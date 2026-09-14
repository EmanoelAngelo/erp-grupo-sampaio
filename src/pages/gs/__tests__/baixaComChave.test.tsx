/**
 * A TELA DE CONTAS MANDA Idempotency-Key NA BAIXA (GAP-PRD-173).
 *
 * O servidor passou a reconhecer o reenvio da mesma baixa pela chave. Isto
 * cobra o lado da tela: a chave nasce no primeiro clique, é REUSADA quando a
 * resposta se perde e a pessoa clica de novo (é esse o reenvio que o servidor
 * reconhece), e morre depois da baixa bem-sucedida — a próxima parcial do
 * mesmo título é um pedido novo, com chave nova.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContasPage from '../ContasPage';
import { setSession } from '@/lib/api/client';

const FAIXAS = { notDueCents: 0, days1to30Cents: 0, days31to60Cents: 0, days61to90Cents: 0, over90Cents: 0 };

function titulo(saldo: number) {
  return {
    id: 'fin-1',
    companyId: 'loja',
    direction: 'in',
    description: 'Aluguel da sala 2',
    amountCents: 10000,
    settledCents: 10000 - saldo,
    balanceCents: saldo,
    status: saldo > 0 ? 'open' : 'settled',
    dueDate: '2026-09-20',
    settledAt: null,
    overdue: false,
    originType: 'manual',
    originId: 'fin-1',
    originLabel: null,
    installmentNumber: 1,
    installmentTotal: 1,
    categoryId: null,
    categoryName: null,
    costCenterId: null,
    accountId: null,
    competenceDate: '2026-09-20',
    note: null,
    counterpartyName: null,
    createdAt: '2026-09-01T12:00:00.000Z',
  };
}

let saldo: number;
let chaves: (string | undefined)[];
let falharProxima: boolean;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  saldo = 10000;
  chaves = [];
  falharProxima = false;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      if (alvo.includes('/settle') && metodo === 'POST') {
        chaves.push(init?.headers?.['Idempotency-Key']);
        if (falharProxima) {
          falharProxima = false;
          // A resposta que se perde: o servidor gravou, a tela não soube.
          saldo -= JSON.parse(init?.body ?? '{}').amountCents;
          throw new TypeError('Failed to fetch');
        }
        const pedido = JSON.parse(init?.body ?? '{}') as { amountCents: number };
        const reenvio = chaves.length >= 2 && chaves[chaves.length - 1] === chaves[chaves.length - 2];
        if (!reenvio) saldo -= pedido.amountCents;
        return json({ entry: titulo(saldo), settlements: [], replayed: reenvio });
      }
      if (alvo.includes('/settlements')) return json({ items: [] });
      if (alvo.includes('/core/finance/entries')) {
        return json({
          items: [titulo(saldo)],
          summary: { openCents: saldo, overdueCents: 0, settledCents: 10000 - saldo, count: 1, openCount: saldo > 0 ? 1 : 0 },
          aging: FAIXAS,
        });
      }
      return json({ items: [] });
    }),
  );
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
    'teste da baixa com chave',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste da baixa com chave');
  localStorage.clear();
});

async function abrirOTitulo() {
  render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-receber']}>
      <ContasPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Detalhes' }));
  const campo = await screen.findByLabelText('Valor a receber');
  fireEvent.change(campo, { target: { value: '30,00' } });
}

describe('GAP-PRD-173 — a baixa leva a chave do pedido', () => {
  it('a resposta se perdeu: o segundo clique manda a MESMA chave (o servidor reconhece o reenvio)', async () => {
    await abrirOTitulo();
    falharProxima = true;

    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    await waitFor(() => expect(chaves).toHaveLength(1));
    await screen.findByText('Falha ao dar baixa.');

    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    await waitFor(() => expect(chaves).toHaveLength(2));

    expect(chaves[0]).toMatch(/^baixa-/);
    expect(chaves[1]).toBe(chaves[0]);
    // O reenvio não baixou de novo: saldo de 70,00, não 40,00.
    expect(saldo).toBe(7000);
  });

  it('depois de uma baixa bem-sucedida, a próxima parcial é um pedido NOVO, com chave nova', async () => {
    await abrirOTitulo();

    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    await waitFor(() => expect(chaves).toHaveLength(1));
    await screen.findByText(/Baixa parcial registrada/);

    const campo = await screen.findByLabelText('Valor a receber');
    fireEvent.change(campo, { target: { value: '30,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    await waitFor(() => expect(chaves).toHaveLength(2));

    expect(chaves[1]).toMatch(/^baixa-/);
    expect(chaves[1]).not.toBe(chaves[0]);
    expect(saldo).toBe(4000);
  });

  it('mudar o valor depois da falha é outro pedido: chave nova', async () => {
    await abrirOTitulo();
    falharProxima = true;

    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    await waitFor(() => expect(chaves).toHaveLength(1));
    await screen.findByText('Falha ao dar baixa.');

    fireEvent.change(screen.getByLabelText('Valor a receber'), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    await waitFor(() => expect(chaves).toHaveLength(2));

    expect(chaves[1]).not.toBe(chaves[0]);
  });
});
