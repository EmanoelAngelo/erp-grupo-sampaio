/**
 * CONTAR UM LOCAL PELA TELA — GAP-PRD-167, o lado da tela.
 *
 * A contagem comparava com o saldo da empresa inteira e a tela não falava em
 * local. Com loja e depósito, contar a Vitrine exigia somar o depósito de
 * cabeça. O seletor "Local contado" aparece quando há mais de um local ativo,
 * o `locationId` viaja na abertura, e a contagem aberta diz qual prateleira é.
 * Quem não usa locais (um só) não ganha campo nenhum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import InventarioPage from '../InventarioPage';

const LOCAIS = [
  { id: 'loc-geral', company_id: 'loja', code: 'GERAL', name: 'Estoque geral', note: null, is_default: 1, active: 1 },
  { id: 'loc-vit', company_id: 'loja', code: 'VIT', name: 'Vitrine', note: null, is_default: 0, active: 1 },
];

const DETALHE = {
  id: 'c-1',
  number: 4,
  status: 'aberta',
  scope_note: 'Prateleira da frente',
  opened_at: '2026-09-11T09:00:00.000Z',
  applied_at: null,
  apply_reason: null,
  cancel_reason: null,
  location_id: 'loc-vit',
  location_code: 'VIT',
  location_name: 'Vitrine',
  items: [
    {
      id: 'i-1',
      product_id: 'p-1',
      name: 'Perfume Floral 50ml',
      internal_code: 'PER-01',
      barcode: null,
      expected_quantity: 3,
      counted_quantity: null,
      counted_by_name: null,
    },
  ],
  resumo: { total: 1, contados: 0, pendentes: 1, divergentes: 0, sobra: 0, falta: 0 },
};

let aberturas: Record<string, unknown>[] = [];
let locais = LOCAIS;

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (alvo.includes('/core/stock/locations')) return json({ locations: locais });
    if (alvo.includes('/core/taxonomy')) return json({ categories: [], brands: [], orphans: { categories: [], subcategories: [], brands: [] } });
    if (alvo.includes('/core/inventory-counts') && init?.method === 'POST') {
      aberturas.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json(DETALHE, 201);
    }
    if (alvo.includes('/core/inventory-counts')) return json({ items: [DETALHE] });
    return json({ items: [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  aberturas = [];
  locais = LOCAIS;
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste do inventário por local',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderizar() {
  render(
    <MemoryRouter>
      <InventarioPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-167 — a contagem de um local pela tela', () => {
  it('com dois locais, o seletor aparece e o locationId viaja na abertura', async () => {
    renderizar();
    const seletor = (await screen.findByLabelText(/Local contado/)) as HTMLSelectElement;
    fireEvent.change(seletor, { target: { value: 'loc-vit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir contagem' }));

    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect(aberturas[0].locationId).toBe('loc-vit');
    // A contagem aberta diz qual prateleira é, e o esperado é o do local.
    expect(await screen.findByText('Local: Vitrine')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('sem escolher local, o corpo não inventa um — é a empresa inteira', async () => {
    renderizar();
    await screen.findByLabelText(/Local contado/);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir contagem' }));
    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect('locationId' in aberturas[0]).toBe(false);
  });

  it('a lista de contagens nomeia o local', async () => {
    renderizar();
    expect(await screen.findByRole('cell', { name: 'Vitrine' })).toBeTruthy();
  });

  it('com um local só, não há seletor', async () => {
    locais = [LOCAIS[0]];
    renderizar();
    await screen.findByText('Nova contagem');
    await waitFor(() => expect(screen.queryByLabelText(/Local contado/)).toBeNull());
  });
});
