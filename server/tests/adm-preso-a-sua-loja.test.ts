/**
 * ============================================================================
 * O ADM DE UMA LOJA É DA SUA LOJA — rodada 48
 * ============================================================================
 *
 * O dono relatou: "um adm da Conceito consegue acesso ao painel de qualquer
 * outra loja do grupo". A troca de empresa já era validada por vínculo
 * (`assertMembership`), mas QUATRO superfícies decidiam alcance de grupo por
 * STRING DE PERFIL — e `admin_geral` numa loja só é um perfil, não um dono:
 *
 *   1. `GET /core/companies` devolvia o grupo inteiro (operações e CNPJs) a
 *      qualquer `admin_geral`/`gestor`, mesmo o de uma loja só;
 *   2. `POST /core/companies` deixava qualquer um deles ABRIR operação nova
 *      no grupo;
 *   3. a auditoria de sistema (`allowCrossCompany`) atravessava empresa para
 *      qualquer `admin_geral`;
 *   4. `resolveIntegrationCompanyId` deixava qualquer `admin_geral`/`gestor`
 *      operar CERTIFICADO, CHAVE ASAAS e configuração fiscal de OUTRA empresa
 *      mandando `companyId` — o mais grave dos quatro.
 *
 * A regra nova é uma só: QUEM ATRAVESSA EMPRESA É O VÍNCULO, NUNCA O PERFIL.
 *   - listar empresas → só as dos próprios vínculos;
 *   - abrir operação → só quem tem vínculo de gestão em TODAS as ativas
 *     (a definição operacional de "responde pelo grupo", a mesma de
 *     `listGroupAdminIds`);
 *   - atravessar para a empresa X (auditoria, integrações) → só quem tem
 *     vínculo de gestão EM X.
 *
 * ADMIN (admin_geral nas 6) e CARLOSGERENTE (gestor nas 6) continuam
 * enxergando tudo — decisão do dono — porque o vínculo deles já diz isso.
 *
 * COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito):
 *  - voltando `listCompanies()` no GET, o adm da Conceito volta a ver os CNPJs
 *    do grupo e o caso da listagem falha;
 *  - tirando `respondePeloGrupo` do POST, o adm de uma loja abre a sétima
 *    operação e o caso do 403 falha;
 *  - voltando `allowCrossCompany` para string de perfil, o caso da auditoria
 *    alheia falha;
 *  - voltando `resolveIntegrationCompanyId` para string, o caso das
 *    integrações alheias falha;
 *  - derivando os gestores do grupo DEPOIS do INSERT da empresa nova, o
 *    gestor perde o título no instante em que a sétima nasce e o caso
 *    "continua criando" falha — o mesmo defeito silencioso que
 *    `listGroupAdminIds` documenta para os administradores;
 *  - gravando o CRIADOR como `admin_geral` fixo, o gestor que cria vira
 *    perfil misto, a criação seguinte (de outra pessoa) não o arrasta, e a
 *    cadeia oitava→nona→décima fica vermelha;
 *  - tirando o companyId do predicado do CRM ou da logística, o PATCH da
 *    oportunidade alheia escreve (e devolve a linha) e o GET da cotação
 *    alheia responde 200 — os dois casos de "id adivinhável" falham.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { getAsaasCredentialStatus } from '../src/services/integrations/AsaasCredentialService.js';
import { recordAudit } from '../src/services/audit/AuditService.js';
import { createLogisticsQuote } from '../src/services/logistics/LogisticsService.js';

const app = createApp();
const SENHA = 'Cerco@PorLoja2026';
const SENHA_GERENTE = 'Gerente@Novo2026';

interface Ator {
  auth: { Authorization: string };
  userId: string;
  /** A prova da sessão que a troca de operação exige (R2-SESSAO). */
  refreshToken: string;
}

/**
 * Usuário de verdade com os vínculos pedidos, logado na primeira empresa da
 * lista — senha Argon2id e login real, nada de token forjado.
 */
async function ator(login: string, vinculos: [string, string][]): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  for (const [companyId, profile] of vinculos) {
    linkUserToCompany(userId, companyId, profile, false);
  }
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: vinculos[0][0] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    userId,
    refreshToken: String(res.body.refreshToken),
  };
}

function empresaPorSlug(slug: string): { id: string } | undefined {
  return getConnection()
    .prepare('SELECT id FROM core_companies WHERE slug = ?')
    .get(slug) as { id: string } | undefined;
}

