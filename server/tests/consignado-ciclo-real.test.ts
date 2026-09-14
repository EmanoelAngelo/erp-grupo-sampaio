/**
 * ============================================================================
 * CONSIGNADO / CONDICIONAL — o ciclo inteiro, e não um status (GAP-V65)
 * ============================================================================
 *
 * ## O que não existia
 *
 * Nada. `grep -i consigna` no servidor, no frontend e na especificação não
 * achava uma linha. Gringa e Me Mimei mandam roupa "no condicional" todo dia;
 * PJ Motors manda peça para o mecânico testar. A mercadoria SAI da loja sem
 * venda, volta em parte e é faturada em parte.
 *
 * O contorno disponível era a pré-venda, e ela mente duas vezes: não registra a
 * saída FÍSICA (a peça está na casa do cliente e o sistema jura que está na
 * prateleira) e não aceita retorno parcial. O outro contorno é anotar no
 * caderno — e aí o estoque diverge em três das seis empresas.
 *
 * ## A REPRESENTAÇÃO ESCOLHIDA, e por que não é reserva
 *
 * A mercadoria consignada SAI DO SALDO. `core_stock.quantity` cai, e é isso que
 * faz a contagem do mês fechar: quem conta a prateleira encontra o que o
 * sistema diz.
 *
 * A alternativa — reserva de longo prazo — foi recusada com nome e motivo.
 * `reserved` nesta casa significa "está aqui, prometida a alguém": é assim na
 * pré-venda, na peça da OS e na vitrine, e nos três casos a mercadoria está na
 * loja. Consignada, ela NÃO está. Uma reserva deixaria `quantity` contando
 * peças que estão na casa do cliente, e a contagem de inventário acusaria falta
 * todo mês, nas mesmas três empresas — que é EXATAMENTE o risco que este gap
 * descreve.
 *
 * ## O FATURAMENTO PASSA PELO RETORNO SIMBÓLICO — e isso não é truque contábil
 *
 * Quando parte da consignação vira venda, a mercadoria já saiu. A venda não
 * pode baixar de novo o que já baixou. O par de movimentos é
 * RETORNO SIMBÓLICO (+) seguido de VENDA (−), na MESMA transação, e ele é
 * literalmente a operação fiscal brasileira: a remessa em consignação sai com
 * um documento, e o faturamento exige o RETORNO SIMBÓLICO da mercadoria antes
 * da nota de venda. O razão fala a língua do contador, e o saldo não se mexe no
 * evento — porque a peça não voltou para a prateleira, ela foi embora com o
 * cliente que já a tinha.
 *
 * ## Como este guarda falha (quebrando de propósito)
 *
 *   - troque o `applyMovement` de saída da remessa por `reserveStock` → "a
 *     mercadoria SAI do saldo" fica vermelho;
 *   - tire o retorno simbólico do faturamento → "faturar não baixa de novo"
 *     fica vermelho com estoque negativo ou faltando;
 *   - deixe `fechar` aceitar pendência → "fechar com pendência é recusado"
 *     fica vermelho;
 *   - tire o CHECK (returned + sold <= delivered) da DDL → "devolver mais do
 *     que saiu é recusado" fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getAvailable, getBalance, listMovements } = await import(
  '../src/services/core/InventoryService.js'
);
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createCustomer } = await import('../src/services/core/CatalogService.js');
const {
  criarConsignacao,
  registrarRetorno,
  faturarConsignacao,
  fecharConsignacao,
  getConsignacao,
  listConsignacoes,
} = await import('../src/services/core/ConsignmentService.js');

let companyId: string;
let userId: string;
let clienteId: string;
let vestido: string;
let cinto: string;

/** Receita reconhecida — consignação entregue não pode aparecer aqui. */
function receita(): number {
  const row = getConnection()
    .prepare(
      'SELECT COALESCE(SUM(settled_cents), 0) AS total FROM core_finance_entries WHERE company_id = ?',
    )
    .get(companyId) as { total: number };
  return row.total;
}

function vendas(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales').get() as { n: number }
  ).n;
}

