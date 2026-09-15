/**
 * Formatos de etiqueta — a geometria do papel.
 *
 * ## Por que isto vive no servidor
 *
 * A tela desenhava a etiqueta em PIXELS e mandava `window.print()` da própria
 * página. Pixel não tem tamanho físico: o mesmo layout saía diferente em cada
 * impressora, e sem `@page` a folha herdava o A4 retrato com margem de
 * documento declarado em `src/index.css`. Etiqueta que não sai no tamanho do
 * adesivo não serve para nada.
 *
 * Aqui tudo é MILÍMETRO e a folha inteira é montada no servidor
 * (`LabelSheet.renderLabelSheet`). A etiqueta avulsa da fila
 * (`PrintRenderer.renderProductLabel`) usa esta mesma geometria, no formato
 * `rolo_50x30`.
 *
 * ## O que este arquivo NÃO resolve
 *
 * Tamanho no papel só sai certo se a impressora estiver com o papel correto e
 * o diálogo em 100%, sem "ajustar à página". O `@page` em milímetro é condição
 * necessária, não suficiente — nenhum código controla o diálogo do sistema.
 * Por isso o formato padrão é o de folha A4, o único que sai certo numa
 * impressora comum de escritório.
 */

/** Campos que cabem no papel. Etiqueta pequena não comporta tudo. */
export type LabelField =
  | 'nome' | 'atributos' | 'preco' | 'barras' | 'ean' | 'codigo' | 'empresa'
  // Os que só os MODELOS da loja oferecem (LabelTemplateService).
  | 'marca' | 'unidade' | 'sku' | 'descricao' | 'complemento'
  // Do LOTE (core_product_batches): o que o fiscal sanitário e o cliente leem no alimento.
  | 'validade' | 'lote';

/** O corte da térmica: nenhum (destaca na serrilha), a cada etiqueta, ou só no fim do lote. */
export type ModoDeCorte = 'nenhum' | 'cada_etiqueta' | 'fim_do_lote';
/** Como a térmica acha o começo da etiqueta: vão entre adesivos, marca preta no verso, ou papel contínuo. */
export type SensorDaMidia = 'vao' | 'marca' | 'continua';

/** Os campos que um MODELO de etiqueta pode escolher — o rótulo vai para a tela. */
export const CAMPOS_DA_ETIQUETA: readonly { id: LabelField; rotulo: string }[] = [
  { id: 'nome', rotulo: 'Nome do produto' },
  // "Descrição curta" imprimia a DESCRIÇÃO INTERNA do cadastro — que o
  // formulário apresenta como "anotação para a equipe, não aparece na
  // vitrine". Uma nota como "margem baixa, não dar desconto" ia parar no
  // adesivo da gôndola, na frente do cliente. A etiqueta agora lê a descrição
  // PÚBLICA (a da loja online), e o rótulo diz isso.
  { id: 'descricao', rotulo: 'Descrição (a mesma da loja online)' },
  { id: 'preco', rotulo: 'Preço' },
  { id: 'barras', rotulo: 'Código de barras (desenho)' },
  { id: 'ean', rotulo: 'Número do código de barras' },
  { id: 'codigo', rotulo: 'Código interno' },
  { id: 'sku', rotulo: 'SKU' },
  { id: 'marca', rotulo: 'Marca' },
  { id: 'unidade', rotulo: 'Unidade' },
  { id: 'atributos', rotulo: 'Grade (tamanho, cor…)' },
  { id: 'empresa', rotulo: 'Nome da loja' },
  { id: 'complemento', rotulo: 'Texto próprio' },
  // DEFEITO QUE ISTO CORRIGE: o lote e a validade existiam no cadastro
  // (core_product_batches) e nenhuma etiqueta os imprimia — o alimento saía
  // para a gôndola sem a data que o cliente e a vigilância sanitária procuram.
  { id: 'validade', rotulo: 'Validade (do lote)' },
  { id: 'lote', rotulo: 'Lote' },
];

