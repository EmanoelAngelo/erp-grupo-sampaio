/**
 * Conciliação bancária: o que o banco diz × o que o financeiro registrou.
 *
 * É a TERCEIRA verdade sobre o mesmo dinheiro. A venda diz que recebeu, o
 * financeiro diz que baixou, e o banco diz o que caiu na conta. Enquanto as
 * três não se olham, a diferença só aparece quando alguém confere o saldo no
 * fim do mês e não bate — sem saber de qual dia veio nem de qual venda.
 *
 * Três divergências, cada uma com um significado diferente para quem responde
 * pelo caixa:
 *
 *   NO EXTRATO, SEM BAIXA   entrou dinheiro na conta e o financeiro não sabe.
 *                           Pode ser recebimento não lançado, transferência
 *                           entre contas ou depósito de terceiro. É o que mais
 *                           esconde receita.
 *   BAIXADO, SEM EXTRATO    o financeiro diz que recebeu e o banco não viu.
 *                           Cheque não compensado, PIX que falhou, ou baixa
 *                           lançada por engano — infla o resultado.
 *   VALOR DIVERGENTE        os dois existem e não batem. Tarifa descontada na
 *                           entrada costuma explicar; diferença redonda, não.
 *
 * A REGRA QUE NÃO SE QUEBRA, a mesma da conciliação do Asaas: ESTA CONCILIAÇÃO
 * NÃO CORRIGE NADA. Ela compara e relata. Ajustar sozinha o lado que "parece
 * errado" é acertar a balança empurrando o prato — some com o sintoma, mantém
 * a causa, e a próxima conferência já parte de um número adulterado.
 *
 * Casar é ato de quem confere, não do sistema: o serviço SUGERE por valor e
 * data, e a pessoa confirma. Casamento automático engoliria justamente o caso
 * que interessa — dois valores iguais no mesmo dia que são fatos diferentes.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { limitesDoPeriodo } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';

export type BankDivergenceKind =
  | 'no_extrato_sem_baixa'
  | 'baixado_sem_extrato'
  | 'valor_divergente';

export interface StatementLineInput {
  occurredAt: string;
  description: string;
  amountCents: number;
  document?: string | null;
  externalId?: string | null;
}

/**
 * Importa linhas de extrato.
 *
 * Reimportar o mesmo arquivo é o caso NORMAL — quem concilia baixa de novo para
 * pegar os últimos dias. Linha com `externalId` já conhecido é ignorada, não
 * duplicada; sem `externalId` o banco não deu identidade e a linha entra, com o
 * risco assumido de repetição.
 */
export function importStatement(input: {
  companyId: string;
  userId?: string;
  accountLabel: string;
  sourceName?: string | null;
  lines: StatementLineInput[];
}): { statementId: string; imported: number; skipped: number } {
  ensureCoreSchema();

  const conta = String(input.accountLabel ?? '').trim();
  if (!conta) throw new ApiError('CORE_BANK_ACCOUNT_REQUIRED', 'Informe a conta.', 400);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ApiError('CORE_BANK_EMPTY', 'O extrato não tem linhas.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const statementId = randomUUID();
    const now = new Date().toISOString();

    const datas = input.lines
      .map((l) => String(l.occurredAt ?? ''))
      .filter(Boolean)
      .sort();

    db.prepare(
      `INSERT INTO core_bank_statements
         (id, company_id, account_label, period_start, period_end, source_name,
          imported_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      statementId,
      input.companyId,
      conta,
      datas[0] ?? null,
      datas[datas.length - 1] ?? null,
      input.sourceName ? String(input.sourceName) : null,
      input.userId ?? null,
      now,
    );

    let importadas = 0;
    let ignoradas = 0;

    for (const linha of input.lines) {
      const valor = Math.round(Number(linha.amountCents));
      if (!Number.isFinite(valor) || valor === 0) {
        // Linha de valor zero não é movimento: é ruído do arquivo.
        ignoradas += 1;
        continue;
      }
      const externo = linha.externalId ? String(linha.externalId).trim() : null;

      if (externo) {
        const existe = db
          .prepare(
            'SELECT id FROM core_bank_statement_lines WHERE company_id = ? AND external_id = ?',
          )
          .get(input.companyId, externo) as { id: string } | undefined;
        if (existe) {
          ignoradas += 1;
          continue;
        }
      }

      db.prepare(
        `INSERT INTO core_bank_statement_lines
           (id, statement_id, company_id, occurred_at, description, amount_cents,
            document, external_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        statementId,
        input.companyId,
        String(linha.occurredAt),
        String(linha.description ?? '').trim() || 'Sem descrição',
        valor,
        linha.document ? String(linha.document) : null,
        externo,
        now,
      );
      importadas += 1;
    }

    return { statementId, imported: importadas, skipped: ignoradas };
  });
}

