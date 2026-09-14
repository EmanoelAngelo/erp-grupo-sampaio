/**
 * A loja online aparece nos números do gestor (GAP-PRD-132): no BI, dentro do
 * faturamento e com a coluna própria; no painel, ao lado do faturamento de
 * balcão, dito com o próprio número.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import BiPage from '../BiPage';
import PainelPage from '../PainelPage';

function json(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function entrar() {
  setSession(
    {
      accessToken: 'token-do-gerente',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'gringa', tradeName: 'Gringa', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da loja online nos números',
  );
}

const OPERACAO = {
  companyId: 'c1',
  tradeName: 'Gringa',
  salesCount: 2,
  revenueCents: 25_000,
  averageTicketCents: 12_500,
  returnsCents: 0,
  netCents: 25_000,
  onlineOrdersCount: 1,
  onlineRevenueCents: 15_000,
};

function painel(extras: Record<string, unknown> = {}) {
  return {
    revenueCents: 10_000,
    salesCount: 1,
    averageTicketCents: 10_000,
    openReceivablesCents: 0,
    byDay: [],
    topProducts: [],
    bySeller: [],
    byBrand: [],
    byBrandUnallocatedCents: 0,
    lowStock: [],
    certificateAlert: null,
    companyId: 'c1',
    companies: [{ id: 'c1', tradeName: 'Gringa' }],
    ...extras,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da loja online nos números');
  localStorage.clear();
});

describe('BI: a loja online dentro do faturamento, com a parte dela à vista', () => {
  it('a coluna "Loja online" mostra valor e quantidade, e a tela diz o que entra', async () => {
    entrar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/insights/operations')) {
          return json({ operations: [OPERACAO], totals: { ...OPERACAO } });
        }
        if (u.includes('/insights/margin')) {
          return json({ consideredItems: 0, skippedNoCost: 0, revenueCents: 0, costCents: 0, marginCents: 0, marginPercent: null });
        }
        return json({ items: [] });
      }),
    );
    render(
      <MemoryRouter>
        <BiPage />
      </MemoryRouter>,
    );
    const celula = await screen.findByTestId('bi-loja-online');
    // O formatador de moeda põe espaço inseparável depois do "R$".
    expect(celula.textContent?.replace(/\s/g, ' ')).toBe('R$ 150,00 (1)');
    expect(screen.getByText(/a coluna “Loja online” mostra a parte deles/)).toBeTruthy();
  });

  it('servidor anterior, sem os campos, mostra traço — e não "R$ 0,00" como se a loja não vendesse', async () => {
    entrar();
    const antiga: Record<string, unknown> = { ...OPERACAO };
    delete antiga.onlineOrdersCount;
    delete antiga.onlineRevenueCents;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/insights/operations')) return json({ operations: [antiga], totals: antiga });
        if (u.includes('/insights/margin')) {
          return json({ consideredItems: 0, skippedNoCost: 0, revenueCents: 0, costCents: 0, marginCents: 0, marginPercent: null });
        }
        return json({ items: [] });
      }),
    );
    render(
      <MemoryRouter>
        <BiPage />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('bi-loja-online')).textContent).toBe('—');
  });
});

describe('painel: a loja online ao lado do faturamento de balcão', () => {
  it('diz o valor e os pedidos pagos, e onde eles entram', async () => {
    entrar();
    vi.stubGlobal('fetch', vi.fn(async () => json(painel({ onlineRevenueCents: 15_000, onlineOrdersCount: 1 }))));
    render(
      <MemoryRouter>
        <PainelPage />
      </MemoryRouter>,
    );
    const frase = await screen.findByTestId('painel-loja-online');
    expect(frase.textContent?.replace(/\s/g, ' ')).toContain('R$ 150,00');
    expect(frase.textContent).toContain('1 pedido(s) pago(s)');
    expect(frase.textContent).toContain('Vendas do período');
  });

  it('servidor anterior, sem o campo, não inventa a frase', async () => {
    entrar();
    vi.stubGlobal('fetch', vi.fn(async () => json(painel())));
    render(
      <MemoryRouter>
        <PainelPage />
      </MemoryRouter>,
    );
    await screen.findByText('Vendas por marca');
    expect(screen.queryByTestId('painel-loja-online')).toBeNull();
  });
});
