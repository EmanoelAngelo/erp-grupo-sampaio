/**
 * ============================================================================
 * A GAVETA SEM PROMESSA (GAP-V55) E A ESPERA QUE CRUZA TERMINAIS (GAP-V59)
 * ============================================================================
 *
 * ## V55 — o que o navegador NÃO faz
 *
 * O gap pedia comando de gaveta e impressão térmica silenciosa. O navegador
 * não abre gaveta e não imprime em silêncio: ele não expõe porta de impressora
 * a uma página, e o caminho de impressão passa pelo driver, que rasteriza —
 * bytes ESC/POS num HTML saem IMPRESSOS, não executados.
 *
 * A entrega, então, é a VERDADE na tela, vinda do servidor (que é quem sabe se
 * há agente local registrado), e a ausência de um botão que às vezes não faz
 * nada. Botão que engana uma vez é botão em que ninguém confia depois — e num
 * balcão isso custa o troco do cliente.
 *
 * ## V59 — a espera local continua local, e agora há caminho para a outra
 *
 * A espera do F7 vive no `localStorage`: não cruza terminais, e formatar a
 * máquina a perde. Em vez de inventar uma terceira ideia de "carrinho
 * guardado", o carrinho que precisa sobreviver ao terminal vira ORÇAMENTO — o
 * documento que já existe, cruza terminais, é retomado pelo F9 e NÃO reserva
 * mercadoria. A pré-venda seria a escolha errada: ela reserva.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const CAMISETA = {
  id: 'p-camiseta',
  internal_code: 'CM-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Camiseta',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 2000,
  price_cents: 5000,
  effective_price_cents: 5000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** A resposta de `/core/print/drawer` deste caso. */
let gaveta = {
  byCommand: false,
  agentPrinters: 0,
  message:
    'O navegador não abre a gaveta por comando, e nenhum agente local está registrado '
    + 'nesta operação. Hoje a gaveta abre pela chave ou pela opção "abrir gaveta ao imprimir" '
    + 'no driver da impressora térmica.',
  command: 'G3AZ+g==',
};

/** Corpos de todos os POST /core/quotes, na ordem. */
let orcamentos: Record<string, unknown>[] = [];
let vendas: Record<string, unknown>[] = [];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/quotes') && metodo === 'POST') {
      orcamentos.push(JSON.parse(String(init?.body ?? '{}')));
      return json({ id: 'q-1', number: 42, kind: 'orcamento', status: 'aberto' }, 201);
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      vendas.push(JSON.parse(String(init?.body ?? '{}')));
      return json(
        {
          id: 's-1',
          number: 1,
          total_cents: 5000,
          change_cents: 0,
          status: 'completed',
          created_at: '2026-08-10T12:00:00.000Z',
        },
        201,
      );
    }
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const pedido = JSON.parse(String(init?.body ?? '{}')) as { items?: { productId: string }[] };
      return json({
        items: (pedido.items ?? []).map(() => ({
          productId: CAMISETA.id,
          priceCents: CAMISETA.effective_price_cents,
          listPriceCents: CAMISETA.price_cents,
          onSale: false,
          fonte: 'cadastro',
        })),
        priceTable: null,
      });
    }
    if (alvo.includes('/core/print/drawer')) return json(gaveta);
    if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      return json({ items: [CAMISETA].filter((p) => p.barcode === q) });
    }
    if (alvo.includes('/core/sales/discount-policy')) {
      return json({ operatorLimitPercent: 10, canAuthorizeSelf: false });
    }
    if (alvo.includes('/core/cash/open')) {
      return json({ session: CAIXA_ABERTO, cashWithdrawalLimitCents: null });
    }
    if (alvo.includes('/core/fiscal/pdv-summary')) {
      return json({
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      });
    }
    return json({ items: [] });
  });
}

