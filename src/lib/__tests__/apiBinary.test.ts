/**
 * `apiBinary` — o irmão binário do cliente, e por que ele não podia ser texto.
 *
 * ## O que cada caso protege, e como fica vermelho
 *
 * Este arquivo existe porque o helper tem quatro decisões que parecem detalhe
 * e não são. Cada uma já produziu, em algum sistema, um arquivo que baixa,
 * tem tamanho, tem nome — e não abre:
 *
 *   - troque `res.blob()` por `res.text()` e o zip perde os bytes que não são
 *     UTF-8 válido (o caso "o byte 0x89 sobrevive");
 *   - tire o `Authorization` e a requisição sai sem portador (o caso do
 *     Bearer);
 *   - tire o retry depois do refresh e o download falha com a sessão viva (o
 *     caso do 401);
 *   - tire a leitura do `Content-Disposition` e todo arquivo cai na pasta de
 *     downloads com o nome de reserva;
 *   - tire o `?? nomePadrao` e o arquivo fica sem nome no navegador que filtra
 *     o cabeçalho — que é o que acontece sem `exposedHeaders` no CORS;
 *   - tire a leitura do corpo de erro e a tela perde o CÓDIGO, que é o que
 *     separa "nota não existe" de "nota sem arquivo guardado".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiRequestError, apiBinary, setSession } from '@/lib/api/client';

/*
  BURACO DO JSDOM, não do produto — a mesma ponte que o teste da importação de
  planilha já precisou. `Blob.prototype.arrayBuffer` existe em todo navegador
  desde 2020; sem ela, o caso que compara BYTE A BYTE seria impossível de
  escrever, e é justamente ele o motivo deste helper existir.
*/
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(leitor.result as ArrayBuffer);
      leitor.onerror = () => reject(leitor.error);
      leitor.readAsArrayBuffer(this);
    });
  };
}

interface Chamada {
  url: string;
  autorizacao: string | null;
}

let chamadas: Chamada[];

function entrar(accessToken = 'token-1') {
  setSession(
    {
      accessToken,
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do apiBinary',
  );
}

/** Registra cada requisição e devolve o que o caso pedir. */
function servidor(resposta: (url: string, tentativa: number) => Response) {
  let tentativa = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      chamadas.push({ url: u, autorizacao: init?.headers?.Authorization ?? null });
      tentativa += 1;
      return resposta(u, tentativa);
    }),
  );
}

function erro(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  chamadas = [];
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do apiBinary');
  localStorage.clear();
});

describe('o arquivo chega como bytes, não como texto', () => {
  it('o byte 0x89 sobrevive à viagem', async () => {
    /*
      `PK\x03\x04` é a assinatura do zip, e logo depois vêm bytes que NÃO
      formam UTF-8 válido. Passar isso por `res.text()` os troca por U+FFFD —
      três bytes cada — e o arquivo resultante tem tamanho, tem nome e o
      Windows recusa abrir. Comparar byte a byte é a única forma de provar que
      não houve decodificação no caminho.
    */
    const cru = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x89, 0xff, 0xfe, 0x00, 0x1f]);
    entrar();
    servidor(() => new Response(cru, { status: 200 }));

    const arquivo = await apiBinary('/core/fiscal/closings/2026-04/pacote', 'reserva.zip');
    const recebido = new Uint8Array(await arquivo.blob.arrayBuffer());

    expect(Array.from(recebido)).toEqual(Array.from(cru));
  });
});

