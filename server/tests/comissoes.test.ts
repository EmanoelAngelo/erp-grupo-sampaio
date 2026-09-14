/**
 * Comissão de venda.
 *
 * O plano desta rodada exige, em maiúsculas, "apuração com linha de estorno
 * desde o primeiro commit". O motivo é direto: comissão que só sabe somar paga
 * o vendedor duas vezes na primeira venda cancelada, e é o erro mais difícil
 * de consertar depois — o dinheiro já saiu.
 *
 * Por isso a metade deste arquivo é sobre desfazer, não sobre calcular.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale, cancelSale } = await import('../src/services/core/SalesService.js');
const { createSaleReturn } = await import('../src/services/core/SaleReturnService.js');
const {
  createGroup,
  fecharPeriodo,
  listEntries,
  setMemberGroup,
  setTier,
  summarize,
  updateGroup,
} = await import('../src/services/core/CommissionService.js');
const { systemCategoryId } = await import('../src/services/core/FinanceSetupService.js');

let empresa: string;
let caixa: string;
let vendedor: string;
let produto: string;
let grupo: string;

/** Soma das linhas de comissão de uma venda — o que o vendedor tem a receber. */
function saldoDaVenda(saleId: string): number {
  const r = getConnection()
    .prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS t FROM core_commission_entries WHERE sale_id = ?',
    )
    .get(saleId) as { t: number };
  return r.t;
}

function vender(chave: string, opcoes: { quantidade?: number; desconto?: number } = {}) {
  const q = opcoes.quantidade ?? 1;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: q,
    referenceType: 'ajuste',
    referenceId: `e-${chave}`,
  });
  return createSale({
    companyId: empresa,
    userId: caixa,
    sellerId: vendedor,
    items: [{ productId: produto, quantity: q }],
    discountCents: opcoes.desconto,
    /*
      R$ 700 em dinheiro cobre a maior venda deste arquivo (R$ 600) com troco.
      Era R$ 10.000 para qualquer venda — e o servidor passou a recusar pagamento
      acima de cem vezes o que falta receber (D-pdv-teclado-M03): R$ 10.000 numa
      venda de R$ 80 é o código de barras no campo de valor. A comissão não
      depende do troco, então o valor menor não muda nenhuma conta abaixo.
    */
    payments: [{ method: 'dinheiro', amountCents: 70_000 }],
    idempotencyKey: chave,
  });
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
  caixa = await upsertUser({
    login: 'CAIXA_COM',
    displayName: 'Operador de Caixa',
    password: 'Teste@Com2026',
  });
  linkUserToCompany(caixa, empresa, 'gestor', true);
  vendedor = await upsertUser({
    login: 'VEND_COM',
    displayName: 'Fernanda Vendas',
    password: 'Teste@Vend2026',
  });
  linkUserToCompany(vendedor, empresa, 'atendente', true);

  // Produto de R$ 100,00.
  produto = createProduct(empresa, { name: 'Tênis Runner', priceCents: 10_000 }).id;

  grupo = createGroup(empresa, 'Loja').id;
  setTier(empresa, grupo, 0, 200); // 2% a partir de zero
  setMemberGroup(empresa, vendedor, grupo);
});

describe('quem vendeu precisa ser da casa', () => {
  it('vendedor de outra empresa é recusado', async () => {
    const outra = upsertCompany({
      slug: 'pj-motors',
      legalName: 'PJ Motors Ltda',
      tradeName: 'PJ Motors',
      kind: 'store',
    });
    const forasteiro = await upsertUser({
      login: 'VEND_FORA',
      displayName: 'De Fora',
      password: 'Teste@Fora2026',
    });
    linkUserToCompany(forasteiro, outra, 'atendente', true);

    applyMovement({
      companyId: empresa,
      productId: produto,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e-fora',
    });
    expect(() =>
      createSale({
        companyId: empresa,
        userId: caixa,
        sellerId: forasteiro,
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
        idempotencyKey: 'v-fora',
      }),
    ).toThrow(/não faz parte desta operação/i);
  });

  it('id inventado é recusado', () => {
    applyMovement({
      companyId: empresa,
      productId: produto,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e-inv',
    });
    expect(() =>
      createSale({
        companyId: empresa,
        userId: caixa,
        sellerId: 'nao-existe',
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
        idempotencyKey: 'v-inv',
      }),
    ).toThrow(/não faz parte/i);
  });
});

