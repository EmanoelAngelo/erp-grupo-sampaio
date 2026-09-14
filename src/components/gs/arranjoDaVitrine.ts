/**
 * COMO CADA NEGÓCIO ARRUMA A PRÓPRIA VITRINE — rodada 56.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO RESOLVE
 * ============================================================================
 *
 * Medido no banco real antes da rodada: a diferença entre as cinco lojas do
 * grupo era EXCLUSIVAMENTE a paleta de cores. Mesma ordem de seções, mesma
 * grade, mesmo card, mesma paginação. Uma importadora de variedades e uma loja
 * de moda saíam idênticas trocando o verde pelo azul.
 *
 * Elas não podem sair iguais porque não vendem igual:
 *
 *   Quem entra numa IMPORTADORA sabe o que quer e PROCURA. A busca é a
 *   primeira coisa da tela, os departamentos são o mapa, e cabe mais coisa por
 *   linha — o cliente está varrendo, não contemplando.
 *
 *   Quem entra numa loja de MODA quer VER. A foto manda, poucas peças por
 *   linha, e o card é RETRATO porque roupa é alta e não quadrada.
 *
 *   Quem entra numa loja de VEÍCULOS quer um modelo. Um por vez, grande, com
 *   os acessórios logo abaixo.
 *
 * ============================================================================
 * POR QUE UMA TABELA, E NÃO CINCO PÁGINAS
 * ============================================================================
 *
 * Cinco páginas divergem no primeiro conserto que alguém fizer em quatro
 * delas. Este repositório já tem essa cicatriz: TRÊS definições diferentes de
 * "abaixo do mínimo" nasceram exatamente assim, e a tela chegou a contradizer
 * o próprio botão de filtrar.
 *
 * Então é UMA página que lê uma linha desta tabela. Acrescentar um negócio é
 * acrescentar uma linha — e o servidor já recusa tipo que não está na lista,
 * para a tela nunca receber um arranjo que ela não sabe desenhar.
 *
 * ============================================================================
 * O QUE O ARRANJO NÃO DECIDE
 * ============================================================================
 *
 * A COR. A paleta é da MARCA e vem dos logos que o dono aprovou (rodada 40,
 * escopos `data-marca`). Gringa e Conceito são as duas 'moda' e têm cores
 * diferentes — o arranjo serve ao negócio, a cor identifica a casa.
 */

/** Os tipos que o servidor pode mandar. Espelha `StorefrontPresets.ts`. */
export type TipoDeLoja = 'variedades' | 'moda' | 'beleza' | 'veiculos';

export interface ArranjoDaVitrine {
  /** Vai para o DOM, para dar como medir qual arranjo está no ar. */
  id: TipoDeLoja | 'neutro';
  /**
   * A busca vem ANTES do herói?
   *
   * Só na importadora. Nas outras a busca existe e fica depois — enterrá-la
   * seria ruim, mas pô-la na frente da vitrine numa loja de moda é pedir que o
   * cliente digite o nome de uma peça que ele ainda não viu.
   */
  buscaPrimeiro: boolean;
  /** Colunas da grade, do celular ao desktop. */
  colunas: { base: number; md: number; lg: number };
  /**
   * A proporção do lugar da foto.
   *
   * Roupa é alta: quadrado corta a peça ou deixa duas faixas vazias. Variedade
   * é quadrada porque é caixa, frasco, embalagem.
   */
  proporcao: 'quadrado' | 'retrato';
  /** A frase padrão do herói quando o gestor ainda não escreveu a dele. */
  chamadaPadrao: string;
}

/**
 * O arranjo NEUTRO é o que a loja nova recebe.
 *
 * Não é "sem arranjo": é o meio-termo seguro — quadrado, três colunas, busca
 * depois do herói. Loja recém-criada tem de sair inteira e apresentável antes
 * de alguém escolher o negócio dela.
 */
const NEUTRO: ArranjoDaVitrine = {
  id: 'neutro',
  buscaPrimeiro: false,
  colunas: { base: 2, md: 3, lg: 4 },
  proporcao: 'quadrado',
  chamadaPadrao: 'A loja do Grupo Sampaio',
};

const ARRANJOS: Record<TipoDeLoja, ArranjoDaVitrine> = {
  variedades: {
    id: 'variedades',
    // O cliente da importadora chega procurando. É a única em que a busca
    // abre a página.
    buscaPrimeiro: true,
    // Densidade alta: é uma loja de varrer, não de contemplar.
    colunas: { base: 2, md: 4, lg: 5 },
    proporcao: 'quadrado',
    chamadaPadrao: 'Importadora de variedades',
  },
  moda: {
    id: 'moda',
    buscaPrimeiro: false,
    // Poucas peças por linha: a foto é o produto.
    colunas: { base: 2, md: 3, lg: 3 },
    proporcao: 'retrato',
    chamadaPadrao: 'Moda e vestuário',
  },
  beleza: {
    id: 'beleza',
    buscaPrimeiro: false,
    colunas: { base: 2, md: 3, lg: 4 },
    // Frasco e paleta são quadrados; retrato deixaria faixa vazia em cima e
    // embaixo de cada card.
    proporcao: 'quadrado',
    chamadaPadrao: 'Beleza e maquiagem',
  },
  veiculos: {
    id: 'veiculos',
    buscaPrimeiro: false,
    // Um modelo por vez no celular, dois no desktop: moto elétrica é compra
    // de olhar demorado, não de varredura.
    colunas: { base: 1, md: 2, lg: 2 },
    proporcao: 'quadrado',
    chamadaPadrao: 'Motos elétricas e acessórios',
  },
};

/**
 * O arranjo de um tipo — com o neutro para tudo que não está na tabela.
 *
 * Aceita `null` e desconhecido de propósito: o servidor valida na escrita, mas
 * a tela não pode quebrar por causa de um valor que chegou de um banco mais
 * novo que ela. Cair no neutro é sair apresentável; estourar é sair em branco.
 */
export function arranjoDaVitrine(tipo: string | null | undefined): ArranjoDaVitrine {
  if (!tipo) return NEUTRO;
  return ARRANJOS[tipo as TipoDeLoja] ?? NEUTRO;
}

/**
 * As classes da grade.
 *
 * Escritas por extenso, e não montadas com template — o Tailwind varre o
 * código-fonte para saber que classes gerar, e `grid-cols-${n}` não existe no
 * CSS final. É a diferença entre a grade funcionar e a página virar uma coluna
 * só, silenciosamente, só no build de produção.
 */
export function classesDaGrade(arranjo: ArranjoDaVitrine): string {
  const base = arranjo.colunas.base === 1 ? 'grid-cols-1' : 'grid-cols-2';
  const md =
    arranjo.colunas.md === 2 ? 'md:grid-cols-2' : arranjo.colunas.md === 3 ? 'md:grid-cols-3' : 'md:grid-cols-4';
  const lg =
    arranjo.colunas.lg === 2
      ? 'lg:grid-cols-2'
      : arranjo.colunas.lg === 3
        ? 'lg:grid-cols-3'
        : arranjo.colunas.lg === 5
          ? 'lg:grid-cols-5'
          : 'lg:grid-cols-4';
  return `${base} ${md} ${lg}`;
}
