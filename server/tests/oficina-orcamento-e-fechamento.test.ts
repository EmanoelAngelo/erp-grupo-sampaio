/**
 * ORÇAMENTO COM APROVAÇÃO DO CLIENTE + ANO DA MOTO — rodada 43.
 *
 * A auditoria mediu: `approved_at` era coluna MORTA desde a DDL — zero
 * leitores, zero escritores. O mecânico orçava, ligava para o cliente, e o
 * "aprovou" morria numa conversa sem registro. E o ano de fabricação, pedido
 * pelo dono desde o início, não existia em coluna nenhuma.
 *
 * O desenho de dois tempos:
 *   - a OFICINA pede (`approval_requested_at`, nova na migração 61);
 *   - o CLIENTE decide no portal dele (`approved_at` finalmente ganha
 *     escritor; recusa limpa o pedido e fica registrada como fala do
 *     proprietário na linha do tempo da OS).
 *
 * O que este arquivo trava, acima de tudo: CONHECER O ID DE UMA OS NÃO DÁ O
 * DIREITO DE APROVAR O ORÇAMENTO DELA. A decisão é de quem é dono do
 * cadastro amarrado à ordem — a mesma régua do resto do portal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { migrateCoreSchema } from '../src/db/core-migrations.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let oficina: { Authorization: string };
let companyId: string;
let workshopId: string;
let n = 0;

const P = (token: string) => ({ 'x-portal-token': token });

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const res = await loginForTest(app, {
    userId: 'ger-43',
    companyId: 'empresa-43',
    profileCodes: ['gerente_oficina'],
  });
  oficina = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  workshopId = 'wk-43';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-43', 'Oficina 43', 'mobility', 1, ?)`,
    )
    .run(workshopId, companyId, new Date().toISOString());
});

/** Cliente com e-mail E documento no cadastro: é a co-prova que abre o portal. */
async function clienteComConta(): Promise<{ customerId: string; token: string }> {
  n += 1;
  const documento = `1114447773${n}`;
  const email = `dono${n}@exemplo.com`;
  const agora = new Date().toISOString();
  const customerId = `cli-43-${n}`;
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(customerId, companyId, `Dono ${n}`, documento, email, agora, agora);
  const r = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: documento, password: 'Portal@2026' });
  expect(r.status).toBe(201);
  // Rodada 50: a co-prova espera o código — prova a caixa na hora, como o
  // dono dela faria (a espera em si mora em cadastro-por-email.test.ts).
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy(); confirmarEmail({ accountId: r.body.account.id as string, codigo });
  return { customerId, token: r.body.token as string };
}

async function equipamentoDe(customerId: string, extra: Record<string, unknown> = {}) {
  const r = await request(app).post('/api/v1/core/equipment').set(oficina).send({
    workshopId,
    brand: 'Shineray',
    model: 'PT2',
    origin: 'EXTERNAL_CUSTOMER',
    ownerCustomerId: customerId,
    ...extra,
  });
  return r;
}

