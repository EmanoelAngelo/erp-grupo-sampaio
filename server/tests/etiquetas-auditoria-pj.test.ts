/**
 * ============================================================================
 * ETIQUETAS — os achados da auditoria da Preço Justo, um a um
 * ============================================================================
 *
 * Cada `describe` nomeia o achado. Cada teste falha com o código de antes:
 *
 *   - o código de barras interno colide com código adicional e trava a folha
 *     em 500 (C-etiquetas-04, A-produto-20);
 *   - a prévia mostra o EAN de OUTRO produto (A-produto-21, C-etiquetas-16);
 *   - o preço é cortado no adesivo (C-etiquetas-01);
 *   - a folha "Pimaco A4356" tinha a geometria da 6180 Carta (C-etiquetas-02);
 *   - EAN-8, UPC-A e código próprio saíam "SEM CÓDIGO DE BARRAS", e EAN com
 *     verificador errado saía com barras que o leitor recusa (C-etiquetas-03);
 *   - o módulo das barras sem mínimo nem ponto da impressora (C-etiquetas-05);
 *   - a descrição INTERNA na gôndola (C-etiquetas-07);
 *   - variantes com etiquetas idênticas (C-etiquetas-08);
 *   - quantidade cortada em silêncio e lote sem teto (C-etiquetas-09/10);
 *   - impressora de etiqueta "de agente" (C-etiquetas-11);
 *   - nome cortado no meio da linha (C-etiquetas-12); número sem desenho
 *     (C-etiquetas-13); o caixa carimbando EAN no cadastro (C-etiquetas-14);
 *     EAN gravado para cartaz sem código (C-etiquetas-15); margem do rolo
 *     (C-etiquetas-19); preço de tabela na fila (C-etiquetas-20);
 *   - o modelo da grade na fila (M02); a folha sempre na célula 1 (M03); o
 *     lote sem transação nem trilha (M04);
 *   - a origem pela NOTA de entrada e o pedido com a última entrega
 *     (B-estoque-entrada-07/20, C-etiquetas-M06).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import {
  EAN_DE_AMOSTRA,
  buildLabels,
  ean13CheckDigit,
  ensureBarcode,
  itemParaPrevia,
  type LabelItem,
} from '../src/services/core/BarcodeService.js';
import {
  avisosDoFormato,
  larguraDoTextoEmEm,
  problemasDosCodigos,
  renderLabelSheet,
  resumoDaFolha,
} from '../src/services/core/LabelSheet.js';
import {
  CAMPOS_DA_ETIQUETA,
  FORMATO_PADRAO,
  findLabelFormat,
  paginaMm,
  porPagina,
  type LabelFormat,
} from '../src/services/core/LabelFormats.js';
import { criarModelo, formatoDoModelo, validarModelo } from '../src/services/core/LabelTemplateService.js';
import { listLabelCandidates } from '../src/services/core/LabelSourcesService.js';
import { CODE128_TABELA, code128Bits, desenhoDoCodigo } from '../src/services/core/Ean13.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { addProductBarcode, findProductByAnyBarcode } from '../src/services/core/CatalogAuxService.js';
import { generateVariants } from '../src/services/core/VariantService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSupplier } from '../src/services/core/SupplierService.js';
import { createPurchaseOrder } from '../src/services/core/PurchaseOrderService.js';
import { upsertPrinter } from '../src/services/core/PrintEngine.js';

const app = createApp();
const EMPRESA = 'loja-etq';
const PX_POR_MM = 96 / 25.4;
let gerente: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, { userId: 'gerente', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
});

async function entrarComoCaixa() {
  const c = await loginForTest(app, { userId: 'caixa', companyId: EMPRESA, profileCodes: ['operador_caixa_loja'] });
  return { Authorization: `Bearer ${c.body.accessToken}` };
}

function eanInterno(seq: number): string {
  const corpo = `2${String(seq).padStart(11, '0')}`;
  return `${corpo}${ean13CheckDigit(corpo)}`;
}

function produto(nome: string, extra: Record<string, unknown> = {}): string {
  return String(createProduct(EMPRESA, { name: nome, priceCents: 1990, ...extra }).id);
}

function codigoNoBanco(id: string): string | null {
  return (getConnection().prepare('SELECT barcode FROM core_products WHERE id = ?').get(id) as { barcode: string | null }).barcode;
}

function modelo(entrada: Record<string, unknown>): LabelFormat {
  return formatoDoModelo(validarModelo({ name: 'Modelo de teste', midia: 'rolo', ...entrada }, EMPRESA));
}

function folha(f: LabelFormat, ids: string[], extra: { comecarEm?: number } = {}): string {
  const items = buildLabels(EMPRESA, ids.map((productId) => ({ productId })), { campos: f.campos });
  return renderLabelSheet({ format: f, items, companyId: EMPRESA, ...extra });
}

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function promocao(productId: string, precoCents: number) {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions (id, company_id, product_id, price_cents, active, starts_at, created_at)
       VALUES (?, ?, ?, ?, 1, '2020-01-01T00:00:00.000Z', ?)`,
    )
    .run(`promo-${productId}`, EMPRESA, productId, precoCents, new Date().toISOString());
}

/** Os corpos de letra dos preços na folha, na ordem. */
function corposDoPreco(html: string, classe: 'preco' | 'de' = 'preco'): number[] {
  return [...html.matchAll(new RegExp(`class="${classe}" style="font-size:([\\d.]+)px"`, 'g'))].map((m) => Number(m[1]));
}

// ------------------------------------------------------------ código interno

