/**
 * PESQUISA AVANÇADA DE VERDADE — GAP-V57.
 *
 * "Pesq. avançada (F4)" era um rótulo em cima da MESMA busca textual: quem
 * clicava esperando filtros recebia o que já tinha — promessa de tela que não
 * existe, o padrão de defeito que a casa combate nos atalhos. Agora o rótulo
 * abre um diálogo com filtros de nome, código, código de barras e categoria
 * sobre o GET /core/products/search que sempre existiu.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const CAMISA_POLO = {
  id: 'p-polo',
  internal_code: 'CP-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Camisa Polo',
  category: 'Roupas',
  brand: null,
  unit: 'UN',
  cost_cents: 3000,
  price_cents: 8000,
  effective_price_cents: 8000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 5,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

const CAMISA_TIME = {
  ...CAMISA_POLO,
  id: 'p-time',
  internal_code: 'CT-0001',
  barcode: '7890000002222',
  name: 'Camisa de Time',
  category: 'Esportes',
};

/** As buscas que chegaram ao servidor, na ordem. */
let buscas: string[] = [];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const pedido = JSON.parse(String(init?.body ?? '{}')) as { items?: { productId: string }[] };
      const linhas = (pedido.items ?? [])
        .map((i) => [CAMISA_POLO, CAMISA_TIME].find((p) => p.id === i.productId))
        .filter((p): p is typeof CAMISA_POLO => Boolean(p))
        .map((p) => ({
          productId: p.id,
          priceCents: p.effective_price_cents,
          listPriceCents: p.price_cents,
          onSale: false,
          fonte: 'cadastro',
        }));
      return new Response(JSON.stringify({ items: linhas, priceTable: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      buscas.push(q);
      corpo = {
        items: [CAMISA_POLO, CAMISA_TIME].filter(
          (p) =>
            p.name.toLowerCase().includes(q.toLowerCase())
            || p.barcode === q
            || p.internal_code === q,
        ),
      };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/sellers')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/units')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  buscas = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

describe('o rótulo abre uma pesquisa avançada de verdade', () => {
  it('o botão abre o diálogo com os quatro filtros', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: /Pesq\. avançada \(F4\)/ }));

    await screen.findByRole('dialog', { name: 'Pesquisa avançada de produtos' });
    expect(screen.getByLabelText('Nome do produto')).toBeTruthy();
    expect(screen.getByLabelText('Código interno')).toBeTruthy();
    expect(screen.getByLabelText('Código de barras')).toBeTruthy();
    expect(screen.getByLabelText('Categoria')).toBeTruthy();
  });

  it('F4 abre o mesmo diálogo — a tecla e o rótulo prometem a mesma coisa', async () => {
    montar();
    fireEvent.keyDown(window, { key: 'F4' });
    await screen.findByRole('dialog', { name: 'Pesquisa avançada de produtos' });
  });

  it('a categoria FILTRA: buscar "camisa" em Roupas esconde a de Esportes', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: /Pesq\. avançada \(F4\)/ }));
    await screen.findByRole('dialog', { name: 'Pesquisa avançada de produtos' });

    fireEvent.change(screen.getByLabelText('Nome do produto'), { target: { value: 'camisa' } });
    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'roupas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    await screen.findByText('Camisa Polo');
    expect(buscas).toContain('camisa');
    // A camisa de time casa no nome e NÃO na categoria — se ela aparecer, o
    // filtro é decorativo, que é exatamente o defeito que este diálogo mata.
    expect(screen.queryByText('Camisa de Time')).toBeNull();
  });

  it('escolher um resultado põe o produto no carrinho e fecha o diálogo', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: /Pesq\. avançada \(F4\)/ }));
    await screen.findByRole('dialog', { name: 'Pesquisa avançada de produtos' });
    fireEvent.change(screen.getByLabelText('Nome do produto'), { target: { value: 'polo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    fireEvent.click(await screen.findByText('Camisa Polo'));

    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: 'Remover Camisa Polo' })).toHaveLength(1),
    );
    expect(screen.queryByRole('dialog', { name: 'Pesquisa avançada de produtos' })).toBeNull();
  });
});
