/**
 * ============================================================================
 * A API TEM QUEM A LEVANTE — supervisor e registro em arquivo (GAP-PRD-013)
 * ============================================================================
 *
 * "Sem supervisor, uma queda da API derruba as seis empresas até alguém
 * digitar o comando." O repositório não trazia supervisor, unidade de serviço
 * nem exemplo — `DEPLOY.md` dizia "quem publica escolhe".
 *
 * `scripts/supervisionar-api` é o supervisor de referência, em Node puro (o
 * mesmo Node que roda a API; nada a baixar): sobe a API, a levanta de novo
 * quando ela cai (espera crescente, que volta ao início depois de um período
 * estável), pede o desligamento pelo canal IPC (no Windows não há SIGTERM de
 * verdade) e grava a saída num arquivo POR DIA, com carimbo de hora e
 * retenção — rodando como tarefa do Windows, não há terminal para ler.
 *
 * Os primeiros casos usam um filho de mentira (um script de dez linhas); o
 * último sobe a API DE VERDADE, na porta desta frente (20000), sobre um banco
 * descartável, derruba o processo à força e confere que ela voltou.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { criarRegistroDiario } = await import('../src/services/implantacao/registroEmArquivo.js');
const { iniciarSupervisor } = await import('../src/services/implantacao/supervisor.js');

const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pasta = '';
beforeAll(() => {
  pasta = mkdtempSync(join(tmpdir(), 'gs-supervisor-'));
});
afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

// ============================================================================

describe('o registro em arquivo', () => {
  let logs = '';
  afterEach(() => {
    if (logs) rmSync(logs, { recursive: true, force: true });
  });

  it('grava cada linha com o carimbo de hora, num arquivo do dia da loja', () => {
    logs = mkdtempSync(join(tmpdir(), 'gs-logs-'));
    // 02:30 UTC de 11/09 ainda é 10/09 em São Paulo: o arquivo é o do dia da loja.
    const registro = criarRegistroDiario({ pasta: logs, agora: () => new Date('2026-09-11T02:30:00.000Z') });
    registro.escrever('{"level":"info","message":"API_SERVER_STARTED"}\n');
    const texto = readFileSync(join(logs, 'api-2026-09-10.log'), 'utf8');
    expect(texto).toBe('2026-09-11T02:30:00.000Z {"level":"info","message":"API_SERVER_STARTED"}\n');
  });

  it('linha que chega em pedaços é gravada inteira, uma vez', () => {
    logs = mkdtempSync(join(tmpdir(), 'gs-logs-'));
    const registro = criarRegistroDiario({ pasta: logs, agora: () => new Date('2026-09-11T15:00:00.000Z') });
    registro.escrever('{"level":"error",');
    registro.escrever('"message":"x"}\n{"level":"info"');
    registro.escrever(',"message":"y"}\n');
    const linhas = readFileSync(registro.arquivoDoDia(), 'utf8').trim().split('\n');
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatch(/\{"level":"error","message":"x"\}$/);
    expect(linhas[1]).toMatch(/\{"level":"info","message":"y"\}$/);
  });

  it('o resto sem quebra de linha sai no descarregar', () => {
    logs = mkdtempSync(join(tmpdir(), 'gs-logs-'));
    const registro = criarRegistroDiario({ pasta: logs, agora: () => new Date('2026-09-11T15:00:00.000Z') });
    registro.escrever('ultima linha sem enter');
    expect(existsSync(registro.arquivoDoDia())).toBe(false);
    registro.descarregar();
    expect(readFileSync(registro.arquivoDoDia(), 'utf8')).toContain('ultima linha sem enter');
  });

  it('a virada do dia abre arquivo novo e poda os que passaram da retenção — só os dele', () => {
    logs = mkdtempSync(join(tmpdir(), 'gs-logs-'));
    for (const dia of ['2026-08-01', '2026-09-01', '2026-09-02', '2026-09-10']) {
      writeFileSync(join(logs, `api-${dia}.log`), 'x\n');
    }
    writeFileSync(join(logs, 'anotacoes-do-dono.txt'), 'não é meu');
    let agora = new Date('2026-09-10T15:00:00.000Z');
    const registro = criarRegistroDiario({ pasta: logs, retencaoDias: 9, agora: () => agora });
    registro.escrever('a\n');
    agora = new Date('2026-09-11T15:00:00.000Z');
    registro.escrever('b\n');

    const restantes = readdirSync(logs).sort();
    // Retenção de 9 dias em 11/09: sobram de 03/09 em diante.
    expect(restantes).toEqual(['anotacoes-do-dono.txt', 'api-2026-09-10.log', 'api-2026-09-11.log']);
    expect(readFileSync(join(logs, 'api-2026-09-11.log'), 'utf8')).toMatch(/ b\n$/);
  });

  it('pasta que não dá para criar não derruba quem escreve', () => {
    const arquivo = join(pasta, 'um-arquivo-no-lugar-da-pasta');
    writeFileSync(arquivo, 'x');
    const registro = criarRegistroDiario({ pasta: join(arquivo, 'logs') });
    expect(() => registro.escrever('linha\n')).not.toThrow();
  });
});

// ============================================================================

/** Um filho de mentira: o que ele faz vem do ambiente. */
function filhoFalso(): string {
  const caminho = join(pasta, 'filho.mjs');
  writeFileSync(
    caminho,
    `
const modo = process.env.MODO;
console.log(JSON.stringify({ message: 'FILHO_SUBIU', supervisionado: process.env.DEVORA_SUPERVISIONADO ?? null }));
if (modo === 'cai') setTimeout(() => process.exit(3), 30);
if (modo === 'vive' || modo === 'teimoso' || modo === 'vive-um-pouco') {
  const t = setInterval(() => {}, 1000);
  if (modo === 'vive-um-pouco') setTimeout(() => process.exit(4), 250);
  process.on('message', (m) => {
    if (modo === 'teimoso') return;
    if (m && m.tipo === 'desligar') {
      console.log(JSON.stringify({ message: 'FILHO_DESLIGOU_LIMPO' }));
      clearInterval(t);
      process.exit(0);
    }
  });
}
`,
  );
  return caminho;
}

