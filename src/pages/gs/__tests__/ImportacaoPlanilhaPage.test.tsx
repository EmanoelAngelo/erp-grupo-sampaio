/**
 * A TELA DA IMPORTAÇÃO DE PLANILHA — a metade que só se prova clicando.
 *
 * ## O que este arquivo cobra, e por que não dá para cobrar no servidor
 *
 * O serviço já tem 38 testes verdes, e nenhum deles alcança o que quebra aqui.
 * O servidor pode contar `semSaldo` com perfeição e a tela não mostrar o
 * número; pode aceitar `PUT .../leitura` e a tela nunca chamar; pode recusar o
 * estoquista com 403 e a tela oferecer o botão assim mesmo. Toda vez que este
 * projeto teve um defeito desse feitio — o roteador de peças inteiro, as 18
 * rotas inalcançáveis — o servidor estava certo e o teste de servidor estava
 * verde.
 *
 * Por isso a rede é dublada e o componente é o de verdade. Cada caso abaixo
 * fica VERMELHO ao se quebrar de propósito exatamente o que ele protege:
 *
 *   - apague o bloco de `semSaldo > 0` e "o PDV RECUSA" some;
 *   - apague o de `semPreco > 0` e "SAI DE GRAÇA" some;
 *   - tire `i.linha` da coluna e o número da planilha desaparece do erro;
 *   - troque o primeiro clique por `void confirmar()` e o POST sai sem ninguém
 *     ler quantas linhas vão para o lixo;
 *   - tire o `onChange` do separador e nenhum PUT sai;
 *   - troque `podeConfirmar` por `true` e o estoquista ganha um botão que o
 *     servidor devolve com 403;
 *   - troque `arrayBuffer()` por `text()` e o byte 0xC7 do Excel brasileiro
 *     chega ao servidor como U+FFFD.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ImportacaoPlanilhaPage from '../ImportacaoPlanilhaPage';

/*
  BURACO DO JSDOM, não do produto.

  `Blob.prototype.arrayBuffer` é padrão e existe em todo navegador desde 2020 —
  é justamente o método que a tela usa para não deixar o `file.text()` destruir
  o acento. O jsdom não o implementa, e sem esta linha o caso do byte 0xC7
  ficaria impossível de escrever: a tela quebraria por ausência do método, e não
  por defeito.

  A ponte é `FileReader.readAsArrayBuffer`, que o jsdom implementa e que devolve
  os bytes tal como entraram. O shim não decide nada que o teste esteja
  medindo — ele só devolve ao ambiente uma capacidade que o alvo real tem.
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
  metodo: string;
  url: string;
  corpo: Record<string, unknown> | null;
}

/** O resumo como o servidor o devolve. Cada caso altera só o que lhe importa. */
function resumoBase(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: 'lote-1',
    nomeArquivo: 'catalogo.csv',
    encoding: 'windows-1252',
    separador: ';',
    cabecalho: ['nome', 'ean', 'preco', 'preco', 'qtd'],
    mapa: { nome: 0, codigo_barras: 1, preco: 2, quantidade: 4 },
    status: 'conferencia',
    totalLinhas: 200,
    novos: 197,
    existentes: 0,
    comSaldo: 197,
    semSaldo: 0,
    semPreco: 0,
    erros: 0,
    jaImportado: null,
    ...sobrescreve,
  };
}

function item(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: `i-${String(sobrescreve.linha ?? 2)}`,
    linha: 2,
    nome: 'PARAFUSO SEXTAVADO',
    codigoBarras: '7891234567895',
    codigoInterno: null,
    unidade: 'UN',
    precoCents: 1290,
    custoCents: 700,
    quantidade: 10,
    produtoId: null,
    acao: 'novo',
    erroCodigo: null,
    erroDetalhe: null,
    ...sobrescreve,
  };
}

