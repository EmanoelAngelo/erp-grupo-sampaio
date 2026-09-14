/**
 * Arquivo de produtos para a balança.
 *
 * Balança de varejo (Toledo, Urano, Filizola) não conversa com o ERP: ela
 * importa um arquivo de texto com a lista de produtos pesáveis. Cada marca tem
 * o seu layout.
 *
 * ## O que eu sei e o que eu NÃO sei
 *
 * As regras COMUNS às três eu conheço e estão aplicadas aqui: uma linha por
 * item, texto sem acento, preço em centavos inteiros sem separador, descrição
 * truncada na largura do campo, e o código de barras NÃO vai no arquivo —
 * a balança compõe o EAN-13 sozinha, a partir do prefixo dela mais o PLU mais
 * o peso ou o preço.
 *
 * O que eu NÃO tenho como confirmar são os OFFSETS EXATOS de cada marca. Por
 * isso cada layout é uma TABELA DE CAMPOS declarada — corrigir uma largura é
 * mudar um número — e os três layouts de marca vêm marcados
 * `confirmado: false`. Publicar um layout inventado como se estivesse certo
 * produz um arquivo que a balança recusa sem explicar, e quem leva a culpa é
 * o sistema.
 *
 * O layout `csv_generico` vem marcado `confirmado: true` porque é o único que
 * este código controla de ponta a ponta: o software da balança normalmente
 * deixa mapear coluna de CSV na mão.
 *
 * ## Como confirmar de vez
 *
 * O caminho curto não é adivinhar: é exportar um arquivo PELA balança que já
 * está na loja, com dois ou três produtos cadastrados, e ler onde cada campo
 * cai. Um arquivo desses resolve o layout da marca inteira.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export type ScaleFieldKey =
  | 'plu'
  | 'tipo'
  | 'preco'
  | 'descricao'
  | 'validade'
  | 'tara'
  | 'departamento';

export interface ScaleField {
  key: ScaleFieldKey;
  /** Largura em caracteres. Em layout delimitado serve de limite, não de padding. */
  width: number;
  /** Para onde o preenchimento vai quando o valor é mais curto que o campo. */
  pad: 'left' | 'right';
  fill: '0' | ' ';
}

export interface ScaleFormat {
  id: string;
  label: string;
  /** Nome sugerido do arquivo, que muitas balanças exigem exato. */
  filename: string;
  /** Nulo em layout de largura fixa. */
  delimiter: string | null;
  /** Cabeçalho, quando o layout tem. */
  header: string | null;
  fields: ScaleField[];
  /**
   * O layout foi conferido contra equipamento real?
   *
   * Nenhum dos três de marca foi. Ver o cabeçalho deste arquivo.
   */
  confirmado: boolean;
  observacao: string;
}

export const SCALE_FORMATS: ScaleFormat[] = [
  {
    id: 'csv_generico',
    label: 'CSV genérico (recomendado)',
    filename: 'produtos-balanca.csv',
    delimiter: ';',
    header: 'PLU;DESCRICAO;TIPO;PRECO;VALIDADE;TARA',
    fields: [
      { key: 'plu', width: 6, pad: 'left', fill: '0' },
      { key: 'descricao', width: 40, pad: 'right', fill: ' ' },
      { key: 'tipo', width: 1, pad: 'left', fill: '0' },
      { key: 'preco', width: 8, pad: 'left', fill: '0' },
      { key: 'validade', width: 3, pad: 'left', fill: '0' },
      { key: 'tara', width: 5, pad: 'left', fill: '0' },
    ],
    confirmado: true,
    observacao:
      'Colunas separadas por ponto-e-vírgula, com cabeçalho. O software da balança costuma deixar você apontar qual coluna é qual.',
  },
  {
    id: 'toledo_mgv',
    label: 'Toledo (MGV) — layout não confirmado',
    filename: 'ITENSMGV.TXT',
    delimiter: null,
    header: null,
    fields: [
      { key: 'plu', width: 6, pad: 'left', fill: '0' },
      { key: 'tipo', width: 1, pad: 'left', fill: '0' },
      { key: 'preco', width: 6, pad: 'left', fill: '0' },
      { key: 'validade', width: 3, pad: 'left', fill: '0' },
      { key: 'descricao', width: 22, pad: 'right', fill: ' ' },
      { key: 'tara', width: 5, pad: 'left', fill: '0' },
    ],
    confirmado: false,
    observacao:
      'Largura fixa, sem separador. As larguras aqui são a melhor aproximação e NÃO foram testadas numa Toledo real.',
  },
  {
    id: 'urano',
    label: 'Urano (Integra) — layout não confirmado',
    filename: 'PRODUTOS.TXT',
    delimiter: null,
    header: null,
    fields: [
      { key: 'plu', width: 6, pad: 'left', fill: '0' },
      { key: 'descricao', width: 25, pad: 'right', fill: ' ' },
      { key: 'preco', width: 7, pad: 'left', fill: '0' },
      { key: 'tipo', width: 1, pad: 'left', fill: '0' },
      { key: 'validade', width: 3, pad: 'left', fill: '0' },
      { key: 'tara', width: 5, pad: 'left', fill: '0' },
    ],
    confirmado: false,
    observacao:
      'Largura fixa. As larguras aqui são a melhor aproximação e NÃO foram testadas numa Urano real.',
  },
  {
    id: 'filizola',
    label: 'Filizola — layout não confirmado',
    filename: 'ITENS.TXT',
    delimiter: null,
    header: null,
    fields: [
      { key: 'plu', width: 6, pad: 'left', fill: '0' },
      { key: 'tipo', width: 1, pad: 'left', fill: '0' },
      { key: 'descricao', width: 30, pad: 'right', fill: ' ' },
      { key: 'preco', width: 8, pad: 'left', fill: '0' },
      { key: 'validade', width: 3, pad: 'left', fill: '0' },
      { key: 'tara', width: 5, pad: 'left', fill: '0' },
      { key: 'departamento', width: 2, pad: 'left', fill: '0' },
    ],
    confirmado: false,
    observacao:
      'Largura fixa. As larguras aqui são a melhor aproximação e NÃO foram testadas numa Filizola real.',
  },
];