describe('C-etiquetas-04 / A-produto-20 — o EAN interno não colide nem trava a folha', () => {
  it('sequências 1 a 10 no cadastro e a 11 como código ADICIONAL: o gerado é o 12, depois o 13 — sem 500', () => {
    for (let s = 1; s <= 10; s += 1) produto(`Legado ${s}`, { barcode: eanInterno(s) });
    addProductBarcode(EMPRESA, produto('Dono do adicional'), eanInterno(11));
    const a = produto('Novo A');
    const b = produto('Novo B');
    expect(ensureBarcode(EMPRESA, a).barcode).toBe(eanInterno(12));
    expect(ensureBarcode(EMPRESA, b).barcode).toBe(eanInterno(13));
  });

  it('código adicional igual ao próximo da sequência não vira dois donos do mesmo bipe', () => {
    const dono = produto('Dono');
    addProductBarcode(EMPRESA, dono, eanInterno(1));
    const novo = produto('Novo');
    const r = ensureBarcode(EMPRESA, novo);
    expect(r.barcode).not.toBe(eanInterno(1));
    expect(findProductByAnyBarcode(EMPRESA, eanInterno(1))).toBe(dono);
    expect(findProductByAnyBarcode(EMPRESA, r.barcode)).toBe(novo);
  });

  it('o EAN gravado vai para a central (product.upserted), como a edição do cadastro', () => {
    const p = produto('Sincronizado');
    const conta = () =>
      (getConnection()
        .prepare("SELECT count(*) AS n FROM core_outbox WHERE aggregate_id = ? AND event_type = 'product.upserted'")
        .get(p) as { n: number }).n;
    const antes = conta();
    ensureBarcode(EMPRESA, p);
    expect(conta()).toBe(antes + 1);
  });

  it('a faixa acabou: 409 com a frase, e não 500', async () => {
    const p = produto('Sem faixa');
    getConnection()
      .prepare(
        `INSERT INTO core_sequences (company_id, name, current) VALUES (?, 'barcode', 99999999999)
         ON CONFLICT (company_id, name) DO UPDATE SET current = excluded.current`,
      )
      .run(EMPRESA);
    const r = await request(app).post(`/api/v1/core/products/${p}/barcode/internal`).set(gerente).send({});
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('CORE_BARCODE_SEQUENCE_EXHAUSTED');
    expect(codigoNoBanco(p)).toBeNull();
  });
});

// -------------------------------------------------------------------- prévia

describe('A-produto-21 / C-etiquetas-16 — a prévia não mostra o código de outro produto', () => {
  it('a amostra não é o EAN interno da sequência 1, nem da faixa 2 que o gerador usa', () => {
    const primeiro = ensureBarcode(EMPRESA, produto('Primeiro com EAN interno')).barcode;
    expect(primeiro).toBe(eanInterno(1));
    expect(itemParaPrevia(EMPRESA, null).barcode).toBe(EAN_DE_AMOSTRA);
    expect(EAN_DE_AMOSTRA).not.toBe(primeiro);
    expect(EAN_DE_AMOSTRA.startsWith('2')).toBe(false);
  });

  it('produto real sem código: a prévia não desenha amostra no lugar dele, e diz que o código nasce ao imprimir', () => {
    ensureBarcode(EMPRESA, produto('Outro, com código'));
    const semCodigo = produto('Vassoura');
    const item = itemParaPrevia(EMPRESA, semCodigo);
    expect(item.barcode).toBe('');
    const html = renderLabelSheet({ format: findLabelFormat('rolo_50x30')!, items: [item], companyId: EMPRESA });
    expect(html).toContain('GERADO AO IMPRIMIR');
    expect(html).not.toContain(eanInterno(1));
    expect(html).not.toContain('<svg');
    expect(codigoNoBanco(semCodigo)).toBeNull();
  });

  it('a amostra sem produto é o PIOR caso: nome de 60 letras e R$ 9.999,99 em promoção', () => {
    const item = itemParaPrevia(EMPRESA, null);
    expect(item.name).toHaveLength(60);
    expect(item.priceCents).toBe(999_999);
    expect(item.onSale).toBe(true);
    expect(item.listPriceCents).toBeGreaterThan(item.priceCents);
  });
});

// --------------------------------------------------------------------- preço

describe('C-etiquetas-01 — o preço cabe na largura, ou a folha é recusada', () => {
  const paisagem = () => modelo({ paperWidthMm: 50, widthMm: 50, heightMm: 30, orientation: 'paisagem', fields: ['nome', 'preco'] });
  const util = 30 - 1.2; // em paisagem, o lado curto

  it('paisagem 50 × 30: "R$ 1.299,90" cabe nos 28,8 mm úteis (antes: 33 mm, e sumiam os centavos)', () => {
    const f = paisagem();
    const html = folha(f, [produto('Caro', { priceCents: 129_990 })]);
    const [px] = corposDoPreco(html);
    expect(px).toBeLessThan(23); // o teto pela altura; ele encolheu
    expect((larguraDoTextoEmEm(brl(129_990)) * px) / PX_POR_MM).toBeLessThanOrEqual(util);
  });

  it('com promoção, "de" e "por" não vazam juntos: ou cabem lado a lado, ou o "de" sobe', () => {
    const f = paisagem();
    const p = produto('Promo', { priceCents: 2490 });
    promocao(p, 1990);
    const html = folha(f, [p]);
    const [px] = corposDoPreco(html);
    const [pxDe] = corposDoPreco(html, 'de');
    const larguraPreco = (larguraDoTextoEmEm(brl(1990)) * px) / PX_POR_MM;
    const larguraDe = (larguraDoTextoEmEm(brl(2490)) * pxDe) / PX_POR_MM;
    if (html.includes('class="preco-bloco empilhado"')) {
      expect(larguraPreco).toBeLessThanOrEqual(util);
      expect(larguraDe).toBeLessThanOrEqual(util);
    } else {
      expect(larguraDe + 1.5 + larguraPreco).toBeLessThanOrEqual(util);
    }
  });

  it('nem no corpo mínimo cabe: a folha é recusada dizendo o produto e o preço', () => {
    // Papel de 15 mm (o mínimo que o modelo aceita) com etiqueta de 12 mm.
    const f = modelo({ paperWidthMm: 15, widthMm: 12, heightMm: 30, fields: ['nome', 'preco'] });
    expect(() => folha(f, [produto('Geladeira', { priceCents: 9_999_999 })])).toThrow(/"Geladeira".*não cabe/);
  });
});

