/**
 * GAP-PRD-115, na tela: o endereço se EDITA (sem apagar e recriar), mostra
 * para que serve e quem recebe, e o checkout com conta escolhe a entrega e a
 * nota fiscal entre os endereços salvos — cadastrando ali mesmo quando não há.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContaDoCliente } from '@/components/gs/ContaDoCliente';
import LojaPage from '@/pages/gs/LojaPage';

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

const CASA = {
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
  kind: 'ambos',
  recipientName: 'Maria Recebedora',
  usableForShipping: true,
  usableForBilling: true,
};

const TRABALHO = {
  ...CASA,
  id: 'end-2',
  label: 'Trabalho',
  street: 'Av. Brasil',
  number: '10',
  // Só entrega (não vai na nota), mas COM o IBGE: desde a reauditoria do
  // GAP-PRD-028 o endereço que recebe um pedido precisa do município pelo
  // código — o sem IBGE é cobrado em entregaNoEnderecoCompleto.test.tsx.
  cityIbge: '4314407',
  isDefault: false,
  kind: 'entrega',
  recipientName: null,
  usableForShipping: true,
  usableForBilling: false,
};

const ESCRITORIO = {
  ...CASA,
  id: 'end-3',
  label: 'Escritório fiscal',
  street: 'Av. Fiscal',
  number: '7',
  isDefault: false,
  kind: 'faturamento',
  recipientName: null,
  usableForShipping: false,
  usableForBilling: true,
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

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('GAP-PRD-115 — Minha conta: editar o endereço', () => {
  it('mostra para que serve e quem recebe', async () => {
    servidor((c) => (c.url.includes('/portal/enderecos') ? json({ items: [CASA, TRABALHO] }) : undefined));
    render(<ContaDoCliente token="tok" />);
    await screen.findByText('Recebe: Maria Recebedora');
    expect(screen.getByText('Entrega e nota fiscal')).toBeTruthy();
    expect(screen.getByText('Só entrega')).toBeTruthy();
  });

  it('"Editar" abre o formulário preenchido, e salvar manda PUT com o que mudou', async () => {
    let lista = [CASA];
    const chamadas = servidor((c) => {
      if (c.method === 'PUT' && c.url.endsWith('/loja/portal/enderecos/end-1')) {
        lista = [{ ...CASA, number: '502' }];
        return json(lista[0]);
      }
      if (c.url.includes('/portal/enderecos')) return json({ items: lista });
      return undefined;
    });
    render(<ContaDoCliente token="tok" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Editar Casa' }));
    const numero = screen.getByLabelText('Número') as HTMLInputElement;
    expect(numero.value).toBe('500');
    expect((screen.getByLabelText('Quem recebe') as HTMLInputElement).value).toBe('Maria Recebedora');
    fireEvent.change(numero, { target: { value: '502' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await screen.findByText(/Endereço atualizado/);
    const put = chamadas.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ number: '502', street: 'Rua XV de Novembro', kind: 'ambos' });
    expect(await screen.findByText(/Rua XV de Novembro, 502/)).toBeTruthy();
  });

  it('a recusa do servidor (nota fiscal sem IBGE) aparece no formulário', async () => {
    servidor((c) => {
      if (c.method === 'POST' && c.url.endsWith('/loja/portal/enderecos')) {
        return json(
          {
            error: {
              code: 'PORTAL_IBGE_OBRIGATORIO',
              message: 'Para usar este endereço na nota fiscal (faturamento), informe o código IBGE do município.',
            },
          },
          400,
        );
      }
      if (c.url.includes('/portal/enderecos')) return json({ items: [] });
      return undefined;
    });
    render(<ContaDoCliente token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar endereço' }));
    fireEvent.change(screen.getByLabelText('Usar este endereço para'), { target: { value: 'faturamento' } });
    // A tela avisa ANTES de enviar…
    expect(screen.getByText('Para usar na nota fiscal, informe o código IBGE do município.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }));
    // …e mostra a recusa do servidor quando ela vem.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/código IBGE/);
  });
});

/* ------------------------------------------------------------- o checkout */

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

