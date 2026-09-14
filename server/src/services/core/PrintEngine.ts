/**
 * PrintEngine — fila e ciclo de vida da impressão.
 *
 * As camadas são separadas de propósito:
 *
 *   DOCUMENTO      o que se quer imprimir (venda, orçamento, etiqueta, OS)
 *   RENDERIZAÇÃO   vira HTML pronto para papel — `PrintRenderer`
 *   JOB            o pedido de impressão, com estado e histórico — aqui
 *   TRANSPORTE     navegador, ou o agente local do caixa (GAP-PRD-082)
 *   IMPRESSORA     configurada por operação (e, a de agente, por caixa)
 *
 * DUAS REGRAS QUE NÃO PODEM CAIR
 *
 * 1. Reimprimir NÃO refaz o fato. Um job novo aponta para o MESMO documento:
 *    não cria venda, não emite documento fiscal, não movimenta estoque e não
 *    gera receita. O que se repete é o papel, não o negócio.
 *
 * 2. `printed` só é gravado quando o transporte confirma. Marcar antes faria o
 *    sistema afirmar que o cupom saiu enquanto a impressora estava sem papel —
 *    e o cliente iria embora sem comprovante, com o sistema dizendo que
 *    imprimiu.
 *
 * O TRANSPORTE É DECIDIDO AQUI, NO NASCIMENTO DO JOB (GAP-PRD-082)
 *
 * Impressora de agente local só recebe o job pelo agente quando os três
 * existem: o endereço dela no computador do caixa, o agente daquele caixa
 * pareado e FALANDO (sinal nos últimos 90 s), e um documento que tem layout
 * térmico. Faltando qualquer um, o job nasce `browser` com o motivo em
 * `fallback_reason` — o cupom sai pela caixa de diálogo, e a tela diz por quê,
 * em vez de ficar esperando um papel que nenhum programa vai imprimir.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { agenteDoCaixa, agenteOnline } from '../payment-terminal/PaymentTerminalLocalAgentService.js';
import { assertTerminalDaEmpresa } from './TerminalRegistry.js';
import { lerDestinoDaImpressora } from './destinoDaImpressora.js';
import { larguraDoCupomCadastrada } from './PapelDaLoja.js';
import { renderDocument } from './PrintRenderer.js';

/** Tipos de documento que o motor sabe enfileirar. */
export const DOCUMENT_TYPES = [
  'PDV_RECEIPT',
  'SALE_RECEIPT',
  'QUOTE',
  'PRE_SALE',
  'PRODUCT_LABEL',
  'EQUIPMENT_QR_TAG',
  'WORKSHOP_OS',
  'CASH_CLOSING',
  // Fiscais: a arquitetura os aceita, mas só saem quando houver autorização
  // real da SEFAZ. Enfileirar não emite nota.
  'DANFCE',
  'DANFE',
  // Do agente local (GAP-PRD-082): a página de teste da impressora e o pulso
  // da gaveta sem venda. Só nascem pelas rotas próprias (motivo, gerência),
  // nunca por POST /print/jobs, e não têm segunda via.
  'PRINTER_TEST',
  'DRAWER_PULSE',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Nascem só pelas rotas próprias; POST /print/jobs e a segunda via os recusam. */
export const TIPOS_RESERVADOS: readonly DocumentType[] = ['PRINTER_TEST', 'DRAWER_PULSE'];

/*
  A ETIQUETA NÃO REGISTRA UM FATO: ANUNCIA O PREÇO DE AGORA (auditoria PJ,
  C-etiquetas-17).

  A segunda via reaproveita o papel congelado porque cupom, orçamento, OS e
  fechamento registram algo que JÁ aconteceu, e o papel de hoje tem que ser o
  mesmo de antes. A etiqueta de produto é o contrário: ela diz na prateleira
  quanto o caixa vai cobrar DAQUI EM DIANTE. Reaproveitar o payload de quando
  a promoção valia colava R$ 39,90 na peça depois de a promoção acabar, e o
  caixa cobrava R$ 49,90 — o papel cobrando menos que o caixa, que é o erro
  caro. Para estes tipos, a segunda via é desenhada de novo, com o cadastro e
  o preço vigente de hoje.
*/
export const TIPOS_QUE_SEGUEM_O_CADASTRO: readonly DocumentType[] = ['PRODUCT_LABEL'];

/** O que o agente sabe mandar para a térmica em ESC/POS. */
export const TIPOS_TERMICOS: readonly DocumentType[] = ['PDV_RECEIPT', 'SALE_RECEIPT', 'PRINTER_TEST', 'DRAWER_PULSE'];

export const DOCUMENT_LABEL: Record<DocumentType, string> = {
  PDV_RECEIPT: 'Comprovante do PDV',
  SALE_RECEIPT: 'Comprovante de venda',
  QUOTE: 'Orçamento',
  PRE_SALE: 'Pré-venda',
  PRODUCT_LABEL: 'Etiqueta de produto',
  EQUIPMENT_QR_TAG: 'Plaquinha de equipamento',
  WORKSHOP_OS: 'Ordem de serviço',
  CASH_CLOSING: 'Fechamento de caixa',
  DANFCE: 'DANFE NFC-e',
  DANFE: 'DANFE',
  PRINTER_TEST: 'Página de teste da impressora',
  DRAWER_PULSE: 'Abertura da gaveta',
};

export type PrintStatus =
  | 'pending'
  | 'rendering'
  | 'ready'
  | 'printing'
  | 'printed'
  | 'failed'
  | 'cancelled';

/** Transições permitidas. Qualquer outra é recusada. */
const ALLOWED: Record<PrintStatus, PrintStatus[]> = {
  pending: ['rendering', 'cancelled', 'failed'],
  rendering: ['ready', 'failed', 'cancelled'],
  ready: ['printing', 'cancelled', 'failed'],
  printing: ['printed', 'failed', 'cancelled'],
  printed: [],
  failed: ['pending'],
  cancelled: [],
};

export type PrintTransport = 'browser' | 'agent';

export interface PrintJob {
  id: string;
  company_id: string;
  document_type: DocumentType;
  document_id: string;
  printer_id: string | null;
  status: PrintStatus;
  copies: number;
  attempts: number;
  payload: string | null;
  error: string | null;
  reprint_of: string | null;
  created_by: string | null;
  created_at: string;
  printed_at: string | null;
  /** Nulo nos jobs anteriores ao agente: é o navegador. */
  transport: PrintTransport | null;
  open_drawer: number;
  /** O caixa cujo agente imprime este job (o da impressora); nulo = o agente da operação. */
  pdv_terminal_id: string | null;
  agent_id: string | null;
  claimed_at: string | null;
  /** Por que um job de impressora de agente saiu pelo navegador. */
  fallback_reason: string | null;
  reason: string | null;
}

/**
 * Acorda o agente que espera impressão desta operação (long-poll). A fila de
 * verdade é a tabela: o aviso só encurta a espera.
 */
export const AVISOS_DE_IMPRESSAO = new EventEmitter();
AVISOS_DE_IMPRESSAO.setMaxListeners(0);

function loadJob(companyId: string, jobId: string): PrintJob {
  const row = getConnection()
    .prepare('SELECT * FROM core_print_jobs WHERE id = ? AND company_id = ?')
    .get(jobId, companyId) as PrintJob | undefined;
  if (!row) throw new ApiError('CORE_PRINT_JOB_NOT_FOUND', 'Job de impressão não encontrado.', 404);
  return row;
}

// ------------------------------------------------------------- impressoras

export interface Printer {
  id: string;
  company_id: string;
  name: string;
  kind: 'cupom' | 'etiqueta' | 'a4';
  transport: PrintTransport;
  paper_width_mm: number | null;
  is_default: number;
  active: number;
  /** O caixa cujo agente imprime nela; nulo = o agente da operação inteira. */
  pdv_terminal_id: string | null;
  /** Onde o agente escreve os bytes naquele computador (ver `destinoDaImpressora`). */
  agent_device: string | null;
}

/** Qual impressora atende cada tipo de documento, por padrão. */
const KIND_BY_DOCUMENT: Record<DocumentType, Printer['kind']> = {
  PDV_RECEIPT: 'cupom',
  SALE_RECEIPT: 'cupom',
  DANFCE: 'cupom',
  DANFE: 'a4',
  QUOTE: 'a4',
  PRE_SALE: 'a4',
  WORKSHOP_OS: 'a4',
  CASH_CLOSING: 'cupom',
  PRODUCT_LABEL: 'etiqueta',
  EQUIPMENT_QR_TAG: 'etiqueta',
  PRINTER_TEST: 'cupom',
  DRAWER_PULSE: 'cupom',
};

function loadPrinter(companyId: string, printerId: string): Printer {
  const row = getConnection()
    .prepare('SELECT * FROM core_printers WHERE id = ? AND company_id = ?')
    .get(printerId, companyId) as Printer | undefined;
  if (!row) throw new ApiError('CORE_PRINTER_NOT_FOUND', 'Impressora não encontrada nesta operação.', 404);
  return row;
}

/**
 * A impressora padrão do tipo, para ESTE caixa.
 *
 * A impressora presa a um caixa (a térmica do Caixa 1) só serve ao Caixa 1;
 * a da operação (sem caixa) serve a todos. Entre as que servem, a do próprio
 * caixa vem antes, e depois a marcada como padrão.
 */
function defaultPrinter(companyId: string, documentType: DocumentType, pdvTerminalId: string | null): Printer | null {
  const kind = KIND_BY_DOCUMENT[documentType];
  return (
    (getConnection()
      .prepare(
        `SELECT * FROM core_printers
          WHERE company_id = ? AND kind = ? AND active = 1
            AND (pdv_terminal_id IS NULL OR pdv_terminal_id = ?)
          ORDER BY (pdv_terminal_id IS NOT NULL) DESC, is_default DESC, created_at LIMIT 1`,
      )
      .get(companyId, kind, pdvTerminalId) as Printer | undefined) ?? null
  );
}

/**
 * A impressora que vai receber este documento: a informada, ou a padrão do
 * tipo para este caixa.
 *
 * Existe à parte (auditoria do cupom, F-07) porque o POST /print/jobs
 * renderizava o papel ANTES de escolher a impressora — e a largura da bobina
 * dela (58 ou 80 mm) muda o papel. A escolha é a MESMA que `createPrintJob`
 * faz: duas regras de escolha poderiam renderizar para uma impressora e
 * enfileirar para outra.
 */
export function impressoraDoDocumento(
  companyId: string,
  documentType: DocumentType,
  pdvTerminalId: string | null,
  printerId?: string | null,
): Printer | null {
  ensureCoreSchema();
  if (printerId) return loadPrinter(companyId, printerId);
  // Tipo desconhecido não tem impressora; a recusa com a frase certa é de quem enfileira.
  if (!DOCUMENT_TYPES.includes(documentType)) return null;
  return defaultPrinter(companyId, documentType, pdvTerminalId);
}

/*
  O DANFCE ABERTO PELA ROTA DA NOTA SAI NA BOBINA DA IMPRESSORA (auditoria PJ,
  F-cupom-fiscal-07#danfce).

  O DEFEITO: a largura da impressora só chegava ao papel por POST /print/jobs.
  `GET /fiscal/documents/:id/danfce` — a rota do "Ver DANFCE" do painel do PDV
  e da tela de documentos fiscais — chamava `renderDanfce` sem largura, e o
  DANFCE saía sempre com a página de 80 mm; na térmica de 58 mm, o driver
  cortava a coluna dos valores ou encolhia tudo.

  A impressora é a MESMA que a fila escolheria para o DANFCE (a de cupom):
  a do caixa de quem pede; sem caixa informado, a do caixa em que a venda da
  nota foi feita (é quase sempre o mesmo computador); sem nenhum, a da
  operação. Sem impressora de cupom, o papel continua o de 80 mm.
*/
export function impressoraDoDanfce(
  companyId: string,
  documentId: string,
  caixaDoPedido: string | null,
): Printer | null {
  ensureCoreSchema();
  let caixa = caixaDoPedido;
  if (!caixa) {
    const venda = getConnection()
      .prepare(
        `SELECT s.terminal_id AS terminal_id
           FROM core_fiscal_documents d
           JOIN core_sales s ON s.id = d.sale_id AND s.company_id = d.company_id
          WHERE d.id = ? AND d.company_id = ?`,
      )
      .get(documentId, companyId) as { terminal_id: string | null } | undefined;
    caixa = venda?.terminal_id ?? null;
  }
  return impressoraDoDocumento(companyId, 'DANFCE', caixa);
}

function nomeDoCaixa(companyId: string, pdvTerminalId: string | null): string | null {
  if (!pdvTerminalId) return null;
  const r = getConnection()
    .prepare('SELECT name FROM core_terminals WHERE id = ? AND company_id = ?')
    .get(pdvTerminalId, companyId) as { name?: string } | undefined;
  return r?.name ?? pdvTerminalId;
}

export interface AgenteDaImpressora {
  agentId: string;
  online: boolean;
  lastSeenAt: string | null;
}

/** O agente que atende esta impressora (o do caixa dela) e se ele está falando. */
export function agenteDaImpressora(companyId: string, printer: Printer): AgenteDaImpressora | null {
  const row = agenteDoCaixa(companyId, printer.pdv_terminal_id ?? null);
  if (!row) return null;
  return {
    agentId: String(row.id),
    online: agenteOnline(row),
    lastSeenAt: (row.lastSeenAt as string | null | undefined) ?? null,
  };
}

/** "do caixa "Caixa 1"" / "da operação" — onde mora o agente desta impressora. */
export function ondeMoraOAgente(companyId: string, printer: Printer): string {
  const caixa = nomeDoCaixa(companyId, printer.pdv_terminal_id ?? null);
  return caixa ? `do caixa "${caixa}"` : 'da operação';
}

function horaCurta(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * O que falta para ESTA impressora imprimir pelo agente agora — ou `null`,
 * quando nada falta. A frase é a que a tela e o job mostram.
 */
export function oQueFaltaNaImpressoraDeAgente(companyId: string, printer: Printer): string | null {
  if (printer.transport !== 'agent') return null;
  /*
    ETIQUETA E A4 NÃO IMPRIMEM PELO AGENTE (auditoria PJ, C-etiquetas-11).

    O agente fala ESC/POS, a língua da térmica de cupom. O cadastro e a página
    de teste já recusam etiqueta/A4 "de agente", mas a impressora cadastrada
    ANTES da trava continuava aparecendo como pronta (endereço, agente no ar),
    sem nada dizendo que ela nunca recebe papel pelo agente. Agora ela aparece
    com o que fazer, e não conta como pronta.
  */
  if (printer.kind !== 'cupom') {
    return `A impressora "${printer.name}" é de ${printer.kind === 'etiqueta' ? 'etiqueta' : 'A4'} e está marcada `
      + 'como agente local, mas o agente só imprime cupom: ela imprime pelo driver, no diálogo do sistema. '
      + 'Edite a impressora e escolha "Navegador" em "Como imprime".';
  }
  if (!printer.agent_device) {
    return `A impressora "${printer.name}" é de agente local, mas não tem o endereço no computador do caixa `
      + '(Configurações › Impressoras).';
  }
  const agente = agenteDaImpressora(companyId, printer);
  const onde = ondeMoraOAgente(companyId, printer);
  if (!agente) {
    return `Nenhum agente local pareado ${onde}. Pareie em Configurações › Maquininhas › Agente local `
      + '(o mesmo programa imprime e fala com o PinPad).';
  }
  if (!agente.online) {
    const visto = horaCurta(agente.lastSeenAt);
    return `O agente local ${onde} está fora do ar${visto ? ` (último sinal em ${visto})` : ''}.`;
  }
  return null;
}

interface DecisaoDeTransporte {
  transport: PrintTransport;
  fallback: string | null;
}

function decidirTransporte(companyId: string, printer: Printer | null, documentType: DocumentType): DecisaoDeTransporte {
  if (!printer || printer.transport !== 'agent') return { transport: 'browser', fallback: null };
  if (!TIPOS_TERMICOS.includes(documentType)) {
    return {
      transport: 'browser',
      fallback: `${DOCUMENT_LABEL[documentType]} não tem layout de cupom térmico: sai pela caixa de diálogo do navegador.`,
    };
  }
  const falta = oQueFaltaNaImpressoraDeAgente(companyId, printer);
  if (falta) return { transport: 'browser', fallback: `${falta} O papel sai pela caixa de diálogo do navegador.` };
  return { transport: 'agent', fallback: null };
}

/**
 * Enfileira uma impressão.
 *
 * `payload` guarda o documento já renderizado. Reimprimir depois devolve
 * exatamente o papel de antes, mesmo que o preço do produto tenha mudado —
 * segunda via tem que ser via do mesmo documento, não um documento novo com os
 * dados de hoje.
 */
export function createPrintJob(input: {
  companyId: string;
  userId?: string | null;
  documentType: DocumentType;
  documentId: string;
  payload?: string | null;
  printerId?: string | null;
  copies?: number;
  reprintOf?: string | null;
  /** O caixa de quem pede: escolhe a impressora daquele computador. */
  pdvTerminalId?: string | null;
  /** Abrir a gaveta junto do cupom. Só vale pelo agente e só para cupom de venda. */
  openDrawer?: boolean;
  /** Motivo declarado (abrir a gaveta sem venda). */
  reason?: string | null;
  /** Recusa em vez de cair para o navegador (teste da impressora, gaveta). */
  exigirAgente?: boolean;
}): PrintJob {
  ensureCoreSchema();

  if (!DOCUMENT_TYPES.includes(input.documentType)) {
    throw new ApiError(
      'CORE_PRINT_TYPE_INVALID',
      `Tipo de documento desconhecido: ${input.documentType}`,
      400,
    );
  }
  const copies = Math.max(1, Math.min(10, Math.floor(input.copies ?? 1)));

  const printer = impressoraDoDocumento(
    input.companyId,
    input.documentType,
    input.pdvTerminalId ?? null,
    input.printerId ?? null,
  );
  const decisao = decidirTransporte(input.companyId, printer, input.documentType);
  if (input.exigirAgente && decisao.transport !== 'agent') {
    throw new ApiError(
      'CORE_PRINT_AGENT_UNAVAILABLE',
      decisao.fallback?.replace(' O papel sai pela caixa de diálogo do navegador.', '')
        ?? 'Não há impressora de agente local para este caixa.',
      409,
      { printerId: printer?.id ?? null },
    );
  }
  const abreGaveta =
    Boolean(input.openDrawer)
    && decisao.transport === 'agent'
    && (input.documentType === 'PDV_RECEIPT' || input.documentType === 'SALE_RECEIPT' || input.documentType === 'DRAWER_PULSE');

  const job = withTransaction(() => {
    const db = getConnection();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_print_jobs
         (id, company_id, document_type, document_id, printer_id, status, copies,
          attempts, payload, error, reprint_of, created_by, created_at, printed_at,
          transport, open_drawer, pdv_terminal_id, agent_id, claimed_at, fallback_reason, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.documentType,
      input.documentId,
      printer?.id ?? null,
      input.payload ? 'ready' : 'pending',
      copies,
      input.payload ?? null,
      input.reprintOf ?? null,
      input.userId ?? null,
      new Date().toISOString(),
      decisao.transport,
      abreGaveta ? 1 : 0,
      printer?.pdv_terminal_id ?? null,
      decisao.fallback,
      input.reason ?? null,
    );
    return loadJob(input.companyId, id);
  });
  if (job.transport === 'agent') AVISOS_DE_IMPRESSAO.emit(input.companyId);
  return job;
}

/*
  O FECHAMENTO QUE FOI DESFEITO NÃO TEM SEGUNDA VIA (revisão da auditoria PJ,
  H-caixa-seguranca-11).

  O DEFEITO: o papel do fechamento passou a ser recusado para turno aberto
  (409 em `renderCashClosing`), mas a segunda via não renderiza: copia o papel
  congelado. Com o turno fechado, impresso e depois REABERTO pelo gerente,
  qualquer operador do balcão pedia a segunda via do job antigo e recebia um
  "CONFERIDO" para um turno aberto — o papel falso que a recusa veio impedir,
  por outra porta. E depois de fechado de novo, a via do job antigo trazia a
  contagem que a reabertura desfez, sem o aviso de reabertura, pronta para ser
  assinada no lugar do fechamento que vale.

  Agora a via do fechamento só sai com o turno fechado e se o papel é do
  fechamento que vale: impresso DEPOIS da última reabertura. Na dúvida (o
  mesmo milissegundo), recusa — pedir a impressão do fechamento atual é
  sempre possível; entregar um fechamento desfeito não tem volta.
*/
function exigirFechamentoQueVale(companyId: string, original: PrintJob): void {
  const db = getConnection();
  const sessao = db
    .prepare('SELECT status, reopened_at FROM core_cash_sessions WHERE id = ? AND company_id = ?')
    .get(original.document_id, companyId) as { status: string; reopened_at: string | null } | undefined;
  if (!sessao) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);
  if (sessao.status !== 'closed') {
    throw new ApiError(
      'CORE_CASH_CLOSING_NOT_CLOSED',
      'Este caixa está aberto agora (foi reaberto depois deste papel): a segunda via deste fechamento não vale mais. '
        + 'Conte a gaveta, confirme o fechamento do caixa e peça a impressão do fechamento novo.',
      409,
      { sessionId: original.document_id, status: sessao.status },
    );
  }
  // A via copia o papel do job ORIGINAL: é a data dele que conta.
  const raiz = original.reprint_of
    ? (db
        .prepare('SELECT created_at FROM core_print_jobs WHERE id = ? AND company_id = ?')
        .get(original.reprint_of, companyId) as { created_at: string } | undefined)
    : undefined;
  const papelDe = raiz?.created_at ?? original.created_at;
  if (sessao.reopened_at && sessao.reopened_at >= papelDe) {
    throw new ApiError(
      'CORE_CASH_CLOSING_SUPERSEDED',
      'Este papel é de um fechamento que foi desfeito: o caixa foi reaberto depois dele e fechado de novo. '
        + 'Peça a impressão do fechamento atual (Imprimir fechamento), e não a segunda via deste.',
      409,
      { sessionId: original.document_id, reabertoEm: sessao.reopened_at, papelDe },
    );
  }
}

/**
 * Segunda via.
 *
 * Reaproveita o documento renderizado do job original — exceto a etiqueta de
 * produto, que é desenhada de novo com o preço de hoje
 * (`TIPOS_QUE_SEGUEM_O_CADASTRO`). O fechamento de caixa só tem via enquanto
 * for o fechamento que vale (`exigirFechamentoQueVale`). O que nasce aqui é
 * papel, não fato: nenhuma venda, nota, receita ou baixa de estoque acontece.
 * E não abre gaveta: o dinheiro já entrou uma vez.
 */
export function reprintJob(input: {
  companyId: string;
  userId?: string | null;
  jobId: string;
  copies?: number;
}): PrintJob {
  ensureCoreSchema();
  const original = loadJob(input.companyId, input.jobId);
  if (TIPOS_RESERVADOS.includes(original.document_type)) {
    throw new ApiError(
      'CORE_PRINT_REPRINT_NOT_ALLOWED',
      `${DOCUMENT_LABEL[original.document_type]} não tem segunda via: peça de novo pela tela própria.`,
      400,
    );
  }
  if (original.document_type === 'CASH_CLOSING') exigirFechamentoQueVale(input.companyId, original);

  // A etiqueta sai com o preço de hoje; o resto, com o papel de antes.
  const payload = TIPOS_QUE_SEGUEM_O_CADASTRO.includes(original.document_type)
    ? renderDocument(input.companyId, original.document_type, original.document_id)
    : original.payload;

  return createPrintJob({
    companyId: input.companyId,
    userId: input.userId,
    documentType: original.document_type,
    documentId: original.document_id,
    payload,
    printerId: original.printer_id,
    copies: input.copies ?? 1,
    // A origem fica registrada: dá para saber quantas vias de um documento
    // saíram e quem pediu cada uma.
    reprintOf: original.reprint_of ?? original.id,
  });
}

/** Avança o estado do job, recusando transição impossível. */
export function advancePrintJob(input: {
  companyId: string;
  jobId: string;
  status: PrintStatus;
  error?: string | null;
}): PrintJob {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const job = loadJob(input.companyId, input.jobId);

    if (!ALLOWED[job.status]?.includes(input.status)) {
      throw new ApiError(
        'CORE_PRINT_TRANSITION_INVALID',
        `Job em "${job.status}" não pode ir para "${input.status}".`,
        409,
        { from: job.status, to: input.status },
      );
    }

    const printedAt = input.status === 'printed' ? new Date().toISOString() : job.printed_at;
    const attempts = input.status === 'printing' ? job.attempts + 1 : job.attempts;

    db.prepare(
      `UPDATE core_print_jobs
          SET status = ?, error = ?, attempts = ?, printed_at = ?
        WHERE id = ?`,
    ).run(input.status, input.error ?? null, attempts, printedAt, input.jobId);

    return loadJob(input.companyId, input.jobId);
  });
}