export function findScaleFormat(id: string): ScaleFormat | undefined {
  return SCALE_FORMATS.find((f) => f.id === id);
}

/**
 * Balança é equipamento antigo: acento vira caractere ilegível no visor e na
 * etiqueta. "Melancia Bandeja" tem de sair sem cedilha e sem til.
 */
export function semAcento(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .toUpperCase();
}

function preencher(valor: string, campo: ScaleField): string {
  const corte = valor.slice(0, campo.width);
  if (corte.length === campo.width) return corte;
  const falta = campo.fill.repeat(campo.width - corte.length);
  return campo.pad === 'left' ? falta + corte : corte + falta;
}

export interface ScaleExportItem {
  productId: string;
  name: string;
  pluCode: string | null;
  priceCents: number;
  /** Inteiro 0/1, como o SQLite guarda — converter aqui esconderia a origem. */
  weighable: number;
  tareGrams: number | null;
}

export interface ScaleExportResult {
  filename: string;
  content: string;
  lineCount: number;
  confirmado: boolean;
  /** O que ficou de fora, com o motivo escrito — nunca sumir com item. */
  skipped: { productId: string; name: string; reason: string }[];
}

/**
 * Monta o arquivo.
 *
 * Só entra produto pesável, com PLU e ativo. Todo o resto vai para `skipped`
 * com o motivo em português: um arquivo com 4 linhas quando a pessoa esperava
 * 40 precisa se explicar sozinho.
 */
export function buildScaleFile(
  companyId: string,
  input: { formatId: string; productIds?: string[] },
): ScaleExportResult {
  ensureCoreSchema();
  const formato = findScaleFormat(input.formatId);
  if (!formato) {
    throw new ApiError('CORE_SCALE_FORMAT_UNKNOWN', 'Formato de balança desconhecido.', 400);
  }

  const db = getConnection();
  const filtroIds =
    input.productIds && input.productIds.length > 0
      ? ` AND id IN (${input.productIds.map(() => '?').join(',')})`
      : '';
  const linhas = db
    .prepare(
      `SELECT id AS productId, name, plu_code AS pluCode, price_cents AS priceCents,
              weighable, tare_grams AS tareGrams, active
         FROM core_products
        WHERE company_id = ?${filtroIds}
        ORDER BY plu_code, name COLLATE NOCASE`,
    )
    .all(companyId, ...(input.productIds ?? [])) as unknown as (ScaleExportItem & {
    active: number;
  })[];

  const skipped: ScaleExportResult['skipped'] = [];
  const saida: string[] = [];
  if (formato.header) saida.push(formato.header);

  for (const p of linhas) {
    if (p.active !== 1) {
      skipped.push({ productId: p.productId, name: p.name, reason: 'Produto inativo.' });
      continue;
    }
    if (p.weighable !== 1) {
      skipped.push({
        productId: p.productId,
        name: p.name,
        reason: 'Não é vendido por peso. Marque "pesável" no cadastro.',
      });
      continue;
    }
    if (!p.pluCode) {
      skipped.push({
        productId: p.productId,
        name: p.name,
        reason: 'Sem PLU. A balança acha o produto por esse número.',
      });
      continue;
    }

    const valores: Record<ScaleFieldKey, string> = {
      plu: p.pluCode,
      // 0 = por peso, 1 = por unidade. Aqui só sai pesável, mas o campo existe
      // porque o layout da balança o exige e omiti-lo desloca tudo à direita.
      tipo: '0',
      preco: String(p.priceCents),
      descricao: semAcento(p.name),
      // Validade em dias. Sem cadastro de validade ainda; sai zero, que a
      // balança lê como "não imprimir data".
      validade: '0',
      tara: String(p.tareGrams ?? 0),
      departamento: '1',
    };

    const campos = formato.fields.map((c) =>
      formato.delimiter ? valores[c.key].slice(0, c.width).trim() : preencher(valores[c.key], c),
    );
    saida.push(formato.delimiter ? campos.join(formato.delimiter) : campos.join(''));
  }

  return {
    filename: formato.filename,
    // CRLF: as três marcas rodam software de origem Windows, e arquivo com LF
    // sozinho já foi lido como uma linha só por importador antigo.
    content: saida.join('\r\n') + '\r\n',
    lineCount: formato.header ? Math.max(0, saida.length - 1) : saida.length,
    confirmado: formato.confirmado,
    skipped,
  };
}

/** Os produtos pesáveis da empresa — a tela lista antes de exportar. */
export function listWeighableProducts(companyId: string): ScaleExportItem[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT id AS productId, name, plu_code AS pluCode, price_cents AS priceCents,
              weighable, tare_grams AS tareGrams
         FROM core_products
        WHERE company_id = ? AND active = 1 AND weighable = 1
        ORDER BY plu_code, name COLLATE NOCASE`,
    )
    .all(companyId) as unknown as ScaleExportItem[];
}
