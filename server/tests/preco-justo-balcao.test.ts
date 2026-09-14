process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * PREÇO JUSTO — DO CADASTRO AO BALCÃO, PELA API
 * ============================================================================
 *
 * O caminho que a loja vai fazer no primeiro dia, provado ponta a ponta:
 *
 *   cadastrar no gestor → código interno / EAN / código de barras interno →
 *   modelo de etiqueta (1 e 2 colunas) → imprimir N etiquetas (estoque NÃO muda)
 *   → entrada de estoque → o PDV acha pelo scanner/código/nome → vende → baixa
 *   uma vez só (reenvio com a mesma chave não baixa de novo) → reimprimir cupom
 *   e etiqueta não mexe no estoque → preço, situação e fiscal alterados no
 *   gestor valem na venda seguinte (uma fonte de verdade).
 *
 * E o escopo: o operador de PDV consulta e vende, mas não configura etiqueta
 * nem gera código de cadastro — 403 do servidor.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { loadSaleForNfce } from '../src/services/core/FiscalXmlNfce.js';
import { isValidEan13 } from '../src/services/core/BarcodeService.js';

const app = createApp();
const SENHA = 'Senha@Balcao2026';

let loja: string;
let gestor: string;
let caixa: string;
let gaveta: string;
let chaves = 0;

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });
const saldo = (productId: string) =>
  (getConnection().prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM core_stock WHERE product_id = ?').get(productId) as { q: number }).q;
const movimentos = (productId: string) =>
  (getConnection().prepare('SELECT count(*) AS n FROM core_stock_movements WHERE product_id = ?').get(productId) as { n: number }).n;

async function entrar(login: string) {
  const r = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId: loja });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}

async function criarProduto(body: Record<string, unknown>) {
  const r = await request(app).post('/api/v1/core/products').set(portador(gestor)).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; internal_code: string; barcode: string | null };
}

async function entrada(productId: string, quantidade: number) {
  const r = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(portador(gestor))
    .send({ productId, movementType: 'in', quantity: quantidade, referenceType: 'entrada', referenceId: `nf-${productId}-${quantidade}`, unitCostCents: 1000 });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function buscarNoPdv(termo: string) {
  const r = await request(app).get(`/api/v1/core/products/search?q=${encodeURIComponent(termo)}`).set(portador(caixa));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.items as { id: string; name: string; price_cents: number; effective_price_cents?: number }[];
}

function vender(productId: string, quantidade: number, pagoCents: number, chave = `venda-${++chaves}`) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(portador(caixa))
    .set('Idempotency-Key', chave)
    .send({ cashSessionId: gaveta, items: [{ productId, quantity: quantidade }], payments: [{ method: 'dinheiro', amountCents: pagoCents }] });
}

beforeAll(async () => {
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Comércio Ltda', tradeName: 'Preço Justo' });
  const g = await upsertUser({ login: 'GESTOR.PJ', displayName: 'Gestor', password: SENHA });
  linkUserToCompany(g, loja, 'gerente_loja', true);
  const c = await upsertUser({ login: 'CAIXA.PJ', displayName: 'Caixa', password: SENHA });
  linkUserToCompany(c, loja, 'operador_caixa_loja', true);
  gestor = await entrar('GESTOR.PJ');
  caixa = await entrar('CAIXA.PJ');
  const abertura = await request(app).post('/api/v1/core/cash/open').set(portador(caixa)).send({ openingCents: 10000 });
  expect(abertura.status, JSON.stringify(abertura.body)).toBe(201);
  gaveta = abertura.body.id;
}, 60_000);

