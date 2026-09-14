/**
 * ============================================================================
 * LOTE E VALIDADE — o ciclo que não existia em camada nenhuma (GAP-V35)
 * ============================================================================
 *
 * ## O defeito
 *
 * `PRAGMA` no banco operacional: ZERO colunas de validade ou lote em
 * `core_products` (48 colunas), `core_stock` (5) e `core_stock_movements` (21);
 * nenhuma tabela de lote em `sqlite_master`. Num grupo cujo catálogo tem
 * `weighable`, `plu_code` e `tare_grams` — desenhado para varejo com balança,
 * isto é, alimento — validade não é conveniência: é obrigação sanitária.
 *
 * As consequências, todas reais: perda por vencimento invisível ao gestor,
 * mercadoria vencida vendável no PDV sem nenhuma trava, e recall impossível
 * ("de qual lote era?" não tinha resposta).
 *
 * ## Como estes casos falham (quebrando de propósito — conferido)
 *
 *   - troque `pickBatchFefo` para ordenar por `created_at` em vez de
 *     `expires_on` e "o que vence primeiro sai primeiro" fica vermelho;
 *   - tire a recusa de `assertBatchUsable` e "lote vencido não sai pela venda"
 *     fica vermelho, com a venda passando;
 *   - troque `dono.tracks_batches === 1` por `true` em `applyMovement` e o
 *     bloco inteiro de "produto sem controle não complica em nada" fica
 *     vermelho — que é a regra dura do módulo;
 *   - grave `batch_balance_after` como `balance` (o do produto) em vez do saldo
 *     do lote e a identidade por lote fica vermelha;
 *   - tire o `AND b.company_id = ?` de `assertBatchUsable` e o caso do tenant
 *     deixa a empresa B consumir o lote da A.
 *
 * ## O que este arquivo NÃO cobra, e por quê
 *
 * A entrada por XML (`NfeImportService`) não declara lote, e isso é decisão
 * registrada: a NF-e traz quantidade e custo, e o grupo `rastro` (nLote/dVal)
 * é opcional e ausente em quase toda nota de varejo. A mercadoria dela cai no
 * balde "sem lote declarado", que é um estado HONESTO e nomeado — e o caso
 * "a pendência diminui pela alocação" abaixo prova que ele tem porta de saída.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement, getBalance, listMovements } from '../src/services/core/InventoryService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';
import {
  allocateToBatch,
  balancesByBatch,
  batchAlerts,
  batchBalance,
  createBatch,
  faixaDaValidade,
  listBatches,
  markBatchChecked,
  pendenciasSemLote,
  saldoSemLote,
  setBatchControl,
} from '../src/services/core/BatchService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let userId: string;
/** Iogurte: controla lote. Parafuso: não controla — é o grupo de controle. */
let iogurte: string;
let parafuso: string;

const HOJE = () => hojeNaLoja();

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-validade',
    companyId: 'loja-validade',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
  userId = res.body.user.id;

  iogurte = String(
    createProduct(companyId, { name: 'Iogurte natural 170g', priceCents: 350, costCents: 200 }).id,
  );
  parafuso = String(
    createProduct(companyId, { name: 'Parafuso 4x40', priceCents: 100, costCents: 40 }).id,
  );
  setBatchControl({ companyId, productId: iogurte, tracksBatches: true, userId });
});

/** Entrada de saldo num lote, pelo funil de sempre. */
function entrar(productId: string, quantidade: number, batchId?: string, ref = randomUUID()) {
  return applyMovement({
    companyId,
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: ref,
    userId,
    batchId,
  });
}

function lote(code: string, expiresOn: string | null, productId = iogurte) {
  return createBatch(companyId, { productId, code, expiresOn, userId });
}

/** Movimentos do mais antigo para o mais novo, que é como se lê história. */
function historico(productId: string) {
  return listMovements(companyId, { productId }).reverse();
}

// ---------------------------------------------------------------------------

