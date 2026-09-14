/**
 * Gestão de equipe: técnicos, perfis e vínculo de oficina.
 *
 * O que estes testes protegem, acima de tudo, é o ISOLAMENTO. Menu escondido
 * não é segurança: quem tem o token pode chamar a API direto. Por isso todo
 * teste de isolamento aqui bate na rota, não na navegação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  linkUserToWorkshop,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const PASSWORD = 'Teste@Equipe2026';

async function makeActor(
  login: string,
  companyId: string,
  profile: string,
  workshopId?: string,
): Promise<{ auth: { Authorization: string }; userId: string }> {
  const userId = await upsertUser({ login, displayName: login, password: PASSWORD });
  linkUserToCompany(userId, companyId, profile, true);
  if (workshopId) linkUserToWorkshop(userId, workshopId, 'mecanico');
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: PASSWORD });
  expect(res.status).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

function workshopIdOf(slug: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

let oficinaCo: string;
let precoJustoCo: string;
let mobilidade: string;
let celulares: string;

beforeEach(() => {
  resetDbForTests();
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  precoJustoCo = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  ensureOfficialWorkshops();
  mobilidade = workshopIdOf('oficina-mobilidade');
  celulares = workshopIdOf('oficina-celulares');
});

describe('cadastro de técnico', () => {
  it('cria mecânico vinculado à oficina, sem expor senha nem hash', async () => {
    const gestor = await makeActor('GESTOR1', oficinaCo, 'gerente_oficina', mobilidade);

    const res = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'ROBERTOMECANICO',
      displayName: 'Roberto Mecânico',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });

    expect(res.status).toBe(201);
    expect(res.body.login).toBe('ROBERTOMECANICO');
    expect(res.body.profileCode).toBe('mecanico');
    expect(res.body.workshops).toHaveLength(1);
    expect(res.body.workshops[0].slug).toBe('oficina-mobilidade');

    // Senha provisória: quem recebe troca no primeiro acesso.
    expect(res.body.mustChangePassword).toBe(true);

    // Nada que sirva para adivinhar a credencial pode sair na resposta.
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('Provisoria@2026');
    expect(corpo).not.toContain('argon2');
    expect(corpo).not.toMatch(/password_hash|passwordHash|session_version/);
  });

  it('login repetido é recusado em vez de sobrescrever a senha de quem já existe', async () => {
    const gestor = await makeActor('GESTOR2', oficinaCo, 'gerente_oficina', mobilidade);
    const vitima = await makeActor('JAEXISTE', oficinaCo, 'mecanico', mobilidade);

    const res = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'JAEXISTE',
      displayName: 'Impostor',
      profileCode: 'mecanico',
      password: 'OutraSenha@2026',
      workshopIds: [mobilidade],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_LOGIN_TAKEN');

    // O ponto do teste: a senha da pessoa que já existia continua valendo.
    const aindaEntra = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'JAEXISTE', password: PASSWORD });
    expect(aindaEntra.status).toBe(200);
    expect(aindaEntra.body.user?.id ?? vitima.userId).toBeTruthy();
  });

  it('perfil de oficina sem oficina vinculada é recusado', async () => {
    const gestor = await makeActor('GESTOR3', oficinaCo, 'gerente_oficina', mobilidade);
    const res = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'SEMOFICINA',
      displayName: 'Sem Oficina',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_LINK_REQUIRED');
  });

  it('senha curta é recusada antes de criar o usuário', async () => {
    const gestor = await makeActor('GESTOR4', oficinaCo, 'gerente_oficina', mobilidade);
    const res = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'FRACA',
      displayName: 'Fraca',
      profileCode: 'mecanico',
      password: '123',
      workshopIds: [mobilidade],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PASSWORD_WEAK');

    const criado = getConnection()
      .prepare('SELECT id FROM core_users WHERE login = ?')
      .get('FRACA');
    expect(criado).toBeUndefined();
  });

  it('não deixa fabricar um admin_geral pela tela de equipe', async () => {
    const gestor = await makeActor('GESTOR5', oficinaCo, 'gerente_oficina', mobilidade);
    const res = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'ESCALADA',
      displayName: 'Escalada',
      profileCode: 'admin_geral',
      password: 'Provisoria@2026',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PROFILE_INVALID');
  });
});

describe('isolamento entre oficinas — via API, não via menu', () => {
  it('gestor da Oficina não vincula técnico à oficina do Preço Justo', async () => {
    const gestor = await makeActor('GESTOR6', oficinaCo, 'gerente_oficina', mobilidade);
    const res = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'INVASOR',
      displayName: 'Invasor',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [celulares],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_FORBIDDEN');
  });

  it('mecânico da mobilidade recebe 403 ao pedir a equipe da oficina de celulares', async () => {
    const mecanico = await makeActor('MECMOB', oficinaCo, 'mecanico', mobilidade);
    const res = await request(app)
      .get(`/api/v1/core/team?workshopId=${celulares}`)
      .set(mecanico.auth);
    // Mecânico não administra equipe: barra no perfil, antes mesmo da oficina.
    expect(res.status).toBe(403);
  });

  it('gestor do Preço Justo não enxerga a equipe da Oficina', async () => {
    const daOficina = await makeActor('GESTOR7', oficinaCo, 'gerente_oficina', mobilidade);
    await request(app).post('/api/v1/core/team').set(daOficina.auth).send({
      login: 'ROBERTOMOB',
      displayName: 'Roberto',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });

    const doPrecoJusto = await makeActor('GESTOR8', precoJustoCo, 'gerente_oficina', celulares);
    const res = await request(app).get('/api/v1/core/team').set(doPrecoJusto.auth);

    expect(res.status).toBe(200);
    const logins = (res.body.items as { login: string }[]).map((i) => i.login);
    expect(logins).not.toContain('ROBERTOMOB');
  });

  it('gestor de outra operação não desativa usuário alheio nem sabendo o id', async () => {
    const daOficina = await makeActor('GESTOR9', oficinaCo, 'gerente_oficina', mobilidade);
    const criado = await request(app).post('/api/v1/core/team').set(daOficina.auth).send({
      login: 'ALVOMOB',
      displayName: 'Alvo',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });

    const forasteiro = await makeActor('GESTOR10', precoJustoCo, 'gerente_oficina', celulares);
    const res = await request(app)
      .post(`/api/v1/core/team/${criado.body.id}/active`)
      .set(forasteiro.auth)
      .send({ active: false });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_USER_NOT_IN_COMPANY');

    // E o alvo continua ativo.
    const alvo = getConnection()
      .prepare('SELECT active FROM core_users WHERE id = ?')
      .get(criado.body.id) as { active: number };
    expect(alvo.active).toBe(1);
  });

  it('forasteiro não redefine a senha de usuário de outra operação', async () => {
    const daOficina = await makeActor('GESTOR11', oficinaCo, 'gerente_oficina', mobilidade);
    const criado = await request(app).post('/api/v1/core/team').set(daOficina.auth).send({
      login: 'ALVOSENHA',
      displayName: 'Alvo',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });

    const forasteiro = await makeActor('GESTOR12', precoJustoCo, 'gerente_oficina', celulares);
    const res = await request(app)
      .post(`/api/v1/core/team/${criado.body.id}/password`)
      .set(forasteiro.auth)
      .send({ password: 'Sequestrada@2026' });

    expect(res.status).toBe(404);

    // A senha original continua sendo a que funciona.
    const entra = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'ALVOSENHA', password: 'Provisoria@2026' });
    expect(entra.status).toBe(200);
  });

  it('mecânico não cria usuário', async () => {
    const mecanico = await makeActor('MECSIMPLES', oficinaCo, 'mecanico', mobilidade);
    const res = await request(app).post('/api/v1/core/team').set(mecanico.auth).send({
      login: 'NOVO',
      displayName: 'Novo',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });
    expect(res.status).toBe(403);
  });
});

describe('ciclo de vida do acesso', () => {
  it('desativar derruba a sessão e barra o login seguinte', async () => {
    const gestor = await makeActor('GESTOR13', oficinaCo, 'gerente_oficina', mobilidade);
    const criado = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'DESLIGADO',
      displayName: 'Desligado',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });

    const antes = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'DESLIGADO', password: 'Provisoria@2026' });
    expect(antes.status).toBe(200);

    const off = await request(app)
      .post(`/api/v1/core/team/${criado.body.id}/active`)
      .set(gestor.auth)
      .send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);

    const depois = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'DESLIGADO', password: 'Provisoria@2026' });
    expect(depois.status).not.toBe(200);

    // Desligar não apaga: o histórico de OS precisa continuar apontando
    // para quem fez o serviço.
    const ainda = getConnection()
      .prepare('SELECT id FROM core_users WHERE id = ?')
      .get(criado.body.id);
    expect(ainda).toBeDefined();
  });

  it('gestor não desativa o próprio acesso', async () => {
    const gestor = await makeActor('GESTOR14', oficinaCo, 'gerente_oficina', mobilidade);
    const res = await request(app)
      .post(`/api/v1/core/team/${gestor.userId}/active`)
      .set(gestor.auth)
      .send({ active: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_CANNOT_DEACTIVATE_SELF');
  });

  it('reset de senha invalida a anterior e marca troca no primeiro acesso', async () => {
    const gestor = await makeActor('GESTOR15', oficinaCo, 'gerente_oficina', mobilidade);
    const criado = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'RESETAR',
      displayName: 'Resetar',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });

    const res = await request(app)
      .post(`/api/v1/core/team/${criado.body.id}/password`)
      .set(gestor.auth)
      .send({ password: 'NovaSenha@2026' });
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);

    const antiga = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'RESETAR', password: 'Provisoria@2026' });
    expect(antiga.status).not.toBe(200);

    const nova = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'RESETAR', password: 'NovaSenha@2026' });
    expect(nova.status).toBe(200);
  });

  it('trocar a oficina do técnico substitui o vínculo, não acumula', async () => {
    // Um gestor com alcance às duas oficinas precisa existir para o caso ser
    // possível: dentro de uma empresa só, é a transferência entre unidades.
    const gestor = await makeActor('GESTOR16', oficinaCo, 'gestor');
    const outra = getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'oficina-extra', 'Oficina Extra', 'mobility', 1, ?) RETURNING id`,
      )
      .get('ws-extra', oficinaCo, new Date().toISOString()) as { id: string };

    const criado = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'TRANSFERIDO',
      displayName: 'Transferido',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });
    expect(criado.status).toBe(201);

    const movido = await request(app)
      .patch(`/api/v1/core/team/${criado.body.id}`)
      .set(gestor.auth)
      .send({ workshopIds: [outra.id] });

    expect(movido.status).toBe(200);
    expect(movido.body.workshops).toHaveLength(1);
    expect(movido.body.workshops[0].slug).toBe('oficina-extra');
  });

  it('registra o último acesso a cada login', async () => {
    const gestor = await makeActor('GESTOR17', oficinaCo, 'gerente_oficina', mobilidade);
    const criado = await request(app).post('/api/v1/core/team').set(gestor.auth).send({
      login: 'ACESSO',
      displayName: 'Acesso',
      profileCode: 'mecanico',
      password: 'Provisoria@2026',
      workshopIds: [mobilidade],
    });
    expect(criado.body.lastLoginAt).toBeNull();

    await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'ACESSO', password: 'Provisoria@2026' });

    const lista = await request(app).get('/api/v1/core/team').set(gestor.auth);
    const alvo = (lista.body.items as { login: string; lastLoginAt: string | null }[]).find(
      (i) => i.login === 'ACESSO',
    );
    expect(alvo?.lastLoginAt).toBeTruthy();
  });
});
