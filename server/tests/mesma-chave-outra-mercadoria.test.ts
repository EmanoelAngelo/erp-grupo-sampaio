/**
 * ============================================================================
 * A MESMA CHAVE COM OUTRA MERCADORIA NÃO É REENVIO (item IDEM)
 * ============================================================================
 *
 * O E2E de API na pilha descartável (verificação E.5) mandou POST
 * /core/sales com a MESMA Idempotency-Key e o corpo DIFERENTE — quantidade 3
 * em vez de 2 — e recebeu 200 com a venda ORIGINAL, calado. O caixa acha que
 * registrou a venda nova, e ela não existe: o cliente levou 3, o sistema
 * baixou 2, e o dinheiro da terceira peça fica sobrando na gaveta sem venda
 * que o explique.
 *
 * O rascunho IETF "The Idempotency-Key HTTP Header Field" manda recusar a
 * reutilização da chave com carga diferente (422 Unprocessable Content). A
 * venda passa a gravar, na criação, a impressão digital da MERCADORIA do
 * pedido — o que se vende, e só isso —, e o reenvio é comparado com ela.
 *
 * O que este arquivo trava:
 *
 *   - mesma chave, outra mercadoria -> 422 CORE_IDEMPOTENCY_KEY_REUSED, e
 *     nada muda: nenhuma venda, estoque, caixa e financeiro intactos;
 *   - mesma chave, os mesmos itens em outra ordem -> 200 com a mesma venda;
 *   - pagamento, gaveta e observação NÃO entram na impressão digital: é assim
 *     que o relançamento da venda offline (mesma chave, corpo original, outra
 *     gaveta) continua devolvendo a mesma venda;
 *   - a venda anterior à impressão digital (coluna nula) segue a regra de
 *     sempre — compatibilidade;
 *   - o serviço (a venda da OS) também tem impressão digital;
 *   - a fila do PDV que entrega a venda recusada por chave reusada NÃO ouve
 *     "já subiu": a venda nova vira pendência, e não some.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { reconcileCoreSchema } from '../src/db/core-migrations.js';
import { getConnection } from '../src/db/sqlite.js';
import { createSale } from '../src/services/core/SalesService.js';
import { impressaoDigitalDaMercadoria, outraMercadoria } from '../src/services/core/ImpressaoDigitalDaVenda.js';
import { ApiError } from '../src/utils/errors.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-mesma-chave';
const GERENTE = 'gerente-mesma-chave';

type Auth = { Authorization: string };
let gerente: Auth;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, { userId: GERENTE, companyId: LOJA, profileCodes: ['gerente_loja'] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
});

async function produto(estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: estoque,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return p.body.id as string;
}

async function abrirCaixa(): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(gerente).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function vender(chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(gerente).set('Idempotency-Key', chave).send(corpo);
}

function contar(sql: string, ...args: (string | number)[]): number {
  return (getConnection().prepare(sql).get(...args) as { n: number }).n;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(LOJA, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

/** Tudo o que uma venda escreve — para provar que a recusa não escreveu nada. */
function retrato() {
  return {
    vendas: contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA),
    itens: contar(
      'SELECT COUNT(*) AS n FROM core_sale_items WHERE sale_id IN (SELECT id FROM core_sales WHERE company_id = ?)',
      LOJA,
    ),
    pagamentos: contar(
      'SELECT COUNT(*) AS n FROM core_sale_payments WHERE sale_id IN (SELECT id FROM core_sales WHERE company_id = ?)',
      LOJA,
    ),
    lancamentos: contar('SELECT COUNT(*) AS n FROM core_finance_entries WHERE company_id = ?', LOJA),
    movimentosDeEstoque: contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ?', LOJA),
    movimentosDeCaixa: contar(
      `SELECT COUNT(*) AS n FROM core_cash_movements
        WHERE session_id IN (SELECT id FROM core_cash_sessions WHERE company_id = ?)`,
      LOJA,
    ),
  };
}

function vendasComAChave(chave: string): number {
  return contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ? AND idempotency_key = ?', LOJA, chave);
}

// ============================================================================

