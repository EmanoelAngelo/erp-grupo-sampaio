/**
 * A CASCA DA LOJA — a porta que faltava para a conta do cliente.
 *
 * O portal existia inteiro (pedidos, endereços, equipamentos) e não tinha um
 * único link a partir da loja. Busca por `minha-conta` em `src/`: 8 hits, todos
 * de dentro do próprio portal. Estes casos existem para que a porta não suma de
 * novo: a casca SEMPRE oferece um caminho para a conta, e ele muda conforme a
 * pessoa está logada.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CascaDaLoja } from '../CascaDaLoja';
import { guardarSessaoPortal } from '@/lib/portalSession';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function montar(direita?: React.ReactNode) {
  render(
    <MemoryRouter>
      <CascaDaLoja direita={direita}>
        <p>conteúdo da página</p>
      </CascaDaLoja>
    </MemoryRouter>,
  );
}

describe('deslogado', () => {
  it('oferece "Entre ou cadastre-se" apontando para a conta', () => {
    montar();
    const entrar = screen.getByRole('link', { name: /entre ou cadastre-se/i });
    expect(entrar.getAttribute('href')).toBe('/minha-conta');
  });

  it('a marca leva de volta à vitrine', () => {
    montar();
    const marca = screen.getByRole('link', { name: /grupo sampaio/i });
    expect(marca.getAttribute('href')).toBe('/loja');
  });

  it('o rodapé também tem um caminho para a conta, e não cita a Oficina', () => {
    montar();
    const naConta = screen.getByRole('link', { name: /minha conta e meus pedidos/i });
    expect(naConta.getAttribute('href')).toBe('/minha-conta');
    // A Oficina não entra no e-commerce (decisão do dono).
    expect(document.body.textContent).not.toMatch(/oficina/i);
  });

  it('mostra o que a página pôs à direita — o carrinho vem por prop', () => {
    montar(<button type="button">Carrinho (2)</button>);
    expect(screen.getByRole('button', { name: /carrinho \(2\)/i })).toBeTruthy();
  });
});

describe('logado', () => {
  function entrar() {
    guardarSessaoPortal({
      token: 't-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: { id: 'a-1', email: 'ana@exemplo.com' },
    });
  }

  it('troca "Entre" por "Olá, {e-mail}" e some com o cadastro', () => {
    entrar();
    montar();
    expect(screen.getByText(/olá, ana@exemplo.com/i)).toBeTruthy();
    expect(screen.queryByText(/entre ou cadastre-se/i)).toBeNull();
  });

  it('reage ao login que acontece DEPOIS de montada, sem recarregar', () => {
    montar();
    expect(screen.getByText(/entre ou cadastre-se/i)).toBeTruthy();
    // O login numa tela filha grava a sessão; a casca ouve o evento. O `act`
    // envolve a atualização de estado que o evento dispara.
    act(() => entrar());
    expect(screen.getByText(/olá, ana@exemplo.com/i)).toBeTruthy();
  });

  it('o botão Sair apaga a sessão e volta a oferecer entrar', () => {
    entrar();
    montar();
    fireEvent.click(screen.getByRole('button', { name: /sair/i }));
    expect(screen.getByText(/entre ou cadastre-se/i)).toBeTruthy();
  });
});
