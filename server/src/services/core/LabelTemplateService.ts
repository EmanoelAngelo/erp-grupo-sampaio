/**
 * ============================================================================
 * MODELOS DE ETIQUETA — a etiqueta que o gestor desenha, e não o código
 * ============================================================================
 *
 * Os sete formatos de `LabelFormats.ts` eram a única escolha, fixos no código.
 * Cada loja compra o rolo que acha, e a impressora que tem: 40 × 30 em uma
 * coluna, 30 × 20 em duas, gôndola na folha A4. Aqui a loja cadastra os DELA:
 *
 *   - a GEOMETRIA real, em milímetro: papel (largura; altura na folha), a
 *     etiqueta, quantas colunas, o espaço entre elas, as margens;
 *   - o CONTEÚDO: quais campos aparecem (nome, preço, código de barras, código
 *     interno, SKU, marca, unidade, descrição curta, texto próprio), o preço em
 *     destaque ou não, a escala do texto e a orientação;
 *   - a IMPRESSORA preferida — só preferência: o modelo não é a impressora, e o
 *     mesmo modelo pode sair em qualquer outra.
 *
 * ## A conta tem de fechar no papel
 *
 * A última coluna cortada, o preço fora do adesivo e a borda sumida só
 * aparecem no papel, depois de gasto o rolo. Por isso a validação recusa, ANTES
 * de salvar, o modelo cujas colunas não cabem na largura do papel (e, na folha,
 * cujas linhas não cabem na altura) — dizendo quanto sobra ou falta.
 *
 * O desenho reaproveita a folha que já existia (`LabelSheet.ts`): o modelo vira
 * um `LabelFormat` e o resto do caminho é o mesmo dos formatos prontos.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  CAMPOS_DA_ETIQUETA,
  DPIS_DA_IMPRESSORA,
  MODULOS_DO_EAN13,
  MODULO_MINIMO_MM,
  RESPIRO_LATERAL_MM,
  type DpiDaImpressora,
  type LabelField,
  type LabelFormat,
  type ModoDeCorte,
  type SensorDaMidia,
} from './LabelFormats.js';
import { PERFIS_DE_IMPRESSAO, acharPerfil, type IdDoPerfil } from './LabelProfiles.js';

export type Midia = 'rolo' | 'folha';
export type Orientacao = 'retrato' | 'paisagem';

export interface LabelTemplate {
  id: string;
  name: string;
  midia: Midia;
  paperWidthMm: number;
  /** Só na folha. No rolo cada linha de etiquetas é uma página. */
  paperHeightMm: number | null;
  widthMm: number;
  heightMm: number;
  columns: number;
  /** Linhas por folha (calculadas quando não informadas). Nulo no rolo. */
  rows: number | null;
  gapXmm: number;
  gapYmm: number;
  marginTopMm: number;
  marginLeftMm: number;
  orientation: Orientacao;
  scalePercent: number;
  /** Resolução da impressora do modelo: 203, 300 ou 600 dpi (ver `DPIS_DA_IMPRESSORA`). */
  dpi: DpiDaImpressora;
  fields: LabelField[];
  priceHighlight: boolean;
  complementText: string | null;
  printerId: string | null;
  printerName: string | null;
  isDefault: boolean;
  /*
    A SAÍDA E A IMPRESSORA FÍSICA (P0 das etiquetas).

    DEFEITO QUE ISTO CORRIGE: o modelo dizia o papel e o conteúdo, mas não
    como a etiqueta chega à impressora nem o que a faz sair no LUGAR — a
    calibração, a densidade, o corte e o sensor ficavam no driver de cada
    computador, e a saída em ZPL/EPL/TSPL, que não passa por driver nenhum,
    não tinha de onde tirá-los.
  */
  /** Perfil de saída que a tela escolhe por padrão (LabelProfiles). Nulo: o navegador. */
  outputProfile: IdDoPerfil | null;
  /** Calibração em mm (−10 a 10): positivo empurra para a direita / para baixo. */
  offsetXmm: number;
  offsetYmm: number;
  /** Escurecimento 0–30. Nulo: o da impressora. */
  darkness: number | null;
  /** Velocidade em pol/s (1–14). Nula: a da impressora. */
  printSpeed: number | null;
  cutMode: ModoDeCorte;
  mediaType: SensorDaMidia;
  /** Vão (ou marca preta) entre etiquetas do rolo, em mm. Nulo: não informado. */
  mediaGapMm: number | null;
  /** Avanço de papel depois da última etiqueta do lote, em mm. */
  feedAfterMm: number;
  createdAt: string;
  updatedAt: string;
}

