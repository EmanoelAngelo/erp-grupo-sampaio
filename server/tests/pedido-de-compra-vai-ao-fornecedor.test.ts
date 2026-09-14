/**
 * ============================================================================
 * O PEDIDO DE COMPRA VAI AO FORNECEDOR — GAP-PRD-090
 * ============================================================================
 *
 * "Enviar ao fornecedor" só fazia `UPDATE status = 'enviado'`. Não havia
 * documento do pedido, nem e-mail, e o comprador transcrevia tudo no WhatsApp.
 *
 * Cada caso nasceu VERMELHO contra o HEAD anterior: as rotas
 * `/purchase-orders/:id/impressao` e `/purchase-orders/:id/email` respondiam
 * 404. As regras que este arquivo trava:
 *
 *   - o A4 traz comprador, fornecedor, itens, custos, total e previsão — e o
 *     rascunho sai com tarja, para não ir ao fornecedor um combinado que muda;
 *   - sem SMTP, o e-mail FICA NA FILA e a resposta diz READY_FOR_CREDENTIAL —
 *     nunca "enviado"; com SMTP, sai com o A4 anexado;
 *   - repetir o clique com a mensagem ainda pendente não enfileira a segunda
 *     cópia (o fornecedor separaria mercadoria em dobro);
 *   - fornecedor sem e-mail é recusa com o caminho, e o pedido não muda.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import {
  flushEmailQueue,
  type CarteiroSmtp,
  type MensagemSmtp,
} from '../src/services/notifications/EmailService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

const EMAIL_VARS = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
] as const;
const originais = new Map<string, string | undefined>(EMAIL_VARS.map((v) => [v, process.env[v]]));

function semCredencial(): void {
  // Vazio, e não ausente: o `.env` do dono não pode vencer o teste.
  for (const v of EMAIL_VARS) process.env[v] = '';
  process.env.EMAIL_ENABLED = 'false';
  resetEnvCacheForTests();
}

function comCredencial(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'compras@loja.com.br';
  process.env.EMAIL_SMTP_HOST = 'smtp.exemplo.com';
  process.env.EMAIL_SMTP_PORT = '465';
  process.env.EMAIL_SMTP_USER = 'compras@loja.com.br';
  process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste-que-nao-e-real';
  resetEnvCacheForTests();
}

interface Sessao {
  auth: { Authorization: string };
  companyId: string;
}

async function entrar(userId: string, perfil: string, empresa = 'loja-compras'): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, companyId: res.body.company.id };
}

let gerente: Sessao;

async function fornecedor(email: string | null = 'vendas@distribuidora.com.br'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(gerente.auth)
    .send({
      name: 'Distribuidora Alfa Ltda',
      tradeName: 'Distribuidora Alfa',
      email,
      contactName: 'Márcia',
      paymentTermDays: 28,
      deliveryDays: 5,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function produto(nome: string): Promise<string> {
  const res = await request(app).post('/api/v1/core/products').set(gerente.auth).send({ name: nome, priceCents: 990 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function pedido(supplierId: string, productId: string): Promise<{ id: string; number: number }> {
  const res = await request(app)
    .post('/api/v1/core/purchase-orders')
    .set(gerente.auth)
    .send({
      supplierId,
      notes: 'Entregar pela porta dos fundos',
      items: [
        { productId, quantity: 100, unitCostCents: 450 },
        { description: 'Fita adesiva <larga>', quantity: 2, unitCostCents: 1250 },
      ],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, number: Number(res.body.number) };
}

function fila(): { template: string; status: string; to_address: string; subject: string; body_text: string; anexo_nome: string | null; anexo_id: string | null }[] {
  return getConnection()
    .prepare(
      `SELECT template, status, to_address, subject, body_text, anexo_nome, anexo_id
         FROM core_email_queue ORDER BY created_at`,
    )
    .all() as never[];
}

beforeEach(async () => {
  resetDbForTests();
  semCredencial();
  gerente = await entrar('gerente-compras', 'gerente_loja');
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const original = originais.get(v);
    if (original === undefined) delete process.env[v];
    else process.env[v] = original;
  }
  resetEnvCacheForTests();
});

describe('GAP-PRD-090 — o pedido em papel', () => {
  it('o A4 traz comprador, fornecedor, itens, custos, total, previsão e prazo — com tarja de rascunho', async () => {
    const f = await fornecedor();
    const p = await pedido(f, await produto('Parafuso 6mm'));

    const res = await request(app).get(`/api/v1/core/purchase-orders/${p.id}/impressao`).set(gerente.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.numero).toBe(p.number);
    expect(res.body.status).toBe('rascunho');
    expect(res.body.emailDoFornecedor).toBe('vendas@distribuidora.com.br');

    const html = String(res.body.html);
    expect(html).toContain('Pedido de compra');
    expect(html).toContain(`Nº ${p.number}`);
    expect(html).toContain('loja-compras'); // o nome da operação que compra
    expect(html).toContain('Distribuidora Alfa Ltda');
    expect(html).toContain('Parafuso 6mm');
    // Texto do usuário é escapado — o papel não vira HTML de ninguém.
    expect(html).toContain('Fita adesiva &lt;larga&gt;');
    expect(html).not.toContain('<larga>');
    expect(html).toMatch(/R\$\s?450,00/); // 100 × 4,50
    expect(html).toMatch(/R\$\s?475,00/); // total do pedido
    expect(html).toContain('28 dia(s) após o recebimento');
    expect(html).toContain('Entregar pela porta dos fundos');
    expect(html).toContain('RASCUNHO');
    expect(html).toContain('não é documento fiscal');
  });

  it('depois de marcado como enviado, o papel sai sem a tarja', async () => {
    const p = await pedido(await fornecedor(), await produto('Parafuso'));
    expect((await request(app).post(`/api/v1/core/purchase-orders/${p.id}/send`).set(gerente.auth)).status).toBe(200);
    const res = await request(app).get(`/api/v1/core/purchase-orders/${p.id}/impressao`).set(gerente.auth);
    expect(res.body.status).toBe('enviado');
    expect(String(res.body.html)).not.toContain('RASCUNHO');
    expect(String(res.body.html)).toContain('Enviado ao fornecedor');
  });

  it('o estoquista imprime (alcance da ficha); o atendente não; a outra empresa não acha', async () => {
    const p = await pedido(await fornecedor(), await produto('Parafuso'));
    const estoquista = await entrar('estoq-compras', 'estoquista');
    const atendente = await entrar('atend-compras', 'atendente');
    const outra = await entrar('ger-outra', 'gerente_loja', 'outra-loja');
    expect((await request(app).get(`/api/v1/core/purchase-orders/${p.id}/impressao`).set(estoquista.auth)).status).toBe(200);
    expect((await request(app).get(`/api/v1/core/purchase-orders/${p.id}/impressao`).set(atendente.auth)).status).toBe(403);
    expect((await request(app).get(`/api/v1/core/purchase-orders/${p.id}/impressao`).set(outra.auth)).status).toBe(404);
  });
});

describe('GAP-PRD-090 — o pedido por e-mail, sem fingir entrega', () => {
  it('sem SMTP: a mensagem fica na fila com o A4 anexado, e a resposta diz que falta credencial', async () => {
    const p = await pedido(await fornecedor(), await produto('Parafuso 6mm'));

    const res = await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(gerente.auth).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      queued: true,
      toAddress: 'vendas@distribuidora.com.br',
      readiness: 'READY_FOR_CREDENTIAL',
    });
    // O rascunho que foi por e-mail É enviado: os itens travam.
    expect(res.body.order.status).toBe('enviado');

    const [msg] = fila();
    expect(msg).toMatchObject({
      template: 'pedido_compra',
      status: 'pending',
      to_address: 'vendas@distribuidora.com.br',
      anexo_nome: `pedido-compra-${p.number}.html`,
    });
    expect(msg.anexo_id).toBeTruthy();
    expect(msg.subject).toContain(`Pedido de compra nº ${p.number}`);
    expect(msg.body_text).toMatch(/1\. Parafuso 6mm \([^)]+\) — 100 × R\$\s?4,50 = R\$\s?450,00/);
    expect(msg.body_text).toMatch(/Total do pedido: R\$\s?475,00/);
    expect(msg.body_text).toContain('Olá, Márcia.');

    // A trilha registra o gesto e a prontidão honesta.
    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'purchase_orders.emailed'")
      .get() as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({ queued: true, readiness: 'READY_FOR_CREDENTIAL' });
  });

  it('clicar de novo com a mensagem ainda pendente não enfileira a segunda cópia', async () => {
    const p = await pedido(await fornecedor(), await produto('Parafuso'));
    await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(gerente.auth).send({});
    const segunda = await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(gerente.auth).send({});
    expect(segunda.status).toBe(200);
    expect(segunda.body.queued).toBe(false);
    expect(fila()).toHaveLength(1);
  });

  it('com SMTP, o carteiro entrega o texto E o A4 anexado', async () => {
    const p = await pedido(await fornecedor(), await produto('Parafuso 6mm'));
    await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(gerente.auth).send({});

    comCredencial();
    const enviados: MensagemSmtp[] = [];
    const carteiro: CarteiroSmtp = {
      enviar(msg) {
        enviados.push(msg);
        return Promise.resolve();
      },
    };
    const r = await flushEmailQueue({ carteiro });
    expect(r.sent).toBe(1);
    expect(enviados[0].to).toBe('vendas@distribuidora.com.br');
    expect(enviados[0].anexos?.[0].nome).toBe(`pedido-compra-${p.number}.html`);
    expect(enviados[0].anexos?.[0].conteudo.toString('utf8')).toContain('Parafuso 6mm');
    expect(fila()[0].status).toBe('sent');
  });

  it('fornecedor sem e-mail: recusa com o caminho, e o pedido continua rascunho', async () => {
    const p = await pedido(await fornecedor(null), await produto('Parafuso'));
    const res = await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(gerente.auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_SUPPLIER_EMAIL_REQUIRED');
    expect(res.body.error.message).toContain('Fornecedores');
    expect(fila()).toHaveLength(0);
    const ficha = await request(app).get(`/api/v1/core/purchase-orders/${p.id}`).set(gerente.auth);
    expect(ficha.body.status).toBe('rascunho');

    // Quem compra pode digitar o endereço que o vendedor pediu.
    const outro = await request(app)
      .post(`/api/v1/core/purchase-orders/${p.id}/email`)
      .set(gerente.auth)
      .send({ to: 'marcia.vendas@gmail.com' });
    expect(outro.status).toBe(200);
    expect(outro.body.toAddress).toBe('marcia.vendas@gmail.com');
  });

  it('pedido cancelado não vai ao fornecedor; estoquista não envia', async () => {
    const p = await pedido(await fornecedor(), await produto('Parafuso'));
    const estoquista = await entrar('estoq-envia', 'estoquista');
    expect((await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(estoquista.auth).send({})).status).toBe(403);

    await request(app).post(`/api/v1/core/purchase-orders/${p.id}/cancel`).set(gerente.auth).send({ reason: 'Desistimos' });
    const res = await request(app).post(`/api/v1/core/purchase-orders/${p.id}/email`).set(gerente.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PURCHASE_ORDER_CANCELLED');
    expect(fila()).toHaveLength(0);
  });
});
