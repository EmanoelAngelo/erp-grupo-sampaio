/**
 * ============================================================================
 * O CERTIFICADO A1 NA PORTA DE ENTRADA — auditoria P0 da Preço Justo
 * ============================================================================
 *
 * O envio do A1 mora no painel administrativo (POST /core/fiscal/certificate),
 * e a auditoria P0 pediu a porta inteira coberta pelo HTTP, não só pelo
 * serviço: arquivo bom, senha errada, arquivo que não é .pfx, certificado
 * vencido, CNPJ de outra raiz, e quem pode e quem não pode enviar ou ler.
 *
 * E o que nunca pode sair: a senha e o arquivo não aparecem na resposta, na
 * trilha de auditoria nem no log do servidor — em nenhum dos desfechos, o de
 * sucesso incluído.
 *
 * Tudo com certificados FICTÍCIOS gerados aqui; nenhuma credencial real.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import forge from 'node-forge';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { findRows, resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';

const app = createApp();
const SENHA_A1 = 'senha-ficticia-do-a1-P0';
const SENHA_LOGIN = 'Teste@PortaDoA1-2026';
const CNPJ_DA_LOJA = '11222333000181';
const DIA = 86_400_000;

function gerarA1(cnpj: string, validade: { de: number; ate: number } = { de: -DIA, ate: 365 * DIA }): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '07';
  cert.validity.notBefore = new Date(Date.now() + validade.de);
  cert.validity.notAfter = new Date(Date.now() + validade.ate);
  cert.setSubject([{ name: 'commonName', value: `LOJA FICTICIA LTDA:${cnpj}` }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC CERTIFICADORA FICTICIA v5' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA_A1, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

let a1Bom: string;
let a1Vencido: string;
let a1DeOutraRaiz: string;
let loja: string;
let gestor: { Authorization: string };
let saidaDoServidor: string[];

beforeAll(() => {
  a1Bom = gerarA1(CNPJ_DA_LOJA);
  a1Vencido = gerarA1(CNPJ_DA_LOJA, { de: -400 * DIA, ate: -DIA });
  a1DeOutraRaiz = gerarA1('11444777000161');
}, 180_000);

async function entrar(login: string, perfil: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA_LOGIN });
  linkUserToCompany(userId, loja, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA_LOGIN });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function enviar(quem: { Authorization: string }, pfxBase64: string, certificatePassword = SENHA_A1) {
  return request(app).post('/api/v1/core/fiscal/certificate').set(quem).send({ pfxBase64, certificatePassword });
}

function certificadosDaLoja() {
  return findRows<Record<string, unknown>>('fiscal_certificate_references', (r) => r.companyId === loja);
}

/** A trilha inteira da operação, como texto — é nela que o segredo não pode estar. */
function trilha(): string {
  return JSON.stringify(
    getConnection().prepare('SELECT action, detail FROM core_audit_log WHERE company_id = ?').all(loja),
  );
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({ companyId: loja, patch: { cnpj: CNPJ_DA_LOJA, uf: 'RS' } });
  gestor = await entrar('GESTORA1P0', 'gestor');

  // O log do servidor, capturado: a senha não pode passar por ele.
  saidaDoServidor = [];
  const guardar = (...partes: unknown[]) => {
    saidaDoServidor.push(partes.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
  };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    guardar(String(chunk));
    return true;
  });
  for (const nivel of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, nivel).mockImplementation(guardar);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function semSegredo(...textos: string[]) {
  const tudo = [...textos, trilha(), ...saidaDoServidor].join('\n');
  expect(tudo).not.toContain(SENHA_A1);
  expect(tudo).not.toContain(a1Bom.slice(0, 80));
  expect(tudo).not.toMatch(/encryptedPfx|encryptedPassword|keyPem|PRIVATE KEY/);
}

