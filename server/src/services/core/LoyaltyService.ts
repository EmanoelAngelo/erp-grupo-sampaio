/**
 * Fidelidade.
 *
 * PONTO ACUMULADO É DÍVIDA DA LOJA, NÃO RECEITA.
 *
 * Cada ponto que o cliente junta é desconto que a loja vai dar depois. Se o
 * ponto entrasse como faturamento, o resultado de hoje subiria e o dia do
 * resgate abriria um buraco do mesmo tamanho — receita reconhecida duas vezes,
 * a mercadoria saindo uma. Por isso a razão de pontos é separada e NÃO encosta
 * em `core_finance_entries`: o que entra no financeiro é a venda, pelo valor
 * que o cliente pagou de verdade.
 *
 * O saldo é a SOMA da razão, nunca um número guardado à parte. Guardar o total
 * numa coluna criaria duas versões da mesma verdade, e a divergência apareceria
 * no balcão, com o cliente afirmando ter mais ponto do que a tela mostra.
 *
 * TRÊS REGRAS QUE CUSTAM DINHEIRO SE ERRADAS:
 *
 *   1. Venda cancelada ou devolvida ESTORNA o ponto — NOS DOIS SENTIDOS: o
 *      acumulado sai (senão o cliente acumula comprando e desistindo) e o
 *      resgatado volta (senão o cliente perde os pontos com que pagou uma
 *      compra que não houve).
 *   2. O valor resgatado NÃO gera ponto. Senão o desconto vira acúmulo, e o
 *      programa se paga sozinho para sempre.
 *   3. Resgate não deixa saldo negativo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface LoyaltyProgram {
  company_id: string;
  active: number;
  cents_per_point: number;
  point_value_cents: number;
  min_points_to_redeem: number;
}

/** Programa da operação. Sem configuração, nasce desligado. */
export function getProgram(companyId: string): LoyaltyProgram {
  ensureCoreSchema();
  const db = getConnection();
  const row = db
    .prepare('SELECT * FROM core_loyalty_programs WHERE company_id = ?')
    .get(companyId) as unknown as LoyaltyProgram | undefined;
  if (row) return row;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_loyalty_programs
       (company_id, active, cents_per_point, point_value_cents, min_points_to_redeem,
        created_at, updated_at)
     VALUES (?, 0, 100, 1, 0, ?, ?)`,
  ).run(companyId, now, now);
  return db
    .prepare('SELECT * FROM core_loyalty_programs WHERE company_id = ?')
    .get(companyId) as unknown as LoyaltyProgram;
}

export function updateProgram(
  companyId: string,
  input: {
    active?: boolean;
    centsPerPoint?: number;
    pointValueCents?: number;
    minPointsToRedeem?: number;
  },
): LoyaltyProgram {
  ensureCoreSchema();
  const atual = getProgram(companyId);

  const centsPerPoint = Math.round(Number(input.centsPerPoint ?? atual.cents_per_point));
  const pointValue = Math.round(Number(input.pointValueCents ?? atual.point_value_cents));
  const minimo = Math.round(Number(input.minPointsToRedeem ?? atual.min_points_to_redeem));

  // Zero centavos por ponto daria ponto infinito na primeira venda.
  if (!Number.isFinite(centsPerPoint) || centsPerPoint < 1) {
    throw new ApiError('CORE_LOYALTY_RATE_INVALID', 'Informe quantos centavos valem 1 ponto.', 400);
  }
  if (!Number.isFinite(pointValue) || pointValue < 0) {
    throw new ApiError('CORE_LOYALTY_VALUE_INVALID', 'Valor do ponto inválido.', 400);
  }
  if (!Number.isFinite(minimo) || minimo < 0) {
    throw new ApiError('CORE_LOYALTY_MIN_INVALID', 'Mínimo para resgate inválido.', 400);
  }

  getConnection()
    .prepare(
      `UPDATE core_loyalty_programs
          SET active = ?, cents_per_point = ?, point_value_cents = ?,
              min_points_to_redeem = ?, updated_at = ?
        WHERE company_id = ?`,
    )
    .run(
      input.active === undefined ? atual.active : input.active ? 1 : 0,
      centsPerPoint,
      pointValue,
      minimo,
      new Date().toISOString(),
      companyId,
    );
  return getProgram(companyId);
}

/** Saldo é a soma da razão. Não existe total guardado à parte. */
export function pointsBalance(companyId: string, customerId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      'SELECT COALESCE(SUM(points), 0) AS saldo FROM core_loyalty_entries WHERE company_id = ? AND customer_id = ?',
    )
    .get(companyId, customerId) as { saldo: number };
  return row.saldo;
}

function inserirLinha(input: {
  companyId: string;
  customerId: string;
  kind: string;
  points: number;
  saleId?: string | null;
  returnId?: string | null;
  description: string;
  userId?: string | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_loyalty_entries
         (id, company_id, customer_id, kind, points, sale_id, return_id, description,
          created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.companyId,
      input.customerId,
      input.kind,
      input.points,
      input.saleId ?? null,
      input.returnId ?? null,
      input.description,
      input.userId ?? null,
      new Date().toISOString(),
    );
}

/**
 * Acumula pela venda.
 *
 * Sobre o valor EFETIVAMENTE PAGO, e descontado do que foi resgatado na
 * própria venda: acumular sobre o desconto que os pontos deram faria o programa
 * se pagar sozinho.
 *
 * Silencioso quando não há o que fazer — venda sem cliente, programa desligado
 * ou valor baixo demais para 1 ponto. Recusar a venda porque a fidelidade não
 * se aplica seria travar o balcão por um benefício.
 */
export function accrueForSale(input: {
  companyId: string;
  saleId: string;
  userId?: string;
}): { points: number; skipped: string | null } {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const sale = db
      .prepare('SELECT * FROM core_sales WHERE id = ? AND company_id = ?')
      .get(input.saleId, input.companyId) as
      | { id: string; number: number; customer_id: string | null; total_cents: number; status: string }
      | undefined;
    if (!sale) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);

    if (!sale.customer_id) return { points: 0, skipped: 'venda sem cliente' };
    if (sale.status === 'cancelled') return { points: 0, skipped: 'venda cancelada' };

    const programa = getProgram(input.companyId);
    if (!programa.active) return { points: 0, skipped: 'programa desligado' };

    const jaAcumulou = db
      .prepare(
        "SELECT id FROM core_loyalty_entries WHERE company_id = ? AND kind = 'earn' AND sale_id = ?",
      )
      .get(input.companyId, input.saleId) as { id: string } | undefined;
    if (jaAcumulou) return { points: 0, skipped: 'já acumulado' };

    // O que foi pago com ponto não gera ponto.
    const resgatado = db
      .prepare(
        `SELECT COALESCE(SUM(-points), 0) AS pts FROM core_loyalty_entries
          WHERE company_id = ? AND kind = 'redeem' AND sale_id = ?`,
      )
      .get(input.companyId, input.saleId) as { pts: number };
    const descontoDePontos = resgatado.pts * programa.point_value_cents;

    const base = Math.max(0, sale.total_cents - descontoDePontos);
    const pontos = Math.floor(base / programa.cents_per_point);
    if (pontos <= 0) return { points: 0, skipped: 'valor abaixo de 1 ponto' };

    inserirLinha({
      companyId: input.companyId,
      customerId: sale.customer_id,
      kind: 'earn',
      points: pontos,
      saleId: input.saleId,
      description: `Compra #${sale.number}`,
      userId: input.userId,
    });
    return { points: pontos, skipped: null };
  });
}

