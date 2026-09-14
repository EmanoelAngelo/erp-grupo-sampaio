/**
 * ============================================================================
 * ETIQUETAS — os complementos da auditoria (trilha 4a)
 * ============================================================================
 *
 *   - C-etiquetas-05: o módulo do código de barras era arredondado para pontos
 *     de 203 dpi em todo rolo (e 300 em toda folha), mesmo com o modelo dizendo
 *     outra impressora — a coluna `dpi` existia e ninguém a lia nem gravava;
 *   - A-produto-M02: UPC-A de 12 dígitos, EAN-8 e código próprio (Code 128)
 *     saem com barras, e a resposta da folha lista o que NÃO virou barra.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { buildLabels } from '../src/services/core/BarcodeService.js';
import { renderLabelSheet } from '../src/services/core/LabelSheet.js';
import { findLabelFormat, type LabelFormat } from '../src/services/core/LabelFormats.js';
import { formatoDoModelo, validarModelo } from '../src/services/core/LabelTemplateService.js';
import { code128Bits, desenhoDoCodigo, ean13Bits } from '../src/services/core/Ean13.js';
import { createProduct } from '../src/services/core/CatalogService.js';

const app = createApp();
const EMPRESA = 'loja-etq-4a';
let gerente: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, { userId: 'gerente', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
});

function produto(nome: string, extra: Record<string, unknown> = {}): string {
  return String(createProduct(EMPRESA, { name: nome, priceCents: 1990, ...extra }).id);
}

function modelo(entrada: Record<string, unknown>): LabelFormat {
  return formatoDoModelo(validarModelo({ name: 'Modelo de teste', midia: 'rolo', ...entrada }, EMPRESA));
}

function folha(f: LabelFormat, ids: string[]): string {
  const items = buildLabels(EMPRESA, ids.map((productId) => ({ productId })), { campos: f.campos });
  return renderLabelSheet({ format: f, items, companyId: EMPRESA });
}

/** A largura (mm) com que o SVG das barras vai para o papel. */
const larguraDasBarras = (html: string) => Number(html.match(/style="width:([\d.]+)mm;height:100%"/)![1]);
/** Quantos pontos da impressora cada módulo do EAN-13 (113 módulos com o silêncio) ocupa. */
const pontosPorModulo = (larguraMm: number, dpi: number) => larguraMm / 113 / (25.4 / dpi);
const ehInteiro = (x: number) => Math.abs(x - Math.round(x)) < 0.01;

const ROLO_40 = { paperWidthMm: 40, widthMm: 40, heightMm: 30, fields: ['nome', 'barras'] };

// ------------------------------------------------------------ o dpi do modelo

