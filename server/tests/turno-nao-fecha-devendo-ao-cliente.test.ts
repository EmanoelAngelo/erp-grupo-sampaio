/**
 * ============================================================================
 * O TURNO NÃO FECHA CALADO DEVENDO AO CLIENTE
 * ============================================================================
 *
 * Auditoria do PDV da Preço Justo (P0), frente "do bipe ao caixa fechado".
 *
 * O DEFEITO MEDIDO: a Preço Justo é a operação onde a devolução em DUAS ETAPAS
 * está ligada por padrão. Nela o registro da devolução trata só a MERCADORIA —
 * a peça volta à prateleira na hora — e o dinheiro é registrado depois, quando
 * de fato voltar ao cliente (PIX feito pela conta, estorno na maquininha, ou a
 * nota tirada da gaveta).
 *
 * Entre uma coisa e outra a loja DEVE aquele valor, e o fechamento do turno não
 * enxergava isso: a gaveta fechava com diferença ZERO e o histórico dizia
 * "conferido". A aritmética estava certa — o dinheiro do reembolso em espécie
 * continua DENTRO da gaveta —, mas ele não é da loja. O operador ia embora sem
 * saber que devia, o turno seguinte contava aquele dinheiro como seu, e a
 * devolução ficava esperando numa tela que o balcão não abre.
 *
 * O CONSERTO é a mesma régua do GAP-PRD-081, que já vale para cobrança sem
 * resposta, PIX pendente e venda guardada recusada: não trava para sempre —
 * quem paga o cliente muitas vezes é a gestão —, trava até ser DITA. A primeira
 * tentativa volta 409 com o valor e a venda; fechar exige declarar ciência com
 * o motivo, e o que ficou pendente vai para o turno.
 *
 * O que este arquivo prova: a recusa nomeada com os números, o resumo que avisa
 * ANTES de contar a gaveta, o fechamento com ciência (e o registro dele), a
 * devolução JÁ reembolsada que não atrapalha ninguém, o reembolso PARCIAL que
 * continua pendente pelo resto — e que as outras operações do grupo, no fluxo
 * imediato, fecham exatamente como antes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ativarDevolucaoEmDuasEtapasNaPrecoJusto } from '../src/services/core/SalePolicyService.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Turno@PrecoJusto2026';

type Auth = { Authorization: string };

let precoJusto = '';
let gringa = '';

async function entrar(login: string, companyId: string, perfil: string): Promise<Auth> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, perfil, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

interface Balcao {
  caixa: Auth;
  gestor: Auth;
  productId: string;
  gaveta: string;
}

async function balcao(companyId: string, sufixo: string): Promise<Balcao> {
  const caixa = await entrar(`caixa.${sufixo}`, companyId, 'operador_caixa_loja');
  // Quem cadastra, estoca e devolve é a gerência (PJ-CAIXA).
  const gestor = await entrar(`gestor.${sufixo}`, companyId, 'gerente_loja');
  const produto = await request(app)
    .post('/api/v1/core/products')
    .set(gestor)
    .send({ name: `Camiseta ${sufixo}`, priceCents: 5_000 });
  expect(produto.status, JSON.stringify(produto.body)).toBe(201);
  const productId = produto.body.id as string;
  const entrada = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(gestor)
    .send({
      productId,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: `carga-${sufixo}`,
    });
  expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);
  const abertura = await request(app)
    .post('/api/v1/core/cash/open')
    .set(caixa)
    .send({ openingCents: 10_000 });
  expect(abertura.status, JSON.stringify(abertura.body)).toBe(201);
  return { caixa, gestor, productId, gaveta: abertura.body.id as string };
}

/** Vende 2 × R$ 50,00 em dinheiro contado, sem troco. */
async function vender(b: Balcao): Promise<{ saleId: string; saleItemId: string }> {
  const venda = await request(app)
    .post('/api/v1/core/sales')
    .set(b.caixa)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ productId: b.productId, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      cashSessionId: b.gaveta,
    });
  expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  const devolvivel = await request(app)
    .get(`/api/v1/core/sales/${venda.body.id}/returnable`)
    .set(b.caixa);
  expect(devolvivel.status).toBe(200);
  return {
    saleId: venda.body.id as string,
    saleItemId: devolvivel.body.items[0].sale_item_id as string,
  };
}

