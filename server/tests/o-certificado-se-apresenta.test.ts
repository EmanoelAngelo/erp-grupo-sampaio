/**
 * ============================================================================
 * O CERTIFICADO SE APRESENTA — e o sistema para de perguntar o que ele já diz
 * ============================================================================
 *
 * ## A regra mestre
 *
 * SE O SISTEMA DESCOBRE, ELE NÃO PERGUNTA. Um `.pfx` da ICP-Brasil carrega
 * titular, CNPJ, autoridade emissora, número de série, janela de validade e a
 * cadeia inteira. Pedir qualquer um desses campos a quem acabou de enviar o
 * arquivo é pedir que a pessoa transcreva — e transcrição erra.
 *
 * O upload passa a EXTRAIR tudo e a DEVOLVER tudo, e a tela mostra o cartão
 * "CERTIFICADO VALIDADO" com o que o arquivo informou.
 *
 * ## GAP-V39 — a conferência do CNPJ era opcional, e não tinha teste
 *
 * `upsertCertificateA1` só comparava o CNPJ quando quem chamava mandava
 * `expectedCnpj`. Campo vazio na tela: o A1 de OUTRA empresa subia calado, e o
 * desmentido só chegaria na rejeição da SEFAZ, com a venda feita. Pior: o
 * branch da recusa não tinha um único teste — `grep CNPJ_MISMATCH` em
 * `server/tests` voltava vazio.
 *
 * Agora a conferência é SEMPRE, contra `core_fiscal_configs.cnpj` (o emitente
 * que o próprio sistema já conhece), com `expectedCnpj` como override
 * explícito de quem sabe o que está fazendo.
 *
 * ## A RÉGUA DA RAIZ — decidida aqui, e é a régua do fisco
 *
 * Igualdade não é a dos 14 dígitos: é a dos OITO primeiros, a RAIZ do CNPJ.
 * A matriz e a filial de uma mesma empresa dividem a raiz (0001 vs 0002), e a
 * SEFAZ aceita o certificado da matriz assinando pela filial justamente por
 * isso — o que ela compara é a base. Recusar por causa do sufixo faria o
 * sistema ser mais severo que o fisco e barrar uma carga legítima.
 *
 * O que a raiz igual com sufixo diferente NÃO é é silêncio: o registro guarda
 * o aviso e a tela o mostra, porque carregar o A1 da matriz numa filial é uma
 * escolha, não um acidente que o sistema deva esconder.
 *
 * Raiz diferente é recusa seca, com os DOIS números na mensagem — quem lê
 * precisa ver o que está no arquivo e o que está no cadastro para saber qual
 * dos dois está errado.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import forge from 'node-forge';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import {
  parseCertificateA1,
  upsertCertificateA1,
} from '../src/services/fiscal/FiscalCertificateService.js';
import { getCertificateView } from '../src/services/core/CertificateStatusService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';

const app = createApp();
const SENHA = 'Certificado@2026';

/** Matriz e filial da MESMA empresa: a raiz 11222333 é a mesma. */
const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL = '11222333000262';
/** Outra empresa inteira — raiz diferente. */
const CNPJ_ESTRANHO = '99888777000166';

interface Molde {
  cn: string;
  /** O atributo `serialNumber` (OID 2.5.4.5) do subject. */
  serialNumberDoSubject?: string;
  emissor?: string;
  validoDe?: Date;
  validoAte?: Date;
}

