/**
 * GAP-PRD-028 (reauditoria), na tela — COM CONTA, A ENTREGA VAI PARA UM
 * ENDEREÇO SALVO COMPLETO, COM O CÓDIGO IBGE.
 *
 * O servidor passou a recusar o fechamento com conta cuja entrega não é um
 * endereço salvo completo (rua, número, bairro, cidade, UF, CEP e IBGE):
 * 422 CHECKOUT_ENDERECO_INCOMPLETO. A tela diz o mesmo ANTES do clique e
 * deixa completar ali mesmo — sem mandar a pessoa atrás de um formulário:
 *
 *   - o endereço escolhido sem IBGE aparece com o que falta, e o botão de
 *     finalizar trava com a frase que diz o que completar;
 *   - "Completar" abre o formulário preenchido; salvar manda o PUT, e o
 *     fechamento destrava e leva o mesmo `shippingAddressId`;
 *   - a recusa do servidor, se vier, aparece com as palavras dele;
 *   - em Minha conta, cada endereço incompleto diz o que falta para entregar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContaDoCliente } from '@/components/gs/ContaDoCliente';
import LojaPage from '../LojaPage';

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

const TRABALHO_SEM_IBGE = {
  id: 'end-9',
  label: 'Trabalho',
  zip: '96010000',
  street: 'Av. Brasil',
  number: '10',
  complement: null,
  district: 'Centro',
  city: 'Pelotas',
  state: 'RS',
  cityIbge: null,
  isDefault: true,
  kind: 'entrega',
  recipientName: null,
  usableForShipping: true,
  usableForBilling: false,
};

const CASA_COMPLETA = {
  ...TRABALHO_SEM_IBGE,
  id: 'end-1',
  label: 'Casa',
  street: 'Rua XV de Novembro',
  number: '500',
  cityIbge: '4314407',
  kind: 'ambos',
  usableForBilling: true,
};

const LOJAS = {
  stores: [{ id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 1 }],
  services: [],
};
const PRODUTOS = {
  total: 1,
  items: [
    {
      id: 'p-1',
      name: 'Jaqueta',
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
      exigeConta: true,
      options: [
        { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' },
        { method: 'tabela_da_loja', label: 'Entrega da loja', priceCents: 2500, estimatedDays: 3, source: 'tabela_da_loja' },
      ],
      deliveryUnavailable: null,
    },
  ],
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

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(rotas: (c: Chamada) => Response | undefined) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const c: Chamada = {
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      chamadas.push(c);
      return rotas(c) ?? json({ items: [] });
    }),
  );
  return chamadas;
}

function lojaCom(enderecos: () => unknown[], extra?: (c: Chamada) => Response | undefined) {
  return servidor((c) => {
    const e = extra?.(c);
    if (e) return e;
    if (c.url.includes('/loja/checkout/frete')) return json(FRETE);
    if (c.url.endsWith('/loja/checkout'))
      return json({ orders: [{ id: 'o-1', number: 9, total_cents: 32500 }], payments: [] }, 201);
    if (c.url.includes('/loja/portal/perfil')) return json(PERFIL);
    if (c.url.includes('/loja/portal/enderecos')) return json({ items: enderecos() });
    if (c.url.includes('/loja/stores')) return json(LOJAS);
    if (c.url.includes('/loja/products')) return json(PRODUTOS);
    return undefined;
  });
}

function entrar() {
  localStorage.setItem(
    'gs.portal',
    JSON.stringify({
      token: 'tok-da-ana',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: { id: 'acc', email: 'ana@exemplo.com', emailVerifiedAt: '2026-09-01T00:00:00Z' },
    }),
  );
}

async function abrirCarrinhoComEntrega() {
  render(
    <MemoryRouter initialEntries={['/gringa']}>
      <LojaPage />
    </MemoryRouter>,
  );
  await screen.findByText('Jaqueta');
  fireEvent.click(screen.getByText('Jaqueta').closest('li')!.querySelector('button')!);
  fireEvent.click(screen.getByRole('button', { name: /Carrinho/ }));
  fireEvent.click(await screen.findByRole('radio', { name: /Entrega da loja/ }));
}

function finalizar(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Finalizar pedido/ }) as HTMLButtonElement;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('GAP-PRD-028 — o checkout com conta pede o endereço de entrega completo', () => {
  it('endereço escolhido sem IBGE: diz o que falta, trava o fechamento, completa ali mesmo e fecha', async () => {
    entrar();
    let lista: unknown[] = [TRABALHO_SEM_IBGE];
    const chamadas = lojaCom(
      () => lista,
      (c) => {
        if (c.method === 'PUT' && c.url.endsWith('/loja/portal/enderecos/end-9')) {
          const completo = { ...TRABALHO_SEM_IBGE, cityIbge: '4314407' };
          lista = [completo];
          return json(completo);
        }
        return undefined;
      },
    );
    await abrirCarrinhoComEntrega();

    const grupo = await screen.findByRole('radiogroup', { name: 'Endereço de entrega' });
    await waitFor(() =>
      expect((within(grupo).getByRole('radio', { name: /Trabalho/ }) as HTMLInputElement).checked).toBe(true),
    );
    // O que falta aparece no próprio endereço, e o fechamento trava com a frase.
    expect(within(grupo).getByText(/falta o código IBGE do município/)).toBeTruthy();
    await screen.findByText(/Complete o endereço de entrega "Trabalho": falta o código IBGE do município/);
    expect(finalizar().disabled).toBe(true);

    // "Completar" abre o formulário já preenchido; salvar manda o PUT.
    fireEvent.click(screen.getByRole('button', { name: 'Completar Trabalho' }));
    const form = screen.getByRole('group', { name: 'Completar Trabalho' });
    expect((within(form).getByLabelText('Número') as HTMLInputElement).value).toBe('10');
    fireEvent.change(within(form).getByLabelText('Código IBGE do município'), { target: { value: '4314407' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar e usar este endereço' }));

    await waitFor(() => expect(finalizar().disabled).toBe(false));
    expect(screen.queryByText(/Complete o endereço de entrega/)).toBeNull();
    fireEvent.click(finalizar());
    await screen.findByText(/Pedido #9 registrado/);

    const put = chamadas.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ street: 'Av. Brasil', number: '10', cityIbge: '4314407' });
    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.body).toMatchObject({ shippingAddressId: 'end-9' });
    expect(fechamento.body?.shippingAddress).toBeUndefined();
  });

  it('endereço sem número e sem bairro: a frase nomeia os dois', async () => {
    entrar();
    lojaCom(() => [{ ...TRABALHO_SEM_IBGE, number: null, district: null, cityIbge: '4314407' }]);
    await abrirCarrinhoComEntrega();

    await screen.findByText(/Complete o endereço de entrega "Trabalho": falta o número \(ou "S\/N"\) e o bairro/);
    expect(finalizar().disabled).toBe(true);
  });

  it('endereço completo: nada trava', async () => {
    entrar();
    lojaCom(() => [CASA_COMPLETA]);
    await abrirCarrinhoComEntrega();

    await waitFor(() => expect(finalizar().disabled).toBe(false));
    expect(screen.queryByText(/Complete o endereço de entrega/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Completar / })).toBeNull();
  });

  it('a recusa do servidor (CHECKOUT_ENDERECO_INCOMPLETO) aparece com as palavras dele', async () => {
    entrar();
    lojaCom(
      () => [CASA_COMPLETA],
      (c) =>
        c.method === 'POST' && c.url.endsWith('/loja/checkout')
          ? json(
              {
                error: {
                  code: 'CHECKOUT_ENDERECO_INCOMPLETO',
                  message:
                    'O endereço "Casa" está incompleto para receber o pedido: falta o código IBGE do município. Complete em Minha conta › Meus endereços (Editar) e finalize de novo.',
                },
              },
              422,
            )
          : undefined,
    );
    await abrirCarrinhoComEntrega();
    await waitFor(() => expect(finalizar().disabled).toBe(false));

    fireEvent.click(finalizar());
    expect(await screen.findByText(/está incompleto para receber o pedido/)).toBeTruthy();
  });
});

describe('GAP-PRD-028 — Minha conta diz o que falta em cada endereço', () => {
  it('o endereço sem IBGE mostra o que falta para entregar; o completo, nada', async () => {
    servidor((c) =>
      c.url.includes('/portal/enderecos') ? json({ items: [CASA_COMPLETA, TRABALHO_SEM_IBGE] }) : undefined,
    );
    render(<ContaDoCliente token="tok" />);

    const aviso = await screen.findByText(/Para receber entregas, falta o código IBGE do município/);
    expect(aviso.closest('li')!.textContent).toMatch(/Trabalho/);
    expect(screen.getAllByText(/Para receber entregas, falta/)).toHaveLength(1);
  });
});
