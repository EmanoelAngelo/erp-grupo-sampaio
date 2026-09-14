process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * O SEED DE DESENVOLVIMENTO — as contas de demonstração, e só na bancada
 * ============================================================================
 *
 * As doze contas de demonstração (CARLOSGERENTE, seis `<slug>.pdv`, quatro
 * mecânicos e JOAOCELULAR) saíram do caminho de produção: `db:seed` passou a
 * ser o bootstrap (as seis empresas e o administrador inicial), e elas moram em
 * `npm run db:seed:dev --prefix server`, que:
 *
 *   - RECUSA ambiente de produção e de homologação (pelos dois nomes);
 *   - RECUSA o banco operacional (`server/data/grupo-sampaio.db` de qualquer
 *     árvore, ou qualquer arquivo com esse nome) — antes de abrir o arquivo;
 *   - não traz senha escrita no código: vêm de `GRUPO_SAMPAIO_*_PASSWORD` de
 *     quem chama, ou são geradas uma por conta e devolvidas UMA vez;
 *   - continua sendo o que o GAP-PRD-040 exigiu: cria o que falta, com senha
 *     provisória, e não toca em conta, senha, nome, perfil nem empresa.
 *
 * Os casos do GAP-PRD-040 que moravam em
 * `seed-nasce-provisorio-e-nao-reescreve.test.ts` vieram para cá; os do
 * administrador foram para `bootstrap-de-producao.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import {
  CONTAS_DE_DEMONSTRACAO,
  SeedDeDesenvolvimentoRecusado,
  conferirQuePodeSemearDesenvolvimento,
  relatorioDoSeedDeDesenvolvimento,
  semearDesenvolvimento,
} from '../src/db/seedDeDesenvolvimento.js';
import { executarBootstrap } from '../src/db/bootstrap.js';
import { upsertUser } from '../src/services/auth/IdentityService.js';

const app = createApp();
const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GESTAO = 'Gestao#Bancada-2026';
const OPERACAO = 'Balcao#Bancada-2026';

const ENV_ORIGINAL = { ...process.env };

function restaurarAmbiente(): void {
  for (const chave of Object.keys(process.env)) {
    if (!(chave in ENV_ORIGINAL)) delete process.env[chave];
  }
  Object.assign(process.env, ENV_ORIGINAL);
  resetEnvCacheForTests();
}

function comAsSenhasDaBancada(): void {
  process.env.GRUPO_SAMPAIO_MANAGEMENT_PASSWORD = GESTAO;
  process.env.GRUPO_SAMPAIO_OPERATION_PASSWORD = OPERACAO;
  resetEnvCacheForTests();
}

beforeEach(() => {
  restaurarAmbiente();
  delete process.env.GRUPO_SAMPAIO_MANAGEMENT_PASSWORD;
  delete process.env.GRUPO_SAMPAIO_OPERATION_PASSWORD;
  delete process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD;
  resetEnvCacheForTests();
  resetDbForTests();
});

afterEach(() => {
  restaurarAmbiente();
});

function contas(): { login: string; must_change_password: number; session_version: number }[] {
  return getConnection()
    .prepare('SELECT login, must_change_password, session_version FROM core_users ORDER BY login')
    .all() as { login: string; must_change_password: number; session_version: number }[];
}

async function entrar(login: string, password: string) {
  return request(app).post('/api/v1/auth/login').send({ login, password });
}

function perfilEm(login: string): { slug: string; profile_code: string }[] {
  return getConnection()
    .prepare(
      `SELECT c.slug, uc.profile_code FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id
         JOIN core_users u ON u.id = uc.user_id
        WHERE u.login = ? ORDER BY c.slug`,
    )
    .all(login) as { slug: string; profile_code: string }[];
}

function bancadasDe(login: string): string[] {
  return (
    getConnection()
      .prepare(
        `SELECT w.slug FROM core_workshop_members m
           JOIN core_workshops w ON w.id = m.workshop_id
           JOIN core_users u ON u.id = m.user_id
          WHERE u.login = ? ORDER BY w.slug`,
      )
      .all(login) as { slug: string }[]
  ).map((r) => r.slug);
}

describe('as doze contas de demonstração', () => {
  it('nascem provisórias, com os perfis e bancadas de sempre — e nenhuma é o administrador', async () => {
    comAsSenhasDaBancada();
    const r = await semearDesenvolvimento();

    expect(CONTAS_DE_DEMONSTRACAO).toHaveLength(12);
    expect(r.contasCriadas.sort()).toEqual([...CONTAS_DE_DEMONSTRACAO].sort());
    expect(r.contasPreservadas).toEqual([]);
    expect(r.modoDeSenha).toBe('variaveis');
    const todas = contas();
    expect(todas.map((c) => c.login).sort()).toEqual([...CONTAS_DE_DEMONSTRACAO].sort());
    expect(todas.map((c) => c.login.toLowerCase())).not.toContain('admin');
    expect(todas.filter((c) => c.must_change_password !== 1)).toEqual([]);

    expect(perfilEm('CARLOSGERENTE').map((v) => v.profile_code)).toEqual(Array(6).fill('gestor'));
    expect(perfilEm('oficina.pdv')).toEqual([{ slug: 'oficina', profile_code: 'operador_caixa_oficina' }]);
    expect(perfilEm('gringa.pdv')).toEqual([{ slug: 'gringa', profile_code: 'operador_caixa_loja' }]);
    expect(bancadasDe('ROBERTOMECANICO')).toEqual(['oficina-mobilidade']);
    expect(bancadasDe('JOAOCELULAR')).toEqual(['oficina-celulares']);

    const pdv = await entrar('preco-justo.pdv', OPERACAO);
    expect(pdv.status, JSON.stringify(pdv.body)).toBe(200);
    expect(pdv.body.user.mustChangePassword).toBe(true);
    const produtos = await request(app)
      .get('/api/v1/core/products')
      .set({ Authorization: `Bearer ${pdv.body.accessToken as string}` });
    expect(produtos.status).toBe(403);
    expect(produtos.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');
    expect((await entrar('CARLOSGERENTE', GESTAO)).status).toBe(200);
  });

  it('convive com o bootstrap: o admin é dele, as doze são daqui', async () => {
    process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD = 'Admin#DaPilha-2026';
    comAsSenhasDaBancada();
    await executarBootstrap({ origem: 'comando' });
    await semearDesenvolvimento();
    expect(contas()).toHaveLength(13);
    expect(contas().filter((c) => c.login === 'admin')).toHaveLength(1);
  });
});

describe('rodar de novo não desfaz o trabalho de ninguém (GAP-PRD-040)', () => {
  it('a senha trocada continua valendo, a sessão continua de pé, e nada é remarcado como provisório', async () => {
    comAsSenhasDaBancada();
    await semearDesenvolvimento();

    const primeiro = await entrar('CARLOSGERENTE', GESTAO);
    const troca = await request(app)
      .post('/api/v1/auth/password')
      .set({ Authorization: `Bearer ${primeiro.body.accessToken as string}` })
      .send({ currentPassword: GESTAO, newPassword: 'SoDoCarlos@2026' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(204);

    const comANova = await entrar('CARLOSGERENTE', 'SoDoCarlos@2026');
    expect(comANova.status).toBe(200);
    const antes = contas().find((c) => c.login === 'CARLOSGERENTE')!;

    const segunda = await semearDesenvolvimento();
    expect(segunda.contasCriadas).toEqual([]);
    expect(segunda.contasPreservadas).toHaveLength(12);

    const depois = await entrar('CARLOSGERENTE', 'SoDoCarlos@2026');
    expect(depois.status).toBe(200);
    expect(depois.body.user.mustChangePassword).toBe(false);
    expect((await entrar('CARLOSGERENTE', GESTAO)).status).toBe(401);

    expect(contas().find((c) => c.login === 'CARLOSGERENTE')!.session_version).toBe(antes.session_version);
    const renova = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: comANova.body.refreshToken });
    expect(renova.status, JSON.stringify(renova.body)).toBe(200);
  });

  it('nome, perfil e cadastro da empresa ajustados também ficam', async () => {
    comAsSenhasDaBancada();
    await semearDesenvolvimento();
    const db = getConnection();
    db.prepare("UPDATE core_users SET display_name = 'Caixa da Frente' WHERE login = 'gringa.pdv'").run();
    db.prepare(
      `UPDATE core_user_companies SET profile_code = 'gerente_loja'
        WHERE user_id = (SELECT id FROM core_users WHERE login = 'gringa.pdv')`,
    ).run();
    db.prepare("UPDATE core_companies SET cnpj = '11222333000181', tax_regime = 'presumido' WHERE slug = 'gringa'").run();

    await semearDesenvolvimento();

    const conta = db
      .prepare(
        `SELECT u.display_name, uc.profile_code FROM core_users u
           JOIN core_user_companies uc ON uc.user_id = u.id WHERE u.login = 'gringa.pdv'`,
      )
      .get() as { display_name: string; profile_code: string };
    expect(conta).toEqual({ display_name: 'Caixa da Frente', profile_code: 'gerente_loja' });
    expect(db.prepare("SELECT cnpj, tax_regime FROM core_companies WHERE slug = 'gringa'").get()).toEqual({
      cnpj: '11222333000181',
      tax_regime: 'presumido',
    });
  });

  it('conta que já existia não é tocada — mas a que ficou sem vínculo é completada', async () => {
    await upsertUser({ login: 'CARLOSGERENTE', displayName: 'Carlos', password: 'DoCarlos@2026' });
    comAsSenhasDaBancada();

    const r = await semearDesenvolvimento();
    expect(r.contasPreservadas).toEqual(['CARLOSGERENTE']);
    expect(r.contasCriadas).toHaveLength(11);

    const carlos = await entrar('CARLOSGERENTE', 'DoCarlos@2026');
    expect(carlos.status, JSON.stringify(carlos.body)).toBe(200);
    expect(carlos.body.user.mustChangePassword).toBe(false);
    expect(carlos.body.user.displayName).toBe('Carlos');
    expect(carlos.body.companies).toHaveLength(6);
  });
});

describe('sem as variáveis: uma senha por conta, devolvida UMA vez — nenhuma escrita no código', () => {
  it('doze senhas diferentes, e cada uma só abre a própria conta', async () => {
    const r = await semearDesenvolvimento();
    expect(r.modoDeSenha).toBe('individual');
    expect(r.senhasGeradas).toHaveLength(12);
    const senhas = r.senhasGeradas.map((s) => s.senha);
    expect(new Set(senhas).size).toBe(12);
    for (const s of senhas) expect(s.length).toBeGreaterThanOrEqual(12);

    const deGringa = r.senhasGeradas.find((s) => s.login === 'gringa.pdv')!;
    const deConceito = r.senhasGeradas.find((s) => s.login === 'conceito.pdv')!;
    expect((await entrar('gringa.pdv', deGringa.senha)).status).toBe(200);
    expect((await entrar('conceito.pdv', deGringa.senha)).status).toBe(401);
    expect((await entrar('conceito.pdv', deConceito.senha)).status).toBe(200);
    // As antigas senhas de desenvolvimento, publicadas no README, não abrem nada.
    expect((await entrar('CARLOSGERENTE', 'admin@123')).status).toBe(401);
    expect((await entrar('gringa.pdv', 'Senha@123')).status).toBe(401);
  });

  it('o relatório mostra cada senha gerada UMA vez, ao lado do login dela, e nunca de novo', async () => {
    const r = await semearDesenvolvimento();
    const linhas = relatorioDoSeedDeDesenvolvimento(r);
    const texto = linhas.join('\n');
    for (const { login, senha } of r.senhasGeradas) {
      expect(texto.split(senha)).toHaveLength(2);
      expect(linhas.find((l) => l.includes(senha))!.trim().split(/\s+/)).toEqual([login, senha]);
    }
    const segunda = await semearDesenvolvimento();
    expect(segunda.senhasGeradas).toEqual([]);
    const textoDaSegunda = relatorioDoSeedDeDesenvolvimento(segunda).join('\n');
    expect(textoDaSegunda).toContain('NÃO foram alteradas');
    for (const { senha } of r.senhasGeradas) expect(textoDaSegunda).not.toContain(senha);
  });

  it('senha informada curta é recusada antes de criar qualquer conta', async () => {
    process.env.GRUPO_SAMPAIO_MANAGEMENT_PASSWORD = 'curta';
    await expect(semearDesenvolvimento()).rejects.toThrow(/8 caracteres/);
    expect(contas()).toHaveLength(0);
  });
});

describe('só na bancada', () => {
  function comChavesFortes(): void {
    process.env.DEVORA_JWT_SECRET = 'segredo-de-teste-longo-o-bastante-para-producao-0123456789';
    process.env.DEVORA_ENCRYPTION_KEY = 'chave-de-cifra-de-teste-longa-o-bastante-0123456789';
    delete process.env.DEVORA_DEV_QUICK_LOGIN;
  }

  it.each([
    ['production', undefined],
    ['staging', undefined],
    ['development', 'production'],
  ])('recusa DEVORA_API_ENV=%s / NODE_ENV=%s — sem criar nada', async (apiEnv, nodeEnv) => {
    comChavesFortes();
    comAsSenhasDaBancada();
    process.env.DEVORA_API_ENV = apiEnv;
    if (nodeEnv) process.env.NODE_ENV = nodeEnv;
    resetEnvCacheForTests();
    await expect(semearDesenvolvimento()).rejects.toBeInstanceOf(SeedDeDesenvolvimentoRecusado);
    await expect(semearDesenvolvimento()).rejects.toThrow(/produ[cç][aã]o|homologa/i);
    expect(contas()).toHaveLength(0);
    expect((getConnection().prepare('SELECT COUNT(*) AS n FROM core_companies').get() as { n: number }).n).toBe(0);
  });

  it.each([
    'C:/Users/User/Desktop/Grupo Sampaio/server/data/grupo-sampaio.db',
    'C:\\Users\\User\\Desktop\\devora-outra-arvore\\server\\data\\grupo-sampaio.db',
    'D:/copia-do-dono/GRUPO-SAMPAIO.db',
    '/app/server/data/grupo-sampaio.db',
  ])('recusa o banco operacional pelo caminho, sem abrir o arquivo: %s', (caminho) => {
    expect(() => conferirQuePodeSemearDesenvolvimento(caminho)).toThrow(SeedDeDesenvolvimentoRecusado);
    expect(() => conferirQuePodeSemearDesenvolvimento(caminho)).toThrow(/banco operacional/);
  });

  /*
    O WINDOWS ABRE O MESMO ARQUIVO POR MAIS DE UM NOME. Ele descarta ponto e
    espaço no fim de cada trecho do caminho ("grupo-sampaio.db." e
    "grupo-sampaio.db " abrem "grupo-sampaio.db") e aceita o nome curto 8.3
    ("GRUPO-~1.DB"). A régua olhava só o texto: um espaço sobrando no fim de
    DEVORA_DATABASE_PATH passava por ela e o seed semeava as doze contas no
    banco operacional — que na instalação da loja roda em `development`, onde
    a trava do ambiente não segura.
  */
  it.runIf(process.platform === 'win32')(
    'recusa o banco operacional escrito de outro jeito que o Windows abre igual — ponto ou espaço no fim, nome curto 8.3',
    () => {
      const pasta = mkdtempSync(join(tmpdir(), 'gs-seed-dev-apelido-'));
      const dados = join(pasta, 'server', 'data');
      mkdirSync(dados, { recursive: true });
      const operacional = join(dados, 'grupo-sampaio.db');
      const noFim = [`${operacional}.`, `${operacional} `, `${operacional}. `];
      try {
        // Antes de o arquivo existir: o Windows criaria o próprio grupo-sampaio.db.
        for (const apelido of noFim) {
          expect(() => conferirQuePodeSemearDesenvolvimento(apelido), JSON.stringify(apelido)).toThrow(/banco operacional/);
        }
        writeFileSync(operacional, '');
        const apelidos = [...noFim];
        const curto = execSync(`cmd /c for %I in ("${operacional}") do @echo %~sI`, { encoding: 'utf8' }).trim();
        // Com o 8.3 desligado no disco, o "nome curto" é o próprio caminho: nada a provar.
        if (curto && curto.toLowerCase() !== operacional.toLowerCase()) apelidos.push(curto);
        for (const apelido of apelidos) {
          expect(() => conferirQuePodeSemearDesenvolvimento(apelido), JSON.stringify(apelido)).toThrow(/banco operacional/);
        }
      } finally {
        rmSync(pasta, { recursive: true, force: true });
      }
    },
  );

  it('aceita um banco de bancada com outro nome', () => {
    expect(() => conferirQuePodeSemearDesenvolvimento(join(tmpdir(), 'bancada', 'desenvolvimento.db'))).not.toThrow();
  });

  it('semearDesenvolvimento confere o caminho ANTES de abrir: o arquivo operacional nem chega a nascer', async () => {
    const pasta = mkdtempSync(join(tmpdir(), 'gs-seed-dev-op-'));
    const operacional = join(pasta, 'server', 'data', 'grupo-sampaio.db');
    const anterior = process.env.DEVORA_DATABASE_PATH;
    try {
      comAsSenhasDaBancada();
      process.env.DEVORA_DATABASE_PATH = operacional;
      await expect(semearDesenvolvimento()).rejects.toThrow(/banco operacional/);
      expect(existsSync(operacional)).toBe(false);
    } finally {
      process.env.DEVORA_DATABASE_PATH = anterior;
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  it('o comando db:seed:dev recusa o banco operacional antes de assumir o banco', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'gs-seed-dev-cli-'));
    const operacional = join(pasta, 'server', 'data', 'grupo-sampaio.db');
    const TSX = join(SERVIDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    try {
      let codigo = 0;
      let saida = '';
      try {
        execFileSync(process.execPath, [TSX, 'src/db/seedDeDesenvolvimento-cli.ts'], {
          cwd: SERVIDOR,
          env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
            DEVORA_IGNORE_DOTENV: 'true',
            DEVORA_API_ENV: 'test',
            DEVORA_DATABASE_PATH: operacional,
            TEST_DATABASE_PATH: operacional,
            GRUPO_SAMPAIO_MANAGEMENT_PASSWORD: GESTAO,
            GRUPO_SAMPAIO_OPERATION_PASSWORD: OPERACAO,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (erro) {
        const e = erro as { status?: number; stdout?: string; stderr?: string };
        codigo = e.status ?? -1;
        saida = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      }
      expect(codigo).toBe(1);
      expect(saida).toMatch(/banco operacional/);
      expect(existsSync(operacional)).toBe(false);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('upsertUser — a ferramenta de provisionamento direto', () => {
  function versaoDe(login: string): number {
    return (
      getConnection().prepare('SELECT session_version AS v FROM core_users WHERE login = ?').get(login) as {
        v: number;
      }
    ).v;
  }

  it('trocar a senha de quem existe derruba as sessões dela; repetir a mesma senha não', async () => {
    await upsertUser({ login: 'PROVISIONADO', displayName: 'Provisionado', password: 'Primeira@2026' });
    const v1 = versaoDe('PROVISIONADO');

    await upsertUser({ login: 'PROVISIONADO', displayName: 'Provisionado', password: 'Primeira@2026' });
    expect(versaoDe('PROVISIONADO')).toBe(v1);

    await upsertUser({ login: 'PROVISIONADO', displayName: 'Provisionado', password: 'Segunda@2026' });
    expect(versaoDe('PROVISIONADO')).toBe(v1 + 1);
    expect((await entrar('PROVISIONADO', 'Segunda@2026')).body.error.code).toBe('API_NO_MEMBERSHIP');
    expect((await entrar('PROVISIONADO', 'Primeira@2026')).status).toBe(401);
  });
});
