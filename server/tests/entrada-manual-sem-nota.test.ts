/**
 * ============================================================================
 * ENTRADA MANUAL — A COMPRA SEM NOTA FISCAL VIRA DOCUMENTO, DÍVIDA E RAZÃO
 * ============================================================================
 *
 * GAP-V17: a compra do fornecedor sem NF-e (feira, autônomo, produtor rural —
 * que o cadastro de fornecedor aceita SEM documento de propósito) só entrava
 * por movimento manual de estoque: sem documento, sem vínculo com fornecedor,
 * sem contas a pagar. A dívida dessa compra não existia no financeiro e o
 * histórico do fornecedor não a via.
 *
 * O desenho do conserto: `POST /purchases/manual` cria um documento de entrada
 * com ESPÉCIE PRÓPRIA (`doc_type = 'manual'` — nunca fingindo ser NF-e) que
 * desagua no MESMO funil conferir → confirmar da entrada por XML. Estoque,
 * custo, prazo do fornecedor, conciliação com pedido e auditoria são os
 * mesmos músculos já provados — o que muda é a origem honesta:
 *
 *   - o financeiro nasce com `origin_type = 'entrada_manual'`, não
 *     'nfe_entrada' — quem lê o contas a pagar sabe que ali não há XML;
 *   - o movimento de estoque sai com kind PURCHASE_RECEIPT ("Recebimento de
 *     compra"), não XML_RECEIPT ("Entrada por XML") — o razão não afirma
 *     arquivo que não existe;
 *   - a descrição diz "Entrada manual", não "NF-e".
 *
 * Idempotência em DUAS portas: a criação aceita `idempotencyKey` (reenviar o
 * mesmo formulário devolve a MESMA nota, como reimportar o mesmo XML), e a
 * confirmação continua idempotente pela referência do movimento + UNIQUE do
 * financeiro.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-da-feira',
    companyId: 'mercadinho-da-feira',
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

// ---------------------------------------------------------------- helpers

/** Seu Zé não tem CNPJ — e o cadastro aceita, de propósito (compras.test.ts). */
async function seuZe(over: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(auth)
    .send({ name: 'Seu Zé das Embalagens', paymentTermDays: 0, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 990, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function dividas(): Record<string, unknown>[] {
  return getConnection()
    .prepare(
      `SELECT amount_cents, direction, status, due_date, origin_type, origin_id,
              supplier_id, description
         FROM core_finance_entries WHERE company_id = ? AND direction = 'out'`,
    )
    .all(companyId) as unknown as Record<string, unknown>[];
}

async function criarEntrada(body: Record<string, unknown>) {
  return request(app).post('/api/v1/core/purchases/manual').set(auth).send(body);
}

async function confirmar(noteId: string) {
  const res = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

// =============================================================== O CAMINHO

describe('a compra sem nota fiscal, de ponta a ponta', () => {
  it('cria o documento em conferência — SEM tocar estoque nem financeiro ainda', async () => {
    const ze = await seuZe();
    const sacola = await produto('Sacola kraft 30x40');

    const res = await criarEntrada({
      supplierId: ze.id,
      documentNumber: 'RECIBO-17',
      items: [{ productId: sacola, quantity: 200, unitCostCents: 45 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.duplicated).toBe(false);
    expect(res.body.status).toBe('conferencia');

    // O documento diz o que É: entrada manual, nunca NF-e.
    const nota = getConnection()
      .prepare('SELECT doc_type, number, supplier_id, total_cents, xml_original FROM core_inbound_notes WHERE id = ?')
      .get(res.body.noteId) as Record<string, unknown>;
    expect(nota.doc_type).toBe('manual');
    expect(nota.number).toBe('RECIBO-17');
    expect(nota.supplier_id).toBe(ze.id);
    expect(nota.total_cents).toBe(200 * 45);
    expect(nota.xml_original).toBeNull(); // não há arquivo — e não se finge um

    // O funil é o MESMO: os itens saem pela mesma rota da conferência.
    const itens = await request(app)
      .get(`/api/v1/core/purchases/notes/${res.body.noteId}/items`)
      .set(auth);
    expect(itens.status).toBe(200);
    expect(itens.body.items).toHaveLength(1);
    expect(itens.body.items[0].productId).toBe(sacola);
    expect(itens.body.items[0].matchedBy).toBe('manual');

    // Documento em conferência é compromisso de digitação, não fato:
    expect(saldo(sacola)).toBe(0);
    expect(dividas()).toHaveLength(0);
  });

  it('confirmar dá entrada no estoque, atualiza o custo e cria a dívida com o prazo do fornecedor — com origem HONESTA', async () => {
    const ze = await seuZe({ paymentTermDays: 15 });
    const sacola = await produto('Sacola kraft 30x40');

    const criada = await criarEntrada({
      supplierId: ze.id,
      documentNumber: 'RECIBO-18',
      items: [{ productId: sacola, quantity: 200, unitCostCents: 45 }],
    });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    const noteId = criada.body.noteId as string;

    const r = await confirmar(noteId);
    expect(r.movedItems).toBe(1);

    // Estoque e custo pela MESMA régua da NF-e.
    expect(saldo(sacola)).toBe(200);
    const custo = getConnection()
      .prepare('SELECT cost_cents FROM core_products WHERE id = ?')
      .get(sacola) as { cost_cents: number };
    expect(custo.cost_cents).toBe(45);

    // A dívida existe, aponta para o fornecedor, vence no prazo dele — e
    // NUNCA se apresenta como NF-e.
    const contas = dividas();
    expect(contas).toHaveLength(1);
    expect(contas[0].amount_cents).toBe(9_000);
    expect(contas[0].status).toBe('open');
    expect(contas[0].supplier_id).toBe(ze.id);
    expect(contas[0].origin_type).toBe('entrada_manual');
    expect(contas[0].origin_id).toBe(noteId);
    expect(String(contas[0].description)).toContain('Entrada manual');
    expect(String(contas[0].description)).not.toContain('NF-e');
    /*
      O PRAZO CONTA A PARTIR DO DIA DA LOJA. O teste somava 15 dias ao dia de
      Greenwich: das 21h à meia-noite em Pelotas ele já virou, e o caso ficava
      vermelho toda noite sem nada no produto ter mudado (a junção da FIS o
      pegou às 23h).
    */
    expect(contas[0].due_date).toBe(somarDias(hojeNaLoja(), 15));

    // O razão do estoque conta a história certa: recebimento de compra, sem
    // afirmar XML que não existe.
    const mov = getConnection()
      .prepare(
        `SELECT kind, reference_type, quantity, unit_cost_cents, document_number
           FROM core_stock_movements
          WHERE company_id = ? AND reference_id = ? AND movement_type = 'in'`,
      )
      .all(companyId, noteId) as unknown as Record<string, unknown>[];
    expect(mov).toHaveLength(1);
    expect(mov[0].kind).toBe('PURCHASE_RECEIPT');
    expect(mov[0].reference_type).toBe('entrada_manual');
    expect(mov[0].quantity).toBe(200);
    expect(mov[0].unit_cost_cents).toBe(45);
    expect(String(mov[0].document_number)).toContain('Entrada manual');

    // E o histórico do fornecedor VÊ a compra — a queixa original do gap.
    const ficha = await request(app).get(`/api/v1/core/suppliers/${ze.id}`).set(auth);
    expect(ficha.status).toBe(200);
    expect(ficha.body.history.noteCount).toBe(1);
    expect(ficha.body.history.totalCents).toBe(9_000);
  });

  it('a conferência da doca vale aqui também: contado 150 de 200, o estoque entra com 150 e a dívida é a do documento', async () => {
    const ze = await seuZe();
    const sacola = await produto('Sacola kraft 30x40');
    const criada = await criarEntrada({
      supplierId: ze.id,
      items: [{ productId: sacola, quantity: 200, unitCostCents: 45 }],
    });
    const noteId = criada.body.noteId as string;

    const conferida = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 0, receivedQuantity: 150, divergenceNote: 'Meio milheiro veio molhado' });
    expect(conferida.status, JSON.stringify(conferida.body)).toBe(200);

    await confirmar(noteId);
    expect(saldo(sacola)).toBe(150);
    // A dívida é a do combinado — abatimento é conversa com o Seu Zé.
    expect(dividas()[0].amount_cents).toBe(9_000);
  });
});

// ============================================================ IDEMPOTÊNCIA

describe('reenviar não duplica — nas duas portas', () => {
  it('a MESMA idempotencyKey devolve a MESMA nota (200, duplicated), sem segunda linha', async () => {
    const ze = await seuZe();
    const sacola = await produto('Sacola kraft 30x40');
    const corpo = {
      supplierId: ze.id,
      idempotencyKey: 'form-abc-123',
      items: [{ productId: sacola, quantity: 10, unitCostCents: 100 }],
    };

    const primeira = await criarEntrada(corpo);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    const segunda = await criarEntrada(corpo);
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
    expect(segunda.body.duplicated).toBe(true);
    expect(segunda.body.noteId).toBe(primeira.body.noteId);

    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(quantas.n).toBe(1);
  });

  it('confirmar duas vezes não dobra estoque nem cria segunda dívida', async () => {
    const ze = await seuZe();
    const sacola = await produto('Sacola kraft 30x40');
    const criada = await criarEntrada({
      supplierId: ze.id,
      items: [{ productId: sacola, quantity: 10, unitCostCents: 100 }],
    });
    const noteId = criada.body.noteId as string;

    await confirmar(noteId);
    const denovo = await confirmar(noteId);
    expect(denovo.alreadyReceived).toBe(true);

    expect(saldo(sacola)).toBe(10);
    expect(dividas()).toHaveLength(1);
  });
});

// ============================================================== AS RECUSAS

describe('o que não pode entrar, não entra', () => {
  it('item sem produto do catálogo é recusado: entrada manual É de item do catálogo', async () => {
    const ze = await seuZe();
    const res = await criarEntrada({
      supplierId: ze.id,
      items: [{ description: 'coisa avulsa', quantity: 1, unitCostCents: 100 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('produto de outra empresa: 404, e nada é gravado', async () => {
    const ze = await seuZe();
    const outra = await loginForTest(app, {
      userId: 'gerente-vizinho-manual',
      companyId: 'vizinha-da-feira',
      profileCodes: ['gerente_loja'],
    });
    const authB = { Authorization: `Bearer ${outra.body.accessToken}` };
    const produtoDaB = await request(app)
      .post('/api/v1/core/products')
      .set(authB)
      .send({ name: 'Produto da vizinha', priceCents: 100 });
    expect(produtoDaB.status).toBe(201);

    const res = await criarEntrada({
      supplierId: ze.id,
      items: [{ productId: produtoDaB.body.id, quantity: 1, unitCostCents: 100 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(quantas.n).toBe(0);
  });

  it('quantidade zero, custo negativo e lista vazia: 400 transacional — cabeçalho não sobrevive a item podre', async () => {
    const ze = await seuZe();
    const sacola = await produto('Sacola kraft 30x40');
    for (const items of [
      [{ productId: sacola, quantity: 0, unitCostCents: 100 }],
      [{ productId: sacola, quantity: 5, unitCostCents: -1 }],
      [],
    ]) {
      const res = await criarEntrada({ supplierId: ze.id, items });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(quantas.n).toBe(0);
  });

  it('fornecedor inexistente: 404 — a dívida precisa de um credor de verdade', async () => {
    const sacola = await produto('Sacola kraft 30x40');
    const res = await criarEntrada({
      supplierId: 'nao-existe',
      items: [{ productId: sacola, quantity: 1, unitCostCents: 100 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it('operador de caixa não lança entrada manual: 403 — criar dívida é da gestão do estoque', async () => {
    const operador = await loginForTest(app, {
      userId: 'caixa-da-feira',
      companyId: 'mercadinho-da-feira',
      profileCodes: ['operador_caixa_loja'],
    });
    const res = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set({ Authorization: `Bearer ${operador.body.accessToken}` })
      .send({ supplierId: 'x', items: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});

// ============================================================== A LISTAGEM

describe('a lista de notas diz a espécie', () => {
  it('doc_type viaja na lista — é por ele que a tela rotula "entrada manual (sem nota fiscal)"', async () => {
    const ze = await seuZe();
    const sacola = await produto('Sacola kraft 30x40');
    await criarEntrada({
      supplierId: ze.id,
      items: [{ productId: sacola, quantity: 10, unitCostCents: 45 }],
    });

    const lista = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].doc_type).toBe('manual');
  });
});
