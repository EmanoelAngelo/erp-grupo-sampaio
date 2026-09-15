/**
 * P0 FISCAL — AS ROTAS NOVAS, PELA CORRENTE INTEIRA (login → token → rota → domínio).
 *
 * Rotas nascem pela capability (a catraca das guardas legadas): reemitir e a
 * NF-e de devolução são da gerência (`fiscal.manage`); ler operações e
 * pendências contábeis também (`fiscal.view`); GRAVAR a operação fiscal é do
 * dono (`fiscal.policy.manage`). O caixa não alcança nenhuma. A empresa vem do
 * token: o gerente de outra operação não reemite a nota desta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { emitNfceForSale } from '../src/services/core/FiscalPipelineService.js';
import { parseSefazResponse, type AuthorizeRequest, type SefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();
const SENHA = 'Teste@RotasFiscais2026';

class RejeitaUmaVez extends SefazTestAdapter {
  private usado = false;

  override async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    if (this.usado) return super.authorize(input);
    this.usado = true;
    return parseSefazResponse({
      body:
        `<retEnviNFe><protNFe><infProt><chNFe>${input.accessKey}</chNFe><cStat>778</cStat>`
        + '<xMotivo>Rejeicao: Informado NCM inexistente</xMotivo></infProt></protNFe></retEnviNFe>',
      correlationId: randomUUID(),
    });
  }
}

const CONSUMIDOR_RS = {
  document: '123.456.789-09',
  name: 'Maria Consumidora',
  ieIndicator: '9',
  street: 'Rua das Flores',
  number: '10',
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '96015000',
};

let empresa: string;
let n = 0;

function configurar(companyId: string): void {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960123456',
      crt: '1',
      street: 'Rua XV de Novembro',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96015000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
}

function venda(): { saleId: string; saleItemId: string; productId: string } {
  ensureCoreSchema();
  n += 1;
  const id = `venda-${n}`;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, empresa, `PJ-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, empresa, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, now);
  return { saleId: id, saleItemId: `i-${id}`, productId: `p-${id}` };
}

/** INSERT que preenche, com valor de teste, as colunas NOT NULL sem padrão que o caso não cita. */
function inserir(tabela: string, valores: Record<string, unknown>): void {
  const db = getConnection();
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all() as unknown as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const linha: Record<string, unknown> = { ...valores };
  for (const c of colunas) {
    if (c.name in linha || c.pk || !c.notnull || c.dflt_value !== null) continue;
    linha[c.name] = c.name.endsWith('_at') ? new Date().toISOString() : /INT|REAL/i.test(c.type) ? 0 : 'teste';
  }
  const nomes = Object.keys(linha);
  db.prepare(`INSERT INTO ${tabela} (${nomes.join(', ')}) VALUES (${nomes.map(() => '?').join(', ')})`).run(
    ...(Object.values(linha) as never[]),
  );
}

async function login(loginName: string, perfil: string, companyId = empresa) {
  const id = await upsertUser({ login: loginName, displayName: loginName, password: SENHA });
  linkUserToCompany(id, companyId, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: loginName, password: SENHA });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(() => {
  resetDbForTests();
  n = 0;
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  configurar(empresa);
});

