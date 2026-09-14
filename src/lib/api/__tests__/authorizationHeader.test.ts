/**
 * O token vai no header. Parece óbvio; não era.
 *
 * O DEFEITO QUE ORIGINOU ESTE ARQUIVO
 *
 * `apiRequest` montava o header como `Bearer ` — a interpolação do token tinha
 * sumido. O efeito foi mudo do jeito mais caro possível:
 *
 *   - toda requisição autenticada saía com portador VAZIO;
 *   - a API respondia 401 em tudo;
 *   - a tela mostrava "Autenticação obrigatória" com a pessoa logada, nome no
 *     topo e token válido no `localStorage`.
 *
 * Ou seja: NENHUMA tela do ERP carregava dado. E a suíte estava verde, porque
 * nada cobria o header — os testes de tela mockam `fetch` e nunca olharam o
 * que ia dentro. Só apareceu ao abrir a oficina no navegador.
 *
 * Por isso este arquivo cobra o CONTEÚDO do header, não a presença dele.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, setSession, type StoredSession } from '../client';

const TOKEN = 'token-de-acesso-do-teste';

function sessao(): StoredSession {
  return {
    accessToken: TOKEN,
    refreshToken: 'refresh-do-teste',
    user: { id: 'u-1', name: 'Fulano', login: 'fulano', profileCode: 'gestor' },
    company: { id: 'c-1', slug: 'gringa', tradeName: 'Gringa' },
    companies: [],
  } as unknown as StoredSession;
}

/** Guarda os headers de cada chamada para inspeção. */
function servidor() {
  const chamadas: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { headers?: Record<string, string> }) => {
      chamadas.push({ url: String(url), headers: init?.headers ?? {} });
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Authorization', () => {
  it('leva o token INTEIRO, não só a palavra Bearer', () => {
    setSession(sessao(), 'LOGIN', 'teste-authorization');
    const chamadas = servidor();

    void apiRequest('/core/workshop/orders');

    const auth = chamadas[0].headers.Authorization;
    expect(auth).toBe(`Bearer ${TOKEN}`);
    // A asserção que faltava: `Bearer ` sozinho passaria em qualquer teste que
    // só verificasse a existência do header.
    expect(auth).not.toBe('Bearer ');
    expect(auth).toContain(TOKEN);
  });

  it('requisição anônima NÃO manda header de autorização', () => {
    setSession(sessao(), 'LOGIN', 'teste-authorization');
    const chamadas = servidor();

    void apiRequest('/loja/products', { anonymous: true });

    expect(chamadas[0].headers.Authorization).toBeUndefined();
  });

  it('sem sessão, não inventa portador vazio', () => {
    setSession(null, 'LOGOUT', 'teste-authorization');
    const chamadas = servidor();

    void apiRequest('/core/workshop/orders');

    // Nem `Bearer `, nem `Bearer null`: header nenhum.
    expect(chamadas[0].headers.Authorization).toBeUndefined();
  });

  it('headers próprios da chamada convivem com o token', () => {
    setSession(sessao(), 'LOGIN', 'teste-authorization');
    const chamadas = servidor();

    void apiRequest('/core/orders', { headers: { 'X-Alguma-Coisa': 'valor' } });

    expect(chamadas[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(chamadas[0].headers['X-Alguma-Coisa']).toBe('valor');
  });
});