describe('a regra dura: produto SEM controle não complica em nada', () => {
  it('a venda de quem não controla lote continua idêntica — e o razão não ganha lote', () => {
    entrar(parafuso, 100);
    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: parafuso, quantity: 10 }],
      payments: [{ method: 'dinheiro', amountCents: 1000 }],
    });

    expect(getBalance(companyId, parafuso)).toBe(90);
    for (const mov of historico(parafuso)) {
      expect(mov.batch_id).toBeNull();
      // As duas colunas do lote ficam nulas: duas colunas de nada em toda
      // linha do histórico não ajudariam ninguém.
      expect(mov.batch_quantity_before).toBeNull();
      expect(mov.batch_balance_after).toBeNull();
    }
  });

  it('informar lote em produto que não controla é RECUSA, nunca silêncio', () => {
    const doIogurte = lote('L1', somarDias(HOJE(), 30));
    expect(() => entrar(parafuso, 5, doIogurte.id)).toThrow(/não controla lote/i);
  });

  it('cadastrar lote em produto sem controle é recusado com o caminho na mensagem', () => {
    expect(() => lote('L1', null, parafuso)).toThrow(/Ligue o controle no cadastro/i);
  });

  it('nenhum alerta nasce de quem não controla: o catálogo inteiro sem lote soma zero', () => {
    entrar(parafuso, 500);
    const alerta = batchAlerts(companyId);
    expect(alerta.faixas.every((f) => f.lotes === 0)).toBe(true);
    expect(alerta.produtosComSaldoSemLote).toBe(0);
    expect(pendenciasSemLote(companyId)).toEqual([]);
  });
});

