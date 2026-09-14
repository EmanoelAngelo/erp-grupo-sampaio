/**
 * ============================================================================
 * O PASSO 86 — o vínculo de hoje ganha escopo de caixa e de bancada, sem perder nada
 * ============================================================================
 *
 * `core_user_companies` ganha cinco colunas (todas com DEFAULT ou anuláveis,
 * então a DDL canônica e o `reconcileCoreSchema` já as levariam ao banco). O
 * passo 86 existe pelo DADO: grava `all_workshops` explícito em cada vínculo
 * que existe, preservando o que cada um vê hoje (desenho §7.2, com a D3b):
 *
 *   - admin_geral, gestor e gerente_oficina → todas (é o isManager de hoje);
 *   - quem não é membro de nenhuma bancada ATIVA da empresa e não é mecânico →
 *     todas (é o fallback de hoje, e a régua de empresa do balcão);
 *   - quem é membro de bancada ativa e não é gerente → só as suas;
 *   - o MECÂNICO sem bancada ativa → nenhuma (D3b: o fallback dele era acidente).
 *
 * Mais `all_terminals = 1` (qualquer caixa da empresa, como hoje) e uma linha
 * `access.migrated` por empresa na trilha, com as contagens.
 *
 * Cada caso cai quando a regra correspondente sai do passo; o de 84 cai se o
 * 86 depender de algo que só o 85 deixa; o de repetição cai se o passo não for
 * idempotente.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { closeConnection, getConnection } = await import('../../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../../src/db/schema.js');
const { criarColecoesDeDocumentos } = await import('../../src/db/database.js');
const { migrateCoreSchema, CORE_TARGET_VERSION } = await import('../../src/db/core-migrations.js');
const { ITENS_DA_CONSOLIDACAO } = await import('../../src/db/consolidacaoDaRemediacao.js');
const { conferirEsquema } = await import('../../src/db/derivaDoEsquema.js');

const COLUNAS_NOVAS = ['all_terminals', 'all_workshops', 'access_version', 'updated_at', 'updated_by'];

function bancoTemporario(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gs-passo86-'));
  return { dir, path: join(dir, 'core.db') };
}

function subir(path: string): void {
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  process.env.TEST_DATABASE_PATH = path;
  resetCoreSchemaCache();
  // As coleções de documentos em CADA banco temporário: `ensureSchema` é
  // memorizado por processo e só as criaria no primeiro (ver schema-drift).
  criarColecoesDeDocumentos(getConnection());
  ensureCoreSchema();
  for (const colecao of ['payment_terminal_configurations', 'payment_terminal_history', 'payment_terminal_transactions']) {
    getConnection().exec(`CREATE TABLE IF NOT EXISTS "${colecao}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL)`);
  }
}

function limpar(dir: string): void {
  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária.
  }
}

const meta = (chave: string) =>
  (getConnection().prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as { value?: string } | undefined)?.value ?? null;

/** Volta o banco a "antes do passo 86": sem as colunas novas, sem a marca, na 85. */
function voltarPara85(): void {
  const db = getConnection();
  for (const c of COLUNAS_NOVAS) db.exec(`ALTER TABLE core_user_companies DROP COLUMN ${c}`);
  db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_86'").run();
  db.prepare("UPDATE core_meta SET value = '85' WHERE key = 'core_schema_version'").run();
}

/** E a "antes do 85" também — o banco que pula de 84 direto para 86. */
function voltarPara84(): void {
  voltarPara85();
  const db = getConnection();
  db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_85'").run();
  db.prepare("UPDATE core_meta SET value = '84' WHERE key = 'core_schema_version'").run();
  for (const nome of ITENS_DA_CONSOLIDACAO.unicos) db.exec(`DROP INDEX IF EXISTS ${nome}`);
}

interface Pessoa {
  login: string;
  perfil: string;
  bancadas: ('ativa' | 'desativada' | 'da-outra-empresa')[];
}

