/**
 * Avaliações de produto — compra verificada de verdade.
 *
 * "Compra verificada" aqui não é um selo: é a condição para a avaliação
 * existir. Avaliar exige um pedido ENTREGUE, da própria conta, contendo o
 * produto. Sem essa amarra, a seção viraria mural de opinião fabricada — e
 * avaliação fabricada destrói exatamente a confiança que ela existe para
 * criar.
 *
 * As três recusas que este arquivo protege:
 *  - quem nunca comprou;
 *  - quem comprou e AINDA NÃO RECEBEU (opinião sobre a foto);
 *  - quem comprou outro produto.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout, markOrderPaid, advanceFulfillment } from '../src/services/core/StorefrontService.js';
import {
  abreviarNome,
  listProductReviews,
  myReview,
  submitReview,
} from '../src/services/core/ProductReviewService.js';
import { confirmarEmail, registerCustomerAccount } from '../src/services/core/CustomerPortalService.js';
import { resolveCustomerSession } from '../src/services/core/CustomerPortalService.js';

let gringa: string;
let n = 0;

function produto(id: string): string {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, gringa, `AV-${id}`, `Produto ${id}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
  ).run(gringa, id, agora);
  return id;
}

/** Conta com uma compra; `entregar` leva o pedido até "entregue". */
async function comprador(input: {
  email: string;
  documento: string;
  productId: string;
  entregar: boolean;
  nome?: string;
}) {
  n += 1;
  const [pedido] = checkout({
    idempotencyKey: `av-${n}`,
    customerName: input.nome ?? 'Ana Beatriz Silva',
    customerEmail: input.email,
    customerDocument: input.documento,
    paymentMethod: 'pix',
    items: [{ productId: input.productId, quantity: 1 }],
  });

  if (input.entregar) {
    markOrderPaid({ companyId: gringa, orderId: pedido.id, provider: 'manual' });
    // Esteira de RETIRADA: chega em 'entregue' sem precisar de transportadora.
    for (const etapa of ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue']) {
      advanceFulfillment({ companyId: gringa, orderId: pedido.id, toStatus: etapa });
    }
  }

  const sessao = await registerCustomerAccount({ termsAccepted: true,
    email: input.email,
    document: input.documento,
    password: 'senha-do-cliente-2026',
  });
  // Rodada 50: a co-prova espera o código — prova a caixa na hora, como o
  // dono dela faria (a espera em si mora em cadastro-por-email.test.ts).
  provarCaixa(sessao.account.id, input.email);
  const resolvida = resolveCustomerSession(sessao.token)!;
  return { accountId: resolvida.account.id, customerIds: resolvida.customerIds };
}

/** Lê o código do e-mail enfileirado e confirma — o gesto do dono da caixa. */
function provarCaixa(accountId: string, email: string): void {
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy(); confirmarEmail({ accountId, codigo });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('quem pode avaliar', () => {
  it('quem comprou e RECEBEU consegue', async () => {
    const p = produto('p-1');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: true,
    });

    const r = submitReview({ ...c, productId: p, rating: 5, comment: 'Chegou rápido.' });
    expect(r.rating).toBe(5);
    expect(listProductReviews(p).count).toBe(1);
  });

  it('quem comprou e AINDA NÃO recebeu é recusado', async () => {
    const p = produto('p-1');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: false,
    });

    // Opinião sobre produto que não chegou é opinião sobre a foto.
    expect(() => submitReview({ ...c, productId: p, rating: 5 })).toThrow(/comprou e já recebeu/i);
    expect(listProductReviews(p).count).toBe(0);
  });

  it('quem comprou OUTRO produto não avalia este', async () => {
    const comprado = produto('p-1');
    const outro = produto('p-2');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: comprado,
      entregar: true,
    });

    expect(() => submitReview({ ...c, productId: outro, rating: 5 })).toThrow(/comprou e já recebeu/i);
  });

  it('conta sem compra nenhuma não avalia', () => {
    const p = produto('p-1');
    expect(() =>
      submitReview({ accountId: 'conta-fantasma', customerIds: [], productId: p, rating: 5 }),
    ).toThrow(/comprou e já recebeu/i);
  });
});

describe('um voto por pessoa', () => {
  it('reavaliar EDITA em vez de somar', async () => {
    const p = produto('p-1');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: true,
    });

    submitReview({ ...c, productId: p, rating: 5, comment: 'Ótimo' });
    submitReview({ ...c, productId: p, rating: 2, comment: 'Mudei de ideia' });

    // Dez compras não dão dez votos, senão quem compra sempre domina a nota.
    const resumo = listProductReviews(p);
    expect(resumo.count).toBe(1);
    expect(resumo.average).toBe(2);
    expect(resumo.items[0].comment).toBe('Mudei de ideia');
  });

  it('a própria avaliação é recuperável para edição', async () => {
    const p = produto('p-1');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: true,
    });
    submitReview({ ...c, productId: p, rating: 4 });

    expect(myReview(c.accountId, p)!.rating).toBe(4);
    expect(myReview(c.accountId, 'produto-que-nao-avaliou')).toBeNull();
  });
});

describe('a nota', () => {
  it('recusa fora de 1 a 5', async () => {
    const p = produto('p-1');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: true,
    });

    expect(() => submitReview({ ...c, productId: p, rating: 0 })).toThrow(/1 a 5/);
    expect(() => submitReview({ ...c, productId: p, rating: 6 })).toThrow(/1 a 5/);
    expect(() => submitReview({ ...c, productId: p, rating: 4.5 })).toThrow(/1 a 5/);
  });

  it('a média sai com uma casa decimal', async () => {
    const p = produto('p-1');
    const a = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: true,
    });
    const b = await comprador({
      email: 'bruno@exemplo.com',
      documento: '529.982.247-25',
      productId: p,
      entregar: true,
    });
    submitReview({ ...a, productId: p, rating: 5 });
    submitReview({ ...b, productId: p, rating: 4 });

    expect(listProductReviews(p).average).toBe(4.5);
  });

  it('produto sem avaliação devolve média nula, não zero', () => {
    const p = produto('p-1');
    // Zero seria lido como "nota zero" na vitrine — é diferente de "sem nota".
    expect(listProductReviews(p).average).toBeNull();
    expect(listProductReviews(p).count).toBe(0);
  });
});

describe('privacidade', () => {
  it('o nome público é abreviado', () => {
    expect(abreviarNome('Ana Beatriz Silva')).toBe('Ana S.');
    expect(abreviarNome('Bruno Costa')).toBe('Bruno C.');
    expect(abreviarNome('Madonna')).toBe('Madonna');
    expect(abreviarNome('')).toBe('Cliente');
  });

  it('a avaliação pública NÃO expõe o nome completo nem o e-mail', async () => {
    const p = produto('p-1');
    const c = await comprador({
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      productId: p,
      entregar: true,
      nome: 'Ana Beatriz Silva',
    });
    submitReview({ ...c, productId: p, rating: 5 });

    const publico = JSON.stringify(listProductReviews(p));
    expect(publico).toContain('Ana S.');
    // A vitrine é pública; nome completo e e-mail de quem comprou não são.
    expect(publico).not.toContain('Ana Beatriz Silva');
    expect(publico).not.toContain('ana@exemplo.com');
  });
});
