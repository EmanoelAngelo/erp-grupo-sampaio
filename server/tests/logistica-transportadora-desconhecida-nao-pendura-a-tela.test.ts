/**
 * ============================================================================
 * TRANSPORTADORA DESCONHECIDA RECUSA — NÃO PENDURA A TELA
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * Duas rotas de teste da tela Logística tomavam o `:carrier` da URL sem
 * conferir nada:
 *
 *     POST /logistics/carriers/:carrier/test-quote
 *     POST /logistics/carriers/:carrier/test-tracking
 *
 * As irmãs delas (`test-connection`, `DELETE .../credentials`) já recusavam
 * nome fora do catálogo com `LOGISTICS_CARRIER_INVALID`; estas duas ficaram de
 * fora e faziam `String(req.params.carrier) as LogisticsCarrierId` — um
 * `as` que só existe na compilação.
 *
 * Do outro lado, `simulateQuote` INDEXA uma tabela por transportadora. Nome
 * desconhecido é `services[carrier]` igual a `undefined`, e `undefined.map(...)`
 * é um TypeError — lançado DENTRO de um handler `async`.
 *
 * E aí o segundo defeito, que é o que estraga o dia: este roteador roda sobre
 * Express 4, que não conhece promessa. O que o handler rejeita não chega ao
 * tratador de erros, porque as duas rotas nem recebiam o `next`. A requisição
 * fica ABERTA — sem status, sem corpo — até o cliente desistir; em produção
 * sobra uma linha de log da rede de segurança do processo, e a tela Logística
 * gira para sempre sem dizer o que houve.
 *
 * ## A REGRA
 *
 * Nome fora do catálogo é 400 com motivo, igual ao das irmãs, ANTES de chamar
 * qualquer coisa — e todo handler `async` deste roteador devolve o erro pelo
 * `next`, para que nenhuma falha vire requisição pendurada.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { findRows, resetDbForTests } from '../src/db/database.js';
import { issueSession } from './helpers/sessao.js';

const app = createApp();
const PRECO_JUSTO = 'company-preco-justo-logistica';
const LOJA = 'store-preco-justo-matriz';
const NOME_INVENTADO = 'transportadora-inventada';

/** Um pacote válido: a recusa tem de ser pela transportadora, não pelos dados. */
const PACOTE = {
  originZipCode: '96020000',
  destinationZipCode: '01310100',
  weightGrams: 800,
  heightCm: 10,
  widthCm: 15,
  lengthCm: 20,
  declaredValueInCents: 12000,
};

function gestor() {
  const tokens = issueSession({
    userId: '550e8400-e29b-41d4-a716-4466554400aa',
    companyId: PRECO_JUSTO,
    storeId: LOJA,
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe('a cotação de teste recusa o nome que não existe', () => {
  it('responde 400 com motivo — em vez de deixar a requisição sem resposta', async () => {
    const res = await request(app)
      .post(`/api/v1/logistics/carriers/${NOME_INVENTADO}/test-quote`)
      .set(gestor())
      .send(PACOTE);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('LOGISTICS_CARRIER_INVALID');
  });

  it('e a transportadora do catálogo continua sendo cotada', async () => {
    const res = await request(app)
      .post('/api/v1/logistics/carriers/correios/test-quote')
      .set(gestor())
      .send(PACOTE);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.options)).toBe(true);
    expect(res.body.options.length).toBeGreaterThan(0);
  });
});

describe('o rastreio de teste recusa o mesmo nome', () => {
  it('responde 400 com motivo', async () => {
    const res = await request(app)
      .post(`/api/v1/logistics/carriers/${NOME_INVENTADO}/test-tracking`)
      .set(gestor())
      .send({ trackingCode: 'AA123456789BR' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('LOGISTICS_CARRIER_INVALID');
  });
});

describe('a cotação que o histórico guarda recusa o mesmo nome', () => {
  /*
    A QUARTA PORTA. `POST /logistics/quotes` passava o corpo inteiro adiante e
    o `carrier` nunca era conferido: com pacote válido e nome inventado, a
    resposta medida era 500 {"code":"API_UNAVAILABLE"} por causa do
    `services[carrier].map` de `simulateQuote`.
  */
  it('responde 400 com motivo — e não grava cotação nenhuma', async () => {
    const res = await request(app)
      .post('/api/v1/logistics/quotes')
      .set(gestor())
      .set('Idempotency-Key', 'cotacao-nome-inventado')
      .send({ ...PACOTE, carrier: NOME_INVENTADO });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('LOGISTICS_CARRIER_INVALID');
    expect(findRows('logistics_quotes', () => true)).toHaveLength(0);
  });

  it('e a transportadora do catálogo continua cotando e gravando', async () => {
    const res = await request(app)
      .post('/api/v1/logistics/quotes')
      .set(gestor())
      .set('Idempotency-Key', 'cotacao-correios')
      .send({ ...PACOTE, carrier: 'correios' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(findRows('logistics_quotes', () => true)).toHaveLength(1);
  });

  it('sem transportadora escolhida o corpo continua valendo — cota em todas as configuradas', async () => {
    const res = await request(app)
      .post('/api/v1/logistics/quotes')
      .set(gestor())
      .set('Idempotency-Key', 'cotacao-sem-transportadora')
      .send(PACOTE);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('a homologação não guarda rodada de transportadora inventada', () => {
  it('recusa antes de gravar — a última rodada da tela continua sendo a de verdade', async () => {
    const res = await request(app)
      .post('/api/v1/logistics/homologation/run')
      .set(gestor())
      .set('Idempotency-Key', 'homologacao-nome-inventado')
      .send({ carrier: NOME_INVENTADO });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('LOGISTICS_CARRIER_INVALID');
    expect(findRows('logistics_homologation_executions', () => true)).toHaveLength(0);
  });
});
