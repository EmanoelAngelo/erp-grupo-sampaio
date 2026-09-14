/**
 * O TRABALHADOR DA FILA FISCAL — GAP-PRD-020.
 *
 * ## O que a auditoria mediu
 *
 * `processNext` só tinha dois chamadores, os dois dentro da emissão de uma
 * venda (`advanceDocument`): a fila andava UM item por requisição, e só quando
 * alguém da MESMA empresa emitia outra nota. Uma queda da SEFAZ às 10h deixava
 * as notas pendentes até a venda seguinte — e a venda seguinte transmitia a
 * nota VELHA (o item mais antigo) e devolvia a própria como "aguardando
 * transmissão". O backoff de 1/5/15/60/240 min só corria se houvesse emissões,
 * e o caixa via "Aguardando transmissão" indefinidamente.
 *
 * ## O que este módulo faz
 *
 * Um laço de fundo, no backend, independente de navegador aberto (o molde do
 * `MailInboxScheduler` e da agenda do contador): a cada tique ele
 *
 *  1. SONDA a SEFAZ para as empresas cuja fila espera por indisponibilidade —
 *     o serviço de status é barato — e, se ela voltou, antecipa as novas
 *     tentativas dessas notas para AGORA: a volta da rede reprocessa sozinha,
 *     sem esperar o fim de um backoff de uma hora;
 *  2. DRENA, por empresa, TODOS os itens vencidos (até um teto por passada),
 *     cada um com o adapter certo para a PROCEDÊNCIA da nota — o A1 do cofre da
 *     própria empresa para nota assinada de verdade, o simulador só para nota
 *     de ensaio e nunca em produção;
 *  3. para a empresa na primeira indisponibilidade: se a SEFAZ caiu, as outras
 *     notas daquela empresa não gastam tentativa contra um serviço fora do ar
 *     nesta passada — cada uma segue com o próprio backoff.
 *
 * Uma empresa que falha não segura as outras: cada uma é drenada dentro do
 * próprio `try`, com o próprio certificado.
 *
 * ## O que ele NÃO faz
 *
 *  - Não reenvia às cegas: quem transmite continua sendo `processNext`, com a
 *    consulta antes de qualquer reenvio depois de timeout.
 *  - Não inventa certificado: nota assinada de verdade sem A1 no cofre ESPERA
 *    (sem gastar tentativa), com o motivo gravado no item para a tela dizer.
 *  - Não põe nota de ensaio para falar com a SEFAZ em produção: o item é
 *    parado (`dead`) com o motivo, e vira pendência.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError, logError, logInfo } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { getDocument, type FiscalDocument } from './FiscalDocumentService.js';
import type { FiscalEnvironment } from './FiscalKeyService.js';
import { FIXTURE_SIGNATURE_MARK, certificadoDoCofre } from './FiscalPipelineService.js';
import { processNext, recoverStaleItems, type ProcessResult } from './FiscalQueueService.js';
import { requeueFromContingency } from './FiscalContingencyService.js';
import { anotarSondagemNoPeriodo, encerrarPeriodo, periodoAtivo } from './FiscalContingenciaOffline.js';
import { exigeAdapterReal, type SefazAdapter } from './SefazAdapter.js';
import { SefazRealAdapter } from './SefazRealAdapter.js';
import { SefazTestAdapter, isTestProtocol } from './SefazTestAdapter.js';
import type { ParsedCertificateA1 } from '../fiscal/FiscalCertificateService.js';

/** O tique do laço. Quem decide se um item está vencido é o `next_attempt_at` dele. */
export const TICK_MS = 60_000;

/** De quanto em quanto tempo, no máximo, perguntar à SEFAZ se ela voltou. */
export const SONDAGEM_MS = 2 * 60_000;

/**
 * Teto de transmissões por empresa numa passada. Uma fila de 300 notas depois
 * de uma tarde sem rede não pode monopolizar o processo por minutos: o resto
 * sai na passada seguinte, um minuto depois.
 */
export const LIMITE_POR_EMPRESA = 50;

/**
 * Códigos gravados no item quando a falha foi INDISPONIBILIDADE (rede, timeout
 * sem resposta conclusiva, serviço paralisado) — os únicos que a volta da SEFAZ
 * resolve sozinha. Rejeição fiscal nunca chega aqui: ela não se retenta.
 */
