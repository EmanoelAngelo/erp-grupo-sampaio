/**
 * Jornada comercial online, ponta a ponta.
 *
 * Carrinho → checkout → cliente oficial → cobrança na conta da operação →
 * webhook → pedido pago → estoque → financeiro.
 *
 * O provedor aqui é um DUBLÊ DE TESTE explícito (`asaasDeTeste`), não um
 * "modo de teste" escondido dentro do serviço. Nada aqui é homologação: são
 * respostas fabricadas por este arquivo para exercitar o caminho sem rede.
 * O `AsaasHttpClient` real é quem monta a requisição — o dublê só devolve o
 * corpo, e é por isso que o teste ainda prova o caminho.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { cancelOrder, checkout } from '../src/services/core/StorefrontService.js';
import { cancelOrderCharges, createOrderCharge } from '../src/services/core/OrderChargeService.js';
import { findAsaasCustomerLink } from '../src/services/core/AsaasCustomerLinkService.js';
import { getAvailable } from '../src/services/core/InventoryService.js';

const CHAVE_PJ = '$aact_sandbox_preco_justo_00000000000000';
const CHAVE_GRINGA = '$aact_sandbox_gringa_1111111111111111111';
const TOKEN_PJ = 'token-webhook-preco-justo';
const TOKEN_GRINGA = 'token-webhook-gringa';

let precoJusto: string;
let gringa: string;
let n = 0;

/**
 * Dublê do Asaas.
 *
 * Responde ao que o `AsaasHttpClient` realmente pede, com o formato que a API
 * documenta. Conta as chamadas — é assim que se prova que dez cliques não
 * viram dez cobranças.
 */
function asaasDeTeste() {
  const chamadas: { method: string; url: string; body: unknown }[] = [];
  let sequencia = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    chamadas.push({ method: metodo, url: endereco, body: corpo });

    const responder = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (endereco.endsWith('/customers') && metodo === 'POST') {
      sequencia += 1;
      return responder({ id: `cus_TEST_${sequencia}`, name: corpo?.name });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      sequencia += 1;
      return responder({
        id: `pay_TEST_${sequencia}`,
        invoiceUrl: `https://sandbox.asaas.com/i/TEST_${sequencia}`,
        bankSlipUrl: `https://sandbox.asaas.com/b/TEST_${sequencia}`,
        dueDate: '2026-12-31',
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
      return responder({ identificationField: '34191.79001 01043.510047 91020.150008 1 96610000010000' });
    }
    // Remover a cobrança é DELETE /payments/:id no Asaas (GAP-PRD-169).
    if (metodo === 'DELETE' && /[/]payments[/][^/?]+$/.test(endereco)) {
      return responder({ id: 'pay_TEST_cancelado', status: 'CANCELLED' });
    }
    return responder({});
  }) as unknown as typeof fetch;

  return { fetchImpl, chamadas };
}

function produtoPublicado(companyId: string, preco = 10000): string {
  n += 1;
  const id = `prod-${companyId.slice(0, 4)}-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Produto online', 'UN', 5000, ?, 1, 1, ?, ?)`,
  ).run(id, companyId, `ON-${n}`, preco, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

function evento(id: string, event: string, providerRef: string): Record<string, unknown> {
  return { id, event, payment: { id: providerRef } };
}

function pedido(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_orders WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

function lancamentos(orderId: string): Record<string, unknown>[] {
  return getConnection()
    .prepare("SELECT * FROM core_finance_entries WHERE origin_type = 'ecommerce_order' AND origin_id = ?")
    .all(orderId) as Record<string, unknown>[];
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'sandbox', apiKey: CHAVE_PJ });
  upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_PJ });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_GRINGA });
  vi.stubEnv('ASAAS_ENABLED', 'true');
});

