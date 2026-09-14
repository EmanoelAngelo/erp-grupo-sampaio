/**
 * A MÁQUINA DE ESTADOS DO PEDIDO É DO SERVIDOR (GAP-PRD-121) — e o cancelamento
 * pelo ERP tem motivo e rastro (GAP-PRD-124).
 *
 * O DEFEITO: `advanceFulfillment` conferia se a etapa pedida EXISTIA, se o
 * pedido não estava parado e se a etapa era do caminho certo (retirada ×
 * entrega). Não conferia se ela era a PRÓXIMA. Resultado medido pela auditoria:
 * `pago → entregue` direto respondia 200, e `entregue → pago` também — o
 * pedido entregue voltava a "pago" e podia ser separado e expedido de novo.
 * A única proteção era a tela oferecer só o botão da próxima etapa; qualquer
 * automação ou chamada direta passava.
 *
 * O CONTRATO AGORA:
 *   - avançar aceita SÓ `proximaEtapa(status, método de envio)`;
 *   - repetir a etapa em que o pedido já está é inofensivo (duplo clique);
 *   - voltar uma etapa é AÇÃO PRÓPRIA (`/fulfillment/voltar`), de gerente,
 *     com motivo obrigatório, evento na linha do tempo e auditoria.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let gerente: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-estados',
    companyId: 'loja-estados',
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function perfil(userId: string, codigo: string) {
  const res = await loginForTest(app, {
    userId,
    companyId: 'loja-estados',
    profileCodes: [codigo],
  });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function pedido(shippingMethod: string, status = 'pago', empresa = companyId): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const numero =
    Number(
      (
        getConnection()
          .prepare('SELECT COALESCE(MAX(number), 0) AS n FROM core_orders WHERE company_id = ?')
          .get(empresa) as { n: number }
      ).n,
    ) + 1;
  getConnection()
    .prepare(
      `INSERT INTO core_orders
         (id, company_id, number, status, customer_name, customer_email, customer_document,
          items_cents, shipping_cents, total_cents, shipping_method, idempotency_key,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Cliente', 'cliente@teste.local', '11122233344',
               10000, 0, 10000, ?, ?, ?, ?)`,
    )
    .run(id, empresa, numero, status, shippingMethod, randomUUID(), agora, agora);
  return id;
}

function avancar(orderId: string, status: string, quem = gerente, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/core/orders/${orderId}/fulfillment`)
    .set(quem)
    .send({ status, ...extra });
}

/** Despachar sem etiqueta diz QUEM leva (GAP-PRD-119): Correios, com o código. */
const DESPACHO = { carrier: 'correios', trackingCode: 'AA123456789BR' } as const;

function voltar(orderId: string, reason: unknown, quem = gerente) {
  return request(app)
    .post(`/api/v1/core/orders/${orderId}/fulfillment/voltar`)
    .set(quem)
    .send({ reason });
}

function estadoDe(orderId: string): string {
  return String(
    (getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as {
      status: string;
    }).status,
  );
}

function eventos(orderId: string) {
  return getConnection()
    .prepare('SELECT status, note, user_id FROM core_order_events WHERE order_id = ? ORDER BY created_at, rowid')
    .all(orderId) as { status: string; note: string | null; user_id: string | null }[];
}

function auditoria(acao: string, orderId: string) {
  return getConnection()
    .prepare('SELECT detail FROM core_audit_log WHERE action = ? AND entity_id = ?')
    .all(acao, orderId) as { detail: string | null }[];
}

// ============================================================================

describe('avançar aceita só a próxima etapa (GAP-PRD-121)', () => {
  it('pago direto para entregue é recusado com 409 e o pedido fica onde estava', async () => {
    const id = pedido('sedex');
    const res = await avancar(id, 'entregue');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_INVALID_TRANSITION');
    // A recusa diz qual é a etapa certa — quem chamou sabe o que fazer.
    expect(res.body.error.details).toMatchObject({
      atual: 'pago',
      pedida: 'entregue',
      esperada: 'separacao',
    });
    expect(estadoDe(id)).toBe('pago');
    expect(eventos(id)).toHaveLength(0);
  });

  it('entregue NÃO volta a pago pelo avanço — regressão não é avanço', async () => {
    const id = pedido('sedex', 'entregue');
    const res = await avancar(id, 'pago');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_INVALID_TRANSITION');
    expect(res.body.error.details).toMatchObject({ atual: 'entregue', esperada: null });
    expect(estadoDe(id)).toBe('entregue');
  });

  it('pular uma etapa no meio também é recusado (separação → embalado)', async () => {
    const id = pedido('retirada', 'separacao');
    const res = await avancar(id, 'embalado');
    expect(res.status).toBe(409);
    expect(res.body.error.details.esperada).toBe('conferencia');
    expect(estadoDe(id)).toBe('separacao');
  });

  it('expedido não volta a separação pelo avanço', async () => {
    const id = pedido('sedex', 'expedido');
    const res = await avancar(id, 'separacao');
    expect(res.status).toBe(409);
    expect(estadoDe(id)).toBe('expedido');
  });

  it('a próxima etapa continua passando, uma a uma, até o fim', async () => {
    const id = pedido('sedex');
    for (const etapa of ['separacao', 'conferencia', 'embalado', 'expedido', 'entregue']) {
      const res = await avancar(id, etapa, gerente, etapa === 'expedido' ? DESPACHO : {});
      expect([etapa, res.status], JSON.stringify(res.body)).toEqual([etapa, 200]);
    }
    expect(estadoDe(id)).toBe('entregue');
  });

  it('repetir a etapa atual continua aceito e não anda o pedido (a linha do tempo é append-only)', async () => {
    const id = pedido('sedex');
    expect((await avancar(id, 'separacao')).status).toBe(200);
    const repetido = await avancar(id, 'separacao');
    expect(repetido.status).toBe(200);
    expect(repetido.body.status).toBe('separacao');
    expect(estadoDe(id)).toBe('separacao');
  });

  it('as recusas antigas continuam com o código delas', async () => {
    expect((await avancar(pedido('retirada', 'embalado'), 'expedido')).body.error.code).toBe(
      'CORE_ORDER_IS_PICKUP',
    );
    expect((await avancar(pedido('sedex', 'embalado'), 'pronto_para_retirada')).body.error.code).toBe(
      'CORE_ORDER_IS_DELIVERY',
    );
    expect((await avancar(pedido('sedex', 'aguardando_pagamento'), 'separacao')).body.error.code).toBe(
      'CORE_ORDER_NOT_PAID',
    );
  });
});

