/**
 * CARREGANDO, VAZIO E ERRO — CADA FETCH DA LOJA RESPONDE OS TRÊS — rodada 57.
 *
 * ## O defeito, mapeado
 *
 * A vitrine de produtos tinha os três estados desde a rodada 56 — e o padrão
 * parou nela. Os outros fetches da loja fundiam os três num só ou engoliam a
 * falha:
 *
 *  - `/loja/stores` falhando: home com "Nossas lojas" e NADA embaixo; na
 *    página da marca, a busca nunca monta e o herói nunca aparece — sem
 *    aviso, para sempre.
 *  - A cotação de frete do checkout falhando: o quadro "Como você quer
 *    receber" fica VAZIO no momento de maior intenção de compra.
 *  - O detalhe do pedido: o refresh automático de 15s falhava e a tela
 *    inteira — com o PIX copia-e-cola que o cliente estava usando — virava
 *    "Pedido não encontrado.", que é mentira.
 *  - Avaliações: "ainda não foi avaliado" cobria carregando, erro E vazio.
 *    Produto com vinte avaliações cinco estrelas mostrava a frase a cada
 *    abertura, e permanentemente quando a API falhava.
 *  - Meus pedidos e Meus aparelhos: o carregando era indistinguível do vazio
 *    — num 4G lento, o cliente lia "nenhum pedido" com os pedidos a caminho.
 *
 * A regra da rodada: quem busca dado responde às três perguntas — "ainda não
 * chegou", "chegou vazio" e "não deu" — e falha transitória de atualização
 * NUNCA derruba dado que já está na tela.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';
import ProdutoLojaPage from '../ProdutoLojaPage';
import MinhaContaPage, { MeuPedidoPage } from '../MinhaContaPage';
import MeusEquipamentosPage from '../MeusEquipamentosPage';
import { AvaliacoesProduto } from '@/components/gs/AvaliacoesProduto';

const PORTAL_KEY = 'gs.portal';

function sessao() {
  return {
    token: 'tok-portal-teste',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: '2026-08-01T00:00:00Z' },
  };
}

const PEDIDO = {
  id: 'ord-1',
  number: 1001,
  storeName: 'Gringa',
  createdAt: '2026-08-10T12:00:00.000Z',
  statusLabel: 'Aguardando pagamento',
  status: 'aguardando_pagamento',
  itemsCents: 20000,
  shippingCents: 0,
  totalCents: 20000,
  deliveryMethod: 'retirada',
  shippingZip: null,
  shippingAddress: null,
  trackingCode: null,
  customer: { name: 'Ana', email: 'ana@exemplo.com', document: '***.444.777-**' },
  items: [
    { description: 'Jaqueta', quantity: 2, unitPriceCents: 10000, totalCents: 20000, imageUrl: null },
  ],
  payments: [
    {
      method: 'pix',
      status: 'pending',
      statusLabel: 'Aguardando pagamento',
      amountCents: 20000,
      pixPayload: '00020126COPIA-E-COLA',
      invoiceUrl: null,
    },
  ],
  timeline: [
    { statusLabel: 'Aguardando pagamento', note: null, createdAt: '2026-08-10T12:00:00.000Z' },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Servidor por rota: cada teste declara só o que importa. */
function servidor(rotas: Record<string, () => Response | Promise<Response>>) {
  const chamadas: { url: string; method: string }[] = [];
  const fake = vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
    const alvo = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    chamadas.push({ url: alvo, method });
    for (const [padrao, responder] of Object.entries(rotas)) {
      const [m, caminho] = padrao.split(' ');
      if (m === method && alvo.includes(caminho)) return responder();
    }
    return json({ error: { message: 'rota não mockada' } }, 404);
  });
  vi.stubGlobal('fetch', fake);
  return { chamadas, fake };
}

