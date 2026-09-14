/**
 * DO CONTAS A PAGAR AO FECHAMENTO DE COMISSÃO, E DE VOLTA (GAP-PRD-174).
 *
 * O título da comissão nascia como lançamento avulso e não era link. Agora a
 * origem `commission_closing` leva a `/sistema/financeiro/comissoes?fechamento=`,
 * a tela de Comissões abre direto na aba "Fechamentos" com aquele fechamento
 * aberto (as vendas que ele levou e a situação do título), e a lista de
 * fechamentos — o histórico que nenhuma tela lia — existe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ComissoesPage from '../ComissoesPage';
import { destinoDaOrigem } from '@/lib/rotasDeOrigem';
import { setSession } from '@/lib/api/client';

const FECHAMENTO = {
  id: 'fech-1',
  sellerId: 'v-1',
  sellerName: 'Joana Vendedora',
  periodFrom: '2026-08-01',
  periodTo: '2026-08-31',
  totalCents: 15000,
  financeEntryId: 'fin-9',
  entryBalanceCents: 15000,
  entryCancelled: false,
  closedBy: 'u-1',
  closedByName: 'Fulano',
  createdAt: '2026-09-01T12:00:00.000Z',
  lineCount: 2,
};

const LINHAS = [
  { id: 'l1', saleId: 's1', saleNumber: 11, originType: 'sale', baseCents: 100000, rateBps: 1000, amountCents: 10000, competenceDate: '2026-08-05', note: null },
  { id: 'l2', saleId: 's2', saleNumber: 12, originType: 'sale', baseCents: 50000, rateBps: 1000, amountCents: 5000, competenceDate: '2026-08-20', note: null },
];

let urls: string[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  urls = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);
      urls.push(alvo);
      if (alvo.includes('/core/commissions/closings/fech-1')) return json({ closing: FECHAMENTO, lines: LINHAS });
      if (alvo.includes('/core/commissions/closings')) return json({ items: [FECHAMENTO] });
      if (alvo.includes('/core/commissions/setup')) return json({ groups: [], members: [] });
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
    'teste do fechamento de comissão',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do fechamento de comissão');
});

function OndeEstou() {
  const l = useLocation();
  return <span data-testid="endereco">{`${l.pathname}${l.search}`}</span>;
}

function montar(endereco: string) {
  render(
    <MemoryRouter initialEntries={[endereco]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ComissoesPage />
              <OndeEstou />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GAP-PRD-174 — o título da comissão é porta, e a porta abre', () => {
  it('a origem do título aponta para o fechamento', () => {
    expect(destinoDaOrigem('commission_closing', 'fech-1')).toBe(
      '/sistema/financeiro/comissoes?fechamento=fech-1',
    );
    // O avulso continua sem porta.
    expect(destinoDaOrigem('manual', 'x')).toBeNull();
  });

  it('chegando pelo link, a tela abre na aba Fechamentos com aquele fechamento aberto', async () => {
    montar('/sistema/financeiro/comissoes?fechamento=fech-1');

    expect(await screen.findByText('Fechamento — Joana Vendedora')).toBeTruthy();
    const linhas = screen.getByRole('table', { name: 'Linhas do fechamento' });
    expect(within(linhas).getByText('#11')).toBeTruthy();
    expect(within(linhas).getByText('#12')).toBeTruthy();
    expect(screen.getAllByText(/a pagar R\$\s?150,00/).length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: 'Fechamentos' }).getAttribute('aria-selected')).toBe('true');
  });

  it('pela lista: "Abrir" mostra o fechamento e escreve o endereço', async () => {
    montar('/sistema/financeiro/comissoes');
    fireEvent.click(screen.getByRole('tab', { name: 'Fechamentos' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir' }));

    await screen.findByText('Fechamento — Joana Vendedora');
    await waitFor(() =>
      expect(screen.getByTestId('endereco').textContent).toBe('/sistema/financeiro/comissoes?fechamento=fech-1'),
    );
    expect(urls.some((u) => u.includes('/core/commissions/closings/fech-1'))).toBe(true);
  });
});