// -------------------------------------------------------------- as folhas

describe('C-etiquetas-02 — as folhas batem com a ficha do fabricante (±0,2 mm)', () => {
  const FICHAS = {
    a4_63x25_3x11: { pagina: [210, 297], etiqueta: [63.5, 25.4], grade: [3, 11], topo: 8.8, esquerda: 7.2, passo: 66.0 },
    a4_67x25_3x10: { pagina: [215.9, 279.4], etiqueta: [66.675, 25.4], grade: [3, 10], topo: 12.7, esquerda: 4.7625, passo: 69.85 },
    a4_101x25_2x10: { pagina: [215.9, 279.4], etiqueta: [101.6, 25.4], grade: [2, 10], topo: 12.7, esquerda: 3.96875, passo: 106.3625 },
  } as const;
  const perto = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(0.2);

  it.each(Object.entries(FICHAS))('%s', (id, ficha) => {
    const f = findLabelFormat(id)!;
    expect(f.fonteDasMedidas).toBeTruthy();
    perto(paginaMm(f).largura, ficha.pagina[0]);
    perto(paginaMm(f).altura, ficha.pagina[1]);
    perto(f.widthMm, ficha.etiqueta[0]);
    perto(f.heightMm, ficha.etiqueta[1]);
    expect([f.columns, f.rows]).toEqual(ficha.grade);
    perto(f.marginTopMm, ficha.topo);
    perto(f.marginLeftMm, ficha.esquerda);
    perto(f.widthMm + f.gapXmm, ficha.passo);
    // A folha é simétrica: a margem da direita é a da esquerda, e a de baixo a de cima.
    perto(paginaMm(f).largura - (f.marginLeftMm + f.columns * f.widthMm + (f.columns - 1) * f.gapXmm), ficha.esquerda);
    perto(paginaMm(f).altura - (f.marginTopMm + f.rows! * f.heightMm), ficha.topo);
  });

  it('o padrão é a A4356 real (33 por folha), e as folhas Carta não mandam comprar A4', () => {
    expect(FORMATO_PADRAO).toBe('a4_63x25_3x11');
    const padrao = findLabelFormat(FORMATO_PADRAO)!;
    expect(padrao.hint).toMatch(/A4356/);
    expect(porPagina(padrao)).toBe(33);
    for (const id of ['a4_67x25_3x10', 'a4_101x25_2x10']) {
      const f = findLabelFormat(id)!;
      expect(f.label).toMatch(/Carta/);
      expect(`${f.label} ${f.hint}`).not.toMatch(/A4356|A4260/);
    }
    const html = folha(findLabelFormat('a4_67x25_3x10')!, [produto('Carta')]);
    expect(html).toContain('@page { size: 215.9mm 279.4mm');
  });
});

// ---------------------------------------------------------- o desenho do código

