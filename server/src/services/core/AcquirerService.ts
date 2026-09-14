/**
 * Operadora de cartão — taxa e prazo.
 *
 * ## O problema
 *
 * Uma venda de R$ 100 no crédito nascia como R$ 100 QUITADOS no mesmo dia. Na
 * prática são ~R$ 96,50 daqui a trinta dias. O sistema confundia faturamento
 * com dinheiro em caixa, e errava para cima justamente no meio de pagamento
 * que a loja mais usa.
 *
 * ## O desenho: N parcelas a receber, N linhas de taxa
 *
 * Uma venda de R$ 300 em 3× gera três linhas a RECEBER (R$ 100 cada, vencendo
 * em 30, 60 e 90 dias) e três linhas a PAGAR com a taxa daquela parcela.
 *
 * Três alternativas foram descartadas:
 *
 *  - **uma linha pelo líquido**: a taxa some dentro da receita, e no fim do ano
 *    ninguém sabe quanto a maquininha custou;
 *  - **uma linha bruta mais uma de taxa**: certo no total, mas a venda
 *    parcelada continua sendo uma linha só — à vista disfarçada de prazo, e o
 *    fluxo de caixa segue mentindo sobre QUANDO o dinheiro chega;
 *  - **parcelas sem taxa**: o calendário fica certo e o custo continua invisível.
 *
 * A parcela cabe na tabela sem reabri-la porque `installment_number` já está na
 * chave única desde a rodada 9 — foi declarado para este dia.
 *
 * ## A trava
 *
 * Sem operadora cadastrada, `planForPayment` devolve nulo e a venda no cartão
 * continua nascendo quitada, exatamente como sempre. O comportamento novo só
 * liga quando alguém cadastra taxa e prazo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { somarDias } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';

const agora = () => new Date().toISOString();

export interface Acquirer {
  id: string;
  company_id: string;
  name: string;
  account_id: string | null;
  active: number;
}

export interface AcquirerRate {
  id: string;
  acquirer_id: string;
  payment_method: string;
  installments: number;
  fee_bps: number;
  settlement_days: number;
}

export function listAcquirers(companyId: string, includeInactive = false): Acquirer[] {
  ensureCoreSchema();
  const filtro = includeInactive ? '' : ' AND active = 1';
  return getConnection()
    .prepare(
      `SELECT * FROM core_acquirers WHERE company_id = ?${filtro} ORDER BY name COLLATE NOCASE`,
    )
    .all(companyId) as unknown as Acquirer[];
}

export function createAcquirer(
  companyId: string,
  input: { name: string; accountId?: string | null },
): Acquirer {
  ensureCoreSchema();
  const nome = String(input.name ?? '').trim();
  if (!nome) throw new ApiError('CORE_ACQUIRER_NAME', 'Informe o nome da operadora.', 400);

  const db = getConnection();
  const id = randomUUID();
  const ts = agora();
  try {
    db.prepare(
      `INSERT INTO core_acquirers (id, company_id, name, account_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, companyId, nome, input.accountId ?? null, ts, ts);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new ApiError('CORE_ACQUIRER_DUPLICATE', `Já existe a operadora "${nome}".`, 409);
    }
    throw err;
  }
  return db.prepare('SELECT * FROM core_acquirers WHERE id = ?').get(id) as unknown as Acquirer;
}

export function updateAcquirer(
  companyId: string,
  id: string,
  input: { name?: string; accountId?: string | null; active?: boolean },
): Acquirer {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT id FROM core_acquirers WHERE id = ? AND company_id = ?')
    .get(id, companyId);
  if (!atual) throw new ApiError('CORE_ACQUIRER_NOT_FOUND', 'Operadora não encontrada.', 404);

  db.prepare(
    `UPDATE core_acquirers
        SET name = COALESCE(?, name),
            account_id = ?,
            active = COALESCE(?, active),
            updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    input.name?.trim() || null,
    input.accountId === undefined ? null : input.accountId,
    input.active === undefined ? null : input.active ? 1 : 0,
    agora(),
    id,
    companyId,
  );
  return db.prepare('SELECT * FROM core_acquirers WHERE id = ?').get(id) as unknown as Acquirer;
}

export function listRates(companyId: string, acquirerId?: string): AcquirerRate[] {
  ensureCoreSchema();
  const filtro = acquirerId ? ' AND acquirer_id = ?' : '';
  const params: unknown[] = acquirerId ? [companyId, acquirerId] : [companyId];
  return getConnection()
    .prepare(
      `SELECT * FROM core_acquirer_rates
        WHERE company_id = ?${filtro}
        ORDER BY payment_method, installments`,
    )
    .all(...(params as never[])) as unknown as AcquirerRate[];
}

/**
 * Grava a taxa e o prazo de uma combinação forma × parcelas.
 *
 * A chave é `(empresa, forma, parcelas)`, e não inclui a operadora: duas
 * operadoras cobrando taxas diferentes para crédito em 3× fariam a venda não
 * saber qual aplicar. Uma loja usa uma maquininha por bandeira, não duas para
 * a mesma coisa.
 */