beforeEach(() => {
  orcamentos = [];
  vendas = [];
  gaveta = {
    byCommand: false,
    agentPrinters: 0,
    message:
      'O navegador não abre a gaveta por comando, e nenhum agente local está registrado '
      + 'nesta operação. Hoje a gaveta abre pela chave ou pela opção "abrir gaveta ao imprimir" '
      + 'no driver da impressora térmica.',
    command: 'G3AZ+g==',
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

async function bipar(codigo = '7890000001111') {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

describe('a gaveta não é prometida (GAP-V55)', () => {
  it('NÃO existe botão de abrir gaveta na tela', async () => {
    /*
      A ausência é a entrega. Enquanto o transporte for o navegador, nenhum
      clique abre gaveta — e um botão que às vezes não faz nada ensina o
      operador a desconfiar da tela inteira.
    */
    montar();
    await screen.findByText(/Aguardar \(F7\)/);
    expect(screen.queryByRole('button', { name: /gaveta/i })).toBeNull();
  });

  it('depois da venda, a tela diz o que a loja PODE fazer hoje', async () => {
    montar();
    await bipar();
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendas).toHaveLength(1));

    const aviso = await screen.findByTestId('pdv-gaveta-verdade');
    // A frase vem do SERVIDOR — a tela não tem uma segunda opinião sobre
    // hardware — e precisa levar a uma ação que funciona: a chave ou o driver.
    expect(aviso.textContent).toContain('chave');
    expect(aviso.textContent).toContain('driver');
  });

  it('com agente local registrado, a frase muda — sem inventar botão', async () => {
    gaveta = {
      byCommand: true,
      agentPrinters: 1,
      message:
        'Impressora de agente local registrada (1). O comando de gaveta e o cupom em ESC/POS '
        + 'ficam disponíveis para o agente na fila de impressão.',
      command: 'G3AZ+g==',
    };
    montar();
    await bipar();
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(vendas).toHaveLength(1));

    const aviso = await screen.findByTestId('pdv-gaveta-verdade');
    expect(aviso.textContent).toContain('agente local');
  });
});

describe('a espera que cruza terminais (GAP-V59)', () => {
  it('guardar no servidor cria um ORÇAMENTO com o carrinho', async () => {
    montar();
    await bipar();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar no servidor' }));
    await waitFor(() => expect(orcamentos).toHaveLength(1));

    /*
      ORÇAMENTO, e não pré-venda: a pré-venda RESERVA mercadoria, e segurar
      saldo por um carrinho parado tira peça da prateleira de quem está pronto
      para pagar — a mesma razão pela qual a espera local nunca reservou nada.
    */
    expect(orcamentos[0].kind).toBe('orcamento');
    const itens = orcamentos[0].items as { productId: string; quantity: number }[];
    expect(itens).toHaveLength(1);
    expect(itens[0].productId).toBe('p-camiseta');
  });

  it('o carrinho sai da tela e a mensagem diz como retomar', async () => {
    montar();
    await bipar();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar no servidor' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remover Camiseta' })).toBeNull());
    // A mensagem diz o NÚMERO e por onde se retoma — sem isso o operador
    // guarda o carrinho e não sabe onde procurá-lo depois.
    const aviso = await screen.findByText(/orçamento #42/);
    expect(aviso.textContent).toContain('F9');
    expect(aviso.textContent).toContain('sem reserva');
  });

  it('carrinho vazio não vira documento — recusa em vez de orçamento fantasma', async () => {
    montar();
    await screen.findByText(/Aguardar \(F7\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar no servidor' }));

    await waitFor(() => expect(screen.getByText('Não há itens para guardar.')).toBeTruthy());
    expect(orcamentos).toHaveLength(0);
  });

  it('o F7 continua LOCAL e instantâneo — não fala com o servidor', async () => {
    // Os dois convivem, e a diferença é o preço de cada um: o F7 é o cliente
    // que esqueceu a carteira no carro.
    montar();
    await bipar();
    fireEvent.click(screen.getByRole('button', { name: 'Aguardar (F7)' }));

    await waitFor(() => expect(screen.getByTestId('pdv-esperas')).toBeTruthy());
    expect(orcamentos).toHaveLength(0);
  });
});
