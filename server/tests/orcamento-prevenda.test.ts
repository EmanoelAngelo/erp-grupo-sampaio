/**
 * Orçamento e pré-venda.
 *
 * A diferença entre os dois é uma só e é o que estes testes cobrem: orçamento
 * NÃO segura estoque (senão meia dúzia de papéis abertos trava a loja com
 * mercadoria que ninguém comprou) e pré-venda SEGURA (senão a peça é vendida
 * no caixa ao lado enquanto o cliente busca o dinheiro).
 *
 * Nenhum dos dois é venda: não geram receita nem baixa. Isso só acontece na
 * conversão — e a venda continua sendo feita pelo SalesService.
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
const { applyMovement, getAvailable, getBalance } = await import(
  '../src/services/core/InventoryService.js'
);
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const {
  cancelQuote,
  convertQuote,
  createQuote,
  expireOverdueQuotes,
  getQuoteDetail,
  listQuotes,
  promoteToPreSale,
} = await import('../src/services/core/QuoteService.js');
const { openSession } = await import('../src/services/core/CashService.js');
const { salvarPolitica } = await import('../src/services/core/SalePolicyService.js');

let companyId: string;
let produto: string;
let userId: string;

/** Receita reconhecida pela empresa — orçamento não pode aparecer aqui. */
function receita(): number {
  const row = getConnection()
    .prepare(
      "SELECT COALESCE(SUM(settled_cents), 0) AS total FROM core_finance_entries WHERE company_id = ?",
    )
    .get(companyId) as { total: number };
  return row.total;
}

function daqui(dias: number): string {
  return new Date(Date.now() + dias * 86400000).toISOString();
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  userId = await upsertUser({
    login: 'ATENDENTE',
    displayName: 'Atendente',
    password: 'senha-teste-123',
  });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);

  produto = String(createProduct(companyId, { name: 'Bateria 60Ah', priceCents: 45000 }).id);
  applyMovement({
    companyId,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: 'carga',
  });
});

function abrir(kind: 'orcamento' | 'pre_venda', quantidade = 3, validUntil?: string) {
  return createQuote({
    companyId,
    userId,
    kind,
    items: [{ productId: produto, quantity: quantidade }],
    validUntil: validUntil ?? null,
  });
}

describe('orçamento não segura estoque', () => {
  it('o disponível continua inteiro', () => {
    abrir('orcamento', 4);
    expect(getBalance(companyId, produto)).toBe(10);
    expect(getAvailable(companyId, produto)).toBe(10);
  });

  it('vários orçamentos abertos não travam a loja', () => {
    abrir('orcamento', 8);
    abrir('orcamento', 8);
    abrir('orcamento', 8);
    expect(getAvailable(companyId, produto)).toBe(10);
  });

  it('pode ser aberto acima do saldo — é uma cotação, não uma promessa', () => {
    const doc = abrir('orcamento', 50);
    expect(doc.status).toBe('aberto');
    expect(doc.total_cents).toBe(50 * 45000);
  });
});

describe('pré-venda segura estoque', () => {
  it('reserva sai do disponível mas não do saldo físico', () => {
    abrir('pre_venda', 4);
    expect(getBalance(companyId, produto)).toBe(10);
    expect(getAvailable(companyId, produto)).toBe(6);
  });

  it('não é aberta sem saldo, em vez de prometer o que não existe', () => {
    expect(() => abrir('pre_venda', 11)).toThrowError(/insuficiente/i);
    expect(getAvailable(companyId, produto)).toBe(10);
  });

  it('a segunda pré-venda respeita a reserva da primeira', () => {
    abrir('pre_venda', 7);
    expect(() => abrir('pre_venda', 5)).toThrowError(/insuficiente/i);
    expect(getAvailable(companyId, produto)).toBe(3);
  });
});

describe('nenhum dos dois é venda', () => {
  it('não gera receita nem baixa de estoque', () => {
    abrir('orcamento', 3);
    abrir('pre_venda', 2);
    expect(receita()).toBe(0);
    expect(getBalance(companyId, produto)).toBe(10);
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales')
      .get() as { n: number };
    expect(vendas.n).toBe(0);
  });
});

