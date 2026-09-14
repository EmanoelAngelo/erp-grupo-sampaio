/**
 * A VITRINE DE CADA NEGÓCIO, PELA TELA — rodada 56.
 *
 * ## O que estava errado, medido antes de escrever uma linha
 *
 * Hoje, em produção, a diferença entre as cinco lojas do grupo é
 * EXCLUSIVAMENTE a paleta de cores. Mesma ordem de seções, mesma grade de
 * 2/3/4 colunas, mesmo card, mesmos filtros. Uma importadora de variedades e
 * uma loja de moda saem idênticas trocando o verde pelo azul.
 *
 * E há um defeito silencioso esperando: TODA imagem da vitrine usa o caminho
 * cru do banco. As fotos são servidas pela API, noutra porta, e o Vite não tem
 * proxy — então no dia em que o dono mandar o primeiro logo, ele aparece no
 * cadastro e quebra na loja. O helper que resolve isso existe desde sempre e
 * só as telas do ERP o usam.
 *
 * ## Por que a tela de verdade, com a rede dublada
 *
 * Um teste de servidor não alcança nada disto: o servidor passou a mandar o
 * tipo, a árvore e os selos, e ficaria verde com a tela ignorando os três —
 * que é exatamente a forma do defeito original.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';

interface LojaDublada {
  id: string;
  slug: string;
  tradeName: string;
  kind: string;
  productCount: number;
  headline: string | null;
  description: string | null;
  whatsapp: string | null;
  bannerText: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  storefrontPreset: string | null;
  seals: { id: string; label: string }[];
}

function lojaDublada(over: Partial<LojaDublada> = {}): LojaDublada {
  return {
    id: 'c-gringa',
    slug: 'gringa',
    tradeName: 'Gringa',
    kind: 'retail',
    productCount: 4,
    headline: null,
    description: null,
    whatsapp: null,
    bannerText: null,
    logoUrl: null,
    coverUrl: null,
    storefrontPreset: 'moda',
    seals: [
      { id: 'retirada', label: 'Retire na loja' },
      { id: 'troca', label: 'Troca em 7 dias' },
    ],
    ...over,
  };
}

function produto(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: 'Jaqueta Corta-Vento',
    brand: 'GRINGA',
    category: 'Vestuário',
    priceCents: 24675,
    basePriceCents: 32900,
    onSale: true,
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

let lojas: LojaDublada[];
let produtos: Record<string, unknown>[];
let ofertas: Record<string, unknown>[];
let departamentos: { name: string; productCount: number; children: { name: string; productCount: number }[] }[];
let pedidos: string[];

function servidor() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    pedidos.push(u);
    const responder = (corpo: unknown) =>
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (u.includes('/loja/stores')) return responder({ stores: lojas, services: [] });
    if (u.includes('/loja/ofertas')) return responder({ items: ofertas });
    if (u.includes('/loja/destaques')) return responder({ items: [] });
    if (u.includes('/loja/categories')) return responder({ items: departamentos });
    if (u.includes('/loja/products')) {
      const params = new URLSearchParams(u.split('?')[1] ?? '');
      const dep = params.get('category');
      const galho = params.get('subcategory');
      const itens = produtos.filter(
        (p) =>
          (!dep || p.category === dep)
          && (!galho || p.subcategory === galho),
      );
      return responder({ total: itens.length, items: itens });
    }
    return responder({});
  });
}

function montar(caminho: string) {
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
  lojas = [lojaDublada()];
  produtos = [produto()];
  ofertas = [];
  departamentos = [];
  pedidos = [];
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ============================================================================

describe('o tipo da loja arruma a página', () => {
  it('a vitrine declara o arranjo que está usando', async () => {
    montar('/gringa');
    // O arranjo é DADO no DOM, e não só classes soltas: é o que deixa medir
    // que a loja de moda não está saindo com a página da importadora.
    const vitrine = await screen.findByTestId('vitrine');
    expect(vitrine.getAttribute('data-arranjo')).toBe('moda');
  });

  it('a importadora põe a busca ANTES de tudo; a loja de moda, não', async () => {
    lojas = [lojaDublada({ slug: 'preco-justo', tradeName: 'Preço Justo', storefrontPreset: 'variedades' })];
    montar('/preco-justo');

    const vitrine = await screen.findByTestId('vitrine');
    expect(vitrine.getAttribute('data-arranjo')).toBe('variedades');
    /*
      Quem entra numa importadora sabe o que quer e PROCURA; quem entra numa
      loja de moda quer VER. Na loja de variedades a busca é a primeira coisa
      da página — antes do herói, antes dos departamentos.
    */
    const busca = screen.getByLabelText('Buscar produto');
    const heroi = screen.getByTestId('heroi-da-loja');
    expect(busca.compareDocumentPosition(heroi) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('na loja de moda o herói vem primeiro e a busca fica depois', async () => {
    montar('/gringa');
    const heroi = await screen.findByTestId('heroi-da-loja');
    const busca = screen.getByLabelText('Buscar produto');
    expect(heroi.compareDocumentPosition(busca) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('loja sem tipo declarado cai no neutro, e não numa página quebrada', async () => {
    lojas = [lojaDublada({ storefrontPreset: null })];
    montar('/gringa');
    const vitrine = await screen.findByTestId('vitrine');
    expect(vitrine.getAttribute('data-arranjo')).toBe('neutro');
    // A página continua inteira: é loja nova, não loja com defeito.
    expect(screen.getByLabelText('Buscar produto')).toBeTruthy();
  });
});

describe('o herói funciona VAZIO — é o estado real de todas as lojas hoje', () => {
  it('sem capa, sem chamada e sem descrição, o herói ainda diz que loja é essa', async () => {
    montar('/gringa');
    const heroi = await screen.findByTestId('heroi-da-loja');
    // Nenhuma das cinco lojas tem headline no banco. Um herói que só apareça
    // preenchido é um herói que ninguém nunca viu.
    expect(within(heroi).getByText('Gringa')).toBeTruthy();
    // E diz o negócio, que o sistema sabe pelo tipo — sem inventar promessa.
    expect(heroi.textContent).toMatch(/moda|vestuário/i);
  });

  it('com chamada escrita pelo gestor, é ELA que fala — não o texto padrão', async () => {
    lojas = [lojaDublada({ headline: 'Peças novas toda semana' })];
    montar('/gringa');
    const heroi = await screen.findByTestId('heroi-da-loja');
    expect(within(heroi).getByText('Peças novas toda semana')).toBeTruthy();
    expect(heroi.textContent).not.toMatch(/Moda e vestuário/);
  });
});

/**
 * O CAMPO QUE O GESTOR PREENCHIA PARA NINGUÉM.
 *
 * O painel diz, no próprio campo, "Aparece para o cliente falar com a loja" —
 * e nenhuma tela pública mostrava o WhatsApp. O dono digitava acreditando que
 * o cliente veria; o único leitor de verdade era o rodapé da ordem de serviço
 * impressa. Texto de tela que promete o que o sistema não faz é pior que
 * campo ausente: ele consome o tempo de quem preenche.
 */
describe('o WhatsApp chega ao cliente', () => {
  it('com número cadastrado, a loja oferece o caminho de falar com ela', async () => {
    lojas = [lojaDublada({ whatsapp: '53 99999-0000' })];
    montar('/gringa');

    const link = await screen.findByRole('link', { name: /WhatsApp/ });
    // Só o dígito vai para o link: o dono digita com espaço e traço, e o
    // wa.me não aceita nada além de número.
    expect(link.getAttribute('href')).toBe('https://wa.me/5553999990000');
  });

  it('sem número, sem botão — e não um link que não leva a lugar nenhum', async () => {
    montar('/gringa');
    await screen.findByTestId('heroi-da-loja');
    expect(screen.queryByRole('link', { name: /WhatsApp/ })).toBeNull();
  });
});

describe('os selos, e só os que o servidor mandou', () => {
  it('a loja mostra o que é verdade sobre comprar nela', async () => {
    montar('/gringa');
    const selos = await screen.findByTestId('selos-da-loja');
    expect(within(selos).getByText('Retire na loja')).toBeTruthy();
    expect(within(selos).getByText('Troca em 7 dias')).toBeTruthy();
  });

  it('a tela NÃO inventa selo: sem lista do servidor, sem faixa', async () => {
    lojas = [lojaDublada({ seals: [] })];
    montar('/gringa');
    await screen.findByTestId('heroi-da-loja');
    // Uma faixa vazia ocupa espaço e não diz nada — e um selo escrito na tela
    // seria promessa que o cadastro não sustenta.
    expect(screen.queryByTestId('selos-da-loja')).toBeNull();
  });
});

describe('os departamentos são navegáveis, e a árvore aparece', () => {
  beforeEach(() => {
    departamentos = [
      {
        name: 'Vestuário',
        productCount: 3,
        children: [
          { name: 'Camisas', productCount: 2 },
          { name: 'Calças', productCount: 1 },
        ],
      },
      { name: 'Calçados', productCount: 1, children: [] },
    ];
    produtos = [
      produto({ id: 'p-1', name: 'Camisa Polo', category: 'Vestuário', subcategory: 'Camisas' }),
      produto({ id: 'p-2', name: 'Calça Jeans', category: 'Vestuário', subcategory: 'Calças' }),
      produto({ id: 'p-3', name: 'Tênis Runner', category: 'Calçados', subcategory: null }),
    ];
  });

  it('o departamento mostra quantos itens tem, e abre os galhos ao ser escolhido', async () => {
    montar('/gringa');
    const nav = await screen.findByRole('navigation', { name: 'Departamentos' });
    // A contagem é o que faz o cliente decidir entrar: "Vestuário" sozinho não
    // diz se tem três peças ou trezentas.
    expect(within(nav).getByRole('button', { name: /Vestuário/ }).textContent).toContain('3');

    // Galho não aparece antes de o departamento ser escolhido: mostrar pai e
    // filha lado a lado, como irmãos, é o que a lista achatada fazia.
    expect(within(nav).queryByRole('button', { name: /Camisas/ })).toBeNull();

    fireEvent.click(within(nav).getByRole('button', { name: /Vestuário/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Camisas/ })).toBeTruthy();
    });
  });

  it('escolher o galho filtra pelo galho, não pelo departamento', async () => {
    montar('/gringa');
    const nav = await screen.findByRole('navigation', { name: 'Departamentos' });
    fireEvent.click(within(nav).getByRole('button', { name: /Vestuário/ }));
    await screen.findByRole('button', { name: /Camisas/ });
    fireEvent.click(screen.getByRole('button', { name: /Camisas/ }));

    await waitFor(() => {
      expect(pedidos.some((p) => p.includes('subcategory=Camisas'))).toBe(true);
    });
  });
});

