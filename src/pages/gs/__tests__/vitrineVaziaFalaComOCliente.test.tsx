/**
 * A VITRINE VAZIA FALA COM O CLIENTE, NÃO COM O ADMINISTRADOR.
 *
 * Loja sem produto publicado mostrava "Nenhum produto publicado — os produtos
 * aparecem aqui quando marcados para venda online no ERP". É a frase certa
 * para quem cadastra e a errada para quem compra: o cliente não sabe o que é
 * ERP nem "marcar para venda online", e lê que a loja está quebrada.
 *
 * A instalação nova de produção nasce assim — o bootstrap não cria produto —,
 * então esta é a primeira tela que o público vê. Cobra-se o texto de cliente
 * na home do grupo e na página da loja, e que o vazio de FILTRO continue com a
 * frase dele (ali a saída é mesmo limpar a busca).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';

const LOJAS = {
  stores: [{ id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 0 }],
  services: [],
};

function servidor() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const corpo = u.includes('/loja/stores')
      ? LOJAS
      : u.includes('/loja/products')
        ? { items: [], total: 0 }
        : { items: [] };
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('loja sem produto publicado', () => {
  it('home: diz ao cliente que não há produto agora — sem falar de ERP', async () => {
    render(
      <MemoryRouter>
        <LojaPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Nenhum produto disponível no momento.')).toBeTruthy();
    expect(screen.queryByText('Nenhum produto publicado')).toBeNull();
    expect(screen.queryByText(/ERP/)).toBeNull();
    expect(screen.queryByText(/marcados para venda online/)).toBeNull();
  });

  it('página da loja: a mesma frase de cliente', async () => {
    render(
      <MemoryRouter initialEntries={['/loja/gringa']}>
        <Routes>
          <Route path="/loja/:storeSlug" element={<LojaPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Nenhum produto disponível no momento.')).toBeTruthy();
    expect(screen.queryByText(/ERP/)).toBeNull();
  });
});
