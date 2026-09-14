/**
 * ============================================================================
 * O LINK DA ORIGEM ABRE O DOCUMENTO — não a tela onde ele mora
 * ============================================================================
 *
 * ## Os três defeitos que este arquivo existe para impedir
 *
 * 1. A ENTRADA MANUAL NÃO VIRAVA LINK. O servidor passou a resolver o rótulo
 *    de `entrada_manual` ('Entrada manual EM-7 — Seu Zé'), e o mapa de destinos
 *    da ContasPage conhecia quatro origens: a compra da feira continuava sem
 *    porta, com o rótulo na tela e nenhum caminho.
 *
 * 2. O LINK LEVAVA À TELA, NÃO AO PAPEL. `/sistema/compras/entrada-notas` abre
 *    a lista inteira; quem clicou em "Nota 4711" ainda tinha de procurar a
 *    4711 no meio de duzentas. Meia navegação — a pessoa chega na sala certa e
 *    a gaveta continua fechada. Os links passam a carregar o ID
 *    (`?venda=`, `?nota=`, `?pedido=`, `?devolucao=`) e a tela de destino abre
 *    o documento sozinha.
 *
 * 3. A FICHA DO DOCUMENTO NÃO MOSTRAVA O QUE ELE COBRA. A VOLTA da
 *    rastreabilidade (`listFinanceEntries({originType, originId})`) existia,
 *    estava testada no servidor e NENHUMA tela a chamava: quem abria a nota de
 *    entrada não via a dívida que ela gerou, e quem abria o pedido de compra
 *    não via nada de dinheiro. Consulta sem leitor é a dívida que este projeto
 *    já pagou várias vezes.
 *
 * Todo caso olha o FIO — o href que sai, a URL que a tela pede — e nenhum se
 * contenta com "a tela renderizou".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ContasPage from '../ContasPage';
import DevolucoesPage from '../DevolucoesPage';
import EntradaNotasPage from '../EntradaNotasPage';
import PedidosCompraPage from '../PedidosCompraPage';
import { VendasPage } from '../OperacaoPages';

// --------------------------------------------------------------- os dublês

function titulo(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    direction: 'out',
    description: 'Entrada manual EM-7',
    amountCents: 45_000,
    settledCents: 0,
    balanceCents: 45_000,
    status: 'open',
    dueDate: '2026-09-10',
    settledAt: null,
    overdue: false,
    counterpartyName: 'Seu Zé das Embalagens',
    originType: 'entrada_manual',
    originId: 'n-manual',
    originLabel: 'Entrada manual EM-7 — Seu Zé das Embalagens',
    installmentNumber: 1,
    installmentTotal: 1,
    categoryId: null,
    categoryName: null,
    costCenterId: null,
    costCenterName: null,
    cancelledAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    ...over,
  };
}

const TITULOS_DA_CONTAS = [
  titulo(),
  titulo({
    id: 't-2',
    description: 'Venda #12',
    direction: 'in',
    originType: 'sale',
    originId: 'venda-12',
    originLabel: 'Venda #12',
  }),
  titulo({
    id: 't-3',
    description: 'Devolução #4',
    originType: 'sale_return',
    originId: 'dev-4',
    originLabel: 'Devolução #4 da venda #12',
  }),
  titulo({
    id: 't-4',
    description: 'NF-e 4711',
    originType: 'nfe_entrada',
    originId: 'nota-4711',
    originLabel: 'Nota 4711 — Distribuidora Alfa',
  }),
  titulo({
    id: 't-5',
    description: 'Aluguel',
    originType: 'manual',
    originId: 't-5',
    originLabel: null,
  }),
];

const RESUMO = { openCents: 45_000, overdueCents: 0, settledCents: 0, count: 5 };
const AGING = {
  notDueCents: 45_000,
  days1to30Cents: 0,
  days31to60Cents: 0,
  days61to90Cents: 0,
  over90Cents: 0,
};

const NOTA = {
  id: 'n-manual',
  access_key: 'manual:n-manual',
  number: 'EM-7',
  series: null,
  supplier_name: 'Seu Zé das Embalagens',
  total_cents: 45_000,
  status: 'recebida',
  created_at: '2026-08-20T10:00:00.000Z',
  issued_at: null,
  carrier_name_xml: null,
  freight_mode: null,
  volumes_qty: null,
  gross_weight_grams: null,
  vehicle_plate: null,
  tem_xml: 0,
  doc_type: 'manual',
};

const NOTA_FISCAL = {
  ...NOTA,
  id: 'nota-4711',
  access_key: '35240114200166000187550010000047110000000017',
  number: '4711',
  series: '1',
  supplier_name: 'Distribuidora Alfa',
  doc_type: 'nfe',
  tem_xml: 1,
};

const ITENS_DA_NOTA = [
  {
    description: 'Sacola kraft 30x40',
    barcode: null,
    ncm: null,
    cfop: null,
    unit: 'UN',
    quantity: 100,
    unitCostCents: 450,
    totalCents: 45_000,
    productId: 'p-sacola',
    matchedBy: 'barcode',
  },
];

const PEDIDO = {
  id: 'pc-9',
  number: 9,
  supplier_id: 'f-ze',
  supplier_name: 'Seu Zé das Embalagens',
  supplier_trade_name: null,
  status: 'recebido',
  expected_at: null,
  notes: null,
  total_cents: 45_000,
  cancel_reason: null,
  created_at: '2026-08-15T10:00:00.000Z',
};

const PEDIDO_DETALHE = {
  ...PEDIDO,
  supplier: { name: 'Seu Zé das Embalagens', trade_name: null, document: null },
  items: [
    {
      id: 'i-1',
      product_id: 'p-sacola',
      internal_code: 'SAC-01',
      description: 'Sacola kraft 30x40',
      quantity: 100,
      unit_cost_cents: 450,
      total_cents: 45_000,
      received_quantity: 100,
    },
  ],
  // AS DUAS ESPÉCIES NA MESMA LISTA — é o caso que a ficha tem de acertar sem
  // adivinhar: a compra digitada gerou dívida com origem 'entrada_manual', a
  // NF-e com 'nfe_entrada', e `doc_type` é o que o servidor manda para separar
  // uma da outra.
  inboundNotes: [
    {
      id: 'n-manual',
      access_key: 'manual:n-manual',
      number: 'EM-7',
      series: null,
      total_cents: 45_000,
      status: 'recebida',
      received_at: '2026-08-20T10:00:00.000Z',
      doc_type: 'manual',
    },
    {
      id: 'nota-4711',
      access_key: '35260814200166000187550010000047111000047118',
      number: '4711',
      series: '1',
      total_cents: 45_000,
      status: 'recebida',
      received_at: '2026-08-21T10:00:00.000Z',
      doc_type: 'nfe',
    },
  ],
};

const VENDAS = [
  {
    id: 'venda-12',
    number: 12,
    total_cents: 15_000,
    change_cents: 0,
    status: 'completed',
    created_at: '2026-08-19T14:00:00.000Z',
    customer_id: null,
  },
  {
    id: 'venda-13',
    number: 13,
    total_cents: 22_000,
    change_cents: 0,
    status: 'completed',
    created_at: '2026-08-19T15:00:00.000Z',
    customer_id: null,
  },
];

const DEVOLUCOES = [
  {
    id: 'dev-4',
    number: 4,
    sale_id: 'venda-12',
    sale_number: 12,
    reason: 'Peça errada',
    total_cents: 5_000,
    refund_method: 'dinheiro',
    created_at: '2026-08-21T10:00:00.000Z',
  },
  {
    id: 'dev-5',
    number: 5,
    sale_id: 'venda-13',
    sale_number: 13,
    reason: 'Arrependimento',
    total_cents: 3_000,
    refund_method: 'dinheiro',
    created_at: '2026-08-22T10:00:00.000Z',
  },
];

// ------------------------------------------------------------- o servidor

let pedidos: { url: string; metodo: string }[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function servidor() {
  fetchMock = vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push({ url: alvo, metodo });

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/finance/entries')) {
      // A VOLTA: quando a ficha pergunta pelos títulos de um documento, só os
      // dele voltam — é o recorte que o servidor faz e o dublê imita.
      const q = new URL(alvo, 'http://x').searchParams;
      const originId = q.get('originId');
      const originType = q.get('originType');
      // O par viaja junto e o servidor casa OS DOIS: uma nota tem uma espécie
      // só, então perguntar pela outra devolve vazio. O dublê imita isso — sem
      // ele, a ficha do pedido receberia o mesmo título duas vezes e a lista
      // renderizaria a mesma chave duas vezes.
      const itens = originId
        ? TITULOS_DA_CONTAS.filter((t) => t.originId === originId && t.originType === originType)
        : TITULOS_DA_CONTAS;
      return json({ items: itens, summary: originId ? null : RESUMO, aging: originId ? null : AGING });
    }
    if (alvo.includes('/core/finance/categories')) return json({ items: [] });
    if (alvo.includes('/core/finance/setup')) {
      return json({ categories: [], costCenters: [], accounts: [] });
    }
    if (alvo.includes('/core/purchases/notes/') && alvo.includes('/items')) {
      return json({ items: ITENS_DA_NOTA });
    }
    if (alvo.includes('/core/purchases/notes/') && alvo.includes('/repricing')) {
      return json({ suggestions: [] });
    }
    if (alvo.includes('/core/purchases/notes')) return json({ items: [NOTA, NOTA_FISCAL] });
    if (alvo.includes('/core/purchase-orders/')) return json(PEDIDO_DETALHE);
    if (alvo.includes('/core/purchase-orders')) return json({ items: [PEDIDO] });
    if (alvo.includes('/core/sale-returns')) return json({ items: DEVOLUCOES });
    if (alvo.includes('/core/sales')) return json({ items: VENDAS });
    return json({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function entrar(profileCode = 'gerente_loja') {
  setSession(
    {
      accessToken: 'token-do-escritorio',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste do deep-link da origem',
  );
}

function montar(rota: string, tela: React.ReactElement) {
  entrar();
  render(<MemoryRouter initialEntries={[rota]}>{tela}</MemoryRouter>);
}

/** As URLs que a tela pediu — é nelas que o parâmetro tem de aparecer. */
function urlsPedidas(): string[] {
  return pedidos.filter((p) => p.metodo === 'GET').map((p) => p.url);
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste do deep-link');
  localStorage.clear();
});

