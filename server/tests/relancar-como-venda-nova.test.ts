/**
 * ============================================================================
 * RELANÇAR COMO VENDA NOVA — a saída da venda guardada cuja chave já
 * registrou OUTRA venda (RES-IDEM-TELA)
 * ============================================================================
 *
 * O PDV guardou na fila uma venda com a chave de uma tentativa que o servidor
 * JÁ tinha registrado com outros itens (a venda #N). Na subida da fila,
 * `createSale` recusa com 422 CORE_IDEMPOTENCY_KEY_REUSED (d622b6d) e a venda
 * vira pendência. As duas saídas que existiam não serviam:
 *
 *   - relançar usa a MESMA chave, e a mesma chave com outra mercadoria é 422
 *     para sempre;
 *   - descartar diz que a venda não existe — mas o dinheiro dela está na
 *     gaveta e a mercadoria saiu com o cliente; refazer à mão depois exige
 *     gerente, redigitar os itens e acertar a gaveta de outro turno.
 *
 * A saída certa é a que o próprio servidor pode fazer sem ninguém redigitar:
 * a venda da pendência vira OUTRA venda, com chave própria, na gaveta aberta de
 * quem relança. A venda #N continua como está.
 *
 * O que este arquivo trava:
 *
 *   - a pendência diz qual venda a chave registrou, e o que ela registrou;
 *   - relançar como venda nova vende UMA vez a mercadoria da pendência, na
 *     gaveta aberta, fecha a pendência apontando a venda nova, e deixa a #N
 *     intacta; a trilha diz tudo;
 *   - repetir o pedido não vende de novo (409, pendência já regularizada), e a
 *     chave da venda nova é da pendência — o reenvio que chega depois de um
 *     commit sem resposta devolve a mesma venda;
 *   - sem venda de OUTRA mercadoria na chave, a rota recusa: ali a saída é o
 *     relançamento comum, e vender com chave nova seria vender em dobro;
 *   - outra empresa não enxerga a pendência; quem não vende não relança.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createSale } from '../src/services/core/SalesService.js';
import { chaveDaVendaNovaDaPendencia } from '../src/services/core/VendasOfflineRecusadas.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-venda-nova';
const OUTRA = 'loja-vizinha-venda-nova';

type Auth = { Authorization: string };
let gerente: Auth;
let caixa: Auth;

async function entrar(empresa: string, userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar(LOJA, 'gerente-venda-nova', 'gerente_loja');
  caixa = await entrar(LOJA, 'caixa-venda-nova', 'operador_caixa_loja');
});

async function produto(estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Camiseta ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: estoque,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return p.body.id as string;
}

async function abrirCaixa(auth: Auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function vender(auth: Auth, chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(auth).set('Idempotency-Key', chave).send(corpo);
}

function entregar(auth: Auth, chave: string, corpo: Record<string, unknown>, recusa: { code: string; message: string }) {
  return request(app).post('/api/v1/core/offline-sales').set(auth).send({
    idempotencyKey: chave,
    label: 'venda do PDV',
    body: corpo,
    queuedAt: '2026-09-12T14:05:00.000Z',
    errorCode: recusa.code,
    errorMessage: recusa.message,
  });
}

function relancarComoNova(auth: Auth, id: string, cashSessionId: string | null) {
  return request(app)
    .post(`/api/v1/core/offline-sales/${id}/relaunch-as-new`)
    .set(auth)
    .send({ cashSessionId, terminalId: null });
}

function contar(sql: string, ...args: (string | number)[]): number {
  return (getConnection().prepare(sql).get(...args) as { n: number }).n;
}

function vendas(): number {
  return contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA);
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(LOJA, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function auditoria(acao: string, entidade: string): { detail: Record<string, unknown> }[] {
  return (
    getConnection()
      .prepare('SELECT detail FROM core_audit_log WHERE company_id = ? AND action = ? AND entity_id = ?')
      .all(LOJA, acao, entidade) as unknown as { detail: string }[]
  ).map((r) => ({ detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

/**
 * O caminho real até a pendência: a venda #N nasce com a chave; a tentativa
 * seguinte, com OUTROS itens e a mesma chave, é recusada e entregue.
 */
