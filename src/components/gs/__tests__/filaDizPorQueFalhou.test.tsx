/**
 * A FILA PRECISA DIZER POR QUE NÃO CONSEGUIU SUBIR.
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 * A barra de conexão dizia sempre a mesma frase quando o envio falhava:
 *
 *     "Ainda não foi possível enviar. Tentaremos de novo."
 *
 * Ela é verdadeira para rede instável — e é MENTIRA para o caso que mais
 * acontece: a venda foi guardada com a sessão de caixa daquele turno, o turno
 * fechou, e o servidor passa a recusar a venda porque a gaveta não está mais
 * aberta. "Tentaremos de novo" nunca vai dar certo, e o dinheiro já foi
 * recebido do cliente.
 *
 * `flushQueue` já guarda o motivo em `lastError` a cada tentativa. Ninguém lia.
 *
 * ============================================================================
 * O QUE MUDA
 * ============================================================================
 *
 * A barra mostra a recusa do servidor, com as palavras dele. Quem está no
 * balcão lê "o caixa desta venda já foi fechado" e sabe o que fazer — abrir o
 * caixa e mandar de novo — em vez de esperar por uma retentativa que não
 * resolve.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EstadoConexao } from '../EstadoConexao';
import { enqueue, queued, removeFromQueue } from '@/lib/api/offlineQueue';

/** A recusa que o servidor devolve quando a gaveta daquele turno já fechou. */
const CAIXA_FECHADO = 'O caixa desta venda já foi fechado. Abra o caixa e envie de novo.';

let respostaDoServidor: () => Response;

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => respostaDoServidor()),
  );
}

beforeEach(() => {
  queued().forEach((q) => removeFromQueue(q.id));
  respostaDoServidor = () =>
    new Response(JSON.stringify({ error: { code: 'CORE_CASH_SESSION_CLOSED', message: CAIXA_FECHADO } }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  servidor();
  enqueue({
    path: '/core/sales',
    method: 'POST',
    body: { items: [] },
    idempotencyKey: 'venda-de-ontem',
    label: 'Venda',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  queued().forEach((q) => removeFromQueue(q.id));
});

// ============================================================================

describe('a barra da fila fala com as palavras do servidor', () => {
  it('a recusa aparece na tela, e não um "tentaremos de novo"', async () => {
    render(<EstadoConexao />);

    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));

    /*
      "Tentaremos de novo" é verdade para rede instável e mentira para uma
      recusa definitiva. Quem está no balcão precisa da diferença: uma espera,
      a outra pede uma ação.
    */
    expect(await screen.findByText(new RegExp(CAIXA_FECHADO.slice(0, 30), 'i'))).toBeTruthy();
  });

  it('a venda continua na fila — recusa não é descarte', async () => {
    render(<EstadoConexao />);
    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    await screen.findByText(new RegExp(CAIXA_FECHADO.slice(0, 30), 'i'));

    // O dinheiro já foi recebido do cliente: jogar a venda fora seria perder o
    // fato. Ela espera a ação que a destrava. (A frase era "1 operação(ões)
    // aguardando envio: venda do PDV"; virou "1 venda guardada aguardando
    // envio — R$ … recebidos", com o valor e a hora — G-offline-sync-17.)
    expect(screen.getByText(/1 venda guardada aguardando envio/i)).toBeTruthy();
  });

  it('quando sobe, a barra some — nada de aviso preso na tela', async () => {
    render(<EstadoConexao />);
    respostaDoServidor = () =>
      new Response(JSON.stringify({ id: 's-1', number: 9 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });

    fireEvent.click(await screen.findByRole('button', { name: /Enviar agora/i }));
    await waitFor(() => expect(screen.queryByText(/operação/i)).toBeNull());
  });
});