let chamadas: Chamada[];
let resumo: ReturnType<typeof resumoBase>;
let itens: ReturnType<typeof item>[];
let totalDeItens: number;
/** O historico que a lista mostra. Cada caso que precisa dele o preenche. */
let lotesDoServidor: Record<string, unknown>[];

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Servidor de mentira que REGISTRA tudo.
 *
 * O registro é o que permite provar chamada que não aconteceu — "o primeiro
 * clique não confirma" só é uma afirmação verificável se houver como olhar a
 * lista de requisições e não achar o POST.
 */
function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ metodo, url: u, corpo });

      if (u.includes('/itens')) return json({ itens, total: totalDeItens });
      if (u.includes('/leitura')) return json(resumo);
      if (u.includes('/confirmar')) {
        return json({ criados: 197, comSaldo: 197, ignorados: 3, unidadesEntradas: 1970 });
      }
      if (metodo === 'DELETE') return new Response(null, { status: 204 });
      if (metodo === 'POST') return json(resumo, 201);
      return json({ items: lotesDoServidor });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste de importação de planilha',
  );
}

/**
 * Sobe um arquivo e espera a conferência aparecer.
 *
 * Passa pelo caminho de verdade (input de arquivo) porque é ele que converte
 * os bytes — atalhar por estado interno deixaria o caso do encoding sem prova.
 */
async function subirPlanilha(bytes = new Uint8Array([0x6e, 0x6f, 0x6d, 0x65])) {
  const entrada = screen.getByLabelText('Arquivo da planilha') as HTMLInputElement;
  const arquivo = new File([bytes], 'catalogo.csv', { type: 'text/csv' });
  fireEvent.change(entrada, { target: { files: [arquivo] } });
  await screen.findByText('O que esta planilha vai criar');
  /*
    Esperar as LINHAS, e não só o resumo.

    O resumo chega no POST e a tela já se desenha; os itens vêm de uma segunda
    requisição. Sem esta espera, todo caso que olha a tabela ou a paginação
    mediria o estado intermediário — que foi exatamente o que apareceu aqui na
    primeira execução, com "0 linha(s)" no lugar de 250.
  */
  const paginas = Math.max(1, Math.ceil(totalDeItens / 100));
  await screen.findByText(`${totalDeItens} linha(s) · página 1 de ${paginas}`);
}

async function montar(profileCode = 'gerente_loja') {
  entrarComo(profileCode);
  servidor();
  render(
    <MemoryRouter>
      <ImportacaoPlanilhaPage />
    </MemoryRouter>,
  );
  await subirPlanilha();
}

beforeEach(() => {
  chamadas = [];
  resumo = resumoBase();
  itens = [item()];
  totalDeItens = 1;
  lotesDoServidor = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de importação de planilha');
  localStorage.clear();
});

describe('o arquivo sobe como bytes', () => {
  it('o byte 0xC7 do Excel brasileiro chega inteiro ao servidor', async () => {
    entrarComo('gerente_loja');
    servidor();
    render(
      <MemoryRouter>
        <ImportacaoPlanilhaPage />
      </MemoryRouter>,
    );

    // "AÇO" em windows-1252: o Ç é o byte 0xC7 sozinho, que NÃO é UTF-8 válido.
    // `file.text()` o trocaria por U+FFFD aqui dentro, antes de qualquer
    // requisição, e o servidor jamais saberia que houve perda.
    await subirPlanilha(new Uint8Array([0x41, 0xc7, 0x4f]));

    const envio = chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/import/produtos'));
    expect(envio).toBeTruthy();
    const bytes = atob(String(envio!.corpo!.arquivo));
    expect([...bytes].map((c) => c.charCodeAt(0))).toEqual([0x41, 0xc7, 0x4f]);
    expect(envio!.corpo!.nomeArquivo).toBe('catalogo.csv');
  });
});

