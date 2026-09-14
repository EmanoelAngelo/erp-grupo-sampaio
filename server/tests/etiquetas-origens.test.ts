/**
 * As seis origens de onde vem a lista de produtos a etiquetar.
 *
 * O que este arquivo mais precisa provar é que ITEM PROBLEMÁTICO NÃO DERRUBA O
 * LOTE. A rotina de plaquinha de oficina faz o contrário — um equipamento sem
 * plaqueta lança 409 de dentro do laço e leva os outros junto — e o resultado
 * é que o operador não imprime nada até caçar o item ruim. Aqui o que dá para
 * etiquetar sai, e o que não dá aparece com o motivo escrito.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { generateVariants } = await import('../src/services/core/VariantService.js');
const { addProductBarcode } = await import('../src/services/core/CatalogAuxService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSupplier } = await import('../src/services/core/SupplierService.js');
const { createPurchaseOrder } = await import('../src/services/core/PurchaseOrderService.js');
const { openInventoryCount, recordCount } = await import(
  '../src/services/core/InventoryCountService.js'
);
const { LABEL_SOURCES, QUANTITY_MODES, listLabelCandidates } = await import(
  '../src/services/core/LabelSourcesService.js'
);
const { getConnection } = await import('../src/db/sqlite.js');

let empresa: string;
let usuario: string;
let camiseta: string;
let bermuda: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'GERENTE_ETQ',
    displayName: 'Gerente',
    password: 'Teste@Etq2026',
  });
  linkUserToCompany(usuario, empresa, 'gerente_loja', true);

  camiseta = createProduct(empresa, { name: 'Camiseta Polo Azul', priceCents: 8990 }).id;
  bermuda = createProduct(empresa, { name: 'Bermuda Jeans', priceCents: 12990 }).id;
});

describe('o catálogo de origens e modos', () => {
  /*
    MUDOU (auditoria B-estoque-entrada-07): a sétima origem é a NOTA DE
    ENTRADA — a compra que chega por XML sem pedido não tinha origem, e
    etiquetar uma nota de 60 itens era buscar e digitar item por item.
  */
  it('são sete origens', () => {
    expect(LABEL_SOURCES).toHaveLength(7);
  });

  it('são três modos de quantidade', () => {
    expect(QUANTITY_MODES).toHaveLength(3);
  });

  /**
   * O modo "usar a quantidade do documento" só faz sentido onde existe
   * documento. A tela desabilita com motivo em vez de sumir com a opção.
   *
   * `codigos` entra na lista porque a lista colada É o documento: repetir a
   * peça três vezes é pedir três etiquetas. Sem isso, a soma de repetições
   * ficaria inalcançável — só este modo a lê.
   */
  it('compra, nota de entrada, inventário e códigos colados têm quantidade de documento', () => {
    const comDoc = LABEL_SOURCES.filter((s) => s.temQuantidadeDeDocumento).map((s) => s.id);
    expect(comDoc.sort()).toEqual(['codigos', 'compra', 'inventario', 'nota']);
  });

  /** Catálogo, estoque e grade não vêm de documento nenhum. */
  it('catálogo, estoque e grade não oferecem quantidade de documento', () => {
    const semDoc = LABEL_SOURCES.filter((s) => !s.temQuantidadeDeDocumento).map((s) => s.id);
    expect(semDoc.sort()).toEqual(['catalogo', 'estoque', 'grade']);
  });

  it('origem desconhecida é recusada, não adivinhada', () => {
    expect(() =>
      listLabelCandidates(empresa, { source: 'inventado' as never }),
    ).toThrow(/desconhecida/i);
  });
});

describe('origem: catálogo', () => {
  it('acha por parte do nome', () => {
    const r = listLabelCandidates(empresa, { source: 'catalogo', search: 'polo' });
    expect(r.candidates.map((c) => c.productId)).toEqual([camiseta]);
  });

  it('acha por código de barras adicional, como o PDV', () => {
    addProductBarcode(empresa, camiseta, '7891234567895');
    const r = listLabelCandidates(empresa, { source: 'catalogo', search: '7891234567895' });
    expect(r.candidates.map((c) => c.productId)).toEqual([camiseta]);
  });

  it('busca vazia é recusada com instrução, não com lista inteira', () => {
    expect(() => listLabelCandidates(empresa, { source: 'catalogo', search: '  ' })).toThrow(
      /informe/i,
    );
  });
});

