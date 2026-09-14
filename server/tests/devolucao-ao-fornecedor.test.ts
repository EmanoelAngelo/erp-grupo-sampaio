/**
 * ============================================================================
 * DEVOLUÇÃO AO FORNECEDOR — GAP-PRD-089
 * ============================================================================
 *
 * O que existia cobria só "confirmei a nota errada": o estorno desfaz a nota
 * INTEIRA e recusa quando a dívida tem baixa ou a mercadoria já saiu. Devolver
 * a pastilha com defeito de uma compra paga e em parte vendida não tinha
 * caminho — `cancelPurchaseOrder` dizia "a devolução é outro caminho", que não
 * existia.
 *
 * Cada caso nasceu VERMELHO contra o HEAD anterior (as rotas respondiam 404 e a
 * tabela não existia). O que este arquivo trava:
 *
 *   - a saída de estoque tem kind próprio, referência própria, custo de entrada
 *     e motivo — e respeita o que a nota pôs, o que já voltou e o DISPONÍVEL;
 *   - o financeiro: ABATIMENTO diminui o título em aberto (sem baixa fingida),
 *     CRÉDITO cria título a receber do fornecedor com origem rotulada, e "sem
 *     efeito" só vale para nota sem dívida;
 *   - o fiscal nasce PENDENTE, com a chave da nota de entrada na frase, e só se
 *     resolve com chave válida, nota do fornecedor ou dispensa justificada;
 *   - a nota com devolução não pode mais ser estornada;
 *   - gerência registra; estoquista lê; outra empresa não acha.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { accessKeyCheckDigit } from '../src/services/core/FiscalKeyService.js';
import { confirmNfe, importNfe } from '../src/services/core/NfeImportService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

interface Sessao {
  auth: { Authorization: string };
  companyId: string;
}

async function entrar(userId: string, perfil: string, empresa = 'loja-devolucao'): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, companyId: res.body.company.id };
}

let gerente: Sessao;

async function fornecedor(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(gerente.auth)
    .send({ name: 'Distribuidora Freio Bom', paymentTermDays: 30 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function produto(nome: string): Promise<string> {
  const res = await request(app).post('/api/v1/core/products').set(gerente.auth).send({ name: nome, priceCents: 9900 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Uma compra de verdade, confirmada: estoque, custo e dívida pelo funil real. */
async function compraRecebida(
  supplierId: string,
  itens: { productId: string; quantity: number; unitCostCents: number }[],
): Promise<string> {
  const criada = await request(app)
    .post('/api/v1/core/purchases/manual')
    .set(gerente.auth)
    .send({ supplierId, documentNumber: 'REC-88', items: itens });
  expect(criada.status, JSON.stringify(criada.body)).toBe(201);
  const confirmada = await request(app)
    .post(`/api/v1/core/purchases/notes/${criada.body.noteId}/confirm`)
    .set(gerente.auth)
    .send({});
  expect(confirmada.status, JSON.stringify(confirmada.body)).toBe(200);
  return criada.body.noteId as string;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(gerente.companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function tituloDaNota(noteId: string): { id: string; amount_cents: number; settled_cents: number; status: string; note: string | null; cancelled_at: string | null } {
  return getConnection()
    .prepare(
      `SELECT id, amount_cents, settled_cents, status, note, cancelled_at FROM core_finance_entries
        WHERE company_id = ? AND origin_id = ? AND direction = 'out'`,
    )
    .get(gerente.companyId, noteId) as never;
}

function devolver(s: Sessao, body: Record<string, unknown>) {
  return request(app).post('/api/v1/core/purchases/supplier-returns').set(s.auth).send(body);
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente-devolucao', 'gerente_loja');
});

describe('GAP-PRD-089 — o que dá para devolver', () => {
  it('a nota recebida diz, por produto, o que entrou, o disponível e o limite', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }]);

    const res = await request(app).get(`/api/v1/core/purchases/notes/${nota}/devolviveis`).set(gerente.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.nota).toMatchObject({ status: 'recebida', totalCents: 25000 });
    expect(res.body.itens).toHaveLength(1);
    expect(res.body.itens[0]).toMatchObject({
      productId: pastilha,
      entrou: 10,
      jaDevolvido: 0,
      disponivel: 10,
      podeDevolver: 10,
      unitCostCents: 2500,
      serializado: false,
    });
    expect(res.body.saldoEmAbertoCents).toBe(25000);
    expect(res.body.temTitulo).toBe(true);
  });
});

