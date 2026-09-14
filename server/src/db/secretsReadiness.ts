/**
 * ============================================================================
 * A PRONTIDÃO DO COFRE — o que está selado, com qual chave, e o que ainda falta
 * ============================================================================
 *
 * Responde a pergunta que decide se dá para publicar, e responde SEM entregar
 * valor nenhum. Cada campo é um de poucos rótulos:
 *
 *   PRODUCTION_SAFE      a chave é própria e longa
 *   DEVELOPMENT_DEFAULT  é a padrão escrita no código-fonte — em produção,
 *                        isso é o mesmo que não ter cofre
 *   MISSING              não há chave declarada (cai na padrão)
 *
 *   SEALED_CURRENT_KEY   o segredo abre com a chave que este processo usa
 *   LEGACY_KEY           existe, mas foi selado com OUTRA chave: não abre.
 *                        É o estado que uma rotação incompleta deixa
 *   ABSENT               não existe
 *
 * ## Por que `LEGACY_KEY` importa tanto
 *
 * Um segredo nesse estado não dá erro até alguém precisar dele — e quem
 * precisa do `.pfx` é a emissão da nota, com o cliente no balcão. Ter o estado
 * antes, numa tela, é a diferença entre descobrir na conferência e descobrir
 * na fila.
 *
 * ============================================================================
 * RESSELAR NÃO É TROCAR
 * ============================================================================
 *
 * `SEALED_CURRENT_KEY` diz que o cofre está fechado com a chave certa HOJE. Não
 * diz nada sobre ontem.
 *
 * Os cinco segredos desta instalação viveram selados com a chave PADRÃO de
 * desenvolvimento — a que está escrita no repositório. Enquanto isso valia,
 * cópias inteiras do banco saíram da máquina: 527 objetos no bucket remoto, 717
 * no disco local. Cada uma abre os cinco para quem tiver o repositório.
 *
 * Resselar troca a fechadura de uma porta cuja cópia da chave antiga já está na
 * rua. Para o `.pfx` isso é tolerável — ele é inútil sem a senha, que nunca
 * esteve no banco. Para uma chave de API do Asaas não é: ela É a credencial.
 *
 * Por isso cada credencial de provedor carrega DOIS fatos: o selo de hoje e se
 * ela ainda precisa ser trocada no portal de quem a emitiu.
 *
 * O critério é o carimbo. `marcarCofreRotacionado` grava quando a rotação
 * aconteceu; credencial cujo último toque humano é anterior a isso viveu
 * exposta. A marca se apaga sozinha quando o dono cola a credencial nova — o
 * `updatedAt` passa da rotação e o diagnóstico para de cobrar, sem ninguém
 * mexer em código.
 */
import { loadEnv } from '../config/env.js';
import { getConnection, resolveDatabasePath } from './sqlite.js';
import { ensureCoreSchema } from './schema.js';
import { inventariarSegredos, type SegredoNoCofre } from './secretsInventory.js';
import { legadosPresentes, syncStatus } from '../services/sync/SyncService.js';
import { backupNoMesmoDiscoDoBanco } from './backup.js';
import { findRows } from './database.js';
import { estadoDaPublicacao } from '../middleware/observarProxy.js';

/** A padrão que o código usa quando ninguém declara. Não é segredo. */
const PADRAO_DE_DESENVOLVIMENTO = 'dev-local-encryption-key-32';
const PADRAO_DO_JWT = 'dev-local-jwt-secret';

/** Onde a marca da rotação mora. Uma linha, uma data. */
const META_ROTACAO = 'cofre_rotacionado_em';

export type EstadoDaChave = 'PRODUCTION_SAFE' | 'DEVELOPMENT_DEFAULT' | 'MISSING';
export type EstadoDoSegredo = 'SEALED_CURRENT_KEY' | 'LEGACY_KEY' | 'ABSENT';
export type TrocaNoProvedor = 'REQUIRED' | 'NOT_REQUIRED';

/** O selo de hoje e a dívida de ontem, separados de propósito. */
export interface EstadoDeCredencial {
  selo: EstadoDoSegredo;
  trocaNoProvedor: TrocaNoProvedor;
}

export interface EstadoDaCentral {
  readiness: string;
  /** Nomes de variável que faltam — nunca valores. */
  missing: string[];
  /** Nomes ANTIGOS encontrados no ambiente, para não sumirem em silêncio. */
  legados: Array<{ antigo: string; oficial: string }>;
}

export interface EstadoDaFila {
  pending: number;
  oldestPendingAt: string | null;
}

/** O backup local mora em outra mídia física que o banco? */
export type MidiaDoBackup = 'YES' | 'NO';

/**
 * O que separa "habilitado" de "pronto" no Asaas de produção.
 *
 * A variável de ambiente diz que a integração está LIGADA. Isso não é a
 * mesma coisa que poder cobrar alguém de verdade.
 */
export type GoLiveDoAsaas =
  | 'NOT_ENABLED'
  | 'BLOCKED_NO_CREDENTIAL'
  | 'BLOCKED_CREDENTIAL_ROTATION'
  | 'BLOCKED_NOT_TESTED'
  | 'READY';

