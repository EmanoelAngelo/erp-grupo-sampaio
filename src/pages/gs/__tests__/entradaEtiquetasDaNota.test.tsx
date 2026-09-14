/**
 * AS ETIQUETAS DO QUE ENTROU — B-estoque-entrada-07.
 *
 * A tela de Etiquetas já abre a fila de uma nota por
 * `/sistema/etiquetas?origem=nota&nota=<id>`, e a Entrada de Notas não levava
 * até lá: quem recebia a carga saía da nota, abria Etiquetas, escolhia "nota de
 * entrada" e procurava a mesma nota de novo.
 *
 * ## Como cada caso fica vermelho
 *
 *   - tire o link das ações da conferência e a nota recebida fica sem ele;
 *   - mostre o link fora do status 'recebida' e a nota em conferência (que
 *     ainda não pôs nada na prateleira) passa a oferecê-lo;
 *   - ignore a capability da tela de Etiquetas e o acesso personalizado sem
 *     `products.view` ganha um link que dá "acesso negado".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';

let statusDaNota: string;
let confirmou: boolean;

function nota() {
  return {
    id: 'n-etq',
    access_key: '35260814200166000187550010000000011000000017',
    number: '11',
    series: '1',
    supplier_name: 'Distribuidora Alfa',
    total_cents: 22250,
    status: statusDaNota,
    created_at: '2026-09-10T10:00:00.000Z',
    issued_at: '2026-09-10T09:00:00.000Z',
    tem_xml: 1,
  };
}

const itens = [
  {
    supplierCode: 'ALFA-778',
    description: 'CABO ACEL CG160 REF 778',
    barcode: null,
    ncm: '87141000',
    cfop: '5102',
    unit: 'UN',
    quantity: 10,
    unitCostCents: 2225,
    totalCents: 22250,
    productId: 'p-cabo',
    matchedBy: 'manual',
    receivedQuantity: null,
    divergenceNote: null,
    conversionFactor: null,
    productName: 'Cabo de Acelerador CG 160',
    productInternalCode: 'CAB-160',
    productUnit: 'UN',
    resolvedFactor: 1,
  },
];

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/purchases/notes/n-etq/confirm') && method === 'POST') {
        confirmou = true;
        statusDaNota = 'recebida';
        return json({ noteId: 'n-etq', status: 'recebida', createdProducts: 0, movedItems: 1, alreadyReceived: false });
      }
      if (u.includes('/purchases/notes/n-etq/items')) return json({ items: itens });
      if (u.includes('/purchases/notes/n-etq/repricing')) return json({ suggestions: [] });
      if (u.includes('/purchases/notes')) return json({ items: [nota()] });
      return json({ items: [] });
    }),
  );
}

async function montar(access?: Record<string, unknown>) {
  setSession(
    {
      accessToken: 'token-da-doca',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
      ...(access ? { access } : {}),
    } as never,
    'LOGIN',
    'teste das etiquetas da entrada',
  );
  servidor();
  render(
    <MemoryRouter initialEntries={['/sistema/compras/entrada-notas?nota=n-etq']}>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findByText('Conferência da nota');
  await screen.findByText('Distribuidora Alfa');
}

const linkDasEtiquetas = () => screen.queryByRole('link', { name: 'Imprimir etiquetas desta entrada' });

beforeEach(() => {
  statusDaNota = 'conferencia';
  confirmou = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('B-07 — imprimir as etiquetas do que a nota pôs no estoque', () => {
  it('nota RECEBIDA aberta: o link leva à fila da nota nas Etiquetas', async () => {
    statusDaNota = 'recebida';
    await montar();
    const link = await waitFor(() => {
      const l = linkDasEtiquetas();
      expect(l).toBeTruthy();
      return l as HTMLAnchorElement;
    });
    expect(link.getAttribute('href')).toBe('/sistema/etiquetas?origem=nota&nota=n-etq');
  });

  it('nota em CONFERÊNCIA: não há o link (nada entrou ainda)', async () => {
    await montar();
    expect(screen.getByRole('button', { name: 'Dar entrada no estoque' })).toBeTruthy();
    expect(linkDasEtiquetas()).toBeNull();
  });

  it('depois de dar entrada, o link aparece na mesma nota', async () => {
    await montar();
    expect(linkDasEtiquetas()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));
    await waitFor(() => expect(confirmou).toBe(true));
    const link = await waitFor(() => {
      const l = linkDasEtiquetas();
      expect(l).toBeTruthy();
      return l as HTMLAnchorElement;
    });
    expect(link.getAttribute('href')).toBe('/sistema/etiquetas?origem=nota&nota=n-etq');
  });

  it('acesso personalizado sem a tela de Etiquetas: o link não é oferecido', async () => {
    statusDaNota = 'recebida';
    await montar({
      modelo: { personalizado: true },
      capabilities: ['purchases.view', 'purchases.receive'],
      terminais: 'todos',
      bancadas: 'todas',
      casa: '/sistema/compras/entrada-notas',
    });
    // A nota recebida já está na tela (sem o botão de entrada) — e sem o link.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dar entrada no estoque' })).toBeNull());
    expect(linkDasEtiquetas()).toBeNull();
  });

  it('acesso personalizado COM a tela de Etiquetas (products.view): o link aparece', async () => {
    statusDaNota = 'recebida';
    await montar({
      modelo: { personalizado: true },
      capabilities: ['purchases.view', 'products.view'],
      terminais: 'todos',
      bancadas: 'todas',
      casa: '/sistema/compras/entrada-notas',
    });
    await waitFor(() => expect(linkDasEtiquetas()).toBeTruthy());
  });
});
