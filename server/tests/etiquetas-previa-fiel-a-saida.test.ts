/**
 * ============================================================================
 * A PRÉVIA DO MODELO É O QUE A SAÍDA DELE IMPRIME (P00 das etiquetas)
 * ============================================================================
 *
 * O DEFEITO: `POST /labels/templates/preview` chamava sempre `renderLabelSheet`
 * — o desenho em HTML/CSS do navegador —, mesmo no modelo cuja saída padrão é
 * ZPL, EPL, TSPL, PDF ou o driver. São dois desenhistas diferentes: o do
 * navegador deixa o CSS cortar o que não cabe; o dos outros (`LabelLayout`, em
 * pontos da impressora) tira campo por campo até caber, avisa quais tirou, e
 * ainda diz o que a linguagem da térmica não sabe fazer (a EPL não corta só no
 * fim do lote). O gestor montava o modelo olhando um adesivo que não era o que
 * a térmica dele ia imprimir, e descobria a diferença com o rolo gasto.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido): volte a prévia
 * para `renderLabelSheet(...)` + `resumoDaFolha(...)` e os três primeiros casos
 * ficam vermelhos (a prévia volta a sair em `@page`/CSS, sem `perfil` e sem os
 * avisos do desenho e da linguagem).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { criarModelo } from '../src/services/core/LabelTemplateService.js';

const app = createApp();
const EMPRESA = 'loja-previa-fiel';
let gerente: { Authorization: string };
let produto: string;

const BASE = {
  midia: 'rolo' as const,
  paperWidthMm: 50,
  widthMm: 50,
  heightMm: 30,
  fields: ['nome', 'preco', 'barras', 'ean'],
};

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, { userId: 'gerente-previa', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  produto = String(createProduct(EMPRESA, { name: 'Arroz 5kg', priceCents: 2990, barcode: '7891234567895' }).id);
});

function previa(body: Record<string, unknown>) {
  return request(app).post('/api/v1/core/labels/templates/preview').set(gerente).send(body);
}

describe('a prévia usa a saída padrão do modelo', () => {
  it('modelo de ZPL: a prévia é o desenho em pontos (SVG), e diz qual saída a desenhou', async () => {
    const m = criarModelo(EMPRESA, null, { name: 'Rolo ZPL', ...BASE, outputProfile: 'zpl' });
    const r = await previa({ templateId: m.id, productId: produto });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.perfil).toBe('zpl');
    expect(r.body.html).toContain('<svg');
    // O desenho em pontos monta a página como SVG; o do navegador, como folha CSS.
    expect(r.body.html).toContain('class="pagina"');
    expect(r.body.etiquetas).toBe(m.columns * 2);
  });

  it('modelo sem saída padrão: continua a folha do navegador, como sempre foi', async () => {
    const m = criarModelo(EMPRESA, null, { name: 'Rolo simples', ...BASE });
    const r = await previa({ templateId: m.id, productId: produto });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.perfil).toBe('navegador');
    expect(r.body.html).toContain('@page { size: 50mm 30mm');
    expect(r.body.html).toContain('Arroz 5kg');
  });

  it('o que a linguagem da térmica não faz aparece na prévia, e não só no arquivo', async () => {
    // A EPL não sabe cortar só no fim do lote — o arquivo avisava; a prévia, não.
    const m = criarModelo(EMPRESA, null, { name: 'Rolo EPL', ...BASE, outputProfile: 'epl', cutMode: 'fim_do_lote' });
    const r = await previa({ templateId: m.id, productId: produto });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.perfil).toBe('epl');
    expect(r.body.avisos.some((a: string) => /EPL: o corte só no fim do lote/.test(a))).toBe(true);
  });

  it('a prévia e a folha daquela saída desenham a MESMA coisa', async () => {
    const m = criarModelo(EMPRESA, null, { name: 'Rolo TSPL', ...BASE, outputProfile: 'tspl' });
    const p = await previa({ templateId: m.id, productId: produto, quantity: 1 });
    const folha = await request(app)
      .post('/api/v1/core/labels/sheet')
      .set(gerente)
      .send({ templateId: m.id, perfil: 'tspl', items: [{ productId: produto, quantity: 1 }] });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(p.body.html).toBe(folha.body.html);
  });

  it('a prévia continua só LENDO: nenhum código de barras é gravado no cadastro', async () => {
    const semCodigo = String(createProduct(EMPRESA, { name: 'Vassoura', priceCents: 1500 }).id);
    const m = criarModelo(EMPRESA, null, { name: 'Rolo ZPL 2', ...BASE, outputProfile: 'zpl' });
    const r = await previa({ templateId: m.id, productId: semCodigo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { getConnection } = await import('../src/db/sqlite.js');
    const linha = getConnection().prepare('SELECT barcode FROM core_products WHERE id = ?').get(semCodigo) as {
      barcode: string | null;
    };
    expect(linha.barcode).toBeNull();
  });
});
