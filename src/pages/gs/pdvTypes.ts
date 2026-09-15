/**
 * Tipos compartilhados do PDV.
 *
 * `CartLine` vivia dentro de `PdvPage.tsx`. Passou a morar aqui quando a
 * espera de venda (F7) precisou do mesmo formato: duplicar a definição faria
 * o carrinho guardado e o carrinho da tela divergirem no dia em que um dos
 * dois ganhasse um campo.
 */
import type { Product } from '@/lib/api/core';
import { formatCents, formatQuantity } from '@/components/gs/format';

export interface CartLine {
  product: Product;
  quantity: number;
  unitPriceCents: number;
  /**
   * Desconto DESTA linha, em centavos, digitado no campo "Desc." do carrinho
   * (GAP-V54). Viaja como items[].discountCents no POST /core/sales — o campo
   * que o servidor sempre aceitou e mediu na alçada, sem emissor na tela até
   * esta rodada. Ausente é zero: linha sem desconto.
   */
  discountCents?: number;
  /**
   * As peças escolhidas, para produto controlado por unidade.
   *
   * Sem isto o servidor recusa a venda: quem leva a moto leva AQUELA moto, e o
   * chassi vai para o documento. Vazio em produto comum.
   */
  unitIds?: string[];
  /** O que se mostra na linha do carrinho: chassi, IMEI ou nº de série. */
  unitLabel?: string;
  /**
   * Quantas das peças escolhidas NÃO têm plaquinha da oficina.
   *
   * Não impede a venda, e não deve: celular e acessório nunca vão ter plaquinha,
   * e travar o balcão por isso pararia a loja. Mas para a moto é a diferença
   * entre o comprador raspar o QR e ver o histórico de montagem, ou raspar e não
   * achar nada — e quem está fechando a venda é a última pessoa que ainda pode
   * mandar vincular antes de a peça sair.
   */
  unidadesSemPlaquinha?: number;
  /**
   * PARA QUAL CLIENTE esta linha foi precificada — e é isto que fecha a classe
   * de defeito inteira, em vez de um caso por vez.
   *
   * O PDV descobre o cliente DEPOIS dos itens, e item entra DEPOIS do cliente
   * por caminhos que ninguém lembra de atualizar: bipe de identidade
   * (chassi/IMEI), carregar pré-venda, retomar venda em espera (F7), produto de
   * preço aberto. Quatro foram medidos; o quinto é o que ainda não aconteceu.
   * Consertar caminho por caminho deixa esse quinto aberto para sempre, porque
   * quem escrever o próximo não vai saber que existe uma lista a atualizar.
   *
   * Com esta marca a regra vira uma só, e não depende de quem criou a linha:
   * toda linha cuja marca não bate com o cliente atual é reprecificada, venha
   * ela de onde vier.
   *
   * Os três estados são diferentes de propósito:
   *   `undefined` — nunca foi precificada para ninguém (linha vinda de
   *                 documento, ou de uma espera guardada antes desta rodada).
   *                 Sempre reprecifica.
   *   `null`      — precificada SEM cliente, que é o preço da busca do balcão.
   *                 Com o carrinho sem cliente, nada a fazer.
   *   `'<id>'`    — precificada para aquele cliente.
   */
  precificadaPara?: string | null;
  /**
   * PARA QUAL QUANTIDADE esta linha foi precificada (G-offline-sync-M01).
   *
   * O DEFEITO: a marca só dizia PARA QUEM. A faixa de preço por quantidade do
   * Gestor ("a partir de 3: R$ 3,33") é aplicada pelo servidor pela quantidade
   * da linha, e a linha nascia com o preço da busca, que é o de UMA unidade.
   * Bipar três vezes (ou corrigir a quantidade para 3) não reprecificava: a
   * tela mostrava R$ 12,00, o débito passava R$ 12,00, e o servidor fechava por
   * R$ 9,99 e recusava o "troco" de R$ 2,01 fora do dinheiro. No F8 a gaveta
   * ficava com os R$ 2,01 que o servidor lançou como troco dado.
   *
   * Ausente vale 1: é a quantidade do preço que a busca devolve, e é o que as
   * linhas gravadas antes deste campo (rascunho, espera) de fato tinham.
   */
  precificadaQtd?: number;
  /**
   * O operador DIGITOU o preço desta linha — ou ela veio de um documento.
   *
   * A reprecificação não sobrescreve valor combinado: ela o limita ao novo
   * vigente (`Math.min`), que é exatamente o que o servidor faz no fechamento.
   * Sem isto, escolher o cliente apagaria a negociação que acabou de acontecer
   * no balcão — e o pior caso não é perder um desconto, é a linha de pré-venda
   * subir para o preço de hoje depois de o cliente ter aprovado outro número.
   *
   * Toda linha vinda de `loadQuote` nasce com isto verdadeiro: preço de
   * pré-venda é negociação GRAVADA, não herança do vigente.
   */
  precoDigitado?: boolean;

