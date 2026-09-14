/**
 * ============================================================================
 * A FICHA DO PEDIDO PRECISA SABER A ESPÉCIE DA NOTA — E O SERVIDOR NÃO DIZIA
 * ============================================================================
 *
 * ## O defeito
 *
 * `GET /core/purchase-orders/:id` devolve `inboundNotes` com id, chave, número,
 * série, total, status e data de recebimento — e NÃO com `doc_type`. Só que a
 * espécie do documento é o que decide a ORIGEM do lançamento financeiro que ele
 * gerou: NF-e importada nasce com `origin_type = 'nfe_entrada'`, compra
 * digitada sem nota fiscal nasce com `'entrada_manual'` (GAP-V17). São origens
 * diferentes de propósito, para que a compra sem nota nunca se apresente como
 * NF-e em relatório, conciliação e estorno.
 *
 * Sem a espécie na resposta, a ficha do pedido (PedidosCompraPage) perguntava
 * ao financeiro DUAS vezes por nota — uma por origem — e ficava com a união.
 * Funciona e é barato, mas guarda na TELA uma segunda definição de "o que é
 * entrada manual": no dia em que o servidor mudar a régua (uma terceira
 * espécie, um recibo de produtor rural), a tela continua adivinhando pela regra
 * velha, e ninguém descobre porque a soma continua fechando por acidente.
 *
 * ## O que este arquivo cobra
 *
 * Que a ficha do pedido traga a ESPÉCIE de cada nota amarrada, com as duas
 * espécies na MESMA lista — e que a espécie devolvida seja a mesma que decide a
 * origem no financeiro, para que ler `doc_type` não seja um terceiro palpite.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import { NOTA_RECEBIDA } from '../src/services/core/InboundNoteStatus.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-das-compras',
    companyId: 'loja-das-duas-especies',
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function fornecedor(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(auth)
    // Sem CNPJ de propósito: o fornecedor da feira é justamente quem entrega
    // sem NF-e, e é dele que nasce a entrada manual.
    .send({ name: 'Seu Zé das Embalagens', paymentTermDays: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function produto(nome: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 990 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function pedido(supplierId: string, productId: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/purchase-orders')
    .set(auth)
    .send({ supplierId, items: [{ productId, quantity: 100, unitCostCents: 450 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/**
 * A NF-e do pedido.
 *
 * Gravada por INSERT, como o resto de `compras.test.ts` faz, e SEM escrever
 * `doc_type`: assim a linha nasce pelo DEFAULT do schema ('nfe'), que é a forma
 * das notas antigas — o caso em que a ficha mais precisa não adivinhar.
 */
function notaFiscal(supplierId: string, productId: string, quantidade: number): string {
  const db = getConnection();
  const noteId = `nfe-${Math.random().toString(36).slice(2)}`;
  const agora = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_inbound_notes
       (id, company_id, access_key, number, supplier_id, total_cents, status, received_at, created_at)
     VALUES (?, ?, ?, '4501', ?, 45000, ?, ?, ?)`,
  ).run(noteId, companyId, `chave-${noteId}`, supplierId, NOTA_RECEBIDA, agora, agora);
  db.prepare(
    `INSERT INTO core_inbound_note_items
       (id, note_id, company_id, product_id, description, quantity, unit_cost_cents, total_cents, matched)
     VALUES (?, ?, ?, ?, 'Sacola kraft 30x40', ?, 450, 45000, 1)`,
  ).run(`item-${noteId}`, noteId, companyId, productId, quantidade);
  return noteId;
}

async function amarrar(orderId: string, noteId: string) {
  const res = await request(app)
    .post(`/api/v1/core/purchase-orders/${orderId}/notes/${noteId}`)
    .set(auth)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

interface NotaDaFicha {
  id: string;
  doc_type: string | null;
  status: string;
}

async function fichaDoPedido(orderId: string): Promise<NotaDaFicha[]> {
  const res = await request(app).get(`/api/v1/core/purchase-orders/${orderId}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.inboundNotes as NotaDaFicha[];
}

describe('a ficha do pedido diz a espécie de cada nota', () => {
  it('NF-e e entrada manual na MESMA lista, cada uma com sua espécie', async () => {
    const ze = await fornecedor();
    const sacola = await produto('Sacola kraft 30x40');
    const orderId = await pedido(ze, sacola);

    // A compra SEM nota fiscal, pelo caminho de verdade: é a rota que carimba
    // `doc_type = 'manual'`, e o teste não inventa o valor.
    const manual = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(auth)
      .send({
        supplierId: ze,
        documentNumber: 'RECIBO-17',
        items: [{ productId: sacola, quantity: 40, unitCostCents: 450 }],
      });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);

    const nfe = notaFiscal(ze, sacola, 60);
    await amarrar(orderId, manual.body.noteId as string);
    await amarrar(orderId, nfe);

    const notas = await fichaDoPedido(orderId);
    expect(notas).toHaveLength(2);

    const porId = new Map(notas.map((n) => [n.id, n]));
    // A espécie viaja na ficha: sem ela, quem lê tem de perguntar duas vezes e
    // descobrir a espécie por eliminação — uma segunda régua fora do servidor.
    expect(porId.get(manual.body.noteId as string)?.doc_type).toBe('manual');
    expect(porId.get(nfe)?.doc_type).toBe('nfe');
  });

  it('a espécie da ficha é a MESMA que decide a origem no financeiro', async () => {
    const ze = await fornecedor();
    const sacola = await produto('Sacola kraft 30x40');
    const orderId = await pedido(ze, sacola);

    const manual = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(auth)
      .send({
        supplierId: ze,
        documentNumber: 'RECIBO-18',
        items: [{ productId: sacola, quantity: 100, unitCostCents: 450 }],
      });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    const noteId = manual.body.noteId as string;

    await amarrar(orderId, noteId);
    const confirmada = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
      .set(auth)
      .send({});
    expect(confirmada.status, JSON.stringify(confirmada.body)).toBe(200);

    const notas = await fichaDoPedido(orderId);
    expect(notas[0].doc_type).toBe('manual');

    /*
      O AMARRE: a dívida desta nota nasceu com `origin_type = 'entrada_manual'`.
      É por isso que a espécie precisa vir do servidor — quem quiser os títulos
      da nota tem de perguntar com ESTA origem, e não com a que sobrou de um
      palpite feito na tela. Se um dia a régua mudar, ela muda num lugar só.
    */
    const origens = getConnection()
      .prepare(
        `SELECT DISTINCT origin_type FROM core_finance_entries
          WHERE company_id = ? AND origin_id = ?`,
      )
      .all(companyId, noteId) as unknown as { origin_type: string }[];
    expect(origens.map((o) => o.origin_type)).toEqual(['entrada_manual']);
  });
});
