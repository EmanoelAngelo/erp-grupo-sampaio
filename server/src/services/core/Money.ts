/**
 * Dinheiro como a pessoa no balcão lê.
 *
 * Existe porque esta rodada precisou da mesma frase em três lugares — a recusa
 * da venda, a recusa do documento e a recusa da liberação pequena demais — e
 * três cópias de "R$ ${(c/100).toFixed(2)}" é o começo clássico de duas delas
 * divergirem: uma com vírgula, outra com ponto, e o operador achando que são
 * dois valores diferentes quando são o mesmo.
 *
 * Não é formatação de tela. A tela tem `Intl` e a moeda do navegador; isto é o
 * número dentro de uma MENSAGEM DE ERRO do servidor, que precisa ser estável e
 * igual em qualquer máquina — inclusive no log, onde não há navegador nenhum.
 *
 * ## Vírgula, e não ponto
 *
 * A primeira versão devolvia `toFixed(2)` e saía "R$ 11999.00". Está errado
 * duas vezes para quem lê: o separador decimal do Brasil é a vírgula, e sem
 * separador de milhar ninguém distingue onze mil e novecentos de mil cento e
 * noventa e nove num relance — que é exatamente o que se pede a quem está no
 * balcão com o cliente esperando.
 *
 * A conta é feita à mão, e não com `Intl`, pelo motivo que o parágrafo acima
 * já dava: `toLocaleString` depende do locale instalado na máquina, e o mesmo
 * erro sairia diferente no servidor da loja e no log do servidor central.
 * Determinismo continua valendo — o que muda é qual formato é o determinístico.
 */
