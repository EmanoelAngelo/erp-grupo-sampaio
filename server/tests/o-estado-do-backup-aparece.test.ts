/**
 * ============================================================================
 * O ESTADO DO BACKUP APARECE (GAP-PRD-011, GAP-PRD-068)
 * ============================================================================
 *
 * A auditoria pôs um backup real na pasta e perguntou à rota:
 * `GET /system/backup/status` respondeu `{ lastBackup: null, status:
 * 'documented' }` — cravado. Nenhuma tela mostrava último backup, cópia
 * remota, disco ou fotos; o único sinal era o log do processo.
 *
 * Este arquivo cobra, contra a rota de verdade (supertest sobre `createApp`):
 *
 *   - com cópia na pasta, a rota diz qual é, quando e quanto pesa;
 *   - cópia atrasada, cópia que falhou (com a MENSAGEM do erro), backup no
 *     mesmo disco do banco, cópia remota não configurada ou recusada: cada
 *     um aparece como FALHOU ou PENDENTE, com o como resolver;
 *   - a conferência do bucket lê o bucket de verdade (um bucket de mentira
 *     num servidor HTTP local) e acusa foto faltando;
 *   - a chave do bucket e a URL nunca aparecem na resposta;
 *   - só quem responde pelo grupo (admin_geral, gestor) alcança.
 *
 * O banco deste arquivo NÃO é anunciado como descartável: é um arquivo
 * temporário próprio, para o diário copiar de verdade (o da suíte é pulado
 * de propósito).
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PASTA_DO_BANCO = mkdtempSync(join(tmpdir(), 'gs-estado-backup-'));
process.env.DEVORA_DATABASE_PATH = join(PASTA_DO_BANCO, 'grupo-sampaio.db');
for (const k of ['DEVORA_SUPABASE_URL', 'DEVORA_SUPABASE_SERVICE_KEY', 'DEVORA_SUPABASE_BUCKET']) delete process.env[k];

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { criarBucketDeMentira } from './helpers/bucketDeMentira.js';

const { createApp } = await import('../src/app.js');
const { loginForTest } = await import('./helpers/auth.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { getConnection, closeConnection } = await import('../src/db/sqlite.js');
const { snapshotDatabase, backupDirectory } = await import('../src/db/backup.js');
const { executarDiario } = await import('../src/services/backup/diarioDoBackup.js');
const { PREFIXO_DOS_OBJETOS } = await import('../src/services/backup/uploadsIncrementais.js');

const app = createApp();
let tokenDoDono = '';

function limparEstado(): void {
  const db = getConnection();
  db.exec(`DELETE FROM core_backup_execucoes; DELETE FROM core_backup_uploads; DELETE FROM core_backup_objetos_remotos;
           DELETE FROM core_meta WHERE key LIKE 'uploads_backup%' OR key LIKE 'backup_%';`);
  rmSync(backupDirectory(), { recursive: true, force: true });
  rmSync(process.env.DEVORA_UPLOADS_DIR as string, { recursive: true, force: true });
}

async function estado() {
  const r = await request(app).get('/api/v1/system/backup/status').set({ Authorization: `Bearer ${tokenDoDono}` });
  expect(r.status).toBe(200);
  return r.body as {
    geral: string;
    itens: Array<{ id: string; estado: string; detalhe: string; comoResolver?: string; quando: string | null }>;
    local: { ultimo: { arquivo: string; bytes: number } | null; mesmoDiscoDoBanco: boolean; pasta: string };
    remoto: { configurado: boolean };
    falhas: Array<{ local: { detalhe: string } }>;
    execucoes: unknown[];
  };
}

function item(e: Awaited<ReturnType<typeof estado>>, id: string) {
  const achado = e.itens.find((i) => i.id === id);
  expect(achado, `item ${id}`).toBeTruthy();
  return achado!;
}

beforeAll(async () => {
  resetEnvCacheForTests();
  const dono = await loginForTest(app, { userId: 'dono-backup', companyId: 'grupo-backup', profileCodes: ['admin_geral'] });
  tokenDoDono = dono.body.accessToken;
});

afterAll(() => {
  closeConnection();
  rmSync(PASTA_DO_BANCO, { recursive: true, force: true });
});

// ============================================================================

describe('quem alcança', () => {
  it('sem sessão, 401', async () => {
    expect((await request(app).get('/api/v1/system/backup/status')).status).toBe(401);
  });

  it('gerente de loja, 403 — o banco é das seis empresas; quem responde é o grupo', async () => {
    const g = await loginForTest(app, { userId: 'gerente-backup', companyId: 'loja-backup', profileCodes: ['gerente_loja'] });
    const r = await request(app).get('/api/v1/system/backup/status').set({ Authorization: `Bearer ${g.body.accessToken}` });
    expect(r.status).toBe(403);
    const c = await request(app).post('/api/v1/system/backup/conferir-bucket').set({ Authorization: `Bearer ${g.body.accessToken}` });
    expect(c.status).toBe(403);
  });
});

// ============================================================================

describe('sem cópia remota configurada', () => {
  beforeEach(() => {
    limparEstado();
  });

  it('com um backup na pasta, a rota diz qual é — e não "lastBackup: null"', async () => {
    const copia = snapshotDatabase('diario');
    expect(copia.skipped).toBeUndefined();
    const e = await estado();
    expect(e).not.toHaveProperty('lastBackup');
    expect(e.local.ultimo?.arquivo).toBe(copia.path.split(/[\\/]/).pop());
    expect(e.local.ultimo?.bytes).toBeGreaterThan(0);
    expect(item(e, 'copia_local').estado).toBe('PRONTO');
  });

  it('nunca houve cópia: PENDENTE, dizendo quando ela roda', async () => {
    const e = await estado();
    const i = item(e, 'copia_local');
    expect(i.estado).toBe('PENDENTE');
    expect(i.detalhe).toMatch(/03:00/);
  });

  it('a última cópia tem mais de um dia: FALHOU, atrasada', async () => {
    const copia = snapshotDatabase('diario');
    const velho = new Date(Date.now() - 30 * 60 * 60 * 1000);
    utimesSync(copia.path, velho, velho);
    const i = item(await estado(), 'copia_local');
    expect(i.estado).toBe('FALHOU');
    expect(i.detalhe).toMatch(/30 h/);
  });

  it('a cópia falhou (disco cheio): FALHOU com a mensagem, na tela e no log', async () => {
    const saida: string[] = [];
    const espiao = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
      saida.push(String(l));
    });
    try {
      await executarDiario({
        gatilho: 'agenda',
        copiarLocal: async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        },
      });
    } finally {
      espiao.mockRestore();
    }
    const e = await estado();
    const i = item(e, 'copia_local');
    expect(i.estado).toBe('FALHOU');
    expect(i.detalhe).toMatch(/no space left/);
    expect(i.comoResolver).toMatch(/espaço livre/);
    expect(e.falhas).toHaveLength(1);
    // GAP-PRD-059: a linha do log carrega a causa.
    const linha = saida.find((l) => l.includes('backup_diario_falhou'));
    expect(linha).toMatch(/no space left on device/);
  });

  it('a cópia remota não configurada aparece como PENDENTE, com o nome das variáveis', async () => {
    snapshotDatabase('diario');
    const e = await estado();
    expect(e.remoto.configurado).toBe(false);
    const r = item(e, 'copia_remota');
    expect(r.estado).toBe('PENDENTE');
    expect(r.comoResolver).toMatch(/DEVORA_SUPABASE_URL/);
    expect(item(e, 'fotos').estado).toBe('PENDENTE');
    expect(e.itens.some((x) => x.id === 'bucket_conferido')).toBe(false);
    expect(e.geral).toBe('PENDENTE');
  });
});

// ============================================================================

describe('o disco do backup (GAP-PRD-068)', () => {
  const ORIGINAL = process.env.DEVORA_BACKUP_DIR;
  afterAll(() => {
    process.env.DEVORA_BACKUP_DIR = ORIGINAL;
    resetEnvCacheForTests();
  });

  it('pasta no mesmo disco do banco: PENDENTE, com o DEVORA_BACKUP_DIR como saída', async () => {
    limparEstado();
    const e = await estado();
    expect(e.local.mesmoDiscoDoBanco).toBe(true);
    const i = item(e, 'outro_disco');
    expect(i.estado).toBe('PENDENTE');
    expect(i.detalhe).toMatch(/MESMO disco/);
    expect(i.comoResolver).toMatch(/DEVORA_BACKUP_DIR=/);
  });

  it('pasta em outro disco: PRONTO — a variável vale sem código novo', async () => {
    const outraLetra = process.platform === 'win32' ? 'Z:/backups-grupo-sampaio' : null;
    if (!outraLetra) return; // fora do Windows toda pasta mora sob a mesma raiz "/"
    process.env.DEVORA_BACKUP_DIR = outraLetra;
    resetEnvCacheForTests();
    const e = await estado();
    expect(e.local.pasta).toBe(outraLetra);
    expect(item(e, 'outro_disco').estado).toBe('PRONTO');
  });
});

// ============================================================================

describe('com cópia remota (um bucket de mentira num servidor local)', () => {
  const bucket = criarBucketDeMentira();
  let fechar: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const s = await bucket.ouvir();
    fechar = s.fechar;
    process.env.DEVORA_SUPABASE_URL = s.url;
    process.env.DEVORA_SUPABASE_SERVICE_KEY = bucket.chave;
    process.env.DEVORA_SUPABASE_BUCKET = bucket.bucket;
    resetEnvCacheForTests();
  });

  afterAll(async () => {
    for (const k of ['DEVORA_SUPABASE_URL', 'DEVORA_SUPABASE_SERVICE_KEY', 'DEVORA_SUPABASE_BUCKET']) delete process.env[k];
    resetEnvCacheForTests();
    await fechar();
  });

  beforeEach(() => {
    limparEstado();
    bucket.objetos.clear();
  });

  function semearFotos(): void {
    const raiz = process.env.DEVORA_UPLOADS_DIR as string;
    mkdirSync(join(raiz, 'produtos'), { recursive: true });
    mkdirSync(join(raiz, 'lojas'), { recursive: true });
    writeFileSync(join(raiz, 'produtos', 'camisa.png'), Buffer.from('camisa-bytes-'.repeat(50)));
    writeFileSync(join(raiz, 'lojas', 'logo.png'), Buffer.from('logo-bytes-'.repeat(40)));
  }

  it('o diário de verdade: cópia na worker, envio do banco e das fotos, tudo PRONTO', async () => {
    semearFotos();
    const r = await executarDiario({ gatilho: 'agenda' });
    expect(r.execucao.local.estado).toBe('ok');
    expect(r.execucao.remoto.estado).toBe('ok');
    expect(r.execucao.uploads.estado).toBe('enviado');
    expect(readdirSync(backupDirectory()).some((f) => f.endsWith('-diario.db'))).toBe(true);
    expect([...bucket.objetos.keys()].some((k) => k.endsWith('-diario.db'))).toBe(true);

    const e = await estado();
    expect(item(e, 'copia_local').estado).toBe('PRONTO');
    expect(item(e, 'copia_remota').estado).toBe('PRONTO');
    expect(item(e, 'fotos').estado).toBe('PRONTO');
    expect(item(e, 'fotos').detalhe).toMatch(/2 arquivo/);
    // Ninguém conferiu o bucket ainda: "enviou" não é "está lá".
    expect(item(e, 'bucket_conferido').estado).toBe('PENDENTE');
  });

  it('conferir o bucket: acha o banco e as fotos, fica PRONTO e vai para a auditoria', async () => {
    semearFotos();
    await executarDiario({ gatilho: 'agenda' });
    const c = await request(app).post('/api/v1/system/backup/conferir-bucket').set({ Authorization: `Bearer ${tokenDoDono}` });
    expect(c.status).toBe(200);
    expect(c.body.conferencia.ok).toBe(true);
    expect(c.body.conferencia.ultimoEnvioPresente).toBe(true);
    expect(c.body.conferencia.objetosFaltando).toBe(0);
    expect(c.body.estado.itens.find((i: { id: string }) => i.id === 'bucket_conferido').estado).toBe('PRONTO');
    const auditoria = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'system.backup.bucket_conferido'")
      .get() as { n: number };
    expect(auditoria.n).toBeGreaterThan(0);
  });

  it('foto que sumiu do bucket: a conferência acusa, e o item vira FALHOU', async () => {
    semearFotos();
    await executarDiario({ gatilho: 'agenda' });
    const umaFoto = [...bucket.objetos.keys()].find((k) => k.startsWith(`${PREFIXO_DOS_OBJETOS}/`))!;
    bucket.objetos.delete(umaFoto);
    const c = await request(app).post('/api/v1/system/backup/conferir-bucket').set({ Authorization: `Bearer ${tokenDoDono}` });
    expect(c.body.conferencia.ok).toBe(false);
    expect(c.body.conferencia.objetosFaltando).toBe(1);
    const i = c.body.estado.itens.find((x: { id: string }) => x.id === 'bucket_conferido');
    expect(i.estado).toBe('FALHOU');
    expect(i.detalhe).toMatch(/1 foto/);
  });

  it('bucket recusando (chave trocada): a cópia remota vira FALHOU com o HTTP — e a chave não aparece', async () => {
    process.env.DEVORA_SUPABASE_SERVICE_KEY = 'sb_secret_chave_que_o_bucket_nao_aceita';
    resetEnvCacheForTests();
    try {
      snapshotDatabase('diario');
      await executarDiario({ gatilho: 'agenda' });
      const e = await estado();
      const i = item(e, 'copia_remota');
      expect(i.estado).toBe('FALHOU');
      expect(i.detalhe).toMatch(/HTTP 401/);
      const texto = JSON.stringify(e);
      expect(texto).not.toContain('sb_secret_chave_que_o_bucket_nao_aceita');
      expect(texto).not.toContain(process.env.DEVORA_SUPABASE_URL as string);
      expect(e.geral).toBe('FALHOU');
    } finally {
      process.env.DEVORA_SUPABASE_SERVICE_KEY = bucket.chave;
      resetEnvCacheForTests();
    }
  });

  it('a resposta nunca carrega a chave nem a URL do bucket', async () => {
    semearFotos();
    await executarDiario({ gatilho: 'agenda' });
    await request(app).post('/api/v1/system/backup/conferir-bucket').set({ Authorization: `Bearer ${tokenDoDono}` });
    const texto = JSON.stringify(await estado());
    expect(texto).not.toContain(bucket.chave);
    expect(texto).not.toContain(process.env.DEVORA_SUPABASE_URL as string);
  });
});
