/**
 * Reserva tem que ter origem.
 *
 * `reserved` segura mercadoria: enquanto está lá, o item não aparece
 * disponível. Sem origem — pedido aguardando pagamento, pré-venda aberta — a
 * loja deixa de vender uma peça que está na prateleira, e ninguém descobre por
 * quê, porque não há o que investigar.
 *
 * O contrário é pior: pedido aberto sem reserva significa vender duas vezes o
 * mesmo item.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { inventoryReconciliation } from '../src/services/core/InventoryReconciliation.js';

let precoJusto: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-rec-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `RC-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
});

describe('base limpa', () => {
  it('sem pedidos e sem reservas, nada a apontar', () => {
    produto(precoJusto);

    const r = inventoryReconciliation(precoJusto);

    expect(r.healthy).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('pedido aberto pelo caminho oficial nasce coerente', () => {
    const p = produto(precoJusto);
    checkout({
      idempotencyKey: 'ck-rec-1',
      customerName: 'Cliente Coerente',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: p, quantity: 3 }],
    });

    const r = inventoryReconciliation(precoJusto);

    // Reserva e origem batem, e o razão registrou a reserva.
    expect(r.healthy).toBe(true);
    expect(r.issues).toEqual([]);
  });
});

describe('reserva sem origem', () => {
  it('é crítica: segura mercadoria que ninguém está comprando', () => {
    const p = produto(precoJusto);
    // Escrita direta na coluna, sem pedido — exatamente o estado que se quer
    // detectar, e que nenhum writer oficial produz.
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 2 WHERE company_id = ? AND product_id = ?')
      .run(precoJusto, p);

    const r = inventoryReconciliation(precoJusto);

    expect(r.healthy).toBe(false);
    const critica = r.issues.find((i) => i.check === 'STOCK_RESERVATION_WITHOUT_SOURCE');
    expect(critica).toBeDefined();
    expect(critica?.detail).toContain('2 reservado');
  });

  it('reserva maior que o pedido aponta só a diferença', () => {
    const p = produto(precoJusto);
    checkout({
      idempotencyKey: 'ck-rec-2',
      customerName: 'Cliente',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: p, quantity: 1 }],
    });
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 4 WHERE company_id = ? AND product_id = ?')
      .run(precoJusto, p);

    const r = inventoryReconciliation(precoJusto);

    expect(r.critical).toBe(1);
    expect(r.issues[0].check).toBe('STOCK_RESERVATION_WITHOUT_SOURCE');
  });
});

describe('pedido sem reserva', () => {
  it('é crítico: o item pode ser vendido de novo', () => {
    const p = produto(precoJusto);
    checkout({
      idempotencyKey: 'ck-rec-3',
      customerName: 'Cliente',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: p, quantity: 2 }],
    });
    // Alguém zerou a reserva sem cancelar o pedido.
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 0 WHERE company_id = ? AND product_id = ?')
      .run(precoJusto, p);

    const r = inventoryReconciliation(precoJusto);

    expect(r.healthy).toBe(false);
    expect(r.issues.some((i) => i.check === 'OPEN_ORDER_WITHOUT_RESERVATION')).toBe(true);
  });
});

describe('reserva sem rastro no razão', () => {
  it('é aviso, não crítico — o saldo está certo, a história não', () => {
    const p = produto(precoJusto);
    checkout({
      idempotencyKey: 'ck-rec-4',
      customerName: 'Cliente',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: p, quantity: 1 }],
    });
    // Apaga o movimento, mantendo saldo e pedido coerentes entre si.
    getConnection()
      .prepare("DELETE FROM core_stock_movements WHERE product_id = ? AND kind LIKE '%RESERVATION%'")
      .run(p);

    const r = inventoryReconciliation(precoJusto);

    expect(r.healthy).toBe(true);
    expect(r.warnings).toBe(1);
    expect(r.issues[0].check).toBe('RESERVATION_WITHOUT_LEDGER');
  });
});

describe('isolamento', () => {
  it('a conferência de uma operação não enxerga a outra', async () => {
    const gringa = await upsertCompany({
      slug: 'gringa',
      tradeName: 'Gringa',
      legalName: 'Gringa Ltda',
    });
    const daGringa = produto(gringa);
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 5 WHERE company_id = ? AND product_id = ?')
      .run(gringa, daGringa);

    expect(inventoryReconciliation(precoJusto).issues).toEqual([]);
    expect(inventoryReconciliation(gringa).critical).toBe(1);
  });
});
