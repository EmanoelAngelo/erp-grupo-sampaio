/**
 * O CUPOM QUE O CLIENTE LEVA PARA CASA DIZ QUAL LOJA VENDEU.
 *
 * ============================================================================
 * O QUE ESTAVA IMPRESSO
 * ============================================================================
 *
 *     GRUPO SAMPAIO          ← 13px, negrito, o título do papel
 *     Preço Justo            ← 10px, cinza, a linha de baixo
 *
 * A holding saía 30% maior que a empresa que efetivamente vendeu, repetindo no
 * papel a mesma inversão que a tela do PDV tinha. E não havia endereço nem
 * telefone em lugar nenhum: o cliente que quer trocar a peça na semana seguinte
 * fica com um papel que não diz para onde voltar.
 *
 * O nome do grupo continua — é ele que responde pelo conjunto —, mas como
 * sobrenome. A loja é o título, e o endereço e o telefone vêm do cadastro
 * fiscal quando existem, porque é lá que eles moram (a nota precisa deles).
 *
 * ============================================================================
 * O QUE ESTE TESTE NÃO DEIXA VOLTAR
 * ============================================================================
 *
 *   - a hierarquia invertida: o nome da loja tem que estar no `h1`;
 *   - o cupom mudo: com endereço cadastrado, ele sai impresso;
 *   - o cupom quebrado: sem cadastro fiscal, nada de "undefined" no papel.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const { renderDocument } = await import('../src/services/core/PrintRenderer.js');

let empresa: string;
let usuario: string;
let produto: string;
let vendaId: string;

/** O cupom da venda, como o papel sai. */
function cupom() {
  return renderDocument(empresa, 'SALE_RECEIPT', vendaId);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
    cnpj: '12345678000199',
  });
  usuario = await upsertUser({
    login: 'CAIXA_CUP',
    displayName: 'Caixa',
    password: 'Teste@Cup2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

  produto = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 5000 }).id;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 5,
    referenceType: 'ajuste',
    referenceId: 'e1',
  });

  vendaId = createSale({
    companyId: empresa,
    userId: usuario,
    items: [{ productId: produto, quantity: 1 }],
    payments: [{ method: 'dinheiro', amountCents: 5000 }],
    idempotencyKey: 'cup-1',
  }).sale.id;
});

/** Põe endereço e telefone no cadastro fiscal — é lá que eles moram. */
function comEnderecoFiscal() {
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_configs
         (company_id, street, number, district, city_name, uf, phone, updated_at)
       VALUES (?, 'Rua das Palmeiras', '128', 'Centro', 'Macapá', 'AP', '(96) 99999-1234', '2026-08-01T00:00:00.000Z')`,
    )
    .run(empresa);
}

// ============================================================================

describe('quem vendeu é a loja, e o papel diz isso', () => {
  it('o nome da loja é o título do cupom; o grupo, o sobrenome', () => {
    const html = cupom();

    /*
      Estava ao contrário: `<h1>GRUPO SAMPAIO</h1>` com a loja numa linha
      menor. Quem lê o papel na semana seguinte precisa saber em qual das seis
      lojas comprou — a holding não troca peça nem atende telefone.
    */
    const titulo = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
    expect(titulo).toContain('Preço Justo');
    expect(titulo).not.toContain('GRUPO SAMPAIO');

    // O grupo continua no papel — só que como sobrenome.
    expect(html).toContain('GRUPO SAMPAIO');
  });

  it('o CNPJ que sai é o da loja que vendeu', () => {
    expect(cupom()).toContain('12.345.678/0001-99');
  });
});

// ============================================================================

describe('o cupom diz para onde voltar', () => {
  it('endereço e telefone cadastrados saem impressos', () => {
    comEnderecoFiscal();
    const html = cupom();

    expect(html).toContain('Rua das Palmeiras');
    expect(html).toContain('128');
    expect(html).toContain('Macapá');
    expect(html).toContain('(96) 99999-1234');
  });

  it('sem cadastro fiscal o cupom sai limpo — nada de "undefined" no papel', () => {
    const html = cupom();

    // A loja pode não ter emitido nota ainda; o cupom continua saindo.
    expect(html).not.toMatch(/undefined|null|NaN/);
    expect(html).toContain('Preço Justo');
  });
});
