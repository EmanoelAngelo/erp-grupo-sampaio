/**
 * O RECORTE CRUZADO SEGUE O PERFIL EM CADA OPERAÇÃO — GAP-PRD-084.
 *
 * O painel (`GET /dashboard?companyId=`) e o BI (`/insights/*`) atravessam
 * empresas pelo VÍNCULO. Mas vínculo não é alçada: a pessoa que é
 * `gerente_loja` na Conceito e `mecanico` na PJ Motors lia, com o token da
 * Conceito, o faturamento, o ticket, a margem e os mais vendidos da PJ Motors
 * — onde ela é mecânico e onde, com o token de lá, painel e BI respondem 403.
 *
 * A régua daqui: uma operação entra no recorte cruzado só se o perfil da
 * pessoa NAQUELA operação abriria a mesma rota lá. O painel é do escritório
 * (`abertaAo(req, 'escritorio')` + os donos); o BI é dos dois gerentes + os
 * donos.
 *
 * Status exato, e o caminho feliz também é cobrado: filtro que esvazia tudo
 * passaria nos casos de recusa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { PERFIS_QUE_LEEM_O_BI } from '../src/services/core/GroupInsights.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const CONCEITO = 'empresa-conceito';
const PJ = 'empresa-pj';
const GRINGA = 'empresa-gringa';
const MEIO_DIA = '2026-06-10T15:00:00.000Z';
const PESSOA = 'u-duas-casas';

let app: ReturnType<typeof createApp>;

function vincular(userId: string, companyId: string, perfil: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (user_id, company_id) DO UPDATE SET profile_code = excluded.profile_code`,
    )
    .run(`${userId}:${companyId}`, userId, companyId, perfil, MEIO_DIA);
}

/** Sessão na operação `companyId`, com o perfil que o vínculo de lá tem. */
function sessaoEm(userId: string, companyId: string, perfil: string): { Authorization: string } {
  const s = issueSession({ userId, companyId, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

function empresa(id: string, nome: string): void {
  getConnection()
    .prepare(
      `INSERT OR IGNORE INTO core_companies
         (id, slug, legal_name, trade_name, tax_regime, kind, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'simples', 'retail', 1, ?, ?)`,
    )
    .run(id, id, `${nome} Ltda`, nome, MEIO_DIA, MEIO_DIA);
}

let numero = 0;
/** Uma venda com um item — o nome e a marca carregam a operação, para a prova. */
function venda(companyId: string, totalCents: number): void {
  numero += 1;
  const db = getConnection();
  const saleId = randomUUID();
  const productId = randomUUID();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, brand, cost_cents, price_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    productId,
    companyId,
    `P${numero}`,
    `Item ${companyId}`,
    `Marca ${companyId}`,
    Math.round(totalCents / 2),
    totalCents,
    MEIO_DIA,
    MEIO_DIA,
  );
  db.prepare(
    `INSERT INTO core_sales
       (id, company_id, number, status, subtotal_cents, total_cents, idempotency_key, created_at)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`,
  ).run(saleId, companyId, numero, totalCents, totalCents, randomUUID(), MEIO_DIA);
  db.prepare(
    `INSERT INTO core_sale_items
       (id, sale_id, company_id, product_id, description, quantity, unit_price_cents, total_cents, cost_cents)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    // O custo vai FOTOGRAFADO no item, como o PDV grava: a margem do BI lê o
    // custo da venda, o mesmo do CMV do DRE (GAP-PRD-086), e não o do cadastro.
  ).run(randomUUID(), saleId, companyId, productId, `Item ${companyId}`, totalCents, totalCents, Math.round(totalCents / 2));
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  // A sessão cria a empresa da sessão; as outras duas nascem aqui.
  sessaoEm(PESSOA, CONCEITO, 'gerente_loja');
  empresa(PJ, 'PJ Motors');
  empresa(GRINGA, 'Gringa');
  vincular(PESSOA, PJ, 'mecanico');
  vincular(PESSOA, GRINGA, 'gerente_loja');
  venda(CONCEITO, 10_000);
  venda(PJ, 50_000);
  venda(GRINGA, 7_000);
});

const PERIODO = 'from=2026-06-01&to=2026-06-30';

describe('o painel de outra operação só abre onde o perfil de lá abriria', () => {
  it('gerente na Conceito e mecânico na PJ: ?companyId=PJ é 403, e o faturamento da PJ não sai', async () => {
    const res = await request(app)
      .get(`/api/v1/core/dashboard?companyId=${PJ}&${PERIODO}`)
      .set(sessaoEm(PESSOA, CONCEITO, 'gerente_loja'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_COMPANY_PROFILE_WITHOUT_ACCESS');
    expect(JSON.stringify(res.body)).not.toContain('50000');
  });

  it('a mesma pessoa, gerente também na Gringa, abre o painel da Gringa (200, os números DELA)', async () => {
    const res = await request(app)
      .get(`/api/v1/core/dashboard?companyId=${GRINGA}&${PERIODO}`)
      .set(sessaoEm(PESSOA, CONCEITO, 'gerente_loja'));
    expect(res.status).toBe(200);
    expect(res.body.revenueCents).toBe(7_000);
  });

  it('o seletor do painel não oferece a operação em que a pessoa é mecânico', async () => {
    const res = await request(app)
      .get(`/api/v1/core/dashboard?${PERIODO}`)
      .set(sessaoEm(PESSOA, CONCEITO, 'gerente_loja'));
    expect(res.status).toBe(200);
    const ids = (res.body.companies as { id: string }[]).map((c) => c.id).sort();
    expect(ids).toEqual([CONCEITO, GRINGA].sort());
  });

  it('com o token da PJ (mecânico) o painel continua 403, como sempre foi', async () => {
    const res = await request(app)
      .get(`/api/v1/core/dashboard?${PERIODO}`)
      .set(sessaoEm(PESSOA, PJ, 'mecanico'));
    expect(res.status).toBe(403);
  });

  it('o gestor com vínculo de gestão nas três vê as três no seletor', async () => {
    const gestor = 'u-gestor';
    sessaoEm(gestor, CONCEITO, 'gestor');
    vincular(gestor, PJ, 'gestor');
    vincular(gestor, GRINGA, 'gestor');
    const res = await request(app)
      .get(`/api/v1/core/dashboard?companyId=${PJ}&${PERIODO}`)
      .set(sessaoEm(gestor, CONCEITO, 'gestor'));
    expect(res.status).toBe(200);
    expect(res.body.revenueCents).toBe(50_000);
    expect((res.body.companies as unknown[]).length).toBe(3);
  });
});

describe('o BI só compara as operações em que a pessoa responde por ele', () => {
  it('/insights/operations não lista a PJ (mecânico lá) e soma só Conceito e Gringa', async () => {
    const res = await request(app)
      .get(`/api/v1/core/insights/operations?${PERIODO}`)
      .set(sessaoEm(PESSOA, CONCEITO, 'gerente_loja'));
    expect(res.status).toBe(200);
    const ids = (res.body.operations as { companyId: string }[]).map((o) => o.companyId).sort();
    expect(ids).toEqual([CONCEITO, GRINGA].sort());
    expect(res.body.totals.revenueCents).toBe(17_000);
  });

  it('as outras três rotas do BI usam a mesma régua — nada da PJ nos produtos, nas marcas e na margem', async () => {
    const auth = sessaoEm(PESSOA, CONCEITO, 'gerente_loja');
    const produtos = await request(app).get(`/api/v1/core/insights/products?${PERIODO}`).set(auth);
    expect(produtos.status).toBe(200);
    expect(JSON.stringify(produtos.body)).not.toContain(PJ);
    expect(JSON.stringify(produtos.body)).toContain(GRINGA);

    const marcas = await request(app).get(`/api/v1/core/insights/brands?${PERIODO}`).set(auth);
    expect(marcas.status).toBe(200);
    expect(JSON.stringify(marcas.body)).not.toContain(PJ);
    expect(JSON.stringify(marcas.body)).toContain(GRINGA);

    const margem = await request(app).get(`/api/v1/core/insights/margin?${PERIODO}`).set(auth);
    expect(margem.status).toBe(200);
    expect(margem.body.revenueCents).toBe(17_000);
  });

  it('estoquista na Gringa não põe a Gringa no BI de quem é gerente na Conceito', async () => {
    vincular(PESSOA, GRINGA, 'estoquista');
    const res = await request(app)
      .get(`/api/v1/core/insights/operations?${PERIODO}`)
      .set(sessaoEm(PESSOA, CONCEITO, 'gerente_loja'));
    expect(res.status).toBe(200);
    const ids = (res.body.operations as { companyId: string }[]).map((o) => o.companyId);
    expect(ids).toEqual([CONCEITO]);
  });

  it('mas o painel (que é do escritório inteiro) abre a Gringa para o estoquista de lá', async () => {
    vincular(PESSOA, GRINGA, 'estoquista');
    const res = await request(app)
      .get(`/api/v1/core/dashboard?companyId=${GRINGA}&${PERIODO}`)
      .set(sessaoEm(PESSOA, CONCEITO, 'gerente_loja'));
    expect(res.status).toBe(200);
  });
});

/**
 * A MESMA RAIZ em duas rotas de dono que também atravessavam pelo vínculo:
 * o certificado do grupo (titular, validade do A1) e a lista de empresas (CNPJ).
 */
describe('as rotas de dono que listam o grupo também seguem o perfil de lá', () => {
  const DONO = 'u-dono-de-uma';

  function donoDaConceitoMecanicoNaPj(): { Authorization: string } {
    const auth = sessaoEm(DONO, CONCEITO, 'gestor');
    vincular(DONO, PJ, 'mecanico');
    vincular(DONO, GRINGA, 'admin_geral');
    return auth;
  }

  it('GET /companies não lista a operação em que o dono é só mecânico', async () => {
    const res = await request(app)
      .get('/api/v1/core/companies')
      .set(donoDaConceitoMecanicoNaPj());
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string }[]).map((c) => c.id).sort();
    expect(ids).toEqual([CONCEITO, GRINGA].sort());
  });

  it('GET /fiscal/certificates/group idem — o A1 da PJ não aparece', async () => {
    const res = await request(app)
      .get('/api/v1/core/fiscal/certificates/group')
      .set(donoDaConceitoMecanicoNaPj());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(PJ);
    expect(JSON.stringify(res.body)).toContain(GRINGA);
  });
});

/**
 * A lista que escolhe as operações do BI é a MESMA do guarda das quatro rotas.
 * O guarda fica por extenso em core.ts (a varredura `o-menu-nao-promete` o lê
 * por AST); este caso é o que impede as duas listas de divergirem.
 */
describe('o guarda do BI e o recorte do BI são a mesma lista', () => {
  it('cada rota de /insights recusa, na sessão, exatamente quem o recorte recusa em outra operação', async () => {
    expect([...PERFIS_QUE_LEEM_O_BI].sort()).toEqual(['gerente_loja', 'gerente_oficina']);
    for (const rota of ['operations', 'products', 'brands', 'margin']) {
      for (const perfil of ['estoquista', 'atendente', 'mecanico', 'operador_caixa_loja']) {
        const res = await request(app)
          .get(`/api/v1/core/insights/${rota}?${PERIODO}`)
          .set(sessaoEm(`u-${perfil}`, CONCEITO, perfil));
        expect(res.status, `${rota} × ${perfil}`).toBe(403);
      }
      for (const perfil of [...PERFIS_QUE_LEEM_O_BI, 'gestor', 'admin_geral']) {
        const res = await request(app)
          .get(`/api/v1/core/insights/${rota}?${PERIODO}`)
          .set(sessaoEm(`u-${perfil}`, CONCEITO, perfil));
        expect(res.status, `${rota} × ${perfil}`).toBe(200);
      }
    }
  });
});
