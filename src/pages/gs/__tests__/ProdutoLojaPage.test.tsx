/**
 * Página pública de produto.
 *
 * O que não pode falhar: a página não promete entrega que a loja não consegue
 * fazer, e não deixa comprar mais do que existe. Sem peso e dimensões não há
 * cotação — inventar meio quilo vira um frete que o transportador não cobra,
 * e a diferença aparece depois da venda.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProdutoLojaPage from '../ProdutoLojaPage';

const BASE = {
  id: 'p-1',
  name: 'Jaqueta Corta-Vento',
  description: 'Descrição de vitrine',
  category: 'Acessórios',
  subcategory: 'Vestuário',
  brand: 'Marca X',
  unit: 'UN',
  imageUrl: null,
  images: [],
  basePriceCents: 32900,
  priceCents: 24675,
  onSale: true,
  available: 4,
  storeSlug: 'gringa',
  storeName: 'Gringa',
  variants: [],
  shippingReadiness: 'READY_FOR_SHIPPING' as const,
  missingShippingFields: [] as string[],
};

function servidor(produto: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(produto), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/loja/gringa/produto/p-1']}>
      <Routes>
        <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('conteúdo', () => {
  it('mostra loja, marca, categoria e o preço promocional', async () => {
    vi.stubGlobal('fetch', servidor(BASE));
    montar();

    await screen.findByRole('heading', { name: 'Jaqueta Corta-Vento' });
    expect(screen.getByText(/Marca X · Acessórios · Vestuário/)).toBeTruthy();
    expect(screen.getByText('R$ 246,75')).toBeTruthy();
    // O "de" continua visível: é a comparação que o cliente faz.
    expect(screen.getByText('R$ 329,00')).toBeTruthy();
  });

  it('produto de outra loja não existe nesta URL', async () => {
    vi.stubGlobal(
      'fetch',
      servidor({ error: { code: 'CORE_PRODUCT_NOT_FOUND', message: 'Produto não encontrado nesta loja.' } }, 404),
    );
    montar();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('não encontrado nesta loja'),
    );
  });
});

describe('entrega', () => {
  it('sem peso e dimensões, não promete entrega — e fala com o comprador, não com o dono', async () => {
    /*
      REVERSÃO da rodada 57: esta prova exigia "peso, altura" na tela PÚBLICA
      — o defeito escrito como intenção. O campo faltante é conversa do
      sistema com o DONO, e ela já acontece na Prontidão Online e no aviso do
      painel da loja. Quem compra não cadastra produto: para ele a informação
      é uma só — este item é retirada, por enquanto.
    */
    vi.stubGlobal(
      'fetch',
      servidor({
        ...BASE,
        shippingReadiness: 'SHIPPING_DATA_INCOMPLETE',
        missingShippingFields: ['peso', 'altura'],
      }),
    );
    montar();

    await waitFor(() =>
      expect(screen.getByText(/só retirada na loja, por enquanto/)).toBeTruthy(),
    );
    // O diagnóstico interno não vaza para a vitrine.
    expect(screen.queryByText(/peso/)).toBeNull();
    expect(screen.queryByText(/dados de embalagem/)).toBeNull();
    // Retirada continua valendo: o produto não fica invendável.
    expect(screen.getByText(/Retire sem custo/)).toBeTruthy();
  });

  it('com as medidas, oferece entrega e retirada', async () => {
    vi.stubGlobal('fetch', servidor(BASE));
    montar();

    await waitFor(() => expect(screen.getByText('Entrega e retirada disponíveis')).toBeTruthy());
  });
});

describe('estoque', () => {
  it('esgotado desabilita a compra', async () => {
    vi.stubGlobal('fetch', servidor({ ...BASE, available: 0 }));
    montar();

    await waitFor(() => expect(screen.getByText('ESGOTADO')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Esgotado' }).hasAttribute('disabled')).toBe(true);
  });

  it('a quantidade não passa do disponível', async () => {
    vi.stubGlobal('fetch', servidor(BASE));
    montar();

    const campo = (await screen.findByLabelText('Quantidade')) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '99' } });

    expect(campo.value).toBe('4');
  });
});

describe('grade', () => {
  const comGrade = {
    ...BASE,
    variants: [
      { id: 'v-p', name: 'Polo · P', barcode: '7890000000001', attributes: { tamanho: 'P' }, priceCents: 24675, available: 2 },
      { id: 'v-g', name: 'Polo · G', barcode: '7890000000002', attributes: { tamanho: 'G' }, priceCents: 24675, available: 0 },
    ],
  };

  it('exige escolher a opção antes de comprar', async () => {
    vi.stubGlobal('fetch', servidor(comGrade));
    montar();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Escolha uma opção' }).hasAttribute('disabled')).toBe(
        true,
      ),
    );
  });

  it('a opção escolhida define o estoque — o P não usa o saldo do G', async () => {
    vi.stubGlobal('fetch', servidor(comGrade));
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'P' }));

    expect(screen.getByText(/2 disponíveis/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Adicionar ao carrinho' })).toBeTruthy();
  });

  it('opção sem saldo não pode ser escolhida', async () => {
    vi.stubGlobal('fetch', servidor(comGrade));
    montar();

    const g = await screen.findByRole('button', { name: 'G (esgotado)' });
    expect(g.hasAttribute('disabled')).toBe(true);
  });
});

