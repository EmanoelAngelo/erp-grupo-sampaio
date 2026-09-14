/**
 * ============================================================================
 * COBRAR O TÍTULO: o contas a receber vira PIX, boleto ou link
 * ============================================================================
 *
 * O DEFEITO QUE ESTE ARQUIVO COBRA (GAP-V70)
 *
 * `createPaymentIntent` estava escrito, testado por ninguém e SEM UM ÚNICO
 * CHAMADOR. O único criador vivo de cobrança era o checkout da loja online, e
 * `FinanceService` não tinha uma linha sobre o Asaas. Quer dizer: lançar o
 * aluguel, a OS da oficina ou a venda a prazo no contas a receber e cobrar o
 * cliente por PIX era impossível pelo sistema — a infraestrutura inteira
 * (credencial por operação, vínculo de cliente, webhook, conciliação) existia
 * para o pedido online e para mais ninguém.
 *
 * Aqui o título ganha o botão: cobrança criada na conta DA OPERAÇÃO, QR/linha
 * digitável/URL de volta na tela, e o webhook que já existia passa a DAR BAIXA
 * no título quando o dinheiro entra.
 *
 * O PROVEDOR É UM DUBLÊ EXPLÍCITO (`asaasDeTeste`), no molde de
 * `ecommerce-jornada.test.ts`: nada aqui é homologação e nada sai deste
 * processo. O `AsaasHttpClient` real é quem monta a requisição — o dublê só
 * devolve o corpo, e é por isso que o teste ainda prova o caminho.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { createEntry, listEntries } from '../src/services/core/FinanceService.js';
import {
  handlePaymentWebhook,
  getIntentsFor,
  listPaymentIntents,
  retryPaymentIntent,
} from '../src/services/core/PaymentService.js';
import {
  cancelFinanceEntryCharges,
  chargeFinanceEntry,
} from '../src/services/core/FinanceChargeService.js';
import { reconcileAsaas } from '../src/services/core/AsaasReconciliation.js';

const CHAVE_PJ = '$aact_sandbox_preco_justo_00000000000000';
const CHAVE_GRINGA = '$aact_sandbox_gringa_1111111111111111111';
const TOKEN_PJ = 'token-webhook-preco-justo';
const TOKEN_GRINGA = 'token-webhook-gringa';

let precoJusto: string;
let gringa: string;
let semChave: string;
let seq = 0;

/**
 * Dublê do Asaas.
 *
 * Responde ao que o `AsaasHttpClient` realmente pede, no formato que a API
 * documenta. Conta as chamadas — é assim que se prova que dois cliques no
 * botão "Cobrar" não viram duas cobranças no boleto de ninguém.
 *
 * `falharProximoPagamento` existe para o retry (GAP-V76): o provedor oscila,
 * a intenção fica `failed`, e o botão "tentar de novo" tem de terminar o
 * serviço sem criar uma segunda cobrança.
 */
function asaasDeTeste(
  opcoes: { falharProximoPagamento?: boolean; falharCancelamento?: boolean } = {},
) {
  const chamadas: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
  let falhar = opcoes.falharProximoPagamento ?? false;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    chamadas.push({ method: metodo, url: endereco, body: corpo });

    const responder = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (endereco.endsWith('/customers') && metodo === 'POST') {
      seq += 1;
      return responder({ id: `cus_TEST_${seq}`, name: corpo?.name });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      if (falhar) {
        falhar = false;
        return responder({ errors: [{ description: 'instabilidade' }] }, 500);
      }
      seq += 1;
      return responder({
        id: `pay_TEST_${seq}`,
        invoiceUrl: `https://sandbox.asaas.com/i/TEST_${seq}`,
        bankSlipUrl: `https://sandbox.asaas.com/b/TEST_${seq}`,
        dueDate: String(corpo?.dueDate ?? '2026-12-31'),
      });
    }
    if (endereco.includes('/pixQrCode')) {
      return responder({
        payload: '00020126TESTE-COPIA-E-COLA',
        encodedImage: 'iVBORw0KGgoTESTE',
        expirationDate: '2026-12-31 23:59:59',
      });
    }
    if (endereco.includes('/identificationField')) {
      return responder({
        identificationField: '34191.79001 01043.510047 91020.150008 1 96610000010000',
      });
    }
    // Remover a cobrança é DELETE /payments/:id no Asaas (GAP-PRD-169).
    if (metodo === 'DELETE' && /[/]payments[/][^/?]+$/.test(endereco)) {
      // O provedor fora do ar no cancelamento é o cenário que separa "a
      // cobrança morreu" de "eu quis que ela morresse".
      if (opcoes.falharCancelamento) return responder({ errors: [{ description: 'fora' }] }, 500);
      return responder({ id: 'pay_TEST_cancelado', status: 'CANCELLED' });
    }
    return responder({});
  }) as unknown as typeof fetch;

  const pagamentosCriados = () =>
    chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/payments'));

  return { fetchImpl, chamadas, pagamentosCriados };
}