function auditoria(action: string): Record<string, unknown>[] {
  return getConnection()
    .prepare('SELECT * FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(companyId, action) as unknown as Record<string, unknown>[];
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio Ltda',
    tradeName: 'Gringa',
  });
  userId = await upsertUser({
    login: 'VENDEDORA',
    displayName: 'Vendedora',
    password: 'senha-teste-123',
  });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);
  clienteId = String(createCustomer(companyId, { name: 'Dona Marlene' }).id);

  vestido = String(createProduct(companyId, { name: 'Vestido longo', priceCents: 20000 }).id);
  cinto = String(createProduct(companyId, { name: 'Cinto de couro', priceCents: 5000 }).id);
  for (const p of [vestido, cinto]) {
    applyMovement({
      companyId,
      productId: p,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: `carga-${p}`,
    });
  }
});

function entregar(qtdVestido = 5, qtdCinto = 0) {
  const items = [{ productId: vestido, quantity: qtdVestido }];
  if (qtdCinto > 0) items.push({ productId: cinto, quantity: qtdCinto });
  // A CHAVE É OBRIGATÓRIA na remessa desde o conserto da idempotência: cada
  // chamada deste helper é uma remessa NOVA, e por isso ganha chave nova.
  return criarConsignacao({
    companyId,
    userId,
    customerId: clienteId,
    items,
    idempotencyKey: randomUUID(),
  });
}

// ------------------------------------------------------------- a REMESSA

describe('a entrega tira a mercadoria da loja — e não gera receita nenhuma', () => {
  it('a mercadoria SAI do saldo, não fica reservada', () => {
    entregar(5);

    // O saldo cai: quem conta a prateleira encontra 5, e o sistema diz 5.
    expect(getBalance(companyId, vestido)).toBe(5);
    expect(getAvailable(companyId, vestido)).toBe(5);

    // E NÃO fica presa como reserva: reserva significa "está aqui, prometida".
    const reserva = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(companyId, vestido) as { reserved: number };
    expect(reserva.reserved).toBe(0);
  });

  it('não vira receita, nem venda, nem lançamento financeiro', () => {
    entregar(5, 3);
    expect(receita()).toBe(0);
    expect(vendas()).toBe(0);
  });

  it('o razão diz REMESSA EM CONSIGNAÇÃO, e não "saída manual"', () => {
    const doc = entregar(5);
    const linha = listMovements(companyId, { productId: vestido }).find(
      (m) => m.reference_id === doc.id,
    );
    expect(linha?.kind).toBe('CONSIGNMENT_OUT');
    expect(linha?.kind_label).toContain('onsigna');
    expect(linha?.quantity).toBe(-5);
  });

  it('sem saldo não sai — prometer o que não existe é pior que recusar', () => {
    expect(() => entregar(40)).toThrowError(/insuficiente/i);
    expect(getBalance(companyId, vestido)).toBe(10);
    expect(listConsignacoes(companyId)).toHaveLength(0);
  });

  it('a remessa deixa trilha', () => {
    entregar(5);
    expect(auditoria('consignment.create')).toHaveLength(1);
  });

  it('cliente é obrigatório: consignação sem dono não tem como voltar', () => {
    expect(() =>
      criarConsignacao({
        companyId,
        userId,
        customerId: null as unknown as string,
        items: [{ productId: vestido, quantity: 1 }],
        idempotencyKey: randomUUID(),
      }),
    ).toThrowError(/cliente/i);
  });
});

