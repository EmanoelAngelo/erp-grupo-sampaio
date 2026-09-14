/**
 * ============================================================================
 * O DOCUMENTO ABERTO SE CORRIGE — e o vendedor dele atravessa a conversão
 * ============================================================================
 *
 * ## GAP-V66: o beco anunciado
 *
 * Não havia PUT nem PATCH em `/quotes`, e `QuoteService` não tinha
 * `updateQuote`. Erro de digitação ou cliente que troca um item custava o
 * documento inteiro: cancelar e redigitar, perdendo NÚMERO (que é como o
 * balcão fala — "orçamento 47"), histórico, e a liberação de gestor já
 * consumida — que é gasta UMA vez e não volta.
 *
 * Pior era o vencimento. O servidor recusa converter documento vencido com
 * "Renove a validade antes de converter", a aprovação diz "Renove a validade
 * antes de aprovar" e a TELA repete a frase — e não existia rota, serviço nem
 * botão que renovasse coisa alguma. Três mensagens mandando fazer uma coisa
 * que o sistema não sabia fazer.
 *
 * ## GAP-V67: a comissão do caixa
 *
 * `core_quotes.seller_id` existia, a rota aceitava `sellerId`, `convertQuote`
 * propagava `quote.seller_id` e `createSale` faz `input.sellerId ?? input.userId`.
 * O elo que faltava era a TELA — e sem ele o documento nascia com vendedor
 * NULO, a conversão propagava nulo, e o `??` caía no usuário que estava
 * faturando. Em loja com comissionamento ativo a comissão nascia para o CAIXA.
 *
 * O teste de comissão abaixo é o que prova a correção: ele mede a linha de
 * `core_commission_entries` e cobra o NOME de quem vendeu, não o de quem
 * recebeu o dinheiro.
 *
 * ## Como estes guardas falham (quebrando de propósito)
 *
 *   - troque `sellerId: (quote.seller_id as string | null) ?? null` por
 *     `null` em `convertQuote` → "a comissão é de quem VENDEU" fica vermelho;
 *   - deixe `updateQuote` aceitar documento convertido → "convertido não
 *     muda" fica vermelho;
 *   - faça `renewQuote` aceitar status 'expirado' → "expirado não renova"
 *     fica vermelho;
 *   - tire o reajuste de reserva de `updateQuote` → "a reserva acompanha a
 *     edição" fica vermelho e a mercadoria fica presa.
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
  convertQuote,
  createQuote,
  getQuoteDetail,
  promoteToPreSale,
  renewQuote,
  updateQuote,
} = await import('../src/services/core/QuoteService.js');
const { createGroup, setTier, setMemberGroup, listEntries } = await import(
  '../src/services/core/CommissionService.js'
);

let companyId: string;
let produto: string;
let outroProduto: string;
/** Quem opera o CAIXA — recebe o dinheiro, e não vendeu nada. */
let caixaId: string;
/** Quem VENDEU — montou o orçamento no salão. */
let vendedorId: string;

function daqui(dias: number): string {
  return new Date(Date.now() + dias * 86400000).toISOString();
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
    slug: 'me-mimei',
    legalName: 'Me Mimei Modas Ltda',
    tradeName: 'Me Mimei',
  });
  caixaId = await upsertUser({
    login: 'CAIXA',
    displayName: 'Caixa do Balcão',
    password: 'senha-teste-123',
  });
  vendedorId = await upsertUser({
    login: 'VENDEDORA',
    displayName: 'Vendedora do Salão',
    password: 'senha-teste-123',
  });
  linkUserToCompany(caixaId, companyId, 'operador_caixa_loja', true);
  linkUserToCompany(vendedorId, companyId, 'atendente', true);

  produto = String(createProduct(companyId, { name: 'Vestido longo', priceCents: 20000 }).id);
  outroProduto = String(createProduct(companyId, { name: 'Cinto de couro', priceCents: 5000 }).id);
  for (const p of [produto, outroProduto]) {
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

function abrir(kind: 'orcamento' | 'pre_venda', quantidade = 2, extra: Record<string, unknown> = {}) {
  return createQuote({
    companyId,
    userId: vendedorId,
    kind,
    items: [{ productId: produto, quantity: quantidade }],
    ...extra,
  });
}

// ---------------------------------------------------------------- GAP-V66

describe('o documento aberto se corrige sem perder o número', () => {
  it('troca item e quantidade, e o número continua o mesmo', () => {
    const doc = abrir('orcamento', 2);

    const editado = updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [
        { productId: produto, quantity: 3 },
        { productId: outroProduto, quantity: 1 },
      ],
    });

    expect(editado.number).toBe(doc.number);
    expect(editado.id).toBe(doc.id);
    expect(editado.total_cents).toBe(3 * 20000 + 5000);

    const itens = getQuoteDetail(companyId, doc.id)?.items as Record<string, unknown>[];
    expect(itens).toHaveLength(2);
  });

  it('o desconto do rodapé se corrige, e o total acompanha', () => {
    const doc = abrir('orcamento', 2, { discountCents: 10000 });
    expect(doc.total_cents).toBe(2 * 20000 - 10000);

    const editado = updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 2 }],
      discountCents: 2000,
    });
    expect(editado.total_cents).toBe(2 * 20000 - 2000);
  });

  it('a edição deixa trilha com o antes e o depois', () => {
    const doc = abrir('orcamento', 2);
    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 5 }],
    });

    const linhas = auditoria('quote.update');
    expect(linhas).toHaveLength(1);
    const detalhe = JSON.parse(String(linhas[0].detail)) as Record<string, unknown>;
    expect(detalhe.totalAnteriorCents).toBe(2 * 20000);
    expect(detalhe.totalCents).toBe(5 * 20000);
  });

  it('documento CONVERTIDO não muda — a venda já aconteceu', () => {
    const doc = abrir('orcamento', 2);
    convertQuote({
      companyId,
      userId: caixaId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    expect(() =>
      updateQuote({
        companyId,
        userId: vendedorId,
        quoteId: doc.id,
        items: [{ productId: produto, quantity: 1 }],
      }),
    ).toThrowError(/já virou a venda|não pode ser editado/i);
  });

  it('documento de outra empresa não é alcançável', () => {
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    const doc = abrir('orcamento', 1);
    expect(() =>
      updateQuote({
        companyId: outra,
        userId: vendedorId,
        quoteId: doc.id,
        items: [{ productId: produto, quantity: 1 }],
      }),
    ).toThrowError(/não encontrado/i);
  });
});

