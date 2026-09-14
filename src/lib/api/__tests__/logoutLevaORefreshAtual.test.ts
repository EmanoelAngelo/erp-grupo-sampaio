/**
 * ============================================================================
 * O CORPO DO LOGOUT LEVA O REFRESH DE AGORA, E O 401 NÃO QUEIMA OUTRA
 * RENOVAÇÃO NEM CRUZA DE OPERAÇÃO (RES-SESSAO)
 * ============================================================================
 *
 * `logout()` montava `{refreshToken: R1}` ANTES de chamar. Com o access vencido
 * (mais de uma hora parado), `apiRequest` recebia 401, renovava — R1 vira R2 —
 * e repetia o logout com o token novo e o corpo VELHO: o servidor revogava R1,
 * que a rotação já tinha matado, e R2 ficava vivo por até sete dias.
 *
 * E como o servidor passa a encerrar o access anterior na rotação e na troca
 * de operação, o 401 de uma requisição que estava no ar quando OUTRA chamada
 * renovou ou trocou de operação não pode mais ser tratado como "meu token
 * venceu": renovar de novo queimaria a sessão que acabou de nascer, e repetir
 * depois de uma troca de operação mandaria a requisição da operação A para a
 * operação B.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiRequest, getSession, logout, setSession, type StoredSession } from '../client';

function token(companyId: string, marca: string): string {
  const corpo = btoa(JSON.stringify({ sub: 'u-1', companyId, marca }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${corpo}.assinatura`;
}

const T1 = token('c-1', 'velho');
const T2 = token('c-1', 'novo');
const TB = token('c-2', 'outra-operacao');

function sessao(accessToken: string, refreshToken: string, companyId = 'c-1'): StoredSession {
  const empresa = { id: companyId, slug: companyId, tradeName: companyId, kind: 'retail' };
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() - 1000,
    user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'gerente_loja' },
    company: empresa,
    companies: [
      { id: 'c-1', slug: 'c-1', tradeName: 'c-1', kind: 'retail', profileCode: 'gerente_loja' },
      { id: 'c-2', slug: 'c-2', tradeName: 'c-2', kind: 'retail', profileCode: 'gerente_loja' },
    ],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const VENCIDO = () => json(401, { error: { code: 'API_SESSION_ENDED', message: 'Sessão encerrada.' } });

type Chamada = { caminho: string; token: string; corpo: unknown };

function servidor(rotas: (c: Chamada) => Response | Promise<Response>): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const chamada: Chamada = {
        caminho: new URL(url).pathname.replace(/^\/api\/v1/, ''),
        token: (init?.headers?.Authorization ?? '').replace(/^Bearer /, ''),
        corpo: init?.body ? JSON.parse(init.body) : undefined,
      };
      chamadas.push(chamada);
      return rotas(chamada);
    }),
  );
  return chamadas;
}

beforeEach(() => {
  localStorage.clear();
  setSession(sessao(T1, 'R1'), 'LOGIN', 'teste-logout');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  setSession(null, 'LOGOUT', 'teste-logout');
});

describe('o corpo do logout é lido na hora de enviar', () => {
  it('access vencido: o logout renova, e a repetição leva o refresh NOVO (R2), não o R1 de antes', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 });
      if (c.caminho === '/auth/logout') return c.token === T1 ? VENCIDO() : new Response(null, { status: 204 });
      return json(404, {});
    });

    await logout();

    const saidas = chamadas.filter((c) => c.caminho === '/auth/logout');
    expect(saidas).toHaveLength(2);
    expect(saidas[0]).toMatchObject({ token: T1, corpo: { refreshToken: 'R1' } });
    // Antes: { refreshToken: 'R1' } — e o R2 ficava vivo por sete dias.
    expect(saidas[1]).toMatchObject({ token: T2, corpo: { refreshToken: 'R2' } });
    expect(getSession()).toBeNull();
  });
});

describe('o 401 de uma requisição que estava no ar quando a sessão mudou', () => {
  it('outra chamada já renovou (mesma operação): repete com o token de agora, sem queimar outra renovação', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return json(200, { accessToken: token('c-1', 'terceiro'), refreshToken: 'R3', expiresIn: 3600 });
      if (c.token === T1) {
        // Enquanto esta estava no ar, outra chamada renovou a sessão.
        setSession(sessao(T2, 'R2'), 'TOKEN_REFRESH', 'teste-renovacao-concorrente');
        return VENCIDO();
      }
      return json(200, { ok: true, token: c.token });
    });

    const res = await apiRequest<{ ok: boolean; token: string }>('/core/pdv/produtos');

    expect(res).toEqual({ ok: true, token: T2 });
    expect(chamadas.map((c) => c.caminho)).not.toContain('/auth/refresh');
    expect(getSession()?.refreshToken).toBe('R2');
  });

  it('a operação mudou enquanto a requisição estava no ar: NÃO repete na operação nova', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return json(200, { accessToken: token('c-2', 'renovado'), refreshToken: 'RB2', expiresIn: 3600 });
      if (c.token === T1) {
        setSession(sessao(TB, 'RB', 'c-2'), 'EXPLICIT_OPERATION_CHANGE', 'teste-troca-concorrente');
        return VENCIDO();
      }
      return json(201, { gravadaEm: c.token });
    });

    const erro = await apiRequest('/core/sales', { method: 'POST', body: { itens: [] }, idempotencyKey: 'k-1' }).catch(
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ApiRequestError);
    expect((erro as ApiRequestError).code).toBe('API_SESSION_SCOPE_CHANGED');
    const vendas = chamadas.filter((c) => c.caminho === '/core/sales');
    expect(vendas).toHaveLength(1);
    expect(vendas[0].token).toBe(T1);
    expect(chamadas.map((c) => c.caminho)).not.toContain('/auth/refresh');
    // A sessão nova, da operação escolhida, fica intacta.
    expect(getSession()?.company.id).toBe('c-2');
  });
});
