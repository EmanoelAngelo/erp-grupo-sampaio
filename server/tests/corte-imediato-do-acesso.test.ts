/**
 * ============================================================================
 * DESLIGOU, CAIU — NA HORA, E NÃO "EM ATÉ UMA HORA" (GAP-PRD-053)
 * ============================================================================
 *
 * O refresh já perguntava à pessoa de hoje (`sessao-do-desligado.test.ts`):
 * desativado, com senha trocada ou desvinculado, o refresh morria. Mas o
 * ACCESS token já emitido continuava valendo até vencer, porque
 * `authMiddleware` só conferia a assinatura e a validade do JWT — nunca o
 * banco. Medido pela auditoria (harness [C1], [C2], [C4]):
 *
 *   - desativado: GET com o access antigo → 200 por até 60 minutos;
 *   - rebaixado de gerente a atendente: a rota de gerente → 200 com o access
 *     antigo;
 *   - desvinculado da operação: access → 200.
 *
 * Funcionário desligado com token vivo operava o caixa por até uma hora, e
 * "trocar a senha do desligado" não cortava nada — só o tempo cortava.
 *
 * Agora `authMiddleware` confere, a cada requisição, a CONTA DE AGORA: ativa,
 * na mesma `session_version` do token e ainda vinculada à operação do token.
 * O perfil que vale é o do vínculo de agora — rebaixamento e promoção valem na
 * requisição seguinte. O custo é uma consulta por chave primária num SQLite
 * local, sem rede.
 *
 * Todos os casos atravessam a ROTA, com o access token emitido ANTES do gesto.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { linkUserToCompany, upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { loginForTest, TEST_PASSWORD } = await import('./helpers/auth.js');

const app = createApp();
const LOJA = 'loja-corte';
const OUTRA = 'loja-corte-b';
/** Rota que o gerente alcança e o atendente não (mesma de sessao-do-desligado). */
const ROTA_DE_GERENTE = '/api/v1/core/fiscal/closings/2026-08/previa';

let gestor: { Authorization: string };

async function entrar(userId: string, perfil: string, companyId = LOJA) {
  const res = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: String(res.body.user.id),
    login: String(res.body.user.login),
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    refreshToken: String(res.body.refreshToken),
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const g = await entrar('chefe-corte', 'gestor');
  gestor = g.auth;
});