describe('o aviso de SEM SALDO', () => {
  it('aparece por extenso quando há produto sem saldo', async () => {
    resumo = resumoBase({ semSaldo: 42, comSaldo: 155 });
    await montar();

    // O número sozinho não ensina nada: o que a pessoa precisa ler é que o
    // caixa vai barrar a venda com o cliente na frente.
    const aviso = await screen.findByText(/42 produto\(s\) entram com estoque zero/);
    expect(aviso.parentElement!.textContent).toMatch(/O PDV RECUSA a venda de produto sem saldo/);
  });

  it('some quando nenhum produto entra sem saldo', async () => {
    resumo = resumoBase({ semSaldo: 0 });
    await montar();

    expect(screen.queryByText(/entram com estoque zero/)).toBeNull();
    expect(screen.queryByText(/O PDV RECUSA/)).toBeNull();
    // A contagem continua no rodapé — o que sai é o aviso, não o número.
    expect(screen.getByText('SEM SALDO: 0')).toBeTruthy();
  });
});

describe('o aviso de SEM PREÇO', () => {
  it('diz que o produto sai de graça no caixa', async () => {
    resumo = resumoBase({ semPreco: 7 });
    await montar();

    const aviso = await screen.findByText(/7 produto\(s\) entram com preço R\$ 0,00/);
    expect(aviso.parentElement!.textContent).toMatch(/SAI DE GRAÇA no caixa/);
  });

  it('some quando todo produto tem preço', async () => {
    resumo = resumoBase({ semPreco: 0 });
    await montar();

    expect(screen.queryByText(/SAI DE GRAÇA/)).toBeNull();
    expect(screen.getByText('SEM PREÇO: 0')).toBeTruthy();
  });
});

describe('as linhas com erro', () => {
  it('trazem o número da linha e o texto do erro', async () => {
    resumo = resumoBase({ erros: 1, novos: 196 });
    itens = [
      item({
        id: 'i-187',
        linha: 187,
        nome: null,
        acao: 'erro',
        erroCodigo: 'NOME_VAZIO',
        erroDetalhe: 'A linha não tem nome de produto.',
      }),
      item(),
    ];
    totalDeItens = 2;
    await montar();

    // Sem o número, "A linha não tem nome" não diz ONDE consertar — e a
    // planilha está aberta ao lado, com 200 linhas.
    const linha = (await screen.findByText('187')).closest('tr');
    expect(linha).toBeTruthy();
    expect(linha!.textContent).toMatch(/A linha não tem nome de produto\./);
  });
});

describe('o segundo clique', () => {
  it('com erros, o primeiro clique NÃO confirma: pede confirmação com os números', async () => {
    resumo = resumoBase({ erros: 3, novos: 197, totalLinhas: 200 });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Criar os produtos e o saldo' }));

    // O que a pessoa lê antes do clique que vale: quantas entram e quantas
    // vão para o lixo.
    await screen.findByRole('button', { name: 'Sim: importar as 197 e descartar as 3' });
    expect(chamadas.some((c) => c.url.includes('/confirmar'))).toBe(false);
  });

  it('o segundo clique confirma de verdade', async () => {
    resumo = resumoBase({ erros: 3, novos: 197, totalLinhas: 200 });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Criar os produtos e o saldo' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sim: importar as 197 e descartar as 3' }),
    );

    await waitFor(() =>
      expect(
        chamadas.filter((c) => c.metodo === 'POST' && c.url.includes('/confirmar')),
      ).toHaveLength(1),
    );
  });

  it('sem erro nenhum, um clique só basta', async () => {
    resumo = resumoBase({ erros: 0 });
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Criar os produtos e o saldo' }));

    // Pedir confirmação para tudo ensina a clicar duas vezes sem ler.
    await waitFor(() =>
      expect(
        chamadas.filter((c) => c.metodo === 'POST' && c.url.includes('/confirmar')),
      ).toHaveLength(1),
    );
  });
});

