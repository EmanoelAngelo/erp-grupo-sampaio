/**
 * O RASTREIO NO PORTAL DO CLIENTE (GAP-PRD-119).
 *
 * A auditoria leu as chaves do pedido no portal: havia `trackingCode` e mais
 * nada — nem transportadora, nem link, nem evento do provedor. O cliente
 * recebia um código e tinha de adivinhar em que site procurá-lo.
 *
 * Este arquivo cobra a tela: quem leva, o link para a página da
 * transportadora, os eventos com a origem, e a FALHA da última consulta dita
 * com todas as letras — sem esconder o link, que continua levando à fonte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MinhaContaPage, { MeuPedidoPage } from '../MinhaContaPage';

const PORTAL_KEY = 'gs.portal';

function sessao() {
  return {
    token: 'tok-portal-rastreio',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: '2026-08-01T00:00:00Z' },
  };
}

const LINK = 'https://www.melhorrastreio.com.br/rastreio/AA123456789BR';

function pedido(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    number: 1001,
    storeName: 'Gringa',
    createdAt: '2026-09-10T12:00:00.000Z',
    statusLabel: 'Expedido',
    status: 'expedido',
    itemsCents: 20000,
    shippingCents: 2390,
    totalCents: 22390,
    deliveryMethod: 'entrega',
    shippingZip: '01310-100',
    shippingAddress: 'Avenida Paulista, 1000',
    shippingServiceName: 'Correios PAC',
    trackingCode: 'AA123456789BR',
    carrierName: 'Melhor Envio',
    trackingUrl: LINK,
    deliveryEstimate: null,
    customer: { name: 'Ana', email: 'ana@exemplo.com', document: '••• 7735' },
    items: [{ description: 'Jaqueta', quantity: 1, unitPriceCents: 20000, totalCents: 20000, imageUrl: null }],
    payments: [],
    timeline: [
      { statusLabel: 'Pago', note: null, createdAt: '2026-09-10T12:10:00.000Z', origin: null },
      {
        statusLabel: 'Expedido',
        note: 'Postagem registrada pela transportadora (Melhor Envio).',
        createdAt: '2026-09-11T12:30:00.000Z',
        origin: 'provedor',
      },
    ],
    tracking: {
      carrier: 'melhor_envio',
      carrierName: 'Melhor Envio',
      trackingCode: 'AA123456789BR',
      trackingUrl: LINK,
      status: 'postado',
      statusLabel: 'Postado',
      viaProvedor: true,
      lastSyncAt: '2026-09-11T13:00:00.000Z',
      lastSyncOk: true,
      aviso: null,
      events: [
        { status: 'etiqueta_gerada', description: 'Etiqueta gerada', occurredAt: '2026-09-10T13:00:00.000Z', origin: 'operador' },
        { status: 'postado', description: 'Encomenda postada na transportadora', occurredAt: '2026-09-11T12:30:00.000Z', origin: 'provedor' },
      ],
    },
    ...over,
  };
}

function servidor(rotas: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      for (const [caminho, corpo] of Object.entries(rotas)) {
        if (alvo.endsWith(caminho)) {
          return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return new Response(JSON.stringify({ error: { message: 'rota não mockada' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
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
  localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o detalhe do pedido mostra o rastreio de verdade', () => {
  it('quem leva, o link da transportadora e os eventos com a origem', async () => {
    servidor({ '/loja/portal/pedidos/ord-1': pedido() });
    montarPedido();

    const bloco = await screen.findByTestId('rastreio-do-pedido');
    expect(bloco.textContent).toContain('Melhor Envio');
    expect(bloco.textContent).toContain('AA123456789BR');
    const link = screen.getByRole('link', { name: 'Acompanhar na transportadora' });
    expect(link.getAttribute('href')).toBe(LINK);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(bloco.textContent).toMatch(/Encomenda postada na transportadora\s*\(transportadora\)/);
    expect(bloco.textContent).toMatch(/Etiqueta gerada\s*\(loja\)/);
    expect(bloco.textContent).toMatch(/Atualizado com a transportadora/);
    // A linha do tempo diz quem informou a expedição.
    expect(screen.getByText(/informado pela transportadora/)).toBeTruthy();
  });

  it('a falha da última consulta é dita — e o link continua lá', async () => {
    servidor({
      '/loja/portal/pedidos/ord-1': pedido({
        tracking: {
          ...pedido().tracking,
          lastSyncOk: false,
          aviso: 'Não conseguimos atualizar o rastreio com a transportadora na última consulta (11/09/2026 10:00). O link abaixo mostra a situação direto na transportadora.',
        },
      }),
    });
    montarPedido();

    expect((await screen.findByText(/Não conseguimos atualizar o rastreio/)).getAttribute('role')).toBe('status');
    expect(screen.getByRole('link', { name: 'Acompanhar na transportadora' })).toBeTruthy();
    expect(screen.queryByText(/Atualizado com a transportadora/)).toBeNull();
  });

  it('entrega da loja: sem link inventado, mas diz quem leva', async () => {
    servidor({
      '/loja/portal/pedidos/ord-1': pedido({
        trackingCode: null,
        carrierName: 'Entrega da loja',
        trackingUrl: null,
        tracking: { ...pedido().tracking, carrier: 'propria', carrierName: 'Entrega da loja', trackingCode: null, trackingUrl: null, viaProvedor: false, events: [] },
      }),
    });
    montarPedido();

    expect((await screen.findByTestId('rastreio-do-pedido')).textContent).toContain('Entrega da loja');
    expect(screen.queryByRole('link', { name: 'Acompanhar na transportadora' })).toBeNull();
  });

  it('servidor antigo (sem `tracking`) ainda mostra o código', async () => {
    servidor({
      '/loja/portal/pedidos/ord-1': pedido({ tracking: undefined, carrierName: undefined, trackingUrl: undefined }),
    });
    montarPedido();
    expect((await screen.findByTestId('rastreio-do-pedido')).textContent).toContain('AA123456789BR');
  });
});

describe('a lista de pedidos', () => {
  it('o código de rastreio vira link para a transportadora', async () => {
    servidor({
      '/loja/portal/pedidos': {
        items: [
          {
            id: 'ord-1',
            number: 1001,
            storeName: 'Gringa',
            createdAt: '2026-09-10T12:00:00.000Z',
            totalCents: 22390,
            statusLabel: 'Expedido',
            paymentStatusLabel: 'Pago',
            paymentMethod: 'pix',
            deliveryMethod: 'entrega',
            trackingCode: 'AA123456789BR',
            trackingUrl: 'https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR',
            carrierName: 'Correios',
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const link = await screen.findByRole('link', { name: 'AA123456789BR' });
    expect(link.getAttribute('href')).toBe('https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR');
    expect(screen.getByText(/Rastreio \(Correios\)/)).toBeTruthy();
  });
});
