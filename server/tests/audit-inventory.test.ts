/**
 * ============================================================================
 * AUDITORIA FASE 4 — O ESTOQUE COM MATEMÁTICA CONHECIDA
 * ============================================================================
 *
 * A pergunta desta fase não é "a rota responde?" — é "a CONTA fecha em todos
 * os lugares que respondem saldo?". A sequência é fixada de antemão, com
 * aritmética que qualquer um confere de cabeça:
 *
 *   produto novo, estoque inicial 10
 *   → recebimento        +5   (saldo 15)
 *   → venda de 3         −3   (saldo 12)
 *   → devolução de 1     +1   (saldo 13)
 *   → ajuste de contagem −2   (saldo 11)
 *
 * O 11 tem de aparecer em QUATRO superfícies independentes, porque cada uma
 * é uma implementação diferente da mesma pergunta:
 *
 *   1. o RAZÃO — a soma dos deltas de `core_stock_movements`;
 *   2. o SALDO MATERIALIZADO — `core_stock` via `getBalance`/`getAvailable`;
 *   3. a ROTA de posição — `GET /core/stock`;
 *   4. o HISTÓRICO — `GET /core/stock/movements`, com os 5 lançamentos na
 *      ordem, cada linha fechando `anterior + delta = posterior` e o
 *      posterior de um sendo o anterior do próximo.
 *
 * Toda a sequência atravessa as ROTAS HTTP (produto, movimento manual, venda,
 * devolução, ajuste) — nada de chamar serviço por dentro no caminho feliz.
 *
 * Depois vêm as tentativas de QUEBRAR:
 *   - reservar 2 numa pré-venda: disponível cai a 9 e o físico fica em 11 —
 *     e a venda de balcão tem de respeitar a reserva (CORE_STOCK_RESERVED);
 *   - saída maior que o saldo: o CHECK `quantity >= 0` recusa e NADA muda —
 *     nem razão, nem saldo, nem outbox da central;
 *   - venda de duas linhas em que a SEGUNDA não tem saldo: a transação tem de
 *     reverter a primeira linha junto;
 *   - quantidade zero e não-numérica: recusadas com CORE_INVALID_QUANTITY;
 *   - quantidade NEGATIVA em entrada/saída: recusada com o MESMO erro — o
 *     sinal é do tipo do movimento, e o sistema não o adivinha do número;
 *   - clique duplo na mesma movimentação: a mesma referência não duplica
 *     (pré-cheque + UNIQUE em (empresa, reference_type, reference_id,
 *     produto, movement_type) dentro de `applyMovement`).
 *
 * O que JÁ TEM dono não é repetido aqui:
 *   - movimentação manual exige motivo → `ajuste-manual-tem-motivo.test.ts`;
 *   - estorno de venda repõe o saldo   → `devolucao.test.ts` (describe
 *     "cancelar depois de devolver...") e `estoque-historico.test.ts`;
 *   - idempotência de `applyMovement` e de `createSale` no nível do serviço
 *     → `core-invariants.test.ts` e `venda-linha-repetida.test.ts`.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

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
import { getAvailable, getBalance } from '../src/services/core/InventoryService.js';

const app = createApp();
const SENHA = 'Auditoria@Estoque2026';

let auth: { Authorization: string };
let empresa: string;

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'bikes-auditoria',
    legalName: 'Sampaio Bikes Auditoria Ltda',
    tradeName: 'Bikes Auditoria',
    kind: 'retail',
  });
  const userId = await upsertUser({
    login: 'GERENTE.AUDIT',
    displayName: 'Gerente da Auditoria',
    password: SENHA,
  });
  linkUserToCompany(userId, empresa, 'gerente_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GERENTE.AUDIT', password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

// ---------------------------------------------------------------- ferramentas

async function criarProduto(nome: string, precoCents: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, costCents: Math.floor(precoCents / 2) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function mover(body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/stock/movements')
    .set(auth)
    .send({ referenceId: randomUUID(), ...body });
}

async function vender(
  items: { productId: string; quantity: number }[],
  totalCents: number,
): Promise<request.Response> {
  return request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .send({
      idempotencyKey: randomUUID(),
      items,
      payments: [{ method: 'dinheiro', amountCents: totalCents }],
    });
}

interface LinhaDoRazao {
  movement_type: string;
  kind: string;
  quantity: number;
  quantity_before: number;
  balance_after: number;
}

/** O razão do produto na ordem em que foi escrito. */
function razao(productId: string): LinhaDoRazao[] {
  return getConnection()
    .prepare(
      `SELECT movement_type, kind, quantity, quantity_before, balance_after
         FROM core_stock_movements
        WHERE company_id = ? AND product_id = ?
        ORDER BY rowid ASC`,
    )
    .all(empresa, productId) as unknown as LinhaDoRazao[];
}

