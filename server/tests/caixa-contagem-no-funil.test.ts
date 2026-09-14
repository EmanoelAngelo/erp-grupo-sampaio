/**
 * O FUNDO DE TROCO E A CONTAGEM VALEM PARA QUALQUER TELA (H-caixa-seguranca-01,
 * as duas telas — a metade do servidor).
 *
 * As duas telas de gaveta (o diálogo do PDV e a tela de Caixa da gestão) agora
 * avisam antes de enviar; a regra, porém, não pode depender delas:
 *
 *   - abrir acima do teto de R$ 100.000,00 é recusado no SERVIÇO
 *     (`CORE_CASH_AMOUNT_TOO_HIGH`), seja qual for o perfil que pede;
 *   - fechar sem a contagem é recusado com `CORE_CASH_COUNT_REQUIRED`. Antes, a
 *     recusa com esse nome existia só na ROTA: o serviço chamado sem a contagem
 *     respondia a régua genérica ("precisa ser um número inteiro de
 *     centavos"), sem dizer que o que faltou foi contar a gaveta — e qualquer
 *     caminho novo até `closeSession` herdaria a mensagem errada.
 *
 * Status EXATO e o ESTADO do banco em cada recusa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  closeSession,
  openSession,
  TETO_DE_DINHEIRO_NA_GAVETA_CENTS,
} from '../src/services/core/CashService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-caixa-duas-telas';
const ABERTURA = 20_000;

let app: ReturnType<typeof createApp>;
let sessao: string;

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}`, companyId: EMPRESA, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

function estado(id = sessao) {
  return getConnection()
    .prepare('SELECT status, counted_cents FROM core_cash_sessions WHERE id = ?')
    .get(id) as { status: string; counted_cents: number | null };
}

function abertas(): number {
  return (
    getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_cash_sessions WHERE company_id = ? AND status = 'open'")
      .get(EMPRESA) as { n: number }
  ).n;
}

function recusaDe(fn: () => unknown): { code?: string; status?: number; message?: string } {
  try {
    fn();
  } catch (err) {
    return err as { code?: string; status?: number; message?: string };
  }
  throw new Error('deveria ter recusado');
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  // A empresa e a conta nascem pelo helper antes da gaveta.
  auth('gerente_loja');
  sessao = openSession({ companyId: EMPRESA, userId: 'u-caixa', openingCents: ABERTURA }).id;
});

describe('fechar sem contagem — a recusa com nome mora no serviço', () => {
  it('closeSession sem a contagem (ausente, nula ou vazia) é CORE_CASH_COUNT_REQUIRED 400, e o turno segue aberto', () => {
    // ' ', false, true, [] e {} (H-caixa-seguranca-R01): a guarda comparava
    // com '' depois do `Number()` da rota; o valor cru é o que se confere.
    for (const contagem of [undefined, null, '', ' ', false, true, [], {}]) {
      const e = recusaDe(() =>
        closeSession({
          companyId: EMPRESA,
          sessionId: sessao,
          userId: 'u-caixa',
          countedCents: contagem as unknown as number,
        }),
      );
      // Antes: CORE_INVALID_AMOUNT, "Contagem do fechamento precisa ser um número inteiro…".
      expect(e.code, String(contagem)).toBe('CORE_CASH_COUNT_REQUIRED');
      expect(e.status).toBe(400);
      expect(e.message).toMatch(/Informe quanto foi contado na gaveta/);
      expect(estado()).toEqual({ status: 'open', counted_cents: null });
    }
  });

  it('a régua dos centavos continua valendo para o que VEIO e não é dinheiro; zero explícito fecha', () => {
    for (const contagem of [Number.NaN, 12.5, -100]) {
      expect(
        recusaDe(() =>
          closeSession({ companyId: EMPRESA, sessionId: sessao, userId: 'u-caixa', countedCents: contagem }),
        ).code,
      ).toBe('CORE_INVALID_AMOUNT');
    }
    expect(estado()).toEqual({ status: 'open', counted_cents: null });
    const fechado = closeSession({ companyId: EMPRESA, sessionId: sessao, userId: 'u-caixa', countedCents: 0 });
    expect(fechado.status).toBe('closed');
    expect(estado()).toEqual({ status: 'closed', counted_cents: 0 });
  });

  it('pela rota, a tela do PDV (operador) e a da gestão (gerente) recebem a MESMA recusa', async () => {
    for (const perfil of ['operador_caixa_loja', 'gerente_loja']) {
      const r = await request(app).post(`/api/v1/core/cash/${sessao}/close`).set(auth(perfil)).send({});
      expect(r.status, `${perfil}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error?.code).toBe('CORE_CASH_COUNT_REQUIRED');
    }
    expect(estado()).toEqual({ status: 'open', counted_cents: null });
  });
});

describe('abrir acima do teto — recusado para qualquer tela', () => {
  it('openSession acima do teto é CORE_CASH_AMOUNT_TOO_HIGH 400 e nenhuma gaveta nasce; no teto exato abre', () => {
    closeSession({ companyId: EMPRESA, sessionId: sessao, userId: 'u-caixa', countedCents: ABERTURA });
    const e = recusaDe(() =>
      openSession({ companyId: EMPRESA, userId: 'u-caixa', openingCents: TETO_DE_DINHEIRO_NA_GAVETA_CENTS + 1 }),
    );
    expect(e.code).toBe('CORE_CASH_AMOUNT_TOO_HIGH');
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/passa do teto de R\$\s*100\.000,00/);
    expect(abertas()).toBe(0);

    const noTeto = openSession({ companyId: EMPRESA, userId: 'u-caixa', openingCents: TETO_DE_DINHEIRO_NA_GAVETA_CENTS });
    expect(noTeto.opening_cents).toBe(TETO_DE_DINHEIRO_NA_GAVETA_CENTS);
  });

  it('pela rota, o código de barras no fundo é recusado para o operador e para o gerente', async () => {
    closeSession({ companyId: EMPRESA, sessionId: sessao, userId: 'u-caixa', countedCents: ABERTURA });
    for (const perfil of ['operador_caixa_loja', 'gerente_loja']) {
      const r = await request(app)
        .post('/api/v1/core/cash/open')
        .set(auth(perfil))
        .send({ openingCents: 7_894_561_230_012 });
      expect(r.status, `${perfil}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error?.code).toBe('CORE_CASH_AMOUNT_TOO_HIGH');
    }
    expect(abertas()).toBe(0);
  });
});
