/**
 * ============================================================================
 * ETIQUETAS — o que a reauditoria achou (trilha 7)
 * ============================================================================
 *
 *   - C-etiquetas-05 (reauditoria): o rolo de 40 × 30 a 203 dpi — o "Novo
 *     modelo" do editor — imprime o módulo das barras com 2,74 pontos da
 *     térmica (barras de 2 e de 3 pontos misturadas), e nenhum aviso saía: só
 *     havia o do mínimo GS1. O mesmo no rolo_33x22 pronto (2,25 pontos).
 *   - C-etiquetas-R03: POST /labels/products gravava EAN interno em todo
 *     produto sem código (não olhava o formato) e não deixava trilha de quais
 *     códigos nasceram.
 *
 * Cada teste falha com o código de antes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { avisosDoFormato } from '../src/services/core/LabelSheet.js';
import { LABEL_FORMATS, findLabelFormat, type LabelFormat } from '../src/services/core/LabelFormats.js';
import { formatoDoModelo, validarModelo } from '../src/services/core/LabelTemplateService.js';

const app = createApp();
const EMPRESA = 'loja-etq-r7';
let gerente: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, { userId: 'gerente', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
});

/** Entra com o perfil; devolve o cabeçalho e o id de verdade (o login de teste cria o usuário com id próprio). */
async function entrarComo(userId: string, perfil: string) {
  const r = await loginForTest(app, { userId, companyId: EMPRESA, profileCodes: [perfil] });
  return { auth: { Authorization: `Bearer ${r.body.accessToken}` }, id: String(r.body.user.id) };
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

const ROLO_40 = { paperWidthMm: 40, widthMm: 40, heightMm: 30, fields: ['nome', 'barras'] };
/** Só o aviso do ponto quebrado (o da altura e o do GS1 são outros). */
const pontoQuebrado = (avisos: string[]) => avisos.filter((a) => /pontos inteiros/.test(a));

// ------------------------------------------------------------ o ponto quebrado

describe('C-etiquetas-05 (reauditoria) — o módulo que não fecha em pontos inteiros da impressora é avisado', () => {
  it('40 × 30 a 203 dpi (o "Novo modelo" do editor): diz os pontos, que saem 2 e 3, e o que resolve (300 dpi ou 43,7 mm)', () => {
    const avisos = pontoQuebrado(avisosDoFormato(modelo(ROLO_40)));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/Na impressora deste modelo \(203 dpi\)/);
    expect(avisos[0]).toMatch(/0,343 mm, que são 2,74 pontos/);
    expect(avisos[0]).toMatch(/umas barras saem com 2 pontos e outras com 3/);
    expect(avisos[0]).toMatch(/use uma impressora de 300 dpi ou uma etiqueta de ao menos 43,7 mm de largura\./);
  });

  it('a largura sugerida resolve de fato: 43,7 mm a 203 dpi não avisa, e 43,6 mm ainda avisa', () => {
    expect(pontoQuebrado(avisosDoFormato(modelo({ ...ROLO_40, paperWidthMm: 43.7, widthMm: 43.7 })))).toEqual([]);
    expect(pontoQuebrado(avisosDoFormato(modelo({ ...ROLO_40, paperWidthMm: 43.6, widthMm: 43.6 })))).toHaveLength(1);
  });

  it('o que fecha em pontos inteiros não avisa: 40 × 30 a 300 e a 600 dpi, 50 × 30 a 203 dpi', () => {
    expect(avisosDoFormato(modelo({ ...ROLO_40, dpi: 300 }))).toEqual([]);
    expect(avisosDoFormato(modelo({ ...ROLO_40, dpi: 600 }))).toEqual([]);
    expect(avisosDoFormato(modelo({ ...ROLO_40, paperWidthMm: 50, widthMm: 50 }))).toEqual([]);
  });

  it('em paisagem o lado das barras é a ALTURA, e o aviso diz isso', () => {
    const avisos = pontoQuebrado(
      avisosDoFormato(modelo({ paperWidthMm: 60, widthMm: 60, heightMm: 40, orientation: 'paisagem', fields: ['nome', 'barras'] })),
    );
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/43,7 mm de altura \(em paisagem as barras correm na altura\)/);
  });

  it('abaixo do mínimo GS1 fica só o aviso do GS1 (um aviso por barra, não dois); sem barras, nenhum', () => {
    const a30 = avisosDoFormato(modelo({ paperWidthMm: 30, widthMm: 30, heightMm: 20, fields: ['nome', 'barras'] }));
    expect(a30.join(' ')).toMatch(/mínimo GS1/);
    expect(pontoQuebrado(a30)).toEqual([]);
    expect(pontoQuebrado(avisosDoFormato(modelo({ ...ROLO_40, fields: ['nome', 'preco'] })))).toEqual([]);
  });

  it('pela rota: o salvar e a prévia devolvem o aviso ao gestor; trocar para 300 dpi o tira', async () => {
    const corpo = { name: 'Rolo 40', midia: 'rolo', ...ROLO_40 };
    const criado = await request(app).post('/api/v1/core/labels/templates').set(gerente).send(corpo);
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(pontoQuebrado(criado.body.avisos)).toHaveLength(1);

    const previa = await request(app).post('/api/v1/core/labels/templates/preview').set(gerente).send({ template: corpo });
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);
    expect(pontoQuebrado(previa.body.avisos)).toHaveLength(1);

    const salvoDoModelo = await request(app).post('/api/v1/core/labels/templates/preview').set(gerente).send({ templateId: criado.body.id });
    expect(pontoQuebrado(salvoDoModelo.body.avisos)).toHaveLength(1);

    const a300 = await request(app).patch(`/api/v1/core/labels/templates/${criado.body.id}`).set(gerente).send({ ...corpo, dpi: 300 });
    expect(a300.status, JSON.stringify(a300.body)).toBe(200);
    expect(pontoQuebrado(a300.body.avisos)).toEqual([]);
  });

  it('formatos prontos (não têm prévia): o que tem o ponto quebrado diz isso na dica — e só ele', () => {
    const quebrados = LABEL_FORMATS.filter((f) => f.campos.includes('barras') && pontoQuebrado(avisosDoFormato(f)).length > 0);
    expect(quebrados.map((f) => f.id)).toEqual(['rolo_33x22']);
    for (const f of LABEL_FORMATS) {
      expect(/pontos inteiros/.test(f.hint), `${f.id}: ${f.hint}`).toBe(quebrados.includes(f));
    }
    expect(pontoQuebrado(avisosDoFormato(findLabelFormat('rolo_33x22')!))[0]).toMatch(
      /Numa impressora de 203 dpi \(a mais comum para rolo\).*2,25 pontos/,
    );
  });
});

