/**
 * A TELA DO FECHAMENTO — a metade que só se prova clicando.
 *
 * ## Por que o servidor verde não basta
 *
 * O pacote tem 38 testes verdes no servidor, e nenhum deles alcança o que
 * quebra aqui. O servidor pode devolver `mesesComMateriaPrima` perfeito e a
 * tela abrir num mês vazio; pode listar quatro pendências e a tela mostrar
 * zero; pode responder 413 com o número medido e a tela dizer "falha ao
 * baixar". Toda vez que este projeto teve um defeito desse feitio — as 18
 * rotas inalcançáveis, o roteador de peças, o 401 da impressão —, o servidor
 * estava certo e o teste de servidor estava verde.
 *
 * ## Como cada caso fica vermelho
 *
 *   - tire o pulo para `mesesComMateriaPrima[0]` e a tela abre no mês corrente
 *     vazio;
 *   - deixe o pulo sem a trava do `useRef` e escolher um mês vazio à mão volta
 *     sozinho para o mês cheio;
 *   - troque `apiBinary` por um `<a href>` para a rota e o Blob nunca chega ao
 *     `salvarArquivo`;
 *   - use `previa.nomeArquivo` em vez do nome que veio do `Content-Disposition`
 *     e o arquivo salvo passa a ignorar o que o servidor nomeou;
 *   - troque a mensagem de erro pela genérica e o número do 413 some;
 *   - esconda o botão quando houver pendência e o caso "pendência não bloqueia"
 *     falha — que é a decisão de projeto mais fácil de perder numa revisão.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FechamentoContadorPage from '../FechamentoContadorPage';

interface Chamada {
  url: string;
  autorizacao: string | null;
}

let chamadas: Chamada[];
/** Nome e bytes de cada download que chegou à pasta de downloads. */
let salvos: { nome: string; blob: Blob }[];
/** Como o servidor responde à rota do pacote — cada caso troca o que precisa. */
let respostaDoPacote: () => Response;
/** Respostas escritas à mão, por período. O resto do calendário é gerado. */
let previas: Record<string, ReturnType<typeof previaBase>>;
/** Liga a recusa de período do servidor — o 400 de `periodBounds`. */
let recusaPeriodo: boolean;

/**
 * O mês que o servidor devolveria para um período SEM nada.
 *
 * Existe porque o servidor responde a qualquer mês válido, inclusive os
 * vazios: é justamente essa resposta que o seletor consome para decidir para
 * onde pular. Um dublê que só conhecesse abril devolveria erro em maio, e os
 * casos mediriam o tratamento de erro em vez do pulo.
 */
function mesVazio(periodo: string) {
  return previaBase({
    period: periodo,
    primeiroDia: `${periodo}-01`,
    ultimoDia: `${periodo}-28`,
    nomeArquivo: `pacote-me-mimei-${periodo}.zip`,
    contagens: {
      emitidasAutorizadas: 0,
      emitidasCanceladas: 0,
      eventos: 0,
      recebidasComArquivo: 0,
      recebidasSemArquivo: 0,
      faixasInutilizadas: 0,
    },
  });
}

function previaBase(sobrescreve: Record<string, unknown> = {}) {
  return {
    period: '2026-04',
    primeiroDia: '2026-04-01',
    ultimoDia: '2026-04-30',
    empresa: { nome: 'Me Mimei Modas', slug: 'me-mimei' },
    nomeArquivo: 'pacote-me-mimei-2026-04.zip',
    contagens: {
      emitidasAutorizadas: 12,
      emitidasCanceladas: 1,
      eventos: 3,
      recebidasComArquivo: 7,
      recebidasSemArquivo: 2,
      faixasInutilizadas: 1,
    },
    pendencias: [] as { codigo: string; titulo: string; detalhe: string; quantidade: number }[],
    mesesComMateriaPrima: ['2026-04', '2026-03'],
    ...sobrescreve,
  };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function erro(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      chamadas.push({ url: u, autorizacao: init?.headers?.Authorization ?? null });

      if (u.includes('/pacote')) return respostaDoPacote();

      const periodo = /closings\/([^/]+)\/previa/.exec(u)?.[1] ?? '';
      if (recusaPeriodo) {
        return erro(
          'CORE_FISCAL_PERIODO_INVALIDO',
          `Período "${periodo}" não é um mês válido. Use o formato AAAA-MM, com mês de 01 a 12.`,
          400,
        );
      }
      return json(previas[periodo] ?? mesVazio(periodo));
    }),
  );
}