/** Registra a devolução da MERCADORIA (uma peça), sem reembolso nenhum. */
async function devolverMercadoria(b: Balcao, venda: { saleId: string; saleItemId: string }) {
  const r = await request(app)
    .post('/api/v1/core/sale-returns')
    .set(b.gestor)
    .set('Idempotency-Key', randomUUID())
    .send({
      saleId: venda.saleId,
      reasonCode: 'desistencia',
      items: [{ saleItemId: venda.saleItemId, quantity: 1, condition: 'intacto' }],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Record<string, unknown>;
}

function fechamentoGravado(sessionId: string) {
  return getConnection()
    .prepare('SELECT status, closed_with_pending FROM core_cash_sessions WHERE id = ?')
    .get(sessionId) as { status: string; closed_with_pending: string | null };
}

beforeEach(() => {
  resetDbForTests();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  // A mesma chamada que a subida do servidor faz: duas etapas SÓ na Preço Justo.
  ativarDevolucaoEmDuasEtapasNaPrecoJusto();
});

describe('a devolução em duas etapas sem reembolso não deixa o turno fechar calado', () => {
  it('recusa nomeada com o valor e a venda, e o resumo avisa antes de contar a gaveta', async () => {
    const b = await balcao(precoJusto, 'pj');
    const venda = await vender(b);
    const devolucao = await devolverMercadoria(b, venda);

    // A tela mostra a pendência ANTES de o operador contar a gaveta.
    const resumo = await request(app).get(`/api/v1/core/cash/${b.gaveta}/summary`).set(b.caixa);
    expect(resumo.status).toBe(200);
    const pendencias = resumo.body.pendenciasEletronicas;
    expect(pendencias.quantidade).toBe(1);
    expect(pendencias.totalCents).toBe(5_000);
    expect(pendencias.devolucoesAguardandoReembolso).toHaveLength(1);
    expect(pendencias.devolucoesAguardandoReembolso[0]).toMatchObject({
      id: devolucao.id,
      number: devolucao.number,
      devolvivelCents: 5_000,
      reembolsadoCents: 0,
      pendenteCents: 5_000,
    });
    // A gaveta continua com o dinheiro da venda: o que se deve ainda está nela.
    expect(resumo.body.expectedCents).toBe(20_000);

    const recusa = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({ countedCents: 20_000 });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(409);
    expect(recusa.body.error.code).toBe('CORE_CASH_CLOSE_ELECTRONIC_PENDING');
    expect(recusa.body.error.message).toContain('R$ 50,00 ainda não devolvidos ao cliente');
    expect(recusa.body.error.message).toContain('Vendas › Devoluções');
    expect(recusa.body.error.details.pendencias.devolucoesAguardandoReembolso).toHaveLength(1);
    // Nada foi fechado pela recusa.
    expect(fechamentoGravado(b.gaveta).status).toBe('open');
  });

  it('fechar com ciência exige o motivo, e o que ficou pendente fica gravado no turno', async () => {
    const b = await balcao(precoJusto, 'pj');
    const venda = await vender(b);
    const devolucao = await devolverMercadoria(b, venda);

    const semMotivo = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({ countedCents: 20_000, pendenciasCiente: true });
    expect(semMotivo.status, JSON.stringify(semMotivo.body)).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_CASH_CLOSE_PENDING_REASON_REQUIRED');
    expect(fechamentoGravado(b.gaveta).status).toBe('open');

    const fechado = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({
        countedCents: 20_000,
        pendenciasCiente: true,
        pendenciasMotivo: 'o gerente faz o PIX da devolução amanhã cedo',
      });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(200);
    expect(fechado.body.difference_cents).toBe(0);

    const gravado = fechamentoGravado(b.gaveta);
    expect(gravado.status).toBe('closed');
    const registro = JSON.parse(gravado.closed_with_pending!) as {
      motivo: string;
      totalCents: number;
      devolucoesAguardandoReembolso?: {
        number: number;
        saleNumber: number | null;
        pendenteCents: number;
      }[];
    };
    expect(registro.motivo).toBe('o gerente faz o PIX da devolução amanhã cedo');
    expect(registro.totalCents).toBe(5_000);
    /*
      O DETALHE, E NÃO SÓ O VALOR (P00-caixa-divida). Este caso passava com a
      devolução AUSENTE do registro: o turno guardava
      {"totalCents":5000,"cobrancas":[],"pagamentosPendentes":[]} — "fechei
      devendo R$ 50,00" sem dizer a quem nem de que devolução. Como este campo
      é o único traço durável do que foi declarado (dele vivem o papel e a
      auditoria), a asserção precisa cobrar a DÍVIDA pelo nome.
    */
    expect(registro.devolucoesAguardandoReembolso).toHaveLength(1);
    expect(registro.devolucoesAguardandoReembolso![0]).toMatchObject({
      number: (devolucao as { number: number }).number,
      pendenteCents: 5_000,
    });

    // A auditoria do fechamento conta o tipo certo e nomeia a devolução —
    // antes ela dizia {"cobrancas":0,"pagamentosPendentes":0,"totalCents":5000},
    // uma trilha que se contradiz sozinha.
    const trilha = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'cash.close' AND entity_id = ?`,
      )
      .get(precoJusto, b.gaveta) as { detail: string };
    const detalhe = JSON.parse(trilha.detail) as {
      pendencias: {
        cobrancas: number;
        devolucoesAguardandoReembolso: number;
        devolucoes: { number: number; saleNumber: number | null; pendenteCents: number }[];
        totalCents: number;
      };
    };
    expect(detalhe.pendencias.devolucoesAguardandoReembolso).toBe(1);
    expect(detalhe.pendencias.totalCents).toBe(5_000);
    expect(detalhe.pendencias.devolucoes[0]).toMatchObject({ pendenteCents: 5_000 });
  });

  /*
    ==========================================================================
    O TURNO SEGUINTE TAMBÉM NÃO FECHA CALADO (P00-caixa-divida)
    ==========================================================================

    O DEFEITO MEDIDO pela verificação adversarial: a pendência era procurada
    só DENTRO da janela do turno em que a devolução foi REGISTRADA. O operador
    de caixa não tem `sales.returns.operate`, então a única saída dele é
    declarar ciência — e, feito isso, a dívida sumia do fechamento para
    sempre: o turno 2, com os mesmos R$ 50,00 do cliente ainda na gaveta,
    fechava 200, diferença 0, pendências 0. O conserto adiava o dano um turno
    em vez de impedi-lo.
  */
  it('a dívida acompanha o cliente, e não a janela do turno: o turno seguinte também é barrado', async () => {
    const b = await balcao(precoJusto, 'pj');
    const venda = await vender(b);
    const devolucao = await devolverMercadoria(b, venda);

    // Turno 1 fecha declarando ciência — o caixa não pode reembolsar.
    const primeiro = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({
        countedCents: 20_000,
        pendenciasCiente: true,
        pendenciasMotivo: 'o gerente paga o cliente amanhã',
      });
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(200);

    // Turno 2, no dia seguinte, com o dinheiro do cliente ainda na gaveta.
    const segundaAbertura = await request(app)
      .post('/api/v1/core/cash/open')
      .set(b.caixa)
      .send({ openingCents: 20_000 });
    expect(segundaAbertura.status, JSON.stringify(segundaAbertura.body)).toBe(201);
    const gaveta2 = segundaAbertura.body.id as string;

    const resumo = await request(app).get(`/api/v1/core/cash/${gaveta2}/summary`).set(b.caixa);
    expect(resumo.status).toBe(200);
    expect(resumo.body.pendenciasEletronicas.quantidade).toBe(1);
    expect(resumo.body.pendenciasEletronicas.devolucoesAguardandoReembolso[0]).toMatchObject({
      id: devolucao.id,
      pendenteCents: 5_000,
    });

    const recusa = await request(app)
      .post(`/api/v1/core/cash/${gaveta2}/close`)
      .set(b.caixa)
      .send({ countedCents: 20_000 });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(409);
    expect(recusa.body.error.code).toBe('CORE_CASH_CLOSE_ELECTRONIC_PENDING');
    expect(recusa.body.error.message).toContain('R$ 50,00 ainda não devolvidos ao cliente');

    // Pago o cliente, o turno 2 fecha limpo: a trava acaba com a dívida, e
    // não com a declaração.
    const reembolso = await request(app)
      .post(`/api/v1/core/sale-returns/${devolucao.id}/refunds`)
      .set(b.gestor)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'dinheiro', amountCents: 5_000, cashSessionId: gaveta2 });
    expect(reembolso.status, JSON.stringify(reembolso.body)).toBe(201);

    const fechado = await request(app)
      .post(`/api/v1/core/cash/${gaveta2}/close`)
      .set(b.caixa)
      .send({ countedCents: 15_000 });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(200);
    expect(fechado.body.difference_cents).toBe(0);
    expect(fechamentoGravado(gaveta2).closed_with_pending).toBeNull();
  });

  /*
    A VIA ASSINADA NÃO PODE MENTIR (P00-caixa-divida). O papel do fechamento
    saía «FECHADO COM PENDÊNCIA ELETRÔNICA DE R$ 50,00 … Não está na gaveta:
    continua na fila do gestor.» com a tabela de itens VAZIA — não dizia que
    era devolução ao cliente, e afirmava o contrário da descoberta inteira
    deste conserto: o reembolso em espécie ainda não pago ESTÁ na gaveta.
  */
  it('o papel do fechamento nomeia a devolução e não diz que o dinheiro está fora da gaveta', async () => {
    const b = await balcao(precoJusto, 'pj');
    const venda = await vender(b);
    const devolucao = await devolverMercadoria(b, venda);
    const fechado = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({
        countedCents: 20_000,
        pendenciasCiente: true,
        pendenciasMotivo: 'o gerente paga o cliente amanhã',
      });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(200);

    const { renderDocument } = await import('../src/services/core/PrintRenderer.js');
    const papel = renderDocument(precoJusto, 'CASH_CLOSING', b.gaveta);
    const bloco = papel.slice(papel.indexOf('FECHADO COM PENDÊNCIA'));
    expect(bloco).toContain(`Devolução #${(devolucao as { number: number }).number}`);
    expect(bloco).toContain('ainda não devolvido ao cliente');
    expect(bloco).toMatch(/50,00/);
    // A frase antiga dizia o contrário do que acontece com este dinheiro.
    expect(bloco).not.toContain('Não está na gaveta');
    expect(bloco).toContain('ESTÁ na contagem desta gaveta');
    expect(bloco).toContain('o gerente paga o cliente amanhã');
  });

  it('reembolso registrado no mesmo turno: o turno fecha limpo, sem declarar nada', async () => {
    const b = await balcao(precoJusto, 'pj');
    const venda = await vender(b);
    const devolucao = await devolverMercadoria(b, venda);

    const reembolso = await request(app)
      .post(`/api/v1/core/sale-returns/${devolucao.id}/refunds`)
      .set(b.gestor)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'dinheiro', amountCents: 5_000, cashSessionId: b.gaveta });
    expect(reembolso.status, JSON.stringify(reembolso.body)).toBe(201);

    const resumo = await request(app).get(`/api/v1/core/cash/${b.gaveta}/summary`).set(b.caixa);
    expect(resumo.body.pendenciasEletronicas.quantidade).toBe(0);
    expect(resumo.body.pendenciasEletronicas.devolucoesAguardandoReembolso).toHaveLength(0);
    // O dinheiro saiu da gaveta: R$ 100,00 de fundo + venda − R$ 50,00 devolvidos.
    expect(resumo.body.expectedCents).toBe(15_000);

    const fechado = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({ countedCents: 15_000 });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(200);
    expect(fechado.body.difference_cents).toBe(0);
    expect(fechamentoGravado(b.gaveta).closed_with_pending).toBeNull();
  });

  it('reembolso PARCIAL continua pendente pelo resto, e é o resto que a recusa cobra', async () => {
    const b = await balcao(precoJusto, 'pj');
    const venda = await vender(b);
    const devolucao = await devolverMercadoria(b, venda);

    const parcial = await request(app)
      .post(`/api/v1/core/sale-returns/${devolucao.id}/refunds`)
      .set(b.gestor)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'dinheiro', amountCents: 2_000, cashSessionId: b.gaveta });
    expect(parcial.status, JSON.stringify(parcial.body)).toBe(201);

    const resumo = await request(app).get(`/api/v1/core/cash/${b.gaveta}/summary`).set(b.caixa);
    const pendencia = resumo.body.pendenciasEletronicas.devolucoesAguardandoReembolso[0];
    expect(pendencia).toMatchObject({
      devolvivelCents: 5_000,
      reembolsadoCents: 2_000,
      pendenteCents: 3_000,
    });
    expect(resumo.body.pendenciasEletronicas.totalCents).toBe(3_000);

    const recusa = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({ countedCents: 18_000 });
    expect(recusa.status).toBe(409);
    expect(recusa.body.error.message).toContain('R$ 30,00 ainda não devolvidos');
  });

  it('a Gringa, no fluxo imediato, fecha exatamente como antes', async () => {
    const b = await balcao(gringa, 'gringa');
    const venda = await vender(b);
    // No fluxo imediato o registro já dá o dinheiro por devolvido, num meio só.
    const devolucao = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(b.gestor)
      .set('Idempotency-Key', randomUUID())
      .send({
        saleId: venda.saleId,
        reason: 'o cliente trocou de ideia',
        refundMethod: 'dinheiro',
        items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
        cashSessionId: b.gaveta,
      });
    expect(devolucao.status, JSON.stringify(devolucao.body)).toBe(201);

    const resumo = await request(app).get(`/api/v1/core/cash/${b.gaveta}/summary`).set(b.caixa);
    expect(resumo.body.pendenciasEletronicas.quantidade).toBe(0);
    expect(resumo.body.pendenciasEletronicas.devolucoesAguardandoReembolso).toHaveLength(0);

    const fechado = await request(app)
      .post(`/api/v1/core/cash/${b.gaveta}/close`)
      .set(b.caixa)
      .send({ countedCents: 15_000 });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(200);
    expect(fechado.body.difference_cents).toBe(0);
  });
});
