/**
 * A TABELA DE PREÇO PASSA A VALER — e o que cada caso aqui quebra sem o guarda.
 *
 * O cadastro de tabela de preço existia inteiro: tela, percentual, exceção por
 * item, texto explicando a regra. E não era lido por ninguém. `priceInTable`
 * tinha ZERO chamadores e não havia elo cliente -> tabela. O dono atende
 * revendedor e atacado com desconto combinado, feito à mão, digitando desconto
 * em cada venda.
 *
 * Digitar o desconto tem uma consequência que ninguém associa à causa: em
 * `SalesService`, o teto do item, o bruto da linha e o rebaixamento saem TODOS
 * de `priceCents`. Desconto por fora é CONCESSÃO — e o revendedor com 15%
 * combinado estourava a alçada de 10% em TODA compra. O balcão travava em toda
 * venda de atacado, e o contorno era chamar o gerente a cada cliente.
 *
 * Com o preço da tabela DENTRO do vigente, o combinado entra no DENOMINADOR e
 * o numerador da concessão fica zero. É esse o caso que decide a rodada, e ele
 * é o `describe` do meio.
 *
 * COMO CADA CASO FALHA — cada linha abaixo foi executada de propósito, e o
 * número entre parênteses é quantos casos deste arquivo ficaram vermelhos:
 *
 *   - tirando `priceTableId` da chamada de `effectivePriceCents` em
 *     `SalesService` (7): o revendedor volta a conceder 20% e a venda dele é
 *     recusada com 403 — o bloco 2 inteiro cai, junto com a fotografia e o
 *     cadastro que nasce com a tabela;
 *   - calculando a tabela sobre `best` em vez de sobre a base (2): promoção e
 *     tabela empilham e o capacete sai por R$ 144,00 onde deveria sair por
 *     R$ 160,00;
 *   - tirando a saída antecipada de `openPrice` (1): a mão de obra passa a
 *     responder `fonte: 'cadastro'` na rota, e é essa resposta que manda a tela
 *     reprecificar a linha — que é como o valor digitado pelo atendente vira
 *     zero, já que o cadastro dela vale zero. A VENDA continua certa mesmo
 *     assim, porque lá o preço aberto já tinha guarda própria; o que quebra é
 *     o contrato com a tela, e é ele que este caso protege;
 *   - tirando `recusarSeTemCliente` de `deletePriceTable` e de
 *     `upsertPriceTable` (2): a desativação passa em silêncio (201) e a
 *     exclusão estoura 500 na chave estrangeira — o gerente recebe "erro
 *     interno" no lugar da frase que diz quantos clientes dependem da tabela;
 *   - gravando nulo no lugar da fotografia (2): a venda deixa de saber sob qual
 *     condição foi cobrada. É o mesmo vermelho que um LEFT JOIN na consulta
 *     daria no caso da tabela editada depois — ali o valor lido passaria a ser
 *     o de hoje (5%) em vez do que foi cobrado (15%).
 *
 * Nenhum caso procura texto de código: todos executam venda, documento e rota
 * de verdade e conferem o que ficou no banco ou o que a rota devolveu.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';
import {
  listPriceTables,
  priceTableForCustomer,
  setPriceTableItem,
  upsertPriceTable,
} from '../src/services/core/CatalogAuxService.js';
import { createQuote } from '../src/services/core/QuoteService.js';

const LOJA = 'loja-tabela';

/** R$ 200,00 — o capacete que o revendedor compra às dúzias. */
const CAPACETE = 20_000;
/** R$ 50,00 — o item pequeno, para os casos de promoção. */
const OLEO = 5_000;

const app = createApp();

function produto(
  id: string,
  nome: string,
  precoCents: number,
  extras: { categoria?: string; precoAberto?: boolean } = {},
): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      LOJA,
      id,
      nome,
      precoCents,
      extras.categoria ?? 'Geral',
      extras.precoAberto ? 1 : 0,
      agora,
      agora,
    );
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 500, 0, ?)',
    )
    .run(LOJA, id, agora);
}

/** Cliente do balcão, com ou sem tabela. */
function cliente(nome: string, priceTableId: string | null = null): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, active, price_table_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, LOJA, nome, priceTableId, agora, agora);
  return id;
}

