/**
 * Arquivo de produtos para a balança.
 *
 * O que este arquivo prova são as regras COMUNS às três marcas, que eu conheço:
 * uma linha por item, sem acento, preço em centavos inteiros, largura fixa
 * respeitada, e produto que não pode ir embora aparece em `skipped` com o
 * motivo escrito.
 *
 * O que ele NÃO prova — e nenhum teste aqui poderia — é que o layout de Toledo,
 * Urano e Filizola está correto contra equipamento real. Por isso os três vêm
 * marcados `confirmado: false`, e há teste cobrando essa marcação: se alguém
 * inverter para `true` sem ter testado numa balança, o teste quebra e pergunta.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, updateProduct } = await import('../src/services/core/CatalogService.js');
const {
  SCALE_FORMATS,
  buildScaleFile,
  findScaleFormat,
  listWeighableProducts,
  semAcento,
} = await import('../src/services/core/ScaleExportService.js');

let empresa: string;

/** Cria um produto já pesável e com PLU — o caso que DEVE sair no arquivo. */
function pesavel(nome: string, plu: string, precoCents: number, tara?: number): string {
  const id = createProduct(empresa, { name: nome, priceCents: precoCents }).id;
  updateProduct(empresa, id, { weighable: true, pluCode: plu, tareGrams: tara ?? null });
  return id;
}

function linhas(formatId: string): string[] {
  return buildScaleFile(empresa, { formatId })
    .content.split('\r\n')
    .filter(Boolean);
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
});

