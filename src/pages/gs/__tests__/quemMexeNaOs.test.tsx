/**
 * QUEM ABRE, QUEM ANOTA E QUEM MEXE NA OS — pela tela (GAP-PRD-099, 102, 103, 182).
 *
 * ## O que cada bloco derruba
 *
 *   - tire o "Abrir OS" do PDV e o caixa da oficina (que mora no ambiente
 *     `pdv`) volta a não ter onde receber o aparelho do cliente;
 *   - mande a abertura sem bancada numa empresa de duas e o servidor recusa
 *     com o cliente na frente — a tela pergunta antes (PDV, quadro e cadastro
 *     de equipamento);
 *   - ofereça a caixa de comentário ao mecânico que não assumiu a OS e ele
 *     leva 403; esconda-a do atendente e o balcão perde a voz;
 *   - esconda o "Devolver" do gerente e a devolução volta a depender de o
 *     técnico assumir de novo;
 *   - mostre "orçamento aguardando o cliente" numa OS que já virou conta e a
 *     ficha contradiz o servidor, que recusa a decisão ali.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';
import OrdemServicoPage from '../OrdemServicoPage';
import OficinaPage from '../OficinaPage';
import EquipamentosPage from '../EquipamentosPage';

interface Pedido {
  alvo: string;
  metodo: string;
  corpo: Record<string, unknown>;
}

const BANCADA_A = { id: 'wk-a', slug: 'mob-a', name: 'Bancada A', kind: 'mobility' };
const BANCADA_B = { id: 'wk-b', slug: 'mob-b', name: 'Bancada B', kind: 'mobility' };

const STATUSES = [
  'em_aberto',
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
  'aguardando_pagamento',
  'finalizada',
];
const SLA = {
  em_andamento: { urgente: 4, alta: 8, media: 16, baixa: 24 },
  manutencao_externa: { urgente: 24, alta: 48, media: 72, baixa: 96 },
  parada_setor: { urgente: 8, alta: 16, media: 24, baixa: 48 },
  aguardando_peca: { urgente: 48, alta: 72, media: 96, baixa: 120 },
};

let pedidos: Pedido[];
let bancadas: (typeof BANCADA_A)[];
let osDaFicha: Record<string, unknown>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (metodo !== 'GET') pedidos.push({ alvo, metodo, corpo });

      if (alvo.includes('/core/workshop/entrada')) return json({ items: bancadas });
      if (alvo.includes('/core/workshop/pending-payment')) {
        return json({
          items: [],
          total: 0,
          temOficina: true,
          faturamentoAPrazo: { habilitado: false, prazoDias: 0 },
        });
      }
      if (metodo === 'POST' && /\/core\/workshop\/orders$/.test(alvo)) {
        return json({ id: 'os-nova', number: 77, status: 'em_aberto', workshop_id: corpo.workshopId ?? 'wk-a' }, 201);
      }
      if (metodo === 'POST' && /\/core\/equipment$/.test(alvo)) {
        return json({ id: 'eq-novo', public_id: 12, publicIdLabel: '#0012' }, 201);
      }
      if (metodo === 'POST' && alvo.endsWith('/comments')) {
        const comentarios = osDaFicha.comments as Record<string, unknown>[];
        comentarios.push({
          id: `c-${comentarios.length + 1}`,
          body: corpo.body,
          author_name: 'Ana do Balcão',
          author_kind: 'balcao',
          created_at: '2026-09-11T13:00:00.000Z',
        });
        return json({ ok: true }, 201);
      }
      if (alvo.includes('/core/workshop/orders?')) {
        return json({ statuses: STATUSES, workshops: [BANCADA_A, BANCADA_B], items: [], total: 0, sla: SLA });
      }
      if (/\/core\/workshop\/orders\/[^/?]+$/.test(alvo)) return json(osDaFicha);
      if (alvo.includes('/core/workshop/chamados')) return json({ items: [] });
      if (alvo.includes('/core/cash/current') || alvo.includes('/core/cash/open')) {
        return json({ session: { id: 'gaveta', opening_cents: 0, status: 'open' }, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/payment-methods')) return json({ methods: [] });
      if (alvo.includes('/terminal/status')) {
        return json({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string, userId = 'user-1', displayName = 'Pessoa') {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: userId, login: userId, displayName, profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [{ id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode }],
    },
    'LOGIN',
    'client.login',
  );
}

function fichaAssumidaPor(mecanicoId: string): Record<string, unknown> {
  return {
    id: 'os-50',
    number: 50,
    status: 'em_andamento',
    workshop_id: 'wk-a',
    workshop_name: 'Bancada A',
    mechanic_id: mecanicoId,
    mechanic_name: 'Zé Mecânico',
    customer_id: null,
    customer_display: 'Seu Jorge',
    customer_phone: null,
    equipment_display: 'Shineray PT2',
    equipment_public_id: null,
    equipment_serial: null,
    plate: null,
    complaint: 'não liga',
    diagnosis: null,
    labor_cents: 5000,
    parts_cents: 10000,
    total_cents: 15000,
    opened_by_customer: 0,
    approval_requested_at: null,
    approved_at: null,
    sale_id: null,
    paid_at: null,
    priority: 'media',
    due_date: null,
    created_at: '2026-09-10T12:00:00.000Z',
    parts: [
      {
        id: 'sp-1',
        description: 'Controlador',
        quantity: 2,
        unit_price_cents: 5000,
        total_cents: 10000,
        returned_quantity: 0,
      },
    ],
    comments: [
      {
        id: 'c-0',
        body: 'Cliente pagou o sinal.',
        author_name: 'Caixa da Oficina',
        author_kind: 'balcao',
        created_at: '2026-09-10T12:30:00.000Z',
      },
    ],
    events: [],
  };
}

beforeEach(() => {
  pedidos = [];
  bancadas = [BANCADA_A];
  osDaFicha = fichaAssumidaPor('user-mec');
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montarPdv() {
  render(
    <MemoryRouter initialEntries={['/pdv']}>
      <PdvPage />
    </MemoryRouter>,
  );
}

function montarFicha() {
  render(
    <MemoryRouter initialEntries={['/sistema/oficina/os/os-50']}>
      <Routes>
        <Route path="/sistema/oficina/os/:id" element={<OrdemServicoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function aberturas(): Pedido[] {
  return pedidos.filter((p) => p.metodo === 'POST' && /\/core\/workshop\/orders$/.test(p.alvo));
}

// ============================================================================

describe('GAP-PRD-099 — o balcão da oficina abre a OS', () => {
  it('o caixa da oficina abre a OS pelo PDV; com uma bancada, a tela não pergunta', async () => {
    entrarComo('operador_caixa_oficina', 'user-caixa', 'Caixa da Oficina');
    montarPdv();
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir OS' }));
    const dialogo = within(await screen.findByRole('dialog', { name: 'Abrir OS' }));
    // Uma bancada só: nada a escolher.
    await waitFor(() =>
      expect((vi.mocked(fetch).mock.calls as unknown[][]).some((c) => String(c[0]).includes('/workshop/entrada'))).toBe(true),
    );
    expect(dialogo.queryByLabelText(/Bancada/)).toBeNull();

    fireEvent.change(dialogo.getByLabelText(/Cliente/), { target: { value: 'Dona Célia' } });
    fireEvent.change(dialogo.getByLabelText('Aparelho'), { target: { value: 'Honda Pop' } });
    fireEvent.change(dialogo.getByLabelText('Placa / gaveta'), { target: { value: 'ABC1D23' } });
    fireEvent.change(dialogo.getByLabelText('Defeito relatado'), { target: { value: 'Não liga' } });
    fireEvent.click(dialogo.getByRole('button', { name: 'Abrir OS' }));

    await waitFor(() => expect(aberturas()).toHaveLength(1));
    const [pedido] = aberturas();
    expect(pedido.corpo).toMatchObject({
      customerName: 'Dona Célia',
      customerId: null,
      equipment: 'Honda Pop',
      plate: 'ABC1D23',
      complaint: 'Não liga',
      priority: 'media',
    });
    expect(pedido.corpo.workshopId).toBeUndefined();
    expect(await screen.findByText(/OS #77 aberta/)).toBeTruthy();
  });

  it('com duas bancadas, o PDV pergunta a bancada e não abre sem ela', async () => {
    bancadas = [BANCADA_A, BANCADA_B];
    entrarComo('operador_caixa_oficina', 'user-caixa', 'Caixa da Oficina');
    montarPdv();
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir OS' }));
    const dialogo = within(await screen.findByRole('dialog', { name: 'Abrir OS' }));
    const seletor = (await dialogo.findByLabelText(/Bancada/)) as HTMLSelectElement;

    fireEvent.change(dialogo.getByLabelText(/Cliente/), { target: { value: 'Dona Célia' } });
    fireEvent.click(dialogo.getByRole('button', { name: 'Abrir OS' }));
    expect(await dialogo.findByText('Escolha a bancada onde a OS vai entrar.')).toBeTruthy();
    expect(aberturas()).toHaveLength(0);

    fireEvent.change(seletor, { target: { value: 'wk-b' } });
    fireEvent.click(dialogo.getByRole('button', { name: 'Abrir OS' }));
    await waitFor(() => expect(aberturas()).toHaveLength(1));
    expect(aberturas()[0].corpo.workshopId).toBe('wk-b');
  });

  it('o caixa da LOJA não ganha o "Abrir OS"', async () => {
    entrarComo('operador_caixa_loja', 'user-loja', 'Caixa da Loja');
    montarPdv();
    await screen.findByRole('button', { name: /Cliente \(F2\)/ });
    expect(screen.queryByRole('button', { name: 'Abrir OS' })).toBeNull();
  });

  it('o atendente abre a OS pelo quadro escolhendo a bancada quando há duas', async () => {
    bancadas = [BANCADA_A, BANCADA_B];
    entrarComo('atendente', 'user-at', 'Ana do Balcão');
    render(
      <MemoryRouter>
        <OficinaPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Nova OS' }));
    const seletor = (await screen.findByLabelText(/Bancada/)) as HTMLSelectElement;
    fireEvent.change(screen.getByLabelText(/Cliente/), { target: { value: 'Seu Jorge' } });

    fireEvent.submit(seletor.closest('form')!);
    expect(await screen.findByText('Escolha a bancada onde a OS vai entrar.')).toBeTruthy();
    expect(aberturas()).toHaveLength(0);

    fireEvent.change(seletor, { target: { value: 'wk-a' } });
    fireEvent.submit(seletor.closest('form')!);
    await waitFor(() => expect(aberturas()).toHaveLength(1));
    expect(aberturas()[0].corpo).toMatchObject({ workshopId: 'wk-a', customerName: 'Seu Jorge' });
  });

  it('o atendente cadastra o equipamento na bancada escolhida', async () => {
    bancadas = [BANCADA_A, BANCADA_B];
    entrarComo('atendente', 'user-at', 'Ana do Balcão');
    render(
      <MemoryRouter>
        <EquipamentosPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar equipamento' }));
    const seletor = (await screen.findByLabelText(/Bancada/)) as HTMLSelectElement;
    fireEvent.click(screen.getByRole('radio', { name: 'Do grupo' }));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e gerar plaquinha' }));
    expect(await screen.findByText('Escolha a bancada da máquina.')).toBeTruthy();

    fireEvent.change(seletor, { target: { value: 'wk-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar e gerar plaquinha' }));
    await waitFor(() =>
      expect(pedidos.filter((p) => /\/core\/equipment$/.test(p.alvo)).map((p) => p.corpo.workshopId)).toEqual(['wk-b']),
    );
  });
});

describe('GAP-PRD-102 — o balcão anota na linha do tempo', () => {
  it('o atendente comenta em OS assumida por um mecânico, e a fala aparece como do balcão', async () => {
    entrarComo('atendente', 'user-at', 'Ana do Balcão');
    montarFicha();
    // A anotação que já estava lá tem a voz do balcão.
    expect((await screen.findAllByText('Anotação do balcão')).length).toBe(1);

    fireEvent.change(await screen.findByLabelText('Novo comentário'), {
      target: { value: 'Cliente ligou perguntando do prazo.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar' }));
    await waitFor(() =>
      expect(pedidos.filter((p) => p.alvo.endsWith('/comments')).map((p) => p.corpo.body)).toEqual([
        'Cliente ligou perguntando do prazo.',
      ]),
    );
    await waitFor(() => expect(screen.getAllByText('Anotação do balcão')).toHaveLength(2));
  });

  it('o mecânico que não assumiu a OS não ganha a caixa de comentário', async () => {
    entrarComo('mecanico', 'user-outro-mec', 'Outro Mecânico');
    montarFicha();
    await screen.findByText('Seu Jorge');
    expect(screen.queryByLabelText('Novo comentário')).toBeNull();
  });

  it('o mecânico responsável continua comentando', async () => {
    entrarComo('mecanico', 'user-mec', 'Zé Mecânico');
    montarFicha();
    expect(await screen.findByLabelText('Novo comentário')).toBeTruthy();
  });
});

describe('GAP-PRD-103 — a devolução de peça tem a régua do servidor', () => {
  it('o gerente da oficina devolve peça de OS de outro técnico', async () => {
    entrarComo('gerente_oficina', 'user-ger', 'Gerente');
    montarFicha();
    const card = (await screen.findByText('Peças aplicadas')).closest('section') as HTMLElement;
    expect(await within(card).findByRole('button', { name: 'Devolver' })).toBeTruthy();
    expect(within(card).getByText(/a gerência pode devolver a que sobrou/)).toBeTruthy();
  });

  it('o mecânico que não assumiu não vê o Devolver', async () => {
    entrarComo('mecanico', 'user-outro-mec', 'Outro Mecânico');
    montarFicha();
    const card = (await screen.findByText('Peças aplicadas')).closest('section') as HTMLElement;
    await within(card).findByText('Controlador');
    expect(within(card).queryByRole('button', { name: 'Devolver' })).toBeNull();
  });
});

describe('GAP-PRD-182 — orçamento pendurado fora da bancada não é anunciado', () => {
  it('OS na fila do caixa com pedido de aprovação antigo não mostra "aguardando o cliente"', async () => {
    osDaFicha = {
      ...fichaAssumidaPor('user-mec'),
      status: 'aguardando_pagamento',
      approval_requested_at: '2026-09-01T10:00:00.000Z',
    };
    entrarComo('gerente_oficina', 'user-ger', 'Gerente');
    montarFicha();
    await screen.findByText('Seu Jorge');
    expect(screen.queryByText('Orçamento aguardando o cliente')).toBeNull();
  });

  it('na bancada, o pedido pendente continua anunciado', async () => {
    osDaFicha = { ...fichaAssumidaPor('user-mec'), approval_requested_at: '2026-09-01T10:00:00.000Z' };
    entrarComo('gerente_oficina', 'user-ger', 'Gerente');
    montarFicha();
    expect(await screen.findByText('Orçamento aguardando o cliente')).toBeTruthy();
  });
});