/**
 * Estorna o ponto de uma venda cancelada ou devolvida — NOS DOIS SENTIDOS.
 *
 * O lado que protege a LOJA: o acumulado sai. Sem isto o cliente acumula
 * comprando e desistindo. Na devolução parcial o estorno é proporcional ao que
 * voltou — devolver metade não pode zerar o ponto da compra inteira.
 *
 * O lado que protege o CLIENTE (achado da auditoria, consertado): o RESGATADO
 * volta. Esta função estornava só as linhas kind='earn'; a linha kind='redeem'
 * presa à venda cancelada ficava de pé — o cliente devolvia a mercadoria,
 * recebia o dinheiro, e os pontos com que pagou parte da compra sumiam. A
 * regra de ouro do módulo ("venda cancelada ESTORNA o ponto") estava
 * implementada só no sentido que protege a loja. Cancelar tem de deixar a
 * razão como se a venda não tivesse existido: o earn dela sai E o resgate
 * volta, na mesma proporção.
 *
 * As duas devoluções entram como kind='reversal' — negativo tira o acumulado,
 * positivo devolve o resgatado (o sinal é a semântica da razão: "positivo
 * acumula, negativo consome"). Por isso os dois controles de repetição olham
 * cada um o SEU sinal: somar tudo junto faria um lado esconder o outro e o
 * segundo cancelamento estornaria de novo.
 *
 * A linha da devolução do resgate NÃO carrega return_id: a UNIQUE
 * (company, kind, sale, return) já é ocupada pela linha do estorno do earn na
 * mesma devolução, e a trava contra o dobro aqui é a soma, não a chave.
 */