export const CODIGOS_DE_INDISPONIBILIDADE = [
  'NETWORK_ERROR',
  'TIMEOUT',
  'TRANSPORT_ERROR',
  'SERVICE_DOWN',
  '108',
  '109',
  '999',
] as const;

/** Desfechos de `processNext` que dizem: a SEFAZ (ou o caminho até ela) está fora. */
export function desfechoDeIndisponibilidade(outcome: string | undefined): boolean {
  return (
    outcome === 'NETWORK_ERROR'
    || outcome === 'TIMEOUT'
    || outcome === 'TRANSPORT_ERROR'
    || outcome === 'SERVICE_DOWN'
    || outcome === 'CONTINGENCY'
  );
}

// ------------------------------------------------------------ o adapter

/**
 * O que a fila pode fazer com uma nota, decidido pela procedência dela.
 *
 *  - `adapter`: transmitir por ele;
 *  - `espera`: ainda não dá (sem A1 no cofre) — o item fica onde está, sem
 *    gastar tentativa, com o motivo anotado;
 *  - `bloqueio`: nunca vai dar por este caminho (nota de ensaio com a operação
 *    ou o processo em produção) — o item para, com o motivo, e vira pendência.
 */
export type EscolhaDoAdapter =
  | { tipo: 'adapter'; adapter: SefazAdapter }
  | { tipo: 'espera'; codigo: string; motivo: string }
  | { tipo: 'bloqueio'; codigo: string; motivo: string };

/** Nota de ENSAIO: assinada pela fixture de desenvolvimento ou com protocolo de teste. */
function notaDeEnsaio(companyId: string, doc: FiscalDocument): boolean {
  if (isTestProtocol(doc.protocol)) return true;
  const row = getConnection()
    .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ? AND company_id = ?')
    .get(doc.id, companyId) as { xml_signed: string | null } | undefined;
  return String(row?.xml_signed ?? '').includes(FIXTURE_SIGNATURE_MARK);
}

function ambiente(doc: FiscalDocument): FiscalEnvironment {
  return doc.environment === 'production' ? 'production' : 'homologation';
}

/**
 * O certificado da empresa, aberto UMA vez por passada — abrir o `.pfx` custa
 * decifrar a senha selada, e a passada pode transmitir dezenas de notas.
 */
export type CacheDeCertificados = Map<string, ParsedCertificateA1 | ApiError | null>;

function certificadoDaPassada(companyId: string, cache: CacheDeCertificados): ParsedCertificateA1 | ApiError | null {
  if (cache.has(companyId)) return cache.get(companyId) ?? null;
  let valor: ParsedCertificateA1 | ApiError | null;
  try {
    valor = certificadoDoCofre(companyId);
  } catch (err) {
    valor = err instanceof ApiError
      ? err
      : new ApiError('FISCAL_CERTIFICATE_UNREADABLE', 'O certificado do cofre não pôde ser aberto.', 500);
  }
  cache.set(companyId, valor);
  return valor;
}

/**
 * O adapter da fila para UMA nota — pela procedência, nunca por pedido.
 *
 * É a mesma régua da emissão (`advanceDocument`) e dos atos administrativos
 * (`FiscalAtosAdministrativos`): nota de ensaio só pelo simulador e nunca em
 * produção (da nota, da operação ou do processo — `exigeAdapterReal`); nota
 * assinada de verdade só pela SEFAZ, com o A1 da própria empresa.
 */
export function adapterDaFila(
  companyId: string,
  doc: FiscalDocument,
  cache: CacheDeCertificados = new Map(),
): EscolhaDoAdapter {
  if (notaDeEnsaio(companyId, doc)) {
    const operacao = getFiscalConfig(companyId).environment;
    if (exigeAdapterReal(ambiente(doc)) || exigeAdapterReal(operacao)) {
      return {
        tipo: 'bloqueio',
        codigo: 'CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION',
        motivo:
          'Nota de ensaio (assinatura de desenvolvimento) não é transmitida com a operação ou o '
          + 'servidor em produção — ela não existe para o fisco. Emita a nota de novo com o A1.',
      };
    }
    return { tipo: 'adapter', adapter: new SefazTestAdapter() };
  }

  const cert = certificadoDaPassada(companyId, cache);
  if (cert instanceof ApiError) {
    return { tipo: 'espera', codigo: cert.code, motivo: cert.message };
  }
  if (!cert) {
    return {
      tipo: 'espera',
      codigo: 'FISCAL_CERTIFICATE_NOT_FOUND',
      motivo:
        'A nota está assinada e espera o certificado A1 no cofre para ser transmitida. Envie o '
        + '.pfx com a senha em Fiscal › Certificado — a fila retoma sozinha.',
    };
  }
  return { tipo: 'adapter', adapter: new SefazRealAdapter({ cert }) };
}

