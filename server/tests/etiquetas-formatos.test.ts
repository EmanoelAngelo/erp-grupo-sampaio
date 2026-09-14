/**
 * Os sete formatos de etiqueta, e a folha que sai deles.
 *
 * O que este arquivo precisa provar é geometria: um formato cuja soma de
 * colunas estoura a largura da folha imprime a última coluna cortada, e isso
 * só apareceria no papel — depois de gastar a folha adesiva.
 *
 * Prova também que o preço impresso é o que o CAIXA cobra. Antes desta rodada
 * a etiqueta saía com `price_cents` cru enquanto o balcão usava
 * `effectivePriceCents`: com promoção ativa, prateleira e caixa divergiam.
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
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { buildLabels } = await import('../src/services/core/BarcodeService.js');
const {
  LABEL_FORMATS,
  FORMATO_PADRAO,
  findLabelFormat,
  larguraOcupadaMm,
  alturaOcupadaMm,
  porPagina,
  paginaMm,
} = await import('../src/services/core/LabelFormats.js');
const { renderLabelSheet, resumoDaFolha } = await import('../src/services/core/LabelSheet.js');

let empresa: string;
let produto: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  produto = createProduct(empresa, { name: 'Camiseta Polo Azul', priceCents: 8990 }).id;
});

describe('o catálogo de formatos', () => {
  /*
    MUDOU (auditoria C-etiquetas-02): eram sete, com o padrão "Pimaco A4356"
    na geometria da 6180 CARTA. Agora a A4356 real (63,5 × 25,4, 3 × 11) é o
    padrão, e os dois ids antigos continuam — como folhas Carta, que é o que a
    geometria deles sempre foi. Oito.
  */
  it('tem exatamente oito formatos', () => {
    expect(LABEL_FORMATS).toHaveLength(8);
  });

  it('nenhum id se repete', () => {
    const ids = LABEL_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('o formato padrão existe no catálogo', () => {
    expect(findLabelFormat(FORMATO_PADRAO)).toBeDefined();
  });

  /**
   * O padrão é de folha A4 e não de rolo. Quem abre a tela pela primeira vez
   * tem impressora comum, e é o único caso em que o papel sai no tamanho certo
   * sem configurar nada.
   */
  it('o formato padrão é de folha, não de rolo', () => {
    expect(findLabelFormat(FORMATO_PADRAO)?.midia).toBe('folha');
  });

  it('formato desconhecido não é inventado', () => {
    expect(findLabelFormat('nao_existe')).toBeUndefined();
  });
});

describe('a geometria fecha no papel', () => {
  /*
    MUDOU (auditoria C-etiquetas-02): a conta era contra a A4 fixa. As folhas
    Carta (215,9 × 279,4) agora têm a página Carta — a conta é contra o papel
    de CADA formato.
  */
  it.each(LABEL_FORMATS.filter((f) => f.midia === 'folha').map((f) => [f.id, f] as const))(
    '%s cabe na largura da própria folha',
    (_id, f) => {
      // A margem esquerda entra na conta uma vez; a direita precisa sobrar.
      expect(larguraOcupadaMm(f)).toBeLessThanOrEqual(paginaMm(f).largura);
    },
  );

  it.each(LABEL_FORMATS.filter((f) => f.midia === 'folha').map((f) => [f.id, f] as const))(
    '%s cabe na altura da própria folha',
    (_id, f) => {
      expect(alturaOcupadaMm(f)).toBeLessThanOrEqual(paginaMm(f).altura);
    },
  );

  it.each(LABEL_FORMATS.map((f) => [f.id, f] as const))(
    '%s tem medidas positivas e ao menos uma coluna',
    (_id, f) => {
      expect(f.widthMm).toBeGreaterThan(0);
      expect(f.heightMm).toBeGreaterThan(0);
      expect(f.columns).toBeGreaterThanOrEqual(1);
      expect(porPagina(f)).toBeGreaterThanOrEqual(1);
    },
  );

  /** Em rolo a página É a etiqueta: não existe folha A4 escondida. */
  it('formato de rolo tem página do tamanho da tira, não A4', () => {
    const rolo = findLabelFormat('rolo_50x30')!;
    const p = paginaMm(rolo);
    expect(p.largura).toBeLessThan(210);
    expect(p.altura).toBeLessThan(297);
  });
});

