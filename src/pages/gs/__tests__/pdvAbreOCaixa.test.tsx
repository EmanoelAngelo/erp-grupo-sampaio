/**
 * O PDV COMEÇA O DIA ABRINDO O CAIXA — auditoria de entrega.
 *
 * ============================================================================
 * O QUE O DONO PEDIU, E O QUE A TELA FAZIA
 * ============================================================================
 *
 * "Garanta que o PDV, se não tiver aberto, já apareça a tela de abertura de
 * caixa."
 *
 * O que havia: uma faixa amarela dizendo
 *
 *     "Nenhum caixa aberto. A venda será registrada sem movimento de gaveta."
 *
 * com um botão "Abrir caixa (F3)" ao lado. O aviso é honesto e o botão está
 * ali — mas a frase revela o problema maior: **o PDV vendia com o caixa
 * fechado**, e o dinheiro entrava sem gaveta nenhuma. No fim do dia o
 * fechamento não fecha: o operador conta as notas e o sistema não sabe de onde
 * vieram.
 *
 * Três coisas mudam, e a segunda é a que importa:
 *
 *  1. o diálogo de abertura sobe SOZINHO ao entrar sem caixa — o primeiro
 *     gesto do dia é o que a tela pede;
 *  2. a venda com caixa fechado passa a ser RECUSADA no balcão, com a frase
 *     que diz o que fazer. Vender fora da gaveta é criar diferença de caixa
 *     por desenho;
 *  3. a recusa vale só quando o sistema SABE que não há gaveta. Se a consulta
 *     ao caixa falhou, o balcão continua vendendo — travar a loja por uma
 *     piscada de rede seria pior que o problema que a trava resolve.
 *
 * ============================================================================
 * CADA TESTE FICA VERMELHO QUANDO O GUARDA SAI
 * ============================================================================
 *
 *   - tire o `if (!r.session) setShowCaixa(true)` e o operador volta a
 *     descobrir sozinho que o dia não começou;
 *   - tire a trava do `finalize` e a venda volta a sair sem gaveta — o teste
 *     vê o POST /core/sales que não deveria existir;
 *   - troque `caixaConhecido && !cash` por `!cash` e o PDV para de vender
 *     quando a rede pisca;
 *   - devolva uma situação fiscal que a tabela do selo não conhece e o PDV
 *     INTEIRO desaparece da tela. Este defeito foi encontrado por acidente
 *     aqui, montando a tela de verdade.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const SESSAO_KEY = 'gs.session';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** O caixa que a rota devolve — aberto ou nada. */
let caixaAberto: Record<string, unknown> | null;
/** A consulta ao caixa responde? `false` dubla a rede caída. */
let caixaResponde: boolean;
/** Situação que o selo fiscal recebe — inclusive uma que a tabela não conhece. */
let situacaoFiscal: string;
/** Toda venda que chegou ao servidor. Vazio é a prova de que nada saiu. */
let vendas: unknown[];

const PRODUTO = {
  id: 'p-1',
  internal_code: 'PJ-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Fone de ouvido',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1000,
  price_cents: 2500,
  effective_price_cents: 2500,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (u.includes('/core/cash/open') && metodo === 'GET') {
      if (!caixaResponde) return json({ error: 'fora do ar' }, 503);
      /*
        A rota devolve SEMPRE o envelope: a sessão (ou nada) e o teto de
        sangria. Um envelope diferente disto derruba o carregamento no catch —
        e foi exatamente assim que a primeira versão deste teste passou a medir
        a coisa errada, achando "sem caixa" onde havia "não perguntei direito".
      */
      return json({ session: caixaAberto, cashWithdrawalLimitCents: null });
    }
    if (u.includes('/core/cash/open') && metodo === 'POST') {
      caixaAberto = { id: 'sessao-1', opening_cents: 10000, status: 'aberto' };
      return json(caixaAberto, 201);
    }
    if (u.includes('/summary')) {
      // O resumo do turno tem forma própria: sem `byMethod` o diálogo quebra.
      return json({ expectedCents: 5000, byMethod: [], movements: [] });
    }
    if (u.includes('/core/fiscal/pdv-summary')) {
      return json({ situacao: situacaoFiscal, pendencyCount: 0, motivos: [] });
    }
    if (u.includes('/core/products/search')) return json({ items: [PRODUTO] });
    if (u.includes('/core/sales') && metodo === 'POST') {
      vendas.push(init?.body ? JSON.parse(init.body) : {});
      return json({ id: 's-1', number: 1, total_cents: 2500, change_cents: 0 }, 201);
    }
    return json({ items: [] });
  });
}

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

