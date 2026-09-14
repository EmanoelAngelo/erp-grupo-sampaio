/**
 * O detalhe do pedido no portal ganha o pós-venda (GAP-PRD-125): o link de
 * rastreio, a nota fiscal da compra e o pedido de devolução.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MeuPedidoPage } from '../MinhaContaPage';

const SESSAO = {
  token: 'tok-portal-pv',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: '2026-08-01T00:00:00Z' },
};

const PEDIDO_ENTREGUE = {
  id: 'ord-9',
  number: 1009,
  storeName: 'Gringa',
  createdAt: '2026-09-01T12:00:00.000Z',
  statusLabel: 'Entregue',
  status: 'entregue',
  itemsCents: 20000,
  shippingCents: 1500,
  totalCents: 21500,
  deliveryMethod: 'entrega',
  shippingZip: '01001-000',
  shippingAddress: 'Rua Um, 10',
  trackingCode: 'BR123456789BR',
  trackingUrl: 'https://rastreamento.correios.com.br/app/index.php?objetos=BR123456789BR',
  shippingServiceName: 'PAC',
  deliveryEstimate: null,
  customer: { name: 'Ana', email: 'ana@exemplo.com', document: '••• 7735' },
  items: [{ description: 'Jaqueta', quantity: 1, unitPriceCents: 20000, totalCents: 20000, imageUrl: null }],
  payments: [],
  timeline: [{ statusLabel: 'Entregue', note: null, createdAt: '2026-09-10T12:00:00.000Z' }],
  notaFiscal: {
    numero: 5,
    serie: 1,
    chave: '43260911222333000181550010000000051000000050',
    status: 'AUTHORIZED',
    statusLabel: 'Autorizada',
    autorizadaEm: '2026-09-02T12:00:00.000Z',
    danfe: true,
    xml: true,
  },
  devolucao: {
    podeSolicitar: true,
    motivoIndisponivel: null,
    prazoArrependimentoAte: '2026-09-17',
    arrependimentoNoPrazo: true,
    solicitacoes: [],
  },
};

function servidor(pedido: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(pedido), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-9']}>
      <Routes>
        <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gs.portal', JSON.stringify(SESSAO));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o pós-venda no detalhe do pedido', () => {
  it('o rastreio dos Correios vira link para acompanhar', async () => {
    servidor(PEDIDO_ENTREGUE);
    montar();
    const link = (await screen.findByRole('link', { name: 'Acompanhar na transportadora' })) as HTMLAnchorElement;
    expect(link.href).toBe(PEDIDO_ENTREGUE.trackingUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    await act(async () => {});
  });

  it('a nota fiscal da compra aparece com DANFE e XML', async () => {
    servidor(PEDIDO_ENTREGUE);
    montar();
    expect(await screen.findByText(/NF-e nº 5 \(série 1\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver DANFE' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar XML' })).toBeTruthy();
  });

  it('o pedido entregue oferece a devolução, com o prazo de desistência', async () => {
    servidor(PEDIDO_ENTREGUE);
    montar();
    expect(await screen.findByRole('button', { name: 'Pedir devolução' })).toBeTruthy();
    expect(screen.getByText(/até 17\/09\/2026/)).toBeTruthy();
  });

  it('servidor antigo (sem os campos novos) não quebra a tela nem inventa seção', async () => {
    const antigo: Record<string, unknown> = { ...PEDIDO_ENTREGUE, trackingUrl: undefined };
    delete antigo.notaFiscal;
    delete antigo.devolucao;
    servidor(antigo);
    montar();
    expect(await screen.findByText('Pedido #1009')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Acompanhar na transportadora' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pedir devolução' })).toBeNull();
    // Pago sem nota: diz que ela vem.
    expect(screen.getByText('A nota fiscal aparece aqui assim que a loja emitir.')).toBeTruthy();
  });
});
