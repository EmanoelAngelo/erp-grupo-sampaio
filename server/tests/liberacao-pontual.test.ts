/**
 * ============================================================================
 * A LIBERAÇÃO PONTUAL — o gerente está na loja, e o sistema passa a saber disso
 * ============================================================================
 *
 * ## Os quatro defeitos que este arquivo prende
 *
 * 1. CANCELAR E DEVOLVER ERAM PERFIL OU NADA (GAP-V60). As duas rotas exigiam
 *    `gerente_loja` e paravam ali. O gerente estava ao lado do balcão, e não
 *    havia como ele dizer "pode" sem trocar de sessão — que na prática
 *    significa emprestar a senha, o contorno que toda loja inventa e que
 *    nenhuma trilha registra. O mecanismo certo já existia (a liberação de
 *    desconto acima da alçada) e era usado em UM lugar; esta rodada o
 *    GENERALIZA em vez de criar um segundo.
 *
 * 2. O IP ERA ACEITO E JOGADO FORA (GAP-V61). `authorizeAction` tinha `ip` na
 *    assinatura, a rota o preenchia, e a tabela não tinha coluna. O endereço
 *    chegava e morria no parâmetro — e quem lia a chamada acreditava que ele
 *    ficava gravado. O terminal nem parâmetro tinha.
 *
 * 3. `GET /core/authorizations` ERA ÓRFÃ (GAP-V62). Existia desde a primeira
 *    rodada da alçada e nenhuma tela a chamava.
 *
 * 4. REABRIR CAIXA NÃO EXISTIA (GAP-V64). `reabrir_caixa` esteve declarada em
 *    `RESTRICTED_ACTIONS` e foi retirada de lá justamente por isso: a lista
 *    prometia uma tranca sobre um recurso inexistente.
 *
 * ## COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito)
 *
 *   - trocando `comLiberacaoPontual` por `requireProfile(req, 'gerente_loja')`
 *     em `POST /sales/:id/cancel`: os seis casos do bloco 1 que passam pela
 *     liberação ficam vermelhos com 403 API_PERMISSION_DENIED;
 *   - tirando a conferência de `reference_id` de `consumirLiberacaoDeAcao`: a
 *     liberação da venda A cancela a venda B e o caso do "recurso errado" fica
 *     verde por engano — este é o vão que a coluna escrita sem leitor deixava;
 *   - tirando a comparação de idade contra `VALIDADE_DA_LIBERACAO_MS`: o
 *     bilhete de ontem cancela a venda de hoje;
 *   - tirando `terminal_id`/`ip` do INSERT de `authorizeAction`: os dois casos
 *     do bloco 3 voltam a ler nulo, que é exatamente o estado anterior;
 *   - tirando a checagem de "última fechada" de `reopenSession`: o turno do
 *     meio do histórico reabre e o caso do 409 cai;
 *   - tirando o `diaDaLoja` da mesma função: o turno de ontem reabre hoje.
 *
 * Nenhum caso procura texto de código: todos sobem por HTTP com token real e
 * conferem o que ficou no banco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { VALIDADE_DA_LIBERACAO_MS } from '../src/services/core/AuthorizationService.js';

const LOJA = 'loja-liberacao';
const OUTRA = 'loja-vizinha';

const app = createApp();

interface Sessao {
  auth: { Authorization: string };
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

/** Quem tem alçada e cancela direto. */
let gerente: Sessao;
/** Quem abre a tela de devoluções e NÃO cancela nada sozinho. */
let estoquista: Sessao;

/** O login do gestor, como o diálogo do balcão o digita. */
const LOGIN_GERENTE = `gerente-lib@${LOJA}`;

