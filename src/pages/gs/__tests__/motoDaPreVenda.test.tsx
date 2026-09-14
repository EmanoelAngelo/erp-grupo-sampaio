/**
 * A MOTO DA PRÉ-VENDA NA TELA (GAP-PRD-025, GAP-PRD-111).
 *
 * O que cada bloco derruba:
 *   - tire `unidades` da conversão do PDV e a pré-venda de moto volta a ser
 *     faturada pela moto que o servidor escolher, e não pela que a linha mostra;
 *   - tire a escolha pela reserva em `loadQuote` e a linha mostra a mais antiga
 *     do pátio no lugar da moto prometida ao cliente;
 *   - tire a troca por bipe e o chassi bipado vira uma SEGUNDA moto na linha de
 *     uma pré-venda de uma moto só;
 *   - tire o cartão "Chassi reservado" e segurar AQUELA moto volta a não ter
 *     gesto na tela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';
import OrcamentosPage from '../OrcamentosPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const MOTO = {
  id: 'p-moto',
  internal_code: 'MT-0001',
  sku: null,
  barcode: null,
  name: 'Honda CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1_200_000,
  price_cents: 1_800_000,
  effective_price_cents: 1_800_000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 3,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
  serialized: 1,
};

const VALIDADE = new Date(Date.now() + 5 * 86_400_000).toISOString();

const PRE_VENDA = {
  id: 'q-moto',
  number: 21,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: null,
  seller_id: null,
  total_cents: 1_800_000,
  discount_cents: 0,
  valid_until: VALIDADE,
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

const RESERVA_DO_DOC = {
  unitId: 'u-verm',
  productId: 'p-moto',
  quoteId: 'q-moto',
  quoteNumber: 21,
  customerName: null,
  validUntil: VALIDADE,
  rotulo: 'CH-VERMELHA',
};

function unidade(id: string, chassis: string, reserva: Record<string, unknown> | null = null) {
  return {
    id,
    company_id: 'loja',
    product_id: 'p-moto',
    status: 'in_stock',
    serial_number: null,
    imei: null,
    chassis,
    motor_number: null,
    plate: null,
    location_id: null,
    cost_cents: null,
    entry_reference_type: null,
    exit_reference_type: null,
    equipment_id: null,
    note: null,
    created_at: '2026-01-01T00:00:00.000Z',
    plaquinha: null,
    reserva,
  };
}

const U_PRETA = unidade('u-preta', 'CH-PRETA');
const U_AZUL_DE_OUTRA = unidade('u-azul', 'CH-AZUL', {
  ...RESERVA_DO_DOC,
  unitId: 'u-azul',
  quoteId: 'q-outra',
  quoteNumber: 8,
  customerName: 'Joana',
  rotulo: 'CH-AZUL',
});

let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> }[];
let detalheAtual: Record<string, unknown>;
let patio: ReturnType<typeof unidade>[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function detalhe(reservas: unknown[]) {
  return {
    ...PRE_VENDA,
    expired: false,
    liberacao: null,
    unidadesReservadas: reservas,
    items: [
      {
        id: 'i-1',
        product_id: 'p-moto',
        description: 'Honda CG 160',
        quantity: 1,
        unit_price_cents: 1_800_000,
        total_cents: 1_800_000,
        serialized: 1,
      },
    ],
  };
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    pedidos.push({ metodo, url: alvo, corpo });

    if (alvo.includes('/convert') && metodo === 'POST') return json({ saleId: 'v-7', number: 7 }, 201);
    if (/\/core\/quotes\/q-moto\/unidades$/.test(alvo) && metodo === 'PUT') {
      detalheAtual = detalhe([RESERVA_DO_DOC]);
      return json({ unidadesReservadas: [RESERVA_DO_DOC] });
    }
    if (/\/core\/quotes\/q-moto$/.test(alvo) && metodo === 'GET') return json(detalheAtual);
    if (/\/core\/products\/p-moto$/.test(alvo)) return json(MOTO);
    if (alvo.includes('/core/units/p-moto')) return json({ items: patio });
    if (alvo.includes('/core/units?q=')) {
      return json({ items: alvo.includes('CH-PRETA') ? [U_PRETA] : [] });
    }
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      return json({
        items: [
          { productId: 'p-moto', priceCents: 1_800_000, listPriceCents: 1_800_000, onSale: false, fonte: 'cadastro' },
        ],
        priceTable: null,
      });
    }
    if (alvo.includes('/core/quotes')) return json({ items: [PRE_VENDA] });
    if (alvo.includes('/core/sales/discount-policy')) {
      return json({ operatorLimitPercent: 10, canAuthorizeSelf: false });
    }
    if (alvo.includes('/core/cash/open') || alvo.includes('/core/cash/current')) {
      return json({ session: CAIXA_ABERTO, cashWithdrawalLimitCents: null });
    }
    if (alvo.includes('/core/fiscal/pdv-summary')) {
      return json({
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      });
    }
    return json({ items: [] });
  });
}

beforeEach(() => {
  pedidos = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste da moto da pré-venda',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function conversoes() {
  return pedidos.filter((p) => p.url.includes('/convert') && p.metodo === 'POST');
}

async function abrirNoPdv() {
  render(
    <MemoryRouter initialEntries={['/pdv?documento=q-moto']}>
      <PdvPage />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: /^Remover / });
}

describe('GAP-PRD-025 — o PDV fatura a pré-venda de moto com o chassi da linha', () => {
  beforeEach(() => {
    detalheAtual = detalhe([RESERVA_DO_DOC]);
    // A preta é a mais antiga; a azul é de outra pré-venda; a vermelha é deste documento.
    patio = [U_PRETA, U_AZUL_DE_OUTRA, unidade('u-verm', 'CH-VERMELHA', RESERVA_DO_DOC)];
  });

  it('a linha nasce com a moto que o documento segura, e a conversão leva esse chassi', async () => {
    await abrirNoPdv();
    expect((await screen.findAllByText(/CH-VERMELHA/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/CH-PRETA/)).toBeNull();
    expect(screen.queryByText(/CH-AZUL/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(conversoes()).toHaveLength(1));
    expect(conversoes()[0].corpo.unidades).toEqual([{ productId: 'p-moto', unitIds: ['u-verm'] }]);
  });

  it('sem moto segurada, sai a mais antiga LIVRE — nunca a de outra pré-venda', async () => {
    detalheAtual = detalhe([]);
    patio = [U_AZUL_DE_OUTRA, U_PRETA];
    await abrirNoPdv();
    expect((await screen.findAllByText(/CH-PRETA/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/CH-AZUL/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(conversoes()).toHaveLength(1));
    expect(conversoes()[0].corpo.unidades).toEqual([{ productId: 'p-moto', unitIds: ['u-preta'] }]);
  });

  it('bipar outro chassi TROCA a moto da linha, sem somar uma segunda', async () => {
    await abrirNoPdv();
    await screen.findAllByText(/CH-VERMELHA/);

    const busca = screen.getByPlaceholderText(/Pesquise por código/);
    fireEvent.change(busca, { target: { value: 'CH-PRETA' } });
    fireEvent.keyDown(busca, { key: 'Enter' });
    await screen.findByText(/Chassi CH-PRETA entra no lugar de CH-VERMELHA/);

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(conversoes()).toHaveLength(1));
    expect(conversoes()[0].corpo.unidades).toEqual([{ productId: 'p-moto', unitIds: ['u-preta'] }]);
  });
});

describe('GAP-PRD-111 — a pré-venda segura AQUELA moto pela tela', () => {
  beforeEach(() => {
    detalheAtual = detalhe([]);
    patio = [U_PRETA, U_AZUL_DE_OUTRA, unidade('u-verm', 'CH-VERMELHA')];
  });

  it('escolher o chassi manda a moto certa e a folha passa a mostrá-la; a de outro cliente vem travada', async () => {
    render(
      <MemoryRouter>
        <OrcamentosPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ver' }));
    const cartao = await screen.findByRole('region', { name: 'Chassi reservado' });
    expect(cartao.textContent).toContain('nenhum chassi segurado');

    fireEvent.click(screen.getByRole('button', { name: 'Escolher chassi' }));
    const azul = await screen.findByRole('checkbox', { name: 'Segurar CH-AZUL' });
    expect((azul as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/reservada p\/ pré-venda #8 de Joana/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Segurar CH-VERMELHA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Segurar chassi' }));

    await waitFor(() =>
      expect(pedidos.some((p) => p.metodo === 'PUT' && p.url.endsWith('/core/quotes/q-moto/unidades'))).toBe(true),
    );
    const put = pedidos.find((p) => p.metodo === 'PUT')!;
    expect(put.corpo).toEqual({ productId: 'p-moto', unitIds: ['u-verm'] });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Chassi reservado' }).textContent).toContain('CH-VERMELHA'),
    );
  });
});