// ============================================================================
// 1. A IDA: o link carrega o documento
// ============================================================================

describe('ContasPage: o link da origem carrega o ID do documento', () => {
  it('a entrada manual VIRA LINK — a origem que o mapa não conhecia', async () => {
    montar('/sistema/financeiro/contas-a-pagar', <ContasPage />);
    await screen.findByText('Entrada manual EM-7');

    const tabela = within(screen.getByRole('table'));
    /*
      O defeito: `ORIGEM_LEGIVEL_SQL` ganhou o ramo de 'entrada_manual' e o
      rótulo passou a chegar na tela — mas sem destino no mapa, o rótulo
      aparecia como texto morto. A compra da feira ficava sem porta.
    */
    const link = tabela.getByRole('link', {
      name: 'Entrada manual EM-7 — Seu Zé das Embalagens',
    });
    expect(link.getAttribute('href')).toBe('/sistema/compras/entrada-notas?nota=n-manual');
  });

  it('cada origem leva ao SEU papel, e não só à tela dele', async () => {
    montar('/sistema/financeiro/contas-a-pagar', <ContasPage />);
    await screen.findByText('Entrada manual EM-7');
    const tabela = within(screen.getByRole('table'));

    const href = (nome: string | RegExp) =>
      tabela.getByRole('link', { name: nome }).getAttribute('href');

    expect(href('Venda #12')).toBe('/sistema/vendas?venda=venda-12');
    expect(href('Devolução #4 da venda #12')).toBe(
      '/sistema/vendas/devolucoes?devolucao=dev-4',
    );
    expect(href('Nota 4711 — Distribuidora Alfa')).toBe(
      '/sistema/compras/entrada-notas?nota=nota-4711',
    );
  });

  it('o lançamento avulso continua sem porta: nenhum link inventado', async () => {
    montar('/sistema/financeiro/contas-a-pagar', <ContasPage />);
    await screen.findByText('Aluguel');
    const tabela = within(screen.getByRole('table'));
    // Não há tela do lançamento avulso: link aqui seria porta desenhada que
    // não abre — o defeito que este projeto já documentou no botão de cancelar.
    expect(tabela.queryByRole('link', { name: /Aluguel/ })).toBeNull();
  });
});