describe('GAP-PRD-089 — devolver parte de uma compra', () => {
  it('ABATIMENTO: estoque sai com kind próprio e o título em aberto diminui — sem baixa fingida', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }]);

    const res = await devolver(gerente, {
      noteId: nota,
      reason: 'Duas pastilhas com defeito de fábrica',
      financeMode: 'abatimento',
      items: [{ productId: pastilha, quantity: 2 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      number: 1,
      goodsCents: 5000,
      creditCents: 5000,
      financeMode: 'abatimento',
      fiscalStatus: 'pendente',
    });
    expect(res.body.items).toEqual([
      expect.objectContaining({ productId: pastilha, quantity: 2, unitCostCents: 2500, totalCents: 5000 }),
    ]);
    // Compra sem nota fiscal: a pendência fiscal manda perguntar ao contador.
    expect(res.body.pendenciaFiscal).toContain('contador');

    // Estoque: 10 − 2, pela saída de referência própria, com custo e motivo.
    expect(saldo(pastilha)).toBe(8);
    const mov = getConnection()
      .prepare(
        `SELECT movement_type, kind, quantity, unit_cost_cents, reason, reference_type
           FROM core_stock_movements WHERE product_id = ? AND kind = 'SUPPLIER_RETURN'`,
      )
      .get(pastilha) as Record<string, unknown>;
    expect(mov).toMatchObject({
      movement_type: 'out',
      quantity: -2,
      unit_cost_cents: 2500,
      reason: 'Duas pastilhas com defeito de fábrica',
      reference_type: 'devolucao_fornecedor',
    });

    // Financeiro: o título caiu de 250 para 200 — sem baixa (nada de pagamento inventado).
    const titulo = tituloDaNota(nota);
    expect(titulo.amount_cents).toBe(20000);
    expect(titulo.settled_cents).toBe(0);
    expect(titulo.status).toBe('open');
    expect(titulo.note).toContain('devolução #1');
    const baixas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_finance_settlements WHERE entry_id = ?')
      .get(titulo.id) as { n: number };
    expect(baixas.n).toBe(0);
    expect(res.body.financeDetail).toEqual([
      expect.objectContaining({ entryId: titulo.id, abatidoCents: 5000, antesCents: 25000, depoisCents: 20000 }),
    ]);

    // A trilha registra o gesto.
    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'purchase.supplier_return.created'")
      .get() as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({ number: 1, financeMode: 'abatimento', creditCents: 5000 });

    // O histórico nomeia o fato.
    const kinds = await request(app).get('/api/v1/core/stock/movement-kinds').set(gerente.auth);
    expect(kinds.body.items).toContainEqual({ kind: 'SUPPLIER_RETURN', label: 'Devolução ao fornecedor' });
  });

  it('CRÉDITO: nota já paga e parcialmente vendida vira título a receber do fornecedor, com origem rotulada', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }]);
    // Paga inteira.
    const titulo = tituloDaNota(nota);
    expect(
      (await request(app).post(`/api/v1/core/finance/entries/${titulo.id}/settle`).set(gerente.auth).send({ amountCents: 25000 })).status,
    ).toBe(200);
    // E parte vendida (saída manual com motivo, para o teste não depender do PDV).
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerente.auth)
      .send({ productId: pastilha, movementType: 'out', quantity: 6, referenceId: 'venda-simulada', reason: 'vendidas' });
    expect(saldo(pastilha)).toBe(4);

    // Abater de dívida paga é recusa com o caminho.
    const abater = await devolver(gerente, {
      noteId: nota, reason: 'Defeito', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }],
    });
    expect(abater.status).toBe(409);
    expect(abater.body.error.code).toBe('CORE_SUPPLIER_RETURN_OPEN_BALANCE');
    expect(saldo(pastilha)).toBe(4);

    // Mais do que o disponível hoje é recusa nomeada.
    const demais = await devolver(gerente, {
      noteId: nota, reason: 'Defeito', financeMode: 'credito', items: [{ productId: pastilha, quantity: 5 }],
    });
    expect(demais.status).toBe(409);
    expect(demais.body.error.code).toBe('CORE_SUPPLIER_RETURN_INVALID_ITEMS');
    expect(demais.body.error.message).toContain('só 4 livre(s)');

    const res = await devolver(gerente, {
      noteId: nota,
      reason: 'Uma com defeito',
      financeMode: 'credito',
      creditCents: 2750, // o fornecedor devolve também o frete daquela parte
      dueDate: '2026-10-15',
      items: [{ productId: pastilha, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ goodsCents: 2500, creditCents: 2750, financeMode: 'credito' });
    expect(saldo(pastilha)).toBe(3);

    // O crédito é um título a RECEBER do fornecedor, com origem própria e rótulo navegável.
    const lista = await request(app)
      .get(`/api/v1/core/finance/entries?direction=in`)
      .set(gerente.auth);
    const credito = lista.body.items.find((e: { originType: string }) => e.originType === 'devolucao_fornecedor');
    expect(credito).toMatchObject({
      amountCents: 2750,
      dueDate: '2026-10-15',
      originId: res.body.id,
      originLabel: 'Devolução ao fornecedor #1 — Distribuidora Freio Bom',
      counterpartyName: 'Distribuidora Freio Bom',
    });
    // O pagamento antigo não foi tocado.
    expect(tituloDaNota(nota)).toMatchObject({ amount_cents: 25000, settled_cents: 25000 });
  });

  it('o limite é o que a nota pôs menos o que já voltou; o crédito somado não passa do total da nota', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 4, unitCostCents: 1000 }]);

    expect((await devolver(gerente, { noteId: nota, reason: 'Sobra', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 3 }] })).status).toBe(201);
    const demais = await devolver(gerente, {
      noteId: nota, reason: 'Sobra', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 2 }],
    });
    expect(demais.status).toBe(409);
    expect(demais.body.error.message).toContain('já voltaram 3');

    const creditoAlto = await devolver(gerente, {
      noteId: nota, reason: 'Sobra', financeMode: 'credito', creditCents: 5000, items: [{ productId: pastilha, quantity: 1 }],
    });
    expect(creditoAlto.status).toBe(409);
    expect(creditoAlto.body.error.code).toBe('CORE_SUPPLIER_RETURN_CREDIT_EXCEEDS_NOTE');
    expect(saldo(pastilha)).toBe(1);
  });

  it('devolver tudo que a nota ainda deve CANCELA o título pelo carimbo — nada de título de zero centavo', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 2, unitCostCents: 1000 }]);
    const res = await devolver(gerente, {
      noteId: nota, reason: 'Pedido errado inteiro', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 2 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const titulo = tituloDaNota(nota);
    expect(titulo.status).toBe('cancelled');
    expect(titulo.cancelled_at).toBeTruthy();
    expect(titulo.amount_cents).toBe(2000);
  });

  it('"sem efeito financeiro" só vale para nota sem dívida', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 2, unitCostCents: 1000 }]);
    const res = await devolver(gerente, {
      noteId: nota, reason: 'Defeito', financeMode: 'sem_financeiro', items: [{ productId: pastilha, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SUPPLIER_RETURN_FINANCE_REQUIRED');
    expect(saldo(pastilha)).toBe(2);
  });

  it('sem motivo, sem item, nota em conferência e nota estornada são recusas; nada sai do estoque', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 2, unitCostCents: 1000 }]);
    expect((await devolver(gerente, { noteId: nota, reason: ' ', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }] })).status).toBe(400);
    expect((await devolver(gerente, { noteId: nota, reason: 'Defeito', financeMode: 'abatimento', items: [] })).status).toBe(400);

    const emConferencia = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(gerente.auth)
      .send({ supplierId: f, items: [{ productId: pastilha, quantity: 1, unitCostCents: 1000 }] });
    const r = await devolver(gerente, {
      noteId: emConferencia.body.noteId, reason: 'Defeito', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_NOTE_NOT_RECEIVED');
    expect(saldo(pastilha)).toBe(2);
  });
});

