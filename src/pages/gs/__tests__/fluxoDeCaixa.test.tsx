/**
 * A TELA DO FLUXO DE CAIXA (GAP-PRD-094).
 *
 * O servidor faz a conta; a tela escolhe o recorte e mostra. Estes testes
 * olham o que sai no fio (horizonte, conta, vencidos) e o que a tela diz com a
 * resposta: o primeiro dia negativo em destaque, os títulos de cada período,
 * e as ressalvas — o que a projeção não conta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FluxoDeCaixaPage from '../FluxoDeCaixaPage';
import { setSession } from '@/lib/api/client';

let urls: string[];
let resposta: Record<string, unknown>;

function periodo(start: string, parcial: Record<string, unknown> = {}) {
  return { start, end: start, inCents: 0, outCents: 0, netCents: 0, balanceCents: 50000, count: 0, items: [], ...parcial };
}

function base(parcial: Record<string, unknown> = {}) {
  return {
    from: '2026-09-11',
    to: '2026-10-10',
    today: '2026-09-11',
    granularity: 'day',
    overdueMode: 'payables',
    account: null,
    openingBalanceCents: 50000,
    accountsConsidered: 1,
    overdue: { inCents: 0, outCents: 0, count: 0, countedInCents: 0, countedOutCents: 0 },
    periods: [
      periodo('2026-09-11'),
      periodo('2026-09-12', {
        outCents: 70000,
        netCents: -70000,
        balanceCents: -20000,
        count: 1,
        items: [
          {
            id: 'fin-1',
            direction: 'out',
            description: 'Fornecedor Alfa',
            dueDate: '2026-09-12',
            balanceCents: 70000,
            counterpartyName: 'Distribuidora Alfa',
            originType: 'nfe_entrada',
            originId: 'nota-1',
            accountId: null,
          },
        ],
      }),
    ],
    totals: { inCents: 0, outCents: 70000, netCents: -70000 },
    closingBalanceCents: -20000,
    lowestBalance: { cents: -20000, date: '2026-09-12' },
    firstNegativeDate: '2026-09-12',
    noDueDate: { inCents: 0, outCents: 0, count: 0 },
    beyond: { inCents: 0, outCents: 0, count: 0 },
    withoutAccount: null,
    settledWithoutAccountCents: 0,
    caveats: ['1 título(s) em aberto sem vencimento (R$ 90,00 a receber, R$ 0,00 a pagar) ficaram fora: sem data não há dia para projetar.'],
    ...parcial,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  urls = [];
  resposta = base();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);
      urls.push(alvo);
      if (alvo.includes('/core/finance/cash-flow')) return json(resposta);
      if (alvo.includes('/core/finance/setup')) {
        return json({
          categories: [],
          costCenters: [],
          accounts: [{ id: 'conta-1', name: 'Banco do Grupo', kind: 'banco', active: 1, is_default: 1, balanceCents: 50000 }],
        });
      }
      return json({ items: [] });
    }),
  );
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste do fluxo de caixa',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do fluxo de caixa');
});

function montar() {
  render(
    <MemoryRouter>
      <FluxoDeCaixaPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-094 — a tela responde "tenho caixa para pagar dia 20?"', () => {
  it('pede 30 dias com vencidos só a pagar, e destaca o primeiro dia negativo', async () => {
    montar();

    const alerta = await screen.findByText(/O saldo projetado fica negativo em 12\/09\/2026/);
    expect(alerta).toBeTruthy();
    const pedido = urls.find((u) => u.includes('/core/finance/cash-flow'))!;
    expect(pedido).toContain('days=30');
    expect(pedido).toContain('overdue=payables');
  });

  it('abre o período e mostra QUAL título sai, com link para a origem', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver os títulos de 12/09/2026' }));

    expect(screen.getByText('Fornecedor Alfa')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'abrir a origem' });
    expect(link.getAttribute('href')).toBe('/sistema/compras/entrada-notas?nota=nota-1');
  });

  it('trocar horizonte, conta e vencidos vai no pedido', async () => {
    montar();
    await screen.findByText(/O saldo projetado fica negativo/);

    fireEvent.click(screen.getByRole('button', { name: '90 dias' }));
    await waitFor(() => expect(urls.some((u) => u.includes('days=90'))).toBe(true));

    await screen.findByRole('option', { name: 'Banco do Grupo' });
    fireEvent.change(screen.getByLabelText('Conta'), { target: { value: 'conta-1' } });
    await waitFor(() => expect(urls.some((u) => u.includes('accountId=conta-1'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Vencidos em aberto'), { target: { value: 'both' } });
    await waitFor(() => expect(urls.some((u) => u.includes('overdue=both'))).toBe(true));
  });

  it('diz o que a projeção não conta', async () => {
    montar();
    expect(await screen.findByText('O que esta projeção não conta')).toBeTruthy();
    expect(screen.getByText(/sem vencimento/)).toBeTruthy();
  });

  it('sem saldo negativo, diz até quando o caixa aguenta', async () => {
    resposta = base({
      firstNegativeDate: null,
      closingBalanceCents: 50000,
      lowestBalance: { cents: 50000, date: '2026-09-11' },
      periods: [periodo('2026-09-11')],
      totals: { inCents: 0, outCents: 0, netCents: 0 },
      caveats: [],
    });
    montar();
    expect(await screen.findByText(/não fica negativo até 10\/10\/2026/)).toBeTruthy();
    expect(screen.getByText('Nada vence no período')).toBeTruthy();
  });
});
