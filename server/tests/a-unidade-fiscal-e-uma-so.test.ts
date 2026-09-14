/**
 * ============================================================================
 * A UNIDADE FISCAL É UMA SÓ — GAP-PRD-180
 * ============================================================================
 *
 * O upload, o GET e o teste da SEFAZ aceitavam `operationalUnitId` (ou
 * `?unit=`), mas a prontidão, a lista do grupo, o pipeline de emissão, o CSC e
 * o cofre dos atos cravavam `unit-default`. Um certificado enviado com
 * `operationalUnitId: 'loja-2'` respondia 201 "configurado" — e ficava
 * INVISÍVEL para tudo que emite: a prontidão dizia FAIL, o PDV não assinava.
 * As rotas legadas iam além: `/integrations/nfe/secrets` guardava o A1 sob o
 * `storeId` do token (ou o id da empresa), um lugar que o núcleo fiscal nunca
 * lê.
 *
 * Não existe cadastro de unidades operacionais. O contrato honesto (a
 * correção recomendada pela ficha) é: a unidade fiscal é a da operação;
 * pedir outra é RECUSADO com o motivo, em vez de gravar num lugar que ninguém
 * lê. `unit-default` explícito continua aceito — é o mesmo lugar.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import forge from 'node-forge';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { resetDbForTests, findRows } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { upsertCertificateA1 } = await import('../src/services/fiscal/FiscalCertificateService.js');
const { getCertificateView, listGroupCertificates } = await import(
  '../src/services/core/CertificateStatusService.js'
);
const { buildReadiness } = await import('../src/services/core/FiscalConfigService.js');
const { acharCscDaOperacao } = await import('../src/services/nfce/NfceCscService.js');
const { unidadeFiscalDoPedido, UNIDADE_FISCAL } = await import(
  '../src/services/core/UnidadeFiscal.js'
);

const app = createApp();
const SENHA_CERT = 'senha-do-a1';
const SENHA_LOGIN = 'Unidade@2026';

let pfx: string;
let empresa: string;
let dono: { Authorization: string };

beforeAll(() => {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 200 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: 'PRECO JUSTO LTDA:11222333000181' }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC TESTE GRUPO SAMPAIO' }]);
  cert.sign(keys.privateKey);
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA_CERT, { algorithm: '3des' });
  pfx = forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}, 60_000);

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  const id = await upsertUser({ login: 'DONO.UNIDADE', displayName: 'Dono', password: SENHA_LOGIN });
  linkUserToCompany(id, empresa, 'admin_geral', true);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'DONO.UNIDADE', password: SENHA_LOGIN });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  dono = { Authorization: `Bearer ${login.body.accessToken}` };
});

function certificadosGravados(): Record<string, unknown>[] {
  return findRows<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === empresa,
  );
}

function recusaDeUnidade(res: request.Response): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.error.code).toBe('CORE_FISCAL_UNIT_NOT_SUPPORTED');
  // A recusa diz o porquê e o que fazer — não é "payload inválido".
  expect(String(res.body.error.message)).toMatch(/unidade/i);
  expect(String(res.body.error.message)).toMatch(/operação/i);
}

// ============================================================================

describe('a régua única', () => {
  it('ausente, vazio ou unit-default dão a unidade da operação', () => {
    expect(unidadeFiscalDoPedido(undefined)).toBe(UNIDADE_FISCAL);
    expect(unidadeFiscalDoPedido(null)).toBe(UNIDADE_FISCAL);
    expect(unidadeFiscalDoPedido('')).toBe(UNIDADE_FISCAL);
    expect(unidadeFiscalDoPedido('  ')).toBe(UNIDADE_FISCAL);
    expect(unidadeFiscalDoPedido('unit-default')).toBe(UNIDADE_FISCAL);
  });

  it('qualquer outra unidade é recusada — não existe cadastro de unidades', () => {
    expect(() => unidadeFiscalDoPedido('loja-2')).toThrow(
      expect.objectContaining({ code: 'CORE_FISCAL_UNIT_NOT_SUPPORTED', status: 400 }),
    );
  });
});

// ============================================================================

describe('as rotas do núcleo não gravam nem leem sob unidade que ninguém emite', () => {
  it('POST /core/fiscal/certificate com outra unidade: 400 e NADA gravado', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(dono)
      .send({ pfxBase64: pfx, certificatePassword: SENHA_CERT, operationalUnitId: 'loja-2' });

    recusaDeUnidade(res);
    expect(certificadosGravados()).toHaveLength(0);
  });

  it('POST com unit-default explícito continua valendo — e a prontidão e o grupo o enxergam', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(dono)
      .send({ pfxBase64: pfx, certificatePassword: SENHA_CERT, operationalUnitId: 'unit-default' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.configured).toBe(true);
    expect(buildReadiness(empresa, '65').items.find((i) => i.key === 'certificate')?.status).toBe('PASS');
    const [linha] = listGroupCertificates([
      { id: empresa, slug: 'preco-justo', trade_name: 'Preço Justo', legal_name: 'Preço Justo Ltda' },
    ]);
    expect(linha.configured).toBe(true);
  });

  it('GET /core/fiscal/certificate?unit=loja-2 é recusado, em vez de responder "não configurado"', async () => {
    upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_CERT });

    recusaDeUnidade(await request(app).get('/api/v1/core/fiscal/certificate?unit=loja-2').set(dono));

    const padrao = await request(app).get('/api/v1/core/fiscal/certificate').set(dono);
    expect(padrao.status).toBe(200);
    expect(padrao.body.configured).toBe(true);
  });

  it('revogar com outra unidade é recusado — e o certificado da operação continua de pé', async () => {
    upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_CERT });

    recusaDeUnidade(
      await request(app)
        .post('/api/v1/core/fiscal/certificate/revoke')
        .set(dono)
        .send({ reason: 'teste', operationalUnitId: 'loja-2' }),
    );
    expect(getCertificateView(empresa).configured).toBe(true);
  });

  it('o teste da SEFAZ com outra unidade é recusado pelo nome, não por "sem certificado"', async () => {
    upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_CERT });

    recusaDeUnidade(
      await request(app)
        .post('/api/v1/core/fiscal/sefaz/status')
        .set(dono)
        .send({ certificatePassword: SENHA_CERT, operationalUnitId: 'loja-2' }),
    );
  });

  it('o CSC com outra unidade é recusado, e nada vai para o cofre', async () => {
    recusaDeUnidade(
      await request(app)
        .post('/api/v1/core/fiscal/nfce/csc')
        .set(dono)
        .set('Idempotency-Key', 'csc-loja-2')
        .send({ cscId: '000001', cscToken: 'TOKEN-X', operationalUnitId: 'loja-2' }),
    );
    expect(findRows('nfce_settings', (r) => r.companyId === empresa)).toHaveLength(0);
  });
});

// ============================================================================

describe('as rotas legadas gravam onde o núcleo lê', () => {
  it('POST /fiscal/certificates saiu do ar (GAP-PRD-096): 404 e nada gravado', async () => {
    // O A1 entra por `/core/fiscal/certificate`, que confere a unidade (acima).
    const res = await request(app)
      .post('/api/v1/fiscal/certificates')
      .set(dono)
      .set('Idempotency-Key', 'cert-legado-loja-2')
      .send({ pfxBase64: pfx, certificatePassword: SENHA_CERT, operationalUnitId: 'loja-2' });
    expect(res.status).toBe(404);
    expect(certificadosGravados()).toHaveLength(0);
  });

  /*
    `/integrations/nfe/secrets` e `/integrations/nfce/secrets` eram a segunda
    porta do A1 e do CSC — e a primeira a gravar fora da unidade que o núcleo
    lê. Saíram com o roteador `/integrations`, que nenhuma tela chamava
    (GAP-PRD-075): o A1 entra por `/core/fiscal/certificate` e o CSC pela rota
    do CSC da tela Fiscal, as duas cobertas acima.
  */
  it('as portas de /integrations saíram: 404, e nem A1 nem CSC gravados por elas', async () => {
    const a1 = await request(app)
      .post('/api/v1/integrations/nfe/secrets')
      .set(dono)
      .send({ pfxBase64: pfx, password: SENHA_CERT });
    const csc = await request(app)
      .post('/api/v1/integrations/nfce/secrets')
      .set(dono)
      .send({ cscId: '000001', cscToken: 'TOKEN-DA-HOMOLOGACAO' });

    expect(a1.status).toBe(404);
    expect(csc.status).toBe(404);
    expect(certificadosGravados()).toHaveLength(0);
    expect(acharCscDaOperacao(empresa, 'unit-default', 'homologation')).toBeNull();
  });
});
