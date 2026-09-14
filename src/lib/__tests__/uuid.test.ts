/**
 * Regressão: o ERP é acessado pelos PDVs através do IP da rede, em HTTP puro.
 * Esse contexto NÃO é seguro, e ali `crypto.randomUUID` não existe — o PDV e a
 * loja quebravam inteiros com "crypto.randomUUID is not a function".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from '../uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uuid', () => {
  it('usa crypto.randomUUID quando disponível', () => {
    const spy = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID: spy, getRandomValues: globalThis.crypto.getRandomValues });
    expect(uuid()).toBe('11111111-2222-4333-8444-555555555555');
    expect(spy).toHaveBeenCalled();
  });

  it('funciona sem randomUUID — o caso do PDV em HTTP na rede', () => {
    // Só getRandomValues, que existe também fora de contexto seguro.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 37 + 11) % 256;
        return arr;
      },
    });
    const value = uuid();
    expect(value).toMatch(UUID_V4);
  });

  it('não quebra sem Web Crypto algum', () => {
    vi.stubGlobal('crypto', undefined);
    expect(uuid()).toMatch(UUID_V4);
  });

  it('não repete valores', () => {
    const gerados = new Set(Array.from({ length: 500 }, () => uuid()));
    expect(gerados.size).toBe(500);
  });
});
