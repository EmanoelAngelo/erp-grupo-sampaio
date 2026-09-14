/**
 * Conferência do estoque reservado.
 *
 * `core_stock.reserved` é um número que segura mercadoria: enquanto ele está
 * lá, o item não aparece disponível para mais ninguém. Se esse número não
 * tiver ORIGEM — um pedido aguardando pagamento, uma pré-venda aberta —, a
 * loja para de vender uma peça que está na prateleira, e ninguém descobre por
 * quê, porque não há o que investigar.
 *
 * O contrário também importa: pedido aberto SEM reserva significa que o item
 * pode ser vendido duas vezes.
 *
 * Este módulo só CONFERE. Não corrige nada: reserva é dado operacional, e
 * conserto automático de saldo esconde a causa em vez de resolvê-la. Quem
 * decide o que fazer com uma divergência é quem opera.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { SQL_PROMESSAS_ABERTAS } from './WorkshopPartsReservation.js';

export type InventoryCheck =
  | 'STOCK_RESERVATION_WITHOUT_SOURCE'
  | 'OPEN_ORDER_WITHOUT_RESERVATION'
  | 'RESERVATION_WITHOUT_LEDGER';

export interface InventoryIssue {
  check: InventoryCheck;
  severity: 'critical' | 'warning';
  productId: string;
  productName: string;
  detail: string;
  /**
   * OS NÚMEROS DA FRASE, para quem precisa agir (GAP-PRD-087).
   *
   * `detail` é para gente ler; a liberação da reserva sem origem precisa da
   * CONTA — quanto está reservado e quanto disso tem origem aberta — e reler o
   * número de dentro de uma frase seria a segunda aritmética que diverge da
   * primeira.
   */
  reserved: number;
  withSource: number;
}

export interface InventoryReport {
  healthy: boolean;
  critical: number;
  warnings: number;
  issues: InventoryIssue[];
}

interface ReservaRow {
  company_id: string;
  product_id: string;
  name: string;
  reserved: number;
  origem: number;
  no_razao: number;
}

/**
 * O que legitimamente segura estoque.
 *
 * ## O QUE ESTAVA FALTANDO AQUI (rodada 55)
 *
 * O comentário anterior dizia "pedido online aguardando pagamento E pré-venda
 * ainda aberta". A consulta só tinha a primeira metade: `core_orders`. Mas
 * `reserveStock` sempre teve TRÊS chamadores — a loja online, a pré-venda
 * (`QuoteService`) e a locação (`RentalContractService`) —, e os dois últimos
 * já apareciam aqui como `STOCK_RESERVATION_WITHOUT_SOURCE`, o alarme mais
 * grave do relatório, sem ter feito nada de errado.
 *
 * Agora a oficina também reserva, e seria a quarta a ser acusada. Alarme que
 * dispara sozinho é alarme que se aprende a ignorar — e aí ele deixa de servir
 * no dia em que a divergência é de verdade.
 *
 * As quatro origens entram por UNION ALL e são somadas depois: o mesmo produto
 * pode estar prometido a um pedido e a uma OS ao mesmo tempo, e as duas
 * promessas são legítimas.
 */
const ORIGENS_ABERTAS = `
  SELECT product_id, SUM(quantidade) AS quantidade FROM (
    -- loja online: pedido aguardando pagamento
    SELECT i.product_id AS product_id, SUM(i.quantity) AS quantidade
      FROM core_orders o
      JOIN core_order_items i ON i.order_id = o.id
     WHERE o.company_id = ? AND o.status = 'aguardando_pagamento'
     GROUP BY i.product_id
    UNION ALL
    -- pré-venda ainda aberta (orçamento não reserva: é papel)
    SELECT qi.product_id AS product_id, SUM(qi.quantity) AS quantidade
      FROM core_quotes q
      JOIN core_quote_items qi ON qi.quote_id = q.id
     WHERE q.company_id = ? AND q.kind = 'pre_venda' AND q.status = 'aberto'
     GROUP BY qi.product_id
    UNION ALL
    -- locação de pé: o que saiu e ainda não voltou
    SELECT ri.product_id AS product_id,
           SUM(ri.quantity - ri.returned_quantity) AS quantidade
      FROM core_rental_contracts rc
      JOIN core_rental_contract_items ri ON ri.contract_id = rc.id
     WHERE rc.company_id = ? AND rc.status = 'aberto'
     GROUP BY ri.product_id
    UNION ALL
    -- oficina: peça prometida a uma OS que ainda não consumiu nem soltou
    ${SQL_PROMESSAS_ABERTAS}
  )
  GROUP BY product_id`;

export function inventoryReconciliation(companyId: string): InventoryReport {
  ensureCoreSchema();
  const db = getConnection();

  const linhas = db
    .prepare(
      `SELECT s.company_id, s.product_id, p.name, s.reserved,
              COALESCE(o.quantidade, 0) AS origem,
              (SELECT COUNT(*) FROM core_stock_movements m
                WHERE m.product_id = s.product_id AND m.company_id = s.company_id
                  AND m.kind LIKE '%RESERVATION%') AS no_razao
         FROM core_stock s
         JOIN core_products p ON p.id = s.product_id
         LEFT JOIN (${ORIGENS_ABERTAS}) o ON o.product_id = s.product_id
        WHERE s.company_id = ? AND (s.reserved > 0 OR COALESCE(o.quantidade, 0) > 0)`,
    )
    // Quatro origens no fragmento + a empresa do WHERE de fora, na ordem
    // em que aparecem no texto da consulta.
    .all(companyId, companyId, companyId, companyId, companyId) as unknown as ReservaRow[];

  const issues: InventoryIssue[] = [];

  for (const linha of linhas) {
    if (linha.reserved > linha.origem) {
      issues.push({
        check: 'STOCK_RESERVATION_WITHOUT_SOURCE',
        severity: 'critical',
        productId: linha.product_id,
        productName: linha.name,
        detail:
          `${linha.reserved} reservado(s) e apenas ${linha.origem} com origem aberta. `
          + 'A diferença segura mercadoria que ninguém está comprando.',
        reserved: linha.reserved,
        withSource: linha.origem,
      });
    }

    if (linha.origem > linha.reserved) {
      issues.push({
        check: 'OPEN_ORDER_WITHOUT_RESERVATION',
        severity: 'critical',
        productId: linha.product_id,
        productName: linha.name,
        detail:
          `${linha.origem} em pedido aberto e apenas ${linha.reserved} reservado(s). `
          + 'O saldo livre está maior do que a realidade e pode ser vendido de novo.',
        reserved: linha.reserved,
        withSource: linha.origem,
      });
    }

    // Reserva legítima, mas sem rastro no razão: o saldo está certo e a
    // história não. Aviso, não crítico — não há risco de venda dupla.
    if (linha.reserved > 0 && linha.no_razao === 0) {
      issues.push({
        check: 'RESERVATION_WITHOUT_LEDGER',
        severity: 'warning',
        productId: linha.product_id,
        productName: linha.name,
        detail:
          'Reserva sem movimento correspondente no razão — o saldo está coerente, '
          + 'mas não há registro de quando a reserva foi criada.',
        reserved: linha.reserved,
        withSource: linha.origem,
      });
    }
  }

  return {
    healthy: issues.filter((i) => i.severity === 'critical').length === 0,
    critical: issues.filter((i) => i.severity === 'critical').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    issues,
  };
}
