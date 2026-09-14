/**
 * ============================================================================
 * A CATEGORIA NA TELA DE CONTAS — no formulário, na linha e no filtro
 * ============================================================================
 *
 * ## O defeito que estes testes existem para impedir
 *
 * É sempre o mesmo, e o projeto já o cometeu três vezes: o campo aparece na
 * tela, a pessoa preenche, e o valor não chega. Na rodada 22 foi uma
 * configuração inteira inerte com 2.348 testes verdes. Na rodada 24 foi a rota
 * de lançamento montando o objeto com seis campos nomeados e descartando
 * `categoryId`, `costCenterId`, `accountId` e `competenceDate` — que o serviço
 * aceitava e gravava.
 *
 * Um formulário assim não dá erro. Ele mostra "Lançamento criado", em verde, e
 * grava nulo. O lançamento vai para o balde "Sem categoria" do DRE, e quem
 * preencheu passa a acreditar que classificou.
 *
 * Por isso TODO teste deste arquivo olha o que sai no FIO — a URL da consulta e
 * o corpo da requisição —, e nenhum se contenta com a mensagem de sucesso. Um
 * teste que dubla o servidor e confere o que ele respondeu fica verde com o fio
 * cortado, porque o dublê responde o que se mandou ele responder.
 *
 * ## O que se cobra aqui
 *
 * 1. A CATEGORIA CHEGA NO POST, e vazio chega como NULO — não como texto
 *    vazio, que o servidor leria como "categoria inexistente" (404) em vez de
 *    "não classificado".
 * 2. A COMPETÊNCIA E A CONTA chegam pelo mesmo caminho — eram os outros dois
 *    campos descartados pela rota.
 * 3. O FILTRO CHEGA NA CONSULTA, inclusive o avesso (`sem-categoria`), que é o
 *    recorte para onde a ressalva do DRE aponta.
 * 4. A LISTA MOSTRA A CATEGORIA de cada linha — sem isso, quem filtrou não tem
 *    como conferir o recorte.
 * 5. A LISTA DE CATEGORIAS VEM DA ROTA QUE A TELA ALCANÇA. A tela é
 *    ROTA_GESTAO e deixa entrar estoquista e atendente;
 *    `/core/finance/categories` está aberta ao escritório inteiro, enquanto
 *    `/core/finance/setup` exige gerente e devolve o saldo de todas as contas
 *    bancárias junto. Buscar o seletor na segunda seria um 403 na cara de quem
 *    a tela deixou entrar — o desencontro que a rodada 23 fechou.
 * 6. QUEM NÃO PODE LANÇAR NÃO VÊ O FORMULÁRIO, e a ausência se explica.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - pare de repassar `categoryId` no `createFinanceEntry` e o primeiro cai;
 *   - mande `''` no lugar de `null` e o segundo cai;
 *   - deixe de passar `categoryId` para `listFinanceEntries` e o quarto cai;
 *   - troque a busca por `financeSetup()` e o teste da rota alcançável cai;
 *   - desenhe o botão "Lançar conta" para todo mundo e o último cai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ContasPage from '../ContasPage';

const CATEGORIAS = [
  { id: 'cat-aluguel', direction: 'out', name: 'Aluguel', parent_id: null, system_code: null, active: 1 },
  { id: 'cat-energia', direction: 'out', name: 'Energia', parent_id: null, system_code: null, active: 1 },
];

const CONTAS = [
  {
    id: 'conta-1',
    name: 'Banco do Brasil',
    kind: 'banco',
    bank_code: '001',
    agency: '1234',
    account_number: '5678',
    opening_balance_cents: 0,
    is_default: 1,
    active: 1,
    balanceCents: 0,
  },
];

/** Uma classificada e uma sem categoria — a linha que o DRE aponta. */
const LANCAMENTOS = [
  {
    id: 'e-1',
    direction: 'out',
    description: 'Aluguel de agosto',
    amountCents: 250000,
    settledCents: 0,
    balanceCents: 250000,
    status: 'open',
    dueDate: '2026-08-10',
    settledAt: null,
    overdue: false,
    counterpartyName: null,
    originType: 'manual',
    categoryId: 'cat-aluguel',
    categoryName: 'Aluguel',
    cancelledAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'e-2',
    description: 'Nota avulsa',
    direction: 'out',
    amountCents: 10000,
    settledCents: 0,
    balanceCents: 10000,
    status: 'open',
    dueDate: '2026-08-20',
    settledAt: null,
    overdue: false,
    counterpartyName: null,
    originType: 'manual',
    categoryId: null,
    categoryName: null,
    cancelledAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
  },
];

const RESUMO = { openCents: 260000, overdueCents: 0, settledCents: 0, count: 2 };

let requisicoes: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

/** As URLs de consulta de lançamentos, em ordem. */
function consultas(): string[] {
  return requisicoes.filter((r) => r.metodo === 'GET' && r.url.includes('/finance/entries?')).map(
    (r) => r.url,
  );
}

