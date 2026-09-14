/**
 * As geometrias da PLAQUINHA — catálogo próprio, e não os formatos de produto.
 *
 * ## Por que separado
 *
 * `LabelFormats` tem sete geometrias de etiqueta comercial, com campos como
 * preço, código de barras e EAN. Pôr a plaquinha lá faria a tela de etiqueta de
 * produto passar a oferecer "Plaquinha 50 × 25" para etiquetar camiseta, e a de
 * plaquinha oferecer "preço" para uma moto que não está à venda.
 *
 * A CASCA da folha é compartilhada (`SheetLayout`): paginação, `@page` em
 * milímetro e recuo são os mesmos. O que muda é a geometria e o conteúdo da
 * célula.
 *
 * ## O piso físico do módulo, e por que ele manda
 *
 * Um QR não é um desenho que encolhe: abaixo de meio milímetro por módulo, a
 * câmera de celular comum começa a errar, e correção de erro não recupera o que
 * a lente não resolveu. Por isso o tamanho do QR aqui não sai de uma proporção
 * bonita — sai do que sobra depois de reservar a folga de corte, conferido
 * contra o piso.
 */
import { desenharQr, type NivelQr } from './Qr.js';

export interface EquipmentTagFormat {
  id: string;
  label: string;
  hint: string;
  midia: 'rolo' | 'folha';
  widthMm: number;
  heightMm: number;
  columns: number;
  rows: number | null;
  gapXmm: number;
  gapYmm: number;
  marginTopMm: number;
  marginLeftMm: number;
  /**
   * Correção de erro do QR deste formato.
   *
   * A plaquinha de pátio nasce em `Q` (~25%): moto pega sol, poeira e
   * combustível, e um vinco no adesivo tira mais do símbolo do que sujeira
   * tira. O rolo térmico fica em `M` porque ali o espaço é menor e subir o
   * nível encolheria o módulo abaixo do piso — trocar legibilidade de perto
   * por tolerância a dano seria perder as duas.
   */
  nivelQr: NivelQr;
  /**
   * A folha é recortada à tesoura? Então precisa de fio de corte e de folga.
   *
   * Folha die-cut (a que já vem vincada de fábrica) usa gap zero de propósito:
   * o corte veio pronto. Reaproveitar essa geometria para recorte manual
   * colocaria a linha da tesoura em cima da zona de silêncio do QR.
   */
  recorteManual: boolean;
}

/** Folga física entre o desenho e a linha de corte, por lado. */
export const SEGURANCA_DE_CORTE_MM = 2;

/**
 * Menor módulo que um celular comum ainda lê com confiança.
 *
 * Não é número escolhido por gosto: abaixo disso o antialias da impressora e a
 * resolução da câmera passam a competir com o tamanho do módulo.
 */
export const MODULO_MINIMO_MM = 0.5;

