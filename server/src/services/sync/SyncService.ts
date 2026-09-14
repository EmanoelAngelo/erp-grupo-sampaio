/**
 * Envio da fila local para o banco central (Supabase/PostgreSQL).
 *
 * Roda FORA do caminho da requisição, em segundo plano. É essa separação que
 * permite a central ser remota sem tornar assíncrono nada que grava venda,
 * estoque ou nota: o PDV continua commitando local, em microssegundos, e este
 * serviço leva os fatos embora quando dá.
 *
 * IDEMPOTÊNCIA — a parte que não pode falhar
 *
 * Reenvio é normal: a central pode confirmar e a resposta se perder no
 * caminho, ou o processo pode morrer entre o envio e o ACK local. Por isso o
 * `id` do evento é a chave primária no destino e o envio é UPSERT. Reenviar o
 * mesmo fato mil vezes resulta em uma linha — e nunca em mil vendas.
 *
 * O evento só sai da fila com a confirmação da central, e apenas os ids que
 * ela disse ter aceitado. Marcar como enviado o que "provavelmente chegou" é a
 * forma de perder um fato de dinheiro em silêncio.
 *
 * CREDENCIAL
 *
 * O servidor precisa de credencial PRÓPRIA (`DEVORA_SUPABASE_URL` +
 * `DEVORA_SUPABASE_SERVICE_KEY`) — os MESMOS nomes que a cópia remota do
 * backup usa, porque é a mesma conta Supabase.
 *
 * Não era assim. Este serviço lia `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`,
 * e o backup lia os nomes `DEVORA_*`. O `.env` da instalação tinha os
 * `DEVORA_*` preenchidos: o backup subia, a sincronia nunca ligou. Medido em
 * 27/08/2026: 118 eventos parados desde 15/08 — doze dias de venda, estoque e
 * fiscal que a central nunca recebeu.
 *
 * E o sistema avisava, todo boot: `CENTRAL_SYNC_WORKER_IDLE`, motivo "sem
 * credencial da central". A mensagem estava certa e era inútil — o dono tinha
 * preenchido a credencial, e o log não dizia QUAL nome faltava. Defeito
 * silencioso não é o que não avisa: é o que avisa uma coisa que ninguém liga
 * à causa.
 *
 * A chave publicável do navegador não serve e
 * não é usada aqui: ela existe para o cliente com RLS, e escrever a central
 * com ela seria confiar no navegador. Sem credencial, o estado é
 * `READY_FOR_CREDENTIAL` e a fila apenas acumula — não se inventa envio.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ensureDotEnvLoaded, lerVariaveisAoVivo } from '../../config/env.js';
import {
  projetarLote,
  supabaseProjectionTransport,
  type ProjectionResult,
  type ProjectionTransport,
} from './CentralProjection.js';
import {
  FalhaDaCentral,
  marcarEnviados,
  marcarFalha,
  marcarProcessando,
  naturezaDaFalha,
  outboxStatus,
  pendentes,
  statusEhTransporte,
  type NaturezaDaFalha,
  type OutboxRow,
  type OutboxSnapshot,
  type RecorteDaFila,
} from './OutboxService.js';
import { logWarn } from '../../utils/errors.js';

export interface CentralTransport {
  readonly name: string;
  /** Marcado quando o destino NÃO é uma Supabase real. */
  readonly isTest?: boolean;
  /** Devolve os ids que a central confirmou ter gravado. */
  send(batch: OutboxRow[]): Promise<{ acceptedIds: string[] }>;
  /** A central já tem o schema aplicado? */
  probeSchema?(): Promise<{ ok: boolean; centralVersion?: number; detail?: string }>;
}

/** Tabela de aterrissagem na central. Uma linha por fato, id como chave. */
export const TABELA_CENTRAL = 'erp_sync_events';

export type { ProjectionTransport, ProjectionResult };

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

/**
 * Credencial do servidor.
 *
 * Lida do ambiente e NUNCA devolvida por nenhuma API — o que sai daqui é
 * apenas se existe ou não.
 */
