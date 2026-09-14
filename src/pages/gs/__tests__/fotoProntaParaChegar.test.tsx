/**
 * A LOJA PRONTA PARA AS FOTOS — rodada 57.
 *
 * ## O risco, mapeado antes de a primeira foto existir
 *
 * Hoje ZERO produtos têm foto, e o dono vai subir um lote em breve. O dia em
 * que as fotos chegarem não pode ser o dia em que a loja quebra:
 *
 *  - Nenhuma <img> da loja tinha onError: um arquivo apagado de uploads/, um
 *    nome errado no lote, uma restauração sem a pasta — e a moldura mostra o
 *    ícone de imagem quebrada do navegador na página onde o cliente decide a
 *    compra.
 *  - Nenhuma tinha loading="lazy", e o servidor serve o ORIGINAL sem
 *    redimensionar: a home carregaria de uma vez todos os originais da grade.
 *  - A foto grande do detalhe usava object-cover em moldura quadrada:
 *    roupa fotografada em retrato (o formato natural da Gringa e da
 *    Conceito) perdia a parte de cima e a de baixo.
 *  - A capa do herói não reservava altura: quando carregasse, empurraria
 *    título, WhatsApp e selos para baixo — layout pulando no primeiro dia de
 *    capas.
 *
 * O conserto tem um centro: `FotoDeProduto`, a MESMA moldura para a foto e
 * para o LugarDaFoto — se a imagem falha, o quadro volta sozinho para o
 * placeholder da marca, na mesma proporção, sem mexer na grade.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';
import ProdutoLojaPage from '../ProdutoLojaPage';
import { FotoDeProduto } from '@/components/gs/LugarDaFoto';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LOJA = {
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
};

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

let lojas: Record<string, unknown>[];
let produtos: Record<string, unknown>[];
let ofertas: Record<string, unknown>[];
let produtoDetalhe: Record<string, unknown> | null;

function servidor() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/loja/stores/') && u.includes('/products/') && produtoDetalhe) {
      return json(produtoDetalhe);
    }
    if (u.includes('/loja/stores')) return json({ stores: lojas, services: [] });
    if (u.includes('/loja/ofertas')) return json({ items: ofertas });
    if (u.includes('/loja/destaques')) return json({ items: [] });
    if (u.includes('/loja/categories')) return json({ items: [] });
    if (u.includes('/loja/products')) return json({ total: produtos.length, items: produtos });
    if (u.includes('/avaliacoes')) return json({ average: null, count: 0, items: [] });
    return json({});
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

beforeEach(() => {
  lojas = [LOJA];
  produtos = [produtoDaGrade()];
  ofertas = [];
  produtoDetalhe = null;
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ============================================================================

describe('FotoDeProduto: a moldura que sabe falhar', () => {
  it('com URL, monta a foto preguiçosa — a grade não baixa originais de uma vez', () => {
    render(
      <FotoDeProduto
        url="/uploads/produtos/jaqueta.jpg"
        alt="Jaqueta"
        loja="Gringa"
        proporcao="retrato"
        testId="foto-jaqueta"
      />,
    );
    const img = screen.getByAltText('Jaqueta');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('quando a imagem falha, o quadro volta ao LugarDaFoto — mesma proporção, sem buraco', () => {
    render(
      <FotoDeProduto
        url="/uploads/produtos/apagada.jpg"
        alt="Jaqueta"
        loja="Gringa"
        proporcao="retrato"
        testId="foto-jaqueta"
      />,
    );
    fireEvent.error(screen.getByAltText('Jaqueta'));
    // O ícone de imagem quebrada do navegador não é um estado da loja.
    expect(screen.queryByAltText('Jaqueta')).toBeNull();
    expect(screen.getByTestId('foto-jaqueta').className).toContain('aspect-[3/4]');
    screen.getByText('Foto em breve');
  });

  it('sem URL nenhuma, é o LugarDaFoto direto', () => {
    render(
      <FotoDeProduto url={null} alt="Jaqueta" loja="Gringa" testId="foto-jaqueta" />,
    );
    screen.getByText('Foto em breve');
  });

  it('a página do produto pede a peça INTEIRA: modo contain, carregada na hora', () => {
    render(
      <FotoDeProduto
        url="/uploads/produtos/jaqueta.jpg"
        alt="Jaqueta"
        loja="Gringa"
        modo="contain"
        eager
      />,
    );
    const img = screen.getByAltText('Jaqueta');
    // object-cover na moldura quadrada corta a roupa em retrato; a página de
    // decisão mostra a peça inteira.
    expect(img.className).toContain('object-contain');
    // …e a foto que o cliente veio ver não espera a preguiça.
    expect(img.getAttribute('loading')).not.toBe('lazy');
  });
});

// ============================================================================

describe('a grade usa a moldura em todo lugar', () => {
  it('card com foto: img preguiçosa; foto que falha vira placeholder no mesmo quadro', async () => {
    produtos = [produtoDaGrade({ imageUrl: '/uploads/produtos/jaqueta.jpg' })];
    montarVitrine('/gringa');
    const img = await screen.findByAltText('Jaqueta Corta-Vento');
    expect(img.getAttribute('loading')).toBe('lazy');

    fireEvent.error(img);
    await screen.findByTestId('sem-foto-p-1');
  });

  it('a oferta segue a proporção do negócio — retrato na moda, não quadrado fixo', async () => {
    ofertas = [
      produtoDaGrade({
        id: 'p-2',
        name: 'Tênis Importado',
        onSale: true,
        priceCents: 19900,
        basePriceCents: 24900,
      }),
    ];
    montarVitrine('/gringa');
    /*
      Medido na tela: a grade da Gringa saía em 3/4 e a OFERTA — o mesmo
      produto, uma seção acima — saía quadrada. Duas proporções para a mesma
      peça na mesma tela.
    */
    const lugar = await screen.findByTestId('sem-foto-p-2');
    expect(lugar.className).toContain('aspect-[3/4]');
  });
});

