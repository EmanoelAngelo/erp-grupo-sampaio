/**
 * ============================================================================
 * UM CSC PARA CADA AMBIENTE — GAP-PRD-022
 * ============================================================================
 *
 * A SEFAZ emite um CSC para homologação e OUTRO para produção. O sistema
 * guardava um só por unidade, sem conferir o ambiente:
 *
 *   - depois da virada para produção, o QR do cupom saía assinado com o CSC de
 *     TESTE (hash que o portal não confere), e a prontidão dizia CONFIGURADO;
 *   - gravar o de produção dava 403 "Produção NFC-e bloqueada" enquanto a
 *     variável NFCE_PRODUCTION_ENABLED não estivesse ligada no servidor — o dia
 *     da virada exigia variável de ambiente e reinício, isto é, chamar o
 *     desenvolvedor;
 *   - e gravar o de produção APAGAVA o de homologação (um slot só).
 *
 * O que estes casos cobram: dois slots por operação (um por ambiente); a
 * montagem usa o do ambiente da operação e recusa, nomeando os dois, quando só
 * existe o outro — antes de numerar; a prontidão diz DIVERGENTE nesse caso; e o
 * CSC de produção pode ser gravado a qualquer momento, sem variável de
 * ambiente — quem protege a produção é o desbloqueio auditado da operação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';
// A variável que o dia da virada exigia. Desligada de propósito: o CSC de
// produção tem de poder ser gravado sem ela.
delete process.env.NFCE_PRODUCTION_ENABLED;

const { createApp } = await import('../src/app.js');
const { resetDbForTests, findRows } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { updateFiscalConfig, buildReadiness, getFiscalConfig } = await import(
  '../src/services/core/FiscalConfigService.js'
);
const { upsertNfceCsc, acharCscDaOperacao, cscsDaOperacao } = await import(
  '../src/services/nfce/NfceCscService.js'
);
const { buildNfceXml, conferirExigenciasDaMontagem, exigirCscDaOperacao } = await import(
  '../src/services/core/FiscalXmlNfce.js'
);
const { grupoTributarioPadrao } = await import('./helpers/grupoTributario.js');
type NfceSale = import('../src/services/core/FiscalXmlNfce.js').NfceSale;

const app = createApp();
const SENHA_LOGIN = 'Csc@Ambiente2026';
/** O token que o helper do grupo tributário grava — o de homologação. */
const TOKEN_HOMOLOGACAO = 'CSC-DE-TESTE-NAO-E-O-REAL';
const TOKEN_PRODUCAO = 'CSC-DE-PRODUCAO-QUE-VALE';

let empresa: string;

const CONFIG_COMPLETA = {
  legalName: 'Preço Justo Comércio Ltda',
  tradeName: 'Preço Justo',
  cnpj: '11.222.333/0001-81',
  ie: '123456789',
  crt: '1',
  zip: '96010-000',
  street: 'Rua Marechal Floriano',
  number: '38',
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
};

function venda(): NfceSale {
  return {
    id: 'sale-1',
    number: 1,
    companyId: empresa,
    createdAt: '2026-09-11T12:00:00.000Z',
    subtotalCents: 10_000,
    discountCents: 0,
    surchargeCents: 0,
    totalCents: 10_000,
    changeCents: 0,
    customerId: null,
    customerDocument: null,
    customerName: null,
    items: [
      {
        productId: 'p1',
        description: 'Camisa Social',
        quantity: 2,
        unitPriceCents: 5_000,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 10_000,
        ncm: '62052000',
        cest: null,
        cfop: '5102',
        origin: '0',
        unit: 'UN',
        barcode: '7891234567895',
        internalCode: 'GS-0001',
      },
    ],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
  };
}

/**
 * Leva a operação a produção por baixo — o desbloqueio real exige uma
 * autorização da SEFAZ de homologação, que não existe aqui. Os casos querem
 * saber o que acontece DEPOIS da virada, não como se vira.
 */
function operacaoEmProducao(): void {
  getConnection()
    .prepare(
      `UPDATE core_fiscal_configs
          SET environment = 'production', production_unlocked = 1
        WHERE company_id = ?`,
    )
    .run(empresa);
}

function gravarProducao(): void {
  upsertNfceCsc({
    companyId: empresa,
    operationalUnitId: 'unit-default',
    cscId: '000002',
    cscToken: TOKEN_PRODUCAO,
    environment: 'production',
  });
}

function itemCsc() {
  return buildReadiness(empresa, '65').items.find((i) => i.key === 'csc')!;
}