  /**
   * O valor COMBINADO, guardado uma vez e nunca reescrito.
   *
   * ## A catraca que este campo desarma
   *
   * A reprecificação limitava o preço fazendo `Math.min(unitPriceCents, novo)`
   * — e `unitPriceCents` é justamente o campo que ela acabou de reescrever. O
   * efeito é uma catraca que só desce:
   *
   *   operador combina R$ 100          -> unitPriceCents = 100
   *   escolhe revendedor de 15%        -> min(100, 85)  = 85
   *   TIRA o cliente (volta ao normal) -> min(85, 100)  = 85   <- deveria ser 100
   *   escolhe outro cliente, de 5%     -> min(85, 95)   = 85
   *
   * Os R$ 100 combinados desapareceram na primeira troca, e o desconto do
   * revendedor grudou numa venda que não é mais dele. Ninguém vê: o número na
   * tela é plausível em todos os passos, e só quem lembra do valor combinado
   * percebe — quer dizer, o cliente, na hora de pagar.
   *
   * Com o combinado guardado à parte, o teto é sempre medido contra ELE, e
   * tirar o cliente devolve o preço à negociação original.
   */
  precoNegociadoCents?: number;
}

/**
 * O retrato de um item que saiu do carrinho antes do Finalizar (GAP-V52/V63).
 *
 * Mora aqui porque a espera (F7) passou a guardar o rastro junto do carrinho
 * (D-pdv-teclado-M05): o formato é um só para a tela e para a espera.
 */
export interface ItemRemovidoDoCarrinho {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  removedAt: string;
}

// ------------------------------------------------- peça de bancada no balcão

/**
 * O produto é peça de bancada?
 *
 * `kind` ausente lê como revenda: é o que o produto era antes de a coluna
 * existir, e é o que devolve toda leitura que não seleciona a coluna. Tratar
 * ausente como peça faria o balcão inteiro pedir confirmação.
 */
export function ehPecaDeBancada(product: Pick<Product, 'kind'>): boolean {
  return product.kind === 'part';
}

/**
 * O distintivo da linha: "Peça · Oficina de Celulares".
 *
 * Nulo para mercadoria — é o que deixa a tela escrever `{distintivo && ...}`
 * sem repetir a pergunta em cada lugar que mostra produto.
 *
 * A bancada entra no texto porque "peça" sozinho não resolve nada de prático:
 * quem está no balcão precisa saber DE QUEM é o estoque que vai ser esvaziado,
 * e é o nome da oficina que ele usa para ir perguntar.
 *
 * Sem nome, o distintivo continua existindo e diz só "Peça de oficina": a
 * busca do PDV sempre traz o nome, mas `getProduct` (o caminho de quem bipa a
 * identidade da peça) devolve a linha crua, sem a junção. Inventar um "oficina
 * sem nome" para essa metade seria escrever na tela um defeito de cadastro que
 * não existe.
 */
export function distintivoDePeca(
  product: Pick<Product, 'kind' | 'workshop_name'>,
): string | null {
  if (!ehPecaDeBancada(product)) return null;
  return product.workshop_name ? `Peça · ${product.workshop_name}` : 'Peça de oficina';
}