export function reversePoints(input: {
  companyId: string;
  saleId: string;
  returnId?: string | null;
  /** 1 = venda inteira. Entre 0 e 1 para devolução parcial. */
  ratio?: number;
  userId?: string;
  reason: string;
}): { reversed: number; redeemReturned: number } {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const proporcao = Math.min(Math.max(Number(input.ratio ?? 1), 0), 1);

    // ---------------------------------------- o acumulado sai (protege a loja)
    let aEstornar = 0;
    const acumulado = db
      .prepare(
        `SELECT customer_id, points FROM core_loyalty_entries
          WHERE company_id = ? AND kind = 'earn' AND sale_id = ?`,
      )
      .get(input.companyId, input.saleId) as { customer_id: string; points: number } | undefined;
    if (acumulado) {
      const jaEstornou = db
        .prepare(
          `SELECT COALESCE(SUM(-points), 0) AS pts FROM core_loyalty_entries
            WHERE company_id = ? AND kind = 'reversal' AND points < 0 AND sale_id = ?`,
        )
        .get(input.companyId, input.saleId) as { pts: number };

      const alvo = Math.round(acumulado.points * proporcao);
      aEstornar = Math.min(alvo, acumulado.points - jaEstornou.pts);
      if (aEstornar > 0) {
        inserirLinha({
          companyId: input.companyId,
          customerId: acumulado.customer_id,
          kind: 'reversal',
          points: -aEstornar,
          saleId: input.saleId,
          returnId: input.returnId ?? null,
          description: input.reason,
          userId: input.userId,
        });
      }
    }

    // ------------------------------------ o resgatado volta (protege o cliente)
    let aDevolver = 0;
    const resgatado = db
      .prepare(
        `SELECT MAX(customer_id) AS cliente, COALESCE(SUM(-points), 0) AS pts
           FROM core_loyalty_entries
          WHERE company_id = ? AND kind = 'redeem' AND sale_id = ?`,
      )
      .get(input.companyId, input.saleId) as { cliente: string | null; pts: number };
    if (resgatado.cliente && resgatado.pts > 0) {
      const jaDevolvido = db
        .prepare(
          `SELECT COALESCE(SUM(points), 0) AS pts FROM core_loyalty_entries
            WHERE company_id = ? AND kind = 'reversal' AND points > 0 AND sale_id = ?`,
        )
        .get(input.companyId, input.saleId) as { pts: number };

      const alvo = Math.round(resgatado.pts * proporcao);
      aDevolver = Math.min(alvo, resgatado.pts - jaDevolvido.pts);
      if (aDevolver > 0) {
        inserirLinha({
          companyId: input.companyId,
          customerId: resgatado.cliente,
          kind: 'reversal',
          points: aDevolver,
          saleId: input.saleId,
          returnId: null,
          description: `${input.reason} — devolução de ${aDevolver} ponto(s) resgatado(s)`,
          userId: input.userId,
        });
      }
    }

    return { reversed: aEstornar, redeemReturned: aDevolver };
  });
}

