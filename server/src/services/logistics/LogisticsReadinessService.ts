import { loadEnv } from '../../config/env.js';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { listLogisticsCredentialRefs } from './LogisticsCredentialService.js';
import { COM_INTEGRACAO_DIRETA, resolveCarrierAccess, type LogisticsCarrierAccess } from './LogisticsCarrierAdapter.js';
import type { LogisticsCarrierId } from './LogisticsCredentialService.js';

export type LogisticsReadinessItemStatus = 'ok' | 'pending' | 'blocked';

export interface LogisticsReadinessChecklistItem {
  key: string;
  label: string;
  status: LogisticsReadinessItemStatus;
  message?: string;
}

export interface LogisticsProviderReadiness {
  carrier: string;
  implemented: boolean;
  configured: boolean;
  homologated: boolean;
  productionBlocked: boolean;
  connectionValidated: boolean;
  quoteValidated: boolean;
  labelValidated: boolean;
  trackingValidated: boolean;
  /** O que a credencial desta transportadora permite, e o que ainda trava (códigos). */
  access: LogisticsCarrierAccess;
  items: LogisticsReadinessChecklistItem[];
  blockingReasons: string[];
}

/**
 * O CEP de onde a mercadoria SAI.
 *
 * Vem da configuração fiscal da operação, que é onde o endereço do emitente já
 * está declarado — pedir o mesmo CEP de novo, em outra tela, criaria duas
 * verdades sobre o mesmo galpão.
 */
export function originZipOf(companyId: string): string | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT zip FROM core_fiscal_configs WHERE company_id = ?')
    .get(companyId) as { zip?: string | null } | undefined;
  const cep = String(row?.zip ?? '').replace(/\D/g, '');
  return cep.length === 8 ? cep : null;
}

/**
 * O item AMBIENTE, dito pela credencial — não pela variável.
 *
 * Antes era `blocked` quando `LOGISTICS_PRODUCTION_ENABLED` estava LIGADA
 * ("Produção habilitada — revisar") e `ok` quando desligada: o checklist
 * ficava verde exatamente no estado em que o checkout não cotava ninguém.
 */
function itemAmbiente(access: LogisticsCarrierAccess): LogisticsReadinessChecklistItem {
  const base = { key: 'ambiente', label: 'AMBIENTE' } as const;
  switch (access.mode) {
    case 'production':
      return { ...base, status: 'ok', message: 'PRODUÇÃO — a cotação vale como preço cobrado no checkout.' };
    case 'sandbox':
      return {
        ...base,
        status: 'pending',
        message: 'SANDBOX — a cotação é real, mas do ambiente de teste do provedor: serve para '
          + 'conferir e não aparece no checkout. Para cobrar do cliente, guarde o token de produção.',
      };
    case 'simulated':
      return {
        ...base,
        status: 'pending',
        message: 'Sem integração direta com esta transportadora: a cotação sai simulada e não vale para cobrar.',
      };
    case 'blocked':
      if (access.locks.includes('PRODUCAO_DESABILITADA_NO_PROCESSO')) {
        return {
          ...base,
          status: 'blocked',
          message: 'Token de PRODUÇÃO guardado, mas o servidor está com a produção de logística '
            + 'desligada. Quem administra o servidor libera com LOGISTICS_PRODUCTION_ENABLED=true '
            + 'no ambiente da API; até lá nenhuma cotação de produção é feita.',
        };
      }
      if (access.locks.includes('SANDBOX_EM_SERVIDOR_DE_PRODUCAO')) {
        return {
          ...base,
          status: 'blocked',
          message: 'Token de SANDBOX num servidor de produção: não opera aqui. Guarde o token de produção.',
        };
      }
      return { ...base, status: 'blocked', message: 'Simulação não opera em servidor de produção.' };
    default:
      return { ...base, status: 'pending', message: 'Sem credencial, não há ambiente.' };
  }
}