describe('a reserva da pré-venda acompanha a edição', () => {
  it('subir a quantidade segura mais mercadoria', () => {
    const doc = abrir('pre_venda', 3);
    expect(getAvailable(companyId, produto)).toBe(7);

    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 6 }],
    });

    expect(getAvailable(companyId, produto)).toBe(4);
    expect(getBalance(companyId, produto)).toBe(10);
  });

  it('baixar a quantidade devolve a diferença ao disponível', () => {
    const doc = abrir('pre_venda', 6);
    expect(getAvailable(companyId, produto)).toBe(4);

    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 2 }],
    });

    expect(getAvailable(companyId, produto)).toBe(8);
  });

  it('tirar o item devolve TUDO o que ele segurava', () => {
    const doc = createQuote({
      companyId,
      userId: vendedorId,
      kind: 'pre_venda',
      items: [
        { productId: produto, quantity: 3 },
        { productId: outroProduto, quantity: 4 },
      ],
    });
    expect(getAvailable(companyId, outroProduto)).toBe(6);

    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 3 }],
    });

    expect(getAvailable(companyId, outroProduto)).toBe(10);
    expect(getAvailable(companyId, produto)).toBe(7);
  });

  it('editar acima do saldo é recusado — e nada muda', () => {
    const doc = abrir('pre_venda', 3);
    expect(() =>
      updateQuote({
        companyId,
        userId: vendedorId,
        quoteId: doc.id,
        items: [{ productId: produto, quantity: 40 }],
      }),
    ).toThrowError(/insuficiente/i);

    // A recusa não pode deixar a mercadoria solta: o documento antigo continua
    // segurando exatamente o que segurava.
    expect(getAvailable(companyId, produto)).toBe(7);
    const itens = getQuoteDetail(companyId, doc.id)?.items as Record<string, unknown>[];
    expect(itens).toHaveLength(1);
    expect(itens[0].quantity).toBe(3);
  });

  it('a pré-venda editada converte pela quantidade NOVA', () => {
    const doc = abrir('pre_venda', 3);
    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 5 }],
    });

    convertQuote({
      companyId,
      userId: caixaId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 5 * 20000 }],
    });

    expect(getBalance(companyId, produto)).toBe(5);
    // Reserva solta por inteiro: disponível volta a bater com o saldo.
    expect(getAvailable(companyId, produto)).toBe(5);
  });
});