export type LabelTemplateInput = Omit<LabelTemplate, 'id' | 'printerName' | 'createdAt' | 'updatedAt'>;

interface Linha {
  id: string;
  name: string;
  midia: string;
  paper_width_mm: number;
  paper_height_mm: number | null;
  width_mm: number;
  height_mm: number;
  colunas: number;
  linhas: number | null;
  gap_x_mm: number;
  gap_y_mm: number;
  margin_top_mm: number;
  margin_left_mm: number;
  orientation: string;
  scale_percent: number;
  /** Nulo só num banco antigo, antes de a reconciliação do esquema criar a coluna. */
  dpi: number | null;
  fields: string;
  price_highlight: number;
  complement_text: string | null;
  printer_id: string | null;
  printer_name: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
  /** As colunas da saída e da impressora física: nulas em banco antigo e em modelo que não as disse. */
  output_profile: string | null;
  offset_x_mm: number | null;
  offset_y_mm: number | null;
  darkness: number | null;
  print_speed: number | null;
  cut_mode: string | null;
  media_type: string | null;
  media_gap_mm: number | null;
  feed_after_mm: number | null;
}

const A4_ALTURA = 297;

const MODOS_DE_CORTE: readonly ModoDeCorte[] = ['nenhum', 'cada_etiqueta', 'fim_do_lote'];
const SENSORES: readonly SensorDaMidia[] = ['vao', 'marca', 'continua'];

/** A linha do banco → os campos da saída e da impressora, com o padrão onde está nulo. */
function impressoraDaLinha(l: Linha) {
  const perfil = acharPerfil(l.output_profile);
  return {
    outputProfile: perfil ? perfil.id : null,
    offsetXmm: l.offset_x_mm ?? 0,
    offsetYmm: l.offset_y_mm ?? 0,
    darkness: l.darkness ?? null,
    printSpeed: l.print_speed ?? null,
    cutMode: MODOS_DE_CORTE.includes(l.cut_mode as ModoDeCorte) ? (l.cut_mode as ModoDeCorte) : 'nenhum',
    mediaType: SENSORES.includes(l.media_type as SensorDaMidia) ? (l.media_type as SensorDaMidia) : 'vao',
    mediaGapMm: l.media_gap_mm ?? null,
    feedAfterMm: l.feed_after_mm ?? 0,
  };
}

function daLinha(l: Linha): LabelTemplate {
  let fields: LabelField[] = [];
  try {
    const lidos = JSON.parse(l.fields) as unknown;
    if (Array.isArray(lidos)) fields = lidos.filter((c): c is LabelField => CAMPOS_DA_ETIQUETA.some((x) => x.id === c));
  } catch {
    fields = ['nome', 'preco', 'barras', 'ean'];
  }
  return {
    id: l.id,
    name: l.name,
    midia: l.midia === 'folha' ? 'folha' : 'rolo',
    paperWidthMm: l.paper_width_mm,
    paperHeightMm: l.paper_height_mm,
    widthMm: l.width_mm,
    heightMm: l.height_mm,
    columns: l.colunas,
    rows: l.linhas,
    gapXmm: l.gap_x_mm,
    gapYmm: l.gap_y_mm,
    marginTopMm: l.margin_top_mm,
    marginLeftMm: l.margin_left_mm,
    orientation: l.orientation === 'paisagem' ? 'paisagem' : 'retrato',
    scalePercent: l.scale_percent,
    // Banco antigo (coluna ainda nula) ou valor fora da lista: o padrão da coluna, 203.
    dpi: ehDpiDaImpressora(l.dpi) ? l.dpi : 203,
    fields,
    priceHighlight: l.price_highlight === 1,
    complementText: l.complement_text,
    printerId: l.printer_id,
    printerName: l.printer_name,
    isDefault: l.is_default === 1,
    ...impressoraDaLinha(l),
    createdAt: l.created_at,
    updatedAt: l.updated_at,
  };
}

const SELECT = `SELECT t.*, p.name AS printer_name
                  FROM core_label_templates t
                  LEFT JOIN core_printers p ON p.id = t.printer_id`;