describe('saldo por lote sai do RAZÃO, e a conta fecha lote a lote', () => {
  it('anterior + delta = posterior em cada linha, por lote', () => {
    const a = lote('LOTE-A', somarDias(HOJE(), 10));
    const b = lote('LOTE-B', somarDias(HOJE(), 40));

    entrar(iogurte, 12, a.id);
    entrar(iogurte, 8, b.id);
    entrar(iogurte, 3, a.id);

    for (const mov of historico(iogurte)) {
      expect(mov.batch_quantity_before).not.toBeNull();
      expect(mov.batch_balance_after).toBe(
        Number(mov.batch_quantity_before) + Number(mov.quantity),
      );
    }

    // E o saldo derivado bate com a última linha de cada lote.
    expect(batchBalance(companyId, a.id)).toBe(15);
    expect(batchBalance(companyId, b.id)).toBe(8);
    // A soma dos lotes é o saldo do produto: uma fonte de verdade só.
    expect(batchBalance(companyId, a.id) + batchBalance(companyId, b.id)).toBe(
      getBalance(companyId, iogurte),
    );
  });

  it('NÃO existe tabela de saldo por lote: o cadastro do lote não guarda quantidade', () => {
    /*
      A prova de que o desenho é o declarado. Se alguém acrescentar uma coluna
      de saldo em `core_product_batches`, este caso fica vermelho e a conversa
      acontece ANTES de o segundo cache divergir do razão.
    */
    const colunas = (
      getConnection().prepare('PRAGMA table_info(core_product_batches)').all() as unknown as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(colunas).not.toContain('quantity');
    expect(colunas).not.toContain('balance');
    expect(colunas).not.toContain('saldo');
  });

  it('o balde SEM LOTE aparece na lista de saldos — esconder faria a soma discordar', () => {
    const a = lote('LOTE-A', somarDias(HOJE(), 10));
    entrar(iogurte, 6, a.id);
    entrar(iogurte, 4); // chegou por nota fiscal: sem lote declarado

    const saldos = balancesByBatch(companyId, iogurte);
    expect(saldos).toHaveLength(2);
    expect(saldos.find((s) => s.batchId === a.id)?.quantity).toBe(6);
    expect(saldos.find((s) => s.batchId === null)?.quantity).toBe(4);
    expect(saldoSemLote(companyId, iogurte)).toBe(4);
  });
});

describe('FEFO: o que vence primeiro sai primeiro', () => {
  it('a venda escolhe o lote de validade mais próxima, e GRAVA a escolha', () => {
    const longe = lote('LONGE', somarDias(HOJE(), 60));
    const perto = lote('PERTO', somarDias(HOJE(), 3));
    entrar(iogurte, 10, longe.id);
    entrar(iogurte, 10, perto.id);

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: iogurte, quantity: 4 }],
      payments: [{ method: 'dinheiro', amountCents: 1400 }],
    });

    const venda = historico(iogurte).find((m) => m.kind === 'SALE')!;
    expect(venda.batch_id).toBe(perto.id);
    // A escolha fica gravada: sem isso, dois relatórios rodando em dias
    // diferentes chegariam a lotes diferentes para a mesma venda de ontem.
    expect(venda.batch_code).toBe('PERTO');
    expect(batchBalance(companyId, perto.id)).toBe(6);
    expect(batchBalance(companyId, longe.id)).toBe(10);
  });

  it('lote sem validade declarada sai DEPOIS de quem tem prazo', () => {
    const semData = lote('SEM-DATA', null);
    const comData = lote('COM-DATA', somarDias(HOJE(), 90));
    entrar(iogurte, 5, semData.id);
    entrar(iogurte, 5, comData.id);

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: iogurte, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 700 }],
    });

    expect(batchBalance(companyId, comData.id)).toBe(3);
    expect(batchBalance(companyId, semData.id)).toBe(5);
  });

  it('o balde SEM LOTE é o ÚLTIMO recurso — a pendência diminui, não cresce', () => {
    const declarado = lote('DECLARADO', somarDias(HOJE(), 20));
    entrar(iogurte, 5, declarado.id);
    entrar(iogurte, 5);

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: iogurte, quantity: 5 }],
      payments: [{ method: 'dinheiro', amountCents: 1750 }],
    });

    expect(batchBalance(companyId, declarado.id)).toBe(0);
    expect(saldoSemLote(companyId, iogurte)).toBe(5);
  });

  it('nenhuma fonte sozinha cobre: RECUSA com a conta na mão, e nada é baixado', () => {
    const a = lote('A', somarDias(HOJE(), 10));
    const b = lote('B', somarDias(HOJE(), 20));
    entrar(iogurte, 3, a.id);
    entrar(iogurte, 4, b.id);

    expect(() =>
      createSale({
        companyId,
        userId,
        idempotencyKey: randomUUID(),
        items: [{ productId: iogurte, quantity: 6 }],
        payments: [{ method: 'dinheiro', amountCents: 2100 }],
      }),
    ).toThrow(/Nenhum lote sozinho cobre 6/);

    // O saldo total daria — o que não dá é sair de um lote só. E nada moveu.
    expect(getBalance(companyId, iogurte)).toBe(7);
    expect(batchBalance(companyId, a.id)).toBe(3);
    expect(batchBalance(companyId, b.id)).toBe(4);
  });
});

