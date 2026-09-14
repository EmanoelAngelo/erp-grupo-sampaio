/**
 * ============================================================================
 * REVISÃO DA TRILHA PDV — dois furos dos consertos G-offline-sync-02 e M01
 * ============================================================================
 *
 * G-offline-sync-02 (revisão) — A LEMBRANÇA DA GAVETA NÃO SEGUIA O CAIXA. Só a
 * releitura de `/cash/open` gravava a última gaveta confirmada. Fechar o turno
 * AQUI (F3 › Fechar) deixava guardada a sessão que acabou de fechar: com o
 * servidor fora no F5 seguinte, a tela punha "Caixa aberto" e mandava a venda
 * para a fila com a gaveta FECHADA — que o reenvio recusa. E a gaveta aberta
 * aqui não virava lembrança: o F5 na queda voltava a mandar venda sem gaveta.
 * Como fica vermelho: tire o `gravarUltimoCaixa` do `onChanged` do
 * `CaixaPdvDialog` no `PdvPage.tsx`.
 *
 * G-offline-sync-M01 (revisão) — O PREÇO ANTES DE COBRAR NÃO TINHA PRAZO. O
 * Finalizar passou a esperar a pergunta de preço por quantidade; a consulta de
 * preço não tem prazo (só a venda tem, e vai para a fila depois dele). Servidor
 * travado — aceita a conexão e não responde — e o F8 de dois sabonetes ficava
 * parado para sempre, sem nem tentar a fila. Como fica vermelho: troque o
 * `comPrazo(...)` de `precoDoCarrinhoEmDia` por `await precoNoAr.current`.
 *
 * O diálogo de caixa é substituído por um de mentira: o que se prova aqui é o
 * que o PDV faz com o `onChanged` — o diálogo só o chama depois de o servidor
 * aceitar a abertura ou o fechamento.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

vi.mock('@/components/gs/CaixaPdvDialog', () => ({
  CaixaPdvDialog: ({
    onChanged,
    onClose,
  }: {
    onChanged: (s: Record<string, unknown> | null) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Caixa de mentira">
      <button
        type="button"
        onClick={() => {
          onChanged(null);
          onClose();
        }}
      >
        fechar o turno (teste)
      </button>
      <button
        type="button"
        onClick={() => {
          onChanged({ ...SESSAO, id: 'S2' });
          onClose();
        }}
      >
        abrir o turno (teste)
      </button>
    </div>
  ),
}));

const SESSAO = {
  id: 'S1',
  terminal_id: 'cx1',
  opening_cents: 20000,
  counted_cents: null,
  expected_cents: null,
  difference_cents: null,
  status: 'aberto',
  opened_at: new Date().toISOString(),
  closed_at: null,
};

const SABONETE = {
  id: 'p3',
  company_id: 'loja',
  name: 'SABONETE',
  internal_code: 'GS-p3',
  sku: null,
  barcode: '7890000000303',
  category: null,
  brand: null,
  cost_cents: 0,
  min_stock: 0,
  price_cents: 400,
  effective_price_cents: 400,
  on_sale: false,
  stock_quantity: 500,
  unit: 'UN',
  kind: 'retail',
  active: 1,
  serialized: 0,
  is_kit: 0,
  open_price: 0,
  weighable: 0,
  stock_control: 1,
  workshop_name: null,
};

const CHAVE_DA_LEMBRANCA = 'gs.pdv.ultimoCaixa:loja';

let sessaoDoCaixa: Record<string, unknown> | null;
let caixaForaDoAr: boolean;
let redeForaNaVenda: boolean;
let precoTravado: boolean;
let pedidosDePreco: number;
let vendas: Record<string, unknown>[];

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      return responder({ items: q === SABONETE.barcode ? [SABONETE] : [], catalogoVazio: false });
    }
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      pedidosDePreco += 1;
      // O servidor travado: aceita a conexão e nunca responde.
      if (precoTravado) return new Promise<Response>(() => undefined);
      const corpo = JSON.parse(init?.body ?? '{}') as { items: { productId: string }[] };
      return responder({
        items: corpo.items.map((i) => ({ productId: i.productId, priceCents: 400, listPriceCents: 400, onSale: false, fonte: 'cadastro' })),
        priceTable: null,
      });
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      vendas.push(corpo);
      if (redeForaNaVenda) throw new TypeError('Failed to fetch');
      return responder(
        { id: `venda-${vendas.length}`, number: 100 + vendas.length, subtotal_cents: 800, discount_cents: 0, surcharge_cents: 0, total_cents: 800, change_cents: 0, nfceNoFinalizar: null },
        201,
      );
    }
    if (alvo.includes('/core/cash/open')) {
      if (caixaForaDoAr) throw new TypeError('Failed to fetch');
      return responder({
        session: sessaoDoCaixa,
        cashWithdrawalLimitCents: null,
        terminal: { id: 'cx1', code: '01', name: 'Caixa 1' },
      });
    }
    if (alvo.includes('/core/print/drawer')) {
      return responder({ byCommand: false, agentPrinters: 0, message: 'A gaveta abre pela chave.', command: '' });
    }
    if (alvo.includes('/core/payment-methods')) {
      return responder({
        methods: [{ code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true }],
      });
    }
    return responder({});
  });
}

function entrarComoCaixa() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-caixa', login: 'PREÇO JUSTO', displayName: 'PREÇO JUSTO', profileCode: 'operador_caixa_loja' },
      company: { id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'operador_caixa_loja' }],
      access: {
        modelo: { code: 'operador_caixa_loja', name: 'Operador de Caixa (loja)', personalizado: false },
        capabilities: ['pdv.sell', 'pdv.cash.operate'],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/pdv',
        carimbo: 'c-caixa',
      },
    } as never,
    'LOGIN',
    'revisão da lembrança da gaveta',
  );
}

function abrirPdv() {
  const tela = render(
    <MemoryRouter initialEntries={['/pdv']}>
      <PdvPage />
    </MemoryRouter>,
  );
  return { campo: screen.getByLabelText(/Pesquise por código/) as HTMLInputElement, tela };
}

function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: campo.value + codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

function lembranca(): string | null {
  const bruto = localStorage.getItem(CHAVE_DA_LEMBRANCA);
  return bruto ? (JSON.parse(bruto) as { session: { id: string } }).session.id : null;
}

/** O F5 durante a queda: a tela sai e volta com o servidor fora. */
async function f5NaQueda(tela: ReturnType<typeof render>) {
  tela.unmount();
  caixaForaDoAr = true;
  redeForaNaVenda = true;
  const { campo } = abrirPdv();
  bipar(campo, SABONETE.barcode);
  await waitFor(() => expect(screen.getByLabelText('Quantidade de SABONETE')).toBeTruthy());
  fireEvent.keyDown(campo, { key: 'F8' });
  await waitFor(() => expect(vendas).toHaveLength(1));
  return vendas[0];
}