export interface ProntidaoDosSegredos {
  encryptionKey: EstadoDaChave;
  jwtSecret: EstadoDaChave;
  a1Pfx: EstadoDoSegredo;
  a1Password: EstadoDoSegredo;
  asaasSandbox: EstadoDeCredencial;
  asaasProduction: EstadoDeCredencial;
  asaasWebhook: EstadoDeCredencial;
  email: EstadoDeCredencial;
  centralSync: EstadoDaCentral;
  outbox: EstadoDaFila;
  /**
   * O backup local está em outra mídia?
   *
   * Hoje, não: `DEVORA_BACKUP_DIR` nunca foi definida e o padrão é a pasta
   * vizinha do banco. O servidor já avisa isso no log a cada boot, e log de
   * boot é lido no dia em que já deu errado. `NO` aqui significa que a
   * proteção real é a cópia remota, e só ela.
   */
  localBackupSeparateMedia: MidiaDoBackup;
  asaasGoLive: GoLiveDoAsaas;
  /** Quantos existem e NÃO abrem com a chave atual. Zero é o que se quer. */
  legadoPendente: number;
  /** Quando o cofre foi rotacionado, se foi. */
  cofreRotacionadoEm: string | null;
  /**
   * A publicação vista pelas requisições (GAP-PRD-055): `DEVORA_TRUST_PROXY`
   * declarado e o que chegou de fato — proxy não declarado, ou caminho que
   * contorna o proxy declarado. Ver `middleware/observarProxy.ts`.
   */
  publicacao: ReturnType<typeof estadoDaPublicacao>;
  checkedAt: string;
}

function meta(chave: string): string | null {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const linha = db.prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as
    | { value: string }
    | undefined;
  return linha?.value ?? null;
}

/**
 * Registra que o cofre foi rotacionado a partir de uma chave PUBLICADA.
 *
 * Só a rotação chama isto, e só quando a chave antiga era conhecida — rotação
 * entre duas chaves próprias não gera dívida com provedor nenhum.
 */
