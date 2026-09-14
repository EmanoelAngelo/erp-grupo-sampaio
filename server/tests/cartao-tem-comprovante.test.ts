/**
 * ============================================================================
 * O CARTÃO PRECISA DA COBRANÇA QUE O AUTORIZOU (GAP-V48 e GAP-V51)
 * ============================================================================
 *
 * ## O defeito que este arquivo cobra
 *
 * "A venda só fecha depois da confirmação da operadora" era uma regra da TELA.
 * O `PagamentoDialog` via `settled: false` e não lançava a linha. O servidor,
 * por sua vez, conferia da linha de pagamento apenas o método e o valor — nada
 * sobre a ORIGEM dela.
 *
 * Resultado, com maquininha integrada e ligada: um POST /core/sales com
 * `{"method":"credito","amountCents":15000,"status":"settled"}` fechava a
 * venda, baixava o estoque e liquidava o recebível sem que cobrança nenhuma
 * tivesse ido ao aparelho. A brecha não é alcançável pela tela — é alcançável
 * por qualquer cliente de API, que é exatamente quem não tem tela para obedecer.
 *
 * E faltava o avesso: a transação da maquininha não sabia de que VENDA era.
 * Depois de uma reconciliação aprovada, a cobrança e a venda ficavam duas
 * ilhas.
 *
 * ## A falsificação, que é o que dá valor ao teste
 *
 * Não basta provar que a venda fecha com uma cobrança aprovada. É preciso
 * provar que ela NÃO fecha com:
 *
 *   - nenhuma cobrança;
 *   - cobrança de OUTRA EMPRESA do grupo;
 *   - cobrança recusada, ou de status não confirmado;
 *   - cobrança de outro valor, ou de outro método;
 *   - cobrança JÁ GASTA em outra venda.
 *
 * ## E a idempotência que era do grupo inteiro (GAP-V51)
 *
 * O lookup de `idempotencyKey` das transações de terminal não filtrava por
 * empresa. Duas operações mandando a mesma chave — o que um integrador com
 * chaves previsíveis (`venda-1`, a data do dia) faz sem pensar — recebiam a
 * transação UMA DA OUTRA, com valor, bandeira e cartão mascarado juntos.
 * Vazamento de tenant e cobrança que não acontece, no mesmo gesto.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import {
  createAndProcessPaymentTerminalTransactionBackend,
  createPaymentTerminalConfigurationBackend,
  getPaymentTerminalTransactionBackend,
} from '../src/services/payment-terminal/PaymentTerminalService.js';
import { chargeOnTerminal } from '../src/services/core/PdvTerminalService.js';

const app = createApp();
const SENHA = 'Comprovante@Balcao2026';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

let loja: string;
let vizinha: string;
let caixa: Ator;
/** A gerência da loja: cadastra e estoca a mercadoria do teste (PJ-CAIXA — o caixa da loja não administra produto). */
let gerente: Ator;

async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/** Maquininha integrada na operação — é ela que liga a exigência. */
function configurarMaquininha(companyId: string): void {
  createPaymentTerminalConfigurationBackend({
    companyId,
    provider: 'mock',
    active: true,
    displayName: 'Maquininha do balcão',
    idempotencyKey: `cfg-${companyId}-${randomUUID()}`,
  });
}

async function produtoComEstoque(preco: number): Promise<string> {
  const criado = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: `Camiseta ${randomUUID().slice(0, 6)}`, priceCents: preco });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  const productId = criado.body.id as string;

  const carga = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(gerente.auth)
    .send({
      productId,
      movementType: 'in',
      quantity: 20,
      referenceType: 'entrada',
      referenceId: `carga-${productId}`,
    });
  expect(carga.status, JSON.stringify(carga.body)).toBe(201);
  return productId;
}

/** Fecha uma venda de UMA unidade paga só no cartão informado. */
function venderNoCartao(
  productId: string,
  precoCents: number,
  pagamento: Record<string, unknown>,
) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(caixa.auth)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ productId, quantity: 1, unitPriceCents: precoCents }],
      payments: [{ method: 'credito', amountCents: precoCents, status: 'settled', ...pagamento }],
    });
}

beforeEach(async () => {
  resetDbForTests();
  loja = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  vizinha = upsertCompany({
    slug: 'me-mimei',
    legalName: 'Me Mimei Modas Ltda',
    tradeName: 'Me Mimei',
  });
  caixa = await ator('CAIXA.GRINGA', loja, 'operador_caixa_loja');
  gerente = await ator('GERENTE.GRINGA', loja, 'gerente_loja');
});

