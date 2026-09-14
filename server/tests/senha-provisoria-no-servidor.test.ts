process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * SENHA PROVISÓRIA NÃO NAVEGA A API — GAP-PRD-202
 * ============================================================================
 *
 * A etapa de troca existia só no navegador: `Protected` mandava a sessão
 * provisória de volta para a porta, e a API servia TODAS as rotas com o token
 * emitido pela senha que a gestão conhece. Medido no harness da auditoria
 * (c1-golive-gaveta-e-nova-empresa): gerente recém-criado, com
 * `mustChangePassword=true`, fez `GET /core/products` com o token provisório e
 * recebeu 200. Quem conhece a provisória — a gestora que a digitou — operava
 * por HTTP em nome do novato, sem passar por tela nenhuma.
 *
 * O conserto: o login com a senha provisória emite um token MARCADO, e o
 * `authMiddleware` recusa token marcado com 403 `API_PASSWORD_CHANGE_REQUIRED`
 * em toda rota — menos nas três que a própria etapa de troca usa: trocar a
 * senha, consultar a sessão e sair.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Gestora@Senha2026';
const PROVISORIA = 'Provisoria@2026';

let loja: string;
let outraLoja: string;
let gestora: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  outraLoja = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  const gestoraId = await upsertUser({ login: 'GESTORA.202', displayName: 'Gestora', password: SENHA });
  linkUserToCompany(gestoraId, loja, 'gestor', true);
  linkUserToCompany(gestoraId, outraLoja, 'gestor', false);
  const login = await request(app).post('/api/v1/auth/login').send({ login: 'GESTORA.202', password: SENHA, companyId: loja });
  expect(login.status).toBe(200);
  gestora = { Authorization: `Bearer ${login.body.accessToken as string}` };
});

/** O caminho real: a gestora cadastra o gerente pela tela e entrega a provisória. */
async function gerenteProvisorio(): Promise<{ id: string; accessToken: string; refreshToken: string }> {
  const criado = await request(app).post('/api/v1/core/team').set(gestora).send({
    login: 'GERENTE.NOVO',
    displayName: 'Gerente Novo',
    profileCode: 'gerente_loja',
    password: PROVISORIA,
  });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  const entrou = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GERENTE.NOVO', password: PROVISORIA, companyId: loja });
  expect(entrou.status).toBe(200);
  expect(entrou.body.user.mustChangePassword).toBe(true);
  return {
    id: String(criado.body.id),
    accessToken: String(entrou.body.accessToken),
    refreshToken: String(entrou.body.refreshToken),
  };
}

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('o token da senha provisória não opera o sistema', () => {
  it('ROTA_COM_SENHA_PROVISORIA: GET /core/products responde 403 API_PASSWORD_CHANGE_REQUIRED', async () => {
    const { accessToken } = await gerenteProvisorio();
    const res = await request(app).get('/api/v1/core/products').set(portador(accessToken));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');
    expect(res.body.error.message).toContain('senha provisória');
  });

  it('a recusa vale nos roteadores guardados por permissão, e vem ANTES da permissão', async () => {
    const { accessToken } = await gerenteProvisorio();
    // O CSC (`/fiscal/nfce/csc`) era o exemplo daqui; foi para o núcleo no
    // GAP-PRD-075. `/logistics/carriers` é roteador guardado por permissão também.
    for (const caminho of ['/api/v1/logistics/carriers', '/api/v1/payment-terminals/homologation', '/api/v1/auth/devices']) {
      const res = await request(app).get(caminho).set(portador(accessToken));
      expect(res.status, `${caminho} ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error.code, caminho).toBe('API_PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('nem escrita, nem troca de operação', async () => {
    const { accessToken } = await gerenteProvisorio();
    const escrita = await request(app)
      .post('/api/v1/core/team')
      .set(portador(accessToken))
      .send({ login: 'X', displayName: 'X', profileCode: 'atendente', password: 'Qualquer@2026' });
    expect(escrita.status).toBe(403);
    expect(escrita.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');

    const troca = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(portador(accessToken))
      .send({ companyId: loja });
    expect(troca.status).toBe(403);
    expect(troca.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');
  });

  it('renovar a sessão provisória não lava a marca', async () => {
    const { refreshToken } = await gerenteProvisorio();
    const renovada = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(renovada.status, JSON.stringify(renovada.body)).toBe(200);

    const res = await request(app).get('/api/v1/core/products').set(portador(String(renovada.body.accessToken)));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');
  });
});

describe('as três portas da etapa de troca continuam abertas', () => {
  it('consultar a sessão e sair', async () => {
    const { accessToken, refreshToken } = await gerenteProvisorio();
    const sessao = await request(app).get('/api/v1/auth/session').set(portador(accessToken));
    expect(sessao.status, JSON.stringify(sessao.body)).toBe(200);

    const sair = await request(app).post('/api/v1/auth/logout').set(portador(accessToken)).send({ refreshToken });
    expect(sair.status).toBe(204);
  });

  it('trocar a senha — e o login seguinte, com a senha só da pessoa, opera normalmente', async () => {
    const { accessToken } = await gerenteProvisorio();
    const troca = await request(app)
      .post('/api/v1/auth/password')
      .set(portador(accessToken))
      .send({ currentPassword: PROVISORIA, newPassword: 'SoMinha@2026' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(204);

    const entrou = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.NOVO', password: 'SoMinha@2026', companyId: loja });
    expect(entrou.status).toBe(200);
    expect(entrou.body.user.mustChangePassword).toBe(false);

    const res = await request(app).get('/api/v1/core/products').set(portador(String(entrou.body.accessToken)));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('quem não tem senha provisória não sente nada', () => {
  it('a gestora, com a senha dela, segue operando', async () => {
    const res = await request(app).get('/api/v1/core/products').set(gestora);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('o reset da gestão marca o PRÓXIMO login, e só ele', async () => {
    const { id } = await gerenteProvisorio();
    // O gerente troca e passa a operar.
    const primeiro = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.NOVO', password: PROVISORIA, companyId: loja });
    await request(app)
      .post('/api/v1/auth/password')
      .set(portador(String(primeiro.body.accessToken)))
      .send({ currentPassword: PROVISORIA, newPassword: 'SoMinha@2026' });

    // A gestora reinicia a senha: a nova provisória volta a travar o login.
    const reset = await request(app)
      .post(`/api/v1/core/team/${id}/password`)
      .set(gestora)
      .send({ password: 'OutraProvisoria@2026' });
    expect(reset.status).toBe(200);

    const comAProvisoria = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.NOVO', password: 'OutraProvisoria@2026', companyId: loja });
    const res = await request(app)
      .get('/api/v1/core/products')
      .set(portador(String(comAProvisoria.body.accessToken)));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');
  });
});
