/**
 * ============================================================================
 * A BARRA DE CONEXÃO DIZ A VERDADE — COM FILA OU SEM (G-offline-sync-03 / 04 /
 * 06 / 13 / 15 / 17 / M03)
 * ============================================================================
 *
 *   04  com a fila vazia, o servidor caía e nenhuma faixa dizia isso: a sonda só
 *       rodava dentro do envio da fila;
 *   03  a faixa prometia que "a venda continua sendo registrada", e sem servidor
 *       só o carrinho que já está na tela fecha;
 *   13  a aba cuja fila a OUTRA aba esvaziou ficava dizendo "aguardando envio"
 *       para sempre, e o diálogo do caixa já aberto não via a venda da outra aba;
 *   15  o reenvio descartava a resposta: ninguém sabia que número a venda
 *       guardada virou, nem reimprimia;
 *   17  a fila virava "venda do PDV, venda do PDV, …", sem valor nem hora;
 *   M03 o reenvio não dizia QUEM vendeu, e a alçada era a de quem estava logado;
 *   06  a venda que estava no ar quando a tela recarregou volta pela fila.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EstadoConexao } from '../EstadoConexao';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { apiRequest, setSession } from '@/lib/api/client';
import { enqueue, queued } from '@/lib/api/offlineQueue';

const printDocument = vi.fn(async () => ({ via: 'navegador', aviso: null }));
vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: (...args: unknown[]) => printDocument(...(args as [])),
}));

interface Pedido {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let pedidos: Pedido[];
let servidorNoAr: boolean;
let respostaDaVenda: () => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

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
      if (!servidorNoAr) throw new TypeError('Failed to fetch');
      if (u.endsWith('/api/v1/health')) return json({ status: 'ok' });
      if (u.includes('/core/offline-sales')) return json({ items: [] });
      if (u.includes('/core/sales') && method === 'POST') return respostaDaVenda();
      if (u.includes('/summary')) return json({ expectedCents: 0, changeCents: 0, byMethod: [], movements: [] });
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string, userId = 'u1') {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: userId, login: 'pessoa', displayName: 'Pessoa', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da barra de conexão',
  );
}

function venda(chave: string, valorCents = 5000, escopo?: { userId: string | null; companyId: string | null }) {
  return {
    path: '/core/sales',
    method: 'POST',
    body: {
      items: [{ productId: 'p-camiseta', quantity: 1, unitPriceCents: valorCents }],
      payments: [{ method: 'dinheiro', amountCents: valorCents }],
      cashSessionId: 'sessao-1',
    },
    idempotencyKey: chave,
    label: 'venda do PDV',
    ...(escopo ? { escopo } : {}),
  };
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  servidorNoAr = true;
  respostaDaVenda = () => json({ id: 's-1234', number: 1234, total_cents: 5000 }, 201);
  printDocument.mockClear();
  servidor();
  entrarComo('operador_caixa_loja');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste da barra de conexão');
  localStorage.clear();
});

// ============================================================================

describe('G-offline-sync-04/03 — o servidor fora aparece mesmo com a fila vazia', () => {
  it('a primeira requisição que não chega acende a faixa, que diz o que dá e o que não dá para fazer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    render(<EstadoConexao />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Servidor de pé, nada guardado: a barra não existe.
    expect(screen.queryByTestId('estado-conexao')).toBeNull();

    // O servidor cai. A fila está vazia; o operador bipa e a busca não chega.
    servidorNoAr = false;
    await act(async () => {
      await apiRequest('/core/products/search?q=7891').catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/servidor da loja não responde/i)).toBeTruthy();
    const oQueFunciona = screen.getByTestId('o-que-funciona-sem-servidor').textContent ?? '';
    expect(oQueFunciona).toMatch(/só o carrinho que já está na tela/);
    expect(oQueFunciona).toMatch(/busca de produto/);
    // A promessa que a fila não cumpre saiu.
    expect(screen.queryByText(/continua sendo registrada/)).toBeNull();
    expect(queued()).toHaveLength(0);

    // O servidor volta: a sonda de 15 s percebe sozinha, e a faixa some.
    servidorNoAr = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByTestId('estado-conexao')).toBeNull();
  });
});

describe('G-offline-sync-R01 — atrás de proxy ou túnel, o 502 da consulta também acende a faixa', () => {
  /*
    O caso de cima simula só o `fetch` que lança. Na implantação com proxy
    reverso ou túnel (a do G-offline-sync-05), a API caída não faz o `fetch`
    lançar: o proxy responde 502 com HTML. O aviso à barra só saía na falha de
    rede e no 502 da VENDA — com a fila vazia, a busca recebia o 502, a tela
    dizia "O servidor respondeu algo que não é JSON…" e nenhuma faixa acendia.
  */
  it('a busca recebe a página 502 do proxy: a faixa diz que o servidor não responde, e o erro é o de sem conexão', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let apiAtrasDoProxy = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        // O proxy fica de pé e responde por tudo — inclusive por `/health`.
        if (!apiAtrasDoProxy) {
          return new Response('<html><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (String(url).endsWith('/api/v1/health')) return json({ status: 'ok' });
        return json({ items: [] });
      }),
    );
    render(<EstadoConexao />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId('estado-conexao')).toBeNull();

    // A API cai atrás do proxy, com a fila vazia. O operador bipa.
    apiAtrasDoProxy = false;
    let erro: unknown;
    await act(async () => {
      erro = await apiRequest('/core/products/search?q=7891').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(erro).toMatchObject({ code: 'API_SERVER_UNREACHABLE', status: 502 });
    expect((erro as Error).message).toMatch(/^Sem conexão com o servidor da loja/);
    expect((erro as Error).message).not.toMatch(/não é JSON/);
    expect(screen.getByText(/servidor da loja não responde/i)).toBeTruthy();
    expect(screen.getByTestId('o-que-funciona-sem-servidor').textContent ?? '').toMatch(
      /só o carrinho que já está na tela/,
    );
    expect(queued()).toHaveLength(0);

    // A API volta: a sonda de 15 s percebe sozinha, e a faixa some.
    apiAtrasDoProxy = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByTestId('estado-conexao')).toBeNull();
  });
});