/** Promoção vigente agora, por produto ou por categoria. */
function promocao(percentOff: number, alvo: { productId?: string; category?: string }): void {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, percent_off, price_cents,
          active, starts_at, ends_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, NULL, ?)`,
    )
    .run(
      randomUUID(),
      LOJA,
      alvo.productId ?? null,
      alvo.category ?? null,
      percentOff,
      '2000-01-01T00:00:00.000Z',
      new Date().toISOString(),
    );
}

/** Tabela de preço criada pelo serviço, como a tela cria. */
function tabela(nome: string, percentOff: number): string {
  return upsertPriceTable(LOJA, { name: nome, percentOff }).id;
}

/** O operador do caixa: nenhuma alçada para liberar nada. */
async function caixa(): Promise<string> {
  const res = await loginForTest(app, {
    userId: 'caixa',
    companyId: LOJA,
    profileCodes: ['operador_caixa_loja'],
  });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Quem tem alçada, e é o único que mexe em tabela e em vínculo de cliente. */
async function gerente(): Promise<string> {
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Uma venda pela PORTA DA FRENTE, com o token de quem não pode liberar nada. */
function vender(token: string, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/sales')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

function linhaDaVenda(saleId: string): {
  price_table_name: string | null;
  price_table_percent_off: number | null;
} {
  return getConnection()
    .prepare('SELECT price_table_name, price_table_percent_off FROM core_sales WHERE id = ?')
    .get(saleId) as never;
}

/**
 * A CONCESSÃO MEDIDA NA VENDA QUE PASSOU.
 *
 * Ela não vem no corpo da resposta — a rota devolve a venda —, e vem no rastro
 * de auditoria de propósito: é a venda que PASSOU que o dono precisa poder
 * revisar depois, para descobrir que um operador dá 9,9% todos os dias. Ler
 * dali é ler o mesmo número que ele lê.
 */
function concessaoDaVenda(saleId: string): {
  brutoCents: number;
  concedidoCents: number;
  percentual: number;
  origens: { cabecalho: number; itens: number; precoRebaixado: number };
} {
  const linha = getConnection()
    .prepare(
      "SELECT detail FROM core_audit_log WHERE action = 'sale.create' AND entity_id = ?",
    )
    .get(saleId) as { detail: string } | undefined;
  if (!linha) throw new Error(`sem rastro de auditoria para a venda ${saleId}`);
  return JSON.parse(linha.detail).concessao;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  await caixa();
  await gerente();
  produto('p-capacete', 'Capacete Integral', CAPACETE);
  produto('p-oleo', 'Óleo 1L', OLEO);
  produto('p-mao-de-obra', 'Mão de obra', 0, { precoAberto: true });
});

/* ========================================================================== */
/* BLOCO 1 — O PREÇO DA TABELA VIRA O PREÇO VIGENTE                           */
/* ========================================================================== */

describe('o preço da tabela é um candidato a preço vigente, calculado sobre a base', () => {
  it('sem tabela, nada muda: o preço é o do cadastro e a fonte diz isso', () => {
    const vigente = effectivePriceCents(LOJA, 'p-capacete', CAPACETE, 'Geral');
    expect(vigente.priceCents).toBe(CAPACETE);
    expect(vigente.onSale).toBe(false);
    expect(vigente.fonte).toBe('cadastro');
  });

  it('com a tabela do revendedor, o vigente É o preço combinado', () => {
    const atacado = tabela('Atacado', 15);
    const vigente = effectivePriceCents(LOJA, 'p-capacete', CAPACETE, 'Geral', {
      priceTableId: atacado,
    });
    expect(vigente.priceCents).toBe(17_000);
    expect(vigente.fonte).toBe('tabela');
    // `onSale` continua significando "abaixo do cadastro" — quem precisa saber
    // que a razão é a tabela, e não uma promoção pública, lê `fonte`.
    expect(vigente.onSale).toBe(true);
  });

  it('PROMOÇÃO E TABELA NÃO EMPILHAM: 20% com 10% dá 20%, e não 28%', () => {
    /*
      O caso que a rodada existe para não deixar acontecer. Empilhar não dá
      erro, não aparece em relatório nenhum e ninguém revisa: é erosão de
      margem invisível. Os dois candidatos saem da MESMA base.
    */
    const varejo = tabela('Revenda', 10);
    promocao(20, { productId: 'p-capacete' });

    const vigente = effectivePriceCents(LOJA, 'p-capacete', CAPACETE, 'Geral', {
      priceTableId: varejo,
    });

    expect(vigente.priceCents).toBe(16_000); // 20% sobre 20.000
    expect(vigente.priceCents).not.toBe(14_400); // 20% e depois 10%
    expect(vigente.fonte).toBe('promocao');
  });

  it('vence o MENOR: com promoção de 5% e tabela de 15%, ganha a tabela', () => {
    const atacado = tabela('Atacado', 15);
    promocao(5, { category: 'Geral' });

    const vigente = effectivePriceCents(LOJA, 'p-capacete', CAPACETE, 'Geral', {
      priceTableId: atacado,
    });

    expect(vigente.priceCents).toBe(17_000);
    expect(vigente.fonte).toBe('tabela');
  });

  it('a exceção por item da tabela continua ganhando do percentual geral', () => {
    const atacado = tabela('Atacado', 15);
    setPriceTableItem(LOJA, atacado, 'p-capacete', 12_000);

    const vigente = effectivePriceCents(LOJA, 'p-capacete', CAPACETE, 'Geral', {
      priceTableId: atacado,
    });
    expect(vigente.priceCents).toBe(12_000);
    expect(vigente.fonte).toBe('tabela');
  });

  it('tabela DESATIVADA não precifica, mesmo com cliente ainda apontando para ela', () => {
    /*
      O estado que este caso monta é o do banco que já rodou: a tabela foi
      desativada quando ninguém a usava, e o vínculo apareceu depois por outra
      porta. O filtro por `active` mora em `priceTableForCustomer` justamente
      para não depender de cada chamador lembrar dele — se ficasse em cada um,
      bastaria um esquecer para a tabela desativada continuar dando desconto.
    */
    const antiga = tabela('Promo Antiga', 15);
    upsertPriceTable(LOJA, { id: antiga, name: 'Promo Antiga', percentOff: 15, active: false });
    const revendedor = cliente('Revenda Silva', antiga);

    expect(priceTableForCustomer(LOJA, revendedor)).toBeNull();

    // E o vínculo continua no cadastro — o que mudou foi o efeito, não o dado.
    const linha = getConnection()
      .prepare('SELECT price_table_id FROM core_customers WHERE id = ?')
      .get(revendedor) as { price_table_id: string | null };
    expect(linha.price_table_id).toBe(antiga);
  });
});

/* ========================================================================== */
/* BLOCO 2 — A CONCESSÃO DO REVENDEDOR SE RESOLVE SOZINHA                     */
/*                                                                            */
/* É o teste que mais importa da rodada.                                      */
/* ========================================================================== */

describe('o revendedor fecha a venda sem chamar gestor', () => {
  let atacado: string;
  let revendedor: string;

  beforeEach(() => {
    // 15% combinado, contra uma alçada de 10%. Antes desta rodada, este par de
    // números sozinho parava o balcão em toda venda de atacado.
    atacado = tabela('Atacado', 15);
    revendedor = cliente('Revenda Silva', atacado);
  });

  it('O CASO QUE DECIDE A RODADA: 15% combinado com teto de 10%, e a venda fecha', async () => {
    const token = await caixa();

    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 17_000 }],
    });

    expect(res.status).toBe(201);
    // O cliente paga o combinado, sem ninguém ter digitado desconto nenhum.
    expect(res.body.total_cents).toBe(17_000);
    // E a alçada mede ZERO: o desconto do revendedor está no DENOMINADOR.
    const concessao = concessaoDaVenda(String(res.body.id));
    expect(concessao.brutoCents).toBe(17_000);
    expect(concessao.concedidoCents).toBe(0);
    expect(concessao.percentual).toBe(0);
    expect(concessao.origens.precoRebaixado).toBe(0);
  });

  it('com 5% A MAIS do operador, a concessão medida é 5% — e não 20%', async () => {
    const token = await caixa();

    // O operador tira mais 5% sobre o preço de revenda: 17.000 -> 16.150.
    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1, unitPriceCents: 16_150 }],
      payments: [{ method: 'dinheiro', amountCents: 16_150 }],
    });

    expect(res.status).toBe(201);
    const concessao = concessaoDaVenda(String(res.body.id));
    expect(concessao.brutoCents).toBe(17_000);
    expect(concessao.concedidoCents).toBe(850);
    // 5%, que é o que o operador de fato concedeu. Os 15% do revendedor não
    // são concessão de ninguém: são a condição combinada com a loja.
    expect(concessao.percentual).toBe(5);
    expect(concessao.percentual).not.toBe(19.25);
  });

  it('O MESMO PREÇO para quem NÃO é revendedor é recusado: a tabela é que muda a conta', async () => {
    const token = await caixa();
    const balcao = cliente('João da Esquina');

    const res = await vender(token, {
      customerId: balcao,
      items: [{ productId: 'p-capacete', quantity: 1, unitPriceCents: 16_150 }],
      payments: [{ method: 'dinheiro', amountCents: 16_150 }],
    });

    // Mesmo carrinho, mesmo preço digitado, mesmo operador. O que muda é o
    // cliente — e sem tabela o rebaixamento inteiro volta a ser concessão.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.details.brutoCents).toBe(CAPACETE);
    expect(res.body.error.details.concedidoCents).toBe(3_850);
    expect(res.body.error.details.percentual).toBe(19.25);
  });

  it('a alçada NÃO afrouxou: 20% ALÉM da tabela continuam pedindo gestor', async () => {
    const token = await caixa();

    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1, unitPriceCents: 13_600 }],
      payments: [{ method: 'dinheiro', amountCents: 13_600 }],
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // 3.400 sobre 17.000 = 20%, medidos sobre o preço de revenda.
    expect(res.body.error.details.brutoCents).toBe(17_000);
    expect(res.body.error.details.percentual).toBe(20);
  });

  it('o teto do item passa a ser o preço de revenda: cobrar o cheio é recusado', async () => {
    const token = await caixa();

    // O PDV manda o preço de cadastro (é o que ele tinha na tela antes de
    // saber do cliente). O servidor não deixa cobrar acima do vigente.
    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1, unitPriceCents: CAPACETE }],
      payments: [{ method: 'dinheiro', amountCents: 17_000 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.total_cents).toBe(17_000);
  });
});

/* ========================================================================== */
/* BLOCO 3 — A MEMÓRIA: FOTOGRAFIA NA VENDA, CONDIÇÃO NO DOCUMENTO            */
/* ========================================================================== */

describe('a venda guarda a condição sob a qual foi cobrada', () => {
  it('nome e percentual ficam gravados na venda, e a rota os devolve', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 17_000 }],
    });
    expect(res.status).toBe(201);

    const detalhe = await request(app)
      .get(`/api/v1/core/sales/${res.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.price_table_name).toBe('Atacado');
    expect(detalhe.body.price_table_percent_off).toBe(15);
  });

  it('EDITAR A TABELA DEPOIS NÃO REESCREVE A VENDA DE ONTEM', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 17_000 }],
    });
    expect(res.status).toBe(201);

    // O dono renegocia: a mesma tabela passa a dar 5%.
    upsertPriceTable(LOJA, { id: atacado, name: 'Atacado', percentOff: 5 });

    // A venda de ontem continua contando a mesma história. Com LEFT JOIN na
    // consulta, o mesmo cupom reimpresso diria 5% — e não haveria como saber
    // qual dos dois números foi cobrado.
    const gravado = linhaDaVenda(String(res.body.id));
    expect(gravado.price_table_name).toBe('Atacado');
    expect(gravado.price_table_percent_off).toBe(15);
    expect(Number(res.body.total_cents)).toBe(17_000);
  });

  it('venda sem cliente grava nulo, que é a verdade sobre ela', async () => {
    const token = await caixa();
    const res = await vender(token, {
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: OLEO }],
    });
    expect(res.status).toBe(201);

    const gravado = linhaDaVenda(String(res.body.id));
    expect(gravado.price_table_name).toBeNull();
    expect(gravado.price_table_percent_off).toBeNull();
  });

  it('o ORÇAMENTO sai pelo preço de revenda e guarda de qual tabela falava', () => {
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const doc = createQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      kind: 'orcamento',
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 2 }],
      alcada: { profileCodes: ['operador_caixa_loja'] },
    });

    // O papel entregue ao cliente já sai com o preço dele — sem ninguém
    // digitar desconto, e por isso sem pedir gestor.
    expect(doc.total_cents).toBe(34_000);

    const linha = getConnection()
      .prepare('SELECT price_table_id, price_table_percent_off, concession_cents FROM core_quotes WHERE id = ?')
      .get(doc.id) as {
      price_table_id: string | null;
      price_table_percent_off: number | null;
      concession_cents: number | null;
    };
    expect(linha.price_table_id).toBe(atacado);
    expect(linha.price_table_percent_off).toBe(15);
    expect(linha.concession_cents).toBe(0);
  });
});