describe('GAP-PRD-089 — a devolução e o estorno não se atropelam', () => {
  it('nota com devolução não pode mais ser estornada', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 5, unitCostCents: 1000 }]);
    await devolver(gerente, { noteId: nota, reason: 'Defeito', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }] });

    const estorno = await request(app)
      .post(`/api/v1/core/purchases/notes/${nota}/estornar`)
      .set(gerente.auth)
      .send({ reason: 'Tentativa de desfazer tudo' });
    expect(estorno.status).toBe(409);
    expect(estorno.body.error.code).toBe('CORE_NOTE_HAS_SUPPLIER_RETURN');
    expect(saldo(pastilha)).toBe(4);
  });
});

describe('GAP-PRD-089 — o gancho fiscal', () => {
  function chaveValida(modelo = '55'): string {
    const base43 = `43260911222333000181${modelo}001000000123100000012`.slice(0, 43);
    return base43 + accessKeyCheckDigit(base43);
  }

  it('devolução de NF-e nasce pendente, com a finalidade e a chave da nota de entrada na frase', async () => {
    const CHAVE = '35240114200166000187550010000000015123456789';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe Id="NFe${CHAVE}" versao="4.00">
  <ide><nNF>1024</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
  <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora de Pecas Ltda</xNome></emit>
  <det nItem="1"><prod><cProd>FORN-001</cProd><cEAN>7891234567895</cEAN>
    <xProd>Filtro de oleo</xProd><NCM>84212300</NCM><CFOP>5102</CFOP>
    <uCom>UN</uCom><qCom>10</qCom><vUnCom>25.00</vUnCom><vProd>250.00</vProd></prod></det>
  <total><ICMSTot><vNF>250.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;
    const noteId = importNfe({ companyId: gerente.companyId, userId: 'u-1', xml }).noteId;
    confirmNfe({ companyId: gerente.companyId, noteId, userId: 'u-1', createMissing: true });
    const itens = await request(app).get(`/api/v1/core/purchases/notes/${noteId}/devolviveis`).set(gerente.auth);
    const filtro = itens.body.itens[0].productId as string;

    const res = await devolver(gerente, {
      noteId, reason: 'Filtro amassado', financeMode: 'abatimento', items: [{ productId: filtro, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.noteLabel).toBe('NF-e 1024');
    expect(res.body.pendenciaFiscal).toContain('finalidade 4');
    expect(res.body.pendenciaFiscal).toContain(CHAVE);

    // A chave da própria nota de ENTRADA não serve como chave da devolução.
    const mesma = await request(app)
      .post(`/api/v1/core/purchases/supplier-returns/${res.body.id}/fiscal`)
      .set(gerente.auth)
      .send({ status: 'emitida', accessKey: CHAVE });
    expect(mesma.status).toBe(400);
  });

  it('só resolve com chave válida de NF-e, nota do fornecedor ou dispensa justificada', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 5, unitCostCents: 1000 }]);
    const dev = await devolver(gerente, { noteId: nota, reason: 'Defeito', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }] });
    const url = `/api/v1/core/purchases/supplier-returns/${dev.body.id}/fiscal`;

    const invalida = await request(app).post(url).set(gerente.auth).send({ status: 'emitida', accessKey: '123' });
    expect(invalida.status).toBe(400);
    expect(invalida.body.error.code).toBe('CORE_SUPPLIER_RETURN_ACCESS_KEY');

    const modelo65 = await request(app).post(url).set(gerente.auth).send({ status: 'emitida', accessKey: chaveValida('65') });
    expect(modelo65.status).toBe(400);

    const semJustificativa = await request(app).post(url).set(gerente.auth).send({ status: 'dispensada' });
    expect(semJustificativa.status).toBe(400);

    const ok = await request(app).post(url).set(gerente.auth).send({ status: 'emitida', accessKey: chaveValida() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ fiscalStatus: 'emitida', fiscalAccessKey: chaveValida(), pendenciaFiscal: null });

    // A lista filtra o que ainda está pendente.
    const pendentes = await request(app).get('/api/v1/core/purchases/supplier-returns?fiscalStatus=pendente').set(gerente.auth);
    expect(pendentes.body.items).toEqual([]);
  });
});