function lancamentosCriados(): Record<string, unknown>[] {
  return requisicoes
    .filter((r) => r.metodo === 'POST' && r.url.includes('/finance/entries'))
    .map((r) => r.corpo ?? {});
}

function servidor(opcoes: { categorias?: unknown[]; statusCategorias?: number } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      requisicoes.push({
        url: alvo,
        metodo,
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });

      const responder = (corpo: unknown, status = 200) =>
        new Response(JSON.stringify(corpo), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      /*
        A ORDEM DOS RECORTES IMPORTA: `/finance/categories` e
        `/finance/entries` são rotas parecidas, e casar na ordem errada
        devolveria a lista de uma para a outra.
      */
      if (alvo.includes('/core/finance/categories')) {
        if (opcoes.statusCategorias && opcoes.statusCategorias !== 200) {
          return responder(
            { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } },
            opcoes.statusCategorias,
          );
        }
        return responder({ items: opcoes.categorias ?? CATEGORIAS });
      }
      if (alvo.includes('/core/finance/setup')) {
        return responder({ categories: CATEGORIAS, costCenters: [], accounts: CONTAS });
      }
      if (alvo.includes('/core/finance/entries') && metodo === 'POST') {
        return responder({ ...LANCAMENTOS[0], id: 'e-novo' }, 201);
      }
      if (alvo.includes('/core/finance/entries')) {
        return responder({ items: LANCAMENTOS, summary: RESUMO });
      }
      return responder({ items: [] });
    }),
  );
}

/** A sessão entra pelo app, como nos outros testes de perfil desta pasta. */
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
    'teste de categoria em contas',
  );
}

beforeEach(() => {
  requisicoes = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de categoria em contas');
  localStorage.clear();
});

/** A tela de contas a PAGAR — o lado onde as categorias do dublê vivem. */
function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-pagar']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

const filtroCategoria = () =>
  screen.getByLabelText('Filtrar por categoria') as HTMLSelectElement;

describe('a lista de categorias vem da rota que a tela inteira alcança', () => {
  it('o seletor é servido por /finance/categories, e não por /finance/setup', async () => {
    servidor();
    entrarComo('atendente');
    montar();

    await waitFor(() => expect(filtroCategoria()).toBeTruthy());

    /*
      `/core/finance/setup` exige gerente porque devolve o saldo de todas as
      contas bancárias. Esta tela é ROTA_GESTAO e deixa entrar estoquista e
      atendente — buscar ali o seletor faria a tela abrir com um filtro vazio
      para metade de quem tem direito a ela.
    */
    const categorias = requisicoes.filter((r) => r.url.includes('/core/finance/categories'));
    expect(categorias.length).toBeGreaterThan(0);
    // E vai recortada pelo LADO: categoria de receita não serve para pagar.
    expect(categorias[0].url).toContain('direction=out');
    expect(requisicoes.some((r) => r.url.includes('/core/finance/setup'))).toBe(false);
  });

  it('categoria indisponível não derruba a lista de contas', async () => {
    servidor({ statusCategorias: 403 });
    entrarComo('atendente');
    montar();

    // A cobrança continua acontecendo: uma lista auxiliar que falhou não pode
    // levar junto o trabalho do dia.
    await screen.findByText('Aluguel de agosto');
    expect(screen.queryByLabelText('Filtrar por categoria')).toBeNull();
  });
});

describe('o filtro por categoria CHEGA na consulta', () => {
  it('escolher uma categoria manda o id na URL', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await waitFor(() => expect(filtroCategoria()).toBeTruthy());
    const antes = consultas().length;
    fireEvent.change(filtroCategoria(), { target: { value: 'cat-aluguel' } });

    await waitFor(() => expect(consultas().length).toBeGreaterThan(antes));
    /*
      O DEFEITO QUE ESTA RODADA EXISTE PARA CONSERTAR, na sua forma de tela: o
      parâmetro escrito no seletor e não repassado à consulta. A lista volta
      inteira, e quem filtrou acredita estar olhando o recorte que pediu.
    */
    expect(consultas().at(-1)).toContain('categoryId=cat-aluguel');
  });

  it('"Sem categoria" manda o avesso, e é ele que a ressalva do DRE aponta', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await waitFor(() => expect(filtroCategoria()).toBeTruthy());
    const antes = consultas().length;
    fireEvent.change(filtroCategoria(), { target: { value: 'sem-categoria' } });

    await waitFor(() => expect(consultas().length).toBeGreaterThan(antes));
    // A grafia é a mesma que o servidor entende. Duas grafias devolveriam a
    // lista inteira em silêncio — de novo o filtro que ninguém aplica.
    expect(consultas().at(-1)).toContain('categoryId=sem-categoria');
  });

  it('sem filtro escolhido, nada de categoria vai na URL', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await waitFor(() => expect(consultas().length).toBeGreaterThan(0));
    // Mandar `categoryId=` vazio faria o servidor procurar uma categoria de id
    // vazio, e a lista voltaria vazia sem que ninguém tivesse filtrado nada.
    expect(consultas()[0]).not.toContain('categoryId');
  });
});