export function listarModelos(companyId: string): LabelTemplate[] {
  ensureCoreSchema();
  return (getConnection()
    .prepare(`${SELECT} WHERE t.company_id = ? ORDER BY t.is_default DESC, t.name`)
    .all(companyId) as unknown as Linha[]).map(daLinha);
}

export function obterModelo(companyId: string, id: string): LabelTemplate {
  ensureCoreSchema();
  const l = getConnection()
    .prepare(`${SELECT} WHERE t.company_id = ? AND t.id = ?`)
    .get(companyId, id) as Linha | undefined;
  if (!l) throw new ApiError('CORE_LABEL_TEMPLATE_NOT_FOUND', 'Modelo de etiqueta não encontrado.', 404);
  return daLinha(l);
}

function numero(valor: unknown, nome: string, min: number, max: number, padrao?: number): number {
  if ((valor === undefined || valor === null || valor === '') && padrao !== undefined) return padrao;
  const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', `${nome}: informe um valor entre ${min} e ${max}.`, 400, { campo: nome });
  }
  return Math.round(n * 100) / 100;
}

function inteiro(valor: unknown, nome: string, min: number, max: number, padrao?: number): number {
  const n = numero(valor, nome, min, max, padrao);
  if (!Number.isInteger(n)) {
    throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', `${nome}: informe um número inteiro.`, 400, { campo: nome });
  }
  return n;
}

const mm = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Quantas linhas cabem na folha, quando o modelo não disse. */
function linhasQueCabem(alturaDoPapel: number, margemTopo: number, altura: number, vaoY: number): number {
  return Math.max(1, Math.floor((alturaDoPapel - margemTopo + vaoY) / (altura + vaoY)));
}

/** Uma das resoluções que o modelo aceita (203, 300 ou 600 dpi)? */
export function ehDpiDaImpressora(valor: unknown): valor is DpiDaImpressora {
  return typeof valor === 'number' && (DPIS_DA_IMPRESSORA as readonly number[]).includes(valor);
}

/**
 * Confere e normaliza o que veio da tela. Recusa com a frase que diz o que
 * mudar — nunca "dados inválidos".
 *
 * `dpiAtual` é a resolução já gravada, na edição: o pedido que não traz `dpi`
 * (tela antiga aberta) mantém a do modelo, em vez de voltar ao padrão.
 */
