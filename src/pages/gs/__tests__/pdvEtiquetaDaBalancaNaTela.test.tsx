/**
 * ============================================================================
 * A ETIQUETA DA BALANÇA ENTRA NO CARRINHO COM O PESO — D-pdv-teclado-16
 * ============================================================================
 *
 * O servidor já lia a etiqueta da balança e devolvia, na linha do produto
 * achado pelo PLU, `balanca: { tipo, quantidade, precoTotalCents }` — com
 * `matched_exact` em zero, para a tela que não lê o campo cair na lista. A
 * tela não lia: bipar a etiqueta do queijo de 0,352 kg desenhava uma lista de
 * um item, e escolhê-lo punha 1 kg no carrinho.
 *
 * Como fica vermelho: tire o bloco `etiquetaDaBalancaUnica` do `runSearch` em
 * `PdvPage.tsx` (a etiqueta volta a cair na lista), ou volte a soma da linha em
 * `addProduct` para `linha.quantity + qty` (0,1 + 0,2 kg vira
 * 0,30000000000000004).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

function produto(id: string, nome: string, barcode: string, preco: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    company_id: 'loja',
    name: nome,
    internal_code: `GS-${id}`,
    sku: null,
    barcode,
    category: null,
    brand: null,
    cost_cents: 0,
    min_stock: 0,
    price_cents: preco,
    effective_price_cents: preco,
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
    ...extra,
  };
}
const QUEIJO = produto('q1', 'QUEIJO MUÇARELA KG', '7890000000901', 4990, { unit: 'KG', weighable: 1, plu_code: '00123' });
const PRESUNTO = produto('q2', 'PRESUNTO FATIADO KG', '7890000000902', 3990, { unit: 'KG', weighable: 1, plu_code: '00123' });
const ARROZ = produto('p1', 'ARROZ X 5kg', '7898215151784', 2190);
const TODOS = [QUEIJO, PRESUNTO, ARROZ];

const ETIQUETA = '2100123003520';
const ETIQUETA_100G = '2100123001004';
const ETIQUETA_200G = '2100123002001';

type Leitura = { tipo: 'peso' | 'preco'; quantidade: number | null; precoTotalCents: number | null };
function comEtiqueta(p: ReturnType<typeof produto>, codigo: string, leitura: Leitura) {
  return { ...p, matched_exact: 0, balanca: { codigo, plu: '00123', ...leitura } };
}

const SESSAO = {
  id: 'sessao-teste',
  terminal_id: 'cx1',
  opening_cents: 20000,
  counted_cents: null,
  expected_cents: null,
  difference_cents: null,
  status: 'aberto',
  opened_at: new Date().toISOString(),
  closed_at: null,
};

type Corpo = Record<string, unknown> & {
  items?: { productId: string; quantity: number; unitPriceCents: number }[];
  payments?: { method: string; amountCents: number }[];
};

let respostasDaBusca: Record<string, unknown[]>;
let vendas: Corpo[];

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      const itens = respostasDaBusca[q] ?? TODOS.filter((p) => p.barcode === q);
      return responder({ items: itens, catalogoVazio: false });
    }
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}') as { items: { productId: string }[] };
      return responder({
        items: corpo.items.map((i) => {
          const p = TODOS.find((x) => x.id === i.productId)!;
          return { productId: i.productId, priceCents: p.price_cents, listPriceCents: p.price_cents, onSale: false, fonte: 'cadastro' };
        }),
        priceTable: null,
      });
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}') as Corpo;
      vendas.push(corpo);
      const total = (corpo.items ?? []).reduce((s, i) => s + Math.round(i.unitPriceCents * i.quantity), 0);
      const pago = (corpo.payments ?? []).reduce((s, p) => s + p.amountCents, 0);
      return responder(
        {
          id: `venda-${vendas.length}`,
          number: 100 + vendas.length,
          subtotal_cents: total,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: total,
          change_cents: Math.max(0, pago - total),
          nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: ['Emissão manual nesta loja'] },
        },
        201,
      );
    }
    if (alvo.includes('/core/cash/open')) {
      return responder({ session: SESSAO, cashWithdrawalLimitCents: null, terminal: { id: 'cx1', code: '01', name: 'Caixa 1' } });
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
    'teste da etiqueta da balança',
  );
}

function abrirPdv() {
  render(
    <MemoryRouter initialEntries={['/pdv']}>
      <PdvPage />
    </MemoryRouter>,
  );
  return screen.getByLabelText(/Pesquise por código/) as HTMLInputElement;
}

function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: campo.value + codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

const qtdDoQueijo = () => screen.getByLabelText(`Quantidade de ${QUEIJO.name}`) as HTMLInputElement;

beforeEach(() => {
  respostasDaBusca = {};
  vendas = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste da etiqueta da balança');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('D-pdv-teclado-16 — a etiqueta da balança no carrinho', () => {
  it('etiqueta de PESO: o queijo entra com 0,352 kg pelo preço do cadastro, e a venda sai assim', async () => {
    respostasDaBusca[ETIQUETA] = [comEtiqueta(QUEIJO, ETIQUETA, { tipo: 'peso', quantidade: 0.352, precoTotalCents: null })];
    const campo = abrirPdv();
    bipar(campo, ETIQUETA);
    await waitFor(() => expect(qtdDoQueijo().value).toBe('0,352'));
    // A linha diz a unidade: "0,352 kg".
    expect(screen.getByTestId(`pdv-unidade-${QUEIJO.id}`).textContent).toBe('kg');
    // O código saiu do campo: a leitura foi consumida.
    await waitFor(() => expect(campo.value).toBe(''));

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].items?.[0]).toMatchObject({ productId: 'q1', quantity: 0.352, unitPriceCents: 4990 });
  });

  it('etiqueta de PREÇO que bate com a conta (0,352 × R$ 49,90 = R$ 17,56): entra com o peso', async () => {
    respostasDaBusca[ETIQUETA] = [comEtiqueta(QUEIJO, ETIQUETA, { tipo: 'preco', quantidade: 0.352, precoTotalCents: 1756 })];
    const campo = abrirPdv();
    bipar(campo, ETIQUETA);
    await waitFor(() => expect(qtdDoQueijo().value).toBe('0,352'));
  });

  it('etiqueta de PREÇO com "Preço Unitário" digitado que não bate: avisa e NÃO põe no carrinho', async () => {
    respostasDaBusca[ETIQUETA] = [comEtiqueta(QUEIJO, ETIQUETA, { tipo: 'preco', quantidade: 0.352, precoTotalCents: 1756 })];
    const campo = abrirPdv();
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '30,00' } });
    bipar(campo, ETIQUETA);
    expect(await screen.findByText(/A etiqueta da balança diz .*17,56.*O item não entrou/)).toBeTruthy();
    expect(screen.queryByLabelText(`Quantidade de ${QUEIJO.name}`)).toBeNull();
    // O valor recusado não cai no próximo bipe (D-pdv-teclado-13).
    expect((screen.getByLabelText('Preço Unitário') as HTMLInputElement).value).toBe('');
  });

  it('etiqueta de PREÇO de produto sem preço (quantidade nula): avisa e não põe', async () => {
    respostasDaBusca[ETIQUETA] = [
      comEtiqueta({ ...QUEIJO, price_cents: 0, effective_price_cents: 0 }, ETIQUETA, { tipo: 'preco', quantidade: null, precoTotalCents: 1756 }),
    ];
    const campo = abrirPdv();
    bipar(campo, ETIQUETA);
    expect(await screen.findByText(/sem preço no cadastro/)).toBeTruthy();
    expect(screen.queryByLabelText(`Quantidade de ${QUEIJO.name}`)).toBeNull();
  });

  it('"2*" antes da etiqueta: a quantidade digitada não multiplica o peso — avisa e não põe', async () => {
    respostasDaBusca[ETIQUETA] = [comEtiqueta(QUEIJO, ETIQUETA, { tipo: 'peso', quantidade: 0.352, precoTotalCents: null })];
    const campo = abrirPdv();
    bipar(campo, `2*${ETIQUETA}`);
    expect(await screen.findByText(/a quantidade digitada \(2\) não vale para ela/)).toBeTruthy();
    expect(screen.queryByLabelText(`Quantidade de ${QUEIJO.name}`)).toBeNull();
  });

  it('duas etiquetas do mesmo queijo (0,1 e 0,2 kg): a linha soma 0,3 kg, sem resto de ponto flutuante', async () => {
    respostasDaBusca[ETIQUETA_100G] = [comEtiqueta(QUEIJO, ETIQUETA_100G, { tipo: 'peso', quantidade: 0.1, precoTotalCents: null })];
    respostasDaBusca[ETIQUETA_200G] = [comEtiqueta(QUEIJO, ETIQUETA_200G, { tipo: 'peso', quantidade: 0.2, precoTotalCents: null })];
    const campo = abrirPdv();
    bipar(campo, ETIQUETA_100G);
    await waitFor(() => expect(qtdDoQueijo().value).toBe('0,1'));
    bipar(campo, ETIQUETA_200G);
    await waitFor(() => expect(qtdDoQueijo().value).toBe('0,3'));
  });

  it('o mesmo PLU em dois cadastros: vai para a lista, que mostra o peso; a escolha entra com ele', async () => {
    respostasDaBusca[ETIQUETA] = [
      comEtiqueta(QUEIJO, ETIQUETA, { tipo: 'peso', quantidade: 0.352, precoTotalCents: null }),
      comEtiqueta(PRESUNTO, ETIQUETA, { tipo: 'peso', quantidade: 0.352, precoTotalCents: null }),
    ];
    const campo = abrirPdv();
    bipar(campo, ETIQUETA);
    const escolha = await screen.findByRole('button', { name: /PRESUNTO FATIADO KG/ });
    expect(screen.getAllByText(/etiqueta da balança: 0,352 kg/)).toHaveLength(2);
    expect(screen.queryByLabelText(`Quantidade de ${QUEIJO.name}`)).toBeNull();
    fireEvent.click(escolha);
    await waitFor(() =>
      expect((screen.getByLabelText(`Quantidade de ${PRESUNTO.name}`) as HTMLInputElement).value).toBe('0,352'),
    );
  });

  it('sem etiqueta: o código de barras de sempre continua entrando com uma unidade', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() =>
      expect((screen.getByLabelText(`Quantidade de ${ARROZ.name}`) as HTMLInputElement).value).toBe('1'),
    );
  });
});
