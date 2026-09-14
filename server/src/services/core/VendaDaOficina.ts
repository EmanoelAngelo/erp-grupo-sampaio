/**
 * A VENDA DA OS, ITEMIZADA — GAP-PRD-024.
 *
 * ## O defeito
 *
 * O checkout da OS criava a venda com UMA linha "Ordem de serviço #N", sem
 * produto, com o total inteiro (peças + mão de obra). Três consequências:
 *
 *  - a NFC-e das peças não tinha de onde tirar NCM, CFOP e origem — a
 *    validação recusava a venda da OS inteira;
 *  - a peça (mercadoria, ICMS) e a mão de obra (serviço, ISS) viravam um valor
 *    só, e não existe documento fiscal que declare as duas coisas juntas;
 *  - os relatórios de produto e o CMV não viam a peça vendida pela oficina.
 *
 * ## O que este módulo faz
 *
 * Diz, a partir da OS, o que a venda É: cada peça aplicada (quantidade líquida
 * da devolução, preço da OS, o custo com que ela SAIU da gaveta) e a mão de
 * obra.
 *
 * O CUSTO É O DA BAIXA, NÃO O DO CADASTRO (GAP-PRD-101, frente OFI): a saída
 * da peça pela OS fotografa o custo no razão, e é esse retrato que vai à linha
 * — o cadastro que muda depois não muda a margem do conserto já feito. Saída
 * sem retrato (baixada antes de a OS fotografar custo) fica NULA, e o CMV a
 * conta como "antes do retrato", nunca como custo zero. O checkout usa
 * isto para criar a venda itemizada; o fiscal usa o MESMO cálculo para a venda
 * da OS que foi cobrada antes desta correção (uma linha só) — a conta é uma,
 * para a nota nunca discordar do que o cliente pagou.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import type { LinhaJaBaixada } from './SalesService.js';
import { custoDaPecaConsumida } from './WorkshopPartsReservation.js';

export interface VendaDaOs {
  orderId: string;
  number: number;
  /** Cada peça com quantidade líquida > 0, na ordem em que foi lançada. */
  pecas: LinhaJaBaixada[];
  pecasCents: number;
  maoDeObraCents: number;
  totalCents: number;
}

/**
 * As linhas da venda de uma OS.
 *
 * A conta de cada peça é a mesma de `recalculateTotals` (WorkshopCoreService):
 * `ROUND(preço × (quantidade − devolvida))`, linha a linha. Se a soma não
 * fechar com o total gravado na OS, a recusa diz isso — cobrar um valor e
 * declarar outro na nota é o defeito que este módulo existe para impedir.
 */
export function vendaDaOs(companyId: string, orderId: string): VendaDaOs {
  ensureCoreSchema();
  const db = getConnection();
  const os = db
    .prepare(
      `SELECT id, number, labor_cents, parts_cents, total_cents
         FROM core_service_orders WHERE id = ? AND company_id = ?`,
    )
    .get(orderId, companyId) as
    | { id: string; number: number; labor_cents: number; parts_cents: number; total_cents: number }
    | undefined;
  if (!os) throw new ApiError('CORE_ORDER_NOT_FOUND', 'OS não encontrada.', 404);

  const linhas = db
    .prepare(
      `SELECT sp.id, sp.product_id, sp.description, sp.quantity, COALESCE(sp.returned_quantity, 0) AS devolvida,
              sp.unit_price_cents
         FROM core_service_order_parts sp
        WHERE sp.order_id = ? AND sp.company_id = ?
        ORDER BY sp.created_at, sp.rowid`,
    )
    .all(orderId, companyId) as unknown as {
    id: string;
    product_id: string;
    description: string;
    quantity: number;
    devolvida: number;
    unit_price_cents: number;
  }[];

  const pecas: LinhaJaBaixada[] = [];
  for (const l of linhas) {
    const liquida = Number(l.quantity) - Number(l.devolvida);
    if (!(liquida > 0)) continue;
    pecas.push({
      productId: l.product_id,
      description: l.description,
      quantity: liquida,
      unitPriceCents: Number(l.unit_price_cents),
      totalCents: Math.round(Number(l.unit_price_cents) * liquida),
      costCents: custoDaPecaConsumida(companyId, orderId, l.id, l.product_id),
    });
  }

  const pecasCents = pecas.reduce((s, p) => s + p.totalCents, 0);
  const maoDeObraCents = Math.max(0, Math.round(Number(os.labor_cents)));
  if (pecasCents + maoDeObraCents !== Number(os.total_cents)) {
    throw new ApiError(
      'CORE_ORDER_TOTAL_MISMATCH',
      `A conta da OS #${os.number} não fecha: peças ${(pecasCents / 100).toFixed(2)} + mão de obra `
        + `${(maoDeObraCents / 100).toFixed(2)} ≠ total ${(Number(os.total_cents) / 100).toFixed(2)}. `
        + 'Relance ou devolva uma peça para a OS refazer a conta antes de cobrar.',
      409,
      { pecasCents, maoDeObraCents, totalCents: Number(os.total_cents) },
    );
  }

  return {
    orderId: os.id,
    number: Number(os.number),
    pecas,
    pecasCents,
    maoDeObraCents,
    totalCents: Number(os.total_cents),
  };
}

/** A descrição da linha de mão de obra — a mesma na venda, na NFS-e e no papel. */
export function descricaoDaMaoDeObra(numeroDaOs: number): string {
  return `Mão de obra — OS #${numeroDaOs}`;
}

/** A OS que foi cobrada por esta venda, se houver. */
export function osDaVenda(
  companyId: string,
  saleId: string,
): { id: string; number: number; customer_id: string | null } | null {
  ensureCoreSchema();
  return (
    (getConnection()
      .prepare(
        `SELECT id, number, customer_id FROM core_service_orders
          WHERE company_id = ? AND sale_id = ? LIMIT 1`,
      )
      .get(companyId, saleId) as { id: string; number: number; customer_id: string | null } | undefined)
    ?? null
  );
}
