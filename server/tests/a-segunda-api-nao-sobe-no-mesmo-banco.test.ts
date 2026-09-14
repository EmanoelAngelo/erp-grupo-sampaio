/**
 * A SEGUNDA API NÃO SOBE NO MESMO BANCO — com processos de verdade
 * (GAP-PRD-137).
 *
 * O que a auditoria mediu: dois processos no mesmo `.db` "quase" funcionam. A
 * escrita serializa, mas a espera de mais de 5 s vira "database is locked"; os
 * trabalhadores de fundo dobram; e as migrações não têm trava entre processos.
 * Nada impedia a segunda API de subir numa outra porta, apontando para o
 * mesmo arquivo.
 *
 * Aqui sobem APIs de verdade — `node --import tsx src/index.ts`, o boot que o
 * operador roda, um processo só (o pid dele é o pid da API) — contra um banco
 * numa pasta temporária COM ESPAÇO no nome:
 *
 *   1. a primeira sobe e fica registrada como dona;
 *   2. a segunda, noutra porta, é recusada ANTES de abrir a porta, com a frase
 *      que diz quem é o dono;
 *   3. o `db:migrate` com a API no ar é recusado e não migra;
 *   4. a API que desce limpa (o pedido do supervisor pelo IPC) solta o banco,
 *      e a migração a frio passa;
 *   5. a API que MORRE sem soltar não trava a próxima: o pid registrado não
 *      existe mais, e quem vem depois assume na hora.
 *
 * Portas: 20000 e 20001, do bloco da frente DEP (plano.json). Nenhum processo
 * sai para a rede: sem credencial, os trabalhadores de fundo só anotam.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '..');
const PORTA_A = 20000;
const PORTA_B = 20001;

const raiz = process.env.GS_ERP_TEST_TMP_ROOT ?? tmpdir();
const pasta = mkdtempSync(join(raiz, 'gs instancia unica '));
const banco = join(pasta, 'dados', 'loja.db');

interface Api {
  proc: ChildProcess;
  saida: () => string;
}

const processos: ChildProcess[] = [];

afterAll(() => {
  for (const p of processos) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  rmSync(pasta, { recursive: true, force: true });
});

function ambiente(porta: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    DEVORA_IGNORE_DOTENV: 'true',
    DEVORA_DATABASE_PATH: banco,
    // Descartável declarado: o snapshot pré-migração pula.
    TEST_DATABASE_PATH: banco,
    DEVORA_BACKUP_DIR: join(pasta, 'backups'),
    DEVORA_UPLOADS_DIR: join(pasta, 'uploads'),
    DEVORA_API_PORT: String(porta),
    DEVORA_API_ENV: 'development',
    LOG_LEVEL: 'info',
  };
}

function subirApi(porta: number): Api {
  let texto = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVIDOR,
    env: ambiente(porta),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  processos.push(proc);
  proc.stdout?.on('data', (d: Buffer) => { texto += d.toString('utf8'); });
  proc.stderr?.on('data', (d: Buffer) => { texto += d.toString('utf8'); });
  return { proc, saida: () => texto };
}

async function esperarAte(condicao: () => boolean, ms: number): Promise<void> {
  const fim = Date.now() + ms;
  while (!condicao()) {
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function esperarSaida(proc: ChildProcess, ms: number): Promise<number | null> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolveSaida, rejeitar) => {
    const relogio = setTimeout(() => rejeitar(new Error('o processo não saiu no prazo')), ms);
    proc.once('exit', (codigo) => {
      clearTimeout(relogio);
      resolveSaida(codigo);
    });
  });
}

async function subiu(api: Api): Promise<void> {
  await esperarAte(
    () => api.saida().includes('API_SERVER_STARTED') || api.proc.exitCode !== null,
    120_000,
  );
  expect(api.saida(), api.saida()).toContain('API_SERVER_STARTED');
}

function rodarMigrate(): { codigo: number | null; saida: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], {
    cwd: SERVIDOR,
    env: ambiente(PORTA_A),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return { codigo: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** O dono registrado, lido só para leitura — como faria quem confere de fora. */
function lerDono(): { tipo: string; pid: number } | null {
  const db = new DatabaseSync(banco, { readOnly: true });
  try {
    const existe = db.prepare("SELECT name FROM sqlite_master WHERE name = 'core_instancia'").get();
    if (!existe) return null;
    const l = db.prepare("SELECT tipo, pid FROM core_instancia WHERE papel = 'dono'").get() as
      | { tipo: string; pid: number }
      | undefined;
    return l ? { tipo: l.tipo, pid: Number(l.pid) } : null;
  } finally {
    db.close();
  }
}

describe('uma API por arquivo de banco, com processos de verdade', () => {
  let a: Api;

  it('1. a primeira API sobe e fica registrada como dona do banco', async () => {
    a = subirApi(PORTA_A);
    await subiu(a);
    expect(lerDono()).toEqual({ tipo: 'api', pid: a.proc.pid });
  }, 150_000);

  it('2. a segunda, noutra porta e no mesmo banco, é recusada antes de abrir a porta', async () => {
    const b = subirApi(PORTA_B);
    const codigo = await esperarSaida(b.proc, 120_000);
    expect(codigo, b.saida()).toBe(1);
    expect(b.saida()).toContain('Outra instância já usa este banco');
    expect(b.saida()).toContain(`pid ${a.proc.pid}`);
    expect(b.saida()).not.toContain('API_SERVER_STARTED');
    // A primeira continua dona, e continua no ar.
    expect(lerDono()).toEqual({ tipo: 'api', pid: a.proc.pid });
    expect(a.proc.exitCode).toBeNull();
  }, 150_000);

  it('3. o db:migrate com a API no ar é recusado e não migra', () => {
    const r = rodarMigrate();
    expect(r.codigo, r.saida).toBe(1);
    expect(r.saida).toContain('Outra instância já usa este banco');
    expect(r.saida).toContain('Nada foi migrado');
    expect(lerDono()).toEqual({ tipo: 'api', pid: a.proc.pid });
  }, 150_000);

  it('4. a API que desce limpa solta o banco, e a migração a frio passa', async () => {
    a.proc.send?.({ tipo: 'desligar' });
    const codigo = await esperarSaida(a.proc, 60_000);
    expect(codigo, a.saida()).toBe(0);
    expect(lerDono()).toBeNull();

    const r = rodarMigrate();
    expect(r.codigo, r.saida).toBe(0);
    expect(lerDono()).toBeNull();
  }, 150_000);

  it('5. a API que MORRE sem soltar não trava a próxima: o pid não existe mais', async () => {
    const c = subirApi(PORTA_A);
    await subiu(c);
    const pid = c.proc.pid;
    c.proc.kill('SIGKILL');
    await esperarSaida(c.proc, 60_000);
    // Morreu sem soltar: a linha continua lá, com o pid de um processo morto.
    expect(lerDono()).toEqual({ tipo: 'api', pid });

    const r = rodarMigrate();
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain('"motivo":"processo_morto"');
    expect(lerDono()).toBeNull();
  }, 180_000);
});