export function validarModelo(
  entrada: Record<string, unknown>,
  companyId: string,
  dpiAtual?: DpiDaImpressora,
  /** O modelo gravado, na edição: o campo da impressora que o pedido não traz fica como está. */
  anterior?: LabelTemplate,
): LabelTemplateInput {
  const name = String(entrada.name ?? '').trim();
  if (!name) throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', 'Dê um nome ao modelo (ex.: "Rolo 40 × 30").', 400, { campo: 'nome' });
  if (name.length > 60) throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', 'Nome do modelo: até 60 caracteres.', 400, { campo: 'nome' });
  const midia: Midia = entrada.midia === 'folha' ? 'folha' : 'rolo';
  const orientation: Orientacao = entrada.orientation === 'paisagem' ? 'paisagem' : 'retrato';

  const widthMm = numero(entrada.widthMm, 'Largura da etiqueta (mm)', 10, 300);
  const heightMm = numero(entrada.heightMm, 'Altura da etiqueta (mm)', 8, 300);
  const columns = inteiro(entrada.columns, 'Colunas', 1, 8, 1);
  const gapXmm = numero(entrada.gapXmm, 'Espaço entre colunas (mm)', 0, 30, 0);
  const gapYmm = numero(entrada.gapYmm, 'Espaço entre linhas (mm)', 0, 30, 0);
  const marginTopMm = numero(entrada.marginTopMm, 'Margem superior (mm)', 0, 60, 0);
  const marginLeftMm = numero(entrada.marginLeftMm, 'Margem esquerda (mm)', 0, 60, 0);

  /*
    NO ROLO, A MARGEM DE CIMA É RESPIRO DENTRO DO ADESIVO (vira padding-top da
    etiqueta). Ela ia até 60 mm sem olhar a altura: um rolo de 40 × 20 com
    margem 25 empurrava o conteúdo inteiro para baixo do adesivo — a etiqueta
    e a prévia saíam EM BRANCO, sem mensagem nenhuma. Sobram ao menos 4 mm
    para o conteúdo, ou o modelo é recusado dizendo o teto.
  */
  if (midia === 'rolo' && marginTopMm >= heightMm - 4) {
    throw new ApiError(
      'CORE_LABEL_TEMPLATE_INVALID',
      `Margem superior de ${mm(marginTopMm)} mm numa etiqueta de ${mm(heightMm)} mm de altura: o conteúdo ficaria fora do adesivo `
        + `e a etiqueta sairia em branco. No rolo, use no máximo ${mm(Math.max(0, heightMm - 4.01))} mm.`,
      400,
      { campo: 'Margem superior (mm)' },
    );
  }
  const larguraMinima = marginLeftMm + columns * widthMm + (columns - 1) * gapXmm;
  const paperWidthMm = numero(entrada.paperWidthMm, 'Largura do papel (mm)', 15, 330, Math.ceil(larguraMinima * 100) / 100);

  // A conta que o papel cobra: a última coluna tem de caber inteira.
  if (larguraMinima > paperWidthMm + 0.001) {
    throw new ApiError(
      'CORE_LABEL_TEMPLATE_DOES_NOT_FIT',
      `As ${columns} coluna(s) ocupam ${mm(larguraMinima)} mm (margem ${mm(marginLeftMm)} + ${columns} × ${mm(widthMm)}`
        + `${columns > 1 ? ` + ${columns - 1} × ${mm(gapXmm)} de espaço` : ''}) e o papel tem ${mm(paperWidthMm)} mm: `
        + 'a última coluna sairia cortada. Diminua a largura, o espaço ou a margem — ou aumente o papel.',
      400,
      { larguraOcupadaMm: larguraMinima, larguraDoPapelMm: paperWidthMm },
    );
  }

  let paperHeightMm: number | null = null;
  let rows: number | null = null;
  if (midia === 'folha') {
    paperHeightMm = numero(entrada.paperHeightMm, 'Altura do papel (mm)', 30, 450, A4_ALTURA);
    const cabem = linhasQueCabem(paperHeightMm, marginTopMm, heightMm, gapYmm);
    rows = inteiro(entrada.rows, 'Linhas por folha', 1, 60, cabem);
    const alturaOcupada = marginTopMm + rows * heightMm + (rows - 1) * gapYmm;
    if (alturaOcupada > paperHeightMm + 0.001) {
      throw new ApiError(
        'CORE_LABEL_TEMPLATE_DOES_NOT_FIT',
        `As ${rows} linha(s) ocupam ${mm(alturaOcupada)} mm e a folha tem ${mm(paperHeightMm)} mm: a última linha `
          + `sairia cortada. Cabem ${cabem} linha(s) com estas medidas.`,
        400,
        { alturaOcupadaMm: alturaOcupada, alturaDoPapelMm: paperHeightMm },
      );
    }
  }

  const permitidos = new Set(CAMPOS_DA_ETIQUETA.map((c) => c.id));
  const brutos = Array.isArray(entrada.fields) ? entrada.fields.map(String) : [];
  const fields = [...new Set(brutos)].filter((c): c is LabelField => permitidos.has(c as LabelField));
  if (fields.length === 0) {
    throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', 'Escolha ao menos um campo para aparecer na etiqueta.', 400, { campo: 'campos' });
  }

  /*
    O CÓDIGO DE BARRAS PRECISA DE LARGURA.

    A validação aceitava etiqueta de 10 a 12 mm com "Código de barras"
    marcado: o EAN-13 tem 113 módulos (com as zonas de silêncio), e em 12 mm
    cada barra ficava com 0,096 mm — menos que um ponto de uma térmica de 203
    dpi (0,125 mm). O desenho era impossível de imprimir, e a prévia mostrava
    barras bonitas. Abaixo de 0,19 mm por módulo (1,5 ponto a 203 dpi) o
    modelo é recusado dizendo a largura mínima; entre 0,19 e o mínimo GS1
    (0,264 mm) ele passa, com o aviso na prévia e no salvar.

    Em paisagem as barras correm no lado CURTO do adesivo — é ele que conta.
  */
  if (fields.includes('barras')) {
    const larguraDasBarras = orientation === 'paisagem' ? heightMm : widthMm;
    const modulo = (larguraDasBarras - RESPIRO_LATERAL_MM) / MODULOS_DO_EAN13;
    if (modulo < MODULO_MINIMO_MM) {
      const minima = Math.ceil((MODULO_MINIMO_MM * MODULOS_DO_EAN13 + RESPIRO_LATERAL_MM) * 10) / 10;
      throw new ApiError(
        'CORE_LABEL_TEMPLATE_BARCODE_TOO_NARROW',
        `Com ${mm(larguraDasBarras)} mm de ${orientation === 'paisagem' ? 'altura (em paisagem as barras correm na altura)' : 'largura'}, `
          + `cada barra do código ficaria com ${mm(Math.round(modulo * 1000) / 1000)} mm — menos do que a impressora consegue marcar. `
          + `Para o código de barras, a etiqueta precisa de ao menos ${mm(minima)} mm; ou desmarque "Código de barras (desenho)".`,
        400,
        { campo: 'campos', larguraMinimaMm: minima },
      );
    }
  }
  /*
    A RESOLUÇÃO DA IMPRESSORA DO MODELO.

    DEFEITO QUE ISTO CORRIGE: a coluna `dpi` existia no esquema, mas o modelo
    não a lia nem gravava — a folha arredondava o módulo das barras para 203
    dpi em todo rolo e 300 em toda folha, fosse qual fosse a impressora. Só
    203, 300 e 600 existem em impressora de etiqueta e de escritório; outro
    número é engano de digitação e vira recusa, dizendo onde achar o certo.
    Sem valor: na edição, o que já estava gravado; no modelo novo, o palpite
    pela mídia (203 no rolo, 300 na folha), que era o comportamento de antes.
  */
  let dpi: DpiDaImpressora;
  if (entrada.dpi === undefined || entrada.dpi === null || entrada.dpi === '') {
    dpi = dpiAtual ?? (midia === 'folha' ? 300 : 203);
  } else {
    const lido = typeof entrada.dpi === 'number' ? entrada.dpi : Number(String(entrada.dpi).trim());
    if (!ehDpiDaImpressora(lido)) {
      throw new ApiError(
        'CORE_LABEL_TEMPLATE_INVALID',
        `Resolução da impressora (dpi): "${String(entrada.dpi)}" não é uma resolução de impressora de etiqueta. `
          + 'Escolha 203, 300 ou 600 — o número está na etiqueta embaixo da impressora ou no manual dela.',
        400,
        { campo: 'Resolução da impressora (dpi)', aceitos: [...DPIS_DA_IMPRESSORA] },
      );
    }
    dpi = lido;
  }

  const complementText = String(entrada.complementText ?? '').trim() || null;
  if (fields.includes('complemento') && !complementText) {
    throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', 'O campo "Texto próprio" está marcado: escreva o texto.', 400, { campo: 'complemento' });
  }
  if (complementText && complementText.length > 80) {
    throw new ApiError('CORE_LABEL_TEMPLATE_INVALID', 'Texto próprio: até 80 caracteres.', 400, { campo: 'complemento' });
  }

  const printerId = String(entrada.printerId ?? '').trim() || null;
  if (printerId) {
    const impressora = getConnection()
      .prepare('SELECT id FROM core_printers WHERE id = ? AND company_id = ?')
      .get(printerId, companyId);
    if (!impressora) throw new ApiError('CORE_PRINTER_NOT_FOUND', 'A impressora escolhida não é desta operação.', 400);
  }

  return {
    name,
    midia,
    paperWidthMm,
    paperHeightMm,
    widthMm,
    heightMm,
    columns,
    rows,
    gapXmm,
    gapYmm: midia === 'folha' ? gapYmm : 0,
    marginTopMm,
    marginLeftMm,
    orientation,
    scalePercent: inteiro(entrada.scalePercent, 'Escala do texto (%)', 50, 200, 100),
    dpi,
    fields,
    priceHighlight: entrada.priceHighlight !== false,
    complementText,
    printerId,
    isDefault: entrada.isDefault === true,
    ...validarImpressoraDoModelo(entrada, midia, anterior),
  };
}

