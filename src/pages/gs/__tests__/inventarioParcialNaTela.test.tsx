/**
 * INVENTÁRIO PARCIAL PELA TELA — o recorte que a rota aceitava e a UI não pedia.
 *
 * ============================================================================
 * O DEFEITO (GAP-V12)
 * ============================================================================
 *
 * `POST /core/inventory-counts` aceita recorte, mas a InventarioPage só
 * enviava `scopeNote`: TODA contagem aberta pela tela congelava o catálogo
 * ativo inteiro. Numa loja com milhares de SKUs a lista ficava impraticável e
 * o acerto avulso, lento.
 *
 * O conserto expõe o recorte na abertura (categoria e/ou busca) e dá um
 * filtro à tabela de itens — filtro de TELA, que não muda a contagem: os itens
 * continuam todos lá, só a rolagem encurta.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import InventarioPage from '../InventarioPage';

const DETALHE = {
  id: 'c-1',
  number: 9,
  status: 'aberta',
  scope_note: 'Bebidas',
  opened_at: '2026-08-25T09:00:00.000Z',
  applied_at: null,
  apply_reason: null,
  cancel_reason: null,
  items: [
    {
      id: 'i-1',
      product_id: 'p-1',
      name: 'Refrigerante Cola 2L',
      internal_code: 'REF-01',
      barcode: null,
      expected_quantity: 10,
      counted_quantity: null,
      counted_by_name: null,
    },
    {
      id: 'i-2',
      product_id: 'p-2',
      name: 'Água mineral 500ml',
      internal_code: 'AGU-01',
      barcode: null,
      expected_quantity: 24,
      counted_quantity: null,
      counted_by_name: null,
    },
  ],
  resumo: { total: 2, contados: 0, pendentes: 2, divergentes: 0, sobra: 0, falta: 0 },
};

const TAXONOMIA = {
  categories: [
    { id: 'cat-1', name: 'Bebidas', parent_id: null, active: 1, usage: 2 },
    { id: 'cat-2', name: 'Vestuário', parent_id: null, active: 1, usage: 1 },
  ],
  brands: [],
  orphans: { categories: [], subcategories: [], brands: [] },
};

/** Corpos enviados ao POST /core/inventory-counts. */
let aberturas: Record<string, unknown>[] = [];

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/taxonomy')) return json(TAXONOMIA);
    if (alvo.includes('/core/inventory-counts') && init?.method === 'POST') {
      aberturas.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json(DETALHE, 201);
    }
    if (alvo.includes('/core/inventory-counts')) return json({ items: [] });
    return json({ items: [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  aberturas = [];
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do inventário parcial na tela',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderizar() {
  render(
    <MemoryRouter>
      <InventarioPage />
    </MemoryRouter>,
  );
}

describe('a abertura envia o recorte', () => {
  it('categoria e busca viajam no corpo — e a contagem volta só com o recorte', async () => {
    renderizar();
    await screen.findByText('Nova contagem');

    fireEvent.change(await screen.findByLabelText(/Categoria/), {
      target: { value: 'Bebidas' },
    });
    fireEvent.change(screen.getByLabelText(/Recorte por busca/), {
      target: { value: 'Cola' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir contagem' }));

    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect(aberturas[0].category).toBe('Bebidas');
    expect(aberturas[0].search).toBe('Cola');

    // A contagem aberta mostra os itens que o servidor congelou.
    await screen.findByText('Refrigerante Cola 2L');
  });

  it('sem recorte, o corpo não inventa filtros — inventário geral como sempre', async () => {
    renderizar();
    await screen.findByText('Nova contagem');

    fireEvent.click(screen.getByRole('button', { name: 'Abrir contagem' }));

    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect(aberturas[0].category ?? null).toBeNull();
    expect(aberturas[0].search ?? null).toBeNull();
  });
});

describe('o filtro da tabela de itens', () => {
  it('encurta a rolagem sem mexer na contagem', async () => {
    renderizar();
    await screen.findByText('Nova contagem');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir contagem' }));
    await screen.findByText('Refrigerante Cola 2L');

    fireEvent.change(screen.getByPlaceholderText(/Filtrar itens/), {
      target: { value: 'Água' },
    });

    expect(screen.queryByText('Refrigerante Cola 2L')).toBeNull();
    expect(screen.getByText('Água mineral 500ml')).toBeTruthy();

    // Limpar o filtro traz tudo de volta: nada saiu da contagem.
    fireEvent.change(screen.getByPlaceholderText(/Filtrar itens/), { target: { value: '' } });
    expect(screen.getByText('Refrigerante Cola 2L')).toBeTruthy();
  });
});
