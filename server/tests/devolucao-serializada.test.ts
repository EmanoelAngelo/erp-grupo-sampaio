/**
 * Devolução de peça IDENTIFICADA — a moto que volta, e a que fica.
 *
 * ## O que este arquivo existe para provar
 *
 * Devolver mercadoria comum é uma conta: entra 2, sai 2. Devolver uma MOTO não
 * é: cada uma tem chassi, plaquinha na oficina e um dono no portal. Duas
 * afirmações que fecham no saldo podem estar as duas erradas sobre qual moto
 * está no pátio.
 *
 * Três defeitos reais, todos invisíveis em qualquer relatório de estoque:
 *
 *  1. A devolução "com defeito" (a caixinha "Não — com defeito" da tela) pulava
 *     o estoque inteiro. Junto com o saldo, pulava a plaquinha: o cliente
 *     recebia o dinheiro de volta, entregava a moto, e CONTINUAVA sendo o dono
 *     dela no portal da oficina — via o histórico e podia abrir chamado para
 *     uma moto parada no pátio da loja. Sem saída: `desvincularUnidade` recusa
 *     por status da unidade e por `sale_status` da plaquinha.
 *
 *  2. A devolução parcial escolhia a moto por sorteio (`.slice(0, quantidade)`
 *     numa consulta sem ordem). Cliente compra duas iguais, devolve a de chassi
 *     B, e o sistema podia registrar a A: o pátio fica com a B, a plaquinha da
 *     A é vendida a outro comprador carregando o chassi de uma moto que está na
 *     garagem do primeiro, e o portal do primeiro passa a mostrar a moto do
 *     pátio.
 *
 *  3. A baixa de unidade não soltava a plaquinha. Ela ficava CONGELADA: some da
 *     lista de adotáveis para sempre, e só o banco à mão desfazia.
 *
 * ## Por que os testes daqui montam DUAS empresas
 *
 * A oficina é outra empresa: a unidade vive na PJ Motors e a plaquinha vive na
 * Oficina, e não existe um `company_id` que contenha as duas. Montar tudo numa
 * empresa só faria a suíte passar por um caminho que a operação nunca percorre.
 *
 * ## Cada `it` foi verificado QUEBRANDO o guarda que ele cobre
 *
 * Comentando a linha ou invertendo a condição, e conferindo que fica vermelho.
 * Teste que continua verde com o guarda desligado não protege nada — só custa
 * tempo e dá coragem falsa a quem lê o resultado da suíte.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { ensureOfficialTagCompanies,
  ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import type { ApiError } from '../src/utils/errors.js';
import { createCustomer, createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement, getBalance } from '../src/services/core/InventoryService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createUnits, getUnit, identifyUnit } from '../src/services/core/ProductUnitService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import {
  plaquinhasVinculaveis,
  vincularUnidade,
} from '../src/services/core/EquipmentStockLink.js';
import { createSaleReturn, returnableItems } from '../src/services/core/SaleReturnService.js';

const SENHA = 'Teste@Devolucao2026';

let loja: string;
let oficinaCo: string;
let mobilidade: string;
let vendedor: string;
let mecanico: string;
let moto: string;
let capacete: string;

/** A recusa como OBJETO: o código é o contrato, a mensagem muda de redação. */
function recusa(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Esperava uma recusa, e a chamada passou.');
}

function linhaPlaquinha(equipmentId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_equipment WHERE id = ?')
    .get(equipmentId) as Record<string, unknown>;
}

function eventosDaPlaquinha(equipmentId: string): string[] {
  return (
    getConnection()
      .prepare(
        'SELECT event_type FROM core_equipment_events WHERE equipment_id = ? ORDER BY created_at, rowid',
      )
      .all(equipmentId) as unknown as { event_type: string }[]
  ).map((e) => e.event_type);
}

