/**
 * A CONCILIAÇÃO PERGUNTA AO PROVEDOR (GAP-PRD-016).
 *
 * ## O defeito
 *
 * `reconcileAsaas` compara as intenções do ERP com o financeiro. Só entra na
 * comparação a intenção em que o dinheiro JÁ entrou — e quem move a intenção
 * de `pending` para `confirmed` é o webhook, e só ele. `AsaasHttpClient.getPayment`
 * existia e não tinha um único chamador. Então:
 *
 *   - URL do webhook errada, token não cadastrado (503), servidor desligado
 *     além da janela de reenvio do Asaas → a intenção fica `pending` para
 *     sempre, o título em aberto, e a conciliação diz "tudo confere";
 *   - o relatório feito para achar "cobrado e não lançado" não enxergava
 *     exatamente o caso em que o dinheiro entrou e o ERP não soube.
 *
 * ## A passada
 *
 * Para cada cobrança da operação com referência no provedor e ainda EM ABERTO
 * aqui (`pending`/`overdue`) — mais as canceladas no ERP nos últimos 60 dias,
 * que ainda podem ser pagas (boleto compensado no dia do cancelamento,
 * cobrança restaurada no painel) —, pergunta `GET /payments/:id` e aplica o
 * status que o provedor devolver pelo MESMO caminho do webhook
 * (`aplicarStatusConsultado`). O que mudou, o que falhou e o que ficou de fora
 * pelo teto da passada ficam registrados em `core_asaas_sync_runs`.
 *
 * ## Os cuidados
 *
 *   - A CONTA É DA OPERAÇÃO: o cliente HTTP usa o cofre da empresa, e a
 *     consulta só alcança intenções dela.
 *   - TETO POR PASSADA (padrão 100): o provedor limita requisições; as mais
 *     tempo sem pergunta vão primeiro (`provider_checked_at`), então nenhuma
 *     fica para sempre sem ser consultada.
 *   - CONSULTA QUE FALHA NÃO MUDA NADA: a cobrança continua como estava, e a
 *     falha é contada e nomeada — ausência de resposta não é "não pagou".
 *   - SEM CREDENCIAL, NADA É CONSULTADO — e a passada diz isso.
 *
 * Roda por botão (tela da conciliação) e sozinha (`AsaasSincronizacaoScheduler`,
 * ao subir e a cada intervalo).
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import { aplicarStatusConsultado, getAsaasCredentials } from './PaymentService.js';

/** Quantas cobranças uma passada pergunta, no máximo. */
export const TETO_PADRAO_DA_PASSADA = 100;

/** Janela em que uma cobrança cancelada no ERP ainda é perguntada. */
const DIAS_DE_CANCELADA_NA_PASSADA = 60;

/**
 * O status do provedor → o evento equivalente do webhook.
 *
 * Só o que tem efeito. `PENDING` e os de dunning não mudam nada aqui: a
 * cobrança continua de pé, e inventar equivalência é o erro que faz pedido
 * sair sem ninguém ter pago.
 */
const EVENTO_DO_STATUS: Record<string, string> = {
  PENDING: 'PAYMENT_CREATED',
  AWAITING_RISK_ANALYSIS: 'PAYMENT_AWAITING_RISK_ANALYSIS',
  OVERDUE: 'PAYMENT_OVERDUE',
  CONFIRMED: 'PAYMENT_CONFIRMED',
  RECEIVED: 'PAYMENT_RECEIVED',
  RECEIVED_IN_CASH: 'PAYMENT_RECEIVED',
  REFUNDED: 'PAYMENT_REFUNDED',
  CHARGEBACK_REQUESTED: 'PAYMENT_CHARGEBACK_REQUESTED',
  CHARGEBACK_DISPUTE: 'PAYMENT_CHARGEBACK_DISPUTE',
  AWAITING_CHARGEBACK_REVERSAL: 'PAYMENT_CHARGEBACK_DISPUTE',
};

/**
 * O evento que a conciliação daria a um status do provedor, ou nulo quando
 * ela não o conhece. Exportado para a homologação conferir, com a MESMA
 * tabela, que a consulta da conciliação entende o que o provedor devolve
 * (GAP-PRD-169).
 */
export function eventoDoStatusDoProvedor(status: string): string | null {
  return EVENTO_DO_STATUS[status] ?? null;
}

export interface MudancaDaSincronizacao {
  intentId: string;
  originType: string;
  originId: string;
  originLabel: string | null;
  providerRef: string;
  antes: string;
  depois: string;
  statusNoProvedor: string;
  detail: string;
}

