/**
 * ============================================================================
 * A COMISSÃO NÃO ATRAVESSA A EMPRESA
 * ============================================================================
 *
 * ## De onde este arquivo veio
 *
 * A varredura de perfis do RBAC (`tests/rbac/varredura/`) bate em todas as
 * rotas guardadas com um id INVENTADO, para medir o guarda. Ela media só o
 * guarda: o status de quem PASSA nunca foi conferido. Cinco dos onze arquivos
 * imprimiam, a cada corrida, a mesma pilha em `stderr`:
 *
 *     path: /api/v1/core/commissions/groups/varredura-rbac-x/tiers
 *     erro: FOREIGN KEY constraint failed  (CommissionService.ts setTier)
 *
 * Erro que aparece sempre é erro que ninguém lê. Puxado o fio, o 500 era só a
 * ponta: `setTier` nunca conferia de quem é o grupo — e o irmão ao lado,
 * `setMemberGroup`, confere. A explicação inteira do defeito está no
 * comentário de `grupoDaEmpresa`, em `CommissionService.ts`.
 *
 * ## O que cada caso falsifica
 *
 *  1. A FAIXA NO GRUPO DA VIZINHA. Com token da A e o id do grupo da B, a
 *     linha NASCIA — `company_id` da A, `group_id` da B — e voltava 200. O
 *     caso cobra 404 E confere no banco que nenhuma linha nova existe: só o
 *     status seria prova fraca, porque a rota poderia gravar e depois falhar.
 *
 *  2. O ORÁCULO DO UNIQUE. `UNIQUE (group_id, min_cents)` é do grupo, não da
 *     empresa. Repetindo o `minCents` que a B já usa, a A recebia 500; num
 *     valor livre, 200. Dois status contam ao de fora o que a vizinha
 *     cadastrou. O caso cobra o MESMO 404 nos dois valores — a resposta não
 *     pode depender do que existe do outro lado.
 *
 *  3. O GRUPO INEXISTENTE. Nenhuma empresa tem esse id: 404 do domínio, e
 *     nunca 500 de chave estrangeira.
 *
 *  4. A PESSOA DE FORA DO VÍNCULO. `PUT /commissions/members/:userId` conferia
 *     o grupo e não a pessoa: o mecânico da B virava vendedor comissionado da
 *     A. 404, e nenhuma linha em `core_commission_members`.
 *
 *  5. A METADE QUE FALSIFICA O RESTO. Dentro da própria empresa, faixa e
 *     vendedor continuam passando. Sem este caso, recusar tudo deixaria o
 *     arquivo verde.
 *
 *  6. A FAIXA ÓRFÃ QUE PAGAVA EM SILÊNCIO. `faixaPara` juntava a faixa só pelo
 *     grupo. Uma linha com `company_id` da vizinha e `group_id` daqui — o que
 *     o defeito de `setTier` gravava — não aparece em `listTiers`, não sai
 *     pelo DELETE da dona do grupo, e ENTRAVA na apuração: 50% onde a tela
 *     promete 1%.
 *
 *  7. O BECO DE QUEM SAIU DA OPERAÇÃO. A conferência de vínculo do item 4
 *     nasceu na frente de segurança ANTES do ramo do `groupId: null`, que é o
 *     DELETE — e o desligamento não apagava a linha de comissão. Resultado:
 *     quem saía ficava com um vínculo de comissão que rota nenhuma removia, e
 *     a readmissão o ressuscitava comissionando.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { registrarComissaoDaVenda } from '../src/services/core/CommissionService.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Comissao@Fronteira2026';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, false);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

let empresaA: string;
let empresaB: string;
let gerenteA: Ator;
let gerenteB: Ator;
/** O grupo de comissão da B — o alvo. */
let grupoB: string;

/** Quantas faixas existem no grupo, olhando o banco direto (sem filtro de empresa). */
function faixasDoGrupo(groupId: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_commission_tiers WHERE group_id = ?')
      .get(groupId) as { n: number }
  ).n;
}

beforeEach(async () => {
  resetDbForTests();
  empresaA = upsertCompany({
    slug: 'comissao-a',
    legalName: 'Comissão A Ltda',
    tradeName: 'Comissão A',
    kind: 'retail',
  });
  empresaB = upsertCompany({
    slug: 'comissao-b',
    legalName: 'Comissão B Ltda',
    tradeName: 'Comissão B',
    kind: 'retail',
  });
  gerenteA = await ator('GER.COM.A', empresaA, 'gerente_loja');
  gerenteB = await ator('GER.COM.B', empresaB, 'gerente_loja');

  const criado = await request(app)
    .post('/api/v1/core/commissions/groups')
    .set(gerenteB.auth)
    .send({ name: 'Vendedores da B' });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  grupoB = String(criado.body.group.id);

  // A B já tem uma faixa em 0 — é ela que arma o oráculo do UNIQUE.
  const faixa = await request(app)
    .put(`/api/v1/core/commissions/groups/${grupoB}/tiers`)
    .set(gerenteB.auth)
    .send({ minCents: 0, rateBps: 300 });
  expect(faixa.status, JSON.stringify(faixa.body)).toBe(200);
});