describe('C-etiquetas-03 — o código cadastrado vira barra, e o inválido não finge ser válido', () => {
  it.each([
    ['96385074', 'EAN-8'],
    ['036000291452', 'UPC-A'],
    ['PJ-ABC-001', 'Code128'],
    ['123456', 'Code128'],
  ])('%s sai como %s, com o número embaixo — nunca "SEM CÓDIGO DE BARRAS"', (codigo, simbologia) => {
    const f = findLabelFormat('rolo_60x40')!;
    const html = folha(f, [produto(`Item ${codigo}`, { barcode: codigo })]);
    expect(html).toContain(`data-simbologia="${simbologia}"`);
    expect(html).not.toContain('SEM CÓDIGO DE BARRAS');
    expect(html).toContain(`<div class="ean">${codigo}</div>`);
  });

  it('EAN-13 com verificador errado (dado legado) sai "CÓDIGO INVÁLIDO" — com o número, sem barras — e a fila avisa antes', () => {
    const p = produto('Legado torto');
    getConnection().prepare("UPDATE core_products SET barcode = '7891234567890' WHERE id = ?").run(p);
    const f = findLabelFormat('rolo_60x40')!;
    const items = buildLabels(EMPRESA, [{ productId: p }], { campos: f.campos });
    const html = renderLabelSheet({ format: f, items, companyId: EMPRESA });
    expect(html).toContain('CÓDIGO INVÁLIDO: 7891234567890');
    expect(html).not.toContain('<svg');
    expect(html).toContain('<div class="ean">7891234567890</div>');
    expect(problemasDosCodigos(f, items)[0].motivo).toMatch(/verificador errado \(o último deveria ser 5\)/);
    const fila = listLabelCandidates(EMPRESA, { source: 'catalogo', search: 'Legado torto' });
    expect(fila.candidates[0].avisoDoCodigo).toMatch(/verificador errado/);
  });

  it('a tabela do Code 128: 107 símbolos distintos, 11 módulos (o STOP, 13), barras em soma par', () => {
    expect(CODE128_TABELA).toHaveLength(107);
    expect(new Set(CODE128_TABELA).size).toBe(107);
    CODE128_TABELA.forEach((padrao, valor) => {
      const larguras = padrao.split('').map(Number);
      expect(larguras.reduce((t, w) => t + w, 0)).toBe(valor === 106 ? 13 : 11);
      expect(larguras.filter((_, i) => i % 2 === 0).reduce((t, w) => t + w, 0) % 2).toBe(0);
    });
    expect([CODE128_TABELA[104], CODE128_TABELA[105], CODE128_TABELA[106]]).toEqual(['211214', '211232', '2331112']);
  });

  /** Um leitor de Code 128 escrito à parte: larguras → símbolos → verificador → texto. */
  function lerCode128(bits: string): string {
    const larguras: number[] = [];
    for (let i = 0; i < bits.length; ) {
      let j = i;
      while (j < bits.length && bits[j] === bits[i]) j += 1;
      larguras.push(j - i);
      i = j;
    }
    expect(larguras.slice(-7).join('')).toBe('2331112');
    const valores: number[] = [];
    for (let i = 0; i < larguras.length - 7; i += 6) {
      const v = CODE128_TABELA.indexOf(larguras.slice(i, i + 6).join(''));
      expect(v).toBeGreaterThanOrEqual(0);
      valores.push(v);
    }
    const [inicio, ...resto] = valores;
    const verificador = resto.pop()!;
    expect((inicio + resto.reduce((t, v, i) => t + v * (i + 1), 0)) % 103).toBe(verificador);
    let conjunto = inicio === 105 ? 'C' : 'B';
    let texto = '';
    for (const v of resto) {
      if (conjunto === 'C') {
        if (v === 100) conjunto = 'B';
        else texto += String(v).padStart(2, '0');
      } else if (v === 99) conjunto = 'C';
      else texto += String.fromCharCode(v + 32);
    }
    return texto;
  }

  it.each(['PJ-ABC-001', '123456', '1234567', '17891234567895'])('o Code 128 de %s se lê de volta igual', (codigo) => {
    expect(lerCode128(code128Bits(codigo)!)).toBe(codigo);
  });

  it('código com caractere que o Code 128 não representa é recusado com o motivo', () => {
    const d = desenhoDoCodigo('CAFÉ-01');
    expect(d.ok).toBe(false);
  });
});

// ------------------------------------------------------ módulo das barras

describe('C-etiquetas-05 — o módulo das barras tem mínimo e cai no ponto da impressora', () => {
  it('etiqueta de 12 mm com código de barras é recusada dizendo a largura mínima', () => {
    expect(() => validarModelo({ name: 'Mini', widthMm: 12, heightMm: 20, fields: ['barras'] }, EMPRESA)).toThrow(/ao menos 22,7 mm/);
  });

  it('em paisagem conta o lado curto: 60 × 20 em paisagem é recusado', () => {
    expect(() =>
      validarModelo({ name: 'Deitada', widthMm: 60, heightMm: 20, orientation: 'paisagem', fields: ['barras'] }, EMPRESA),
    ).toThrow(/em paisagem as barras correm na altura/);
  });

  /*
    MUDOU (reauditoria de C-etiquetas-05): "40 × 30 passa sem aviso" era o
    defeito. A 203 dpi (o padrão do rolo) o módulo de 0,343 mm são 2,75 pontos
    da térmica — barras de 2 e de 3 pontos misturadas —, e ninguém era avisado.
    Agora 40 × 30 a 203 dpi passa COM o aviso do ponto quebrado (e sem o do GS1);
    a 300 dpi, onde o módulo fecha em 4 pontos, passa sem aviso.
  */
  it('30 × 20 passa, com o aviso do mínimo GS1; 40 × 30 a 203 dpi avisa o ponto quebrado; a 300 dpi, sem aviso', () => {
    expect(avisosDoFormato(modelo({ paperWidthMm: 30, widthMm: 30, heightMm: 20, fields: ['nome', 'barras'] })).join(' ')).toMatch(/mínimo GS1/);
    const a203 = avisosDoFormato(modelo({ paperWidthMm: 40, widthMm: 40, heightMm: 30, fields: ['nome', 'barras'] }));
    expect(a203.join(' ')).toMatch(/pontos inteiros/);
    expect(a203.join(' ')).not.toMatch(/mínimo GS1/);
    expect(avisosDoFormato(modelo({ paperWidthMm: 40, widthMm: 40, heightMm: 30, fields: ['nome', 'barras'], dpi: 300 }))).toEqual([]);
  });

  const larguraDasBarras = (html: string) => Number(html.match(/style="width:([\d.]+)mm;height:100%"/)![1]);

  it('no rolo de 50 mm, a largura das barras é 113 módulos de um número INTEIRO de pontos de 203 dpi', () => {
    const f = modelo({ paperWidthMm: 50, widthMm: 50, heightMm: 30, fields: ['nome', 'barras'] });
    const largura = larguraDasBarras(folha(f, [produto('Arroz', { barcode: '7891234567895' })]));
    const pontos = largura / 113 / (25.4 / 203);
    expect(Math.abs(pontos - Math.round(pontos))).toBeLessThan(0.01);
    expect(largura / 113).toBeGreaterThanOrEqual(0.264);
    expect(largura).toBeLessThanOrEqual(50 - 1.2);
  });

  it('no rolo de 40 mm, o arredondamento NÃO derruba o módulo para baixo do mínimo GS1 (fica 0,343 mm, não 0,25)', () => {
    const f = modelo({ paperWidthMm: 40, widthMm: 40, heightMm: 30, fields: ['nome', 'barras'] });
    const largura = larguraDasBarras(folha(f, [produto('Feijão', { barcode: '7891234567895' })]));
    expect(largura / 113).toBeGreaterThanOrEqual(0.264);
    expect(largura).toBeLessThanOrEqual(40 - 1.2);
  });
});