/**
 * PARA ONDE VAI O RESULTADO DA BUSCA — e é aqui que a peça é barrada.
 *
 * `carrinho`   casamento EXATO de um item só: foi bipagem, e bipar é o gesto
 *              de quem já está com a coisa na mão. Entra direto, como sempre.
 * `perguntar`  o casamento exato é uma PEÇA DE BANCADA. Vender continua
 *              permitido — proibir empurraria o operador a cadastrar o mesmo
 *              item de novo, que é o desfecho pior —, mas nunca por acidente:
 *              o saldo que sai é o que a oficina está contando para terminar um
 *              conserto, e a venda de balcão o esvaziava sem ninguém ver, sem
 *              nem uma linha na tela dizendo que aquilo era peça.
 * `lista`      qualquer outra coisa: a tela mostra os achados e a pessoa
 *              escolhe.
 *
 * Mora aqui, fora do componente, porque é a REGRA e precisa de teste próprio:
 * dentro do `runSearch` ela só seria exercível montando a tela inteira.
 */
export type DestinoDaBusca = 'carrinho' | 'perguntar' | 'lista';

/**
 * A linha da busca, com a marca de casamento exato quando o servidor a manda.
 *
 * `matched_exact` é a marca que a busca do balcão JÁ devolve (A-produto-M01:
 * código de barras, código interno em qualquer caixa e códigos adicionais —
 * sem o SKU). `exato` é o nome pedido ao integrador; os dois são opcionais, e
 * sem nenhum a tela infere (ver `casouExato`).
 */
export type AchadoDaBusca = Product & {
  exato?: number | boolean | null;
  matched_exact?: number | boolean | null;
  /**
   * O que a ETIQUETA DA BALANÇA diz (D-pdv-teclado-16). Só vem na linha do
   * produto achado pelo PLU de uma etiqueta da faixa que a operação declarou —
   * e nessa linha `matched_exact` vem em zero de propósito (ver
   * `etiquetaDaBalancaUnica`).
   */
  balanca?: LeituraDaBalanca | null;
};

/**
 * A etiqueta da balança lida pelo servidor (`GET /core/products/search`).
 *
 * `quantidade` é o que vai na linha da venda, em kg com 3 casas: o peso
 * impresso, ou — na etiqueta de PREÇO — o total dividido pelo preço vigente
 * (nula quando o produto está sem preço). `precoTotalCents` é o total impresso
 * na etiqueta de preço; na de peso é nulo.
 */
export interface LeituraDaBalanca {
  codigo: string;
  plu: string;
  tipo: 'peso' | 'preco';
  quantidade: number | null;
  precoTotalCents: number | null;
}

export type AchadoDaBalanca = AchadoDaBusca & { balanca: LeituraDaBalanca };

/** A linha veio pela etiqueta da balança? */
export function temEtiquetaDaBalanca(achado: Product | AchadoDaBusca): achado is AchadoDaBalanca {
  const b = (achado as AchadoDaBusca).balanca;
  return b !== undefined && b !== null && typeof b === 'object';
}

/*
  A ETIQUETA DA BALANÇA ENTRA NO CARRINHO COM O PESO (D-pdv-teclado-16).

  O DEFEITO: o servidor já lia a etiqueta (prefixo, PLU e peso ou preço
  embutidos) e devolvia `balanca` na linha do produto — com `matched_exact` em
  zero, para que a tela que não soubesse ler o campo mandasse o achado para a
  lista em vez de pôr "1 kg". A tela não sabia: bipar a etiqueta do queijo de
  0,352 kg desenhava uma lista de um item, e escolhê-lo punha 1 kg (o valor do
  campo Quantidade) — o cliente pagava o triplo, ou o caixa digitava o peso de
  cabeça.

  A regra: UMA linha com `balanca` entra direto, com a quantidade da etiqueta.
  Duas ou mais (o mesmo PLU em dois cadastros — defeito de cadastro) vão para a
  lista, onde a pessoa escolhe; nenhuma é a busca de sempre.
*/
export function etiquetaDaBalancaUnica(achados: AchadoDaBusca[]): AchadoDaBalanca | null {
  const daBalanca = achados.filter(temEtiquetaDaBalanca);
  return daBalanca.length === 1 ? daBalanca[0] : null;
}

/**
 * Quanto a conta "quantidade × preço" pode se afastar do total impresso na
 * etiqueta de PREÇO sem ser erro.
 *
 * A quantidade da etiqueta de preço é o total dividido pelo preço, arredondado
 * ao GRAMA (3 casas). Esse arredondamento, multiplicado de volta pelo preço do
 * quilo, erra até meio grama de mercadoria: 1 centavo num produto de R$ 20/kg,
 * 3 centavos num de R$ 49,90/kg. Mais do que isso não é arredondamento — é o
 * preço da linha diferente do que a etiqueta usou.
 */
