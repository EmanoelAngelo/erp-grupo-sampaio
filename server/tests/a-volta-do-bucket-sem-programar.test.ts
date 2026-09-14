/**
 * ============================================================================
 * A VOLTA DO BUCKET SEM PROGRAMAR (GAP-PRD-012)
 * ============================================================================
 *
 * Disco morto. O operador precisa listar o bucket, baixar o `.db` e o
 * conjunto de fotos do dia, restaurar os dois num caminho novo e subir — sem
 * desenvolvedor. Até aqui, as funções de download existiam e nenhum comando
 * as chamava: o banco voltava por download manual no painel do provedor e as
 * fotos só com código novo.
 *
 * Este arquivo roda os QUATRO comandos como o operador rodaria — processo
 * filho, pelo `tsx`, lendo a configuração do ambiente — contra um bucket de
 * mentira num servidor HTTP local (127.0.0.1, porta escolhida pelo sistema):
 *
 *   listar-bucket, baixar-backup, restaurar-uploads, restaurar-do-bucket
 *
 * e cobra: o que volta abre (banco) e bate byte a byte (fotos), nos dois
 * formatos de fotos que existem no bucket; nada é escrito por cima; cópia
 * quebrada não vira arquivo; sem configuração, o comando diz o que falta; e
 * a chave nunca aparece na saída.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { criarBucketDeMentira } from './helpers/bucketDeMentira.js';

const { sincronizarUploads } = await import('../src/services/backup/uploadsIncrementais.js');
const { montarManifesto, montarPacote } = await import('../src/db/backupUploads.js');
const { verificarBackup } = await import('../src/db/backup.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { resetDbForTests } = await import('../src/db/database.js');

const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(SERVIDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RAIZ_DE_UPLOADS = process.env.DEVORA_UPLOADS_DIR as string;

const bucket = criarBucketDeMentira();
let url = '';
let fechar: () => Promise<void> = async () => {};
let area: string;

function bytesDe(semente: string, tamanho: number): Buffer {
  const b = Buffer.alloc(tamanho);
  for (let i = 0; i < tamanho; i += 1) b[i] = (semente.charCodeAt(i % semente.length) * 7 + i) % 256;
  return b;
}

function rodar(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ codigo: number; saida: string }> {
  return new Promise((ok) => {
    execFile(
      process.execPath,
      [TSX, join(SERVIDOR, 'src', 'scripts', `${script}.ts`), ...args],
      {
        cwd: area,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          DEVORA_IGNORE_DOTENV: 'true',
          DEVORA_SUPABASE_URL: url,
          DEVORA_SUPABASE_SERVICE_KEY: bucket.chave,
          DEVORA_SUPABASE_BUCKET: bucket.bucket,
          ...env,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
      (erro, stdout, stderr) => {
        const codigo = erro ? Number((erro as { code?: number }).code ?? 1) : 0;
        ok({ codigo, saida: `${stdout}${stderr}` });
      },
    );
  });
}

/** Um banco SQLite de verdade, como o diário o teria enviado. */
function bancoDeVerdade(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'gs-banco-do-bucket-'));
  const caminho = join(dir, 'b.db');
  const db = new DatabaseSync(caminho);
  db.exec("CREATE TABLE core_companies (id TEXT PRIMARY KEY, trade_name TEXT); INSERT INTO core_companies VALUES ('preco-justo', 'Preço Justo');");
  db.close();
  const conteudo = readFileSync(caminho);
  rmSync(dir, { recursive: true, force: true });
  return conteudo;
}

function gravarFoto(caminho: string, conteudo: Buffer): void {
  const completo = join(RAIZ_DE_UPLOADS, ...caminho.split('/'));
  mkdirSync(dirname(completo), { recursive: true });
  writeFileSync(completo, conteudo);
}

const ANTIGO = 'grupo-sampaio-2026-09-09T06-00-00-000Z-diario.db';
const NOVO = 'grupo-sampaio-2026-09-10T06-00-00-000Z-diario.db';