describe('sem maquininha integrada, nada muda', () => {
  it('o cartão continua sendo lançado à mão contra o comprovante de papel', async () => {
    /*
      Cinco das seis operações não têm maquininha integrada e usam o aparelho
      avulso da adquirente. Exigir transação de um equipamento que não existe
      pararia o balcão delas — a exigência só liga onde há integração.
    */
    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('com maquininha integrada, o cartão exige cobrança aprovada', () => {
  beforeEach(() => configurarMaquininha(loja));

  it('venda de cartão SEM transação é recusada', async () => {
    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {});

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_REF_REQUIRED');
  });

  it('a recusa não deixa venda pela metade: nada baixou do estoque', async () => {
    const productId = await produtoComEstoque(15000);
    await venderNoCartao(productId, 15000, {});

    const saldo = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(loja, productId) as { quantity: number };
    expect(saldo.quantity).toBe(20);
  });

  it('com a cobrança aprovada, a venda fecha', async () => {
    const productId = await produtoComEstoque(15000);
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
    });
    expect(cobranca.settled).toBe(true);

    const res = await venderNoCartao(productId, 15000, {
      providerRef: cobranca.transactionId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // A linha de pagamento guarda a referência — é por ela que a conferência
    // de maquininha chega da venda à cobrança.
    const linha = getConnection()
      .prepare('SELECT provider, provider_ref FROM core_sale_payments WHERE sale_id = ?')
      .get(res.body.id) as { provider: string | null; provider_ref: string | null };
    expect(linha.provider_ref).toBe(cobranca.transactionId);
    expect(linha.provider).toBe('mock');
  });

  it('e a cobrança passa a saber de que venda ela é', async () => {
    const productId = await produtoComEstoque(15000);
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
    });
    const res = await venderNoCartao(productId, 15000, {
      providerRef: cobranca.transactionId,
    });
    expect(res.status).toBe(201);

    const tx = getPaymentTerminalTransactionBackend(loja, cobranca.transactionId) as Record<
      string,
      unknown
    >;
    expect(tx.saleId).toBe(res.body.id);
    expect(tx.saleNumber).toBe(res.body.number);
  });
});

describe('as falsificações', () => {
  beforeEach(() => configurarMaquininha(loja));

  it('cobrança de OUTRA EMPRESA não serve — para esta venda ela não existe', async () => {
    configurarMaquininha(vizinha);
    const daVizinha = await chargeOnTerminal({
      companyId: vizinha,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
    });
    expect(daVizinha.settled).toBe(true);

    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {
      providerRef: daVizinha.transactionId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_NOT_FOUND');
  });

  it('cobrança RECUSADA pela operadora não fecha venda', async () => {
    const recusada = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
      scenario: 'decline',
    });
    expect(recusada.settled).toBe(false);

    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {
      providerRef: recusada.transactionId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_NOT_APPROVED');
  });

  it('cobrança de status NÃO CONFIRMADO não fecha venda', async () => {
    // O caso mais caro do balcão: ninguém sabe se o cliente pagou. Fechar aqui
    // seria entregar mercadoria contra uma dúvida.
    const incerta = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
      scenario: 'timeout_uncertain',
    });
    expect(incerta.needsReconciliation).toBe(true);

    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {
      providerRef: incerta.transactionId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_NOT_APPROVED');
  });

  it('cobrança de OUTRO VALOR não fecha a venda', async () => {
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 9900,
      idempotencyKey: randomUUID(),
    });

    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {
      providerRef: cobranca.transactionId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_AMOUNT_MISMATCH');
  });

  it('cobrança de DÉBITO não fecha linha de crédito', async () => {
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'debito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
    });

    const productId = await produtoComEstoque(15000);
    const res = await venderNoCartao(productId, 15000, {
      providerRef: cobranca.transactionId,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_METHOD_MISMATCH');
  });

  it('a MESMA cobrança não paga duas vendas', async () => {
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
    });

    const productId = await produtoComEstoque(15000);
    const primeira = await venderNoCartao(productId, 15000, {
      providerRef: cobranca.transactionId,
    });
    expect(primeira.status).toBe(201);

    const segunda = await venderNoCartao(productId, 15000, {
      providerRef: cobranca.transactionId,
    });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_ALREADY_USED');
  });

  it('mas o REENVIO da mesma venda continua devolvendo a mesma venda', async () => {
    /*
      A distinção que mantém o balcão de pé: "a mesma cobrança em duas VENDAS"
      é fraude ou engano; "a mesma venda enviada duas vezes" é queda de rede, e
      é o caso normal. A idempotência da venda responde antes de qualquer
      conferência de cartão — se não respondesse, um reenvio levaria
      TX_ALREADY_USED e o operador refaria uma venda que já existia.
    */
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 15000,
      idempotencyKey: randomUUID(),
    });
    const productId = await produtoComEstoque(15000);
    const chave = randomUUID();
    const corpo = {
      items: [{ productId, quantity: 1, unitPriceCents: 15000 }],
      payments: [
        {
          method: 'credito',
          amountCents: 15000,
          status: 'settled',
          providerRef: cobranca.transactionId,
        },
      ],
    };

    const primeira = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', chave)
      .send(corpo);
    expect(primeira.status).toBe(201);

    const reenvio = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', chave)
      .send(corpo);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
  });

  it('a mesma cobrança em DUAS LINHAS da mesma venda também não passa', async () => {
    const cobranca = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'credito',
      amountInCents: 5000,
      idempotencyKey: randomUUID(),
    });

    const productId = await produtoComEstoque(10000);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId, quantity: 1, unitPriceCents: 10000 }],
        payments: [
          { method: 'credito', amountCents: 5000, providerRef: cobranca.transactionId },
          { method: 'credito', amountCents: 5000, providerRef: cobranca.transactionId },
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error?.code).toBe('CORE_SALE_TERMINAL_TX_ALREADY_USED');
  });
});