async function osDe(customerId: string, equipmentId: string): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(oficina)
    .send({ workshopId, customerId, equipmentId, customerName: 'Dono', complaint: 'Nao liga' });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function comOrcamento(customerId: string, equipmentId: string): Promise<string> {
  const osId = await osDe(customerId, equipmentId);
  const labor = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/labor`)
    .set(oficina)
    .send({ workshopId, laborCents: 15000 });
  expect(labor.status).toBeLessThan(300);
  return osId;
}

function linhaDaOS(osId: string) {
  return getConnection()
    .prepare(
      'SELECT approval_requested_at, approved_at, status FROM core_service_orders WHERE id = ?',
    )
    .get(osId) as {
    approval_requested_at: string | null;
    approved_at: string | null;
    status: string;
  };
}

describe('ano de fabricação no cadastro da moto', () => {
  it('o cadastro aceita o ano, e a listagem o devolve', async () => {
    const { customerId } = await clienteComConta();
    const r = await equipamentoDe(customerId, { year: 2024 });
    expect(r.status).toBe(201);
    expect(r.body.year).toBe(2024);

    const lista = await request(app)
      .get('/api/v1/core/equipment')
      .set(oficina)
      .query({ workshopId });
    expect(lista.status).toBe(200);
    expect(lista.body.items[0].year).toBe(2024);
  });

  it('ano absurdo é recusado — plaquinha não viaja no tempo', async () => {
    const { customerId } = await clienteComConta();
    expect((await equipamentoDe(customerId, { year: 1800 })).status).toBe(400);
    expect(
      (await equipamentoDe(customerId, { year: new Date().getFullYear() + 3 })).status,
    ).toBe(400);
  });
});

describe('o pedido de aprovação — lado da oficina', () => {
  it('OS sem valor não pede aprovação: não há o que aprovar', async () => {
    const { customerId } = await clienteComConta();
    const eq = (await equipamentoDe(customerId)).body.id as string;
    const osId = await osDe(customerId, eq);
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(oficina)
      .send({ workshopId });
    expect(r.status).toBe(409);
  });

  it('com valor, o pedido registra o momento e o portal do dono passa a mostrar', async () => {
    const { customerId, token } = await clienteComConta();
    const eq = (await equipamentoDe(customerId)).body.id as string;
    const osId = await comOrcamento(customerId, eq);

    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(oficina)
      .send({ workshopId });
    expect(r.status).toBe(200);
    expect(linhaDaOS(osId).approval_requested_at).toBeTruthy();

    const ficha = await request(app)
      .get(`/api/v1/loja/portal/equipamentos/${eq}`)
      .set(P(token));
    expect(ficha.status).toBe(200);
    const ordem = ficha.body.ordens[0];
    expect(ordem.id).toBe(osId);
    expect(ordem.approvalRequestedAt).toBeTruthy();
    expect(ordem.approvedAt).toBeNull();
  });

  it('perfil de loja não pede aprovação de OS', async () => {
    const { customerId } = await clienteComConta();
    const eq = (await equipamentoDe(customerId)).body.id as string;
    const osId = await comOrcamento(customerId, eq);
    const loja = await loginForTest(app, {
      userId: 'ger-loja-43',
      companyId: 'empresa-43',
      profileCodes: ['gerente_loja'],
    });
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set({ Authorization: `Bearer ${loja.body.accessToken}` })
      .send({ workshopId });
    expect(r.status).toBe(403);
  });
});

describe('a decisão — lado do dono, no portal', () => {
  async function osPedida(): Promise<{
    osId: string;
    eq: string;
    token: string;
    customerId: string;
  }> {
    const { customerId, token } = await clienteComConta();
    const eq = (await equipamentoDe(customerId)).body.id as string;
    const osId = await comOrcamento(customerId, eq);
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(oficina)
      .send({ workshopId });
    expect(r.status).toBe(200);
    return { osId, eq, token, customerId };
  }

  it('aprovar grava approved_at — a coluna morta ganha escritor — e fala como proprietário', async () => {
    const { osId, token } = await osPedida();
    const r = await request(app).post(`/api/v1/loja/portal/ordens/${osId}/aprovar`).set(P(token));
    expect(r.status).toBe(200);

    const linha = linhaDaOS(osId);
    expect(linha.approved_at).toBeTruthy();
    expect(linha.approval_requested_at).toBeTruthy();

    const fala = getConnection()
      .prepare(
        `SELECT author_kind, body FROM core_service_order_comments
          WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(osId) as { author_kind: string; body: string };
    expect(fala.author_kind).toBe('proprietario');
    expect(fala.body).toMatch(/aprov/i);
  });

  it('recusar limpa o pedido e a recusa fica na linha do tempo', async () => {
    const { osId, token } = await osPedida();
    const r = await request(app).post(`/api/v1/loja/portal/ordens/${osId}/recusar`).set(P(token));
    expect(r.status).toBe(200);

    const linha = linhaDaOS(osId);
    expect(linha.approval_requested_at).toBeNull();
    expect(linha.approved_at).toBeNull();

    const fala = getConnection()
      .prepare(
        `SELECT author_kind, body FROM core_service_order_comments
          WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(osId) as { author_kind: string; body: string };
    expect(fala.author_kind).toBe('proprietario');
    expect(fala.body).toMatch(/recus/i);
  });

  it('OUTRO cliente não decide orçamento alheio — nem descobre que a OS existe', async () => {
    const { osId } = await osPedida();
    const intruso = await clienteComConta();
    const r = await request(app)
      .post(`/api/v1/loja/portal/ordens/${osId}/aprovar`)
      .set(P(intruso.token));
    expect(r.status).toBe(404);
    expect(linhaDaOS(osId).approved_at).toBeNull();
  });

  it('sem pedido pendente não há o que decidir', async () => {
    const { customerId, token } = await clienteComConta();
    const eq = (await equipamentoDe(customerId)).body.id as string;
    const osId = await comOrcamento(customerId, eq);
    const r = await request(app).post(`/api/v1/loja/portal/ordens/${osId}/aprovar`).set(P(token));
    expect(r.status).toBe(409);
  });

  it('aprovado uma vez, recusar depois não vale — o serviço pode já ter começado', async () => {
    const { osId, token } = await osPedida();
    await request(app).post(`/api/v1/loja/portal/ordens/${osId}/aprovar`).set(P(token));
    const r = await request(app).post(`/api/v1/loja/portal/ordens/${osId}/recusar`).set(P(token));
    expect(r.status).toBe(409);
    expect(linhaDaOS(osId).approved_at).toBeTruthy();
  });

  it('novo pedido de aprovação APAGA a aprovação antiga — orçamento mudou, decisão recomeça', async () => {
    const { osId, token } = await osPedida();
    await request(app).post(`/api/v1/loja/portal/ordens/${osId}/aprovar`).set(P(token));
    expect(linhaDaOS(osId).approved_at).toBeTruthy();

    // A oficina mexeu no orçamento e pediu de novo: o "sim" antigo não vale
    // para o valor novo.
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(oficina)
      .send({ workshopId });
    expect(r.status).toBe(200);
    const linha = linhaDaOS(osId);
    expect(linha.approved_at).toBeNull();
    expect(linha.approval_requested_at).toBeTruthy();
  });
});

describe('migração 62: o resquício do significado antigo', () => {
  /*
    Descoberto NA TELA, contra o banco real: a OS #1 apareceu com o selo
    "orçamento aprovado pelo cliente" sem cliente algum ter aprovado. Um fluxo
    removido em 12/08 gravava `approved_at` como "aprovada para execução".
    A rodada 43 mudou o significado da coluna, e valor gravado pelo
    significado antigo tem de ser limpo — senão o selo nasce mentindo.
  */
  it('limpa approved_at herdado do fluxo antigo', async () => {
    const { customerId } = await clienteComConta();
    const eq = (await equipamentoDe(customerId)).body.id as string;
    const osId = await osDe(customerId, eq);
    const db = getConnection();
    // O lixo do significado antigo, como está no banco em uso.
    db.prepare("UPDATE core_service_orders SET approved_at = '2026-08-12T02:16:17.172Z' WHERE id = ?").run(osId);
    // Reaplica só o passo 62, como num banco que ainda não o recebeu.
    db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_62'").run();
    migrateCoreSchema();
    expect(linhaDaOS(osId).approved_at).toBeNull();
  });
});
