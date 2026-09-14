/**
 * Backup do banco: snapshot de migração, cópia diária, verificação e
 * restauração.
 *
 * ATÉ A RODADA 35 este módulo fazia só a primeira coisa — e fazia bem: o
 * snapshot usa `VACUUM INTO`, a forma suportada de copiar um SQLite aberto,
 * com o WAL incluído. Copiar o `.db` sem o `-wal` produz um arquivo que parece
 * íntegro e está desatualizado: o pior tipo de backup.
 *
 * O QUE A AUDITORIA MEDIU, e este arquivo passou a responder:
 *
 *   1. O backup morava na mesma pasta do banco, no mesmo disco. Agora a pasta
 *      vem de `DEVORA_BACKUP_DIR`, e enquanto ela estiver no mesmo disco do
 *      banco, o diário avisa no log a cada execução. Não há como "resolver"
 *      isso em código: outro disco é decisão de quem opera.
 *   2. Não havia backup automático. `startDailyBackup` roda ao subir e a cada
 *      24 h, no backend, sem depender de alguém lembrar.
 *   3. A poda mantinha 10 arquivos sem distinguir motivo: dez migrações
 *      seguidas apagavam todos os backups manuais. Agora cada motivo é podado
 *      em separado, por idade, com um MÍNIMO que nunca é ultrapassado — a
 *      pasta nunca fica vazia por limpeza.
 *   4. Não havia restauração, e o script que dizia verificar procurava
 *      arquivos do projeto anterior. `restaurarBackupEm` e `verificarBackup`
 *      existem e são provados por teste que abre o arquivo de verdade.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: restaurar por cima do banco em uso. Com o
 * servidor ligado isso corrompe os dois. Quem restaura o banco operacional
 * para o servidor, desliga o servidor, renomeia o atual e restaura no caminho
 * livre — o script `db:restore` conduz esse caminho e recusa o outro.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { loadEnv } from '../config/env.js';
import { logError, logInfo } from '../utils/errors.js';
import { getConnection, repoRoot, resolveDatabasePath } from './sqlite.js';
import { isDisposableDatabase } from './safety.js';

const PREFIXO = 'grupo-sampaio-';

/** Retenção dos snapshots de migração: são muitos e valem pouco tempo. */
const MIGRACAO = { manterDias: 14, manterMinimo: 3, manterMaximo: 10 };
/** Retenção do diário e do manual: valem mais e são poucos. */
const DIARIO = { manterDias: 30, manterMinimo: 7 };

const DIA_MS = 24 * 60 * 60 * 1000;

export function backupDirectory(): string {
  const configurado = loadEnv().DEVORA_BACKUP_DIR?.trim();
  if (configurado) {
    return isAbsolute(configurado) ? configurado : resolve(repoRoot(), configurado);
  }
  return resolve(repoRoot(), 'server/data/backups');
}

/**
 * Raiz do volume (a letra, no Windows; `/`, no resto). Serve para saber se o
 * backup está no mesmo disco do banco — a única pergunta que importa quando
 * o disco morre.
 */
function discoDe(caminho: string): string {
  return parse(resolve(caminho)).root.toLowerCase();
}

/*
  O DISPOSITIVO, E NÃO SÓ A LETRA (GAP-PRD-068).

  Comparar a raiz do caminho acerta no Windows com letras diferentes, mas erra
  onde a letra não diz nada: no Linux e no container tudo começa por `/`, e um
  segundo disco montado em `/mnt/backup` aparecia como "mesmo disco" para
  sempre. O `dev` do `stat` é o identificador do volume (no Windows, o número
  de série do volume): dois caminhos com o mesmo `dev` moram no mesmo disco.
  Pasta que ainda não existe usa o ancestral mais próximo que existe; se nem
  isso der, vale a comparação pela raiz.
*/
function dispositivoDe(caminho: string): number | null {
  let atual = resolve(caminho);
  for (;;) {
    try {
      return statSync(atual).dev;
    } catch {
      const pai = parse(atual).dir;
      if (!pai || pai === atual) return null;
      atual = pai;
    }
  }
}

export function mesmoDisco(a: string, b: string): boolean {
  if (discoDe(a) !== discoDe(b)) return false;
  const da = dispositivoDe(a);
  const db = dispositivoDe(b);
  return da === null || db === null ? true : da === db;
}

