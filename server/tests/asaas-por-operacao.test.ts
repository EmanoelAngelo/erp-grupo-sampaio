/**
 * Cada operação cobra na conta dela.
 *
 * O `PaymentService` lia a chave do Asaas do AMBIENTE — uma chave só para as
 * seis operações. Na prática: o Pix do cliente da Gringa caía na conta do
 * Preço Justo, e a conciliação de duas empresas com CNPJ diferente virava a
 * mesma pilha. Não é um detalhe de configuração; é dinheiro na conta errada.
 *
 * O cofre por empresa já existia (`AsaasCredentialService`) e não era usado
 * pelo caminho vivo. Estes testes fixam a ligação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { upsertAsaasApiKey } from '../src/services/integrations/AsaasCredentialService.js';
import {
  resolveAsaasEnvironment,
  upsertAsaasIntegrationState,
} from '../src/services/integrations/AsaasIntegrationStateService.js';
import { getAsaasCredentials, getAsaasStatus } from '../src/services/core/PaymentService.js';

const CHAVE_GRINGA = '$aact_chave_de_teste_da_gringa_0000000000';
const CHAVE_PRECO_JUSTO = '$aact_chave_de_teste_do_preco_justo_11111';

let gringa: string;
let precoJusto: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
});

describe('credencial por operação', () => {
  it('a chave de uma operação não vale para outra', () => {
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });
    upsertAsaasApiKey({
      companyId: precoJusto,
      environment: 'sandbox',
      apiKey: CHAVE_PRECO_JUSTO,
    });

    expect(getAsaasCredentials({ companyId: gringa })?.apiKey).toBe(CHAVE_GRINGA);
    expect(getAsaasCredentials({ companyId: precoJusto })?.apiKey).toBe(CHAVE_PRECO_JUSTO);
  });

  it('operação sem chave própria não herda a da vizinha', () => {
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });

    const outra = getAsaasCredentials({ companyId: precoJusto });

    // Pode cair no fallback de ambiente (desenvolvimento), mas jamais na chave
    // da Gringa — é isso que separa as contas.
    expect(outra?.apiKey).not.toBe(CHAVE_GRINGA);
  });

  it('chave do cofre é declarada como vinda do cofre', () => {
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });

    expect(getAsaasCredentials({ companyId: gringa })?.source).toBe('vault');
  });
});

describe('sandbox é o padrão, produção é conquistada', () => {
  it('sem nada configurado, o ambiente é sandbox', () => {
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });

    expect(getAsaasCredentials({ companyId: gringa })?.environment).toBe('sandbox');
  });

  it('pedir produção não basta — cada tranca aparece no motivo', () => {
    upsertAsaasIntegrationState({ companyId: gringa }, { environment: 'production' });

    const { environment, blockedBy } = resolveAsaasEnvironment(
      { companyId: gringa },
      { productionCredentialConfigured: false, productionAllowedByProcess: false },
    );

    expect(environment).toBe('sandbox');
    expect(blockedBy).toContain('PRODUCAO_DESABILITADA_NO_PROCESSO');
    expect(blockedBy).toContain('SEM_CREDENCIAL_DE_PRODUCAO');
    // A quarta tranca é o teste da chave de PRODUÇÃO (GAP-PRD-170).
    expect(blockedBy).toContain('CREDENCIAL_DE_PRODUCAO_NAO_TESTADA');
    expect(blockedBy).toContain('HOMOLOGACAO_SANDBOX_PENDENTE');
  });

  it('com as cinco trancas abertas, produção vale', () => {
    upsertAsaasIntegrationState(
      { companyId: gringa },
      { environment: 'production', productionConnectionVerified: true, sandboxHomologated: true },
    );

    const { environment, blockedBy } = resolveAsaasEnvironment(
      { companyId: gringa },
      { productionCredentialConfigured: true, productionAllowedByProcess: true },
    );

    expect(environment).toBe('production');
    expect(blockedBy).toEqual([]);
  });

  it('homologação pendente segura a produção sozinha', () => {
    upsertAsaasIntegrationState(
      { companyId: gringa },
      { environment: 'production', productionConnectionVerified: true, sandboxHomologated: false },
    );

    const { environment, blockedBy } = resolveAsaasEnvironment(
      { companyId: gringa },
      { productionCredentialConfigured: true, productionAllowedByProcess: true },
    );

    expect(environment).toBe('sandbox');
    expect(blockedBy).toEqual(['HOMOLOGACAO_SANDBOX_PENDENTE']);
  });
});

describe('status para a tela', () => {
  it('diz o que ainda falta para produção, sem devolver a chave', () => {
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: CHAVE_GRINGA });

    const status = getAsaasStatus({ companyId: gringa });

    expect(status.configured).toBe(true);
    expect(status.environment).toBe('sandbox');
    expect(status.readiness).toBe('READY_FOR_SANDBOX_TEST');
    expect(status.productionBlockedBy.length).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(CHAVE_GRINGA);
  });
});
