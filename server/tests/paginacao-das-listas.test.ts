/**
 * ============================================================================
 * A LISTA DIZ QUE CORTOU — GAP-PRD-070 e GAP-PRD-164
 * ============================================================================
 *
 * Com 150 produtos, `GET /core/products` devolvia 100 e o corpo só tinha
 * `{ items, missingShippingDataCount }`; com 150 clientes, `GET /core/customers`
 * devolvia 100 e só `{ items }`. A 201ª nota de entrada e o 201º pedido de
 * compra sumiam do mesmo jeito, e o painel mostrava 10 produtos abaixo do
 * mínimo sem dizer quantos ficaram de fora. Nenhuma dessas respostas deixava a
 * tela saber que havia mais — e `?limit=1000000` devolvia o catálogo inteiro.
 *
 * Cada caso daqui nasceu VERMELHO contra essas respostas:
 *   - tire o `total` de uma rota e o caso dela falha;
 *   - tire o teto de 500 e o caso do `limit` gigante falha;
 *   - ignore o `offset` e a segunda página repete a primeira;
 *   - conte sem os filtros e o total da busca vira o total da empresa.
 *
 * O PADRÃO DE CADA LISTA É O DE ANTES: quem não pede página recebe as mesmas
 * linhas que recebia. É isso que mantém de pé as telas que ainda não paginam.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { lerPagina, TETO_DA_PAGINA } from '../src/services/core/paginacao.js';

const app = createApp();

interface Sessao {
  auth: { Authorization: string };
  companyId: string;
}

async function entrar(userId: string, companyId: string, perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    companyId: res.body.company.id,
  };
}

const AGORA = '2026-09-01T12:00:00.000Z';
/** Carimbo crescente — a ordem de criação é o que várias listas usam. */
const instante = (i: number) => new Date(Date.parse(AGORA) + i * 60_000).toISOString();
const tres = (i: number) => String(i).padStart(3, '0');

/**
 * Os produtos entram direto no banco: 150 POSTs custariam segundos e não
 * provariam nada a mais — o que está em teste é a LEITURA.
 */
function semearProdutos(companyId: string, n: number, prefixo = 'Produto'): string[] {
  const db = getConnection();
  const ins = db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = randomUUID();
    ins.run(id, companyId, `${prefixo.slice(0, 3).toUpperCase()}${tres(i)}`, `${prefixo} ${tres(i)}`, AGORA, AGORA);
    ids.push(id);
  }
  return ids;
}

