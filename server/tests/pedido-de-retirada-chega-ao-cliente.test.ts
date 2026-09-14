/**
 * O PEDIDO DE RETIRADA TEM DE CHEGAR AO CLIENTE.
 *
 * ============================================================================
 * O BECO SEM SAÍDA DO DIA 1
 * ============================================================================
 *
 * O padrão de toda loja do grupo é `pickup_enabled: 1, delivery_enabled: 0` —
 * quer dizer, **todo pedido online nasce sendo de retirada**. E a tela de
 * pedidos avançava as etapas por um mapa fixo:
 *
 *     embalado → expedido
 *
 * "Expedido" é etapa de ENTREGA. O servidor recusa com 409 e a mensagem certa
 * ("pedido é de retirada: a etapa é 'pronto para retirada'"), mas a tela não
 * conhece esse estado: não tem rótulo, não tem cor e não tem botão. O pedido
 * fica parado em "Embalado" para sempre, a mercadoria fica no balcão, e o
 * cliente nunca é avisado de que ela está lá esperando por ele.
 *
 * O servidor está certo desde sempre. O que faltava era a tela saber os onze
 * estados — e o vocabulário deles vir do servidor, em vez de ser uma segunda
 * cópia que envelhece sozinha.
 *
 * ============================================================================
 * E O PEDIDO REEMBOLSADO, QUE CONTINUAVA ANDANDO
 * ============================================================================
 *
 * `advanceFulfillment` recusa `aguardando_pagamento` e `cancelado`, e deixava
 * passar `reembolsado`. O dinheiro já voltou para o cliente, e o pedido seguia
 * para "expedido" — com o e-mail "seu pedido está a caminho" indo para quem
 * acabou de ser reembolsado.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import {
  ETAPAS_DA_ENTREGA,
  ETAPAS_DA_RETIRADA,
  ORDER_STATUS_LABEL,
} from '../src/services/core/StorefrontService.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-oms',
    companyId: 'loja-oms',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Um pedido pago, do jeito que a loja o entrega. */
function pedido(shippingMethod: string, status = 'pago'): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const numero =
    Number(
      (
        getConnection()
          .prepare('SELECT COALESCE(MAX(number), 0) AS n FROM core_orders WHERE company_id = ?')
          .get(companyId) as { n: number }
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
    .run(id, companyId, numero, status, shippingMethod, randomUUID(), agora, agora);
  return id;
}

function avancar(orderId: string, status: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/core/orders/${orderId}/fulfillment`)
    .set(auth)
    .send({ status, ...extra });
}

function estadoDe(orderId: string): string {
  return String(
    (getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as {
      status: string;
    }).status,
  );
}

// ============================================================================

describe('o caminho da retirada vai até o fim', () => {
  it('as etapas da retirada terminam em "pronto para retirada", e depois "entregue"', () => {
    /*
      A LISTA É DO SERVIDOR. A tela tinha a própria, e foi ela que produziu o
      beco: `embalado → expedido` para todo pedido, inclusive os de retirada.
    */
    expect(ETAPAS_DA_RETIRADA).toEqual([
      'pago',
      'separacao',
      'conferencia',
      'embalado',
      'pronto_para_retirada',
      'entregue',
    ]);
  });

  it('as da entrega passam por "expedido"', () => {
    expect(ETAPAS_DA_ENTREGA).toEqual([
      'pago',
      'separacao',
      'conferencia',
      'embalado',
      'expedido',
      'entregue',
    ]);
  });

  it('o pedido de retirada percorre as quatro etapas e chega ao cliente', async () => {
    const id = pedido('retirada');

    for (const etapa of ETAPAS_DA_RETIRADA.slice(1)) {
      const res = await avancar(id, etapa);
      expect([etapa, res.status], JSON.stringify(res.body)).toEqual([etapa, 200]);
    }

    expect(estadoDe(id)).toBe('entregue');
  });

  it('o de entrega percorre as dele', async () => {
    const id = pedido('sedex');

    for (const etapa of ETAPAS_DA_ENTREGA.slice(1)) {
      // O despacho diz QUEM leva (GAP-PRD-119); motoboy da loja não tem código.
      const res = await avancar(id, etapa, etapa === 'expedido' ? { carrier: 'propria' } : {});
      expect([etapa, res.status], JSON.stringify(res.body)).toEqual([etapa, 200]);
    }

    expect(estadoDe(id)).toBe('entregue');
  });

  it('e cada etapa tem rótulo em português — inclusive a da retirada', () => {
    for (const etapa of [...ETAPAS_DA_RETIRADA, ...ETAPAS_DA_ENTREGA]) {
      expect([etapa, ORDER_STATUS_LABEL[etapa]]).toEqual([etapa, expect.any(String)]);
    }
    expect(ORDER_STATUS_LABEL.pronto_para_retirada).toBe('Pronto para retirada');
  });

  it('os estados terminais também têm rótulo — senão a tela mostra o código cru', () => {
    for (const estado of ['cancelado', 'reembolsado', 'aguardando_pagamento']) {
      expect([estado, ORDER_STATUS_LABEL[estado]]).toEqual([estado, expect.any(String)]);
    }
  });
});

// ============================================================================

describe('as etapas que não são deste caminho continuam recusadas', () => {
  it('retirada não expede', async () => {
    const id = pedido('retirada');
    const res = await avancar(id, 'expedido');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_IS_PICKUP');
  });

  it('entrega não fica "pronta para retirada"', async () => {
    const id = pedido('sedex');
    const res = await avancar(id, 'pronto_para_retirada');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_IS_DELIVERY');
  });
});

// ============================================================================

describe('pedido reembolsado não anda mais', () => {
  it('avançar um pedido reembolsado é recusado', async () => {
    /*
      O dinheiro já voltou para o cliente. Seguir para "expedido" mandaria o
      e-mail "seu pedido está a caminho" para quem acabou de ser reembolsado —
      e tiraria do estoque uma mercadoria que ninguém comprou mais.
    */
    const id = pedido('sedex', 'reembolsado');

    const res = await avancar(id, 'separacao');

    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/reembolsad/i);
    expect(estadoDe(id)).toBe('reembolsado');
  });

  it('cancelado continua recusado', async () => {
    const id = pedido('sedex', 'cancelado');
    expect((await avancar(id, 'separacao')).status).toBe(409);
  });

  it('e o pedido pago continua andando — a recusa é do estado, não da rota', async () => {
    const id = pedido('sedex', 'pago');
    expect((await avancar(id, 'separacao')).status).toBe(200);
  });
});