export function backupNoMesmoDiscoDoBanco(): boolean {
  const banco = resolveDatabasePath();
  if (banco === ':memory:') return false;
  return mesmoDisco(backupDirectory(), isAbsolute(banco) ? banco : resolve(repoRoot(), banco));
}

export interface BackupResult {
  path: string;
  bytes: number;
  createdAt: string;
  skipped?: 'in-memory' | 'disposable';
}

/**
 * Copia um banco ABERTO para um arquivo novo, com o WAL incluído.
 *
 * É a única função que sabe copiar; `snapshotDatabase` e o diário passam por
 * aqui. Recebe a conexão, e não o caminho, para o teste poder usá-la sobre um
 * banco temporário próprio sem tocar no da suíte nem no operacional.
 */
export function copiarBancoParaArquivo(db: DatabaseSync, destino: string): void {
  mkdirSync(parse(destino).dir, { recursive: true });
  db.prepare('VACUUM INTO ?').run(destino);
}

/**
 * Tira um snapshot consistente do banco atual.
 *
 * NÃO tira de banco descartável, e isso não é otimização: o snapshot existe
 * para tornar reversível uma migração sobre DADO REAL. Um banco de teste é um
 * arquivo temporário que será jogado fora — não há o que restaurar.
 *
 * O custo de ignorar isso foi medido: a suíte passou de ~90 s para 223 s e
 * dezenas de testes estouraram o timeout, porque cada arquivo de teste roda as
 * migrações do zero e passou a copiar o banco inteiro no disco.
 */
/*
  QUAL BANCO NÃO SE COPIA — o DESCARTÁVEL, e só ele (achado da frente DEP/D2).

  A régua era `!isOperationalDatabase(origem)`: copiava só o banco que mora em
  `./server/data/grupo-sampaio.db`. Qualquer outro caminho era tratado como
  descartável — e o `DEPLOY.md` e a conferência da implantação mandam pôr o
  banco no "disco persistente definitivo" (`DEVORA_DATABASE_PATH=D:/...`).
  Quem seguisse o roteiro ficava SEM diário e sem cópia antes da migração, e
  sem uma linha no log: o pulo era calado.

  Descartável é o que se declara descartável, pela mesma régua das operações
  destrutivas (`db/safety.ts`): `:memory:` ou o caminho anunciado em
  `TEST_DATABASE_PATH`. A suíte anuncia o banco de cada worker, e por isso a
  medição de desempenho acima continua valendo.
*/
type PlanoDaCopia =
  | { pular: BackupResult }
  | { origem: string; destinoDir: string; destino: string; createdAt: string };

function planejarCopia(motivo: string, agora = new Date()): PlanoDaCopia {
  const origem = resolveDatabasePath();
  if (origem === ':memory:' || isDisposableDatabase(origem)) {
    return {
      pular: {
        path: '',
        bytes: 0,
        createdAt: agora.toISOString(),
        skipped: origem === ':memory:' ? 'in-memory' : 'disposable',
      },
    };
  }
  const carimbo = agora.toISOString().replace(/[:.]/g, '-');
  const destinoDir = backupDirectory();
  return {
    origem,
    destinoDir,
    destino: join(destinoDir, `${PREFIXO}${carimbo}-${motivo}.db`),
    createdAt: agora.toISOString(),
  };
}

function concluirCopia(motivo: string, destinoDir: string, destino: string, createdAt: string): BackupResult {
  // Cada motivo limpa só a própria família. Uma migração não apaga o diário.
  if (motivo.startsWith('pre-migracao')) {
    podarBackups(destinoDir, { ...MIGRACAO, motivo: 'pre-migracao' });
  } else {
    podarBackups(destinoDir, { ...DIARIO, motivo });
  }
  return {
    path: destino,
    bytes: existsSync(destino) ? statSync(destino).size : 0,
    createdAt,
  };
}

export function snapshotDatabase(motivo: string): BackupResult {
  const plano = planejarCopia(motivo);
  if ('pular' in plano) return plano.pular;
  copiarBancoParaArquivo(getConnection(), plano.destino);
  return concluirCopia(motivo, plano.destinoDir, plano.destino, plano.createdAt);
}