function workshopIdOf(slug: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

/** Cria N unidades E o saldo correspondente, que é como a entrada de nota faz. */
function entrarComUnidades(produto: string, quantidade: number, ref: string): string[] {
  const ids = createUnits(loja, produto, quantidade, {
    entryReferenceType: 'ajuste',
    entryReferenceId: ref,
  });
  applyMovement({
    companyId: loja,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'ajuste',
    referenceId: ref,
    unitIds: ids,
  });
  return ids;
}

/**
 * Uma moto pronta para vender: unidade na loja, plaquinha na oficina,
 * vinculadas.
 *
 * O chassi é OPCIONAL porque as duas situações são reais, e as duas importam
 * aqui. Com chassi é como o balcão reconhece a moto — é o número bipado, e sem
 * ele o teste não conseguiria dizer QUAL moto voltou. Sem chassi é o estado em
 * que a unidade nasce: a nota de entrada traz "3 motos" muito antes de alguém ir
 * ao pátio ler os números.
 */
function motoComPlaquinha(ref: string, chassi?: string) {
  const [unitId] = entrarComUnidades(moto, 1, ref);
  if (chassi) identifyUnit(loja, unitId, { chassis: chassi, userId: vendedor });
  const plaquinha = createEquipment({
    companyId: oficinaCo,
    workshopId: mobilidade,
    userId: mecanico,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'PJ Motors',
    model: 'Sport 3000',
    chassis: chassi,
  });
  vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });
  return { unitId, equipmentId: plaquinha.id, chassi };
}

function comprador(nome: string, documento: string): string {
  return String(createCustomer(loja, { name: nome, document: documento }).id);
}

function vender(unitIds: string[], chave: string, customerId: string): string {
  const { sale } = createSale({
    companyId: loja,
    userId: vendedor,
    customerId,
    items: [{ productId: moto, quantity: unitIds.length, unitIds }],
    payments: [{ method: 'dinheiro', amountCents: 1_800_000 * unitIds.length }],
    idempotencyKey: chave,
  });
  return sale.id;
}

/** O id da linha da venda — é por ele que a devolução fala. */
function linhaDaVenda(saleId: string, productId: string): string {
  return (
    getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ? AND product_id = ?')
      .get(saleId, productId) as { id: string }
  ).id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  loja = upsertCompany({
    slug: 'pj-motors-dev',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
    kind: 'store',
  });
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  ensureOfficialWorkshops();
  // A regra de ouro do dono (rodada 53): PJ Motors e Oficina usam
  // plaquinha. O teste monta um grupo de mentira e tem de dizer o mesmo
  // que o seed diz.
  ensureOfficialTagCompanies();
  // A loja deste arquivo usa o slug `pj-motors-dev`, que a marca oficial nao
  // alcanca: aqui ela e dita a mao.
  getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1 WHERE id = ?').run(loja);
  mobilidade = workshopIdOf('oficina-mobilidade');

  vendedor = await upsertUser({ login: 'BALCAO_DEV', displayName: 'Balcão', password: SENHA });
  linkUserToCompany(vendedor, loja, 'gerente_loja', true);
  mecanico = await upsertUser({ login: 'MEC_DEV', displayName: 'Mecânico', password: SENHA });
  linkUserToCompany(mecanico, oficinaCo, 'gerente_oficina', true);

  moto = createProduct(loja, { name: 'Honda CG 160', priceCents: 1_800_000 }).id;
  updateProduct(loja, moto, { serialized: true });
  capacete = createProduct(loja, { name: 'Capacete', priceCents: 30_000 }).id;
});

/* ------------------------------------------- a moto que volta é a que voltou */

