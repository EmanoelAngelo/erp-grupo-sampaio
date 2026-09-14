/**
 * A OS FORA DAS REGRAS NA FICHA — e o conserto pela tela (GAP-PRD-188).
 *
 * O que cada caso derruba:
 *   - esconda o cartão e a OS #1 do banco da loja volta a precisar de SQL;
 *   - mande a regularização sem motivo e o servidor recusa com o gerente na
 *     frente — a tela barra antes;
 *   - ofereça "encerrar" numa OS com mão de obra e o servidor recusa com 409;
 *   - mostre o formulário ao mecânico e ele leva 403.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OrdemServicoPage from '../OrdemServicoPage';

interface Pedido {
  alvo: string;
  metodo: string;
  corpo: Record<string, unknown>;
}

let pedidos: Pedido[];
let ficha: Record<string, unknown>;
let bancadas: { id: string; slug: string; name: string; kind: string }[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function osLegada(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'os-1',
    number: 1,
    status: 'em_andamento',
    workshop_id: null,
    workshop_name: null,
    mechanic_id: null,
    mechanic_name: null,
    customer_id: null,
    customer_display: 'Teste',
    customer_phone: null,
    equipment_display: null,
    equipment_public_id: null,
    equipment_serial: null,
    plate: null,
    complaint: 'teste',
    diagnosis: null,
    labor_cents: 0,
    parts_cents: 0,
    total_cents: 0,
    opened_by_customer: 0,
    approval_requested_at: null,
    approved_at: null,
    sale_id: null,
    paid_at: null,
    priority: 'media',
    due_date: null,
    status_changed_at: '2026-08-12T10:00:00.000Z',
    created_at: '2026-08-12T10:00:00.000Z',
    irregularidades: ['sem_bancada', 'sem_responsavel'],
    parts: [],
    comments: [],
    events: [],
    ...extra,
  };
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (metodo !== 'GET') pedidos.push({ alvo, metodo, corpo });
      if (metodo === 'POST' && alvo.endsWith('/regularizar')) {
        ficha = { ...ficha, status: 'em_aberto', workshop_id: 'wk-a', irregularidades: [] };
        return json(ficha);
      }
      if (alvo.includes('/core/workshop/entrada')) return json({ items: bancadas });
      if (/\/core\/workshop\/orders\/[^/?]+$/.test(alvo)) return json(ficha);
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Pessoa', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [{ id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode }],
    },
    'LOGIN',
    'client.login',
  );
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/oficina/os/os-1']}>
      <Routes>
        <Route path="/sistema/oficina/os/:id" element={<OrdemServicoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  pedidos = [];
  ficha = osLegada();
  bancadas = [{ id: 'wk-a', slug: 'a', name: 'Bancada A', kind: 'mobility' }];
  entrarComo('gerente_oficina');
  servidor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('GAP-PRD-188 — a ficha da OS fora das regras', () => {
  it('diz o que está fora e o gerente devolve ao quadro com motivo', async () => {
    montar();
    await screen.findByText('A OS #1 está fora das regras atuais');
    expect(screen.getByText(/Sem bancada/)).toBeTruthy();
    expect(screen.getByText(/sem responsável/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Regularizar' }));
    // Sem motivo o botão nem habilita: nada sai para o servidor.
    const confirmar = screen.getByRole('button', { name: 'Confirmar regularização' }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo/), {
      target: { value: 'OS de antes da bancada existir' },
    });
    fireEvent.click(confirmar);

    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0].alvo).toContain('/core/workshop/orders/os-1/regularizar');
    expect(pedidos[0].corpo).toEqual({ destino: 'quadro', motivo: 'OS de antes da bancada existir' });
    // A ficha recarrega e o cartão some: a OS voltou às regras.
    await waitFor(() => expect(screen.queryByText(/fora das regras atuais/)).toBeNull());
  });

  it('encerrar como lançamento indevido vai com o destino certo; com duas bancadas, a bancada é escolhida', async () => {
    bancadas = [
      { id: 'wk-a', slug: 'a', name: 'Bancada A', kind: 'mobility' },
      { id: 'wk-b', slug: 'b', name: 'Bancada B', kind: 'mobility' },
    ];
    montar();
    await screen.findByText('A OS #1 está fora das regras atuais');
    fireEvent.click(screen.getByRole('button', { name: 'Regularizar' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Encerrar como lançamento indevido' }));
    const campoBancada = await screen.findByLabelText(/Bancada/);
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'OS de teste' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar regularização' }));
    // Com duas bancadas, sem escolher, a tela pergunta antes do servidor.
    expect(await screen.findByText('Escolha a bancada em que a OS vai ficar.')).toBeTruthy();
    expect(pedidos).toHaveLength(0);

    fireEvent.change(campoBancada, { target: { value: 'wk-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar regularização' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0].corpo).toEqual({ destino: 'encerrar', motivo: 'OS de teste', workshopId: 'wk-b' });
  });

  it('OS com mão de obra não oferece "encerrar": só lançamento sem dinheiro é indevido', async () => {
    ficha = osLegada({ labor_cents: 3000, total_cents: 3000, irregularidades: ['sem_responsavel'], workshop_id: 'wk-a' });
    montar();
    await screen.findByText('A OS #1 está fora das regras atuais');
    fireEvent.click(screen.getByRole('button', { name: 'Regularizar' }));
    expect(
      (screen.getByRole('radio', { name: 'Encerrar como lançamento indevido' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('o mecânico vê o aviso e a quem pedir, sem o formulário', async () => {
    entrarComo('mecanico');
    montar();
    await screen.findByText('A OS #1 está fora das regras atuais');
    expect(screen.getByText(/Peça ao gerente/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Regularizar' })).toBeNull();
  });

  it('OS dentro das regras não mostra cartão nenhum', async () => {
    ficha = osLegada({ irregularidades: [], workshop_id: 'wk-a', mechanic_id: 'user-1' });
    montar();
    await screen.findAllByText(/OS #1/);
    expect(screen.queryByText(/fora das regras atuais/)).toBeNull();
  });
});
