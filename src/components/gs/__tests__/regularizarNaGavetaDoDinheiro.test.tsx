/**
 * ============================================================================
 * "REGULARIZAR" RELANÇA ONDE O DINHEIRO ESTÁ, E LIBERA A ALÇADA ALI MESMO
 * (G-offline-sync-10 / 11 / 17)
 * ============================================================================
 *
 *   10  relançava sempre na gaveta aberta do computador de QUEM CLICA: a venda
 *       do Caixa 1 entrava na gaveta do Caixa 2. Agora a gaveta que o servidor
 *       aponta (`gavetaDeDestino`) é a do relançamento, de qualquer computador;
 *       sem ela, a gaveta deste computador, e a de outro caixa pede confirmação.
 *   11  a pendência recusada por alçada não tinha caminho de liberação: o cartão
 *       pede a liberação do gestor e relança com ela.
 *   17  o cartão mostra o código da venda guardada — o do comprovante offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RegularizarVendasOffline } from '../RegularizarVendasOffline';
import { setSession } from '@/lib/api/client';

interface Pedido {
  url: string;
  method: string;
  body: unknown;
}

let pedidos: Pedido[];
let recusadas: unknown[];
let gavetaDesteComputador: unknown;
let respostasDoRelancamento: (() => Response)[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE = {
  id: 'offsale-1',
  idempotencyKey: 'pdv-0b8f2c1e-4d3a-4f7e-9a61-5c2d7e8f9a10',
  label: 'venda do PDV',
  queuedAt: '2026-09-13T21:40:00.000Z',
  reportedAt: '2026-09-14T08:00:00.000Z',
  lastReportedAt: '2026-09-14T08:00:00.000Z',
  reportedBy: 'u-caixa-1',
  reportedByName: 'Caixa 1',
  terminalId: 't1',
  terminalName: 'Caixa 1',
  cashSessionId: 'sessao-caixa-1',
  receivedCents: 20000,
  itemsCount: 1,
  items: [{ productId: 'p-bota', name: 'Bota', quantity: 1, unitPriceCents: 20000 }],
  payments: [{ method: 'dinheiro', amountCents: 20000 }],
  status: 'pendente',
  errorCode: 'CORE_INSUFFICIENT_STOCK',
  errorMessage: 'Estoque insuficiente para concluir a operação.',
  attempts: 1,
  saleId: null,
  saleNumber: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  vendaDaChave: null,
  gavetaDeDestino: null as unknown,
};

const RELANCADA = () =>
  json({ sale: { id: 's-90', number: 90, total_cents: 20000 }, duplicated: false, pendencia: { ...BASE, status: 'regularizada' } }, 201);

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      pedidos.push({ url: u, method, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
      if (u.includes('/relaunch')) return (respostasDoRelancamento.shift() ?? RELANCADA)();
      if (u.includes('/core/authorizations') && method === 'POST') return json({ id: 'lib-1' }, 201);
      if (u.includes('/core/offline-sales')) return json({ items: recusadas });
      if (u.includes('/core/cash/open')) return json(gavetaDesteComputador);
      return json({ items: [] });
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  recusadas = [BASE];
  respostasDoRelancamento = [];
  gavetaDesteComputador = {
    session: { id: 'sessao-caixa-2', terminal_id: 't2', status: 'open', opening_cents: 0 },
    cashWithdrawalLimitCents: null,
    terminal: { id: 't2' },
  };
  servidor();
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-caixa-2', login: 'caixa2', displayName: 'Caixa 2', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste de regularizar na gaveta do dinheiro',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste de regularizar na gaveta do dinheiro');
  localStorage.clear();
});

async function cartao() {
  render(<RegularizarVendasOffline onClose={() => undefined} />);
  return screen.findByTestId('venda-offline-recusada');
}

function relancamentos() {
  return pedidos.filter((p) => p.url.includes('/relaunch'));
}

// ============================================================================

describe('G-offline-sync-10 — a gaveta do relançamento é a do dinheiro', () => {
  it('com a gaveta da venda aberta, relança nela — sem pedir a gaveta deste computador', async () => {
    recusadas = [
      { ...BASE, gavetaDeDestino: { cashSessionId: 'sessao-caixa-1', terminalId: 't1', terminalName: 'Caixa 1', motivo: 'a_da_venda' } },
    ];
    gavetaDesteComputador = { session: null, cashWithdrawalLimitCents: null };
    const c = await cartao();
    expect(within(c).getByTestId('gaveta-de-destino').textContent).toMatch(/gaveta do Caixa 1, que continua aberta/);

    fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    await screen.findByText(/Venda #90 relançada/);
    expect(relancamentos()[0].body).toEqual({ cashSessionId: 'sessao-caixa-1', terminalId: 't1' });
    // Não perguntou pela gaveta deste computador, e não disse que falta gaveta aqui.
    expect(pedidos.some((p) => p.url.includes('/core/cash/open'))).toBe(false);
    expect(screen.queryByText(/Não há gaveta aberta neste computador/)).toBeNull();
  });

  it('gaveta de outro caixa: o cartão mostra a sobra e a falta, e só relança com a confirmação', async () => {
    respostasDoRelancamento = [
      () =>
        json(
          {
            error: {
              code: 'CORE_OFFLINE_SALE_OTHER_DRAWER',
              message:
                'O dinheiro desta venda ficou na gaveta do Caixa 1, que já fechou, e Caixa 1 não tem gaveta aberta agora. '
                + 'Relançar na gaveta do Caixa 2 põe a venda onde o dinheiro não está: uma gaveta fica com a sobra e a outra com a falta.',
              details: { confirmavel: true, terminalDaVenda: 't1' },
            },
          },
          409,
        ),
    ];
    const c = await cartao();
    fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    const confirmar = await within(c).findByTestId('confirmar-outra-gaveta');
    expect(confirmar.textContent).toMatch(/sobra/);
    expect(relancamentos()[0].body).toEqual({ cashSessionId: 'sessao-caixa-2', terminalId: 't2' });

    fireEvent.click(within(confirmar).getByRole('button', { name: /Relançar nesta gaveta mesmo assim/i }));
    await screen.findByText(/Venda #90 relançada/);
    expect(relancamentos()[1].body).toEqual({ cashSessionId: 'sessao-caixa-2', terminalId: 't2', confirmarOutraGaveta: true });
  });

  it('o computador de outro caixa registrado não relança a gaveta aberta de lá: diz onde, sem botão de confirmar', async () => {
    recusadas = [
      { ...BASE, gavetaDeDestino: { cashSessionId: 'sessao-caixa-1', terminalId: 't1', terminalName: 'Caixa 1', motivo: 'a_da_venda' } },
    ];
    respostasDoRelancamento = [
      () =>
        json(
          {
            error: {
              code: 'CORE_OFFLINE_SALE_OTHER_DRAWER',
              message: 'O dinheiro desta venda está na gaveta do Caixa 1, que está aberta, e ela é relançada nela.',
              details: { confirmavel: false },
            },
          },
          409,
        ),
    ];
    const c = await cartao();
    fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    expect((await within(c).findByRole('alert')).textContent).toMatch(/gaveta do Caixa 1/);
    expect(within(c).queryByTestId('confirmar-outra-gaveta')).toBeNull();
  });
});

describe('G-offline-sync-11 — a recusa por alçada pede a liberação ali mesmo', () => {
  it('a pendência recusada por alçada oferece a liberação, e relança com ela na gaveta da venda', async () => {
    recusadas = [
      {
        ...BASE,
        errorCode: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
        errorMessage: 'Esta venda concede R$ 30,00 sobre R$ 100,00 (30%), acima do limite de 10% desta operação.',
        gavetaDeDestino: { cashSessionId: 'sessao-caixa-1', terminalId: 't1', terminalName: 'Caixa 1', motivo: 'a_da_venda' },
      },
    ];
    const c = await cartao();
    fireEvent.click(within(c).getByRole('button', { name: /Pedir liberação do gestor/i }));
    const form = within(c).getByTestId('liberacao-do-gestor');
    fireEvent.change(within(form).getByLabelText('Usuário do gestor'), { target: { value: 'ADMIN-PREÇO JUSTO' } });
    fireEvent.change(within(form).getByLabelText('Senha do gestor'), { target: { value: 'senha-do-gestor' } });
    fireEvent.click(within(form).getByRole('button', { name: /Liberar e relançar/i }));

    await screen.findByText(/Venda #90 relançada/);
    const liberacao = pedidos.find((p) => p.url.includes('/core/authorizations'));
    expect(liberacao?.body).toMatchObject({
      action: 'desconto_acima_limite',
      login: 'ADMIN-PREÇO JUSTO',
      password: 'senha-do-gestor',
    });
    expect(relancamentos()[0].body).toEqual({ cashSessionId: 'sessao-caixa-1', terminalId: 't1', authorizationId: 'lib-1' });
  });

  it('o 403 fresco do relançamento abre o caminho, e a liberação leva os números do servidor', async () => {
    respostasDoRelancamento = [
      () =>
        json(
          {
            error: {
              code: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
              message: 'Esta venda concede R$ 30,00 sobre R$ 100,00 (30%). Peça a liberação de um gestor.',
              details: { concedidoCents: 3000, brutoCents: 10000, percentual: 30 },
            },
          },
          403,
        ),
    ];
    const c = await cartao();
    fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    fireEvent.click(await within(c).findByRole('button', { name: /Pedir liberação do gestor/i }));
    const form = within(c).getByTestId('liberacao-do-gestor');
    fireEvent.change(within(form).getByLabelText('Usuário do gestor'), { target: { value: 'gerente' } });
    fireEvent.change(within(form).getByLabelText('Senha do gestor'), { target: { value: 'x' } });
    fireEvent.click(within(form).getByRole('button', { name: /Liberar e relançar/i }));
    await screen.findByText(/Venda #90 relançada/);
    expect(pedidos.find((p) => p.url.includes('/core/authorizations'))?.body).toMatchObject({
      concedidoCents: 3000,
      brutoCents: 10000,
    });
    expect(relancamentos()[1].body).toMatchObject({ authorizationId: 'lib-1' });
  });
});

describe('G-offline-sync-17 — o código casa o papel do cliente com a pendência', () => {
  it('o cartão mostra o código da venda guardada', async () => {
    const c = await cartao();
    expect(within(c).getByTestId('codigo-da-venda-guardada').textContent).toMatch(/código 7E8F9A10/);
  });
});