describe('a devolução não escolhe a moto por sorteio', () => {
  /**
   * A MESMA REGRA QUE A SAÍDA JÁ IMPÕE.
   *
   * `applyMovement` recusa toda saída de serializado sem `unitIds`. A devolução
   * era a única ENTRADA que contornava isso — e é entrada de peça identificada,
   * com o operador no balcão e a moto na frente.
   */
  it('devolver serializado sem dizer QUAL peça é recusado', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId], 'v1', dono);

    const err = recusa(() =>
      createSaleReturn({
        companyId: loja,
        userId: vendedor,
        saleId,
        reason: 'Arrependimento',
        items: [{ saleItemId: linhaDaVenda(saleId, moto), quantity: 1 }],
      }),
    );
    expect(err.code).toBe('CORE_RETURN_UNITS_REQUIRED');
    expect(err.status).toBe(400);

    // E nada aconteceu: a recusa é ANTES de qualquer escrita.
    expect(getBalance(loja, moto)).toBe(0);
    expect(getUnit(loja, a.unitId)!.status).toBe('sold');
  });

  it('a quantidade tem de bater com o tamanho da lista bipada', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId, b.unitId], 'v1', dono);

    // Duas peças na devolução, uma bipada. Deixar passar seria voltar ao
    // sorteio para a segunda.
    const err = recusa(() =>
      createSaleReturn({
        companyId: loja,
        userId: vendedor,
        saleId,
        reason: 'Devolveu as duas',
        items: [{ saleItemId: linhaDaVenda(saleId, moto), quantity: 2, unitIds: [a.unitId] }],
      }),
    );
    expect(err.code).toBe('CORE_RETURN_UNITS_REQUIRED');
    expect(getBalance(loja, moto)).toBe(0);
  });

  /**
   * O CASO CENTRAL DO DEFEITO.
   *
   * Duas motos iguais na mesma venda, o cliente devolve a B. Se o código
   * escolhesse, a A voltaria — e as duas contas continuariam fechando.
   */
  it('volta EXATAMENTE a moto bipada, e a outra continua vendida', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId, b.unitId], 'v1', dono);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Devolveu a segunda moto',
      items: [{ saleItemId: linhaDaVenda(saleId, moto), quantity: 1, unitIds: [b.unitId] }],
    });

    // O saldo sobe 1 nas duas hipóteses; é a IDENTIDADE que separa o certo do
    // errado, e por isso o teste olha unidade por unidade.
    expect(getBalance(loja, moto)).toBe(1);
    expect(getUnit(loja, b.unitId)!.status).toBe('in_stock');
    expect(getUnit(loja, a.unitId)!.status).toBe('sold');

    // E do lado da oficina: a plaquinha da moto que ficou com o cliente
    // continua tendo dono; a da que voltou, não.
    expect(linhaPlaquinha(a.equipmentId).sale_status).toBe('SOLD');
    expect(linhaPlaquinha(a.equipmentId).owner_customer_id).not.toBeNull();
    expect(linhaPlaquinha(b.equipmentId).sale_status).toBe('NOT_SOLD');
    expect(linhaPlaquinha(b.equipmentId).owner_customer_id).toBeNull();
  });

  it('peça de OUTRA venda é recusada', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const outro = comprador('Outro', '39053344705');
    const venda1 = vender([a.unitId], 'v1', dono);
    vender([b.unitId], 'v2', outro);

    // Aceitar devolveria uma moto que ESTE cliente nunca levou, com dinheiro
    // saindo do caixa por isso — e soltaria a plaquinha do outro comprador.
    const err = recusa(() =>
      createSaleReturn({
        companyId: loja,
        userId: vendedor,
        saleId: venda1,
        reason: 'Peça da outra venda',
        items: [{ saleItemId: linhaDaVenda(venda1, moto), quantity: 1, unitIds: [b.unitId] }],
      }),
    );
    expect(err.code).toBe('CORE_RETURN_UNIT_NOT_IN_SALE');
    expect(err.status).toBe(409);
    expect(getUnit(loja, b.unitId)!.status).toBe('sold');
    expect(linhaPlaquinha(b.equipmentId).sale_status).toBe('SOLD');
  });

  it('a mesma peça não volta duas vezes', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId, b.unitId], 'v1', dono);
    const linha = linhaDaVenda(saleId, moto);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Primeira parcial',
      items: [{ saleItemId: linha, quantity: 1, unitIds: [a.unitId] }],
    });

    // A quantidade ainda permite (vendeu 2, voltou 1), então quem barra é a
    // peça: ela já está de volta no estoque e não saiu nesta venda de novo.
    const err = recusa(() =>
      createSaleReturn({
        companyId: loja,
        userId: vendedor,
        saleId,
        reason: 'Mesma peça de novo',
        items: [{ saleItemId: linha, quantity: 1, unitIds: [a.unitId] }],
      }),
    );
    expect(err.code).toBe('CORE_RETURN_UNIT_NOT_IN_SALE');
    expect(getBalance(loja, moto)).toBe(1);
  });

  /**
   * A MESMA MOTO CONTADA DUAS VEZES.
   *
   * O tamanho bate com a quantidade, então o guarda do tamanho deixa passar. Sem
   * a conferência de repetição, uma moto voltaria como se fossem duas: o saldo
   * subiria 2 com uma peça no pátio, e a segunda "devolução" da mesma unidade
   * ficaria sem lastro.
   */
  it('a mesma peça bipada duas vezes na mesma linha é recusada', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId, b.unitId], 'v1', dono);

    const err = recusa(() =>
      createSaleReturn({
        companyId: loja,
        userId: vendedor,
        saleId,
        reason: 'Bipou a mesma moto duas vezes',
        items: [
          { saleItemId: linhaDaVenda(saleId, moto), quantity: 2, unitIds: [a.unitId, a.unitId] },
        ],
      }),
    );
    expect(err.code).toBe('CORE_UNIT_REPEATED');
    expect(err.status).toBe(400);
    expect(getBalance(loja, moto)).toBe(0);
  });

  /** Produto sem controle por unidade continua sendo uma conta, e só. */
  it('produto comum não passa a exigir peça bipada', () => {
    applyMovement({
      companyId: loja,
      productId: capacete,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga-capacete',
    });
    const dono = comprador('Comprador', '52998224725');
    const { sale } = createSale({
      companyId: loja,
      userId: vendedor,
      customerId: dono,
      items: [{ productId: capacete, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 60_000 }],
      idempotencyKey: 'v-capacete',
    });

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId: sale.id,
      reason: 'Não serviu',
      items: [{ saleItemId: linhaDaVenda(sale.id, capacete), quantity: 1 }],
    });
    expect(getBalance(loja, capacete)).toBe(9);
  });

  /**
   * A TELA PRECISA OFERECER O QUE O SERVIDOR EXIGE.
   *
   * Exigir a peça sem devolver a lista faria o operador adivinhar um UUID: a
   * recusa seria correta e a tela, inútil.
   */
  it('a consulta da tela traz as peças daquela venda, com chassi', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId, b.unitId], 'v1', dono);

    const linha = returnableItems(loja, saleId).find((i) => i.product_id === moto)!;
    expect(linha.serialized).toBe(1);
    const oferecidas = linha.units as { id: string; chassis: string | null }[];
    expect(oferecidas.map((u) => u.chassis).sort()).toEqual(['CHASSI-A', 'CHASSI-B']);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Devolveu a A',
      items: [{ saleItemId: linhaDaVenda(saleId, moto), quantity: 1, unitIds: [a.unitId] }],
    });

    // Peça que já voltou não é oferecida de novo: oferecer seria oferecer a
    // recusa.
    const depois = returnableItems(loja, saleId).find((i) => i.product_id === moto)!;
    expect((depois.units as { chassis: string | null }[]).map((u) => u.chassis)).toEqual([
      'CHASSI-B',
    ]);
  });

  it('produto comum não vem com lista de peças', () => {
    applyMovement({
      companyId: loja,
      productId: capacete,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'carga-capacete',
    });
    const dono = comprador('Comprador', '52998224725');
    const { sale } = createSale({
      companyId: loja,
      userId: vendedor,
      customerId: dono,
      items: [{ productId: capacete, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 30_000 }],
      idempotencyKey: 'v-capacete',
    });
    const linha = returnableItems(loja, sale.id).find((i) => i.product_id === capacete)!;
    expect(linha.serialized).toBe(0);
    expect(linha.units).toEqual([]);
  });
});

