/**
 * ============================================================================
 * T10 — A SUBIDA SEMEIA OS MODELOS DE SISTEMA SEM ATROPELAR O DONO
 * ============================================================================
 *
 * `ensurePermissionTemplates()` roda em `prepararBanco` — a cada subida e a
 * cada `db:migrate`, como as bancadas oficiais (desenho §3.2):
 *
 *   - modelo que não existe nasce com as capabilities do código;
 *   - o de catálogo inteiro (Administrador e Gestor do grupo) é forçado ao
 *     catálogo inteiro SEMPRE;
 *   - o de sistema que o dono não editou acompanha o código (capability nova
 *     chega ao Gerente de Loja de toda instalação);
 *   - o que o dono editou NÃO é tocado — as novidades do catálogo ficam
 *     oferecidas, não impostas;
 *   - o do dono nunca é tocado;
 *   - capability que saiu do catálogo sai dos modelos e dos vínculos, com trilha.
 *
 * E sem a linha no banco (o banco que os testes truncam), o código responde:
 * é isso que mantém verdes os arquivos que provisionam por `profile_code`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKUPS = mkdtempSync(join(tmpdir(), 'gs-rbac-semeadura-backup-'));
process.env.DEVORA_BACKUP_DIR = BACKUPS;

const { afterAll, beforeEach, describe, expect, it } = await import('vitest');
const { criarColecoesDeDocumentos, resetDbForTests } = await import('../../src/db/database.js');
const { closeConnection, getConnection } = await import('../../src/db/sqlite.js');
const { resetCoreSchemaCache } = await import('../../src/db/schema.js');
const { prepararBanco } = await import('../../src/db/migracaoCompleta.js');
const { linkUserToCompany, upsertCompany, upsertUser } = await import('../../src/services/auth/IdentityService.js');
const { editarModelo, ensurePermissionTemplates, novidadesDoModelo } = await import('../../src/services/auth/AcessoService.js');
const { acessoDoVinculo } = await import('../../src/services/auth/AcessoEfetivo.js');
const { CAPABILITIES, CATALOG_VERSION, MODELOS_DE_SISTEMA } = await import('../../src/services/auth/Capabilities.js');

afterAll(() => {
  try {
    rmSync(BACKUPS, { recursive: true, force: true });
  } catch {
    // Pasta temporária.
  }
});

interface LinhaDoModelo {
  id: string;
  code: string;
  name: string;
  origin: string;
  full_catalog: number;
  owner_edited: number;
  seeded_catalog_version: number | null;
  version: number;
  assignable_by: string;
  default_workshops: string;
  hidden: number;
}

const db = () => getConnection();
const modelo = (code: string) =>
  db().prepare('SELECT * FROM core_permission_templates WHERE code = ?').get(code) as LinhaDoModelo | undefined;
const capsDoModelo = (code: string) =>
  (db()
    .prepare(
      `SELECT tc.capability FROM core_permission_template_capabilities tc
         JOIN core_permission_templates t ON t.id = tc.template_id
        WHERE t.code = ? ORDER BY tc.capability`,
    )
    .all(code) as { capability: string }[]).map((r) => r.capability);
const trilha = (acao: string) =>
  db().prepare('SELECT entity_id, detail FROM core_audit_log WHERE action = ? ORDER BY created_at').all(acao) as {
    entity_id: string | null;
    detail: string | null;
  }[];

beforeEach(() => {
  resetDbForTests();
});

describe('T10 — a semeadura', () => {
  it('banco sem modelos: nasce um por modelo de sistema, com as capabilities e os atributos do código', () => {
    const r = ensurePermissionTemplates();
    expect(r.inseridos.sort()).toEqual(Object.keys(MODELOS_DE_SISTEMA).sort());
    for (const [code, m] of Object.entries(MODELOS_DE_SISTEMA)) {
      const linha = modelo(code)!;
      expect(linha.origin, code).toBe('sistema');
      expect(linha.name, code).toBe(m.nome);
      expect(linha.full_catalog, code).toBe(m.fullCatalog ? 1 : 0);
      expect(linha.assignable_by, code).toBe(m.assignableBy);
      expect(linha.default_workshops, code).toBe(m.defaultWorkshops);
      expect(linha.hidden, code).toBe(m.hidden ? 1 : 0);
      expect(linha.owner_edited, code).toBe(0);
      expect(linha.seeded_catalog_version, code).toBe(CATALOG_VERSION);
      expect(linha.version, code).toBe(1);
      expect(capsDoModelo(code), code).toEqual([...m.capabilities].sort());
    }
    expect(trilha('template.seeded')).toHaveLength(Object.keys(MODELOS_DE_SISTEMA).length);
  });

  it('rodar de novo não muda nada: nenhuma versão sobe, nenhuma trilha nova', () => {
    ensurePermissionTemplates();
    const antes = db().prepare('SELECT code, version FROM core_permission_templates ORDER BY code').all();
    const trilhaAntes = (db().prepare('SELECT COUNT(*) AS n FROM core_audit_log').get() as { n: number }).n;
    const r = ensurePermissionTemplates();
    expect(r).toMatchObject({ inseridos: [], sincronizados: [] });
    expect(db().prepare('SELECT code, version FROM core_permission_templates ORDER BY code').all()).toEqual(antes);
    expect((db().prepare('SELECT COUNT(*) AS n FROM core_audit_log').get() as { n: number }).n).toBe(trilhaAntes);
  });

  it('capability que falta num modelo de sistema NÃO editado volta na subida, e a versão sobe', () => {
    ensurePermissionTemplates();
    const estoquista = modelo('estoquista')!;
    db().prepare("DELETE FROM core_permission_template_capabilities WHERE template_id = ? AND capability = 'inventory.view'").run(estoquista.id);
    const r = ensurePermissionTemplates();
    expect(r.sincronizados).toEqual(['estoquista']);
    expect(capsDoModelo('estoquista')).toContain('inventory.view');
    expect(modelo('estoquista')!.version).toBe(2);
    const sync = trilha('template.system_synced');
    expect(sync).toHaveLength(1);
    expect(JSON.parse(sync[0]!.detail!)).toMatchObject({ modelo: 'estoquista', adicionadas: ['inventory.view'], removidas: [] });
  });

  it('modelo editado pelo dono NÃO é sobrescrito, e as novidades do catálogo ficam oferecidas', () => {
    ensurePermissionTemplates();
    const semEstoque = MODELOS_DE_SISTEMA.estoquista!.capabilities.filter((c) => c !== 'inventory.view');
    editarModelo({ atorId: 'dono', codigo: 'estoquista', capabilities: semEstoque });
    expect(modelo('estoquista')!.owner_edited).toBe(1);

    ensurePermissionTemplates();
    expect(capsDoModelo('estoquista')).not.toContain('inventory.view');
    expect(novidadesDoModelo('estoquista')).toEqual([]);

    // Uma instalação semeada numa versão anterior do catálogo: o que entrou
    // depois dela, com padrão neste modelo, e que ele não tem, é novidade.
    db().prepare("UPDATE core_permission_templates SET seeded_catalog_version = 0 WHERE code = 'estoquista'").run();
    expect(novidadesDoModelo('estoquista')).toEqual(['inventory.view']);
  });

  it('o Administrador do grupo tem SEMPRE o catálogo inteiro — a subida conserta o que faltar e o que sobrar', () => {
    ensurePermissionTemplates();
    const admin = modelo('admin_geral')!;
    db().prepare("DELETE FROM core_permission_template_capabilities WHERE template_id = ? AND capability LIKE 'finance.%'").run(admin.id);
    db().prepare("INSERT INTO core_permission_template_capabilities (template_id, capability) VALUES (?, 'x.removida')").run(admin.id);
    ensurePermissionTemplates();
    expect(capsDoModelo('admin_geral')).toEqual([...CAPABILITIES].sort());
    expect(capsDoModelo('gestor')).toEqual([...CAPABILITIES].sort());
  });

  it('modelo do DONO nunca é sincronizado — mas capability que saiu do catálogo sai dele e dos vínculos, com trilha', async () => {
    ensurePermissionTemplates();
    const empresa = upsertCompany({ slug: 'loja-semeadura', legalName: 'Loja Ltda', tradeName: 'Loja' });
    const agora = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO core_permission_templates (id, code, name, origin, created_at, updated_at)
         VALUES ('dono-1', 'dono-caixa-e-painel', 'Caixa e painel', 'dono', ?, ?)`,
      )
      .run(agora, agora);
    const inserirCap = db().prepare('INSERT INTO core_permission_template_capabilities (template_id, capability) VALUES (?, ?)');
    inserirCap.run('dono-1', 'dashboard.view');
    inserirCap.run('dono-1', 'x.aposentada');
    const pessoa = await upsertUser({ login: 'PESSOA.SEMEADURA', displayName: 'Pessoa', password: 'Senha@Semeadura2026' });
    linkUserToCompany(pessoa, empresa, 'dono-caixa-e-painel', true);
    const vinculo = (db().prepare('SELECT id FROM core_user_companies WHERE user_id = ?').get(pessoa) as { id: string }).id;
    db()
      .prepare("INSERT INTO core_user_company_capabilities (user_company_id, capability, effect, granted_at) VALUES (?, 'x.aposentada', 'grant', ?)")
      .run(vinculo, agora);

    const r = ensurePermissionTemplates();
    expect(r.sincronizados).toEqual([]);
    expect(capsDoModelo('dono-caixa-e-painel')).toEqual(['dashboard.view']);
    expect(db().prepare('SELECT COUNT(*) AS n FROM core_user_company_capabilities').get()).toEqual({ n: 0 });
    expect(trilha('template.capability_removed').map((t) => JSON.parse(t.detail!))).toEqual([
      expect.objectContaining({ modelo: 'dono-caixa-e-painel', removidas: ['x.aposentada'] }),
    ]);
    expect(trilha('access.capability_removed')).toHaveLength(1);
  });
});

describe('a resolução: o banco quando há modelo, o código quando não há', () => {
  it('banco truncado, sem modelo nenhum: MODELOS_DE_SISTEMA responde, e código desconhecido é vazio', async () => {
    const empresa = upsertCompany({ slug: 'loja-resolucao', legalName: 'Loja Ltda', tradeName: 'Loja' });
    const casos: [string, number][] = [['gerente_loja', 107], ['admin_geral', CAPABILITIES.length], ['contador', 1], ['perfil_inventado', 0]];
    for (const [perfil, n] of casos) {
      const id = await upsertUser({ login: `R.${perfil}`, displayName: perfil, password: 'Senha@Resolucao2026' });
      linkUserToCompany(id, empresa, perfil, true);
      expect(acessoDoVinculo(id, empresa)!.capabilities.size, perfil).toBe(n);
    }
    expect(db().prepare('SELECT COUNT(*) AS n FROM core_permission_templates').get()).toEqual({ n: 0 });
  });

  it('com o modelo no banco, é o banco que vale — editar muda o acesso de quem o usa', async () => {
    const empresa = upsertCompany({ slug: 'loja-resolucao-2', legalName: 'Loja Ltda', tradeName: 'Loja' });
    const id = await upsertUser({ login: 'R.ATENDENTE', displayName: 'Atendente', password: 'Senha@Resolucao2026' });
    linkUserToCompany(id, empresa, 'atendente', true);
    ensurePermissionTemplates();
    editarModelo({ atorId: null, codigo: 'atendente', capabilities: ['customers.view'] });
    expect([...acessoDoVinculo(id, empresa)!.capabilities]).toEqual(['customers.view']);
  });
});

describe('prepararBanco semeia — e duas subidas seguidas são idempotentes', () => {
  it('a porta da subida e do db:migrate chama ensurePermissionTemplates depois das bancadas oficiais', () => {
    const fonte = readFileSync(new URL('../../src/db/migracaoCompleta.ts', import.meta.url), 'utf8');
    const corpo = fonte.slice(fonte.indexOf('export function prepararBanco'), fonte.indexOf('function linhaDeVersoes'));
    expect(corpo.indexOf('ensurePermissionTemplates()')).toBeGreaterThan(corpo.indexOf('ensureOfficialTagCompanies()'));
  });

  it('banco novo: duas subidas, dezoito modelos, versões intactas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-rbac-semeadura-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    process.env.TEST_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    // `ensureSchema` (documentos) é memorizado por processo: o banco novo
    // precisa das coleções criadas nele, como a subida real faria.
    criarColecoesDeDocumentos(getConnection());
    try {
      prepararBanco();
      const primeira = db().prepare('SELECT code, version FROM core_permission_templates ORDER BY code').all();
      expect(primeira).toHaveLength(Object.keys(MODELOS_DE_SISTEMA).length);
      prepararBanco();
      expect(db().prepare('SELECT code, version FROM core_permission_templates ORDER BY code').all()).toEqual(primeira);
    } finally {
      closeConnection();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Pasta temporária.
      }
    }
  });
});
