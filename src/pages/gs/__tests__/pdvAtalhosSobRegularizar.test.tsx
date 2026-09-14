/**
 * ============================================================================
 * OS ATALHOS DO BALCÃO NÃO AGEM POR BAIXO DE "REGULARIZAR" (RES-IDEM-TELA)
 * ============================================================================
 *
 * "Regularizar" (a venda guardada que o servidor recusou) abre por cima do PDV,
 * pela barra de conexão — e é para lá que a recusa da chave reusada manda o
 * caixa relançar como venda nova. O handler de atalhos do PDV só conhece os
 * modais DELE: com "Regularizar" aberto e o carrinho montado, F8 finalizava a
 * venda do carrinho POR BAIXO, em dinheiro, sem o caixa ver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const PRODUTO = {
  id: 'p-1',
  internal_code: 'PJ-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Fone de ouvido',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1000,
  price_cents: 2500,
  effective_price_cents: 2500,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

const PENDENCIA = {
  id: 'offsale-1',
  idempotencyKey: 'pdv-chave-reusada',
  label: 'venda do PDV',
  queuedAt: '2026-09-12T14:05:00.000Z',
  reportedAt: '2026-09-12T18:00:00.000Z',
  lastReportedAt: '2026-09-12T18:00:00.000Z',
  reportedBy: 'u1',
  reportedByName: 'Caixa 1',
  terminalId: null,
  terminalName: null,
  cashSessionId: 'sessao-antiga',
  receivedCents: 15000,
  itemsCount: 1,
  items: [{ productId: 'p-camiseta', name: 'Camiseta', quantity: 3, unitPriceCents: 5000 }],
  payments: [{ method: 'dinheiro', amountCents: 15000 }],
  status: 'pendente',
  errorCode: 'CORE_IDEMPOTENCY_KEY_REUSED',
  errorMessage: 'recusada',
  attempts: 1,
  saleId: null,
  saleNumber: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  vendaDaChave: {
    id: 's-5',
    number: 5,
    totalCents: 10000,
    status: 'completed',
    items: [{ description: 'Camiseta', quantity: 2 }],
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Cada POST de venda que saiu da tela. */
let vendasEnviadas: number;

beforeEach(() => {
  vendasEnviadas = 0;
  localStorage.setItem(
    'gs.session',
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const u = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('/core/offline-sales')) return json({ items: [PENDENCIA] });
      if (u.includes('/core/sales') && metodo === 'POST') {
        vendasEnviadas += 1;
        return json({ id: 's-9', number: 9, total_cents: 2500, change_cents: 0 }, 201);
      }
      if (u.includes('/core/cash/open') && metodo === 'GET') {
        return json({
          session: { id: 'sessao-1', opening_cents: 5000, status: 'aberto' },
          cashWithdrawalLimitCents: null,
        });
      }
      if (u.includes('/summary')) return json({ expectedCents: 5000, byMethod: [], movements: [] });
      if (u.includes('/core/fiscal/pdv-summary')) return json({ situacao: 'READY', pendencyCount: 0, motivos: [] });
      if (u.includes('/core/products/search')) return json({ items: [PRODUTO] });
      return json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o balcão por baixo de "Regularizar"', () => {
  it('com "Regularizar" aberto e o carrinho montado, F8 não finaliza a venda por baixo', async () => {
    render(
      <MemoryRouter>
        <PdvPage />
      </MemoryRouter>,
    );
    const busca = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
    fireEvent.change(busca, { target: { value: '7890000001111' } });
    fireEvent.keyDown(busca, { key: 'Enter' });
    await screen.findByText('Fone de ouvido');

    fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
    const cartao = await screen.findByTestId('venda-offline-recusada');

    fireEvent.keyDown(cartao, { key: 'F8' });
    await new Promise((r) => setTimeout(r, 80));
    expect(vendasEnviadas).toBe(0);
    // O carrinho continua lá, esperando o caixa voltar a ele.
    expect(screen.getAllByText('Fone de ouvido').length).toBeGreaterThan(0);
  });
});
