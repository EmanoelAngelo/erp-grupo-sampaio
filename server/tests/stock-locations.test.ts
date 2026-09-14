/**
 * Locais de estoque — onde a mercadoria está.
 *
 * O que este arquivo mais precisa provar é a decisão de desenho: o local é
 * dimensão do RAZÃO, e não da chave de `core_stock`. Se a soma dos locais
 * puder divergir do total, o desenho está errado — e é a primeira coisa
 * cobrada aqui.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance, listMovements } = await import(
  '../src/services/core/InventoryService.js'
);
const {
  balanceByLocation,
  createLocation,
  ensureDefaultLocation,
  listLocations,
  transferStock,
  updateLocation,
} = await import('../src/services/core/StockLocationService.js');

let empresa: string;
let produto: string;
let deposito: string;
let loja: string;

/** Soma o que o razão diz por local — tem de bater com o total em cache. */
function somaDosLocais(): number {
  return balanceByLocation(empresa, produto).reduce((t, l) => t + l.quantity, 0);
}

function entrada(quantidade: number, ref: string, locationId?: string): void {
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'ajuste',
    referenceId: ref,
    locationId,
  });
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  produto = createProduct(empresa, { name: 'Óleo 20W50', priceCents: 3000 }).id;
  deposito = createLocation(empresa, { code: 'DEP', name: 'Depósito' }).id;
  loja = createLocation(empresa, { code: 'LOJA', name: 'Loja' }).id;
});

describe('o local não abre a tabela de saldo', () => {
  it('a soma dos locais é sempre igual ao total em cache', () => {
    entrada(10, 'e1', deposito);
    entrada(4, 'e2', loja);

    expect(getBalance(empresa, produto)).toBe(14);
    expect(somaDosLocais()).toBe(14);
  });

  /**
   * Este é o caso que o desenho alternativo — local na chave primária de
   * `core_stock` — recusaria: o `CHECK (quantity >= 0)` passaria a valer por
   * local, e vender 5 de quem tem 3 na loja e 7 no depósito estouraria. Aqui
   * o invariante segue sendo o TOTAL, que é o que o negócio quer dizer.
   */
  it('vender mais do que há em um local não é recusado pelo saldo total', () => {
    entrada(3, 'e1', loja);
    entrada(7, 'e2', deposito);

    expect(() =>
      applyMovement({
        companyId: empresa,
        productId: produto,
        movementType: 'out',
        quantity: 5,
        referenceType: 'venda',
        referenceId: 'v1',
      }),
    ).not.toThrow();

    expect(getBalance(empresa, produto)).toBe(5);
  });

  it('o total continua sem poder ficar negativo', () => {
    entrada(2, 'e1', loja);
    expect(() =>
      applyMovement({
        companyId: empresa,
        productId: produto,
        movementType: 'out',
        quantity: 3,
        referenceType: 'venda',
        referenceId: 'v1',
        locationId: loja,
      }),
    ).toThrow();
  });
});

describe('movimento sem local cai no padrão', () => {
  /**
   * É o que mantém íntegro TODO movimento gravado antes desta coluna existir —
   * nenhum registro histórico precisou ser reescrito.
   */
  it('movimento com local nulo aparece no local padrão, não em um grupo sem nome', () => {
    entrada(6, 'e1'); // sem local

    const padrao = ensureDefaultLocation(empresa);
    const posicao = balanceByLocation(empresa, produto);

    expect(posicao).toHaveLength(1);
    expect(posicao[0].locationId).toBe(padrao.id);
    expect(posicao[0].quantity).toBe(6);
  });

  it('a empresa ganha um local padrão sozinha, sem cadastro prévio', () => {
    const outra = upsertCompany({
      slug: 'pj-motors',
      legalName: 'PJ Motors Ltda',
      tradeName: 'PJ Motors',
      kind: 'workshop',
    });
    const locais = listLocations(outra);
    expect(locais).toHaveLength(1);
    expect(locais[0].is_default).toBe(1);
  });
});