describe('lote vencido não sai pela venda — e tem por onde sair', () => {
  it('só há saldo vencido: a venda é recusada, com o caminho na mensagem', () => {
    const velho = lote('VELHO', somarDias(HOJE(), -1));
    entrar(iogurte, 10, velho.id);

    expect(() =>
      createSale({
        companyId,
        userId,
        idempotencyKey: randomUUID(),
        items: [{ productId: iogurte, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 350 }],
      }),
    ).toThrow(/vencid/i);
    expect(getBalance(companyId, iogurte)).toBe(10);
  });

  it('o lote que vence HOJE ainda vende: o dia impresso é o último dia bom', () => {
    const hoje = lote('HOJE', HOJE());
    entrar(iogurte, 4, hoje.id);

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: iogurte, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 350 }],
    });
    expect(batchBalance(companyId, hoje.id)).toBe(3);
  });

  it('com um lote bom ao lado, o FEFO pula o vencido em vez de travar o caixa', () => {
    const velho = lote('VELHO', somarDias(HOJE(), -5));
    const bom = lote('BOM', somarDias(HOJE(), 20));
    entrar(iogurte, 10, velho.id);
    entrar(iogurte, 10, bom.id);

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: iogurte, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 700 }],
    });

    expect(batchBalance(companyId, bom.id)).toBe(8);
    expect(batchBalance(companyId, velho.id)).toBe(10);
  });

  it('nomear o lote vencido na VENDA não fura a trava', () => {
    const velho = lote('VELHO', somarDias(HOJE(), -2));
    entrar(iogurte, 5, velho.id);
    expect(() =>
      applyMovement({
        companyId,
        productId: iogurte,
        movementType: 'out',
        quantity: 1,
        referenceType: 'sale',
        referenceId: randomUUID(),
        kind: 'SALE',
        batchId: velho.id,
        userId,
      }),
    ).toThrow(/venceu em/i);
  });

  it('a PERDA leva o vencido embora — é a porta que a trava exige que exista', () => {
    const velho = lote('VELHO', somarDias(HOJE(), -2));
    entrar(iogurte, 5, velho.id);

    applyMovement({
      companyId,
      productId: iogurte,
      movementType: 'out',
      quantity: 5,
      referenceType: 'perda',
      referenceId: randomUUID(),
      kind: 'MANUAL_EXIT',
      reason: 'Vencido — descarte',
      batchId: velho.id,
      userId,
    });

    expect(batchBalance(companyId, velho.id)).toBe(0);
    expect(getBalance(companyId, iogurte)).toBe(0);
  });

  it('a perda SEM escolher lote descarta o mais velho, inclusive vencido', () => {
    const velho = lote('VELHO', somarDias(HOJE(), -3));
    const bom = lote('BOM', somarDias(HOJE(), 30));
    entrar(iogurte, 6, velho.id);
    entrar(iogurte, 6, bom.id);

    applyMovement({
      companyId,
      productId: iogurte,
      movementType: 'out',
      quantity: 6,
      referenceType: 'perda',
      referenceId: randomUUID(),
      kind: 'MANUAL_EXIT',
      reason: 'Descarte da geladeira',
      userId,
    });

    expect(batchBalance(companyId, velho.id)).toBe(0);
    expect(batchBalance(companyId, bom.id)).toBe(6);
  });

  it('o ACERTO DE CONTAGEM absorve o vencido — senão a contagem trava inteira', async () => {
    /*
      O BECO SEM SAÍDA QUE ESTE CASO FECHA, e ele quase nasceu: a primeira
      versão da lista de exceções dizia 'inventario', um rótulo que não existe
      em lugar nenhum do projeto — o acerto grava 'inventory_count'. A loja
      contaria a geladeira, encontraria menos porque o iogurte vencido foi para
      o lixo, e o acerto seria RECUSADO com uma mensagem sobre venda de produto
      vencido. A contagem inteira ficaria travada.
    */
    const velho = lote('VENCEU', somarDias(HOJE(), -4));
    entrar(iogurte, 10, velho.id);

    const abertura = await request(app)
      .post('/api/v1/core/inventory-counts')
      .set(auth)
      .send({ productIds: [iogurte], scopeNote: 'Geladeira' });
    expect(abertura.status).toBe(201);
    const countId = abertura.body.id;

    await request(app)
      .post(`/api/v1/core/inventory-counts/${countId}/items`)
      .set(auth)
      .send({ productId: iogurte, countedQuantity: 6 });

    const aplicou = await request(app)
      .post(`/api/v1/core/inventory-counts/${countId}/apply`)
      .set(auth)
      .send({ reason: 'Descarte de vencido conferido na contagem' });
    expect(aplicou.status).toBe(200);

    expect(getBalance(companyId, iogurte)).toBe(6);
    expect(batchBalance(companyId, velho.id)).toBe(6);
  });

  it('receber num lote JÁ VENCIDO é permitido: é a caixa que chegou vencida', () => {
    const velho = lote('CHEGOU-VENCIDO', somarDias(HOJE(), -10));
    // Recusar a entrada empurraria o conferente a lançar sem lote, e a
    // mercadoria vencida sumiria do único relatório que a mostra.
    expect(() => entrar(iogurte, 12, velho.id)).not.toThrow();
    expect(batchBalance(companyId, velho.id)).toBe(12);
    expect(batchAlerts(companyId).faixas.find((f) => f.faixa === 'vencido')?.quantity).toBe(12);
  });
});