describe('conversão em venda', () => {
  it('orçamento vira venda com baixa e receita', () => {
    const doc = abrir('orcamento', 3);
    const { saleId } = convertQuote({
      companyId,
      userId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 135000 }],
    });

    expect(saleId).toBeTruthy();
    expect(getBalance(companyId, produto)).toBe(7);
    expect(receita()).toBe(135000);
    expect(getQuoteDetail(companyId, doc.id)?.status).toBe('convertido');
  });

  it('pré-venda solta a reserva e dá baixa — sem contar duas vezes', () => {
    const doc = abrir('pre_venda', 4);
    expect(getAvailable(companyId, produto)).toBe(6);

    convertQuote({
      companyId,
      userId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 180000 }],
    });

    expect(getBalance(companyId, produto)).toBe(6);
    // Reserva solta e mercadoria baixada: disponível volta a bater com o saldo.
    expect(getAvailable(companyId, produto)).toBe(6);
  });

  it('converter duas vezes é recusado, e a segunda não dá baixa de novo', () => {
    const doc = abrir('pre_venda', 3);
    convertQuote({
      companyId,
      userId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 135000 }],
    });

    expect(() =>
      convertQuote({
        companyId,
        userId,
        quoteId: doc.id,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 135000 }],
      }),
    ).toThrowError(/já virou a venda/i);

    expect(getBalance(companyId, produto)).toBe(7);
    expect(receita()).toBe(135000);
  });

  it('orçamento acima do saldo não vira venda', () => {
    const doc = abrir('orcamento', 50);
    expect(() =>
      convertQuote({
        companyId,
        userId,
        quoteId: doc.id,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 50 * 45000 }],
      }),
    ).toThrowError(/insuficiente/i);
    expect(getBalance(companyId, produto)).toBe(10);
  });

  it('documento de outra empresa não é alcançável', () => {
    const outra = upsertCompany({
      slug: 'oficina',
      legalName: 'Oficina Ltda',
      tradeName: 'Oficina',
    });
    const doc = abrir('orcamento', 1);
    expect(() =>
      convertQuote({
        companyId: outra,
        userId,
        quoteId: doc.id,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 45000 }],
      }),
    ).toThrowError(/não encontrado/i);
  });
});

describe('validade', () => {
  it('vencido não converte', () => {
    const doc = abrir('orcamento', 2, daqui(-1));
    expect(() =>
      convertQuote({
        companyId,
        userId,
        quoteId: doc.id,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 90000 }],
      }),
    ).toThrowError(/vencido/i);
  });

  it('dentro da validade converte normalmente', () => {
    const doc = abrir('orcamento', 2, daqui(7));
    const { saleId } = convertQuote({
      companyId,
      userId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 90000 }],
    });
    expect(saleId).toBeTruthy();
  });

  it('pré-venda esquecida devolve a mercadoria quando expira', () => {
    abrir('pre_venda', 6, daqui(-1));
    expect(getAvailable(companyId, produto)).toBe(4);

    expect(expireOverdueQuotes(companyId)).toBe(1);
    // Sem isto, mercadoria some do disponível para sempre sem ter sido vendida.
    expect(getAvailable(companyId, produto)).toBe(10);
    expect(listQuotes(companyId, { status: 'expirado' })).toHaveLength(1);
  });

  it('expirar duas vezes não solta a reserva duas vezes', () => {
    abrir('pre_venda', 6, daqui(-1));
    expireOverdueQuotes(companyId);
    expect(expireOverdueQuotes(companyId)).toBe(0);
    expect(getAvailable(companyId, produto)).toBe(10);
  });
});