function entrar(profileCode = 'gerente_loja') {
  setSession(
    {
      accessToken: 'token-do-gerente',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode },
      company: { id: 'loja', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do fechamento',
  );
}

async function montar() {
  entrar();
  servidor();
  render(
    <MemoryRouter>
      <FechamentoContadorPage />
    </MemoryRouter>,
  );
  await screen.findByText(/O que abril de 2026 tem/);
}

beforeEach(() => {
  chamadas = [];
  salvos = [];
  previas = { '2026-04': previaBase() };
  recusaPeriodo = false;
  respostaDoPacote = () =>
    new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x89]), {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="pacote-me-mimei-2026-04.zip"' },
    });
  localStorage.clear();

  /*
    O relógio parado em MAIO de 2026, e um mês com matéria-prima em ABRIL.

    Sem congelar o relógio, o caso do seletor mediria coisas diferentes a cada
    execução — em abril de 2026 ele ficaria verde por acaso, sem o pulo nunca
    acontecer. A data escolhida é de propósito um mês DEPOIS do último mês com
    dado: é a situação real de quem abre a tela no começo do mês para fechar o
    anterior.
  */
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-05-06T12:00:00.000Z'));

  // O jsdom não implementa nem `createObjectURL` nem o download por âncora.
  // A ponte registra o que teria ido para a pasta de downloads.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:http://localhost/objeto'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    salvos.push({ nome: this.download, blob: new Blob() });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do fechamento');
  localStorage.clear();
});

describe('o seletor abre onde tem matéria-prima', () => {
  it('o mês corrente vazio cede lugar ao mês mais recente COM dado', async () => {
    /*
      É maio; maio não tem nada; abril tem. Abrir em maio mostraria a grade zerada
      e faria quem clicou concluir que a função não funciona — foi por isso que
      `mesesComMateriaPrima` existe na resposta do servidor.
    */
    previas['2026-05'] = previaBase({
      period: '2026-05',
      primeiroDia: '2026-05-01',
      ultimoDia: '2026-05-31',
      nomeArquivo: 'pacote-me-mimei-2026-05.zip',
      contagens: {
        emitidasAutorizadas: 0,
        emitidasCanceladas: 0,
        eventos: 0,
        recebidasComArquivo: 0,
        recebidasSemArquivo: 0,
        faixasInutilizadas: 0,
      },
    });
    entrar();
    servidor();
    render(
      <MemoryRouter>
        <FechamentoContadorPage />
      </MemoryRouter>,
    );

    await screen.findByText(/O que abril de 2026 tem/);
    // A primeira consulta foi ao mês corrente; a segunda, ao mês do dado.
    const periodosPedidos = chamadas
      .filter((c) => c.url.includes('/previa'))
      .map((c) => /closings\/([^/]+)\/previa/.exec(c.url)?.[1]);
    expect(periodosPedidos).toEqual(['2026-05', '2026-04']);
    expect((screen.getByLabelText('Mês do fechamento') as HTMLSelectElement).value).toBe('2026-04');
  });

  it('lista vazia é resposta legítima: fica no mês corrente e diz que não houve movimento', async () => {
    previas['2026-05'] = previaBase({
      period: '2026-05',
      primeiroDia: '2026-05-01',
      ultimoDia: '2026-05-31',
      nomeArquivo: 'pacote-me-mimei-2026-05.zip',
      contagens: {
        emitidasAutorizadas: 0,
        emitidasCanceladas: 0,
        eventos: 0,
        recebidasComArquivo: 0,
        recebidasSemArquivo: 0,
        faixasInutilizadas: 0,
      },
      mesesComMateriaPrima: [],
    });
    entrar();
    servidor();
    render(
      <MemoryRouter>
        <FechamentoContadorPage />
      </MemoryRouter>,
    );

    await screen.findByText(/O que maio de 2026 tem/);
    // Seis zeros sem uma frase seriam lidos como defeito da tela.
    expect(screen.getByText(/não tem nota emitida, evento nem nota de entrada/)).toBeTruthy();
    expect(chamadas.filter((c) => c.url.includes('/previa'))).toHaveLength(1);
  });

  it('escolher um mês à mão MANDA — o pulo não acontece uma segunda vez', async () => {
    /*
      Sem a trava, o pulo aconteceria a cada carregamento: quem escolhesse
      março (que aqui não tem dado nenhum na lista) seria jogado de volta para
      abril no instante seguinte, e a tela desobedeceria a pessoa.
    */
    previas['2026-03'] = previaBase({
      period: '2026-03',
      primeiroDia: '2026-03-01',
      ultimoDia: '2026-03-31',
      nomeArquivo: 'pacote-me-mimei-2026-03.zip',
      mesesComMateriaPrima: ['2026-04'],
    });
    await montar();

    fireEvent.change(screen.getByLabelText('Mês do fechamento'), { target: { value: '2026-03' } });

    await screen.findByText(/O que março de 2026 tem/);
    expect((screen.getByLabelText('Mês do fechamento') as HTMLSelectElement).value).toBe('2026-03');
  });
});

