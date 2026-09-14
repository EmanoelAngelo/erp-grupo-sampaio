/**
 * ============================================================================
 * PIX NO BALCÃO PELO ASAAS (GAP-PRD-077)
 * ============================================================================
 *
 * O DEFEITO: sem maquininha, PIX no balcão era `addPayment('pix', cents)` —
 * uma linha `settled` sem cobrança nenhuma: o operador conferia o app do banco
 * e lançava como recebido, e a tela prometia um "QR na tela do computador" que
 * não existia. O caminho `pending` (aceito pela API) era um beco:
 * `createPaymentIntent` não tinha chamador com origem `sale`, o webhook só
 * tratava pedido online e título, e o único escritor de `core_sale_payments`
 * era o INSERT da venda — a linha pendente ficava pendente para sempre, com o
 * título em aberto e o caixa fechando sem ela.
 *
 * AGORA: o balcão gera o QR na conta da operação; a venda fecha com a linha
 * liquidada (se o PIX já caiu) ou pendente (se o cliente precisou ir); o
 * webhook — ou a consulta ao provedor — liquida a linha e baixa o título; a
 * gerência tem a fila do que ficou pendente; e a conciliação compara o PIX com
 * a LINHA do PIX, sem acusar a parte em dinheiro da mesma venda.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { loginForTest } from './helpers/auth.js';
import { asaasComEstado } from './helpers/asaasComEstado.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { cancelSale, createSale } from '../src/services/core/SalesService.js';
import { handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { reconcileAsaas } from '../src/services/core/AsaasReconciliation.js';
import { sincronizarCobrancasComProvedor } from '../src/services/core/AsaasSincronizacao.js';
import {
  cancelarPixDoBalcao,
  confirmarPixPendente,
  consultarPixDoBalcao,
  criarPixDoBalcao,
  listarPixPendentesDoBalcao,
  statusDoPixDoBalcao,
} from '../src/services/core/PdvPixService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const LOJA = 'loja-balcao';
const VIZINHA = 'loja-vizinha-balcao';
const SEM_CHAVE = 'loja-sem-chave-balcao';
const TOKEN = 'token-webhook-loja-balcao';
const CPF = '52998224725';
let seq = 0;
let produto: string;
let caixaUserId: string;
let asaas: ReturnType<typeof asaasComEstado>;

async function entrar(companyId: string, perfil: string): Promise<{ Authorization: string }> {
  seq += 1;
  const login = await loginForTest(app, { userId: `u-${perfil}-${seq}`, companyId, profileCodes: [perfil] });
  expect(login.status).toBe(200);
  return { Authorization: `Bearer ${login.body.accessToken}` };
}

function referencia(): string {
  seq += 1;
  return `ref-balcao-${seq}-abcdef`;
}

async function qr(amountCents = 5000, companyId = LOJA) {
  return criarPixDoBalcao({
    companyId,
    amountCents,
    referencia: referencia(),
    pagadorDocumento: CPF,
    pagadorNome: 'Dona Marlene',
    fetchImpl: asaas.fetchImpl,
  });
}

function vender(payments: Record<string, unknown>[], chave = `venda-${++seq}`) {
  return createSale({
    companyId: LOJA,
    userId: caixaUserId,
    items: [{ productId: produto, quantity: 1 }],
    payments: payments as never,
    idempotencyKey: chave,
  });
}

function receber(ref: string, valor = 50, id = `evt-${ref}`) {
  return handlePaymentWebhook({
    provider: 'asaas',
    companyId: LOJA,
    token: TOKEN,
    payload: { id, event: 'PAYMENT_RECEIVED', payment: { id: ref, value: valor, billingType: 'PIX' } },
  });
}

function linhaPix(saleId: string): Record<string, unknown> {
  return getConnection()
    .prepare("SELECT * FROM core_sale_payments WHERE sale_id = ? AND method = 'pix'")
    .get(saleId) as Record<string, unknown>;
}

function titulosDaVenda(saleId: string): { status: string; settled_cents: number; amount_cents: number }[] {
  return getConnection()
    .prepare("SELECT status, settled_cents, amount_cents FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ? AND direction = 'in'")
    .all(saleId) as never;
}

function intencao(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_payment_intents WHERE id = ?').get(id) as Record<string, unknown>;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  await entrar(LOJA, 'gerente_loja');
  await entrar(VIZINHA, 'gerente_loja');
  await entrar(SEM_CHAVE, 'gerente_loja');
  caixaUserId = String(
    (getConnection().prepare("SELECT user_id FROM core_user_companies WHERE company_id = ? LIMIT 1").get(LOJA) as {
      user_id: string;
    }).user_id,
  );
  upsertAsaasApiKey({ companyId: LOJA, environment: 'sandbox', apiKey: '$aact_sandbox_loja_balcao_000000000' });
  upsertAsaasApiKey({ companyId: VIZINHA, environment: 'sandbox', apiKey: '$aact_sandbox_vizinha_balcao_11111' });
  upsertAsaasWebhookToken({ companyId: LOJA, webhookToken: TOKEN });
  produto = createProduct(LOJA, { name: 'Camiseta Polo', priceCents: 10000 }).id;
  applyMovement({ companyId: LOJA, productId: produto, movementType: 'in', quantity: 20, referenceType: 'ajuste', referenceId: 'e1' });
  asaas = asaasComEstado();
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-077 — o QR nasce no ERP', () => {
  it('sem credencial o balcão sabe que é manual, e diz onde configurar', () => {
    const s = statusDoPixDoBalcao(SEM_CHAVE);
    expect(s.disponivel).toBe(false);
    expect(s.motivo).toMatch(/Integrações › Asaas/);
    expect(statusDoPixDoBalcao(LOJA)).toMatchObject({ disponivel: true, ambiente: 'sandbox' });
  });

  it('gera a cobrança PIX na conta da operação, vencendo hoje, e devolve o copia-e-cola', async () => {
    const pix = await qr(5000);

    const corpo = asaas.criacoes()[0].body!;
    expect(corpo).toMatchObject({ billingType: 'PIX', value: 50 });
    expect(String(corpo.externalReference)).toMatch(/^pdv-pix:/);
    expect(pix.status).toBe('pending');
    expect(pix.pixPayload).toContain('00020126');
    expect(pix.saleId).toBeNull();
    const intent = intencao(pix.intentId);
    expect(intent).toMatchObject({ origin_type: 'sale', method: 'pix', amount_cents: 5000 });
  });

  it('dois cliques no mesmo QR não viram duas cobranças', async () => {
    const ref = referencia();
    const a = await criarPixDoBalcao({ companyId: LOJA, amountCents: 5000, referencia: ref, pagadorDocumento: CPF, fetchImpl: asaas.fetchImpl });
    const b = await criarPixDoBalcao({ companyId: LOJA, amountCents: 5000, referencia: ref, pagadorDocumento: CPF, fetchImpl: asaas.fetchImpl });
    expect(b.intentId).toBe(a.intentId);
    expect(asaas.criacoes()).toHaveLength(1);
  });

  /*
    A MESMA REFERÊNCIA COM OUTRO VALOR NÃO É O MESMO QR (RES-IDEM-VIZ).

    `createPaymentIntent` devolvia a cobrança da chave sem olhar o valor: a
    referência de um QR de R$ 50 reenviada com R$ 80 mostrava o QR de R$ 50
    como se fosse o novo, e o cliente pagava o valor errado.
  */
  it('a mesma referência com OUTRO valor ou outro pagador é recusada (422), sem nova cobrança', async () => {
    const ref = referencia();
    const a = await criarPixDoBalcao({ companyId: LOJA, amountCents: 5000, referencia: ref, pagadorDocumento: CPF, fetchImpl: asaas.fetchImpl });
    const clientesAntes = (getConnection().prepare('SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ?').get(LOJA) as { n: number }).n;

    await expect(
      criarPixDoBalcao({ companyId: LOJA, amountCents: 8000, referencia: ref, pagadorDocumento: CPF, fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'CORE_IDEMPOTENCY_KEY_REUSED', status: 422 });
    await expect(
      criarPixDoBalcao({ companyId: LOJA, amountCents: 5000, referencia: ref, pagadorDocumento: '11144477735', fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'CORE_IDEMPOTENCY_KEY_REUSED', status: 422 });

    expect(asaas.criacoes()).toHaveLength(1);
    expect(intencao(a.intentId)).toMatchObject({ amount_cents: 5000 });
    expect((getConnection().prepare('SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ?').get(LOJA) as { n: number }).n).toBe(clientesAntes);
  });

  it('cobrança anterior à impressão digital: a mesma referência devolve o QR de antes, como sempre', async () => {
    const ref = referencia();
    const a = await criarPixDoBalcao({ companyId: LOJA, amountCents: 5000, referencia: ref, pagadorDocumento: CPF, fetchImpl: asaas.fetchImpl });
    getConnection().prepare('UPDATE core_payment_intents SET idempotency_fingerprint = NULL WHERE id = ?').run(a.intentId);
    const b = await criarPixDoBalcao({ companyId: LOJA, amountCents: 8000, referencia: ref, pagadorDocumento: CPF, fetchImpl: asaas.fetchImpl });
    expect(b.intentId).toBe(a.intentId);
    expect(asaas.criacoes()).toHaveLength(1);
  });

  it('sem pagador com CPF, recusa dizendo o que falta — não inventa pagador', async () => {
    await expect(
      criarPixDoBalcao({ companyId: LOJA, amountCents: 5000, referencia: referencia(), fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'CORE_PIX_BALCAO_SEM_PAGADOR' });
    expect(asaas.criacoes()).toHaveLength(0);
  });
});

// ============================================================================
describe('GAP-PRD-077 — a venda fecha com o PIX, e o PIX liquida a venda', () => {
  it('PIX pago ANTES de fechar: a linha entra liquidada — mesmo que a tela diga "pendente"', async () => {
    const pix = await qr(10000);
    const aviso = receber(String(pix.providerRef), 100);
    expect(aviso.detail).toMatch(/venda ainda não foi fechada/);

    const { sale } = vender([{ method: 'pix', amountCents: 10000, status: 'pending', paymentIntentId: pix.intentId }]);

    const linha = linhaPix(sale.id);
    expect(linha).toMatchObject({ status: 'settled', provider: 'asaas', provider_ref: pix.providerRef, payment_intent_id: pix.intentId });
    expect(titulosDaVenda(sale.id).every((t) => t.status === 'settled')).toBe(true);
    expect(intencao(pix.intentId).origin_id).toBe(sale.id);
    expect(reconcileAsaas({ companyId: LOJA })).toMatchObject({ matched: 1, rows: [] });
  });

  it('PIX ainda em aberto: a venda fecha PENDENTE, e o webhook liquida a linha e baixa o título', async () => {
    const pix = await qr(10000);
    const { sale } = vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }]);
    expect(linhaPix(sale.id).status).toBe('pending');
    expect(titulosDaVenda(sale.id)[0].status).toBe('open');

    // Antes: o webhook não tratava origem `sale` — nada liquidava a linha.
    const r = receber(String(pix.providerRef), 100);

    expect(r.detail).toMatch(/venda #\d+ foi liquidada/);
    const linha = linhaPix(sale.id);
    expect(linha.status).toBe('settled');
    expect(linha.settled_at).toBeTruthy();
    expect(titulosDaVenda(sale.id)[0]).toMatchObject({ status: 'settled', settled_cents: 10000 });
    const baixa = getConnection()
      .prepare('SELECT note, method FROM core_finance_settlements WHERE note = ?')
      .get(`Asaas ${pix.providerRef}`) as { note: string; method: string };
    expect(baixa.method).toBe('pix');
    expect(reconcileAsaas({ companyId: LOJA })).toMatchObject({ matched: 1, rows: [] });

    // O reenvio do provedor não baixa de novo.
    receber(String(pix.providerRef), 100, `evt-reenvio-${pix.providerRef}`);
    expect(titulosDaVenda(sale.id)[0].settled_cents).toBe(10000);
  });

  it('venda meio dinheiro, meio PIX: a conciliação compara o PIX com a linha do PIX — sem acusar o dinheiro', async () => {
    const pix = await qr(5000);
    const { sale } = vender([
      { method: 'dinheiro', amountCents: 5000 },
      { method: 'pix', amountCents: 5000, paymentIntentId: pix.intentId },
    ]);
    receber(String(pix.providerRef), 50);

    const relatorio = reconcileAsaas({ companyId: LOJA });
    expect(relatorio.rows).toEqual([]);
    expect(relatorio).toMatchObject({ providerCents: 5000, financeCents: 5000, matched: 1 });
    expect(titulosDaVenda(sale.id).reduce((a, t) => a + t.settled_cents, 0)).toBe(10000);
  });

  it('webhook perdido: a consulta ao provedor (botão do caixa ou passada automática) liquida a linha', async () => {
    const pix = await qr(10000);
    const { sale } = vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }]);
    asaas.pagar(String(pix.providerRef), 'RECEIVED', 100);

    await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'automatico', fetchImpl: asaas.fetchImpl });

    expect(linhaPix(sale.id).status).toBe('settled');
    expect(titulosDaVenda(sale.id)[0].status).toBe('settled');
  });

  it('a tela consulta o provedor e vê o PIX pago antes de fechar a venda', async () => {
    const pix = await qr(10000);
    asaas.pagar(String(pix.providerRef), 'RECEIVED', 100);

    const lido = await consultarPixDoBalcao({ companyId: LOJA, intentId: pix.intentId, fetchImpl: asaas.fetchImpl });
    expect(lido.status).toBe('pending');
    const consultado = await consultarPixDoBalcao({ companyId: LOJA, intentId: pix.intentId, consultar: true, fetchImpl: asaas.fetchImpl });
    expect(consultado.status).toBe('confirmed');
  });
});

