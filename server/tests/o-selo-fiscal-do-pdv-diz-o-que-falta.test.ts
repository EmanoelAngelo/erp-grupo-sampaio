/**
 * ============================================================================
 * "FISCAL NÃO CONFIGURADO" NO PDV DA PREÇO JUSTO — auditoria P0
 * ============================================================================
 *
 * ## A causa, conferida no banco da loja (somente leitura)
 *
 * Emitente completo (razão social, CNPJ, IE, CRT 1, endereço, IBGE), séries
 * 55/1 e 65/1 no nº 1, ambiente de homologação — e dois buracos:
 *
 *  1. o A1 está no cofre SEM a senha selada (gravado antes de a senha passar a
 *     ser guardada): o item `certificate` é FAIL;
 *  2. nenhum CSC gravado: o item `csc` é FAIL.
 *
 * Os dois são configuração, e o selo dizia só "Esta operação ainda não emite
 * nota". Este arquivo crava o que o balcão passa a receber, e os três
 * defeitos vizinhos que a auditoria achou no mesmo caminho:
 *
 *  - o A1 enviado com a operação ERRADA selecionada no topo era gravado,
 *    calado, na outra loja;
 *  - o A1 de outra raiz de CNPJ (emitente trocado depois do upload) passava
 *    como utilizável;
 *  - a homologação gastava a numeração da produção (o "nº inicial 1" do
 *    contador virava 11 no primeiro cupom de verdade);
 *  - a IE do RS (CGC/TE) não tinha o dígito conferido.
 *
 * ## Como fica vermelho
 *
 *  - volte a classificação antiga da rota e o caso "configuração vence
 *    catálogo" recebe PENDING;
 *  - tire o bloqueio do A1 de outra operação e o upload na loja errada passa;
 *  - volte `resolveSerie` a ignorar o ambiente e a série 1 anda no teste.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  buildReadiness,
  ieDoRsConfere,
  updateFiscalConfig,
} from '../src/services/core/FiscalConfigService.js';
import {
  getSeries,
  reserveNextNumber,
  resolveSerie,
  setSeriesNextNumber,
} from '../src/services/core/FiscalKeyService.js';
import { resumoFiscalDoPdv } from '../src/services/core/ResumoFiscalDoPdv.js';
import { upsertNfceCsc } from '../src/services/nfce/NfceCscService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';

const app = createApp();
const SENHA_A1 = 'senha-do-a1-de-teste-p0';
const SENHA_LOGIN = 'Teste@SeloFiscalP0-2026';
/** CNPJ e IE FICTÍCIOS, com dígitos válidos — nada da loja real. */
const CNPJ_DA_LOJA = '11.222.333/0001-81';
const CNPJ_FILIAL = '11.222.333/0002-62';
const CNPJ_DE_OUTRA_RAIZ = '11.444.777/0001-61';
const IE_DO_RS_VALIDA = '096/0012346';
const CSC_ID_DE_PRODUCAO = 'CSCID-PROD-777';

let a1DaLoja: string;
let loja: string;
let seq = 0;

/** Um A1 de teste com emissor diferente do titular (o autoassinado é FAIL à parte). */
function gerarA1(cnpj: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 365);
  cert.setSubject([{ name: 'commonName', value: `LOJA FICTICIA LTDA:${cnpj.replace(/\D/g, '')}` }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC CERTIFICADORA FICTICIA v5' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA_A1, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

beforeAll(() => {
  a1DaLoja = gerarA1(CNPJ_DA_LOJA);
}, 120_000);

function emitenteCompleto(companyId: string, cnpj = CNPJ_DA_LOJA) {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Loja Ficticia Ltda',
      cnpj,
      ie: IE_DO_RS_VALIDA,
      crt: '1',
      street: 'Rua Andrade Neves',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96020-080',
      uf: 'RS',
    },
  });
}

function enviarA1(companyId = loja, pfx = a1DaLoja) {
  upsertCertificateA1({ companyId, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
}

/** O estado do banco da loja: emitente e séries no lugar, A1 sem a senha, nenhum CSC. */
function estadoDaPrecoJusto() {
  emitenteCompleto(loja);
  setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId: loja, model: '55', serie: 1, nextNumber: 1 });
  enviarA1();
  getConnection()
    .prepare("UPDATE fiscal_certificate_references SET data = json_remove(data, '$.encryptedPassword')")
    .run();
}

function gravarCsc(environment: 'homologation' | 'production', cscId = '000001') {
  upsertNfceCsc({
    companyId: loja,
    operationalUnitId: 'unit-default',
    cscId,
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
    environment,
  });
}