// ------------------------------------------------------------ descrição

describe('C-etiquetas-07 — a etiqueta imprime a descrição PÚBLICA, nunca a interna', () => {
  it('"Descrição" marcada mostra a da loja online, e não a anotação da equipe', () => {
    const p = produto('Hidratante');
    getConnection()
      .prepare("UPDATE core_products SET description = 'Fornecedor X — margem baixa, não dar desconto', online_description = 'Hidratante corporal 200 ml' WHERE id = ?")
      .run(p);
    const html = folha(modelo({ paperWidthMm: 50, widthMm: 50, heightMm: 30, fields: ['nome', 'descricao'] }), [p]);
    expect(html).toContain('Hidratante corporal 200 ml');
    expect(html).not.toContain('margem baixa');
    expect(CAMPOS_DA_ETIQUETA.find((c) => c.id === 'descricao')?.rotulo).toMatch(/loja online/);
  });
});

// ------------------------------------------------------------------ grade

describe('C-etiquetas-08 — variantes da mesma grade não saem com etiquetas iguais', () => {
  function grade() {
    const pai = produto('Camiseta Básica');
    const { created } = generateVariants({ companyId: EMPRESA, productId: pai, axes: { tamanho: ['P', 'M', 'G'] } });
    return { pai, variantes: created.map((v) => String(v.id)) };
  }

  it('sem a linha da grade no formato, o título é o nome completo de cada variante', () => {
    const { variantes } = grade();
    const f = findLabelFormat('rolo_33x22')!;
    expect(f.campos).not.toContain('atributos');
    const nomes = buildLabels(EMPRESA, variantes.map((productId) => ({ productId })), { campos: f.campos }).map((i) => i.name);
    expect(new Set(nomes).size).toBe(3);
    expect(nomes.every((n) => n !== 'Camiseta Básica')).toBe(true);
  });

  it('com a linha da grade, o título é o do modelo e a grade diferencia', () => {
    const { variantes } = grade();
    const itens = buildLabels(EMPRESA, variantes.map((productId) => ({ productId })), { campos: findLabelFormat('rolo_50x30')!.campos });
    expect(new Set(itens.map((i) => i.name))).toEqual(new Set(['Camiseta Básica']));
    expect(new Set(itens.map((i) => i.attributes)).size).toBe(3);
  });
});

// --------------------------------------------------- quantidade e teto do lote

describe('C-etiquetas-09 / C-etiquetas-10 — quantidade e tamanho do lote são conferidos', () => {
  it('350 etiquetas de um item: 400 dizendo o produto (antes saíam 200 em silêncio)', async () => {
    const p = produto('Parafuso 3/8');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: p, quantity: 350 }] });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABEL_QUANTITY_INVALID');
    expect(r.body.error?.message).toMatch(/"Parafuso 3\/8"/);
  });

  it('quantidade "abc": 400 (antes: NaN e zero etiquetas)', async () => {
    const p = produto('Porca');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: p, quantity: 'abc' }] });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABEL_QUANTITY_INVALID');
  });

  it('20 itens × 200 = 4.000 etiquetas: 400 com o total e o teto', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ productId: produto(`Item ${i}`, { barcode: eanInterno(500 + i) }), quantity: 200 }));
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABELS_TOO_MANY');
    expect(r.body.error?.message).toMatch(/4\.000.*3\.000/);
  });

  it('3.000 etiquetas se montam em menos de 1 s (a etiqueta de cada item é desenhada uma vez)', () => {
    const f = findLabelFormat(FORMATO_PADRAO)!;
    const items: LabelItem[] = Array.from({ length: 15 }, (_, i) => ({
      productId: `p${i}`, name: `Produto ${i}`, internalCode: `GS-${i}`, barcode: eanInterno(900 + i), priceCents: 1990,
      listPriceCents: 1990, onSale: false, quantity: 200, attributes: '', brand: '', unit: 'UN', sku: '', shortDescription: '',
    }));
    const t0 = performance.now();
    const html = renderLabelSheet({ format: f, items, companyId: EMPRESA });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(html.split('class="etq"').length - 1).toBe(3000);
  });
});

// ------------------------------------------------------ impressora de etiqueta

describe('C-etiquetas-11 — impressora de etiqueta não é "de agente"', () => {
  it('cadastrar etiqueta com transporte de agente: 400 dizendo que sai pelo driver', async () => {
    const r = await request(app)
      .post('/api/v1/core/print/printers')
      .set(gerente)
      .send({ name: 'Zebra ZD220', kind: 'etiqueta', transport: 'agent', agentDevice: 'COM3' });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_PRINTER_AGENT_ONLY_RECEIPT');
  });

  it('a página de teste (ESC/POS) numa impressora de etiqueta antiga "de agente": 400', async () => {
    const antiga = upsertPrinter({ companyId: EMPRESA, name: 'Argox antiga', kind: 'etiqueta', transport: 'agent', agentDevice: 'COM3' });
    const r = await request(app).post(`/api/v1/core/print/printers/${antiga.id}/test`).set(gerente).send({});
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_PRINTER_TEST_ONLY_RECEIPT');
  });
});

