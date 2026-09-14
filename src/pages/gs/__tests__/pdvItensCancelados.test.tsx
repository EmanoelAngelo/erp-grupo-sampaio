/**
 * ITENS CANCELADOS NO PDV — o rodapé para de mentir (GAP-V52/V63).
 *
 * O rodapé mostrava "Itens cancelados: 0" com um LITERAL: o operador podia
 * bipar, mostrar o total ao cliente, remover a linha e fechar por menos — e o
 * gestor, olhando a tela, achava que o número existia. Pior que não ter.
 *
 * O que este arquivo cobra, montando o PDV de verdade com a rede dublada:
 *
 *   - o contador conta AO VIVO, na quantidade removida;
 *   - a finalização envia os cancelados no POST /core/sales (cancelledItems);
 *   - a venda seguinte começa zerada — rastro de um cliente não vaza pro outro.
 *
 * Venda abandonada sem finalizar NÃO persiste (o carrinho é local — decisão
 * documentada no servidor, em core_sale_removed_items).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const CAMISETA = {
  id: 'p-camiseta',
  internal_code: 'CM-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Camiseta',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 2000,
  price_cents: 5000,
  effective_price_cents: 5000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

const BERMUDA = {
  ...CAMISETA,
  id: 'p-bermuda',
  internal_code: 'BM-0001',
  barcode: '7890000002222',
  name: 'Bermuda',
  price_cents: 4990,
  effective_price_cents: 4990,
};

/** Corpos de todos os POST /core/sales, na ordem em que saíram. */
let vendasEnviadas: Record<string, unknown>[] = [];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      vendasEnviadas.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        JSON.stringify({ id: 's-1', number: 1, total_cents: 5000, change_cents: 0, status: 'completed', created_at: '' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const pedido = JSON.parse(String(init?.body ?? '{}')) as { items?: { productId: string }[] };
      const linhas = (pedido.items ?? [])
        .map((i) => [CAMISETA, BERMUDA].find((p) => p.id === i.productId))
        .filter((p): p is typeof CAMISETA => Boolean(p))
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
      corpo = { items: [CAMISETA, BERMUDA].filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/sellers')) {
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
  vendasEnviadas = [];
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

async function bipar(codigo: string, quantidade?: string) {
  if (quantidade !== undefined) {
    const campos = screen.getAllByLabelText(/^Quantidade$/);
    fireEvent.change(campos[0], { target: { value: quantidade } });
  }
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

/** O valor escrito no rodapé, ao lado de "Itens cancelados:". */
function contadorDeCancelados(): string {
  return screen.getByText('Itens cancelados:').parentElement!.querySelector('strong')!
    .textContent!;
}

describe('o contador conta ao vivo', () => {
  it('começa em zero e sobe com a QUANTIDADE removida, não com o clique', async () => {
    montar();
    expect(contadorDeCancelados()).toBe('0');

    await bipar('7890000001111', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Camiseta' }));

    // Removeu uma linha de DUAS unidades: são 2 itens cancelados.
    await waitFor(() => expect(contadorDeCancelados()).toBe('2'));
  });

  it('acumula remoções de linhas diferentes', async () => {
    montar();
    await bipar('7890000001111');
    await bipar('7890000002222');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Camiseta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remover Bermuda' }));

    await waitFor(() => expect(contadorDeCancelados()).toBe('2'));
  });
});

describe('os cancelados viajam na finalização', () => {
  it('o POST /core/sales leva cancelledItems com produto, quantidade e preço', async () => {
    montar();
    await bipar('7890000001111', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Camiseta' }));
    await bipar('7890000002222');

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));

    const cancelados = vendasEnviadas[0].cancelledItems as {
      productId: string;
      name: string;
      quantity: number;
      unitPriceCents: number;
      removedAt: string;
    }[];
    expect(cancelados).toHaveLength(1);
    expect(cancelados[0].productId).toBe('p-camiseta');
    expect(cancelados[0].name).toBe('Camiseta');
    expect(cancelados[0].quantity).toBe(2);
    expect(cancelados[0].unitPriceCents).toBe(5000);
    expect(cancelados[0].removedAt).toBeTruthy();
  });

  it('depois de fechar, o contador volta a zero para o próximo cliente', async () => {
    montar();
    await bipar('7890000001111');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Camiseta' }));
    await bipar('7890000002222');
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    await waitFor(() => expect(contadorDeCancelados()).toBe('0'));
  });

  it('cancelar a venda (F6) zera o rastro — a venda seguinte sai limpa', async () => {
    montar();
    await bipar('7890000001111');
    fireEvent.click(screen.getByRole('button', { name: 'Remover Camiseta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar (F6)' }));
    await waitFor(() => expect(contadorDeCancelados()).toBe('0'));

    await bipar('7890000002222');
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));

    // O carrinho cancelado morreu com o rastro dele: a venda nova não carrega
    // cancelamento nenhum — rastro de cliente não vaza para o próximo.
    const corpo = vendasEnviadas[0];
    expect(corpo.cancelledItems ?? []).toHaveLength(0);
  });
});
