/**
 * AS PALAVRAS QUE O CLIENTE LÊ — rodada 57.
 *
 * ## O defeito, medido na tela contra o banco real
 *
 * A vitrine da Gringa dizia "2 disponível(is)". O detalhe do produto dizia
 * "2 disponível(is) · UN" — com o código de unidade CRU do cadastro na tela
 * pública. A home dizia "1 produto(s) online". A cotação de frete prometia
 * "até 3 dia(s) útil(eis)". E o aviso de entrega explicava ao COMPRADOR que
 * faltam "dados de embalagem (peso, altura, largura, comprimento)" — o
 * diagnóstico que pertence ao dono, na tela de prontidão do ERP, vazando para
 * quem só queria saber se o produto chega em casa.
 *
 * "(s)" é a loja dizendo que não teve tempo de decidir o plural. O cliente
 * decide em um segundo — e conclui o mesmo sobre o resto da loja.
 *
 * ## Duas reversões deliberadas
 *
 * 1. O teste antigo de ProdutoLojaPage EXIGIA que a página pública dissesse
 *    "peso, altura". Era o defeito escrito como intenção: o campo faltante é
 *    conversa entre o sistema e o dono (Prontidão Online já a faz). Aqui o
 *    cliente lê o que interessa a ele: retirada continua valendo.
 *
 * 2. O vazio da busca dizia "limpe os filtros" sem oferecer o botão — a tela
 *    mandando o cliente fazer o que ela mesma não oferece, que é a mesma
 *    família do hint do WhatsApp da rodada 56.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';
import ProdutoLojaPage from '../ProdutoLojaPage';

function loja(over: Record<string, unknown> = {}) {
  return {
    id: 'c-gringa',
    slug: 'gringa',
    tradeName: 'Gringa',
    kind: 'retail',
    productCount: 1,
    headline: null,
    description: null,
    whatsapp: null,
    bannerText: null,
    logoUrl: null,
    coverUrl: null,
    storefrontPreset: 'moda',
    seals: [],
    ...over,
  };
}

function produtoDaGrade(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: 'Jaqueta Corta-Vento',
    brand: 'GRINGA',
    category: 'Vestuário',
    priceCents: 24675,
    basePriceCents: 32900,
    onSale: false,
    available: 2,
    unit: 'UN',
    imageUrl: null,
    storeSlug: 'gringa',
    storeName: 'Gringa',
    hasVariants: false,
    featured: false,
    ...over,
  };
}

function detalhe(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: 'Jaqueta Corta-Vento',
    description: null,
    category: 'Vestuário',
    subcategory: null,
    brand: 'GRINGA',
    unit: 'UN',
    imageUrl: null,
    images: [],
    basePriceCents: 32900,
    priceCents: 24675,
    onSale: false,
    available: 2,
    storeSlug: 'gringa',
    storeName: 'Gringa',
    variants: [],
    shippingReadiness: 'READY_FOR_SHIPPING',
    missingShippingFields: [],
    related: [],
    ...over,
  };
}

let lojas: Record<string, unknown>[];
let produtos: Record<string, unknown>[];
let produtoDetalhe: Record<string, unknown>;
let cotacao: Record<string, unknown>;

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    const responder = (corpo: unknown) =>
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (u.includes('/shipping-quote')) return responder(cotacao);
    if (u.includes('/loja/stores/') && u.includes('/products/')) return responder(produtoDetalhe);
    if (u.includes('/loja/stores')) return responder({ stores: lojas, services: [] });
    if (u.includes('/loja/ofertas') || u.includes('/loja/destaques')) return responder({ items: [] });
    if (u.includes('/loja/categories')) return responder({ items: [] });
    if (u.includes('/loja/checkout/frete') && init?.method === 'POST') {
      /*
        A COTAÇÃO É POR LOJA desde que o carrinho de duas lojas parou de
        despachar a segunda de graça. `lojas` é a forma; `options` no topo
        continua saindo por compatibilidade, e a tela não a usa mais.
      */
      const opcoes = [
        {
          method: 'pac',
          label: 'PAC',
          priceCents: 2350,
          estimatedDays: 1,
          source: 'correios',
        },
      ];
      return responder({
        lojas: [
          {
            companyId: 'gringa',
            storeName: 'Gringa',
            itemsCents: 10_000,
            options: opcoes,
            deliveryUnavailable: null,
          },
        ],
        options: opcoes,
        deliveryUnavailable: null,
      });
    }
    if (u.includes('/loja/products')) {
      const params = new URLSearchParams(u.split('?')[1] ?? '');
      const q = (params.get('q') ?? '').toLowerCase();
      const itens = produtos.filter(
        (p) => !q || String(p.name).toLowerCase().includes(q),
      );
      return responder({ total: itens.length, items: itens });
    }
    if (u.includes('/avaliacoes')) return responder({ average: null, count: 0, items: [] });
    return responder({});
  });
}

