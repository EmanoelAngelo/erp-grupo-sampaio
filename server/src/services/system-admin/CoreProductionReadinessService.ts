/**
 * Prontidão do núcleo para produção.
 *
 * GAP-PRD-057: o READY vinha de `loadDb().version >= 15` — a versão da camada
 * de DOCUMENTOS, que fica em 19 para sempre depois do primeiro boot. A sonda
 * não conseguia ficar vermelha, e para medir ela materializava as coleções
 * inteiras. Agora mede o NÚCLEO (`core_meta.core_schema_version` contra
 * `CORE_TARGET_VERSION`, com as marcas de passo) — o mesmo número de
 * `npm run db:status` e da tela Configurações › Sistema.
 *
 * As pendências externas deixaram de ser seis frases fixas ("chave pendente")
 * ditas com a chave presente ou ausente: cada uma nomeia a chave de produção
 * que está desligada neste servidor. O que falta EMPRESA POR EMPRESA
 * (certificado, CSC, conta do Asaas, transportadora) é a tela Empresas ›
 * Implantação que diz — não esta sonda global.
 *
 * Duas coisas a mais, da frente PAG: a maquininha de TESTE ligada em alguma
 * operação é BLOQUEIO do núcleo (GAP-PRD-001), e o que cada operação ainda
 * precisa cadastrar ou instalar vem junto, sem bloquear (GAP-PRD-083/203).
 *
 * E a DERIVA DO ESQUEMA (GAP-PRD-140): o banco contra um banco novo desta
 * build — colunas, DEFAULT, UNIQUE, CHECK e índices. Não bloqueia o núcleo (a
 * subida repara o que é seguro), mas o que ela não pôde reparar fica dito
 * aqui e na tela Sistema, item a item, com o motivo e o comando.
 */

import { loadEnv } from '../../config/env.js';
import { fraseDaSituacao, versoesDoBancoEmUso, type VersoesDoEsquema } from '../../db/versaoDoEsquema.js';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { listActiveTestTerminalConfigurations } from '../payment-terminal/PaymentTerminalService.js';
import { situacaoDasImpressoras } from '../core/PrintEngine.js';
import { derivaDoBancoEmUso, type DerivaDoEsquema } from '../../db/derivaDoEsquema.js';

export type CoreReadinessStatus = 'READY' | 'NOT_READY';
export type ExternalIntegrationsStatus = 'PENDING' | 'PARTIAL' | 'READY';
export type CoreProductionOverallStatus =
  | 'not_ready'
  | 'conditionally_ready'
  | 'ready_for_core_production'
  | 'ready_for_full_production';

type Env = ReturnType<typeof loadEnv>;

/** As seis chaves de produção, com o nome que o operador escreve no `.env`. */
const CHAVES_DE_PRODUCAO: Array<{ modulo: string; chave: string; ligada: (env: Env) => boolean }> = [
  { modulo: 'Asaas (cobrança online)', chave: 'ASAAS_PRODUCTION_ENABLED', ligada: (e) => e.asaasProductionEnabled },
  { modulo: 'NF-e', chave: 'NFE_PRODUCTION_ENABLED', ligada: (e) => e.nfeProductionEnabled },
  { modulo: 'NFC-e', chave: 'NFCE_PRODUCTION_ENABLED', ligada: (e) => e.nfceProductionEnabled },
  { modulo: 'Logística', chave: 'LOGISTICS_PRODUCTION_ENABLED', ligada: (e) => e.logisticsProductionEnabled },
  {
    modulo: 'Maquininha/TEF',
    chave: 'PAYMENT_TERMINAL_PRODUCTION_ENABLED',
    ligada: (e) => e.paymentTerminalProductionEnabled,
  },
  { modulo: 'E-commerce', chave: 'ECOMMERCE_PRODUCTION_ENABLED', ligada: (e) => e.ecommerceProductionEnabled },
];

function resolveExternalStatus(env: Env): ExternalIntegrationsStatus {
  const ligadas = CHAVES_DE_PRODUCAO.map((c) => c.ligada(env));
  if (ligadas.every(Boolean)) return 'READY';
  if (ligadas.some(Boolean)) return 'PARTIAL';
  return 'PENDING';
}

