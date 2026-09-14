/**
 * AS PORTAS DE ENTRADA SÓ TÊM O LOGIN NORMAL — e não ensinam login de ninguém.
 *
 * Com o acesso sem senha removido, a tela de login da gestão e do PDV fica com
 * usuário + senha e, no PDV de um computador registrado, o botão do terminal
 * confiável (que não é anônimo: o token é emitido por um administrador e é
 * revogável).
 *
 * E os campos paravam de sugerir logins de demonstração: o placeholder dizia
 * 'CARLOSGERENTE', 'preco-justo.pdv' e 'ROBERTOMECANICO' — logins que existem
 * no banco de demonstração, escritos na porta de entrada para quem quisesse
 * tentar. Agora é texto neutro.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../LoginPage';
import OficinaLoginPage from '../OficinaLoginPage';

const LOGINS_DE_DEMONSTRACAO = ['CARLOSGERENTE', 'preco-justo.pdv', 'ROBERTOMECANICO'];

function servidorDesligado() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'API_NOT_FOUND', message: 'x' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

async function assentar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const campoUsuario = () => screen.getByLabelText(/^Usuário\s*\*?$/) as HTMLInputElement;
const botoes = () => screen.getAllByRole('button').map((b) => b.textContent?.trim());

beforeEach(() => {
  localStorage.clear();
  servidorDesligado();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a porta da gestão e do PDV', () => {
  it('só tem o login normal: usuário, senha e "Entrar"', async () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await assentar();
    expect(campoUsuario()).toBeTruthy();
    expect(screen.getByLabelText(/^Senha\s*\*?$/)).toBeTruthy();
    expect(botoes()).toEqual(['Entrar']);
  });

  it('o placeholder é neutro nas duas abas — nenhum login de demonstração na porta', async () => {
    const { container } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await assentar();
    expect(campoUsuario().placeholder).toBe('seu login');
    fireEvent.click(screen.getByRole('tab', { name: 'PDV' }));
    expect(campoUsuario().placeholder).toBe('seu login');
    for (const login of LOGINS_DE_DEMONSTRACAO) expect(container.innerHTML).not.toContain(login);
  });

  it('o terminal registrado continua com o botão dele, na aba do PDV', async () => {
    localStorage.setItem('gs.deviceToken', 'token-de-terminal-de-teste');
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await assentar();
    fireEvent.click(screen.getByRole('tab', { name: 'PDV' }));
    expect(botoes()).toEqual(['Entrar', 'Entrar no PDV deste terminal']);
  });
});

describe('a porta da bancada', () => {
  it('o placeholder é neutro — nenhum login de mecânico na porta', async () => {
    const { container } = render(
      <MemoryRouter>
        <OficinaLoginPage />
      </MemoryRouter>,
    );
    await assentar();
    expect(campoUsuario().placeholder).toBe('seu login');
    for (const login of LOGINS_DE_DEMONSTRACAO) expect(container.innerHTML).not.toContain(login);
  });
});
