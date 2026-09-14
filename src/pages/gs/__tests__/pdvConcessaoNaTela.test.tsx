/**
 * A CONCESSÃO APARECE NO BALCÃO — e a recusa do servidor também.
 *
 * ## Por que não bastam os testes de `pdvConcessao.test.ts`
 *
 * Aqueles provam que a CONTA está certa. Continuariam verdes com a tela
 * ignorando o resultado inteiro — que é a forma exata do defeito que este
 * projeto já cometeu duas vezes: o dado existe, é calculado, é gravado, e
 * ninguém lê. `origens` nasceu no servidor para a mensagem poder dizer de onde
 * veio cada centavo concedido; se nenhuma tela mostrar, é campo sem leitor.
 *
 * Por isso aqui o PDV é montado DE VERDADE, com a rede dublada, e o que se
 * cobra é texto na tela.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire o painel de concessão e o operador volta a descobrir a recusa só no
 *     Finalizar, com o cliente na frente;
 *   - deixe de ler `details` do 403 e a liberação volta a ser pedida sem
 *     número, mandando o gestor digitar a senha no escuro;
 *   - engula `CORE_PRODUCT_WITHOUT_PRICE` numa mensagem genérica e a recusa
 *     volta a não dizer o que fazer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';

/** A gaveta aberta do turno — sem ela o PDV recusa a venda. */
const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

/** Moto de R$ 12.000 — o item do caso real do preço rebaixado. */
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
  stock_quantity: 2,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** O produto que a entrada de nota criou e ninguém precificou. */
const SEM_PRECO = {
  ...MOTO,
  id: 'p-filtro',
  internal_code: 'MT-0002',
  barcode: '7890000002222',
  name: 'Filtro de óleo',
  price_cents: 0,
  effective_price_cents: 0,
};

/**
 * Mão de obra: preço ABERTO, sugestão zero no cadastro.
 *
 * É o caso que a recusa do servidor manda consertar "na linha" — e o motivo de
 * a linha ter passado a ter campo.
 */
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

/**
 * A pré-venda que o cliente volta para pagar, com a moto pelo preço combinado
 * semanas atrás. A tabela subiu desde então — é o carrinho que acusava "Acima
 * do limite" num caminho em que ninguém ia pedir gestor nenhum.
 */
const PRE_VENDA = {
  id: 'q-1',
  number: 77,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: null,
  customer_name: null,
  total_cents: 1000000,
  discount_cents: 0,
  valid_until: null,
  converted_sale_id: null,
  created_at: '2026-08-01T12:00:00.000Z',
};

const PRE_VENDA_DETALHE = {
  ...PRE_VENDA,
  note: null,
  items: [
    {
      id: 'qi-1',
      product_id: 'p-moto',
      description: 'Moto Honda CG 160',
      quantity: 1,
      unit_price_cents: 1000000,
      discount_cents: 0,
      total_cents: 1000000,
    },
  ],
};

