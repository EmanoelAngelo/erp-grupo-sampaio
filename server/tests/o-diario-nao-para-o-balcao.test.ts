/**
 * ============================================================================
 * O DIÁRIO NÃO PARA O BALCÃO E AS FOTOS NÃO TÊM TETO (GAP-PRD-058)
 * ============================================================================
 *
 * O que a auditoria mediu:
 *
 *   - a cópia remota das fotos era UM pacote (JSON com base64, gzip) montado
 *     inteiro na memória, síncrono, na thread da API — e recusado acima de
 *     200 MB, com uma linha de log e mais nada;
 *   - todo dia o processo relia e re-hasheava o catálogo inteiro;
 *   - o `VACUUM INTO` do diário também rodava na thread da API;
 *   - o diário rodava 24 h depois do BOOT, não numa hora escolhida.
 *
 * O que este arquivo cobra:
 *
 *   1. a cópia do banco numa worker thread: o laço de eventos continua girando
 *      durante a cópia, e a cópia traz o que ainda está no `-wal`;
 *   2. o banco que mora fora de `server/data` também é copiado (quem seguia o
 *      DEPLOY.md ficava sem diário, calado);
 *   3. as fotos vão uma a uma, endereçadas pelo sha256: só o que falta sobe,
 *      conteúdo repetido é um objeto só, nada é sobrescrito, o manifesto vem
 *      por último e só quando TUDO subiu;
 *   4. arquivo que não mudou não é relido (a digital fica no índice);
 *   5. a volta: o conjunto versão 2 restaura byte a byte, recusa objeto
 *      adulterado, caminho fora do destino e sobrescrita;
 *   6. a hora do diário é de parede, pelo relógio da loja.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { criarBucketDeMentira } from './helpers/bucketDeMentira.js';

const { copiarArquivoDeBancoEmSegundoPlano, snapshotDatabase, verificarBackup } = await import('../src/db/backup.js');
const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { resetCoreSchemaCache } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const {
  inventariarUploads,
  sincronizarUploads,
  restaurarConjuntoPorObjetos,
  PREFIXO_DOS_OBJETOS,
} = await import('../src/services/backup/uploadsIncrementais.js');
const { proximaExecucaoDoDiario, lerHoraDoDiario } = await import('../src/services/backup/agendaDoBackup.js');
const { listarObjetos } = await import('../src/services/backup/bucket.js');

const RAIZ_DE_UPLOADS = process.env.DEVORA_UPLOADS_DIR as string;

function bytesDe(semente: string, tamanho: number): Buffer {
  const b = Buffer.alloc(tamanho);
  for (let i = 0; i < tamanho; i += 1) b[i] = (semente.charCodeAt(i % semente.length) * 31 + i) % 256;
  return b;
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function gravarFoto(caminho: string, conteudo: Buffer): void {
  const completo = join(RAIZ_DE_UPLOADS, ...caminho.split('/'));
  mkdirSync(join(completo, '..'), { recursive: true });
  writeFileSync(completo, conteudo);
}

function limparFotos(): void {
  rmSync(RAIZ_DE_UPLOADS, { recursive: true, force: true });
  mkdirSync(RAIZ_DE_UPLOADS, { recursive: true });
}

beforeEach(() => {
  resetDbForTests();
  // `core_meta` fica fora do reset de propósito (é a versão do esquema); a
  // lembrança do último conjunto enviado mora lá e não pode vazar entre casos.
  getConnection().prepare("DELETE FROM core_meta WHERE key LIKE 'uploads_backup%' OR key LIKE 'backup_%'").run();
  limparFotos();
});

// ============================================================================

describe('a cópia do banco numa worker thread', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gs-copia-worker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('o laço de eventos gira durante a cópia, e a cópia traz o que está no -wal', async () => {
    const origem = join(dir, 'origem.db');
    const db = new DatabaseSync(origem);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x TEXT);');
    const ins = db.prepare('INSERT INTO t VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < 60_000; i += 1) ins.run(`linha-${i}-${'x'.repeat(40)}`);
    db.exec('COMMIT');
    // Esta fica no -wal (sem checkpoint): copiar só o .db a perderia.
    db.exec("INSERT INTO t VALUES ('a-ultima')");

    let voltas = 0;
    let girando = true;
    const girar = (): void => {
      if (!girando) return;
      voltas += 1;
      setImmediate(girar);
    };
    setImmediate(girar);
    const destino = join(dir, 'copia', 'copia.db');
    await copiarArquivoDeBancoEmSegundoPlano(origem, destino);
    girando = false;

    expect(voltas, 'a thread da API ficou parada durante a cópia').toBeGreaterThan(3);
    const veredito = verificarBackup(destino);
    expect(veredito.ok).toBe(true);
    const copia = new DatabaseSync(destino, { readOnly: true });
    expect((copia.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(60_001);
    expect(copia.prepare("SELECT x FROM t WHERE x = 'a-ultima'").get()).toBeTruthy();
    copia.close();
    // A origem segue aberta e escrevível: a cópia só leu.
    db.exec("INSERT INTO t VALUES ('depois')");
    db.close();
  });

  it('falha da cópia vira erro com a mensagem — não uma promessa pendurada', async () => {
    await expect(
      copiarArquivoDeBancoEmSegundoPlano(join(dir, 'nao-existe.db'), join(dir, 'x.db')),
    ).rejects.toThrow(/unable to open|no such file|cannot open/i);
  });
});

// ============================================================================

describe('o banco fora de server/data também é copiado', () => {
  const ORIGINAL = process.env.DEVORA_DATABASE_PATH;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gs-banco-proprio-'));
  });
  afterEach(() => {
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = ORIGINAL;
    resetCoreSchemaCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('DEVORA_DATABASE_PATH num disco "definitivo" (não anunciado como descartável) tem cópia', () => {
    /*
      A régua antiga copiava só `./server/data/grupo-sampaio.db`. O DEPLOY.md
      manda pôr o banco no disco persistente definitivo — e quem seguia o
      roteiro ficava sem diário e sem cópia antes da migração, sem aviso.
    */
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'dados', 'grupo-sampaio.db');
    mkdirSync(join(dir, 'dados'), { recursive: true });
    resetCoreSchemaCache();
    getConnection().exec('CREATE TABLE IF NOT EXISTS prova (x TEXT); INSERT INTO prova VALUES (\'ok\');');

    const r = snapshotDatabase('manual');
    expect(r.skipped).toBeUndefined();
    expect(existsSync(r.path)).toBe(true);
    expect(r.path.startsWith(process.env.DEVORA_BACKUP_DIR as string)).toBe(true);
    expect(verificarBackup(r.path).ok).toBe(true);
  });

  it('o banco anunciado como descartável continua sem cópia', () => {
    // É o banco desta suíte: TEST_DATABASE_PATH === DEVORA_DATABASE_PATH.
    expect(snapshotDatabase('manual').skipped).toBe('disposable');
  });
});