// ------------------------------------------------------- POST /labels/products

describe('C-etiquetas-R03 — POST /labels/products audita os códigos que grava e respeita o formato', () => {
  const trilhas = () =>
    getConnection()
      .prepare("SELECT user_id, entity_id, detail FROM core_audit_log WHERE company_id = ? AND action = 'label.products' ORDER BY created_at")
      .all(EMPRESA) as { user_id: string; entity_id: string; detail: string }[];

  it('o estoquista pede os dados de três produtos sem código: os três ganham EAN, e a resposta e a trilha dizem quais', async () => {
    const estoquista = await entrarComo('estoquista', 'estoquista');
    const ids = [produto('Sem código A'), produto('Sem código B'), produto('Sem código C')];
    const r = await request(app).post('/api/v1/core/labels/products').set(estoquista.auth).send({ items: ids.map((productId) => ({ productId })) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const esperados = ids.map((productId) => ({ productId, barcode: codigoNoBanco(productId) }));
    for (const e of esperados) expect(e.barcode).toMatch(/^2\d{12}$/);
    expect(r.body.codigosGerados.map(({ productId, barcode }: { productId: string; barcode: string }) => ({ productId, barcode }))).toEqual(esperados);

    const [trilha, ...outras] = trilhas();
    expect(outras).toHaveLength(0);
    // A trilha diz QUEM pediu: o estoquista, e não um usuário qualquer.
    expect(trilha.user_id).toBe(estoquista.id);
    expect(JSON.parse(trilha.detail)).toEqual({ produtos: 3, codigosGerados: esperados });
  });

  it('com o formato do cartaz de gôndola (sem barras nem número): ninguém ganha EAN, e a trilha diz zero', async () => {
    const p = produto('Para o cartaz');
    const r = await request(app).post('/api/v1/core/labels/products').set(gerente).send({ formatId: 'a4_gondola_2x5', items: [{ productId: p }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items[0].barcode).toBe('');
    expect(r.body.codigosGerados).toEqual([]);
    expect(codigoNoBanco(p)).toBeNull();
    const [trilha] = trilhas();
    expect(trilha.entity_id).toBe('a4_gondola_2x5');
    expect(JSON.parse(trilha.detail).codigosGerados).toEqual([]);
  });

  it('formato desconhecido: 400 dizendo onde achar os formatos, e nada gravado', async () => {
    const p = produto('Formato errado');
    const r = await request(app).post('/api/v1/core/labels/products').set(gerente).send({ formatId: 'nao_existe', items: [{ productId: p }] });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABEL_FORMAT_UNKNOWN');
    expect(r.body.error?.message).toMatch(/GET \/labels\/catalog/);
    expect(codigoNoBanco(p)).toBeNull();
    expect(trilhas()).toHaveLength(0);
  });

  it('lote com um produto que não existe: 404, nenhum código gravado e nenhuma trilha', async () => {
    const a = produto('Válido');
    const r = await request(app)
      .post('/api/v1/core/labels/products')
      .set(gerente)
      .send({ items: [{ productId: a }, { productId: 'nao-existe' }] });
    expect(r.status).toBe(404);
    expect(codigoNoBanco(a)).toBeNull();
    expect(trilhas()).toHaveLength(0);
  });

  it('pelo MODELO da loja (templateId): modelo sem barras nem número não grava EAN; modelo de OUTRA empresa é 404 e nada é gravado', async () => {
    const semCodigo = await request(app)
      .post('/api/v1/core/labels/templates')
      .set(gerente)
      .send({ name: 'Só nome e preço', midia: 'rolo', paperWidthMm: 50, widthMm: 50, heightMm: 30, fields: ['nome', 'preco'] });
    expect(semCodigo.status, JSON.stringify(semCodigo.body)).toBe(201);
    const p = produto('Pelo modelo');
    const r = await request(app).post('/api/v1/core/labels/products').set(gerente).send({ templateId: semCodigo.body.id, items: [{ productId: p }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.codigosGerados).toEqual([]);
    expect(codigoNoBanco(p)).toBeNull();
    expect(trilhas()[0].entity_id).toBe(`modelo:${semCodigo.body.id}`);

    // O modelo de outra empresa não vale aqui: 404, e o produto continua sem código.
    const outra = await loginForTest(app, { userId: 'gerente-outra', companyId: 'outra-empresa-r7', profileCodes: ['gerente_loja'] });
    const alheio = await request(app)
      .post('/api/v1/core/labels/templates')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ name: 'De outra loja', midia: 'rolo', paperWidthMm: 50, widthMm: 50, heightMm: 30, fields: ['nome', 'barras'] });
    expect(alheio.status, JSON.stringify(alheio.body)).toBe(201);
    const q = produto('Não é da outra');
    const cruzado = await request(app).post('/api/v1/core/labels/products').set(gerente).send({ templateId: alheio.body.id, items: [{ productId: q }] });
    expect(cruzado.status).toBe(404);
    expect(codigoNoBanco(q)).toBeNull();
    expect(trilhas()).toHaveLength(1);
  });

  it('o formato desconhecido diz onde vai cada coisa: formatId para o catálogo, templateId para o modelo', async () => {
    const r = await request(app).post('/api/v1/core/labels/products').set(gerente).send({ formatId: 'id-de-modelo', items: [{ productId: produto('X') }] });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/em templateId/);
  });

  it('lote acima de 1000 produtos é recusado antes de gravar qualquer código (o mesmo teto da folha)', async () => {
    const p = produto('Primeiro do lote grande');
    const items = [{ productId: p }, ...Array.from({ length: 1000 }, (_, i) => ({ productId: `inexistente-${i}` }))];
    const r = await request(app).post('/api/v1/core/labels/products').set(gerente).send({ items });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_LABELS_TOO_MANY');
    expect(r.body.error?.message).toMatch(/até 1000 produtos/);
    expect(codigoNoBanco(p)).toBeNull();
    expect(trilhas()).toHaveLength(0);
  });

  it('o caixa (sem products.manage) recebe os dados sem código, nada é gravado, e a trilha registra o pedido', async () => {
    const caixa = await entrarComo('caixa', 'operador_caixa_loja');
    const p = produto('Do caixa');
    const r = await request(app).post('/api/v1/core/labels/products').set(caixa.auth).send({ items: [{ productId: p }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items[0].barcode).toBe('');
    expect(r.body.codigosGerados).toEqual([]);
    expect(codigoNoBanco(p)).toBeNull();
    expect(JSON.parse(trilhas()[0].detail)).toEqual({ produtos: 1, codigosGerados: [] });
  });
});
