/**
 * A DEVOLUÇÃO DA PREÇO JUSTO EM DUAS ETAPAS — mercadoria, estoque, reembolso,
 * caixa, fechamento, auditoria e fiscal coerentes entre si.
 *
 * Antes, o registro da devolução dava o dinheiro por devolvido no próprio ato,
 * num meio só: "PIX" e "estorno no cartão" eram gravados como feitos sem que
 * ninguém tivesse feito nada, e a tela só DIZIA "devolva R$ X ao cliente". Na
 * Preço Justo agora são duas etapas:
 *
 *   1. a MERCADORIA — itens, quantidade, motivo, condição e se volta ao estoque
 *      disponível (estoque movimentado uma vez, no máximo);
 *   2. o REEMBOLSO — registrado depois, pelo que de fato aconteceu, em uma ou
 *      mais parcelas: dinheiro (sai da gaveta e baixa o esperado), PIX feito
 *      pela conta, estorno feito na maquininha. Pendente, parcial, concluído.
 *
 * O fiscal é um terceiro estado, e as outras operações continuam no fluxo de
 * antes. Todos os casos usam SÓ a Preço Justo (a Gringa aparece uma vez, para
 * provar que ficou como estava).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import {
  ativarDevolucaoEmDuasEtapasNaPrecoJusto,
  fluxoDaDevolucao,
} from '../src/services/core/SalePolicyService.js';

const app = createApp();
const PJ = 'preco-justo';

type Auth = { Authorization: string };
let gestor: Auth;
let caixa: Auth;
let gaveta: string;

async function entrar(userId: string, companyId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function abrirCaixa(quem: Auth, fundoCents: number): Promise<string> {
  const ab = await request(app).post('/api/v1/core/cash/open').set(quem).send({ openingCents: fundoCents });
  expect(ab.status, JSON.stringify(ab.body)).toBe(201);
  return String(ab.body.id ?? ab.body.session?.id);
}

beforeEach(async () => {
  resetDbForTests();
  gestor = await entrar('admin-preco-justo', PJ, 'gerente_loja');
  caixa = await entrar('caixa-preco-justo', PJ, 'operador_caixa_loja');
  // A subida liga a Preço Justo; aqui a empresa nasceu depois dela.
  expect(ativarDevolucaoEmDuasEtapasNaPrecoJusto()).toBe(true);
  gaveta = await abrirCaixa(caixa, 20000);
});

async function produto(nome: string, precoCents: number, quantidade = 10, quem: Auth = gestor): Promise<string> {
  const p = await request(app).post('/api/v1/core/products').set(quem).send({ name: nome, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const e = await request(app).post('/api/v1/core/stock/movements').set(quem).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
    unitCostCents: 1000,
  });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  return String(p.body.id);
}

async function vender(
  itens: { productId: string; quantity: number }[],
  pagamentos: { method: string; amountCents: number }[],
  quem: Auth = caixa,
  cashSessionId: string | null = gaveta,
): Promise<{ id: string; number: number; total_cents: number }> {
  const r = await request(app)
    .post('/api/v1/core/sales')
    .set(quem)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: itens,
      payments: pagamentos.map((p) => ({ ...p, status: 'settled' })),
      cashSessionId,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.sale ?? r.body) as { id: string; number: number; total_cents: number };
}

async function devolvivel(saleId: string, quem: Auth = gestor) {
  const r = await request(app).get(`/api/v1/core/sales/${saleId}/returnable`).set(quem);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    fluxo: string;
    venda: Record<string, unknown> & { devolucoes: Record<string, unknown>[]; fiscal: { estado: string } };
    items: { sale_item_id: string; quantity: number; returned_quantity: number; unit_price_cents: number }[];
  };
}

function devolver(
  saleId: string,
  itens: { saleItemId: string; quantity: number; restock?: boolean; condition?: string }[],
  opcoes: { reasonCode?: string; reasonNote?: string; chave?: string; quem?: Auth } = {},
) {
  return request(app)
    .post('/api/v1/core/sale-returns')
    .set(opcoes.quem ?? gestor)
    .set('Idempotency-Key', opcoes.chave ?? randomUUID())
    .send({
      saleId,
      reasonCode: opcoes.reasonCode ?? 'desistencia',
      reasonNote: opcoes.reasonNote,
      items: itens.map((i) => ({ restock: true, ...i })),
    });
}

function reembolsar(returnId: string, corpo: Record<string, unknown>, chave: string = randomUUID(), quem: Auth = gestor) {
  return request(app)
    .post(`/api/v1/core/sale-returns/${returnId}/refunds`)
    .set(quem)
    .set('Idempotency-Key', chave)
    .send(corpo);
}

async function esperadoNaGaveta(quem: Auth = caixa): Promise<number> {
  const r = await request(app).get(`/api/v1/core/cash/${gaveta}/summary`).set(quem);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Number(r.body.expectedCents);
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(PJ, productId) as { quantity: number } | undefined;
  return Number(row?.quantity ?? 0);
}

function movimentosDaDevolucao(productId: string): number {
  return Number(
    (
      getConnection()
        .prepare(
          `SELECT COUNT(*) AS n FROM core_stock_movements
            WHERE company_id = ? AND product_id = ? AND reference_type = 'sale_return'`,
        )
        .get(PJ, productId) as { n: number }
    ).n,
  );
}

function linhas(sql: string, ...args: unknown[]): Record<string, unknown>[] {
  return getConnection().prepare(sql).all(...(args as string[])) as unknown as Record<string, unknown>[];
}

describe('só a Preço Justo foi ligada', () => {
  it('a Preço Justo devolve em duas etapas; a Gringa continua no fluxo imediato', async () => {
    await entrar('gerente-gringa', 'gringa', 'gerente_loja');
    ativarDevolucaoEmDuasEtapasNaPrecoJusto();
    expect(fluxoDaDevolucao(PJ)).toBe('duas_etapas');
    expect(fluxoDaDevolucao('gringa')).toBe('imediato');
  });

  it('na Gringa a devolução segue dando o dinheiro por devolvido no ato, e não aceita reembolso à parte', async () => {
    const gringa = await entrar('gerente-gringa', 'gringa', 'gerente_loja');
    const p = await produto('Blusa', 5000, 5, gringa);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'pix', amountCents: 5000 }], gringa, null);
    const itens = (await devolvivel(v.id, gringa)).items;
    const d = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(gringa)
      .send({ saleId: v.id, reason: 'Não serviu', refundMethod: 'pix', items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.reembolso.fluxo).toBe('imediato');
    expect(d.body.reembolso.situacao).toBe('concluido');
    const recusa = await reembolsar(d.body.id, { method: 'pix', amountCents: 5000 }, randomUUID(), gringa);
    expect(recusa.status).toBe(409);
    expect(recusa.body.error.code).toBe('CORE_RETURN_REFUND_NOT_PENDING');
  });
});

describe('A/H/P — devolução total em dinheiro: a mercadoria volta ao estoque uma vez, o dinheiro sai da gaveta no reembolso', () => {
  it('a devolução registra a mercadoria e deixa o reembolso PENDENTE; o registro do dinheiro conclui', async () => {
    const p = await produto('Panela', 3000, 10);
    const v = await vender([{ productId: p, quantity: 2 }], [{ method: 'dinheiro', amountCents: 6000 }]);
    expect(saldo(p)).toBe(8);
    const antesDaDevolucao = await esperadoNaGaveta();
    const { items } = await devolvivel(v.id);

    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 2 }]);
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.total_cents).toBe(6000);
    expect(d.body.mercadoria).toEqual({ situacao: 'concluida', estoque: 'retornou' });
    expect(d.body.reembolso).toMatchObject({
      fluxo: 'duas_etapas',
      devolvivelCents: 6000,
      reembolsadoCents: 0,
      pendenteCents: 6000,
      situacao: 'pendente',
    });
    // H: voltou ao estoque disponível — uma vez.
    expect(saldo(p)).toBe(10);
    expect(movimentosDaDevolucao(p)).toBe(1);
    // Nada saiu da gaveta nem do financeiro ainda: ninguém entregou dinheiro.
    expect(await esperadoNaGaveta()).toBe(antesDaDevolucao);
    expect(linhas("SELECT id FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?", d.body.id)).toHaveLength(0);

    const r = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 6000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.reembolso).toMatchObject({ reembolsadoCents: 6000, pendenteCents: 0, situacao: 'concluido' });
    // R: o dinheiro devolvido baixa o esperado do fechamento.
    expect(await esperadoNaGaveta()).toBe(antesDaDevolucao - 6000);
    // Saída real da gaveta, VINCULADA ao reembolso — não uma sangria genérica.
    const mov = linhas(
      `SELECT movement_type, amount_cents, reference_type, reference_id, note, user_id FROM core_cash_movements
        WHERE session_id = ? AND reference_type = 'sale_return_refund'`,
      gaveta,
    );
    expect(mov).toHaveLength(1);
    expect(mov[0]).toMatchObject({ movement_type: 'sale_return', amount_cents: -6000, reference_id: r.body.refundId });
    expect(String(mov[0].note)).toContain('DEVOLUÇÃO AO CLIENTE');
    // Saída financeira no meio certo, vinculada à devolução.
    const fin = linhas(
      "SELECT direction, amount_cents, status, payment_method FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?",
      d.body.id,
    );
    expect(fin).toEqual([expect.objectContaining({ direction: 'out', amount_cents: 6000, status: 'settled', payment_method: 'dinheiro' })]);
    // Q: o reembolso não mexe no estoque.
    expect(saldo(p)).toBe(10);
    expect(movimentosDaDevolucao(p)).toBe(1);
  });
});

describe('B/J/K — devolução parcial e o saldo devolvível', () => {
  it('3 × R$ 30,00, devolve 1: R$ 30,00; comprou 3, devolveu 2, só pode mais 1', async () => {
    const p = await produto('Copo', 3000, 10);
    const v = await vender([{ productId: p, quantity: 3 }], [{ method: 'dinheiro', amountCents: 9000 }]);
    const { items } = await devolvivel(v.id);
    const item = items[0].sale_item_id;

    const d1 = await devolver(v.id, [{ saleItemId: item, quantity: 1 }]);
    expect(d1.status, JSON.stringify(d1.body)).toBe(201);
    expect(d1.body.total_cents).toBe(3000);

    const d2 = await devolver(v.id, [{ saleItemId: item, quantity: 1 }]);
    expect(d2.status).toBe(201);
    // K: acima do que resta é recusado no servidor.
    const acima = await devolver(v.id, [{ saleItemId: item, quantity: 2 }]);
    expect(acima.status).toBe(409);
    expect(acima.body.error.code).toBe('CORE_RETURN_EXCEEDS_SOLD');

    const depois = await devolvivel(v.id);
    expect(depois.items[0].returned_quantity).toBe(2);
    expect(depois.venda.devolucoes).toHaveLength(2);
  });

  it('o valor é o histórico pago, com o desconto rateado — não o preço de hoje', async () => {
    const p = await produto('Jarra', 5000, 10);
    const v = await vender([{ productId: p, quantity: 2 }], [{ method: 'dinheiro', amountCents: 10000 }]);
    // O cadastro sobe depois da venda: a devolução continua pelo preço pago.
    await request(app).put(`/api/v1/core/products/${p}`).set(gestor).send({ priceCents: 9000 });
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.total_cents).toBe(5000);
  });
});

describe('I — mercadoria avariada não volta ao estoque disponível', () => {
  it('avariado com "não volta": estoque não sobe; avariado marcado para voltar é recusado; sem condição é recusado', async () => {
    const p = await produto('Liquidificador', 12000, 5);
    const v = await vender([{ productId: p, quantity: 2 }], [{ method: 'dinheiro', amountCents: 24000 }]);
    const { items } = await devolvivel(v.id);
    const item = items[0].sale_item_id;
    expect(saldo(p)).toBe(3);

    const paraVoltar = await devolver(v.id, [{ saleItemId: item, quantity: 1, restock: true, condition: 'quebrado' }]);
    expect(paraVoltar.status).toBe(409);
    expect(paraVoltar.body.error.code).toBe('CORE_RETURN_DAMAGED_TO_STOCK');

    const semCondicao = await devolver(v.id, [{ saleItemId: item, quantity: 1, restock: false }]);
    expect(semCondicao.status).toBe(400);
    expect(semCondicao.body.error.code).toBe('CORE_RETURN_CONDITION_REQUIRED');

    const d = await devolver(v.id, [{ saleItemId: item, quantity: 1, restock: false, condition: 'avariado' }], {
      reasonCode: 'defeito',
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.mercadoria.estoque).toBe('nao_retornou');
    expect(d.body.items[0]).toMatchObject({ restock: 0, item_condition: 'avariado' });
    expect(saldo(p)).toBe(3);
    expect(movimentosDaDevolucao(p)).toBe(0);
  });

  it('motivo "outro" exige observação', async () => {
    const p = await produto('Tigela', 2000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 2000 }]);
    const { items } = await devolvivel(v.id);
    const sem = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }], { reasonCode: 'outro' });
    expect(sem.status).toBe(400);
    expect(sem.body.error.code).toBe('CORE_RETURN_REASON_NOTE_REQUIRED');
    const com = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }], {
      reasonCode: 'outro',
      reasonNote: 'Cliente comprou em dobro',
    });
    expect(com.status).toBe(201);
    expect(com.body).toMatchObject({ reason_code: 'outro', reason_note: 'Cliente comprou em dobro', reason: 'Outro — Cliente comprou em dobro' });
  });
});

describe('C/D/S — PIX e cartão: confirmação do que foi feito fora, sem mexer no dinheiro da gaveta', () => {
  it('PIX: pendente até o registro; o registro guarda referência e não baixa o esperado', async () => {
    const p = await produto('Fone', 8000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'pix', amountCents: 8000 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    expect(d.body.reembolso.situacao).toBe('pendente');
    expect(d.body.reembolso.sugestao).toEqual([{ method: 'pix', cents: 8000 }]);
    const antes = await esperadoNaGaveta();

    const r = await reembolsar(d.body.id, { method: 'pix', amountCents: 8000, reference: 'E2E-PIX-778899', note: 'Chave CPF do cliente' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.reembolso.situacao).toBe('concluido');
    expect(r.body.reembolso.registros[0]).toMatchObject({ method: 'pix', amount_cents: 8000, reference: 'E2E-PIX-778899', cash_session_id: null });
    expect(await esperadoNaGaveta()).toBe(antes);
    const baixa = linhas(
      `SELECT s.method FROM core_finance_settlements s JOIN core_finance_entries e ON e.id = s.entry_id
        WHERE e.origin_type = 'sale_return' AND e.origin_id = ?`,
      d.body.id,
    );
    expect(baixa).toEqual([{ method: 'pix' }]);
  });

  it('cartão: sem TEF nada é pedido a ninguém; o registro é a confirmação do estorno na maquininha, com NSU', async () => {
    const p = await produto('Mixer', 15000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'credito', amountCents: 15000 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    expect(d.body.reembolso.sugestao).toEqual([{ method: 'credito', cents: 15000 }]);
    const antes = await esperadoNaGaveta();
    const r = await reembolsar(d.body.id, { method: 'credito', amountCents: 15000, reference: 'NSU 004512' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estornosNaMaquininha).toEqual([]);
    expect(r.body.reembolso.situacao).toBe('concluido');
    expect(r.body.reembolso.registros[0]).toMatchObject({ method: 'credito', reference: 'NSU 004512' });
    expect(await esperadoNaGaveta()).toBe(antes);
  });
});

describe('E/F/G/L — pagamento misto, reembolso parcial e o saldo pendente', () => {
  it('R$ 100 dinheiro + R$ 100 PIX: reconhece as duas parcelas e nunca passa do devolvível', async () => {
    const p = await produto('Ventilador', 20000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [
      { method: 'dinheiro', amountCents: 10000 },
      { method: 'pix', amountCents: 10000 },
    ]);
    const { items, venda } = await devolvivel(v.id);
    expect(venda.payments).toEqual([
      expect.objectContaining({ method: 'dinheiro', amount_cents: 10000 }),
      expect.objectContaining({ method: 'pix', amount_cents: 10000 }),
    ]);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    expect(d.body.reembolso.sugestao).toEqual([
      { method: 'dinheiro', cents: 10000 },
      { method: 'pix', cents: 10000 },
    ]);

    // PIX além do que entrou em PIX é outro meio: precisa de justificativa.
    const alem = await reembolsar(d.body.id, { method: 'pix', amountCents: 15000 });
    expect(alem.status).toBe(400);
    expect(alem.body.error.code).toBe('CORE_REFUND_METHOD_JUSTIFICATION_REQUIRED');

    const a = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 10000 });
    expect(a.body.reembolso).toMatchObject({ situacao: 'parcial', reembolsadoCents: 10000, pendenteCents: 10000 });
    // L: acima do pendente é recusado.
    const demais = await reembolsar(d.body.id, { method: 'pix', amountCents: 10001 });
    expect(demais.status).toBe(409);
    expect(demais.body.error.code).toBe('CORE_REFUND_EXCEEDS_PENDING');
    const b = await reembolsar(d.body.id, { method: 'pix', amountCents: 10000 });
    expect(b.status).toBe(201);
    expect(b.body.reembolso).toMatchObject({ situacao: 'concluido', reembolsadoCents: 20000, pendenteCents: 0 });
    const concluido = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 1 });
    expect(concluido.status).toBe(409);
    expect(concluido.body.error.code).toBe('CORE_REFUND_ALREADY_DONE');
  });

  it('R$ 300 a devolver, R$ 200 entregues: PARCIAL com R$ 100 pendentes, e os R$ 100 depois concluem', async () => {
    const p = await produto('Micro-ondas', 30000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 30000 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    const r1 = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 20000 });
    expect(r1.body.reembolso).toMatchObject({ reembolsadoCents: 20000, pendenteCents: 10000, situacao: 'parcial' });
    const lista = await request(app).get('/api/v1/core/sale-returns').query({ saleId: v.id }).set(gestor);
    expect(lista.body.items[0].reembolso).toMatchObject({ situacao: 'parcial', pendenteCents: 10000 });
    const r2 = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 10000 });
    expect(r2.body.reembolso).toMatchObject({ reembolsadoCents: 30000, pendenteCents: 0, situacao: 'concluido' });
  });

  it('meio diferente do original: só com justificativa, e o registro guarda o meio original e quem decidiu', async () => {
    const p = await produto('Chaleira', 7000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 7000 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    const r = await reembolsar(d.body.id, {
      method: 'pix',
      amountCents: 7000,
      justification: 'Cliente pediu PIX, a gaveta estava sem troco',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.reembolso.registros[0]).toMatchObject({
      method: 'pix',
      original_method: 'dinheiro R$ 70,00',
      method_justification: 'Cliente pediu PIX, a gaveta estava sem troco',
      created_by_name: expect.any(String),
    });
  });
});

describe('M/N/O — duplicidade bloqueada no servidor', () => {
  it('duplo clique no reembolso: um registro, uma saída da gaveta, um lançamento', async () => {
    const p = await produto('Batedeira', 9000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 9000 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    const chave = randomUUID();
    const corpo = { method: 'dinheiro', amountCents: 9000 };
    const [a, b] = await Promise.all([reembolsar(d.body.id, corpo, chave), reembolsar(d.body.id, corpo, chave)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(linhas('SELECT id FROM core_sale_return_refunds WHERE return_id = ?', d.body.id)).toHaveLength(1);
    expect(linhas("SELECT id FROM core_cash_movements WHERE reference_type = 'sale_return_refund'")).toHaveLength(1);
    expect(linhas("SELECT id FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?", d.body.id)).toHaveLength(1);
    // O: a mesma chave com outro pedido é recusada, sem gravar nada.
    const outra = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 100 }, chave);
    expect(outra.status).toBe(422);
    expect(outra.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    // Sem chave, o registro não sai.
    const semChave = await request(app).post(`/api/v1/core/sale-returns/${d.body.id}/refunds`).set(gestor).send(corpo);
    expect(semChave.status).toBe(400);
    expect(semChave.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REQUIRED');
  });

  it('duplo ENTER na devolução: uma devolução, o estoque sobe uma vez; o reenvio devolve a mesma', async () => {
    const p = await produto('Sanduicheira', 6000, 5);
    const v = await vender([{ productId: p, quantity: 2 }], [{ method: 'dinheiro', amountCents: 12000 }]);
    const { items } = await devolvivel(v.id);
    const chave = randomUUID();
    const pedido = [{ saleItemId: items[0].sale_item_id, quantity: 1 }];
    const [a, b] = await Promise.all([devolver(v.id, pedido, { chave }), devolver(v.id, pedido, { chave })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(linhas('SELECT id FROM core_sale_returns WHERE sale_id = ?', v.id)).toHaveLength(1);
    expect(saldo(p)).toBe(4);
    expect(movimentosDaDevolucao(p)).toBe(1);
    const reenvio = await devolver(v.id, pedido, { chave });
    expect(reenvio.status).toBe(200);
    expect(reenvio.body.id).toBe(a.body.id);
    expect(saldo(p)).toBe(4);
  });
});

describe('T/U — abertura só com o fundo; fechamento mostra o esperado, o contado e a diferença', () => {
  it('fundo 200 + vendas 1.000 − devolução 100 − sangria 200 = esperado 900; contado 890 = falta 10, na auditoria', async () => {
    // U: a abertura pediu só o fundo (beforeEach) — e ele é o ponto de partida.
    const aberta = await request(app).get('/api/v1/core/cash/open').set(caixa);
    expect(aberta.body.session).toMatchObject({ id: gaveta, opening_cents: 20000, status: 'open' });

    const grande = await produto('Geladeira', 90000, 2);
    const pequeno = await produto('Filtro', 10000, 5);
    const v = await vender(
      [
        { productId: grande, quantity: 1 },
        { productId: pequeno, quantity: 1 },
      ],
      [{ method: 'dinheiro', amountCents: 100000 }],
    );
    const { items } = await devolvivel(v.id);
    const filtro = items.find((i) => i.unit_price_cents === 10000)!;
    const d = await devolver(v.id, [{ saleItemId: filtro.sale_item_id, quantity: 1 }]);
    await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 10000 });
    const sangria = await request(app)
      .post(`/api/v1/core/cash/${gaveta}/movements`)
      .set(caixa)
      .send({ movementType: 'withdrawal', amountCents: 20000, note: 'Sangria para o cofre' });
    expect(sangria.status, JSON.stringify(sangria.body)).toBe(201);

    // T: o operador VÊ o esperado antes de contar.
    expect(await esperadoNaGaveta(caixa)).toBe(90000);

    const fechado = await request(app).post(`/api/v1/core/cash/${gaveta}/close`).set(caixa).send({ countedCents: 89000 });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(200);
    expect(fechado.body).toMatchObject({ expected_cents: 90000, counted_cents: 89000, difference_cents: -1000 });
    const trilha = linhas("SELECT action FROM core_audit_log WHERE company_id = ? AND action = 'cash.close'", PJ);
    expect(trilha).toHaveLength(1);
  });
});

describe('V — permissões da Preço Justo', () => {
  it('o login do caixa (PREÇO JUSTO) consulta, mas não registra devolução nem reembolso: 403', async () => {
    const p = await produto('Garrafa', 4000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 4000 }]);
    const { items } = await devolvivel(v.id, caixa);
    const peloCaixa = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }], { quem: caixa });
    expect(peloCaixa.status).toBe(403);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    const reembolsoPeloCaixa = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 4000 }, randomUUID(), caixa);
    expect(reembolsoPeloCaixa.status).toBe(403);
    expect(saldo(p)).toBe(5);
    expect(linhas('SELECT id FROM core_sale_return_refunds')).toHaveLength(0);
  });

  it('o gestor de outra operação não alcança a devolução da Preço Justo', async () => {
    const p = await produto('Pote', 1500, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 1500 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    const outraLoja = await entrar('gerente-gringa', 'gringa', 'gerente_loja');
    const r = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 1500 }, randomUUID(), outraLoja);
    expect(r.status).toBe(404);
  });
});

describe('W/X — auditoria e fiscal separado', () => {
  it('a trilha guarda a devolução e cada reembolso; a ficha mostra quem registrou e quem aprovou', async () => {
    const p = await produto('Frigideira', 5000, 5);
    const v = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 5000 }]);
    const { items } = await devolvivel(v.id);
    const d = await devolver(v.id, [{ saleItemId: items[0].sale_item_id, quantity: 1, restock: false, condition: 'defeituoso' }], {
      reasonCode: 'defeito',
    });
    await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 2000 });
    const ficha = await request(app).get(`/api/v1/core/sale-returns/${d.body.id}`).set(gestor);
    expect(ficha.body.approved_by_name).toBeTruthy();
    expect(ficha.body.created_by_name).toBeTruthy();
    expect(ficha.body.reembolso.registros).toHaveLength(1);

    const trilha = linhas(
      "SELECT action, detail FROM core_audit_log WHERE company_id = ? AND entity_id = ? ORDER BY created_at",
      PJ,
      d.body.id,
    );
    expect(trilha.map((t) => t.action)).toEqual(['sale_returns.created', 'sale_returns.refund_registered']);
    const criada = JSON.parse(String(trilha[0].detail));
    expect(criada).toMatchObject({ saleId: v.id, motivo: 'Defeito', devolvivelCents: 5000, fluxo: 'duas_etapas' });
    expect(criada.itens[0]).toMatchObject({ voltouAoEstoque: false, condicao: 'defeituoso' });
    const reembolso = JSON.parse(String(trilha[1].detail));
    expect(reembolso).toMatchObject({ method: 'dinheiro', amountCents: 2000, situacaoDepois: 'parcial', pendenteDepoisCents: 3000 });
  });

  it('venda sem NFC-e: fiscal NÃO FISCAL; com NFC-e autorizada: fiscal PENDENTE DE REGULARIZAÇÃO mesmo com estoque e reembolso concluídos', async () => {
    const p = await produto('Cafeteira', 11000, 5);
    const semNota = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 11000 }]);
    expect((await devolvivel(semNota.id)).venda.fiscal.estado).toBe('nao_fiscal');

    const comNota = await vender([{ productId: p, quantity: 1 }], [{ method: 'dinheiro', amountCents: 11000 }]);
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, sale_id, model, serie, number, environment, status, created_at, updated_at)
         VALUES (?, ?, ?, '65', 1, 1, 'homologacao', 'AUTHORIZED', ?, ?)`,
      )
      .run(randomUUID(), PJ, comNota.id, new Date().toISOString(), new Date().toISOString());
    const { items } = await devolvivel(comNota.id);
    const d = await devolver(comNota.id, [{ saleItemId: items[0].sale_item_id, quantity: 1 }]);
    const r = await reembolsar(d.body.id, { method: 'dinheiro', amountCents: 11000 });
    expect(r.body.mercadoria).toEqual({ situacao: 'concluida', estoque: 'retornou' });
    expect(r.body.reembolso.situacao).toBe('concluido');
    expect(r.body.fiscal).toMatchObject({ estado: 'pendente_regularizacao', rotulo: 'PENDENTE DE REGULARIZAÇÃO' });
    // Nada fingiu cancelamento na SEFAZ: a nota continua autorizada.
    expect(linhas('SELECT status FROM core_fiscal_documents WHERE sale_id = ?', comNota.id)).toEqual([{ status: 'AUTHORIZED' }]);
  });
});
