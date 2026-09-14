/**
 * A PEÇA DE BANCADA NO BALCÃO.
 *
 * O DEFEITO QUE ORIGINOU ISTO
 *
 * A rodada decidiu, com razão, que bipar o código de barras de uma peça tem de
 * ACHAR o produto: responder "não encontrado" para um item que está na gaveta
 * empurra o operador a cadastrar de novo, e aí o mesmo item passa a ter dois
 * cadastros com o saldo rachado entre eles.
 *
 * Só que o servidor passou a devolver `kind` e `workshop_name` e NINGUÉM lia
 * nenhum dos dois. O efeito prático não era cosmético: o casamento EXATO de
 * código de barras entrava direto no carrinho e a venda de balcão concluía — a
 * gaveta da bancada esvaziava sem ninguém ver, e nem uma linha da tela dizia
 * que aquilo era peça.
 *
 * O QUE ESTE ARQUIVO COBRA, E POR QUE ASSIM
 *
 * Renderiza o PDV DE VERDADE, com a rede dublada. Um teste que exercitasse só
 * `destinoDaBusca` provaria que a função decide certo e continuaria verde com
 * a tela ignorando a decisão — que é exatamente a forma do defeito original:
 * o dado existia, ninguém lia.
 *
 * Cada teste daqui falha quando o guarda sai:
 *
 *   - tire o ramo `perguntar` de `destinoDaBusca` (devolva 'carrinho' para
 *     peça) e a peça bipada volta a cair no carrinho sozinha;
 *   - tire `distintivoDePeca` da lista ou da linha do carrinho e a peça volta a
 *     ser indistinguível de mercadoria;
 *   - tire `includeParts` da chamada e o interruptor vira enfeite.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

/** A gaveta aberta do turno — sem ela o PDV recusa a venda. */
const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

/** A peça: `kind: 'part'` e a bancada com NOME, como a busca a devolve. */
const PECA = {
  id: 'p-bat',
  internal_code: 'PC-0001',
  sku: null,
  barcode: '7890000000024',
  name: 'Bateria Original iPhone 11',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 8000,
  price_cents: 15000,
  effective_price_cents: 15000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 4,
  active: 1,
  kind: 'part',
  workshop_name: 'Oficina de Celulares',
};

/** A mercadoria: mesmo formato, `kind: 'retail'` e sem bancada. */
const MERCADORIA = {
  ...PECA,
  id: 'p-cabo',
  internal_code: 'LJ-0002',
  barcode: '7890000000017',
  name: 'Cabo USB-C 1m',
  price_cents: 3900,
  effective_price_cents: 3900,
  kind: 'retail',
  workshop_name: null,
};

/** Toda URL que a busca recebeu — é por ela que se prova o `includeParts`. */
let buscas: string[] = [];

/**
 * O servidor dublado.
 *
 * A busca responde pelo que casa com `q`, respeitando `includeParts` do jeito
 * que o servidor de verdade faz: por CÓDIGO a peça vem sempre; por NOME, só
 * com o interruptor ligado. Dublar a metade errada aqui faria o teste passar
 * com a tela chamando a rota errada.
 */
function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    let corpo: unknown = {};

    if (alvo.includes('/core/products/search')) {
      buscas.push(alvo);
      const params = new URLSearchParams(alvo.split('?')[1] ?? '');
      const q = params.get('q') ?? '';
      const comPecas = params.get('includeParts') === '1';
      const todos = [MERCADORIA, PECA];
      const itens = todos.filter((p) => {
        const porCodigo = p.barcode === q || p.internal_code === q;
        if (porCodigo) return true;
        const porNome = p.name.toLowerCase().includes(q.toLowerCase());
        return porNome && (comPecas || p.kind !== 'part');
      });
      corpo = { items: itens };
    } else if (alvo.includes('/core/cash/open')) {
      /*
        O BALCÃO VENDE COM A GAVETA ABERTA — e o dublê tem que refletir isso.

        Estes testes dublavam `session: null`, e o PDV faturava assim mesmo:
        o dinheiro entrava sem gaveta e o fechamento do dia não tinha como
        bater. Agora a venda com caixa fechado é recusada no balcão, e um
        dublê sem sessão testaria uma loja que não existe.
      */
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/team')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/units/search')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      // O selo fiscal da faixa superior monta junto com a tela. Uma resposta
      // vazia aqui derruba o PDV inteiro antes de a busca acontecer.
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }

    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  buscas = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** O selo fiscal da faixa superior usa `useNavigate`: sem Router, nem monta. */