/** Bipa o produto e confere que ele entrou no carrinho. */
async function porNoCarrinho() {
  const busca = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
  fireEvent.change(busca, { target: { value: '7890000001111' } });
  fireEvent.keyDown(busca, { key: 'Enter' });
  await screen.findByText('Fone de ouvido');
}

/** Fecha o diálogo de abertura — o operador que só queria consultar um preço. */
async function fecharAbertura() {
  await screen.findByTestId('caixa-pdv');
  fireEvent.click(screen.getByRole('button', { name: /^fechar$/i }));
  await waitFor(() => expect(screen.queryByTestId('caixa-pdv')).toBeNull());
}

beforeEach(() => {
  caixaAberto = null;
  caixaResponde = true;
  situacaoFiscal = 'READY';
  vendas = [];
  localStorage.setItem(
    SESSAO_KEY,
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ============================================================================

describe('o caixa fechado é a primeira coisa que o PDV resolve', () => {
  it('entrar sem caixa aberto sobe a tela de abertura sozinho', async () => {
    montar();

    /*
      O primeiro gesto do dia é abrir o caixa. Deixar isso escondido atrás de
      um botão numa faixa de aviso é pedir que o operador descubra sozinho o
      que o sistema já sabe — e o preço de não descobrir era vender fora da
      gaveta a manhã inteira.
    */
    expect(await screen.findByTestId('caixa-pdv')).toBeTruthy();
  });

  it('com caixa já aberto, a tela NÃO aparece — o operador cai direto na venda', async () => {
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();

    // Espera o carregamento assentar antes de afirmar a ausência: afirmar
    // "não apareceu" antes de a resposta chegar seria verdade por acidente.
    await waitFor(() => {
      expect(screen.queryByText(/Nenhum caixa aberto/)).toBeNull();
    });
    expect(screen.queryByTestId('caixa-pdv')).toBeNull();
  });

  it('a faixa não promete mais "a venda será registrada" — ela diz o que fazer', async () => {
    montar();
    const aviso = await screen.findByText(/Nenhum caixa aberto/);

    /*
      A frase antiga — "a venda será registrada sem movimento de gaveta" —
      descrevia com honestidade um comportamento que não deveria existir.
    */
    expect(aviso.textContent).not.toMatch(/será registrada/i);
    expect(aviso.textContent).toMatch(/não é possível vender/i);
  });
});

// ============================================================================

describe('vender com o caixa fechado é recusado no balcão', () => {
  it('o Finalizar Rápido não manda venda nenhuma para o servidor', async () => {
    montar();
    await fecharAbertura();

    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    /*
      A prova é a AUSÊNCIA do POST. Uma trava que só mostra mensagem e deixa a
      requisição sair teria a mesma cara na tela e o mesmo estrago no caixa.
    */
    // "Caixa fechado" sozinho também é o status da faixa superior — a mensagem
    // do balcão é a que manda abrir.
    await screen.findByText(/abra o caixa antes de vender/i);
    expect(vendas).toHaveLength(0);
  });

  it('o caminho do pagamento também para — e a tela pede o caixa de volta', async () => {
    montar();
    await fecharAbertura();

    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar \(F10\)/i }));

    // A recusa chega antes de o cliente escolher a forma de pagamento, e a
    // tela de abertura volta — o conserto no mesmo gesto da recusa.
    expect(await screen.findByTestId('caixa-pdv')).toBeTruthy();
    expect(vendas).toHaveLength(0);
  });
});

// ============================================================================

describe('a trava separa "não há caixa" de "não sei"', () => {
  it('consulta fora do ar não para o balcão', async () => {
    caixaResponde = false;
    montar();

    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    /*
      Aqui a venda TEM que sair. `cash` é nulo dos dois jeitos — sem caixa e
      sem resposta —, e tratar os dois iguais fecharia a loja toda vez que a
      rede piscasse. A gaveta fica sem vínculo, que é o que já acontecia antes
      desta rodada, e a faixa diz que não deu para confirmar.
    */
    await waitFor(() => expect(vendas).toHaveLength(1));
    expect(screen.getByText(/Não foi possível confirmar o caixa/i)).toBeTruthy();
  });
});

