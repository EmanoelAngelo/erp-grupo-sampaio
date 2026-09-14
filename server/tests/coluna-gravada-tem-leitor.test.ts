/**
 * TRÊS COLUNAS QUE TINHAM ESCRITOR E NÃO TINHAM LEITOR — e o que cada uma
 * deixava passar enquanto ficava calada.
 *
 * A regra é do cabeçalho de `SalePolicyService` e vale para o sistema inteiro:
 * coluna que ninguém lê não é dado, é ficção com custo de manutenção. Ela dá a
 * IMPRESSÃO de que uma decisão está sendo tomada — o número está lá, no banco,
 * com nome de gente — e a decisão não está em lugar nenhum. As três abaixo
 * nasceram na mesma rodada que escreveu a regra, o que só mostra o quanto é
 * fácil escorregar:
 *
 *   core_authorizations.granted_gross_cents   escrita na liberação, devolvida
 *                                             na resposta, e NENHUMA decisão a
 *                                             consultava.
 *   core_quotes.concession_gross_cents        escrita no INSERT do documento e
 *                                             lida por ninguém.
 *   core_quotes.authorization_id              escrita na criação e lida por
 *                                             ninguém — nem por tela, nem por
 *                                             relatório.
 *
 * Cada `describe` abaixo é uma dessas colunas virando decisão ou virando tela.
 *
 * COMO CADA CASO FALHA (verificado apagando o leitor de propósito):
 *
 *   - tirando a comparação de percentual de `consumirLiberacaoDeConcessao`, a
 *     venda com o carrinho trocado fecha com a assinatura de um gestor que
 *     aprovou outra coisa, e o primeiro grupo falha;
 *   - voltando a conversão a comparar CENTAVOS, a queda de preço deixa de virar
 *     linha de auditoria e o segundo grupo falha;
 *   - tirando a junção de `getQuoteDetail`, o documento volta a não saber quem
 *     liberou o desconto dele e o terceiro grupo falha.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createQuote, convertQuote } from '../src/services/core/QuoteService.js';

const MOTO = 1_200_000;
const OLEO = 5_000;
const LOJA = 'loja-leitor';

const app = createApp();

/** Quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = { profileCodes: ['operador_caixa_loja'] };

function produto(id: string, nome: string, precoCents: number): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 'Geral', 0, 1, ?, ?)`,
    )
    .run(id, LOJA, id, nome, precoCents, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(LOJA, id, agora);
}

function precoDe(id: string, precoCents: number): void {
  getConnection()
    .prepare('UPDATE core_products SET price_cents = ? WHERE id = ? AND company_id = ?')
    .run(precoCents, id, LOJA);
}

/**
 * O GESTOR, com nome — porque a tela vai mostrar o nome dele.
 *
 * Gravado direto: o que está sob teste é o documento LEMBRAR quem liberou.
 * Quem prova que a credencial do gestor é conferida de verdade é o teste de
 * `authorizeAction`, em pdv-finalizacao.
 */
function gerente(): string {
  const id = 'u-gerente';
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_users (id, login, display_name, password_hash, active, created_at, updated_at)
       VALUES (?, 'gerente@loja-leitor', 'Ana Gerente', 'x', 1, ?, ?)`,
    )
    .run(id, agora, agora);
  return id;
}

/**
 * Liberação de gestor já registrada, com o que ele viu na tela ao dizer sim.
 *
 * `sobreCents` é `granted_gross_cents`: o BRUTO contra o qual a concessão foi
 * aprovada. É ele que transforma "liberei R$ 3.400" em "liberei 28,33%".
 */
function liberacao(opcoes: {
  para?: string;
  ateCents?: number | null;
  sobreCents?: number | null;
} = {}): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by,
          granted_concession_cents, granted_gross_cents, reason, created_at)
       VALUES (?, ?, 'desconto_acima_limite', ?, 'u-gerente', ?, ?, 'cliente antigo', ?)`,
    )
    .run(
      id,
      LOJA,
      opcoes.para ?? 'u-caixa',
      opcoes.ateCents ?? null,
      opcoes.sobreCents ?? null,
      new Date().toISOString(),
    );
  return id;
}

function consumoDa(id: string): { consumed_ref_id: string | null } {
  return getConnection()
    .prepare('SELECT consumed_ref_id FROM core_authorizations WHERE id = ?')
    .get(id) as never;
}

function venda(extra: Record<string, unknown>) {
  return createSale({
    companyId: LOJA,
    userId: 'u-caixa',
    idempotencyKey: randomUUID(),
    items: [],
    payments: [],
    ...extra,
  } as Parameters<typeof createSale>[0]);
}

