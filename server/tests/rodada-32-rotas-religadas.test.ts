/**
 * AS ROTAS QUE A VARREDURA DA RODADA 28 ACHOU MORTAS — cada uma re-medida na
 * rodada 32, e as que FICARAM ganharam o que faltava: leitor de verdade e
 * teste que as exercite.
 *
 *   - `GET /core/cash/sessions`: LIGADA. O comentário admitia "nenhuma tela o
 *     consome"; a decisão foi ligar (histórico de turnos na tela de caixa da
 *     gestão) porque o que o dono perde sem ela é a pergunta mais comum do
 *     fechamento — "de quem era o caixa que fechou faltando?". A rota agora
 *     devolve quem abriu e quem fechou PELO NOME.
 *
 *   - `POST /core/pdv/terminal/:id/confirmar-teste`: DECLARADA. É a porta que
 *     torna o fluxo assíncrono do PIX percorrível sem aparelho físico, correta
 *     e documentada — mas guarda sem teste que a exercite é promessa. O caso
 *     aqui percorre o caminho do provedor mock de ponta a ponta PELA ROTA.
 *
 *   - `GET /core/orders/:id` e `POST /core/orders/:id/cancel`: LIGADAS. O
 *     cancel foi re-medido: só cancela pedido AGUARDANDO PAGAMENTO, devolve a
 *     reserva, é idempotente e recusa pedido pago (o caminho certo é
 *     devolução). É seguro e útil — sem ele, o pedido que o cliente desistiu
 *     segura reserva de estoque para sempre, sem ação na tela.
 *
 *   - `GET /core/logistics/shipments`: APAGADA (ver o comentário em core.ts).
 *     O caso aqui prova que a rota NÃO existe mais — para ela não voltar em
 *     silêncio enquanto o módulo /api/v1/logistics, que fica, segue vivo.
 *
 *   - `GET /core/workshop/pending-payment`: FICA. Não é morta por acidente: é
 *     a metade de LER do fluxo de checkout da OS (`workshops-equipment.test.ts`
 *     percorre complete -> fila -> checkout inteiro). Apagá-la mutilaria um
 *     fluxo cujo escritor (checkout) continua vivo e testado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';

const app = createApp();
const LOJA = 'loja-religada';

async function token(perfil: string, userId: string): Promise<string> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

describe('GET /core/cash/sessions — o histórico de turnos, com gente pelo nome', () => {
  it('abrir e fechar aparecem no histórico com opened_by_name, closed_by_name e diferença', async () => {
    const caixa = await token('operador_caixa_loja', 'maria');

    const aberto = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth(caixa))
      .send({ openingCents: 10_000 });
    expect(aberto.status).toBe(201);

    // Conta R$ 90,00 onde deveria haver R$ 100,00: diferença de -10,00.
    const fechado = await request(app)
      .post(`/api/v1/core/cash/${aberto.body.id}/close`)
      .set(auth(caixa))
      .send({ countedCents: 9_000 });
    expect(fechado.status).toBe(200);

    const historico = await request(app).get('/api/v1/core/cash/sessions').set(auth(caixa));
    expect(historico.status).toBe(200);
    const turno = historico.body.items.find((s: { id: string }) => s.id === aberto.body.id);
    expect(turno).toBeTruthy();
    expect(turno.opened_by_name).toBe('maria');
    expect(turno.closed_by_name).toBe('maria');
    expect(turno.difference_cents).toBe(-1_000);
    expect(turno.status).toBe('closed');
  });
});

describe('POST /core/pdv/terminal/:id/confirmar-teste — o caminho do mock, pela rota', () => {
  function maquininhaMock(): void {
    getConnection()
      .prepare('INSERT INTO payment_terminal_configurations (id, data) VALUES (?, ?)')
      .run(
        `cfg-${LOJA}`,
        JSON.stringify({
          id: `cfg-${LOJA}`,
          companyId: LOJA,
          provider: 'mock',
          active: true,
          createdAt: new Date().toISOString(),
        }),
      );
  }

  it('PIX nasce pendente na maquininha e só liquida com a confirmação explícita de teste', async () => {
    const caixa = await token('operador_caixa_loja', 'maria');
    maquininhaMock();

    // A cobrança nasce pela rota do PDV, pendente.
    const cobranca = await request(app)
      .post('/api/v1/core/pdv/terminal/charge')
      .set(auth(caixa))
      .set('Idempotency-Key', 'pix-rota-1')
      .send({ method: 'pix', amountInCents: 5_000 });
    expect(cobranca.status).toBe(200);
    expect(cobranca.body.settled).toBe(false);

    const confirmada = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cobranca.body.transactionId}/confirmar-teste`)
      .set(auth(caixa));
    expect(confirmada.status).toBe(200);
    expect(confirmada.body.settled).toBe(true);
    expect(confirmada.body.state).toBe('aprovado');
  });
});

describe('GET /core/orders/:id e POST /core/orders/:id/cancel — o pedido tem detalhe e saída', () => {
  /** Pedido online direto no banco, como a tela de pedidos o encontraria. */
  function pedido(status: string, quantidade = 2): { orderId: string; productId: string } {
    const db = getConnection();
    const agora = new Date().toISOString();
    const productId = `p-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Camisa Online', 'UN', 0, 5000, 'Geral', 0, 1, ?, ?)`,
    ).run(productId, LOJA, productId, agora, agora);
    // Estoque com a reserva que o checkout teria segurado.
    db.prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, ?, ?)',
    ).run(LOJA, productId, quantidade, agora);

    const orderId = `pedido-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO core_orders
         (id, company_id, number, customer_name, customer_email,
          shipping_zip, shipping_address, shipping_method, shipping_cents,
          items_cents, total_cents, status, payment_method, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 1, 'Joana Compradora', 'joana@exemplo.com', '68900000', 'Rua das Flores, 250',
               'retirada', 0, 10000, 10000, ?, 'pix', ?, ?, ?)`,
    ).run(orderId, LOJA, status, `k-${orderId}`, agora, agora);
    db.prepare(
      `INSERT INTO core_order_items (id, order_id, company_id, product_id, description,
                                     quantity, unit_price_cents, total_cents)
       VALUES (?, ?, ?, ?, 'Camisa Online', ?, 5000, 10000)`,
    ).run(`oi-${orderId}`, orderId, LOJA, productId, quantidade);
    return { orderId, productId };
  }

  it('o detalhe devolve itens e eventos; pedido de OUTRA empresa é 404, não vazamento', async () => {
    const atendente = await token('atendente', 'ana');
    const { orderId } = pedido('aguardando_pagamento');

    const res = await request(app).get(`/api/v1/core/orders/${orderId}`).set(auth(atendente));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(Array.isArray(res.body.events)).toBe(true);

    // Outra empresa com o MESMO id de pedido não aparece por aqui.
    upsertCompany({ id: 'outra-empresa', slug: 'outra-empresa', legalName: 'Outra Ltda', tradeName: 'Outra' });
    getConnection()
      .prepare("UPDATE core_orders SET company_id = 'outra-empresa' WHERE id = ?")
      .run(orderId);
    const vazio = await request(app).get(`/api/v1/core/orders/${orderId}`).set(auth(atendente));
    expect(vazio.status).toBe(404);
  });

  it('cancelar DEVOLVE a reserva, é idempotente, e o operador de caixa não cancela', async () => {
    const atendente = await token('atendente', 'ana');
    const caixa = await token('operador_caixa_loja', 'maria');
    const { orderId, productId } = pedido('aguardando_pagamento');

    const barrado = await request(app)
      .post(`/api/v1/core/orders/${orderId}/cancel`)
      .set(auth(caixa))
      .send({ reason: 'tentativa do balcão' });
    expect(barrado.status).toBe(403);

    const res = await request(app)
      .post(`/api/v1/core/orders/${orderId}/cancel`)
      .set(auth(atendente))
      .send({ reason: 'cliente desistiu' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');

    const estoque = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(LOJA, productId) as { reserved: number };
    expect(estoque.reserved).toBe(0);

    // Dez cliques liberam a reserva UMA vez: repetir não é erro nem faz nada.
    const denovo = await request(app)
      .post(`/api/v1/core/orders/${orderId}/cancel`)
      .set(auth(atendente))
      .send({ reason: 'clique repetido' });
    expect(denovo.status).toBe(200);
    expect(denovo.body.status).toBe('cancelado');
  });

  it('pedido PAGO não se cancela por aqui: 409 apontando para a devolução', async () => {
    const gerente = await token('gerente_loja', 'chefe');
    const { orderId } = pedido('pago');

    const res = await request(app)
      .post(`/api/v1/core/orders/${orderId}/cancel`)
      .set(auth(gerente))
      .send({ reason: 'tarde demais' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_ALREADY_PAID');
  });
});

describe('GET /core/logistics/shipments — apagada, e provada apagada', () => {
  it('a rota do core não existe mais; a do módulo de logística continua guardada', async () => {
    const gerente = await token('gerente_loja', 'chefe');

    const morta = await request(app)
      .get('/api/v1/core/logistics/shipments')
      .set(auth(gerente));
    expect(morta.status).toBe(404);

    // O módulo próprio segue no ar (a permissão decide quem entra, não o 404).
    const viva = await request(app).get('/api/v1/logistics/shipments').set(auth(gerente));
    expect(viva.status).not.toBe(404);
  });
});