describe('C-etiquetas-05 — o módulo das barras cai no ponto da impressora DO MODELO', () => {
  it('rolo 40 × 30 a 300 dpi: cada módulo é um número INTEIRO de pontos de 300 dpi (antes: 4,06 pontos, a conta de 203)', () => {
    const arroz = produto('Arroz', { barcode: '7891234567895' });
    const f300 = modelo({ ...ROLO_40, dpi: 300 });
    expect(f300.dpi).toBe(300);
    const largura = larguraDasBarras(folha(f300, [arroz]));
    expect(ehInteiro(pontosPorModulo(largura, 300))).toBe(true);
    expect(Math.round(pontosPorModulo(largura, 300))).toBe(4);
    expect(largura / 113).toBeGreaterThanOrEqual(0.264);
    expect(largura).toBeLessThanOrEqual(40 - 1.2);

    // O MESMO modelo a 203 dpi sai com outra largura: quem decide é o dpi.
    const largura203 = larguraDasBarras(folha(modelo({ ...ROLO_40, dpi: 203 }), [arroz]));
    expect(Math.abs(largura203 - largura)).toBeGreaterThan(0.1);
    expect(ehInteiro(pontosPorModulo(largura203, 300))).toBe(false);
  });

  it('rolo 50 × 30 a 600 dpi: o módulo é múltiplo de 25,4/600 mm', () => {
    const f = modelo({ paperWidthMm: 50, widthMm: 50, heightMm: 30, fields: ['nome', 'barras'], dpi: 600 });
    const largura = larguraDasBarras(folha(f, [produto('Feijão', { barcode: '7891234567895' })]));
    expect(ehInteiro(pontosPorModulo(largura, 600))).toBe(true);
    expect(largura).toBeLessThanOrEqual(50 - 1.2);
  });

  it('dpi fora de 203/300/600 é recusado dizendo o campo e os valores aceitos', () => {
    for (const errado of [250, '96', 'abc']) {
      expect(() => validarModelo({ name: 'Rolo', ...ROLO_40, dpi: errado }, EMPRESA)).toThrow(
        /Resolução da impressora \(dpi\).*203, 300 ou 600/,
      );
    }
  });

  it('sem dpi: rolo nasce com 203 e folha com 300 — o palpite de antes, agora gravado', () => {
    expect(validarModelo({ name: 'Rolo', ...ROLO_40 }, EMPRESA).dpi).toBe(203);
    expect(validarModelo({ name: 'Folha', midia: 'folha', widthMm: 60, heightMm: 30, fields: ['nome'] }, EMPRESA).dpi).toBe(300);
    // Número em texto (vindo de <select>) vale.
    expect(validarModelo({ name: 'Rolo', ...ROLO_40, dpi: '600' }, EMPRESA).dpi).toBe(600);
  });

  it('pela rota: grava, lista, mantém quando a tela não manda, muda quando manda — e recusa com 400', async () => {
    const base = { name: 'Rolo 300 dpi', midia: 'rolo', ...ROLO_40 };
    const criado = await request(app).post('/api/v1/core/labels/templates').set(gerente).send({ ...base, dpi: 300 });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.dpi).toBe(300);
    const id = String(criado.body.id);
    const noBanco = () => (getConnection().prepare('SELECT dpi FROM core_label_templates WHERE id = ?').get(id) as { dpi: number }).dpi;
    expect(noBanco()).toBe(300);

    const lista = await request(app).get('/api/v1/core/labels/templates').set(gerente);
    expect(lista.body.items.find((m: { id: string }) => m.id === id)?.dpi).toBe(300);

    // Tela antiga aberta, sem o campo: o dpi gravado fica (não volta a 203).
    const semDpi = await request(app).patch(`/api/v1/core/labels/templates/${id}`).set(gerente).send(base);
    expect(semDpi.status, JSON.stringify(semDpi.body)).toBe(200);
    expect(semDpi.body.dpi).toBe(300);

    const para600 = await request(app).patch(`/api/v1/core/labels/templates/${id}`).set(gerente).send({ ...base, dpi: 600 });
    expect(para600.body.dpi).toBe(600);
    expect(noBanco()).toBe(600);

    const errado = await request(app).patch(`/api/v1/core/labels/templates/${id}`).set(gerente).send({ ...base, dpi: 250 });
    expect(errado.status).toBe(400);
    expect(errado.body.error?.code).toBe('CORE_LABEL_TEMPLATE_INVALID');
    expect(errado.body.error?.message).toMatch(/203, 300 ou 600/);
    expect(noBanco()).toBe(600);
  });

  it('a folha e a prévia pela rota usam o dpi do modelo', async () => {
    const p = produto('Macarrão', { barcode: '7891234567895' });
    const criado = await request(app)
      .post('/api/v1/core/labels/templates')
      .set(gerente)
      .send({ name: 'Rolo 300', midia: 'rolo', ...ROLO_40, dpi: 300 });
    const sheet = await request(app)
      .post('/api/v1/core/labels/sheet')
      .set(gerente)
      .send({ templateId: criado.body.id, items: [{ productId: p, quantity: 1 }] });
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(ehInteiro(pontosPorModulo(larguraDasBarras(sheet.body.html), 300))).toBe(true);

    const previa = await request(app)
      .post('/api/v1/core/labels/templates/preview')
      .set(gerente)
      .send({ template: { name: 'Rascunho', midia: 'rolo', ...ROLO_40, dpi: 300 }, productId: p, quantity: 1 });
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);
    expect(ehInteiro(pontosPorModulo(larguraDasBarras(previa.body.html), 300))).toBe(true);
  });
});

// ------------------------------------------ UPC-A, EAN-8 e código próprio

describe('A-produto-M02 — UPC-A de 12 dígitos, EAN-8 e código próprio saem com barras', () => {
  it.each([
    // [código, simbologia, módulos com as zonas de silêncio]
    ['012345678905', 'UPC-A', 9 + 95 + 9],
    ['96385074', 'EAN-8', 7 + 67 + 7],
    ['PJ-ABC-001', 'Code128', 10 + code128Bits('PJ-ABC-001')!.length + 10],
  ])('%s vira <svg> de %s — nunca "SEM CÓDIGO"', (codigo, simbologia, modulos) => {
    const html = folha(findLabelFormat('rolo_50x30')!, [produto(`Item ${codigo}`, { barcode: codigo })]);
    expect(html).toContain('<svg');
    expect(html).toContain(`data-simbologia="${simbologia}"`);
    expect(html).toContain(`viewBox="0 0 ${modulos} 28"`);
    expect(html).not.toContain('SEM CÓDIGO');
    expect(html).not.toContain('CÓDIGO INVÁLIDO');
  });

  it('o UPC-A é desenhado como o EAN-13 com o zero na frente (o que o leitor devolve é o mesmo GTIN)', () => {
    const d = desenhoDoCodigo('012345678905');
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.bits).toBe(ean13Bits('0012345678905'));
  });

  it('pela rota: os três saem com barras, e só o código torto aparece em codigosSemDesenho', async () => {
    const upc = produto('Cereal importado', { barcode: '012345678905' });
    const ean8 = produto('Batom', { barcode: '96385074' });
    const proprio = produto('Parafuso da casa', { barcode: 'PJ-ABC-001' });
    const torto = produto('Legado torto');
    // Dado legado: o cadastro de hoje já recusaria este verificador.
    getConnection().prepare("UPDATE core_products SET barcode = '7891234567890' WHERE id = ?").run(torto);

    const r = await request(app)
      .post('/api/v1/core/labels/sheet')
      .set(gerente)
      .send({ formatId: 'rolo_50x30', items: [upc, ean8, proprio, torto].map((productId) => ({ productId, quantity: 1 })) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((String(r.body.html).match(/<svg/g) ?? []).length).toBe(3);
    expect(r.body.html).not.toContain('SEM CÓDIGO');
    expect(r.body.codigosSemDesenho).toHaveLength(1);
    expect(r.body.codigosSemDesenho[0].name).toBe('Legado torto');
    expect(r.body.codigosSemDesenho[0].motivo).toMatch(/verificador errado/);
    expect(r.body.semCodigo).toEqual([]);
  });
});