/*
  Gerar RSA de 2048 custa segundos. Os arquivos são gerados UMA vez no
  `beforeAll` e reaproveitados — o `beforeEach` só limpa o banco.
*/
function gerarPfx(molde: Molde): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0a1b2c3d';
  cert.validity.notBefore = molde.validoDe ?? new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = molde.validoAte ?? new Date(Date.now() + 86_400_000 * 300);

  const subject: forge.pki.CertificateField[] = [
    { name: 'commonName', value: molde.cn },
    { name: 'organizationName', value: 'ICP-Brasil' },
    { name: 'countryName', value: 'BR' },
  ];
  if (molde.serialNumberDoSubject) {
    subject.push({ name: 'serialNumber', value: molde.serialNumberDoSubject });
  }
  cert.setSubject(subject);
  cert.setIssuer([{ name: 'commonName', value: molde.emissor ?? molde.cn }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA, {
    algorithm: '3des',
  });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

let matriz: string;
let filial: string;
let estranho: string;
let pessoaFisica: string;

let empresa: string;
let dono: { Authorization: string };

beforeAll(() => {
  matriz = gerarPfx({
    cn: `PRECO JUSTO COMERCIO LTDA:${CNPJ_MATRIZ}`,
    emissor: 'AC SOLUTI Multipla v5',
  });
  filial = gerarPfx({
    cn: `PRECO JUSTO COMERCIO LTDA:${CNPJ_FILIAL}`,
    emissor: 'AC SOLUTI Multipla v5',
  });
  estranho = gerarPfx({
    cn: `GRINGA IMPORTADORA LTDA:${CNPJ_ESTRANHO}`,
    emissor: 'AC SOLUTI Multipla v5',
  });
  pessoaFisica = gerarPfx({
    cn: 'MARIA DA SILVA:12345678909',
    serialNumberDoSubject: '12345678909',
    emissor: 'AC SOLUTI Multipla v5',
  });
}, 120_000);

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  const userId = await upsertUser({ login: 'DONOA1', displayName: 'Dono', password: SENHA });
  linkUserToCompany(userId, empresa, 'admin_geral', true);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'DONOA1', password: SENHA, companyId: empresa });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  dono = { Authorization: `Bearer ${login.body.accessToken}` };
});

// ===========================================================================
// AUTODETECÇÃO
// ===========================================================================

