/**
 * ============================================================================
 * O LOG DIZ QUAL FOI O ERRO (GAP-PRD-059)
 * ============================================================================
 *
 * `sanitizeForLog` percorria `Object.entries` — e `message` e `stack` de um
 * `Error` não são enumeráveis. Quem escrevia `logError('x', { err })` recebia
 *
 *     {"level":"error","message":"backup_diario_falhou","err":{}}
 *
 * O diário de backup e o laço de expiração de reserva escrevem exatamente
 * assim. Disco cheio, pasta sem permissão, bucket fora do ar: tudo virava a
 * mesma linha sem causa, e o diagnóstico virava adivinhação.
 *
 * O conserto é na raiz (o sanitizador), e não nos dois chamadores: o próximo
 * `{ err }` que alguém escrever também sai legível.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ApiError, logError, logWarn, sanitizeForLog } = await import('../src/utils/errors.js');

let saida: string[] = [];
const NIVEL = process.env.LOG_LEVEL;

beforeEach(() => {
  saida = [];
  delete process.env.LOG_LEVEL;
  for (const metodo of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, metodo).mockImplementation((linha: unknown) => {
      saida.push(String(linha));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  if (NIVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = NIVEL;
});

function ultimaLinha(): Record<string, unknown> {
  expect(saida.length).toBeGreaterThan(0);
  return JSON.parse(saida[saida.length - 1]) as Record<string, unknown>;
}

describe('um Error dentro do meta', () => {
  it('a falha do diário de backup sai com a mensagem', () => {
    logError('backup_diario_falhou', { err: new Error('disco cheio') });
    const linha = ultimaLinha();
    const err = linha.err as Record<string, unknown>;
    expect(saida[0]).toContain('disco cheio');
    expect(err.message).toBe('disco cheio');
    expect(err.name).toBe('Error');
  });

  it('a pilha vem curta: a primeira linha e no máximo quatro quadros', () => {
    logError('reserva_expiracao_laco', { err: new TypeError('x is not a function') });
    const err = ultimaLinha().err as Record<string, unknown>;
    expect(err.name).toBe('TypeError');
    expect(typeof err.stack).toBe('string');
    const partes = String(err.stack).split(' | ');
    expect(partes[0]).toBe('TypeError: x is not a function');
    expect(partes.length).toBeLessThanOrEqual(5);
    expect(partes.length).toBeGreaterThan(1);
  });

  it('o código do sistema operacional vem junto — é ele que diz "disco cheio" de verdade', () => {
    const e = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    logError('backup_diario_falhou', { err: e });
    const err = ultimaLinha().err as Record<string, unknown>;
    expect(err.code).toBe('ENOSPC');
  });

  it('a causa encadeada também sai', () => {
    const e = new Error('o envio falhou', { cause: new Error('ECONNRESET') });
    logWarn('backup_remoto_falhou', { err: e });
    const err = ultimaLinha().err as Record<string, unknown>;
    expect((err.cause as Record<string, unknown>).message).toBe('ECONNRESET');
  });

  it('ApiError leva o código e o status, que são campos enumeráveis dela', () => {
    logError('falhou', { err: new ApiError('CORE_X', 'Algo recusado.', 409) });
    const err = ultimaLinha().err as Record<string, unknown>;
    expect(err.message).toBe('Algo recusado.');
    expect(err.code).toBe('CORE_X');
    expect(err.status).toBe(409);
  });

  it('segredo na mensagem ou na pilha continua mascarado', () => {
    logError('falhou', { err: new Error('HTTP 401 com Bearer sb_secret_abc.def-123 no cabeçalho') });
    expect(saida[0]).not.toContain('sb_secret_abc');
    expect(saida[0]).toContain('Bearer [REDACTED]');
  });

  it('Error solto no primeiro nível e dentro de lista também', () => {
    const limpo = sanitizeForLog({ erros: [new Error('um'), new Error('dois')] }) as {
      erros: Array<{ message: string }>;
    };
    expect(limpo.erros.map((e) => e.message)).toEqual(['um', 'dois']);
  });

  it('causa que aponta para si mesma não prende o log num laço', () => {
    const e = new Error('circular') as Error & { cause?: unknown };
    e.cause = e;
    expect(() => logError('falhou', { err: e })).not.toThrow();
    expect((ultimaLinha().err as Record<string, unknown>).message).toBe('circular');
  });
});