/**
 * A SAÍDA PADRÃO, A CALIBRAÇÃO E OS AJUSTES DA TÉRMICA do modelo.
 *
 * O pedido que NÃO traz um campo (tela antiga aberta) mantém o valor gravado —
 * o mesmo cuidado do dpi: uma tela sem o campo não pode zerar a calibração que
 * alguém acertou na impressora. Valor fora da faixa é recusado dizendo o
 * campo e o que vale.
 */
function validarImpressoraDoModelo(entrada: Record<string, unknown>, midia: Midia, anterior?: LabelTemplate) {
  const veio = (chave: string) => entrada[chave] !== undefined;
  const opcional = (valor: unknown, nome: string, min: number, max: number, soInteiro = false): number | null => {
    if (valor === null || valor === undefined || valor === '') return null;
    return soInteiro ? inteiro(valor, nome, min, max) : numero(valor, nome, min, max);
  };
  const escolha = <T extends string>(chave: string, nome: string, aceitos: readonly T[], padrao: T, atual?: T): T => {
    if (!veio(chave)) return atual ?? padrao;
    const v = entrada[chave];
    if (v === null || v === '') return padrao;
    if (!aceitos.includes(String(v) as T)) {
      throw new ApiError(
        'CORE_LABEL_TEMPLATE_INVALID',
        `${nome}: "${String(v)}" não é uma das opções (${aceitos.join(', ')}).`,
        400,
        { campo: nome, aceitos: [...aceitos] },
      );
    }
    return String(v) as T;
  };

  let outputProfile: IdDoPerfil | null = veio('outputProfile') ? null : anterior?.outputProfile ?? null;
  if (veio('outputProfile') && entrada.outputProfile !== null && entrada.outputProfile !== '') {
    const p = acharPerfil(String(entrada.outputProfile));
    if (!p) {
      throw new ApiError(
        'CORE_LABEL_TEMPLATE_INVALID',
        `Saída padrão: "${String(entrada.outputProfile)}" não é uma saída de impressão. Escolha uma de: `
          + `${PERFIS_DE_IMPRESSAO.map((x) => x.rotulo).join(', ')}.`,
        400,
        { campo: 'Saída padrão', aceitos: PERFIS_DE_IMPRESSAO.map((x) => x.id) },
      );
    }
    outputProfile = p.id;
  }
  // A combinação final (inclusive a saída mantida de antes com a mídia que mudou agora).
  const perfil = acharPerfil(outputProfile);
  if (perfil && !perfil.aceitaFolha && midia === 'folha') {
    throw new ApiError(
      'CORE_LABEL_TEMPLATE_INVALID',
      `A saída "${perfil.rotulo}" é de impressora térmica de rolo e não imprime folha. Para folha A4/Carta, use `
        + 'Navegador, Driver da impressora ou PDF — ou mude o modelo para rolo.',
      400,
      { campo: 'Saída padrão' },
    );
  }

  return {
    outputProfile,
    offsetXmm: veio('offsetXmm') ? numero(entrada.offsetXmm, 'Deslocamento horizontal (mm)', -10, 10, 0) : anterior?.offsetXmm ?? 0,
    offsetYmm: veio('offsetYmm') ? numero(entrada.offsetYmm, 'Deslocamento vertical (mm)', -10, 10, 0) : anterior?.offsetYmm ?? 0,
    darkness: veio('darkness') ? opcional(entrada.darkness, 'Densidade (0 a 30)', 0, 30, true) : anterior?.darkness ?? null,
    printSpeed: veio('printSpeed') ? opcional(entrada.printSpeed, 'Velocidade (pol/s)', 1, 14, true) : anterior?.printSpeed ?? null,
    cutMode: escolha<ModoDeCorte>('cutMode', 'Corte', MODOS_DE_CORTE, 'nenhum', anterior?.cutMode),
    mediaType: escolha<SensorDaMidia>('mediaType', 'Sensor da mídia', SENSORES, 'vao', anterior?.mediaType),
    mediaGapMm: veio('mediaGapMm') ? opcional(entrada.mediaGapMm, 'Vão entre as etiquetas do rolo (mm)', 0, 20) : anterior?.mediaGapMm ?? null,
    feedAfterMm: veio('feedAfterMm') ? numero(entrada.feedAfterMm, 'Avanço ao fim do lote (mm)', 0, 100, 0) : anterior?.feedAfterMm ?? 0,
  };
}

