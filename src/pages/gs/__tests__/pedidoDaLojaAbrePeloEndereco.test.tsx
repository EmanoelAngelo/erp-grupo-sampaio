/**
 * ============================================================================
 * O PEDIDO DA LOJA ABRE PELO ENDEREÇO — a última porta desenhada que não abria
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * A rodada anterior fez cada origem de lançamento financeiro virar um endereço
 * que abre O DOCUMENTO: `?venda=`, `?nota=`, `?pedido=`, `?devolucao=`. Uma
 * origem ficou de fora: `ecommerce_order`. O título "Pedido #1009 — Ana
 * Compradora" navegava para `/sistema/pedidos` — a LISTA inteira, com o 1009
 * perdido entre duzentas linhas. Meia navegação: a pessoa chega na sala certa e
 * a gaveta continua fechada.
 *
 * Ficou de fora com razão registrada — `PedidosPage` mora em `GestaoPages.tsx`,
 * fora da posse daquela rodada, e escrever um parâmetro que ninguém lê seria a
 * porta desenhada que não abre. Este arquivo é a cobrança do fechamento: o
 * endereço carrega o pedido E a tela o abre.
 *
 * ## O NOME DO PARÂMETRO
 *
 * `?pedido=` JÁ É do pedido de COMPRA (`/sistema/compras/pedidos`). Dois papéis
 * diferentes disputando o mesmo nome é como duas telas passam a entender coisas
 * diferentes pela mesma palavra. O pedido da LOJA é `?encomenda=` — o
 * substantivo que a casa já usa para ele (`StorefrontService`: carrinho de duas
 * lojas vira "duas encomendas, de dois endereços, com dois pesos").
 *
 * ## O ESTADO HONESTO DO PEDIDO QUE NÃO EXISTE
 *
 * Link velho, id trocado a dedo, pedido de OUTRA empresa — o servidor responde
 * 404 nos três casos, e são casos reais. A tela não pode ficar "Abrindo…" para
 * sempre nem mostrar uma ficha vazia, que diria "este pedido não tem itens"
 * sobre um pedido que ela nunca leu.
 *
 * Todo caso olha o FIO: a URL que a tela pede, o endereço que ela escreve, o
 * recado que ela dá. Nenhum se contenta com "a tela renderizou".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import {
  PARAM_DO_PEDIDO_DE_COMPRA,
  destinoDaOrigem,
  rotaDoPedidoDeCompra,
} from '@/lib/rotasDeOrigem';
import ContasPage from '../ContasPage';
import { PedidosPage } from '../GestaoPages';

// --------------------------------------------------------------- os dublês

const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: {
    aguardando_pagamento: 'Aguardando pagamento',
    pago: 'Pago',
    separacao: 'Separação',
    conferencia: 'Conferência',
    embalado: 'Embalado',
    expedido: 'Expedido',
    pronto_para_retirada: 'Pronto para retirada',
    entregue: 'Entregue',
    cancelado: 'Cancelado',
    reembolsado: 'Reembolsado',
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

const OUTRO_PEDIDO = {
  ...PEDIDO,
  id: 'ord-10',
  number: 1010,
  customer_name: 'Bruno Comprador',
};

/** O documento: o pedido com os itens e a linha do tempo dele. */
const PEDIDO_DETALHE = {
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
  events: [
    { id: 'oe-1', status: 'aguardando_pagamento', note: null, created_at: '2026-08-10T12:00:00.000Z' },
    { id: 'oe-2', status: 'pago', note: 'Pix confirmado', created_at: '2026-08-10T12:30:00.000Z' },
  ],
};