describe('tenant: o lote da empresa A é invisível e inconsumível pela B', () => {
  it('a empresa B não consegue consumir nem enxergar o lote da A', async () => {
    const daA = lote('SEGREDO-A', somarDias(HOJE(), 30));
    entrar(iogurte, 10, daA.id);

    const outra = await loginForTest(app, {
      userId: 'gerente-outra',
      companyId: 'loja-outra',
      profileCodes: ['gerente_loja'],
    });
    const authB = { Authorization: `Bearer ${outra.body.accessToken}` };
    const companyB = outra.body.company.id;
    const iogurteB = String(
      createProduct(companyB, { name: 'Iogurte da B', priceCents: 400, costCents: 250 }).id,
    );
    setBatchControl({ companyId: companyB, productId: iogurteB, tracksBatches: true });

    // Invisível: nem a listagem nem a ficha do lote atravessam a fronteira.
    expect(listBatches(companyB)).toEqual([]);
    const ficha = await request(app)
      .get(`/api/v1/core/stock/batches/${daA.id}`)
      .set(authB);
    expect(ficha.status).toBe(404);

    // Inconsumível: nem pelo serviço, nem pela rota de movimento.
    expect(() =>
      applyMovement({
        companyId: companyB,
        productId: iogurteB,
        movementType: 'in',
        quantity: 1,
        referenceType: 'entrada',
        referenceId: randomUUID(),
        batchId: daA.id,
      }),
    ).toThrow(/não encontrado/i);

    // E o saldo da A não se mexeu.
    expect(batchBalance(companyId, daA.id)).toBe(10);
  });
});

describe('conferência: quem olhou a caixa, e quando', () => {
  it('o carimbo guarda autor e hora, e conferir de novo não rouba a autoria', () => {
    const l = lote('L-CONF', somarDias(HOJE(), 20));
    const primeira = markBatchChecked({ companyId, batchId: l.id, userId });
    expect(primeira.duplicated).toBe(false);
    expect(primeira.batch.checked_by).toBe(userId);
    expect(primeira.batch.checked_at).toBeTruthy();

    const segunda = markBatchChecked({ companyId, batchId: l.id, userId: 'outra-pessoa' });
    expect(segunda.duplicated).toBe(true);
    expect(segunda.batch.checked_by).toBe(userId);
    expect(segunda.batch.checked_at).toBe(primeira.batch.checked_at);
  });

  it('o alerta conta quantos lotes COM SALDO ainda não foram conferidos', () => {
    const a = lote('A', somarDias(HOJE(), 20));
    const b = lote('B', somarDias(HOJE(), 20));
    entrar(iogurte, 5, a.id);
    entrar(iogurte, 5, b.id);
    expect(batchAlerts(companyId).naoConferidos).toBe(2);

    markBatchChecked({ companyId, batchId: a.id, userId });
    expect(batchAlerts(companyId).naoConferidos).toBe(1);
  });
});

