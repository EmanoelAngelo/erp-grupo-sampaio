/**
 * TODA SAÍDA SOLTA A PLAQUINHA — menos a venda, que lhe dá dono.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * `applyMovement` decidia o estado da unidade pelo TIPO do movimento:
 *
 *     const statusDaSaida = input.movementType === 'out' ? 'sold' : 'baixada';
 *
 * e o comentário logo acima dizia a intenção certa — "saída por ajuste ou perda
 * não é venda; o status separa as duas porque 'vendida' é o que vira garantia e
 * nota do cliente". Só que `movementType` não separa nada: a venda de balcão, o
 * ajuste manual, a perda e o consumo de peça em OS são TODOS `'out'`.
 *
 * O efeito é uma plaquinha CONGELADA. A unidade fica `sold`, mas nem
 * `venderPelaUnidade` roda (a referência não é venda) nem `baixarPelaUnidade`
 * (o status não é `baixada`). O `equipment_id` continua apontando para a
 * plaquinha, e a partir daí:
 *
 *   - `plaquinhasVinculaveis` a exclui, porque há unidade apontando para ela;
 *   - `desvincularUnidade` recusa soltar, porque a unidade não está em estoque.
 *
 * A moto some da lista de adotáveis com a mensagem "já foi vendida" — para uma
 * moto que ninguém vendeu. A única saída era mexer no banco à mão.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Quem decide é a REFERÊNCIA, não o tipo do movimento: venda dá dono, qualquer
 * outra saída definitiva solta a plaquinha, e só a transferência não mexe nela
 * — porque ali a unidade volta na perna de entrada.
 *
 * O lado seguro do padrão é SOLTAR: plaquinha solta se vincula de novo em dois
 * cliques; plaquinha congelada só sai com alguém abrindo o banco.
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
const { createCustomer, createProduct, updateProduct } = await import(
  '../src/services/core/CatalogService.js'
);
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createUnits } = await import('../src/services/core/ProductUnitService.js');
const { createEquipment } = await import('../src/services/core/EquipmentService.js');
const { plaquinhasVinculaveis, vincularUnidade } = await import(
  '../src/services/core/EquipmentStockLink.js'
);
const { transferStock, createLocation } = await import(
  '../src/services/core/StockLocationService.js'
);

let pjMotors: string;
let bancada: string;
let vendedor: string;
let produto: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  pjMotors = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  getConnection()
    .prepare("UPDATE core_companies SET uses_equipment_tags = 1 WHERE slug = 'pj-motors'")
    .run();

  bancada = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'pj-patio', 'Pátio', 'mobility', 1, ?)`,
    )
    .run(bancada, pjMotors, new Date().toISOString());

  vendedor = await upsertUser({
    login: 'VEND_CONG',
    displayName: 'Vendedor',
    password: 'Teste@Cong2026',
  });
  linkUserToCompany(vendedor, pjMotors, 'gerente_loja', true);

  produto = createProduct(pjMotors, { name: 'Moto do patio', priceCents: 1_000_000 }).id;
  updateProduct(pjMotors, produto, { serialized: true });
});

/** Uma unidade em estoque, com plaquinha colada nela. */
function motoComPlaquinha(): { unitId: string; equipmentId: string } {
  const [unitId] = createUnits(pjMotors, produto, 1, {
    entryReferenceType: 'ajuste',
    entryReferenceId: `e-${randomUUID()}`,
    locationId: null,
  });
  applyMovement({
    companyId: pjMotors,
    productId: produto,
    movementType: 'in',
    quantity: 1,
    referenceType: 'ajuste',
    referenceId: `e-${unitId}`,
    unitIds: [unitId],
  });

  const equipamento = createEquipment({
    companyId: pjMotors,
    workshopId: bancada,
    userId: vendedor,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: 'Patio',
    chassis: `CH-${randomUUID().slice(0, 8)}`,
  });
  vincularUnidade({ companyId: pjMotors, unitId, equipmentId: equipamento.id, userId: vendedor });

  return { unitId, equipmentId: equipamento.id };
}

function unidade(unitId: string): { status: string; equipment_id: string | null } {
  return getConnection()
    .prepare('SELECT status, equipment_id FROM core_product_units WHERE id = ?')
    .get(unitId) as { status: string; equipment_id: string | null };
}

/** A saída manual que a tela de movimentações faz. */
function sairPor(unitId: string, referenceType: string) {
  applyMovement({
    companyId: pjMotors,
    productId: produto,
    movementType: 'out',
    quantity: 1,
    referenceType,
    referenceId: `ref-${randomUUID()}`,
    unitIds: [unitId],
    userId: vendedor,
    reason: 'Baixa manual',
  });
}

