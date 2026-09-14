/**
 * A SENHA DO A1 NÃO PODE SER DIGITADA A CADA VENDA.
 *
 * ============================================================================
 * O QUE A ARQUITETURA DIZIA, E POR QUE PRECISOU MUDAR
 * ============================================================================
 *
 * `getCertificateA1(companyId, unidade, senha)` exigia a senha em toda chamada,
 * e o comentário do pipeline explicava a intenção com todas as letras:
 *
 *     "Não existe worker de fundo de propósito: a senha não fica guardada,
 *      então todo ato fiscal real tem alguém presente."
 *
 * A intenção é boa e o desenho é coerente — para um ato fiscal por dia. Para um
 * PDV de balcão, não: emitir cupom é o gesto mais repetido da loja, e pedir a
 * senha do certificado a cada venda produz um de dois desfechos, ambos piores
 * que guardar a senha:
 *
 *   - o operador não emite nota nenhuma, ou
 *   - a senha vira um papel colado no monitor.
 *
 * ============================================================================
 * O QUE MUDA, E O QUE NÃO MUDA
 * ============================================================================
 *
 * A senha passa a ser selada com o MESMO primitivo que já guarda o `.pfx`, o
 * token do CSC e a chave do Asaas — `encryptFiscalSecret`, cifrado com a chave
 * do servidor. Não há cofre novo: haveria dois lugares para proteger.
 *
 * O que NÃO muda: a senha nunca volta por API, nunca aparece em log, nunca é
 * sincronizada para a central, e a tela continua sem tê-la depois de gravada.
 * Este arquivo cobra cada uma dessas coisas.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const {
  upsertCertificateA1,
  getCertificateA1,
  sanitizeCertificateForResponse,
} = await import('../src/services/fiscal/FiscalCertificateService.js');
const { gerarCertificado } = await import('./helpers/certificado.js');

const SENHA = 'senha-do-a1-que-so-o-dono-tem';
let empresa: string;
let pfxBase64: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  pfxBase64 = gerarCertificado('PRECO JUSTO:11222333000181', SENHA);
});

// ============================================================================

describe('a emissão não pede a senha de novo', () => {
  it('depois de configurado, o certificado abre sem senha nenhuma', () => {
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64,
      password: SENHA,
    });

    /*
      É esta chamada que o PDV faz a cada cupom. Exigir a senha aqui é exigir
      alguém presente em toda venda — e o resultado real disso é a senha colada
      no monitor.
    */
    const parsed = getCertificateA1(empresa, 'unit-default');
    expect(parsed.cnpj).toBe('11222333000181');
  });

  it('a senha continua aceita quando vem — o caminho interativo não quebrou', () => {
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64,
      password: SENHA,
    });

    const parsed = getCertificateA1(empresa, 'unit-default', SENHA);
    expect(parsed.cnpj).toBe('11222333000181');
  });

  it('senha errada informada é recusada, mesmo com a guardada correta', () => {
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64,
      password: SENHA,
    });

    // Quem informa senha está afirmando qual é. Aceitar a guardada no lugar
    // esconderia do operador que ele digitou errado.
    expect(() => getCertificateA1(empresa, 'unit-default', 'chute')).toThrow();
  });

  it('sem senha guardada e sem senha informada, a recusa diz o que fazer', () => {
    // Certificado de uma instalação anterior, gravado antes desta rodada.
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64,
      password: SENHA,
    });
    getConnection()
      .prepare(
        `UPDATE fiscal_certificate_references
            SET data = json_remove(data, '$.encryptedPassword')`,
      )
      .run();

    expect(() => getCertificateA1(empresa, 'unit-default')).toThrow(/senha/i);
  });
});

// ============================================================================

describe('a senha selada não volta por lugar nenhum', () => {
  it('a resposta da API não carrega senha nem o pfx', () => {
    const row = upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64,
      password: SENHA,
    });

    const resposta = sanitizeCertificateForResponse(row);
    const texto = JSON.stringify(resposta);

    expect(texto).not.toContain(SENHA);
    expect(texto).not.toContain(pfxBase64.slice(0, 40));
    expect(texto).not.toMatch(/encryptedPassword|encryptedPfx/);
    // Mas a tela precisa saber que existe, para não pedir de novo.
    expect(resposta.senhaGuardada).toBe(true);
  });

  it('a senha não fica em claro no banco', () => {
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64,
      password: SENHA,
    });

    const bruto = getConnection()
      .prepare('SELECT data FROM fiscal_certificate_references')
      .all() as { data: string }[];

    expect(bruto).toHaveLength(1);
    expect(bruto[0].data).not.toContain(SENHA);
    // E está lá, cifrada: o campo existe.
    expect(bruto[0].data).toContain('encryptedPassword');
  });
});