function erroDe(fn: () => unknown): {
  code: string;
  message: string;
  details: Record<string, number | string>;
} {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string; details?: unknown };
    return { code: e.code, message: e.message, details: (e.details ?? {}) as never };
  }
  throw new Error('esperava um erro, e a operação passou');
}

function auditoria(acao: string): { detail: string }[] {
  return getConnection()
    .prepare('SELECT detail FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(LOJA, acao) as never;
}

/** Token do caixa, e o id real dele — é ele que a liberação carrega. */
async function operador(): Promise<{ token: string; userId: string }> {
  const res = await loginForTest(app, {
    userId: 'caixa',
    companyId: LOJA,
    profileCodes: ['operador_caixa_loja'],
  });
  expect(res.status).toBe(200);
  const linha = getConnection()
    .prepare('SELECT id FROM core_users WHERE login = ?')
    .get(`caixa@${LOJA}`) as { id: string };
  return { token: res.body.accessToken as string, userId: linha.id };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  await operador();
  gerente();
  produto('p-moto', 'Moto Elétrica', MOTO);
  produto('p-oleo', 'Óleo 1L', OLEO);
});

/* ========================================================================== */
/* COLUNA 1 — core_authorizations.granted_gross_cents                         */
/* ========================================================================== */

describe('a liberação do gestor vale como PERCENTUAL, e não só em centavos', () => {
  /*
    O gestor não aprova um número solto: ele olha uma venda. A tela diz
    "R$ 3.400,00 de concessão sobre R$ 12.000,00", ele lê os 28,3% e digita a
    senha. `granted_gross_cents` é a metade dessa frase que ficava muda.
  */
  const LIBERADO = 340_000; // R$ 3.400,00
  const SOBRE = MOTO; // ...sobre a moto de R$ 12.000,00 = 28,33%

  it('O CONTORNO: tirar a moto do carrinho fazia os MESMOS R$ 3.400 virarem 68%', () => {
    /*
      O teto em centavos não é ultrapassado — R$ 3.400 continuam sendo
      R$ 3.400 —, e por isso a venda fechava. O que mudou foi o denominador: o
      operador trocou o carrinho depois de o gerente ter ido embora, e a
      assinatura dele passou a cobrir uma venda que ele não viu.
    */
    const id = liberacao({ ateCents: LIBERADO, sobreCents: SOBRE });

    // 50 óleos = R$ 2.500,00 de bruto. R$ 1.000,00 de desconto são 40%.
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 50 }],
        discountCents: 100_000,
        payments: [{ method: 'dinheiro', amountCents: 150_000 }],
        alcada: { ...CAIXA, authorizationId: id },
      }),
    );

    expect(erro.code).toBe('CORE_AUTHORIZATION_ABOVE_PERCENT');
    // Os dois percentuais aparecem na mensagem: sem eles, quem está no balcão
    // não entende por que uma liberação de R$ 3.400 recusou um desconto de
    // R$ 1.000.
    expect(erro.details.percentualAutorizado).toBe(28.33);
    expect(erro.details.percentualPedido).toBe(40);
    expect(erro.details.autorizadoBrutoCents).toBe(SOBRE);

    // E a recusa acontece ANTES do consumo: a liberação continua inteira para
    // o documento certo, e o gerente não precisa ser chamado de novo por causa
    // de um erro que não foi dele.
    expect(consumoDa(id).consumed_ref_id).toBeNull();
  });

  it('no carrinho que o gestor VIU, a mesma liberação passa e é gasta', () => {
    /*
      A outra metade, e ela vale tanto quanto a recusa: um guarda que também
      barrasse a venda aprovada teria trocado um contorno por um balcão parado.
    */
    const id = liberacao({ ateCents: LIBERADO, sobreCents: SOBRE });

    const { sale } = venda({
      items: [{ productId: 'p-moto', quantity: 1 }],
      discountCents: LIBERADO,
      payments: [{ method: 'dinheiro', amountCents: MOTO - LIBERADO }],
      alcada: { ...CAIXA, authorizationId: id },
    });

    expect(sale.total_cents).toBe(MOTO - LIBERADO);
    expect(consumoDa(id).consumed_ref_id).toBe(sale.id);
  });

  it('liberação SEM bruto declarado continua valendo — a porta é estreita, não aberta', () => {
    /*
      É o caminho do PDV de hoje, que ainda manda só o `reason` em texto. Sem
      denominador não há percentual, e INVENTAR um seria pior que não comparar:
      recusaria venda legítima com um número que ninguém disse. O teto em
      centavos continua valendo, e o consumo continua sendo de uma vez só.
    */
    const id = liberacao({ ateCents: LIBERADO, sobreCents: null });

    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 50 }],
      discountCents: 100_000,
      payments: [{ method: 'dinheiro', amountCents: 150_000 }],
      alcada: { ...CAIXA, authorizationId: id },
    });

    expect(sale.total_cents).toBe(150_000);
    expect(consumoDa(id).consumed_ref_id).toBe(sale.id);
  });

  it('o teto em CENTAVOS continua de pé: quem estoura os dois é recusado por ele', () => {
    // R$ 4.000,00 de desconto contra uma liberação de R$ 3.400,00 — estoura o
    // valor absoluto, e a mensagem que serve é a do valor absoluto.
    const id = liberacao({ ateCents: LIBERADO, sobreCents: SOBRE });

    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1 }],
        discountCents: 400_000,
        payments: [{ method: 'dinheiro', amountCents: MOTO - 400_000 }],
        alcada: { ...CAIXA, authorizationId: id },
      }),
    );

    expect(erro.code).toBe('CORE_AUTHORIZATION_BELOW_CONCESSION');
  });
});

