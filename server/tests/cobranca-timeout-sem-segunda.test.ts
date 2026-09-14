/**
 * ============================================================================
 * TIMEOUT NA CRIAÇÃO NÃO VIRA SEGUNDA COBRANÇA (GAP-PRD-049)
 * ============================================================================
 *
 * O DEFEITO: o `POST /payments` sai, o Asaas CRIA a cobrança, e a resposta não
 * volta a tempo (`ASAAS_TIMEOUT_MS`). O catch marcava a intenção `failed` sem
 * `provider_ref` — exatamente o estado que o "tentar de novo" (GAP-V76) aceita
 * re-cobrar. A retentativa chamava o provedor outra vez e criava a SEGUNDA
 * cobrança: o cliente com dois PIX/boletos, e o pagamento da primeira chegava
 * pelo webhook como "Cobrança não encontrada no ERP" — dinheiro na conta sem
 * título nem pedido vinculado, visível só na conciliação do mês.
 *
 * No pedido online era pior: `createOrderCharge` nem registrava a falha — a
 * intenção ficava `pending` sem referência, e o segundo clique cobrava de novo.
 *
 * O `externalReference` (id da origem) sempre foi enviado. Faltava perguntar
 * por ele:
 *
 *   1. antes de recriar, a retentativa consulta `GET /payments?externalReference=`
 *      e ADOTA a cobrança que já existe lá (se ela já foi paga, baixa);
 *   2. se a consulta falhar, NADA é recriado — não dá para provar a ausência;
 *   3. o webhook da cobrança órfã casa pela referência externa, dentro da
 *      mesma operação, em vez de cair em "não encontrada";
 *   4. cancelar o título/pedido cancela também a órfã no provedor.
 *
 * O Asaas aqui é um dublê COM ESTADO: guarda o que criou, e pode "perder a
 * resposta" depois de criar — o cenário exato do timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { createEntry } from '../src/services/core/FinanceService.js';
import {
  cancelFinanceEntryCharges,
  chargeFinanceEntry,
} from '../src/services/core/FinanceChargeService.js';
import { handlePaymentWebhook, retryPaymentIntent } from '../src/services/core/PaymentService.js';
import { cancelOrderCharges, createOrderCharge } from '../src/services/core/OrderChargeService.js';
import { checkout } from '../src/services/core/StorefrontService.js';

const TOKEN_PJ = 'token-webhook-preco-justo';
const TOKEN_GRINGA = 'token-webhook-gringa';

let precoJusto: string;
let gringa: string;
let seq = 0;

interface CobrancaRemota {
  id: string;
  customer: string;
  value: number;
  billingType: string;
  status: string;
  externalReference: string;
  invoiceUrl: string;
  deleted: boolean;
  dateCreated: string;
}

/**
 * Asaas com memória. `perderRespostas` = quantas criações acontecem LÁ e têm a
 * resposta perdida no caminho; `consultaFora` derruba a listagem.
 */
