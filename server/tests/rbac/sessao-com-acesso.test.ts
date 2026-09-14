process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * A SESSÃO CARREGA O ACESSO EFETIVO — e ele vale NA REQUISIÇÃO SEGUINTE
 * ============================================================================
 *
 * F1 do RBAC granular (desenho §5). A conferência por requisição
 * (`ContaDaSessao.ts`) passa a carregar, na MESMA consulta por chave primária,
 * o acesso do vínculo ativo: as capabilities do modelo aplicado, mais e menos
 * a personalização, o escopo de caixas e o de bancadas. As capabilities NÃO
 * vão no token — viajando nele, a revogação imediata se perderia (GAP-PRD-053).
 *
 * Cada caso aqui cai quando a peça correspondente sai:
 *   - `access` no login, na sessão, na troca e no dispositivo (a tela monta o
 *     menu por ele, F3);
 *   - `X-Acesso-Em-Vigor` quando o acesso muda depois do token;
 *   - T9: tirar ou dar capability vale na requisição seguinte, e editar o
 *     modelo afeta todos que o usam;
 *   - D2: empresa desativada derruba a sessão e o refresh;
 *   - a senha provisória relida DO BANCO, e não só do token;
 *   - `requireCapability` recusa com 403 JSON, código e capability no detalhe.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetDbForTests } from '../../src/db/database.js';
import { getConnection } from '../../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../../src/services/auth/IdentityService.js';
import { authMiddleware, type AuthedRequest } from '../../src/middleware/auth.js';
import { ApiError } from '../../src/utils/errors.js';
import {
  comCapability,
  requireAllCapabilities,
  requireAnyCapability,
  requireCapability,
  requireTerminalNoEscopo,
} from '../../src/services/auth/Autorizacao.js';
import {
  definirTerminaisDoVinculo,
  editarModelo,
  ensurePermissionTemplates,
  personalizarVinculo,
} from '../../src/services/auth/AcessoService.js';
import { MODELOS_DE_SISTEMA } from '../../src/services/auth/Capabilities.js';
import { issueSession } from '../helpers/sessao.js';

const app = createApp();
const SENHA = 'Senha@Acesso2026';

let loja: string;
let gringa: string;
let gerenteId: string;
let mecanicoId: string;

