/**
 * ============================================================================
 * UM ÍNDICE POR PERGUNTA (GAP-PRD-144)
 * ============================================================================
 *
 * A DDL canônica criava `ix_stock_movements_product` e `ix_stock_mov_product`,
 * os dois em `core_stock_movements (company_id, product_id, created_at)`: a
 * tabela mais quente do sistema (o razão de estoque) pagava duas escritas de
 * índice por movimento, sem ganho nenhum de leitura.
 *
 * O que este arquivo cobra, num banco novo levado até o alvo como o boot faz:
 *
 *   1. nenhuma tabela tem dois índices com a mesma definição (mesmas colunas
 *      na mesma ordem, mesma unicidade, mesmo filtro parcial);
 *   2. o índice duplicado não nasce mais, e o que fica cobre a mesma pergunta.
 *
 * No banco que já existe, o `DROP INDEX` vai no passo de consolidação
 * (docs/audits/remediacao/migracoes/DEP.md): o boot não derruba índice.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { migrateCoreSchema } from '../src/db/core-migrations.js';
import { getConnection } from '../src/db/sqlite.js';

interface Indice {
  tabela: string;
  nome: string;
  assinatura: string;
}

function indicesDoBanco(): Indice[] {
  const db = getConnection();
  const linhas = db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master
        WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'`,
    )
    .all() as Array<{ name: string; tbl_name: string; sql: string | null }>;

  return linhas.map((l) => {
    const colunas = (
      db.prepare(`PRAGMA index_xinfo("${l.name.replace(/"/g, '""')}")`).all() as Array<{
        seqno: number;
        name: string | null;
        desc: number;
        key: number;
      }>
    )
      .filter((c) => c.key === 1)
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => `${c.name ?? '<expr>'}${c.desc ? ' DESC' : ''}`);
    const sql = (l.sql ?? '').replace(/\s+/g, ' ');
    const unico = /CREATE\s+UNIQUE\s+INDEX/i.test(sql);
    const onde = /\sWHERE\s(.*)$/i.exec(sql)?.[1]?.trim().toLowerCase() ?? '';
    // Índice de expressão: a coluna vem nula; a expressão está no SQL.
    const expressao = colunas.includes('<expr>') ? (/\((.*)\)/.exec(sql)?.[1] ?? '') : '';
    return {
      tabela: l.tbl_name,
      nome: l.name,
      assinatura: [unico ? 'UNIQUE' : 'INDEX', colunas.join(','), expressao, onde].join(' | '),
    };
  });
}

beforeAll(() => {
  resetDbForTests();
  ensureCoreSchema();
  migrateCoreSchema();
});

describe('um índice por pergunta', () => {
  it('nenhuma tabela tem dois índices com a mesma definição', () => {
    const porAssinatura = new Map<string, string[]>();
    for (const i of indicesDoBanco()) {
      const chave = `${i.tabela} :: ${i.assinatura}`;
      porAssinatura.set(chave, [...(porAssinatura.get(chave) ?? []), i.nome]);
    }
    const duplicados = [...porAssinatura.entries()]
      .filter(([, nomes]) => nomes.length > 1)
      .map(([chave, nomes]) => `${chave} → ${nomes.join(' e ')}`);
    expect(duplicados).toEqual([]);
  });

  it('o razão de estoque tem um índice por (empresa, produto, data) — e não dois', () => {
    const nomes = indicesDoBanco()
      .filter((i) => i.tabela === 'core_stock_movements')
      .map((i) => i.nome);
    expect(nomes).toContain('ix_stock_movements_product');
    expect(nomes).not.toContain('ix_stock_mov_product');
  });
});