// ============================================================================

describe('o índice das fotos não relê o que não mudou', () => {
  it('só as pastas declaradas: node_modules e cache na raiz de uploads não entram', async () => {
    gravarFoto('produtos/a.png', bytesDe('a', 100));
    gravarFoto('node_modules/coisa/index.js', Buffer.from('nao-e-dado'));
    gravarFoto('.cache/x.tmp', Buffer.from('nao-e-dado'));
    expect((await inventariarUploads()).arquivos.map((a) => a.caminho)).toEqual(['produtos/a.png']);
  });

  it('o sha256 vem de cada arquivo e é reaproveitado enquanto tamanho e data não mudam', async () => {
    const logo = bytesDe('logo', 900);
    gravarFoto('lojas/logo.png', logo);
    const primeiro = await inventariarUploads();
    expect(primeiro.arquivos).toEqual([
      expect.objectContaining({ caminho: 'lojas/logo.png', bytes: 900, sha256: sha(logo) }),
    ]);

    // Mesmo tamanho, mesma data, conteúdo trocado por baixo: a digital guardada
    // é reaproveitada — a prova de que o arquivo NÃO foi relido.
    const completo = join(RAIZ_DE_UPLOADS, 'lojas', 'logo.png');
    const quando = new Date(primeiro.arquivos[0].modificadoEm);
    writeFileSync(completo, bytesDe('outro', 900));
    utimesSync(completo, quando, quando);
    expect((await inventariarUploads()).arquivos[0].sha256).toBe(sha(logo));

    // Data mudou: relê.
    const depois = new Date(quando.getTime() + 5_000);
    utimesSync(completo, depois, depois);
    expect((await inventariarUploads()).arquivos[0].sha256).toBe(sha(bytesDe('outro', 900)));
  });

  it('arquivo apagado sai do índice', async () => {
    gravarFoto('produtos/a.png', bytesDe('a', 100));
    gravarFoto('produtos/b.png', bytesDe('b', 100));
    await inventariarUploads();
    rmSync(join(RAIZ_DE_UPLOADS, 'produtos', 'b.png'));
    const m = await inventariarUploads();
    expect(m.arquivos.map((a) => a.caminho)).toEqual(['produtos/a.png']);
    const n = getConnection().prepare('SELECT COUNT(*) AS n FROM core_backup_uploads').get() as { n: number };
    expect(n.n).toBe(1);
  });
});