describe('origem: estoque', () => {
  it('traz o saldo junto, para o modo "usar o saldo"', () => {
    applyMovement({
      companyId: empresa,
      productId: camiseta,
      movementType: 'in',
      quantity: 7,
      referenceType: 'ajuste',
      referenceId: 'e1',
    });
    const r = listLabelCandidates(empresa, { source: 'estoque' });
    expect(r.candidates.find((c) => c.productId === camiseta)?.stockQuantity).toBe(7);
  });

  /**
   * O aviso "gera código ao imprimir" só serve se aparecer em quem realmente
   * não tem código. Antes esta origem mandava `barcode: null` para todo mundo
   * — o aviso saía em produto que já tinha EAN, e virou ruído.
   */
  it('traz o código de barras de quem já tem', () => {
    const comEan = createProduct(empresa, {
      name: 'Meia Cano Alto',
      priceCents: 1990,
      barcode: '7891234567895',
    }).id;
    const r = listLabelCandidates(empresa, { source: 'estoque' });
    expect(r.candidates.find((c) => c.productId === comEan)?.barcode).toBe('7891234567895');
    expect(r.candidates.find((c) => c.productId === camiseta)?.barcode).toBeNull();
  });

  it('com o filtro ligado, só vem o que está abaixo do mínimo', () => {
    const critico = createProduct(empresa, {
      name: 'Meia Cano Alto',
      priceCents: 1990,
      minStock: 10,
    }).id;
    const r = listLabelCandidates(empresa, { source: 'estoque', lowOnly: true });
    expect(r.candidates.map((c) => c.productId)).toContain(critico);
  });
});

describe('origem: pedido de compra', () => {
  async function pedidoCom(itens: { productId?: string; description?: string; quantity: number }[]) {
    const fornecedor = createSupplier(empresa, { name: 'Distribuidora Norte' }).id as string;
    return createPurchaseOrder({
      companyId: empresa,
      userId: usuario,
      supplierId: fornecedor,
      items: itens.map((i) => ({
        productId: i.productId ?? null,
        description: i.description ?? 'Item',
        quantity: i.quantity,
        unitCostCents: 1000,
      })),
    }).id as string;
  }

  /*
    MUDOU (auditoria B-estoque-entrada-20): sem nada recebido, a sugestão era a
    quantidade PEDIDA (12) — etiqueta para mercadoria que não está na mão. Agora
    o item vai para os problemas, dizendo para etiquetar pela nota quando chegar.
    A sugestão com mercadoria recebida (a da última entrega) está provada em
    etiquetas-auditoria-pj.test.ts.
  */
  it('pedido sem nada recebido: o item vai para os problemas, e não sugere a quantidade pedida', async () => {
    const pedido = await pedidoCom([{ productId: camiseta, quantity: 12 }]);
    const r = listLabelCandidates(empresa, { source: 'compra', purchaseOrderId: pedido });
    expect(r.candidates).toHaveLength(0);
    expect(r.problemas.map((p) => p.motivo)).toEqual([expect.stringMatching(/Nada deste item chegou/)]);
  });

  /**
   * Item de nota sem vínculo com o cadastro é o caso comum: veio do XML do
   * fornecedor e ninguém amarrou. Não dá para etiquetar — mas sumir com ele
   * faria o operador achar que etiquetou a nota inteira.
   */
  it('item sem produto vinculado vira problema declarado, não desaparece', async () => {
    const pedido = await pedidoCom([
      { productId: camiseta, quantity: 3 },
      { description: 'CX PARAFUSO 3/8 SORTIDO', quantity: 5 },
    ]);
    // A camiseta CHEGOU (agora só o que chegou é candidato — B-estoque-entrada-20).
    getConnection()
      .prepare('UPDATE core_purchase_order_items SET received_quantity = 3 WHERE order_id = ? AND product_id = ?')
      .run(pedido, camiseta);
    const r = listLabelCandidates(empresa, { source: 'compra', purchaseOrderId: pedido });

    expect(r.candidates).toHaveLength(1);
    expect(r.problemas).toHaveLength(1);
    expect(r.problemas[0].descricao).toBe('CX PARAFUSO 3/8 SORTIDO');
    expect(r.problemas[0].motivo).toMatch(/vincul/i);
  });

  it('pedido inexistente devolve 404, não lista vazia', () => {
    expect(() =>
      listLabelCandidates(empresa, { source: 'compra', purchaseOrderId: 'nao-existe' }),
    ).toThrow(/não encontrado/i);
  });
});