/**
 * Maquininha de TESTE ligada em alguma operação (GAP-PRD-001).
 *
 * O banco real da Preço Justo tem uma configuração `mock` ativa: fora de
 * produção ela aprova cartão sem dinheiro, e em produção é ignorada pelo
 * balcão — mas continua gravada, esperando o dia em que alguém suba o
 * processo sem a variável de ambiente. Go-live com isso ligado não é
 * "pronto": vira bloqueio crítico com o nome da operação, até o gestor
 * desligá-la (Vendas › Conferência de maquininha) — ou até o passo 85 da
 * migração desligá-la, com rastro e auditoria.
 */
function maquininhasDeTesteLigadas() {
  ensureCoreSchema();
  const nomeDa = getConnection().prepare('SELECT trade_name FROM core_companies WHERE id = ?');
  return listActiveTestTerminalConfigurations().map((c) => {
    const empresa = nomeDa.get(c.companyId) as { trade_name?: string } | undefined;
    return { ...c, companyName: empresa?.trade_name ?? c.companyId };
  });
}

/**
 * O QUE CADA OPERAÇÃO AINDA PRECISA CADASTRAR OU INSTALAR (GAP-PRD-083, GAP-PRD-203).
 *
 * Nada disto é defeito, e nada disto bloqueia o núcleo: sem taxa de operadora
 * o cartão segue pelo caminho declarado (recebido no dia, valor cheio); sem
 * impressora o cupom sai pelo navegador. Mas o dono precisa saber, operação
 * por operação, o que ainda depende DELE — taxa e prazo de cada contrato de
 * maquininha, a impressora térmica de cada balcão, o agente local instalado e
 * testado —, e esta é a lista. Cada item diz quem resolve e em que tela; com o
 * insumo em mãos, nenhuma linha de código.
 */
export interface PendenciaDeConfiguracao {
  companyId: string;
  companyName: string;
  area: 'operadora_de_cartao' | 'impressora' | 'agente_local';
  /** Quem resolve: o dono (contrato/cadastro) ou a instalação de equipamento. */
  quem: 'dono' | 'equipamento';
  mensagem: string;
  onde: string;
}

export function pendenciasDeConfiguracao(): PendenciaDeConfiguracao[] {
  ensureCoreSchema();
  const db = getConnection();
  const empresas = db
    .prepare('SELECT id, trade_name FROM core_companies ORDER BY trade_name')
    .all() as { id: string; trade_name: string }[];
  const taxasDa = db.prepare(
    `SELECT COUNT(*) AS n FROM core_acquirer_rates r
       JOIN core_acquirers a ON a.id = r.acquirer_id
      WHERE r.company_id = ? AND a.active = 1`,
  );
  const lista: PendenciaDeConfiguracao[] = [];
  for (const e of empresas) {
    const base = { companyId: e.id, companyName: e.trade_name };
    if ((taxasDa.get(e.id) as { n: number }).n === 0) {
      lista.push({
        ...base,
        area: 'operadora_de_cartao',
        quem: 'dono',
        mensagem:
          'Nenhuma taxa de operadora de cartão cadastrada: a venda no cartão entra como recebida no dia, pelo '
          + 'valor cheio, e a taxa não aparece como despesa.',
        onde: 'Financeiro › Operadoras de cartão',
      });
    }
    const impressoras = situacaoDasImpressoras(e.id).filter((p) => p.active);
    if (!impressoras.some((p) => p.kind === 'cupom')) {
      lista.push({
        ...base,
        area: 'impressora',
        quem: 'equipamento',
        mensagem:
          'Nenhuma impressora de cupom cadastrada: o cupom sai pela impressora que o navegador escolher, com a '
          + 'caixa de diálogo, e a gaveta abre pela chave.',
        onde: 'Configurações › Impressoras',
      });
    }
    for (const p of impressoras.filter((i) => i.transport === 'agent')) {
      if (p.problem) {
        lista.push({
          ...base,
          area: 'agente_local',
          quem: 'equipamento',
          mensagem: `Impressora de agente "${p.name}": ${p.problem}`,
          onde: 'Configurações › Impressoras',
        });
      } else if (p.lastTest?.status !== 'printed') {
        lista.push({
          ...base,
          area: 'agente_local',
          quem: 'equipamento',
          mensagem: `Impressora de agente "${p.name}" sem página de teste confirmada pelo agente.`,
          onde: 'Configurações › Impressoras',
        });
      }
    }
  }
  return lista;
}

