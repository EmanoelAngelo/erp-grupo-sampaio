/**
 * A concessão do carrinho, calculada na tela ANTES de fechar a venda.
 *
 * ## Por que existe uma conta aqui, se quem decide é o servidor
 *
 * O servidor é quem decide, e continua sendo — esta rodada moveu a alçada para
 * dentro de `createSale` justamente porque o denominador vinha do cliente. Isto
 * aqui não decide nada: é uma PRÉVIA, e ela existe porque a alçada honesta
 * passou a recusar vendas que antes passavam.
 *
 * O caso concreto: o operador carrega uma pré-venda antiga no PDV, com o preço
 * que foi negociado semanas atrás. Ele não digita desconto nenhum. Mas a tabela
 * subiu desde então, e a diferença agora conta como concessão. Sem prévia, ele
 * descobre isso no momento em que aperta Finalizar com o cliente na frente — e
 * a mensagem fala de um desconto que ele tem certeza de não ter dado.
 *
 * Com a prévia, o número está na tela desde que o item entrou no carrinho.
 *
 * ## A CONTA TEM DE SER A MESMA DO SERVIDOR, senão é pior que nada
 *
 * Uma prévia que diverge do servidor é uma tela que mente: mostra 8%, o
 * servidor recusa por 12%, e a pessoa deixa de confiar nos dois números. Por
 * isso cada linha abaixo espelha `SalesService.createSale`, e não uma
 * simplificação dela:
 *
 *   - preço fechado tem TETO no vigente (`Math.min`), então digitar acima não
 *     aumenta o bruto — o servidor cobra o vigente de qualquer forma;
 *   - preço ABERTO não tem teto nem concessão na diferença: o bruto da linha é
 *     o que foi combinado. Medir "abaixo do vigente" em produto de preço aberto
 *     faria a oficina pedir gestor em toda mão de obra, porque a sugestão
 *     cadastrada desses itens costuma ser zero;
 *   - o percentual é `concedido / bruto` com duas casas, e bruto zero com algo
 *     concedido é 100% — deu-se tudo o que havia.
 *
 * O que a prévia NÃO pode fazer é decidir. Promoção que venceu entre a busca e
 * o Finalizar, preço alterado noutro terminal, item que saiu do catálogo: a
 * palavra final é do servidor, e quando ele recusa é a mensagem DELE que a tela
 * mostra, com os números dele. Ver `PdvPage.finalize`.
 *
 * Mora fora de `PdvPage.tsx` porque é regra e precisa de teste próprio: dentro
 * do componente só seria exercível montando a tela inteira — e porque arquivo
 * de componente que exporta função quebra o fast refresh do Vite.
 */
import { parseReaisToCents } from '@/components/gs/format';
import type { CartLine } from './pdvTypes';

/** O preço que a loja cobra hoje por este item, já com a promoção vigente. */
export function precoVigenteCents(line: CartLine): number {
  return line.product.effective_price_cents ?? line.product.price_cents;
}

/** O cadastro é sugestão, e não teto: mão de obra, serviço, o combinado. */
export function ehPrecoAberto(line: CartLine): boolean {
  return line.product.open_price === 1;
}

/**
 * O que a venda realmente vai cobrar nesta linha, por unidade.
 *
 * Não é `line.unitPriceCents`: em preço fechado o servidor aplica teto. Um
 * valor digitado acima do vigente é silenciosamente rebaixado lá, e a tela que
 * somasse o digitado prometeria ao cliente um total que a venda não cobra.
 */
export function unitarioCobradoCents(line: CartLine): number {
  const vigente = precoVigenteCents(line);
  return ehPrecoAberto(line)
    ? Math.max(0, line.unitPriceCents)
    : Math.min(line.unitPriceCents, vigente);
}

export interface ConcessaoPrevista {
  /** Preço vigente x quantidade (o combinado, em preço aberto). */
  brutoCents: number;
  /** Rodapé + preço rebaixado. */
  concedidoCents: number;
  /** concedido / bruto, em pontos percentuais, duas casas. */
  percentual: number;
  origens: { cabecalho: number; itens: number; precoRebaixado: number };
  /**
   * Linhas que o servidor vai RECUSAR por preço zero, com o nome do produto.
   *
   * Aparecer aqui é diferente de conceder: não é desconto, é item sem preço —
   * o que a entrada de nota cria às centenas e ninguém precificou. Saber disso
   * no carrinho evita descobrir no Finalizar, com o cliente esperando.
   */
  semPreco: { productId: string; nome: string; aberto: boolean }[];
  /**
   * Linhas em que se digitou acima do preço vigente.
   *
   * Não é erro e não impede nada — mas o servidor cobra o vigente, e sem este
   * aviso a tela mostraria um total maior do que a venda vai fechar.
   */
  acimaDoVigente: { productId: string; nome: string; vigenteCents: number }[];
}

