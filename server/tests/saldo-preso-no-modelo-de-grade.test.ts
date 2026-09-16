/**
 * ============================================================================
 * O SALDO PRESO NO MODELO DE GRADE TEM COMO SAIR (P00-prod-05)
 * ============================================================================
 *
 * O DEFEITO: `applyMovement` recusa qualquer movimento de um modelo de grade —
 * e a recusa era TOTAL, em qualquer direção, com saldo ou sem. Para o produto
 * que nunca teve saldo isso está certo e é o caso de sempre. Para o que JÁ TEM
 * — o banco antigo, de antes de `generateVariants` passar a recusar a grade
 * sobre mercadoria — ela fechava a última porta:
 *
 *   - vender não dá: o balcão esconde o modelo, e a venda recusa antes;
 *   - contar não dá: a contagem de inventário não lista o modelo;
 *   - excluir a grade não dá: variante com histórico não se apaga;
 *   - e ZERAR não dava, porque a saída caía na mesma recusa.
 *
 * Resultado: mercadoria que aparece na posição e no valor do estoque para
 * sempre, sem nenhum gesto no sistema que a resolva — só mexendo no banco à mão,
 * que é exatamente o que esta entrega não pode exigir do dono.
 *
 * O CONSERTO libera SÓ a saída, e só enquanto há saldo preso: a entrada continua
 * recusada (é ela que faria o saldo crescer), a venda continua recusada lá em
 * cima, o `CHECK (quantity >= 0)` impede tirar mais do que há, e a rota manual
 * já exige MOTIVO em toda saída — a regularização nasce com rastro. É o gesto
 * que a própria recusa de `generateVariants` manda fazer: "dê saída do saldo do
 * modelo e lance a entrada em cada tamanho".
 *
 * ## Como a guarda falha (quebrando de propósito)
 *
 *   - volte o `if (dono.tem_grade) throw` incondicional e a saída volta a ser
 *     recusada, deixando a mercadoria presa para sempre;
 *   - tire o `!saidaDeRegularizacao` e a ENTRADA no modelo volta a passar,
 *     fazendo o saldo preso crescer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { getBalance } from '../src/services/core/InventoryService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const PJ = 'preco-justo-grade';

let app: ReturnType<typeof createApp>;

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}-${PJ}`, companyId: PJ, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

const mover = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/core/stock/movements').set(auth('gerente_loja')).send(body);

/**
 * O ESTADO QUE O BANCO ANTIGO TEM: modelo com saldo E com grade.
 *
 * Montado com SQL cru de propósito — nenhum caminho de hoje o produz, e é
 * justamente por isso que ele precisa de teste: `generateVariants` recusa a
 * grade sobre mercadoria, e `applyMovement` recusa a entrada no modelo. O que
 * existe é o que ficou gravado antes das duas recusas.
 */
function modeloComSaldoEGrade(saldo: number): { modeloId: string; varianteId: string } {
  const db = getConnection();
  const agora = new Date().toISOString();
  const modeloId = randomUUID();
  const varianteId = randomUUID();
  const inserir = db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents, active,
        publish_online, parent_id, variant_attributes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 2000, 3990, 1, 0, ?, ?, ?, ?)`,
  );
  inserir.run(modeloId, PJ, 'PJ-9001', 'Camiseta Polo', null, null, agora, agora);
  inserir.run(varianteId, PJ, 'PJ-9002', 'Camiseta Polo · M', modeloId, '{"tamanho":"M"}', agora, agora);
  db.prepare(
    `INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(PJ, modeloId, saldo, agora);
  return { modeloId, varianteId };
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  auth('gerente_loja');
});

