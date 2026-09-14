/**
 * ============================================================================
 * O PERFIL QUE A TELA MOSTRA ACOMPANHA O PERFIL QUE O SERVIDOR USA (GAP-PRD-053)
 * ============================================================================
 *
 * A API passou a conferir a conta a cada requisição e a usar o perfil do
 * vínculo DE AGORA. Quando ele difere do que o token carrega (a gestão
 * rebaixou ou promoveu a pessoa), a resposta traz `X-Perfil-Em-Vigor`.
 *
 * A tela monta o menu com o perfil guardado na sessão. Sem acompanhar o aviso,
 * o gerente rebaixado veria o menu de gerente e levaria 403 em cada clique, e
 * o atendente promovido não veria o que passou a alcançar até entrar de novo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, getSession, setSession, subscribeSession, type StoredSession } from '../client';

function token(companyId: string): string {
  const corpo = btoa(JSON.stringify({ sub: 'u-1', companyId, profileCodes: ['gerente_loja'] }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${corpo}.assinatura`;
}

function sessao(): StoredSession {
  return {
    accessToken: token('c-1'),
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3600_000,
    user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
    company: { id: 'c-1', slug: 'gringa', tradeName: 'Gringa', kind: 'retail' },
    companies: [
      { id: 'c-1', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', profileCode: 'gerente_loja' },
      { id: 'c-2', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail', profileCode: 'estoquista' },
    ],
  };
}

function responder(status: number, cabecalhos: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(status < 400 ? { items: [] } : { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } }), {
        status,
        headers: { 'Content-Type': 'application/json', ...cabecalhos },
      }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  setSession(sessao(), 'LOGIN', 'teste-perfil-em-vigor');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('X-Perfil-Em-Vigor', () => {
  it('rebaixado: a sessão guardada passa a dizer o perfil de agora — e quem ouve a sessão é avisado', async () => {
    const ouvidos: (string | undefined)[] = [];
    const parar = subscribeSession((s) => ouvidos.push(s?.user.profileCode));
    responder(403, { 'X-Perfil-Em-Vigor': 'atendente' });

    await apiRequest('/core/fiscal/closings/2026-08/previa').catch(() => undefined);
    parar();

    expect(getSession()?.user.profileCode).toBe('atendente');
    // O vínculo DESTA operação muda; o da outra operação fica como estava.
    expect(getSession()?.companies.map((c) => c.profileCode)).toEqual(['atendente', 'estoquista']);
    // A operação não muda: o aviso é só do perfil.
    expect(getSession()?.company.id).toBe('c-1');
    expect(ouvidos).toContain('atendente');
  });

  it('promovido: vale também numa resposta de sucesso', async () => {
    setSession({ ...sessao(), user: { ...sessao().user, profileCode: 'atendente' } }, 'LOGIN', 'teste');
    responder(200, { 'X-Perfil-Em-Vigor': 'gerente_loja' });
    await apiRequest('/core/products');
    expect(getSession()?.user.profileCode).toBe('gerente_loja');
  });

  it('sem o cabeçalho, nada muda', async () => {
    responder(200);
    await apiRequest('/core/products');
    expect(getSession()?.user.profileCode).toBe('gerente_loja');
  });

  it('requisição anônima (vitrine, login) não mexe na sessão administrativa', async () => {
    responder(200, { 'X-Perfil-Em-Vigor': 'atendente' });
    await apiRequest('/loja/products', { anonymous: true });
    expect(getSession()?.user.profileCode).toBe('gerente_loja');
  });
});
