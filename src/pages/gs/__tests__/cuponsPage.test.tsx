/**
 * A tela de Cupons de desconto — GAP-PRD-123.
 *
 * Criar com os padrões seguros (uma vez por cliente, não cumulativo), o valor
 * fixo com pedido mínimo, a recusa do servidor com as palavras dele, a lista
 * com os usos e a situação, e encerrar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CuponsPage from '../CuponsPage';

const DIA = 86_400_000;

function cupom(over: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    code: 'BEMVINDO10',
    description: null,
    percent_off: 10,
    amount_cents: null,
    min_order_cents: 0,
    starts_at: new Date(Date.now() - DIA).toISOString(),
    ends_at: null,
    max_uses: 100,
    max_uses_per_customer: 1,
    accumulates_with_promotions: 0,
    active: 1,
    uses: 3,
    discount_total_cents: 4500,
    ...over,
  };
}

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

function servidor(lista: unknown[], post?: () => Response) {
  const chamadas: Chamada[] = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      chamadas.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'GET') return json({ items: lista });
      if (method === 'POST') {
        return post ? post() : json(cupom({ id: 'novo', code: 'CRIADO', uses: 0 }), 201);
      }
      return json(cupom({ active: 0 }));
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <CuponsPage />
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

describe('a lista', () => {
  it('mostra o código, os usos contra o teto, o alcance e a situação', async () => {
    servidor([cupom(), cupom({ id: 'c-2', code: 'VELHO', active: 0, uses: 7, max_uses: null })]);
    montar();
    await screen.findByText('BEMVINDO10');
    expect(screen.getByText('3 de 100')).toBeTruthy();
    expect(screen.getAllByText('Só preço cheio').length).toBeGreaterThan(0);
    expect(screen.getByText('Valendo')).toBeTruthy();
    expect(screen.getByText('Encerrado')).toBeTruthy();
  });

  it('esgotado aparece como esgotado', async () => {
    servidor([cupom({ uses: 100 })]);
    montar();
    await screen.findByText('Esgotado');
  });
});

describe('criar', () => {
  it('percentual, com os padrões seguros: uma vez por cliente, não cumulativo', async () => {
    const chamadas = servidor([]);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Novo cupom' }));
    fireEvent.change(screen.getByLabelText(/^Código/), { target: { value: 'bemvindo10' } });
    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar cupom' }));

    await waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body).toMatchObject({
      code: 'BEMVINDO10',
      percentOff: 10,
      minOrderCents: 0,
      maxUsesPerCustomer: 1,
      maxUses: null,
      accumulatesWithPromotions: false,
    });
    await screen.findByText(/Cupom CRIADO criado/);
  });

  it('valor fixo com pedido mínimo, em centavos', async () => {
    const chamadas = servidor([]);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Novo cupom' }));
    fireEvent.change(screen.getByLabelText(/^Código/), { target: { value: 'VINTE' } });
    fireEvent.change(screen.getByLabelText('Tipo de desconto'), { target: { value: 'valor' } });
    fireEvent.change(await screen.findByLabelText(/Valor do desconto/), { target: { value: '20,00' } });
    fireEvent.change(screen.getByLabelText(/Pedido mínimo/), { target: { value: '150,00' } });
    fireEvent.click(screen.getByLabelText(/Vale também sobre itens/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar cupom' }));

    await waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body).toMatchObject({
      code: 'VINTE',
      amountCents: 2000,
      minOrderCents: 15000,
      accumulatesWithPromotions: true,
    });
  });

  it('a recusa do servidor aparece com as palavras dele', async () => {
    servidor([], () =>
      new Response(
        JSON.stringify({
          error: { code: 'CORE_COUPON_CODE_TAKEN', message: 'Já existe um cupom VERAO nesta empresa.' },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Novo cupom' }));
    fireEvent.change(screen.getByLabelText(/^Código/), { target: { value: 'VERAO' } });
    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar cupom' }));
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Já existe um cupom VERAO');
  });
});

describe('encerrar', () => {
  it('chama o servidor e diz que os pedidos antigos mantêm o desconto', async () => {
    const chamadas = servidor([cupom()]);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));
    await screen.findByText(/não vale mais no checkout/);
    const del = chamadas.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('/core/coupons/c-1');
  });
});
