/**
 * ============================================================================
 * O CAIXA DA OFICINA — receber a OS com a cesta do PDV, repetir sem duplicar,
 * e estornar o recebimento sem SQL (GAP-PRD-042, 104, 209, 105)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-042: a fila `GET /workshop/pending-payment` não tinha tela e
 *     devolvia a linha crua da OS (sem nome de cliente, sem aparelho). O caixa
 *     da oficina mora no ambiente `pdv` e não alcança a ficha da OS.
 *   - GAP-PRD-104: o recebimento tinha UMA forma, valor cheio, sem desconto
 *     autorizado, sem fiado, sem maquininha vinculada.
 *   - GAP-PRD-209: repetir o POST com a mesma Idempotency-Key devolvia 409 em
 *     vez da resposta original — o cliente que perdeu a resposta ficava sem ela.
 *   - GAP-PRD-105: OS paga não tinha caminho de volta; cancelar a venda deixava
 *     a OS "finalizada" apontando para venda cancelada.
 *
 * ## E o que este arquivo achou no caminho
 *
 * A chave do recebimento descia CRUA para `createSale`, que procura venda por
 * chave na empresa inteira. A Idempotency-Key de uma venda de balcão reenviada
 * no recebimento da OS devolvia AQUELA venda como "duplicada" — e a OS era
 * finalizada apontando para a venda de outra pessoa. É a obrigação que o
 * cabeçalho de `createSale` impõe a quem chama a partir de documento: o
 * namespace mora em quem conhece o documento.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { createPaymentTerminalConfigurationBackend } from '../src/services/payment-terminal/PaymentTerminalService.js';
import { grantCredit } from '../src/services/core/CustomerCreditService.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';

/*
  UMA INSTÂNCIA DE APP POR TESTE (RES-IDEM-VIZ).

  `createApp()` monta um `express-rate-limit` de 300 requisições por minuto,
  com armazenamento próprio por instância. Com a app única do arquivo, os 28
  testes (cinco logins cada, no `beforeEach`, mais os recebimentos) passaram do
  teto dentro do mesmo minuto, e os últimos voltavam 429 no login — um
  vermelho que não é da oficina. A instância nova zera o contador sem tocar no
  limitador, que continua valendo em produção (o mesmo remédio de
  `contador-varredura-das-rotas.test.ts`). O token é JWT: vale em qualquer
  instância, porque o segredo e o banco são os mesmos.
*/
let app: ReturnType<typeof createApp> = createApp();

const OFICINA = 'oficina-cx';
const PJ = 'pj-cx';
const CPF_VALIDO = '529.982.247-25';

interface Ator {
  auth: { Authorization: string };
  userId: string;
  login: string;
}

let gerente: Ator;
let mecanico: Ator;
let caixa: Ator;
let gestor: Ator;
let gerentePj: Ator;
let workshopId: string;
let seq = 0;

async function entrar(userId: string, empresa: string, perfil: string): Promise<Ator> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
    login: `${userId}@${empresa}`,
  };
}

beforeEach(async () => {
  app = createApp();
  resetDbForTests();
  seq = 0;
  gerente = await entrar('ger-cx', OFICINA, 'gerente_oficina');
  mecanico = await entrar('mec-cx', OFICINA, 'mecanico');
  caixa = await entrar('cx-cx', OFICINA, 'operador_caixa_oficina');
  gestor = await entrar('gestor-cx', OFICINA, 'gestor');
  gerentePj = await entrar('ger-pj-cx', PJ, 'gerente_oficina');

  workshopId = 'wk-cx';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-cx', 'Bancada CX', 'mobility', 1, ?)`,
    )
    .run(workshopId, OFICINA, new Date().toISOString());
  // O mecânico é da bancada; o caixa, como no banco da loja, NÃO é.
  getConnection()
    .prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), workshopId, mecanico.userId, new Date().toISOString());
});

