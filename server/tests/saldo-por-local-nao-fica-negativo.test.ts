/**
 * O LOCAL DE ONDE A MERCADORIA SAIU.
 *
 * ============================================================================
 * GERAL: −3, COM TRÊS PEÇAS NA VITRINE
 * ============================================================================
 *
 * `core_stock_movements.location_id` é preenchido por UM chamador em todo o
 * projeto: a rota de movimento manual. Venda, consumo de peça em OS, entrada
 * de nota, devolução — todos gravam NULL. E `balanceByLocation` faz
 * `COALESCE(location_id, <padrão>)`, que é a decisão certa para o movimento
 * ANTIGO (gravado antes da coluna existir) e a decisão errada para a saída de
 * hoje: ela é cobrada do local padrão, tenha ele saldo ou não.
 *
 * Então: chega mercadoria, ela é transferida inteira para a Vitrine, alguém
 * vende três — e o relatório de posição mostra GERAL com −3 e Vitrine com o
 * saldo cheio. O total da empresa está certo (o `CHECK (quantity >= 0)` cuida
 * disso); a distribuição é ficção.
 *
 * E não é só um relatório feio. `transferStock` VALIDA contra esse número:
 *
 *   - a Vitrine aparece com mais do que tem, e o sistema oferece transferir de
 *     volta peças que já saíram pela porta;
 *   - o GERAL negativo recusa transferência legítima de outro produto no mesmo
 *     local, porque a conta de origem está envenenada.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * A saída sem local declarado passa a ESCOLHER o local, e a escolha é a única
 * que não inventa nada: o local que TEM a mercadoria.
 *
 *   1. o padrão, se ele cobre a saída — é onde a mercadoria está quando
 *      ninguém mexeu em local nenhum, que é o caso da maioria das empresas;
 *   2. senão, o local com mais saldo que cubra a saída inteira;
 *   3. senão, o local com mais saldo.
 *
 * O passo 3 é o resto honesto: quando a mercadoria está espalhada em pedaços
 * menores que a saída, UMA linha de movimento não consegue dizer de onde saiu
 * cada pedaço — e rachar a linha quebraria a chave de idempotência do razão,
 * que é a proteção mais forte deste sistema. Nesse caso o local mais cheio
 * fica devendo, e o relatório mostra isso — o que é diferente de cobrar do
 * padrão um saldo que nunca esteve lá.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 *  - saída sai do local que tem, e não do padrão vazio
 *  - o padrão continua sendo o primeiro escolhido quando cobre
 *  - local declarado pelo chamador é respeitado, mesmo sem saldo lá
 *  - a transferência passa a enxergar o saldo verdadeiro dos dois lados
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const {
  createLocation,
  ensureDefaultLocation,
  balanceByLocation,
  transferStock,
} = await import('../src/services/core/StockLocationService.js');

let loja: string;
let produto: string;
let padrao: string;
let vitrine: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  produto = String(createProduct(loja, { name: 'Jaqueta', priceCents: 32_900 }).id);
  padrao = ensureDefaultLocation(loja).id;
  vitrine = String(createLocation(loja, { code: 'VIT', name: 'Vitrine' }).id);
});

function entrada(quantidade: number, locationId: string | null, ref: string) {
  applyMovement({
    companyId: loja,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: ref,
    locationId,
  });
}

/** A venda: o chamador que NÃO sabe de local nenhum. */
function venda(quantidade: number, ref: string) {
  applyMovement({
    companyId: loja,
    productId: produto,
    movementType: 'out',
    quantity: quantidade,
    referenceType: 'sale',
    referenceId: ref,
  });
}

function porLocal(): Record<string, number> {
  const mapa: Record<string, number> = {};
  for (const l of balanceByLocation(loja, produto)) mapa[l.name] = l.quantity;
  return mapa;
}

// ============================================================================