function buildProviderItems(
  carrier: string,
  cred: Record<string, unknown> | undefined,
  access: LogisticsCarrierAccess,
  originZip: string | null,
): LogisticsProviderReadiness {
  const configured = access.configured;
  const legado = String(cred?.lastTestStatus ?? '');
  const homologated = legado === 'homologated';
  // Conexão e cotação têm campo próprio; `lastTestStatus` só vale para as
  // linhas gravadas antes da separação.
  const conexaoOk = cred?.connectionStatus === 'ok' || (!cred?.connectionStatus && legado === 'connection_ok') || homologated;
  const cotacaoOk = cred?.lastQuoteStatus === 'ok' || (!cred?.lastQuoteStatus && legado === 'quote_ok') || homologated;
  const falhouConexao = cred?.connectionStatus === 'failed';
  const falhouCotacao = cred?.lastQuoteStatus === 'failed';

  /*
    IMPLEMENTADO ERA `ok` FIXO PARA AS TRÊS (GAP-PRD-118).

    Correios e Jadlog não têm cliente HTTP: a cotação sai simulada, e conexão,
    etiqueta e rastreio respondiam "pendente de implementação". O checklist,
    porém, acendia IMPLEMENTADO em verde — e ensinava o dono a contratar os
    Correios acreditando que bastaria a credencial. Agora o item diz a verdade,
    e os outros itens (credencial, conexão, etiqueta...) nem aparecem para
    quem não tem integração: não há o que configurar ali. Os serviços dessas
    transportadoras (PAC, SEDEX, .Package...) chegam pelo Melhor Envio.
  */
  if (!COM_INTEGRACAO_DIRETA.has(carrier as LogisticsCarrierId)) {
    const nome = NOME[carrier] ?? carrier;
    const [com, dos] = carrier === 'correios' ? ['com os', 'dos'] : ['com a', 'da'];
    return {
      carrier,
      implemented: false,
      configured,
      homologated: false,
      productionBlocked: true,
      connectionValidated: false,
      quoteValidated: false,
      labelValidated: false,
      trackingValidated: false,
      access,
      items: [
        {
          key: 'implementado',
          label: 'SEM INTEGRAÇÃO DIRETA',
          status: 'blocked',
          message: `O sistema não fala direto ${com} ${nome}: não há cotação, etiqueta nem rastreio `
            + `por contrato próprio. Os serviços ${dos} ${nome} são cotados, comprados e rastreados pelo `
            + 'Melhor Envio. Um contrato direto exigiria programar a integração — a credencial sozinha não basta.',
        },
      ],
      // Não é pendência de ninguém: não há o que configurar aqui.
      blockingReasons: [],
    };
  }

  const etiquetaOk = cred?.lastLabelStatus === 'ok' || legado === 'label_ok' || homologated;
  const rastreioOk = cred?.lastTrackingStatus === 'ok' || legado === 'tracking_ok' || homologated;

  const items: LogisticsReadinessChecklistItem[] = [
    {
      key: 'implementado',
      label: 'IMPLEMENTADO',
      status: 'ok',
      message: 'Cotação, etiqueta (compra, geração e impressão), rastreio e cancelamento pelo provedor.',
    },
    {
      key: 'credenciais',
      label: 'CREDENCIAIS',
      status: configured ? 'ok' : 'pending',
      message: configured
        ? undefined
        : carrier === 'melhor_envio'
          ? 'Cole o token do Melhor Envio no quadro "Credencial do Melhor Envio", nesta tela.'
          : 'Cadastre credenciais no backend.',
    },
    {
      key: 'origem',
      label: 'ORIGEM/CEP',
      // ESTE ITEM NÃO OLHAVA PARA NADA: era 'pending' fixo, com uma mensagem
      // mandando configurar o que talvez já estivesse configurado. Um item que
      // nunca fica verde ensina a ignorar o checklist inteiro.
      status: originZip ? 'ok' : 'pending',
      message: originZip
        ? undefined
        : 'Informe o CEP da operação em Fiscal → Configuração. É de lá que a '
          + 'mercadoria sai, e sem ele não há o que cotar.',
    },
    itemAmbiente(access),
    {
      key: 'conexao',
      label: 'CONEXÃO',
      status: conexaoOk ? 'ok' : 'pending',
      message: falhouConexao ? String(cred?.connectionMessage ?? 'O último teste de conexão falhou.') : undefined,
    },
    {
      key: 'cotacao',
      label: 'COTAÇÃO',
      status: cotacaoOk ? 'ok' : 'pending',
      message: falhouCotacao ? String(cred?.lastQuoteMessage ?? 'A última cotação falhou.') : undefined,
    },
    {
      // Acende na primeira etiqueta GERADA de verdade (Pedidos → ficha do
      // pedido → Comprar etiqueta). Antes só acendia por um status que nenhum
      // código gravava.
      key: 'etiqueta',
      label: 'ETIQUETA',
      status: etiquetaOk ? 'ok' : 'pending',
      message: etiquetaOk
        ? undefined
        : cred?.lastLabelStatus === 'failed'
          ? String(cred?.lastLabelMessage ?? 'A última etiqueta falhou.')
          : 'Nenhuma etiqueta gerada ainda. A primeira compra, na ficha do pedido, confirma esta etapa.',
    },
    {
      key: 'tracking',
      label: 'RASTREAMENTO',
      status: rastreioOk ? 'ok' : 'pending',
      message: rastreioOk
        ? undefined
        : cred?.lastTrackingStatus === 'failed'
          ? String(cred?.lastTrackingMessage ?? 'A última consulta de rastreio falhou.')
          : 'Nenhuma consulta de rastreio ainda. Ela acontece sozinha depois da primeira etiqueta.',
    },
  ];

  const blockingReasons = items.filter((i) => i.status !== 'ok').map((i) => i.message ?? `${carrier.toUpperCase()} — ${i.label} pendente.`);

  return {
    carrier,
    implemented: true,
    configured,
    homologated,
    productionBlocked: !access.chargeable,
    connectionValidated: conexaoOk,
    quoteValidated: cotacaoOk,
    labelValidated: etiquetaOk,
    trackingValidated: rastreioOk,
    access,
    items,
    blockingReasons,
  };
}