/** Quem escolhe o adapter numa passada. O teste injeta o dele; a produção usa `adapterDaFila`. */
export type EscolhedorDeAdapter = (
  companyId: string,
  doc: FiscalDocument,
  cache: CacheDeCertificados,
) => EscolhaDoAdapter;

// -------------------------------------------------------- o estado visível

export interface SondagemDaSefaz {
  em: string;
  online: boolean;
  cStat: string | null;
  xMotivo: string | null;
  fonte: 'sefaz' | 'test' | 'falha';
}

/** A última pergunta feita à SEFAZ por empresa. Estado do processo, para a tela. */
const sondagens = new Map<string, SondagemDaSefaz>();

export function ultimaSondagem(companyId: string): SondagemDaSefaz | null {
  return sondagens.get(companyId) ?? null;
}

export interface EstadoDoTrabalhador {
  ligado: boolean;
  tickMs: number | null;
  ultimaPassada: string | null;
  ultimaPassadaResumo: ResultadoDaPassada | null;
  ultimoErro: string | null;
}

const estado: EstadoDoTrabalhador = {
  ligado: false,
  tickMs: null,
  ultimaPassada: null,
  ultimaPassadaResumo: null,
  ultimoErro: null,
};

export function estadoDoTrabalhador(): EstadoDoTrabalhador {
  return { ...estado };
}

// ------------------------------------------------------------- a sondagem

/** Anota o motivo da espera no item — só quando muda, para não reescrever a cada minuto. */
function anotarEspera(itemId: string, codigo: string, motivo: string, now: Date): void {
  getConnection()
    .prepare(
      `UPDATE core_fiscal_queue SET error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND (COALESCE(error_code, '') <> ? OR COALESCE(error_message, '') <> ?)`,
    )
    .run(codigo, motivo, now.toISOString(), itemId, codigo, motivo);
}