/*
  A REMESSA ERA O ÚNICO DOS TRÊS EVENTOS DE ESTOQUE SEM CHAVE.

  `/retorno` e `/faturar` exigiam `Idempotency-Key` desde que nasceram; a
  remessa, não — e ela é a mais cara das três, porque tira mercadoria do saldo
  sem venda e não tem CHECK nenhum para segurá-la por baixo (duas remessas
  são, cada uma, legítimas). Um reenvio de rede ou uma aba duplicada criava
  DUAS consignações sob dois números e baixava o mesmo vestido duas vezes.
*/
describe('a remessa não sai em dobro', () => {
  it('a MESMA chave devolve a MESMA consignação, e o saldo cai uma vez só', () => {
    const chave = randomUUID();
    const primeira = criarConsignacao({
      companyId,
      userId,
      customerId: clienteId,
      items: [{ productId: vestido, quantity: 3 }],
      idempotencyKey: chave,
    });
    const reenvio = criarConsignacao({
      companyId,
      userId,
      customerId: clienteId,
      items: [{ productId: vestido, quantity: 3 }],
      idempotencyKey: chave,
    });

    expect(primeira.duplicated).toBe(false);
    expect(reenvio.duplicated).toBe(true);
    expect(reenvio.id).toBe(primeira.id);
    expect(reenvio.number).toBe(primeira.number);

    expect(listConsignacoes(companyId)).toHaveLength(1);
    // 10 − 3, e não 10 − 6: a mercadoria saiu UMA vez.
    expect(getBalance(companyId, vestido)).toBe(7);
    expect(auditoria('consignment.create')).toHaveLength(1);
  });

  it('sem chave a remessa nem começa — nenhuma peça sai da prateleira', () => {
    expect(() =>
      criarConsignacao({
        companyId,
        userId,
        customerId: clienteId,
        items: [{ productId: vestido, quantity: 3 }],
        idempotencyKey: '',
      }),
    ).toThrowError(/idempot/i);
    expect(getBalance(companyId, vestido)).toBe(10);
    expect(listConsignacoes(companyId)).toHaveLength(0);
  });

  it('o reenvio não é confundido com falta de estoque', () => {
    // O caso que a ordem da conferência protege: a primeira remessa levou TUDO,
    // e o reenvio da mesma chave não pode responder "estoque insuficiente" —
    // ele tem de devolver a remessa que já aconteceu.
    const chave = randomUUID();
    const doc = criarConsignacao({
      companyId,
      userId,
      customerId: clienteId,
      items: [{ productId: vestido, quantity: 10 }],
      idempotencyKey: chave,
    });
    const reenvio = criarConsignacao({
      companyId,
      userId,
      customerId: clienteId,
      items: [{ productId: vestido, quantity: 10 }],
      idempotencyKey: chave,
    });
    expect(reenvio.id).toBe(doc.id);
    expect(reenvio.duplicated).toBe(true);
    expect(getBalance(companyId, vestido)).toBe(0);
  });
});

// -------------------------------------------------------------- o RETORNO

describe('o retorno parcial devolve ao disponível o que voltou', () => {
  it('voltou 2 de 5: o saldo sobe 2, e sobram 3 com o cliente', () => {
    const doc = entregar(5);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
    });

    expect(getBalance(companyId, vestido)).toBe(7);
    const detalhe = getConsignacao(companyId, doc.id);
    expect(detalhe?.items[0].returned_qty).toBe(2);
    expect(detalhe?.items[0].pending_qty).toBe(3);
  });

  it('dois retornos parciais somam, e cada um é um movimento próprio', () => {
    const doc = entregar(5);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
    });
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 1 }],
    });

    expect(getBalance(companyId, vestido)).toBe(8);
    expect(getConsignacao(companyId, doc.id)?.items[0].pending_qty).toBe(2);
  });

  it('devolver mais do que saiu é recusado', () => {
    const doc = entregar(3);
    expect(() =>
      registrarRetorno({
        companyId,
        userId,
        consignmentId: doc.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: vestido, quantity: 4 }],
      }),
    ).toThrowError(/pendente|não saiu|maior/i);
    expect(getBalance(companyId, vestido)).toBe(7);
  });

  it('a MESMA chave não devolve duas vezes', () => {
    const doc = entregar(5);
    const chave = randomUUID();
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: chave,
      items: [{ productId: vestido, quantity: 2 }],
    });
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: chave,
      items: [{ productId: vestido, quantity: 2 }],
    });
    expect(getBalance(companyId, vestido)).toBe(7);
    expect(getConsignacao(companyId, doc.id)?.items[0].returned_qty).toBe(2);
  });

  it('retorno não gera receita', () => {
    const doc = entregar(5);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 5 }],
    });
    expect(receita()).toBe(0);
    expect(vendas()).toBe(0);
  });
});

// --------------------------------------------------------------- a VENDA

