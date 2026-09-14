/**
 * Compras: fornecedor e pedido.
 *
 * A regra que este arquivo existe para proteger: PEDIDO NÃO É ENTRADA.
 *
 * O fornecedor manda o que ele manda, não o que foi pedido — falta item, vem
 * quantidade diferente, vem produto trocado. Se o pedido somasse ao estoque, o
 * sistema afirmaria que a mercadoria chegou porque alguém digitou que ia
 * chegar, e a diferença só apareceria no inventário, meses depois, como
 * sumiço sem explicação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
/*
  O STATUS VEM DA CONSTANTE, e não de um literal digitado aqui.

  Estes testes escreviam `'received'` — o valor que a consulta esperava e que a
  produção NUNCA grava. Passavam verdes enquanto o sistema real ficava com o
  pedido de compra parado em "enviado" para sempre e o histórico do fornecedor
  vazio. O teste concordava com o defeito em vez de cobrar o comportamento.
*/
import { NOTA_IMPORTADA, NOTA_RECEBIDA } from '../src/services/core/InboundNoteStatus.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-compras',
    companyId: 'loja-compras',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function fornecedor(over: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(auth)
    .send({ name: 'Distribuidora Alfa Ltda', document: '11222333000181', ...over });
  expect(res.status).toBe(201);
  return res.body;
}

async function produto(nome = 'Peça A', preco = 5000) {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: preco });
  return res.body.id as string;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT COALESCE(quantity, 0) AS q FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { q: number } | undefined;
  return row?.q ?? 0;
}

describe('cadastro de fornecedor', () => {
  it('guarda os prazos, que é o que faltava para comprar', async () => {
    const f = await fornecedor({ paymentTermDays: 28, deliveryDays: 7 });
    expect(f.payment_term_days).toBe(28);
    expect(f.delivery_days).toBe(7);
  });

  it('o mesmo CNPJ não vira dois cadastros', async () => {
    await fornecedor();
    const segundo = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: 'Alfa de novo', document: '11.222.333/0001-81' });
    // Máscara diferente, mesmo documento: deixar passar partiria o histórico
    // de compras do mesmo fornecedor em dois cadastros incompletos.
    expect(segundo.status).toBe(409);
  });

  it('documento com e sem máscara é o mesmo fornecedor na busca', async () => {
    await fornecedor();
    const res = await request(app)
      .get('/api/v1/core/suppliers?search=11.222.333/0001-81')
      .set(auth);
    expect(res.body.items).toHaveLength(1);
  });

  it('fornecedor sem documento é aceito — feira e autônomo existem', async () => {
    const res = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: 'Seu Zé das Embalagens' });
    expect(res.status).toBe(201);
  });

  it('prazo negativo não entra', async () => {
    const f = await fornecedor({ deliveryDays: -5 });
    expect(f.delivery_days).toBe(0);
  });

  it('desativar não apaga: o histórico continua com origem', async () => {
    const f = await fornecedor();
    await request(app).post(`/api/v1/core/suppliers/${f.id}/active`).set(auth).send({ active: false });

    const lista = await request(app).get('/api/v1/core/suppliers').set(auth);
    expect(lista.body.items).toHaveLength(0);

    const comInativos = await request(app)
      .get('/api/v1/core/suppliers?includeInactive=true')
      .set(auth);
    expect(comInativos.body.items).toHaveLength(1);

    // E continua respondendo por onde já passou.
    const detalhe = await request(app).get(`/api/v1/core/suppliers/${f.id}`).set(auth);
    expect(detalhe.status).toBe(200);
  });

  it('fornecedor de outra operação não é visível', async () => {
    const f = await fornecedor();
    const outra = await loginForTest(app, {
      userId: 'gerente-outra',
      companyId: 'loja-vizinha',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get(`/api/v1/core/suppliers/${f.id}`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.status).toBe(404);
  });
});

