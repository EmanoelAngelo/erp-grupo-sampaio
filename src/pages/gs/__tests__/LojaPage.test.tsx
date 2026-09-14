/**
 * A loja pública, do carrinho ao PIX.
 *
 * Duas coisas não podem falhar aqui:
 *
 * 1. O carrinho precisa avisar que o checkout vai dividir o pedido por loja.
 *    Descobrir isso só depois de pagar, ao receber dois pedidos e duas
 *    cobranças, é o tipo de surpresa que vira chamado.
 * 2. MOSTRAR O QR NÃO É RECEBER. Um cliente que acha que já pagou some, e a
 *    mercadoria fica reservada esperando um dinheiro que não vem.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LojaPage from '../LojaPage';

const LOJAS = {
  stores: [
    { id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 1 },
    { id: 'c-mm', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail', productCount: 1 },
  ],
  services: [],
};

const PRODUTOS = {
  total: 2,
  items: [
    {
      id: 'p-gringa',
      name: 'Jaqueta Corta-Vento',
      description: null,
      category: null,
      brand: null,
      imageUrl: null,
      basePriceCents: 32900,
      priceCents: 24675,
      onSale: true,
      available: 5,
      storeSlug: 'gringa',
      storeName: 'Gringa',
    },
    {
      id: 'p-mimei',
      name: 'Kit Skincare Facial',
      description: null,
      category: null,
      brand: null,
      imageUrl: null,
      basePriceCents: 12900,
      priceCents: 12900,
      onSale: false,
      available: 9,
      storeSlug: 'me-mimei',
      storeName: 'Me Mimei',
    },
  ],
};

/**
 * A cotação de frete, UMA POR LOJA.
 *
 * O carrinho deste arquivo tem duas lojas de propósito, e é justamente o
 * caso que despachava a segunda de graça: o frete cotado ia inteiro para o
 * primeiro pedido e o segundo nascia com R$ 0,00. Cada loja cota a sua, e a
 * tela soma.
 */
/**
 * O que o servidor diz que cada item custa AGORA.
 *
 * Vazio por padrão: os casos que não falam de preço não precisam saber que
 * esta conferência existe. Quem quer testá-la preenche antes de montar.
 */
let itensRevalidados: {
  productId: string;
  companyId: string;
  name: string;
  quantity: number;
  priceCents: number;
  available: number;
}[] = [];

