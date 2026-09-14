/**
 * O LEGADO SAI DA ÁRVORE, E O QUE FICA NA MÁQUINA É APONTADO (GAP-PRD-154).
 *
 * A auditoria achou, versionados apesar do `.gitignore`: `server/backups/*.json`
 * (snapshots JSON do projeto anterior, coleções vazias, com manifesto e um
 * `verify/restore-verify.json`) — um segundo formato de backup na árvore, que
 * nenhum comando restaura e que confunde quem restaura. Na raiz, dumps de
 * saída do vitest (UTF-16, meio megabyte cada) e a extração de um spec de
 * uma conversa antiga, com caminho de transcrição de agente.
 *
 * Na máquina da loja, fora do git: `server/data/devora-api.json` (o banco
 * JSON do sistema anterior) e `.env.bak-*` com as mesmas chaves do `.env`.
 * Esses o repositório não apaga — estão na instalação do dono —, mas a
 * conferência da implantação passa a apontá-los pelo nome, com o que fazer.
 *
 * E o exemplo de `.env` do desenvolvimento apontava o banco para
 * `./server/data/devora-api.json`, que o servidor troca por `devora-api.db`:
 * quem copiasse o exemplo ganhava um banco DIFERENTE do padrão
 * (`grupo-sampaio.db`) sem perceber.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conferirImplantacao } from '../src/services/implantacao/conferenciaDaImplantacao.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');

function arquivosVersionados(): string[] | null {
  try {
    return execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null; // fora de um checkout (imagem, pacote): nada a conferir aqui
  }
}

describe('o repositório não versiona dado nem sobra de execução', () => {
  const versionados = arquivosVersionados();

  const PROIBIDOS: Array<[RegExp, string]> = [
    [/^server\/backups\//, 'backup legado em JSON'],
    [/(^|\/)\.env\.(bak|backup)(-|$)/, 'cópia de .env'],
    [/\.db(-wal|-shm)?$/, 'banco SQLite'],
    [/^server\/data\/[^/]+\.json$/, 'banco JSON do sistema anterior'],
    [/^vitest-[^/]*\.txt$/, 'saída de execução do vitest'],
    [/^cp37-spec-full\.txt$/, 'extração de spec de conversa antiga'],
    [/^_extract_cp37\.ps1$/, 'script de extração de transcrição'],
  ];

  it.skipIf(versionados === null)('nenhum arquivo versionado casa com o que é dado', () => {
    const achados = (versionados ?? []).flatMap((arquivo) =>
      PROIBIDOS.filter(([re]) => re.test(arquivo)).map(([, porque]) => `${arquivo} (${porque})`),
    );
    expect(achados).toEqual([]);
  });

  it('o .gitignore segura a volta das saídas do vitest', () => {
    const regras = readFileSync(join(RAIZ, '.gitignore'), 'utf8');
    expect(regras).toMatch(/^vitest-\*\.txt\r?$/m);
  });
});

describe('o banco padrão tem um nome só', () => {
  const caminhoNoExemplo = (arquivo: string): string => {
    const m = /^DEVORA_DATABASE_PATH=(.*)$/m.exec(readFileSync(join(RAIZ, arquivo), 'utf8'));
    return (m?.[1] ?? '').trim();
  };

  it('os exemplos de .env não apontam para o nome .json do sistema anterior', () => {
    expect(caminhoNoExemplo('.env.example')).toBe('./server/data/grupo-sampaio.db');
    // A homologação usa o mesmo nome que o compose de staging monta.
    expect(caminhoNoExemplo('.env.staging.example')).toBe('./server/data/staging-grupo-sampaio.db');
  });

  it('o padrão do esquema de ambiente é o mesmo de sqlite.ts', () => {
    const env = readFileSync(join(RAIZ, 'server', 'src', 'config', 'env.ts'), 'utf8');
    const sqlite = readFileSync(join(RAIZ, 'server', 'src', 'db', 'sqlite.ts'), 'utf8');
    const padraoDoEnv = /DEVORA_DATABASE_PATH: z\.string\(\)\.default\('([^']+)'\)/.exec(env)?.[1];
    const padraoDoSqlite = /DEFAULT_DATABASE_PATH = '([^']+)'/.exec(sqlite)?.[1];
    expect(padraoDoSqlite).toBe('./server/data/grupo-sampaio.db');
    expect(padraoDoEnv).toBe(padraoDoSqlite);
  });
});

describe('a conferência da implantação aponta o legado que ficou na máquina', () => {
  function contexto(pastas: Record<string, string[]>) {
    return {
      env: { DEVORA_API_ENV: 'development' },
      raiz: 'C:/grupo-sampaio',
      existe: () => true,
      emContainer: false,
      processo: null,
      listar: (pasta: string) => pastas[pasta.split('\\').join('/')] ?? [],
    };
  }

  const item = (r: ReturnType<typeof conferirImplantacao>) => r.itens.find((i) => i.id === 'artefatos_legados');

  it('cópia de .env, banco JSON antigo e backup JSON antigo: ATENÇÃO, pelo nome', () => {
    const r = conferirImplantacao(
      contexto({
        'C:/grupo-sampaio': ['.env', '.env.bak-2026-08-27T13-42-14-753Z', 'package.json'],
        'C:/grupo-sampaio/server': ['.env.backup', 'package.json'],
        'C:/grupo-sampaio/server/data': ['grupo-sampaio.db', 'devora-api.json'],
        'C:/grupo-sampaio/server/backups': ['devora-backup-2026-08-07T23-05-51-165Z.json', 'manifest-x.json', 'verify'],
      }),
    );
    const i = item(r);
    expect(i?.estado).toBe('ATENCAO');
    expect(i?.detalhe).toContain('.env.bak-2026-08-27T13-42-14-753Z');
    expect(i?.detalhe).toContain('server/.env.backup');
    expect(i?.detalhe).toContain('server/data/devora-api.json');
    expect(i?.detalhe).toContain('server/backups');
    expect(i?.comoResolver).toMatch(/cofre/);
    // ATENÇÃO, não BLOQUEIA: nada disso impede subir.
    expect(r.itens.filter((x) => x.estado === 'BLOQUEIA').map((x) => x.id)).not.toContain('artefatos_legados');
  });

  it('sem sobra, OK', () => {
    const r = conferirImplantacao(
      contexto({
        'C:/grupo-sampaio': ['.env', 'package.json'],
        'C:/grupo-sampaio/server/data': ['grupo-sampaio.db', '.gitkeep'],
      }),
    );
    expect(item(r)?.estado).toBe('OK');
  });

  it('o .env.example e o .env de verdade não contam como cópia', () => {
    const r = conferirImplantacao(
      contexto({ 'C:/grupo-sampaio': ['.env', '.env.example', '.env.production.example', '.env.local'] }),
    );
    expect(item(r)?.estado).toBe('OK');
  });
});