describe('o saldo preso no modelo de grade (P00-prod-05)', () => {
  it('a recusa NOMEIA o saldo preso e o gesto que o resolve', async () => {
    const { modeloId } = modeloComSaldoEGrade(10);
    const entrada = await mover({
      productId: modeloId,
      movementType: 'in',
      quantity: 3,
      referenceId: 'entrada-1',
      referenceType: 'entrada',
    });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(400);
    expect(entrada.body.error.code).toBe('CORE_PRODUCT_IS_GRID_MODEL');
    expect(entrada.body.error.message).toContain('10 preso no modelo');
    expect(entrada.body.error.message).toContain('SAÍDA');
    // E o saldo preso NÃO cresceu.
    expect(getBalance(PJ, modeloId)).toBe(10);
  });

  it('a saída com motivo tira o saldo preso — em duas etapas, até zerar', async () => {
    const { modeloId } = modeloComSaldoEGrade(10);

    const parcial = await mover({
      productId: modeloId,
      movementType: 'out',
      quantity: 4,
      referenceId: 'regulariza-1',
      referenceType: 'ajuste',
      reason: 'Saldo preso no modelo: relançado no tamanho M',
    });
    expect(parcial.status, JSON.stringify(parcial.body)).toBe(201);
    expect(getBalance(PJ, modeloId)).toBe(6);

    const resto = await mover({
      productId: modeloId,
      movementType: 'adjust',
      quantity: -6,
      referenceId: 'regulariza-2',
      referenceType: 'ajuste',
      reason: 'Saldo preso no modelo: relançado no tamanho M',
    });
    expect(resto.status, JSON.stringify(resto.body)).toBe(201);
    expect(getBalance(PJ, modeloId)).toBe(0);
  });

  it('zerado o modelo, a recusa volta a ser a de sempre', async () => {
    const { modeloId } = modeloComSaldoEGrade(0);
    const r = await mover({
      productId: modeloId,
      movementType: 'out',
      quantity: 1,
      referenceId: 'regulariza-3',
      referenceType: 'ajuste',
      reason: 'tentativa',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_PRODUCT_IS_GRID_MODEL');
    expect(r.body.error.message).toContain('Escolha a variante');
  });

  it('a saída não tira mais do que está preso', async () => {
    const { modeloId } = modeloComSaldoEGrade(3);
    const r = await mover({
      productId: modeloId,
      movementType: 'out',
      quantity: 5,
      referenceId: 'regulariza-4',
      referenceType: 'ajuste',
      reason: 'tentativa',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
    expect(getBalance(PJ, modeloId)).toBe(3);
  });

  it('a tela de Movimentações ACHA o modelo preso; o balcão continua sem vê-lo', async () => {
    const { modeloId } = modeloComSaldoEGrade(10);

    const balcao = await request(app)
      .get('/api/v1/core/products/search')
      .query({ q: 'Camiseta' })
      .set(auth('operador_caixa_loja'));
    expect(balcao.status).toBe(200);
    expect((balcao.body.items as Record<string, unknown>[]).map((i) => i.id)).not.toContain(modeloId);

    const movimentacoes = await request(app)
      .get('/api/v1/core/products/search')
      .query({ q: 'Camiseta', comSaldoPreso: '1' })
      .set(auth('gerente_loja'));
    expect(movimentacoes.status).toBe(200);
    const achado = (movimentacoes.body.items as Record<string, unknown>[]).find(
      (i) => i.id === modeloId,
    );
    expect(achado, 'o modelo preso tem de aparecer para quem vai regularizá-lo').toBeTruthy();
    expect(Number(achado?.saldo_preso)).toBe(1);
  });

  it('modelo de grade SEM saldo preso continua fora da busca, com o interruptor ligado', async () => {
    const { modeloId, varianteId } = modeloComSaldoEGrade(0);
    const r = await request(app)
      .get('/api/v1/core/products/search')
      .query({ q: 'Camiseta', comSaldoPreso: '1' })
      .set(auth('gerente_loja'));
    const ids = (r.body.items as Record<string, unknown>[]).map((i) => i.id);
    expect(ids).not.toContain(modeloId);
    // A variante, essa sim, aparece — como sempre apareceu.
    expect(ids).toContain(varianteId);
  });

  it('a entrada no TAMANHO continua entrando normalmente', async () => {
    const { modeloId, varianteId } = modeloComSaldoEGrade(10);
    const r = await mover({
      productId: varianteId,
      movementType: 'in',
      quantity: 10,
      referenceId: 'entrada-do-tamanho',
      referenceType: 'entrada',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(getBalance(PJ, varianteId)).toBe(10);
    expect(getBalance(PJ, modeloId)).toBe(10);
  });
});