describe('mesma chave, outra mercadoria', () => {
  it('quantidade 3 em vez de 2 é recusada com 422, e nada muda no estoque, no caixa ou no financeiro', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;

    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    expect(saldo(p)).toBe(8);
    const antes = retrato();

    const outra = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    });

    // Hoje: 200 com a venda original, calado. O certo é recusar, e dizer por quê.
    expect(outra.status, JSON.stringify(outra.body)).toBe(422);
    expect(outra.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    // A mensagem diz QUAL venda a chave já registrou e o que fazer.
    expect(outra.body.error.message).toContain(`#${primeira.body.number as number}`);
    expect(outra.body.error.message).toMatch(/chave nova/i);

    // Nada foi escrito: nem venda, nem item, nem baixa, nem gaveta, nem título.
    expect(retrato()).toEqual(antes);
    expect(saldo(p)).toBe(8);
    expect(vendasComAChave(chave)).toBe(1);
  });

  it('outro produto com a mesma chave também é recusado', async () => {
    const p1 = await produto(10);
    const p2 = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;

    expect(
      (await vender(chave, {
        cashSessionId: gaveta,
        items: [{ productId: p1, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
      })).status,
    ).toBe(201);

    const outra = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p2, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect(outra.status).toBe(422);
    expect(outra.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(saldo(p2)).toBe(10);
  });

  it('os mesmos itens em outra ordem são o mesmo pedido: 200 com a mesma venda', async () => {
    const p1 = await produto(10);
    const p2 = await produto(10, 3000);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;

    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [
        { productId: p1, quantity: 2 },
        { productId: p2, quantity: 1 },
      ],
      payments: [{ method: 'dinheiro', amountCents: 13_000 }],
    });
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    const antes = retrato();

    const reenvio = await vender(chave, {
      cashSessionId: gaveta,
      items: [
        { productId: p2, quantity: 1 },
        { productId: p1, quantity: 2 },
      ],
      payments: [{ method: 'dinheiro', amountCents: 13_000 }],
    });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
    expect(retrato()).toEqual(antes);
    expect(saldo(p1)).toBe(8);
    expect(saldo(p2)).toBe(9);
  });

  it('gaveta, observação e preço de linha não fazem parte da impressão digital', async () => {
    /*
      É o que mantém vivo o relançamento da venda offline: a MESMA chave com o
      CORPO ORIGINAL numa gaveta que não é a do turno em que a venda foi feita.
      A mercadoria e o dinheiro são os mesmos — muda só a gaveta onde entrou.

      O PAGAMENTO passou a entrar (RES-IDEM-VIZ): nenhum fluxo legítimo reenvia
      a mesma chave com outro dinheiro — o relançamento usa o corpo guardado, e
      o PIX e a maquininha reenviam a MESMA linha. Ver mesma-chave-outro-corpo.
    */
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;

    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(primeira.status).toBe(201);

    const reenvio = await vender(chave, {
      cashSessionId: null,
      note: 'reenvio da fila',
      items: [{ productId: p, quantity: 2, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
    expect(vendasComAChave(chave)).toBe(1);
  });

  it('a venda nasce com a impressão digital da mercadoria gravada', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const venda = await vender(`pdv-${randomUUID()}`, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(venda.status).toBe(201);
    const row = getConnection()
      .prepare('SELECT idempotency_fingerprint AS f FROM core_sales WHERE id = ?')
      .get(venda.body.id) as { f: string | null };
    expect(row.f).toMatch(/^v1:[0-9a-f]{64}$/);
  });
});

// ============================================================================

describe('venda anterior à impressão digital', () => {
  it('sem impressão digital gravada, o reenvio diferente devolve a original como sempre', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(primeira.status).toBe(201);
    // A venda gravada antes desta rodada: a coluna nasceu nula nela.
    getConnection()
      .prepare('UPDATE core_sales SET idempotency_fingerprint = NULL WHERE id = ?')
      .run(primeira.body.id as string);

    const reenvio = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
    expect(vendasComAChave(chave)).toBe(1);
    expect(saldo(p)).toBe(8);
  });

  it('o banco antigo ganha a coluna pelo reconcile, anulável', () => {
    const db = getConnection();
    db.exec('ALTER TABLE core_sales DROP COLUMN idempotency_fingerprint;');
    const { added } = reconcileCoreSchema();
    expect(added).toContain('core_sales.idempotency_fingerprint');
    const coluna = (
      db.prepare('PRAGMA table_info(core_sales)').all() as unknown as { name: string; notnull: number }[]
    ).find((c) => c.name === 'idempotency_fingerprint');
    expect(coluna).toMatchObject({ notnull: 0 });
  });
});

// ============================================================================

describe('o serviço sem mercadoria (a venda da OS)', () => {
  function tentar(fn: () => unknown): ApiError | null {
    try {
      fn();
      return null;
    } catch (err) {
      return err as ApiError;
    }
  }

  it('o valor do serviço entra na impressão digital; o reenvio igual devolve a mesma venda', async () => {
    const gaveta = await abrirCaixa();
    const chave = `os:ordem-1:${randomUUID()}`;
    const base = {
      companyId: LOJA,
      userId: GERENTE,
      idempotencyKey: chave,
      items: [],
      payments: [{ method: 'dinheiro', amountCents: 8000 }],
      cashSessionId: gaveta,
      origin: 'oficina',
      serviceTotalCents: 8000,
      serviceDescription: 'Mão de obra da OS #1',
    };

    const primeira = createSale(base);
    expect(primeira.duplicated).toBe(false);

    // O mesmo serviço, reenviado sem gaveta: a mesma venda.
    const reenvio = createSale({ ...base, cashSessionId: null });
    expect(reenvio.duplicated).toBe(true);
    expect(reenvio.sale.id).toBe(primeira.sale.id);

    // Outro valor de serviço com a mesma chave: recusado.
    const antes = retrato();
    const erro = tentar(() =>
      createSale({ ...base, serviceTotalCents: 9000, payments: [{ method: 'dinheiro', amountCents: 9000 }] }),
    );
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro?.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(erro?.status).toBe(422);
    expect(retrato()).toEqual(antes);
  });
});

// ============================================================================

describe('a fila do PDV entregando a venda recusada por chave reusada', () => {
  function entregar(chave: string, corpo: Record<string, unknown>, recusa: { code: string; message: string }) {
    return request(app).post('/api/v1/core/offline-sales').set(gerente).send({
      idempotencyKey: chave,
      label: 'venda do PDV',
      body: corpo,
      queuedAt: '2026-09-12T10:00:00.000Z',
      errorCode: recusa.code,
      errorMessage: recusa.message,
    });
  }

  it('a venda nova não ouve "já subiu": vira pendência, e o relançamento é recusado com o motivo', async () => {
    /*
      O caminho real do PDV: POST /sales volta 422, a fila classifica como
      recusa do servidor e ENTREGA a venda em /offline-sales. Se a entrega
      respondesse "já subiu" (a chave tem venda), o PDV marcaria como enviada
      e a venda nova sumiria do mesmo jeito calado que a 422 veio fechar.
    */
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const original = {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    };
    const primeira = await vender(chave, original);
    expect(primeira.status).toBe(201);

    const diferente = {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    };
    const recusa = await vender(chave, diferente);
    expect(recusa.status).toBe(422);

    const entregue = await entregar(chave, diferente, recusa.body.error);
    expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
    expect(entregue.body.jaSubiu).toBe(false);
    expect(entregue.body.pendencia).toMatchObject({
      status: 'pendente',
      receivedCents: 15_000,
      errorCode: 'CORE_IDEMPOTENCY_KEY_REUSED',
    });

    // Relançar com a mesma chave continua recusado, e a pendência guarda o porquê.
    const relancada = await request(app)
      .post(`/api/v1/core/offline-sales/${entregue.body.pendencia.id as string}/relaunch`)
      .set(gerente)
      .send({ cashSessionId: gaveta });
    expect(relancada.status).toBe(422);
    expect(relancada.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(vendasComAChave(chave)).toBe(1);
    expect(saldo(p)).toBe(8);
  });

  it('a entrega do MESMO corpo da venda que já existe continua dizendo "já subiu"', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    };
    const primeira = await vender(chave, corpo);
    expect(primeira.status).toBe(201);

    const entregue = await entregar(chave, { ...corpo, cashSessionId: null }, { code: 'X', message: 'qualquer' });
    expect(entregue.status).toBe(200);
    expect(entregue.body).toMatchObject({ jaSubiu: true, saleId: primeira.body.id });
  });
});

// ============================================================================

describe('a receita da impressão digital', () => {
  it('não depende da ordem dos itens, das unidades, das peças baixadas nem das linhas de serviço', () => {
    const a = impressaoDigitalDaMercadoria({
      items: [
        { productId: 'moto', quantity: 2, unitIds: ['chassi-1', 'chassi-2'] },
        { productId: 'capacete', quantity: 1 },
      ],
      linhasJaBaixadas: [
        { productId: 'pastilha', quantity: 2 },
        { productId: 'oleo', quantity: 1 },
      ],
      serviceLines: [
        { description: 'Troca de óleo', quantity: 1 },
        { description: 'Revisão', quantity: 1 },
      ],
      serviceTotalCents: 12_000,
    });
    const b = impressaoDigitalDaMercadoria({
      items: [
        { productId: 'capacete', quantity: '1' },
        { productId: 'moto', quantity: 2, unitIds: ['chassi-2', 'chassi-1'] },
      ],
      linhasJaBaixadas: [
        { productId: 'oleo', quantity: 1 },
        { productId: 'pastilha', quantity: 2 },
      ],
      serviceLines: [
        { description: ' Revisão ', quantity: 1 },
        { description: 'Troca de óleo', quantity: 1 },
      ],
      serviceTotalCents: 12_000.2,
    });
    expect(a).toBe(b);
  });

  it('preço de linha, gaveta e observação não entram; mercadoria, serviço, desconto e pagamento entram', () => {
    const base = { items: [{ productId: 'p', quantity: 2 }], payments: [{ method: 'pix', amountCents: 1 }] };
    const comResto = {
      items: [{ productId: 'p', quantity: 2, unitPriceCents: 999, discountCents: 50 }],
      payments: [{ method: 'pix', amountCents: 1, status: 'settled' as const, providerRef: 'ref-1' }],
      cashSessionId: 'outra-gaveta',
      note: 'outra',
    };
    expect(impressaoDigitalDaMercadoria(comResto)).toBe(impressaoDigitalDaMercadoria(base));
    // Sem desconto é desconto zero; "100" e 100 são o mesmo pagamento.
    expect(impressaoDigitalDaMercadoria({ ...base, discountCents: 0, surchargeCents: undefined })).toBe(
      impressaoDigitalDaMercadoria(base),
    );
    expect(
      impressaoDigitalDaMercadoria({ ...base, payments: [{ method: 'pix', amountCents: '1' as unknown as number }] }),
    ).toBe(impressaoDigitalDaMercadoria(base));

    const comDinheiro = impressaoDigitalDaMercadoria(base);
    expect(impressaoDigitalDaMercadoria({ ...base, payments: [{ method: 'pix', amountCents: 2 }] })).not.toBe(comDinheiro);
    expect(impressaoDigitalDaMercadoria({ ...base, payments: [{ method: 'debito', amountCents: 1 }] })).not.toBe(comDinheiro);
    expect(impressaoDigitalDaMercadoria({ ...base, discountCents: 1 })).not.toBe(comDinheiro);
    expect(impressaoDigitalDaMercadoria({ ...base, surchargeCents: 1 })).not.toBe(comDinheiro);
    expect(impressaoDigitalDaMercadoria({ ...base, customerCreditCents: 1 })).not.toBe(comDinheiro);

    const h = impressaoDigitalDaMercadoria(base);
    expect(impressaoDigitalDaMercadoria({ items: [{ productId: 'p', quantity: 3 }] })).not.toBe(h);
    expect(impressaoDigitalDaMercadoria({ items: [{ productId: 'q', quantity: 2 }] })).not.toBe(h);
    expect(
      impressaoDigitalDaMercadoria({ items: [{ productId: 'p', quantity: 2, unitIds: ['chassi-9'] }] }),
    ).not.toBe(h);
    expect(impressaoDigitalDaMercadoria({ ...base, serviceTotalCents: 100 })).not.toBe(h);
    expect(impressaoDigitalDaMercadoria({ ...base, linhasJaBaixadas: [{ productId: 'x', quantity: 1 }] })).not.toBe(h);
  });

  it('só acusa outra mercadoria quando dá para comparar', () => {
    const agora = impressaoDigitalDaMercadoria({ items: [{ productId: 'p', quantity: 2 }] });
    const outra = impressaoDigitalDaMercadoria({ items: [{ productId: 'p', quantity: 3 }] });
    expect(outraMercadoria(agora, agora)).toBe(false);
    expect(outraMercadoria(outra, agora)).toBe(true);
    // Venda anterior à coluna, e impressão de uma receita que não é esta.
    expect(outraMercadoria(null, agora)).toBe(false);
    expect(outraMercadoria(`v0:${'0'.repeat(64)}`, agora)).toBe(false);
  });
});
