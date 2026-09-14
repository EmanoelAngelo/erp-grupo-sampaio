/**
 * ============================================================================
 * O AMBIENTE DE CADA DOCUMENTO DF-e CHEGA AO BANCO QUE JÁ EXISTE — DFE-AMBIENTE
 * ============================================================================
 *
 * A Distribuição DF-e numera por ambiente, e `core_dfe_documents` passou a
 * guardar o ambiente de cada documento, com a unicidade (company_id,
 * environment, nsu). UNIQUE declarada na tabela não se troca com ALTER: o
 * banco da loja (versão 84) precisa da tabela RECONSTRUÍDA, com todas as
 * linhas, índices e chaves — inclusive `imported_note_id`.
 *
 * O ambiente das linhas antigas não foi gravado por ninguém. A regra do passo
 * 85, da prova mais forte para a mais fraca:
 *   1. chave do SIMULADOR → homologação (o simulador nunca responde por
 *      produção — `exigirAdapterDeVerdade`);
 *   2. nota COMPLETA com `<tpAmb>` no XML → o ambiente que a própria SEFAZ
 *      carimbou (1 produção, 2 homologação);
 *   3. o resto (resumo, que não traz tpAmb) → o ambiente fiscal ATUAL da
 *      empresa, que é o que a consulta usou (sem configuração: homologação).
 *
 * Casos:
 *   - banco da 84: o passo 85 reconstrói a tabela (e não o reparo do esquema
 *     depois dele), sem perder linha, rowid, índice nem vínculo com a nota;
 *   - banco criado pela DDL canônica anterior (85 sem a coluna): a mesma
 *     conversão acontece na subida, antes do reconcile;
 *   - banco com vínculo órfão (chaves estrangeiras desligadas um dia): o passo
 *     não reconstrói dentro da transação, e o reparo do esquema o faz depois,
 *     com as chaves desligadas — o ambiente já preenchido.
 *
 * ## Como fica vermelho
 *
 *  - sem a coluna e a troca de UNIQUE, a tabela continua (company_id, nsu);
 *  - sem o preenchimento, toda linha antiga vira homologação (o DEFAULT);
 *  - sem a reconstrução no passo, quem a faz é o reparo — e o caso da 84 cobra
 *    que o reparo não precisou mexer nesta tabela.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DEVORA_API_ENV = 'test';

const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { criarColecoesDeDocumentos } = await import('../src/db/database.js');
const { migrateCoreSchema, CORE_TARGET_VERSION } = await import('../src/db/core-migrations.js');
const { conferirEsquema } = await import('../src/db/derivaDoEsquema.js');
const { CHAVES_DFE_DO_SIMULADOR } = await import('../src/services/core/SefazTestAdapter.js');
const { CHAVES_DFE_DO_SIMULADOR_NA_MIGRACAO } = await import('../src/db/consolidacaoDaRemediacao.js');
const { consultarDistribuicao } = await import('../src/services/core/DfeDistribuicaoService.js');

/** A DDL de `core_dfe_documents` até a versão 84 (e na 85 antes desta correção). */
const DDL_ANTIGA = `CREATE TABLE core_dfe_documents (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     nsu               TEXT NOT NULL,
     schema_type       TEXT NOT NULL,
     access_key        TEXT,
     supplier_cnpj     TEXT,
     supplier_name     TEXT,
     total_cents       INTEGER,
     issued_at         TEXT,
     xml               TEXT,
     manifest_status   TEXT,
     manifest_protocol TEXT,
     manifested_at     TEXT,
     imported_note_id  TEXT REFERENCES core_inbound_notes(id),
     received_at       TEXT NOT NULL,
     UNIQUE (company_id, nsu)
   )`;

const COLUNAS_ANTIGAS = [
  'id', 'company_id', 'nsu', 'schema_type', 'access_key', 'supplier_cnpj', 'supplier_name', 'total_cents',
  'issued_at', 'xml', 'manifest_status', 'manifest_protocol', 'manifested_at', 'imported_note_id', 'received_at',
];

const AGORA = '2026-09-01T12:00:00.000Z';

function bancoPeloBoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-dfe-amb-'));
  const path = join(dir, 'core.db');
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  process.env.TEST_DATABASE_PATH = path;
  resetCoreSchemaCache();
  criarColecoesDeDocumentos(getConnection());
  ensureCoreSchema();
  migrateCoreSchema();
  return dir;
}

function subirDeNovo(): void {
  closeConnection();
  resetCoreSchemaCache();
  criarColecoesDeDocumentos(getConnection());
  ensureCoreSchema();
  migrateCoreSchema();
}

function apagar(dir: string): void {
  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária; o Windows às vezes segura o handle.
  }
}

function meta(db: DatabaseSync, chave: string): string | null {
  return (db.prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as { value?: string } | undefined)?.value ?? null;
}

