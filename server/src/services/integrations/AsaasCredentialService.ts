/**
 * Credenciais Asaas por empresa/unidade — vault com fallback env.
 */

import { timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { findRows } from '../../db/database.js';
import {
  deleteIntegrationSecret,
  getIntegrationSecretPlaintext,
  listIntegrationSecrets,
  upsertIntegrationSecret,
  type IntegrationProvider,
  type IntegrationSecretType,
} from './IntegrationSecretVaultService.js';
import { secretProvider } from '../../secrets/SecretProvider.js';

const PROVIDER: IntegrationProvider = 'asaas';

function apiKeySecretType(environment: 'sandbox' | 'production'): IntegrationSecretType {
  return environment === 'production' ? 'asaas_production_api_key' : 'asaas_sandbox_api_key';
}

export function upsertAsaasApiKey(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
  environment: 'sandbox' | 'production';
  apiKey: string;
}): Record<string, unknown> {
  return upsertIntegrationSecret({
    companyId: input.companyId,
    storeId: input.storeId,
    operationalUnitId: input.operationalUnitId,
    provider: PROVIDER,
    secretType: apiKeySecretType(input.environment),
    plaintext: input.apiKey.trim(),
  });
}

export function upsertAsaasWebhookToken(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
  webhookToken: string;
}): Record<string, unknown> {
  return upsertIntegrationSecret({
    companyId: input.companyId,
    storeId: input.storeId,
    operationalUnitId: input.operationalUnitId,
    provider: PROVIDER,
    secretType: 'webhook_token',
    plaintext: input.webhookToken.trim(),
  });
}

export function getAsaasApiKey(
  companyId: string,
  environment: 'sandbox' | 'production',
  scope?: { storeId?: string; operationalUnitId?: string },
): string | null {
  const fromVault = getIntegrationSecretPlaintext({
    companyId,
    storeId: scope?.storeId,
    operationalUnitId: scope?.operationalUnitId,
    provider: PROVIDER,
    secretType: apiKeySecretType(environment),
  });
  if (fromVault) return fromVault;

  /*
    ================================================================
    A CHAVE DO AMBIENTE NÃO É CONTA DE PRODUÇÃO DE NINGUÉM
    ================================================================

    A guarda aqui era `DEVORA_API_ENV === 'production'` — o modo do PROCESSO. E
    o que importa é o ambiente da COBRANÇA, que é outra coisa.

    As duas se separam exatamente na configuração deste projeto: instalação
    local (processo fora de 'production'), `ASAAS_PRODUCTION_ENABLED=true`, e a
    chave de produção de UMA empresa no `.env`. Nessa combinação, qualquer
    operação SEM credencial própria cobrava na conta dessa empresa — dinheiro
    real, de cliente real, na conta errada, sem erro em tela nenhuma.

    Não há como o código saber de quem é a chave do `.env`; tratar a empresa
    ativa como dona seria adivinhar, e o custo dessa adivinhação é dinheiro na
    conta de outro CNPJ. Para produção, a única fonte é o cofre, por operação.

    O fallback continua valendo em SANDBOX, que é onde se desenvolve e onde
    nenhum dinheiro muda de mãos.
  */
  if (environment === 'production') return null;
  // A mesma régua do token do webhook (GAP-PRD-113): produção pelos dois nomes.
  if (!asaasEnvFallbackAllowed()) return null;
  return secretProvider.getAsaasApiKey(environment);
}

export function getAsaasWebhookToken(
  companyId: string,
  scope?: { storeId?: string; operationalUnitId?: string },
): string | null {
  const fromVault = getIntegrationSecretPlaintext({
    companyId,
    storeId: scope?.storeId,
    operationalUnitId: scope?.operationalUnitId,
    provider: PROVIDER,
    secretType: 'webhook_token',
  });
  if (fromVault) return fromVault;
  /*
    O TOKEN DO .env NÃO VALE EM PRODUÇÃO (GAP-PRD-113).

    A API key sempre teve esta guarda; o token do webhook não tinha. Numa
    operação sem token no cofre, a rota POR EMPRESA aceitava o token global —
    que, na prática, é o da primeira operação configurada. Em produção cada
    operação cadastra o seu, e a falta dele é 503 ("salve o token"), não um
    atalho compartilhado entre CNPJs.
  */
  if (!asaasEnvFallbackAllowed()) return null;
  return secretProvider.getAsaasWebhookToken();
}

