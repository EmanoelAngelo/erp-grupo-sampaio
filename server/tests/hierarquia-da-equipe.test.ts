/**
 * ============================================================================
 * A HIERARQUIA DA EQUIPE — GAP-PRD-010 e GAP-PRD-152
 * ============================================================================
 *
 * O harness da auditoria (a3-perfis-tenant, apagado) mediu, com login Argon2id
 * de verdade, cinco 200 onde devia haver 403:
 *
 *   [A1] gerente_loja troca a senha do admin_geral;
 *   [A2] gerente_loja desativa o admin_geral;
 *   [A3] gerente_loja rebaixa o gestor a estoquista por PATCH;
 *   [A4] gerente_loja rebaixa o admin_geral a atendente por PATCH;
 *   [A5] gerente_loja troca nome e e-mail do gestor.
 *
 * E o [A6]: um gestor de UMA empresa desativa o admin_geral do grupo nas seis,
 * porque `core_users.active` é da pessoa e não do vínculo.
 *
 * Os casos abaixo reproduzem os seis pela rota, e cobram também o outro lado:
 * o gerente continua administrando a equipe dele (travar isso seria trocar a
 * escalada por uma loja que não se administra), e a conta que entra em várias
 * operações pode ser tirada só DESTA, sem desligar as outras.
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
const SENHA = 'Teste@Hierarquia2026';
const CORE = '/api/v1/core';

let lojaA: string;
let lojaB: string;
let oficina: string;
let celulares: string;
let mobilidade: string;

function bancada(slug: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

/** Uma conta com um vínculo por operação: [empresa, perfil, bancada?]. */
async function conta(login: string, vinculos: [string, string, string?][]): Promise<string> {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  vinculos.forEach(([empresa, perfil, oficinaId], i) => {
    linkUserToCompany(id, empresa, perfil, i === 0);
    if (oficinaId) linkUserToWorkshop(id, oficinaId, 'mecanico');
  });
  return id;
}

async function sessao(login: string, companyId: string): Promise<{ Authorization: string }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

function linhaDe(userId: string): { active: number; display_name: string; email: string | null } {
  return getConnection()
    .prepare('SELECT active, display_name, email FROM core_users WHERE id = ?')
    .get(userId) as { active: number; display_name: string; email: string | null };
}

function perfilEm(userId: string, companyId: string): string | undefined {
  const row = getConnection()
    .prepare('SELECT profile_code FROM core_user_companies WHERE user_id = ? AND company_id = ?')
    .get(userId, companyId) as { profile_code?: string } | undefined;
  return row?.profile_code;
}

beforeEach(() => {
  resetDbForTests();
  lojaA = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  lojaB = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  oficina = upsertCompany({ slug: 'oficina', legalName: 'Oficina Ltda', tradeName: 'Oficina', kind: 'workshop' });
  ensureOfficialWorkshops();
  celulares = bancada('oficina-celulares');
  mobilidade = bancada('oficina-mobilidade');
});

// ---------------------------------------------------------------------------
// GAP-PRD-010
// ---------------------------------------------------------------------------

