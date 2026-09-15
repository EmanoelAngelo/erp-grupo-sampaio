/**
 * ============================================================================
 * A FRONTEIRA ENTRE A PJ MOTORS E A OFICINA (GAP-PRD-109, GAP-PRD-189, GAP-PRD-110)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-109: a Oficina abria OS DE CLIENTE sobre moto que ainda era
 *     estoque da PJ — sem recusa nem aviso. A guarda só existia na venda.
 *   - GAP-PRD-189: `POST /equipment/:id/owner` registrava venda À MÃO na
 *     plaquinha interna não adotada: SOLD sem venda, sem financeiro e sem nota,
 *     com a mesma moto `in_stock` na PJ. A única volta era mexer no banco.
 *   - GAP-PRD-110: a PJ gerava, imprimia e liberava lote de plaquinha sem ter
 *     bancada nenhuma; os números do grupo queimavam em adesivos que nunca
 *     entrariam numa máquina, e a mensagem de "atende mais de uma oficina" saía
 *     para quem não tem nenhuma.
 *
 * ## O que mudou no P0 das plaquinhas
 *
 * Plaquinha passou a ser EXCLUSIVA da PJ Motors. O caso GAP-PRD-110 terminava
 * provando que "a Oficina segue gerando" — e esse é justamente o comportamento
 * que o dono tirou: a Oficina leva 403 `CORE_COMPANY_NO_TAGS` no pool inteiro,
 * leitura inclusive. As OS da Oficina (GAP-PRD-109/189) não mudam.
 *
 * ## O que mudou depois, por decisão do dono
 *
 * A regra da bancada saiu da plaquinha: somada à do P0, ela deixava o grupo
 * sem ninguém que gerasse lote (a PJ não tem bancada). A PJ Motors gera,
 * imprime e libera sem bancada, e o caso GAP-PRD-110 abaixo agora prova isso.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { assignOwner, createEquipment } from '../src/services/core/EquipmentService.js';
import { createOrder } from '../src/services/core/WorkshopCoreService.js';
import { plaquinhasVinculaveis, vincularUnidade } from '../src/services/core/EquipmentStockLink.js';

const app = createApp();
const SENHA = 'Teste@Fronteira2026';

let pj: string;
let oficinaCo: string;
let mobilidade: string;
let vendedor: string;
let gerenteOficina: string;
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

async function entrar(login: string): Promise<{ Authorization: string }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function linhaPlaquinha(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_equipment WHERE id = ?').get(id) as Record<string, unknown>;
}

function motoNoPatio(chassi: string): string {
  seq += 1;
  const [id] = createUnits(pj, moto, 1, { entryReferenceType: 'ajuste', entryReferenceId: `e${seq}` });
  applyMovement({
    companyId: pj,
    productId: moto,
    movementType: 'in',
    quantity: 1,
    referenceType: 'ajuste',
    referenceId: `e${seq}`,
    unitIds: [id],
  });
  getConnection().prepare('UPDATE core_product_units SET chassis = ? WHERE id = ?').run(chassi, id);
  return id;
}

function plaquinha(chassis?: string) {
  return createEquipment({
    companyId: oficinaCo,
    workshopId: mobilidade,
    userId: gerenteOficina,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'PJ Motors',
    model: 'Sport 3000',
    chassis,
  });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  pj = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors', kind: 'store' });
  oficinaCo = upsertCompany({ slug: 'oficina', legalName: 'Oficina Ltda', tradeName: 'Oficina', kind: 'workshop' });
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  mobilidade = (
    getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }
  ).id;
  vendedor = await upsertUser({ login: 'GER.PJ.FRONTEIRA', displayName: 'Gerente da PJ', password: SENHA });
  linkUserToCompany(vendedor, pj, 'gerente_loja', true);
  gerenteOficina = await upsertUser({ login: 'GER.OF.FRONTEIRA', displayName: 'Gerente da Oficina', password: SENHA });
  linkUserToCompany(gerenteOficina, oficinaCo, 'gerente_oficina', true);
  moto = String(createProduct(pj, { name: 'Honda CG 160', priceCents: 1_800_000 }).id);
  updateProduct(pj, moto, { serialized: true });
});

// ---------------------------------------------------------------- GAP-PRD-109

describe('GAP-PRD-109 — a moto do estoque não abre OS de cliente', () => {
  it('com cliente do cadastro é recusada nomeando a loja; sem cliente, entra como montagem interna', async () => {
    const unidade = motoNoPatio('CH-109');
    const eq = plaquinha('CH-109');
    vincularUnidade({ companyId: pj, unitId: unidade, equipmentId: eq.id, userId: vendedor });
    const cliente = createCustomer(oficinaCo, { name: 'Cliente da Oficina', document: '52998224725' });

    const err = recusa(() =>
      createOrder({
        companyId: oficinaCo,
        workshopId: mobilidade,
        userId: gerenteOficina,
        customerId: String(cliente.id),
        equipmentId: eq.id,
      }),
    );
    expect(err.code).toBe('CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER');
    expect(err.message).toContain('PJ Motors');

    // A mesma recusa pela rota, para o gerente da oficina.
    const gerente = await entrar('GER.OF.FRONTEIRA');
    const rota = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerId: String(cliente.id), equipmentId: eq.id, complaint: 'revisão' });
    expect(rota.status).toBe(409);
    expect(rota.body.error.code).toBe('CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER');

    const interna = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: gerenteOficina,
      equipmentId: eq.id,
    });
    const os = getConnection()
      .prepare('SELECT customer_id, customer_name FROM core_service_orders WHERE id = ?')
      .get(interna.id) as { customer_id: string | null; customer_name: string };
    expect(os).toEqual({ customer_id: null, customer_name: 'Montagem interna' });
    expect(linhaPlaquinha(eq.id)).toMatchObject({ sale_status: 'NOT_SOLD', owner_customer_id: null });
  });

  it('depois da venda a moto é do comprador, e a OS dele abre com o cadastro', () => {
    const unidade = motoNoPatio('CH-109B');
    const eq = plaquinha('CH-109B');
    vincularUnidade({ companyId: pj, unitId: unidade, equipmentId: eq.id, userId: vendedor });
    const comprador = createCustomer(pj, { name: 'Rita', document: '52998224725' });
    createSale({
      companyId: pj,
      userId: vendedor,
      customerId: String(comprador.id),
      items: [{ productId: moto, quantity: 1, unitIds: [unidade] }],
      payments: [{ method: 'dinheiro', amountCents: 1_800_000 }],
      idempotencyKey: randomUUID(),
    });
    const dono = String(linhaPlaquinha(eq.id).owner_customer_id);

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: gerenteOficina,
      customerId: dono,
      equipmentId: eq.id,
    });
    expect(os.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------- GAP-PRD-189

describe('GAP-PRD-189 — a moto do pátio não é "vendida à mão"', () => {
  it('a plaquinha com o chassi de uma moto no pátio da PJ recusa o registro à mão, e nada muda', () => {
    motoNoPatio('CH-189');
    const eq = plaquinha('CH-189');
    const comprador = createCustomer(oficinaCo, { name: 'Comprador', document: '52998224725' });

    const err = recusa(() =>
      assignOwner({ companyId: oficinaCo, equipmentId: eq.id, customerId: String(comprador.id), userId: gerenteOficina }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_SALE_BY_PDV');
    expect(err.message).toContain('PJ Motors');
    expect(linhaPlaquinha(eq.id)).toMatchObject({ sale_status: 'NOT_SOLD', owner_customer_id: null });
    // Continua adotável pela unidade, que é o caminho da venda.
    expect(plaquinhasVinculaveis(pj).map((c) => c.id)).toContain(eq.id);
  });

  it('a moto que saiu antes do sistema (sem unidade no pátio) ainda aceita; venda inventada não', () => {
    const eq = plaquinha('CH-ANTIGA');
    const comprador = createCustomer(oficinaCo, { name: 'Dono Antigo', document: '52998224725' });

    const inventada = recusa(() =>
      assignOwner({
        companyId: oficinaCo,
        equipmentId: eq.id,
        customerId: String(comprador.id),
        userId: gerenteOficina,
        saleId: 'venda-que-nao-existe',
      }),
    );
    expect(inventada.code).toBe('CORE_SALE_NOT_FOUND');

    const depois = assignOwner({
      companyId: oficinaCo,
      equipmentId: eq.id,
      customerId: String(comprador.id),
      userId: gerenteOficina,
    });
    expect(depois.sale_status).toBe('SOLD');
  });

  it('a venda à mão já gravada se desfaz pela ficha, com motivo, e a moto volta a poder ir ao PDV', async () => {
    const eq = plaquinha('CH-LEGADO');
    const comprador = createCustomer(oficinaCo, { name: 'Dono Registrado', document: '52998224725' });
    assignOwner({ companyId: oficinaCo, equipmentId: eq.id, customerId: String(comprador.id), userId: gerenteOficina });
    const gerente = await entrar('GER.OF.FRONTEIRA');

    const ficha = await request(app).get(`/api/v1/core/equipment/${eq.id}`).set(gerente);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.vendaAMao).toBe(true);

    const semMotivo = await request(app)
      .post(`/api/v1/core/equipment/${eq.id}/owner/desfazer`)
      .set(gerente)
      .send({ motivo: '' });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_REASON_REQUIRED');

    const desfeita = await request(app)
      .post(`/api/v1/core/equipment/${eq.id}/owner/desfazer`)
      .set(gerente)
      .send({ motivo: 'A moto ainda está no pátio da PJ' });
    expect(desfeita.status, JSON.stringify(desfeita.body)).toBe(200);
    expect(desfeita.body.public_token).toBeUndefined();
    expect(linhaPlaquinha(eq.id)).toMatchObject({ sale_status: 'NOT_SOLD', owner_customer_id: null, sold_at: null });

    const evento = getConnection()
      .prepare("SELECT description FROM core_equipment_events WHERE equipment_id = ? AND event_type = 'sale_reverted'")
      .get(eq.id) as { description: string };
    expect(evento.description).toContain('A moto ainda está no pátio da PJ');
    expect(evento.description).toContain('Dono Registrado');
    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'equipment.sale.manual_undo' AND entity_id = ?")
      .get(eq.id) as { n: number };
    expect(trilha.n).toBe(1);

    const fichaDepois = await request(app).get(`/api/v1/core/equipment/${eq.id}`).set(gerente);
    expect(fichaDepois.body.vendaAMao).toBe(false);
    // De volta às candidatas: a unidade da PJ a adota e a venda sai pelo PDV.
    expect(plaquinhasVinculaveis(pj).map((c) => c.id)).toContain(eq.id);

    // Desfazer de novo não tem o que desfazer.
    const deNovo = await request(app)
      .post(`/api/v1/core/equipment/${eq.id}/owner/desfazer`)
      .set(gerente)
      .send({ motivo: 'de novo' });
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.error.code).toBe('CORE_MANUAL_SALE_NOT_APPLICABLE');
  });

  it('venda de verdade não se desfaz por aqui', async () => {
    const unidade = motoNoPatio('CH-VENDIDA');
    const eq = plaquinha('CH-VENDIDA');
    vincularUnidade({ companyId: pj, unitId: unidade, equipmentId: eq.id, userId: vendedor });
    const comprador = createCustomer(pj, { name: 'Rita', document: '52998224725' });
    createSale({
      companyId: pj,
      userId: vendedor,
      customerId: String(comprador.id),
      items: [{ productId: moto, quantity: 1, unitIds: [unidade] }],
      payments: [{ method: 'dinheiro', amountCents: 1_800_000 }],
      idempotencyKey: randomUUID(),
    });
    const gerente = await entrar('GER.OF.FRONTEIRA');
    const res = await request(app)
      .post(`/api/v1/core/equipment/${eq.id}/owner/desfazer`)
      .set(gerente)
      .send({ motivo: 'tentativa' });
    expect(res.status).toBe(409);
    expect(linhaPlaquinha(eq.id).sale_status).toBe('SOLD');
  });
});

// ---------------------------------------------------------------- GAP-PRD-110

/*
  A DECISÃO DO DONO VIROU ESTE CASO DE CABEÇA PARA BAIXO.

  Ele provava "quem gera plaquinha é quem tem bancada": a PJ sem bancada levava
  409 `CORE_TAGS_NEED_WORKSHOP` no lote, na folha e na liberação, e o pool
  dizia `temBancada: false` para a tela esconder o botão. Somada à regra do P0
  (plaquinha só na PJ Motors), ela deixava o grupo sem ninguém que gerasse
  lote. O dono decidiu que a PJ gera, imprime e libera as plaquinhas dela sem
  bancada — o portão é a empresa. A outra metade do caso continua valendo: a
  Oficina, COM bancada, não tem pool nenhum.
*/
describe('GAP-PRD-110 — a PJ gera sem bancada; a bancada não dá plaquinha a ninguém', () => {
  it('a PJ sem bancada gera, imprime e libera — o adesivo antigo também; a Oficina, com bancada, leva 403', async () => {
    const gerentePj = await entrar('GER.PJ.FRONTEIRA');
    const bancadasDaPj = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_workshops WHERE company_id = ?')
      .get(pj) as { n: number };
    expect(bancadasDaPj.n).toBe(0);

    const pool = await request(app).get('/api/v1/core/equipment-tags').set(gerentePj);
    expect(pool.status, JSON.stringify(pool.body)).toBe(200);
    expect(pool.body.usaPlaquinha).toBe(true);
    // O campo que escondia "Gerar lote" da tela saiu junto com a regra.
    expect(pool.body.temBancada).toBeUndefined();

    const lote = await request(app).post('/api/v1/core/equipment-tags/batches').set(gerentePj).send({ quantidade: 2 });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    expect(lote.body.criadas).toBe(2);

    // Adesivo gerado ANTES da decisão (o legado do banco): vai à folha e é liberado.
    const legado = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_equipment_tags (id, company_id, public_id, public_token, status, created_by, created_at, updated_at)
         VALUES (?, ?, 9001, ?, 'gerada', ?, ?, ?)`,
      )
      .run(legado, pj, `tok-${legado}`, vendedor, new Date().toISOString(), new Date().toISOString());
    const folha = await request(app).post('/api/v1/core/equipment-tags/sheet').set(gerentePj).send({ tagIds: [legado] });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body.plaquinhas).toBe(1);
    const libera = await request(app).post('/api/v1/core/equipment-tags/release').set(gerentePj).send({ tagIds: [legado] });
    expect(libera.status, JSON.stringify(libera.body)).toBe(200);
    expect(libera.body).toEqual({ liberadas: 1 });
    // A prévia do layout continua como sempre.
    const previa = await request(app).post('/api/v1/core/equipment-tags/sheet').set(gerentePj).send({ preview: true });
    expect(previa.status).toBe(200);

    /*
      A OFICINA NÃO TEM POOL (P0 das plaquinhas). Aqui a asserção antiga era
      "a Oficina segue gerando" (201) e "o pool dela tem bancada". A regra do
      dono tirou a plaquinha da Oficina: ela tem bancada, e mesmo assim gerar e
      ler o pool são 403 — a bancada não decide quem tem plaquinha. Nenhum
      número foi reservado pela tentativa.
    */
    const gerenteOf = await entrar('GER.OF.FRONTEIRA');
    const daOficina = await request(app)
      .post('/api/v1/core/equipment-tags/batches')
      .set(gerenteOf)
      .send({ quantidade: 2 });
    expect(daOficina.status, JSON.stringify(daOficina.body)).toBe(403);
    expect(daOficina.body.error.code).toBe('CORE_COMPANY_NO_TAGS');
    const poolOficina = await request(app).get('/api/v1/core/equipment-tags').set(gerenteOf);
    expect(poolOficina.status).toBe(403);
    expect(poolOficina.body.items).toBeUndefined();
    const depois = getConnection().prepare('SELECT COUNT(*) AS n FROM core_equipment_tags WHERE company_id = ?').get(oficinaCo) as { n: number };
    expect(depois.n).toBe(0);
  });
});
