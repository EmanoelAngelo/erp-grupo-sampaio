/**
 * O XML DA NOTA DE ENTRADA, na tela — o buraco irreversível, agora com botão.
 *
 * ## O que estava em jogo
 *
 * Até a rodada 27 o arquivo do fornecedor era lido, virava linha e era
 * descartado. Não é um campo a mais: é o documento assinado por um terceiro,
 * que o contador escritura e que ninguém pode remontar. O servidor passou a
 * guardá-lo verbatim — mas guardar sem entregar não resolve nada, e é essa
 * metade que este arquivo cobra.
 *
 * ## A frase da nota velha é o caso mais fácil de escrever errado
 *
 * A nota importada ANTES da rodada 27 não tem arquivo e nunca terá. A tela
 * precisa dizer isso, e a tentação é escrever "notas anteriores a abril de
 * 2026". Essa frase envelhece em silêncio: basta a migração rodar noutra data,
 * ou alguém restaurar um banco antigo, para a tela afirmar uma data que nunca
 * existiu. A data sai do DADO — de `issued_at`, com `created_at` de reserva.
 *
 * ## Como cada caso fica vermelho
 *
 *   - mostre o botão sempre (ignorando `tem_xml`) e a nota velha ganha um
 *     clique que termina em 404;
 *   - troque `mesDaNota` por uma data escrita no código e o caso das duas
 *     notas com meses diferentes falha;
 *   - troque `apiBinary` por um `<a href>` para a rota e nada chega ao
 *     `salvarArquivo`;
 *   - trate os dois 404 como um só e a nota sem arquivo passa a mandar alguém
 *     procurar um defeito que não existe.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';

const XML_DO_FORNECEDOR =
  '<?xml version="1.0" encoding="UTF-8"?><nfeProc><NFe><infNFe Id="NFe3524"/></NFe></nfeProc>';

interface Chamada {
  url: string;
  autorizacao: string | null;
}

let chamadas: Chamada[];
let salvos: string[];
let notas: ReturnType<typeof nota>[];
let respostaDoXml: () => Response;

function nota(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: 'n-nova',
    access_key: '35240114200166000187550010000000011000000017',
    number: '11',
    series: '1',
    supplier_name: 'Distribuidora Alfa',
    total_cents: 125000,
    status: 'recebida',
    created_at: '2026-04-12T10:00:00.000Z',
    issued_at: '2026-04-10T09:00:00.000Z',
    carrier_name_xml: null,
    freight_mode: null,
    volumes_qty: null,
    gross_weight_grams: null,
    vehicle_plate: null,
    tem_xml: 1,
    ...sobrescreve,
  };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      chamadas.push({ url: u, autorizacao: init?.headers?.Authorization ?? null });

      if (u.includes('/xml')) return respostaDoXml();
      if (u.includes('/purchases/notes')) return json({ items: notas });
      // Bancadas e peças: extras desta tela, que não interessam a estes casos.
      return json({ items: [] });
    }),
  );
}

function entrar(profileCode = 'gerente_loja') {
  setSession(
    {
      accessToken: 'token-do-estoque',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode },
      company: { id: 'loja', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do XML da entrada',
  );
}

async function montar() {
  entrar();
  servidor();
  render(
    <MemoryRouter>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findByText('Distribuidora Alfa');
}

beforeEach(() => {
  chamadas = [];
  salvos = [];
  notas = [nota()];
  respostaDoXml = () =>
    new Response(XML_DO_FORNECEDOR, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition':
          'attachment; filename="35240114200166000187550010000000011000000017-nfe.xml"',
      },
    });
  localStorage.clear();

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:http://localhost/objeto'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    salvos.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do XML da entrada');
  localStorage.clear();
});

describe('o botão existe só onde o arquivo existe', () => {
  it('a nota com arquivo tem botão; a nota velha tem a frase', async () => {
    notas = [
      nota(),
      nota({
        id: 'n-velha',
        access_key: '35230114200166000187550010000000091000000091',
        number: '9',
        supplier_name: 'Atacado Beta',
        created_at: '2024-03-08T14:00:00.000Z',
        issued_at: '2024-03-05T08:00:00.000Z',
        tem_xml: 0,
      }),
    ];
    await montar();

    expect(screen.getAllByRole('button', { name: 'Baixar XML' })).toHaveLength(1);
    /*
      A DATA VEM DA NOTA. Trocar `mesDaNota` por um mês escrito no código deixa
      este caso vermelho — as duas notas são de meses diferentes, e só uma
      delas está sem arquivo.
    */
    expect(screen.getByText(/sem arquivo — entrou em 03\/2024/)).toBeTruthy();
    expect(screen.queryByText(/entrou em 04\/2026/)).toBeNull();
  });

  it('sem `issued_at` a frase cai na data de criação, e não some', async () => {
    // Nota antiga de verdade pode não ter emissão preenchida. Uma frase que
    // dependesse só de `issued_at` viraria "sem arquivo — entrou em Invalid
    // Date" na tela de quem tem justamente as notas mais velhas.
    notas = [nota({ tem_xml: 0, issued_at: null, created_at: '2023-11-20T12:00:00.000Z' })];
    await montar();

    expect(screen.getByText(/sem arquivo — entrou em 11\/2023/)).toBeTruthy();
  });

  it('a entrada manual não tem botão e não finge ter perdido o arquivo (GAP-PRD-204)', async () => {
    // Compra digitada nunca teve XML: a frase da nota antiga ("antes de o
    // sistema guardar o XML") mandaria o contador procurar o que não existe.
    notas = [nota({ id: 'n-manual', doc_type: 'manual', tem_xml: 0, number: 'EM-3' })];
    await montar();

    expect(screen.queryByRole('button', { name: 'Baixar XML' })).toBeNull();
    expect(screen.getByText('entrada manual — sem nota fiscal')).toBeTruthy();
    expect(screen.queryByText(/antes de o sistema guardar o XML/)).toBeNull();
  });

  it('resposta antiga do servidor, sem `tem_xml`, é lida como "não tem"', async () => {
    // Ausente tem de significar a verdade de antes da rodada 27 — nunca um
    // botão otimista que devolve 404.
    notas = [nota({ tem_xml: undefined })];
    await montar();

    expect(screen.queryByRole('button', { name: 'Baixar XML' })).toBeNull();
  });
});

