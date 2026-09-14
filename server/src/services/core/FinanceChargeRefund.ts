/**
 * ESTORNAR A COBRANÇA PAGA DE UM TÍTULO (GAP-PRD-092).
 *
 * ## O buraco
 *
 * `AsaasHttpClient.refundPayment` tinha um único chamador — o pedido online.
 * No contas a receber, devolver o dinheiro de um PIX/cartão pago era sair do
 * sistema: estornar no portal do Asaas e, depois, lembrar de estornar a baixa
 * na tela de Contas. Até alguém lembrar, o título continuava quitado e a
 * conciliação acusava "lançado e não cobrado" — dois sistemas para um gesto.
 *
 * ## O gesto, e as duas metades dele
 *
 * 1. PEDIR O ESTORNO AO PROVEDOR, na conta DA OPERAÇÃO (cofre da empresa).
 *    Recusa do provedor não muda nada aqui: a cobrança continua paga, com a
 *    frase do provedor no `last_error` e na resposta — "Erro Asaas 400" não diz
 *    a ninguém o que fazer.
 *
 * 2. DESFAZER A BAIXA — só sob confirmação explícita (`desfazerBaixa`). A baixa
 *    que o webhook gravou (`Asaas <cobrança>`) é estornada por
 *    `reverseSettlement`: a linha original fica, marcada, e entra a
 *    contrapartida negativa com o motivo. Estornar receita mexe em competência
 *    e em fechamento de mês; por isso é uma pergunta da tela, e não um efeito
 *    colateral.
 *
 * Quando o estorno JÁ FOI FEITO NO PORTAL (o `PAYMENT_REFUNDED` chegou e a
 * intenção está `refunded`), o mesmo gesto faz só a metade 2 — pedir estorno de
 * novo seria cobrar o provedor por um dinheiro que já voltou.
 *
 * Nada aqui desfaz baixa MANUAL: só a que esta cobrança produziu. Se alguém
 * baixou o título no caixa, a divergência é outra, e continua na conciliação.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import { listEntries, reverseSettlement, type FinanceEntry } from './FinanceService.js';

/** Os status em que o dinheiro ENTROU pela cobrança — os únicos estornáveis. */
const PAGAS = new Set(['confirmed', 'amount_mismatch', 'paid_after_cancel']);

interface IntencaoDoTitulo {
  id: string;
  status: string;
  provider_ref: string | null;
  environment: string;
  method: string;
  amount_cents: number;
}

export interface FinanceChargeRefundResult {
  intentId: string;
  providerRef: string;
  /** O provedor foi chamado AGORA e aceitou. `false` quando já estava estornada. */
  estornadoNoProvedor: boolean;
  /** A baixa desta cobrança foi desfeita AGORA. */
  baixaDesfeita: boolean;
  /** A baixa desta cobrança continua de pé depois do gesto. */
  baixaDePe: boolean;
  entry: FinanceEntry | null;
  detail: string;
}

/** A baixa que ESTA cobrança produziu e que ainda não foi estornada. */
export function baixaViva(companyId: string, entryId: string, providerRef: string): { id: string } | undefined {
  return getConnection()
    .prepare(
      `SELECT id FROM core_finance_settlements
        WHERE company_id = ? AND entry_id = ? AND note = ?
          AND reverses_id IS NULL AND reversed_at IS NULL
        LIMIT 1`,
    )
    .get(companyId, entryId, `Asaas ${providerRef}`) as { id: string } | undefined;
}

/** A frase do provedor, quando ele mandou uma. Nunca carrega a chave. */
function fraseDoProvedor(err: unknown): string {
  if (err instanceof ApiError) {
    const detalhes = err.details as { errors?: { description?: string }[] } | undefined;
    const descricao = detalhes?.errors?.map((e) => e.description).filter(Boolean).join(' ');
    return descricao ? `${descricao} (${err.message})` : err.message;
  }
  return `network:${(err as Error).name}`;
}

interface TituloDaOperacao {
  id: string;
  origin_type: string;
  origin_id: string;
}

function tituloDaOperacao(companyId: string, entryId: string): TituloDaOperacao {
  const row = getConnection()
    .prepare('SELECT id, origin_type, origin_id FROM core_finance_entries WHERE id = ? AND company_id = ?')
    .get(entryId, companyId) as TituloDaOperacao | undefined;
  // 404 e não 403: título de outra operação simplesmente não está aqui.
  if (!row) throw new ApiError('CORE_FINANCE_ENTRY_NOT_FOUND', 'Lançamento não encontrado.', 404);
  return row;
}

/** O título como a tela o lê — pelo par de origem, que é o filtro exato da lista. */
function entryAtual(companyId: string, titulo: TituloDaOperacao): FinanceEntry | null {
  return (
    listEntries(companyId, { originType: titulo.origin_type, originId: titulo.origin_id }).find(
      (e) => e.id === titulo.id,
    ) ?? null
  );
}

