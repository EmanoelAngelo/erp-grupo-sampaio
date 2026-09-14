/**
 * O KPI "EM ABERTO" CONTA OS ABERTOS (GAP-PRD-208).
 *
 * O subtítulo do KPI mostrava `summary.count` — todos os lançamentos do lado,
 * quitados inclusive. Com o único lançamento já liquidado, a tela dizia
 * "R$ 0,00 · 1 lançamento(s)": o valor certo ao lado de uma contagem de outra
 * coisa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContasPage from '../ContasPage';
import { setSession } from '@/lib/api/client';

const FAIXAS = { notDueCents: 0, days1to30Cents: 0, days31to60Cents: 0, days61to90Cents: 0, over90Cents: 0 };

let resumo: Record<string, unknown>;
let itens: Record<string, unknown>[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function lancamento(parcial: Record<string, unknown>) {
  return {
    id: 'fin-1',
    companyId: 'loja',
    direction: 'in',
    description: 'Venda à vista',
    amountCents: 12345,
    settledCents: 12345,
    balanceCents: 0,
    status: 'settled',
    dueDate: '2026-09-01',
    settledAt: '2026-09-01T12:00:00.000Z',
    overdue: false,
    originType: 'manual',
    originId: 'fin-1',
    originLabel: null,
    installmentNumber: 1,
    installmentTotal: 1,
    categoryId: null,
    costCenterId: null,
    accountId: null,
    competenceDate: '2026-09-01',
    note: null,
    counterpartyName: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    ...parcial,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);
      if (alvo.includes('/core/finance/entries')) return json({ items: itens, summary: resumo, aging: FAIXAS });
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
    'teste do KPI em aberto',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do KPI em aberto');
  localStorage.clear();
});

function montar() {
  return render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-receber']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-208 — o subtítulo do "Em aberto" conta os abertos', () => {
  it('com o único lançamento liquidado, diz "0 em aberto" — não "1 lançamento(s)"', async () => {
    itens = [lancamento({})];
    resumo = { openCents: 0, overdueCents: 0, settledCents: 12345, count: 1, openCount: 0, overdueCount: 0 };
    montar();

    await waitFor(() => expect(screen.getByText('0 em aberto')).toBeTruthy());
    expect(screen.queryByText('1 lançamento(s)')).toBeNull();
  });

  it('usa a contagem do servidor (que vê tudo, não só as 500 linhas da lista)', async () => {
    itens = [lancamento({ balanceCents: 5000, settledCents: 0, amountCents: 5000, status: 'open' })];
    resumo = { openCents: 900000, overdueCents: 0, settledCents: 0, count: 812, openCount: 640, overdueCount: 0 };
    montar();

    await waitFor(() => expect(screen.getByText('640 em aberto')).toBeTruthy());
  });

  it('servidor antigo sem openCount: conta os abertos da própria lista, nunca o total', async () => {
    itens = [
      lancamento({ id: 'a' }),
      lancamento({ id: 'b', balanceCents: 3000, settledCents: 0, amountCents: 3000, status: 'open' }),
    ];
    resumo = { openCents: 3000, overdueCents: 0, settledCents: 12345, count: 2 };
    montar();

    await waitFor(() => expect(screen.getByText('1 em aberto')).toBeTruthy());
  });
});