describe('dinheiro e PIX não passam a exigir maquininha', () => {
  beforeEach(() => configurarMaquininha(loja));

  it('venda em dinheiro fecha como sempre fechou', async () => {
    const productId = await produtoComEstoque(15000);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId, quantity: 1, unitPriceCents: 15000 }],
        payments: [{ method: 'dinheiro', amountCents: 15000 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('PIX continua fechando sem transação de terminal', async () => {
    /*
      PIX tem DOIS caminhos: o do aparelho e o do provedor de cobrança, com QR
      na tela do computador. O segundo é legítimo e não produz transação de
      terminal nenhuma — exigir vínculo ali recusaria um recebimento de verdade.
    */
    const productId = await produtoComEstoque(15000);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId, quantity: 1, unitPriceCents: 15000 }],
        payments: [{ method: 'pix', amountCents: 15000 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('idempotência da maquininha é POR EMPRESA (GAP-V51)', () => {
  it('mesma chave em duas operações cria DUAS cobranças, cada uma da sua', async () => {
    configurarMaquininha(loja);
    configurarMaquininha(vizinha);

    // A chave previsível é o cenário real: integrador que usa o número do
    // cupom, a data do dia, o id do caixa.
    const chave = 'cobranca-do-dia-1';

    const daLoja = (await createAndProcessPaymentTerminalTransactionBackend({
      companyId: loja,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 15000,
      idempotencyKey: chave,
    })) as Record<string, unknown>;

    const daVizinha = (await createAndProcessPaymentTerminalTransactionBackend({
      companyId: vizinha,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 22000,
      idempotencyKey: chave,
    })) as Record<string, unknown>;

    // Antes, a segunda chamada devolvia a transação da PRIMEIRA empresa — com
    // valor, bandeira e cartão mascarado dela.
    expect(daVizinha.id).not.toBe(daLoja.id);
    expect(daVizinha.companyId).toBe(vizinha);
    expect(daVizinha.amountInCents).toBe(22000);
  });

  it('a mesma chave DENTRO da empresa continua devolvendo a mesma cobrança', async () => {
    // O reenvio por queda de rede não pode cobrar o cliente duas vezes: a
    // cerca por empresa não afrouxa a idempotência, só a torna honesta.
    configurarMaquininha(loja);
    const chave = 'cobranca-do-dia-2';

    const primeira = (await createAndProcessPaymentTerminalTransactionBackend({
      companyId: loja,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 15000,
      idempotencyKey: chave,
    })) as Record<string, unknown>;
    const reenvio = (await createAndProcessPaymentTerminalTransactionBackend({
      companyId: loja,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 15000,
      idempotencyKey: chave,
    })) as Record<string, unknown>;

    expect(reenvio.id).toBe(primeira.id);
  });

  it('configuração de maquininha também é cercada por empresa', async () => {
    // Mesmo defeito, mesma tabela de chaves: a segunda empresa recebia a
    // configuração da primeira e ficava sem maquininha nenhuma.
    const chave = `cfg-compartilhada-${randomUUID()}`;
    const primeira = createPaymentTerminalConfigurationBackend({
      companyId: loja,
      provider: 'mock',
      active: true,
      idempotencyKey: chave,
    }) as Record<string, unknown>;
    const segunda = createPaymentTerminalConfigurationBackend({
      companyId: vizinha,
      provider: 'mock',
      active: true,
      idempotencyKey: chave,
    }) as Record<string, unknown>;

    expect(segunda.id).not.toBe(primeira.id);
    expect(segunda.companyId).toBe(vizinha);
  });
});