beforeAll(async () => {
  area = mkdtempSync(join(tmpdir(), 'gs-volta-do-bucket-'));
  const s = await bucket.ouvir();
  url = s.url;
  fechar = s.fechar;

  // Duas cópias do banco na raiz.
  bucket.objetos.set(ANTIGO, { conteudo: bancoDeVerdade(), criadoEm: '2026-09-09T06:00:01Z' });
  bucket.objetos.set(NOVO, { conteudo: bancoDeVerdade(), criadoEm: '2026-09-10T06:00:01Z' });

  // Um pacote ANTIGO (versão 1), de agosto, com a foto velha da loja.
  resetDbForTests();
  getConnection().prepare("DELETE FROM core_meta WHERE key LIKE 'uploads_backup%'").run();
  rmSync(RAIZ_DE_UPLOADS, { recursive: true, force: true });
  gravarFoto('lojas/logo-antigo.png', bytesDe('logo-antigo', 700));
  const m1 = { ...montarManifesto(), criadoEm: '2026-08-01T00:00:00.000Z' };
  bucket.objetos.set('uploads/uploads-2026-08-01T00-00-00-000Z.json.gz', { conteudo: montarPacote(m1), criadoEm: '' });
  bucket.objetos.set('uploads/manifesto-2026-08-01T00-00-00-000Z.json', {
    conteudo: Buffer.from(JSON.stringify(m1)),
    criadoEm: '',
  });

  // O conjunto de HOJE (versão 2), pelo envio do diário.
  rmSync(RAIZ_DE_UPLOADS, { recursive: true, force: true });
  gravarFoto('lojas/logo.png', bytesDe('logo', 1500));
  gravarFoto('produtos/camisa.png', bytesDe('camisa', 4200));
  gravarFoto('os/antes.jpg', bytesDe('antes', 900));
  const envio = await sincronizarUploads({
    fetchImpl: bucket.fetchImpl,
    config: { url, serviceKey: bucket.chave, bucket: bucket.bucket },
  });
  expect(envio.estado).toBe('enviado');
}, 60_000);

afterAll(async () => {
  await fechar();
  rmSync(area, { recursive: true, force: true });
});

// ============================================================================

describe('listar-bucket', () => {
  it('mostra as cópias do banco e os conjuntos de fotos, do mais novo ao mais velho — sem a chave', async () => {
    const r = await rodar('listar-bucket', []);
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain('Cópias do banco: 2');
    expect(r.saida.indexOf(NOVO)).toBeLessThan(r.saida.indexOf(ANTIGO));
    expect(r.saida).toMatch(/Conjuntos de fotos \(manifestos\): 2/);
    expect(r.saida).toContain('Pacotes antigos (versão 1): 1');
    expect(r.saida).not.toContain(bucket.chave);
  }, 60_000);

  it('sem configuração: diz o que falta e sai com 1', async () => {
    const r = await rodar('listar-bucket', [], { DEVORA_SUPABASE_URL: '', DEVORA_SUPABASE_SERVICE_KEY: '' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/DEVORA_SUPABASE_URL/);
  }, 60_000);
});

// ============================================================================

describe('baixar-backup', () => {
  it('--ultimo traz a cópia mais nova, conferida, e ela abre com os dados', async () => {
    const destino = join(area, 'baixado', 'grupo-sampaio.db');
    const r = await rodar('baixar-backup', ['--ultimo', destino]);
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain(NOVO);
    expect(verificarBackup(destino).ok).toBe(true);
    const db = new DatabaseSync(destino, { readOnly: true });
    expect(db.prepare('SELECT trade_name FROM core_companies').get()).toEqual({ trade_name: 'Preço Justo' });
    db.close();
  }, 60_000);

  it('destino que já existe: recusa, e o arquivo de lá fica intocado', async () => {
    const destino = join(area, 'ja-existe.db');
    writeFileSync(destino, 'o banco de hoje');
    const r = await rodar('baixar-backup', [NOVO, destino]);
    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/já existe/);
    expect(readFileSync(destino, 'utf8')).toBe('o banco de hoje');
  }, 60_000);

  it('cópia quebrada no bucket: recusa e não deixa arquivo nenhum para trás', async () => {
    bucket.objetos.set('grupo-sampaio-2026-09-08T06-00-00-000Z-diario.db', {
      conteudo: Buffer.from('isto nao e um banco'),
      criadoEm: '',
    });
    const destino = join(area, 'quebrado.db');
    const r = await rodar('baixar-backup', ['grupo-sampaio-2026-09-08T06-00-00-000Z-diario.db', destino]);
    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/NÃO abre como banco/);
    expect(existsSync(destino)).toBe(false);
    expect(existsSync(`${destino}.baixando`)).toBe(false);
    bucket.objetos.delete('grupo-sampaio-2026-09-08T06-00-00-000Z-diario.db');
  }, 60_000);

  it('nome com caminho é recusado antes de ir ao bucket', async () => {
    const r = await rodar('baixar-backup', ['../fora.db', join(area, 'x.db')]);
    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/Nome inválido/);
  }, 60_000);
});

