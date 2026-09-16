/**
 * ============================================================================
 * IMPRIMIR ETIQUETAS — montar, desenhar na saída escolhida, registrar, auditar
 * ============================================================================
 *
 * O caminho único de toda impressão de etiqueta de produto: a folha da tela
 * (`POST /labels/sheet`), a reimpressão de um lote do histórico
 * (`POST /labels/prints/:id/reprint`) e a etiqueta de teste
 * (`POST /labels/test`).
 *
 * ## Montar, desenhar, registrar e auditar numa transação só
 *
 * `buildLabels` grava EAN interno em quem não tinha, e o desenho ainda pode
 * recusar a folha depois (o preço que não cabe nem no corpo mínimo). Com o
 * desenho, o histórico e a auditoria dentro da mesma transação, a recusa
 * desfaz os códigos — a transação de `buildLabels` vira SAVEPOINT desta.
 *
 * ## Quem imprimiu, o quê, quanto
 *
 * DEFEITO QUE ISTO CORRIGE: a trilha `label.sheet` dizia quantos produtos e
 * quantas etiquetas, mas não QUAIS nem quantas de cada, nem por qual saída —
 * e não havia como reimprimir o lote de ontem sem remontar a fila à mão.
 * Agora cada impressão grava `core_label_print_jobs` (usuário, formato ou
 * modelo, saída, cada item com a quantidade e o preço que saiu no papel) e a
 * auditoria aponta para ela. Nada de segredo: o arquivo gerado não é
 * guardado, só o que é preciso para refazê-lo.
 *
 * ## A reimpressão sai com o preço de HOJE
 *
 * A mesma decisão da fila de impressão (`TIPOS_QUE_SEGUEM_O_CADASTRO` em
 * PrintEngine.ts): a etiqueta anuncia o que o caixa cobra daqui em diante, e
 * não um fato passado como o cupom. Reimprimir com o preço de ontem poria na
 * gôndola um valor que o caixa já não cobra.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { buildLabels, itemParaPrevia, type LabelItem } from './BarcodeService.js';
import {
  bytesWindows1252,
  documentoSvg,
  gerarEpl,
  gerarPdf,
  gerarTspl,
  gerarZpl,
  type TrabalhoDeImpressao,
} from './LabelCommands.js';
import { FORMATO_PADRAO, findLabelFormat, porPagina, type LabelFormat } from './LabelFormats.js';
import { dpiDoFormato, layoutDaEtiqueta, mmDosPontos, paginarEtiquetas } from './LabelLayout.js';
import {
  PERFIL_PADRAO,
  PERFIS_DE_IMPRESSAO,
  acharPerfil,
  metricaDoPerfil,
  reticenciasDoPerfil,
  type IdDoPerfil,
  type PerfilDeImpressao,
} from './LabelProfiles.js';
import { avisosDoFormato, nomeDaEmpresa, problemasDosCodigos, renderLabelSheet, resumoDaFolha } from './LabelSheet.js';
import { formatoDoModelo, obterModelo } from './LabelTemplateService.js';

// ------------------------------------------------------------ o pedido

/** A saída pedida; sem pedido, o navegador (o comportamento de sempre da folha). */
export function perfilPedido(bruto: unknown): PerfilDeImpressao {
  if (bruto === undefined || bruto === null || bruto === '') return acharPerfil(PERFIL_PADRAO)!;
  const p = acharPerfil(String(bruto));
  if (!p) {
    throw new ApiError(
      'CORE_LABEL_PROFILE_UNKNOWN',
      `Saída de impressão desconhecida ("${String(bruto)}"). Use uma de: ${PERFIS_DE_IMPRESSAO.map((x) => x.id).join(', ')}.`,
      400,
      { aceitos: PERFIS_DE_IMPRESSAO.map((x) => x.id) },
    );
  }
  return p;
}

/** Um MODELO da loja (templateId) ou um dos formatos prontos (formatId). */
export function formatoDoPedido(
  companyId: string,
  body: { templateId?: unknown; formatId?: unknown },
): { format: LabelFormat; templateId: string | null } {
  if (body.templateId) {
    const id = String(body.templateId);
    return { format: formatoDoModelo(obterModelo(companyId, id)), templateId: id };
  }
  const format = findLabelFormat(String(body.formatId ?? FORMATO_PADRAO));
  if (!format) throw new ApiError('CORE_LABEL_FORMAT_UNKNOWN', 'Formato de etiqueta desconhecido.', 400);
  return { format, templateId: null };
}

/**
 * "Começar na posição N" da primeira folha: a folha já usada volta à
 * impressora e as etiquetas saem nas células livres, em vez de gastar uma
 * folha nova para cada punhado de produtos.
 */
