/**
 * O CARTÃO DE MARGEM DO BI DIZ QUAL CUSTO USA — e conta o que ficou de fora
 * (GAP-PRD-086).
 *
 * O servidor passou a calcular a margem com o custo gravado no dia da venda,
 * a mesma régua do CMV do DRE, e a separar as linhas sem custo gravado
 * (`skippedBeforeSnapshot`). A tela precisa dizer as duas coisas: qual custo
 * está na conta, e quantas linhas ficaram fora por não terem custo gravado —
 * senão a margem de 3 itens se lê como a margem do período.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BiPage from '../BiPage';
import { setSession } from '@/lib/api/client';

let margem: Record<string, unknown>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);
      if (alvo.includes('/core/insights/operations')) {
        return json({
          operations: [],
          totals: { salesCount: 0, revenueCents: 0, averageTicketCents: 0, returnsCents: 0, netCents: 0 },
        });
      }
      if (alvo.includes('/core/insights/margin')) return json(margem);
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
    'teste da margem do BI',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste da margem do BI');
});

function montar() {
  render(
    <MemoryRouter>
      <BiPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-086 — o cartão de margem usa o custo do dia da venda, e diz', () => {
  it('declara a régua (a mesma do CMV) e conta as linhas sem custo gravado', async () => {
    margem = {
      consideredItems: 3,
      skippedNoCost: 1,
      skippedBeforeSnapshot: 2,
      revenueCents: 40000,
      costCents: 16000,
      marginCents: 24000,
      marginPercent: 60,
    };
    montar();

    expect(await screen.findByText('60%')).toBeTruthy();
    expect(screen.getByText(/custo gravado no dia de cada venda/)).toBeTruthy();
    expect(screen.getByText(/2 item\(ns\) ficaram fora por não ter custo gravado na\s+venda/)).toBeTruthy();
    expect(screen.getByText(/1 item\(ns\) vendidos ficaram FORA/)).toBeTruthy();
  });

  it('sem nada com custo gravado: "não há como calcular", e diz por quê', async () => {
    margem = {
      consideredItems: 0,
      skippedNoCost: 0,
      skippedBeforeSnapshot: 4,
      revenueCents: 0,
      costCents: 0,
      marginCents: 0,
      marginPercent: null,
    };
    montar();

    expect(await screen.findByText('Não há como calcular a margem')).toBeTruthy();
    expect(screen.getByText(/4 item\(ns\) são de antes de o sistema gravar custo/)).toBeTruthy();
  });
});