describe('a apuração', () => {
  it('venda de R$ 100 a 2% gera R$ 2,00', () => {
    const { sale } = vender('v1');
    const linhas = listEntries(empresa);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].amount_cents).toBe(200);
    expect(linhas[0].seller_id).toBe(vendedor);
    expect(saldoDaVenda(sale.id)).toBe(200);
  });

  /**
   * A base é o subtotal MENOS o desconto de cabeçalho. O acréscimo não entra:
   * juros de cartão e frete não são mérito de venda.
   */
  it('o desconto de cabeçalho reduz a base', () => {
    vender('v1', { desconto: 2_000 }); // R$ 100 - R$ 20 = R$ 80
    expect(listEntries(empresa)[0].amount_cents).toBe(160);
    expect(listEntries(empresa)[0].base_cents).toBe(8_000);
  });

  it('a faixa escolhida é a maior que o valor alcança', () => {
    setTier(empresa, grupo, 50_000, 300); // 3% a partir de R$ 500
    vender('v1', { quantidade: 6 }); // R$ 600
    expect(listEntries(empresa)[0].rate_bps).toBe(300);
    expect(listEntries(empresa)[0].amount_cents).toBe(1_800);
  });

  /**
   * A REGRA MUDA COM O TEMPO, e é por isso que a linha é gravada em vez de
   * recalculada. Comissão já apurada não pode mudar de valor depois.
   */
  it('mudar o percentual depois não altera o que já foi apurado', () => {
    vender('v1');
    expect(listEntries(empresa)[0].amount_cents).toBe(200);

    setTier(empresa, grupo, 0, 500); // sobe para 5%
    expect(listEntries(empresa)[0].amount_cents).toBe(200);
  });

  it('mover o vendedor de grupo não altera o que já foi apurado', () => {
    vender('v1');
    const outro = createGroup(empresa, 'Gerência').id;
    setTier(empresa, outro, 0, 1_000);
    setMemberGroup(empresa, vendedor, outro);
    expect(listEntries(empresa)[0].amount_cents).toBe(200);
  });
});

describe('venda sem comissão não derruba nada, e não some', () => {
  /** É o estado de TODA instalação no dia do deploy. */
  it('vendedor sem grupo: a venda acontece e não gera linha', () => {
    setMemberGroup(empresa, vendedor, null);
    const { sale } = vender('v1');
    expect(sale.total_cents).toBe(10_000);
    expect(listEntries(empresa)).toHaveLength(0);
  });

  it('a venda sem comissão aparece contada no balde da apuração', () => {
    setMemberGroup(empresa, vendedor, null);
    vender('v1');
    const { semComissao } = summarize(empresa, '2000-01-01', '2100-01-01');
    expect(semComissao.vendas).toBe(1);
    expect(semComissao.totalCents).toBe(10_000);
  });

  /**
   * Desativar não apaga: as linhas já apuradas apontam para faixas do grupo, e
   * o histórico precisa continuar explicável.
   */
  it('grupo desativado para de comissionar, e o já apurado continua lá', () => {
    vender('v1');
    expect(listEntries(empresa)).toHaveLength(1);

    updateGroup(empresa, grupo, { active: false });
    vender('v2');

    expect(listEntries(empresa)).toHaveLength(1);
    expect(listEntries(empresa)[0].amount_cents).toBe(200);
  });

  it('grupo sem faixa que cubra o valor não gera linha', () => {
    const alto = createGroup(empresa, 'Alta').id;
    setTier(empresa, alto, 100_000, 500); // só a partir de R$ 1.000
    setMemberGroup(empresa, vendedor, alto);
    vender('v1'); // R$ 100
    expect(listEntries(empresa)).toHaveLength(0);
  });
});