function produtoSemNcm(companyId = loja): void {
  seq += 1;
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, tax_profile, active,
                                  created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, 1000, NULL, '5102', '0', NULL, 1, ?, ?)`,
    )
    .run(`prod-p0-${seq}`, companyId, `P0-${seq}`, `Produto ${seq}`, now, now);
}

async function entrar(login: string, companyId: string, perfil: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA_LOGIN });
  linkUserToCompany(userId, companyId, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA_LOGIN });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
});

// ============================================================================

describe('a causa do "fiscal não configurado"', () => {
  it('A1 sem a senha e sem CSC: NÃO CONFIGURADO, com as duas faltas nomeadas e quem resolve', () => {
    estadoDaPrecoJusto();
    const r = resumoFiscalDoPdv(loja);

    expect(r.situacao).toBe('NOT_CONFIGURED');
    expect(r.canEmit).toBe(false);
    expect(r.ambiente).toBe('homologation');
    expect(r.faltas.map((f) => f.key)).toEqual(['certificate', 'csc']);

    const [a1, csc] = r.faltas;
    expect(a1.texto).toMatch(/sem a senha guardada/);
    expect(a1.quemResolve).toBe('administrador');
    expect(a1.onde).toMatch(/Fiscal › Certificado/);
    expect(csc.texto).toMatch(/de homologação não está gravado/);
    expect(csc.quemResolve).toBe('administrador');

    // A frase do selo — antes, "Esta operação ainda não emite nota." e só.
    expect(r.resumo).toMatch(/Falta: Certificado A1; CSC/);
    expect(r.resumo).toMatch(/Quem resolve: administrador/);
    // Compatibilidade: `blocking` segue existindo, com o texto do balcão.
    expect(r.blocking.map((b) => b.key)).toEqual(['certificate', 'csc']);
  });

  it('a rota entrega ao OPERADOR DE CAIXA o mesmo resumo — e nada que aponte para o segredo', async () => {
    estadoDaPrecoJusto();
    // Só o CSC de PRODUÇÃO gravado: o checklist do administrador nomeia o CSC ID
    // (é o que evita regravar o mesmo); o balcão não precisa vê-lo.
    gravarCsc('production', CSC_ID_DE_PRODUCAO);
    const caixa = await entrar('CAIXAP0', loja, 'operador_caixa_loja');

    const res = await request(app).get('/api/v1/core/fiscal/pdv-summary').set(caixa);
    expect(res.status).toBe(200);
    expect(res.body.situacao).toBe('NOT_CONFIGURED');
    expect(res.body.faltas.map((f: { key: string }) => f.key)).toEqual(['certificate', 'csc']);

    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain(CSC_ID_DE_PRODUCAO);
    expect(texto).not.toContain('CSC-DE-TESTE');
    expect(texto).not.toContain(SENHA_A1);
    expect(texto).not.toMatch(/11222333000181|LOJA FICTICIA|encrypted|pfx|keyPem/i);
    // O detalhe do administrador, sim, nomeia o CSC ID.
    const doAdmin = buildReadiness(loja, '65').items.find((i) => i.key === 'csc')!;
    expect(doAdmin.detail).toContain(CSC_ID_DE_PRODUCAO);
  });

  it('configuração ausente vence catálogo incompleto: produto sem NCM não mascara o CSC', () => {
    emitenteCompleto(loja);
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
    enviarA1();
    produtoSemNcm();

    const r = resumoFiscalDoPdv(loja);
    // Antes: PENDING, "faltam dados fiscais em produtos" — com o CSC faltando.
    expect(r.situacao).toBe('NOT_CONFIGURED');
    const chaves = r.faltas.map((f) => f.key);
    expect(chaves).toContain('csc');
    expect(chaves).toContain('product_ncm');
    expect(r.faltas.find((f) => f.key === 'product_ncm')!.quemResolve).toBe('contador');
    expect(r.resumo).toMatch(/Quem resolve: administrador e contador/);
  });

  it('só o catálogo incompleto: PENDENTE, e quem resolve é o contador', () => {
    emitenteCompleto(loja);
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
    enviarA1();
    gravarCsc('homologation');
    produtoSemNcm();

    const r = resumoFiscalDoPdv(loja);
    expect(r.situacao).toBe('PENDING');
    expect(r.faltas.every((f) => f.key.startsWith('product'))).toBe(true);
  });

  it('A1 reenviado com a senha e CSC de homologação: pronta para TESTE — nunca "pronta"', () => {
    estadoDaPrecoJusto();
    enviarA1();
    gravarCsc('homologation');

    const r = resumoFiscalDoPdv(loja);
    expect(r.faltas).toEqual([]);
    expect(r.canEmit).toBe(true);
    // Em homologação a nota não tem valor fiscal: READY é só da produção.
    expect(r.situacao).toBe('TEST_ONLY');
    expect(r.resumo).toMatch(/HOMOLOGAÇÃO/);
    expect(r.resumo).toMatch(/não tem valor fiscal/);
  });

  it('cada operação vê a própria situação, e só ela', async () => {
    estadoDaPrecoJusto();
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    const caixaDaOutra = await entrar('CAIXAGRINGAP0', outra, 'operador_caixa_loja');

    const res = await request(app).get('/api/v1/core/fiscal/pdv-summary').set(caixaDaOutra);
    expect(res.status).toBe(200);
    expect(res.body.situacao).toBe('NOT_CONFIGURED');
    const chaves = res.body.faltas.map((f: { key: string }) => f.key);
    // A Gringa não tem emitente: é isso que ela vê — e não o A1 da Preço Justo.
    expect(chaves).toContain('emitter');
    expect(chaves).toContain('certificate');
    expect(res.body.faltas.find((f: { key: string }) => f.key === 'certificate').texto)
      .toMatch(/Nenhum certificado/);
  });
});

// ============================================================================

describe('o A1 vai para a operação dona dele', () => {
  it('A1 do CNPJ que é o emitente de OUTRA operação é recusado, e nada é gravado', () => {
    emitenteCompleto(loja);
    const outra = upsertCompany({ slug: 'conceito', legalName: 'Conceito Ltda', tradeName: 'Conceito' });

    // O administrador com a Conceito selecionada no topo, enviando o A1 da Preço Justo.
    expect(() => enviarA1(outra)).toThrow(/OUTRA operação do grupo/);
    try {
      enviarA1(outra);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('FISCAL_CERTIFICATE_DE_OUTRA_OPERACAO');
    }
    expect(findRows('fiscal_certificate_references', (r) => r.companyId === outra)).toHaveLength(0);

    // Na operação certa, o mesmo arquivo entra.
    enviarA1(loja);
    expect(findRows('fiscal_certificate_references', (r) => r.companyId === loja)).toHaveLength(1);
  });

  it('mesma raiz (matriz e filial) continua aceita, com o aviso da conferência', () => {
    emitenteCompleto(loja);
    const filial = upsertCompany({ slug: 'filial', legalName: 'Filial Ltda', tradeName: 'Filial' });
    emitenteCompleto(filial, CNPJ_FILIAL);

    enviarA1(filial);
    const linha = findRows<Record<string, unknown>>(
      'fiscal_certificate_references',
      (r) => r.companyId === filial,
    )[0];
    expect(linha.cnpjConference).toBe('raiz');
  });

  it('emitente trocado para outra raiz depois do upload: o checklist diz que o A1 é de outro CNPJ', () => {
    emitenteCompleto(loja);
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
    enviarA1();
    gravarCsc('homologation');
    expect(buildReadiness(loja, '65').items.find((i) => i.key === 'certificate')!.status).toBe('PASS');

    updateFiscalConfig({ companyId: loja, patch: { cnpj: CNPJ_DE_OUTRA_RAIZ } });
    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'certificate')!;
    expect(item.status).toBe('FAIL');
    expect(item.state).toBe('DIVERGENTE');
    expect(item.detail).toMatch(/raiz diferente/);

    const r = resumoFiscalDoPdv(loja);
    expect(r.faltas.find((f) => f.key === 'certificate')!.texto).toMatch(/não é do CNPJ desta operação/);
  });
});

// ============================================================================

describe('a numeração da homologação não gasta a da produção', () => {
  beforeEach(() => {
    emitenteCompleto(loja);
    enviarA1();
    gravarCsc('homologation');
  });

  it('série legada (sem ambiente) segue servindo aos dois — e o checklist avisa que o teste gasta a numeração', () => {
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'serie')!;
    expect(item.status).toBe('PASS');
    expect(item.detail).toMatch(/serve aos dois ambientes/);
    expect(resolveSerie(loja, '65', undefined, 'homologation')).toBe(1);
    expect(resolveSerie(loja, '65', undefined, 'production')).toBe(1);
  });

  it('série 1 reservada para a produção: sem série de homologação, o checklist trava e diz por quê', () => {
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1, environment: 'production' });

    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'serie')!;
    expect(item.status).toBe('FAIL');
    expect(item.detail).toMatch(/reservada.*produção/);
    expect(() => resolveSerie(loja, '65', undefined, 'homologation')).toThrow(/ambiente: homologação/);
    expect(() => resolveSerie(loja, '65', 1, 'homologation')).toThrow(/reservada para produção/);

    const r = resumoFiscalDoPdv(loja);
    expect(r.situacao).toBe('NOT_CONFIGURED');
    expect(r.faltas.find((f) => f.key === 'serie')!.texto).toMatch(/homologação/);
  });

  it('com a série 2 de homologação, o teste numera na 2 e a série 1 da produção continua no nº 1', () => {
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1, environment: 'production' });
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 2, nextNumber: 1, environment: 'homologation' });

    const serieDoTeste = resolveSerie(loja, '65', undefined, 'homologation');
    expect(serieDoTeste).toBe(2);
    expect(reserveNextNumber({ companyId: loja, model: '65', serie: serieDoTeste })).toBe(1);
    expect(reserveNextNumber({ companyId: loja, model: '65', serie: serieDoTeste })).toBe(2);

    const series = getSeries(loja, '65');
    expect(series.find((s) => s.serie === 1)).toMatchObject({ nextNumber: 1, environment: 'production' });
    expect(series.find((s) => s.serie === 2)).toMatchObject({ nextNumber: 3, environment: 'homologation' });
    expect(resolveSerie(loja, '65', undefined, 'production')).toBe(1);
    expect(buildReadiness(loja, '65').items.find((i) => i.key === 'serie')!.status).toBe('PASS');
  });

  it('série que já tem nota de produção não vira série de homologação', () => {
    setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
    const now = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents (id, company_id, model, serie, number, environment, status,
                                            created_at, updated_at)
         VALUES ('doc-prod-1', ?, '65', 1, 1, 'production', 'AUTHORIZED', ?, ?)`,
      )
      .run(loja, now, now);

    expect(getSeries(loja, '65')[0].usadas).toEqual({ homologation: 0, production: 1 });
    expect(() =>
      setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 2, environment: 'homologation' }),
    ).toThrow(/nota\(s\) de produção/);
    // A recusa não gravou nada: nem o número, nem o ambiente.
    expect(getSeries(loja, '65')[0]).toMatchObject({ nextNumber: 1, environment: null });
  });

  it('a rota grava o ambiente, a listagem o devolve, e ambiente inventado é 400', async () => {
    const gerente = await entrar('GERENTEP0', loja, 'gerente_loja');

    const ok = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 2, nextNumber: 1, environment: 'homologation' });
    expect(ok.status).toBe(200);
    expect(ok.body.items.find((s: { serie: number }) => s.serie === 2).environment).toBe('homologation');

    const errado = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 3, nextNumber: 1, environment: 'producao' });
    expect(errado.status).toBe(400);
    expect(errado.body.error.code).toBe('CORE_FISCAL_ENVIRONMENT_INVALID');

    // Sem o campo, o ambiente gravado não muda (é o gesto de só avançar o número).
    await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 2, nextNumber: 5 });
    const lista = await request(app).get('/api/v1/core/fiscal/series').set(gerente);
    const nfce = lista.body.items.find((i: { model: string }) => i.model === '65');
    expect(nfce.series.find((s: { serie: number }) => s.serie === 2)).toMatchObject({
      nextNumber: 5,
      environment: 'homologation',
    });
  });
});

