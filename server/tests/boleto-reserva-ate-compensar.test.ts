/**
 * O BOLETO VIVE ATÉ O BANCO PODER CONFIRMAR (GAP-PRD-029).
 *
 * O DEFEITO: a cobrança do pedido online vence em D+1 para PIX, boleto e
 * cartão, e a reserva de estoque morria 25 horas depois do pedido — um relógio
 * calibrado para o PIX aplicado a todo mundo. Para o boleto isso quer dizer:
 * o cliente lê "válido até amanhã", paga no vencimento, o banco compensa em
 * D+1 útil, e antes disso a rotina já cancelou o pedido, soltou o estoque e
 * pediu o cancelamento ao provedor. O dinheiro chega depois, vira
 * `paid_after_cancel` e alguém regulariza à mão.
 *
 * A REGRA: a reserva de um pedido com boleto vivo no provedor vai até o fim do
 * SEGUNDO dia útil depois do último dia em que o boleto pode ser pago (o
 * vencimento, ou o próximo dia útil quando ele cai em fim de semana ou
 * feriado). PIX e cartão continuam com as 25 horas — a cobrança deles morre
 * junto no provedor, e segurar estoque mais tempo seria vitrine esgotada por
 * pedido que ninguém vai pagar.
 *
 * O provedor é um DUBLÊ explícito deste arquivo: nenhuma rede.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { upsertAsaasApiKey } from '../src/services/integrations/AsaasCredentialService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { createOrderCharge } from '../src/services/core/OrderChargeService.js';
import {
  PRAZO_DA_RESERVA_MS,
  expirarPedidosNaoPagos,
} from '../src/services/core/OrderReservationExpiry.js';
import { getAvailable } from '../src/services/core/InventoryService.js';

const CHAVE = '$aact_sandbox_preco_justo_00000000000000';

let loja: string;
let n = 0;
let cancelamentos: string[];

/** Dublê do Asaas: devolve o vencimento que recebeu, como a API faz. */
function asaasDeTeste(): typeof fetch {
  let sequencia = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    const responder = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (endereco.endsWith('/customers') && metodo === 'POST') {
      sequencia += 1;
      return responder({ id: `cus_TEST_${sequencia}` });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      sequencia += 1;
      return responder({
        id: `pay_TEST_${sequencia}`,
        invoiceUrl: `https://sandbox.asaas.com/i/TEST_${sequencia}`,
        bankSlipUrl: `https://sandbox.asaas.com/b/TEST_${sequencia}`,
        dueDate: corpo?.dueDate,
      });
    }
    if (endereco.includes('/pixQrCode')) {
      return responder({ payload: '00020126TESTE', encodedImage: 'iVBOR', expirationDate: null });
    }
    if (endereco.includes('/identificationField')) {
      return responder({ identificationField: '34191.79001 01043.510047 91020.150008 1 96610000010000' });
    }
    // Cancelar no provedor é `DELETE /payments/:id` (e o plano de parcelas,
    // `DELETE /installments/:id`) — a rota que o Asaas tem de verdade; o
    // `/cancel` antigo fica aceito, para o dublê não esconder um retorno a ele.
    if (
      endereco.includes('/cancel')
      || (metodo === 'DELETE' && /\/(payments|installments)\/[^/]+$/.test(endereco))
    ) {
      cancelamentos.push(endereco);
      return responder({ status: 'CANCELLED', deleted: true });
    }
    return responder({});
  }) as unknown as typeof fetch;
}

function produtoPublicado(companyId: string): string {
  n += 1;
  const id = `prod-bol-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Produto online', 'UN', 5000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `BOL-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

async function pedidoCom(method: 'boleto' | 'pix', companyId = loja) {
  const produto = produtoPublicado(companyId);
  const [ordem] = checkout({
    idempotencyKey: `ck-bol-${n}`,
    customerName: 'Cliente Boleto',
    customerDocument: '111.444.777-35',
    paymentMethod: method,
    items: [{ productId: produto, quantity: 1 }],
  });
  const cobranca = await createOrderCharge({
    companyId,
    orderId: ordem.id,
    method,
    fetchImpl: asaasDeTeste(),
  });
  return { ordem, produto, cobranca };
}

function status(orderId: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as {
      status: string;
    }
  ).status;
}

function criadoEm(orderId: string): Date {
  const linha = getConnection()
    .prepare('SELECT created_at FROM core_orders WHERE id = ?')
    .get(orderId) as { created_at: string };
  return new Date(linha.created_at);
}

/** O relógio do teste: data do pedido e vencimento do boleto, fixos. */
function fixar(orderId: string, criado: string, vencimento: string | null): void {
  const db = getConnection();
  db.prepare('UPDATE core_orders SET created_at = ? WHERE id = ?').run(criado, orderId);
  db.prepare(
    "UPDATE core_payment_intents SET created_at = ?, due_date = ? WHERE origin_type = 'ecommerce_order' AND origin_id = ?",
  ).run(criado, vencimento, orderId);
}

const expirar = (instante: string | Date) =>
  expirarPedidosNaoPagos(new Date(instante), { fetchImpl: asaasDeTeste() });

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  cancelamentos = [];
  loja = await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Ltda' });
  upsertAsaasApiKey({ companyId: loja, environment: 'sandbox', apiKey: CHAVE });
  vi.stubEnv('ASAAS_ENABLED', 'true');
});