export const EQUIPMENT_TAG_FORMATS: EquipmentTagFormat[] = [
  {
    /*
      A geometria que a fila de impressão já usa. Fica em primeiro por ser a
      conhecida — quem já imprime plaquinha reconhece o resultado.

      ELA É APERTADA, E ISSO É FATO MEDIDO, NÃO OPINIÃO. Com 25 mm de altura
      menos a margem interna, sobram 20 mm para o símbolo — e o módulo fica
      abaixo do piso de meio milímetro. O sistema NÃO esconde isso: a resposta
      da folha traz `abaixoDoPiso`, e a tela avisa antes de gastar adesivo.

      Por que continua no catálogo mesmo assim: é o que a oficina já imprime
      hoje, na térmica que ela tem, e funciona no dia a dia — o piso é o ponto
      em que a leitura começa a ficar sensível a câmera ruim e luz fraca, não
      um ponto de falha. Trocar a impressora é decisão do dono; esconder a
      medida seria decisão nossa.
    */
    id: 'plaq_rolo_50x25',
    label: 'Rolo 50 × 25 mm',
    hint: 'A plaquinha de sempre. Impressora térmica, uma por vez.',
    midia: 'rolo',
    widthMm: 50,
    heightMm: 25,
    columns: 1,
    rows: null,
    gapXmm: 0,
    gapYmm: 0,
    // Em rolo a margem é INTERNA à etiqueta: a casca não a aplica como recuo
    // de folha, então a célula a reproduz como padding.
    marginTopMm: 2,
    marginLeftMm: 2,
    nivelQr: 'M',
    recorteManual: false,
  },
  {
    /*
      O formato de trabalho: três colunas, com folga para tesoura.

      Duas colunas de 101,6 mm foi a primeira ideia e desperdiça quase metade
      do adesivo — o conteúdo da plaquinha ocupa ~45 mm, e o resto sai em
      branco. Três colunas de 66,7 mm cabem o mesmo desenho e aproveitam a
      folha.

      Os vãos de 4 mm existem para a tesoura: com gap zero, a linha de corte é
      a fronteira compartilhada por duas células, e o erro humano de ±1 mm come
      a zona de silêncio do QR vizinho.
    */
    id: 'plaq_a4_63x33_3col',
    label: 'Folha A4 — 21 por folha (63 × 33 mm)',
    hint: 'Folha adesiva comum, para recortar. Vãos de 4 mm e fio de corte.',
    midia: 'folha',
    /*
      A ALTURA SAI DO QR, e não do gosto.

      A primeira tentativa foi 66,7 × 25,4 — a medida da etiqueta comercial de
      três colunas. Duas contas a derrubaram, e as duas só apareceram porque o
      teste é geométrico:

      1. LARGURA: 4,6 + 3×66,7 + 2×4 = 212,7 mm num papel de 210. A última
         coluna sairia cortada, e isso só se descobre no papel.
      2. MÓDULO: com 25,4 mm de altura menos 4 mm de folga de corte, sobram
         21,4 mm para um símbolo de 49 unidades — 0,44 mm por módulo, abaixo do
         que a câmera de celular comum resolve.

      63 × 33 resolve as duas: 5 + 3×63 + 2×4 = 202 mm de largura, e 29 mm
      úteis de altura dão 0,58 mm por módulo.
    */
    widthMm: 63,
    heightMm: 33,
    columns: 3,
    rows: 7,
    gapXmm: 4,
    gapYmm: 4,
    marginTopMm: 12.7,
    marginLeftMm: 5,
    nivelQr: 'Q',
    recorteManual: true,
  },
  {
    /*
      A grande, para moto que fica meses no pátio.

      Mais milímetro por módulo é mais leitura de longe e mais tolerância a
      adesivo descascando na beirada.
    */
    id: 'plaq_a4_95x50_2col',
    label: 'Folha A4 — 10 por folha (95 × 50 mm)',
    hint: 'Plaquinha grande, para equipamento que fica muito tempo no pátio.',
    midia: 'folha',
    // 4 + 2×95 + 6 = 200 mm. Sobram 10 mm, e a folga importa: laser e jato de
    // tinta têm ~4 mm de área não imprimível por lado, e encostar na borda faz
    // o navegador REDUZIR a página inteira para caber — o que muda todas as
    // medidas em milímetro de uma vez.
    widthMm: 95,
    heightMm: 50,
    columns: 2,
    rows: 5,
    gapXmm: 6,
    gapYmm: 6,
    marginTopMm: 15,
    marginLeftMm: 4,
    nivelQr: 'Q',
    recorteManual: true,
  },
];

export function equipmentTagFormat(id: string | undefined): EquipmentTagFormat {
  return (
    EQUIPMENT_TAG_FORMATS.find((f) => f.id === id) ?? EQUIPMENT_TAG_FORMATS[1]!
  );
}

/** O id do formato que segue os milímetros do layout da empresa (rodada 53). */
export const FORMATO_PERSONALIZADO = 'plaq_personalizado';