/* ========================================================================== */
/* COLUNA 2 — core_quotes.concession_gross_cents                              */
/* ========================================================================== */

describe('a conversão compara PERCENTUAL, e é aí que o bruto aprovado é lido', () => {
  function orcamentoDeOleo(descontoCents: number) {
    return createQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      kind: 'orcamento',
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: descontoCents,
      alcada: CAIXA,
    });
  }

  function converter(quoteId: string, pagoCents: number) {
    return convertQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      quoteId,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'dinheiro', amountCents: pagoCents }],
    });
  }

  it('o documento guarda o BRUTO junto com a concessão — e agora alguém o lê', () => {
    const doc = orcamentoDeOleo(2_500);
    const linha = getConnection()
      .prepare('SELECT concession_cents, concession_gross_cents FROM core_quotes WHERE id = ?')
      .get(doc.id) as { concession_cents: number; concession_gross_cents: number };

    expect(linha).toEqual({ concession_cents: 2_500, concession_gross_cents: 50_000 });
  });

  it('PREÇO QUE CAIU: os mesmos centavos viraram uma FATIA maior, e isso vira auditoria', () => {
    /*
      O caso que a comparação em centavos deixava passar inteiro, e ele não tem
      nada de exótico numa loja que reajusta tabela para baixo (promoção, fim de
      linha, produto encalhado).

      Orçamento: 10 óleos a R$ 50,00 = R$ 500,00 de bruto, com R$ 25,00 de
      desconto de rodapé — 5%, dentro do limite do balcão.

      A tabela cai para R$ 40,00. Na conversão, o preço congelado do documento
      é limitado ao vigente (o cliente não paga mais do que a loja anuncia
      hoje), então o bruto passa a ser R$ 400,00 e o MESMO desconto de R$ 25,00
      vira 6,25%.

      Em centavos: diferença ZERO. Nenhuma linha, nenhum registro — a loja
      abriu mão de uma fatia maior do que a aprovada e ninguém ficava sabendo.
      Em percentual: 6,25% contra 5%, e o fato econômico vira linha.
    */
    const doc = orcamentoDeOleo(2_500);
    precoDe('p-oleo', 4_000);

    const r = converter(doc.id, 37_500);

    // Os centavos são exatamente os mesmos dos dois lados — é este par que
    // fazia o critério antigo ficar calado.
    expect(r.concessaoAutorizadaCents).toBe(2_500);
    expect(r.concessaoNaVendaCents).toBe(2_500);
    expect(r.diferencaCents).toBe(0);

    // E o percentual não é.
    expect(r.percentualAutorizado).toBe(5);
    expect(r.percentualNaVenda).toBe(6.25);

    const linhas = auditoria('quote.convert.concessao_aumentou');
    expect(linhas).toHaveLength(1);
    const detalhe = JSON.parse(linhas[0].detail) as Record<string, number>;
    expect(detalhe.brutoAutorizadoCents).toBe(50_000);
    expect(detalhe.percentualAutorizado).toBe(5);
    expect(detalhe.percentual).toBe(6.25);
  });

  it('PREÇO INALTERADO: mesma fatia, e nenhuma linha — o registro não vira ruído', () => {
    /*
      Um critério que registrasse tudo não registraria nada: a linha de
      auditoria só serve enquanto for rara o bastante para alguém abrir.
    */
    const doc = orcamentoDeOleo(2_500);
    const r = converter(doc.id, 47_500);

    expect(r.percentualAutorizado).toBe(5);
    expect(r.percentualNaVenda).toBe(5);
    expect(auditoria('quote.convert.concessao_aumentou')).toHaveLength(0);
  });

  it('PREÇO QUE SUBIU: continua virando linha, como antes', () => {
    // O reajuste para cima já era registrado pelo critério em centavos, e
    // continua sendo pelo de percentual — trocar o critério não podia PERDER o
    // caso que o antigo pegava.
    const doc = orcamentoDeOleo(2_500);
    precoDe('p-oleo', 6_000);

    const r = converter(doc.id, 47_500);

    expect(r.percentualAutorizado).toBe(5);
    // Bruto de R$ 600,00; concedido = R$ 25,00 de rodapé + R$ 100,00 de preço
    // congelado abaixo do vigente = R$ 125,00, ou 20,83%.
    expect(r.percentualNaVenda).toBeGreaterThan(20);
    expect(auditoria('quote.convert.concessao_aumentou')).toHaveLength(1);
  });

  it('documento SEM bruto guardado cai no critério antigo, e não em silêncio', () => {
    /*
      Documento com concessão medida e bruto nulo não nasce mais — as duas
      colunas são escritas na mesma linha do mesmo INSERT. Mas um banco
      restaurado pela metade é exatamente o estado que este arquivo já aprendeu
      a não supor, e sem denominador não há percentual: volta-se a comparar
      centavos, que registra menos do que se quer em vez de não registrar nada.
    */
    const doc = orcamentoDeOleo(2_500);
    getConnection()
      .prepare('UPDATE core_quotes SET concession_gross_cents = NULL WHERE id = ?')
      .run(doc.id);
    precoDe('p-oleo', 6_000);

    const r = converter(doc.id, 47_500);

    expect(r.percentualAutorizado).toBeNull();
    expect(r.diferencaCents).toBeGreaterThan(0);
    expect(auditoria('quote.convert.concessao_aumentou')).toHaveLength(1);
  });
});