describe('transferência entre locais', () => {
  it('move a mercadoria sem alterar o total', () => {
    entrada(10, 'e1', deposito);

    transferStock({
      companyId: empresa,
      productId: produto,
      fromLocationId: deposito,
      toLocationId: loja,
      quantity: 4,
    });

    const posicao = balanceByLocation(empresa, produto);
    expect(posicao.find((l) => l.locationId === deposito)?.quantity).toBe(6);
    expect(posicao.find((l) => l.locationId === loja)?.quantity).toBe(4);
    expect(getBalance(empresa, produto)).toBe(10);
    expect(somaDosLocais()).toBe(10);
  });

  it('recusa transferir mais do que há na origem, e não move nada', () => {
    entrada(3, 'e1', deposito);

    expect(() =>
      transferStock({
        companyId: empresa,
        productId: produto,
        fromLocationId: deposito,
        toLocationId: loja,
        quantity: 5,
      }),
    ).toThrow(/insuficiente/i);

    expect(balanceByLocation(empresa, produto).find((l) => l.locationId === deposito)?.quantity).toBe(
      3,
    );
    expect(getBalance(empresa, produto)).toBe(3);
  });

  it('recusa origem igual ao destino', () => {
    entrada(5, 'e1', deposito);
    expect(() =>
      transferStock({
        companyId: empresa,
        productId: produto,
        fromLocationId: deposito,
        toLocationId: deposito,
        quantity: 1,
      }),
    ).toThrow(/mesmo local/i);
  });

  it('recusa local inativo como destino', () => {
    entrada(5, 'e1', deposito);
    updateLocation(empresa, loja, { active: false });

    expect(() =>
      transferStock({
        companyId: empresa,
        productId: produto,
        fromLocationId: deposito,
        toLocationId: loja,
        quantity: 1,
      }),
    ).toThrow(/não encontrado ou inativo/i);
  });

  /** As duas pernas compartilham a referência: o histórico lê como UM fato. */
  it('as duas pernas ficam ligadas pela mesma referência', () => {
    entrada(10, 'e1', deposito);
    const { reference } = transferStock({
      companyId: empresa,
      productId: produto,
      fromLocationId: deposito,
      toLocationId: loja,
      quantity: 4,
    });
    expect(reference).toBeTruthy();
  });

  /*
    ============================================================================
    O RAZÃO TEM DE DIZER "TRANSFERÊNCIA" — e ele dizia "manual"
    ============================================================================

    `TRANSFER_OUT` e `TRANSFER_IN` já existiam em `MOVEMENT_KINDS` e já tinham
    rótulo em português desde que a tela de Movimentações ganhou o filtro por
    tipo. Só que `transferStock` gravava as duas pernas SEM `kind` explícito, e
    a dedução de `inferKind` não conhece a referência 'transferencia': ela caía
    no par genérico direção→tipo, e a saída virava MANUAL_EXIT e a entrada
    MANUAL_ENTRY.

    O estrago não é cosmético. O gestor que abre Movimentações, escolhe
    "Transferência — saída" no filtro e procura para onde foi a mercadoria
    recebe ZERO LINHAS — a opção existe no menu, o dado existe no banco, e a
    consulta não os une. Pior: as mesmas linhas aparecem sob "Saída manual",
    onde ficam misturadas com as perdas e os consumos internos. Quem confere
    prateleira contra sistema lê saída definitiva onde houve mudança de
    prateleira.

    COMO ELE FALHA: tirar `kind: 'TRANSFER_OUT'`/`'TRANSFER_IN'` das duas
    chamadas de `applyMovement` em `transferStock` deixa este caso vermelho em
    quatro pontos — os dois kinds gravados e as duas buscas pelo filtro.
  */
  it('as duas pernas se declaram TRANSFERÊNCIA — e o filtro da tela as encontra', () => {
    entrada(10, 'e1', deposito);
    transferStock({
      companyId: empresa,
      productId: produto,
      fromLocationId: deposito,
      toLocationId: loja,
      quantity: 4,
    });

    // O razão, do mais antigo para o mais novo: a carga, a saída, a entrada.
    const razao = listMovements(empresa, { productId: produto }).reverse();
    expect(razao).toHaveLength(3);
    expect(razao[1].kind).toBe('TRANSFER_OUT');
    expect(razao[2].kind).toBe('TRANSFER_IN');

    // E o rótulo é o que a tela mostra: quem lê a linha entende o fato.
    expect(razao[1].kind_label).toBe('Transferência — saída');
    expect(razao[2].kind_label).toBe('Transferência — entrada');

    /*
      O FILTRO É O PONTO. A tela oferece "Transferência — saída" no menu
      porque `MOVEMENT_KINDS` a oferece; sem o kind gravado, escolhê-la
      devolvia lista vazia e a transferência ficava escondida dentro de
      "Saída manual", ao lado de perda e consumo interno.
    */
    expect(listMovements(empresa, { kind: 'TRANSFER_OUT' })).toHaveLength(1);
    expect(listMovements(empresa, { kind: 'TRANSFER_IN' })).toHaveLength(1);
    // E o balde manual guarda só a carga inicial — a transferência saiu de lá.
    expect(listMovements(empresa, { kind: ['MANUAL_ENTRY', 'MANUAL_EXIT'] })).toHaveLength(1);
  });
});

