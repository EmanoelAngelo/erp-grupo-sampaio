/**
 * ============================================================================
 * A POLÍTICA DE GESTÃO — GAP-PRD-165 (quem vê dinheiro) e GAP-PRD-166 (a régua)
 * ============================================================================
 *
 * Duas decisões moravam no código, com justificativa e sem o dono:
 *
 *   165  o painel (faturamento, ticket, recebíveis) e a posição de estoque com
 *        custo abriam para atendente e estoquista;
 *   166  o valor do estoque era sempre saldo × último custo do cadastro, e o
 *        contador pode exigir custo médio.
 *
 * Nasceu VERMELHO contra o HEAD anterior: o atendente recebia `revenueCents` e
 * `openReceivablesCents` numéricos, o estoquista recebia `cost_cents` e o total
 * do estoque, e `/management-policy` respondia 404. O que se trava aqui:
 *
 *   - padrão SEGURO: sem decisão, só a gerência vê dinheiro — no servidor;
 *   - o dono (e só ele) abre para a equipe, com trilha;
 *   - a régua "custo médio" refaz a média móvel do razão, e a posição, o total
 *     e a Central valorizam pela MESMA régua;
 *   - trocar a régua derruba a confirmação do contador.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { custoMedioPorProduto } from '../src/services/core/PoliticaDeGestaoService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'loja-politica';

interface Sessao {
  auth: { Authorization: string };
  companyId: string;
}

async function entrar(perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId: `u-${perfil}`, companyId: EMPRESA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, companyId: res.body.company.id };
}

let gerente: Sessao;
let dono: Sessao;

async function get(s: Sessao, url: string) {
  const res = await request(app).get(`/api/v1/core${url}`).set(s.auth);
  expect(res.status, `${url}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body;
}

async function produtoComEntradas(nome: string, custoDoCadastro: number, entradas: [number, number][]): Promise<string> {
  const p = await request(app).post('/api/v1/core/products').set(gerente.auth).send({ name: nome, priceCents: 9900, costCents: custoDoCadastro });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  for (const [i, [quantidade, custo]] of entradas.entries()) {
    const m = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerente.auth)
      .send({ productId: p.body.id, movementType: 'in', quantity: quantidade, unitCostCents: custo, referenceId: `entrada-${nome}-${i}` });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
  }
  return p.body.id as string;
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente_loja');
  dono = await entrar('admin_geral');
});

describe('GAP-PRD-165 — padrão seguro: só a gerência vê dinheiro', () => {
  it('o atendente abre o painel e recebe a contagem, sem faturamento, ticket nem recebíveis', async () => {
    getConnection()
      .prepare(
        `INSERT INTO core_finance_entries (id, company_id, direction, amount_cents, status, settled_cents,
                                           description, origin_type, origin_id, created_at)
         VALUES (?, ?, 'in', 5000, 'open', 0, 'A receber', 'manual', ?, ?)`,
      )
      .run(randomUUID(), gerente.companyId, randomUUID(), new Date().toISOString());

    const doGerente = await get(gerente, '/dashboard');
    expect(doGerente.openReceivablesCents).toBe(5000);
    expect(doGerente.revenueCents).toBe(0);
    expect(doGerente.dinheiroOculto).toBe(false);

    const atendente = await entrar('atendente');
    const doAtendente = await get(atendente, '/dashboard');
    expect(doAtendente).toMatchObject({
      revenueCents: null,
      averageTicketCents: null,
      openReceivablesCents: null,
      byBrandUnallocatedCents: null,
      dinheiroOculto: true,
    });
    expect(doAtendente.salesCount).toBe(0);
  });

  it('o estoquista abre a posição e recebe saldo e mínimo — custo e valor saem da resposta', async () => {
    await produtoComEntradas('Parafuso', 2000, [[10, 2000]]);
    const estoquista = await entrar('estoquista');

    const posicao = await get(estoquista, '/stock');
    expect(posicao.custoOculto).toBe(true);
    expect(posicao.items[0]).toMatchObject({ name: 'Parafuso', quantity: 10, cost_cents: null, value_cents: null });
    const valor = await get(estoquista, '/stock/valuation');
    expect(valor).toMatchObject({ totalCents: null, oculto: true, produtosComSaldo: 1 });

    // A gerência continua vendo.
    const doGerente = await get(gerente, '/stock');
    expect(doGerente.items[0]).toMatchObject({ cost_cents: 2000, value_cents: 20000 });
    expect((await get(gerente, '/stock/valuation')).totalCents).toBe(20000);
  });

  it('o DONO abre para a equipe; a trilha guarda antes e depois; o gerente não decide pelo dono', async () => {
    await produtoComEntradas('Parafuso', 2000, [[10, 2000]]);
    const atendente = await entrar('atendente');

    // Todo o escritório lê a política — com os padrões seguros e "não decidida".
    const lida = await get(atendente, '/management-policy');
    expect(lida.policy).toMatchObject({
      painelFinanceiroEquipe: false,
      custoDoEstoqueEquipe: false,
      reguaDeValorizacao: 'ultimo_custo',
      decidida: false,
    });

    const pelaGerencia = await request(app)
      .put('/api/v1/core/management-policy')
      .set(gerente.auth)
      .send({ painelFinanceiroEquipe: true });
    expect(pelaGerencia.status).toBe(403);

    const invalida = await request(app)
      .put('/api/v1/core/management-policy')
      .set(dono.auth)
      .send({ painelFinanceiroEquipe: 'sim' });
    expect(invalida.status).toBe(400);

    const salva = await request(app)
      .put('/api/v1/core/management-policy')
      .set(dono.auth)
      .send({ painelFinanceiroEquipe: true, custoDoEstoqueEquipe: true });
    expect(salva.status, JSON.stringify(salva.body)).toBe(200);
    expect(salva.body.policy).toMatchObject({ painelFinanceiroEquipe: true, custoDoEstoqueEquipe: true, decidida: true });

    expect((await get(atendente, '/dashboard')).dinheiroOculto).toBe(false);
    expect((await get(atendente, '/stock')).items[0].cost_cents).toBe(2000);

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'management_policy.updated'")
      .get() as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({
      antes: { painelFinanceiroEquipe: false },
      depois: { painelFinanceiroEquipe: true, custoDoEstoqueEquipe: true },
    });
  });

  it('a política é da empresa: a outra operação continua no padrão seguro', async () => {
    await request(app).put('/api/v1/core/management-policy').set(dono.auth).send({ painelFinanceiroEquipe: true });
    const outra = await loginForTest(app, { userId: 'atend-outra', companyId: 'outra-politica', profileCodes: ['atendente'] });
    const res = await request(app).get('/api/v1/core/dashboard').set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.body.dinheiroOculto).toBe(true);
  });
});

describe('GAP-PRD-166 — a régua do valor do estoque', () => {
  it('último custo (padrão) × custo médio móvel reconstruído do razão', async () => {
    // Cadastro diz 2000 (a última compra); o razão tem 10 a 1000 e 10 a 2000.
    const p = await produtoComEntradas('Filtro', 2000, [[10, 1000], [10, 2000]]);
    expect(custoMedioPorProduto(gerente.companyId).get(p)).toBe(1500);

    expect((await get(gerente, '/stock/valuation')).totalCents).toBe(40000); // 20 × 2000
    const media = await request(app).put('/api/v1/core/management-policy').set(dono.auth).send({ reguaDeValorizacao: 'custo_medio' });
    expect(media.status).toBe(200);

    const valor = await get(gerente, '/stock/valuation');
    expect(valor).toMatchObject({ totalCents: 30000, regua: 'custo_medio', semCustoNoRazao: 0 }); // 20 × 1500
    const posicao = await get(gerente, '/stock');
    expect(posicao.items[0]).toMatchObject({ cost_cents: 2000, valuation_cost_cents: 1500, value_cents: 30000 });

    // A saída não mexe na média: 15 × 1500.
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerente.auth)
      .send({ productId: p, movementType: 'out', quantity: 5, referenceId: 'saida-1', reason: 'venda simulada' });
    expect((await get(gerente, '/stock/valuation')).totalCents).toBe(22500);

    // A Central valoriza pela MESMA régua.
    const central = await get(gerente, '/reports/valorizacao');
    const linha = (central.rows ?? central.items ?? []).find((r: { name: string }) => r.name === 'Filtro');
    expect(linha).toMatchObject({ cost_cents: 1500, value_cents: 22500 });
  });

  it('produto sem nenhuma entrada com custo cai no cadastro — e é contado como pendência', async () => {
    const semCusto = await request(app).post('/api/v1/core/products').set(gerente.auth).send({ name: 'Sem custo no razão', priceCents: 500, costCents: 300 });
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerente.auth)
      .send({ productId: semCusto.body.id, movementType: 'in', quantity: 4, referenceId: 'sem-custo' });
    await request(app).put('/api/v1/core/management-policy').set(dono.auth).send({ reguaDeValorizacao: 'custo_medio' });
    expect(await get(gerente, '/stock/valuation')).toMatchObject({ totalCents: 1200, semCustoNoRazao: 1 });
  });

  it('a confirmação do contador vale para a régua confirmada; trocar a régua a derruba', async () => {
    const confirmada = await request(app)
      .put('/api/v1/core/management-policy')
      .set(dono.auth)
      .send({ reguaDeValorizacao: 'custo_medio', reguaConfirmadaPor: 'Contabilidade Silva' });
    expect(confirmada.body.policy).toMatchObject({ reguaDeValorizacao: 'custo_medio', reguaConfirmadaPor: 'Contabilidade Silva' });
    expect(confirmada.body.policy.reguaConfirmadaEm).toBeTruthy();

    const trocou = await request(app).put('/api/v1/core/management-policy').set(dono.auth).send({ reguaDeValorizacao: 'ultimo_custo' });
    expect(trocou.body.policy).toMatchObject({ reguaDeValorizacao: 'ultimo_custo', reguaConfirmadaPor: null, reguaConfirmadaEm: null });

    const invalida = await request(app).put('/api/v1/core/management-policy').set(dono.auth).send({ reguaDeValorizacao: 'fifo' });
    expect(invalida.status).toBe(400);
  });
});
