/**
 * ============================================================================
 * O QUE CADA OPERAÇÃO AINDA PRECISA PARA COBRAR PELO ASAAS (GAP-PRD-017)
 * ============================================================================
 *
 * ## A situação medida
 *
 * Só o Preço Justo tinha credencial no cofre. As outras cinco operações
 * (Gringa, Me Mimei, Conceito, PJ Motors, Oficina) respondiam
 * `CORE_ASAAS_UNCONFIGURED` na cobrança do título e degradavam o checkout
 * online. A auditoria provou que nenhuma linha de código falta para elas
 * cobrarem: com a chave e o token de cada uma cadastrados pela tela, o fluxo
 * inteiro (cobrar, webhook, baixa, conciliação) passa sem mudança.
 *
 * ## O que faltava era ENXERGAR o que falta
 *
 * A tela do Asaas é POR OPERAÇÃO: para saber o que falta nas seis, o dono
 * trocava de operação seis vezes. Esta leitura junta as operações a que a
 * pessoa está vinculada (`core_user_companies`, o mesmo escopo do BI do
 * grupo — nunca "todas as empresas") e diz, para cada uma, o que ainda é
 * INSUMO EXTERNO (chave, token, cadastro da URL no painel do Asaas, endereço
 * público) e o que é AÇÃO NA TELA (testar, homologar, pedir produção). Nada é
 * código: é a lista que o dono cumpre.
 *
 * Nenhum segredo sai daqui: só "configurada ou não" e de onde veio.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { asaasEnvFallbackAllowed, getAsaasCredentialStatus } from '../integrations/AsaasCredentialService.js';
import { getAsaasIntegrationState } from '../integrations/AsaasIntegrationStateService.js';
import { getAsaasStatus } from './PaymentService.js';
import { describeAsaasWebhook } from './AsaasWebhookInfo.js';

export type TipoDoQueFalta = 'credencial' | 'configuracao_do_servidor' | 'cadastro_no_asaas' | 'acao_na_tela';

export interface OQueFalta {
  codigo: string;
  tipo: TipoDoQueFalta;
  /** Quem resolve: o dono na tela, ou quem instala o servidor. */
  quem: 'dono' | 'instalacao';
  frase: string;
}

export interface ProntidaoAsaasDaOperacao {
  companyId: string;
  tradeName: string;
  /** Ambiente que o servidor usaria HOJE para cobrar desta operação. */
  effectiveEnvironment: 'sandbox' | 'production';
  /** Cobra em sandbox agora (há chave de sandbox). */
  canChargeSandbox: boolean;
  /** Cobra em produção agora (todas as travas abertas). */
  canChargeProduction: boolean;
  credentials: {
    sandbox: { configured: boolean; source: string };
    production: { configured: boolean; source: string };
    webhookToken: { configured: boolean; source: string };
  };
  sandboxConnectionVerified: boolean;
  productionConnectionVerified: boolean;
  sandboxHomologated: boolean;
  requestedEnvironment: string;
  productionBlockedBy: string[];
  webhook: { url: string; publiclyReachable: boolean; lastEventAt: string | null };
  /** O que ainda falta, na ordem em que se faz. Vazio = pronta para produção. */
  missing: OQueFalta[];
}

function operacoesDe(userId: string): { id: string; trade_name: string }[] {
  return getConnection()
    .prepare(
      `SELECT c.id, c.trade_name
         FROM core_companies c
         JOIN core_user_companies uc ON uc.company_id = c.id
        WHERE uc.user_id = ? AND c.active = 1
        ORDER BY c.trade_name`,
    )
    .all(userId) as unknown as { id: string; trade_name: string }[];
}

