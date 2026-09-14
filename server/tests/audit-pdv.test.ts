/**
 * ============================================================================
 * AUDITORIA FASE 6 — O PDV CERTIFICADO NAS SEIS OPERAÇÕES
 * ============================================================================
 *
 * O dono pediu a prova de que O MESMO turno de caixa fecha redondo em cada uma
 * das seis empresas do grupo — não em "uma loja de teste". Cada operação tem
 * seu CNPJ, seu operador, sua numeração de venda e sua gaveta; o que este
 * arquivo percorre, POR EMPRESA, é o turno inteiro pela API:
 *
 *   login do operador → abrir caixa com fundo de troco → cadastrar e estocar
 *   mercadoria → achar produto (busca por texto E bipe de código de barras) →
 *   montar o carrinho (quantidade alterada, um item removido antes de fechar)
 *   → desconto dentro da alçada → cliente com CPF válido → DINHEIRO com troco
 *   → finalizar → provar estoque, lista de vendas, gaveta e financeiro em
 *   CENTAVOS EXATOS → fechar o caixa com diferença ZERO.
 *
 * A aritmética do turno, fixada de propósito (a mesma nas seis):
 *
 *   fundo de troco ............ R$ 100,00  (10000)
 *   Camiseta 2 × R$ 35,00 ..... R$  70,00  ( 7000)
 *   Bermuda 1 × R$ 49,90 ...... R$  49,90  ( 4990)
 *   (Cinto de R$ 12,00 entrou no carrinho e SAIU antes de fechar)
 *   subtotal .................. R$ 119,90  (11990)
 *   desconto de rodapé ........ R$   9,90  (  990) → 8,26% < 10% da alçada
 *   TOTAL ..................... R$ 110,00  (11000)
 *   entregue em dinheiro ...... R$ 150,00  (15000)
 *   TROCO ..................... R$  40,00  ( 4000)
 *   fica na gaveta ............ R$ 110,00  (11000)
 *   esperado no fechamento .... R$ 210,00  (21000) → contado 21000, diferença 0
 *
 * O que os 3.900 testes da casa JÁ provam não é repetido aqui (alçada acima do
 * limite, idempotência do clique duplo, pagamento dividido, parcelamento de
 * cartão, cancelamento). Os casos únicos no fim são os dois buracos que o grep
 * da casa NÃO achou coberto: vender contra caixa FECHADO e vender produto
 * INATIVO apontado por id — mais o pagamento eletrônico manual que não pode
 * tocar na gaveta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { digitoVerificadorGtin } from '../src/services/core/Gtin.js';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Turno@Certificado2026';

/** As seis operações reais do grupo — slugs e tipos do bootstrap (server/src/db/bootstrap.ts). */
const OPERACOES = [
  { slug: 'preco-justo', nome: 'Preço Justo', kind: 'retail' },
  { slug: 'gringa', nome: 'Gringa', kind: 'retail' },
  { slug: 'me-mimei', nome: 'Me Mimei', kind: 'retail' },
  { slug: 'conceito', nome: 'Conceito', kind: 'retail' },
  { slug: 'pj-motors', nome: 'PJ Motors', kind: 'retail' },
  { slug: 'oficina', nome: 'Oficina', kind: 'workshop' },
] as const;

type Operacao = (typeof OPERACOES)[number];

const companyIds = new Map<string, string>();

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

/** Usuário de verdade, senha Argon2id, login real — nada de token forjado. */
async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/** O operador de caixa da operação, com o perfil que o seed dá de verdade. */
function perfilDoCaixa(op: Operacao): string {
  return op.kind === 'workshop' ? 'operador_caixa_oficina' : 'operador_caixa_loja';
}

/** O gerente da operação — é ele quem lê o financeiro. */
function perfilDoGerente(op: Operacao): string {
  return op.kind === 'workshop' ? 'gerente_oficina' : 'gerente_loja';
}

