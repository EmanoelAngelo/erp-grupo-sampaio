/**
 * ============================================================================
 * QUANDO É O SERVIDOR QUE DIZ "SENHA PROVISÓRIA" — GAP-PRD-202, lado da tela
 * ============================================================================
 *
 * A API passou a recusar, com 403 `API_PASSWORD_CHANGE_REQUIRED`, toda rota
 * que não seja a da etapa de troca quando o token veio da senha provisória. A
 * tela já guardava a bandeira do login; o que estes casos cobram é o outro
 * caminho — a sessão guardada SEM a bandeira (perdida, ou de antes do
 * contrato) e o servidor dizendo que é provisória:
 *
 *  - o cliente marca `mustChangePassword` na sessão guardada;
 *  - o guarda de rota, que acompanha a sessão, tira a pessoa do conteúdo e a
 *    leva para a porta, que abre na etapa de troca — sem esperar um F5.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Protected } from '../Protected';
import { ApiRequestError, apiRequest, getSession, setSession, type StoredSession } from '@/lib/api/client';

function sessaoSemBandeira(): StoredSession {
  return {
    accessToken: 'sem-escopo',
    refreshToken: 'r-1',
    expiresAt: Date.now() + 3_600_000,
    user: { id: 'u-1', login: 'GERENTE.NOVO', displayName: 'Gerente Novo', profileCode: 'gerente_loja' },
    company: { id: 'preco-justo', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
    companies: [
      { id: 'preco-justo', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'gerente_loja' },
    ],
  };
}

function servidorRecusaPorSenhaProvisoria() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'API_PASSWORD_CHANGE_REQUIRED',
              message: 'Esta sessão entrou com a senha provisória definida pela gestão.',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste da recusa do servidor');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o 403 API_PASSWORD_CHANGE_REQUIRED', () => {
  it('chega à tela como erro nomeado E marca a sessão guardada como provisória', async () => {
    setSession(sessaoSemBandeira(), 'LOGIN', 'teste: sessão sem bandeira');
    servidorRecusaPorSenhaProvisoria();

    const erro = await apiRequest('/core/products').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiRequestError);
    expect((erro as ApiRequestError).code).toBe('API_PASSWORD_CHANGE_REQUIRED');
    expect(getSession()?.user.mustChangePassword).toBe(true);

    // E a marca persiste: um F5 restaura a sessão já com a bandeira.
    const guardada = JSON.parse(localStorage.getItem('gs.session') ?? '{}') as StoredSession;
    expect(guardada.user.mustChangePassword).toBe(true);
  });

  it('o guarda de rota tira a pessoa do conteúdo na hora e a leva para a porta', async () => {
    setSession(sessaoSemBandeira(), 'LOGIN', 'teste: sessão sem bandeira');
    servidorRecusaPorSenhaProvisoria();

    render(
      <MemoryRouter initialEntries={['/sistema/produtos']}>
        <Routes>
          <Route
            path="/sistema/produtos"
            element={
              <Protected environments={['gestao']}>
                <p>CONTEUDO</p>
              </Protected>
            }
          />
          <Route path="/login" element={<p>PORTA DA GESTAO</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('CONTEUDO')).toBeTruthy();

    await act(async () => {
      await apiRequest('/core/products').catch(() => undefined);
    });

    expect(screen.queryByText('CONTEUDO')).toBeNull();
    expect(screen.getByText('PORTA DA GESTAO')).toBeTruthy();
  });

  it('outro 403 qualquer não marca nada — permissão negada não é senha provisória', async () => {
    setSession(sessaoSemBandeira(), 'LOGIN', 'teste: sessão sem bandeira');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await apiRequest('/core/audit').catch(() => undefined);
    expect(getSession()?.user.mustChangePassword).toBeUndefined();
  });
});