/** O grupo como ele está hoje na loja, com os casos de bancada que a regra distingue. */
const PESSOAS: Pessoa[] = [
  { login: 'admin', perfil: 'admin_geral', bancadas: [] },
  { login: 'carlos', perfil: 'gestor', bancadas: [] },
  { login: 'gerente.oficina', perfil: 'gerente_oficina', bancadas: ['ativa'] },
  { login: 'atendente.solto', perfil: 'atendente', bancadas: [] },
  { login: 'atendente.membro', perfil: 'atendente', bancadas: ['ativa'] },
  { login: 'caixa.oficina', perfil: 'operador_caixa_oficina', bancadas: [] },
  { login: 'mecanico.membro', perfil: 'mecanico', bancadas: ['ativa'] },
  { login: 'mecanico.sem.bancada', perfil: 'mecanico', bancadas: [] },
  { login: 'mecanico.so.desativada', perfil: 'mecanico', bancadas: ['desativada'] },
  { login: 'estoquista.so.desativada', perfil: 'estoquista', bancadas: ['desativada'] },
  { login: 'atendente.so.outra', perfil: 'atendente', bancadas: ['da-outra-empresa'] },
];

/** O valor que o passo tem de gravar para cada um (null = a regra não se aplica). */
const ESPERADO: Record<string, number> = {
  admin: 1,
  carlos: 1,
  'gerente.oficina': 1,
  'atendente.solto': 1,
  'atendente.membro': 0,
  'caixa.oficina': 1,
  'mecanico.membro': 0,
  'mecanico.sem.bancada': 0,
  'mecanico.so.desativada': 0,
  'estoquista.so.desativada': 1,
  'atendente.so.outra': 1,
};

function semearOGrupo(): void {
  const db = getConnection();
  const agora = '2026-09-01T12:00:00.000Z';
  const empresa = db.prepare(
    `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  empresa.run('oficina', 'oficina', 'Oficina Ltda', 'Oficina', agora, agora);
  empresa.run('loja', 'loja', 'Loja Ltda', 'Loja', agora, agora);
  const bancada = db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at) VALUES (?, ?, ?, ?, 'mobility', ?, ?)`,
  );
  bancada.run('b-ativa', 'oficina', 'b-ativa', 'Bancada ativa', 1, agora);
  bancada.run('b-desativada', 'oficina', 'b-desativada', 'Bancada desativada', 0, agora);
  bancada.run('b-outra', 'loja', 'b-outra', 'Bancada da loja', 1, agora);
  const usuario = db.prepare(
    `INSERT INTO core_users (id, login, display_name, password_hash, hash_algorithm, must_rehash, active, session_version, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'argon2id', 0, 1, 1, ?, ?)`,
  );
  const vinculo = db.prepare(
    `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at) VALUES (?, ?, 'oficina', ?, 1, ?)`,
  );
  const membro = db.prepare(
    `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at) VALUES (?, ?, ?, 'mecanico', ?)`,
  );
  const idDaBancada = { ativa: 'b-ativa', desativada: 'b-desativada', 'da-outra-empresa': 'b-outra' } as const;
  for (const p of PESSOAS) {
    usuario.run(`u-${p.login}`, p.login, p.login, agora, agora);
    vinculo.run(`v-${p.login}`, `u-${p.login}`, p.perfil, agora);
    for (const b of p.bancadas) membro.run(`m-${p.login}-${b}`, idDaBancada[b], `u-${p.login}`, agora);
  }
  // O dono também está na loja, com vínculo de administrador.
  db.prepare(
    `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at) VALUES ('v-admin-loja', 'u-admin', 'loja', 'admin_geral', 0, ?)`,
  ).run(agora);
}

function vinculos(): Record<string, { profile_code: string; all_terminals: number; all_workshops: number | null; access_version: number }> {
  const linhas = getConnection()
    .prepare(
      `SELECT u.login, uc.company_id, uc.profile_code, uc.all_terminals, uc.all_workshops, uc.access_version
         FROM core_user_companies uc JOIN core_users u ON u.id = uc.user_id`,
    )
    .all() as unknown as { login: string; company_id: string; profile_code: string; all_terminals: number; all_workshops: number | null; access_version: number }[];
  return Object.fromEntries(linhas.map((l) => [`${l.login}@${l.company_id}`, l]));
}

