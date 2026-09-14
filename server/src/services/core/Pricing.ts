/**
 * Markup e margem: as duas contas que o balcão confunde.
 *
 * MARKUP é sobre o CUSTO — "quanto eu somo em cima do que paguei".
 * MARGEM é sobre o PREÇO — "quanto do que recebo sobra".
 *
 * Custo 100, preço 150: markup 50%, margem 33,33%. São o mesmo negócio visto
 * de dois ângulos, e trocar um pelo outro na hora de precificar é como se
 * perde dinheiro achando que se está ganhando.
 *
 * NENHUM DOS DOIS É GUARDADO NO BANCO. Derivam de custo e preço, e uma cópia
 * gravada divergiria no primeiro reajuste — a tela mostraria margem de 40%
 * sobre um preço que já mudou. O que o produto guarda é o MÍNIMO, que é
 * política e não conta.
 *
 * As funções vão nos dois sentidos porque a tela vai nos dois: digitar o preço
 * mostra o markup, e digitar o markup calcula o preço.
 */

/** Centavos, sempre inteiro. Arredonda para o mais próximo. */
function centavos(valor: number): number {
  return Math.round(valor);
}

/**
 * Markup a partir de custo e preço.
 *
 * `null` quando o custo é zero: dividir por zero daria infinito, e mostrar
 * "0,00%" — como faz a referência — é pior, porque 0% significa "vendo pelo
 * custo", que é uma afirmação falsa sobre um produto sem custo lançado.
 */
export function markupDe(custoCents: number, precoCents: number): number | null {
  if (custoCents <= 0) return null;
  return ((precoCents - custoCents) / custoCents) * 100;
}

/**
 * Margem a partir de custo e preço.
 *
 * `null` quando o preço é zero — não há do que tirar percentual.
 */
export function margemDe(custoCents: number, precoCents: number): number | null {
  if (precoCents <= 0) return null;
  return ((precoCents - custoCents) / precoCents) * 100;
}

/** Preço que produz o markup pedido sobre o custo. */
export function precoPorMarkup(custoCents: number, markupPercent: number): number {
  return centavos(custoCents * (1 + markupPercent / 100));
}

/**
 * Preço que produz a margem pedida.
 *
 * Margem de 100% ou mais é impossível: o preço teria de ser infinito para que
 * o custo virasse uma fração nula dele. Recusar é melhor que devolver um
 * número absurdo que alguém salva sem olhar.
 */
export function precoPorMargem(custoCents: number, margemPercent: number): number | null {
  if (margemPercent >= 100) return null;
  return centavos(custoCents / (1 - margemPercent / 100));
}

export interface AvaliacaoPreco {
  markupPercent: number | null;
  margemPercent: number | null;
  /** Preço abaixo do custo — vende no prejuízo. */
  abaixoDoCusto: boolean;
  /** Violou algum mínimo declarado no produto. */
  abaixoDoMinimo: boolean;
  /** O que exatamente ficou abaixo, para a tela poder dizer. */
  motivos: string[];
}

export interface MinimosDoProduto {
  minPriceCents?: number | null;
  minMarkupPercent?: number | null;
  minMarginPercent?: number | null;
}

/**
 * Avalia um preço contra o custo e os mínimos do produto.
 *
 * Devolve os MOTIVOS, e não só um booleano: "abaixo do mínimo" sem dizer qual
 * mínimo obriga quem está no balcão a adivinhar o que corrigir.
 *
 * Quem decide o que fazer com isto é quem chama. Aqui não se bloqueia venda —
 * bloquear no cálculo esconderia a regra num lugar onde ninguém procura.
 */
export function avaliarPreco(
  custoCents: number,
  precoCents: number,
  minimos: MinimosDoProduto = {},
): AvaliacaoPreco {
  const motivos: string[] = [];

  const minPreco = minimos.minPriceCents ?? 0;
  if (minPreco > 0 && precoCents < minPreco) {
    motivos.push(`preço abaixo do mínimo de ${(minPreco / 100).toFixed(2)}`);
  }

  const markupPercent = markupDe(custoCents, precoCents);
  const minMarkup = minimos.minMarkupPercent;
  if (minMarkup != null && markupPercent != null && markupPercent < minMarkup) {
    motivos.push(`markup abaixo do mínimo de ${minMarkup.toFixed(2)}%`);
  }

  const margemPercent = margemDe(custoCents, precoCents);
  const minMargem = minimos.minMarginPercent;
  if (minMargem != null && margemPercent != null && margemPercent < minMargem) {
    motivos.push(`margem abaixo do mínimo de ${minMargem.toFixed(2)}%`);
  }

  return {
    markupPercent,
    margemPercent,
    abaixoDoCusto: custoCents > 0 && precoCents < custoCents,
    abaixoDoMinimo: motivos.length > 0,
    motivos,
  };
}

/**
 * Quantidade válida para a unidade.
 *
 * Caixa não se vende pela metade. A unidade declara quantas casas decimais
 * aceita, e o que passa disso é erro de digitação — arredondar em silêncio
 * deixaria meia caixa no estoque para sempre.
 */
export function quantidadeValida(quantidade: number, casasDecimais: number): boolean {
  if (!Number.isFinite(quantidade) || quantidade <= 0) return false;
  const fator = 10 ** casasDecimais;
  return Math.abs(quantidade * fator - Math.round(quantidade * fator)) < 1e-9;
}

/** Custo do kit pela soma das peças, quando o cadastro pede isso. */
export function custoDoKit(
  componentes: { quantity: number; costCents: number }[],
): number {
  return centavos(
    componentes.reduce((total, c) => total + c.quantity * c.costCents, 0),
  );
}
