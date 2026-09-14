/**
 * Rotas dos eventos fiscais.
 *
 * O que se cobra aqui NÃO é a regra fiscal — ela tem testes próprios no
 * domínio. É a camada de borda: quem pode chamar, de qual operação, e que o
 * `companyId` venha SEMPRE do token.
 *
 * Aceitar `companyId` do corpo permitiria cancelar a nota de outra operação
 * sabendo o id do documento. É o tipo de furo que não aparece na tela.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfeForSale,
  getDocument,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const PASSWORD = 'Teste@Rotas2026';
const JUST = 'Erro de digitacao no pedido do cliente';

const DEST: NfeRecipient = {
  document: '11.444.777/0001-61',
  name: 'Comprador Atacado Ltda',
  ieIndicator: '1',
  ie: '987654321',
  street: 'Rua do Comércio',
  number: '500',
  district: 'Industrial',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  zip: '96010000',
  uf: 'RS',
};

let pjMotors: string;
let gringa: string;
let gestor: { Authorization: string };
let gestorGringa: { Authorization: string };
let caixa: { Authorization: string };
let mecanico: { Authorization: string };
let n = 0;

async function actor(login: string, profile: string, company: string) {
  const id = await upsertUser({ login, displayName: login, password: PASSWORD });
  linkUserToCompany(id, company, profile, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: PASSWORD });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function configurar(companyId: string) {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Operação Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
}

function criarVenda(companyId: string, id: string): string {
  ensureCoreSchema();
  n += 1;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Patinete', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `C-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 200000, 0, 0, 200000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Patinete', 2, 100000, 0, 200000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'pix', 200000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

async function nfeAutorizada(companyId: string, saleId: string) {
  const { document } = createNfeForSale({ companyId, saleId, recipient: DEST });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  transition({ companyId, documentId: document.id, to: 'SIGNED' });
  enqueue({ companyId, documentId: document.id });
  await processNext({ companyId, adapter: new SefazTestAdapter() });
  return getDocument(companyId, document.id)!;
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  pjMotors = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  configurar(pjMotors);
  configurar(gringa);

  gestor = await actor('GESTORPJ', 'gerente_loja', pjMotors);
  gestorGringa = await actor('GESTORGR', 'gerente_loja', gringa);
  caixa = await actor('CAIXAPJ', 'operador_caixa_loja', pjMotors);
  mecanico = await actor('MECPJ', 'mecanico', pjMotors);
});

describe('cancelamento pela rota', () => {
  it('gestor cancela e a resposta traz protocolo do evento', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r1'));

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/cancel`)
      .set(gestor)
      .send({ justification: JUST, developmentMode: true });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.protocol).toMatch(/^TEST-/);
    expect(res.body.document.status).toBe('CANCELLED');
  });

  it('justificativa curta volta 400 com a mensagem certa', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r2'));
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/cancel`)
      .set(gestor)
      .send({ justification: 'erro', developmentMode: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_JUSTIFICATION_TOO_SHORT');
  });

  it('caixa não cancela nota', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r3'));
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/cancel`)
      .set(caixa)
      .send({ justification: JUST, developmentMode: true });
    expect(res.status).toBe(403);
  });

  it('mecânico não acessa nenhum evento fiscal', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r4'));
    expect(
      (
        await request(app)
          .post(`/api/v1/core/fiscal/documents/${doc.id}/cancel`)
          .set(mecanico)
          .send({ justification: JUST })
      ).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/core/fiscal/void-ranges').set(mecanico)).status).toBe(403);
  });

  /** O furo que não aparece na tela: cancelar documento de outra operação. */
  it('gestor da Gringa NÃO cancela nota da PJ Motors, mesmo sabendo o id', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r5'));

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/cancel`)
      .set(gestorGringa)
      .send({ justification: JUST, developmentMode: true });

    expect(res.status).toBe(404);
    expect(getDocument(pjMotors, doc.id)!.status).toBe('AUTHORIZED');
  });

  it('companyId no corpo é ignorado — o escopo vem do token', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r6'));

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/cancel`)
      .set(gestorGringa)
      .send({ justification: JUST, developmentMode: true, companyId: pjMotors });

    expect(res.status).toBe(404);
    expect(getDocument(pjMotors, doc.id)!.status).toBe('AUTHORIZED');
  });
});