/**
 * A prévia da concessão para o carrinho na tela.
 *
 * `descontoRodapeCents` é o desconto do documento — no PDV ele chega do campo
 * digitável do rodapé (GAP-V54), de uma pré-venda carregada ou de uma venda
 * retomada da espera, e é a maior das três parcelas quando existe.
 *
 * O desconto de LINHA (`origens.itens`) DEIXOU de sair sempre zero: o campo
 * "Desc." da linha do carrinho grava `discountCents` na CartLine, e ele é
 * somado aqui exatamente como o servidor o soma em `concedidoItens` — a
 * previsão que divergisse do servidor seria pior que nenhuma.
 */
export function concessaoPrevista(
  lines: CartLine[],
  descontoRodapeCents: number,
): ConcessaoPrevista {
  let bruto = 0;
  let rebaixado = 0;
  let itens = 0;
  const semPreco: ConcessaoPrevista['semPreco'] = [];
  const acimaDoVigente: ConcessaoPrevista['acimaDoVigente'] = [];

  for (const line of lines) {
    const vigente = precoVigenteCents(line);
    const aberto = ehPrecoAberto(line);
    const unit = unitarioCobradoCents(line);

    bruto += Math.round((aberto ? unit : vigente) * line.quantity);
    if (!aberto) rebaixado += Math.round((vigente - unit) * line.quantity);
    // O desconto explícito da linha conta como concessão em QUALQUER preço —
    // a mesma regra do servidor: ali alguém digitou "abro mão de tanto".
    itens += Math.max(0, Math.round(line.discountCents ?? 0));

    if (unit <= 0) {
      semPreco.push({ productId: line.product.id, nome: line.product.name, aberto });
    }
    if (!aberto && line.unitPriceCents > vigente) {
      acimaDoVigente.push({
        productId: line.product.id,
        nome: line.product.name,
        vigenteCents: vigente,
      });
    }
  }

  // O rodapé é dinheiro concedido mesmo quando o carrinho está vazio de bruto:
  // não se subtrai o que não se cobrou.
  const cabecalho = Math.max(0, Math.round(descontoRodapeCents));
  const concedido = cabecalho + itens + rebaixado;

  return {
    brutoCents: bruto,
    concedidoCents: concedido,
    percentual:
      bruto > 0 ? Math.round((concedido / bruto) * 10000) / 100 : concedido > 0 ? 100 : 0,
    origens: { cabecalho, itens, precoRebaixado: rebaixado },
    semPreco,
    acimaDoVigente,
  };
}

/**
 * O desconto de rodapé DIGITADO, em centavos — GAP-V54.
 *
 * O campo aceita as duas línguas do balcão: "50" é R$ 50,00 (a mesma leitura
 * de `parseReaisToCents` que todos os campos de dinheiro do PDV usam) e "10%"
 * é dez por cento DO SUBTOTAL da tela. O percentual vira centavos aqui, uma
 * vez, e o que viaja no POST é sempre um inteiro de centavos: o servidor nunca
 * recebe porcentagem, e a alçada dele mede o valor como sempre mediu.
 *
 * Recalculado a cada mudança do carrinho quando é percentual — "10%" continua
 * sendo 10% depois de bipar mais um item, que é o que quem digitou quis dizer.
 *
 * O teto é o subtotal: desconto maior que a venda seria recusado pelo servidor
 * ("Desconto maior que o total da venda"), então o campo nem deixa nascer o
 * estado que vai morrer no Finalizar com o cliente na frente.
 *
 * Vazio e ilegível são zero — campo em branco não concede nada.
 */
export function descontoDoRodapeCents(texto: string, subtotalCents: number): number {
  const bruto = texto.trim();
  if (!bruto) return 0;
  if (bruto.endsWith('%')) {
    const pct = Number(bruto.slice(0, -1).replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.min(subtotalCents, Math.round((subtotalCents * pct) / 100));
  }
  const cents = parseReaisToCents(bruto) ?? 0;
  return Math.min(subtotalCents, Math.max(0, cents));
}

/**
 * De onde veio a concessão, em frases de balcão.
 *
 * É o consumidor de `origens` — o campo que o servidor criou para a mensagem
 * poder dizer O QUE reduzir. "Precisa de gestor" sem isto manda a pessoa
 * procurar um desconto que talvez ela nem tenha digitado.
 *
 * Recebe só as origens (e não a concessão inteira) porque serve às duas
 * fontes: a prévia calculada aqui e o detalhe que vem no 403 do servidor. O
 * texto é o mesmo nos dois casos, e é isso que faz a mensagem de recusa
 * parecer a continuação do painel, e não outra história.
 */
export function origensEmPalavras(
  origens: { cabecalho: number; itens: number; precoRebaixado: number },
  emReais: (cents: number) => string,
): string[] {
  const partes: string[] = [];
  if (origens.cabecalho > 0) partes.push(`${emReais(origens.cabecalho)} de desconto no rodapé`);
  if (origens.itens > 0) partes.push(`${emReais(origens.itens)} de desconto nos itens`);
  if (origens.precoRebaixado > 0) {
    partes.push(`${emReais(origens.precoRebaixado)} de preço abaixo do vigente`);
  }
  return partes;
}
