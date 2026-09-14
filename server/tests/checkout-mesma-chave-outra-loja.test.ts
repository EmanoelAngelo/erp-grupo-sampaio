/**
 * ============================================================================
 * O MESMO CHECKOUT É O MESMO CARRINHO INTEIRO — TODAS AS LOJAS (R2-IDEM, item 7)
 * ============================================================================
 *
 * O carrinho de duas lojas vira dois pedidos, e a chave de cada pedido é
 * `<Idempotency-Key>:<empresa>`. A impressão do RES-IDEM-VIZ era da parte de
 * CADA loja, e isso deixava duas brechas, as duas com dinheiro no meio:
 *
 *   - a mesma chave com a loja B RETIRADA respondia só o pedido da loja A. O
 *     pedido da B continuava reservando mercadoria (e com cobrança pendurada),
 *     sem aparecer na resposta — o comprador achava que tinha comprado uma coisa;
 *   - a mesma chave com a loja B ACRESCENTADA devolvia o pedido da A e criava um
 *     pedido NOVO para a B, com a chave de um checkout que já tinha acontecido.
 *
 * E o endereço não entrava em impressão nenhuma: a mesma chave com outro
 * endereço devolvia o pedido do endereço antigo como se fosse o novo.
 *
 * Agora a impressão é do PEDIDO INTEIRO — todas as lojas, itens, quantidades,
 * frete escolhido de cada loja, endereços, pagamento, cupom e comprador —,
 * gravada em cada pedido do checkout. A mesma chave com outro carrinho é 422
 * CORE_IDEMPOTENCY_KEY_REUSED ANTES de reservar qualquer coisa; o mesmo corpo
 * devolve TODOS os pedidos da primeira vez. Pedido anterior à coluna segue a
 * regra de hoje.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { checkout, type CheckoutInput } from '../src/services/core/StorefrontService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { ApiError } from '../src/utils/errors.js';

let LOJA_A: string;
let LOJA_B: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  LOJA_A = await upsertCompany({ slug: 'loja-checkout-a', tradeName: 'Loja A', legalName: 'Loja A Ltda' });
  LOJA_B = await upsertCompany({ slug: 'loja-checkout-b', tradeName: 'Loja B', legalName: 'Loja B Ltda' });
});

function publicado(empresa: string, estoque = 10): string {
  const id = `vitrine-${randomUUID().slice(0, 8)}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
       active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Mochila', 'UN', 4000, 15000, 1, 1, ?, ?)`,
  ).run(id, empresa, id, agora, agora);
  db.prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)').run(
    empresa,
    id,
    estoque,
    agora,
  );
  return id;
}

function reservado(empresa: string, productId: string): number {
  const row = getConnection()
    .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(empresa, productId) as { reserved: number } | undefined;
  return row?.reserved ?? 0;
}

function pedidos(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_orders').get() as { n: number }).n;
}

function fechar(chave: string, itens: { productId: string; quantity: number }[], extra: Partial<CheckoutInput> = {}) {
  return checkout({
    idempotencyKey: chave,
    customerName: 'Ana Compradora',
    customerDocument: '52998224725',
    customerEmail: 'ana@exemplo.com',
    shippingZip: '01310-100',
    shippingAddress: 'Avenida Paulista, 1000 - São Paulo/SP',
    paymentMethod: 'pix',
    items: itens,
    ...extra,
  });
}

function recusa(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('era para recusar, e passou');
}

// ============================================================================

describe('o mesmo corpo devolve TODOS os pedidos da primeira vez', () => {
  it('carrinho de duas lojas reenviado igual: os dois pedidos, sem pedido nem reserva a mais', () => {
    const a = publicado(LOJA_A);
    const b = publicado(LOJA_B);
    const primeira = fechar('ck-duas-lojas', [
      { productId: a, quantity: 1 },
      { productId: b, quantity: 2 },
    ]);
    expect(primeira).toHaveLength(2);

    // A ordem dos itens no corpo não muda o carrinho.
    const segunda = fechar('ck-duas-lojas', [
      { productId: b, quantity: 2 },
      { productId: a, quantity: 1 },
    ]);
    expect(segunda.map((o) => o.id).sort()).toEqual(primeira.map((o) => o.id).sort());
    expect(pedidos()).toBe(2);
    expect(reservado(LOJA_A, a)).toBe(1);
    expect(reservado(LOJA_B, b)).toBe(2);
  });
});

describe('a mesma chave com outro carrinho é 422 antes de reservar', () => {
  it('a loja B RETIRADA: recusa nomeando os dois pedidos — o da B não some da resposta', () => {
    const a = publicado(LOJA_A);
    const b = publicado(LOJA_B);
    const primeira = fechar('ck-tira-b', [
      { productId: a, quantity: 1 },
      { productId: b, quantity: 1 },
    ]);

    const err = recusa(() => fechar('ck-tira-b', [{ productId: a, quantity: 1 }]));
    expect(err.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(err.status).toBe(422);
    const detalhe = err.details as { orderIds?: string[]; orderNumbers?: number[] };
    expect([...(detalhe.orderIds ?? [])].sort()).toEqual(primeira.map((o) => o.id).sort());
    expect(detalhe.orderNumbers).toHaveLength(2);
    expect(pedidos()).toBe(2);
    expect(reservado(LOJA_A, a)).toBe(1);
    expect(reservado(LOJA_B, b)).toBe(1);
  });

  it('a loja B ACRESCENTADA: recusa, e nenhum pedido nasce para a B com a chave velha', () => {
    const a = publicado(LOJA_A);
    const b = publicado(LOJA_B);
    fechar('ck-poe-b', [{ productId: a, quantity: 1 }]);

    const err = recusa(() =>
      fechar('ck-poe-b', [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ]),
    );
    expect(err.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(pedidos()).toBe(1);
    expect(reservado(LOJA_B, b)).toBe(0);
  });

  it('o mesmo carrinho com OUTRO endereço de entrega é outro pedido', () => {
    const a = publicado(LOJA_A);
    fechar('ck-endereco', [{ productId: a, quantity: 1 }]);
    const err = recusa(() =>
      fechar('ck-endereco', [{ productId: a, quantity: 1 }], { shippingAddress: 'Rua Augusta, 50 - São Paulo/SP' }),
    );
    expect(err.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    const outroCep = recusa(() => fechar('ck-endereco', [{ productId: a, quantity: 1 }], { shippingZip: '04001-000' }));
    expect(outroCep.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(pedidos()).toBe(1);
  });

  it('o frete escolhido de UMA das lojas mudou: recusa o carrinho inteiro', () => {
    const a = publicado(LOJA_A);
    const b = publicado(LOJA_B);
    const retirada = { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, real: false };
    const tabela = { method: 'tabela_da_loja', label: 'Entrega da loja', priceCents: 2500, estimatedDays: 4, real: false };
    fechar(
      'ck-frete',
      [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ],
      { shippingPorEmpresa: { [LOJA_A]: retirada, [LOJA_B]: retirada } },
    );
    const err = recusa(() =>
      fechar(
        'ck-frete',
        [
          { productId: a, quantity: 1 },
          { productId: b, quantity: 1 },
        ],
        { shippingPorEmpresa: { [LOJA_A]: retirada, [LOJA_B]: tabela } },
      ),
    );
    expect(err.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(pedidos()).toBe(2);
  });
});

describe('pedido anterior à impressão do checkout', () => {
  it('sem a impressão do carrinho (nem a da loja), segue a regra de hoje', () => {
    const a = publicado(LOJA_A);
    const b = publicado(LOJA_B);
    const primeira = fechar('ck-legado', [
      { productId: a, quantity: 1 },
      { productId: b, quantity: 1 },
    ]);
    getConnection().exec('UPDATE core_orders SET checkout_fingerprint = NULL, idempotency_fingerprint = NULL');

    // A regra de hoje: cada loja devolve o pedido da chave dela.
    const deNovo = fechar('ck-legado', [{ productId: a, quantity: 1 }]);
    expect(deNovo.map((o) => o.id)).toEqual([primeira.find((o) => o.company_id === LOJA_A)!.id]);
    expect(pedidos()).toBe(2);
  });
});