function coletor() {
  const linhas: string[] = [];
  let resto = '';
  return {
    linhas,
    saida: (texto: string) => {
      resto += texto;
      const partes = resto.split(/\r?\n/);
      resto = partes.pop() ?? '';
      linhas.push(...partes.filter(Boolean));
    },
    com: (mensagem: string) => linhas.filter((l) => l.includes(`"${mensagem}"`)),
  };
}

async function ate(condicao: () => boolean, limiteMs: number): Promise<void> {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > limiteMs) throw new Error('condição não aconteceu a tempo');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('o supervisor', () => {
  it('a API que cai é levantada de novo, com espera crescente', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: filhoFalso(),
      cwd: pasta,
      env: { ...process.env, MODO: 'cai' },
      saida: c.saida,
      esperaInicialMs: 40,
      esperaMaximaMs: 1_000,
    });
    await ate(() => c.com('SUPERVISOR_REINICIA').length >= 3, 10_000);
    await sup.parar();

    const esperas = c.com('SUPERVISOR_REINICIA').slice(0, 3).map((l) => JSON.parse(l).esperaMs);
    expect(esperas).toEqual([40, 80, 160]);
    const saiu = JSON.parse(c.com('SUPERVISOR_API_SAIU')[0]);
    expect(saiu.codigo).toBe(3);
    expect(c.com('FILHO_SUBIU').length).toBeGreaterThanOrEqual(3);
  });

  it('a espera tem teto — o supervisor nunca desiste das seis empresas', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: filhoFalso(),
      cwd: pasta,
      env: { ...process.env, MODO: 'cai' },
      saida: c.saida,
      esperaInicialMs: 20,
      esperaMaximaMs: 60,
    });
    await ate(() => c.com('SUPERVISOR_REINICIA').length >= 4, 10_000);
    await sup.parar();
    const esperas = c.com('SUPERVISOR_REINICIA').slice(0, 4).map((l) => JSON.parse(l).esperaMs);
    expect(esperas).toEqual([20, 40, 60, 60]);
  });

  it('depois de um período estável, a espera volta ao começo', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: filhoFalso(),
      cwd: pasta,
      env: { ...process.env, MODO: 'vive-um-pouco' },
      saida: c.saida,
      esperaInicialMs: 30,
      esperaMaximaMs: 1_000,
      estavelAposMs: 100,
    });
    await ate(() => c.com('SUPERVISOR_REINICIA').length >= 3, 10_000);
    await sup.parar();
    const esperas = c.com('SUPERVISOR_REINICIA').slice(0, 3).map((l) => JSON.parse(l).esperaMs);
    expect(esperas).toEqual([30, 30, 30]);
  });

  it('o filho sabe que está sob supervisor, e a saída dele passa pelo registro', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: filhoFalso(),
      cwd: pasta,
      env: { ...process.env, MODO: 'vive' },
      saida: c.saida,
    });
    await ate(() => c.com('FILHO_SUBIU').length >= 1, 10_000);
    await sup.parar();
    expect(JSON.parse(c.com('FILHO_SUBIU')[0]).supervisionado).toBe('1');
  });

  it('parar pede o desligamento pelo IPC, o filho desce limpo, e ninguém o levanta', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: filhoFalso(),
      cwd: pasta,
      env: { ...process.env, MODO: 'vive' },
      saida: c.saida,
      esperaInicialMs: 20,
    });
    await ate(() => c.com('FILHO_SUBIU').length >= 1, 10_000);
    await sup.parar();
    await new Promise((r) => setTimeout(r, 150));

    expect(c.com('FILHO_DESLIGOU_LIMPO')).toHaveLength(1);
    expect(JSON.parse(c.com('SUPERVISOR_API_SAIU')[0]).codigo).toBe(0);
    expect(c.com('SUPERVISOR_REINICIA')).toHaveLength(0);
    expect(c.com('FILHO_SUBIU')).toHaveLength(1);
  });

  it('filho que ignora o pedido é derrubado no prazo', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: filhoFalso(),
      cwd: pasta,
      env: { ...process.env, MODO: 'teimoso' },
      saida: c.saida,
      prazoDeParadaMs: 300,
    });
    await ate(() => c.com('FILHO_SUBIU').length >= 1, 10_000);
    const inicio = Date.now();
    await sup.parar();
    expect(Date.now() - inicio).toBeLessThan(5_000);
    expect(c.com('SUPERVISOR_FORCOU_PARADA')).toHaveLength(1);
  });

  it('entrada que não existe não vira laço apertado: cai, espera, tenta de novo', async () => {
    const c = coletor();
    const sup = iniciarSupervisor({
      entrada: join(pasta, 'nao-existe.js'),
      cwd: pasta,
      env: { ...process.env },
      saida: c.saida,
      esperaInicialMs: 30,
    });
    await ate(() => c.com('SUPERVISOR_REINICIA').length >= 2, 10_000);
    await sup.parar();
    expect(c.com('SUPERVISOR_REINICIA').map((l) => JSON.parse(l).esperaMs).slice(0, 2)).toEqual([30, 60]);
  });
});