describe('o que ficou vira venda de verdade — e só aí nasce a receita', () => {
  it('faturar 2 de 5 gera venda, receita e financeiro', () => {
    const doc = entregar(5);
    const { saleId, totalCents } = faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    expect(saleId).toBeTruthy();
    expect(totalCents).toBe(40000);
    expect(receita()).toBe(40000);
    expect(vendas()).toBe(1);
  });

  it('faturar NÃO baixa o estoque de novo — a peça já tinha saído', () => {
    const doc = entregar(5);
    expect(getBalance(companyId, vestido)).toBe(5);

    faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    // O saldo NÃO se mexe: retorno simbólico (+2) e venda (−2) se anulam.
    expect(getBalance(companyId, vestido)).toBe(5);
    expect(getConsignacao(companyId, doc.id)?.items[0].sold_qty).toBe(2);
    expect(getConsignacao(companyId, doc.id)?.items[0].pending_qty).toBe(3);
  });

  it('o razão registra o RETORNO SIMBÓLICO e a VENDA — as duas pernas', () => {
    const doc = entregar(5);
    faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    const kinds = listMovements(companyId, { productId: vestido }).map((m) => m.kind);
    expect(kinds).toContain('CONSIGNMENT_SYMBOLIC_RETURN');
    expect(kinds).toContain('SALE');
  });

  it('faturar mais do que está pendente é recusado', () => {
    const doc = entregar(3);
    expect(() =>
      faturarConsignacao({
        companyId,
        userId,
        consignmentId: doc.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: vestido, quantity: 4 }],
        payments: [{ method: 'dinheiro', amountCents: 80000 }],
      }),
    ).toThrowError(/pendente|não saiu|maior/i);
    expect(receita()).toBe(0);
    expect(getBalance(companyId, vestido)).toBe(7);
  });

  it('o que já voltou não pode ser faturado', () => {
    const doc = entregar(3);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 3 }],
    });
    expect(() =>
      faturarConsignacao({
        companyId,
        userId,
        consignmentId: doc.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: vestido, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 20000 }],
      }),
    ).toThrowError(/pendente|não saiu|maior/i);
  });

  it('a MESMA chave não fatura duas vezes', () => {
    const doc = entregar(5);
    const chave = randomUUID();
    const primeira = faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: chave,
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });
    const segunda = faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: chave,
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    expect(segunda.saleId).toBe(primeira.saleId);
    expect(vendas()).toBe(1);
    expect(receita()).toBe(40000);
    expect(getConsignacao(companyId, doc.id)?.items[0].sold_qty).toBe(2);
  });

  it('o preço CONGELADO na remessa manda, mesmo com a tabela reajustada', () => {
    /*
      A cliente levou o vestido por R$ 200. Enquanto ele estava no armário
      dela, a loja reajustou para R$ 260. Ela paga os R$ 200 que combinou — é o
      mesmo congelamento do orçamento, e quem explicaria o contrário ao cliente
      seria a vendedora, que não teve parte na decisão.
    */
    const doc = entregar(2);
    getConnection()
      .prepare('UPDATE core_products SET price_cents = 26000 WHERE id = ?')
      .run(vestido);

    const { totalCents } = faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    expect(totalCents).toBe(40000);
    expect(receita()).toBe(40000);
  });

  it('a diferença contra a tabela de hoje vai para a trilha, sem barrar', () => {
    const doc = entregar(2);
    getConnection()
      .prepare('UPDATE core_products SET price_cents = 26000 WHERE id = ?')
      .run(vestido);
    faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    const detalhe = JSON.parse(String(auditoria('consignment.invoice')[0].detail)) as {
      concessaoCents: number;
      brutoCents: number;
    };
    // 2 × (260 − 200) = R$ 120 abaixo da tabela de hoje. Legítimo, e visível.
    expect(detalhe.concessaoCents).toBe(12000);
    expect(detalhe.brutoCents).toBe(52000);
  });

  it('a venda sai no nome do cliente da consignação', () => {
    const doc = entregar(2);
    const { saleId } = faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });
    const venda = getConnection()
      .prepare('SELECT customer_id FROM core_sales WHERE id = ?')
      .get(saleId) as { customer_id: string | null };
    expect(venda.customer_id).toBe(clienteId);
  });

  it('faturar deixa trilha com a venda', () => {
    const doc = entregar(2);
    faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });
    const linhas = auditoria('consignment.invoice');
    expect(linhas).toHaveLength(1);
    expect(String(linhas[0].detail)).toContain('saleId');
  });
});

// ---------------------------------------------------------- o FECHAMENTO

