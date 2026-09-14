/**
 * ============================================================================
 * A PLAQUINHA DEPOIS DA VENDA — o vínculo tardio (GAP-PRD-108)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 * Venda no PDV de unidade sem plaquinha é permitida (o PDV só avisa). Depois
 * disso, `POST /units/:id/equipment` respondia 409 "já foi vendida e não recebe
 * plaquinha nova": a plaquinha que a Oficina montou com o MESMO chassi ficava
 * `NOT_SOLD`, sem dono, com o portal do comprador mudo e a garantia sem data de
 * venda — e aparecia nas candidatas de QUALQUER unidade nova, pronta para ser
 * adotada pela moto errada.
 *
 * ## O que se cobra aqui
 *
 *   - a moto vendida sem plaquinha ganha a plaquinha com o mesmo número, e a
 *     plaquinha recebe o que a venda disse: comprador (espelhado pelo CPF), data
 *     da venda e o id da venda;
 *   - a plaquinha com o número de uma moto vendida some das candidatas das
 *     outras unidades, e o vínculo direto é recusado dizendo de quem ela é;
 *   - sem número igual, sem comprador ou sem CPF, a recusa diz o que falta — e
 *     nada é gravado pela metade.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import type { ApiError } from '../src/utils/errors.js';
import { createCustomer, createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createUnits, getUnit } from '../src/services/core/ProductUnitService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { plaquinhasVinculaveis, vincularUnidade } from '../src/services/core/EquipmentStockLink.js';

const app = createApp();
const SENHA = 'Teste@Tardio2026';

let loja: string;
let oficinaCo: string;
let mobilidade: string;
let vendedor: string;
let mecanico: string;
let moto: string;
let seq = 0;

function recusa(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Esperava uma recusa, e a chamada passou.');
}

function linhaPlaquinha(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_equipment WHERE id = ?').get(id) as Record<string, unknown>;
}

function eventos(id: string): string[] {
  return (
    getConnection()
      .prepare('SELECT event_type FROM core_equipment_events WHERE equipment_id = ? ORDER BY created_at, rowid')
      .all(id) as { event_type: string }[]
  ).map((e) => e.event_type);
}

/** Uma moto no pátio da PJ, já com chassi (ou sem, quando `chassi` é nulo). */
function motoNoPatio(chassi: string | null): string {
  seq += 1;
  const [id] = createUnits(loja, moto, 1, { entryReferenceType: 'ajuste', entryReferenceId: `e${seq}` });
  applyMovement({
    companyId: loja,
    productId: moto,
    movementType: 'in',
    quantity: 1,
    referenceType: 'ajuste',
    referenceId: `e${seq}`,
    unitIds: [id],
  });
  if (chassi) getConnection().prepare('UPDATE core_product_units SET chassis = ? WHERE id = ?').run(chassi, id);
  return id;
}

function plaquinha(identidade: { chassis?: string; motorNumber?: string } = {}) {
  return createEquipment({
    companyId: oficinaCo,
    workshopId: mobilidade,
    userId: mecanico,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'PJ Motors',
    model: 'Sport 3000',
    chassis: identidade.chassis,
    motorNumber: identidade.motorNumber,
  });
}

function vender(unitId: string, customerId: string | null): { id: string; created_at: string } {
  seq += 1;
  const { sale } = createSale({
    companyId: loja,
    userId: vendedor,
    customerId,
    items: [{ productId: moto, quantity: 1, unitIds: [unitId] }],
    payments: [{ method: 'dinheiro', amountCents: 1_800_000 }],
    idempotencyKey: `venda-${seq}`,
  });
  return getConnection().prepare('SELECT id, created_at FROM core_sales WHERE id = ?').get(sale.id) as {
    id: string;
    created_at: string;
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  loja = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors', kind: 'store' });
  oficinaCo = upsertCompany({ slug: 'oficina', legalName: 'Oficina Ltda', tradeName: 'Oficina', kind: 'workshop' });
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  mobilidade = (
    getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }
  ).id;
  vendedor = await upsertUser({ login: 'GER.PJ.TARDIO', displayName: 'Gerente da PJ', password: SENHA });
  linkUserToCompany(vendedor, loja, 'gerente_loja', true);
  mecanico = await upsertUser({ login: 'MEC.TARDIO', displayName: 'Mecânico', password: SENHA });
  linkUserToCompany(mecanico, oficinaCo, 'gerente_oficina', true);
  moto = String(createProduct(loja, { name: 'Honda CG 160', priceCents: 1_800_000 }).id);
  updateProduct(loja, moto, { serialized: true });
});

