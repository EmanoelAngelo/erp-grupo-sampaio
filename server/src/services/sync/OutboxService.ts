/**
 * Fila de saída para o banco central (Supabase/PostgreSQL).
 *
 * ARQUITETURA — por que o SQLite continua existindo
 *
 * O PDV precisa vender com a internet caída. Uma loja que para de faturar
 * porque o link oscilou é um problema maior do que qualquer relatório
 * consolidado resolve. Então o SQLite local segue sendo o banco OPERACIONAL,
 * com as transações e os invariantes onde sempre estiveram, e a Supabase é a
 * CENTRAL, que recebe os fatos quando a conexão volta.
 *
 * A consequência importante: o nó local é a autoridade sobre os fatos que ele
 * mesmo produz. A central consolida — ela não escreve de volta. Isso elimina
 * resolução de conflito, que é onde esse tipo de projeto costuma inventar
 * regra e perder dinheiro.
 *
 * A REGRA QUE SUSTENTA TUDO
 *
 * `enqueue` só funciona DENTRO da transação que grava o fato, e recusa
 * qualquer chamada fora dela. É isso que fecha o buraco clássico do padrão:
 * "gravou a venda e caiu antes de publicar". Com a fila na mesma transação,
 * ou os dois existem ou nenhum existe. Não há terceiro estado.
 *
 * ESTADOS
 *
 *   pending    → nunca saiu
 *   processing → entregue ao worker; ele pode ter morrido no meio
 *   synced     → a central CONFIRMOU
 *   retry      → falhou, tem hora marcada para tentar de novo
 *   dead       → esgotou as tentativas; precisa de gente olhando
 *
 * `processing` existe para distinguir "morreu no meio do envio" de "nunca
 * saiu". O reenvio de um `processing` é seguro porque a central é idempotente
 * por `id` — ver `SyncService`.
 *
 * O QUE NUNCA SAI DAQUI
 *
 * Segredo não vai para a central. Hash de senha, certificado, senha do
 * certificado, chave de API, token de webhook, token de sessão e dado de
 * cartão são removidos do payload — e agregados que existem só para guardar
 * segredo não são sincronizáveis de forma alguma.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, inTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export type OutboxStatus = 'pending' | 'processing' | 'synced' | 'retry' | 'dead';

/**
 * Depois disto, o evento RECUSADO para de tentar sozinho e espera uma pessoa.
 *
 * Só a recusa conta (GAP-PRD-047). Falha de transporte — a central fora do
 * ar — tenta para sempre: doze tentativas eram uns 25 minutos, e uma queda
 * de meia hora da Supabase deixava a fila inteira em `dead` até alguém
 * clicar em "Tentar novamente".
 */
export const MAX_ATTEMPTS = 12;

/** O teto da espera entre tentativas quando a central não responde. */
export const ESPERA_MAXIMA_TRANSPORTE_MS = 10 * 60_000;

/** O teto da espera entre tentativas de um evento recusado. */
const ESPERA_MAXIMA_RECUSA_MS = 5 * 60_000;

/**
 * As duas naturezas de falha, e o que cada uma faz com o evento.
 *
 *   TRANSPORTE — rede, tempo esgotado, 5xx, 408, 429: a central não disse
 *                nada sobre o evento. Insistir resolve; nunca vira `dead`.
 *   RECUSA     — 4xx determinístico, ou a central respondeu e não confirmou
 *                o evento: ela olhou e disse não. Conta para `MAX_ATTEMPTS`.
 */
export type NaturezaDaFalha = 'TRANSPORTE' | 'RECUSA';

/** Falha do envio com a natureza já decidida por quem conhece o protocolo. */
export class FalhaDaCentral extends Error {
  constructor(
    message: string,
    readonly natureza: NaturezaDaFalha,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'FalhaDaCentral';
  }
}