function asaasComMemoria(opcoes: { perderRespostas?: number; consultaFora?: boolean; recusarAntes?: number } = {}) {
  const cobrancas: CobrancaRemota[] = [];
  const chamadas: { method: string; url: string }[] = [];
  let perder = opcoes.perderRespostas ?? 0;
  let recusar = opcoes.recusarAntes ?? 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    chamadas.push({ method: metodo, url: endereco });
    const responder = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    if (endereco.endsWith('/customers') && metodo === 'POST') {
      seq += 1;
      return responder({ id: `cus_TEST_${seq}` });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      if (recusar > 0) {
        // Recusa ANTES de criar: aqui a cobrança de fato não existe lá.
        recusar -= 1;
        return responder({ errors: [{ description: 'instabilidade' }] }, 503);
      }
      seq += 1;
      const nova: CobrancaRemota = {
        id: `pay_TEST_${seq}`,
        customer: String(corpo.customer ?? ''),
        value: Number(corpo.value),
        billingType: String(corpo.billingType),
        status: 'PENDING',
        externalReference: String(corpo.externalReference ?? ''),
        invoiceUrl: `https://sandbox.asaas.com/i/TEST_${seq}`,
        deleted: false,
        dateCreated: '2026-09-11',
      };
      cobrancas.push(nova);
      if (perder > 0) {
        perder -= 1;
        // Criou do lado de lá; a resposta morre no caminho (o AbortController).
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return responder(nova);
    }
    if (metodo === 'GET' && /\/payments\?/.test(endereco)) {
      if (opcoes.consultaFora) throw new DOMException('timeout', 'TimeoutError');
      const ref = new URL(endereco).searchParams.get('externalReference');
      const data = cobrancas.filter((c) => c.externalReference === ref);
      return responder({ object: 'list', hasMore: false, totalCount: data.length, data });
    }
    // Remover a cobrança é DELETE /payments/:id no Asaas (GAP-PRD-169).
    if (metodo === 'DELETE' && /[/]payments[/][^/?]+$/.test(endereco)) {
      const id = endereco.split('/payments/')[1].split('/')[0];
      const alvo = cobrancas.find((c) => c.id === id);
      if (alvo) alvo.deleted = true;
      return responder({ id, deleted: true });
    }
    if (endereco.includes('/pixQrCode')) return responder({ payload: '000201-TESTE' });
    return responder({});
  }) as unknown as typeof fetch;

  const criacoes = () => chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/payments'));
  const consultas = () => chamadas.filter((c) => c.method === 'GET' && /\/payments\?/.test(c.url));
  return { fetchImpl, cobrancas, chamadas, criacoes, consultas };
}

function titulo(companyId: string, amountCents = 30000): string {
  seq += 1;
  const cliente = `cli-${companyId.slice(0, 4)}-${seq}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Dona Marlene', ?, 'marlene@exemplo.com.br', 1, ?, ?)`,
    )
    .run(cliente, companyId, String(52998224725 + seq), agora, agora);
  return createEntry({
    companyId,
    direction: 'in',
    description: 'Aluguel da sala 2',
    amountCents,
    dueDate: '2026-09-10',
    customerId: cliente,
  }).id;
}

function intentDe(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_payment_intents WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

function saldoBaixado(entryId: string): number {
  return Number(
    (getConnection().prepare('SELECT settled_cents FROM core_finance_entries WHERE id = ?').get(entryId) as {
      settled_cents: number;
    }).settled_cents,
  );
}

function pedidoComCliente(companyId: string, sufixo: string): string {
  const agora = new Date().toISOString();
  const produto = `prod-${sufixo}`;
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, 'Produto online', 'UN', 5000, 10000, 1, 1, ?, ?)`,
    )
    .run(produto, companyId, `ON-${sufixo}`, agora, agora);
  getConnection()
    .prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)')
    .run(companyId, produto, agora);
  seq += 1;
  const cliente = `cli-ped-${seq}`;
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Comprador', ?, 'comprador@exemplo.com.br', 1, ?, ?)`,
    )
    .run(cliente, companyId, String(11144477735 + seq), agora, agora);
  const [pedido] = checkout({
    idempotencyKey: `ck-${sufixo}`,
    customerName: 'Comprador',
    paymentMethod: 'pix',
    items: [{ productId: produto, quantity: 1 }],
  });
  getConnection()
    .prepare('UPDATE core_orders SET customer_id = ?, customer_document = ? WHERE id = ?')
    .run(cliente, String(11144477735 + seq), pedido.id);
  return pedido.id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  precoJusto = await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Ltda' });
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'sandbox', apiKey: '$aact_sandbox_pj_000000000000' });
  upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: '$aact_sandbox_gr_111111111111' });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_PJ });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_GRINGA });
  // Nenhuma chamada sai deste processo: o que não passar pelo dublê explícito
  // cai aqui e falha como rede ausente, em vez de alcançar o sandbox real.
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

