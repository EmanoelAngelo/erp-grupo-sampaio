/**
 * ETIQUETAS — trilha "etiquetas" da auditoria PJ (lote 5).
 *
 * D-pdv-teclado-16#gerador  O EAN interno é "2 + 11 dígitos de sequência". Ele
 *                 só fica no "20…" enquanto a sequência não passa de 10^10 − 1.
 *                 O salto de `ensureBarcode` (para depois do MAIOR código "2…"
 *                 cadastrado) contava também um "21…" posto num produto depois
 *                 de a balança ser declarada no 21, e a contagem simples também
 *                 chega lá: o produto novo ganhava um código que a busca do
 *                 balcão lê como "PLU + peso" de OUTRO produto.
 *
 * PED-etq-02      O cabeçalho de LabelSheet.ts dizia que a etiqueta avulsa da
 *                 fila tinha desenho próprio de 50 × 30 e segunda via
 *                 congelada. Hoje ela é a folha `rolo_50x30` e a segunda via é
 *                 redesenhada.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const { addProductBarcode, codigoNaFaixaDaBalanca, gravarConfigDaEtiquetaDaBalanca } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { buildLabels, ean13CheckDigit, ensureBarcode, generateInternalEan13 } = await import(
  '../src/services/core/BarcodeService.js'
);
const { renderLabelSheet } = await import('../src/services/core/LabelSheet.js');
const { findLabelFormat } = await import('../src/services/core/LabelFormats.js');
const { renderDocument } = await import('../src/services/core/PrintRenderer.js');
const { TIPOS_QUE_SEGUEM_O_CADASTRO } = await import('../src/services/core/PrintEngine.js');

let empresa: string;

function eanInterno(seq: number): string {
  const corpo = `2${String(seq).padStart(11, '0')}`;
  return `${corpo}${ean13CheckDigit(corpo)}`;
}

/** Os 12 primeiros dígitos viram um EAN-13 com o verificador certo. */
function ean(corpo12: string): string {
  return `${corpo12}${ean13CheckDigit(corpo12)}`;
}

function produto(nome: string, extra: Record<string, unknown> = {}): string {
  return String(createProduct(empresa, { name: nome, priceCents: 1990, ...extra }).id);
}

function sequenciaEm(valor: number) {
  getConnection()
    .prepare(
      `INSERT INTO core_sequences (company_id, name, current) VALUES (?, 'barcode', ?)
       ON CONFLICT (company_id, name) DO UPDATE SET current = excluded.current`,
    )
    .run(empresa, valor);
}

