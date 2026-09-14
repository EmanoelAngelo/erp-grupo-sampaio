/**
 * O cupom no detalhe do pedido do portal — GAP-PRD-123.
 *
 * O servidor guarda o item LÍQUIDO do cupom (é o que a NF-e declara). A
 * cliente lê o valor da linha ANTES do cupom, o bruto dos itens, a linha
 * "Cupom CÓDIGO −R$" uma vez só, e o total que pagou — as contas batem na
 * cabeça de quem lê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MeuPedidoPage } from '../MinhaContaPage';

const SESSAO = {
  token: 'tok-portal-cupom',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: '2026-08-01T00:00:00Z' },
};

function pedido(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-7',
    number: 1007,
    storeName: 'Gringa',
    createdAt: '2026-09-01T12:00:00.000Z',
    statusLabel: 'Aguardando pagamento',
    status: 'aguardando_pagamento',
    // Líquido: 20000 de itens − 2000 de cupom.
    itemsCents: 18000,
    discountCents: 2000,
    couponCode: 'DEZ',
    shippingCents: 1500,
    totalCents: 19500,
    deliveryMethod: 'entrega',
    shippingZip: '01001-000',
    shippingAddress: 'Rua Um, 10',
    trackingCode: null,
    shippingServiceName: 'PAC',
    deliveryEstimate: null,
    customer: { name: 'Ana', email: 'ana@exemplo.com', document: '••• 7735' },
    items: [
      { description: 'Jaqueta', quantity: 2, unitPriceCents: 10000, totalCents: 18000, discountCents: 2000, imageUrl: null },
    ],
    payments: [],
    timeline: [],
    ...over,
  };
}

function servidor(corpo: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-7']}>
      <Routes>
        <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gs.portal', JSON.stringify(SESSAO));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o cupom no detalhe do pedido', () => {
  it('mostra a linha pelo valor antes do cupom, os itens brutos, o cupom e o total pago', async () => {
    servidor(pedido());
    montar();
    const cupom = await screen.findByText(/Cupom\s+DEZ/);
    expect(cupom.tagName).toBe('DT');
    expect(cupom.nextElementSibling?.textContent).toMatch(/−R\$\s*20,00/);
    // Itens = bruto (180 + 20); a linha também é o bruto.
    expect(screen.getAllByText(/R\$\s*200,00/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/R\$\s*195,00/).length).toBeGreaterThanOrEqual(1);
  });

  it('pedido sem cupom não mostra linha de cupom', async () => {
    servidor(
      pedido({
        itemsCents: 20000,
        discountCents: 0,
        couponCode: null,
        totalCents: 21500,
        items: [{ description: 'Jaqueta', quantity: 2, unitPriceCents: 10000, totalCents: 20000, discountCents: 0, imageUrl: null }],
      }),
    );
    montar();
    await screen.findByText('Pedido #1007');
    expect(screen.queryByText(/Cupom\s/)).toBeNull();
  });
});