/**
 * Os nomes ANTIGOS, mantidos só para serem denunciados.
 *
 * Não são aceitos como credencial: dois jeitos certos de configurar a mesma
 * coisa deixariam a próxima pessoa sem saber qual vale. Mas quem os preencheu
 * fez tudo o que sabia fazer, e precisa ouvir que o nome mudou — em vez de
 * "falta credencial", que foi a mensagem que produziu doze dias de fila parada.
 */
const NOMES_LEGADOS: Array<[string, string]> = [
  ['SUPABASE_URL', 'DEVORA_SUPABASE_URL'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'DEVORA_SUPABASE_SERVICE_KEY'],
];

/** Quais nomes antigos estão no ambiente. Só os nomes; nunca os valores. */
export function legadosPresentes(): Array<{ antigo: string; oficial: string }> {
  ensureDotEnvLoaded();
  return NOMES_LEGADOS.filter(([antigo]) => Boolean(process.env[antigo]?.trim())).map(
    ([antigo, oficial]) => ({ antigo, oficial }),
  );
}

/**
 * A credencial da central, lida AO VIVO do `.env` (GAP-PRD-065).
 *
 * `ensureDotEnvLoaded` só preenche chave AUSENTE, e o arquivo de exemplo traz
 * `DEVORA_SUPABASE_URL=` vazia: preencher depois não mudava nada até o
 * próximo boot, e a tela de Sincronização seguia dizendo que faltava. Agora
 * cada ciclo relê as duas chaves (`lerVariaveisAoVivo`, com a precedência do
 * boot: variável do ambiente do sistema continua mandando).
 */
function credencialDaCentral(): { url: string; serviceRoleKey: string } {
  const v = lerVariaveisAoVivo(['DEVORA_SUPABASE_URL', 'DEVORA_SUPABASE_SERVICE_KEY'] as const);
  return {
    url: v.DEVORA_SUPABASE_URL?.trim() ?? '',
    serviceRoleKey: v.DEVORA_SUPABASE_SERVICE_KEY?.trim() ?? '',
  };
}