describe('a faixa não entra no grupo da vizinha', () => {
  it('PUT de faixa no grupo da B com token da A é 404 — e nenhuma linha nova no grupo dela', async () => {
    const antes = faixasDoGrupo(grupoB);

    const res = await request(app)
      .put(`/api/v1/core/commissions/groups/${grupoB}/tiers`)
      .set(gerenteA.auth)
      .send({ minCents: 50_000, rateBps: 9_900 });

    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('CORE_COMMISSION_GROUP_NOT_FOUND');
    expect(faixasDoGrupo(grupoB)).toBe(antes);
  });

  it('o UNIQUE do grupo não vira oráculo: o valor que a B já usa responde igual ao livre', async () => {
    const ocupado = await request(app)
      .put(`/api/v1/core/commissions/groups/${grupoB}/tiers`)
      .set(gerenteA.auth)
      .send({ minCents: 0, rateBps: 100 });
    const livre = await request(app)
      .put(`/api/v1/core/commissions/groups/${grupoB}/tiers`)
      .set(gerenteA.auth)
      .send({ minCents: 777_777, rateBps: 100 });

    expect(ocupado.status).toBe(404);
    expect(livre.status).toBe(404);
    expect(ocupado.body?.error?.code).toBe(livre.body?.error?.code);
    expect(faixasDoGrupo(grupoB)).toBe(1);
  });

  it('grupo que não existe em empresa nenhuma é 404 do domínio, nunca 500 de chave estrangeira', async () => {
    const res = await request(app)
      .put('/api/v1/core/commissions/groups/grupo-que-nao-existe/tiers')
      .set(gerenteA.auth)
      .send({ minCents: 0, rateBps: 100 });

    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('CORE_COMMISSION_GROUP_NOT_FOUND');
  });
});

