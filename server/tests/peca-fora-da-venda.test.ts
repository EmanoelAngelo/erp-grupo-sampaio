/**
 * A PEÇA DE BANCADA NÃO CHEGA A UMA VENDA.
 *
 * POR QUE ESTE ARQUIVO GRAVA NO BANCO POR SQL CRU
 *
 * Os guardas do ESCRITOR já existem: `exigirTipoCoerente` recusa publicar uma
 * peça, e `updateProduct` também. Um teste que usasse a API para tentar criar o
 * estado proibido só provaria que o escritor funciona — e passaria mesmo que
 * TODA a filtragem da vitrine fosse apagada, porque o estado nunca chegaria a
 * existir para ser lido.
 *
 * O estado proibido chega ao banco por outros caminhos que não passam pelo
 * escritor: importação de XML, migração de uma base antiga, e o UPDATE feito à
 * mão no SQLite para "resolver rápido" numa sexta-feira. Por isso cada teste
 * daqui grava `kind = 'part'` com `publish_online = 1` por INSERT direto,
 * pulando o escritor de propósito, e cobra que o LEITOR continue não mostrando.
 *
 * É o que faz o teste falhar quando o guarda sai: apague `p.kind <> 'part'` de
 * `PRODUTO_VISIVEL_NA_LOJA` e a peça aparece nas sete leituras.
 *
 * AS SETE LEITURAS DE PRODUTO DA LOJA
 *
 *   1. a contagem de produtos por loja, na home do portal
 *   2. a listagem da vitrine
 *   3. o detalhe público
 *   4. a GRADE do detalhe — a que não filtrava nada além de `active`
 *   5. a lista de categorias
 *   6. a leitura do carrinho na cotação de frete
 *   7. a conferência de cada item no checkout
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  checkout,
  getStorefrontProduct,
  getStorefrontProductDetail,
  listCategories,
  listStorefrontProducts,
  listStorefronts,
} from '../src/services/core/StorefrontService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let empresa: string;
let bancada: string;

/**
 * Grava um produto PULANDO `createProduct` de propósito.
 *
 * `kind` e `workshop_id` entram como vierem: é o INSERT cru que simula a
 * migração antiga e o UPDATE manual, os dois caminhos que o guarda do escritor
 * não alcança.
 */
function inserirProduto(input: {
  id: string;
  nome: string;
  kind?: 'part' | 'retail';
  workshopId?: string | null;
  publicado?: boolean;
  categoria?: string | null;
  parentId?: string | null;
  barcode?: string | null;
  precoCents?: number;
}): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents, category,
          barcode, active, publish_online, kind, workshop_id, parent_id,
          weight_grams, height_cm, width_cm, length_cm, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 1000, ?, ?, ?, 1, ?, ?, ?, ?, 500, 10, 10, 10, ?, ?)`,
    )
    .run(
      input.id,
      empresa,
      `COD-${input.id}`,
      input.nome,
      input.precoCents ?? 25000,
      input.categoria === undefined ? 'Acessórios' : input.categoria,
      input.barcode ?? null,
      input.publicado === false ? 0 : 1,
      input.kind ?? 'retail',
      input.workshopId ?? null,
      input.parentId ?? null,
      agora,
      agora,
    );
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
    )
    .run(empresa, input.id, agora);
  return input.id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = await upsertCompany({
    slug: 'preco-justo-pecas',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });

  bancada = 'wk-celulares';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'celulares', 'Oficina de Celulares', 'phones', 1, ?)`,
    )
    .run(bancada, empresa, new Date().toISOString());
});