async function pendenciaDeChaveReusada() {
  const p = await produto(10);
  const gaveta = await abrirCaixa(caixa);
  const chave = `pdv-${randomUUID()}`;
  const original = await vender(caixa, chave, {
    cashSessionId: gaveta,
    items: [{ productId: p, quantity: 2 }],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
  });
  expect(original.status, JSON.stringify(original.body)).toBe(201);

  const corpoDaFila = {
    cashSessionId: gaveta,
    items: [{ productId: p, quantity: 3, unitPriceCents: 5000 }],
    payments: [{ method: 'dinheiro', amountCents: 15_000 }],
  };
  const recusa = await vender(caixa, chave, corpoDaFila);
  expect(recusa.status).toBe(422);
  expect(recusa.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');

  const entregue = await entregar(caixa, chave, corpoDaFila, recusa.body.error);
  expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
  return {
    produtoId: p,
    gaveta,
    chave,
    original: original.body as { id: string; number: number },
    pendenciaId: entregue.body.pendencia.id as string,
    entregue: entregue.body.pendencia as Record<string, unknown>,
  };
}

// ============================================================================

describe('a pendência diz qual venda a chave registrou', () => {
  it('a lista traz a venda #N da chave, com o que ela registrou', async () => {
    const c = await pendenciaDeChaveReusada();
    expect(c.entregue.vendaDaChave).toMatchObject({
      id: c.original.id,
      number: c.original.number,
      totalCents: 10_000,
      status: 'completed',
    });

    const lista = await request(app).get('/api/v1/core/offline-sales').set(gerente);
    expect(lista.status).toBe(200);
    const item = (lista.body.items as { id: string; vendaDaChave: { items: { quantity: number }[] } }[]).find(
      (i) => i.id === c.pendenciaId,
    );
    expect(item?.vendaDaChave.items).toEqual([{ description: expect.any(String), quantity: 2 }]);
  });

  it('a pendência sem venda na chave (caixa fechado) não traz venda nenhuma', async () => {
    const p = await produto(10);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const entregue = await entregar(
      caixa,
      chave,
      { cashSessionId: turno, items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5000 }] },
      { code: 'CORE_CASH_SESSION_CLOSED', message: 'O caixa informado já foi fechado.' },
    );
    expect(entregue.status).toBe(201);
    expect(entregue.body.pendencia.vendaDaChave).toBeNull();
  });
});

