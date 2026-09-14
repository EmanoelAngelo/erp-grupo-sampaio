/**
 * A CONTAGEM COM MOTO FALTANDO PRECISA TER FIM.
 *
 * ============================================================================
 * O BECO
 * ============================================================================
 *
 * Duas regras deste sistema, cada uma certa sozinha, se trancavam uma na
 * outra:
 *
 *   - `openInventoryCount` CONGELA o esperado no instante em que a contagem
 *     abre. É a decisão certa: fazer a conta na hora de aplicar faria o acerto
 *     absorver tudo o que foi vendido no intervalo;
 *
 *   - o acerto de produto SERIALIZADO é recusado. Também é certo: "faltam 2"
 *     não diz QUAIS 2, e ajustar pelo número deixaria dois chassis marcados
 *     como no pátio sem estar.
 *
 * O conferente conta o pátio, acha uma moto a menos, e o sistema manda fazer
 * o que tem de ser feito: dar baixa NAQUELA moto, pelo chassi, em Estoque ›
 * Unidades. Ele faz. O saldo cai e passa a bater com o que ele contou.
 *
 * E a contagem continua travada. Porque `applyInventoryCount` compara o
 * contado com o ESPERADO CONGELADO — que não mudou e nunca vai mudar — e
 * estoura de novo com a mesma frase, mandando fazer o que já foi feito. A
 * única saída era cancelar a contagem e recontar o pátio inteiro.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Para o serializado, a pergunta certa não é "o contado bate com o esperado de
 * quando a contagem abriu?" — é "o contado bate com o que o sistema diz AGORA,
 * depois das baixas peça a peça?".
 *
 * Se bate, a divergência foi resolvida pelo caminho que o próprio sistema
 * mandou usar, e não há acerto a fazer: a linha passa. Se não bate, a recusa
 * continua — e passa a dizer QUANTAS ainda faltam identificar, que é o número
 * que quem está no pátio precisa.
 *
 * O não-serializado não muda em nada: para ele o acerto por diferença é o
 * caminho, e a diferença é contra o esperado congelado.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection, withTransaction } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { listUnits, createUnits } = await import('../src/services/core/ProductUnitService.js');
const { openInventoryCount, recordCount, applyInventoryCount } = await import(
  '../src/services/core/InventoryCountService.js'
);

let loja: string;
let moto: string;
let parafuso: string;
const USUARIO = 'u-conferente';

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });

  moto = String(createProduct(loja, { name: 'Scooter 3000W', priceCents: 1_290_000 }).id);
  getConnection().prepare('UPDATE core_products SET serialized = 1 WHERE id = ?').run(moto);
  parafuso = String(createProduct(loja, { name: 'Parafuso M8', priceCents: 250 }).id);

  // Três motos entram no pátio, cada uma com a sua plaquinha.
  withTransaction(() => {
    // A plaquinha nasce com a entrada: o funil recusa mover serializado sem
    // dizer QUAIS peças se moveram.
    const plaquinhas = createUnits(loja, moto, 3, {
      entryReferenceType: 'nfe_entrada',
      entryReferenceId: 'nf-motos',
    });
    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'in',
      quantity: 3,
      unitIds: plaquinhas,
      referenceType: 'nfe_entrada',
      referenceId: 'nf-motos',
    });
    applyMovement({
      companyId: loja,
      productId: parafuso,
      movementType: 'in',
      quantity: 100,
      referenceType: 'nfe_entrada',
      referenceId: 'nf-parafusos',
    });
  });
});

/** A baixa da moto que sumiu — pelo chassi, que é o caminho que o sistema manda usar. */
function darBaixaNaMoto(): string {
  const unidade = listUnits(loja, moto, { status: 'in_stock' })[0];
  withTransaction(() => {
    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'out',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: `sumiu-${unidade.id}`,
      unitIds: [unidade.id],
      userId: USUARIO,
      reason: 'não estava no pátio',
    });
  });
  return unidade.id;
}

function abrirEContar(contado: { produto: string; quantidade: number }[]): string {
  const conta = openInventoryCount({
    companyId: loja,
    userId: USUARIO,
    productIds: contado.map((c) => c.produto),
  });
  for (const c of contado) {
    recordCount({
      companyId: loja,
      userId: USUARIO,
      countId: String(conta.id),
      productId: c.produto,
      countedQuantity: c.quantidade,
    });
  }
  return String(conta.id);
}