describe('o estorno', () => {
  it('cancelar a venda zera a comissão dela', () => {
    const { sale } = vender('v1');
    expect(saldoDaVenda(sale.id)).toBe(200);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });
    expect(saldoDaVenda(sale.id)).toBe(0);
  });

  /** A positiva original FICA: apagar esconderia por que a comissão mudou. */
  it('o estorno é linha nova, e a original continua lá', () => {
    const { sale } = vender('v1');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });

    const linhas = listEntries(empresa);
    expect(linhas).toHaveLength(2);
    expect(linhas.some((l) => l.amount_cents === 200 && l.origin_type === 'sale')).toBe(true);
    expect(linhas.some((l) => l.amount_cents === -200 && l.origin_type === 'sale_cancel')).toBe(
      true,
    );
  });

  it('cancelar duas vezes não estorna duas vezes', () => {
    const { sale } = vender('v1');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });
    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'de novo' });
    expect(saldoDaVenda(sale.id)).toBe(0);
    expect(listEntries(empresa)).toHaveLength(2);
  });

  it('devolver metade estorna metade da comissão', () => {
    const { sale } = vender('v1', { quantidade: 2 }); // R$ 200 -> comissão R$ 4,00
    expect(saldoDaVenda(sale.id)).toBe(400);

    const itens = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .all(sale.id) as unknown as { id: string }[];
    createSaleReturn({
      companyId: empresa,
      userId: caixa,
      saleId: sale.id,
      items: [{ saleItemId: itens[0].id, quantity: 1 }],
      reason: 'Teste de devolucao',
      refundMethod: 'dinheiro',
    });

    expect(saldoDaVenda(sale.id)).toBe(200);
  });

  /**
   * O CASO QUE MAIS IMPORTA: devolver parcial e DEPOIS cancelar não pode
   * estornar duas vezes. O cancelamento leva só o que sobrou.
   */
  it('devolver parcial e depois cancelar fecha exatamente em zero', () => {
    const { sale } = vender('v1', { quantidade: 2 });
    const itens = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .all(sale.id) as unknown as { id: string }[];

    createSaleReturn({
      companyId: empresa,
      userId: caixa,
      saleId: sale.id,
      items: [{ saleItemId: itens[0].id, quantity: 1 }],
      reason: 'Teste de devolucao',
      refundMethod: 'dinheiro',
    });
    expect(saldoDaVenda(sale.id)).toBe(200);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });
    expect(saldoDaVenda(sale.id)).toBe(0);
  });

  /**
   * O denominador do estorno é o SUBTOTAL, não o total: a devolução devolve
   * valor bruto de item, e a base comissionável é líquida do desconto de
   * cabeçalho. Com o total, a loja estornaria a MENOS.
   */
  it('venda com desconto de cabeçalho não estorna menos do que apurou', () => {
    const { sale } = vender('v1', { quantidade: 2, desconto: 4_000 }); // 200 - 40 = 160
    expect(saldoDaVenda(sale.id)).toBe(320);

    const itens = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .all(sale.id) as unknown as { id: string }[];
    createSaleReturn({
      companyId: empresa,
      userId: caixa,
      saleId: sale.id,
      items: [{ saleItemId: itens[0].id, quantity: 1 }],
      reason: 'Teste de devolucao',
      refundMethod: 'dinheiro',
    });

    // Metade do subtotal devolvida => metade da comissão estornada.
    expect(saldoDaVenda(sale.id)).toBe(160);
  });
});