// ============================================================================

describe('as fotos vão para o bucket uma a uma', () => {
  function configDe(bucket: ReturnType<typeof criarBucketDeMentira>, url = 'https://projeto.supabase.invalido') {
    return { url, serviceKey: bucket.chave, bucket: bucket.bucket };
  }

  function semear(): void {
    gravarFoto('lojas/logo-gringa.png', bytesDe('logo', 1200));
    gravarFoto('produtos/camisa.png', bytesDe('camisa', 2400));
    gravarFoto('os/antes.jpg', bytesDe('antes', 640));
  }

  it('cada arquivo vira um objeto uploads/objetos/<sha256>, e o manifesto versão 2 vem por último', async () => {
    semear();
    const b = criarBucketDeMentira();
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });

    expect(r.estado).toBe('enviado');
    expect(r.enviados).toBe(3);
    const nomes = [...b.objetos.keys()];
    for (const conteudo of [bytesDe('logo', 1200), bytesDe('camisa', 2400), bytesDe('antes', 640)]) {
      expect(nomes).toContain(`${PREFIXO_DOS_OBJETOS}/${sha(conteudo)}`);
    }
    const gravacoes = b.chamadas.filter((c) => c.metodo === 'POST');
    expect(gravacoes[gravacoes.length - 1].caminho).toMatch(/\/uploads\/manifesto-.*\.json$/);
    const manifesto = JSON.parse(b.objetos.get(r.manifesto as string)!.conteudo.toString('utf8'));
    expect(manifesto.versao).toBe(2);
    expect(manifesto.arquivos).toHaveLength(3);
    // Nenhum pacote .json.gz: nada passa inteiro pela memória, e não há teto.
    expect(nomes.some((n) => n.endsWith('.json.gz'))).toBe(false);
  });

  it('nunca pede x-upsert e a chave não aparece em nome nem em manifesto', async () => {
    semear();
    const b = criarBucketDeMentira();
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(b.chamadas.every((c) => c.cabecalhos['x-upsert'] !== 'true')).toBe(true);
    for (const c of b.chamadas) expect(c.caminho).not.toContain(b.chave);
    expect(b.objetos.get(r.manifesto as string)!.conteudo.toString('utf8')).not.toContain(b.chave);
  });

  it('nada mudou: não toca o bucket', async () => {
    semear();
    const b = criarBucketDeMentira();
    await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    const antes = b.chamadas.length;
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r.estado).toBe('sem_mudanca');
    expect(b.chamadas.length).toBe(antes);
  });

  it('uma foto nova: sobe só ela, e um manifesto novo', async () => {
    semear();
    const b = criarBucketDeMentira();
    await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    gravarFoto('produtos/calca.png', bytesDe('calca', 3000));
    const antes = b.chamadas.length;
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r.estado).toBe('enviado');
    expect(r.enviados).toBe(1);
    const novas = b.chamadas.slice(antes).filter((c) => c.metodo === 'POST').map((c) => c.caminho);
    expect(novas).toHaveLength(2);
    expect(novas[0]).toContain(sha(bytesDe('calca', 3000)));
  });

  it('conteúdo repetido em dois caminhos é um objeto só', async () => {
    gravarFoto('produtos/a.png', bytesDe('igual', 500));
    gravarFoto('produtos/b.png', bytesDe('igual', 500));
    const b = criarBucketDeMentira();
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r.enviados).toBe(1);
    expect([...b.objetos.keys()].filter((n) => n.startsWith(PREFIXO_DOS_OBJETOS))).toHaveLength(1);
  });

  it('objeto que o bucket já tem (409) conta como presente — o nome é o conteúdo', async () => {
    semear();
    const b = criarBucketDeMentira();
    const conteudo = bytesDe('camisa', 2400);
    b.objetos.set(`${PREFIXO_DOS_OBJETOS}/${sha(conteudo)}`, { conteudo, criadoEm: new Date().toISOString() });
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r.estado).toBe('enviado');
    expect(r.enviados).toBe(2);
  });

  it('um objeto falhou: não sobe manifesto, e o próximo diário manda só o que faltou', async () => {
    semear();
    const b = criarBucketDeMentira();
    b.falharGravacao(new RegExp(sha(bytesDe('camisa', 2400))), 503);
    const r1 = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r1.estado).toBe('falhou');
    expect(r1.detalhe).toMatch(/503/);
    expect([...b.objetos.keys()].some((n) => n.includes('manifesto'))).toBe(false);

    const antes = b.chamadas.length;
    const r2 = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r2.estado).toBe('enviado');
    const gravadas = b.chamadas.slice(antes).filter((c) => c.metodo === 'POST').map((c) => c.caminho);
    expect(gravadas).toHaveLength(2); // a camisa e o manifesto
    expect(gravadas[0]).toContain(sha(bytesDe('camisa', 2400)));
  });

  it('trocar de bucket reenvia tudo, em vez de acreditar que o novo já tem', async () => {
    semear();
    const b1 = criarBucketDeMentira();
    await sincronizarUploads({ fetchImpl: b1.fetchImpl, config: configDe(b1) });
    const b2 = criarBucketDeMentira();
    const r = await sincronizarUploads({ fetchImpl: b2.fetchImpl, config: configDe(b2, 'https://outro.supabase.invalido') });
    expect(r.estado).toBe('enviado');
    expect(r.enviados).toBe(3);
  });

  it('sem configuração: diz que não está configurado, sem tocar a rede', async () => {
    semear();
    const b = criarBucketDeMentira();
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: { url: '', serviceKey: '', bucket: '' } });
    expect(r.estado).toBe('nao_configurado');
    expect(b.chamadas).toHaveLength(0);
  });

  it('sem foto nenhuma: vazio, e nada sobe', async () => {
    const b = criarBucketDeMentira();
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    expect(r.estado).toBe('vazio');
    expect(b.chamadas).toHaveLength(0);
  });

  it('o laço de eventos gira entre um arquivo e outro', async () => {
    for (let i = 0; i < 40; i += 1) gravarFoto(`produtos/p${i}.png`, bytesDe(`p${i}`, 4000));
    const b = criarBucketDeMentira();
    let voltas = 0;
    let girando = true;
    const girar = (): void => {
      if (!girando) return;
      voltas += 1;
      setImmediate(girar);
    };
    setImmediate(girar);
    const r = await sincronizarUploads({ fetchImpl: b.fetchImpl, config: configDe(b) });
    girando = false;
    expect(r.estado).toBe('enviado');
    expect(voltas).toBeGreaterThan(10);
  });
});