describe('a imagem é servida pela API — e a vitrine precisa saber disso', () => {
  it('o logo da loja passa pelo resolvedor de origem', async () => {
    lojas = [lojaDublada({ logoUrl: '/uploads/lojas/logo.png' })];
    montar('/gringa');

    /*
      Pela tag, não pelo papel: o logo é decorativo desde a rodada 57
      (alt="" + aria-hidden — o NOME da loja está no <span> ao lado, dentro do
      mesmo link, e alt com o nome fazia o leitor anunciar a loja duas vezes).
      Imagem decorativa sai da árvore de acessibilidade, e é isso que se quer.
    */
    let logo: HTMLImageElement | undefined;
    await waitFor(() => {
      logo = [...document.querySelectorAll('img')].find((i) => i.src.includes('logo.png'));
      expect(logo, 'o logo deveria estar na tela').toBeTruthy();
    });
    logo = logo as HTMLImageElement;
    /*
      O caminho no banco é relativo à API, que roda noutra porta, e o Vite não
      tem proxy. `src="/uploads/..."` bate no Vite e dá 404 — a loja mostra
      moldura quebrada no dia em que o dono mandar o primeiro logo.
    */
    expect(logo.src).toMatch(/^https?:\/\/[^/]+\/uploads\/lojas\/logo\.png$/);
    expect(logo.getAttribute('src')).not.toBe('/uploads/lojas/logo.png');
  });

  it('a foto do produto no card também', async () => {
    produtos = [produto({ imageUrl: '/uploads/produtos/foto.png' })];
    montar('/gringa');

    const foto = (await screen.findAllByRole('img')).find((i) =>
      (i as HTMLImageElement).src.includes('foto.png'),
    ) as HTMLImageElement;
    expect(foto).toBeTruthy();
    expect(foto.getAttribute('src')).not.toBe('/uploads/produtos/foto.png');
  });
});

