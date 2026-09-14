/**
 * A PLAQUINHA DA PJ MOTORS E A DA OFICINA IDENTIFICAM COISAS DIFERENTES.
 *
 * ============================================================================
 * A REGRA QUE O DONO ESCREVEU
 * ============================================================================
 *
 * **PJ Motors** — a plaquinha identifica motocicleta do ESTOQUE, destinada à
 * venda.
 *
 * **Oficina** — a plaquinha identifica máquina EXTERNA, do cliente, recebida
 * para manutenção.
 *
 * São dois domínios que compartilham a mesma numeração e o mesmo formato de QR.
 * O erro perigoso não é a leitura falhar: é ela ACERTAR o registro e errar o
 * significado — a moto de um cliente aparecendo à venda, ou a moto do pátio
 * virando "equipamento em manutenção" e saindo do disponível.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO COBRA
 * ============================================================================
 *
 * Que a leitura cruzada seja RECUSADA, com a recusa dizendo qual das regras
 * pegou — e não silenciosamente reinterpretada. `equipamento-no-estoque` já
 * cobre o sentido "cliente → estoque"; aqui está o mapa inteiro, incluindo o
 * sentido contrário e a busca que alimenta cada tela.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createEquipment, assignOwner, listEquipment } = await import(
  '../src/services/core/EquipmentService.js'
);
const { plaquinhasVinculaveis, vincularUnidade } = await import(
  '../src/services/core/EquipmentStockLink.js'
);
const { createCustomer, createProduct, updateProduct } = await import(
  '../src/services/core/CatalogService.js'
);
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createUnits } = await import('../src/services/core/ProductUnitService.js');

let pjMotors: string;
let oficina: string;
let bancadaDaOficina: string;
let bancadaDaPj: string;
let mecanico: string;
let vendedor: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  pjMotors = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  oficina = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });

  bancadaDaOficina = bancada(oficina, 'oficina-mobilidade');
  bancadaDaPj = bancada(pjMotors, 'pj-patio');

  mecanico = await upsertUser({
    login: 'MEC_CRUZ',
    displayName: 'Mecânico',
    password: 'Teste@Cruz2026',
  });
  linkUserToCompany(mecanico, oficina, 'mecanico', true);
  vendedor = await upsertUser({
    login: 'VEND_CRUZ',
    displayName: 'Vendedor',
    password: 'Teste@Cruz2026',
  });
  linkUserToCompany(vendedor, pjMotors, 'gerente_loja', true);

  /*
    A REGRA DE OURO DO DONO: plaquinha com QR é só de PJ Motors e Oficina. Em
    banco criado do zero pelas funções de identidade, a marca não vem — e sem
    ela a recusa que dispara primeiro é "esta operação não usa plaquinha", que
    esconderia a regra de ORIGEM, que é a que este arquivo existe para provar.
  */
  getConnection()
    .prepare("UPDATE core_companies SET uses_equipment_tags = 1 WHERE slug IN ('pj-motors', 'oficina')")
    .run();
});

function bancada(companyId: string, slug: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, ?, 'mobility', 1, ?)`,
    )
    .run(id, companyId, slug, `Bancada ${slug}`, new Date().toISOString());
  return id;
}

/** A moto do PÁTIO da PJ Motors: existe para ser vendida. */
function motoDaPjMotors() {
  return createEquipment({
    companyId: pjMotors,
    workshopId: bancadaDaPj,
    userId: vendedor,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: 'Shineray Patio',
    chassis: `CH-${randomUUID().slice(0, 8)}`,
  });
}

/** A moto do CLIENTE, recebida pela Oficina para manutenção. */
function motoDoCliente() {
  const dono = createCustomer(oficina, { name: 'Cliente da rua', document: '39053344705' });
  return createEquipment({
    companyId: oficina,
    workshopId: bancadaDaOficina,
    userId: mecanico,
    origin: 'EXTERNAL_CUSTOMER',
    ownerCustomerId: String(dono.id),
    brand: 'Honda',
    model: 'Biz do cliente',
    chassis: `CH-${randomUUID().slice(0, 8)}`,
  });
}

function recusa(fn: () => unknown): { code: string; status: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; status?: number; message: string };
    if (e.status === undefined) throw new Error(`erro sem status: ${e.message}`);
    return { code: String(e.code), status: Number(e.status), message: e.message };
  }
  throw new Error('A operação deveria ter sido recusada, e não foi.');
}

// ============================================================================

describe('a moto do cliente não vira estoque de venda', () => {
  it('a plaquinha dela não aparece entre as vinculáveis da PJ Motors', () => {
    const doCliente = motoDoCliente();
    expect(plaquinhasVinculaveis(pjMotors).map((p) => p.id)).not.toContain(doCliente.id);
  });

  it('nem quando se digita o número da plaquinha dela na busca', () => {
    /*
      A lista é conveniência; a BUSCA é como o balcão realmente chega numa
      plaquinha, digitando o número que está colado na máquina. Se o filtro de
      origem valesse só na listagem sem termo, bastaria digitar "#0001" para a
      moto do cliente aparecer vinculável.
    */
    const doCliente = motoDoCliente();
    const numero = String(doCliente.public_id);

    expect(plaquinhasVinculaveis(pjMotors, numero).map((p) => p.id)).not.toContain(doCliente.id);
    expect(plaquinhasVinculaveis(pjMotors, `#${numero}`).map((p) => p.id)).not.toContain(
      doCliente.id,
    );
  });

  it('e vincular pelo id é recusado dizendo QUAL regra pegou', () => {
    const doCliente = motoDoCliente();
    const produto = createProduct(pjMotors, { name: 'Moto do patio', priceCents: 1_000_000 }).id;
    updateProduct(pjMotors, produto, { serialized: true });
    // Uma unidade SERIALIZADA, que é o que recebe plaquinha — entrada de nota
    // cria as duas coisas juntas, e é isso que se reproduz aqui.
    const [unitId] = createUnits(pjMotors, produto, 1, {
      entryReferenceType: 'ajuste',
      entryReferenceId: 'e1',
      locationId: null,
    });
    applyMovement({
      companyId: pjMotors,
      productId: produto,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e1',
      unitIds: [unitId],
    });

    const err = recusa(() =>
      vincularUnidade({
        companyId: pjMotors,
        unitId,
        equipmentId: doCliente.id,
        userId: vendedor,
      }),
    );

    expect(err.status).toBe(409);
    // A recusa certa é "é do cliente" — e não "é de outra empresa", que
    // esconderia a regra que importa atrás de um detalhe de escopo.
    expect(err.message).toMatch(/cliente/i);
  });
});

