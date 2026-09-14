/**
 * A TELA DE LOGIN NÃO TEM SONDA NEM PAINEL DE ENTRADA SEM SENHA — com flag de
 * build ou sem ela, com o servidor respondendo ou não.
 *
 * Este arquivo cobrava que a sonda do atalho de desenvolvimento só saísse com
 * `VITE_DEV_QUICK_LOGIN=true` no build (GAP-PRD-206). O atalho saiu por
 * inteiro: o servidor não tem mais a rota, o cliente não tem mais as funções,
 * e a tela não tem mais o painel vermelho com os botões dos usuários do banco.
 *
 * O que se cobra agora é a ausência, no pior cenário: a flag antiga ligada no
 * build E um servidor que responde a lista como respondia. A tela não pergunta
 * e não mostra nada — só o login normal.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as cliente from '@/lib/api/client';
import LoginPage from '@/pages/gs/LoginPage';

const USUARIO_DO_BANCO = {
  id: 'u1',
  login: 'ADMIN',
  display_name: 'Administrador Grupo Sampaio',
  company_id: 'c1',
  profile_code: 'admin_geral',
  trade_name: 'Loja Um',
  kind: 'retail',
};

/** Um servidor que ainda responderia a lista e a entrada — como o antigo. */
function servidorQueAindaResponde() {
  const f = vi.fn(async (url: string | URL | Request) => {
    const alvo = String(url);
    if (alvo.includes('/auth/quick-login/users')) {
      return new Response(JSON.stringify({ users: [USUARIO_DO_BANCO] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'API_NOT_FOUND', message: 'x' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o cliente não tem mais a porta sem senha', () => {
  it('nem a sonda, nem a entrada, nem a leitura da flag de build', () => {
    const nomes = Object.keys(cliente);
    for (const nome of ['listQuickLoginUsers', 'quickLogin', 'atalhoDeDesenvolvimentoNoBuild']) {
      expect(nomes, nome).not.toContain(nome);
    }
  });
});

describe('a tela de login, com o servidor respondendo a lista antiga', () => {
  for (const flag of ['', 'false', 'true']) {
    it(`VITE_DEV_QUICK_LOGIN=${JSON.stringify(flag)}: nenhuma pergunta ao servidor, nenhum painel, nenhum botão de usuário`, async () => {
      vi.stubEnv('VITE_DEV_QUICK_LOGIN', flag);
      const f = servidorQueAindaResponde();
      render(createElement(MemoryRouter, null, createElement(LoginPage)));
      // Tempo para qualquer efeito de montagem ir ao servidor e voltar.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      const perguntas = f.mock.calls.map(([url]) => String(url));
      expect(perguntas.filter((u) => u.includes('quick-login'))).toEqual([]);
      expect(screen.queryByText(/SEM SENHA/i)).toBeNull();
      expect(screen.queryByText(/Administrador Grupo Sampaio/)).toBeNull();
      expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Entrar']);
    });
  }
});