describe('o download do arquivo', () => {
  it('busca com o Bearer e salva com o nome do Content-Disposition', async () => {
    /*
      O cabeçalho nomeia diferente da reserva da tela, de propósito.

      Em produção os dois coincidem: o servidor monta o nome a partir da mesma
      chave de acesso que a lista traz. Iguais, porém, o caso passaria com a
      tela lendo qualquer um dos dois — e o que se quer provar aqui é que ela
      lê o CABEÇALHO, que é quem sabe o nome de verdade do arquivo servido.
    */
    respostaDoXml = () =>
      new Response(XML_DO_FORNECEDOR, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml',
          'Content-Disposition': 'attachment; filename="nota-do-fornecedor-nfe.xml"',
        },
      });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar XML' }));

    await waitFor(() => expect(salvos).toHaveLength(1));
    expect(salvos[0]).toBe('nota-do-fornecedor-nfe.xml');

    const doXml = chamadas.find((c) => c.url.includes('/xml'));
    expect(doXml?.url).toContain('/core/purchases/notes/n-nova/xml');
    // Um `<a href>` para esta rota receberia 401 do `authMiddleware`.
    expect(doXml?.autorizacao).toBe('Bearer token-do-estoque');
  });

  it('sem o cabeçalho, o arquivo ainda sai com a chave de acesso no nome', async () => {
    // É o que acontece se o `exposedHeaders` do CORS cair: o cabeçalho existe
    // e o navegador o esconde do JavaScript. Sem a reserva, o contador
    // receberia um arquivo chamado com o identificador interno da linha.
    respostaDoXml = () =>
      new Response(XML_DO_FORNECEDOR, { status: 200, headers: { 'Content-Type': 'application/xml' } });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar XML' }));

    await waitFor(() => expect(salvos).toHaveLength(1));
    expect(salvos[0]).toBe('35240114200166000187550010000000011000000017-nfe.xml');
  });

  it('nota sem arquivo guardado diz que o arquivo não existe — e não que a nota sumiu', async () => {
    /*
      Corrida real: a lista foi carregada antes de alguém apagar o XML, ou o
      `tem_xml` chegou desatualizado. Os dois códigos de 404 do servidor
      existem para esta diferença, e é aqui que ela serve para alguma coisa.
    */
    respostaDoXml = () =>
      json(
        {
          error: {
            code: 'CORE_INBOUND_NOTE_XML_AUSENTE',
            message:
              'O XML desta nota não foi guardado. Ela entrou antes de o sistema passar a guardar '
              + 'o arquivo do fornecedor, e não há como recuperá-lo.',
          },
        },
        404,
      );
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar XML' }));

    expect(await screen.findByText(/não há como recuperá-lo/)).toBeTruthy();
    expect(salvos).toHaveLength(0);
  });

  it('nota que não é mais desta operação recarrega a lista e diz outra coisa', async () => {
    respostaDoXml = () =>
      json(
        { error: { code: 'CORE_INBOUND_NOTE_NOT_FOUND', message: 'Nota de entrada não encontrada.' } },
        404,
      );
    await montar();
    const listagensAntes = chamadas.filter((c) => c.url.endsWith('/purchases/notes')).length;

    fireEvent.click(screen.getByRole('button', { name: 'Baixar XML' }));

    expect(await screen.findByText(/não está mais nesta operação/)).toBeTruthy();
    // Recarregar é o gesto certo aqui, e é o que separa este caso do de cima:
    // a lista na tela está velha, não o arquivo.
    await waitFor(() =>
      expect(chamadas.filter((c) => c.url.endsWith('/purchases/notes')).length).toBeGreaterThan(
        listagensAntes,
      ),
    );
  });
});
