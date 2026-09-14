/**
 * ============================================================================
 * A PRÉ-VENDA PASSA A GASTAR O VALE — a recusa honesta sai de cena
 * ============================================================================
 *
 * O PDV sabia usar crédito de loja em venda direta e RECUSAVA na conversão de
 * documento, com uma frase que era honesta enquanto o servidor não sabia fazer:
 * "Pré-venda ainda não aceita crédito de loja". O operador tinha de fechar pelo
 * valor cheio e mandar o cliente voltar outro dia para gastar o próprio vale.
 *
 * Agora `POST /core/quotes/:id/convert` recebe `customerCreditCents` e o gasta
 * pelo MESMO `CustomerCreditService` da venda direta. A tela deixa de recusar e
 * passa a mandar o número.
 *
 * ## Como estes guardas falham (quebrando de propósito)
 *
 *   - devolva a recusa ao caminho de `loadedQuote` e o primeiro caso fica
 *     vermelho: nenhuma conversão sai, e o balcão volta a cobrar o valor cheio
 *     de quem tem vale;
 *   - pare de repassar `customerCreditCents` no corpo da conversão e o segundo
 *     caso acusa: a chamada sai, a venda fecha, e o vale continua no saldo do
 *     cliente — o desfecho que ninguém percebe até o cliente reclamar;
 *   - mande o crédito em toda conversão (mesmo sem o operador ter clicado) e o
 *     terceiro caso acusa: a conversão sem vale tem de sair limpa.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const VESTIDO = {
  id: 'p-vestido',
  internal_code: 'VD-0001',
  sku: null,
  barcode: '7890000003333',
  name: 'Vestido longo',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 8_000,
  price_cents: 20_000,
  effective_price_cents: 20_000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Quem devolveu uma peça de manhã e volta à tarde com a pré-venda aprovada. */
const MARTA = {
  id: 'c-marta',
  code: null,
  name: 'Marta Compradora',
  document: '39053344705',
  email: null,
  phone: null,
  address: null,
  notes: null,
  active: 1,
  price_table_id: null,
};

/** A pré-venda dela: uma peça de R$ 200,00, sem desconto de rodapé. */
const PRE_VENDA = {
  id: 'q-pre',
  number: 12,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: MARTA.id,
  seller_id: null,
  total_cents: 20_000,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

/** A mesma pré-venda de um cliente que nunca devolveu nada. */
const PRE_VENDA_SEM_VALE = { ...PRE_VENDA, id: 'q-pre-sem-vale', number: 13, customer_id: null };

/** Os corpos que a tela mandou para POST /core/quotes/:id/convert. */
let conversoes: { url: string; corpo: Record<string, unknown> }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/convert') && metodo === 'POST') {
      conversoes.push({ url: alvo, corpo: JSON.parse(String(init?.body ?? '{}')) });
      return json({ saleId: 'v-99', number: 99 }, 201);
    }
    const credito = alvo.match(/\/core\/customers\/([^/?]+)\/credits/);
    if (credito) {
      return json(
        credito[1] === MARTA.id
          ? {
              balance: 25_000,
              entries: [
                {
                  id: 'cc-1',
                  kind: 'grant',
                  amount_cents: 25_000,
                  origin_type: 'sale_return',
                  origin_id: 'dev-1',
                  description: 'Devolução #7 da venda #12',
                  return_number: 7,
                  sale_number: null,
                  created_at: '2026-08-20T14:00:00.000Z',
                },
              ],
            }
          : { balance: 0, entries: [] },
      );
    }
    const detalhe = alvo.match(/\/core\/quotes\/([^/?]+)$/);
    if (detalhe && metodo === 'GET') {
      const base = detalhe[1] === PRE_VENDA_SEM_VALE.id ? PRE_VENDA_SEM_VALE : PRE_VENDA;
      return json({
        ...base,
        expired: false,
        liberacao: null,
        items: [
          {
            id: 'i-1',
            product_id: VESTIDO.id,
            description: VESTIDO.name,
            quantity: 1,
            unit_price_cents: 20_000,
            total_cents: 20_000,
          },
        ],
      });
    }
    if (alvo.match(/\/core\/products\/p-vestido$/)) return json(VESTIDO);
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      return json({
        items: [
          {
            productId: VESTIDO.id,
            priceCents: VESTIDO.effective_price_cents,
            listPriceCents: VESTIDO.price_cents,
            onSale: false,
            fonte: 'cadastro',
          },
        ],
        priceTable: null,
      });
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/quotes')) {
      corpo = { items: [PRE_VENDA, PRE_VENDA_SEM_VALE] };
    } else if (alvo.includes(`/core/customers/${MARTA.id}`)) {
      // A pré-venda traz o cliente PELO ID (GAP-PRD-070), não da lista de 100.
      corpo = MARTA;
    } else if (alvo.includes('/core/customers')) {
      /*
        A Marta é a 101ª cliente: ela NÃO está na primeira página da lista sem
        termo. Era assim que a pré-venda dela carregava com o carrinho em
        "Consumidor final" enquanto o servidor faturava para ela (GAP-PRD-070).
      */
      corpo = { items: [], total: 101, limit: 100, offset: 0 };
    } else if (alvo.includes('/core/products/search')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open') || alvo.includes('/core/cash/current')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/sellers') || alvo.includes('/core/catalog/price-tables')) {
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
    return json(corpo);
  });
}

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
    'teste da pré-venda com vale',
  );
}