describe('a validade se renova — o beco que três mensagens anunciavam', () => {
  it('documento vencido volta a valer e converte', () => {
    const doc = abrir('orcamento', 2, { validUntil: daqui(-1) });
    expect(() =>
      convertQuote({
        companyId,
        userId: caixaId,
        quoteId: doc.id,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'dinheiro', amountCents: 40000 }],
      }),
    ).toThrowError(/vencido/i);

    renewQuote({ companyId, userId: vendedorId, quoteId: doc.id, validUntil: daqui(7) });

    const { saleId } = convertQuote({
      companyId,
      userId: caixaId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });
    expect(saleId).toBeTruthy();
  });

  it('renovar sem data usa a validade da política, contada de hoje', () => {
    const doc = abrir('orcamento', 1, { validUntil: daqui(-3) });
    const renovado = renewQuote({ companyId, userId: vendedorId, quoteId: doc.id });
    expect(new Date(String(renovado.valid_until)).getTime()).toBeGreaterThan(Date.now());
  });

  it('renovar NÃO mexe em preço nem em reserva', () => {
    const doc = abrir('pre_venda', 4, { validUntil: daqui(-1) });
    const antes = getAvailable(companyId, produto);
    const renovado = renewQuote({ companyId, userId: vendedorId, quoteId: doc.id });
    expect(renovado.total_cents).toBe(doc.total_cents);
    expect(getAvailable(companyId, produto)).toBe(antes);
  });

  it('a renovação deixa trilha com a validade velha e a nova', () => {
    const doc = abrir('orcamento', 1, { validUntil: daqui(-1) });
    renewQuote({ companyId, userId: vendedorId, quoteId: doc.id, validUntil: daqui(5) });
    const linhas = auditoria('quote.renew');
    expect(linhas).toHaveLength(1);
    const detalhe = JSON.parse(String(linhas[0].detail)) as Record<string, unknown>;
    expect(String(detalhe.validadeAnterior)).toContain('-');
    expect(detalhe.validUntil).not.toBe(detalhe.validadeAnterior);
  });

  it('documento EXPIRADO pela varredura não renova — a reserva dele já foi solta', () => {
    const doc = abrir('pre_venda', 3, { validUntil: daqui(-1) });
    getConnection()
      .prepare("UPDATE core_quotes SET status = 'expirado' WHERE id = ?")
      .run(doc.id);

    expect(() =>
      renewQuote({ companyId, userId: vendedorId, quoteId: doc.id }),
    ).toThrowError(/expirado|não pode ser renovado/i);
  });

  it('documento convertido não renova', () => {
    const doc = abrir('orcamento', 1);
    convertQuote({
      companyId,
      userId: caixaId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });
    expect(() =>
      renewQuote({ companyId, userId: vendedorId, quoteId: doc.id }),
    ).toThrowError(/já virou a venda|não pode ser renovado/i);
  });
});

// ---------------------------------------------------------------- GAP-V67

describe('a comissão é de quem VENDEU, não de quem recebeu o dinheiro', () => {
  /** 5% para todo mundo, a partir do primeiro centavo. */
  function comissaoDe5PorCento(): void {
    const grupo = createGroup(companyId, 'Salão');
    setTier(companyId, grupo.id, 0, 500);
    setMemberGroup(companyId, vendedorId, grupo.id);
    setMemberGroup(companyId, caixaId, grupo.id);
  }

  it('orçamento com vendedor: a comissão nasce para ele, e não para o caixa', () => {
    comissaoDe5PorCento();
    const doc = createQuote({
      companyId,
      userId: vendedorId,
      kind: 'orcamento',
      items: [{ productId: produto, quantity: 2 }],
      sellerId: vendedorId,
    });

    // Quem CONVERTE é o caixa — é ele que está com o token na mão no PDV.
    convertQuote({
      companyId,
      userId: caixaId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 40000 }],
    });

    const linhas = listEntries(companyId, {});
    expect(linhas).toHaveLength(1);
    expect(linhas[0].seller_id).toBe(vendedorId);
    expect(linhas[0].seller_id).not.toBe(caixaId);
    expect(linhas[0].amount_cents).toBe(Math.round(40000 * 0.05));
  });

  it('o vendedor atravessa a aprovação: orçamento → pré-venda → venda', () => {
    comissaoDe5PorCento();
    const orcamento = createQuote({
      companyId,
      userId: vendedorId,
      kind: 'orcamento',
      items: [{ productId: produto, quantity: 1 }],
      sellerId: vendedorId,
    });
    const preVenda = promoteToPreSale({
      companyId,
      userId: caixaId,
      quoteId: orcamento.id,
    });
    convertQuote({
      companyId,
      userId: caixaId,
      quoteId: preVenda.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });

    const linhas = listEntries(companyId, {});
    expect(linhas).toHaveLength(1);
    expect(linhas[0].seller_id).toBe(vendedorId);
  });

  it('sem vendedor no documento, a comissão continua caindo para quem converte', () => {
    /*
      O ESTADO ANTIGO, GRAVADO COMO TESTE — e é o que dá sentido aos dois casos
      acima. `createSale` faz `sellerId ?? userId`, e o fallback está CERTO para
      a venda de balcão digitada no PDV. O defeito nunca foi o `??`: era o
      documento nascer sem vendedor porque a TELA não tinha o campo.
    */
    comissaoDe5PorCento();
    const doc = abrir('orcamento', 1);
    convertQuote({
      companyId,
      userId: caixaId,
      quoteId: doc.id,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });
    expect(listEntries(companyId, {})[0].seller_id).toBe(caixaId);
  });

  it('a edição troca o vendedor do documento', () => {
    const doc = createQuote({
      companyId,
      userId: vendedorId,
      kind: 'orcamento',
      items: [{ productId: produto, quantity: 1 }],
      sellerId: caixaId,
    });
    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 1 }],
      sellerId: vendedorId,
    });
    expect(getQuoteDetail(companyId, doc.id)?.seller_id).toBe(vendedorId);
  });
});

