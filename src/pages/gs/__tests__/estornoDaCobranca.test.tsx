/**
 * ============================================================================
 * "ESTORNAR COBRANÇA" NA TELA DE CONTAS (GAP-PRD-092)
 * ============================================================================
 *
 * A ContasPage dizia, no próprio código, que "o caminho do dinheiro que entrou
 * é o estorno" — e não oferecia o estorno. Devolver o PIX de um título pago
 * era ir ao portal do Asaas e depois lembrar de estornar a baixa aqui.
 *
 * Estes testes olham o que sai no FIO: o botão aparece para a gerência sobre
 * cobrança de título PAGA (e sobre a já estornada no portal com baixa de pé),
 * a confirmação "desfazer também a baixa" viaja no corpo, e a resposta do
 * servidor é repetida como veio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContasPage from '../ContasPage';
import { setSession } from '@/lib/api/client';

const RESUMO = { openCents: 0, overdueCents: 0, settledCents: 30000, count: 0 };
const FAIXAS = { notDueCents: 0, days1to30Cents: 0, days31to60Cents: 0, days61to90Cents: 0, over90Cents: 0 };

function cobranca(parcial: Record<string, unknown>) {
  return {
    id: 'int-1',
    originType: 'finance_entry',
    originId: 'fin-1',
    originLabel: 'Aluguel da sala 2',
    method: 'pix',
    provider: 'asaas',
    environment: 'sandbox',
    amountCents: 30000,
    status: 'confirmed',
    providerRef: 'pay_1',
    invoiceUrl: null,
    lastError: null,
    attempts: 1,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    confirmedAt: '2026-09-01T12:00:00.000Z',
    settlementStanding: true,
    ...parcial,
  };
}

let cobrancas: Record<string, unknown>[];
let enviados: { url: string; method: string; body: Record<string, unknown> | undefined }[];
let respostaDoEstorno: () => Response;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      enviados.push({ url: alvo, method: metodo, body: init?.body ? JSON.parse(init.body) : undefined });
      if (alvo.includes('/charges/refund') && metodo === 'POST') return respostaDoEstorno();
      if (alvo.includes('/core/payment-intents')) return json({ items: cobrancas });
      if (alvo.includes('/core/finance/entries')) return json({ items: [], summary: RESUMO, aging: FAIXAS });
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
    'teste do estorno da cobrança',
  );
}

function montar() {
  return render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-receber']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  enviados = [];
  cobrancas = [cobranca({})];
  localStorage.clear();
  respostaDoEstorno = () =>
    json({
      intentId: 'int-1',
      providerRef: 'pay_1',
      estornadoNoProvedor: true,
      baixaDesfeita: true,
      baixaDePe: false,
      entry: null,
      detail: 'Estorno pedido e aceito pelo provedor. A baixa do título foi desfeita e ele voltou a ficar em aberto.',
    });
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do estorno da cobrança');
  localStorage.clear();
});

describe('GAP-PRD-092 — estornar a cobrança paga do título pela tela', () => {
  it('o gerente estorna: a confirmação e o motivo viajam no corpo, e a resposta vem inteira', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Estornar cobrança' }));
    const painel = screen.getByRole('region', { name: /Confirmar estorno/i });
    const caixa = within(painel).getByRole('checkbox');
    expect((caixa as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(painel).getByRole('textbox'), { target: { value: 'cliente desistiu' } });
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar estorno' }));

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/charges/refund'))).toBe(true));
    const pedido = enviados.find((e) => e.url.includes('/charges/refund'))!;
    expect(pedido.url).toContain('/core/finance/entries/fin-1/charges/refund');
    expect(pedido.method).toBe('POST');
    expect(pedido.body).toEqual({ desfazerBaixa: true, motivo: 'cliente desistiu' });
    expect(await screen.findByText(/A baixa do título foi desfeita/)).toBeTruthy();
  });

  it('desmarcar "desfazer a baixa" manda false — a decisão é de quem clica', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Estornar cobrança' }));
    const painel = screen.getByRole('region', { name: /Confirmar estorno/i });
    fireEvent.click(within(painel).getByRole('checkbox'));
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar estorno' }));

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/charges/refund'))).toBe(true));
    expect(enviados.find((e) => e.url.includes('/charges/refund'))!.body).toEqual({ desfazerBaixa: false });
  });

  it('a recusa do provedor aparece com as palavras do servidor', async () => {
    respostaDoEstorno = () =>
      json(
        { error: { code: 'CORE_CHARGE_REFUND_REFUSED', message: 'O provedor recusou o estorno: saldo insuficiente.' } },
        422,
      );
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Estornar cobrança' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar estorno' }));

    expect(await screen.findByText(/saldo insuficiente/)).toBeTruthy();
  });

  it('o caixa não vê o botão: devolver dinheiro é da gerência', async () => {
    entrarComo('operador_caixa_loja');
    montar();

    await screen.findByText('Aluguel da sala 2');
    expect(screen.queryByRole('button', { name: 'Estornar cobrança' })).toBeNull();
  });

  it('estornada no portal com a baixa de pé: o gesto é "Desfazer a baixa"', async () => {
    cobrancas = [cobranca({ status: 'refunded', settlementStanding: true })];
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Desfazer a baixa' }));
    expect(screen.getByText(/já voltou ao cliente/)).toBeTruthy();
  });

  it('sem nada a estornar — em aberto, ou estornada sem baixa de pé — não há botão', async () => {
    cobrancas = [
      cobranca({ id: 'int-aberta', status: 'pending', originLabel: 'Boleto em aberto' }),
      cobranca({ id: 'int-feita', status: 'refunded', settlementStanding: false, originLabel: 'Já resolvida' }),
      cobranca({ id: 'int-pedido', originType: 'ecommerce_order', originLabel: 'Pedido online #9' }),
    ];
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('Já resolvida');
    expect(screen.queryByRole('button', { name: 'Estornar cobrança' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desfazer a baixa' })).toBeNull();
  });
});