// ============================================================================

describe('o selo fiscal não apaga o balcão', () => {
  it('situação que a tabela do selo não conhece deixa o PDV de pé', async () => {
    /*
      O selo traduz a situação fiscal por uma tabela de quatro chaves. Uma
      quinta situação vinda do servidor devolvia `undefined`, o componente
      quebrava lendo `.classe`, e o React — sem barreira de erro nenhuma —
      desmontava a ÁRVORE INTEIRA: o caixa ficava com a tela branca no meio do
      atendimento por causa de um aviso informativo.
    */
    situacaoFiscal = 'BLOQUEADO_PELA_SEFAZ';
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();

    expect(await screen.findByText(/FISCAL/)).toBeTruthy();
    // O PDV continua inteiro: a busca do balcão está lá.
    expect(await screen.findByPlaceholderText(/c.digo|barras|produto/i)).toBeTruthy();
  });
});

// ============================================================================

describe('o PDV diz em qual loja o operador está', () => {
  it('o nome da loja é a identidade grande — o grupo é o sobrenome', async () => {
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();

    /*
      Medido na tela real antes desta rodada: "GRUPO SAMPAIO" em 26px e o nome
      da loja em 13px, na segunda faixa, depois do nome do operador. São seis
      empresas com o mesmo letreiro — e quem atende em duas delas descobria
      onde estava pelo canto da tela. Trocar de empresa e ver o mesmo topo é a
      receita da venda lançada na loja errada.
    */
    const loja = await screen.findByTestId('pdv-loja');
    expect(loja.textContent).toBe('Preço Justo');

    const identidade = screen.getByTestId('pdv-identidade');
    const grupo = identidade.firstElementChild as HTMLElement;
    expect(grupo.textContent?.trim()).toBe('GRUPO SAMPAIO');

    // A loja é a linha grande; o grupo é a linha pequena. Sem isto o teste
    // passaria com as duas do mesmo tamanho — que é exatamente o defeito.
    expect(loja.className).toContain('text-[26px]');
    expect(grupo.className).toContain('--gs-text-xs');
  });
});

// ============================================================================

describe('a cor do balcão é a da loja', () => {
  it('o PDV carrega a marca da empresa — os seis não podem ser iguais', async () => {
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();

    /*
      `--gs-header-gradient` já muda por empresa em `tokens.css` — verde para
      preco-justo, rosa para me-mimei, grafite para pj-motors —, mas quem
      escrevia `data-marca` era só a casca da LOJA pública. No balcão os seis
      PDVs saíam idênticos, e o operador que atende em duas empresas não tinha
      nem cor nem nome para se situar.
    */
    const raiz = await screen.findByTestId('pdv-raiz');
    expect(raiz.getAttribute('data-marca')).toBe('preco-justo');
  });
});

// ============================================================================

describe('com o diálogo do caixa aberto, o teclado é dele', () => {
  it('F8 não fecha a venda por trás do modal', async () => {
    // Caixa aberto: a tela entra direto na venda e o carrinho pode ser feito.
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();
    await porNoCarrinho();

    // Agora o operador abre o caixa pelo F3 — para uma sangria, digamos.
    fireEvent.keyDown(window, { key: 'F3' });
    await screen.findByTestId('caixa-pdv');

    /*
      O guarda dos atalhos listava `showPayment || showAuth || showQuotes` e
      esquecia `showCaixa`. Com o diálogo do caixa aberto, F8 finalizava a
      venda por baixo dele — e agora que o diálogo SOBE SOZINHO na entrada,
      esse é o estado mais comum da tela no começo do dia.

      O carrinho está CHEIO de propósito: com ele vazio o teste passaria pela
      recusa de "Carrinho vazio" e não provaria guarda nenhum.
    */
    fireEvent.keyDown(window, { key: 'F8' });
    await new Promise((r) => setTimeout(r, 60));
    expect(vendas).toHaveLength(0);
    expect(screen.getByTestId('caixa-pdv')).toBeTruthy();
  });
});

// ============================================================================

