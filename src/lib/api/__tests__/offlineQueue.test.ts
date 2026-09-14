/**
 * Fila de escrita para quando o servidor não responde.
 *
 * O RISCO QUE ESTE ARQUIVO EXISTE PARA CONTER: fila de reenvio mal feita é uma
 * máquina de vender duas vezes. Só entra o que tem CHAVE DE IDEMPOTÊNCIA — é
 * ela que faz o servidor devolver a venda original em vez de criar outra.
 *
 * A segunda distinção, igualmente cara: rede caída é caso de fila; recusa do
 * servidor (estoque insuficiente, permissão negada) é erro que o operador
 * precisa ver AGORA. Enfileirar uma recusa faria o sistema insistir para sempre
 * numa venda que nunca vai passar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueue,
  flushQueue,
  isNetworkFailure,
  queued,
  removeFromQueue,
  subscribeQueue,
} from '../offlineQueue';

beforeEach(() => {
  localStorage.clear();
});

function venda(chave: string, rotulo = 'venda do PDV') {
  return {
    path: '/core/sales',
    method: 'POST',
    body: { total: 1000 },
    idempotencyKey: chave,
    label: rotulo,
  };
}

describe('só entra o que pode ser reenviado', () => {
  it('requisição SEM chave de idempotência é recusada', () => {
    // Sem a chave, reenviar é duplicar. A guarda é dura de propósito.
    expect(() => enqueue({ ...venda(''), idempotencyKey: '' })).toThrow(/idempot/i);
    expect(queued()).toHaveLength(0);
  });

  it('com chave, entra e persiste', () => {
    enqueue(venda('chave-1'));
    expect(queued()).toHaveLength(1);
    expect(queued()[0].idempotencyKey).toBe('chave-1');
  });

  it('a fila sobrevive ao fechamento do navegador', () => {
    enqueue(venda('chave-persistente'));
    // `queued()` relê do localStorage — é o mesmo caminho de um recarregamento.
    expect(queued()[0].idempotencyKey).toBe('chave-persistente');
  });
});

describe('reenvio', () => {
  it('envia na ORDEM e limpa o que subiu', async () => {
    enqueue(venda('a'));
    enqueue(venda('b'));
    const enviadas: string[] = [];

    const r = await flushQueue(async (item) => {
      enviadas.push(item.idempotencyKey);
    });

    // Ordem importa: duas vendas do mesmo produto no fim do estoque têm
    // desfechos diferentes conforme quem chega primeiro.
    expect(enviadas).toEqual(['a', 'b']);
    expect(r.sent).toBe(2);
    expect(queued()).toHaveLength(0);
  });

  it('reenvia com a MESMA chave — é o que impede duplicar', async () => {
    enqueue(venda('chave-unica'));
    const chaves: string[] = [];
    await flushQueue(async (item) => {
      chaves.push(item.idempotencyKey);
    });
    expect(chaves).toEqual(['chave-unica']);
  });

  it('falha interrompe o lote e mantém o que faltou', async () => {
    enqueue(venda('primeira'));
    enqueue(venda('segunda'));
    enqueue(venda('terceira'));

    const r = await flushQueue(async (item) => {
      if (item.idempotencyKey === 'segunda') throw new Error('servidor caiu de novo');
    });

    expect(r.sent).toBe(1);
    // Insistir nas seguintes deixaria buracos no meio da fila, e o operador não
    // teria como saber quais passaram.
    expect(queued().map((q) => q.idempotencyKey)).toEqual(['segunda', 'terceira']);
  });

  it('a falha fica registrada na própria linha', async () => {
    enqueue(venda('com-erro'));
    await flushQueue(async () => {
      throw new Error('timeout');
    });
    expect(queued()[0].attempts).toBe(1);
    expect(queued()[0].lastError).toContain('timeout');
  });

  it('fila vazia não faz nada', async () => {
    const r = await flushQueue(async () => {
      throw new Error('não deveria ser chamado');
    });
    expect(r).toEqual({ sent: 0, forwarded: 0, failed: 0 });
  });
});

describe('rede caída não é recusa do servidor', () => {
  it('falha de fetch conta como rede', () => {
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('recusa do servidor NÃO conta', () => {
    // 409 de estoque insuficiente precisa chegar ao operador agora, e não
    // virar tentativa eterna.
    const recusa = Object.assign(new Error('Estoque insuficiente'), { name: 'ApiRequestError' });
    expect(isNetworkFailure(recusa)).toBe(false);
  });
});

describe('a tela acompanha', () => {
  it('quem assina recebe o estado atual e as mudanças', () => {
    const vistos: number[] = [];
    const cancelar = subscribeQueue((f) => vistos.push(f.length));

    enqueue(venda('x'));
    enqueue(venda('y'));
    removeFromQueue(queued()[0].id);
    cancelar();

    // Estado inicial (0) mais cada mudança.
    expect(vistos).toEqual([0, 1, 2, 1]);
  });

  it('fila corrompida não trava a tela', () => {
    localStorage.setItem('gs.fila.escrita', 'isso não é json');
    // Começar vazia é melhor que derrubar o balcão.
    expect(queued()).toEqual([]);
  });
});

describe('integração com o cliente da API', () => {
  it('venda sem servidor vai para a fila, com erro que a tela entende', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { apiRequest } = await import('../client');

    await expect(
      apiRequest('/core/sales', {
        method: 'POST',
        body: { items: [] },
        idempotencyKey: 'venda-offline',
        queueWhenOffline: true,
        queueLabel: 'venda do PDV',
        anonymous: true,
      }),
    ).rejects.toMatchObject({ code: 'API_QUEUED_OFFLINE' });

    expect(queued()).toHaveLength(1);
    expect(queued()[0].label).toBe('venda do PDV');
    vi.unstubAllGlobals();
  });

  it('CONSULTA sem servidor NÃO vai para a fila', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { apiRequest } = await import('../client');

    // Fingir que uma consulta "foi enfileirada" mostraria dado velho como
    // atual — pior que dizer que está sem conexão.
    await expect(apiRequest('/core/products', { anonymous: true })).rejects.toThrow();
    expect(queued()).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
