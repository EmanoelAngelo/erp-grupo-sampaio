/**
 * A GAVETA SEGURA — cinco defeitos da camada de caixa, cada um com o caso que
 * falhava antes do conserto.
 *
 *   H-caixa-seguranca-04  o teto da sangria valia por MOVIMENTO: cinco sangrias
 *                         de R$ 200 com teto de R$ 200 tiravam R$ 1.000 sem
 *                         gestor nenhum. Agora vale para o TURNO.
 *   H-caixa-seguranca-08  sangria sem motivo: "Sangria −R$ 180", sem destino.
 *   H-caixa-seguranca-09  movimento sem idempotência: a resposta perdida no
 *                         Wi-Fi e o segundo clique gravavam a sangria duas vezes.
 *   H-caixa-seguranca-13  `countedCents ?? 0` (e `openingCents ?? 0`): corpo sem
 *                         o campo fechava o turno com contado zero, sem erro.
 *   H-caixa-seguranca-14  sem teto no servidor para o que entra na gaveta: um
 *                         código de barras bipado virava bilhões de reais.
 *
 * Status EXATO e o ESTADO do banco em cada recusa: guarda que recusa tudo
 * passaria num teste que só olha a resposta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  addMovement,
  openSession,
  TETO_DE_DINHEIRO_NA_GAVETA_CENTS,
} from '../src/services/core/CashService.js';
import { salvarPolitica } from '../src/services/core/SalePolicyService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-gaveta-segura';
const ABERTURA = 300_000;
const CAIXA = ['operador_caixa_loja'];
const GERENTE = ['gerente_loja'];

let app: ReturnType<typeof createApp>;
let sessao: string;

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}`, companyId: EMPRESA, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

/** Uma liberação de sangria já dada pelo gestor, como a rota grava. */
function liberacao(requestedBy: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by, reason, granted_concession_cents, created_at)
       VALUES (?, ?, 'sangria_especial', ?, 'u-gerente', 'teste', NULL, ?)`,
    )
    .run(id, EMPRESA, requestedBy, new Date().toISOString());
  return id;
}

function sangrar(input: {
  amountCents: number;
  perfis: string[];
  userId?: string;
  authorizationId?: string | null;
  chave?: string | null;
  note?: string;
}) {
  return addMovement({
    companyId: EMPRESA,
    sessionId: sessao,
    userId: input.userId ?? 'u-caixa',
    movementType: 'withdrawal',
    amountCents: input.amountCents,
    note: input.note ?? 'Depósito no banco',
    alcada: { profileCodes: input.perfis, authorizationId: input.authorizationId ?? null },
    chave: input.chave ?? null,
  });
}

function movimentos(sessionId = sessao) {
  return getConnection()
    .prepare(
      `SELECT movement_type, amount_cents, reference_type, reference_id, note
         FROM core_cash_movements WHERE session_id = ? AND movement_type <> 'opening'
        ORDER BY created_at, rowid`,
      // `rowid` desempata: dois movimentos no mesmo milissegundo voltavam em
      // ordem instável, e o teste que confere a ordem dos tipos piscava.
    )
    .all(sessionId) as {
    movement_type: string;
    amount_cents: number;
    reference_type: string;
    reference_id: string;
    note: string | null;
  }[];
}

function estadoDaSessao(id: string) {
  return getConnection()
    .prepare('SELECT status, counted_cents FROM core_cash_sessions WHERE id = ?')
    .get(id) as { status: string; counted_cents: number | null };
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  // A empresa e a conta nascem pelo helper antes da gaveta.
  auth('gerente_loja');
  sessao = openSession({ companyId: EMPRESA, userId: 'u-caixa', openingCents: ABERTURA }).id;
});

// ============================================================================

describe('H-caixa-seguranca-04 — o teto da sangria vale para o TURNO', () => {
  beforeEach(() => {
    salvarPolitica({ companyId: EMPRESA, userId: 'u-dono', cashWithdrawalLimitReais: '200' });
  });

  it('a primeira no teto passa; a segunda, mesmo pequena, pede gestor — fracionar não contorna', () => {
    expect(sangrar({ amountCents: 20_000, perfis: CAIXA }).balance).toBe(ABERTURA - 20_000);
    try {
      sangrar({ amountCents: 100, perfis: CAIXA });
      throw new Error('a segunda sangria deveria pedir gestor');
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
      expect(e.code).toBe('CORE_WITHDRAWAL_NEEDS_AUTHORIZATION');
      // A frase diz a soma: sem ela, "R$ 1,00 passa do teto de R$ 200,00" não se entende.
      expect(e.message).toContain('já sangrados sem gestor neste turno');
      expect(e.details).toMatchObject({ tetoCents: 20_000, pedidoCents: 100, jaSangradoSemGestorCents: 20_000 });
    }
    // Nada gravado na recusa.
    expect(movimentos()).toHaveLength(1);
  });

  it('cinco sangrias de R$ 200 com teto de R$ 200: só a primeira passa sem gestor', () => {
    let passaram = 0;
    for (let i = 0; i < 5; i += 1) {
      try {
        sangrar({ amountCents: 20_000, perfis: CAIXA });
        passaram += 1;
      } catch {
        /* recusada: é o que se espera da segunda em diante */
      }
    }
    expect(passaram).toBe(1);
  });

  it('com a liberação do gestor passa, e a sangria liberada NÃO entra na soma do sem-gestor', () => {
    sangrar({ amountCents: 15_000, perfis: CAIXA });
    const id = liberacao('u-caixa');
    expect(sangrar({ amountCents: 10_000, perfis: CAIXA, authorizationId: id }).balance).toBe(ABERTURA - 25_000);
    expect(movimentos().map((m) => m.reference_type)).toEqual(['manual', 'manual_com_gestor']);
    // Sobram R$ 50 de teto sem gestor (200 − 150): R$ 50 passa, R$ 50,01 não.
    expect(sangrar({ amountCents: 5_000, perfis: CAIXA }).balance).toBe(ABERTURA - 30_000);
    expect(() => sangrar({ amountCents: 1, perfis: CAIXA })).toThrow(/liberação de um gestor/);
  });

  it('a sangria do GERENTE não gasta o teto do operador — e o gerente continua sem teto', () => {
    expect(sangrar({ amountCents: 90_000, perfis: GERENTE, userId: 'u-gerente' }).balance).toBe(ABERTURA - 90_000);
    expect(sangrar({ amountCents: 20_000, perfis: CAIXA }).balance).toBe(ABERTURA - 110_000);
    expect(movimentos().map((m) => m.reference_type)).toEqual(['manual_com_gestor', 'manual']);
  });
});

// ============================================================================

describe('H-caixa-seguranca-08 — a sangria diz para onde o dinheiro foi', () => {
  it('pela rota: sem motivo é 400 nomeado e nada é gravado; com motivo passa e o motivo fica', async () => {
    const semMotivo = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .send({ movementType: 'withdrawal', amountCents: 1_000 });
    expect(semMotivo.status, JSON.stringify(semMotivo.body)).toBe(400);
    expect(semMotivo.body.error?.code).toBe('CORE_CASH_REASON_REQUIRED');

    const soEspaco = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .send({ movementType: 'withdrawal', amountCents: 1_000, note: '  a ' });
    expect(soEspaco.status).toBe(400);
    expect(movimentos()).toHaveLength(0);

    const comMotivo = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .send({ movementType: 'withdrawal', amountCents: 1_000, note: '  depósito banco ' });
    expect(comMotivo.status, JSON.stringify(comMotivo.body)).toBe(201);
    expect(movimentos()[0]).toMatchObject({ amount_cents: -1_000, note: 'depósito banco' });
  });

  it('o gerente também diz o motivo — a regra é do dinheiro, não do perfil', () => {
    expect(() => sangrar({ amountCents: 1_000, perfis: GERENTE, note: '' })).toThrow(/motivo da sangria/);
  });

  it('suprimento continua com a observação opcional (dinheiro entrando)', async () => {
    const r = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .send({ movementType: 'supply', amountCents: 5_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

// ============================================================================

describe('H-caixa-seguranca-09 — o reenvio do mesmo movimento não grava de novo', () => {
  it('mesma chave e mesmo corpo: um movimento só, o mesmo saldo, e o reenvio responde 200', async () => {
    const corpo = { movementType: 'withdrawal', amountCents: 50_000, note: 'Depósito no banco' };
    const primeiro = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .set('Idempotency-Key', 'sangria-wifi-1')
      .send(corpo);
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(201);

    const reenvio = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .set('Idempotency-Key', 'sangria-wifi-1')
      .send(corpo);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body).toMatchObject({ balance: ABERTURA - 50_000, repetido: true });
    expect(movimentos()).toHaveLength(1);
    expect(movimentos()[0].reference_id).toBe('sangria-wifi-1');
  });

  it('mesma chave com OUTRO valor: 422 nomeado e nada gravado', async () => {
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .set('Idempotency-Key', 'sangria-wifi-2')
      .send({ movementType: 'withdrawal', amountCents: 50_000, note: 'Depósito no banco' });
    const outro = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('operador_caixa_loja'))
      .set('Idempotency-Key', 'sangria-wifi-2')
      .send({ movementType: 'withdrawal', amountCents: 60_000, note: 'Depósito no banco' });
    expect(outro.status, JSON.stringify(outro.body)).toBe(422);
    expect(outro.body.error?.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(movimentos()).toHaveLength(1);
  });

  it('o reenvio da sangria LIBERADA não gasta a liberação de novo (casa pela chave antes)', () => {
    salvarPolitica({ companyId: EMPRESA, userId: 'u-dono', cashWithdrawalLimitReais: '500' });
    const id = liberacao('u-caixa');
    sangrar({ amountCents: 80_000, perfis: CAIXA, authorizationId: id, chave: 'liberada-1' });
    // Sem o casamento pela chave, este reenvio daria "liberação já foi usada".
    const r = sangrar({ amountCents: 80_000, perfis: CAIXA, authorizationId: id, chave: 'liberada-1' });
    expect(r).toEqual({ balance: ABERTURA - 80_000, repetido: true });
    expect(movimentos()).toHaveLength(1);
  });

  it('sem chave, dois pedidos iguais continuam sendo dois movimentos (o comportamento de antes)', () => {
    sangrar({ amountCents: 1_000, perfis: CAIXA });
    sangrar({ amountCents: 1_000, perfis: CAIXA });
    expect(movimentos()).toHaveLength(2);
  });
});

// ============================================================================

describe('H-caixa-seguranca-13 — contagem e fundo ausentes não viram zero', () => {
  it('fechar sem countedCents (ou com null) é 400 e o turno continua aberto; 0 explícito fecha', async () => {
    for (const corpo of [{}, { countedCents: null }, { countedCents: '' }]) {
      const r = await request(app)
        .post(`/api/v1/core/cash/${sessao}/close`)
        .set(auth('operador_caixa_loja'))
        .send(corpo);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error?.code).toBe('CORE_CASH_COUNT_REQUIRED');
      expect(estadoDaSessao(sessao)).toEqual({ status: 'open', counted_cents: null });
    }
    const zero = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth('operador_caixa_loja'))
      .send({ countedCents: 0 });
    expect(zero.status, JSON.stringify(zero.body)).toBe(200);
    expect(estadoDaSessao(sessao)).toEqual({ status: 'closed', counted_cents: 0 });
  });

  it('abrir sem openingCents é 400 e nenhuma gaveta nasce; 0 explícito abre', async () => {
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth('operador_caixa_loja'))
      .send({ countedCents: ABERTURA });
    const sem = await request(app).post('/api/v1/core/cash/open').set(auth('operador_caixa_loja')).send({});
    expect(sem.status, JSON.stringify(sem.body)).toBe(400);
    expect(sem.body.error?.code).toBe('CORE_CASH_OPENING_REQUIRED');
    const abertas = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_cash_sessions WHERE company_id = ? AND status = 'open'")
      .get(EMPRESA) as { n: number };
    expect(abertas.n).toBe(0);
    const zero = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth('operador_caixa_loja'))
      .send({ openingCents: 0 });
    expect(zero.status, JSON.stringify(zero.body)).toBe(201);
  });
});

// ============================================================================

describe('H-caixa-seguranca-R01 — o que não é número não vira zero (nem um centavo)', () => {
  /*
    Antes, a rota só recusava undefined, null e '' e fazia `Number(valor)` no
    resto: `Number(' ')`, `Number(false)` e `Number([])` são 0 — o turno
    fechava com contado ZERO, a gaveta inteira em falta — e `Number(true)` é 1.
  */
  it('fechar com contagem de espaço, booleano, lista ou objeto é 400 nomeado e o turno segue aberto', async () => {
    for (const countedCents of [' ', '   ', false, true, [], [300_000], {}]) {
      const r = await request(app)
        .post(`/api/v1/core/cash/${sessao}/close`)
        .set(auth('operador_caixa_loja'))
        .send({ countedCents });
      expect(r.status, `${JSON.stringify(countedCents)}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error?.code, JSON.stringify(countedCents)).toBe('CORE_CASH_COUNT_REQUIRED');
      expect(estadoDaSessao(sessao)).toEqual({ status: 'open', counted_cents: null });
    }
  });

  it('texto que é número continua valendo; hexadecimal e notação científica não são contagem', async () => {
    for (const countedCents of ['0x10', '1e3']) {
      const r = await request(app)
        .post(`/api/v1/core/cash/${sessao}/close`)
        .set(auth('operador_caixa_loja'))
        .send({ countedCents });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error?.code).toBe('CORE_INVALID_AMOUNT');
      expect(estadoDaSessao(sessao)).toEqual({ status: 'open', counted_cents: null });
    }
    const texto = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth('operador_caixa_loja'))
      .send({ countedCents: ' 300000 ' });
    expect(texto.status, JSON.stringify(texto.body)).toBe(200);
    expect(estadoDaSessao(sessao)).toEqual({ status: 'closed', counted_cents: ABERTURA });
  });

  it('abrir com fundo true, espaço ou lista é 400 nomeado e nenhuma gaveta nasce (antes: R$ 0,01 ou zero)', async () => {
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth('operador_caixa_loja'))
      .send({ countedCents: ABERTURA });
    for (const openingCents of [true, false, ' ', [], {}]) {
      const r = await request(app).post('/api/v1/core/cash/open').set(auth('operador_caixa_loja')).send({ openingCents });
      expect(r.status, `${JSON.stringify(openingCents)}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error?.code).toBe('CORE_CASH_OPENING_REQUIRED');
    }
    const abertas = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_cash_sessions WHERE company_id = ? AND status = 'open'")
      .get(EMPRESA) as { n: number };
    expect(abertas.n).toBe(0);
  });

  it('suprimento com valor true não lança R$ 0,01 na gaveta', async () => {
    for (const amountCents of [true, [5_000], ' ']) {
      const r = await request(app)
        .post(`/api/v1/core/cash/${sessao}/movements`)
        .set(auth('operador_caixa_loja'))
        .send({ movementType: 'supply', amountCents });
      expect(r.status, `${JSON.stringify(amountCents)}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error?.code).toBe('CORE_INVALID_AMOUNT');
    }
    expect(movimentos()).toHaveLength(0);
  });
});

