/**
 * ============================================================================
 * A VOLTA FECHA NAS CINCO FICHAS — as duas que faltavam (V04-FIN-016)
 * ============================================================================
 *
 * ## O DEFEITO MEDIDO
 *
 * A IDA — "título → documento" — está inteira: as CINCO origens com documento
 * (`sale`, `sale_return`, `nfe_entrada`, `entrada_manual`, `ecommerce_order`)
 * têm destino em `destinoDaOrigem`, com caso verde.
 *
 * A VOLTA — "documento → os títulos que ele gerou" — fechava em TRÊS:
 *
 *   sale ............. `OperacaoPages`, com `financeEntries` na própria ficha;
 *   nfe_entrada ...... `EntradaNotasPage`, por segunda consulta;
 *   entrada_manual ... a MESMA tela, pela mesma consulta com a outra origem.
 *
 * Faltavam duas, e as duas mexem em dinheiro:
 *
 *   sale_return ...... a devolução gera lançamento de origem 'sale_return' —
 *                      dinheiro SAINDO — e a ficha dela (`?devolucao=<id>`, o
 *                      recorte para onde o próprio contas a pagar navega) não
 *                      mostrava nenhum. Quem clicava em "Devolução #4 da venda
 *                      #12" no contas a pagar chegava na devolução e não via o
 *                      título que ela criou: para saber se o estorno já tinha
 *                      saído, saía da ficha e voltava ao financeiro procurar
 *                      pelo texto — o gesto que a rastreabilidade existe para
 *                      apagar.
 *   ecommerce_order .. o pedido da loja gera recebível e a ficha do pedido
 *                      (`?encomenda=<id>`, em `GestaoPages`) mostrava itens,
 *                      linha do tempo e nota fiscal — dinheiro nenhum.
 *
 * ## OS DOIS CAMINHOS, E POR QUE CADA FICHA ESCOLHEU O SEU
 *
 * O componente é o MESMO (`TitulosDoDocumento`) — ele não consulta nada, recebe
 * a lista pronta. O que muda é QUEM pergunta:
 *
 *   PEDIDO DA LOJA → na PRÓPRIA resposta do detalhe. A ficha já faz
 *   `GET /core/orders/:id` para existir; pendurar os títulos nessa resposta
 *   custa ZERO requisição a mais. É o precedente da venda.
 *
 *   DEVOLUÇÃO → por SEGUNDA consulta. A tela não abre detalhe nenhum: o
 *   recorte `?devolucao=` é feito sobre o histórico que já chegou. Pendurar os
 *   títulos em `GET /sale-returns/:id` obrigaria a tela a fazer uma chamada que
 *   ela não faz hoje, e a receber a devolução DUAS vezes (uma na lista, outra
 *   no detalhe) só para carregar o bloco financeiro de carona. É o precedente
 *   da nota de entrada.
 *
 * ## OS DOIS ESTADOS QUE NÃO PODEM SE PARECER
 *
 * "Não gerou título" e "não consegui perguntar" são fatos diferentes, e o
 * segundo lido como o primeiro afirma que o documento não cobra ninguém. Cada
 * ficha tem um caso para cada um.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';
import { PedidosPage } from '../GestaoPages';

// --------------------------------------------------------------- os dublês

const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: {
    aguardando_pagamento: 'Aguardando pagamento',
    pago: 'Pago',
    cancelado: 'Cancelado',
  },
};

const PEDIDO = {
  id: 'ord-9',
  number: 1009,
  customer_name: 'Ana Compradora',
  total_cents: 20_000,
  status: 'pago',
  tracking_code: null,
  shipping_method: 'retirada',
  created_at: '2026-08-10T12:00:00.000Z',
};

function tituloDoPedido(over: Record<string, unknown> = {}) {
  return {
    id: 'fin-ped-1',
    direction: 'in',
    description: 'Pedido online #1009',
    amountCents: 20_000,
    settledCents: 0,
    balanceCents: 20_000,
    status: 'open',
    dueDate: '2026-09-10',
    settledAt: null,
    overdue: false,
    counterpartyName: 'Ana Compradora',
    originType: 'ecommerce_order',
    originId: 'ord-9',
    originLabel: 'Pedido online #1009',
    installmentNumber: 1,
    installmentTotal: 1,
    categoryId: null,
    categoryName: null,
    costCenterId: null,
    costCenterName: null,
    cancelledAt: null,
    createdAt: '2026-08-10T12:00:00.000Z',
    ...over,
  };
}

/** O papel do pedido — com o bloco financeiro que ele passou a trazer. */
function pedidoDetalhe(over: Record<string, unknown> = {}) {
  return {
    ...PEDIDO,
    customer_email: 'ana@exemplo.com',
    shipping_address: 'Rua das Flores, 100',
    items: [
      {
        id: 'oi-1',
        product_id: 'p-1',
        description: 'Camiseta lisa P',
        quantity: 2,
        unit_price_cents: 10_000,
        total_cents: 20_000,
      },
    ],
    events: [],
    financeEntries: [tituloDoPedido()],
    ...over,
  };
}

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
    sale_id: 'venda-12',
    sale_number: 12,
    reason: 'Arrependimento',
    total_cents: 3_000,
    refund_method: 'dinheiro',
    created_at: '2026-08-22T10:00:00.000Z',
  },
];

