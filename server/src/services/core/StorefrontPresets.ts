/**
 * O TIPO DE CADA LOJA — rodada 56.
 *
 * ============================================================================
 * O QUE ESTE MÓDULO RESOLVE
 * ============================================================================
 *
 * Medido no banco real antes da rodada: a diferença entre as cinco lojas do
 * grupo, na vitrine, era EXCLUSIVAMENTE a paleta de cores. Mesma ordem de
 * seções, mesma grade de 2/3/4 colunas, mesmo card, mesmos filtros, mesma
 * paginação de 12. Uma importadora de variedades e uma loja de moda saíam
 * idênticas trocando o verde pelo azul.
 *
 * Elas não podem sair iguais porque não vendem igual. Quem entra numa
 * importadora sabe o que quer e procura; quem entra numa loja de moda quer ver.
 * A primeira vive de busca e densidade; a segunda, de foto grande e poucas
 * peças por linha.
 *
 * ============================================================================
 * POR QUE UMA LISTA, E NÃO CINCO PÁGINAS
 * ============================================================================
 *
 * A tentação é escrever uma vitrine por loja. Cinco páginas divergem no
 * primeiro conserto que alguém fizer em quatro delas — e este repositório já
 * tem a cicatriz: três definições diferentes de "abaixo do mínimo" nasceram
 * exatamente assim.
 *
 * Então é UMA página que lê um tipo e se arruma. O tipo é DADO
 * (`core_companies.storefront_preset`), porque slug se renomeia e loja nova
 * nasce a qualquer momento; e a lista de tipos válidos mora aqui, num lugar
 * só, para o servidor recusar o que a tela não sabe desenhar.
 *
 * ============================================================================
 * O QUE O TIPO NÃO DECIDE
 * ============================================================================
 *
 * A COR. A paleta é da MARCA e vem dos logos que o dono aprovou (rodada 40,
 * escopos `data-marca` em tokens.css). Duas lojas de moda do mesmo grupo têm
 * o mesmo arranjo e cores diferentes — e é assim que tem de ser: o arranjo
 * serve ao negócio, a cor identifica a casa.
 */

/**
 * Os quatro negócios que o grupo tem hoje.
 *
 * Acrescentar um valor aqui é acrescentar um arranjo que a tela precisa saber
 * desenhar — por isso a lista é fechada e o servidor recusa o que não está
 * nela. A memória deste projeto guarda o custo de listas abertas: um estado
 * novo entrou por complemento e quebrou quatro regras caladas.
 */
export const STOREFRONT_PRESETS = ['variedades', 'moda', 'beleza', 'veiculos'] as const;

export type StorefrontPreset = (typeof STOREFRONT_PRESETS)[number];

/** Rótulo em português, para a tela do gestor escolher. */
export const STOREFRONT_PRESET_LABEL: Record<StorefrontPreset, string> = {
  variedades: 'Importadora de variedades',
  moda: 'Moda e vestuário',
  beleza: 'Beleza e maquiagem',
  veiculos: 'Veículos e acessórios',
};

/**
 * O que cada tipo muda na vitrine, em uma linha — para a tela do gestor dizer
 * ao dono o que ele está escolhendo, em vez de oferecer quatro palavras soltas.
 */
export const STOREFRONT_PRESET_HINT: Record<StorefrontPreset, string> = {
  variedades: 'Busca em destaque, departamentos e mais produtos por linha.',
  moda: 'Foto grande, poucas peças por linha e as categorias em vitrine.',
  beleza: 'Vitrine em destaque, cards compactos e categorias por cor.',
  veiculos: 'Um modelo por vez, com os acessórios logo abaixo.',
};

export function isStorefrontPreset(valor: unknown): valor is StorefrontPreset {
  return STOREFRONT_PRESETS.includes(String(valor ?? '') as StorefrontPreset);
}

/**
 * As cinco lojas do grupo e o negócio de cada uma.
 *
 * Fica aqui e não na migração porque a migração roda uma vez: se o dono trocar
 * o tipo de uma loja pela tela, a migração não pode desfazer na próxima
 * subida. O passo de esquema só CARIMBA quem ainda está nulo.
 */
export const PRESET_OFICIAL: Record<string, StorefrontPreset> = {
  'preco-justo': 'variedades',
  gringa: 'moda',
  conceito: 'moda',
  'me-mimei': 'beleza',
  'pj-motors': 'veiculos',
};
