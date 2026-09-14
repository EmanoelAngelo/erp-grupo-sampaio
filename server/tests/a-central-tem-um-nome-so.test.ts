/**
 * ============================================================================
 * DUAS PARTES DO MESMO SISTEMA CHAMANDO A MESMA CONTA POR NOMES DIFERENTES
 * ============================================================================
 *
 * A cópia remota do backup lê `DEVORA_SUPABASE_URL` e
 * `DEVORA_SUPABASE_SERVICE_KEY`. A sincronia com a central lia `SUPABASE_URL` e
 * `SUPABASE_SERVICE_ROLE_KEY`. Mesma conta Supabase, dois nomes.
 *
 * O `.env` desta instalação tem os nomes `DEVORA_*` preenchidos. O backup
 * funcionava; a sincronia nunca ligou. Resultado medido em 27/08/2026: **118
 * eventos parados na fila desde 15/08** — doze dias de venda, estoque e fiscal
 * que a central nunca recebeu.
 *
 * ## Por que ninguém percebeu
 *
 * Porque o sistema fazia a coisa certa com a informação errada. Sem credencial,
 * a fila ACUMULA em vez de inventar envio — é o comportamento correto, e está
 * escrito assim no serviço. O boot registrava `CENTRAL_SYNC_WORKER_IDLE` com o
 * motivo "sem credencial da central", toda vez.
 *
 * A mensagem estava certa e era inútil: o dono tinha preenchido a credencial.
 * Ele não tinha como saber que o servidor procurava por outro nome, e o log
 * não dizia QUAL nome faltava. Um defeito silencioso não é o que não avisa —
 * é o que avisa uma coisa que ninguém consegue ligar à causa.
 *
 * ## O que este arquivo trava
 *
 *  - a sincronia lê os nomes oficiais do projeto, os mesmos do backup;
 *  - os nomes legados sozinhos NÃO configuram nada — e são DENUNCIADOS, que é
 *    a diferença entre um erro que se acha e um que some;
 *  - `syncStatus` nomeia as variáveis que faltam pelo nome oficial;
 *  - backup e sincronia leem exatamente o mesmo par, por leitura do código.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '../src');

const { supabaseConfig, syncStatus } = await import('../src/services/sync/SyncService.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');

/** Valores inventados. Não são credencial de ninguém. */
const URL_INVENTADA = 'https://central-inventada.supabase.co';
const CHAVE_INVENTADA = 'chave-de-servico-inventada-para-o-teste';

const VARIAVEIS = [
  'DEVORA_SUPABASE_URL',
  'DEVORA_SUPABASE_SERVICE_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARIAVEIS) {
    ORIGINAL[v] = process.env[v];
    delete process.env[v];
  }
  resetEnvCacheForTests();
});

afterEach(() => {
  for (const v of VARIAVEIS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v];
  }
  resetEnvCacheForTests();
});

// ============================================================================

describe('a sincronia lê o nome oficial do projeto', () => {
  it('com DEVORA_SUPABASE_URL e DEVORA_SUPABASE_SERVICE_KEY, está configurada', () => {
    process.env.DEVORA_SUPABASE_URL = URL_INVENTADA;
    process.env.DEVORA_SUPABASE_SERVICE_KEY = CHAVE_INVENTADA;
    resetEnvCacheForTests();

    const config = supabaseConfig();
    expect(config, 'o par oficial do projeto precisa configurar a central').not.toBeNull();
    expect(config?.url).toBe(URL_INVENTADA);
  });

  it('sem nenhuma das duas, não está — e a fila acumula, que é o certo', () => {
    expect(supabaseConfig()).toBeNull();
  });

  it('só a URL não basta: metade da credencial não é credencial', () => {
    process.env.DEVORA_SUPABASE_URL = URL_INVENTADA;
    resetEnvCacheForTests();
    expect(supabaseConfig()).toBeNull();
  });
});

// ============================================================================