beforeEach(() => {
  conversoes = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirDocumento(id: string) {
  render(
    <MemoryRouter initialEntries={[`/pdv?documento=${id}`]}>
      <PdvPage />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getAllByText(/pré-venda #1[23]/i).length).toBeGreaterThan(0),
  );
  // A linha do carrinho só existe depois de o produto do documento chegar.
  await screen.findByRole('button', { name: /^Remover / });
}

async function abrirPagamento() {
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar (F10)' }));
  await screen.findByRole('dialog', { name: 'Pagamento' });
}

describe('o vale paga a pré-venda no balcão', () => {
  it('a conversão sai com o crédito no corpo, e a tela não recusa mais', async () => {
    await abrirDocumento(PRE_VENDA.id);
    await abrirPagamento();

    // O bloco do vale aparece porque o cliente veio DO DOCUMENTO — carregar a
    // pré-venda traz o cliente junto, e é o saldo dele que o diálogo lê.
    const bloco = await screen.findByTestId('pdv-credito-de-loja');
    expect(bloco.textContent).toContain('Marta Compradora');

    const usar = await screen.findByRole('button', { name: /Usar crédito/ });
    // O vale cobre no máximo o total: R$ 250,00 de saldo numa venda de R$ 200,00.
    expect(usar.textContent).toContain(formatCents(20_000));
    fireEvent.click(usar);
    await waitFor(() =>
      expect(screen.getByText('Falta receber').parentElement!.textContent).toContain(
        formatCents(0),
      ),
    );

    const dialogo = screen.getByRole('dialog', { name: 'Pagamento' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Finalizar (F10)' }));

    // A RECUSA SAIU DE CENA: antes, este clique parava aqui com "Pré-venda
    // ainda não aceita crédito de loja" e nenhuma requisição saía.
    await waitFor(() => expect(conversoes).toHaveLength(1));
    expect(conversoes[0].url).toContain(`/core/quotes/${PRE_VENDA.id}/convert`);
    expect(conversoes[0].corpo.customerCreditCents).toBe(20_000);
    // O vale fica FORA de `payments`: ali mora o que o cliente PAGOU, e aqui ele
    // cobrou uma dívida que a loja já tinha com ele.
    expect(conversoes[0].corpo.payments).toEqual([]);

    expect(screen.queryByText(/ainda não aceita crédito de loja/i)).toBeNull();
    await screen.findByText(/venda #99/);
  });

  it('conversão sem vale continua sem o campo — o crédito não vai de carona', async () => {
    await abrirDocumento(PRE_VENDA_SEM_VALE.id);
    await abrirPagamento();

    // Documento sem cliente: não há saldo de ninguém, e o bloco nem aparece.
    // Prometer o que a API recusa é o jeito mais rápido de ensinar alguém a
    // ignorar um botão.
    expect(screen.queryByTestId('pdv-credito-de-loja')).toBeNull();
    const dialogo = screen.getByRole('dialog', { name: 'Pagamento' });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pagamento' })).toBeNull());

    // O caminho rápido do balcão (F8) fecha em dinheiro pelo valor exato, e
    // passa pelo MESMO `finalize`: é ele que prova que o campo do crédito só
    // viaja quando alguém o pediu.
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await waitFor(() => expect(conversoes).toHaveLength(1));
    expect(conversoes[0].corpo.customerCreditCents).toBeUndefined();
    expect(conversoes[0].corpo.payments).toEqual([
      { method: 'dinheiro', amountCents: 20_000 },
    ]);
  });
});