/* ------------------------------- a devolução com defeito solta a plaquinha */

describe('devolução com defeito: o saldo não sobe, e o dono deixa de ser dono', () => {
  /**
   * O DEFEITO INTEIRO, EM UM TESTE.
   *
   * O cliente recebeu o dinheiro, entregou a moto, e continuava sendo o dono
   * dela no portal — via o histórico e podia abrir chamado para uma moto parada
   * no pátio da loja.
   */
  it('o cliente deixa de constar como dono, e o saldo continua sem subir', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId], 'v1', dono);
    expect(linhaPlaquinha(a.equipmentId).sale_status).toBe('SOLD');

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Motor fundido',
      items: [
        { saleItemId: linhaDaVenda(saleId, moto), quantity: 1, restock: false, unitIds: [a.unitId] },
      ],
    });

    // A razão de existir da caixinha: peça quebrada NÃO vira saldo vendável.
    expect(getBalance(loja, moto)).toBe(0);

    // O que muda é a propriedade: a moto está no pátio da loja, e o portal do
    // cliente tem de parar de mostrá-la como dele.
    const linha = linhaPlaquinha(a.equipmentId);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();
    expect(linha.sold_at).toBeNull();
    expect(linha.sale_id).toBeNull();
  });

  it('a unidade fica baixada — voltou fisicamente, e não é vendável', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId], 'v1', dono);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Motor fundido',
      items: [
        { saleItemId: linhaDaVenda(saleId, moto), quantity: 1, restock: false, unitIds: [a.unitId] },
      ],
    });

    const unidade = getUnit(loja, a.unitId)!;
    expect(unidade.status).toBe('baixada');
    // Nem `sold` (o cliente devolveu) nem `in_stock` (não pode ser vendida).
    expect(unidade.status).not.toBe('sold');
    expect(unidade.status).not.toBe('in_stock');
  });

  /**
   * SEM ISTO, A PLAQUINHA CONGELA.
   *
   * `plaquinhasVinculaveis` exclui toda plaquinha com unidade apontando para
   * ela, e `desvincularUnidade` recusa soltar unidade fora do estoque. A moto
   * sumiria da lista de adotáveis para sempre.
   */
  it('a plaquinha se solta e volta a poder ser adotada por outra unidade', () => {
    // SEM CHASSI DE PROPÓSITO, e a razão é uma limitação real: o índice único
    // de `chassis` em `core_product_units` não olha o status, e a unidade
    // baixada continua guardando o número. Enquanto ela existir, nenhuma
    // unidade nova daquela mesma moto consegue nascer com o mesmo chassi — e
    // `identifyUnit` recusa corrigir unidade fora do estoque. A soltura da
    // plaquinha é o que este teste prova; a identidade presa na unidade baixada
    // é outra dívida, e fica nomeada aqui em vez de escondida atrás de um teste
    // arranjado para não esbarrar nela.
    const a = motoComPlaquinha('e1');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId], 'v1', dono);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Motor fundido',
      items: [
        { saleItemId: linhaDaVenda(saleId, moto), quantity: 1, restock: false, unitIds: [a.unitId] },
      ],
    });

    expect(getUnit(loja, a.unitId)!.equipment_id).toBeNull();
    const linha = linhaPlaquinha(a.equipmentId);
    // `origin_company_id` é o campo COM LEITOR: é ele que faz
    // `plaquinhasVinculaveis` esconder a plaquinha, e por isso é ele que precisa
    // estar limpo para a asserção seguinte valer.
    expect(linha.origin_company_id).toBeNull();
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).toContain(a.equipmentId);

    const [nova] = entrarComUnidades(moto, 1, 'e-nova');
    expect(() =>
      vincularUnidade({
        companyId: loja,
        unitId: nova,
        equipmentId: a.equipmentId,
        userId: vendedor,
      }),
    ).not.toThrow();
  });

  it('o histórico da plaquinha conta as duas coisas: venda desfeita e baixa', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId], 'v1', dono);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'Motor fundido',
      items: [
        { saleItemId: linhaDaVenda(saleId, moto), quantity: 1, restock: false, unitIds: [a.unitId] },
      ],
    });

    // Apagar a passagem seria mentir sobre a moto: houve dono, e ele deixou de
    // ser. E a baixa explica por que a plaquinha ficou solta.
    const eventos = eventosDaPlaquinha(a.equipmentId);
    expect(eventos).toContain('sold');
    expect(eventos).toContain('sale_reverted');
    expect(eventos).toContain('stock_written_off');
  });

  /** Devolver com defeito UMA de duas não pode soltar a plaquinha da outra. */
  it('a moto que ficou com o cliente não é tocada', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const b = motoComPlaquinha('e2', 'CHASSI-B');
    const dono = comprador('Comprador', '52998224725');
    const saleId = vender([a.unitId, b.unitId], 'v1', dono);

    createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId,
      reason: 'A segunda veio com defeito',
      items: [
        { saleItemId: linhaDaVenda(saleId, moto), quantity: 1, restock: false, unitIds: [b.unitId] },
      ],
    });

    expect(getUnit(loja, a.unitId)!.status).toBe('sold');
    expect(getUnit(loja, a.unitId)!.equipment_id).toBe(a.equipmentId);
    expect(linhaPlaquinha(a.equipmentId).sale_status).toBe('SOLD');
    expect(getUnit(loja, b.unitId)!.status).toBe('baixada');
  });

  /** Mercadoria comum com defeito continua sendo só "o saldo não sobe". */
  it('produto comum com defeito segue sem mexer em nada', () => {
    applyMovement({
      companyId: loja,
      productId: capacete,
      movementType: 'in',
      quantity: 4,
      referenceType: 'entrada',
      referenceId: 'carga-capacete',
    });
    const dono = comprador('Comprador', '52998224725');
    const { sale } = createSale({
      companyId: loja,
      userId: vendedor,
      customerId: dono,
      items: [{ productId: capacete, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 30_000 }],
      idempotencyKey: 'v-capacete',
    });

    const registro = createSaleReturn({
      companyId: loja,
      userId: vendedor,
      saleId: sale.id,
      reason: 'Casco trincado',
      items: [{ saleItemId: linhaDaVenda(sale.id, capacete), quantity: 1, restock: false }],
    });
    expect(getBalance(loja, capacete)).toBe(3);
    expect(registro.total_cents).toBe(30_000);
  });
});