function titulo(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    direction: 'in',
    description: 'Pedido #1009',
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
    originLabel: 'Pedido #1009 — Ana Compradora',
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

const RESUMO = { openCents: 20_000, overdueCents: 0, settledCents: 0, count: 1 };
const AGING = {
  notDueCents: 20_000,
  days1to30Cents: 0,
  days31to60Cents: 0,
  days61to90Cents: 0,
  over90Cents: 0,
};

// ------------------------------------------------------------- o servidor

let pedidos: { url: string; metodo: string }[] = [];

/**
 * O dublê responde como o servidor responde — inclusive o 404.
 *
 * `GET /core/orders/:id` confere `order.company_id !== companyId` e devolve
 * `CORE_ORDER_NOT_FOUND` tanto para o id que não existe quanto para o pedido de
 * OUTRA empresa: do lado de cá, os dois são o mesmo caso, e é de propósito —
 * dizer "existe, mas não é sua" já entrega que existe.
 */
function servidor(opcoes: { pedidoExiste?: boolean } = {}) {
  const existe = opcoes.pedidoExiste !== false;
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
        if (!existe) {
          return json(
            { error: { code: 'CORE_ORDER_NOT_FOUND', message: 'Pedido não encontrado.' } },
            404,
          );
        }
        return json(PEDIDO_DETALHE);
      }
      if (alvo.includes('/core/orders')) {
        return json({ items: [PEDIDO, OUTRO_PEDIDO], vocabulario: VOCABULARIO });
      }
      if (alvo.includes('/core/finance/entries')) {
        return json({ items: [titulo()], summary: RESUMO, aging: AGING });
      }
      if (alvo.includes('/core/finance/categories')) return json({ items: [] });
      if (alvo.includes('/core/finance/setup')) {
        return json({ categories: [], costCenters: [], accounts: [] });
      }
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
    'teste do endereço do pedido da loja',
  );
}

/** O endereço que a tela está mostrando AGORA — é nele que o parâmetro entra. */
function EnderecoAtual() {
  const { pathname, search } = useLocation();
  return <span data-testid="endereco">{`${pathname}${search}`}</span>;
}

function montar(rota: string, tela: React.ReactElement) {
  entrar();
  render(
    <MemoryRouter initialEntries={[rota]}>
      {tela}
      <EnderecoAtual />
    </MemoryRouter>,
  );
}

function urlsPedidas(): string[] {
  return pedidos.filter((p) => p.metodo === 'GET').map((p) => p.url);
}

/** Só o documento: `/nfe/readiness` também contém o id e não é a ficha. */
function leiturasDaFicha(id: string): string[] {
  return urlsPedidas().filter((u) => u.endsWith(`/core/orders/${id}`));
}

function endereco(): string {
  return screen.getByTestId('endereco').textContent ?? '';
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
  setSession(null, 'LOGOUT', 'fim do teste do endereço do pedido da loja');
  localStorage.clear();
});

// ============================================================================
// 1. O NOME DO PARÂMETRO — e a porta que ele abre
// ============================================================================

describe('rotasDeOrigem: o pedido da loja tem endereço próprio', () => {
  it('ecommerce_order leva ao PEDIDO, não só à tela dos pedidos', () => {
    /*
      O defeito: o destino era '/sistema/pedidos' cru. Quem clicava no título
      do título financeiro chegava na lista inteira e ainda tinha de achar o
      #1009 no meio dela — o gesto que o link prometeu evitar.
    */
    expect(destinoDaOrigem('ecommerce_order', 'ord-9')).toBe('/sistema/pedidos?encomenda=ord-9');
  });

  it('o nome não disputa com o pedido de COMPRA, que já é dono de `?pedido=`', () => {
    // Dois papéis diferentes com o mesmo nome de parâmetro é como duas telas
    // passam a entender coisas diferentes pela mesma palavra.
    expect(PARAM_DO_PEDIDO_DE_COMPRA).toBe('pedido');
    expect(destinoDaOrigem('ecommerce_order', 'x')).not.toContain('?pedido=');
    expect(rotaDoPedidoDeCompra('pc-9')).toBe('/sistema/compras/pedidos?pedido=pc-9');
  });

  it('o id viaja codificado — id não é texto de URL', () => {
    expect(destinoDaOrigem('ecommerce_order', 'a b&c')).toBe(
      '/sistema/pedidos?encomenda=a%20b%26c',
    );
  });

  it('a origem sem superfície continua sem porta', () => {
    expect(destinoDaOrigem('manual', 't-5')).toBeNull();
  });
});

