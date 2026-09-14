/**
 * RASTRO DO ITEM CANCELADO NO CARRINHO — GAP-V52/V63.
 *
 * O rodapé do PDV dizia "Itens cancelados: 0" com um literal hardcoded: o
 * operador podia bipar, mostrar o total ao cliente, remover a linha e fechar
 * por menos — sem contador na tela e sem registro em lugar nenhum. Este
 * arquivo prova a metade do SERVIDOR: o que a tela conta ao vivo viaja no
 * POST /core/sales (campo cancelledItems) e vira linha em
 * core_sale_removed_items, lida de volta pelo detalhe da venda.
 *
 * DECISÃO DOCUMENTADA: venda abandonada sem finalizar NÃO persiste rastro —
 * o carrinho é local (estado da tela), e o servidor só fica sabendo da venda
 * no Finalizar. O rastro cobre a venda que FECHOU com item removido no meio,
 * que é o cenário do desvio de balcão (fechar por menos do que se mostrou).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSale, getSaleDetail } from '../src/services/core/SalesService.js';

const app = createApp();
const SENHA = 'Rastro@Cancelado2026';

let companyA: string;
let companyB: string;
let produtoA: string;
let produtoRemovidoA: string;
let produtoB: string;
let operadorA: string;

function criarProduto(companyId: string, name: string, priceCents: number): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents,
          min_stock, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 0, 1, ?, ?)`,
    )
    .run(id, companyId, `COD-${id.slice(0, 6)}`, name, priceCents, now, now);
  return id;
}

function linhasDoRastro(saleId: string): {
  company_id: string;
  product_id: string | null;
  name: string;
  quantity: number;
  unit_price_cents: number;
  removed_by: string | null;
  removed_at: string;
  reason: string | null;
}[] {
  return getConnection()
    .prepare(
      `SELECT company_id, product_id, name, quantity, unit_price_cents,
              removed_by, removed_at, reason
         FROM core_sale_removed_items WHERE sale_id = ? ORDER BY name`,
    )
    .all(saleId) as never;
}

async function logar(login: string, companyId: string, profile: string) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

beforeEach(() => {
  resetDbForTests();
  companyA = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  companyB = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  produtoA = criarProduto(companyA, 'Camiseta', 5000);
  produtoRemovidoA = criarProduto(companyA, 'Cinto', 1200);
  produtoB = criarProduto(companyB, 'Vestido', 9000);
  applyMovement({
    companyId: companyA,
    productId: produtoA,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: 'carga-a',
  });
  operadorA = '';
});

/** A venda padrão do arquivo: 1 camiseta paga em dinheiro, sem gaveta. */
function vender(overrides: Record<string, unknown> = {}) {
  return createSale({
    companyId: companyA,
    userId: operadorA || 'op-service',
    idempotencyKey: randomUUID(),
    items: [{ productId: produtoA, quantity: 1, unitPriceCents: 5000 }],
    payments: [{ method: 'dinheiro', amountCents: 5000 }],
    ...overrides,
  } as Parameters<typeof createSale>[0]);
}