export function setRate(
  companyId: string,
  input: {
    acquirerId: string;
    paymentMethod: string;
    installments: number;
    feeBps: number;
    settlementDays: number;
  },
): AcquirerRate {
  ensureCoreSchema();
  const db = getConnection();
  const op = db
    .prepare('SELECT id FROM core_acquirers WHERE id = ? AND company_id = ?')
    .get(input.acquirerId, companyId);
  if (!op) throw new ApiError('CORE_ACQUIRER_NOT_FOUND', 'Operadora não encontrada.', 404);

  if (!Number.isInteger(input.installments) || input.installments < 1) {
    throw new ApiError('CORE_ACQUIRER_INSTALLMENTS', 'Número de parcelas inválido.', 400);
  }
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0) {
    throw new ApiError('CORE_ACQUIRER_FEE', 'Taxa inválida.', 400);
  }
  if (!Number.isInteger(input.settlementDays) || input.settlementDays < 0) {
    throw new ApiError('CORE_ACQUIRER_DAYS', 'Prazo inválido.', 400);
  }

  const existente = db
    .prepare(
      `SELECT id FROM core_acquirer_rates
        WHERE company_id = ? AND payment_method = ? AND installments = ?`,
    )
    .get(companyId, input.paymentMethod, input.installments) as { id: string } | undefined;

  if (existente) {
    db.prepare(
      `UPDATE core_acquirer_rates
          SET acquirer_id = ?, fee_bps = ?, settlement_days = ?
        WHERE id = ?`,
    ).run(input.acquirerId, input.feeBps, input.settlementDays, existente.id);
    return db
      .prepare('SELECT * FROM core_acquirer_rates WHERE id = ?')
      .get(existente.id) as unknown as AcquirerRate;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_acquirer_rates
       (id, company_id, acquirer_id, payment_method, installments, fee_bps, settlement_days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    companyId,
    input.acquirerId,
    input.paymentMethod,
    input.installments,
    input.feeBps,
    input.settlementDays,
    agora(),
  );
  return db
    .prepare('SELECT * FROM core_acquirer_rates WHERE id = ?')
    .get(id) as unknown as AcquirerRate;
}

export function removeRate(companyId: string, rateId: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare('DELETE FROM core_acquirer_rates WHERE id = ? AND company_id = ?')
    .run(rateId, companyId);
}

export interface SettlementInstallment {
  number: number;
  /** Bruto da parcela. A soma bate com o valor pago, ao centavo. */
  grossCents: number;
  feeCents: number;
  dueDate: string;
}

export interface SettlementPlan {
  acquirerId: string;
  accountId: string | null;
  installments: SettlementInstallment[];
  totalFeeCents: number;
}

/**
 * O calendário de recebimento de um pagamento.
 *
 * Devolve nulo quando não há regra cadastrada para aquela forma e número de
 * parcelas — e é isso que mantém o comportamento antigo intacto em toda
 * instalação que ainda não cadastrou operadora.
 *
 * ## Onde vai o centavo
 *
 * R$ 100,00 em 3× não dá 33,33 três vezes: dá 99,99. A sobra vai para a
 * PRIMEIRA parcela, que é o que a operadora faz e o que o cliente vê na
 * fatura. Jogar na última faria a conferência do último mês nunca fechar.
 */
export function planForPayment(
  companyId: string,
  input: { paymentMethod: string; amountCents: number; installments?: number; saleDate: string },
): SettlementPlan | null {
  ensureCoreSchema();
  const parcelas = Math.max(1, Math.round(input.installments ?? 1));

  const regra = getConnection()
    .prepare(
      `SELECT r.*, a.account_id, a.active
         FROM core_acquirer_rates r
         JOIN core_acquirers a ON a.id = r.acquirer_id
        WHERE r.company_id = ? AND r.payment_method = ? AND r.installments = ?
          AND a.active = 1`,
    )
    .get(companyId, input.paymentMethod, parcelas) as
    | (AcquirerRate & { account_id: string | null })
    | undefined;
  if (!regra) return null;

  const base = Math.floor(input.amountCents / parcelas);
  const sobra = input.amountCents - base * parcelas;

  const lista: SettlementInstallment[] = [];
  let taxaTotal = 0;
  for (let n = 1; n <= parcelas; n += 1) {
    const bruto = n === 1 ? base + sobra : base;
    const taxa = Math.round((bruto * regra.fee_bps) / 10_000);
    taxaTotal += taxa;
    lista.push({
      number: n,
      grossCents: bruto,
      feeCents: taxa,
      // Cada parcela cai um período depois da anterior: 30, 60, 90.
      dueDate: somarDias(input.saleDate, regra.settlement_days * n),
    });
  }

  return {
    acquirerId: regra.acquirer_id,
    accountId: regra.account_id,
    installments: lista,
    totalFeeCents: taxaTotal,
  };
}

/*
  Aqui existiu um `hasAnyRate` cujo comentário dizia "a tela usa" — nenhuma
  tela jamais usou. Saiu com o comentário mentiroso junto: a tela que precisar
  saber se há operadora configurada pergunta pela lista de taxas, que ela já
  carrega.
*/
