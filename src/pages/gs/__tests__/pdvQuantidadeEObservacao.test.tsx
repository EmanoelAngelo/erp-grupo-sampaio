/**
 * QUANTIDADE EDITÁVEL NA LINHA (GAP-V56) e OBSERVAÇÃO SEM window.prompt
 * (GAP-V58).
 *
 * Corrigir "2" para "3" depois do bipe exigia rebipar (soma) ou remover a
 * linha e recomeçar; a observação subia num prompt nativo — uma linha só, sem
 * estilo, bloqueando a aba, e desabilitado em alguns kiosks (a observação
 * sumia SEM erro).
 *
 * O que se cobra:
 *   - input de quantidade na linha (inteiro >= 1), refletido no POST;
 *   - produto SERIALIZADO fica de fora — a quantidade dele é o nº de peças
 *     escolhidas, e mexer no número sem escolher peça mentiria o chassi;
 *   - a observação sobe num diálogo da casa e continua indo no POST.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';
import FONTE from '../PdvPage.tsx?raw';

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
  serialized: 0,
};

const MOTO_SERIALIZADA = {
  ...CAMISETA,
  id: 'p-moto',
  internal_code: 'MT-0001',
  barcode: '7890000002222',
  name: 'Moto Elétrica Z',
  price_cents: 1200000,
  effective_price_cents: 1200000,
  serialized: 1,
};

const UNIDADE = {
  id: 'u-1',
  product_id: 'p-moto',
  status: 'in_stock',
  chassis: 'CHS-123',
  imei: null,
  plate: null,
  serial_number: null,
  motor_number: null,
  equipment_id: 'eq-1',
};

let vendasEnviadas: Record<string, unknown>[] = [];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      vendasEnviadas.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        JSON.stringify({ id: 's-1', number: 1, total_cents: 15000, change_cents: 0, status: 'completed', created_at: '' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const pedido = JSON.parse(String(init?.body ?? '{}')) as { items?: { productId: string }[] };
      const linhas = (pedido.items ?? [])
        .map((i) => [CAMISETA, MOTO_SERIALIZADA].find((p) => p.id === i.productId))
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
      corpo = { items: [CAMISETA, MOTO_SERIALIZADA].filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/units/p-moto')) {
      // As peças em estoque do produto serializado — é o que a linha mostra.
      corpo = { items: [UNIDADE] };
    } else if (alvo.includes('/core/units')) {
      corpo = { items: [] };
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

async function bipar(codigo: string) {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

describe('quantidade editável na linha do carrinho', () => {
  it('corrigir 1 para 3 muda o total e o POST — sem rebipar', async () => {
    montar();
    await bipar('7890000001111');

    fireEvent.change(screen.getByLabelText('Quantidade de Camiseta'), {
      target: { value: '3' },
    });
    // 3 × R$ 50,00 no total da venda.
    await screen.findByText('150,00');

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    const itens = vendasEnviadas[0].items as { quantity: number }[];
    expect(itens[0].quantity).toBe(3);
  });

  it('zero e lixo não entram: a linha fica na última quantidade válida', async () => {
    montar();
    await bipar('7890000001111');

    fireEvent.change(screen.getByLabelText('Quantidade de Camiseta'), {
      target: { value: '0' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    const itens = vendasEnviadas[0].items as { quantity: number }[];
    expect(itens[0].quantity).toBe(1);
  });

  it('produto serializado não ganha o campo — quantidade ali é o nº de peças escolhidas', async () => {
    montar();
    await bipar('7890000002222');

    expect(screen.queryByLabelText('Quantidade de Moto Elétrica Z')).toBeNull();
  });
});

describe('a observação sobe num diálogo da casa, não no prompt do navegador', () => {
  it('a fonte do PDV não usa mais window.prompt', () => {
    // O prompt nativo bloqueia a aba e alguns kiosks o desabilitam — a
    // observação sumia sem erro nenhum. O parêntese é o que separa a CHAMADA
    // do comentário que conta a história de por que ela saiu.
    expect(FONTE).not.toContain('window.prompt(');
  });

  it('escrever no diálogo põe a observação no POST da venda', async () => {
    montar();
    await bipar('7890000001111');

    fireEvent.click(screen.getByRole('button', { name: 'Observações (Alt+O)' }));
    const campo = await screen.findByLabelText('Observação da venda');
    fireEvent.change(campo, { target: { value: 'cliente busca às 18h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar observação' }));

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    expect(vendasEnviadas[0].note).toBe('cliente busca às 18h');
  });

  it('cancelar o diálogo não mexe na observação que já existia', async () => {
    montar();
    await bipar('7890000001111');

    fireEvent.click(screen.getByRole('button', { name: 'Observações (Alt+O)' }));
    fireEvent.change(await screen.findByLabelText('Observação da venda'), {
      target: { value: 'primeira' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar observação' }));

    fireEvent.click(screen.getByRole('button', { name: 'Observações (Alt+O)' }));
    fireEvent.change(await screen.findByLabelText('Observação da venda'), {
      target: { value: 'rascunho abandonado' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    expect(vendasEnviadas[0].note).toBe('primeira');
  });
});
