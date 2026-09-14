/**
 * O PAPEL NA LARGURA DA BOBINA (auditoria do cupom, F-07 e F-17).
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * F-07  O cupom e o DANFCE pelo navegador eram fixos em 80 mm, e o POST
 *       /print/jobs renderizava o papel ANTES de escolher a impressora: a
 *       térmica de 58 mm cadastrada recebia uma página de 74 mm, e o driver
 *       cortava a coluna dos valores (TOTAL, TROCO) ou encolhia tudo.
 *
 * F-17  O agente só reconhecia EXATAMENTE 58: quem cadastrasse 57 (a medida
 *       escrita na bobina) ganhava 48 colunas numa impressora de 32. O
 *       cadastro gravava qualquer número. E no ESC/POS o nome longo e a linha
 *       "Venda #12345  14/09/2026, 10:30:00" passavam de 32 colunas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { renderDocument } from '../src/services/core/PrintRenderer.js';
import { upsertPrinter } from '../src/services/core/PrintEngine.js';
import { colunasDa } from '../src/services/core/PrintAgentQueue.js';
import { cupomEscPos } from '../src/services/core/EscPos.js';

const app = createApp();
const SENHA = 'Bobina@Estreita2026';

let empresa: string;
let userId: string;
let auth: { Authorization: string };
let saleId: string;

function vendaSimples(): string {
  ensureCoreSchema();
  const db = getConnection();
  const agora = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents, active, created_at, updated_at)
     VALUES ('p-bob', ?, 'BOB-1', 'Camiseta', 'UN', 0, 5000, 1, ?, ?)`,
  ).run(empresa, agora, agora);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES ('v-bob', ?, 1, 'completed', 5000, 0, 0, 5000, 'pdv', 'k-bob', 0, ?)`,
  ).run(empresa, agora);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES ('i-bob', 'v-bob', ?, 'p-bob', 'Camiseta', 1, 5000, 0, 5000)`,
  ).run(empresa);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES ('pay-bob', 'v-bob', ?, 'dinheiro', 5000, 'settled', ?)`,
  ).run(empresa, agora);
  return 'v-bob';
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  userId = await upsertUser({ login: 'CAIXA.BOBINA', displayName: 'Caixa', password: SENHA });
  linkUserToCompany(userId, empresa, 'operador_caixa_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: 'CAIXA.BOBINA', password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  saleId = vendaSimples();
});

// ============================================================================

describe('F-07 — o papel do navegador se mede pela bobina', () => {
  it('cupom de 58 mm: página de 58 mm e corpo de 48 mm; sem largura, o de 80 mm de sempre', () => {
    const estreito = renderDocument(empresa, 'SALE_RECEIPT', saleId, { larguraMm: 58 });
    expect(estreito).toContain('size: 58mm auto');
    // A cabeça térmica da bobina de 58 imprime ~48 mm: um corpo de 54 mm (a
    // primeira versão do conserto) ainda cortava a coluna dos valores.
    expect(estreito).toContain('width: 48mm');
    expect(estreito).toContain('margin: 5mm');
    expect(estreito).not.toContain('80mm');

    const padrao = renderDocument(empresa, 'SALE_RECEIPT', saleId);
    expect(padrao).toContain('size: 80mm auto');
    expect(padrao).toContain('width: 74mm');

    // 57 mm (a medida escrita na bobina) é a mesma bobina de 58.
    expect(renderDocument(empresa, 'SALE_RECEIPT', saleId, { larguraMm: 57 })).toContain('size: 58mm auto');
  });

  it('POST /print/jobs: a impressora de 58 mm do cupom recebe o papel de 58 mm', async () => {
    upsertPrinter({ companyId: empresa, name: 'Térmica 58', kind: 'cupom', paperWidthMm: 58, isDefault: true });

    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: saleId });
    expect(job.status, JSON.stringify(job.body)).toBe(201);

    const doc = await request(app).get(`/api/v1/core/print/jobs/${job.body.id}/document`).set(auth);
    expect(doc.status).toBe(200);
    expect(doc.text).toContain('size: 58mm auto');
  });

  it('POST /print/jobs: a impressora de 80 mm, ou nenhuma, continua com o papel de 80 mm', async () => {
    const semImpressora = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: saleId });
    expect(semImpressora.status, JSON.stringify(semImpressora.body)).toBe(201);
    const doc = await request(app).get(`/api/v1/core/print/jobs/${semImpressora.body.id}/document`).set(auth);
    expect(doc.text).toContain('size: 80mm auto');

    const larga = upsertPrinter({ companyId: empresa, name: 'Térmica 80', kind: 'cupom', paperWidthMm: 80 });
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: saleId, printerId: larga.id });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const doc80 = await request(app).get(`/api/v1/core/print/jobs/${job.body.id}/document`).set(auth);
    expect(doc80.text).toContain('size: 80mm auto');
  });

  it('o fechamento de caixa também sai na bobina de 58', async () => {
    const { openSession, closeSession } = await import('../src/services/core/CashService.js');
    const sessao = openSession({ companyId: empresa, userId, openingCents: 10_000 });
    closeSession({ companyId: empresa, sessionId: sessao.id, countedCents: 10_000, userId });
    const html = renderDocument(empresa, 'CASH_CLOSING', sessao.id, { larguraMm: 58 });
    expect(html).toContain('size: 58mm auto');
    expect(html).toContain('FECHAMENTO DE CAIXA');
  });
});

// ============================================================================

describe('F-17 — 57 mm é a bobina de 58, e o cadastro só aceita bobina que existe', () => {
  it('o agente monta 32 colunas para 57 e 58 mm, e 48 para 80 mm ou sem medida', () => {
    expect(colunasDa(57)).toBe(32);
    expect(colunasDa(58)).toBe(32);
    expect(colunasDa(79)).toBe(48);
    expect(colunasDa(80)).toBe(48);
    expect(colunasDa(null)).toBe(48);
  });

  it('impressora de cupom: 57 vira 58, 79 vira 80, e 65 é recusado com a frase que manda conferir', () => {
    expect(upsertPrinter({ companyId: empresa, name: 'A', kind: 'cupom', paperWidthMm: 57 }).paper_width_mm).toBe(58);
    expect(upsertPrinter({ companyId: empresa, name: 'B', kind: 'cupom', paperWidthMm: 79 }).paper_width_mm).toBe(80);
    expect(upsertPrinter({ companyId: empresa, name: 'C', kind: 'cupom' }).paper_width_mm).toBeNull();

    let erro: unknown;
    try {
      upsertPrinter({ companyId: empresa, name: 'D', kind: 'cupom', paperWidthMm: 65 });
    } catch (e) {
      erro = e;
    }
    expect(erro).toMatchObject({ code: 'CORE_PRINTER_PAPER_WIDTH_INVALID', status: 400 });
    expect(String((erro as Error).message)).toMatch(/58 mm ou de 80 mm/);
  });

  it('a etiqueta continua com a medida dela — a régua é só da bobina de cupom', () => {
    expect(upsertPrinter({ companyId: empresa, name: 'Etiq', kind: 'etiqueta', paperWidthMm: 40 }).paper_width_mm).toBe(40);
  });

  it('no ESC/POS de 32 colunas nenhuma linha passa da bobina — nome longo quebra por palavra', () => {
    const nomeLongo = 'Camiseta Gola V Algodao Egipcio Premium Manga Longa Azul Marinho';
    const bytes = cupomEscPos({
      loja: 'Preco Justo',
      cnpj: '12.345.678/0001-90',
      endereco: 'Rua das Palmeiras, 128 - Centro - Pelotas - RS',
      numero: 12345,
      quando: '14/09/2026, 10:30:00',
      itens: [{ descricao: nomeLongo, quantidade: 1, unitarioCents: 12_990, totalCents: 12_990 }],
      subtotalCents: 12_990,
      totalCents: 12_990,
      pagamentos: [{ metodo: 'PIX - aguardando confirmacao', valorCents: 12_990 }],
      aReceberCents: 12_990,
      colunas: 32,
    });
    // O texto impresso, sem os comandos ESC/POS (ESC @, ESC a n, ESC E n, GS V B 0).
    const imprimiveis: number[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x1b) {
        i += bytes[i + 1] === 0x40 ? 1 : bytes[i + 1] === 0x70 ? 4 : 2;
        continue;
      }
      if (bytes[i] === 0x1d) {
        i += 3;
        continue;
      }
      imprimiveis.push(bytes[i]);
    }
    const texto = Buffer.from(imprimiveis).toString('latin1');
    const linhas = texto.split('\n');

    const largas = linhas.filter((l) => l.length > 32);
    expect(largas, JSON.stringify(largas)).toEqual([]);
    // Nenhuma palavra do nome foi partida no meio.
    for (const palavra of nomeLongo.split(' ')) expect(texto).toContain(palavra);
    // A data não coube ao lado do número: desceu para a linha dela, inteira.
    expect(linhas).toContain('Venda #12345');
    expect(linhas.some((l) => l.trim() === '14/09/2026, 10:30:00')).toBe(true);
    // O valor que não cabe ao lado do rótulo desce alinhado à direita, sem quebrar.
    expect(linhas.some((l) => l.length === 32 && l.endsWith('129,90'))).toBe(true);
  });
});
