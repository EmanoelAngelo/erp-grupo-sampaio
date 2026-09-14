/**
 * ============================================================================
 * O SERVIÇO DE BALCÃO — o produto que não sai de prateleira nenhuma (GAP-V02)
 * ============================================================================
 *
 * ## O defeito, medido
 *
 * Ajuste de bainha, instalação de acessório, aplicação de película: o varejo
 * vende isso todo dia, e o Devora não conseguia. `SalesService.baixasDaLinha`
 * mandava TODA linha que não fosse kit desmembrado para `applyMovement`, e o
 * `CHECK (quantity >= 0)` de `core_stock` recusava a venda inteira por falta de
 * saldo — de uma coisa que nunca teve saldo nem vai ter. Nenhuma coluna de
 * `core_products` ligava ou desligava isso.
 *
 * O contorno real do balcão é lançar uma entrada fictícia de mil unidades, e
 * ela suja o razão para sempre: o histórico de estoque passa a ter uma entrada
 * que nunca aconteceu, e a contagem de inventário passa a perguntar quantas
 * "instalações" existem na prateleira.
 *
 * ## O que este arquivo cobra
 *
 *  1. o serviço VENDE sem saldo nenhum, e a venda não gera movimento;
 *  2. venda MISTA (serviço + mercadoria) baixa SÓ a mercadoria;
 *  3. o serviço fica fora da posição de estoque e do valor do estoque;
 *  4. o serviço não entra na contagem de inventário — nem no catálogo inteiro,
 *     nem por lista explícita (aí com recusa nomeada);
 *  5. desligar o controle de um produto que AINDA TEM SALDO é recusado, com o
 *     saldo na mensagem: o estoque não pode sumir sem movimento que o explique;
 *  6. serviço é excludente com peso e com unidade serializada, nos dois
 *     sentidos (criação e edição).
 *
 * ## COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito)
 *
 *  - tire o `if (!produtoControlaEstoque(produto)) return []` de `baixasDaLinha`
 *    e o caso 1 estoura com CORE_INSUFFICIENT_STOCK;
 *  - tire o `AND p.stock_control = 1` de `listStock` e o caso 3 fica vermelho;
 *  - tire o mesmo filtro de `openInventoryCount` e o caso 4 fica vermelho;
 *  - tire a recusa `CORE_STOCK_CONTROL_WITH_BALANCE` e o caso 5 passa a
 *    desligar o controle deixando sete unidades órfãs no saldo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, getProduct, updateProduct } = await import(
  '../src/services/core/CatalogService.js'
);
const { createSale } = await import('../src/services/core/SalesService.js');
const { applyMovement, listStock, stockValuation } = await import(
  '../src/services/core/InventoryService.js'
);
const { openInventoryCount } = await import('../src/services/core/InventoryCountService.js');
const { produtoControlaEstoque } = await import('../src/services/core/CatalogAuxService.js');

let loja: string;

/** Um serviço de balcão: preço fechado, sem prateleira. */
function servico(nome: string, precoCents: number): string {
  const p = createProduct(loja, {
    name: nome,
    priceCents: precoCents,
    stockControl: false,
  });
  return String(p.id);
}

/** Uma mercadoria comum, com saldo lançado por movimento de verdade. */
function mercadoria(nome: string, precoCents: number, saldo: number): string {
  const p = createProduct(loja, { name: nome, priceCents: precoCents, costCents: 1000 });
  if (saldo > 0) {
    applyMovement({
      companyId: loja,
      productId: String(p.id),
      movementType: 'in',
      quantity: saldo,
      kind: 'MANUAL_ENTRY',
      referenceType: 'carga',
      referenceId: `carga-${p.id}`,
      reason: 'carga inicial do teste',
    });
  }
  return String(p.id);
}

function vender(items: { productId: string; quantity: number }[], totalCents: number) {
  return createSale({
    companyId: loja,
    userId: 'u-caixa',
    idempotencyKey: randomUUID(),
    items,
    payments: [{ method: 'dinheiro', amountCents: totalCents }],
  });
}

function saldoDe(productId: string): number {
  const linha = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(loja, productId) as { quantity?: number } | undefined;
  return Number(linha?.quantity ?? 0);
}

function movimentosDe(productId: string): number {
  const linha = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ? AND product_id = ?')
    .get(loja, productId) as { n: number };
  return linha.n;
}

function erroDe(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('esperava recusa, e passou');
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
});

describe('o serviço vende sem prateleira', () => {
  it('a venda fecha SEM saldo nenhum e não gera movimento de estoque', () => {
    const pelicula = servico('Aplicação de película', 3000);
    // Deliberadamente sem nenhuma entrada: é este o cenário que o CHECK do
    // banco recusava antes desta rodada.
    expect(saldoDe(pelicula)).toBe(0);

    const { sale } = vender([{ productId: pelicula, quantity: 1 }], 3000);

    expect(sale.total_cents).toBe(3000);
    // Nada saiu da prateleira porque não havia prateleira.
    expect(movimentosDe(pelicula)).toBe(0);
    expect(saldoDe(pelicula)).toBe(0);
  });

  it('duas películas na mesma linha continuam sem tocar no estoque', () => {
    const pelicula = servico('Aplicação de película', 3000);
    vender([{ productId: pelicula, quantity: 2 }], 6000);
    expect(movimentosDe(pelicula)).toBe(0);
  });

  it('VENDA MISTA: o serviço passa e a mercadoria baixa — só ela', () => {
    const capa = mercadoria('Capa de celular', 5000, 10);
    const instalacao = servico('Instalação de película', 3000);

    vender(
      [
        { productId: capa, quantity: 2 },
        { productId: instalacao, quantity: 1 },
      ],
      13000,
    );

    // A mercadoria baixou exatamente o que foi vendido...
    expect(saldoDe(capa)).toBe(8);
    expect(movimentosDe(capa)).toBe(2); // a carga inicial + a venda
    // ...e o serviço não deixou rastro nenhum no razão.
    expect(movimentosDe(instalacao)).toBe(0);
  });

  it('a mercadoria SEM saldo continua sendo recusada — o serviço não afrouxou nada', () => {
    const capa = mercadoria('Capa de celular', 5000, 0);
    const erro = erroDe(() => vender([{ productId: capa, quantity: 1 }], 5000));
    expect(erro.code).toBe('CORE_INSUFFICIENT_STOCK');
  });
});

