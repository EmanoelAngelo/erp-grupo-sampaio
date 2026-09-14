/**
 * A REPRECIFICAÇÃO DO CARRINHO POR CLASSE — e não caminho por caminho.
 *
 * ## O defeito que este arquivo existe para fechar
 *
 * O revendedor tem desconto combinado. Até esta rodada ele era digitado à mão
 * em cada venda, e digitar desconto no PDV é CONCESSÃO: um combinado de 15%
 * estourava a alçada de 10% em toda compra e parava o balcão para chamar
 * gestor. A partir desta rodada o preço da tabela é o preço VIGENTE — o
 * combinado vive no denominador e o numerador da concessão fica zero.
 *
 * Só que o vigente passou a depender de QUEM está comprando, e o PDV descobre o
 * cliente numa ordem que ninguém controla. Os críticos mediram quatro caminhos
 * pelos quais uma linha entra no carrinho com o preço do cliente errado:
 *
 *   1. bipe de identidade (chassi/IMEI), que acha o produto por outra rota;
 *   2. carregar pré-venda/orçamento;
 *   3. retomar venda em espera (F7), inclusive uma guardada ontem;
 *   4. produto de preço aberto, cujo valor nasce na conversa.
 *
 * Consertar os quatro com quatro `if` deixaria o QUINTO aberto — e o quinto é
 * sempre o que ainda não foi escrito. Por isso a regra aqui não pergunta de
 * onde a linha veio: pergunta PARA QUEM ela foi precificada. Toda linha cuja
 * marca não bate com o cliente atual é reprecificada, e é o servidor quem
 * devolve o número.
 *
 * ## Por que fica fora de `PdvPage.tsx`
 *
 * Porque é regra, e regra precisa de teste próprio: dentro do componente só
 * seria exercível montando a tela inteira. E porque arquivo de componente que
 * exporta função quebra o fast refresh do Vite.
 *
 * ## O que este arquivo NÃO faz
 *
 * Não calcula preço. Nenhuma linha abaixo aplica percentual, compara promoção
 * ou lê tabela: isso mora no `PricingService`, no servidor, e chega pronto em
 * `POST /core/pricing/cart`. Aqui só se decide QUEM perguntar e ONDE guardar a
 * resposta. Uma conta de preço escrita aqui viraria a segunda implementação da
 * regra, e a divergência entre as duas apareceria no balcão como venda recusada
 * por alçada num carrinho que a tela mostrava dentro do limite.
 */
import type { CarrinhoPrecificado, LinhaPrecificada } from '@/lib/api/core';
import type { CartLine } from './pdvTypes';

/**
 * O cliente atual, normalizado para o formato da marca da linha.
 *
 * "Sem cliente" é `null` nos dois lados. Deixar `undefined` circular faria
 * `undefined !== null` disparar reprecificação eterna num carrinho sem cliente
 * — uma ida ao servidor por item bipado, sem nada a corrigir.
 */
export function clienteDaVenda(customerId: string | null | undefined): string | null {
  return customerId ?? null;
}

/**
 * As linhas que precisam de preço novo.
 *
 * A comparação é com `!==` e não com uma verificação de "tem cliente": o caso
 * de TIRAR o cliente do carrinho é tão real quanto o de escolhê-lo, e nele os
 * preços têm de VOLTAR ao normal. Um revendedor removido do carrinho que
 * continuasse levando 15% seria desconto dado a quem não o tem.
 */
export function linhasParaReprecificar(
  lines: CartLine[],
  customerId: string | null | undefined,
): CartLine[] {
  const alvo = clienteDaVenda(customerId);
  /*
    E PARA QUANTAS UNIDADES (G-offline-sync-M01): a faixa de preço por
    quantidade do Gestor depende do número da linha, e só comparar o cliente
    deixava o terceiro bipe do mesmo item no preço de uma unidade. Ver
    `CartLine.precificadaQtd`.
  */
  return lines.filter((l) => l.precificadaPara !== alvo || precificadaParaQtd(l) !== l.quantity);
}

/** A quantidade da marca; ausente é 1, o preço que a busca devolve. */
function precificadaParaQtd(line: CartLine): number {
  return line.precificadaQtd ?? 1;
}

/**
 * O preço que a linha passa a mostrar, dada a resposta do servidor para ela.
 *
 * Separada porque é a decisão inteira em quatro linhas, e cada uma delas tem
 * um jeito próprio de dar errado:
 *
 *   - `fonte: 'aberto'` NÃO mexe em nada. Mão de obra e serviço têm
 *     `price_cents` zero no cadastro; reprecificar zeraria a linha no instante
 *     em que o cliente fosse escolhido, e o valor combinado com o cliente
 *     sumiria sem erro nenhum. A exclusão é a MESMA decisão do servidor — ele
 *     é quem diz `'aberto'`, a tela não reimplementa a pergunta.
 *   - preço DIGITADO vira `Math.min(digitado, novoVigente)`. Nunca o vigente
 *     puro: isso apagaria a negociação. E nunca o digitado puro: o servidor
 *     aplica teto no vigente em preço fechado, e a tela que somasse acima
 *     prometeria ao cliente um total que a venda não cobra.
 *   - o resto acompanha o vigente, que é o gesto todo desta rodada.
 */