// ============================================================================

describe('voltar uma etapa é ação explícita, com motivo e rastro (GAP-PRD-121)', () => {
  it('volta UMA etapa, grava o motivo na linha do tempo e na auditoria', async () => {
    const id = pedido('sedex', 'expedido');
    const res = await voltar(id, 'Etiqueta errada, pacote voltou do balcão dos Correios');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('embalado');
    expect(estadoDe(id)).toBe('embalado');

    const ultimo = eventos(id).at(-1)!;
    expect(ultimo.status).toBe('embalado');
    expect(ultimo.note).toMatch(/Expedido/);
    expect(ultimo.note).toMatch(/Etiqueta errada/);
    expect(ultimo.user_id).toBeTruthy();

    const trilha = auditoria('order.fulfillment_regress', id);
    expect(trilha).toHaveLength(1);
    expect(JSON.parse(trilha[0].detail!)).toMatchObject({
      de: 'expedido',
      para: 'embalado',
      motivo: 'Etiqueta errada, pacote voltou do balcão dos Correios',
    });
  });

  it('entregue por engano volta para "pronto para retirada" no pedido de retirada', async () => {
    const id = pedido('retirada', 'entregue');
    const res = await voltar(id, 'Marcado entregue antes de o cliente chegar');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pronto_para_retirada');
  });

  it('sem motivo é 400 e nada muda', async () => {
    const id = pedido('sedex', 'separacao');
    for (const motivo of [undefined, '', '   ', 'ok']) {
      const res = await voltar(id, motivo);
      expect([motivo, res.status]).toEqual([motivo, 400]);
      expect(res.body.error.code).toBe('CORE_ORDER_REGRESS_REASON');
    }
    expect(estadoDe(id)).toBe('separacao');
  });

  it('"pago" é a primeira etapa: não há para onde voltar', async () => {
    const id = pedido('sedex', 'pago');
    const res = await voltar(id, 'tentativa de voltar antes do começo');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_INVALID_TRANSITION');
  });

  it('pedido parado (cancelado, reembolsado, aguardando) não volta', async () => {
    for (const status of ['cancelado', 'reembolsado', 'aguardando_pagamento']) {
      const res = await voltar(pedido('sedex', status), 'motivo qualquer suficiente');
      expect([status, res.status]).toEqual([status, 409]);
    }
  });

  it('só a gerência desfaz etapa: atendente e estoquista recebem 403', async () => {
    const id = pedido('sedex', 'separacao');
    for (const codigo of ['atendente', 'estoquista']) {
      const quem = await perfil(`u-${codigo}`, codigo);
      const res = await voltar(id, 'eu quero voltar esta etapa', quem);
      expect([codigo, res.status]).toEqual([codigo, 403]);
    }
    expect(estadoDe(id)).toBe('separacao');
  });

  it('pedido de outra empresa é 404, sem dizer que existe', async () => {
    const outra = (await loginForTest(app, {
      userId: 'gerente-vizinho',
      companyId: 'loja-vizinha',
      profileCodes: ['gerente_loja'],
    })).body.company.id as string;
    const alheio = pedido('sedex', 'separacao', outra);
    expect((await voltar(alheio, 'nao e meu pedido mesmo')).status).toBe(404);
    expect((await avancar(alheio, 'conferencia')).status).toBe(404);
    expect(estadoDe(alheio)).toBe('separacao');
  });

  it('depois de voltar, o caminho segue normal a partir da etapa restaurada', async () => {
    const id = pedido('sedex', 'conferencia');
    expect((await voltar(id, 'faltou conferir um item')).body.status).toBe('separacao');
    expect((await avancar(id, 'embalado')).status).toBe(409);
    expect((await avancar(id, 'conferencia')).status).toBe(200);
  });
});

// ============================================================================

describe('cancelar pelo ERP pede motivo e deixa rastro (GAP-PRD-124)', () => {
  it('sem motivo é 400 e a reserva continua', async () => {
    const id = pedido('retirada', 'aguardando_pagamento');
    const res = await request(app)
      .post(`/api/v1/core/orders/${id}/cancel`)
      .set(gerente)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_ORDER_CANCEL_REASON');
    expect(estadoDe(id)).toBe('aguardando_pagamento');
  });

  it('com motivo cancela, grava o motivo no evento e na auditoria', async () => {
    const id = pedido('retirada', 'aguardando_pagamento');
    const res = await request(app)
      .post(`/api/v1/core/orders/${id}/cancel`)
      .set(gerente)
      .send({ reason: 'Cliente desistiu por telefone' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');
    expect(eventos(id).at(-1)).toMatchObject({
      status: 'cancelado',
      note: 'Cliente desistiu por telefone',
    });
    const trilha = auditoria('order.cancel', id);
    expect(trilha).toHaveLength(1);
    expect(JSON.parse(trilha[0].detail!)).toMatchObject({ motivo: 'Cliente desistiu por telefone' });
  });
});