/** Cadastra um produto pela API, como o balcão cadastra. */
async function cadastrarProduto(
  auth: Ator['auth'],
  corpo: { name: string; priceCents: number; barcode?: string },
): Promise<string> {
  const res = await request(app).post('/api/v1/core/products').set(auth).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Entrada de estoque pela API, com a referência que a rota exige. */
async function estocar(
  auth: Ator['auth'],
  productId: string,
  quantity: number,
): Promise<number> {
  const res = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(auth)
    .send({
      productId,
      movementType: 'in',
      quantity,
      referenceType: 'entrada',
      referenceId: `carga-${productId}`,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.balance as number;
}

/** O saldo cru da prateleira, direto do razão — a prova final de cada baixa. */
function saldoNoBanco(companyId: string, productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

/** Movimentos de gaveta que uma venda gerou (deve ser UM, líquido de troco). */
function movimentosDaVenda(saleId: string): { movement_type: string; amount_cents: number }[] {
  return getConnection()
    .prepare(
      `SELECT movement_type, amount_cents FROM core_cash_movements
        WHERE reference_type = 'sale' AND reference_id = ?`,
    )
    .all(saleId) as unknown as { movement_type: string; amount_cents: number }[];
}

beforeEach(() => {
  resetDbForTests();
  companyIds.clear();
  for (const op of OPERACOES) {
    companyIds.set(
      op.slug,
      upsertCompany({
        slug: op.slug,
        legalName: `${op.nome} Ltda`,
        tradeName: op.nome,
        kind: op.kind,
      }),
    );
  }
});

// ============================================================================
// O TURNO CERTIFICADOR, POR EMPRESA
// ============================================================================

describe.each(OPERACOES)('o turno de caixa fecha redondo na $nome', (op) => {
  it('login → caixa → busca e bipe → carrinho → desconto → CPF → dinheiro com troco → provas → fechamento zero', async () => {
    const companyId = companyIds.get(op.slug)!;
    const caixa = await ator(`caixa.${op.slug}`, companyId, perfilDoCaixa(op));
    // Quem cadastra e estoca a mercadoria é a gerência (PJ-CAIXA: o caixa da loja não administra produto).
    const cadastro = await ator(`cadastro.${op.slug}`, companyId, 'gerente_loja');

    // ---- abre o caixa com fundo de troco de R$ 100,00
    const abertura = await request(app)
      .post('/api/v1/core/cash/open')
      .set(caixa.auth)
      .send({ openingCents: 10_000 });
    expect(abertura.status, JSON.stringify(abertura.body)).toBe(201);
    expect(abertura.body.status).toBe('open');
    expect(abertura.body.opening_cents).toBe(10_000);
    const sessao = abertura.body.id as string;

    // E o PDV encontra o caixa aberto ao recarregar a tela.
    const aberto = await request(app).get('/api/v1/core/cash/open').set(caixa.auth);
    expect(aberto.status).toBe(200);
    expect(aberto.body.session?.id).toBe(sessao);

    // ---- a mercadoria do dia, cadastrada e estocada pela gerência (PJ-CAIXA)
    // EAN com o verificador calculado: código com o dígito errado agora é recusado no cadastro.
    const baseBermuda = `789${String(1000 + OPERACOES.indexOf(op)).padStart(4, '0')}00020`;
    const eanBermuda = `${baseBermuda}${digitoVerificadorGtin(baseBermuda)}`;
    const camiseta = await cadastrarProduto(cadastro.auth, {
      name: `Camiseta Básica ${op.nome}`,
      priceCents: 3_500,
    });
    const bermuda = await cadastrarProduto(cadastro.auth, {
      name: `Bermuda Jeans ${op.nome}`,
      priceCents: 4_990,
      barcode: eanBermuda,
    });
    const cinto = await cadastrarProduto(cadastro.auth, {
      name: `Cinto de Couro ${op.nome}`,
      priceCents: 1_200,
    });
    expect(await estocar(cadastro.auth, camiseta, 20)).toBe(20);
    expect(await estocar(cadastro.auth, bermuda, 15)).toBe(15);
    expect(await estocar(cadastro.auth, cinto, 8)).toBe(8);

    // ---- ACHAR o produto: busca por texto…
    const busca = await request(app)
      .get(`/api/v1/core/products/search?q=${encodeURIComponent('Camiseta Básica')}`)
      .set(caixa.auth);
    expect(busca.status, JSON.stringify(busca.body)).toBe(200);
    const daBusca = (busca.body.items as Record<string, unknown>[]).find(
      (i) => i.id === camiseta,
    );
    expect(daBusca, 'a busca por texto tem de achar a camiseta').toBeDefined();
    expect(daBusca!.price_cents).toBe(3_500);
    expect(daBusca!.effective_price_cents).toBe(3_500);
    expect(daBusca!.stock_quantity).toBe(20);

    // …e bipe do código de barras — o item bipado vem PRIMEIRO.
    const bipe = await request(app)
      .get(`/api/v1/core/products/search?q=${eanBermuda}`)
      .set(caixa.auth);
    expect(bipe.status).toBe(200);
    expect(bipe.body.items.length).toBeGreaterThan(0);
    expect(bipe.body.items[0].id).toBe(bermuda);
    expect(bipe.body.items[0].price_cents).toBe(4_990);

    // ---- o cliente com CPF válido, com máscara e tudo (o banco guarda só dígitos)
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(caixa.auth)
      .send({ name: `Cliente Fiel da ${op.nome}`, document: '529.982.247-25' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    expect(cliente.body.document).toBe('52998224725');

    // ---- a alçada da operação, perguntada ANTES de dar o desconto
    const politica = await request(app)
      .get('/api/v1/core/sales/discount-policy')
      .set(caixa.auth);
    expect(politica.status).toBe(200);
    expect(politica.body.operatorLimitPercent).toBe(10);
    expect(politica.body.canAuthorizeSelf).toBe(false);

    /*
      O carrinho da história: camiseta (qtd 1→2, ALTERADA), bermuda, e o cinto
      que entrou e foi REMOVIDO antes de fechar. O que a API recebe é o
      carrinho final — e a prova de que o cinto saiu é o saldo dele intacto lá
      embaixo. Desconto de rodapé de R$ 9,90 = 8,26% do bruto de R$ 119,90,
      DENTRO dos 10% — nenhum gestor é chamado.
    */
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', `turno-${op.slug}-1`)
      .send({
        cashSessionId: sessao,
        customerId: cliente.body.id,
        items: [
          { productId: camiseta, quantity: 2 },
          { productId: bermuda, quantity: 1 },
        ],
        discountCents: 990,
        payments: [{ method: 'dinheiro', amountCents: 15_000 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const saleId = venda.body.id as string;

    // A matemática da finalização, centavo a centavo.
    expect(venda.body.number).toBe(1); // numeração própria desta empresa
    expect(venda.body.total_cents).toBe(11_000); // 7000 + 4990 − 990
    expect(venda.body.change_cents).toBe(4_000); // 15000 − 11000
    expect(venda.body.status).toBe('completed');

    // ---- PROVA 1: o estoque baixou o que saiu — e SÓ o que saiu.
    expect(saldoNoBanco(companyId, camiseta)).toBe(18); // 20 − 2
    expect(saldoNoBanco(companyId, bermuda)).toBe(14); // 15 − 1
    expect(saldoNoBanco(companyId, cinto)).toBe(8); // removido do carrinho: intacto
    // E a superfície que o PDV enxerga diz o mesmo número.
    const rebipe = await request(app)
      .get(`/api/v1/core/products/search?q=${eanBermuda}`)
      .set(caixa.auth);
    expect(rebipe.body.items[0].stock_quantity).toBe(14);

    // ---- PROVA 2: a venda aparece na lista do turno, com o detalhe inteiro.
    const lista = await request(app).get('/api/v1/core/sales').set(caixa.auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].id).toBe(saleId);
    expect(lista.body.items[0].total_cents).toBe(11_000);

    const detalhe = await request(app).get(`/api/v1/core/sales/${saleId}`).set(caixa.auth);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.items).toHaveLength(2);
    expect(detalhe.body.discount_cents).toBe(990);
    expect(detalhe.body.customer_id).toBe(cliente.body.id);
    const linhaCamiseta = (detalhe.body.items as Record<string, unknown>[]).find(
      (i) => i.product_id === camiseta,
    )!;
    expect(linhaCamiseta.quantity).toBe(2);
    expect(linhaCamiseta.unit_price_cents).toBe(3_500);
    expect(linhaCamiseta.total_cents).toBe(7_000);
    expect(detalhe.body.payments).toHaveLength(1);
    expect(detalhe.body.payments[0].method).toBe('dinheiro');
    expect(detalhe.body.payments[0].amount_cents).toBe(15_000);

    // ---- PROVA 3: a gaveta recebeu UM movimento, líquido de troco.
    const naGaveta = movimentosDaVenda(saleId);
    expect(naGaveta).toHaveLength(1);
    expect(naGaveta[0].movement_type).toBe('sale');
    expect(naGaveta[0].amount_cents).toBe(11_000); // 15000 entregues − 4000 de troco

    // O resumo do turno escreve a conta inteira: entregue − troco = gaveta.
    const resumo = await request(app)
      .get(`/api/v1/core/cash/${sessao}/summary`)
      .set(caixa.auth);
    expect(resumo.status).toBe(200);
    expect(resumo.body.expectedCents).toBe(21_000); // 10000 de fundo + 11000 da venda
    expect(resumo.body.changeCents).toBe(4_000);
    expect(resumo.body.byMethod).toEqual([{ method: 'dinheiro', total: 15_000 }]);
    const tipos = (resumo.body.movements as { movement_type: string }[]).map(
      (m) => m.movement_type,
    );
    expect(tipos.sort()).toEqual(['opening', 'sale']);

    // ---- PROVA 4: o financeiro tem UM lançamento, quitado, do total da venda.
    const gerente = await ator(`gerente.${op.slug}`, companyId, perfilDoGerente(op));
    const financeiro = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(gerente.auth);
    expect(financeiro.status, JSON.stringify(financeiro.body)).toBe(200);
    // A listagem da tela não expõe originId — a venda se apresenta pelo
    // número no description, que é o que o gerente lê.
    const daVenda = (financeiro.body.items as Record<string, unknown>[]).filter(
      (e) => e.originType === 'sale' && e.description === 'Venda #1',
    );
    expect(daVenda).toHaveLength(1);
    expect(daVenda[0].amountCents).toBe(11_000); // o total — nunca os 15000 entregues
    expect(daVenda[0].settledCents).toBe(11_000);
    expect(daVenda[0].balanceCents).toBe(0);
    expect(daVenda[0].status).toBe('settled');
    // E o total somado no banco diz o mesmo número — o relatório fecha.
    expect(financeiro.body.summary.settledCents).toBe(11_000);
    expect(financeiro.body.summary.openCents).toBe(0);
    // A prova de origem em id, que a listagem não carrega, sai do razão cru.
    const lancamento = getConnection()
      .prepare(
        `SELECT amount_cents, settled_cents, status FROM core_finance_entries
          WHERE company_id = ? AND origin_type = 'sale' AND origin_id = ?`,
      )
      .all(companyId, saleId) as { amount_cents: number; settled_cents: number; status: string }[];
    expect(lancamento).toHaveLength(1);
    expect(lancamento[0].amount_cents).toBe(11_000);
    expect(lancamento[0].settled_cents).toBe(11_000);

    // ---- fecha o caixa contando EXATAMENTE o que a conta diz: diferença ZERO.
    const fechamento = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(caixa.auth)
      .send({ countedCents: 21_000 });
    expect(fechamento.status, JSON.stringify(fechamento.body)).toBe(200);
    expect(fechamento.body.status).toBe('closed');
    expect(fechamento.body.expected_cents).toBe(21_000);
    expect(fechamento.body.counted_cents).toBe(21_000);
    expect(fechamento.body.difference_cents).toBe(0);

    // E o terminal não acha mais caixa aberto — o turno acabou de verdade.
    const depois = await request(app).get('/api/v1/core/cash/open').set(caixa.auth);
    expect(depois.status).toBe(200);
    expect(depois.body.session).toBeNull();
  });
});

// ============================================================================
// CASOS ÚNICOS — numa empresa só (Gringa), o que o grep da casa NÃO achou coberto
// ============================================================================

describe('pagamento eletrônico manual não toca na gaveta (débito, crédito, PIX)', () => {
  it('as três vendas fecham, liquidam o financeiro, e o esperado da gaveta continua sendo só o fundo', async () => {
    const companyId = companyIds.get('gringa')!;
    const caixa = await ator('caixa.eletronico', companyId, 'operador_caixa_loja');
    // Quem cadastra e estoca a mercadoria é a gerência (PJ-CAIXA: o caixa da loja não administra produto).
    const cadastro = await ator('cadastro.eletronico', companyId, 'gerente_loja');

    const abertura = await request(app)
      .post('/api/v1/core/cash/open')
      .set(caixa.auth)
      .send({ openingCents: 5_000 });
    expect(abertura.status).toBe(201);
    const sessao = abertura.body.id as string;

    const produto = await cadastrarProduto(cadastro.auth, {
      name: 'Moletom Gringa',
      priceCents: 5_000,
    });
    await estocar(cadastro.auth, produto, 10);

    for (const metodo of ['debito', 'credito', 'pix'] as const) {
      const venda = await request(app)
        .post('/api/v1/core/sales')
        .set(caixa.auth)
        .set('Idempotency-Key', `eletronico-${metodo}`)
        .send({
          cashSessionId: sessao,
          items: [{ productId: produto, quantity: 1 }],
          payments: [{ method: metodo, amountCents: 5_000 }],
        });
      expect(venda.status, `${metodo}: ${JSON.stringify(venda.body)}`).toBe(201);
      expect(venda.body.total_cents).toBe(5_000);
      // Não existe troco de cartão nem de PIX — e nem sobra para haver.
      expect(venda.body.change_cents).toBe(0);
      // NENHUM movimento de gaveta: dinheiro eletrônico não vira cédula.
      expect(movimentosDaVenda(venda.body.id as string)).toHaveLength(0);

      // Sem operadora cadastrada, o financeiro nasce quitado no valor exato.
      const entrada = getConnection()
        .prepare(
          `SELECT amount_cents, settled_cents, status FROM core_finance_entries
            WHERE origin_type = 'sale' AND origin_id = ?`,
        )
        .get(venda.body.id) as { amount_cents: number; settled_cents: number; status: string };
      expect(entrada.amount_cents).toBe(5_000);
      expect(entrada.settled_cents).toBe(5_000);
      expect(entrada.status).toBe('settled');
    }

    // A conferência: três vendas de R$ 50, e a gaveta espera SÓ o fundo.
    const resumo = await request(app)
      .get(`/api/v1/core/cash/${sessao}/summary`)
      .set(caixa.auth);
    expect(resumo.body.expectedCents).toBe(5_000);
    const porMetodo = Object.fromEntries(
      (resumo.body.byMethod as { method: string; total: number }[]).map((m) => [
        m.method,
        m.total,
      ]),
    );
    expect(porMetodo).toEqual({ debito: 5_000, credito: 5_000, pix: 5_000 });

    // Fechar contando o fundo dá diferença zero — o eletrônico não infla a gaveta.
    const fechamento = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(caixa.auth)
      .send({ countedCents: 5_000 });
    expect(fechamento.body.difference_cents).toBe(0);
  });
});

describe('caixa fechado não recebe venda', () => {
  it('a venda apontando para a sessão já fechada é recusada NOMEADA, e nada é gravado', async () => {
    const companyId = companyIds.get('gringa')!;
    const caixa = await ator('caixa.tardio', companyId, 'operador_caixa_loja');
    // Quem cadastra e estoca a mercadoria é a gerência (PJ-CAIXA: o caixa da loja não administra produto).
    const cadastro = await ator('cadastro.tardio', companyId, 'gerente_loja');

    const produto = await cadastrarProduto(cadastro.auth, {
      name: 'Jaqueta Gringa',
      priceCents: 20_000,
    });
    await estocar(cadastro.auth, produto, 5);

    const abertura = await request(app)
      .post('/api/v1/core/cash/open')
      .set(caixa.auth)
      .send({ openingCents: 0 });
    const sessao = abertura.body.id as string;
    const fechamento = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(caixa.auth)
      .send({ countedCents: 0 });
    expect(fechamento.status).toBe(200);

    /*
      O turno acabou, conferido e assinado — e a venda chega atrasada apontando
      para ele. Dinheiro depois da conferência é diferença que o relatório
      nunca explica; o serviço recusa com nome, e a recusa tem de chegar ao
      PDV pela rota, não só existir no serviço.
    */
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'venda-no-turno-morto')
      .send({
        cashSessionId: sessao,
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 20_000 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(400);
    expect(venda.body.error?.code).toBe('CORE_CASH_SESSION_CLOSED');

    // Ou tudo, ou nada: sem venda, sem baixa, sem movimento na gaveta morta.
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(vendas.n).toBe(0);
    expect(saldoNoBanco(companyId, produto)).toBe(5);
    const sessaoDepois = getConnection()
      .prepare('SELECT expected_cents, difference_cents FROM core_cash_sessions WHERE id = ?')
      .get(sessao) as { expected_cents: number; difference_cents: number };
    expect(sessaoDepois.expected_cents).toBe(0);
    expect(sessaoDepois.difference_cents).toBe(0);
  });
});

describe('produto inativo não vende', () => {
  it('apontado por id direto na rota de venda — sem passar pela busca — a venda é recusada e o saldo fica', async () => {
    const companyId = companyIds.get('gringa')!;
    const caixa = await ator('caixa.inativo', companyId, 'operador_caixa_loja');
    // Quem cadastra e estoca a mercadoria é a gerência (PJ-CAIXA: o caixa da loja não administra produto).
    const cadastro = await ator('cadastro.inativo', companyId, 'gerente_loja');

    const abertura = await request(app)
      .post('/api/v1/core/cash/open')
      .set(caixa.auth)
      .send({ openingCents: 0 });
    const sessao = abertura.body.id as string;

    const produto = await cadastrarProduto(cadastro.auth, {
      name: 'Casaco Fora de Linha',
      priceCents: 9_900,
    });
    await estocar(cadastro.auth, produto, 3);

    // O gerente tira o produto de circulação (a regra da casa: active viaja no PUT).
    // É o GERENTE mesmo: desde o GAP-PRD-052 o PUT do cadastro não aceita o caixa.
    const gerente = await ator('gerente.inativo', companyId, 'gerente_loja');
    const inativa = await request(app)
      .put(`/api/v1/core/products/${produto}`)
      .set(gerente.auth)
      .send({ active: false });
    expect(inativa.status, JSON.stringify(inativa.body)).toBe(200);
    expect(inativa.body.active).toBe(0);

    /*
      `audit-manager.test.ts` já prova que o inativo SOME da busca. O buraco
      que sobrava é o id guardado: um carrinho velho na tela, um atalho, uma
      integração — o produto inativo apontado DIRETO na venda tem de ser
      recusado, senão a busca é só cosmética.
    */
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'venda-do-inativo')
      .send({
        cashSessionId: sessao,
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 9_900 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(404);
    expect(venda.body.error?.code).toBe('CORE_PRODUCT_NOT_FOUND');

    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(vendas.n).toBe(0);
    expect(saldoNoBanco(companyId, produto)).toBe(3);
  });
});
