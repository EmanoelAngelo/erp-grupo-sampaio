/**
 * ============================================================================
 * DESATIVADO É DESATIVADO — GAP-PRD-179
 * ============================================================================
 *
 * `revokeCertificate` apagava o `.pfx` cifrado do registro e DEIXAVA a senha
 * selada: depois de "desativar", a senha do A1 do dono continuava no banco,
 * decifrável por quem tivesse a chave do cofre. Metade do segredo apagada é
 * segredo guardado.
 *
 * E o reenvio fazia `{ ...r, ...row }` sobre a linha revogada: o registro
 * voltava a `valid` carregando `revokedAt` e `revokeReason` do certificado
 * ANTERIOR — um válido com carimbo de revogado, histórico misturado no mesmo
 * lugar.
 *
 * O que estes casos cobram:
 *
 *   - revogar apaga arquivo E senha, pelo serviço e pela rota;
 *   - depois de revogado, nada abre o certificado — nem com a senha digitada;
 *   - reenviar limpa os carimbos da revogação e guarda o anterior num
 *     histórico SEM segredo (impressão digital, série, validade, motivo).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { resetDbForTests, findOneRow } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { upsertCertificateA1, getCertificateA1, sanitizeCertificateForResponse } = await import(
  '../src/services/fiscal/FiscalCertificateService.js'
);
const { revokeCertificate, getCertificateView } = await import(
  '../src/services/core/CertificateStatusService.js'
);
const { gerarCertificado } = await import('./helpers/certificado.js');

const app = createApp();
const SENHA = 'senha-do-a1-que-so-o-dono-tem';
const SENHA_LOGIN = 'Revogar@2026';

let pfxAntigo: string;
let pfxNovo: string;
let empresa: string;

beforeAll(() => {
  pfxAntigo = gerarCertificado('PRECO JUSTO ANTIGO:11222333000181', SENHA);
  pfxNovo = gerarCertificado('PRECO JUSTO NOVO:11222333000181', SENHA);
}, 120_000);

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
});

function linhaCrua(): Record<string, unknown> {
  return findOneRow<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === empresa,
  ) as Record<string, unknown>;
}

function textoCruDoBanco(): string {
  const rows = getConnection()
    .prepare('SELECT data FROM fiscal_certificate_references')
    .all() as { data: string }[];
  return rows.map((r) => r.data).join('\n');
}

function carregar(pfx = pfxAntigo): void {
  upsertCertificateA1({
    companyId: empresa,
    operationalUnitId: 'unit-default',
    pfxBase64: pfx,
    password: SENHA,
  });
}

async function dono(): Promise<{ Authorization: string }> {
  const id = await upsertUser({ login: 'DONO.REVOGA', displayName: 'Dono', password: SENHA_LOGIN });
  linkUserToCompany(id, empresa, 'admin_geral', true);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'DONO.REVOGA', password: SENHA_LOGIN });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { Authorization: `Bearer ${login.body.accessToken}` };
}

// ============================================================================

describe('revogar apaga o arquivo E a senha', () => {
  it('pelo serviço: o registro fica sem .pfx e sem senha selada', () => {
    carregar();
    expect(linhaCrua().encryptedPassword).toBeTruthy();

    revokeCertificate({ companyId: empresa, reason: 'Certificado comprometido.' });

    const linha = linhaCrua();
    expect(linha.status).toBe('revoked');
    expect(linha.encryptedPfx).toBeUndefined();
    // O defeito: a senha continuava aqui, decifrável.
    expect(linha.encryptedPassword).toBeUndefined();
    // No banco, nem a CHAVE do campo sobra.
    expect(textoCruDoBanco()).not.toContain('encryptedPassword');
    expect(textoCruDoBanco()).not.toContain('encryptedPfx');
  });

  it('depois de revogado, nada abre o certificado — nem com a senha certa digitada', () => {
    carregar();
    revokeCertificate({ companyId: empresa, reason: 'Troca de certificadora.' });

    expect(() => getCertificateA1(empresa, 'unit-default')).toThrow(
      expect.objectContaining({ code: 'FISCAL_CERTIFICATE_NOT_FOUND' }),
    );
    expect(() => getCertificateA1(empresa, 'unit-default', SENHA)).toThrow(
      expect.objectContaining({ code: 'FISCAL_CERTIFICATE_NOT_FOUND' }),
    );
  });

  it('a tela recebe "não configurado" e "senha não guardada"', () => {
    carregar();
    revokeCertificate({ companyId: empresa, reason: 'Troca de certificadora.' });

    expect(getCertificateView(empresa).configured).toBe(false);
    expect(sanitizeCertificateForResponse(linhaCrua()).senhaGuardada).toBe(false);
  });

  it('pela rota: o cofre fica vazio, e a auditoria registra o motivo sem segredo', async () => {
    carregar();
    const cabecalho = await dono();

    const res = await request(app)
      .post('/api/v1/core/fiscal/certificate/revoke')
      .set(cabecalho)
      .send({ reason: 'Funcionário que tinha a senha saiu da empresa.' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(linhaCrua().encryptedPassword).toBeUndefined();
    expect(linhaCrua().encryptedPfx).toBeUndefined();

    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'fiscal.certificate.revoke'")
      .all() as { detail: string }[];
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].detail).toContain('Funcionário que tinha a senha saiu');
    expect(auditoria[0].detail).not.toContain(SENHA);
  });
});

// ============================================================================

describe('reenviar depois de revogar volta a válido — sem os carimbos do anterior', () => {
  it('o registro volta a valid SEM revokedAt nem revokeReason, e com a senha selada de novo', () => {
    carregar(pfxAntigo);
    revokeCertificate({ companyId: empresa, reason: 'Certificado comprometido.' });

    carregar(pfxNovo);

    const linha = linhaCrua();
    expect(linha.status).toBe('valid');
    // O defeito: o válido carregava o carimbo do revogado.
    expect(linha.revokedAt).toBeUndefined();
    expect(linha.revokeReason).toBeUndefined();
    expect(linha.encryptedPassword).toBeTruthy();
    expect(getCertificateA1(empresa, 'unit-default').subject).toContain('NOVO');
  });

  it('o anterior vai para o histórico: impressão digital, série, validade e o motivo da revogação', () => {
    carregar(pfxAntigo);
    const impressaoAntiga = linhaCrua().fingerprintSha256;
    revokeCertificate({ companyId: empresa, reason: 'Certificado comprometido.' });

    carregar(pfxNovo);

    const historico = linhaCrua().historico as Record<string, unknown>[];
    expect(Array.isArray(historico)).toBe(true);
    expect(historico).toHaveLength(1);
    expect(historico[0]).toMatchObject({
      status: 'revoked',
      fingerprintSha256: impressaoAntiga,
      revokeReason: 'Certificado comprometido.',
    });
    expect(historico[0].revokedAt).toBeTruthy();
    expect(historico[0].replacedAt).toBeTruthy();
    expect(historico[0].validTo).toBeTruthy();
    expect(linhaCrua().fingerprintSha256).not.toBe(impressaoAntiga);
  });

  it('trocar um certificado VÁLIDO por outro também guarda o anterior — sem carimbo de revogação', () => {
    carregar(pfxAntigo);
    const impressaoAntiga = linhaCrua().fingerprintSha256;

    carregar(pfxNovo);

    const historico = linhaCrua().historico as Record<string, unknown>[];
    expect(historico).toHaveLength(1);
    expect(historico[0].status).toBe('valid');
    expect(historico[0].fingerprintSha256).toBe(impressaoAntiga);
    expect(historico[0].revokedAt ?? null).toBeNull();
  });

  it('o histórico não guarda segredo nenhum', () => {
    carregar(pfxAntigo);
    revokeCertificate({ companyId: empresa, reason: 'Troca.' });
    carregar(pfxNovo);
    carregar(pfxAntigo);

    const historico = JSON.stringify(linhaCrua().historico);
    expect(historico).not.toMatch(/encrypted|pfx|password|senha/i);
    expect((linhaCrua().historico as unknown[]).length).toBe(2);
  });
});