describe('alerta e relatório: vencido, 7, 15 e 30 dias', () => {
  it('a régua em TypeScript e a do SQL dizem a mesma coisa', () => {
    const hoje = HOJE();
    expect(faixaDaValidade(somarDias(hoje, -1), hoje)).toBe('vencido');
    expect(faixaDaValidade(hoje, hoje)).toBe('vence_em_7');
    expect(faixaDaValidade(somarDias(hoje, 7), hoje)).toBe('vence_em_7');
    expect(faixaDaValidade(somarDias(hoje, 8), hoje)).toBe('vence_em_15');
    expect(faixaDaValidade(somarDias(hoje, 16), hoje)).toBe('vence_em_30');
    expect(faixaDaValidade(somarDias(hoje, 31), hoje)).toBe('em_dia');
    expect(faixaDaValidade(null, hoje)).toBe('sem_validade');
  });

  it('cada faixa traz lotes, estoque e valor em CENTAVOS INTEIROS', () => {
    const vencido = lote('V', somarDias(HOJE(), -1));
    const em3 = lote('S3', somarDias(HOJE(), 3));
    const em12 = lote('S12', somarDias(HOJE(), 12));
    const em25 = lote('S25', somarDias(HOJE(), 25));
    const emDia = lote('OK', somarDias(HOJE(), 200));
    // Meio quilo em cada: o arredondamento por lote é o que faz o rodapé bater.
    for (const l of [vencido, em3, em12, em25, emDia]) entrar(iogurte, 2.5, l.id);

    const faixas = new Map(batchAlerts(companyId).faixas.map((f) => [f.faixa, f]));
    expect(faixas.get('vencido')!.lotes).toBe(1);
    expect(faixas.get('vence_em_7')!.lotes).toBe(1);
    expect(faixas.get('vence_em_15')!.lotes).toBe(1);
    expect(faixas.get('vence_em_30')!.lotes).toBe(1);
    expect(faixas.get('em_dia')!.lotes).toBe(1);

    // 2,5 × 200 centavos = 500 centavos exatos, arredondado POR LOTE.
    for (const f of faixas.values()) {
      if (f.lotes === 0) continue;
      expect(f.valueCents).toBe(500);
      expect(Number.isInteger(f.valueCents)).toBe(true);
    }
  });

  it('TODA faixa aparece, mesmo zerada — tela que às vezes tem a linha mente', () => {
    const alerta = batchAlerts(companyId);
    expect(alerta.faixas.map((f) => f.faixa)).toEqual([
      'vencido',
      'vence_em_7',
      'vence_em_15',
      'vence_em_30',
      'em_dia',
      'sem_validade',
    ]);
  });

  it('lote zerado não grita: ele já foi embora da prateleira', () => {
    const l = lote('SAIU', somarDias(HOJE(), 2));
    entrar(iogurte, 4, l.id);
    applyMovement({
      companyId,
      productId: iogurte,
      movementType: 'out',
      quantity: 4,
      referenceType: 'perda',
      referenceId: randomUUID(),
      reason: 'quebra',
      batchId: l.id,
      userId,
    });

    expect(batchAlerts(companyId).faixas.find((f) => f.faixa === 'vence_em_7')!.lotes).toBe(0);
    expect(listBatches(companyId)).toEqual([]);
    expect(listBatches(companyId, { incluirZerados: true })).toHaveLength(1);
  });

  it('o filtro por faixa acontece no SQL, e a lista sai em ordem de validade', () => {
    lote('TARDE', somarDias(HOJE(), 100));
    const cedo = lote('CEDO', somarDias(HOJE(), 2));
    entrar(iogurte, 1, cedo.id);
    entrar(iogurte, 1, listBatches(companyId, { incluirZerados: true }).find((b) => b.code === 'TARDE')!.id);

    const todos = listBatches(companyId);
    expect(todos.map((b) => b.code)).toEqual(['CEDO', 'TARDE']);
    expect(listBatches(companyId, { faixa: 'vence_em_7' }).map((b) => b.code)).toEqual(['CEDO']);
    expect(listBatches(companyId, { faixa: 'vencido' })).toEqual([]);
  });
});