describe('o access token antigo cai no gesto — não quando vence', () => {
  it('[C1] desativado: a próxima requisição com o token já emitido é 401', async () => {
    const alvo = await entrar('caixa-desligado', 'gerente_loja');
    expect((await request(app).get(ROTA_DE_GERENTE).set(alvo.auth)).status).toBe(200);

    const desliga = await request(app)
      .post(`/api/v1/core/team/${alvo.id}/active`)
      .set(gestor)
      .send({ active: false });
    expect(desliga.status).toBe(200);

    const depois = await request(app).get(ROTA_DE_GERENTE).set(alvo.auth);
    expect(depois.status).toBe(401);
    expect(depois.body.error.code).toBe('API_SESSION_ENDED');
  });

  it('[C2] rebaixado: o token já emitido passa a valer o perfil DE AGORA', async () => {
    const alvo = await entrar('gerente-rebaixado-na-hora', 'gerente_loja');
    expect((await request(app).get(ROTA_DE_GERENTE).set(alvo.auth)).status).toBe(200);

    const rebaixa = await request(app)
      .patch(`/api/v1/core/team/${alvo.id}`)
      .set(gestor)
      .send({ profileCode: 'atendente' });
    expect(rebaixa.status).toBe(200);

    // O MESMO token, sem refresh: a rota de gerente recusa o atendente.
    const recusada = await request(app).get(ROTA_DE_GERENTE).set(alvo.auth);
    expect(recusada.status).toBe(403);
    // E a resposta avisa a tela do perfil em vigor, para ela redesenhar o menu.
    expect(recusada.headers['x-perfil-em-vigor']).toBe('atendente');

    // E a sessão consultada diz o perfil que vale, não o que o token carrega.
    const sessao = await request(app).get('/api/v1/auth/session').set(alvo.auth);
    expect(sessao.status).toBe(200);
    expect(sessao.body.session.profileCodes).toEqual(['atendente']);
  });

  it('promovido: o mesmo token já alcança o que o perfil novo alcança', async () => {
    const alvo = await entrar('atendente-promovido', 'atendente');
    expect((await request(app).get(ROTA_DE_GERENTE).set(alvo.auth)).status).toBe(403);

    const promove = await request(app)
      .patch(`/api/v1/core/team/${alvo.id}`)
      .set(gestor)
      .send({ profileCode: 'gerente_loja' });
    expect(promove.status).toBe(200);

    expect((await request(app).get(ROTA_DE_GERENTE).set(alvo.auth)).status).toBe(200);
  });

  it('[C4] desvinculado da operação: o token daquela operação é 401', async () => {
    const alvo = await entrar('estoquista-desvinculado', 'estoquista');
    getConnection()
      .prepare('DELETE FROM core_user_companies WHERE user_id = ? AND company_id = ?')
      .run(alvo.id, LOJA);

    const depois = await request(app).get('/api/v1/core/products').set(alvo.auth);
    expect(depois.status).toBe(401);
    expect(depois.body.error.code).toBe('API_SESSION_ENDED');
  });

  it('removido desta operação pela tela: cai aqui, e segue trabalhando na outra', async () => {
    const alvo = await entrar('tecnico-duas-lojas', 'estoquista');
    upsertCompany({ id: OUTRA, slug: OUTRA, legalName: `${OUTRA} Ltda`, tradeName: OUTRA });
    linkUserToCompany(alvo.id, OUTRA, 'estoquista', false);

    const naOutra = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(alvo.auth)
      .send({ companyId: OUTRA, refreshToken: alvo.refreshToken });
    expect(naOutra.status).toBe(200);
    const authNaOutra = { Authorization: `Bearer ${naOutra.body.accessToken}` };

    const remove = await request(app)
      .post(`/api/v1/core/team/${alvo.id}/remove-from-company`)
      .set(gestor)
      .send({});
    expect(remove.status, JSON.stringify(remove.body)).toBe(200);

    expect((await request(app).get('/api/v1/core/products').set(alvo.auth)).status).toBe(401);
    expect((await request(app).get('/api/v1/core/products').set(authNaOutra)).status).toBe(200);
  });

  it('senha redefinida pela gestão: o token de antes do reset cai — quem tem a senha nova entra na etapa de troca', async () => {
    const alvo = await entrar('caixa-resetado', 'estoquista');
    const reset = await request(app)
      .post(`/api/v1/core/team/${alvo.id}/password`)
      .set(gestor)
      .send({ password: 'Provisoria@2026' });
    expect(reset.status).toBe(200);

    // Era esta a fresta que o GAP-PRD-202 deixou registrada: o token emitido
    // antes do reset não carrega a marca da senha provisória e valia até vencer.
    expect((await request(app).get('/api/v1/core/products').set(alvo.auth)).status).toBe(401);

    const novo = await request(app).post('/api/v1/auth/login').send({ login: alvo.login, password: 'Provisoria@2026' });
    expect(novo.status).toBe(200);
    const comProvisoria = await request(app)
      .get('/api/v1/core/products')
      .set({ Authorization: `Bearer ${novo.body.accessToken}` });
    expect(comProvisoria.status).toBe(403);
    expect(comProvisoria.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');
  });

  it('troca da PRÓPRIA senha: todas as sessões caem na hora, e o login com a nova entra', async () => {
    const alvo = await entrar('caixa-troca-propria', 'estoquista');
    const troca = await request(app)
      .post('/api/v1/auth/password')
      .set(alvo.auth)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'SoMinha@2026x' });
    expect(troca.status).toBe(204);

    // Se a troca foi porque a senha vazou, a sessão do ladrão não sobrevive
    // nem uma requisição.
    expect((await request(app).get('/api/v1/core/products').set(alvo.auth)).status).toBe(401);

    const novo = await request(app).post('/api/v1/auth/login').send({ login: alvo.login, password: 'SoMinha@2026x' });
    expect(novo.status).toBe(200);
    expect(
      (await request(app).get('/api/v1/core/products').set({ Authorization: `Bearer ${novo.body.accessToken}` })).status,
    ).toBe(200);
  });

  it('terminal do PDV: desativar o usuário do terminal corta a sessão do terminal na hora', async () => {
    const caixa = await entrar('caixa-terminal', 'estoquista');
    const enroll = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(gestor)
      .send({ userId: caixa.id, label: 'Caixa 1' });
    expect(enroll.status).toBe(201);
    const terminal = await request(app).post('/api/v1/auth/device/login').send({ deviceToken: enroll.body.deviceToken });
    expect(terminal.status).toBe(200);
    const authDoTerminal = { Authorization: `Bearer ${terminal.body.accessToken}` };
    expect((await request(app).get('/api/v1/core/products').set(authDoTerminal)).status).toBe(200);

    await request(app).post(`/api/v1/core/team/${caixa.id}/active`).set(gestor).send({ active: false });
    expect((await request(app).get('/api/v1/core/products').set(authDoTerminal)).status).toBe(401);
  });

  it('as rotas da etapa de troca também conferem a conta: desligado não consulta nem a sessão', async () => {
    const alvo = await entrar('desligado-etapa', 'atendente');
    await request(app).post(`/api/v1/core/team/${alvo.id}/active`).set(gestor).send({ active: false });
    expect((await request(app).get('/api/v1/auth/session').set(alvo.auth)).status).toBe(401);
  });
});

describe('quem não mudou nada não percebe nada', () => {
  it('o token segue valendo, requisição após requisição', async () => {
    const alvo = await entrar('caixa-tranquilo', 'gerente_loja');
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get(ROTA_DE_GERENTE).set(alvo.auth);
      expect(res.status).toBe(200);
      // Perfil igual ao do token: nada a avisar.
      expect(res.headers['x-perfil-em-vigor']).toBeUndefined();
    }
  });

  it('mexer em OUTRA pessoa não derruba ninguém além dela', async () => {
    const fica = await entrar('fica-na-loja', 'gerente_loja');
    const sai = await entrar('sai-da-loja', 'atendente');
    await request(app).post(`/api/v1/core/team/${sai.id}/active`).set(gestor).send({ active: false });
    expect((await request(app).get(ROTA_DE_GERENTE).set(fica.auth)).status).toBe(200);
  });

  it('token sem Bearer e token inválido continuam 401 com os códigos de sempre', async () => {
    const semToken = await request(app).get('/api/v1/core/products');
    expect(semToken.status).toBe(401);
    expect(semToken.body.error.code).toBe('API_AUTHENTICATION_REQUIRED');
    const invalido = await request(app).get('/api/v1/core/products').set({ Authorization: 'Bearer x.y.z' });
    expect(invalido.status).toBe(401);
    expect(invalido.body.error.code).toBe('API_INVALID_TOKEN');
  });
});
