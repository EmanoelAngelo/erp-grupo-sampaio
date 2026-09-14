/**
 * ============================================================================
 * GUARDAS DA AUDITORIA INTEGRAL — quatro buracos que a suíte deixava passar
 * ============================================================================
 *
 * Este arquivo cobra quatro comportamentos que a auditoria encontrou abertos:
 *
 * 1. TEF MOCK EM PRODUÇÃO. O domínio payment-terminal nunca olhava o
 *    ambiente: em produção, um POST de configuração criava provider 'mock' e
 *    a cobrança "aprovava" sem dinheiro trocar de mãos. A régua espelhada é a
 *    do fiscal — `SefazAdapter.selectAdapter` recusa o provider de teste em
 *    produção num ponto só. Aqui a mesma regra vale para configuração,
 *    credencial e cobrança. Dev/test continuam livres: é onde o mock existe.
 *
 * 2. NF-e LEGADO FABRICANDO AUTORIZAÇÃO. `authorizeNfeDocumentBackend`
 *    gravava 'authorized' com protocolo inventado de `Date.now()`. Foi
 *    neutralizado aqui e, na junção do GAP-PRD-075, apagado com o serviço
 *    inteiro: a prova da saída mora em `rotas-fiscais-legadas-fora-do-ar`.
 *
 * 3. /bi/dashboard DECORATIVO. `getExecutiveDashboardBackend` devolvia todos
 *    os indicadores executivos hardcoded em zero, e NENHUMA tela o chama
 *    (BiPage usa /insights/*). Número decorativo é mentira executiva: a rota
 *    saiu do ar, e este arquivo prova que o caminho responde o 404 com
 *    envelope da casa — sem derrubar o resto do módulo /bi.
 *
 * 4. api_request_logs SEM TETO. Todo ApiError virava linha para sempre, sem
 *    leitor nenhum no repositório. A poda de retenção (30 dias) roda dentro
 *    do próprio registro, com amortização — o teste grava mais de um ciclo
 *    inteiro de amostragem para garantir que a poda aconteceu pelo menos
 *    uma vez, sem depender da fase do contador.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'audit-guardas-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'audit-guardas-encryption-key-suficientemente-longa';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { issueSession } from '../src/services/api/ApiAuthService.js';
import { runMigrations } from '../src/db/migrate.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { findOneRow, findRows, insertRow } from '../src/db/database.js';
import { ApiError } from '../src/utils/errors.js';
import {
  createAndProcessPaymentTerminalTransactionBackend,
  createPaymentTerminalConfigurationBackend,
  upsertPaymentTerminalCredentials,
} from '../src/services/payment-terminal/PaymentTerminalService.js';
import { processPaymentTerminalTransaction } from '../src/services/payment-terminal/PaymentTerminalProviderAdapter.js';
import { createRequestLog } from '../src/services/api/ApiIdempotencyService.js';

/**
 * Troca o ambiente declarado e derruba o cache do loadEnv — sem o reset, o
 * primeiro serviço que leu o ambiente congela a resposta para todo o worker.
 */
function emAmbiente(nome: 'development' | 'test' | 'staging' | 'production') {
  process.env.DEVORA_API_ENV = nome;
  resetEnvCacheForTests();
}

function capturaErro(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  // Nenhum teste deste arquivo pode vazar "produção" para o vizinho.
  emAmbiente('test');
});

// ============================================================================