export interface CoreProductionReadiness {
  coreStatus: CoreReadinessStatus;
  externalIntegrationsStatus: ExternalIntegrationsStatus;
  overallStatus: CoreProductionOverallStatus;
  criticalBlockers: string[];
  externalBlockers: string[];
  productionFlagsBlocked: boolean;
  /** A versão do NÚCLEO (a que muda com o código). */
  databaseVersion: number | null;
  /** O esquema inteiro: núcleo contra o alvo, e a camada de documentos rotulada. */
  schema: VersoesDoEsquema;
  /** As maquininhas de teste ligadas — cada uma é um bloqueio (GAP-PRD-001). */
  testTerminalConfigurations: ReturnType<typeof maquininhasDeTesteLigadas>;
  /** O que cada operação ainda precisa cadastrar ou instalar; não bloqueia (GAP-PRD-083/203). */
  configurationPending: PendenciaDeConfiguracao[];
  /** O banco contra um banco novo desta build (GAP-PRD-140); não bloqueia o núcleo. */
  schemaDrift: DerivaDoEsquema;
  environment: string;
  asaasEnabled: boolean;
  asaasProductionEnabled: boolean;
  lastEvaluatedAt: string;
}

export function evaluateCoreProductionReadiness(): CoreProductionReadiness {
  const env = loadEnv();
  const schema = versoesDoBancoEmUso();
  const desligadas = CHAVES_DE_PRODUCAO.filter((c) => !c.ligada(env));
  const testTerminalConfigurations = maquininhasDeTesteLigadas();
  const bloqueiosDeMaquininha = testTerminalConfigurations.map(
    (c) => `Maquininha de TESTE (provider mock) ligada em ${c.companyName}: aprova cartão sem dinheiro. `
      + 'Desligue em Vendas › Conferência de maquininha antes do go-live.',
  );

  const esquemaEmDia = schema.situacao === 'EM_DIA';
  const coreStatus: CoreReadinessStatus =
    esquemaEmDia && bloqueiosDeMaquininha.length === 0 ? 'READY' : 'NOT_READY';
  const externalIntegrationsStatus = resolveExternalStatus(env);

  let overallStatus: CoreProductionOverallStatus = 'not_ready';
  if (coreStatus === 'READY') {
    if (externalIntegrationsStatus === 'READY') overallStatus = 'ready_for_full_production';
    else if (externalIntegrationsStatus === 'PARTIAL') overallStatus = 'conditionally_ready';
    else overallStatus = 'ready_for_core_production';
  }

  return {
    coreStatus,
    externalIntegrationsStatus,
    overallStatus,
    criticalBlockers: [
      ...(esquemaEmDia ? [] : [`Esquema do núcleo: ${fraseDaSituacao(schema)}`]),
      ...bloqueiosDeMaquininha,
    ],
    externalBlockers: desligadas.map(
      (c) =>
        `${c.modulo} — produção desligada neste servidor (${c.chave}=false). `
        + 'O que falta em cada empresa está em Empresas › Implantação.',
    ),
    productionFlagsBlocked: desligadas.length === CHAVES_DE_PRODUCAO.length,
    databaseVersion: schema.nucleo.versao,
    schema,
    testTerminalConfigurations,
    // Não bloqueia o núcleo: é o que cada operação ainda precisa cadastrar ou
    // instalar (GAP-PRD-083/203), com quem resolve e onde.
    configurationPending: pendenciasDeConfiguracao(),
    // O banco igual a um banco novo desta build? (GAP-PRD-140)
    schemaDrift: derivaDoBancoEmUso(),
    environment: env.DEVORA_API_ENV,
    asaasEnabled: env.asaasEnabled,
    asaasProductionEnabled: env.asaasProductionEnabled,
    lastEvaluatedAt: new Date().toISOString(),
  };
}
