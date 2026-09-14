/**
 * ============================================================================
 * O ORÇAMENTO CHEGA AO BALCÃO — GAP-V68
 * ============================================================================
 *
 * `POST /core/quotes/:id/convert` sempre aceitou orçamento, sempre foi testado
 * e herda a mesma idempotência da pré-venda. O que não existia era o caminho
 * pela TELA: o F9 filtrava `kind: 'pre_venda'` e a tela de orçamentos não
 * oferecia nada.
 *
 * O custo era do operador, e ele é maior do que parece. O cliente que fecha na
 * hora obrigava DOIS passos — Aprovar, que cria pré-venda e RESERVA mercadoria
 * por sete dias, e só então F9 — ou fazia o balcão redigitar tudo, que é como o
 * preço aprovado se perde e como a alçada do documento vira decoração.
 *
 * Este arquivo cobra os dois caminhos que a rodada abriu:
 *
 *   1. O F9 lista orçamento aberto, e a linha DIZ que ele não reservou nada.
 *      Chamar tudo de "pré-venda" seria mentir na tela mais consultada do
 *      balcão: quem lê "mercadoria reservada" sobre um orçamento se surpreende
 *      quando faltar saldo no Finalizar.
 *   2. `/pdv?documento=<id>` carrega o documento pelo MESMO caminho do F9 — é a
 *      mão que a tela de orçamentos dá com o botão "Faturar".
 *
 * ## Como estes guardas falham (quebrando de propósito)
 *
 *   - volte `kind: 'pre_venda'` em `openQuotes` → o orçamento some da lista;
 *   - tire o efeito que lê `documento` da URL → o botão Faturar leva a um PDV
 *     vazio, que é pior que não ter botão.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const PRODUTO = {
  id: 'p-1',
  internal_code: 'LJ-0001',
  sku: null,
  barcode: '789',
  name: 'Vestido longo',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 8000,
  price_cents: 20000,
  effective_price_cents: 20000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
};

const ORCAMENTO = {
  id: 'q-orc',
  number: 47,
  kind: 'orcamento',
  status: 'aberto',
  customer_id: null,
  total_cents: 40000,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

const PRE_VENDA = { ...ORCAMENTO, id: 'q-pre', number: 12, kind: 'pre_venda' };

/** Toda URL que a listagem de documentos recebeu — prova o filtro do F9. */
let consultas: string[] = [];

function servidor() {
  consultas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/cash/current')) return json(CAIXA_ABERTO);
      if (alvo.includes('/core/cash')) return json({ items: [] });
      if (alvo.includes('/core/sellers')) return json({ items: [] });
      if (alvo.includes('/core/customers')) return json({ items: [] });
      if (alvo.match(/\/core\/products\/p-1$/)) return json(PRODUTO);
      if (alvo.includes('/core/products/search')) return json({ items: [PRODUTO] });

      const detalhe = alvo.match(/\/core\/quotes\/([^/?]+)$/);
      if (detalhe && metodo === 'GET') {
        const base = detalhe[1] === 'q-pre' ? PRE_VENDA : ORCAMENTO;
        return json({
          ...base,
          expired: false,
          liberacao: null,
          items: [
            {
              id: 'i-1',
              product_id: 'p-1',
              description: 'Vestido longo',
              quantity: 2,
              unit_price_cents: 20000,
              total_cents: 40000,
            },
          ],
        });
      }
      if (alvo.includes('/core/quotes')) {
        consultas.push(alvo);
        return json({ items: [ORCAMENTO, PRE_VENDA] });
      }

      return json({});
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('o F9 mostra os DOIS documentos, e diz qual é qual', () => {
  it('o orçamento aberto aparece na lista', async () => {
    render(
      <MemoryRouter initialEntries={['/pdv']}>
        <PdvPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda \(F9\)/ }));

    // Com o filtro antigo (`kind: 'pre_venda'`) esta linha não existia.
    expect(await screen.findByRole('button', { name: /Orçamento #47/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pré-venda #12/ })).toBeTruthy();
  });

  it('a consulta NÃO filtra por tipo — era o filtro que escondia o orçamento', async () => {
    render(
      <MemoryRouter initialEntries={['/pdv']}>
        <PdvPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda \(F9\)/ }));
    await screen.findByRole('button', { name: /Orçamento #47/ });

    const lista = consultas.find((c) => c.includes('status=aberto'));
    expect(lista).toBeTruthy();
    expect(lista).not.toContain('kind=pre_venda');
  });

  it('a linha diz que o orçamento NÃO reservou mercadoria', async () => {
    render(
      <MemoryRouter initialEntries={['/pdv']}>
        <PdvPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda \(F9\)/ }));

    const linha = await screen.findByRole('button', { name: /Orçamento #47/ });
    expect(linha.textContent).toContain('sem reserva');
    const daPreVenda = screen.getByRole('button', { name: /Pré-venda #12/ });
    expect(daPreVenda.textContent).toContain('mercadoria reservada');
  });
});

describe('a mão dada pela tela de orçamentos', () => {
  it('/pdv?documento=<id> abre o balcão com o documento carregado', async () => {
    render(
      <MemoryRouter initialEntries={['/pdv?documento=q-orc']}>
        <PdvPage />
      </MemoryRouter>,
    );

    // A faixa que diz de quem é o carrinho — e ela não pode prometer reserva
    // que o orçamento não fez.
    await waitFor(() =>
      expect(screen.getByText(/orçamento #47/i)).toBeTruthy(),
    );
    expect(screen.getByText(/NÃO reserva mercadoria/i)).toBeTruthy();
  });

  it('sem o parâmetro, o balcão abre vazio como sempre', async () => {
    render(
      <MemoryRouter initialEntries={['/pdv']}>
        <PdvPage />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /Pré-venda \(F9\)/ });
    expect(screen.queryByText(/orçamento #47/i)).toBeNull();
  });
});
