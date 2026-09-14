/**
 * A LOJA OPERÁVEL SEM MOUSE — rodada 57.
 *
 * ## O que a lente de teclado achou
 *
 * A base estava certa — quase todo clicável é <button>/<Link> de verdade e o
 * foco visível é regra global do tokens.css. Os buracos eram de
 * COMPORTAMENTO:
 *
 *  - O diálogo de cancelar pedido (a decisão sem volta da conta) não movia o
 *    foco para dentro, não fechava com Escape e não devolvia o foco ao botão
 *    que o abriu. Teclado entrava no diálogo… por acaso, ou nunca.
 *  - Três pares input+botão viviam em <div>: CEP da simulação de frete,
 *    código de confirmação do e-mail, código do balcão da oficina. Digitar e
 *    apertar Enter — o gesto universal — não fazia NADA.
 *  - As estrelas da avaliação eram um <span> com aria-label, que leitor de
 *    tela ignora em elemento genérico: a nota saía como "estrela preta
 *    estrela preta estrela preta…", cinco vezes por avaliação.
 *  - O botão do carrinho abre e fecha uma seção e não declarava
 *    aria-expanded: para o leitor de tela, um botão que não diz o que fez.
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

function sessao(emailVerificado = true) {
  return {
    token: 'tok-portal-teste',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    account: {
      id: 'acc-1',
      email: 'ana@exemplo.com',
      emailVerifiedAt: emailVerificado ? '2026-08-01T00:00:00Z' : null,
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

const PEDIDO_CANCELAVEL = {
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
  payments: [],
  timeline: [
    { statusLabel: 'Aguardando pagamento', note: null, createdAt: '2026-08-10T12:00:00.000Z' },
  ],
};

const DETALHE_COM_FRETE = {
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ============================================================================

describe('o diálogo de cancelar pedido respeita o teclado', () => {
  function montar() {
    servidor({
      'GET /loja/portal/pedidos/ord-1': () => json(PEDIDO_CANCELAVEL),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-1']}>
        <Routes>
          <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('ao abrir, o foco entra no diálogo — no botão que NÃO destrói nada', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    const dialogo = screen.getByRole('dialog');
    await waitFor(() => {
      expect(dialogo.contains(document.activeElement)).toBe(true);
    });
    // O foco nasce em "Manter pedido": Enter por reflexo mantém, não cancela.
    expect((document.activeElement as HTMLElement).textContent).toBe('Manter pedido');
  });

  it('Escape fecha e devolve o foco ao botão que abriu', async () => {
    montar();
    const abridor = await screen.findByRole('button', { name: 'Cancelar pedido' });
    abridor.focus();
    fireEvent.click(abridor);
    screen.getByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Sem devolver o foco, o teclado cai no <body> e a pessoa recomeça a
    // página inteira do zero.
    expect(document.activeElement).toBe(abridor);
  });

  it('Tab circula dentro do diálogo em vez de vazar para a página', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    const dialogo = screen.getByRole('dialog');
    const manter = screen.getByRole('button', { name: 'Manter pedido' });
    const confirmar = screen.getByRole('button', { name: 'Sim, cancelar' });

    // Do último para frente volta ao primeiro…
    confirmar.focus();
    fireEvent.keyDown(dialogo, { key: 'Tab' });
    expect(document.activeElement).toBe(manter);
    // …e do primeiro para trás vai ao último.
    fireEvent.keyDown(dialogo, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmar);
  });
});

// ============================================================================

describe('Enter envia o que o campo promete', () => {
  it('CEP da simulação de frete vive num <form>: Enter calcula', async () => {
    const { chamadas } = servidor({
      'GET /loja/stores/gringa/products/p-1': () => json(DETALHE_COM_FRETE),
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /avaliacoes': () => json({ average: null, count: 0, items: [] }),
      'POST /shipping-quote': () => json({ options: [], simulated: false }),
    });
    render(
      <MemoryRouter initialEntries={['/loja/gringa/produto/p-1']}>
        <Routes>
          <Route path="/loja/:storeSlug/produto/:productId" element={<ProdutoLojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const cep = await screen.findByLabelText('CEP de entrega');
    fireEvent.change(cep, { target: { value: '96010000' } });

    const form = cep.closest('form');
    // O par input+botão vivia numa <div>: digitar o CEP e apertar Enter não
    // fazia nada — o gesto mais automático do teclado, mudo.
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(chamadas.some((c) => c.url.includes('/shipping-quote'))).toBe(true);
    });
  });

  it('o código de confirmação do e-mail envia com Enter', async () => {
    const { chamadas } = servidor({
      'GET /loja/portal/pedidos': () => json({ items: [] }),
      'GET /loja/portal/enderecos': () => json({ items: [] }),
      'GET /loja/portal/perfil': () => json({ email: 'ana@exemplo.com', name: null, phone: null }),
      'POST /loja/portal/verificar-email': () => json({ ok: true }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao(false)));
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const campo = await screen.findByLabelText('Código de confirmação');
    fireEvent.change(campo, { target: { value: '123456' } });
    const form = campo.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(chamadas.some((c) => c.url.includes('verificar-email') && c.method === 'POST')).toBe(
        true,
      );
    });
  });

  it('o código do balcão da oficina resgata com Enter', async () => {
    const { chamadas } = servidor({
      'GET /loja/portal/equipamentos': () => json({ items: [] }),
      'GET /loja/portal/chamados': () => json({ items: [] }),
      'POST /loja/portal/convite/resgatar': () => json({ customerName: 'Ana' }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/equipamentos']}>
        <Routes>
          <Route path="/minha-conta/equipamentos" element={<MeusEquipamentosPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const campo = await screen.findByLabelText('Código da oficina');
    fireEvent.change(campo, { target: { value: 'ABCD234567' } });
    const form = campo.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(chamadas.some((c) => c.url.includes('convite/resgatar'))).toBe(true);
    });
  });
});

// ============================================================================

describe('o que fala com leitor de tela', () => {
  it('as estrelas são uma imagem com a nota por extenso', async () => {
    servidor({
      'GET /avaliacoes': () =>
        json({
          average: 4,
          count: 1,
          items: [
            {
              id: 'av-1',
              rating: 4,
              comment: 'Boa.',
              displayName: 'Ana',
              createdAt: '2026-08-01T00:00:00Z',
            },
          ],
        }),
    });
    render(
      <MemoryRouter>
        <AvaliacoesProduto productId="p-1" />
      </MemoryRouter>,
    );
    /*
      `aria-label` num <span> genérico não é exposto de forma confiável — o
      leitor caía nos caracteres crus: "estrela preta estrela preta…". Com
      role="img", a nota sai como "4 de 5" e os glifos ficam decorativos.
    */
    const estrelas = await screen.findAllByRole('img', { name: '4 de 5' });
    expect(estrelas.length).toBeGreaterThan(0);
  });

  it('o botão do carrinho declara aberto/fechado e o que controla', async () => {
    servidor({
      'GET /loja/stores': () => json({ stores: [], services: [] }),
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
    const botao = await screen.findByRole('button', { name: /Carrinho \(0\)/ });
    expect(botao.getAttribute('aria-expanded')).toBe('false');
    expect(botao.getAttribute('aria-controls')).toBe('secao-carrinho');

    fireEvent.click(botao);
    expect(botao.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('secao-carrinho')).not.toBeNull();
  });

  it('a pílula de pagamento mostra o foco que o sr-only escondia', async () => {
    servidor({
      'GET /loja/stores': () => json({ stores: [], services: [] }),
      'GET /loja/products': () =>
        json({
          total: 1,
          items: [
            {
              id: 'p-1',
              name: 'Jaqueta',
              brand: null,
              category: null,
              priceCents: 100,
              basePriceCents: 100,
              onSale: false,
              available: 5,
              unit: 'UN',
              imageUrl: null,
              storeSlug: 'gringa',
              storeName: 'Gringa',
              hasVariants: false,
              featured: false,
            },
          ],
        }),
      'GET /loja/ofertas': () => json({ items: [] }),
      'GET /loja/destaques': () => json({ items: [] }),
      'GET /loja/categories': () => json({ items: [] }),
      'POST /loja/checkout/frete': () => json({ options: [], deliveryUnavailable: null }),
    });
    render(
      <MemoryRouter initialEntries={['/loja']}>
        <Routes>
          <Route path="/loja" element={<LojaPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Jaqueta');
    fireEvent.click(screen.getByLabelText('Adicionar Jaqueta ao carrinho'));
    fireEvent.click(screen.getByRole('button', { name: /Carrinho \(1\)/ }));

    /*
      O rádio é sr-only (1px, clipado): o anel global de :focus-visible caía
      NELE e ficava invisível. A pílula visível precisa reagir ao foco do
      rádio — irmão `peer` com `peer-focus-visible:`.
    */
    const radio = await screen.findByRole('radio', { name: 'PIX' });
    expect(radio.className).toContain('peer');
    const pilula = radio.nextElementSibling as HTMLElement;
    expect(pilula.className).toContain('peer-focus-visible:');
  });
});