function aplicar(countId: string) {
  return applyInventoryCount({
    companyId: loja,
    userId: USUARIO,
    countId,
    reason: 'contagem do pátio',
  });
}

// ============================================================================

describe('a contagem do pátio chega ao fim', () => {
  it('depois da baixa pelo chassi, o acerto APLICA', () => {
    const conta = abrirEContar([{ produto: moto, quantidade: 2 }]);

    // O sistema mandou dar baixa peça a peça. O conferente deu.
    darBaixaNaMoto();
    expect(getBalance(loja, moto)).toBe(2);

    const aplicada = aplicar(conta);

    // Antes: estourava com CORE_SERIALIZED_NEEDS_UNIT para sempre, mandando
    // fazer o que já tinha sido feito. A saída era cancelar e recontar.
    expect(aplicada.status).toBe('aplicada');
  });

  it('e o acerto NÃO cria movimento nenhum — a baixa já foi o acerto', () => {
    const conta = abrirEContar([{ produto: moto, quantidade: 2 }]);
    darBaixaNaMoto();
    aplicar(conta);

    const doInventario = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_stock_movements
          WHERE company_id = ? AND reference_type = 'inventory_count'`,
      )
      .get(loja) as { n: number };
    expect(doInventario.n).toBe(0);
    // E o saldo é o que a baixa deixou — o acerto não somou nem tirou nada.
    expect(getBalance(loja, moto)).toBe(2);
  });
});

// ============================================================================

describe('a recusa continua de pé, e passa a dizer quantas faltam', () => {
  it('sem baixa nenhuma, aplicar é recusado', () => {
    const conta = abrirEContar([{ produto: moto, quantidade: 2 }]);

    let erro: { code?: string; message: string } | null = null;
    try {
      aplicar(conta);
    } catch (e) {
      erro = e as { code?: string; message: string };
    }

    expect(erro?.code).toBe('CORE_SERIALIZED_NEEDS_UNIT');
    expect(erro?.message).toMatch(/Scooter 3000W/);
    // O número que falta identificar tem de estar na frase: sem ele, quem
    // está no pátio não sabe quantas plaquinhas procurar.
    expect(erro?.message).toMatch(/1/);
  });

  it('com baixa parcial, a recusa diz o que ainda falta', () => {
    // Duas sumiram, o conferente só achou uma para dar baixa.
    const conta = abrirEContar([{ produto: moto, quantidade: 1 }]);
    darBaixaNaMoto();

    let erro: { message: string } | null = null;
    try {
      aplicar(conta);
    } catch (e) {
      erro = e as { message: string };
    }
    expect(erro?.message).toMatch(/Scooter 3000W/);
    // Saldo 2, contado 1: falta UMA.
    expect(getBalance(loja, moto)).toBe(2);
  });

  it('e a contagem continua ABERTA — nada foi aplicado pela metade', () => {
    const conta = abrirEContar([
      { produto: parafuso, quantidade: 98 },
      { produto: moto, quantidade: 2 },
    ]);

    expect(() => aplicar(conta)).toThrow();

    // O parafuso tinha diferença e NÃO pode ter sido acertado: a transação
    // inteira volta atrás.
    expect(getBalance(loja, parafuso)).toBe(100);
    const estado = getConnection()
      .prepare('SELECT status FROM core_inventory_counts WHERE id = ?')
      .get(conta) as { status: string };
    expect(estado.status).toBe('aberta');
  });
});

// ============================================================================

describe('o produto comum não muda em nada', () => {
  it('a diferença continua sendo contra o esperado congelado', () => {
    const conta = abrirEContar([{ produto: parafuso, quantidade: 98 }]);

    /*
      Entre contar e aplicar a loja continuou vendendo. O acerto é DIFERENÇA
      (−2), somada ao saldo do momento — e não substituição, que devolveria
      ao estoque as três vendidas no intervalo.
    */
    withTransaction(() => {
      applyMovement({
        companyId: loja,
        productId: parafuso,
        movementType: 'out',
        quantity: 3,
        referenceType: 'sale',
        referenceId: 'v-1',
      });
    });

    aplicar(conta);
    expect(getBalance(loja, parafuso)).toBe(95);
  });
});
