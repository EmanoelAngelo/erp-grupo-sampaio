/**
 * O QUE A REVISÃO ADVERSÁRIA DA RODADA 57 PEGOU.
 *
 * Cinco lentes sobre o diff do polimento, cada achado passado por um
 * refutador: 25 alegações, 5 derrubadas, 20 confirmadas — 15 defeitos
 * distintos depois de juntar o que duas lentes viram do mesmo jeito.
 *
 * Quase todos são da mesma família, e vale nomeá-la: ESTADO QUE SOBREVIVE AO
 * QUE O CRIOU. A foto escolhida por índice numa lista que encolhe. As
 * avaliações do produto anterior numa página que não desmonta. Os pedidos da
 * conta anterior no mesmo navegador. A ficha que o QR reabre depois de
 * fechada. O foco devolvido a um botão que já desmontou.
 *
 * O resto são promessas: o "Tentar de novo" que curava só a grade, o
 * "retire sem custo" numa loja que pode não ter retirada, o "Tentando de
 * novo…" eterno de uma sessão que venceu.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';
import ProdutoLojaPage from '../ProdutoLojaPage';
import MinhaContaPage, { MeuPedidoPage } from '../MinhaContaPage';
import MeusEquipamentosPage from '../MeusEquipamentosPage';

const PORTAL_KEY = 'gs.portal';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessao(token = 'tok-1', email = 'ana@exemplo.com') {
  return {
    token,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    account: { id: 'acc-1', email, emailVerifiedAt: '2026-08-01T00:00:00Z' },
  };
}

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
  return { chamadas };
}

function detalhe(over: Record<string, unknown> = {}) {
  return {
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
    pickupEnabled: true,
    related: [],
    ...over,
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

function montarProduto(id = 'p-1') {
  render(
    <MemoryRouter initialEntries={[`/loja/gringa/produto/${id}`]}>
      <Routes>
        <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function montarPedido() {
  render(
    <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-1']}>
      <Routes>
        <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

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

describe('a foto escolhida não desliza quando a lista encolhe', () => {
  it('miniatura que morre depois do clique não troca a foto grande', async () => {
    servidor({
      'GET /loja/stores/gringa/products/p-1': () =>
        json(
          detalhe({
            images: [
              { url: '/uploads/a.jpg', isPrimary: true },
              { url: '/uploads/b.jpg', isPrimary: false },
              { url: '/uploads/c.jpg', isPrimary: false },
            ],
          }),
        ),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /avaliacoes': () => json({ average: null, count: 0, items: [] }),
    });
    montarProduto();

    // O cliente escolhe a SEGUNDA foto.
    fireEvent.click(await screen.findByLabelText('Foto 2'));
    const grande = screen.getByAltText('Jaqueta Corta-Vento') as HTMLImageElement;
    expect(grande.src).toContain('b.jpg');

    /*
      A miniatura da PRIMEIRA falha depois (é lazy: chega tarde numa rede
      móvel). Com índice, a lista viraria [b,c], o índice 1 passaria a ser c
      e a tela trocaria sozinha a foto que o cliente escolheu.
    */
    const mini = [...document.querySelectorAll('img')].find((i) => i.src.includes('a.jpg'));
    fireEvent.error(mini!);

    await waitFor(() => {
      const agora = screen.getByAltText('Jaqueta Corta-Vento') as HTMLImageElement;
      expect(agora.src).toContain('b.jpg');
    });
  });
});

// ============================================================================

describe('a página do produto não carrega o produto anterior', () => {
  it('trocar de produto zera as avaliações do que ficou para trás', async () => {
    let quem = 'p-1';
    servidor({
      'GET /loja/stores/gringa/products/p-1': () =>
        json(detalhe({ related: [
          { id: 'p-2', name: 'Tênis', imageUrl: null, priceCents: 19900, onSale: false, storeName: 'Gringa', storeSlug: 'gringa' },
        ] })),
      'GET /loja/stores/gringa/products/p-2': () => json(detalhe({ id: 'p-2', name: 'Tênis' })),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /avaliacoes': () =>
        quem === 'p-1'
          ? json({
            average: 5,
            count: 3,
            items: [
              { id: 'av-1', rating: 5, comment: 'Ótima jaqueta', displayName: 'Ana', createdAt: '2026-08-01T00:00:00Z' },
            ],
          })
          // O produto novo demora: o teste não resolve nunca, para flagrar o
          // que fica na tela nesse intervalo.
          : new Promise<Response>(() => {}),
    });
    montarProduto();
    await screen.findByText('Ótima jaqueta');
    await screen.findByText(/3 avaliações de quem comprou/);

    quem = 'p-2';
    fireEvent.click(screen.getByText('Tênis'));

    /*
      A rota é a mesma — só o parâmetro muda — então a página não desmonta e a
      seção de avaliações ficava com a nota, a contagem e os comentários do
      produto ANTERIOR sob o nome e o preço do novo.
    */
    await waitFor(() => {
      expect(screen.queryByText('Ótima jaqueta')).toBeNull();
    });
    expect(screen.queryByText(/3 avaliações/)).toBeNull();
    screen.getByText('Carregando avaliações…');
  });
});