function semearClientes(companyId: string, n: number): void {
  const ins = getConnection().prepare(
    `INSERT INTO core_customers (id, company_id, name, phone, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  for (let i = 1; i <= n; i += 1) {
    ins.run(randomUUID(), companyId, `Cliente ${tres(i)}`, `9699999${String(i).padStart(4, '0')}`, AGORA, AGORA);
  }
}

function semearFornecedor(companyId: string): string {
  const id = randomUUID();
  getConnection()
    .prepare('INSERT INTO core_suppliers (id, company_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, companyId, 'Distribuidora Alfa', AGORA);
  return id;
}

function semearNotas(companyId: string, n: number, supplierId: string): string[] {
  const ins = getConnection().prepare(
    `INSERT INTO core_inbound_notes (id, company_id, access_key, number, supplier_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'recebida', ?)`,
  );
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = randomUUID();
    ins.run(id, companyId, `3526${String(i).padStart(40, '0')}`, String(1000 + i), supplierId, instante(i));
    ids.push(id);
  }
  return ids;
}

function semearPedidosDeCompra(companyId: string, n: number, supplierId: string): void {
  const ins = getConnection().prepare(
    `INSERT INTO core_purchase_orders (id, company_id, number, supplier_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= n; i += 1) {
    ins.run(randomUUID(), companyId, i, supplierId, instante(i));
  }
}

async function get(sessao: Sessao, url: string) {
  const res = await request(app).get(`/api/v1/core${url}`).set(sessao.auth);
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return res.body as Record<string, unknown> & { items: Record<string, unknown>[] };
}

beforeEach(() => {
  resetDbForTests();
});

// ================================================================ o saneador

describe('lerPagina: o que chega torto vira o padrão, e o teto vale sempre', () => {
  it('ausente, zero, negativo e texto caem no padrão; acima do teto, o teto', () => {
    expect(lerPagina({}, 100)).toEqual({ limit: 100, offset: 0 });
    expect(lerPagina({ limit: '0', offset: '-5' }, 100)).toEqual({ limit: 100, offset: 0 });
    expect(lerPagina({ limit: 'abc', offset: 'x' }, 200)).toEqual({ limit: 200, offset: 0 });
    expect(lerPagina({ limit: '1000000', offset: '40' }, 100)).toEqual({
      limit: TETO_DA_PAGINA,
      offset: 40,
    });
    expect(lerPagina({ limit: '25.9', offset: '10.7' }, 100)).toEqual({ limit: 25, offset: 10 });
  });
});

// ================================================================ produtos

describe('GAP-PRD-070 — produtos: página, total e teto', () => {
  let gestor: Sessao;
  beforeEach(async () => {
    gestor = await entrar('gestor-pag', 'gringa', 'gerente_loja');
    semearProdutos(gestor.companyId, 150);
  });

  it('sem página pedida: as mesmas 100 de sempre, e o total diz que são 150', async () => {
    const corpo = await get(gestor, '/products');
    expect(corpo.items).toHaveLength(100);
    expect(corpo.total).toBe(150);
    expect(corpo.limit).toBe(100);
    expect(corpo.offset).toBe(0);
    // A pendência de envio continua viajando junto.
    expect(corpo).toHaveProperty('missingShippingDataCount');
  });

  it('o offset leva à segunda página, sem repetir ninguém da primeira', async () => {
    const primeira = await get(gestor, '/products?limit=100&offset=0');
    const segunda = await get(gestor, '/products?limit=100&offset=100');
    expect(segunda.items).toHaveLength(50);
    expect(segunda.total).toBe(150);
    const ids = new Set(primeira.items.map((p) => p.id));
    expect(segunda.items.some((p) => ids.has(p.id))).toBe(false);
    // O 101º produto existe para a tela — era ele que sumia.
    expect(segunda.items[0].name).toBe('Produto 101');
  });

  it('?limit=1000000 não devolve o catálogo inteiro: para no teto de 500', async () => {
    semearProdutos(gestor.companyId, 400, 'Extra');
    const corpo = await get(gestor, '/products?limit=1000000');
    expect(corpo.limit).toBe(500);
    expect(corpo.items).toHaveLength(500);
    expect(corpo.total).toBe(550);
  });

  it('o total respeita a busca — não é o total da empresa', async () => {
    semearProdutos(gestor.companyId, 3, 'Parafuso');
    const corpo = await get(gestor, '/products?search=Parafuso');
    expect(corpo.items).toHaveLength(3);
    expect(corpo.total).toBe(3);
  });

  it('o total respeita o filtro de pendência de envio', async () => {
    const corpo = await get(gestor, '/products?missingShippingData=1');
    // Nenhum dos semeados está publicado: a pendência é zero, e o total também.
    expect(corpo.total).toBe(0);
    expect(corpo.total).toBe(corpo.missingShippingDataCount);
  });

  it('o total é da empresa do token: a outra operação não conta', async () => {
    const outra = await entrar('gestor-outra', 'preco-justo', 'gerente_loja');
    semearProdutos(outra.companyId, 7);
    const corpo = await get(outra, '/products');
    expect(corpo.total).toBe(7);
  });
});

// ================================================================ clientes

describe('GAP-PRD-070 — clientes: página e total, com e sem termo', () => {
  let caixa: Sessao;
  beforeEach(async () => {
    caixa = await entrar('caixa-pag', 'gringa', 'operador_caixa_loja');
    semearClientes(caixa.companyId, 150);
  });

  it('sem termo: 100 de 150, e a tela fica sabendo', async () => {
    const corpo = await get(caixa, '/customers');
    expect(corpo.items).toHaveLength(100);
    expect(corpo.total).toBe(150);
    expect(corpo.limit).toBe(100);
    expect(corpo.offset).toBe(0);
  });

  it('o 101º cliente aparece na segunda página', async () => {
    const segunda = await get(caixa, '/customers?offset=100');
    expect(segunda.items).toHaveLength(50);
    expect(segunda.items[0].name).toBe('Cliente 101');
    expect(segunda.total).toBe(150);
  });

  it('com termo: o total é o dos que casam, e não o da empresa', async () => {
    const ins = getConnection().prepare(
      `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    for (const nome of ['Marlene Souza', 'Marlene Dias', 'Ana Marlene']) {
      ins.run(randomUUID(), caixa.companyId, nome, AGORA, AGORA);
    }
    const corpo = await get(caixa, '/customers?search=Marlene');
    expect(corpo.total).toBe(3);
    expect(corpo.items).toHaveLength(3);
  });

  it('com termo: a página anda sobre os que casam, sem repetir ninguém', async () => {
    const primeira = await get(caixa, '/customers?search=Cliente&limit=100');
    expect(primeira.total).toBe(150);
    expect(primeira.items).toHaveLength(100);
    const segunda = await get(caixa, '/customers?search=Cliente&limit=100&offset=100');
    expect(segunda.items).toHaveLength(50);
    expect(segunda.items[0].name).toBe('Cliente 101');
    const ids = new Set(primeira.items.map((c) => c.id));
    expect(segunda.items.some((c) => ids.has(c.id))).toBe(false);
  });

  it('a busca por telefone continua normalizando e contando certo', async () => {
    const corpo = await get(caixa, `/customers?search=${encodeURIComponent('(96) 99999-0150')}`);
    expect(corpo.total).toBe(1);
    expect(corpo.items[0].name).toBe('Cliente 150');
  });

  it('o limit tem teto também aqui', async () => {
    const corpo = await get(caixa, '/customers?limit=99999');
    expect(corpo.limit).toBe(500);
    expect(corpo.items).toHaveLength(150);
  });
});

// ================================================================== vendas

describe('GAP-PRD-070 — vendas: a página pedida volta na resposta', () => {
  it('limit e offset ecoam junto do total que já existia', async () => {
    const gestor = await entrar('gestor-vendas', 'gringa', 'gerente_loja');
    const corpo = await get(gestor, '/sales?limit=50&offset=0');
    expect(corpo.total).toBe(0);
    expect(corpo.limit).toBe(50);
    expect(corpo.offset).toBe(0);
    const semNada = await get(gestor, '/sales');
    expect(semNada.limit).toBe(200);
  });
});

// ======================================================= notas de entrada

describe('GAP-PRD-164 — notas de entrada: a 201ª não some mais', () => {
  let estoquista: Sessao;
  let notas: string[];
  beforeEach(async () => {
    estoquista = await entrar('estoq-pag', 'gringa', 'estoquista');
    const fornecedor = semearFornecedor(estoquista.companyId);
    notas = semearNotas(estoquista.companyId, 205, fornecedor);
  });

  it('sem página pedida: as 200 mais recentes, e o total diz 205', async () => {
    const corpo = await get(estoquista, '/purchases/notes');
    expect(corpo.items).toHaveLength(200);
    expect(corpo.total).toBe(205);
    expect(corpo.limit).toBe(200);
    expect(corpo.offset).toBe(0);
  });

  it('a segunda página traz as cinco mais antigas', async () => {
    const corpo = await get(estoquista, '/purchases/notes?offset=200');
    expect(corpo.items).toHaveLength(5);
    expect(corpo.items.map((n) => n.id)).toContain(notas[0]);
  });

  it('?id= devolve a nota do link mesmo fora da página, e só ela', async () => {
    const corpo = await get(estoquista, `/purchases/notes?id=${notas[0]}`);
    expect(corpo.items).toHaveLength(1);
    expect(corpo.items[0].id).toBe(notas[0]);
    expect(corpo.total).toBe(1);
  });

  it('a busca acha a nota antiga pelo número, e o total é o da busca', async () => {
    const corpo = await get(estoquista, '/purchases/notes?search=1001');
    expect(corpo.items.map((n) => n.number)).toEqual(['1001']);
    expect(corpo.total).toBe(1);
    const porFornecedor = await get(estoquista, '/purchases/notes?search=Alfa&limit=10');
    expect(porFornecedor.total).toBe(205);
    expect(porFornecedor.items).toHaveLength(10);
  });

  it('a nota de outra operação não entra na conta nem pelo id', async () => {
    const outra = await entrar('estoq-outra', 'preco-justo', 'estoquista');
    const corpo = await get(outra, `/purchases/notes?id=${notas[0]}`);
    expect(corpo.items).toHaveLength(0);
    expect(corpo.total).toBe(0);
  });
});

// ======================================================= pedidos de compra

describe('GAP-PRD-164 — pedidos de compra: página e total', () => {
  it('205 pedidos: 200 na primeira, 5 na segunda, total 205', async () => {
    const estoquista = await entrar('estoq-po', 'gringa', 'estoquista');
    const fornecedor = semearFornecedor(estoquista.companyId);
    semearPedidosDeCompra(estoquista.companyId, 205, fornecedor);
    const primeira = await get(estoquista, '/purchase-orders');
    expect(primeira.items).toHaveLength(200);
    expect(primeira.total).toBe(205);
    expect(primeira.items[0].number).toBe(205);
    const segunda = await get(estoquista, '/purchase-orders?offset=200');
    expect(segunda.items.map((p) => p.number)).toEqual([5, 4, 3, 2, 1]);
    // O filtro entra na conta.
    const rascunhos = await get(estoquista, '/purchase-orders?status=enviado');
    expect(rascunhos.total).toBe(0);
  });
});

// ================================================== painel: estoque baixo

describe('GAP-PRD-164 — o painel diz quantos ficaram abaixo do mínimo', () => {
  it('12 abaixo do mínimo: a tabela traz 10 e o total diz 12', async () => {
    const gestor = await entrar('gestor-painel', 'gringa', 'gerente_loja');
    const ids = semearProdutos(gestor.companyId, 12, 'Baixo');
    const db = getConnection();
    for (const id of ids) {
      db.prepare('UPDATE core_products SET min_stock = 5 WHERE id = ?').run(id);
      db.prepare(
        'INSERT INTO core_stock (company_id, product_id, quantity, updated_at) VALUES (?, ?, 1, ?)',
      ).run(gestor.companyId, id, AGORA);
    }
    const corpo = await get(gestor, '/dashboard');
    expect((corpo.lowStock as unknown[]).length).toBe(10);
    expect(corpo.lowStockTotal).toBe(12);
  });
});

// ============================= as outras listas que cortavam sem dizer

describe('GAP-PRD-070 — equipamentos, orçamentos, pedidos online e histórico contam o todo', () => {
  it('equipamentos: total e página', async () => {
    const gestor = await entrar('gestor-eq', 'gringa', 'admin_geral');
    const db = getConnection();
    const oficina = randomUUID();
    db.prepare(
      'INSERT INTO core_workshops (id, company_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(oficina, gestor.companyId, `of-${oficina.slice(0, 8)}`, 'Oficina', AGORA);
    const ins = db.prepare(
      `INSERT INTO core_equipment (id, company_id, workshop_id, public_id, public_token, origin, brand, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Honda', ?, ?)`,
    );
    for (let i = 1; i <= 5; i += 1) {
      const origem = i <= 3 ? 'INTERNAL_PJ_MOTORS' : 'EXTERNAL_CUSTOMER';
      ins.run(randomUUID(), gestor.companyId, oficina, 90_000 + i, randomUUID(), origem, AGORA, AGORA);
    }
    const corpo = await get(gestor, '/equipment?limit=2&offset=2');
    expect(corpo.items).toHaveLength(2);
    expect(corpo.total).toBe(5);
    expect(corpo.limit).toBe(2);
    expect(corpo.offset).toBe(2);
    // Os cartões contam o banco, não a página de 2.
    expect(corpo.totalPorOrigem).toEqual({ INTERNAL_PJ_MOTORS: 3, EXTERNAL_CUSTOMER: 2 });
    const padrao = await get(gestor, '/equipment');
    expect(padrao.limit).toBe(300);
    // O token da plaquinha continua fora da lista.
    expect(padrao.items.every((e) => !('public_token' in e))).toBe(true);
  });

  it('orçamentos: total e página', async () => {
    const gestor = await entrar('gestor-orc', 'gringa', 'gerente_loja');
    const ins = getConnection().prepare(
      `INSERT INTO core_quotes (id, company_id, number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i <= 4; i += 1) ins.run(randomUUID(), gestor.companyId, i, instante(i), instante(i));
    const corpo = await get(gestor, '/quotes?limit=3');
    expect(corpo.items).toHaveLength(3);
    expect(corpo.total).toBe(4);
    const segunda = await get(gestor, '/quotes?limit=3&offset=3');
    expect(segunda.items).toHaveLength(1);
    expect(segunda.items[0].number).toBe(1);
    expect((await get(gestor, '/quotes')).limit).toBe(100);
  });

  it('pedidos online: total e página', async () => {
    const gestor = await entrar('gestor-oms', 'gringa', 'gerente_loja');
    const ins = getConnection().prepare(
      `INSERT INTO core_orders (id, company_id, number, customer_name, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'Comprador', ?, ?, ?)`,
    );
    for (let i = 1; i <= 3; i += 1) {
      ins.run(randomUUID(), gestor.companyId, i, randomUUID(), instante(i), instante(i));
    }
    const corpo = await get(gestor, '/orders?limit=2');
    expect(corpo.items).toHaveLength(2);
    expect(corpo.total).toBe(3);
    expect(corpo).toHaveProperty('vocabulario');
    expect((await get(gestor, '/orders')).limit).toBe(200);
  });

  it('histórico de estoque: o total conta com os filtros, e o limit tem teto', async () => {
    const gestor = await entrar('gestor-mov', 'gringa', 'gerente_loja');
    const [produto] = semearProdutos(gestor.companyId, 1, 'Movido');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/v1/core/stock/movements')
        .set(gestor.auth)
        .send({
          productId: produto,
          movementType: 'in',
          quantity: 1,
          referenceType: 'manual',
          referenceId: randomUUID(),
        });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    }
    const corpo = await get(gestor, '/stock/movements?limit=2');
    expect(corpo.items).toHaveLength(2);
    expect(corpo.total).toBe(3);
    const filtrado = await get(gestor, `/stock/movements?productId=${randomUUID()}`);
    expect(filtrado.total).toBe(0);
    expect((await get(gestor, '/stock/movements?limit=99999')).limit).toBe(500);
  });
});
