process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * O RECORTE DE CAIXAS VALE EM TODA ROTA DA GAVETA — H-caixa-seguranca-10.
 *
 * O dono restringe um login ao "Caixa 1" (`acesso.terminais = [cx1]`). Antes,
 * só a ABERTURA conferia o recorte: movimento, resumo, fechamento e reabertura
 * usavam o `sessionId` da URL e a empresa do token, e `GET /cash/open` aceitava
 * `?terminalId=` livre. O operador consultava a gaveta do Caixa 2, pegava o id
 * e lançava sangria nela ou a fechava com uma contagem qualquer.
 *
 * O controle também é cobrado: no próprio caixa tudo passa, e o administrador
 * (todos os caixas) opera as duas gavetas — guarda que recusa todo mundo
 * passaria no teste de recusa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { ensurePermissionTemplates } from '../src/services/auth/AcessoService.js';
import { createTerminal } from '../src/services/core/TerminalService.js';

const app = createApp();
const SENHA = 'Senha@Gaveta2026';

let loja: string;
let cx1: string;
let cx2: string;
let admin: { Authorization: string };
let restrito: { Authorization: string };
let gaveta1: string;
let gaveta2: string;

async function entrar(login: string, companyId: string): Promise<{ Authorization: string }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function abrir(caixa: string): Promise<string> {
  const r = await request(app).post('/api/v1/core/cash/open').set(admin).send({ openingCents: 10_000, terminalId: caixa });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(r.body.id);
}

function movimentosDe(sessionId: string): number {
  return (getConnection()
    .prepare("SELECT COUNT(*) AS n FROM core_cash_movements WHERE session_id = ? AND movement_type <> 'opening'")
    .get(sessionId) as { n: number }).n;
}

beforeEach(async () => {
  resetDbForTests();
  ensurePermissionTemplates();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  const adminId = await upsertUser({ login: 'ADMIN.GAVETA', displayName: 'Administrador', password: SENHA });
  linkUserToCompany(adminId, loja, 'admin_geral', true);
  [cx1, cx2] = ['Caixa 1', 'Caixa 2'].map((name) => createTerminal({ companyId: loja, userId: adminId, name }).id);
  admin = await entrar('ADMIN.GAVETA', loja);

  const pessoa = await upsertUser({ login: 'SO.CAIXA1', displayName: 'Só o Caixa 1', password: SENHA });
  const cfg = await request(app)
    .put(`/api/v1/acesso/usuarios/${pessoa}`)
    .set(admin)
    .send({ empresas: [{ companyId: loja, vinculado: true, modelo: 'somente_pdv', terminais: [cx1] }] });
  expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
  restrito = await entrar('SO.CAIXA1', loja);

  gaveta1 = await abrir(cx1);
  gaveta2 = await abrir(cx2);
});

describe('a gaveta de outro caixa não é do operador restrito', () => {
  it('movimento na gaveta do Caixa 2: 403 com o nome do caixa, e nada gravado', async () => {
    const r = await request(app)
      .post(`/api/v1/core/cash/${gaveta2}/movements`)
      .set(restrito)
      .send({ movementType: 'supply', amountCents: 1_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error?.code).toBe('CORE_TERMINAL_OUT_OF_SCOPE');
    expect(r.body.error?.message).toContain('Caixa 2');
    expect(movimentosDe(gaveta2)).toBe(0);
  });

  it('resumo e fechamento da gaveta do Caixa 2: 403, e ela continua aberta', async () => {
    const resumo = await request(app).get(`/api/v1/core/cash/${gaveta2}/summary`).set(restrito);
    expect(resumo.status, JSON.stringify(resumo.body)).toBe(403);
    expect(resumo.body.error?.code).toBe('CORE_TERMINAL_OUT_OF_SCOPE');

    const fecha = await request(app).post(`/api/v1/core/cash/${gaveta2}/close`).set(restrito).send({ countedCents: 0 });
    expect(fecha.status, JSON.stringify(fecha.body)).toBe(403);
    const status = (getConnection().prepare('SELECT status FROM core_cash_sessions WHERE id = ?').get(gaveta2) as { status: string }).status;
    expect(status).toBe('open');
  });

  it('reabrir o turno do Caixa 2: 403 de ESCOPO, antes de qualquer conversa sobre liberação', async () => {
    const fecha = await request(app).post(`/api/v1/core/cash/${gaveta2}/close`).set(admin).send({ countedCents: 10_000 });
    expect(fecha.status, JSON.stringify(fecha.body)).toBe(200);
    const r = await request(app).post(`/api/v1/core/cash/${gaveta2}/reopen`).set(restrito).send({ reason: 'quero mexer' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error?.code).toBe('CORE_TERMINAL_OUT_OF_SCOPE');
  });

  it('a consulta com ?terminalId= do Caixa 2 não devolve a gaveta dele — devolve a recusa', async () => {
    const r = await request(app).get(`/api/v1/core/cash/open?terminalId=${cx2}`).set(restrito);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.session).toBeNull();
    expect(r.body.terminalRecusado?.id).toBe(cx2);
  });

  it('no PRÓPRIO caixa tudo passa: consulta, movimento e resumo', async () => {
    const consulta = await request(app).get(`/api/v1/core/cash/open?terminalId=${cx1}`).set(restrito);
    expect(consulta.body.session?.id).toBe(gaveta1);
    const mov = await request(app)
      .post(`/api/v1/core/cash/${gaveta1}/movements`)
      .set(restrito)
      .send({ movementType: 'supply', amountCents: 1_000 });
    expect(mov.status, JSON.stringify(mov.body)).toBe(201);
    const resumo = await request(app).get(`/api/v1/core/cash/${gaveta1}/summary`).set(restrito);
    expect(resumo.status, JSON.stringify(resumo.body)).toBe(200);
  });

  it('quem tem todos os caixas opera as duas gavetas', async () => {
    const r = await request(app)
      .post(`/api/v1/core/cash/${gaveta2}/movements`)
      .set(admin)
      .send({ movementType: 'supply', amountCents: 1_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('id de gaveta inventado continua 404', async () => {
    const r = await request(app).get('/api/v1/core/cash/nao-existe/summary').set(restrito);
    expect(r.status).toBe(404);
  });
});