/** Estado HTTP que diz "não consegui responder agora", e não "não". */
export function statusEhTransporte(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * A natureza de uma falha qualquer.
 *
 * `FalhaDaCentral` já diz a sua. Para o resto (transportes de teste, erro de
 * biblioteca), o texto decide: erro de rede e HTTP 5xx/408/429 são
 * transporte. O DESCONHECIDO É RECUSA — a regra antiga (doze e para), que é o
 * lado seguro: tratar como transporte um erro que nunca vai passar faria o
 * evento tentar para sempre sem ninguém saber.
 */
export function naturezaDaFalha(err: unknown): NaturezaDaFalha {
  if (err instanceof FalhaDaCentral) return err.natureza;
  const texto = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  const http = /HTTP (\d{3})/.exec(texto);
  if (http) return statusEhTransporte(Number(http[1])) ? 'TRANSPORTE' : 'RECUSA';
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network|AbortError|TimeoutError/i.test(
      texto,
    )
  ) {
    return 'TRANSPORTE';
  }
  return 'RECUSA';
}

export interface OutboxRow {
  seq: number;
  id: string;
  node_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  company_id: string;
  operational_unit_id: string | null;
  operation: string;
  schema_version: number;
  payload: string;
  occurred_at: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  /** 'TRANSPORTE' | 'RECUSA' — ver `NaturezaDaFalha`. Nula em linha antiga. */
  last_error_kind?: string | null;
}

/**
 * Agregados que NUNCA são sincronizados.
 *
 * Não é uma lista de "dados sensíveis" genérica: é a lista do que existe só
 * para guardar segredo ou sessão. Replicar qualquer um deles na central não
 * traria informação de negócio — só mais um lugar de onde um segredo pode
 * vazar.
 */
export const NAO_SINCRONIZAVEIS = new Set([
  'core_secrets',
  'core_integration_secrets',
  'core_fiscal_certificates',
  'core_customer_sessions',
  'core_sessions',
  'core_refresh_tokens',
  'core_user_sessions',
  'secret',
  'session',
  'certificate',
]);

/**
 * Campos removidos do payload em qualquer agregado — POR PALAVRA (GAP-PRD-138).
 *
 * A comparação era por SUBSTRING, e isso apagava campo de negócio em silêncio:
 * `pan` (o número do cartão) está dentro de `company`, `expansion`, `panel` e
 * `span`; `token` está dentro de `tokens_total`; `secret` dentro de
 * `secretaria`. `company_id` e `company_name` sumiam do evento a caminho da
 * central. E a substring deixava passar o contrário: `privateKey` e
 * `cardNumber` (camelCase) não contêm `private_key` nem `card_number`.
 *
 * Agora o nome é quebrado em palavras (snake_case, camelCase, kebab, siglas) e
 * a regra olha a PALAVRA. Continua valendo o que a substring prometia —
 * coluna nova com nome parecido entra sem ninguém atualizar a lista —, porque
 * `api_key_encrypted`, `webhook_token` e `clientSecret` têm a palavra inteira.
 */
const PALAVRAS_PROIBIDAS = new Set([
  'password',
  'passwd',
  'senha',
  'hash',
  'secret',
  'token',
  'apikey',
  'certificate',
  'pfx',
  'csc',
  // XML fiscal carrega assinatura digital e nao acrescenta nada ao
  // consolidado: modelo, serie, numero e chave ja sobem em campos proprios.
  'xml',
  // O número do cartão ("primary account number") e o código de segurança.
  'pan',
  'cvv',
  // Segredo selado (`encryptedPfx`, `encrypted_value`) não é plaintext, mas
  // na central não serve para nada — e lá a chave que o abre não existe.
  'encrypted',
]);

/** Sequências de palavras que, juntas, nomeiam um segredo. */
const SEQUENCIAS_PROIBIDAS: string[][] = [
  ['api', 'key'],
  ['private', 'key'],
  ['card', 'number'],
];

/**
 * A última palavra que faz do campo uma CONTAGEM: `tokens_total` é quantos,
 * nunca qual. Um número de coisas não é a coisa.
 */
const PALAVRAS_DE_CONTAGEM = new Set(['total', 'count', 'qtd', 'quantidade', 'contagem']);