/**
 * A GEOMETRIA DO TAMANHO ESCOLHIDO PELA EMPRESA.
 *
 * O editor de layout oferece largura, altura e margem em milímetro — como o
 * sistema anterior — e o catálogo de formatos decide onde a plaquinha cai na
 * folha. Enquanto os dois não se conversavam, o editor prometia 100 × 40 mm e
 * o papel saía com os 63 × 33 do formato escolhido: duas verdades sobre a
 * mesma etiqueta, e a divergência só aparecia na impressora.
 *
 * Aqui o tamanho do layout vira um formato de verdade: as colunas e as linhas
 * são CALCULADAS para caber no A4 com a folga de corte, e o QR passa pela
 * mesma conta de módulo dos outros três — o dono escolhe o milímetro, e o
 * sistema diz se aquele milímetro ainda dá um código legível.
 */
export function formatoDoLayout(layout: {
  widthMm: number;
  heightMm: number;
  marginMm: number;
}): EquipmentTagFormat {
  const gap = 4;
  const margemEsquerda = 5;
  const margemTopo = 12.7;
  // A4 útil, descontadas as margens da folha e a área não imprimível.
  const largura = 210 - margemEsquerda * 2;
  const altura = 297 - margemTopo - 10;
  const columns = Math.max(1, Math.floor((largura + gap) / (layout.widthMm + gap)));
  const rows = Math.max(1, Math.floor((altura + gap) / (layout.heightMm + gap)));

  return {
    id: FORMATO_PERSONALIZADO,
    label: `Personalizado — ${layout.widthMm} × ${layout.heightMm} mm`,
    hint: 'O tamanho definido no editor de layout desta operação.',
    midia: 'folha',
    widthMm: layout.widthMm,
    heightMm: layout.heightMm,
    columns,
    rows,
    gapXmm: gap,
    gapYmm: gap,
    marginTopMm: margemTopo,
    marginLeftMm: margemEsquerda,
    // Plaquinha de pátio: sol, poeira e vinco tiram pedaço do símbolo.
    nivelQr: 'Q',
    recorteManual: true,
  };
}

export interface EscalaDaPlaquinha {
  qrMm: number;
  moduloMm: number;
  modulos: number;
  /** Abaixo do piso: o QR sai, mas com aviso — quem imprime precisa saber. */
  abaixoDoPiso: boolean;
}

/**
 * Quanto o QR pode medir neste formato, com este conteúdo.
 *
 * A contagem de módulos vem do QR DE VERDADE, e não de um número assumido: a
 * mesma plaquinha com um domínio mais longo sobe de versão, ganha módulos e
 * encolhe cada um deles. Assumir 37 daria um número certo hoje e errado no dia
 * em que o endereço público mudasse — em silêncio, num adesivo já colado.
 */
export function escalaDaPlaquinha(
  formato: EquipmentTagFormat,
  conteudo: string,
): EscalaDaPlaquinha {
  const { modulos, lado } = desenharQr(conteudo, { nivel: formato.nivelQr });

  // O espaço vertical útil é a altura menos a folga de corte dos dois lados —
  // e, no rolo, menos a margem interna, que a casca não aplica.
  const margemInterna = formato.midia === 'rolo' ? formato.marginTopMm * 2 : 0;
  const folga = formato.recorteManual ? SEGURANCA_DE_CORTE_MM * 2 : 1;
  const alturaUtil = formato.heightMm - folga - margemInterna;

  // Nunca mais que 45% da largura: o resto é do #000N e do modelo, que são o
  // resgate humano quando o QR não lê.
  const qrMm = Math.min(alturaUtil, formato.widthMm * 0.45);
  const moduloMm = qrMm / lado;

  return {
    qrMm: Number(qrMm.toFixed(2)),
    moduloMm: Number(moduloMm.toFixed(3)),
    modulos,
    abaixoDoPiso: moduloMm < MODULO_MINIMO_MM,
  };
}