describe('ContasPage: o título do pedido online vira link para o pedido', () => {
  it('o href carrega o id do pedido', async () => {
    montar('/sistema/financeiro/contas-a-receber', <ContasPage />);
    await screen.findByText('Pedido #1009');

    const link = screen.getByRole('link', { name: 'Pedido #1009 — Ana Compradora' });
    expect(link.getAttribute('href')).toBe('/sistema/pedidos?encomenda=ord-9');
  });
});

// ============================================================================
// 2. A CHEGADA: a tela abre o pedido do endereço
// ============================================================================

describe('PedidosPage: ?encomenda= abre a ficha do pedido', () => {
  it('pede o documento do link, sem ninguém clicar', async () => {
    montar('/sistema/pedidos?encomenda=ord-9', <PedidosPage />);

    await waitFor(() => expect(leiturasDaFicha('ord-9').length).toBeGreaterThan(0));
    // E a ficha aparece com o que o papel diz: o número e o item comprado.
    expect(await screen.findByText(/Pedido #1009/)).toBeTruthy();
    expect(await screen.findByText('Camiseta lisa P')).toBeTruthy();
  });

  it('sem parâmetro, nenhum pedido é aberto sozinho', async () => {
    montar('/sistema/pedidos', <PedidosPage />);
    await screen.findByText('Ana Compradora');

    // A lista carrega; nenhuma ficha é pedida. Abrir um pedido por conta
    // própria é escolher por quem chegou aqui para ver todos.
    expect(leiturasDaFicha('ord-9')).toHaveLength(0);
    expect(screen.queryByText('Camiseta lisa P')).toBeNull();
  });

  it('abrir pela lista ESCREVE o endereço — a URL descreve a tela', async () => {
    montar('/sistema/pedidos', <PedidosPage />);

    (await screen.findByRole('button', { name: '#1009' })).click();

    await waitFor(() => expect(endereco()).toBe('/sistema/pedidos?encomenda=ord-9'));
    expect(await screen.findByText('Camiseta lisa P')).toBeTruthy();
  });

  it('e o clique não lê o mesmo pedido duas vezes', async () => {
    montar('/sistema/pedidos', <PedidosPage />);

    (await screen.findByRole('button', { name: '#1009' })).click();
    await screen.findByText('Camiseta lisa P');
    await act(async () => {});

    /*
      Sem a marca de "este parâmetro já foi honrado", o clique abriria o pedido
      DUAS vezes: uma pelo próprio clique e outra pelo efeito, quando o
      parâmetro que o clique acabou de escrever chegasse. São dois GETs e um
      piscar de ficha vazia entre eles.
    */
    expect(leiturasDaFicha('ord-9')).toHaveLength(1);
  });

  it('o parâmetro FICA na URL: um F5 tem de mostrar o mesmo papel', async () => {
    montar('/sistema/pedidos?encomenda=ord-9', <PedidosPage />);
    await screen.findByText('Camiseta lisa P');

    // Ao contrário do `?documento=` do PDV, abrir um pedido não consome nada.
    expect(endereco()).toBe('/sistema/pedidos?encomenda=ord-9');
  });
});

// ============================================================================
// 3. O ESTADO HONESTO: o pedido que não existe (ou é de outra empresa)
// ============================================================================

describe('PedidosPage: o pedido que o link promete e o servidor nega', () => {
  it('diz o que houve — sem carregar para sempre e sem ficha vazia', async () => {
    servidor({ pedidoExiste: false });
    montar('/sistema/pedidos?encomenda=ord-fantasma', <PedidosPage />);

    // O recado do SERVIDOR, que é quem sabe: "não encontrado" cobre o id
    // inexistente e o pedido de outra empresa com a mesma frase, de propósito.
    expect(await screen.findByText(/Pedido não encontrado/)).toBeTruthy();

    // Nem "Abrindo…" eterno, nem ficha aberta em cima de nada: uma ficha vazia
    // diria "este pedido não tem itens" sobre um pedido que ninguém leu.
    await waitFor(() => expect(screen.queryByText(/Abrindo o pedido/)).toBeNull());
    expect(screen.queryByText(/Pedido #1009/)).toBeNull();

    // E a lista continua de pé: o link quebrado não derruba a tela inteira.
    expect(await screen.findByText('Ana Compradora')).toBeTruthy();
  });
});