/** Para onde a conversão foi chamada — prova de que o faturamento não é venda. */
let convertidas: string[] = [];
/** O que a rota de política respondeu, e o que o POST de venda vai devolver. */
let limitePercent = 10;
let respostaDaVenda: { status: number; body: unknown } = {
  status: 201,
  body: { id: 's-1', number: 1, total_cents: 0, change_cents: 0, status: 'fechada', created_at: '' },
};

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      return new Response(JSON.stringify(respostaDaVenda.body), {
        status: respostaDaVenda.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // A conversão da pré-venda é OUTRA rota, e é justamente o ponto do teste
    // da faixa: faturar documento não passa por `POST /core/sales`.
    if (alvo.includes('/core/quotes/') && alvo.endsWith('/convert') && metodo === 'POST') {
      convertidas.push(alvo);
      return new Response(JSON.stringify({ saleId: 's-9', number: 9 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    /*
      A REPRECIFICAÇÃO POR CLIENTE, que o PDV passou a consultar.

      Nenhum cliente tem tabela neste arquivo — o que se mede aqui é a
      concessão, e ela não muda. Mas o dublê precisa responder o CONTRATO: um
      corpo genérico deixaria a tela sem `items`, e a prova de que o carrinho de
      pré-venda não acusa alçada passaria a depender de a tela ignorar uma
      resposta quebrada, e não da conta estar certa.

      O preço devolvido é o mesmo do cadastro/promoção que a busca já usa, que é
      exatamente o que o servidor responde para venda sem cliente.
    */
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const pedido = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as {
        items?: { productId: string }[];
      };
      const linhas = (pedido.items ?? [])
        .map((i) => [MOTO, SEM_PRECO, MAO_DE_OBRA].find((p) => p.id === i.productId))
        .filter((p): p is typeof MOTO => Boolean(p))
        .map((p) => ({
          productId: p.id,
          priceCents: p.effective_price_cents,
          listPriceCents: p.price_cents,
          onSale: p.effective_price_cents < p.price_cents,
          fonte: p.open_price === 1 ? 'aberto' : 'cadastro',
        }));
      return new Response(JSON.stringify({ items: linhas, priceTable: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      corpo = { items: [MOTO, SEM_PRECO, MAO_DE_OBRA].filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/products/')) {
      // `getProduct`, o caminho que `loadQuote` usa para remontar o carrinho.
      corpo = MOTO;
    } else if (alvo.includes('/core/quotes/')) {
      corpo = PRE_VENDA_DETALHE;
    } else if (alvo.includes('/core/quotes')) {
      corpo = { items: [PRE_VENDA] };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: limitePercent, canAuthorizeSelf: false };
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
  convertidas = [];
  limitePercent = 10;
  respostaDaVenda = {
    status: 201,
    body: { id: 's-1', number: 1, total_cents: 0, change_cents: 0, status: 'fechada', created_at: '' },
  };
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

/**
 * Põe o item no carrinho pelo preço digitado.
 *
 * Preço ANTES da busca de propósito: é o gesto do balcão — a pessoa digita o
 * valor combinado e só então bipa.
 */
async function biparCom(codigo: string, precoReais?: string) {
  if (precoReais !== undefined) {
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: precoReais } });
  }
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Remover / }).length)
    .toBeGreaterThan(0));
}

describe('o painel de concessão, antes de fechar a venda', () => {
  it('não aparece quando não se concedeu nada — senão vira parte do cenário', async () => {
    montar();
    await biparCom('7890000001111');

    expect(screen.queryByText(/Concessão nesta venda/i)).toBeNull();
  });

  it('mostra quanto, quantos por cento, e DE ONDE veio', async () => {
    montar();
    // A moto de R$ 12.000 saindo por R$ 10.000: ninguém digitou desconto, e
    // ainda assim há R$ 2.000 de concessão. Este era o caminho que não passava
    // por alçada nenhuma.
    await biparCom('7890000001111', '10000');

    const painel = await screen.findByText(/Concessão nesta venda/i);
    const caixa = painel.parentElement!;
    // `formatCents` e não a string literal: o pt-BR usa espaço NÃO separável
    // depois do "R$", e um teste escrito com espaço comum reprovaria a moeda
    // certa. O que se cobra é o que o balcão lê.
    expect(caixa.textContent).toContain(formatCents(200000));
    expect(caixa.textContent).toContain('16.67%');
    expect(caixa.textContent).toContain(formatCents(1200000));
    // O leitor de `origens`: sem esta frase, "precisa de gestor" manda a pessoa
    // procurar um desconto que ela não deu.
    expect(caixa.textContent).toContain('de preço abaixo do vigente');
  });

  it('diz se passou do limite DESTA operação, com o número que o servidor deu', async () => {
    limitePercent = 25;
    montar();
    await biparCom('7890000001111', '10000');

    const caixa = (await screen.findByText(/Concessão nesta venda/i)).parentElement!;
    // 16,67% cabe em 25%: o mesmo carrinho que pediria gestor numa loja de
    // limite 10 passa nesta. É por isso que o número não pode ser constante
    // no frontend.
    expect(caixa.textContent).toContain('Dentro do limite de 25%');
  });

  it('avisa que vai pedir gestor ANTES de o servidor recusar', async () => {
    montar();
    await biparCom('7890000001111', '10000');

    const caixa = (await screen.findByText(/Concessão nesta venda/i)).parentElement!;
    expect(caixa.textContent).toContain('Acima do limite de 10%');
  });
});

describe('a recusa do servidor manda na tela', () => {
  it('os números do 403 aparecem — o gestor não digita a senha no escuro', async () => {
    respostaDaVenda = {
      status: 403,
      body: {
        error: {
          code: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
          message: 'Esta venda concede R$ 2.000,00 sobre R$ 12.000,00 (16.67%).',
          details: {
            percentual: 16.67,
            concedidoCents: 200000,
            brutoCents: 1200000,
            origens: { cabecalho: 50000, itens: 30000, precoRebaixado: 120000 },
            limite: 10,
          },
        },
      },
    };
    montar();
    await biparCom('7890000001111', '10000');
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    const painel = await screen.findByText(/Precisa da liberação de um gestor/i);
    const caixa = painel.parentElement!;
    // As TRÊS origens do servidor, e não só a que a tela sabia calcular. O PDV
    // não tem campo de desconto por item; quem enxerga os três caminhos é o
    // servidor, e é o detalhe dele que está sendo lido aqui.
    expect(caixa.textContent).toContain('de desconto no rodapé');
    expect(caixa.textContent).toContain('de desconto nos itens');
    expect(caixa.textContent).toContain('de preço abaixo do vigente');
    expect(caixa.textContent).toContain('Acima do limite de 10%');
  });
});

/** Abre a lista de pré-vendas e carrega a #77 no carrinho. */
async function carregarPreVenda() {
  fireEvent.click(screen.getByRole('button', { name: /Pré-venda \(F9\)/ }));
  fireEvent.click(await screen.findByText('Pré-venda #77'));
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

describe('a faixa não pode acusar onde o servidor não barra', () => {
  it('no carrinho de pré-venda ela NÃO diz "acima do limite" — a conversão não pede gestor', async () => {
    montar();
    await carregarPreVenda();

    // A moto foi combinada por R$ 10.000 e a tabela está em R$ 12.000: são
    // 16,67% de concessão, acima dos 10% desta operação. Numa venda avulsa isso
    // pediria gestor; faturando o documento, não pede — e a faixa dizia que sim.
    const caixa = (await screen.findByText(/Concessão da pré-venda #77/i)).parentElement!;
    expect(caixa.textContent).toContain(formatCents(200000));
    expect(caixa.textContent).toContain('16.67%');
    /*
      O GUARDA. Volte o `acima` a ignorar a pré-venda e esta linha reaparece —
      com o operador aprendendo que faixa vermelha não significa nada, que é o
      preço que se paga por acusar sem barrar.
    */
    expect(caixa.textContent).not.toContain('Acima do limite');
    expect(caixa.textContent).toContain('já passou pela alçada quando foi criado');
    // E o que ele precisa mesmo saber: o que ele mexer aqui não chega à venda.
    expect(caixa.textContent).toContain('mexer no carrinho aqui não muda a venda');
  });

  it('faturar a pré-venda vai pela CONVERSÃO, e não pela venda avulsa', async () => {
    montar();
    await carregarPreVenda();
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    // É o fato que sustenta a faixa: a alçada de `POST /core/sales` não é
    // consultada neste caminho, porque este caminho não é ele.
    await waitFor(() => expect(convertidas).toHaveLength(1));
    expect(convertidas[0]).toContain('/core/quotes/q-1/convert');
  });

  it('na venda avulsa ela continua acusando — o limite ali é cobrado de verdade', async () => {
    montar();
    await biparCom('7890000001111', '10000');

    const caixa = (await screen.findByText(/Concessão nesta venda/i)).parentElement!;
    expect(caixa.textContent).toContain('Acima do limite de 10%');
  });
});

describe('produto sem preço', () => {
  it('a tela avisa no carrinho, antes de a venda ser recusada', async () => {
    montar();
    await biparCom('7890000002222');

    const aviso = await screen.findByText(/Item sem preço no carrinho/i);
    expect(aviso.parentElement!.textContent).toContain('Filtro de óleo');
  });

  it('a recusa do servidor aparece com o texto DELE e uma saída', async () => {
    respostaDaVenda = {
      status: 409,
      body: {
        error: {
          code: 'CORE_PRODUCT_WITHOUT_PRICE',
          message:
            '"Filtro de óleo" está sem preço de venda e por isso não pode ser vendido. '
            + 'Defina o preço em Produtos (ou na Alteração rápida) e bipe de novo.',
          details: { productId: 'p-filtro', name: 'Filtro de óleo', openPrice: false },
        },
      },
    };
    montar();
    await biparCom('7890000002222');
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    // O texto do servidor, inteiro: ele é quem sabe que o produto veio de uma
    // nota e ficou sem precificar. Um "falha ao finalizar" genérico deixaria o
    // operador sem saber o que consertar.
    const recusa = await screen.findByText(/está sem preço de venda/);
    expect(recusa.textContent).toContain('Defina o preço em Produtos');

    // E a saída: tirar do carrinho é o conserto possível no balcão.
    fireEvent.click(screen.getByRole('button', { name: 'Tirar do carrinho' }));
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /^Remover / })).toHaveLength(0),
    );
  });
});

/**
 * O CAMPO QUE A RECUSA MANDAVA USAR E QUE NÃO EXISTIA.
 *
 * O servidor recusa preço aberto sem valor com "digite o valor na linha antes
 * de fechar a venda". Havia só o "Preço Unitário" da coluna de busca, que vale
 * ao PÔR o item no carrinho — depois de ele estar lá, a linha não tinha onde
 * digitar nada. A pessoa procurava o campo citado, não achava, e concluía que o
 * sistema estava quebrado; o conserto real era tirar a linha e bipar de novo.
 *
 * Tire o campo da linha e os três testes abaixo caem.
 */
describe('preço aberto se resolve NA LINHA, que é o que a recusa manda fazer', () => {
  it('a mão de obra bipada sem valor ganha o campo na própria linha', async () => {
    montar();
    await biparCom('7890000003333');

    expect(screen.getByLabelText('Valor combinado de Mão de obra revisão')).toBeTruthy();
    // E o aviso aponta para ele, e não mais para o campo da busca.
    const aviso = (await screen.findByText(/Item sem preço no carrinho/i)).parentElement!;
    expect(aviso.textContent).toContain('"Valor combinado", na própria linha');
  });

  it('digitar ali põe o valor na venda, sem tirar o item do carrinho', async () => {
    montar();
    await biparCom('7890000003333');

    fireEvent.change(screen.getByLabelText('Valor combinado de Mão de obra revisão'), {
      target: { value: '150,00' },
    });

    // O total da linha passa a ser o combinado. `textContent` e não
    // `getByText`: o pt-BR põe espaço NÃO separável depois do "R$", e o
    // normalizador do getByText o troca por espaço comum — a comparação
    // reprovaria justamente a moeda certa.
    await waitFor(() => {
      const linha = screen.getByRole('button', { name: /^Remover / }).closest('li')!;
      expect(linha.textContent).toContain(formatCents(15000));
    });
    // ...o aviso de item sem preço some, porque o estado que ele descrevia
    // deixou de existir...
    expect(screen.queryByText(/Item sem preço no carrinho/i)).toBeNull();
    // ...e o item continua no carrinho: o conserto não custou uma bipagem nova.
    expect(screen.getAllByRole('button', { name: /^Remover / })).toHaveLength(1);
  });

  it('apagar o valor volta a acusar — o campo em branco não guarda o de antes', async () => {
    montar();
    await biparCom('7890000003333', '150');
    expect(screen.queryByText(/Item sem preço no carrinho/i)).toBeNull();

    fireEvent.change(screen.getByLabelText('Valor combinado de Mão de obra revisão'), {
      target: { value: '' },
    });

    // Mostrar o valor antigo num campo vazio esconderia exatamente o estado que
    // vai ser recusado no Finalizar, com o cliente na frente.
    await screen.findByText(/Item sem preço no carrinho/i);
  });

  it('produto de preço FECHADO não ganha campo de preço na linha', async () => {
    montar();
    await biparCom('7890000001111');

    // Aqui o preço vem do cadastro, e baixá-lo é concessão. Um campo de preço
    // em toda linha do carrinho abriria um caminho novo de desconto no gesto
    // mais repetido do balcão.
    expect(screen.queryByLabelText(/^Valor combinado de Moto/)).toBeNull();
  });
});
