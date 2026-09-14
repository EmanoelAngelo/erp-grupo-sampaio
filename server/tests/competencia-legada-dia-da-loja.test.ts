/**
 * A COMPETÊNCIA LEGADA NO DIA DE GREENWICH (GAP-PRD-142).
 *
 * O banco da loja tem três lançamentos automáticos cuja competência é o dia UTC
 * do carimbo: 372eca4c (2026-08-13T00:59:11Z = 21h59 de 12/08 em Pelotas,
 * R$ 50,00), 01fa3166 (2026-08-13T02:25:59Z = 23h25 de 12/08, R$ 269,70) e um
 * pedido online de 2026-08-16T02:50:46Z. O DRE por competência os contava no
 * dia seguinte ao do relatório de vendas.
 *
 * Cada caso cai quando o guarda correspondente sai:
 *   - sem a correção no passo 85, as duas linhas da ficha continuam em 13/08;
 *   - sem o critério de "ninguém mexeu", a linha baixada por gente, a linha com
 *     trilha e a digitada à mão mudariam junto;
 *   - sem a regra do vencimento, o vencimento do cartão (em trinta dias) seria
 *     arrastado para 12/08;
 *   - com `substr(created_at, 1, 10)` de volta nas migrações antigas, o banco
 *     restaurado de cópia anterior recriaria o desvio.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { migrateCoreSchema, rebuildFinanceEntriesForTests } = await import('../src/db/core-migrations.js');
const { CHAVE_DA_COMPETENCIA_LEGADA, corrigirCompetenciaLegada } = await import(
  '../src/db/consolidacaoDaRemediacao.js'
);

function bancoTemporario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-competencia-'));
  const path = join(dir, 'core.db');
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  process.env.TEST_DATABASE_PATH = path;
  resetCoreSchemaCache();
  ensureCoreSchema();
  migrateCoreSchema();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
       VALUES ('empresa-1', 'empresa-1', 'Empresa Um Ltda', 'Empresa Um', 1, ?, ?)`,
    )
    .run(agora, agora);
  return dir;
}

function limpar(dir: string): void {
  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária; o Windows às vezes segura o handle.
  }
}

interface Lancamento {
  id: string;
  origem: string;
  criadoEm: string;
  competencia: string | null;
  vencimento: string | null;
  quitadoEm?: string | null;
  status?: string;
  valor?: number;
}

function lancar(l: Lancamento): void {
  const valor = l.valor ?? 1000;
  const quitado = l.status === 'settled';
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at, settled_cents,
          description, origin_type, origin_id, competence_date, created_at)
       VALUES (?, 'empresa-1', 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      l.id,
      valor,
      l.status ?? 'open',
      l.vencimento,
      l.quitadoEm ?? null,
      quitado ? valor : 0,
      `Lançamento ${l.id}`,
      l.origem,
      `origem-${l.id}`,
      l.competencia,
      l.criadoEm,
    );
}

function datas(id: string): { competencia: string | null; vencimento: string | null } {
  const r = getConnection()
    .prepare('SELECT competence_date AS c, due_date AS v FROM core_finance_entries WHERE id = ?')
    .get(id) as { c: string | null; v: string | null };
  return { competencia: r.c, vencimento: r.v };
}

/** As linhas da ficha, e as que NÃO podem mudar. */
function semearOCenario(): void {
  // As duas linhas da ficha: venda à vista, quitada no instante em que nasceu.
  lancar({ id: 'venda-2159', origem: 'sale', criadoEm: '2026-08-13T00:59:11.616Z', competencia: '2026-08-13',
    vencimento: '2026-08-13', status: 'settled', quitadoEm: '2026-08-13T00:59:11.616Z', valor: 5000 });
  lancar({ id: 'venda-2325', origem: 'sale', criadoEm: '2026-08-13T02:25:59.783Z', competencia: '2026-08-13',
    vencimento: '2026-08-13', status: 'settled', quitadoEm: '2026-08-13T02:25:59.783Z', valor: 26970 });
  // Pedido online das 23h50 de 15/08.
  lancar({ id: 'pedido-2350', origem: 'ecommerce_order', criadoEm: '2026-08-16T02:50:46.763Z', competencia: '2026-08-16',
    vencimento: '2026-08-16', status: 'settled', quitadoEm: '2026-08-16T02:50:46.763Z', valor: 32900 });
  // Cartão: vence em trinta dias. A competência corrige; o vencimento é outra data e fica.
  lancar({ id: 'cartao-2200', origem: 'sale', criadoEm: '2026-08-13T01:00:00.000Z', competencia: '2026-08-13',
    vencimento: '2026-09-12' });

  // O QUE NÃO PODE MUDAR.
  // Baixada por gente depois (há linha de baixa).
  lancar({ id: 'baixada-por-gente', origem: 'sale', criadoEm: '2026-08-13T01:30:00.000Z', competencia: '2026-08-13',
    vencimento: '2026-08-13' });
  getConnection()
    .prepare(
      `INSERT INTO core_finance_settlements (id, entry_id, company_id, amount_cents, method, settled_at, user_id, note)
       VALUES ('baixa-1', 'baixada-por-gente', 'empresa-1', 500, 'pix', '2026-08-20T13:00:00.000Z', NULL, 'baixa no balcão')`,
    )
    .run();
  // Editada por gente: a linha tem trilha de auditoria.
  lancar({ id: 'editada-por-gente', origem: 'nfe_entrada', criadoEm: '2026-08-13T01:40:00.000Z', competencia: '2026-08-13',
    vencimento: '2026-08-13' });
  getConnection()
    .prepare(
      `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
       VALUES ('trilha-1', 'empresa-1', NULL, 'finance.charge_created', 'finance_entry', 'editada-por-gente', '{}', NULL,
               '2026-08-14T12:00:00.000Z')`,
    )
    .run();
  // Quitada DEPOIS de nascer (não é a quitação automática do balcão).
  lancar({ id: 'quitada-depois', origem: 'sale_return', criadoEm: '2026-08-13T01:50:00.000Z', competencia: '2026-08-13',
    vencimento: '2026-08-13', status: 'settled', quitadoEm: '2026-08-15T10:00:00.000Z' });
  // Digitada à mão: a data é a que a pessoa escolheu.
  lancar({ id: 'digitada', origem: 'manual', criadoEm: '2026-08-13T00:30:00.000Z', competencia: '2026-08-13',
    vencimento: '2026-08-13' });
  // À tarde: o dia UTC e o da loja são o mesmo.
  lancar({ id: 'a-tarde', origem: 'sale', criadoEm: '2026-08-13T15:00:00.000Z', competencia: '2026-08-13',
    vencimento: '2026-08-13' });
}

