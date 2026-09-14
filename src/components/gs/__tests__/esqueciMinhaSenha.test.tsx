/**
 * "ESQUECI MINHA SENHA" NA TELA DE ENTRADA — GAP-PRD-160.
 *
 * Só aparece quando o servidor diz que o caminho existe; os dois passos (pedir
 * o código, trocar a senha) chamam as rotas públicas certas; a confirmação que
 * não bate nem chega ao servidor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EsqueciMinhaSenha } from '../EsqueciMinhaSenha';

interface Chamada {
  metodo: string;
  caminho: string;
  corpo: unknown;
}

let chamadas: Chamada[] = [];

function servidor(disponivel: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const caminho = new URL(url).pathname.replace(/^\/api\/v1/, '');
      chamadas.push({ metodo, caminho, corpo: init?.body ? JSON.parse(init.body) : null });
      const responder = (status: number, corpo: unknown) =>
        new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
      if (caminho === '/auth/senha/recuperacao') return responder(200, { disponivel });
      if (caminho === '/auth/senha/esqueci') {
        return responder(202, { ok: true, mensagem: 'Se a conta tiver e-mail cadastrado, o código chega.' });
      }
      if (caminho === '/auth/senha/recuperar') return responder(200, { ok: true });
      return responder(404, { error: { code: 'NAO_DUBLADO', message: caminho } });
    }),
  );
}

beforeEach(() => {
  chamadas = [];
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a porta só aparece quando abre', () => {
  it('servidor diz que não há recuperação: nenhum link na tela', async () => {
    servidor(false);
    const { container } = render(<EsqueciMinhaSenha />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('servidor diz que há: o link aparece', async () => {
    servidor(true);
    render(<EsqueciMinhaSenha />);
    expect(await screen.findByRole('button', { name: 'Esqueci minha senha' })).toBeTruthy();
  });
});

describe('os dois passos', () => {
  it('pede o código pelo login e troca a senha com ele', async () => {
    servidor(true);
    render(<EsqueciMinhaSenha />);
    fireEvent.click(await screen.findByRole('button', { name: 'Esqueci minha senha' }));

    fireEvent.change(screen.getByLabelText('Login ou e-mail'), { target: { value: 'joao.caixa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código por e-mail' }));
    expect(await screen.findByText(/o código chega/)).toBeTruthy();
    expect(chamadas.find((c) => c.caminho === '/auth/senha/esqueci')?.corpo).toEqual({
      identificador: 'joao.caixa',
    });

    fireEvent.change(screen.getByLabelText(/Código recebido/), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('Senha nova'), { target: { value: 'Nova@Balcao2026' } });
    fireEvent.change(screen.getByLabelText('Confirme a senha nova'), {
      target: { value: 'Nova@Balcao2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(await screen.findByText(/Senha trocada/)).toBeTruthy();
    expect(chamadas.find((c) => c.caminho === '/auth/senha/recuperar')?.corpo).toEqual({
      identificador: 'joao.caixa',
      codigo: '12345678',
      novaSenha: 'Nova@Balcao2026',
    });
  });

  it('confirmação que não bate não chega ao servidor', async () => {
    servidor(true);
    render(<EsqueciMinhaSenha />);
    fireEvent.click(await screen.findByRole('button', { name: 'Esqueci minha senha' }));
    fireEvent.change(screen.getByLabelText('Login ou e-mail'), { target: { value: 'joao.caixa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código por e-mail' }));
    await screen.findByText(/o código chega/);

    fireEvent.change(screen.getByLabelText(/Código recebido/), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('Senha nova'), { target: { value: 'Nova@Balcao2026' } });
    fireEvent.change(screen.getByLabelText('Confirme a senha nova'), { target: { value: 'Outra@2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(chamadas.some((c) => c.caminho === '/auth/senha/recuperar')).toBe(false);
  });
});