describe('a prévia conta o mês', () => {
  it('mostra as contagens da grade e o nome do arquivo que vai sair', async () => {
    await montar();

    expect(screen.getByText('Notas autorizadas').parentElement?.textContent).toContain('12');
    expect(screen.getByText('Compras sem XML').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Faixas inutilizadas').parentElement?.textContent).toContain('1');
    expect(screen.getByText('pacote-me-mimei-2026-04.zip')).toBeTruthy();
    expect(screen.getByText(/de 2026-04-01 a 2026-04-30/)).toBeTruthy();
  });

  it('a pendência aparece com o detalhe inteiro E NÃO bloqueia o download', async () => {
    /*
      A decisão mais fácil de perder numa revisão: com zero notas emitidas no
      banco real, um critério bloqueante reprovaria todos os meses, todos os
      meses — e um alerta que sempre acende deixa de ser lido.
    */
    previas['2026-04'] = previaBase({
      pendencias: [
        {
          codigo: 'RECEBIDA_SEM_ARQUIVO',
          titulo: 'Nota recebida sem o XML guardado',
          detalhe: 'O XML delas não existe mais e não há como recuperá-lo.',
          quantidade: 2,
        },
        {
          codigo: 'RECEBIDA_NAO_CONFERIDA',
          titulo: 'Nota recebida ainda em conferência',
          detalhe: 'A mercadoria não foi conferida.',
          quantidade: 1,
        },
      ],
    });
    await montar();

    // O DETALHE inteiro, e não só o título: é ele que diz o que fazer a
    // respeito, e é a parte que uma tela apressada resume até virar rótulo.
    expect(screen.getByText(/O XML delas não existe mais/)).toBeTruthy();
    expect(screen.getByText('Nota recebida sem o XML guardado').textContent).toContain('(2)');
    expect(screen.getByText(/A mercadoria não foi conferida/)).toBeTruthy();

    const botao = screen.getByRole('button', { name: 'Baixar o pacote' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
  });
});

/**
 * ============================================================================
 * AS TRÊS AUSÊNCIAS DA COMPRA RECEBIDA, CADA UMA COM O SEU TILE
 * ============================================================================
 *
 * ## O defeito que estes casos medem
 *
 * `recebidasSemArquivo` contava TRÊS fatos diferentes até o serviço separá-los
 * (`FiscalClosingService`, função `baldeDaEntrada`): o XML PERDIDO (nota
 * anterior a o sistema guardar o arquivo), a COMPRA SEM NF-e (entrada manual —
 * feira, autônomo, produtor rural — que nunca teve XML) e a ENTRADA ESTORNADA
 * (documento morto). Os três chegam na prévia; a grade mostrava seis KPIs e as
 * duas contagens novas só apareciam no cartão de pendências.
 *
 * O mês de uma loja que compra na feira fica ilegível de relance: a grade diz
 * zero em tudo que é entrada, e a resposta está três cartões abaixo.
 *
 * ## AUSENTE NÃO É ZERO — a distinção que os campos opcionais existem para ter
 *
 * Os dois campos são OPCIONAIS na interface de propósito: um servidor que ainda
 * não separa os baldes não pode fazer a tela escrever `0` onde a resposta é
 * "não sei". Escrever zero ali seria a tela afirmar, com a autoridade de um
 * número, que não houve compra sem nota fiscal neste mês — quando o que houve
 * foi uma pergunta que ninguém respondeu.
 *
 * E há um segundo efeito, que é o que o último caso mede: contra esse servidor
 * antigo o balde "Compras sem XML" ainda é o dos TRÊS fatos, e a frase "o
 * arquivo do fornecedor não foi guardado e não há como recuperá-lo" passa a
 * prometer mais do que o balde contém — ela descreve o XML perdido e cobre
 * também compras que nunca tiveram arquivo nenhum.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - tire os dois tiles da grade e o mês de compras de feira volta a ser
 *     ilegível de relance;
 *   - troque o `—` por `String(contagem ?? 0)` e a tela passa a afirmar "zero
 *     compras sem nota fiscal" onde o servidor não disse nada;
 *   - deixe o hint do "Compras sem XML" fixo e ele mente contra a resposta
 *     antiga, que ainda mistura os três.
 */
describe('as três ausências da compra recebida têm cada uma o seu tile', () => {
  /** O valor de um KPI é o parágrafo logo abaixo do rótulo. */
  function valorDoKpi(rotulo: string): string {
    return screen.getByText(rotulo).nextElementSibling?.textContent ?? '';
  }

  it('com contagem: os dois baldes novos aparecem na grade com o número do servidor', async () => {
    previas['2026-04'] = previaBase({
      contagens: {
        emitidasAutorizadas: 0,
        emitidasCanceladas: 0,
        eventos: 0,
        recebidasComArquivo: 0,
        recebidasSemArquivo: 1,
        recebidasSemNota: 3,
        recebidasEstornadas: 2,
        faixasInutilizadas: 0,
      },
    });
    await montar();

    expect(valorDoKpi('Compras sem NF-e')).toBe('3');
    expect(valorDoKpi('Entradas estornadas')).toBe('2');
    // O balde do XML perdido continua contando SÓ ele.
    expect(valorDoKpi('Compras sem XML')).toBe('1');
  });

  it('um mês feito só de compra de feira NÃO é um mês vazio', async () => {
    /*
      O caso que originou a costura: a grade zerada e três compras no
      cartão de pendências. A frase do mês vazio, se aparecesse, negaria em
      palavras o que a tela lista logo abaixo.
    */
    previas['2026-04'] = previaBase({
      contagens: {
        emitidasAutorizadas: 0,
        emitidasCanceladas: 0,
        eventos: 0,
        recebidasComArquivo: 0,
        recebidasSemArquivo: 0,
        recebidasSemNota: 3,
        recebidasEstornadas: 0,
        faixasInutilizadas: 0,
      },
    });
    await montar();

    expect(valorDoKpi('Compras sem NF-e')).toBe('3');
    expect(screen.queryByText(/não tem nota emitida, evento nem nota de entrada/)).toBeNull();
  });

  it('com zero: o tile mostra 0 e não some — zero é uma resposta', async () => {
    previas['2026-04'] = previaBase({
      contagens: {
        emitidasAutorizadas: 12,
        emitidasCanceladas: 1,
        eventos: 3,
        recebidasComArquivo: 7,
        recebidasSemArquivo: 2,
        recebidasSemNota: 0,
        recebidasEstornadas: 0,
        faixasInutilizadas: 1,
      },
    });
    await montar();

    expect(valorDoKpi('Compras sem NF-e')).toBe('0');
    expect(valorDoKpi('Entradas estornadas')).toBe('0');
    // Com os baldes separados, o hint do XML perdido descreve só ele.
    expect(screen.getByText(/não foi guardado e não há como recuperá-lo/)).toBeTruthy();
  });

  it('SEM os campos: a tela diz que não sabe, e não escreve zero', async () => {
    /*
      `previaBase` não manda os campos novos — é a resposta do servidor que
      ainda não separava, e é ela que a tela tem de sobreviver sem mentir.
    */
    await montar();

    expect(valorDoKpi('Compras sem NF-e')).toBe('—');
    expect(valorDoKpi('Entradas estornadas')).toBe('—');
    // Nada de zero: o número afirmaria o que ninguém respondeu.
    expect(valorDoKpi('Compras sem NF-e')).not.toBe('0');
    expect(valorDoKpi('Entradas estornadas')).not.toBe('0');

    // E o balde antigo se declara misturado, porque contra este servidor ele
    // ainda é o dos três fatos.
    expect(screen.getByText(/ainda é o antigo/)).toBeTruthy();
    expect(screen.queryByText(/não foi guardado e não há como recuperá-lo/)).toBeNull();
  });
});

describe('o download', () => {
  it('busca com o Bearer e entrega o arquivo com o nome do Content-Disposition', async () => {
    /*
      O cabeçalho nomeia o arquivo DIFERENTE da prévia, de propósito.

      Em produção os dois nomes coincidem — saem do mesmo `nomeDoPacote`. Se o
      teste os deixasse iguais, ele passaria com a tela lendo qualquer um dos
      dois, e não provaria nada. A divergência aqui também é um cenário real:
      a prévia é carregada uma vez e o pacote é montado depois, e entre os dois
      alguém pode ter renomeado a operação. Quem nomeia o arquivo é o servidor
      que o montou, com o slug já filtrado contra injeção de cabeçalho.
    */
    respostaDoPacote = () =>
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="pacote-me-mimei-modas-2026-04.zip"',
        },
      });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar o pacote' }));

    await waitFor(() => expect(salvos).toHaveLength(1));
    expect(salvos[0].nome).toBe('pacote-me-mimei-modas-2026-04.zip');

    const doPacote = chamadas.find((c) => c.url.includes('/pacote'));
    // Um `<a href>` para esta rota receberia 401: `authMiddleware` lê o token
    // só do cabeçalho.
    expect(doPacote?.autorizacao).toBe('Bearer token-do-gerente');
  });

  it('o cabeçalho filtrado pelo CORS não deixa o arquivo sem nome', async () => {
    // Sem `exposedHeaders` no servidor é exatamente isto que o navegador faz:
    // o cabeçalho existe na resposta e o JavaScript não o enxerga.
    respostaDoPacote = () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200 });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar o pacote' }));

    await waitFor(() => expect(salvos).toHaveLength(1));
    expect(salvos[0].nome).toBe('pacote-me-mimei-2026-04.zip');
  });

  it('o 413 chega à tela COM o número medido pelo servidor', async () => {
    respostaDoPacote = () =>
      erro(
        'CORE_FISCAL_PACOTE_GRANDE_DEMAIS',
        'O pacote deste mês tem 7312 documentos, acima do teto de 5000.',
        413,
      );
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar o pacote' }));

    // O número é o que diz a quem lê se o caso é dividir o mês ou se há algo
    // errado. "Falha ao baixar" jogaria fora a única informação da resposta.
    expect(await screen.findByText(/7312 documentos/)).toBeTruthy();
    expect(salvos).toHaveLength(0);
  });

  it('período recusado pelo servidor vira a mensagem do servidor, não uma tela em branco', async () => {
    recusaPeriodo = true;
    entrar();
    servidor();
    render(
      <MemoryRouter>
        <FechamentoContadorPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/não é um mês válido/)).toBeTruthy();
  });
});