describe('GAP-PRD-108 — a moto vendida sem plaquinha ganha o vínculo', () => {
  it('a plaquinha com o mesmo chassi entra depois da venda, e o comprador vira o dono com a data da venda', () => {
    const unidade = motoNoPatio('CH-TARDIA');
    const comprador = createCustomer(loja, { name: 'Rita Compradora', document: '52998224725' });
    const venda = vender(unidade, String(comprador.id));
    const eq = plaquinha({ chassis: 'CH-TARDIA' });

    // Nas candidatas "de qualquer unidade", ela NÃO aparece: é daquela moto.
    expect(plaquinhasVinculaveis(loja).map((c) => c.id)).not.toContain(eq.id);
    // Para a moto vendida, aparece — só ela, pelo número.
    expect(plaquinhasVinculaveis(loja, undefined, unidade).map((c) => c.id)).toEqual([eq.id]);

    const resultado = vincularUnidade({ companyId: loja, unitId: unidade, equipmentId: eq.id, userId: vendedor });
    expect(resultado.saleStatus).toBe('SOLD');

    const depois = linhaPlaquinha(eq.id);
    const espelho = getConnection()
      .prepare('SELECT id FROM core_customers WHERE company_id = ? AND document = ?')
      .get(oficinaCo, '52998224725') as { id: string };
    expect(depois).toMatchObject({
      sale_status: 'SOLD',
      sale_id: venda.id,
      sold_at: venda.created_at,
      owner_customer_id: espelho.id,
      origin_company_id: loja,
    });
    const u = getUnit(loja, unidade)!;
    expect(u.equipment_id).toBe(eq.id);
    expect(u.chassis).toBe('CH-TARDIA');
    expect(eventos(eq.id)).toEqual(expect.arrayContaining(['stock_linked', 'sold']));
  });

  it('a plaquinha com o número de uma moto vendida não entra em outra unidade', () => {
    const vendida = motoNoPatio('CH-DA-VENDIDA');
    const comprador = createCustomer(loja, { name: 'Rita', document: '52998224725' });
    vender(vendida, String(comprador.id));
    const eq = plaquinha({ chassis: 'CH-DA-VENDIDA' });
    const nova = motoNoPatio(null);

    const err = recusa(() => vincularUnidade({ companyId: loja, unitId: nova, equipmentId: eq.id, userId: vendedor }));
    expect(err.code).toBe('CORE_EQUIPMENT_BELONGS_TO_SOLD_UNIT');
    expect(err.message).toContain('CH-DA-VENDIDA');
    expect(getUnit(loja, nova)!.equipment_id).toBeNull();
    expect(linhaPlaquinha(eq.id).sale_status).toBe('NOT_SOLD');
  });

  it('sem número igual, sem comprador ou sem CPF, a recusa diz o que falta e nada é gravado', () => {
    const comCpf = createCustomer(loja, { name: 'Rita', document: '52998224725' });
    const semCpf = createCustomer(loja, { name: 'Zé Sem Documento' });

    // A plaquinha sem número nenhum não se liga à moto vendida.
    const u1 = motoNoPatio('CH-UM');
    vender(u1, String(comCpf.id));
    const semNumero = plaquinha();
    expect(
      recusa(() => vincularUnidade({ companyId: loja, unitId: u1, equipmentId: semNumero.id, userId: vendedor })).code,
    ).toBe('CORE_LATE_LINK_NEEDS_IDENTITY');

    // Número diferente, nem confirmando pela unidade.
    const outroNumero = plaquinha({ chassis: 'CH-OUTRO' });
    expect(
      recusa(() =>
        vincularUnidade({
          companyId: loja,
          unitId: u1,
          equipmentId: outroNumero.id,
          userId: vendedor,
          confirmarPelaUnidade: true,
        }),
      ).code,
    ).toBe('CORE_LATE_LINK_NEEDS_IDENTITY');

    // Venda sem cliente: não há dono para carimbar.
    const u2 = motoNoPatio('CH-DOIS');
    vender(u2, null);
    const eq2 = plaquinha({ chassis: 'CH-DOIS' });
    expect(
      recusa(() => vincularUnidade({ companyId: loja, unitId: u2, equipmentId: eq2.id, userId: vendedor })).code,
    ).toBe('CORE_LATE_LINK_WITHOUT_BUYER');

    // Cliente sem CPF: o espelho da oficina é pelo documento.
    const u3 = motoNoPatio('CH-TRES');
    vender(u3, String(semCpf.id));
    const eq3 = plaquinha({ chassis: 'CH-TRES' });
    expect(
      recusa(() => vincularUnidade({ companyId: loja, unitId: u3, equipmentId: eq3.id, userId: vendedor })).code,
    ).toBe('CORE_LATE_LINK_BUYER_WITHOUT_DOCUMENT');

    for (const id of [semNumero.id, outroNumero.id, eq2.id, eq3.id]) {
      expect(linhaPlaquinha(id)).toMatchObject({ sale_status: 'NOT_SOLD', owner_customer_id: null, origin_company_id: null });
    }
    for (const u of [u1, u2, u3]) expect(getUnit(loja, u)!.equipment_id).toBeNull();
  });

  it('pela rota: a fila das vendidas sem plaquinha, as candidatas da unidade e a trilha do vínculo tardio', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ login: 'GER.PJ.TARDIO', password: SENHA });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const gerente = { Authorization: `Bearer ${login.body.accessToken}` };

    const unidade = motoNoPatio('CH-ROTA');
    motoNoPatio(null);
    const comprador = createCustomer(loja, { name: 'Rita', document: '52998224725' });
    vender(unidade, String(comprador.id));
    const eq = plaquinha({ chassis: 'CH-ROTA' });

    const antes = await request(app).get('/api/v1/core/units/summary').set(gerente);
    expect(antes.status, JSON.stringify(antes.body)).toBe(200);
    expect(antes.body).toMatchObject({ semPlaquinha: 1, vendidasSemPlaquinha: 1, produtosSerializados: 1, semIdentidade: 1 });

    const candidatas = await request(app)
      .get(`/api/v1/core/units/equipment-candidates?unitId=${unidade}`)
      .set(gerente);
    expect(candidatas.body.items.map((c: { id: string }) => c.id)).toEqual([eq.id]);

    const liga = await request(app)
      .post(`/api/v1/core/units/${unidade}/equipment`)
      .set(gerente)
      .send({ equipmentId: eq.id });
    expect(liga.status, JSON.stringify(liga.body)).toBe(201);
    expect(liga.body.plaquinha.saleStatus).toBe('SOLD');

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'unit.equipment.link' AND entity_id = ?")
      .get(unidade) as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({ equipmentId: eq.id, tardio: true });

    const depois = await request(app).get('/api/v1/core/units/summary').set(gerente);
    expect(depois.body.vendidasSemPlaquinha).toBe(0);
  });
});