function montarVitrine(caminho: string) {
  render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route path="/loja" element={<LojaPage />} />
        <Route path="/:storeSlug" element={<LojaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function montarDetalhe() {
  render(
    <MemoryRouter initialEntries={['/loja/gringa/produto/p-1']}>
      <Routes>
        <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  lojas = [loja()];
  produtos = [produtoDaGrade()];
  produtoDetalhe = detalhe();
  cotacao = { options: [], simulated: false };
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ============================================================================

describe('o plural é decidido pela loja, não pelo cliente', () => {
  it('a grade diz "2 disponíveis" e "1 disponível" — nunca "(is)"', async () => {
    produtos = [
      produtoDaGrade({ id: 'p-1', name: 'Jaqueta', available: 2 }),
      produtoDaGrade({ id: 'p-2', name: 'Tênis', available: 1 }),
    ];
    montarVitrine('/gringa');
    await screen.findByText('2 disponíveis');
    await screen.findByText('1 disponível');
    expect(screen.queryByText(/dispon[íi]vel\(is\)/)).toBeNull();
  });

  it('o card da loja na home diz "1 produto online", sem "(s)"', async () => {
    lojas = [loja({ productCount: 1 })];
    montarVitrine('/loja');
    await screen.findByText('1 produto online');
    expect(screen.queryByText(/produto\(s\)/)).toBeNull();
  });

  it('o detalhe diz "2 disponíveis" e esconde o código de unidade "UN"', async () => {
    montarDetalhe();
    await screen.findByText('2 disponíveis');
    // "UN" é vocabulário do cadastro. Unidade só aparece quando diz algo ao
    // cliente (kg, m…) — e "unidade" não diz.
    expect(screen.queryByText(/·\s*UN/)).toBeNull();
  });

  it('unidade que não é UN continua aparecendo — quilo importa para quem compra', async () => {
    produtoDetalhe = detalhe({ unit: 'KG', available: 3 });
    montarDetalhe();
    await screen.findByText(/3 disponíveis · KG/);
  });

  it('a simulação de frete promete "1 dia útil", não "1 dia(s) útil(eis)"', async () => {
    cotacao = {
      options: [{ carrier: 'Correios', serviceName: 'PAC', priceInCents: 2350, estimatedDays: 1 }],
      simulated: false,
    };
    montarDetalhe();
    fireEvent.change(await screen.findByLabelText('CEP de entrega'), {
      target: { value: '96010-000' },
    });
    fireEvent.click(screen.getByText('Calcular'));
    await screen.findByText(/1 dia útil após a expedição/);
    expect(screen.queryByText(/dia\(s\)/)).toBeNull();
  });
});

// ============================================================================

describe('o aviso de entrega fala com o comprador, não com o dono', () => {
  it('produto sem medidas: retirada afirmada, diagnóstico interno omitido', async () => {
    /*
      REVERSÃO DELIBERADA do teste anterior, que exigia "peso, altura" na tela
      pública. O campo faltante é conversa do sistema com o DONO — e ela já
      acontece, na Prontidão Online e no aviso do painel da loja. O comprador
      não cadastra produto: para ele, o que importa é que dá para retirar.
    */
    produtoDetalhe = detalhe({
      shippingReadiness: 'SHIPPING_DATA_INCOMPLETE',
      missingShippingFields: ['peso', 'altura', 'largura', 'comprimento'],
    });
    montarDetalhe();
    await screen.findByText(/retirada na loja/i);
    expect(screen.queryByText(/peso/)).toBeNull();
    expect(screen.queryByText(/dados de embalagem/)).toBeNull();
  });
});

// ============================================================================

describe('o vazio oferece a saída que anuncia', () => {
  it('busca sem resultado tem o botão que limpa a busca e os filtros', async () => {
    montarVitrine('/gringa');
    await screen.findByText('Jaqueta Corta-Vento');

    fireEvent.change(screen.getByLabelText('Buscar produto'), {
      target: { value: 'coisa-que-nao-existe' },
    });
    await screen.findByText('Nada encontrado com esses filtros');

    // A frase manda limpar; o botão faz. Sem ele, a tela manda o cliente
    // caçar o campo lá em cima e apagar na mão.
    fireEvent.click(screen.getByRole('button', { name: 'Limpar a busca e os filtros' }));
    await screen.findByText('Jaqueta Corta-Vento');
    expect((screen.getByLabelText('Buscar produto') as HTMLInputElement).value).toBe('');
  });
});

// ============================================================================

describe('"Ver carrinho" leva ao carrinho — na loja em que o cliente está', () => {
  it('o aviso do detalhe aponta para a página da loja com o carrinho aberto', async () => {
    montarDetalhe();
    fireEvent.click(await screen.findByText('Adicionar ao carrinho'));
    const link = await screen.findByText('Ver carrinho');
    /*
      Antes apontava para /loja — a home do GRUPO, com outra paleta, o
      carrinho fechado e a Gringa para trás. Dois saltos de contexto para ver
      o que acabou de guardar.
    */
    expect(link.getAttribute('href')).toBe('/gringa?carrinho=1');
  });

  it('?carrinho=1 abre a seção do carrinho ao chegar', async () => {
    montarVitrine('/gringa?carrinho=1');
    await screen.findByText('Seu carrinho');
  });
});

// ============================================================================

describe('o prazo do checkout também fala plural', () => {
  it('"até 1 dia útil após a postagem" na opção de entrega', async () => {
    montarVitrine('/gringa');
    await screen.findByText('Jaqueta Corta-Vento');
    // Põe no carrinho e abre: a cotação dublada responde 1 dia.
    fireEvent.click(screen.getByLabelText('Adicionar Jaqueta Corta-Vento ao carrinho'));
    fireEvent.click(screen.getByRole('button', { name: /Carrinho \(1\)/ }));
    await screen.findByText(/até 1 dia útil após a postagem/);
    expect(screen.queryByText(/útil\(eis\)/)).toBeNull();
  });
});