async function produto(nome: string, precoCents: number, quantidade: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: nome, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await request(app).post('/api/v1/core/stock/movements').set(gerente.auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id as string}`,
  });
  return String(p.body.id);
}

async function venda(productId: string, totalCents: number): Promise<{ id: string }> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(gerente.auth)
    .send({
      idempotencyKey: randomUUID(),
      items: [{ productId, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: totalCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.sale ?? res.body) as { id: string };
}

/** Pede a liberação como a tela pede: pela rota, com a credencial do gestor. */
function pedirLiberacao(
  quem: Sessao,
  corpo: Record<string, unknown>,
): request.Test {
  return request(app)
    .post('/api/v1/core/authorizations')
    .set(quem.auth)
    .send({ login: LOGIN_GERENTE, password: TEST_PASSWORD, ...corpo });
}

function linhaDaLiberacao(id: string): {
  consumed_ref_type: string | null;
  consumed_ref_id: string | null;
  reference_id: string | null;
  terminal_id: string | null;
  ip: string | null;
} {
  return getConnection()
    .prepare(
      `SELECT consumed_ref_type, consumed_ref_id, reference_id, terminal_id, ip
         FROM core_authorizations WHERE id = ?`,
    )
    .get(id) as never;
}

/** O detalhe da última linha de auditoria daquela ação. */
function ultimaAuditoria(acao: string): Record<string, unknown> {
  const linha = getConnection()
    .prepare(
      `SELECT detail FROM core_audit_log
        WHERE company_id = ? AND action = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(LOJA, acao) as { detail: string } | undefined;
  expect(linha, `nenhuma auditoria de ${acao}`).toBeDefined();
  return JSON.parse(linha!.detail) as Record<string, unknown>;
}

function statusDaVenda(id: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_sales WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-lib', 'gerente_loja');
  estoquista = await entrar('estoque-lib', 'estoquista');
});

/* ========================================================================== */
/* BLOCO 1 — CANCELAR: A PORTA DE DUAS PORTAS (GAP-V60)                       */
/* ========================================================================== */