describe('o vendedor comissionado sai do vínculo, não do id digitado', () => {
  it('a pessoa da B não entra na apuração da A — 404, e nenhuma linha de membro', async () => {
    const grupoA = await request(app)
      .post('/api/v1/core/commissions/groups')
      .set(gerenteA.auth)
      .send({ name: 'Vendedores da A' });
    expect(grupoA.status).toBe(201);

    const res = await request(app)
      .put(`/api/v1/core/commissions/members/${gerenteB.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: grupoA.body.group.id });

    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('CORE_COMMISSION_MEMBER_NOT_FOUND');
    const linhas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_commission_members WHERE user_id = ?')
      .get(gerenteB.userId) as { n: number };
    expect(linhas.n).toBe(0);
  });
});

describe('e dentro da própria empresa tudo continua passando', () => {
  it('a A grava faixa no PRÓPRIO grupo e comissiona a PRÓPRIA equipe', async () => {
    const grupoA = await request(app)
      .post('/api/v1/core/commissions/groups')
      .set(gerenteA.auth)
      .send({ name: 'Vendedores da A' });
    expect(grupoA.status).toBe(201);
    const idA = String(grupoA.body.group.id);

    const faixa = await request(app)
      .put(`/api/v1/core/commissions/groups/${idA}/tiers`)
      .set(gerenteA.auth)
      .send({ minCents: 0, rateBps: 250 });
    expect(faixa.status, JSON.stringify(faixa.body)).toBe(200);
    expect(faixa.body.tier.group_id).toBe(idA);
    expect(faixa.body.tier.company_id).toBe(empresaA);

    const membro = await request(app)
      .put(`/api/v1/core/commissions/members/${gerenteA.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: idA });
    expect(membro.status, JSON.stringify(membro.body)).toBe(200);

    // E a faixa regravada no mesmo mínimo continua ATUALIZANDO, não duplicando.
    const regravada = await request(app)
      .put(`/api/v1/core/commissions/groups/${idA}/tiers`)
      .set(gerenteA.auth)
      .send({ minCents: 0, rateBps: 400 });
    expect(regravada.status).toBe(200);
    expect(regravada.body.tier.rate_bps).toBe(400);
    expect(faixasDoGrupo(idA)).toBe(1);

    // Tirar o vendedor do grupo (groupId nulo) também segue funcionando.
    const semGrupo = await request(app)
      .put(`/api/v1/core/commissions/members/${gerenteA.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: null });
    expect(semGrupo.status).toBe(200);
  });
});

// ============================================================================
// A FAIXA ÓRFÃ NÃO PAGA — nem some do relatório e continua pagando
// ============================================================================

/** Cria o grupo da A com uma faixa de 1% a partir de zero, e devolve o id. */
async function grupoDeUmPorCentoNaA(): Promise<string> {
  const criado = await request(app)
    .post('/api/v1/core/commissions/groups')
    .set(gerenteA.auth)
    .send({ name: 'Vendedores da A' });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  const id = String(criado.body.group.id);

  const faixa = await request(app)
    .put(`/api/v1/core/commissions/groups/${id}/tiers`)
    .set(gerenteA.auth)
    .send({ minCents: 0, rateBps: 100 });
  expect(faixa.status, JSON.stringify(faixa.body)).toBe(200);
  return id;
}

/**
 * A linha que o defeito antigo de `setTier` gravava: `company_id` da VIZINHA,
 * `group_id` do grupo daqui. Escrita à mão de propósito — a rota não a grava
 * mais, e é justamente o resíduo de um banco anterior ao conserto que se quer
 * neutralizar.
 */
function faixaOrfaNoGrupo(groupId: string, companyIdDaVizinha: string, minCents: number, rateBps: number): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_commission_tiers (id, company_id, group_id, min_cents, rate_bps, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyIdDaVizinha, groupId, minCents, rateBps, new Date().toISOString());
  return id;
}

/**
 * Uma venda da A no banco — o mínimo que a chave estrangeira de
 * `core_commission_entries.sale_id` exige. A apuração é o que este caso mede;
 * o caminho do PDV até a venda tem suíte própria.
 */
function vendaDaA(sellerId: string, totalCents: number): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_sales (id, company_id, number, seller_id, status, subtotal_cents,
                               total_cents, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
    )
    .run(id, empresaA, 1, sellerId, totalCents, totalCents, `idem-${id}`, new Date().toISOString());
  return id;
}

describe('a faixa com a empresa da vizinha não entra na apuração daqui', () => {
  it('a venda paga a faixa da PRÓPRIA empresa (1%), não os 50% da linha órfã', async () => {
    const grupoA = await grupoDeUmPorCentoNaA();
    faixaOrfaNoGrupo(grupoA, empresaB, 1_000, 5_000);

    const membro = await request(app)
      .put(`/api/v1/core/commissions/members/${gerenteA.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: grupoA });
    expect(membro.status, JSON.stringify(membro.body)).toBe(200);

    // R$ 20,00 de base: a faixa da A paga 20 centavos; a órfã pagaria 1000.
    const saleId = vendaDaA(gerenteA.userId, 2_000);
    registrarComissaoDaVenda({
      companyId: empresaA,
      saleId,
      sellerId: gerenteA.userId,
      baseCents: 2_000,
    });

    const linha = getConnection()
      .prepare('SELECT amount_cents, rate_bps FROM core_commission_entries WHERE sale_id = ?')
      .get(saleId) as { amount_cents: number; rate_bps: number } | undefined;

    expect(linha, 'a venda tinha de gerar comissão pela faixa da própria empresa').toBeTruthy();
    expect(linha!.rate_bps).toBe(100);
    expect(linha!.amount_cents).toBe(20);
  });

  it('e remover a faixa órfã pela empresa errada não diz "removida": 404, e a linha continua', async () => {
    const grupoA = await grupoDeUmPorCentoNaA();
    const orfa = faixaOrfaNoGrupo(grupoA, empresaB, 1_000, 5_000);

    const res = await request(app)
      .delete(`/api/v1/core/commissions/tiers/${orfa}`)
      .set(gerenteA.auth);

    // O DELETE é escopado por empresa e não apagou nada: sucesso falso era a
    // tela dizer "Faixa removida." sobre uma linha que continuou lá.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body?.error?.code).toBe('CORE_COMMISSION_TIER_NOT_FOUND');
    const ainda = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_commission_tiers WHERE id = ?')
      .get(orfa) as { n: number };
    expect(ainda.n).toBe(1);
  });

  it('a faixa da própria empresa continua saindo pelo DELETE', async () => {
    const grupoA = await grupoDeUmPorCentoNaA();
    const minha = (
      getConnection()
        .prepare('SELECT id FROM core_commission_tiers WHERE group_id = ? AND company_id = ?')
        .get(grupoA, empresaA) as { id: string }
    ).id;

    const res = await request(app)
      .delete(`/api/v1/core/commissions/tiers/${minha}`)
      .set(gerenteA.auth);

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(faixasDoGrupo(grupoA)).toBe(0);
  });
});