describe('GAP-PRD-089 — quem registra, quem lê, e a outra empresa', () => {
  it('estoquista lê mas não registra; atendente não lê; outra empresa não acha', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha de freio');
    const nota = await compraRecebida(f, [{ productId: pastilha, quantity: 5, unitCostCents: 1000 }]);
    const dev = await devolver(gerente, { noteId: nota, reason: 'Defeito', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }] });

    const estoquista = await entrar('estoq-dev', 'estoquista');
    expect((await request(app).get('/api/v1/core/purchases/supplier-returns').set(estoquista.auth)).status).toBe(200);
    expect((await request(app).get(`/api/v1/core/purchases/supplier-returns/${dev.body.id}`).set(estoquista.auth)).status).toBe(200);
    expect((await devolver(estoquista, { noteId: nota, reason: 'x y z', financeMode: 'abatimento', items: [{ productId: pastilha, quantity: 1 }] })).status).toBe(403);

    const atendente = await entrar('atend-dev', 'atendente');
    expect((await request(app).get('/api/v1/core/purchases/supplier-returns').set(atendente.auth)).status).toBe(403);

    const outra = await entrar('ger-outra-dev', 'gerente_loja', 'outra-loja-dev');
    expect((await request(app).get(`/api/v1/core/purchases/supplier-returns/${dev.body.id}`).set(outra.auth)).status).toBe(404);
    expect((await request(app).get(`/api/v1/core/purchases/notes/${nota}/devolviveis`).set(outra.auth)).status).toBe(404);
    const lista = await request(app).get('/api/v1/core/purchases/supplier-returns').set(outra.auth);
    expect(lista.body.items).toEqual([]);
  });
});
