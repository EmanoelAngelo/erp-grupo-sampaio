/**
 * PIX na maquininha.
 *
 * O QUE ESTE ARQUIVO PROTEGE
 *
 * PIX no aparelho é ASSÍNCRONO: a maquininha exibe o QR, o cliente abre o
 * banco, escaneia e paga — e a confirmação chega depois. O mock aprovava na
 * primeira chamada, o que ensinaria ao PDV um fluxo que não existe e faria
 * todo o caminho ser refeito quando o SDK real chegasse.
 *
 * Mais grave: aprovar sozinho é o sistema DIZER QUE RECEBEU dinheiro que
 * ninguém pagou. É o pior defeito possível neste ERP, e nenhum atalho de teste
 * justifica.
 *
 * Então: o PIX nasce pendente com o copia-e-cola, e só sai de pendente com uma
 * confirmação explícita — que, fora do provedor de teste, é recusada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  chargeOnTerminal,
  confirmarPixDeTeste,
  consultarPagamentoTerminal,
  methodNeedsTerminal,
} from '../src/services/core/PdvTerminalService.js';

const app = createApp();
let gringa: string;

/** Maquininha mock ativa para a operação. */
function configurarMaquininha(companyId: string, provider = 'mock'): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO payment_terminal_configurations (id, data)
       VALUES (?, ?)`,
    )
    .run(
      `cfg-${companyId}`,
      JSON.stringify({
        id: `cfg-${companyId}`,
        companyId,
        provider,
        active: true,
        createdAt: agora,
      }),
    );
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('por onde o PIX passa', () => {
  it('sem maquininha, PIX NÃO vai para o terminal', () => {
    // Continua sendo o PIX do provedor de cobrança, com QR na tela.
    expect(methodNeedsTerminal('pix', gringa)).toBe(false);
  });

  it('com maquininha integrada, PIX passa pelo aparelho', () => {
    configurarMaquininha(gringa);
    expect(methodNeedsTerminal('pix', gringa)).toBe(true);
  });

  it('cartão sempre passa pela maquininha, com ou sem empresa informada', () => {
    expect(methodNeedsTerminal('credito')).toBe(true);
    expect(methodNeedsTerminal('debito')).toBe(true);
  });

  it('dinheiro nunca passa', () => {
    configurarMaquininha(gringa);
    expect(methodNeedsTerminal('dinheiro', gringa)).toBe(false);
  });
});

describe('o QR aparece e a venda NÃO fecha sozinha', () => {
  beforeEach(() => configurarMaquininha(gringa));

  it('a cobrança nasce pendente, com o copia-e-cola', async () => {
    const r = await chargeOnTerminal({
      companyId: gringa,
      userId: 'u-1',
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: 'pix-1',
    });

    expect(r.qrPayload).toBeTruthy();
    // O que sustenta tudo: `settled` false significa que a venda não fecha.
    expect(r.settled).toBe(false);
    expect(r.state).not.toBe('aprovado');
  });

  it('consultar não muda nada — pode ser chamada o tempo todo', async () => {
    const r = await chargeOnTerminal({
      companyId: gringa,
      userId: 'u-1',
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: 'pix-2',
    });

    for (let i = 0; i < 10; i += 1) {
      const consulta = consultarPagamentoTerminal(gringa, r.transactionId);
      expect(consulta.settled).toBe(false);
    }
  });

  it('o tempo passando NÃO aprova o pagamento', async () => {
    const r = await chargeOnTerminal({
      companyId: gringa,
      userId: 'u-1',
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: 'pix-3',
    });

    // Aprovar por decurso de prazo seria dizer que recebeu dinheiro que
    // ninguém pagou.
    await new Promise((s) => setTimeout(s, 50));
    expect(consultarPagamentoTerminal(gringa, r.transactionId).settled).toBe(false);
  });
});

describe('confirmação', () => {
  it('confirmada, a cobrança fica liquidada e a venda pode fechar', async () => {
    configurarMaquininha(gringa);
    const r = await chargeOnTerminal({
      companyId: gringa,
      userId: 'u-1',
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: 'pix-4',
    });

    const confirmado = confirmarPixDeTeste({
      companyId: gringa,
      userId: 'u-1',
      transactionId: r.transactionId,
    });

    expect(confirmado.settled).toBe(true);
    expect(confirmado.state).toBe('aprovado');
  });

  it('confirmar dez vezes tem o efeito de uma', async () => {
    configurarMaquininha(gringa);
    const r = await chargeOnTerminal({
      companyId: gringa,
      userId: 'u-1',
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: 'pix-5',
    });

    for (let i = 0; i < 10; i += 1) {
      confirmarPixDeTeste({ companyId: gringa, userId: 'u-1', transactionId: r.transactionId });
    }

    expect(consultarPagamentoTerminal(gringa, r.transactionId).settled).toBe(true);
  });

  it('a resposta continua marcada como SIMULADA até o fim', async () => {
    configurarMaquininha(gringa);
    const r = await chargeOnTerminal({
      companyId: gringa,
      userId: 'u-1',
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: 'pix-6',
    });

    const confirmado = confirmarPixDeTeste({
      companyId: gringa,
      userId: 'u-1',
      transactionId: r.transactionId,
    });
    // Sem esta marca, uma venda de teste passaria por venda de verdade no
    // relatório do dia.
    expect(confirmado.simulated).toBe(true);
  });

  it('com provedor REAL a confirmação manual é RECUSADA', async () => {
    // Quem confirma pagamento de verdade é a adquirente. Esta porta não pode
    // existir com maquininha real, ou daria para "aprovar" venda no braço.
    configurarMaquininha(gringa, 'stone');

    expect(() =>
      confirmarPixDeTeste({ companyId: gringa, userId: 'u-1', transactionId: 'qualquer' }),
    ).toThrow(/provedor de teste/i);
  });
});

describe('as rotas do terminal não se atropelam', () => {
  it('/uncertain é lida como caminho, não como id de transação', async () => {
    // Uma rota com parâmetro declarada antes engoliria a palavra "uncertain".
    // Sem token a resposta é 401 — o middleware de autenticação recusa antes
    // de qualquer guarda de perfil, então 403 aqui seria sinal de que a
    // requisição ENTROU sem se identificar. O que NÃO pode acontecer é a fila
    // de conferência virar consulta de transação.
    const res = await request(app).get('/api/v1/core/pdv/terminal/uncertain');
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).not.toBe('CORE_TERMINAL_NOT_FOUND');
  });
});