/* ========================================================================== */
/* COLUNA 3 — core_quotes.authorization_id                                    */
/* ========================================================================== */

describe('o documento diz QUEM liberou o desconto dele', () => {
  it('a liberação consumida fica no documento, e o detalhe a devolve com NOME', async () => {
    const { token, userId } = await operador();
    const id = liberacao({ para: userId, ateCents: MOTO });

    // Moto de R$ 12.000 escrita por R$ 6.000: 50% de concessão, muito acima do
    // limite do balcão. Sem a liberação, este documento não existiria.
    const doc = await request(app)
      .post('/api/v1/core/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'orcamento',
        items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 600_000 }],
        authorizationId: id,
      });
    expect(doc.status).toBe(201);

    const detalhe = await request(app)
      .get(`/api/v1/core/quotes/${doc.body.id as string}`)
      .set('Authorization', `Bearer ${token}`);

    expect(detalhe.status).toBe(200);
    /*
      É esta a pergunta da conferência de caixa — "quem autorizou este
      desconto?" —, e antes ela só tinha resposta abrindo o relatório de
      autorizações e cruzando por horário. O nome mora em `core_users`, então é
      o servidor que junta: a tela não tem (nem deve ter) como cruzar as duas
      tabelas.
    */
    expect(detalhe.body.liberacao).toMatchObject({
      id,
      autorizado_por: 'Ana Gerente',
      granted_concession_cents: MOTO,
      reason: 'cliente antigo',
    });
  });

  it('documento que não precisou de gestor devolve liberação NULA', async () => {
    const { token } = await operador();

    // 4% de desconto: cabe no limite do balcão, ninguém foi chamado.
    const doc = await request(app)
      .post('/api/v1/core/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'orcamento',
        items: [{ productId: 'p-oleo', quantity: 10 }],
        discountCents: 2_000,
      });
    expect(doc.status).toBe(201);

    const detalhe = await request(app)
      .get(`/api/v1/core/quotes/${doc.body.id as string}`)
      .set('Authorization', `Bearer ${token}`);

    // Nulo aqui é informação, e não buraco: significa que a concessão coube no
    // limite. É por isso que a tela não mostra um "Liberado por: —" fixo.
    expect(detalhe.body.liberacao).toBeNull();
  });
});
