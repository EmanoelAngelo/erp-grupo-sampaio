/**
 * ============================================================================
 * PDV — A BUSCA ATRÁS DE PROXY DIZ "SEM CONEXÃO" (G-offline-sync-R01)
 * ============================================================================
 *
 * O DEFEITO: com proxy reverso ou túnel na frente da API (a implantação do
 * G-offline-sync-05), a API caída não faz o `fetch` lançar — o proxy responde
 * 502 com uma página HTML. O cliente HTTP transformava isso em
 * `API_INVALID_RESPONSE`, e a busca do PDV, que só reconhecia a falha de rede
 * (`isNetworkFailure`), mostrava "O servidor respondeu algo que não é JSON. Se
 * houver um proxy ou túnel…" a cada bipe — e nenhuma faixa de conexão
 * acendia, porque o aviso à barra só saía na falha de rede.
 *
 * O conserto está no cliente HTTP (`client.ts`: 502/503/504 avisa a barra; a
 * página do proxy vira `API_SERVER_UNREACHABLE` com o status real) e em
 * `isNetworkFailure` (`offlineQueue.ts`: esse código é "não chegou à API").
 * Para ver este teste falhar: em `isNetworkFailure`, tire a última linha
 * (`return … === CODIGO_PROXY_SEM_API`) e devolva `false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EVENTO_SERVIDOR_SEM_RESPOSTA, setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

const printDocument = vi.fn(async (..._args: unknown[]) => ({ via: 'navegador', aviso: null as string | null }));
vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: (...args: unknown[]) => printDocument(...args),
}));

const ARROZ = {
  id: 'p1',
  company_id: 'loja',
  name: 'ARROZ X 5kg',
  internal_code: 'GS-p1',
  sku: null,
  barcode: '7898215151784',
  category: null,
  brand: null,
  cost_cents: 0,
  min_stock: 0,
  price_cents: 2190,
  effective_price_cents: 2190,
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

/** A API caída atrás do proxy: ele responde a busca com a página 502 dele. */
let apiForaAtrasDoProxy: boolean;
let buscas: number;

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      buscas += 1;
      if (apiForaAtrasDoProxy) {
        return new Response('<html><body><h1>502 Bad Gateway</h1><hr><center>nginx</center></body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      return responder({ items: q === ARROZ.barcode ? [ARROZ] : [], catalogoVazio: false });
    }
    if (alvo.match(/\/core\/products\/p1$/)) return responder(ARROZ);
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}') as { items: { productId: string }[] };
      return responder({
        items: corpo.items.map((i) => ({
          productId: i.productId,
          priceCents: ARROZ.effective_price_cents,
          listPriceCents: ARROZ.price_cents,
          onSale: false,
          fonte: 'cadastro',
        })),
        priceTable: null,
      });
    }
    if (alvo.includes('/core/cash/open')) {
      return responder({
        session: SESSAO,
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
    if (alvo.includes('/pdv/terminal/status')) {
      return responder({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
    }
    if (alvo.includes('/pdv/pix-asaas/status')) {
      return responder({ disponivel: false, ambiente: 'sandbox', motivo: 'Sem PIX integrado.' });
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
    'teste da busca atrás do proxy',
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

beforeEach(() => {
  apiForaAtrasDoProxy = false;
  buscas = 0;
  printDocument.mockReset();
  printDocument.mockImplementation(async () => ({ via: 'navegador', aviso: null }));
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste da busca atrás do proxy');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('G-offline-sync-R01 — a busca que recebe o 502 do proxy', () => {
  it('diz "sem conexão" e o que ainda dá para fazer — e não "algo que não é JSON"', async () => {
    const avisos = vi.fn();
    window.addEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    try {
      apiForaAtrasDoProxy = true;
      const campo = abrirPdv();
      bipar(campo, ARROZ.barcode);
      expect(
        await screen.findByText(
          'Sem conexão com o servidor da loja — a busca de produto não funciona agora. Dá para finalizar só o carrinho que já está na tela.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/não é JSON/)).toBeNull();
      // A barra de conexão foi avisada: é ela que sonda e acende a faixa.
      expect(avisos).toHaveBeenCalled();

      // A API volta: o mesmo bipe põe o item no carrinho. (O código do bipe que
      // falhou fica no campo; o leitor bipa num campo limpo.)
      apiForaAtrasDoProxy = false;
      fireEvent.change(campo, { target: { value: '' } });
      bipar(campo, ARROZ.barcode);
      await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
      expect(buscas).toBeGreaterThanOrEqual(2);
    } finally {
      window.removeEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    }
  });
});
