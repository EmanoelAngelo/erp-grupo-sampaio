/**
 * ============================================================================
 * BACKUP SEM VOLTA NÃO É BACKUP
 * ============================================================================
 *
 * O módulo remoto só sabia ENVIAR. Um envio que devolve HTTP 200 prova que o
 * bucket aceitou a requisição — não prova que o objeto está lá, com o tamanho
 * certo, no dia seguinte, nem que ele volta.
 *
 * "O job existe e o log diz ok" é exatamente o tipo de garantia que ninguém
 * conferiu. E backup sem teste de restauração é a promessa mais cara que um
 * sistema pode fazer: ela só é cobrada no dia em que já não há o que fazer.
 *
 * Duas metades entraram: `listarBackupsRemotos` (o objeto está lá?) e
 * `baixarBackupRemoto` (ele volta?). Este arquivo cobra as duas contra um
 * `fetch` de mentira — o bucket de verdade foi conferido à mão, e o resultado
 * está no relatório da rodada.
 *
 * ## O que se cobra aqui
 *
 *   - sem credencial, as duas recusam com motivo e NÃO estouram;
 *   - a chave NUNCA aparece no retorno, no motivo, nem em exceção;
 *   - HTTP de recusa vira motivo legível, com o status;
 *   - o download escreve no destino pedido, e só nele;
 *   - a listagem entende o formato do Supabase e devolve nome, bytes e data.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { listarBackupsRemotos, baixarBackupRemoto, enviarBackupRemoto } = await import(
  '../src/db/backupRemoto.js'
);

const CONFIG = {
  url: 'https://projeto-de-mentira.supabase.co',
  serviceKey: 'sb_secret_ISTO_NAO_PODE_VAZAR_EM_LUGAR_NENHUM',
  bucket: 'backups',
};

const SEM_CONFIG = { url: '', serviceKey: '', bucket: '' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gs-remoto-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // pasta temporária
  }
});

/** Um `fetch` que responde o que o caso pedir, e guarda o que recebeu. */
function servidor(resposta: Response | (() => Response)) {
  const chamadas: { url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    return typeof resposta === 'function' ? resposta() : resposta;
  }) as unknown as typeof fetch;
  return { impl, chamadas };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================

describe('sem credencial, nada estoura e ninguém finge que funcionou', () => {
  it('a listagem recusa com motivo', async () => {
    const r = await listarBackupsRemotos({ config: SEM_CONFIG });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/não configurada/i);
  });

  it('o download recusa com motivo, e não cria arquivo', async () => {
    const destino = join(dir, 'nao-deve-existir.db');
    const r = await baixarBackupRemoto('qualquer.db', destino, { config: SEM_CONFIG });
    expect(r.ok).toBe(false);
    expect(existsSync(destino)).toBe(false);
  });

  it('o envio recusa com motivo', async () => {
    const arquivo = join(dir, 'x.db');
    writeFileSync(arquivo, 'conteúdo');
    const r = await enviarBackupRemoto(arquivo, { config: SEM_CONFIG });
    expect(r.ok).toBe(false);
  });
});

// ============================================================================

describe('a chave nunca sai do cabeçalho', () => {
  it('não aparece no motivo de uma recusa do bucket', async () => {
    const { impl } = servidor(json({ error: 'nope' }, 403));
    const r = await listarBackupsRemotos({ config: CONFIG, fetchImpl: impl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).not.toContain(CONFIG.serviceKey);
      expect(r.motivo).toMatch(/403/);
    }
  });

  it('não aparece no retorno de um envio bem-sucedido', async () => {
    const arquivo = join(dir, 'y.db');
    writeFileSync(arquivo, 'conteúdo');
    const { impl } = servidor(new Response('', { status: 200 }));
    const r = await enviarBackupRemoto(arquivo, { config: CONFIG, fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CONFIG.serviceKey);
  });

  it('vai nos DOIS cabeçalhos — o esquema novo e o antigo do Supabase', async () => {
    /*
      A chave nova (`sb_secret_...`) autentica pelo header `apikey`; o Bearer
      cobre o esquema antigo (service_role JWT). Mandar os dois atende
      qualquer idade de projeto, e um projeto criado hoje recusaria só o
      Bearer.
    */
    const { impl, chamadas } = servidor(json([]));
    await listarBackupsRemotos({ config: CONFIG, fetchImpl: impl });
    expect(chamadas[0].headers.apikey).toBe(CONFIG.serviceKey);
    expect(chamadas[0].headers.Authorization).toBe(`Bearer ${CONFIG.serviceKey}`);
  });
});

// ============================================================================

describe('a listagem diz o que existe lá', () => {
  it('nome, bytes e data, no formato que o Supabase devolve', async () => {
    const { impl, chamadas } = servidor(
      json([
        {
          name: 'grupo-sampaio-2026-08-27T05-00-00-000Z-diario.db',
          created_at: '2026-08-27T05:00:01.000Z',
          metadata: { size: 5_758_976 },
        },
      ]),
    );

    const r = await listarBackupsRemotos({ config: CONFIG, fetchImpl: impl });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.itens).toHaveLength(1);
      expect(r.itens[0].nome).toMatch(/diario\.db$/);
      expect(r.itens[0].bytes).toBe(5_758_976);
      expect(r.itens[0].criadoEm).toBe('2026-08-27T05:00:01.000Z');
    }
    // E pede ao bucket certo, ordenado pelo mais novo.
    expect(chamadas[0].url).toContain(`/storage/v1/object/list/${CONFIG.bucket}`);
    expect(String(chamadas[0].body)).toContain('created_at');
  });

  it('bucket vazio é resposta, não falha', async () => {
    const { impl } = servidor(json([]));
    const r = await listarBackupsRemotos({ config: CONFIG, fetchImpl: impl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.itens).toEqual([]);
  });

  it('formato inesperado NÃO vira lista vazia', async () => {
    /*
      Devolver `[]` aqui diria "não há backup nenhum" — e é a frase mais
      perigosa que este módulo pode dizer sem ser verdade.
    */
    const { impl } = servidor(json({ mensagem: 'algo diferente' }));
    const r = await listarBackupsRemotos({ config: CONFIG, fetchImpl: impl });
    expect(r.ok).toBe(false);
  });
});

// ============================================================================

describe('o download traz o arquivo de volta, byte a byte', () => {
  it('escreve no destino pedido, com o mesmo conteúdo', async () => {
    const conteudo = Buffer.from('SQLite format 3\u0000isto é o banco');
    const { impl, chamadas } = servidor(new Response(conteudo, { status: 200 }));
    const destino = join(dir, 'restaurado.db');

    const r = await baixarBackupRemoto('algum-backup.db', destino, {
      config: CONFIG,
      fetchImpl: impl,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toBe(conteudo.length);
    expect(readFileSync(destino)).toEqual(conteudo);
    expect(chamadas[0].url).toBe(
      `${CONFIG.url}/storage/v1/object/${CONFIG.bucket}/algum-backup.db`,
    );
  });

  it('recusa do bucket vira motivo com o status, e nenhum arquivo nasce', async () => {
    const { impl } = servidor(new Response('', { status: 404 }));
    const destino = join(dir, 'nao-nasce.db');

    const r = await baixarBackupRemoto('sumiu.db', destino, { config: CONFIG, fetchImpl: impl });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/404/);
    expect(existsSync(destino)).toBe(false);
  });
});
