/**
 * ============================================================================
 * PEDIDO DE COMPRA COM PRODUTO DO CATÁLOGO — a ponta que faltava do GAP-V16
 * ============================================================================
 *
 * O sintoma: a ÚNICA tela de criação de pedido só tinha descrição livre, então
 * todo pedido nascia com product_id NULL em todos os itens. `recalcReceived`
 * casa por product_id — o "Recebido" ficava 0 e o pedido preso em 'enviado'
 * PARA SEMPRE, mesmo com notas amarradas e confirmadas. A conciliação inteira
 * (provada verde em audit-purchase.test.ts com pedidos criados por API) era
 * inalcançável pela interface.
 *
 * Estes casos cobram a tela:
 *
 *  1. a linha do pedido tem BUSCA no catálogo (o padrão das outras telas —
 *     MovimentacoesEstoquePage, OrcamentosPage), e escolher um produto faz o
 *     POST viajar com `productId` — é o que liga a tela ao ciclo
 *     pedido→XML→amarrar→recalc já provado no servidor;
 *  2. a descrição LIVRE continua sendo caminho legítimo (embalagem, café —
 *     decisão documentada no serviço): linha sem produto viaja só com a
 *     descrição, sem productId inventado;
 *  3. escolher o produto pré-preenche o custo com o custo do cadastro — que o
 *     comprador pode sobrescrever, porque o combinado é dele.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PedidosCompraPage from '../PedidosCompraPage';

const FORNECEDOR = {
  id: 'f-1',
  name: 'Distribuidora Riacho Ltda',
  trade_name: 'Riacho Autopeças',
  document: '14200166000187',
  delivery_days: 5,
  payment_term_days: 30,
  active: 1,
};

const PASTILHA = {
  id: 'p-pastilha',
  internal_code: 'PST-01',
  sku: null,
  barcode: null,
  name: 'Pastilha de freio',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 2500,
  price_cents: 9900,
  min_stock: 0,
  active: 1,
};

interface Chamada {
  method?: string;
  body?: string;
}

let fetchMock: ReturnType<typeof vi.fn>;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: Chamada) => {
    const alvo = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (init?.method === 'POST' && alvo.includes('/core/purchase-orders')) {
      return json({ id: 'o-1', number: 7, status: 'rascunho', total_cents: 0 }, 201);
    }
    if (alvo.includes('/core/products/search')) {
      return json({ items: [PASTILHA] });
    }
    if (alvo.includes('/core/purchase-orders')) return json({ items: [] });
    if (alvo.includes('/core/suppliers')) return json({ items: [FORNECEDOR] });
    return json({ items: [] });
  });
}

function entrar() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do pedido com catálogo',
  );
}

beforeEach(() => {
  localStorage.clear();
  fetchMock = servidor();
  vi.stubGlobal('fetch', fetchMock);
  entrar();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirFormulario() {
  render(
    <MemoryRouter>
      <PedidosCompraPage />
    </MemoryRouter>,
  );
  const novo = (await screen.findByRole('button', { name: 'Novo pedido' })) as HTMLButtonElement;
  // O botão destrava quando a lista de fornecedores chega.
  await waitFor(() => expect(novo.disabled).toBe(false));
  fireEvent.click(novo);
  // O fornecedor é obrigatório nos dois cenários.
  const seletor = (await screen.findByLabelText(/Fornecedor/)) as HTMLSelectElement;
  fireEvent.change(seletor, { target: { value: 'f-1' } });
}

function escritas(): [string, Record<string, unknown>][] {
  return (fetchMock.mock.calls as [unknown, Chamada?][])
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => [
      String(url),
      JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    ]);
}

describe('a linha do pedido busca no catálogo', () => {
  it('escolher um produto manda productId no POST — o ciclo pedido×nota nasce ligado', async () => {
    await abrirFormulario();

    // A busca da linha: digitar acha no catálogo, como nas outras telas.
    const busca = screen.getByLabelText(/Produto do catálogo do item 1/);
    fireEvent.change(busca, { target: { value: 'pastilha' } });
    const opcao = await screen.findByRole('button', { name: /Pastilha de freio · PST-01/ });
    fireEvent.click(opcao);

    // O custo veio do cadastro (R$ 25,00) — sugestão, não algema.
    const custo = screen.getByLabelText(/Custo unitário do item 1/) as HTMLInputElement;
    expect(custo.value).toBe('25');

    const qtd = screen.getByLabelText(/Quantidade do item 1/);
    fireEvent.change(qtd, { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho' }));

    await waitFor(() => {
      const chamada = escritas().find(([url]) => url.includes('/core/purchase-orders'));
      expect(chamada, 'nenhum POST em /core/purchase-orders').toBeTruthy();
      const items = chamada![1].items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      // O CONSERTO: o item viaja amarrado ao catálogo.
      expect(items[0].productId).toBe('p-pastilha');
      expect(items[0].quantity).toBe(10);
      expect(items[0].unitCostCents).toBe(2500);
    });
  });

  it('descrição livre continua legítima: linha sem produto viaja SEM productId', async () => {
    await abrirFormulario();

    const descricao = screen.getByLabelText(/Descrição livre do item 1/);
    fireEvent.change(descricao, { target: { value: 'Café para a copa' } });
    const qtd = screen.getByLabelText(/Quantidade do item 1/);
    fireEvent.change(qtd, { target: { value: '2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho' }));

    await waitFor(() => {
      const chamada = escritas().find(([url]) => url.includes('/core/purchase-orders'));
      expect(chamada, 'nenhum POST em /core/purchase-orders').toBeTruthy();
      const items = chamada![1].items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Café para a copa');
      // Sem produto escolhido não se inventa vínculo.
      expect(items[0].productId ?? null).toBeNull();
    });
  });

  it('desfazer a escolha do produto devolve a linha ao texto livre', async () => {
    await abrirFormulario();

    const busca = screen.getByLabelText(/Produto do catálogo do item 1/);
    fireEvent.change(busca, { target: { value: 'pastilha' } });
    fireEvent.click(await screen.findByRole('button', { name: /Pastilha de freio · PST-01/ }));

    // O vínculo aparece — e tem como sair dele.
    fireEvent.click(screen.getByRole('button', { name: /remover produto do item 1/i }));
    expect(screen.getByLabelText(/Produto do catálogo do item 1/)).toBeTruthy();
  });
});
