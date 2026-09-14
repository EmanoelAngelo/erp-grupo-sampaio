/**
 * ============================================================================
 * AS QUITAÇÕES ANTIGAS SEM BAIXA (GAP-PRD-171) — o caminho, e a decisão do dono
 * ============================================================================
 *
 * ## O que ficou para trás
 *
 * Antes do V29, a fatia à vista da venda nascia com `settled_cents =
 * amount_cents` e NENHUMA linha em `core_finance_settlements`. O saldo fechava;
 * a história não. A conciliação bancária compara o extrato contra BAIXAS, e
 * para ela essas entradas não existem: o banco da loja tinha 7 lançamentos
 * quitados (R$ 6.223,45) sem baixa nenhuma. Os lançamentos novos nascem com
 * baixa-espelho (`inserirBaixaEspelho`), e o código decidiu de propósito não
 * retroagir: "inventar baixa retroativa com carimbo de hoje sujaria a
 * conciliação de um mês já vivido".
 *
 * ## Por que isto é decisão do dono, e o que o software oferece
 *
 * Criar a baixa-espelho dos antigos muda o que a conciliação de agosto mostra:
 * aqueles recebimentos passam a ter com o que casar no extrato (bom), e a
 * conferência de um mês já fechado passa a ter linhas que não tinha (é o que
 * alguém pode não querer). Não há resposta técnica certa — é escolha de quem
 * responde pelo caixa. O software deixa a escolha PRONTA:
 *
 *   - `listarQuitacoesSemBaixa` diz quais são, quanto, e desde quando;
 *   - `criarBaixasEspelhoLegadas` cria, sob confirmação explícita, a baixa que
 *     falta de cada uma, com a data da QUITAÇÃO ORIGINAL (não a de hoje — é a
 *     objeção que o próprio código fazia), a forma de pagamento do lançamento,
 *     quem mandou criar e a nota "migração";
 *   - nada roda sozinho: nem no boot, nem em migração.
 *
 * ## O que a baixa-espelho NÃO mexe
 *
 * `settled_cents` do lançamento fica como está (a baixa explica o que já
 * estava quitado; somar de novo pagaria em dobro — a mesma razão de
 * `inserirBaixaEspelho` não passar por `settleEntry`). Saldo da conta, resumo,
 * DRE e fluxo de caixa leem `settled_cents` e não mudam. O que muda é a
 * conciliação bancária e o regime de caixa, que leem as baixas.
 *
 * ## Idempotente por construção
 *
 * "O que falta" é recalculado a cada chamada: `settled_cents` menos a soma das
 * baixas que existem (estornos negativos inclusive). Chamar duas vezes cria na
 * primeira e nada na segunda.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export const NOTA_DA_MIGRACAO =
  'Baixa-espelho de migração: lançamento quitado antes do registro de baixas (GAP-PRD-171).';

export interface QuitacaoSemBaixa {
  id: string;
  direction: 'in' | 'out';
  description: string;
  amountCents: number;
  settledCents: number;
  /** O que as baixas existentes explicam. */
  explainedCents: number;
  /** O que falta explicar — o valor da baixa-espelho que seria criada. */
  missingCents: number;
  /** A data que a baixa-espelho levaria: a da quitação, ou a de criação. */
  mirrorDate: string;
  paymentMethod: string | null;
  originType: string;
  createdAt: string;
}

const SQL_DAS_QUITACOES = `
  SELECT e.id, e.direction, e.description, e.amount_cents, e.settled_cents,
         e.payment_method, e.origin_type, e.created_at, e.settled_at,
         COALESCE((SELECT SUM(s.amount_cents) FROM core_finance_settlements s
                    WHERE s.entry_id = e.id AND s.company_id = e.company_id), 0) AS explicado
    FROM core_finance_entries e
   WHERE e.company_id = ? AND e.cancelled_at IS NULL AND e.settled_cents > 0`;

function lerQuitacoes(companyId: string): QuitacaoSemBaixa[] {
  const rows = getConnection()
    .prepare(`${SQL_DAS_QUITACOES} ORDER BY e.created_at, e.id`)
    .all(companyId) as unknown as Record<string, unknown>[];
  return rows
    .map((r) => {
      const settled = Number(r.settled_cents);
      const explicado = Number(r.explicado);
      return {
        id: String(r.id),
        direction: String(r.direction) as 'in' | 'out',
        description: String(r.description),
        amountCents: Number(r.amount_cents),
        settledCents: settled,
        explainedCents: explicado,
        missingCents: settled - explicado,
        mirrorDate: String(r.settled_at ?? r.created_at),
        paymentMethod: (r.payment_method as string | null) ?? null,
        originType: String(r.origin_type),
        createdAt: String(r.created_at),
      };
    })
    .filter((q) => q.missingCents > 0);
}

export function listarQuitacoesSemBaixa(companyId: string): {
  items: QuitacaoSemBaixa[];
  count: number;
  inCents: number;
  outCents: number;
} {
  ensureCoreSchema();
  const items = lerQuitacoes(companyId);
  return {
    items,
    count: items.length,
    inCents: items.filter((i) => i.direction === 'in').reduce((t, i) => t + i.missingCents, 0),
    outCents: items.filter((i) => i.direction === 'out').reduce((t, i) => t + i.missingCents, 0),
  };
}

export function criarBaixasEspelhoLegadas(input: {
  companyId: string;
  userId?: string | null;
  /** Só estes lançamentos. Omitido, todos os que faltam. */
  entryIds?: string[] | null;
  /** A confirmação explícita: sem ela, nada é gravado. */
  confirm: boolean;
}): { created: number; totalCents: number; settlementIds: string[] } {
  ensureCoreSchema();
  if (input.confirm !== true) {
    throw new ApiError(
      'CORE_LEGACY_SETTLEMENTS_CONFIRM_REQUIRED',
      'Confirme a criação das baixas-espelho: ela muda o que a conciliação bancária mostra para os meses antigos.',
      400,
    );
  }
  const filtro = input.entryIds && input.entryIds.length > 0 ? new Set(input.entryIds.map(String)) : null;

  return withTransaction(() => {
    const db = getConnection();
    const inserir = db.prepare(
      `INSERT INTO core_finance_settlements
         (id, entry_id, company_id, amount_cents, method, settled_at, user_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    let total = 0;
    // Recalculado DENTRO da transação: dois cliques não criam duas baixas.
    for (const q of lerQuitacoes(input.companyId)) {
      if (filtro && !filtro.has(q.id)) continue;
      const id = randomUUID();
      inserir.run(
        id,
        q.id,
        input.companyId,
        q.missingCents,
        q.paymentMethod,
        q.mirrorDate,
        input.userId ?? null,
        NOTA_DA_MIGRACAO,
      );
      ids.push(id);
      total += q.missingCents;
    }
    return { created: ids.length, totalCents: total, settlementIds: ids };
  });
}