describe('jornada PIX completa', () => {
  it('do carrinho ao pedido pago, com estoque e financeiro certos', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl } = asaasDeTeste();

    const [ordem] = checkout({
      idempotencyKey: 'ck-pix-1',
      customerName: 'Maria Compradora',
      customerDocument: '111.444.777-35',
      customerEmail: 'maria@exemplo.com',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 2 }],
    });

    // Reserva na criação: o item sai da vitrine antes de o dinheiro chegar.
    expect(getAvailable(precoJusto, produto)).toBe(8);
    expect(pedido(ordem.id).customer_id).toBeTruthy();

    const cobranca = await createOrderCharge({
      companyId: precoJusto,
      orderId: ordem.id,
      method: 'pix',
      fetchImpl,
    });

    expect(cobranca.status).toBe('pending');
    expect(cobranca.pixPayload).toBe('00020126TESTE-COPIA-E-COLA');
    // Mostrar o QR NÃO é receber.
    expect(pedido(ordem.id).status).toBe('aguardando_pagamento');
    expect(lancamentos(ordem.id)).toHaveLength(0);

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: evento('ev-pix-1', 'PAYMENT_CONFIRMED', cobranca.intent.provider_ref!),
    });

    expect(pedido(ordem.id).status).toBe('pago');
    // Reserva virou baixa: 10 - 2, e nada mais reservado.
    expect(getAvailable(precoJusto, produto)).toBe(8);
    const saldo = getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(precoJusto, produto) as { quantity: number; reserved: number };
    expect(saldo).toEqual({ quantity: 8, reserved: 0 });

    // Um único fato econômico.
    const financeiro = lancamentos(ordem.id);
    expect(financeiro).toHaveLength(1);
    expect(financeiro[0].status).toBe('settled');
  });

  it('o cliente do pedido é o oficial da operação, reaproveitado na segunda compra', async () => {
    const { fetchImpl } = asaasDeTeste();
    const primeiro = produtoPublicado(precoJusto);
    const segundo = produtoPublicado(precoJusto);

    const [a] = checkout({
      idempotencyKey: 'ck-cli-1',
      customerName: 'João Cliente',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: primeiro, quantity: 1 }],
    });
    const [b] = checkout({
      idempotencyKey: 'ck-cli-2',
      customerName: 'João Cliente',
      customerDocument: '11144477735',
      customerEmail: 'joao@exemplo.com',
      paymentMethod: 'pix',
      items: [{ productId: segundo, quantity: 1 }],
    });

    // Mesmo CPF, mesmo cadastro — com ou sem pontuação.
    expect(pedido(a.id).customer_id).toBe(pedido(b.id).customer_id);
    const clientes = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_customers WHERE company_id = ?')
      .get(precoJusto) as { c: number };
    expect(clientes.c).toBe(1);

    /*
      O e-mail que chegou na segunda compra NÃO entra no cadastro (GAP-PRD-006).

      Este caso afirmava o contrário — "o e-mail que chegou foi guardado" — e
      era exatamente o defeito: o checkout é público, e quem digitasse o CPF de
      outra pessoa com o próprio e-mail trocava o contato do cadastro dela e
      fabricava a co-prova que o portal usava para entregar o histórico. O
      cadastro fica como estava; o pedido guarda a cópia do que foi digitado.
    */
    const cliente = getConnection()
      .prepare('SELECT email FROM core_customers WHERE id = ?')
      .get(String(pedido(b.id).customer_id)) as { email: string | null };
    expect(cliente.email).toBeNull();
    expect(pedido(b.id).customer_email).toBe('joao@exemplo.com');

    await createOrderCharge({ companyId: precoJusto, orderId: a.id, method: 'pix', fetchImpl });
    await createOrderCharge({ companyId: precoJusto, orderId: b.id, method: 'pix', fetchImpl });

    // Um cliente no provedor, não dois.
    const vinculos = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_asaas_customers WHERE company_id = ?')
      .get(precoJusto) as { c: number };
    expect(vinculos.c).toBe(1);
  });
});

describe('idempotência da cobrança', () => {
  it('dez cliques em pagar = uma cobrança no provedor', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl, chamadas } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-idem',
      customerName: 'Cliente Apressado',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 1 }],
    });

    const resultados = [];
    for (let i = 0; i < 10; i += 1) {
      resultados.push(
        await createOrderCharge({
          companyId: precoJusto,
          orderId: ordem.id,
          method: 'pix',
          fetchImpl,
        }),
      );
    }

    const referencias = new Set(resultados.map((r) => r.intent.provider_ref));
    expect(referencias.size).toBe(1);

    const criacoes = chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/payments'));
    expect(criacoes).toHaveLength(1);

    // E o QR foi buscado UMA vez: reabrir o pedido lê o que já está guardado.
    const buscasDeQr = chamadas.filter((c) => c.url.includes('/pixQrCode'));
    expect(buscasDeQr).toHaveLength(1);

    const intencoes = getConnection()
      .prepare("SELECT COUNT(*) c FROM core_payment_intents WHERE origin_id = ?")
      .get(ordem.id) as { c: number };
    expect(intencoes.c).toBe(1);
  });

  it('reenviar o mesmo checkout não cria segundo pedido nem segunda reserva', () => {
    const produto = produtoPublicado(precoJusto);
    const entrada = {
      idempotencyKey: 'ck-repetido',
      customerName: 'Cliente Duplo',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix' as const,
      items: [{ productId: produto, quantity: 3 }],
    };

    const primeiro = checkout(entrada);
    const segundo = checkout(entrada);

    expect(segundo[0].id).toBe(primeiro[0].id);
    expect(getAvailable(precoJusto, produto)).toBe(7);
  });
});