describe('a saída sai de onde a mercadoria está', () => {
  it('tudo na Vitrine: a venda desconta da Vitrine, e o GERAL não fica negativo', () => {
    entrada(10, vitrine, 'nf-1');
    venda(3, 'v-1');

    const saldos = porLocal();
    // Antes: { 'Geral': -3, 'Vitrine': 10 } — o total certo, a posição ficção.
    expect(saldos['Vitrine']).toBe(7);
    expect(saldos['Estoque geral'] ?? 0).toBe(0);
  });

  it('nenhum local fica devendo quando algum deles cobre', () => {
    entrada(10, vitrine, 'nf-2');
    venda(3, 'v-2');
    venda(4, 'v-3');

    for (const linha of balanceByLocation(loja, produto)) {
      expect(linha.quantity).toBeGreaterThanOrEqual(0);
    }
  });

  it('o padrão continua sendo o primeiro escolhido quando ele cobre', () => {
    /*
      A empresa que nunca mexeu em local nenhum não pode sentir esta mudança:
      todo saldo está no padrão, e é dele que a saída tem de sair.
    */
    entrada(10, padrao, 'nf-3');
    entrada(10, vitrine, 'nf-4');
    venda(4, 'v-4');

    const saldos = porLocal();
    expect(saldos['Estoque geral']).toBe(6);
    expect(saldos['Vitrine']).toBe(10);
  });

  it('e movimento sem local nenhum, dos dois lados, continua como sempre foi', () => {
    entrada(10, null, 'nf-5');
    venda(4, 'v-5');

    // Entrada sem local cai no padrão (é o COALESCE de sempre), e a saída sai
    // de lá — nada muda para quem não usa locais.
    expect(porLocal()['Estoque geral']).toBe(6);
  });
});

// ============================================================================

describe('o local declarado pelo chamador é respeitado', () => {
  it('quem diz de onde tira manda — mesmo que a conta fique devendo ali', () => {
    /*
      A rota de movimento manual EXISTE para o operador dizer o que aconteceu
      na prateleira. Se ele declara o local, o sistema não pode "corrigir" a
      escolha dele: o ajuste é justamente o gesto de acertar o que o sistema
      pensava.
    */
    entrada(10, vitrine, 'nf-6');
    applyMovement({
      companyId: loja,
      productId: produto,
      movementType: 'out',
      quantity: 2,
      referenceType: 'ajuste',
      referenceId: 'aj-1',
      locationId: padrao,
      reason: 'quebra',
    });

    const saldos = porLocal();
    expect(saldos['Estoque geral']).toBe(-2);
    expect(saldos['Vitrine']).toBe(10);
  });
});

// ============================================================================

describe('a transferência passa a enxergar o saldo verdadeiro', () => {
  it('não oferece devolver da Vitrine peça que já saiu pela porta', () => {
    entrada(10, vitrine, 'nf-7');
    venda(8, 'v-6');

    // Sobraram 2 na Vitrine. Transferir 5 de volta é impossível — e antes o
    // sistema aceitava, porque a Vitrine ainda "tinha" 10.
    expect(() =>
      transferStock({
        companyId: loja,
        productId: produto,
        fromLocationId: vitrine,
        toLocationId: padrao,
        quantity: 5,
      }),
    ).toThrow(/insuficiente/i);

    // E os 2 que existem transferem normalmente.
    const r = transferStock({
      companyId: loja,
      productId: produto,
      fromLocationId: vitrine,
      toLocationId: padrao,
      quantity: 2,
    });
    expect(r.reference).toBeTruthy();
    expect(porLocal()['Estoque geral']).toBe(2);
  });

  it('e o GERAL negativo não recusa mais transferência legítima', () => {
    entrada(6, vitrine, 'nf-8');
    entrada(4, padrao, 'nf-9');
    venda(6, 'v-7');

    /*
      A venda de 6 não cabe no padrão (4), e cabe na Vitrine (6): sai de lá.
      O padrão fica com os 4 que realmente estão lá — e a transferência deles
      é legítima. Antes o padrão marcava −2 e esta transferência era recusada.
    */
    const r = transferStock({
      companyId: loja,
      productId: produto,
      fromLocationId: padrao,
      toLocationId: vitrine,
      quantity: 4,
    });
    expect(r.reference).toBeTruthy();
    expect(porLocal()['Vitrine']).toBe(4);
  });
});