export interface SincronizacaoAsaas {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'manual' | 'automatico';
  checked: number;
  changed: number;
  failed: number;
  skipped: number;
  unconfigured: boolean;
  changes: MudancaDaSincronizacao[];
  errors: { intentId: string; providerRef: string; error: string }[];
}

interface Candidata {
  id: string;
  origin_type: string;
  origin_id: string;
  origin_label: string | null;
  provider_ref: string;
  environment: string;
  status: string;
}

const ROTULO_DA_ORIGEM_SQL = `CASE i.origin_type
         WHEN 'ecommerce_order' THEN 'Pedido online #' || ped.number
         WHEN 'finance_entry' THEN fin.description
         WHEN 'sale' THEN 'Venda #' || v.number
         ELSE NULL END`;

const JOINS_DA_ORIGEM = `LEFT JOIN core_orders ped ON i.origin_type = 'ecommerce_order' AND ped.id = i.origin_id
       LEFT JOIN core_finance_entries fin ON i.origin_type = 'finance_entry' AND fin.id = i.origin_id
       LEFT JOIN core_sales v ON i.origin_type = 'sale' AND v.id = i.origin_id`;

function limiteDasCanceladas(): string {
  return new Date(Date.now() - DIAS_DE_CANCELADA_NA_PASSADA * 24 * 3600 * 1000).toISOString();
}

const FILTRO_DAS_CANDIDATAS = `i.company_id = ? AND i.provider = 'asaas' AND i.provider_ref IS NOT NULL
          AND (i.status IN ('pending', 'overdue') OR (i.status = 'cancelled' AND i.updated_at >= ?))`;

/** Quantas cobranças em aberto (com referência) esta operação tem para perguntar. */
export function contarCobrancasAConsultar(companyId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(`SELECT COUNT(*) AS n FROM core_payment_intents i WHERE ${FILTRO_DAS_CANDIDATAS}`)
    .get(companyId, limiteDasCanceladas()) as { n: number };
  return Number(row.n);
}

/** A frase do provedor para a falha, sem nunca carregar a chave. */
function motivoDaFalha(err: unknown): string {
  if (err instanceof ApiError) {
    const detalhes = err.details as { errors?: { description?: string }[] } | undefined;
    const descricao = detalhes?.errors?.map((e) => e.description).filter(Boolean).join(' ');
    return descricao ? `${descricao} (${err.message})` : err.message;
  }
  return `network:${(err as Error).name}`;
}

