/**
 * A POLÍTICA DO BALCÃO — o que o operador pode fazer sem chamar o dono.
 *
 * ## Os três buracos da alçada, que este arquivo existe para manter fechados
 *
 * A trava de desconto existia e era contornável por três caminhos. Os três
 * estavam no código ao mesmo tempo, e nenhum deles dava erro:
 *
 *   1. O DENOMINADOR VINHA DO CLIENTE. A rota media o desconto contra
 *      req.body.estimatedTotalCents — o total que o próprio PDV informava.
 *      Total inflado passava qualquer desconto sem gestor.
 *   2. DESCONTO DE LINHA NÃO PASSAVA POR NADA. Bastava digitar o desconto no
 *      item em vez do rodapé.
 *   3. PREÇO UNITÁRIO REBAIXADO NÃO PASSAVA POR NADA. Havia teto e não havia
 *      piso: uma moto de R$ 12.000 saía por R$ 1,00, o estoque baixava e a
 *      comissão era calculada sobre R$ 1,00.
 *
 * ## O que estes testes provam, e como eles falham
 *
 * Cada caso abaixo QUEBRA se o guarda for removido — é esse o critério deste
 * projeto para um teste de guarda valer alguma coisa. Verificado tirando cada
 * pedaço:
 *
 *   - somando só o desconto de rodapé na concessão, os casos de linha e de
 *     preço rebaixado passam a fechar a venda e falham aqui;
 *   - devolvendo o teto Math.min para produto de preço aberto, a mão de obra
 *     volta a ser vendida por R$ 0,00 e o caso de preço aberto falha;
 *   - deixando o vencimento do fiado como now.slice(0,10), o caso de prazo
 *     falha com a data de hoje.
 *
 * Nenhum deles procura texto de código: todos executam a venda de verdade e
 * conferem o que ficou no banco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createSale } from '../src/services/core/SalesService.js';
import {
  PADRAO_LIMITE_DESCONTO_PERCENT,
  PADRAO_PRAZO_FIADO_DIAS,
  PADRAO_VALIDADE_RESERVA_DIAS,
  politicaDaEmpresa,
  salvarPolitica,
  validadeDaReserva,
} from '../src/services/core/SalePolicyService.js';
import { diaDaLoja, hojeNaLoja, horaDaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';

const MOTO = 1_200_000;
const OLEO = 5_000;

let empresa: string;

/** Perfil de quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = { profileCodes: ['operador_caixa_loja'] };

function produto(
  id: string,
  nome: string,
  precoCents: number,
  extras: { openPrice?: boolean; companyId?: string } = {},
): void {
  const agora = new Date().toISOString();
  // `companyId` é opcional e cai na empresa do cenário. Ele existe para os
  // casos que precisam de DUAS operações vivas ao mesmo tempo: política é por
  // empresa, e uma leitura que ignorasse company_id só aparece quando há uma
  // segunda empresa com número diferente na mesma execução.
  const dona = extras.companyId ?? empresa;
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 'Geral', ?, 1, ?, ?)`,
    )
    .run(id, dona, id, nome, precoCents, extras.openPrice ? 1 : 0, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(dona, id, agora);
}

/** Saldo da moto na prateleira — venda recusada não pode ter baixado nada. */
function saldoDaMoto(): number {
  return (
    getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(empresa, 'p-moto') as { quantity: number }
  ).quantity;
}

function cliente(): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
       VALUES ('c-1', ?, 'Dona Marta', 1, ?, ?)`,
    )
    .run(empresa, agora, agora);
  return 'c-1';
}

/**
 * Liberação de gestor já registrada.
 *
 * Gravada direto porque o que está sob teste aqui é a VENDA reconhecer a
 * liberação; quem prova que a credencial do gestor é conferida de verdade é o
 * teste de authorizeAction, em pdv-finalizacao.
 */
function liberacaoDeGestor(): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by, created_at)
       VALUES (?, ?, 'desconto_acima_limite', 'u-caixa', 'u-gerente', ?)`,
    )
    .run(id, empresa, new Date().toISOString());
  return id;
}

/*
  A PILHA INTEIRA, para os casos que só existem acima do serviço.

  Dois defeitos desta rodada moram na rota e não no serviço: o denominador que
  vinha do corpo da requisição, e quem pode mexer na política. Nenhum dos dois
  aparece chamando createSale ou salvarPolitica direto — a chamada direta já
  passou pelo portão. Por isso estes cenários sobem por HTTP, com token de
  verdade e perfil de verdade.
*/
const app = createApp();
const LOJA = 'loja-alpha';

/** Token de quem NÃO tem alçada — é dele o corpo que tenta enganar a trava. */
async function tokenDoCaixa(): Promise<string> {
  const res = await loginForTest(app, {
    userId: 'caixa',
    companyId: LOJA,
    profileCodes: ['operador_caixa_loja'],
  });
  expect(res.status).toBe(200);
  produto('p-oleo-http', 'Óleo 1L', OLEO, { companyId: LOJA });
  return res.body.accessToken as string;
}

