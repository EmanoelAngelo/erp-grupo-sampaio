/**
 * MERCADORIA NÃO PODE FICAR PRESA NUM PRODUTO QUE NINGUÉM VENDE.
 *
 * ============================================================================
 * O MODELO DE GRADE, E O SALDO QUE SOBRA NELE
 * ============================================================================
 *
 * O sistema decidiu — e cumpre em cinco lugares — que **modelo de grade não é
 * item de venda**: no balcão, "a camiseta" sem tamanho não existe. A venda
 * recusa (`CORE_PRODUCT_HAS_VARIANTS`), o orçamento recusa, a busca do PDV
 * esconde, e a contagem de inventário nem lista.
 *
 * `generateVariants` toma essa decisão e não trata a consequência dela: se o
 * modelo JÁ TINHA saldo — que é o caminho normal, porque a loja cadastra a
 * camisa, dá entrada da nota e só depois percebe que precisa separar por
 * tamanho —, esse saldo fica órfão.
 *
 * E órfão do pior jeito possível:
 *
 *   - APARECE na tela de Estoque (`listStock` não exclui modelo);
 *   - SOME do PDV, do orçamento e da vitrine como item vendável;
 *   - NÃO É ALCANÇADO pela contagem de inventário, que é o único mecanismo do
 *     ERP para fazer sistema e prateleira concordarem;
 *   - CRESCE, porque a entrada de nota continua casando o item do fornecedor
 *     com o código de barras, o código interno e o nome do modelo;
 *   - E TEM UMA SAÍDA ERRADA: o checkout da loja online aceita o id do modelo,
 *     reserva o saldo preso e o consome num pedido de "a camisa" sem tamanho.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * O funil de estoque passa a saber o que o resto do sistema já sabia: modelo de
 * grade e kit não recebem nem entregam saldo. Recusar na porta é mais honesto
 * que migrar sozinho — quem gera a grade sabe onde a mercadoria está; o sistema
 * não sabe qual tamanho são as dez camisas da prateleira.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { generateVariants } = await import('../src/services/core/VariantService.js');
const { matchItems } = await import('../src/services/core/NfeImportService.js');
const { checkout } = await import('../src/services/core/StorefrontService.js');

let loja: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
});

/** A camisa que a loja cadastrou antes de decidir usar grade. */
function camisaComSaldo(qtd: number): string {
  const id = createProduct(loja, { name: 'Camisa Social', priceCents: 9_000 }).id;
  getConnection()
    .prepare("UPDATE core_products SET barcode = '7891111111111', publish_online = 1 WHERE id = ?")
    .run(id);
  if (qtd > 0) {
    applyMovement({
      companyId: loja,
      productId: id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `nf-${id}`,
    });
  }
  return id;
}

function gerarGrade(productId: string) {
  return generateVariants({
    companyId: loja,
    productId,
    axes: { tamanho: ['P', 'M', 'G'] },
  });
}

// ============================================================================

describe('gerar a grade com saldo no modelo é RECUSADO', () => {
  it('a recusa diz o que fazer com a mercadoria que está na prateleira', () => {
    const camisa = camisaComSaldo(10);

    let erro: { code?: string; message: string } | null = null;
    try {
      gerarGrade(camisa);
    } catch (e) {
      erro = e as { code?: string; message: string };
    }

    expect(erro?.code).toBe('CORE_MODEL_HAS_STOCK');
    // A mensagem tem de dizer o número e o caminho — senão quem lê fica sem
    // saber quantas camisas precisa distribuir nem por onde.
    expect(erro?.message).toMatch(/10/);
    expect(erro?.message).toMatch(/tamanho|variante|grade/i);
  });

  it('e nada é criado: nem variante, nem código de barras', () => {
    const camisa = camisaComSaldo(10);
    try {
      gerarGrade(camisa);
    } catch {
      /* esperado */
    }

    const filhos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE parent_id = ?')
      .get(camisa) as { n: number };
    expect(filhos.n).toBe(0);
    // E o saldo continua onde estava, alcançável pelo PDV como sempre foi.
    expect(getBalance(loja, camisa)).toBe(10);
  });

  it('com saldo ZERO, a grade é gerada normalmente', () => {
    const camisa = camisaComSaldo(0);
    const r = gerarGrade(camisa);
    expect(r.created).toHaveLength(3);
  });

  it('e gerar de novo, para acrescentar uma cor, continua funcionando', () => {
    /*
      A recusa é sobre SALDO NO MODELO, e não sobre "já tem grade". Acrescentar
      um tamanho é operação normal de catálogo, e o modelo com grade tem saldo
      zero justamente porque a mercadoria está nas variantes.
    */
    const camisa = camisaComSaldo(0);
    gerarGrade(camisa);

    const r = generateVariants({
      companyId: loja,
      productId: camisa,
      axes: { tamanho: ['P', 'M', 'G', 'GG'] },
    });
    expect(r.created).toHaveLength(1);
  });
});

// ============================================================================

