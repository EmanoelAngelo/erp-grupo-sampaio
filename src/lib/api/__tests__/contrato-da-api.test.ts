/**
 * ============================================================================
 * O CONTRATO DA RESPOSTA — e o `undefined` que atravessava até a tela
 * ============================================================================
 *
 * ## O defeito
 *
 * `coreApi` desembrulha o envelope em 58 lugares, sempre da mesma forma:
 *
 *     apiRequest<{ items: Sale[] }>('/core/sales').then((r) => r.items)
 *
 * O servidor responde `{ items: [...] }` e o cliente entrega a lista. Enquanto
 * a chave vier, tudo funciona.
 *
 * Quando ela NÃO vem, nada reclama. `apiRequest` devolve o objeto como está,
 * `r.items` vira `undefined`, a promessa RESOLVE — e o `try/catch` da tela não
 * é acionado, porque não houve erro. O `undefined` viaja até o componente e
 * estoura lá, num `.map` ou num `.length`, com a tela em branco e a mensagem
 * "Cannot read properties of undefined".
 *
 * Isso NÃO é o caminho de erro. O caminho de erro funciona: `apiRequest` lança
 * `ApiRequestError` em qualquer status fora de 2xx, e as 86 telas do roteador
 * sobrevivem a ele (está provado em `router/__tests__/toda-tela-monta`). O que
 * não existia era o caminho de CONTRATO QUEBRADO — 200 com um corpo que não é
 * o combinado.
 *
 * ## Quando isso acontece de verdade
 *
 * O gatilho realista nasce no dia do deploy: o navegador guarda o pacote
 * antigo em cache e a API sobe nova. Uma rota que deixou de mandar `items`, ou
 * passou a responder 204, entrega `undefined` a um cliente que ainda pede
 * `items` — e o cliente apaga a tela em vez de dizer o que houve.
 *
 * ## A regra
 *
 * O desembrulho passa a ser UM ponto — `envelope(chave)` —, e contrato
 * quebrado vira `ApiRequestError`, que é o que as telas já sabem tratar.
 *
 * Ele NÃO fabrica lista vazia. Devolver `[]` quando o servidor não mandou nada
 * transformaria falha em "não há registros": a tela diria "nenhuma venda hoje"
 * num dia de movimento, e ninguém procuraria defeito nenhum.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, envelope, exigirCampos, ApiRequestError, setSession } from '../client';

/** Responde uma vez com o que o caso pedir. */
function servidor(corpo: string | null, status = 200, tipo = 'application/json') {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(status === 204 ? null : corpo, {
          status,
          headers: { 'Content-Type': tipo },
        }),
    ),
  );
}

/** A chamada que o `coreApi` faz 39 vezes. */
function listar(): Promise<unknown[]> {
  return apiRequest<{ items: unknown[] }>('/core/sales').then(envelope('items'));
}

async function erroDe(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (e) {
    return e as ApiRequestError;
  }
  throw new Error('esperava um erro e a promessa resolveu');
}