// ============================================================================

describe('a volta de um conjunto versão 2', () => {
  let destino: string;
  beforeEach(() => {
    destino = mkdtempSync(join(tmpdir(), 'gs-volta-fotos-'));
  });
  afterEach(() => {
    rmSync(destino, { recursive: true, force: true });
  });

  async function enviarEAbrir() {
    gravarFoto('lojas/logo.png', bytesDe('logo', 1200));
    gravarFoto('os/antes.jpg', bytesDe('antes', 640));
    const b = criarBucketDeMentira();
    const r = await sincronizarUploads({
      fetchImpl: b.fetchImpl,
      config: { url: 'https://p.supabase.invalido', serviceKey: b.chave, bucket: b.bucket },
    });
    const manifesto = JSON.parse(b.objetos.get(r.manifesto as string)!.conteudo.toString('utf8'));
    const baixar = async (s: string) => {
      const o = b.objetos.get(`${PREFIXO_DOS_OBJETOS}/${s}`);
      if (!o) throw new Error('não está no bucket');
      return o.conteudo;
    };
    return { b, manifesto, baixar };
  }

  it('devolve cada arquivo byte a byte, na estrutura de pastas do DEVORA_UPLOADS_DIR', async () => {
    const { manifesto, baixar } = await enviarEAbrir();
    const v = await restaurarConjuntoPorObjetos(manifesto, destino, baixar);
    expect(v.arquivos).toBe(2);
    expect(readFileSync(join(destino, 'lojas', 'logo.png'))).toEqual(bytesDe('logo', 1200));
    expect(readFileSync(join(destino, 'os', 'antes.jpg'))).toEqual(bytesDe('antes', 640));
  });

  it('retomar uma volta interrompida pula o que já está lá, igual', async () => {
    const { manifesto, baixar } = await enviarEAbrir();
    await restaurarConjuntoPorObjetos(manifesto, destino, baixar);
    const v = await restaurarConjuntoPorObjetos(manifesto, destino, baixar);
    expect(v.arquivos).toBe(0);
    expect(v.jaEstavam).toBe(2);
  });

  it('objeto adulterado no bucket é recusado', async () => {
    const { b, manifesto, baixar } = await enviarEAbrir();
    const chave = `${PREFIXO_DOS_OBJETOS}/${sha(bytesDe('logo', 1200))}`;
    b.objetos.set(chave, { conteudo: Buffer.from('outra coisa'), criadoEm: '' });
    await expect(restaurarConjuntoPorObjetos(manifesto, destino, baixar)).rejects.toThrow(/sha256/);
  });

  it('arquivo que já existe no destino com outro conteúdo não é sobrescrito', async () => {
    const { manifesto, baixar } = await enviarEAbrir();
    mkdirSync(join(destino, 'lojas'), { recursive: true });
    writeFileSync(join(destino, 'lojas', 'logo.png'), 'o de hoje');
    await expect(restaurarConjuntoPorObjetos(manifesto, destino, baixar)).rejects.toThrow(/outro conteúdo/);
    expect(readFileSync(join(destino, 'lojas', 'logo.png'), 'utf8')).toBe('o de hoje');
  });

  it('caminho fora do destino (ou fora das pastas declaradas) é recusado antes de escrever', async () => {
    const { manifesto, baixar } = await enviarEAbrir();
    for (const caminho of ['../fora.png', 'lojas/../../fora.png', 'node_modules/x.js']) {
      const forjado = { ...manifesto, arquivos: [{ ...manifesto.arquivos[0], caminho }] };
      await expect(restaurarConjuntoPorObjetos(forjado, destino, baixar)).rejects.toThrow(/caminho/i);
    }
  });
});