describe('relançar como venda nova', () => {
  it('vende UMA vez a mercadoria da pendência na gaveta aberta, e a venda #N fica como está', async () => {
    const c = await pendenciaDeChaveReusada();
    expect(saldo(c.produtoId)).toBe(8);
    const antes = vendas();

    const r = await relancarComoNova(caixa, c.pendenciaId, c.gaveta);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.duplicated).toBe(false);
    expect(r.body.sale.id).not.toBe(c.original.id);
    expect(r.body.sale.total_cents).toBe(15_000);

    // UMA venda a mais, com os itens da pendência; a #N intacta.
    expect(vendas()).toBe(antes + 1);
    expect(saldo(c.produtoId)).toBe(5);
    const original = getConnection()
      .prepare('SELECT status, total_cents, idempotency_key FROM core_sales WHERE id = ?')
      .get(c.original.id) as { status: string; total_cents: number; idempotency_key: string };
    expect(original).toEqual({ status: 'completed', total_cents: 10_000, idempotency_key: c.chave });

    // A venda nova tem chave PRÓPRIA — a da pendência — e não a reusada.
    const nova = getConnection()
      .prepare('SELECT idempotency_key, cash_session_id FROM core_sales WHERE id = ?')
      .get(r.body.sale.id as string) as { idempotency_key: string; cash_session_id: string };
    expect(nova.idempotency_key).toBe(chaveDaVendaNovaDaPendencia(c.pendenciaId));
    expect(nova.idempotency_key).not.toBe(c.chave);
    expect(nova.cash_session_id).toBe(c.gaveta);

    // A pendência fecha apontando a venda nova, e a nota nomeia a #N.
    expect(r.body.pendencia).toMatchObject({ status: 'regularizada', saleId: r.body.sale.id });
    expect(String(r.body.pendencia.resolutionNote)).toContain(`#${c.original.number}`);

    // A trilha: a venda nasceu de uma pendência, como venda nova, e diz qual
    // venda a chave original registrou.
    const criada = auditoria('sale.create', r.body.sale.id as string);
    expect(criada).toHaveLength(1);
    expect(criada[0].detail).toMatchObject({
      offlinePendingId: c.pendenciaId,
      relancadaComoVendaNova: true,
      vendaDaChaveOriginal: { id: c.original.id, number: c.original.number },
    });
    const regularizada = auditoria('sale.offline.regularized', c.pendenciaId);
    expect(regularizada).toHaveLength(1);
    expect(regularizada[0].detail).toMatchObject({
      saleId: r.body.sale.id,
      comoVendaNova: true,
      chaveOriginal: c.chave,
      vendaDaChaveOriginal: { id: c.original.id, number: c.original.number },
    });
  });

  it('repetir o pedido não vende de novo', async () => {
    const c = await pendenciaDeChaveReusada();
    expect((await relancarComoNova(caixa, c.pendenciaId, c.gaveta)).status).toBe(201);
    const depois = vendas();

    const outra = await relancarComoNova(gerente, c.pendenciaId, c.gaveta);
    expect(outra.status).toBe(409);
    expect(outra.body.error.code).toBe('CORE_OFFLINE_SALE_NOT_PENDING');
    expect(vendas()).toBe(depois);
    expect(saldo(c.produtoId)).toBe(5);
  });

  it('a venda nova que já nasceu (commit sem resposta) é devolvida, e não vendida outra vez', async () => {
    const c = await pendenciaDeChaveReusada();
    // A tentativa anterior gravou a venda com a chave da pendência e caiu
    // antes de fechar a pendência.
    const primeira = createSale({
      companyId: LOJA,
      userId: 'caixa-venda-nova',
      idempotencyKey: chaveDaVendaNovaDaPendencia(c.pendenciaId),
      items: [{ productId: c.produtoId, quantity: 3, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
      cashSessionId: c.gaveta,
    });
    const antes = vendas();

    const r = await relancarComoNova(caixa, c.pendenciaId, c.gaveta);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.duplicated).toBe(true);
    expect(r.body.sale.id).toBe(primeira.sale.id);
    expect(vendas()).toBe(antes);
    expect(r.body.pendencia).toMatchObject({ status: 'regularizada', saleId: primeira.sale.id });
  });

  it('sem venda na chave, a rota recusa: a saída é o relançamento comum', async () => {
    const p = await produto(10);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const entregue = await entregar(
      caixa,
      chave,
      { cashSessionId: turno, items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5000 }] },
      { code: 'CORE_CASH_SESSION_CLOSED', message: 'O caixa informado já foi fechado.' },
    );
    const antes = vendas();

    const r = await relancarComoNova(caixa, entregue.body.pendencia.id as string, turno);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_OFFLINE_SALE_KEY_NOT_REUSED');
    expect(r.body.error.message).toMatch(/Relançar na gaveta aberta/);
    expect(vendas()).toBe(antes);
    expect(saldo(p)).toBe(10);
  });

  it('com a MESMA mercadoria na chave, recusa: vender com chave nova seria vender em dobro', async () => {
    /*
      A pendência nasceu de uma recusa comum (caixa fechado), e depois a MESMA
      venda subiu por outro caminho com a mesma chave. Ali a venda da pendência
      JÁ existe: o relançamento comum a devolve (duplicated), e a venda nova
      seria a segunda cópia do mesmo atendimento.
    */
    const p = await produto(10);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      cashSessionId: turno,
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    };
    const entregue = await entregar(caixa, chave, corpo, { code: 'CORE_CASH_SESSION_CLOSED', message: 'fechado' });
    expect(entregue.status).toBe(201);
    expect((await vender(caixa, chave, corpo)).status).toBe(201);
    const antes = vendas();

    // A tela não oferece a venda nova: a venda da chave é a desta pendência. A
    // comparação é pela impressão inteira — itens E dinheiro, como a gravada.
    const lista = await request(app).get('/api/v1/core/offline-sales').set(caixa);
    const item = (lista.body.items as { id: string; vendaDaChave: unknown }[]).find(
      (i) => i.id === entregue.body.pendencia.id,
    );
    expect(item?.vendaDaChave).toBeNull();

    const r = await relancarComoNova(caixa, entregue.body.pendencia.id as string, turno);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_OFFLINE_SALE_KEY_NOT_REUSED');
    expect(vendas()).toBe(antes);
    expect(saldo(p)).toBe(9);
  });

  it('sem gaveta aberta de quem relança, a venda nova é recusada e a pendência continua como estava', async () => {
    /*
      `createSale` aceita venda sem gaveta. Aqui não pode: o dinheiro desta
      venda já está numa gaveta, e a venda nova sem gaveta deixaria a sobra sem
      explicação. A recusa é de quem relança — a pendência não a guarda, e
      segue dizendo por que foi recusada (a chave reusada).
    */
    const c = await pendenciaDeChaveReusada();
    /*
      A gaveta em que a venda foi feita FECHA antes: agora sim, nenhuma gaveta
      recebe o dinheiro. Este caso deixava a gaveta da venda aberta e esperava
      a recusa, porque a rota só olhava a gaveta de quem relança. Com
      G-offline-sync-10, a gaveta da venda ainda aberta recebe o relançamento
      mesmo sem gaveta no pedido — é onde o dinheiro está (o caso seguinte).
    */
    const esperado = (
      getConnection()
        .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM core_cash_movements WHERE session_id = ?')
        .get(c.gaveta) as { t: number }
    ).t;
    const fechou = await request(app).post(`/api/v1/core/cash/${c.gaveta}/close`).set(gerente).send({
      countedCents: esperado,
      pendenciasCiente: true,
      pendenciasMotivo: 'o gerente relança a venda nova no turno seguinte',
    });
    expect(fechou.status, JSON.stringify(fechou.body)).toBe(200);
    const antes = vendas();
    const r = await relancarComoNova(caixa, c.pendenciaId, null);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(vendas()).toBe(antes);
    const pendencia = getConnection()
      .prepare('SELECT status, error_code FROM core_offline_sale_pendings WHERE id = ?')
      .get(c.pendenciaId) as { status: string; error_code: string };
    expect(pendencia.status).toBe('pendente');
    expect(pendencia.error_code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
  });

  it('sem gaveta no pedido e com a gaveta da venda ABERTA, a venda nova entra nela (G-offline-sync-10)', async () => {
    // O dinheiro desta venda está na gaveta em que ela foi feita, e ela segue
    // aberta: o relançamento entra nela, venha de onde vier — inclusive do
    // escritório, sem gaveta nenhuma no computador de quem relança.
    const c = await pendenciaDeChaveReusada();
    const r = await relancarComoNova(gerente, c.pendenciaId, null);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const nova = getConnection()
      .prepare('SELECT cash_session_id FROM core_sales WHERE id = ?')
      .get(r.body.sale.id as string) as { cash_session_id: string };
    expect(nova.cash_session_id).toBe(c.gaveta);
  });

  it('a recusa de quem vende (estoque que acabou) fica na pendência, e nada é vendido', async () => {
    const c = await pendenciaDeChaveReusada();
    // A prateleira zerou depois da venda #N: não há as 3 da pendência.
    getConnection()
      .prepare('UPDATE core_stock SET quantity = 1 WHERE company_id = ? AND product_id = ?')
      .run(LOJA, c.produtoId);
    const antes = vendas();
    const r = await relancarComoNova(caixa, c.pendenciaId, c.gaveta);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
    expect(vendas()).toBe(antes);
    const pendencia = getConnection()
      .prepare('SELECT status, error_code FROM core_offline_sale_pendings WHERE id = ?')
      .get(c.pendenciaId) as { status: string; error_code: string };
    expect(pendencia).toEqual({ status: 'pendente', error_code: 'CORE_INSUFFICIENT_STOCK' });
    // A venda #N da chave continua sendo apontada: a tela ainda sabe o caso.
    const lista = await request(app).get('/api/v1/core/offline-sales').set(caixa);
    const item = (lista.body.items as { id: string; vendaDaChave: { number: number } | null }[]).find(
      (i) => i.id === c.pendenciaId,
    );
    expect(item?.vendaDaChave?.number).toBe(c.original.number);
  });
});

