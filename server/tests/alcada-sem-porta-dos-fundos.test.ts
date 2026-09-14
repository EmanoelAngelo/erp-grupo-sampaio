/**
 * OS TRÊS CONTORNOS DA ALÇADA — e por que cada caso aqui quebra sem o guarda.
 *
 * A rodada anterior fez a alçada medir a CONCESSÃO INTEIRA (rodapé + linha +
 * preço rebaixado) contra o bruto calculado no servidor. A trava ficou certa e
 * ficou contornável, por três caminhos que não davam erro nenhum:
 *
 *   1. A VENDA EM DUAS ETAPAS. `convertQuote` chamava `createSale` SEM alçada.
 *      O mesmo operador escrevia a moto de R$ 12.000 por R$ 1,00 num orçamento
 *      e convertia segundos depois. A porta da frente recusava; esta não. Duas
 *      chamadas HTTP e a trava sumia.
 *   2. ACRÉSCIMO NEGATIVO. `surchargeCents` entrava sem checagem de sinal, era
 *      somado ao total (podendo derrubá-lo a quase zero) e estava
 *      declaradamente FORA da concessão. Um acréscimo de -R$ 11.999,00 era um
 *      desconto que a alçada não via.
 *   3. A LIBERAÇÃO ETERNA. A autorização era conferida por EXISTÊNCIA
 *      (id + empresa + ação): nunca consumida, nunca vinculada à venda, sem
 *      valor. Um "sim" do gerente servia para infinitas vendas seguintes, de
 *      clientes diferentes, em dias diferentes — e um "sim" para 15% liberava
 *      60%.
 *
 * COMO ESTES CASOS FALHAM (verificado quebrando cada guarda de propósito):
 *
 *   - tirando a `alcada` de POST /core/quotes, os quatro casos de documento
 *     passam a criar o orçamento e falham aqui;
 *   - tirando a recusa de acréscimo negativo, a moto sai por R$ 1,00 e os dois
 *     casos de acréscimo falham;
 *   - trocando o consumo por um SELECT de existência, a segunda venda com a
 *     mesma liberação fecha e o caso do bilhete de uma viagem só falha;
 *   - ignorando `granted_concession_cents`, os 60% passam com a liberação de
 *     15% e o caso do teto falha;
 *   - ignorando `requested_by`, a liberação de um caixa serve para o outro.
 *
 * Nenhum caso procura texto de código: todos executam venda e documento de
 * verdade e conferem o que ficou no banco.
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
const LOJA = 'loja-alcada';

const app = createApp();

/** Perfil de quem opera o caixa: nenhuma alçada para liberar nada. */
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

function saldo(productId: string): { quantity: number; reserved: number } {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(LOJA, productId) as { quantity: number; reserved: number };
}

/**
 * Liberação de gestor já registrada, opcionalmente COM teto declarado.
 *
 * Gravada direto porque o que está sob teste é a venda/o documento CONSUMIR a
 * liberação; quem prova que a credencial do gestor é conferida de verdade é o
 * teste de `authorizeAction`, em pdv-finalizacao.
 */
