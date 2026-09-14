/**
 * ============================================================================
 * A LIBERAÇÃO PONTUAL PRECISA DE ALGUÉM QUE A PERCORRA
 * ============================================================================
 *
 * ## O defeito, no tamanho exato
 *
 * `POST /core/sales/:id/cancel` e `POST /core/sale-returns` foram abertas para
 * `abertaAo(req, 'escritorio')` e passaram a chamar `comLiberacaoPontual`: o
 * estoquista e o atendente deixam de tomar um "não" seco e chamam um gestor ali
 * mesmo, com a senha dele, gasta uma vez, presa àquela venda.
 *
 * O recurso foi construído PARA ELES e não CHEGAVA a eles, por duas travas
 * que ninguém alinhou com as duas escritas:
 *
 *   1. a única tela que chama as duas rotas — `/sistema/vendas/devolucoes` —
 *      declarava `QUEM_DESFAZ_VENDA`, lista sem estoquista e sem atendente. O
 *      `Protected` os devolvia para casa ANTES da tela montar;
 *   2. e ainda que entrassem, `GET /core/sale-returns` — que a tela carrega ao
 *      montar — os recusava com 403, junto de `GET /sales/:id/returnable`, que
 *      é como a tela descobre o que ainda pode voltar.
 *
 * Efeito medido: o ramo `CORE_RETURN_NEEDS_AUTHORIZATION` da `DevolucoesPage`
 * não tinha NENHUM usuário alcançável na aplicação entregue. Os quatro perfis
 * que abriam a tela (os dois donos e os dois gerentes) devolvem DIRETO e nunca
 * veem o ramo; os dois para quem ele foi escrito não chegavam à tela. Um
 * caminho morto com cara de vivo.
 *
 * ## Por que nenhum teste pegava
 *
 * Os de tela montam `<DevolucoesPage/>` direto no `MemoryRouter`, SEM passar
 * pelo `Protected` — a tela abre para qualquer perfil dublado, e a porta
 * fechada fica invisível. Os de servidor exercitavam a ESCRITA com o token do
 * estoquista, mas liam o item devolvível com o token do GERENTE (ver
 * `liberacao-pontual.test.ts`, `itemDevolvivel`), então a leitura fechada
 * nunca era tocada.
 *
 * Este arquivo percorre o caminho INTEIRO com um token só, o de quem o recurso
 * atende: monta a tela (as duas chamadas do mount), escolhe a venda, toma o
 * 403 nomeado, pede a liberação e conclui. O lado do navegador está em
 * `src/pages/gs/__tests__/audit-portas.test.tsx`, que agora passa pelo
 * `Protected` REAL nesta tela.
 *
 * ## Como este guarda falha (quebrando de propósito)
 *
 *   - troque `abertaAo(req, 'balcao', 'escritorio')` de volta por
 *     `requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS)` em
 *     `GET /sale-returns` e o primeiro bloco fica vermelho com 403 em cima do
 *     mount da tela;
 *   - faça o mesmo em `GET /sales/:id/returnable` e o percurso completo quebra
 *     na escolha da venda, ANTES de chegar ao 403 nomeado;
 *   - tire `'estoquista'` de `ESCRITORIO` e os dois blocos caem juntos.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';

const LOJA = 'loja-do-caminho-vivo';
const app = createApp();

interface Sessao {
  auth: { Authorization: string };
  userId: string;
}

async function entrar(userId: string, perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

let gerente: Sessao;
let estoquista: Sessao;
let atendente: Sessao;

/** O login do gestor, como o diálogo do balcão o digita. */
const LOGIN_GERENTE = `gerente-caminho@${LOJA}`;