/** Uma promessa que o teste resolve quando quiser — para ver o "carregando". */
function pendurada<T>() {
  let soltar!: (v: T) => void;
  const promessa = new Promise<T>((res) => {
    soltar = res;
  });
  return { promessa, soltar };
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

const PRODUTO_GRADE = {
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
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

// ============================================================================

describe('as lojas têm os três estados', () => {
  it('home: /loja/stores falhando mostra o erro com "Tentar de novo" — e o retry recarrega', async () => {
    let falhar = true;
    servidor({
      'GET /loja/stores': () =>
        falhar ? json({ error: { message: 'quebrou' } }, 500) : json({ stores: [LOJA], services: [] }),
      'GET /loja/products': () => json({ total: 0, items: [] }),
      'GET /loja/ofertas': () => json({ items: [] }),
      'GET /loja/destaques': () => json({ items: [] }),
      'GET /loja/categories': () => json({ items: [] }),
    });
    render(
      <MemoryRouter initialEntries={['/loja']}>
        <Routes>
          <Route path="/loja" element={<LojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Não foi possível carregar as lojas agora.');

    falhar = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar carregar as lojas de novo' }));
    await screen.findByText('Gringa');
  });

  it('página da marca: stores falhando avisa em vez de sumir com o herói para sempre', async () => {
    servidor({
      'GET /loja/stores': () => json({ error: { message: 'quebrou' } }, 500),
      'GET /loja/products': () => json({ total: 1, items: [PRODUTO_GRADE] }),
      'GET /loja/ofertas': () => json({ items: [] }),
      'GET /loja/destaques': () => json({ items: [] }),
      'GET /loja/categories': () => json({ items: [] }),
    });
    render(
      <MemoryRouter initialEntries={['/gringa']}>
        <Routes>
          <Route path="/:storeSlug" element={<LojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // O aviso aparece — e a vitrine de produtos, que vem de outro endpoint,
    // continua de pé embaixo dele.
    await screen.findByText('Não foi possível carregar as lojas agora.');
    await screen.findByText('Jaqueta Corta-Vento');
  });
});

// ============================================================================

describe('a cotação de frete do checkout não falha em silêncio', () => {
  it('falha vira aviso com "Tentar de novo" dentro do quadro de entrega', async () => {
    let falhar = true;
    servidor({
      'GET /loja/stores': () => json({ stores: [LOJA], services: [] }),
      'GET /loja/products': () => json({ total: 1, items: [PRODUTO_GRADE] }),
      'GET /loja/ofertas': () => json({ items: [] }),
      'GET /loja/destaques': () => json({ items: [] }),
      'GET /loja/categories': () => json({ items: [] }),
      'POST /loja/checkout/frete': () =>
        falhar
          ? json({ error: { message: 'quebrou' } }, 500)
          : json({
            // A cotação é POR LOJA: o carrinho de duas lojas cota duas.
            lojas: [
              {
                companyId: 'gringa',
                storeName: 'Gringa',
                itemsCents: 10_000,
                options: [
                  { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' },
                ],
                deliveryUnavailable: null,
              },
            ],
            deliveryUnavailable: null,
          }),
    });
    render(
      <MemoryRouter initialEntries={['/gringa']}>
        <Routes>
          <Route path="/:storeSlug" element={<LojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Jaqueta Corta-Vento');
    fireEvent.click(screen.getByLabelText('Adicionar Jaqueta Corta-Vento ao carrinho'));
    fireEvent.click(screen.getByRole('button', { name: /Carrinho \(1\)/ }));

    // Antes: o fieldset "Como você quer receber" ficava vazio, sem uma
    // palavra — o cliente com o cartão na mão olhando um quadro em branco.
    await screen.findByText('Não foi possível calcular as formas de entrega.');

    falhar = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar calcular de novo' }));
    await screen.findByText('Retirar na loja');
  });
});

// ============================================================================

describe('o detalhe do pedido protege o PIX que está na tela', () => {
  it('falha do refresh automático NÃO troca o pedido pela tela de erro', async () => {
    vi.useFakeTimers();
    let chamadas = 0;
    servidor({
      'GET /loja/portal/pedidos/ord-1': () => {
        chamadas += 1;
        // Primeira resposta boa; o refresh de 15s falha.
        return chamadas === 1 ? json(PEDIDO) : json({ error: { message: 'rede piscou' } }, 500);
      },
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-1']}>
        <Routes>
          <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // Deixa a primeira carga assentar.
    await vi.waitFor(() => {
      expect(screen.getByText(/Pedido #1001/)).toBeTruthy();
    });

    // O relógio anda 15s e o refresh falha.
    await vi.advanceTimersByTimeAsync(15_000);

    /*
      O PIX continua na tela — o cliente está com o app do banco aberto,
      voltando para copiar o código. A falha vira um aviso discreto, nunca
      "Pedido não encontrado." (que era o fallback… e era mentira).
    */
    await vi.waitFor(() => {
      expect(screen.getByText('Não foi possível atualizar agora. Tentando de novo…')).toBeTruthy();
    });
    expect(screen.getByText(/Pedido #1001/)).toBeTruthy();
    expect(screen.queryByText(/Pedido não encontrado/)).toBeNull();
  });

  it('a falha na PRIMEIRA carga diz "não deu para carregar", não "não encontrado"', async () => {
    servidor({
      'GET /loja/portal/pedidos/ord-1': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-1']}>
        <Routes>
          <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // Rede caída não é "pedido não existe": dizer que não existe faz o
    // cliente concluir que não deve pagar.
    await screen.findByText('Não foi possível carregar o pedido agora.');
    expect(screen.queryByText(/não encontrado/)).toBeNull();
  });
});

// ============================================================================

describe('avaliações distinguem carregando, erro e vazio', () => {
  function montar() {
    render(
      <MemoryRouter>
        <AvaliacoesProduto productId="p-1" />
      </MemoryRouter>,
    );
  }

  it('enquanto a resposta não chega, diz que está carregando — não "nunca avaliado"', async () => {
    const { promessa, soltar } = pendurada<Response>();
    servidor({ 'GET /avaliacoes': () => promessa });
    montar();
    await screen.findByText('Carregando avaliações…');
    // A frase de vazio é uma AFIRMAÇÃO sobre o produto. Antes de a resposta
    // chegar, afirmá-la é inventar.
    expect(screen.queryByText(/ainda não foi avaliado/)).toBeNull();

    soltar(json({ average: 4.5, count: 2, items: [] }));
    await screen.findByText(/2 avaliações de quem comprou/);
  });

  it('falha da API vira "não foi possível carregar", nunca "nunca avaliado"', async () => {
    servidor({ 'GET /avaliacoes': () => json({ error: { message: 'quebrou' } }, 500) });
    montar();
    await screen.findByText('Não foi possível carregar as avaliações agora.');
    expect(screen.queryByText(/ainda não foi avaliado/)).toBeNull();
  });

  it('vazio de verdade — resposta com zero — mantém a frase de sempre', async () => {
    servidor({ 'GET /avaliacoes': () => json({ average: null, count: 0, items: [] }) });
    montar();
    await screen.findByText('Este produto ainda não foi avaliado.');
  });
});

// ============================================================================

describe('o portal não confunde carregando com vazio', () => {
  it('meus pedidos: enquanto carrega, diz que carrega', async () => {
    const { promessa, soltar } = pendurada<Response>();
    servidor({ 'GET /loja/portal/pedidos': () => promessa });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Carregando seus pedidos…');
    expect(screen.queryByText('Nenhum pedido ainda')).toBeNull();

    soltar(json({ items: [] }));
    await screen.findByText('Nenhum pedido ainda');
  });

  it('meus aparelhos: o vazio só fala depois de a resposta chegar vazia', async () => {
    const { promessa, soltar } = pendurada<Response>();
    servidor({
      'GET /loja/portal/equipamentos': () => promessa,
      'GET /loja/portal/chamados': () => json({ items: [] }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/equipamentos']}>
        <Routes>
          <Route path="/minha-conta/equipamentos" element={<MeusEquipamentosPage />} />
        </Routes>
      </MemoryRouter>,
    );
    /*
      Antes: "Nenhum aparelho ligado a esta conta ainda… peça o código no
      balcão" aparecia DURANTE o carregamento — o dono da moto lia num 4G
      lento que não tem moto, e um segundo depois a moto chegava.
    */
    await screen.findByText('Carregando seus aparelhos…');
    expect(screen.queryByText(/Nenhum aparelho ligado/)).toBeNull();

    soltar(json({ items: [] }));
    await screen.findByText(/Nenhum aparelho ligado/);
  });

  it('meus aparelhos: em erro, o vazio não fala junto', async () => {
    servidor({
      'GET /loja/portal/equipamentos': () => json({ error: { message: 'quebrou' } }, 500),
      'GET /loja/portal/chamados': () => json({ items: [] }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/equipamentos']}>
        <Routes>
          <Route path="/minha-conta/equipamentos" element={<MeusEquipamentosPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // "Não foi possível carregar" e "nenhum aparelho" juntos se contradizem —
    // e o cliente não sabe em qual acreditar.
    await waitFor(() => {
      expect(screen.queryByText('Carregando seus aparelhos…')).toBeNull();
    });
    expect(screen.queryByText(/Nenhum aparelho ligado/)).toBeNull();
  });

  it('meus dados: a falha do perfil vira aviso com retry, não formulário sumido', async () => {
    let falhar = true;
    servidor({
      'GET /loja/portal/pedidos': () => json({ items: [] }),
      'GET /loja/portal/enderecos': () => json({ items: [] }),
      'GET /loja/portal/perfil': () =>
        falhar
          ? json({ error: { message: 'quebrou' } }, 500)
          : json({ email: 'ana@exemplo.com', name: 'Ana', phone: '53 99999-0000' }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    /*
      Antes o catch era vazio e o formulário "Meus dados" simplesmente não
      renderizava — quem veio corrigir o telefone não encontrava a tela e não
      tinha como saber que ela existe.
    */
    await screen.findByText('Não deu para carregar seus dados agora.');

    falhar = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar carregar meus dados de novo' }));
    await screen.findByText('Meus dados');
  });
});

// ============================================================================

describe('o erro do produto oferece a segunda chance', () => {
  it('falha transitória tem "Tentar de novo" — e ele funciona', async () => {
    let falhar = true;
    const DETALHE = {
      id: 'p-1',
      name: 'Jaqueta Corta-Vento',
      description: null,
      category: 'Vestuário',
      subcategory: null,
      brand: null,
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
    };
    servidor({
      'GET /loja/stores/gringa/products/p-1': () =>
        falhar ? Promise.reject(new TypeError('Failed to fetch')) : json(DETALHE),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /avaliacoes': () => json({ average: null, count: 0, items: [] }),
    });
    render(
      <MemoryRouter initialEntries={['/loja/gringa/produto/p-1']}>
        <Routes>
          <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const retry = await screen.findByRole('button', { name: 'Tentar de novo' });

    falhar = false;
    fireEvent.click(retry);
    await screen.findByText('Jaqueta Corta-Vento');
  });

  it('o caminho de volta leva à loja do produto, não à home do grupo', async () => {
    servidor({
      'GET /loja/stores/gringa/products/p-1': () => Promise.reject(new TypeError('x')),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
    });
    render(
      <MemoryRouter initialEntries={['/loja/gringa/produto/p-1']}>
        <Routes>
          <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const volta = await screen.findByText('Voltar para a loja');
    expect(volta.getAttribute('href')).toBe('/gringa');
  });
});