async function entrar(login: string, companyId: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}
const portador = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(async () => {
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  gerenteId = await upsertUser({ login: 'GERENTE.ACESSO', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(gerenteId, loja, 'gerente_loja', true);
  linkUserToCompany(gerenteId, gringa, 'atendente', false);
  mecanicoId = await upsertUser({ login: 'MECANICO.ACESSO', displayName: 'Mecânico', password: SENHA });
  linkUserToCompany(mecanicoId, loja, 'mecanico', true);
});

describe('o acesso efetivo viaja na resposta — login, sessão, troca de empresa e dispositivo', () => {
  it('o login devolve access do vínculo escolhido, e companies[] ganha o modelo sem perder o profileCode', async () => {
    const res = await entrar('GERENTE.ACESSO', loja);
    const access = res.body.access;
    expect(access.modelo).toEqual({ code: 'gerente_loja', name: 'Gerente de Loja', personalizado: false, acrescentadas: [], retiradas: [] });
    expect(access.capabilities).toHaveLength(MODELOS_DE_SISTEMA.gerente_loja!.capabilities.length);
    expect(access.capabilities).toContain('logistics.view');
    expect(access.capabilities).not.toContain('group.admin');
    expect(access.terminais).toBe('todos');
    expect(access.bancadas).toBe('todas');
    expect(access.casa).toBe('/sistema/painel');
    expect(typeof access.carimbo).toBe('string');
    // O que a tela usa hoje continua lá.
    expect(res.body.user.profileCode).toBe('gerente_loja');
    const naGringa = res.body.companies.find((c: { id: string }) => c.id === gringa);
    expect(naGringa.profileCode).toBe('atendente');
    expect(naGringa.modelo).toEqual({ code: 'atendente', name: 'Atendente' });
  });

  it('GET /auth/session traz o access do vínculo ATIVO, e a sessão continua sem capabilities dentro', async () => {
    const login = await entrar('GERENTE.ACESSO', loja);
    const res = await request(app).get('/api/v1/auth/session').set(portador(login.body.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.access.modelo.code).toBe('gerente_loja');
    expect(res.body.access.capabilities).toEqual(login.body.access.capabilities);
    expect(res.body.access.carimbo).toBe(login.body.access.carimbo);
    expect(res.body.session.profileCodes).toEqual(['gerente_loja']);
    // As capabilities NÃO moram no token nem no eco da sessão.
    expect(JSON.stringify(res.body.session)).not.toContain('logistics.view');
    expect(res.body.companies.map((c: { modelo: { code: string } }) => c.modelo.code).sort()).toEqual(['atendente', 'gerente_loja']);
  });

  it('a troca de empresa devolve o access da empresa de DESTINO', async () => {
    const login = await entrar('GERENTE.ACESSO', loja);
    const troca = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(portador(login.body.accessToken))
      .send({ companyId: gringa, refreshToken: login.body.refreshToken });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(troca.body.access.modelo.code).toBe('atendente');
    expect([...troca.body.access.capabilities].sort()).toEqual([...MODELOS_DE_SISTEMA.atendente!.capabilities].sort());
    const sessao = await request(app).get('/api/v1/auth/session').set(portador(troca.body.accessToken));
    expect(sessao.body.access.modelo.code).toBe('atendente');
  });

  it('o mecânico: bancadas pelas de que é membro (nenhuma, aqui), e a casa é a oficina', async () => {
    const res = await entrar('MECANICO.ACESSO', loja);
    expect(res.body.access.bancadas).toEqual([]);
    expect(res.body.access.casa).toBe('/sistema/oficina');
  });

  it('o login do dispositivo também devolve o access do titular', async () => {
    const adminId = await upsertUser({ login: 'ADMIN.ACESSO', displayName: 'Admin', password: SENHA });
    linkUserToCompany(adminId, loja, 'admin_geral', true);
    const caixaId = await upsertUser({ login: 'CAIXA.ACESSO', displayName: 'Caixa', password: SENHA });
    linkUserToCompany(caixaId, loja, 'operador_caixa_loja', true);
    const admin = await entrar('ADMIN.ACESSO', loja);
    const registro = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(portador(admin.body.accessToken))
      .send({ userId: caixaId, label: 'Balcão 1' });
    expect(registro.status, JSON.stringify(registro.body)).toBe(201);
    const disp = await request(app).post('/api/v1/auth/device/login').send({ deviceToken: registro.body.deviceToken });
    expect(disp.status, JSON.stringify(disp.body)).toBe(200);
    expect(disp.body.access.modelo.code).toBe('operador_caixa_loja');
    expect(disp.body.access.casa).toBe('/pdv');
  });
});

describe('T9 — tirar ou dar capability vale na requisição seguinte', () => {
  it('tirar logistics.view do gerente: a próxima requisição é 403, com X-Acesso-Em-Vigor; devolver, passa', async () => {
    const login = await entrar('GERENTE.ACESSO', loja);
    const token = login.body.accessToken as string;

    const antes = await request(app).get('/api/v1/logistics/readiness').set(portador(token));
    expect(antes.status, JSON.stringify(antes.body)).not.toBe(403);
    // Sem mudança, o cabeçalho não aparece: o carimbo do token é o de agora.
    expect(antes.headers['x-acesso-em-vigor']).toBeUndefined();

    personalizarVinculo({ atorId: null, userId: gerenteId, companyId: loja, grants: [], revokes: ['logistics.view'] });
    const depois = await request(app).get('/api/v1/logistics/readiness').set(portador(token));
    expect(depois.status).toBe(403);
    expect(depois.body.error.code).toBe('API_PERMISSION_DENIED');
    const carimbo = depois.headers['x-acesso-em-vigor'];
    expect(typeof carimbo).toBe('string');
    expect(carimbo).not.toBe(login.body.access.carimbo);

    // A tela relê a sessão e recebe o acesso novo, com o mesmo carimbo do cabeçalho.
    const sessao = await request(app).get('/api/v1/auth/session').set(portador(token));
    expect(sessao.body.access.carimbo).toBe(carimbo);
    expect(sessao.body.access.capabilities).not.toContain('logistics.view');
    expect(sessao.body.access.modelo).toMatchObject({ code: 'gerente_loja', personalizado: true, retiradas: ['logistics.view'] });

    personalizarVinculo({ atorId: null, userId: gerenteId, companyId: loja, grants: [], revokes: [] });
    const devolvida = await request(app).get('/api/v1/logistics/readiness').set(portador(token));
    expect(devolvida.status, JSON.stringify(devolvida.body)).not.toBe(403);
  });

  it('dar logistics.view ao mecânico: a rota que o recusava passa a responder', async () => {
    const login = await entrar('MECANICO.ACESSO', loja);
    const token = login.body.accessToken as string;
    expect((await request(app).get('/api/v1/logistics/readiness').set(portador(token))).status).toBe(403);
    personalizarVinculo({ atorId: null, userId: mecanicoId, companyId: loja, grants: ['logistics.view'], revokes: [] });
    const depois = await request(app).get('/api/v1/logistics/readiness').set(portador(token));
    expect(depois.status, JSON.stringify(depois.body)).not.toBe(403);
    expect(depois.headers['x-acesso-em-vigor']).toBeDefined();
  });

  it('editar o MODELO afeta todos os que o usam, na requisição seguinte', async () => {
    const outroId = await upsertUser({ login: 'GERENTE.DOIS', displayName: 'Gerente Dois', password: SENHA });
    linkUserToCompany(outroId, loja, 'gerente_loja', true);
    ensurePermissionTemplates();
    const um = (await entrar('GERENTE.ACESSO', loja)).body.accessToken as string;
    const dois = (await entrar('GERENTE.DOIS', loja)).body.accessToken as string;
    for (const t of [um, dois]) expect((await request(app).get('/api/v1/logistics/readiness').set(portador(t))).status).not.toBe(403);

    const semLogistica = MODELOS_DE_SISTEMA.gerente_loja!.capabilities.filter((c) => c !== 'logistics.view');
    editarModelo({ atorId: null, codigo: 'gerente_loja', capabilities: semLogistica });

    for (const t of [um, dois]) {
      const res = await request(app).get('/api/v1/logistics/readiness').set(portador(t));
      expect(res.status).toBe(403);
      expect(res.headers['x-acesso-em-vigor']).toBeDefined();
    }
  });

  it('o modelo de catálogo inteiro não se edita (409 CORE_TEMPLATE_LOCKED)', () => {
    ensurePermissionTemplates();
    expect(() => editarModelo({ atorId: null, codigo: 'admin_geral', capabilities: ['dashboard.view'] })).toThrow(
      expect.objectContaining({ code: 'CORE_TEMPLATE_LOCKED', status: 409 }),
    );
  });
});

describe('D2 — empresa desativada derruba a sessão', () => {
  it('a próxima requisição é 401 API_SESSION_ENDED, e o refresh também não renova', async () => {
    const login = await entrar('GERENTE.ACESSO', loja);
    expect((await request(app).get('/api/v1/core/products').set(portador(login.body.accessToken))).status).toBe(200);

    getConnection().prepare('UPDATE core_companies SET active = 0 WHERE id = ?').run(loja);

    const depois = await request(app).get('/api/v1/core/products').set(portador(login.body.accessToken));
    expect(depois.status).toBe(401);
    expect(depois.body.error.code).toBe('API_SESSION_ENDED');
    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('a sessão em OUTRA empresa, ativa, segue valendo', async () => {
    const login = await entrar('GERENTE.ACESSO', gringa);
    getConnection().prepare('UPDATE core_companies SET active = 0 WHERE id = ?').run(loja);
    const res = await request(app).get('/api/v1/core/products').set(portador(login.body.accessToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('a senha provisória é relida DO BANCO a cada requisição', () => {
  it('sessão sem a marca no token, com a conta ainda provisória: 403 API_PASSWORD_CHANGE_REQUIRED', async () => {
    // O token sai limpo (emitido pelo serviço, sem a marca), mas a conta está
    // com a senha provisória da gestão: quem conhece a senha não pode operar.
    const tokens = issueSession({ userId: 'conta-provisoria', companyId: loja, profileCodes: ['gerente_loja'] });
    getConnection().prepare('UPDATE core_users SET must_change_password = 1 WHERE id = ?').run('conta-provisoria');

    const res = await request(app).get('/api/v1/core/products').set(portador(tokens.accessToken));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');

    // As portas da etapa de troca continuam abertas.
    const sessao = await request(app).get('/api/v1/auth/session').set(portador(tokens.accessToken));
    expect(sessao.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// As guardas novas, num roteador de prova
// ---------------------------------------------------------------------------

function appDeProva() {
  const prova = express();
  prova.use(express.json());
  const rota = (guarda: (req: AuthedRequest) => void) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      guarda(req);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };
  prova.get('/financeiro', authMiddleware, rota((req) => requireCapability(req, 'finance.manage')));
  prova.get('/qualquer', authMiddleware, rota((req) => requireAnyCapability(req, 'finance.manage', 'customers.view')));
  prova.get('/todas', authMiddleware, rota((req) => requireAllCapabilities(req, 'customers.view', 'finance.manage')));
  prova.get('/middleware', authMiddleware, comCapability('finance.manage'), (_req, res) => {
    res.json({ ok: true });
  });
  prova.get('/caixa/:terminalId', authMiddleware, rota((req) => requireTerminalNoEscopo(req, req.params.terminalId === 'nenhum' ? null : String(req.params.terminalId))));
  prova.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    res.status(500).json({ error: { code: 'X', message: String(err) } });
  });
  return prova;
}

describe('requireCapability e irmãs', () => {
  it('recusa com 403 JSON, API_PERMISSION_DENIED, o rótulo na mensagem e a capability no detalhe', async () => {
    const atendente = issueSession({ userId: 'atendente-prova', companyId: loja, profileCodes: ['atendente'] });
    const res = await request(appDeProva()).get('/financeiro').set(portador(atendente.accessToken));
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
    expect(res.body.error.message).toMatch(/^Seu acesso nesta empresa não inclui: /);
    expect(res.body.error.details).toMatchObject({ capabilities: ['finance.manage'], companyId: loja });

    const gerente = issueSession({ userId: 'gerente-prova', companyId: loja, profileCodes: ['gerente_loja'] });
    expect((await request(appDeProva()).get('/financeiro').set(portador(gerente.accessToken))).status).toBe(200);
  });

  it('qualquer: passa com uma; todas: recusa se falta uma; a middleware faz o mesmo que a chamada', async () => {
    const atendente = issueSession({ userId: 'atendente-prova', companyId: loja, profileCodes: ['atendente'] });
    const h = portador(atendente.accessToken);
    expect((await request(appDeProva()).get('/qualquer').set(h)).status).toBe(200);
    const todas = await request(appDeProva()).get('/todas').set(h);
    expect(todas.status).toBe(403);
    expect(todas.body.error.details.capabilities).toEqual(['finance.manage']);
    expect((await request(appDeProva()).get('/middleware').set(h)).status).toBe(403);
  });

  it('perfil desconhecido não tem capability nenhuma — falha fechada', async () => {
    const inventado = issueSession({ userId: 'inventado-prova', companyId: loja, profileCodes: ['perfil_inventado'] });
    const res = await request(appDeProva()).get('/qualquer').set(portador(inventado.accessToken));
    expect(res.status).toBe(403);
  });

  it('escopo de caixa: sem caixa cadastrado vale só a capability; com lista, fora dela é 403 e sem caixa é 409', async () => {
    const caixa = issueSession({ userId: 'caixa-prova', companyId: loja, profileCodes: ['operador_caixa_loja'] });
    const h = portador(caixa.accessToken);
    definirTerminaisDoVinculo({ atorId: null, userId: 'caixa-prova', companyId: loja, terminais: [] });
    // Empresa com 0 caixas: "PDV único" — não há o que recortar.
    expect((await request(appDeProva()).get('/caixa/nenhum').set(h)).status).toBe(200);

    const agora = new Date().toISOString();
    const inserir = getConnection().prepare(
      'INSERT INTO core_terminals (id, company_id, code, name, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    );
    inserir.run('cx-1', loja, 'pj-cx1', 'Caixa 1', agora);
    inserir.run('cx-2', loja, 'pj-cx2', 'Caixa 2', agora);
    definirTerminaisDoVinculo({ atorId: null, userId: 'caixa-prova', companyId: loja, terminais: ['cx-1'] });

    expect((await request(appDeProva()).get('/caixa/cx-1').set(h)).status).toBe(200);
    const fora = await request(appDeProva()).get('/caixa/cx-2').set(h);
    expect(fora.status).toBe(403);
    expect(fora.body.error.code).toBe('CORE_TERMINAL_OUT_OF_SCOPE');
    expect(fora.body.error.message).toContain('Caixa 2');
    const sem = await request(appDeProva()).get('/caixa/nenhum').set(h);
    expect(sem.status).toBe(409);
    expect(sem.body.error.code).toBe('CORE_TERMINAL_REQUIRED');

    // "Todos os caixas" volta a aceitar qualquer um.
    definirTerminaisDoVinculo({ atorId: null, userId: 'caixa-prova', companyId: loja, terminais: 'todos' });
    expect((await request(appDeProva()).get('/caixa/cx-2').set(h)).status).toBe(200);
  });

  it('a mudança de acesso fica na trilha, com antes e depois e sem senha', () => {
    issueSession({ userId: 'caixa-trilha', companyId: loja, profileCodes: ['operador_caixa_loja'] });
    personalizarVinculo({ atorId: 'quem-mudou', userId: 'caixa-trilha', companyId: loja, grants: ['dashboard.view'], revokes: [] });
    const linha = getConnection()
      .prepare("SELECT user_id, entity_id, detail FROM core_audit_log WHERE action = 'access.capabilities_customized'")
      .get() as { user_id: string; entity_id: string; detail: string };
    expect(linha.user_id).toBe('quem-mudou');
    expect(linha.entity_id).toBe('caixa-trilha');
    const detalhe = JSON.parse(linha.detail);
    expect(detalhe.antes.grants).toEqual([]);
    expect(detalhe.depois.grants).toEqual(['dashboard.view']);
    expect(detalhe.diff.capabilities['+']).toEqual(['dashboard.view']);
    expect(linha.detail).not.toMatch(/password|senha|hash/i);
  });
});
