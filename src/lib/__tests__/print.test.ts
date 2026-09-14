/**
 * A JANELA DE IMPRESSÃO DO PDV — o 401 que o balcão via todo dia.
 *
 * ## O defeito que este arquivo tranca
 *
 * `print.ts` abria a janela assim:
 *
 *     window.open(coreApi.printDocumentUrl(job.id))
 *
 * A rota do outro lado — `GET /core/print/jobs/:id/document` — passa por
 * `authMiddleware`, que lê o token SÓ de `req.headers.authorization`. Não há
 * cookie e não há `?token=`. Uma janela aberta por URL não manda cabeçalho
 * nenhum, então a resposta era 401 `API_AUTHENTICATION_REQUIRED`: quem fechava
 * uma venda no balcão via um JSON de erro de autenticação no lugar do cupom,
 * com o cliente na frente. Medido no navegador, não deduzido.
 *
 * Nenhum teste de servidor pegaria isso — a rota está certa, e responde certo
 * para quem manda o cabeçalho. O defeito mora inteiro no lado de cá.
 *
 * ## Como cada caso fica vermelho
 *
 *   - devolva `window.open` para a URL da API e "a janela recebe o CONTEÚDO"
 *     falha, porque o endereço deixa de ser `blob:`;
 *   - tire o `Authorization` do `apiBinary` e o caso do Bearer falha;
 *   - tire o tratamento de erro e o caso do job em `failed` falha: a janela
 *     abriria com o erro dentro, como abria antes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setSession } from '@/lib/api/client';
import { printJobInBrowser } from '@/lib/print';
import type { PrintJob } from '@/lib/api/core';

const CUPOM = '<html><body><h1>CUPOM NAO FISCAL</h1><p>Me Mimei</p></body></html>';

interface Chamada {
  url: string;
  metodo: string;
  autorizacao: string | null;
  corpo: Record<string, unknown> | null;
}

let chamadas: Chamada[];
/** Blobs entregues ao `createObjectURL`, na ordem — o conteúdo da janela. */
let blobs: Blob[];
/** O que foi passado para `window.open`. É o coração deste arquivo. */
let aberturas: string[];

const job = { id: 'job-1', status: 'queued' } as unknown as PrintJob;

/**
 * O texto de um Blob — pela ponte, porque o jsdom não implementa `Blob.text()`.
 *
 * É buraco do AMBIENTE e não do produto: `text()` é padrão desde 2020 e existe
 * em todo navegador. O `FileReader` que o jsdom implementa devolve exatamente
 * os mesmos bytes, e a ponte não decide nada do que o teste está medindo.
 */
function textoDo(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result));
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsText(blob);
  });
}