/**
 * Casa uma linha do extrato com uma baixa do financeiro.
 *
 * Quem confere decide. O sistema sugere, e a sugestão erra: dois recebimentos
 * de mesmo valor no mesmo dia são indistinguíveis para uma regra automática, e
 * casar o par errado esconde a divergência real em vez de mostrá-la.
 */
export function matchLine(input: {
  companyId: string;
  lineId: string;
  settlementId: string;
  userId?: string;
}): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const linha = db
      .prepare('SELECT * FROM core_bank_statement_lines WHERE id = ? AND company_id = ?')
      .get(input.lineId, input.companyId) as Record<string, unknown> | undefined;
    if (!linha) throw new ApiError('CORE_BANK_LINE_NOT_FOUND', 'Linha não encontrada.', 404);

    const baixa = db
      .prepare('SELECT * FROM core_finance_settlements WHERE id = ? AND company_id = ?')
      .get(input.settlementId, input.companyId) as Record<string, unknown> | undefined;
    if (!baixa) throw new ApiError('CORE_SETTLEMENT_NOT_FOUND', 'Baixa não encontrada.', 404);

    // Uma baixa casa com UMA linha: permitir duas faria o mesmo dinheiro
    // aparecer conciliado duas vezes e sumir da lista de divergências.
    const jaCasada = db
      .prepare(
        'SELECT id FROM core_bank_statement_lines WHERE company_id = ? AND matched_settlement_id = ? AND id <> ?',
      )
      .get(input.companyId, input.settlementId, input.lineId) as { id: string } | undefined;
    if (jaCasada) {
      throw new ApiError(
        'CORE_SETTLEMENT_ALREADY_MATCHED',
        'Esta baixa já está conciliada com outra linha do extrato.',
        409,
      );
    }

    db.prepare(
      `UPDATE core_bank_statement_lines
          SET matched_settlement_id = ?, matched_at = ?, matched_by = ?
        WHERE id = ?`,
    ).run(input.settlementId, new Date().toISOString(), input.userId ?? null, input.lineId);

    return { ...linha, matched_settlement_id: input.settlementId };
  });
}

/**
 * Desfaz um casamento — e DIZ o que desfez.
 *
 * O erro humano mais provável desta tela é casar a linha errada: dois
 * recebimentos de mesmo valor no mesmo dia são indistinguíveis para a
 * sugestão, e quem confere clica no primeiro. Desfazer precisava existir na
 * tela (GAP-V26) e, para existir com honestidade, precisa deixar rastro.
 *
 * A função devolvia `void`, e desfazer APAGA `matched_by`/`matched_at` — o
 * único vestígio de quem tinha casado. Sem devolver o que foi desfeito, a
 * trilha de auditoria só poderia registrar "alguém desfez alguma coisa": a
 * baixa que voltou a ficar solta não teria nome em lugar nenhum, e a
 * conferência seguinte encontraria uma divergência sem história.
 */
export function unmatchLine(
  companyId: string,
  lineId: string,
): { lineId: string; settlementId: string | null; amountCents: number; description: string } {
  ensureCoreSchema();
  const db = getConnection();
  const linha = db
    .prepare('SELECT * FROM core_bank_statement_lines WHERE id = ? AND company_id = ?')
    .get(lineId, companyId) as Record<string, unknown> | undefined;
  if (!linha) throw new ApiError('CORE_BANK_LINE_NOT_FOUND', 'Linha não encontrada.', 404);

  db.prepare(
    `UPDATE core_bank_statement_lines
        SET matched_settlement_id = NULL, matched_at = NULL, matched_by = NULL
      WHERE id = ? AND company_id = ?`,
  ).run(lineId, companyId);

  return {
    lineId,
    settlementId: (linha.matched_settlement_id as string | null) ?? null,
    amountCents: Number(linha.amount_cents),
    description: String(linha.description),
  };
}