describe('o funil de estoque recusa o modelo de grade', () => {
  /**
   * A regra estava replicada por consulta ad-hoc em cada chamador
   * (`SELECT 1 ... WHERE parent_id = ?`), e por isso os chamadores que
   * ninguém lembrou — a entrada de nota, a planilha, o checkout online —
   * continuavam somando saldo no modelo. `applyMovement` é por onde TODOS
   * passam.
   */
  it('entrada de nota no modelo é recusada', () => {
    const camisa = camisaComSaldo(0);
    gerarGrade(camisa);

    expect(() =>
      applyMovement({
        companyId: loja,
        productId: camisa,
        movementType: 'in',
        quantity: 5,
        referenceType: 'nfe_entrada',
        referenceId: 'nf-999',
      }),
    ).toThrow(/grade|variante|tamanho/i);
  });

  it('e a variante recebe normalmente', () => {
    const camisa = camisaComSaldo(0);
    const { created } = gerarGrade(camisa);

    applyMovement({
      companyId: loja,
      productId: created[0].id,
      movementType: 'in',
      quantity: 5,
      referenceType: 'nfe_entrada',
      referenceId: 'nf-999',
    });

    expect(getBalance(loja, created[0].id)).toBe(5);
    expect(getBalance(loja, camisa)).toBe(0);
  });

  it('kit também não recebe saldo — ele é a soma dos componentes', () => {
    const kit = createProduct(loja, { name: 'Kit de higiene', priceCents: 5_000 }).id;
    getConnection().prepare('UPDATE core_products SET is_kit = 1 WHERE id = ?').run(kit);

    expect(() =>
      applyMovement({
        companyId: loja,
        productId: kit,
        movementType: 'in',
        quantity: 3,
        referenceType: 'nfe_entrada',
        referenceId: 'nf-kit',
      }),
    ).toThrow(/kit/i);
  });
});

// ============================================================================

describe('a entrada de nota não casa o item com o modelo', () => {
  /**
   * O modelo mantém o código de barras, o código interno e o nome que tinha
   * antes da grade — `generateVariants` não limpa nenhum dos três. Então a
   * nota do fornecedor com o código antigo continuava apontando para ele, e o
   * saldo preso CRESCIA a cada entrega.
   */
  it('o item que casaria com o modelo volta sem produto, e com o motivo', () => {
    const camisa = camisaComSaldo(0);
    gerarGrade(camisa);

    const [casado] = matchItems(loja, [
      {
        supplierCode: null,
        barcode: '7891111111111',
        description: 'Camisa Social',
        quantity: 10,
        unit: 'UN',
        unitCents: 4_000,
        totalCents: 40_000,
        ncm: null,
        cfop: null,
      } as never,
    ]);

    expect(casado.productId).toBeNull();
    expect(String((casado as { matchNote?: string }).matchNote)).toMatch(/grade|variante|tamanho/i);
  });

  it('produto sem grade continua casando pelo código de barras', () => {
    const camisa = camisaComSaldo(0);

    const [casado] = matchItems(loja, [
      {
        supplierCode: null,
        barcode: '7891111111111',
        description: 'Camisa Social',
        quantity: 10,
        unit: 'UN',
        unitCents: 4_000,
        totalCents: 40_000,
        ncm: null,
        cfop: null,
      } as never,
    ]);

    expect(casado.productId).toBe(camisa);
    expect(casado.matchedBy).toBe('barcode');
  });

  it('kit não casa — ele não é mercadoria que entra', () => {
    const kit = createProduct(loja, { name: 'Kit de higiene', priceCents: 5_000 }).id;
    getConnection()
      .prepare("UPDATE core_products SET is_kit = 1, barcode = '7892222222222' WHERE id = ?")
      .run(kit);

    const [casado] = matchItems(loja, [
      {
        supplierCode: null,
        barcode: '7892222222222',
        description: 'Kit de higiene',
        quantity: 3,
        unit: 'UN',
        unitCents: 2_000,
        totalCents: 6_000,
        ncm: null,
        cfop: null,
      } as never,
    ]);

    expect(casado.productId).toBeNull();
  });
});

// ============================================================================

describe('o checkout online não aceita o modelo', () => {
  it('pedido com o id do modelo é recusado — "a camisa" sem tamanho não existe', () => {
    /*
      A vitrine mostra o MODELO num card só (é a decisão certa: uma camisa com
      P/M/G viraria quatro cards). A página do produto oferece a variante. Mas
      o checkout se anuncia como "a última porta" e só conferia
      `PRODUTO_VISIVEL_NA_LOJA` — sem olhar a grade. Um POST com o id do modelo
      passava, reservava o saldo preso e o consumia.
    */
    const camisa = camisaComSaldo(0);
    gerarGrade(camisa);

    expect(() =>
      checkout({
        idempotencyKey: randomUUID(),
        customerName: 'Ana',
        customerDocument: '11122233344',
        paymentMethod: 'pix',
        items: [{ productId: camisa, quantity: 1 }],
      }),
    ).toThrow(/grade|tamanho|variante/i);
  });

  it('e com a variante o pedido nasce normalmente', () => {
    const camisa = camisaComSaldo(0);
    const { created } = gerarGrade(camisa);
    getConnection()
      .prepare('UPDATE core_products SET publish_online = 1 WHERE id = ?')
      .run(created[0].id);
    applyMovement({
      companyId: loja,
      productId: created[0].id,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'carga',
    });

    const pedidos = checkout({
      idempotencyKey: randomUUID(),
      customerName: 'Ana',
      customerDocument: '11122233344',
      paymentMethod: 'pix',
      items: [{ productId: created[0].id, quantity: 1 }],
    });

    expect(pedidos).toHaveLength(1);
  });
});