export function toleranciaDaEtiquetaDePrecoCents(unitarioCents: number): number {
  return Math.max(1, Math.ceil(Math.max(0, unitarioCents) / 2000));
}

/**
 * A etiqueta pode entrar no carrinho pelo preço `unitarioCents`? Nulo é sim;
 * texto é a recusa, para a faixa, dizendo o que houve e o que fazer.
 *
 * `unitarioCents` é o preço com que a linha vai NASCER: o digitado em "Preço
 * Unitário", ou o vigente do cadastro. A reprecificação posterior (tabela do
 * cliente) é outra regra, a mesma de qualquer item — a etiqueta diz quanto a
 * mercadoria pesa, e o preço do cliente é o do cliente.
 */
export function recusaDaEtiquetaDaBalanca(achado: AchadoDaBalanca, unitarioCents: number): string | null {
  const { balanca } = achado;
  const kg = balanca.quantidade;
  if (kg === null || !Number.isFinite(kg) || kg <= 0) {
    return balanca.tipo === 'preco'
      ? `A etiqueta de preço da balança não vira peso para "${achado.name}": o produto está sem preço no `
        + 'cadastro. O item não entrou — cadastre o preço do quilo, ou escolha o produto e digite o peso.'
      : `A etiqueta da balança de "${achado.name}" marca peso zero. O item não entrou — pese de novo e `
        + 'bipe a etiqueta nova.';
  }
  if (balanca.tipo !== 'preco' || balanca.precoTotalCents === null) return null;
  const cobrado = Math.round(kg * unitarioCents);
  if (Math.abs(cobrado - balanca.precoTotalCents) <= toleranciaDaEtiquetaDePrecoCents(unitarioCents)) {
    return null;
  }
  return (
    `A etiqueta da balança diz ${formatCents(balanca.precoTotalCents)}, e ${formatQuantity(kg)} kg de `
    + `"${achado.name}" a ${formatCents(unitarioCents)}/kg dá ${formatCents(cobrado)}. O item não entrou: `
    + 'a etiqueta de preço vale pelo preço do cadastro — apague o "Preço Unitário" digitado e bipe de novo, '
    + 'ou pese de novo na balança.'
  );
}

/**
 * ESTE ACHADO VEIO POR CÓDIGO (casamento exato) OU POR TEXTO?
 *
 * ## O defeito que isto fecha (D-pdv-teclado-03)
 *
 * A regra era `barcode === termo || internal_code === termo`. O servidor casa
 * exato por MAIS dois caminhos — o SKU e os CÓDIGOS ADICIONAIS do cadastro
 * (`core_product_barcodes`, o código do fardo, a etiqueta antiga) — e o
 * `SELECT p.*` não devolve os adicionais. Bipar o código adicional trazia UM
 * produto, a tela não reconhecia o casamento, desenhava uma lista de um item e
 * o Enter do leitor já tinha sido gasto: o item não entrava e o código ficava
 * no campo, esperando o próximo bipe se colar atrás dele.
 *
 * ## Como a tela sabe sem o servidor dizer
 *
 * A busca do balcão só devolve uma linha por dois motivos: casamento EXATO
 * (código de barras, código interno, SKU, código adicional) ou TEXTO — `nome
 * LIKE %termo%` ou `código interno LIKE %termo%`. Não há terceiro. Então a
 * linha cujo nome e código interno NÃO contêm o termo só pode ter vindo pelo
 * casamento exato. `LIKE` do SQLite ignora caixa só em ASCII; `toLowerCase`
 * ignora em tudo — se o LIKE casou, o `includes` também casa, e o erro possível
 * é só para o lado seguro (cair na lista).
 *
 * `%` e `_` são curingas do LIKE: com eles no termo a inferência não vale, e a
 * linha cai na lista. Leitor de código de barras não digita nenhum dos dois.
 *
 * Quando o servidor mandar a marca, é a palavra dele que vale — a inferência
 * é o reserva para o servidor que ainda não manda.
 *
 * ## A marca que o servidor JÁ manda (revisão)
 *
 * A busca do balcão desta árvore devolve `matched_exact` (A-produto-M01), e
 * esta função só lia `exato` — que nenhum servidor manda. Ignorada a marca,
 * dois casos caíam na lista: o código interno digitado em outra caixa
 * ("gs-000001" para o "GS-000001", que o servidor casa por `upper()`), e o
 * código adicional de um produto cujo próprio nome contém o número. A
 * igualdade direta vem ANTES da marca porque `matched_exact` não conhece o
 * SKU: SKU igual ao termo é casamento exato mesmo com a marca em zero.
 */
