/*
  O painel (`getAsaasIntegrationPanel`) e as rotas `/integrations/asaas*` saíram
  com o roteador `/integrations`, que nenhuma tela chamava (GAP-PRD-075). A tela
  do Asaas fala com `/core/integrations/asaas*`, cobertas em `asaas-rotas.test.ts`
  e `homologacao-asaas-pela-tela.test.ts`.
*/
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  upsertAsaasApiKey,
  getAsaasCredentialStatus,
  removeAsaasSecret,
} from '../src/services/integrations/AsaasCredentialService.js';
import {
  buildAsaasHomologationChecklist,
  mapAsaasConnectionError,
  testAsaasSandboxConnection,
} from '../src/services/integrations/AsaasHomologationService.js';
import { getAsaasIntegrationState, upsertAsaasIntegrationState } from '../src/services/integrations/AsaasIntegrationStateService.js';
import { ApiError } from '../src/utils/errors.js';

const COMPANY = 'company-asaas-hom-test';
const STORE = 'store-asaas-hom-test';

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe('Asaas homologation — state machine', () => {
  it('checklist inicia aguardando credencial', () => {
    const creds = getAsaasCredentialStatus(COMPANY, { storeId: STORE });
    const state = getAsaasIntegrationState({ companyId: COMPANY, storeId: STORE });
    const checklist = buildAsaasHomologationChecklist(state, creds);
    expect(checklist.find((s) => s.key === 'credential')?.status).toBe('pending');
  });

  it('teste conexão sem credencial retorna mensagem amigável', async () => {
    const result = await testAsaasSandboxConnection({ companyId: COMPANY, storeId: STORE });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toMatch(/credencial/i);
  });

  it('mapAsaasConnectionError não expõe segredo', () => {
    const mapped = mapAsaasConnectionError(new ApiError('ASAAS_REMOTE_ERROR', 'fail', 401));
    expect(JSON.stringify(mapped)).not.toContain('$aact');
    expect(mapped.message).toBeTruthy();
  });

  it('estado homologado persiste após patch', () => {
    upsertAsaasIntegrationState(
      { companyId: COMPANY, storeId: STORE },
      { sandboxHomologated: true, homologationStatus: 'homologated' },
    );
    const state = getAsaasIntegrationState({ companyId: COMPANY, storeId: STORE });
    expect(state.sandboxHomologated).toBe(true);
  });
});

describe('Asaas homologation — vault resolution', () => {
  it('credencial sandbox isolada por empresa', () => {
    upsertAsaasApiKey({ companyId: COMPANY, environment: 'sandbox', apiKey: 'sandbox-key-company-a' });
    upsertAsaasApiKey({ companyId: 'other-co', environment: 'sandbox', apiKey: 'sandbox-key-company-b' });
    expect(getAsaasCredentialStatus(COMPANY).sandbox.configured).toBe(true);
    expect(getAsaasCredentialStatus('other-co').sandbox.configured).toBe(true);
    expect(getAsaasCredentialStatus(COMPANY).sandbox.maskedHint).not.toContain('sandbox-key-company-a');
  });

  it('credencial isolada por unidade', () => {
    upsertAsaasApiKey({ companyId: COMPANY, storeId: STORE, environment: 'sandbox', apiKey: 'unit-a-key' });
    upsertAsaasApiKey({ companyId: COMPANY, storeId: 'other-store', environment: 'sandbox', apiKey: 'unit-b-key' });
    expect(getAsaasCredentialStatus(COMPANY, { storeId: STORE }).sandbox.configured).toBe(true);
    expect(getAsaasCredentialStatus(COMPANY, { storeId: 'other-store' }).sandbox.configured).toBe(true);
  });

  it('remove api_key sandbox via alias', () => {
    upsertAsaasApiKey({ companyId: COMPANY, environment: 'sandbox', apiKey: 'remove-me' });
    expect(removeAsaasSecret(COMPANY, 'api_key', undefined, 'sandbox')).toBe(true);
    expect(getAsaasCredentialStatus(COMPANY).sandbox.configured).toBe(false);
  });
});

describe('Asaas homologation — real sandbox (optional)', () => {
  const runReal = process.env.ASAAS_SANDBOX_TESTS === 'true' && Boolean(process.env.ASAAS_SANDBOX_API_KEY);

  it.skipIf(!runReal)('teste conexão real sandbox', async () => {
    upsertAsaasApiKey({
      companyId: COMPANY,
      storeId: STORE,
      environment: 'sandbox',
      apiKey: process.env.ASAAS_SANDBOX_API_KEY!,
    });
    const result = await testAsaasSandboxConnection({ companyId: COMPANY, storeId: STORE });
    expect(result.ok).toBe(true);
  });
});
