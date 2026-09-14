/**
 * DEVOLUÇÃO EM DINHEIRO SAI DA GAVETA — auditoria de entrega.
 *
 * ============================================================================
 * O DINHEIRO SAÍA E O SISTEMA NÃO VIA
 * ============================================================================
 *
 * A tela oferece três formas de devolver e descreve a primeira assim:
 *
 *     Dinheiro — "Sai da gaveta, se houver caixa aberto"
 *
 * O servidor cumpre a promessa: `SaleReturnService` lança o movimento negativo
 * na sessão, mas SÓ quando recebe `cashSessionId` — e a tela nunca mandava. Ela
 * não chamava `getOpenCash` em lugar nenhum. O resultado no balcão: o operador
 * tira as notas da gaveta, devolve ao cliente, e no fechamento a contagem dá
 * FALTA — do valor exato da devolução, sem nenhum movimento que explique. Quem
 * leva a culpa é quem estava no caixa.
 *
 * Duas coisas mudam:
 *
 *  1. a devolução em dinheiro manda a sessão aberta, e ela é lida na hora do
 *     envio (não na abertura da tela): entre abrir a tela e devolver pode ter
 *     passado um turno inteiro;
 *  2. sem caixa aberto, a devolução em dinheiro é RECUSADA, com a frase que diz
 *     o que fazer. Devolver espécie fora da gaveta é criar a diferença de
 *     propósito. Cartão e PIX seguem normalmente — esses voltam pela operadora,
 *     não pela gaveta.
 *
 * ============================================================================
 * CADA TESTE FICA VERMELHO QUANDO O GUARDA SAI
 * ============================================================================
 *
 *   - pare de mandar `cashSessionId` e o primeiro teste vê o corpo sem a
 *     sessão — que é exatamente o defeito que estava entregue;
 *   - deixe a devolução em dinheiro passar sem caixa e o segundo teste vê o
 *     POST que não deveria existir;
 *   - estenda a recusa ao cartão e o terceiro cai: estorno de cartão não
 *     depende de gaveta nenhuma.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA = {
  id: 's-1',
  number: 42,
  company_id: 'loja',
  customer_id: null,
  seller_id: null,
  cash_session_id: null,
  subtotal_cents: 10000,
  discount_cents: 0,
  total_cents: 10000,
  change_cents: 0,
  status: 'closed',
  note: null,
  created_at: '2026-08-18T10:00:00.000Z',
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

/** O caixa que a rota devolve na hora do envio — aberto ou nada. */
let caixaAberto: Record<string, unknown> | null;
let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

const devolucoes = () => enviados.filter((e) => e.url.includes('/core/sale-returns'));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') {
        enviados.push({
          url: alvo,
          metodo,
          corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        });
      }

      if (alvo.includes('/core/cash/open')) {
        return json({ session: caixaAberto, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/core/sale-returns') && metodo === 'POST') {
        return json({ id: 'r-1', number: 7, sale_number: 42, total_cents: 10000 }, 201);
      }
      // A ordem importa: "sale-returns" não contém "sales".
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/returnable')) return json({ items: [ITEM] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
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
    'teste de devolução',
  );
}

beforeEach(() => {
  enviados = [];
  caixaAberto = { id: 'sessao-7', opening_cents: 20000, status: 'aberto' };
  localStorage.clear();
  servidor();
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de devolução');
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
}

/** Escolhe a venda, marca o item inteiro e escreve o motivo. */
async function prepararDevolucao(metodo: 'dinheiro' | 'cartao') {
  montar();
  fireEvent.click(await screen.findByRole('button', { name: 'Devolver desta' }));
  await screen.findByText('Camiseta');

  const quantidade = screen.getByLabelText(/Devolver quantos de Camiseta/i);
  fireEvent.change(quantidade, { target: { value: '1' } });

  fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: 'Peça com defeito' } });
  fireEvent.change(screen.getByLabelText(/Como o dinheiro volta/i), { target: { value: metodo } });
}

// ============================================================================

describe('a devolução em dinheiro passa pela gaveta', () => {
  it('a sessão de caixa aberta vai no corpo — é ela que tira o dinheiro da gaveta', async () => {
    await prepararDevolucao('dinheiro');
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/i }));

    await waitFor(() => expect(devolucoes()).toHaveLength(1));
    /*
      Sem este campo o servidor pula o `INSERT` em `core_cash_movements` — o
      código está lá, íntegro, esperando um id que a tela nunca mandava. O
      dinheiro saía da gaveta pela mão do operador e não saía do sistema.
    */
    expect(devolucoes()[0].corpo?.cashSessionId).toBe('sessao-7');
  });

  it('sem caixa aberto, a devolução em dinheiro é recusada — e nada é enviado', async () => {
    caixaAberto = null;
    await prepararDevolucao('dinheiro');
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/i }));

    /*
      A prova é a AUSÊNCIA do POST. Registrar a devolução assim geraria o
      documento, estornaria estoque e comissão, e deixaria o dinheiro fora de
      qualquer gaveta — o fechamento do dia daria falta sem explicação.
    */
    expect(await screen.findByText(/caixa aberto/i)).toBeTruthy();
    expect(devolucoes()).toHaveLength(0);
  });

  it('cartão não depende de gaveta: devolve com o caixa fechado', async () => {
    caixaAberto = null;
    await prepararDevolucao('cartao');
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/i }));

    // Estorno de cartão volta pela operadora. Recusar aqui seria inventar uma
    // trava onde o dinheiro nem passa pelo balcão.
    await waitFor(() => expect(devolucoes()).toHaveLength(1));
    expect(devolucoes()[0].corpo?.cashSessionId ?? null).toBeNull();
  });
});
