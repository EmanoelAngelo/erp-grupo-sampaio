/**
 * ============================================================================
 * A FILA DO BALCÃO SOBE SOZINHA E A RECUSA NÃO FICA PRESA (GAP-PRD-044/045/046)
 * ============================================================================
 *
 * GAP-PRD-044: com a rede da loja de pé e o SERVIDOR desligado,
 * `navigator.onLine` fica `true`, o evento `online` nunca dispara, e a venda
 * guardada só subia quando alguém clicava em "Enviar agora". A barra também
 * não sabia dizer que o problema era o servidor.
 *
 * GAP-PRD-045/046: a venda que o servidor RECUSA (o caixa daquele turno
 * fechou, o estoque acabou) ficava presa no `localStorage` daquele computador,
 * sem tela para relançar e invisível para o gestor.
 *
 * Os casos cobram:
 *
 *   - a tentativa automática, sem clique, e a frase "servidor da loja";
 *   - a recusa definitiva entregue ao servidor, saindo deste computador;
 *   - Regularizar: relançar na gaveta aberta DESTE computador, a recusa por
 *     estoque dita pelo nome do produto, a falta de gaveta aberta, e o
 *     descarte só para a gerência;
 *   - o diálogo do caixa não fecha a gaveta com venda deste computador na fila.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EstadoConexao } from '../EstadoConexao';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { setSession } from '@/lib/api/client';
import { classificarFalha, enqueue, esperaDaTentativa, flushQueue, queued } from '@/lib/api/offlineQueue';

interface Pedido {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let pedidos: Pedido[];
let servidorNoAr: boolean;
let respostaDaVenda: () => Response;
let recusadasNoServidor: unknown[];
let respostaDoRelancamento: () => Response;
let gavetaAberta: unknown;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RECUSA_DO_CAIXA = 'O caixa informado já foi fechado — abra um caixa para vender.';

const PENDENCIA = {
  id: 'offsale-1',
  idempotencyKey: 'venda-guardada-1',
  label: 'venda do PDV',
  queuedAt: '2026-09-10T14:05:00.000Z',
  reportedAt: '2026-09-10T18:00:00.000Z',
  lastReportedAt: '2026-09-10T18:00:00.000Z',
  reportedBy: 'u1',
  reportedByName: 'Caixa 1',
  terminalId: null,
  terminalName: null,
  cashSessionId: 'sessao-antiga',
  receivedCents: 5000,
  itemsCount: 1,
  items: [{ productId: 'p-camiseta', name: 'Camiseta', quantity: 1, unitPriceCents: 5000 }],
  payments: [{ method: 'dinheiro', amountCents: 5000 }],
  status: 'pendente',
  errorCode: 'CORE_CASH_SESSION_CLOSED',
  errorMessage: RECUSA_DO_CAIXA,
  attempts: 1,
  saleId: null,
  saleNumber: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
};

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      pedidos.push({
        url: u,
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
        headers: init?.headers ?? {},
      });
      // Servidor desligado com a rede de pé: o navegador devolve TypeError.
      if (!servidorNoAr) throw new TypeError('Failed to fetch');
      if (u.endsWith('/api/v1/health')) return json({ status: 'ok' });
      if (u.includes('/relaunch')) return respostaDoRelancamento();
      if (u.includes('/discard')) {
        recusadasNoServidor = [];
        return json({ ...PENDENCIA, status: 'descartada' });
      }
      if (u.includes('/core/offline-sales') && method === 'POST') {
        recusadasNoServidor = [PENDENCIA];
        return json({ jaSubiu: false, pendencia: PENDENCIA }, 201);
      }
      if (u.includes('/core/offline-sales')) return json({ items: recusadasNoServidor });
      if (u.includes('/core/cash/open')) return json(gavetaAberta);
      if (u.includes('/core/sales')) return respostaDaVenda();
      if (u.includes('/summary')) return json({ expectedCents: 0, changeCents: 0, byMethod: [], movements: [] });
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
    'teste da fila do balcão',
  );
}

function venda(chave: string) {
  return {
    path: '/core/sales',
    method: 'POST',
    body: {
      items: [{ productId: 'p-camiseta', quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: 'sessao-antiga',
    },
    idempotencyKey: chave,
    label: 'venda do PDV',
  };
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  servidorNoAr = true;
  respostaDaVenda = () => json({ id: 's-1', number: 9 }, 201);
  recusadasNoServidor = [];
  gavetaAberta = { session: null, cashWithdrawalLimitCents: null };
  respostaDoRelancamento = () => json({ error: { code: 'X', message: 'não configurado' } }, 500);
  servidor();
  entrarComo('operador_caixa_loja');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da fila do balcão');
  localStorage.clear();
});

// ============================================================================

describe('GAP-PRD-044 — a venda guardada sobe sem clique', () => {
  it('servidor fora com a rede de pé: a barra diz que é o SERVIDOR, e a venda sobe sozinha quando ele volta', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    servidorNoAr = false;
    enqueue(venda('venda-da-queda'));
    render(<EstadoConexao />);

    // Ninguém clica. A primeira tentativa pergunta ao servidor e descobre
    // que ele está fora — com o navegador achando que está tudo bem.
    expect(navigator.onLine).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(esperaDaTentativa(0));
    });
    expect(screen.getByText(/servidor da loja não responde/i)).toBeTruthy();
    expect(screen.getByText(/Nova tentativa automática/i)).toBeTruthy();
    expect(pedidos.some((p) => p.url.includes('/core/sales'))).toBe(false);

    // O servidor volta. De novo sem clique: a próxima tentativa sobe a venda.
    servidorNoAr = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(esperaDaTentativa(1));
    });
    const envio = pedidos.find((p) => p.url.includes('/core/sales') && p.method === 'POST');
    expect(envio?.headers['Idempotency-Key']).toBe('venda-da-queda');
    expect(queued()).toHaveLength(0);
    expect(screen.queryByText(/aguardando envio/i)).toBeNull();
    expect(screen.queryByText(/servidor da loja não responde/i)).toBeNull();
  });

  it('navegador reaberto com fila e servidor de pé: a venda sobe na primeira tentativa, sem clique', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    enqueue(venda('venda-de-ontem-a-noite'));
    render(<EstadoConexao />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(esperaDaTentativa(0));
    });
    expect(queued()).toHaveLength(0);
  });

  it('a espera cresce e para em 30 s', () => {
    expect([0, 1, 2, 3, 4, 9].map(esperaDaTentativa)).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
  });
});

describe('GAP-PRD-045/046 — a recusa vai para o servidor, e não fica neste computador', () => {
  it('recusa definitiva: a venda é entregue com a mesma chave, sai daqui, e a barra oferece Regularizar', async () => {
    respostaDaVenda = () => json({ error: { code: 'CORE_CASH_SESSION_CLOSED', message: RECUSA_DO_CAIXA } }, 400);
    enqueue(venda('venda-guardada-1'));
    render(<EstadoConexao />);

    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    await screen.findByRole('button', { name: /Regularizar/i });

    const entrega = pedidos.find((p) => p.url.includes('/core/offline-sales') && p.method === 'POST');
    expect(entrega?.body).toMatchObject({
      idempotencyKey: 'venda-guardada-1',
      errorCode: 'CORE_CASH_SESSION_CLOSED',
      errorMessage: RECUSA_DO_CAIXA,
      body: { cashSessionId: 'sessao-antiga' },
    });
    expect(queued()).toHaveLength(0);
    expect(screen.getByText(/1 venda\(s\) guardada\(s\) recusada\(s\) pelo servidor/)).toBeTruthy();
  });

  it('Regularizar relança na gaveta aberta DESTE computador', async () => {
    recusadasNoServidor = [PENDENCIA];
    gavetaAberta = {
      session: { id: 'sessao-de-agora', terminal_id: null, status: 'open', opening_cents: 0 },
      cashWithdrawalLimitCents: null,
      terminal: null,
    };
    respostaDoRelancamento = () => {
      recusadasNoServidor = [];
      return json(
        { sale: { id: 's-77', number: 77, total_cents: 5000 }, duplicated: false, pendencia: { ...PENDENCIA, status: 'regularizada' } },
        201,
      );
    };
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
    await screen.findByText(/50,00 recebidos/);
    expect(screen.getByText(/Recusada: O caixa informado já foi fechado/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Relançar na gaveta aberta/i }));
    await screen.findByText(/Venda #77 relançada/);
    const relancamento = pedidos.find((p) => p.url.includes('/relaunch'));
    expect(relancamento?.url).toContain('/core/offline-sales/offsale-1/relaunch');
    expect(relancamento?.body).toEqual({ cashSessionId: 'sessao-de-agora', terminalId: null });
  });

  it('estoque que acabou: a tela diz o produto e aponta a entrada de estoque', async () => {
    recusadasNoServidor = [PENDENCIA];
    gavetaAberta = { session: { id: 'sessao-de-agora', terminal_id: null }, cashWithdrawalLimitCents: null };
    respostaDoRelancamento = () =>
      json(
        {
          error: {
            code: 'CORE_INSUFFICIENT_STOCK',
            message: 'Estoque insuficiente para concluir a operação.',
            details: { productId: 'p-camiseta', requested: 1 },
          },
        },
        409,
      );
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Relançar na gaveta aberta/i }));
    await screen.findByText(/Sem estoque de Camiseta para relançar/);
    expect(screen.getByRole('link', { name: /Abrir Movimentações/i }).getAttribute('href')).toBe(
      '/sistema/estoque/movimentacoes',
    );
  });

  it('sem gaveta aberta neste computador: não relança, e diz para abrir o caixa', async () => {
    recusadasNoServidor = [PENDENCIA];
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Relançar na gaveta aberta/i }));
    await screen.findByText(/Não há gaveta aberta neste computador/);
    expect(pedidos.some((p) => p.url.includes('/relaunch'))).toBe(false);
  });

  it('descartar só aparece para a gerência, e leva o motivo', async () => {
    recusadasNoServidor = [PENDENCIA];
    const { unmount } = render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
    await screen.findByText(/50,00 recebidos/);
    expect(screen.queryByRole('button', { name: /^Descartar$/ })).toBeNull();
    unmount();

    entrarComo('gerente_loja');
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Regularizar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Descartar$/ }));
    const confirmar = screen.getByRole('button', { name: /Confirmar descarte/i }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo do descarte'), {
      target: { value: 'cliente desistiu e o dinheiro foi devolvido' },
    });
    fireEvent.click(confirmar);
    await screen.findByText(/descartada\. O motivo ficou na trilha/);
    const descarte = pedidos.find((p) => p.url.includes('/discard'));
    expect(descarte?.body).toEqual({ reason: 'cliente desistiu e o dinheiro foi devolvido' });
  });
});

describe('a gaveta não fecha com venda deste computador na fila', () => {
  it('o botão de fechar espera a fila esvaziar, e diz por quê', async () => {
    enqueue(venda('venda-ainda-no-navegador'));
    render(
      <CaixaPdvDialog
        cash={{ id: 'sessao-antiga', opening_cents: 0, status: 'open', opened_at: '2026-09-10T11:00:00.000Z' } as never}
        tetoSangriaCents={null}
        vendasEmEspera={0}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    );
    expect((await screen.findByTestId('caixa-fila-offline')).textContent).toMatch(/1 venda\(s\) guardada\(s\)/);
    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '0,00' } });
    const fechar = screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement;
    expect(fechar.disabled).toBe(true);

    // A fila subiu: o fechamento volta a valer.
    await act(async () => {
      await flushQueue(async () => 'enviada');
    });
    await waitFor(() => expect(screen.queryByTestId('caixa-fila-offline')).toBeNull());
  });
});

describe('o que conta como recusa', () => {
  it('rede, prazo e servidor sobrecarregado tentam de novo; 401 é sessão; o resto dos 4xx é recusa', () => {
    expect(classificarFalha(new TypeError('Failed to fetch'))).toBe('rede');
    expect(classificarFalha({ status: 0 })).toBe('rede');
    expect(classificarFalha({ status: 503 })).toBe('rede');
    expect(classificarFalha({ status: 429 })).toBe('rede');
    expect(classificarFalha({ status: 401 })).toBe('sessao');
    expect(classificarFalha({ status: 400, code: 'CORE_CASH_SESSION_CLOSED' })).toBe('recusa');
    expect(classificarFalha({ status: 409, code: 'CORE_INSUFFICIENT_STOCK' })).toBe('recusa');
  });

  it('a venda encaminhada sai da fila e é contada à parte', async () => {
    enqueue(venda('a'));
    enqueue(venda('b'));
    const r = await flushQueue(async (item) => (item.idempotencyKey === 'a' ? 'encaminhada' : undefined));
    expect(r).toEqual({ sent: 1, forwarded: 1, failed: 0 });
    expect(queued()).toHaveLength(0);
  });
});