/** Token de quem responde pela margem, e portanto decide a política. */
async function tokenDoGerente(): Promise<string> {
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function venda(extra: Record<string, unknown>) {
  return createSale({
    companyId: empresa,
    userId: 'u-caixa',
    idempotencyKey: randomUUID(),
    items: [],
    payments: [],
    ...extra,
  } as Parameters<typeof createSale>[0]);
}

/** O detalhe da recusa, nos campos que estes casos leem. */
interface DetalheDaRecusa {
  brutoCents?: number;
  percentual?: number;
  limite?: number;
  openPrice?: boolean;
  origens: { cabecalho: number; itens: number; precoRebaixado: number };
}

/** Erro capturado com código e detalhe, que é o que o balcão vê. */
function erroDe(fn: () => unknown): { code: string; message: string; details: DetalheDaRecusa } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string; details?: unknown };
    return { code: e.code, message: e.message, details: e.details as DetalheDaRecusa };
  }
  throw new Error('esperava um erro, e a venda passou');
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = await upsertCompany({
    slug: 'pj-motors',
    tradeName: 'PJ Motors',
    legalName: 'PJ Motors Ltda',
  });
  produto('p-moto', 'Moto Elétrica', MOTO);
  produto('p-oleo', 'Óleo 1L', OLEO);
  produto('p-mao-obra', 'Mão de obra', 0, { openPrice: true });
  produto('p-sem-preco', 'Peça da nota sem preço', 0);
});

describe('o bruto é do servidor, e não do corpo da requisição', () => {
  it('mede a concessão contra o preço vigente, não contra o total informado', () => {
    // 10 óleos = R$ 500,00 de bruto. R$ 100,00 de desconto são 20%.
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10 }],
        discountCents: 10_000,
        payments: [{ method: 'dinheiro', amountCents: 40_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // O bruto é preço vigente x quantidade, somado no servidor. Nada que o PDV
    // mande participa deste número.
    expect(erro.details.brutoCents).toBe(50_000);
    expect(erro.details.percentual).toBe(20);
    expect(erro.details.limite).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
  });

  it('dentro do limite a venda fecha, e a concessão volta medida', () => {
    const { concessao } = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 2_500, // 5%
      payments: [{ method: 'dinheiro', amountCents: 47_500 }],
      alcada: CAIXA,
    });

    expect(concessao).toEqual({
      brutoCents: 50_000,
      concedidoCents: 2_500,
      percentual: 5,
      origens: { cabecalho: 2_500, itens: 0, precoRebaixado: 0 },
    });
  });
});

describe('os três caminhos da concessão chegam no mesmo lugar', () => {
  it('DESCONTO DE LINHA passa pela alçada (antes não passava por nada)', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10, discountCents: 10_000 }],
        payments: [{ method: 'dinheiro', amountCents: 40_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.origens).toEqual({
      cabecalho: 0,
      itens: 10_000,
      precoRebaixado: 0,
    });
  });

  it('PREÇO REBAIXADO passa pela alçada — a moto de R$ 12.000 por R$ 1,00', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
        payments: [{ method: 'dinheiro', amountCents: 100 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.origens.precoRebaixado).toBe(MOTO - 100);
    expect(erro.details.percentual).toBeGreaterThan(99);
    // E a moto continua na prateleira: a venda inteira foi recusada.
    expect(saldoDaMoto()).toBe(50);
  });

  it('a MESMA moto por R$ 1,00 passa COM liberação de gestor, e aí sim o estoque baixa', () => {
    /*
      O outro lado do caso, e ele importa tanto quanto a recusa: a trava não
      pode ser um "não" absoluto. Vender abaixo do preço acontece — moto de
      mostruário, peça avariada, acerto de negociação —, e o que a rodada
      mudou não foi PROIBIR: foi exigir que alguém com alçada assine.

      Sem este teste, a suíte aceitaria como correta uma implementação que
      simplesmente barra tudo, e o balcão descobriria isso no primeiro dia com
      um cliente na frente.
    */
    const { sale, concessao } = venda({
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
      payments: [{ method: 'dinheiro', amountCents: 100 }],
      alcada: { ...CAIXA, authorizationId: liberacaoDeGestor() },
    });

    expect(sale.total_cents).toBe(100);
    expect(saldoDaMoto()).toBe(49);
    // A concessão continua MEDIDA depois de liberada: é ela que a rota grava
    // na auditoria, e é por ela que o dono descobre depois quem assinou o quê.
    expect(concessao!.concedidoCents).toBe(MOTO - 100);
    expect(concessao!.origens.precoRebaixado).toBe(MOTO - 100);
  });

  it('os três somam juntos: nenhum deles sozinho estoura, o conjunto estoura', () => {
    // 4% de rodapé + 4% de linha + 4% de preço rebaixado = 12%, acima de 10.
    const erro = erroDe(() =>
      venda({
        items: [
          { productId: 'p-oleo', quantity: 10, unitPriceCents: 4_800, discountCents: 2_000 },
        ],
        discountCents: 2_000,
        payments: [{ method: 'dinheiro', amountCents: 44_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.origens).toEqual({
      cabecalho: 2_000,
      itens: 2_000,
      precoRebaixado: 2_000,
    });
    expect(erro.details.percentual).toBe(12);
  });
});

describe('a mensagem diz QUANTO e DE ONDE', () => {
  it('traz o valor, o percentual, o limite e a origem de cada parcela', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10, discountCents: 5_000 }],
        discountCents: 5_000,
        payments: [{ method: 'dinheiro', amountCents: 40_000 }],
        alcada: CAIXA,
      }),
    );

    // "Precisa de gestor" sem número manda a pessoa adivinhar o que reduzir.
    expect(erro.message).toContain('R$ 100,00');
    expect(erro.message).toContain('20%');
    expect(erro.message).toContain('10%');
    expect(erro.message).toContain('rodapé');
    expect(erro.message).toContain('itens');
  });

  it('o preço rebaixado é NOMEADO — quem carregou um orçamento não digitou desconto', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 900_000 }],
        payments: [{ method: 'dinheiro', amountCents: 900_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.message).toContain('abaixo do vigente');
  });
});