export function posicaoInicial(format: LabelFormat, bruto: unknown): number {
  const cabem = porPagina(format);
  const n = bruto === undefined || bruto === null || bruto === '' ? 1 : Number(bruto);
  if (!Number.isInteger(n) || n < 1 || n > cabem) {
    throw new ApiError('CORE_LABEL_START_INVALID', `Posição inicial: informe um número de 1 a ${cabem} (as etiquetas desta folha).`, 400);
  }
  return n;
}

const nomeDeArquivo = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'etiquetas';

// ------------------------------------------------------------ a emissão

export interface ArquivoDaEtiqueta {
  nome: string;
  mime: string;
  base64: string;
}

export interface EmissaoDeEtiquetas {
  perfil: IdDoPerfil;
  /** O que a tela mostra: a folha (navegador) ou a prévia em SVG, na MESMA geometria do arquivo. */
  html: string;
  /** O arquivo da saída (PDF, ZPL, EPL, TSPL, HTML exato). Nulo no navegador: a folha é o próprio html. */
  arquivo: ArquivoDaEtiqueta | null;
  /** O texto dos comandos (ZPL, EPL, TSPL), para conferir na tela. */
  comandos: string | null;
  etiquetas: number;
  folhas: number;
  avisos: string[];
}

/** Largura da cabeça de 4 polegadas, a maior das térmicas de balcão comuns (104 mm úteis). */
const CABECA_DE_4_POLEGADAS_MM = 104;

/**
 * Desenha os itens já montados na saída do perfil. Não escreve nada: é o
 * desenho puro, com o nome da loja para o rodapé.
 */
export function emitirEtiquetas(input: {
  perfil: PerfilDeImpressao;
  format: LabelFormat;
  items: LabelItem[];
  companyId: string;
  comecarEm: number;
  moldura?: boolean;
  nomeDoArquivo: string;
}): EmissaoDeEtiquetas {
  const { perfil, format: f, items } = input;
  if (perfil.saida === 'html') {
    const html = renderLabelSheet({ format: f, items, companyId: input.companyId, comecarEm: input.comecarEm, moldura: input.moldura });
    const r = resumoDaFolha(f, items, input.comecarEm);
    /*
      A FOLHA DO NAVEGADOR TAMBÉM DIZ O QUE PODE SAIR ERRADO (P00 das etiquetas).

      O DEFEITO: esta linha devolvia `avisos: []`. O navegador é a saída PADRÃO
      — é por ele que a loja imprime todo dia — e era a única que saía muda: as
      barras abaixo do mínimo GS1 (o leitor do caixa falha ou demora), o módulo
      que não fecha em ponto inteiro na impressora do modelo (umas barras com 2
      pontos e outras com 3) e os campos marcados que pedem mais altura do que a
      etiqueta tem (o código de barras sai cortado embaixo) só apareciam ao
      trocar a saída para ZPL/EPL/TSPL/PDF, ou na prévia do editor de modelos.
      Quem nunca abriu o editor gastava o rolo inteiro para descobrir na gôndola.

      São os MESMOS avisos da prévia (`avisosDoFormato`, a geometria do
      formato): a folha do navegador é desenhada por `renderLabelSheet`, em
      milímetro, e é dela que a prévia do modelo sai também — então o que vale
      para uma vale para a outra, e as duas passam a dizer a mesma coisa.
    */
    return {
      perfil: perfil.id,
      html,
      arquivo: null,
      comandos: null,
      etiquetas: r.etiquetas,
      folhas: r.folhas,
      avisos: avisosDoFormato(f),
    };
  }
  if (!perfil.aceitaFolha && f.midia === 'folha') {
    throw new ApiError(
      'CORE_LABEL_PROFILE_MEDIA',
      `A saída "${perfil.rotulo}" é de impressora térmica de rolo e não imprime folha (${f.label}). `
        + 'Para folha A4/Carta, use Navegador, Driver da impressora ou PDF.',
      400,
      { perfil: perfil.id },
    );
  }
  const empresa = nomeDaEmpresa(input.companyId);
  const dpi = dpiDoFormato(f);
  const metrica = metricaDoPerfil(perfil, dpi);
  const reticencias = reticenciasDoPerfil(perfil);
  const etiquetas = items.map((item) => layoutDaEtiqueta(f, item, { empresa, metrica, reticencias, moldura: input.moldura }));
  const paginacao = paginarEtiquetas(f, items.map((i) => i.quantity), input.comecarEm);
  const trabalho: TrabalhoDeImpressao = { formato: f, etiquetas, paginas: paginacao.paginas };
  const avisos: string[] = [...etiquetas.flatMap((e) => e.avisos), ...paginacao.avisos];
  const html = documentoSvg(trabalho, `Etiquetas — ${f.label}`);
  const nome = `${input.nomeDoArquivo}.${perfil.extensao}`;

  let conteudo: Buffer;
  let comandos: string | null = null;
  if (perfil.saida === 'pdf') conteudo = gerarPdf(trabalho);
  else if (perfil.saida === 'html_exato') conteudo = Buffer.from(html, 'utf8');
  else {
    const s = perfil.saida === 'zpl' ? gerarZpl(trabalho) : perfil.saida === 'tspl' ? gerarTspl(trabalho) : gerarEpl(trabalho);
    comandos = s.comandos;
    avisos.push(...s.avisos);
    // A EPL declara Windows-1252 no cabeçalho (I8,A): o arquivo sai nesses bytes.
    conteudo = perfil.saida === 'epl' ? bytesWindows1252(s.comandos) : Buffer.from(s.comandos, 'utf8');
  }
  const larguraMm = paginacao.paginas[0] ? mmDosPontos(paginacao.paginas[0].largura, dpi) : 0;
  if (perfil.levaAjustesDaTermica && larguraMm > CABECA_DE_4_POLEGADAS_MM + 0.5) {
    avisos.push(
      `A página tem ${larguraMm.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mm de largura — mais que a cabeça de 4 polegadas `
        + `(${CABECA_DE_4_POLEGADAS_MM} mm) das térmicas de balcão comuns: a coluna da direita pode sair cortada.`,
    );
  }
  return {
    perfil: perfil.id,
    html,
    arquivo: { nome, mime: perfil.mime, base64: conteudo.toString('base64') },
    comandos,
    etiquetas: items.reduce((t, i) => t + i.quantity, 0),
    folhas: paginacao.paginas.length,
    avisos: [...new Set(avisos)],
  };
}

