/**
 * ============================================================================
 * A CHAVE DA PRODUÇÃO — GAP-V42
 * ============================================================================
 *
 * ## O portão existia; a chave, não
 *
 * `updateFiscalConfig` recusa `environment = 'production'` enquanto
 * `production_unlocked` for 0, com uma mensagem que promete liberação depois de
 * "configuração completa, certificado válido e autorização real na
 * homologação". As colunas `production_unlocked_at` e `production_unlocked_by`
 * existem desde o schema — e NENHUMA linha de código as escrevia. No dia da
 * virada, ligar produção seria um UPDATE na mão no banco: sem autor, sem data,
 * sem trilha, e com o risco de alguém "resolver" a recusa apagando o portão.
 *
 * Esta rodada dá a chave: `POST /core/fiscal/production-unlock`.
 *
 * ## A condição é a REAL, não a que o simulador satisfaz
 *
 * `buildReadiness` chama de HOMOLOGATED qualquer empresa com um documento
 * AUTHORIZED com protocolo — e o `SefazTestAdapter` produz exatamente isso, com
 * protocolo `TEST-`. Aceitar HOMOLOGATED como condição do desbloqueio deixaria
 * a produção a um clique de distância de um ENSAIO, que é o pior desfecho
 * possível: nota real emitida por quem só provou que o simulador responde.
 *
 * A régua do desbloqueio é a de `FiscalClosingService.SO_PRODUCAO`, virada para
 * a homologação: documento AUTHORIZED, ambiente `homologation`, protocolo que
 * NÃO começa com `TEST-` e XML assinado que NÃO carrega a marca de fixture.
 *
 * ## E destravar NÃO liga produção
 *
 * Este é o ponto que a tela precisa dizer com todas as letras. O desbloqueio é
 * o primeiro de três elos: depois dele ainda é preciso virar o ambiente da
 * operação para `production` (outro ato, outra rota) e ter o servidor rodando
 * fora do modo de desenvolvimento — `developmentMode` é recusado sob
 * `DEVORA_API_ENV=production`, e provider de teste não transmite em produção.
 * Um botão que dissesse "produção ligada" seria mentira em dois terços.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import forge from 'node-forge';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import {
  assessProductionUnlock,
  getFiscalConfig,
  updateFiscalConfig,
} from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { upsertNfceCsc } from '../src/services/nfce/NfceCscService.js';
import { TEST_PROTOCOL_PREFIX } from '../src/services/core/SefazTestAdapter.js';
import { FIXTURE_SIGNATURE_MARK } from '../src/services/core/FiscalPipelineService.js';

const app = createApp();
const SENHA = 'Producao@2026';
const CNPJ = '11222333000181';

let pfxBase64: string;
let empresa: string;
let dono: { Authorization: string };
let sequencia = 0;

beforeAll(() => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 300);
  cert.setSubject([{ name: 'commonName', value: `PRECO JUSTO LTDA:${CNPJ}` }]);
  // Emissor DIFERENTE do titular: autoassinado é fixture, e o checklist o
  // reprova em `certificate_icp` — que é justamente um dos bloqueios aqui.
  cert.setIssuer([{ name: 'commonName', value: 'AC SOLUTI Multipla v5' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA, { algorithm: '3des' });
  pfxBase64 = forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}, 120_000);

/** Deixa a operação com o cadastro fiscal inteiro — tudo menos a homologação. */
function cadastroCompleto(): void {
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Preço Justo Ltda',
      cnpj: CNPJ,
      ie: '1234567890',
      crt: '1',
      zip: '90000000',
      street: 'Rua das Flores',
      number: '100',
      district: 'Centro',
      cityName: 'Porto Alegre',
      cityIbge: '4314902',
      uf: 'RS',
    },
  });
  upsertCertificateA1({
    companyId: empresa,
    operationalUnitId: 'unit-default',
    pfxBase64,
    password: SENHA,
  });
  setSeriesNextNumber({ companyId: empresa, model: '65', serie: 1, nextNumber: 1 });
  upsertNfceCsc({
    companyId: empresa,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'TOKEN-DE-HOMOLOGACAO',
    environment: 'homologation',
  });
}

