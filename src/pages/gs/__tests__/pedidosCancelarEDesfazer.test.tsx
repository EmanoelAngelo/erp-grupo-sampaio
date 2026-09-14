/**
 * A tela de Pedidos ganha as duas portas que faltavam (GAP-PRD-124, GAP-PRD-121):
 * "Cancelar" ao lado de "Baixar pagamento", e "Desfazer etapa" na ficha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PedidosPage } from '../GestaoPages';

const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: {
    aguardando_pagamento: 'Aguardando pagamento',
    pago: 'Pago',
    separacao: 'Separação',
    conferencia: 'Conferência',
    embalado: 'Embalado',
    expedido: 'Expedido',
    pronto_para_retirada: 'Pronto para retirada',
    entregue: 'Entregue',
    cancelado: 'Cancelado',
    reembolsado: 'Reembolsado',
  },
};

function pedido(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    number: 1001,
    customer_name: 'Ana Compradora',
    total_cents: 20000,
    status: 'aguardando_pagamento',
    tracking_code: null,
    created_at: '2026-08-10T12:00:00.000Z',
    shipping_method: 'retirada',
    ...over,
  };
}

function servidor(items: Record<string, unknown>[]) {
  const posts: { url: string; body: unknown }[] = [];
  const leituras = { lista: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (init?.method === 'POST') {
        posts.push({ url: u, body: JSON.parse(String(init.body ?? '{}')) });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/nfe/readiness')) {
        return new Response(
          JSON.stringify({ canEmit: false, alreadyEmitted: false, reasons: ['Pedido de teste'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (/\/core\/orders\/[^/?]+$/.test(u.split('?')[0])) {
        const id = u.split('?')[0].split('/').pop();
        const p = items.find((i) => i.id === id)!;
        return new Response(
          JSON.stringify({ ...p, items: [], events: [], financeEntries: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      leituras.lista += 1;
      return new Response(JSON.stringify({ items, vocabulario: VOCABULARIO }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { posts, leituras };
}

function montar(url = '/sistema/pedidos') {
  render(
    <MemoryRouter initialEntries={[url]}>
      <PedidosPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('cancelar pedido aguardando pagamento (GAP-PRD-124)', () => {
  it('o botão está ao lado de "Baixar pagamento" e manda o motivo para /cancel', async () => {
    const { posts, leituras } = servidor([pedido()]);
    montar();

    expect(await screen.findByRole('button', { name: 'Baixar pagamento' })).toBeTruthy();
    (await screen.findByRole('button', { name: 'Cancelar' })).click();
    const dialogo = await screen.findByRole('dialog', { name: 'Cancelar o pedido #1001' });
    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: 'Cliente desistiu por telefone' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar o pedido' }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain('/core/orders/ord-1/cancel');
    expect(posts[0].body).toEqual({ reason: 'Cliente desistiu por telefone' });
    // A lista é recarregada: o pedido cancelado aparece como está.
    await vi.waitFor(() => expect(leituras.lista).toBeGreaterThanOrEqual(2));
    await act(async () => {});
  });

  it('pedido pago não oferece "Cancelar" — depois do dinheiro o caminho é devolver', async () => {
    servidor([pedido({ status: 'pago' })]);
    montar();
    await screen.findByRole('button', { name: 'Separação' });
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
  });
});

describe('desfazer etapa na ficha (GAP-PRD-121)', () => {
  it('a ficha de um pedido entregue oferece voltar para a etapa anterior do caminho dele', async () => {
    const { posts } = servidor([pedido({ status: 'entregue' })]);
    montar('/sistema/pedidos?encomenda=ord-1');

    const botao = await screen.findByRole('button', {
      name: 'Desfazer etapa (voltar para Pronto para retirada)',
    });
    botao.click();
    const dialogo = await screen.findByRole('dialog', {
      name: 'Voltar o pedido #1001 de "Entregue" para "Pronto para retirada"',
    });
    fireEvent.change(within(dialogo).getByRole('textbox'), {
      target: { value: 'Marcado entregue antes de o cliente chegar' },
    });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Voltar a etapa' }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain('/core/orders/ord-1/fulfillment/voltar');
    expect(posts[0].body).toEqual({ reason: 'Marcado entregue antes de o cliente chegar' });
    await act(async () => {});
  });

  it('pedido em "Pago" (a primeira etapa) não oferece desfazer', async () => {
    servidor([pedido({ status: 'pago' })]);
    montar('/sistema/pedidos?encomenda=ord-1');
    await screen.findByText('Pedido #1001');
    expect(screen.queryByRole('button', { name: /Desfazer etapa/ })).toBeNull();
  });
});