describe('vitrine: a peça publicada à força continua invisível', () => {
  beforeEach(() => {
    inserirProduto({ id: 'merc-1', nome: 'Capa de Silicone' });
    // O estado que o escritor recusa e o banco aceita.
    inserirProduto({
      id: 'peca-1',
      nome: 'Bateria Original iPhone 11',
      kind: 'part',
      workshopId: bancada,
      categoria: 'Peças de Reposição',
    });
  });

  it('1. não entra na contagem de produtos da loja no portal', () => {
    const { stores } = listStorefronts();
    const loja = stores.find((s) => s.slug === 'preco-justo-pecas');
    // Duas linhas publicadas no banco, UMA à venda. A contagem é a primeira
    // promessa que a home faz ao cliente sobre o tamanho da loja.
    expect(loja?.productCount).toBe(1);
  });

  it('2. não aparece na listagem da vitrine, nem buscando pelo nome dela', () => {
    const todos = listStorefrontProducts({ storeSlug: 'preco-justo-pecas' }).items;
    expect(todos.map((p) => p.id)).toEqual(['merc-1']);

    const buscando = listStorefrontProducts({ search: 'Bateria' }).items;
    expect(buscando).toHaveLength(0);
  });

  it('3. não existe como produto público', () => {
    expect(getStorefrontProduct('peca-1')).toBeNull();
    expect(getStorefrontProduct('merc-1')).not.toBeNull();
  });

  it('4. não abre a página de detalhe', () => {
    expect(getStorefrontProductDetail('preco-justo-pecas', 'peca-1')).toBeNull();
  });

  it('5. a categoria que só tem peça não vira filtro da loja', () => {
    // Categoria sem nada à venda é uma gaveta que o cliente abre e volta vazio.
    // Desde a rodada 56 o departamento vem em ÁRVORE, com a contagem do que dá
    // para comprar — o que esta regra trava continua sendo a ausência.
    const arvore = listCategories('preco-justo-pecas');
    expect(arvore.map((c) => c.name)).toEqual(['Acessórios']);
    expect(arvore[0].productCount).toBe(1);
  });

  it('6. a cotação de frete do carrinho recusa a peça', async () => {
    const res = await request(app)
      .post('/api/v1/loja/checkout/frete')
      .send({ items: [{ productId: 'peca-1', quantity: 1 }], zip: '69900000' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PRODUCT_NOT_AVAILABLE');
  });

  it('7. o checkout recusa a peça', () => {
    expect(() =>
      checkout({
        idempotencyKey: 'chk-peca-1',
        customerName: 'Cliente Teste',
        paymentMethod: 'pix',
        items: [{ productId: 'peca-1', quantity: 1 }],
      }),
    ).toThrowError(/indisponível/i);
  });

  it('o produto de revenda continua passando pelas sete — a recusa é da peça, não de todo mundo', () => {
    const pedidos = checkout({
      idempotencyKey: 'chk-merc-1',
      customerName: 'Cliente Teste',
      paymentMethod: 'pix',
      items: [{ productId: 'merc-1', quantity: 2 }],
    });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].total_cents).toBe(50000);
  });
});

describe('vitrine: a GRADE do detalhe passa pela mesma porta', () => {
  /*
    Esta era a sétima consulta, e a única que conferia só `active`. A filtragem
    parecia já ter acontecido no produto-pai — não acontece: cada variante é uma
    linha própria, com o próprio `publish_online` e o próprio `kind`.
  */
  beforeEach(() => {
    inserirProduto({ id: 'modelo', nome: 'Fone Bluetooth' });
    inserirProduto({ id: 'var-preto', nome: 'Fone Bluetooth · Preto', parentId: 'modelo' });
    inserirProduto({
      id: 'var-fora',
      nome: 'Fone Bluetooth · Rosa',
      parentId: 'modelo',
      publicado: false,
    });
    inserirProduto({
      id: 'var-peca',
      nome: 'Fone Bluetooth · Alto-falante avulso',
      parentId: 'modelo',
      kind: 'part',
      workshopId: bancada,
    });
  });

  it('a grade mostra só a variante que está à venda', () => {
    const detalhe = getStorefrontProductDetail('preco-justo-pecas', 'modelo');
    expect(detalhe?.variants.map((v) => v.id)).toEqual(['var-preto']);
  });

  it('a variante despublicada some da grade em vez de virar 404 no carrinho', () => {
    // Antes ela era oferecida na página e recusada no checkout: o cliente
    // escolhia a cor, ia pagar e levava "produto indisponível" sem entender.
    const detalhe = getStorefrontProductDetail('preco-justo-pecas', 'modelo');
    expect(detalhe?.variants.some((v) => v.id === 'var-fora')).toBe(false);
    expect(() =>
      checkout({
        idempotencyKey: 'chk-var-fora',
        customerName: 'Cliente Teste',
        paymentMethod: 'pix',
        items: [{ productId: 'var-fora', quantity: 1 }],
      }),
    ).toThrowError(/indisponível/i);
  });
});

