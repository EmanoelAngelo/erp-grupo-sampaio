/**
 * ============================================================================
 * UMA COBRANÇA POR CHAVE — MESMO COM DUAS CHAMADAS AO MESMO TEMPO (GAP-PRD-008)
 * ============================================================================
 *
 * ## O defeito
 *
 * `createAndProcessPaymentTerminalTransactionBackend` fazia:
 *
 *     busca a chave  →  await provedor (segundos, com aparelho real)  →  grava
 *
 * Duas requisições com a mesma chave (reenvio do PDV depois de um timeout,
 * clique repetido, fila offline) passavam as duas pela busca antes de qualquer
 * uma gravar — e o cliente era cobrado DUAS VEZES no provedor. E se a API
 * caísse durante o `await`, nenhuma linha existia: o cliente podia ter sido
 * cobrado e o ERP não sabia; o reenvio com a mesma chave cobrava de novo.
 *
 * ## O que passa a valer, e o que estes casos cobram
 *
 * 1. A chave (empresa, idempotencyKey) é reservada NO BANCO, com UNIQUE, e a
 *    transação nasce `in_progress` ANTES de falar com o provedor.
 * 2. A segunda chamada com a mesma chave NÃO fala com o provedor: aguarda a
 *    primeira (mesmo processo) ou devolve a linha que já existe.
 * 3. Cobrança que ficou "falando com o provedor" sem ninguém esperando por
 *    ela (a API caiu no meio) aparece como NÃO CONFIRMADA — na fila de
 *    conferência do gestor — e nunca é cobrada de novo sozinha.
 * 4. Provedor que estoura no meio da chamada também é "não sei": não
 *    confirmado, nunca recusado.
 *
 * O adaptador é segurado por um dublê para que a janela entre "chamou" e
 * "respondeu" seja do tamanho que um aparelho real tem — o mock de verdade
 * responde num microtick e esconderia a corrida.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'uma-cobranca-por-chave-jwt-secret-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'uma-cobranca-por-chave-chave-de-cifra-comprida';

const controle = vi.hoisted(() => ({
  segurar: false,
  falhar: false,
  chamadas: 0,
  pendentes: [] as Array<() => void>,
}));

vi.mock('../src/services/payment-terminal/PaymentTerminalProviderAdapter.js', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('../src/services/payment-terminal/PaymentTerminalProviderAdapter.js')
  >();
  return {
    ...original,
    processPaymentTerminalTransaction: vi.fn(
      async (...args: Parameters<typeof original.processPaymentTerminalTransaction>) => {
        controle.chamadas += 1;
        if (controle.falhar) throw new Error('conexão com a adquirente caiu no meio da cobrança');
        if (controle.segurar) await new Promise<void>((soltar) => controle.pendentes.push(soltar));
        return original.processPaymentTerminalTransaction(...args);
      },
    ),
  };
});

const { createApp } = await import('../src/app.js');
const { resetDbForTests, findRows, insertRow } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
const { issueSession } = await import('./helpers/sessao.js');
const {
  createAndProcessPaymentTerminalTransactionBackend,
  createPaymentTerminalConfigurationBackend,
  resetTerminalChargesInFlightForTests,
} = await import('../src/services/payment-terminal/PaymentTerminalService.js');
const {
  chargeOnTerminal,
  getTerminalPayment,
  listUncertainPayments,
  reconcileTerminalPayment,
} = await import('../src/services/core/PdvTerminalService.js');

const app = createApp();

let loja: string;
let vizinha: string;
let operador: string;

/** Deixa as promessas e os ticks pendentes rodarem. */
async function tick(vezes = 5) {
  for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r));
}

function soltarTodas() {
  const lista = controle.pendentes.splice(0);
  for (const soltar of lista) soltar();
}

function linhasDaChave(companyId: string, chave: string) {
  return findRows('payment_terminal_transactions', (r) => r.companyId === companyId && r.idempotencyKey === chave);
}