async function clienteDoCadastro(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/customers')
    .set(gerente.auth)
    .send({ name: 'Dona Marta', document: CPF_VALIDO, phone: '53 99999-0000' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

/** OS com mão de obra (em centavos) concluída pelo mecânico — na fila do caixa. */
async function osNaFila(laborCents = 20000, customerId?: string): Promise<string> {
  seq += 1;
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente.auth)
    .send({
      workshopId,
      customerId,
      customerName: customerId ? undefined : `Cliente ${seq}`,
      complaint: 'Não liga',
    });
  expect(os.status, JSON.stringify(os.body)).toBe(201);
  const id = String(os.body.id);
  await request(app)
    .post(`/api/v1/core/workshop/orders/${id}/assume`)
    .set(mecanico.auth)
    .send({ status: 'em_andamento', comment: 'assumindo' })
    .expect(200);
  await request(app)
    .post(`/api/v1/core/workshop/orders/${id}/labor`)
    .set(mecanico.auth)
    .send({ laborCents })
    .expect(200);
  const fim = await request(app)
    .post(`/api/v1/core/workshop/orders/${id}/complete`)
    .set(mecanico.auth)
    .send({ diagnosis: 'Controlador trocado', hasCost: true, forcarChecklist: true });
  expect(fim.status, JSON.stringify(fim.body)).toBe(200);
  expect(fim.body.status).toBe('aguardando_pagamento');
  return id;
}

async function abrirCaixa(quem: Ator = caixa): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/cash/open')
    .set(quem.auth)
    .send({ openingCents: 10000 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function receber(osId: string, corpo: Record<string, unknown>, chave?: string, quem = caixa) {
  const req = request(app).post(`/api/v1/core/workshop/orders/${osId}/checkout`).set(quem.auth);
  if (chave) req.set('Idempotency-Key', chave);
  return req.send(corpo);
}

function linhaDaOs(osId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_service_orders WHERE id = ?')
    .get(osId) as Record<string, unknown>;
}

function contar(sql: string, ...params: unknown[]): number {
  return (getConnection().prepare(sql).get(...(params as never[])) as { n: number }).n;
}

// ============================================================================

describe('GAP-PRD-042 — a fila do caixa da oficina', () => {
  it('o caixa (sem vínculo de bancada) lê a fila com cliente, aparelho e total', async () => {
    const customerId = await clienteDoCadastro();
    const osId = await osNaFila(15000, customerId);

    const fila = await request(app).get('/api/v1/core/workshop/pending-payment').set(caixa.auth);
    expect(fila.status, JSON.stringify(fila.body)).toBe(200);
    expect(fila.body.temOficina).toBe(true);
    expect(fila.body.total).toBe(1);
    const [linha] = fila.body.items as Record<string, unknown>[];
    expect(linha.id).toBe(osId);
    expect(linha.customer_display).toBe('Dona Marta');
    expect(linha.total_cents).toBe(15000);
    expect(linha.workshop_name).toBe('Bancada CX');
    // A política do fiado viaja com a fila: é o caixa quem a lê, e a rota da
    // política é de gerente.
    expect(fila.body.faturamentoAPrazo).toEqual({ habilitado: false, prazoDias: 0 });
  });

  it('o mecânico não lê a fila de dinheiro', async () => {
    const res = await request(app).get('/api/v1/core/workshop/pending-payment').set(mecanico.auth);
    expect(res.status).toBe(403);
  });

  it('empresa sem oficina responde temOficina=false — o PDV não oferece o botão', async () => {
    const pj = await request(app).get('/api/v1/core/workshop/pending-payment').set(gerentePj.auth);
    expect(pj.status).toBe(200);
    expect(pj.body.temOficina).toBe(false);
    expect(pj.body.items).toEqual([]);
  });
});

describe('GAP-PRD-104 — o recebimento com a cesta do PDV', () => {
  it('divide entre PIX e dinheiro, calcula o troco e lança só a espécie na gaveta', async () => {
    const osId = await osNaFila(27990);
    const gaveta = await abrirCaixa();

    const res = await receber(
      osId,
      {
        cashSessionId: gaveta,
        payments: [
          { method: 'pix', amountCents: 10000 },
          { method: 'dinheiro', amountCents: 20000 },
        ],
      },
      'rec-split',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.order.status).toBe('finalizada');
    expect(res.body.sale.total_cents).toBe(27990);
    expect(res.body.sale.change_cents).toBe(2010);

    const meios = getConnection()
      .prepare('SELECT method, amount_cents FROM core_sale_payments WHERE sale_id = ? ORDER BY method')
      .all(res.body.sale.id) as { method: string; amount_cents: number }[];
    expect(meios).toEqual([
      { method: 'dinheiro', amount_cents: 20000 },
      { method: 'pix', amount_cents: 10000 },
    ]);
    // Na gaveta entra o dinheiro que FICOU: 20.000 recebidos menos 2.010 de troco.
    const naGaveta = contar(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM core_cash_movements
        WHERE session_id = ? AND reference_type = 'sale' AND reference_id = ?`,
      gaveta,
      res.body.sale.id,
    );
    expect(naGaveta).toBe(17990);
  });

  it('desconto dentro da alçada do caixa entra, fica na venda e reduz o título', async () => {
    const osId = await osNaFila(20000);
    const res = await receber(
      osId,
      { discountCents: 1500, payments: [{ method: 'pix', amountCents: 18500 }] },
      'rec-desc',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.sale.total_cents).toBe(18500);
    const venda = getConnection()
      .prepare('SELECT discount_cents, subtotal_cents FROM core_sales WHERE id = ?')
      .get(res.body.sale.id) as { discount_cents: number; subtotal_cents: number };
    expect(venda).toEqual({ discount_cents: 1500, subtotal_cents: 20000 });
    const titulo = contar(
      "SELECT amount_cents AS n FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?",
      res.body.sale.id,
    );
    expect(titulo).toBe(18500);
  });

  it('desconto acima da alçada pede gestor — e a liberação dele fecha o recebimento', async () => {
    const osId = await osNaFila(20000);
    const corpo = { discountCents: 5000, payments: [{ method: 'pix', amountCents: 15000 }] };

    const recusa = await receber(osId, corpo, 'rec-alcada');
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(403);
    expect(recusa.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(recusa.body.error.details.brutoCents).toBe(20000);
    expect(String(linhaDaOs(osId).status)).toBe('aguardando_pagamento');

    const liberacao = await request(app)
      .post('/api/v1/core/authorizations')
      .set(caixa.auth)
      .send({
        action: 'desconto_acima_limite',
        login: gestor.login,
        password: TEST_PASSWORD,
        concedidoCents: 5000,
        brutoCents: 20000,
        reason: 'Cliente antigo',
      });
    expect(liberacao.status, JSON.stringify(liberacao.body)).toBe(201);

    const certo = await receber(osId, { ...corpo, authorizationId: liberacao.body.id }, 'rec-alcada');
    expect(certo.status, JSON.stringify(certo.body)).toBe(201);
    expect(certo.body.sale.total_cents).toBe(15000);
    // A liberação foi GASTA nesta venda — não vale para a próxima OS.
    const gasta = getConnection()
      .prepare('SELECT consumed_ref_id FROM core_authorizations WHERE id = ?')
      .get(liberacao.body.id) as { consumed_ref_id: string };
    expect(gasta.consumed_ref_id).toBe(certo.body.sale.id);
  });

  it('pagar menos que o total, sem desconto, continua recusado com o buraco em centavos', async () => {
    const osId = await osNaFila(20000);
    const res = await receber(osId, { payments: [{ method: 'dinheiro', amountCents: 15000 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PAYMENT_MISMATCH');
    expect(res.body.error.details.missing).toBe(5000);
  });

  it('com maquininha integrada, cartão sem a cobrança que o autorizou é recusado; com ela, a venda leva o provedor', async () => {
    createPaymentTerminalConfigurationBackend({
      companyId: OFICINA,
      provider: 'mock',
      active: true,
      displayName: 'Maquininha da oficina',
      idempotencyKey: `cfg-${randomUUID()}`,
    });
    const osId = await osNaFila(20000);

    const semCobranca = await receber(osId, {
      payments: [{ method: 'credito', amountCents: 20000 }],
    });
    expect(semCobranca.status, JSON.stringify(semCobranca.body)).toBe(400);
    expect(semCobranca.body.error.code).toBe('CORE_SALE_TERMINAL_REF_REQUIRED');

    const cobranca = await request(app)
      .post('/api/v1/core/pdv/terminal/charge')
      .set(caixa.auth)
      .set('Idempotency-Key', `cobranca-${randomUUID()}`)
      .send({ method: 'credito', amountInCents: 20000 });
    expect(cobranca.status, JSON.stringify(cobranca.body)).toBe(200);
    expect(cobranca.body.settled).toBe(true);

    const res = await receber(
      osId,
      {
        payments: [
          { method: 'credito', amountCents: 20000, providerRef: cobranca.body.transactionId },
        ],
      },
      'rec-cartao',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const linha = getConnection()
      .prepare('SELECT provider, provider_ref FROM core_sale_payments WHERE sale_id = ?')
      .get(res.body.sale.id) as { provider: string | null; provider_ref: string | null };
    expect(linha.provider).toBe('mock');
    expect(linha.provider_ref).toBe(cobranca.body.transactionId);
  });

  it('fiado: desligado por padrão; ligado, fatura para o cliente do cadastro com o prazo da política', async () => {
    const customerId = await clienteDoCadastro();
    const osId = await osNaFila(20000, customerId);

    const desligado = await receber(osId, { payments: [] });
    expect(desligado.status, JSON.stringify(desligado.body)).toBe(400);
    expect(desligado.body.error.code).toBe('CORE_WORKSHOP_CREDIT_DISABLED');

    const politica = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(gerente.auth)
      .send({ creditSaleDueDays: 30, workshopCreditEnabled: true });
    expect(politica.status, JSON.stringify(politica.body)).toBe(200);
    expect(politica.body.workshopCreditEnabled).toBe(true);
    expect(politica.body.definidos.workshopCreditEnabled).toBe(true);

    const fila = await request(app).get('/api/v1/core/workshop/pending-payment').set(caixa.auth);
    expect(fila.body.faturamentoAPrazo).toEqual({ habilitado: true, prazoDias: 30 });

    const res = await receber(osId, { payments: [] }, 'rec-fiado');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const titulo = getConnection()
      .prepare(
        `SELECT status, amount_cents, customer_id, due_date FROM core_finance_entries
          WHERE origin_type = 'sale' AND origin_id = ? AND direction = 'in'`,
      )
      .get(res.body.sale.id) as {
      status: string;
      amount_cents: number;
      customer_id: string;
      due_date: string;
    };
    expect(titulo.status).toBe('open');
    expect(titulo.amount_cents).toBe(20000);
    expect(titulo.customer_id).toBe(customerId);
    const venda = getConnection()
      .prepare('SELECT created_at FROM core_sales WHERE id = ?')
      .get(res.body.sale.id) as { created_at: string };
    const dias = Math.round(
      (Date.parse(`${titulo.due_date.slice(0, 10)}T12:00:00Z`)
        - Date.parse(`${venda.created_at.slice(0, 10)}T12:00:00Z`))
        / 86_400_000,
    );
    // O dia da loja pode ser o de ontem em UTC perto da meia-noite — por isso
    // a faixa de um dia, e não o número exato.
    expect(dias).toBeGreaterThanOrEqual(29);
    expect(dias).toBeLessThanOrEqual(31);

    // O comprovante diz que é a prazo — sem meio de pagamento, o papel não
    // pode parecer "pago".
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixa.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: res.body.sale.id });
    const papel = await request(app)
      .get(`/api/v1/core/print/jobs/${job.body.id}/document`)
      .set(caixa.auth);
    expect(papel.text).toContain('A PRAZO — conta a receber');
  });

  it('o vale do cliente cobrindo a OS inteira NÃO é fiado — passa com a política desligada', async () => {
    const customerId = await clienteDoCadastro();
    grantCredit({
      companyId: OFICINA,
      customerId,
      amountCents: 30000,
      originType: 'sale_return',
      originId: 'devolucao-anterior',
      description: 'Devolução anterior',
    });
    const osId = await osNaFila(20000, customerId);
    const res = await receber(osId, { payments: [], customerCreditCents: 20000 }, 'rec-vale');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.order.status).toBe('finalizada');
    // E o que sobra do vale continua no saldo — não vira troco.
    const saldo = await request(app)
      .get(`/api/v1/core/customers/${customerId}/credits`)
      .set(gerente.auth);
    expect(saldo.body.balance).toBe(10000);
  });

  it('fiado de OS sem cliente do cadastro é recusado com o gesto que resolve', async () => {
    await request(app)
      .put('/api/v1/core/sale-policies')
      .set(gerente.auth)
      .send({ workshopCreditEnabled: true })
      .expect(200);
    const osId = await osNaFila(20000);
    const res = await receber(osId, { payments: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_CREDIT_NEEDS_CUSTOMER');
  });

  it('o comprovante da OS sai pela fila de impressão com a linha do serviço e as formas', async () => {
    const osId = await osNaFila(20000);
    const pago = await receber(
      osId,
      {
        payments: [
          { method: 'pix', amountCents: 5000 },
          { method: 'debito', amountCents: 15000 },
        ],
      },
      'rec-papel',
    );
    expect(pago.status, JSON.stringify(pago.body)).toBe(201);
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixa.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: pago.body.sale.id });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const papel = await request(app)
      .get(`/api/v1/core/print/jobs/${job.body.id}/document`)
      .set(caixa.auth);
    expect(papel.status).toBe(200);
    const numero = Number(linhaDaOs(osId).number);
    // A venda da OS sai itemizada (junção FIS × OFI, GAP-PRD-024/101): a mão de obra
    // tem a descrição que a NFS-e usa, e é ela que o comprovante imprime.
    expect(papel.text).toContain(`Mão de obra — OS #${numero}`);
    // As formas saem com o nome que o cliente lê (PrintRenderer.rotuloDoMeio), não o código.
    expect(papel.text).toContain('PIX');
    expect(papel.text).toContain('Cartão de débito');
    expect(papel.text).toContain('COMPROVANTE NÃO FISCAL');
  });

  it('a chave de uma venda de balcão NÃO finaliza a OS com a venda alheia', async () => {
    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(gerente.auth)
      .send({ name: 'Serviço avulso', priceCents: 5000, stockControl: false });
    expect(produto.status, JSON.stringify(produto.body)).toBe(201);
    const balcao = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'mesma-chave')
      .send({
        items: [{ productId: produto.body.id, quantity: 1 }],
        payments: [{ method: 'pix', amountCents: 5000 }],
      });
    expect(balcao.status, JSON.stringify(balcao.body)).toBe(201);

    const osId = await osNaFila(20000);
    const res = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, 'mesma-chave');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.sale.id).not.toBe(balcao.body.id);
    expect(res.body.sale.total_cents).toBe(20000);
    expect(linhaDaOs(osId).sale_id).toBe(res.body.sale.id);
  });
});

describe('GAP-PRD-209 — repetir o recebimento devolve o que aconteceu', () => {
  it('mesma Idempotency-Key: 200 com a MESMA venda, sem segunda venda nem segundo título', async () => {
    const osId = await osNaFila(20000);
    const corpo = { payments: [{ method: 'pix', amountCents: 20000 }] };
    const primeira = await receber(osId, corpo, 'chave-da-tela');
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);

    const replay = await receber(osId, corpo, 'chave-da-tela');
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replay).toBe(true);
    expect(replay.body.sale.id).toBe(primeira.body.sale.id);
    expect(replay.body.order.status).toBe('finalizada');

    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', OFICINA)).toBe(1);
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale' AND direction = 'in'",
      ),
    ).toBe(1);
  });

  it('sem cabeçalho a chave padrão da OS também repete a resposta', async () => {
    const osId = await osNaFila(20000);
    const corpo = { payments: [{ method: 'pix', amountCents: 20000 }] };
    const primeira = await receber(osId, corpo);
    expect(primeira.status).toBe(201);
    const replay = await receber(osId, corpo);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.sale.id).toBe(primeira.body.sale.id);
  });

  /*
    A MESMA CHAVE COM OUTRO DINHEIRO NÃO É O MESMO RECEBIMENTO (RES-IDEM-VIZ).

    O replay devolvia a venda da chave sem olhar o corpo: o recebimento feito
    em PIX, repetido com a mesma chave em dinheiro, respondia 200 com a venda
    do PIX — e a gaveta ficava esperando um dinheiro que nunca entrou nela.
  */
  it('mesma Idempotency-Key com OUTRO pagamento ou desconto: 422, e nada muda', async () => {
    const osId = await osNaFila(20000);
    const gaveta = await abrirCaixa();
    const primeira = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }], cashSessionId: gaveta }, 'chave-os-dinheiro');
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    const vendas = contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', OFICINA);
    const caixaAntes = contar('SELECT COUNT(*) AS n FROM core_cash_movements WHERE session_id = ?', gaveta);

    for (const corpo of [
      { payments: [{ method: 'dinheiro', amountCents: 20000 }], cashSessionId: gaveta },
      { payments: [{ method: 'pix', amountCents: 19000 }], discountCents: 1000, cashSessionId: gaveta },
    ]) {
      const outra = await receber(osId, corpo, 'chave-os-dinheiro');
      expect(outra.status, JSON.stringify(outra.body)).toBe(422);
      expect(outra.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    }
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', OFICINA)).toBe(vendas);
    expect(contar('SELECT COUNT(*) AS n FROM core_cash_movements WHERE session_id = ?', gaveta)).toBe(caixaAntes);

    // O mesmo corpo, noutra gaveta (a do turno seguinte), continua sendo o replay.
    const replay = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, 'chave-os-dinheiro');
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.sale.id).toBe(primeira.body.sale.id);
  });

  it('recebimento anterior à impressão digital: o replay diferente devolve o original, como sempre', async () => {
    const osId = await osNaFila(20000);
    const primeira = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, 'chave-os-antiga');
    expect(primeira.status).toBe(201);
    getConnection().prepare('UPDATE core_sales SET idempotency_fingerprint = NULL WHERE id = ?').run(primeira.body.sale.id as string);
    const replay = await receber(osId, { payments: [{ method: 'debito', amountCents: 20000 }] }, 'chave-os-antiga');
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.sale.id).toBe(primeira.body.sale.id);
  });

  it('OUTRA chave numa OS já paga continua sendo 409 — é outro recebimento, não um reenvio', async () => {
    const osId = await osNaFila(20000);
    await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, 'a').expect(201);
    const outra = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, 'b');
    expect(outra.status).toBe(409);
    expect(outra.body.error.code).toBe('CORE_ORDER_NOT_AWAITING_PAYMENT');
  });
});

