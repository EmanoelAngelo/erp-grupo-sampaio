/**
 * `core_terminals` DEIXA DE SER BOMBA.
 *
 * ATUALIZAÇÃO (remediação PAG/P2, GAP-PRD-039/146): o cadastro de caixas
 * existe agora (`TerminalService`, rotas `/core/terminals`), e a guarda passou
 * a conferir a EMPRESA do caixa. O contrato deste arquivo continua valendo —
 * id que esta operação não cadastrou é 400 nomeado antes do INSERT — e a
 * mensagem mudou de "o cadastro não existe, deixe vazio" para "não está
 * cadastrado nesta operação, confira em Configurações › Caixas e terminais".
 * O caminho feliz com caixa cadastrado está em
 * `terminais-e-gaveta-por-caixa.test.ts`.
 *
 * O texto original, que descreve o defeito como ele era:
 *
 * A tabela está vazia, tem ZERO escritores, e TRÊS chaves estrangeiras apontam
 * para ela (`core_cash_sessions`, `core_sales`, `core_device_tokens`) com
 * `PRAGMA foreign_keys = ON`. Dois pontos de entrada aceitavam `terminalId`
 * de fora — `POST /core/cash/open` (corpo, com fallback em `req.auth.storeId`)
 * e `POST /auth/device/enroll` (corpo) — e quem mandasse um id qualquer tomava
 * FOREIGN KEY constraint failed: um 500 cru, sem uma palavra sobre a causa.
 *
 * PROVA DE QUE O GUARDA MORDE (quebrado de propósito, rodado, relatado):
 * comentando o `assertTerminalRegistered` de `openSession`, o caso do caixa
 * caiu com `expected 500 to be 400` — o estouro de FK cru voltou, que é
 * exatamente o defeito. Recolocado o guarda, verde.
 *
 * Isto NÃO é o CRUD de terminal (módulo próprio, fora desta rodada): é só a
 * tradução do estouro para um erro com nome, dito ANTES do INSERT.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';

const app = createApp();
const LOJA = 'loja-terminal';

async function entrar(perfil: string, userId: string) {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status).toBe(200);
  return { token: res.body.accessToken as string, userId: res.body.user?.id as string };
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

describe('POST /core/cash/open', () => {
  it('terminalId que não existe vira 400 NOMEADO — não um 500 de chave estrangeira', async () => {
    const { token } = await entrar('operador_caixa_loja', 'caixa');
    const res = await request(app)
      .post('/api/v1/core/cash/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ openingCents: 10_000, terminalId: 'gaveta-2' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_TERMINAL_NOT_REGISTERED');
    // A mensagem tem que dizer O QUE FAZER: onde se confere o cadastro.
    expect(res.body.error.message).toMatch(/não está cadastrado nesta operação/i);
    expect(res.body.error.message).toMatch(/Caixas e terminais/);

    // E NADA foi gravado pela metade.
    const sessoes = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_cash_sessions')
      .get() as { n: number };
    expect(sessoes.n).toBe(0);
  });

  it('sem terminalId o caixa abre normalmente — o caminho de hoje continua vivo', async () => {
    const { token } = await entrar('operador_caixa_loja', 'caixa');
    const res = await request(app)
      .post('/api/v1/core/cash/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ openingCents: 10_000 });
    expect(res.status).toBe(201);
    expect(res.body.terminal_id).toBeNull();
  });
});

describe('POST /auth/device/enroll', () => {
  it('terminalId que não existe vira o MESMO 400 nomeado', async () => {
    const admin = await entrar('admin_geral', 'administrador');
    // O alvo do token precisa existir e pertencer à empresa.
    const alvo = await entrar('operador_caixa_loja', 'caixa');

    const res = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ userId: alvo.userId, label: 'PDV 2', terminalId: 'terminal-fantasma' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_TERMINAL_NOT_REGISTERED');
  });

  it('sem terminalId o token de terminal nasce normalmente', async () => {
    const admin = await entrar('admin_geral', 'administrador');
    const alvo = await entrar('operador_caixa_loja', 'caixa');

    const res = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ userId: alvo.userId, label: 'PDV 2' });

    expect(res.status).toBe(201);
    expect(res.body.deviceToken).toBeTruthy();
  });
});

/*
  O TERCEIRO PONTO DE ENTRADA, achado por um atacante DEPOIS de a rodada
  afirmar que eram dois: a VENDA também aceita `terminalId` do corpo, e o
  inseria cru — 500 de chave estrangeira na rota mais usada do sistema,
  alcançável por qualquer operador de caixa.

  O guarda foi para dentro de `createSale`, no serviço, onde todo chamador
  passa. Este caso prova o 400 nomeado pela rota.
*/
describe('POST /core/sales', () => {
  it('terminalId que não existe vira 400 NOMEADO — a venda era o ponto esquecido', async () => {
    const { token, userId } = await entrar('gestor', 'dono-venda-terminal');

    // Um produto com estoque, para a venda ser legítima em tudo MENOS no terminal.
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                    price_cents, min_stock, active, is_kit, created_at, updated_at)
         VALUES ('p-term', ?, 'PT-1', 'Cabo', 'UN', 0, 1000, 0, 1, 0, ?, ?)`,
      )
      .run(LOJA, agora, agora);
    getConnection()
      .prepare(
        'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
      )
      .run(LOJA, 'p-term', agora);

    const res = await request(app)
      .post('/api/v1/core/sales')
      .set('Idempotency-Key', `t-${Math.random()}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({
        terminalId: 'terminal-fantasma',
        sellerId: userId,
        items: [{ productId: 'p-term', quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_TERMINAL_NOT_REGISTERED');

    // E nada foi gravado: o guarda fala ANTES do INSERT.
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(vendas.n).toBe(0);
  });

  it('sem terminalId, a venda segue como sempre', async () => {
    const { token, userId } = await entrar('gestor', 'dono-venda-normal');
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                    price_cents, min_stock, active, is_kit, created_at, updated_at)
         VALUES ('p-livre', ?, 'PL-1', 'Fonte', 'UN', 0, 2000, 0, 1, 0, ?, ?)`,
      )
      .run(LOJA, agora, agora);
    getConnection()
      .prepare(
        'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
      )
      .run(LOJA, 'p-livre', agora);

    const res = await request(app)
      .post('/api/v1/core/sales')
      .set('Idempotency-Key', `t-${Math.random()}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({
        sellerId: userId,
        items: [{ productId: 'p-livre', quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 2000 }],
      });

    expect(res.status).toBe(201);
  });
});