describe('a consignação fecha quando não há nada pendente', () => {
  it('parte vendida, parte devolvida: fecha', () => {
    const doc = entregar(5);
    faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 3 }],
    });

    const fechada = fecharConsignacao({ companyId, userId, consignmentId: doc.id });
    expect(fechada.status).toBe('fechada');

    // A conta do estoque fecha: 10 − 2 vendidos = 8 na prateleira.
    expect(getBalance(companyId, vestido)).toBe(8);
    expect(receita()).toBe(40000);
  });

  it('fechar com pendência é recusado, e a mensagem diz o que falta', () => {
    const doc = entregar(5);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 1 }],
    });

    expect(() => fecharConsignacao({ companyId, userId, consignmentId: doc.id })).toThrowError(
      /pendente|Vestido longo/i,
    );
    expect(getConsignacao(companyId, doc.id)?.status).toBe('aberta');
  });

  it('consignação fechada não recebe retorno nem faturamento', () => {
    const doc = entregar(2);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
    });
    fecharConsignacao({ companyId, userId, consignmentId: doc.id });

    expect(() =>
      registrarRetorno({
        companyId,
        userId,
        consignmentId: doc.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: vestido, quantity: 1 }],
      }),
    ).toThrowError(/fechada|não est/i);
  });

  it('fechar duas vezes não muda nada', () => {
    const doc = entregar(2);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 2 }],
    });
    fecharConsignacao({ companyId, userId, consignmentId: doc.id });
    const segunda = fecharConsignacao({ companyId, userId, consignmentId: doc.id });
    expect(segunda.status).toBe('fechada');
    expect(auditoria('consignment.close')).toHaveLength(1);
  });

  it('o fechamento deixa trilha', () => {
    const doc = entregar(1);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 1 }],
    });
    fecharConsignacao({ companyId, userId, consignmentId: doc.id });
    expect(auditoria('consignment.close')).toHaveLength(1);
  });
});

// ------------------------------------------------------------ as RECUSAS

describe('o que NÃO entra em consignação', () => {
  it('serviço de balcão não sai da loja porque nunca esteve nela', () => {
    const id = String(
      createProduct(companyId, {
        name: 'Ajuste de bainha',
        priceCents: 3000,
        stockControl: false,
      }).id,
    );
    expect(() =>
      criarConsignacao({
        companyId,
        userId,
        customerId: clienteId,
        items: [{ productId: id, quantity: 1 }],
        idempotencyKey: randomUUID(),
      }),
    ).toThrowError(/serviço|não controla estoque/i);
  });

  it('documento de outra empresa não é alcançável', () => {
    const outra = upsertCompany({
      slug: 'me-mimei',
      legalName: 'Me Mimei Ltda',
      tradeName: 'Me Mimei',
    });
    const doc = entregar(2);
    expect(getConsignacao(outra, doc.id)).toBeNull();
    expect(() =>
      registrarRetorno({
        companyId: outra,
        userId,
        consignmentId: doc.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: vestido, quantity: 1 }],
      }),
    ).toThrowError(/não encontrada/i);
  });

  it('quantidade zero ou negativa não sai', () => {
    expect(() =>
      criarConsignacao({
        companyId,
        userId,
        customerId: clienteId,
        items: [{ productId: vestido, quantity: 0 }],
        idempotencyKey: randomUUID(),
      }),
    ).toThrowError(/quantidade/i);
  });

  it('consignação sem item não existe', () => {
    expect(() =>
      criarConsignacao({
        companyId,
        userId,
        customerId: clienteId,
        items: [],
        idempotencyKey: randomUUID(),
      }),
    ).toThrowError(/ao menos um item/i);
  });
});

// ------------------------------------------------------- o CICLO INTEIRO

describe('o ciclo inteiro fecha a conta', () => {
  it('10 na prateleira, 5 saem, 2 vendem, 3 voltam: 8 e R$ 400 de receita', () => {
    const doc = entregar(5, 4);
    expect(getBalance(companyId, vestido)).toBe(5);
    expect(getBalance(companyId, cinto)).toBe(6);
    expect(receita()).toBe(0);

    faturarConsignacao({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [
        { productId: vestido, quantity: 2 },
        { productId: cinto, quantity: 1 },
      ],
      payments: [{ method: 'dinheiro', amountCents: 45000 }],
    });

    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [
        { productId: vestido, quantity: 3 },
        { productId: cinto, quantity: 3 },
      ],
    });

    const fechada = fecharConsignacao({ companyId, userId, consignmentId: doc.id });
    expect(fechada.status).toBe('fechada');
    expect(getBalance(companyId, vestido)).toBe(8);
    expect(getBalance(companyId, cinto)).toBe(9);
    expect(receita()).toBe(45000);
  });

  it('a lista mostra o que está com o cliente AGORA', () => {
    const doc = entregar(5);
    registrarRetorno({
      companyId,
      userId,
      consignmentId: doc.id,
      idempotencyKey: randomUUID(),
      items: [{ productId: vestido, quantity: 1 }],
    });

    const lista = listConsignacoes(companyId);
    expect(lista).toHaveLength(1);
    expect(lista[0].pending_qty).toBe(4);
    expect(lista[0].customer_name).toBe('Dona Marlene');
  });
});
