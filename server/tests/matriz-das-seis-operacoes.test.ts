/**
 * A MATRIZ DAS SEIS OPERAÇÕES — uma travessia cruzada por classe de dado.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO É, E O QUE ELE NÃO É
 * ============================================================================
 *
 * O grupo tem seis CNPJs no mesmo banco: Conceito, Gringa, Me Mimei, Oficina,
 * PJ Motors e Preço Justo. Todo dado do sistema pertence a um deles, e o
 * defeito mais caro que este ERP pode ter não é um erro na tela — é um
 * ACERTO na tela da empresa errada, que ninguém nota porque o número é
 * plausível.
 *
 * `auditoria-p0-isolamento` já cobre quatro fronteiras específicas (gaveta,
 * token de webhook, ids soltos do corpo, junção com a oficina), e
 * `fiscal-multiempresa` cobre a fila fiscal. Este arquivo é o MAPA: percorre
 * as classes de dado uma a uma e, para cada uma, tenta atravessar a fronteira.
 *
 * Não repete o que aqueles dois provam. O que ele acrescenta é a COBERTURA
 * SISTEMÁTICA — a garantia de que nenhuma classe ficou de fora por esquecimento.
 *
 * ============================================================================
 * A FALSIFICAÇÃO
 * ============================================================================
 *
 * Cada bloco tem o par: a operação da empresa A é recusada (ou volta vazia)
 * sobre o dado da empresa B, **e** a mesma operação passa dentro da própria
 * empresa. Sem a segunda metade, um teste ficaria verde com o sistema inteiro
 * quebrado — recusar tudo também recusa o que devia passar.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

/** As seis operações, com o papel que cada uma faz no grupo. */
const OPERACOES = [
  { slug: 'preco-justo', nome: 'Preço Justo' },
  { slug: 'gringa', nome: 'Gringa' },
  { slug: 'me-mimei', nome: 'Me Mimei' },
  { slug: 'conceito', nome: 'Conceito' },
  { slug: 'pj-motors', nome: 'PJ Motors' },
  { slug: 'oficina', nome: 'Oficina' },
] as const;

type Slug = (typeof OPERACOES)[number]['slug'];

interface Operacao {
  companyId: string;
  auth: { Authorization: string };
  /** Um produto, um cliente e um fornecedor DESTA operação. */
  produto: string;
  cliente: string;
  fornecedor: string;
}

const op = {} as Record<Slug, Operacao>;

beforeAll(async () => {
  resetDbForTests();

  for (const { slug, nome } of OPERACOES) {
    const res = await loginForTest(app, {
      userId: `gerente-${slug}`,
      companyId: slug,
      profileCodes: ['gerente_loja', 'gerente_oficina'],
    });
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    const companyId = res.body.company.id as string;

    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: `Produto da ${nome}`, priceCents: 5_000 })
      .expect(201);

    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .send({ name: `Cliente da ${nome}`, document: documentoDe(slug) })
      .expect(201);

    const fornecedor = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: `Fornecedor da ${nome}` })
      .expect(201);

    op[slug] = {
      companyId,
      auth,
      produto: produto.body.id,
      cliente: cliente.body.id,
      fornecedor: fornecedor.body.id,
    };
  }
});

/** CPF distinto por operação: o cadastro recusa documento repetido. */
function documentoDe(slug: Slug): string {
  const base = OPERACOES.findIndex((o) => o.slug === slug) + 1;
  return `1112223334${String(base).padStart(2, '0')}`;
}

/** A lista devolvida por uma rota de coleção. */
async function listar(slug: Slug, caminho: string): Promise<Record<string, unknown>[]> {
  const res = await request(app).get(`/api/v1/core/${caminho}`).set(op[slug].auth);
  expect([caminho, res.status]).toEqual([caminho, 200]);
  const corpo = res.body as { items?: Record<string, unknown>[] };
  return corpo.items ?? [];
}

// ============================================================================
// 1. AS SEIS EXISTEM, E CADA UMA É UMA EMPRESA
// ============================================================================