export interface BankDivergence {
  kind: BankDivergenceKind;
  occurredAt: string;
  description: string;
  bankCents: number | null;
  financeCents: number | null;
  differenceCents: number;
  lineId: string | null;
  settlementId: string | null;
}

/**
 * O relatório.
 *
 * Compara o período pedido nos dois lados e devolve o que NÃO se explica. Não
 * altera nada — nem casa sozinho, nem corrige valor.
 */
export function reconcileBank(input: {
  companyId: string;
  from?: string;
  to?: string;
}): {
  period: { from: string | null; to: string | null };
  bankTotalCents: number;
  financeTotalCents: number;
  differenceCents: number;
  matched: number;
  divergences: BankDivergence[];
} {
  ensureCoreSchema();
  const db = getConnection();
  const from = input.from ?? null;
  const to = input.to ?? null;

  /*
    DUAS COLUNAS, DOIS FORMATOS — e o mesmo período.

    `occurred_at` vem do arquivo do banco e é uma DATA de calendário
    ('2026-08-31'). `settled_at` é o carimbo da baixa, um INSTANTE
    ('2026-08-31T14:00:00.000Z'). Os dois usavam o mesmo par de parâmetros, e
    o resultado era o último dia do período sumindo só de um dos lados:
    '2026-08-31T14:00:00.000Z' <= '2026-08-31' é falso. O total do banco
    fechava e o do financeiro não, e a diferença aparecia como divergência.

    Agora cada coluna recebe a ponta no formato dela, e o instante vem dos
    limites da loja — a baixa das 21h30 é do dia em que o caixa a fez.
  */
  const limitesDoExtrato = limitesDoPeriodo(from, to);
  const filtroData = (coluna: string) => {
    let sql = '';
    if (from) sql += ` AND ${coluna} >= ?`;
    if (to) sql += ` AND ${coluna} <= ?`;
    return sql;
  };
  /** Para coluna de DATA pura, como `occurred_at`. */
  const paramsData: string[] = [];
  if (from) paramsData.push(from);
  if (to) paramsData.push(to);
  /** Para coluna de INSTANTE, como `settled_at`. */
  const paramsInstante: string[] = [];
  if (from) paramsInstante.push(limitesDoExtrato.inicio);
  if (to) paramsInstante.push(limitesDoExtrato.fim);

  const linhas = db
    .prepare(
      `SELECT * FROM core_bank_statement_lines
        WHERE company_id = ?${filtroData('occurred_at')}
        ORDER BY occurred_at`,
    )
    .all(input.companyId, ...paramsData) as unknown as Record<string, unknown>[];

  /*
    O ESTORNO SÃO DUAS LINHAS, E O FILTRO SÓ TIRAVA UMA.

    `reverseSettlement` carimba `reversed_at` na baixa original e INSERE uma
    contrapartida de valor negativo, com `reverses_id` apontando para ela. O
    filtro era só `reversed_at IS NULL`: tirava a original e deixava a
    contrapartida.

    Um par baixa+estorno de R$ 500 somava −R$ 500 no lado do financeiro em vez
    de zero, e a contrapartida ainda entrava na lista como "baixado sem
    extrato" — uma divergência que não existe, no relatório cujo produto é
    justamente a lista de divergências.

    As duas linhas saem juntas, e o par volta a valer zero.
  */
  const baixas = db
    .prepare(
      `SELECT s.*, e.description AS entry_description
         FROM core_finance_settlements s
         JOIN core_finance_entries e ON e.id = s.entry_id
        WHERE s.company_id = ?
          AND s.reversed_at IS NULL AND s.reverses_id IS NULL${filtroData('s.settled_at')}
        ORDER BY s.settled_at`,
    )
    .all(input.companyId, ...paramsInstante) as unknown as Record<string, unknown>[];

  const casadas = new Set(
    linhas.filter((l) => l.matched_settlement_id).map((l) => String(l.matched_settlement_id)),
  );

  const divergences: BankDivergence[] = [];

  for (const linha of linhas) {
    const idBaixa = linha.matched_settlement_id ? String(linha.matched_settlement_id) : null;
    if (!idBaixa) {
      divergences.push({
        kind: 'no_extrato_sem_baixa',
        occurredAt: String(linha.occurred_at),
        description: String(linha.description),
        bankCents: Number(linha.amount_cents),
        financeCents: null,
        differenceCents: Number(linha.amount_cents),
        lineId: String(linha.id),
        settlementId: null,
      });
      continue;
    }

    const baixa = baixas.find((b) => String(b.id) === idBaixa);
    if (!baixa) {
      /*
        A BAIXA CASADA SUMIU DO CONJUNTO — e há duas razões, com desfechos
        opostos.

        Fora do período pedido: não é divergência. Quem pediu agosto e casou
        com uma baixa de julho não tem problema nenhum a resolver.

        ESTORNADA: é a divergência mais importante que este relatório pode
        achar. O banco tem o crédito, o financeiro não tem mais a baixa — é
        cheque devolvido, PIX estornado, cobrança contestada depois de
        conciliada. Antes desta rodada os dois casos caíam no mesmo `continue`,
        e a linha simplesmente desaparecia do relatório feito para encontrá-la.
      */
      const estornada = db
        .prepare(
          `SELECT 1 FROM core_finance_settlements
            WHERE id = ? AND company_id = ? AND reversed_at IS NOT NULL`,
        )
        .get(idBaixa, input.companyId);
      if (!estornada) continue;

      divergences.push({
        kind: 'no_extrato_sem_baixa',
        occurredAt: String(linha.occurred_at),
        description: String(linha.description),
        bankCents: Number(linha.amount_cents),
        financeCents: null,
        differenceCents: Number(linha.amount_cents),
        lineId: String(linha.id),
        settlementId: null,
      });
      continue;
    }

    const diff = Number(linha.amount_cents) - Number(baixa.amount_cents);
    if (diff !== 0) {
      divergences.push({
        kind: 'valor_divergente',
        occurredAt: String(linha.occurred_at),
        description: String(linha.description),
        bankCents: Number(linha.amount_cents),
        financeCents: Number(baixa.amount_cents),
        differenceCents: diff,
        lineId: String(linha.id),
        settlementId: idBaixa,
      });
    }
  }

  for (const baixa of baixas) {
    if (casadas.has(String(baixa.id))) continue;
    divergences.push({
      kind: 'baixado_sem_extrato',
      occurredAt: String(baixa.settled_at),
      description: String(baixa.entry_description ?? 'Baixa'),
      bankCents: null,
      financeCents: Number(baixa.amount_cents),
      differenceCents: -Number(baixa.amount_cents),
      lineId: null,
      settlementId: String(baixa.id),
    });
  }

  const bankTotal = linhas.reduce((s, l) => s + Number(l.amount_cents), 0);
  const financeTotal = baixas.reduce((s, b) => s + Number(b.amount_cents), 0);

  return {
    period: { from, to },
    bankTotalCents: bankTotal,
    financeTotalCents: financeTotal,
    differenceCents: bankTotal - financeTotal,
    matched: casadas.size,
    divergences: divergences.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
  };
}