const TITULO_DA_DEVOLUCAO = {
  ...tituloDoPedido(),
  id: 'fin-dev-1',
  direction: 'out',
  description: 'Devolução #4 da venda #12',
  amountCents: 5_000,
  balanceCents: 5_000,
  originType: 'sale_return',
  originId: 'dev-4',
  originLabel: 'Devolução #4 da venda #12',
  counterpartyName: null,
};

// ------------------------------------------------------------- o servidor

let pedidos: { url: string; metodo: string }[] = [];

interface Opcoes {
  /** O detalhe do pedido responde sem o bloco — servidor de outra versão. */
  pedidoSemBlocoFinanceiro?: boolean;
  /** O pedido não gerou título nenhum. */
  pedidoSemTitulo?: boolean;
  /** A consulta dos títulos falha — que NÃO é "não gerou título". */
  financeiroForaDoAr?: boolean;
  /** 200 com o corpo sem `items` — servidor de outra versão, ou proxy. */
  financeiroSemItems?: boolean;
}

function servidor(opcoes: Opcoes = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      pedidos.push({ url: alvo, metodo });

      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/nfe/readiness')) {
        return json({ canEmit: false, alreadyEmitted: false, reasons: ['Cliente sem CPF.'] });
      }
      if (/\/core\/orders\/[^/?]+$/.test(alvo)) {
        if (opcoes.pedidoSemBlocoFinanceiro) {
          const { financeEntries: _fora, ...semBloco } = pedidoDetalhe();
          return json(semBloco);
        }
        return json(pedidoDetalhe(opcoes.pedidoSemTitulo ? { financeEntries: [] } : {}));
      }
      if (alvo.includes('/core/orders')) {
        return json({ items: [PEDIDO], vocabulario: VOCABULARIO });
      }
      if (alvo.includes('/core/finance/entries')) {
        if (opcoes.financeiroForaDoAr) {
          return json(
            { error: { code: 'CORE_FORBIDDEN', message: 'Sem permissão para o financeiro.' } },
            403,
          );
        }
        if (opcoes.financeiroSemItems) return json({ summary: null, aging: null });
        const q = new URL(alvo, 'http://x').searchParams;
        const originId = q.get('originId');
        const originType = q.get('originType');
        const casa = originType === 'sale_return' && originId === 'dev-4';
        return json({
          items: casa ? [TITULO_DA_DEVOLUCAO] : [],
          summary: null,
          aging: null,
        });
      }
      if (alvo.includes('/core/customer-credits/liability')) {
        return json({ cents: 0, customers: 0 });
      }
      if (alvo.includes('/core/sale-returns')) return json({ items: DEVOLUCOES });
      if (alvo.includes('/core/sales')) return json({ items: VENDAS });
      return json({ items: [] });
    }),
  );
}

function entrar() {
  setSession(
    {
      accessToken: 'token-do-escritorio',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste da volta nas cinco fichas',
  );
}

function montar(rota: string, tela: React.ReactElement) {
  entrar();
  render(<MemoryRouter initialEntries={[rota]}>{tela}</MemoryRouter>);
}

function urlsPedidas(): string[] {
  return pedidos.filter((p) => p.metodo === 'GET').map((p) => p.url);
}

/** As consultas de título de um documento — o par originType+originId. */
function consultasDeTitulo(): string[] {
  return urlsPedidas().filter((u) => u.includes('/core/finance/entries') && u.includes('originId'));
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
  setSession(null, 'LOGOUT', 'fim do teste da volta');
  localStorage.clear();
});

// ============================================================================
// 4 de 5 — A DEVOLUÇÃO (sale_return)
// ============================================================================