describe('locação: peça de bancada não se aluga', () => {
  let auth: { Authorization: string };
  let clienteId: string;
  let empresaDoLogin: string;

  beforeEach(async () => {
    const res = await loginForTest(app, {
      userId: 'ger-locacao-peca',
      companyId: 'loja-locacao-peca',
      profileCodes: ['gerente_loja'],
    });
    auth = { Authorization: `Bearer ${res.body.accessToken}` };
    empresaDoLogin = res.body.company.id;

    // A bancada e as peças precisam ser da MESMA empresa do contrato: o saldo
    // é por empresa, e um contrato só enxerga o estoque de quem tem o CNPJ.
    empresa = empresaDoLogin;
    bancada = 'wk-locacao';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'bancada-loc', 'Oficina de Celulares', 'phones', 1, ?)`,
      )
      .run(bancada, empresa, new Date().toISOString());

    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .send({ name: 'Cliente Locatário', document: '11122233396' });
    clienteId = cliente.body.id;
  });

  it('recusa com CORE_PART_CANNOT_BE_RENTED', async () => {
    inserirProduto({
      id: 'peca-loc',
      nome: 'Tela AMOLED',
      kind: 'part',
      workshopId: bancada,
      publicado: false,
    });

    const res = await request(app)
      .post('/api/v1/core/rentals')
      .set(auth)
      .send({
        customerId: clienteId,
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        items: [{ productId: 'peca-loc', quantity: 1, unitCents: 5000 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PART_CANNOT_BE_RENTED');
  });

  it('o saldo da bancada continua intocado depois da recusa', async () => {
    inserirProduto({
      id: 'peca-loc-2',
      nome: 'Bateria de reposição',
      kind: 'part',
      workshopId: bancada,
      publicado: false,
    });

    await request(app)
      .post('/api/v1/core/rentals')
      .set(auth)
      .send({
        customerId: clienteId,
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        items: [{ productId: 'peca-loc-2', quantity: 1, unitCents: 5000 }],
      });

    // A recusa acontece ANTES da reserva. Reservar e depois recusar deixaria a
    // peça presa fora de qualquer contrato: some do disponível da oficina e
    // nada na tela de peças explica para onde foi.
    const saldo = getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(empresa, 'peca-loc-2') as { quantity: number; reserved: number };
    expect(saldo.reserved).toBe(0);
    expect(saldo.quantity).toBe(10);
  });

  it('mercadoria de revenda continua alugando normalmente', async () => {
    inserirProduto({ id: 'cadeira', nome: 'Cadeira de Plástico', publicado: false });

    const res = await request(app)
      .post('/api/v1/core/rentals')
      .set(auth)
      .send({
        customerId: clienteId,
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        items: [{ productId: 'cadeira', quantity: 3, unitCents: 500 }],
      });

    expect(res.status).toBe(201);
    const saldo = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(empresa, 'cadeira') as { reserved: number };
    expect(saldo.reserved).toBe(3);
  });
});

/**
 * PRÉ-VENDA: A MESMA REGRA DA LOCAÇÃO, PORQUE É O MESMO FATO.
 *
 * A locação recusa peça porque o contrato RESERVA saldo — tira do disponível a
 * bateria que a oficina está contando para terminar um conserto, e nada na
 * tela de peças diz para onde ela foi. A pré-venda reserva pelo MESMO
 * `reserveStock`, e não recusava nada: duas regras para o mesmo fato, e a mais
 * frouxa das duas era a do documento que o balcão abre todo dia.
 *
 * O orçamento fica de fora de propósito, e é isso que o último teste registra:
 * ele não reserva coisa nenhuma, e recusá-lo seria proibir responder quanto
 * custa a tela do celular — a pergunta mais comum do balcão de uma loja com
 * bancada.
 */
describe('pré-venda: peça de bancada não é reservada', () => {
  let auth: { Authorization: string };

  beforeEach(async () => {
    const res = await loginForTest(app, {
      userId: 'caixa-prevenda-peca',
      companyId: 'loja-prevenda-peca',
      profileCodes: ['gerente_loja'],
    });
    auth = { Authorization: `Bearer ${res.body.accessToken}` };
    empresa = res.body.company.id;

    bancada = 'wk-prevenda';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'bancada-pv', 'Oficina de Celulares', 'phones', 1, ?)`,
      )
      .run(bancada, empresa, new Date().toISOString());

    inserirProduto({
      id: 'peca-pv',
      nome: 'Tela AMOLED',
      kind: 'part',
      workshopId: bancada,
      publicado: false,
    });
    inserirProduto({ id: 'merc-pv', nome: 'Película de Vidro', publicado: false });
  });

  function abrir(kind: string, productId: string) {
    return request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({ kind, items: [{ productId, quantity: 1 }] });
  }

  function saldo(productId: string): { quantity: number; reserved: number } {
    return getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(empresa, productId) as { quantity: number; reserved: number };
  }

  it('recusa com CORE_PART_CANNOT_BE_PRE_SOLD, dizendo de que bancada é', async () => {
    const res = await abrir('pre_venda', 'peca-pv');

    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PART_CANNOT_BE_PRE_SOLD');
    // O nome da oficina na frase: "é peça de oficina" não diz a quem perguntar.
    expect(res.body.error?.message ?? '').toContain('Oficina de Celulares');
  });

  it('o saldo da bancada continua intocado depois da recusa', async () => {
    await abrir('pre_venda', 'peca-pv');

    // A recusa vem ANTES da reserva. Reservar e depois recusar deixaria a peça
    // presa fora de qualquer documento — e a pré-venda sem validade nunca
    // expira, então ninguém a soltaria nunca.
    expect(saldo('peca-pv')).toMatchObject({ quantity: 10, reserved: 0 });
  });

  it('o orçamento com a MESMA peça é aceito — ele não segura nada', async () => {
    const res = await abrir('orcamento', 'peca-pv');

    expect(res.status).toBe(201);
    expect(saldo('peca-pv').reserved).toBe(0);
  });

  it('mas aprovar esse orçamento esbarra na mesma recusa, e não em silêncio', async () => {
    const orcamento = await abrir('orcamento', 'peca-pv');

    const promovido = await request(app)
      .post(`/api/v1/core/quotes/${orcamento.body.id}/promote`)
      .set(auth)
      .send({});

    // `promoteToPreSale` reusa `createQuote` justamente para não ter uma
    // segunda cópia da regra: a recusa aparece aqui de graça.
    expect(promovido.status).toBe(409);
    expect(promovido.body.error?.code ?? promovido.body.code).toBe(
      'CORE_PART_CANNOT_BE_PRE_SOLD',
    );
    expect(saldo('peca-pv').reserved).toBe(0);
  });

  it('mercadoria de revenda continua entrando em pré-venda e reservando', async () => {
    const res = await abrir('pre_venda', 'merc-pv');

    expect(res.status).toBe(201);
    expect(saldo('merc-pv').reserved).toBe(1);
  });
});