// ============================================================================

describe('o portal não mostra dado de outra conta', () => {
  it('sair e entrar com outra conta não deixa os pedidos da anterior na tela', async () => {
    let dono = 'ana';
    servidor({
      'GET /loja/portal/pedidos': () =>
        dono === 'ana'
          ? json({ items: [{ id: 'o-1', number: 1, storeName: 'Gringa', createdAt: '2026-08-01T00:00:00Z', totalCents: 1000, statusLabel: 'Pago', status: 'pago', deliveryMethod: 'retirada' }] })
          : new Promise<Response>(() => {}),
      'GET /loja/portal/enderecos': () => json({ items: [] }),
      'GET /loja/portal/perfil': () => json({ email: 'ana@exemplo.com', name: null, phone: null }),
      'POST /loja/portal/sair': () => json({ ok: true }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao('tok-ana')));
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Pedido #1');

    // Outra pessoa entra no MESMO navegador — o computador de casa, o balcão.
    dono = 'bruno';
    // Dois "Sair" na tela: o da casca (topo) e o da conta. O da conta é o
    // segundo, e é o que encerra a sessão no servidor.
    fireEvent.click(screen.getAllByRole('button', { name: 'Sair' })[1]);

    /*
      Sair já derruba a tela para o acesso; o que importa é que, quando a
      sessão nova monta a lista, o pedido da anterior não esteja lá — e
      enquanto a chamada da conta nova não volta (aqui ela nunca volta), a
      tela mostre "Carregando", nunca o dado de quem saiu.
    */
    await waitFor(() => {
      expect(screen.queryByText('Pedido #1')).toBeNull();
    });

    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao('tok-bruno', 'bruno@exemplo.com')));
    cleanup();
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Carregando seus pedidos…');
    expect(screen.queryByText('Pedido #1')).toBeNull();
  });
});

// ============================================================================

