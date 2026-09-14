/**
 * O que a nota fez com o preço.
 *
 * Confirmar uma entrada atualiza o CUSTO do produto e deixa o PREÇO onde
 * estava. O fornecedor aumenta, a margem encolhe, e nenhuma tela grita — a
 * loja passa a vender no prejuízo item a item até alguém notar no fechamento
 * do mês, se notar.
 *
 * A conta é a de `Pricing.ts`, que já é usada pelo cadastro de produto. Uma
 * segunda implementação de markup e margem divergiria da primeira no dia em
 * que uma das duas mudasse.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, getProduct, updateProduct } = await import(
  '../src/services/core/CatalogService.js'
);
const { createSupplier } = await import('../src/services/core/SupplierService.js');
const { applyPrices, suggestionsForNote } = await import(
  '../src/services/core/RepricingService.js'
);
const { NOTA_RECEBIDA } = await import('../src/services/core/InboundNoteStatus.js');

let empresa: string;
let fornecedor: string;

/** Uma nota confirmada com um item, já refletida no custo do produto. */
function notaCom(produtoId: string, custoUnitarioCents: number): string {
  const db = getConnection();
  const agora = new Date().toISOString();
  const noteId = `n-${produtoId.slice(0, 8)}-${custoUnitarioCents}`;
  db.prepare(
    `INSERT INTO core_inbound_notes
       (id, company_id, supplier_id, access_key, number, series, issued_at,
        total_cents, status, received_at, created_at)
     VALUES (?, ?, ?, ?, '1', '1', ?, ?, ?, ?, ?)`,
  ).run(
    noteId,
    empresa,
    fornecedor,
    `k-${noteId}`,
    agora,
    custoUnitarioCents,
    NOTA_RECEBIDA,
    agora,
    agora,
  );
  db.prepare(
    `INSERT INTO core_inbound_note_items
       (id, note_id, company_id, product_id, description, quantity,
        unit_cost_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Item', 1, ?, ?)`,
  ).run(`i-${noteId}`, noteId, empresa, produtoId, custoUnitarioCents, custoUnitarioCents);

  // É o que a confirmação da nota faz: o custo do cadastro passa a ser o da
  // nota mais recente.
  db.prepare('UPDATE core_products SET cost_cents = ? WHERE id = ?').run(
    custoUnitarioCents,
    produtoId,
  );
  return noteId;
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
  fornecedor = createSupplier(empresa, { name: 'Fornecedor Teste' }).id as string;
});

describe('o alerta', () => {
  /** O caso do dia a dia: o fornecedor aumentou e o preço ficou parado. */
  it('produto que passou a vender abaixo da margem mínima é apontado', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarginPercent: 40,
    }).id;

    // Custo sobe de R$ 50 para R$ 70: margem cai de 50% para 30%.
    const nota = notaCom(p, 7_000);
    const [s] = suggestionsForNote(empresa, nota);

    expect(s.abaixoDoMinimo).toBe(true);
    expect(s.motivos.join(' ')).toMatch(/margem/i);
    expect(s.margemPercent).toBeCloseTo(30, 1);
  });

  it('produto ainda dentro do mínimo não vira sugestão', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarginPercent: 40,
    }).id;

    const nota = notaCom(p, 5_500); // margem 45%
    const [s] = suggestionsForNote(empresa, nota);
    expect(s.abaixoDoMinimo).toBe(false);
    expect(s.precoSugeridoCents).toBeNull();
  });

  /** Vender abaixo do custo é o alarme mais alto que existe. */
  it('preço abaixo do custo é apontado mesmo sem mínimo declarado', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 4_000,
      costCents: 3_000,
    }).id;

    const nota = notaCom(p, 6_000);
    const [s] = suggestionsForNote(empresa, nota);
    expect(s.abaixoDoCusto).toBe(true);
  });

  /**
   * Sem mínimo declarado não há o que sugerir: inventar um número seria opinar
   * sobre um negócio que não é nosso.
   */
  it('sem mínimo declarado, avisa mas não sugere preço', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 4_000,
      costCents: 3_000,
    }).id;

    const nota = notaCom(p, 6_000);
    const [s] = suggestionsForNote(empresa, nota);
    expect(s.abaixoDoCusto).toBe(true);
    expect(s.precoSugeridoCents).toBeNull();
  });
});

