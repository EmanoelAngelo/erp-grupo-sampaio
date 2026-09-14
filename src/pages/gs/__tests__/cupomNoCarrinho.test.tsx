/**
 * O cupom na gaveta do carrinho — GAP-PRD-123.
 *
 *   - "Aplicar" pergunta ao servidor, mostra o desconto e o total ANTES do
 *     clique, e o fechamento leva o código;
 *   - o cupom recusado aparece com a mensagem do servidor, e nada de desconto
 *     no total nem código no fechamento;
 *   - com conta, a simulação leva o token do portal (o "uma vez por cliente"
 *     é conferido pela conta);
 *   - remover volta o total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LojaPage from '../LojaPage';

const PORTAL_KEY = 'gs.portal';

const LOJAS = {
  stores: [{ id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 1 }],
  services: [],
};

const PRODUTOS = {
  total: 1,
  items: [
    {
      id: 'p-gringa',
      name: 'Jaqueta Corta-Vento',
      description: null,
      category: null,
      brand: null,
      imageUrl: null,
      basePriceCents: 30000,
      priceCents: 30000,
      onSale: false,
      available: 5,
      storeSlug: 'gringa',
      storeName: 'Gringa',
    },
  ],
};

const FRETE = {
  lojas: [
    {
      companyId: 'c-gr',
      storeName: 'Gringa',
      itemsCents: 30000,
      exigeConta: false,
      options: [
        { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' },
      ],
      deliveryUnavailable: null,
    },
  ],
  exigeConta: false,
  itens: [],
};

const PERFIL = {
  email: 'ana@exemplo.com',
  name: 'Ana Conta',
  phone: '53999990000',
  nameSource: 'conta',
  documentMasked: '••• 7735',
  hasDocument: true,
  emailVerified: true,
  faltando: [],
};

type Chamada = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function servidor(cupom: () => Response) {
  const chamadas: Chamada[] = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      chamadas.push({
        url: u,
        method,
        headers: init?.headers ?? {},
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      if (u.includes('/loja/checkout/cupom')) return cupom();
      if (u.includes('/loja/checkout/frete')) return json(FRETE);
      if (u.includes('/loja/checkout')) {
        return json(
          { orders: [{ id: 'o-1', number: 7, total_cents: 27000 }], payments: [{ orderId: 'o-1', status: 'unconfigured' }] },
          201,
        );
      }
      if (u.includes('/loja/portal/perfil')) return json(PERFIL);
      if (u.includes('/loja/portal/enderecos')) return json({ items: [] });
      if (u.includes('/loja/stores')) return json(LOJAS);
      if (u.includes('/loja/products')) return json(PRODUTOS);
      return json({ items: [] });
    }),
  );
  return chamadas;
}

const CUPOM_OK = () =>
  new Response(
    JSON.stringify({
      code: 'DEZ',
      discountCents: 3000,
      lojas: [{ companyId: 'c-gr', storeName: 'Gringa', discountCents: 3000, description: null }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

async function montarComItem() {
  render(
    <MemoryRouter initialEntries={['/gringa']}>
      <LojaPage />
    </MemoryRouter>,
  );
  await screen.findByText('Jaqueta Corta-Vento');
  const card = screen.getByText('Jaqueta Corta-Vento').closest('li')!;
  fireEvent.click(card.querySelector('button')!);
  fireEvent.click(screen.getByRole('button', { name: /Carrinho/ }));
  await screen.findByText('Retirar na loja');
}

function aplicar(codigo: string) {
  fireEvent.change(screen.getByLabelText('Código do cupom'), { target: { value: codigo } });
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o cupom na gaveta do carrinho', () => {
  it('aplicar mostra o desconto e o total, e o fechamento leva o código', async () => {
    const chamadas = servidor(CUPOM_OK);
    await montarComItem();

    aplicar('dez');
    const aplicado = await screen.findByText(/aplicado:/);
    expect(aplicado.textContent).toContain('DEZ');
    expect(aplicado.textContent).toMatch(/30,00/);
    expect(screen.getByText(/Total\s+R\$\s*270,00/)).toBeTruthy();

    const simulacao = chamadas.find((c) => c.url.includes('/loja/checkout/cupom'))!;
    expect(simulacao.body).toMatchObject({
      code: 'DEZ',
      items: [{ productId: 'p-gringa', quantity: 1 }],
    });

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Visitante' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '529.982.247-25' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await screen.findByText(/Pedido #7 registrado/);

    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.body).toMatchObject({ couponCode: 'DEZ' });
  });

  it('o cupom recusado aparece com a mensagem do servidor, sem desconto nem código no fechamento', async () => {
    const chamadas = servidor(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'CHECKOUT_CUPOM_PEDIDO_MINIMO',
              message: 'O cupom DEZ vale para compras a partir de R$ 500,00 em produtos desta loja. Faltam R$ 200,00.',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await montarComItem();

    aplicar('DEZ');
    const alerta = await screen.findByText(/Faltam R\$ 200,00/);
    expect(alerta.getAttribute('role')).toBe('alert');
    expect(screen.getByText(/Total\s+R\$\s*300,00/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Visitante' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '529.982.247-25' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await screen.findByText(/Pedido #7 registrado/);
    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.body?.couponCode).toBeUndefined();
  });

  it('Enter no campo aplica o cupom e NÃO fecha o pedido', async () => {
    const chamadas = servidor(CUPOM_OK);
    await montarComItem();
    const campo = screen.getByLabelText('Código do cupom');
    fireEvent.change(campo, { target: { value: 'DEZ' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await screen.findByText(/aplicado:/);
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))).toBe(false);
  });

  it('remover o cupom volta o total', async () => {
    servidor(CUPOM_OK);
    await montarComItem();
    aplicar('DEZ');
    await screen.findByText(/aplicado:/);
    fireEvent.click(screen.getByRole('button', { name: 'Remover cupom' }));
    await waitFor(() => expect(screen.getByText(/Total\s+R\$\s*300,00/)).toBeTruthy());
    expect(screen.queryByText(/aplicado:/)).toBeNull();
  });

  it('com conta, a simulação leva o token do portal', async () => {
    localStorage.setItem(
      PORTAL_KEY,
      JSON.stringify({
        token: 'tok-da-ana',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        account: { id: 'acc-ana', email: 'ana@exemplo.com', emailVerifiedAt: '2026-09-01T00:00:00Z' },
      }),
    );
    const chamadas = servidor(CUPOM_OK);
    await montarComItem();
    aplicar('DEZ');
    await screen.findByText(/aplicado:/);
    const simulacao = chamadas.find((c) => c.url.includes('/loja/checkout/cupom'))!;
    expect(simulacao.headers['x-portal-token']).toBe('tok-da-ana');
    expect(simulacao.body).not.toHaveProperty('customerEmail');
  });
});