export function prontidaoAsaasDaOperacao(companyId: string, tradeName: string): ProntidaoAsaasDaOperacao {
  const env = loadEnv();
  const cred = getAsaasCredentialStatus(companyId);
  const state = getAsaasIntegrationState({ companyId });
  const status = getAsaasStatus({ companyId });
  const webhook = describeAsaasWebhook(companyId);

  const falta: OQueFalta[] = [];
  const empurrar = (codigo: string, tipo: TipoDoQueFalta, quem: 'dono' | 'instalacao', frase: string) =>
    falta.push({ codigo, tipo, quem, frase });

  // A chave do .env é atalho de desenvolvimento, recusado em produção: a
  // operação que só tem ela não tem chave PRÓPRIA.
  if (cred.sandbox.source !== 'vault') {
    empurrar('CHAVE_SANDBOX', 'credencial', 'dono', 'Guardar a API key de SANDBOX da conta Asaas desta operação.');
  }
  if (cred.webhook.source !== 'vault') {
    empurrar(
      'TOKEN_WEBHOOK',
      'credencial',
      'dono',
      'Guardar o token do webhook desta operação (o mesmo cadastrado no painel do Asaas).',
    );
  }
  if (!webhook.publiclyReachable) {
    empurrar(
      'ENDERECO_PUBLICO',
      'configuracao_do_servidor',
      'instalacao',
      'Definir GRUPO_SAMPAIO_PUBLIC_URL (ou ASAAS_WEBHOOK_PUBLIC_URL) com o endereço HTTPS público da API.',
    );
  }
  if (!webhook.lastEvent) {
    empurrar(
      'URL_NO_PAINEL',
      'cadastro_no_asaas',
      'dono',
      `Cadastrar ${webhook.url} no painel do Asaas desta operação — nenhum aviso do Asaas chegou ainda.`,
    );
  }
  if (!state.sandboxHomologated) {
    empurrar('HOMOLOGACAO', 'acao_na_tela', 'dono', 'Rodar a homologação em sandbox (Integrações › Asaas).');
  }
  if (cred.production.source !== 'vault') {
    empurrar('CHAVE_PRODUCAO', 'credencial', 'dono', 'Guardar a API key de PRODUÇÃO da conta Asaas desta operação.');
  } else if (state.productionConnectionVerified !== true) {
    empurrar('TESTE_PRODUCAO', 'acao_na_tela', 'dono', 'Testar a conexão: a chave de produção ainda não foi testada.');
  }
  /*
    ============================================================================
    A VARIÁVEL QUE FAZ AS OUTRAS VALEREM — e que a lista não pedia
    ============================================================================

    `asaasEnvFallbackAllowed()` só FECHA o atalho do `.env` (chave de sandbox e
    token de webhook) quando o processo está em produção, por um dos dois
    nomes: `DEVORA_API_ENV=production` ou `NODE_ENV=production`. Esta lista
    pedia ASAAS_PRODUCTION_ENABLED, GRUPO_SAMPAIO_PUBLIC_URL e as credenciais —
    nunca o MODO DO PROCESSO.

    Numa instalação que suba a API fora de produção (é como a API roda em
    `tsx watch`) com um `.env` trazendo ASAAS_API_KEY e token de webhook, o
    dono cumpre a lista inteira e ainda assim: Integrações › Asaas mostra
    "Sandbox: configurada" com a dica de uma chave que NÃO é desta operação, o
    PIX do balcão nasce na conta alheia, o token do `.env` vale para operar sem
    token próprio, e a homologação (5ª tranca) pode ser aprovada contra essa
    conta — abrindo o portão de produção com uma prova que não é da operação. E
    fora do Asaas, o mesmo interruptor libera o provedor MOCK da maquininha
    (`mockProviderBlocked`), que aprova cartão sem dinheiro trocar de mãos.

    Não é código faltando: é item de entrega que a lista tem de PEDIR.

    A conferência é ESTREITA de propósito: só quando o atalho está aberto E
    alguma credencial está de fato vindo do ambiente. Pedir o modo do processo
    numa instalação sem chave nenhuma no `.env` seria alarme sem dano — e a
    régua geral do modo do processo já é item próprio, com o mesmo nome de
    variável, em Configurações › Implantação (item "Ambiente", que BLOQUEIA).
  */
  const credencialDeAmbiente =
    cred.sandbox.source === 'env' || cred.webhook.source === 'env' || cred.production.source === 'env';
  if (asaasEnvFallbackAllowed() && credencialDeAmbiente) {
    empurrar(
      'MODO_DO_PROCESSO',
      'configuracao_do_servidor',
      'instalacao',
      'Subir a API em modo de produção (DEVORA_API_ENV=production, e também NODE_ENV=production) '
      + 'e reiniciar: é essa variável que fecha o atalho do .env. Enquanto ela não estiver, a '
      + 'chave e o token do servidor valem COMO SE fossem desta operação — inclusive para '
      + 'aprovar a homologação em sandbox.',
    );
  }
  if (!env.asaasProductionEnabled) {
    empurrar(
      'PRODUCAO_NO_SERVIDOR',
      'configuracao_do_servidor',
      'instalacao',
      'Ligar ASAAS_PRODUCTION_ENABLED=true no servidor de produção.',
    );
  }
  if (state.environment !== 'production') {
    empurrar('PEDIDO_PRODUCAO', 'acao_na_tela', 'dono', 'Pedir produção (Integrações › Asaas).');
  }

  return {
    companyId,
    tradeName,
    effectiveEnvironment: status.environment === 'production' ? 'production' : 'sandbox',
    canChargeSandbox: cred.sandbox.configured,
    canChargeProduction: status.environment === 'production',
    credentials: {
      sandbox: { configured: cred.sandbox.configured, source: cred.sandbox.source },
      production: { configured: cred.production.configured, source: cred.production.source },
      webhookToken: { configured: cred.webhook.configured, source: cred.webhook.source },
    },
    sandboxConnectionVerified: state.connectionVerified === true,
    productionConnectionVerified: state.productionConnectionVerified === true,
    sandboxHomologated: state.sandboxHomologated === true,
    requestedEnvironment: String(state.environment ?? 'sandbox'),
    productionBlockedBy: status.productionBlockedBy,
    webhook: {
      url: webhook.url,
      publiclyReachable: webhook.publiclyReachable,
      lastEventAt: webhook.lastEvent?.receivedAt ?? null,
    },
    missing: falta,
  };
}

export function prontidaoAsaasDoGrupo(userId: string): {
  operations: ProntidaoAsaasDaOperacao[];
  readyForProduction: number;
  total: number;
} {
  ensureCoreSchema();
  const operations = operacoesDe(userId).map((c) => prontidaoAsaasDaOperacao(c.id, c.trade_name));
  return {
    operations,
    readyForProduction: operations.filter((o) => o.canChargeProduction).length,
    total: operations.length,
  };
}
