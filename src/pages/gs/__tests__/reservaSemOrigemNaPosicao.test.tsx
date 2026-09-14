/**
 * A RESERVA PRESA NA POSIÇÃO DE ESTOQUE — GAP-PRD-087, o lado da tela.
 *
 * A coluna "Reservado" dizia quanto e nunca por quê. O cartão novo mostra o
 * produto, a conta e o documento que prendeu a mercadoria (o pedido online que
 * não existe mais), e dá à GERÊNCIA o gesto de soltar a parte sem origem — com
 * motivo, no corpo da requisição. Para quem não é gerência, o botão não existe
 * (a rota recusa) e a frase diz a quem pedir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { EstoquePage } from '../OperacaoPages';

const PROBLEMA = {
  check: 'STOCK_RESERVATION_WITHOUT_SOURCE',
  severity: 'critical',
  productId: 'p-bolsa',
  productName: 'Bolsa Conceito',
  detail: '1 reservado(s) e apenas 0 com origem aberta. A diferença segura mercadoria que ninguém está comprando.',
  reserved: 1,
  withSource: 0,
  semOrigem: 1,
  referencias: [
    {
      referenceType: 'ecommerce_order',
      referenceId: '57bee3bf-a951-4958-af27-4f0b5fbfe224',
      documentNumber: null,
      quantidade: 1,
      desde: '2026-08-15T12:01:59.000Z',
      situacao: 'inexistente',
      explicacao:
        'pedido da loja online 57bee3bf reservou 1 e não existe mais — ninguém soltou a reserva quando ele sumiu.',
    },
  ],
};

let pedidos: { url: string; method: string; body: unknown }[] = [];
let resolvido = false;

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    pedidos.push({ url: alvo, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (alvo.includes('/liberar-sem-origem') && method === 'POST') {
      resolvido = true;
      return json({
        productId: 'p-bolsa',
        productName: 'Bolsa Conceito',
        liberado: 1,
        reservadoAntes: 1,
        reservadoDepois: 0,
        semOrigemAntes: 1,
      });
    }
    if (alvo.includes('/core/stock/reconciliation')) {
      return json(
        resolvido
          ? { healthy: true, critical: 0, warnings: 0, issues: [] }
          : { healthy: false, critical: 1, warnings: 0, issues: [PROBLEMA] },
      );
    }
    if (alvo.includes('/core/stock/valuation')) return json({ totalCents: 0, produtosComSaldo: 0 });
    if (alvo.includes('/core/stock')) return json({ items: [] });
    return json({ items: [] });
  });
}

function entrarComo(perfil: string) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: perfil, displayName: perfil, profileCode: perfil },
      company: { id: 'conceito', slug: 'conceito', tradeName: 'Conceito', kind: 'retail' },
      companies: [
        { id: 'conceito', slug: 'conceito', tradeName: 'Conceito', kind: 'retail', profileCode: perfil },
      ],
    } as never,
    'LOGIN',
    'teste da reserva sem origem',
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  resolvido = false;
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderizar() {
  render(
    <MemoryRouter>
      <EstoquePage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-087 — a posição de estoque diz por que a peça está presa', () => {
  it('mostra o produto, a conta e o documento que não existe mais', async () => {
    entrarComo('gerente_loja');
    renderizar();
    expect(await screen.findByText('Reservas que precisam de conferência')).toBeTruthy();
    expect(screen.getByText('Bolsa Conceito')).toBeTruthy();
    expect(screen.getByText('Reserva sem origem')).toBeTruthy();
    expect(screen.getByText('documento não existe')).toBeTruthy();
    expect(screen.getByText(/não existe mais — ninguém soltou a reserva/)).toBeTruthy();
  });

  it('o gerente solta a reserva com motivo; o motivo viaja e o cartão some', async () => {
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar reserva sem origem' }));

    const confirmar = screen.getByRole('button', { name: /Liberar 1 sem origem/ });
    // Sem motivo o botão não anda — o servidor recusaria.
    expect((confirmar as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Motivo para liberar a reserva de Bolsa Conceito'), {
      target: { value: 'Pedido online apagado sem soltar a reserva' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Liberar 1 sem origem/ }));

    await waitFor(() =>
      expect(pedidos.some((p) => p.url.includes('/core/stock/reservations/p-bolsa/liberar-sem-origem'))).toBe(true),
    );
    const post = pedidos.find((p) => p.method === 'POST')!;
    expect(post.body).toEqual({ reason: 'Pedido online apagado sem soltar a reserva' });

    expect(await screen.findByText(/voltou a ficar disponível/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Reservas que precisam de conferência')).toBeNull());
  });

  it('o estoquista vê o problema e NÃO vê o botão — a frase manda chamar a gerência', async () => {
    entrarComo('estoquista');
    renderizar();
    expect(await screen.findByText('Bolsa Conceito')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Liberar reserva sem origem' })).toBeNull();
    expect(screen.getByText(/decisão da gerência/)).toBeTruthy();
  });

  it('sem problema, o cartão não ocupa a tela', async () => {
    resolvido = true;
    entrarComo('gerente_loja');
    renderizar();
    await waitFor(() =>
      expect(pedidos.some((p) => p.url.includes('/core/stock/reconciliation'))).toBe(true),
    );
    expect(screen.queryByText('Reservas que precisam de conferência')).toBeNull();
  });
});