// ============================================================================
describe('GAP-PRD-077 — as travas', () => {
  it('o mesmo PIX não fecha duas vendas; o reenvio da MESMA venda passa', async () => {
    const pix = await qr(10000);
    const chave = 'venda-unica';
    const primeira = vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }], chave);
    const reenvio = vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }], chave);
    expect(reenvio.duplicated).toBe(true);
    expect(reenvio.sale.id).toBe(primeira.sale.id);

    expect(() => vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }])).toThrow(/já fechou outra venda/);
  });

  it('valor da linha diferente do PIX gerado: recusa', async () => {
    const pix = await qr(5000);
    expect(() =>
      vender([
        { method: 'dinheiro', amountCents: 5000 },
        { method: 'pix', amountCents: 5000, paymentIntentId: pix.intentId },
        { method: 'pix', amountCents: 100, paymentIntentId: pix.intentId },
      ]),
    ).toThrow(/duas linhas/);
    expect(() => vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }])).toThrow(/R\$ 50,00/);
  });

  it('PIX de outra operação é inexistente aqui', async () => {
    const daVizinha = await qr(10000, VIZINHA);
    expect(() => vender([{ method: 'pix', amountCents: 10000, paymentIntentId: daVizinha.intentId }])).toThrow(/não encontrado/);
  });

  it('desistir cancela a cobrança no provedor — e o QR cancelado não fecha venda', async () => {
    const pix = await qr(10000);

    const cancelado = await cancelarPixDoBalcao({ companyId: LOJA, intentId: pix.intentId, fetchImpl: asaas.fetchImpl });

    expect(cancelado.status).toBe('cancelled');
    expect(asaas.cobrancas.find((c) => c.id === pix.providerRef)?.deleted).toBe(true);
    expect(() => vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }])).toThrow(/não fecha venda/);
  });

  it('PIX pago numa venda cancelada vira dinheiro a regularizar — e aparece na conciliação', async () => {
    const pix = await qr(10000);
    const { sale } = vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }]);
    cancelSale({ companyId: LOJA, saleId: sale.id, userId: caixaUserId, reason: 'cliente desistiu' } as never);

    const r = receber(String(pix.providerRef), 100);

    expect(r.detail).toMatch(/venda cancelada/);
    expect(intencao(pix.intentId).status).toBe('paid_after_cancel');
    expect(reconcileAsaas({ companyId: LOJA }).rows.map((l) => l.kind)).toEqual(['cobrado_nao_lancado']);
  });
});

