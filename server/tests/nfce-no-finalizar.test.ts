/**
 * ============================================================================
 * A NFC-e NO FINALIZAR — A DECISÃO DO DONO GANHA MECANISMO (GAP-PRD-163)
 * ============================================================================
 *
 * A NFC-e da venda saía só por um clique no painel fiscal do PDV, depois do
 * Finalizar. O painel era honesto, mas o clique esquecido é venda sem nota — e
 * não havia como o dono escolher o contrário. Agora há:
 *
 *   - política por empresa, MANUAL por padrão (o comportamento de sempre) ou
 *     AUTOMATICA; só o dono grava, a gerência lê, e a troca deixa trilha;
 *   - no modo automático, o Finalizar dispara a emissão EM SEGUNDO PLANO,
 *     depois da resposta, e SÓ quando a prontidão DA VENDA está verde — a
 *     mesma régua do botão. Venda não pronta não dispara, e a resposta diz
 *     por quê;
 *   - a falha da emissão nunca derruba a venda: vira trilha;
 *   - o emissor de teste (a suíte não fala com a SEFAZ) não existe em
 *     produção — nem armado, nem se armado antes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import forge from 'node-forge';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { emissionReadinessForSale } from '../src/services/core/FiscalPipelineService.js';
import { upsertNfceCsc } from '../src/services/nfce/NfceCscService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { ApiError } from '../src/utils/errors.js';
import {
  definirEmissorDeTeste,
  emissorEmUso,
} from '../src/services/core/EmissaoNoFinalizar.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const SENHA = 'Teste@NfceNoFinalizar2026';
const SENHA_A1 = 'senha-do-a1-de-teste';

let pfx: string;
let loja: string;
let seq = 0;

/** A1 de teste cujo EMISSOR não é o titular — o autoassinado a prontidão reprova. */
function gerarA1(): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 365);
  cert.setSubject([{ name: 'commonName', value: 'PRECO JUSTO LTDA:11222333000181' }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC CERTIFICADORA FICTICIA v5' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA_A1, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

beforeAll(() => {
  pfx = gerarA1();
});

/** A operação inteira no lugar — com ou sem o certificado. */
function operacao(opcoes: { comCertificado?: boolean } = {}) {
  updateFiscalConfig({
    companyId: loja,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960012345',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010-000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(loja);
  setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
  upsertNfceCsc({
    companyId: loja,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
  if (opcoes.comCertificado !== false) {
    upsertCertificateA1({ companyId: loja, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
  }
}

async function ator(login: string, perfil: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, loja, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId: loja });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

/** Produto classificado (NCM, CFOP, origem), com saldo para vender. */
async function produtoComSaldo(gerente: { Authorization: string }): Promise<string> {
  seq += 1;
  const id = `prod-finalizar-${seq}`;
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Peça de teste', 'UN', 1000, 5000, '87083090', '5102', '0', 1, ?, ?)`,
    )
    .run(id, loja, `FIN-${seq}`, now, now);
  const entrada = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: id,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: `carga-${id}`,
  });
  expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);
  return id;
}

async function vender(auth: { Authorization: string }, productId: string, chave = randomUUID()) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', chave)
    .send({
      items: [{ productId, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
}

function trilha(acao: string): { entity_id: string; detail: string }[] {
  return getConnection()
    .prepare('SELECT entity_id, detail FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(loja, acao) as { entity_id: string; detail: string }[];
}

let chamadas: string[];

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  loja = upsertCompany({ slug: 'preco-justo-finalizar', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  chamadas = [];
  definirEmissorDeTeste(async (e) => {
    chamadas.push(e.saleId);
    return { status: 'QUEUED' };
  });
});

afterEach(() => {
  definirEmissorDeTeste(null);
});

// ---------------------------------------------------------------------------
// A política
// ---------------------------------------------------------------------------

describe('a política — decisão do dono, com padrão seguro', () => {
  it('sem escolha, vale MANUAL — o comportamento de sempre', async () => {
    const gerente = await ator('GERENTE.FIN', 'gerente_loja');
    const res = await request(app).get('/api/v1/core/fiscal/emission-policy').set(gerente);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ modo: 'MANUAL', atualizadoEm: null, atualizadoPor: null });
  });

  it('só o dono grava: a gerência recebe 403, o dono grava com trilha', async () => {
    const gerente = await ator('GERENTE.FIN2', 'gerente_loja');
    const dono = await ator('DONO.FIN', 'admin_geral');

    const recusa = await request(app)
      .put('/api/v1/core/fiscal/emission-policy')
      .set(gerente)
      .send({ modo: 'AUTOMATICA' });
    expect(recusa.status).toBe(403);

    const gravado = await request(app)
      .put('/api/v1/core/fiscal/emission-policy')
      .set(dono)
      .send({ modo: 'AUTOMATICA' });
    expect(gravado.status, JSON.stringify(gravado.body)).toBe(200);
    expect(gravado.body.modo).toBe('AUTOMATICA');
    expect(gravado.body.atualizadoEm).toBeTruthy();

    const lido = await request(app).get('/api/v1/core/fiscal/emission-policy').set(gerente);
    expect(lido.body.modo).toBe('AUTOMATICA');

    const [linha] = trilha('fiscal.emission_policy_updated');
    expect(JSON.parse(linha.detail)).toEqual({ antes: 'MANUAL', depois: 'AUTOMATICA' });
  });

  it('valor fora da lista é recusado com código próprio', async () => {
    const dono = await ator('DONO.FIN2', 'admin_geral');
    const res = await request(app)
      .put('/api/v1/core/fiscal/emission-policy')
      .set(dono)
      .send({ modo: 'sim' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_EMISSION_POLICY_INVALID');
  });

  it('o caixa não lê a política — ele vê o efeito no painel', async () => {
    const caixa = await ator('CAIXA.FIN', 'operador_caixa_loja');
    const res = await request(app).get('/api/v1/core/fiscal/emission-policy').set(caixa);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// O Finalizar
// ---------------------------------------------------------------------------

describe('o Finalizar', () => {
  async function automatica() {
    const dono = await ator(`DONO.${randomUUID().slice(0, 6)}`, 'admin_geral');
    const res = await request(app)
      .put('/api/v1/core/fiscal/emission-policy')
      .set(dono)
      .send({ modo: 'AUTOMATICA' });
    expect(res.status).toBe(200);
  }

  it('MANUAL: a venda diz que nada foi disparado, e nada é disparado', async () => {
    operacao();
    const gerente = await ator('GERENTE.MAN', 'gerente_loja');
    const res = await vender(gerente, await produtoComSaldo(gerente));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.nfceNoFinalizar).toEqual({ modo: 'MANUAL', disparada: false, motivos: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(chamadas).toEqual([]);
  });

  it('AUTOMATICA com a venda pronta: dispara em segundo plano, com a venda certa', async () => {
    operacao();
    const gerente = await ator('GERENTE.AUTO', 'gerente_loja');
    const produto = await produtoComSaldo(gerente);
    await automatica();

    const res = await vender(gerente, produto);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.nfceNoFinalizar).toEqual({ modo: 'AUTOMATICA', disparada: true, motivos: [] });
    // A prontidão que liberou o disparo é a mesma do botão do painel.
    expect(emissionReadinessForSale(loja, res.body.id).canEmit).toBe(true);

    await vi.waitFor(() => expect(chamadas).toEqual([res.body.id]));
    await vi.waitFor(() => expect(trilha('fiscal.nfce_auto_emit')).toHaveLength(1));
    expect(trilha('fiscal.nfce_auto_emit')[0].entity_id).toBe(res.body.id);
  });

  it('AUTOMATICA sem certificado: não dispara, e a resposta diz por quê', async () => {
    operacao({ comCertificado: false });
    const gerente = await ator('GERENTE.SEMCERT', 'gerente_loja');
    const produto = await produtoComSaldo(gerente);
    await automatica();

    const res = await vender(gerente, produto);
    expect(res.status).toBe(201);
    expect(res.body.nfceNoFinalizar.modo).toBe('AUTOMATICA');
    expect(res.body.nfceNoFinalizar.disparada).toBe(false);
    expect(res.body.nfceNoFinalizar.motivos.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(chamadas).toEqual([]);
  });

  it('a falha da emissão não derruba a venda: vira trilha', async () => {
    operacao();
    const gerente = await ator('GERENTE.FALHA', 'gerente_loja');
    const produto = await produtoComSaldo(gerente);
    await automatica();
    definirEmissorDeTeste(async () => {
      throw new ApiError('CORE_SEFAZ_UNAVAILABLE', 'SEFAZ fora do ar.', 503);
    });

    const res = await vender(gerente, produto);
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(trilha('fiscal.nfce_auto_emit_failed')).toHaveLength(1));
    expect(JSON.parse(trilha('fiscal.nfce_auto_emit_failed')[0].detail)).toMatchObject({
      code: 'CORE_SEFAZ_UNAVAILABLE',
    });
    const venda = getConnection().prepare('SELECT status FROM core_sales WHERE id = ?').get(res.body.id);
    expect(venda).toBeDefined();
  });

  it('a venda repetida pela mesma chave não dispara de novo', async () => {
    operacao();
    const gerente = await ator('GERENTE.REPETE', 'gerente_loja');
    const produto = await produtoComSaldo(gerente);
    await automatica();

    const primeira = await vender(gerente, produto, 'mesma-chave');
    const segunda = await vender(gerente, produto, 'mesma-chave');
    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(200);
    expect(segunda.body.nfceNoFinalizar).toBeUndefined();
    await vi.waitFor(() => expect(chamadas).toEqual([primeira.body.id]));
    await new Promise((r) => setTimeout(r, 30));
    expect(chamadas).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A costura de teste não existe em produção
// ---------------------------------------------------------------------------

describe('o emissor de teste não existe em produção', () => {
  const nodeEnvAntes = process.env.NODE_ENV;
  const apiEnvAntes = process.env.DEVORA_API_ENV;

  afterEach(() => {
    process.env.NODE_ENV = nodeEnvAntes;
    if (apiEnvAntes === undefined) delete process.env.DEVORA_API_ENV;
    else process.env.DEVORA_API_ENV = apiEnvAntes;
    resetEnvCacheForTests();
  });

  it('com NODE_ENV=production, armar o emissor de teste é recusado', () => {
    definirEmissorDeTeste(null);
    process.env.NODE_ENV = 'production';
    expect(() => definirEmissorDeTeste(async () => null)).toThrow(/não existe em produção/);
  });

  it('com DEVORA_API_ENV=production, também', () => {
    definirEmissorDeTeste(null);
    /*
      Produção de verdade tem os segredos: sem eles o `loadEnv` recusa o
      processo antes de a costura ser perguntada — e o teste mediria a recusa
      do ambiente, não a da costura.
    */
    const jwtAntes = process.env.DEVORA_JWT_SECRET;
    const chaveAntes = process.env.DEVORA_ENCRYPTION_KEY;
    process.env.DEVORA_JWT_SECRET = 'nfce-no-finalizar-jwt-de-producao-suficientemente-longo-e-unico';
    process.env.DEVORA_ENCRYPTION_KEY = 'nfce-no-finalizar-chave-de-producao-suficientemente-longa-e-unica';
    process.env.DEVORA_API_ENV = 'production';
    resetEnvCacheForTests();
    try {
      expect(() => definirEmissorDeTeste(async () => null)).toThrow(/não existe em produção/);
    } finally {
      if (jwtAntes === undefined) delete process.env.DEVORA_JWT_SECRET;
      else process.env.DEVORA_JWT_SECRET = jwtAntes;
      if (chaveAntes === undefined) delete process.env.DEVORA_ENCRYPTION_KEY;
      else process.env.DEVORA_ENCRYPTION_KEY = chaveAntes;
    }
  });

  it('armado antes, ignorado depois: em produção o Finalizar usa o emissor real', () => {
    expect(emissorEmUso()).toBe('TESTE');
    process.env.NODE_ENV = 'production';
    expect(emissorEmUso()).toBe('REAL');
  });
});