/**
 * Baixas candidatas para uma linha do extrato.
 *
 * Sugestão, não decisão: mesmo valor, dentro de alguns dias, ainda não casada.
 */
export function suggestMatches(
  companyId: string,
  lineId: string,
  windowDays = 5,
): Record<string, unknown>[] {
  ensureCoreSchema();
  const db = getConnection();
  const linha = db
    .prepare('SELECT * FROM core_bank_statement_lines WHERE id = ? AND company_id = ?')
    .get(lineId, companyId) as Record<string, unknown> | undefined;
  if (!linha) throw new ApiError('CORE_BANK_LINE_NOT_FOUND', 'Linha não encontrada.', 404);

  const base = new Date(String(linha.occurred_at)).getTime();
  const de = new Date(base - windowDays * 86400000).toISOString();
  const ate = new Date(base + windowDays * 86400000).toISOString();

  return db
    .prepare(
      `SELECT s.*, e.description AS entry_description
         FROM core_finance_settlements s
         JOIN core_finance_entries e ON e.id = s.entry_id
        WHERE s.company_id = ? AND s.reversed_at IS NULL
          AND s.amount_cents = ?
          AND s.settled_at >= ? AND s.settled_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM core_bank_statement_lines l
             WHERE l.matched_settlement_id = s.id
          )
        ORDER BY s.settled_at LIMIT 20`,
    )
    .all(companyId, Number(linha.amount_cents), de, ate) as unknown as Record<string, unknown>[];
}