describe('o aviso de reimportação', () => {
  it('diz a data, o que a importação anterior criou, e exige segundo clique', async () => {
    resumo = resumoBase({
      erros: 0,
      jaImportado: {
        id: 'lote-0',
        confirmadoEm: '2026-07-14T10:00:00.000Z',
        criados: 197,
        comSaldo: 197,
      },
    });
    await montar();

    const aviso = await screen.findByText(/Este arquivo já foi importado em 14\/07\/2026/);
    expect(aviso.parentElement!.textContent).toMatch(/cria produtos DUPLICADOS e SOMA o estoque/);

    // Mesmo sem erro nenhum, aqui o clique único seria o erro mais caro da
    // tela: catálogo em dobro e saldo somado por cima.
    fireEvent.click(screen.getByRole('button', { name: 'Criar os produtos e o saldo' }));
    await screen.findByRole('button', { name: /Sim: importar de novo as 200 linhas/ });
    expect(chamadas.some((c) => c.url.includes('/confirmar'))).toBe(false);
  });
});

describe('a leitura é editável', () => {
  it('trocar o separador dispara PUT .../leitura', async () => {
    await montar();

    fireEvent.change(screen.getByLabelText('Separador de colunas'), { target: { value: ',' } });

    await waitFor(() => {
      const put = chamadas.find((c) => c.metodo === 'PUT' && c.url.includes('/leitura'));
      expect(put).toBeTruthy();
      expect(put!.corpo!.separador).toBe(',');
      // O mapa NÃO vai junto: as colunas passam a ser outras, e reaproveitar
      // índices do arquivo lido errado apontaria "preço" para uma coluna de
      // nome.
      expect(put!.corpo!.mapa).toBeUndefined();
    });
  });

  it('trocar a codificação dispara PUT .../leitura', async () => {
    await montar();

    fireEvent.change(screen.getByLabelText('Codificação do arquivo'), {
      target: { value: 'utf-8' },
    });

    await waitFor(() => {
      const put = chamadas.find((c) => c.metodo === 'PUT' && c.url.includes('/leitura'));
      expect(put).toBeTruthy();
      expect(put!.corpo!.encoding).toBe('utf-8');
    });
  });

  it('o mapa é por ÍNDICE, e cabeçalho repetido continua distinguível', async () => {
    await montar();

    // O arquivo tem "preco" nas colunas 3 e 4 (índices 2 e 3). Por nome as
    // duas opções seriam idênticas; por índice, a pessoa consegue dizer qual
    // é a de custo.
    const custo = screen.getByLabelText('Custo') as HTMLSelectElement;
    expect([...custo.options].map((o) => o.textContent)).toEqual([
      '— não usar —',
      'coluna 1 — nome',
      'coluna 2 — ean',
      'coluna 3 — preco',
      'coluna 4 — preco',
      'coluna 5 — qtd',
    ]);

    fireEvent.change(custo, { target: { value: '3' } });

    await waitFor(() => {
      const put = chamadas.find((c) => c.metodo === 'PUT' && c.url.includes('/leitura'));
      expect(put).toBeTruthy();
      expect(put!.corpo!.mapa).toMatchObject({ custo: 3, nome: 0, preco: 2 });
    });
  });
});

describe('quem confirma', () => {
  it('o estoquista NÃO ganha o botão de confirmar', async () => {
    resumo = resumoBase({ erros: 0 });
    await montar('estoquista');

    // O servidor recusa `confirmar` para ele com 403. Oferecer o clique seria
    // a porta que bate na cara.
    expect(screen.queryByRole('button', { name: 'Criar os produtos e o saldo' })).toBeNull();
    expect(screen.getByText(/Criar o catálogo é decisão da gerência/)).toBeTruthy();
    // O que ele PODE fazer continua ali: conferir, corrigir e descartar.
    expect(screen.getByRole('button', { name: 'Descartar rascunho' })).toBeTruthy();
  });

  it('o gerente da loja ganha', async () => {
    resumo = resumoBase({ erros: 0 });
    await montar('gerente_loja');

    // Sem este caso, o de cima ficaria verde com o botão sumido para todo
    // mundo — inclusive para quem o servidor atende.
    expect(screen.getByRole('button', { name: 'Criar os produtos e o saldo' })).toBeTruthy();
    expect(screen.queryByText(/decisão da gerência/)).toBeNull();
  });
});