const FRETE_DAS_DUAS = {
  lojas: [
    {
      companyId: 'c-gr',
      storeName: 'Gringa',
      itemsCents: 24_675,
      options: [
        { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' },
      ],
      deliveryUnavailable: null,
    },
    {
      companyId: 'c-mm',
      storeName: 'Me Mimei',
      itemsCents: 12_900,
      options: [
        { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' },
      ],
      deliveryUnavailable: null,
    },
  ],
  deliveryUnavailable: null,
};

/** Respostas do backend, sem rede. O checkout devolve o que a API devolve. */
function servidor(checkout: unknown) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const corpo = u.includes('/loja/stores')
      ? LOJAS
      : u.includes('/loja/destaques') || u.includes('/loja/ofertas')
        ? { items: [] }
        : u.includes('/loja/categories')
          ? { items: [] }
          : u.includes('/loja/products')
            ? PRODUTOS
            : u.includes('/loja/checkout/frete')
              ? { ...FRETE_DAS_DUAS, itens: itensRevalidados }
              : checkout;
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  itensRevalidados = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function montarComDoisItens() {
  // A vitrine tem links para a página de produto: sem Router, nem monta.
  render(
    <MemoryRouter>
      <LojaPage />
    </MemoryRouter>,
  );
  await screen.findByText('Jaqueta Corta-Vento');

  for (const nome of ['Jaqueta Corta-Vento', 'Kit Skincare Facial']) {
    const card = screen.getByText(nome).closest('li')!;
    fireEvent.click(card.querySelector('button')!);
  }
  fireEvent.click(screen.getByRole('button', { name: /Carrinho/ }));
}

describe('carrinho com duas lojas', () => {
  it('agrupa por loja e avisa que serão dois pedidos', async () => {
    vi.stubGlobal('fetch', servidor({ orders: [], payments: [] }));

    await montarComDoisItens();

    expect(screen.getByRole('heading', { name: 'Gringa' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Me Mimei' })).toBeTruthy();
    // O aviso é o ponto: a divisão não pode ser descoberta depois de pagar.
    expect(screen.getByText(/dividido em/).textContent).toContain('2 pedidos');
  });

  it('exige CPF ou CNPJ — sem ele o provedor recusa a cobrança', async () => {
    vi.stubGlobal('fetch', servidor({ orders: [], payments: [] }));

    await montarComDoisItens();

    expect(screen.getByLabelText('CPF ou CNPJ').hasAttribute('required')).toBe(true);
  });

  /*
    GAP-PRD-191: sem e-mail o pedido nascia sem ter por onde avisar o
    comprador — e o servidor passou a recusar antes de reservar. A tela pede
    antes do clique, e mostra a recusa do servidor quando ela vem.
  */
  it('exige e-mail — é por ele que o pedido e o PIX chegam', async () => {
    vi.stubGlobal('fetch', servidor({ orders: [], payments: [] }));

    await montarComDoisItens();

    const email = screen.getByLabelText('E-mail') as HTMLInputElement;
    expect(email.hasAttribute('required')).toBe(true);
    expect(email.type).toBe('email');
  });

  it('a recusa do servidor (CPF com dígito errado) aparece com as palavras dele', async () => {
    const recusa = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/loja/checkout')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'CHECKOUT_VISITANTE_INCOMPLETO',
              message: 'Para fechar o pedido, informe: CPF ou CNPJ válido (os dígitos finais conferem).',
              details: { campos: ['documento'] },
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return servidor({})(url);
    });
    vi.stubGlobal('fetch', recusa);
    await montarComDoisItens();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '11122233344' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() => expect(screen.getByText(/os dígitos finais conferem/)).toBeTruthy());
    expect(screen.queryByText('Pague com PIX')).toBeNull();
  });
});

describe('depois do checkout', () => {
  const cobrancaPix = {
    orders: [{ id: 'o-1', number: 7, total_cents: 24675 }],
    payments: [
      {
        orderId: 'o-1',
        method: 'pix',
        status: 'pending',
        environment: 'sandbox',
        pixPayload: '00020126TESTE-COPIA-E-COLA',
        pixImageBase64: null,
        dueDate: '2026-12-31 23:59:59',
      },
    ],
  };

  it('mostra o copia-e-cola e diz que ainda está aguardando pagamento', async () => {
    vi.stubGlobal('fetch', servidor(cobrancaPix));
    await montarComDoisItens();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '11144477735' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() => expect(screen.getByText('Pague com PIX')).toBeTruthy());
    expect((screen.getByLabelText('PIX copia e cola') as HTMLTextAreaElement).value).toBe(
      '00020126TESTE-COPIA-E-COLA',
    );
    expect(screen.getByText('AGUARDANDO PAGAMENTO')).toBeTruthy();
    // Em nenhum lugar a tela diz que o pedido foi pago.
    expect(screen.queryByText(/^PAGO$/)).toBeNull();
  });

  it('sandbox é declarado — o cliente não é cobrado de verdade', async () => {
    vi.stubGlobal('fetch', servidor(cobrancaPix));
    await montarComDoisItens();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '11144477735' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() =>
      expect(screen.getByText(/ambiente de testes/)).toBeTruthy(),
    );
  });

  it('sem credencial na operação, não finge pagamento online', async () => {
    vi.stubGlobal(
      'fetch',
      servidor({
        orders: [{ id: 'o-2', number: 8, total_cents: 12900 }],
        payments: [{ orderId: 'o-2', status: 'unconfigured' }],
      }),
    );
    await montarComDoisItens();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '11144477735' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() =>
      expect(screen.getByText('Pagamento online indisponível nesta loja')).toBeTruthy(),
    );
    // O pedido existe e os itens estão reservados — isso continua verdade.
    expect(screen.getByText(/itens, reservados/)).toBeTruthy();
    expect(screen.queryByText('Pague com PIX')).toBeNull();
  });

  /*
    GAP-PRD-029: o boleto dizia "Válido até amanhã" e o pedido era cancelado
    25h depois, antes de o banco confirmar o boleto pago no vencimento. A tela
    diz até quando pagar e até quando os itens ficam reservados — as duas
    datas no dia da loja, cada uma com o nome certo.
  */
  it('boleto: diz até quando pagar e até quando os itens ficam reservados', async () => {
    vi.stubGlobal(
      'fetch',
      servidor({
        orders: [{ id: 'o-3', number: 9, total_cents: 24675 }],
        payments: [
          {
            orderId: 'o-3',
            method: 'boleto',
            status: 'pending',
            environment: 'sandbox',
            bankSlipUrl: 'https://sandbox.asaas.com/b/TEST_1',
            identificationField: '34191.79001 01043.510047 91020.150008 1 96610000010000',
            dueDate: '2026-09-12',
            reservedUntil: '2026-09-17T02:59:59.999Z',
          },
        ],
      }),
    );
    await montarComDoisItens();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '11144477735' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() => expect(screen.getByText('Pague o boleto')).toBeTruthy());
    expect(screen.getByText(/Pague até/).textContent).toContain('12/09/2026');
    // O instante 02:59Z do dia 17 é o fim do dia 16 na loja.
    expect(screen.getByText(/ficam reservados até/).textContent).toContain('16/09/2026');
    expect(screen.getByText(/34191\.79001/)).toBeTruthy();
    // Boleto não tem "código do PIX", nem "Válido até" sem dizer de quê.
    expect(screen.queryByText(/código do PIX/)).toBeNull();
    expect(screen.queryByText(/Válido até/)).toBeNull();
  });
});