describe('DevolucoesPage: a ficha da devolução mostra o que ela gerou no financeiro', () => {
  it('pergunta pelos títulos DAQUELA devolução — com a origem sale_return e o id do link', async () => {
    montar('/sistema/vendas/devolucoes?devolucao=dev-4', <DevolucoesPage />);

    await waitFor(() => expect(consultasDeTitulo().length).toBeGreaterThan(0));
    const consulta = consultasDeTitulo()[0];
    // O par viaja junto: tipo sem id devolveria os títulos de TODAS as
    // devoluções da empresa, e id sem tipo apostaria que UUIDs não colidem.
    expect(consulta).toContain('originType=sale_return');
    expect(consulta).toContain('originId=dev-4');
  });

  it('e o estorno aparece na ficha, com valor e situação', async () => {
    montar('/sistema/vendas/devolucoes?devolucao=dev-4', <DevolucoesPage />);

    expect(await screen.findByText('O que esta devolução gerou no financeiro')).toBeTruthy();
    expect(await screen.findByText('Devolução #4 da venda #12')).toBeTruthy();
    // R$ 50,00 — o valor do estorno, em centavos inteiros.
    expect(screen.getAllByText('R$ 50,00').length).toBeGreaterThan(0);
  });

  it('FALHA de consulta não vira "não gerou título" — são dois fatos diferentes', async () => {
    servidor({ financeiroForaDoAr: true });
    montar('/sistema/vendas/devolucoes?devolucao=dev-4', <DevolucoesPage />);

    /*
      Sem esta distinção, um 403 ou uma piscada de rede apareceria como
      "Nenhum título" e quem lesse concluiria que a devolução não devolveu
      dinheiro nenhum — a mentira mais cara que uma ficha de estorno conta.
    */
    const alerta = await screen.findByText(/Sem permissão para o financeiro|Falha ao consultar/);
    expect(alerta.getAttribute('role')).toBe('alert');
    expect(screen.queryByText('Nenhum título')).toBeNull();
  });

  it('200 SEM "items" também é falha declarada — e não derruba a tela', async () => {
    servidor({ financeiroSemItems: true });
    montar('/sistema/vendas/devolucoes?devolucao=dev-4', <DevolucoesPage />);

    /*
      Sem o guarda de contrato, `r.items` seria `undefined`, entraria no estado
      e o bloco chamaria `.length` sobre nada: a tela inteira cai em tela
      branca, longe da causa. Aqui a ausência vira o mesmo recado honesto da
      falha de rede — e o resto da tela continua de pé.
    */
    expect(await screen.findByText(/sem "items"|não entende/i)).toBeTruthy();
    expect(screen.queryByText('Nenhum título')).toBeNull();
    expect(await screen.findByText('Peça errada')).toBeTruthy();
  });

  it('sem recorte, nenhuma ficha está aberta: nada é perguntado ao financeiro', async () => {
    montar('/sistema/vendas/devolucoes', <DevolucoesPage />);
    await screen.findByText('Peça errada');

    // Sem documento na mesa não há origem pela qual perguntar — e perguntar
    // pela lista inteira seria uma consulta por linha do histórico.
    expect(consultasDeTitulo()).toHaveLength(0);
    expect(screen.queryByText('O que esta devolução gerou no financeiro')).toBeNull();
  });
});

// ============================================================================
// 5 de 5 — O PEDIDO DA LOJA (ecommerce_order)
// ============================================================================

describe('PedidosPage: a ficha do pedido da loja mostra o que ele gerou no financeiro', () => {
  it('o título vem NA PRÓPRIA resposta do detalhe — sem segunda ida ao servidor', async () => {
    montar('/sistema/pedidos?encomenda=ord-9', <PedidosPage />);

    expect(await screen.findByText('O que este pedido gerou no financeiro')).toBeTruthy();
    expect(await screen.findByText('Pedido online #1009')).toBeTruthy();

    /*
      A ficha já faz `GET /core/orders/:id` para existir. Perguntar de novo em
      `GET /finance/entries` seria uma segunda pergunta para uma resposta já na
      mão — com um estado de carregamento a mais e um 403 a mais, porque aquela
      rota não alcança todo perfil que abre Pedidos.
    */
    expect(consultasDeTitulo()).toHaveLength(0);
  });

  it('pedido sem título diz "não gerou", que é resposta legítima', async () => {
    servidor({ pedidoSemTitulo: true });
    montar('/sistema/pedidos?encomenda=ord-9', <PedidosPage />);

    // Pedido aguardando pagamento ainda não cobra ninguém: lista vazia é fato,
    // não falha.
    expect(await screen.findByText('Nenhum título')).toBeTruthy();
  });

  it('resposta SEM o bloco é falha declarada, não "não gerou título"', async () => {
    servidor({ pedidoSemBlocoFinanceiro: true });
    montar('/sistema/pedidos?encomenda=ord-9', <PedidosPage />);

    /*
      Servidor de versão anterior (ou proxy que cortou o corpo) não manda o
      campo. Desenhar "Nenhum título" aí diria que o pedido não cobra ninguém —
      a mesma armadilha que a ficha da venda já fecha.
    */
    expect(await screen.findByText(/financeEntries/)).toBeTruthy();
    expect(screen.queryByText('Nenhum título')).toBeNull();
  });

  it('sem parâmetro, nenhuma ficha e nenhum bloco financeiro', async () => {
    montar('/sistema/pedidos', <PedidosPage />);
    await screen.findByText('Ana Compradora');

    expect(screen.queryByText('O que este pedido gerou no financeiro')).toBeNull();
  });
});