function gravar(companyId: string, id: string, m: LabelTemplateInput, agora: string, userId: string | null, novo: boolean) {
  const db = getConnection();
  if (m.isDefault) db.prepare('UPDATE core_label_templates SET is_default = 0 WHERE company_id = ? AND id <> ?').run(companyId, id);
  const valores = [
    m.name, m.midia, m.paperWidthMm, m.paperHeightMm, m.widthMm, m.heightMm, m.columns, m.rows,
    m.gapXmm, m.gapYmm, m.marginTopMm, m.marginLeftMm, m.orientation, m.scalePercent, m.dpi,
    JSON.stringify(m.fields), m.priceHighlight ? 1 : 0, m.complementText, m.printerId, m.isDefault ? 1 : 0,
    // A saída e a impressora física (P0 das etiquetas).
    m.outputProfile, m.offsetXmm, m.offsetYmm, m.darkness, m.printSpeed, m.cutMode, m.mediaType, m.mediaGapMm, m.feedAfterMm,
  ];
  try {
    if (novo) {
      db.prepare(
        `INSERT INTO core_label_templates
           (id, company_id, name, midia, paper_width_mm, paper_height_mm, width_mm, height_mm, colunas, linhas,
            gap_x_mm, gap_y_mm, margin_top_mm, margin_left_mm, orientation, scale_percent, dpi, fields, price_highlight,
            complement_text, printer_id, is_default,
            output_profile, offset_x_mm, offset_y_mm, darkness, print_speed, cut_mode, media_type, media_gap_mm, feed_after_mm,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, companyId, ...valores, userId, agora, agora);
    } else {
      db.prepare(
        `UPDATE core_label_templates
            SET name = ?, midia = ?, paper_width_mm = ?, paper_height_mm = ?, width_mm = ?, height_mm = ?,
                colunas = ?, linhas = ?, gap_x_mm = ?, gap_y_mm = ?, margin_top_mm = ?, margin_left_mm = ?,
                orientation = ?, scale_percent = ?, dpi = ?, fields = ?, price_highlight = ?, complement_text = ?,
                printer_id = ?, is_default = ?,
                output_profile = ?, offset_x_mm = ?, offset_y_mm = ?, darkness = ?, print_speed = ?, cut_mode = ?,
                media_type = ?, media_gap_mm = ?, feed_after_mm = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(...valores, agora, id, companyId);
    }
  } catch (err) {
    if (/UNIQUE constraint failed: core_label_templates/.test(String((err as Error).message))) {
      throw new ApiError('CORE_LABEL_TEMPLATE_NAME_TAKEN', `Já existe um modelo chamado "${m.name}".`, 409);
    }
    throw err;
  }
}

export function criarModelo(companyId: string, userId: string | null, entrada: Record<string, unknown>): LabelTemplate {
  ensureCoreSchema();
  const m = validarModelo(entrada, companyId);
  const id = randomUUID();
  withTransaction(() => gravar(companyId, id, m, new Date().toISOString(), userId, true));
  return obterModelo(companyId, id);
}

export function atualizarModelo(companyId: string, id: string, entrada: Record<string, unknown>): LabelTemplate {
  ensureCoreSchema();
  const atual = obterModelo(companyId, id);
  // O pedido sem `dpi` (tela antiga) mantém a resolução gravada — e o mesmo
  // vale para a saída, a calibração e os ajustes da térmica.
  const m = validarModelo(entrada, companyId, atual.dpi, atual);
  withTransaction(() => gravar(companyId, id, m, new Date().toISOString(), null, false));
  return obterModelo(companyId, id);
}

export function excluirModelo(companyId: string, id: string): { id: string; name: string } {
  ensureCoreSchema();
  const m = obterModelo(companyId, id);
  getConnection().prepare('DELETE FROM core_label_templates WHERE id = ? AND company_id = ?').run(id, companyId);
  return { id, name: m.name };
}

/**
 * O modelo como GEOMETRIA da folha — a mesma estrutura dos formatos prontos,
 * com o que só o modelo tem (papel, orientação, escala, destaque do preço).
 */
export function formatoDoModelo(m: LabelTemplateInput & { id?: string }): LabelFormat {
  return {
    id: m.id ? `modelo:${m.id}` : 'modelo:rascunho',
    label: m.name,
    hint: '',
    midia: m.midia,
    widthMm: m.widthMm,
    heightMm: m.heightMm,
    columns: m.columns,
    rows: m.midia === 'folha' ? m.rows : null,
    gapXmm: m.gapXmm,
    gapYmm: m.midia === 'folha' ? m.gapYmm : 0,
    marginTopMm: m.marginTopMm,
    marginLeftMm: m.marginLeftMm,
    campos: m.fields,
    paperWidthMm: m.paperWidthMm,
    paperHeightMm: m.midia === 'folha' ? (m.paperHeightMm ?? A4_ALTURA) : null,
    orientation: m.orientation,
    scalePercent: m.scalePercent,
    // A folha arredonda o módulo das barras para os pontos DESTA impressora.
    dpi: m.dpi,
    priceHighlight: m.priceHighlight,
    complementText: m.complementText,
  };
}
