/**
 * ============================================================================
 * UMA INSTÂNCIA POR ARQUIVO DE BANCO (GAP-PRD-137)
 * ============================================================================
 *
 * A topologia suportada é UMA API por arquivo SQLite, e nada a garantia. A
 * auditoria mediu o que acontece com dois processos no mesmo `.db`: eles
 * "quase" funcionam — o que é pior que recusar.
 *
 *   - a escrita serializa, mas uma transação longa do outro (backup, bootstrap
 *     em lotes, migração) faz a venda esperar; passando de 5 s
 *     (`busy_timeout`), vira "database is locked" e a venda responde 500;
 *   - os trabalhadores de fundo DOBRAM: o carteiro lê os e-mails pendentes e
 *     só marca depois de enviar — dois carteiros mandam o mesmo e-mail;
 *   - as migrações do núcleo conferem e marcam passo sem trava entre
 *     processos: dois boots ao mesmo tempo aplicam o mesmo passo.
 *
 * ## A trava
 *
 * Uma linha em `core_instancia` diz QUEM é o dono do banco: tipo (API,
 * migração, manutenção), pid, máquina, desde quando, e a última batida (a API
 * bate a cada 10 s). Quem sobe tenta assumir dentro de `BEGIN IMMEDIATE` — dois
 * processos subindo juntos serializam ali, e só um vence.
 *
 * Quando o dono registrado ainda vale:
 *
 *   - MESMA MÁQUINA: o pid manda. Processo vivo = ocupado, mesmo com a batida
 *     atrasada — uma migração síncrona longa não bate, e continua sendo dona.
 *     Processo morto (queda, `tsx watch` que matou o filho, tarefa encerrada à
 *     força) = assume na hora, sem esperar prazo nenhum.
 *     A exceção é a batida parada há mais de 10 min com o pid vivo: o número
 *     foi reaproveitado por outro programa (o Windows reusa pid) — assume, e
 *     diz no log.
 *   - OUTRA MÁQUINA (banco numa pasta de rede — que o SQLite nem suporta com
 *     WAL): só a batida vale. Mais de 30 s sem bater = o dono morreu.
 *
 * O dono que perde a linha (outra máquina assumiu depois de 30 s de silêncio,
 * ou um pid reaproveitado foi dado como morto) descobre na batida seguinte e
 * DESLIGA com 1: dois donos é exatamente o que a trava existe para impedir.
 *
 * Quem usa: o boot da API (`index.ts`, antes de migrar e antes de abrir a
 * porta), o `db:migrate` e a poda das tabelas aposentadas. A tela Sistema
 * mostra o dono (`GET /system/release`).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getConnection, resolveDatabasePath, withTransaction } from '../../db/sqlite.js';
import { DDL_DA_INSTANCIA } from '../../db/schema.js';
import { logError, logInfo, logWarn } from '../../utils/errors.js';

export type TipoDeInstancia = 'api' | 'migracao' | 'manutencao';

export interface DonoDoBanco {
  tipo: string;
  pid: number;
  host: string;
  iniciadoEm: string;
  batidaEm: string;
}

/** A API bate a cada 10 s. */
export const BATIDA_MS = 10_000;
/** Outra máquina sem bater há 30 s (três batidas perdidas) = morreu. */
export const PRAZO_DA_BATIDA_MS = 30_000;
/** Pid vivo na mesma máquina sem bater há 10 min = o número foi reaproveitado. */
export const LIMITE_DO_PID_REAPROVEITADO_MS = 10 * 60_000;
/**
 * Quanto a API espera o dono anterior sair antes de desistir: cobre os 8 s do
 * desligamento limpo (`cicloDoProcesso`) de quem está descendo.
 */
export const ESPERA_DA_API_MS = 12_000;

const PAPEL = 'dono';

export interface AmbienteDaTrava {
  pid: number;
  host: string;
  agora: () => number;
  pidVivo: (pid: number) => boolean;
}

/** `kill(pid, 0)` não mata nada: só pergunta se o processo existe. */
export function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe, e é de outro usuário. ESRCH: não existe.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ambientePadrao(): AmbienteDaTrava {
  return { pid: process.pid, host: hostname(), agora: Date.now, pidVivo: processoVivo };
}

interface Linha {
  token: string;
  tipo: string;
  pid: number;
  host: string;
  iniciado_em: string;
  batida_em: string;
}

function paraDono(l: Linha): DonoDoBanco {
  return { tipo: l.tipo, pid: Number(l.pid), host: l.host, iniciadoEm: l.iniciado_em, batidaEm: l.batida_em };
}

function lerLinha(): Linha | undefined {
  const db = getConnection();
  db.exec(DDL_DA_INSTANCIA);
  return db
    .prepare('SELECT token, tipo, pid, host, iniciado_em, batida_em FROM core_instancia WHERE papel = ?')
    .get(PAPEL) as Linha | undefined;
}