function procNFe(accessKey: string, tpAmb: '1' | '2'): string {
  return (
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe>'
    + `<infNFe Id="NFe${accessKey}" versao="4.00"><ide><nNF>7</nNF><tpAmb>${tpAmb}</tpAmb></ide></infNFe>`
    + `</NFe><protNFe><infProt><tpAmb>${tpAmb}</tpAmb><chNFe>${accessKey}</chNFe></infProt></protNFe></nfeProc>`
  );
}

const K = (n: number) => `4326091420016600018755001${String(n).padStart(9, '0')}1${String(n).padStart(8, '0')}5`;

/**
 * O banco como a loja o tem: a tabela antiga, com linhas de duas empresas —
 * uma em PRODUÇÃO, outra sem configuração fiscal —, um documento amarrado a
 * uma nota do funil, a marca do ensaio do simulador e um índice a mais.
 */
function montarTabelaAntiga(db: DatabaseSync, opcoes: { voltarParaA84: boolean; notaOrfa?: boolean }): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DROP TABLE core_dfe_documents');
  db.exec(DDL_ANTIGA);
  db.exec('CREATE INDEX ix_dfe_documents_key ON core_dfe_documents (company_id, access_key)');
  db.exec('CREATE INDEX ix_dfe_teste_fornecedor ON core_dfe_documents (supplier_cnpj)');
  db.exec('PRAGMA foreign_keys = ON;');

  const empresa = db.prepare(
    `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  empresa.run('emp-producao', 'emp-producao', 'Producao Ltda', 'Producao', AGORA, AGORA);
  empresa.run('emp-sem-config', 'emp-sem-config', 'Sem Config Ltda', 'Sem Config', AGORA, AGORA);
  db.prepare(
    "INSERT INTO core_fiscal_configs (company_id, environment, updated_at) VALUES ('emp-producao', 'production', ?)",
  ).run(AGORA);
  db.prepare(
    `INSERT INTO core_inbound_notes (id, company_id, access_key, created_at)
     VALUES ('nota-1', 'emp-producao', ?, ?)`,
  ).run(K(2), AGORA);

  const doc = db.prepare(
    `INSERT INTO core_dfe_documents
       (id, company_id, nsu, schema_type, access_key, supplier_cnpj, supplier_name, total_cents, issued_at, xml,
        manifest_status, manifest_protocol, manifested_at, imported_note_id, received_at)
     VALUES (?, ?, ?, ?, ?, '14200166000187', ?, ?, '2026-08-20T09:00:00-03:00', ?, ?, ?, ?, ?, ?)`,
  );
  // Empresa em produção: um resumo (sem tpAmb), uma nota completa carimbada de
  // homologação e amarrada à nota do funil, e o ensaio do simulador.
  doc.run('d-resumo', 'emp-producao', '1', 'resNFe', K(1), 'Fornecedor A', 15000, `<resNFe><chNFe>${K(1)}</chNFe></resNFe>`,
    null, null, null, null, AGORA);
  doc.run('d-completa-hom', 'emp-producao', '2', 'procNFe', K(2), 'Fornecedor B', 25000, procNFe(K(2), '2'),
    'ciencia', '191260000000001', AGORA, 'nota-1', AGORA);
  doc.run('d-simulador', 'emp-producao', '3', 'resNFe', CHAVES_DFE_DO_SIMULADOR[0], 'Fornecedor Simulado 1', 15000,
    `<resNFe><chNFe>${CHAVES_DFE_DO_SIMULADOR[0]}</chNFe></resNFe>`, null, null, null, null, AGORA);
  // Empresa sem configuração fiscal: um resumo, e uma nota completa carimbada de produção.
  doc.run('d-sem-config', 'emp-sem-config', '1', 'resNFe', K(4), 'Fornecedor C', 1000, `<resNFe><chNFe>${K(4)}</chNFe></resNFe>`,
    null, null, null, null, AGORA);
  doc.run('d-completa-prod', 'emp-sem-config', '2', 'procNFe', K(5), 'Fornecedor D', 2000, procNFe(K(5), '1'),
    'confirmacao', '191260000000002', AGORA, null, AGORA);

  if (opcoes.notaOrfa) {
    // O vínculo com uma nota que não existe mais — só possível com as chaves desligadas um dia.
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare("UPDATE core_dfe_documents SET imported_note_id = 'nota-que-sumiu' WHERE id = 'd-sem-config'").run();
    db.exec('PRAGMA foreign_keys = ON;');
  }

  if (opcoes.voltarParaA84) {
    db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_85'").run();
    db.prepare("UPDATE core_meta SET value = '84' WHERE key = 'core_schema_version'").run();
  }
}

type Linha = Record<string, unknown>;

function linhasAntigas(db: DatabaseSync): Linha[] {
  return db
    .prepare(`SELECT rowid AS rid, ${COLUNAS_ANTIGAS.join(', ')} FROM core_dfe_documents ORDER BY id`)
    .all() as Linha[];
}

function ambientes(db: DatabaseSync): Record<string, string> {
  const linhas = db.prepare('SELECT id, environment FROM core_dfe_documents').all() as { id: string; environment: string }[];
  return Object.fromEntries(linhas.map((l) => [l.id, l.environment]));
}

function unicosDaTabela(db: DatabaseSync): string[] {
  const lista = db.prepare('PRAGMA index_list(core_dfe_documents)').all() as { name: string; origin: string }[];
  return lista
    .filter((i) => i.origin === 'u')
    .map((i) => (db.prepare(`PRAGMA index_info("${i.name}")`).all() as { name: string }[]).map((c) => c.name).join(', '));
}

function indicesExplicitos(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'core_dfe_documents' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string }[]
  ).map((i) => i.name);
}

const AMBIENTES_ESPERADOS = {
  'd-resumo': 'production',
  'd-completa-hom': 'homologation',
  'd-simulador': 'homologation',
  'd-sem-config': 'homologation',
  'd-completa-prod': 'production',
};

function conferirTabelaNova(
  db: DatabaseSync,
  antes: Linha[],
  indices: string[] = ['ix_dfe_documents_key', 'ix_dfe_teste_fornecedor'],
): void {
  // Todas as linhas, com os mesmos valores e o mesmo rowid.
  expect(linhasAntigas(db)).toEqual(antes);
  expect(ambientes(db)).toEqual(AMBIENTES_ESPERADOS);
  // A unicidade é por ambiente, e os índices da tabela voltaram.
  expect(unicosDaTabela(db)).toEqual(['company_id, environment, nsu']);
  expect(indicesExplicitos(db)).toEqual(indices);
  expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
  // A tabela é a do banco novo.
  expect(conferirEsquema(db).divergencias.filter((d) => d.tabela === 'core_dfe_documents')).toEqual([]);

  // E a produção grava o NSU 2 que a homologação já tem, sem ser engolida.
  const inserir = db.prepare(
    `INSERT OR IGNORE INTO core_dfe_documents (id, company_id, environment, nsu, schema_type, access_key, received_at)
     VALUES (?, 'emp-producao', ?, ?, 'resNFe', ?, ?)`,
  );
  expect(Number(inserir.run('d-prod-2', 'production', '2', K(8), AGORA).changes)).toBe(1);
  // No mesmo ambiente, o NSU continua único.
  expect(Number(inserir.run('d-prod-1-de-novo', 'production', '1', K(9), AGORA).changes)).toBe(0);
  // E um terceiro valor de ambiente não entra (INSERT puro: o OR IGNORE pularia o CHECK calado).
  expect(() =>
    db
      .prepare(
        `INSERT INTO core_dfe_documents (id, company_id, environment, nsu, schema_type, access_key, received_at)
         VALUES ('d-contingencia', 'emp-producao', 'contingencia', '7', 'resNFe', ?, ?)`,
      )
      .run(K(7), AGORA),
  ).toThrow(/CHECK/);
}

describe('DFE-AMBIENTE — o banco que vem da 84', () => {
  it('o passo 85 reconstrói core_dfe_documents com o ambiente de cada linha, sem perder linha, índice nem vínculo', () => {
    const dir = bancoPeloBoot();
    try {
      let db = getConnection();
      montarTabelaAntiga(db, { voltarParaA84: true });
      const antes = linhasAntigas(db);
      expect(antes).toHaveLength(5);
      expect(unicosDaTabela(db)).toEqual(['company_id, nsu']);

      subirDeNovo();
      db = getConnection();

      expect(Number(meta(db, 'core_schema_version'))).toBe(CORE_TARGET_VERSION);
      conferirTabelaNova(db, antes);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        (db.prepare("SELECT imported_note_id FROM core_dfe_documents WHERE id = 'd-completa-hom'").get() as {
          imported_note_id: string;
        }).imported_note_id,
      ).toBe('nota-1');

      // Foi o PASSO que reconstruiu (dentro da migração), e não o reparo do esquema depois.
      const resultado = JSON.parse(meta(db, 'consolidacao85:resultado')!) as { aplicados: string[]; pendencias: string[] };
      expect(resultado.aplicados.some((a) => a.startsWith('dfe_ambiente_por_documento:'))).toBe(true);
      expect(resultado.pendencias).toEqual([]);
      expect(meta(db, 'esquema:ultimo_reparo') ?? '').not.toContain('core_dfe_documents');

      // Rodar o passo de novo não muda nada (idempotente).
      const depois = db.prepare('SELECT rowid AS rid, * FROM core_dfe_documents ORDER BY id').all();
      db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_85'").run();
      db.prepare("UPDATE core_meta SET value = '84' WHERE key = 'core_schema_version'").run();
      subirDeNovo();
      db = getConnection();
      expect(db.prepare('SELECT rowid AS rid, * FROM core_dfe_documents ORDER BY id').all()).toEqual(depois);
    } finally {
      apagar(dir);
    }
  });
});

describe('DFE-AMBIENTE — o banco criado pela DDL canônica anterior (85 sem a coluna)', () => {
  it('a subida acrescenta o ambiente, preenche pela mesma regra e troca a unicidade', () => {
    const dir = bancoPeloBoot();
    try {
      let db = getConnection();
      montarTabelaAntiga(db, { voltarParaA84: false });
      expect(meta(db, 'core_migration_step_85')).toBe('applied');
      const antes = linhasAntigas(db);
      // A pendência que uma falha anterior do item teria deixado.
      db.prepare("INSERT INTO core_meta (key, value) VALUES ('consolidacao85:pendencia:dfe_ambiente_por_documento', '{}')").run();

      subirDeNovo();
      db = getConnection();

      conferirTabelaNova(db, antes);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // Resolvido, a pendência não fica acusando.
      expect(meta(db, 'consolidacao85:pendencia:dfe_ambiente_por_documento')).toBeNull();
    } finally {
      apagar(dir);
    }
  });
});

describe('DFE-AMBIENTE — as marcas do simulador e a recusa em voz alta', () => {
  it('as chaves do simulador que o passo reconhece são as que o simulador inventa', () => {
    expect(CHAVES_DFE_DO_SIMULADOR_NA_MIGRACAO).toEqual(CHAVES_DFE_DO_SIMULADOR);
  });

  it('com a tabela ainda na unicidade antiga (reconstrução adiada), a consulta desfaz o lote em vez de engolir a nota', async () => {
    const dir = bancoPeloBoot();
    try {
      const db = getConnection();
      // O estado de um reparo que não pôde reconstruir: a coluna existe, a UNIQUE é a antiga.
      montarTabelaAntiga(db, { voltarParaA84: false });
      db.exec("ALTER TABLE core_dfe_documents ADD COLUMN environment TEXT NOT NULL DEFAULT 'homologation'");
      db.prepare("UPDATE core_fiscal_configs SET cnpj = '11222333000181', uf = 'RS' WHERE company_id = 'emp-producao'").run();
      const antes = linhasAntigas(db);

      // A SEFAZ de produção entrega NSU 1..3 — os mesmos números que a homologação já ocupa.
      const sefazDeProducao = {
        isReal: true,
        name: 'sefaz-producao-dublada',
        distributionDFe: async () => ({
          cStat: '138',
          xMotivo: 'Documento localizado',
          ultNsu: 3,
          docs: [1, 2, 3].map((n) => ({
            nsu: String(n),
            schema: 'resNFe',
            xml: `<resNFe><chNFe>${K(30 + n)}</chNFe><xNome>Producao ${n}</xNome></resNFe>`,
          })),
        }),
      };

      await expect(
        consultarDistribuicao({ companyId: 'emp-producao', userId: 'u-1', adapter: sefazDeProducao as never }),
      ).rejects.toMatchObject({ code: 'CORE_DFE_ESQUEMA_PENDENTE' });

      // Nada gravado: a próxima consulta, depois do reparo, parte do mesmo cursor.
      expect(linhasAntigas(db)).toEqual(antes);
    } finally {
      apagar(dir);
    }
  });
});

describe('DFE-AMBIENTE — o banco com vínculo órfão', () => {
  it('o passo não reconstrói com a referência órfã dentro da transação; o reparo do esquema o faz, com o ambiente já preenchido', () => {
    const dir = bancoPeloBoot();
    try {
      let db = getConnection();
      montarTabelaAntiga(db, { voltarParaA84: true, notaOrfa: true });
      const antes = linhasAntigas(db);
      expect(db.prepare('PRAGMA foreign_key_check(core_dfe_documents)').all()).toHaveLength(1);

      subirDeNovo();
      db = getConnection();

      // O reparo do esquema (GAP-PRD-140) recria os índices CANÔNICOS da tabela; o
      // índice que só este banco tinha é o que o passo preserva no caminho sem órfã.
      conferirTabelaNova(db, antes, ['ix_dfe_documents_key']);
      // A órfã continua a mesma — nem apagada, nem "consertada" por palpite.
      expect(db.prepare('PRAGMA foreign_key_check(core_dfe_documents)').all()).toHaveLength(1);
      expect(meta(db, 'esquema:ultimo_reparo') ?? '').toContain('core_dfe_documents');
      const resultado = JSON.parse(meta(db, 'consolidacao85:resultado')!) as { pendencias: string[] };
      expect(resultado.pendencias).toEqual([]);
    } finally {
      apagar(dir);
    }
  });
});