export function supabaseConfig(): SupabaseConfig | null {
  const { url, serviceRoleKey } = credencialDaCentral();
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

/**
 * Estados, do mais cru ao pronto.
 *
 * A distinção importa: "tem credencial" não é "tem schema", e "tem schema" não
 * é "os dados batem". Chamar qualquer um deles de ONLINE esconde exatamente a
 * pergunta que o gestor precisa fazer.
 */
export type SyncReadiness =
  | 'READY_FOR_CREDENTIAL'
  | 'READY_FOR_SCHEMA'
  | 'READY_FOR_BOOTSTRAP'
  | 'SYNC_READY';

const META_SCHEMA_OK = 'central_schema_ok_at';
const META_BOOTSTRAP = 'central_bootstrap_completed_at';

function meta(chave: string): string | null {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const linha = db.prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as
    | { value?: string }
    | undefined;
  return linha?.value ?? null;
}

export function setMeta(chave: string, valor: string): void {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(chave, valor);
}

/** "Sem erro" é ausência de linha — não uma string vazia fingindo silêncio. */
export function clearMeta(chave: string): void {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('DELETE FROM core_meta WHERE key = ?').run(chave);
}

export interface SyncStatus {
  readiness: SyncReadiness;
  missing: string[];
  transport: string;
  isTestTransport: boolean;
  centralSchemaCheckedAt: string | null;
  bootstrapCompletedAt: string | null;
  outbox: OutboxSnapshot;
  /**
   * O ciclo de fundo está mesmo rodando?
   *
   * A tela dizia "a fila sobe sozinha" e nada subia: `startSyncWorker` não
   * tinha chamador nenhum. Afirmação sobre processo de fundo precisa ser
   * conferível de fora, senão vira promessa — e promessa sobre fila de dinheiro
   * é como se perde um fato em silêncio.
   */
  workerRunning: boolean;
  /**
   * Entregar não é projetar (GAP-PRD-048). O último erro de projeção, quando
   * aconteceu e quando a central aceitou uma projeção pela última vez — o
   * diagnóstico era gravado e ninguém o lia.
   */
  projecao: DiagnosticoDaProjecao;
}

/**
 * Situação, sem tocar na rede.
 *
 * Só afirma o que dá para saber daqui. "Schema aplicado" e "bootstrap feito"
 * vêm de marcas gravadas quando aquilo realmente aconteceu — não de suposição.
 */
export function syncStatus(transport?: CentralTransport, recorte?: RecorteDaFila): SyncStatus {
  const config = supabaseConfig();
  const credencial = credencialDaCentral();
  const missing: string[] = [];
  if (!credencial.url) missing.push('DEVORA_SUPABASE_URL');
  if (!credencial.serviceRoleKey) {
    missing.push('DEVORA_SUPABASE_SERVICE_KEY');
  }

  /*
    E o recado para quem preencheu o nome antigo.

    Entra em `missing` de propósito: é a lista que a tela mostra e que o
    diagnóstico do dono lê. Dizer só "falta DEVORA_SUPABASE_URL" a quem
    acabou de escrever SUPABASE_URL é repetir o defeito com outro nome.
  */
  for (const { antigo, oficial } of legadosPresentes()) {
    missing.push(`${antigo} está no ambiente mas foi RENOMEADA: use ${oficial}`);
  }

  const schemaOkAt = meta(META_SCHEMA_OK);
  const bootstrapAt = meta(META_BOOTSTRAP);
  const temTransporte = Boolean(transport) || Boolean(config);

  let readiness: SyncReadiness;
  if (!temTransporte) readiness = 'READY_FOR_CREDENTIAL';
  else if (!schemaOkAt) readiness = 'READY_FOR_SCHEMA';
  else if (!bootstrapAt) readiness = 'READY_FOR_BOOTSTRAP';
  else readiness = 'SYNC_READY';

  return {
    readiness,
    missing: temTransporte ? [] : missing,
    transport: transport?.name ?? (config ? 'supabase' : 'none'),
    isTestTransport: Boolean(transport?.isTest),
    centralSchemaCheckedAt: schemaOkAt,
    bootstrapCompletedAt: bootstrapAt,
    // A fila, recortada quando quem pergunta não responde pelo nó (GAP-PRD-136).
    outbox: outboxStatus(recorte),
    workerRunning: syncWorkerRunning(),
    projecao: diagnosticoDaProjecao(),
  };
}

/**
 * Transporte real: PostgREST da Supabase.
 *
 * `Prefer: resolution=merge-duplicates` transforma o INSERT em UPSERT pela
 * chave primária — é o que torna o reenvio inofensivo. `return=representation`
 * faz a central devolver o que gravou, e são ESSES ids que saem da fila: a
 * confirmação vem do destino, não da suposição de quem enviou.
 */
export function supabaseTransport(
  config: SupabaseConfig,
  fetchImpl: typeof fetch = fetch,
): CentralTransport {
  const headers = () => ({
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json',
  });

  /** A credencial não pode vazar por mensagem de erro. */
  const limpar = (texto: string) => texto.split(config.serviceRoleKey).join('<oculto>');

  return {
    name: 'supabase',
    async send(batch) {
      const corpo = batch.map((row) => ({
        id: row.id,
        node_id: row.node_id,
        event_type: row.event_type,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        company_id: row.company_id,
        operational_unit_id: row.operational_unit_id,
        operation: row.operation,
        schema_version: row.schema_version,
        payload: JSON.parse(row.payload) as unknown,
        occurred_at: row.occurred_at,
        node_seq: row.seq,
      }));

      /*
        A NATUREZA DA FALHA É DECIDIDA AQUI, onde se conhece o protocolo
        (GAP-PRD-047): rede que não respondeu e 5xx/408/429 são TRANSPORTE — a
        fila insiste para sempre —; o resto dos 4xx é RECUSA e conta para o
        limite. A mensagem sai limpa da chave nos dois casos.
      */
      let res: Response;
      try {
        res = await fetchImpl(`${config.url}/rest/v1/${TABELA_CENTRAL}`, {
          method: 'POST',
          headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(corpo),
        });
      } catch (err) {
        throw new FalhaDaCentral(
          limpar(`A central não respondeu: ${err instanceof Error ? err.message : String(err)}`),
          'TRANSPORTE',
        );
      }

      if (!res.ok) {
        const detalhe = await res.text().catch(() => '');
        throw new FalhaDaCentral(
          limpar(`Central recusou o lote (HTTP ${res.status}): ${detalhe.slice(0, 200)}`),
          statusEhTransporte(res.status) ? 'TRANSPORTE' : 'RECUSA',
          res.status,
        );
      }

      const gravados = (await res.json()) as { id?: string }[];
      return { acceptedIds: gravados.map((g) => g.id).filter((id): id is string => Boolean(id)) };
    },

    async probeSchema() {
      try {
        const res = await fetchImpl(
          `${config.url}/rest/v1/erp_central_migrations?select=version&order=version.desc&limit=1`,
          { headers: headers() },
        );
        if (!res.ok) {
          return { ok: false, detail: limpar(`HTTP ${res.status} ao ler erp_central_migrations`) };
        }
        const linhas = (await res.json()) as { version?: number }[];
        if (linhas.length === 0) return { ok: false, detail: 'Nenhuma migration aplicada na central.' };
        return { ok: true, centralVersion: linhas[0].version };
      } catch (err) {
        return { ok: false, detail: limpar((err as Error).message) };
      }
    },
  };
}

/**
 * Transporte de TESTE — central em memória.
 *
 * Existe para que o projeto continue desenvolvível e testável sem credencial
 * real. Guarda por `id`, exatamente como o UPSERT da Supabase faria, e por
 * isso reproduz a idempotência de verdade em vez de fingir.
 *
 * `isTest` é obrigatório e aparece na tela: um ambiente que sincroniza para
 * lugar nenhum não pode se apresentar como pronto.
 */
export function testCentralTransport(opções?: {
  falharCom?: () => string | null;
  aceitarSomente?: (row: OutboxRow) => boolean;
}): CentralTransport & { gravados: Map<string, OutboxRow>; envios: number } {
  const gravados = new Map<string, OutboxRow>();
  const estado = { envios: 0 };

  return {
    name: 'test-central',
    isTest: true,
    get gravados() {
      return gravados;
    },
    get envios() {
      return estado.envios;
    },
    async send(batch) {
      estado.envios += 1;
      const erro = opções?.falharCom?.();
      if (erro) throw new Error(erro);

      const aceitos: string[] = [];
      for (const row of batch) {
        if (opções?.aceitarSomente && !opções.aceitarSomente(row)) continue;
        // UPSERT por id: é isto que faz o reenvio não duplicar.
        gravados.set(row.id, row);
        aceitos.push(row.id);
      }
      return { acceptedIds: aceitos };
    },
    async probeSchema() {
      return { ok: true, centralVersion: 0, detail: 'central de teste' };
    },
  };
}

/** Resolve o transporte: o explícito ganha; senão, a credencial real. */
export function resolveTransport(explicito?: CentralTransport): CentralTransport | null {
  if (explicito) return explicito;
  const config = supabaseConfig();
  return config ? supabaseTransport(config) : null;
}

/** Confere o schema da central e grava a marca. Toca a rede. */
export async function probeCentralSchema(
  transport?: CentralTransport,
): Promise<{ ok: boolean; detail?: string }> {
  const t = resolveTransport(transport);
  if (!t) return { ok: false, detail: 'Sem credencial para a central.' };
  if (!t.probeSchema) return { ok: false, detail: 'Transporte não sabe conferir schema.' };

  const r = await t.probeSchema();
  if (r.ok) setMeta(META_SCHEMA_OK, new Date().toISOString());
  return { ok: r.ok, detail: r.detail };
}

export function marcarBootstrapConcluido(): void {
  setMeta(META_BOOTSTRAP, new Date().toISOString());
}

export interface SyncResult {
  attempted: number;
  sent: number;
  failed: number;
  readiness: SyncReadiness;
  transport: string;
  isTestTransport: boolean;
  error?: string;
  /** Ausente quando não há para onde projetar. Nunca zero fingindo sucesso. */
  projected?: ProjectionResult;
}

const META_ULTIMO_ERRO_PROJECAO = 'central_projection_last_error';
const META_ULTIMO_ERRO_PROJECAO_EM = 'central_projection_last_error_at';
const META_ULTIMA_PROJECAO_ACEITA_EM = 'central_projection_last_ok_at';

/**
 * O DIAGNÓSTICO DA PROJEÇÃO, AGORA LIDO (GAP-PRD-048).
 *
 * `central_projection_last_error` era escrito aqui e nunca lido — nem pela
 * rota, nem pela tela, nem pela conferência. O banco da loja guardou um
 * PGRST202 (a função de projeção não existia na central) sem data, e nada
 * separava "faltou um dia" de "continua faltando".
 *
 * Três chaves em `core_meta`, sempre escritas juntas pelas duas funções
 * abaixo — o envio normal e a reprojeção administrativa passam por elas:
 *
 *   - o último erro e QUANDO ele aconteceu;
 *   - quando a central aceitou uma projeção pela última vez. "Quebrou agora"
 *     não apaga "funcionava": o erro novo não mexe nesta.
 *
 * Erro gravado por versão anterior não tem hora: `ultimoErroEm` volta nulo e
 * a tela diz que a data não se sabe, em vez de inventar uma.
 */
export interface DiagnosticoDaProjecao {
  ultimoErro: string | null;
  ultimoErroEm: string | null;
  ultimaAceitaEm: string | null;
}

export function diagnosticoDaProjecao(): DiagnosticoDaProjecao {
  return {
    ultimoErro: meta(META_ULTIMO_ERRO_PROJECAO),
    ultimoErroEm: meta(META_ULTIMO_ERRO_PROJECAO_EM),
    ultimaAceitaEm: meta(META_ULTIMA_PROJECAO_ACEITA_EM),
  };
}

/** A central recusou (ou não recebeu) a projeção: o erro novo, com a hora. */
export function registrarErroDeProjecao(mensagem: string, em: string = new Date().toISOString()): void {
  setMeta(META_ULTIMO_ERRO_PROJECAO, mensagem);
  setMeta(META_ULTIMO_ERRO_PROJECAO_EM, em);
}

/** A central aceitou projeção: o erro superado sai, e fica a hora da aceita. */
export function registrarProjecaoAceita(em: string = new Date().toISOString()): void {
  clearMeta(META_ULTIMO_ERRO_PROJECAO);
  clearMeta(META_ULTIMO_ERRO_PROJECAO_EM);
  setMeta(META_ULTIMA_PROJECAO_ACEITA_EM, em);
}

/**
 * Transporte de projeção derivado do ambiente.
 *
 * Mesma credencial do envio: quem pode gravar a aterrissagem pode projetar.
 * Sem credencial devolve `null`, e aí não se projeta nem se finge que sim.
 */
export function projectionTransportFromEnv(): ProjectionTransport | null {
  const config = supabaseConfig();
  if (!config) return null;
  return supabaseProjectionTransport({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
  });
}

/** Uma falha de um evento, com a natureza que decide se ele pode morrer. */
interface FalhaDoEvento {
  id: string;
  mensagem: string;
  natureza: NaturezaDaFalha;
}

const NAO_CONFIRMADO = 'A central não confirmou a gravação deste evento.';

/**
 * Entrega o lote — e, se a central RECUSAR um lote de vários, entrega um a um
 * para achar o culpado (GAP-PRD-047).
 *
 * Sem isto, um evento envenenado num lote de cem fazia a central recusar os
 * cem, os cem ganhavam tentativa de recusa, e doze passadas depois os cem
 * estavam `dead` por causa de um. Falha de TRANSPORTE não isola: se a central
 * não responde, ela não responde para nenhum — e se cair no meio da
 * isolação, o resto do lote espera como transporte.
 */
async function entregarIsolando(
  transport: CentralTransport,
  lote: OutboxRow[],
): Promise<{ aceitos: string[]; falhas: FalhaDoEvento[]; erro?: string }> {
  const naoConfirmados = (ids: Set<string>, linhas: OutboxRow[]): FalhaDoEvento[] =>
    linhas
      .filter((r) => !ids.has(r.id))
      .map((r) => ({ id: r.id, mensagem: NAO_CONFIRMADO, natureza: 'RECUSA' as const }));

  try {
    const { acceptedIds } = await transport.send(lote);
    return { aceitos: acceptedIds, falhas: naoConfirmados(new Set(acceptedIds), lote) };
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : 'Falha ao falar com a central.';
    const natureza = naturezaDaFalha(err);
    if (natureza === 'TRANSPORTE' || lote.length === 1) {
      return { aceitos: [], falhas: lote.map((r) => ({ id: r.id, mensagem, natureza })), erro: mensagem };
    }

    const aceitos: string[] = [];
    const falhas: FalhaDoEvento[] = [];
    for (let i = 0; i < lote.length; i += 1) {
      const linha = lote[i]!;
      try {
        const { acceptedIds } = await transport.send([linha]);
        if (acceptedIds.includes(linha.id)) aceitos.push(linha.id);
        else falhas.push(...naoConfirmados(new Set(acceptedIds), [linha]));
      } catch (errDoEvento) {
        const texto = errDoEvento instanceof Error ? errDoEvento.message : mensagem;
        if (naturezaDaFalha(errDoEvento) === 'TRANSPORTE') {
          // A central caiu no meio da isolação: ninguém do resto foi julgado.
          for (const resto of lote.slice(i)) {
            falhas.push({ id: resto.id, mensagem: texto, natureza: 'TRANSPORTE' });
          }
          break;
        }
        falhas.push({ id: linha.id, mensagem: texto, natureza: 'RECUSA' });
      }
    }
    return { aceitos, falhas, erro: falhas.length > 0 ? mensagem : undefined };
  }
}

/** Mesma mensagem e mesma natureza viram uma chamada só de `marcarFalha`. */
function agruparFalhas(
  falhas: FalhaDoEvento[],
): Array<{ ids: string[]; mensagem: string; natureza: NaturezaDaFalha }> {
  const grupos = new Map<string, { ids: string[]; mensagem: string; natureza: NaturezaDaFalha }>();
  for (const f of falhas) {
    const chave = `${f.natureza}\u0000${f.mensagem}`;
    const grupo = grupos.get(chave) ?? { ids: [], mensagem: f.mensagem, natureza: f.natureza };
    grupo.ids.push(f.id);
    grupos.set(chave, grupo);
  }
  return [...grupos.values()];
}

/**
 * Uma passada da fila.
 *
 * Sem credencial não faz nada e diz por quê — a fila continua intacta, que é
 * exatamente o comportamento desejado enquanto a central não existe.
 */
export async function syncOnce(input?: {
  transport?: CentralTransport;
  batchSize?: number;
  projectionTransport?: ProjectionTransport;
}): Promise<SyncResult> {
  const transport = resolveTransport(input?.transport);
  const status = syncStatus(input?.transport);

  if (!transport) {
    return {
      attempted: 0,
      sent: 0,
      failed: 0,
      readiness: 'READY_FOR_CREDENTIAL',
      transport: 'none',
      isTestTransport: false,
    };
  }

  const base = {
    readiness: status.readiness,
    transport: transport.name,
    isTestTransport: Boolean(transport.isTest),
  };

  /*
    ========================================================================
    CENTRAL SEM ESQUEMA NÃO É CENTRAL FORA DO AR
    ========================================================================

    Os dois casos parecem o mesmo — o envio falha — e não são.

    Central fora do ar VOLTA. Insistir com espera crescente é a resposta
    certa, e é o que o backoff faz. Central sem as tabelas não volta sozinha:
    alguém tem de rodar o SQL de `docs/supabase` no painel. Insistir contra
    isso gasta o orçamento de tentativas contra uma condição que tentar de
    novo não resolve.

    E o orçamento acaba. São doze tentativas com espera de até cinco minutos:
    uma hora de servidor no ar e a fila inteira vira `dead`, esperando uma
    pessoa que nem sabe que precisa ser esperada.

    Foi medido, não imaginado. Ao ligar o trabalhador depois de acertar o nome
    da credencial, com a central ainda sem esquema, 100 dos 118 eventos foram
    para `retry` com duas tentativas em menos de um minuto — todos com
    "Could not find the table 'public.erp_sync_events'".

    O estado `READY_FOR_SCHEMA` já dizia exatamente isso desde sempre.
    Ninguém o consultava antes de enviar.

    A sondagem acontece aqui, e não numa tela: assim que o dono rodar o SQL, a
    batida seguinte encontra o esquema e a fila anda — sem reiniciar nada.
  */
  /*
    So quem SABE responder e perguntado.

    Um transporte sem probeSchema nao e evidencia de central sem esquema — e
    um transporte que nao tem como conferir. Barra-lo aqui transformaria o
    porteiro num muro: os transportes de teste, que nao conferem nada, nunca
    entregariam.
  */
  if (status.readiness === 'READY_FOR_SCHEMA' && transport.probeSchema) {
    const sonda = await probeCentralSchema(transport);
    if (!sonda.ok) {
      return {
        attempted: 0,
        sent: 0,
        failed: 0,
        ...base,
        error: sonda.detail ?? 'a central ainda não tem o esquema aplicado',
      };
    }
    // Confirmado agora: o envio segue nesta mesma passada.
    base.readiness = syncStatus(input?.transport).readiness;
  }

  const lote = pendentes(input?.batchSize ?? 100);
  if (lote.length === 0) return { attempted: 0, sent: 0, failed: 0, ...base };

  // Reserva o lote ANTES de sair: se este processo morrer no meio, os eventos
  // ficam em `processing` com prazo, e voltam a circular quando ele vence.
  marcarProcessando(lote.map((r) => r.id));

  try {
    const entrega = await entregarIsolando(transport, lote);
    const acceptedIds = entrega.aceitos;
    const enviados = marcarEnviados(acceptedIds);

    // O que a central NÃO confirmou continua na fila e será reenviado — com a
    // natureza da falha, que decide se ele pode acabar em `dead`.
    const aceitos = new Set(acceptedIds);
    const naoConfirmados = lote.map((r) => r.id).filter((id) => !aceitos.has(id));
    let mortos = 0;
    for (const { ids, mensagem, natureza } of agruparFalhas(entrega.falhas)) {
      mortos += marcarFalha(ids, mensagem, natureza);
    }
    if (mortos > 0) {
      // O aviso que antes só existia se alguém abrisse a tela.
      logWarn('CENTRAL_SYNC_EVENTO_PARADO', {
        eventos: mortos,
        motivo: entrega.erro ?? 'a central recusou o evento',
        comoResolver: 'Integrações › Banco central: resolver a causa e "Tentar novamente".',
      });
    }

    /**
     * PROJETAR VEM DEPOIS DE ENTREGAR, e nunca junto.
     *
     * São falhas separadas de propósito: se a projeção quebrar, o fato já está
     * salvo na aterrissagem; fosse a mesma operação, um erro de projeção
     * significaria fato perdido. Por isso o try/catch próprio — falha aqui NÃO
     * devolve o evento para a fila de envio, que já cumpriu seu papel.
     *
     * O QUE ACONTECE COM O FATO NÃO PROJETADO. Ele fica na aterrissagem com
     * `projected_at` nulo, e ESTE caminho não volta para buscá-lo: daqui a
     * pouco o evento sai da fila como `synced`, e `pendentes()` nunca mais o
     * devolve. Quem o alcança é `reprojetarPendentes`, em `Reprojection.ts`,
     * que parte da aterrissagem em vez da fila — comando administrativo
     * `reprojetar-central.js`, rodado por gente.
     *
     * Isso não era verdade até 29/08/2026: o comentário aqui prometia que o
     * fato "pode ser reprojetado" e não havia mecanismo nenhum. Os 118 eventos
     * desta instalação ficaram exatamente nesse estado.
     *
     * Sem transporte de projeção (nenhuma credencial), não se tenta nada: o
     * fato fica na aterrissagem esperando, que é o estado honesto.
     */
    let projected: ProjectionResult | undefined;
    const projecao = input?.projectionTransport ?? projectionTransportFromEnv();
    if (projecao && acceptedIds.length > 0) {
      const entregues = lote.filter((r) => aceitos.has(r.id));
      try {
        projected = await projetarLote(entregues, projecao);
      } catch (err) {
        projected = undefined;
        registrarErroDeProjecao(
          err instanceof Error ? err.message : 'Falha ao projetar na central.',
        );
      }

      /*
        O ERRO SUPERADO SAI DE CENA — mas só quando foi mesmo superado.

        Até 30/08/2026 esta chave só era escrita, nunca apagada: com a central
        100% saudável, o diagnóstico ainda exibia o PGRST202 da véspera, e
        "quebrou um dia" era indistinguível de "quebrou agora".

        Limpa-se apenas quando a central ACEITOU projeção nesta passada
        (`projectedIds` não vazio). Fila vazia não projeta nada; lote só de
        tipos desconhecidos entrega sem projetar — nenhum dos dois é prova de
        que a projeção voltou, e o erro fica. E a limpeza vem ANTES do
        carimbo de propósito: se o carimbo falhar agora, é o erro DELE que o
        diagnóstico deve mostrar, não o fóssil.
      */
      if (projected && projected.projectedIds.length > 0) {
        registrarProjecaoAceita();
      }

      /*
        O CARIMBO, depois da confirmação — e só nos ids aceitos.

        Até 30/08/2026 ninguém carimbava aqui: o único escritor de
        `projected_at` era a reprojeção administrativa, e todo evento novo
        ficava "não projetado" para sempre, com a linha de negócio já
        gravada. O diagnóstico mentiria mais a cada venda.

        Falha do carimbo NÃO derruba o sync: o fato está entregue e
        projetado, e o evento sem carimbo é exatamente o que a reprojeção
        sabe encontrar e refazer, idempotentemente. Registra-se o erro e
        segue-se — reter o envio por metadado seria inverter a hierarquia.
      */
      if (projected && projected.projectedIds.length > 0 && projecao.marcarProjetados) {
        try {
          await projecao.marcarProjetados(projected.projectedIds);
        } catch (err) {
          registrarErroDeProjecao(
            err instanceof Error ? err.message : 'Falha ao carimbar a projeção.',
          );
        }
      }
    }

    return {
      attempted: lote.length,
      sent: enviados,
      failed: naoConfirmados.length,
      projected,
      ...base,
      ...(entrega.erro ? { error: entrega.erro } : {}),
    };
  } catch (err) {
    // Só chega aqui o que não é do envio (a entrega já trata os dela): ainda
    // assim a natureza decide, para um defeito local não matar a fila.
    const mensagem = err instanceof Error ? err.message : 'Falha ao falar com a central.';
    marcarFalha(
      lote.map((r) => r.id),
      mensagem,
      naturezaDaFalha(err),
    );
    return { attempted: lote.length, sent: 0, failed: lote.length, ...base, error: mensagem };
  }
}

// ------------------------------------------------------------------- worker

let timer: ReturnType<typeof setInterval> | null = null;
let rodando = false;

export interface WorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  transport?: CentralTransport;
}

/**
 * Ciclo de fundo.
 *
 * Nunca lança: uma falha de rede não pode derrubar o processo que atende o
 * PDV. `rodando` impede que duas passadas se sobreponham quando a central
 * está lenta — sem isso, um envio de 40 s com intervalo de 15 s empilharia
 * chamadas até o processo engasgar.
 */
export function startSyncWorker(options?: WorkerOptions): void {
  if (timer) return;
  const intervalo = options?.intervalMs ?? 15_000;

  timer = setInterval(() => {
    if (rodando) return;
    rodando = true;
    void syncOnce({ transport: options?.transport, batchSize: options?.batchSize })
      .catch(() => undefined)
      .finally(() => {
        rodando = false;
      });
  }, intervalo);

  // Um timer de fundo não pode segurar o processo aberto no encerramento.
  timer.unref?.();
}

export function stopSyncWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  rodando = false;
}

export function syncWorkerRunning(): boolean {
  return timer !== null;
}