export function casouExato(achado: AchadoDaBusca, termo: string): boolean {
  const alvo = termo.trim();
  if (!alvo) return false;
  if (
    achado.barcode === alvo
    || (achado.internal_code ?? '').toUpperCase() === alvo.toUpperCase()
    || (achado.sku ?? null) === alvo
  ) {
    return true;
  }
  const marca = achado.exato ?? achado.matched_exact;
  if (marca !== undefined && marca !== null) {
    return marca === true || Number(marca) === 1;
  }
  if (/[%_]/.test(alvo)) return false;
  const t = alvo.toLowerCase();
  const porTexto =
    (achado.name ?? '').toLowerCase().includes(t)
    || (achado.internal_code ?? '').toLowerCase().includes(t);
  return !porTexto;
}

export function destinoDaBusca(achados: AchadoDaBusca[], termo: string): DestinoDaBusca {
  const alvo = termo.trim();
  if (achados.length === 0 || !alvo) return 'lista';
  /*
    UM casamento exato decide, mesmo acompanhado de achados por texto: o código
    bipado é de um produto só, e a lista ao lado dele é ruído do LIKE. Dois
    exatos (o mesmo código em dois cadastros) é defeito de cadastro — aí a
    pessoa escolhe na lista.
  */
  const exatos = achados.filter((a) => casouExato(a, alvo));
  if (exatos.length !== 1) return 'lista';
  return ehPecaDeBancada(exatos[0]) ? 'perguntar' : 'carrinho';
}

/** O achado que `destinoDaBusca` mandou para o carrinho (ou para a pergunta). */
export function achadoExato(achados: AchadoDaBusca[], termo: string): AchadoDaBusca | null {
  const exatos = achados.filter((a) => casouExato(a, termo));
  return exatos.length === 1 ? exatos[0] : null;
}

/**
 * Produto vendido a peso (GAP da balança): a quantidade é decimal, em kg.
 *
 * `weighable` vem na linha da busca (`p.*`), mas o tipo `Product` do cliente
 * não o declara — daí a leitura por aqui, num lugar só.
 */
export function ehPesavel(product: Product): boolean {
  return Number((product as Product & { weighable?: number | null }).weighable ?? 0) === 1;
}

/*
  PRODUTO VENDIDO POR UNIDADE NÃO ENTRA EM PEDAÇO (D-pdv-teclado-14, a parte
  da tela).

  O servidor passou a recusar (`CORE_QUANTITY_MUST_BE_INTEGER`), e a tela
  aceitava "2,5" (ou "0,5*código") numa camiseta UN: a linha entrava com meia
  camiseta, o total mostrava metade do preço, e a recusa só vinha no Finalizar —
  com o cliente na frente e, às vezes, o cartão já passado.

  A regra do servidor é "pesável, ou unidade que fraciona (kg, metro, litro), ou
  unidade cadastrada com casas decimais". A tela não conhece o cadastro de
  unidades da empresa; por isso ela só barra as unidades que SABE que são
  inteiras — as de contagem. Unidade que ela não conhece segue para o servidor,
  que decide: barrar por palpite uma unidade decimal cadastrada pararia uma
  venda legítima sem conserto possível no balcão.
*/
const UNIDADES_DE_CONTAGEM = new Set([
  'UN', 'UND', 'UNID', 'UNIDADE', 'PC', 'PÇ', 'PCA', 'PECA', 'PEÇA', 'CX', 'PCT', 'KIT', 'PAR',
  'DZ', 'JG', 'FD', 'CJ',
]);