describe('origem: contagem de inventário', () => {
  it('a quantidade sugerida é o que foi contado', () => {
    const contagem = openInventoryCount({
      companyId: empresa,
      userId: usuario,
      productIds: [camiseta],
    }).id as string;
    recordCount({
      companyId: empresa,
      userId: usuario,
      countId: contagem,
      productId: camiseta,
      countedQuantity: 9,
    });

    const r = listLabelCandidates(empresa, { source: 'inventario', countId: contagem });
    expect(r.candidates[0].documentQuantity).toBe(9);
  });

  /**
   * Nulo NÃO é zero. Item que a contagem não alcançou não foi contado como
   * nenhum — sugerir 0 etiquetas transformaria "não contei" em "não tem".
   */
  it('item ainda não contado não vira quantidade zero', () => {
    const contagem = openInventoryCount({
      companyId: empresa,
      userId: usuario,
      productIds: [camiseta, bermuda],
    }).id as string;
    recordCount({
      companyId: empresa,
      userId: usuario,
      countId: contagem,
      productId: camiseta,
      countedQuantity: 4,
    });

    const r = listLabelCandidates(empresa, { source: 'inventario', countId: contagem });
    expect(r.candidates.map((c) => c.productId)).toEqual([camiseta]);
    expect(r.problemas.map((p) => p.motivo)).toEqual(['Ainda não foi contado.']);
  });
});

describe('origem: códigos colados', () => {
  it('aceita quebra de linha, vírgula e ponto-e-vírgula', () => {
    const r = listLabelCandidates(empresa, {
      source: 'codigos',
      codes: 'GS-000001\nGS-000002',
    });
    expect(r.candidates).toHaveLength(2);
  });

  /** Colar a mesma peça três vezes quer dizer três etiquetas, não três linhas. */
  it('código repetido soma quantidade em vez de duplicar a linha', () => {
    const r = listLabelCandidates(empresa, {
      source: 'codigos',
      codes: 'GS-000001;GS-000001;GS-000001',
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].documentQuantity).toBe(3);
  });

  it('código inexistente é devolvido com o motivo, e não engole a lista', () => {
    const r = listLabelCandidates(empresa, {
      source: 'codigos',
      codes: 'GS-000001\nXPTO-999',
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.problemas[0].descricao).toBe('XPTO-999');
  });
});

describe('origem: grade do modelo', () => {
  /** A grade nasce por `generateVariants` — `createProduct` não cria filho. */
  function comGrade(): { modelo: string; variantes: string[] } {
    const modelo = createProduct(empresa, { name: 'Camisa Social', priceCents: 15990 }).id;
    const { created } = generateVariants({
      companyId: empresa,
      productId: modelo,
      axes: { tamanho: ['P', 'M'] },
    });
    return { modelo, variantes: created.map((v) => v.id) };
  }

  it('a partir do modelo, traz as variantes e não o modelo', () => {
    const { modelo, variantes } = comGrade();
    const r = listLabelCandidates(empresa, { source: 'grade', productId: modelo });

    expect(r.candidates.map((c) => c.productId).sort()).toEqual([...variantes].sort());
    expect(r.candidates.map((c) => c.productId)).not.toContain(modelo);
  });

  /** Quem clicou numa peça da grade quer as irmãs dela, não só ela. */
  it('a partir de uma variante, traz as irmãs', () => {
    const { variantes } = comGrade();
    const r = listLabelCandidates(empresa, { source: 'grade', productId: variantes[0] });
    expect(r.candidates.map((c) => c.productId).sort()).toEqual([...variantes].sort());
  });

  it('produto sem grade sai sozinho, com o aviso de que não tem grade', () => {
    const r = listLabelCandidates(empresa, { source: 'grade', productId: camiseta });
    expect(r.candidates.map((c) => c.productId)).toEqual([camiseta]);
    expect(r.problemas[0].motivo).toMatch(/não tem grade/i);
  });
});
