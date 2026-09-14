/**
 * Na tela de Pedidos, o pedido de devolução que a cliente abriu no portal
 * aparece na lista e na ficha, com a decisão da loja (GAP-PRD-125).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PedidosPage } from '../GestaoPages';

const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: { entregue: 'Entregue' },
};

const PEDIDO = {
  id: 'ord-s',
  number: 3003,
  customer_name: 'Carla Pede',
  total_cents: 9000,
  status: 'entregue',
  tracking_code: null,
  created_at: '2026-09-01T12:00:00.000Z',
  shipping_method: 'retirada',
  return_request_status: 'aberta',
};

const SOLICITACAO = {
  id: 'req-1',
  orderId: 'ord-s',
  kind: 'defeito',
  kindLabel: 'Produto com defeito',
  reason: 'O zíper quebrou',
  status: 'aberta',
  statusLabel: 'Aguardando a loja',
  decisionNote: null,
  createdAt: '2026-09-10T12:00:00.000Z',
  decidedAt: null,
};

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/nfe/readiness')) return json({ canEmit: false, alreadyEmitted: false, reasons: ['x'] });
      if (/\/core\/orders\/ord-s$/.test(u.split('?')[0])) {
        return json({ ...PEDIDO, items: [], events: [], financeEntries: [], returnRequests: [SOLICITACAO] });
      }
      return json({ items: [PEDIDO], vocabulario: VOCABULARIO });
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

describe('o pedido de devolução da cliente na gestão', () => {
  it('a lista marca o pedido que espera decisão', async () => {
    servidor();
    render(
      <MemoryRouter>
        <PedidosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Devolução solicitada')).toBeTruthy();
  });

  it('a ficha mostra o relato da cliente e oferece aprovar ou recusar', async () => {
    servidor();
    render(
      <MemoryRouter initialEntries={['/sistema/pedidos?encomenda=ord-s']}>
        <PedidosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Pedidos de devolução da cliente')).toBeTruthy();
    expect(screen.getByText('Relato da cliente: O zíper quebrou')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aprovar devolução' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeTruthy();
    await act(async () => {});
  });
});
