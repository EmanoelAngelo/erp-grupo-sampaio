/**
 * Prazos e taxas de recebimento.
 *
 * Uma venda de R$ 100 no crédito nascia como R$ 100 QUITADOS no mesmo dia. Na
 * prática são ~R$ 96,50 daqui a trinta dias. O sistema confundia faturamento
 * com dinheiro em caixa, e errava para cima justamente no meio de pagamento
 * que a loja mais usa.
 *
 * O primeiro bloco deste arquivo é o mais importante: SEM operadora cadastrada,
 * nada muda. É essa trava que permite ligar o comportamento novo sem mexer em
 * nenhuma instalação que ainda não configurou nada.
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
const { createSale } = await import('../src/services/core/SalesService.js');
const { createAcquirer, planForPayment, setRate, updateAcquirer } = await import(
  '../src/services/core/AcquirerService.js'
);
const { systemCategoryId } = await import('../src/services/core/FinanceSetupService.js');

let empresa: string;
let usuario: string;
let produto: string;

interface Linha {
  direction: string;
  amount_cents: number;
  status: string;
  due_date: string;
  settled_cents: number;
  installment_number: number;
  installment_total: number;
  category_id: string | null;
  payment_method: string | null;
}

function lancamentos(saleId: string, direcao?: string): Linha[] {
  const filtro = direcao ? ' AND direction = ?' : '';
  const params: unknown[] = direcao ? [saleId, direcao] : [saleId];
  return getConnection()
    .prepare(
      `SELECT * FROM core_finance_entries
        WHERE origin_type = 'sale' AND origin_id = ?${filtro}
        ORDER BY direction, installment_number`,
    )
    .all(...(params as never[])) as unknown as Linha[];
}

function vender(
  payments: { method: string; amountCents: number; installments?: number }[],
  chave: string,
  opcoes: { quantidade?: number; desconto?: number } = {},
) {
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
    userId: usuario,
    items: [{ productId: produto, quantity: q }],
    discountCents: opcoes.desconto,
    payments,
    idempotencyKey: chave,
  });
}

/** Cadastra crédito em N vezes com taxa e prazo. */
function regraCredito(parcelas: number, taxaBps: number, dias = 30): void {
  const op =
    createAcquirerSeguro('Cielo') ??
    (() => {
      throw new Error('operadora');
    })();
  setRate(empresa, {
    acquirerId: op,
    paymentMethod: 'credito',
    installments: parcelas,
    feeBps: taxaBps,
    settlementDays: dias,
  });
}

let operadoraId: string | null = null;
function createAcquirerSeguro(nome: string): string {
  if (operadoraId) return operadoraId;
  operadoraId = createAcquirer(empresa, { name: nome }).id;
  return operadoraId;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  operadoraId = null;
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'CAIXA_PRZ',
    displayName: 'Caixa',
    password: 'Teste@Prz2026',
  });
  linkUserToCompany(usuario, empresa, 'gestor', true);
  // Produto de R$ 100,00.
  produto = createProduct(empresa, { name: 'Tênis Runner', priceCents: 10_000 }).id;
});