describe('GAP-PRD-142 — a competência legada vai para o dia da loja', () => {
  it('o passo 85 corrige as linhas da ficha, e só elas', () => {
    const dir = bancoTemporario();
    try {
      semearOCenario();

      // Ensaio: lista sem mudar nada.
      const ensaio = corrigirCompetenciaLegada(getConnection(), { aplicar: false }).linhas;
      expect(ensaio.map((l) => l.id).sort()).toEqual(['cartao-2200', 'pedido-2350', 'venda-2159', 'venda-2325']);
      expect(datas('venda-2159').competencia).toBe('2026-08-13');

      // O passo 85 roda de novo (a marca sai), como num banco que ainda não o tem.
      getConnection().exec("DELETE FROM core_meta WHERE key = 'core_migration_step_85'");
      migrateCoreSchema();

      // As duas linhas da ficha: 21h59 e 23h25 de 12/08 em Pelotas.
      expect(datas('venda-2159')).toEqual({ competencia: '2026-08-12', vencimento: '2026-08-12' });
      expect(datas('venda-2325')).toEqual({ competencia: '2026-08-12', vencimento: '2026-08-12' });
      expect(datas('pedido-2350')).toEqual({ competencia: '2026-08-15', vencimento: '2026-08-15' });
      // O vencimento só vai junto quando era igual à competência antiga.
      expect(datas('cartao-2200')).toEqual({ competencia: '2026-08-12', vencimento: '2026-09-12' });

      // Nada que alguém tocou, nada digitado, nada fora da janela.
      for (const id of ['baixada-por-gente', 'editada-por-gente', 'quitada-depois', 'digitada', 'a-tarde']) {
        expect(datas(id), id).toEqual({ competencia: '2026-08-13', vencimento: '2026-08-13' });
      }

      // Quantas linhas mudaram, em core_meta e na trilha, com o antes e o depois.
      const meta = JSON.parse(
        (getConnection().prepare('SELECT value FROM core_meta WHERE key = ?').get(CHAVE_DA_COMPETENCIA_LEGADA) as {
          value: string;
        }).value,
      ) as { linhas: number; porEmpresa: Record<string, number>; ids: string[] };
      expect(meta.linhas).toBe(4);
      expect(meta.porEmpresa).toEqual({ 'empresa-1': 4 });
      const trilha = getConnection()
        .prepare(
          `SELECT entity_id, detail FROM core_audit_log
            WHERE action = 'finance.entry_competence_corrected' ORDER BY entity_id`,
        )
        .all() as unknown as { entity_id: string; detail: string }[];
      expect(trilha.map((t) => t.entity_id)).toEqual(['cartao-2200', 'pedido-2350', 'venda-2159', 'venda-2325']);
      const daFicha = JSON.parse(trilha.find((t) => t.entity_id === 'venda-2159')!.detail) as {
        antes: { competenceDate: string; dueDate: string };
        depois: { competenceDate: string; dueDate: string };
      };
      expect(daFicha.antes).toEqual({ competenceDate: '2026-08-13', dueDate: '2026-08-13' });
      expect(daFicha.depois).toEqual({ competenceDate: '2026-08-12', dueDate: '2026-08-12' });
      const resultado = JSON.parse(
        (getConnection().prepare("SELECT value FROM core_meta WHERE key = 'consolidacao85:resultado'").get() as {
          value: string;
        }).value,
      ) as { aplicados: string[] };
      expect(resultado.aplicados).toContain('fin_competencia_legada_no_dia_da_loja:4');

      // Idempotente: rodar de novo não acha mais nada.
      expect(corrigirCompetenciaLegada(getConnection()).linhas).toEqual([]);
    } finally {
      limpar(dir);
    }
  });

  it('a reconstrução do razão e o passo 56 preenchem a competência pelo dia da loja', () => {
    const dir = bancoTemporario();
    try {
      const db = getConnection();

      // Passo 56 num banco que ainda não o tinha: competência e vencimento nulos.
      lancar({ id: 'sem-competencia', origem: 'sale', criadoEm: '2026-08-13T00:59:11.616Z', competencia: null,
        vencimento: null });
      db.exec("DELETE FROM core_meta WHERE key = 'core_migration_step_56'");
      migrateCoreSchema();
      expect(datas('sem-competencia').competencia).toBe('2026-08-12');

      // A reconstrução, num razão de antes da coluna de competência.
      db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE core_finance_entries;
        CREATE TABLE core_finance_entries (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL, direction TEXT NOT NULL,
          amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', due_date TEXT,
          settled_at TEXT, settled_cents INTEGER NOT NULL DEFAULT 0, customer_id TEXT, supplier_id TEXT,
          description TEXT NOT NULL, origin_type TEXT NOT NULL, origin_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (origin_type, origin_id, direction)
        );
        INSERT INTO core_finance_entries (id, company_id, direction, amount_cents, description, origin_type, origin_id, created_at)
        VALUES ('antigo', 'empresa-1', 'in', 5000, 'Venda antiga', 'sale', 'v-antiga', '2026-08-13T00:59:11.616Z');
        PRAGMA foreign_keys = ON;
      `);
      rebuildFinanceEntriesForTests();
      expect(datas('antigo').competencia).toBe('2026-08-12');
    } finally {
      limpar(dir);
    }
  });

  it('as migrações antigas não cortam mais a competência pelo dia de Greenwich', () => {
    const fonte = readFileSync(new URL('../src/db/core-migrations.ts', import.meta.url), 'utf8');
    expect(fonte).not.toMatch(/selecao\.push\('substr\(created_at, 1, 10\)'\)/);
    expect(fonte).not.toMatch(/COALESCE\(due_date, substr\(created_at, 1, 10\)\)/);
    expect(fonte).toMatch(/selecao\.push\(diaDaLojaSql\('created_at'\)\)/);
  });
});