describe('o polling do PIX distingue rede piscando de sessão vencida', () => {
  it('401 no refresh diz que a sessão venceu, em vez de "tentando de novo" eterno', async () => {
    vi.useFakeTimers();
    let n = 0;
    servidor({
      'GET /loja/portal/pedidos/ord-1': () => {
        n += 1;
        return n === 1 ? json(PEDIDO) : json({ error: { message: 'sessão expirada' } }, 401);
      },
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    montarPedido();
    await vi.waitFor(() => {
      expect(screen.getByText(/Pedido #1001/)).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(15_000);

    /*
      A sessão do portal vence em uma hora e o cliente fica minutos nesta
      tela esperando o PIX cair. Tratar 401 como rede piscando deixava a
      página martelando um 401 a cada 15s, prometendo uma atualização que
      nunca vinha — e quem pagou nunca via o pedido virar "pago".
    */
    await vi.waitFor(() => {
      expect(screen.getByText(/Sua sessão venceu/)).toBeTruthy();
    });
    expect(screen.queryByText(/Tentando de novo/)).toBeNull();
  });

  it('5xx continua sendo transitório — o PIX fica na tela', async () => {
    vi.useFakeTimers();
    let n = 0;
    servidor({
      'GET /loja/portal/pedidos/ord-1': () => {
        n += 1;
        return n === 1 ? json(PEDIDO) : json({ error: { message: 'oops' } }, 500);
      },
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    montarPedido();
    await vi.waitFor(() => {
      expect(screen.getByText(/Pedido #1001/)).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await vi.waitFor(() => {
      expect(screen.getByText('Não foi possível atualizar agora. Tentando de novo…')).toBeTruthy();
    });
    expect(screen.getByText(/Pedido #1001/)).toBeTruthy();
  });
});

// ============================================================================

describe('o diálogo de cancelar segura o teclado e mostra o próprio erro', () => {
  function montarCancelavel(rotas: Record<string, () => Response | Promise<Response>> = {}) {
    servidor({
      'GET /loja/portal/pedidos/ord-1': () => json({ ...PEDIDO, payments: [] }),
      ...rotas,
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    montarPedido();
  }

  it('Tab vindo de FORA do diálogo é puxado para dentro', async () => {
    montarCancelavel();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    screen.getByRole('dialog');

    /*
      O trap antigo vivia no onKeyDown do container: só funcionava se o foco
      já estivesse dentro. Escapando uma vez — e escapava, porque o botão que
      abriu desmonta quando o pedido deixa de ser cancelável — o Tab passeava
      pela página atrás do véu, invisível.
    */
    document.body.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('o erro do cancelamento aparece DENTRO do diálogo, não atrás do véu', async () => {
    montarCancelavel({
      'POST /loja/portal/pedidos/ord-1/cancelar': () =>
        json({ error: { message: 'Este pedido já foi pago.' } }, 409),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, cancelar' }));

    // Falhar não fecha o diálogo — e a mensagem morava na seção de baixo,
    // coberta: o cliente via o botão voltar ao normal e mais nada.
    const dialogo = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialogo.textContent).toContain('Este pedido já foi pago.');
    });
  });
});

// ============================================================================

describe('as promessas dos botões e dos avisos', () => {
  it('"Tentar de novo" da vitrine recarrega também ofertas, destaques e departamentos', async () => {
    let falhar = true;
    const { chamadas } = servidor({
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /loja/products': () =>
        falhar ? json({ error: { message: 'x' } }, 500) : json({ total: 0, items: [] }),
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
    await screen.findByText('Não foi possível carregar a loja agora.');
    const antes = chamadas.filter((c) => c.url.includes('/loja/ofertas')).length;

    falhar = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    // As coleções somem em silêncio quando falham: um botão que cura só a
    // grade deixa a página pela metade sem dizer.
    await waitFor(() => {
      expect(chamadas.filter((c) => c.url.includes('/loja/ofertas')).length).toBeGreaterThan(antes);
    });
  });

  it('loja sem retirada não recebe a promessa de "retire sem custo"', async () => {
    servidor({
      'GET /loja/stores/gringa/products/p-1': () =>
        json(
          detalhe({
            shippingReadiness: 'SHIPPING_DATA_INCOMPLETE',
            missingShippingFields: ['peso'],
            pickupEnabled: false,
          }),
        ),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /avaliacoes': () => json({ average: null, count: 0, items: [] }),
    });
    montarProduto();

    /*
      "Retire sem custo — é só fechar o pedido escolhendo a retirada" era dito
      sem nunca perguntar se a loja FAZ retirada. É o mesmo `pickup_enabled`
      que decide o selo "Retire na loja": prometer no detalhe o que o selo não
      afirma é a tela garantindo o que o cadastro nega, e o cliente descobre
      no fim do checkout com o carrinho montado.
    */
    await screen.findByText(/Entrega indisponível para este produto/);
    expect(screen.queryByText(/Retire sem custo/)).toBeNull();
  });

  it('com retirada ligada, a promessa continua', async () => {
    servidor({
      'GET /loja/stores/gringa/products/p-1': () =>
        json(
          detalhe({
            shippingReadiness: 'SHIPPING_DATA_INCOMPLETE',
            missingShippingFields: ['peso'],
            pickupEnabled: true,
          }),
        ),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /avaliacoes': () => json({ average: null, count: 0, items: [] }),
    });
    montarProduto();
    await screen.findByText(/só retirada na loja, por enquanto/);
    screen.getByText(/Retire sem custo/);
  });
});

// ============================================================================

describe('a ficha aberta pelo QR abre uma vez só', () => {
  it('fechar e recarregar a lista não reabre a ficha sozinha', async () => {
    const EQUIP = {
      id: 'eq-1',
      publicIdLabel: '#0001',
      brand: 'Shineray',
      model: 'SHI',
      color: null,
      plate: null,
      serialNumber: null,
      companyName: 'PJ Motors',
      workshopName: null,
    };
    servidor({
      // A específica ANTES da genérica: o mock casa por `includes`, e
      // `/equipamentos` engoliria `/equipamentos/eq-1`.
      'GET /loja/portal/equipamentos/eq-1': () => json({ equipamento: EQUIP, ordens: [] }),
      'GET /loja/portal/equipamentos': () => json({ items: [EQUIP] }),
      'GET /loja/portal/chamados': () => json({ items: [] }),
      'POST /loja/portal/convite/resgatar': () => json({ customerName: 'Ana' }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/equipamentos?equipamento=%230001']}>
        <Routes>
          <Route path="/minha-conta/equipamentos" element={<MeusEquipamentosPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // A plaquinha abre a ficha sozinha — é o elo do QR.
    const fechar = await screen.findByRole('button', { name: 'fechar' });
    fireEvent.click(fechar);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'fechar' })).toBeNull();
    });

    /*
      O efeito depende da LISTA, que recarrega a cada ação. Sem consumir o
      alvo, qualquer mexida reabria a ficha que o cliente acabou de fechar.
    */
    fireEvent.change(screen.getByLabelText('Código da oficina'), {
      target: { value: 'ABCD234567' },
    });
    fireEvent.submit(screen.getByLabelText('Código da oficina').closest('form')!);

    await screen.findByText(/Pronto, Ana/);
    expect(screen.queryByRole('button', { name: 'fechar' })).toBeNull();
  });
});
