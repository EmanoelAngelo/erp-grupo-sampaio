/**
 * A PRONTIDÃO DIZ SE O BANCO É IGUAL A UM BANCO NOVO (GAP-PRD-140).
 *
 * O número da versão diz em que passo o banco está; a deriva diz se ele tem a
 * forma que os passos prometem. Aqui: banco novo = IDÊNTICO; um índice
 * apagado aparece pelo nome, sem derrubar o núcleo (a ficha é P3 e não
 * bloqueia); e a subida seguinte o repara, com o reparo registrado.
 */
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';
for (const flag of [
  'ASAAS_PRODUCTION_ENABLED',
  'NFE_PRODUCTION_ENABLED',
  'NFCE_PRODUCTION_ENABLED',
  'LOGISTICS_PRODUCTION_ENABLED',
  'PAYMENT_TERMINAL_PRODUCTION_ENABLED',
  'ECOMMERCE_PRODUCTION_ENABLED',
]) {
  process.env[flag] = 'false';
}

import { describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { issueSession } = await import('./helpers/sessao.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { migrateCoreSchema } = await import('../src/db/core-migrations.js');
const { getConnection } = await import('../src/db/sqlite.js');

const app = createApp();

function dono() {
  const t = issueSession({
    userId: 'dono-deriva',
    companyId: 'company-deriva',
    storeId: 'store-deriva',
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${t.accessToken}` };
}

interface Deriva {
  situacao: string;
  tabelasConferidas: number;
  indicesConferidos: number;
  divergencias: { objeto: string; descricao: string; reparo: string }[];
  comoResolver: string | null;
  ultimoReparo: { modo: string; reparados: string[]; pendentes: unknown[] } | null;
}

describe('GET /system/readiness mostra a deriva do esquema', () => {
  it('banco novo: IDÊNTICO; índice apagado: DIVERGE pelo nome, sem bloquear o núcleo; a subida seguinte repara', async () => {
    runMigrations();
    migrateCoreSchema();

    let res = await request(app).get('/api/v1/system/readiness').set(dono());
    expect(res.status).toBe(200);
    let deriva = res.body.schemaDrift as Deriva;
    expect(deriva.situacao).toBe('IDENTICO');
    expect(deriva.tabelasConferidas).toBeGreaterThan(100);
    expect(deriva.indicesConferidos).toBeGreaterThan(100);
    expect(deriva.comoResolver).toBeNull();
    const nucleo = res.body.coreStatus as string;

    getConnection().exec('DROP INDEX ix_fiscal_docs_order');
    res = await request(app).get('/api/v1/system/readiness').set(dono());
    deriva = res.body.schemaDrift as Deriva;
    expect(deriva.situacao).toBe('DIVERGE');
    const item = deriva.divergencias.find((d) => d.objeto === 'ix_fiscal_docs_order');
    expect(item?.reparo).toBe('criar_indice');
    expect(item?.descricao).toMatch(/falta neste banco/);
    expect(deriva.comoResolver).toMatch(/db:conferir-esquema -- --reparar/);
    // P3, não bloqueia: o núcleo continua como estava.
    expect(res.body.coreStatus).toBe(nucleo);

    // A subida seguinte: o índice volta, a cada subida (e não só uma vez).
    migrateCoreSchema();
    res = await request(app).get('/api/v1/system/readiness').set(dono());
    deriva = res.body.schemaDrift as Deriva;
    expect(deriva.situacao).toBe('IDENTICO');
    expect(deriva.ultimoReparo?.modo).toBe('boot');
    expect(deriva.ultimoReparo?.reparados.join(' ')).toMatch(/ix_fiscal_docs_order/);
    expect(deriva.ultimoReparo?.pendentes).toEqual([]);
  });
});
