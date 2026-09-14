/**
 * ============================================================================
 * O CERTIFICADO SEM A SENHA NO COFRE — GAP-PRD-023
 * ============================================================================
 *
 * O A1 real da Preço Justo (banco da loja, conferido em modo somente leitura
 * pela auditoria) foi gravado antes de a senha passar a ser selada: tem
 * `encryptedPfx`, não tem `encryptedPassword`, nem titular, tipo de documento,
 * conferência de CNPJ ou tamanho da cadeia. O PDV pararia em
 * FISCAL_CERTIFICATE_PASSWORD_REQUIRED — e a prontidão dizia "Certificado A1:
 * PASS", AUTO_DETECTADO, sem uma palavra sobre a senha.
 *
 * O conserto do DONO é externo e não exige código: reenviar o mesmo .pfx com a
 * senha em Fiscal › Certificado. O que é código, e estes casos cobram, é o
 * sistema DIZER isso antes da venda:
 *
 *   - o item `certificate` deixa de ser PASS mudo: FAIL, PENDENTE, dono, com a
 *     instrução do reenvio — nos dois modelos;
 *   - a prontidão não se diz PRONTA PARA HOMOLOGAÇÃO com esse certificado;
 *   - o reenvio pelo caminho de sempre resolve tudo: sela a senha, preenche o
 *     cartão, confere o CNPJ e devolve o item a PASS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests, findOneRow } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig, buildReadiness } = await import(
  '../src/services/core/FiscalConfigService.js'
);
const { upsertCertificateA1 } = await import('../src/services/fiscal/FiscalCertificateService.js');
const { listGroupCertificates } = await import('../src/services/core/CertificateStatusService.js');
const { gerarCertificado } = await import('./helpers/certificado.js');

const SENHA = 'senha-do-a1-da-preco-justo';
const CNPJ = '11222333000181';

let pfx: string;
let empresa: string;

beforeAll(() => {
  pfx = gerarCertificado(`PRECO JUSTO COMERCIO LTDA:${CNPJ}`, SENHA);
}, 120_000);

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ, uf: 'RS' } });
});

function enviar(): void {
  upsertCertificateA1({
    companyId: empresa,
    operationalUnitId: 'unit-default',
    pfxBase64: pfx,
    password: SENHA,
  });
}

/**
 * O registro como está no banco da loja: gravado antes da autodetecção e antes
 * da senha selada. Os campos saem do JSON como nunca existiram lá.
 */
function estadoRealDoDono(): void {
  enviar();
  getConnection()
    .prepare(
      `UPDATE fiscal_certificate_references
          SET data = json_remove(data, '$.encryptedPassword', '$.holderName', '$.documentType',
                                 '$.documentNumber', '$.cnpjConference', '$.chainLength',
                                 '$.selfSigned', '$.fingerprintSha256')`,
    )
    .run();
}

function itemDoCertificado(model = '65') {
  return buildReadiness(empresa, model).items.find((i) => i.key === 'certificate')!;
}

function linhaCrua(): Record<string, unknown> {
  return findOneRow<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === empresa,
  ) as Record<string, unknown>;
}

// ============================================================================

describe('a prontidão enxerga a senha que falta', () => {
  it('o registro real do dono: o item não é PASS mudo — diz que a senha não está selada e manda reenviar', () => {
    estadoRealDoDono();
    const item = itemDoCertificado();

    // O defeito: PASS, AUTO_DETECTADO, detail null.
    expect(item.status).toBe('FAIL');
    expect(item.state).toBe('PENDENTE');
    expect(item.owner).toBe('dono');
    expect(item.detail).toMatch(/senha/i);
    expect(item.detail).toMatch(/[Rr]eenvie/);
    expect(item.detail).toMatch(/Fiscal › Certificado/);
    // O arquivo existe e se apresentou: o que se sabe dele continua dito.
    expect(item.known).toContain('PRECO JUSTO');
    expect(item.source).toBe('certificado');
  });

  it('a NF-e diz o mesmo — o certificado é um só para os dois modelos', () => {
    estadoRealDoDono();
    const item = itemDoCertificado('55');
    expect(item.status).toBe('FAIL');
    expect(item.detail).toMatch(/[Rr]eenvie/);
  });

  it('com esse certificado, a operação não se diz pronta para a homologação', () => {
    estadoRealDoDono();
    const relatorio = buildReadiness(empresa, '65');

    expect(relatorio.readiness).toBe('READY_FOR_CERTIFICATE');
    expect(relatorio.blockingReasons.join(' | ')).toMatch(/Certificado A1: .*senha/i);
  });

  it('a lista do grupo diz que a senha não está guardada — booleano, nunca a senha', () => {
    estadoRealDoDono();
    const [linha] = listGroupCertificates([
      { id: empresa, slug: 'preco-justo', trade_name: 'Preço Justo', legal_name: 'Preço Justo Ltda' },
    ]);
    expect(linha.configured).toBe(true);
    expect(linha.senhaGuardada).toBe(false);
    expect(JSON.stringify(linha)).not.toContain(SENHA);
  });
});

// ============================================================================

describe('o reenvio resolve sem código', () => {
  it('reenviar o mesmo .pfx com a senha sela a senha, preenche o cartão, confere o CNPJ e devolve o PASS', () => {
    estadoRealDoDono();
    expect(itemDoCertificado().status).toBe('FAIL');

    enviar();

    const linha = linhaCrua();
    expect(linha.encryptedPassword).toBeTruthy();
    expect(linha.holderName).toBe('PRECO JUSTO COMERCIO LTDA');
    expect(linha.documentType).toBe('CNPJ');
    expect(linha.cnpjConference).toBe('conferido');
    expect(linha.chainLength).toBe(1);

    const item = itemDoCertificado();
    expect(item.status).toBe('PASS');
    expect(item.detail).toBeNull();
    expect(item.state).toBe('AUTO_DETECTADO');
  });
});
