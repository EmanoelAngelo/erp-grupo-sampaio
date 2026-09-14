/**
 * ============================================================================
 * A MAQUININHA DE TESTE NÃO OPERA ONDE EXISTE DINHEIRO (GAP-PRD-001)
 * ============================================================================
 *
 * ## O que a auditoria achou no banco real
 *
 * A Preço Justo tem, gravada, uma configuração de maquininha `provider: mock`,
 * `active: true`. Três defeitos se somavam em cima dessa linha:
 *
 *   1. Em produção, `getTerminalStatus` a contava como maquininha integrada:
 *      o cartão passava a exigir cobrança no aparelho, a cobrança batia na
 *      trava do mock (403) e a venda exigia transação que nunca existiria. O
 *      balcão da Preço Justo simplesmente não fechava cartão.
 *   2. `NODE_ENV=production` sem `DEVORA_API_ENV` não ligava a trava — o
 *      padrão desta variável é `development`, e é assim que hospedagem e
 *      container sobem um Node.
 *   3. Não havia rota nem tela para desligar a linha. E mesmo gravando
 *      `active: false` à mão, ela continuava contando: a leitura passava pelo
 *      sanitizador, que descartava o campo `active`.
 *
 * ## O que estes casos cobram
 *
 * - A régua do "ambiente de dinheiro" lê os DOIS nomes (`DEVORA_API_ENV` e
 *   `NODE_ENV`), nas portas de escrita e também na LEITURA.
 * - A linha mock já gravada é IGNORADA em produção: o balcão volta ao cartão
 *   lançado à mão, como as outras cinco operações — em vez de travar.
 * - Configuração desativada não conta.
 * - O gerente desliga (e religa) pela rota, com motivo e auditoria; o caixa
 *   não — desligar a maquininha é desligar a exigência de cobrança aprovada.
 * - Religar o mock em produção é recusado; desligá-lo em produção funciona,
 *   porque é exatamente o caminho de correção da linha da Preço Justo.
 * - A prontidão de go-live denuncia configuração de teste ativa.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'maquininha-teste-jwt-secret-bem-comprido-e-variado';
process.env.DEVORA_ENCRYPTION_KEY = 'maquininha-teste-chave-de-cifra-bem-comprida-e-variada';

const { createApp } = await import('../src/app.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { resetDbForTests, insertRow, findOneRow, findRows, updateRows } = await import(
  '../src/db/database.js'
);
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { issueSession } = await import('../src/services/api/ApiAuthService.js');
const { assertMockProviderAllowed } = await import(
  '../src/services/payment-terminal/PaymentTerminalCredentialService.js'
);
const { processPaymentTerminalTransaction } = await import(
  '../src/services/payment-terminal/PaymentTerminalProviderAdapter.js'
);
const { createPaymentTerminalConfigurationBackend } = await import(
  '../src/services/payment-terminal/PaymentTerminalService.js'
);
const { chargeOnTerminal, getTerminalStatus } = await import(
  '../src/services/core/PdvTerminalService.js'
);
const { listAudit } = await import('../src/services/audit/AuditService.js');
const { evaluateCoreProductionReadiness } = await import(
  '../src/services/system-admin/CoreProductionReadinessService.js'
);

const app = createApp();
const SENHA = 'Maquininha@Teste2026';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

let loja: string;
let vizinha: string;
let caixa: Ator;
let gerente: Ator;
let gerenteVizinha: Ator;

function emAmbiente(apiEnv: 'development' | 'test' | 'staging' | 'production', nodeEnv = 'test') {
  process.env.DEVORA_API_ENV = apiEnv;
  process.env.NODE_ENV = nodeEnv;
  resetEnvCacheForTests();
}

async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/** A linha que a auditoria leu no banco real da Preço Justo, como ela está lá. */
function linhaMockDoBancoReal(companyId: string, id = 'ptcfg-1786588515956') {
  insertRow('payment_terminal_configurations', {
    id,
    companyId,
    provider: 'mock',
    active: true,
    environment: 'sandbox',
    displayName: 'Maquininha do balcao',
    lastTestStatus: 'credit_failed',
  });
  return id;
}

function capturaErro(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
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
      quantity: 5,
      referenceType: 'entrada',
      referenceId: `carga-${productId}`,
    });
  expect(carga.status, JSON.stringify(carga.body)).toBe(201);
  return productId;
}

beforeEach(async () => {
  emAmbiente('test');
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  vizinha = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  caixa = await ator('CAIXA.PJ', loja, 'operador_caixa_loja');
  gerente = await ator('GERENTE.PJ', loja, 'gerente_loja');
  gerenteVizinha = await ator('GERENTE.GRINGA', vizinha, 'gerente_loja');
});

afterEach(() => {
  // Nenhum caso pode vazar "produção" para o vizinho.
  emAmbiente('test');
});

// ============================================================================