// ============================================================================

describe('a moto da PJ Motors não vira máquina de cliente', () => {
  it('a origem é decidida na criação e nenhum caminho a reescreve', () => {
    const doPatio = motoDaPjMotors();
    const doCliente = motoDoCliente();

    // Não há escritor de `origin` fora de `createEquipment`. Esta asserção é a
    // guarda dessa ausência: se alguém acrescentar um, ela continua verde e o
    // teste de baixo é que pega — por isso os dois existem.
    const origens = getConnection()
      .prepare('SELECT id, origin FROM core_equipment ORDER BY public_id')
      .all() as { id: string; origin: string }[];

    expect(origens).toEqual([
      { id: doPatio.id, origin: 'INTERNAL_PJ_MOTORS' },
      { id: doCliente.id, origin: 'EXTERNAL_CUSTOMER' },
    ]);
  });

  it('registrar dono numa moto de CLIENTE é recusado — ela nunca foi vendida', () => {
    const doCliente = motoDoCliente();
    const outro = createCustomer(oficina, { name: 'Outra pessoa', document: '52998224725' });

    const err = recusa(() =>
      assignOwner({
        companyId: oficina,
        equipmentId: doCliente.id,
        customerId: String(outro.id),
        userId: mecanico,
      }),
    );

    expect(err.code).toBe('CORE_EQUIPMENT_NOT_SELLABLE');
    expect(err.message).toMatch(/cliente trouxe/i);
  });

  it('a moto do pátio ACEITA o registro de venda — é para isso que ela existe', () => {
    const doPatio = motoDaPjMotors();
    const comprador = createCustomer(pjMotors, { name: 'Comprador', document: '98765432100' });

    const depois = assignOwner({
      companyId: pjMotors,
      equipmentId: doPatio.id,
      customerId: String(comprador.id),
      userId: vendedor,
    });

    expect(depois.sale_status).toBe('SOLD');
  });
});

// ============================================================================

describe('cada operação lê a própria plaquinha', () => {
  it('a Oficina não enxerga a moto do pátio da PJ Motors', () => {
    const doPatio = motoDaPjMotors();
    expect(listEquipment(oficina, {}).map((e) => e.id)).not.toContain(doPatio.id);
  });

  it('a PJ Motors não enxerga a moto de cliente da Oficina', () => {
    const doCliente = motoDoCliente();
    expect(listEquipment(pjMotors, {}).map((e) => e.id)).not.toContain(doCliente.id);
  });

  it('nem digitando o número da plaquinha da vizinha', () => {
    const doPatio = motoDaPjMotors();
    const doCliente = motoDoCliente();

    expect(
      listEquipment(oficina, { search: String(doPatio.public_id) }).map((e) => e.id),
    ).not.toContain(doPatio.id);
    expect(
      listEquipment(pjMotors, { search: String(doCliente.public_id) }).map((e) => e.id),
    ).not.toContain(doCliente.id);
  });

  it('e cada uma enxerga a sua', () => {
    const doPatio = motoDaPjMotors();
    const doCliente = motoDoCliente();

    expect(listEquipment(pjMotors, { search: String(doPatio.public_id) }).map((e) => e.id)).toEqual([
      doPatio.id,
    ]);
    expect(listEquipment(oficina, { search: String(doCliente.public_id) }).map((e) => e.id)).toEqual(
      [doCliente.id],
    );
  });
});