function precoDaLinha(line: CartLine, resposta: LinhaPrecificada): number {
  if (resposta.fonte === 'aberto') return line.unitPriceCents;
  if (line.precoDigitado) {
    /*
      O TETO É MEDIDO CONTRA O COMBINADO, e nunca contra o preço já reescrito.

      Aqui estava `Math.min(line.unitPriceCents, ...)` — e `unitPriceCents` é o
      campo que esta própria função reescreve. Isso fazia uma catraca que só
      desce: combinado 100, revendedor de 15% baixa para 85, e TIRAR o cliente
      deixava 85, porque o `min` já não conhecia mais os 100.

      O combinado mora em `precoNegociadoCents`, escrito uma vez. O `??` cobre
      a linha que veio de uma sessão anterior sem o campo — ali o
      `unitPriceCents` ainda é o melhor palpite disponível.
    */
    const combinado = line.precoNegociadoCents ?? line.unitPriceCents;
    return Math.min(combinado, resposta.priceCents);
  }
  return resposta.priceCents;
}

/**
 * Aplica no carrinho o que o servidor respondeu.
 *
 * ## O `effective_price_cents` da linha É REESCRITO, e isso é o ponto
 *
 * `pdvConcessao` mede a concessão contra `product.effective_price_cents` — o
 * mesmo denominador que `SalesService` usa. Se a tela guardasse o preço da
 * tabela só em `unitPriceCents` e deixasse o vigente no valor de cadastro, o
 * painel do balcão acusaria os 15% do revendedor como concessão e diria "acima
 * do limite" numa venda que o servidor fecha sem pedir gestor. As duas telas
 * discordariam do servidor pelo mesmo motivo: um denominador velho.
 *
 * `price_cents` continua sendo o preço de CADASTRO — é ele que aparece riscado
 * no "de/por", e é a única forma de o operador ver que o desconto está valendo.
 *
 * ## Produto omitido da resposta
 *
 * Fica exatamente como estava — o servidor omite o que não existe mais ou foi
 * inativado. Mas a marca É gravada assim mesmo: sem isso a linha ficaria
 * eternamente pendente e a tela pediria preço ao servidor a cada render, num
 * laço que só aparece como lentidão. Quem recusa a venda de um produto que
 * sumiu é a venda, com a mensagem que nomeia o produto.
 *
 * ## `pedidos` — a linha que entrou DURANTE a ida ao servidor
 *
 * O balcão bipa enquanto a resposta está a caminho, e a linha nova não estava
 * no pedido. Sem `pedidos`, ela cairia no caso acima ("omitida, marque assim
 * mesmo") e ficaria congelada no preço da busca, sem a tabela do cliente e sem
 * nunca mais ser perguntada — o defeito exato que esta rodada existe para
 * fechar, reintroduzido pela porta dos fundos. Linha que não foi perguntada
 * continua pendente, e a próxima passada a pega.
 */
export function aplicarPrecificacao(
  lines: CartLine[],
  resposta: CarrinhoPrecificado,
  customerId: string | null | undefined,
  pedidos: string[],
  /**
   * A quantidade que foi PERGUNTADA para cada produto (G-offline-sync-M01).
   *
   * A resposta vale para aquele número: se a linha mudou de quantidade durante
   * a ida ao servidor (o quarto bipe chegou antes da resposta do terceiro), o
   * preço que voltou é o da quantidade velha e a linha continua pendente — a
   * próxima passada pergunta de novo. Ausente, vale a quantidade de agora (o
   * contrato de antes, para quem chama sem saber da faixa).
   */
  quantidades?: Record<string, number>,
): CartLine[] {
  const alvo = clienteDaVenda(customerId);
  const porProduto = new Map(resposta.items.map((i) => [i.productId, i]));
  const perguntados = new Set(pedidos);

  return lines.map((line) => {
    if (line.precificadaPara === alvo && (line.precificadaQtd ?? 1) === line.quantity) return line;
    if (!perguntados.has(line.product.id)) return line;
    const perguntada = quantidades?.[line.product.id] ?? line.quantity;
    if (perguntada !== line.quantity) return line;
    const marca = { precificadaPara: alvo, precificadaQtd: line.quantity };

    const item = porProduto.get(line.product.id);
    if (!item) return { ...line, ...marca };

    if (item.fonte === 'aberto') {
      // Nem o vigente é tocado: em preço aberto não existe vigente a descobrir,
      // e escrever a sugestão do cadastro (quase sempre zero) faria a linha
      // parecer "acima do vigente" para o painel de concessão.
      return { ...line, ...marca };
    }

    return {
      ...line,
      ...marca,
      unitPriceCents: precoDaLinha(line, item),
      product: {
        ...line.product,
        effective_price_cents: item.priceCents,
        on_sale: item.onSale,
      },
    };
  });
}

/**
 * A condição do cliente em uma frase de balcão: "Atacado · -15%".
 *
 * Existe porque preço que cai sozinho assusta. O operador escolhe o cliente,
 * vê o total do carrinho diminuir e não tem como saber se foi ele quem apertou
 * alguma coisa errada. Uma linha dizendo o nome da tabela e o percentual
 * transforma o susto em confirmação — e é a mesma frase que ele repete ao
 * cliente quando perguntam por que o preço é esse.
 *
 * Nulo devolve nulo: uma faixa permanente dizendo "sem tabela" em toda venda de
 * balcão vira parte do cenário, e no dia em que trouxer um nome ninguém lê.
 */
export function condicaoEmPalavras(
  priceTable: CarrinhoPrecificado['priceTable'],
): string | null {
  if (!priceTable) return null;
  const percentual = Number(priceTable.percentOff ?? 0);
  // Tabela de 0% existe: é a que só tem preços fixados por item, sem desconto
  // geral. Anunciar "-0%" pareceria defeito; o nome sozinho já explica.
  if (!(percentual > 0)) return priceTable.name;
  const texto = percentual.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
  return `${priceTable.name} · -${texto}%`;
}