function codigoNoBanco(id: string): string | null {
  return (getConnection().prepare('SELECT barcode FROM core_products WHERE id = ?').get(id) as { barcode: string | null })
    .barcode;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({ slug: 'preco-justo-etq', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo', kind: 'store' });
  // A tabela da declaração não está na lista do reset: cada teste começa sem ela.
  gravarConfigDaEtiquetaDaBalanca(empresa, null);
});

describe('D-pdv-teclado-16#gerador — o EAN interno nunca cai na faixa declarada da balança', () => {
  it('um "21…" cadastrado depois da declaração não arrasta o salto para dentro da faixa: o gerado segue no "20…"', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '21', digitosDoPlu: 4, valorEmbutido: 'peso' });
    // A caixa fechada que veio do sistema antigo com uma etiqueta "21…", posta
    // DEPOIS da declaração. Gravada direto na tabela, e não por
    // `addProductBarcode`: o código chega também por caminhos que não consultam
    // a declaração (importação, sincronização), e este teste é do GERADOR — se
    // o cadastro passar a recusar código na faixa, a prova continua valendo.
    getConnection()
      .prepare(
        'INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), empresa, produto('Caixa de tomate'), ean('210105000352'), new Date().toISOString());
    // O próximo da sequência (1) já é código adicional de outro produto: o
    // gerador precisa saltar.
    addProductBarcode(empresa, produto('Legado'), eanInterno(1));

    const gerado = ensureBarcode(empresa, produto('Camiseta')).barcode;
    // Antes: o salto ia para depois do "2101050003520" e devolvia "210105000353…",
    // lido pela busca como PLU 0105 + 353 g.
    expect(gerado.startsWith('21')).toBe(false);
    expect(codigoNaFaixaDaBalanca(empresa, gerado)).toBe(false);
    // E não queima o resto do "20…": o salto conta só os internos de verdade.
    expect(gerado).toBe(eanInterno(2));
  });

  it('a contagem chegando ao fim do "20…" pula a subfaixa inteira da balança de uma vez', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'preco' });
    sequenciaEm(9_999_999_999);
    // Antes: "2100000000000…", dentro da faixa.
    expect(ensureBarcode(empresa, produto('Primeiro depois do 20')).barcode).toBe(eanInterno(20_000_000_000));
    expect(ensureBarcode(empresa, produto('Segundo')).barcode).toBe(eanInterno(20_000_000_001));
  });

  it('sem balança declarada, nada muda: o número seguinte é o da sequência', () => {
    sequenciaEm(9_999_999_999);
    expect(generateInternalEan13(empresa)).toBe(eanInterno(10_000_000_000));
  });

  it('a balança na última subfaixa (29) e a sequência no fim da 28: 409 com a frase, e o produto fica sem código', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '29', digitosDoPlu: 4, valorEmbutido: 'peso' });
    sequenciaEm(89_999_999_999);
    const p = produto('Sem faixa');
    let erro: { code?: string; message?: string } | null = null;
    try {
      ensureBarcode(empresa, p);
    } catch (e) {
      erro = e as { code?: string; message?: string };
    }
    // Antes: devolvia "2900000000000…" e gravava no produto.
    expect(erro?.code).toBe('CORE_BARCODE_SEQUENCE_EXHAUSTED');
    expect(erro?.message).toMatch(/balança/);
    expect(erro?.message).toMatch(/EAN do fabricante/);
    expect(codigoNoBanco(p)).toBeNull();
  });

  it('a folha de etiquetas, que gera o código de quem não tem, também fica fora da faixa', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '21', digitosDoPlu: 4, valorEmbutido: 'peso' });
    sequenciaEm(9_999_999_999);
    const [item] = buildLabels(empresa, [{ productId: produto('Vassoura') }]);
    expect(item.codigoGerado).toBe(true);
    expect(codigoNaFaixaDaBalanca(empresa, item.barcode)).toBe(false);
    expect(item.barcode).toBe(eanInterno(20_000_000_000));
  });
});

describe('PED-etq-02 — o cabeçalho de LabelSheet.ts diz o que o código faz hoje', () => {
  const fonte = readFileSync(new URL('../src/services/core/LabelSheet.ts', import.meta.url), 'utf8');
  const cabecalho = fonte.slice(0, fonte.indexOf('*/'));

  it('não descreve mais um desenho próprio de 50 × 30 com segunda via congelada', () => {
    expect(cabecalho).not.toMatch(/desenha UMA etiqueta de 50 × 30/);
    expect(cabecalho).not.toMatch(/reimprime a partir do payload congelado/);
    expect(cabecalho).toMatch(/rolo_50x30/);
    expect(cabecalho).toMatch(/TIPOS_QUE_SEGUEM_O_CADASTRO/);
  });

  it('o que o cabeçalho afirma é verdade: a etiqueta da fila É a folha rolo_50x30, e a segunda via é redesenhada', () => {
    const p = produto('Blusa', { barcode: '7891234567895' });
    const formato = findLabelFormat('rolo_50x30')!;
    const daFolha = renderLabelSheet({
      format: formato,
      items: buildLabels(empresa, [{ productId: p, quantity: 1 }], { campos: formato.campos, podeGerarCodigo: false }),
      companyId: empresa,
    });
    expect(renderDocument(empresa, 'PRODUCT_LABEL', p)).toBe(daFolha);
    expect(TIPOS_QUE_SEGUEM_O_CADASTRO).toContain('PRODUCT_LABEL');
  });
});
