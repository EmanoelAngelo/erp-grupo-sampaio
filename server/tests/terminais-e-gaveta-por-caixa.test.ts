/**
 * ============================================================================
 * UMA GAVETA POR CAIXA — o cadastro de terminais que não existia
 * (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150, GAP-PRD-131)
 * ============================================================================
 *
 * O que a auditoria mediu, e o que este arquivo prova que acabou:
 *
 *  - `core_terminals` não tinha UM escritor. Três chaves estrangeiras
 *    apontavam para ela, e qualquer `terminalId` era recusado. A regra
 *    efetiva era UMA gaveta por empresa: o segundo operador levava 409 ao
 *    abrir e vendia na gaveta do primeiro — o dinheiro dos dois, um
 *    fechamento só, diferença que ninguém atribui.
 *  - O token de terminal (o único caminho sem senha) existia só por rota, e
 *    não podia ser preso a terminal nenhum.
 *  - Um caixa aberto de outro dia (a Gringa desde 12/08) não era apontado em
 *    lugar nenhum: a venda do dia 1º cairia na gaveta de agosto.
 *
 * Tudo aqui passa pela rota, com login real (Argon2id), como a tela passa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { hojeNaLoja } from '../src/services/core/CalendarioOperacional.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-dois-caixas';
const OUTRA = 'loja-vizinha';

type Auth = { Authorization: string };
interface Sessao {
  auth: Auth;
  userId: string;
}

async function entrar(userId: string, perfil: string, empresa = LOJA): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

function produto(id: string, precoCents: number, empresa = LOJA): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, min_stock, active, is_kit, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 0, 1, 0, ?, ?)`,
    )
    .run(id, empresa, `${id}-cod`, `Produto ${id}`, precoCents, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 100, 0, ?)',
    )
    .run(empresa, id, agora);
  return id;
}

function criarTerminal(quem: Sessao, name: string) {
  return request(app).post('/api/v1/core/terminals').set(quem.auth).send({ name });
}

function abrirCaixa(quem: Sessao, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/cash/open').set(quem.auth).send(corpo);
}

function vender(quem: Sessao, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(quem.auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

function auditoria(acao: string): { entity_id: string; detail: string | null; user_id: string | null }[] {
  return getConnection()
    .prepare('SELECT entity_id, detail, user_id FROM core_audit_log WHERE action = ? ORDER BY created_at')
    .all(acao) as unknown as { entity_id: string; detail: string | null; user_id: string | null }[];
}

let gerente: Sessao;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-dois-caixas', 'gerente_loja');
});

// ============================================================================
// 1. O CADASTRO (GAP-PRD-039, GAP-PRD-146)
// ============================================================================

describe('cadastro de terminais: core_terminals ganha escritor', () => {
  it('o gerente cria o caixa pela rota — código gerado pela operação, auditoria gravada', async () => {
    const res = await criarTerminal(gerente, '  Caixa 2 — balcão  ');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.name).toBe('Caixa 2 — balcão');
    // O código é da operação: o slug na frente garante que duas lojas não
    // disputem o mesmo "cx1" (a coluna é UNIQUE no banco inteiro).
    expect(res.body.code).toBe(`${LOJA}-cx1`);
    expect(res.body.active).toBe(true);

    const segundo = await criarTerminal(gerente, 'Caixa 3');
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(201);
    expect(segundo.body.code).toBe(`${LOJA}-cx2`);

    const linha = getConnection()
      .prepare('SELECT company_id, name, active, created_by FROM core_terminals WHERE id = ?')
      .get(String(res.body.id)) as { company_id: string; name: string; active: number; created_by: string };
    expect(linha.company_id).toBe(LOJA);
    expect(linha.active).toBe(1);
    expect(linha.created_by).toBe(gerente.userId);

    const trilha = auditoria('terminal.create');
    expect(trilha.map((t) => t.entity_id)).toContain(String(res.body.id));

    const lista = await request(app).get('/api/v1/core/terminals').set(gerente.auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items.map((t: { name: string }) => t.name)).toEqual(['Caixa 2 — balcão', 'Caixa 3']);
  });

  it('nome é obrigatório e não se repete na operação (sem olhar maiúscula)', async () => {
    const vazio = await criarTerminal(gerente, '   ');
    expect(vazio.status).toBe(400);
    expect(vazio.body.error.code).toBe('CORE_TERMINAL_NAME_REQUIRED');

    expect((await criarTerminal(gerente, 'Caixa 1')).status).toBe(201);
    const repetido = await criarTerminal(gerente, 'caixa 1');
    expect(repetido.status).toBe(409);
    expect(repetido.body.error.code).toBe('CORE_TERMINAL_NAME_TAKEN');
  });

  it('o operador de caixa LÊ a lista (escolhe o caixa do computador), mas não cadastra', async () => {
    await criarTerminal(gerente, 'Caixa 1');
    const caixa = await entrar('op-le-lista', 'operador_caixa_loja');
    const lista = await request(app).get('/api/v1/core/terminals').set(caixa.auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);

    const cria = await criarTerminal(caixa, 'Caixa pirata');
    expect(cria.status).toBe(403);
  });

  it('renomeia, e desativar exige motivo e caixa fechado — reativar devolve', async () => {
    const t = await criarTerminal(gerente, 'Caixa 1');
    const id = String(t.body.id);

    const renomeado = await request(app)
      .patch(`/api/v1/core/terminals/${id}`)
      .set(gerente.auth)
      .send({ name: 'Caixa da frente' });
    expect(renomeado.status, JSON.stringify(renomeado.body)).toBe(200);
    expect(renomeado.body.name).toBe('Caixa da frente');

    const semMotivo = await request(app)
      .post(`/api/v1/core/terminals/${id}/deactivate`)
      .set(gerente.auth)
      .send({});
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_TERMINAL_REASON_REQUIRED');

    const aberto = await abrirCaixa(gerente, { openingCents: 1_000, terminalId: id });
    expect(aberto.status, JSON.stringify(aberto.body)).toBe(201);

    const comGaveta = await request(app)
      .post(`/api/v1/core/terminals/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'máquina foi para o conserto' });
    expect(comGaveta.status).toBe(409);
    expect(comGaveta.body.error.code).toBe('CORE_TERMINAL_HAS_OPEN_CASH');

    await request(app)
      .post(`/api/v1/core/cash/${String(aberto.body.id)}/close`)
      .set(gerente.auth)
      .send({ countedCents: 1_000 });

    const desativado = await request(app)
      .post(`/api/v1/core/terminals/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'máquina foi para o conserto' });
    expect(desativado.status, JSON.stringify(desativado.body)).toBe(200);
    expect(desativado.body.active).toBe(false);
    expect(desativado.body.deactivationReason).toBe('máquina foi para o conserto');
    expect(auditoria('terminal.deactivate')).toHaveLength(1);

    // Terminal desligado não abre gaveta.
    const naoAbre = await abrirCaixa(gerente, { openingCents: 0, terminalId: id });
    expect(naoAbre.status).toBe(409);
    expect(naoAbre.body.error.code).toBe('CORE_TERMINAL_INACTIVE');

    const religado = await request(app)
      .post(`/api/v1/core/terminals/${id}/activate`)
      .set(gerente.auth)
      .send({});
    expect(religado.status).toBe(200);
    expect(religado.body.active).toBe(true);
  });

  it('terminal de OUTRA operação não existe aqui — nem para abrir gaveta, nem para mexer', async () => {
    const vizinho = await entrar('gerente-vizinho', 'gerente_loja', OUTRA);
    const deles = await criarTerminal(vizinho, 'Caixa 1');
    expect(deles.status).toBe(201);
    const idDeles = String(deles.body.id);

    const lista = await request(app).get('/api/v1/core/terminals').set(gerente.auth);
    expect(lista.body.items).toHaveLength(0);

    const renomear = await request(app)
      .patch(`/api/v1/core/terminals/${idDeles}`)
      .set(gerente.auth)
      .send({ name: 'meu agora' });
    expect(renomear.status).toBe(404);

    const desativar = await request(app)
      .post(`/api/v1/core/terminals/${idDeles}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'tentativa' });
    expect(desativar.status).toBe(404);

    const gaveta = await abrirCaixa(gerente, { openingCents: 0, terminalId: idDeles });
    expect(gaveta.status).toBe(400);
    expect(gaveta.body.error.code).toBe('CORE_TERMINAL_NOT_REGISTERED');
  });
});

// ============================================================================
// 2. A GAVETA É DO CAIXA (GAP-PRD-039)
// ============================================================================

describe('dois operadores, dois caixas, duas gavetas', () => {
  it('cada um abre a SUA gaveta, vende nela e fecha só o que é dele', async () => {
    const cx1 = String((await criarTerminal(gerente, 'Caixa 1')).body.id);
    const cx2 = String((await criarTerminal(gerente, 'Caixa 2')).body.id);
    const ana = await entrar('ana-caixa', 'operador_caixa_loja');
    const beto = await entrar('beto-caixa', 'operador_caixa_loja');
    const p = produto('p-dois', 2_000);

    const gavetaAna = await abrirCaixa(ana, { openingCents: 10_000, terminalId: cx1 });
    expect(gavetaAna.status, JSON.stringify(gavetaAna.body)).toBe(201);
    // O segundo operador ABRE a dele — antes levava 409 CORE_CASH_ALREADY_OPEN.
    const gavetaBeto = await abrirCaixa(beto, { openingCents: 5_000, terminalId: cx2 });
    expect(gavetaBeto.status, JSON.stringify(gavetaBeto.body)).toBe(201);
    expect(gavetaBeto.body.id).not.toBe(gavetaAna.body.id);
    expect(gavetaBeto.body.terminal_id).toBe(cx2);

    // A consulta do PDV do Beto devolve a gaveta DELE, não a da Ana.
    const doBeto = await request(app).get(`/api/v1/core/cash/open?terminalId=${cx2}`).set(beto.auth);
    expect(doBeto.status).toBe(200);
    expect(doBeto.body.session.id).toBe(gavetaBeto.body.id);
    expect(doBeto.body.terminal).toMatchObject({ id: cx2, name: 'Caixa 2' });

    const vendaBeto = await vender(beto, {
      terminalId: cx2,
      cashSessionId: gavetaBeto.body.id,
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2_000 }],
    });
    expect(vendaBeto.status, JSON.stringify(vendaBeto.body)).toBe(201);
    const vendaAna = await vender(ana, {
      terminalId: cx1,
      cashSessionId: gavetaAna.body.id,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 4_000 }],
    });
    expect(vendaAna.status, JSON.stringify(vendaAna.body)).toBe(201);

    const vendas = getConnection()
      .prepare('SELECT seller_id, terminal_id, cash_session_id FROM core_sales WHERE company_id = ? ORDER BY number')
      .all(LOJA) as unknown as { terminal_id: string; cash_session_id: string }[];
    expect(vendas).toEqual([
      expect.objectContaining({ terminal_id: cx2, cash_session_id: gavetaBeto.body.id }),
      expect.objectContaining({ terminal_id: cx1, cash_session_id: gavetaAna.body.id }),
    ]);

    // Fechamento do Beto: 5.000 de fundo + 2.000 da venda dele. Nada da Ana.
    const fechaBeto = await request(app)
      .post(`/api/v1/core/cash/${String(gavetaBeto.body.id)}/close`)
      .set(beto.auth)
      .send({ countedCents: 7_000 });
    expect(fechaBeto.status).toBe(200);
    expect(fechaBeto.body.expected_cents).toBe(7_000);
    expect(fechaBeto.body.difference_cents).toBe(0);

    // A gaveta da Ana continua aberta, com o dinheiro dela.
    const resumoAna = await request(app)
      .get(`/api/v1/core/cash/${String(gavetaAna.body.id)}/summary`)
      .set(ana.auth);
    expect(resumoAna.body.session.status).toBe('open');
    expect(resumoAna.body.expectedCents).toBe(14_000);
  });

  it('venda de um caixa NÃO cai na gaveta do outro — 409 nomeado, nada gravado', async () => {
    const cx1 = String((await criarTerminal(gerente, 'Caixa 1')).body.id);
    const cx2 = String((await criarTerminal(gerente, 'Caixa 2')).body.id);
    const p = produto('p-cruzado', 1_000);
    const gaveta1 = await abrirCaixa(gerente, { openingCents: 0, terminalId: cx1 });

    const cruzada = await vender(gerente, {
      terminalId: cx2,
      cashSessionId: gaveta1.body.id,
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 1_000 }],
    });
    expect(cruzada.status, JSON.stringify(cruzada.body)).toBe(409);
    expect(cruzada.body.error.code).toBe('CORE_CASH_SESSION_OTHER_TERMINAL');
    const n = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(n.n).toBe(0);
  });

  it('venda sem terminal no corpo herda o terminal da gaveta em que caiu', async () => {
    const cx1 = String((await criarTerminal(gerente, 'Caixa 1')).body.id);
    const p = produto('p-herda', 1_000);
    const gaveta = await abrirCaixa(gerente, { openingCents: 0, terminalId: cx1 });
    const venda = await vender(gerente, {
      cashSessionId: gaveta.body.id,
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 1_000 }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const linha = getConnection()
      .prepare('SELECT terminal_id FROM core_sales WHERE company_id = ?')
      .get(LOJA) as { terminal_id: string };
    expect(linha.terminal_id).toBe(cx1);
  });

  it('com caixas cadastrados, abrir gaveta sem dizer QUAL é recusado — e a consulta avisa', async () => {
    await criarTerminal(gerente, 'Caixa 1');
    const semTerminal = await abrirCaixa(gerente, { openingCents: 0 });
    expect(semTerminal.status).toBe(400);
    expect(semTerminal.body.error.code).toBe('CORE_TERMINAL_REQUIRED');

    const consulta = await request(app).get('/api/v1/core/cash/open').set(gerente.auth);
    expect(consulta.status).toBe(200);
    expect(consulta.body.session).toBeNull();
    expect(consulta.body.exigeTerminal).toBe(true);
    expect(consulta.body.terminaisAtivos).toBe(1);
  });

  it('sem caixa cadastrado, a gaveta única de hoje continua funcionando', async () => {
    const res = await abrirCaixa(gerente, { openingCents: 0 });
    expect(res.status).toBe(201);
    expect(res.body.terminal_id).toBeNull();
    const consulta = await request(app).get('/api/v1/core/cash/open').set(gerente.auth);
    expect(consulta.body.session.id).toBe(res.body.id);
    expect(consulta.body.exigeTerminal).toBe(false);
  });

  it('reabrir é "o último turno DESTE caixa", não o último da loja', async () => {
    const cx1 = String((await criarTerminal(gerente, 'Caixa 1')).body.id);
    const cx2 = String((await criarTerminal(gerente, 'Caixa 2')).body.id);
    const g1 = await abrirCaixa(gerente, { openingCents: 0, terminalId: cx1 });
    const g2 = await abrirCaixa(gerente, { openingCents: 0, terminalId: cx2 });
    await request(app).post(`/api/v1/core/cash/${String(g1.body.id)}/close`).set(gerente.auth).send({ countedCents: 0 });
    // O Caixa 2 fecha DEPOIS — antes disto, o Caixa 1 não reabria mais.
    getConnection()
      .prepare("UPDATE core_cash_sessions SET closed_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), String(g1.body.id));
    await request(app).post(`/api/v1/core/cash/${String(g2.body.id)}/close`).set(gerente.auth).send({ countedCents: 0 });

    const reabre = await request(app)
      .post(`/api/v1/core/cash/${String(g1.body.id)}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'faltou lançar a sangria' });
    expect(reabre.status, JSON.stringify(reabre.body)).toBe(200);
    expect(reabre.body.status).toBe('open');
  });
});

// ============================================================================
// 3. O TOKEN DO TERMINAL, PRESO AO CAIXA (GAP-PRD-150)
// ============================================================================

describe('token de dispositivo preso ao caixa', () => {
  async function operadorDoBalcao(login: string): Promise<string> {
    const id = await upsertUser({ login, displayName: login, password: TEST_PASSWORD });
    linkUserToCompany(id, LOJA, 'operador_caixa_loja', false);
    return id;
  }

  it('o dono registra o token no Caixa 2, a lista diz qual caixa é, e o PDV abre só a gaveta dele', async () => {
    const dono = await entrar('dono-token', 'gestor');
    const cx1 = String((await criarTerminal(dono, 'Caixa 1')).body.id);
    const cx2 = String((await criarTerminal(dono, 'Caixa 2')).body.id);
    const pdv = await operadorDoBalcao(`pdv2@${LOJA}`);

    const enroll = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(dono.auth)
      .send({ userId: pdv, label: 'Computador do balcão 2', terminalId: cx2 });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(201);
    expect(enroll.body.id).toBeTruthy();
    expect(enroll.body.terminalId).toBe(cx2);
    const trilha = auditoria('auth.device_enroll');
    expect(trilha).toHaveLength(1);
    // A auditoria nunca guarda o token.
    expect(String(trilha[0].detail)).not.toContain(String(enroll.body.deviceToken));

    const lista = await request(app).get('/api/v1/auth/devices').set(dono.auth);
    expect(lista.body.items[0]).toMatchObject({ terminalId: cx2, terminalName: 'Caixa 2' });

    const login = await request(app).post('/api/v1/auth/device/login').send({ deviceToken: enroll.body.deviceToken });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const doTerminal = { Authorization: `Bearer ${login.body.accessToken as string}` };

    const consulta = await request(app).get('/api/v1/core/cash/open').set(doTerminal);
    expect(consulta.body.terminal).toMatchObject({ id: cx2, name: 'Caixa 2' });
    expect(consulta.body.terminalDoDispositivo).toBe(true);

    // O computador do Caixa 2 não abre a gaveta do Caixa 1, nem pedindo.
    const outro = await request(app)
      .post('/api/v1/core/cash/open')
      .set(doTerminal)
      .send({ openingCents: 0, terminalId: cx1 });
    expect(outro.status).toBe(409);
    expect(outro.body.error.code).toBe('CORE_TERMINAL_MISMATCH');

    const proprio = await request(app).post('/api/v1/core/cash/open').set(doTerminal).send({ openingCents: 0 });
    expect(proprio.status, JSON.stringify(proprio.body)).toBe(201);
    expect(proprio.body.terminal_id).toBe(cx2);
  });

  it('token para caixa de outra operação é 400; para caixa desligado, 409', async () => {
    const dono = await entrar('dono-token-2', 'gestor');
    const pdv = await operadorDoBalcao(`pdv3@${LOJA}`);
    const vizinho = await entrar('gerente-vizinho-2', 'gerente_loja', OUTRA);
    const deles = String((await criarTerminal(vizinho, 'Caixa 1')).body.id);

    const alheio = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(dono.auth)
      .send({ userId: pdv, label: 'PDV', terminalId: deles });
    expect(alheio.status).toBe(400);
    expect(alheio.body.error.code).toBe('CORE_TERMINAL_NOT_REGISTERED');

    const nosso = String((await criarTerminal(dono, 'Caixa 9')).body.id);
    await request(app)
      .post(`/api/v1/core/terminals/${nosso}/deactivate`)
      .set(dono.auth)
      .send({ reason: 'vendido' });
    const desligado = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(dono.auth)
      .send({ userId: pdv, label: 'PDV', terminalId: nosso });
    expect(desligado.status).toBe(409);
    expect(desligado.body.error.code).toBe('CORE_TERMINAL_INACTIVE');
  });

  it('desligar o caixa corta o login do token dele; revogar exige nada além do id e fica auditado', async () => {
    const dono = await entrar('dono-token-3', 'gestor');
    const cx = String((await criarTerminal(dono, 'Caixa 1')).body.id);
    const pdv = await operadorDoBalcao(`pdv4@${LOJA}`);
    const enroll = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(dono.auth)
      .send({ userId: pdv, label: 'PDV', terminalId: cx });

    await request(app).post(`/api/v1/core/terminals/${cx}/deactivate`).set(dono.auth).send({ reason: 'furtado' });
    const barrado = await request(app).post('/api/v1/auth/device/login').send({ deviceToken: enroll.body.deviceToken });
    expect(barrado.status).toBe(401);
    expect(barrado.body.error.message).toMatch(/desativado/i);

    await request(app).post(`/api/v1/core/terminals/${cx}/activate`).set(dono.auth).send({});
    const volta = await request(app).post('/api/v1/auth/device/login').send({ deviceToken: enroll.body.deviceToken });
    expect(volta.status).toBe(200);

    const revoga = await request(app)
      .post(`/api/v1/auth/device/${String(enroll.body.id)}/revoke`)
      .set(dono.auth)
      .send({ reason: 'computador trocado' });
    expect(revoga.status).toBe(200);
    const trilha = auditoria('auth.device_revoke');
    expect(JSON.parse(String(trilha[0].detail))).toMatchObject({ reason: 'computador trocado' });
  });
});

// ============================================================================
// 4. A GAVETA ESQUECIDA (GAP-PRD-131)
// ============================================================================

describe('gaveta aberta de outro dia é apontada', () => {
  it('a consulta do PDV e a lista das gavetas dizem desde quando — e a recusa de abrir diz a data', async () => {
    const cx = String((await criarTerminal(gerente, 'Caixa 1')).body.id);
    const velha = await abrirCaixa(gerente, { openingCents: 10_000, terminalId: cx });
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    getConnection()
      .prepare('UPDATE core_cash_sessions SET opened_at = ? WHERE id = ?')
      .run(trintaDiasAtras.toISOString(), String(velha.body.id));

    const consulta = await request(app).get(`/api/v1/core/cash/open?terminalId=${cx}`).set(gerente.auth);
    expect(consulta.body.session.id).toBe(velha.body.id);
    expect(consulta.body.deOutroDia).toMatchObject({ hoje: hojeNaLoja(), dias: 30 });

    const gavetas = await request(app).get('/api/v1/core/cash/drawers').set(gerente.auth);
    expect(gavetas.status, JSON.stringify(gavetas.body)).toBe(200);
    expect(gavetas.body.items).toHaveLength(1);
    expect(gavetas.body.items[0]).toMatchObject({
      sessionId: velha.body.id,
      terminalId: cx,
      terminalName: 'Caixa 1',
      openingCents: 10_000,
      expectedCents: 10_000,
      deOutroDia: expect.objectContaining({ dias: 30 }),
    });
    expect(gavetas.body.items[0].openedByName).toBe('gerente-dois-caixas');
    expect(gavetas.body.deOutroDia).toBe(1);

    const outra = await abrirCaixa(gerente, { openingCents: 0, terminalId: cx });
    expect(outra.status).toBe(409);
    expect(outra.body.error.code).toBe('CORE_CASH_ALREADY_OPEN');
    expect(outra.body.error.message).toMatch(/aberto desde \d{2}\/\d{2}\/\d{4}/);
  });

  it('a gaveta aberta hoje não é "de outro dia"', async () => {
    const aberta = await abrirCaixa(gerente, { openingCents: 0 });
    const consulta = await request(app).get('/api/v1/core/cash/open').set(gerente.auth);
    expect(consulta.body.session.id).toBe(aberta.body.id);
    expect(consulta.body.deOutroDia).toBeNull();
    const gavetas = await request(app).get('/api/v1/core/cash/drawers').set(gerente.auth);
    expect(gavetas.body.items[0].deOutroDia).toBeNull();
    expect(gavetas.body.items[0].terminalName).toBeNull();
    expect(gavetas.body.deOutroDia).toBe(0);
  });

  it('a lista das gavetas é da operação: a vizinha não aparece', async () => {
    await abrirCaixa(gerente, { openingCents: 0 });
    const vizinho = await entrar('gerente-vizinho-3', 'gerente_loja', OUTRA);
    const gavetas = await request(app).get('/api/v1/core/cash/drawers').set(vizinho.auth);
    expect(gavetas.status).toBe(200);
    expect(gavetas.body.items).toHaveLength(0);
  });
});