/**
 * ============================================================================
 * A LISTA DE TRABALHO DECLARA O QUE CORTOU (GAP-PRD-177)
 * ============================================================================
 *
 * `listLines` devolvia no máximo 500 linhas e `listStatements` no máximo 50,
 * sem nenhum sinal na resposta. O relatório (`reconcileBank`) não limita — os
 * TOTAIS sempre estiveram certos —, mas a lista em que a pessoa trabalha
 * cortava: num mês com mais de 500 lançamentos bancários, o fim do extrato
 * sumia da tela em silêncio, e com ele as linhas ainda sem conciliação.
 *
 * Agora a página vem com `total` (o que existe no filtro), `limit`, `offset` e
 * `truncated` — o mesmo contrato da Central de Relatórios, que declara a
 * truncagem em vez de escondê-la. A tela mostra "mostrando X de Y" e busca a
 * próxima página. A ordem ganha o `id` como desempate: página por OFFSET sobre
 * uma ordem com empates repete ou pula linha entre uma página e outra.
 */
export interface Pagina<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  /** Há mais linhas no filtro do que as devolvidas nesta página. */
  truncated: boolean;
}

/** Teto por página. O padrão continua sendo o de antes (500). */
export const LINHAS_POR_PAGINA_MAX = 2000;

function paginacao(limit?: number, offset?: number, padrao = 500): { limit: number; offset: number } {
  const l = Math.trunc(Number(limit ?? padrao));
  const o = Math.trunc(Number(offset ?? 0));
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, LINHAS_POR_PAGINA_MAX) : padrao,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

export function listStatementsPage(
  companyId: string,
  opcoes: { limit?: number; offset?: number } = {},
): Pagina<Record<string, unknown>> {
  ensureCoreSchema();
  const { limit, offset } = paginacao(opcoes.limit, opcoes.offset, 50);
  const db = getConnection();
  const total = Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM core_bank_statements WHERE company_id = ?').get(companyId) as {
        n: number;
      }
    ).n,
  );
  const items = db
    .prepare(
      `SELECT s.*, COUNT(l.id) AS line_count,
              SUM(CASE WHEN l.matched_settlement_id IS NOT NULL THEN 1 ELSE 0 END) AS matched_count
         FROM core_bank_statements s
         LEFT JOIN core_bank_statement_lines l ON l.statement_id = s.id
        WHERE s.company_id = ?
        GROUP BY s.id
        ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(companyId, limit, offset) as unknown as Record<string, unknown>[];
  return { items, total, limit, offset, truncated: offset + items.length < total };
}

export function listStatements(companyId: string): Record<string, unknown>[] {
  return listStatementsPage(companyId).items;
}

export interface FiltroDasLinhas {
  statementId?: string;
  onlyUnmatched?: boolean;
  /** Só as já casadas — a lista do "Desfazer" (GAP-V26), paginada à parte. */
  onlyMatched?: boolean;
  limit?: number;
  offset?: number;
}

export function listLinesPage(
  companyId: string,
  filters: FiltroDasLinhas = {},
): Pagina<Record<string, unknown>> {
  ensureCoreSchema();
  const { limit, offset } = paginacao(filters.limit, filters.offset);
  let where = 'WHERE l.company_id = ?';
  const params: (string | number)[] = [companyId];
  if (filters.statementId) {
    where += ' AND l.statement_id = ?';
    params.push(filters.statementId);
  }
  if (filters.onlyUnmatched) where += ' AND l.matched_settlement_id IS NULL';
  else if (filters.onlyMatched) where += ' AND l.matched_settlement_id IS NOT NULL';

  const db = getConnection();
  const total = Number(
    (
      db.prepare(`SELECT COUNT(*) AS n FROM core_bank_statement_lines l ${where}`).get(...params) as {
        n: number;
      }
    ).n,
  );
  // `matched_by` era escrito e nunca nomeado: quem casou a linha com a baixa é
  // parte do fato — conferência tem autor. O nome viaja junto da linha.
  const items = db
    .prepare(
      `SELECT l.*, u.display_name AS matched_by_name
         FROM core_bank_statement_lines l
         LEFT JOIN core_users u ON u.id = l.matched_by
        ${where}
        ORDER BY l.occurred_at, l.id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as Record<string, unknown>[];
  return { items, total, limit, offset, truncated: offset + items.length < total };
}

export function listLines(
  companyId: string,
  filters: FiltroDasLinhas = {},
): Record<string, unknown>[] {
  return listLinesPage(companyId, filters).items;
}