describe('a lista mostra a categoria de cada linha', () => {
  it('a classificada mostra o nome; a que não tem aparece marcada', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('Aluguel de agosto');
    /*
      A busca é escopada na TABELA porque "Aluguel" também é uma opção do
      seletor de filtro — e é isso mesmo que se quer: o mesmo nome nos dois
      lugares é o que permite conferir o recorte depois de filtrar.
    */
    const tabela = within(screen.getByRole('table'));
    // Sem a coluna, o filtro acima seria inconferível — e "sem categoria"
    // marcado é o que torna a pendência acionável na própria lista.
    expect(tabela.getByText('Aluguel')).toBeTruthy();
    expect(tabela.getByText('SEM CATEGORIA')).toBeTruthy();
  });
});

describe('o formulário: o que sai no fio', () => {
  async function abrirFormulario() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(screen.getByLabelText('Categoria')).toBeTruthy());
  }

  /*
    Rótulo obrigatório leva um asterisco dentro do `<label>`, então o texto
    acessível é "Descrição *". A expressão é ancorada nas duas pontas porque a
    busca da lista se anuncia como "Descrição ou fornecedor…" — sem a âncora,
    o teste digitaria no campo de busca acreditando estar preenchendo o
    formulário, e o corpo da requisição sairia vazio sem ninguém notar.
  */
  function preencherObrigatorios() {
    fireEvent.change(screen.getByLabelText(/^Descrição\s*\*?$/), {
      target: { value: 'Energia' },
    });
    fireEvent.change(screen.getByLabelText(/^Valor\s*\*?$/), { target: { value: '150,00' } });
  }

  it('a categoria escolhida CHEGA ao servidor', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'cat-energia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(lancamentosCriados()).toHaveLength(1));
    /*
      O CORAÇÃO DESTE ARQUIVO.

      A rota descartava este campo, e o formulário mostrava "Lançamento criado"
      do mesmo jeito. Um teste que olhasse a mensagem de sucesso ficaria verde
      com o valor caindo no chão — só o corpo da requisição denuncia.
    */
    expect(lancamentosCriados()[0].categoryId).toBe('cat-energia');
  });

  it('categoria em branco vai como NULO, e não como texto vazio', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(lancamentosCriados()).toHaveLength(1));
    /*
      `''` é um id que não existe: o servidor procuraria a categoria de id
      vazio e recusaria com 404 "Categoria não encontrada" — para alguém que
      simplesmente não quis classificar. Nulo é a ausência que a coluna aceita.
    */
    expect(lancamentosCriados()[0].categoryId).toBeNull();
    expect(lancamentosCriados()[0].categoryId).not.toBe('');
  });

  it('competência e conta chegam pelo mesmo caminho — eram os outros dois descartados', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.change(screen.getByLabelText('Competência'), { target: { value: '2026-07-31' } });
    await waitFor(() => expect(screen.getByLabelText('Conta')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Conta'), { target: { value: 'conta-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(lancamentosCriados()).toHaveLength(1));
    const corpo = lancamentosCriados()[0];
    // A competência decide em que MÊS o lançamento conta no DRE. Perdê-la no
    // caminho joga a despesa de julho no resultado de agosto, em silêncio.
    expect(corpo.competenceDate).toBe('2026-07-31');
    // A conta move o saldo que aparece em Financeiro › Cadastros.
    expect(corpo.accountId).toBe('conta-1');
  });

  it('competência em branco vai NULA, para o servidor usar a escada dele', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(lancamentosCriados()).toHaveLength(1));
    // Nulo faz o servidor cair para o vencimento e, na falta dele, para a data
    // do lançamento — a escada que impede um lançamento de sumir do relatório
    // por esquecimento. Inventar uma data aqui tiraria essa decisão dele.
    expect(lancamentosCriados()[0].competenceDate).toBeNull();
  });
});

describe('quem lança é quem o servidor deixa lançar', () => {
  for (const perfil of ['gerente_loja', 'gerente_oficina', 'gestor', 'admin_geral']) {
    it(`${perfil} vê o botão de lançar`, async () => {
      servidor();
      entrarComo(perfil);
      montar();

      await screen.findByText('Aluguel de agosto');
      expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeTruthy();
    });
  }

  for (const perfil of ['estoquista', 'atendente']) {
    it(`${perfil} consulta e filtra, mas NÃO vê o formulário`, async () => {
      servidor();
      entrarComo(perfil);
      montar();

      await screen.findByText('Aluguel de agosto');
      /*
        `POST /core/finance/entries` exige gerente. Oferecer o formulário para
        quem vai levar 403 no fim faria a pessoa preencher descrição, valor,
        vencimento, categoria e competência para nada.
      */
      expect(screen.queryByRole('button', { name: 'Lançar conta' })).toBeNull();
      // E a ausência se explica, em vez de virar mistério.
      expect(screen.getByText(/Lançar conta avulsa é do gerente/)).toBeTruthy();
      // O que É dela continua de pé.
      expect(filtroCategoria()).toBeTruthy();
    });
  }
});
