/**
 * ============================================================================
 * O SUPERVISOR PARA QUANDO PEDEM — sem matar a API no meio de uma venda
 * ============================================================================
 *
 * Medido rodando o supervisor compilado nesta máquina: no Windows o libuv
 * põe o processo filho num "job" que morre junto com o pai. Encerrar a tarefa
 * agendada (ou matar o supervisor) derruba a API NA HORA — sem fechar as
 * conexões, sem fechar o banco (o `-wal` fica para o próximo boot). Nenhum
 * dado confirmado se perde (WAL com `synchronous FULL`), mas a venda que
 * estava sendo gravada naquele instante recebe erro de rede.
 *
 * Para a parada PLANEJADA (atualizar a versão, remover o serviço) existe um
 * canal de controle local: um pipe nomeado no Windows, um socket de arquivo
 * no Linux. `scripts/parar-api` manda `parar` por ele; o supervisor pede à
 * API que desça limpa, espera, e só então sai. O mesmo canal impede um
 * segundo supervisor de subir em cima do primeiro — duas APIs disputando a
 * mesma porta e o mesmo banco.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';

const { abrirCanalDeControle, pedirParada, caminhoDoCanal } = await import(
  '../src/services/implantacao/canalDeControle.js'
);

function canalDeTeste(): string {
  const nome = `gs-teste-${randomUUID()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${nome}` : join(tmpdir(), `${nome}.sock`);
}

const abertos: Server[] = [];
afterEach(async () => {
  for (const s of abertos.splice(0)) {
    await new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()));
  }
});

describe('o canal de controle', () => {
  it('parar pelo canal chama a parada e só responde depois que ela terminou', async () => {
    const caminho = canalDeTeste();
    const eventos: string[] = [];
    const canal = await abrirCanalDeControle(caminho, {
      aoParar: async () => {
        eventos.push('parando');
        await new Promise((r) => setTimeout(r, 100));
        eventos.push('parou');
      },
    });
    abertos.push(canal);

    const resposta = await pedirParada(caminho);
    expect(resposta).toBe('parado');
    expect(eventos).toEqual(['parando', 'parou']);
  });

  it('sem supervisor no ar, a resposta diz isso — em vez de travar esperando', async () => {
    expect(await pedirParada(canalDeTeste())).toBe('sem_supervisor');
  });

  it('um segundo supervisor não abre o mesmo canal — nada de duas APIs na mesma porta', async () => {
    const caminho = canalDeTeste();
    abertos.push(await abrirCanalDeControle(caminho, { aoParar: async () => undefined }));
    await expect(abrirCanalDeControle(caminho, { aoParar: async () => undefined })).rejects.toThrow(
      /já há um supervisor/,
    );
  });

  it('comando desconhecido é recusado sem parar nada', async () => {
    const caminho = canalDeTeste();
    let parou = false;
    abertos.push(
      await abrirCanalDeControle(caminho, {
        aoParar: async () => {
          parou = true;
        },
      }),
    );
    const { createConnection } = await import('node:net');
    const resposta = await new Promise<string>((resolve) => {
      const s = createConnection(caminho, () => s.write('apagar-tudo\n'));
      let texto = '';
      s.on('data', (d) => {
        texto += String(d);
      });
      s.on('close', () => resolve(texto));
    });
    expect(resposta).toMatch(/desconhecido/);
    expect(parou).toBe(false);
  });

  it('o caminho padrão é um pipe nomeado no Windows e um socket no Linux, e o ambiente pode trocar', () => {
    const original = process.env.DEVORA_SUPERVISOR_CANAL;
    try {
      delete process.env.DEVORA_SUPERVISOR_CANAL;
      const padrao = caminhoDoCanal();
      if (process.platform === 'win32') expect(padrao).toBe('\\\\.\\pipe\\grupo-sampaio-erp-api');
      else expect(padrao).toMatch(/grupo-sampaio-erp-api\.sock$/);
      process.env.DEVORA_SUPERVISOR_CANAL = 'outra-instalacao';
      expect(caminhoDoCanal()).toContain('outra-instalacao');
    } finally {
      if (original === undefined) delete process.env.DEVORA_SUPERVISOR_CANAL;
      else process.env.DEVORA_SUPERVISOR_CANAL = original;
    }
  });
});