describe('orçamento aprovado vira pré-venda', () => {
  it('a pré-venda nasce com os mesmos itens e passa a segurar estoque', () => {
    const orcamento = abrir('orcamento', 4);
    expect(getAvailable(companyId, produto)).toBe(10);

    const preVenda = promoteToPreSale({ companyId, userId, quoteId: orcamento.id });

    expect(preVenda.kind).toBe('pre_venda');
    expect(preVenda.total_cents).toBe(orcamento.total_cents);
    expect(getAvailable(companyId, produto)).toBe(6);

    const itens = getQuoteDetail(companyId, preVenda.id)?.items as Record<string, unknown>[];
    expect(itens).toHaveLength(1);
    expect(itens[0].quantity).toBe(4);
  });

  it('o orçamento fica no histórico apontando para a pré-venda', () => {
    const orcamento = abrir('orcamento', 2);
    const preVenda = promoteToPreSale({ companyId, userId, quoteId: orcamento.id });

    const original = getQuoteDetail(companyId, orcamento.id);
    expect(original?.status).toBe('convertido');
    expect(String(original?.note)).toContain(`pré-venda #${preVenda.number}`);
  });

  it('numeração é independente: orçamento #1 e pré-venda #1 convivem', () => {
    const orcamento = abrir('orcamento', 1);
    const preVenda = promoteToPreSale({ companyId, userId, quoteId: orcamento.id });
    expect(orcamento.number).toBe(1);
    expect(preVenda.number).toBe(1);
  });

  it('sem saldo na hora da aprovação, a pré-venda não nasce', () => {
    const orcamento = abrir('orcamento', 9);
    // A mercadoria foi embora entre a cotação e a aprovação.
    abrir('pre_venda', 8);
    expect(() => promoteToPreSale({ companyId, userId, quoteId: orcamento.id })).toThrowError(
      /insuficiente/i,
    );
    // O orçamento continua aberto: nada foi consumido pela tentativa.
    expect(getQuoteDetail(companyId, orcamento.id)?.status).toBe('aberto');
  });

  it('pré-venda não vira pré-venda de novo', () => {
    const preVenda = abrir('pre_venda', 1);
    expect(() => promoteToPreSale({ companyId, userId, quoteId: preVenda.id })).toThrowError(
      /só orçamento/i,
    );
  });

  it('orçamento vencido não é aprovado', () => {
    const orcamento = abrir('orcamento', 1, daqui(-1));
    expect(() => promoteToPreSale({ companyId, userId, quoteId: orcamento.id })).toThrowError(
      /vencido/i,
    );
  });

  it('o caminho inteiro fecha: orçamento → pré-venda → venda', () => {
    const orcamento = abrir('orcamento', 3);
    const preVenda = promoteToPreSale({ companyId, userId, quoteId: orcamento.id });
    const { saleId } = convertQuote({
      companyId,
      userId,
      quoteId: preVenda.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 135000 }],
    });

    expect(saleId).toBeTruthy();
    expect(getBalance(companyId, produto)).toBe(7);
    expect(getAvailable(companyId, produto)).toBe(7);
    expect(receita()).toBe(135000);
  });
});

describe('cancelamento', () => {
  it('pré-venda cancelada devolve a reserva', () => {
    const doc = abrir('pre_venda', 5);
    expect(getAvailable(companyId, produto)).toBe(5);

    cancelQuote({ companyId, quoteId: doc.id, reason: 'cliente desistiu' });
    expect(getAvailable(companyId, produto)).toBe(10);
  });

  it('cancelar duas vezes não devolve duas vezes', () => {
    const doc = abrir('pre_venda', 5);
    cancelQuote({ companyId, quoteId: doc.id });
    cancelQuote({ companyId, quoteId: doc.id });
    expect(getAvailable(companyId, produto)).toBe(10);
  });

  it('documento já convertido não pode ser cancelado por aqui', () => {
    const doc = abrir('orcamento', 2);
    convertQuote({
      companyId,
      userId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 90000 }],
    });
    expect(() => cancelQuote({ companyId, quoteId: doc.id })).toThrowError(/já convertido/i);
  });

  it('cancelado não vira venda', () => {
    const doc = abrir('pre_venda', 2);
    cancelQuote({ companyId, quoteId: doc.id });
    expect(() =>
      convertQuote({
        companyId,
        userId,
        quoteId: doc.id,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 90000 }],
      }),
    ).toThrowError(/não pode ser convertido/i);
  });
});

/**
 * A PRÉ-VENDA ETERNA — o defeito mais caro deste módulo.
 *
 * `expireOverdueQuotes` filtra `valid_until IS NOT NULL`. Documento sem
 * validade não era "válido para sempre": era INVISÍVEL para a varredura que
 * solta reservas. E a aprovação de orçamento criava a pré-venda exatamente
 * assim, com validade nula. A peça reservada saía do disponível e não voltava
 * nunca — não por venda, não por contagem, por esquecimento.
 *
 * Os sete dias existiam, mas no formulário do NAVEGADOR: valiam só para quem
 * abria o documento por aquela tela.
 */