// ============================================================================

describe('o herói e os cards de loja aguentam capa', () => {
  it('a capa do herói tem altura reservada — nada pula quando ela chega', async () => {
    lojas = [{ ...LOJA, coverUrl: '/uploads/lojas/gringa-capa.jpg' }];
    montarVitrine('/gringa');
    const capa = await screen.findByAltText('Capa da Gringa');
    // Altura fixa por breakpoint: o espaço existe ANTES de a imagem carregar,
    // e todas as lojas saem com herói da mesma altura.
    expect(capa.className).toContain('h-40');
    expect(capa.className).toContain('object-cover');
  });

  it('na home, o card de loja sem capa mostra a inicial — não fica torto ao lado de quem tem', async () => {
    lojas = [
      { ...LOJA, coverUrl: '/uploads/lojas/gringa-capa.jpg' },
      {
        ...LOJA,
        id: 'c-conceito',
        slug: 'conceito',
        tradeName: 'Conceito',
        coverUrl: null,
      },
    ];
    montarVitrine('/loja');
    /*
      No dia em que o dono subir a capa de UMA loja, o grid estica os cards da
      linha à mesma altura — e o card sem capa ficava com o texto colado no
      topo e um vazio embaixo. O bloco tipográfico ocupa o mesmo espaço.
    */
    await screen.findByAltText('Capa da Gringa');
    const bloco = await screen.findByTestId('capa-tipografica-conceito');
    expect(bloco.textContent).toContain('C');
  });

  it('capa de card que falha cai no bloco tipográfico', async () => {
    lojas = [{ ...LOJA, coverUrl: '/uploads/lojas/apagada.jpg' }];
    montarVitrine('/loja');
    const capa = await screen.findByAltText('Capa da Gringa');
    fireEvent.error(capa);
    await screen.findByTestId('capa-tipografica-gringa');
  });
});

// ============================================================================

describe('a galeria do detalhe descarta a foto morta', () => {
  it('todas as fotos falhando, o quadro volta ao LugarDaFoto', async () => {
    produtoDetalhe = {
      id: 'p-1',
      name: 'Jaqueta Corta-Vento',
      description: null,
      category: 'Vestuário',
      subcategory: null,
      brand: null,
      unit: 'UN',
      imageUrl: null,
      images: [{ url: '/uploads/produtos/apagada.jpg', isPrimary: true }],
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
    };
    render(
      <MemoryRouter initialEntries={['/loja/gringa/produto/p-1']}>
        <Routes>
          <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const img = await screen.findByAltText('Jaqueta Corta-Vento');
    fireEvent.error(img);
    await screen.findByTestId('sem-foto-do-produto');
  });
});