// ============================================================================

describe('de ponta a ponta, com a API de verdade', () => {
  const PORTA = 20000;
  const base = `http://127.0.0.1:${PORTA}/api/v1`;

  async function responde(caminho: string): Promise<number> {
    try {
      const r = await fetch(`${base}${caminho}`);
      return r.status;
    } catch {
      return 0;
    }
  }

  it(
    'sobe a API, levanta de novo depois de uma queda à força, e desce limpo — fechando o banco',
    async () => {
      const dados = mkdtempSync(join(tmpdir(), 'gs-supervisor-api-'));
      const banco = join(dados, 'grupo-sampaio.db');
      const c = coletor();
      const sup = iniciarSupervisor({
        entrada: join(SERVIDOR, 'src', 'index.ts'),
        argumentosDoNode: ['--import', 'tsx'],
        cwd: SERVIDOR,
        env: {
          ...process.env,
          DEVORA_IGNORE_DOTENV: 'true',
          DEVORA_API_ENV: 'test',
          DEVORA_API_PORT: String(PORTA),
          DEVORA_DATABASE_PATH: banco,
          TEST_DATABASE_PATH: banco,
          DEVORA_UPLOADS_DIR: join(dados, 'uploads'),
          DEVORA_BACKUP_DIR: join(dados, 'backups'),
          DEVORA_SUPABASE_URL: '',
          DEVORA_SUPABASE_SERVICE_KEY: '',
          EMAIL_ENABLED: 'false',
        },
        saida: c.saida,
        esperaInicialMs: 200,
      });
      try {
        await ate(() => c.com('API_SERVER_STARTED').length >= 1, 90_000);
        expect(await responde('/readiness')).toBe(200);

        // Queda à força: nada de desligamento gracioso, o processo some.
        const pid = sup.pidAtual();
        expect(pid).toBeGreaterThan(0);
        process.kill(pid!, 'SIGKILL');

        await ate(() => c.com('API_SERVER_STARTED').length >= 2, 90_000);
        expect(c.com('SUPERVISOR_REINICIA').length).toBeGreaterThanOrEqual(1);
        expect(await responde('/health')).toBe(200);
      } finally {
        await sup.parar();
      }

      expect(c.com('API_DESLIGANDO').length).toBeGreaterThanOrEqual(1);
      expect(c.com('API_DESLIGADA').length).toBeGreaterThanOrEqual(1);
      expect(await responde('/health')).toBe(0);
      // Banco fechado: o -wal foi recolhido e o arquivo pode ser apagado (no
      // Windows, arquivo com handle aberto não sai).
      expect(existsSync(`${banco}-wal`)).toBe(false);
      rmSync(dados, { recursive: true, force: true });
      expect(existsSync(banco)).toBe(false);
    },
    240_000,
  );
});