/** O dono atual do banco, ou `null` quando ninguém assumiu. Só lê. */
export function donoDoBanco(): DonoDoBanco | null {
  const l = lerLinha();
  return l ? paraDono(l) : null;
}

export type MotivoDeAssumir =
  | 'livre'
  | 'mesmo_processo'
  | 'processo_morto'
  | 'pid_reaproveitado'
  | 'batida_vencida';

export type Decisao =
  | { assumiu: true; token: string; motivo: MotivoDeAssumir; anterior: DonoDoBanco | null }
  | { assumiu: false; dono: DonoDoBanco; motivo: 'processo_vivo' | 'outra_maquina' };

/**
 * Uma tentativa, sem espera. Dentro de `BEGIN IMMEDIATE`: dois processos que
 * tentam ao mesmo tempo serializam aqui.
 */
export function tentarAssumir(tipo: TipoDeInstancia, parcial: Partial<AmbienteDaTrava> = {}): Decisao {
  const amb = { ...ambientePadrao(), ...parcial };
  getConnection().exec(DDL_DA_INSTANCIA);
  return withTransaction((): Decisao => {
    const atual = lerLinha();
    let motivo: MotivoDeAssumir = 'livre';
    if (atual) {
      const idade = amb.agora() - Date.parse(atual.batida_em);
      const semBatidaValida = !Number.isFinite(idade);
      if (atual.host === amb.host) {
        if (Number(atual.pid) === amb.pid) motivo = 'mesmo_processo';
        else if (!amb.pidVivo(Number(atual.pid))) motivo = 'processo_morto';
        else if (semBatidaValida || idade > LIMITE_DO_PID_REAPROVEITADO_MS) motivo = 'pid_reaproveitado';
        else return { assumiu: false, dono: paraDono(atual), motivo: 'processo_vivo' };
      } else if (semBatidaValida || idade > PRAZO_DA_BATIDA_MS) {
        motivo = 'batida_vencida';
      } else {
        return { assumiu: false, dono: paraDono(atual), motivo: 'outra_maquina' };
      }
    }
    const token = randomUUID();
    const agoraIso = new Date(amb.agora()).toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_instancia (papel, token, tipo, pid, host, iniciado_em, batida_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(papel) DO UPDATE SET
           token = excluded.token, tipo = excluded.tipo, pid = excluded.pid, host = excluded.host,
           iniciado_em = excluded.iniciado_em, batida_em = excluded.batida_em`,
      )
      .run(PAPEL, token, tipo, amb.pid, amb.host, agoraIso, agoraIso);
    return { assumiu: true, token, motivo, anterior: atual ? paraDono(atual) : null };
  });
}

/**
 * Uma batida. Devolve `false` quando a linha já não é deste token — alguém
 * assumiu o banco, e este processo deixou de ser o dono.
 */
export function baterUmaVez(token: string, agora: () => number = Date.now): boolean {
  const r = getConnection()
    .prepare('UPDATE core_instancia SET batida_em = ? WHERE papel = ? AND token = ?')
    .run(new Date(agora()).toISOString(), PAPEL, token);
  return Number(r.changes) > 0;
}

/** Solta a linha, se ainda for deste token. Nunca lança: roda no desligamento. */
export function liberarInstancia(token: string): boolean {
  try {
    const r = getConnection().prepare('DELETE FROM core_instancia WHERE papel = ? AND token = ?').run(PAPEL, token);
    return Number(r.changes) > 0;
  } catch {
    return false;
  }
}

function descricaoDoTipo(tipo: string): string {
  if (tipo === 'api') return 'uma API';
  if (tipo === 'migracao') return 'uma migração (db:migrate)';
  if (tipo === 'manutencao') return 'um comando de manutenção do banco';
  return `um processo (${tipo})`;
}

/** A frase que o operador lê quando o banco já tem dono. */
export function fraseDoBancoOcupado(dono: DonoDoBanco, caminho: string, agora: number = Date.now()): string {
  const segundos = Math.max(0, Math.round((agora - Date.parse(dono.batidaEm)) / 1000));
  return (
    `Outra instância já usa este banco: ${descricaoDoTipo(dono.tipo)}, pid ${dono.pid} em ${dono.host}, `
    + `desde ${dono.iniciadoEm} (última batida há ${Number.isFinite(segundos) ? segundos : '?'} s). `
    + 'O sistema roda UMA instância por arquivo de banco: dois processos no mesmo arquivo disputam a '
    + 'escrita (a espera passa de 5 s e a venda recebe "database is locked"), dobram os trabalhadores de '
    + 'fundo (o mesmo e-mail sai duas vezes) e migram sem trava. Pare a outra '
    + '(node server/dist/scripts/parar-api.js, ou a tarefa/serviço que a levanta) ou aponte '
    + `DEVORA_DATABASE_PATH para outro arquivo. Banco: ${caminho}`
  );
}

export class BancoOcupado extends Error {
  readonly code = 'DEVORA_BANCO_OCUPADO';

  constructor(readonly dono: DonoDoBanco, readonly caminho: string) {
    super(fraseDoBancoOcupado(dono, caminho));
    this.name = 'BancoOcupado';
  }
}

export interface Trava {
  token: string;
  /** Para de bater (o desligamento chama antes de fechar o banco). */
  pararDeBater: () => void;
  /** Para de bater e solta a linha. */
  liberar: () => void;
}

export interface OpcoesDeAssumir {
  /** Quanto esperar o dono atual sair antes de desistir. 0 = recusa na hora. */
  esperaMs?: number;
  pausaMs?: number;
  /** Intervalo da batida; 0 = não bate (comando curto e síncrono). */
  batidaMs?: number;
  /** Chamado quando a batida descobre que a linha é de outro. */
  aoPerder?: (dono: DonoDoBanco | null) => void;
  ambiente?: Partial<AmbienteDaTrava>;
}

function comecarABater(token: string, intervalo: number, aoPerder: (dono: DonoDoBanco | null) => void): () => void {
  let parado = false;
  const timer = setInterval(() => {
    if (parado) return;
    try {
      if (!baterUmaVez(token)) {
        parado = true;
        clearInterval(timer);
        aoPerder(donoDoBanco());
      }
    } catch (err) {
      // Banco ocupado por mais de 5 s nesta batida: a próxima tenta de novo.
      logWarn('instancia_batida_falhou', { erro: err });
    }
  }, intervalo);
  timer.unref?.();
  return () => {
    parado = true;
    clearInterval(timer);
  };
}

function registrarAssuncao(tipo: TipoDeInstancia, d: Extract<Decisao, { assumiu: true }>): void {
  const meta = { tipo, motivo: d.motivo, anterior: d.anterior ?? undefined };
  if (d.motivo === 'pid_reaproveitado' || d.motivo === 'batida_vencida') {
    logWarn('INSTANCIA_ASSUMIU_DE_DONO_SILENCIOSO', meta);
  } else {
    logInfo('INSTANCIA_ASSUMIU', meta);
  }
}

/**
 * Assume o banco, esperando até `esperaMs` o dono atual sair. Lança
 * `BancoOcupado` se ele continuar lá.
 */
export async function assumirInstancia(tipo: TipoDeInstancia, opcoes: OpcoesDeAssumir = {}): Promise<Trava> {
  const espera = opcoes.esperaMs ?? 0;
  const pausa = opcoes.pausaMs ?? 500;
  const inicio = Date.now();
  let avisou = false;
  for (;;) {
    const d = tentarAssumir(tipo, opcoes.ambiente);
    if (d.assumiu) {
      registrarAssuncao(tipo, d);
      return montarTrava(d.token, opcoes);
    }
    const restante = espera - (Date.now() - inicio);
    if (restante <= 0) throw new BancoOcupado(d.dono, resolveDatabasePath());
    if (!avisou) {
      avisou = true;
      logWarn('INSTANCIA_ESPERANDO_O_DONO_SAIR', { dono: d.dono, esperaMs: espera });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pausa, restante)));
  }
}

/** A mesma coisa, sem espera e síncrona: para comando de linha de comando. */
export function assumirInstanciaAgora(tipo: TipoDeInstancia, opcoes: Omit<OpcoesDeAssumir, 'esperaMs' | 'pausaMs'> = {}): Trava {
  const d = tentarAssumir(tipo, opcoes.ambiente);
  if (!d.assumiu) throw new BancoOcupado(d.dono, resolveDatabasePath());
  registrarAssuncao(tipo, d);
  return montarTrava(d.token, { batidaMs: 0, ...opcoes });
}

function montarTrava(token: string, opcoes: OpcoesDeAssumir): Trava {
  const intervalo = opcoes.batidaMs ?? BATIDA_MS;
  const aoPerder =
    opcoes.aoPerder
    ?? ((dono: DonoDoBanco | null) => logError('INSTANCIA_PERDIDA', { dono: dono ?? undefined }));
  const pararDeBater = intervalo > 0 ? comecarABater(token, intervalo, aoPerder) : () => undefined;
  return {
    token,
    pararDeBater,
    liberar: () => {
      pararDeBater();
      liberarInstancia(token);
    },
  };
}

/** O que a tela Sistema mostra: o dono, e se é este processo que responde. */
export function instanciaNoAr(): (DonoDoBanco & { estaInstancia: boolean }) | null {
  const dono = donoDoBanco();
  if (!dono) return null;
  return { ...dono, estaInstancia: dono.pid === process.pid && dono.host === hostname() };
}