function cliente(companyId: string, dados: { documento?: string | null } = {}): string {
  seq += 1;
  const id = `cli-${companyId.slice(0, 4)}-${seq}`;
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Dona Marlene', ?, 'marlene@exemplo.com.br', 1, ?, ?)`,
    )
    .run(
      id,
      companyId,
      // Documento próprio por cadastro: a UNIQUE (empresa, documento) do
      // cliente é real, e reaproveitar o mesmo CPF esconderia o cenário.
      dados.documento === undefined ? String(52998224725 + seq) : dados.documento,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  return id;
}

function tituloAReceber(
  companyId: string,
  input: { amountCents: number; dueDate?: string; customerId?: string | null },
) {
  return createEntry({
    companyId,
    direction: 'in',
    description: 'Aluguel da sala 2',
    amountCents: input.amountCents,
    dueDate: input.dueDate ?? '2026-09-10',
    customerId: input.customerId ?? cliente(companyId),
  });
}

function entradaCrua(id: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_finance_entries WHERE id = ?')
    .get(id) as Record<string, unknown>;
}

function evento(
  id: string,
  event: string,
  providerRef: string,
  valorReais?: number,
): Record<string, unknown> {
  return {
    id,
    event,
    payment: valorReais === undefined ? { id: providerRef } : { id: providerRef, value: valorReais },
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  semChave = await upsertCompany({
    slug: 'sem-chave',
    tradeName: 'Sem Chave',
    legalName: 'Sem Chave Ltda',
  });
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'sandbox', apiKey: CHAVE_PJ });
  upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_PJ });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_GRINGA });
  vi.stubEnv('ASAAS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe('GAP-V70 — o título a receber vira cobrança no provedor', () => {
  it('cria a cobrança PIX com o cliente do título e devolve o copia-e-cola', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });

    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    expect(cobranca.status).toBe('pending');
    expect(cobranca.intent.origin_type).toBe('finance_entry');
    expect(cobranca.intent.origin_id).toBe(titulo.id);
    expect(cobranca.intent.amount_cents).toBe(30000);
    expect(cobranca.pixPayload).toBe('00020126TESTE-COPIA-E-COLA');
    expect(cobranca.invoiceUrl).toContain('https://sandbox.asaas.com/i/');

    // O cliente foi resolvido no provedor ANTES da cobrança, e o vínculo ficou.
    const criouCliente = asaas.chamadas.find((c) => c.url.endsWith('/customers'));
    expect(criouCliente).toBeTruthy();
    const pagamento = asaas.pagamentosCriados()[0];
    expect(pagamento.body?.billingType).toBe('PIX');
    // Reais no provedor, centavos aqui. 30000 centavos = R$ 300,00.
    expect(pagamento.body?.value).toBe(300);
    expect(pagamento.body?.externalReference).toBe(titulo.id);
  });

  it('boleto devolve a linha digitável; cartão sai como CREDIT_CARD na página do provedor', async () => {
    const asaas = asaasDeTeste();
    const boleto = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: tituloAReceber(precoJusto, { amountCents: 15000 }).id,
      method: 'boleto',
      fetchImpl: asaas.fetchImpl,
    });
    expect(boleto.identificationField).toContain('34191.79001');

    const cartao = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: tituloAReceber(precoJusto, { amountCents: 15000 }).id,
      method: 'cartao',
      fetchImpl: asaas.fetchImpl,
    });
    expect(cartao.intent.method).toBe('cartao');
    expect(asaas.pagamentosCriados().at(-1)?.body?.billingType).toBe('CREDIT_CARD');
    // O número do cartão NUNCA passa por aqui: quem digita é a página do provedor.
    expect(cartao.invoiceUrl).toContain('https://sandbox.asaas.com/i/');
  });

  it('o webhook do provedor BAIXA o título quando o pagamento entra', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    const r = handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload: evento('evt-1', 'PAYMENT_RECEIVED', cobranca.intent.provider_ref!, 300),
    });
    expect(r.accepted).toBe(true);

    const depois = entradaCrua(titulo.id);
    expect(Number(depois.settled_cents)).toBe(30000);
    expect(String(depois.status)).toBe('settled');

    // A baixa deixa rastro conciliável — não é um saldo que aparece do nada.
    const baixas = getConnection()
      .prepare('SELECT * FROM core_finance_settlements WHERE entry_id = ?')
      .all(titulo.id) as Record<string, unknown>[];
    expect(baixas).toHaveLength(1);
    expect(Number(baixas[0].amount_cents)).toBe(30000);
  });

  it('reprocessar o MESMO evento não baixa duas vezes', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    const payload = evento('evt-repetido', 'PAYMENT_RECEIVED', cobranca.intent.provider_ref!, 300);

    handlePaymentWebhook({ provider: 'asaas', token: TOKEN_PJ, companyId: precoJusto, payload });
    const segunda = handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload,
    });

    expect(segunda.duplicated).toBe(true);
    expect(Number(entradaCrua(titulo.id).settled_cents)).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