describe('o boleto não morre antes do banco confirmar', () => {
  it('a reprodução da auditoria: 25h depois o pedido do boleto de amanhã continua reservado', async () => {
    const { ordem, produto } = await pedidoCom('boleto');
    const depois = new Date(criadoEm(ordem.id).getTime() + PRAZO_DA_RESERVA_MS + 60_000);

    const r = await expirar(depois);

    expect(r.cancelados).toBe(0);
    expect(status(ordem.id)).toBe('aguardando_pagamento');
    // O item continua fora da vitrine — é dele, enquanto o boleto vale.
    expect(getAvailable(loja, produto)).toBe(9);
    // E ninguém pediu ao provedor para matar o boleto que o cliente pode pagar.
    expect(cancelamentos).toEqual([]);
  });

  it('vencimento no sábado: paga-se na segunda, e a reserva vai até o fim da quarta', async () => {
    const { ordem, produto } = await pedidoCom('boleto');
    // Sexta 11/09/2026 às 10h na loja; boleto vencendo no sábado 12/09.
    fixar(ordem.id, '2026-09-11T13:00:00.000Z', '2026-09-12');

    // Quarta 16/09 às 23h30 na loja: o banco ainda pode estar compensando.
    expect((await expirar('2026-09-17T02:30:00.000Z')).cancelados).toBe(0);
    expect(status(ordem.id)).toBe('aguardando_pagamento');

    // Quinta 17/09 à 0h01: agora sim — o boleto não vai mais ser pago.
    expect((await expirar('2026-09-17T03:01:00.000Z')).cancelados).toBe(1);
    expect(status(ordem.id)).toBe('cancelado');
    expect(getAvailable(loja, produto)).toBe(10);
    // A cobrança morre no provedor ANTES de o estoque voltar (GAP-V72).
    expect(cancelamentos).toHaveLength(1);
  });

  it('feriado nacional no caminho empurra a reserva um dia útil', async () => {
    const { ordem } = await pedidoCom('boleto');
    // Sexta 04/09/2026; vence sábado 05/09; segunda 07/09 é feriado.
    // Pagável até terça 08/09 → mais dois dias úteis = quinta 10/09.
    fixar(ordem.id, '2026-09-04T13:00:00.000Z', '2026-09-05');

    expect((await expirar('2026-09-11T02:00:00.000Z')).cancelados).toBe(0);
    expect((await expirar('2026-09-11T03:01:00.000Z')).cancelados).toBe(1);
  });

  it('cobrança antiga, sem vencimento guardado, usa o D+1 que o código sempre usou', async () => {
    const { ordem } = await pedidoCom('boleto');
    // Segunda 14/09 às 10h; vencimento não gravado (linha anterior à regra).
    fixar(ordem.id, '2026-09-14T13:00:00.000Z', null);

    // Terça 15/09 à noite: bem depois das 25h, e o boleto vence hoje.
    expect((await expirar('2026-09-16T00:00:00.000Z')).cancelados).toBe(0);
    // Vencimento terça → +2 úteis = quinta 17/09; sexta 0h01 cancela.
    expect((await expirar('2026-09-18T02:30:00.000Z')).cancelados).toBe(0);
    expect((await expirar('2026-09-18T03:01:00.000Z')).cancelados).toBe(1);
  });

  it('o vencimento que foi ao provedor fica guardado na intenção', async () => {
    const { ordem, cobranca } = await pedidoCom('boleto');
    const intencao = getConnection()
      .prepare("SELECT due_date FROM core_payment_intents WHERE origin_id = ? AND method = 'boleto'")
      .get(ordem.id) as { due_date: string | null };
    expect(intencao.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cobranca.dueDate).toBe(intencao.due_date);
  });

  it('a cobrança devolve até quando os itens ficam reservados — depois do vencimento', async () => {
    const { cobranca } = await pedidoCom('boleto');
    const vencimento = String(cobranca.dueDate);
    const fimDoVencimento = new Date(`${vencimento}T23:59:59.999-03:00`).getTime();

    expect(typeof cobranca.reservedUntil).toBe('string');
    // Pelo menos dois dias corridos depois do fim do vencimento (dois úteis).
    expect(new Date(String(cobranca.reservedUntil)).getTime()).toBeGreaterThanOrEqual(
      fimDoVencimento + 2 * 86_400_000,
    );
  });
});

describe('PIX e cartão continuam no relógio curto', () => {
  it('PIX vivo no provedor: 25h depois o pedido é cancelado e a cobrança morre lá', async () => {
    const { ordem, cobranca } = await pedidoCom('pix');
    const depois = new Date(criadoEm(ordem.id).getTime() + PRAZO_DA_RESERVA_MS + 60_000);

    expect((await expirar(depois)).cancelados).toBe(1);
    expect(status(ordem.id)).toBe('cancelado');
    expect(cancelamentos).toHaveLength(1);
    // E a tela soube disso na hora da cobrança.
    expect(new Date(String(cobranca.reservedUntil)).getTime()).toBe(
      criadoEm(ordem.id).getTime() + PRAZO_DA_RESERVA_MS,
    );
  });

  it('boleto que nunca saiu (loja sem credencial) não segura estoque além das 25h', async () => {
    const semChave = await upsertCompany({ slug: 'conceito', tradeName: 'Conceito', legalName: 'Conceito Ltda' });
    vi.stubEnv('ASAAS_API_KEY', '');
    const { ordem, cobranca } = await pedidoCom('boleto', semChave);
    expect(cobranca.status).toBe('unconfigured');

    const depois = new Date(criadoEm(ordem.id).getTime() + PRAZO_DA_RESERVA_MS + 60_000);
    expect((await expirar(depois)).cancelados).toBe(1);
  });
});
