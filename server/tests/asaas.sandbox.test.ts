/**
 * Testes Sandbox opcionais — executar somente com ASAAS_SANDBOX_TESTS=true e chave configurada.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loginForTest } from './helpers/auth.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests, findOneRow } from '../src/db/database.js';
import { AsaasHttpClient } from '../src/services/asaas/AsaasHttpClient.js';
import {
  enqueueOperationalAttempt,
  processOperationalAttempt,
} from '../src/services/asaas/AsaasOperationalService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const sandboxEnabled = process.env.ASAAS_SANDBOX_TESTS === 'true';
const hasKey = Boolean(process.env.ASAAS_API_KEY?.trim());

function configureSandboxEnv(): void {
  process.env.ASAAS_ENABLED = 'true';
  process.env.ASAAS_PRODUCTION_ENABLED = 'false';
  process.env.ASAAS_ENVIRONMENT = 'sandbox';
  resetEnvCacheForTests();
}

describe.skipIf(!sandboxEnabled || !hasKey)('Homologação — Asaas Sandbox REAL', () => {
  beforeEach(() => {
    configureSandboxEnv();
    resetDbForTests();
  });

  it('conexão REAL com Asaas Sandbox', async () => {
    const client = new AsaasHttpClient({ environment: 'sandbox' });
    const result = await client.testConnection();
    expect(result.ok).toBe(true);
    expect(result.environment).toBe('sandbox');
  });

  it('cliente REAL + idempotência operacional', async () => {
    const idempotencyKey = `hom-customer-${randomUUID()}`;
    const customerId = `cust-${randomUUID()}`;
    const first = enqueueOperationalAttempt({
      companyId: 'company-hom',
      operationType: 'asaas_customer_sync',
      sourceType: 'customer',
      sourceId: customerId,
      idempotencyKey,
      correlationId: 'hom-1',
      payload: { name: 'Cliente Homologação DEVORA', customerId, document: '24971563792' },
    });
    const duplicate = enqueueOperationalAttempt({
      companyId: 'company-hom',
      operationType: 'asaas_customer_sync',
      sourceType: 'customer',
      sourceId: customerId,
      idempotencyKey,
      correlationId: 'hom-1',
      payload: { name: 'Cliente Homologação DEVORA', customerId, document: '24971563792' },
    });
    expect(duplicate.id).toBe(first.id);
    await processOperationalAttempt(String(first.id), 'company-hom');
    await processOperationalAttempt(String(first.id), 'company-hom');
    const attempt = findOneRow<Record<string, unknown>>(
      'asaas_operational_attempts',
      (row) => row.id === first.id,
    );
    expect(attempt?.status).toBe('completed');
  });

  it('PIX REAL — cobrança + QR Code', async () => {
    const client = new AsaasHttpClient({ environment: 'sandbox' });
    const customer = await client.createCustomer({
      name: 'PIX Homologação',
      cpfCnpj: '24971563792',
      externalReference: `pix-${randomUUID()}`,
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3);
    const payment = await client.createPayment({
      customer: customer.id,
      billingType: 'PIX',
      value: 10.5,
      dueDate: dueDate.toISOString().slice(0, 10),
    });
    expect(payment.id).toBeTruthy();
    expect(payment.status).toBeTruthy();
    const qr = await client.getPixQrCode(String(payment.id));
    expect(qr.encodedImage ?? qr.payload).toBeTruthy();
  });

  it('Boleto REAL — cobrança + linha digitável', async () => {
    const client = new AsaasHttpClient({ environment: 'sandbox' });
    const customer = await client.createCustomer({
      name: 'Boleto Homologação',
      cpfCnpj: '24971563792',
      externalReference: `boleto-${randomUUID()}`,
    });
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 5);
    const payment = await client.createPayment({
      customer: customer.id,
      billingType: 'BOLETO',
      value: 25,
      dueDate: dueDate.toISOString().slice(0, 10),
    });
    expect(payment.id).toBeTruthy();
    expect(payment.dueDate ?? dueDate.toISOString().slice(0, 10)).toBeTruthy();
    const field = await client.getIdentificationField(String(payment.id));
    expect(field.identificationField ?? field.barCode ?? payment.bankSlipUrl ?? payment.invoiceUrl).toBeTruthy();
  });

  it('checkout hospedado REAL Sandbox', async () => {
    const client = new AsaasHttpClient({ environment: 'sandbox' });
    const customer = await client.createCustomer({
      name: 'Checkout Homologação',
      cpfCnpj: '24971563792',
      externalReference: `checkout-${randomUUID()}`,
    });
    const checkout = await client.createCheckout({
      customer: customer.id,
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['DETACHED'],
      items: [{ name: 'Item homologação', value: 15, quantity: 1 }],
      callback: { successUrl: 'https://example.com/success', cancelUrl: 'https://example.com/cancel' },
    });
    expect(checkout.id ?? checkout.url).toBeTruthy();
  });

  it('API test-connection autenticada', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-hom',
      companyId: 'company-hom',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/asaas/test-connection')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ environment: 'sandbox' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe.skipIf(sandboxEnabled && hasKey)('Homologação — Asaas Sandbox REAL', () => {
  it('PENDING — configure ASAAS_SANDBOX_TESTS=true, ASAAS_ENABLED=true e ASAAS_API_KEY no .env', () => {
    expect(sandboxEnabled && hasKey).toBe(false);
  });
});