describe('cancelar venda: perfil OU liberação pontual, e nunca um terceiro caminho', () => {
  it('O CAMINHO ANTIGO CONTINUA: o gerente cancela DIRETO, sem pedir nada a ninguém', async () => {
    /*
      É a metade que decide se a rodada foi um ganho ou uma armadilha. Exigir
      liberação também do gerente seria o argumento que TIROU `cancelar_venda`
      da lista de ações restritas: ninguém autoriza a própria ação, e o gerente
      teria de chamar um segundo gerente para cancelar.
    */
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const res = await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(gerente.auth)
      .send({ reason: 'cliente desistiu' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(statusDaVenda(v.id)).toBe('cancelled');

    // E nenhuma liberação foi criada: o gerente não pediu nada.
    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_authorizations')
      .get() as { n: number };
    expect(quantas.n).toBe(0);
  });

  it('o operador SEM perfil recebe o 403 NOMEADO — e a venda não muda', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const res = await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(estoquista.auth)
      .send({ reason: 'engano' });

    expect(res.status).toBe(403);
    /*
      O CÓDIGO É O CONTEÚDO. `API_PERMISSION_DENIED` diria "não pode" e a tela
      não teria o que oferecer; este diz "não pode SOZINHO", e é ele que faz o
      diálogo do gestor abrir. O `details` leva a ação e o alvo porque, sem os
      dois, a tela teria de adivinhar o que mandar no pedido de liberação.
    */
    expect(res.body.error.code).toBe('CORE_CANCEL_NEEDS_AUTHORIZATION');
    expect(res.body.error.details.action).toBe('cancelar_venda');
    expect(res.body.error.details.referenceId).toBe(v.id);
    expect(statusDaVenda(v.id)).toBe('completed');
  });

  it('COM a liberação do gestor a venda cancela, e a trilha guarda os DOIS usuários', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: v.id,
      reason: 'erro de digitação no balcão',
    });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const res = await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(estoquista.auth)
      .send({ reason: 'erro de digitação', authorizationId: lib.body.id });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(statusDaVenda(v.id)).toBe('cancelled');

    /*
      QUEM PEDIU E QUEM ASSINOU, na mesma linha. `userId` sozinho diria que a
      estoquista cancelou por conta própria — que é justamente a leitura falsa
      que o empréstimo de senha produz hoje, e que esta rodada existe para
      substituir.
    */
    const detalhe = ultimaAuditoria('sale.cancel');
    expect(detalhe.requestingUserId).toBe(estoquista.userId);
    expect(detalhe.authorizingUserId).toBe(gerente.userId);
    expect(detalhe.authorizationId).toBe(lib.body.id);

    // O bilhete foi GASTO nesta venda — é o que impede a segunda viagem.
    const marca = linhaDaLiberacao(String(lib.body.id));
    expect(marca.consumed_ref_type).toBe('sale');
    expect(marca.consumed_ref_id).toBe(v.id);
  });

  it('FALSIFICAÇÃO — senha errada não libera nada, e não deixa liberação no banco', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set(estoquista.auth)
      .send({
        action: 'cancelar_venda',
        referenceId: v.id,
        login: LOGIN_GERENTE,
        password: 'nao-e-a-senha',
      });

    expect(lib.status).toBe(403);
    expect(lib.body.error.code).toBe('CORE_AUTHORIZATION_DENIED');
    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_authorizations')
      .get() as { n: number };
    expect(quantas.n).toBe(0);
  });

  it('FALSIFICAÇÃO — gestor de OUTRA empresa não tem alçada nesta operação', async () => {
    /*
      A senha está certa e o perfil é de gerente: o que falha é o VÍNCULO. Sem
      esta trava, o grupo inteiro viraria uma empresa só na hora de liberar, e
      o gerente da loja vizinha assinaria cancelamentos daqui.
    */
    upsertCompany({ id: OUTRA, slug: OUTRA, legalName: 'Vizinha Ltda', tradeName: 'Vizinha' });
    const vizinho = await upsertUser({
      login: `gerente-vizinho@${OUTRA}`,
      displayName: 'Gerente da Vizinha',
      password: TEST_PASSWORD,
    });
    linkUserToCompany(vizinho, OUTRA, 'gerente_loja', true);

    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set(estoquista.auth)
      .send({
        action: 'cancelar_venda',
        referenceId: v.id,
        login: `gerente-vizinho@${OUTRA}`,
        password: TEST_PASSWORD,
      });

    expect(lib.status).toBe(403);
    expect(lib.body.error.code).toBe('CORE_AUTHORIZATION_DENIED');
    expect(lib.body.error.message).toContain('alçada');
  });

  it('FALSIFICAÇÃO — a liberação JÁ GASTA não cancela uma segunda venda', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const primeira = await venda(p, 20_000);
    const segunda = await venda(p, 20_000);

    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: primeira.id,
    });
    // O motivo passou a ser obrigatório (E-venda-servidor-M01). Sem ele o
    // primeiro cancelamento seria recusado ANTES de gastar o bilhete, e o
    // segundo pedido mediria outra coisa (bilhete de outra venda, não gasto).
    const primeiro = await request(app)
      .post(`/api/v1/core/sales/${primeira.id}/cancel`)
      .set(estoquista.auth)
      .send({ authorizationId: lib.body.id, reason: 'cliente desistiu' });
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(200);

    const res = await request(app)
      .post(`/api/v1/core/sales/${segunda.id}/cancel`)
      .set(estoquista.auth)
      .send({ authorizationId: lib.body.id, reason: 'cliente desistiu' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_AUTHORIZATION_ALREADY_USED');
    expect(statusDaVenda(segunda.id)).toBe('completed');
  });

  it('FALSIFICAÇÃO — a liberação de UMA venda não vale para OUTRA', async () => {
    /*
      O caso que a coluna `reference_id` escrita sem leitor deixava passar. O
      bilhete está fresco, é do operador certo e nunca foi gasto: o único
      motivo para recusá-lo é o ALVO. Sem a conferência, o "sim" para a venda
      #482 cancela a #483 sem nenhum sintoma.
    */
    const p = await produto('Capacete', 20_000, 5);
    const liberada = await venda(p, 20_000);
    const outra = await venda(p, 20_000);

    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: liberada.id,
    });

    const res = await request(app)
      .post(`/api/v1/core/sales/${outra.id}/cancel`)
      .set(estoquista.auth)
      .send({ authorizationId: lib.body.id });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_AUTHORIZATION_OTHER_RESOURCE');
    expect(res.body.error.details.liberadoPara).toBe(liberada.id);
    expect(res.body.error.details.pedidoPara).toBe(outra.id);
    expect(statusDaVenda(outra.id)).toBe('completed');

    // E o bilhete continua INTACTO: recusar não é gastar.
    expect(linhaDaLiberacao(String(lib.body.id)).consumed_ref_id).toBeNull();
  });

  it('FALSIFICAÇÃO — a liberação VENCE, e o bilhete de ontem não cancela hoje', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: v.id,
    });

    // Envelhece o bilhete um minuto além da validade — é o operador que pede a
    // senha de manhã "para conferir uma coisa" e usa à noite, com a loja vazia.
    getConnection()
      .prepare('UPDATE core_authorizations SET created_at = ? WHERE id = ?')
      .run(
        new Date(Date.now() - VALIDADE_DA_LIBERACAO_MS - 60_000).toISOString(),
        lib.body.id,
      );

    const res = await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(estoquista.auth)
      .send({ authorizationId: lib.body.id });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_AUTHORIZATION_EXPIRED');
    expect(statusDaVenda(v.id)).toBe('completed');
  });

  it('FALSIFICAÇÃO — a liberação de OUTRO operador não serve a este', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);
    const outroOperador = await entrar('atende-lib', 'atendente');

    const lib = await pedirLiberacao(outroOperador, {
      action: 'cancelar_venda',
      referenceId: v.id,
    });

    const res = await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(estoquista.auth)
      .send({ authorizationId: lib.body.id });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_AUTHORIZATION_NOT_YOURS');
  });

  it('pedir liberação de ação com ALVO sem informar o alvo é recusado antes da senha', async () => {
    const res = await pedirLiberacao(estoquista, { action: 'cancelar_venda' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_AUTHORIZATION_NEEDS_REFERENCE');
  });
});