// ---------------------------------------------------------- nome e número

describe('C-etiquetas-12 / C-etiquetas-13 — o texto não sai cortado ao meio, e o número sai sem o desenho', () => {
  it('a 130 %, o nome ocupa um número INTEIRO de linhas e quebra palavra longa', () => {
    const html = folha(modelo({ paperWidthMm: 40, widthMm: 40, heightMm: 30, scalePercent: 130, fields: ['nome', 'preco', 'barras'] }), [
      produto('KIT-HIDRATANTE-CORPORAL-500ML-COM-OLEO-DE-ARGAN', { barcode: '7891234567895' }),
    ]);
    const regra = html.match(/\.nome \{([^}]*)\}/)![1];
    const linhas = Number(regra.match(/-webkit-line-clamp: (\d+);/)![1]);
    const alturaMax = Number(regra.match(/max-height: ([\d.]+)px/)![1]);
    const linha = Math.min(13, 30 * 0.28) * 1.3 * 1.12;
    expect(Math.abs(alturaMax - linhas * linha)).toBeLessThan(0.02);
    expect(linhas * linha).toBeLessThanOrEqual(30 * 0.26 * PX_POR_MM + 0.01);
    expect((linhas + 1) * linha).toBeGreaterThan(30 * 0.26 * PX_POR_MM);
    expect(regra).toContain('overflow-wrap: anywhere');
    expect(regra).toContain('flex-shrink: 0');
  });

  it('com todos os campos numa etiqueta de 20 mm, o editor avisa que não cabe', () => {
    const f = modelo({
      paperWidthMm: 30, widthMm: 30, heightMm: 20, complementText: 'Troca em 30 dias',
      fields: ['nome', 'descricao', 'marca', 'atributos', 'complemento', 'preco', 'barras', 'ean', 'codigo'],
    });
    expect(avisosDoFormato(f).join(' ')).toMatch(/pedem cerca de .* mm de altura e a etiqueta tem 20 mm/);
  });

  it('"Número do código de barras" marcado SEM o desenho imprime o número', () => {
    const html = folha(modelo({ paperWidthMm: 50, widthMm: 50, heightMm: 30, fields: ['nome', 'ean'] }), [
      produto('Cartaz', { barcode: '7891234567895' }),
    ]);
    expect(html).toContain('<div class="ean">7891234567895</div>');
    expect(html).not.toContain('class="barras"');
  });
});

// --------------------------------------------- quem pode gravar código no cadastro

describe('C-etiquetas-14 / C-etiquetas-15 — a folha só grava código quando deve', () => {
  it('o caixa imprime a folha, mas o produto sem código sai SEM barras e continua sem código no cadastro', async () => {
    const caixa = await entrarComoCaixa();
    const p = produto('Sabão do caixa');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(caixa).send({ formatId: 'rolo_50x30', items: [{ productId: p, quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.semCodigo).toEqual(['Sabão do caixa']);
    expect(r.body.codigosGerados).toEqual([]);
    expect(r.body.html).toContain('gere no cadastro do produto');
    expect(codigoNoBanco(p)).toBeNull();

    const dados = await request(app).post('/api/v1/core/labels/products').set(caixa).send({ items: [{ productId: p }] });
    expect(dados.status).toBe(200);
    expect(dados.body.items[0].barcode).toBe('');
    expect(codigoNoBanco(p)).toBeNull();
  });

  it('o gerente, na mesma folha, grava o código — e a resposta diz qual', async () => {
    const p = produto('Sabão do gerente');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: p, quantity: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.codigosGerados).toEqual([{ productId: p, name: 'Sabão do gerente', barcode: codigoNoBanco(p) }]);
    expect(codigoNoBanco(p)).toMatch(/^2\d{12}$/);
  });

  it('o cartaz de gôndola (sem código de barras) não grava EAN em ninguém', async () => {
    const p = produto('Cartaz de gôndola');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'a4_gondola_2x5', items: [{ productId: p, quantity: 1 }] });
    expect(r.status).toBe(200);
    expect(codigoNoBanco(p)).toBeNull();
  });
});

// --------------------------------------------------------- margem do rolo

describe('C-etiquetas-19 — no rolo, a margem de cima não empurra o conteúdo para fora', () => {
  it('rolo de 20 mm com margem 25 (ou 16): recusado; com 15, passa', () => {
    expect(() => validarModelo({ name: 'Rolo', widthMm: 40, heightMm: 20, marginTopMm: 25, fields: ['nome'] }, EMPRESA)).toThrow(/em branco/);
    expect(() => validarModelo({ name: 'Rolo', widthMm: 40, heightMm: 20, marginTopMm: 16, fields: ['nome'] }, EMPRESA)).toThrow(/Margem superior/);
    expect(validarModelo({ name: 'Rolo', widthMm: 40, heightMm: 20, marginTopMm: 15, fields: ['nome'] }, EMPRESA).marginTopMm).toBe(15);
  });
});

// ------------------------------------------------------ preço na fila

describe('C-etiquetas-20 — a fila mostra o preço que a etiqueta vai imprimir', () => {
  it('produto em promoção: preço vigente, de tabela e o sinal de promoção', () => {
    const p = produto('Camisa em promoção', { priceCents: 5990 });
    promocao(p, 4990);
    const c = listLabelCandidates(EMPRESA, { source: 'catalogo', search: 'Camisa em promoção' }).candidates[0];
    expect(c).toMatchObject({ priceCents: 4990, listPriceCents: 5990, onSale: true });
  });
});

