/**
 * ============================================================================
 * A CALIBRAÇÃO E OS AJUSTES DA TÉRMICA CHEGAM AO PAPEL (P00 das etiquetas)
 * ============================================================================
 *
 * O DEFEITO: o modelo GRAVA nove colunas — deslocamento X/Y, densidade,
 * velocidade, corte, sensor da mídia, vão do rolo e avanço final —, a tela as
 * edita no painel "Saída, calibração e mídia" e a migração as acrescentou. Mas
 * `formatoDoModelo`, que é o ÚNICO caminho de um modelo até o desenho
 * (`formatoDoPedido` → `formatoDoModelo` → folha, prévia, teste e comandos),
 * NÃO as copiava para o `LabelFormat`. Quem as lê do outro lado já existia:
 * `paginarEtiquetas` usa os deslocamentos, `renderLabelSheet` os aplica no CSS
 * da folha, e `gerarZpl`/`gerarEpl`/`gerarTspl` põem densidade, velocidade,
 * corte, sensor e vão dentro do arquivo. Elas chegavam sempre `undefined`.
 *
 * Na loja: a térmica que puxa o rolo 1 mm torto imprimia tudo 1 mm torto para
 * sempre — a etiqueta de teste manda "ajuste o deslocamento do modelo e imprima
 * de novo", a pessoa ajustava, salvava, e o adesivo saía idêntico. O corte
 * configurado nunca cortava, a densidade nunca escurecia, e o rolo de marca
 * preta saía desalinhado numa impressora que a tela dizia estar configurada.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido): tire qualquer
 * uma das nove linhas de `formatoDoModelo` e o caso correspondente fica
 * vermelho; tire todas e o arquivo inteiro fica.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { criarModelo } from '../src/services/core/LabelTemplateService.js';

const app = createApp();
const EMPRESA = 'loja-calibracao';
let gerente: { Authorization: string };
let produto: string;

const BASE = {
  midia: 'rolo' as const,
  paperWidthMm: 50,
  widthMm: 50,
  heightMm: 30,
  dpi: 203,
  fields: ['nome', 'preco', 'barras'],
};

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, { userId: 'gerente-calib', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  produto = String(createProduct(EMPRESA, { name: 'Arroz 5kg', priceCents: 2990, barcode: '7891234567895' }).id);
});

/**
 * A folha daquele modelo na saída pedida — a saída vai explícita, como a tela
 * a manda (ela adota a saída padrão do modelo em `perfilId`).
 */
