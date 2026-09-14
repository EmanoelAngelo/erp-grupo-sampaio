/**
 * ============================================================================
 * O BANCO QUE JÁ ESTÁ NA VERSÃO 85 GANHA A IMPRESSÃO DIGITAL DA VENDA PELA
 * SUBIDA DE VERDADE (RES-IDEM-TELA, sugestão do verificador do d622b6d)
 * ============================================================================
 *
 * O banco da loja já está na versão 85 — a última desta build. A coluna
 * `core_sales.idempotency_fingerprint` (d622b6d) não tem passo numerado: ela
 * mora na DDL canônica, e quem a leva a um banco existente é o
 * `reconcileCoreSchema`, que a subida roda dentro de `migrateCoreSchema` mesmo
 * quando não há passo nenhum a aplicar.
 *
 * `mesma-chave-outra-mercadoria` prova o `reconcileCoreSchema` chamado à mão.
 * Este arquivo prova o CAMINHO DA SUBIDA — o que o `index.ts` faz ao abrir a
 * porta (`prepararBanco` → `migrateCoreSchema`, que começa pelo
 * `ensureCoreSchema`) — num banco já marcado como 85 e sem a coluna, que é
 * exatamente o banco da loja no dia em que esta build sobe. E prova o que
 * importa depois: a venda grava a impressão, e a mesma chave com outra
 * mercadoria é recusada com 422.
 *
 * A subida tem DUAS redes para essa coluna, e o arquivo mede as duas juntas:
 * o `reconcileCoreSchema` dentro da transação dos passos e, depois dela, o
 * reparo do esquema contra um banco novo (`repararEsquema`, GAP-PRD-140), que
 * também acrescenta coluna faltando. Medido com mutação: tirando só o
 * reconcile, o reparo põe a coluna e o arquivo continua verde; tirando os
 * dois, a coluna não chega e o arquivo fica vermelho — que é o dia em que
 * toda venda do banco da loja cairia com "no such column".
 *
 * O SEGUNDO BLOCO é o caminho INTEIRO do boot e do `npm run db:migrate`
 * (R2-IDEM, item 5): `prepararBanco` roda `runMigrations` — a camada de
 * documentos — ANTES do núcleo, e depois as bancadas e as plaquinhas. O
 * primeiro bloco chama o par do núcleo à mão; o segundo sobe pela função que
 * o `index.ts` chama, e leva junto a coluna nova do checkout
 * (`core_orders.checkout_fingerprint`), que também não tem passo numerado.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema, resetCoreSchemaCache } from '../src/db/schema.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { prepararBanco } from '../src/db/migracaoCompleta.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

function colunas(tabela: string): { name: string; notnull: number; dflt_value: string | null }[] {
  return getConnection().prepare(`PRAGMA table_info(${tabela})`).all() as unknown as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
}

function temAColuna(tabela = 'core_sales', coluna = 'idempotency_fingerprint'): boolean {
  return colunas(tabela).some((c) => c.name === coluna);
}

function versao(): number {
  const row = getConnection()
    .prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'")
    .get() as { value: string } | undefined;
  return Number(row?.value ?? 0);
}

/** A venda grava a impressão digital, e a mesma chave com outra mercadoria é 422. */
async function aVendaGravaAImpressaoEAChaveReusadaE422(loja: string): Promise<void> {
  const app = createApp();
  const login = await loginForTest(app, { userId: `gerente-${loja}`, companyId: loja, profileCodes: ['gerente_loja'] });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

  const p = await request(app).post('/api/v1/core/products').set(auth).send({ name: 'Camiseta', priceCents: 5000 });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const entrada = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(entrada.status, JSON.stringify(entrada.body)).toBeLessThan(300);
  const gaveta = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
  expect(gaveta.status, JSON.stringify(gaveta.body)).toBe(201);

  const chave = `pdv-${randomUUID()}`;
  const venda = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', chave)
    .send({
      cashSessionId: gaveta.body.id,
      items: [{ productId: p.body.id, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
  expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  const gravada = getConnection()
    .prepare('SELECT idempotency_fingerprint AS f FROM core_sales WHERE id = ?')
    .get(venda.body.id as string) as { f: string | null };
  expect(gravada.f).toMatch(/^v1:[0-9a-f]{64}$/);

  const outra = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', chave)
    .send({
      cashSessionId: gaveta.body.id,
      items: [{ productId: p.body.id, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    });
  expect(outra.status, JSON.stringify(outra.body)).toBe(422);
  expect(outra.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
  expect(outra.body.error.details).toMatchObject({ saleId: venda.body.id, saleNumber: venda.body.number });
}

describe('a subida sobre o banco da loja na versão 85 (o par do núcleo)', () => {
  let subida: { from: number; to: number };

  beforeAll(() => {
    resetDbForTests();
    // O banco da loja: migrado até o alvo desta build...
    migrateCoreSchema();
    expect(versao()).toBe(CORE_TARGET_VERSION);
    // ...e sem a coluna, como estava antes do d622b6d.
    getConnection().exec('ALTER TABLE core_sales DROP COLUMN idempotency_fingerprint;');
    expect(temAColuna()).toBe(false);

    // A subida de verdade, num processo que acabou de nascer: o cache do
    // esquema zerado, e o mesmo par que o boot chama.
    resetCoreSchemaCache();
    ensureCoreSchema();
    subida = migrateCoreSchema();
  });

  it('não aplica passo nenhum — e ainda assim a coluna chega, anulável', () => {
    expect(subida).toEqual({ from: CORE_TARGET_VERSION, to: CORE_TARGET_VERSION });
    expect(versao()).toBe(CORE_TARGET_VERSION);
    const coluna = colunas('core_sales').find((c) => c.name === 'idempotency_fingerprint');
    expect(coluna).toMatchObject({ notnull: 0, dflt_value: null });
  });

  it('a venda grava a impressão digital, e a mesma chave com outra mercadoria é 422', async () => {
    await aVendaGravaAImpressaoEAChaveReusadaE422('loja-banco-na-85');
  });
});

describe('o caminho inteiro do boot: prepararBanco (runMigrations antes do núcleo)', () => {
  let subida: { nucleo: { de: number; para: number } };

  beforeAll(() => {
    resetDbForTests();
    migrateCoreSchema();
    expect(versao()).toBe(CORE_TARGET_VERSION);
    // O banco da loja antes das duas colunas sem passo numerado.
    getConnection().exec('ALTER TABLE core_sales DROP COLUMN idempotency_fingerprint;');
    getConnection().exec('ALTER TABLE core_orders DROP COLUMN checkout_fingerprint;');
    expect(temAColuna()).toBe(false);
    expect(temAColuna('core_orders', 'checkout_fingerprint')).toBe(false);

    // O processo novo sobe pela MESMA função do index.ts e do db:migrate.
    resetCoreSchemaCache();
    subida = prepararBanco();
  });

  it('não aplica passo nenhum — e as duas colunas chegam, anuláveis', () => {
    expect(subida.nucleo).toEqual({ de: CORE_TARGET_VERSION, para: CORE_TARGET_VERSION });
    expect(versao()).toBe(CORE_TARGET_VERSION);
    expect(colunas('core_sales').find((c) => c.name === 'idempotency_fingerprint')).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(colunas('core_orders').find((c) => c.name === 'checkout_fingerprint')).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
  });

  it('a venda grava a impressão digital, e a mesma chave com outra mercadoria é 422', async () => {
    await aVendaGravaAImpressaoEAChaveReusadaE422('loja-banco-na-85-boot');
  });
});