/* ========================================================================== */
/* BLOCO 4 — PREÇO ABERTO FICA DE FORA, DOS DOIS LADOS                        */
/* ========================================================================== */

describe('mão de obra não é reprecificada por tabela nenhuma', () => {
  it('a rota devolve fonte "aberto" e o valor do cadastro, para a tela não mexer', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await request(app)
      .post('/api/v1/core/pricing/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerId: revendedor,
        items: [
          { productId: 'p-capacete', quantity: 1 },
          { productId: 'p-mao-de-obra', quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    const porProduto = Object.fromEntries(
      (res.body.items as { productId: string; fonte: string; priceCents: number }[]).map((i) => [
        i.productId,
        i,
      ]),
    );
    expect(porProduto['p-capacete'].fonte).toBe('tabela');
    expect(porProduto['p-capacete'].priceCents).toBe(17_000);
    // A decisão de NÃO reprecificar sai daqui, do servidor. A tela obedece —
    // e é por isso que ela não zera a linha de mão de obra ao escolher o
    // cliente, que é o que aconteceria: o cadastro dela vale zero.
    expect(porProduto['p-mao-de-obra'].fonte).toBe('aberto');
    expect(porProduto['p-mao-de-obra'].priceCents).toBe(0);
  });

  it('a OS do revendedor cobra a mão de obra combinada, e isso não é concessão', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await vender(token, {
      customerId: revendedor,
      items: [{ productId: 'p-mao-de-obra', quantity: 1, unitPriceCents: 15_000 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.total_cents).toBe(15_000);
    // Nem rebaixamento (o cadastro é sugestão, não teto) nem desconto de
    // tabela: o valor nasceu na conversa e é o bruto dele mesmo.
    const concessao = concessaoDaVenda(String(res.body.id));
    expect(concessao.brutoCents).toBe(15_000);
    expect(concessao.concedidoCents).toBe(0);
  });
});

/* ========================================================================== */
/* BLOCO 5 — A TABELA EM USO NÃO SOME                                         */
/* ========================================================================== */

describe('tabela com cliente vinculado não é apagada nem desativada', () => {
  it('EXCLUIR recusa com 409 e diz QUANTOS clientes usam', async () => {
    const token = await gerente();
    const atacado = tabela('Atacado', 15);
    cliente('Revenda Silva', atacado);
    cliente('Moto Peças ME', atacado);

    const res = await request(app)
      .delete(`/api/v1/core/catalog/price-tables/${atacado}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRICE_TABLE_IN_USE');
    expect(res.body.error.details.customers).toBe(2);
    // O número está na mensagem porque é ele que diz o tamanho do trabalho
    // que o gerente teria de fazer antes.
    expect(res.body.error.message).toContain('2');

    // E a tabela continua lá.
    expect(listPriceTables(LOJA)).toHaveLength(1);
  });

  it('DESATIVAR é a porta ao lado, e é recusada pela mesma conta', async () => {
    const token = await gerente();
    const atacado = tabela('Atacado', 15);
    cliente('Revenda Silva', atacado);

    const res = await request(app)
      .post('/api/v1/core/catalog/price-tables')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: atacado, name: 'Atacado', percentOff: 15, active: false });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRICE_TABLE_IN_USE');
    expect(res.body.error.details.customers).toBe(1);

    // Continua ativa: a recusa acontece ANTES do UPDATE, não depois.
    const salva = listPriceTables(LOJA)[0];
    expect(salva.active).toBe(1);
    expect(salva.customers).toBe(1);
  });

  it('sem cliente vinculado, apagar e desativar continuam funcionando', async () => {
    const token = await gerente();
    const semUso = tabela('Promo Antiga', 5);

    const desativar = await request(app)
      .post('/api/v1/core/catalog/price-tables')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: semUso, name: 'Promo Antiga', percentOff: 5, active: false });
    expect(desativar.status).toBe(201);
    expect(desativar.body.active).toBe(0);

    // Salvar de novo uma tabela JÁ inativa não é recusado: o que se barra é o
    // ato de tirar do ar, não a existência de uma tabela desativada. Sem isso
    // seria impossível corrigir o nome de uma tabela antiga.
    const reeditar = await request(app)
      .post('/api/v1/core/catalog/price-tables')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: semUso, name: 'Promo Antiga', percentOff: 7, active: false });
    expect(reeditar.status).toBe(201);
    expect(reeditar.body.percent_off).toBe(7);

    const apagar = await request(app)
      .delete(`/api/v1/core/catalog/price-tables/${semUso}`)
      .set('Authorization', `Bearer ${token}`);
    expect(apagar.status).toBe(200);
    expect(apagar.body.priceTables).toHaveLength(0);
  });

  it('a lista de tabelas diz quantos clientes usam cada uma', async () => {
    const token = await gerente();
    const atacado = tabela('Atacado', 15);
    tabela('Revenda', 8);
    cliente('Revenda Silva', atacado);

    const res = await request(app)
      .get('/api/v1/core/catalog/aux')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const porNome = Object.fromEntries(
      (res.body.priceTables as { name: string; customers: number }[]).map((t) => [t.name, t]),
    );
    expect(porNome['Atacado'].customers).toBe(1);
    expect(porNome['Revenda'].customers).toBe(0);
  });
});

/* ========================================================================== */
/* BLOCO 6 — A ROTA DA REPRECIFICAÇÃO E O ELO CLIENTE -> TABELA               */
/* ========================================================================== */

describe('POST /core/pricing/cart: nenhuma regra de preço nasce no navegador', () => {
  it('devolve o preço de cada produto e a condição do cliente', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await request(app)
      .post('/api/v1/core/pricing/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerId: revendedor,
        items: [
          { productId: 'p-capacete', quantity: 3 },
          { productId: 'p-oleo', quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.priceTable).toEqual({ id: atacado, name: 'Atacado', percentOff: 15 });
    expect(res.body.items).toEqual([
      {
        productId: 'p-capacete',
        priceCents: 17_000,
        listPriceCents: CAPACETE,
        onSale: true,
        fonte: 'tabela',
      },
      {
        productId: 'p-oleo',
        priceCents: 4_250,
        listPriceCents: OLEO,
        onSale: true,
        fonte: 'tabela',
      },
    ]);
  });

  it('sem cliente, devolve os preços normais e priceTable nulo', async () => {
    const token = await caixa();
    tabela('Atacado', 15);

    const res = await request(app)
      .post('/api/v1/core/pricing/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: null, items: [{ productId: 'p-capacete', quantity: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.priceTable).toBeNull();
    expect(res.body.items[0].priceCents).toBe(CAPACETE);
    expect(res.body.items[0].fonte).toBe('cadastro');
  });

  it('produto inativo ou inexistente sai da resposta e não derruba o resto', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await request(app)
      .post('/api/v1/core/pricing/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerId: revendedor,
        items: [
          { productId: 'p-que-nao-existe', quantity: 1 },
          { productId: 'p-capacete', quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe('p-capacete');
  });

  it('carrinho vazio com cliente devolve só a condição, para a tela anunciá-la', async () => {
    const token = await caixa();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await request(app)
      .post('/api/v1/core/pricing/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: revendedor });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.priceTable.name).toBe('Atacado');
  });
});

describe('onde se liga o cliente à tabela', () => {
  it('o cadastro nasce com a tabela, e a venda seguinte já sai pelo preço dela', async () => {
    const gerenteToken = await gerente();
    const caixaToken = await caixa();
    const atacado = tabela('Atacado', 15);

    const criado = await request(app)
      .post('/api/v1/core/customers')
      .set('Authorization', `Bearer ${gerenteToken}`)
      .send({ name: 'Revenda Silva', priceTableId: atacado });
    expect(criado.status).toBe(201);
    expect(criado.body.price_table_id).toBe(atacado);

    const venda = await vender(caixaToken, {
      customerId: criado.body.id,
      items: [{ productId: 'p-capacete', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 17_000 }],
    });
    expect(venda.status).toBe(201);
    expect(venda.body.total_cents).toBe(17_000);
  });

  it('trocar a tabela de um cliente que já existe deixa rastro com o id novo', async () => {
    const token = await gerente();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva');

    const res = await request(app)
      .put(`/api/v1/core/customers/${revendedor}/price-table`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priceTableId: atacado });

    expect(res.status).toBe(200);
    expect(res.body.price_table_id).toBe(atacado);

    const rastro = getConnection()
      .prepare('SELECT detail FROM core_audit_log WHERE company_id = ? AND action = ?')
      .all(LOJA, 'customer.price_table') as { detail: string }[];
    expect(rastro).toHaveLength(1);
    expect(JSON.parse(rastro[0].detail)).toEqual({ priceTableId: atacado });
  });

  it('desfazer o vínculo devolve o cliente ao preço normal', async () => {
    const token = await gerente();
    const atacado = tabela('Atacado', 15);
    const revendedor = cliente('Revenda Silva', atacado);

    const res = await request(app)
      .put(`/api/v1/core/customers/${revendedor}/price-table`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priceTableId: null });

    expect(res.status).toBe(200);
    expect(res.body.price_table_id).toBeNull();

    const caixaToken = await caixa();
    const venda = await vender(caixaToken, {
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: CAPACETE }],
    });
    expect(venda.status).toBe(201);
    expect(venda.body.total_cents).toBe(CAPACETE);
  });

  it('vincular a uma tabela DESATIVADA é recusado: o vínculo não teria efeito', async () => {
    const token = await gerente();
    const antiga = tabela('Promo Antiga', 5);
    upsertPriceTable(LOJA, { id: antiga, name: 'Promo Antiga', percentOff: 5, active: false });
    const alguem = cliente('João da Esquina');

    const res = await request(app)
      .put(`/api/v1/core/customers/${alguem}/price-table`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priceTableId: antiga });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRICE_TABLE_NOT_FOUND');
  });
});

/* ========================================================================== */
/* BLOCO 7 — A COLUNA NOVA CHEGA AO BANCO QUE JÁ RODA NA LOJA                 */
/* ========================================================================== */

describe('a migração 59', () => {
  /** As cinco colunas desta rodada, e onde cada uma mora. */
  const NOVAS: [string, string][] = [
    ['core_customers', 'price_table_id'],
    ['core_sales', 'price_table_name'],
    ['core_sales', 'price_table_percent_off'],
    ['core_quotes', 'price_table_id'],
    ['core_quotes', 'price_table_percent_off'],
  ];

  function colunas(tabela: string): Set<string> {
    return new Set(
      (getConnection().prepare(`PRAGMA table_info(${tabela})`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
  }

  it('leva as cinco colunas a um banco que está na versão 58', () => {
    const db = getConnection();

    // Marca tudo até 58 como já aplicado e desfaz o trabalho do 59: é
    // exatamente o estado do banco que roda na loja hoje.
    for (let passo = 2; passo <= 58; passo += 1) {
      db.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, 'applied')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`core_migration_step_${passo}`);
    }
    db.prepare('DELETE FROM core_meta WHERE key = ?').run('core_migration_step_59');
    for (const [tabela, coluna] of NOVAS) {
      db.exec(`ALTER TABLE ${tabela} DROP COLUMN ${coluna};`);
      expect(colunas(tabela).has(coluna)).toBe(false);
    }

    migrateCoreSchema();

    for (const [tabela, coluna] of NOVAS) {
      expect(colunas(tabela).has(coluna)).toBe(true);
    }
  });

  it('o passo 65 cria email_verified_at num banco que está na versão 64', () => {
    /*
      O passo 65 (rodada 50) é um `addColumn` puro — e `addColumn` devolve
      cedo se a coluna já existe. Num banco NOVO, `ensureCoreSchema` já a cria
      pela DDL canônica, então o passo é no-op e nenhum teste de banco novo o
      exercita: apagar o `addColumn` passaria a suíte inteira e só quebraria
      em produção (banco v64) com "no such column" na verificação de e-mail.
      Este caso reproduz o banco v64 real: coluna derrubada, e o passo 65 a
      recria.
    */
    const db = getConnection();
    for (let passo = 2; passo <= 64; passo += 1) {
      db.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, 'applied')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`core_migration_step_${passo}`);
    }
    db.prepare('DELETE FROM core_meta WHERE key = ?').run('core_migration_step_65');
    db.exec('ALTER TABLE core_customer_accounts DROP COLUMN email_verified_at;');
    expect(colunas('core_customer_accounts').has('email_verified_at')).toBe(false);

    migrateCoreSchema();

    expect(colunas('core_customer_accounts').has('email_verified_at')).toBe(true);
  });

  it('o passo 59 EXISTE e se marca sozinho — sem ele o alvo seria um passo fantasma', () => {
    /*
      A regra do arquivo de migrações: o alvo e o número do ÚLTIMO passo têm de
      ser o mesmo número. Um alvo maior que o último passo cria um passo que
      nunca é marcado, `haPassoPendente` devolve true para sempre, e TODO
      restart do servidor copia o banco inteiro — já aconteceu neste projeto,
      com dez cópias em `server/data/backups`, três delas no mesmo minuto.
    */
    // 68 desde a rodada 53 (o pool de plaquinhas: duas tabelas, a coluna da
    // regra de ouro e a carga a partir dos equipamentos existentes). Antes:
    // 67 na rodada 52 (garantia e montador na máquina; foto e
    // conferência de entrada na OS, com backfill do entered_at). Antes: 66 na
    // rodada 51 (prioridade, prazo e o relógio do SLA); 65 na rodada 50
    // (email_verified_at — o e-mail prova dono). O numero envelhece junto com
    // o arquivo de proposito: quem cria um passo atualiza aqui, ciente.
    /*
      Rodada 54 (passo 69, a marca de quem assina o papel da bancada):
      conferido que o passo so acrescenta `core_workshops.brand_company_id` e
      regrava as duas bancadas oficiais. Nao toca em equipamento, em OS nem
      em tabela de preco — os casos abaixo seguem valendo.
    */
    /*
      Rodada 73 (passo 73, a conversão de unidade na entrada de nota):
      conferido que o passo só acrescenta três colunas NULLABLE a
      `core_inbound_note_items` — unit_trib, quantity_trib e
      conversion_factor. Não reconstrói tabela, não regrava linha, e não
      toca em equipamento, plaquinha, OS, quadro da oficina, marca de
      bancada nem tabela de preço. Os casos abaixo seguem valendo.

      E o passo NASCEU errado, com o alvo ainda em 72: o passo rodava e
      `haPassoPendente` não o via, então a migração entrava sem o snapshot.
      `schema-drift` ganhou o caso que cobra os dois sentidos.
    */
    /*
      Passo 74 (o rastro do item cancelado no carrinho — GAP-V52/V63):
      conferido que o passo só marca a criação de `core_sale_removed_items`
      (tabela NOVA, que o ensureCoreSchema já cria pelo IF NOT EXISTS) e
      garante o índice por venda — o desenho do passo 7. Não reconstrói
      tabela, não regrava linha, e não toca em tabela de preço, equipamento,
      OS nem bancada. Os casos abaixo seguem valendo.
    */
    /*
      Passos 75-77 (rodada dos vídeos): 75 — anexo na fila de e-mail e
      índices do pacote do contador (GAP-V30/V31); 76 — cópia de
      arquivamento do evento fiscal (GAP-V32); 77 — a nota de entrada ganha
      espécie (`doc_type`, entrada manual sem NF-e — GAP-V17) e as colunas
      de estorno (`reversed_at/by/reason` — GAP-V20). Só colunas novas com
      default ou nullable e índices — nenhum toca em tabela de preço,
      equipamento, OS nem bancada. Os casos abaixo seguem valendo.
    */
    /*
      Passo 78 (a liberação diz ONDE foi digitada, e o turno reabre —
      GAP-V61/V64): duas colunas nullable em `core_authorizations`
      (`terminal_id`, `ip`) e cinco em `core_cash_sessions` (a trilha da
      reabertura, com `reopen_count` NOT NULL DEFAULT 0). Só ALTER de coluna
      nova — não reconstrói tabela, não regrava linha e não toca em tabela de
      preço, produto nem venda. Os casos abaixo seguem valendo.
    */
    /*
      Passo 79 (o crédito de loja ganha razão — GAP-V10/V47): `CREATE TABLE IF
      NOT EXISTS core_customer_credits` pela DDL canônica e o índice dela. Não
      reconstrói tabela, não regrava linha e não toca em tabela de preço,
      produto nem venda. Os casos abaixo seguem valendo.
    */
    /*
      Passo 80 (o catálogo ganha serviço, faixa, embalagem, campo próprio, dia
      da semana e IPI — GAP-V01/V08). Este é o primeiro passo desde a rodada da
      tabela de preço que ENCOSTA no assunto deste arquivo, e por isso a
      conferência foi mais longe que "não toca":

        - ALTER de coluna nova em `core_products` (`stock_control`,
          `pack_factor`, `pack_unit`): não reconstrói a tabela e não regrava
          linha nenhuma. `stock_control` nasce 1 em toda linha, que é o
          comportamento de sempre;
        - `core_product_price_tiers` é tabela NOVA e nasce VAZIA. A faixa por
          quantidade é mais um CANDIDATO ao menor preço, e candidato que não
          existe não concorre: sem linha nela, `effectivePriceCents` decide
          exatamente como decidia — e é isso que os casos abaixo cobram.

      Os casos abaixo seguem valendo.
    */
    /*
      Passo 84 (o anexo do e-mail sai da fila e vai para o cofre — GAP-V30,
      conserto): UM ALTER, `core_email_queue.anexo_id`, nullable e sem
      backfill, mais a tabela NOVA `core_email_attachments`, que nasce na DDL
      canônica. Não toca em equipamento, plaquinha, OS nem garantia — os casos
      abaixo seguem valendo, como no passo 83 (`core_sale_items.cost_cents`).
    */
    /*
      Passo 86 (RBAC granular): cinco colunas em `core_user_companies` e o
      escopo de bancada de cada vínculo gravado. Não toca em tabela de preço,
      produto nem venda: os casos abaixo seguem valendo.
    */
    expect(CORE_TARGET_VERSION).toBe(86);
    migrateCoreSchema();

    const pendentes: number[] = [];
    for (let passo = 2; passo <= CORE_TARGET_VERSION; passo += 1) {
      const marca = getConnection()
        .prepare('SELECT value FROM core_meta WHERE key = ?')
        .get(`core_migration_step_${passo}`) as { value?: string } | undefined;
      if (marca?.value !== 'applied') pendentes.push(passo);
    }
    expect(pendentes).toEqual([]);
  });
});