// ============================================================================

describe('a saída que não é venda solta a plaquinha', () => {
  it('ajuste manual: a unidade sai BAIXADA e a plaquinha fica livre', () => {
    const { unitId, equipmentId } = motoComPlaquinha();

    sairPor(unitId, 'ajuste');

    const depois = unidade(unitId);
    expect(depois.status).toBe('baixada');
    expect(depois.equipment_id).toBeNull();
    // E a plaquinha volta a ser adotável — que é o desfecho que faltava.
    expect(plaquinhasVinculaveis(pjMotors).map((p) => p.id)).toContain(equipmentId);
  });

  it('perda segue o mesmo caminho', () => {
    const { unitId, equipmentId } = motoComPlaquinha();
    sairPor(unitId, 'perda');

    expect(unidade(unitId).equipment_id).toBeNull();
    expect(plaquinhasVinculaveis(pjMotors).map((p) => p.id)).toContain(equipmentId);
  });

  it('consumo de peça em ordem de serviço também', () => {
    const { unitId, equipmentId } = motoComPlaquinha();
    sairPor(unitId, 'service_order');

    expect(unidade(unitId).equipment_id).toBeNull();
    expect(plaquinhasVinculaveis(pjMotors).map((p) => p.id)).toContain(equipmentId);
  });

  it('referência DESCONHECIDA cai no lado seguro: solta', () => {
    /*
      `POST /stock/movements` aceita `referenceType` livre, e módulos novos
      inventam referências. O padrão tem de ser o desfecho recuperável:
      plaquinha solta se vincula de novo em dois cliques; plaquinha congelada
      só sai com alguém abrindo o banco.
    */
    const { unitId, equipmentId } = motoComPlaquinha();
    sairPor(unitId, 'modulo_que_ainda_nao_existe');

    expect(unidade(unitId).equipment_id).toBeNull();
    expect(plaquinhasVinculaveis(pjMotors).map((p) => p.id)).toContain(equipmentId);
  });
});

// ============================================================================

describe('a venda continua dando dono, e não soltando', () => {
  it('venda de balcão mantém o vínculo e marca a unidade como vendida', () => {
    const { unitId, equipmentId } = motoComPlaquinha();

    // Venda de moto com plaquinha exige cliente — é o vínculo que leva o
    // histórico da máquina ao portal de quem comprou.
    const cliente = createCustomer(pjMotors, { name: 'Comprador', document: '39053344705' });
    const vendaId = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_sales
           (id, company_id, number, status, subtotal_cents, discount_cents, total_cents,
            change_cents, customer_id, idempotency_key, created_at)
         VALUES (?, ?, 1, 'completed', 1000000, 0, 1000000, 0, ?, ?, ?)`,
      )
      .run(vendaId, pjMotors, String(cliente.id), randomUUID(), agora);

    applyMovement({
      companyId: pjMotors,
      productId: produto,
      movementType: 'out',
      quantity: 1,
      referenceType: 'sale',
      referenceId: vendaId,
      unitIds: [unitId],
      userId: vendedor,
    });

    const depois = unidade(unitId);
    expect(depois.status).toBe('sold');
    // O vínculo PERMANECE: é ele que liga a garantia à moto que o cliente levou.
    expect(depois.equipment_id).toBeTruthy();
    expect(plaquinhasVinculaveis(pjMotors).map((p) => p.id)).not.toContain(equipmentId);
  });
});

// ============================================================================

describe('a transferência não é saída — a unidade só muda de prateleira', () => {
  it('depois de transferir, a plaquinha continua na moto', () => {
    const { unitId, equipmentId } = motoComPlaquinha();
    const geral = createLocation(pjMotors, { code: 'GERAL2', name: 'Geral' });
    const vitrine = createLocation(pjMotors, { code: 'VITRINE', name: 'Vitrine' });

    // A unidade entrou sem local; põe-se no GERAL para poder transferir.
    getConnection()
      .prepare('UPDATE core_product_units SET location_id = ? WHERE id = ?')
      .run(geral.id, unitId);
    getConnection()
      .prepare('UPDATE core_stock_movements SET location_id = ? WHERE company_id = ?')
      .run(geral.id, pjMotors);

    transferStock({
      companyId: pjMotors,
      productId: produto,
      quantity: 1,
      fromLocationId: geral.id,
      toLocationId: vitrine.id,
      userId: vendedor,
    });

    const depois = unidade(unitId);
    expect(depois.status).toBe('in_stock');
    expect(depois.equipment_id).toBe(equipmentId);
  });
});