describe('o nome legado não configura calado', () => {
  it('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sozinhos NÃO configuram', () => {
    /*
      Aceitar os dois nomes pareceria gentileza e seria o contrário: ficariam
      dois jeitos certos de configurar a mesma coisa, e a próxima pessoa a ler
      `.env` não saberia qual vale. Um nome só.
    */
    process.env.SUPABASE_URL = URL_INVENTADA;
    process.env.SUPABASE_SERVICE_ROLE_KEY = CHAVE_INVENTADA;
    resetEnvCacheForTests();

    expect(supabaseConfig()).toBeNull();
  });

  it('mas o estado DENUNCIA que elas estão lá — senão o erro some de novo', () => {
    /*
      Este é o caso que fecha o defeito de verdade. Quem preencheu o nome
      antigo fez tudo o que sabia fazer; o sistema tem de dizer que viu o
      esforço e que o nome mudou. "Falta credencial" para quem acabou de
      preencher a credencial é a mensagem que produziu doze dias de fila parada.
    */
    process.env.SUPABASE_URL = URL_INVENTADA;
    process.env.SUPABASE_SERVICE_ROLE_KEY = CHAVE_INVENTADA;
    resetEnvCacheForTests();

    const s = syncStatus();
    const texto = JSON.stringify(s);
    expect(texto, 'o nome ANTIGO precisa aparecer no diagnóstico').toContain('SUPABASE_URL');
    expect(texto, 'e o nome NOVO também, para a pessoa saber o que fazer').toContain(
      'DEVORA_SUPABASE_URL',
    );
  });

  it('e o diagnóstico não vaza o valor da credencial', () => {
    process.env.SUPABASE_URL = URL_INVENTADA;
    process.env.SUPABASE_SERVICE_ROLE_KEY = CHAVE_INVENTADA;
    resetEnvCacheForTests();

    expect(JSON.stringify(syncStatus())).not.toContain(CHAVE_INVENTADA);
  });
});

// ============================================================================

describe('o que falta é dito pelo nome oficial', () => {
  it('sem credencial nenhuma, `missing` nomeia as duas variáveis DEVORA_*', () => {
    const s = syncStatus();
    expect(s.missing).toContain('DEVORA_SUPABASE_URL');
    expect(s.missing).toContain('DEVORA_SUPABASE_SERVICE_KEY');
  });

  it('com o par completo, `missing` fica vazio', () => {
    process.env.DEVORA_SUPABASE_URL = URL_INVENTADA;
    process.env.DEVORA_SUPABASE_SERVICE_KEY = CHAVE_INVENTADA;
    resetEnvCacheForTests();
    expect(syncStatus().missing).toEqual([]);
  });
});

// ============================================================================

describe('backup e sincronia leem o mesmo par, por leitura do código', () => {
  /*
    As duas partes podiam voltar a divergir na próxima vez que alguém
    acrescentasse um consumidor da mesma conta. Este caso lê o fonte e compara —
    a mesma forma dos outros guardas por leitura deste projeto.
  */
  function nomesLidosEm(arquivo: string): string[] {
    const texto = readFileSync(resolve(SRC, arquivo), 'utf8');
    const achados = new Set<string>();
    for (const m of texto.matchAll(/\b((?:DEVORA_)?SUPABASE_[A-Z_]+)\b/g)) achados.add(m[1]);
    return [...achados].sort();
  }

  it('a leitura enxerga os arquivos — senão ficaria verde lendo nada', () => {
    expect(nomesLidosEm('db/backupRemoto.ts').length).toBeGreaterThan(1);
    expect(nomesLidosEm('services/sync/SyncService.ts').length).toBeGreaterThan(0);
  });

  it('a sincronia não lê nenhum nome que o backup desconheça', () => {
    const doBackup = new Set(nomesLidosEm('db/backupRemoto.ts'));
    // O bucket é só do backup: a central não guarda arquivo.
    doBackup.add('DEVORA_SUPABASE_BUCKET');

    const daSincronia = nomesLidosEm('services/sync/SyncService.ts').filter(
      // O nome legado é citado no diagnóstico DE PROPÓSITO, para denunciá-lo.
      (n) => n !== 'SUPABASE_URL' && n !== 'SUPABASE_SERVICE_ROLE_KEY',
    );

    const estranhos = daSincronia.filter((n) => !doBackup.has(n));
    expect(
      estranhos,
      'a sincronia lê uma variável que o backup não conhece: ou é nome novo para '
        + 'a mesma conta, ou o projeto voltou a ter duas nomenclaturas',
    ).toEqual([]);
  });

  it('e o boot não lê nome nenhum por conta própria', () => {
    // A decisão de ter credencial mora no serviço. O boot pergunta a ele.
    const boot = readFileSync(resolve(SRC, 'index.ts'), 'utf8');
    const codigo = boot
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    expect(codigo).not.toMatch(/process\.env\.(DEVORA_)?SUPABASE_/);
  });
});