describe('o produto sem foto — que hoje é 100% da vitrine', () => {
  it('o card traz um lugar de foto com a cara da loja, não um cinza com "sem imagem"', async () => {
    montar('/gringa');
    const vazio = await screen.findByTestId('sem-foto-p-1');
    /*
      Zero dos produtos publicados do grupo tem foto. Então o placeholder NÃO é
      detalhe: é o que o cliente vê em toda a vitrine. Um retângulo cinza
      escrito "sem imagem" lê como defeito; o mesmo espaço com a inicial da
      loja e o nome da peça lê como foto que ainda vai chegar.
    */
    expect(vazio.textContent).toContain('Gringa');
    expect(vazio.textContent).not.toContain('sem imagem');
  });
});

describe('a promoção da loja aparece NA LOJA', () => {
  it('a página da marca mostra as ofertas dela', async () => {
    ofertas = [produto({ id: 'p-of', name: 'Jaqueta em oferta' })];
    montar('/gringa');
    /*
      A seção existia e era escondida na página da marca — só a home do grupo a
      desenhava. A Gringa tem produto em promoção no banco real e a vitrine
      dela não dizia em lugar nenhum.
    */
    const secao = await screen.findByRole('region', { name: 'Ofertas' });
    expect(within(secao).getByText('Jaqueta em oferta')).toBeTruthy();
  });

  it('sem oferta, sem seção — faixa vazia é promessa quebrada', async () => {
    montar('/gringa');
    await screen.findByTestId('heroi-da-loja');
    expect(screen.queryByRole('region', { name: 'Ofertas' })).toBeNull();
  });
});