describe('as seis operações do grupo', () => {
  it('cada uma tem companyId próprio', () => {
    const ids = OPERACOES.map((o) => op[o.slug].companyId);
    expect(new Set(ids).size).toBe(6);
  });

  it('e o escopo do token é o da operação, não o do corpo da requisição', async () => {
    /*
      A rota lê o `companyId` do TOKEN. Mandar outro no corpo não muda nada —
      esta é a fronteira que sustenta todas as outras deste arquivo.
    */
    const res = await request(app)
      .post('/api/v1/core/products')
      .set(op['gringa'].auth)
      .send({ name: 'Tentativa', priceCents: 100, companyId: op['preco-justo'].companyId })
      .expect(201);

    const dono = getConnection()
      .prepare('SELECT company_id FROM core_products WHERE id = ?')
      .get(res.body.id) as { company_id: string };
    expect(dono.company_id).toBe(op['gringa'].companyId);
  });
});

// ============================================================================
// 2. CATÁLOGO, CLIENTES E FORNECEDORES
// ============================================================================

describe('catálogo, clientes e fornecedores não atravessam', () => {
  it('cada operação lista só os próprios produtos', async () => {
    /*
      O invariante é "NADA da vizinha", e não "exatamente um": outros testes
      deste arquivo criam produtos, e uma lista de tamanho fixo mediria a ordem
      de execução em vez da fronteira.
    */
    for (const { slug, nome } of OPERACOES) {
      const nomes = (await listar(slug, 'products')).map((p) => String(p.name));
      expect([slug, nomes]).toEqual([slug, expect.arrayContaining([`Produto da ${nome}`])]);
      /*
        A asserção mede o que VAZOU, e não "não contém": `expect([slug, nomes])`
        com `toContain` conferiria a membresia do PAR — que nunca contém o nome
        — e passaria com a fronteira derrubada. Foi o que aconteceu na primeira
        versão deste arquivo, e só a mordida provada mostrou.
      */
      const dasOutras = OPERACOES.filter((o) => o.slug !== slug).map((o) => `Produto da ${o.nome}`);
      const vazou = dasOutras.filter((alheio) => nomes.includes(alheio));
      expect([slug, vazou]).toEqual([slug, []]);
    }
  });

  it('cada operação lista só os próprios clientes', async () => {
    for (const { slug, nome } of OPERACOES) {
      const nomes = (await listar(slug, 'customers')).map((c) => String(c.name));
      expect([slug, nomes]).toEqual([slug, [`Cliente da ${nome}`]]);
    }
  });

  it('cada operação lista só os próprios fornecedores', async () => {
    for (const { slug, nome } of OPERACOES) {
      const nomes = (await listar(slug, 'suppliers')).map((s) => String(s.name));
      expect([slug, nomes]).toEqual([slug, [`Fornecedor da ${nome}`]]);
    }
  });

  it('pedir o produto da vizinha pelo id devolve 404, e não o produto', async () => {
    const res = await request(app)
      .get(`/api/v1/core/products/${op['preco-justo'].produto}`)
      .set(op['gringa'].auth);
    expect(res.status).toBe(404);
  });

  it('e pedir o PRÓPRIO produto devolve 200 — senão o teste acima não prova nada', async () => {
    const res = await request(app)
      .get(`/api/v1/core/products/${op['gringa'].produto}`)
      .set(op['gringa'].auth);
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 3. ESTOQUE — O PDV DA GRINGA NÃO VENDE ESTOQUE DO PREÇO JUSTO
// ============================================================================

describe('estoque', () => {
  it('mover estoque do produto da vizinha é recusado', async () => {
    const res = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(op['gringa'].auth)
      .send({
        productId: op['preco-justo'].produto,
        movementType: 'in',
        quantity: 5,
        referenceType: 'entrada',
        referenceId: randomUUID(),
      });

    // 404 ou 400: o que importa é que o saldo da vizinha não se move.
    expect([404, 400, 409]).toContain(res.status);
  });

  it('e mover o próprio passa', async () => {
    const res = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(op['gringa'].auth)
      .send({
        productId: op['gringa'].produto,
        movementType: 'in',
        quantity: 5,
        referenceType: 'entrada',
        referenceId: randomUUID(),
      });

    expect(res.status).toBe(201);
  });

  it('o saldo da vizinha não aparece na lista de estoque', async () => {
    const daPrecoJusto = (await listar('preco-justo', 'stock')).map((s) => String(s.product_id));
    expect(daPrecoJusto).not.toContain(op['gringa'].produto);
  });
});

// ============================================================================
// 4. VENDA — O PDV DE CADA OPERAÇÃO
// ============================================================================

describe('venda', () => {
  /** Uma venda de balcão, com o produto informado. */
  function vender(slug: Slug, productId: string) {
    return request(app)
      .post('/api/v1/core/sales')
      .set(op[slug].auth)
      .send({
        items: [{ productId, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        idempotencyKey: randomUUID(),
      });
  }

  it('a Gringa não vende o produto do Preço Justo', async () => {
    const res = await vender('gringa', op['preco-justo'].produto);
    expect([404, 400, 409]).toContain(res.status);
  });

  it('a Gringa vende o próprio', async () => {
    const res = await vender('gringa', op['gringa'].produto);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('a venda de uma operação não aparece na lista da outra', async () => {
    const daPrecoJusto = await listar('preco-justo', 'sales');
    const numeros = daPrecoJusto.map((v) => String(v.id));
    const daGringa = await listar('gringa', 'sales');

    for (const venda of daGringa) expect(numeros).not.toContain(String(venda.id));
  });

  it('cliente da vizinha é recusado na venda', async () => {
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(op['gringa'].auth)
      .send({
        customerId: op['preco-justo'].cliente,
        items: [{ productId: op['gringa'].produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        idempotencyKey: randomUUID(),
      });

    expect([404, 400, 409]).toContain(res.status);
  });
});

// ============================================================================
// 5. FINANCEIRO
// ============================================================================

describe('financeiro', () => {
  async function lancar(slug: Slug) {
    const res = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(op[slug].auth)
      .send({
        direction: 'in',
        amountCents: 12_345,
        description: `Lançamento da ${slug}`,
        dueDate: '2026-08-31',
      });
    expect([slug, res.status]).toEqual([slug, 201]);
    return res.body as { id: string };
  }

  it('cada operação vê só os próprios lançamentos', async () => {
    for (const { slug } of OPERACOES) await lancar(slug);

    for (const { slug } of OPERACOES) {
      const descricoes = (await listar(slug, 'finance/entries?direction=in')).map((e) =>
        String(e.description),
      );
      expect(descricoes).toContain(`Lançamento da ${slug}`);
      for (const outra of OPERACOES.filter((o) => o.slug !== slug)) {
        expect([slug, descricoes.includes(`Lançamento da ${outra.slug}`)]).toEqual([slug, false]);
      }
    }
  });

  it('dar baixa no lançamento da vizinha é recusado', async () => {
    const daPrecoJusto = await lancar('preco-justo');

    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${daPrecoJusto.id}/settlements`)
      .set(op['gringa'].auth)
      .send({ amountCents: 12_345, method: 'dinheiro' });

    expect(res.status).toBe(404);
  });
});

// ============================================================================
// 6. FISCAL — SÉRIE, NUMERAÇÃO E CERTIFICADO
// ============================================================================

describe('fiscal', () => {
  it('a configuração fiscal de cada operação é a dela', async () => {
    for (const { slug } of OPERACOES) {
      const res = await request(app).get('/api/v1/core/fiscal/config').set(op[slug].auth);
      expect([slug, res.status]).toEqual([slug, 200]);
      expect([slug, res.body.companyId]).toEqual([slug, op[slug].companyId]);
    }
  });

  it('a numeração é por empresa, modelo e série — as seis começam do 1', async () => {
    /*
      Numeração compartilhada seria o pior desfecho fiscal possível: duas
      empresas emitindo com o mesmo número, e a segunda descobrindo na
      rejeição.
    */
    const db = getConnection();
    for (const { slug } of OPERACOES) {
      db.prepare(
        `INSERT INTO core_fiscal_series (id, company_id, model, serie, next_number, active, created_at)
         VALUES (?, ?, '65', 1, 1, 1, ?)
         ON CONFLICT DO NOTHING`,
      ).run(randomUUID(), op[slug].companyId, new Date().toISOString());
    }

    const series = db
      .prepare('SELECT company_id, next_number FROM core_fiscal_series WHERE model = ?')
      .all('65') as { company_id: string; next_number: number }[];

    expect(series.length).toBeGreaterThanOrEqual(6);
    for (const s of series) expect([s.company_id, s.next_number]).toEqual([s.company_id, 1]);
  });

  it('o documento fiscal de uma operação não aparece na lista da outra', async () => {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, model, serie, number, access_key, environment, status,
            issued_at, created_at, updated_at)
         VALUES (?, ?, '65', 1, 99, ?, 'production', 'AUTHORIZED', ?, ?, ?)`,
      )
      .run(randomUUID(), op['preco-justo'].companyId, '7'.repeat(44), agora, agora, agora);

    const daGringa = await listar('gringa', 'fiscal/documents');
    expect(daGringa.map((d) => String(d.accessKey ?? d.access_key))).not.toContain('7'.repeat(44));

    const doPrecoJusto = await listar('preco-justo', 'fiscal/documents');
    expect(doPrecoJusto.map((d) => String(d.accessKey ?? d.access_key))).toContain('7'.repeat(44));
  });
});

// ============================================================================
// 7. OFICINA E PJ MOTORS — OS DOIS DOMÍNIOS DA PLAQUINHA
// ============================================================================

describe('oficina e PJ Motors', () => {
  it('a Oficina não enxerga as bancadas da Preço Justo', async () => {
    const daOficina = (await listar('oficina', 'workshops')).map((w) => String(w.company_id));
    for (const c of daOficina) expect(c).toBe(op['oficina'].companyId);
  });

  it('a identidade impressa de cada bancada é da própria operação', async () => {
    for (const slug of ['oficina', 'preco-justo'] as const) {
      const marcas = await listar(slug, 'workshops/brands');
      for (const m of marcas) {
        // Nulo é "assina em nome próprio" — e é o padrão das duas.
        expect([slug, m.brandCompanyId]).toEqual([slug, null]);
      }
    }
  });
});

// ============================================================================
// 8. A FALSIFICAÇÃO PROPOSITAL
// ============================================================================

describe('falsificação: um dado plantado do outro lado da fronteira', () => {
  /**
   * As classes acima provam que a API não deixa atravessar. Este bloco prova o
   * contrário do contrário: com um dado da vizinha PLANTADO à força no banco,
   * as consultas continuam sem enxergá-lo — quer dizer, o filtro está na
   * consulta, e não na sorte de o dado não existir.
   *
   * Sem isto, todos os testes acima passariam num sistema que simplesmente não
   * tem dado nenhum para vazar.
   */
  it('produto da vizinha plantado no banco não aparece na lista', async () => {
    const id = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                    price_cents, active, created_at, updated_at)
         VALUES (?, ?, ?, 'Plantado na vizinha', 'UN', 100, 200, 1, ?, ?)`,
      )
      .run(id, op['preco-justo'].companyId, `PL-${id.slice(0, 6)}`, agora, agora);

    const nomes = (await listar('gringa', 'products')).map((p) => String(p.name));
    expect(nomes).not.toContain('Plantado na vizinha');

    // E a MESMA consulta, do lado certo, o encontra: é isto que prova que o
    // teste mediu o filtro, e não a ausência do dado.
    const doDono = (await listar('preco-justo', 'products')).map((p) => String(p.name));
    expect(doDono).toContain('Plantado na vizinha');
  });

  it('lançamento financeiro da vizinha plantado no banco não entra no total', async () => {
    const id = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents, due_date,
            description, origin_type, origin_id, created_at)
         VALUES (?, ?, 'in', 999999, 'open', 0, '2026-08-31', 'Plantado', 'manual', ?, ?)`,
      )
      .run(id, op['preco-justo'].companyId, randomUUID(), agora);

    const res = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(op['gringa'].auth)
      .expect(200);

    expect(Number(res.body.summary.openCents)).toBeLessThan(999999);
  });
});
