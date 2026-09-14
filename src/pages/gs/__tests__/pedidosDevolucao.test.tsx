/**
 * Na tela de Pedidos, o pedido reembolsado cuja mercadoria não voltou
 * conferida aparece marcado, e a ficha oferece o recebimento (GAP-PRD-122).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PedidosPage } from '../GestaoPages';

const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: { reembolsado: 'Reembolsado', entregue: 'Entregue', pago: 'Pago' },
};

const PEDIDO = {
  id: 'ord-r',
  number: 2002,
  customer_name: 'Bruno Devolve',
  total_cents: 15000,
  status: 'reembolsado',
  tracking_code: 'BR1',
  created_at: '2026-08-10T12:00:00.000Z',
  shipping_method: 'sedex',
  return_goods_status: 'aguardando',
};

function servidor(pedido: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/nfe/readiness')) return json({ canEmit: false, alreadyEmitted: false, reasons: ['x'] });
      // O envio da ficha (GAP-PRD-120): o pedido não tem envio nenhum.
      if (u.includes('/logistics/orders/')) return json({ readiness: null, items: [] });
      if (/\/core\/orders\/ord-r$/.test(u.split('?')[0])) {
        return json({
          ...pedido,
          items: [
            { id: 'i1', product_id: 'p1', description: 'Jaqueta', quantity: 1, unit_price_cents: 15000, total_cents: 15000 },
          ],
          events: [],
          financeEntries: [],
        });
      }
      return json({ items: [pedido], vocabulario: VOCABULARIO });
    }),
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('mercadoria devolvida a conferir', () => {
  it('a linha do pedido diz que a mercadoria ainda não foi conferida', async () => {
    servidor(PEDIDO);
    render(
      <MemoryRouter>
        <PedidosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mercadoria a conferir')).toBeTruthy();
  });

  it('a ficha oferece o recebimento, item a item', async () => {
    servidor(PEDIDO);
    render(
      <MemoryRouter initialEntries={['/sistema/pedidos?encomenda=ord-r']}>
        <PedidosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mercadoria devolvida a conferir')).toBeTruthy();
    expect(screen.getByLabelText('Jaqueta — volta ao estoque (de 1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmar recebimento' })).toBeTruthy();
    await act(async () => {});
  });

  it('mercadoria já recebida não oferece o recebimento de novo', async () => {
    servidor({ ...PEDIDO, return_goods_status: 'recebida' });
    render(
      <MemoryRouter initialEntries={['/sistema/pedidos?encomenda=ord-r']}>
        <PedidosPage />
      </MemoryRouter>,
    );
    await screen.findByText('Pedido #2002');
    expect(screen.queryByText('Mercadoria devolvida a conferir')).toBeNull();
    expect(screen.queryByText('Mercadoria a conferir')).toBeNull();
  });
});