async function produtoComSaldo(nome: string, precoCents: number, qtd: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: nome, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await request(app)
    .post('/api/v1/core/stock/movements')
    .set(gerente.auth)
    .send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id as string}`,
    });
  return String(p.body.id);
}

async function vender(productId: string, totalCents: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(gerente.auth)
    .send({
      idempotencyKey: randomUUID(),
      items: [{ productId, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: totalCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String((res.body.sale ?? res.body).id);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-caminho', 'gerente_loja');
  estoquista = await entrar('estoque-caminho', 'estoquista');
  atendente = await entrar('atende-caminho', 'atendente');
});

// ===========================================================================

describe('a tela de devoluções MONTA para quem a liberação pontual atende', () => {
  /*
    As DUAS chamadas do mount da `DevolucoesPage` (`carregar()`): a lista de
    devoluções e a lista de vendas. Uma delas negando já deixa a tela sendo uma
    casca — e era exatamente o que acontecia com a primeira.
  */
  for (const quem of ['estoquista', 'atendente'] as const) {
    it(`${quem} lê a lista de devoluções e a de vendas — o mount inteiro`, async () => {
      const sessao = quem === 'estoquista' ? estoquista : atendente;
      const devolucoes = await request(app).get('/api/v1/core/sale-returns').set(sessao.auth);
      expect(devolucoes.status, JSON.stringify(devolucoes.body)).toBe(200);
      expect(Array.isArray(devolucoes.body.items)).toBe(true);

      const vendas = await request(app).get('/api/v1/core/sales').set(sessao.auth);
      expect(vendas.status, JSON.stringify(vendas.body)).toBe(200);
    });
  }

  it('e o que AINDA PODE VOLTAR também abre — é como a tela escolhe os itens', async () => {
    const p = await produtoComSaldo('Tênis de corrida', 40_000, 5);
    const saleId = await vender(p, 40_000);

    const res = await request(app)
      .get(`/api/v1/core/sales/${saleId}/returnable`)
      .set(estoquista.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('a BANCADA continua de fora — abrir para o escritório não abriu para todos', async () => {
    /*
      O recorte é o do prédio: o mecânico não lê o faturamento da loja, e o
      contador não mora em ambiente nenhum daqui. Sem este caso, "alinhar as
      pontas" poderia ter virado "abrir a rota", que é o conserto errado.
    */
    for (const perfil of ['mecanico', 'contador']) {
      const fora = await entrar(`fora-${perfil}`, perfil);
      const res = await request(app).get('/api/v1/core/sale-returns').set(fora.auth);
      expect(res.status, `${perfil}: ${JSON.stringify(res.body)}`).toBe(403);
    }
  });
});

describe('o percurso INTEIRO com um token só — o do estoquista', () => {
  it('monta, escolhe, toma o 403 nomeado, pede a liberação e devolve', async () => {
    const p = await produtoComSaldo('Bota de trilha', 30_000, 5);
    const saleId = await vender(p, 30_000);

    // 1. o mount da tela, com o token DELE — não com o do gerente.
    expect((await request(app).get('/api/v1/core/sale-returns').set(estoquista.auth)).status)
      .toBe(200);
    expect((await request(app).get('/api/v1/core/sales').set(estoquista.auth)).status).toBe(200);

    // 2. escolher a venda: o que ainda pode voltar, lido por ele.
    const devolviveis = await request(app)
      .get(`/api/v1/core/sales/${saleId}/returnable`)
      .set(estoquista.auth);
    expect(devolviveis.status, JSON.stringify(devolviveis.body)).toBe(200);
    const saleItemId = String(devolviveis.body.items[0].sale_item_id);

    // 3. o 403 NOMEADO — é ele que faz o diálogo do gestor abrir na tela.
    const semLiberacao = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(estoquista.auth)
      .send({
        saleId,
        reason: 'apertou',
        refundMethod: 'pix',
        items: [{ saleItemId, quantity: 1 }],
      });
    expect(semLiberacao.status).toBe(403);
    expect(semLiberacao.body.error.code).toBe('CORE_RETURN_NEEDS_AUTHORIZATION');

    // 4. a liberação, pedida pela sessão DELE com a credencial do gestor.
    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set(estoquista.auth)
      .send({
        login: LOGIN_GERENTE,
        password: TEST_PASSWORD,
        action: 'devolver_venda',
        referenceId: saleId,
        reason: 'cliente voltou com a bota',
      });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    // 5. e a devolução acontece, com os DOIS nomes na trilha.
    const registrada = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(estoquista.auth)
      .send({
        saleId,
        reason: 'apertou',
        refundMethod: 'pix',
        items: [{ saleItemId, quantity: 1 }],
        authorizationId: lib.body.id,
      });
    expect(registrada.status, JSON.stringify(registrada.body)).toBe(201);

    const trilha = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'sale_returns.created'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(LOJA) as { detail: string } | undefined;
    expect(trilha, 'a devolução não deixou rastro').toBeDefined();
    const detalhe = JSON.parse(trilha!.detail) as Record<string, unknown>;
    expect(detalhe.requestingUserId).toBe(estoquista.userId);
    expect(detalhe.authorizingUserId).toBe(gerente.userId);

    // 6. e a devolução aparece na lista que ELE lê — o ciclo fecha na tela.
    const depois = await request(app).get('/api/v1/core/sale-returns').set(estoquista.auth);
    expect(depois.status).toBe(200);
    expect((depois.body.items as unknown[]).length).toBe(1);

    // 7. o detalhe também, que é o que a tela abre ao clicar na linha.
    const umSo = await request(app)
      .get(`/api/v1/core/sale-returns/${registrada.body.id as string}`)
      .set(estoquista.auth);
    expect(umSo.status, JSON.stringify(umSo.body)).toBe(200);
  });

  it('o mesmo percurso CANCELANDO — o atendente, que também não tinha porta', async () => {
    const p = await produtoComSaldo('Mochila', 15_000, 5);
    const saleId = await vender(p, 15_000);

    const semLiberacao = await request(app)
      .post(`/api/v1/core/sales/${saleId}/cancel`)
      .set(atendente.auth)
      .send({ reason: 'engano do balcão' });
    expect(semLiberacao.status).toBe(403);
    expect(semLiberacao.body.error.code).toBe('CORE_CANCEL_NEEDS_AUTHORIZATION');

    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set(atendente.auth)
      .send({
        login: LOGIN_GERENTE,
        password: TEST_PASSWORD,
        action: 'cancelar_venda',
        referenceId: saleId,
      });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const cancelada = await request(app)
      .post(`/api/v1/core/sales/${saleId}/cancel`)
      .set(atendente.auth)
      .send({ reason: 'engano do balcão', authorizationId: lib.body.id });
    expect(cancelada.status, JSON.stringify(cancelada.body)).toBe(200);

    const status = (
      getConnection().prepare('SELECT status FROM core_sales WHERE id = ?').get(saleId) as {
        status: string;
      }
    ).status;
    expect(status).toBe('cancelled');
  });
});