function entrar() {
  setSession(
    {
      accessToken: 'token-do-caixa',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'operador_caixa_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da impressão',
  );
}

/**
 * O servidor de verdade, na parte que importa: a rota do documento SÓ responde
 * a quem manda o Bearer. Sem o cabeçalho ela devolve 401, exatamente como o
 * `authMiddleware` faz — é isso que torna o caso da janela uma prova, e não
 * uma coincidência de implementação.
 */
function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        url: string | URL,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        const u = String(url);
        const autorizacao = init?.headers?.Authorization ?? null;
        chamadas.push({
          url: u,
          metodo: (init?.method ?? 'GET').toUpperCase(),
          autorizacao,
          corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        });

        if (u.includes('/document')) {
          if (!autorizacao) {
            return new Response(
              JSON.stringify({
                error: { code: 'API_AUTHENTICATION_REQUIRED', message: 'Autenticação obrigatória.' },
              }),
              { status: 401, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(CUPOM, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        return new Response(JSON.stringify({ id: 'job-1', status: 'printing' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    ),
  );
}

/** Janela de mentira que registra o endereço e guarda os ouvintes. */
function janelaAbrivel(abre = true) {
  const ouvintes: Record<string, (() => void)[]> = {};
  const janela = {
    addEventListener: (evento: string, ouvinte: () => void) => {
      (ouvintes[evento] ??= []).push(ouvinte);
    },
    print: vi.fn(),
    close: vi.fn(),
  };
  vi.stubGlobal(
    'open',
    vi.fn((url: string) => {
      aberturas.push(String(url));
      return abre ? janela : null;
    }),
  );
  return { janela, ouvintes };
}

beforeEach(() => {
  chamadas = [];
  blobs = [];
  aberturas = [];
  localStorage.clear();
  /*
    BURACO DO JSDOM: `URL.createObjectURL` não existe nele, e é o método que o
    conserto usa. A ponte guarda o Blob e devolve um endereço `blob:` de
    mentira — o mesmo formato que o navegador devolve —, o que dá ao teste
    exatamente as duas coisas que ele precisa medir: o endereço que foi para a
    janela e o conteúdo que estava por trás dele.
  */
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:http://localhost/objeto-${blobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da impressão');
  localStorage.clear();
});

describe('a janela recebe o cupom, e não a URL da API', () => {
  it('o endereço aberto é um blob local, nunca o endereço da rota autenticada', async () => {
    entrar();
    servidor();
    janelaAbrivel();

    await printJobInBrowser(job);

    expect(aberturas).toHaveLength(1);
    expect(aberturas[0]).toMatch(/^blob:/);
    // A prova pelo avesso: se a URL da rota chegasse à janela, ela abriria
    // sem cabeçalho e mostraria 401 — que é o que acontecia.
    expect(aberturas[0]).not.toContain('/core/print/jobs');
  });

  it('o conteúdo por trás do endereço é o CUPOM', async () => {
    entrar();
    servidor();
    janelaAbrivel();

    await printJobInBrowser(job);

    expect(blobs).toHaveLength(1);
    await expect(textoDo(blobs[0])).resolves.toBe(CUPOM);
    // O tipo viaja junto: sem ele a janela renderizaria o HTML como texto puro
    // e o cupom sairia com as tags à mostra.
    expect(blobs[0].type).toContain('text/html');
  });

  it('a busca do documento leva o Bearer — é o que o 401 exigia', async () => {
    entrar();
    servidor();
    janelaAbrivel();

    await printJobInBrowser(job);

    const doDocumento = chamadas.filter((c) => c.url.includes('/document'));
    expect(doDocumento).toHaveLength(1);
    expect(doDocumento[0].autorizacao).toBe('Bearer token-do-caixa');
  });

  it('o diálogo é disparado depois do load — e fechar o diálogo NÃO grava "impresso"', async () => {
    entrar();
    servidor();
    const { janela, ouvintes } = janelaAbrivel();

    await printJobInBrowser(job);
    expect(janela.print).not.toHaveBeenCalled();

    ouvintes.load?.forEach((o) => o());
    expect(janela.print).toHaveBeenCalledTimes(1);

    // Antes do `afterprint` nada foi impresso, e o job NÃO pode dizer que foi.
    expect(chamadas.some((c) => c.corpo?.status === 'printed')).toBe(false);
    /*
      O COMPORTAMENTO MUDOU (F-cupom-fiscal-18). Este caso cobrava `printed`
      depois do `afterprint` — e o evento dispara igual quando o operador
      CANCELA o diálogo do Windows: a fila registrava "impresso" para o cupom
      que nunca saiu. O navegador não diz se o papel saiu, então o job fica em
      `printing` (a promessa do cabeçalho de `printJobInBrowser`), e o evento
      só faz a faxina: solta o Blob e fecha a janela.
    */
    ouvintes.afterprint?.forEach((o) => o());
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas.some((c) => c.corpo?.status === 'printed')).toBe(false);
    expect(janela.close).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

describe('quando o documento não vem', () => {
  it('o job vai para failed com o motivo do servidor, e nenhuma janela abre', async () => {
    /*
      Sessão ausente: o `apiBinary` sai sem Bearer e o servidor de teste
      responde 401, igual ao `authMiddleware`. É o cenário que o código antigo
      atravessava calado — ele abria a janela ANTES de saber se havia
      documento, e o erro ia parar dentro dela.
    */
    servidor();
    janelaAbrivel();

    const falha = await printJobInBrowser(job).catch((e: Error) => e);

    expect(falha).toBeInstanceOf(Error);
    expect(aberturas).toHaveLength(0);
    const falhou = chamadas.find((c) => c.corpo?.status === 'failed');
    expect(falhou?.corpo?.error).toContain('Autenticação obrigatória');
  });

  it('pop-up bloqueado solta o Blob em vez de deixá-lo preso na memória', async () => {
    entrar();
    servidor();
    janelaAbrivel(false);

    await printJobInBrowser(job).catch(() => undefined);

    // Ninguém vai ler aquele endereço: mantê-lo prenderia o cupom inteiro na
    // memória da aba até a página ser recarregada.
    expect(aberturas).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(aberturas[0]);
    expect(chamadas.some((c) => c.corpo?.status === 'failed')).toBe(true);
  });
});