/**
 * A operação tem token de webhook PRÓPRIO, no cofre?
 *
 * É o cerco do atalho de desenvolvimento (GAP-PRD-113): fora de produção o
 * token do `.env` continua valendo, mas só para operação que ainda não tem o
 * dela. Quem cadastrou o próprio token provou que quer ser conferido por ele —
 * e o token de ambiente não atravessa para a cobrança dessa operação.
 */
export function temTokenDeWebhookProprio(companyId: string): boolean {
  return Boolean(
    getIntegrationSecretPlaintext({ companyId, provider: PROVIDER, secretType: 'webhook_token' }),
  );
}

/**
 * DE QUEM É ESTE TOKEN? — a pergunta que o webhook precisa fazer (rodada 61).
 *
 * O webhook do Asaas é rota PÚBLICA: quem chama é o provedor, não um usuário
 * logado, então não há `companyId` na requisição. Foi por isso que o handler
 * lia o token só do `.env` — e o token que o gestor salva pela tela vai para o
 * COFRE, por empresa. Duas fontes para a mesma pergunta: a tela dizia
 * "Configurada", o Asaas levava 503, e as duas afirmações eram verdadeiras
 * sobre lugares diferentes.
 *
 * A saída não é adivinhar a empresa: é procurar o token entre os cadastrados.
 * Conhecer o token PROVA de quem é o evento — é exatamente para isso que ele
 * existe — e o handler ganha a empresa que antes lhe faltava.
 *
 * A comparação é em tempo constante para não vazar, pelo tempo de resposta,
 * quantos caracteres do token o atacante já acertou.
 */
/**
 * Existe ALGUM token de webhook cadastrado, em qualquer empresa?
 *
 * Separa as duas recusas que o gestor precisa distinguir: 503 é "não há o que
 * conferir — salve o token"; 401 é "o token não confere — compare com o do
 * Asaas". Trocar uma pela outra faz alguém salvar de novo o mesmo valor
 * errado, ou procurar cadastro que já existe.
 */
export function existeTokenDeWebhookCadastrado(): boolean {
  return findRows<{ provider?: string; secretType?: string }>(
    'integration_secrets',
    (r) => r.provider === PROVIDER && r.secretType === 'webhook_token',
  ).length > 0;
}

export function findCompanyByAsaasWebhookToken(token: string): string | null {
  const informado = String(token ?? '');
  if (!informado) return null;

  const linhas = findRows<{ companyId?: string; provider?: string; secretType?: string }>(
    'integration_secrets',
    (r) => r.provider === PROVIDER && r.secretType === 'webhook_token',
  );

  for (const linha of linhas) {
    const companyId = String(linha.companyId ?? '');
    if (!companyId) continue;
    const guardado = getIntegrationSecretPlaintext({
      companyId,
      provider: PROVIDER,
      secretType: 'webhook_token',
    });
    if (guardado && iguaisEmTempoConstante(guardado, informado)) return companyId;
  }
  return null;
}

/**
 * Compara sem entregar, pelo relógio, onde as cadeias começam a divergir.
 *
 * `a === b` sai no primeiro caractere diferente, e a diferença de tempo entre
 * "errou no primeiro" e "errou no último" é medível por quem tenta adivinhar
 * o token — este endereço é público e aceita quantas tentativas quiserem.
 */