/**
 * Um documento AUTHORIZED no banco.
 *
 * Não há como chegar a uma autorização REAL de homologação neste ambiente — ela
 * exige a SEFAZ do outro lado. O que se pode fazer é escrever exatamente os
 * valores que `FiscalDocumentService.transition` grava, e IMPORTAR as marcas de
 * ensaio em vez de digitá-las: se um dia a marca mudar, este arquivo muda
 * junto. É a mesma defesa que `fechamento-contador.test.ts` usa.
 */
function documentoAutorizado(over: {
  environment?: string;
  protocol?: string | null;
  xmlSigned?: string;
} = {}): string {
  sequencia += 1;
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, model, serie, number, access_key, environment, status,
          xml_signed, xml_authorized, protocol, issued_at, authorized_at,
          created_at, updated_at)
       VALUES (?, ?, '65', 1, ?, ?, ?, 'AUTHORIZED', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      empresa,
      sequencia,
      `4326${String(sequencia).padStart(40, '0')}`,
      over.environment ?? 'homologation',
      over.xmlSigned ?? '<NFe><Signature><X509Certificate>REAL</X509Certificate></Signature></NFe>',
      '<protNFe/>',
      over.protocol === undefined ? '143260000123456' : over.protocol,
      agora,
      agora,
      agora,
      agora,
    );
  return id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  sequencia = 0;
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  const userId = await upsertUser({ login: 'DONOPROD', displayName: 'Dono', password: SENHA });
  linkUserToCompany(userId, empresa, 'admin_geral', true);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'DONOPROD', password: SENHA, companyId: empresa });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  dono = { Authorization: `Bearer ${login.body.accessToken}` };
});

// ===========================================================================

describe('o estado honesto do desbloqueio', () => {
  it('operação recém-criada: bloqueada, sem carimbo e com a lista do que falta', () => {
    const parecer = assessProductionUnlock(empresa);
    expect(parecer.unlocked).toBe(false);
    expect(parecer.canUnlock).toBe(false);
    expect(parecer.unlockedAt).toBeNull();
    expect(parecer.unlockedBy).toBeNull();
    expect(parecer.evidence).toBeNull();
    expect(parecer.blockingReasons.length).toBeGreaterThan(0);
    expect(parecer.blockingReasons.join(' | ')).toMatch(/homologa/i);
  });

  it('cadastro completo ainda não basta — falta a autorização real', () => {
    cadastroCompleto();
    const parecer = assessProductionUnlock(empresa);
    expect(parecer.canUnlock).toBe(false);
    expect(parecer.blockingReasons.join(' | ')).toMatch(/autoriza|homologa/i);
  });

  it('documento autorizado pelo SIMULADOR não conta — protocolo TEST- é ensaio', () => {
    cadastroCompleto();
    documentoAutorizado({ protocol: `${TEST_PROTOCOL_PREFIX}0001` });

    const parecer = assessProductionUnlock(empresa);
    expect(parecer.canUnlock).toBe(false);
    expect(parecer.evidence).toBeNull();
  });

  it('documento assinado com a chave de fixture não conta, mesmo com protocolo numérico', () => {
    cadastroCompleto();
    documentoAutorizado({
      xmlSigned: `<NFe><Signature><X509Certificate>${FIXTURE_SIGNATURE_MARK}:AAA</X509Certificate></Signature></NFe>`,
    });

    const parecer = assessProductionUnlock(empresa);
    expect(parecer.canUnlock).toBe(false);
    expect(parecer.evidence).toBeNull();
  });

  it('documento de PRODUÇÃO não serve de prova de homologação', () => {
    cadastroCompleto();
    documentoAutorizado({ environment: 'production' });
    expect(assessProductionUnlock(empresa).canUnlock).toBe(false);
  });

  it('com a autorização real, o parecer libera e mostra a PROVA', () => {
    cadastroCompleto();
    documentoAutorizado();

    const parecer = assessProductionUnlock(empresa);
    expect(parecer.canUnlock).toBe(true);
    expect(parecer.blockingReasons).toEqual([]);
    expect(parecer.evidence?.protocol).toBe('143260000123456');
    expect(parecer.evidence?.model).toBe('65');
    expect(parecer.evidence?.number).toBe(1);
  });

  it('a cadeia inteira é declarada, não só o elo que este ato resolve', () => {
    cadastroCompleto();
    documentoAutorizado();
    const parecer = assessProductionUnlock(empresa);

    // Três elos: destravar, virar o ambiente da operação e o servidor fora do
    // modo de desenvolvimento. A tela repete estes textos.
    expect(parecer.remainingSteps.length).toBeGreaterThanOrEqual(2);
    expect(parecer.remainingSteps.join(' | ')).toMatch(/ambiente/i);
  });
});