export interface LabelFormat {
  id: string;
  label: string;
  /** Para que serve, em uma frase — vai para a tela. */
  hint: string;
  /** Rolo (uma etiqueta por página) ou folha A4. */
  midia: 'rolo' | 'folha';
  widthMm: number;
  heightMm: number;
  columns: number;
  /** Linhas por folha. Nulo em rolo, onde a página é a própria etiqueta. */
  rows: number | null;
  gapXmm: number;
  gapYmm: number;
  /** Margem da folha. Em rolo é a margem da própria etiqueta. */
  marginTopMm: number;
  marginLeftMm: number;
  campos: LabelField[];
  /**
   * De onde saíram as medidas (a ficha do fabricante da folha). Existe para o
   * teste conferir a geometria contra ela: medida "de cabeça" desalinha a
   * folha inteira e só aparece no papel.
   */
  fonteDasMedidas?: string;
  /**
   * O papel real: nos MODELOS da loja, e nas folhas que não são A4 (Carta).
   * Ausente numa folha, a página é A4.
   */
  paperWidthMm?: number;
  paperHeightMm?: number | null;
  orientation?: 'retrato' | 'paisagem';
  scalePercent?: number;
  priceHighlight?: boolean;
  complementText?: string | null;
  /**
   * A resolução da impressora do MODELO (203, 300 ou 600 dpi). O módulo do
   * código de barras é arredondado para os pontos DELA. Ausente (formatos
   * prontos), vale o palpite pela mídia: 203 no rolo, 300 na folha.
   */
  dpi?: number;
  /*
    O QUE SÓ A IMPRESSORA FÍSICA DECIDE (modelos da loja).

    DEFEITO QUE ISTO CORRIGE: o modelo dizia o papel e o conteúdo, mas não o
    que faz o adesivo sair no LUGAR: a térmica que puxa o rolo 1 mm torto
    imprimia todas as etiquetas 1 mm tortas, e não havia onde compensar; a
    densidade, a velocidade, o corte e o sensor da mídia ficavam no driver de
    cada computador — e a saída em ZPL/EPL/TSPL, que não passa por driver
    nenhum, não tinha de onde tirá-los.
  */
  /** Calibração: desloca a etiqueta inteira no papel, em mm (positivo = direita/baixo). */
  offsetXmm?: number;
  offsetYmm?: number;
  /** Escurecimento da térmica, 0–30 (a escala do ZPL; TSPL e EPL usam a metade). Nulo: o da impressora. */
  densidade?: number | null;
  /** Velocidade em polegadas por segundo. Nula: a da impressora. */
  velocidade?: number | null;
  corte?: ModoDeCorte;
  sensor?: SensorDaMidia;
  /** O vão (ou a marca preta) entre uma etiqueta e a próxima no rolo, em mm. Nulo: não informado. */
  vaoDoRoloMm?: number | null;
  /** Avanço de papel depois da última etiqueta do lote, em mm. */
  avancoFinalMm?: number;
}

/**
 * As resoluções de impressora que um modelo pode declarar: 203 (térmica de
 * balcão — Argox, Elgin, Zebra de entrada), 300 (térmica de linha melhor, e o
 * múltiplo das jato de tinta/laser) e 600 (laser).
 */
export const DPIS_DA_IMPRESSORA = [203, 300, 600] as const;
export type DpiDaImpressora = (typeof DPIS_DA_IMPRESSORA)[number];

/** Folha A4, em milímetros. */
const A4_LARGURA = 210;
const A4_ALTURA = 297;

/**
 * Os oito formatos.
 *
 * Quatro de rolo, para impressora térmica de etiqueta (Argox, Zebra, Elgin), e
 * quatro de folha adesiva, que é o que se compra em papelaria.
 *
 * ## As folhas seguem a FICHA do fabricante — e dizem qual
 *
 * DEFEITO QUE ISTO CORRIGE: o formato padrão se chamava "Pimaco A4356" e tinha
 * a geometria da Pimaco 6180, que é folha CARTA (66,7 × 25,4, 30 por folha,
 * margem de 12,7). A A4356 real tem 63,5 × 25,4 mm e 33 por folha (3 × 11).
 * Quem comprava a folha que a tela mandava comprar imprimia com passo de
 * coluna de 69,2 mm contra 66,0 reais, a primeira linha 3,9 mm abaixo — e as
 * barras e o número de cada etiqueta caíam no adesivo de baixo. O "20 por
 * folha" citava a A4260 (que é 63,5 × 38,1, 21 por folha) com a geometria da
 * 6181 Carta.
 *
 * Agora cada folha traz `fonteDasMedidas` (a ficha de onde saiu cada número) e
 * o teste confere as medidas contra ela. Os ids antigos continuam existindo —
 * modelos da loja e telas abertas os usam — mas passam a ser o que a geometria
 * deles sempre foi: folha CARTA (215,9 × 279,4 mm), com a página Carta.
 */
