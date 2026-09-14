/**
 * UMA INSTÂNCIA POR ARQUIVO DE BANCO — as regras da trava (GAP-PRD-137).
 *
 * Aqui a trava é exercida no próprio processo, com pid, máquina e relógio
 * injetados, para cobrir cada ramo sem depender de quais pids existem na
 * máquina. O que ela faz com processos DE VERDADE (a segunda API recusada
 * antes de abrir a porta, o `db:migrate` recusado com a API no ar, a API que
 * morreu não travando a próxima) está em
 * `a-segunda-api-nao-sobe-no-mesmo-banco.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  BancoOcupado,
  LIMITE_DO_PID_REAPROVEITADO_MS,
  PRAZO_DA_BATIDA_MS,
  assumirInstancia,
  assumirInstanciaAgora,
  baterUmaVez,
  donoDoBanco,
  liberarInstancia,
  tentarAssumir,
  type Decisao,
} from '../src/services/implantacao/instanciaUnica.js';

const T0 = Date.parse('2026-09-11T12:00:00.000Z');
const vivo = () => true;
const morto = () => false;

function assumiu(d: Decisao): Extract<Decisao, { assumiu: true }> {
  if (!d.assumiu) throw new Error(`esperava assumir, mas o banco é de ${JSON.stringify(d.dono)}`);
  return d;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

describe('quem chega primeiro é o dono', () => {
  it('banco sem dono: assume e fica registrado com pid, máquina e tipo', () => {
    const d = assumiu(tentarAssumir('api', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    expect(d.motivo).toBe('livre');
    expect(donoDoBanco()).toMatchObject({ tipo: 'api', pid: 100, host: 'loja', iniciadoEm: new Date(T0).toISOString() });
  });

  it('mesma máquina, dono vivo: o segundo processo é recusado e sabe quem é o dono', () => {
    assumiu(tentarAssumir('api', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    const d = tentarAssumir('api', { pid: 200, host: 'loja', agora: () => T0 + 1_000, pidVivo: vivo });
    expect(d.assumiu).toBe(false);
    if (d.assumiu) return;
    expect(d.motivo).toBe('processo_vivo');
    expect(d.dono).toMatchObject({ pid: 100, host: 'loja', tipo: 'api' });
    expect(donoDoBanco()?.pid).toBe(100);
  });

  it('o db:migrate com a API no ar é recusado do mesmo jeito', () => {
    assumiu(tentarAssumir('api', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    const d = tentarAssumir('migracao', { pid: 300, host: 'loja', agora: () => T0 + 2_000, pidVivo: vivo });
    expect(d.assumiu).toBe(false);
  });
});

describe('o dono que morreu não trava a próxima subida', () => {
  it('mesma máquina, pid morto: assume NA HORA, sem esperar a batida vencer', () => {
    assumiu(tentarAssumir('api', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    const d = assumiu(tentarAssumir('api', { pid: 200, host: 'loja', agora: () => T0 + 1_000, pidVivo: morto }));
    expect(d.motivo).toBe('processo_morto');
    expect(d.anterior?.pid).toBe(100);
    expect(donoDoBanco()?.pid).toBe(200);
  });

  it('batida atrasada com o pid VIVO não libera: uma migração síncrona longa não bate e continua dona', () => {
    assumiu(tentarAssumir('migracao', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    const d = tentarAssumir('api', { pid: 200, host: 'loja', agora: () => T0 + 5 * 60_000, pidVivo: vivo });
    expect(d.assumiu).toBe(false);
  });

  it('pid vivo mas sem bater há mais de 10 min: o número foi reaproveitado — assume', () => {
    assumiu(tentarAssumir('api', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    const d = assumiu(
      tentarAssumir('api', { pid: 200, host: 'loja', agora: () => T0 + LIMITE_DO_PID_REAPROVEITADO_MS + 1, pidVivo: vivo }),
    );
    expect(d.motivo).toBe('pid_reaproveitado');
  });

  it('o mesmo pid na mesma máquina (o contêiner que reinicia como pid 1) assume', () => {
    assumiu(tentarAssumir('api', { pid: 1, host: 'c0ffee', agora: () => T0, pidVivo: vivo }));
    const d = assumiu(tentarAssumir('api', { pid: 1, host: 'c0ffee', agora: () => T0 + 1_000, pidVivo: vivo }));
    expect(d.motivo).toBe('mesmo_processo');
  });
});

describe('outra máquina: só a batida vale', () => {
  it('batida fresca recusa; passados 30 s sem bater, assume', () => {
    assumiu(tentarAssumir('api', { pid: 100, host: 'caixa-1', agora: () => T0, pidVivo: vivo }));
    const cedo = tentarAssumir('api', { pid: 100, host: 'caixa-2', agora: () => T0 + PRAZO_DA_BATIDA_MS - 1, pidVivo: morto });
    expect(cedo.assumiu).toBe(false);
    if (!cedo.assumiu) expect(cedo.motivo).toBe('outra_maquina');

    const tarde = assumiu(tentarAssumir('api', { pid: 100, host: 'caixa-2', agora: () => T0 + PRAZO_DA_BATIDA_MS + 1, pidVivo: vivo }));
    expect(tarde.motivo).toBe('batida_vencida');
  });

  it('a batida renova o prazo', () => {
    const a = assumiu(tentarAssumir('api', { pid: 100, host: 'caixa-1', agora: () => T0, pidVivo: vivo }));
    expect(baterUmaVez(a.token, () => T0 + 25_000)).toBe(true);
    const d = tentarAssumir('api', { pid: 100, host: 'caixa-2', agora: () => T0 + 40_000, pidVivo: vivo });
    expect(d.assumiu).toBe(false);
  });
});

describe('perder, soltar e esperar', () => {
  it('quem perdeu a linha descobre na batida — e liberar não solta a linha do novo dono', () => {
    const a = assumiu(tentarAssumir('api', { pid: 100, host: 'loja', agora: () => T0, pidVivo: vivo }));
    const b = assumiu(tentarAssumir('api', { pid: 200, host: 'loja', agora: () => T0 + 1_000, pidVivo: morto }));
    expect(baterUmaVez(a.token)).toBe(false);
    expect(liberarInstancia(a.token)).toBe(false);
    expect(donoDoBanco()?.pid).toBe(200);
    expect(liberarInstancia(b.token)).toBe(true);
    expect(donoDoBanco()).toBeNull();
  });

  it('a batida periódica avisa quando outro processo assumiu', async () => {
    const aoPerder = vi.fn();
    const trava = assumirInstanciaAgora('api', { batidaMs: 20, aoPerder, ambiente: { pid: 100, host: 'loja', pidVivo: vivo } });
    assumiu(tentarAssumir('api', { pid: 200, host: 'loja', pidVivo: morto }));
    await vi.waitFor(() => expect(aoPerder).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(aoPerder.mock.calls[0][0]).toMatchObject({ pid: 200 });
    trava.liberar();
  });

  it('assumirInstancia espera o dono sair e então assume', async () => {
    const a = assumiu(tentarAssumir('api', { pid: 100, host: 'loja', pidVivo: vivo }));
    setTimeout(() => liberarInstancia(a.token), 150);
    const trava = await assumirInstancia('api', {
      esperaMs: 3_000,
      pausaMs: 30,
      batidaMs: 0,
      ambiente: { pid: 200, host: 'loja', pidVivo: vivo },
    });
    expect(donoDoBanco()?.pid).toBe(200);
    trava.liberar();
    expect(donoDoBanco()).toBeNull();
  });

  it('e desiste com BancoOcupado, numa frase que diz quem é o dono e o que fazer', async () => {
    assumiu(tentarAssumir('api', { pid: 100, host: 'loja', pidVivo: vivo }));
    const tentativa = assumirInstancia('api', {
      esperaMs: 120,
      pausaMs: 30,
      batidaMs: 0,
      ambiente: { pid: 200, host: 'loja', pidVivo: vivo },
    });
    await expect(tentativa).rejects.toBeInstanceOf(BancoOcupado);
    const erro = (await tentativa.catch((e: unknown) => e)) as BancoOcupado;
    expect(erro.code).toBe('DEVORA_BANCO_OCUPADO');
    expect(erro.dono.pid).toBe(100);
    expect(erro.message).toContain('pid 100 em loja');
    expect(erro.message).toContain('UMA instância por arquivo de banco');
    expect(erro.message).toContain('DEVORA_DATABASE_PATH');
    expect(erro.message).toContain('parar-api');
  });
});

describe('quem usa a trava, e em que ordem', () => {
  /*
    A trava só protege a migração se vier ANTES dela. Se alguém mover
    `prepararBanco()` para cima de `assumirInstancia`, dois boots juntos voltam
    a aplicar o mesmo passo — e o teste de processos passaria mesmo assim,
    porque lá a segunda API chega depois da primeira ter migrado.
  */
  const fonte = (relativo: string) => readFileSync(new URL(relativo, import.meta.url), 'utf8');

  it('o boot assume o banco antes de migrar, e solta ao fechar', () => {
    const boot = fonte('../src/index.ts');
    const corpo = boot.slice(boot.indexOf('export async function startServer'));
    const assume = corpo.indexOf("assumirInstancia('api'");
    const migra = corpo.indexOf('prepararBanco()');
    expect(assume).toBeGreaterThan(-1);
    expect(migra).toBeGreaterThan(assume);
    expect(corpo).toMatch(/fecharBanco: \(\) => \{\s*trava\.liberar\(\);\s*closeConnection\(\);/);
  });

  it('os comandos que migram ou escrevem o banco assumem antes', () => {
    const migra = fonte('../src/db/migracaoCompleta.ts');
    const comando = migra.slice(migra.indexOf('export function migrarPelaLinhaDeComando'));
    expect(comando.indexOf("assumirInstanciaAgora('migracao')")).toBeGreaterThan(-1);
    expect(comando.indexOf('prepararBanco()')).toBeGreaterThan(comando.indexOf("assumirInstanciaAgora('migracao')"));

    // `db:bootstrap` e `db:seed` (o mesmo comando) migram e escrevem.
    const bootstrap = fonte('../src/db/bootstrap-cli.ts');
    expect(bootstrap.indexOf("assumirInstanciaAgora('manutencao')")).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('prepararBanco()')).toBeGreaterThan(bootstrap.indexOf("assumirInstanciaAgora('manutencao')"));
    expect(bootstrap.indexOf('executarBootstrap(')).toBeGreaterThan(bootstrap.indexOf('prepararBanco()'));

    // `db:seed:dev` também — e confere o banco ANTES de abri-lo para assumir.
    const dev = fonte('../src/db/seedDeDesenvolvimento-cli.ts');
    const assumeODev = dev.indexOf("assumirInstanciaAgora('manutencao')");
    expect(assumeODev).toBeGreaterThan(dev.indexOf('conferirQuePodeSemearDesenvolvimento('));
    expect(dev.indexOf('prepararBanco()')).toBeGreaterThan(assumeODev);

    const rotacao = fonte('../src/scripts/rotacionar-chave.ts');
    expect(rotacao.indexOf("assumirInstanciaAgora('manutencao')")).toBeGreaterThan(-1);
    expect(rotacao.indexOf('rotacionarChaveDoCofre({')).toBeGreaterThan(rotacao.indexOf("assumirInstanciaAgora('manutencao')"));
  });
});

describe('a tela Sistema vê o dono', () => {
  it('GET /system/release traz a instância: pid, máquina, e que é este processo', async () => {
    const app = createApp();
    const login = await loginForTest(app, { userId: 'dono-do-banco', companyId: 'empresa-instancia', profileCodes: ['admin_geral'] });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const sem = await request(app).get('/api/v1/system/release').set(auth);
    expect(sem.status).toBe(200);
    expect(sem.body.instancia).toBeNull();

    const trava = assumirInstanciaAgora('api');
    const com = await request(app).get('/api/v1/system/release').set(auth);
    expect(com.body.instancia).toMatchObject({ tipo: 'api', pid: process.pid, host: hostname(), estaInstancia: true });
    trava.liberar();
  });
});
