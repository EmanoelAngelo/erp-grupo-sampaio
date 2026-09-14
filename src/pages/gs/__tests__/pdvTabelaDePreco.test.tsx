/**
 * A TABELA DE PREÇO VALENDO NO BALCÃO — o PDV montado de verdade.
 *
 * ## Por que não bastam os testes de `pdvReprecificacao.test.ts`
 *
 * Aqueles provam que a REGRA está certa. Continuariam verdes com o `PdvPage`
 * nunca chamando a rota — o dado existe, é calculado, e ninguém lê. É a forma
 * exata do defeito que fez esta rodada existir: o cadastro de tabela de preço
 * estava inteiro, com tela e texto explicando a regra de atacado, e
 * `priceInTable` não tinha um único chamador.
 *
 * Por isso aqui a tela é montada com a rede dublada, e o que se cobra é o
 * NÚMERO QUE O OPERADOR LÊ.
 *
 * ## O caminho não importa — e é esse o ponto
 *
 * O PDV descobre o cliente depois dos itens tanto quanto os itens entram depois
 * do cliente. Cada `describe` abaixo é um caminho diferente por onde a linha
 * chega ao carrinho: bipe comum, bipe com o cliente já escolhido, pré-venda
 * carregada, venda retomada da espera. Nenhum deles tem código próprio no
 * `PdvPage` — todos passam pela mesma marca `precificadaPara`. Se um dia
 * aparecer um quinto caminho, ele nasce coberto.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire o efeito de reprecificação e a moto do revendedor volta a sair por
 *     R$ 12.000,00 em todos os quatro caminhos;
 *   - deixe de reescrever o vigente e a venda de atacado volta a acusar 15% de
 *     concessão e a pedir gestor — que é o balcão travando em toda venda de
 *     revenda, o estado de onde esta rodada partiu;
 *   - ignore `fonte: 'aberto'` e a mão de obra combinada em R$ 250,00 vai a
 *     zero no instante em que o cliente é escolhido.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';

/** A gaveta aberta do turno — sem ela o PDV recusa a venda. */
const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const MOTO = {
  id: 'p-moto',
  internal_code: 'MT-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Moto Honda CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 900000,
  price_cents: 1200000,
  effective_price_cents: 1200000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 3,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Mão de obra: preço ABERTO, sugestão zero no cadastro. */
const MAO_DE_OBRA = {
  ...MOTO,
  id: 'p-servico',
  internal_code: 'SV-0001',
  barcode: '7890000003333',
  name: 'Mão de obra revisão',
  price_cents: 0,
  effective_price_cents: 0,
  open_price: 1,
};

const CATALOGO = [MOTO, MAO_DE_OBRA];

/** O revendedor de 15% — a razão de a funcionalidade existir. */
const REVENDEDOR = {
  id: 'c-revenda',
  name: 'PJ Motos Revenda',
  document: '11222333000181',
  email: null,
  phone: null,
  price_table_id: 't-atacado',
};

const CONSUMIDOR = {
  id: 'c-final',
  name: 'Maria da Silva',
  document: null,
  email: null,
  phone: null,
  price_table_id: null,
};

const PRE_VENDA = {
  id: 'q-1',
  number: 77,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: 'c-revenda',
  total_cents: 1200000,
  discount_cents: 0,
  valid_until: null,
  converted_sale_id: null,
  created_at: '2026-08-01T12:00:00.000Z',
};

const PRE_VENDA_DETALHE = {
  ...PRE_VENDA,
  note: null,
  liberacao: null,
  expired: false,
  items: [
    {
      id: 'qi-1',
      product_id: 'p-moto',
      description: 'Moto Honda CG 160',
      quantity: 1,
      // Aprovado por R$ 11.000,00 — ACIMA do preço de revenda de hoje. É o caso
      // em que o cliente virou revendedor depois de o documento ser aprovado.
      unit_price_cents: 1100000,
      discount_cents: 0,
      total_cents: 1100000,
    },
  ],
};

/** Todo corpo que a tela mandou para `POST /core/pricing/cart`. */
let pedidosDePreco: { customerId: string | null; items: { productId: string }[] }[] = [];
/** Quando verdadeiro, a rota de preço falha — para o caso da rede caindo. */
let precoFalha = false;

/**
 * A resposta de preço, calculada como o servidor calcula.
 *
 * ESCRITA UMA VEZ SÓ, e a partir da tabela do cliente: um dublê que devolvesse
 * números fixos por cenário deixaria de reprovar a tela no dia em que ela
 * pedisse preço para o cliente errado — responderia certo de qualquer forma.
 */
function precificar(customerId: string | null, ids: string[]) {
  const revendedor = customerId === REVENDEDOR.id;
  return {
    items: ids
      .map((id) => CATALOGO.find((p) => p.id === id))
      .filter((p): p is typeof MOTO => Boolean(p))
      .map((p) => {
        if (p.open_price === 1) {
          // A MESMA decisão do servidor: em preço aberto não há vigente a
          // descobrir, e a tela não pode inventar um.
          return {
            productId: p.id,
            priceCents: p.price_cents,
            listPriceCents: p.price_cents,
            onSale: false,
            fonte: 'aberto' as const,
          };
        }
        const preco = revendedor ? Math.round(p.price_cents * 0.85) : p.price_cents;
        return {
          productId: p.id,
          priceCents: preco,
          listPriceCents: p.price_cents,
          onSale: preco < p.price_cents,
          fonte: revendedor ? ('tabela' as const) : ('cadastro' as const),
        };
      }),
    priceTable: revendedor ? { id: 't-atacado', name: 'Atacado', percentOff: 15 } : null,
  };
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      if (precoFalha) {
        return new Response(
          JSON.stringify({ error: { code: 'CORE_INTERNAL', message: 'Servidor indisponível.' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const corpo = JSON.parse(String(init?.body ?? '{}')) as {
        customerId: string | null;
        items: { productId: string }[];
      };
      pedidosDePreco.push(corpo);
      return new Response(
        JSON.stringify(precificar(corpo.customerId, corpo.items.map((i) => i.productId))),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      return new Response(
        JSON.stringify({
          id: 's-1',
          number: 1,
          total_cents: 0,
          change_cents: 0,
          status: 'fechada',
          created_at: '',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      corpo = { items: CATALOGO.filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/products/')) {
      const id = alvo.split('/core/products/')[1].split('?')[0];
      corpo = CATALOGO.find((p) => p.id === id) ?? MOTO;
    } else if (alvo.includes('/core/quotes/')) {
      corpo = PRE_VENDA_DETALHE;
    } else if (alvo.includes('/core/quotes')) {
      corpo = { items: [PRE_VENDA] };
    } else if (alvo.includes(`/core/customers/${REVENDEDOR.id}`)) {
      // A pré-venda traz o cliente PELO ID (GAP-PRD-070), não da lista de 100.
      corpo = REVENDEDOR;
    } else if (alvo.includes('/core/customers')) {
      corpo = { items: [REVENDEDOR, CONSUMIDOR] };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
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
  pedidosDePreco = [];
  precoFalha = false;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

async function bipar(codigo: string, precoReais?: string) {
  if (precoReais !== undefined) {
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: precoReais } });
  }
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

async function escolherCliente(nome: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: 'Cliente (F2)' }));
  const opcao = await screen.findByRole('button', { name: nome });
  fireEvent.click(opcao);
}

/** O total da linha, que é o número que o operador confere com o cliente. */
async function esperarTotalDaLinha(cents: number) {
  await waitFor(() => {
    const linha = screen.getByRole('button', { name: /^Remover / }).closest('li')!;
    expect(linha.textContent).toContain(formatCents(cents));
  });
}

// ---------------------------------------- caminho 1: o cliente entra DEPOIS

describe('o cliente escolhido depois dos itens', () => {
  it('reprecifica a moto já no carrinho para o preço de revenda', async () => {
    montar();
    await bipar('7890000001111');
    // Sem cliente, o preço é o da busca: R$ 12.000,00.
    await esperarTotalDaLinha(1200000);

    await escolherCliente('PJ Motos Revenda');

    // 15% da tabela: R$ 10.200,00, sem ninguém digitar desconto.
    await esperarTotalDaLinha(1020000);
  });

  it('a condição aparece escrita — preço que cai sozinho assusta', async () => {
    montar();
    await bipar('7890000001111');
    await escolherCliente('PJ Motos Revenda');

    const faixa = await screen.findByTestId('pdv-tabela-do-cliente');
    expect(faixa.textContent).toContain('Atacado');
    expect(faixa.textContent).toContain('-15%');
  });

  it('cliente SEM tabela não muda preço nenhum, e não anuncia condição', async () => {
    montar();
    await bipar('7890000001111');
    await escolherCliente('Maria da Silva');

    await waitFor(() => expect(pedidosDePreco.some((p) => p.customerId === 'c-final')).toBe(true));
    await esperarTotalDaLinha(1200000);
    expect(screen.queryByTestId('pdv-tabela-do-cliente')).toBeNull();
  });

  it('tirar o cliente devolve o preço cheio — o desconto vai embora com ele', async () => {
    montar();
    await bipar('7890000001111');
    await escolherCliente('PJ Motos Revenda');
    await esperarTotalDaLinha(1020000);

    // O revendedor escolhido por engano no primeiro item ficaria dando 15% ao
    // resto do carrinho se não houvesse como desfazer sem cancelar a venda.
    await escolherCliente(/Consumidor final/);

    await esperarTotalDaLinha(1200000);
    expect(screen.queryByTestId('pdv-tabela-do-cliente')).toBeNull();
  });
});

// ------------------------------------- caminho 2: o item entra DEPOIS do cliente

describe('o item bipado com o cliente já escolhido', () => {
  it('anuncia a condição ANTES do primeiro bipe', async () => {
    montar();
    await escolherCliente('PJ Motos Revenda');

    const faixa = await screen.findByTestId('pdv-tabela-do-cliente');
    expect(faixa.textContent).toContain('Atacado');
    // Nenhum item ainda: a consulta do carrinho vazio existe só para isto.
    expect(screen.queryAllByRole('button', { name: /^Remover / })).toHaveLength(0);
  });

  it('a moto entra já pelo preço de revenda', async () => {
    montar();
    await escolherCliente('PJ Motos Revenda');
    await screen.findByTestId('pdv-tabela-do-cliente');

    await bipar('7890000001111');

    // A busca do balcão responde R$ 12.000,00 — ela não conhece cliente. É a
    // reprecificação que corrige a linha recém-criada.
    await esperarTotalDaLinha(1020000);
  });
});

// ------------------------------------------------ o que decide a rodada

describe('a venda de atacado fecha SEM autorização de gestor', () => {
  it('o revendedor de 15% com teto de 10% não aciona o painel de concessão', async () => {
    montar();
    await escolherCliente('PJ Motos Revenda');
    await bipar('7890000001111');
    await esperarTotalDaLinha(1020000);

    /*
      O ponto inteiro da rodada. Com o preço da tabela DENTRO do vigente, os
      R$ 1.800,00 combinados entram no denominador e o numerador da concessão
      fica zero. Sem isso, este mesmo carrinho acusaria 15% sobre R$ 12.000,00 e
      pediria gestor — em TODA venda de revenda.
    */
    expect(screen.queryByText(/Concessão nesta venda/i)).toBeNull();
    expect(screen.queryByText(/Acima do limite/i)).toBeNull();
  });

  it('5% ALÉM da tabela medem 5% — e não 19,25%', async () => {
    montar();
    await escolherCliente('PJ Motos Revenda');
    await screen.findByTestId('pdv-tabela-do-cliente');

    // R$ 9.690,00: 5% abaixo do preço de revenda de R$ 10.200,00.
    await bipar('7890000001111', '9690');
    await esperarTotalDaLinha(969000);

    const painel = await screen.findByText(/Concessão nesta venda/i);
    const caixa = painel.parentElement!;
    expect(caixa.textContent).toContain('5%');
    // O denominador é o preço de REVENDA, não o de cadastro.
    expect(caixa.textContent).toContain(formatCents(1020000));
    expect(caixa.textContent).toContain(formatCents(51000));
    // 5% cabe em 10%: ninguém é chamado.
    expect(caixa.textContent).toContain('Dentro do limite de 10%');
    // O número que apareceria sem a tabela no denominador.
    expect(caixa.textContent).not.toContain('19.25%');
  });
});

// ------------------------------------- caminho 3: a pré-venda carregada (F9)

describe('a pré-venda carregada no balcão', () => {
  it('o preço aprovado é limitado ao vigente do cliente, e o vigente é o de revenda', async () => {
    montar();
    await escolherCliente('PJ Motos Revenda');
    await screen.findByTestId('pdv-tabela-do-cliente');

    // O botão passou a se chamar "Orçamento/Pré-venda (F9)" quando o F9 deixou
    // de listar só pré-venda (GAP-V68). O casamento vira REGEX para não voltar
    // a quebrar no dia em que o rótulo ganhar outra palavra — o que este caso
    // mede é a tabela de preço, não o texto do botão.
    fireEvent.click(screen.getByRole('button', { name: /Pré-venda \(F9\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda #77/ }));

    /*
      O documento foi aprovado por R$ 11.000,00, ACIMA do preço de revenda de
      hoje. O servidor aplica teto no vigente ao faturar, então a tela que
      mostrasse R$ 11.000,00 prometeria ao cliente um total que a venda não
      cobra — e o carrinho de pré-venda nunca passava por reprecificação
      nenhuma antes desta rodada.
    */
    await esperarTotalDaLinha(1020000);
  });
});

// ----------------------------- caminho 4: a venda retomada da espera (F7)

describe('a venda retomada da espera', () => {
  it('a espera guardada ANTES desta rodada é reprecificada ao ser retomada', async () => {
    /*
      Escrito direto no `localStorage` de propósito: é exatamente a forma que
      uma espera guardada pela versão anterior tem — linhas sem a marca
      `precificadaPara`, e um cliente com tabela. Nenhum código do `PdvPage`
      trata este caso; ele é coberto porque a marca ausente não bate com
      cliente nenhum.
    */
    localStorage.setItem(
      'gs.pdv.emEspera',
      JSON.stringify([
        {
          id: 'espera-antiga',
          // O escopo é o da gaveta aberta do turno — desde a rodada do caixa,
          // "sem caixa" deixou de ser uma constante única do grupo e passou a
          // levar a empresa junto. O que este teste mede é outra coisa: a
          // linha SEM `precificadaPara`, como a versão anterior gravava.
          escopo: CAIXA_ABERTO.id,
          rotulo: 'PJ Motos Revenda',
          criadoEm: '2026-08-18T12:00:00.000Z',
          lines: [{ product: MOTO, quantity: 1, unitPriceCents: 1200000 }],
          customerId: REVENDEDOR.id,
          customerName: REVENDEDOR.name,
          discount: 0,
          note: '',
        },
      ]),
    );

    montar();
    const faixa = await screen.findByTestId('pdv-esperas');
    fireEvent.click(
      Array.from(faixa.querySelectorAll('button')).find(
        (b) => b.textContent === 'PJ Motos Revenda',
      )!,
    );

    await esperarTotalDaLinha(1020000);
    await screen.findByTestId('pdv-tabela-do-cliente');
  });
});

// ------------------------------------------------- preço aberto fica de fora

describe('mão de obra não é reprecificada', () => {
  it('o valor combinado sobrevive à escolha do cliente', async () => {
    montar();
    // R$ 250,00 combinados no balcão, antes de saber quem é o cliente.
    await bipar('7890000003333', '250');
    await esperarTotalDaLinha(25000);

    await escolherCliente('PJ Motos Revenda');
    await screen.findByTestId('pdv-tabela-do-cliente');

    /*
      Sem a exclusão, esta linha iria a ZERO: o cadastro de mão de obra tem
      `price_cents` zero, e reprecificá-la escreveria a sugestão do cadastro
      por cima do combinado — sem erro nenhum na tela, no instante em que o
      cliente fosse escolhido.
    */
    await esperarTotalDaLinha(25000);
    expect(
      (screen.getByLabelText('Valor combinado de Mão de obra revisão') as HTMLInputElement).value,
    ).toBe('250,00');
  });
});

// ------------------------------------------------------ quando a rede falha

describe('a rota de preço fora do ar', () => {
  it('avisa em vez de fingir que o preço do cliente foi aplicado', async () => {
    montar();
    await bipar('7890000001111');
    await esperarTotalDaLinha(1200000);

    precoFalha = true;
    await escolherCliente('PJ Motos Revenda');

    /*
      Marcar as linhas como precificadas aqui seria afirmar que R$ 12.000,00 é
      o preço do revendedor — e o operador fecharia a venda por esse valor sem
      nada na tela dizendo o contrário. A palavra final continua sendo do
      servidor no fechamento; o que a tela deve é não mentir no meio.
    */
    await screen.findByText(/Não foi possível aplicar o preço do cliente/i);
    await esperarTotalDaLinha(1200000);
    expect(screen.queryByTestId('pdv-tabela-do-cliente')).toBeNull();
  });
});