// ------------------------------------------------------------ o histórico

type TipoDeImpressao = 'lote' | 'reimpressao' | 'teste';

interface ItemDoHistorico {
  productId: string;
  name: string;
  quantity: number;
  priceCents: number;
  batchId: string | null;
}

export interface ImpressaoDeEtiquetas {
  id: string;
  kind: TipoDeImpressao;
  profile: string;
  formatId: string;
  templateId: string | null;
  formatName: string;
  items: ItemDoHistorico[];
  labels: number;
  pages: number;
  startAt: number;
  reprintOf: string | null;
  userId: string | null;
  /** Quem imprimiu, pelo nome — `userId` sozinho não responde a pergunta de quem lê. */
  userName: string | null;
  createdAt: string;
}

interface LinhaDoHistorico {
  id: string;
  kind: string;
  profile: string;
  format_id: string;
  template_id: string | null;
  format_name: string;
  items: string;
  labels: number;
  pages: number;
  start_at: number;
  reprint_of: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

function daLinhaDoHistorico(l: LinhaDoHistorico): ImpressaoDeEtiquetas {
  let items: ItemDoHistorico[] = [];
  try {
    const lidos = JSON.parse(l.items) as unknown;
    if (Array.isArray(lidos)) items = lidos as ItemDoHistorico[];
  } catch {
    items = [];
  }
  return {
    id: l.id,
    kind: l.kind === 'reimpressao' || l.kind === 'teste' ? l.kind : 'lote',
    profile: l.profile,
    formatId: l.format_id,
    templateId: l.template_id,
    formatName: l.format_name,
    items,
    labels: l.labels,
    pages: l.pages,
    startAt: l.start_at,
    reprintOf: l.reprint_of,
    userId: l.user_id,
    userName: l.user_name,
    createdAt: l.created_at,
  };
}

const SELECT_DO_HISTORICO = `SELECT j.*, u.display_name AS user_name
                               FROM core_label_print_jobs j
                               LEFT JOIN core_users u ON u.id = j.user_id`;

function gravarImpressao(r: {
  companyId: string;
  userId: string | null;
  kind: TipoDeImpressao;
  perfil: IdDoPerfil;
  format: LabelFormat;
  templateId: string | null;
  items: LabelItem[];
  labels: number;
  pages: number;
  comecarEm: number;
  reprintOf: string | null;
}): string {
  const id = randomUUID();
  const itens: ItemDoHistorico[] = r.items.map((i) => ({
    productId: i.productId, name: i.name, quantity: i.quantity, priceCents: i.priceCents, batchId: i.batchId ?? null,
  }));
  getConnection()
    .prepare(
      `INSERT INTO core_label_print_jobs
         (id, company_id, user_id, kind, profile, format_id, template_id, format_name, items, labels, pages, start_at, reprint_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, r.companyId, r.userId, r.kind, r.perfil, r.format.id, r.templateId, r.format.label, JSON.stringify(itens),
      r.labels, r.pages, r.comecarEm, r.reprintOf, new Date().toISOString(),
    );
  return id;
}

export function listarImpressoes(companyId: string, limite = 30): ImpressaoDeEtiquetas[] {
  ensureCoreSchema();
  const n = Math.max(1, Math.min(200, Math.floor(Number(limite) || 30)));
  return (getConnection()
    .prepare(`${SELECT_DO_HISTORICO} WHERE j.company_id = ? ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`)
    .all(companyId, n) as unknown as LinhaDoHistorico[]).map(daLinhaDoHistorico);
}

/** Uma impressão DESTA operação — a de outra empresa é "não encontrada", nunca "proibida". */
export function obterImpressao(companyId: string, id: string): ImpressaoDeEtiquetas {
  ensureCoreSchema();
  const l = getConnection()
    .prepare(`${SELECT_DO_HISTORICO} WHERE j.company_id = ? AND j.id = ?`)
    .get(companyId, id) as LinhaDoHistorico | undefined;
  if (!l) throw new ApiError('CORE_LABEL_PRINT_NOT_FOUND', 'Impressão de etiquetas não encontrada nesta operação.', 404);
  return daLinhaDoHistorico(l);
}

// ------------------------------------------------------------ imprimir

export interface RespostaDaImpressao extends Omit<EmissaoDeEtiquetas, 'avisos'> {
  codigosGerados: { productId: string; name: string; barcode: string }[];
  semCodigo: string[];
  codigosSemDesenho: { name: string; motivo: string }[];
  promocoes: string[];
  semPreco: string[];
  avisos: string[];
  impressaoId: string;
}

export function imprimirEtiquetas(p: {
  companyId: string;
  userId: string | null;
  format: LabelFormat;
  templateId: string | null;
  items: { productId: string; quantity?: unknown; batchId?: unknown }[];
  perfil: PerfilDeImpressao;
  comecarEm: number;
  podeGerarCodigo: boolean;
  tipo: 'lote' | 'reimpressao';
  reimpressaoDe?: string | null;
}): RespostaDaImpressao {
  const { built, emissao, codigosGerados, impressaoId } = withTransaction(() => {
    const montadas = buildLabels(p.companyId, p.items, { campos: p.format.campos, podeGerarCodigo: p.podeGerarCodigo });
    const desenho = emitirEtiquetas({
      perfil: p.perfil, format: p.format, items: montadas, companyId: p.companyId, comecarEm: p.comecarEm,
      nomeDoArquivo: `etiquetas-${nomeDeArquivo(p.format.id)}`,
    });
    const gerados = montadas
      .filter((i) => i.codigoGerado)
      .map((i) => ({ productId: i.productId, name: i.name, barcode: i.barcode }));
    const id = gravarImpressao({
      companyId: p.companyId, userId: p.userId, kind: p.tipo, perfil: p.perfil.id, format: p.format, templateId: p.templateId,
      items: montadas, labels: desenho.etiquetas, pages: desenho.folhas, comecarEm: p.comecarEm, reprintOf: p.reimpressaoDe ?? null,
    });
    recordAudit({
      companyId: p.companyId,
      userId: p.userId,
      action: p.tipo === 'reimpressao' ? 'label.reprint' : 'label.sheet',
      entityType: 'label_batch',
      entityId: p.format.id,
      // QUEM (userId acima), QUAL modelo, QUANTAS de cada e por QUAL saída — e
      // quais produtos ganharam código neste lote. Nada de segredo.
      detail: {
        produtos: montadas.length,
        etiquetas: desenho.etiquetas,
        folhas: desenho.folhas,
        perfil: p.perfil.id,
        modelo: p.templateId,
        quantidades: montadas.map((i) => ({ productId: i.productId, quantidade: i.quantity })),
        comecarEm: p.comecarEm,
        impressaoId: id,
        ...(p.reimpressaoDe ? { reimpressaoDe: p.reimpressaoDe } : {}),
        codigosGerados: gerados.map(({ productId, barcode }) => ({ productId, barcode })),
      },
    });
    return { built: montadas, emissao: desenho, codigosGerados: gerados, impressaoId: id };
  });
  return {
    ...emissao,
    codigosGerados,
    semCodigo: built.filter((i) => i.codigoPendente === 'sem_permissao').map((i) => i.name),
    codigosSemDesenho: problemasDosCodigos(p.format, built),
    promocoes: built.filter((i) => i.onSale).map((i) => i.name),
    // Etiqueta com R$ 0,00 na prateleira é pior que etiqueta nenhuma: o preço
    // anunciado obriga a loja. Não recusamos — há caso legítimo, como brinde —,
    // mas quem clicou precisa ser avisado.
    semPreco: built.filter((i) => i.priceCents <= 0).map((i) => i.name),
    impressaoId,
  };
}

/**
 * REIMPRIMIR um lote do histórico: os mesmos produtos, as mesmas quantidades
 * e o mesmo formato (ou modelo), com o preço e o cadastro de HOJE. A saída e
 * a posição inicial podem mudar (a folha de ontem acabou; a térmica é outra).
 */
export function reimprimirEtiquetas(input: {
  companyId: string;
  userId: string | null;
  id: string;
  perfil?: unknown;
  startAt?: unknown;
  podeGerarCodigo: boolean;
}): RespostaDaImpressao {
  const original = obterImpressao(input.companyId, input.id);
  if (original.kind === 'teste') {
    throw new ApiError('CORE_LABEL_REPRINT_TEST', 'A etiqueta de teste não tem reimpressão: imprima o teste de novo.', 409);
  }
  if (original.items.length === 0) {
    throw new ApiError('CORE_LABEL_REPRINT_EMPTY', 'Esta impressão não guardou itens para reimprimir.', 409);
  }
  let format: LabelFormat | undefined;
  if (original.templateId) {
    try {
      format = formatoDoModelo(obterModelo(input.companyId, original.templateId));
    } catch (err) {
      if ((err as ApiError).code !== 'CORE_LABEL_TEMPLATE_NOT_FOUND') throw err;
      throw new ApiError(
        'CORE_LABEL_REPRINT_TEMPLATE_GONE',
        `O modelo "${original.formatName}" foi apagado depois desta impressão. Gere a folha de novo com outro modelo.`,
        409,
      );
    }
  } else {
    format = findLabelFormat(original.formatId);
  }
  if (!format) {
    throw new ApiError('CORE_LABEL_REPRINT_TEMPLATE_GONE', `O formato "${original.formatName}" não existe mais. Gere a folha de novo.`, 409);
  }
  const perfil = input.perfil === undefined || input.perfil === null || input.perfil === ''
    ? acharPerfil(original.profile) ?? perfilPedido(null)
    : perfilPedido(input.perfil);
  return imprimirEtiquetas({
    companyId: input.companyId,
    userId: input.userId,
    format,
    templateId: original.templateId,
    items: original.items.map((i) => ({ productId: i.productId, quantity: i.quantity, ...(i.batchId ? { batchId: i.batchId } : {}) })),
    perfil,
    comecarEm: posicaoInicial(format, input.startAt),
    podeGerarCodigo: input.podeGerarCodigo,
    tipo: 'reimpressao',
    reimpressaoDe: original.id,
  });
}

/**
 * A ETIQUETA DE TESTE: uma etiqueta da AMOSTRA de pior caso (nome longo, preço
 * de quatro dígitos em promoção, o EAN de amostra 040…, que não é de produto
 * nenhum) com uma MOLDURA meio milímetro para dentro da borda — se a moldura
 * sai torta no adesivo, a calibração X/Y do modelo diz quanto corrigir. Não
 * grava nada no cadastro; fica no histórico e na auditoria.
 */
export function imprimirTeste(input: {
  companyId: string;
  userId: string | null;
  format: LabelFormat;
  templateId: string | null;
  perfil: PerfilDeImpressao;
}): EmissaoDeEtiquetas & { impressaoId: string } {
  const item = itemParaPrevia(input.companyId, null, 1, input.format.campos);
  return withTransaction(() => {
    const emissao = emitirEtiquetas({
      perfil: input.perfil, format: input.format, items: [item], companyId: input.companyId, comecarEm: 1, moldura: true,
      nomeDoArquivo: `etiqueta-de-teste-${nomeDeArquivo(input.format.id)}`,
    });
    const impressaoId = gravarImpressao({
      companyId: input.companyId, userId: input.userId, kind: 'teste', perfil: input.perfil.id, format: input.format,
      templateId: input.templateId, items: [], labels: emissao.etiquetas, pages: emissao.folhas, comecarEm: 1, reprintOf: null,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'label.test',
      entityType: 'label_batch',
      entityId: input.format.id,
      detail: { perfil: input.perfil.id, modelo: input.templateId, impressaoId },
    });
    return { ...emissao, impressaoId };
  });
}