describe('carta de correção pela rota', () => {
  it('cria carta e devolve a sequência decidida pelo servidor', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r7'));

    const a = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/correction-letter`)
      .set(gestor)
      .send({ text: 'Corrigir o nome do bairro do destinatario', developmentMode: true });
    const b = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/correction-letter`)
      .set(gestor)
      .send({ text: 'Complementar dados de transporte da entrega', developmentMode: true });

    expect(a.body.sequence).toBe(1);
    expect(b.body.sequence).toBe(2);
  });

  /** A sequência NÃO vem do cliente. */
  it('sequência enviada pelo frontend é ignorada', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r8'));
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/correction-letter`)
      .set(gestor)
      .send({ text: 'Corrigir o ponto de referencia informado', sequence: 99, developmentMode: true });

    expect(res.body.sequence).toBe(1);
  });

  it('correção proibida volta 409 explicando o caminho', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r9'));
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${doc.id}/correction-letter`)
      .set(gestor)
      .send({ text: 'Corrigir o valor total da nota fiscal', developmentMode: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_CCE_FORBIDDEN');
  });

  it('o aviso dos limites vem do domínio', async () => {
    const res = await request(app)
      .get('/api/v1/core/fiscal/correction-letter/notice')
      .set(gestor);
    expect(res.status).toBe(200);
    expect(res.body.notice).toMatch(/não altera a NF-e/i);
  });
});

describe('inutilização pela rota', () => {
  it('cria e lista a faixa', async () => {
    const criar = await request(app)
      .post('/api/v1/core/fiscal/void-ranges')
      .set(gestor)
      .send({
        model: '55',
        serie: 1,
        year: 2026,
        from: 10,
        to: 15,
        justification: 'Falha no sistema durante a emissao',
        developmentMode: true,
      });

    expect(criar.status).toBe(200);
    expect(criar.body.accepted).toBe(true);

    const lista = await request(app).get('/api/v1/core/fiscal/void-ranges').set(gestor);
    expect(lista.body.items[0].from).toBe(10);
    expect(lista.body.items[0].status).toBe('AUTHORIZED');
  });

  it('faixa com número já emitido volta 409', async () => {
    await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r10'));
    const res = await request(app)
      .post('/api/v1/core/fiscal/void-ranges')
      .set(gestor)
      .send({
        model: '55', serie: 1, year: 2026, from: 1, to: 5,
        justification: 'Falha no sistema durante a emissao', developmentMode: true,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_VOID_NUMBER_USED');
  });

  it('caixa não inutiliza', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/void-ranges')
      .set(caixa)
      .send({
        model: '55', serie: 1, year: 2026, from: 20, to: 25,
        justification: 'Falha no sistema durante a emissao',
      });
    expect(res.status).toBe(403);
  });

  it('faixa de uma operação não aparece na outra', async () => {
    await request(app)
      .post('/api/v1/core/fiscal/void-ranges')
      .set(gestor)
      .send({
        model: '55', serie: 1, year: 2026, from: 30, to: 35,
        justification: 'Falha no sistema durante a emissao', developmentMode: true,
      });

    const outra = await request(app).get('/api/v1/core/fiscal/void-ranges').set(gestorGringa);
    expect(outra.body.items).toHaveLength(0);
  });
});

describe('XML e DANFE pela rota', () => {
  it('o XML é servido e não carrega segredo', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r11'));
    const res = await request(app)
      .get(`/api/v1/core/fiscal/documents/${doc.id}/xml`)
      .set(gestor);

    expect(res.status).toBe(200);
    // A rota serve a NOTA assinada, nao o envelope de resposta da SEFAZ.
    expect(res.text).toContain('assinado');
    expect(res.text).not.toMatch(/PRIVATE KEY|cscToken|\.pfx/i);
  });

  it('DANFE de outra operação volta 404', async () => {
    const doc = await nfeAutorizada(pjMotors, criarVenda(pjMotors, 'r12'));
    const res = await request(app)
      .get(`/api/v1/core/fiscal/documents/${doc.id}/danfe`)
      .set(gestorGringa);
    expect(res.status).toBe(404);
  });

  it('DANFE de documento não autorizado exige preview explícito', async () => {
    const { document } = createNfeForSale({
      companyId: pjMotors,
      saleId: criarVenda(pjMotors, 'r13'),
      recipient: DEST,
    });

    const semPreview = await request(app)
      .get(`/api/v1/core/fiscal/documents/${document.id}/danfe`)
      .set(gestor);
    expect(semPreview.status).toBe(409);

    const comPreview = await request(app)
      .get(`/api/v1/core/fiscal/documents/${document.id}/danfe?preview=1`)
      .set(gestor);
    expect(comPreview.status).toBe(200);
    expect(comPreview.text).toContain('DOCUMENTO NÃO AUTORIZADO');
  });
});