/** `apiKeyEncrypted` → api, key, encrypted; `XMLAssinado` → xml, assinado. */
function palavrasDoNome(nome: string): string[] {
  return nome
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A palavra, ou o plural dela (`tokens`, `secrets`, `hashes`). */
function ehProibida(palavra: string): boolean {
  if (PALAVRAS_PROIBIDAS.has(palavra)) return true;
  if (palavra.endsWith('es') && PALAVRAS_PROIBIDAS.has(palavra.slice(0, -2))) return true;
  return palavra.endsWith('s') && PALAVRAS_PROIBIDAS.has(palavra.slice(0, -1));
}

export function campoProibido(nome: string): boolean {
  const palavras = palavrasDoNome(nome);
  // `tokens_total`, `api_key_count`: uma contagem é um número, não o segredo.
  if (palavras.length > 1 && PALAVRAS_DE_CONTAGEM.has(palavras[palavras.length - 1])) return false;
  if (palavras.some(ehProibida)) return true;
  return SEQUENCIAS_PROIBIDAS.some((seq) =>
    palavras.some((_, i) => seq.every((p, j) => palavras[i + j] === p)),
  );
}

/** Remove do payload tudo o que não pode sair do nó, em qualquer profundidade. */
export function redigirPayload(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redigirPayload);
  if (valor === null || typeof valor !== 'object') return valor;

  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
    if (campoProibido(chave)) continue;
    saida[chave] = redigirPayload(v);
  }
  return saida;
}

/**
 * Identidade deste nó.
 *
 * Gerada uma vez e gravada no próprio banco. Não vem do hostname: duas lojas
 * restauradas do mesmo backup teriam o mesmo nome de máquina, e os eventos de
 * uma apareceriam como se fossem da outra.
 */
export function nodeId(): string {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

  const configurado = process.env.GRUPO_SAMPAIO_NODE_ID?.trim();
  if (configurado) return configurado;

  const linha = db
    .prepare("SELECT value FROM core_meta WHERE key = 'sync_node_id'")
    .get() as { value?: string } | undefined;
  if (linha?.value) return linha.value;

  const novo = randomUUID();
  db.prepare("INSERT INTO core_meta (key, value) VALUES ('sync_node_id', ?)").run(novo);
  return novo;
}

export interface EnqueueInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  companyId: string;
  operationalUnitId?: string | null;
  operation: 'insert' | 'update' | 'delete';
  schemaVersion: number;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

/**
 * Enfileira um fato para a central.
 *
 * Porta única, usada por `recordDomainEvent`. DEVE ser chamada dentro da
 * transação que grava o fato: fora dela é erro de programação, não caso a
 * tolerar — uma fila que sobrevive ao rollback do fato faria a central
 * registrar venda que não existe.
 */
export function enqueue(input: EnqueueInput): string | null {
  ensureCoreSchema();

  if (NAO_SINCRONIZAVEIS.has(input.aggregateType)) return null;

  if (!inTransaction()) {
    throw new ApiError(
      'SYNC_OUTBOX_FORA_DE_TRANSACAO',
      `Evento "${input.eventType}" precisa ser enfileirado dentro da transação que `
        + 'grava o fato. Fora dela, um rollback deixaria a central com um fato que '
        + 'não aconteceu.',
      500,
    );
  }

  const agora = new Date().toISOString();
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_outbox
         (id, node_id, event_type, aggregate_type, aggregate_id, company_id,
          operational_unit_id, operation, schema_version, payload, occurred_at,
          status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      id,
      nodeId(),
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.companyId,
      input.operationalUnitId ?? null,
      input.operation,
      input.schemaVersion,
      JSON.stringify(redigirPayload(input.payload)),
      input.occurredAt ?? agora,
      agora,
    );
  return id;
}

/**
 * O próximo lote a enviar, na ordem em que os fatos aconteceram.
 *
 * Inclui `processing` cujo prazo venceu: é assim que um evento entregue a um
 * worker que morreu volta a circular. O reenvio é seguro porque a central é
 * idempotente por `id`.
 */
export function pendentes(limite = 100): OutboxRow[] {
  ensureCoreSchema();
  const agora = new Date().toISOString();
  return getConnection()
    .prepare(
      `SELECT * FROM core_outbox
        WHERE status IN ('pending', 'retry', 'processing')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY seq
        LIMIT ?`,
    )
    .all(agora, limite) as unknown as OutboxRow[];
}

/**
 * Marca o lote como entregue a um worker.
 *
 * O `next_attempt_at` empurrado para a frente é o que evita que DOIS workers
 * peguem o mesmo evento ao mesmo tempo. Mesmo que peguem, a central deduplica
 * por `id` — esta trava é para não desperdiçar rede, não para corretude.
 */
