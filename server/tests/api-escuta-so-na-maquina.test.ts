/**
 * A API ESCUTA SÓ NA PRÓPRIA MÁQUINA, A MENOS QUE ALGUÉM DIGA OUTRA COISA.
 *
 * Na VPS a API apareceu ouvindo em `*:8787`: a porta publicada direto na
 * internet, por fora do Caddy e do HTTPS. O `server.listen` recebia só a porta,
 * e o Node, sem endereço, escuta em todas as interfaces.
 *
 * Agora o endereço é `DEVORA_API_HOST`, com padrão `127.0.0.1`. Estes casos
 * provam:
 *
 *   - no `loadEnv`: o padrão é 127.0.0.1, o valor configurado é respeitado,
 *     vazio vale o padrão, e o que não é endereço (URL, barra) é recusado;
 *   - com a API DE VERDADE (`node --import tsx src/index.ts`, o boot que o
 *     operador roda, num banco descartável): no padrão ela responde em
 *     127.0.0.1 e RECUSA a conexão pelo IP de rede da máquina; com
 *     `DEVORA_API_HOST=0.0.0.0`, responde pelos dois — e a porta continua a
 *     mesma. O log API_SERVER_STARTED diz host e porta.
 *
 * Como fica vermelho: tire o `env.DEVORA_API_HOST` do `server.listen` e a API
 * volta a aceitar a conexão pelo IP de rede no caso padrão.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, resetEnvCacheForTests } from '../src/config/env.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '..');
const PORTA = 20020;

// -------------------------------------------------------------- o loadEnv

describe('DEVORA_API_HOST no loadEnv', () => {
  const antes = process.env.DEVORA_API_HOST;
  afterEach(() => {
    if (antes === undefined) delete process.env.DEVORA_API_HOST;
    else process.env.DEVORA_API_HOST = antes;
    resetEnvCacheForTests();
  });

  function hostCom(valor: string | undefined): string {
    if (valor === undefined) delete process.env.DEVORA_API_HOST;
    else process.env.DEVORA_API_HOST = valor;
    resetEnvCacheForTests();
    return loadEnv().DEVORA_API_HOST;
  }

  it('o padrão é 127.0.0.1 — sem variável e com a variável vazia', () => {
    expect(hostCom(undefined)).toBe('127.0.0.1');
    expect(hostCom('')).toBe('127.0.0.1');
    expect(hostCom('   ')).toBe('127.0.0.1');
  });

  it('o valor configurado é respeitado (e aparado)', () => {
    expect(hostCom('0.0.0.0')).toBe('0.0.0.0');
    expect(hostCom(' ::1 ')).toBe('::1');
    expect(hostCom('localhost')).toBe('localhost');
  });

  it('o que não é endereço é recusado com o nome da variável', () => {
    expect(() => hostCom('http://203.0.113.10')).toThrow(/DEVORA_API_HOST/);
    expect(() => hostCom('127.0.0.1/api')).toThrow(/DEVORA_API_HOST/);
  });
});

// -------------------------------------------------------- a API de verdade

const pastas: string[] = [];
const processos: ChildProcess[] = [];

afterAll(() => {
  for (const p of processos) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  for (const d of pastas) rmSync(d, { recursive: true, force: true });
});

/** Um IPv4 de rede desta máquina (não o loopback), se houver. */
function ipDeRede(): string | null {
  for (const lista of Object.values(networkInterfaces())) {
    for (const i of lista ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

function conecta(host: string, porta: number): Promise<boolean> {
  return new Promise((resolver) => {
    const s = connect({ host, port: porta });
    const fim = (ok: boolean) => {
      s.destroy();
      resolver(ok);
    };
    s.setTimeout(3000, () => fim(false));
    s.once('connect', () => fim(true));
    s.once('error', () => fim(false));
  });
}

async function subirApi(host: string | undefined): Promise<{ proc: ChildProcess; inicio: Record<string, unknown> }> {
  const pasta = mkdtempSync(join(process.env.GS_ERP_TEST_TMP_ROOT ?? tmpdir(), 'gs api host '));
  pastas.push(pasta);
  const banco = join(pasta, 'dados', 'loja.db');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    DEVORA_IGNORE_DOTENV: 'true',
    DEVORA_DATABASE_PATH: banco,
    TEST_DATABASE_PATH: banco,
    DEVORA_BACKUP_DIR: join(pasta, 'backups'),
    DEVORA_UPLOADS_DIR: join(pasta, 'uploads'),
    DEVORA_API_PORT: String(PORTA),
    DEVORA_API_ENV: 'development',
    LOG_LEVEL: 'info',
  };
  if (host !== undefined) env.DEVORA_API_HOST = host;
  let texto = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVIDOR,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  processos.push(proc);
  proc.stdout?.on('data', (d: Buffer) => { texto += d.toString('utf8'); });
  proc.stderr?.on('data', (d: Buffer) => { texto += d.toString('utf8'); });

  const limite = Date.now() + 120_000;
  for (;;) {
    const linha = texto.split(/\r?\n/).find((l) => l.includes('"API_SERVER_STARTED"'));
    if (linha) return { proc, inicio: JSON.parse(linha.slice(linha.indexOf('{'))) as Record<string, unknown> };
    if (proc.exitCode !== null) throw new Error(`a API saiu antes de subir:\n${texto}`);
    if (Date.now() > limite) throw new Error(`a API não subiu no prazo:\n${texto}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function derrubar(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const saiu = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGKILL');
  await saiu;
}

describe('a API de verdade escuta no endereço declarado', () => {
  it(
    'no padrão: 127.0.0.1, a porta de sempre, e o IP de rede da máquina é recusado',
    async () => {
      const { proc, inicio } = await subirApi(undefined);
      try {
        expect(inicio).toMatchObject({ message: 'API_SERVER_STARTED', host: '127.0.0.1', port: PORTA });
        const r = await fetch(`http://127.0.0.1:${PORTA}/api/v1/health`);
        expect(r.status).toBe(200);
        const ip = ipDeRede();
        if (ip) expect(await conecta(ip, PORTA)).toBe(false);
      } finally {
        await derrubar(proc);
      }
    },
    180_000,
  );

  it(
    'com DEVORA_API_HOST=0.0.0.0: o valor é respeitado e a API responde também pelo IP de rede',
    async () => {
      const { proc, inicio } = await subirApi('0.0.0.0');
      try {
        expect(inicio).toMatchObject({ message: 'API_SERVER_STARTED', host: '0.0.0.0', port: PORTA });
        expect((await fetch(`http://127.0.0.1:${PORTA}/api/v1/health`)).status).toBe(200);
        const ip = ipDeRede();
        if (ip) expect(await conecta(ip, PORTA)).toBe(true);
      } finally {
        await derrubar(proc);
      }
    },
    180_000,
  );
});