export const LABEL_FORMATS: LabelFormat[] = [
  {
    // Este é o layout que já existia. Fica em primeiro por ser o conhecido.
    id: 'rolo_50x30',
    label: 'Rolo 50 × 30 mm',
    hint: 'A etiqueta de sempre. Impressora térmica, uma coluna.',
    midia: 'rolo',
    widthMm: 50,
    heightMm: 30,
    columns: 1,
    rows: null,
    gapXmm: 0,
    gapYmm: 0,
    marginTopMm: 2,
    marginLeftMm: 2,
    campos: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo', 'empresa'],
  },
  {
    id: 'rolo_33x22',
    label: 'Rolo 33 × 22 mm',
    // O aviso do ponto quebrado (C-etiquetas-05): 31,8 mm úteis dão 2,25 pontos
    // de térmica de 203 dpi por módulo, e o formato pronto não tem prévia onde
    // `avisosDoFormato` apareceria — então é a dica que diz.
    hint: 'Etiqueta pequena, para peça miúda. Só nome, preço e código de barras. Em 33 mm as barras não fecham em '
      + 'pontos inteiros da térmica e saem desiguais: se o leitor do caixa falhar, use o rolo de 50 × 30.',
    midia: 'rolo',
    widthMm: 33,
    heightMm: 22,
    columns: 1,
    rows: null,
    gapXmm: 0,
    gapYmm: 0,
    marginTopMm: 1.5,
    marginLeftMm: 1.5,
    // Sem atributos, sem rodapé: em 22 mm de altura, o código de barras precisa
    // de espaço para ser lido, e é ele que faz a etiqueta valer alguma coisa.
    campos: ['nome', 'preco', 'barras', 'ean'],
  },
  {
    id: 'rolo_60x40',
    label: 'Rolo 60 × 40 mm',
    hint: 'Etiqueta grande, com preço em destaque. Boa para caixa e embalagem.',
    midia: 'rolo',
    widthMm: 60,
    heightMm: 40,
    columns: 1,
    rows: null,
    gapXmm: 0,
    gapYmm: 0,
    marginTopMm: 2.5,
    marginLeftMm: 2.5,
    campos: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo', 'empresa'],
  },
  {
    id: 'rolo_100x30_2',
    label: 'Rolo 100 × 30 mm (2 colunas)',
    hint: 'Rolo duplo: sai o dobro de etiqueta por metro de papel.',
    midia: 'rolo',
    widthMm: 48,
    heightMm: 30,
    columns: 2,
    rows: 1,
    gapXmm: 4,
    gapYmm: 0,
    marginTopMm: 2,
    marginLeftMm: 2,
    campos: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo'],
  },
  {
    // O padrão. Ver `FORMATO_PADRAO` abaixo.
    id: 'a4_63x25_3x11',
    label: 'Folha A4 — 33 por folha (63,5 × 25,4 mm)',
    hint: 'Folha adesiva comum (Pimaco A4356 ou equivalente). Sai certo em impressora de escritório, escala 100 %.',
    midia: 'folha',
    widthMm: 63.5,
    heightMm: 25.4,
    columns: 3,
    rows: 11,
    // Passo horizontal de 66,0 mm na ficha = 63,5 de etiqueta + 2,5 de vão.
    gapXmm: 2.5,
    gapYmm: 0,
    marginTopMm: 8.8,
    marginLeftMm: 7.2,
    // A grade entra: sem ela, as variantes P/M/G saíam com etiquetas iguais.
    campos: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo'],
    fonteDasMedidas:
      'Ficha Pimaco A4356 (A4 210 × 297): etiqueta 63,5 × 25,4 mm, 3 colunas × 11 linhas, '
      + 'margem superior 8,8 mm, lateral 7,2 mm, passo horizontal 66,0 mm, passo vertical 25,4 mm.',
  },
  {
    /*
      Id antigo, mantido: é o formato que era o padrão, e modelos da loja e
      pedidos já gravados apontam para ele. A GEOMETRIA sempre foi a da folha
      CARTA (Pimaco 6180 / Avery 5160) — agora com a página Carta de verdade,
      e sem mandar comprar uma folha A4 que não bate.
    */
    id: 'a4_67x25_3x10',
    label: 'Folha Carta — 30 por folha (66,7 × 25,4 mm)',
    hint: 'Folha CARTA (215,9 × 279,4 mm), Pimaco 6180 ou Avery 5160. Não serve para folha A4.',
    midia: 'folha',
    widthMm: 66.68,
    heightMm: 25.4,
    columns: 3,
    rows: 10,
    gapXmm: 3.18,
    gapYmm: 0,
    marginTopMm: 12.7,
    marginLeftMm: 4.76,
    campos: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo'],
    paperWidthMm: 215.9,
    paperHeightMm: 279.4,
    fonteDasMedidas:
      'Ficha Pimaco 6180 / Avery 5160 (Carta 215,9 × 279,4): etiqueta 66,68 × 25,4 mm (2 5/8" × 1"), '
      + '3 × 10, margem superior 12,7 mm (1/2"), lateral 4,76 mm (3/16"), passo horizontal 69,85 mm (2 3/4").',
  },
  {
    // Id antigo, mantido pelo mesmo motivo: a geometria é a da 6181 CARTA.
    id: 'a4_101x25_2x10',
    label: 'Folha Carta — 20 por folha (101,6 × 25,4 mm)',
    hint: 'Folha CARTA larga (215,9 × 279,4 mm), Pimaco 6181 ou Avery 5161. Cabe nome comprido.',
    midia: 'folha',
    widthMm: 101.6,
    heightMm: 25.4,
    columns: 2,
    rows: 10,
    gapXmm: 4.76,
    gapYmm: 0,
    marginTopMm: 12.7,
    marginLeftMm: 3.97,
    campos: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo'],
    paperWidthMm: 215.9,
    paperHeightMm: 279.4,
    fonteDasMedidas:
      'Ficha Pimaco 6181 / Avery 5161 (Carta 215,9 × 279,4): etiqueta 101,6 × 25,4 mm (4" × 1"), '
      + '2 × 10, margem superior 12,7 mm (1/2"), lateral 3,97 mm (5/32"), passo horizontal 106,36 mm (4 3/16").',
  },
  {
    id: 'a4_gondola_2x5',
    label: 'Folha A4 — cartaz de gôndola, 10 por folha (99 × 50 mm)',
    hint: 'Preço grande para a prateleira. Não é adesivo de peça.',
    midia: 'folha',
    widthMm: 99,
    heightMm: 50,
    columns: 2,
    rows: 5,
    gapXmm: 4,
    gapYmm: 4,
    marginTopMm: 15,
    marginLeftMm: 3,
    // Cartaz de gôndola é para o cliente ler de longe: o preço domina e o
    // código de barras não entra — ninguém bipa a prateleira.
    campos: ['nome', 'atributos', 'preco', 'codigo', 'empresa'],
  },
];