// ============================================================================
// QUEM SAIU DA OPERAÇÃO NÃO FICA COM VÍNCULO DE COMISSÃO PRESO
// ============================================================================

/** Uma vendedora da A que também tem vínculo na B — senão o desligamento é recusado. */
async function vendedoraDasDuas(): Promise<Ator> {
  const a = await ator('VEND.COM.A', empresaA, 'atendente');
  linkUserToCompany(a.userId, empresaB, 'atendente', false);
  return a;
}

function vinculosDeComissao(userId: string, companyId: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_commission_members WHERE user_id = ? AND company_id = ?')
      .get(userId, companyId) as { n: number }
  ).n;
}

describe('o desligamento leva o vínculo de comissão junto', () => {
  it('sair da operação apaga a linha — e a readmissão não volta comissionando sozinha', async () => {
    const grupoA = await grupoDeUmPorCentoNaA();
    const vendedora = await vendedoraDasDuas();

    const membro = await request(app)
      .put(`/api/v1/core/commissions/members/${vendedora.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: grupoA });
    expect(membro.status, JSON.stringify(membro.body)).toBe(200);
    expect(vinculosDeComissao(vendedora.userId, empresaA)).toBe(1);

    const saiu = await request(app)
      .post(`/api/v1/core/team/${vendedora.userId}/remove-from-company`)
      .set(gerenteA.auth)
      .send({});
    expect(saiu.status, JSON.stringify(saiu.body)).toBe(200);
    expect(vinculosDeComissao(vendedora.userId, empresaA)).toBe(0);

    // Readmitida, ela volta SEM grupo: comissionar de novo é decisão de alguém.
    const devolta = await request(app)
      .post('/api/v1/core/team/link')
      .set(gerenteA.auth)
      .send({ login: 'VEND.COM.A', profileCode: 'atendente' });
    expect(devolta.status, JSON.stringify(devolta.body)).toBe(201);
    expect(vinculosDeComissao(vendedora.userId, empresaA)).toBe(0);
  });

  it('a linha que já ficou órfã em base antiga ainda sai pelo PUT com groupId nulo', async () => {
    const grupoA = await grupoDeUmPorCentoNaA();
    const vendedora = await vendedoraDasDuas();

    const saiu = await request(app)
      .post(`/api/v1/core/team/${vendedora.userId}/remove-from-company`)
      .set(gerenteA.auth)
      .send({});
    expect(saiu.status, JSON.stringify(saiu.body)).toBe(200);

    /*
      O estado que qualquer banco anterior ao conserto tem: a pessoa já saiu da
      operação e a linha de comissão ficou. Escrita à mão porque a rota não a
      cria mais nesse estado — e é exatamente ela que precisava voltar a sair.
    */
    getConnection()
      .prepare(
        `INSERT INTO core_commission_members (company_id, user_id, group_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(empresaA, vendedora.userId, grupoA, new Date().toISOString());
    expect(vinculosDeComissao(vendedora.userId, empresaA)).toBe(1);

    const tirou = await request(app)
      .put(`/api/v1/core/commissions/members/${vendedora.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: null });

    // Antes: 404 CORE_COMMISSION_MEMBER_NOT_FOUND, e a linha ficava para sempre.
    expect(tirou.status, JSON.stringify(tirou.body)).toBe(200);
    expect(vinculosDeComissao(vendedora.userId, empresaA)).toBe(0);
  });

  it('e ATRIBUIR grupo a quem não é da operação continua sendo 404', async () => {
    const grupoA = await grupoDeUmPorCentoNaA();
    const vendedora = await vendedoraDasDuas();

    const saiu = await request(app)
      .post(`/api/v1/core/team/${vendedora.userId}/remove-from-company`)
      .set(gerenteA.auth)
      .send({});
    expect(saiu.status, JSON.stringify(saiu.body)).toBe(200);

    // Apagar nunca vaza nada; ATRIBUIR é o ato que faria gente de fora
    // aparecer na apuração daqui — e esse continua guardado.
    const res = await request(app)
      .put(`/api/v1/core/commissions/members/${vendedora.userId}`)
      .set(gerenteA.auth)
      .send({ groupId: grupoA });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body?.error?.code).toBe('CORE_COMMISSION_MEMBER_NOT_FOUND');
    expect(vinculosDeComissao(vendedora.userId, empresaA)).toBe(0);
  });
});