/** Para o item com o motivo: ninguém mais o reivindica, e ele aparece nas pendências. */
function pararItem(item: { id: string; companyId: string; documentId: string }, codigo: string, motivo: string, now: Date): void {
  getConnection()
    .prepare(
      `UPDATE core_fiscal_queue
          SET status = 'dead', next_attempt_at = NULL, error_code = ?, error_message = ?,
              locked_until = NULL, locked_by = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(codigo, motivo, now.toISOString(), item.id);
  recordAudit({
    companyId: item.companyId,
    userId: null,
    action: 'fiscal.queue_blocked',
    entityType: 'fiscal_document',
    entityId: item.documentId,
    detail: { codigo, motivo, origem: 'trabalhador-da-fila' },
  });
}

/**
 * Empresas cuja fila ESPERA por indisponibilidade: itens em `retry` ainda não
 * vencidos, cujo último erro foi rede/timeout/serviço fora. São as que a volta
 * da SEFAZ destrava — e as únicas que vale sondar.
 */
function empresasEsperandoASefaz(now: Date): { companyId: string; documentId: string | null }[] {
  const db = getConnection();
  const codigos = CODIGOS_DE_INDISPONIBILIDADE.map(() => '?').join(', ');
  const porEmpresa = new Map<string, string | null>();

  // 1. Notas em nova tentativa por indisponibilidade, ainda não vencidas.
  for (const r of db
    .prepare(
      `SELECT q.company_id AS companyId, MIN(q.document_id) AS documentId
         FROM core_fiscal_queue q
        WHERE q.status = 'retry'
          AND q.next_attempt_at > ?
          AND q.error_code IN (${codigos})
        GROUP BY q.company_id`,
    )
    .all(now.toISOString(), ...CODIGOS_DE_INDISPONIBILIDADE) as unknown as { companyId: string; documentId: string }[]) {
    porEmpresa.set(r.companyId, r.documentId);
  }

  // 2. Notas que desistiram por indisponibilidade e entraram em contingência
  //    (a regra antiga, das cinco tentativas) — a volta da SEFAZ as devolve.
  for (const r of db
    .prepare(
      `SELECT d.company_id AS companyId, MIN(d.id) AS documentId
         FROM core_fiscal_documents d
         JOIN core_fiscal_queue q ON q.document_id = d.id
        WHERE d.status = 'CONTINGENCY' AND q.status = 'dead' AND q.error_code IN (${codigos})
        GROUP BY d.company_id`,
    )
    .all(...CODIGOS_DE_INDISPONIBILIDADE) as unknown as { companyId: string; documentId: string }[]) {
    if (!porEmpresa.has(r.companyId)) porEmpresa.set(r.companyId, r.documentId);
  }

  // 3. Operações com período de contingência aberto (GAP-PRD-098): é a
  //    sondagem que fecha o período quando a SEFAZ volta.
  for (const r of db
    .prepare(
      `SELECT p.company_id AS companyId,
              (SELECT q.document_id FROM core_fiscal_queue q
                 JOIN core_fiscal_documents d ON d.id = q.document_id
                WHERE q.company_id = p.company_id AND d.model = '65'
                  AND q.status IN ('pending', 'retry')
                ORDER BY q.created_at LIMIT 1) AS documentId
         FROM core_fiscal_contingency_periods p
        WHERE p.ended_at IS NULL`,
    )
    .all() as unknown as { companyId: string; documentId: string | null }[]) {
    if (!porEmpresa.get(r.companyId)) porEmpresa.set(r.companyId, r.documentId);
  }

  return [...porEmpresa].map(([companyId, documentId]) => ({ companyId, documentId }));
}

/**
 * O adapter da SONDAGEM quando não há nota a quem perguntar a procedência (o
 * período aberto à mão, antes de qualquer venda): o A1 do cofre, ou o
 * simulador fora de produção. O serviço de status não carrega documento.
 */
function adapterDeSondagem(companyId: string, cache: CacheDeCertificados): SefazAdapter | null {
  const cert = certificadoDaPassada(companyId, cache);
  if (cert && !(cert instanceof ApiError)) return new SefazRealAdapter({ cert });
  if (!exigeAdapterReal(getFiscalConfig(companyId).environment)) return new SefazTestAdapter();
  return null;
}

/**
 * A SEFAZ voltou para esta operação (GAP-PRD-098): o período de contingência
 * fecha e as notas que tinham desistido por indisponibilidade voltam à fila —
 * o mesmo documento, o mesmo número, a mesma chave.
 */
function devolverAoTrabalho(
  companyId: string,
  s: SondagemDaSefaz,
  now: Date,
): { periodoEncerrado: boolean; devolvidas: number } {
  const periodo = encerrarPeriodo({
    companyId,
    origem: 'AUTOMATICA',
    cStat: s.cStat,
    motivo: 'A sondagem da SEFAZ respondeu em operação.',
  });
  const codigos = CODIGOS_DE_INDISPONIBILIDADE.map(() => '?').join(', ');
  const legadas = getConnection()
    .prepare(
      `SELECT d.id FROM core_fiscal_documents d
         JOIN core_fiscal_queue q ON q.document_id = d.id
        WHERE d.company_id = ? AND d.status = 'CONTINGENCY' AND q.status = 'dead'
          AND q.error_code IN (${codigos})`,
    )
    .all(companyId, ...CODIGOS_DE_INDISPONIBILIDADE) as unknown as { id: string }[];
  let devolvidas = 0;
  for (const { id } of legadas) {
    try {
      requeueFromContingency({ companyId, documentId: id, userId: null });
      // No relógio desta passada: a drenagem logo abaixo já a leva.
      getConnection()
        .prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE company_id = ? AND document_id = ?')
        .run(now.toISOString(), companyId, id);
      devolvidas += 1;
    } catch (err) {
      logError('FISCAL_QUEUE_WORKER_REQUEUE_FAILED', { companyId, documentId: id, error: String(err) });
    }
  }
  return { periodoEncerrado: periodo !== null, devolvidas };
}

/**
 * Pergunta à SEFAZ se ela está no ar, com o adapter da procedência da nota.
 *
 * Falha de transporte na sondagem é resposta ("fora"), não exceção: a rede
 * que caiu é justamente o que se está perguntando.
 */
export async function sondarSefaz(
  companyId: string,
  doc: FiscalDocument | null,
  escolher: EscolhedorDeAdapter,
  cache: CacheDeCertificados,
  now: Date,
): Promise<SondagemDaSefaz | null> {
  let adapter: SefazAdapter | null;
  if (doc) {
    const escolha = escolher(companyId, doc, cache);
    adapter = escolha.tipo === 'adapter' ? escolha.adapter : null;
  } else {
    adapter = adapterDeSondagem(companyId, cache);
  }
  if (!adapter) return null;
  const config = getFiscalConfig(companyId);
  let sondagem: SondagemDaSefaz;
  try {
    const s = await adapter.statusServico({
      uf: config.uf ?? '',
      environment: doc ? ambiente(doc) : config.environment,
      model: doc?.model ?? '65',
    });
    sondagem = { em: now.toISOString(), online: s.online, cStat: s.cStat, xMotivo: s.xMotivo, fonte: s.source };
  } catch (err) {
    sondagem = {
      em: now.toISOString(),
      online: false,
      cStat: null,
      xMotivo: err instanceof Error ? err.message : 'Sem resposta do serviço de status.',
      fonte: 'falha',
    };
  }
  sondagens.set(companyId, sondagem);
  return sondagem;
}

/**
 * A SEFAZ voltou: as notas que esperavam por indisponibilidade são antecipadas
 * para agora. O contador de tentativas NÃO volta a zero — ele conta tentativas
 * reais, e é ele que decide quando a nota desiste.
 */
function anteciparEsperasDeIndisponibilidade(companyId: string, now: Date): number {
  const codigos = CODIGOS_DE_INDISPONIBILIDADE.map(() => '?').join(', ');
  const r = getConnection()
    .prepare(
      `UPDATE core_fiscal_queue SET next_attempt_at = ?, updated_at = ?
        WHERE company_id = ? AND status = 'retry' AND next_attempt_at > ?
          AND error_code IN (${codigos})`,
    )
    .run(now.toISOString(), now.toISOString(), companyId, now.toISOString(), ...CODIGOS_DE_INDISPONIBILIDADE);
  return Number(r.changes);
}

/** Quanto tempo desde a última sondagem desta empresa. */
function podeSondar(companyId: string, now: Date): boolean {
  const ultima = sondagens.get(companyId);
  return !ultima || now.getTime() - new Date(ultima.em).getTime() >= SONDAGEM_MS;
}

// ---------------------------------------------------------------- a drenagem

export interface ResultadoDaEmpresa {
  companyId: string;
  transmitidos: number;
  esperando: number;
  bloqueados: number;
  /** O desfecho que fez a passada parar para esta empresa, quando parou. */
  paradaPor: string | null;
  erro: string | null;
}

/**
 * Drena a fila de UMA empresa: todos os itens vencidos, até o teto, cada um
 * com o adapter da procedência dele. Para na primeira indisponibilidade.
 *
 * Exportada para a rota "transmitir pendentes agora" e para o teste.
 */
export async function drenarEmpresa(input: {
  companyId: string;
  now?: Date;
  escolher?: EscolhedorDeAdapter;
  limite?: number;
  userId?: string | null;
  cache?: CacheDeCertificados;
}): Promise<ResultadoDaEmpresa> {
  ensureCoreSchema();
  const now = input.now ?? new Date();
  const escolher = input.escolher ?? adapterDaFila;
  const cache = input.cache ?? new Map();
  const limite = input.limite ?? LIMITE_POR_EMPRESA;
  const resultado: ResultadoDaEmpresa = {
    companyId: input.companyId,
    transmitidos: 0,
    esperando: 0,
    bloqueados: 0,
    paradaPor: null,
    erro: null,
  };

  // Item travado por processo que morreu volta antes — para CONSULTA.
  recoverStaleItems(input.companyId, now);

  /*
    PERÍODO DE CONTINGÊNCIA ABERTO (GAP-PRD-098): a SEFAZ da NFC-e está fora,
    e as NFC-e da operação ESPERAM — quem fecha o período é a sondagem. Gastar
    tentativa contra o serviço fora só empurraria o backoff das notas off-line
    para perto do prazo. A NF-e (outro host) segue a vida.
  */
  const nfcePausada = periodoAtivo(input.companyId) !== null;
  const pausa = nfcePausada
    ? `AND document_id NOT IN (SELECT id FROM core_fiscal_documents WHERE company_id = ? AND model = '65')`
    : '';

  const vistos: string[] = [];
  while (resultado.transmitidos < limite) {
    const agora = now.toISOString();
    const filtro = vistos.length ? `AND id NOT IN (${vistos.map(() => '?').join(', ')})` : '';
    const proximo = getConnection()
      .prepare(
        `SELECT id, document_id FROM core_fiscal_queue
          WHERE company_id = ?
            AND status IN ('pending', 'retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (locked_until IS NULL OR locked_until <= ?)
            ${pausa}
            ${filtro}
          ORDER BY next_attempt_at, created_at
          LIMIT 1`,
      )
      .get(
        input.companyId,
        agora,
        agora,
        ...(nfcePausada ? [input.companyId] : []),
        ...vistos,
      ) as { id: string; document_id: string } | undefined;
    if (!proximo) break;
    vistos.push(proximo.id);

    const doc = getDocument(input.companyId, proximo.document_id);
    if (!doc) continue;

    const escolha = escolher(input.companyId, doc, cache);
    if (escolha.tipo === 'espera') {
      anotarEspera(proximo.id, escolha.codigo, escolha.motivo, now);
      resultado.esperando += 1;
      continue;
    }
    if (escolha.tipo === 'bloqueio') {
      pararItem(
        { id: proximo.id, companyId: input.companyId, documentId: doc.id },
        escolha.codigo,
        escolha.motivo,
        now,
      );
      resultado.bloqueados += 1;
      continue;
    }

    let r: ProcessResult;
    try {
      r = await processNext({
        companyId: input.companyId,
        adapter: escolha.adapter,
        now,
        documentId: doc.id,
        userId: input.userId ?? null,
      });
    } catch (err) {
      // Um documento que derruba o processamento não derruba a fila inteira.
      resultado.erro = err instanceof Error ? err.message : String(err);
      logError('FISCAL_QUEUE_WORKER_ITEM_FAILED', { companyId: input.companyId, documentId: doc.id, error: resultado.erro });
      continue;
    }
    if (!r.processed) continue;
    resultado.transmitidos += 1;
    if (desfechoDeIndisponibilidade(r.outcome)) {
      resultado.paradaPor = r.outcome ?? null;
      break;
    }
  }

  return resultado;
}

/** Empresas com trabalho vencido (ou item travado por processo que morreu). */
function empresasComTrabalho(now: Date): string[] {
  const agora = now.toISOString();
  return (
    getConnection()
      .prepare(
        `SELECT DISTINCT company_id FROM core_fiscal_queue
          WHERE (status IN ('pending', 'retry')
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                 AND (locked_until IS NULL OR locked_until <= ?))
             OR (status = 'sending' AND locked_until IS NOT NULL AND locked_until <= ?)`,
      )
      .all(agora, agora, agora) as unknown as { company_id: string }[]
  ).map((r) => r.company_id);
}

export interface ResultadoDaPassada {
  em: string;
  sondadas: number;
  antecipadas: number;
  empresas: ResultadoDaEmpresa[];
}

/**
 * Uma passada do trabalhador. Exportada para o teste chamá-la sem relógio.
 */
export async function runFiscalQueueTick(input: {
  now?: Date;
  escolher?: EscolhedorDeAdapter;
} = {}): Promise<ResultadoDaPassada> {
  ensureCoreSchema();
  const now = input.now ?? new Date();
  const escolher = input.escolher ?? adapterDaFila;
  const cache: CacheDeCertificados = new Map();
  let sondadas = 0;
  let antecipadas = 0;

  // 1. A SEFAZ voltou? Só para quem espera por ela, e no máximo a cada SONDAGEM_MS.
  for (const espera of empresasEsperandoASefaz(now)) {
    if (!podeSondar(espera.companyId, now)) continue;
    const doc = espera.documentId ? getDocument(espera.companyId, espera.documentId) : null;
    try {
      const s = await sondarSefaz(espera.companyId, doc, escolher, cache, now);
      if (!s) continue;
      sondadas += 1;
      if (s.online) {
        // O período fecha e as notas que desistiram voltam — ANTES de
        // antecipar, para que as devolvidas entrem na drenagem desta passada.
        const volta = devolverAoTrabalho(espera.companyId, s, now);
        const n = anteciparEsperasDeIndisponibilidade(espera.companyId, now);
        antecipadas += n + volta.devolvidas;
        if (n > 0 || volta.devolvidas > 0 || volta.periodoEncerrado) {
          recordAudit({
            companyId: espera.companyId,
            userId: null,
            action: 'fiscal.sefaz_back_online',
            entityType: 'fiscal_queue',
            entityId: espera.companyId,
            detail: {
              cStat: s.cStat,
              antecipadas: n,
              devolvidasDaContingencia: volta.devolvidas,
              periodoEncerrado: volta.periodoEncerrado,
              origem: 'trabalhador-da-fila',
            },
          });
        }
      } else {
        anotarSondagemNoPeriodo(espera.companyId, { em: s.em, cStat: s.cStat, xMotivo: s.xMotivo });
      }
    } catch (err) {
      logError('FISCAL_QUEUE_WORKER_PROBE_FAILED', { companyId: espera.companyId, error: String(err) });
    }
  }

  // 2. Drena cada empresa com trabalho vencido — isoladas umas das outras.
  const empresas: ResultadoDaEmpresa[] = [];
  for (const companyId of empresasComTrabalho(now)) {
    try {
      empresas.push(await drenarEmpresa({ companyId, now, escolher, cache }));
    } catch (err) {
      const erro = err instanceof Error ? err.message : String(err);
      empresas.push({ companyId, transmitidos: 0, esperando: 0, bloqueados: 0, paradaPor: null, erro });
      logError('FISCAL_QUEUE_WORKER_COMPANY_FAILED', { companyId, error: erro });
    }
  }

  return { em: now.toISOString(), sondadas, antecipadas, empresas };
}

// ------------------------------------------------------------- o laço de fundo

let timer: NodeJS.Timeout | null = null;

/** Duas passadas não se atropelam: quem chega durante uma espera o resultado dela. */
let passadaEmVoo: Promise<ResultadoDaPassada> | null = null;

async function tique(): Promise<ResultadoDaPassada> {
  if (passadaEmVoo) return passadaEmVoo;
  passadaEmVoo = runFiscalQueueTick()
    .then((r) => {
      estado.ultimaPassada = r.em;
      estado.ultimaPassadaResumo = r;
      estado.ultimoErro = r.empresas.find((e) => e.erro)?.erro ?? null;
      return r;
    })
    .catch((err) => {
      estado.ultimoErro = String(err);
      throw err;
    })
    .finally(() => {
      passadaEmVoo = null;
    });
  return passadaEmVoo;
}

/**
 * Liga o trabalhador — roda já na subida (o servidor pode ter ficado desligado
 * com notas na fila) e a cada `tickMs` depois. Liga SEMPRE: sem certificado a
 * passada só anota a espera, sem gastar tentativa; quando o A1 chega ao cofre,
 * a fila anda sem reiniciar nada (a lição do trabalhador da central).
 *
 * Quem chama é o `index.ts`, ao lado dos outros trabalhadores.
 */
export function startFiscalQueueWorker(tickMs = TICK_MS): void {
  if (timer) return;
  void tique().catch((err) => logError('FISCAL_QUEUE_WORKER_TICK_FAILED', { error: String(err) }));
  timer = setInterval(() => {
    void tique().catch((err) => logError('FISCAL_QUEUE_WORKER_TICK_FAILED', { error: String(err) }));
  }, tickMs);
  // Não segura o processo: `npm test` e o desligamento não esperam o tique.
  timer.unref?.();
  estado.ligado = true;
  estado.tickMs = tickMs;
  logInfo('FISCAL_QUEUE_WORKER_STARTED', { tickMs });
}

export function stopFiscalQueueWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  estado.ligado = false;
  estado.tickMs = null;
}

/** Só para teste: esquece as sondagens e o estado entre casos. */
export function reiniciarEstadoDoTrabalhadorParaTeste(): void {
  sondagens.clear();
  estado.ultimaPassada = null;
  estado.ultimaPassadaResumo = null;
  estado.ultimoErro = null;
}