function gravarPassada(p: SincronizacaoAsaas, companyId: string, userId: string | null): void {
  getConnection()
    .prepare(
      `INSERT INTO core_asaas_sync_runs
         (id, company_id, trigger, user_id, started_at, finished_at, checked, changed, failed,
          skipped, unconfigured, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.id,
      companyId,
      p.trigger,
      userId,
      p.startedAt,
      p.finishedAt,
      p.checked,
      p.changed,
      p.failed,
      p.skipped,
      p.unconfigured ? 1 : 0,
      JSON.stringify({ changes: p.changes, errors: p.errors }),
    );
}

export async function sincronizarCobrancasComProvedor(input: {
  companyId: string;
  trigger: 'manual' | 'automatico';
  userId?: string | null;
  limite?: number;
  fetchImpl?: typeof fetch;
}): Promise<SincronizacaoAsaas> {
  ensureCoreSchema();
  const db = getConnection();
  const passada: SincronizacaoAsaas = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    trigger: input.trigger,
    checked: 0,
    changed: 0,
    failed: 0,
    skipped: 0,
    unconfigured: false,
    changes: [],
    errors: [],
  };

  if (!getAsaasCredentials({ companyId: input.companyId })) {
    passada.unconfigured = true;
    passada.skipped = contarCobrancasAConsultar(input.companyId);
    passada.finishedAt = new Date().toISOString();
    gravarPassada(passada, input.companyId, input.userId ?? null);
    return passada;
  }

  const teto = Math.min(Math.max(Math.trunc(input.limite ?? TETO_PADRAO_DA_PASSADA), 1), 500);
  const total = contarCobrancasAConsultar(input.companyId);
  const candidatas = db
    .prepare(
      `SELECT i.id, i.origin_type, i.origin_id, i.provider_ref, i.environment, i.status,
              ${ROTULO_DA_ORIGEM_SQL} AS origin_label
         FROM core_payment_intents i
         ${JOINS_DA_ORIGEM}
        WHERE ${FILTRO_DAS_CANDIDATAS}
        ORDER BY COALESCE(i.provider_checked_at, '') ASC, i.created_at ASC
        LIMIT ?`,
    )
    .all(input.companyId, limiteDasCanceladas(), teto) as unknown as Candidata[];
  passada.skipped = Math.max(total - candidatas.length, 0);

  const clientes = new Map<string, AsaasHttpClient>();
  const clienteDo = (ambiente: string) => {
    const chave = ambiente === 'production' ? 'production' : 'sandbox';
    let c = clientes.get(chave);
    if (!c) {
      c = new AsaasHttpClient({ environment: chave, companyId: input.companyId, fetchImpl: input.fetchImpl });
      clientes.set(chave, c);
    }
    return c;
  };

  for (const c of candidatas) {
    let remoto: Record<string, unknown>;
    try {
      remoto = await clienteDo(c.environment).getPayment(c.provider_ref);
    } catch (err) {
      passada.failed += 1;
      passada.errors.push({ intentId: c.id, providerRef: c.provider_ref, error: motivoDaFalha(err) });
      // A pergunta foi feita: a próxima passada começa pelas que nem foram.
      db.prepare('UPDATE core_payment_intents SET provider_checked_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        c.id,
      );
      continue;
    }
    passada.checked += 1;

    const statusNoProvedor = String(remoto.status ?? '');
    const evento = remoto.deleted === true ? 'PAYMENT_DELETED' : (EVENTO_DO_STATUS[statusNoProvedor] ?? '');
    const valor = typeof remoto.value === 'number' ? remoto.value : undefined;
    try {
      const r = aplicarStatusConsultado({
        companyId: input.companyId,
        intentId: c.id,
        evento,
        pagamento: { id: c.provider_ref, value: valor, billingType: remoto.billingType, status: statusNoProvedor },
      });
      if (r.antes !== r.depois) {
        passada.changed += 1;
        passada.changes.push({
          intentId: c.id,
          originType: c.origin_type,
          originId: c.origin_id,
          originLabel: c.origin_label,
          providerRef: c.provider_ref,
          antes: r.antes,
          depois: r.depois,
          statusNoProvedor: remoto.deleted === true ? 'DELETED' : statusNoProvedor,
          detail: r.detail,
        });
      }
    } catch (err) {
      passada.failed += 1;
      passada.errors.push({
        intentId: c.id,
        providerRef: c.provider_ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  passada.finishedAt = new Date().toISOString();
  gravarPassada(passada, input.companyId, input.userId ?? null);
  return passada;
}

/** A última passada desta operação — é o "de quando" da tela da conciliação. */
export function ultimaSincronizacao(companyId: string): SincronizacaoAsaas | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT * FROM core_asaas_sync_runs WHERE company_id = ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(companyId) as Record<string, unknown> | undefined;
  if (!row) return null;
  let detalhe: { changes?: MudancaDaSincronizacao[]; errors?: SincronizacaoAsaas['errors'] };
  try {
    detalhe = row.detail ? JSON.parse(String(row.detail)) : {};
  } catch {
    detalhe = {};
  }
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
    trigger: row.trigger === 'automatico' ? 'automatico' : 'manual',
    checked: Number(row.checked),
    changed: Number(row.changed),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
    unconfigured: Number(row.unconfigured) === 1,
    changes: detalhe.changes ?? [],
    errors: detalhe.errors ?? [],
  };
}

/**
 * A passada automática, para TODAS as operações com credencial.
 *
 * Operação sem chave não é consultada nem registra passada — o registro
 * automático de "sem credencial" a cada meia hora só encheria a tabela.
 * Falha de uma operação não impede a seguinte.
 */
export async function sincronizarTodasAsOperacoes(opcoes: { fetchImpl?: typeof fetch } = {}): Promise<{
  operacoes: number;
  changed: number;
  failed: number;
}> {
  ensureCoreSchema();
  const empresas = getConnection()
    .prepare(
      `SELECT DISTINCT company_id AS id FROM core_payment_intents
        WHERE provider = 'asaas' AND provider_ref IS NOT NULL AND status IN ('pending', 'overdue', 'cancelled')`,
    )
    .all() as { id: string }[];
  let operacoes = 0;
  let changed = 0;
  let failed = 0;
  for (const { id } of empresas) {
    if (!getAsaasCredentials({ companyId: id })) continue;
    if (contarCobrancasAConsultar(id) === 0) continue;
    const r = await sincronizarCobrancasComProvedor({ companyId: id, trigger: 'automatico', fetchImpl: opcoes.fetchImpl });
    operacoes += 1;
    changed += r.changed;
    failed += r.failed;
  }
  return { operacoes, changed, failed };
}
