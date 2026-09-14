/**
 * ============================================================================
 * A VENDA QUE A GERÊNCIA DESCARTOU SAI DA FILA (G-offline-sync-16)
 * ============================================================================
 *
 * O gerente descartou a pendência em "Regularizar" ("o cliente desistiu, o
 * dinheiro foi devolvido"), mas a cópia seguia na fila deste computador. O
 * servidor passou a recusar o reenvio com 409 `CORE_OFFLINE_SALE_DISCARDED`, e
 * a fila tratava como qualquer recusa: entregava de novo como pendência — e, com
 * a entrega recusada, a venda ficava na fila tentando para sempre, com a barra
 * dizendo "aguardando envio" de uma venda que não vai existir.
 *
 * Agora a descartada sai da fila sem nova entrega, e a barra diz o que houve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EstadoConexao } from '../EstadoConexao';
import { setSession } from '@/lib/api/client';
import { enqueue, queued } from '@/lib/api/offlineQueue';

interface Pedido {
  url: string;
  method: string;
}

let pedidos: Pedido[];
let respostaDaVenda: () => Response;
let respostaDaEntrega: () => Response;
/** O que o servidor lista em "Regularizar" — a entrega que deu certo põe a pendência aqui. */
let recusadasNoServidor: unknown[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const DESCARTADA = () =>
  json(
    {
      error: {
        code: 'CORE_OFFLINE_SALE_DISCARDED',
        message:
          'Esta venda guardada offline foi DESCARTADA pela gerência em Regularizar vendas offline, e por isso não é registrada agora.',
        details: { pendenciaId: 'offsale-1' },
      },
    },
    409,
  );

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  recusadasNoServidor = [];
  respostaDaVenda = DESCARTADA;
  // A entrega de novo seria recusada (a pendência guardada é outra coisa agora):
  // é o caso em que a venda ficava presa na fila para sempre.
  respostaDaEntrega = () =>
    json({ error: { code: 'CORE_IDEMPOTENCY_KEY_REUSED', message: 'chave reusada' } }, 422);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      pedidos.push({ url: u, method });
      if (u.endsWith('/api/v1/health')) return json({ status: 'ok' });
      if (u.includes('/core/offline-sales') && method === 'POST') {
        const r = respostaDaEntrega();
        if (r.status < 300) recusadasNoServidor = [{ id: 'offsale-2' }];
        return r;
      }
      if (u.includes('/core/offline-sales')) return json({ items: recusadasNoServidor });
      if (u.includes('/core/sales')) return respostaDaVenda();
      return json({ items: [] });
    }),
  );
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'caixa', displayName: 'Caixa', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da venda descartada na fila',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste da venda descartada na fila');
  localStorage.clear();
});

function venda(chave: string) {
  return {
    path: '/core/sales',
    method: 'POST',
    body: {
      items: [{ productId: 'p-camiseta', quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    },
    idempotencyKey: chave,
    label: 'venda do PDV',
  };
}

describe('G-offline-sync-16 — a venda descartada pela gerência não fica tentando na fila', () => {
  it('409 CORE_OFFLINE_SALE_DISCARDED tira a venda da fila, sem nova entrega, e a barra diz que ela foi descartada', async () => {
    enqueue(venda('pdv-descartada-1'));
    render(<EstadoConexao />);

    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    // A barra fica com o aviso mesmo com a fila vazia, até o caixa dar ciência.
    const aviso = await screen.findByTestId('vendas-descartadas');
    expect(aviso.textContent).toMatch(/1 venda\(s\) guardada\(s\) neste computador tinha\(m\) sido DESCARTADA\(S\)/);

    // Saiu da fila — antes ficava com a recusa escrita, tentando a cada 30 s.
    expect(queued()).toHaveLength(0);
    // E não foi entregue de novo como pendência: a decisão já está no servidor.
    expect(pedidos.some((p) => p.url.includes('/core/offline-sales') && p.method === 'POST')).toBe(false);
    // Nem mandou o caixa procurar em "Regularizar" o que não está lá.
    expect(screen.queryByText(/foi\(ram\) para "Regularizar"/)).toBeNull();

    // Dada a ciência, sem fila e sem recusa esperando, a barra some.
    fireEvent.click(screen.getByRole('button', { name: /Ciente/i }));
    expect(screen.queryByTestId('estado-conexao')).toBeNull();
  });

  it('as outras recusas continuam indo para "Regularizar"', async () => {
    respostaDaVenda = () =>
      json({ error: { code: 'CORE_CASH_SESSION_CLOSED', message: 'O caixa informado já foi fechado.' } }, 400);
    respostaDaEntrega = () => json({ jaSubiu: false, pendencia: { id: 'offsale-2' } }, 201);
    enqueue(venda('pdv-caixa-fechado'));
    render(<EstadoConexao />);

    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    expect((await screen.findByTestId('estado-conexao')).textContent).toMatch(
      /1 venda\(s\) recusada\(s\) pelo servidor foi\(ram\) para "Regularizar"/,
    );
    expect(pedidos.some((p) => p.url.includes('/core/offline-sales') && p.method === 'POST')).toBe(true);
    expect(screen.queryByTestId('vendas-descartadas')).toBeNull();
    expect(queued()).toHaveLength(0);
  });
});
