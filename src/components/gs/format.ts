/**
 * Formatação pt-BR compartilhada pelas telas.
 *
 * Vive fora de `ui.tsx` porque um módulo que exporta componentes não deve
 * exportar também funções — isso quebra o fast refresh do Vite.
 */

/** Centavos inteiros para moeda. O núcleo guarda dinheiro sempre em centavos. */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatQuantity(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/**
 * "2 disponíveis", "1 dia útil" — o plural decidido pela loja, não pelo
 * cliente.
 *
 * A loja pública dizia "2 disponível(is)", "1 produto(s) online", "até 3
 * dia(s) útil(eis)" — o "(s)" é a tela confessando que não teve tempo de
 * decidir o plural, e quem lê decide em um segundo o que isso diz sobre o
 * resto. Recebe as DUAS formas por extenso em vez de colar "s": "útil/úteis"
 * e "avaliação/avaliações" não se formam por sufixo.
 */
export function contar(n: number, singular: string, plural: string): string {
  return `${formatQuantity(n)} ${n === 1 ? singular : plural}`;
}

/**
 * ============================================================================
 * O PONTO QUE MULTIPLICAVA POR CEM
 * ============================================================================
 *
 * Texto do balcão para centavos: aceita "12,50", "12.50", "1.500,00" e "12".
 *
 * Fica ao lado de `formatCents` de propósito — são as duas pontas da mesma
 * conversão, e separá-las convidaria a duas regras diferentes sobre o que é
 * um valor válido. Devolve `null` quando não dá para ler, em vez de zero:
 * zero é um valor legítimo de contagem de caixa, e confundir "digitou nada"
 * com "contou nada" fecharia turno com falta inventada.
 *
 * ## O DEFEITO, MEDIDO
 *
 * A versão anterior apagava TODO ponto como separador de milhar ANTES de
 * olhar se havia vírgula. Rodando a função como ela estava:
 *
 *     "12.50"     ->  R$ 1.250,00     (cem vezes MAIS)
 *     "1234.56"   ->  R$ 123.456,00   (cem vezes MAIS)
 *     "1,234.56"  ->  R$ 1,23         (mil vezes MENOS)
 *
 * O primeiro caso é o que dói: `CaixaPdvDialog` usa esta função para SANGRIA,
 * SUPRIMENTO e CONTAGEM DE FECHAMENTO. Um operador que conta a gaveta e digita
 * `12.50` fechava o turno declarando R$ 1.250,00 — uma sobra de mil e duzentos
 * reais inventada, num número que ninguém confere porque veio "do sistema".
 * Nenhum teste pegava, porque todos os casos existentes usavam vírgula.
 *
 * ## A REGRA, E POR QUE ELA NÃO REGRIDE NINGUÉM
 *
 * Devolver `null` no caso ambíguo seria PIOR que o defeito: `PdvPage.tsx:632`
 * e `AlteracaoRapidaPage.tsx:56` fazem `?? 0`, então uma leitura que hoje sai
 * errada por cem passaria a sair ZERO — e zero em preço de linha é uma moto
 * saindo de graça. A função tem de decidir, sempre.
 *
 * A decisão vem de quem digita:
 *
 *  - A VÍRGULA É SEMPRE DECIMAL. É o separador do pt-BR e não tem ambiguidade
 *    nenhuma; é também o que TODAS as telas escrevem de volta no campo
 *    (`reaisNoCampo` no PDV, `reais()` na alteração rápida). Tudo que este
 *    projeto gera para ser relido passa por aqui, e continua passando.
 *
 *  - O PONTO É AMBÍGUO, e só ele precisa de regra. Quem digita no teclado
 *    numérico do caixa, ou cola de um export de sistema estrangeiro, escreve
 *    `12.50` querendo doze e cinquenta. Quem escreve à moda daqui escreve
 *    `1.500` querendo mil e quinhentos. O que separa os dois é o TAMANHO DO
 *    GRUPO depois do último ponto: exatamente TRÊS dígitos é grupo de milhar
 *    (é a única forma que o pt-BR produz); qualquer outro número de casas —
 *    uma, duas, quatro — é casa decimal.
 *
 *  - COM OS DOIS PRESENTES não sobra ambiguidade: o que aparece POR ÚLTIMO é o
 *    decimal, e o outro é milhar. Isso lê `1.234,56` e `1,234.56` como o mesmo
 *    valor, que é o que os dois querem dizer.
 *
 * `1.500` continua sendo mil e quinhentos, e não um e meio. É uma escolha, não
 * uma dedução — e é a escolha certa porque é a forma que o pt-BR realmente
 * escreve, e porque a tela nunca gera esse texto: para valer um e cinquenta o
 * campo teria de ter sido digitado com três casas decimais.
 */
/**
 * Qual caractere marca a casa decimal — `null` quando não há nenhuma.
 *
 * É a regra descrita no bloco acima, isolada porque QUANTIDADE precisa da
 * mesma decisão (`parseQuantity`, logo abaixo). Duas cópias fariam "1.500"
 * valer mil e quinhentos num campo e um e meio no outro, na mesma tela.
 */
function separadorDecimal(limpo: string): '.' | ',' | null {
  const ultimoPonto = limpo.lastIndexOf('.');
  const ultimaVirgula = limpo.lastIndexOf(',');

  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    return ultimaVirgula > ultimoPonto ? ',' : '.';
  }
  if (ultimaVirgula >= 0) return ',';
  if (ultimoPonto >= 0) {
    // A regra do grupo de três: `1.500` é milhar, `12.50` é decimal.
    const casas = limpo.length - ultimoPonto - 1;
    return casas === 3 ? null : '.';
  }
  return null;
}