function liberacao(
  opcoes: { para?: string; ateCents?: number | null } = {},
): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by,
          granted_concession_cents, created_at)
       VALUES (?, ?, 'desconto_acima_limite', ?, 'u-gerente', ?, ?)`,
    )
    .run(id, LOJA, opcoes.para ?? 'u-caixa', opcoes.ateCents ?? null, new Date().toISOString());
  return id;
}

function linhaDaLiberacao(id: string): {
  consumed_ref_type: string | null;
  consumed_ref_id: string | null;
  consumed_at: string | null;
} {
  return getConnection()
    .prepare(
      'SELECT consumed_ref_type, consumed_ref_id, consumed_at FROM core_authorizations WHERE id = ?',
    )
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

/**
 * O detalhe que acompanha a recusa — e ele é conteúdo, não enfeite.
 *
 * "Precisa de gestor" sem número manda quem está no balcão adivinhar o que
 * reduzir. Cada campo aqui é lido por algum caso abaixo justamente para que a
 * mensagem não possa emagrecer sem alguém notar.
 */
interface DetalheDaRecusa {
  brutoCents?: number;
  concedidoCents?: number;
  percentual?: number;
  limite?: number;
  origens?: { cabecalho: number; precoRebaixado: number };
  authorizationId?: string;
  autorizadoCents?: number;
  surchargeCents?: number;
}

/** Erro capturado com código e detalhe, que é o que o balcão vê. */
function erroDe(fn: () => unknown): {
  code: string;
  message: string;
  details: DetalheDaRecusa;
} {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string; details?: unknown };
    return { code: e.code, message: e.message, details: (e.details ?? {}) as DetalheDaRecusa };
  }
  throw new Error('esperava um erro, e a operação passou');
}

/** O operador do balcão, com token real e o id que a liberação vai carregar. */
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

function auditoria(acao: string): { detail: string }[] {
  return getConnection()
    .prepare('SELECT detail FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(LOJA, acao) as never;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  await operador();
  produto('p-moto', 'Moto Elétrica', MOTO);
  produto('p-oleo', 'Óleo 1L', OLEO);
});

/* ========================================================================== */
/* BLOQUEIO 1 — A VENDA EM DUAS ETAPAS                                        */
/* ========================================================================== */

describe('o orçamento deixou de ser a porta dos fundos da venda', () => {
  async function abrirOrcamento(token: string, corpo: Record<string, unknown>) {
    return request(app)
      .post('/api/v1/core/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send(corpo);
  }

  it('O CONTORNO INTEIRO, PELA PORTA ONDE ELE ESTAVA: a moto de R$ 12.000 por R$ 1,00', async () => {
    const { token } = await operador();

    // Passo 1 do contorno: escrever o preço rebaixado num documento. É aqui
    // que ele morria de graça — `createQuote` não conferia nada.
    const doc = await abrirOrcamento(token, {
      kind: 'orcamento',
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
    });

    expect(doc.status).toBe(403);
    expect(doc.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(doc.body.error.details.origens.precoRebaixado).toBe(MOTO - 100);
    expect(doc.body.error.details.percentual).toBeGreaterThan(99);

    // E o passo 2 nem existe: não há documento para converter.
    const documentos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_quotes WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(documentos.n).toBe(0);
  });

  it('a PRÉ-VENDA é recusada pela mesma conta, e não chega a reservar nada', async () => {
    const { token } = await operador();

    const doc = await abrirOrcamento(token, {
      kind: 'pre_venda',
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
    });

    expect(doc.status).toBe(403);
    expect(doc.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // A recusa vem antes da reserva: peça presa fora de qualquer documento é
    // mercadoria que some do disponível sem ninguém saber por quê.
    expect(saldo('p-moto')).toMatchObject({ quantity: 50, reserved: 0 });
  });

  it('o desconto de RODAPÉ do documento também é medido, não só o preço', async () => {
    const { token } = await operador();

    // 10 óleos = R$ 500,00. R$ 100,00 de rodapé são 20%, acima dos 10%.
    const doc = await abrirOrcamento(token, {
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 10_000,
    });

    expect(doc.status).toBe(403);
    expect(doc.body.error.details.origens).toEqual({
      cabecalho: 10_000,
      precoRebaixado: 0,
    });
    expect(doc.body.error.details.brutoCents).toBe(50_000);
  });

  it('linha ACIMA da tabela não abate a concessão de outra linha', async () => {
    /*
      Aqui, ao contrário da venda, o preço informado NÃO é limitado ao vigente:
      um documento pode ser escrito acima da tabela. Sem o piso por linha, essa
      diferença entra como concessão NEGATIVA e paga a concessão real de outro
      item — o operador escreve a moto R$ 2.000 abaixo e "compensa" com dez
      óleos inflados, e a soma fecha dentro da alçada.

      Com o piso: 16% e recusa. Sem ele: 8% e o documento nasce.
    */
    const { token } = await operador();

    const doc = await abrirOrcamento(token, {
      items: [
        { productId: 'p-moto', quantity: 1, unitPriceCents: 1_000_000 },
        { productId: 'p-oleo', quantity: 10, unitPriceCents: 15_000 },
      ],
    });

    expect(doc.status).toBe(403);
    expect(doc.body.error.details.origens.precoRebaixado).toBe(200_000);
    expect(doc.body.error.details.brutoCents).toBe(1_250_000);
    expect(doc.body.error.details.percentual).toBe(16);
  });

  it('preço unitário que não é número é recusado antes de virar documento', async () => {
    // NaN atravessa toda trava sem acionar nenhuma: NaN <= 0 e NaN > limite são
    // ambos false. Um documento com total NaN seria também uma alçada que
    // aprova qualquer coisa.
    const { token } = await operador();

    const doc = await abrirOrcamento(token, {
      items: [{ productId: 'p-oleo', quantity: 10, unitPriceCents: 'de graça' }],
    });

    expect(doc.status).toBe(400);
    expect(doc.body.error.code).toBe('CORE_INVALID_LINE_VALUE');
  });

  it('dentro do limite o documento nasce normalmente, com a concessão gravada', async () => {
    const { token } = await operador();

    // 5% — cabe na alçada do balcão e não pede nada a ninguém.
    const doc = await abrirOrcamento(token, {
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 2_500,
    });

    expect(doc.status).toBe(201);
    const gravado = getConnection()
      .prepare('SELECT concession_cents, concession_gross_cents FROM core_quotes WHERE id = ?')
      .get(doc.body.id) as { concession_cents: number; concession_gross_cents: number };

    // A concessão fica no documento MESMO tendo cabido no limite: é ela que a
    // conversão compara depois.
    expect(gravado).toEqual({ concession_cents: 2_500, concession_gross_cents: 50_000 });
  });

  it('COM liberação de gestor o documento passa, e a conversão não pede nada de novo', async () => {
    const { token, userId } = await operador();

    const doc = await abrirOrcamento(token, {
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
      authorizationId: liberacao({ para: userId }),
    });
    expect(doc.status).toBe(201);

    /*
      A outra metade da decisão, e ela importa tanto quanto a recusa: barrar na
      criação só é honesto se a conversão ficar leve. Se esta conversão pedisse
      gestor de novo, a rodada teria trocado um contorno por um balcão parado.
    */
    const venda = await request(app)
      .post(`/api/v1/core/quotes/${doc.body.id}/convert`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ payments: [{ method: 'dinheiro', amountCents: 100 }] });

    expect(venda.status).toBe(201);
    expect(saldo('p-moto').quantity).toBe(49);
  });
});

describe('na conversão, o preço que mudou não vira pedido de gestor', () => {
  function orcamentoDaMoto(precoDigitado: number) {
    return createQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      kind: 'orcamento',
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: precoDigitado }],
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

  it('preço INALTERADO: a concessão é a mesma, e nada é registrado como aumento', () => {
    // R$ 1.100.000 sobre R$ 1.200.000 = 8,33%, dentro dos 10%.
    const doc = orcamentoDaMoto(1_100_000);
    const r = converter(doc.id, 1_100_000);

    expect(r.concessaoAutorizadaCents).toBe(100_000);
    expect(r.concessaoNaVendaCents).toBe(100_000);
    expect(r.diferencaCents).toBe(0);
    expect(auditoria('quote.convert.concessao_aumentou')).toHaveLength(0);
  });

  it('preço que CAIU: a loja abriu mão de MENOS, e também não se pede nada', () => {
    const doc = orcamentoDaMoto(1_100_000);
    // A tabela desceu até o valor do documento: não há mais concessão nenhuma.
    precoDe('p-moto', 1_100_000);

    const r = converter(doc.id, 1_100_000);
    expect(r.concessaoNaVendaCents).toBe(0);
    expect(r.diferencaCents).toBe(0);
    expect(auditoria('quote.convert.concessao_aumentou')).toHaveLength(0);
  });

  it('preço que SUBIU: a venda FECHA, e a diferença vira linha de auditoria', () => {
    /*
      A decisão da rodada, escrita como teste. O produto encareceu entre a
      aprovação e o pagamento: a concessão medida hoje é maior sem que ninguém
      tenha concedido nada. Barrar aqui pararia o balcão com o cliente na
      frente por causa de um reajuste — e ensinaria o operador a cancelar o
      documento e digitar a venda na mão, que é como um fato econômico some.
    */
    const doc = orcamentoDaMoto(1_100_000);
    precoDe('p-moto', 1_400_000);

    const r = converter(doc.id, 1_100_000);

    expect(r.concessaoAutorizadaCents).toBe(100_000);
    expect(r.concessaoNaVendaCents).toBe(300_000);
    expect(r.diferencaCents).toBe(200_000);

    const linhas = auditoria('quote.convert.concessao_aumentou');
    expect(linhas).toHaveLength(1);
    const detalhe = JSON.parse(linhas[0].detail) as Record<string, number>;
    expect(detalhe.concessaoAutorizadaCents).toBe(100_000);
    expect(detalhe.concessaoNaVendaCents).toBe(300_000);
    expect(detalhe.diferencaCents).toBe(200_000);
  });

  it('documento anterior a esta rodada é convertido e marcado como NÃO CONFERIDO', () => {
    const doc = orcamentoDaMoto(1_100_000);
    // Simula o orçamento que já estava no banco antes de a coluna existir.
    getConnection()
      .prepare('UPDATE core_quotes SET concession_cents = NULL, concession_gross_cents = NULL WHERE id = ?')
      .run(doc.id);

    const r = converter(doc.id, 1_100_000);

    expect(r.concessaoAutorizadaCents).toBeNull();
    // Zero seria mentira: ninguém mediu aquele documento. A auditoria diz isso
    // com todas as letras em vez de inventar um aumento.
    expect(r.diferencaCents).toBe(0);
    expect(auditoria('quote.convert.concessao_nao_conferida')).toHaveLength(1);
  });
});

/* ========================================================================== */
/* BLOQUEIO 2 — ACRÉSCIMO NEGATIVO É DESCONTO                                 */
/* ========================================================================== */

describe('acréscimo negativo é desconto, e desconto se lança como desconto', () => {
  it('a moto de R$ 12.000 por R$ 1,00 via acréscimo de -R$ 11.999 é RECUSADA', () => {
    /*
      O quarto caminho da concessão, e o único que a alçada nem tentava olhar:
      o acréscimo está declaradamente FORA do bruto (e com razão — ele é juros
      de cartão e frete), e ao mesmo tempo era capaz de derrubar o total a
      qualquer valor. Concessão invisível, sem gestor e sem rastro.
    */
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1 }],
        surchargeCents: -(MOTO - 100),
        payments: [{ method: 'dinheiro', amountCents: 100 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_SURCHARGE');
    // A mensagem manda a pessoa usar o campo certo — e é justamente ali que o
    // valor passa a ser medido pela alçada.
    expect(erro.message).toContain('DESCONTO');
    // E a moto continua na prateleira.
    expect(saldo('p-moto').quantity).toBe(50);
  });

  it('lançado como DESCONTO, o mesmo valor passa a pedir gestor — que é o ponto', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1 }],
        discountCents: MOTO - 100,
        payments: [{ method: 'dinheiro', amountCents: 100 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.origens.cabecalho).toBe(MOTO - 100);
  });

  it('acréscimo POSITIVO continua funcionando: juros de cartão e frete são legítimos', () => {
    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      surchargeCents: 500,
      payments: [{ method: 'dinheiro', amountCents: OLEO + 500 }],
      alcada: CAIXA,
    });
    expect(sale.total_cents).toBe(OLEO + 500);
  });
});

/* ========================================================================== */
/* BLOQUEIO 3 — A LIBERAÇÃO É UM BILHETE DE UMA VIAGEM SÓ                     */
/* ========================================================================== */

describe('a liberação do gestor é gasta na venda que a usou', () => {
  function vendaComLiberacao(id: string) {
    return venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 25_000, // 50%, muito acima dos 10%
      payments: [{ method: 'dinheiro', amountCents: 25_000 }],
      alcada: { ...CAIXA, authorizationId: id },
    });
  }

  it('a PRIMEIRA venda fecha e carimba a liberação com o id dela', () => {
    const id = liberacao();
    const { sale } = vendaComLiberacao(id);

    const marca = linhaDaLiberacao(id);
    expect(marca.consumed_ref_type).toBe('sale');
    expect(marca.consumed_ref_id).toBe(sale.id);
    expect(marca.consumed_at).toBeTruthy();
  });

  it('A SEGUNDA VENDA COM A MESMA LIBERAÇÃO É RECUSADA — era o contorno', () => {
    /*
      O PDV guarda `authorizationId` no estado da tela. Sem o consumo, uma
      senha de gerente digitada uma vez virava desconto ilimitado até a aba ser
      fechada: outra venda, outro cliente, outro dia, mesmo id.
    */
    const id = liberacao();
    vendaComLiberacao(id);

    const erro = erroDe(() => vendaComLiberacao(id));
    expect(erro.code).toBe('CORE_AUTHORIZATION_ALREADY_USED');
    expect(erro.details.authorizationId).toBe(id);

    // E só existe UMA venda: a segunda não fechou pela metade.
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(vendas.n).toBe(1);
  });

  it('liberar R$ 1.800 e vender concedendo R$ 25.000 NÃO passa', () => {
    // O "sim" tem valor. Sem ele, liberar 15% autorizava 60% — bastava o
    // operador aumentar o desconto depois que o gerente saiu de perto.
    const erro = erroDe(() => vendaComLiberacao(liberacao({ ateCents: 1_800 })));

    expect(erro.code).toBe('CORE_AUTHORIZATION_BELOW_CONCESSION');
    expect(erro.details.autorizadoCents).toBe(1_800);
    expect(erro.details.concedidoCents).toBe(25_000);
    // Os dois números na frase: "precisa de gestor" sem número manda a pessoa
    // adivinhar quanto reduzir.
    expect(erro.message).toContain('R$ 18,00');
    expect(erro.message).toContain('R$ 250,00');
  });

  it('liberação COM teto suficiente passa, e o teto não vira uma segunda trava', () => {
    const { sale } = vendaComLiberacao(liberacao({ ateCents: 25_000 }));
    expect(sale.total_cents).toBe(25_000);
  });

  it('a liberação de OUTRO operador não serve', () => {
    const erro = erroDe(() => vendaComLiberacao(liberacao({ para: 'u-outro-caixa' })));
    expect(erro.code).toBe('CORE_AUTHORIZATION_NOT_YOURS');
  });

  it('venda que falha DEPOIS do consumo devolve a liberação intacta', () => {
    /*
      O consumo mora na transação da venda de propósito. Se o pagamento não
      fechar — ou faltar saldo, ou o caixa estiver fechado —, o rollback tem de
      devolver o bilhete: fazer o operador chamar o gerente de novo por causa
      de um erro que não foi dele é como uma trava correta vira uma trava que
      todo mundo aprende a contornar.
    */
    const id = liberacao();
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10 }],
        discountCents: 25_000,
        payments: [{ method: 'dinheiro', amountCents: 1_000 }], // falta dinheiro
        alcada: { ...CAIXA, authorizationId: id },
      }),
    );
    expect(erro.code).toBe('CORE_PAYMENT_MISMATCH');
    expect(linhaDaLiberacao(id).consumed_ref_id).toBeNull();

    // E ela continua servindo para a venda seguinte, que é o desfecho certo.
    const { sale } = vendaComLiberacao(id);
    expect(sale.total_cents).toBe(25_000);
  });

  it('o DOCUMENTO também gasta a liberação, e o mesmo bilhete não vale para dois', () => {
    const id = liberacao();
    const doc = createQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      kind: 'orcamento',
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
      alcada: { ...CAIXA, authorizationId: id },
    });

    const marca = linhaDaLiberacao(id);
    expect(marca.consumed_ref_type).toBe('quote');
    expect(marca.consumed_ref_id).toBe(doc.id);

    const erro = erroDe(() =>
      createQuote({
        companyId: LOJA,
        userId: 'u-caixa',
        kind: 'orcamento',
        items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
        alcada: { ...CAIXA, authorizationId: id },
      }),
    );
    expect(erro.code).toBe('CORE_AUTHORIZATION_ALREADY_USED');
  });

  it('id inventado continua caindo na mensagem completa da alçada', () => {
    // Não é "liberação inválida": quem está no balcão precisa saber QUANTO
    // está concedendo e DE ONDE vem, e essa mensagem é a da trava.
    const erro = erroDe(() => vendaComLiberacao(randomUUID()));
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
  });
});