function somaDoRazao(productId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM core_stock_movements
        WHERE company_id = ? AND product_id = ?`,
    )
    .get(empresa, productId) as { total: number };
  return row.total;
}

function linhaDoCoreStock(productId: string): { quantity: number; reserved: number } | undefined {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(empresa, productId) as { quantity: number; reserved: number } | undefined;
}

/** Quantos fatos já subiram para a fila da central. */
function tamanhoDoOutbox(): number {
  const row = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_outbox')
    .get() as { n: number };
  return row.n;
}

async function posicaoDeEstoque(productId: string) {
  const res = await request(app).get('/api/v1/core/stock').set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as { product_id: string; quantity: number; reserved: number }[]).find(
    (i) => i.product_id === productId,
  );
}

// ============================================================================

describe('a sequência com matemática conhecida: 10 +5 −3 +1 −2 = 11 em todo lugar', () => {
  it('atravessa produto → entrada → recebimento → venda → devolução → ajuste, e o 11 aparece nas quatro superfícies', async () => {
    // Produto novo com estoque inicial 10 — a carga inicial é um movimento
    // manual de entrada, que é como a tela de estoque faz.
    const produto = await criarProduto('Capacete Auditoria', 10_000);
    const inicial = await mover({
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga-inicial',
    });
    expect(inicial.status, JSON.stringify(inicial.body)).toBe(201);
    expect(inicial.body.balance).toBe(10);

    // Recebimento +5 — segunda entrada, referência própria.
    const recebimento = await mover({
      productId: produto,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'recebimento-nf-1001',
    });
    expect(recebimento.status, JSON.stringify(recebimento.body)).toBe(201);
    expect(recebimento.body.balance).toBe(15);

    // Venda de 3 pela rota do PDV — 3 × R$ 100,00.
    const venda = await vender([{ productId: produto, quantity: 3 }], 30_000);
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const saleId = String(venda.body.id);
    expect(getBalance(empresa, produto)).toBe(12);

    // Devolução de 1, mercadoria boa, volta para o vendável.
    const devolviveis = await request(app)
      .get(`/api/v1/core/sales/${saleId}/returnable`)
      .set(auth);
    expect(devolviveis.status, JSON.stringify(devolviveis.body)).toBe(200);
    const itemDaVenda = (devolviveis.body.items as { sale_item_id: string }[])[0];
    const devolucao = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId,
        reason: 'Cliente trocou de ideia — auditoria fase 4',
        items: [{ saleItemId: itemDaVenda.sale_item_id, quantity: 1, restock: true }],
      });
    expect(devolucao.status, JSON.stringify(devolucao.body)).toBe(201);
    expect(getBalance(empresa, produto)).toBe(13);

    // Ajuste −2, com motivo — a contagem achou 2 a menos na prateleira.
    const ajuste = await mover({
      productId: produto,
      movementType: 'adjust',
      quantity: -2,
      referenceType: 'ajuste',
      referenceId: 'acerto-contagem-1',
      reason: 'Acerto de contagem — auditoria fase 4',
    });
    expect(ajuste.status, JSON.stringify(ajuste.body)).toBe(201);
    expect(ajuste.body.balance).toBe(11);

    // --------------------------------------------------- superfície 1: razão
    expect(somaDoRazao(produto)).toBe(11);

    // ------------------------------------- superfície 2: saldo materializado
    expect(getBalance(empresa, produto)).toBe(11);
    expect(getAvailable(empresa, produto)).toBe(11);
    expect(linhaDoCoreStock(produto)).toEqual({ quantity: 11, reserved: 0 });

    // -------------------------------------------- superfície 3: GET /stock
    const posicao = await posicaoDeEstoque(produto);
    expect(posicao?.quantity).toBe(11);
    expect(posicao?.reserved).toBe(0);

    // ------------------------------ superfície 4: o histórico, com a ordem
    const historico = await request(app)
      .get(`/api/v1/core/stock/movements?productId=${produto}`)
      .set(auth);
    expect(historico.status, JSON.stringify(historico.body)).toBe(200);
    const linhas = historico.body.items as LinhaDoRazao[];
    expect(linhas).toHaveLength(5);

    // A rota devolve do mais novo para o mais antigo.
    expect(linhas.map((l) => l.quantity)).toEqual([-2, 1, -3, 5, 10]);
    expect(linhas.map((l) => l.balance_after)).toEqual([11, 13, 12, 15, 10]);
    expect(linhas.map((l) => l.kind)).toEqual([
      /*
        O RÓTULO DO AJUSTE AVULSO MUDOU (B-estoque-entrada-13). Era
        'INVENTORY_ADJUSTMENT_NEGATIVE' — o mesmo "Acerto de inventário (−)" de
        uma contagem de verdade, e o histórico não distinguia o ajuste lançado
        no balcão da falta achada numa contagem com esperado e contado. O
        'adjust' sem contagem por trás agora é ajuste MANUAL de saldo.
      */
      'MANUAL_ADJUSTMENT_NEGATIVE',
      'SALE_RETURN',
      'SALE',
      'MANUAL_ENTRY',
      'MANUAL_ENTRY',
    ]);

    // E o razão fecha linha a linha: anterior + delta = posterior, e o
    // posterior de um é o anterior do próximo — sem buraco e sem sobra.
    const cronologico = razao(produto);
    expect(cronologico).toHaveLength(5);
    for (const linha of cronologico) {
      expect(linha.quantity_before + linha.quantity, JSON.stringify(linha)).toBe(
        linha.balance_after,
      );
    }
    for (let i = 1; i < cronologico.length; i += 1) {
      expect(cronologico[i].quantity_before).toBe(cronologico[i - 1].balance_after);
    }
  });
});

// ============================================================================

describe('reserva: promessa não é baixa, mas trava o disponível', () => {
  it('pré-venda de 2 deixa físico 11 e disponível 9 — e a venda de balcão respeita a reserva', async () => {
    const produto = await criarProduto('Bicicleta Aro 29', 10_000);
    await mover({
      productId: produto,
      movementType: 'in',
      quantity: 11,
      referenceType: 'entrada',
      referenceId: 'carga-reserva',
    });

    // Reservar 2 numa pré-venda, pela rota.
    const prevenda = await request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({ kind: 'pre_venda', items: [{ productId: produto, quantity: 2 }] });
    expect(prevenda.status, JSON.stringify(prevenda.body)).toBe(201);

    expect(getBalance(empresa, produto)).toBe(11);
    expect(getAvailable(empresa, produto)).toBe(9);
    const posicao = await posicaoDeEstoque(produto);
    expect(posicao?.quantity).toBe(11);
    expect(posicao?.reserved).toBe(2);

    // Vender 10 esbarra na reserva: há 11 na prateleira, mas 2 têm dono.
    const acimaDoLivre = await vender([{ productId: produto, quantity: 10 }], 100_000);
    expect(acimaDoLivre.status, JSON.stringify(acimaDoLivre.body)).toBe(409);
    expect(acimaDoLivre.body.error?.code).toBe('CORE_STOCK_RESERVED');
    expect(getBalance(empresa, produto)).toBe(11);
    expect(getAvailable(empresa, produto)).toBe(9);

    // Vender exatamente o disponível passa e zera o livre.
    const noLimite = await vender([{ productId: produto, quantity: 9 }], 90_000);
    expect(noLimite.status, JSON.stringify(noLimite.body)).toBe(201);
    expect(getBalance(empresa, produto)).toBe(2);
    expect(getAvailable(empresa, produto)).toBe(0);

    // Cancelar a pré-venda devolve o disponível sem inventar mercadoria.
    const cancelamento = await request(app)
      .post(`/api/v1/core/quotes/${prevenda.body.id}/cancel`)
      .set(auth)
      .send({ reason: 'Cliente desistiu' });
    expect(cancelamento.status, JSON.stringify(cancelamento.body)).toBe(200);
    expect(getBalance(empresa, produto)).toBe(2);
    expect(getAvailable(empresa, produto)).toBe(2);

    // O razão continua fechando: 11 entraram, 9 saíram. Reserva e liberação
    // entram no histórico com delta físico ZERO — não são baixa.
    expect(somaDoRazao(produto)).toBe(2);
  });
});

// ============================================================================

describe('falsificação: saída maior que o saldo é recusada e NADA muda', () => {
  it('out 15 com saldo 11 leva 409 — razão, saldo, posição e outbox ficam exatamente como estavam', async () => {
    const produto = await criarProduto('Câmara de Ar', 2_000);
    await mover({
      productId: produto,
      movementType: 'in',
      quantity: 11,
      referenceType: 'entrada',
      referenceId: 'carga-check',
    });

    const linhasAntes = razao(produto).length;
    const outboxAntes = tamanhoDoOutbox();

    const estouro = await mover({
      productId: produto,
      movementType: 'out',
      quantity: 15,
      referenceType: 'perda',
      referenceId: 'tentativa-estouro',
      reason: 'Tentativa de saída acima do saldo — auditoria',
    });
    expect(estouro.status, JSON.stringify(estouro.body)).toBe(409);
    expect(estouro.body.error?.code).toBe('CORE_INSUFFICIENT_STOCK');

    // NADA mudou: nem o saldo, nem o razão, nem o fato para a central.
    expect(getBalance(empresa, produto)).toBe(11);
    expect(razao(produto)).toHaveLength(linhasAntes);
    expect(tamanhoDoOutbox()).toBe(outboxAntes);
    const posicao = await posicaoDeEstoque(produto);
    expect(posicao?.quantity).toBe(11);

    // O limite exato passa: sair 11 de 11 zera sem violar o CHECK...
    const noLimite = await mover({
      productId: produto,
      movementType: 'out',
      quantity: 11,
      referenceType: 'uso_interno',
      referenceId: 'saida-total',
      reason: 'Consumo interno da oficina',
    });
    expect(noLimite.status, JSON.stringify(noLimite.body)).toBe(201);
    expect(noLimite.body.balance).toBe(0);

    // ...e do zero não sai mais nada.
    const doZero = await mover({
      productId: produto,
      movementType: 'out',
      quantity: 1,
      referenceType: 'perda',
      referenceId: 'saida-do-zero',
      reason: 'Não deveria sair',
    });
    expect(doZero.status).toBe(409);
    expect(getBalance(empresa, produto)).toBe(0);
  });

  it('venda de duas linhas em que a segunda não tem saldo reverte a primeira junto', async () => {
    const capacete = await criarProduto('Capacete Rollback', 10_000);
    const luva = await criarProduto('Luva Rollback', 5_000);
    await mover({
      productId: capacete,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga-a',
    });
    await mover({
      productId: luva,
      movementType: 'in',
      quantity: 1,
      referenceType: 'entrada',
      referenceId: 'carga-b',
    });

    // 2 capacetes (tem) + 3 luvas (só tem 1): a venda INTEIRA tem de falhar.
    const res = await vender(
      [
        { productId: capacete, quantity: 2 },
        { productId: luva, quantity: 3 },
      ],
      35_000,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe('CORE_INSUFFICIENT_STOCK');

    // A primeira linha não pode ter baixado: transação é tudo ou nada.
    expect(getBalance(empresa, capacete)).toBe(10);
    expect(getBalance(empresa, luva)).toBe(1);
    expect(razao(capacete)).toHaveLength(1);
    expect(razao(luva)).toHaveLength(1);
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(vendas.n).toBe(0);
  });
});

// ============================================================================

describe('falsificação: quantidade que não é quantidade', () => {
  it('zero e não-número são recusados com CORE_INVALID_QUANTITY, sem sujar o razão', async () => {
    const produto = await criarProduto('Corrente 9v', 8_000);

    const zero = await mover({
      productId: produto,
      movementType: 'in',
      quantity: 0,
      referenceType: 'entrada',
      referenceId: 'entrada-zero',
    });
    expect(zero.status, JSON.stringify(zero.body)).toBe(400);
    expect(zero.body.error?.code).toBe('CORE_INVALID_QUANTITY');

    const naoNumero = await mover({
      productId: produto,
      movementType: 'in',
      quantity: 'cinco',
      referenceType: 'entrada',
      referenceId: 'entrada-texto',
    });
    expect(naoNumero.status, JSON.stringify(naoNumero.body)).toBe(400);
    expect(naoNumero.body.error?.code).toBe('CORE_INVALID_QUANTITY');

    expect(getBalance(empresa, produto)).toBe(0);
    expect(razao(produto)).toHaveLength(0);
  });

  it('entrada com quantidade NEGATIVA é recusada — o sistema não adivinha o sinal', async () => {
    /*
      ACHADO DA AUDITORIA, consertado nesta rodada. `signedDelta` em
      `InventoryService.ts` aplicava `Math.abs` sobre a quantidade de
      `in`/`out`: uma entrada de −5 virava +5 em silêncio. O contrato do
      serviço sempre documentou "sempre positiva; o sinal é definido por
      movementType" — mas ninguém cobrava, e quem digitou −5 querendo tirar 5
      recebia +5: um erro de 10 unidades, sem aviso, e o histórico registrava
      uma entrada que ninguém fez.

      A casa já escreveu a régua em outro teste: "chamada que parece
      funcionar e não faz nada é pior que erro" — e chamada que parece
      funcionar e faz O CONTRÁRIO é pior ainda. Agora `applyMovement` recusa
      quantidade negativa em `in`/`out` com CORE_INVALID_QUANTITY, no funil
      por onde TODO chamador passa — a rota inclusive.
    */
    const produto = await criarProduto('Pneu 26', 12_000);
    await mover({
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga-sinal',
    });

    const negativa = await mover({
      productId: produto,
      movementType: 'in',
      quantity: -5,
      referenceType: 'entrada',
      referenceId: 'entrada-negativa',
    });
    expect(negativa.status, JSON.stringify(negativa.body)).toBe(400);
    expect(negativa.body.error?.code).toBe('CORE_INVALID_QUANTITY');

    // A saída negativa é o mesmo dedo no mesmo lugar: recusada igual.
    const saidaNegativa = await mover({
      productId: produto,
      movementType: 'out',
      quantity: -5,
      referenceType: 'perda',
      referenceId: 'saida-negativa',
      reason: 'Sinal trocado — não pode entrar',
    });
    expect(saidaNegativa.status, JSON.stringify(saidaNegativa.body)).toBe(400);
    expect(saidaNegativa.body.error?.code).toBe('CORE_INVALID_QUANTITY');

    // E o saldo não pode ter mudado em nenhuma direção.
    expect(getBalance(empresa, produto)).toBe(10);
    // O razão só tem a carga inicial: recusa não vira história.
    expect(razao(produto)).toHaveLength(1);
  });
});

// ============================================================================

describe('falsificação: o clique duplo na movimentação manual', () => {
  it('a mesma referência entra UMA vez — a segunda volta 200/duplicated e o razão tem uma linha só', async () => {
    /*
      O mecanismo, conferido no código: `applyMovement` faz um pré-cheque por
      (company_id, reference_type, reference_id, product_id, movement_type) e
      o banco ainda tem a UNIQUE com a mesma chave. O reenvio devolve o saldo
      corrente com `duplicated: true`, e a rota rebaixa o status de 201 para
      200. O nível do SERVIÇO já é coberto por `core-invariants.test.ts`;
      aqui o que se prova é a rota inteira, com o corpo idêntico que um clique
      duplo de verdade produz.
    */
    const produto = await criarProduto('Cadeado U-lock', 6_000);
    const corpo = {
      productId: produto,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'nf-77',
    };

    const primeiro = await mover(corpo);
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(201);
    expect(primeiro.body.duplicated).toBe(false);
    expect(primeiro.body.balance).toBe(5);

    const segundo = await mover(corpo);
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(200);
    expect(segundo.body.duplicated).toBe(true);
    expect(segundo.body.balance).toBe(5);

    expect(getBalance(empresa, produto)).toBe(5);
    expect(razao(produto)).toHaveLength(1);
    expect(somaDoRazao(produto)).toBe(5);

    // A segunda VIAGEM do fornecedor (referência nova) soma de verdade — a
    // idempotência é do gesto, não do documento.
    const segundaViagem = await mover({ ...corpo, referenceId: 'nf-77-viagem-2' });
    expect(segundaViagem.status).toBe(201);
    expect(getBalance(empresa, produto)).toBe(10);
  });
});
