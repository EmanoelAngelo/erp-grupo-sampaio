/**
 * ============================================================================
 * A LOJA PERGUNTA EM QUANTAS VEZES — E O NÚMERO CHEGA NO CHECKOUT (GAP-PRD-114)
 * ============================================================================
 *
 * O selo "Parcele em até 6x" existia, e a tela de checkout não oferecia
 * escolha nenhuma: a cobrança do cartão nascia à vista. Estes testes olham o
 * FIO — o que sai no corpo de `POST /loja/checkout` — e não só o que aparece.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LojaPage from '../LojaPage';
import { descreverParcelas, maximoDeParcelas } from '@/lib/parcelasDoCarrinho';

const LOJAS = {
  stores: [
    { id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 1, cardInstallmentsMax: 6 },
    { id: 'c-mm', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail', productCount: 1, cardInstallmentsMax: null },
  ],
  services: [],
};

const PRODUTOS = {
  total: 2,
  items: [
    {
      id: 'p-gringa', name: 'Jaqueta Corta-Vento', description: null, category: null, brand: null, imageUrl: null,
      basePriceCents: 60000, priceCents: 60000, onSale: false, available: 5, storeSlug: 'gringa', storeName: 'Gringa',
    },
    {
      id: 'p-mimei', name: 'Kit Skincare Facial', description: null, category: null, brand: null, imageUrl: null,
      basePriceCents: 12900, priceCents: 12900, onSale: false, available: 9, storeSlug: 'me-mimei', storeName: 'Me Mimei',
    },
  ],
};

function freteDas(lojas: string[]) {
  const todas = {
    'c-gr': { companyId: 'c-gr', storeName: 'Gringa', itemsCents: 60000 },
    'c-mm': { companyId: 'c-mm', storeName: 'Me Mimei', itemsCents: 12900 },
  } as const;
  return {
    lojas: lojas.map((id) => ({
      ...todas[id as keyof typeof todas],
      options: [{ method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' }],
      deliveryUnavailable: null,
    })),
    deliveryUnavailable: null,
    itens: [],
  };
}

let checkouts: Record<string, unknown>[];
let lojasNoFrete: string[];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    let corpo: unknown = { items: [] };
    if (u.includes('/loja/stores')) corpo = LOJAS;
    else if (u.includes('/loja/products')) corpo = PRODUTOS;
    else if (u.includes('/loja/checkout/frete')) corpo = freteDas(lojasNoFrete);
    else if (u.includes('/loja/checkout') && init?.method === 'POST') {
      const pedido = JSON.parse(String(init.body)) as Record<string, unknown>;
      checkouts.push(pedido);
      corpo = {
        orders: [{ id: 'o-1', number: 9, total_cents: 60000 }],
        payments: [
          {
            orderId: 'o-1',
            method: pedido.paymentMethod,
            installments: pedido.installments ?? 1,
            status: 'pending',
            environment: 'sandbox',
            bankSlipUrl: 'https://sandbox.asaas.com/i/TESTE',
          },
        ],
      };
    }
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

async function montarCom(nomes: string[]) {
  render(
    <MemoryRouter>
      <LojaPage />
    </MemoryRouter>,
  );
  await screen.findByText('Jaqueta Corta-Vento');
  for (const nome of nomes) {
    fireEvent.click(screen.getByText(nome).closest('li')!.querySelector('button')!);
  }
  fireEvent.click(screen.getByRole('button', { name: /Carrinho/ }));
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
  fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '11144477735' } });
  // O e-mail do visitante é obrigatório (GAP-PRD-191): é por ele que o pedido
  // e a cobrança chegam — sem ele o formulário não sai.
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
}

function escolherCartao() {
  fireEvent.click(screen.getByRole('radio', { name: 'Cartão de crédito' }));
}

beforeEach(() => {
  localStorage.clear();
  checkouts = [];
  lojasNoFrete = ['c-gr'];
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('GAP-PRD-114 — a escolha das parcelas no checkout', () => {
  it('cartão numa loja que parcela em 6x: a tela oferece 1x a 6x com o valor, e o número viaja no corpo', async () => {
    await montarCom(['Jaqueta Corta-Vento']);
    escolherCartao();

    const seletor = (await screen.findByLabelText('Parcelas')) as HTMLSelectElement;
    expect(Array.from(seletor.options).map((o) => o.textContent)).toEqual([
      'à vista, R$ 600,00',
      '2x de R$ 300,00',
      '3x de R$ 200,00',
      '4x de R$ 150,00',
      '5x de R$ 120,00',
      '6x de R$ 100,00',
    ]);
    fireEvent.change(seletor, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() => expect(checkouts).toHaveLength(1));
    expect(checkouts[0]).toMatchObject({ paymentMethod: 'cartao', installments: 6 });
    expect(await screen.findByText('Pague com cartão em 6x')).toBeTruthy();
  });

  it('PIX não parcela: sem seletor, e nada de installments no corpo', async () => {
    await montarCom(['Jaqueta Corta-Vento']);

    await screen.findByRole('button', { name: /Finalizar pedido/ });
    expect(screen.queryByLabelText('Parcelas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() => expect(checkouts).toHaveLength(1));
    expect(checkouts[0].installments).toBeUndefined();
  });

  it('escolheu 3x e voltou para o PIX: o 3x não viaja escondido', async () => {
    await montarCom(['Jaqueta Corta-Vento']);
    escolherCartao();
    fireEvent.change(await screen.findByLabelText('Parcelas'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('radio', { name: 'PIX' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    await waitFor(() => expect(checkouts).toHaveLength(1));
    expect(checkouts[0]).toMatchObject({ paymentMethod: 'pix' });
    expect(checkouts[0].installments).toBeUndefined();
  });

  it('carrinho com uma loja que só vende à vista: o cartão não oferece parcelas', async () => {
    lojasNoFrete = ['c-gr', 'c-mm'];
    await montarCom(['Jaqueta Corta-Vento', 'Kit Skincare Facial']);
    escolherCartao();

    await screen.findByRole('button', { name: /Finalizar pedido/ });
    expect(screen.queryByLabelText('Parcelas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await waitFor(() => expect(checkouts).toHaveLength(1));
    expect(checkouts[0].installments).toBeUndefined();
  });
});

describe('GAP-PRD-114 — a conta do máximo (a mesma do servidor)', () => {
  it('menor teto entre as lojas, e nunca parcela abaixo de R$ 5,00', () => {
    expect(maximoDeParcelas([{ nome: 'A', totalCents: 60000, teto: 6 }])).toBe(6);
    expect(maximoDeParcelas([{ nome: 'A', totalCents: 60000, teto: 6 }, { nome: 'B', totalCents: 90000, teto: 3 }])).toBe(3);
    expect(maximoDeParcelas([{ nome: 'A', totalCents: 60000, teto: 6 }, { nome: 'B', totalCents: 9000, teto: null }])).toBe(1);
    expect(maximoDeParcelas([{ nome: 'A', totalCents: 2000, teto: 6 }])).toBe(4);
  });

  it('a sobra de centavos é dita, não escondida', () => {
    expect(descreverParcelas(10000, 3)).toBe('3x de R$ 33,33 (uma de R$ 33,34)');
  });
});
