/**
 * O que a nota fez com o seu preço.
 *
 * ## O buraco que isto fecha
 *
 * Confirmar uma entrada de nota atualiza o CUSTO do produto com o valor pago
 * ao fornecedor. O PREÇO de venda fica onde estava.
 *
 * O resultado é silencioso e caro: o fornecedor aumentou 12%, o custo subiu, a
 * margem encolheu — e ninguém percebe, porque nenhuma tela grita. A loja passa
 * a vender no prejuízo item a item até alguém notar no fechamento do mês, se
 * notar.
 *
 * Este serviço olha para a nota recém-confirmada e responde: dos produtos que
 * entraram, quais agora estão abaixo do mínimo que VOCÊ mesmo declarou, e por
 * quanto teriam de ser vendidos para voltar ao patamar.
 *
 * ## Ele não muda preço sozinho
 *
 * Sugere. Preço é decisão de dono, não consequência automática de uma nota:
 * às vezes se absorve o aumento para não perder o cliente, às vezes se
 * repassa. O que não pode é a decisão acontecer por omissão.
 *
 * A conta é a de `Pricing.ts`, sem uma segunda implementação — markup e margem
 * já vivem lá e são usados pelo cadastro de produto.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { avaliarPreco, precoPorMargem, precoPorMarkup } from './Pricing.js';

export interface SugestaoDePreco {
  productId: string;
  name: string;
  internalCode: string;
  custoAtualCents: number;
  precoAtualCents: number;
  markupPercent: number | null;
  margemPercent: number | null;
  /** Vende abaixo do que custou. */
  abaixoDoCusto: boolean;
  abaixoDoMinimo: boolean;
  motivos: string[];
  /**
   * Preço que devolveria o produto ao mínimo declarado. Nulo quando o produto
   * não declara mínimo nenhum — aí não há o que sugerir, e inventar um número
   * seria opinar sobre um negócio que não é nosso.
   */
  precoSugeridoCents: number | null;
}

interface LinhaDaNota {
  product_id: string;
  name: string;
  internal_code: string;
  cost_cents: number;
  price_cents: number;
  min_price_cents: number | null;
  min_markup_percent: number | null;
  min_margin_percent: number | null;
  unit_cost_cents: number;
}

/**
 * O preço que recolocaria o produto no mínimo.
 *
 * Quando há mais de um mínimo declarado, vale o MAIOR: atender só o menos
 * exigente deixaria o produto violando o outro, e a sugestão nasceria errada.
 */
function precoParaVoltarAoMinimo(linha: LinhaDaNota): number | null {
  const candidatos: number[] = [];

  if (linha.min_price_cents && linha.min_price_cents > 0) {
    candidatos.push(linha.min_price_cents);
  }
  if (linha.min_markup_percent != null) {
    candidatos.push(precoPorMarkup(linha.cost_cents, linha.min_markup_percent));
  }
  if (linha.min_margin_percent != null) {
    const p = precoPorMargem(linha.cost_cents, linha.min_margin_percent);
    if (p != null) candidatos.push(p);
  }

  if (candidatos.length === 0) return null;
  return Math.max(...candidatos);
}

/**
 * As sugestões de uma nota já confirmada.
 *
 * Só entram produtos vinculados: item de nota sem produto no catálogo não tem
 * preço para rever, e listá-lo daria a impressão de que algo ficou por fazer
 * quando o que falta é o vínculo, em outra tela.
 */
export function suggestionsForNote(companyId: string, noteId: string): SugestaoDePreco[] {
  ensureCoreSchema();
  const db = getConnection();

  const nota = db
    .prepare('SELECT id FROM core_inbound_notes WHERE id = ? AND company_id = ?')
    .get(noteId, companyId);
  if (!nota) throw new ApiError('CORE_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);

  const linhas = db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.internal_code, p.cost_cents, p.price_cents,
              p.min_price_cents, p.min_markup_percent, p.min_margin_percent,
              i.unit_cost_cents
         FROM core_inbound_note_items i
         JOIN core_products p ON p.id = i.product_id AND p.company_id = ?
        WHERE i.note_id = ? AND i.product_id IS NOT NULL
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all(companyId, noteId) as unknown as LinhaDaNota[];

  return linhas.map((linha) => {
    const avaliacao = avaliarPreco(linha.cost_cents, linha.price_cents, {
      minPriceCents: linha.min_price_cents,
      minMarkupPercent: linha.min_markup_percent,
      minMarginPercent: linha.min_margin_percent,
    });

    return {
      productId: linha.product_id,
      name: linha.name,
      internalCode: linha.internal_code,
      custoAtualCents: linha.cost_cents,
      precoAtualCents: linha.price_cents,
      markupPercent: avaliacao.markupPercent,
      margemPercent: avaliacao.margemPercent,
      abaixoDoCusto: avaliacao.abaixoDoCusto,
      abaixoDoMinimo: avaliacao.abaixoDoMinimo,
      motivos: avaliacao.motivos,
      precoSugeridoCents:
        avaliacao.abaixoDoCusto || avaliacao.abaixoDoMinimo
          ? precoParaVoltarAoMinimo(linha)
          : null,
    };
  });
}

/**
 * Aplica os preços que o lojista aceitou.
 *
 * Recebe a lista explícita do que mudar, e não "aplique todas as sugestões":
 * um botão que muda preço em massa sem a pessoa ver linha a linha é como se
 * perde a confiança na ferramenta no primeiro item errado.
 */
export function applyPrices(
  companyId: string,
  precos: { productId: string; priceCents: number }[],
): { atualizados: number } {
  ensureCoreSchema();
  const db = getConnection();
  const stmt = db.prepare(
    'UPDATE core_products SET price_cents = ?, updated_at = ? WHERE id = ? AND company_id = ?',
  );
  const agora = new Date().toISOString();

  let atualizados = 0;
  for (const p of precos) {
    if (!Number.isInteger(p.priceCents) || p.priceCents < 0) {
      throw new ApiError('CORE_PRICE_INVALID', 'Preço inválido.', 400);
    }
    const r = stmt.run(p.priceCents, agora, p.productId, companyId);
    atualizados += Number(r.changes ?? 0);
  }
  return { atualizados };
}