describe('pedido de compra', () => {
  it('NÃO movimenta estoque — é combinado, não entrada', async () => {
    const f = await fornecedor();
    const p = await produto();
    const antes = saldo(p);

    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 50, unitCostCents: 3000 }] });

    expect(res.status).toBe(201);
    await request(app).post(`/api/v1/core/purchase-orders/${res.body.id}/send`).set(auth).send({});

    // Nem ao criar, nem ao enviar. Quem dá entrada é a conferência da nota.
    expect(saldo(p)).toBe(antes);
  });

  it('soma o total do que foi pedido', async () => {
    const f = await fornecedor();
    const p = await produto();
    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({
        supplierId: f.id,
        items: [
          { productId: p, quantity: 10, unitCostCents: 2500 },
          { description: 'Caixa de papelão', quantity: 100, unitCostCents: 120 },
        ],
      });
    expect(res.body.total_cents).toBe(10 * 2500 + 100 * 120);
  });

  it('aceita item sem produto do catálogo', async () => {
    // Comprar embalagem ou café não deveria obrigar a criar produto de revenda.
    const f = await fornecedor();
    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ description: 'Café para a loja', quantity: 5, unitCostCents: 2200 }] });
    expect(res.status).toBe(201);
  });

  it('pedido sem item é recusado', async () => {
    const f = await fornecedor();
    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [] });
    expect(res.status).toBe(400);
  });

  it('a previsão de entrega sai do prazo do fornecedor', async () => {
    const f = await fornecedor({ deliveryDays: 10 });
    const p = await produto();
    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 1, unitCostCents: 100 }] });

    const dias = Math.round(
      (new Date(res.body.expected_at).getTime() - Date.now()) / 86400000,
    );
    expect(dias).toBe(10);
  });

  it('fornecedor desativado não recebe pedido', async () => {
    const f = await fornecedor();
    const p = await produto();
    await request(app).post(`/api/v1/core/suppliers/${f.id}/active`).set(auth).send({ active: false });

    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 1, unitCostCents: 100 }] });
    expect(res.status).toBe(400);
  });
});

describe('depois de enviado, o combinado é o combinado', () => {
  async function pedidoEnviado() {
    const f = await fornecedor();
    const p = await produto();
    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 10, unitCostCents: 1000 }] });
    await request(app).post(`/api/v1/core/purchase-orders/${res.body.id}/send`).set(auth).send({});
    return { orderId: res.body.id as string, produtoId: p, supplierId: f.id as string };
  }

  it('rascunho aceita alteração de itens', async () => {
    const f = await fornecedor();
    const p = await produto();
    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 10, unitCostCents: 1000 }] });

    const res = await request(app)
      .put(`/api/v1/core/purchase-orders/${criado.body.id}/items`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 3, unitCostCents: 1000 }] });
    expect(res.status).toBe(200);
    expect(res.body.total_cents).toBe(3000);
  });

  it('enviado NÃO aceita — a nota chegaria divergente de um pedido mudado aqui dentro', async () => {
    const { orderId, produtoId } = await pedidoEnviado();
    const res = await request(app)
      .put(`/api/v1/core/purchase-orders/${orderId}/items`)
      .set(auth)
      .send({ items: [{ productId: produtoId, quantity: 999, unitCostCents: 1 }] });
    expect(res.status).toBe(409);
  });

  it('cancelar exige motivo', async () => {
    const { orderId } = await pedidoEnviado();
    const semMotivo = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/cancel`)
      .set(auth)
      .send({ reason: '' });
    expect(semMotivo.status).toBe(400);

    const comMotivo = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/cancel`)
      .set(auth)
      .send({ reason: 'Fornecedor sem estoque' });
    expect(comMotivo.body.status).toBe('cancelado');
    expect(comMotivo.body.cancel_reason).toBe('Fornecedor sem estoque');
  });
});