/*
  A OBSERVAÇÃO NÃO TINHA COMO SAIR DO DOCUMENTO.

  O UPDATE usava `note = COALESCE(?, note)`, então o `null` que a tela manda ao
  limpar o campo era lido como "não mexa" — e o texto ANTIGO voltava. Não é
  cosmético: a observação carrega instrução de trabalho ("trocar o zíper"), e
  uma que não se apaga continua sendo executada depois de cancelada.

  A régua certa é a de customerId/sellerId, que este arquivo já usa:
  `undefined` é "não mandou o campo", `null` é "mandou vazio".
*/
describe('a observação do documento se apaga', () => {
  function observacaoDe(id: string): string | null {
    return (getQuoteDetail(companyId, id)?.note as string | null) ?? null;
  }

  it('mandar null APAGA — o texto antigo não volta', () => {
    const doc = abrir('orcamento', 1, { note: 'trocar o zíper antes de entregar' });
    expect(observacaoDe(doc.id)).toBe('trocar o zíper antes de entregar');

    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 1 }],
      note: null,
    });
    expect(observacaoDe(doc.id)).toBeNull();
  });

  it('não mandar o campo PRESERVA — ausente continua sendo "não mexa"', () => {
    const doc = abrir('orcamento', 1, { note: 'entregar sem embalagem' });
    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 3 }],
    });
    expect(observacaoDe(doc.id)).toBe('entregar sem embalagem');
  });

  it('mandar texto novo troca o antigo', () => {
    const doc = abrir('orcamento', 1, { note: 'primeira' });
    updateQuote({
      companyId,
      userId: vendedorId,
      quoteId: doc.id,
      items: [{ productId: produto, quantity: 1 }],
      note: 'segunda',
    });
    expect(observacaoDe(doc.id)).toBe('segunda');
  });
});

/*
  O VENDEDOR DO DOCUMENTO PRECISA EXISTIR — e não precisava.

  `createQuote` e `updateQuote` gravavam `input.sellerId ?? null` cru enquanto
  `createSale` conferia de verdade. Um id inventado (ou de OUTRA empresa)
  entrava no documento sem erro e só estourava na CONVERSÃO, com o cliente
  esperando no balcão — que é o pior momento para descobrir, e é o argumento
  que o próprio `convertQuote` já fazia.
*/
describe('o vendedor gravado no documento é conferido', () => {
  it('id inventado é recusado na criação, e nenhum documento nasce', () => {
    expect(() =>
      createQuote({
        companyId,
        userId: vendedorId,
        kind: 'orcamento',
        items: [{ productId: produto, quantity: 1 }],
        sellerId: 'ninguem-com-esse-id',
      }),
    ).toThrowError(/não faz parte desta operação/i);

    expect(
      Number(
        (
          getConnection()
            .prepare('SELECT COUNT(*) AS n FROM core_quotes WHERE company_id = ?')
            .get(companyId) as { n: number }
        ).n,
      ),
    ).toBe(0);
  });

  it('vendedor de OUTRA empresa é recusado', async () => {
    const outra = upsertCompany({
      slug: 'pj-motors-vendedor',
      legalName: 'PJ Motors Ltda',
      tradeName: 'PJ Motors',
    });
    const forasteiro = await upsertUser({
      login: 'FORASTEIRO',
      displayName: 'Vendedor de outra loja',
      password: 'senha-teste-123',
    });
    linkUserToCompany(forasteiro, outra, 'atendente', true);

    expect(() =>
      createQuote({
        companyId,
        userId: vendedorId,
        kind: 'orcamento',
        items: [{ productId: produto, quantity: 1 }],
        sellerId: forasteiro,
      }),
    ).toThrowError(/não faz parte desta operação/i);
  });

  it('a edição confere igual — a fresta não reabre no PATCH', () => {
    const doc = abrir('orcamento', 1);
    expect(() =>
      updateQuote({
        companyId,
        userId: vendedorId,
        quoteId: doc.id,
        items: [{ productId: produto, quantity: 1 }],
        sellerId: 'ninguem-com-esse-id',
      }),
    ).toThrowError(/não faz parte desta operação/i);
    expect(getQuoteDetail(companyId, doc.id)?.seller_id).toBeNull();
  });
});