// ============================================================================
// 2. A CHEGADA: a tela de destino abre o documento
// ============================================================================

describe('VendasPage: ?venda= recorta a venda pedida', () => {
  it('mostra só a venda do link, e diz que está recortada', async () => {
    montar('/sistema/vendas?venda=venda-12', <VendasPage />);

    await screen.findByText('#12');
    // A #13 existe na resposta e NÃO pode aparecer: chegar na lista inteira
    // com a venda perdida no meio é a meia-navegação que este arquivo fecha.
    expect(screen.queryByText('#13')).toBeNull();
    // E a tela DIZ que está recortada, com saída — recorte silencioso vira
    // "sumiram as vendas" para quem chegou aqui por outro caminho.
    expect(screen.getByText(/Mostrando só a venda/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ver todas as vendas/i })).toBeTruthy();
  });

  it('sem parâmetro, a lista inteira continua exatamente como era', async () => {
    montar('/sistema/vendas', <VendasPage />);
    await screen.findByText('#12');
    expect(screen.getByText('#13')).toBeTruthy();
    expect(screen.queryByText(/Mostrando só a venda/i)).toBeNull();
  });
});

describe('EntradaNotasPage: ?nota= abre a conferência daquela nota', () => {
  it('pede os itens da nota do link, sem ninguém clicar', async () => {
    montar('/sistema/compras/entrada-notas?nota=n-manual', <EntradaNotasPage />);

    await waitFor(() =>
      expect(
        urlsPedidas().some((u) => u.includes('/core/purchases/notes/n-manual/items')),
      ).toBe(true),
    );
    // E a conferência aparece na tela, com o item da nota.
    expect(await screen.findByText('Sacola kraft 30x40')).toBeTruthy();
  });

  it('sem parâmetro, nenhuma nota é aberta sozinha', async () => {
    montar('/sistema/compras/entrada-notas', <EntradaNotasPage />);
    await screen.findByText(/Notas importadas/);
    expect(urlsPedidas().some((u) => u.includes('/items'))).toBe(false);
  });
});

