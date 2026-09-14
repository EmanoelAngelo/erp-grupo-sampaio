/**
 * QUITAÇÕES ANTIGAS SEM BAIXA NA CONCILIAÇÃO BANCÁRIA (GAP-PRD-171).
 *
 * O cartão só aparece quando há o que decidir, diz quanto é e desde quando, e
 * cria as baixas-espelho só depois de a pessoa confirmar — com o `confirm`
 * explícito no corpo, que o servidor exige.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConciliacaoBancariaPage from '../ConciliacaoBancariaPage';
import { setSession } from '@/lib/api/client';

const RELATORIO = {
  period: { from: null, to: null },
  bankTotalCents: 0,
  financeTotalCents: 0,
  differenceCents: 0,
  matched: 0,
  divergences: [],
};

let legados: Record<string, unknown>;
let enviados: { url: string; method: string; body?: Record<string, unknown> }[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const DUAS = {
  count: 2,
  inCents: 64870,
  outCents: 0,
  items: [
    { id: 'e1', direction: 'in', description: 'Venda à vista #3', amountCents: 31970, settledCents: 31970, explainedCents: 0, missingCents: 31970, mirrorDate: '2026-08-12T15:00:00.000Z', paymentMethod: 'dinheiro', originType: 'sale', createdAt: '2026-08-12T15:00:00.000Z' },
    { id: 'e2', direction: 'in', description: 'Venda à vista #4', amountCents: 32900, settledCents: 32900, explainedCents: 0, missingCents: 32900, mirrorDate: '2026-08-13T15:00:00.000Z', paymentMethod: 'pix', originType: 'sale', createdAt: '2026-08-13T15:00:00.000Z' },
  ],
};

beforeEach(() => {
  enviados = [];
  legados = DUAS;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      enviados.push({ url: alvo, method: metodo, body: init?.body ? JSON.parse(init.body) : undefined });
      if (alvo.includes('/legacy-settlements/mirror') && metodo === 'POST') {
        legados = { count: 0, inCents: 0, outCents: 0, items: [] };
        return json({ created: 2, totalCents: 64870, settlementIds: ['s1', 's2'] });
      }
      if (alvo.includes('/core/finance/legacy-settlements')) return json(legados);
      if (alvo.includes('/core/bank/conciliacao')) return json(RELATORIO);
      if (alvo.includes('/core/bank/lines')) return json({ items: [], total: 0, limit: 500, offset: 0, truncated: false });
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
    'teste das quitações sem baixa',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste das quitações sem baixa');
});

function montar() {
  render(
    <MemoryRouter>
      <ConciliacaoBancariaPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-171 — a decisão sobre as quitações antigas está na tela', () => {
  it('diz quantas, quanto e desde quando', async () => {
    montar();
    expect(await screen.findByText('Quitações antigas sem baixa')).toBeTruthy();
    expect(screen.getByText(/quitado\(s\) desde 12\/08\/2026 somam/)).toBeTruthy();
  });

  it('só cria depois da confirmação, e manda confirm: true', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Criar as baixas-espelho' }));
    // Ainda nada foi enviado: o primeiro clique só pergunta.
    expect(enviados.some((e) => e.method === 'POST')).toBe(false);
    expect(screen.getByRole('alertdialog', { name: 'Criar as baixas-espelho?' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Criar as baixas' }));

    await waitFor(() => expect(enviados.some((e) => e.method === 'POST')).toBe(true));
    const post = enviados.find((e) => e.method === 'POST')!;
    expect(post.url).toContain('/core/finance/legacy-settlements/mirror');
    expect(post.body).toEqual({ confirm: true });
    expect(await screen.findByText(/2 baixa\(s\)-espelho criada\(s\)/)).toBeTruthy();
  });

  it('"Agora não" fecha a pergunta sem gravar', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Criar as baixas-espelho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agora não' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(enviados.some((e) => e.method === 'POST')).toBe(false);
  });

  it('sem nada a decidir, o cartão não aparece', async () => {
    legados = { count: 0, inCents: 0, outCents: 0, items: [] };
    montar();
    await screen.findByText('Importar extrato');
    await waitFor(() => expect(enviados.some((e) => e.url.includes('legacy-settlements'))).toBe(true));
    expect(screen.queryByText('Quitações antigas sem baixa')).toBeNull();
  });
});
