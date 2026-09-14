/**
 * ============================================================================
 * SERVIDOR OCUPADO NÃO É SENHA ERRADA — A RENOVAÇÃO QUE FALHA NÃO DESLOGA
 * (GAP-PRD-055)
 * ============================================================================
 *
 * Qualquer `!res.ok` do `/auth/refresh` apagava a sessão local e mandava o
 * caixa para o login. Atrás de um proxy reverso sem `DEVORA_TRUST_PROXY`, as
 * seis operações dividem o balde de 300 requisições por minuto — e um 429 na
 * renovação (ou um 502 do proxy durante um reinício da API) derrubava a venda
 * que estava no meio.
 *
 * Só a RECUSA da credencial (400/401/403: refresh vencido, revogado, conta
 * desligada) apaga a sessão. 429, 5xx, rede e resposta que não é JSON deixam a
 * sessão onde está, e a tela recebe um erro que diz a verdade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiRequest, getSession, setSession, type StoredSession } from '../client';

/** Um JWT de mentira, legível pelo `scopeFromToken` — só o corpo importa aqui. */
function token(companyId: string, marca: string): string {
  const corpo = btoa(JSON.stringify({ sub: 'u-1', companyId, marca }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${corpo}.assinatura`;
}

function sessao(): StoredSession {
  return {
    accessToken: token('c-1', 'velho'),
    refreshToken: 'refresh-vivo',
    expiresAt: Date.now() - 1000,
    user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'operador_caixa_loja' },
    company: { id: 'c-1', slug: 'gringa', tradeName: 'Gringa', kind: 'retail' },
    companies: [{ id: 'c-1', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', profileCode: 'operador_caixa_loja' }],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Servidor dublado: a rota da tela responde 401 com o token velho e 200 com o
 * novo; o `/auth/refresh` responde o que o caso mandar.
 */
function servidor(respostaDoRefresh: () => Response | Promise<Response>) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const caminho = new URL(url).pathname.replace(/^\/api\/v1/, '');
      chamadas.push(caminho);
      if (caminho === '/auth/refresh') return respostaDoRefresh();
      const auth = init?.headers?.Authorization ?? '';
      if (auth.includes(token('c-1', 'velho'))) {
        return json(401, { error: { code: 'API_INVALID_TOKEN', message: 'Token inválido.' } });
      }
      return json(200, { items: ['ok'] });
    }),
  );
  return chamadas;
}

beforeEach(() => {
  localStorage.clear();
  setSession(sessao(), 'LOGIN', 'teste-renovacao');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a renovação que o servidor não pôde atender', () => {
  it('429 no refresh: a sessão FICA, e o erro diz que é o servidor ocupado', async () => {
    servidor(() => json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }));

    const erro = await apiRequest('/core/pdv/produtos').catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiRequestError);
    expect((erro as ApiRequestError).code).toBe('API_SESSION_REFRESH_UNAVAILABLE');
    expect((erro as ApiRequestError).status).toBe(429);
    expect((erro as ApiRequestError).message).toMatch(/continua conectado/);
    // O ponto do caso: ninguém foi mandado para o login.
    expect(getSession()?.refreshToken).toBe('refresh-vivo');
  });

  it('502 do proxy durante o reinício da API: a sessão fica', async () => {
    servidor(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const erro = await apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    expect((erro as ApiRequestError).code).toBe('API_SESSION_REFRESH_UNAVAILABLE');
    expect(getSession()).not.toBeNull();
  });

  it('rede fora no refresh: a sessão fica', async () => {
    servidor(() => {
      throw new TypeError('Failed to fetch');
    });
    const erro = await apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    expect((erro as ApiRequestError).code).toBe('API_SESSION_REFRESH_UNAVAILABLE');
    expect((erro as ApiRequestError).status).toBe(0);
    expect(getSession()).not.toBeNull();
  });

  it('200 com página HTML (o proxy respondendo no lugar da API): a sessão fica', async () => {
    servidor(() => new Response('<html>manutenção</html>', { status: 200 }));
    const erro = await apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    expect((erro as ApiRequestError).code).toBe('API_SESSION_REFRESH_UNAVAILABLE');
    expect(getSession()?.accessToken).toBe(token('c-1', 'velho'));
  });

  it('e quando o servidor volta, a próxima requisição renova e segue', async () => {
    let ocupado = true;
    servidor(() =>
      ocupado
        ? json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } })
        : json(200, { accessToken: token('c-1', 'novo'), refreshToken: 'refresh-novo', expiresIn: 3600 }),
    );

    await apiRequest('/core/pdv/produtos').catch(() => undefined);
    ocupado = false;

    const corpo = await apiRequest<{ items: string[] }>('/core/pdv/produtos');
    expect(corpo.items).toEqual(['ok']);
    expect(getSession()?.refreshToken).toBe('refresh-novo');
  });
});

describe('a renovação que o servidor RECUSOU', () => {
  it('401 no refresh: aí sim a sessão é apagada (credencial vencida, revogada ou conta desligada)', async () => {
    servidor(() => json(401, { error: { code: 'API_INVALID_TOKEN', message: 'Refresh token inválido.' } }));
    const erro = await apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    expect((erro as ApiRequestError).status).toBe(401);
    expect(getSession()).toBeNull();
  });

  it('403 no refresh também apaga', async () => {
    servidor(() => json(403, { error: { code: 'API_TENANT_MISMATCH', message: 'Empresa não autorizada.' } }));
    await apiRequest('/core/pdv/produtos').catch(() => undefined);
    expect(getSession()).toBeNull();
  });

  it('refresh que dá certo segue exatamente como antes: repete a requisição com o token novo', async () => {
    const chamadas = servidor(() =>
      json(200, { accessToken: token('c-1', 'novo'), refreshToken: 'refresh-novo', expiresIn: 3600 }),
    );
    const corpo = await apiRequest<{ items: string[] }>('/core/pdv/produtos');
    expect(corpo.items).toEqual(['ok']);
    expect(chamadas).toEqual(['/core/pdv/produtos', '/auth/refresh', '/core/pdv/produtos']);
  });
});