describe('paginação', () => {
  it('a primeira busca pede 100 linhas e a tela diz o total', async () => {
    totalDeItens = 250;
    await montar();

    const busca = chamadas.find((c) => c.url.includes('/itens'));
    expect(busca!.url).toMatch(/limit=100/);
    expect(busca!.url).toMatch(/offset=0/);
    // 5000 linhas no DOM travam a tela em que a pessoa mais precisa enxergar.
    expect(screen.getByText('250 linha(s) · página 1 de 3')).toBeTruthy();
  });

  it('"Próxima" busca o bloco seguinte no servidor', async () => {
    totalDeItens = 250;
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));

    await waitFor(() =>
      expect(chamadas.some((c) => c.url.includes('/itens') && c.url.includes('offset=100'))).toBe(
        true,
      ),
    );
  });
});

/*
  NULO, ZERO E "NÃO FOI LIDO" SÃO TRÊS COISAS, E A TELA MOSTRAVA UMA.

  Achado conferindo a tela no navegador, com a suíte verde: a primeira versão
  imprimia "R$ 0,00" e "0" para tudo que não fosse número positivo.

  O caso que denuncia é a linha SEM NOME. A leitura para no primeiro problema,
  então ela sai do servidor com `precoCents: null` mesmo tendo `10,00` escrito
  na célula — e a tela afirmava "R$ 0,00", que é um valor que a planilha não
  diz, logo abaixo do aviso que ensina a desconfiar exatamente desse número.

  E, nas linhas boas, juntava "a planilha não disse" com "a planilha disse que
  não tem" — a distinção em que a rodada inteira se apoia, e a mesma que
  `core_inbound_note_items.received_quantity` faz do outro lado.
*/
describe('nulo, zero e não-lido são três estados distintos na tabela', () => {
  it('linha com erro não mostra preço nem quantidade — o campo não chegou a ser lido', async () => {
    itens = [
      item({
        linha: 6,
        acao: 'erro',
        nome: null,
        codigoBarras: null,
        precoCents: null,
        custoCents: null,
        quantidade: null,
        erroCodigo: 'CORE_IMPORT_SEM_NOME',
        erroDetalhe: 'Linha sem nome de produto.',
      }),
    ];
    totalDeItens = 1;
    resumo = resumoBase({ novos: 0, comSaldo: 0, erros: 1, totalLinhas: 1 });
    await montar();

    /*
      A PRIMEIRA VERSÃO DESTE TESTE PASSAVA SEM O GUARDA, e por isso está
      escrito assim.

      Ele só checava a ausência de "R$ 0,00". Sem o guarda de linha-com-erro a
      célula cai no ramo do nulo e imprime "sem preço" — o "R$ 0,00" continua
      ausente, e o teste ficava verde certificando um comportamento errado.

      O que se cobra agora é a célula que TEM de aparecer. E "sem preço" numa
      linha de erro é errado por dois motivos: o campo não chegou a ser lido
      (a leitura para no primeiro problema), e a linha nem vai ser importada,
      então ela não é uma das que o rodapé conta como sem preço.
    */
    const linha = screen.getByText('Linha sem nome de produto.').closest('tr');
    expect(linha).toBeTruthy();

    expect(linha!.textContent).not.toMatch(/R\$ 0,00/);
    expect(linha!.textContent).not.toMatch(/sem preço/);
    expect(linha!.textContent).not.toMatch(/sem saldo/);
    // Traço nas três colunas de número: preço, custo e quantidade.
    expect((linha!.textContent!.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('linha boa SEM a coluna preenchida diz "sem preço", e não R$ 0,00', async () => {
    itens = [item({ linha: 3, precoCents: null, quantidade: 5 })];
    totalDeItens = 1;
    resumo = resumoBase({ novos: 1, comSaldo: 1, semPreco: 1, erros: 0, totalLinhas: 1 });
    await montar();

    expect(screen.getByText('sem preço')).toBeTruthy();
    expect(screen.queryByText('R$ 0,00')).toBeNull();
  });

  it('preço ZERO de verdade aparece como R$ 0,00 — quem escreveu zero conferiu', async () => {
    itens = [item({ linha: 3, precoCents: 0, quantidade: 5 })];
    totalDeItens = 1;
    resumo = resumoBase({ novos: 1, comSaldo: 1, semPreco: 1, erros: 0, totalLinhas: 1 });
    await montar();

    expect(screen.getByText('R$ 0,00')).toBeTruthy();
    expect(screen.queryByText('sem preço')).toBeNull();
  });

  it('quantidade ausente diz "sem saldo"; quantidade zero mostra 0', async () => {
    itens = [
      item({ linha: 3, id: 'i-3', quantidade: null }),
      item({ linha: 4, id: 'i-4', quantidade: 0 }),
    ];
    totalDeItens = 2;
    resumo = resumoBase({ novos: 2, comSaldo: 0, semSaldo: 2, erros: 0, totalLinhas: 2 });
    await montar();

    /*
      Duas células diferentes para dois fatos diferentes: quem deixou vazio
      esqueceu, quem escreveu zero contou.

      A busca é DENTRO DA LINHA, e não pela tela toda: "0" aparece no rodapé
      ("0 já existe(m)", "ERROS: 0") e um `getByText('0')` solto acharia vários
      — passando ou falhando pelo motivo errado, conforme o rodapé mudasse.
    */
    const linhaSemSaldo = screen.getByText('sem saldo').closest('tr');
    expect(linhaSemSaldo?.textContent).toMatch(/^3/);

    const linhaComZero = screen.getAllByRole('row').find((tr) => /^4/.test(tr.textContent ?? ''));
    expect(linhaComZero).toBeTruthy();
    expect(linhaComZero!.textContent).not.toMatch(/sem saldo/);
  });
});

/*
  DOIS DEFEITOS ACHADOS NA REVISÃO ADVERSARIAL DA TELA, com a suíte verde.
  Cada caso abaixo estava vermelho antes do conserto.
*/
describe('o filtro "só os erros" não sobrevive à releitura', () => {
  it('corrigir a leitura desliga o filtro — senão a tabela fica vazia e mente', async () => {
    resumo = resumoBase({ erros: 1, novos: 1, totalLinhas: 2 });
    itens = [
      item({ id: 'i-9', linha: 9, acao: 'erro', erroDetalhe: 'Linha sem nome de produto.' }),
      item(),
    ];
    totalDeItens = 2;
    await montar();

    fireEvent.click(screen.getByRole('button', { name: /Ver só o|Ver só os/ }));
    await waitFor(() => {
      expect(chamadas.some((c) => c.url.includes('apenasErros=1'))).toBe(true);
    });

    /*
      A pessoa descobre que a causa era o mapa e corrige o separador. O servidor
      devolve zero erros — e o botão que DESLIGA o filtro é desenhado só quando
      há erros, então ele some. Sem `setApenasErros(false)` na releitura o
      filtro ficava ligado sem controle nenhum para voltar: a tabela esvaziava e
      a tela dizia que a planilha não tinha linha depois do cabeçalho, sobre um
      arquivo cheio de linhas boas.
    */
    resumo = resumoBase({ erros: 0, novos: 2, totalLinhas: 2, separador: ',' });
    chamadas = [];
    fireEvent.change(screen.getByLabelText('Separador de colunas'), { target: { value: ',' } });

    await waitFor(() => {
      expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true);
    });
    await waitFor(() => {
      const buscas = chamadas.filter((c) => c.metodo === 'GET' && c.url.includes('/itens'));
      expect(buscas.length).toBeGreaterThan(0);
      // Nenhuma busca DEPOIS da releitura pode continuar pedindo só os erros.
      expect(buscas.every((c) => !c.url.includes('apenasErros=1'))).toBe(true);
    });
  });
});

/*
  "JÁ EXISTE" LÊ COMO "VAI SER PULADO" — e não é: a quantidade da linha SOMA no
  estoque do produto que já está lá.

  O caso que morde é o mais comum: importa, vê três erros, corrige as três
  células no Excel, sobe de novo. As 197 linhas boas agora casam com os produtos
  da primeira importação e somam saldo outra vez. O bloco vermelho de
  reimportação não pega isso, porque ele compara o arquivo byte a byte — e o
  arquivo mudou, foi corrigido.
*/
describe('produto que já existe tem a consequência escrita', () => {
  it('avisa que a quantidade SOMA no estoque atual', async () => {
    resumo = resumoBase({ novos: 3, existentes: 197, comSaldo: 200 });
    await montar();

    const aviso = screen.getByText(/197 linha\(s\) casaram com produto que JÁ EXISTE/);
    expect(aviso).toBeTruthy();
    expect(aviso.parentElement!.textContent).toMatch(/SOMA no estoque atual/);
    expect(aviso.parentElement!.textContent).toMatch(/duas vezes/);
  });

  it('some quando nenhuma linha casa com produto existente', async () => {
    resumo = resumoBase({ novos: 200, existentes: 0 });
    await montar();
    expect(screen.queryByText(/casaram com produto que JÁ EXISTE/)).toBeNull();
  });
});

/*
  O RASCUNHO DE OUTRO ARQUIVO FICAVA PRESO NA LISTA.

  O subtítulo prometia que reenviar substitui o rascunho — e isso vale só para
  o arquivo IDÊNTICO, porque o servidor compara o conteúdo byte a byte. O caso
  comum é o outro: a pessoa vê o erro, corrige a planilha e sobe a versão nova.
  O rascunho velho não é substituído e ficava lá para sempre, sem nenhuma ação.

  A rota de descarte já existia e já aceitava o estoquista. Faltava o botão.
*/
describe('descartar rascunho direto da lista', () => {
  it('o rascunho tem botão; a importação confirmada não', async () => {
    lotesDoServidor = [
      { id: 'l-1', filename: 'catalogo-v1.csv', status: 'conferencia', created_at: '2026-08-10T10:00:00.000Z', confirmed_at: null, created_products: null, moved_products: null, skipped_rows: null },
      { id: 'l-2', filename: 'catalogo-v0.csv', status: 'confirmado', created_at: '2026-08-01T10:00:00.000Z', confirmed_at: '2026-08-01T11:00:00.000Z', created_products: 187, moved_products: 187, skipped_rows: 3 },
    ];
    await montar();

    const linhaRascunho = screen.getByText('catalogo-v1.csv').closest('tr');
    const linhaConfirmada = screen.getByText('catalogo-v0.csv').closest('tr');

    expect(linhaRascunho!.querySelector('button')).toBeTruthy();
    // Confirmada já virou estoque: não há rascunho a descartar.
    expect(linhaConfirmada!.querySelector('button')).toBeNull();
  });

  it('clicar manda o DELETE do lote daquela linha, e não do que está aberto', async () => {
    lotesDoServidor = [
      { id: 'l-antigo', filename: 'catalogo-v1.csv', status: 'conferencia', created_at: '2026-08-10T10:00:00.000Z', confirmed_at: null, created_products: null, moved_products: null, skipped_rows: null },
    ];
    await montar();
    chamadas = [];

    const linha = screen.getByText('catalogo-v1.csv').closest('tr');
    fireEvent.click(linha!.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      const del = chamadas.find((c) => c.metodo === 'DELETE');
      expect(del).toBeTruthy();
      // O lote da LINHA, não o `lote-1` que está aberto na conferência.
      expect(del!.url).toContain('/core/import/produtos/l-antigo');
    });
  });
});
