/**
 * A CONVERSÃO DE TIPO CONTADA NA TELA — mercadoria <-> peça de bancada.
 *
 * ## O que estava errado, e por que não bastava consertar o servidor
 *
 * O formulário oferecia "Peça de oficina" e a oficina dona desde sempre, e o
 * PUT descartava os dois em silêncio: 200 OK, nada gravado. No banco real,
 * dezenove produtos, todos revenda, nenhum com oficina.
 *
 * O conserto NÃO foi passar a gravar pelo PUT — isso abriria uma segunda porta
 * de conversão, mais larga e sem rastro. A conversão passou a ter rota própria,
 * e essa rota devolve os EFEITOS: o que saiu da vitrine, o que perdeu o
 * destaque, quanto saldo muda de lado e — a ponta mais cara — se a peça está
 * sem preço de venda.
 *
 * ## Por que os efeitos precisam de teste DE TELA
 *
 * Os `efeitos` existem por um motivo só: alguém LÊ. Se a tela guardasse o
 * resultado e não o exibisse, o servidor continuaria calculando certo e a
 * pessoa continuaria vendo "Produto atualizado." — que é o defeito original com
 * outra roupa: dado com escritor e sem leitor. Um teste de servidor prova o
 * cálculo; só este prova que ele chega aos olhos de quem converte.
 *
 * Cada teste daqui falha se o card de efeitos sumir, se a chamada de conversão
 * parar de acontecer, ou se ela passar a acontecer quando ninguém mudou nada.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProdutoFormPage from '../ProdutoFormPage';

const PRODUTO_ID = 'prod-1';
const BANCADA = 'wk-celulares';

/** O produto como o cadastro o devolve. Mercadoria de revenda, publicada. */
let produto: Record<string, unknown>;
/** O que a rota de conversão responde — cada teste desenha os seus efeitos. */
let respostaDoTipo: Record<string, unknown>;
/** Método + URL de tudo que a tela pediu. É por aqui que se prova a rota. */
let pedidos: string[];

function produtoPadrao(): Record<string, unknown> {
  return {
    id: PRODUTO_ID,
    name: 'Bateria Original iPhone 11',
    internal_code: 'LJ-0009',
    barcode: '7890000000024',
    sku: null,
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 8000,
    price_cents: 15000,
    effective_price_cents: 15000,
    on_sale: false,
    min_stock: 0,
    stock_quantity: 12,
    active: 1,
    publish_online: 1,
    kind: 'retail',
    workshop_id: null,
  };
}

function efeitosPadrao(): Record<string, unknown> {
  return {
    kind: 'part',
    workshopId: BANCADA,
    workshopName: 'Oficina de Celulares',
    efeitos: {
      despublicadoDaLoja: true,
      destaqueRemovido: true,
      saldoQueMudaDeLado: 12,
      reservadoEmAberto: 0,
      vendasAnteriores: 0,
      semPrecoDeVenda: false,
    },
    aviso: 'Saiu da loja online; deixou de ser destaque na vitrine.',
  };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push(`${metodo} ${alvo}`);

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (metodo === 'POST' && alvo.endsWith('/tipo')) return responder(respostaDoTipo);
    if (metodo === 'PUT' && alvo.includes('/core/products/')) return responder(produto);

    if (alvo.includes('/core/workshops')) {
      return responder({
        items: [
          {
            id: BANCADA,
            slug: 'celulares',
            name: 'Oficina de Celulares',
            kind: 'phones',
            // Só bancada com estoque de peça entra no seletor: a conversão
            // recusa as outras (`CORE_WORKSHOP_WITHOUT_PARTS`).
            capabilities: { parts: true, equipment: true, orders: true },
          },
        ],
      });
    }
    if (alvo.includes('/core/taxonomy')) return responder({ categories: [], brands: [] });
    if (alvo.includes('/core/stock')) return responder({ items: [] });
    if (alvo.includes('/barcodes')) return responder({ barcodes: [] });
    if (alvo.includes('/kit')) return responder({ components: [], costCents: 0 });
    if (/\/core\/products\/[^/]+$/.test(alvo)) return responder(produto);

    return responder({});
  });
}