describe('A–F. cadastro no gestor, códigos e o PDV achando o produto', () => {
  it('A. produto cadastrado no gestor aparece no PDV, pelo nome e pelo código interno', async () => {
    const p = await criarProduto({ name: 'Arroz Tipo 1 5kg', priceCents: 1990, costCents: 1200 });
    expect((await buscarNoPdv('Arroz Tipo')).map((i) => i.id)).toContain(p.id);
    expect((await buscarNoPdv(p.internal_code)).map((i) => i.id)).toEqual([p.id]);
  });

  it('D. "Gerar código" reserva um código interno único e curto — e pula o que alguém digitou igual', async () => {
    const r1 = await request(app).post('/api/v1/core/products/codes/next').set(portador(gestor)).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.code).toMatch(/^GS-\d{6}$/);
    const numero = Number(r1.body.code.slice(3));
    const proximo = `GS-${String(numero + 1).padStart(6, '0')}`;
    await criarProduto({ name: 'Feijão Carioca 1kg', priceCents: 890, internalCode: proximo });
    const r2 = await request(app).post('/api/v1/core/products/codes/next').set(portador(gestor)).send({});
    expect(r2.body.code).not.toBe(proximo);
    expect(r2.body.code).not.toBe(r1.body.code);
    const p = await criarProduto({ name: 'Macarrão 500g', priceCents: 450, internalCode: r2.body.code });
    expect((await buscarNoPdv(r2.body.code)).map((i) => i.id)).toEqual([p.id]);
  });

  it('E. EAN do fabricante: o scanner acha; o mesmo EAN em outro produto é recusado antes de salvar', async () => {
    const p = await criarProduto({ name: 'Refrigerante 2L', priceCents: 999, barcode: '7894900011517' });
    expect((await buscarNoPdv('7894900011517')).map((i) => i.id)).toEqual([p.id]);
    const dup = await request(app).post('/api/v1/core/products').set(portador(gestor)).send({ name: 'Outro', priceCents: 100, barcode: '7894900011517' });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('CORE_BARCODE_DUPLICATE');
  });

  it('E2. EAN com o dígito verificador errado é recusado — no cadastro e na edição', async () => {
    // 7894900011517 é válido; trocar o último dígito dá um código que o scanner nunca leria.
    const novo = await request(app).post('/api/v1/core/products').set(portador(gestor)).send({ name: 'EAN torto', priceCents: 100, barcode: '7894900011518' });
    expect(novo.status).toBe(400);
    expect(novo.body.error?.code).toBe('CORE_BARCODE_INVALID');
    expect(novo.body.error?.message).toMatch(/deveria ser 7/);
    const p = await criarProduto({ name: 'Produto com EAN corrigido depois', priceCents: 100 });
    const edita = await request(app).put(`/api/v1/core/products/${p.id}`).set(portador(gestor)).send({ barcode: '7891000100104' });
    expect(edita.status).toBe(400);
    expect(edita.body.error?.code).toBe('CORE_BARCODE_INVALID');
    const certo = await request(app).put(`/api/v1/core/products/${p.id}`).set(portador(gestor)).send({ barcode: '7891000100103' });
    expect(certo.status, JSON.stringify(certo.body)).toBe(200);
    // Código interno da loja que não tem cara de GTIN (letras) continua livre.
    const interno = await criarProduto({ name: 'Código da loja', priceCents: 100, barcode: 'PJ-ABC-001' });
    expect(interno.barcode).toBe('PJ-ABC-001');
  });

  it('F. sem EAN: "Gerar código de barras" dá um EAN-13 interno válido (prefixo 2) — e o PDV acha por ele', async () => {
    const p = await criarProduto({ name: 'Sabão em barra', priceCents: 350 });
    expect(p.barcode).toBeNull();
    const r = await request(app).post(`/api/v1/core/products/${p.id}/barcode/internal`).set(portador(gestor)).send({});
    expect(r.status).toBe(200);
    expect(r.body.generated).toBe(true);
    expect(r.body.barcode).toMatch(/^2\d{12}$/);
    expect(isValidEan13(r.body.barcode)).toBe(true);
    expect((await buscarNoPdv(r.body.barcode)).map((i) => i.id)).toEqual([p.id]);
    // De novo: o produto já tem código, e fica com ele (etiqueta colada não invalida).
    const deNovo = await request(app).post(`/api/v1/core/products/${p.id}/barcode/internal`).set(portador(gestor)).send({});
    expect(deNovo.body).toMatchObject({ barcode: r.body.barcode, generated: false });
  });
});

