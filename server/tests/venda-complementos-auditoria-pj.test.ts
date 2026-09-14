/**
 * ============================================================================
 * A VENDA NO SERVIDOR — os complementos da trilha "venda" da auditoria do
 * Preço Justo
 * ============================================================================
 *
 *   E-venda-servidor-09  a devolução não tinha chave de idempotência: o reenvio
 *                        depois de uma resposta perdida gravava a SEGUNDA
 *                        devolução e tirava dinheiro da gaveta de novo.
 *   G-offline-sync-14    a venda guardada offline sincronizada no dia seguinte
 *                        entrava no DRE, na comissão e nos relatórios com a
 *                        hora da sincronização.
 *   A-produto-17         o piso de preço do cadastro (mínimo, markup e margem
 *                        mínimos) não era aplicado na venda.
 *   A-produto-26         as casas decimais da unidade não governavam a
 *                        quantidade vendida.
 *   D-pdv-teclado-05     sem teto de quantidade por item no servidor.
 *   D-pdv-teclado-M03    sem teto na soma dos pagamentos, e o PIX pendente
 *                        passava do que faltava.
 *
 * Cada caso executa a venda ou a devolução de verdade e confere o que ficou no
 * banco; cada um falha na versão anterior do servidor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureDefaultUnits } from '../src/services/core/CatalogAuxService.js';
import { diaDaLoja } from '../src/services/core/CalendarioOperacional.js';
import { createQuote, convertQuote } from '../src/services/core/QuoteService.js';
import { createGroup, setMemberGroup, setTier } from '../src/services/core/CommissionService.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-venda-complementos';

type Auth = { Authorization: string };
let gerente: Auth;
let gerenteId: string;
let companyId: string;

async function entrar(userId: string, perfil: string): Promise<{ auth: Auth; userId: string }> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const g = await entrar('gerente-compl', 'gerente_loja');
  gerente = g.auth;
  gerenteId = g.userId;
  companyId = LOJA;
});

async function produto(precoCents: number, quantidade = 20, nome?: string): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: nome ?? `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  if (quantidade > 0) {
    const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: quantidade,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id as string}`,
    });
    expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  }
  return String(p.body.id);
}

function vender(corpo: Record<string, unknown>, chave = randomUUID(), auth: Auth = gerente) {
  return request(app).post('/api/v1/core/sales').set(auth).set('Idempotency-Key', chave).send(corpo);
}

async function abrirCaixa(): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(gerente).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function contar(sql: string, ...params: unknown[]): number {
  return Number((getConnection().prepare(sql).get(...params) as { n: number }).n);
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function contarVendas(): number {
  return contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', companyId);
}

const horasAtras = (horas: number) => new Date(Date.now() - horas * 3_600_000).toISOString();

// ============================================================================
describe('E-venda-servidor-09 — a mesma chave não grava a segunda devolução', () => {
  async function vendaEmDinheiro() {
    const caixa = await abrirCaixa();
    const p = await produto(5000, 10, 'Jaqueta jeans');
    const v = await vender({
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: caixa,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const itens = await request(app).get(`/api/v1/core/sales/${v.body.id as string}/returnable`).set(gerente);
    return {
      caixa,
      p,
      saleId: String(v.body.id),
      saleItemId: String(itens.body.items[0].sale_item_id),
    };
  }

  function devolver(corpo: Record<string, unknown>, chave?: string, auth: Auth = gerente) {
    const r = request(app).post('/api/v1/core/sale-returns').set(auth);
    if (chave) r.set('Idempotency-Key', chave);
    return r.send(corpo);
  }

  it('o reenvio com a mesma chave devolve a devolução gravada — estoque, gaveta e financeiro uma vez só', async () => {
    const { caixa, p, saleId, saleItemId } = await vendaEmDinheiro();
    const estoqueAntes = saldo(p);
    const chave = randomUUID();
    const corpo = {
      saleId,
      reason: 'Tamanho errado',
      refundMethod: 'dinheiro',
      cashSessionId: caixa,
      items: [{ saleItemId, quantity: 1 }],
    };

    const primeira = await devolver(corpo, chave);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    // A resposta se perdeu; a tela reenvia o MESMO pedido, com a MESMA chave.
    const segunda = await devolver(corpo, chave);
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
    expect(segunda.body.id).toBe(primeira.body.id);
    expect(segunda.body.number).toBe(primeira.body.number);

    // Antes: duas devoluções, o estoque subindo duas vezes e R$ 100 fora da gaveta.
    expect(contar('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?', saleId)).toBe(1);
    expect(saldo(p)).toBe(estoqueAntes + 1);
    const saiuDaGaveta = getConnection()
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM core_cash_movements
          WHERE session_id = ? AND reference_type = 'sale_return'`,
      )
      .get(caixa) as { t: number };
    expect(saiuDaGaveta.t).toBe(-5000);
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale_return' AND company_id = ?",
        companyId,
      ),
    ).toBe(1);
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'sale_returns.created' AND company_id = ?",
        companyId,
      ),
    ).toBe(1);
  });

  it('a mesma chave com OUTRO pedido é 422, e nada é gravado', async () => {
    const { caixa, saleId, saleItemId } = await vendaEmDinheiro();
    const chave = randomUUID();
    const base = { saleId, reason: 'Tamanho errado', refundMethod: 'dinheiro', cashSessionId: caixa };
    const primeira = await devolver({ ...base, items: [{ saleItemId, quantity: 1 }] }, chave);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);

    const outra = await devolver({ ...base, items: [{ saleItemId, quantity: 2 }] }, chave);
    expect(outra.status, JSON.stringify(outra.body)).toBe(422);
    expect(outra.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(outra.body.error.message).toContain(`a devolução #${primeira.body.number as number}`);
    expect(contar('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?', saleId)).toBe(1);
  });

  it('o motivo e a gaveta não mudam o pedido: reenviar com o motivo corrigido devolve a mesma devolução', async () => {
    const { caixa, saleId, saleItemId } = await vendaEmDinheiro();
    const chave = randomUUID();
    const itens = [{ saleItemId, quantity: 1 }];
    const primeira = await devolver(
      { saleId, reason: 'Tamanho errado', refundMethod: 'dinheiro', cashSessionId: caixa, items: itens },
      chave,
    );
    expect(primeira.status).toBe(201);
    const segunda = await devolver(
      { saleId, reason: 'Tamanho errado (cliente trocou de ideia)', refundMethod: 'dinheiro', items: itens },
      chave,
    );
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
    expect(segunda.body.id).toBe(primeira.body.id);
  });

  it('sem chave, é o comportamento de sempre: dois envios são duas devoluções', async () => {
    const { caixa, saleId, saleItemId } = await vendaEmDinheiro();
    const corpo = {
      saleId,
      reason: 'Tamanho errado',
      refundMethod: 'dinheiro',
      cashSessionId: caixa,
      items: [{ saleItemId, quantity: 1 }],
    };
    expect((await devolver(corpo)).status).toBe(201);
    expect((await devolver(corpo)).status).toBe(201);
    expect(contar('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?', saleId)).toBe(2);
  });

  it('quem devolveu com a liberação do gestor reenvia e ouve que está registrada — e não "liberação já usada"', async () => {
    const { saleId, saleItemId } = await vendaEmDinheiro();
    const estoquista = await entrar('estoque-compl', 'estoquista');
    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set(estoquista.auth)
      .send({
        login: `gerente-compl@${LOJA}`,
        password: TEST_PASSWORD,
        action: 'devolver_venda',
        referenceId: saleId,
        reason: 'cliente voltou com a jaqueta',
      });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const chave = randomUUID();
    const corpo = {
      saleId,
      reason: 'Tamanho errado',
      refundMethod: 'pix',
      authorizationId: lib.body.id,
      items: [{ saleItemId, quantity: 1 }],
    };
    const primeira = await devolver(corpo, chave, estoquista.auth);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    const segunda = await devolver(corpo, chave, estoquista.auth);
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
    expect(segunda.body.id).toBe(primeira.body.id);
    expect(contar('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?', saleId)).toBe(1);
  });
});

// ============================================================================
describe('G-offline-sync-14 — a venda guardada entra com a hora em que aconteceu', () => {
  async function gavetaAbertaHa(horas: number): Promise<string> {
    const caixa = await abrirCaixa();
    getConnection()
      .prepare('UPDATE core_cash_sessions SET opened_at = ? WHERE id = ?')
      .run(horasAtras(horas), caixa);
    return caixa;
  }

  function vendaGuardada(p: string, caixa: string, queuedAt: string) {
    return vender(
      {
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
        cashSessionId: caixa,
        vendaGuardada: { userId: gerenteId, queuedAt },
      },
      `pdv-${randomUUID()}`,
    );
  }

  function venda(saleId: string): { created_at: string } {
    return getConnection().prepare('SELECT created_at FROM core_sales WHERE id = ?').get(saleId) as never;
  }

  function trilhaDaHora(saleId: string): { registradaEm: string; motivoDaHora: string | null } {
    const linha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'sale.create' AND entity_id = ?")
      .get(saleId) as { detail: string };
    return JSON.parse(linha.detail).vendaGuardada;
  }

  it('guardada às 22h de ontem, na gaveta aberta às 8h de ontem, sincronizada hoje: entra com a hora de ontem', async () => {
    const caixa = await gavetaAbertaHa(34);
    const p = await produto(5000);
    const quando = horasAtras(20);

    const res = await vendaGuardada(p, caixa, quando);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Antes: a hora da sincronização.
    expect(venda(res.body.id).created_at).toBe(quando);
    expect(res.body.created_at).toBe(quando);
    // A competência do título e da comissão é o dia da venda, não o do envio.
    const titulo = getConnection()
      .prepare("SELECT competence_date FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?")
      .get(res.body.id) as { competence_date: string };
    expect(titulo.competence_date).toBe(diaDaLoja(quando));
    expect(trilhaDaHora(res.body.id)).toMatchObject({ registradaEm: quando, motivoDaHora: null });
  });

  it('com a hora no futuro (relógio do PDV adiantado), entra com a hora de agora — e a trilha diz por quê', async () => {
    const caixa = await gavetaAbertaHa(2);
    const p = await produto(5000);
    const antes = Date.now();
    const res = await vendaGuardada(p, caixa, new Date(Date.now() + 2 * 3_600_000).toISOString());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const gravada = Date.parse(venda(res.body.id).created_at);
    expect(gravada).toBeGreaterThanOrEqual(antes - 1000);
    expect(gravada).toBeLessThanOrEqual(Date.now() + 1000);
    expect(trilhaDaHora(res.body.id).motivoDaHora).toMatch(/futuro/);
  });

  it('com a hora anterior à abertura da gaveta em que ela entrou, entra com a hora de agora', async () => {
    const caixa = await gavetaAbertaHa(34);
    const p = await produto(5000);
    const antes = Date.now();
    const res = await vendaGuardada(p, caixa, horasAtras(40));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Date.parse(venda(res.body.id).created_at)).toBeGreaterThanOrEqual(antes - 1000);
    expect(trilhaDaHora(res.body.id).motivoDaHora).toMatch(/abertura da gaveta/);
  });

  it('com mais de 72 horas, entra com a hora de agora', async () => {
    const caixa = await gavetaAbertaHa(100);
    const p = await produto(5000);
    const antes = Date.now();
    const res = await vendaGuardada(p, caixa, horasAtras(80));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Date.parse(venda(res.body.id).created_at)).toBeGreaterThanOrEqual(antes - 1000);
    expect(trilhaDaHora(res.body.id).motivoDaHora).toMatch(/72 horas/);
  });

  /*
    REVISÃO: com a competência retroativa, a comissão podia nascer "aberta"
    dentro de um período já fechado para o vendedor — o fechamento seguinte é de
    outras datas e refechar o mesmo período é recusado. Ela ficava presa.
  */
  function comissaoDoGerente(): void {
    const grupo = createGroup(companyId, 'Loja').id;
    setTier(companyId, grupo, 0, 200);
    setMemberGroup(companyId, gerenteId, grupo);
  }

  function competenciaDaComissao(saleId: string): string | undefined {
    const linha = getConnection()
      .prepare('SELECT competence_date FROM core_commission_entries WHERE sale_id = ? AND amount_cents > 0')
      .get(saleId) as { competence_date: string } | undefined;
    return linha?.competence_date;
  }

  it('revisão: período de comissão do dia da venda já fechado — a venda fica com a hora dela, a comissão entra hoje', async () => {
    const caixa = await gavetaAbertaHa(34);
    const p = await produto(5000);
    comissaoDoGerente();
    // 30 h atrás é sempre outro dia da loja; o fechamento cobre só aquele dia.
    const quando = horasAtras(30);
    const diaDaVenda = diaDaLoja(quando);
    getConnection()
      .prepare(
        `INSERT INTO core_commission_closings
           (id, company_id, seller_id, period_from, period_to, total_cents, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(randomUUID(), companyId, gerenteId, diaDaVenda, diaDaVenda, new Date().toISOString());

    const res = await vendaGuardada(p, caixa, quando);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(venda(res.body.id).created_at).toBe(quando);
    // Antes: competência no dia fechado, e a linha nunca era paga.
    expect(competenciaDaComissao(res.body.id)).toBe(diaDaLoja(new Date().toISOString()));
  });

  it('revisão: sem período fechado, a comissão da venda guardada fica no dia em que ela aconteceu', async () => {
    const caixa = await gavetaAbertaHa(34);
    const p = await produto(5000);
    comissaoDoGerente();
    const quando = horasAtras(30);
    const res = await vendaGuardada(p, caixa, quando);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(competenciaDaComissao(res.body.id)).toBe(diaDaLoja(quando));
  });

  it('o reenvio da mesma venda guardada continua devolvendo a original', async () => {
    const caixa = await gavetaAbertaHa(34);
    const p = await produto(5000);
    const quando = horasAtras(20);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: caixa,
      vendaGuardada: { userId: gerenteId, queuedAt: quando },
    };
    const a = await vender(corpo, chave);
    const b = await vender(corpo, chave);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(contarVendas()).toBe(1);
  });
});

// ============================================================================
describe('A-produto-17 — o piso de preço do cadastro vale na venda', () => {
  async function produtoComPiso(
    precoCents: number,
    piso: { minPrice?: number; custo?: number; markup?: number; margem?: number },
  ): Promise<string> {
    const p = await produto(precoCents, 20, 'Camiseta básica');
    getConnection()
      .prepare(
        `UPDATE core_products SET min_price_cents = ?, cost_cents = ?, min_markup_percent = ?,
                min_margin_percent = ? WHERE id = ?`,
      )
      .run(piso.minPrice ?? 0, piso.custo ?? 0, piso.markup ?? null, piso.margem ?? null, p);
    return p;
  }

  function liberacaoPara(requestedBy: string): string {
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_authorizations
           (id, company_id, action, requested_by, authorized_by, granted_concession_cents, created_at)
         VALUES (?, ?, 'desconto_acima_limite', ?, ?, NULL, ?)`,
      )
      .run(id, companyId, requestedBy, gerenteId, new Date().toISOString());
    return id;
  }

  it('R$ 23,92 num produto de piso R$ 25,00 é recusado sem liberação — mesmo dentro dos 10% do operador', async () => {
    const caixa = await entrar('caixa-compl', 'operador_caixa_loja');
    const p = await produtoComPiso(2600, { minPrice: 2500 });
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
      },
      randomUUID(),
      caixa.auth,
    );
    // Antes: 201 — 8% de concessão, dentro da alçada, e o piso nunca lido.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.message).toMatch(/Camiseta básica/);
    expect(res.body.error.message).toMatch(/R\$ 23,92/);
    expect(res.body.error.message).toMatch(/piso de R\$ 25,00/);
    expect(res.body.error.details.abaixoDoPiso[0]).toMatchObject({
      productId: p,
      unitarioCobradoCents: 2392,
      pisoCents: 2500,
      precoDoCadastroCents: null,
    });
    // O cadastro (R$ 26,00) passa do piso: cobrar o piso é uma saída real.
    expect(res.body.error.message).toMatch(/cobre ao menos o piso/);
    expect(contarVendas()).toBe(0);
  });

  it('revisão: com o preço do CADASTRO abaixo do piso, a recusa não manda "cobrar o piso" — aponta Produtos', async () => {
    const caixa = await entrar('caixa-compl', 'operador_caixa_loja');
    const p = await produtoComPiso(2400, { minPrice: 2500 });
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 2400 }],
      },
      randomUUID(),
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // Antes: "ou cobre ao menos o piso" — e o servidor corta a linha no preço
    // do cadastro, então digitar R$ 25,00 voltava a cobrar R$ 24,00.
    expect(res.body.error.message).not.toMatch(/cobre ao menos o piso/);
    expect(res.body.error.message).toMatch(/preço de venda do cadastro, R\$ 24,00, já está abaixo desse piso/);
    expect(res.body.error.message).toMatch(/corrigido em Produtos/);
    expect(res.body.error.details.abaixoDoPiso[0].precoDoCadastroCents).toBe(2400);
    expect(contarVendas()).toBe(0);
  });

  it('com a liberação do gestor a venda sai — e a liberação fica gasta nela', async () => {
    const caixa = await entrar('caixa-compl', 'operador_caixa_loja');
    const p = await produtoComPiso(2600, { minPrice: 2500 });
    const lib = liberacaoPara(caixa.userId);
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
        authorizationId: lib,
      },
      randomUUID(),
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const gasta = getConnection()
      .prepare('SELECT consumed_ref_id FROM core_authorizations WHERE id = ?')
      .get(lib) as { consumed_ref_id: string | null };
    expect(gasta.consumed_ref_id).toBe(res.body.id);
  });

  it('o gerente vende abaixo do piso sem pedir a si mesmo', async () => {
    const p = await produtoComPiso(2600, { minPrice: 2500 });
    const res = await vender({
      items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('markup mínimo: custo R$ 20,00 e 30% dão piso de R$ 26,00 — R$ 25,00 pede gestor', async () => {
    const caixa = await entrar('caixa-compl', 'operador_caixa_loja');
    const p = await produtoComPiso(2700, { custo: 2000, markup: 30 });
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2500 }],
        payments: [{ method: 'dinheiro', amountCents: 2500 }],
      },
      randomUUID(),
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.message).toMatch(/markup mínimo de 30%/);
    expect(res.body.error.details.abaixoDoPiso[0].pisoCents).toBe(2600);
  });

  it('o desconto do rodapé também abate do que a linha cobra', async () => {
    const caixa = await entrar('caixa-compl', 'operador_caixa_loja');
    const p = await produtoComPiso(2600, { minPrice: 2500 });
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1 }],
        discountCents: 208,
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
      },
      randomUUID(),
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.details.abaixoDoPiso[0].unitarioCobradoCents).toBe(2392);
  });

  it('no piso ou acima, o operador vende como sempre', async () => {
    const caixa = await entrar('caixa-compl', 'operador_caixa_loja');
    const p = await produtoComPiso(2600, { minPrice: 2500 });
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2500 }],
        payments: [{ method: 'dinheiro', amountCents: 2500 }],
      },
      randomUUID(),
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// ============================================================================
describe('A-produto-26 — as casas decimais da unidade governam a quantidade', () => {
  async function produtoEm(unidade: string, pesavel = false): Promise<string> {
    const p = await produto(1000, 50);
    getConnection()
      .prepare('UPDATE core_products SET unit = ?, weighable = ? WHERE id = ?')
      .run(unidade, pesavel ? 1 : 0, p);
    return p;
  }

  it('1,255 m numa unidade de duas casas é recusado; 1,25 m passa', async () => {
    ensureDefaultUnits(companyId);
    const p = await produtoEm('M');
    const recusada = await vender({
      items: [{ productId: p, quantity: 1.255 }],
      payments: [{ method: 'dinheiro', amountCents: 2000 }],
    });
    // Antes: 201, com 1,255 m no cupom e na nota.
    expect(recusada.status, JSON.stringify(recusada.body)).toBe(400);
    expect(recusada.body.error.code).toBe('CORE_QUANTITY_DECIMALS');
    expect(recusada.body.error.message).toMatch(/até 2 casas decimais/);
    expect(recusada.body.error.details).toMatchObject({ unit: 'M', casasAceitas: 2 });
    expect(contarVendas()).toBe(0);

    const aceita = await vender({
      items: [{ productId: p, quantity: 1.25 }],
      payments: [{ method: 'dinheiro', amountCents: 1250 }],
    });
    expect(aceita.status, JSON.stringify(aceita.body)).toBe(201);
  });

  it('CX (zero casas) continua recusando 2,5', async () => {
    ensureDefaultUnits(companyId);
    const p = await produtoEm('CX');
    const res = await vender({
      items: [{ productId: p, quantity: 2.5 }],
      payments: [{ method: 'dinheiro', amountCents: 2500 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_QUANTITY_MUST_BE_INTEGER');
  });

  it('o pesável segue a balança, e a unidade fora do cadastro não é bloqueada pelas casas', async () => {
    ensureDefaultUnits(companyId);
    const pesavel = await produtoEm('M', true);
    const a = await vender({
      items: [{ productId: pesavel, quantity: 0.735 }],
      payments: [{ method: 'dinheiro', amountCents: 1000 }],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);

    getConnection().prepare("DELETE FROM core_units WHERE company_id = ? AND code = 'KG'").run(companyId);
    const porQuilo = await produtoEm('KG');
    const b = await vender({
      items: [{ productId: porQuilo, quantity: 1.23456 }],
      payments: [{ method: 'dinheiro', amountCents: 2000 }],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
  });
});

// ============================================================================
describe('D-pdv-teclado-05 — teto de quantidade por item no servidor', () => {
  it('100.000 numa linha é recusado, e o código de barras no campo de quantidade também', async () => {
    const p = await produto(5000);
    for (const quantidade of [100_000, 7_891_234_567_895]) {
      const res = await vender({
        items: [{ productId: p, quantity: quantidade }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
      });
      // Antes: a linha seguia e só parava — se parasse — no estoque.
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.code).toBe('CORE_INVALID_QUANTITY');
      expect(res.body.error.message).toMatch(/99\.999/);
      expect(res.body.error.details).toMatchObject({ productId: p, maximo: 99_999 });
    }
    expect(contarVendas()).toBe(0);
  });

  it('a conversão de orçamento passa pelo mesmo teto', async () => {
    const p = await produto(5000, 0);
    const doc = createQuote({
      companyId,
      userId: gerenteId,
      kind: 'orcamento',
      items: [{ productId: p, quantity: 100_000, unitPriceCents: 5000 }],
    });
    let erro: { code?: string } | null = null;
    try {
      convertQuote({
        companyId,
        userId: gerenteId,
        quoteId: String(doc.id),
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 500_000_000 }],
      });
    } catch (e) {
      erro = e as { code?: string };
    }
    expect(erro?.code).toBe('CORE_INVALID_QUANTITY');
    expect(contarVendas()).toBe(0);
  });
});

// ============================================================================
describe('D-pdv-teclado-M03 — tetos do pagamento no servidor', () => {
  it('PIX pendente acima do que falta é recusado — não existe troco de PIX', async () => {
    const p = await produto(10_000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 15_000, status: 'pending' }],
    });
    // Antes: 201, com um título esperando um PIX maior que a dívida.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_PAYMENT_ABOVE_REMAINING');
    expect(res.body.error.message).toContain('R$ 150,00');
    expect(res.body.error.message).toContain('R$ 100,00');
    expect(contarVendas()).toBe(0);
  });

  it('soma absurda em dinheiro (código de barras no campo de valor) é recusada, com o valor e o total', async () => {
    const p = await produto(5000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 789_123_456_789 }],
    });
    // Antes: 201, com troco de R$ 7,8 bilhões gravado na venda.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_PAYMENT_TOO_LARGE');
    expect(res.body.error.message).toContain('R$ 50,00');
    expect(res.body.error.details).toMatchObject({ recebidoCents: 789_123_456_789, totalCents: 5000 });
    expect(contarVendas()).toBe(0);
  });

  it('a nota de R$ 100 para a bala de R$ 0,50 continua valendo — a mesma folga da tela', async () => {
    const p = await produto(50);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.change_cents).toBe(9_950);
  });
});
