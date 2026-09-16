/**
 * ============================================================================
 * A FOLHA DO NAVEGADOR DIZ O QUE PODE SAIR ERRADO NO PAPEL (P00 das etiquetas)
 * ============================================================================
 *
 * O DEFEITO: `emitirEtiquetas` devolvia `avisos: []` na saída HTML — que é a
 * saída PADRÃO, a que a loja usa todo dia. As barras abaixo do mínimo GS1 (o
 * leitor do caixa falha), o módulo que não fecha em ponto inteiro na impressora
 * do modelo (barras de 2 e de 3 pontos misturadas) e os campos que pedem mais
 * altura do que a etiqueta tem (o código sai cortado embaixo) só apareciam ao
 * trocar a saída para ZPL/EPL/TSPL/PDF, ou na prévia do editor de modelos. Quem
 * nunca abriu o editor gastava o rolo para descobrir na gôndola.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido): volte
 * `avisos: avisosDoFormato(f)` para `avisos: []` no ramo `perfil.saida ===
 * 'html'` de `emitirEtiquetas` e os três primeiros casos ficam vermelhos.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { criarModelo } from '../src/services/core/LabelTemplateService.js';

const app = createApp();
const EMPRESA = 'loja-etq-avisos';
let gerente: { Authorization: string };
let arroz: string;

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, { userId: 'gerente-avisos', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  arroz = String(createProduct(EMPRESA, { name: 'Arroz 5kg', priceCents: 2990, barcode: '7891234567895' }).id);
});

/** O modelo do editor, com o que o caso precisa mudar. */
function modelo(extra: Record<string, unknown>) {
  return criarModelo(EMPRESA, null, {
    name: 'Modelo do caso',
    midia: 'rolo',
    paperWidthMm: 40,
    widthMm: 40,
    heightMm: 30,
    fields: ['nome', 'barras'],
    ...extra,
  });
}

function folhaNoNavegador(body: Record<string, unknown>) {
  return request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ items: [{ productId: arroz, quantity: 1 }], ...body });
}

describe('a saída padrão (navegador) avisa o que as outras já avisavam', () => {
  it('rolo 40 × 30 a 203 dpi: a folha do navegador diz que as barras saem com 2 e 3 pontos', async () => {
    const m = modelo({ dpi: 203 });
    const r = await folhaNoNavegador({ templateId: m.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Sem `perfil`, a saída é o navegador: HTML, sem arquivo.
    expect(r.body.perfil).toBe('navegador');
    expect(r.body.arquivo).toBeNull();
    expect(r.body.avisos.some((a: string) => /pontos inteiros/.test(a))).toBe(true);
  });

  it('a etiqueta estreita demais: a folha do navegador diz que a barra fica abaixo do mínimo GS1', async () => {
    const m = modelo({ paperWidthMm: 25, widthMm: 25, heightMm: 30, dpi: 300 });
    const r = await folhaNoNavegador({ templateId: m.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.avisos.some((a: string) => /mínimo GS1/.test(a))).toBe(true);
  });

  it('campos demais para a altura: a folha do navegador diz que o de baixo pode sair cortado', async () => {
    const m = modelo({
      heightMm: 15,
      fields: ['nome', 'descricao', 'marca', 'atributos', 'preco', 'barras', 'ean', 'codigo', 'empresa'],
      dpi: 300,
    });
    const r = await folhaNoNavegador({ templateId: m.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.avisos.some((a: string) => /sair cortado/.test(a))).toBe(true);
  });

  it('o mesmo modelo, e a prévia do editor e a folha do navegador dizem a MESMA coisa', async () => {
    const m = modelo({ dpi: 203 });
    const previa = await request(app).post('/api/v1/core/labels/templates/preview').set(gerente).send({ templateId: m.id });
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);
    const folha = await folhaNoNavegador({ templateId: m.id });
    expect(folha.body.avisos).toEqual(previa.body.avisos);
  });

  it('o formato que fecha certo não inventa aviso nenhum', async () => {
    const m = modelo({ paperWidthMm: 50, widthMm: 50, heightMm: 30, dpi: 203 });
    const r = await folhaNoNavegador({ templateId: m.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.avisos).toEqual([]);
  });
});