describe('GAP-V70 — as falsificações', () => {
  it('título de OUTRA empresa não é cobrável pela conta desta', async () => {
    const asaas = asaasDeTeste();
    const daGringa = tituloAReceber(gringa, { amountCents: 30000 });

    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: daGringa.id,
        method: 'pix',
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_ENTRY_NOT_FOUND' });
    expect(asaas.pagamentosCriados()).toHaveLength(0);
  });

  it('título já quitado não gera cobrança nova', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    getConnection()
      .prepare(
        "UPDATE core_finance_entries SET settled_cents = amount_cents, status = 'settled' WHERE id = ?",
      )
      .run(titulo.id);

    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: titulo.id,
        method: 'pix',
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_ENTRY_SETTLED' });
    expect(asaas.pagamentosCriados()).toHaveLength(0);
  });

  it('duas cobranças do mesmo título são UMA — dois cliques não cobram duas vezes', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });

    const primeira = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    const segunda = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    expect(segunda.intent.id).toBe(primeira.intent.id);
    expect(segunda.intent.provider_ref).toBe(primeira.intent.provider_ref);
    expect(asaas.pagamentosCriados()).toHaveLength(1);
    expect(getIntentsFor({ companyId: precoJusto, originType: 'finance_entry', originId: titulo.id }))
      .toHaveLength(1);
  });

  it('webhook com VALOR DIVERGENTE não baixa o título — a conferência da casa é preservada', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    const r = handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      // R$ 1,00 num título de R$ 300,00.
      payload: evento('evt-divergente', 'PAYMENT_RECEIVED', cobranca.intent.provider_ref!, 1),
    });

    expect(r.detail).toContain('divergente');
    expect(Number(entradaCrua(titulo.id).settled_cents)).toBe(0);
    const intent = getIntentsFor({
      companyId: precoJusto,
      originType: 'finance_entry',
      originId: titulo.id,
    })[0];
    expect(intent.status).toBe('amount_mismatch');
    expect(intent.last_error).toContain('300,00');
  });

  it('sem credencial configurada a ação é RECUSADA com o estado honesto', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(semChave, { amountCents: 30000 });

    await expect(
      chargeFinanceEntry({
        companyId: semChave,
        entryId: titulo.id,
        method: 'pix',
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_ASAAS_UNCONFIGURED' });
    expect(asaas.pagamentosCriados()).toHaveLength(0);
    // Nada de intenção fantasma para a tela mostrar como "pendente".
    expect(
      getIntentsFor({ companyId: semChave, originType: 'finance_entry', originId: titulo.id }),
    ).toHaveLength(0);
  });

  it('título a PAGAR não vira cobrança — cobra-se o que se recebe', async () => {
    const asaas = asaasDeTeste();
    const conta = createEntry({
      companyId: precoJusto,
      direction: 'out',
      description: 'Energia',
      amountCents: 9000,
      dueDate: '2026-09-10',
    });
    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: conta.id,
        method: 'pix',
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_CHARGE_DIRECTION' });
  });

  it('título sem cliente não vira cobrança — o provedor pendura a cobrança em alguém', async () => {
    const asaas = asaasDeTeste();
    const semCliente = createEntry({
      companyId: precoJusto,
      direction: 'in',
      description: 'Venda a prazo do balcão',
      amountCents: 5000,
      dueDate: '2026-09-10',
    });
    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: semCliente.id,
        method: 'pix',
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_CHARGE_WITHOUT_CUSTOMER' });
  });

  it('cliente sem CPF/CNPJ é recusado com o nome do campo, antes de cobrar', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, {
      amountCents: 5000,
      customerId: cliente(precoJusto, { documento: null }),
    });
    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: titulo.id,
        method: 'pix',
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_ASAAS_CUSTOMER_DOCUMENT_REQUIRED' });
    expect(asaas.pagamentosCriados()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('GAP-V73 — cobrança parcelada vira carnê no contas a receber', () => {
  it('parcela em 3 com a régua de centavos da casa e uma cobrança por parcela', async () => {
    const asaas = asaasDeTeste();
    // 10000 em 3: 3334 + 3333 + 3333. O resto vai na PRIMEIRA, regra da casa.
    const titulo = tituloAReceber(precoJusto, { amountCents: 10000, dueDate: '2026-01-31' });

    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'boleto',
      installmentCount: 3,
      fetchImpl: asaas.fetchImpl,
    });

    expect(cobranca.installments).toHaveLength(3);
    expect(cobranca.installments.map((p) => p.amountCents)).toEqual([3334, 3333, 3333]);
    // Vencimento mensal com clamp de fim de mês — 31/jan, 28/fev, 31/mar.
    expect(cobranca.installments.map((p) => p.dueDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);

    const parcelas = listEntries(precoJusto, { direction: 'in' });
    expect(parcelas).toHaveLength(3);
    expect(parcelas.map((p) => p.installmentNumber).sort()).toEqual([1, 2, 3]);
    expect(parcelas.every((p) => p.installmentTotal === 3)).toBe(true);
    expect(parcelas.reduce((s, p) => s + p.amountCents, 0)).toBe(10000);

    // Uma cobrança por parcela, cada uma com o SEU vencimento e o SEU valor.
    expect(asaas.pagamentosCriados()).toHaveLength(3);
    expect(asaas.pagamentosCriados().map((c) => c.body?.value)).toEqual([33.34, 33.33, 33.33]);
  });

  it('o webhook da parcela 2 baixa a parcela 2 — e só ela', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 10000, dueDate: '2026-01-31' });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'boleto',
      installmentCount: 3,
      fetchImpl: asaas.fetchImpl,
    });

    const segunda = cobranca.installments[1];
    handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload: evento('evt-p2', 'PAYMENT_RECEIVED', segunda.providerRef!, 33.33),
    });

    expect(Number(entradaCrua(segunda.entryId).settled_cents)).toBe(3333);
    expect(Number(entradaCrua(cobranca.installments[0].entryId).settled_cents)).toBe(0);
    expect(Number(entradaCrua(cobranca.installments[2].entryId).settled_cents)).toBe(0);
  });

  it('título com baixa parcial não se parcela — o carnê nasceria mentindo', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 10000, dueDate: '2026-01-31' });
    getConnection()
      .prepare('UPDATE core_finance_entries SET settled_cents = 1000 WHERE id = ?')
      .run(titulo.id);

    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: titulo.id,
        method: 'boleto',
        installmentCount: 3,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_CHARGE_INSTALLMENTS_REFUSED' });
    // O título continua inteiro: nada foi partido antes da recusa.
    expect(Number(entradaCrua(titulo.id).installment_total)).toBe(1);
    expect(Number(entradaCrua(titulo.id).amount_cents)).toBe(10000);
  });

  it('parcelar duas vezes o mesmo título é recusado — ele já é parcela', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 10000, dueDate: '2026-01-31' });
    await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'boleto',
      installmentCount: 3,
      fetchImpl: asaas.fetchImpl,
    });

    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: titulo.id,
        method: 'boleto',
        installmentCount: 2,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_CHARGE_INSTALLMENTS_REFUSED' });
    expect(listEntries(precoJusto, { direction: 'in' })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
describe('GAP-V75/V76 — status, falhas e a segunda tentativa', () => {
  it('a falha do provedor fica REGISTRADA na intenção, com o erro e a tentativa', async () => {
    const asaas = asaasDeTeste({ falharProximoPagamento: true });
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });

    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    expect(cobranca.status).toBe('failed');
    expect(cobranca.intent.provider_ref).toBeFalsy();
    expect(cobranca.intent.last_error).toBeTruthy();
    // A chave da cobrança NUNCA aparece no erro guardado.
    expect(cobranca.intent.last_error).not.toContain(CHAVE_PJ);
  });

  it('a lista de cobranças da operação mostra status, erro e tentativas', async () => {
    const asaas = asaasDeTeste({ falharProximoPagamento: true });
    const falhou = tituloAReceber(precoJusto, { amountCents: 30000 });
    const ok = tituloAReceber(precoJusto, { amountCents: 12000 });
    await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: falhou.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: ok.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    const todas = listPaymentIntents({ companyId: precoJusto });
    expect(todas).toHaveLength(2);
    const comFalha = todas.find((i) => i.status === 'failed')!;
    expect(comFalha.lastError).toBeTruthy();
    expect(comFalha.attempts).toBeGreaterThanOrEqual(1);
    expect(comFalha.amountCents).toBe(30000);
    expect(comFalha.originType).toBe('finance_entry');
    expect(comFalha.originLabel).toContain('Aluguel');

    // O filtro por status é o que o gestor usa para achar o que quebrou.
    expect(listPaymentIntents({ companyId: precoJusto, status: 'failed' })).toHaveLength(1);
    // E a cobrança de OUTRA operação não aparece nesta lista.
    expect(listPaymentIntents({ companyId: gringa })).toHaveLength(0);
  });

  it('re-tentar a cobrança falhada usa a MESMA intenção e não cria uma segunda', async () => {
    const asaas = asaasDeTeste({ falharProximoPagamento: true });
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const falha = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    expect(falha.status).toBe('failed');

    const retentativa = await retryPaymentIntent({
      companyId: precoJusto,
      intentId: falha.intent.id,
      fetchImpl: asaas.fetchImpl,
    });

    expect(retentativa.status).toBe('pending');
    expect(retentativa.intent.id).toBe(falha.intent.id);
    expect(retentativa.intent.provider_ref).toBeTruthy();
    expect(Number(retentativa.intent.attempts)).toBe(2);
    expect(
      getIntentsFor({ companyId: precoJusto, originType: 'finance_entry', originId: titulo.id }),
    ).toHaveLength(1);
  });

  it('a intenção de OUTRA empresa não é re-tentável por esta', async () => {
    const asaas = asaasDeTeste({ falharProximoPagamento: true });
    const daGringa = tituloAReceber(gringa, { amountCents: 30000 });
    const falha = await chargeFinanceEntry({
      companyId: gringa,
      entryId: daGringa.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    await expect(
      retryPaymentIntent({
        companyId: precoJusto,
        intentId: falha.intent.id,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_PAYMENT_INTENT_NOT_FOUND' });
  });

  it('cobrança que JÁ existe no provedor não é re-tentada — seria cobrar duas vezes', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    await expect(
      retryPaymentIntent({
        companyId: precoJusto,
        intentId: cobranca.intent.id,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_PAYMENT_INTENT_NOT_RETRIABLE' });
    expect(asaas.pagamentosCriados()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('as portas HTTP da cobrança', () => {
  it('estoquista não cobra; gerente cobra e a trilha registra', async () => {
    const asaas = asaasDeTeste();
    vi.stubGlobal('fetch', asaas.fetchImpl);

    const app = createApp();
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: 'company-1',
      profileCodes: ['gerente_loja'],
    });
    const estoque = await loginForTest(app, {
      userId: 'estoquista',
      companyId: 'company-1',
      profileCodes: ['estoquista'],
    });
    upsertAsaasApiKey({ companyId: 'company-1', environment: 'sandbox', apiKey: CHAVE_PJ });

    const titulo = tituloAReceber('company-1', { amountCents: 30000 });

    const negado = await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charge`)
      .set('Authorization', `Bearer ${estoque.body.accessToken as string}`)
      .send({ method: 'pix' });
    expect(negado.status).toBe(403);

    const ok = await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charge`)
      .set('Authorization', `Bearer ${gerente.body.accessToken as string}`)
      .send({ method: 'pix' });
    expect(ok.status).toBe(201);
    expect(ok.body.pixPayload).toBe('00020126TESTE-COPIA-E-COLA');

    const trilha = getConnection()
      .prepare("SELECT * FROM core_audit_log WHERE action = 'finance.charge_created'")
      .all() as Record<string, unknown>[];
    expect(trilha).toHaveLength(1);

    // A lista de cobranças do título responde para quem a tela deixa entrar.
    const lista = await request(app)
      .get(`/api/v1/core/finance/entries/${titulo.id}/charges`)
      .set('Authorization', `Bearer ${estoque.body.accessToken as string}`);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);

    // E a lista geral (a tela de status das cobranças) também.
    const painel = await request(app)
      .get('/api/v1/core/payment-intents')
      .set('Authorization', `Bearer ${estoque.body.accessToken as string}`);
    expect(painel.status).toBe(200);
    expect(painel.body.items).toHaveLength(1);
  });

  it('a resposta da cobrança NUNCA carrega a chave da operação', async () => {
    const asaas = asaasDeTeste();
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const app = createApp();
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: 'company-1',
      profileCodes: ['gerente_loja'],
    });
    upsertAsaasApiKey({ companyId: 'company-1', environment: 'sandbox', apiKey: CHAVE_PJ });
    const titulo = tituloAReceber('company-1', { amountCents: 30000 });

    const ok = await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charge`)
      .set('Authorization', `Bearer ${gerente.body.accessToken as string}`)
      .send({ method: 'pix' });

    expect(JSON.stringify(ok.body)).not.toContain(CHAVE_PJ);
    expect(JSON.stringify(ok.body)).not.toContain('aact_');
  });
});

// ---------------------------------------------------------------------------
describe('a conciliação conhece a SEGUNDA origem de cobrança', () => {
  /**
   * O DEFEITO (regressão do V13-ASS-016): `AsaasReconciliation` ficou intocado
   * quando a cobrança avulsa nasceu. O lado do provedor trazia a intenção do
   * título (`finance_entry:<id>`), o lado do financeiro filtrava
   * `origin_type IN ('ecommerce_order','sale')` — e o título avulso é
   * `manual:<id dele mesmo>`. A chave da comparação é `origin_type:origin_id`,
   * então 'finance_entry:x' nunca casava com 'manual:x': TODO título cobrado e
   * pago aparecia como `cobrado_nao_lancado`, mesmo com o webhook tendo baixado
   * o título corretamente na mesma tela.
   *
   * Este é o caminho INTEIRO: cobrança criada pelo serviço real, webhook real,
   * baixa real, conciliação real. Nenhuma linha é escrita à mão.
   */
  it('título cobrado e pago pelo provedor NÃO aparece como divergência', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload: evento('evt-conc-1', 'PAYMENT_RECEIVED', cobranca.intent.provider_ref!, 300),
    });
    // O título FOI baixado — é este o fato que a conciliação estava negando.
    expect(String(entradaCrua(titulo.id).status)).toBe('settled');

    const r = reconcileAsaas({ companyId: precoJusto });

    expect(r.rows).toHaveLength(0);
    expect(r.matched).toBe(1);
    expect([r.providerCents, r.financeCents, r.differenceCents]).toEqual([30000, 30000, 0]);
  });

  it('e o alerta continua existindo: pagamento confirmado sem baixa é divergência', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    /*
      Alguém baixou o título no caixa ANTES do webhook: `settleEntry` recusa a
      segunda baixa e o desfecho é "Pagamento confirmado, título NÃO baixado".
      A baixa manual não deixa `settled_at` dentro da janela do provedor, então
      o lado do financeiro não a enxerga — e é exatamente disto que a
      conciliação tem de falar.
    */
    getConnection()
      .prepare(
        `UPDATE core_finance_entries
            SET settled_cents = amount_cents, status = 'settled', settled_at = NULL
          WHERE id = ?`,
      )
      .run(titulo.id);
    handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload: evento('evt-conc-2', 'PAYMENT_RECEIVED', cobranca.intent.provider_ref!, 300),
    });

    const r = reconcileAsaas({ companyId: precoJusto });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('cobrado_nao_lancado');
    expect(r.rows[0].originType).toBe('finance_entry');
    expect(r.rows[0].originId).toBe(titulo.id);
  });

  it('no carnê, a parcela paga bate e as outras duas não viram divergência', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 10000, dueDate: '2026-01-31' });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'boleto',
      installmentCount: 3,
      fetchImpl: asaas.fetchImpl,
    });

    const segunda = cobranca.installments[1];
    handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload: evento('evt-conc-3', 'PAYMENT_RECEIVED', segunda.providerRef!, 33.33),
    });

    const r = reconcileAsaas({ companyId: precoJusto });
    // Parcela 2 casada; parcelas 1 e 3 são cobrança EM ABERTO, não divergência.
    expect(r.rows).toHaveLength(0);
    expect(r.matched).toBe(1);
    expect([r.providerCents, r.financeCents]).toEqual([3333, 3333]);
  });
});

// ---------------------------------------------------------------------------
describe('GAP-V73 — parcelar DEPOIS de cobrar não deixa a parcela 1 com o valor cheio', () => {
  /**
   * O DEFEITO: a tela só travava o campo de parcelas por `installmentTotal > 1`
   * ou `settledCents > 0`, e o servidor não conferia intenção existente antes
   * de chamar `parcelarEntrada`. O estrago era silencioso e em três passos:
   *
   *   1. o título de R$ 300 vira carnê de 3 × R$ 100;
   *   2. a parcela 1 MANTÉM O ID do título, então reencontra a MESMA chave de
   *      idempotência (`finance_entry:<id>:pix`) e recebe a intenção ANTIGA —
   *      a de R$ 300, viva no provedor;
   *   3. se o cliente pagar os R$ 300, `settleEntry` recusa por exceder o saldo
   *      da parcela (R$ 100) e o desfecho é "Pagamento confirmado, título NÃO
   *      baixado": dinheiro na conta e contas a receber em aberto — o pior
   *      estado possível.
   *
   * A trava de tela não protege outro cliente HTTP. A recusa mora no SERVIDOR.
   */
  it('o servidor RECUSA parcelar um título que já tem cobrança viva', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000, dueDate: '2026-01-31' });
    const primeira = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    expect(primeira.intent.amount_cents).toBe(30000);

    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: titulo.id,
        method: 'pix',
        installmentCount: 3,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_CHARGE_ALREADY_OPEN' });

    // O título continua INTEIRO: nada foi partido antes da recusa.
    expect(Number(entradaCrua(titulo.id).installment_total)).toBe(1);
    expect(Number(entradaCrua(titulo.id).amount_cents)).toBe(30000);
    expect(listEntries(precoJusto, { direction: 'in' })).toHaveLength(1);
    // E nenhuma cobrança nova nasceu no provedor.
    expect(asaas.pagamentosCriados()).toHaveLength(1);
  });

  it('a recusa vale para o OUTRO meio também — a cobrança viva é do título', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000, dueDate: '2026-01-31' });
    await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    // Chave de idempotência diferente (boleto), mesmo título: a parcela 1
    // nasceria com o PIX de R$ 300 vivo no provedor ao lado do carnê.
    await expect(
      chargeFinanceEntry({
        companyId: precoJusto,
        entryId: titulo.id,
        method: 'boleto',
        installmentCount: 3,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_CHARGE_ALREADY_OPEN' });
    expect(Number(entradaCrua(titulo.id).installment_total)).toBe(1);
  });

  it('a recusa é do SERVIDOR e chega pela porta HTTP com 409', async () => {
    const asaas = asaasDeTeste();
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const app = createApp();
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: 'company-1',
      profileCodes: ['gerente_loja'],
    });
    upsertAsaasApiKey({ companyId: 'company-1', environment: 'sandbox', apiKey: CHAVE_PJ });
    const titulo = tituloAReceber('company-1', { amountCents: 30000, dueDate: '2026-01-31' });
    const token = gerente.body.accessToken as string;

    await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ method: 'pix' })
      .expect(201);

    // Um cliente HTTP que ignora a trava de tela leva a MESMA recusa.
    const parcelar = await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charge`)
      .set('Authorization', `Bearer ${token}`)
      .send({ method: 'pix', installmentCount: 3 });

    expect(parcelar.status).toBe(409);
    expect(parcelar.body?.error?.code).toBe('CORE_FINANCE_CHARGE_ALREADY_OPEN');
    expect(Number(entradaCrua(titulo.id).installment_total)).toBe(1);
  });

  it('cobrança MORTA não tranca o título: cancelada, o carnê pode nascer', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000, dueDate: '2026-01-31' });
    await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    await cancelFinanceEntryCharges({
      companyId: precoJusto,
      entryId: titulo.id,
      fetchImpl: asaas.fetchImpl,
    });

    const carne = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      installmentCount: 3,
      fetchImpl: asaas.fetchImpl,
    });

    // A recusa protege o cliente da cobrança dobrada, não trava o título para
    // sempre: sem cobrança viva, parcelar volta a ser possível.
    expect(carne.installments).toHaveLength(3);
    expect(carne.installments.map((p) => p.amountCents)).toEqual([10000, 10000, 10000]);
    // E a parcela 1 recebeu uma cobrança NOVA, com o valor da parcela — não a
    // intenção antiga de R$ 300.
    expect(carne.intent.amount_cents).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
describe('a cobrança do título se CANCELA no provedor', () => {
  /**
   * O DEFEITO: existia `cancelOrderCharges` para o pedido, com três chamadores,
   * e NADA equivalente para o título — a própria tela declarava a ausência
   * ("não há rota para isso no título"). Um PIX/boleto de título que perdeu a
   * razão de ser continuava vivo no provedor, e o cliente podia pagá-lo. O
   * dinheiro não sumia (vira divergência na conciliação), mas gerava
   * regularização manual evitável — e, no caminho do parcelamento, era a
   * cobrança velha que a parcela 1 herdava.
   */
  it('cancelar apaga a cobrança no provedor e marca a intenção', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    const r = await cancelFinanceEntryCharges({
      companyId: precoJusto,
      entryId: titulo.id,
      fetchImpl: asaas.fetchImpl,
    });

    expect(r).toEqual({ cancelled: 1, failed: 0 });
    expect(
      asaas.chamadas.some(
        (c) => c.method === 'DELETE' && c.url.endsWith(`/payments/${cobranca.intent.provider_ref}`),
      ),
    ).toBe(true);
    expect(
      getIntentsFor({ companyId: precoJusto, originType: 'finance_entry', originId: titulo.id })
        .map((i) => i.status),
    ).toEqual(['cancelled']);
  });

  it('cobrança JÁ PAGA não se cancela — o caminho do dinheiro que entrou é o estorno', async () => {
    const asaas = asaasDeTeste();
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    const cobranca = await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });
    handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PJ,
      companyId: precoJusto,
      payload: evento('evt-pago', 'PAYMENT_RECEIVED', cobranca.intent.provider_ref!, 300),
    });

    const r = await cancelFinanceEntryCharges({
      companyId: precoJusto,
      entryId: titulo.id,
      fetchImpl: asaas.fetchImpl,
    });

    // Nada a cancelar, e NADA foi pedido ao provedor: cancelar cobrança paga
    // apagaria o rastro do dinheiro que já está na conta.
    expect(r).toEqual({ cancelled: 0, failed: 0 });
    expect(asaas.chamadas.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(
      getIntentsFor({ companyId: precoJusto, originType: 'finance_entry', originId: titulo.id })
        .map((i) => i.status),
    ).toEqual(['confirmed']);
  });

  it('falha do provedor NÃO mente: a intenção continua viva com o erro registrado', async () => {
    const asaas = asaasDeTeste({ falharCancelamento: true });
    const titulo = tituloAReceber(precoJusto, { amountCents: 30000 });
    await chargeFinanceEntry({
      companyId: precoJusto,
      entryId: titulo.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    const r = await cancelFinanceEntryCharges({
      companyId: precoJusto,
      entryId: titulo.id,
      fetchImpl: asaas.fetchImpl,
    });

    expect(r).toEqual({ cancelled: 0, failed: 1 });
    const intents = getIntentsFor({
      companyId: precoJusto,
      originType: 'finance_entry',
      originId: titulo.id,
    });
    // Marcar como cancelada aqui seria dizer que o boleto morreu quando ele
    // continua vivo lá fora — a mentira mais cara possível nesta tela.
    expect(intents[0].status).toBe('pending');
    expect(intents[0].last_error).toContain('cancelamento');
  });

  it('título de OUTRA empresa não tem cobrança cancelável por esta', async () => {
    const asaas = asaasDeTeste();
    const daGringa = tituloAReceber(gringa, { amountCents: 30000 });
    await chargeFinanceEntry({
      companyId: gringa,
      entryId: daGringa.id,
      method: 'pix',
      fetchImpl: asaas.fetchImpl,
    });

    await expect(
      cancelFinanceEntryCharges({
        companyId: precoJusto,
        entryId: daGringa.id,
        fetchImpl: asaas.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FINANCE_ENTRY_NOT_FOUND' });
    expect(asaas.chamadas.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('a porta HTTP: estoquista não cancela, gerente cancela e a trilha registra', async () => {
    const asaas = asaasDeTeste();
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const app = createApp();
    const estoquista = await loginForTest(app, {
      userId: 'estoquista',
      companyId: 'company-1',
      profileCodes: ['estoquista'],
    });
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: 'company-1',
      profileCodes: ['gerente_loja'],
    });
    const tokenGerente = gerente.body.accessToken as string;
    upsertAsaasApiKey({ companyId: 'company-1', environment: 'sandbox', apiKey: CHAVE_PJ });
    const titulo = tituloAReceber('company-1', { amountCents: 30000 });

    await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charge`)
      .set('Authorization', `Bearer ${tokenGerente}`)
      .send({ method: 'pix' })
      .expect(201);

    await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charges/cancel`)
      .set('Authorization', `Bearer ${estoquista.body.accessToken as string}`)
      .send({})
      .expect(403);

    const ok = await request(app)
      .post(`/api/v1/core/finance/entries/${titulo.id}/charges/cancel`)
      .set('Authorization', `Bearer ${tokenGerente}`)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ cancelled: 1, failed: 0 });

    const trilha = getConnection()
      .prepare(
        "SELECT * FROM core_audit_log WHERE action = 'finance.charge_cancelled' AND entity_id = ?",
      )
      .all(titulo.id) as Record<string, unknown>[];
    expect(trilha).toHaveLength(1);
  });
});