describe('NODE_ENV=production também é ambiente de dinheiro', () => {
  it('sem DEVORA_API_ENV declarado, o mock é recusado nas três portas', async () => {
    emAmbiente('development', 'production');

    const erro = capturaErro(() => assertMockProviderAllowed('mock'));
    expect(erro).toMatchObject({ code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION', status: 403 });

    const cfg = capturaErro(() =>
      createPaymentTerminalConfigurationBackend({
        companyId: loja,
        provider: 'mock',
        idempotencyKey: 'cfg-node-env-producao',
      }),
    );
    expect(cfg).toMatchObject({ code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION' });
    expect(
      findOneRow('payment_terminal_configurations', (r) => r.idempotencyKey === 'cfg-node-env-producao'),
    ).toBeNull();

    await expect(
      processPaymentTerminalTransaction(loja, 'mock', { paymentMethod: 'credit', amountInCents: 1000 }),
    ).rejects.toMatchObject({ code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION' });
  });

  it('dev e teste continuam livres para o mock', () => {
    emAmbiente('development', 'development');
    expect(capturaErro(() => assertMockProviderAllowed('mock'))).toBeNull();
    emAmbiente('test', 'test');
    expect(capturaErro(() => assertMockProviderAllowed('mock'))).toBeNull();
  });
});

describe('a linha mock já gravada não liga a maquininha em produção', () => {
  it.each([
    ['DEVORA_API_ENV=production', 'production', 'test'],
    ['DEVORA_API_ENV=staging', 'staging', 'test'],
    ['NODE_ENV=production', 'development', 'production'],
  ] as const)('%s: o status diz "sem maquininha integrada" e avisa da linha de teste', (_n, api, node) => {
    linhaMockDoBancoReal(loja);
    emAmbiente(api, node);
    const status = getTerminalStatus(loja);
    expect(status.configured).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.simulated).toBe(false);
    expect(status.message).toMatch(/teste/i);
    expect(status.message).toMatch(/ignorad/i);
  });

  it('pela rota: status sem maquininha, e a cobrança diz "não configurada" em vez de 403', async () => {
    linhaMockDoBancoReal(loja);
    emAmbiente('production');

    const status = await request(app).get('/api/v1/core/pdv/terminal/status').set(caixa.auth);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.configured).toBe(false);

    const cobranca = await request(app)
      .post('/api/v1/core/pdv/terminal/charge')
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'credito', amountInCents: 1000 });
    expect(cobranca.status, JSON.stringify(cobranca.body)).toBe(409);
    expect(cobranca.body.error.code).toBe('CORE_TERMINAL_NOT_CONFIGURED');
  });

  it('o balcão da Preço Justo fecha cartão lançado à mão em produção, como as outras cinco', async () => {
    const productId = await produtoComEstoque(12000);
    linhaMockDoBancoReal(loja);
    emAmbiente('production');

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId, quantity: 1, unitPriceCents: 12000 }],
        payments: [{ method: 'credito', amountCents: 12000, status: 'settled' }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  });

  it('confirmação manual de PIX de teste é recusada em produção', async () => {
    linhaMockDoBancoReal(loja);
    const pix = await chargeOnTerminal({
      companyId: loja,
      userId: caixa.userId,
      method: 'pix',
      amountInCents: 5000,
      idempotencyKey: randomUUID(),
    });
    expect(pix.state).toBe('processando');

    emAmbiente('production');
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/confirmar-teste`)
      .set(caixa.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_TERMINAL_CONFIRM_NOT_ALLOWED');
  });

  it('o painel de provedores não trata o mock como configurado em produção (e não estoura)', async () => {
    linhaMockDoBancoReal(loja);
    emAmbiente('production');
    const admin = issueSession({
      userId: gerente.userId,
      companyId: loja,
      storeId: 'store-pj',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/payment-terminals/providers-status')
      .set({ Authorization: `Bearer ${admin.accessToken}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mock = (res.body.items as { provider: string; configured: boolean; connection: { ok: boolean } }[])
      .find((i) => i.provider === 'mock');
    expect(mock?.configured).toBe(false);
    expect(mock?.connection.ok).toBe(false);
  });
});

describe('configuração desativada não conta como maquininha', () => {
  it('active:false gravado na linha desliga a exigência (a leitura não descarta mais o campo)', () => {
    const id = linhaMockDoBancoReal(loja);
    expect(getTerminalStatus(loja).configured).toBe(true);

    updateRows('payment_terminal_configurations', (r) => r.id === id, (r) => ({ ...r, active: false }));
    expect(getTerminalStatus(loja).configured).toBe(false);
  });

  it('em dev/teste, a maquininha de teste ativa se declara simulada para o balcão', () => {
    linhaMockDoBancoReal(loja);
    const status = getTerminalStatus(loja);
    expect(status.configured).toBe(true);
    expect(status.simulated).toBe(true);
    expect(status.message).toMatch(/TESTE/);
  });
});

describe('o gerente desliga e religa a maquininha pela rota', () => {
  it('lista as configurações da própria operação, com o estado de cada uma', async () => {
    const id = linhaMockDoBancoReal(loja);
    linhaMockDoBancoReal(vizinha, 'ptcfg-da-vizinha');

    const res = await request(app).get('/api/v1/core/pdv/terminal/configurations').set(gerente.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id, provider: 'mock', active: true, simulated: true });
    // Nada de segredo na listagem.
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedPayload/);
  });

  it('o caixa não lista nem desliga: desligar a maquininha desliga a exigência de cobrança', async () => {
    const id = linhaMockDoBancoReal(loja);
    const lista = await request(app).get('/api/v1/core/pdv/terminal/configurations').set(caixa.auth);
    expect(lista.status).toBe(403);
    const desliga = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(caixa.auth)
      .send({ reason: 'tentativa do caixa' });
    expect(desliga.status).toBe(403);
    expect(getTerminalStatus(loja).configured).toBe(true);
  });

  it('desligar exige motivo', async () => {
    const id = linhaMockDoBancoReal(loja);
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_REASON_REQUIRED');
    expect(getTerminalStatus(loja).configured).toBe(true);
  });

  it('configuração de outra operação é 404, e continua ligada', async () => {
    const id = linhaMockDoBancoReal(loja);
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(gerenteVizinha.auth)
      .send({ reason: 'não é minha' });
    expect(res.status).toBe(404);
    expect(getTerminalStatus(loja).configured).toBe(true);
  });

  it('EM PRODUÇÃO o gerente desliga a linha mock — é o caminho de correção do banco real', async () => {
    const id = linhaMockDoBancoReal(loja);
    emAmbiente('production');

    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'Maquininha de teste esquecida no banco da loja (GAP-PRD-001).' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id, active: false });

    const linha = findOneRow<Record<string, unknown>>('payment_terminal_configurations', (r) => r.id === id);
    expect(linha?.active).toBe(false);
    expect(linha?.deactivatedBy).toBe(gerente.userId);
    expect(String(linha?.deactivationReason)).toMatch(/GAP-PRD-001/);

    // Fica na auditoria com o nome de quem desligou, e no histórico do módulo.
    const trilha = listAudit(loja, { limit: 20 }).items as unknown as Record<string, unknown>[];
    const registro = trilha.find((a) => a.action === 'payment_terminal.configuration.deactivated');
    expect(registro).toBeTruthy();
    expect(registro?.entity_id).toBe(id);
    const historico = findRows('payment_terminal_history', (r) => r.configurationId === id);
    expect(historico.some((h) => h.action === 'configuration_deactivated')).toBe(true);

    // E desligar de novo não finge que fez alguma coisa.
    const denovo = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'de novo' });
    expect(denovo.status).toBe(409);
    expect(denovo.body.error.code).toBe('PAYMENT_TERMINAL_CONFIGURATION_ALREADY_INACTIVE');
  });

  it('religar o mock em produção é recusado; em teste funciona', async () => {
    const id = linhaMockDoBancoReal(loja);
    await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'desligando para o teste' })
      .expect(200);

    emAmbiente('production');
    const recusado = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/activate`)
      .set(gerente.auth)
      .send({ reason: 'quero o mock de volta' });
    expect(recusado.status).toBe(403);
    expect(recusado.body.error.code).toBe('PAYMENT_TERMINAL_MOCK_IN_PRODUCTION');
    expect(
      findOneRow<Record<string, unknown>>('payment_terminal_configurations', (r) => r.id === id)?.active,
    ).toBe(false);

    emAmbiente('test');
    const religado = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/activate`)
      .set(gerente.auth)
      .send({ reason: 'ensaio do balcão' });
    expect(religado.status, JSON.stringify(religado.body)).toBe(200);
    expect(religado.body.active).toBe(true);
    expect(getTerminalStatus(loja).configured).toBe(true);
    const trilha = listAudit(loja, { limit: 20 }).items as unknown as Record<string, unknown>[];
    expect(trilha.some((a) => a.action === 'payment_terminal.configuration.activated')).toBe(true);
  });
});

describe('a prontidão de go-live denuncia maquininha de teste ativa', () => {
  it('bloqueio crítico nomeando a operação, e some depois de desligar', async () => {
    const id = linhaMockDoBancoReal(loja);
    const antes = evaluateCoreProductionReadiness();
    expect(antes.criticalBlockers.join(' ')).toMatch(/Preço Justo/);
    expect(antes.testTerminalConfigurations).toEqual([
      expect.objectContaining({ companyId: loja, configurationId: id, provider: 'mock' }),
    ]);

    await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${id}/deactivate`)
      .set(gerente.auth)
      .send({ reason: 'antes do go-live' })
      .expect(200);
    const depois = evaluateCoreProductionReadiness();
    expect(depois.testTerminalConfigurations).toEqual([]);
    expect(depois.criticalBlockers.join(' ')).not.toMatch(/maquininha/i);
  });
});