export function emReais(cents: number): string {
  const negativo = cents < 0;
  const inteiro = Math.floor(Math.abs(cents) / 100);
  const centavos = String(Math.abs(cents) % 100).padStart(2, '0');
  const milhar = String(inteiro).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}R$ ${milhar},${centavos}`;
}

/*
  ===========================================================================
  LEITURA — TEXTO QUE A PESSOA DIGITOU VIRANDO NÚMERO
  ===========================================================================

  ATENÇÃO: `parseReaisToCents` EXISTE DUAS VEZES neste projeto — aqui e em
  `src/components/gs/format.ts`, para a tela. Não é escolha: são dois pacotes,
  e `server/tsconfig.json` tem `rootDir` apontando para `src` e um `include`
  que só alcança `src`, sem caminho para fora. (Escrito por extenso porque o
  glob do `include` termina nos dois caracteres que FECHAM um comentário de
  bloco — colá-lo aqui parte este texto no meio e o erro aparece longe.)
  O `Ean13.ts` já bateu nesta mesma parede e a documentou.

  As duas cópias não podem divergir, e o que impede é
  `src/components/gs/__tests__/dinheiroSincronizado.test.ts`: ele importa as
  DUAS funções e roda a mesma tabela de casos nas duas. Divergiu em um caso, a
  suíte fica vermelha.

  Ele compara COMPORTAMENTO, e não texto de fonte como o teste do EAN-13 faz.
  A diferença importa: o teste do EAN quebra quando alguém mexe só num
  comentário, e teste que acusa o inocente é teste que acaba apagado.
*/

/**
 * A regra do separador, num lugar só — porque dinheiro e quantidade têm de
 * ler "1.500" do mesmo jeito.
 *
 *  - A VÍRGULA É SEMPRE DECIMAL. Ninguém aqui escreve milhar com vírgula.
 *  - O PONTO É AMBÍGUO, e só ele precisa de regra: `12.50` (teclado numérico,
 *    export estrangeiro) quer dizer doze e cinquenta; `1.500` quer dizer mil e
 *    quinhentos. O que separa os dois é o TAMANHO DO GRUPO depois do último
 *    ponto — exatamente TRÊS dígitos é milhar, porque é a única forma que o
 *    pt-BR produz; qualquer outro número de casas é decimal.
 *  - COM OS DOIS PRESENTES não sobra ambiguidade: o que vem POR ÚLTIMO é o
 *    decimal. Isso lê `1.234,56` e `1,234.56` como o mesmo valor.
 *
 * Devolve `null` quando o texto não é número — inclusive para os separadores
 * sozinhos (`,`) e para sobra de separador dentro da fração (`1.2.3,4,5`).
 */
function separarDecimal(texto: string): { inteiro: string; fracao: string } | null {
  if (!/^[0-9.,]+$/.test(texto)) return null;

  const ultimoPonto = texto.lastIndexOf('.');
  const ultimaVirgula = texto.lastIndexOf(',');

  let decimal: '.' | ',' | null;
  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    decimal = ultimaVirgula > ultimoPonto ? ',' : '.';
  } else if (ultimaVirgula >= 0) {
    decimal = ',';
  } else if (ultimoPonto >= 0) {
    const casas = texto.length - ultimoPonto - 1;
    decimal = casas === 3 ? null : '.';
  } else {
    decimal = null;
  }

  const corte = decimal === null ? texto.length : texto.lastIndexOf(decimal);
  // O que sobra à esquerda ainda pode ter separadores de milhar; eles saem.
  const inteiro = texto.slice(0, corte).replace(/[.,]/g, '');
  const fracao = decimal === null ? '' : texto.slice(corte + 1);

  if (!inteiro && !fracao) return null;
  if (fracao && !/^\d+$/.test(fracao)) return null;
  if (inteiro && !/^\d+$/.test(inteiro)) return null;
  return { inteiro, fracao };
}

/**
 * Texto para centavos. Gêmea de `parseReaisToCents` em
 * `src/components/gs/format.ts` — as duas têm de responder igual.
 *
 * NÃO ACEITA NEGATIVO, e é de propósito: preço negativo pagaria o cliente para
 * levar a mercadoria. Quem escreveu `-5` no campo de preço errou, e a recusa é
 * a resposta certa.
 */
export function parseReaisToCents(texto: string): number | null {
  const limpo = texto.trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (!limpo) return null;

  const partes = separarDecimal(limpo);
  if (!partes) return null;

  const valor = Number(`${partes.inteiro || '0'}.${partes.fracao || '0'}`);
  if (!Number.isFinite(valor)) return null;
  return Math.round(valor * 100);
}

/**
 * Texto para quantidade, pela MESMA regra de separador do dinheiro.
 *
 * Existe porque a planilha do Excel brasileiro escreve `2,5` para dois e meio,
 * e `Number('2,5')` é NaN. Sem esta função, a célula com vírgula viraria NaN,
 * `applyMovement` recusaria com quantidade inválida, e o lote inteiro — as
 * outras 197 linhas boas — cairia junto, depois de a tela ter mostrado tudo
 * verde. O erro de digitação de uma pessoa não pode derrubar o trabalho dela
 * inteiro.
 *
 * ## Aqui o negativo PASSA, e no dinheiro não
 *
 * A diferença é deliberada. `Math.abs` mora dentro de `signedDelta`
 * (`InventoryService.ts`), então uma quantidade `-5` chegando lá vira entrada
 * de CINCO unidades — a planilha que escreveu "-3" para dizer "faltam 3"
 * CRIARIA três, em silêncio, e o saldo mentiria sem nenhuma mensagem.
 *
 * Devolver `null` também não serve: quem chama não conseguiria distinguir
 * "-3" de "abc", e as duas mensagens são diferentes — uma manda corrigir o
 * sinal, a outra manda olhar a célula. Então esta função REPORTA o que está
 * escrito, com sinal, e a recusa do negativo é decisão de quem importa. Ler e
 * decidir são trabalhos separados.
 */
export function parseQuantidade(texto: string): number | null {
  const limpo = texto.trim().replace(/\s/g, '');
  if (!limpo) return null;

  const negativo = limpo.startsWith('-');
  const partes = separarDecimal(negativo ? limpo.slice(1) : limpo);
  if (!partes) return null;

  const valor = Number(`${partes.inteiro || '0'}.${partes.fracao || '0'}`);
  if (!Number.isFinite(valor)) return null;
  return negativo ? -valor : valor;
}
