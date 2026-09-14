/**
 * ============================================================================
 * A VENDA GUARDADA CUJA CHAVE JÁ REGISTROU OUTRA VENDA (RES-IDEM-TELA)
 * ============================================================================
 *
 * O PDV guardou na fila uma venda com a chave de uma tentativa que o servidor
 * JÁ tinha registrado com outros itens (a venda #N). Quando a fila sobe, o
 * servidor recusa com 422 CORE_IDEMPOTENCY_KEY_REUSED, e a venda vira
 * pendência em "Regularizar". Relançar com a MESMA chave dá 422 para sempre —
 * e a tela oferecia só esse botão, sem dizer o que fazer.
 *
 * O que estes casos cobram:
 *
 *   - a pendência explica, na língua de quem regulariza, que a venda #N existe
 *     e o que ela registrou, e que esta é OUTRA venda;
 *   - o botão que nunca vai passar (relançar com a mesma chave) sai, e entra
 *     "Relançar como venda nova", que chama a rota nova do servidor na gaveta
 *     aberta deste computador;
 *   - a recusa do relançamento comum por chave reusada (servidor que ainda não
 *     manda `vendaDaChave`) também explica, em vez de repetir o texto cru.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { EstadoConexao } from '../EstadoConexao';
import { setSession } from '@/lib/api/client';

interface Pedido {
  url: string;
  method: string;
  body: unknown;
}

let pedidos: Pedido[];
let recusadasNoServidor: unknown[];
let respostaDoRelancamento: () => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TEXTO_DO_SERVIDOR =
  'Esta chave de idempotência já registrou a venda #5, com outra mercadoria — nada foi registrado agora. '
  + 'Uma venda nova precisa de chave nova.';

const PENDENCIA = {
  id: 'offsale-1',
  idempotencyKey: 'pdv-chave-reusada',
  label: 'venda do PDV',
  queuedAt: '2026-09-12T14:05:00.000Z',
  reportedAt: '2026-09-12T18:00:00.000Z',
  lastReportedAt: '2026-09-12T18:00:00.000Z',
  reportedBy: 'u1',
  reportedByName: 'Caixa 1',
  terminalId: null,
  terminalName: null,
  cashSessionId: 'sessao-antiga',
  receivedCents: 15000,
  itemsCount: 1,
  items: [{ productId: 'p-camiseta', name: 'Camiseta', quantity: 3, unitPriceCents: 5000 }],
  payments: [{ method: 'dinheiro', amountCents: 15000 }],
  status: 'pendente',
  errorCode: 'CORE_IDEMPOTENCY_KEY_REUSED',
  errorMessage: TEXTO_DO_SERVIDOR,
  attempts: 1,
  saleId: null,
  saleNumber: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  vendaDaChave: {
    id: 's-5',
    number: 5,
    totalCents: 10000,
    status: 'completed',
    items: [{ description: 'Camiseta', quantity: 2 }],
  },
};

const GAVETA_ABERTA = {
  session: { id: 'sessao-de-agora', terminal_id: null, status: 'open', opening_cents: 0 },
  cashWithdrawalLimitCents: null,
  terminal: null,
};

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      pedidos.push({ url: u, method, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
      if (u.endsWith('/api/v1/health')) return json({ status: 'ok' });
      if (u.includes('/relaunch')) return respostaDoRelancamento();
      if (u.includes('/core/offline-sales')) return json({ items: recusadasNoServidor });
      if (u.includes('/core/cash/open')) return json(GAVETA_ABERTA);
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da chave reusada',
  );
}

async function abrirRegularizar() {
  render(<EstadoConexao />);
  fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
  return screen.findByTestId('venda-offline-recusada');
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  recusadasNoServidor = [PENDENCIA];
  respostaDoRelancamento = () => json({ error: { code: 'X', message: 'não configurado' } }, 500);
  servidor();
  entrarComo('operador_caixa_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da chave reusada');
  localStorage.clear();
});

// ============================================================================

describe('a pendência cuja chave já registrou a venda #N', () => {
  it('explica o que aconteceu, mostra o que a #N registrou, e não oferece o botão que nunca passa', async () => {
    const cartao = await abrirRegularizar();
    const explicacao = within(cartao).getByTestId('explicacao-chave-reusada');
    expect(explicacao.textContent).toMatch(/já registrou a venda #5, com outros itens/);
    expect(explicacao.textContent).toMatch(/2\s*×\s*Camiseta/);
    expect(explicacao.textContent).toMatch(/100,00/);
    // A #5 continua existindo, e a saída é outra venda.
    expect(explicacao.textContent).toMatch(/venda nova/i);
    // O texto cru do servidor (chave de idempotência) não é o que se lê.
    expect(within(cartao).queryByText(/idempot/i)).toBeNull();
    expect(within(cartao).queryByRole('button', { name: /Relançar na gaveta aberta/i })).toBeNull();
    expect(within(cartao).getByRole('button', { name: /Relançar como venda nova/i })).toBeTruthy();
  });

  it('"Relançar como venda nova" chama a rota nova, na gaveta aberta deste computador', async () => {
    respostaDoRelancamento = () => {
      recusadasNoServidor = [];
      return json(
        {
          sale: { id: 's-78', number: 78, total_cents: 15000 },
          duplicated: false,
          pendencia: { ...PENDENCIA, status: 'regularizada', saleId: 's-78', saleNumber: 78 },
        },
        201,
      );
    };
    const cartao = await abrirRegularizar();
    fireEvent.click(within(cartao).getByRole('button', { name: /Relançar como venda nova/i }));

    expect(await screen.findByText(/Venda #78 registrada como venda nova/)).toBeTruthy();
    const relancamento = pedidos.find((p) => p.url.includes('/relaunch'));
    expect(relancamento?.url).toContain('/core/offline-sales/offsale-1/relaunch-as-new');
    expect(relancamento?.method).toBe('POST');
    expect(relancamento?.body).toEqual({ cashSessionId: 'sessao-de-agora', terminalId: null });
    // Nenhum relançamento com a MESMA chave foi tentado.
    expect(pedidos.some((p) => /\/relaunch$/.test(p.url))).toBe(false);
  });
});

describe('o servidor diz que a chave NÃO tem outra venda (`vendaDaChave: null`) — R2-IDEM, item 2', () => {
  it('o código gravado da recusa não vira explicação: a saída é o relançamento comum', async () => {
    /*
      A pendência guarda o código da recusa que a trouxe (a chave reusada), mas
      o servidor, que olhou a chave AGORA, diz que não há venda de outra
      mercadoria nela — a venda anterior é da mesma cesta, ou anterior à
      impressão. O fallback pelo código (feito para servidor que não manda o
      campo) escondia o relançamento comum e oferecia o "como venda nova", que o
      servidor recusa (409) — e que, se passasse, venderia em dobro.
    */
    recusadasNoServidor = [{ ...PENDENCIA, vendaDaChave: null }];
    const cartao = await abrirRegularizar();
    expect(within(cartao).queryByTestId('explicacao-chave-reusada')).toBeNull();
    expect(within(cartao).getByRole('button', { name: /Relançar na gaveta aberta/i })).toBeTruthy();
    expect(within(cartao).queryByRole('button', { name: /Relançar como venda nova/i })).toBeNull();
  });

  it('servidor que não manda o campo (undefined) continua valendo pelo código gravado', async () => {
    recusadasNoServidor = [{ ...PENDENCIA, vendaDaChave: undefined }];
    const cartao = await abrirRegularizar();
    expect(within(cartao).getByTestId('explicacao-chave-reusada')).toBeTruthy();
    expect(within(cartao).getByRole('button', { name: /Relançar como venda nova/i })).toBeTruthy();
  });

  it('com `null` na lista, a recusa FRESCA do relançamento (422) ainda explica', async () => {
    recusadasNoServidor = [{ ...PENDENCIA, errorCode: 'CORE_CASH_SESSION_CLOSED', vendaDaChave: null }];
    respostaDoRelancamento = () =>
      json(
        { error: { code: 'CORE_IDEMPOTENCY_KEY_REUSED', message: TEXTO_DO_SERVIDOR, details: { saleId: 's-5', saleNumber: 5 } } },
        422,
      );
    const cartao = await abrirRegularizar();
    fireEvent.click(within(cartao).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    const explicacao = await within(cartao).findByTestId('explicacao-chave-reusada');
    expect(explicacao.textContent).toMatch(/já registrou a venda #5/);
  });
});

describe('servidor sem `vendaDaChave`: a recusa do relançamento comum também explica', () => {
  it('o 422 da chave reusada vira explicação e a saída certa, e não o texto cru', async () => {
    recusadasNoServidor = [{ ...PENDENCIA, errorCode: 'CORE_CASH_SESSION_CLOSED', errorMessage: 'caixa fechado', vendaDaChave: undefined }];
    respostaDoRelancamento = () =>
      json(
        {
          error: {
            code: 'CORE_IDEMPOTENCY_KEY_REUSED',
            message: TEXTO_DO_SERVIDOR,
            details: { saleId: 's-5', saleNumber: 5 },
          },
        },
        422,
      );
    const cartao = await abrirRegularizar();
    fireEvent.click(within(cartao).getByRole('button', { name: /Relançar na gaveta aberta/i }));

    const explicacao = await within(cartao).findByTestId('explicacao-chave-reusada');
    expect(explicacao.textContent).toMatch(/já registrou a venda #5, com outros itens/);
    expect(within(cartao).queryByText(/idempot/i)).toBeNull();
    expect(within(cartao).getByRole('button', { name: /Relançar como venda nova/i })).toBeTruthy();
  });
});
