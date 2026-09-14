/**
 * ============================================================================
 * O LOG OBEDECE O LOG_LEVEL (GAP-PRD-153)
 * ============================================================================
 *
 * `LOG_LEVEL` estava no schema, validado (a API recusa subir com um valor
 * fora da lista) e documentado nos três exemplos — e o logger não o lia:
 * `logInfo` imprimia tudo, sempre. Quem pusesse `LOG_LEVEL=error` para
 * aliviar o disco achava que tinha configurado alguma coisa.
 *
 * A ordem é debug < info < warn < error. O nível é lido a cada chamada (o
 * logger é importado por tudo, antes de o `.env` ser lido), e valor estranho
 * cai em `info` em vez de calar o log — quem recusa valor inválido é o boot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logDebug, logError, logInfo, logWarn } = await import('../src/utils/errors.js');

const ORIGINAL = process.env.LOG_LEVEL;
let saida: string[] = [];

beforeEach(() => {
  saida = [];
  for (const metodo of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, metodo).mockImplementation((linha: unknown) => {
      saida.push(String(linha));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = ORIGINAL;
});

function emitir(): string[] {
  logDebug('evento_debug');
  logInfo('evento_info');
  logWarn('evento_warn');
  logError('evento_error');
  return saida.map((l) => (JSON.parse(l) as { message: string }).message);
}

describe('LOG_LEVEL', () => {
  it('error: só o erro sai', () => {
    process.env.LOG_LEVEL = 'error';
    expect(emitir()).toEqual(['evento_error']);
  });

  it('warn: aviso e erro', () => {
    process.env.LOG_LEVEL = 'warn';
    expect(emitir()).toEqual(['evento_warn', 'evento_error']);
  });

  it('info (o padrão): tudo menos o debug', () => {
    delete process.env.LOG_LEVEL;
    expect(emitir()).toEqual(['evento_info', 'evento_warn', 'evento_error']);
  });

  it('debug: tudo', () => {
    process.env.LOG_LEVEL = 'debug';
    expect(emitir()).toEqual(['evento_debug', 'evento_info', 'evento_warn', 'evento_error']);
  });

  it('valor estranho não cala o log — cai em info', () => {
    process.env.LOG_LEVEL = 'verbose';
    expect(emitir()).toEqual(['evento_info', 'evento_warn', 'evento_error']);
  });

  it('cada linha diz o próprio nível, e o aviso vai para o stderr como o erro', () => {
    process.env.LOG_LEVEL = 'debug';
    const errSpy = vi.mocked(console.error);
    const warnSpy = vi.mocked(console.warn);
    emitir();
    const niveis = saida.map((l) => (JSON.parse(l) as { level: string }).level);
    expect(niveis).toEqual(['debug', 'info', 'warn', 'error']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