describe('o .pfx conta tudo que sabe', () => {
  it('a leitura extrai titular, documento, emissor, série, DN, validade e impressão digital', () => {
    const lido = parseCertificateA1(matriz, SENHA);

    // O titular vem SEM o CNPJ colado — o padrão ICP-Brasil gruda os dois no
    // CN, e quem lê a tela quer o nome da empresa, não o nome com um número.
    expect(lido.holderName).toBe('PRECO JUSTO COMERCIO LTDA');
    expect(lido.documentType).toBe('CNPJ');
    expect(lido.documentNumber).toBe(CNPJ_MATRIZ);
    expect(lido.cnpj).toBe(CNPJ_MATRIZ);

    expect(lido.issuer).toContain('AC SOLUTI');
    expect(lido.serialNumber).toBe('0a1b2c3d');

    // O DN inteiro, não só o CN: é ele que prova de qual hierarquia o arquivo
    // veio quando o CN é ambíguo.
    expect(lido.subjectDn).toContain('PRECO JUSTO');
    expect(lido.subjectDn).toContain('ICP-Brasil');
    expect(lido.issuerDn).toContain('AC SOLUTI');

    expect(new Date(lido.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(lido.validTo).getTime()).toBeGreaterThan(Date.now());

    // SHA-256 em 32 pares hexadecimais separados por dois-pontos.
    expect(lido.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    expect(lido.chainLength).toBe(1);
    // Emissor igual ao titular não é o caso aqui: o molde tem AC própria.
    expect(lido.selfSigned).toBe(false);
  });

  it('e-CPF é reconhecido como pessoa física, não confundido com CNPJ', () => {
    const lido = parseCertificateA1(pessoaFisica, SENHA);
    expect(lido.documentType).toBe('CPF');
    expect(lido.documentNumber).toBe('12345678909');
    expect(lido.holderName).toBe('MARIA DA SILVA');
    // `cnpj` continua sendo SÓ CNPJ: quem o lê (emissão, SEFAZ) não pode
    // receber um CPF disfarçado de CNPJ.
    expect(lido.cnpj).toBe('');
  });

  it('a impressão digital identifica o ARQUIVO — igual para o mesmo, diferente para outro', () => {
    const uma = parseCertificateA1(matriz, SENHA);
    const outra = parseCertificateA1(matriz, SENHA);
    const terceira = parseCertificateA1(estranho, SENHA);

    expect(uma.fingerprintSha256).toBe(outra.fingerprintSha256);
    expect(terceira.fingerprintSha256).not.toBe(uma.fingerprintSha256);
  });

  it('o upload persiste os dados e a tela recebe todos eles — sem nada de segredo junto', async () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });

    const res = await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(dono)
      .send({ pfxBase64: matriz, certificatePassword: SENHA });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cert = res.body.certificate as Record<string, unknown>;

    expect(cert.holderName).toBe('PRECO JUSTO COMERCIO LTDA');
    expect(cert.documentType).toBe('CNPJ');
    expect(cert.documentNumber).toBe(CNPJ_MATRIZ);
    expect(String(cert.issuer)).toContain('AC SOLUTI');
    expect(cert.serialNumber).toBe('0a1b2c3d');
    expect(String(cert.subjectDn)).toContain('PRECO JUSTO');
    expect(String(cert.issuerDn)).toContain('AC SOLUTI');
    expect(String(cert.fingerprintSha256)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(cert.chainLength).toBe(1);
    expect(cert.selfSigned).toBe(false);
    expect(cert.senhaGuardada).toBe(true);
    expect(res.body.daysRemaining).toBeGreaterThan(0);

    // O sigilo da rodada do cofre continua valendo, campo novo nenhum o furou.
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain(SENHA);
    expect(texto).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(texto).not.toContain('BEGIN PRIVATE KEY');
    expect(texto).not.toMatch(/encryptedPfx|encryptedPassword/);
  });

  it('o que foi extraído sobrevive à releitura — a tela não reprocessa o arquivo', () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64: matriz,
      password: SENHA,
    });

    const view = getCertificateView(empresa);
    expect(view.certificate?.holderName).toBe('PRECO JUSTO COMERCIO LTDA');
    expect(view.certificate?.documentNumber).toBe(CNPJ_MATRIZ);
    expect(view.certificate?.fingerprintSha256).toBeTruthy();
  });
});

// ===========================================================================
// GAP-V39 — a conferência do CNPJ
// ===========================================================================