describe('PedidosCompraPage: ?pedido= abre o pedido', () => {
  it('pede o detalhe do pedido do link, sem ninguém clicar', async () => {
    montar('/sistema/compras/pedidos?pedido=pc-9', <PedidosCompraPage />);

    await waitFor(() =>
      expect(urlsPedidas().some((u) => u.includes('/core/purchase-orders/pc-9'))).toBe(true),
    );
    expect(await screen.findByText(/Pedido #9/)).toBeTruthy();
  });
});

describe('DevolucoesPage: ?devolucao= recorta a devolução pedida', () => {
  it('mostra só a devolução do link, e diz que está recortada', async () => {
    montar('/sistema/vendas/devolucoes?devolucao=dev-4', <DevolucoesPage />);

    await screen.findByText('Peça errada');
    expect(screen.queryByText('Arrependimento')).toBeNull();
    expect(screen.getByText(/Mostrando só a devolução/i)).toBeTruthy();
  });

  it('sem parâmetro, o histórico inteiro continua na tela', async () => {
    montar('/sistema/vendas/devolucoes', <DevolucoesPage />);
    await screen.findByText('Peça errada');
    expect(screen.getByText('Arrependimento')).toBeTruthy();
  });
});

// ============================================================================
// 3. A VOLTA: a ficha do documento mostra os títulos que ele gerou
// ============================================================================

describe('o bloco financeiro da NOTA de entrada', () => {
  it('pergunta pelos títulos DAQUELA nota e os lista', async () => {
    montar('/sistema/compras/entrada-notas?nota=n-manual', <EntradaNotasPage />);

    await waitFor(() => {
      const pedido = urlsPedidas().find((u) => u.includes('/core/finance/entries'));
      expect(pedido, 'a ficha da nota não perguntou pelos títulos dela').toBeTruthy();
      const q = new URL(pedido!, 'http://x').searchParams;
      // Os dois viajam JUNTOS: tipo sem id devolveria a empresa inteira.
      expect(q.get('originType')).toBe('entrada_manual');
      expect(q.get('originId')).toBe('n-manual');
    });

    // E o que ela cobra aparece: valor e vencimento, não só a existência.
    // (O valor aparece mais de uma vez de propósito: coluna "Valor", coluna
    // "Falta" e o total do bloco — a dívida inteira ainda em aberto.)
    expect((await screen.findAllByText(/R\$ 450,00/)).length).toBeGreaterThan(0);
    expect(screen.getByText('10/09/2026')).toBeTruthy();
  });

  it('a nota fiscal pergunta com a origem DELA — a espécie decide o tipo', async () => {
    montar('/sistema/compras/entrada-notas?nota=nota-4711', <EntradaNotasPage />);

    await waitFor(() => {
      const pedido = urlsPedidas().find((u) => u.includes('/core/finance/entries'));
      expect(pedido).toBeTruthy();
      const q = new URL(pedido!, 'http://x').searchParams;
      /*
        A nota com XML e a compra digitada moram na MESMA tabela e geram
        origens DIFERENTES ('nfe_entrada' × 'entrada_manual'). Perguntar
        sempre com a mesma devolveria lista vazia para metade das notas — um
        "nenhum título" indistinguível de "não gerou dívida".
      */
      expect(q.get('originType')).toBe('nfe_entrada');
      expect(q.get('originId')).toBe('nota-4711');
    });
  });
});

describe('o bloco financeiro do PEDIDO de compra', () => {
  it('pergunta pelos títulos das NOTAS do pedido — que é de onde a dívida nasce', async () => {
    montar('/sistema/compras/pedidos?pedido=pc-9', <PedidosCompraPage />);

    await waitFor(() => {
      const consultas = urlsPedidas()
        .filter((u) => u.includes('/core/finance/entries'))
        .map((u) => {
          const q = new URL(u, 'http://x').searchParams;
          return `${q.get('originType')}:${q.get('originId')}`;
        });
      /*
        O pedido de compra NÃO gera lançamento: quem gera é a nota que chega
        contra ele. Perguntar por `originType=purchase_order` devolveria vazio
        para sempre — bloco bonito que nunca mostra nada.

        E pergunta UMA VEZ POR NOTA, com a espécie que o servidor mandou.

        Antes eram duas perguntas por nota — uma por espécie —, porque
        `inboundNotes` não trazia `doc_type`: a ficha ficava com a união e
        descobria a espécie por eliminação. Barato, e uma SEGUNDA definição de
        "o que é entrada manual" morando na tela; no dia em que a régua do
        servidor mudasse, aqui continuaria a regra velha. Agora a espécie vem
        na resposta e `origemDaNota` — a MESMA função que a tela de Entrada de
        notas usa — a traduz num lugar só.
      */
      expect(consultas).toContain('entrada_manual:n-manual');
      expect(consultas).toContain('nfe_entrada:nota-4711');
      // E não pergunta pela espécie que a nota NÃO é: adivinhação a mais é
      // adivinhação, mesmo quando a resposta vem vazia.
      expect(consultas).not.toContain('nfe_entrada:n-manual');
      expect(consultas).not.toContain('entrada_manual:nota-4711');
      expect(consultas).toHaveLength(2);
    });

    expect((await screen.findAllByText(/R\$ 450,00/)).length).toBeGreaterThan(0);
  });

  it('a nota do pedido vira LINK para a ficha dela', async () => {
    montar('/sistema/compras/pedidos?pedido=pc-9', <PedidosCompraPage />);
    const link = await screen.findByRole('link', { name: /EM-7/ });
    expect(link.getAttribute('href')).toBe('/sistema/compras/entrada-notas?nota=n-manual');
  });
});
