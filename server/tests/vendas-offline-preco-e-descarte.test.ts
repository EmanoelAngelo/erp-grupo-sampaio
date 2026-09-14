/**
 * ============================================================================
 * A VENDA GUARDADA OFFLINE: O DESCARTE CONFERE A VENDA, E O PREÇO MUDADO TEM
 * SAÍDA (G-offline-sync-16 / G-offline-sync-08)
 * ============================================================================
 *
 *   16  o descarte só olhava a pendência: com a venda da chave já registrada
 *       (a cópia de outro computador subiu), o gerente "descartava" uma venda
 *       que existe — estoque baixado, dinheiro na gaveta, e a trilha dizendo o
 *       contrário. Agora é 409 `CORE_OFFLINE_SALE_ALREADY_SOLD` com o número.
 *
 *   08  a venda cobrada no cartão pelo preço antigo, com o preço baixado antes
 *       de ela subir, era recusada com `CORE_SALE_TOTAL_CHANGED` — e o
 *       relançamento repetia o mesmo corpo e a mesma recusa, para sempre. Agora
 *       o relançamento aceita `ajusteDePreco`: pelo preço de agora (o cartão
 *       cai a diferença, a devolver ao cliente) ou mantendo o cobrado (a
 *       diferença vira acréscimo — só a gerência). A decisão fica registrada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { corpoComAjusteDePreco } from '../src/services/core/VendasOfflineRecusadas.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-preco-e-descarte';

type Auth = { Authorization: string };
let gerente: Auth;
let caixa: Auth;

async function entrar(userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-preco-descarte', 'gerente_loja');
  caixa = await entrar('caixa-preco-descarte', 'operador_caixa_loja');
});

async function produto(precoCents: number, estoque: number, nome?: string): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: nome ?? `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: estoque,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  return String(p.body.id);
}

async function abrirCaixa(auth: Auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function reenviar(auth: Auth, chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(auth).set('Idempotency-Key', chave).send(corpo);
}

function entregar(auth: Auth, chave: string, corpo: Record<string, unknown>, recusa: { code: string; message: string }) {
  return request(app).post('/api/v1/core/offline-sales').set(auth).send({
    idempotencyKey: chave,
    label: 'venda do PDV',
    body: corpo,
    queuedAt: '2026-09-13T21:40:00.000Z',
    errorCode: recusa.code,
    errorMessage: recusa.message,
  });
}

function relancar(auth: Auth, id: string, corpo: Record<string, unknown> = {}) {
  return request(app).post(`/api/v1/core/offline-sales/${id}/relaunch`).set(auth).send(corpo);
}

function descartar(auth: Auth, id: string, reason: string) {
  return request(app).post(`/api/v1/core/offline-sales/${id}/discard`).set(auth).send({ reason });
}

function vendasComAChave(chave: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE idempotency_key = ?')
      .get(chave) as { n: number }
  ).n;
}

function linhaDaPendencia(id: string) {
  return getConnection()
    .prepare('SELECT status, error_code, sale_id, resolution_note FROM core_offline_sale_pendings WHERE id = ?')
    .get(id) as { status: string; error_code: string | null; sale_id: string | null; resolution_note: string | null };
}

function pagamentosDa(saleId: string) {
  return getConnection()
    .prepare('SELECT method, amount_cents FROM core_sale_payments WHERE sale_id = ? ORDER BY amount_cents')
    .all(saleId) as unknown as { method: string; amount_cents: number }[];
}

/** Simula a queda entre gravar a venda e fechar a pendência. */
function reabrirPendencia(id: string): void {
  getConnection()
    .prepare(
      `UPDATE core_offline_sale_pendings
          SET status = 'pendente', sale_id = NULL, resolved_by = NULL, resolved_at = NULL, resolution_note = NULL
        WHERE id = ?`,
    )
    .run(id);
}