describe('o fechamento', () => {
  it('gera uma conta a pagar classificada como folha', () => {
    vender('v1');
    const r = fecharPeriodo({
      companyId: empresa,
      sellerId: vendedor,
      from: '2000-01-01',
      to: '2100-01-01',
      userId: caixa,
    });

    expect(r.totalCents).toBe(200);
    const lanc = getConnection()
      .prepare('SELECT * FROM core_finance_entries WHERE id = ?')
      .get(r.financeEntryId!) as {
      direction: string;
      amount_cents: number;
      status: string;
      category_id: string;
    };
    expect(lanc.direction).toBe('out');
    expect(lanc.amount_cents).toBe(200);
    expect(lanc.status).toBe('open');
    expect(lanc.category_id).toBe(systemCategoryId(empresa, 'folha'));
  });

  it('as linhas fechadas param de aparecer como abertas', () => {
    vender('v1');
    fecharPeriodo({
      companyId: empresa,
      sellerId: vendedor,
      from: '2000-01-01',
      to: '2100-01-01',
    });
    expect(listEntries(empresa)[0].status).toBe('fechado');
  });

  /** A única trava contra pagar duas vezes o mesmo período. */
  it('fechar o mesmo período duas vezes é recusado', () => {
    vender('v1');
    fecharPeriodo({
      companyId: empresa,
      sellerId: vendedor,
      from: '2000-01-01',
      to: '2100-01-01',
    });
    expect(() =>
      fecharPeriodo({
        companyId: empresa,
        sellerId: vendedor,
        from: '2000-01-01',
        to: '2100-01-01',
      }),
    ).toThrow(/já foi fechado/i);
  });

  it('período sem comissão em aberto é recusado', () => {
    expect(() =>
      fecharPeriodo({
        companyId: empresa,
        sellerId: vendedor,
        from: '2000-01-01',
        to: '2100-01-01',
      }),
    ).toThrow(/não há comissão/i);
  });

  /**
   * Estorno que chega depois NÃO reabre o período: conta a pagar já emitida
   * não muda de valor. Ele entra no fechamento seguinte.
   */
  it('estorno posterior não altera a conta a pagar já criada', () => {
    const { sale } = vender('v1');
    const r = fecharPeriodo({
      companyId: empresa,
      sellerId: vendedor,
      from: '2000-01-01',
      to: '2100-01-01',
    });

    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });

    const lanc = getConnection()
      .prepare('SELECT amount_cents FROM core_finance_entries WHERE id = ?')
      .get(r.financeEntryId!) as { amount_cents: number };
    expect(lanc.amount_cents).toBe(200);

    // E o estorno fica em aberto, para o próximo fechamento.
    const estorno = listEntries(empresa).find((l) => l.origin_type === 'sale_cancel');
    expect(estorno?.status).toBe('aberto');
  });

  /**
   * Saldo zero ou negativo não vira conta a pagar: seria um crédito que
   * ninguém sabe cobrar.
   *
   * O caso testado é o ZERO — venda e estorno no mesmo período. O negativo
   * puro exigiria o estorno cair num período SEM a venda que o originou, e a
   * competência do estorno é a data do fato: os dois nascem no mesmo dia.
   * Ambos passam pelo mesmo `if (total > 0)`, então o zero cobre a regra.
   */
  it('saldo zero fecha sem gerar conta a pagar', () => {
    const { sale } = vender('v1');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });

    const r = fecharPeriodo({
      companyId: empresa,
      sellerId: vendedor,
      from: '2000-01-01',
      to: '2100-01-01',
    });
    expect(r.totalCents).toBe(0);
    expect(r.financeEntryId).toBeNull();
    // E as duas linhas ficam fechadas, para não entrarem de novo no mês seguinte.
    expect(listEntries(empresa).every((l) => l.status === 'fechado')).toBe(true);
  });
});

describe('o resumo por vendedor', () => {
  it('separa apurado de estornado', () => {
    const { sale } = vender('v1');
    vender('v2');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: caixa, reason: 'teste' });

    const { rows } = summarize(empresa, '2000-01-01', '2100-01-01');
    const linha = rows.find((r) => r.sellerId === vendedor)!;
    expect(linha.apuradoCents).toBe(400);
    expect(linha.estornadoCents).toBe(200);
    expect(linha.saldoCents).toBe(200);
    expect(linha.sellerName).toBe('Fernanda Vendas');
  });
});
