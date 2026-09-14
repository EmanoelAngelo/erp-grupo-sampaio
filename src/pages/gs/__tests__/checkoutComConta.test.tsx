/**
 * O checkout COM CONTA, na tela — GAP-PRD-043 e GAP-PRD-028.
 *
 * A auditoria fechou um pedido logada e leu "Nenhum pedido ainda": a vitrine
 * mandava o checkout como visitante, sem o token do portal. O que se cobra:
 *
 *   - com conta, o checkout leva o `x-portal-token`, NÃO manda e-mail digitado
 *     (vale o da conta), pré-preenche do perfil e usa o endereço salvo;
 *   - a loja que exige conta pede o login ANTES — o carrinho fica, e o botão
 *     de finalizar não finge que vai funcionar;
 *   - conta sem e-mail confirmado não finaliza, e a tela diz por quê;
 *   - sessão vencida no fechamento volta a pedir o login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function frete(exigeConta: boolean) {
  return {
    lojas: [
      {
        companyId: 'c-gr',
        storeName: 'Gringa',
        itemsCents: 30000,
        exigeConta,
        options: [
          { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' },
          { method: 'tabela_da_loja', label: 'Entrega da loja', priceCents: 2500, estimatedDays: 3, source: 'tabela_da_loja' },
        ],
        deliveryUnavailable: null,
      },
    ],
    exigeConta,
    itens: [],
  };
}

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

const ENDERECOS = {
  items: [
    {
      id: 'end-1',
      label: 'Casa',
      zip: '96010000',
      street: 'Rua XV de Novembro',
      number: '500',
      complement: null,
      district: 'Centro',
      city: 'Pelotas',
      state: 'RS',
      cityIbge: '4314407',
      isDefault: true,
    },
  ],
};

const PEDIDO_OK = {
  orders: [{ id: 'o-1', number: 7, total_cents: 32500 }],
  payments: [{ orderId: 'o-1', status: 'unconfigured' }],
};

type Chamada = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function servidor(opcoes: {
  exigeConta: boolean;
  perfil?: Record<string, unknown>;
  checkout?: () => Response;
}) {
  const chamadas: Chamada[] = [];
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
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/loja/checkout/frete')) return json(frete(opcoes.exigeConta));
      if (u.includes('/loja/checkout')) return opcoes.checkout ? opcoes.checkout() : json(PEDIDO_OK, 201);
      if (u.includes('/loja/portal/perfil')) return json(opcoes.perfil ?? PERFIL);
      if (u.includes('/loja/portal/enderecos')) return json(ENDERECOS);
      if (u.includes('/loja/stores')) return json(LOJAS);
      if (u.includes('/loja/products')) return json(PRODUTOS);
      return json({ items: [] });
    }),
  );
  return chamadas;
}

function entrar(verificado = true) {
  localStorage.setItem(
    PORTAL_KEY,
    JSON.stringify({
      token: 'tok-da-ana',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: {
        id: 'acc-ana',
        email: 'ana@exemplo.com',
        emailVerifiedAt: verificado ? '2026-09-01T00:00:00Z' : null,
      },
    }),
  );
}

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

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a loja exige conta e ninguém entrou (GAP-PRD-028)', () => {
  it('pede o login antes, com o caminho de volta — e não deixa finalizar', async () => {
    const chamadas = servidor({ exigeConta: true });
    await montarComItem();

    await screen.findByText('Para comprar, entre na sua conta');
    const link = screen.getByRole('link', { name: 'Entrar ou criar conta' });
    expect(link.getAttribute('href')).toBe('/minha-conta?voltar=%2Fgringa');
    // Sem os campos de visitante: não adianta preencher o que o servidor recusa.
    expect(screen.queryByLabelText('E-mail')).toBeNull();
    const finalizar = screen.getByRole('button', { name: /Finalizar pedido/ }) as HTMLButtonElement;
    expect(finalizar.disabled).toBe(true);
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))).toBe(false);
  });

  it('loja aberta para visitante: os campos de sempre, com e-mail', async () => {
    servidor({ exigeConta: false });
    await montarComItem();

    expect(screen.getByLabelText('E-mail')).toBeTruthy();
    expect(screen.queryByText('Para comprar, entre na sua conta')).toBeNull();
  });
});

describe('com conta (GAP-PRD-043)', () => {
  it('pré-preenche do perfil, mostra o documento da conta mascarado e diz quem compra', async () => {
    entrar();
    servidor({ exigeConta: true });
    await montarComItem();

    await screen.findByText('ana@exemplo.com');
    await waitFor(() => expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Ana Conta'));
    expect((screen.getByLabelText('Telefone') as HTMLInputElement).value).toBe('53999990000');
    const doc = screen.getByLabelText('CPF ou CNPJ') as HTMLInputElement;
    expect(doc.disabled).toBe(true);
    expect(doc.value).toBe('••• 7735');
    // O e-mail do pedido é o da conta: não há campo para digitar outro.
    expect(screen.queryByLabelText('E-mail')).toBeNull();
  });

  it('finalizar leva o token do portal, sem e-mail digitado, e usa o endereço salvo', async () => {
    entrar();
    const chamadas = servidor({ exigeConta: true });
    await montarComItem();
    await waitFor(() => expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Ana Conta'));

    // Entrega: os endereços salvos aparecem com o padrão escolhido.
    fireEvent.click(screen.getByRole('radio', { name: /Entrega da loja/ }));
    // Dois grupos agora (GAP-PRD-115): entrega e nota fiscal — o da entrega.
    const grupo = await screen.findByRole('radiogroup', { name: 'Endereço de entrega' });
    const casa = within(grupo).getByRole('radio', { name: /Casa/ }) as HTMLInputElement;
    await waitFor(() => expect(casa.checked).toBe(true));
    // Com endereço salvo escolhido, o campo de texto não é pedido.
    expect(screen.queryByLabelText('Endereço de entrega', { selector: 'input' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await screen.findByText(/Pedido #7 registrado/);

    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.headers['x-portal-token']).toBe('tok-da-ana');
    expect(fechamento.body).not.toHaveProperty('customerEmail');
    expect(fechamento.body).toMatchObject({
      customerName: 'Ana Conta',
      shippingAddressId: 'end-1',
      shippingZip: '96010000',
      // A casa tem IBGE: serve também para a nota, e vai como faturamento.
      billingAddressId: 'end-1',
    });
    expect(fechamento.body?.shippingAddress).toBeUndefined();
  });

  it('e-mail ainda não confirmado: a tela diz, e o botão não finaliza', async () => {
    entrar(false);
    servidor({ exigeConta: true, perfil: { ...PERFIL, emailVerified: false, faltando: ['email_verificado'] } });
    await montarComItem();

    await screen.findByText(/Confirme seu e-mail para finalizar/);
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Finalizar pedido/ }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('conta sem documento: o CPF/CNPJ é pedido no próprio checkout e vai no fechamento', async () => {
    entrar();
    const chamadas = servidor({
      exigeConta: true,
      perfil: { ...PERFIL, name: null, phone: null, hasDocument: false, documentMasked: null, faltando: ['nome', 'documento', 'telefone'] },
    });
    await montarComItem();
    await screen.findByText(/ficam guardados na sua conta/);

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Nova' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '111.444.777-35' } });
    fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '53999990000' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await screen.findByText(/Pedido #7 registrado/);

    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.body).toMatchObject({
      customerName: 'Ana Nova',
      customerDocument: '111.444.777-35',
      customerPhone: '53999990000',
    });
  });

  it('sessão vencida no fechamento: a mensagem do servidor aparece e a tela volta a pedir o login', async () => {
    entrar();
    servidor({
      exigeConta: true,
      checkout: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'PORTAL_UNAUTHENTICATED',
              message: 'Sua sessão expirou. Entre de novo na sua conta para finalizar — o carrinho continua aqui.',
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    await montarComItem();
    await waitFor(() => expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Ana Conta'));

    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await screen.findByText(/Sua sessão expirou/);
    await screen.findByText('Para comprar, entre na sua conta');
    expect(localStorage.getItem(PORTAL_KEY)).toBeNull();
  });
});