describe('quem alcança as rotas novas', () => {
  it('operações e pendências: a gerência lê; o caixa não', async () => {
    const gerente = await login('GERPJ', 'gerente_loja');
    const caixa = await login('CAIXAPJ', 'operador_caixa_loja');

    const ops = await request(app).get('/api/v1/core/fiscal/operacoes').set(gerente);
    expect(ops.status).toBe(200);
    expect(ops.body.items.map((o: { operacao: string }) => o.operacao)).toEqual([
      'venda_nfce',
      'venda_nfe',
      'devolucao_venda',
      'devolucao_compra',
    ]);
    const pend = await request(app).get('/api/v1/core/fiscal/pendencias-contabeis').set(gerente);
    expect(pend.status).toBe(200);
    expect(pend.body.items.length).toBeGreaterThan(0);

    expect((await request(app).get('/api/v1/core/fiscal/operacoes').set(caixa)).status).toBe(403);
    expect((await request(app).get('/api/v1/core/fiscal/pendencias-contabeis').set(caixa)).status).toBe(403);
  });

  it('gravar a operação fiscal é do dono, com trilha — o gerente não decide', async () => {
    const gerente = await login('GERPJ2', 'gerente_loja');
    const dono = await login('DONOPJ', 'admin_geral');

    const negado = await request(app)
      .put('/api/v1/core/fiscal/operacoes/devolucao_venda')
      .set(gerente)
      .send({ confirmadaPeloContador: true });
    expect(negado.status).toBe(403);

    const ok = await request(app)
      .put('/api/v1/core/fiscal/operacoes/devolucao_venda')
      .set(dono)
      .send({ confirmadaPeloContador: true, observacao: 'Conferido pelo contador em 15/09' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ operacao: 'devolucao_venda', confirmadaPeloContador: true, origem: 'cadastro' });
    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS c FROM core_audit_log WHERE action = 'fiscal.operation_updated'")
      .get() as { c: number };
    expect(Number(trilha.c)).toBe(1);

    const invalido = await request(app).put('/api/v1/core/fiscal/operacoes/devolucao_venda').set(dono).send({ cfopInterno: '5202' });
    expect(invalido.status).toBe(400);
  });
});

describe('reemitir a rejeitada pela rota', () => {
  it('o gerente reemite com o mesmo número; o caixa não alcança; o gerente de OUTRA operação não acha a nota', async () => {
    const { saleId } = venda();
    const rejeitada = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter: new RejeitaUmaVez() });
    expect(rejeitada.document.status).toBe('REJECTED');

    const caixa = await login('CAIXAPJ3', 'operador_caixa_loja');
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    const gerenteDaOutra = await login('GERGRINGA', 'gerente_loja', outra);
    const gerente = await login('GERPJ3', 'gerente_loja');
    const rota = `/api/v1/core/fiscal/documents/${rejeitada.document.id}/reemitir`;

    expect((await request(app).post(rota).set(caixa).send({ developmentMode: true })).status).toBe(403);
    expect((await request(app).post(rota).set(gerenteDaOutra).send({ developmentMode: true })).status).toBe(404);

    const ok = await request(app).post(rota).set(gerente).send({ developmentMode: true });
    expect(ok.status).toBe(200);
    expect(ok.body.document.status).toBe('AUTHORIZED');
    expect(ok.body.document.number).toBe(rejeitada.document.number);
    expect(ok.body.reemissao.chaveAnterior).toBe(rejeitada.document.accessKey);
  });
});

describe('a NF-e de devolução de venda pela rota', () => {
  it('sai autorizada com finNFe 4; sem destinatário é 400; o caixa não alcança', async () => {
    const v = venda();
    await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    const returnId = `dev-${n}`;
    inserir('core_sale_returns', {
      id: returnId,
      company_id: empresa,
      number: 1,
      sale_id: v.saleId,
      reason: 'Defeito na costura',
      total_cents: 5000,
      refund_method: 'dinheiro',
    });
    inserir('core_sale_return_items', {
      id: `${returnId}-1`,
      return_id: returnId,
      company_id: empresa,
      sale_item_id: v.saleItemId,
      product_id: v.productId,
      quantity: 1,
      unit_price_cents: 5000,
      total_cents: 5000,
      restock: 0,
    });

    const gerente = await login('GERPJ4', 'gerente_loja');
    const caixa = await login('CAIXAPJ4', 'operador_caixa_loja');
    const rota = `/api/v1/core/fiscal/devolucoes/venda/${returnId}/nfe`;

    expect((await request(app).post(rota).set(caixa).send({ recipient: CONSUMIDOR_RS, developmentMode: true })).status).toBe(403);
    expect((await request(app).post(rota).set(gerente).send({ developmentMode: true })).status).toBe(400);

    const ok = await request(app).post(rota).set(gerente).send({ recipient: CONSUMIDOR_RS, developmentMode: true });
    expect(ok.status).toBe(200);
    expect(ok.body.document.status).toBe('AUTHORIZED');
    expect(ok.body.pendencias.length).toBeGreaterThan(0);
    const xml = String(
      (getConnection().prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(ok.body.document.id) as {
        xml_original: string;
      }).xml_original,
    );
    expect(xml).toContain('<finNFe>4</finNFe>');
    expect(xml).toContain('<tpNF>0</tpNF>');
  });
});
