/**
 * CRM no núcleo: lead e oportunidade.
 *
 * A regra que este arquivo protege: LEAD NÃO É CLIENTE.
 *
 * Guardar lead em `core_customers` com um sinalizador é a solução óbvia e sai
 * cara: o cadastro passaria a conter gente que nunca comprou, e todo número
 * calculado por cliente — quantos clientes a loja tem, ticket médio, recompra —
 * dividiria por uma base inflada. O erro não aparece como erro; aparece como um
 * ticket médio que caiu sem explicação.
 *
 * A segunda: quando o lead compra, ele vira cliente APONTANDO para o cadastro.
 * Se já existe alguém com aquele documento, liga ao que existe — senão a mesma
 * pessoa passa a ter dois cadastros e o histórico dela fica partido.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-crm',
    companyId: 'loja-crm',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function lead(over: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/core/leads')
    .set(auth)
    .send({ name: 'Maria Interessada', phone: '51999990000', source: 'instagram', ...over });
  expect(res.status).toBe(201);
  return res.body;
}

function contarClientes(): number {
  const row = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ?')
    .get(companyId) as { n: number };
  return row.n;
}

describe('lead não é cliente', () => {
  it('criar lead NÃO cria cliente', async () => {
    const antes = contarClientes();
    await lead();
    // Contar lead como cliente inflaria toda média por cliente.
    expect(contarClientes()).toBe(antes);
  });

  it('o lead nasce como novo', async () => {
    const l = await lead();
    expect(l.status).toBe('novo');
    expect(l.customer_id).toBeNull();
  });

  it('a mesma chave de idempotência devolve o mesmo lead', async () => {
    const chave = 'lead-balcao-1';
    const a = await request(app)
      .post('/api/v1/core/leads')
      .set({ ...auth, 'Idempotency-Key': chave })
      .send({ name: 'Duplo Clique' });
    const b = await request(app)
      .post('/api/v1/core/leads')
      .set({ ...auth, 'Idempotency-Key': chave })
      .send({ name: 'Duplo Clique' });
    // Clique duplo no balcão não pode virar dois contatos da mesma pessoa.
    expect(b.body.id).toBe(a.body.id);
  });

  it('lead sem nome é recusado', async () => {
    const res = await request(app).post('/api/v1/core/leads').set(auth).send({ name: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('conversão', () => {
  it('converter cria o cliente e liga os dois', async () => {
    const l = await lead({ document: '12345678901' });
    const res = await request(app).post(`/api/v1/core/leads/${l.id}/convert`).set(auth).send({});

    expect(res.status).toBe(200);
    expect(res.body.customerId).toBeTruthy();
    expect(res.body.lead.status).toBe('convertido');
    expect(res.body.lead.customer_id).toBe(res.body.customerId);
    expect(contarClientes()).toBe(1);
  });

  it('cliente que já existe é REAPROVEITADO, não duplicado', async () => {
    // O cadastro já tem esta pessoa, de uma compra anterior no balcão.
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .send({ name: 'João Antigo', document: '98765432100' });
    expect(cliente.status).toBe(201);

    const l = await lead({ name: 'João pelo Instagram', document: '987.654.321-00' });
    const res = await request(app).post(`/api/v1/core/leads/${l.id}/convert`).set(auth).send({});

    // Criar outro partiria o histórico de compras da mesma pessoa em dois.
    expect(res.body.reusedExisting).toBe(true);
    expect(res.body.customerId).toBe(cliente.body.id);
    expect(contarClientes()).toBe(1);
  });

  it('converter duas vezes não cria dois clientes', async () => {
    const l = await lead({ document: '11122233344' });
    const a = await request(app).post(`/api/v1/core/leads/${l.id}/convert`).set(auth).send({});
    const b = await request(app).post(`/api/v1/core/leads/${l.id}/convert`).set(auth).send({});
    expect(b.body.customerId).toBe(a.body.customerId);
    expect(contarClientes()).toBe(1);
  });

  it('não se marca "convertido" na mão', async () => {
    const l = await lead();
    const res = await request(app)
      .patch(`/api/v1/core/leads/${l.id}/status`)
      .set(auth)
      .send({ status: 'convertido' });
    // Deixar passar criaria lead convertido sem cliente nenhum do outro lado.
    expect(res.status).toBe(400);
  });
});

describe('situação do lead', () => {
  it('perder exige motivo', async () => {
    const l = await lead();
    const semMotivo = await request(app)
      .patch(`/api/v1/core/leads/${l.id}/status`)
      .set(auth)
      .send({ status: 'perdido' });
    expect(semMotivo.status).toBe(400);

    const comMotivo = await request(app)
      .patch(`/api/v1/core/leads/${l.id}/status`)
      .set(auth)
      .send({ status: 'perdido', lostReason: 'Comprou no concorrente' });
    expect(comMotivo.body.status).toBe('perdido');
    expect(comMotivo.body.lost_reason).toBe('Comprou no concorrente');
  });

  it('lead convertido não muda mais de situação', async () => {
    const l = await lead({ document: '55566677788' });
    await request(app).post(`/api/v1/core/leads/${l.id}/convert`).set(auth).send({});
    const res = await request(app)
      .patch(`/api/v1/core/leads/${l.id}/status`)
      .set(auth)
      .send({ status: 'em_contato' });
    expect(res.status).toBe(409);
  });
});

describe('oportunidade', () => {
  it('precisa de lead ou cliente — previsão sem dono não serve', async () => {
    const res = await request(app)
      .post('/api/v1/core/opportunities')
      .set(auth)
      .send({ title: 'Órfã', amountCents: 100000 });
    expect(res.status).toBe(400);
  });

  it('o valor é estimativa e NÃO entra no financeiro', async () => {
    const l = await lead();
    await request(app)
      .post('/api/v1/core/opportunities')
      .set(auth)
      .send({ leadId: l.id, title: 'Kit completo', amountCents: 500000 });

    // Somar previsão ao faturamento contaria como dinheiro o que é conversa.
    const lancamentos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_finance_entries WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(lancamentos.n).toBe(0);
  });

  it('converter o lead passa as oportunidades abertas para o cliente', async () => {
    const l = await lead({ document: '22233344455' });
    const o = await request(app)
      .post('/api/v1/core/opportunities')
      .set(auth)
      .send({ leadId: l.id, title: 'Negociação', amountCents: 250000 });

    const conv = await request(app).post(`/api/v1/core/leads/${l.id}/convert`).set(auth).send({});

    const depois = await request(app).get('/api/v1/core/opportunities').set(auth);
    const atual = depois.body.items.find((x: { id: string }) => x.id === o.body.id);
    // A negociação é a mesma; mudou o nome de quem está do outro lado.
    expect(atual.customer_id).toBe(conv.body.customerId);
  });

  it('perder exige motivo; ganhar pode apontar a venda', async () => {
    const l = await lead();
    const o1 = await request(app)
      .post('/api/v1/core/opportunities')
      .set(auth)
      .send({ leadId: l.id, title: 'Perdida', amountCents: 100 });

    const semMotivo = await request(app)
      .post(`/api/v1/core/opportunities/${o1.body.id}/close`)
      .set(auth)
      .send({ status: 'perdida' });
    expect(semMotivo.status).toBe(400);

    const comMotivo = await request(app)
      .post(`/api/v1/core/opportunities/${o1.body.id}/close`)
      .set(auth)
      .send({ status: 'perdida', lostReason: 'Preço' });
    expect(comMotivo.body.status).toBe('perdida');
  });

  it('oportunidade encerrada não encerra de novo', async () => {
    const l = await lead();
    const o = await request(app)
      .post('/api/v1/core/opportunities')
      .set(auth)
      .send({ leadId: l.id, title: 'Uma vez só', amountCents: 100 });
    await request(app)
      .post(`/api/v1/core/opportunities/${o.body.id}/close`)
      .set(auth)
      .send({ status: 'ganha' });
    const segunda = await request(app)
      .post(`/api/v1/core/opportunities/${o.body.id}/close`)
      .set(auth)
      .send({ status: 'perdida', lostReason: 'tarde demais' });
    expect(segunda.status).toBe(409);
  });
});

describe('resumo do funil', () => {
  it('separa o estimado do ganho', async () => {
    const l = await lead();
    await request(app)
      .post('/api/v1/core/opportunities')
      .set(auth)
      .send({ leadId: l.id, title: 'Em aberto', amountCents: 300000 });

    const res = await request(app).get('/api/v1/core/crm/summary').set(auth);
    expect(res.body.leads.novo).toBe(1);
    expect(res.body.opportunities.abertas).toBe(1);
    // Rotulado como estimado em todo lugar: não é receita.
    expect(res.body.opportunities.abertoEstimadoCents).toBe(300000);
    expect(res.body.opportunities.ganhas).toBe(0);
  });
});

describe('isolamento', () => {
  it('lead de outra operação não é visível', async () => {
    const l = await lead();
    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha-crm',
      companyId: 'loja-vizinha-crm',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .patch(`/api/v1/core/leads/${l.id}/status`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ status: 'em_contato' });
    expect(res.status).toBe(404);
  });
});