describe('a sugestão de preço', () => {
  it('devolve o produto exatamente ao mínimo de margem', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarginPercent: 40,
    }).id;

    const nota = notaCom(p, 7_000);
    const [s] = suggestionsForNote(empresa, nota);

    // Margem de 40% sobre custo 7.000 => preço 11.666,67 -> 11.667
    expect(s.precoSugeridoCents).toBe(11_667);
  });

  it('respeita o mínimo de markup', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarkupPercent: 100,
    }).id;

    const nota = notaCom(p, 7_000);
    const [s] = suggestionsForNote(empresa, nota);
    expect(s.precoSugeridoCents).toBe(14_000); // 100% sobre 7.000
  });

  /**
   * Com mais de um mínimo declarado vale o MAIOR: atender só o menos exigente
   * deixaria o produto violando o outro, e a sugestão nasceria errada.
   */
  it('com vários mínimos, sugere o maior deles', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarkupPercent: 100, // => 14.000
      minMarginPercent: 60, // => 17.500
      minPriceCents: 12_000,
    }).id;

    const nota = notaCom(p, 7_000);
    const [s] = suggestionsForNote(empresa, nota);
    expect(s.precoSugeridoCents).toBe(17_500);
  });
});

describe('aplicar', () => {
  it('grava só os preços informados', () => {
    const a = createProduct(empresa, { name: 'A', priceCents: 10_000, costCents: 7_000 }).id;
    const b = createProduct(empresa, { name: 'B', priceCents: 20_000, costCents: 7_000 }).id;

    const r = applyPrices(empresa, [{ productId: a, priceCents: 12_000 }]);

    expect(r.atualizados).toBe(1);
    expect(getProduct(empresa, a)?.price_cents).toBe(12_000);
    expect(getProduct(empresa, b)?.price_cents).toBe(20_000);
  });

  it('preço negativo é recusado', () => {
    const p = createProduct(empresa, { name: 'A', priceCents: 10_000 }).id;
    expect(() => applyPrices(empresa, [{ productId: p, priceCents: -1 }])).toThrow(/inválido/i);
  });

  /** Produto de outra empresa não é alterado por engano. */
  it('não alcança produto de outra empresa', () => {
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
      kind: 'store',
    });
    const alheio = createProduct(outra, { name: 'A', priceCents: 10_000 }).id;

    const r = applyPrices(empresa, [{ productId: alheio, priceCents: 1 }]);
    expect(r.atualizados).toBe(0);
    expect(getProduct(outra, alheio)?.price_cents).toBe(10_000);
  });

  it('depois de aplicar, o produto sai da lista de alerta', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarginPercent: 40,
    }).id;
    const nota = notaCom(p, 7_000);

    const antes = suggestionsForNote(empresa, nota)[0];
    expect(antes.abaixoDoMinimo).toBe(true);

    applyPrices(empresa, [{ productId: p, priceCents: antes.precoSugeridoCents! }]);

    expect(suggestionsForNote(empresa, nota)[0].abaixoDoMinimo).toBe(false);
  });
});

describe('o que fica de fora', () => {
  /**
   * Item de nota sem produto no catálogo não tem preço para rever. Listá-lo
   * daria a impressão de que algo ficou por fazer aqui, quando o que falta é
   * o vínculo, em outra tela.
   */
  it('item sem produto vinculado não aparece', () => {
    const db = getConnection();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, supplier_id, access_key, number, series, issued_at,
          total_cents, status, created_at)
       VALUES ('n1', ?, ?, 'k1', '1', '1', ?, 1000, ?, ?)`,
    ).run(empresa, fornecedor, agora, NOTA_RECEBIDA, agora);
    db.prepare(
      `INSERT INTO core_inbound_note_items
         (id, note_id, company_id, description, quantity, unit_cost_cents, total_cents)
       VALUES ('i1', 'n1', ?, 'Sem vinculo', 1, 1000, 1000)`,
    ).run(empresa);

    expect(suggestionsForNote(empresa, 'n1')).toHaveLength(0);
  });

  it('nota inexistente é recusada', () => {
    expect(() => suggestionsForNote(empresa, 'nao-existe')).toThrow(/não encontrada/i);
  });

  /** Produto desativado depois da compra não precisa de preço novo. */
  it('a sugestão usa os mínimos atuais do produto', () => {
    const p = createProduct(empresa, {
      name: 'Camiseta Polo',
      priceCents: 10_000,
      costCents: 5_000,
      minMarginPercent: 40,
    }).id;
    const nota = notaCom(p, 7_000);
    expect(suggestionsForNote(empresa, nota)[0].abaixoDoMinimo).toBe(true);

    // O lojista afrouxa o mínimo: o alerta some, sem tocar em preço.
    updateProduct(empresa, p, { minMarginPercent: 20 });
    expect(suggestionsForNote(empresa, nota)[0].abaixoDoMinimo).toBe(false);
  });
});