// ============================================================================
describe('GAP-PRD-077 — a fila dos pendentes', () => {
  it('lista o PIX pendente (do provedor e o declarado à mão), mais antigo primeiro', async () => {
    const pix = await qr(10000);
    vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }]);
    vender([{ method: 'pix', amountCents: 10000, status: 'pending' }]);

    const fila = listarPixPendentesDoBalcao(LOJA);

    expect(fila).toHaveLength(2);
    expect(fila.map((f) => f.viaProvedor)).toEqual([true, false]);
    expect(fila[0]).toMatchObject({ intentStatus: 'pending', providerRef: pix.providerRef, amountCents: 10000 });
  });

  it('PIX do provedor: "confirmar" pergunta ao provedor — não pago, recusa; pago, liquida', async () => {
    const pix = await qr(10000);
    const { sale } = vender([{ method: 'pix', amountCents: 10000, paymentIntentId: pix.intentId }]);
    const linha = String(linhaPix(sale.id).id);

    await expect(
      confirmarPixPendente({ companyId: LOJA, saleId: sale.id, paymentId: linha, fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'CORE_PIX_BALCAO_NAO_PAGO' });

    asaas.pagar(String(pix.providerRef), 'RECEIVED', 100);
    const r = await confirmarPixPendente({ companyId: LOJA, saleId: sale.id, paymentId: linha, fetchImpl: asaas.fetchImpl });
    expect(r.liquidada).toBe(true);
    expect(linhaPix(sale.id).status).toBe('settled');
  });

  it('PIX declarado pendente sem provedor: a gerência confirma COM a nota de como conferiu', async () => {
    const { sale } = vender([{ method: 'pix', amountCents: 10000, status: 'pending' }]);
    const linha = String(linhaPix(sale.id).id);

    await expect(
      confirmarPixPendente({ companyId: LOJA, saleId: sale.id, paymentId: linha }),
    ).rejects.toMatchObject({ code: 'CORE_PIX_CONFIRMACAO_SEM_NOTA' });

    const r = await confirmarPixPendente({ companyId: LOJA, saleId: sale.id, paymentId: linha, note: 'extrato do banco, 11/09 14h32' });
    expect(r.liquidada).toBe(true);
    expect(linhaPix(sale.id).status).toBe('settled');
    expect(titulosDaVenda(sale.id)[0].status).toBe('settled');
    expect(listarPixPendentesDoBalcao(LOJA)).toHaveLength(0);
  });
});

