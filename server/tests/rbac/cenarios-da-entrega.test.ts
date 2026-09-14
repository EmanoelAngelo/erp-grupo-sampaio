process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * OS CINCO CENÁRIOS DA ENTREGA — o acesso granular provado pela API
 * ============================================================================
 *
 * O administrador configura cada pessoa pela MESMA rota da tela de Usuários
 * (`PUT /api/v1/acesso/usuarios/:id`); a pessoa entra com a própria senha; e
 * cada rota responde pelo SERVIDOR — 200 para o que foi liberado, 403 para o
 * resto, inclusive quando a URL é chamada direto, sem menu nenhum no caminho.
 *
 *   1. só o PDV da Preço Justo;
 *   2. dois PDVs específicos (o terceiro caixa recusa);
 *   3. todos os PDVs + Painel, sem Fiscal e sem Usuários (pelo atalho, e pelo
 *      gerente de loja com Fiscal e Usuários retirados — a retirada vale);
 *   4. só o Estoque da Preço Justo (outra empresa recusa, no login e na troca);
 *   5. o administrador com acesso total.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetDbForTests } from '../../src/db/database.js';
import { getConnection } from '../../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../../src/services/auth/IdentityService.js';
import { ensurePermissionTemplates } from '../../src/services/auth/AcessoService.js';
import { createTerminal } from '../../src/services/core/TerminalService.js';

const app = createApp();
const SENHA = 'Senha@Cenarios2026';

let loja: string;
let gringa: string;
let adminId: string;
let tokenAdmin: string;
let caixas: string[];

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });

async function entrar(login: string, companyId: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { accessToken: string; refreshToken: string; access: { capabilities: string[]; terminais: unknown; casa: string } };
}

const pedir = (token: string, caminho: string) => request(app).get(`/api/v1${caminho}`).set(portador(token));

type Empresa = { companyId: string; vinculado: boolean; modelo?: string; capabilities?: string[]; terminais?: 'todos' | string[] };

async function configurar(userId: string, empresas: Empresa[], token = tokenAdmin) {
  return request(app).put(`/api/v1/acesso/usuarios/${userId}`).set(portador(token)).send({ empresas });
}

async function pessoaCom(login: string, empresas: Empresa[]) {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  const res = await configurar(id, empresas);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return id;
}

/** O status de cada rota, para a asserção ler como tabela. */
async function statusDe(token: string, caminhos: string[]) {
  const saida: Record<string, number> = {};
  for (const c of caminhos) saida[c] = (await pedir(token, c)).status;
  return saida;
}

const PDV = '/core/cash/open';
const PAINEL = '/core/dashboard';
const ESTOQUE = '/core/stock';
const FISCAL = '/core/fiscal/config';
const USUARIOS = '/core/team';

beforeEach(async () => {
  resetDbForTests();
  ensurePermissionTemplates();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  adminId = await upsertUser({ login: 'ADMIN.CENARIO', displayName: 'Administrador', password: SENHA });
  linkUserToCompany(adminId, loja, 'admin_geral', true);
  linkUserToCompany(adminId, gringa, 'admin_geral', false);
  caixas = ['Caixa 1', 'Caixa 2', 'Caixa 3'].map((name) => createTerminal({ companyId: loja, userId: adminId, name }).id);
  tokenAdmin = (await entrar('ADMIN.CENARIO', loja)).accessToken;
});

describe('cenário 1 — só o PDV da Preço Justo', () => {
  it('o PDV abre; Painel, Estoque, Fiscal, Usuários e a API de acesso respondem 403; a Gringa recusa', async () => {
    const id = await pessoaCom('SO.PDV', [{ companyId: loja, vinculado: true, modelo: 'somente_pdv' }]);
    const sessao = await entrar('SO.PDV', loja);
    expect(sessao.access.capabilities).toContain('pdv.sell');
    expect(sessao.access.capabilities).not.toContain('dashboard.view');

    expect(await statusDe(sessao.accessToken, [PDV, PAINEL, ESTOQUE, FISCAL, USUARIOS, `/acesso/usuarios/${adminId}`])).toEqual({
      [PDV]: 200,
      [PAINEL]: 403,
      [ESTOQUE]: 403,
      [FISCAL]: 403,
      [USUARIOS]: 403,
      [`/acesso/usuarios/${adminId}`]: 403,
    });

    const naGringa = await request(app).post('/api/v1/auth/login').send({ login: 'SO.PDV', password: SENHA, companyId: gringa });
    expect(naGringa.status).not.toBe(200);
    const troca = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(portador(sessao.accessToken))
      .send({ companyId: gringa, refreshToken: sessao.refreshToken });
    expect(troca.status).toBe(403);

    // O retrato que a tela de Usuários mostra: vínculo só na Preço Justo.
    const retrato = await pedir(tokenAdmin, `/acesso/usuarios/${id}`);
    expect(retrato.status).toBe(200);
    const porEmpresa = Object.fromEntries(retrato.body.empresas.map((e: { companyId: string; vinculado: boolean }) => [e.companyId, e.vinculado]));
    expect(porEmpresa).toEqual({ [loja]: true, [gringa]: false });

    // A mudança de acesso deixa trilha, com o autor: quem estava na tela.
    const trilha = getConnection()
      .prepare("SELECT action, user_id FROM core_audit_log WHERE company_id = ? AND action LIKE 'access.%'")
      .all(loja) as { action: string; user_id: string | null }[];
    expect(trilha.map((t) => t.action)).toEqual(expect.arrayContaining(['access.template_applied']));
    expect(new Set(trilha.map((t) => t.user_id))).toEqual(new Set([adminId]));
  });
});