/**
 * O formato inicial da tela.
 *
 * É o de folha A4 e não o rolo de 50 × 30, apesar de o rolo ser o layout
 * antigo: quem abre a tela pela primeira vez provavelmente tem uma impressora
 * comum, e é o único caso em que o papel sai no tamanho certo sem configurar
 * nada. Quem tem térmica troca uma vez e segue.
 */
export const FORMATO_PADRAO = 'a4_63x25_3x11';

/**
 * A LARGURA DAS BARRAS — as constantes que a validação do modelo e a folha
 * usam juntas (uma régua só).
 *
 * O EAN-13 ocupa 113 módulos com as zonas de silêncio; a etiqueta deixa 0,6 mm
 * de respiro de cada lado. O módulo abaixo de 0,19 mm (1,5 ponto de uma
 * térmica de 203 dpi) não se imprime com confiança; abaixo de 0,264 mm (80 %
 * do nominal GS1) leitor a laser pode falhar.
 */
export const RESPIRO_LATERAL_MM = 1.2;
export const MODULOS_DO_EAN13 = 113;
export const MODULO_MINIMO_MM = 0.19;
export const MODULO_GS1_MM = 0.264;

export function findLabelFormat(id: string): LabelFormat | undefined {
  return LABEL_FORMATS.find((f) => f.id === id);
}

