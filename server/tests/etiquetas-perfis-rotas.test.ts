/**
 * ============================================================================
 * ETIQUETAS — P0 da Preço Justo: saídas, histórico, reimpressão e teste
 * ============================================================================
 *
 * Pela API, contra o banco de teste descartável:
 *
 *   - a MIGRAÇÃO: banco antigo sem as colunas novas do modelo ganha as nove,
 *     anuláveis, pelo `reconcileCoreSchema` — e rodar de novo não muda nada;
 *   - o MODELO grava a saída, a calibração e os ajustes da térmica, e a tela
 *     antiga (sem os campos) não os apaga;
 *   - a FOLHA em ZPL/PDF/navegador, com o histórico e a auditoria dizendo quem
 *     imprimiu, qual modelo e quantas de cada — sem guardar o arquivo;
 *   - a REIMPRESSÃO com o preço de hoje, apontando para a original;
 *   - a ETIQUETA DE TESTE (amostra 040, moldura), que não grava no cadastro;
 *   - o ISOLAMENTO entre operações e o alcance (atendente fora).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { reconcileCoreSchema } from '../src/db/core-migrations.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { createBatch, setBatchControl } from '../src/services/core/BatchService.js';
import { criarModelo } from '../src/services/core/LabelTemplateService.js';

const app = createApp();
const EMPRESA = 'loja-etq-p0';
const OUTRA = 'loja-etq-p0-outra';
let gerente: { Authorization: string };
let caixa: { Authorization: string };
let atendente: { Authorization: string };
let outraLoja: { Authorization: string };

const bearer = (r: { body: { accessToken: string } }) => ({ Authorization: `Bearer ${r.body.accessToken}` });

beforeEach(async () => {
  resetDbForTests();
  gerente = bearer(await loginForTest(app, { userId: 'gerente-p0', companyId: EMPRESA, profileCodes: ['gerente_loja'] }));
  caixa = bearer(await loginForTest(app, { userId: 'caixa-p0', companyId: EMPRESA, profileCodes: ['operador_caixa_loja'] }));
  atendente = bearer(await loginForTest(app, { userId: 'atendente-p0', companyId: EMPRESA, profileCodes: ['atendente'] }));
  outraLoja = bearer(await loginForTest(app, { userId: 'gerente-outra', companyId: OUTRA, profileCodes: ['gerente_loja'] }));
});

function produto(nome: string, extra: Record<string, unknown> = {}): string {
  return String(createProduct(EMPRESA, { name: nome, priceCents: 1990, barcode: '7891234567895', ...extra }).id);
}

const ROLO_ZPL = {
  name: 'Rolo 50 × 30 ZPL', midia: 'rolo', paperWidthMm: 50, widthMm: 50, heightMm: 30,
  fields: ['nome', 'preco', 'barras', 'ean'], outputProfile: 'zpl',
};

const decodificar = (b64: string, enc: BufferEncoding = 'utf8') => Buffer.from(b64, 'base64').toString(enc);

// ---------------------------------------------------------------- migração

describe('a migração é aditiva e idempotente', () => {
  it('banco antigo sem as nove colunas: o reconcile as acrescenta anuláveis, a linha antiga fica, e rodar de novo não muda nada', async () => {
    const db = getConnection();
    // O banco de teste é descartável: a tabela volta ao desenho de ANTES desta entrega.
    db.exec('DROP TABLE core_label_templates');
    db.exec(`CREATE TABLE core_label_templates (
       id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
       name TEXT NOT NULL, midia TEXT NOT NULL DEFAULT 'rolo', paper_width_mm REAL NOT NULL, paper_height_mm REAL,
       width_mm REAL NOT NULL, height_mm REAL NOT NULL, colunas INTEGER NOT NULL DEFAULT 1, linhas INTEGER,
       gap_x_mm REAL NOT NULL DEFAULT 0, gap_y_mm REAL NOT NULL DEFAULT 0, margin_top_mm REAL NOT NULL DEFAULT 0,
       margin_left_mm REAL NOT NULL DEFAULT 0, orientation TEXT NOT NULL DEFAULT 'retrato',
       scale_percent INTEGER NOT NULL DEFAULT 100, dpi INTEGER NOT NULL DEFAULT 203, fields TEXT NOT NULL,
       price_highlight INTEGER NOT NULL DEFAULT 1, complement_text TEXT,
       printer_id TEXT REFERENCES core_printers(id) ON DELETE SET NULL, is_default INTEGER NOT NULL DEFAULT 0,
       created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (company_id, name))`);
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_label_templates (id, company_id, name, paper_width_mm, width_mm, height_mm, fields, created_at, updated_at)
       VALUES ('antigo', ?, 'Modelo antigo', 50, 50, 30, '["nome","preco"]', ?, ?)`,
    ).run(EMPRESA, agora, agora);

    const primeira = reconcileCoreSchema();
    const novas = ['output_profile', 'offset_x_mm', 'offset_y_mm', 'darkness', 'print_speed', 'cut_mode', 'media_type', 'media_gap_mm', 'feed_after_mm'];
    expect(primeira.added).toEqual(expect.arrayContaining(novas.map((c) => `core_label_templates.${c}`)));
    expect(primeira.skipped.filter((c) => c.startsWith('core_label_templates'))).toEqual([]);
    const colunas = db.prepare('PRAGMA table_info(core_label_templates)').all() as { name: string; notnull: number; dflt_value: unknown }[];
    for (const c of novas) {
      const col = colunas.find((x) => x.name === c);
      expect(col, c).toBeDefined();
      expect(col!.notnull, c).toBe(0);
      expect(col!.dflt_value, c).toBeNull();
    }
    const segunda = reconcileCoreSchema();
    expect(segunda.added.filter((c) => c.startsWith('core_label_templates'))).toEqual([]);

    // A linha antiga continua, e sai com o padrão onde a coluna é nula.
    const lista = await request(app).get('/api/v1/core/labels/templates').set(gerente);
    expect(lista.status).toBe(200);
    const antigo = lista.body.items.find((m: { id: string }) => m.id === 'antigo');
    expect(antigo).toMatchObject({ outputProfile: null, offsetXmm: 0, offsetYmm: 0, darkness: null, printSpeed: null, cutMode: 'nenhum', mediaType: 'vao', mediaGapMm: null, feedAfterMm: 0 });
  });

  it('o histórico de impressão nasce com a tabela e o índice por empresa', () => {
    const db = getConnection();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'core_label_print_jobs'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_label_print_jobs_empresa'").get()).toBeDefined();
  });
});

// ------------------------------------------------------------------ modelo

describe('o modelo guarda a saída, a calibração e os ajustes da térmica', () => {
  it('grava, lista, a tela antiga (sem os campos) não apaga, e valor fora da faixa é recusado dizendo o campo', async () => {
    const criado = await request(app).post('/api/v1/core/labels/templates').set(gerente).send({
      ...ROLO_ZPL, offsetXmm: 1.25, offsetYmm: -0.5, darkness: 18, printSpeed: 4, cutMode: 'fim_do_lote', mediaType: 'marca', mediaGapMm: 3, feedAfterMm: 5,
    });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body).toMatchObject({ outputProfile: 'zpl', offsetXmm: 1.25, offsetYmm: -0.5, darkness: 18, printSpeed: 4, cutMode: 'fim_do_lote', mediaType: 'marca', mediaGapMm: 3, feedAfterMm: 5 });
    const id = String(criado.body.id);

    // A tela antiga manda só o que conhecia: nada da impressora muda.
    const { outputProfile: _o, ...semSaida } = ROLO_ZPL;
    const antiga = await request(app).patch(`/api/v1/core/labels/templates/${id}`).set(gerente).send(semSaida);
    expect(antiga.status, JSON.stringify(antiga.body)).toBe(200);
    expect(antiga.body).toMatchObject({ outputProfile: 'zpl', offsetXmm: 1.25, cutMode: 'fim_do_lote', mediaGapMm: 3 });

    for (const [campo, valor, frase] of [
      ['cutMode', 'guilhotina', /Corte/],
      ['mediaType', 'furo', /Sensor da mídia/],
      ['offsetXmm', 11, /Deslocamento horizontal/],
      ['darkness', 31, /Densidade/],
      ['outputProfile', 'ppla', /Saída padrão/],
    ] as const) {
      const r = await request(app).patch(`/api/v1/core/labels/templates/${id}`).set(gerente).send({ ...ROLO_ZPL, [campo]: valor });
      expect(r.status, campo).toBe(400);
      expect(r.body.error?.code, campo).toBe('CORE_LABEL_TEMPLATE_INVALID');
      expect(r.body.error?.message, campo).toMatch(frase);
    }
  });

  it('saída de térmica numa FOLHA é recusada — inclusive a mantida de antes quando a mídia muda', async () => {
    const folha = await request(app).post('/api/v1/core/labels/templates').set(gerente).send({
      name: 'Folha', midia: 'folha', widthMm: 63.5, heightMm: 25.4, columns: 3, paperWidthMm: 210, fields: ['nome'], outputProfile: 'tspl',
    });
    expect(folha.status).toBe(400);
    expect(folha.body.error?.message).toMatch(/não imprime folha/);
    const rolo = await request(app).post('/api/v1/core/labels/templates').set(gerente).send(ROLO_ZPL);
    const mudou = await request(app).patch(`/api/v1/core/labels/templates/${rolo.body.id}`).set(gerente).send({
      name: 'Rolo 50 × 30 ZPL', midia: 'folha', widthMm: 63.5, heightMm: 25.4, columns: 3, paperWidthMm: 210, fields: ['nome'],
    });
    expect(mudou.status).toBe(400);
    expect(mudou.body.error?.message).toMatch(/não imprime folha/);
  });
});

// ---------------------------------------------------------------- a folha

describe('a folha na saída escolhida, com histórico e auditoria', () => {
  it('ZPL pelo modelo: o arquivo é o texto dos comandos, a prévia é SVG, e o histórico e a trilha dizem quem, qual modelo e quantas', async () => {
    const m = criarModelo(EMPRESA, null, ROLO_ZPL);
    const arroz = produto('Arroz');
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({
      templateId: m.id, perfil: 'zpl', items: [{ productId: arroz, quantity: 3 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.perfil).toBe('zpl');
    expect(r.body.etiquetas).toBe(3);
    expect(r.body.arquivo.nome).toMatch(/\.zpl$/);
    expect(decodificar(r.body.arquivo.base64)).toBe(r.body.comandos);
    expect(r.body.comandos).toContain('^PQ3,0,1,Y');
    expect(r.body.comandos).toContain('^FD789123456789^FS');
    expect(r.body.html).toContain('<svg class="pagina"');

    const job = getConnection().prepare('SELECT * FROM core_label_print_jobs WHERE id = ?').get(r.body.impressaoId) as Record<string, unknown>;
    expect(job).toMatchObject({ company_id: EMPRESA, kind: 'lote', profile: 'zpl', template_id: m.id, format_id: `modelo:${m.id}`, labels: 3, pages: 3, start_at: 1 });
    expect(job.user_id).toBeTruthy();
    expect(JSON.parse(String(job.items))).toEqual([{ productId: arroz, name: 'Arroz', quantity: 3, priceCents: 1990, batchId: null }]);

    const audit = getConnection()
      .prepare("SELECT user_id, detail FROM core_audit_log WHERE company_id = ? AND action = 'label.sheet' ORDER BY created_at DESC LIMIT 1")
      .get(EMPRESA) as { user_id: string; detail: string };
    expect(audit.user_id).toBe(job.user_id);
    const detail = JSON.parse(audit.detail);
    expect(detail).toMatchObject({ perfil: 'zpl', modelo: m.id, quantidades: [{ productId: arroz, quantidade: 3 }], impressaoId: r.body.impressaoId, etiquetas: 3 });
    // A trilha não guarda o arquivo nem os comandos.
    expect(audit.detail).not.toMatch(/\^XA|base64/);
  });

  it('sem saída pedida, a folha é a de sempre (navegador): HTML da folha, sem arquivo — e fica no histórico', async () => {
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: produto('Feijão') }] });
    expect(r.status).toBe(200);
    expect(r.body.perfil).toBe('navegador');
    expect(r.body.arquivo).toBeNull();
    expect(r.body.html).toContain('@page { size: 50mm 30mm');
    const job = getConnection().prepare('SELECT profile, kind FROM core_label_print_jobs WHERE id = ?').get(r.body.impressaoId);
    expect(job).toEqual({ profile: 'navegador', kind: 'lote' });
  });

  it('PDF na folha A4: um PDF de verdade; térmica na folha A4 e saída desconhecida são recusadas dizendo o que usar', async () => {
    const p = produto('Café');
    const pdf = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'a4_63x25_3x11', perfil: 'pdf', items: [{ productId: p }] });
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);
    expect(decodificar(pdf.body.arquivo.base64, 'latin1').startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.body.arquivo.mime).toBe('application/pdf');

    const tspl = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'a4_63x25_3x11', perfil: 'tspl', items: [{ productId: p }] });
    expect(tspl.status).toBe(400);
    expect(tspl.body.error?.code).toBe('CORE_LABEL_PROFILE_MEDIA');
    expect(tspl.body.error?.message).toMatch(/Navegador, Driver da impressora ou PDF/);

    const nada = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', perfil: 'ppla', items: [{ productId: p }] });
    expect(nada.status).toBe(400);
    expect(nada.body.error?.code).toBe('CORE_LABEL_PROFILE_UNKNOWN');
  });

  it('validade e lote: o lote informado sai na etiqueta; lote de outro produto é recusado; sem lote com saldo, não se inventa validade', async () => {
    const m = criarModelo(EMPRESA, null, { ...ROLO_ZPL, name: 'Com validade', heightMm: 40, fields: ['nome', 'preco', 'validade', 'lote', 'barras'] });
    const iogurte = produto('Iogurte');
    const outro = produto('Outro', { barcode: '7891234567802' });
    // Lote só existe em produto que controla lote e validade.
    setBatchControl({ companyId: EMPRESA, productId: iogurte, tracksBatches: true });
    const lote = createBatch(EMPRESA, { productId: iogurte, code: 'L2409', expiresOn: '2026-12-31' });

    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({
      templateId: m.id, perfil: 'zpl', items: [{ productId: iogurte, quantity: 1, batchId: lote.id }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.comandos).toContain('Val. 31/12/2026 · Lote L2409');
    const job = getConnection().prepare('SELECT items FROM core_label_print_jobs WHERE id = ?').get(r.body.impressaoId) as { items: string };
    expect(JSON.parse(job.items)[0].batchId).toBe(lote.id);

    const alheio = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({
      templateId: m.id, perfil: 'zpl', items: [{ productId: outro, quantity: 1, batchId: lote.id }],
    });
    expect(alheio.status).toBe(404);
    expect(alheio.body.error?.code).toBe('CORE_BATCH_NOT_FOUND');

    // O lote existe, mas sem saldo no razão: a etiqueta sai sem a linha.
    const semSaldo = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({
      templateId: m.id, perfil: 'zpl', items: [{ productId: iogurte, quantity: 1 }],
    });
    expect(semSaldo.status).toBe(200);
    expect(semSaldo.body.comandos).not.toContain('Val. ');
  });
});

// ------------------------------------------------ histórico e reimpressão

describe('o histórico e a reimpressão', () => {
  it('o caixa lista e reimprime o lote do gerente, em outra saída; a reimpressão sai com o preço de HOJE e aponta para a original', async () => {
    const arroz = produto('Arroz');
    const original = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: arroz, quantity: 2 }] });
    expect(original.status).toBe(200);
    getConnection().prepare('UPDATE core_products SET price_cents = 2490 WHERE id = ?').run(arroz);

    const lista = await request(app).get('/api/v1/core/labels/prints').set(caixa);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0]).toMatchObject({ id: original.body.impressaoId, kind: 'lote', profile: 'navegador', labels: 2, formatName: 'Rolo 50 × 30 mm' });

    const re = await request(app).post(`/api/v1/core/labels/prints/${original.body.impressaoId}/reprint`).set(caixa).send({ perfil: 'epl' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.perfil).toBe('epl');
    expect(re.body.etiquetas).toBe(2);
    expect(re.body.arquivo.nome).toMatch(/\.epl$/);
    expect(decodificar(re.body.arquivo.base64, 'latin1')).toContain('R$ 24,90');

    const job = getConnection().prepare('SELECT * FROM core_label_print_jobs WHERE id = ?').get(re.body.impressaoId) as Record<string, unknown>;
    expect(job).toMatchObject({ kind: 'reimpressao', profile: 'epl', reprint_of: original.body.impressaoId });
    expect(JSON.parse(String(job.items))[0].priceCents).toBe(2490);
    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE company_id = ? AND action = 'label.reprint'")
      .get(EMPRESA) as { detail: string };
    expect(JSON.parse(trilha.detail).reimpressaoDe).toBe(original.body.impressaoId);
  });

  it('isolamento: outra operação não vê o histórico desta e não a reimprime (404, e não 403)', async () => {
    const r = await request(app).post('/api/v1/core/labels/sheet').set(gerente).send({ formatId: 'rolo_50x30', items: [{ productId: produto('Sal') }] });
    const outra = await request(app).get('/api/v1/core/labels/prints').set(outraLoja);
    expect(outra.body.items).toEqual([]);
    const tentativa = await request(app).post(`/api/v1/core/labels/prints/${r.body.impressaoId}/reprint`).set(outraLoja).send({});
    expect(tentativa.status).toBe(404);
    expect(tentativa.body.error?.code).toBe('CORE_LABEL_PRINT_NOT_FOUND');
  });

  it('o atendente não imprime etiqueta: o histórico, a reimpressão e o teste respondem 403', async () => {
    expect((await request(app).get('/api/v1/core/labels/prints').set(atendente)).status).toBe(403);
    expect((await request(app).post('/api/v1/core/labels/prints/qualquer/reprint').set(atendente).send({})).status).toBe(403);
    expect((await request(app).post('/api/v1/core/labels/test').set(atendente).send({ formatId: 'rolo_50x30' })).status).toBe(403);
  });
});

// ----------------------------------------------------- etiqueta de teste

describe('a etiqueta de teste', () => {
  it('sai com a amostra 040 e a moldura, não grava código em produto nenhum, fica no histórico e não tem reimpressão', async () => {
    const semCodigo = String(createProduct(EMPRESA, { name: 'Sem código', priceCents: 990 }).id);
    const r = await request(app).post('/api/v1/core/labels/test').set(caixa).send({ formatId: 'rolo_50x30', perfil: 'zpl' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.comandos).toContain('^FD040000000000^FS');
    expect(r.body.comandos).toMatch(/\^GB\d+,\d+,\d+,B,0\^FS/);
    const barcode = getConnection().prepare('SELECT barcode FROM core_products WHERE id = ?').get(semCodigo) as { barcode: string | null };
    expect(barcode.barcode).toBeNull();

    const job = getConnection().prepare('SELECT kind, items FROM core_label_print_jobs WHERE id = ?').get(r.body.impressaoId);
    expect(job).toEqual({ kind: 'teste', items: '[]' });
    const trilha = getConnection().prepare("SELECT count(*) AS n FROM core_audit_log WHERE company_id = ? AND action = 'label.test'").get(EMPRESA) as { n: number };
    expect(trilha.n).toBe(1);

    const re = await request(app).post(`/api/v1/core/labels/prints/${r.body.impressaoId}/reprint`).set(caixa).send({});
    expect(re.status).toBe(409);
    expect(re.body.error?.code).toBe('CORE_LABEL_REPRINT_TEST');
  });

  it('no navegador, a etiqueta de teste é a folha com o contorno no papel', async () => {
    const r = await request(app).post('/api/v1/core/labels/test').set(gerente).send({ formatId: 'rolo_50x30' });
    expect(r.status).toBe(200);
    expect(r.body.arquivo).toBeNull();
    expect(r.body.html).toContain('.folha .etq { outline: 0.25mm solid #000;');
  });
});

describe('o catálogo diz as saídas e o que falta homologar', () => {
  it('GET /labels/catalog traz os sete perfis, o padrão e a lista de homologação física', async () => {
    const r = await request(app).get('/api/v1/core/labels/catalog').set(caixa);
    expect(r.status).toBe(200);
    expect(r.body.perfis.map((p: { id: string }) => p.id)).toEqual(['navegador', 'driver_windows', 'termica_generica', 'pdf', 'zpl', 'epl', 'tspl']);
    expect(r.body.perfilPadrao).toBe('navegador');
    expect(r.body.homologacao.length).toBeGreaterThan(5);
  });
});
