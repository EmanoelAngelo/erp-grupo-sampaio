/**
 * A nota fiscal do pedido online.
 *
 * A NF-e 55 existia inteira e só sabia partir de uma VENDA. Pedido online não é
 * venda: tem financeiro próprio, lançado quando o pagamento entrou. Converter
 * pedido em venda para caber na coluna `sale_id` lançaria a mesma receita duas
 * vezes — e por isso a ponte ficou de fora até esta rodada, com um diagnóstico
 * no lugar dela.
 *
 * A INVARIANTE QUE ESTE ARQUIVO PROTEGE, e é a razão de o atalho ter sido
 * recusado:
 *
 *   EMITIR NOTA NÃO CRIA VENDA, NÃO BAIXA ESTOQUE E NÃO LANÇA RECEITA.
 *
 * Emitir papel não move mercadoria nem dinheiro. Se algum dia alguém "resolver"
 * isto criando uma venda para o pedido, os testes de contagem abaixo quebram.
 *
 * E o destinatário vem do CADASTRO do cliente, não do texto do pedido: a NF-e
 * quer município com código IBGE, e o endereço do pedido é uma linha só, boa
 * para a etiqueta e inútil para o fisco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfeForOrder,
  emitNfeForOrder,
  orderInvoiceReadiness,
  recipientForOrder,
} from '../src/services/core/OrderInvoiceService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const SENHA = 'Teste@PedidoNfe2026';
const EMAIL = 'joana@exemplo.com';

let companyId: string;
let gestor: { Authorization: string };
let contaId: string;
let numero = 0;

function agora(): string {
  return new Date().toISOString();
}

function criarProduto(ncm: string | null = '62052000'): string {
  numero += 1;
  const id = `prod-${numero}`;
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Camisa Online', 'UN', 1000, 5000, ?, '5102', '0', 1, ?, ?)`,
    )
    .run(id, companyId, `ON-${numero}`, ncm, agora(), agora());
  return id;
}

/** Endereço estruturado da CONTA — é dele que sai o destinatário. */
function criarEndereco(opcoes: { ibge?: string | null; zip?: string } = {}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_customer_addresses
         (id, account_id, label, zip, street, number, complement, district, city, state,
          city_ibge, is_default, created_at, updated_at)
       VALUES (?, ?, 'Casa', ?, 'Rua das Flores', '250', NULL, 'Central', 'Macapá', 'AP',
               ?, 1, ?, ?)`,
    )
    .run(
      randomUUID(),
      contaId,
      opcoes.zip ?? '68900000',
      opcoes.ibge === undefined ? '1600303' : opcoes.ibge,
      agora(),
      agora(),
    );
}

function criarPedido(
  opcoes: {
    status?: string;
    produtoId?: string;
    freteCents?: number;
    email?: string | null;
    documento?: string | null;
  } = {},
): string {
  ensureCoreSchema();
  numero += 1;
  const db = getConnection();
  const id = `pedido-${numero}`;
  const produto = opcoes.produtoId ?? criarProduto();
  const itens = 10000;
  const frete = opcoes.freteCents ?? 0;

  const clienteId = randomUUID();
  db.prepare(
    `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
     VALUES (?, ?, 'Joana Compradora', ?, ?, 1, ?, ?)`,
  ).run(
    clienteId,
    companyId,
    opcoes.documento === undefined ? `1111111111${numero}` : opcoes.documento,
    EMAIL,
    agora(),
    agora(),
  );

  db.prepare(
    `INSERT INTO core_orders
       (id, company_id, number, customer_id, customer_name, customer_email, customer_document,
        shipping_zip, shipping_address, shipping_method, shipping_cents,
        items_cents, total_cents, status, payment_method, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Joana Compradora', ?, ?, '68900000', 'Rua das Flores, 250 - Central',
             ?, ?, ?, ?, ?, 'pix', ?, ?, ?)`,
  ).run(
    id,
    companyId,
    numero,
    clienteId,
    opcoes.email === undefined ? EMAIL : opcoes.email,
    opcoes.documento === undefined ? `1111111111${numero}` : opcoes.documento,
    frete > 0 ? 'entrega' : 'retirada',
    frete,
    itens,
    itens + frete,
    opcoes.status ?? 'pago',
    `k-${id}`,
    agora(),
    agora(),
  );

  db.prepare(
    `INSERT INTO core_order_items (id, order_id, company_id, product_id, description,
                                   quantity, unit_price_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Online', 2, 5000, 10000)`,
  ).run(`oi-${numero}`, id, companyId, produto);

  return id;
}