describe('carrinho com duas operações', () => {
  it('vira dois pedidos, duas cobranças e duas contas', async () => {
    const doPrecoJusto = produtoPublicado(precoJusto, 10000);
    const daGringa = produtoPublicado(gringa, 25000);
    const { fetchImpl, chamadas } = asaasDeTeste();

    const pedidos = checkout({
      idempotencyKey: 'ck-multi',
      customerName: 'Cliente Multi',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [
        { productId: doPrecoJusto, quantity: 1 },
        { productId: daGringa, quantity: 1 },
      ],
    });

    expect(pedidos).toHaveLength(2);
    expect(new Set(pedidos.map((p) => p.company_id))).toEqual(new Set([precoJusto, gringa]));

    for (const p of pedidos) {
      await createOrderCharge({
        companyId: p.company_id,
        orderId: p.id,
        method: 'pix',
        fetchImpl,
      });
    }

    // Duas cobranças, cada uma com a chave da sua operação — é isso que
    // garante que o dinheiro cai no CNPJ certo.
    const criacoes = chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/payments'));
    expect(criacoes).toHaveLength(2);

    // Cliente vinculado nas DUAS operações, separadamente.
    const cliPj = pedido(pedidos.find((p) => p.company_id === precoJusto)!.id).customer_id;
    const cliGr = pedido(pedidos.find((p) => p.company_id === gringa)!.id).customer_id;
    expect(cliPj).not.toBe(cliGr);
    expect(findAsaasCustomerLink({ companyId: precoJusto, customerId: String(cliPj), environment: 'sandbox' })).toBeTruthy();
    expect(findAsaasCustomerLink({ companyId: gringa, customerId: String(cliGr), environment: 'sandbox' })).toBeTruthy();

    // Nenhuma cobrança soma o valor das duas empresas.
    const valores = criacoes.map((c) => (c.body as { value: number }).value).sort();
    expect(valores).toEqual([100, 250]);
  });

  it('o webhook de uma operação não confirma o pedido da outra', async () => {
    const daGringa = produtoPublicado(gringa);
    const { fetchImpl } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-cross',
      customerName: 'Cliente Cross',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: daGringa, quantity: 1 }],
    });
    const cobranca = await createOrderCharge({
      companyId: gringa,
      orderId: ordem.id,
      method: 'pix',
      fetchImpl,
    });

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: precoJusto,
        token: TOKEN_PJ,
        payload: evento('ev-cross', 'PAYMENT_CONFIRMED', cobranca.intent.provider_ref!),
      }),
    ).toThrow(expect.objectContaining({ code: 'API_WEBHOOK_TENANT_MISMATCH' }));

    expect(pedido(ordem.id).status).toBe('aguardando_pagamento');
  });
});

describe('cancelamento antes do pagamento', () => {
  it('cancela a cobrança no provedor e devolve a reserva', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl, chamadas } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-cancel',
      customerName: 'Cliente Arrependido',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 4 }],
    });
    await createOrderCharge({ companyId: precoJusto, orderId: ordem.id, method: 'pix', fetchImpl });
    expect(getAvailable(precoJusto, produto)).toBe(6);

    await cancelOrderCharges({ companyId: precoJusto, orderId: ordem.id, fetchImpl });
    cancelOrder({ companyId: precoJusto, orderId: ordem.id, reason: 'Cliente desistiu' });

    expect(chamadas.some((c) => c.method === 'DELETE' && /[/]payments[/][^/?]+$/.test(c.url))).toBe(true);
    expect(pedido(ordem.id).status).toBe('cancelado');
    // Estoque de volta na prateleira, inteiro.
    expect(getAvailable(precoJusto, produto)).toBe(10);
    const saldo = getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(precoJusto, produto) as { quantity: number; reserved: number };
    expect(saldo).toEqual({ quantity: 10, reserved: 0 });
  });
});

describe('webhook duplicado sobre o pedido real', () => {
  it('dez vezes o mesmo evento = um pagamento, um financeiro, uma baixa', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-dup',
      customerName: 'Cliente Repetido',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 2 }],
    });
    const cobranca = await createOrderCharge({
      companyId: precoJusto,
      orderId: ordem.id,
      method: 'pix',
      fetchImpl,
    });
    const payload = evento('ev-dup', 'PAYMENT_CONFIRMED', cobranca.intent.provider_ref!);

    for (let i = 0; i < 10; i += 1) {
      handlePaymentWebhook({ provider: 'asaas', companyId: precoJusto, token: TOKEN_PJ, payload });
    }

    expect(pedido(ordem.id).status).toBe('pago');
    expect(lancamentos(ordem.id)).toHaveLength(1);
    const saldo = getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(precoJusto, produto) as { quantity: number; reserved: number };
    expect(saldo).toEqual({ quantity: 8, reserved: 0 });
  });
});