beforeEach(() => {
  sessaoDoCaixa = SESSAO;
  caixaForaDoAr = false;
  redeForaNaVenda = false;
  precoTravado = false;
  pedidosDePreco = 0;
  vendas = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim da revisão da lembrança da gaveta');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('G-offline-sync-02 (revisão) — a lembrança da gaveta segue o que o caixa fez aqui', () => {
  it('fechar o turno aqui apaga a lembrança: o F5 na queda NÃO manda venda para a gaveta fechada', async () => {
    const { campo, tela } = abrirPdv();
    await waitFor(() => expect(lembranca()).toBe('S1'));

    fireEvent.keyDown(campo, { key: 'F3' });
    fireEvent.click(await screen.findByRole('button', { name: 'fechar o turno (teste)' }));
    expect(lembranca()).toBeNull();

    const venda = await f5NaQueda(tela);
    expect(venda.cashSessionId ?? null).not.toBe('S1');
    expect(screen.queryByTestId('pdv-caixa-nao-confirmado')).toBeNull();
  });

  it('abrir o turno aqui vira lembrança: o F5 na queda manda a venda com a gaveta nova', async () => {
    sessaoDoCaixa = null;
    const { tela } = abrirPdv();
    // Sem caixa, o PDV já abre o diálogo de caixa na entrada.
    fireEvent.click(await screen.findByRole('button', { name: 'abrir o turno (teste)' }));
    expect(lembranca()).toBe('S2');

    const venda = await f5NaQueda(tela);
    expect(venda.cashSessionId).toBe('S2');
    expect(venda.terminalId).toBe('cx1');
  });
});

describe('G-offline-sync-M01 (revisão) — o preço antes de cobrar tem prazo', () => {
  it('servidor que não responde ao preço: o F8 de dois do mesmo item segue para a venda, sem travar o balcão', async () => {
    precoTravado = true;
    const { campo } = abrirPdv();
    for (const esperado of ['1', '2']) {
      bipar(campo, SABONETE.barcode);
      await waitFor(() =>
        expect((screen.getByLabelText('Quantidade de SABONETE') as HTMLInputElement).value).toBe(esperado),
      );
    }
    await waitFor(() => expect(pedidosDePreco).toBeGreaterThan(0));

    fireEvent.keyDown(campo, { key: 'F8' });
    await waitFor(() => expect(vendas).toHaveLength(1), { timeout: 6000 });
    const itens = vendas[0].items as { productId: string; quantity: number; unitPriceCents: number }[];
    expect(itens[0]).toMatchObject({ productId: 'p3', quantity: 2, unitPriceCents: 400 });
  }, 12000);
});