export function marcarProcessando(ids: string[], prazoMs = 60_000): void {
  if (ids.length === 0) return;
  ensureCoreSchema();
  const db = getConnection();
  const prazo = new Date(Date.now() + prazoMs).toISOString();
  const stmt = db.prepare(
    `UPDATE core_outbox SET status = 'processing', next_attempt_at = ?
      WHERE id = ? AND status IN ('pending', 'retry', 'processing')`,
  );
  for (const id of ids) stmt.run(prazo, id);
}

/** Confirmação da central. Só o que ela aceitou sai da fila. */
export function marcarEnviados(ids: string[]): number {
  if (ids.length === 0) return 0;
  ensureCoreSchema();
  const db = getConnection();
  const agora = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE core_outbox
        SET status = 'synced', sent_at = ?, last_error = NULL, last_error_kind = NULL,
            next_attempt_at = NULL
      WHERE id = ? AND status <> 'synced'`,
  );
  let n = 0;
  for (const id of ids) n += Number(stmt.run(agora, id).changes ?? 0);
  return n;
}

/**
 * Falha no envio.
 *
 * A linha CONTINUA na fila — ganha tentativa, motivo, natureza e hora da
 * próxima. Backoff exponencial: insistir de segundo em segundo contra uma
 * central fora do ar só queima bateria e enche log.
 *
 * A NATUREZA decide o fim (GAP-PRD-047):
 *
 *   - TRANSPORTE nunca vira `dead`. A espera cresce até 10 minutos e para
 *     aí; a central voltando, o evento sobe na batida seguinte sem ninguém
 *     clicar em nada. As tentativas continuam contadas, para a tela dizer há
 *     quanto tempo se insiste.
 *   - RECUSA esgotada vira `dead`. Ele não some e não é reenviado sozinho:
 *     fica esperando uma pessoa, porque um evento que a central recusa doze
 *     vezes tem um problema que tentar de novo não resolve.
 *
 * O padrão é RECUSA — o comportamento de antes — para quem chama sem saber.
 * Devolve quantos eventos acabaram de virar `dead`, para quem chama avisar.
 */
export function marcarFalha(
  ids: string[],
  erro: string,
  natureza: NaturezaDaFalha = 'RECUSA',
): number {
  if (ids.length === 0) return 0;
  ensureCoreSchema();
  const db = getConnection();
  const buscar = db.prepare('SELECT attempts FROM core_outbox WHERE id = ?');
  const stmt = db.prepare(
    `UPDATE core_outbox
        SET status = ?, attempts = ?, last_error = ?, last_error_kind = ?, next_attempt_at = ?
      WHERE id = ? AND status <> 'synced'`,
  );

  let mortos = 0;
  for (const id of ids) {
    const atual = buscar.get(id) as { attempts: number } | undefined;
    const tentativas = (atual?.attempts ?? 0) + 1;
    const morto = natureza === 'RECUSA' && tentativas >= MAX_ATTEMPTS;
    const teto = natureza === 'TRANSPORTE' ? ESPERA_MAXIMA_TRANSPORTE_MS : ESPERA_MAXIMA_RECUSA_MS;
    // 2^n segundos, com o expoente contido para a conta não virar Infinity
    // numa queda de dias (a tentativa 40 ainda é um número, e o teto manda).
    const esperaMs = Math.min(2 ** Math.min(tentativas, 20) * 1000, teto);
    const r = stmt.run(
      morto ? 'dead' : 'retry',
      tentativas,
      erro.slice(0, 500),
      natureza,
      morto ? null : new Date(Date.now() + esperaMs).toISOString(),
      id,
    );
    if (morto && Number(r.changes ?? 0) > 0) mortos += 1;
  }
  return mortos;
}

/**
 * Recorte da fila por operação (GAP-PRD-136).
 *
 * A fila é do NÓ — uma tabela para todas as empresas do servidor. Quem não
 * responde pelo grupo inteiro enxerga e mexe só nos eventos da própria
 * operação; sem recorte, é o nó inteiro (o trabalhador de fundo, os scripts e
 * quem responde pelo grupo).
 */
export interface RecorteDaFila {
  companyId: string;
}

function filtroDoRecorte(recorte?: RecorteDaFila): { sql: string; args: string[] } {
  return recorte ? { sql: ' AND company_id = ?', args: [recorte.companyId] } : { sql: '', args: [] };
}

/**
 * Devolve um evento morto para a fila — ação de gente, nunca automática.
 *
 * Com recorte, só os mortos daquela operação: o gerente da loja A não decide
 * pelos eventos da loja B (GAP-PRD-136).
 */
export function reviverMortos(recorte?: RecorteDaFila): number {
  ensureCoreSchema();
  const f = filtroDoRecorte(recorte);
  return Number(
    getConnection()
      .prepare(
        `UPDATE core_outbox SET status = 'pending', attempts = 0, next_attempt_at = NULL
          WHERE status = 'dead'${f.sql}`,
      )
      .run(...f.args).changes ?? 0,
  );
}

export interface OutboxSnapshot {
  nodeId: string;
  pending: number;
  processing: number;
  retry: number;
  synced: number;
  dead: number;
  oldestPendingAt: string | null;
  lastSyncedAt: string | null;
  lastSyncedEventType: string | null;
  lastError: string | null;
  /**
   * A natureza da última falha (GAP-PRD-047). `TRANSPORTE` quer dizer "a
   * central não responde e a fila insiste sozinha"; `RECUSA`, "a central
   * disse não" — é esta que acaba em `dead`. Nula em linha antiga.
   */
  lastErrorKind: NaturezaDaFalha | null;
  /** Eventos em nova tentativa porque a central não respondeu. */
  esperandoCentral: number;
  /** Segundos entre o fato mais antigo na fila e agora. */
  lagSeconds: number | null;
}

/**
 * Quanto a central está atrasada em relação a este nó.
 *
 * Com recorte, as contagens, o último evento e o último erro são SÓ da
 * operação pedida (GAP-PRD-136) — o texto do erro de outra empresa não é da
 * conta de quem não responde por ela.
 */
export function outboxStatus(recorte?: RecorteDaFila): OutboxSnapshot {
  ensureCoreSchema();
  const db = getConnection();
  const f = filtroDoRecorte(recorte);
  const contarPor = (status: OutboxStatus) =>
    Number(
      (
        db
          .prepare(`SELECT COUNT(*) c FROM core_outbox WHERE status = ?${f.sql}`)
          .get(status, ...f.args) as {
          c: number;
        }
      ).c,
    );

  const maisAntigo = db
    .prepare(
      `SELECT occurred_at FROM core_outbox
        WHERE status <> 'synced'${f.sql} ORDER BY seq LIMIT 1`,
    )
    .get(...f.args) as { occurred_at?: string } | undefined;

  const ultimo = db
    .prepare(
      `SELECT sent_at, event_type FROM core_outbox
        WHERE status = 'synced'${f.sql} ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(...f.args) as { sent_at?: string; event_type?: string } | undefined;

  const erro = db
    .prepare(
      `SELECT last_error, last_error_kind FROM core_outbox
        WHERE status <> 'synced' AND last_error IS NOT NULL${f.sql}
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(...f.args) as { last_error?: string; last_error_kind?: string | null } | undefined;

  const esperandoCentral = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM core_outbox
            WHERE status = 'retry' AND last_error_kind = 'TRANSPORTE'${f.sql}`,
        )
        .get(...f.args) as { c: number }
    ).c,
  );

  const lagSeconds = maisAntigo?.occurred_at
    ? Math.max(0, Math.round((Date.now() - new Date(maisAntigo.occurred_at).getTime()) / 1000))
    : null;

  const tipo = erro?.last_error_kind;
  return {
    nodeId: nodeId(),
    pending: contarPor('pending'),
    processing: contarPor('processing'),
    retry: contarPor('retry'),
    synced: contarPor('synced'),
    dead: contarPor('dead'),
    oldestPendingAt: maisAntigo?.occurred_at ?? null,
    lastSyncedAt: ultimo?.sent_at ?? null,
    lastSyncedEventType: ultimo?.event_type ?? null,
    lastError: erro?.last_error ?? null,
    lastErrorKind: tipo === 'TRANSPORTE' || tipo === 'RECUSA' ? tipo : null,
    esperandoCentral,
    lagSeconds,
  };
}
