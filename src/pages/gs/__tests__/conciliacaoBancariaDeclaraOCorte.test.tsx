/**
 * A CONCILIAÇÃO BANCÁRIA DIZ "MOSTRANDO X DE Y" (GAP-PRD-177).
 *
 * A lista de trabalho cortava em 500 linhas sem aviso: num mês cheio, o fim do
 * extrato — com as pendências dele — sumia da tela. Agora a tela pede as
 * pendentes e as casadas em páginas separadas, mostra quantas existem de
 * verdade e busca o resto sob pedido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConciliacaoBancariaPage from '../ConciliacaoBancariaPage';
import { setSession } from '@/lib/api/client';

const RELATORIO = {
  from: '2026-08-01',
  to: '2026-08-31',
  bankTotalCents: 0,
  financeTotalCents: 0,
  differenceCents: 0,
  matched: 0,
  divergences: [],
};

function linha(i: number, casada = false) {
  return {
    id: `l-${casada ? 'c' : 'p'}-${i}`,
    occurred_at: '2026-08-10',
    description: `${casada ? 'Casada' : 'Pendente'} ${i}`,
    amount_cents: 1000 + i,
    document: null,
    matched_settlement_id: casada ? `b-${i}` : null,
    matched_at: casada ? '2026-08-11T12:00:00.000Z' : null,
    matched_by_name: casada ? 'Fulano' : null,
  };
}

const PENDENTES = Array.from({ length: 7 }, (_, i) => linha(i + 1));
const PAGINA = 5;
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
      if (alvo.includes('/core/bank/conciliacao')) return json(RELATORIO);
      if (alvo.includes('/core/bank/lines')) {
        const offset = Number(new URL(alvo, 'http://x').searchParams.get('offset') ?? 0);
        if (alvo.includes('onlyMatched=true')) {
          const casadas = [linha(1, true)];
          return json({ items: casadas, total: 1, limit: PAGINA, offset: 0, truncated: false });
        }
        const items = PENDENTES.slice(offset, offset + PAGINA);
        return json({
          items,
          total: PENDENTES.length,
          limit: PAGINA,
          offset,
          truncated: offset + items.length < PENDENTES.length,
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
    'teste do corte da conciliação',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do corte da conciliação');
});

describe('GAP-PRD-177 — a lista de trabalho declara o corte', () => {
  it('diz quantas pendências existem além das mostradas, e busca o resto', async () => {
    render(
      <MemoryRouter>
        <ConciliacaoBancariaPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(/Mostrando 5 de 7 linhas sem conciliação/),
    ).toBeTruthy();
    expect(screen.queryByText('Pendente 7')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));

    await waitFor(() => expect(screen.getByText('Pendente 7')).toBeTruthy());
    expect(screen.queryByText(/Mostrando .* linhas sem conciliação/)).toBeNull();
    expect(urls.some((u) => u.includes('onlyUnmatched=true') && u.includes('offset=5'))).toBe(true);
  });

  it('pede pendentes e casadas separadas — as casadas não empurram as pendentes para fora', async () => {
    render(
      <MemoryRouter>
        <ConciliacaoBancariaPage />
      </MemoryRouter>,
    );
    await screen.findByText('Linhas conciliadas');
    expect(urls.some((u) => u.includes('/core/bank/lines') && u.includes('onlyUnmatched=true'))).toBe(true);
    expect(urls.some((u) => u.includes('/core/bank/lines') && u.includes('onlyMatched=true'))).toBe(true);
    // A lista das casadas coube inteira: nenhum aviso para ela.
    expect(screen.queryByText(/linhas conciliadas\. O resumo/)).toBeNull();
  });
});