describe('alocação: o saldo sem lote ganha lote, sem UPDATE no razão', () => {
  it('um PAR de movimentos, saldo total intacto e pendência menor', () => {
    entrar(iogurte, 20); // como se tivesse chegado por nota fiscal
    expect(pendenciasSemLote(companyId)).toHaveLength(1);
    expect(pendenciasSemLote(companyId)[0].quantity).toBe(20);

    const l = lote('DOCA-1', somarDias(HOJE(), 45));
    allocateToBatch({ companyId, productId: iogurte, batchId: l.id, quantity: 12, userId });

    expect(getBalance(companyId, iogurte)).toBe(20);
    expect(batchBalance(companyId, l.id)).toBe(12);
    expect(saldoSemLote(companyId, iogurte)).toBe(8);
    // As duas pernas ficam no histórico: o razão diz o que aconteceu, e nada
    // do passado foi reescrito.
    const linhas = historico(iogurte);
    expect(linhas).toHaveLength(3);
    expect(linhas.filter((m) => m.batch_id === l.id)).toHaveLength(1);
  });

  it('não dá para alocar mais do que existe sem lote', () => {
    entrar(iogurte, 5);
    const l = lote('DOCA-2', somarDias(HOJE(), 45));
    expect(() =>
      allocateToBatch({ companyId, productId: iogurte, batchId: l.id, quantity: 9, userId }),
    ).toThrow(/não dá para alocar/i);
  });

  it('a alocação não rouba saldo de lote já declarado', () => {
    const antigo = lote('ANTIGO', somarDias(HOJE(), 5));
    entrar(iogurte, 10, antigo.id);
    entrar(iogurte, 10);

    const novo = lote('NOVO', somarDias(HOJE(), 60));
    allocateToBatch({ companyId, productId: iogurte, batchId: novo.id, quantity: 10, userId });

    // O FEFO teria escolhido ANTIGO (vence antes) se a perna de saída não
    // dissesse explicitamente que vem do balde.
    expect(batchBalance(companyId, antigo.id)).toBe(10);
    expect(batchBalance(companyId, novo.id)).toBe(10);
    expect(saldoSemLote(companyId, iogurte)).toBe(0);
  });
});

describe('o interruptor do controle de lote', () => {
  it('produto controlado por unidade não aceita lote — seriam duas escolhas', () => {
    const moto = String(
      createProduct(companyId, { name: 'Moto 160', priceCents: 1_500_000, serialized: true }).id,
    );
    expect(() =>
      setBatchControl({ companyId, productId: moto, tracksBatches: true, userId }),
    ).toThrow(/controlado por unidade/i);
  });

  it('serviço de balcão não tem lote: não há movimento para carregá-lo', () => {
    const servico = String(
      createProduct(companyId, {
        name: 'Instalação de película',
        priceCents: 5000,
        stockControl: false,
      }).id,
    );
    expect(() =>
      setBatchControl({ companyId, productId: servico, tracksBatches: true, userId }),
    ).toThrow(/não controla estoque/i);
  });

  it('DESLIGAR não apaga o passado: o movimento antigo continua dizendo o lote', () => {
    const l = lote('L-DESLIGA', somarDias(HOJE(), 30));
    entrar(iogurte, 5, l.id);
    setBatchControl({ companyId, productId: iogurte, tracksBatches: false, userId });

    const antiga = historico(iogurte)[0];
    expect(antiga.batch_id).toBe(l.id);
    // E a saída nova deixa de escolher lote, sem quebrar nada.
    entrar(iogurte, 3);
    expect(historico(iogurte)[1].batch_id).toBeNull();
  });
});