// ===========================================================================

describe('o ato de desbloquear', () => {
  it('sem a autorização real, a rota RECUSA e nada muda no banco', async () => {
    cadastroCompleto();

    const res = await request(app)
      .post('/api/v1/core/fiscal/production-unlock')
      .set(dono)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_PRODUCTION_NOT_HOMOLOGATED');
    expect(String(res.body.error.message)).toMatch(/homologa/i);

    const row = getConnection()
      .prepare('SELECT production_unlocked, production_unlocked_at, production_unlocked_by FROM core_fiscal_configs WHERE company_id = ?')
      .get(empresa) as Record<string, unknown>;
    expect(row.production_unlocked).toBe(0);
    expect(row.production_unlocked_at).toBeNull();
  });

  it('com a autorização real, destrava e CARIMBA quem e quando', async () => {
    cadastroCompleto();
    documentoAutorizado();

    const res = await request(app)
      .post('/api/v1/core/fiscal/production-unlock')
      .set(dono)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.unlocked).toBe(true);
    expect(res.body.unlockedAt).toBeTruthy();
    expect(res.body.unlockedBy).toBeTruthy();

    const cfg = getFiscalConfig(empresa);
    expect(cfg.productionUnlocked).toBe(true);
    // E o ambiente NÃO virou sozinho: destravar é só o primeiro elo.
    expect(cfg.environment).toBe('homologation');
  });

  it('é idempotente: a segunda chamada não reescreve o carimbo do primeiro ato', async () => {
    cadastroCompleto();
    documentoAutorizado();

    const primeira = await request(app)
      .post('/api/v1/core/fiscal/production-unlock')
      .set(dono)
      .send({});
    expect(primeira.status).toBe(200);

    const segunda = await request(app)
      .post('/api/v1/core/fiscal/production-unlock')
      .set(dono)
      .send({});
    expect(segunda.status).toBe(200);
    expect(segunda.body.alreadyUnlocked).toBe(true);
    expect(segunda.body.unlockedAt).toBe(primeira.body.unlockedAt);
    expect(segunda.body.unlockedBy).toBe(primeira.body.unlockedBy);
  });

  it('a trilha registra o ato com a prova que o autorizou', async () => {
    cadastroCompleto();
    documentoAutorizado();
    await request(app).post('/api/v1/core/fiscal/production-unlock').set(dono).send({}).expect(200);

    const trilha = await request(app)
      .get('/api/v1/core/audit?action=fiscal.production_unlocked')
      .set(dono);
    expect(trilha.status).toBe(200);
    const linha = (trilha.body.items as { action: string; detail: unknown }[]).find(
      (i) => i.action === 'fiscal.production_unlocked',
    );
    expect(linha).toBeTruthy();
    expect(JSON.stringify(linha?.detail)).toContain('143260000123456');
  });

  it('gerente de loja não tem a chave — desbloquear produção é ato de dono', async () => {
    cadastroCompleto();
    documentoAutorizado();

    const userId = await upsertUser({
      login: 'GERENTEPROD',
      displayName: 'Gerente',
      password: SENHA,
    });
    linkUserToCompany(userId, empresa, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTEPROD', password: SENHA, companyId: empresa });

    const res = await request(app)
      .post('/api/v1/core/fiscal/production-unlock')
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
    expect(getFiscalConfig(empresa).productionUnlocked).toBe(false);
  });

  it('o desbloqueio é POR EMPRESA — a vizinha continua trancada', async () => {
    cadastroCompleto();
    documentoAutorizado();
    const gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });

    await request(app).post('/api/v1/core/fiscal/production-unlock').set(dono).send({}).expect(200);

    expect(getFiscalConfig(empresa).productionUnlocked).toBe(true);
    expect(getFiscalConfig(gringa).productionUnlocked).toBe(false);
  });
});