/*
  A CÓPIA DO DIÁRIO NÃO PARA O BALCÃO (GAP-PRD-058).

  `VACUUM INTO` na conexão da API roda na única thread do processo: enquanto o
  SQLite lê o banco inteiro e escreve a cópia, nenhuma venda anda. A cópia
  diária passa a rodar numa worker thread, com uma conexão PRÓPRIA e SÓ DE
  LEITURA sobre o mesmo arquivo. Com o WAL (o modo do banco), leitor não trava
  escritor: a cópia enxerga um instante consistente, com o `-wal` incluído, e
  a API segue atendendo.

  O código da worker é JavaScript puro (`eval`), e não um arquivo `.ts`: roda
  igual sob `tsx`, no `dist` compilado e dentro do Vitest, sem carregador.
  A cópia da MIGRAÇÃO, a da rotação de chave e a manual continuam síncronas de
  propósito: ali nada mais pode acontecer até a cópia existir.
*/
const CODIGO_DA_COPIA = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db = null;
try {
  db = new DatabaseSync(workerData.origem, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare('VACUUM INTO ?').run(workerData.destino);
  parentPort.postMessage({ ok: true });
} catch (erro) {
  parentPort.postMessage({ ok: false, erro: String((erro && erro.message) || erro), codigo: erro && erro.code });
} finally {
  if (db) db.close();
}
`;

/** Copia o arquivo de banco `origem` para `destino` numa worker thread, só lendo a origem. */
export function copiarArquivoDeBancoEmSegundoPlano(origem: string, destino: string): Promise<void> {
  mkdirSync(parse(destino).dir, { recursive: true });
  return new Promise<void>((aceitar, recusar) => {
    const worker = new Worker(CODIGO_DA_COPIA, { eval: true, workerData: { origem, destino } });
    let respondeu = false;
    worker.once('message', (m: { ok: boolean; erro?: string; codigo?: string }) => {
      respondeu = true;
      if (m.ok) aceitar();
      else {
        recusar(Object.assign(new Error(m.erro ?? 'A cópia do banco falhou.'), m.codigo ? { code: m.codigo } : {}));
      }
    });
    worker.once('error', (erro) => {
      respondeu = true;
      recusar(erro);
    });
    worker.once('exit', (codigo) => {
      if (!respondeu) recusar(new Error(`A cópia do banco terminou sem resposta (saída ${codigo}).`));
    });
  });
}

/** O snapshot, com a cópia numa worker thread. É o que o diário usa. */
export async function snapshotDatabaseEmSegundoPlano(motivo: string): Promise<BackupResult> {
  const plano = planejarCopia(motivo);
  if ('pular' in plano) return plano.pular;
  await copiarArquivoDeBancoEmSegundoPlano(plano.origem, plano.destino);
  return concluirCopia(motivo, plano.destinoDir, plano.destino, plano.createdAt);
}

// ------------------------------------------------------------------ inventário

export interface BackupListado {
  file: string;
  path: string;
  bytes: number;
  createdAt: string;
  motivo: string;
}

function motivoDe(nome: string): string {
  // grupo-sampaio-<carimbo>-<motivo>.db — o motivo é o último segmento, mas o
  // carimbo ISO também tem hífens; por isso se lê de trás para a frente e só
  // o que vem depois do último hífen do carimbo conta. Motivo composto
  // ("pre-migracao-v60") é reconhecido pelo prefixo.
  const semExt = nome.slice(PREFIXO.length, -'.db'.length);
  if (semExt.includes('-pre-migracao')) return 'pre-migracao';
  const ultimo = semExt.split('-').pop() ?? '';
  return ultimo || 'desconhecido';
}

export function listarBackups(dir = backupDirectory()): BackupListado[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(PREFIXO) && f.endsWith('.db'))
    .map((f) => {
      const st = statSync(join(dir, f));
      return {
        file: f,
        path: join(dir, f),
        bytes: st.size,
        createdAt: st.mtime.toISOString(),
        motivo: motivoDe(f),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------- poda

export interface RegraDePoda {
  /** Arquivos mais velhos que isto são candidatos a sair. */
  manterDias: number;
  /** NUNCA deixa menos que isto, por mais velhos que sejam. */
  manterMinimo: number;
  /** Opcional: acima disto, os mais velhos saem mesmo dentro do prazo. */
  manterMaximo?: number;
  /** Só arquivos deste motivo; sem motivo, todos. */
  motivo?: string;
}

/**
 * Apaga o que passou do prazo, respeitando um mínimo que nunca é ultrapassado.
 *
 * O mínimo é o que impede o defeito medido: a poda antiga apagava pelo
 * número, e um fim de semana de migrações deixava a pasta sem nenhum backup
 * do dono.
 */
export function podarBackups(dir: string, regra: RegraDePoda): number {
  const familia = listarBackups(dir).filter((b) =>
    regra.motivo ? b.motivo === regra.motivo || b.file.includes(`-${regra.motivo}`) : true,
  );
  // Do mais novo ao mais velho. Os primeiros `manterMinimo` são intocáveis.
  const limite = Date.now() - regra.manterDias * DIA_MS;
  let apagados = 0;
  familia.forEach((b, indice) => {
    if (indice < regra.manterMinimo) return;
    const velho = new Date(b.createdAt).getTime() < limite;
    const excedente = regra.manterMaximo !== undefined && indice >= regra.manterMaximo;
    if (!velho && !excedente) return;
    try {
      unlinkSync(b.path);
      apagados += 1;
    } catch {
      // Um backup que não pôde ser removido não é motivo para abortar o que a
      // poda estava acompanhando.
    }
  });
  return apagados;
}

// ------------------------------------------------------- verificação/restauro

export interface Veredito {
  ok: boolean;
  motivo?: string;
  tabelas?: number;
}

/**
 * Abre o arquivo como SQLite, só leitura, e pergunta ao próprio SQLite se
 * ele está íntegro. Não confere SHA de cópia — confere que o conteúdo serve.
 */
export function verificarBackup(caminho: string): Veredito {
  if (!existsSync(caminho)) return { ok: false, motivo: 'Arquivo não existe.' };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(caminho, { readOnly: true });
    const integridade = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integridade.integrity_check !== 'ok') {
      return { ok: false, motivo: `integrity_check: ${integridade.integrity_check}` };
    }
    const tabelas = (
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    ).n;
    if (tabelas === 0) return { ok: false, motivo: 'O arquivo abre, mas não tem nenhuma tabela.' };
    return { ok: true, tabelas };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

/**
 * Restaura um backup NUM CAMINHO NOVO. Recusa destino que já existe — ver o
 * cabeçalho: restaurar por cima do banco em uso corrompe os dois.
 */
export function restaurarBackupEm(backup: string, destino: string): Veredito {
  const veredito = verificarBackup(backup);
  if (!veredito.ok) return { ok: false, motivo: `O backup não passou na verificação: ${veredito.motivo}` };
  if (existsSync(destino)) {
    return {
      ok: false,
      motivo: `O destino já existe (${destino}). Restaurar por cima de um banco corrompe os dois; `
        + 'renomeie o atual e restaure num caminho livre.',
    };
  }
  mkdirSync(parse(destino).dir, { recursive: true });
  copyFileSync(backup, destino);
  // O restaurado também tem que abrir — copiar não é garantia.
  const conferido = verificarBackup(destino);
  if (!conferido.ok) {
    unlinkSync(destino);
    return { ok: false, motivo: `A cópia restaurada não abriu: ${conferido.motivo}` };
  }
  return conferido;
}

// ---------------------------------------------------------------- diário

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * A JANELA DO DIÁRIO — 20 h, e não 24 h exatas.
 *
 * Um servidor que sobe todo dia às 8h05 e ontem subiu às 8h00 teria 24h05 de
 * intervalo. Com uma régua de 24 h cravadas ele alternaria entre copiar e não
 * copiar conforme o minuto do relógio. A folga faz o comportamento ser
 * previsível para quem olha a pasta.
 */
const JANELA_DO_DIARIO_MS = 20 * 60 * 60 * 1000;

/**
 * Já existe cópia DIÁRIA recente nesta pasta?
 *
 * Só a família `diario` conta. A cópia de migração e a de rotação de chave
 * são tiradas por outro motivo, num instante que ninguém escolheu, e somem por
 * outra régua de retenção — deixá-las contar faria uma migração cancelar o
 * diário daquele dia.
 */
export function jaHaBackupDeHoje(dir = backupDirectory()): boolean {
  const diarios = listarBackups(dir).filter((b) => b.motivo === 'diario');
  if (diarios.length === 0) return false;
  // `listarBackups` já devolve do mais novo para o mais velho.
  const maisNovo = new Date(diarios[0].createdAt).getTime();
  return Date.now() - maisNovo < JANELA_DO_DIARIO_MS;
}

/** O diário mais recente da pasta, ou `null`. */
export function ultimoDiario(dir = backupDirectory()): BackupListado | null {
  return listarBackups(dir).find((b) => b.motivo === 'diario') ?? null;
}

/**
 * Liga o diário. Roda ao subir — o servidor pode ter passado dias desligado —
 * e depois todo dia na hora marcada (`DEVORA_BACKUP_HORA`, padrão 03:00 pelo
 * relógio da loja — GAP-PRD-058). `unref` para não segurar o processo no
 * desligamento. A execução em si (cópia numa worker thread, envio do banco e
 * das fotos, registro) mora em `services/backup/diarioDoBackup.ts`.
 *
 * ============================================================================
 * MAS SÓ SE AINDA NÃO HOUVER UMA DE HOJE
 * ============================================================================
 *
 * A cópia ao subir tem motivo bom: o servidor pode ter passado dias
 * desligado, e esperar 24 h pela primeira deixaria uma janela sem proteção.
 * Faltava a outra metade da frase.
 *
 * Sem ela, cada subida do processo produzia um arquivo de 5 MB e um envio ao
 * bucket. Medido em 27/08/2026, com o sistema ainda em bancada:
 *
 *     717 arquivos locais    3,6 GB    entre 18 e 27/08 — nove dias
 *     529 objetos no bucket  2,7 GB
 *
 * `tsx watch` reinicia o servidor a cada salvamento. Cada reinício, uma
 * cópia. E a poda local é por DATA — "30 dias, mínimo 7" —, então setecentos
 * arquivos de nove dias não são podados por nada; o bucket não tem poda
 * nenhuma e é armazenamento pago.
 *
 * O que mais pesa não é o custo. Cada objeto é uma cópia INTEIRA do banco das
 * seis empresas: multiplicar cópias multiplica exposição. Foi esse número,
 * 529, que transformou "a chave de cifra era a padrão" num incidente com
 * credencial a trocar no portal do provedor.
 *
 * Em produção o servidor reinicia pouco, e por isso é tentador chamar isto de
 * problema de bancada. Não é: um deploy em laço de reinício, ou um supervisor
 * reerguendo um processo que morre, produz o mesmo efeito contra o bucket de
 * produção.
 */
/*
  A EXECUÇÃO MARCADA PULA SÓ SE A DA SUBIDA ACABOU DE RODAR.

  Subir às 02h50 sem diário de hoje tira a cópia na hora; às 03h00 a marcada
  não tira outra dez minutos depois. A janela é curta (2 h) de propósito: com
  a de 20 h da subida, uma cópia ao subir às 10h cancelaria a das 03h do dia
  seguinte e deixaria 41 h entre duas cópias.
*/
const JANELA_DA_MARCADA_MS = 2 * 60 * 60 * 1000;

let ligado = false;
let emCurso: Promise<void> | null = null;

function rodarDiario(gatilho: 'boot' | 'agenda'): void {
  if (emCurso) {
    logInfo('backup_diario_em_curso', { gatilho });
    return;
  }
  // Import dinâmico: o diário importa este módulo, e o estático fecharia o ciclo.
  emCurso = import('../services/backup/diarioDoBackup.js')
    .then((m) => m.executarDiario({ gatilho }))
    .then(() => undefined)
    .catch((err) => {
      logError('backup_diario_falhou', { err });
    })
    .finally(() => {
      emCurso = null;
    });
}

function agendarProxima(): void {
  if (!ligado) return;
  void import('../services/backup/agendaDoBackup.js')
    .then(({ horaDoDiario, proximaExecucaoDoDiario }) => {
      if (!ligado) return;
      const agora = new Date();
      const proxima = proximaExecucaoDoDiario(agora, horaDoDiario());
      timer = setTimeout(() => {
        timer = null;
        const ultimo = ultimoDiario();
        if (ultimo && Date.now() - new Date(ultimo.createdAt).getTime() < JANELA_DA_MARCADA_MS) {
          logInfo('backup_diario_pulado', { motivo: 'a cópia da subida tem menos de 2 h' });
        } else {
          rodarDiario('agenda');
        }
        agendarProxima();
      }, Math.max(1_000, proxima.getTime() - agora.getTime()));
      timer.unref();
      logInfo('backup_diario_agendado', { proxima: proxima.toISOString() });
    })
    .catch((err) => {
      logError('backup_agenda_falhou', { err });
    });
}

export function startDailyBackup(): void {
  if (ligado) return;
  ligado = true;
  if (jaHaBackupDeHoje()) {
    logInfo('backup_diario_pulado', {
      motivo: 'já existe cópia diária de menos de 20 h — esta subida não tira outra',
    });
  } else {
    rodarDiario('boot');
  }
  agendarProxima();
}

export function stopDailyBackup(): void {
  ligado = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
