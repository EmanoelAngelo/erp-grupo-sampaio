/**
 * O ERRO TRAZ O CÓDIGO DO LOG (GAP-PRD-064).
 *
 * O servidor devolve `requestId` em todo envelope de erro e grava o mesmo
 * número no log. O cliente o jogava fora: a pessoa lia "Erro interno." e o
 * suporte não tinha como achar a linha do log daquele clique — e o roteiro de
 * incidente mandava "capturar o correlationId".
 *
 *   - 5xx com requestId: a frase ganha o começo do código;
 *   - 4xx (recusa de regra): a frase fica como o servidor escreveu;
 *   - todo erro fica nos últimos erros da aba, com o código inteiro;
 *   - o `ApiRequestError` carrega o `requestId` para quem quiser mostrar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiRequest, limparErrosDaApiParaTestes, ultimosErrosDaApi } from '@/lib/api/client';

function responder(status: number, corpo: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

beforeEach(() => {
  localStorage.clear();
  limparErrosDaApiParaTestes();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('o erro traz o código do log', () => {
  it('5xx: a frase leva o começo do código, e o erro carrega o código inteiro', async () => {
    responder(500, {
      error: { code: 'API_UNAVAILABLE', message: 'Erro interno.' },
      requestId: 'abcdef12-3456-4789-8abc-def012345678',
    });
    const erro = await apiRequest('/core/qualquer').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiRequestError);
    const e = erro as ApiRequestError;
    expect(e.message).toBe('Erro interno. Código para o suporte: abcdef12.');
    expect(e.requestId).toBe('abcdef12-3456-4789-8abc-def012345678');
    expect(e.status).toBe(500);

    const [registrado] = ultimosErrosDaApi();
    expect(registrado).toMatchObject({
      metodo: 'GET',
      caminho: '/core/qualquer',
      status: 500,
      codigo: 'API_UNAVAILABLE',
      mensagem: 'Erro interno.',
      requestId: 'abcdef12-3456-4789-8abc-def012345678',
    });
  });

  it('4xx: a frase do servidor fica como está, mas o erro também entra na lista', async () => {
    responder(409, {
      error: { code: 'CORE_STOCK_INSUFFICIENT', message: 'Saldo insuficiente.' },
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    const e = (await apiRequest('/core/sales?x=1', { method: 'POST', body: {} }).catch((x: unknown) => x)) as ApiRequestError;
    expect(e.message).toBe('Saldo insuficiente.');
    expect(e.requestId).toBe('11111111-2222-4333-8444-555555555555');
    expect(ultimosErrosDaApi()[0]).toMatchObject({ metodo: 'POST', caminho: '/core/sales', status: 409 });
  });

  it('sem requestId no corpo, nada é inventado', async () => {
    responder(500, { error: { code: 'API_UNAVAILABLE', message: 'Erro interno.' } });
    const e = (await apiRequest('/core/x').catch((x: unknown) => x)) as ApiRequestError;
    expect(e.message).toBe('Erro interno.');
    expect(e.requestId).toBeUndefined();
    expect(ultimosErrosDaApi()[0].requestId).toBeNull();
  });

  it('a lista guarda só os vinte últimos, o mais novo primeiro', async () => {
    for (let i = 0; i < 25; i += 1) {
      responder(500, { error: { code: 'E', message: `erro ${i}` }, requestId: `id-${i}` });
      await apiRequest(`/core/r${i}`).catch(() => undefined);
    }
    const lista = ultimosErrosDaApi();
    expect(lista).toHaveLength(20);
    expect(lista[0].requestId).toBe('id-24');
    expect(lista[19].requestId).toBe('id-5');
  });
});