describe('cadastro de local', () => {
  it('recusa código repetido na mesma empresa', () => {
    expect(() => createLocation(empresa, { code: 'DEP', name: 'Outro depósito' })).toThrow(
      /já existe/i,
    );
  });

  it('normaliza o código para maiúsculas', () => {
    const local = createLocation(empresa, { code: 'vitrine', name: 'Vitrine' });
    expect(local.code).toBe('VITRINE');
  });

  it('exige nome', () => {
    expect(() => createLocation(empresa, { code: 'XPT', name: '  ' })).toThrow(/informe/i);
  });

  /**
   * Desativar o padrão deixaria órfão todo movimento com local nulo — que é
   * como o histórico inteiro está gravado.
   */
  it('não deixa desativar o local padrão', () => {
    const padrao = ensureDefaultLocation(empresa);
    expect(() => updateLocation(empresa, padrao.id, { active: false })).toThrow(/padrão/i);
  });

  it('local inativo some da lista, mas o saldo dele continua visível', () => {
    entrada(5, 'e1', loja);
    updateLocation(empresa, loja, { active: false });

    expect(listLocations(empresa).some((l) => l.id === loja)).toBe(false);
    expect(balanceByLocation(empresa, produto).find((l) => l.locationId === loja)?.quantity).toBe(5);
  });
});

/**
 * O SALDO E A UNIDADE PRECISAM CONCORDAR SOBRE ONDE A PEÇA ESTÁ.
 *
 * ## A contradição
 *
 * `location_id` nulo tem significado declarado: é o local padrão da empresa.
 * `balanceByLocation` respeita isso com `COALESCE(m.location_id, <padrão>)`,
 * então uma entrada sem local aparece corretamente no GERAL.
 *
 * `pickUnitsFifo` NÃO respeita: quando recebe um local, filtra
 * `AND location_id = ?` — e no SQLite `NULL = 'loc-geral'` é falso. A unidade
 * que entrou sem local não é encontrada por local nenhum, nem pelo padrão.
 *
 * Resultado, com produto serializado: a tela de posição diz que há 3 motos no
 * GERAL, e a transferência do GERAL para a Loja falha dizendo que há 0. Os
 * dois números saem do mesmo banco, no mesmo instante.
 *
 * ## Por que isso importa agora
 *
 * Toda unidade nascida de NF-e está nesse estado: `createUnits` não recebe
 * local, e `applyMovement` sobrescreve com nulo em `markUnitsIn`. Ou seja, o
 * caminho NORMAL de entrada de mercadoria produz o defeito — não é um canto
 * raro.
 */
describe('a unidade serializada não some quando o local é o padrão', () => {
  it('unidade que entrou SEM local é encontrada pelo local padrão', async () => {
    const { createUnits, isSerialized, pickUnitsFifo } = await import(
      '../src/services/core/ProductUnitService.js'
    );
    const { updateProduct } = await import('../src/services/core/CatalogService.js');

    updateProduct(empresa, produto, { serialized: true });
    expect(isSerialized(empresa, produto)).toBe(true);

    // Exatamente o que a entrada de NF-e faz hoje: unidades sem local.
    const unidades = createUnits(empresa, produto, 3, {
      entryReferenceType: 'nfe_entrada',
      entryReferenceId: 'nota-1',
    });
    applyMovement({
      companyId: empresa,
      productId: produto,
      movementType: 'in',
      quantity: 3,
      unitIds: unidades,
      referenceType: 'nfe_entrada',
      referenceId: 'nota-1',
    });

    const padrao = ensureDefaultLocation(empresa);

    // O saldo por local já concorda: as 3 aparecem no padrão.
    expect(
      balanceByLocation(empresa, produto).find((l) => l.locationId === padrao.id)?.quantity,
    ).toBe(3);

    // A unidade tem de concordar com ele.
    expect(pickUnitsFifo(empresa, produto, 3, padrao.id)).toHaveLength(3);
  });

  /**
   * O caso que o lojista vive: recebeu a moto pela nota e quer mandar para a
   * loja. Hoje isso estoura "0 unidade(s) em estoque neste local" na cara de
   * quem está olhando um saldo que diz 3.
   */
  it('transferir do padrão para a loja funciona para unidade vinda de nota', async () => {
    const { createUnits } = await import('../src/services/core/ProductUnitService.js');
    const { updateProduct } = await import('../src/services/core/CatalogService.js');

    updateProduct(empresa, produto, { serialized: true });
    const unidades = createUnits(empresa, produto, 2, {
      entryReferenceType: 'nfe_entrada',
      entryReferenceId: 'nota-2',
    });
    applyMovement({
      companyId: empresa,
      productId: produto,
      movementType: 'in',
      quantity: 2,
      unitIds: unidades,
      referenceType: 'nfe_entrada',
      referenceId: 'nota-2',
    });

    const padrao = ensureDefaultLocation(empresa);

    expect(() =>
      transferStock({
        companyId: empresa,
        productId: produto,
        quantity: 1,
        fromLocationId: padrao.id,
        toLocationId: loja,
      }),
    ).not.toThrow();

    // E o total continua sendo o total: transferência não cria nem some peça.
    expect(getBalance(empresa, produto)).toBe(2);
    expect(somaDosLocais()).toBe(2);
  });
});
