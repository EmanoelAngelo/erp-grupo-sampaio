/**
 * A DEVOLUÇÃO EM CRÉDITO NA TELA — o vale precisa de dono (GAP-V10/V47).
 *
 * O servidor passou a exigir cliente identificado para devolver "em crédito de
 * loja": vale sem dono é dinheiro que a loja deve a ninguém — nenhum extrato o
 * mostra, nenhuma venda o consome, e o passivo cresce invisível a cada
 * devolução. Era exatamente esse o buraco.
 *
 * A tela tem de dizer isso ANTES do clique. Deixar o 403 explicar seria mandar
 * o operador montar a devolução inteira — item, quantidade, motivo, com o
 * cliente na frente — para só então descobrir que a forma escolhida não vale.
 *
 * ## Como cada caso fica vermelho quando o guarda sai
 *
 *   - deixe "Crédito de loja" habilitado na venda anônima e a tela volta a
 *     oferecer o que a API recusa;
 *   - tire a explicação e a opção fica cinza sem motivo — que é pior, porque a
 *     pessoa não descobre sozinha que basta identificar o cliente;
 *   - tire o passivo em vale e o total que a loja deve volta a existir só
 *     somando devolução por devolução à mão, que é o mesmo que não existir.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import DevolucoesPage from '../DevolucoesPage';

/** A venda do balcão anônimo — a maioria, e a que não admite vale. */
const VENDA_ANONIMA = {
  id: 's-anon',
  number: 42,
  customer_id: null,
  total_cents: 10000,
  change_cents: 0,
  status: 'closed',
  created_at: '2026-08-18T10:00:00.000Z',
};

/** A venda com cliente — a única que pode virar vale. */
const VENDA_COM_DONO = {
  id: 's-dono',
  number: 43,
  customer_id: 'c-marta',
  total_cents: 25000,
  change_cents: 0,
  status: 'closed',
  created_at: '2026-08-19T10:00:00.000Z',
};

const ITEM = {
  sale_item_id: 'si-1',
  product_id: 'p-1',
  description: 'Camiseta',
  quantity: 1,
  total_cents: 10000,
  returned_quantity: 0,
  serialized: 0,
  units: [],
};

let passivo: { cents: number; customers: number } = { cents: 75_000, customers: 3 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);
      if (alvo.includes('/core/customer-credits/liability')) return json(passivo);
      if (alvo.includes('/core/cash/open')) {
        return json({ session: { id: 'sessao-7', status: 'aberto' }, cashWithdrawalLimitCents: null });
      }
      // A ordem importa: "sale-returns" não contém "sales".
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/returnable')) return json({ items: [ITEM] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA_ANONIMA, VENDA_COM_DONO] });
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da devolução em crédito',
  );
}

beforeEach(() => {
  passivo = { cents: 75_000, customers: 3 };
  localStorage.clear();
  servidor();
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da devolução em crédito');
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
}

/** Abre a venda de número N para devolução. */
async function abrir(numero: number) {
  montar();
  const linha = (await screen.findByText(`#${numero}`)).closest('tr')!;
  fireEvent.click(
    Array.from(linha.querySelectorAll('button')).find((b) => b.textContent === 'Devolver desta')!,
  );
  await screen.findByText('Camiseta');
}

function opcaoDoCredito(): HTMLOptionElement {
  const select = screen.getByLabelText(/Como o dinheiro volta/i) as HTMLSelectElement;
  return Array.from(select.options).find((o) => o.value === 'credito')!;
}

describe('o vale precisa de dono', () => {
  it('venda anônima: o crédito de loja fica indisponível, e a tela diz por quê', async () => {
    await abrir(42);

    expect(opcaoDoCredito().disabled).toBe(true);
    // Cinza sem motivo é pior que ausente: a pessoa não descobre sozinha que
    // basta identificar o cliente.
    expect(
      screen.getByText(/crédito de loja não está disponível/i).textContent,
    ).toMatch(/dinheiro|PIX|cart/i);
  });

  it('venda com cliente: o crédito de loja pode ser escolhido', async () => {
    await abrir(43);

    expect(opcaoDoCredito().disabled).toBe(false);
    expect(screen.queryByText(/crédito de loja não está disponível/i)).toBeNull();

    const select = screen.getByLabelText(/Como o dinheiro volta/i);
    fireEvent.change(select, { target: { value: 'credito' } });
    expect((select as HTMLSelectElement).value).toBe('credito');
  });

  it('o rótulo promete o que o sistema agora cumpre: vale gastável na próxima compra', async () => {
    await abrir(43);
    // Até esta rodada "crédito na loja" era um rótulo sem mecanismo — a dica
    // que promete o consumo só pode existir porque o consumo existe.
    expect(opcaoDoCredito().textContent).toMatch(/gastável na próxima compra/i);
  });
});

describe('o passivo em vale fica à vista', () => {
  it('a tela que concede o vale mostra quanto a loja já deve', async () => {
    montar();
    const aviso = await screen.findByTestId('passivo-em-vale');
    expect(aviso.textContent).toContain(formatCents(75_000));
    expect(aviso.textContent).toContain('3 clientes');
  });

  it('sem vale nenhum em aberto, o aviso não vira paisagem', async () => {
    passivo = { cents: 0, customers: 0 };
    montar();
    await screen.findByText('#42');
    await waitFor(() => expect(screen.queryByTestId('passivo-em-vale')).toBeNull());
  });
});