// -------------------------------------------------------------- M02, M03, M04

describe('C-etiquetas-M02 — o modelo da grade não vai para a fila nem ganha EAN', () => {
  it('estoque, catálogo e códigos colados mandam o modelo para os problemas; a folha o recusa', async () => {
    const pai = produto('Bermuda Grade');
    const { created } = generateVariants({ companyId: EMPRESA, productId: pai, axes: { tamanho: ['38', '40'] } });
    const variantes = created.map((v) => String(v.id));
    const internoDoPai = (getConnection().prepare('SELECT internal_code FROM core_products WHERE id = ?').get(pai) as { internal_code: string }).internal_code;

    for (const r of [
      listLabelCandidates(EMPRESA, { source: 'estoque' }),
      listLabelCandidates(EMPRESA, { source: 'catalogo', search: 'Bermuda Grade' }),
      listLabelCandidates(EMPRESA, { source: 'codigos', codes: internoDoPai }),
    ]) {
      expect(r.candidates.map((c) => c.productId)).not.toContain(pai);
      expect(r.problemas.some((p) => /modelo de uma grade/.test(p.motivo))).toBe(true);
    }
    expect(listLabelCandidates(EMPRESA, { source: 'estoque' }).candidates.map((c) => c.productId)).toEqual(expect.arrayContaining(variantes));

    const folhaDoPai = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: pai, quantity: 1 }] });
    expect(folhaDoPai.status).toBe(400);
    expect(folhaDoPai.body.error?.code).toBe('CORE_LABEL_GRID_MODEL');
    expect(codigoNoBanco(pai)).toBeNull();
  });
});

describe('C-etiquetas-M03 — a folha começa na posição pedida', () => {
  it('começar na 5ª posição da A4 de 33: quatro células vazias antes da primeira etiqueta, e a conta de folhas acompanha', () => {
    const f = findLabelFormat(FORMATO_PADRAO)!;
    const html = folha(f, [produto('Reetiquetar', { barcode: '7891234567895' })], { comecarEm: 5 });
    const primeiraFolha = html.split('<section class="folha">')[1];
    const antes = primeiraFolha.slice(0, primeiraFolha.indexOf('class="etq"'));
    expect(antes.split('class="etq-vazia"').length - 1).toBe(4);
    const items = buildLabels(EMPRESA, [{ productId: produto('Trinta', { barcode: eanInterno(700) }), quantity: 30 }], { campos: f.campos });
    expect(resumoDaFolha(f, items, 5)).toEqual({ etiquetas: 30, folhas: 2 });
  });

  it('posição fora da folha: 400', async () => {
    const p = produto('Fora', { barcode: '7891234567895' });
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: FORMATO_PADRAO, startAt: 34, items: [{ productId: p, quantity: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABEL_START_INVALID');
  });
});

describe('C-etiquetas-M04 — o lote é conferido inteiro antes de gravar, e a trilha diz o que nasceu', () => {
  it('dois válidos sem código e um inexistente: 404, e os dois continuam sem código', async () => {
    const a = produto('Válido A');
    const b = produto('Válido B');
    const r = await request(app)
      .post('/api/v1/core/labels/sheet')
      .set(gerente)
      .send({ formatId: 'rolo_50x30', items: [{ productId: a }, { productId: b }, { productId: 'nao-existe' }] });
    expect(r.status).toBe(404);
    expect(codigoNoBanco(a)).toBeNull();
    expect(codigoNoBanco(b)).toBeNull();
  });

  it('o DESENHO recusa a folha (preço que não cabe) depois de montar: o código que o lote gravaria é desfeito, e não há trilha órfã', async () => {
    // Revisão: `buildLabels` fechava a própria transação, e a recusa do
    // desenho vinha depois — o EAN ficava gravado sem folha e sem auditoria.
    const m = criarModelo(EMPRESA, null, {
      name: 'Estreita', midia: 'rolo', paperWidthMm: 15, widthMm: 12, heightMm: 30, fields: ['nome', 'preco', 'ean'],
    });
    const p = produto('Geladeira sem código', { priceCents: 9_999_999 });
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ templateId: m.id, items: [{ productId: p }] });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABEL_PRICE_DOES_NOT_FIT');
    expect(codigoNoBanco(p)).toBeNull();
    const trilhas = getConnection()
      .prepare("SELECT count(*) AS n FROM core_audit_log WHERE company_id = ? AND action = 'label.sheet'")
      .get(EMPRESA) as { n: number };
    expect(trilhas.n).toBe(0);
  });

  it('a auditoria do lote lista quais produtos ganharam qual código', async () => {
    const a = produto('Auditado');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: a }] });
    expect(r.status).toBe(200);
    const linha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE company_id = ? AND action = 'label.sheet' ORDER BY created_at DESC LIMIT 1")
      .get(EMPRESA) as { detail: string };
    expect(JSON.parse(linha.detail).codigosGerados).toEqual([{ productId: a, barcode: codigoNoBanco(a) }]);
  });
});

// --------------------------------------------- nota de entrada e pedido de compra

function nota(id: string, status: string, extra: { pedido?: string; recebidaEm?: string } = {}) {
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_notes (id, company_id, access_key, number, status, received_at, purchase_order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, EMPRESA, `chave-${id}`, id.toUpperCase(), status, extra.recebidaEm ?? new Date().toISOString(), extra.pedido ?? null, new Date().toISOString());
}

