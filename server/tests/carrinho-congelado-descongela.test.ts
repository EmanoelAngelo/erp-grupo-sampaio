/**
 * O CARRINHO GUARDADO NO NAVEGADOR NÃO PODE MENTIR O PREÇO.
 *
 * ============================================================================
 * R$ 240,00 NA TELA, R$ 320,00 NA COBRANÇA
 * ============================================================================
 *
 * O carrinho da loja guarda o PRODUTO INTEIRO no `localStorage` — nome, preço,
 * disponível, tudo — e nunca pergunta de novo. É a decisão certa para o
 * carrinho sobreviver a um refresh e a decisão errada para o preço: a promoção
 * termina, o preço de tabela volta, e o cliente que deixou a aba aberta desde
 * ontem continua vendo R$ 240,00.
 *
 * O servidor está certo o tempo todo: o `checkout` reprecifica cada item pelo
 * banco. Então o pedido nasce por R$ 320,00 e o PIX é emitido nesse valor —
 * com o cliente tendo lido, conferido e concordado com outro número.
 *
 * O contrário também acontece e é pior de explicar: a promoção COMEÇA, o
 * cliente paga o preço velho, mais caro, sem nunca ver o desconto que estava
 * anunciado na mesma vitrine.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * A cotação de frete já pergunta ao banco o preço de cada item — é dele que
 * sai o `itemsCents` de cada loja — e jogava o número fora. Ela roda a cada
 * mudança do carrinho e a cada abertura da gaveta, que é exatamente o momento
 * em que o cliente vai olhar os valores.
 *
 * Então ela passa a DEVOLVER o que já sabe: preço, nome e disponível de cada
 * item, do servidor. A tela adota esses números antes de mostrar o total, e
 * avisa quando algum mudou — porque preço que muda sozinho na frente do
 * cliente, sem uma palavra, é o mesmo defeito com outra cara.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';

const app = createApp();
let companyId: string;
let jaqueta: string;

async function abrirLoja(): Promise<void> {
  const res = await loginForTest(app, {
    userId: 'gerente-carrinho',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  companyId = res.body.company.id;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_storefront_settings (company_id, updated_at) VALUES (?, ?)`,
    )
    .run(companyId, agora);
}

function publicar(empresa: string, nome: string, precoCents: number, saldo: number): string {
  const id = String(createProduct(empresa, { name: nome, priceCents: precoCents }).id);
  getConnection()
    .prepare('UPDATE core_products SET publish_online = 1 WHERE id = ?')
    .run(id);
  applyMovement({
    companyId: empresa,
    productId: id,
    movementType: 'in',
    quantity: saldo,
    referenceType: 'entrada',
    referenceId: `carga-${id}`,
  });
  return id;
}

function cotar(items: { productId: string; quantity: number }[]) {
  return request(app).post('/api/v1/loja/checkout/frete').send({ items });
}

beforeEach(async () => {
  resetDbForTests();
  await abrirLoja();
  jaqueta = publicar(companyId, 'Jaqueta Corta-Vento', 24_000, 5);
});

// ============================================================================

describe('a cotação devolve o preço de agora', () => {
  it('cada item volta com preço, nome e disponível do servidor', async () => {
    const res = await cotar([{ productId: jaqueta, quantity: 2 }]);

    expect(res.status).toBe(200);
    const item = res.body.itens.find((i: { productId: string }) => i.productId === jaqueta);
    expect(item).toBeTruthy();
    expect(item.priceCents).toBe(24_000);
    expect(item.name).toBe('Jaqueta Corta-Vento');
    expect(item.available).toBe(5);
  });

  it('preço que mudou desde que a aba abriu volta com o valor NOVO', async () => {
    // O cliente pôs no carrinho por R$ 240,00 e foi almoçar.
    const antes = await cotar([{ productId: jaqueta, quantity: 1 }]);
    expect(antes.body.itens[0].priceCents).toBe(24_000);

    getConnection()
      .prepare('UPDATE core_products SET price_cents = 32000 WHERE id = ?')
      .run(jaqueta);

    const depois = await cotar([{ productId: jaqueta, quantity: 1 }]);
    // É este número que o checkout vai cobrar — e é este que a tela tem de
    // mostrar ANTES de o cliente clicar em finalizar.
    expect(depois.body.itens[0].priceCents).toBe(32_000);
  });

  it('e o total da loja é somado com o preço novo', async () => {
    getConnection()
      .prepare('UPDATE core_products SET price_cents = 32000 WHERE id = ?')
      .run(jaqueta);

    const res = await cotar([{ productId: jaqueta, quantity: 2 }]);
    expect(res.body.lojas[0].itemsCents).toBe(64_000);
  });

  it('o disponível também é o de agora — o que vendeu no intervalo sai da conta', async () => {
    getConnection()
      .prepare('UPDATE core_stock SET quantity = 1 WHERE company_id = ? AND product_id = ?')
      .run(companyId, jaqueta);

    const res = await cotar([{ productId: jaqueta, quantity: 3 }]);
    expect(res.body.itens[0].available).toBe(1);
  });
});

// ============================================================================

describe('duas lojas: cada item sabe de quem é', () => {
  it('o item volta com a empresa dele, para a tela agrupar sem adivinhar', async () => {
    const outra = await loginForTest(app, {
      userId: 'gerente-mimei',
      companyId: 'me-mimei',
      profileCodes: ['gerente_loja'],
    });
    const idOutra = outra.body.company.id as string;
    const agora = new Date().toISOString();
    void agora;
    getConnection()
      .prepare(
        `INSERT INTO core_storefront_settings (company_id, updated_at) VALUES (?, ?)`,
      )
      .run(idOutra, agora);
    const kitId = publicar(idOutra, 'Kit Skincare', 12_900, 4);

    const res = await cotar([
      { productId: jaqueta, quantity: 1 },
      { productId: kitId, quantity: 1 },
    ]);

    expect(res.body.itens).toHaveLength(2);
    const kit = res.body.itens.find((i: { productId: string }) => i.productId === kitId);
    expect(kit.companyId).toBe(idOutra);
    expect(kit.priceCents).toBe(12_900);
  });
});
