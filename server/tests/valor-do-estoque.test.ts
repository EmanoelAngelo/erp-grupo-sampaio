/**
 * QUANTO VALE O MEU ESTOQUE — a pergunta de fechamento que nada respondia.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * Nenhuma tela nem rota somava saldo × custo. O dado bruto sempre esteve
 * pronto (`GET /core/stock` traz `cost_cents` por item), mas a agregação não
 * existia em lugar nenhum — o stub de BI que prometia `inventoryValueCents`
 * foi removido justamente por responder zero hardcoded. Quem precisava do
 * número para fechamento ou seguro exportava a lista e somava fora do sistema.
 *
 * ============================================================================
 * A DECISÃO DE DESENHO, declarada
 * ============================================================================
 *
 * O custo usado é o DO CADASTRO (`core_products.cost_cents` de agora), e não
 * um custo médio ponderado. Custo médio exigiria reconstruir o histórico de
 * entradas — que nem sempre tem custo preenchido — e produziria um número com
 * cara de contabilidade sem sê-lo. O valor aqui responde "quanto custaria
 * repor a prateleira hoje, pelo último custo conhecido", e a tela diz isso em
 * palavras.
 *
 * DINHEIRO É CENTAVO INTEIRO. Quantidade pode ser fracionada (0,5 kg), custo
 * é inteiro; o produto dos dois arredonda POR ITEM, e o total é a soma dos
 * itens já arredondados — assim o rodapé bate com a soma da coluna, sempre.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-valor',
    companyId: 'loja-valor',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

function produtoComSaldo(
  nome: string,
  costCents: number,
  quantidade: number,
  empresa = companyId,
): string {
  const id = createProduct(empresa, { name: nome, priceCents: 9_999, costCents }).id;
  if (quantidade > 0) {
    applyMovement({
      companyId: empresa,
      productId: id,
      movementType: 'in',
      quantity: quantidade,
      referenceType: 'entrada',
      referenceId: `carga-${id}`,
    });
  }
  return id;
}

describe('GET /core/stock/valuation — o total da empresa', () => {
  it('soma saldo × custo do cadastro, em centavos INTEIROS', async () => {
    // 3 × 1.099 = 3.297; 0,5 × 333 = 166,5 → arredonda para 167 no ITEM.
    produtoComSaldo('Óleo 20W50', 1_099, 3);
    produtoComSaldo('Queijo por kg', 333, 0.5);

    const res = await request(app).get('/api/v1/core/stock/valuation').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(3_297 + 167);
    expect(Number.isInteger(res.body.totalCents)).toBe(true);
  });

  it('produto sem saldo e produto sem custo entram com zero — e não derrubam a soma', async () => {
    produtoComSaldo('Sem saldo', 5_000, 0);
    produtoComSaldo('Sem custo', 0, 10);
    produtoComSaldo('Normal', 250, 4); // 1.000

    const res = await request(app).get('/api/v1/core/stock/valuation').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(1_000);
    // Só quem tem saldo conta como produto valorado — é o número que o gestor
    // confere contra a prateleira, não contra o catálogo.
    expect(res.body.produtosComSaldo).toBe(2);
  });

  it('cada empresa vê SÓ o próprio estoque — o tenant vem do token, nunca da consulta', async () => {
    produtoComSaldo('Da loja A', 1_000, 5); // 5.000 na empresa do token

    const outra = await loginForTest(app, {
      userId: 'gerente-da-b',
      companyId: 'loja-valor-b',
      profileCodes: ['gerente_loja'],
    });
    produtoComSaldo('Da loja B', 7_777, 2, outra.body.company.id as string);

    const daA = await request(app).get('/api/v1/core/stock/valuation').set(auth);
    const daB = await request(app)
      .get('/api/v1/core/stock/valuation')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });

    expect(daA.body.totalCents).toBe(5_000);
    expect(daB.body.totalCents).toBe(15_554);
  });

  it('o mecânico não alcança — custo de compra não é assunto da bancada', async () => {
    const mecanico = await loginForTest(app, {
      userId: 'mecanico-valor',
      companyId: 'loja-valor',
      profileCodes: ['mecanico'],
    });
    const res = await request(app)
      .get('/api/v1/core/stock/valuation')
      .set({ Authorization: `Bearer ${mecanico.body.accessToken}` });
    expect(res.status).toBe(403);
  });
});

describe('a posição de estoque carrega o valor POR PRODUTO', () => {
  it('cada linha traz value_cents = saldo × custo, arredondado no servidor', async () => {
    /*
      A conta mora no servidor de propósito: se cada tela multiplicasse
      quantity × cost_cents por conta própria, o arredondamento de quantidade
      fracionada divergiria entre a linha e o rodapé — e as duas estariam
      "certas".
    */
    produtoComSaldo('Queijo por kg', 333, 0.5);

    const res = await request(app).get('/api/v1/core/stock').set(auth);

    expect(res.status).toBe(200);
    const item = (res.body.items as { name: string; value_cents: number }[]).find(
      (i) => i.name === 'Queijo por kg',
    );
    expect(item?.value_cents).toBe(167);
  });
});
