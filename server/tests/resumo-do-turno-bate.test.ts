/**
 * O RESUMO DO TURNO PRECISA BATER COM A GAVETA.
 *
 * ============================================================================
 * DOIS NÚMEROS VERDADEIROS QUE SE CONTRADIZEM NA TELA
 * ============================================================================
 *
 * O fechamento mostra "Recebido no turno, por meio" e, ao lado, o esperado em
 * gaveta. Os dois vêm do servidor e os dois estão certos — só que respondem a
 * perguntas diferentes:
 *
 *   `byMethod.dinheiro`  quanto o cliente ENTREGOU em espécie (a venda inteira)
 *   `expectedCents`      quanto FICOU na gaveta (entregue menos o troco)
 *
 * Numa venda de R$ 50 paga com uma nota de R$ 100, o primeiro diz R$ 100 e o
 * segundo diz R$ 50. Quem está conferindo lê "recebido em dinheiro: R$ 100",
 * conta R$ 50 na gaveta, e passa a procurar um erro que não existe. Nada na
 * tela dizia que a diferença era o troco.
 *
 * O conserto não é mudar nenhum dos dois — é o servidor mandar TAMBÉM o troco
 * do turno, para a tela conseguir escrever a conta inteira:
 *
 *     entregue em espécie − troco devolvido = o que ficou na gaveta
 *
 * ============================================================================
 * O QUE ESTE TESTE NÃO DEIXA VOLTAR
 * ============================================================================
 *
 *   - o resumo sem o troco, que é o que impedia a tela de explicar;
 *   - o troco contado errado (venda cancelada entrando na conta);
 *   - a aritmética quebrando: entregue − troco tem que dar o movimento da
 *     gaveta, sempre.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale, cancelSale } = await import('../src/services/core/SalesService.js');
const { openSession, getSummary } = await import('../src/services/core/CashService.js');

let empresa: string;
let usuario: string;
let produto: string;
let caixa: string;

/** O total de um meio no resumo. */
function porMeio(sessionId: string, metodo: string): number {
  const r = getSummary(empresa, sessionId)!;
  return r.byMethod.find((m) => m.method === metodo)?.total ?? 0;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'CAIXA_RES',
    displayName: 'Caixa',
    password: 'Teste@Res2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

  // Produto de R$ 50,00.
  produto = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 5000 }).id;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 20,
    referenceType: 'ajuste',
    referenceId: 'e1',
  });

  caixa = openSession({ companyId: empresa, userId: usuario, openingCents: 0 }).id;
});

/** Vende uma camiseta recebendo `entregue` em espécie. */
function venderComNota(entregue: number, chave: string) {
  return createSale({
    companyId: empresa,
    userId: usuario,
    cashSessionId: caixa,
    items: [{ productId: produto, quantity: 1 }],
    payments: [{ method: 'dinheiro', amountCents: entregue }],
    idempotencyKey: chave,
  }).sale;
}

// ============================================================================

describe('o troco do turno vem no resumo', () => {
  it('nota de R$ 100 numa venda de R$ 50: entregue 100, troco 50, gaveta 50', () => {
    venderComNota(10000, 'v1');
    const resumo = getSummary(empresa, caixa)!;

    // Os dois números que se contradiziam na tela, agora com a ponte entre eles.
    expect(porMeio(caixa, 'dinheiro')).toBe(10000);
    expect(resumo.changeCents).toBe(5000);
    expect(resumo.expectedCents).toBe(5000);

    // A conta que a tela vai escrever.
    expect(porMeio(caixa, 'dinheiro') - resumo.changeCents).toBe(resumo.expectedCents);
  });

  it('venda sem troco não inventa troco', () => {
    venderComNota(5000, 'v1');
    const resumo = getSummary(empresa, caixa)!;

    expect(resumo.changeCents).toBe(0);
    expect(resumo.expectedCents).toBe(5000);
  });

  it('o troco soma o turno inteiro', () => {
    venderComNota(10000, 'v1'); // troco 50
    venderComNota(20000, 'v2'); // troco 150
    const resumo = getSummary(empresa, caixa)!;

    expect(resumo.changeCents).toBe(20000);
    expect(porMeio(caixa, 'dinheiro') - resumo.changeCents).toBe(resumo.expectedCents);
  });

  it('venda cancelada sai da conta do troco — senão o esperado nunca fecha', () => {
    const venda = venderComNota(10000, 'v1');
    venderComNota(10000, 'v2');
    cancelSale({ companyId: empresa, userId: usuario, saleId: venda.id, reason: 'erro' });

    const resumo = getSummary(empresa, caixa)!;
    /*
      O cancelamento devolve o líquido da venda à gaveta e tira a venda da
      conferência. Deixar o troco dela no total quebraria a aritmética que a
      tela escreve — e quem lê acharia que faltam R$ 50 na gaveta.
    */
    expect(resumo.changeCents).toBe(5000);
    expect(porMeio(caixa, 'dinheiro') - resumo.changeCents).toBe(resumo.expectedCents);
  });
});

// ============================================================================

describe('a composição do esperado continua inteira', () => {
  it('os movimentos vêm com tipo, valor e nota — é deles que a tela monta a conta', () => {
    venderComNota(10000, 'v1');
    const resumo = getSummary(empresa, caixa)!;

    /*
      O servidor sempre mandou `movements` completo e a tela jogava fora,
      guardando só dois números. No fim do dia, "esperado R$ 350" sem dizer de
      onde veio obriga o operador a confiar ou a abrir outra tela.
    */
    const venda = resumo.movements.find((m) => m.movement_type === 'sale');
    expect(venda).toBeTruthy();
    expect(venda!.amount_cents).toBe(5000);
    expect(String(venda!.note ?? '')).toMatch(/Venda #/);
  });
});

// ============================================================================

describe('a gaveta só aceita os três tipos de movimento que existem', () => {
  it('tipo inventado é recusado — e não vira crédito positivo', async () => {
    const { addMovement } = await import('../src/services/core/CashService.js');

    /*
      A rota repassa `req.body?.movementType` cru, e `addMovement` decidia o
      sinal por `=== 'withdrawal' ? -abs : +abs`. O tipo TypeScript não existe
      em execução: qualquer outro texto — 'sale', 'ajuste', 'x' — caía no ramo
      POSITIVO e virava dinheiro entrando na gaveta, com um tipo que nenhum
      relatório sabe ler.
    */
    expect(() =>
      addMovement({
        companyId: empresa,
        sessionId: caixa,
        userId: usuario,
        movementType: 'sale' as never,
        amountCents: 50000,
      }),
    ).toThrow(/movimento/i);

    // E a gaveta não mexeu.
    expect(getSummary(empresa, caixa)!.expectedCents).toBe(0);
  });

  it('os três tipos legítimos continuam passando', async () => {
    const { addMovement } = await import('../src/services/core/CashService.js');

    addMovement({
      companyId: empresa,
      sessionId: caixa,
      userId: usuario,
      movementType: 'supply',
      amountCents: 30000,
    });
    addMovement({
      companyId: empresa,
      sessionId: caixa,
      userId: usuario,
      movementType: 'withdrawal',
      amountCents: 10000,
      // A sangria diz para onde o dinheiro foi (H-caixa-seguranca-08).
      note: 'Depósito no banco',
    });
    addMovement({
      companyId: empresa,
      sessionId: caixa,
      userId: usuario,
      movementType: 'adjustment',
      amountCents: 500,
    });

    expect(getSummary(empresa, caixa)!.expectedCents).toBe(20500);
  });
});