/* ------------------------------- a baixa pendurada no movimento de estoque */

describe('a baixa de unidade solta a plaquinha pelo próprio movimento', () => {
  /**
   * O GANCHO MORA NO `applyMovement`, E NÃO NO CHAMADOR.
   *
   * `POST /units/:id/write-off` — perda, quebra, devolução ao fornecedor — não
   * sabe da existência de plaquinha, e não deveria saber. Pendurar a soltura no
   * único escritor do saldo é o que garante que TODO caminho de baixa a desfaça,
   * na mesma transação: o rollback que desfaz o saldo desfaz o vínculo.
   *
   * Este teste NÃO chama `baixarPelaUnidade`. É essa ausência que ele prova.
   */
  it('baixar pelo movimento desfaz o vínculo, sem ninguém pedir', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');

    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      referenceId: a.unitId,
      kind: 'INVENTORY_ADJUSTMENT_NEGATIVE',
      reason: 'Roubada do pátio',
      userId: vendedor,
      unitIds: [a.unitId],
    });

    expect(getUnit(loja, a.unitId)!.status).toBe('baixada');
    expect(getUnit(loja, a.unitId)!.equipment_id).toBeNull();
    const linha = linhaPlaquinha(a.equipmentId);
    // O campo com leitor. Limpo, a plaquinha volta à lista de candidatas — a
    // última asserção deste teste é quem cobra isso.
    expect(linha.origin_company_id).toBeNull();
    // Saiu do estoque, mas NÃO foi vendida: continua sem dono.
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(eventosDaPlaquinha(a.equipmentId)).toContain('stock_written_off');
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).toContain(a.equipmentId);
  });

  /**
   * O CANAL ONLINE TAMBÉM CARIMBA A PLAQUINHA.
   *
   * `venderPelaUnidade` atende os dois canais (ver `REFERENCIAS_QUE_DAO_DONO` em
   * `EquipmentStockLink`), mas quem PERGUNTA é a lista deste arquivo. Enquanto
   * ela dizia só `'sale'`, aquele atendimento era código morto: a moto vendida
   * pelo site saía do estoque e a plaquinha continuava `NOT_SOLD`, sem dono —
   * exatamente o defeito que a ponte existe para matar, só que pelo outro canal.
   *
   * O pedido é gravado direto na tabela porque o caminho real é checkout mais
   * webhook do provedor, e montá-lo aqui arrastaria reserva, FIFO e Asaas para
   * dentro de um teste de devolução. O que a ponte lê do pedido são duas
   * colunas, e é isso que a linha entrega.
   */
  it('a saída por pedido da loja online dá dono à plaquinha', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const compradorOnline = comprador('Compradora Online', '39053344705');

    const pedido = randomUUID();
    const ts = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_orders
           (id, company_id, number, customer_id, customer_name, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(pedido, loja, 1, compradorOnline, 'Compradora Online', `chk-${pedido}`, ts, ts);

    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'out',
      quantity: 1,
      referenceType: 'ecommerce_order',
      referenceId: pedido,
      kind: 'ECOMMERCE_CONSUMPTION',
      userId: vendedor,
      unitIds: [a.unitId],
    });

    const linha = linhaPlaquinha(a.equipmentId);
    expect(linha.sale_status).toBe('SOLD');
    expect(linha.owner_customer_id).not.toBeNull();
    // `sale_id` referencia `core_sales`, e um pedido da loja online não é uma
    // venda de balcão: o rastro do pedido fica no evento.
    expect(linha.sale_id).toBeNull();
    expect(eventosDaPlaquinha(a.equipmentId)).toContain('sold');
  });

  /**
   * QUEM DECIDE É O STATUS GRAVADO, NÃO A REFERÊNCIA.
   *
   * A venda escreve `sold` e amarra a plaquinha ao comprador. Se o gancho da
   * baixa se confundisse com ela, a moto entregue ao cliente ficaria sem dono no
   * portal no mesmo instante em que ele a levou.
   */
  it('a venda continua amarrando: a saída vendida não solta nada', () => {
    const a = motoComPlaquinha('e1', 'CHASSI-A');
    const dono = comprador('Comprador', '52998224725');
    vender([a.unitId], 'v1', dono);

    expect(getUnit(loja, a.unitId)!.status).toBe('sold');
    expect(getUnit(loja, a.unitId)!.equipment_id).toBe(a.equipmentId);
    const linha = linhaPlaquinha(a.equipmentId);
    expect(linha.sale_status).toBe('SOLD');
    expect(linha.origin_company_id).toBe(loja);
    expect(eventosDaPlaquinha(a.equipmentId)).not.toContain('stock_written_off');
  });
});
