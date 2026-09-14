/**
 * DESCONTO DIGITÁVEL NO PDV — GAP-V54.
 *
 * O caixa que precisava dar R$ 5,00 redondos recalculava preço unitário item a
 * item: não havia campo de desconto nem no rodapé nem na linha. O backend
 * inteiro (discountCents de cabeçalho e de linha, alçada, auditoria) sempre
 * esteve pronto — faltava o emissor na tela.
 *
 * O que se cobra aqui, com o PDV montado e a rede dublada:
 *
 *   - desconto de RODAPÉ em R$ e em % viaja como discountCents no POST;
 *   - desconto POR ITEM viaja como items[].discountCents;
 *   - dentro da alçada a venda passa; acima, o 403 do servidor abre o diálogo
 *     do gestor e a liberação volta no reenvio — a autoridade é o SERVIDOR.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const MOTO = {
  id: 'p-moto',
  internal_code: 'MT-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Moto Honda CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 900000,
  price_cents: 1200000,
  effective_price_cents: 1200000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 2,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

let vendasEnviadas: Record<string, unknown>[] = [];
let autorizacoesPedidas: Record<string, unknown>[] = [];
/** As respostas do POST /core/sales, consumidas em ordem. */
let respostasDaVenda: { status: number; body: unknown }[] = [];

const VENDA_OK = {
  status: 201,
  body: { id: 's-1', number: 1, total_cents: 1150000, change_cents: 0, status: 'completed', created_at: '' },
};

const RECUSA_DE_ALCADA = {
  status: 403,
  body: {
    error: {
      code: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
      message: 'Esta venda concede R$ 2.000,00 sobre R$ 12.000,00 (16.67%).',
      details: {
        percentual: 16.67,
        concedidoCents: 200000,
        brutoCents: 1200000,
        origens: { cabecalho: 200000, itens: 0, precoRebaixado: 0 },
        limite: 10,
      },
    },
  },
};

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      vendasEnviadas.push(JSON.parse(String(init?.body ?? '{}')));
      const resposta = respostasDaVenda.shift() ?? VENDA_OK;
      return new Response(JSON.stringify(resposta.body), {
        status: resposta.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (alvo.includes('/core/authorizations') && metodo === 'POST') {
      autorizacoesPedidas.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        JSON.stringify({ id: 'aut-1', action: 'desconto_acima_limite', authorizedBy: 'g-1' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const pedido = JSON.parse(String(init?.body ?? '{}')) as { items?: { productId: string }[] };
      const linhas = (pedido.items ?? [])
        .filter((i) => i.productId === MOTO.id)
        .map(() => ({
          productId: MOTO.id,
          priceCents: MOTO.effective_price_cents,
          listPriceCents: MOTO.price_cents,
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
      corpo = { items: MOTO.barcode === q ? [MOTO] : [] };
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
  autorizacoesPedidas = [];
  respostasDaVenda = [];
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

async function biparMoto() {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: '7890000001111' } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

describe('o desconto de rodapé, digitado em reais ou em porcentagem', () => {
  it('R$ digitado abate do total na tela e viaja como discountCents', async () => {
    montar();
    await biparMoto();

    fireEvent.change(screen.getByLabelText('Desconto da venda (R$ ou %)'), {
      target: { value: '500' },
    });

    // A tela abate na hora (prévia); a palavra final continua com o servidor.
    await screen.findByText('11.500,00');

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    expect(vendasEnviadas[0].discountCents).toBe(50000);
  });

  it('porcentagem converte sobre o subtotal — 10% de R$ 12.000 são R$ 1.200', async () => {
    montar();
    await biparMoto();

    fireEvent.change(screen.getByLabelText('Desconto da venda (R$ ou %)'), {
      target: { value: '10%' },
    });
    await screen.findByText('10.800,00');

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    expect(vendasEnviadas[0].discountCents).toBe(120000);
  });

  it('dentro da alçada a venda passa sem gestor', async () => {
    montar();
    await biparMoto();
    fireEvent.change(screen.getByLabelText('Desconto da venda (R$ ou %)'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    await screen.findByText(/Venda #1 finalizada/);
    // O total anunciado é o do SERVIDOR, não a conta da tela.
    expect(screen.getByText(/Venda #1 finalizada/).textContent).toContain(formatCents(1150000));
    expect(screen.queryByText('Autorização do gestor')).toBeNull();
  });
});

describe('acima da alçada, o 403 do servidor abre o diálogo do gestor', () => {
  it('a recusa vira pedido de liberação, e a liberação volta no reenvio', async () => {
    respostasDaVenda = [RECUSA_DE_ALCADA, VENDA_OK];
    montar();
    await biparMoto();
    fireEvent.change(screen.getByLabelText('Desconto da venda (R$ ou %)'), {
      target: { value: '2000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    // O diálogo que já existia para o preço rebaixado atende o desconto novo.
    await screen.findByText('Autorização do gestor');
    fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'GERENTE1' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-forte' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    await waitFor(() => expect(vendasEnviadas).toHaveLength(2));
    // A liberação concedida viaja no reenvio — é ela que o servidor consome.
    expect(vendasEnviadas[1].authorizationId).toBe('aut-1');
    // E o pedido de liberação levou os NÚMEROS, não só a frase.
    expect(autorizacoesPedidas[0].concedidoCents).toBe(200000);
  });
});

describe('o desconto por item, na própria linha', () => {
  it('viaja como items[].discountCents e abate no total da linha', async () => {
    montar();
    await biparMoto();

    fireEvent.change(screen.getByLabelText('Desconto de Moto Honda CG 160'), {
      target: { value: '500' },
    });
    await screen.findByText('11.500,00');

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendasEnviadas).toHaveLength(1));
    const itens = vendasEnviadas[0].items as { discountCents?: number }[];
    expect(itens[0].discountCents).toBe(50000);
  });

  it('a concessão prevista soma o desconto da linha — o painel avisa antes do 403', async () => {
    montar();
    await biparMoto();
    // R$ 2.000 na linha de uma moto de R$ 12.000: 16,67%, acima dos 10%.
    fireEvent.change(screen.getByLabelText('Desconto de Moto Honda CG 160'), {
      target: { value: '2000' },
    });

    const caixa = (await screen.findByText(/Concessão nesta venda/i)).parentElement!;
    expect(caixa.textContent).toContain('de desconto nos itens');
    expect(caixa.textContent).toContain('Acima do limite de 10%');
  });
});