/** O produto só pode sair em quantidade INTEIRA? (a mesma decisão do servidor, pela metade que a tela sabe) */
export function soVendeInteiro(product: Product): boolean {
  if (ehPesavel(product)) return false;
  return UNIDADES_DE_CONTAGEM.has(String(product.unit ?? 'UN').trim().toUpperCase());
}

/** A frase da recusa — a mesma do servidor, para o caixa ler uma coisa só nos dois lugares. */
export function recusaDeFracao(product: Product, quantidade: number): string {
  return (
    `"${product.name}" é vendido por unidade (${String(product.unit ?? 'UN').toUpperCase()}): `
    + `a quantidade precisa ser inteira, e veio ${String(quantidade).replace('.', ',')}. `
    + 'Corrija a quantidade.'
  );
}

/**
 * Teto de quantidade de uma linha do balcão.
 *
 * Nenhuma venda de balcão leva cem mil unidades de um item — e é exatamente
 * esse o tamanho de um código de barras que caiu no campo errado
 * (D-pdv-teclado-05): "3" + "7891234567895" vira 37 trilhões de unidades.
 */
export const QTD_MAXIMA_DA_LINHA = 99_999;

/**
 * Atalhos que o handler da tela principal trata.
 *
 * Mora aqui, e não em `PdvPage.tsx`, porque constante exportada de arquivo de
 * componente quebra o fast refresh do Vite — a tela recarrega inteira a cada
 * gravação em vez de atualizar em pé.
 */
/**
 * Teclas de função que o PDV trata.
 *
 * F5, F11 e F12 NÃO entram nesta lista, e não é esquecimento: são teclas do
 * sistema operacional (recarregar, tela cheia, ferramentas do navegador). O
 * balcão roda num desktop, e roubar a tecla de recarregar de quem trabalha o
 * dia inteiro no navegador custa mais do que economiza. O pagamento, que era
 * F5, passou para F10; a observação, que era F12, virou Alt+O.
 */
export const PDV_SHORTCUT_KEYS = ['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10'];

/** Teclas que devem chegar ao navegador intactas. Há teste cobrando. */
export const PDV_TECLAS_DO_SISTEMA = ['F5', 'F11', 'F12'];

// ------------------------------------------------ fiscal incompleto no balcão

/**
 * O "FISCAL INCOMPLETO" DO BALCÃO (P0 da Preço Justo).
 *
 * O DEFEITO: o produto sem NCM (ou sem grupo tributário que feche) entrava no
 * carrinho sem sinal nenhum, e a recusa da NFC-e só aparecia DEPOIS do
 * pagamento, com o cliente pago na frente do caixa.
 *
 * A busca agora manda `fiscal_pendencias` — os NOMES dos campos que a nota
 * recusaria, pela régua da própria nota (servidor, `PendenciaFiscalNoBalcao`).
 * O distintivo vai na lista e na linha do carrinho; a frase vai na faixa
 * quando o item entra direto pela bipagem, sem passar pela lista. Nenhum dos
 * dois bloqueia a venda — travar o balcão por cadastro pararia a loja —; o
 * que eles fazem é o operador saber ANTES do pagamento, e chamar quem cuida
 * do catálogo.
 */
export function pendenciasFiscais(product: Pick<Product, 'fiscal_pendencias'>): string[] {
  const lista = product.fiscal_pendencias;
  return Array.isArray(lista)
    ? lista.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
}

/** "Fiscal incompleto: NCM, CFOP" — o distintivo. Nulo quando não há o que avisar. */
export function rotuloFiscalIncompleto(product: Pick<Product, 'fiscal_pendencias'>): string | null {
  const p = pendenciasFiscais(product);
  return p.length > 0 ? `Fiscal incompleto: ${p.join(', ')}` : null;
}

/** A frase da faixa quando o item entrou direto pela bipagem. */
export function avisoFiscalIncompleto(product: Pick<Product, 'name' | 'fiscal_pendencias'>): string | null {
  const p = pendenciasFiscais(product);
  if (p.length === 0) return null;
  return (
    `"${product.name}" entrou, mas o cadastro fiscal está incompleto (${p.join(', ')}): a NFC-e desta `
    + 'venda vai ser recusada até alguém completar o cadastro. Avise o gerente ou quem cuida do catálogo.'
  );
}