describe('PDV: a busca por nome esconde a peça, a bipagem acha', () => {
  let auth: { Authorization: string };

  beforeEach(async () => {
    const res = await loginForTest(app, {
      userId: 'caixa-peca',
      companyId: 'loja-pdv-peca',
      profileCodes: ['gerente_loja'],
    });
    auth = { Authorization: `Bearer ${res.body.accessToken}` };
    empresa = res.body.company.id;

    bancada = 'wk-pdv';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'bancada-pdv', 'Oficina de Celulares', 'phones', 1, ?)`,
      )
      .run(bancada, empresa, new Date().toISOString());

    inserirProduto({ id: 'bat-loja', nome: 'Bateria Externa 10000mAh', barcode: '7890000000017' });
    inserirProduto({
      id: 'bat-peca',
      nome: 'Bateria Original iPhone 11',
      kind: 'part',
      workshopId: bancada,
      publicado: false,
      barcode: '7890000000024',
    });
  });

  async function buscar(q: string, extra = ''): Promise<Record<string, unknown>[]> {
    const res = await request(app)
      .get(`/api/v1/core/products/search?q=${encodeURIComponent(q)}${extra}`)
      .set(auth);
    expect(res.status).toBe(200);
    return res.body.items as Record<string, unknown>[];
  }

  it('busca por NOME não oferece a peça', async () => {
    const itens = await buscar('Bateria');
    // As duas se chamam "Bateria". Oferecer as duas esconde o produto de venda
    // no meio do estoque de conserto, e a peça tem preço de reposição.
    expect(itens.map((i) => i.id)).toEqual(['bat-loja']);
  });

  it('BIPAGEM do código de barras ACHA a peça, e diz que é peça', async () => {
    const itens = await buscar('7890000000024');
    /*
      "Produto não encontrado" para um item que está na mão do operador é
      mentira, e a saída que a tela deixa é cadastrar de novo — aí o mesmo item
      passa a ter dois cadastros e o saldo racha entre os dois.
    */
    expect(itens).toHaveLength(1);
    expect(itens[0].id).toBe('bat-peca');
    expect(itens[0].kind).toBe('part');
    // Nome da bancada, não o id: "peça da Oficina de Celulares" é uma frase que
    // a tela mostra; um UUID não é.
    expect(itens[0].workshop_name).toBe('Oficina de Celulares');
  });

  it('o código interno exato também acha a peça', async () => {
    const itens = await buscar('COD-bat-peca');
    expect(itens.map((i) => i.id)).toEqual(['bat-peca']);
  });

  it('includeParts=1 traz a peça também na busca por nome', async () => {
    const itens = await buscar('Bateria', '&includeParts=1');
    expect(itens.map((i) => i.id).sort()).toEqual(['bat-loja', 'bat-peca']);
  });

  it('a mercadoria de revenda vem com kind retail e sem bancada', async () => {
    const itens = await buscar('7890000000017');
    expect(itens[0].kind).toBe('retail');
    expect(itens[0].workshop_name).toBeNull();
  });
});
