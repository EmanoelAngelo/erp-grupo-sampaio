/**
 * O INVENTÁRIO COM O LEITOR NA MÃO — B-estoque-entrada-16.
 *
 * A contagem só aceitava digitação linha a linha: o filtro não olhava o código
 * de barras, e não havia onde bipar. Bipar a caixa não achava o item, e o
 * conferente lia o nome na etiqueta e procurava a linha.
 *
 * ## Como cada caso fica vermelho
 *
 *   - tire o código de barras (ou os adicionais) do filtro e o bipe no filtro
 *     não acha a linha;
 *   - tire o campo de bipe, ou mande a leitura como contagem absoluta, e três
 *     bipes não viram três.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import InventarioPage from '../InventarioPage';

const EAN = '7894900011517';
const DUN = '17891234567892';

let contado: number | null;
let bipes: Record<string, unknown>[];

function detalhe() {
  return {
    id: 'c-1',
    number: 12,
    status: 'aberta',
    scope_note: 'Pilhas',
    opened_at: '2026-09-12T09:00:00.000Z',
    applied_at: null,
    apply_reason: null,
    cancel_reason: null,
    location_name: null,
    items: [
      {
        id: 'i-1',
        product_id: 'p-pilha',
        name: 'Pilha AA',
        internal_code: 'PIL-01',
        barcode: EAN,
        extra_barcodes: DUN,
        expected_quantity: 10,
        counted_quantity: contado,
        counted_by_name: null,
      },
      {
        id: 'i-2',
        product_id: 'p-fita',
        name: 'Fita isolante',
        internal_code: 'FIT-01',
        barcode: null,
        extra_barcodes: null,
        expected_quantity: 4,
        counted_quantity: null,
        counted_by_name: null,
      },
    ],
    resumo: { total: 2, contados: contado === null ? 0 : 1, pendentes: contado === null ? 2 : 1, divergentes: 0, sobra: 0, falta: 0 },
  };
}

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (alvo.includes('/core/inventory-counts/c-1/items') && init?.method === 'POST') {
      const corpo = JSON.parse(String(init.body)) as Record<string, unknown>;
      bipes.push(corpo);
      if (corpo.barcode === EAN || corpo.barcode === DUN) contado = (contado ?? 0) + Number(corpo.increment);
      return json(detalhe());
    }
    if (alvo.includes('/core/inventory-counts') && init?.method === 'POST') return json(detalhe(), 201);
    if (alvo.includes('/core/inventory-counts')) return json({ items: [] });
    return json({ items: [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  contado = null;
  bipes = [];
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'est', displayName: 'Estoquista', profileCode: 'estoquista' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'estoquista' }],
    } as never,
    'LOGIN',
    'teste do bipe no inventário',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirContagem() {
  render(
    <MemoryRouter>
      <InventarioPage />
    </MemoryRouter>,
  );
  await screen.findByText('Nova contagem');
  fireEvent.click(screen.getByRole('button', { name: 'Abrir contagem' }));
  await screen.findByText('Pilha AA');
}

describe('B-16 — o inventário aceita o leitor', () => {
  it('o código de barras e o adicional acham a linha no filtro', async () => {
    await abrirContagem();
    const filtro = screen.getByRole('textbox', { name: 'Filtrar itens da contagem' });
    fireEvent.change(filtro, { target: { value: EAN } });
    expect(screen.getByText('Pilha AA')).toBeTruthy();
    expect(screen.queryByText('Fita isolante')).toBeNull();
    fireEvent.change(filtro, { target: { value: DUN } });
    expect(screen.getByText('Pilha AA')).toBeTruthy();
  });

  it('três leituras (código + Enter) somam 3 na linha certa', async () => {
    await abrirContagem();
    const campo = screen.getByRole('textbox', { name: 'Bipar código de barras' });
    for (const codigo of [EAN, EAN, DUN]) {
      fireEvent.change(campo, { target: { value: codigo } });
      fireEvent.keyDown(campo, { key: 'Enter' });
    }

    await waitFor(() => expect(bipes).toHaveLength(3));
    expect(bipes[0]).toEqual({ barcode: EAN, increment: 1 });
    expect(bipes[2]).toEqual({ barcode: DUN, increment: 1 });
    expect(await screen.findByDisplayValue('3')).toBeTruthy();
    expect(screen.getByText('Pilha AA: 3 contado(s).')).toBeTruthy();
  });
});