// ============================================================================

describe('a inscrição estadual do RS (CGC/TE)', () => {
  it('o número passado pelo contador confere no dígito do RS — com a barra, sem reescrever', () => {
    // O "CGC/TE 093/0491475" do contador: dez dígitos, DV 5.
    expect(ieDoRsConfere('093/0491475')).toBe(true);
    expect(ieDoRsConfere('0930491475')).toBe(true);
    expect(ieDoRsConfere('093/0491476')).toBe(false);
    expect(ieDoRsConfere('123456789')).toBe(false);

    emitenteCompleto(loja);
    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'ie')!;
    expect(item.label).toBe('Inscrição estadual (CGC/TE)');
    expect(item.status).toBe('PASS');
    expect(item.known).toBe(IE_DO_RS_VALIDA);
  });

  it('dígito errado: DIVERGENTE, com a consequência dita — e não trava a emissão', () => {
    emitenteCompleto(loja);
    updateFiscalConfig({ companyId: loja, patch: { ie: '096/0012345' } });
    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'ie')!;
    expect(item.status).toBe('PENDING');
    expect(item.state).toBe('DIVERGENTE');
    expect(item.detail).toMatch(/dígito verificador do CGC\/TE/);
    expect(item.detail).toMatch(/rejeição 209/);
  });

  it('sem IE: trava, e no RS pede o CGC/TE pelo nome', () => {
    emitenteCompleto(loja);
    updateFiscalConfig({ companyId: loja, patch: { ie: null } });
    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'ie')!;
    expect(item.status).toBe('FAIL');
    expect(item.detail).toMatch(/CGC\/TE/);
  });

  it('fora do RS, o rótulo e a régua ficam como estavam', () => {
    updateFiscalConfig({
      companyId: loja,
      patch: {
        legalName: 'Loja Ficticia Ltda',
        cnpj: CNPJ_DA_LOJA,
        ie: '123456789',
        uf: 'SC',
        cityName: 'Florianópolis',
        cityIbge: '4205407',
      },
    });
    const item = buildReadiness(loja, '65').items.find((i) => i.key === 'ie')!;
    expect(item.label).toBe('Inscrição estadual');
    expect(item.status).toBe('PASS');
  });
});