beforeEach(() => {
  pedidos = [];
  produto = produtoPadrao();
  respostaDoTipo = efeitosPadrao();
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function montar() {
  render(
    <MemoryRouter initialEntries={[`/sistema/produtos/${PRODUTO_ID}`]}>
      <Routes>
        <Route path="/sistema/produtos/:id" element={<ProdutoFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
  // O formulário só está pronto quando o produto chegou: agir antes disso
  // dispararia o `setForm` da carga por cima do que o teste digitou.
  await screen.findByDisplayValue('Bateria Original iPhone 11');
}

/**
 * O seletor pela OPÇÃO que só ele tem.
 *
 * A tela tem meia dúzia de `select` (unidade, categoria, origem…) e o rótulo
 * envolve o campo, então o nome acessível arrasta junto a dica inteira. Achar
 * pela opção é o que sobra de estável.
 */
function seletorComOpcao(nomeDaOpcao: string): HTMLSelectElement {
  const opcao = screen.getByRole('option', { name: nomeDaOpcao }) as HTMLOptionElement;
  return opcao.closest('select') as HTMLSelectElement;
}

/** O gesto inteiro: virar peça, escolher a bancada e salvar. */
async function converterEmPeca() {
  fireEvent.change(seletorComOpcao('Peça de oficina'), { target: { value: 'part' } });
  await waitFor(() => expect(screen.getByRole('option', { name: 'Oficina de Celulares' })).toBeTruthy());
  fireEvent.change(seletorComOpcao('Oficina de Celulares'), { target: { value: BANCADA } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
}

describe('os efeitos da conversão aparecem na tela', () => {
  it('a conversão passa pela rota PRÓPRIA, e o card conta o que ela fez', async () => {
    await montar();
    await converterEmPeca();

    // O card, com a bancada no título: "salvo com sucesso" não diria nada do
    // que aconteceu.
    expect(await screen.findByText('Agora é peça de Oficina de Celulares')).toBeTruthy();

    // A PORTA: o PUT grava o resto do cadastro, a conversão vai pela rota que
    // conta os efeitos e grava auditoria. Um PUT que convertesse sozinho seria
    // a segunda porta, mais larga e sem rastro.
    expect(pedidos.some((p) => p.startsWith('PUT') && p.endsWith(`/products/${PRODUTO_ID}`))).toBe(
      true,
    );
    expect(pedidos.some((p) => p.startsWith('POST') && p.endsWith('/tipo'))).toBe(true);
    // E a ORDEM: o PUT antes, a conversão depois. O PUT pode estar ligando
    // "pesável" ou dando PLU, e peça não pode ser nem uma coisa nem outra —
    // convertendo depois, o invariante do servidor decide sobre o estado FINAL.
    const ondePut = pedidos.findIndex((p) => p.startsWith('PUT'));
    const ondeTipo = pedidos.findIndex((p) => p.endsWith('/tipo'));
    expect(ondePut).toBeLessThan(ondeTipo);

    // E cada efeito vira uma frase: são coisas que moram em abas diferentes
    // deste mesmo formulário, e ninguém as veria de outro jeito.
    expect(screen.getByText(/Saiu da vitrine/)).toBeTruthy();
    expect(screen.getByText(/régua de destaques/)).toBeTruthy();
    expect(screen.getByText(/12 em estoque passam a ser contadas na gaveta/)).toBeTruthy();
    // O saldo NÃO é movimento: mudou quem conta, e a frase diz isso.
    expect(screen.getByText(/Nada entrou nem saiu do estoque/)).toBeTruthy();
  });

  /**
   * O AVISO VERMELHO — a ponta mais cara da corrente.
   *
   * Produto criado pela importação de XML nasce com preço zero de propósito ("a
   * nota traz o custo e o sistema não inventa margem"). Como peça, `addPart`
   * RECUSA o lançamento — e quem descobre isso é o mecânico, com o aparelho
   * aberto na bancada, se ninguém avisar aqui.
   *
   * O teste cobra o destaque, e não só a existência da frase: uma linha a mais
   * numa lista de cinco itens iguais é uma linha que ninguém lê.
   */
  it('preço zero vira aviso VERMELHO, e diz que a OS vai recusar', async () => {
    produto = { ...produtoPadrao(), price_cents: 0 };
    respostaDoTipo = {
      ...efeitosPadrao(),
      efeitos: {
        despublicadoDaLoja: false,
        destaqueRemovido: false,
        saldoQueMudaDeLado: 0,
        reservadoEmAberto: 0,
        vendasAnteriores: 0,
        semPrecoDeVenda: true,
      },
      aviso: 'Está sem preço de venda e entraria na ordem de serviço por R$ 0,00.',
    };
    await montar();
    await converterEmPeca();

    const aviso = await screen.findByText(/Sem preço de venda/);
    expect(aviso.textContent).toContain('RECUSADO');
    // Vermelho e em negrito: o destaque é a diferença entre um item de lista e
    // um aviso que faz a pessoa parar.
    expect(aviso.className).toContain('gs-danger');
    expect(aviso.className).toContain('font-semibold');
  });

  /**
   * O NÚMERO QUE PROMETIA DEMAIS.
   *
   * `saldoNaGaveta` (o nome antigo) era o saldo BRUTO, e a frase dizia "12
   * passam a ser contadas na gaveta da bancada". Só que o lançamento na OS cobra
   * o DISPONÍVEL — bruto menos reservado —, então uma peça com pedido da loja em
   * aberto prometia à bancada uma dúzia que o mecânico não conseguiria usar.
   */
  it('o que já está reservado é descontado em palavras, não escondido', async () => {
    respostaDoTipo = {
      ...efeitosPadrao(),
      efeitos: {
        despublicadoDaLoja: true,
        destaqueRemovido: false,
        saldoQueMudaDeLado: 12,
        reservadoEmAberto: 8,
        vendasAnteriores: 0,
        semPrecoDeVenda: false,
      },
    };
    await montar();
    await converterEmPeca();

    const linha = await screen.findByText(/12 em estoque passam a ser contadas na gaveta/);
    const texto = (linha.textContent ?? '').replace(/\s+/g, ' ');
    expect(texto).toContain('8 desse total já está reservada');
    // As TRÊS origens da reserva. Culpar só o pedido online descreveria o
    // estado errado em dois dos três casos.
    expect(texto).toContain('pedido da loja, orçamento ou contrato de locação');
  });

  it('o histórico de vendas é contado, e dito que não some', async () => {
    respostaDoTipo = {
      ...efeitosPadrao(),
      efeitos: {
        despublicadoDaLoja: false,
        destaqueRemovido: false,
        saldoQueMudaDeLado: 0,
        reservadoEmAberto: 0,
        vendasAnteriores: 12,
        semPrecoDeVenda: false,
      },
    };
    await montar();
    await converterEmPeca();

    const linha = await screen.findByText(/12 venda\(s\) de balcão/);
    expect(linha.textContent).toContain('O histórico continua onde está.');
  });

  it('a volta para revenda avisa que NÃO republica', async () => {
    produto = { ...produtoPadrao(), kind: 'part', workshop_id: BANCADA, publish_online: 0 };
    respostaDoTipo = {
      kind: 'retail',
      workshopId: null,
      workshopName: null,
      efeitos: {
        despublicadoDaLoja: false,
        destaqueRemovido: false,
        saldoQueMudaDeLado: 4,
        reservadoEmAberto: 0,
        vendasAnteriores: 0,
        semPrecoDeVenda: false,
      },
      aviso: '4 em estoque voltam a ser contados como mercadoria da loja.',
    };
    await montar();

    fireEvent.change(seletorComOpcao('Mercadoria de venda'), { target: { value: 'retail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Agora é mercadoria de revenda')).toBeTruthy();
    // Republicar por herança poria à venda algo que ninguém revisou desde
    // então: quem publica é quem cuida da loja, num clique deliberado.
    expect(screen.getByText(/Volta ao catálogo despublicado/)).toBeTruthy();
    expect(screen.getByText(/4 em estoque voltam a contar como mercadoria da loja/)).toBeTruthy();
  });
});

describe('a conversão só acontece quando alguém mudou o tipo', () => {
  /**
   * SALVAR SEM MEXER NO TIPO NÃO CONVERTE.
   *
   * O formulário manda o objeto inteiro toda vez. Chamar a rota de conversão a
   * cada Salvar geraria um registro de auditoria dizendo que alguém mudou o
   * tipo — quando ninguém mudou nada —, e o rastro que responde "quem tirou
   * este item da vitrine" viraria ruído.
   */
  it('trocar só o preço de uma peça não chama a rota de conversão', async () => {
    produto = { ...produtoPadrao(), kind: 'part', workshop_id: BANCADA, publish_online: 0 };
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await screen.findByText('Produto atualizado.');
    expect(pedidos.some((p) => p.endsWith('/tipo'))).toBe(false);
    // E nenhum card de efeitos: não houve efeito nenhum a contar.
    expect(screen.queryByText(/Agora é peça de/)).toBeNull();
  });

  /**
   * PEÇA SEM BANCADA É RECUSADA ANTES DE GRAVAR METADE.
   *
   * A recusa é da tela porque ela pode ser dada antes da ida ao servidor — e o
   * PUT já teria gravado o resto do cadastro quando a conversão falhasse.
   */
  it('escolher "peça" sem escolher a oficina não salva nada', async () => {
    await montar();

    fireEvent.change(seletorComOpcao('Peça de oficina'), { target: { value: 'part' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('Peça precisa de uma oficina dona');
    expect(pedidos.some((p) => p.startsWith('PUT'))).toBe(false);
    expect(pedidos.some((p) => p.endsWith('/tipo'))).toBe(false);
  });

  /** O card é dispensável pela pessoa: ele informa, não bloqueia. */
  it('"Entendi" fecha o card de efeitos', async () => {
    await montar();
    await converterEmPeca();
    await screen.findByText('Agora é peça de Oficina de Celulares');

    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }));

    await waitFor(() =>
      expect(screen.queryByText('Agora é peça de Oficina de Celulares')).toBeNull(),
    );
  });
});