export function marcarCofreRotacionado(quando: string): void {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare(
    'INSERT INTO core_meta (key, value) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(META_ROTACAO, quando);
}

function estadoDaChave(valor: string | undefined, padrao: string): EstadoDaChave {
  if (!valor) return 'MISSING';
  if (valor === padrao) return 'DEVELOPMENT_DEFAULT';
  return 'PRODUCTION_SAFE';
}

/** O estado de cada segredo, e nenhum valor. */
export function prontidaoDosSegredos(): ProntidaoDosSegredos {
  const segredos = inventariarSegredos();
  const rotacionadoEm = meta(META_ROTACAO);

  const acha = (predicado: (s: SegredoNoCofre) => boolean): EstadoDoSegredo => {
    const s = segredos.find(predicado);
    if (!s) return 'ABSENT';
    return s.decryptableWithCurrentKey ? 'SEALED_CURRENT_KEY' : 'LEGACY_KEY';
  };

  /**
   * A credencial viveu selada pela chave publicada?
   *
   * Sem marca de rotação a resposta é não — não se acusa o que não se sabe. Com
   * marca, decide o carimbo do último toque HUMANO na credencial: o resselo não
   * mexe nele de propósito, justamente para que este cálculo continue valendo.
   */
  const credencial = (predicado: (s: SegredoNoCofre) => boolean): EstadoDeCredencial => {
    const s = segredos.find(predicado);
    if (!s) return { selo: 'ABSENT', trocaNoProvedor: 'NOT_REQUIRED' };
    const selo: EstadoDoSegredo = s.decryptableWithCurrentKey
      ? 'SEALED_CURRENT_KEY'
      : 'LEGACY_KEY';
    if (!rotacionadoEm) return { selo, trocaNoProvedor: 'NOT_REQUIRED' };
    const tocadaEm = s.atualizadoEm ?? null;
    // Sem carimbo, o lado seguro é cobrar: melhor uma troca a mais que uma
    // credencial exposta considerada limpa.
    const anterior = tocadaEm === null || tocadaEm <= rotacionadoEm;
    return { selo, trocaNoProvedor: anterior ? 'REQUIRED' : 'NOT_REQUIRED' };
  };

  const porTipoDeIntegracao = (tipo: string): EstadoDeCredencial =>
    credencial((s) => s.tipo === 'integration_secret' && s.detalhe === tipo);

  return {
    encryptionKey: estadoDaChave(
      process.env.DEVORA_ENCRYPTION_KEY ? loadEnv().DEVORA_ENCRYPTION_KEY : undefined,
      PADRAO_DE_DESENVOLVIMENTO,
    ),
    jwtSecret: estadoDaChave(
      process.env.DEVORA_JWT_SECRET ? loadEnv().DEVORA_JWT_SECRET : undefined,
      PADRAO_DO_JWT,
    ),
    a1Pfx: acha((s) => s.tipo === 'a1_pfx'),
    a1Password: acha((s) => s.tipo === 'a1_password'),
    asaasSandbox: porTipoDeIntegracao('asaas_sandbox_api_key'),
    asaasProduction: porTipoDeIntegracao('asaas_production_api_key'),
    asaasWebhook: porTipoDeIntegracao('webhook_token'),
    email: credencial((s) => s.tipo === 'email_password'),
    centralSync: estadoDaCentral(),
    outbox: estadoDaFila(),
    localBackupSeparateMedia: midiaDoBackup(),
    asaasGoLive: goLiveDoAsaas(segredos, rotacionadoEm),
    legadoPendente: segredos.filter((s) => !s.decryptableWithCurrentKey).length,
    cofreRotacionadoEm: rotacionadoEm,
    publicacao: estadoDaPublicacao(),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * O backup local está em outra mídia FÍSICA?
 *
 * A comparação é pela raiz do volume — a letra, no Windows; `/`, no resto.
 * É a única pergunta que importa quando o disco morre: pasta diferente no
 * mesmo disco não protege de nada.
 *
 * Não se inventa disco que não existe. O campo diz o que é, e o destino de
 * hospedagem é que vai resolver.
 */
function midiaDoBackup(): MidiaDoBackup {
  try {
    const banco = resolveDatabasePath();
    if (!banco || banco === ':memory:') return 'NO';
    // A mesma régua da tela de backup (GAP-PRD-068): o volume, e não só a letra.
    return backupNoMesmoDiscoDoBanco() ? 'NO' : 'YES';
  } catch {
    return 'NO';
  }
}

/**
 * Habilitado não é pronto.
 *
 * `ASAAS_PRODUCTION_ENABLED=true` diz que a integração está LIGADA. Para
 * cobrar alguém de verdade faltam três coisas, e a terceira é a que quase
 * escapa: o selo de "conexão verificada" fica gravado no estado da integração
 * e SOBREVIVE à troca da chave. Sem olhar a data, uma credencial recém-colada
 * herdaria a aprovação de outra — que é destravar produção de mentira.
 */
function goLiveDoAsaas(
  segredos: SegredoNoCofre[],
  rotacionadoEm: string | null,
): GoLiveDoAsaas {
  if (process.env.ASAAS_PRODUCTION_ENABLED !== 'true') return 'NOT_ENABLED';

  const producao = segredos.find(
    (s) => s.tipo === 'integration_secret' && s.detalhe === 'asaas_production_api_key',
  );
  if (!producao) return 'BLOCKED_NO_CREDENTIAL';

  const tocadaEm = producao.atualizadoEm ?? null;
  const pedeTroca =
    Boolean(rotacionadoEm) && (tocadaEm === null || tocadaEm <= (rotacionadoEm as string));
  if (pedeTroca) return 'BLOCKED_CREDENTIAL_ROTATION';

  /*
    O teste tem de ser POSTERIOR à credencial que está lá agora. Um teste
    anterior verificou outra chave.

    E tem de ser o teste da chave de PRODUÇÃO (GAP-PRD-170). O selo lido aqui
    era `connectionVerified`, que o teste do ambiente efetivo carimbava com a
    chave de SANDBOX enquanto a porta de produção estava fechada. Cada
    ambiente tem o próprio selo agora, e é o da produção que responde "a
    chave de produção funciona".
  */
  let verificado = false;
  try {
    for (const linha of findRows<Record<string, unknown>>('integration_configurations', () => true)) {
      if (String(linha.provider ?? '') !== 'asaas') continue;
      if (producao.companyId && String(linha.companyId ?? "") !== producao.companyId) continue;
      if (linha.productionConnectionVerified !== true) continue;
      const quando =
        typeof linha.productionConnectionTestedAt === 'string' ? linha.productionConnectionTestedAt : null;
      if (quando && tocadaEm && quando > tocadaEm) verificado = true;
    }
  } catch {
    verificado = false;
  }
  return verificado ? 'READY' : 'BLOCKED_NOT_TESTED';
}

function estadoDaCentral(): EstadoDaCentral {
  try {
    const s = syncStatus();
    return { readiness: s.readiness, missing: s.missing, legados: legadosPresentes() };
  } catch {
    // O diagnóstico não pode cair por causa de uma parte dele.
    return { readiness: 'UNKNOWN', missing: [], legados: [] };
  }
}

/**
 * A fila para a central, no diagnóstico do dono.
 *
 * 118 eventos ficaram doze dias parados sem ninguém perceber, porque o único
 * lugar que contava a história era o log do boot — e log de boot é lido no dia
 * em que já deu errado.
 */
function estadoDaFila(): EstadoDaFila {
  try {
    ensureCoreSchema();
    const db = getConnection();
    const r = db
      .prepare(
        "SELECT COUNT(*) AS n, MIN(created_at) AS mais_antigo FROM core_outbox WHERE status = 'pending'",
      )
      .get() as { n: number; mais_antigo: string | null };
    return { pending: r.n, oldestPendingAt: r.mais_antigo };
  } catch {
    return { pending: 0, oldestPendingAt: null };
  }
}