const NOME: Record<string, string> = { correios: 'Correios', jadlog: 'Jadlog', melhor_envio: 'Melhor Envio' };

/**
 * A frase da tarja: o checkout está cobrando transportadora, e se não, por quê.
 *
 * Sai do CONTRATO (credencial + trava de processo), não de uma variável lida
 * sozinha — a tela antes dizia "PRODUÇÃO BLOQUEADA" lendo só a flag.
 */
function resumoDoCheckout(providers: LogisticsProviderReadiness[], originZip: string | null) {
  const cobrando = providers.filter((p) => p.access.chargeable).map((p) => p.carrier);
  if (cobrando.length > 0) {
    return {
      active: true,
      carriers: cobrando,
      message: originZip
        ? `${cobrando.map((c) => NOME[c] ?? c).join(', ')} em produção: a cotação vale como preço de frete no checkout.`
        : `${cobrando.map((c) => NOME[c] ?? c).join(', ')} em produção, mas falta o CEP de origem da operação — sem ele não há o que cotar.`,
    };
  }
  const travas = providers.flatMap((p) => p.access.locks);
  let message = 'Nenhuma transportadora com token de produção: o checkout oferece só retirada e a tabela da loja.';
  if (travas.includes('PRODUCAO_DESABILITADA_NO_PROCESSO')) {
    message = 'O token de produção está guardado, mas o servidor está com a produção de logística desligada '
      + '(LOGISTICS_PRODUCTION_ENABLED). Até ligar, o checkout oferece só retirada e a tabela da loja.';
  } else if (travas.includes('CREDENCIAL_DE_SANDBOX')) {
    message = 'Só há token de SANDBOX: a cotação serve para conferir e não aparece no checkout. '
      + 'Guarde o token de produção para cobrar frete de transportadora.';
  }
  return { active: false, carriers: [] as string[], message };
}

export function buildLogisticsReadinessChecklist(companyId: string): {
  overallStatus: 'ready_for_homologation' | 'pending';
  productionBlocked: boolean;
  processProductionEnabled: boolean;
  externalEnabled: boolean;
  providers: LogisticsProviderReadiness[];
  blockingReasons: string[];
  checkoutCarrier: { active: boolean; carriers: string[]; message: string };
} {
  const env = loadEnv();
  const creds = listLogisticsCredentialRefs(companyId);
  const originZip = originZipOf(companyId);
  const carriers = ['correios', 'jadlog', 'melhor_envio'] as const;
  const providers = carriers.map((carrier) => {
    const access = resolveCarrierAccess(companyId, carrier);
    // A linha que a cotação usa é a mesma que a prontidão lê: a da operação
    // inteira, e a gravada por último.
    const cred = creds
      .filter((c) => c.carrier === carrier)
      .sort((a, b) => {
        const escopo = Number(a.storeId == null) - Number(b.storeId == null);
        return escopo !== 0 ? -escopo : String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
      })[0];
    return buildProviderItems(carrier, cred, access, originZip);
  });
  // Pronto para homologar é ter ALGUMA transportadora fazendo chamada real.
  const readyCore = providers.some((p) => p.access.realCalls);
  const blockingReasons = providers.flatMap((p) => p.blockingReasons);
  const checkoutCarrier = resumoDoCheckout(providers, originZip);

  return {
    overallStatus: readyCore ? 'ready_for_homologation' : 'pending',
    productionBlocked: !checkoutCarrier.active,
    processProductionEnabled: env.logisticsProductionEnabled,
    externalEnabled: env.logisticsExternalEnabled,
    providers,
    blockingReasons,
    checkoutCarrier,
  };
}