describe('as rotas: guarda, idempotência e trilha', () => {
  it('a entrada manual cria o lote pelo CÓDIGO lido na embalagem', async () => {
    const res = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth)
      .send({
        productId: iogurte,
        movementType: 'in',
        quantity: 6,
        referenceType: 'entrada',
        referenceId: randomUUID(),
        batchCode: 'FORN-2409',
        expiresOn: somarDias(HOJE(), 25),
      });
    expect(res.status).toBe(201);

    const lotes = listBatches(companyId, { productId: iogurte });
    expect(lotes).toHaveLength(1);
    expect(lotes[0].code).toBe('FORN-2409');
    expect(lotes[0].quantity).toBe(6);
    expect(lotes[0].faixa).toBe('vence_em_30');
  });

  it('numa SAÍDA, código de lote inexistente é recusa — não cria lote negativo', async () => {
    entrar(iogurte, 5);
    const res = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth)
      .send({
        productId: iogurte,
        movementType: 'out',
        quantity: 1,
        referenceType: 'perda',
        referenceId: randomUUID(),
        reason: 'quebrou',
        batchCode: 'NAO-EXISTE',
      });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('CORE_BATCH_NOT_FOUND');
    expect(listBatches(companyId, { incluirZerados: true })).toEqual([]);
  });

  it('a listagem, o alerta e as pendências chegam pela mesma porta da tela', async () => {
    const l = lote('ROTA-1', somarDias(HOJE(), 4));
    entrar(iogurte, 2, l.id);
    entrar(iogurte, 3);

    const lista = await request(app).get('/api/v1/core/stock/batches').set(auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);

    const alerta = await request(app).get('/api/v1/core/stock/batches/alertas').set(auth);
    expect(alerta.status).toBe(200);
    expect(alerta.body.hoje).toBe(HOJE());
    expect(alerta.body.pendencias).toHaveLength(1);
    expect(alerta.body.quantidadeSemLote).toBe(3);
  });

  it('conferir pela rota grava a trilha UMA vez, e o segundo clique responde 200', async () => {
    const l = lote('ROTA-CONF', somarDias(HOJE(), 10));
    const primeira = await request(app)
      .post(`/api/v1/core/stock/batches/${l.id}/conferir`)
      .set(auth)
      .send({});
    expect(primeira.status).toBe(201);
    const segunda = await request(app)
      .post(`/api/v1/core/stock/batches/${l.id}/conferir`)
      .set(auth)
      .send({});
    expect(segunda.status).toBe(200);
    expect(segunda.body.duplicated).toBe(true);

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'stock.batch.check'")
      .get() as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('a mudança de validade deixa o DE/PARA na auditoria', async () => {
    const l = lote('ROTA-VAL', somarDias(HOJE(), 5));
    const nova = somarDias(HOJE(), 40);
    const res = await request(app)
      .patch(`/api/v1/core/stock/batches/${l.id}`)
      .set(auth)
      .send({ expiresOn: nova });
    expect(res.status).toBe(200);

    const linha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'stock.batch.update'")
      .get() as { detail: string };
    const detalhe = JSON.parse(linha.detail);
    expect(detalhe.expiresOn.de).toBe(somarDias(HOJE(), 5));
    expect(detalhe.expiresOn.para).toBe(nova);
  });

  it('o caixa não cadastra lote: a escrita é de quem organiza a prateleira', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-validade',
      companyId: 'loja-validade',
      profileCodes: ['operador_caixa_loja'],
    });
    const res = await request(app)
      .post('/api/v1/core/stock/batches')
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` })
      .send({ productId: iogurte, code: 'X', expiresOn: somarDias(HOJE(), 10) });
    expect(res.status).toBe(403);
  });

  it('o interruptor liga o controle pela tela do produto e grava a trilha', async () => {
    const res = await request(app)
      .patch(`/api/v1/core/stock/batch-control/${parafuso}`)
      .set(auth)
      .send({ tracksBatches: true });
    expect(res.status).toBe(200);
    expect(res.body.tracksBatches).toBe(true);

    const linha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'product.batch_control'")
      .get() as { n: number };
    expect(linha.n).toBe(1);
  });
});