// ============================================================================

describe('a hora do diário', () => {
  it('03:00 pelo relógio da loja: de manhã, a próxima é amanhã às 03:00', () => {
    // 11/09 às 09:00 em Pelotas = 12:00 UTC.
    expect(proximaExecucaoDoDiario(new Date('2026-09-11T12:00:00Z'), 3).toISOString()).toBe('2026-09-12T06:00:00.000Z');
  });

  it('de madrugada, antes das 03:00, a próxima é hoje', () => {
    // 11/09 às 02:00 em Pelotas = 05:00 UTC.
    expect(proximaExecucaoDoDiario(new Date('2026-09-11T05:00:00Z'), 3).toISOString()).toBe('2026-09-11T06:00:00.000Z');
  });

  it('exatamente na hora: a próxima é amanhã, não agora de novo', () => {
    expect(proximaExecucaoDoDiario(new Date('2026-09-11T06:00:00Z'), 3).toISOString()).toBe('2026-09-12T06:00:00.000Z');
  });

  it('às 22h de Pelotas o dia de Greenwich já virou — e a conta continua pelo da loja', () => {
    // 11/09 às 22:30 em Pelotas = 12/09 01:30 UTC; hora 23 → 11/09 23:00 local = 12/09 02:00 UTC.
    expect(proximaExecucaoDoDiario(new Date('2026-09-12T01:30:00Z'), 23).toISOString()).toBe('2026-09-12T02:00:00.000Z');
  });

  it('DEVORA_BACKUP_HORA: vazio é 3; fora de 0..23 ou não numérico é inválido', () => {
    expect(lerHoraDoDiario('')).toBe(3);
    expect(lerHoraDoDiario(undefined)).toBe(3);
    expect(lerHoraDoDiario('0')).toBe(0);
    expect(lerHoraDoDiario('23')).toBe(23);
    expect(lerHoraDoDiario('24')).toBeNull();
    expect(lerHoraDoDiario('3h')).toBeNull();
  });
});