export function parseReaisToCents(texto: string): number | null {
  const limpo = texto.trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (!limpo) return null;

  /*
    Só dígito e separador. Isto é o que recusa "abc", "--", "R$" sozinho e o
    negativo — frete negativo pagaria o cliente para comprar.
  */
  if (!/^[0-9.,]+$/.test(limpo)) return null;

  const decimal = separadorDecimal(limpo);
  const corte = decimal === null ? limpo.length : limpo.lastIndexOf(decimal);
  // O que sobra à esquerda ainda pode ter separadores de milhar; eles saem.
  const inteiro = limpo.slice(0, corte).replace(/[.,]/g, '');
  const fracao = decimal === null ? '' : limpo.slice(corte + 1);

  // "," e "." sozinhos chegam até aqui com as duas partes vazias.
  if (!inteiro && !fracao) return null;
  // Separador dentro da fração é texto que não é dinheiro. (O exemplo que
  // este comentário dava — "1.2.3,4,5" — NÃO cai aqui: a última vírgula vira
  // o decimal, a fração fica sendo "5" e o texto lê 1234,50. A guarda só
  // alcança o que sobra depois do corte, e o corte é sempre na última
  // ocorrência do decimal. Fixado em `__tests__/format.test.ts`, que é o teste
  // DESTA cópia — a gêmea do servidor tem o mesmo caso no teste dela.)
  if (fracao && !/^\d+$/.test(fracao)) return null;
  if (inteiro && !/^\d+$/.test(inteiro)) return null;

  const valor = Number(`${inteiro || '0'}.${fracao || '0'}`);
  if (!Number.isFinite(valor)) return null;
  return Math.round(valor * 100);
}

/**
 * Texto do balcão para QUANTIDADE — a outra ponta de `formatQuantity`.
 *
 * Peça de oficina é vendida por metro e por quilo, então quantidade tem casa
 * decimal de verdade: 0,7 metro de fio é lançamento comum. E `formatQuantity`
 * escreve em pt-BR com agrupamento — 1500 sai como "1.500" —, então a tela
 * precisa saber ler de volta o que ela mesma escreveu.
 *
 * A AMBIGUIDADE DO PONTO É A MESMA DO DINHEIRO, e por isso a regra é a mesma,
 * lida do mesmo lugar: `separadorDecimal`. Escrever uma segunda regra aqui
 * faria "1.500" valer mil e quinhentos num campo e um e meio no outro, na
 * mesma tela — que é exatamente como as três definições de "abaixo do mínimo"
 * nasceram neste repositório.
 *
 * O que MUDA em relação ao dinheiro são as casas: dinheiro tem duas, e
 * quantidade tem três (é o que `formatQuantity` imprime, e é o que a unidade
 * de peça fracionada exige). Cortar em duas transformaria 0,125 em 0,12 sem
 * ninguém pedir.
 *
 * `null` quando não dá para ler — nunca zero: quantidade zero é recusa
 * explícita em todo lançamento, e confundir "digitou errado" com "não quis
 * nada" esconderia o erro de digitação.
 */
export function parseQuantity(texto: string): number | null {
  const limpo = String(texto ?? '').trim().replace(/\s/g, '');
  if (!limpo) return null;
  if (!/^[0-9.,]+$/.test(limpo)) return null;

  const decimal = separadorDecimal(limpo);
  const corte = decimal === null ? limpo.length : limpo.lastIndexOf(decimal);
  const inteiro = limpo.slice(0, corte).replace(/[.,]/g, '');
  const fracao = decimal === null ? '' : limpo.slice(corte + 1);

  if (!inteiro && !fracao) return null;
  if (fracao && !/^\d+$/.test(fracao)) return null;
  if (inteiro && !/^\d+$/.test(inteiro)) return null;

  const valor = Number(`${inteiro || '0'}.${fracao || '0'}`);
  if (!Number.isFinite(valor)) return null;
  // Três casas, arredondando — a mesma precisão que `formatQuantity` imprime.
  return Math.round(valor * 1000) / 1000;
}

/**
 * Gramas para quilos, na tela.
 *
 * O peso da nota é guardado em GRAMAS inteiras — o XML traz kg com 3 casas, e
 * 3 casas de quilo é exatamente grama, então a conversão é exata e não entra
 * float. Mas a doca pesa em quilo, e é em quilo que a pessoa confere contra o
 * romaneio.
 */
export function formatGramsAsKg(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return '—';
  return `${(grams / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 3 })} kg`;
}

/**
 * CNPJ ou CPF pontuado, a partir dos dígitos.
 *
 * Uma função só para os dois porque quem a chama nem sempre sabe qual dos dois
 * recebeu: o certificado A1 traz o documento do titular, e ele é CNPJ num
 * e-CNPJ e CPF num e-CPF. Duas funções obrigariam a tela a decidir antes de
 * formatar, e a decisão erraria justamente no caso raro.
 *
 * O que não couber em 14 nem em 11 dígitos volta como veio: inventar pontuação
 * sobre um valor que não é documento esconderia o defeito em vez de mostrá-lo.
 */
export function formatarDocumento(valor: unknown): string {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 14) {
    return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (digitos.length === 11) {
    return digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return String(valor ?? '') || '—';
}