describe('G–I, S. modelos de etiqueta, quantidade e reimpressão sem estoque', () => {
  let rolo1: string;
  let rolo2: string;

  it('G. modelo de 1 coluna: página do tamanho do adesivo, uma etiqueta por página', async () => {
    const r = await request(app).post('/api/v1/core/labels/templates').set(portador(gestor)).send({
      name: 'Rolo 40 × 30', midia: 'rolo', paperWidthMm: 40, widthMm: 40, heightMm: 30, columns: 1,
      fields: ['nome', 'preco', 'barras', 'ean', 'codigo'], isDefault: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    rolo1 = r.body.id;
    const p = await criarProduto({ name: 'Óleo de Soja 900ml', priceCents: 799, barcode: '7891107101621' });
    const folha = await request(app).post('/api/v1/core/labels/sheet').set(portador(gestor)).send({ templateId: rolo1, items: [{ productId: p.id, quantity: 3 }] });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    const html: string = folha.body.html;
    expect(html).toContain('@page { size: 40mm 30mm;');
    expect(html).toContain('grid-template-columns: repeat(1, 40mm);');
    expect(html.match(/class="etq"/g)?.length).toBe(3);
    expect(html.match(/<section class="folha">/g)?.length).toBe(3);
    expect(html).toContain('R$&nbsp;7,99'.replace('&nbsp;', ' '));
  });

  it('H. modelo de 2 colunas: esquerda/direita no papel real, a última coluna inteira; e o que não cabe é recusado', async () => {
    const r = await request(app).post('/api/v1/core/labels/templates').set(portador(gestor)).send({
      name: 'Rolo 30 × 20 — 2 colunas', midia: 'rolo', paperWidthMm: 64, widthMm: 30, heightMm: 20, columns: 2, gapXmm: 2, marginLeftMm: 1,
      fields: ['nome', 'preco', 'barras'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    rolo2 = r.body.id;
    const p = await criarProduto({ name: 'Açúcar 1kg', priceCents: 549, barcode: '7896035610214' });
    const folha = await request(app).post('/api/v1/core/labels/sheet').set(portador(gestor)).send({ templateId: rolo2, items: [{ productId: p.id, quantity: 5 }] });
    const html: string = folha.body.html;
    expect(html).toContain('@page { size: 64mm 20mm;');
    expect(html).toContain('grid-template-columns: repeat(2, 30mm);');
    expect(html).toContain('column-gap: 2mm;');
    expect(html).toContain('padding: 0mm 0 0 1mm;');
    expect(html.match(/class="etq"/g)?.length).toBe(5);
    // 5 etiquetas em 2 colunas = 3 linhas (a última com uma só).
    expect(html.match(/<section class="folha">/g)?.length).toBe(3);
    expect(folha.body).toMatchObject({ etiquetas: 5, folhas: 3 });

    const naoCabe = await request(app).post('/api/v1/core/labels/templates').set(portador(gestor)).send({
      name: 'Não cabe', midia: 'rolo', paperWidthMm: 60, widthMm: 30, heightMm: 20, columns: 2, gapXmm: 2, marginLeftMm: 1, fields: ['nome'],
    });
    expect(naoCabe.status).toBe(400);
    expect(naoCabe.body.error?.code).toBe('CORE_LABEL_TEMPLATE_DOES_NOT_FIT');
    expect(naoCabe.body.error?.message).toMatch(/cortada/);
  });

  it('I/S. imprimir 30 etiquetas — e reimprimir — não movimenta estoque', async () => {
    const p = await criarProduto({ name: 'Café 500g', priceCents: 1890 });
    await entrada(p.id, 30);
    const antes = { saldo: saldo(p.id), movs: movimentos(p.id) };
    expect(antes.saldo).toBe(30);
    for (let vez = 0; vez < 2; vez += 1) {
      const folha = await request(app).post('/api/v1/core/labels/sheet').set(portador(gestor)).send({ templateId: rolo1, items: [{ productId: p.id, quantity: 30 }] });
      expect(folha.body.etiquetas).toBe(30);
    }
    expect({ saldo: saldo(p.id), movs: movimentos(p.id) }).toEqual(antes);
  });

  it('a prévia do modelo só LÊ: não grava código de barras no produto', async () => {
    const p = await criarProduto({ name: 'Vassoura', priceCents: 1500 });
    const r = await request(app).post('/api/v1/core/labels/templates/preview').set(portador(gestor)).send({ templateId: rolo2, productId: p.id });
    expect(r.status).toBe(200);
    expect(r.body.html).toContain('Vassoura');
    const barcode = (getConnection().prepare('SELECT barcode FROM core_products WHERE id = ?').get(p.id) as { barcode: string | null }).barcode;
    expect(barcode).toBeNull();
  });

  it('o operador de PDV vê os modelos, mas não cria modelo nem gera código de cadastro (403)', async () => {
    expect((await request(app).get('/api/v1/core/labels/templates').set(portador(caixa))).status).toBe(200);
    const criar = await request(app).post('/api/v1/core/labels/templates').set(portador(caixa)).send({ name: 'X', widthMm: 40, heightMm: 30, fields: ['nome'] });
    expect(criar.status).toBe(403);
    expect((await request(app).post('/api/v1/core/products/codes/next').set(portador(caixa)).send({})).status).toBe(403);
    // Consultar e vender não dá poder de gestão: o caixa não muda o cadastro de quem já existe.
    const existente = await criarProduto({ name: 'Produto do gestor', priceCents: 1000 });
    const mudar = await request(app).put(`/api/v1/core/products/${existente.id}`).set(portador(caixa)).send({ priceCents: 1 });
    expect(mudar.status).toBe(403);
    expect((getConnection().prepare('SELECT price_cents FROM core_products WHERE id = ?').get(existente.id) as { price_cents: number }).price_cents).toBe(1000);
  });
});

describe('J, K, T. entrada, venda que baixa uma vez só, e cupom reimpresso sem estoque', () => {
  it('J/K. entrada aumenta; venda reduz; o reenvio da MESMA venda (fila offline) não baixa de novo', async () => {
    const p = await criarProduto({ name: 'Leite Integral 1L', priceCents: 499, barcode: '7896259410133' });
    await entrada(p.id, 10);
    expect(saldo(p.id)).toBe(10);
    const v = await vender(p.id, 2, 1000, 'chave-leite');
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.total_cents).toBe(998);
    expect(v.body.change_cents).toBe(2);
    expect(saldo(p.id)).toBe(8);
    // A fila do PDV reenvia com a MESMA chave quando a conexão volta.
    const reenvio = await vender(p.id, 2, 1000, 'chave-leite');
    expect(reenvio.body.id).toBe(v.body.id);
    expect(saldo(p.id)).toBe(8);
  });

  it('T. imprimir e reimprimir o cupom (COMPROVANTE NÃO FISCAL) não mexe no estoque', async () => {
    const p = await criarProduto({ name: 'Biscoito 200g', priceCents: 350 });
    await entrada(p.id, 5);
    const v = await vender(p.id, 1, 350);
    expect(v.status).toBe(201);
    const antes = { saldo: saldo(p.id), movs: movimentos(p.id) };
    const job = await request(app).post('/api/v1/core/print/jobs').set(portador(caixa)).send({ documentType: 'SALE_RECEIPT', documentId: v.body.id });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const reimpressao = await request(app).post(`/api/v1/core/print/jobs/${job.body.id}/reprint`).set(portador(gestor)).send({});
    expect(reimpressao.status, JSON.stringify(reimpressao.body)).toBe(201);
    expect({ saldo: saldo(p.id), movs: movimentos(p.id) }).toEqual(antes);
    const doc = await request(app).get(`/api/v1/core/print/jobs/${job.body.id}/document`).set(portador(caixa));
    expect(doc.text).toContain('COMPROVANTE NÃO FISCAL');
    expect(doc.text).toContain('Dinheiro');
  });
});

describe('B, C, fiscal. o gestor muda, o PDV usa na venda seguinte', () => {
  it('B. preço alterado de R$ 19,90 para R$ 21,90: a busca e a venda seguinte usam R$ 21,90', async () => {
    const p = await criarProduto({ name: 'ARROZ X', priceCents: 1990, barcode: '7898215151784' });
    await entrada(p.id, 5);
    expect((await buscarNoPdv('7898215151784'))[0]?.price_cents).toBe(1990);
    const put = await request(app).put(`/api/v1/core/products/${p.id}`).set(portador(gestor)).send({ priceCents: 2190 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const achado = (await buscarNoPdv('7898215151784'))[0]!;
    expect(achado.effective_price_cents ?? achado.price_cents).toBe(2190);
    const v = await vender(p.id, 1, 2190);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.total_cents).toBe(2190);
  });

  it('C. produto inativado some do PDV e não pode ser vendido', async () => {
    const p = await criarProduto({ name: 'Detergente', priceCents: 299, barcode: '7891022100693' });
    await entrada(p.id, 5);
    await request(app).put(`/api/v1/core/products/${p.id}`).set(portador(gestor)).send({ active: false });
    expect(await buscarNoPdv('7891022100693')).toEqual([]);
    const v = await vender(p.id, 1, 299);
    expect(v.status).not.toBe(201);
    expect(saldo(p.id)).toBe(5);
  });

  it('a classificação fiscal confirmada no cadastro é a que a NFC-e da venda seguinte usa', async () => {
    const p = await criarProduto({ name: 'Arroz Integral', priceCents: 1290, barcode: '7896006711117', ncm: '10062010' });
    await entrada(p.id, 5);
    const v1 = await vender(p.id, 1, 1290);
    expect(JSON.stringify(loadSaleForNfce(loja, v1.body.id))).toContain('10062010');
    await request(app).put(`/api/v1/core/products/${p.id}`).set(portador(gestor)).send({ ncm: '10063021' });
    const v2 = await vender(p.id, 1, 1290);
    const nota = JSON.stringify(loadSaleForNfce(loja, v2.body.id));
    expect(nota).toContain('10063021');
    expect(nota).not.toContain('10062010');
  });
});
