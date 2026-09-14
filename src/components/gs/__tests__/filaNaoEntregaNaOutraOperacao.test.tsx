/**
 * ============================================================================
 * A VENDA DA FILA SOBE SÓ NA OPERAÇÃO EM QUE FOI FEITA (RES-SESSAO)
 * ============================================================================
 *
 * O servidor passou a encerrar o access token de antes na troca de operação, e
 * o cliente, quando o 401 chega depois de a sessão mudar de operação, não
 * repete a requisição na operação nova: lança `API_SESSION_SCOPE_CHANGED`, com
 * status 409.
 *
 * Duas portas levavam a venda da operação A para a operação B:
 *
 *   1. A fila lia esse 409 como RECUSA DO SERVIDOR (`classificarFalha`: todo
 *      4xx que não é 401/408/429). E recusa, na barra de conexão, quer dizer
 *      "entregue a venda ao servidor como pendência a regularizar" — com a
 *      sessão de AGORA. A venda da loja ia para "Regularizar" da oficina, com
 *      um código de recusa que o servidor nunca deu, e saía da fila.
 *   2. A fila não sabia em que operação a venda foi feita: o reenvio seguinte
 *      saía com a sessão de agora. Consertada só a porta 1, a venda que estava
 *      no ar na hora da troca ficava na fila — e subia na oficina na tentativa
 *      seguinte. Antes do RES-SESSAO, o mesmo reenvio subia na loja, com o
 *      token de antes, que ainda valia.
 *
 * Agora a venda guardada leva a operação da sessão em que foi feita, e só sobe
 * nela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EstadoConexao } from '../EstadoConexao';
import { ApiRequestError, apiRequest, setSession, type StoredSession } from '@/lib/api/client';
import { classificarFalha, enqueue, queued, removeFromQueue } from '@/lib/api/offlineQueue';

function token(companyId: string, marca = 'primeiro'): string {
  const corpo = btoa(JSON.stringify({ sub: 'u-1', companyId, marca }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${corpo}.assinatura`;
}

const DA_LOJA = token('c-1');
const DA_OFICINA = token('c-2');
const DA_LOJA_DE_VOLTA = token('c-1', 'de-volta');

function sessao(accessToken: string, companyId: string): StoredSession {
  return {
    accessToken,
    refreshToken: `refresh-${companyId}`,
    expiresAt: Date.now() + 3_600_000,
    user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'gerente_loja' },
    company: { id: companyId, slug: companyId, tradeName: companyId, kind: 'retail' },
    companies: [
      { id: 'c-1', slug: 'c-1', tradeName: 'c-1', kind: 'retail', profileCode: 'gerente_loja' },
      { id: 'c-2', slug: 'c-2', tradeName: 'c-2', kind: 'retail', profileCode: 'gerente_loja' },
    ],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Chamada = { metodo: string; caminho: string; token: string };
let chamadas: Chamada[] = [];

const vendasEnviadas = () => chamadas.filter((c) => c.caminho === '/core/sales').map((c) => c.token);
const entregasARegularizar = () =>
  chamadas.filter((c) => c.caminho === '/core/offline-sales' && c.metodo === 'POST');

function limparFila() {
  queued().forEach((q) => removeFromQueue(q.id));
}

/** Clica em "Enviar agora" quando a barra estiver pronta para outro envio. */
async function enviarAgora() {
  await waitFor(() => {
    const botao = screen.getByRole('button', { name: /Enviar agora/i }) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', { name: /Enviar agora/i }));
}

beforeEach(() => {
  localStorage.clear();
  chamadas = [];
  setSession(sessao(DA_LOJA, 'c-1'), 'LOGIN', 'teste-fila-troca');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const chamada: Chamada = {
        metodo: init?.method ?? 'GET',
        caminho: new URL(url).pathname.replace(/^\/api\/v1/, ''),
        token: (init?.headers?.Authorization ?? '').replace(/^Bearer /, ''),
      };
      chamadas.push(chamada);
      if (chamada.caminho === '/core/sales' && chamada.token === DA_LOJA) {
        // Enquanto o reenvio estava no ar, a pessoa trocou de operação: o
        // servidor encerrou o token da loja, e a sessão agora é da oficina.
        setSession(sessao(DA_OFICINA, 'c-2'), 'EXPLICIT_OPERATION_CHANGE', 'teste-fila-troca');
        return json(401, { error: { code: 'API_SESSION_ENDED', message: 'Sessão encerrada.' } });
      }
      // Com qualquer outro token, o servidor ACEITA a venda — na operação do token.
      if (chamada.caminho === '/core/sales') return json(201, { id: 's-1', number: 7 });
      if (chamada.caminho === '/core/offline-sales' && chamada.metodo === 'POST') {
        return json(201, { jaSubiu: false, pendencia: { id: 'p-1' } });
      }
      if (chamada.caminho === '/core/offline-sales') return json(200, { items: [] });
      if (chamada.caminho === '/health') return json(200, { ok: true });
      return json(404, {});
    }),
  );
  limparFila();
  // Venda guardada antes de a fila saber a operação (o formato de antes).
  enqueue({
    path: '/core/sales',
    method: 'POST',
    body: { items: [{ productId: 'p-loja', quantity: 1 }] },
    idempotencyKey: 'venda-da-loja',
    label: 'Venda da loja',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  limparFila();
  setSession(null, 'LOGOUT', 'teste-fila-troca');
  localStorage.clear();
});

describe('a troca de operação no meio do reenvio não é recusa do servidor', () => {
  it('a sessão que mudou de operação não é classificada como recusa', () => {
    const erro = new ApiRequestError('API_SESSION_SCOPE_CHANGED', 'A sessão mudou de operação.', 409);
    expect(classificarFalha(erro)).not.toBe('recusa');
  });

  it('a venda da loja não é entregue a "Regularizar" da oficina, e continua na fila', async () => {
    render(<EstadoConexao />);
    await enviarAgora();

    // O envio terminou, de um jeito ou de outro: a fila esvaziou ou registrou a falha.
    await waitFor(() => {
      expect(vendasEnviadas().length).toBeGreaterThan(0);
      expect(queued().length === 0 || Boolean(queued()[0]?.lastAttemptAt)).toBe(true);
    });

    // Antes: POST /core/offline-sales com o token DA OFICINA, e a fila vazia.
    expect(entregasARegularizar()).toEqual([]);
    const fila = queued();
    expect(fila).toHaveLength(1);
    expect(fila[0].idempotencyKey).toBe('venda-da-loja');
    expect(fila[0].lastErrorKind).not.toBe('recusa');
    // E a venda não foi repetida na oficina.
    expect(vendasEnviadas()).toEqual([DA_LOJA]);
    // A barra diz o que houve, e não "a sessão expirou" nem "recusado".
    expect(await screen.findByText(/operação mudou/i)).toBeTruthy();
  });
});

describe('a venda guardada sobe só na operação em que foi feita', () => {
  it('depois da troca no meio do envio, o envio seguinte — já na oficina — não leva a venda da loja', async () => {
    render(<EstadoConexao />);
    await enviarAgora();
    await waitFor(() => expect(queued()[0]?.lastAttemptAt).toBeTruthy());

    await enviarAgora();
    await waitFor(() => expect(screen.getByText(/outra operação/i)).toBeTruthy());

    // Antes: o segundo envio saía com o token da oficina, e a venda da loja
    // era gravada na oficina.
    expect(vendasEnviadas()).toEqual([DA_LOJA]);
    expect(entregasARegularizar()).toEqual([]);
    expect(queued()).toHaveLength(1);
  });

  it('a venda guardada na loja não sobe na oficina', async () => {
    limparFila();
    enqueue({
      path: '/core/sales',
      method: 'POST',
      body: { items: [{ productId: 'p-loja', quantity: 1 }] },
      idempotencyKey: 'venda-guardada-na-loja',
      label: 'Venda da loja',
      escopo: { userId: 'u-1', companyId: 'c-1' },
    });
    setSession(sessao(DA_OFICINA, 'c-2'), 'EXPLICIT_OPERATION_CHANGE', 'teste-fila-troca');

    render(<EstadoConexao />);
    await enviarAgora();
    await waitFor(() =>
      expect(vendasEnviadas().length > 0 || screen.queryByText(/outra operação/i) !== null).toBe(true),
    );

    expect(vendasEnviadas()).toEqual([]);
    expect(entregasARegularizar()).toEqual([]);
    expect(queued().map((q) => q.idempotencyKey)).toEqual(['venda-guardada-na-loja']);
  });

  it('de volta à loja, a venda sobe — com o token da loja', async () => {
    limparFila();
    enqueue({
      path: '/core/sales',
      method: 'POST',
      body: { items: [{ productId: 'p-loja', quantity: 1 }] },
      idempotencyKey: 'venda-guardada-na-loja',
      label: 'Venda da loja',
      escopo: { userId: 'u-1', companyId: 'c-1' },
    });
    setSession(sessao(DA_OFICINA, 'c-2'), 'EXPLICIT_OPERATION_CHANGE', 'teste-fila-troca');
    setSession(sessao(DA_LOJA_DE_VOLTA, 'c-1'), 'EXPLICIT_OPERATION_CHANGE', 'teste-fila-troca');

    render(<EstadoConexao />);
    await enviarAgora();
    await waitFor(() => expect(queued()).toHaveLength(0));

    expect(vendasEnviadas()).toEqual([DA_LOJA_DE_VOLTA]);
  });

  it('a venda que entra na fila leva a operação e a pessoa da sessão em que foi feita', async () => {
    limparFila();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const erro = await apiRequest('/core/sales', {
      method: 'POST',
      body: { items: [] },
      idempotencyKey: 'venda-sem-servidor',
      queueWhenOffline: true,
      queueLabel: 'Venda',
    }).catch((e: unknown) => e);

    expect((erro as ApiRequestError).code).toBe('API_QUEUED_OFFLINE');
    const guardada = queued().find((q) => q.idempotencyKey === 'venda-sem-servidor');
    expect(guardada?.escopo).toEqual({ userId: 'u-1', companyId: 'c-1' });
  });
});