/*
  ============================================================================
  A FILA NÃO ENTREGA "ERRO INTERNO." (P00-pdv-cab)
  ============================================================================

  O corpo guardado é o que o navegador montou meses atrás, e a entrega dele
  confere apenas que `items` é uma LISTA (`registrarVendaOfflineRecusada`). Uma
  linha sem `productId` ali dentro seguia para `createSale` como a linha de
  qualquer venda — e era 500 API_UNAVAILABLE com pilha no log, na tela onde o
  gestor tenta salvar uma venda que já aconteceu, sem nenhuma pista do que
  fazer. As duas portas de relançamento passam pelo mesmo guarda de forma;
  este caso prova que as duas recusam com 4xx e com o motivo, e que a recusa
  fica GRAVADA na pendência (é lá que a próxima pessoa vai ler).
*/
describe('a venda guardada malformada é recusada com motivo, e não com "Erro interno."', () => {
  /** A pendência cuja chave já registrou outra venda, com a linha sem produto. */
  async function pendenciaSemProduto() {
    const p = await produto(10);
    const gaveta = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const original = await vender(caixa, chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(original.status, JSON.stringify(original.body)).toBe(201);
    const corpoDaFila = {
      cashSessionId: gaveta,
      // A linha que o PDV montou sem dizer QUAL produto.
      items: [{ quantity: 3, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    };
    const entregue = await entregar(caixa, chave, corpoDaFila, {
      code: 'CORE_IDEMPOTENCY_KEY_REUSED',
      message: 'A chave já registrou outra venda.',
    });
    expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
    return { gaveta, pendenciaId: entregue.body.pendencia.id as string };
  }

  it('relançar como venda nova: 400 nomeado dizendo QUAL linha, e nada é vendido', async () => {
    const c = await pendenciaSemProduto();
    const antes = vendas();
    const r = await relancarComoNova(caixa, c.pendenciaId, c.gaveta);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_SALE_ITEM_PRODUCT_REQUIRED');
    expect(r.body.error.message).toContain('linha 1');
    expect(vendas()).toBe(antes);
    // A recusa fica na pendência: a próxima pessoa lê o motivo verdadeiro.
    const lista = await request(app).get('/api/v1/core/offline-sales').set(gerente);
    const item = (lista.body.items as { id: string; errorCode: string; status: string }[]).find(
      (i) => i.id === c.pendenciaId,
    );
    expect(item?.status).toBe('pendente');
    expect(item?.errorCode).toBe('CORE_SALE_ITEM_PRODUCT_REQUIRED');
  });

  it('o relançamento comum recusa igual: mesma classe, mesma porta', async () => {
    const c = await pendenciaSemProduto();
    const antes = vendas();
    const r = await request(app)
      .post(`/api/v1/core/offline-sales/${c.pendenciaId}/relaunch`)
      .set(caixa)
      .send({ cashSessionId: c.gaveta, terminalId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_SALE_ITEM_PRODUCT_REQUIRED');
    expect(vendas()).toBe(antes);
  });
});

describe('quem pode', () => {
  it('outra empresa não enxerga a pendência (404), e nada é vendido', async () => {
    const c = await pendenciaDeChaveReusada();
    const vizinho = await entrar(OUTRA, 'gerente-vizinho-venda-nova', 'gerente_loja');
    const antes = vendas();
    const r = await relancarComoNova(vizinho, c.pendenciaId, null);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('CORE_OFFLINE_SALE_NOT_FOUND');
    expect(vendas()).toBe(antes);
  });

  it('quem não vende não relança: o mesmo alcance de POST /sales', async () => {
    const c = await pendenciaDeChaveReusada();
    const estoquista = await entrar(LOJA, 'estoquista-venda-nova', 'estoquista');
    const r = await relancarComoNova(estoquista, c.pendenciaId, c.gaveta);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('API_PERMISSION_DENIED');
  });
});
