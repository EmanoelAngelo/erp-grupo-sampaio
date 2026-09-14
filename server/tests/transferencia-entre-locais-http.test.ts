/**
 * TRANSFERÊNCIA ENTRE LOCAIS — a rota HTTP que nenhum teste atravessava.
 *
 * ============================================================================
 * O BURACO DE COBERTURA
 * ============================================================================
 *
 * `transferStock` está provado a fundo no nível do serviço
 * (stock-locations.test.ts, saldo-por-local-nao-fica-negativo.test.ts), mas
 * NENHUM teste atravessava `POST /core/stock/transfers`: o guarda de perfil, o
 * parse do corpo e o `recordAudit` da rota viviam sem cobrança automática.
 * Rota fina também quebra — um rename de campo no corpo, um perfil a menos no
 * guarda ou um recordAudit removido passariam verdes.
 *
 * Este arquivo cobre exatamente as três coisas que SÓ existem na rota:
 *
 *   1. o caminho feliz por HTTP (201) com o saldo POR LOCAL conferido depois,
 *      pela rota de posição por local — nada de olhar o serviço por dentro;
 *   2. a recusa de perfil (403): atendente mora no escritório mas não mexe em
 *      prateleira — o guarda nomeia gerentes e estoquista;
 *   3. a trilha de auditoria da rota, com origem, destino e quantidade.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createLocation } from '../src/services/core/StockLocationService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let produto: string;
let deposito: string;
let vitrine: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'estoquista-transfere',
    companyId: 'loja-transfere',
    profileCodes: ['estoquista'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  produto = createProduct(companyId, { name: 'Capacete fechado', priceCents: 25_000 }).id;
  deposito = createLocation(companyId, { code: 'DEP', name: 'Depósito' }).id;
  vitrine = createLocation(companyId, { code: 'VIT', name: 'Vitrine' }).id;
  applyMovement({
    companyId,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: 'carga-inicial',
    locationId: deposito,
  });
});

async function saldoPorLocal(): Promise<Record<string, number>> {
  const res = await request(app)
    .get(`/api/v1/core/stock/locations/balance/${produto}`)
    .set(auth)
    .expect(200);
  return Object.fromEntries(
    (res.body.balances as { locationId: string; quantity: number }[]).map((l) => [
      l.locationId,
      l.quantity,
    ]),
  );
}

describe('POST /core/stock/transfers', () => {
  it('201: a mercadoria muda de local e a posição por local confere', async () => {
    const res = await request(app).post('/api/v1/core/stock/transfers').set(auth).send({
      productId: produto,
      fromLocationId: deposito,
      toLocationId: vitrine,
      quantity: 3,
      note: 'Reposição da vitrine',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // A referência é o que amarra as duas pernas no histórico.
    expect(typeof res.body.reference).toBe('string');

    const saldos = await saldoPorLocal();
    expect(saldos[deposito]).toBe(7);
    expect(saldos[vitrine]).toBe(3);
  });

  it('403: atendente não mexe em prateleira — e o corpo nem é processado', async () => {
    const atendente = await loginForTest(app, {
      userId: 'atendente-transfere',
      companyId: 'loja-transfere',
      profileCodes: ['atendente'],
    });

    const res = await request(app)
      .post('/api/v1/core/stock/transfers')
      .set({ Authorization: `Bearer ${atendente.body.accessToken}` })
      .send({
        productId: produto,
        fromLocationId: deposito,
        toLocationId: vitrine,
        quantity: 3,
      });

    expect(res.status).toBe(403);
    // Nada se moveu: a recusa veio antes de qualquer escrita.
    const saldos = await saldoPorLocal();
    expect(saldos[deposito]).toBe(10);
    expect(saldos[vitrine] ?? 0).toBe(0);
  });

  it('a rota grava auditoria: quem transferiu, de onde, para onde, quanto', async () => {
    await request(app)
      .post('/api/v1/core/stock/transfers')
      .set(auth)
      .send({
        productId: produto,
        fromLocationId: deposito,
        toLocationId: vitrine,
        quantity: 2,
      })
      .expect(201);

    const linha = getConnection()
      .prepare(
        `SELECT user_id, entity_id, detail FROM core_audit_log
          WHERE company_id = ? AND action = 'stock.transfer'`,
      )
      .get(companyId) as { user_id: string; entity_id: string; detail: string } | undefined;

    expect(linha).toBeDefined();
    expect(linha?.entity_id).toBe(produto);
    const detail = JSON.parse(linha?.detail ?? '{}') as Record<string, unknown>;
    expect(detail.from).toBe(deposito);
    expect(detail.to).toBe(vitrine);
    expect(detail.quantity).toBe(2);
  });

  it('a recusa do serviço atravessa a rota com o envelope da casa', async () => {
    // Mais do que há na origem: o serviço recusa e a rota tem de repassar o
    // código legível, não um 500 cru.
    const res = await request(app).post('/api/v1/core/stock/transfers').set(auth).send({
      productId: produto,
      fromLocationId: deposito,
      toLocationId: vitrine,
      quantity: 99,
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_LOCATION_INSUFFICIENT');
  });
});
