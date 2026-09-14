/**
 * O CANCELAMENTO DIZ O QUE ENTROU DEPOIS — a tela de Devoluções na reauditoria
 * da trilha "venda" do Preço Justo.
 *
 *   E-venda-servidor-R01 a venda a prazo paga depois em Contas a receber (ou o
 *                        PIX pendente baixado à mão) não aparecia em nenhum
 *                        campo do resumo, e a tela transformava o resumo zero
 *                        em "Nada desta venda tinha sido recebido, então não há
 *                        dinheiro a devolver" — para uma venda que o cliente
 *                        tinha pago.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA = {
  id: 's-1',
  number: 42,
  company_id: 'loja',
  customer_id: 'c-1',
  seller_id: null,
  cash_session_id: null,
  subtotal_cents: 20000,
  discount_cents: 0,
  total_cents: 20000,
  change_cents: 0,
  status: 'completed',
  note: null,
  created_at: '2026-09-14T10:00:00.000Z',
};

const json = (dado: unknown, status = 200) =>
  new Response(JSON.stringify(dado), { status, headers: { 'Content-Type': 'application/json' } });

const ZERADO = {
  gavetaCents: 0,
  aDevolverAMao: { dinheiro: 0, credito: 0, debito: 0, pix: 0 },
  maquininhaCents: 0,
  valeDevolvidoCents: 0,
  valeRevogadoCents: 0,
  jaDevolvidoCents: 0,
};

function servidor(reembolso: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (alvo.includes('/cancel') && metodo === 'POST') {
        return json({ ...VENDA, status: 'cancelled', estornosNaMaquininha: [], reembolso });
      }
      if (alvo.includes('/returnable')) return json({ items: [] });
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
      return json({ items: [] });
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
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
    'teste do cancelamento com recebimento depois',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do cancelamento com recebimento depois');
  localStorage.clear();
});

async function cancelarAVenda() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
  await screen.findByText('#42');
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar venda' }));
  await screen.findByTestId('confirmar-cancelamento');
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'cliente devolveu o item' } });
  fireEvent.click(screen.getByRole('button', { name: /Cancelar a venda #42/ }));
  return screen.findByText(/Venda #42 cancelada/);
}

describe('E-venda-servidor-R01 — o aviso do cancelamento não diz "nada recebido" do que entrou depois', () => {
  it('fiada paga depois em dinheiro: manda devolver os R$ 200 pelo meio da baixa', async () => {
    servidor({ ...ZERADO, recebidoDepois: { cents: 20000, meios: ['dinheiro'] } });
    const aviso = await cancelarAVenda();
    expect(aviso.textContent).toMatch(/Devolva R\$\s200,00 ao cliente pelo meio em que ele pagou \(Dinheiro\)/);
    expect(aviso.textContent).toMatch(/recebido depois, em Contas a receber/);
    // Antes: "Nada desta venda tinha sido recebido, então não há dinheiro a devolver."
    expect(aviso.textContent).not.toMatch(/Nada desta venda tinha sido recebido/);
  });

  it('baixa sem meio informado: diz que o meio não foi informado, e ainda manda devolver', async () => {
    servidor({ ...ZERADO, recebidoDepois: { cents: 8000, meios: ['não informado'] } });
    const aviso = await cancelarAVenda();
    expect(aviso.textContent).toMatch(/Devolva R\$\s80,00 .*meio não informado na baixa/);
    expect(aviso.textContent).not.toMatch(/Nada desta venda tinha sido recebido/);
  });

  it('controle: nada entrou em lugar nenhum — continua dizendo que não há o que devolver', async () => {
    servidor({ ...ZERADO, recebidoDepois: { cents: 0, meios: [] } });
    const aviso = await cancelarAVenda();
    expect(aviso.textContent).toMatch(/Nada desta venda tinha sido recebido/);
  });
});
