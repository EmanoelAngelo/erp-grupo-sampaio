/**
 * A EXCLUSÃO DE PRODUTO CONHECE CADA TABELA QUE APONTA PARA ELE.
 *
 * `excluirProduto` decide "tem histórico?" por uma LISTA escrita à mão, e não
 * pela FK: as NO ACTION bloqueariam sozinhas, mas as CASCADE que são histórico
 * (o razão de estoque, as unidades serializadas, os lotes) seriam apagadas em
 * silêncio. A lista é a regra — e lista escrita à mão envelhece.
 *
 * Este arquivo impede o envelhecimento: toda FK para `core_products` que o
 * esquema canônico declara tem de estar classificada (histórico, limpeza ou
 * variante). A próxima tabela que referenciar produto derruba este caso até
 * alguém decidir, por escrito, se ela prende o produto ou sai junto com ele.
 */
import { describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { REFERENCIAS_AO_PRODUTO } from '../src/services/core/ProductDeletionService.js';

function fksParaProduto(): string[] {
  resetDbForTests();
  ensureCoreSchema();
  const db = getConnection();
  const tabelas = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const fks: string[] = [];
  for (const { name } of tabelas) {
    const lista = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {
      table: string;
      from: string;
    }[];
    for (const fk of lista) if (fk.table === 'core_products') fks.push(`${name}.${fk.from}`);
  }
  return fks.sort();
}

describe('a lista da exclusão cobre o esquema inteiro', () => {
  it('toda FK para core_products está classificada', () => {
    const classificadas = new Set(REFERENCIAS_AO_PRODUTO.map((r) => `${r.tabela}.${r.coluna}`));
    const fks = fksParaProduto();
    // O esquema de hoje tem trinta; se o regex da leitura quebrar, a lista vazia
    // passaria "classificada" por acidente.
    expect(fks.length).toBeGreaterThanOrEqual(30);
    expect(fks.filter((fk) => !classificadas.has(fk))).toEqual([]);
  });

  it('toda referência classificada existe de verdade (tabela e coluna)', () => {
    resetDbForTests();
    ensureCoreSchema();
    const db = getConnection();
    for (const r of REFERENCIAS_AO_PRODUTO) {
      const colunas = db.prepare(`PRAGMA table_info("${r.tabela}")`).all() as { name: string }[];
      expect(
        colunas.some((c) => c.name === r.coluna),
        `${r.tabela}.${r.coluna} não existe`,
      ).toBe(true);
    }
  });

  it('o razão, as unidades, os lotes e a venda são HISTÓRICO — nunca limpeza', () => {
    const destino = (tabela: string, coluna = 'product_id') =>
      REFERENCIAS_AO_PRODUTO.find((r) => r.tabela === tabela && r.coluna === coluna)?.destino;
    for (const tabela of [
      'core_stock_movements',
      'core_product_units',
      'core_product_batches',
      'core_sale_items',
      'core_order_items',
      'core_inbound_note_items',
      'core_service_order_parts',
      'core_product_fiscal_suggestions',
      'core_product_reviews',
    ]) {
      expect(destino(tabela), tabela).toBe('historico');
    }
    expect(destino('core_kit_components', 'component_id')).toBe('historico');
    expect(destino('core_equipment', 'linked_product_id')).toBe('historico');
    // E os que a missão manda limpar.
    for (const tabela of [
      'core_product_barcodes',
      'core_product_images',
      'core_price_table_items',
      'core_product_price_tiers',
      'core_promotions',
      'core_supplier_item_codes',
      'core_customer_cart_items',
    ]) {
      expect(destino(tabela), tabela).toBe('limpeza');
    }
    expect(destino('core_custom_field_values', 'entity_id')).toBe('limpeza');
    expect(destino('core_products', 'parent_id')).toBe('variante');
  });

  it('todo histórico tem nome para a pessoa ler na recusa', () => {
    for (const r of REFERENCIAS_AO_PRODUTO.filter((x) => x.destino === 'historico')) {
      expect(r.codigo, `${r.tabela}.${r.coluna}`).toMatch(/^[a-z_]+$/);
      expect(r.rotulo?.[0], `${r.tabela}.${r.coluna}`).toBeTruthy();
      expect(r.rotulo?.[1], `${r.tabela}.${r.coluna}`).toBeTruthy();
    }
  });
});