describe('G-offline-sync-13 — a barra e o caixa acompanham a outra aba', () => {
  it('a outra aba enviou a venda: esta barra para de dizer "aguardando envio"', async () => {
    enqueue(venda('venda-da-outra-aba'));
    render(<EstadoConexao />);
    expect(await screen.findByText(/aguardando envio/i)).toBeTruthy();

    // A outra aba esvazia a fila e o navegador avisa esta com `storage`.
    localStorage.setItem('gs.fila.escrita', '[]');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'gs.fila.escrita' }));
    });
    await waitFor(() => expect(screen.queryByText(/aguardando envio/i)).toBeNull());
  });

  it('mesmo sem o aviso da outra aba, "Enviar agora" relê a fila em vez de congelar a barra', async () => {
    enqueue(venda('venda-que-ja-subiu'));
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    await waitFor(() => expect(queued()).toHaveLength(0));
    // Estado velho na barra: a fila foi esvaziada por fora, sem evento.
    enqueue(venda('outra'));
    await screen.findByText(/aguardando envio/i);
    localStorage.setItem('gs.fila.escrita', '[]');
    fireEvent.click(screen.getByRole('button', { name: /Enviar agora/i }));
    await waitFor(() => expect(screen.queryByText(/aguardando envio/i)).toBeNull());
  });

  it('o diálogo do caixa JÁ ABERTO vê a venda que a outra aba guardou, e não deixa fechar', async () => {
    render(
      <CaixaPdvDialog
        cash={{ id: 'sessao-1', opening_cents: 0, status: 'open', opened_at: '2026-09-14T11:00:00.000Z' } as never}
        tetoSangriaCents={null}
        vendasEmEspera={0}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    );
    await screen.findByRole('button', { name: /Fechar caixa/i });
    expect(screen.queryByTestId('caixa-fila-offline')).toBeNull();

    localStorage.setItem(
      'gs.fila.escrita',
      JSON.stringify([{ ...venda('venda-da-aba-a'), id: 'q-1', queuedAt: new Date().toISOString(), attempts: 0 }]),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'gs.fila.escrita' }));
    });
    expect((await screen.findByTestId('caixa-fila-offline')).textContent).toMatch(/1 venda\(s\) guardada\(s\)/);
    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '0,00' } });
    expect((screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('G-offline-sync-15 — a barra diz o número que a venda guardada virou', () => {
  it('"a venda guardada das HH:MM (código …) virou a venda #1234", com o comprovante a um clique', async () => {
    enqueue(venda('pdv-0b8f2c1e-4d3a-4f7e-9a61-5c2d7e8f9a10'));
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));

    const linha = await screen.findByTestId('venda-guardada-subiu');
    expect(linha.textContent).toMatch(/virou a venda #1234/);
    expect(linha.textContent).toMatch(/código 7E8F9A10/);
    fireEvent.click(screen.getByRole('button', { name: /Imprimir comprovante da #1234/i }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('SALE_RECEIPT', 's-1234', expect.anything()));

    fireEvent.click(screen.getByRole('button', { name: /Dispensar/i }));
    await waitFor(() => expect(screen.queryByTestId('venda-guardada-subiu')).toBeNull());
  });
});

describe('G-offline-sync-17 — a fila em uma frase', () => {
  it('oito vendas guardadas: quantas, quanto dinheiro e desde quando — sem a lista repetida', async () => {
    servidorNoAr = false;
    for (let i = 0; i < 8; i += 1) enqueue(venda(`venda-${i}`));
    render(<EstadoConexao />);
    const resumo = (await screen.findByTestId('resumo-da-fila')).textContent ?? '';
    expect(resumo).toMatch(/8 vendas guardadas aguardando envio/);
    expect(resumo).toMatch(/400,00 recebidos/);
    expect(resumo).toMatch(/a mais antiga das \d{2}:\d{2}/);
    expect(resumo).not.toMatch(/venda do PDV, venda do PDV/);
  });
});

describe('G-offline-sync-M03 — o reenvio diz quem vendeu e quando', () => {
  it('a venda do operador reenviada na sessão do gerente leva o operador e a hora da venda', async () => {
    entrarComo('gerente_loja', 'ger-1');
    const guardada = enqueue(venda('venda-do-operador', 5000, { userId: 'op-1', companyId: 'c1' }));
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    await waitFor(() => expect(queued()).toHaveLength(0));
    const envio = pedidos.find((p) => p.url.includes('/core/sales') && p.method === 'POST');
    expect(envio?.headers['Idempotency-Key']).toBe('venda-do-operador');
    expect((envio?.body as { vendaGuardada?: unknown }).vendaGuardada).toEqual({
      userId: 'op-1',
      queuedAt: guardada.queuedAt,
    });
  });
});

describe('G-offline-sync-06 — a venda que estava no ar quando a tela recarregou', () => {
  it('volta para a fila com a mesma chave e sobe', async () => {
    localStorage.setItem(
      'gs.fila.emEnvio',
      JSON.stringify([
        {
          ...venda('venda-do-f5'),
          escopo: { userId: 'u1', companyId: 'c1' },
          desde: Date.now() - 60_000,
        },
      ]),
    );
    render(<EstadoConexao />);
    expect(await screen.findByText(/aguardando envio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Enviar agora/i }));
    await waitFor(() => expect(queued()).toHaveLength(0));
    const envio = pedidos.find((p) => p.url.includes('/core/sales') && p.method === 'POST');
    expect(envio?.headers['Idempotency-Key']).toBe('venda-do-f5');
    expect(localStorage.getItem('gs.fila.emEnvio')).toBeNull();
  });
});