// ============================================================================

describe('H-caixa-seguranca-14 — o que entra na gaveta tem teto no servidor', () => {
  it('abertura com um código de barras no fundo é 400 e nenhuma gaveta nasce', async () => {
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth('operador_caixa_loja'))
      .send({ countedCents: ABERTURA });
    const r = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth('operador_caixa_loja'))
      .send({ openingCents: 7_894_561_230_012 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.code).toBe('CORE_CASH_AMOUNT_TOO_HIGH');
    const abertas = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_cash_sessions WHERE company_id = ? AND status = 'open'")
      .get(EMPRESA) as { n: number };
    expect(abertas.n).toBe(0);
  });

  it('suprimento e ajuste acima do teto são 400; no teto exato passa', async () => {
    for (const tipo of ['supply', 'adjustment']) {
      const r = await request(app)
        .post(`/api/v1/core/cash/${sessao}/movements`)
        .set(auth('gerente_loja'))
        .send({ movementType: tipo, amountCents: TETO_DE_DINHEIRO_NA_GAVETA_CENTS + 1 });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error?.code).toBe('CORE_CASH_AMOUNT_TOO_HIGH');
    }
    expect(movimentos()).toHaveLength(0);
    const noTeto = await request(app)
      .post(`/api/v1/core/cash/${sessao}/movements`)
      .set(auth('gerente_loja'))
      .send({ movementType: 'supply', amountCents: TETO_DE_DINHEIRO_NA_GAVETA_CENTS });
    expect(noTeto.status, JSON.stringify(noTeto.body)).toBe(201);
  });
});