// ============================================================================
describe('GAP-PRD-077 — as rotas', () => {
  it('o caixa gera o QR e consulta; a fila e a confirmação são da gerência', async () => {
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const caixa = await entrar(LOJA, 'operador_caixa_loja');
    const gerente = await entrar(LOJA, 'gerente_loja');

    const status = await request(app).get('/api/v1/core/pdv/pix-asaas/status').set(caixa);
    expect(status.body.disponivel).toBe(true);

    const criado = await request(app)
      .post('/api/v1/core/pdv/pix-asaas')
      .set(caixa)
      .send({ amountCents: 10000, referencia: 'ref-rota-0001', pagadorDocumento: CPF });
    expect(criado.status).toBe(201);
    expect(criado.body.pixPayload).toBeTruthy();

    const lido = await request(app).get(`/api/v1/core/pdv/pix-asaas/${criado.body.intentId}?consultar=1`).set(caixa);
    expect(lido.status).toBe(200);
    expect(lido.body.status).toBe('pending');

    expect((await request(app).get('/api/v1/core/pdv/pix-pendentes').set(caixa)).status).toBe(403);
    expect((await request(app).get('/api/v1/core/pdv/pix-pendentes').set(gerente)).status).toBe(200);

    const auditoria = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'sale.pix_balcao_gerado'")
      .get() as { n: number };
    expect(auditoria.n).toBe(1);
  });
});
