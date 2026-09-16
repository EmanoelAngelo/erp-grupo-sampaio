/**
 * A NF-e (MODELO 55) DE UMA VENDA DE BALCÃO, NA FICHA DA VENDA (P0 fiscal).
 *
 * ## O defeito
 *
 * `createNfeForSale` existia inteiro no servidor — série do cadastro,
 * destinatário validado, município conferido na tabela do IBGE e a trava de
 * "um documento vivo por venda" — e NENHUM caminho o chamava fora dos testes.
 * A NF-e do sistema só saía de PEDIDO ONLINE. O cliente que compra no balcão
 * com CNPJ e pede a nota ficava sem caminho, embora o próprio domínio escreva
 * a regra do caso: quem vendeu no balcão e precisa da NF-e cancela o cupom,
 * dentro do prazo, e só então emite a nota.
 *
 * ## O que se cobra
 *
 *  - venda SEM cupom vivo: o formulário do destinatário (o endereço a loja não
 *    tem) e a emissão, com o município escolhido na lista do IBGE;
 *  - venda COM NFC-e viva: nada de botão — a tela diz que a venda já está
 *    documentada e qual é o caminho (cancelar o cupom primeiro);
 *  - quem não tem `fiscal.manage` não recebe a seção: a rota é da gerência.
 *
 * Como cada caso falha sem o conserto: sem a seção, o botão não existe; sem a
 * leitura do cupom, a venda documentada volta a oferecer a emissão que o
 * servidor recusa com 409.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { VendasPage } from '../OperacaoPages';

const VENDA = {
  id: 'v-301',
  number: 301,
  total_cents: 25_000,
  change_cents: 0,
  status: 'completed',
  created_at: '2026-09-14T17:40:00.000Z',
  customer_id: null,
};

const FICHA = {
  ...VENDA,
  items: [
    {
      id: 'si-1',
      product_id: 'p-1',
      description: 'Camiseta',
      quantity: 1,
      unit_price_cents: 25_000,
      total_cents: 25_000,
    },
  ],
  payments: [],
  customerCreditCents: 0,
  removedItems: [],
  financeEntries: [],
};

/** O cupom desta venda: nulo (sem nota) ou o documento vivo. */
let cupom: unknown = null;
let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[];

const CAPS: Record<string, string[]> = {
  gerente_loja: ['fiscal.manage', 'sales.view'],
  operador_caixa_loja: ['fiscal.sale.emit', 'sales.view'],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url).split('?')[0];
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (metodo !== 'GET') {
      enviados.push({
        url: alvo,
        metodo,
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
    }
    if (alvo.includes('/core/fiscal/sales/v-301/nfe') && metodo === 'POST') {
      return json({
        document: {
          id: 'doc-55',
          model: '55',
          serie: 1,
          number: 31,
          accessKey: '3'.repeat(44),
          status: 'AUTHORIZED',
          protocol: 'TEST-31',
        },
        statusLabel: 'Autorizada',
        pendencias: [],
      });
    }
    if (alvo.includes('/core/fiscal/sales/v-301/status')) return json(cupom);
    if (alvo.includes('/loja/municipios')) {
      return json({ carregada: true, total: 1, itens: [{ codigo: '4314407', nome: 'Pelotas', uf: 'RS' }] });
    }
    if (/\/core\/sales\/v-301$/.test(alvo)) return json(FICHA);
    if (alvo.includes('/core/sales')) return json({ items: [VENDA], total: 1 });
    return json({});
  });
}

function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
      access: {
        modelo: { code: profileCode, name: profileCode, personalizado: false },
        capabilities: CAPS[profileCode] ?? [],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/sistema',
        carimbo: `c-${profileCode}`,
      },
    } as never,
    'LOGIN',
    'teste da NF-e da venda de balcão',
  );
}

beforeEach(() => {
  enviados = [];
  cupom = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrar('gerente_loja');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirFicha() {
  render(
    <MemoryRouter>
      <VendasPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir a venda #301' }));
  return screen.findByRole('dialog', { name: 'Venda #301' });
}

describe('a NF-e da venda de balcão sai pela ficha da venda', () => {
  it('sem cupom, o formulário pede o endereço e a nota sai com o município do IBGE', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e desta venda' }));

    fireEvent.change(await screen.findByLabelText(/Nome do cliente/), {
      target: { value: 'Atacado Sul Ltda' },
    });
    fireEvent.change(screen.getByLabelText(/CPF ou CNPJ/), { target: { value: '11.444.777/0001-61' } });
    fireEvent.change(screen.getByLabelText(/Logradouro/), { target: { value: 'Rua do Comércio' } });
    fireEvent.change(screen.getByLabelText(/^Número/), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText(/Bairro/), { target: { value: 'Industrial' } });
    fireEvent.change(screen.getByLabelText(/^UF/), { target: { value: 'RS' } });
    fireEvent.change(screen.getByLabelText(/Município/), { target: { value: 'Pelot' } });
    fireEvent.click(await screen.findByRole('option', { name: /Pelotas/ }));

    const botoes = screen.getAllByRole('button', { name: 'Emitir NF-e desta venda' });
    fireEvent.click(botoes[botoes.length - 1]!);

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/fiscal/sales/v-301/nfe'))).toBe(true));
    expect(enviados.find((e) => e.url.includes('/fiscal/sales/v-301/nfe'))!.corpo).toEqual({
      recipient: {
        document: '11444777000161',
        name: 'Atacado Sul Ltda',
        ieIndicator: '9',
        street: 'Rua do Comércio',
        number: '500',
        complement: null,
        district: 'Industrial',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        uf: 'RS',
        zip: null,
      },
    });

    expect(await screen.findByText(/NF-e 31, série 1 — AUTHORIZED/)).toBeTruthy();
  });

  it('venda com NFC-e viva não oferece a emissão — e diz qual é o caminho', async () => {
    cupom = {
      document: { id: 'doc-65', model: '65', serie: 1, number: 88, status: 'AUTHORIZED' },
      statusLabel: 'Autorizada',
      terminal: true,
      isTest: false,
    };
    await abrirFicha();
    expect(await screen.findByText(/já tem NFC-e nº 88/)).toBeTruthy();
    expect(screen.getByText(/cancele o cupom/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e desta venda' })).toBeNull();
  });

  it('o caixa não recebe a seção: a rota é da gerência', async () => {
    entrar('operador_caixa_loja');
    await abrirFicha();
    expect(screen.queryByTestId('nfe-da-venda')).toBeNull();
  });
});