describe('GAP-PRD-105 — estornar o recebimento de uma OS paga', () => {
  async function osPaga(corpo?: Record<string, unknown>): Promise<{ osId: string; saleId: string }> {
    const osId = await osNaFila(20000);
    const res = await receber(
      osId,
      corpo ?? { payments: [{ method: 'pix', amountCents: 20000 }] },
      `paga-${osId}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { osId, saleId: String(res.body.sale.id) };
  }

  it('o gerente da oficina estorna: a venda cai, a OS volta para a fila do caixa e a história conta por quê', async () => {
    const gaveta = await abrirCaixa(gerente);
    const { osId, saleId } = await osPaga({
      cashSessionId: gaveta,
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'Caixa lançou dinheiro, o cliente pagou no PIX' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.status).toBe('aguardando_pagamento');
    expect(res.body.order.sale_id).toBeNull();
    expect(res.body.order.paid_at).toBeNull();
    expect(res.body.sale.status).toBe('cancelled');

    const venda = getConnection()
      .prepare('SELECT status FROM core_sales WHERE id = ?')
      .get(saleId) as { status: string };
    expect(venda.status).toBe('cancelled');
    // O título da venda caiu junto, e a espécie saiu da gaveta.
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ? AND status <> 'cancelled'",
        saleId,
      ),
    ).toBe(0);
    expect(
      contar(
        "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM core_cash_movements WHERE reference_id = ? AND movement_type = 'sale_cancel'",
        saleId,
      ),
    ).toBe(-20000);

    const evento = getConnection()
      .prepare(
        `SELECT from_status, to_status, note, user_id FROM core_service_order_events
          WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(osId) as { from_status: string; to_status: string; note: string; user_id: string };
    expect(evento.from_status).toBe('finalizada');
    expect(evento.to_status).toBe('aguardando_pagamento');
    expect(evento.note).toContain('o cliente pagou no PIX');
    expect(evento.user_id).toBe(gerente.userId);

    const auditoria = getConnection()
      .prepare(
        "SELECT detail FROM core_audit_log WHERE action = 'workshop.order.reversal' AND entity_id = ?",
      )
      .get(osId) as { detail: string } | undefined;
    expect(auditoria).toBeTruthy();
    expect(JSON.parse(auditoria!.detail).saleId).toBe(saleId);

    // E a OS volta a ser cobrável — com chave nova, sem colidir com a antiga.
    const denovo = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, 'nova');
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(201);
    expect(denovo.body.sale.id).not.toBe(saleId);
    expect(linhaDaOs(osId).status).toBe('finalizada');
  });

  it('o reenvio da chave do recebimento estornado NÃO refinaliza a OS com a venda cancelada', async () => {
    const { osId } = await osPaga();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'forma errada' })
      .expect(200);
    const velho = await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }, `paga-${osId}`);
    expect(velho.status, JSON.stringify(velho.body)).toBe(409);
    expect(velho.body.error.code).toBe('CORE_CHECKOUT_REVERSED');
    expect(linhaDaOs(osId).status).toBe('aguardando_pagamento');
  });

  it('a chave padrão (sem cabeçalho) também não colide depois do estorno', async () => {
    const osId = await osNaFila(20000);
    await receber(osId, { payments: [{ method: 'pix', amountCents: 20000 }] }).expect(201);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'forma errada' })
      .expect(200);
    const denovo = await receber(osId, { payments: [{ method: 'debito', amountCents: 20000 }] });
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(201);
    expect(linhaDaOs(osId).status).toBe('finalizada');
  });

  it('sem motivo não há estorno', async () => {
    const { osId } = await osPaga();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerente.auth)
      .send({ reason: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REVERSAL_REASON_REQUIRED');
    expect(linhaDaOs(osId).status).toBe('finalizada');
  });

  it('o caixa não estorna sozinho: pede gestor, e a liberação presa à venda fecha o estorno', async () => {
    const { osId, saleId } = await osPaga();
    const recusa = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(caixa.auth)
      .send({ reason: 'cobrado em dobro' });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(403);
    expect(recusa.body.error.code).toBe('CORE_CANCEL_NEEDS_AUTHORIZATION');
    expect(recusa.body.error.details.referenceId).toBe(saleId);

    const bilhete = await request(app)
      .post('/api/v1/core/authorizations')
      .set(caixa.auth)
      .send({
        action: 'cancelar_venda',
        login: gestor.login,
        password: TEST_PASSWORD,
        referenceId: saleId,
        reason: 'estorno da OS',
      });
    expect(bilhete.status, JSON.stringify(bilhete.body)).toBe(201);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(caixa.auth)
      .send({ reason: 'cobrado em dobro', authorizationId: bilhete.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.status).toBe('aguardando_pagamento');
  });

  it('o mecânico não estorna', async () => {
    const { osId } = await osPaga();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(mecanico.auth)
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('OS que não está paga, ou foi fechada sem custo, não tem recebimento a estornar', async () => {
    const naFila = await osNaFila(20000);
    const r1 = await request(app)
      .post(`/api/v1/core/workshop/orders/${naFila}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'teste' });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('CORE_ORDER_NOT_PAID');

    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ workshopId, customerName: 'Garantia', complaint: 'ruído' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/assume`)
      .set(mecanico.auth)
      .send({ status: 'em_andamento', comment: 'ok' })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/complete`)
      .set(mecanico.auth)
      .send({ diagnosis: 'ajuste', hasCost: false, noCostReason: 'garantia', forcarChecklist: true })
      .expect(200);
    const r2 = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'teste' });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('CORE_ORDER_WITHOUT_SALE');
  });

  it('cancelar a venda da OS pela tela de vendas também reabre a OS — nunca mais finalizada com venda cancelada', async () => {
    const { osId, saleId } = await osPaga();
    const cancel = await request(app)
      .post(`/api/v1/core/sales/${saleId}/cancel`)
      .set(gestor.auth)
      .send({ reason: 'cancelada no escritório' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const os = linhaDaOs(osId);
    expect(os.status).toBe('aguardando_pagamento');
    expect(os.sale_id).toBeNull();
  });

  it('OS legada finalizada apontando para venda JÁ cancelada é reparada pelo estorno, sem mexer na venda', async () => {
    const { osId, saleId } = await osPaga();
    // O estado que o código antigo deixava: venda cancelada, OS finalizada.
    getConnection()
      .prepare("UPDATE core_sales SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .run(new Date().toISOString(), saleId);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'venda cancelada antes da correção' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.status).toBe('aguardando_pagamento');
    expect(res.body.order.sale_id).toBeNull();
  });

  it('a oficina de outra empresa não alcança a OS', async () => {
    const { osId } = await osPaga();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerentePj.auth)
      .send({ reason: 'tentativa de outra empresa' });
    expect(res.status).toBe(404);
    expect(linhaDaOs(osId).status).toBe('finalizada');
  });
});