function vinculosDe(userId: string): { company_id: string; profile_code: string }[] {
  return getConnection()
    .prepare('SELECT company_id, profile_code FROM core_user_companies WHERE user_id = ?')
    .all(userId) as unknown as { company_id: string; profile_code: string }[];
}

let conceito: string;
let gringa: string;
let precoJusto: string;

beforeEach(() => {
  resetDbForTests();
  conceito = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio de Roupas Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
});

/** O adm preso à Conceito: perfil de administrador, vínculo em UMA loja. */
const admConceito = () => ator('ADM.CONCEITO', [[conceito, 'admin_geral']]);
/** O dono do grupo: admin_geral em todas — o ADMIN do seed. */
const donoGrupo = () =>
  ator('DONO.GRUPO', [
    [conceito, 'admin_geral'],
    [gringa, 'admin_geral'],
    [precoJusto, 'admin_geral'],
  ]);
/** O gestor do grupo: gestor em todas — o CARLOSGERENTE do seed. */
const carlos = () =>
  ator('CARLOS.GESTOR', [
    [conceito, 'gestor'],
    [gringa, 'gestor'],
    [precoJusto, 'gestor'],
  ]);

function corpoDeLoja(login = 'GERENTE.NOVA') {
  return {
    legalName: 'Sampaio Bikes Comércio Ltda',
    tradeName: 'Sampaio Bikes',
    kind: 'retail',
    manager: { login, displayName: 'Gerente da Nova', password: SENHA_GERENTE },
  };
}

describe('a listagem de empresas devolve só as dos próprios vínculos', () => {
  it('o adm da Conceito vê a Conceito — e NÃO vê as operações e CNPJs das outras', async () => {
    const adm = await admConceito();
    const res = await request(app).get('/api/v1/core/companies').set(adm.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((c: { slug: string }) => c.slug)).toEqual(['conceito']);
  });

  it('quem tem vínculo em todas continua vendo todas — ADMIN e gestor', async () => {
    for (const abrir of [donoGrupo, carlos]) {
      const a = await abrir();
      const res = await request(app).get('/api/v1/core/companies').set(a.auth);
      expect(res.status).toBe(200);
      const slugs = (res.body.items as { slug: string }[]).map((c) => c.slug).sort();
      expect(slugs).toEqual(['conceito', 'gringa', 'preco-justo']);
    }
  });
});