export function getPrintJob(companyId: string, jobId: string): PrintJob {
  ensureCoreSchema();
  return loadJob(companyId, jobId);
}

export function listPrintJobs(
  companyId: string,
  options: { documentId?: string; status?: PrintStatus; limit?: number } = {},
): PrintJob[] {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = 'SELECT * FROM core_print_jobs WHERE company_id = ?';
  if (options.documentId) {
    sql += ' AND document_id = ?';
    params.push(options.documentId);
  }
  if (options.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(options.limit ?? 100);
  return getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as PrintJob[];
}

export function listPrinters(companyId: string): Printer[] {
  ensureCoreSchema();
  return getConnection()
    .prepare('SELECT * FROM core_printers WHERE company_id = ? ORDER BY kind, name')
    .all(companyId) as unknown as Printer[];
}

export function getPrinter(companyId: string, printerId: string): Printer {
  ensureCoreSchema();
  return loadPrinter(companyId, printerId);
}

export function upsertPrinter(input: {
  companyId: string;
  id?: string;
  name: string;
  kind: Printer['kind'];
  transport?: Printer['transport'];
  paperWidthMm?: number | null;
  isDefault?: boolean;
  active?: boolean;
  /** O caixa cujo agente imprime nela (GAP-PRD-082). Ausente = mantém o que havia. */
  pdvTerminalId?: string | null;
  /** Onde o agente escreve os bytes. Ausente = mantém o que havia. */
  agentDevice?: string | null;
}): Printer {
  ensureCoreSchema();
  if (!input.name?.trim()) {
    throw new ApiError('CORE_PRINTER_NAME_REQUIRED', 'Informe o nome da impressora.', 400);
  }
  if (!['cupom', 'etiqueta', 'a4'].includes(input.kind)) {
    throw new ApiError('CORE_PRINTER_KIND_INVALID', `Tipo inválido: ${input.kind}`, 400);
  }
  if (input.transport !== undefined && !['browser', 'agent'].includes(input.transport)) {
    throw new ApiError('CORE_PRINTER_TRANSPORT_INVALID', `Transporte inválido: ${input.transport}`, 400);
  }

  /*
    A BOBINA DE CUPOM É DE 58 OU DE 80 mm (auditoria do cupom, F-17).

    A largura era gravada como veio, sem conferência. Pela API dava para
    cadastrar a térmica como "57" (a medida escrita na bobina) ou "65" (erro de
    digitação) — e o agente, que só reconhecia exatamente 58, mandava 48
    colunas para uma impressora de 32. Agora 57/58 viram 58, 79/80 viram 80, e
    o resto é recusado com a frase que manda conferir a embalagem.
  */
  let larguraDoPapel: number | null = input.paperWidthMm ?? null;
  if (input.kind === 'cupom') {
    const cadastrada = larguraDoCupomCadastrada(input.paperWidthMm);
    if (cadastrada === undefined) {
      throw new ApiError(
        'CORE_PRINTER_PAPER_WIDTH_INVALID',
        `A bobina de impressora de cupom é de 58 mm ou de 80 mm (57 e 79, a medida escrita na caixa `
          + `da bobina, também valem). Recebido: ${String(input.paperWidthMm)}. Confira a largura na `
          + 'embalagem da bobina e escolha 58 ou 80.',
        400,
        { paperWidthMm: input.paperWidthMm },
      );
    }
    larguraDoPapel = cadastrada;
  }

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();

    const existing = input.id
      ? (db
          .prepare('SELECT * FROM core_printers WHERE id = ? AND company_id = ?')
          .get(input.id, input.companyId) as Printer | undefined)
      : undefined;

    // O caixa e o endereço: ausentes mantêm o que havia; vazios limpam.
    const caixa =
      input.pdvTerminalId === undefined
        ? (existing?.pdv_terminal_id ?? null)
        : (input.pdvTerminalId ? String(input.pdvTerminalId) : null);
    if (caixa && caixa !== (existing?.pdv_terminal_id ?? null)) {
      assertTerminalDaEmpresa(input.companyId, caixa, { exigirAtivo: true });
    }
    let endereco =
      input.agentDevice === undefined
        ? (existing?.agent_device ?? null)
        : (input.agentDevice ? String(input.agentDevice).trim() || null : null);
    if (endereco) {
      const lido = lerDestinoDaImpressora(endereco);
      if (!lido.ok) throw new ApiError('CORE_PRINTER_DEVICE_INVALID', lido.motivo, 400);
      endereco = lido.destino.endereco;
    }

    if (existing) {
      db.prepare(
        `UPDATE core_printers
            SET name = ?, kind = ?, transport = ?, paper_width_mm = ?, active = ?, updated_at = ?,
                pdv_terminal_id = ?, agent_device = ?
          WHERE id = ?`,
      ).run(
        input.name.trim(),
        input.kind,
        input.transport ?? 'browser',
        larguraDoPapel,
        input.active === false ? 0 : 1,
        now,
        caixa,
        endereco,
        id,
      );
    } else {
      db.prepare(
        `INSERT INTO core_printers
           (id, company_id, name, kind, transport, paper_width_mm, is_default, active,
            created_at, updated_at, pdv_terminal_id, agent_device)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.companyId,
        input.name.trim(),
        input.kind,
        input.transport ?? 'browser',
        larguraDoPapel,
        input.active === false ? 0 : 1,
        now,
        now,
        caixa,
        endereco,
      );
    }

    // Só uma padrão por tipo: duas padrões fariam o sistema escolher sozinho e
    // o cupom sair na impressora de etiqueta.
    if (input.isDefault) {
      db.prepare(
        'UPDATE core_printers SET is_default = 0 WHERE company_id = ? AND kind = ?',
      ).run(input.companyId, input.kind);
      db.prepare('UPDATE core_printers SET is_default = 1 WHERE id = ?').run(id);
    }

    return db.prepare('SELECT * FROM core_printers WHERE id = ?').get(id) as unknown as Printer;
  });
}

export interface SituacaoDaImpressora {
  printerId: string;
  name: string;
  kind: Printer['kind'];
  transport: PrintTransport;
  active: boolean;
  pdvTerminalId: string | null;
  pdvTerminalName: string | null;
  agentDevice: string | null;
  agent: AgenteDaImpressora | null;
  /** A última página de teste pedida para esta impressora, e o que o agente disse. */
  lastTest: { jobId: string; status: PrintStatus; at: string; error: string | null } | null;
  /** Impressora de agente que imprime AGORA: endereço, agente no ar. */
  ready: boolean;
  /** O que falta, em uma frase; nulo quando nada falta (ou é de navegador). */
  problem: string | null;
}

export interface PrintReadiness {
  /** Existe impressora configurada para este tipo? */
  configured: boolean;
  /**
   * Sem impressora física e sem agente local, o estado é
   * `READY_FOR_HARDWARE` — nunca `HOMOLOGATED`. `AGENT_READY` só com agente
   * no ar e página de teste CONFIRMADA pelo agente naquela impressora.
   */
  readiness: 'READY_FOR_HARDWARE' | 'BROWSER_ONLY' | 'AGENT_READY';
  message: string;
  printers: SituacaoDaImpressora[];
}

function ultimoTeste(companyId: string, printerId: string): SituacaoDaImpressora['lastTest'] {
  const r = getConnection()
    .prepare(
      `SELECT id, status, created_at, printed_at, error FROM core_print_jobs
        WHERE company_id = ? AND printer_id = ? AND document_type = 'PRINTER_TEST'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, printerId) as
    | { id: string; status: PrintStatus; created_at: string; printed_at: string | null; error: string | null }
    | undefined;
  return r ? { jobId: r.id, status: r.status, at: r.printed_at ?? r.created_at, error: r.error } : null;
}

export function situacaoDasImpressoras(companyId: string): SituacaoDaImpressora[] {
  return listPrinters(companyId).map((p) => {
    const agente = p.transport === 'agent' ? agenteDaImpressora(companyId, p) : null;
    const problem = p.active === 1 ? oQueFaltaNaImpressoraDeAgente(companyId, p) : null;
    return {
      printerId: p.id,
      name: p.name,
      kind: p.kind,
      transport: p.transport,
      active: p.active === 1,
      pdvTerminalId: p.pdv_terminal_id ?? null,
      pdvTerminalName: nomeDoCaixa(companyId, p.pdv_terminal_id ?? null),
      agentDevice: p.agent_device ?? null,
      agent: agente,
      lastTest: p.transport === 'agent' ? ultimoTeste(companyId, p.id) : null,
      ready: p.transport === 'agent' && p.active === 1 && problem === null,
      problem,
    };
  });
}

/**
 * O que o sistema consegue fazer hoje com impressão.
 *
 * O navegador NÃO imprime em silêncio: ele abre a caixa de diálogo do sistema.
 * Impressão direta só pelo agente local — e só se afirma quando o agente está
 * no ar e já imprimiu a página de teste naquela impressora.
 */
export function printReadiness(companyId: string): PrintReadiness {
  ensureCoreSchema();
  const situacao = situacaoDasImpressoras(companyId);
  const ativas = situacao.filter((p) => p.active);
  /*
    SÓ A IMPRESSORA DE CUPOM CONTA COMO IMPRESSÃO DIRETA (auditoria PJ,
    C-etiquetas-11).

    O DEFEITO: `deAgente` e `homologadas` contavam impressora de QUALQUER
    tipo. Uma etiqueta cadastrada como "agente" antes da trava do cadastro,
    com uma página de teste confirmada (o agente confirma a ESCRITA dos bytes,
    mesmo que a Argox/Zebra imprima lixo), fazia a prontidão dizer
    AGENT_READY — "impressão direta" numa loja em que nenhum cupom sai pelo
    agente, e em que a etiqueta nunca sai por ele (não tem layout térmico).
    Agora só a de cupom entra nas duas contas; a etiqueta/A4 marcada como
    agente aparece na lista com o que fazer (`oQueFaltaNaImpressoraDeAgente`).
  */
  const deAgente = ativas.filter((p) => p.transport === 'agent' && p.kind === 'cupom');
  const foraDoAgente = ativas.find((p) => p.transport === 'agent' && p.kind !== 'cupom');

  if (ativas.length === 0) {
    return {
      configured: false,
      readiness: 'READY_FOR_HARDWARE',
      message:
        'Nenhuma impressora configurada. Os documentos podem ser gerados e impressos pelo navegador, com a caixa de diálogo do sistema.',
      printers: situacao,
    };
  }
  if (deAgente.length > 0) {
    const homologadas = deAgente.filter((p) => p.ready && p.lastTest?.status === 'printed');
    if (homologadas.length > 0) {
      const faltam = deAgente.length - homologadas.length;
      return {
        configured: true,
        readiness: 'AGENT_READY',
        message:
          `Impressão direta pelo agente local: ${homologadas.length} impressora(s) com página de teste confirmada.`
          + (faltam > 0 ? ` ${faltam} ainda não: veja o que falta em cada uma.` : ''),
        printers: situacao,
      };
    }
    const primeiroProblema = deAgente.find((p) => p.problem)?.problem;
    return {
      configured: true,
      readiness: 'READY_FOR_HARDWARE',
      message: primeiroProblema
        ? `${primeiroProblema} Até resolver, a impressão continua saindo pelo navegador.`
        : 'O agente local está no ar: imprima a página de teste para confirmar a impressora antes de contar com ela no balcão.',
      printers: situacao,
    };
  }
  return {
    configured: true,
    readiness: 'BROWSER_ONLY',
    message:
      'Impressão pelo navegador: a caixa de diálogo do sistema é aberta. Impressão silenciosa exige o agente local.'
      + (foraDoAgente?.problem ? ` ${foraDoAgente.problem}` : ''),
    printers: situacao,
  };
}

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * O papel da página de teste e da abertura da gaveta, na versão HTML: é o que
 * `/print/jobs/:id/document` devolve se alguém abrir o job pela tela. O que a
 * térmica recebe sai de `PrintAgentQueue.bytesDoJob`.
 */
export function papelSimples(titulo: string, linhas: string[]): string {
  return (
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escaparHtml(titulo)}</title></head>`
    + `<body style="font-family:monospace;width:72mm"><h1 style="font-size:14px">${escaparHtml(titulo)}</h1>`
    + linhas.map((l) => `<p style="margin:2px 0">${escaparHtml(l)}</p>`).join('')
    + '</body></html>'
  );
}

/*
  Aqui existiu um `assertFiscalDocumentAllowed`, cujo comentário prometia
  "documento fiscal só é enfileirado com autorização real". A trava é
  NECESSÁRIA — e já roda, só que em outro lugar: `renderDanfce` e `renderDanfe`
  recusam documento não autorizado, e TODO caminho até `createPrintJob` passa
  por eles (`POST /print/jobs` renderiza antes de enfileirar; a segunda via
  reaproveita um payload que só pôde nascer autorizado). Esta função era uma
  cópia da trava que nunca rodou — e o comentário dela fazia parecer que a
  proteção morava aqui. Guarda de verdade tem chamador; esta saiu MEDIDA.
*/