/** Quantas etiquetas cabem por página. Em rolo é sempre uma "página" por linha. */
/**
 * A GEOMETRIA de uma folha, sem os campos de etiqueta comercial.
 *
 * As cinco funcoes abaixo so leem medida: quantas colunas, que tamanho, que
 * vao, que margem. Nao sabem o que vai dentro da celula.
 *
 * O tipo estreito existe para a PLAQUINHA reusar a mesma matemática sem herdar
 * a lista de "campos" — que fala de preço, código de barras e EAN, e não tem
 * sentido num adesivo colado numa moto. Uma segunda cópia dessas contas
 * divergiria no dia em que uma das duas mudasse, e paginação errada só aparece
 * no papel, depois de gasta a folha adesiva.
 */
export interface SheetGeometry {
  midia: 'rolo' | 'folha';
  widthMm: number;
  heightMm: number;
  columns: number;
  rows: number | null;
  gapXmm: number;
  gapYmm: number;
  marginTopMm: number;
  marginLeftMm: number;
  /** Só nos MODELOS da loja: a largura (e, na folha, a altura) real do papel. */
  paperWidthMm?: number;
  paperHeightMm?: number | null;
}
export function porPagina(f: SheetGeometry): number {
  return f.columns * (f.rows ?? 1);
}

/**
 * A largura ocupada pelas colunas, para conferir que a conta fecha no papel.
 *
 * Existe para o teste: um formato cuja soma de colunas estoura a largura da
 * folha imprime a última coluna cortada, e isso só apareceria no papel.
 */
export function larguraOcupadaMm(f: SheetGeometry): number {
  return f.marginLeftMm + f.columns * f.widthMm + (f.columns - 1) * f.gapXmm;
}

export function alturaOcupadaMm(f: SheetGeometry): number {
  const linhas = f.rows ?? 1;
  return f.marginTopMm + linhas * f.heightMm + (linhas - 1) * f.gapYmm;
}

/**
 * A folha física onde o formato é impresso.
 *
 * Em ROLO a página é exatamente a tira de etiqueta: um rolo de 50 × 30 mm tem
 * página de 50 × 30 mm, e a margem é a área de respeito DENTRO do adesivo, não
 * um acréscimo em volta. Somar a margem ao tamanho da página faria a
 * impressora térmica avançar papel a mais a cada etiqueta e desalinhar o rolo
 * inteiro depois de algumas dezenas.
 */
export function paginaMm(f: SheetGeometry): { largura: number; altura: number } {
  // MODELO da loja: o papel é o que ele declarou (a validação já conferiu que cabe).
  // No rolo, a página continua sendo UMA linha de etiquetas: a altura é a da etiqueta.
  if (f.paperWidthMm) {
    if (f.midia === 'folha') return { largura: f.paperWidthMm, altura: f.paperHeightMm ?? A4_ALTURA };
    return { largura: f.paperWidthMm, altura: f.heightMm };
  }
  if (f.midia === 'folha') return { largura: A4_LARGURA, altura: A4_ALTURA };
  const linhas = f.rows ?? 1;
  return {
    largura: f.columns * f.widthMm + (f.columns - 1) * f.gapXmm,
    altura: linhas * f.heightMm + (linhas - 1) * f.gapYmm,
  };
}

/** A margem só vira recuo da folha em papel A4. Em rolo ela é interna à etiqueta. */
export function recuoDaFolhaMm(f: SheetGeometry): { topo: number; esquerda: number } {
  // No MODELO, a margem esquerda recua a primeira coluna no papel (o liner do
  // rolo tem borda); a de cima só recua na folha — no rolo a página é a etiqueta.
  if (f.paperWidthMm) return { topo: f.midia === 'folha' ? f.marginTopMm : 0, esquerda: f.marginLeftMm };
  return f.midia === 'folha'
    ? { topo: f.marginTopMm, esquerda: f.marginLeftMm }
    : { topo: 0, esquerda: 0 };
}