describe('GAP-V39 — o CNPJ do certificado é conferido SEMPRE', () => {
  it('certificado de outra empresa é RECUSADO mesmo sem ninguém pedir a conferência', () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });

    /*
      Este é o defeito inteiro: nenhum `expectedCnpj`, campo vazio na tela. O
      certificado da Gringa subia calado no Preço Justo.
    */
    let erro: unknown;
    try {
      upsertCertificateA1({
        companyId: empresa,
        operationalUnitId: 'unit-default',
        pfxBase64: estranho,
        password: SENHA,
      });
    } catch (e) {
      erro = e;
    }

    expect((erro as { code?: string })?.code).toBe('FISCAL_CERTIFICATE_CNPJ_MISMATCH');
    // Os DOIS números na mensagem: quem lê precisa saber qual dos dois errou.
    expect(String((erro as Error)?.message)).toMatch(
      /CNPJ do certificado não corresponde à empresa selecionada/i,
    );
    expect(String((erro as Error)?.message)).toContain('99.888.777/0001-66');
    expect(String((erro as Error)?.message)).toContain('11.222.333/0001-81');

    // E nada foi gravado: recusa é recusa.
    expect(getCertificateView(empresa).configured).toBe(false);
  });

  it('pela ROTA, a recusa chega como 400 com o código nomeado', async () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });

    const res = await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(dono)
      .send({ pfxBase64: estranho, certificatePassword: SENHA });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_CNPJ_MISMATCH');
  });

  it('CNPJ igual passa, e o registro declara que a conferência foi feita', () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64: matriz,
      password: SENHA,
    });

    const view = getCertificateView(empresa);
    expect(view.certificate?.cnpjConference).toBe('conferido');
    expect(view.certificate?.cnpjConferenceWarning).toBeNull();
  });

  it('MESMA RAIZ com filial diferente passa — mas com aviso, porque é escolha', () => {
    // O cadastro é a filial 0002; o arquivo é o A1 da matriz 0001.
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_FILIAL } });
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64: matriz,
      password: SENHA,
    });

    const view = getCertificateView(empresa);
    expect(view.certificate?.cnpjConference).toBe('raiz');
    expect(String(view.certificate?.cnpjConferenceWarning)).toMatch(
      /mesma raiz|mesmo estabelecimento|matriz/i,
    );
    expect(String(view.certificate?.cnpjConferenceWarning)).toContain('11.222.333/0001-81');
    expect(String(view.certificate?.cnpjConferenceWarning)).toContain('11.222.333/0002-62');
  });

  it('sem CNPJ no cadastro do emitente, aceita — e DECLARA que não conferiu', () => {
    // Nada de `updateFiscalConfig`: a operação ainda não tem CNPJ.
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64: estranho,
      password: SENHA,
    });

    const view = getCertificateView(empresa);
    expect(view.certificate?.cnpjConference).toBe('sem_referencia');
    expect(String(view.certificate?.cnpjConferenceWarning)).toMatch(/não foi conferido|CNPJ do emitente/i);
  });

  it('`expectedCnpj` continua vencendo o cadastro — o override de quem sabe', () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });

    // O cadastro diz matriz; quem envia afirma que espera a Gringa. O arquivo
    // é da Gringa: o override manda, e a carga passa.
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64: estranho,
      password: SENHA,
      expectedCnpj: CNPJ_ESTRANHO,
    });
    expect(getCertificateView(empresa).certificate?.cnpjConference).toBe('conferido');
  });

  it('`expectedCnpj` que não bate recusa, mesmo com o cadastro batendo', () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });

    expect(() =>
      upsertCertificateA1({
        companyId: empresa,
        operationalUnitId: 'unit-default',
        pfxBase64: matriz,
        password: SENHA,
        expectedCnpj: CNPJ_ESTRANHO,
      }),
    ).toThrowError(/não corresponde/i);
  });

  it('e-CPF não é barrado pela conferência de CNPJ — é avisado', () => {
    /*
      Certificado de pessoa física não tem CNPJ para comparar. Recusar seria
      inventar uma regra que o fisco não faz (MEI e produtor rural emitem com
      e-CPF em algumas UFs); calar seria esconder que a conferência não pôde
      acontecer. O caminho é aceitar e declarar.
    */
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });
    upsertCertificateA1({
      companyId: empresa,
      operationalUnitId: 'unit-default',
      pfxBase64: pessoaFisica,
      password: SENHA,
    });

    const view = getCertificateView(empresa);
    expect(view.certificate?.cnpjConference).toBe('sem_referencia');
    expect(String(view.certificate?.cnpjConferenceWarning)).toMatch(/pessoa física|CPF/i);
  });

  it('a auditoria registra a conferência — nunca o arquivo nem a senha', async () => {
    updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ_MATRIZ } });
    await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(dono)
      .send({ pfxBase64: matriz, certificatePassword: SENHA })
      .expect(201);

    const trilha = await request(app)
      .get('/api/v1/core/audit?action=fiscal.certificate.upsert')
      .set(dono);
    expect(trilha.status).toBe(200);
    const linha = (trilha.body.items as { action: string; detail: unknown }[]).find(
      (i) => i.action === 'fiscal.certificate.upsert',
    );
    expect(linha).toBeTruthy();
    const detalhe = JSON.stringify(linha?.detail ?? {});
    expect(detalhe).toContain('conferido');
    expect(detalhe).not.toContain(SENHA);
  });
});
