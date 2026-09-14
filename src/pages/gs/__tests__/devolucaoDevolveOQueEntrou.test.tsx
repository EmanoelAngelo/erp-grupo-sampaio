/**
 * A TELA DE DEVOLUÇÕES ANUNCIA O QUE O SERVIDOR VAI DEVOLVER, E TIRA DA GAVETA
 * DO CAIXA DESTE COMPUTADOR (GAP-PRD-009, GAP-PRD-050, GAP-PRD-161).
 *
 *   - "A devolver" era `round(total × qtd / vendida)` sobre o total BRUTO do
 *     desconto do rodapé: anunciava R$ 200,00 numa venda que recebeu R$ 180,00.
 *     Agora sai do líquido (`net_total_cents`) e do que já voltou
 *     (`returned_cents`), pela mesma conta do servidor.
 *   - A devolução em dinheiro e o cancelamento levam o caixa que o PDV guardou
 *     neste computador: com vários caixas, o dinheiro sai da gaveta de quem está
 *     aqui, e não da aberta mais recente.
 *   - A recusa do servidor (nenhuma gaveta aberta) chega com as palavras dele.
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
  subtotal_cents: 20000,
  discount_cents: 2000,
  total_cents: 18000,
  change_cents: 0,
  status: 'completed',
  note: null,
  created_at: '2026-08-18T10:00:00.000Z',
};

let item: Record<string, unknown>;
let respostaDoCaixa: Record<string, unknown>;
let recusaDaDevolucao: { code: string; message: string } | null;
let chamadas: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

const posts = (trecho: string) => chamadas.filter((c) => c.metodo === 'POST' && c.url.includes(trecho));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      chamadas.push({
        url: alvo,
        metodo,
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      if (alvo.includes('/core/cash/open')) return json(respostaDoCaixa);
      if (alvo.includes('/core/sale-returns') && metodo === 'POST') {
        if (recusaDaDevolucao) return json({ error: recusaDaDevolucao }, 409);
        return json({ id: 'r-1', number: 7, sale_number: 42, total_cents: 18000 }, 201);
      }
      if (alvo.includes('/cancel') && metodo === 'POST') return json({ ...VENDA, status: 'cancelled' });
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/returnable')) return json({ items: [item] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
      return json({ items: [] });
    }),
  );
}

beforeEach(() => {
  chamadas = [];
  recusaDaDevolucao = null;
  item = {
    sale_item_id: 'si-1',
    product_id: 'p-1',
    description: 'Camiseta',
    quantity: 2,
    total_cents: 20000,
    net_total_cents: 18000,
    returned_quantity: 0,
    returned_cents: 0,
    serialized: 0,
    units: [],
  };
  respostaDoCaixa = { session: { id: 'sessao-7', status: 'open' }, cashWithdrawalLimitCents: null };
  localStorage.clear();
  servidor();
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste de devolução',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de devolução');
  localStorage.clear();
});

async function escolher(quantidade: string, metodo = 'dinheiro') {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Devolver desta' }));
  await screen.findByText('Camiseta');
  fireEvent.change(screen.getByLabelText(/Devolver quantos de Camiseta/i), { target: { value: quantidade } });
  fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: 'Tamanho errado' } });
  fireEvent.change(screen.getByLabelText(/Como o dinheiro volta/i), { target: { value: metodo } });
}

// ============================================================================

describe('"A devolver" é o que o cliente pagou (GAP-PRD-009, GAP-PRD-050)', () => {
  it('venda com R$ 20 de desconto no rodapé: devolver as 2 anuncia R$ 180,00, e não R$ 200,00', async () => {
    await escolher('2');
    expect(screen.getByText(/A devolver:/).textContent).toContain('180,00');
    // E a tela diz por quê: o desconto do total entrou no item.
    expect(screen.getByTestId('desconto-do-rodape-rateado').textContent).toMatch(/desconto no total/);
  });

  it('devolver 1 de 2 anuncia a metade do líquido: R$ 90,00', async () => {
    await escolher('1');
    expect(screen.getByText(/A devolver:/).textContent).toContain('90,00');
  });

  it('a última fração devolve exatamente o que resta: linha de R$ 29,99 com 1.999 já devolvidos → R$ 10,00', async () => {
    item = {
      ...item,
      quantity: 3,
      total_cents: 2999,
      net_total_cents: 2999,
      returned_quantity: 2,
      returned_cents: 1999,
    };
    await escolher('1');
    expect(screen.getByText(/A devolver:/).textContent).toContain('10,00');
    // Sem desconto no rodapé não há o que explicar.
    expect(screen.queryByTestId('desconto-do-rodape-rateado')).toBeNull();
  });
});

describe('o dinheiro sai da gaveta do caixa deste computador (GAP-PRD-161)', () => {
  it('a consulta da gaveta e a devolução levam o caixa que o PDV guardou', async () => {
    localStorage.setItem('gs.pdv.terminal.loja', 'cx-2');
    await escolher('1');
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/i }));

    await waitFor(() => expect(posts('/core/sale-returns')).toHaveLength(1));
    const consulta = chamadas.find((c) => c.url.includes('/core/cash/open'));
    expect(consulta?.url).toContain('terminalId=cx-2');
    expect(posts('/core/sale-returns')[0].corpo?.terminalId).toBe('cx-2');
    expect(posts('/core/sale-returns')[0].corpo?.cashSessionId).toBe('sessao-7');
  });

  it('operação com caixas e este computador sem caixa escolhido: explica, e nada é enviado', async () => {
    respostaDoCaixa = { session: null, exigeTerminal: true, terminaisAtivos: 2, cashWithdrawalLimitCents: null };
    await escolher('1');
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/i }));

    expect(await screen.findByText(/Escolha o caixa no PDV/)).toBeTruthy();
    expect(posts('/core/sale-returns')).toHaveLength(0);
  });

  it('a recusa do servidor sem gaveta aberta aparece com as palavras dele', async () => {
    recusaDaDevolucao = {
      code: 'CORE_CASH_SESSION_REQUIRED',
      message: 'A devolução entrega R$ 90,00 em dinheiro ao cliente, e não há caixa aberto agora.',
    };
    await escolher('1');
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/i }));

    expect(await screen.findByText(/não há caixa aberto agora/)).toBeTruthy();
  });

  it('o cancelamento também leva o caixa deste computador', async () => {
    localStorage.setItem('gs.pdv.terminal.loja', 'cx-2');
    render(
      <MemoryRouter>
        <DevolucoesPage />
      </MemoryRouter>,
    );
    await screen.findByText('#42');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar venda' }));
    await screen.findByTestId('confirmar-cancelamento');
    // O motivo passou a ser obrigatório (E-venda-servidor-M01): sem ele o
    // botão não confirma, e este caso mede o caixa, não o motivo.
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'cliente desistiu' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancelar a venda #42/ }));

    await waitFor(() => expect(posts('/cancel')).toHaveLength(1));
    expect(posts('/cancel')[0].corpo?.terminalId).toBe('cx-2');
  });
});