// ============================================================================

describe('o laço do diário: ao subir, e depois na hora marcada', () => {
  afterEach(async () => {
    const { stopDailyBackup } = await import('../src/db/backup.js');
    stopDailyBackup();
    vi.useRealTimers();
  });

  function gatilhos(): string[] {
    return (
      getConnection().prepare('SELECT gatilho FROM core_backup_execucoes ORDER BY iniciado_em').all() as unknown as Array<{
        gatilho: string;
      }>
    ).map((l) => l.gatilho);
  }

  it('sem diário de hoje, roda ao subir; a próxima é às 03:00 da loja, não 24 h depois do boot', async () => {
    // 11/09 às 09:00 em Pelotas.
    vi.useFakeTimers({ now: new Date('2026-09-11T12:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { startDailyBackup } = await import('../src/db/backup.js');
    startDailyBackup();
    await vi.waitFor(() => expect(gatilhos()).toEqual(['boot']));

    // Dezessete horas depois (02:00 da loja): ainda não.
    await vi.advanceTimersByTimeAsync(17 * 60 * 60 * 1000);
    expect(gatilhos()).toEqual(['boot']);

    // Às 03:00 da loja (06:00 UTC), roda — agendada.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1_000);
    await vi.waitFor(() => expect(gatilhos()).toEqual(['boot', 'agenda']));
  });
});

// ============================================================================

describe('a listagem do bucket anda por todas as páginas', () => {
  it('com o provedor devolvendo menos que o pedido por página, nada fica de fora', async () => {
    const b = criarBucketDeMentira();
    for (let i = 0; i < 7; i += 1) b.objetos.set(`uploads/objetos/obj-${i}`, { conteudo: Buffer.from('x'), criadoEm: '' });
    // Um provedor com teto de 3 por página, pedido de 5: parar em "veio menos
    // que o limite" perderia quatro objetos.
    const comTeto = (async (url: string, init?: RequestInit) => {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return b.fetchImpl(url, { ...init, body: JSON.stringify({ ...corpo, limit: Math.min(Number(corpo.limit), 3) }) });
    }) as unknown as typeof fetch;
    const r = await listarObjetos('uploads/objetos', {
      fetchImpl: comTeto,
      porPagina: 5,
      config: { url: 'https://p.supabase.invalido', serviceKey: b.chave, bucket: b.bucket },
    });
    expect(r.ok && r.itens.map((i) => i.nome).sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `obj-${i}`));
  });
});