describe('o catálogo de formatos de balança', () => {
  it('tem os quatro layouts, e nenhum id repetido', () => {
    expect(SCALE_FORMATS).toHaveLength(4);
    const ids = SCALE_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Este teste é uma trava de honestidade. Publicar um layout de marca como
   * confirmado sem ter testado numa balança produz um arquivo que o
   * equipamento recusa sem explicar — e a culpa cai no sistema.
   */
  it('os três layouts de marca continuam declarados como NÃO confirmados', () => {
    for (const id of ['toledo_mgv', 'urano', 'filizola']) {
      expect(findScaleFormat(id)?.confirmado).toBe(false);
    }
  });

  it('o CSV genérico é o único confirmado — é o que este código controla', () => {
    expect(findScaleFormat('csv_generico')?.confirmado).toBe(true);
  });

  it('formato desconhecido é recusado', () => {
    expect(() => buildScaleFile(empresa, { formatId: 'nao_existe' })).toThrow(/desconhecido/i);
  });
});

describe('o que entra e o que fica de fora', () => {
  it('produto pesável com PLU sai no arquivo', () => {
    pesavel('Melancia', '000123', 599);
    const r = buildScaleFile(empresa, { formatId: 'csv_generico' });
    expect(r.lineCount).toBe(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('produto não pesável fica de fora, com o motivo escrito', () => {
    createProduct(empresa, { name: 'Camiseta Polo', priceCents: 8990 });
    const r = buildScaleFile(empresa, { formatId: 'csv_generico' });
    expect(r.lineCount).toBe(0);
    expect(r.skipped[0].reason).toMatch(/peso/i);
  });

  /** Pesável sem PLU é o erro mais comum: a balança acha o produto por ele. */
  it('pesável sem PLU fica de fora, dizendo que falta o PLU', () => {
    const id = createProduct(empresa, { name: 'Tomate', priceCents: 899 }).id;
    updateProduct(empresa, id, { weighable: true });
    const r = buildScaleFile(empresa, { formatId: 'csv_generico' });
    expect(r.lineCount).toBe(0);
    expect(r.skipped[0].reason).toMatch(/PLU/);
  });

  it('produto inativo fica de fora', () => {
    const id = pesavel('Banana', '000200', 499);
    updateProduct(empresa, id, { active: false });
    const r = buildScaleFile(empresa, { formatId: 'csv_generico' });
    expect(r.lineCount).toBe(0);
    expect(r.skipped[0].reason).toMatch(/inativo/i);
  });

  it('dá para exportar só os produtos escolhidos', () => {
    const melancia = pesavel('Melancia', '000123', 599);
    pesavel('Mamao', '000124', 799);
    const r = buildScaleFile(empresa, { formatId: 'csv_generico', productIds: [melancia] });
    expect(r.lineCount).toBe(1);
  });

  it('a lista de pesáveis mostra quem já está pronto para a balança', () => {
    pesavel('Melancia', '000123', 599);
    createProduct(empresa, { name: 'Camiseta Polo', priceCents: 8990 });
    expect(listWeighableProducts(empresa).map((p) => p.name)).toEqual(['Melancia']);
  });
});

describe('as regras comuns às três marcas', () => {
  /** Balança é equipamento antigo: acento vira caractere ilegível no visor. */
  it('acento e cedilha somem, e o texto sai em maiúscula', () => {
    expect(semAcento('Melancia Fatiada — Açaí')).toBe('MELANCIA FATIADA  ACAI');
  });

  it('o nome do produto sai sem acento no arquivo', () => {
    pesavel('Açaí na Tigela', '000300', 1599);
    expect(linhas('csv_generico')[1]).toContain('ACAI NA TIGELA');
  });

  /** Preço com vírgula ou ponto desloca todos os campos à direita. */
  it('o preço sai em centavos inteiros, sem separador', () => {
    pesavel('Melancia', '000123', 599);
    expect(linhas('csv_generico')[1].split(';')[3]).toBe('599');
  });

  /**
   * O código de barras NÃO vai no arquivo: a balança compõe o EAN-13 sozinha,
   * a partir do prefixo dela mais o PLU mais o peso.
   */
  it('o código de barras não entra no arquivo', () => {
    const id = pesavel('Melancia', '000123', 599);
    const conteudo = buildScaleFile(empresa, { formatId: 'csv_generico' }).content;
    expect(conteudo).not.toContain(id);
    expect(conteudo).not.toMatch(/\d{13}/);
  });

  it('a tara sai em gramas, e vira zero quando não há', () => {
    pesavel('Salada Pote', '000400', 1299, 35);
    pesavel('Melancia', '000123', 599);
    const l = linhas('csv_generico');
    expect(l[1].split(';')[5]).toBe('0'); // 000123, sem tara
    expect(l[2].split(';')[5]).toBe('35'); // 000400
  });

  it('o arquivo termina em CRLF — o importador roda em Windows', () => {
    pesavel('Melancia', '000123', 599);
    expect(buildScaleFile(empresa, { formatId: 'csv_generico' }).content.endsWith('\r\n')).toBe(
      true,
    );
  });
});

describe('largura fixa', () => {
  it('cada linha tem exatamente a soma das larguras dos campos', () => {
    pesavel('Melancia', '000123', 599);
    const f = findScaleFormat('toledo_mgv')!;
    const largura = f.fields.reduce((t, c) => t + c.width, 0);
    expect(linhas('toledo_mgv')[0]).toHaveLength(largura);
  });

  it('nome comprido é cortado na largura, não empurra o resto', () => {
    pesavel('Melancia Fatiada Bandeja Grande Premium Especial', '000123', 599);
    const f = findScaleFormat('toledo_mgv')!;
    const largura = f.fields.reduce((t, c) => t + c.width, 0);
    expect(linhas('toledo_mgv')[0]).toHaveLength(largura);
  });

  it('o PLU é preenchido com zero à esquerda', () => {
    pesavel('Melancia', '123', 599);
    expect(linhas('toledo_mgv')[0].slice(0, 6)).toBe('000123');
  });

  it('o layout delimitado não preenche com zero à toa', () => {
    pesavel('Melancia', '123', 599);
    expect(linhas('csv_generico')[1].split(';')[0]).toBe('123');
  });
});

describe('o PLU é único por empresa', () => {
  /** Dois produtos com o mesmo PLU fariam a balança vender um pelo preço do outro. */
  it('o banco recusa PLU repetido na mesma empresa', () => {
    pesavel('Melancia', '000123', 599);
    expect(() => pesavel('Mamao', '000123', 799)).toThrow();
  });

  it('empresas diferentes podem usar o mesmo PLU', () => {
    pesavel('Melancia', '000123', 599);
    const outra = upsertCompany({
      slug: 'conceito',
      legalName: 'Conceito Ltda',
      tradeName: 'Conceito',
      kind: 'store',
    });
    const id = createProduct(outra, { name: 'Melancia', priceCents: 599 }).id;
    expect(() => updateProduct(outra, id, { weighable: true, pluCode: '000123' })).not.toThrow();
  });
});