// ===========================================================================

describe('o portão que já existia continua sendo o mesmo', () => {
  it('antes do desbloqueio, virar o ambiente para produção é recusado', () => {
    cadastroCompleto();
    expect(() =>
      updateFiscalConfig({ companyId: empresa, patch: { environment: 'production' } }),
    ).toThrowError(/Produção bloqueada/i);
  });

  it('depois do desbloqueio, o ambiente pode ser virado — e só então', async () => {
    cadastroCompleto();
    documentoAutorizado();
    await request(app).post('/api/v1/core/fiscal/production-unlock').set(dono).send({}).expect(200);

    const cfg = updateFiscalConfig({
      companyId: empresa,
      patch: { environment: 'production' },
    });
    expect(cfg.environment).toBe('production');
  });

  it('o parecer viaja junto do checklist — a tela não precisa de uma chamada a mais', async () => {
    cadastroCompleto();
    documentoAutorizado();

    const res = await request(app).get('/api/v1/core/fiscal/readiness?model=65').set(dono);
    expect(res.status).toBe(200);
    expect(res.body.productionUnlock.canUnlock).toBe(true);
    expect(res.body.productionUnlock.unlocked).toBe(false);
  });
});

/*
  ============================================================================
  O AMBIENTE SÓ TEM DOIS VALORES — E O SERVIDOR PASSOU A EXIGIR ISSO
  ============================================================================

  A rota entregava `req.body` cru ao serviço, e o serviço só se pronunciava
  sobre o valor 'production'. Qualquer outra string entrava no mapa e era
  GRAVADA literal: `{"environment":"contingencia"}` persistia, e 'PRODUCTION'
  em caixa alta escapava do portão do desbloqueio por não ser igual a
  'production'.

  O estrago não é fiscal — a emissão é fail-safe (`env === 'production' ? '1' :
  '2'`, então ambiente estranho emite em homologação e o DANFE sai com a tarja
  de sem valor fiscal). O estrago é de SAÍDA: com um ambiente que a tela não
  conhece, o cartão não oferece gesto nenhum, e a operação fica sem caminho de
  volta para homologação pelo navegador — exatamente o "UPDATE na mão no banco"
  que a virada do ambiente existe para eliminar.

  A recusa é uma união fechada, e não uma lista de proibidos: valor novo só
  entra se alguém o declarar aqui.
*/
describe('o ambiente é um dos dois, e o resto é recusado', () => {
  it('ambiente inventado não é gravado — a recusa nomeia o que vale', () => {
    cadastroCompleto();
    expect(() =>
      updateFiscalConfig({
        companyId: empresa,
        patch: { environment: 'contingencia' } as never,
      }),
    ).toThrowError(/homologation.*production|production.*homologation/i);

    // E o que estava lá continua lá: recusar é não escrever.
    expect(getFiscalConfig(empresa).environment).toBe('homologation');
  });

  it('a caixa alta não passa pelo portão do desbloqueio', () => {
    cadastroCompleto();
    /*
      'PRODUCTION' não é igual a 'production', então o portão do desbloqueio o
      deixaria passar — e a operação acabaria gravada num ambiente que nem a
      trava de produção nem a tela reconhecem. É o pior dos dois mundos.
    */
    expect(() =>
      updateFiscalConfig({
        companyId: empresa,
        patch: { environment: 'PRODUCTION' } as never,
      }),
    ).toThrowError(/homologation.*production|production.*homologation/i);
    expect(getFiscalConfig(empresa).environment).toBe('homologation');
  });

  it('os dois valores legítimos continuam passando', async () => {
    cadastroCompleto();
    expect(
      updateFiscalConfig({ companyId: empresa, patch: { environment: 'homologation' } })
        .environment,
    ).toBe('homologation');

    documentoAutorizado();
    await request(app).post('/api/v1/core/fiscal/production-unlock').set(dono).send({}).expect(200);
    expect(
      updateFiscalConfig({ companyId: empresa, patch: { environment: 'production' } }).environment,
    ).toBe('production');
  });
});