/* ========================================================================== */
/* BLOCO 2 — DEVOLVER: A MESMA PORTA, E O "SIM" NÃO ATRAVESSA AÇÕES           */
/* ========================================================================== */

describe('devolução: a mesma liberação, e ela não paga a ação vizinha', () => {
  async function itemDevolvivel(saleId: string): Promise<string> {
    const res = await request(app)
      .get(`/api/v1/core/sales/${saleId}/returnable`)
      .set(gerente.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return String(res.body.items[0].sale_item_id);
  }

  it('o operador SEM perfil recebe o 403 nomeado da devolução', async () => {
    const p = await produto('Bota', 30_000, 5);
    const v = await venda(p, 30_000);
    const item = await itemDevolvivel(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(estoquista.auth)
      .send({
        saleId: v.id,
        reason: 'apertou',
        refundMethod: 'pix',
        items: [{ saleItemId: item, quantity: 1 }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_RETURN_NEEDS_AUTHORIZATION');
    expect(res.body.error.details.action).toBe('devolver_venda');
  });

  it('COM a liberação a devolução é registrada, com os dois usuários na trilha', async () => {
    const p = await produto('Bota', 30_000, 5);
    const v = await venda(p, 30_000);
    const item = await itemDevolvivel(v.id);

    const lib = await pedirLiberacao(estoquista, {
      action: 'devolver_venda',
      referenceId: v.id,
      reason: 'cliente voltou com a bota',
    });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(estoquista.auth)
      .send({
        saleId: v.id,
        reason: 'apertou',
        refundMethod: 'pix',
        items: [{ saleItemId: item, quantity: 1 }],
        authorizationId: lib.body.id,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const detalhe = ultimaAuditoria('sale_returns.created');
    expect(detalhe.requestingUserId).toBe(estoquista.userId);
    expect(detalhe.authorizingUserId).toBe(gerente.userId);
    expect(linhaDaLiberacao(String(lib.body.id)).consumed_ref_id).toBe(v.id);
  });

  it('FALSIFICAÇÃO — liberação de CANCELAR não paga uma devolução', async () => {
    /*
      A ação faz parte da consulta do consumo de propósito. Sem isso, um "sim"
      para desfazer a venda inteira serviria para devolver um item — e o
      contrário também, que é pior: devolver uma peça é decisão menor que
      cancelar a venda toda.
    */
    const p = await produto('Bota', 30_000, 5);
    const v = await venda(p, 30_000);
    const item = await itemDevolvivel(v.id);

    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: v.id,
    });

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(estoquista.auth)
      .send({
        saleId: v.id,
        reason: 'apertou',
        refundMethod: 'pix',
        items: [{ saleItemId: item, quantity: 1 }],
        authorizationId: lib.body.id,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_AUTHORIZATION_INVALID');
    // E o bilhete de cancelar continua inteiro — ele não foi gasto aqui.
    expect(linhaDaLiberacao(String(lib.body.id)).consumed_ref_id).toBeNull();
  });
});

/* ========================================================================== */
/* BLOCO 3 — ONDE A SENHA FOI DIGITADA (GAP-V61)                              */
/* ========================================================================== */

describe('a liberação grava ONDE foi digitada — terminal e IP', () => {
  it('em sessão de login comum: IP do socket gravado, terminal NULO — e nulo é a verdade', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: v.id,
    });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const linha = linhaDaLiberacao(String(lib.body.id));
    // Antes desta rodada as duas colunas não existiam e o `ip` montado na rota
    // era descartado em silêncio.
    expect(linha.ip).toBeTruthy();
    expect(linha.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(linha.terminal_id).toBeNull();
    // E a resposta devolve os dois, para a tela não ter de reconsultar.
    expect(lib.body.ip).toBe(linha.ip);
    expect(lib.body.terminalId).toBeNull();
  });

  it('em sessão de TERMINAL: o terminal do token vai junto — e vem do token, não do corpo', async () => {
    /*
      O terminal sai do TOKEN de propósito. Aceitá-lo do corpo faria a etiqueta
      de "onde a senha foi digitada" ser escolhida por quem digita — é a mesma
      regra que fez o denominador da alçada sair do servidor e não da
      requisição.
    */
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_terminals (id, company_id, code, name, active, created_at)
         VALUES ('term-1', ?, 'CX1', 'Caixa 1', 1, ?)`,
      )
      .run(LOJA, agora);

    const caixaId = await upsertUser({
      login: `pdv-balcao@${LOJA}`,
      displayName: 'PDV Balcão',
      password: TEST_PASSWORD,
    });
    linkUserToCompany(caixaId, LOJA, 'operador_caixa_loja', false);

    const admin = await entrar('dono-lib', 'admin_geral');
    const enroll = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(admin.auth)
      .send({ userId: caixaId, label: 'Caixa 1', terminalId: 'term-1' });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(201);

    const sessao = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken: enroll.body.deviceToken });
    expect(sessao.status, JSON.stringify(sessao.body)).toBe(200);

    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);

    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set({ Authorization: `Bearer ${sessao.body.accessToken as string}` })
      .send({
        action: 'cancelar_venda',
        referenceId: v.id,
        login: LOGIN_GERENTE,
        password: TEST_PASSWORD,
        // Mentira no corpo: o terminal gravado tem de ser o do token.
        terminalId: 'term-inventado',
      });

    expect(lib.status, JSON.stringify(lib.body)).toBe(201);
    expect(linhaDaLiberacao(String(lib.body.id)).terminal_id).toBe('term-1');
  });
});

/* ========================================================================== */
/* BLOCO 4 — A ROTA ÓRFÃ GANHA LEITOR (GAP-V62)                               */
/* ========================================================================== */

describe('GET /core/authorizations: a consulta que nenhuma tela chamava', () => {
  it('devolve quem pediu, quem liberou, a ação, o recurso, o terminal e o IP', async () => {
    const p = await produto('Capacete', 20_000, 5);
    const v = await venda(p, 20_000);
    const lib = await pedirLiberacao(estoquista, {
      action: 'cancelar_venda',
      referenceId: v.id,
      reason: 'erro de digitação',
    });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const dono = await entrar('dono-lib', 'admin_geral');
    const res = await request(app).get('/api/v1/core/authorizations').set(dono.auth);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const linha = res.body.items[0] as Record<string, unknown>;
    /*
      OS DOIS NOMES. `authorized_by_name` sozinho contava metade: numa lista de
      liberações, "o caixa novo pediu seis esta semana" é o fato que interessa,
      e um uuid em `requested_by` não deixa ninguém vê-lo.
    */
    expect(linha.requested_by_name).toBe('estoque-lib');
    expect(linha.authorized_by_name).toBe('gerente-lib');
    expect(linha.action).toBe('cancelar_venda');
    expect(linha.reference_id).toBe(v.id);
    expect(linha.reason).toBe('erro de digitação');
    expect(linha.ip).toBeTruthy();
  });

  it('o GERENTE não lê a lista: é o diário de vigilância dele', async () => {
    /*
      O mesmo argumento que fecha `GET /core/audit` a `gerente_loja`, e aqui ele
      é mais forte: a linha nomeia o gerente que ASSINOU. O guarda estreitou
      nesta rodada, e estreitou junto com a tela que passou a consumir a rota —
      a seção de Auditoria, que já é só de quem responde pelo grupo.
    */
    const res = await request(app).get('/api/v1/core/authorizations').set(gerente.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
  });

  it('a lista é da EMPRESA — a liberação da vizinha não aparece aqui', async () => {
    upsertCompany({ id: OUTRA, slug: OUTRA, legalName: 'Vizinha Ltda', tradeName: 'Vizinha' });
    getConnection()
      .prepare(
        `INSERT INTO core_authorizations
           (id, company_id, action, requested_by, authorized_by, created_at)
         VALUES (?, ?, 'desconto_acima_limite', 'x', 'y', ?)`,
      )
      .run(randomUUID(), OUTRA, new Date().toISOString());

    const dono = await entrar('dono-lib', 'admin_geral');
    const res = await request(app).get('/api/v1/core/authorizations').set(dono.auth);
    expect(res.body.items).toHaveLength(0);
  });

  it('`?limit=abc` não derruba a consulta com 500 — o teto engole o NaN', async () => {
    const dono = await entrar('dono-lib', 'admin_geral');
    const res = await request(app).get('/api/v1/core/authorizations?limit=abc').set(dono.auth);
    expect(res.status).toBe(200);
  });
});

/* ========================================================================== */
/* BLOCO 5 — REABRIR O TURNO (GAP-V64)                                        */
/* ========================================================================== */

describe('reabertura de caixa: só a última, só hoje, e a conferência não some', () => {
  async function abrir(quem: Sessao, openingCents = 10_000): Promise<string> {
    const res = await request(app)
      .post('/api/v1/core/cash/open')
      .set(quem.auth)
      .send({ openingCents });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return String(res.body.id);
  }

  async function fechar(quem: Sessao, sessionId: string, countedCents: number): Promise<void> {
    const res = await request(app)
      .post(`/api/v1/core/cash/${sessionId}/close`)
      .set(quem.auth)
      .send({ countedCents });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  function turno(id: string): Record<string, unknown> {
    return getConnection()
      .prepare('SELECT * FROM core_cash_sessions WHERE id = ?')
      .get(id) as Record<string, unknown>;
  }

  it('o gerente reabre DIRETO, e o fechamento desfeito vai para a TRILHA', async () => {
    const sessao = await abrir(gerente);
    // Contou R$ 60,00 numa gaveta que esperava R$ 100,00: falta de R$ 40,00.
    await fechar(gerente, sessao, 6_000);

    const res = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'faltou lançar a sangria' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const linha = turno(sessao);
    expect(linha.status).toBe('open');

    /*
      AS COLUNAS VIVAS VOLTAM A NULO, e isso é o estado honesto: gaveta aberta
      não tem contagem. Deixar o contado de um fechamento desfeito na linha
      faria a tela exibir uma conferência que não vale mais.
    */
    expect(linha.counted_cents).toBeNull();
    expect(linha.expected_cents).toBeNull();
    expect(linha.difference_cents).toBeNull();
    expect(linha.closed_at).toBeNull();

    /*
      E A CONFERÊNCIA NÃO SUMIU. Apagar a falta de R$ 40,00 que alguém já
      explicou seria a outra saída ruim — a que transforma "reabrir o turno" em
      "sumir com o problema".
    */
    const trilha = JSON.parse(String(linha.closing_trail)) as Record<string, unknown>[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].counted_cents).toBe(6_000);
    expect(trilha[0].expected_cents).toBe(10_000);
    expect(trilha[0].difference_cents).toBe(-4_000);
    expect(trilha[0].reopen_reason).toBe('faltou lançar a sangria');
    expect(linha.reopen_count).toBe(1);
  });

  it('reaberta, a gaveta VOLTA A ACEITAR movimento, e o fechamento seguinte RECALCULA', async () => {
    const sessao = await abrir(gerente);
    await fechar(gerente, sessao, 10_000);

    // Fechado, o movimento é recusado — é a regra de sempre.
    const antes = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(gerente.auth)
      .send({ movementType: 'supply', amountCents: 5_000 });
    expect(antes.status).toBe(409);
    expect(antes.body.error.code).toBe('CORE_CASH_CLOSED');

    await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'faltou o suprimento' });

    const depois = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(gerente.auth)
      .send({ movementType: 'supply', amountCents: 5_000 });
    expect(depois.status, JSON.stringify(depois.body)).toBe(201);

    // O esperado é a soma dos MOVIMENTOS, e o novo entrou na conta: R$ 150,00.
    await fechar(gerente, sessao, 15_000);
    const linha = turno(sessao);
    expect(linha.expected_cents).toBe(15_000);
    expect(linha.difference_cents).toBe(0);
    // E a trilha continua guardando o fechamento anterior.
    expect(JSON.parse(String(linha.closing_trail))).toHaveLength(1);
  });

  it('o operador SEM alçada precisa da liberação — e com ela reabre', async () => {
    const sessao = await abrir(gerente);
    await fechar(gerente, sessao, 10_000);

    const caixa = await entrar('caixa-lib', 'operador_caixa_loja');

    const semLiberacao = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(caixa.auth)
      .send({ reason: 'esqueci uma venda' });
    expect(semLiberacao.status).toBe(403);
    expect(semLiberacao.body.error.code).toBe('CORE_REOPEN_NEEDS_AUTHORIZATION');
    expect(turno(sessao).status).toBe('closed');

    const lib = await pedirLiberacao(caixa, {
      action: 'reabrir_caixa',
      referenceId: sessao,
      reason: 'faltou lançar uma venda no turno',
    });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const comLiberacao = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(caixa.auth)
      .send({ reason: 'esqueci uma venda', authorizationId: lib.body.id });

    expect(comLiberacao.status, JSON.stringify(comLiberacao.body)).toBe(200);
    expect(turno(sessao).status).toBe('open');

    const detalhe = ultimaAuditoria('cash.reopen');
    expect(detalhe.requestingUserId).toBe(caixa.userId);
    expect(detalhe.authorizingUserId).toBe(gerente.userId);
    expect(linhaDaLiberacao(String(lib.body.id)).consumed_ref_id).toBe(sessao);
  });

  it('FALSIFICAÇÃO — o turno ANTIGO não reabre: só o último fechado', async () => {
    const primeiro = await abrir(gerente);
    await fechar(gerente, primeiro, 10_000);
    const segundo = await abrir(gerente);
    await fechar(gerente, segundo, 10_000);

    const res = await request(app)
      .post(`/api/v1/core/cash/${primeiro}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'quero mexer no de ontem de manhã' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_NOT_LAST_SESSION');
    expect(res.body.error.details.ultimaFechada).toBe(segundo);
    expect(turno(primeiro).status).toBe('closed');
  });

  it('FALSIFICAÇÃO — turno de OUTRA empresa não existe: 404, e não 403', async () => {
    upsertCompany({ id: OUTRA, slug: OUTRA, legalName: 'Vizinha Ltda', tradeName: 'Vizinha' });
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_cash_sessions
           (id, company_id, terminal_id, opened_by, closed_by, opening_cents,
            counted_cents, expected_cents, difference_cents, status, opened_at, closed_at)
         VALUES ('turno-vizinho', ?, NULL, 'x', 'x', 0, 0, 0, 0, 'closed', ?, ?)`,
      )
      .run(OUTRA, agora, agora);

    const res = await request(app)
      .post('/api/v1/core/cash/turno-vizinho/reopen')
      .set(gerente.auth)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_CASH_NOT_FOUND');
    // E o turno da vizinha continua fechado — a recusa não tocou nele.
    expect(
      (
        getConnection()
          .prepare('SELECT status FROM core_cash_sessions WHERE id = ?')
          .get('turno-vizinho') as { status: string }
      ).status,
    ).toBe('closed');
  });

  it('FALSIFICAÇÃO — a SEGUNDA reabertura seguida é recusada: o turno já está aberto', async () => {
    const sessao = await abrir(gerente);
    await fechar(gerente, sessao, 10_000);

    const primeira = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'primeira' });
    expect(primeira.status).toBe(200);

    const segunda = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'segunda' });

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_CASH_ALREADY_OPEN');
    // E a trilha continua com UM fechamento — a recusa não empilhou nada.
    expect(JSON.parse(String(turno(sessao).closing_trail))).toHaveLength(1);
    expect(turno(sessao).reopen_count).toBe(1);
  });

  it('reabrir DUAS VEZES o mesmo turno empilha DOIS fechamentos na trilha', async () => {
    /*
      A outra leitura de "duas reaberturas", e ela precisa funcionar: fechar,
      reabrir, fechar de novo e reabrir de novo é o dia em que o caixa erra a
      contagem duas vezes. O que não pode acontecer é a segunda reabertura
      apagar o primeiro fechamento — a trilha é uma PILHA, não um campo.
    */
    const sessao = await abrir(gerente);
    await fechar(gerente, sessao, 6_000);
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'contei errado' });
    await fechar(gerente, sessao, 9_000);
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'contei errado de novo' });

    const linha = turno(sessao);
    const trilha = JSON.parse(String(linha.closing_trail)) as Record<string, unknown>[];
    expect(trilha).toHaveLength(2);
    expect(trilha[0].counted_cents).toBe(6_000);
    expect(trilha[1].counted_cents).toBe(9_000);
    expect(linha.reopen_count).toBe(2);
  });

  it('FALSIFICAÇÃO — o turno de ONTEM não reabre hoje', async () => {
    /*
      O dia é o do CALENDÁRIO DA LOJA, e não 24 horas corridas: o que autoriza
      reabrir é a gaveta ainda estar ali, com o mesmo dinheiro e as mesmas
      pessoas. Amanhã de manhã aquele fechamento já é o fato do dia anterior.
    */
    const sessao = await abrir(gerente);
    await fechar(gerente, sessao, 10_000);
    const ontem = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    getConnection()
      .prepare('UPDATE core_cash_sessions SET closed_at = ?, opened_at = ? WHERE id = ?')
      .run(ontem, ontem, sessao);

    const res = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(gerente.auth)
      .send({ reason: 'ficou faltando' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_REOPEN_TOO_LATE');
    expect(turno(sessao).status).toBe('closed');
  });
});