/**
 * Resgate: pontos viram desconto.
 *
 * Devolve quanto vale em centavos, para o PDV usar como desconto. O saldo sai
 * na hora — deixar para depois abriria janela para resgatar duas vezes o mesmo
 * ponto em dois caixas.
 */
export function redeemPoints(input: {
  companyId: string;
  customerId: string;
  points: number;
  saleId?: string | null;
  userId?: string;
}): { points: number; discountCents: number; balanceAfter: number } {
  ensureCoreSchema();
  return withTransaction(() => {
    const programa = getProgram(input.companyId);
    if (!programa.active) {
      throw new ApiError('CORE_LOYALTY_DISABLED', 'Programa de fidelidade desligado.', 409);
    }

    const pontos = Math.round(Number(input.points));
    if (!Number.isFinite(pontos) || pontos <= 0) {
      throw new ApiError('CORE_LOYALTY_POINTS_INVALID', 'Informe quantos pontos resgatar.', 400);
    }
    if (pontos < programa.min_points_to_redeem) {
      throw new ApiError(
        'CORE_LOYALTY_BELOW_MINIMUM',
        `O resgate mínimo é de ${programa.min_points_to_redeem} pontos.`,
        400,
      );
    }

    const saldo = pointsBalance(input.companyId, input.customerId);
    if (pontos > saldo) {
      throw new ApiError(
        'CORE_LOYALTY_INSUFFICIENT',
        `Saldo insuficiente: o cliente tem ${saldo} ponto(s).`,
        409,
      );
    }

    inserirLinha({
      companyId: input.companyId,
      customerId: input.customerId,
      kind: 'redeem',
      points: -pontos,
      saleId: input.saleId ?? null,
      description: `Resgate de ${pontos} ponto(s)`,
      userId: input.userId,
    });

    return {
      points: pontos,
      discountCents: pontos * programa.point_value_cents,
      balanceAfter: pointsBalance(input.companyId, input.customerId),
    };
  });
}

export function customerStatement(
  companyId: string,
  customerId: string,
): { balance: number; entries: Record<string, unknown>[] } {
  ensureCoreSchema();
  const entries = getConnection()
    .prepare(
      `SELECT e.*, s.number AS sale_number
         FROM core_loyalty_entries e
         LEFT JOIN core_sales s ON s.id = e.sale_id
        WHERE e.company_id = ? AND e.customer_id = ?
        ORDER BY e.created_at DESC LIMIT 200`,
    )
    .all(companyId, customerId) as unknown as Record<string, unknown>[];
  return { balance: pointsBalance(companyId, customerId), entries };
}

/**
 * Quanto a operação deve em pontos.
 *
 * É passivo, e a tela mostra assim: são descontos já prometidos que ainda vão
 * sair do caixa.
 */
export function loyaltyLiability(companyId: string): {
  points: number;
  estimatedCents: number;
  customers: number;
} {
  ensureCoreSchema();
  const programa = getProgram(companyId);
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(points), 0) AS pts, COUNT(DISTINCT customer_id) AS clientes
         FROM core_loyalty_entries WHERE company_id = ?`,
    )
    .get(companyId) as { pts: number; clientes: number };
  return {
    points: row.pts,
    estimatedCents: row.pts * programa.point_value_cents,
    customers: row.clientes,
  };
}