describe('o que chegou sai da nota, não da digitação', () => {
  async function cenario() {
    const f = await fornecedor();
    const p = await produto();
    const pedido = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 10, unitCostCents: 1000 }] });
    await request(app)
      .post(`/api/v1/core/purchase-orders/${pedido.body.id}/send`)
      .set(auth)
      .send({});
    return { orderId: pedido.body.id as string, produtoId: p, supplierId: f.id as string };
  }

  /** Nota já conferida, do jeito que o NfeImportService a deixa. */
  function notaRecebida(supplierId: string, produtoId: string, quantidade: number) {
    const db = getConnection();
    const noteId = `nota-${Math.random().toString(36).slice(2)}`;
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, supplier_id, total_cents, status, received_at, created_at)
       VALUES (?, ?, ?, '1', ?, 1000, ?, ?, ?)`,
    ).run(noteId, companyId, `chave-${noteId}`, supplierId, NOTA_RECEBIDA, agora, agora);
    db.prepare(
      `INSERT INTO core_inbound_note_items
         (id, note_id, company_id, product_id, description, quantity, unit_cost_cents, total_cents, matched)
       VALUES (?, ?, ?, ?, 'Peça A', ?, 1000, 1000, 1)`,
    ).run(`item-${noteId}`, noteId, companyId, produtoId, quantidade);
    return noteId;
  }

  it('nota parcial deixa o pedido em recebido_parcial', async () => {
    const { orderId, produtoId, supplierId } = await cenario();
    const nota = notaRecebida(supplierId, produtoId, 4);

    const res = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/notes/${nota}`)
      .set(auth)
      .send({});

    expect(res.body.status).toBe('recebido_parcial');
  });

  it('completado o pedido, vira recebido', async () => {
    const { orderId, produtoId, supplierId } = await cenario();
    const n1 = notaRecebida(supplierId, produtoId, 4);
    const n2 = notaRecebida(supplierId, produtoId, 6);

    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/notes/${n1}`).set(auth).send({});
    const res = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/notes/${n2}`)
      .set(auth)
      .send({});

    expect(res.body.status).toBe('recebido');
  });

  it('nota de outro fornecedor é recusada', async () => {
    const { orderId, produtoId } = await cenario();
    const outro = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: 'Beta Distribuidora', document: '99888777000166' });
    const nota = notaRecebida(outro.body.id, produtoId, 10);

    // Mercadoria vinda de quem não foi pedido é a divergência mais grosseira
    // que existe: amarrar assim mesmo a esconderia.
    const res = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/notes/${nota}`)
      .set(auth)
      .send({});
    expect(res.status).toBe(409);
  });

  it('o detalhe mostra o pedido, o recebido e a nota que trouxe', async () => {
    const { orderId, produtoId, supplierId } = await cenario();
    const nota = notaRecebida(supplierId, produtoId, 4);
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/notes/${nota}`).set(auth).send({});

    const res = await request(app).get(`/api/v1/core/purchase-orders/${orderId}`).set(auth);
    expect(res.body.items[0].quantity).toBe(10);
    expect(res.body.items[0].received_quantity).toBe(4);
    expect(res.body.inboundNotes).toHaveLength(1);
  });

  it('a observação do pedido não é engolida pela lista de notas', async () => {
    const f = await fornecedor();
    const p = await produto();
    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({
        supplierId: f.id,
        notes: 'Entregar pela porta dos fundos',
        items: [{ productId: p, quantity: 1, unitCostCents: 100 }],
      });

    // `notes` é a observação de quem comprou; as notas de entrada vêm em
    // `inboundNotes`. Espalhar o array por cima apagaria a observação.
    const res = await request(app)
      .get(`/api/v1/core/purchase-orders/${criado.body.id}`)
      .set(auth);
    expect(res.body.notes).toBe('Entregar pela porta dos fundos');
    expect(res.body.inboundNotes).toEqual([]);
  });

  it('pedido recebido não é cancelado', async () => {
    const { orderId, produtoId, supplierId } = await cenario();
    const nota = notaRecebida(supplierId, produtoId, 10);
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/notes/${nota}`).set(auth).send({});

    const res = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/cancel`)
      .set(auth)
      .send({ reason: 'mudei de ideia' });
    // O que chegou, chegou: cancelar não desfaz a nota nem a dívida.
    expect(res.status).toBe(409);
  });
});

describe('histórico de compras do fornecedor', () => {
  it('conta nota recebida, e só ela', async () => {
    const f = await fornecedor();
    const p = await produto();
    const db = getConnection();
    const agora = new Date().toISOString();

    // Uma recebida e uma só importada, ainda sem conferência.
    for (const [id, status, total] of [
      ['n-ok', NOTA_RECEBIDA, 15000],
      ['n-pendente', NOTA_IMPORTADA, 99900],
    ] as const) {
      db.prepare(
        `INSERT INTO core_inbound_notes
           (id, company_id, access_key, number, supplier_id, total_cents, status, received_at, created_at)
         VALUES (?, ?, ?, '1', ?, ?, ?, ?, ?)`,
      ).run(id, companyId, `chave-${id}`, f.id, total, status, agora, agora);
    }

    const res = await request(app).get(`/api/v1/core/suppliers/${f.id}`).set(auth);
    // Importada ainda não entrou no estoque: contar como compra inflaria o
    // quanto se comprou de alguém que talvez não tenha entregue.
    expect(res.body.history.noteCount).toBe(1);
    expect(res.body.history.totalCents).toBe(15000);
    expect(p).toBeTruthy();
  });
});