describe('cenário 2 — dois PDVs específicos', () => {
  it('os dois caixas do acesso passam; o terceiro é 403 com o nome do caixa, na leitura e na abertura', async () => {
    await pessoaCom('DOIS.PDVS', [{ companyId: loja, vinculado: true, modelo: 'somente_pdv', terminais: [caixas[0]!, caixas[1]!] }]);
    const { accessToken, access } = await entrar('DOIS.PDVS', loja);
    expect(access.terminais).toEqual([caixas[0], caixas[1]].sort());

    for (const caixa of [caixas[0], caixas[1]]) {
      const res = await pedir(accessToken, `/core/print/drawer?terminalId=${caixa}`);
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    }
    const fora = await pedir(accessToken, `/core/print/drawer?terminalId=${caixas[2]}`);
    expect(fora.status).toBe(403);
    expect(fora.body.error?.code ?? fora.body.code).toBe('CORE_TERMINAL_OUT_OF_SCOPE');

    const abrirFora = await request(app)
      .post('/api/v1/core/cash/open')
      .set(portador(accessToken))
      .send({ terminalId: caixas[2], openingAmountCents: 0 });
    expect(abrirFora.status).toBe(403);
  });
});

describe('cenário 3 — todos os PDVs + Painel, sem Fiscal e sem Usuários', () => {
  it('pelo atalho "PDV + Painel" nas duas empresas: PDV e Painel abrem, qualquer caixa serve, Fiscal e Usuários 403', async () => {
    await pessoaCom('PDV.PAINEL', [
      { companyId: loja, vinculado: true, modelo: 'pdv_painel', terminais: 'todos' },
      { companyId: gringa, vinculado: true, modelo: 'pdv_painel', terminais: 'todos' },
    ]);
    const sessao = await entrar('PDV.PAINEL', loja);
    expect(await statusDe(sessao.accessToken, [PDV, PAINEL, FISCAL, USUARIOS, ESTOQUE])).toEqual({
      [PDV]: 200,
      [PAINEL]: 200,
      [FISCAL]: 403,
      [USUARIOS]: 403,
      [ESTOQUE]: 403,
    });
    const terceiro = await pedir(sessao.accessToken, `/core/print/drawer?terminalId=${caixas[2]}`);
    expect(terceiro.status).not.toBe(403);

    // A troca para a outra empresa do acesso funciona, e lá vale o mesmo recorte.
    const troca = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(portador(sessao.accessToken))
      .send({ companyId: gringa, refreshToken: sessao.refreshToken });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(await statusDe(troca.body.accessToken, [PAINEL, FISCAL, USUARIOS])).toEqual({
      [PAINEL]: 200,
      [FISCAL]: 403,
      [USUARIOS]: 403,
    });
  });

  it('pelo gerente de loja com as páginas de Fiscal e de Usuários DESMARCADAS: a retirada vale no servidor', async () => {
    const catalogo = await pedir(tokenAdmin, '/acesso/catalogo');
    expect(catalogo.status).toBe(200);
    const gerente = catalogo.body.modelos.find((m: { code: string }) => m.code === 'gerente_loja');
    const semFiscalNemUsuarios = (gerente.capabilities as string[]).filter(
      (c) => !c.startsWith('fiscal.') && !c.startsWith('users.') && !c.startsWith('permissions.'),
    );
    await pessoaCom('GERENTE.RECORTADO', [
      { companyId: loja, vinculado: true, modelo: 'gerente_loja', capabilities: semFiscalNemUsuarios, terminais: 'todos' },
    ]);
    const { accessToken, access } = await entrar('GERENTE.RECORTADO', loja);
    expect(access.capabilities).not.toContain('fiscal.view');
    expect(await statusDe(accessToken, [PDV, PAINEL, ESTOQUE, FISCAL, USUARIOS, '/acesso/catalogo'])).toEqual({
      [PDV]: 200,
      [PAINEL]: 200,
      [ESTOQUE]: 200,
      [FISCAL]: 403,
      [USUARIOS]: 403,
      '/acesso/catalogo': 403,
    });
  });
});