describe('a porta é o cabeçalho, não a URL', () => {
  it('a requisição sai com o Bearer da sessão', async () => {
    entrar('token-do-gerente');
    servidor(() => new Response(new Uint8Array([1, 2]), { status: 200 }));

    await apiBinary('/core/purchases/notes/n-1/xml', 'nota.xml');

    expect(chamadas[0].autorizacao).toBe('Bearer token-do-gerente');
  });

  it('401 com sessão viva renova e REPETE — o download não morre no meio', async () => {
    entrar('token-vencido');
    servidor((url, tentativa) => {
      if (url.includes('/auth/refresh')) {
        return new Response(
          JSON.stringify({ accessToken: 'token-novo', refreshToken: 'r-2', expiresIn: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (tentativa === 1) return erro('API_AUTHENTICATION_REQUIRED', 'Autenticação obrigatória.', 401);
      return new Response(new Uint8Array([0x50, 0x4b]), { status: 200 });
    });

    const arquivo = await apiBinary('/core/fiscal/closings/2026-04/pacote', 'reserva.zip');

    expect(new Uint8Array(await arquivo.blob.arrayBuffer()).length).toBe(2);
    // A segunda ida ao arquivo já leva o token novo — é isso que faz a sessão
    // sobreviver ao vencimento no meio de um download.
    const doArquivo = chamadas.filter((c) => c.url.includes('/pacote'));
    expect(doArquivo.map((c) => c.autorizacao)).toEqual([
      'Bearer token-vencido',
      'Bearer token-novo',
    ]);
  });
});

describe('o nome do arquivo', () => {
  it('vem do Content-Disposition quando o servidor o expõe', async () => {
    entrar();
    servidor(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="pacote-me-mimei-2026-04.zip"' },
        }),
    );

    const arquivo = await apiBinary('/core/fiscal/closings/2026-04/pacote', 'reserva.zip');

    expect(arquivo.nomeArquivo).toBe('pacote-me-mimei-2026-04.zip');
  });

  it('cai no nome de reserva quando o cabeçalho não chega', async () => {
    /*
      É EXATAMENTE o que acontece sem `exposedHeaders: ['Content-Disposition']`
      no CORS: o cabeçalho sai do servidor e o navegador o filtra antes de o
      JavaScript vê-lo. Sem o `?? nomePadrao`, o arquivo cairia na pasta de
      downloads com o nome que o navegador inventar.
    */
    entrar();
    servidor(() => new Response(new Uint8Array([1]), { status: 200 }));

    const arquivo = await apiBinary('/core/fiscal/closings/2026-04/pacote', 'pacote-loja-2026-04.zip');

    expect(arquivo.nomeArquivo).toBe('pacote-loja-2026-04.zip');
  });

  it('a forma com acento (filename*) vence a simples', async () => {
    entrar();
    servidor(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            'Content-Disposition':
              "attachment; filename=\"pacote.zip\"; filename*=UTF-8''pacote-fevereiro-servi%C3%A7os.zip",
          },
        }),
    );

    const arquivo = await apiBinary('/core/fiscal/closings/2026-02/pacote', 'reserva.zip');

    expect(arquivo.nomeArquivo).toBe('pacote-fevereiro-serviços.zip');
  });

  it('nome com barra ou ".." não sai da pasta de downloads', async () => {
    // Cabeçalho é entrada, mesmo vindo do nosso servidor. O filtro custa uma
    // linha e fecha a única forma de um download escrever onde não deve.
    entrar();
    servidor(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="../../etc/passwd.zip"' },
        }),
    );

    const arquivo = await apiBinary('/core/fiscal/closings/2026-04/pacote', 'reserva.zip');

    expect(arquivo.nomeArquivo).not.toContain('/');
    expect(arquivo.nomeArquivo).not.toContain('..');
  });
});

describe('o erro chega com CÓDIGO, que é o que a tela usa para escolher a frase', () => {
  it('nota sem arquivo guardado preserva CORE_INBOUND_NOTE_XML_AUSENTE', async () => {
    entrar();
    servidor(() =>
      erro('CORE_INBOUND_NOTE_XML_AUSENTE', 'O XML desta nota não foi guardado.', 404),
    );

    const falha = await apiBinary('/core/purchases/notes/n-1/xml', 'nota.xml').catch((e) => e);

    expect(falha).toBeInstanceOf(ApiRequestError);
    expect((falha as ApiRequestError).code).toBe('CORE_INBOUND_NOTE_XML_AUSENTE');
    expect((falha as ApiRequestError).status).toBe(404);
    expect((falha as ApiRequestError).message).toContain('não foi guardado');
  });

  it('o 413 do pacote grande demais chega com o número medido do servidor', async () => {
    entrar();
    servidor(() =>
      erro(
        'CORE_FISCAL_PACOTE_GRANDE_DEMAIS',
        'O pacote deste mês tem 7.312 documentos, acima do teto de 5.000.',
        413,
      ),
    );

    const falha = await apiBinary('/core/fiscal/closings/2026-04/pacote', 'reserva.zip').catch(
      (e) => e,
    );

    expect((falha as ApiRequestError).code).toBe('CORE_FISCAL_PACOTE_GRANDE_DEMAIS');
    // O NÚMERO é a única informação útil da resposta: é ele que diz se o caso
    // é dividir o mês ou se há algo errado. Uma mensagem genérica o jogaria fora.
    expect((falha as ApiRequestError).message).toContain('7.312');
  });
});