function iguaisEmTempoConstante(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` exige tamanhos iguais; o tamanho em si não é segredo.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function removeAsaasSecret(
  companyId: string,
  secretType: 'api_key' | 'webhook_token' | 'asaas_sandbox_api_key' | 'asaas_production_api_key',
  scope?: { storeId?: string; operationalUnitId?: string },
  environment?: 'sandbox' | 'production',
): boolean {
  const resolvedType = secretType === 'api_key'
    ? apiKeySecretType(environment ?? 'sandbox')
    : secretType;
  return deleteIntegrationSecret({
    companyId,
    provider: PROVIDER,
    secretType: resolvedType,
    storeId: scope?.storeId,
    operationalUnitId: scope?.operationalUnitId,
  });
}

export function getAsaasCredentialStatus(
  companyId: string,
  scope?: { storeId?: string; operationalUnitId?: string },
): {
  sandbox: { configured: boolean; maskedHint?: string; source: 'vault' | 'env' | 'none' };
  production: { configured: boolean; maskedHint?: string; source: 'vault' | 'env' | 'none' };
  webhook: { configured: boolean; maskedHint?: string; source: 'vault' | 'env' | 'none' };
} {
  const vaultSecrets = listIntegrationSecrets(companyId, {
    provider: PROVIDER,
    storeId: scope?.storeId,
    operationalUnitId: scope?.operationalUnitId,
  });
  const sandboxVault = vaultSecrets.find((s) => s.secretType === 'asaas_sandbox_api_key');
  const productionVault = vaultSecrets.find((s) => s.secretType === 'asaas_production_api_key');
  const webhookVault = vaultSecrets.find((s) => s.secretType === 'webhook_token');

  /*
    ================================================================
    DEFEITO: A TELA DIZIA "CONFIGURADA" SOBRE A CHAVE QUE O SERVIDOR RECUSA
    ================================================================

    A chave de ambiente entrava aqui direto de `secretProvider.getAsaasStatus`,
    que só pergunta "existe no `.env`?". Mas quem ENTREGA a chave para cobrar é
    `getAsaasApiKey`, e ela tem duas guardas que este status não tinha:

      - produção NUNCA vem do `.env` (o bloco no alto deste arquivo explica:
        não há como o código saber de quem é aquela chave, e o custo de
        adivinhar é dinheiro na conta de outro CNPJ);
      - sandbox pelo `.env` só fora de produção (`asaasEnvFallbackAllowed`) —
        a mesma régua que o token do webhook já seguia, logo abaixo.

    A consequência é medível numa instalação com `ASAAS_PRODUCTION_ENABLED=true`
    e a chave de produção no `.env` — exatamente o `.env` desta bancada, como
    `tests/setup.ts` registra. Integrações › Asaas mostrava "Produção:
    configurada", com a dica mascarada de uma chave que não é da operação;
    "Testar conexão" escolhe os ambientes a testar POR ESTE `configured`,
    entrava no de produção e recebia de volta "Nenhuma API key de produção
    configurada para esta operação" — deixando o botão sempre vermelho, mesmo
    com o sandbox verde. Duas afirmações do mesmo servidor sobre a mesma chave,
    uma negando a outra, no dia da implantação.

    O conserto é a mesma régua da entrega, aplicada aqui: chave de ambiente que
    `getAsaasApiKey` recusaria não é "configurada".
  */
  const SEM_CHAVE_DE_AMBIENTE = { configured: false, maskedHint: undefined } as const;
  const envSandbox = asaasEnvFallbackAllowed()
    ? secretProvider.getAsaasStatus('sandbox')
    : SEM_CHAVE_DE_AMBIENTE;
  const envProduction = SEM_CHAVE_DE_AMBIENTE;
  // Token de ambiente que o servidor RECUSA (produção) não é "configurado": a
  // tela diria "Configurada" e o Asaas levaria 503 (GAP-PRD-113).
  const envWebhook = asaasEnvFallbackAllowed() ? secretProvider.getAsaasWebhookToken() : null;

  return {
    sandbox: {
      configured: Boolean(sandboxVault?.configured) || envSandbox.configured,
      maskedHint: (sandboxVault?.maskedHint as string) ?? envSandbox.maskedHint,
      source: sandboxVault?.configured ? 'vault' : envSandbox.configured ? 'env' : 'none',
    },
    production: {
      configured: Boolean(productionVault?.configured) || envProduction.configured,
      maskedHint: (productionVault?.maskedHint as string) ?? envProduction.maskedHint,
      source: productionVault?.configured ? 'vault' : envProduction.configured ? 'env' : 'none',
    },
    webhook: {
      configured: Boolean(webhookVault?.configured) || Boolean(envWebhook),
      maskedHint: (webhookVault?.maskedHint as string) ?? (envWebhook ? secretProvider.maskSecret(envWebhook) : undefined),
      source: webhookVault?.configured ? 'vault' : envWebhook ? 'env' : 'none',
    },
  };
}

/**
 * O atalho do `.env` (chave sandbox e token de webhook) só vale fora de produção.
 *
 * Produção pelos DOIS nomes, como o resto do servidor: `NODE_ENV=production` é
 * o que hospedagem e gerenciador de processo definem sozinhos, e quem sobe o
 * build esquecendo `DEVORA_API_ENV` ficaria com o atalho ligado em silêncio.
 */
export function asaasEnvFallbackAllowed(): boolean {
  const env = loadEnv();
  return env.DEVORA_API_ENV !== 'production' && process.env.NODE_ENV !== 'production';
}
