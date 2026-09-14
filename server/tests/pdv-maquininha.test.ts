/**
 * PDV × maquininha.
 *
 * A regra que estes testes protegem: clicar em "Crédito" não é receber.
 * Quando há maquininha integrada, o cartão só entra na venda depois que o
 * provedor confirmar — senão o caixa fecharia com dinheiro que o banco nunca
 * vai repassar.
 *
 * E o caso difícil, que já existia no domínio de terminal e não pode
 * regredir: quando o sistema NÃO SABE se aprovou, ele não decide sozinho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createPaymentTerminalConfigurationBackend } = await import(
  '../src/services/payment-terminal/PaymentTerminalService.js'
);
const {
  chargeOnTerminal,
  getTerminalPayment,
  getTerminalStatus,
  listUncertainPayments,
  methodNeedsTerminal,
  reconcileTerminalPayment,
} = await import('../src/services/core/PdvTerminalService.js');
const { listAudit } = await import('../src/services/audit/AuditService.js');

let companyId: string;
let operador: string;
let gerente: string;

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  operador = await upsertUser({
    login: 'CAIXA',
    displayName: 'Caixa',
    password: 'senha-teste-123',
  });
  linkUserToCompany(operador, companyId, 'operador_caixa_loja', true);
  gerente = await upsertUser({
    login: 'GERENTE',
    displayName: 'Gerente',
    password: 'senha-teste-123',
  });
  linkUserToCompany(gerente, companyId, 'gerente_loja', true);
});

function configurarMaquininha() {
  createPaymentTerminalConfigurationBackend({
    companyId,
    provider: 'mock',
    active: true,
    name: 'Maquininha do balcão',
  });
}

function cobrar(overrides: Record<string, unknown> = {}) {
  return chargeOnTerminal({
    companyId,
    userId: operador,
    method: 'credito',
    amountInCents: 15000,
    idempotencyKey: randomUUID(),
    ...overrides,
  } as Parameters<typeof chargeOnTerminal>[0]);
}

describe('quais meios passam pela maquininha', () => {
  it('cartão sim', () => {
    expect(methodNeedsTerminal('credito')).toBe(true);
    expect(methodNeedsTerminal('debito')).toBe(true);
  });

  it('dinheiro, PIX e crediário não', () => {
    expect(methodNeedsTerminal('dinheiro')).toBe(false);
    expect(methodNeedsTerminal('pix')).toBe(false);
    expect(methodNeedsTerminal('crediario')).toBe(false);
  });

  it('dinheiro não é aceito na cobrança de terminal', async () => {
    configurarMaquininha();
    await expect(cobrar({ method: 'dinheiro' })).rejects.toThrowError(/não passa pela maquininha/i);
  });
});

describe('operação sem maquininha integrada', () => {
  it('o estado é honesto: READY_FOR_HARDWARE, não homologado', () => {
    const status = getTerminalStatus(companyId);
    expect(status.configured).toBe(false);
    expect(status.readiness).toBe('READY_FOR_HARDWARE');
    expect(status.message).toMatch(/lançado manualmente/i);
  });

  it('cobrar é recusado em vez de fingir aprovação', async () => {
    await expect(cobrar()).rejects.toThrowError(/Nenhuma maquininha integrada/i);
  });
});

describe('cobrança na maquininha', () => {
  it('aprovada libera a venda', async () => {
    configurarMaquininha();
    const result = await cobrar();
    expect(result.state).toBe('aprovado');
    expect(result.settled).toBe(true);
    expect(result.needsReconciliation).toBe(false);
  });

  it('recusada NÃO libera a venda', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'decline' });
    expect(result.state).toBe('recusado');
    expect(result.settled).toBe(false);
    expect(result.message).toMatch(/recusado/i);
  });

  it('resposta simulada é marcada como simulada — nunca passa por real', async () => {
    configurarMaquininha();
    const result = await cobrar();
    // Adaptador mock: sem maquininha física isto não é cobrança de verdade.
    expect(result.simulated).toBe(true);
  });

  it('reenvio com a mesma chave não cobra o cliente duas vezes', async () => {
    configurarMaquininha();
    const key = randomUUID();
    const primeira = await cobrar({ idempotencyKey: key });
    const segunda = await cobrar({ idempotencyKey: key });
    expect(segunda.transactionId).toBe(primeira.transactionId);
  });

  it('valor zero ou negativo é recusado', async () => {
    configurarMaquininha();
    await expect(cobrar({ amountInCents: 0 })).rejects.toThrowError(/maior que zero/i);
  });

  it('a cobrança fica na auditoria com o estado alcançado', async () => {
    configurarMaquininha();
    const result = await cobrar();
    const trilha = listAudit(companyId, { limit: 20 }).items as unknown as Record<string, unknown>[];
    const registro = trilha.find((a) => String(a.action).startsWith('pdv.terminal.'));
    expect(registro).toBeTruthy();
    expect(String(registro?.action)).toBe(`pdv.terminal.${result.state}`);
  });
});

describe('timeout incerto — a regra que não pode cair', () => {
  it('não é aprovado, não é recusado: fica não confirmado', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'timeout_uncertain' });

    expect(result.state).toBe('timeout_nao_confirmado');
    // Não finaliza a venda: entregaria mercadoria sem ter recebido.
    expect(result.settled).toBe(false);
    // Não marca como recusado: perderia uma venda que pode ter sido paga.
    expect(result.state).not.toBe('recusado');
    expect(result.needsReconciliation).toBe(true);
  });

  it('a mensagem diz ao operador para NÃO repetir a cobrança', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'timeout_uncertain' });
    expect(result.message).toMatch(/NÃO CONFIRMADO/);
    expect(result.message).toMatch(/não repita a cobrança/i);
  });

  it('consultar de novo não muda o estado sozinho', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'timeout_uncertain' });
    const consultado = getTerminalPayment(companyId, result.transactionId);
    expect(consultado.state).toBe('timeout_nao_confirmado');
    expect(consultado.settled).toBe(false);
  });

  it('reconciliar como aprovado libera a venda e fica na auditoria', () => {
    configurarMaquininha();
    return cobrar({ scenario: 'timeout_uncertain' }).then((result) => {
      const fechado = reconcileTerminalPayment({
        companyId,
        userId: gerente,
        transactionId: result.transactionId,
        outcome: 'aprovado',
        reason: 'Conferido no extrato: NSU 88213 aprovado às 14h02.',
      });

      expect(fechado.state).toBe('aprovado');
      expect(fechado.settled).toBe(true);
      expect(fechado.needsReconciliation).toBe(false);

      const trilha = listAudit(companyId, { limit: 20 }).items as unknown as Record<string, unknown>[];
      expect(
        trilha.some((a) => String(a.action) === 'pdv.terminal.reconciliado.aprovado'),
      ).toBe(true);
    });
  });

  it('reconciliar como recusado não libera a venda', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'timeout_uncertain' });
    const fechado = reconcileTerminalPayment({
      companyId,
      userId: gerente,
      transactionId: result.transactionId,
      outcome: 'recusado',
      reason: 'Extrato não mostra a transação.',
    });
    expect(fechado.settled).toBe(false);
  });

  it('reconciliar exige dizer o que foi verificado', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'timeout_uncertain' });
    expect(() =>
      reconcileTerminalPayment({
        companyId,
        userId: gerente,
        transactionId: result.transactionId,
        outcome: 'aprovado',
        reason: '   ',
      }),
    ).toThrowError(/verificado no extrato/i);
  });

  it('depois de conferida, sai da fila do gestor', async () => {
    configurarMaquininha();
    const result = await cobrar({ scenario: 'timeout_uncertain' });
    expect(listUncertainPayments(companyId)).toHaveLength(1);

    reconcileTerminalPayment({
      companyId,
      userId: gerente,
      transactionId: result.transactionId,
      outcome: 'recusado',
      reason: 'Extrato não mostra a transação.',
    });

    // Sem gravar o desfecho, o gestor reconciliaria a mesma cobrança para
    // sempre, a cada vez que abrisse a tela.
    expect(listUncertainPayments(companyId)).toHaveLength(0);
    expect(getTerminalPayment(companyId, result.transactionId).state).toBe('recusado');
  });

  it('a fila só mostra o que está de fato sem resposta', async () => {
    configurarMaquininha();
    await cobrar();
    await cobrar({ scenario: 'decline' });
    expect(listUncertainPayments(companyId)).toHaveLength(0);
  });

  it('transação já resolvida não é reconciliada', async () => {
    configurarMaquininha();
    const aprovada = await cobrar();
    expect(() =>
      reconcileTerminalPayment({
        companyId,
        userId: gerente,
        transactionId: aprovada.transactionId,
        outcome: 'recusado',
        reason: 'tentativa indevida',
      }),
    ).toThrowError(/já está aprovado/i);
  });
});