function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

/** Digita no campo de busca e aperta Enter — o gesto do leitor de código. */
async function bipar(codigo: string) {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() => expect(buscas.length).toBeGreaterThan(0));
}

/** As linhas do carrinho, que é o que a venda leva. */
function carrinho(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^Remover / });
}

describe('bipar uma PEÇA não enche o carrinho sozinho', () => {
  it('para, pergunta e diz de que bancada é', async () => {
    montar();
    await bipar('7890000000024');

    const pergunta = await screen.findByRole('alertdialog');
    // A bancada pelo NOME: é com ele que o operador vai perguntar a alguém.
    expect(pergunta.textContent).toContain('Oficina de Celulares');
    expect(pergunta.textContent).toContain('Bateria Original iPhone 11');

    // E o carrinho continua vazio: era isto que a venda silenciosa fazia.
    expect(carrinho()).toHaveLength(0);
    expect(screen.getByText('Não há nenhum produto vendido.')).toBeTruthy();
  });

  it('VENDER continua permitido — recusar empurraria o cadastro duplicado', async () => {
    montar();
    await bipar('7890000000024');

    fireEvent.click(await screen.findByRole('button', { name: 'Vender assim mesmo' }));

    await waitFor(() => expect(carrinho()).toHaveLength(1));
    // E a linha do carrinho continua dizendo o que é, até a hora de fechar.
    expect(screen.getAllByText('Peça · Oficina de Celulares').length).toBeGreaterThan(0);
  });

  it('cancelar não deixa nada para trás', async () => {
    montar();
    await bipar('7890000000024');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(carrinho()).toHaveLength(0);
  });
});

describe('a mercadoria de revenda não paga pelo guarda da peça', () => {
  it('bipar mercadoria continua entrando direto no carrinho', async () => {
    montar();
    await bipar('7890000000017');

    // Sem pergunta: é o gesto mais repetido do balcão, e uma confirmação a
    // cada bipagem custaria fila.
    await waitFor(() => expect(carrinho()).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('o interruptor "Incluir peças da oficina"', () => {
  it('começa desligado, e desligado a busca por NOME não traz peça', async () => {
    montar();
    const chave = screen.getByLabelText('Incluir peças da oficina') as HTMLInputElement;
    expect(chave.checked).toBe(false);

    await bipar('Bateria');

    expect(buscas[0]).not.toContain('includeParts');
    expect(screen.queryByText('Bateria Original iPhone 11')).toBeNull();
  });

  it('ligado, CHAMA a opção que o servidor oferece e a peça aparece marcada', async () => {
    montar();
    const campo = screen.getByLabelText(/Pesquise por código/);
    fireEvent.change(campo, { target: { value: 'Bateria' } });

    // Ligar refaz a busca na hora: resultado velho na tela faria o interruptor
    // parecer quebrado.
    fireEvent.click(screen.getByLabelText('Incluir peças da oficina'));

    await waitFor(() => expect(buscas.some((u) => u.includes('includeParts=1'))).toBe(true));
    const linha = await screen.findByText('Bateria Original iPhone 11');
    // Achar a peça sem dizer que é peça é o defeito, não o conserto.
    expect(linha.textContent).toContain('Peça · Oficina de Celulares');
  });
});
