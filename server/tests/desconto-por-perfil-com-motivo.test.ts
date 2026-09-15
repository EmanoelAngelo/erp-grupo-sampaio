/**
 * ============================================================================
 * O P0 DA PREÇO JUSTO — DESCONTO NO PDV
 * ============================================================================
 *
 * O que a alçada fazia até esta rodada: UMA pergunta, "a concessão da venda
 * passa de X% do bruto?", com X igual para a operação inteira. O que ficava
 * fora dela, e passava sem gestor e sem rastro:
 *
 *   - limite POR PERFIL (a atendente e o caixa tinham o mesmo teto; o gerente,
 *     nenhum);
 *   - limite em VALOR (10% de uma moto são R$ 1.200);
 *   - limite POR ITEM (60% numa linha barata cabem nos 10% de uma venda grande);
 *   - o MOTIVO da liberação (a trilha dizia quanto e quem, nunca por quê);
 *   - a ALÇADA DE QUEM LIBERA (o gerente limitado a 20% liberava 70%);
 *   - a comparação em ponto flutuante (7% exatos num limite de 7% pediam gestor);
 *   - a trilha confiando no corpo (`authorizationId` do cliente virava
 *     "liberada pelo gestor").
 *
 * E o offline: a venda guardada da atendente, reenviada ou relançada por um
 * caixa de limite maior, era medida pelo limite dele.
 *
 * COMO ESTES CASOS FALHAM (cada guarda tirado de propósito):
 *
 *   - voltando `createSale` a chamar só `discountNeedsAuthorization`, os casos
 *     de perfil, valor e item passam a fechar a venda;
 *   - tirando `conferirAlcadaDoAutorizador`, o gerente de 20% libera 50%;
 *   - voltando `passaDoPercentual` à divisão em ponto flutuante, os 7% exatos
 *     pedem gestor;
 *   - tirando a conferência do motivo em `authorizeAction`, a senha sem porquê
 *     libera na operação que o exige;
 *   - voltando a trilha a ler `req.body.authorizationId`, o id inventado vira
 *     "liberada";
 *   - tirando `perfisDeQuemVendeu`, a venda da atendente passa pelo caixa.
 *
 * Nenhum caso procura texto de código: todos executam venda, documento e
 * liberação de verdade contra um banco descartável e conferem o que ficou nele.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createQuote } from '../src/services/core/QuoteService.js';
import { passaDoPercentual } from '../src/services/core/AuthorizationService.js';
import {
  exigirMotivoDaLiberacaoNaPrecoJusto,
  gravarLimitesPorPerfil,
  limitesPorPerfil,
  normalizarLimitesPorPerfil,
  politicaDaEmpresa,
  salvarPolitica,
} from '../src/services/core/SalePolicyService.js';

const app = createApp();
const LOJA = 'loja-p0-desconto';
const OUTRA = 'loja-p0-vizinha';
const CAMISA = 10_000;
const MOTO = 1_200_000;
const BONE = 999;

type Auth = { Authorization: string };
interface Pessoa {
  auth: Auth;
  id: string;
  login: string;
}

let caixa: Pessoa;
let atendente: Pessoa;
let gerente: Pessoa;
let gerenteVizinho: Pessoa;

const CAIXA = { profileCodes: ['operador_caixa_loja'] };
const ATENDENTE = { profileCodes: ['atendente'] };
const GERENTE = { profileCodes: ['gerente_loja'] };

async function entrar(empresa: string, userId: string, perfil: string): Promise<Pessoa> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    id: String(res.body.user.id),
    login: `${userId}@${empresa}`,
  };
}

function produto(id: string, nome: string, precoCents: number, empresa = LOJA): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 'Geral', 0, 1, ?, ?)`,
    )
    .run(id, empresa, id, nome, precoCents, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(empresa, id, agora);
}

function saldo(productId: string): number {
  return (
    getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE product_id = ?')
      .get(productId) as { quantity: number }
  ).quantity;
}

/** A régua do dono, gravada pelo mesmo caminho da tela (normaliza e grava). */
function limitar(linhas: Record<string, unknown>[], empresa = LOJA) {
  return gravarLimitesPorPerfil({
    companyId: empresa,
    userId: 'dono',
    limites: normalizarLimitesPorPerfil(linhas),
  });
}

/**
 * Liberação já registrada, com o autorizador DE VERDADE (um vínculo real).
 * Quem prova que a senha é conferida é o grupo HTTP deste arquivo e o
 * pdv-finalizacao; aqui o que está sob teste é a venda GASTAR a liberação.
 */