describe('estorno depois do pagamento', () => {
  it('o pedido sai de pago, e o estoque NÃO volta sozinho', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-refund',
      customerName: 'Cliente Estornado',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 3 }],
    });
    const cobranca = await createOrderCharge({
      companyId: precoJusto,
      orderId: ordem.id,
      method: 'pix',
      fetchImpl,
    });
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: evento('ev-ref-1', 'PAYMENT_CONFIRMED', cobranca.intent.provider_ref!),
    });
    expect(pedido(ordem.id).status).toBe('pago');

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: evento('ev-ref-2', 'PAYMENT_REFUNDED', cobranca.intent.provider_ref!),
    });

    expect(pedido(ordem.id).status).toBe('reembolsado');

    // A mercadoria já saiu. Devolver estoque automaticamente inventaria uma
    // devolução física que ninguém conferiu.
    const saldo = getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(precoJusto, produto) as { quantity: number; reserved: number };
    expect(saldo).toEqual({ quantity: 7, reserved: 0 });

    // O lançamento original continua lá, e continua único: a receita do mês
    // do pagamento não é reescrita. O dinheiro que voltou é uma SAÍDA própria,
    // quitada, na competência do estorno (GAP-PRD-031).
    expect(lancamentos(ordem.id)).toHaveLength(1);
    const contrapartida = getConnection()
      .prepare(
        `SELECT direction, amount_cents, settled_cents, status FROM core_finance_entries
          WHERE origin_type = 'ecommerce_order_refund' AND origin_id = ?`,
      )
      .all(ordem.id) as Record<string, unknown>[];
    expect(contrapartida).toHaveLength(1);
    expect(contrapartida[0]).toMatchObject({ direction: 'out', status: 'settled' });
    expect(contrapartida[0].settled_cents).toBe(contrapartida[0].amount_cents);

    const linha = getConnection()
      .prepare('SELECT status, note FROM core_order_events WHERE order_id = ? ORDER BY created_at')
      .all(ordem.id) as { status: string; note: string | null }[];
    expect(linha.map((e) => e.status)).toContain('reembolsado');
  });

  it('estorno repetido não muda nada de novo', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-refund-dup',
      customerName: 'Cliente Estornado',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 1 }],
    });
    const cobranca = await createOrderCharge({
      companyId: precoJusto,
      orderId: ordem.id,
      method: 'pix',
      fetchImpl,
    });
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: evento('ev-rd-1', 'PAYMENT_CONFIRMED', cobranca.intent.provider_ref!),
    });
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: evento('ev-rd-2', 'PAYMENT_REFUNDED', cobranca.intent.provider_ref!),
    });

    // Outro evento de estorno, com id próprio: passa pela idempotência do
    // webhook, mas o pedido já está reembolsado.
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN_PJ,
      payload: evento('ev-rd-3', 'PAYMENT_REFUNDED', cobranca.intent.provider_ref!),
    });

    const eventos = getConnection()
      .prepare("SELECT COUNT(*) c FROM core_order_events WHERE order_id = ? AND status = 'reembolsado'")
      .get(ordem.id) as { c: number };
    expect(eventos.c).toBe(1);
    expect(lancamentos(ordem.id)).toHaveLength(1);
  });
});

describe('boleto', () => {
  it('gera a cobrança e devolve a linha digitável, sem dar o pedido por pago', async () => {
    const produto = produtoPublicado(precoJusto);
    const { fetchImpl } = asaasDeTeste();
    const [ordem] = checkout({
      idempotencyKey: 'ck-boleto',
      customerName: 'Cliente Boleto',
      customerDocument: '111.444.777-35',
      paymentMethod: 'boleto',
      items: [{ productId: produto, quantity: 1 }],
    });

    const cobranca = await createOrderCharge({
      companyId: precoJusto,
      orderId: ordem.id,
      method: 'boleto',
      fetchImpl,
    });

    expect(cobranca.identificationField).toContain('34191');
    expect(cobranca.bankSlipUrl).toContain('sandbox.asaas.com');
    expect(pedido(ordem.id).status).toBe('aguardando_pagamento');
  });
});

describe('sem credencial', () => {
  it('a loja não quebra: a cobrança sai como não configurada', async () => {
    const semChave = await upsertCompany({
      slug: 'conceito',
      tradeName: 'Conceito',
      legalName: 'Conceito Ltda',
    });
    // Sem fallback de ambiente para esta operação.
    vi.stubEnv('ASAAS_API_KEY', '');
    const produto = produtoPublicado(semChave);
    const [ordem] = checkout({
      idempotencyKey: 'ck-sem-chave',
      customerName: 'Cliente Sem Provedor',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 1 }],
    });

    const cobranca = await createOrderCharge({
      companyId: semChave,
      orderId: ordem.id,
      method: 'pix',
    });

    expect(cobranca.status).toBe('unconfigured');
    expect(cobranca.pixPayload).toBeNull();
    expect(pedido(ordem.id).status).toBe('aguardando_pagamento');
  });
});