describe('o envio do A1 pela rota do painel administrativo', () => {
  it('arquivo bom: 201, o cartão se preenche sozinho, a senha fica selada — e nada de segredo sai', async () => {
    const res = await enviar(gestor, a1Bom);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.configured).toBe(true);
    expect(res.body.certificate.documentNumber).toBe(CNPJ_DA_LOJA);
    expect(res.body.certificate.cnpjConference).toBe('conferido');
    expect(res.body.certificate.senhaGuardada).toBe(true);
    expect(certificadosDaLoja()).toHaveLength(1);
    // A trilha registra QUE houve troca, com metadado seguro.
    expect(trilha()).toContain('fiscal.certificate.upsert');
    semSegredo(JSON.stringify(res.body));
  });

  it('senha errada: 400, e nada é gravado', async () => {
    const res = await enviar(gestor, a1Bom, 'senha-que-nao-e');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_PASSWORD_INVALID');
    expect(certificadosDaLoja()).toHaveLength(0);
    semSegredo(JSON.stringify(res.body));
    expect(JSON.stringify(res.body)).not.toContain('senha-que-nao-e');
  });

  it('arquivo que não é .pfx: 400 com motivo, e nada é gravado', async () => {
    const res = await enviar(gestor, Buffer.from('isto não é um certificado').toString('base64'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_INVALID');
    expect(certificadosDaLoja()).toHaveLength(0);
  });

  it('sem arquivo ou sem senha: 400 pedindo os dois', async () => {
    const semSenha = await enviar(gestor, a1Bom, '');
    expect(semSenha.status).toBe(400);
    expect(semSenha.body.error.code).toBe('FISCAL_CERTIFICATE_CREDENTIALS_REQUIRED');
    const semArquivo = await enviar(gestor, '');
    expect(semArquivo.status).toBe(400);
    expect(certificadosDaLoja()).toHaveLength(0);
  });

  it('certificado vencido: 400 e nada gravado — vencido não assina nota', async () => {
    const res = await enviar(gestor, a1Vencido);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_EXPIRED');
    expect(certificadosDaLoja()).toHaveLength(0);
  });

  it('CNPJ de outra raiz: 400 dizendo os dois números, e nada gravado', async () => {
    const res = await enviar(gestor, a1DeOutraRaiz);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_CNPJ_MISMATCH');
    expect(res.body.error.message).toMatch(/11\.444\.777\/0001-61/);
    expect(certificadosDaLoja()).toHaveLength(0);
  });

  it('a renovação troca o arquivo e guarda o anterior no histórico, sem segredo', async () => {
    expect((await enviar(gestor, a1Bom)).status).toBe(201);
    const novo = gerarA1(CNPJ_DA_LOJA, { de: -DIA, ate: 700 * DIA });
    expect((await enviar(gestor, novo)).status).toBe(201);

    const [linha] = certificadosDaLoja();
    expect(Array.isArray(linha.historico)).toBe(true);
    expect((linha.historico as unknown[]).length).toBe(1);
    expect(JSON.stringify(linha.historico)).not.toMatch(/encrypted|keyPem/);
  });
});

describe('quem envia e quem lê o A1', () => {
  it('o operador de caixa não envia nem lê o certificado — o PDV só consulta o resumo', async () => {
    const caixa = await entrar('CAIXAA1P0', 'operador_caixa_loja');
    expect((await enviar(caixa, a1Bom)).status).toBe(403);
    expect((await request(app).get('/api/v1/core/fiscal/certificate').set(caixa)).status).toBe(403);
    expect(certificadosDaLoja()).toHaveLength(0);

    // O que o caixa alcança é o resumo, sem nada do certificado.
    const resumo = await request(app).get('/api/v1/core/fiscal/pdv-summary').set(caixa);
    expect(resumo.status).toBe(200);
  });

  it('o gerente da loja também não envia: o A1 assina em nome da empresa', async () => {
    const gerente = await entrar('GERENTEA1P0', 'gerente_loja');
    expect((await enviar(gerente, a1Bom)).status).toBe(403);
    expect(certificadosDaLoja()).toHaveLength(0);
  });

  it('a leitura do gestor devolve o cartão, nunca o arquivo nem a senha', async () => {
    await enviar(gestor, a1Bom);
    const res = await request(app).get('/api/v1/core/fiscal/certificate').set(gestor);
    expect(res.status).toBe(200);
    expect(res.body.certificate.senhaGuardada).toBe(true);
    semSegredo(JSON.stringify(res.body));
  });
});