describe('abrir operação no grupo é de quem responde pelo grupo', () => {
  it('o adm de UMA loja recebe 403, e nada fica no banco', async () => {
    const adm = await admConceito();
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(adm.auth)
      .send(corpoDeLoja());
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error?.code).toBe('CORE_GROUP_SCOPE_REQUIRED');
    expect(empresaPorSlug('sampaio-bikes')).toBeUndefined();
  });

  it('o gestor do grupo continua criando — o alcance dele vem do vínculo', async () => {
    const gestor = await carlos();
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(gestor.auth)
      .send(corpoDeLoja());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('a empresa nova chega com os gestores do grupo dentro — e o gestor continua respondendo pelo grupo', async () => {
    /*
      Antes desta rodada, só os `admin_geral` de todas ganhavam vínculo na
      empresa recém-criada. O CARLOSGERENTE ficaria de FORA da sétima loja — e
      perderia o título de gestor do grupo no instante em que ela nascesse,
      sem erro nenhum: só uma loja que ele não alcança.
    */
    const dono = await donoGrupo();
    const gestor = await carlos();
    // Gestor de uma loja só: não é do grupo, não é arrastado para a nova.
    const gestorLocal = await ator('GESTOR.LOCAL', [[gringa, 'gestor']]);

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(corpoDeLoja());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const novaId = res.body.company.id as string;

    const doCarlos = vinculosDe(gestor.userId).find((v) => v.company_id === novaId);
    expect(doCarlos?.profile_code).toBe('gestor');
    expect(vinculosDe(gestorLocal.userId).map((v) => v.company_id)).not.toContain(novaId);

    // E, com a sétima já de pé, o gestor do grupo AINDA abre a oitava: se os
    // gestores fossem derivados depois do INSERT, aqui viria 403.
    const oitava = await request(app)
      .post('/api/v1/core/companies')
      .set(gestor.auth)
      .send({ ...corpoDeLoja('GERENTE.OITAVA'), tradeName: 'Sampaio Trikes', legalName: 'Sampaio Trikes Ltda' });
    expect(oitava.status, JSON.stringify(oitava.body)).toBe(201);

    /*
      O CRIADOR entra com o perfil que o fez do grupo — não `admin_geral`
      fixo. Gravado como admin, o gestor virava perfil MISTO (gestor em N,
      admin em 1) e caía das DUAS listas de derivação: a criação seguinte,
      feita por outra pessoa, não o arrastava, e ele perdia o grupo em
      silêncio. A cadeia inteira está medida aqui: perfil do criador na
      oitava, arrasto na nona criada por OUTRO, e a décima que só nasce se o
      gestor continuou respondendo pelo grupo.
    */
    const naOitava = vinculosDe(gestor.userId).find(
      (v) => v.company_id === (oitava.body.company.id as string),
    );
    expect(naOitava?.profile_code).toBe('gestor');

    const nona = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send({ ...corpoDeLoja('GERENTE.NONA'), tradeName: 'Sampaio Quads', legalName: 'Sampaio Quads Ltda' });
    expect(nona.status, JSON.stringify(nona.body)).toBe(201);
    const naNona = vinculosDe(gestor.userId).find(
      (v) => v.company_id === (nona.body.company.id as string),
    );
    expect(naNona?.profile_code).toBe('gestor');

    const decima = await request(app)
      .post('/api/v1/core/companies')
      .set(gestor.auth)
      .send({ ...corpoDeLoja('GERENTE.DECIMA'), tradeName: 'Sampaio Sup', legalName: 'Sampaio Sup Ltda' });
    expect(decima.status, JSON.stringify(decima.body)).toBe(201);
  });
});

/*
  A auditoria de sistema (`GET /system/audit`) atravessava empresa pela query,
  por vínculo. Saiu na verificação do GAP-PRD-075: sem tela, lia uma lista em
  memória que só os testes preenchiam e, vazia, inventava a linha
  `audit-stub-scan` — o "items.length > 0 e todos da Gringa" que este bloco
  cobrava era a linha inventada, carimbada com a empresa pedida. A trilha de
  verdade é `GET /core/audit`, e ela NÃO atravessa pela query: a empresa é a do
  token. Quem responde por várias troca de operação (`/auth/session/switch`).
*/
describe('a trilha da auditoria é da empresa do token', () => {
  it('o adm da Conceito pedindo a Gringa pela query lê só a Conceito', async () => {
    recordAudit({ companyId: gringa, action: 'adm.linha_da_gringa', entityType: 'teste' });
    recordAudit({ companyId: conceito, action: 'adm.linha_da_conceito', entityType: 'teste' });
    const adm = await admConceito();
    const res = await request(app)
      .get(`/api/v1/core/audit?companyId=${gringa}&limit=200`)
      .set(adm.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acoes = (res.body.items as { action: string }[]).map((i) => i.action);
    expect(acoes).not.toContain('adm.linha_da_gringa');
    expect(acoes).toContain('adm.linha_da_conceito');
  });

  it('nem o dono do grupo atravessa pela query: vínculo não é filtro de URL', async () => {
    recordAudit({ companyId: gringa, action: 'adm.linha_da_gringa', entityType: 'teste' });
    const dono = await donoGrupo();
    const res = await request(app)
      .get(`/api/v1/core/audit?companyId=${gringa}&limit=200`)
      .set(dono.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acoes = (res.body.items as { action: string }[]).map((i) => i.action);
    expect(acoes).not.toContain('adm.linha_da_gringa');
  });

  it('a porta antiga, que atravessava pela query, não responde mais', async () => {
    const adm = await admConceito();
    const res = await request(app).get(`/api/v1/system/audit?companyId=${gringa}`).set(adm.auth);
    expect(res.status).toBe(404);
  });
});

/*
  O item 4 do cabeçalho morava no roteador `/integrations`, que aceitava
  `companyId` na query e no corpo e decidia a travessia por
  `resolveIntegrationCompanyId`. O roteador saiu (GAP-PRD-075): nenhuma tela o
  chamava, e cada credencial tem a porta do próprio domínio, onde a empresa
  vem SEMPRE do token — não há `companyId` de fora para atravessar.
*/
describe('integrações: certificado e chave são da empresa do vínculo', () => {
  it('a porta que aceitava ?companyId= saiu: 404 para o adm da Conceito e para o dono', async () => {
    const adm = await admConceito();
    const dono = await donoGrupo();
    for (const quem of [adm, dono]) {
      const res = await request(app)
        .get(`/api/v1/integrations?companyId=${gringa}`)
        .set(quem.auth);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    }
  });

  it('nem ESCREVER: a chave Asaas da Gringa não nasce pela mão do adm da Conceito', async () => {
    /*
      A porta da tela ignora `companyId` no corpo: a chave cai na empresa do
      token. Este caso passa pela ROTA de escrita e confere o COFRE depois —
      o da Gringa segue vazio.
    */
    const adm = await admConceito();
    const res = await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(adm.auth)
      .send({ companyId: gringa, environment: 'sandbox', apiKey: '$aact_hmlg_invasao_XXXX' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(getAsaasCredentialStatus(gringa, {}).sandbox.configured).toBe(false);
    expect(getAsaasCredentialStatus(conceito, {}).sandbox.configured).toBe(true);
  });
});

describe('o id adivinhável não atravessa empresa — logística', () => {
  /*
    Dois primos do mesmo vazamento, achados pela revisão da rodada: rotas que
    resolviam a linha SÓ pelo :id do cliente, com id `<prefixo>-<timestamp>`
    enumerável — o gerente da empresa X editava a oportunidade (ou lia a
    cotação de frete, com CEPs e valor declarado) da empresa Y. O escopo da
    sessão entrou no predicado; empresa errada responde IGUAL a id
    inexistente, sem oráculo de existência entre tenants.
  */
  // O primo do CRM (PATCH de oportunidade alheia) saiu com o roteador /crm
  // (GAP-PRD-075): a oportunidade que a tela usa é a do núcleo, e o cerco
  // dela é cobrado em audit-crm.test.ts.
  it('cotação de frete alheia é 404 — e a própria continua legível', async () => {
    const daGringa = createLogisticsQuote({
      companyId: gringa,
      originZip: '96010-000',
      destinationZip: '01310-100',
      declaredValue: 12_000,
    }) as { id: string };

    const adm = await admConceito();
    const cruzada = await request(app)
      .get(`/api/v1/logistics/quotes/${daGringa.id}`)
      .set(adm.auth);
    expect(cruzada.status).toBe(404);

    const gestorGringa = await ator('GESTOR.GRINGA.LOG', [[gringa, 'gestor']]);
    const propria = await request(app)
      .get(`/api/v1/logistics/quotes/${daGringa.id}`)
      .set(gestorGringa.auth);
    expect(propria.status, JSON.stringify(propria.body)).toBe(200);
    expect(propria.body.declaredValue).toBe(12_000);
  });
});

describe('a troca de loja continua barrada pelo vínculo', () => {
  it('o adm da Conceito não troca para a Gringa', async () => {
    const adm = await admConceito();
    const res = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(adm.auth)
      .send({ companyId: gringa, refreshToken: adm.refreshToken });
    expect(res.status).toBe(403);
  });

  it('o gestor do grupo troca — e o token novo carrega o perfil do destino', async () => {
    const gestor = await carlos();
    const res = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(gestor.auth)
      .send({ companyId: gringa, refreshToken: gestor.refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const sessao = await request(app)
      .get('/api/v1/auth/session')
      .set({ Authorization: `Bearer ${res.body.accessToken}` });
    expect(sessao.status).toBe(200);
    expect(sessao.body.session.companyId).toBe(gringa);
    expect(sessao.body.session.profileCodes).toEqual(['gestor']);
  });

  it('o perfil do token é o do VÍNCULO de destino — gestor lá, gerente cá', async () => {
    /*
      O caso acima não separa "perfil do destino" de "perfil que já era":
      Carlos é gestor dos dois lados. Aqui os perfis DIFEREM — gestor na
      Conceito, gerente_loja na Gringa — e o token pós-troca tem de dizer
      gerente_loja. Se `issueSession` regredir para o perfil da sessão velha,
      este é o caso que fica vermelho.
    */
    const misto = await ator('GESTOR.MISTO', [
      [conceito, 'gestor'],
      [gringa, 'gerente_loja'],
    ]);
    const res = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(misto.auth)
      .send({ companyId: gringa, refreshToken: misto.refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const sessao = await request(app)
      .get('/api/v1/auth/session')
      .set({ Authorization: `Bearer ${res.body.accessToken}` });
    expect(sessao.body.session.companyId).toBe(gringa);
    expect(sessao.body.session.profileCodes).toEqual(['gerente_loja']);
  });
});
