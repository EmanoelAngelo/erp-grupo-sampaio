/**
 * ============================================================================
 * A LOJA NOVA NÃO NASCE TRAVADA — as unidades padrão do catálogo
 * ============================================================================
 *
 * Auditoria do PDV da Preço Justo (P0), item P00-catalogo-unidade.
 *
 * O DEFEITO MEDIDO PELA ROTA, numa empresa nova:
 *
 *   POST /core/catalog/units {SC} ....... 201
 *   POST /core/products {name, price} ... 400 CORE_UNIT_NOT_FOUND
 *                                         («A unidade "UN" não está cadastrada
 *                                          nesta operação»)
 *   GET  /core/catalog/aux .............. 200 (só a SC)
 *   POST /core/products ................. 400 DE NOVO — e para sempre.
 *
 * `ensureDefaultUnits` decidia "já semeei" a partir de "existe ALGUMA
 * unidade", e `upsertUnit` não a chamava: bastava uma unidade própria nascer
 * antes de qualquer listagem para as quinze padrão ficarem de fora
 * definitivamente. A tela do produto nasce com 'UN' e manda 'UN', então a loja
 * implantada por script, importação ou API não cadastrava produto nenhum — e
 * listar depois NÃO consertava, porque a listagem saía cedo pela mesma conta.
 *
 * O que este arquivo trava:
 *
 *   - a loja que cria a unidade própria PRIMEIRO continua cadastrando produto;
 *   - as quinze nascem uma vez só, sem duplicar;
 *   - e a padrão que o dono EXCLUIU não ressuscita na próxima listagem — que é
 *     o defeito que a conferência ingênua ("faltou alguma das quinze? semeia")
 *     teria colocado no lugar deste.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA_NOVA = 'loja-recem-nascida';

type Auth = { Authorization: string };
let gerente: Auth;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente-loja-nova',
    companyId: LOJA_NOVA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
});

/** As unidades cruas desta operação, do banco — sem passar pela semeadura. */
function unidadesGravadas(): string[] {
  return (
    getConnection()
      .prepare('SELECT code FROM core_units WHERE company_id = ? ORDER BY code')
      .all(LOJA_NOVA) as unknown as { code: string }[]
  ).map((u) => u.code);
}

describe('as unidades padrão nascem mesmo quando a loja cadastra a sua primeiro', () => {
  it('unidade própria antes de qualquer listagem: o cadastro de produto continua entrando', async () => {
    const propria = await request(app)
      .post('/api/v1/core/catalog/units')
      .set(gerente)
      .send({ code: 'SC', name: 'Saco', decimals: 0 });
    expect(propria.status, JSON.stringify(propria.body)).toBe(201);

    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Arroz do dia', priceCents: 2_490 });
    expect(produto.status, JSON.stringify(produto.body)).toBe(201);
    expect(produto.body.unit).toBe('UN');

    // A unidade própria continua lá, ao lado das padrão.
    expect(unidadesGravadas()).toContain('SC');
    expect(unidadesGravadas()).toContain('UN');
  });

  it('a semeadura é uma só: listar duas vezes não duplica nada', async () => {
    const primeira = await request(app).get('/api/v1/core/catalog/aux').set(gerente);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(200);
    const codigos = unidadesGravadas();
    expect(codigos).toContain('UN');
    expect(codigos).toContain('KG');

    const segunda = await request(app).get('/api/v1/core/catalog/aux').set(gerente);
    expect(segunda.status).toBe(200);
    expect(unidadesGravadas()).toEqual(codigos);
    // Nenhuma sigla repetida.
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  /*
    O CONTRÁRIO DO DEFEITO TAMBÉM É DEFEITO. `deleteUnit` apaga a unidade que
    nenhum produto usa — é uma decisão do dono, e a semeadura não pode desfazê-la
    na próxima abertura da tela. Por isso a conferência é "existe ALGUMA das
    padrão?", e não "estão as quinze?".
  */
  it('a unidade padrão que o dono excluiu não volta na próxima listagem', async () => {
    const aux = await request(app).get('/api/v1/core/catalog/aux').set(gerente);
    expect(aux.status).toBe(200);
    const duzia = (aux.body.units as { id: string; code: string }[]).find((u) => u.code === 'DZ');
    expect(duzia, 'a dúzia é uma das padrão').toBeDefined();

    const excluida = await request(app)
      .delete(`/api/v1/core/catalog/units/${duzia!.id}`)
      .set(gerente);
    expect(excluida.status, JSON.stringify(excluida.body)).toBe(200);
    expect(unidadesGravadas()).not.toContain('DZ');

    const depois = await request(app).get('/api/v1/core/catalog/aux').set(gerente);
    expect(depois.status).toBe(200);
    expect((depois.body.units as { code: string }[]).map((u) => u.code)).not.toContain('DZ');
    expect(unidadesGravadas()).not.toContain('DZ');
  });
});