describe('GAP-PRD-115 — o checkout com conta escolhe entrega e nota', () => {
  it('entrega só lista o que entrega; a nota só o que fatura; os dois vão no fechamento', async () => {
    entrar();
    const chamadas = lojaCom(() => [CASA, TRABALHO, ESCRITORIO]);
    await abrirCarrinhoComEntrega();

    const entrega = await screen.findByRole('radiogroup', { name: 'Endereço de entrega' });
    const nota = await screen.findByRole('radiogroup', { name: 'Endereço da nota fiscal' });
    expect(within(entrega).queryByRole('radio', { name: /Escritório fiscal/ })).toBeNull();
    expect(within(nota).queryByRole('radio', { name: /Trabalho/ })).toBeNull();
    // Não há mais o campo de texto solto para quem tem conta.
    expect(screen.queryByLabelText('Endereço de entrega', { selector: 'input' })).toBeNull();

    fireEvent.click(within(entrega).getByRole('radio', { name: /Trabalho/ }));
    fireEvent.click(within(nota).getByRole('radio', { name: /Escritório fiscal/ }));
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await screen.findByText(/Pedido #9 registrado/);

    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.body).toMatchObject({ shippingAddressId: 'end-2', billingAddressId: 'end-3' });
    expect(fechamento.body?.shippingAddress).toBeUndefined();
  });

  it('conta sem endereço: pede o cadastro ali mesmo, trava o fechamento até escolher, e usa o novo', async () => {
    entrar();
    let lista: unknown[] = [];
    const chamadas = lojaCom(
      () => lista,
      (c) => {
        if (c.method === 'POST' && c.url.endsWith('/loja/portal/enderecos')) {
          const novo = { ...CASA, id: 'end-novo', label: null, recipientName: null };
          lista = [novo];
          return json(novo, 201);
        }
        return undefined;
      },
    );
    await abrirCarrinhoComEntrega();

    await screen.findByText(/Cadastre o endereço de entrega/);
    expect(screen.getByText('Escolha ou cadastre o endereço de entrega.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Finalizar pedido/ }) as HTMLButtonElement).disabled).toBe(true);

    const grupo = screen.getByRole('group', { name: 'Novo endereço de entrega' });
    for (const [rotulo, valor] of [
      ['CEP', '96010-000'],
      ['Rua', 'Rua XV de Novembro'],
      ['Número', '500'],
      ['Cidade', 'Pelotas'],
      ['UF', 'RS'],
      ['Código IBGE do município', '4314407'],
    ]) {
      fireEvent.change(within(grupo).getByLabelText(rotulo), { target: { value: valor } });
    }
    fireEvent.click(within(grupo).getByRole('button', { name: 'Salvar e usar este endereço' }));

    const entrega = await screen.findByRole('radiogroup', { name: 'Endereço de entrega' });
    await waitFor(() =>
      expect((within(entrega).getByRole('radio') as HTMLInputElement).checked).toBe(true),
    );
    const botao = screen.getByRole('button', { name: /Finalizar pedido/ }) as HTMLButtonElement;
    await waitFor(() => expect(botao.disabled).toBe(false));
    fireEvent.click(botao);
    await screen.findByText(/Pedido #9 registrado/);

    const criado = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/portal/enderecos'))!;
    expect(criado.body).toMatchObject({ street: 'Rua XV de Novembro', cityIbge: '4314407' });
    const fechamento = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/loja/checkout'))!;
    expect(fechamento.body).toMatchObject({ shippingAddressId: 'end-novo', billingAddressId: 'end-novo' });
  });

  it('sem endereço que sirva para a nota: a compra segue, e a tela diz que a nota espera', async () => {
    entrar();
    lojaCom(() => [TRABALHO]);
    await abrirCarrinhoComEntrega();
    expect(await screen.findByText(/Nenhum endereço seu serve para a nota fiscal/)).toBeTruthy();
    const botao = screen.getByRole('button', { name: /Finalizar pedido/ }) as HTMLButtonElement;
    await waitFor(() => expect(botao.disabled).toBe(false));
  });
});
