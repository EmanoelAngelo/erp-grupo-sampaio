/**
 * ============================================================================
 * A PRÉ-VENDA CUJA TENTATIVA JÁ REGISTROU OUTRA VENDA (R2-IDEM, item 4)
 * ============================================================================
 *
 * A conversão da pré-venda (`POST /core/quotes/:id/convert`) desce a chave com
 * o documento no nome (`quote:<id>:<chave>`), e o servidor recusa a MESMA
 * chave com outro pedido (422 CORE_IDEMPOTENCY_KEY_REUSED). O PDV tratava a
 * recusa pelo código no ramo comum da venda (8e46c01), mas o caminho da
 * pré-venda — o `if (loadedQuote)` do finalizar — nunca tinha sido medido pela
 * tela.
 *
 * O 422 só chega com o documento ainda ABERTO (a pré-venda já faturada é 409
 * CORE_QUOTE_ALREADY_CONVERTED antes de qualquer venda — QuoteService,
 * `convertQuote`), então "registrar como venda nova" é uma saída que passa: a
 * conversão sai com chave nova e fatura o documento.
 *
 * O que estes casos cobram, pela conversão:
 *   - a recusa vira o diálogo da casa, na língua do caixa, com o número da
 *     venda; nada é reenviado sem a escolha;
 *   - "Registrar como venda nova" converte o documento com OUTRA chave;
 *   - "Voltar ao carrinho" não converte nada, e o documento continua carregado.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const SESSAO_KEY = 'gs.session';

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
  open_price: 0,
};

const PRE_VENDA = {
  id: 'q-pre',
  number: 12,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: null,
  total_cents: 40000,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

const TEXTO_DO_SERVIDOR =
  'Esta chave de idempotência já registrou a venda #7, com outra mercadoria ou outro pagamento — nada foi '
  + 'registrado agora. Uma venda nova precisa de chave nova.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** As chaves de cada conversão, na ordem. */
let chavesDaConversao: string[];
let chaveOcupada: string | null;

function servidor() {
  return vi.fn(
    async (url: string | URL | Request, init?: { method?: string; headers?: Record<string, string> }) => {
      const barra = respostaDaBarraDoShell(url);
      if (barra) return barra;
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();

      if (/\/core\/quotes\/q-pre\/convert$/.test(alvo) && metodo === 'POST') {
        const chave = new Headers(init?.headers).get('Idempotency-Key') ?? '';
        chavesDaConversao.push(chave);
        chaveOcupada ??= chave;
        if (chave === chaveOcupada) {
          return json(
            { error: { code: 'CORE_IDEMPOTENCY_KEY_REUSED', message: TEXTO_DO_SERVIDOR, details: { saleId: 's-7', saleNumber: 7 } } },
            422,
          );
        }
        return json({ saleId: 's-8', number: 8 }, 201);
      }
      if (/\/core\/quotes\/q-pre$/.test(alvo) && metodo === 'GET') {
        return json({
          ...PRE_VENDA,
          expired: false,
          liberacao: null,
          items: [
            { id: 'i-1', product_id: 'p-1', description: 'Vestido longo', quantity: 2, unit_price_cents: 20000, total_cents: 40000 },
          ],
        });
      }
      if (alvo.includes('/core/quotes')) return json({ items: [PRE_VENDA] });
      if (alvo.includes('/core/sales/s-7') && metodo === 'GET') {
        return json({
          id: 's-7',
          number: 7,
          total_cents: 20000,
          change_cents: 0,
          status: 'completed',
          created_at: '2026-09-13T10:00:00.000Z',
          subtotal_cents: 20000,
          discount_cents: 0,
          surcharge_cents: 0,
          seller_id: null,
          note: null,
          items: [{ id: 'i-9', product_id: 'p-1', description: 'Vestido longo', quantity: 1, unit_price_cents: 20000, total_cents: 20000 }],
          payments: [],
          customerCreditCents: 0,
          removedItems: [],
          financeEntries: [],
        });
      }
      if (alvo.includes('/core/cash/open') && metodo === 'GET') {
        return json({ session: { id: 'sessao-1', opening_cents: 5000, status: 'aberto' }, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/summary')) return json({ expectedCents: 5000, byMethod: [], movements: [] });
      if (alvo.includes('/core/fiscal/pdv-summary')) return json({ situacao: 'READY', pendencyCount: 0, motivos: [] });
      if (/\/core\/products\/p-1$/.test(alvo)) return json(PRODUTO);
      if (alvo.includes('/core/products/search')) return json({ items: [PRODUTO] });
      return json({ items: [] });
    },
  );
}

async function converterERecusar() {
  render(
    <MemoryRouter initialEntries={['/pdv?documento=q-pre']}>
      <PdvPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getAllByText(/pré-venda #12/i)[0]).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
  return screen.findByRole('dialog', { name: /já registrou/i });
}

beforeEach(() => {
  chavesDaConversao = [];
  chaveOcupada = null;
  localStorage.setItem(
    SESSAO_KEY,
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a conversão da pré-venda recusada pela chave reusada', () => {
  it('vira o diálogo da casa, na língua do caixa — e nada é reenviado sem a escolha', async () => {
    const dialogo = await converterERecusar();
    expect(dialogo.textContent).toContain('Esta tentativa já registrou a venda #7, com outros itens.');
    expect(dialogo.textContent).toMatch(/nada foi registrado agora/i);
    expect(screen.queryByText(/idempot/i)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(chavesDaConversao).toHaveLength(1);
    // O documento continua carregado: nada se perdeu.
    expect(screen.getAllByText(/pré-venda #12/i)[0]).toBeTruthy();
  });

  it('"Registrar como venda nova" converte o documento com OUTRA chave', async () => {
    const dialogo = await converterERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Registrar como venda nova/i }));

    expect(await screen.findByText(/#12 faturad[oa] — venda #8/i)).toBeTruthy();
    expect(chavesDaConversao).toHaveLength(2);
    expect(chavesDaConversao[1]).not.toBe('');
    expect(chavesDaConversao[1]).not.toBe(chavesDaConversao[0]);
    expect(screen.queryByRole('dialog', { name: /já registrou/i })).toBeNull();
  });

  it('"Voltar ao carrinho" não converte nada, e o documento fica', async () => {
    const dialogo = await converterERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar ao carrinho/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já registrou/i })).toBeNull());
    expect(chavesDaConversao).toHaveLength(1);
    expect(screen.getAllByText(/pré-venda #12/i)[0]).toBeTruthy();
  });

  it('"Ver a venda #7" mostra o que ela registrou, sem converter', async () => {
    const dialogo = await converterERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Ver a venda #7/i }));
    const resumo = await within(dialogo).findByTestId('venda-da-tentativa');
    expect(resumo.textContent).toMatch(/1\s*×\s*Vestido longo/);
    expect(chavesDaConversao).toHaveLength(1);
  });
});