describe('quem pode liberar, libera', () => {
  it('gerente não pede autorização a si mesmo', () => {
    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 25_000,
      payments: [{ method: 'dinheiro', amountCents: 25_000 }],
      alcada: { profileCodes: ['gerente_loja'] },
    });
    expect(sale.total_cents).toBe(25_000);
  });

  it('com liberação de gestor registrada, a venda fecha', () => {
    const { sale, concessao } = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 25_000,
      payments: [{ method: 'dinheiro', amountCents: 25_000 }],
      alcada: { ...CAIXA, authorizationId: liberacaoDeGestor() },
    });
    expect(sale.total_cents).toBe(25_000);
    // Mesmo liberada, a concessão continua medida: é ela que a rota audita.
    expect(concessao!.percentual).toBe(50);
  });

  it('id de autorização inventado NÃO libera', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10 }],
        discountCents: 25_000,
        payments: [{ method: 'dinheiro', amountCents: 25_000 }],
        alcada: { ...CAIXA, authorizationId: randomUUID() },
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
  });
});

describe('preço aberto: o cadastro sugere, o balcão decide', () => {
  it('mão de obra sai pelo valor digitado, e não pelo zero do cadastro', () => {
    // ANTES: o teto era o preço do cadastro (zero), e Math.min jogava fora o
    // valor digitado — toda mão de obra era vendida por R$ 0,00.
    const { sale, concessao } = venda({
      items: [{ productId: 'p-mao-obra', quantity: 1, unitPriceCents: 30_000 }],
      payments: [{ method: 'dinheiro', amountCents: 30_000 }],
      alcada: CAIXA,
    });

    expect(sale.total_cents).toBe(30_000);
    // E não vira concessão: preço aberto não tem "vigente" de onde descer.
    expect(concessao).toEqual({
      brutoCents: 30_000,
      concedidoCents: 0,
      percentual: 0,
      origens: { cabecalho: 0, itens: 0, precoRebaixado: 0 },
    });
  });

  it('serviço abaixo da sugestão não pede gestor', () => {
    produto('p-revisao', 'Revisão completa', 40_000, { openPrice: true });
    const { concessao } = venda({
      items: [{ productId: 'p-revisao', quantity: 1, unitPriceCents: 20_000 }],
      payments: [{ method: 'dinheiro', amountCents: 20_000 }],
      alcada: CAIXA,
    });
    // Metade da sugestão, e nenhuma concessão: fosse contado, a oficina
    // chamaria o gestor em toda OS.
    expect(concessao!.concedidoCents).toBe(0);
    expect(concessao!.brutoCents).toBe(20_000);
  });

  it('desconto EXPLÍCITO na linha continua contando, mesmo em preço aberto', () => {
    // Aqui alguém digitou "abro mão de tanto". Isso é concessão em qualquer
    // preço, e o teste existe para o tratamento de preço aberto não virar uma
    // porta por onde o desconto passa.
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-mao-obra', quantity: 1, unitPriceCents: 30_000, discountCents: 9_000 }],
        payments: [{ method: 'dinheiro', amountCents: 21_000 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.origens.itens).toBe(9_000);
  });
});

describe('produto sem preço não é vendido por engano', () => {
  it('preço vigente zero é recusado, e a mensagem diz o que fazer', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-sem-preco', quantity: 1 }],
        payments: [],
        customerId: cliente(),
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_PRODUCT_WITHOUT_PRICE');
    expect(erro.details.openPrice).toBe(false);
    // Quem está no balcão precisa saber ONDE resolver — a nota de entrada cria
    // dezenas de produtos assim.
    expect(erro.message).toContain('Alteração rápida');
    expect(erro.message).toContain('entrada de nota');
  });

  it('preço aberto sem valor digitado também é recusado, com outra instrução', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-mao-obra', quantity: 1 }],
        payments: [],
        customerId: cliente(),
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_PRODUCT_WITHOUT_PRICE');
    expect(erro.details.openPrice).toBe(true);
    expect(erro.message).toContain('digite o valor na linha');
  });

  it('o BRINDE continua possível: concessão total, com gestor', () => {
    // Dar de graça é decisão de alguém e fica registrada. O que foi barrado
    // acima é o preço zero por descuido, que não deixa rastro nenhum.
    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      discountCents: OLEO,
      payments: [{ method: 'dinheiro', amountCents: 1 }],
      alcada: { ...CAIXA, authorizationId: liberacaoDeGestor() },
    });
    expect(sale.total_cents).toBe(0);
  });
});