// ============================================================================

describe('restaurar-uploads', () => {
  it('--ultimo traz o conjunto de hoje (versão 2), byte a byte, na estrutura do DEVORA_UPLOADS_DIR', async () => {
    const destino = join(area, 'fotos-hoje');
    const r = await rodar('restaurar-uploads', ['--ultimo', destino]);
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain('formato 2');
    expect(readFileSync(join(destino, 'lojas', 'logo.png'))).toEqual(bytesDe('logo', 1500));
    expect(readFileSync(join(destino, 'produtos', 'camisa.png'))).toEqual(bytesDe('camisa', 4200));
    expect(readFileSync(join(destino, 'os', 'antes.jpg'))).toEqual(bytesDe('antes', 900));
    expect(r.saida).toContain('DEVORA_UPLOADS_DIR=');
  }, 60_000);

  it('o pacote antigo (versão 1) também volta, pelo manifesto ou pelo nome do pacote', async () => {
    const pelaManifesto = join(area, 'fotos-agosto');
    const r1 = await rodar('restaurar-uploads', ['manifesto-2026-08-01T00-00-00-000Z.json', pelaManifesto]);
    expect(r1.codigo, r1.saida).toBe(0);
    expect(r1.saida).toContain('formato 1');
    expect(readFileSync(join(pelaManifesto, 'lojas', 'logo-antigo.png'))).toEqual(bytesDe('logo-antigo', 700));

    const peloPacote = join(area, 'fotos-agosto-2');
    const r2 = await rodar('restaurar-uploads', ['uploads-2026-08-01T00-00-00-000Z.json.gz', peloPacote]);
    expect(r2.codigo, r2.saida).toBe(0);
    expect(readFileSync(join(peloPacote, 'lojas', 'logo-antigo.png'))).toEqual(bytesDe('logo-antigo', 700));
  }, 60_000);

  it('foto adulterada no bucket: recusa com o nome do arquivo', async () => {
    const chave = [...bucket.objetos.keys()].find((k) => k.startsWith('uploads/objetos/'))!;
    const original = bucket.objetos.get(chave)!;
    bucket.objetos.set(chave, { conteudo: Buffer.from('trocado'), criadoEm: '' });
    try {
      const r = await rodar('restaurar-uploads', ['--ultimo', join(area, 'fotos-adulteradas')]);
      expect(r.codigo, r.saida).toBe(1);
      expect(r.saida).toMatch(/sha256/);
    } finally {
      bucket.objetos.set(chave, original);
    }
  }, 60_000);
});

// ============================================================================

describe('restaurar-do-bucket — o disco morto', () => {
  it('numa pasta nova: banco e fotos mais novos, conferidos, e as duas linhas do .env', async () => {
    const pasta = join(area, 'maquina-nova');
    const r = await rodar('restaurar-do-bucket', [pasta]);
    expect(r.codigo, r.saida).toBe(0);
    expect(verificarBackup(join(pasta, 'grupo-sampaio.db')).ok).toBe(true);
    expect(readFileSync(join(pasta, 'uploads', 'produtos', 'camisa.png'))).toEqual(bytesDe('camisa', 4200));
    const barra = (c: string) => c.split('\\').join('/');
    expect(r.saida).toContain(`DEVORA_DATABASE_PATH=${barra(join(pasta, 'grupo-sampaio.db'))}`);
    expect(r.saida).toContain(`DEVORA_UPLOADS_DIR=${barra(join(pasta, 'uploads'))}`);
    expect(r.saida).not.toContain(bucket.chave);
  }, 60_000);

  it('pasta que não está vazia: recusa — nunca por cima da instalação', async () => {
    const pasta = join(area, 'instalacao-atual');
    mkdirSync(pasta, { recursive: true });
    writeFileSync(join(pasta, 'grupo-sampaio.db'), 'o banco em uso');
    const r = await rodar('restaurar-do-bucket', [pasta]);
    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/não está vazia/);
    expect(readFileSync(join(pasta, 'grupo-sampaio.db'), 'utf8')).toBe('o banco em uso');
  }, 60_000);

  it('escolhendo a cópia: --banco traz a pedida, não a mais nova', async () => {
    const pasta = join(area, 'maquina-nova-2');
    const r = await rodar('restaurar-do-bucket', [pasta, '--banco', ANTIGO]);
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain(ANTIGO);
  }, 60_000);
});
