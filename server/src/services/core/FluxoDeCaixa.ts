/**
 * ============================================================================
 * FLUXO DE CAIXA PROJETADO (GAP-PRD-094)
 * ============================================================================
 *
 * ## A pergunta que nenhuma tela respondia
 *
 * "Tenho caixa para pagar o fornecedor dia 20?" O financeiro sabia o saldo de
 * hoje de cada conta (`accountBalanceCents`), o que está em aberto a receber e
 * a pagar (`summarize`) e as faixas de atraso (`agingPorFaixas`). O que não
 * sabia era JUNTAR: o que entra e o que sai por dia ou semana nos próximos 30,
 * 60 ou 90 dias, e onde o saldo vai parar. O gestor filtrava as duas telas de
 * Contas por vencimento e fazia a conta de cabeça.
 *
 * ## A conta, e o que ela NÃO inventa
 *
 *   saldo projetado no fim do período = saldo de hoje
 *                                      + vencidos que se decidiu contar
 *                                      + Σ (a receber − a pagar) até lá
 *
 * - O SALDO DE HOJE é o das contas cadastradas (partida + o que já foi
 *   quitado por elas) — o mesmo número da tela de Cadastros, pelo mesmo
 *   `accountBalanceCents`. Dinheiro quitado em lançamento SEM conta não entra
 *   no saldo de conta nenhuma, e a resposta diz quanto é (em vez de somar
 *   numa conta que ninguém escolheu).
 * - O QUE ENTRA E SAI é o SALDO em aberto de cada título vivo
 *   (`amount_cents − settled_cents`, `cancelled_at IS NULL` — os mesmos
 *   critérios do resumo e das faixas), pela data de VENCIMENTO. A parcela do
 *   cartão que a operadora deposita em D+30 já é um título com esse
 *   vencimento; ela aparece no dia em que cai, não no dia da venda.
 * - OS VENCIDOS em aberto não têm data futura para cair. Contá-los hoje ou
 *   não é decisão, e a resposta a torna explícita (`overdue`):
 *     'payables' (padrão) — conta a DÍVIDA vencida como saída de hoje e não
 *        conta o RECEBÍVEL vencido: é a leitura conservadora, a que não
 *        promete dinheiro que já atrasou;
 *     'both'  — conta os dois, como se tudo fosse acertado hoje;
 *     'none'  — nenhum dos dois; aparecem só como informação.
 * - SEM VENCIMENTO não há dia para projetar: fica fora e é contado.
 *
 * O MENOR SALDO do período e o PRIMEIRO DIA NEGATIVO saem prontos, porque são
 * a resposta à pergunta do fornecedor.
 *
 * Tudo cercado pela empresa do token; conta de outra operação é 404.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { accountBalanceCents } from './FinanceSetupService.js';

export type GranularidadeDoFluxo = 'day' | 'week';
export type VencidosNoFluxo = 'payables' | 'both' | 'none';

export const HORIZONTE_MAXIMO_DIAS = 366;
const ITENS_POR_PERIODO = 50;
const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;

export interface ItemDoFluxo {
  id: string;
  direction: 'in' | 'out';
  description: string;
  dueDate: string | null;
  /** O que falta receber/pagar — não o valor original. */
  balanceCents: number;
  counterpartyName: string | null;
  originType: string;
  originId: string;
  accountId: string | null;
}

export interface PeriodoDoFluxo {
  start: string;
  end: string;
  inCents: number;
  outCents: number;
  netCents: number;
  /** Saldo projetado ao FIM do período. */
  balanceCents: number;
  count: number;
  /** Os títulos do período, até 50; `count` diz quantos são. */
  items: ItemDoFluxo[];
}

export interface FluxoDeCaixa {
  from: string;
  to: string;
  today: string;
  granularity: GranularidadeDoFluxo;
  overdueMode: VencidosNoFluxo;
  account: { id: string; name: string } | null;
  /** Saldo de hoje das contas consideradas. */
  openingBalanceCents: number;
  accountsConsidered: number;
  overdue: {
    inCents: number;
    outCents: number;
    count: number;
    /** O que desses vencidos entrou na projeção, conforme `overdueMode`. */
    countedInCents: number;
    countedOutCents: number;
  };
  periods: PeriodoDoFluxo[];
  totals: { inCents: number; outCents: number; netCents: number };
  closingBalanceCents: number;
  lowestBalance: { cents: number; date: string };
  /** O primeiro dia em que o saldo projetado fica abaixo de zero, ou nulo. */
  firstNegativeDate: string | null;
  /** Abertos sem vencimento: sem dia para projetar. */
  noDueDate: { inCents: number; outCents: number; count: number };
  /** Abertos com vencimento DEPOIS do horizonte — o que vem a seguir. */
  beyond: { inCents: number; outCents: number; count: number };
  /** Com filtro de conta: abertos que não dizem por qual conta vão passar. */
  withoutAccount: { inCents: number; outCents: number; count: number } | null;
  /** Dinheiro já quitado em lançamento sem conta — fora do saldo de hoje. */
  settledWithoutAccountCents: number;
  caveats: string[];
}

