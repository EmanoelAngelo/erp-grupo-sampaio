/**
 * ============================================================================
 * NO BALCÃO: A VENDA QUE NÃO COUBE NA FILA NÃO É "GUARDADA", E A QUE O PROXY
 * RECUSOU É (G-offline-sync-M02 / G-offline-sync-05)
 * ============================================================================
 *
 * M02 — com o armazenamento do navegador cheio ou bloqueado, a fila engolia a
 * falha: a tela dizia "Venda guardada na fila — NÃO refaça esta venda", limpava
 * o carrinho e imprimia o comprovante, e nada tinha sido gravado. A venda
 * sumia. Agora o cliente HTTP lança `API_QUEUE_UNAVAILABLE`, que o PDV trata
 * como erro: o carrinho FICA, a chave fica, e finalizar de novo com o servidor
 * de volta registra a venda uma vez só.
 *
 * 05 — atrás de proxy ou túnel, a API caída vira 502 com HTML. A venda caía em
 * "O servidor respondeu algo que não é JSON" e não era guardada. Agora ela vai
 * para a fila, e o balcão segue como numa queda de rede.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';
import { queued } from '@/lib/api/offlineQueue';

const SESSAO_KEY = 'gs.session';

const PRODUTO = {
  id: 'p-1',
  internal_code: 'PJ-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Fone de ouvido',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1000,
  price_cents: 2500,
  effective_price_cents: 2500,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let chavesEnviadas: string[];
/** O que o POST da venda recebe: queda de rede, página do proxy ou a venda. */
let venda: 'rede_caida' | 'proxy_502' | 'no_ar';

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (u.includes('/core/sales') && metodo === 'POST') {
      chavesEnviadas.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
      if (venda === 'rede_caida') throw new TypeError('Failed to fetch');
      if (venda === 'proxy_502') {
        return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return json({ id: 's-1', number: 1, total_cents: 2500, change_cents: 0 }, 201);
    }
    if (u.includes('/core/cash/open') && metodo === 'GET') {
      return json({ session: { id: 'sessao-1', opening_cents: 5000, status: 'aberto' }, cashWithdrawalLimitCents: null });
    }
    if (u.includes('/summary')) return json({ expectedCents: 5000, byMethod: [], movements: [] });
    if (u.includes('/core/fiscal/pdv-summary')) return json({ situacao: 'READY', pendencyCount: 0, motivos: [] });
    if (u.includes('/core/products/search')) return json({ items: [PRODUTO] });
    return json({ items: [] });
  });
}

async function porNoCarrinho() {
  const busca = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
  fireEvent.change(busca, { target: { value: '7890000001111' } });
  fireEvent.keyDown(busca, { key: 'Enter' });
  await screen.findByText('Fone de ouvido');
}

/** O armazenamento recusa a fila (cota cheia, quiosque bloqueado) — e só ela. */
function armazenamentoSemEspacoParaAFila() {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, chave: string, valor: string) {
    if (chave.startsWith('gs.fila.')) throw new DOMException('A cota do armazenamento acabou.', 'QuotaExceededError');
    return original.call(this, chave, valor);
  });
}

beforeEach(() => {
  chavesEnviadas = [];
  venda = 'rede_caida';
  localStorage.setItem(
    SESSAO_KEY,
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('G-offline-sync-M02 — sem lugar na fila, a venda NÃO é dada como guardada', () => {
  it('o carrinho fica, a tela diz que a venda não foi registrada, e a repetição usa a MESMA chave', async () => {
    const espiao = armazenamentoSemEspacoParaAFila();
    render(
      <MemoryRouter>
        <PdvPage />
      </MemoryRouter>,
    );
    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    expect(await screen.findByText(/NÃO foi registrada/)).toBeTruthy();
    // Nada de "guardada, não refaça": o carrinho continua na tela.
    expect(screen.queryByText(/não refa/i)).toBeNull();
    expect(screen.getAllByText('Fone de ouvido').length).toBeGreaterThan(0);
    expect(queued()).toHaveLength(0);

    // O servidor volta e o armazenamento também: finalizar de novo registra UMA venda, com a mesma chave.
    espiao.mockRestore();
    venda = 'no_ar';
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
    expect(await screen.findByText(/Venda #1 finalizada/)).toBeTruthy();
    expect(chavesEnviadas).toHaveLength(2);
    expect(chavesEnviadas[1]).toBe(chavesEnviadas[0]);
  });
});

describe('G-offline-sync-05 — o 502 do proxy guarda a venda como a queda de rede', () => {
  it('a venda vai para a fila com a chave do carrinho, e a tela avisa para NÃO refazer', async () => {
    venda = 'proxy_502';
    render(
      <MemoryRouter>
        <PdvPage />
      </MemoryRouter>,
    );
    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    expect(await screen.findByText(/não refa/i)).toBeTruthy();
    expect(screen.queryByText(/não é JSON/)).toBeNull();
    await waitFor(() => expect(queued().map((q) => q.idempotencyKey)).toEqual([chavesEnviadas[0]]));
  });
});