describe('estoque, inventário e valor ignoram o serviço', () => {
  it('não aparece na posição de estoque nem no valor do estoque', () => {
    const capa = mercadoria('Capa de celular', 5000, 4);
    const instalacao = servico('Instalação de película', 3000);

    const posicao = listStock(loja);
    expect(posicao.map((l) => l.product_id)).toContain(capa);
    expect(posicao.map((l) => l.product_id)).not.toContain(instalacao);

    // 4 × R$ 10,00 de custo. O serviço não soma nem subtrai nada.
    expect(stockValuation(loja).totalCents).toBe(4000);
    expect(stockValuation(loja).produtosComSaldo).toBe(1);
  });

  it('a contagem do catálogo inteiro não pergunta quantas instalações há na prateleira', () => {
    const capa = mercadoria('Capa de celular', 5000, 4);
    const instalacao = servico('Instalação de película', 3000);

    const contagem = openInventoryCount({
      companyId: loja,
      userId: 'u-gerente',
      scopeNote: 'balanço geral',
    });

    const itens = getConnection()
      .prepare('SELECT product_id FROM core_inventory_count_items WHERE count_id = ?')
      .all(contagem.id) as unknown as { product_id: string }[];
    expect(itens.map((i) => i.product_id)).toEqual([capa]);
    expect(itens.map((i) => i.product_id)).not.toContain(instalacao);
  });

  it('e a lista EXPLÍCITA recusa, dizendo por quê', () => {
    const instalacao = servico('Instalação de película', 3000);
    const erro = erroDe(() =>
      openInventoryCount({
        companyId: loja,
        userId: 'u-gerente',
        productIds: [instalacao],
      }),
    );
    expect(erro.code).toBe('CORE_PRODUCT_WITHOUT_STOCK_CONTROL');
    // A mensagem nomeia o produto: quem abriu a contagem precisa saber QUAL
    // linha da lista dele não entra.
    expect(erro.message).toContain('Instalação de película');
    expect(erro.message).toContain('não há o que contar');
  });
});

describe('a fronteira do cadastro', () => {
  it('desligar o controle com saldo em estoque é RECUSADO, com o número na frase', () => {
    const capa = mercadoria('Capa de celular', 5000, 7);

    const erro = erroDe(() => updateProduct(loja, capa, { stockControl: false }));
    expect(erro.code).toBe('CORE_STOCK_CONTROL_WITH_BALANCE');
    expect(erro.message).toContain('7');
    expect(erro.message).toContain('movimento registrado');

    // E o cadastro NÃO mudou: recusa que grava metade é pior que recusa.
    expect(getProduct(loja, capa)?.stock_control).toBe(1);
    expect(saldoDe(capa)).toBe(7);
  });

  it('com o saldo zerado por movimento, o mesmo produto vira serviço', () => {
    const capa = mercadoria('Capa de celular', 5000, 7);
    applyMovement({
      companyId: loja,
      productId: capa,
      movementType: 'out',
      quantity: 7,
      kind: 'MANUAL_EXIT',
      referenceType: 'ajuste',
      referenceId: 'zerar-para-servico',
      reason: 'saiu de linha; passa a ser serviço',
    });

    updateProduct(loja, capa, { stockControl: false });
    expect(getProduct(loja, capa)?.stock_control).toBe(0);
    // O razão continua contando a história inteira — foi este o ponto.
    expect(movimentosDe(capa)).toBe(2);
  });

  it('serviço não é pesável nem serializado — nem na criação, nem na edição', () => {
    expect(
      erroDe(() =>
        createProduct(loja, { name: 'Serviço pesável', stockControl: false, weighable: true }),
      ).code,
    ).toBe('CORE_SERVICE_AND_WEIGHABLE');
    expect(
      erroDe(() =>
        createProduct(loja, { name: 'Serviço com chassi', stockControl: false, serialized: true }),
      ).code,
    ).toBe('CORE_SERVICE_AND_SERIALIZED');

    // O PUT não pode ser o contorno do POST: ligar peso num serviço já gravado
    // é a mesma recusa.
    const corte = servico('Ajuste de bainha', 2000);
    expect(erroDe(() => updateProduct(loja, corte, { weighable: true })).code).toBe(
      'CORE_SERVICE_AND_WEIGHABLE',
    );
  });

  it('ausência da coluna lê como CONTROLA — é o que todo cadastro antigo significa', () => {
    // A pergunta é feita por uma função só, e é ela que os três leitores usam.
    expect(produtoControlaEstoque({})).toBe(true);
    expect(produtoControlaEstoque(null)).toBe(true);
    expect(produtoControlaEstoque({ stock_control: 1 })).toBe(true);
    expect(produtoControlaEstoque({ stock_control: 0 })).toBe(false);
  });
});