function reais(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dataBR(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;
}

function diasEntre(de: string, ate: string): number {
  const a = Date.parse(`${de}T12:00:00.000Z`);
  const b = Date.parse(`${ate}T12:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

export function projetarFluxoDeCaixa(input: {
  companyId: string;
  from?: string | null;
  to?: string | null;
  /** Alternativa a `to`: quantos dias a partir de `from` (padrão 30). */
  days?: number | null;
  accountId?: string | null;
  granularity?: string | null;
  overdue?: string | null;
}): FluxoDeCaixa {
  ensureCoreSchema();
  const db = getConnection();
  const hoje = hojeNaLoja();
  const caveats: string[] = [];

  for (const [nome, valor] of [
    ['from', input.from],
    ['to', input.to],
  ] as const) {
    if (valor && !SO_DATA.test(valor)) {
      throw new ApiError('CORE_CASH_FLOW_DATE_INVALID', `Data inválida em ${nome}: use AAAA-MM-DD.`, 400);
    }
  }

  /*
    O PASSADO NÃO SE PROJETA. Um `from` anterior a hoje misturaria o que já
    foi pago (e está no saldo) com o que ainda vai cair; a projeção começa
    hoje, e o que venceu antes é a linha dos vencidos.
  */
  let from = input.from || hoje;
  if (from < hoje) {
    caveats.push(
      `A projeção começa hoje (${dataBR(hoje)}), não em ${dataBR(from)}: o que venceu antes aparece como vencido em aberto.`,
    );
    from = hoje;
  }

  let to: string;
  if (input.to) {
    to = input.to;
  } else {
    const dias = Math.trunc(Number(input.days ?? 30));
    if (!Number.isFinite(dias) || dias < 1 || dias > HORIZONTE_MAXIMO_DIAS) {
      throw new ApiError(
        'CORE_CASH_FLOW_RANGE_INVALID',
        `Informe um horizonte entre 1 e ${HORIZONTE_MAXIMO_DIAS} dias.`,
        400,
      );
    }
    to = somarDias(from, dias - 1);
  }
  if (to < from) {
    throw new ApiError('CORE_CASH_FLOW_RANGE_INVALID', 'O fim do período é anterior ao começo.', 400);
  }
  if (diasEntre(from, to) + 1 > HORIZONTE_MAXIMO_DIAS) {
    throw new ApiError(
      'CORE_CASH_FLOW_RANGE_INVALID',
      `O horizonte máximo é de ${HORIZONTE_MAXIMO_DIAS} dias.`,
      400,
    );
  }

  const totalDeDias = diasEntre(from, to) + 1;
  const granularity: GranularidadeDoFluxo =
    input.granularity === 'day' || input.granularity === 'week'
      ? input.granularity
      : totalDeDias <= 31
        ? 'day'
        : 'week';
  const overdueMode: VencidosNoFluxo =
    input.overdue === 'both' || input.overdue === 'none' || input.overdue === 'payables'
      ? input.overdue
      : 'payables';

  // ------------------------------------------------------------ a conta
  let account: { id: string; name: string } | null = null;
  let openingBalanceCents = 0;
  let accountsConsidered: number;
  if (input.accountId) {
    const conta = db
      .prepare('SELECT id, name FROM core_finance_accounts WHERE id = ? AND company_id = ?')
      .get(input.accountId, input.companyId) as { id: string; name: string } | undefined;
    if (!conta) throw new ApiError('CORE_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);
    account = { id: conta.id, name: conta.name };
    openingBalanceCents = accountBalanceCents(input.companyId, conta.id);
    accountsConsidered = 1;
  } else {
    const contas = db
      .prepare('SELECT id FROM core_finance_accounts WHERE company_id = ? AND active = 1')
      .all(input.companyId) as { id: string }[];
    for (const c of contas) openingBalanceCents += accountBalanceCents(input.companyId, c.id);
    accountsConsidered = contas.length;
    if (contas.length === 0) {
      caveats.push(
        'Nenhuma conta cadastrada: o saldo de hoje começa em zero e a projeção mostra só o que entra e sai. Cadastre as contas em Financeiro › Cadastros.',
      );
    }
  }

  const semConta = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN settled_cents ELSE -settled_cents END), 0) AS v
         FROM core_finance_entries
        WHERE company_id = ? AND cancelled_at IS NULL AND account_id IS NULL AND settled_cents > 0`,
    )
    .get(input.companyId) as { v: number };
  const settledWithoutAccountCents = Number(semConta.v);
  if (settledWithoutAccountCents !== 0 && !account) {
    caveats.push(
      `${reais(Math.abs(settledWithoutAccountCents))} já ${
        settledWithoutAccountCents > 0 ? 'recebidos (líquido)' : 'pagos (líquido)'
      } em lançamentos sem conta definida não estão no saldo de hoje: não se sabe em que conta esse dinheiro está.`,
    );
  }

  // ---------------------------------------------------------- os títulos
  const params: unknown[] = [input.companyId];
  let filtroConta = '';
  if (account) {
    filtroConta = ' AND e.account_id = ?';
    params.push(account.id);
  }
  const abertos = db
    .prepare(
      `SELECT e.id, e.direction, e.description, e.due_date, e.account_id,
              e.origin_type, e.origin_id,
              e.amount_cents - e.settled_cents AS saldo,
              COALESCE(c.name, s.name) AS contraparte
         FROM core_finance_entries e
         LEFT JOIN core_customers c ON c.id = e.customer_id
         LEFT JOIN core_suppliers s ON s.id = e.supplier_id
        WHERE e.company_id = ? AND e.cancelled_at IS NULL
          AND e.settled_cents < e.amount_cents${filtroConta}
        ORDER BY e.due_date, e.direction DESC, e.created_at`,
    )
    .all(...(params as never[])) as unknown as {
    id: string;
    direction: 'in' | 'out';
    description: string;
    due_date: string | null;
    account_id: string | null;
    origin_type: string;
    origin_id: string;
    saldo: number;
    contraparte: string | null;
  }[];

  // Os períodos, do começo ao fim, sem buraco: dia sem movimento é linha com
  // zero — é justamente nele que o saldo projetado continua o mesmo.
  const periods: PeriodoDoFluxo[] = [];
  const passo = granularity === 'day' ? 1 : 7;
  for (let inicio = from; inicio <= to; inicio = somarDias(inicio, passo)) {
    const fim = somarDias(inicio, passo - 1);
    periods.push({
      start: inicio,
      end: fim > to ? to : fim,
      inCents: 0,
      outCents: 0,
      netCents: 0,
      balanceCents: 0,
      count: 0,
      items: [],
    });
  }
  const periodoDe = (dia: string): PeriodoDoFluxo | undefined =>
    periods[Math.floor(diasEntre(from, dia) / passo)];

  const overdue = { inCents: 0, outCents: 0, count: 0, countedInCents: 0, countedOutCents: 0 };
  const noDueDate = { inCents: 0, outCents: 0, count: 0 };
  const beyond = { inCents: 0, outCents: 0, count: 0 };

  for (const t of abertos) {
    const saldo = Number(t.saldo);
    const entra = t.direction === 'in';
    if (!t.due_date) {
      noDueDate.count += 1;
      if (entra) noDueDate.inCents += saldo;
      else noDueDate.outCents += saldo;
      continue;
    }
    const venc = t.due_date.slice(0, 10);
    if (venc < from) {
      overdue.count += 1;
      if (entra) overdue.inCents += saldo;
      else overdue.outCents += saldo;
      continue;
    }
    if (venc > to) {
      beyond.count += 1;
      if (entra) beyond.inCents += saldo;
      else beyond.outCents += saldo;
      continue;
    }
    const p = periodoDe(venc);
    if (!p) continue;
    p.count += 1;
    if (entra) p.inCents += saldo;
    else p.outCents += saldo;
    if (p.items.length < ITENS_POR_PERIODO) {
      p.items.push({
        id: t.id,
        direction: t.direction,
        description: t.description,
        dueDate: venc,
        balanceCents: saldo,
        counterpartyName: t.contraparte,
        originType: t.origin_type,
        originId: t.origin_id,
        accountId: t.account_id,
      });
    }
  }

  overdue.countedOutCents = overdueMode === 'none' ? 0 : overdue.outCents;
  overdue.countedInCents = overdueMode === 'both' ? overdue.inCents : 0;

  // O saldo anda período a período. Os vencidos contados entram no primeiro
  // (hoje): é quando se decidiu que eles acontecem.
  let saldo = openingBalanceCents + overdue.countedInCents - overdue.countedOutCents;
  let menor = { cents: saldo, date: from };
  let primeiroNegativo: string | null = saldo < 0 ? from : null;
  const totals = { inCents: 0, outCents: 0, netCents: 0 };
  for (const p of periods) {
    p.netCents = p.inCents - p.outCents;
    saldo += p.netCents;
    p.balanceCents = saldo;
    totals.inCents += p.inCents;
    totals.outCents += p.outCents;
    if (saldo < menor.cents) menor = { cents: saldo, date: p.end };
    if (saldo < 0 && !primeiroNegativo) {
      // Na visão diária, o dia exato; na semanal, o primeiro dia da semana
      // em que um título de saída leva o saldo abaixo de zero.
      primeiroNegativo = granularity === 'day' ? p.start : primeiroDiaNegativo(p, saldo - p.netCents);
    }
  }
  totals.netCents = totals.inCents - totals.outCents;

  if (overdue.count > 0) {
    const partes: string[] = [];
    if (overdue.outCents > 0) {
      partes.push(
        `${reais(overdue.outCents)} a pagar vencidos ${overdueMode === 'none' ? 'não foram contados' : 'contam como saída de hoje'}`,
      );
    }
    if (overdue.inCents > 0) {
      partes.push(
        `${reais(overdue.inCents)} a receber vencidos ${overdueMode === 'both' ? 'contam como entrada de hoje' : 'não foram contados — recebível atrasado não é dinheiro garantido'}`,
      );
    }
    caveats.push(`Vencidos em aberto: ${partes.join('; ')}.`);
  }
  if (noDueDate.count > 0) {
    caveats.push(
      `${noDueDate.count} título(s) em aberto sem vencimento (${reais(noDueDate.inCents)} a receber, ${reais(noDueDate.outCents)} a pagar) ficaram fora: sem data não há dia para projetar.`,
    );
  }
  if (periods.some((p) => p.count > p.items.length)) {
    caveats.push(`Cada período lista até ${ITENS_POR_PERIODO} títulos; os totais contam todos.`);
  }

  let withoutAccount: FluxoDeCaixa['withoutAccount'] = null;
  if (account) {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents - settled_cents ELSE 0 END), 0) AS entra,
                COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents - settled_cents ELSE 0 END), 0) AS sai
           FROM core_finance_entries
          WHERE company_id = ? AND cancelled_at IS NULL AND settled_cents < amount_cents
            AND account_id IS NULL
            AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?`,
      )
      .get(input.companyId, from, to) as { n: number; entra: number; sai: number };
    withoutAccount = { count: Number(r.n), inCents: Number(r.entra), outCents: Number(r.sai) };
    if (withoutAccount.count > 0) {
      caveats.push(
        `${withoutAccount.count} título(s) do período não dizem por qual conta vão passar (${reais(withoutAccount.inCents)} a receber, ${reais(withoutAccount.outCents)} a pagar) e não estão nesta projeção. Veja a projeção de todas as contas.`,
      );
    }
  }

  return {
    from,
    to,
    today: hoje,
    granularity,
    overdueMode,
    account,
    openingBalanceCents,
    accountsConsidered,
    overdue,
    periods,
    totals,
    closingBalanceCents: saldo,
    lowestBalance: menor,
    firstNegativeDate: primeiroNegativo,
    noDueDate,
    beyond,
    withoutAccount,
    settledWithoutAccountCents,
    caveats,
  };
}

/** Dentro de uma semana, o dia em que o saldo cruza o zero. */
function primeiroDiaNegativo(p: PeriodoDoFluxo, saldoAntes: number): string {
  const porDia = new Map<string, number>();
  for (const i of p.items) {
    const d = i.dueDate ?? p.start;
    porDia.set(d, (porDia.get(d) ?? 0) + (i.direction === 'in' ? i.balanceCents : -i.balanceCents));
  }
  let saldo = saldoAntes;
  for (const dia of [...porDia.keys()].sort()) {
    saldo += porDia.get(dia) ?? 0;
    if (saldo < 0) return dia;
  }
  // Mais de 50 títulos na semana: a lista não traz todos, e o dia exato não é
  // conhecido — o começo da semana é a resposta segura.
  return p.start;
}