afterEach(() => {
  seq = 0;
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-049 — título: timeout e a retentativa', () => {
  it('timeout na criação deixa a intenção failed dizendo que o resultado é INCERTO', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);

    const r = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });

    expect(r.status).toBe('failed');
    expect(r.intent.provider_ref).toBeFalsy();
    // Quem lê precisa saber que a cobrança PODE existir lá — não é "não existe".
    expect(String(r.intent.last_error)).toMatch(/pode ter sido criada/i);
    expect(asaas.cobrancas).toHaveLength(1);
  });

  it('a retentativa ADOTA a cobrança que o provedor criou — não cria outra', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });

    const retentativa = await retryPaymentIntent({
      companyId: precoJusto,
      intentId: falha.intent.id,
      fetchImpl: asaas.fetchImpl,
    });

    // Antes: segundo POST /payments — duas cobranças para o mesmo título.
    expect(asaas.criacoes()).toHaveLength(1);
    expect(asaas.cobrancas).toHaveLength(1);
    expect(asaas.consultas()[0].url).toContain(`externalReference=${entryId}`);
    expect(retentativa.intent.id).toBe(falha.intent.id);
    expect(retentativa.intent.provider_ref).toBe(asaas.cobrancas[0].id);
    expect(retentativa.status).toBe('pending');
    expect(retentativa.intent.invoice_url).toBe(asaas.cobrancas[0].invoiceUrl);
    expect(retentativa.intent.last_error).toBeNull();
  });

  it('sem cobrança lá, a retentativa cria — a primeira de fato não existia', async () => {
    const asaas = asaasComMemoria({ recusarAntes: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });
    expect(falha.status).toBe('failed');

    const retentativa = await retryPaymentIntent({ companyId: precoJusto, intentId: falha.intent.id, fetchImpl: asaas.fetchImpl });

    expect(retentativa.status).toBe('pending');
    expect(asaas.cobrancas).toHaveLength(1);
    expect(retentativa.intent.provider_ref).toBe(asaas.cobrancas[0].id);
  });

  it('provedor mudo na consulta: NADA é recriado, e a intenção diz por quê', async () => {
    const perde = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: perde.fetchImpl });

    const mudo = asaasComMemoria({ consultaFora: true });
    const retentativa = await retryPaymentIntent({ companyId: precoJusto, intentId: falha.intent.id, fetchImpl: mudo.fetchImpl });

    expect(mudo.criacoes()).toHaveLength(0);
    expect(retentativa.status).toBe('failed');
    expect(retentativa.intent.provider_ref).toBeFalsy();
    expect(String(retentativa.intent.last_error)).toMatch(/conferir/i);
  });

  it('a órfã JÁ PAGA quando a retentativa pergunta: adota e BAIXA o título', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });
    asaas.cobrancas[0].status = 'RECEIVED';

    const retentativa = await retryPaymentIntent({ companyId: precoJusto, intentId: falha.intent.id, fetchImpl: asaas.fetchImpl });

    expect(asaas.criacoes()).toHaveLength(1);
    expect(retentativa.intent.status).toBe('confirmed');
    expect(saldoBaixado(entryId)).toBe(30000);
  });
});