function liberacao(opcoes: { para: string; por: string; empresa?: string }): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by, justification, created_at)
       VALUES (?, ?, 'desconto_acima_limite', ?, ?, 'cliente fiel', ?)`,
    )
    .run(id, opcoes.empresa ?? LOJA, opcoes.para, opcoes.por, new Date().toISOString());
  return id;
}

function consumidaEm(id: string): string | null {
  return (
    getConnection().prepare('SELECT consumed_ref_id FROM core_authorizations WHERE id = ?').get(id) as {
      consumed_ref_id: string | null;
    }
  ).consumed_ref_id;
}

function venda(extra: Record<string, unknown>) {
  return createSale({
    companyId: LOJA,
    userId: caixa.id,
    idempotencyKey: randomUUID(),
    items: [],
    payments: [],
    ...extra,
  } as Parameters<typeof createSale>[0]);
}

/** Camiseta de R$ 100,00 com desconto de rodapé, pago em dinheiro. */
function camisaComDesconto(descontoCents: number, alcada: Record<string, unknown> = CAIXA) {
  return venda({
    items: [{ productId: 'p-camisa', quantity: 1 }],
    discountCents: descontoCents,
    payments: [{ method: 'dinheiro', amountCents: CAMISA - descontoCents }],
    alcada,
  });
}

interface Excesso {
  regra: string;
  limite: number;
  medido: number;
  productId?: string;
  nome?: string;
}

interface DetalheDaRecusa {
  limite?: number | null;
  excessos?: Excesso[];
  brutoCents?: number;
  origens?: { cabecalho: number; itens: number; precoRebaixado: number };
  authorizedBy?: string;
}

function erroDe(fn: () => unknown): { code: string; message: string; details: DetalheDaRecusa } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string; details?: unknown };
    return { code: e.code, message: e.message, details: (e.details ?? {}) as DetalheDaRecusa };
  }
  throw new Error('esperava um erro, e a operação passou');
}

function regras(d: DetalheDaRecusa): string[] {
  return (d.excessos ?? []).map((e) => e.regra);
}

async function abrirCaixa(quem: Pessoa): Promise<string> {
  const r = await request(app).post('/api/v1/core/cash/open').set(quem.auth).send({ openingCents: 0 });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

function vender(quem: Pessoa, chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(quem.auth).set('Idempotency-Key', chave).send(corpo);
}

function pedirLiberacao(quem: Pessoa, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/authorizations')
    .set(quem.auth)
    .send({ action: 'desconto_acima_limite', login: gerente.login, password: TEST_PASSWORD, ...corpo });
}

function trilhaDaVenda(saleId: string): Record<string, unknown> {
  const linha = getConnection()
    .prepare(`SELECT detail FROM core_audit_log WHERE action = 'sale.create' AND entity_id = ?`)
    .get(saleId) as { detail: string } | undefined;
  expect(linha, 'a venda não deixou trilha').toBeTruthy();
  return JSON.parse(linha!.detail) as Record<string, unknown>;
}

function trilhaInteira(): string {
  return (
    getConnection().prepare('SELECT detail FROM core_audit_log').all() as { detail: string | null }[]
  )
    .map((l) => l.detail ?? '')
    .join('\n');
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  caixa = await entrar(LOJA, 'caixa-p0', 'operador_caixa_loja');
  atendente = await entrar(LOJA, 'atendente-p0', 'atendente');
  gerente = await entrar(LOJA, 'gerente-p0', 'gerente_loja');
  gerenteVizinho = await entrar(OUTRA, 'gerente-vizinho-p0', 'gerente_loja');
  produto('p-camisa', 'Camiseta', CAMISA);
  produto('p-moto', 'Moto Elétrica', MOTO);
  produto('p-bone', 'Boné', BONE);
});

/* ========================================================================== */
/* O PADRÃO É O DE ONTEM                                                      */
/* ========================================================================== */

describe('operação que não configurou nada vende exatamente como antes', () => {
  it('10% exatos passam, o centavo seguinte pede gestor, e o gerente sem linha segue sem teto', () => {
    expect(camisaComDesconto(1_000).sale.total_cents).toBe(9_000);

    const erro = erroDe(() => camisaComDesconto(1_001));
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.limite).toBe(10);
    // A frase de sempre: o limite é da operação, não "do seu perfil".
    expect(erro.message).toContain('acima do limite de 10% desta operação');
    expect(erro.message).not.toContain('do seu perfil');

    expect(camisaComDesconto(9_000, GERENTE).sale.total_cents).toBe(1_000);
  });
});

/* ========================================================================== */
/* LIMITE POR PERFIL, EM % E EM R$, NA VENDA E NO ITEM                        */
/* ========================================================================== */

describe('limite por perfil, configurável por operação', () => {
  it('atendente com 5% e caixa com 10% na mesma loja: 8% passa para um e não para o outro', () => {
    limitar([{ profileCode: 'atendente', maxPercent: '5' }]);

    const erro = erroDe(() =>
      venda({
        userId: atendente.id,
        items: [{ productId: 'p-camisa', quantity: 1 }],
        discountCents: 800,
        payments: [{ method: 'dinheiro', amountCents: 9_200 }],
        alcada: ATENDENTE,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.limite).toBe(5);
    expect(erro.message).toContain('do seu perfil nesta operação');

    expect(camisaComDesconto(800).sale.total_cents).toBe(9_200);
  });

  it('o limite é DA OPERAÇÃO: o da vizinha não vale aqui, e o daqui não vale lá', () => {
    produto('p-camisa-vizinha', 'Camiseta', CAMISA, OUTRA);
    limitar([{ profileCode: 'operador_caixa_loja', maxPercent: '2' }], OUTRA);

    // Aqui, os 10% de sempre.
    expect(camisaComDesconto(800).sale.total_cents).toBe(9_200);

    // Lá, os 2% da vizinha.
    const erro = erroDe(() =>
      createSale({
        companyId: OUTRA,
        userId: gerenteVizinho.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: 'p-camisa-vizinha', quantity: 1 }],
        discountCents: 300,
        payments: [{ method: 'dinheiro', amountCents: 9_700 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.limite).toBe(2);
  });

  it('gerente com linha configurada passa a pedir liberação acima dela', () => {
    limitar([{ profileCode: 'gerente_loja', maxPercent: '20' }]);
    expect(regras(erroDe(() => camisaComDesconto(3_000, GERENTE)).details)).toEqual(['percentual_venda']);
    expect(camisaComDesconto(1_500, GERENTE).sale.total_cents).toBe(8_500);
  });

  it('o teto em VALOR da venda pega o que o percentual deixa passar (5% de uma moto)', () => {
    limitar([{ profileCode: 'operador_caixa_loja', maxReais: '500,00' }]);

    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1 }],
        discountCents: 60_000,
        payments: [{ method: 'dinheiro', amountCents: MOTO - 60_000 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // 5% cabe nos 10%: o que estoura é o valor, e só ele.
    expect(regras(erro.details)).toEqual(['valor_venda']);
    expect(erro.message).toContain('R$ 500,00');
    expect(saldo('p-moto')).toBe(50);

    const { sale } = venda({
      items: [{ productId: 'p-moto', quantity: 1 }],
      discountCents: 40_000,
      payments: [{ method: 'dinheiro', amountCents: MOTO - 40_000 }],
      alcada: CAIXA,
    });
    expect(sale.total_cents).toBe(MOTO - 40_000);
  });

  it('o teto POR ITEM pega a linha barata escondida numa venda grande', () => {
    limitar([{ profileCode: 'operador_caixa_loja', itemMaxPercent: '15' }]);

    // 60% na camiseta, 0,5% da venda inteira: cabia nos 10% sem ninguém ver.
    const erro = erroDe(() =>
      venda({
        items: [
          { productId: 'p-moto', quantity: 1 },
          { productId: 'p-camisa', quantity: 1, discountCents: 6_000 },
        ],
        payments: [{ method: 'dinheiro', amountCents: MOTO + CAMISA - 6_000 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.details.excessos).toEqual([
      expect.objectContaining({ regra: 'percentual_item', productId: 'p-camisa', nome: 'Camiseta', limite: 15, medido: 60 }),
    ]);
    expect(erro.message).toContain('"Camiseta"');
  });

  it('o teto por item em R$ vale para o PREÇO REBAIXADO, e não só para o desconto digitado', () => {
    limitar([{ profileCode: 'operador_caixa_loja', itemMaxReais: '5,00' }]);

    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-camisa', quantity: 1, unitPriceCents: 9_400 }],
        payments: [{ method: 'dinheiro', amountCents: 9_400 }],
        alcada: CAIXA,
      }),
    );
    expect(regras(erro.details)).toEqual(['valor_item']);

    // Exatos R$ 5,00 cabem no teto de R$ 5,00.
    const { sale } = venda({
      items: [{ productId: 'p-camisa', quantity: 1, unitPriceCents: 9_500 }],
      payments: [{ method: 'dinheiro', amountCents: 9_500 }],
      alcada: CAIXA,
    });
    expect(sale.total_cents).toBe(9_500);
  });

  it('item dentro e rodapé dentro — os DOIS JUNTOS passam do teto da venda', () => {
    limitar([{ profileCode: 'operador_caixa_loja', maxPercent: '10', itemMaxPercent: '8' }]);

    // 7% na linha (cabe nos 8%) + 6% no rodapé = 13% da venda (passa dos 10%).
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-camisa', quantity: 1, discountCents: 700 }],
        discountCents: 600,
        payments: [{ method: 'dinheiro', amountCents: CAMISA - 1_300 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(regras(erro.details)).toEqual(['percentual_venda']);
    expect(erro.details.origens).toMatchObject({ cabecalho: 600, itens: 700 });

    // Cada um sozinho passa.
    expect(
      venda({
        items: [{ productId: 'p-camisa', quantity: 1, discountCents: 700 }],
        payments: [{ method: 'dinheiro', amountCents: CAMISA - 700 }],
        alcada: CAIXA,
      }).sale.total_cents,
    ).toBe(CAMISA - 700);
  });

  it('o ORÇAMENTO tem a mesma régua — escrever no papel não contorna o perfil', () => {
    limitar([
      { profileCode: 'atendente', maxPercent: '5' },
      { profileCode: 'operador_caixa_loja', itemMaxPercent: '5' },
    ]);

    const daAtendente = erroDe(() =>
      createQuote({
        companyId: LOJA,
        userId: atendente.id,
        kind: 'orcamento',
        items: [{ productId: 'p-camisa', quantity: 1, unitPriceCents: 9_200 }],
        alcada: ATENDENTE,
      }),
    );
    expect(daAtendente.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(regras(daAtendente.details)).toEqual(['percentual_venda']);

    const doCaixa = erroDe(() =>
      createQuote({
        companyId: LOJA,
        userId: caixa.id,
        kind: 'orcamento',
        items: [{ productId: 'p-camisa', quantity: 1, unitPriceCents: 9_000 }],
        alcada: CAIXA,
      }),
    );
    expect(regras(doCaixa.details)).toEqual(['percentual_item']);
  });

  it('a gravação recusa perfil desconhecido, admin_geral, texto e percentual acima de 100', () => {
    for (const ruim of [
      [{ profileCode: 'perfil-inventado', maxPercent: '5' }],
      [{ profileCode: 'admin_geral', maxPercent: '5' }],
      [{ profileCode: 'atendente', maxPercent: 'dez' }],
      [{ profileCode: 'atendente', itemMaxPercent: '150' }],
      [{ profileCode: 'atendente' }, { profileCode: 'atendente' }],
    ]) {
      expect(erroDe(() => limitar(ruim)).code).toBe('CORE_SALE_POLICY_INVALID');
    }
    expect(limitesPorPerfil(LOJA)).toEqual([]);
  });

  it('o valor digitado com milhar e vírgula vira centavos, e a linha toda vazia volta ao padrão', () => {
    expect(limitar([{ profileCode: 'atendente', maxReais: '1.234,56', itemMaxPercent: '7,125' }])).toEqual([
      { profileCode: 'atendente', maxPercent: null, maxCents: 123_456, itemMaxPercent: 7.13, itemMaxCents: null },
    ]);
    expect(limitar([{ profileCode: 'atendente', maxPercent: '', maxReais: '' }])).toEqual([]);
  });
});

/* ========================================================================== */
/* PERCENTUAL E VALOR EM CENTAVOS INTEIROS                                    */
/* ========================================================================== */

describe('percentual e valor, comparados em centavos inteiros', () => {
  it('7% exatos num limite de 7% passam — a conta em ponto flutuante pedia gestor', () => {
    // O defeito, escrito como fato do JavaScript:
    expect((700 / 10_000) * 100 > 7).toBe(true);
    expect(passaDoPercentual(10_000, 700, 7)).toBe(false);
    expect(passaDoPercentual(10_000, 701, 7)).toBe(true);

    salvarPolitica({ companyId: LOJA, userId: 'dono', discountLimitPercent: 7 });
    expect(camisaComDesconto(700).sale.total_cents).toBe(9_300);
    expect(erroDe(() => camisaComDesconto(701)).code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
  });

  it('limite com casa decimal: 2,5% de R$ 100,00 são 250 centavos, e 251 já passa', () => {
    expect(passaDoPercentual(10_000, 250, 2.5)).toBe(false);
    expect(passaDoPercentual(10_000, 251, 2.5)).toBe(true);
  });

  it('preço quebrado: 10% de R$ 9,99 são 99,9 centavos — 99 cabem, 100 já pedem gestor', () => {
    expect(passaDoPercentual(BONE, 99, 10)).toBe(false);
    expect(passaDoPercentual(BONE, 100, 10)).toBe(true);
    const bone = (desconto: number) =>
      venda({
        items: [{ productId: 'p-bone', quantity: 1 }],
        discountCents: desconto,
        payments: [{ method: 'dinheiro', amountCents: BONE - desconto }],
        alcada: CAIXA,
      });
    expect(bone(99).sale.total_cents).toBe(900);
    expect(erroDe(() => bone(100)).code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
  });

  it('teto de R$ 50,00: exatos 5.000 centavos passam e 5.001 não', () => {
    limitar([{ profileCode: 'operador_caixa_loja', maxReais: '50' }]);
    const moto = (desconto: number) =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1 }],
        discountCents: desconto,
        payments: [{ method: 'dinheiro', amountCents: MOTO - desconto }],
        alcada: CAIXA,
      });
    expect(moto(5_000).sale.total_cents).toBe(MOTO - 5_000);
    expect(regras(erroDe(() => moto(5_001)).details)).toEqual(['valor_venda']);
  });
});

/* ========================================================================== */
/* ENTRADAS DEFENSIVAS                                                        */
/* ========================================================================== */

describe('entradas defensivas: o corpo não decide nada', () => {
  it('desconto NEGATIVO é recusado na linha e no rodapé', () => {
    expect(
      erroDe(() =>
        venda({
          items: [{ productId: 'p-camisa', quantity: 1, discountCents: -500 }],
          payments: [{ method: 'dinheiro', amountCents: CAMISA + 500 }],
          alcada: CAIXA,
        }),
      ).code,
    ).toBe('CORE_INVALID_DISCOUNT');
    expect(erroDe(() => camisaComDesconto(-500)).code).toBe('CORE_INVALID_DISCOUNT');
  });

  it('desconto maior que o item, e desconto que leva o total abaixo de zero, são recusados', () => {
    expect(
      erroDe(() =>
        venda({
          items: [{ productId: 'p-camisa', quantity: 1, discountCents: CAMISA + 1 }],
          payments: [{ method: 'dinheiro', amountCents: 1 }],
          alcada: GERENTE,
        }),
      ).code,
    ).toBe('CORE_INVALID_DISCOUNT');
    const rodape = erroDe(() => camisaComDesconto(CAMISA + 1, GERENTE));
    expect(rodape.code).toBe('CORE_INVALID_DISCOUNT');
    expect(rodape.message).toContain('maior que o total');
    expect(saldo('p-camisa')).toBe(50);
  });

  it('PREÇO ALTERADO: acima do vigente é cortado, abaixo é concessão — uma linha inflada não paga a outra', () => {
    const erro = erroDe(() =>
      venda({
        items: [
          { productId: 'p-camisa', quantity: 1, unitPriceCents: 200_000 },
          { productId: 'p-moto', quantity: 1, unitPriceCents: 1_000_000 },
        ],
        payments: [{ method: 'dinheiro', amountCents: 1_010_000 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // O bruto é o vigente (R$ 100 da camiseta), e não os R$ 2.000 do corpo.
    expect(erro.details.brutoCents).toBe(CAMISA + MOTO);
    expect(erro.details.origens?.precoRebaixado).toBe(200_000);
  });

  it('CORPO FORJADO: perfil, autorizador, total e limite declarados pelo cliente não abrem a alçada', async () => {
    const gaveta = await abrirCaixa(caixa);
    const r = await vender(caixa, `pdv-${randomUUID()}`, {
      items: [{ productId: 'p-camisa', quantity: 1 }],
      discountCents: 5_000,
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
      cashSessionId: gaveta,
      profileCodes: ['gestor'],
      profiles: ['admin_geral'],
      alcada: { profileCodes: ['gestor'] },
      authorizedBy: gerente.id,
      autorizadoPor: gerente.id,
      estimatedTotalCents: 1_000_000,
      limite: 100,
      discountLimitPercent: 100,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(r.body.error.details.limite).toBe(10);
    expect(saldo('p-camisa')).toBe(50);
  });

  it('liberação de OUTRA operação não vale aqui, e a de lá fica intacta', () => {
    const daVizinha = liberacao({ para: caixa.id, por: gerenteVizinho.id, empresa: OUTRA });
    const erro = erroDe(() => camisaComDesconto(5_000, { ...CAIXA, authorizationId: daVizinha }));
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(consumidaEm(daVizinha)).toBeNull();
  });

  it('gerente de OUTRA operação não autoriza nesta — nem com a senha certa', async () => {
    const r = await request(app)
      .post('/api/v1/core/authorizations')
      .set(caixa.auth)
      .send({
        action: 'desconto_acima_limite',
        login: gerenteVizinho.login,
        password: TEST_PASSWORD,
        concedidoCents: 5_000,
        brutoCents: CAMISA,
        justificativa: 'cliente fiel, compra de atacado',
      });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CORE_AUTHORIZATION_DENIED');
    const linhas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_authorizations WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(linhas.n).toBe(0);
  });
});

/* ========================================================================== */
/* QUEM LIBERA, POR QUÊ, E A TRILHA                                           */
/* ========================================================================== */

describe('acima do limite: gestor identificado, com motivo, e a trilha inteira', () => {
  it('onde a operação exige, a senha SEM MOTIVO não libera nada — e a senha não vai para a trilha', async () => {
    salvarPolitica({ companyId: LOJA, userId: 'dono', discountReasonRequired: true });

    const semMotivo = await pedirLiberacao(caixa, { concedidoCents: 5_000, brutoCents: CAMISA });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_AUTHORIZATION_REASON_REQUIRED');

    const curto = await pedirLiberacao(caixa, { justificativa: ' ok ' });
    expect(curto.status).toBe(400);

    const comMotivo = await pedirLiberacao(caixa, {
      concedidoCents: 5_000,
      brutoCents: CAMISA,
      justificativa: '  cliente fiel,   compra de atacado ',
    });
    expect(comMotivo.status, JSON.stringify(comMotivo.body)).toBe(201);
    expect(comMotivo.body.justificativa).toBe('cliente fiel, compra de atacado');

    const gravadas = getConnection()
      .prepare('SELECT authorized_by, justification FROM core_authorizations WHERE company_id = ?')
      .all(LOJA) as { authorized_by: string; justification: string }[];
    expect(gravadas).toEqual([{ authorized_by: gerente.id, justification: 'cliente fiel, compra de atacado' }]);
    expect(trilhaInteira()).not.toContain(TEST_PASSWORD);
  });

  it('sem a exigência (o padrão), a liberação sem motivo continua valendo — como sempre', async () => {
    const r = await pedirLiberacao(caixa, { concedidoCents: 5_000, brutoCents: CAMISA });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.justificativa).toBeNull();
  });

  it('a venda liberada grava quem aplicou, quem liberou, o motivo e o antes/depois — lidos do SERVIDOR', async () => {
    const gaveta = await abrirCaixa(caixa);
    const lib = await pedirLiberacao(caixa, {
      concedidoCents: 5_000,
      brutoCents: CAMISA,
      justificativa: 'troca de peça com defeito',
    });
    expect(lib.status).toBe(201);

    const r = await vender(caixa, `pdv-${randomUUID()}`, {
      items: [{ productId: 'p-camisa', quantity: 1 }],
      discountCents: 5_000,
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
      cashSessionId: gaveta,
      authorizationId: lib.body.id,
      // O cliente tenta assinar por outro gestor: a trilha não ouve.
      authorizedBy: 'gestor-inventado',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const trilha = trilhaDaVenda(r.body.id as string);
    expect(trilha.authorizationId).toBe(lib.body.id);
    expect(trilha.alcada).toMatchObject({
      aplicadoPor: caixa.id,
      liberacao: { id: lib.body.id, autorizadoPor: gerente.id, justificativa: 'troca de peça com defeito' },
      brutoCents: CAMISA,
      concedidoCents: 5_000,
      totalCents: 5_000,
      percentual: 50,
      limite: { percentual: 10, valorCents: null, itemPercentual: null, itemValorCents: null },
      excessos: [expect.objectContaining({ regra: 'percentual_venda', limite: 10, medido: 50 })],
    });
    expect(trilhaInteira()).not.toContain(TEST_PASSWORD);
    expect(trilhaInteira()).not.toContain('gestor-inventado');
  });

  it('id de liberação no corpo de uma venda DENTRO do limite não vira "liberada" na trilha', async () => {
    const gaveta = await abrirCaixa(caixa);
    const r = await vender(caixa, `pdv-${randomUUID()}`, {
      items: [{ productId: 'p-camisa', quantity: 1 }],
      discountCents: 500,
      payments: [{ method: 'dinheiro', amountCents: 9_500 }],
      cashSessionId: gaveta,
      authorizationId: randomUUID(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const trilha = trilhaDaVenda(r.body.id as string);
    expect(trilha.authorizationId).toBeNull();
    expect(trilha.alcada).toMatchObject({ liberacao: null, excessos: [], concedidoCents: 500 });
  });

  it('o gerente limitado a 20% NÃO libera 50% — e a liberação fica intacta para uma venda menor', () => {
    limitar([{ profileCode: 'gerente_loja', maxPercent: '20' }]);
    const id = liberacao({ para: caixa.id, por: gerente.id });

    const erro = erroDe(() => camisaComDesconto(5_000, { ...CAIXA, authorizationId: id }));
    expect(erro.code).toBe('CORE_AUTHORIZATION_ABOVE_AUTHORIZER_LIMIT');
    expect(erro.message).toContain('gerente-p0');
    expect(erro.details.authorizedBy).toBe(gerente.id);
    // A transação desfez o consumo: o bilhete continua bom.
    expect(consumidaEm(id)).toBeNull();

    const { sale } = camisaComDesconto(1_500, { ...CAIXA, authorizationId: id });
    expect(consumidaEm(id)).toBe(sale.id);
  });

  it('Preço Justo: o passo liga o motivo SÓ nela, uma vez, respeita o "não" do dono e não inventa limite', () => {
    const pj = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });

    expect(exigirMotivoDaLiberacaoNaPrecoJusto()).toBe(true);
    expect(politicaDaEmpresa(pj).discountReasonRequired).toBe(true);
    expect(politicaDaEmpresa(LOJA).discountReasonRequired).toBe(false);
    // Idempotente: a segunda subida não escreve nada.
    expect(exigirMotivoDaLiberacaoNaPrecoJusto()).toBe(false);
    // Nenhum limite por perfil foi inventado: esses números são do dono.
    expect(limitesPorPerfil(pj)).toEqual([]);

    // Salvar a política SEM o campo mantém a trava — cliente antigo não a desliga.
    salvarPolitica({ companyId: pj, userId: 'dono', discountLimitPercent: 5 });
    expect(politicaDaEmpresa(pj).discountReasonRequired).toBe(true);

    // O "não" explícito do dono fica, mesmo depois de outra subida.
    salvarPolitica({ companyId: pj, userId: 'dono', discountReasonRequired: false });
    expect(exigirMotivoDaLiberacaoNaPrecoJusto()).toBe(false);
    expect(politicaDaEmpresa(pj).discountReasonRequired).toBe(false);
  });

  it('a política e os limites por perfil atravessam a rota do gerente, e a mudança fica na auditoria com o antes', async () => {
    const put = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(gerente.auth)
      .send({
        discountLimitPercent: '',
        creditSaleDueDays: '',
        reservationValidDays: '',
        cashWithdrawalLimitReais: '',
        discountReasonRequired: true,
        limitesPorPerfil: [{ profileCode: 'atendente', maxPercent: '5', maxReais: '50,00', itemMaxPercent: '', itemMaxReais: '' }],
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.discountReasonRequired).toBe(true);
    expect(put.body.limitesPorPerfil).toEqual([
      { profileCode: 'atendente', maxPercent: 5, maxCents: 5_000, itemMaxPercent: null, itemMaxCents: null },
    ]);

    // Valor recusado nos limites não grava NADA — nem a política.
    const ruim = await request(app)
      .put('/api/v1/core/sale-policies')
      .set(gerente.auth)
      .send({ discountLimitPercent: 3, limitesPorPerfil: [{ profileCode: 'atendente', maxPercent: 'cinco' }] });
    expect(ruim.status).toBe(400);
    expect(politicaDaEmpresa(LOJA).discountLimitPercent).toBe(10);

    const log = getConnection()
      .prepare(`SELECT detail FROM core_audit_log WHERE company_id = ? AND action = 'sale_policy.update'`)
      .get(LOJA) as { detail: string };
    const detalhe = JSON.parse(log.detail) as Record<string, unknown>;
    expect(detalhe.discountReasonRequired).toBe(true);
    expect(detalhe.limitesPorPerfilAntes).toEqual([]);

    // O PDV da atendente recebe os tetos dela, e não os da operação.
    const doPdv = await request(app).get('/api/v1/core/sales/discount-policy').set(atendente.auth);
    expect(doPdv.status).toBe(200);
    expect(doPdv.body).toMatchObject({
      operatorLimitPercent: 10,
      canAuthorizeSelf: false,
      motivoObrigatorio: true,
      limiteDoPerfil: { percentual: 5, valorCents: 5_000, doPerfil: true },
    });
    // O caixa não lê nem grava a política: é o limite dele que está ali.
    expect((await request(app).get('/api/v1/core/sale-policies').set(caixa.auth)).status).toBe(403);
  });
});

/* ========================================================================== */
/* OFFLINE                                                                    */
/* ========================================================================== */

describe('offline: a venda guardada não contorna o limite, e a fila é idempotente', () => {
  const QUANDO = '2026-09-14T15:10:00.000Z';

  async function cenario() {
    limitar([{ profileCode: 'atendente', maxPercent: '5' }]);
    const gaveta = await abrirCaixa(caixa);
    // 8% de rodapé: cabe nos 10% do caixa, não nos 5% da atendente que vendeu.
    const corpo = {
      items: [{ productId: 'p-camisa', quantity: 1 }],
      discountCents: 800,
      payments: [{ method: 'dinheiro', amountCents: 9_200 }],
      cashSessionId: gaveta,
      vendaGuardada: { userId: atendente.id, queuedAt: QUANDO },
    };
    return { gaveta, corpo, chave: `pdv-${randomUUID()}` };
  }

  function vendasComAChave(chave: string): number {
    return (
      getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ? AND idempotency_key = ?')
        .get(LOJA, chave) as { n: number }
    ).n;
  }

  it('a venda da atendente (5%) reenviada pelo caixa (10%) é recusada e vira pendência — nunca aceita calada', async () => {
    const c = await cenario();
    const reenvio = await vender(caixa, c.chave, c.corpo);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(403);
    expect(reenvio.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(reenvio.body.error.details.limite).toBe(5);
    expect(vendasComAChave(c.chave)).toBe(0);

    const entregue = await request(app).post('/api/v1/core/offline-sales').set(caixa.auth).send({
      idempotencyKey: c.chave,
      label: 'venda do PDV',
      body: c.corpo,
      queuedAt: QUANDO,
      errorCode: reenvio.body.error.code,
      errorMessage: reenvio.body.error.message,
    });
    expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
    expect(entregue.body.pendencia.status).toBe('pendente');

    // A MESMA venda feita pelo próprio caixa passa: o que mudou foi quem vendeu.
    // (`undefined` não viaja no JSON: é o corpo sem `vendaGuardada`.)
    const doCaixa = { ...c.corpo, vendaGuardada: undefined };
    expect((await vender(caixa, `pdv-${randomUUID()}`, doCaixa)).status).toBe(201);
  });

  it('relançar pelo caixa sem liberação continua recusado; com a do gestor vende UMA vez, e o reenvio é idempotente', async () => {
    const c = await cenario();
    const reenvio = await vender(caixa, c.chave, c.corpo);
    expect(reenvio.status).toBe(403);
    const pend = (
      await request(app).post('/api/v1/core/offline-sales').set(caixa.auth).send({
        idempotencyKey: c.chave,
        label: 'venda do PDV',
        body: c.corpo,
        queuedAt: QUANDO,
        errorCode: reenvio.body.error.code,
        errorMessage: reenvio.body.error.message,
      })
    ).body.pendencia as { id: string };

    // O caixa de 10% não abre para a atendente o que o perfil dela não abre.
    const semLiberacao = await request(app)
      .post(`/api/v1/core/offline-sales/${pend.id}/relaunch`)
      .set(caixa.auth)
      .send({});
    expect(semLiberacao.status, JSON.stringify(semLiberacao.body)).toBe(403);
    expect(semLiberacao.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(vendasComAChave(c.chave)).toBe(0);

    const lib = await pedirLiberacao(caixa, {
      concedidoCents: 800,
      brutoCents: CAMISA,
      justificativa: 'venda guardada sem servidor, conferida',
    });
    expect(lib.status).toBe(201);
    const relancada = await request(app)
      .post(`/api/v1/core/offline-sales/${pend.id}/relaunch`)
      .set(caixa.auth)
      .send({ authorizationId: lib.body.id });
    expect(relancada.status, JSON.stringify(relancada.body)).toBe(201);
    expect(vendasComAChave(c.chave)).toBe(1);
    expect(trilhaDaVenda(relancada.body.sale.id as string).alcada).toMatchObject({
      liberacao: { id: lib.body.id, autorizadoPor: gerente.id, justificativa: 'venda guardada sem servidor, conferida' },
    });

    // A cópia que ainda estava na fila do PDV sobe depois: é a MESMA venda.
    const copia = await vender(caixa, c.chave, c.corpo);
    expect(copia.status, JSON.stringify(copia.body)).toBe(200);
    expect(copia.body.id).toBe(relancada.body.sale.id);
    expect(vendasComAChave(c.chave)).toBe(1);
    expect(consumidaEm(lib.body.id as string)).toBe(relancada.body.sale.id);
  });

  it('o gerente que relança decide com a alçada DELE — é a regularização explícita, e fica na trilha', async () => {
    const c = await cenario();
    const reenvio = await vender(caixa, c.chave, c.corpo);
    const pend = (
      await request(app).post('/api/v1/core/offline-sales').set(caixa.auth).send({
        idempotencyKey: c.chave,
        label: 'venda do PDV',
        body: c.corpo,
        queuedAt: QUANDO,
        errorCode: reenvio.body.error.code,
        errorMessage: reenvio.body.error.message,
      })
    ).body.pendencia as { id: string };

    const r = await request(app)
      .post(`/api/v1/core/offline-sales/${pend.id}/relaunch`)
      .set(gerente.auth)
      .send({ cashSessionId: null, terminalId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const trilha = getConnection()
      .prepare(`SELECT user_id, detail FROM core_audit_log WHERE action = 'sale.create' AND entity_id = ?`)
      .get(r.body.sale.id as string) as { user_id: string; detail: string };
    expect(trilha.user_id).toBe(gerente.id);
    expect(JSON.parse(trilha.detail).alcada).toMatchObject({ aplicadoPor: gerente.id, concedidoCents: 800 });
  });

  it('reenviar a mesma venda guardada duas vezes não duplica nada', async () => {
    const gaveta = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      items: [{ productId: 'p-camisa', quantity: 1 }],
      discountCents: 500,
      payments: [{ method: 'dinheiro', amountCents: 9_500 }],
      cashSessionId: gaveta,
      vendaGuardada: { userId: caixa.id, queuedAt: QUANDO },
    };
    const primeira = await vender(caixa, chave, corpo);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    const segunda = await vender(caixa, chave, corpo);
    expect(segunda.status).toBe(200);
    expect(segunda.body.id).toBe(primeira.body.id);
    expect(vendasComAChave(chave)).toBe(1);
    expect(saldo('p-camisa')).toBe(49);
  });
});
