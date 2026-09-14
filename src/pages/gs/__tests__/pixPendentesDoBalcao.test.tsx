/**
 * ============================================================================
 * A FILA DOS PIX PENDENTES DO BALCÃO EM CONTAS A RECEBER (GAP-PRD-077)
 * ============================================================================
 *
 * A linha de PIX `pending` da venda era um beco: nada a liquidava e nenhuma
 * tela a mostrava. A gerência passa a ver cada uma, com a idade, e resolve —
 * o PIX do provedor pelo PROVEDOR ("Consultar o provedor", sem nota), o
 * declarado à mão com a nota de como foi conferido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContasPage from '../ContasPage';
import { setSession } from '@/lib/api/client';

const RESUMO = { openCents: 0, overdueCents: 0, settledCents: 0, count: 0 };
const FAIXAS = { notDueCents: 0, days1to30Cents: 0, days31to60Cents: 0, days61to90Cents: 0, over90Cents: 0 };

const PENDENTES = [
  {
    saleId: 'venda-1', saleNumber: 41, paymentId: 'pag-1', amountCents: 10000, createdAt: '2026-09-09T12:00:00.000Z',
    ageDays: 2, viaProvedor: true, intentId: 'int-1', intentStatus: 'pending', providerRef: 'pay_TEST_1', lastError: null,
  },
  {
    saleId: 'venda-2', saleNumber: 42, paymentId: 'pag-2', amountCents: 3000, createdAt: '2026-09-11T12:00:00.000Z',
    ageDays: 0, viaProvedor: false, intentId: null, intentStatus: null, providerRef: null, lastError: null,
  },
];

let enviados: { url: string; method: string; body: Record<string, unknown> | undefined }[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      enviados.push({ url: alvo, method: metodo, body: init?.body ? JSON.parse(init.body) : undefined });
      if (alvo.includes('/confirmar') && metodo === 'POST') {
        return json({ liquidada: true, detail: 'PIX do balcão confirmado: a venda #41 foi liquidada.' });
      }
      if (alvo.includes('/core/pdv/pix-pendentes')) return json({ items: PENDENTES });
      if (alvo.includes('/core/finance/entries')) return json({ items: [], summary: RESUMO, aging: FAIXAS });
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da fila de PIX pendentes',
  );
}

function montar() {
  return render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-receber']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste da fila de PIX pendentes');
  localStorage.clear();
});

describe('GAP-PRD-077 — a fila dos PIX pendentes do balcão', () => {
  it('a gerência vê cada PIX pendente, com a venda, o valor e a idade', async () => {
    entrarComo('gerente_loja');
    montar();

    expect(await screen.findByText('Venda #41 · R$ 100,00')).toBeTruthy();
    expect(screen.getByText('Venda #42 · R$ 30,00')).toBeTruthy();
    expect(screen.getByText(/há 2 dia\(s\)/)).toBeTruthy();
    expect(screen.getByText(/PIX declarado pendente, sem provedor/)).toBeTruthy();
  });

  it('PIX do provedor: "Consultar o provedor" pergunta sem nota — quem afirma é o provedor', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Consultar o provedor' }));

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/confirmar'))).toBe(true));
    const pedido = enviados.find((e) => e.url.includes('/confirmar'))!;
    expect(pedido.url).toContain('/core/sales/venda-1/payments/pag-1/confirmar');
    expect(pedido.body).toEqual({});
    expect(await screen.findByText(/venda #41 foi liquidada/)).toBeTruthy();
  });

  it('PIX sem provedor: a confirmação leva a nota de como foi conferido', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar recebimento' }));
    const campo = screen.getByLabelText('Como o recebimento foi conferido');
    fireEvent.change(campo, { target: { value: 'extrato do banco, 11/09 14h32' } });
    fireEvent.click(within(campo.closest('div')!).getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/venda-2/payments/pag-2/confirmar'))).toBe(true));
    expect(enviados.find((e) => e.url.includes('/confirmar'))!.body).toEqual({ note: 'extrato do banco, 11/09 14h32' });
  });

  it('o caixa não vê a fila: cobrar o PIX que não caiu é da gerência', async () => {
    entrarComo('operador_caixa_loja');
    montar();

    await screen.findByText('Cobranças online');
    expect(screen.queryByText('PIX do balcão aguardando confirmação')).toBeNull();
    expect(enviados.some((e) => e.url.includes('/pdv/pix-pendentes'))).toBe(false);
  });
});