describe('a folha renderizada', () => {
  function folha(formatId: string, quantidade = 1) {
    const f = findLabelFormat(formatId)!;
    const items = buildLabels(empresa, [{ productId: produto, quantity: quantidade }]);
    return { html: renderLabelSheet({ format: f, items, companyId: empresa }), f, items };
  }

  /**
   * `@page` em milímetro é o que faz o adesivo sair no tamanho certo. Sem ele
   * a folha herda o A4 retrato com margem de documento de `src/index.css`.
   */
  it('declara @page em milímetro', () => {
    expect(folha('rolo_50x30').html).toContain('@page { size: 50mm 30mm');
  });

  it('a folha A4 declara 210mm de largura', () => {
    expect(folha(FORMATO_PADRAO).html).toContain('@page { size: 210mm 297mm');
  });

  it('quantidade 3 vira três etiquetas no papel', () => {
    const { html } = folha(FORMATO_PADRAO, 3);
    expect(html.split('class="etq"').length - 1).toBe(3);
  });

  /** Paginação errada desperdiça folha adesiva, que custa. */
  it('quebra em folhas quando passa do que cabe', () => {
    const f = findLabelFormat(FORMATO_PADRAO)!;
    const cabem = porPagina(f); // 30
    const { html } = folha(FORMATO_PADRAO, cabem + 1);
    expect(html.split('class="folha"').length - 1).toBe(2);
  });

  it('conta etiquetas e folhas antes de imprimir', () => {
    const f = findLabelFormat(FORMATO_PADRAO)!;
    // Uma a mais do que cabe na folha (33 na A4356; eram 30 na geometria Carta).
    const uma = porPagina(f) + 1;
    const items = buildLabels(empresa, [{ productId: produto, quantity: uma }]);
    expect(resumoDaFolha(f, items)).toEqual({ etiquetas: uma, folhas: 2 });
  });

  /**
   * Cartaz de gôndola é para ler de longe: ninguém bipa a prateleira, e as
   * barras roubariam o espaço do preço.
   */
  it('o cartaz de gôndola não traz código de barras', () => {
    const f = findLabelFormat('a4_gondola_2x5')!;
    expect(f.campos).not.toContain('barras');
    expect(folha('a4_gondola_2x5').html).not.toContain('class="barras"');
  });

  /** Em 22 mm de altura, atributo e rodapé roubariam o espaço das barras. */
  it('a etiqueta pequena abre mão de atributos e rodapé', () => {
    const f = findLabelFormat('rolo_33x22')!;
    expect(f.campos).not.toContain('atributos');
    expect(f.campos).not.toContain('empresa');
    expect(f.campos).toContain('barras');
  });

  it('o nome da empresa sai da própria empresa da sessão', () => {
    expect(folha('rolo_50x30').html).toContain('Preço Justo');
  });
});

describe('o preço da etiqueta é o preço do caixa', () => {
  /** Promoção ativa: a prateleira não pode anunciar o preço cheio. */
  it('com promoção vigente, a etiqueta sai com o preço promocional', () => {
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents,
                                      active, starts_at, created_at)
         VALUES ('promo-1', ?, ?, 4990, 1, '2020-01-01T00:00:00.000Z', ?)`,
      )
      .run(empresa, produto, new Date().toISOString());

    const [item] = buildLabels(empresa, [{ productId: produto, quantity: 1 }]);
    expect(item.priceCents).toBe(4990);
    expect(item.listPriceCents).toBe(8990);
    expect(item.onSale).toBe(true);
  });

  it('sem promoção, o preço de tabela e o vigente são o mesmo', () => {
    const [item] = buildLabels(empresa, [{ productId: produto, quantity: 1 }]);
    expect(item.priceCents).toBe(8990);
    expect(item.onSale).toBe(false);
  });

  /**
   * Um preço riscado ao lado do outro numa etiqueta sem promoção é a receita
   * para o cliente ler o errado.
   */
  it('o "de / por" só aparece quando há promoção', () => {
    const f = findLabelFormat(FORMATO_PADRAO)!;
    const semPromo = buildLabels(empresa, [{ productId: produto, quantity: 1 }]);
    // `class="..."` e não `preco-bloco` solto: a regra de estilo existe sempre,
    // e procurar por ela acharia o CSS em vez do elemento.
    expect(renderLabelSheet({ format: f, items: semPromo, companyId: empresa })).not.toContain(
      'class="preco-bloco"',
    );

    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents,
                                      active, starts_at, created_at)
         VALUES ('promo-2', ?, ?, 4990, 1, '2020-01-01T00:00:00.000Z', ?)`,
      )
      .run(empresa, produto, new Date().toISOString());
    const comPromo = buildLabels(empresa, [{ productId: produto, quantity: 1 }]);
    expect(renderLabelSheet({ format: f, items: comPromo, companyId: empresa })).toContain(
      'class="preco-bloco"',
    );
  });
});