function entrou(noteId: string, productId: string, quantidade: number) {
  applyMovement({ companyId: EMPRESA, productId, movementType: 'in', quantity: quantidade, referenceType: 'nfe_entrada', referenceId: noteId });
}

describe('B-estoque-entrada-07 — as etiquetas do que entrou numa nota', () => {
  it('nota confirmada com 2 produtos (5 un; 3 un que vieram de 1 CX de 3): 5 e 3', () => {
    const sabao = produto('Sabão');
    const detergente = produto('Detergente');
    nota('nf1', 'recebida');
    // A confirmação agrupa as linhas do mesmo produto e grava UM movimento por
    // produto, já na unidade do cadastro (a CX de 3 entra como 3).
    entrou('nf1', sabao, 5);
    entrou('nf1', detergente, 3);
    const r = listLabelCandidates(EMPRESA, { source: 'nota', noteId: 'nf1' });
    expect(Object.fromEntries(r.candidates.map((c) => [c.productId, c.documentQuantity]))).toEqual({ [sabao]: 5, [detergente]: 3 });
  });

  it('nota em conferência ou estornada é recusada dizendo por quê', () => {
    nota('nf2', 'conferencia');
    nota('nf3', 'estornada');
    expect(() => listLabelCandidates(EMPRESA, { source: 'nota', noteId: 'nf2' })).toThrow(/em conferência/);
    expect(() => listLabelCandidates(EMPRESA, { source: 'nota', noteId: 'nf3' })).toThrow(/estornada/);
  });

  it('pela rota: GET /labels/candidates?source=nota&noteId=…', async () => {
    const p = produto('Arroz');
    nota('nf4', 'recebida');
    entrou('nf4', p, 12);
    const r = await request(app).get('/api/v1/core/labels/candidates?source=nota&noteId=nf4').set(gerente);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.candidates).toEqual([expect.objectContaining({ productId: p, documentQuantity: 12 })]);
  });
});

describe('B-estoque-entrada-20 / C-etiquetas-M06 — o pedido sugere o que chegou na última entrega', () => {
  it('pedido de 100 entregue em 40 e 60: a sugestão é 60, e não os 100 acumulados', () => {
    const p = produto('Parafuso');
    const usuario = (getConnection().prepare("SELECT id FROM core_users WHERE lower(login) = lower('gerente@loja-etq')").get() as { id: string }).id;
    const fornecedor = String(createSupplier(EMPRESA, { name: 'Distribuidora' }).id);
    const pedido = String(
      createPurchaseOrder({
        companyId: EMPRESA,
        userId: usuario,
        supplierId: fornecedor,
        items: [{ productId: p, description: 'Parafuso', quantity: 100, unitCostCents: 10 }],
      }).id,
    );
    getConnection().prepare('UPDATE core_purchase_order_items SET received_quantity = 100 WHERE order_id = ?').run(pedido);
    nota('ent1', 'recebida', { pedido, recebidaEm: '2026-09-01T10:00:00.000Z' });
    entrou('ent1', p, 40);
    nota('ent2', 'recebida', { pedido, recebidaEm: '2026-09-10T10:00:00.000Z' });
    entrou('ent2', p, 60);
    const r = listLabelCandidates(EMPRESA, { source: 'compra', purchaseOrderId: pedido });
    expect(r.candidates[0].documentQuantity).toBe(60);
  });

  /*
    B-estoque-entrada-20#reauditoria / C-etiquetas-R02: a última entrega é do
    PEDIDO, não de cada produto. Sem o conserto, a porca (que só veio na nota 1,
    já etiquetada) entrava na fila com 10 — a mercadoria da entrega anterior
    reimpressa.
  */
  it('parafuso e porca; nota 1 traz os dois, nota 2 só o parafuso: sai parafuso 60, e a porca vai para os problemas', () => {
    const parafuso = produto('Parafuso');
    const porca = produto('Porca');
    const usuario = (getConnection().prepare("SELECT id FROM core_users WHERE lower(login) = lower('gerente@loja-etq')").get() as { id: string }).id;
    const fornecedor = String(createSupplier(EMPRESA, { name: 'Distribuidora' }).id);
    const pedido = String(
      createPurchaseOrder({
        companyId: EMPRESA,
        userId: usuario,
        supplierId: fornecedor,
        items: [
          { productId: parafuso, description: 'Parafuso', quantity: 100, unitCostCents: 10 },
          { productId: porca, description: 'Porca', quantity: 10, unitCostCents: 5 },
        ],
      }).id,
    );
    getConnection().prepare('UPDATE core_purchase_order_items SET received_quantity = 100 WHERE order_id = ? AND product_id = ?').run(pedido, parafuso);
    getConnection().prepare('UPDATE core_purchase_order_items SET received_quantity = 10 WHERE order_id = ? AND product_id = ?').run(pedido, porca);
    nota('ent-a', 'recebida', { pedido, recebidaEm: '2026-09-01T10:00:00.000Z' });
    entrou('ent-a', parafuso, 40);
    entrou('ent-a', porca, 10);
    nota('ent-b', 'recebida', { pedido, recebidaEm: '2026-09-10T10:00:00.000Z' });
    entrou('ent-b', parafuso, 60);

    const r = listLabelCandidates(EMPRESA, { source: 'compra', purchaseOrderId: pedido });
    expect(r.candidates.map((c) => [c.productId, c.documentQuantity])).toEqual([[parafuso, 60]]);
    expect(r.problemas).toEqual([
      { descricao: 'Porca', motivo: expect.stringMatching(/Não veio na última entrega do pedido \(nota ENT-B\).*Nota de entrada/) },
    ]);
  });
});