describe('carrinho', () => {
  it('grava no MESMO carrinho da vitrine, com a loja junto', async () => {
    vi.stubGlobal('fetch', servidor(BASE));
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar ao carrinho' }));

    const carrinho = JSON.parse(localStorage.getItem('gs.loja.carrinho')!) as {
      product: { id: string; storeSlug: string };
      quantity: number;
    }[];
    expect(carrinho).toHaveLength(1);
    // A loja precisa ir junto: é ela que agrupa o carrinho e divide o pedido.
    expect(carrinho[0].product.storeSlug).toBe('gringa');
    expect(carrinho[0].quantity).toBe(1);
  });

  it('a variante entra no carrinho como o item que sai do estoque', async () => {
    vi.stubGlobal(
      'fetch',
      servidor({
        ...BASE,
        variants: [
          { id: 'v-p', name: 'Polo · P', barcode: '789', attributes: { tamanho: 'P' }, priceCents: 24675, available: 3 },
        ],
      }),
    );
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'P' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar ao carrinho' }));

    const carrinho = JSON.parse(localStorage.getItem('gs.loja.carrinho')!) as {
      product: { id: string };
    }[];
    // O id é o da VARIANTE, não o do modelo: é dela que o saldo sai.
    expect(carrinho[0].product.id).toBe('v-p');
  });
});

/**
 * A cotação de frete, com o payload EXATO que a rota devolve.
 *
 * Estes testes existem por um defeito que passou por todos os gates: a tela
 * lia `priceCents` e `deliveryDays`, e o servidor manda `priceInCents` e
 * `estimatedDays`. O preço caía no fallback e o cliente lia FRETE R$ 0,00 —
 * frete grátis que não existe é cobrança surpresa depois da venda. Não
 * apareceu no navegador só porque nenhum produto tem medidas cadastradas
 * ainda, então a cotação nunca chegava a devolver opção.
 *
 * Por isso o payload aqui é copiado do contrato do adapter
 * (`LogisticsQuoteOptionResult`), e não escrito à mão no formato que a tela
 * gostaria de receber.
 */
describe('cotação de frete', () => {
  /** Responde o produto no GET e a cotação no POST. */
  function servidorComCotacao(cotacao: unknown) {
    return vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = metodo === 'POST' && String(url).includes('shipping-quote') ? cotacao : BASE;
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  async function cotar(cotacao: unknown) {
    vi.stubGlobal('fetch', servidorComCotacao(cotacao));
    montar();
    fireEvent.change(await screen.findByLabelText('CEP de entrega'), {
      target: { value: '01310-100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Calcular' }));
  }

  it('mostra o preço real e o prazo do transportador', async () => {
    await cotar({
      estimate: true,
      simulated: false,
      real: true,
      options: [
        {
          carrier: 'correios',
          serviceCode: 'SEDEX',
          serviceName: 'SEDEX',
          priceInCents: 3450,
          insuranceInCents: 246,
          estimatedDays: 3,
          simulated: false,
          real: true,
        },
      ],
    });

    await screen.findByText('SEDEX');
    // O defeito: isto vinha como R$ 0,00.
    expect(screen.getByText('R$ 34,50')).toBeTruthy();
    expect(screen.queryByText('R$ 0,00')).toBeNull();
    expect(screen.getByText(/3 dias úteis/)).toBeTruthy();
  });

  it('preço ausente vira "a confirmar", NUNCA R$ 0,00', async () => {
    // Opção sem preço não pode ser lida como frete grátis.
    await cotar({
      estimate: true,
      options: [{ carrier: 'jadlog', serviceName: 'Jadlog Package', estimatedDays: 5 }],
    });

    await screen.findByText('valor a confirmar');
    expect(screen.queryByText('R$ 0,00')).toBeNull();
  });

  it('simulação é dita como simulação', async () => {
    await cotar({
      estimate: true,
      simulated: true,
      real: false,
      options: [
        { carrier: 'correios', serviceName: 'PAC', priceInCents: 1800, estimatedDays: 8, simulated: true },
      ],
    });

    await screen.findByText('PAC');
    // Sem transportadora conectada, o número é chute do sistema — e a tela diz.
    expect(screen.getByText(/SIMULAÇÃO/)).toBeTruthy();
  });
});