describe('todo documento nasce com validade', () => {
  function validadeDe(quoteId: string): string | null {
    return (getQuoteDetail(companyId, quoteId)?.valid_until as string | null) ?? null;
  }

  it('orçamento aberto sem data ganha a validade do servidor', () => {
    expect(validadeDe(abrir('orcamento', 1).id)).not.toBeNull();
  });

  it('pré-venda aberta sem data ganha a validade do servidor', () => {
    expect(validadeDe(abrir('pre_venda', 1).id)).not.toBeNull();
  });

  it('a pré-venda APROVADA de um orçamento também — era o caminho quebrado', () => {
    const orcamento = abrir('orcamento', 3);
    const preVenda = promoteToPreSale({ companyId, userId, quoteId: orcamento.id });
    expect(validadeDe(preVenda.id)).not.toBeNull();
  });

  /*
    O dia é lido no RELÓGIO DA LOJA, não em UTC.

    A validade é o fim do dia local, e no fuso do Brasil isso vira 02:59 do dia
    SEGUINTE em UTC. Comparar por `toISOString()` faria o teste cobrar um dia a
    mais e passaria a mentir sobre a regra — o prazo que o atendente combina
    com o cliente é o do calendário da parede.
  */
  function diaLocal(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  it('o padrão são os 7 dias que moravam na tela, e valem até o FIM do dia', () => {
    const doc = abrir('pre_venda', 1);
    const validade = new Date(String(validadeDe(doc.id)));
    const esperado = new Date();
    esperado.setDate(esperado.getDate() + 7);
    expect(diaLocal(validade)).toBe(diaLocal(esperado));
    // "Vale 7 dias" no balcão significa "até o fim do sétimo dia". Morrer no
    // meio da tarde pegaria o cliente voltando às 18h com o dinheiro na mão.
    expect(validade.getHours()).toBe(23);
  });

  it('o dono muda o prazo e o documento novo obedece', () => {
    salvarPolitica({ companyId, userId, reservationValidDays: 2 });
    const doc = abrir('pre_venda', 1);
    const validade = new Date(String(validadeDe(doc.id)));
    const esperado = new Date();
    esperado.setDate(esperado.getDate() + 2);
    expect(diaLocal(validade)).toBe(diaLocal(esperado));
  });

  it('data digitada pelo atendente manda sobre o padrão', () => {
    const escolhida = daqui(30);
    const doc = abrir('pre_venda', 1, escolhida);
    expect(validadeDe(doc.id)).toBe(escolhida);
  });

  it('a validade padrão é ALCANÇADA pela varredura — é o que faltava', () => {
    // Zero dia = vence no fim de hoje. Com a validade nula de antes, este
    // documento seria invisível para expireOverdueQuotes e a mercadoria ficaria
    // presa para sempre; aqui ele é encontrado e a peça volta.
    salvarPolitica({ companyId, userId, reservationValidDays: 0 });
    abrir('pre_venda', 6);
    expect(getAvailable(companyId, produto)).toBe(4);

    const amanha = new Date(Date.now() + 86400000);
    expect(expireOverdueQuotes(companyId, amanha)).toBe(1);
    expect(getAvailable(companyId, produto)).toBe(10);
  });
});

/**
 * A VARREDURA RODA NA ABERTURA DE CAIXA — e não pode impedir a loja de abrir.
 *
 * Não há agendador neste servidor: ele roda dentro da loja e é desligado à
 * noite. Abrir o caixa é o único evento que acontece todo dia e antes da
 * primeira venda.
 */
describe('a abertura de caixa solta o que venceu', () => {
  it('a mercadoria de uma pré-venda vencida volta ao disponível', () => {
    abrir('pre_venda', 6, daqui(-1));
    expect(getAvailable(companyId, produto)).toBe(4);

    openSession({ companyId, userId, openingCents: 10000 });

    expect(getAvailable(companyId, produto)).toBe(10);
    expect(listQuotes(companyId, { status: 'expirado' })).toHaveLength(1);
  });

  it('se a varredura EXPLODIR, o caixa abre assim mesmo', () => {
    abrir('pre_venda', 6, daqui(-1));

    /*
      Falha real, não simulada por mock: um gatilho no banco aborta justamente
      o UPDATE que marca o documento como expirado. É o tipo de coisa que
      acontece com dado sujo em loja de verdade.

      O que este teste cobra é a decisão escrita em CashService: a faxina é
      engolida e a abertura continua. Se alguém "tratar o erro direito" e
      deixar a exceção subir, NINGUÉM ABRE O CAIXA E A LOJA NÃO VENDE — o dia
      inteiro parado por causa de uma reserva presa, que custa uma peça e
      continua consertável.
    */
    getConnection().exec(
      `CREATE TRIGGER tg_prova_expiracao BEFORE UPDATE ON core_quotes
         WHEN new.status = 'expirado'
       BEGIN SELECT RAISE(ABORT, 'falha proposital na expiracao'); END;`,
    );

    try {
      const sessao = openSession({ companyId, userId, openingCents: 10000 });
      expect(sessao.status).toBe('open');
      // A reserva continua presa — é o custo aceito, e é menor que a loja parada.
      expect(getAvailable(companyId, produto)).toBe(4);
    } finally {
      getConnection().exec('DROP TRIGGER IF EXISTS tg_prova_expiracao;');
    }
  });
});