describe('vitrine robusta (rodada 39)', () => {
  /** Servidor flexível: cada rota devolve o que o teste declarar. */
  function backend(rotas: {
    products?: unknown;
    destaques?: unknown;
    categories?: unknown;
  }) {
    return vi.fn(async (url: string) => {
      const u = String(url);
      const corpo = u.includes('/loja/stores')
        ? LOJAS
        : u.includes('/loja/ofertas')
          ? { items: [] }
          : u.includes('/loja/destaques')
            ? rotas.destaques ?? { items: [] }
          : u.includes('/loja/categories')
            ? rotas.categories ?? { items: [] }
            : u.includes('/loja/products')
              ? rotas.products ?? { total: 0, items: [] }
              : { orders: [] };
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('produto de grade mostra "a partir de" e não tem botão de + direto', async () => {
    vi.stubGlobal(
      'fetch',
      backend({
        products: {
          total: 1,
          items: [
            {
              id: 'mod-1',
              name: 'Camisa Polo',
              description: null,
              category: null,
              brand: null,
              imageUrl: null,
              basePriceCents: 8000,
              priceCents: 8000,
              onSale: false,
              available: 5,
              storeSlug: 'gringa',
              storeName: 'Gringa',
              hasVariants: true,
              fromPriceCents: 8000,
            },
          ],
        },
      }),
    );
    render(
      <MemoryRouter>
        <LojaPage />
      </MemoryRouter>,
    );
    await screen.findByText('Camisa Polo');
    expect(screen.getByText(/a partir de/i)).toBeTruthy();
    // Grade não entra direto no carrinho: sem o botão "+".
    expect(screen.queryByLabelText(/Adicionar Camisa Polo/)).toBeNull();
    // O botão leva à escolha.
    expect(screen.getByText('Escolher')).toBeTruthy();
  });

  it('a faixa de Destaques aparece quando há destaques', async () => {
    vi.stubGlobal(
      'fetch',
      backend({
        products: { total: 0, items: [] },
        destaques: {
          items: [
            {
              id: 'd-1',
              name: 'Tênis em Destaque',
              imageUrl: null,
              basePriceCents: 9000,
              priceCents: 9000,
              onSale: false,
              available: 3,
              storeSlug: 'gringa',
              storeName: 'Gringa',
            },
          ],
        },
      }),
    );
    render(
      <MemoryRouter>
        <LojaPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Destaques')).toBeTruthy();
    expect(screen.getByText('Tênis em Destaque')).toBeTruthy();
  });

  it('erro no servidor mostra "tentar de novo", não "nenhum produto"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/loja/stores')) {
          return new Response(JSON.stringify(LOJAS), { status: 200 });
        }
        if (u.includes('/loja/products')) {
          return new Response(JSON.stringify({ error: { message: 'caiu' } }), { status: 500 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );
    render(
      <MemoryRouter>
        <LojaPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/não foi possível carregar a loja/i)).toBeTruthy();
    expect(screen.getByText(/tentar de novo/i)).toBeTruthy();
    expect(screen.queryByText(/nenhum produto/i)).toBeNull();
  });

  it('busca sem resultado diz "nada encontrado", não o vazio da loja', async () => {
    vi.stubGlobal('fetch', backend({ products: { total: 0, items: [] } }));
    render(
      <MemoryRouter>
        <LojaPage />
      </MemoryRouter>,
    );
    // Sem busca: o vazio da LOJA, com a frase de cliente (frente PRODUTO: a
    // de administrador falava em "marcar para venda online no ERP").
    expect(await screen.findByText('Nenhum produto disponível no momento.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Buscar produto'), { target: { value: 'inexistente' } });
    expect(await screen.findByText(/nada encontrado/i)).toBeTruthy();
  });
})

// ============================================================================

/**
 * O CARRINHO CONGELADO NO NAVEGADOR.
 *
 * O carrinho guarda o produto inteiro no `localStorage` e nunca perguntava de
 * novo. A promoção termina, o preço de tabela volta, e quem deixou a aba
 * aberta desde ontem continua vendo R$ 246,75 — enquanto o `checkout`, que
 * reprecifica tudo pelo banco, emite o PIX por R$ 329,00.
 *
 * A cotação de frete roda a cada abertura desta gaveta e já pergunta o preço
 * ao banco. Agora ela devolve o número, e a tela o adota.
 */
describe('o carrinho não mostra preço de ontem', () => {
  it('adota o preço que o servidor acabou de dizer', async () => {
    itensRevalidados = [
      {
        productId: 'p-gringa',
        companyId: 'c-gr',
        name: 'Jaqueta Corta-Vento',
        quantity: 1,
        // A promoção acabou: voltou ao preço de tabela.
        priceCents: 32_900,
        available: 5,
      },
      {
        productId: 'p-mimei',
        companyId: 'c-mm',
        name: 'Kit Skincare Facial',
        quantity: 1,
        priceCents: 12_900,
        available: 9,
      },
    ];
    vi.stubGlobal('fetch', servidor(cobrancaPixParaCarrinho));
    await montarComDoisItens();

    // O preço da linha é o de agora, não o que o card mostrava.
    await waitFor(() =>
      expect(screen.getByText('1 × R$ 329,00')).toBeTruthy(),
    );
  });

  it('e DIZ que mudou — trocar em silêncio é o mesmo defeito', async () => {
    itensRevalidados = [
      {
        productId: 'p-gringa',
        companyId: 'c-gr',
        name: 'Jaqueta Corta-Vento',
        quantity: 1,
        priceCents: 32_900,
        available: 5,
      },
    ];
    vi.stubGlobal('fetch', servidor(cobrancaPixParaCarrinho));
    await montarComDoisItens();

    await waitFor(() =>
      expect(screen.getByText(/mudou desde que você/)).toBeTruthy(),
    );
  });

  it('preço igual não vira aviso — a maioria das visitas não mudou nada', async () => {
    itensRevalidados = [
      {
        productId: 'p-gringa',
        companyId: 'c-gr',
        name: 'Jaqueta Corta-Vento',
        quantity: 1,
        priceCents: 24_675,
        available: 5,
      },
    ];
    vi.stubGlobal('fetch', servidor(cobrancaPixParaCarrinho));
    await montarComDoisItens();

    await screen.findByText('Seu carrinho');
    expect(screen.queryByText(/mudou desde que você/)).toBeNull();
  });
});

/** Uma cobrança qualquer: estes casos param antes de finalizar. */
const cobrancaPixParaCarrinho = { orders: [], payments: [] };