describe('GAP-PRD-010 — gerente não toma, não desativa e não rebaixa conta de dono', () => {
  let admin: string;
  let gestor: string;
  let gerente: { Authorization: string };

  beforeEach(async () => {
    admin = await conta('ADMIN.H', [[lojaA, 'admin_geral'], [lojaB, 'admin_geral']]);
    gestor = await conta('GESTOR.H', [[lojaA, 'gestor'], [lojaB, 'gestor']]);
    await conta('GERENTE.H', [[lojaA, 'gerente_loja']]);
    gerente = await sessao('GERENTE.H', lojaA);
  });

  it('[A1] gerente de loja NÃO troca a senha do admin_geral — e a senha dele continua valendo', async () => {
    const res = await request(app)
      .post(`${CORE}/team/${admin}/password`)
      .set(gerente)
      .send({ password: 'SenhaTomada@2026' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');
    expect(res.body.error.message).toContain('admin_geral');

    const tomada = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'ADMIN.H', password: 'SenhaTomada@2026', companyId: lojaA });
    expect(tomada.status).toBe(401);
    await sessao('ADMIN.H', lojaA);
  });

  it('[A2] gerente de loja NÃO desativa o admin_geral', async () => {
    const res = await request(app)
      .post(`${CORE}/team/${admin}/active`)
      .set(gerente)
      .send({ active: false });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');
    expect(linhaDe(admin).active).toBe(1);
  });

  it('[A3] gerente de loja NÃO rebaixa o gestor por PATCH', async () => {
    const res = await request(app)
      .patch(`${CORE}/team/${gestor}`)
      .set(gerente)
      .send({ profileCode: 'estoquista' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');
    expect(perfilEm(gestor, lojaA)).toBe('gestor');
  });

  it('[A4] gerente de loja NÃO rebaixa o admin_geral por PATCH', async () => {
    const res = await request(app)
      .patch(`${CORE}/team/${admin}`)
      .set(gerente)
      .send({ profileCode: 'atendente' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');
    expect(perfilEm(admin, lojaA)).toBe('admin_geral');
  });

  it('[A5] gerente de loja NÃO troca nome nem e-mail do gestor', async () => {
    const res = await request(app)
      .patch(`${CORE}/team/${gestor}`)
      .set(gerente)
      .send({ displayName: 'Impostor', email: 'impostor@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');
    const linha = linhaDe(gestor);
    expect(linha.display_name).toBe('GESTOR.H');
    expect(linha.email).toBeNull();
  });

  it('nem mexe só nas bancadas do admin_geral — o PATCH confere o alvo antes de qualquer campo', async () => {
    const res = await request(app)
      .patch(`${CORE}/team/${admin}`)
      .set(gerente)
      .send({ workshopIds: [celulares] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');
  });

  it('gerente de OFICINA recebe a mesma recusa — a régua é do perfil, não da loja', async () => {
    await conta('GERENTE.OF', [[oficina, 'gerente_oficina', mobilidade]]);
    const adminDaOficina = await conta('ADMIN.OF', [[oficina, 'admin_geral']]);
    const gerenteOf = await sessao('GERENTE.OF', oficina);

    const senha = await request(app)
      .post(`${CORE}/team/${adminDaOficina}/password`)
      .set(gerenteOf)
      .send({ password: 'SenhaTomada@2026' });
    expect(senha.status).toBe(403);

    const rebaixa = await request(app)
      .patch(`${CORE}/team/${adminDaOficina}`)
      .set(gerenteOf)
      .send({ profileCode: 'mecanico', workshopIds: [mobilidade] });
    expect(rebaixa.status).toBe(403);
    expect(perfilEm(adminDaOficina, oficina)).toBe('admin_geral');
  });

  it('o gerente CONTINUA administrando a equipe dele — inclusive outro gerente, que é par', async () => {
    const atendente = await conta('ATENDENTE.H', [[lojaA, 'atendente']]);
    const outroGerente = await conta('GERENTE2.H', [[lojaA, 'gerente_loja']]);

    const promove = await request(app)
      .patch(`${CORE}/team/${atendente}`)
      .set(gerente)
      .send({ profileCode: 'estoquista', displayName: 'Atendente Renomeado' });
    expect(promove.status, JSON.stringify(promove.body)).toBe(200);
    expect(promove.body.profileCode).toBe('estoquista');

    const reset = await request(app)
      .post(`${CORE}/team/${outroGerente}/password`)
      .set(gerente)
      .send({ password: 'Provisoria@2026' });
    expect(reset.status).toBe(200);
    expect(reset.body.mustChangePassword).toBe(true);
  });

  it('gestor e admin_geral são PARES: um mexe na conta do outro', async () => {
    const doAdmin = await sessao('ADMIN.H', lojaA);
    const renomeia = await request(app)
      .patch(`${CORE}/team/${gestor}`)
      .set(doAdmin)
      .send({ displayName: 'Gestor do Grupo' });
    expect(renomeia.status, JSON.stringify(renomeia.body)).toBe(200);

    const doGestor = await sessao('GESTOR.H', lojaA);
    const reset = await request(app)
      .post(`${CORE}/team/${admin}/password`)
      .set(doGestor)
      .send({ password: 'Provisoria@2026' });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  });

  it('a lista diz à tela o que ela pode oferecer — e não oferece mexer no dono', async () => {
    const res = await request(app).get(`${CORE}/team`).set(gerente);
    expect(res.status).toBe(200);
    const porLogin = new Map(
      (res.body.items as { login: string; acoes: Record<string, unknown> }[]).map((m) => [m.login, m.acoes]),
    );

    expect(porLogin.get('ADMIN.H')).toMatchObject({
      gerirNaOperacao: false,
      gerirConta: false,
      removerDaOperacao: false,
    });
    expect(porLogin.get('GESTOR.H')).toMatchObject({ gerirNaOperacao: false, gerirConta: false });
    expect(String(porLogin.get('GESTOR.H')?.motivo)).toContain('gestor');
    expect(porLogin.get('GERENTE.H')).toMatchObject({ gerirNaOperacao: true, gerirConta: true });
  });
});

// ---------------------------------------------------------------------------
// GAP-PRD-152
// ---------------------------------------------------------------------------

describe('GAP-PRD-152 — a conta é uma, as operações são várias', () => {
  it('[A6] gestor de UMA empresa não desativa o admin_geral que entra em outras', async () => {
    const admin = await conta('ADMIN.G', [[lojaA, 'admin_geral'], [lojaB, 'admin_geral']]);
    await conta('GESTOR.SO.A', [[lojaA, 'gestor']]);
    const gestorDeA = await sessao('GESTOR.SO.A', lojaA);

    const res = await request(app)
      .post(`${CORE}/team/${admin}/active`)
      .set(gestorDeA)
      .send({ active: false });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TARGET_BEYOND_YOUR_REACH');
    expect(res.body.error.details).toMatchObject({ outrasOperacoes: 1 });
    expect(linhaDe(admin).active).toBe(1);
  });

  it('o gestor que responde pelas mesmas operações desativa — e o corte vale para todas', async () => {
    const admin = await conta('ADMIN.G2', [[lojaA, 'admin_geral'], [lojaB, 'admin_geral']]);
    await conta('GESTOR.AB', [[lojaA, 'gestor'], [lojaB, 'gestor']]);
    const gestorDoGrupo = await sessao('GESTOR.AB', lojaA);

    const res = await request(app)
      .post(`${CORE}/team/${admin}/active`)
      .set(gestorDoGrupo)
      .send({ active: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const naB = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'ADMIN.G2', password: SENHA, companyId: lojaB });
    expect(naB.status).toBe(401);
  });

  it('gerente de A não troca a senha de quem também trabalha numa operação onde ele não manda', async () => {
    const mecanico = await conta('MEC.AW', [[lojaA, 'mecanico', celulares], [oficina, 'mecanico', mobilidade]]);
    await conta('GERENTE.A', [[lojaA, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A', lojaA);

    const senha = await request(app)
      .post(`${CORE}/team/${mecanico}/password`)
      .set(gerente)
      .send({ password: 'Sequestrada@2026' });
    expect(senha.status).toBe(403);
    expect(senha.body.error.code).toBe('CORE_TARGET_BEYOND_YOUR_REACH');

    const desativa = await request(app)
      .post(`${CORE}/team/${mecanico}/active`)
      .set(gerente)
      .send({ active: false });
    expect(desativa.status).toBe(403);
    expect(linhaDe(mecanico).active).toBe(1);

    await sessao('MEC.AW', oficina);
  });

  it('mas continua mexendo no que é DAQUI: perfil e bancadas — sem apagar a bancada da outra operação', async () => {
    const mecanico = await conta('MEC.AW2', [[lojaA, 'mecanico', celulares], [oficina, 'mecanico', mobilidade]]);
    await conta('GERENTE.A2', [[lojaA, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A2', lojaA);

    // A tela manda nome e e-mail junto, INTACTOS — resalvar não é mexer na conta.
    const res = await request(app)
      .patch(`${CORE}/team/${mecanico}`)
      .set(gerente)
      .send({ displayName: 'MEC.AW2', email: null, profileCode: 'mecanico', workshopIds: [celulares] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const bancadas = getConnection()
      .prepare('SELECT workshop_id FROM core_workshop_members WHERE user_id = ? ORDER BY workshop_id')
      .all(mecanico) as { workshop_id: string }[];
    expect(bancadas.map((b) => b.workshop_id).sort()).toEqual([celulares, mobilidade].sort());

    const renomeia = await request(app)
      .patch(`${CORE}/team/${mecanico}`)
      .set(gerente)
      .send({ displayName: 'Outro Nome' });
    expect(renomeia.status).toBe(403);
    expect(renomeia.body.error.code).toBe('CORE_TARGET_BEYOND_YOUR_REACH');
  });

  it('"Remover desta operação" tira o vínculo daqui e deixa a pessoa entrando nas outras', async () => {
    const mecanico = await conta('MEC.AW3', [[lojaA, 'mecanico', celulares], [oficina, 'mecanico', mobilidade]]);
    await conta('GERENTE.A3', [[lojaA, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A3', lojaA);

    const lista = await request(app).get(`${CORE}/team`).set(gerente);
    const oferta = (lista.body.items as { login: string; acoes: Record<string, unknown> }[]).find(
      (m) => m.login === 'MEC.AW3',
    )!.acoes;
    expect(oferta).toMatchObject({
      gerirNaOperacao: true,
      gerirConta: false,
      removerDaOperacao: true,
      outrasOperacoes: 1,
    });

    const res = await request(app).post(`${CORE}/team/${mecanico}/remove-from-company`).set(gerente).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: mecanico, removedFromCompany: true });

    expect(perfilEm(mecanico, lojaA)).toBeUndefined();
    expect(perfilEm(mecanico, oficina)).toBe('mecanico');
    expect(linhaDe(mecanico).active).toBe(1);
    const bancadas = getConnection()
      .prepare('SELECT workshop_id FROM core_workshop_members WHERE user_id = ?')
      .all(mecanico) as { workshop_id: string }[];
    expect(bancadas.map((b) => b.workshop_id)).toEqual([mobilidade]);

    const emA = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'MEC.AW3', password: SENHA, companyId: lojaA });
    expect(emA.status).toBe(403);
    await sessao('MEC.AW3', oficina);

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'team.removed_from_company' AND entity_id = ?")
      .get(mecanico) as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('o último vínculo não se remove — para tirar o acesso inteiro existe Desativar', async () => {
    const atendente = await conta('ATEND.SO.A', [[lojaA, 'atendente']]);
    await conta('GERENTE.A4', [[lojaA, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A4', lojaA);

    const res = await request(app).post(`${CORE}/team/${atendente}/remove-from-company`).set(gerente).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_LAST_COMPANY_LINK');
    expect(perfilEm(atendente, lojaA)).toBe('atendente');
  });

  it('vínculo de admin_geral não se remove pela tela — como a criação dele, é de instalação', async () => {
    const admin = await conta('ADMIN.G3', [[lojaA, 'admin_geral'], [lojaB, 'admin_geral']]);
    await conta('GESTOR.SO.A3', [[lojaA, 'gestor']]);
    const gestorDeA = await sessao('GESTOR.SO.A3', lojaA);

    const res = await request(app).post(`${CORE}/team/${admin}/remove-from-company`).set(gestorDeA).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_INSTALL_ONLY_PROFILE');
    expect(perfilEm(admin, lojaA)).toBe('admin_geral');
  });

  it('gerente não remove dono da operação, e ninguém remove a si mesmo', async () => {
    const gestor = await conta('GESTOR.G4', [[lojaA, 'gestor'], [lojaB, 'gestor']]);
    const gerenteId = await conta('GERENTE.A5', [[lojaA, 'gerente_loja'], [lojaB, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A5', lojaA);

    const dono = await request(app).post(`${CORE}/team/${gestor}/remove-from-company`).set(gerente).send({});
    expect(dono.status).toBe(403);
    expect(dono.body.error.code).toBe('CORE_TARGET_ABOVE_YOURS');

    const proprio = await request(app).post(`${CORE}/team/${gerenteId}/remove-from-company`).set(gerente).send({});
    expect(proprio.status).toBe(400);
    expect(proprio.body.error.code).toBe('CORE_CANNOT_REMOVE_SELF');
  });

  it('a remoção se desfaz: "dar acesso a uma conta que já existe" religa pelo login, sem tocar na senha', async () => {
    const mecanico = await conta('MEC.AW6', [[lojaA, 'mecanico', celulares], [oficina, 'mecanico', mobilidade]]);
    await conta('GERENTE.A6', [[lojaA, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A6', lojaA);
    await request(app).post(`${CORE}/team/${mecanico}/remove-from-company`).set(gerente).send({});

    const volta = await request(app)
      .post(`${CORE}/team/link`)
      .set(gerente)
      .send({ login: 'mec.aw6', profileCode: 'mecanico', workshopIds: [celulares] });
    expect(volta.status, JSON.stringify(volta.body)).toBe(201);
    expect(volta.body).toMatchObject({ id: mecanico, profileCode: 'mecanico' });
    expect(volta.body.workshops.map((w: { id: string }) => w.id)).toEqual([celulares]);
    expect(JSON.stringify(volta.body)).not.toMatch(/password_hash|passwordHash|argon2|session_version/);

    // Religar não reescreve a senha nem a marca como provisória.
    const entra = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'MEC.AW6', password: SENHA, companyId: lojaA });
    expect(entra.status).toBe(200);
    expect(entra.body.user.mustChangePassword).toBe(false);

    const deNovo = await request(app)
      .post(`${CORE}/team/link`)
      .set(gerente)
      .send({ login: 'MEC.AW6', profileCode: 'mecanico', workshopIds: [celulares] });
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.error.code).toBe('CORE_ALREADY_IN_COMPANY');
  });

  it('religar obedece a mesma régua da criação: gerente não entrega perfil de dono, e login inexistente é 404', async () => {
    await conta('FORA.DAQUI', [[lojaB, 'atendente']]);
    await conta('GERENTE.A7', [[lojaA, 'gerente_loja']]);
    const gerente = await sessao('GERENTE.A7', lojaA);

    const promove = await request(app)
      .post(`${CORE}/team/link`)
      .set(gerente)
      .send({ login: 'FORA.DAQUI', profileCode: 'gestor' });
    expect(promove.status).toBe(403);
    expect(promove.body.error.code).toBe('CORE_PROFILE_ABOVE_YOURS');

    const semOficina = await request(app)
      .post(`${CORE}/team/link`)
      .set(gerente)
      .send({ login: 'FORA.DAQUI', profileCode: 'mecanico', workshopIds: [] });
    expect(semOficina.status).toBe(400);
    expect(semOficina.body.error.code).toBe('CORE_WORKSHOP_LINK_REQUIRED');

    const alheia = await request(app)
      .post(`${CORE}/team/link`)
      .set(gerente)
      .send({ login: 'FORA.DAQUI', profileCode: 'mecanico', workshopIds: [mobilidade] });
    expect(alheia.status).toBe(403);
    expect(alheia.body.error.code).toBe('CORE_WORKSHOP_FORBIDDEN');

    const fantasma = await request(app)
      .post(`${CORE}/team/link`)
      .set(gerente)
      .send({ login: 'NINGUEM.COM.ESSE.LOGIN', profileCode: 'atendente' });
    expect(fantasma.status).toBe(404);
    expect(fantasma.body.error.code).toBe('CORE_USER_NOT_FOUND');
  });
});