async function folha(templateId: string, perfil?: string) {
  const r = await request(app)
    .post('/api/v1/core/labels/sheet')
    .set(gerente)
    .send({ templateId, ...(perfil ? { perfil } : {}), items: [{ productId: produto, quantity: 1 }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { html: string; comandos: string | null; avisos: string[] };
}

describe('o deslocamento de calibração sai no papel', () => {
  it('ZPL: com X de 2 mm a 203 dpi, cada campo anda 16 pontos para a direita no rolo que tem folga', async () => {
    // O rolo de 60 mm com etiqueta de 50 tem 10 mm de folga: é onde a
    // calibração horizontal cabe.
    const FOLGA = { ...BASE, paperWidthMm: 60 };
    const reto = criarModelo(EMPRESA, null, { name: 'Reto', ...FOLGA, outputProfile: 'zpl' });
    const torto = criarModelo(EMPRESA, null, { name: 'Torto', ...FOLGA, outputProfile: 'zpl', offsetXmm: 2 });

    const xDe = (comandos: string) => [...comandos.matchAll(/\^FO(\d+),(\d+)/g)].map((m) => Number(m[1]));
    const a = xDe((await folha(reto.id, 'zpl')).comandos ?? '');
    const b = xDe((await folha(torto.id, 'zpl')).comandos ?? '');
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a.map((x) => x + Math.round((2 * 203) / 25.4)));
  });

  it('o deslocamento que não cabe no papel encosta na borda E AVISA — nunca em silêncio', async () => {
    // No rolo em que a etiqueta é a própria página (50 × 30 de 50 × 30), não há
    // para onde descer: o papel diz isso em vez de fingir que calibrou.
    const torto = criarModelo(EMPRESA, null, { name: 'Sem folga', ...BASE, outputProfile: 'zpl', offsetYmm: 2 });
    const r = await folha(torto.id, 'zpl');
    expect(r.avisos.some((a) => /levaria parte da etiqueta para fora do papel/.test(a))).toBe(true);
  });

  it('a folha do navegador aplica o mesmo deslocamento no CSS, em milímetro', async () => {
    const torto = criarModelo(EMPRESA, null, { name: 'Torto navegador', ...BASE, offsetXmm: 1.5, offsetYmm: -0.5 });
    expect((await folha(torto.id)).html).toContain('transform: translate(1.5mm, -0.5mm)');
  });
});

describe('os ajustes da térmica vão DENTRO do arquivo', () => {
  it('ZPL: densidade, velocidade, corte a cada etiqueta e sensor de marca preta', async () => {
    const m = criarModelo(EMPRESA, null, {
      name: 'ZPL ajustado',
      ...BASE,
      outputProfile: 'zpl',
      darkness: 22,
      printSpeed: 4,
      cutMode: 'cada_etiqueta',
      mediaType: 'marca',
    });
    const comandos = (await folha(m.id, m.outputProfile ?? undefined)).comandos ?? '';
    expect(comandos).toContain('~SD22');
    expect(comandos).toContain('^PR4');
    expect(comandos).toContain('^MMC');
    expect(comandos).toContain('^MNM');
  });

  it('TSPL: densidade (metade da escala), velocidade, cortador, marca preta com o vão medido e o avanço final', async () => {
    const m = criarModelo(EMPRESA, null, {
      name: 'TSPL ajustado',
      ...BASE,
      outputProfile: 'tspl',
      darkness: 20,
      printSpeed: 3,
      cutMode: 'cada_etiqueta',
      mediaType: 'marca',
      mediaGapMm: 3,
      feedAfterMm: 5,
    });
    const comandos = (await folha(m.id, m.outputProfile ?? undefined)).comandos ?? '';
    expect(comandos).toContain('BLINE 3 mm,0 mm');
    expect(comandos).toContain('SET CUTTER 1');
    expect(comandos).toContain('DENSITY 10');
    expect(comandos).toContain('SPEED 3');
    expect(comandos).toContain(`FEED ${Math.round((5 * 203) / 25.4)}`);
  });

  it('o vão do rolo NÃO informado avisa e assume 2 mm; informado, some o aviso e sai a medida', async () => {
    const sem = criarModelo(EMPRESA, null, { name: 'Sem vão', ...BASE, outputProfile: 'tspl' });
    const semVao = await folha(sem.id, 'tspl');
    expect(semVao.comandos).toContain('GAP 2 mm,0 mm');
    expect(semVao.avisos.some((a) => /vão entre as etiquetas do rolo não foi informado/.test(a))).toBe(true);

    const com = criarModelo(EMPRESA, null, { name: 'Com vão', ...BASE, outputProfile: 'tspl', mediaGapMm: 2.5 });
    const comVao = await folha(com.id, 'tspl');
    expect(comVao.comandos).toContain('GAP 2.5 mm,0 mm');
    expect(comVao.avisos.some((a) => /vão entre as etiquetas do rolo não foi informado/.test(a))).toBe(false);
  });

  it('o modelo sem ajuste nenhum não inventa comando: sem ~SD, sem ^PR, e destacar em vez de cortar', async () => {
    const m = criarModelo(EMPRESA, null, { name: 'Cru', ...BASE, outputProfile: 'zpl' });
    const comandos = (await folha(m.id, m.outputProfile ?? undefined)).comandos ?? '';
    expect(comandos).not.toContain('~SD');
    expect(comandos).not.toContain('^PR');
    expect(comandos).toContain('^MMT');
    expect(comandos).toContain('^MNY');
  });
});