describe('gravação do rastro na venda', () => {
  it('cancelledItems viram linhas em core_sale_removed_items, com autor e retrato', () => {
    const { sale } = vender({
      userId: 'operador-1',
      cancelledItems: [
        {
          productId: produtoRemovidoA,
          name: 'Cinto',
          quantity: 2,
          unitPriceCents: 1200,
          removedAt: '2026-08-30T14:03:00.000Z',
        },
      ],
    });

    const rastro = linhasDoRastro(sale.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].company_id).toBe(companyA);
    expect(rastro[0].product_id).toBe(produtoRemovidoA);
    expect(rastro[0].name).toBe('Cinto');
    expect(rastro[0].quantity).toBe(2);
    expect(rastro[0].unit_price_cents).toBe(1200);
    // Quem removeu é quem operou a venda — o servidor não aceita autor do corpo.
    expect(rastro[0].removed_by).toBe('operador-1');
    expect(rastro[0].removed_at).toBe('2026-08-30T14:03:00.000Z');
    expect(rastro[0].reason).toBeNull();
  });

  it('venda sem cancelledItems não grava rastro nenhum', () => {
    const { sale } = vender();
    expect(linhasDoRastro(sale.id)).toHaveLength(0);
  });

  it('o detalhe da venda devolve o bloco removedItems', () => {
    const { sale } = vender({
      cancelledItems: [{ productId: produtoRemovidoA, name: 'Cinto', quantity: 1, unitPriceCents: 1200 }],
    });
    const detalhe = getSaleDetail(companyA, sale.id)!;
    const removidos = detalhe.removedItems as { name: string; quantity: number }[];
    expect(removidos).toHaveLength(1);
    expect(removidos[0].name).toBe('Cinto');
    expect(removidos[0].quantity).toBe(1);
  });

  it('reenvio idempotente da mesma venda não duplica o rastro', () => {
    const key = randomUUID();
    const args = {
      companyId: companyA,
      userId: 'op-idem',
      idempotencyKey: key,
      items: [{ productId: produtoA, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cancelledItems: [{ productId: produtoRemovidoA, name: 'Cinto', quantity: 1, unitPriceCents: 1200 }],
    } as Parameters<typeof createSale>[0];

    const first = createSale(args);
    const second = createSale(args);
    expect(second.duplicated).toBe(true);
    expect(linhasDoRastro(first.sale.id)).toHaveLength(1);
  });
});

describe('o rastro não fura o cerco da empresa', () => {
  it('produto de OUTRA empresa no rastro entra sem vínculo — só o retrato fica', () => {
    // O rastro é trilha, não razão: recusar a venda por causa de um id estranho
    // pararia o balcão. Mas gravar a FK de outra empresa seria vazamento de
    // tenant — o vínculo cai e o nome (retrato) permanece.
    const { sale } = vender({
      cancelledItems: [{ productId: produtoB, name: 'Vestido', quantity: 1, unitPriceCents: 9000 }],
    });
    const rastro = linhasDoRastro(sale.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].product_id).toBeNull();
    expect(rastro[0].name).toBe('Vestido');
  });

  it('a empresa B não lê o detalhe (nem o rastro) da venda da empresa A', () => {
    const { sale } = vender({
      cancelledItems: [{ productId: produtoRemovidoA, name: 'Cinto', quantity: 1, unitPriceCents: 1200 }],
    });
    expect(getSaleDetail(companyB, sale.id)).toBeNull();
  });
});

describe('lixo não entra no banco', () => {
  it('quantidade que não é número recusa a venda com mensagem legível', () => {
    expect(() =>
      vender({
        cancelledItems: [{ productId: produtoRemovidoA, name: 'Cinto', quantity: 'banana', unitPriceCents: 1200 }],
      }),
    ).toThrowError(/item cancelado/i);
  });

  it('quantidade zero ou negativa também recusa — remoção sem quantidade não existe', () => {
    expect(() =>
      vender({
        cancelledItems: [{ productId: produtoRemovidoA, name: 'Cinto', quantity: 0, unitPriceCents: 1200 }],
      }),
    ).toThrowError(/item cancelado/i);
  });
});

describe('o caminho da rota, de ponta a ponta', () => {
  it('POST /core/sales leva cancelledItems ao banco, o GET devolve e a auditoria conta', async () => {
    const caixa = await logar('CAIXA-A', companyA, 'operador_caixa_loja');

    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId: produtoA, quantity: 1, unitPriceCents: 5000 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
        cancelledItems: [
          { productId: produtoRemovidoA, name: 'Cinto', quantity: 3, unitPriceCents: 1200 },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // Gravou com o autor do TOKEN, nunca do corpo.
    const rastro = linhasDoRastro(res.body.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].removed_by).toBe(caixa.userId);
    expect(rastro[0].quantity).toBe(3);

    // O detalhe da venda mostra os cancelados — é a superfície de auditoria.
    const detalhe = await request(app).get(`/api/v1/core/sales/${res.body.id}`).set(caixa.auth);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.removedItems).toHaveLength(1);
    expect(detalhe.body.removedItems[0].name).toBe('Cinto');

    // E a trilha central sabe QUANTOS itens foram cancelados nesta venda.
    const audit = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE action = 'sale.create' AND entity_id = ?`,
      )
      .get(res.body.id) as { detail: string } | undefined;
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.detail).itensCancelados).toBe(1);
  });

  it('a venda da empresa A é 404 para o operador da empresa B', async () => {
    const { sale } = vender({
      cancelledItems: [{ productId: produtoRemovidoA, name: 'Cinto', quantity: 1, unitPriceCents: 1200 }],
    });
    const caixaB = await logar('CAIXA-B', companyB, 'operador_caixa_loja');
    const detalhe = await request(app).get(`/api/v1/core/sales/${sale.id}`).set(caixaB.auth);
    expect(detalhe.status).toBe(404);
  });
});