describe('a venda fiada ganha prazo', () => {
  function vencimentoDaVenda(saleId: string): string {
    return (
      getConnection()
        .prepare("SELECT due_date FROM core_finance_entries WHERE origin_id = ? AND direction = 'in'")
        .get(saleId) as { due_date: string }
    ).due_date;
  }

  it('sem política, vence hoje — exatamente como antes', () => {
    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [],
      customerId: cliente(),
      alcada: CAIXA,
    });
    /*
      "HOJE" É O DIA DA LOJA — a mesma correção que o caso do PIX pendente
      já carregava logo abaixo. `new Date().toISOString()` responde o dia de
      GREENWICH: das 21h à meia-noite em Pelotas os dois divergem, e este caso
      ficava vermelho toda noite sem nada no produto ter mudado.
    */
    expect(vencimentoDaVenda(sale.id)).toBe(hojeNaLoja());
  });

  it('com 30 dias na política, a dívida nasce vencendo em 30 dias', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', creditSaleDueDays: 30 });

    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [],
      customerId: cliente(),
      alcada: CAIXA,
    });

    /*
      O PRAZO CONTA A PARTIR DO DIA DA LOJA, e não do de Greenwich.

      Somar 30 dias em milissegundos sobre `Date.now()` e recortar o ISO é
      pedir o dia de Greenwich duas vezes: entre 21h e a meia-noite, ele já
      virou. Era assim que o defeito dos DOIS RELÓGIOS passava despercebido —
      o teste errava junto com o código. Quem prova o caso da virada, com
      relógio encenado, é `venda-noturna-tem-um-relogio-so`.
    */
    expect(vencimentoDaVenda(sale.id)).toBe(somarDias(hojeNaLoja(), 30));
  });

  it('PIX pendente NÃO ganha o prazo do fiado: espera-se que caia hoje', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', creditSaleDueDays: 30 });

    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [{ method: 'pix', amountCents: OLEO, status: 'pending' }],
      customerId: cliente(),
      alcada: CAIXA,
    });

    /*
      "HOJE" É O DIA DA LOJA, e não o de Greenwich — e este caso só passava por
      sorte de horário.

      A venda com PIX pendente não é fiada: o vencimento dela é a COMPETÊNCIA,
      que `createSale` calcula com `diaDaLoja(now)`. A asserção comparava com
      `new Date().toISOString()`, que é o dia UTC: das 21h à meia-noite em
      Pelotas os dois divergem, e o caso ficava vermelho toda noite sem que nada
      no produto tivesse mudado. É a mesma mordida de "data de calendário versus
      instante" que já custou duas rodadas aqui.
    */
    expect(vencimentoDaVenda(sale.id)).toBe(hojeNaLoja());
  });
});

describe('a política em si', () => {
  it('empresa sem linha se comporta como o sistema de ontem', () => {
    const p = politicaDaEmpresa(empresa);
    expect(p.discountLimitPercent).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
    expect(p.creditSaleDueDays).toBe(PADRAO_PRAZO_FIADO_DIAS);
    expect(p.reservationValidDays).toBe(PADRAO_VALIDADE_RESERVA_DIAS);
    /*
      O teto da sangria não tem padrão de sistema, e é a única exceção da
      política: aqui a ausência NÃO é um número, é a ausência de trava. Nulo
      significa "o caixa tira o que quiser", que é o comportamento de sempre —
      inventar um teto padrão ligaria a exigência de gestor nas seis operações
      num deploy que ninguém pediu.
    */
    expect(p.cashWithdrawalLimitCents).toBeNull();
    // E a tela consegue dizer que ninguém configurou nada. A comparação é do
    // objeto INTEIRO de propósito: campo novo que a tela não souber mostrar
    // derruba este caso em vez de passar em silêncio.
    expect(p.definidos).toEqual({
      discountLimitPercent: false,
      creditSaleDueDays: false,
      reservationValidDays: false,
      cashWithdrawalLimitCents: false,
      // Faturar OS a prazo (GAP-PRD-104): a tela de Política de venda mostra.
      workshopCreditEnabled: false,
    });
    // E o padrão do fiado da OS é o seguro: desligado.
    expect(p.workshopCreditEnabled).toBe(false);
  });

  it('o que o dono definiu aparece como definido; o resto segue padrão', () => {
    const p = salvarPolitica({
      companyId: empresa,
      userId: 'u-dono',
      discountLimitPercent: 2.5,
    });
    expect(p.discountLimitPercent).toBe(2.5);
    expect(p.definidos.discountLimitPercent).toBe(true);
    expect(p.creditSaleDueDays).toBe(PADRAO_PRAZO_FIADO_DIAS);
    expect(p.definidos.creditSaleDueDays).toBe(false);
  });

  it('apagar o campo volta ao padrão, e não grava vazio', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: 2.5 });
    const p = salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: '' });
    expect(p.discountLimitPercent).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
    expect(p.definidos.discountLimitPercent).toBe(false);
  });

  it('TEXTO QUE NÃO É NÚMERO É RECUSADO — é o caso que liberaria tudo', () => {
    // Num par chave/valor, "dez" viraria NaN, e NaN > limite é FALSE: a trava
    // falharia ABERTA. Aqui o erro aparece na cara de quem digitou.
    const erro = erroDe(() =>
      salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: 'dez' }),
    );
    expect(erro.code).toBe('CORE_SALE_POLICY_INVALID');
    expect(politicaDaEmpresa(empresa).discountLimitPercent).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
  });

  it('percentual fora de 0 a 100 é recusado', () => {
    expect(
      erroDe(() =>
        salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: 150 }),
      ).code,
    ).toBe('CORE_SALE_POLICY_INVALID');
  });

  it('o limite salvo é o que a venda aplica', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: 30 });
    // 20% passaria a caber onde antes não cabia.
    const { concessao } = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 10_000,
      payments: [{ method: 'dinheiro', amountCents: 40_000 }],
      alcada: CAIXA,
    });
    expect(concessao!.percentual).toBe(20);
  });

  it('a validade da reserva sai da política, e vale até o FIM do dia', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', reservationValidDays: 3 });
    /*
      O DIA E A HORA NO RELÓGIO DA LOJA, e não no da máquina que roda o teste.
      `getDate()`/`getHours()` leem o fuso do processo: num CI ou contêiner em
      UTC a validade certa (23:59 em Pelotas = 02:59Z do dia seguinte) lia dia
      21 às 2h, e o caso acusava o produto do defeito que ele não tem.
    */
    const validade = validadeDaReserva(empresa, new Date('2026-08-17T10:00:00-03:00'));
    expect(diaDaLoja(validade)).toBe('2026-08-20');
    // Fim do dia: uma reserva que morre às 10h da manhã perde o cliente que
    // volta à tarde com o dinheiro.
    expect(horaDaLoja(validade).slice(0, 2)).toBe('23');
  });
});