describe('cenário 4 — só o Estoque da Preço Justo', () => {
  it('o Estoque abre; PDV, Painel, Fiscal e Usuários 403; a Gringa recusa no login e na troca', async () => {
    await pessoaCom('SO.ESTOQUE', [{ companyId: loja, vinculado: true, modelo: 'estoque' }]);
    const sessao = await entrar('SO.ESTOQUE', loja);
    expect(await statusDe(sessao.accessToken, [ESTOQUE, PDV, PAINEL, FISCAL, USUARIOS])).toEqual({
      [ESTOQUE]: 200,
      [PDV]: 403,
      [PAINEL]: 403,
      [FISCAL]: 403,
      [USUARIOS]: 403,
    });
    const naGringa = await request(app).post('/api/v1/auth/login').send({ login: 'SO.ESTOQUE', password: SENHA, companyId: gringa });
    expect(naGringa.status).not.toBe(200);
    const troca = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(portador(sessao.accessToken))
      .send({ companyId: gringa, refreshToken: sessao.refreshToken });
    expect(troca.status).toBe(403);
  });
});

describe('cenário 5 — o administrador com acesso total', () => {
  it('todas as rotas dos cenários respondem, e a API de acesso também', async () => {
    const outro = await upsertUser({ login: 'QUALQUER.UM', displayName: 'Qualquer', password: SENHA });
    expect(await statusDe(tokenAdmin, [PDV, PAINEL, ESTOQUE, FISCAL, USUARIOS, '/acesso/catalogo', `/acesso/usuarios/${outro}`])).toEqual({
      [PDV]: 200,
      [PAINEL]: 200,
      [ESTOQUE]: 200,
      [FISCAL]: 200,
      [USUARIOS]: 200,
      '/acesso/catalogo': 200,
      [`/acesso/usuarios/${outro}`]: 200,
    });
  });
});

describe('quem mexe no acesso de quem', () => {
  it('ninguém edita o próprio acesso', async () => {
    const res = await configurar(adminId, [{ companyId: loja, vinculado: true, modelo: 'somente_pdv' }]);
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_CANNOT_EDIT_OWN_ACCESS');
  });

  it('o gerente de loja não entrega o modelo de dono, não mexe na empresa que não administra, e não dá o que não tem', async () => {
    const gerenteId = await upsertUser({ login: 'GERENTE.ADMIN', displayName: 'Gerente', password: SENHA });
    linkUserToCompany(gerenteId, loja, 'gerente_loja', true);
    const alvo = await upsertUser({ login: 'ALVO.ACESSO', displayName: 'Alvo', password: SENHA });
    const tokenGerente = (await entrar('GERENTE.ADMIN', loja)).accessToken;

    const dono = await configurar(alvo, [{ companyId: loja, vinculado: true, modelo: 'admin_geral' }], tokenGerente);
    expect(dono.status).toBe(403);
    const outraEmpresa = await configurar(alvo, [{ companyId: gringa, vinculado: true, modelo: 'somente_pdv' }], tokenGerente);
    expect(outraEmpresa.status).toBe(403);
    const alheia = await configurar(alvo, [{ companyId: loja, vinculado: true, modelo: 'somente_pdv', capabilities: ['pdv.sell', 'group.admin'] }], tokenGerente);
    expect(alheia.status).toBe(403);
    expect(alheia.body.error?.code ?? alheia.body.code).toBe('CORE_CAPABILITY_NOT_YOURS');

    // Nada disso gravou: o alvo continua sem vínculo nenhum.
    const vinculos = getConnection().prepare('SELECT COUNT(*) AS n FROM core_user_companies WHERE user_id = ?').get(alvo) as { n: number };
    expect(vinculos.n).toBe(0);

    // O que ele pode: dar o PDV da loja dele.
    const ok = await configurar(alvo, [{ companyId: loja, vinculado: true, modelo: 'somente_pdv' }], tokenGerente);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('tirar a pessoa da empresa desfaz o vínculo: o login naquela empresa passa a recusar', async () => {
    const id = await pessoaCom('SAI.DA.LOJA', [
      { companyId: loja, vinculado: true, modelo: 'somente_pdv' },
      { companyId: gringa, vinculado: true, modelo: 'somente_pdv' },
    ]);
    await entrar('SAI.DA.LOJA', gringa);
    const res = await configurar(id, [{ companyId: gringa, vinculado: false }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const depois = await request(app).post('/api/v1/auth/login').send({ login: 'SAI.DA.LOJA', password: SENHA, companyId: gringa });
    expect(depois.status).not.toBe(200);
    await entrar('SAI.DA.LOJA', loja);
  });
});