function contagens() {
  const db = getConnection();
  const n = (t: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  return {
    vendas: n('core_sales'),
    itensDeVenda: n('core_sale_items'),
    estoque: n('core_stock_movements'),
    financeiro: n('core_finance_entries'),
    documentos: n('core_fiscal_documents'),
  };
}

beforeEach(async () => {
  resetDbForTests();
  numero = 0;
  companyId = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio Ltda',
    tradeName: 'Gringa',
  });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Gringa Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });

  contaId = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_customer_accounts (id, email, password_hash, active, created_at, updated_at)
       VALUES (?, ?, 'x', 1, ?, ?)`,
    )
    .run(contaId, EMAIL, agora(), agora());

  const userId = await upsertUser({ login: 'GESTOR1', displayName: 'Gestor', password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GESTOR1', password: SENHA });
  gestor = { Authorization: `Bearer ${res.body.accessToken}` };
});

describe('o destinatário sai do cadastro, não do texto do pedido', () => {
  it('monta endereço estruturado a partir do endereço da conta', () => {
    criarEndereco();
    const pedido = criarPedido();

    const dest = recipientForOrder(companyId, pedido)!;

    expect(dest.street).toBe('Rua das Flores');
    expect(dest.number).toBe('250');
    expect(dest.district).toBe('Central');
    expect(dest.cityIbge).toBe('1600303');
    expect(dest.uf).toBe('AP');
    // Consumidor final de loja online. Marcar contribuinte sem inscrição
    // mudaria a tributação da operação inteira.
    expect(dest.ieIndicator).toBe('9');
  });

  it('sem endereço cadastrado, devolve nulo em vez de inventar', () => {
    const pedido = criarPedido();
    // Completar município em branco produziria nota ACEITA e ERRADA — o pior
    // desfecho, porque o fisco registra o que foi enviado.
    expect(recipientForOrder(companyId, pedido)).toBeNull();
  });

  it('escolhe o endereço do CEP que o cliente usou na compra', () => {
    criarEndereco({ zip: '11111111' });
    criarEndereco({ zip: '68900000' });
    const pedido = criarPedido();

    expect(recipientForOrder(companyId, pedido)!.zip).toBe('68900000');
  });
});

describe('o que falta para faturar, dito antes do clique', () => {
  it('pedido não pago não é faturável, e diz o estado', () => {
    criarEndereco();
    const pedido = criarPedido({ status: 'aguardando_pagamento' });

    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    expect(r.reasons[0]).toContain('aguardando_pagamento');
  });

  it('cliente sem endereço fiscal vira motivo em português', () => {
    const pedido = criarPedido();
    const r = orderInvoiceReadiness(companyId, pedido);

    expect(r.canEmit).toBe(false);
    expect(r.reasons.join(' ')).toContain('endereço');
  });

  it('endereço sem código IBGE é apontado — é o campo que a NF-e exige', () => {
    // O endereço já era estruturado e ainda assim não servia para a nota: o
    // município vai pelo código de 7 dígitos, não pelo nome.
    criarEndereco({ ibge: null });
    const pedido = criarPedido();

    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    expect(r.reasons.join(' ')).toContain('IBGE');
  });

  it('produto do catálogo sem NCM não trava um pedido que está completo', () => {
    criarEndereco();
    criarProduto(null); // existe no catálogo, não está neste pedido
    const pedido = criarPedido({ produtoId: criarProduto() });

    const motivos = orderInvoiceReadiness(companyId, pedido).reasons.join(' ');
    // Travar aqui pararia o faturamento da loja inteira por causa de um item
    // que ninguém comprou.
    expect(motivos).not.toContain('produto(s) ativo(s)');
  });

  it('item DO PEDIDO sem NCM é apontado, com o nome do item', () => {
    criarEndereco();
    const pedido = criarPedido({ produtoId: criarProduto(null) });

    const motivos = orderInvoiceReadiness(companyId, pedido).reasons.join(' ');
    expect(motivos).toContain('NCM');
    expect(motivos).toContain('Camisa Online');
  });
});

describe('emitir a nota não cria venda nem repete dinheiro', () => {
  it('o documento nasce ligado ao PEDIDO, e nenhuma venda aparece', async () => {
    criarEndereco();
    const pedido = criarPedido();
    const antes = contagens();

    await emitNfeForOrder({ companyId, orderId: pedido, developmentMode: true });

    const depois = contagens();
    expect(depois.documentos).toBe(antes.documentos + 1);
    // A INVARIANTE. Criar venda aqui lançaria a mesma receita duas vezes e
    // baixaria de novo um estoque que já saiu no checkout.
    expect(depois.vendas).toBe(antes.vendas);
    expect(depois.itensDeVenda).toBe(antes.itensDeVenda);
    expect(depois.estoque).toBe(antes.estoque);
    expect(depois.financeiro).toBe(antes.financeiro);

    const doc = getConnection()
      .prepare('SELECT order_id, sale_id, model FROM core_fiscal_documents LIMIT 1')
      .get() as { order_id: string | null; sale_id: string | null; model: string };
    expect(doc.order_id).toBe(pedido);
    expect(doc.sale_id).toBeNull();
    expect(doc.model).toBe('55');
  });

  it('emitir duas vezes não gera segundo documento nem queima segundo número', async () => {
    criarEndereco();
    const pedido = criarPedido();

    const a = await emitNfeForOrder({ companyId, orderId: pedido, developmentMode: true });
    const b = await emitNfeForOrder({ companyId, orderId: pedido, developmentMode: true });

    expect(b.document.id).toBe(a.document.id);
    expect(b.document.number).toBe(a.document.number);
    expect(contagens().documentos).toBe(1);
  });

  it('o pedido continua como estava: a nota não muda o pedido', async () => {
    criarEndereco();
    const pedido = criarPedido();

    await emitNfeForOrder({ companyId, orderId: pedido, developmentMode: true });

    const row = getConnection()
      .prepare('SELECT status FROM core_orders WHERE id = ?')
      .get(pedido) as { status: string };
    expect(row.status).toBe('pago');
  });

  it('depois de emitida, a prontidão diz "já tem" e aponta o documento', async () => {
    criarEndereco();
    const pedido = criarPedido();
    const r = await emitNfeForOrder({ companyId, orderId: pedido, developmentMode: true });

    const p = orderInvoiceReadiness(companyId, pedido);
    expect(p.alreadyEmitted).toBe(true);
    expect(p.canEmit).toBe(false);
    expect(p.documentId).toBe(r.document.id);
  });

  it('pedido não pago é recusado mesmo se alguém chamar direto o serviço', () => {
    criarEndereco();
    const pedido = criarPedido({ status: 'aguardando_pagamento' });

    // A tela já não oferece; o serviço recusa de novo. Nota antes do dinheiro
    // declara uma operação que ainda pode não acontecer.
    expect(() => createNfeForOrder({ companyId, orderId: pedido })).toThrow(/pago/i);
  });

  it('o frete vai em campo próprio e o total dos itens continua fechando', async () => {
    criarEndereco();
    const pedido = criarPedido({ freteCents: 2500 });

    const r = await emitNfeForOrder({ companyId, orderId: pedido, developmentMode: true });
    const xml = getConnection()
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(r.document.id) as { xml_original: string };

    // Somar o frete ao total dos itens faria toda nota com entrega ser
    // recusada por divergência.
    expect(xml.xml_original).toContain('<vFrete>25.00</vFrete>');
    expect(xml.xml_original).toContain('<vProd>100.00</vProd>');
    expect(xml.xml_original).toContain('<vNF>125.00</vNF>');
  });
});

describe('a rota respeita perfil e vínculo', () => {
  it('o gestor consulta a prontidão do pedido da própria operação', async () => {
    criarEndereco();
    const pedido = criarPedido();

    const res = await request(app)
      .get(`/api/v1/core/orders/${pedido}/nfe/readiness`)
      .set(gestor);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('canEmit');
  });

  it('pedido de outra operação não existe para este gestor', async () => {
    const outra = upsertCompany({
      slug: 'preco-justo',
      legalName: 'Preço Justo Ltda',
      tradeName: 'Preço Justo',
    });
    const empresaOriginal = companyId;
    companyId = outra;
    const pedido = criarPedido();
    companyId = empresaOriginal;

    const res = await request(app)
      .get(`/api/v1/core/orders/${pedido}/nfe/readiness`)
      .set(gestor);

    expect(res.status).toBe(404);
  });

  it('sem sessão, nada', async () => {
    const pedido = criarPedido();
    const res = await request(app).get(`/api/v1/core/orders/${pedido}/nfe/readiness`);
    expect(res.status).toBe(401);
  });
});