describe('a abertura do caixa termina no balcão, não no modal', () => {
  it('abrir o caixa fecha o diálogo e devolve a tela de venda', async () => {
    montar();
    await screen.findByTestId('caixa-pdv');

    const dialogo = screen.getByTestId('caixa-pdv');
    fireEvent.change(within(dialogo).getByPlaceholderText(/0,00/), { target: { value: '200,00' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /^Abrir caixa$/i }));

    /*
      O diálogo ficava na tela depois de abrir — agora em modo "Caixa aberto",
      com um botão VERMELHO "Fechar caixa" exatamente onde o dedo acabara de
      clicar em "Abrir caixa". O primeiro gesto do dia terminava a um clique de
      desfazer o próprio dia.
    */
    await waitFor(() => expect(screen.queryByTestId('caixa-pdv')).toBeNull());
    expect(screen.queryByText(/Nenhum caixa aberto/)).toBeNull();
  });

  it('fundo de troco com cara de código de barras é recusado', async () => {
    montar();
    await screen.findByTestId('caixa-pdv');

    /*
      O campo de valor fica focado e o leitor de código de barras está ligado
      na mesma máquina: bipar um produto na tela de abertura escrevia
      "7894561230012" no fundo de troco — R$ 7.894.561.230,01. O servidor só
      recusa negativo, e a gaveta nascia com quase oito bilhões de reais.
    */
    const dialogo = screen.getByTestId('caixa-pdv');
    fireEvent.change(within(dialogo).getByPlaceholderText(/0,00/), { target: { value: '7894561230012' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /^Abrir caixa$/i }));

    expect(await screen.findByText(/Fundo de troco acima de/i)).toBeTruthy();
    // E nada foi para o servidor: o caixa continua fechado.
    expect(screen.getByTestId('caixa-pdv')).toBeTruthy();
  });

  it('o diálogo diz de qual loja é o caixa', async () => {
    montar();
    const dialogo = await screen.findByTestId('caixa-pdv');

    /*
      Esta passou a ser a PRIMEIRA tela do dia, e ela pedia dinheiro sem dizer
      de quem era a gaveta. Quem opera duas empresas na mesma máquina digitava
      o fundo de troco no escuro.
    */
    expect(dialogo.textContent).toContain('Preço Justo');
  });
});

// ============================================================================

describe('a gaveta muda por baixo do PDV, e a tela relê', () => {
  it('voltar o foco relê o caixa — o turno fechado em outra máquina aparece aqui', async () => {
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();
    await waitFor(() => expect(screen.queryByText(/Nenhum caixa aberto/)).toBeNull());

    /*
      O caixa é UM POR EMPRESA: o gerente fecha o turno de outra máquina — ou
      de outra aba — e esta tela, que lia a sessão uma vez só na montagem,
      continuava achando a gaveta aberta pelo resto do dia. Toda venda seguinte
      levava um `cashSessionId` de sessão fechada, e a recusa chegava com o
      cliente na frente.
    */
    caixaAberto = null;
    fireEvent.focus(window);

    expect(await screen.findByText(/Nenhum caixa aberto/)).toBeTruthy();
    // Mas a tela de abertura NÃO sobe sozinha aqui: subir um modal por cima de
    // um atendimento em curso, a cada volta de foco, seria pior que o defeito.
    expect(screen.queryByTestId('caixa-pdv')).toBeNull();
  });
});

// ============================================================================

describe('com o caixa aberto ainda dá para chegar na gaveta', () => {
  it('a faixa de identidade vira o caminho para o caixa', async () => {
    caixaAberto = { id: 'sessao-1', opening_cents: 5000, status: 'aberto' };
    montar();

    /*
      Assim que o caixa abre, a faixa com o botão "Abrir caixa (F3)" some — ela
      é `{!cash && ...}`. Depois disso não sobrava NENHUM controle de caixa na
      tela: os seis botões do rodapé são Aguardar, Cancelar, Finalizar Rápido,
      Pré-venda, Cliente e Observações, e "Caixa aberto" era um texto morto. O
      F3 existia, declarado apenas dentro do popup de ajuda — sangria e
      fechamento dependiam de alguém ter lido aquela lista.
    */
    const botao = await screen.findByRole('button', { name: /Caixa aberto/i });
    fireEvent.click(botao);

    expect(await screen.findByTestId('caixa-pdv')).toBeTruthy();
  });
});