beforeEach(() => {
  setSession(null, 'LOGOUT', 'client.logout');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================

describe('1–5 · o que é resposta legítima e continua passando', () => {
  it('envelope válido com lista cheia', async () => {
    servidor(JSON.stringify({ items: [{ id: 'v-1' }, { id: 'v-2' }] }));
    await expect(listar()).resolves.toHaveLength(2);
  });

  it('envelope válido com LISTA VAZIA — que é resposta, não falha', async () => {
    /*
      A distinção que dá sentido a tudo: `{ items: [] }` é o servidor dizendo
      "não há registros", e tem de passar. `{}` é o servidor não dizendo nada,
      e tem de falhar. Tratar os dois igual foi o defeito.
    */
    servidor(JSON.stringify({ items: [] }));
    await expect(listar()).resolves.toEqual([]);
  });

  it('envelope com OBJETO, e não lista — o mesmo desembrulho serve', async () => {
    servidor(JSON.stringify({ account: { id: 'c-1', name: 'Caixa' } }));
    const conta = await apiRequest<{ account: { id: string } }>('/core/finance/accounts', {
      method: 'POST',
    }).then(envelope('account'));
    expect(conta.id).toBe('c-1');
  });

  it('valor FALSO legítimo passa — zero e false não são ausência', async () => {
    servidor(JSON.stringify({ total: 0 }));
    await expect(
      apiRequest<{ total: number }>('/core/sales').then(envelope('total')),
    ).resolves.toBe(0);
  });

  it('resposta SEM desembrulho continua entregando o objeto inteiro', async () => {
    // Nem toda chamada desembrulha: `getSession` quer o corpo todo.
    servidor(JSON.stringify({ session: { id: 's-1' }, extra: 1 }));
    const corpo = await apiRequest<{ session: unknown; extra: number }>('/core/x');
    expect(corpo.extra).toBe(1);
  });
});

// ============================================================================

describe('6 · 204 sem corpo', () => {
  it('quem espera nada continua recebendo nada', async () => {
    servidor(null, 204);
    await expect(apiRequest<void>('/core/promotions/p-1', { method: 'DELETE' })).resolves
      .toBeUndefined();
  });

  it('mas quem espera um envelope recebe ERRO, e não `undefined`', async () => {
    /*
      É o caso que o deploy cria: a rota passa a responder 204 e o pacote
      antigo do navegador continua pedindo `items`. Antes: `undefined.map` e
      tela em branco. Agora: erro nomeado, que a tela já sabe mostrar.
    */
    servidor(null, 204);
    const erro = await erroDe(listar());
    expect(erro).toBeInstanceOf(ApiRequestError);
    expect(erro.code).toBe('API_CONTRACT_BROKEN');
    expect(erro.message).toMatch(/items/);
  });
});

// ============================================================================

describe('7–13 · os erros HTTP continuam sendo erros HTTP', () => {
  const CASOS: [number, string][] = [
    [400, 'CORE_INVALID_PAYLOAD'],
    [401, 'AUTH_REQUIRED'],
    [403, 'API_PERMISSION_DENIED'],
    [404, 'CORE_NOT_FOUND'],
    [409, 'CORE_CONFLICT'],
    [422, 'CORE_UNPROCESSABLE'],
    [500, 'API_ERROR'],
  ];

  for (const [status, code] of CASOS) {
    it(`${status} preserva código, mensagem e status`, async () => {
      servidor(
        JSON.stringify({ error: { code, message: `falhou com ${status}` } }),
        status,
      );
      const erro = await erroDe(listar());
      expect(erro).toBeInstanceOf(ApiRequestError);
      expect(erro.code).toBe(code);
      expect(erro.message).toBe(`falhou com ${status}`);
      expect(erro.status).toBe(status);
    });
  }

  it('erro sem envelope de erro ainda vira ApiRequestError com o status certo', async () => {
    servidor('{}', 503);
    const erro = await erroDe(listar());
    expect(erro).toBeInstanceOf(ApiRequestError);
    expect(erro.status).toBe(503);
  });
});

// ============================================================================

describe('14 · envelope malformado', () => {
  it('200 com corpo que NÃO é JSON vira erro nomeado, não SyntaxError cru', async () => {
    /*
      É o que um proxy devolve quando o app está fora do ar: 200 com uma página
      HTML. `JSON.parse` lançava `SyntaxError: Unexpected token '<'` — um erro
      que não é `ApiRequestError` e que chega à tela como frase de runtime.
    */
    servidor('<html><body>502 Bad Gateway</body></html>', 200, 'text/html');
    const erro = await erroDe(listar());
    expect(erro).toBeInstanceOf(ApiRequestError);
    expect(erro.code).toBe('API_INVALID_RESPONSE');
  });

  it('200 com corpo VAZIO onde se espera envelope também é erro', async () => {
    servidor('', 200);
    const erro = await erroDe(listar());
    expect(erro.code).toBe('API_CONTRACT_BROKEN');
  });

  it('200 com JSON que não é objeto (uma lista solta) é erro', async () => {
    // Contrato do projeto: o corpo é sempre objeto nomeando o conteúdo. Lista
    // solta na raiz não é resposta desta API.
    servidor(JSON.stringify([{ id: 'v-1' }]));
    const erro = await erroDe(listar());
    expect(erro.code).toBe('API_CONTRACT_BROKEN');
  });
});

// ============================================================================

describe('15 · campo obrigatório ausente', () => {
  it('200 com objeto SEM a chave pedida é erro — e não lista vazia', async () => {
    servidor(JSON.stringify({ outraCoisa: [] }));
    const erro = await erroDe(listar());
    expect(erro.code).toBe('API_CONTRACT_BROKEN');
    // A mensagem nomeia a chave: sem ela, quem lê o log não sabe o que faltou.
    expect(erro.message).toMatch(/items/);
  });

  it('chave presente com valor NULO também é contrato quebrado', async () => {
    servidor(JSON.stringify({ items: null }));
    const erro = await erroDe(listar());
    expect(erro.code).toBe('API_CONTRACT_BROKEN');
  });

  it('e NUNCA devolve lista vazia no lugar — isso esconderia o defeito', async () => {
    /*
      Um `?? []` aqui transformaria falha em "não há registros": a tela diria
      "nenhuma venda hoje" num dia de movimento, e ninguém procuraria defeito.
      Este caso existe para que essa tentação fique vermelha.
    */
    servidor(JSON.stringify({}));
    await expect(listar()).rejects.toBeInstanceOf(ApiRequestError);
  });
});

// ============================================================================

/**
 * O CORPO COM VÁRIOS CAMPOS — e a diferença entre AUSENTE e NULO.
 *
 * Boa parte das telas não desembrulha um conteúdo: lê vários campos do mesmo
 * corpo (`const c = await coreApi.labelCatalog(); setSources(c.sources)`). Ali
 * o `undefined` entra pela mesma porta — `setSources(undefined)` e o
 * `sources.find` do render seguinte apaga a tela.
 *
 * E ali a régua é OUTRA: meia dúzia de tipos deste projeto declaram
 * `description: string | null`. O campo é obrigatório no contrato e o valor
 * legítimo dele é nulo — produto sem descrição existe. Reprovar nulo recusaria
 * resposta correta, e foi o que quebrou 38 casos de tela antes desta distinção
 * existir.
 */
describe('exigirCampos · o corpo com vários campos', () => {
  it('corpo completo passa e volta inteiro', () => {
    const c = exigirCampos({ sources: [], formats: [], defaultFormat: 'a' }, 'sources', 'formats');
    expect(c.defaultFormat).toBe('a');
  });

  it('campo AUSENTE reprova, e a mensagem o nomeia', () => {
    let erro: ApiRequestError | null = null;
    try {
      exigirCampos({ sources: [] } as { sources: never[]; formats?: never[] }, 'sources', 'formats');
    } catch (e) {
      erro = e as ApiRequestError;
    }
    expect(erro?.code).toBe('API_CONTRACT_BROKEN');
    expect(erro?.message).toMatch(/formats/);
    expect(erro?.message).not.toMatch(/sources/);
  });

  it('campo presente e NULO passa — nulo é valor, não ausência', () => {
    const c = exigirCampos({ description: null, name: 'Camisa' }, 'description', 'name');
    expect(c.description).toBeNull();
  });

  it('corpo inteiro ausente reprova', () => {
    expect(() => exigirCampos(undefined as unknown as { a: number }, 'a')).toThrow(ApiRequestError);
  });

  it('e NUNCA devolve objeto vazio no lugar', () => {
    expect(() => exigirCampos({} as { items?: never[] } as { items: never[] }, 'items')).toThrow();
  });
});