// ============================================================================
describe('G-offline-sync-16 — o descarte confere se a venda já existe', () => {
  it('a venda desta pendência já subiu: o descarte é recusado com o número, e relançar fecha apontando para ela', async () => {
    const p = await produto(5000, 5);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: turno,
    };
    // Este computador entregou a venda como pendência...
    const pend = (await entregar(caixa, chave, corpo, { code: 'CORE_INSUFFICIENT_STOCK', message: 'sem estoque' })).body
      .pendencia;
    expect(pend.status).toBe('pendente');
    // ...e a cópia que seguia na fila de outro computador subiu.
    const subiu = await reenviar(caixa, chave, corpo);
    expect(subiu.status, JSON.stringify(subiu.body)).toBe(201);

    const descarte = await descartar(gerente, pend.id, 'cliente desistiu e o dinheiro foi devolvido');
    expect(descarte.status, JSON.stringify(descarte.body)).toBe(409);
    expect(descarte.body.error.code).toBe('CORE_OFFLINE_SALE_ALREADY_SOLD');
    expect(descarte.body.error.details).toMatchObject({ saleId: subiu.body.id, saleNumber: subiu.body.number });
    expect(descarte.body.error.message).toContain(`#${subiu.body.number as number}`);
    // Nada foi descartado, nem registrado como descartado.
    expect(linhaDaPendencia(pend.id).status).toBe('pendente');
    const trilha = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'sale.offline.discarded' AND entity_id = ?`)
      .get(pend.id) as { n: number };
    expect(trilha.n).toBe(0);

    // A saída que a recusa aponta: relançar devolve a venda que existe, sem vender de novo.
    const r = await relancar(caixa, pend.id, { cashSessionId: turno });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.duplicated).toBe(true);
    expect(r.body.pendencia.saleId).toBe(subiu.body.id);
    expect(vendasComAChave(chave)).toBe(1);
  });

  // Revisão: a recusa mandava "cancele a venda #N em Vendas" mesmo com a #N já
  // cancelada — o gerente que seguiu a instrução ouvia a mesma frase de novo.
  it('com a venda desta pendência já cancelada, a recusa não manda cancelar de novo: aponta o "Relançar"', async () => {
    const p = await produto(5000, 5);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: turno,
    };
    const pend = (await entregar(caixa, chave, corpo, { code: 'CORE_INSUFFICIENT_STOCK', message: 'sem estoque' })).body
      .pendencia;
    const subiu = await reenviar(caixa, chave, corpo);
    expect(subiu.status, JSON.stringify(subiu.body)).toBe(201);

    const antes = await descartar(gerente, pend.id, 'cliente desistiu e o dinheiro foi devolvido');
    expect(antes.body.error.message).toMatch(/cancele a venda #\d+ em Vendas/);
    // O gerente seguiu a recusa e cancelou a venda em Vendas.
    getConnection().prepare("UPDATE core_sales SET status = 'cancelled' WHERE id = ?").run(subiu.body.id);

    const depois = await descartar(gerente, pend.id, 'cliente desistiu e o dinheiro foi devolvido');
    expect(depois.status, JSON.stringify(depois.body)).toBe(409);
    expect(depois.body.error.code).toBe('CORE_OFFLINE_SALE_ALREADY_SOLD');
    expect(depois.body.error.details).toMatchObject({ saleId: subiu.body.id, cancelada: true });
    expect(depois.body.error.message).toMatch(/já está CANCELADA/);
    expect(depois.body.error.message).not.toMatch(/cancele a venda/);
    expect(linhaDaPendencia(pend.id).status).toBe('pendente');
  });

  it('venda de OUTRA mercadoria na chave não bloqueia o descarte (RES-IDEM-TELA segue valendo)', async () => {
    const p = await produto(5000, 10);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const primeira = await reenviar(caixa, chave, {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: turno,
    });
    expect(primeira.status).toBe(201);
    const outra = {
      items: [{ productId: p, quantity: 2, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: turno,
    };
    const recusa = await reenviar(caixa, chave, outra);
    expect(recusa.status).toBe(422);
    const pend = (await entregar(caixa, chave, outra, recusa.body.error)).body.pendencia;
    expect(pend.vendaDaChave?.number).toBe(primeira.body.number);

    const d = await descartar(gerente, pend.id, 'a venda anterior era este mesmo atendimento, conferido');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.status).toBe('descartada');
  });

  it('a venda NOVA que a pendência já fez também bloqueia o descarte', async () => {
    const p = await produto(5000, 10);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    await reenviar(caixa, chave, {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: turno,
    });
    const outra = {
      items: [{ productId: p, quantity: 2, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: turno,
    };
    const recusa = await reenviar(caixa, chave, outra);
    const pend = (await entregar(caixa, chave, outra, recusa.body.error)).body.pendencia;
    const nova = await request(app)
      .post(`/api/v1/core/offline-sales/${pend.id as string}/relaunch-as-new`)
      .set(caixa)
      .send({ cashSessionId: turno });
    expect(nova.status, JSON.stringify(nova.body)).toBe(201);

    reabrirPendencia(pend.id);
    const d = await descartar(gerente, pend.id, 'cliente desistiu e o dinheiro foi devolvido');
    expect(d.status, JSON.stringify(d.body)).toBe(409);
    expect(d.body.error.code).toBe('CORE_OFFLINE_SALE_ALREADY_SOLD');
    expect(d.body.error.details.saleNumber).toBe(nova.body.sale.number);
  });
});

// ============================================================================
describe('G-offline-sync-08 — a venda recusada pelo preço que baixou tem saída', () => {
  /** Cobrada no débito a R$ 50; a promoção de R$ 40 entrou antes de ela subir. */
  async function vendaRecusadaPeloPreco() {
    const p = await produto(5000, 5, 'Jaqueta jeans');
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'debito', amountCents: 5000 }],
      cashSessionId: turno,
    };
    getConnection().prepare('UPDATE core_products SET price_cents = 4000 WHERE id = ?').run(p);
    const reenvio = await reenviar(caixa, chave, corpo);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(409);
    expect(reenvio.body.error.code).toBe('CORE_SALE_TOTAL_CHANGED');
    const entregue = await entregar(caixa, chave, corpo, reenvio.body.error);
    expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
    return { p, turno, chave, corpo, pend: entregue.body.pendencia as { id: string } };
  }

  it('sem ajuste, relançar devolve a recusa com as linhas do servidor — é o que a tela mostra', async () => {
    const { p, chave, pend } = await vendaRecusadaPeloPreco();
    const r = await relancar(caixa, pend.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_SALE_TOTAL_CHANGED');
    expect(r.body.error.details.linhas[0]).toMatchObject({ productId: p, informadoCents: 5000, vigenteCents: 4000 });
    expect(vendasComAChave(chave)).toBe(0);
  });

  it('pelo preço de agora: a venda entra por R$ 40, o débito cai para R$ 40, e a pendência diz quanto devolver', async () => {
    const { chave, corpo, pend } = await vendaRecusadaPeloPreco();
    const r = await relancar(caixa, pend.id, { ajusteDePreco: 'preco_de_agora' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sale.total_cents).toBe(4000);
    expect(r.body.ajusteDePreco).toMatchObject({
      modo: 'preco_de_agora',
      diferencaCents: 1000,
      estornoCents: 1000,
      devolverEmDinheiroCents: 0,
    });
    expect(pagamentosDa(r.body.sale.id)).toEqual([{ method: 'debito', amount_cents: 4000 }]);
    expect(r.body.pendencia.status).toBe('regularizada');
    expect(r.body.pendencia.resolutionNote).toMatch(/Devolver R\$ 10,00 ao cliente/);
    expect(r.body.pendencia.resolutionNote).toMatch(/Jaqueta jeans/);
    const trilha = getConnection()
      .prepare(`SELECT detail FROM core_audit_log WHERE action = 'sale.offline.regularized' AND entity_id = ?`)
      .get(pend.id) as { detail: string };
    expect(JSON.parse(trilha.detail).ajusteDePreco).toMatchObject({ modo: 'preco_de_agora', diferencaCents: 1000 });

    // A cópia que ainda estava na fila do PDV sobe depois: o dinheiro mudou,
    // então é 422 — e a entrega dela aponta a venda ajustada, sem nova pendência.
    const copia = await reenviar(caixa, chave, corpo);
    expect(copia.status).toBe(422);
    const entrega = await entregar(caixa, chave, corpo, copia.body.error);
    expect(entrega.status, JSON.stringify(entrega.body)).toBe(200);
    expect(entrega.body).toMatchObject({ jaSubiu: true, saleId: r.body.sale.id });
    expect(vendasComAChave(chave)).toBe(1);
  });

  it('manter o valor cobrado é da gerência: o caixa é recusado sem apagar o motivo, e o gerente lança o acréscimo', async () => {
    const { chave, pend } = await vendaRecusadaPeloPreco();
    const negado = await relancar(caixa, pend.id, { ajusteDePreco: 'manter_o_cobrado' });
    expect(negado.status, JSON.stringify(negado.body)).toBe(403);
    expect(negado.body.error.code).toBe('CORE_OFFLINE_SALE_PRICE_ADJUST_FORBIDDEN');
    // A recusa é de quem relançou: a pendência continua dizendo "o preço mudou".
    expect(linhaDaPendencia(pend.id).error_code).toBe('CORE_SALE_TOTAL_CHANGED');
    expect(vendasComAChave(chave)).toBe(0);

    const r = await relancar(gerente, pend.id, { ajusteDePreco: 'manter_o_cobrado' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sale.total_cents).toBe(5000);
    const venda = getConnection()
      .prepare('SELECT surcharge_cents FROM core_sales WHERE id = ?')
      .get(r.body.sale.id) as { surcharge_cents: number };
    expect(venda.surcharge_cents).toBe(1000);
    expect(pagamentosDa(r.body.sale.id)).toEqual([{ method: 'debito', amount_cents: 5000 }]);
    expect(r.body.pendencia.resolutionNote).toMatch(/acréscimo de R\$ 10,00/);
  });

  it('ajuste inventado é recusado e não troca o motivo da pendência', async () => {
    const { pend } = await vendaRecusadaPeloPreco();
    const r = await relancar(caixa, pend.id, { ajusteDePreco: 'de_graca' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CORE_OFFLINE_SALE_PRICE_ADJUST_INVALID');
    expect(linhaDaPendencia(pend.id).error_code).toBe('CORE_SALE_TOTAL_CHANGED');
  });

  it('a venda ajustada que nasceu sem a pendência fechar é desta pendência: nada de "venda nova", nada em dobro', async () => {
    const { chave, pend } = await vendaRecusadaPeloPreco();
    const r = await relancar(caixa, pend.id, { ajusteDePreco: 'preco_de_agora' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    reabrirPendencia(pend.id);

    // Sem a marca, a venda ajustada (outro dinheiro) apareceria como "outra
    // mercadoria na chave" e puxaria o "Relançar como venda nova".
    const lista = await request(app).get('/api/v1/core/offline-sales').set(caixa);
    expect(lista.body.items[0].vendaDaChave).toBeNull();
    const comoNova = await request(app)
      .post(`/api/v1/core/offline-sales/${pend.id}/relaunch-as-new`)
      .set(caixa)
      .send({});
    expect(comoNova.status).toBe(409);
    expect(comoNova.body.error.code).toBe('CORE_OFFLINE_SALE_KEY_NOT_REUSED');
    // O descarte também reconhece a venda ajustada.
    const descarte = await descartar(gerente, pend.id, 'cliente desistiu e o dinheiro foi devolvido');
    expect(descarte.body.error.code).toBe('CORE_OFFLINE_SALE_ALREADY_SOLD');

    // Relançar de novo devolve a MESMA venda e fecha a pendência.
    const deNovo = await relancar(caixa, pend.id);
    expect(deNovo.status, JSON.stringify(deNovo.body)).toBe(200);
    expect(deNovo.body.duplicated).toBe(true);
    expect(deNovo.body.sale.id).toBe(r.body.sale.id);
    expect(deNovo.body.pendencia.status).toBe('regularizada');
    expect(vendasComAChave(chave)).toBe(1);
  });
});

// ============================================================================
describe('G-offline-sync-08 — a conta do ajuste', () => {
  const recusa = {
    recebidoCents: 5000,
    aCobrarCents: 4000,
    linhas: [{ productId: 'p', name: 'Bota', informadoCents: 5000, vigenteCents: 4000 }],
  };

  it('dinheiro e cartão: a diferença sai do cartão, e o troco já dado no balcão não muda', () => {
    const r = corpoComAjusteDePreco(
      {
        items: [{ productId: 'p', quantity: 1, unitPriceCents: 5000 }],
        payments: [
          { method: 'dinheiro', amountCents: 500 },
          { method: 'debito', amountCents: 4500 },
        ],
      },
      recusa,
      'preco_de_agora',
      'u',
    );
    expect(r.corpo.payments).toEqual([
      { method: 'dinheiro', amountCents: 500 },
      { method: 'debito', amountCents: 3500 },
    ]);
    expect((r.corpo.items as { unitPriceCents: number }[])[0].unitPriceCents).toBe(4000);
    expect(r.resumo).toMatchObject({ diferencaCents: 1000, estornoCents: 1000, devolverEmDinheiroCents: 0 });
  });

  it('duas unidades: a diferença é a de cada uma vezes a quantidade', () => {
    const r = corpoComAjusteDePreco(
      {
        items: [{ productId: 'p', quantity: 2, unitPriceCents: 5000 }],
        payments: [{ method: 'credito', amountCents: 10000 }],
      },
      { ...recusa, recebidoCents: 10000, aCobrarCents: 8000 },
      'preco_de_agora',
      'u',
    );
    expect(r.resumo.diferencaCents).toBe(2000);
    expect(r.corpo.payments).toEqual([{ method: 'credito', amountCents: 8000 }]);
  });

  it('o cartão preso à cobrança da maquininha não é diminuído: a recusa diz o caminho', () => {
    expect(() =>
      corpoComAjusteDePreco(
        {
          items: [{ productId: 'p', quantity: 1, unitPriceCents: 5000 }],
          payments: [{ method: 'credito', amountCents: 5000, providerRef: 'tx-1' }],
        },
        recusa,
        'preco_de_agora',
        'u',
      ),
    ).toThrowError(/maquininha/);
  });

  it('manter o cobrado: a diferença vira acréscimo, e os pagamentos ficam como estão', () => {
    const corpo = {
      items: [{ productId: 'p', quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'debito', amountCents: 5000 }],
    };
    const r = corpoComAjusteDePreco(corpo, recusa, 'manter_o_cobrado', 'u');
    expect(r.corpo.surchargeCents).toBe(1000);
    expect(r.corpo.payments).toEqual(corpo.payments);
    expect(r.resumo).toMatchObject({ acrescimoCents: 1000, estornoCents: 0 });
  });

  // Revisão: a frase dizia "estorno no aparelho do cartão" para toda devolução
  // eletrônica, inclusive a de PIX — que não passa pela maquininha.
  it('o PIX é devolvido por PIX, e não "estornado no aparelho do cartão"', () => {
    const r = corpoComAjusteDePreco(
      {
        items: [{ productId: 'p', quantity: 1, unitPriceCents: 5000 }],
        payments: [{ method: 'pix', amountCents: 5000 }],
      },
      recusa,
      'preco_de_agora',
      'u',
    );
    expect(r.corpo.payments).toEqual([{ method: 'pix', amountCents: 4000 }]);
    expect(r.resumo.frase).toMatch(/Devolver R\$ 10,00 ao cliente: R\$ 10,00 devolvidos por PIX\./);
    expect(r.resumo.frase).not.toMatch(/aparelho do cartão/);
  });

  it('o cartão continua dito como estorno no aparelho, com o meio', () => {
    const r = corpoComAjusteDePreco(
      {
        items: [{ productId: 'p', quantity: 1, unitPriceCents: 5000 }],
        payments: [{ method: 'debito', amountCents: 5000 }],
      },
      recusa,
      'preco_de_agora',
      'u',
    );
    expect(r.resumo.frase).toMatch(/R\$ 10,00 de estorno no débito, no aparelho do cartão\./);
  });
});