describe('TEF mock não alcança produção', () => {
  it('produção recusa criar configuração com provider mock', () => {
    emAmbiente('production');
    const erro = capturaErro(() =>
      createPaymentTerminalConfigurationBackend({
        companyId: 'company-guarda-tef',
        provider: 'mock',
        idempotencyKey: 'guarda-cfg-producao-1',
      }),
    );
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe('PAYMENT_TERMINAL_MOCK_IN_PRODUCTION');
    // E a configuração NÃO pode ter nascido por baixo do erro.
    expect(
      findOneRow('payment_terminal_configurations', (r) => r.idempotencyKey === 'guarda-cfg-producao-1'),
    ).toBeNull();
  });

  it('produção recusa credencial/ativação para o provider mock', () => {
    emAmbiente('production');
    const erro = capturaErro(() =>
      upsertPaymentTerminalCredentials({
        companyId: 'company-guarda-tef',
        provider: 'mock',
        credentials: { accessToken: 'nao-importa' },
      }),
    );
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe('PAYMENT_TERMINAL_MOCK_IN_PRODUCTION');
  });

  it('produção recusa executar cobrança com provider mock', async () => {
    emAmbiente('production');
    await expect(
      processPaymentTerminalTransaction('company-guarda-tef', 'mock', {
        paymentMethod: 'credit',
        amountInCents: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION' });

    // O caminho que a rota e o PDV usam passa pelo mesmo guarda.
    await expect(
      createAndProcessPaymentTerminalTransactionBackend({
        companyId: 'company-guarda-tef',
        provider: 'mock',
        paymentMethod: 'credit',
        amountInCents: 10_000,
        idempotencyKey: 'guarda-tx-producao-1',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION' });

    // E nenhuma transação "aprovada" pode ter ficado gravada.
    expect(
      findOneRow('payment_terminal_transactions', (r) => r.idempotencyKey === 'guarda-tx-producao-1'),
    ).toBeNull();
  });

  it('staging segue a mesma régua de produção', async () => {
    emAmbiente('staging');
    const erro = capturaErro(() =>
      createPaymentTerminalConfigurationBackend({
        companyId: 'company-guarda-tef',
        provider: 'mock',
        idempotencyKey: 'guarda-cfg-staging-1',
      }),
    );
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe('PAYMENT_TERMINAL_MOCK_IN_PRODUCTION');

    await expect(
      processPaymentTerminalTransaction('company-guarda-tef', 'mock', {
        paymentMethod: 'credit',
        amountInCents: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION' });
  });

  it('dev/test continuam livres para o mock', async () => {
    emAmbiente('test');
    const cfg = createPaymentTerminalConfigurationBackend({
      companyId: 'company-guarda-tef',
      provider: 'mock',
      idempotencyKey: 'guarda-cfg-teste-1',
    });
    expect(cfg).toMatchObject({ provider: 'mock' });

    const tx = await processPaymentTerminalTransaction('company-guarda-tef', 'mock', {
      paymentMethod: 'credit',
      amountInCents: 10_000,
    });
    expect(tx.ok).toBe(true);
    expect(tx.simulated).toBe(true);
  });
});

// ============================================================================

/*
  "NF-e legado não fabrica autorização" morava aqui, sobre
  `NfeService.authorizeNfeDocumentBackend` e a coleção `nfe_documents`. Os dois
  saíram na junção do GAP-PRD-075 — o serviço apagado, a coleção aposentada —
  e a prova da saída está em `rotas-fiscais-legadas-fora-do-ar.test.ts`. Não
  sobra escritor de documento fiscal fora de `core_fiscal_documents` para
  fabricar coisa nenhuma.
*/

// ============================================================================

describe('/bi/dashboard decorativo saiu do ar', () => {
  const app = createApp();

  function authHeaders() {
    const tokens = issueSession({
      userId: '550e8400-e29b-41d4-a716-446655440077',
      companyId: 'company-guarda-bi',
      storeId: 'store-guarda-bi',
      profileCodes: ['admin_geral'],
    });
    return { Authorization: `Bearer ${tokens.accessToken}` };
  }

  it('GET /bi/dashboard responde 404 com envelope, mesmo autenticado', async () => {
    const res = await request(app).get('/api/v1/bi/dashboard').set(authHeaders());
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('API_NOT_FOUND');
  });

  it('GET /bi/executive (o mesmo stub por outro nome) também responde 404', async () => {
    const res = await request(app).get('/api/v1/bi/executive').set(authHeaders());
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('API_NOT_FOUND');
  });

  it('e o módulo /bi inteiro saiu — a sonda de um módulo sem número também (GAP-PRD-075)', async () => {
    // O processo vivo responde em /health; o BI de verdade é /core/insights/*.
    const sonda = await request(app).get('/api/v1/bi/health');
    expect(sonda.status).toBe(404);
    expect(sonda.body.error?.code).toBe('API_NOT_FOUND');
    const processo = await request(app).get('/api/v1/health');
    expect(processo.status).toBe(200);
  });
});

// ============================================================================

describe('api_request_logs tem teto de 30 dias', () => {
  it('linha com mais de 30 dias é podada; linha recente fica', () => {
    const agora = Date.now();
    insertRow('api_request_logs', {
      id: 'guarda-log-velho',
      method: 'GET',
      path: '/fantasma',
      status: 404,
      requestId: 'guarda-req-velha',
      createdAt: new Date(agora - 40 * 86_400_000).toISOString(),
    });
    insertRow('api_request_logs', {
      id: 'guarda-log-recente',
      method: 'GET',
      path: '/fantasma',
      status: 404,
      requestId: 'guarda-req-recente',
      createdAt: new Date(agora - 10 * 86_400_000).toISOString(),
    });

    // Mais de um ciclo inteiro de amortização: a poda tem que ter rodado
    // pelo menos uma vez, não importa em que fase o contador esteja.
    for (let i = 0; i < 101; i += 1) {
      createRequestLog({
        method: 'GET',
        path: '/guarda-retencao',
        status: 400,
        requestId: `guarda-req-${i}`,
      });
    }

    expect(findOneRow('api_request_logs', (r) => r.id === 'guarda-log-velho')).toBeNull();
    expect(findOneRow('api_request_logs', (r) => r.id === 'guarda-log-recente')).not.toBeNull();
    // E o registro do dia continua sendo gravado normalmente.
    expect(
      findRows('api_request_logs', (r) => r.path === '/guarda-retencao').length,
    ).toBe(101);
  });
});
