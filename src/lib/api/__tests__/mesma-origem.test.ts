/**
 * A TELA FALA COM A API NA MESMA ORIGEM (GAP-PRD-013).
 *
 * Na publicação de referência a própria API serve as telas
 * (`DEVORA_SERVIR_FRONTEND=true`) e o proxy HTTPS da frente encaminha tudo para
 * ela. O bundle é buildado com `VITE_API_BASE_URL=/` — o Dockerfile faz isso
 * por padrão — e aí toda chamada precisa ser RELATIVA à página: `/api/v1/...`,
 * sem host e sem porta.
 *
 * O caminho sem configuração (em branco) continua derivando `host:8787`, que é
 * o caso balcão/LAN; este arquivo não mexe nele.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiOrigin, apiRequest } from '../client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VITE_API_BASE_URL=/', () => {
  it('as chamadas saem relativas à página — /api/v1/..., sem host nem porta', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/');
    const chamadas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        chamadas.push(String(url));
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await apiRequest('/health');
    expect(chamadas).toEqual(['/api/v1/health']);
  });

  it('e as fotos (/uploads) também: a origem da API é a própria página', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/');
    expect(apiOrigin()).toBe('');
    expect(`${apiOrigin()}/uploads/produtos/a.webp`).toBe('/uploads/produtos/a.webp');
  });

  it('com domínio explícito, a barra final não duplica', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://erp.exemplo.com.br/');
    expect(apiOrigin()).toBe('https://erp.exemplo.com.br');
  });
});