describe('o que não é número não entra na conta', () => {
  // NaN atravessa TODAS as travas deste arquivo sem acionar uma só: NaN <= 0,
  // NaN < 0 e NaN > limite são todos false. Sem estes casos, um valor de tela
  // corrompido gravaria uma venda com total NaN e liberaria qualquer alçada.
  it('preço unitário que não é número é recusado', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 1, unitPriceCents: 'muito' }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_INVALID_LINE_VALUE');
  });

  it('desconto de rodapé que não é número é recusado', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 1 }],
        discountCents: 'metade',
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_INVALID_LINE_VALUE');
    // E nada foi gravado: a venda não existe pela metade.
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales').get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('o que esta rodada deliberadamente NÃO fechou', () => {
  it('chamador sem alçada informada tem a concessão MEDIDA, mas não barrada', () => {
    // É o caso da conversão de orçamento (QuoteService), fora do alcance desta
    // rodada. Este teste existe para a lacuna ser visível e intencional: no dia
    // em que a conversão passar a informar quem está no balcão, ele muda junto.
    const { sale, concessao } = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 25_000,
      payments: [{ method: 'dinheiro', amountCents: 25_000 }],
    });
    expect(sale.total_cents).toBe(25_000);
    expect(concessao!.percentual).toBe(50);
  });

  it('reenvio da mesma venda não é reprecificado', () => {
    const chave = randomUUID();
    const args = {
      companyId: empresa,
      userId: 'u-caixa',
      idempotencyKey: chave,
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: OLEO }],
      alcada: CAIXA,
    };
    createSale(args);
    const segunda = createSale(args);

    expect(segunda.duplicated).toBe(true);
    // Nulo, e não zero: recalcular a concessão sobre os preços de hoje poderia
    // recusar uma venda que já aconteceu.
    expect(segunda.concessao).toBeNull();
  });
});

/**
 * O BURACO DO DENOMINADOR, PELA PORTA ONDE ELE ESTAVA.
 *
 * Os casos acima chamam createSale direto e provam que o bruto é somado no
 * servidor. Provam metade: o defeito não morava no serviço, morava na ROTA —
 * era ela que lia `req.body.estimatedTotalCents` e media o desconto contra o
 * total que o próprio PDV informava.
 *
 * Por isso estes casos sobem a pilha inteira, com token de operador de caixa e
 * o campo VENENOSO no corpo. Uma implementação que tirasse a conta da rota mas
 * deixasse o campo chegar em createSale como "dica" passaria em todos os
 * testes de serviço e continuaria com a porta aberta. Aqui não passa.
 */