/** O `p=` do QR: chave|versão|tpAmb|idToken|hash. */
function partesDoQr(xml: string): string[] {
  const url = /<qrCode><!\[CDATA\[([^\]]+)\]\]><\/qrCode>/.exec(xml)?.[1] ?? '';
  return (new URL(url).searchParams.get('p') ?? '').split('|');
}

function hashEsperado(chave: string, tpAmb: string, idToken: string, token: string): string {
  return createHash('sha1')
    .update(`${chave}|2|${tpAmb}|${idToken}${token}`)
    .digest('hex')
    .toUpperCase();
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  updateFiscalConfig({ companyId: empresa, patch: CONFIG_COMPLETA });
  // Grupo tributário e o CSC de HOMOLOGAÇÃO (000001).
  grupoTributarioPadrao(empresa);
});

// ============================================================================

describe('dois slots: um CSC por ambiente', () => {
  it('gravar o de produção NÃO apaga o de homologação', () => {
    gravarProducao();

    expect(acharCscDaOperacao(empresa, 'unit-default', 'homologation')).toEqual({
      cscId: '000001',
      cscToken: TOKEN_HOMOLOGACAO,
    });
    expect(acharCscDaOperacao(empresa, 'unit-default', 'production')).toEqual({
      cscId: '000002',
      cscToken: TOKEN_PRODUCAO,
    });
    expect(findRows('nfce_settings', (r) => r.companyId === empresa)).toHaveLength(2);
  });

  it('o CSC de produção é gravado sem variável de ambiente nem reinício', () => {
    // Era 403 "Produção NFC-e bloqueada." com NFCE_PRODUCTION_ENABLED desligada.
    expect(() => gravarProducao()).not.toThrow();
  });

  it('regravar o mesmo ambiente substitui — sem criar uma terceira linha', () => {
    gravarProducao();
    upsertNfceCsc({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      cscId: '000003',
      cscToken: 'CSC-DE-PRODUCAO-NOVO',
      environment: 'production',
    });

    expect(findRows('nfce_settings', (r) => r.companyId === empresa)).toHaveLength(2);
    expect(acharCscDaOperacao(empresa, 'unit-default', 'production')?.cscId).toBe('000003');
    expect(acharCscDaOperacao(empresa, 'unit-default', 'homologation')?.cscId).toBe('000001');
  });

  it('o resumo por ambiente diz o que existe — sem o token', () => {
    gravarProducao();
    const resumo = cscsDaOperacao(empresa);
    expect(resumo.homologation?.cscId).toBe('000001');
    expect(resumo.production?.cscId).toBe('000002');
    expect(JSON.stringify(resumo)).not.toContain(TOKEN_PRODUCAO);
    expect(JSON.stringify(resumo)).not.toContain(TOKEN_HOMOLOGACAO);
  });

  it('registro antigo, gravado sem o campo environment, vale como homologação', () => {
    getConnection()
      .prepare("UPDATE nfce_settings SET data = json_remove(data, '$.environment')")
      .run();

    expect(acharCscDaOperacao(empresa, 'unit-default', 'homologation')?.cscId).toBe('000001');
    expect(acharCscDaOperacao(empresa, 'unit-default', 'production')).toBeNull();
  });

  it('ambiente que não existe é recusado', () => {
    expect(() =>
      upsertNfceCsc({
        companyId: empresa,
        operationalUnitId: 'unit-default',
        cscId: '000009',
        cscToken: 'X',
        environment: 'contingencia' as never,
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
});

// ============================================================================

describe('a montagem usa o CSC do ambiente da operação', () => {
  it('operação em PRODUÇÃO com só o CSC de homologação: recusa nomeando os dois ambientes', () => {
    operacaoEmProducao();

    let erro: { code?: string; message?: string; details?: Record<string, unknown> } = {};
    try {
      exigirCscDaOperacao(empresa, 'production');
    } catch (e) {
      erro = e as typeof erro;
    }
    expect(erro.code).toBe('NFCE_CSC_REQUIRED');
    expect(erro.message).toMatch(/produção/);
    expect(erro.message).toMatch(/homologação/);
    // O ID de teste aparece — é o que separa "não tem" de "tem o errado".
    expect(erro.message).toContain('000001');
  });

  it('e a recusa vem ANTES de numerar — na pré-validação da montagem', () => {
    operacaoEmProducao();
    expect(() => conferirExigenciasDaMontagem(venda(), 'production')).toThrow(
      expect.objectContaining({ code: 'NFCE_CSC_REQUIRED' }),
    );
  });

  it('o QR do cupom de PRODUÇÃO é assinado com o CSC de produção (tpAmb 1, idToken 2)', () => {
    gravarProducao();
    operacaoEmProducao();
    const config = getFiscalConfig(empresa);
    expect(config.environment).toBe('production');

    const { xml, accessKey } = buildNfceXml({ sale: venda(), config, serie: 1, number: 1 });
    const [chave, versao, tpAmb, idToken, hash] = partesDoQr(xml);

    expect(chave).toBe(accessKey);
    expect(versao).toBe('2');
    expect(tpAmb).toBe('1');
    expect(idToken).toBe('2');
    // O defeito: o hash saía com o token de teste.
    expect(hash).toBe(hashEsperado(accessKey, '1', '2', TOKEN_PRODUCAO));
    expect(hash).not.toBe(hashEsperado(accessKey, '1', '1', TOKEN_HOMOLOGACAO));
  });

  it('e o de HOMOLOGAÇÃO continua com o de homologação, mesmo com o de produção já gravado', () => {
    gravarProducao();
    const config = getFiscalConfig(empresa);

    const { xml, accessKey } = buildNfceXml({ sale: venda(), config, serie: 1, number: 1 });
    const [, , tpAmb, idToken, hash] = partesDoQr(xml);

    expect(tpAmb).toBe('2');
    expect(idToken).toBe('1');
    expect(hash).toBe(hashEsperado(accessKey, '2', '1', TOKEN_HOMOLOGACAO));
  });
});

// ============================================================================

describe('a prontidão confere o ambiente', () => {
  it('produção com só o de homologação: FAIL, DIVERGENTE, e o detalhe manda gravar o de produção', () => {
    operacaoEmProducao();
    const csc = itemCsc();

    // O defeito: PASS sem detalhe, com o CSC de teste.
    expect(csc.status).toBe('FAIL');
    expect(csc.state).toBe('DIVERGENTE');
    expect(csc.owner).toBe('dono');
    expect(csc.detail).toMatch(/produção/);
    expect(csc.detail).toMatch(/homologação/);
    expect(csc.known).toMatch(/000001/);
  });

  it('produção com o de produção: PASS, e o known diz qual está em uso', () => {
    gravarProducao();
    operacaoEmProducao();
    const csc = itemCsc();

    expect(csc.status).toBe('PASS');
    expect(csc.known).toMatch(/000002/);
    expect(csc.known).toMatch(/produção/);
  });

  it('homologação sem o de produção: PASS — com o aviso de que a virada vai precisar dele', () => {
    const csc = itemCsc();

    expect(csc.status).toBe('PASS');
    expect(csc.known).toMatch(/000001/);
    expect(csc.detail).toMatch(/produção/);
  });

  it('homologação com os dois: PASS sem aviso', () => {
    gravarProducao();
    const csc = itemCsc();

    expect(csc.status).toBe('PASS');
    expect(csc.detail).toBeNull();
  });
});

// ============================================================================

describe('pela rota', () => {
  async function dono(): Promise<{ Authorization: string }> {
    const id = await upsertUser({ login: 'DONO.CSC', displayName: 'Dono', password: SENHA_LOGIN });
    linkUserToCompany(id, empresa, 'admin_geral', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'DONO.CSC', password: SENHA_LOGIN });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    return { Authorization: `Bearer ${login.body.accessToken}` };
  }

  it('POST do CSC de produção: 201, os dois aparecem no GET, e a auditoria registra sem o token', async () => {
    const cabecalho = await dono();

    const res = await request(app)
      .post('/api/v1/core/fiscal/nfce/csc')
      .set(cabecalho)
      .set('Idempotency-Key', 'csc-producao-1')
      .send({ cscId: '000002', cscToken: TOKEN_PRODUCAO, environment: 'production' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.environment).toBe('production');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_PRODUCAO);

    const lista = await request(app).get('/api/v1/core/fiscal/nfce/csc').set(cabecalho);
    expect(lista.status).toBe(200);
    const ambientes = (lista.body.items as { environment: string; cscId: string }[])
      .map((i) => `${i.environment}:${i.cscId}`)
      .sort();
    expect(ambientes).toEqual(['homologation:000001', 'production:000002']);

    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'fiscal.nfce_csc.upsert'")
      .all() as { detail: string }[];
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].detail).toContain('production');
    expect(auditoria[0].detail).toContain('000002');
    expect(auditoria[0].detail).not.toContain(TOKEN_PRODUCAO);
  });
});