function conferirOPasso(): void {
  const v = vinculos();
  // Nenhum vínculo perdido, nenhum perfil trocado.
  expect(Object.keys(v)).toHaveLength(PESSOAS.length + 1);
  for (const p of PESSOAS) {
    const linha = v[`${p.login}@oficina`]!;
    expect(linha.profile_code, p.login).toBe(p.perfil);
    expect(linha.all_terminals, p.login).toBe(1);
    expect(linha.access_version, p.login).toBe(1);
    expect(linha.all_workshops, p.login).toBe(ESPERADO[p.login]);
  }
  expect(v['admin@loja']!.all_workshops).toBe(1);

  const trilha = getConnection()
    .prepare("SELECT company_id, detail FROM core_audit_log WHERE action = 'access.migrated' ORDER BY company_id")
    .all() as { company_id: string; detail: string }[];
  expect(trilha.map((t) => t.company_id)).toEqual(['loja', 'oficina']);
  expect(JSON.parse(trilha[1]!.detail)).toEqual({
    passo: 86,
    vinculos: PESSOAS.length,
    todosOsCaixas: PESSOAS.length,
    todasAsBancadas: 7,
    soAsBancadasDeQueEMembro: 2,
    nenhumaBancada: 2,
  });
}

describe('passo 86 — banco novo', () => {
  it('é o último passo, marca, e a DDL canônica já traz as colunas e as tabelas', () => {
    const { dir, path } = bancoTemporario();
    try {
      subir(path);
      migrateCoreSchema();
      expect(CORE_TARGET_VERSION).toBe(86);
      expect(meta('core_migration_step_86')).toBe('applied');
      expect(Number(meta('core_schema_version'))).toBe(86);
      const colunas = (getConnection().prepare('PRAGMA table_info(core_user_companies)').all() as { name: string }[]).map((c) => c.name);
      for (const c of COLUNAS_NOVAS) expect(colunas).toContain(c);
      for (const t of ['core_permission_templates', 'core_permission_template_capabilities', 'core_user_company_capabilities', 'core_user_company_terminals']) {
        expect(getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t).toBeDefined();
      }
    } finally {
      limpar(dir);
    }
  });
});

describe('passo 86 — o banco que vem de antes', () => {
  it('um banco na 85: nenhum vínculo perdido, bancadas preservadas pela regra (só as ATIVAS contam), trilha por empresa', () => {
    const { dir, path } = bancoTemporario();
    try {
      subir(path);
      migrateCoreSchema();
      voltarPara85();
      semearOGrupo();
      migrateCoreSchema();
      expect(meta('core_migration_step_86')).toBe('applied');
      conferirOPasso();
      // E o banco migrado é igual a um banco novo (schema-drift).
      const c = conferirEsquema(getConnection());
      expect(c.divergencias).toEqual([]);
    } finally {
      limpar(dir);
    }
  });

  it('um banco na 84 passa pela 85 e chega à 86 com o mesmo resultado', () => {
    const { dir, path } = bancoTemporario();
    try {
      subir(path);
      migrateCoreSchema();
      voltarPara84();
      semearOGrupo();
      const r = migrateCoreSchema();
      expect(r).toEqual({ from: 84, to: 86 });
      expect(meta('core_migration_step_85')).toBe('applied');
      expect(meta('core_migration_step_86')).toBe('applied');
      conferirOPasso();
    } finally {
      limpar(dir);
    }
  });

  it('subir de novo não refaz nada: nenhum valor muda, nenhuma trilha nova', () => {
    const { dir, path } = bancoTemporario();
    try {
      subir(path);
      migrateCoreSchema();
      voltarPara85();
      semearOGrupo();
      migrateCoreSchema();
      const antes = vinculos();
      // O dono escolhe "todas" para o mecânico sem bancada depois da migração:
      // a escolha dele sobrevive às subidas seguintes.
      getConnection().prepare("UPDATE core_user_companies SET all_workshops = 1 WHERE id = 'v-mecanico.sem.bancada'").run();
      subir(path);
      migrateCoreSchema();
      const depois = vinculos();
      expect(depois['mecanico.sem.bancada@oficina']!.all_workshops).toBe(1);
      delete (antes as Record<string, unknown>)['mecanico.sem.bancada@oficina'];
      delete (depois as Record<string, unknown>)['mecanico.sem.bancada@oficina'];
      expect(depois).toEqual(antes);
      expect(getConnection().prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'access.migrated'").get()).toEqual({ n: 2 });
    } finally {
      limpar(dir);
    }
  });
});