describe('pela rota do PDV: o total que o cliente informa não decide nada', () => {
  /** Dez óleos: R$ 500,00 de bruto, conferíveis no cadastro da loja. */
  function corpo(extra: Record<string, unknown>) {
    return {
      items: [{ productId: 'p-oleo-http', quantity: 10 }],
      payments: [{ method: 'dinheiro', amountCents: 40_000 }],
      ...extra,
    };
  }

  async function vender(token: string, body: Record<string, unknown>) {
    return request(app)
      .post('/api/v1/core/sales')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  it('TOTAL INFLADO NÃO PASSA MAIS DESCONTO SEM GESTOR — é o caso que prova a rodada', async () => {
    const token = await tokenDoCaixa();

    // R$ 100,00 sobre R$ 500,00 são 20%. O corpo jura que o carrinho vale
    // R$ 1.000.000,00, o que faria o mesmo desconto parecer 0,01% — que é
    // exatamente como um desconto de 20% passava sem ninguém olhar.
    const res = await vender(
      token,
      corpo({ discountCents: 10_000, estimatedTotalCents: 100_000_000 }),
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // O número que a trava usou é o do CADASTRO, não o do corpo.
    expect(res.body.error.details.brutoCents).toBe(50_000);
    expect(res.body.error.details.percentual).toBe(20);
  });

  it('o mesmo corpo SEM o campo é recusado igual — o campo virou inerte', async () => {
    const token = await tokenDoCaixa();
    const res = await vender(token, corpo({ discountCents: 10_000 }));

    expect(res.status).toBe(403);
    expect(res.body.error.details.brutoCents).toBe(50_000);
    expect(res.body.error.details.percentual).toBe(20);
  });

  it('e o campo também não BARRA nada: dentro do limite, a venda fecha', async () => {
    const token = await tokenDoCaixa();

    // 5% de concessão e um estimatedTotalCents ridículo de R$ 1,00. Se alguém
    // "aproveitasse" o campo como segunda checagem, esta venda legítima seria
    // recusada e o balcão pararia por causa de um número que a tela manda por
    // hábito. Ignorar é ignorar dos dois lados.
    const res = await vender(
      token,
      corpo({
        discountCents: 2_500,
        estimatedTotalCents: 100,
        payments: [{ method: 'dinheiro', amountCents: 47_500 }],
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.total_cents).toBe(47_500);
  });

  it('o desconto de LINHA também é barrado pela rota, e não só pelo serviço', async () => {
    const token = await tokenDoCaixa();
    const res = await vender(token, {
      items: [{ productId: 'p-oleo-http', quantity: 10, discountCents: 10_000 }],
      payments: [{ method: 'dinheiro', amountCents: 40_000 }],
      estimatedTotalCents: 100_000_000,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.details.origens).toEqual({
      cabecalho: 0,
      itens: 10_000,
      precoRebaixado: 0,
    });
  });

  it('o limite anunciado ao PDV é o DESTA operação, e não os 10 do grupo', async () => {
    const token = await tokenDoCaixa();
    salvarPolitica({ companyId: LOJA, userId: 'u-dono', discountLimitPercent: 3 });

    // A tela pergunta o limite para avisar ANTES de tentar. Se ela continuasse
    // recebendo 10 enquanto o servidor aplica 3, o operador só descobriria a
    // regra ao levar o 403 com o cliente na frente.
    const res = await request(app)
      .get('/api/v1/core/sales/discount-policy')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorLimitPercent).toBe(3);
    expect(res.body.canAuthorizeSelf).toBe(false);
  });
});

/**
 * QUEM PODE MUDAR A PRÓPRIA COLEIRA.
 *
 * A tela de política mora em ROTA_GESTAO, e o ambiente "gestao" deste sistema
 * abre também para atendente e estoquista — a casca é mais larga do que a
 * decisão. Quem fecha é o servidor, e sem estes casos ninguém saberia que ele
 * fecha: as duas rotas não tinham teste nenhum.
 *
 * O operador de caixa é o caso que importa. O limite de desconto existe para
 * limitá-lo; se ele puder editá-lo, não há limite — ele abre a tela, põe 100%,
 * dá o desconto e devolve para 10, e a auditoria da venda registra uma
 * concessão perfeitamente dentro da política.
 *
 * Estes casos só existem por HTTP: chamar `salvarPolitica` direto já é estar do
 * lado de dentro do portão.
 */
describe('a política é do dono, e é o servidor que fecha a porta', () => {
  it('o operador de caixa NÃO lê nem grava a política — é o limite dele que está ali', async () => {
    const token = await tokenDoCaixa();
    const auth = { Authorization: `Bearer ${token}` };

    const leitura = await request(app).get('/api/v1/core/sale-policies').set(auth);
    expect(leitura.status).toBe(403);

    const escrita = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(auth)
      .send({ discountLimitPercent: 100 });
    expect(escrita.status).toBe(403);

    // E o limite dele continua o de sempre: a tentativa não deixou rastro.
    expect(politicaDaEmpresa(LOJA).discountLimitPercent).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
  });

  it('o gerente lê, grava, e o que ele mudou fica na AUDITORIA', async () => {
    const auth = { Authorization: `Bearer ${await tokenDoGerente()}` };

    const antes = await request(app).get('/api/v1/core/sale-policies').set(auth);
    expect(antes.status).toBe(200);
    expect(antes.body.definidos.discountLimitPercent).toBe(false);

    const gravou = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(auth)
      .send({ discountLimitPercent: 5, creditSaleDueDays: 30, reservationValidDays: '' });

    expect(gravou.status).toBe(200);
    expect(gravou.body.discountLimitPercent).toBe(5);
    expect(gravou.body.definidos.creditSaleDueDays).toBe(true);
    // Campo enviado vazio volta ao padrão, e a resposta diz isso — é o que a
    // tela usa para escrever "padrão do sistema" em vez de fingir um 7 digitado.
    expect(gravou.body.reservationValidDays).toBe(PADRAO_VALIDADE_RESERVA_DIAS);
    expect(gravou.body.definidos.reservationValidDays).toBe(false);

    /*
      Mudar o limite de desconto é mudar quanto a loja pode dar de graça sem
      ninguém ser chamado. Sem esta linha na auditoria, a pergunta "por que
      aquela venda de 40% não pediu gestor?" não tem resposta: o limite de
      ontem não existe em lugar nenhum.
    */
    const log = getConnection()
      .prepare(
        `SELECT user_id, detail FROM core_audit_log
          WHERE company_id = ? AND action = 'sale_policy.update'`,
      )
      .get(LOJA) as { user_id: string; detail: string } | undefined;

    expect(log).toBeTruthy();
    const detalhe = JSON.parse(log!.detail) as Record<string, unknown>;
    // O que FICOU VALENDO, e não o que veio no corpo: é o estado final que
    // explica uma venda depois.
    expect(detalhe.discountLimitPercent).toBe(5);
    expect(detalhe.reservationValidDays).toBe(PADRAO_VALIDADE_RESERVA_DIAS);
  });

  it('valor recusado não grava nada, e a mensagem do servidor chega à tela', async () => {
    const erro = await request(app)
      .put('/api/v1/core/sale-policies')
      .set('Authorization', `Bearer ${await tokenDoGerente()}`)
      .send({ discountLimitPercent: 'dez' });

    expect(erro.status).toBe(400);
    expect(erro.body.error.code).toBe('CORE_SALE_POLICY_INVALID');
    expect(politicaDaEmpresa(LOJA).definidos.discountLimitPercent).toBe(false);
  });
});

/**
 * A POLÍTICA É DA EMPRESA — e isto só se prova com DUAS operações vivas.
 *
 * O grupo tem lojas com margens diferentes: a que vende moto trabalha com
 * outra folga que a que vende peça. Uma leitura sem company_id — ou um cache
 * de módulo, que é o jeito mais fácil de escrever isso errado — só aparece
 * quando existe uma segunda empresa com número diferente na MESMA execução.
 * Com uma empresa só, a leitura errada passa despercebida para sempre.
 */
describe('duas operações, dois limites, ao mesmo tempo', () => {
  it('5% na primeira e o padrão de 10% na segunda, no mesmo teste', async () => {
    const outra = await upsertCompany({
      slug: 'jd-pecas',
      tradeName: 'JD Peças',
      legalName: 'JD Peças Ltda',
    });
    produto('p-oleo-jd', 'Óleo 1L', OLEO, { companyId: outra });
    salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: 5 });

    // 8% de concessão, o MESMO carrinho nas duas lojas.
    const carrinho = {
      userId: 'u-caixa',
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 4_000,
      payments: [{ method: 'dinheiro', amountCents: 46_000 }],
      alcada: CAIXA,
    };

    const barrado = erroDe(() => venda({ ...carrinho }));
    expect(barrado.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(barrado.details.percentual).toBe(8);
    expect(barrado.details.limite).toBe(5);

    const { sale, concessao } = createSale({
      ...carrinho,
      companyId: outra,
      idempotencyKey: randomUUID(),
      items: [{ productId: 'p-oleo-jd', quantity: 10 }],
    } as Parameters<typeof createSale>[0]);

    // Os mesmos 8% passam na loja que nunca configurou nada.
    expect(concessao!.percentual).toBe(8);
    expect(sale.total_cents).toBe(46_000);

    // E a segunda continua HERDANDO o padrão: o 5 da primeira não vazou para
    // cá, nem virou "definido pelo dono" numa tela que ele nunca abriu.
    const dela = politicaDaEmpresa(outra);
    expect(dela.discountLimitPercent).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
    expect(dela.definidos.discountLimitPercent).toBe(false);
    expect(politicaDaEmpresa(empresa).discountLimitPercent).toBe(5);
  });

  it('o prazo do fiado também não atravessa a parede', async () => {
    const outra = await upsertCompany({
      slug: 'jd-pecas',
      tradeName: 'JD Peças',
      legalName: 'JD Peças Ltda',
    });
    salvarPolitica({ companyId: empresa, userId: 'u-dono', creditSaleDueDays: 30 });

    expect(politicaDaEmpresa(empresa).creditSaleDueDays).toBe(30);
    expect(politicaDaEmpresa(outra).creditSaleDueDays).toBe(PADRAO_PRAZO_FIADO_DIAS);
    expect(politicaDaEmpresa(outra).reservationValidDays).toBe(PADRAO_VALIDADE_RESERVA_DIAS);
  });
});

/**
 * NULO É O COMPORTAMENTO DE HOJE — provado pelo COMPORTAMENTO, não pela leitura.
 *
 * "politicaDaEmpresa devolve 10" prova que a função tem um default. Não prova
 * que a VENDA aplica esse default, nem que a reserva o aplica, nem que o fiado
 * o aplica. É a diferença entre o padrão existir e o padrão VALER — e é
 * exatamente onde uma migração que criasse a tabela com DEFAULT 0 passaria no
 * teste de leitura e transformaria toda loja do grupo em "nenhum desconto sem
 * gestor" da noite para o dia.
 *
 * Os três campos, os três caminhos, com a tabela vazia.
 */
describe('empresa que nunca abriu a tela vende exatamente como ontem', () => {
  it('não existe linha nenhuma para esta empresa — é essa a condição do teste', () => {
    const n = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sale_policies WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(n.n).toBe(0);
  });

  it('DESCONTO: 10% exatos passam, e o centavo seguinte pede gestor', () => {
    // O limite é o de sempre, e a fronteira é onde sempre esteve: "acima de"
    // pede gestor, "igual a" não. Um teste só do lado que barra deixaria
    // passar uma implementação que barra os 10% cravados e faz o balcão
    // chamar o dono para o desconto que ele mesmo autorizou.
    const { concessao } = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 5_000,
      payments: [{ method: 'dinheiro', amountCents: 45_000 }],
      alcada: CAIXA,
    });
    expect(concessao!.percentual).toBe(10);

    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10 }],
        discountCents: 5_001,
        payments: [{ method: 'dinheiro', amountCents: 44_999 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.limite).toBe(PADRAO_LIMITE_DESCONTO_PERCENT);
  });

  it('FIADO: a dívida vence hoje, como vencia antes da tabela existir', () => {
    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [],
      customerId: cliente(),
      alcada: CAIXA,
    });
    const venc = getConnection()
      .prepare("SELECT due_date FROM core_finance_entries WHERE origin_id = ? AND direction = 'in'")
      .get(sale.id) as { due_date: string };
    /*
      "HOJE" É O DIA DA LOJA — o mesmo conserto dos casos do vencimento acima.
      `new Date().toISOString()` é o dia de Greenwich: das 21h à meia-noite em
      Pelotas ele já virou, e este caso ficava vermelho toda noite.
    */
    expect(venc.due_date).toBe(hojeNaLoja());
  });

  it('RESERVA: sete dias, a constante que morava na tela do frontend', () => {
    // O dia no calendário da loja — ver o caso da validade, acima.
    const validade = validadeDaReserva(empresa, new Date('2026-08-17T10:00:00-03:00'));
    expect(diaDaLoja(validade)).toBe('2026-08-24');
  });

  it('e o ZERO do dono é uma escolha, não a ausência dele', () => {
    // A distinção que a tabela inteira existe para carregar: campo vazio volta
    // ao padrão, campo com zero vale zero. Se os dois virassem a mesma coisa,
    // o dono não teria como dizer "nenhum desconto sem mim".
    salvarPolitica({ companyId: empresa, userId: 'u-dono', discountLimitPercent: 0 });
    const p = politicaDaEmpresa(empresa);
    expect(p.discountLimitPercent).toBe(0);
    expect(p.definidos.discountLimitPercent).toBe(true);

    // E vale de verdade: um centavo de concessão já chama o gestor.
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 10 }],
        discountCents: 1,
        payments: [{ method: 'dinheiro', amountCents: 49_999 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.limite).toBe(0);
  });
});

