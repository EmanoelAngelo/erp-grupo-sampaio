/**
 * GAP-PRD-193, na tela: o carrinho de quem entrou mora na CONTA, o login
 * funde o carrinho do aparelho, "Sair" leva a cópia embora, e a sessão
 * acompanha quem está usando a loja.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';
import ProdutoLojaPage from '../ProdutoLojaPage';

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

const PRODUTO = (id: string, name: string, priceCents = 10000) => ({
  id,
  name,
  description: null,
  category: null,
  brand: null,
  imageUrl: null,
  basePriceCents: priceCents,
  priceCents,
  onSale: false,
  available: 5,
  storeSlug: 'gringa',
  storeName: 'Gringa',
});
const JAQUETA = PRODUTO('p-jaq', 'Jaqueta');
const BOTA = PRODUTO('p-bota', 'Bota', 20000);

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(rotas: (c: Chamada) => Response | undefined) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const c: Chamada = {
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      chamadas.push(c);
      const r = rotas(c);
      if (r) return r;
      if (c.url.includes('/loja/stores')) {
        return json({ stores: [{ id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 2 }], services: [] });
      }
      if (c.url.includes('/loja/products')) return json({ total: 2, items: [JAQUETA, BOTA] });
      if (c.url.includes('/loja/checkout/frete')) return json({ lojas: [], itens: [] });
      return json({ items: [] });
    }),
  );
  return chamadas;
}

const EXPIRA = new Date(Date.now() + 30 * 60_000).toISOString();

function entrar(accountId = 'acc-ana') {
  localStorage.setItem(
    'gs.portal',
    JSON.stringify({
      token: 'tok-da-ana',
      expiresAt: EXPIRA,
      account: { id: accountId, email: 'ana@exemplo.com', emailVerifiedAt: '2026-09-01T00:00:00Z' },
    }),
  );
}

function carrinhoLocal(linhas: { product: unknown; quantity: number }[], dono?: string) {
  localStorage.setItem('gs.loja.carrinho', JSON.stringify(linhas));
  if (dono) localStorage.setItem('gs.loja.carrinho.conta', dono);
}

function montarLoja() {
  render(
    <MemoryRouter initialEntries={['/gringa']}>
      <LojaPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('GAP-PRD-193 — o carrinho mora na conta', () => {
  it('entrar FUNDE o carrinho do aparelho com o da conta, e a tela mostra o fundido', async () => {
    entrar();
    carrinhoLocal([{ product: JAQUETA, quantity: 1 }]);
    const chamadas = servidor((c) =>
      c.url.endsWith('/loja/portal/carrinho/mesclar')
        ? json({
          items: [
            { productId: 'p-jaq', quantity: 1, product: JAQUETA },
            { productId: 'p-bota', quantity: 2, product: BOTA },
          ],
          descartados: [],
          updatedAt: null,
        })
        : undefined,
    );
    montarLoja();

    await waitFor(() =>
      expect(chamadas.some((c) => c.url.endsWith('/loja/portal/carrinho/mesclar'))).toBe(true),
    );
    const mescla = chamadas.find((c) => c.url.endsWith('/loja/portal/carrinho/mesclar'))!;
    expect(mescla.body).toEqual({ items: [{ productId: 'p-jaq', quantity: 1 }] });
    // O botão do carrinho conta os itens do carrinho fundido: 1 + 2.
    await waitFor(() => expect(screen.getByRole('button', { name: /Carrinho/ }).textContent).toContain('Carrinho (3)'));
    expect(localStorage.getItem('gs.loja.carrinho.conta')).toBe('acc-ana');
  });

  it('a cópia já é desta conta: o SERVIDOR é a verdade (lê, não funde)', async () => {
    entrar();
    carrinhoLocal([{ product: JAQUETA, quantity: 4 }], 'acc-ana');
    const chamadas = servidor((c) =>
      c.method === 'GET' && c.url.endsWith('/loja/portal/carrinho')
        ? json({ items: [{ productId: 'p-bota', quantity: 1, product: BOTA }], descartados: [], updatedAt: null })
        : undefined,
    );
    montarLoja();

    await waitFor(() => expect(screen.getByRole('button', { name: /Carrinho/ }).textContent).toContain('Carrinho (1)'));
    expect(chamadas.some((c) => c.url.endsWith('/carrinho/mesclar'))).toBe(false);
  });

  it('depois de carregado, mudar o carrinho manda a lista nova para a conta', async () => {
    entrar();
    const chamadas = servidor((c) =>
      c.url.includes('/loja/portal/carrinho')
        ? json({ items: c.body?.items ? [] : [], descartados: [], updatedAt: null })
        : undefined,
    );
    montarLoja();
    await screen.findByText('Jaqueta');
    await waitFor(() => expect(chamadas.some((c) => c.url.endsWith('/carrinho/mesclar'))).toBe(true));

    fireEvent.click(screen.getByText('Jaqueta').closest('li')!.querySelector('button')!);
    await waitFor(
      () => expect(chamadas.some((c) => c.method === 'PUT' && c.url.endsWith('/loja/portal/carrinho'))).toBe(true),
    );
    const envio = chamadas.find((c) => c.method === 'PUT' && c.url.endsWith('/loja/portal/carrinho'))!;
    expect(envio.body).toEqual({ items: [{ productId: 'p-jaq', quantity: 1 }] });
  });

  it('o que saiu da vitrine: a tela diz que o item saiu do carrinho', async () => {
    entrar();
    carrinhoLocal([{ product: JAQUETA, quantity: 1 }]);
    servidor((c) =>
      c.url.endsWith('/carrinho/mesclar')
        ? json({ items: [], descartados: [{ productId: 'p-jaq', motivo: 'indisponivel' }], updatedAt: null })
        : undefined,
    );
    montarLoja();
    await screen.findByText('Jaqueta');
    fireEvent.click(screen.getByRole('button', { name: /Carrinho/ }));
    expect(await screen.findByText(/Um item saiu do carrinho/)).toBeTruthy();
  });

  it('sem conta, nada vai ao servidor — o carrinho segue no navegador', async () => {
    carrinhoLocal([{ product: JAQUETA, quantity: 1 }]);
    const chamadas = servidor(() => undefined);
    montarLoja();
    await screen.findByText('Jaqueta');
    fireEvent.click(screen.getByText('Bota').closest('li')!.querySelector('button')!);
    await new Promise((r) => setTimeout(r, 600));
    expect(chamadas.some((c) => c.url.includes('/loja/portal/'))).toBe(false);
  });

  it('"Sair" encerra a sessão no servidor e leva embora a cópia do carrinho da conta', async () => {
    entrar();
    carrinhoLocal([{ product: JAQUETA, quantity: 1 }], 'acc-ana');
    const chamadas = servidor((c) =>
      c.method === 'GET' && c.url.endsWith('/loja/portal/carrinho')
        ? json({ items: [{ productId: 'p-jaq', quantity: 1, product: JAQUETA }], descartados: [], updatedAt: null })
        : undefined,
    );
    montarLoja();
    await waitFor(() => expect(screen.getByRole('button', { name: /Carrinho/ }).textContent).toContain('Carrinho (1)'));

    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    await waitFor(() => expect(chamadas.some((c) => c.url.endsWith('/loja/portal/sair'))).toBe(true));
    expect(localStorage.getItem('gs.portal')).toBeNull();
    expect(localStorage.getItem('gs.loja.carrinho.conta')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: /Carrinho/ }).textContent).toContain('Carrinho (0)'));
  });

  it('a página do produto, com conta, acrescenta também no carrinho da conta', async () => {
    entrar();
    const chamadas = servidor((c) =>
      c.url.includes('/loja/stores/gringa/products/p-jaq')
        ? json({ ...JAQUETA, unit: 'UN', images: [], variants: [], subcategory: null, shippingReadiness: 'READY_FOR_SHIPPING', missingShippingFields: [] })
        : undefined,
    );
    render(
      <MemoryRouter initialEntries={['/loja/gringa/produto/p-jaq']}>
        <Routes>
          <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar ao carrinho' }));
    await waitFor(() => expect(chamadas.some((c) => c.url.endsWith('/loja/portal/carrinho/itens'))).toBe(true));
    expect(chamadas.find((c) => c.url.endsWith('/carrinho/itens'))!.body).toEqual({ productId: 'p-jaq', quantity: 1 });
  });
});

describe('GAP-PRD-193 — a sessão acompanha quem usa a loja', () => {
  it('abrir a loja logado renova, e a sessão guardada ganha o vencimento novo', async () => {
    entrar();
    const novo = new Date(Date.now() + 60 * 60_000).toISOString();
    const chamadas = servidor((c) =>
      c.url.endsWith('/loja/portal/sessao') ? json({ expiresAt: novo, absoluteExpiresAt: novo }) : undefined,
    );
    montarLoja();
    await waitFor(() => expect(chamadas.some((c) => c.url.endsWith('/loja/portal/sessao'))).toBe(true));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('gs.portal')!).expiresAt).toBe(novo));
  });

  it('renovação recusada (401: saiu em outro aparelho) limpa a sessão', async () => {
    entrar();
    servidor((c) =>
      c.url.endsWith('/loja/portal/sessao')
        ? json({ error: { code: 'PORTAL_UNAUTHENTICATED', message: 'Entre na sua conta para continuar.' } }, 401)
        : undefined,
    );
    montarLoja();
    await waitFor(() => expect(localStorage.getItem('gs.portal')).toBeNull());
  });

  it('não renova a cada clique: no máximo uma vez a cada 5 minutos', async () => {
    entrar();
    const chamadas = servidor((c) =>
      c.url.endsWith('/loja/portal/sessao') ? json({ expiresAt: EXPIRA, absoluteExpiresAt: EXPIRA }) : undefined,
    );
    montarLoja();
    await screen.findByText('Jaqueta');
    for (let i = 0; i < 5; i += 1) fireEvent.pointerDown(document.body);
    expect(chamadas.filter((c) => c.url.endsWith('/loja/portal/sessao'))).toHaveLength(1);
  });
});
