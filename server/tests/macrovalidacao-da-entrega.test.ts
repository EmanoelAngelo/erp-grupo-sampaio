/**
 * A MACROVALIDAÇÃO DA ENTREGA — as travessias completas, uma por operação.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO É
 * ============================================================================
 *
 * Os outros testes provam PEÇAS: a fila fiscal por empresa, a comissão sem
 * resíduo, a plaquinha que não congela, o pedido de retirada que chega ao
 * cliente. Este percorre os CAMINHOS INTEIROS que o dono descreveu, do jeito
 * que a loja vai usar no primeiro dia:
 *
 *   PREÇO JUSTO   abrir caixa → vender → estoque → financeiro → fechar turno
 *   GRINGA        vender para cliente cadastrado, e nada da vizinha aparece
 *   PJ MOTORS     moto no pátio → plaquinha → venda → dono na plaquinha
 *   OFICINA       moto do cliente → OS → peça → fechamento → papel da Oficina
 *
 * A diferença entre isto e os testes de unidade não é o tamanho: é que aqui os
 * módulos se encostam. Cada um deles passa sozinho; o que se mede aqui é a
 * COSTURA — e é na costura que este projeto encontrou a maioria dos defeitos.
 *
 * ============================================================================
 * O QUE ELE NÃO PROVA
 * ============================================================================
 *
 * Nada contra a SEFAZ e nada contra o Asaas de verdade. Emissão real, QR real e
 * cobrança real dependem de credencial externa, e chamar simulador de
 * homologação seria a mentira mais cara deste relatório. O que está coberto
 * aqui é o que o sistema faz sozinho.
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
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { createUnits } = await import('../src/services/core/ProductUnitService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const { openSession, closeSession, expectedCents } = await import(
  '../src/services/core/CashService.js'
);
const { summarize } = await import('../src/services/core/FinanceService.js');
const { createEquipment } = await import('../src/services/core/EquipmentService.js');
const { plaquinhasVinculaveis, vincularUnidade } = await import(
  '../src/services/core/EquipmentStockLink.js'
);
const { renderServiceOrderA4 } = await import('../src/services/core/ServiceOrderA4.js');
const { incomeStatement } = await import('../src/services/core/IncomeStatementService.js');
const { hojeNaLoja } = await import('../src/services/core/CalendarioOperacional.js');

interface Loja {
  companyId: string;
  operador: string;
}

const loja = {} as Record<string, Loja>;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  for (const [slug, nome, kind] of [
    ['preco-justo', 'Preço Justo', 'store'],
    ['gringa', 'Gringa', 'store'],
    ['pj-motors', 'PJ Motors', 'store'],
    ['oficina', 'Oficina', 'workshop'],
  ] as const) {
    const companyId = upsertCompany({
      slug,
      legalName: `${nome} Ltda`,
      tradeName: nome,
      kind,
    });
    const operador = await upsertUser({
      login: `OP_${slug.toUpperCase().replace('-', '_')}`,
      displayName: `Operador ${nome}`,
      password: 'Teste@Macro2026',
    });
    linkUserToCompany(operador, companyId, 'gerente_loja', true);
    loja[slug] = { companyId, operador };
  }

  // A regra de ouro do dono: plaquinha com QR é só de PJ Motors e Oficina.
  getConnection()
    .prepare(
      "UPDATE core_companies SET uses_equipment_tags = 1 WHERE slug IN ('pj-motors', 'oficina')",
    )
    .run();
});

/** Um produto com saldo, do jeito que a carga inicial o cria. */
function produtoComSaldo(slug: string, nome: string, priceCents: number, qtd: number): string {
  const { companyId } = loja[slug];
  const id = createProduct(companyId, { name: nome, priceCents }).id;
  applyMovement({
    companyId,
    productId: id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${id}`,
  });
  return id;
}

/** Uma bancada da operação. */
function bancadaDe(slug: string, nomeSlug: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, ?, 'mobility', 1, ?)`,
    )
    .run(id, loja[slug].companyId, nomeSlug, `Bancada ${nomeSlug}`, new Date().toISOString());
  return id;
}

// ============================================================================
// PREÇO JUSTO — o balcão inteiro, da abertura ao fechamento
// ============================================================================

describe('Preço Justo: caixa → venda → estoque → financeiro → turno', () => {
  it('a travessia fecha, e cada número bate com o anterior', () => {
    const { companyId, operador } = loja['preco-justo'];
    const camiseta = produtoComSaldo('preco-justo', 'Camiseta Polo', 5_000, 10);

    // 1. ABRIR O CAIXA. Sem gaveta aberta o balcão não vende.
    const caixa = openSession({ companyId, userId: operador, openingCents: 10_000 });
    expect(caixa.status).toBe('open');

    // 2. VENDER. Duas camisetas, R$ 20,00 em dinheiro para R$ 100,00.
    const { sale } = createSale({
      companyId,
      userId: operador,
      cashSessionId: caixa.id,
      items: [{ productId: camiseta, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 12_000 }],
      idempotencyKey: 'macro-pj-1',
    });
    expect([sale.total_cents, sale.change_cents]).toEqual([10_000, 2_000]);

    // 3. ESTOQUE. Saiu exatamente o que foi vendido.
    expect(getBalance(companyId, camiseta)).toBe(8);

    // 4. FINANCEIRO. A venda em dinheiro não deixa conta a receber aberta.
    expect(summarize(companyId, 'in').openCents).toBe(0);

    /*
      5. GAVETA. Abertura + o que ENTROU em espécie − o troco devolvido.

      R$ 100,00 de abertura, R$ 120,00 recebidos, R$ 20,00 de troco: sobram
      R$ 200,00 na gaveta. O número que interessa aqui é o do DINHEIRO que
      passou pelo caixa, e não o total da venda — eles só coincidem quando o
      cliente paga o valor exato.
    */
    expect(expectedCents(caixa.id)).toBe(10_000 + 12_000 - 2_000);

    // 6. FECHAR O TURNO conferindo o que está na gaveta.
    const fechado = closeSession({
      companyId,
      sessionId: caixa.id,
      userId: operador,
      countedCents: 20_000,
    });
    expect([fechado.status, fechado.difference_cents]).toEqual(['closed', 0]);
  });

  it('a venda aparece no DRE do dia em que ela aconteceu', () => {
    const { companyId, operador } = loja['preco-justo'];
    const camiseta = produtoComSaldo('preco-justo', 'Camiseta Polo', 5_000, 10);
    const caixa = openSession({ companyId, userId: operador, openingCents: 0 });

    createSale({
      companyId,
      userId: operador,
      cashSessionId: caixa.id,
      items: [{ productId: camiseta, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
      idempotencyKey: 'macro-pj-dre',
    });

    // A venda foi agora; o recorte é o dia da LOJA, e não o de Greenwich.
    const hoje = hojeNaLoja();
    expect(incomeStatement(companyId, hoje, hoje).reconciliation.panelRevenueCents).toBe(5_000);
  });
});

// ============================================================================
// GRINGA — vende o próprio, e só o próprio
// ============================================================================

describe('Gringa: venda com cliente, e nada da vizinha', () => {
  it('vende o próprio produto para o próprio cliente', () => {
    const { companyId, operador } = loja['gringa'];
    const bolsa = produtoComSaldo('gringa', 'Bolsa importada', 25_000, 3);
    const cliente = createCustomer(companyId, { name: 'Ana', document: '39053344705' });
    const caixa = openSession({ companyId, userId: operador, openingCents: 0 });

    const { sale } = createSale({
      companyId,
      userId: operador,
      cashSessionId: caixa.id,
      customerId: String(cliente.id),
      items: [{ productId: bolsa, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 25_000 }],
      idempotencyKey: 'macro-gr-1',
    });

    expect(sale.total_cents).toBe(25_000);
    expect(getBalance(companyId, bolsa)).toBe(2);
  });

  it('e o produto do Preço Justo é recusado no PDV da Gringa', () => {
    const doVizinho = produtoComSaldo('preco-justo', 'Camiseta Polo', 5_000, 10);
    const { companyId, operador } = loja['gringa'];
    const caixa = openSession({ companyId, userId: operador, openingCents: 0 });

    expect(() =>
      createSale({
        companyId,
        userId: operador,
        cashSessionId: caixa.id,
        items: [{ productId: doVizinho, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        idempotencyKey: 'macro-gr-cruzada',
      }),
    ).toThrow();

    // E o saldo do vizinho não se moveu.
    expect(getBalance(loja['preco-justo'].companyId, doVizinho)).toBe(10);
  });
});

// ============================================================================
// PJ MOTORS — moto no pátio, plaquinha, venda
// ============================================================================

describe('PJ Motors: moto → plaquinha → venda → dono', () => {
  it('a moto vendida leva a plaquinha, e a plaquinha leva o dono', () => {
    const { companyId, operador } = loja['pj-motors'];
    const bancada = bancadaDe('pj-motors', 'pj-patio');

    // 1. O produto serializado, com uma unidade de verdade.
    const modelo = createProduct(companyId, { name: 'Moto eletrica', priceCents: 1_000_000 }).id;
    updateProduct(companyId, modelo, { serialized: true });
    const [unitId] = createUnits(companyId, modelo, 1, {
      entryReferenceType: 'entrada',
      entryReferenceId: 'nf-1',
      locationId: null,
    });
    applyMovement({
      companyId,
      productId: modelo,
      movementType: 'in',
      quantity: 1,
      referenceType: 'entrada',
      referenceId: 'nf-1',
      unitIds: [unitId],
    });

    // 2. A PLAQUINHA — moto do PÁTIO, destinada à venda.
    const moto = createEquipment({
      companyId,
      workshopId: bancada,
      userId: operador,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Shineray',
      model: 'Patio',
      chassis: 'CH-MACRO-1',
    });
    expect(plaquinhasVinculaveis(companyId).map((p) => p.id)).toContain(moto.id);

    vincularUnidade({ companyId, unitId, equipmentId: moto.id, userId: operador });

    // 3. A VENDA, com cliente — é ele que recebe a garantia.
    const comprador = createCustomer(companyId, { name: 'Bruno', document: '52998224725' });
    const caixa = openSession({ companyId, userId: operador, openingCents: 0 });
    const { sale } = createSale({
      companyId,
      userId: operador,
      cashSessionId: caixa.id,
      customerId: String(comprador.id),
      items: [{ productId: modelo, quantity: 1, unitIds: [unitId] }],
      payments: [{ method: 'dinheiro', amountCents: 1_000_000 }],
      idempotencyKey: 'macro-pj-moto',
    });
    expect(sale.total_cents).toBe(1_000_000);

    // 4. A PLAQUINHA GUARDA O DONO — é o que liga a garantia à moto.
    const depois = getConnection()
      .prepare('SELECT sale_status, owner_customer_id FROM core_equipment WHERE id = ?')
      .get(moto.id) as { sale_status: string; owner_customer_id: string | null };
    expect(depois.sale_status).toBe('SOLD');
    expect(depois.owner_customer_id).toBe(String(comprador.id));

    // 5. E o estoque zerou.
    expect(getBalance(companyId, modelo)).toBe(0);
  });
});

// ============================================================================
// OFICINA — moto do cliente, OS, e o papel com a identidade certa
// ============================================================================

describe('Oficina: moto externa → OS → papel da OFICINA', () => {
  it('a máquina do cliente entra, vira OS, e o papel diz Oficina', () => {
    const { companyId, operador } = loja['oficina'];
    const bancada = bancadaDe('oficina', 'oficina-mobilidade');
    const dono = createCustomer(companyId, { name: 'Carla', document: '98765432100' });

    // 1. A MÁQUINA DO CLIENTE — externa, com dono desde o primeiro dia.
    const moto = createEquipment({
      companyId,
      workshopId: bancada,
      userId: operador,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: String(dono.id),
      brand: 'Honda',
      model: 'Biz',
      chassis: 'CH-MACRO-2',
    });

    // Ela NUNCA é estoque de venda — nem aqui, nem na PJ Motors.
    expect(plaquinhasVinculaveis(companyId).map((p) => p.id)).not.toContain(moto.id);
    expect(plaquinhasVinculaveis(loja['pj-motors'].companyId).map((p) => p.id)).not.toContain(
      moto.id,
    );

    // 2. A ORDEM DE SERVIÇO.
    const osId = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_service_orders
           (id, company_id, workshop_id, number, status, complaint, customer_id, equipment_id,
            created_at, updated_at)
         VALUES (?, ?, ?, 1, 'em_aberto', 'Não liga', ?, ?, ?, ?)`,
      )
      .run(osId, companyId, bancada, String(dono.id), moto.id, agora, agora);

    // 3. O PAPEL. É este o defeito que o dono apontou pelo nome.
    const papel = renderServiceOrderA4(companyId, osId);
    expect(papel.marca).toBe('Oficina');
    expect(papel.html).not.toContain('PJ Motors');
    expect(papel.html).not.toContain('Grupo Sampaio');
  });
});