// ============================================================================
describe('GAP-PRD-049 — o webhook da cobrança órfã', () => {
  it('pago antes de qualquer retentativa: casa pela referência externa e baixa o título', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });
    const orfa = asaas.cobrancas[0];

    const r = handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: {
        id: 'evt_orfa_1',
        event: 'PAYMENT_RECEIVED',
        payment: { id: orfa.id, value: 300, billingType: 'PIX', externalReference: entryId },
      },
    });

    // Antes: "Cobrança não encontrada no ERP." e o título em aberto.
    expect(r.detail).not.toMatch(/não encontrada/i);
    expect(saldoBaixado(entryId)).toBe(30000);
    expect(intentDe(falha.intent.id)).toMatchObject({ provider_ref: orfa.id, status: 'confirmed' });
  });

  it('a referência externa não atravessa empresas', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });

    const r = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: {
        id: 'evt_orfa_2',
        event: 'PAYMENT_RECEIVED',
        payment: { id: 'pay_da_gringa', value: 300, billingType: 'PIX', externalReference: entryId },
      },
    });

    expect(r.detail).toMatch(/não encontrada/i);
    expect(saldoBaixado(entryId)).toBe(0);
  });

  it('meio diferente do da intenção não é adotado — outra cobrança, outro caminho', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: {
        id: 'evt_orfa_3',
        event: 'PAYMENT_RECEIVED',
        payment: { id: 'pay_boleto_avulso', value: 300, billingType: 'BOLETO', externalReference: entryId },
      },
    });

    expect(intentDe(falha.intent.id).provider_ref).toBeNull();
    expect(saldoBaixado(entryId)).toBe(0);
  });
});

// ============================================================================
describe('GAP-PRD-049 — pedido online', () => {
  it('timeout não deixa a intenção pendente sem referência, e o segundo clique não cobra duas vezes', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const orderId = pedidoComCliente(precoJusto, 'timeout');

    await expect(
      createOrderCharge({ companyId: precoJusto, orderId, method: 'pix', fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'ASAAS_CONNECTION_FAILED' });

    const registrada = getConnection()
      .prepare(`SELECT * FROM core_payment_intents WHERE origin_id = ?`)
      .get(orderId) as Record<string, unknown>;
    expect(registrada.status).toBe('failed');
    expect(String(registrada.last_error)).toMatch(/pode ter sido criada/i);

    const segunda = await createOrderCharge({ companyId: precoJusto, orderId, method: 'pix', fetchImpl: asaas.fetchImpl });

    expect(asaas.criacoes()).toHaveLength(1);
    expect(asaas.cobrancas).toHaveLength(1);
    expect(segunda.intent.provider_ref).toBe(asaas.cobrancas[0].id);
    expect(segunda.status).toBe('pending');
  });
});

// ============================================================================
describe('GAP-PRD-049 — cancelar não deixa a órfã viva no provedor', () => {
  it('título: a cobrança de resultado incerto é procurada e cancelada lá', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });

    const r = await cancelFinanceEntryCharges({ companyId: precoJusto, entryId, fetchImpl: asaas.fetchImpl });

    expect(r.cancelled).toBe(1);
    expect(asaas.cobrancas[0].deleted).toBe(true);
    expect(intentDe(falha.intent.id)).toMatchObject({ status: 'cancelled', provider_ref: asaas.cobrancas[0].id });
  });

  it('título: provedor mudo na consulta — a intenção NÃO é dada como cancelada', async () => {
    const perde = asaasComMemoria({ perderRespostas: 1 });
    const entryId = titulo(precoJusto);
    const falha = await chargeFinanceEntry({ companyId: precoJusto, entryId, method: 'pix', fetchImpl: perde.fetchImpl });

    const mudo = asaasComMemoria({ consultaFora: true });
    const r = await cancelFinanceEntryCharges({ companyId: precoJusto, entryId, fetchImpl: mudo.fetchImpl });

    expect(r.failed).toBe(1);
    expect(intentDe(falha.intent.id).status).toBe('failed');
  });

  it('pedido: a órfã é cancelada no provedor junto com o pedido', async () => {
    const asaas = asaasComMemoria({ perderRespostas: 1 });
    const orderId = pedidoComCliente(precoJusto, 'cancela');
    await createOrderCharge({ companyId: precoJusto, orderId, method: 'pix', fetchImpl: asaas.fetchImpl }).catch(() => null);

    const r = await cancelOrderCharges({ companyId: precoJusto, orderId, fetchImpl: asaas.fetchImpl });

    expect(r.cancelled).toBe(1);
    expect(asaas.cobrancas[0].deleted).toBe(true);
  });
});