export async function refundFinanceEntryCharge(input: {
  companyId: string;
  entryId: string;
  /** A confirmação explícita da tela: desfazer também a baixa do título. */
  desfazerBaixa: boolean;
  motivo?: string | null;
  userId?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FinanceChargeRefundResult> {
  ensureCoreSchema();
  const db = getConnection();
  const titulo = tituloDaOperacao(input.companyId, input.entryId);
  const motivo = String(input.motivo ?? '').trim().slice(0, 200);

  const cobrancas = db
    .prepare(
      `SELECT id, status, provider_ref, environment, method, amount_cents
         FROM core_payment_intents
        WHERE company_id = ? AND origin_type = 'finance_entry' AND origin_id = ?
          AND provider = 'asaas' AND provider_ref IS NOT NULL
        ORDER BY created_at DESC`,
    )
    .all(input.companyId, input.entryId) as unknown as IntencaoDoTitulo[];

  // A PAGA vem primeiro; sem ela, a estornada que ainda deixou baixa de pé.
  const paga = cobrancas.find((c) => PAGAS.has(c.status));
  const estornadaComBaixa = cobrancas.find(
    (c) => c.status === 'refunded' && baixaViva(input.companyId, input.entryId, String(c.provider_ref)),
  );
  const alvo = paga ?? estornadaComBaixa;

  if (!alvo) {
    throw new ApiError(
      'CORE_CHARGE_NOT_REFUNDABLE',
      cobrancas.some((c) => c.status === 'refunded')
        ? 'A cobrança deste título já foi estornada e a baixa dela já foi desfeita: não há mais nada a estornar.'
        : 'Este título não tem cobrança PAGA no provedor. Cobrança em aberto se cancela; baixa manual se estorna pelo histórico de baixas.',
      409,
    );
  }
  const ref = String(alvo.provider_ref);

  if (!paga && !input.desfazerBaixa) {
    throw new ApiError(
      'CORE_CHARGE_NOT_REFUNDABLE',
      'O dinheiro desta cobrança já voltou ao cliente; o que resta é desfazer a baixa do título — confirme essa opção.',
      409,
    );
  }

  let estornadoNoProvedor = false;
  if (paga) {
    const gateway = new AsaasHttpClient({
      environment: paga.environment as 'sandbox' | 'production',
      companyId: input.companyId,
      fetchImpl: input.fetchImpl,
    });
    try {
      await gateway.refundPayment(ref);
      estornadoNoProvedor = true;
    } catch (err) {
      const frase = fraseDoProvedor(err);
      db.prepare('UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?').run(
        `estorno: ${frase}`,
        new Date().toISOString(),
        paga.id,
      );
      const recusaDeVerdade = err instanceof ApiError && err.code === 'ASAAS_REMOTE_ERROR' && err.status < 500;
      throw new ApiError(
        recusaDeVerdade ? 'CORE_CHARGE_REFUND_REFUSED' : 'CORE_CHARGE_REFUND_UNCERTAIN',
        recusaDeVerdade
          ? `O provedor recusou o estorno: ${frase}`
          : `O provedor não confirmou o estorno (${frase}). Ele pode ter sido feito: confira a cobrança antes de tentar de novo — a sincronização da conciliação consulta o provedor.`,
        recusaDeVerdade ? 422 : 502,
      );
    }
  }

  const agora = new Date().toISOString();
  const baixaDesfeita = withTransaction(() => {
    if (estornadoNoProvedor) {
      db.prepare(
        "UPDATE core_payment_intents SET status = 'refunded', last_error = NULL, updated_at = ? WHERE id = ?",
      ).run(agora, alvo.id);
    }
    if (!input.desfazerBaixa) return false;
    const baixa = baixaViva(input.companyId, input.entryId, ref);
    if (!baixa) return false;
    reverseSettlement({
      companyId: input.companyId,
      settlementId: baixa.id,
      userId: input.userId ?? null,
      note: `Estorno Asaas ${ref}${motivo ? ` — ${motivo}` : ''}`,
    });
    return true;
  });

  const baixaDePe = Boolean(baixaViva(input.companyId, input.entryId, ref));
  const partes: string[] = [];
  partes.push(estornadoNoProvedor ? 'Estorno pedido e aceito pelo provedor.' : 'O estorno já estava feito no provedor.');
  if (baixaDesfeita) partes.push('A baixa do título foi desfeita e ele voltou a ficar em aberto.');
  else if (baixaDePe) partes.push('A baixa do título continua de pé — desfaça quando decidir, pelo mesmo botão.');

  return {
    intentId: alvo.id,
    providerRef: ref,
    estornadoNoProvedor,
    baixaDesfeita,
    baixaDePe,
    entry: entryAtual(input.companyId, titulo),
    detail: partes.join(' '),
  };
}