function cobrar(companyId: string, chave: string, extra: Record<string, unknown> = {}) {
  return createAndProcessPaymentTerminalTransactionBackend({
    companyId,
    provider: 'mock',
    paymentMethod: 'credit',
    amountInCents: 15_000,
    installments: 1,
    idempotencyKey: chave,
    ...extra,
  }) as Promise<Record<string, unknown>>;
}

beforeEach(async () => {
  soltarTodas();
  controle.segurar = false;
  controle.falhar = false;
  controle.chamadas = 0;
  resetTerminalChargesInFlightForTests();
  resetDbForTests();
  loja = upsertCompany({ slug: 'me-mimei', legalName: 'Me Mimei Ltda', tradeName: 'Me Mimei' });
  vizinha = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  operador = await upsertUser({ login: 'CAIXA.MM', displayName: 'Caixa', password: 'Senha@Caixa2026' });
  linkUserToCompany(operador, loja, 'operador_caixa_loja', true);
  for (const companyId of [loja, vizinha]) {
    createPaymentTerminalConfigurationBackend({
      companyId,
      provider: 'mock',
      active: true,
      displayName: 'Balcão',
      idempotencyKey: `cfg-${companyId}`,
    });
  }
});

describe('duas chamadas simultâneas com a mesma chave', () => {
  it('cobram UMA vez no provedor e devolvem a MESMA transação', async () => {
    controle.segurar = true;
    const chave = 'venda-123';
    const primeira = cobrar(loja, chave);
    const segunda = cobrar(loja, chave);
    await tick();
    soltarTodas();
    const [a, b] = await Promise.all([primeira, segunda]);

    expect(b.id).toBe(a.id);
    expect(controle.chamadas).toBe(1);
    expect(linhasDaChave(loja, chave)).toHaveLength(1);
    expect(a.status).toBe('authorized');
    expect(b.status).toBe('authorized');
  });

  it('também sem segurar o provedor (o caso que a auditoria mediu: 2 linhas)', async () => {
    const chave = 'venda-456';
    const [a, b] = await Promise.all([cobrar(loja, chave), cobrar(loja, chave)]);
    expect(b.id).toBe(a.id);
    expect(linhasDaChave(loja, chave)).toHaveLength(1);
    expect(controle.chamadas).toBe(1);
  });

  it('pela rota HTTP, dois POST simultâneos com o mesmo Idempotency-Key viram uma cobrança', async () => {
    controle.segurar = true;
    const sessao = issueSession({
      userId: operador,
      companyId: loja,
      storeId: 'store-mm',
      profileCodes: ['admin_geral'],
    });
    const auth = { Authorization: `Bearer ${sessao.accessToken}` };
    const chave = `http-${randomUUID()}`;
    const enviar = () =>
      request(app)
        .post('/api/v1/payment-terminals/transactions')
        .set(auth)
        .set('Idempotency-Key', chave)
        .send({ amountInCents: 1000, paymentMethod: 'credit', provider: 'mock' });

    const r1 = enviar().then((r) => r);
    const r2 = enviar().then((r) => r);
    // As duas requisições precisam chegar ao serviço antes de o provedor responder.
    for (let i = 0; i < 50 && controle.chamadas < 1; i += 1) await tick();
    await tick(20);
    soltarTodas();
    const [a, b] = await Promise.all([r1, r2]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(controle.chamadas).toBe(1);
    expect(linhasDaChave(loja, chave)).toHaveLength(1);
  });

  it('a mesma chave em empresas DIFERENTES continua sendo duas cobranças', async () => {
    const [a, b] = await Promise.all([cobrar(loja, 'caixa-1'), cobrar(vizinha, 'caixa-1')]);
    expect(a.id).not.toBe(b.id);
    expect(a.companyId).toBe(loja);
    expect(b.companyId).toBe(vizinha);
    expect(controle.chamadas).toBe(2);
  });
});

describe('a transação existe ANTES de o provedor responder', () => {
  it('nasce in_progress, e o balcão a vê como "processando" enquanto a chamada está viva', async () => {
    controle.segurar = true;
    const chave = randomUUID();
    const emCurso = cobrar(loja, chave);
    await tick();

    const linhas = linhasDaChave(loja, chave);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe('in_progress');
    expect(linhas[0].providerCallState).toBe('awaiting_provider');
    expect(getTerminalPayment(loja, String(linhas[0].id)).state).toBe('processando');
    // Enquanto a chamada está viva, não é pendência de conferência.
    expect(listUncertainPayments(loja)).toHaveLength(0);

    soltarTodas();
    const final = await emCurso;
    expect(final.id).toBe(linhas[0].id);
    expect(final.status).toBe('authorized');
    expect(final.providerCallState).toBe('answered');
  });

  it('a chave fica reservada no banco com UNIQUE (empresa, chave)', async () => {
    const tx = await cobrar(loja, 'chave-unica');
    const reservas = getConnection()
      .prepare(
        `SELECT transaction_id FROM core_payment_terminal_charge_keys
          WHERE company_id = ? AND idempotency_key = ?`,
      )
      .all(loja, 'chave-unica') as { transaction_id: string }[];
    expect(reservas).toEqual([{ transaction_id: tx.id }]);

    expect(() =>
      getConnection()
        .prepare(
          `INSERT INTO core_payment_terminal_charge_keys
             (company_id, idempotency_key, transaction_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(loja, 'chave-unica', 'pttx-outra', new Date().toISOString()),
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('sem chave de idempotência, não há cobrança', async () => {
    await expect(
      createAndProcessPaymentTerminalTransactionBackend({
        companyId: loja,
        provider: 'mock',
        paymentMethod: 'credit',
        amountInCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_TERMINAL_IDEMPOTENCY_REQUIRED', status: 400 });
    expect(controle.chamadas).toBe(0);
  });
});

describe('a API caiu durante a chamada ao provedor', () => {
  it('a cobrança órfã aparece como NÃO CONFIRMADA, e o reenvio não cobra de novo', async () => {
    controle.segurar = true;
    const chave = randomUUID();
    const pendente = cobrar(loja, chave).catch(() => null);
    await tick();
    const [orfa] = linhasDaChave(loja, chave);
    expect(orfa.status).toBe('in_progress');

    // "Reinício": o processo que esperava a resposta morreu. A promessa em voo
    // some junto; a linha no banco é tudo o que sobra.
    resetTerminalChargesInFlightForTests();
    controle.segurar = false;
    const chamadasAntes = controle.chamadas;

    const vista = getTerminalPayment(loja, String(orfa.id));
    expect(vista.state).toBe('timeout_nao_confirmado');
    expect(vista.settled).toBe(false);
    expect(vista.needsReconciliation).toBe(true);
    expect(listUncertainPayments(loja).map((p) => p.transactionId)).toEqual([orfa.id]);

    // O PDV reenviando com a mesma chave recebe a mesma cobrança — e o
    // provedor não é chamado de novo.
    const reenvio = await chargeOnTerminal({
      companyId: loja,
      userId: operador,
      method: 'credito',
      amountInCents: 15_000,
      idempotencyKey: chave,
    });
    expect(reenvio.transactionId).toBe(orfa.id);
    expect(reenvio.state).toBe('timeout_nao_confirmado');
    expect(controle.chamadas).toBe(chamadasAntes);

    // A saída é a de sempre: o gestor confere o extrato e afirma.
    const fechado = reconcileTerminalPayment({
      companyId: loja,
      userId: operador,
      transactionId: String(orfa.id),
      outcome: 'aprovado',
      reason: 'Extrato da adquirente: NSU 771 aprovado às 10h12.',
    });
    expect(fechado.settled).toBe(true);
    expect(getTerminalPayment(loja, String(orfa.id)).state).toBe('aprovado');
    expect(listUncertainPayments(loja)).toHaveLength(0);
    // E se a resposta do provedor chegar DEPOIS da decisão do gestor, ela não
    // sobrescreve o que foi afirmado pelo extrato: vai para o histórico.
    soltarTodas();
    await pendente;
    expect(getTerminalPayment(loja, String(orfa.id)).state).toBe('aprovado');
    expect(
      findRows('payment_terminal_history', (r) => r.transactionId === orfa.id && r.action === 'late_provider_answer'),
    ).toHaveLength(1);
  });

  it('linha órfã deixada por uma versão que caiu antes de responder também é não confirmada', () => {
    insertRow('payment_terminal_transactions', {
      id: 'pttx-orfa-de-boot-anterior',
      companyId: loja,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 9_900,
      idempotencyKey: 'chave-do-boot-anterior',
      status: 'in_progress',
      providerCallState: 'awaiting_provider',
      providerCallStartedAt: '2026-09-10T22:00:00.000Z',
    });
    const vista = getTerminalPayment(loja, 'pttx-orfa-de-boot-anterior');
    expect(vista.state).toBe('timeout_nao_confirmado');
    expect(vista.needsReconciliation).toBe(true);
  });

  it('o provedor estourando no meio da chamada é "não sei": não confirmado, nunca recusado', async () => {
    controle.falhar = true;
    const chave = randomUUID();
    const tx = await cobrar(loja, chave);
    expect(tx.status).toBe('timeout_uncertain');
    expect(String(tx.providerError)).toMatch(/caiu/);
    const vista = getTerminalPayment(loja, String(tx.id));
    expect(vista.state).toBe('timeout_nao_confirmado');
    expect(vista.state).not.toBe('recusado');

    // E o reenvio não tenta de novo por conta própria.
    controle.falhar = false;
    const reenvio = await cobrar(loja, chave);
    expect(reenvio.id).toBe(tx.id);
    expect(controle.chamadas).toBe(1);
  });
});

/*
  A MESMA CHAVE COM OUTRA COBRANÇA NÃO É REENVIO (RES-IDEM-VIZ).

  O reenvio devolvia a transação da chave sem olhar o que se pedia: a mesma
  chave com R$ 250 em vez de R$ 150 respondia a cobrança de R$ 150 como se
  fosse a nova — o balcão acharia que cobrou um valor que ninguém cobrou.
*/
describe('a mesma chave com outro valor, forma ou parcelas', () => {
  it('é recusada com 422 CORE_IDEMPOTENCY_KEY_REUSED, sem nova linha e sem chamar o provedor', async () => {
    const chave = `outra-${randomUUID()}`;
    const tx = await cobrar(loja, chave);
    expect(tx.status).toBe('authorized');
    const chamadasAntes = controle.chamadas;

    for (const extra of [{ amountInCents: 25_000 }, { paymentMethod: 'debit' }, { installments: 3 }]) {
      await expect(cobrar(loja, chave, extra)).rejects.toMatchObject({
        code: 'CORE_IDEMPOTENCY_KEY_REUSED',
        status: 422,
      });
    }
    expect(linhasDaChave(loja, chave)).toHaveLength(1);
    expect(controle.chamadas).toBe(chamadasAntes);
  });

  it('pela rota do PDV também: 422, e a cobrança da chave continua a original', async () => {
    const chave = `pdv-${randomUUID()}`;
    const tx = await cobrar(loja, chave);
    await expect(
      chargeOnTerminal({ companyId: loja, userId: operador, method: 'credito', amountInCents: 9_000, idempotencyKey: chave }),
    ).rejects.toMatchObject({ code: 'CORE_IDEMPOTENCY_KEY_REUSED', status: 422 });
    expect(linhasDaChave(loja, chave).map((r) => r.id)).toEqual([tx.id]);
  });

  it('cobrança anterior à impressão digital: a mesma chave devolve a linha, como sempre', async () => {
    insertRow('payment_terminal_transactions', {
      id: 'pttx-anterior-a-impressao',
      companyId: loja,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 9_900,
      installments: 1,
      idempotencyKey: 'chave-anterior-a-impressao',
      status: 'authorized',
      providerCallState: 'answered',
    });
    const reenvio = await cobrar(loja, 'chave-anterior-a-impressao', { amountInCents: 12_345 });
    expect(reenvio.id).toBe('pttx-anterior-a-impressao');
    expect(controle.chamadas).toBe(0);
  });
});