/*
  O TETO DA SANGRIA PELA ROTA, e não pelo serviço.

  Este bloco existe por causa de um defeito que passou por 2348 testes verdes: a
  rota `PUT /core/sale-policies` montava a chamada nomeando três campos um a um
  e simplesmente não repassava o quarto. O serviço aceitava o parâmetro, recebia
  `undefined`, e gravava a coluna como nula — o teto da gaveta era impossível de
  configurar pela única tela que o escreve, e a trava do caixa nunca disparava
  em produção.

  Nenhum teste pegou porque todos chamavam `salvarPolitica` DIRETO. A chamada
  direta pula exatamente o pedaço que estava quebrado. Testar o serviço não é
  testar a corrente; por isso estes casos sobem por HTTP.
*/
describe('o teto da sangria atravessa a rota inteira', () => {
  it('o que o gerente grava pela rota é o que a rota devolve', async () => {
    const auth = { Authorization: `Bearer ${await tokenDoGerente()}` };

    const r = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(auth)
      .send({ cashWithdrawalLimitReais: '500' });

    expect(r.status).toBe(200);
    // Reais entram, centavos saem — a unidade no nome do campo é o que impede
    // o erro de cem vezes.
    expect(r.body.cashWithdrawalLimitCents).toBe(50_000);
    expect(r.body.definidos.cashWithdrawalLimitCents).toBe(true);

    const lido = await request(app).get('/api/v1/core/sale-policies').set(auth);
    expect(lido.body.cashWithdrawalLimitCents).toBe(50_000);
  });

  /**
   * O SEGUNDO DEFEITO, e ele só aparece acima de mil.
   *
   * A tela devolve o valor formatado ao campo, e o formato daqui agrupa milhar:
   * R$ 5.000,00. O servidor fazia `replace(',', '.')` — que com uma STRING troca
   * só a PRIMEIRA ocorrência — e "5.000,00" virava "5.000.00", que é NaN. O dono
   * deixava de conseguir salvar a política INTEIRA, inclusive campos que não
   * tinham nada a ver com o teto.
   */
  it('valor com separador de milhar é aceito — é o que a tela devolve ao campo', async () => {
    const auth = { Authorization: `Bearer ${await tokenDoGerente()}` };
    const r = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(auth)
      .send({ cashWithdrawalLimitReais: '5.000,00' });

    expect(r.status).toBe(200);
    expect(r.body.cashWithdrawalLimitCents).toBe(500_000);
  });

  it('e o percentual com vírgula continua funcionando como antes', async () => {
    const auth = { Authorization: `Bearer ${await tokenDoGerente()}` };
    const r = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(auth)
      .send({ discountLimitPercent: '7,5' });

    expect(r.status).toBe(200);
    expect(r.body.discountLimitPercent).toBe(7.5);
  });

  it('texto que não é número é recusado pela rota, e nada é gravado', async () => {
    const auth = { Authorization: `Bearer ${await tokenDoGerente()}` };
    const r = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(auth)
      .send({ cashWithdrawalLimitReais: 'quinhentos' });

    expect(r.status).toBe(400);
    const lido = await request(app).get('/api/v1/core/sale-policies').set(auth);
    expect(lido.body.cashWithdrawalLimitCents).toBeNull();
  });

  /**
   * O teto tem de chegar a quem VAI SER BARRADO por ele. O operador de caixa
   * não lê a política — é o limite dele que está ali —, então o número viaja
   * junto da sessão de caixa, que é a rota que ele já chama.
   */
  it('o operador de caixa recebe o teto pela rota do caixa, sem ler a política', async () => {
    const gerente = { Authorization: `Bearer ${await tokenDoGerente()}` };
    await request(app)
      .put('/api/v1/core/sale-policies')
      .set(gerente)
      .send({ cashWithdrawalLimitReais: '800' });

    const caixa = { Authorization: `Bearer ${await tokenDoCaixa()}` };
    const negado = await request(app).get('/api/v1/core/sale-policies').set(caixa);
    expect(negado.status).toBe(403);

    const aberto = await request(app).get('/api/v1/core/cash/open').set(caixa);
    expect(aberto.status).toBe(200);
    expect(aberto.body.cashWithdrawalLimitCents).toBe(80_000);
  });
});