describe('sem operadora cadastrada, NADA muda', () => {
  it('a venda no cartão continua gerando uma linha quitada hoje', () => {
    const { sale } = vender([{ method: 'credito', amountCents: 10_000 }], 'v1');
    const linhas = lancamentos(sale.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe('settled');
    expect(linhas[0].amount_cents).toBe(10_000);
    expect(linhas[0].settled_cents).toBe(10_000);
    expect(linhas[0].installment_number).toBe(1);
  });

  it('a venda em dinheiro continua igual', () => {
    const { sale } = vender([{ method: 'dinheiro', amountCents: 10_000 }], 'v1');
    expect(lancamentos(sale.id)).toHaveLength(1);
  });

  it('planForPayment devolve nulo quando não há regra', () => {
    expect(
      planForPayment(empresa, {
        paymentMethod: 'credito',
        amountCents: 10_000,
        saleDate: '2026-08-17',
      }),
    ).toBeNull();
  });

  /** Operadora desativada é o mesmo que não ter operadora. */
  it('operadora inativa não aplica taxa', () => {
    regraCredito(1, 350);
    updateAcquirer(empresa, operadoraId!, { active: false });
    expect(
      planForPayment(empresa, {
        paymentMethod: 'credito',
        amountCents: 10_000,
        saleDate: '2026-08-17',
      }),
    ).toBeNull();
  });
});

describe('o calendário de recebimento', () => {
  it('crédito à vista cai em 30 dias, não hoje', () => {
    regraCredito(1, 350, 30);
    const { sale } = vender([{ method: 'credito', amountCents: 10_000 }], 'v1');

    const receber = lancamentos(sale.id, 'in');
    expect(receber).toHaveLength(1);
    expect(receber[0].status).toBe('open');
    expect(receber[0].settled_cents).toBe(0);
    expect(receber[0].due_date).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it('crédito em 3x gera três parcelas, em 30, 60 e 90 dias', () => {
    regraCredito(3, 350, 30);
    const { sale } = vender(
      [{ method: 'credito', amountCents: 30_000, installments: 3 }],
      'v1',
      { quantidade: 3 },
    );

    const receber = lancamentos(sale.id, 'in');
    expect(receber).toHaveLength(3);
    expect(receber.map((l) => l.amount_cents)).toEqual([10_000, 10_000, 10_000]);
    // As datas sobem: cada parcela cai um período depois.
    expect(receber[0].due_date < receber[1].due_date).toBe(true);
    expect(receber[1].due_date < receber[2].due_date).toBe(true);
    expect(receber.every((l) => l.installment_total === 3)).toBe(true);
  });

  /**
   * R$ 100,00 em 3× não dá 33,33 três vezes: dá 99,99. A sobra vai para a
   * PRIMEIRA parcela, que é o que a operadora faz e o que o cliente vê.
   */
  it('o centavo que sobra vai para a primeira parcela', () => {
    regraCredito(3, 0, 30);
    const plano = planForPayment(empresa, {
      paymentMethod: 'credito',
      amountCents: 10_000,
      installments: 3,
      saleDate: '2026-08-17',
    })!;
    expect(plano.installments.map((p) => p.grossCents)).toEqual([3_334, 3_333, 3_333]);
    // E a soma bate com o que o cliente pagou, ao centavo.
    expect(plano.installments.reduce((t, p) => t + p.grossCents, 0)).toBe(10_000);
  });

  it('a soma das parcelas é sempre igual ao valor pago', () => {
    regraCredito(7, 250, 30);
    for (const valor of [1, 99, 100, 12_345, 99_999]) {
      const plano = planForPayment(empresa, {
        paymentMethod: 'credito',
        amountCents: valor,
        installments: 7,
        saleDate: '2026-08-17',
      })!;
      expect(plano.installments.reduce((t, p) => t + p.grossCents, 0)).toBe(valor);
    }
  });
});

describe('a taxa é despesa, não redução de receita', () => {
  it('sai como linha própria, na categoria de taxa de cartão', () => {
    regraCredito(1, 350, 30);
    const { sale } = vender([{ method: 'credito', amountCents: 10_000 }], 'v1');

    const pagar = lancamentos(sale.id, 'out');
    expect(pagar).toHaveLength(1);
    expect(pagar[0].amount_cents).toBe(350); // 3,5% de R$ 100
    expect(pagar[0].category_id).toBe(systemCategoryId(empresa, 'taxa_cartao'));
  });

  /**
   * O bruto fica no a receber. Embutir o líquido faria a taxa sumir dentro da
   * receita, e no fim do ano ninguém saberia quanto a maquininha custou.
   */
  it('o valor a receber é o BRUTO, e a taxa aparece do lado', () => {
    regraCredito(1, 350, 30);
    const { sale } = vender([{ method: 'credito', amountCents: 10_000 }], 'v1');

    expect(lancamentos(sale.id, 'in')[0].amount_cents).toBe(10_000);
    expect(lancamentos(sale.id, 'out')[0].amount_cents).toBe(350);
  });

  it('em 3x, cada parcela tem sua linha de taxa, na mesma data', () => {
    regraCredito(3, 350, 30);
    const { sale } = vender(
      [{ method: 'credito', amountCents: 30_000, installments: 3 }],
      'v1',
      { quantidade: 3 },
    );

    const receber = lancamentos(sale.id, 'in');
    const pagar = lancamentos(sale.id, 'out');
    expect(pagar).toHaveLength(3);
    expect(pagar.map((l) => l.due_date)).toEqual(receber.map((l) => l.due_date));
  });

  /** Direção diferente não colide na chave única, que a inclui. */
  it('a receber e a pagar convivem com a mesma origem e parcela', () => {
    regraCredito(2, 350, 30);
    const { sale } = vender(
      [{ method: 'credito', amountCents: 20_000, installments: 2 }],
      'v1',
      { quantidade: 2 },
    );
    expect(lancamentos(sale.id, 'in')).toHaveLength(2);
    expect(lancamentos(sale.id, 'out')).toHaveLength(2);
  });

  it('taxa zero não gera linha de despesa', () => {
    regraCredito(1, 0, 30);
    const { sale } = vender([{ method: 'credito', amountCents: 10_000 }], 'v1');
    expect(lancamentos(sale.id, 'out')).toHaveLength(0);
  });
});

describe('venda com mais de uma forma de pagamento', () => {
  it('o dinheiro entra quitado hoje e o cartão fica a receber', () => {
    regraCredito(1, 350, 30);
    const { sale } = vender(
      [
        { method: 'dinheiro', amountCents: 5_000 },
        { method: 'credito', amountCents: 5_000 },
      ],
      'v1',
    );

    const receber = lancamentos(sale.id, 'in');
    expect(receber).toHaveLength(2);
    const quitado = receber.find((l) => l.status === 'settled')!;
    const aberto = receber.find((l) => l.status === 'open')!;
    expect(quitado.amount_cents).toBe(5_000);
    expect(quitado.payment_method).toBe('dinheiro');
    expect(aberto.amount_cents).toBe(5_000);
    expect(aberto.payment_method).toBe('credito');
  });

  /** A taxa incide só sobre o que passou na maquininha. */
  it('a taxa incide apenas sobre a parte do cartão', () => {
    regraCredito(1, 1_000, 30); // 10%
    const { sale } = vender(
      [
        { method: 'dinheiro', amountCents: 5_000 },
        { method: 'credito', amountCents: 5_000 },
      ],
      'v1',
    );
    expect(lancamentos(sale.id, 'out')[0].amount_cents).toBe(500); // 10% de 5.000
  });
});

describe('desconto de cabeçalho', () => {
  /**
   * O desconto sai da última fatia, que é a mais distante: o caixa de curto
   * prazo não é penalizado por um desconto que o lojista já deu.
   */
  it('a soma do que se recebe bate com o total da venda', () => {
    regraCredito(2, 0, 30);
    const { sale } = vender(
      [{ method: 'credito', amountCents: 18_000, installments: 2 }],
      'v1',
      { quantidade: 2, desconto: 2_000 },
    );

    const receber = lancamentos(sale.id, 'in');
    const soma = receber.reduce((t, l) => t + l.amount_cents, 0);
    expect(soma).toBe(sale.total_cents);
    expect(soma).toBe(18_000);
  });
});

describe('parcela com centavo quebrado', () => {
  /**
   * R$ 100 em 3× é o caso que mais aparece no balcão e o que mais quebra:
   * 33,34 + 33,33 + 33,33. Reproduzido a partir de uma falha na tela.
   */
  it('R$ 100 em 3x grava as três parcelas e as três taxas', () => {
    regraCredito(3, 350, 30);
    const { sale } = vender(
      [{ method: 'credito', amountCents: 10_000, installments: 3 }],
      'v1',
    );

    const receber = lancamentos(sale.id, 'in');
    expect(receber.map((l) => l.amount_cents)).toEqual([3_334, 3_333, 3_333]);
    expect(lancamentos(sale.id, 'out')).toHaveLength(3);
  });
});

describe('o troco não é receita', () => {
  /**
   * Quem paga R$ 120 numa venda de R$ 100 leva R$ 20 de volta. Sem este
   * ajuste a loja registraria R$ 120 de entrada, e o financeiro fecharia
   * acima do que de fato entrou.
   *
   * O desconto de cabeçalho, ao contrário, NÃO entra na conta: os pagamentos
   * já somam o total líquido dele.
   */
  it('pagar com sobra em dinheiro não infla o que se recebe', () => {
    regraCredito(1, 350, 30);
    const { sale } = vender(
      [
        { method: 'dinheiro', amountCents: 7_000 },
        { method: 'credito', amountCents: 5_000 },
      ],
      'v1',
    );

    // Venda de R$ 100, pagos R$ 120: R$ 20 voltam como troco.
    expect(sale.total_cents).toBe(10_000);
    const soma = lancamentos(sale.id, 'in').reduce((t, l) => t + l.amount_cents, 0);
    expect(soma).toBe(10_000);
  });

  it('o troco sai da fatia em espécie, não da do cartão', () => {
    regraCredito(1, 0, 30);
    const { sale } = vender(
      [
        { method: 'dinheiro', amountCents: 7_000 },
        { method: 'credito', amountCents: 5_000 },
      ],
      'v1',
    );

    const receber = lancamentos(sale.id, 'in');
    expect(receber.find((l) => l.payment_method === 'credito')?.amount_cents).toBe(5_000);
    expect(receber.find((l) => l.payment_method === 'dinheiro')?.amount_cents).toBe(5_000);
  });
});

describe('o cadastro', () => {
  it('nome repetido de operadora é recusado', () => {
    createAcquirer(empresa, { name: 'Cielo' });
    expect(() => createAcquirer(empresa, { name: 'Cielo' })).toThrow(/já existe/i);
  });

  it('regravar a mesma forma e parcela atualiza em vez de duplicar', () => {
    const op = createAcquirer(empresa, { name: 'Cielo' }).id;
    setRate(empresa, {
      acquirerId: op,
      paymentMethod: 'credito',
      installments: 1,
      feeBps: 350,
      settlementDays: 30,
    });
    const segunda = setRate(empresa, {
      acquirerId: op,
      paymentMethod: 'credito',
      installments: 1,
      feeBps: 400,
      settlementDays: 25,
    });
    expect(segunda.fee_bps).toBe(400);
    expect(segunda.settlement_days).toBe(25);
  });

  it('taxa e prazo negativos são recusados', () => {
    const op = createAcquirer(empresa, { name: 'Cielo' }).id;
    const base = { acquirerId: op, paymentMethod: 'credito', installments: 1 };
    expect(() => setRate(empresa, { ...base, feeBps: -1, settlementDays: 30 })).toThrow(
      /taxa inválida/i,
    );
    expect(() => setRate(empresa, { ...base, feeBps: 350, settlementDays: -1 })).toThrow(
      /prazo inválido/i,
    );
  });

  it('débito pode ter prazo e taxa próprios', () => {
    const op = createAcquirer(empresa, { name: 'Cielo' }).id;
    setRate(empresa, {
      acquirerId: op,
      paymentMethod: 'debito',
      installments: 1,
      feeBps: 150,
      settlementDays: 1,
    });
    const plano = planForPayment(empresa, {
      paymentMethod: 'debito',
      amountCents: 10_000,
      saleDate: '2026-08-17',
    })!;
    expect(plano.installments[0].feeCents).toBe(150);
    expect(plano.installments[0].dueDate).toBe('2026-08-18');
  });
});
