/**
 * O QUADRO NA TELA — retrato no movimento, coluna que pagina e OS fora das
 * regras (GAP-PRD-183, GAP-PRD-187, GAP-PRD-188).
 *
 * Cada caso morre com uma mutação concreta:
 *   - tire `expectedStatus`/`expectedStatusChangedAt` do POST e o primeiro
 *     caso falha (o servidor não teria como recusar o retrato velho);
 *   - tire o recarregamento no 409 e o card continua na coluna errada;
 *   - tire `ordem=quadro` do pedido da coluna e a coluna volta a pedir as
 *     mais novas;
 *   - tire o botão "Carregar mais" e as dez mais antigas ficam fora do quadro.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OficinaPage from '../OficinaPage';

const INSTANTE = '2026-09-10T12:00:00.000Z';

function osDo(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `os-${n}`,
    number: n,
    customer_name: `Cliente ${n}`,
    equipment: null,
    plate: null,
    complaint: null,
    status: 'em_andamento',
    mechanic_id: 'user-ger',
    total_cents: 0,
    updated_at: new Date().toISOString(),
    priority: 'media',
    due_date: null,
    status_changed_at: new Date().toISOString(),
    customer_display: `Cliente ${n}`,
    customer_vinculado: 1,
    equipment_display: 'Scooter',
    mechanic_name: 'Gerente',
    workshop_name: 'Mobilidade',
    irregularidades: [],
    ...extra,
  };
}

const STATUSES = [
  'em_aberto',
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
  'aguardando_pagamento',
  'finalizada',
];

let ordens: ReturnType<typeof osDo>[];
let pedidos: string[];
let escritas: { url: string; body: Record<string, unknown> }[];
/** Resposta de erro a devolver na próxima escrita, se houver. */
let recusaDaEscrita: { status: number; body: unknown } | null;
/** Total fingido por coluna (para testar a paginação sem 70 objetos à mão). */
let totalFingido: Record<string, number>;

function servidor() {
  pedidos = [];
  escritas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const responder = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (metodo !== 'GET') {
        escritas.push({ url: alvo, body: init?.body ? JSON.parse(init.body) : {} });
        if (recusaDaEscrita) {
          const r = recusaDaEscrita;
          recusaDaEscrita = null;
          return responder(r.body, r.status);
        }
        return responder({ ok: true });
      }
      if (alvo.includes('/core/workshop/chamados')) return responder({ items: [] });
      if (alvo.includes('/core/workshop/orders')) {
        pedidos.push(alvo);
        const qs = new URLSearchParams(alvo.split('?')[1] ?? '');
        const status = qs.get('status') ?? '';
        const limite = Number(qs.get('limit') ?? 100);
        const deslocamento = Number(qs.get('offset') ?? 0);
        const daColuna = ordens.filter((o) => o.status === status);
        const pagina = daColuna.slice(deslocamento, deslocamento + limite);
        return responder({
          statuses: STATUSES,
          workshops: [{ id: 'ws-mob', name: 'Mobilidade' }],
          items: pagina,
          total: totalFingido[status] ?? daColuna.length,
          sla: {},
          priorities: ['urgente', 'alta', 'media', 'baixa'],
        });
      }
      return responder({});
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-ger', login: 'g', displayName: 'Gerente', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

function montar() {
  render(
    <MemoryRouter>
      <OficinaPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ordens = [osDo(1, { status_changed_at: INSTANTE })];
  recusaDaEscrita = null;
  totalFingido = {};
  entrarComo('gerente_oficina');
  servidor();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function moverPeloSeletor(numero: number, para: string, observacao: string) {
  fireEvent.change(screen.getByLabelText(`Situação da OS ${numero}`), { target: { value: para } });
  await screen.findByText(new RegExp(`Mover a OS #${numero}`));
  fireEvent.change(screen.getByLabelText(/Observação obrigatória/), {
    target: { value: observacao },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar mudança' }));
}

describe('GAP-PRD-183 — o movimento leva o retrato que o card mostrava', () => {
  it('o POST carrega a situação e o instante que o card tinha', async () => {
    montar();
    await screen.findByText('OS #1');
    await moverPeloSeletor(1, 'aguardando_peca', 'Peça pedida');

    await waitFor(() => expect(escritas).toHaveLength(1));
    expect(escritas[0].body).toEqual({
      status: 'aguardando_peca',
      comment: 'Peça pedida',
      expectedStatus: 'em_andamento',
      expectedStatusChangedAt: INSTANTE,
    });
  });

  it('409 da OS que mudou: a mensagem do servidor fica na tela e o quadro recarrega com a coluna real', async () => {
    recusaDaEscrita = {
      status: 409,
      body: {
        error: {
          code: 'CORE_ORDER_STALE',
          message:
            'A OS #1 mudou desde que você abriu o quadro: agora está em "Manutenção externa" '
            + '(último movimento: Zé). Recarregue e confira antes de mover.',
        },
      },
    };
    montar();
    await screen.findByText('OS #1');
    const pedidosAntes = pedidos.length;
    // Enquanto isso, outra pessoa moveu a OS.
    ordens = [osDo(1, { status: 'manutencao_externa', status_changed_at: new Date().toISOString() })];

    await moverPeloSeletor(1, 'aguardando_peca', 'Peça pedida');

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('agora está em "Manutenção externa"');
    await waitFor(() => expect(pedidos.length).toBeGreaterThan(pedidosAntes));
    const coluna = await screen.findByRole('region', { name: 'Manutenção externa' });
    await waitFor(() => expect(within(coluna).queryByText('OS #1')).not.toBeNull());
    // A mensagem sobrevive ao recarregamento — é ela que explica o salto.
    expect(screen.getByRole('alert').textContent).toContain('Manutenção externa');
  });
});

describe('GAP-PRD-187 — a coluna pagina a partir das mais antigas', () => {
  it('as colunas de trabalho pedem a ordem do quadro; a de finalizadas, as mais recentes', async () => {
    montar();
    await screen.findByText('OS #1');
    const daColuna = (s: string) => pedidos.find((p) => p.includes(`status=${s}&`) || p.endsWith(`status=${s}`))!;
    expect(daColuna('aguardando_peca')).toContain('ordem=quadro');
    expect(daColuna('em_andamento')).toContain('ordem=quadro');
    expect(daColuna('finalizada')).not.toContain('ordem=quadro');
  });

  it('com mais de 60 na coluna, "carregar mais" busca a próxima página e as antigas entram no quadro', async () => {
    ordens = Array.from({ length: 70 }, (_, i) => osDo(100 + i, { status: 'aguardando_peca' }));
    montar();
    const coluna = await screen.findByRole('region', { name: 'Aguardando peça' });
    await waitFor(() => expect(within(coluna).getAllByRole('listitem')).toHaveLength(60));
    expect(within(coluna).getByText('60 de 70')).toBeTruthy();
    expect(within(coluna).queryByText('OS #165')).toBeNull();

    fireEvent.click(within(coluna).getByRole('button', { name: 'Carregar mais 10 de 10' }));

    await waitFor(() => expect(within(coluna).getAllByRole('listitem')).toHaveLength(70));
    const pagina2 = pedidos.find((p) => p.includes('status=aguardando_peca') && p.includes('offset=60'));
    expect(pagina2).toContain('ordem=quadro');
    expect(within(coluna).getByText('OS #169')).toBeTruthy();
    expect(within(coluna).queryByRole('button', { name: /Carregar mais/ })).toBeNull();
  });

  it('o recarregamento depois de um movimento não encolhe a coluna de volta a 60', async () => {
    ordens = [
      osDo(1, { status_changed_at: INSTANTE }),
      ...Array.from({ length: 70 }, (_, i) => osDo(100 + i, { status: 'aguardando_peca' })),
    ];
    montar();
    const coluna = await screen.findByRole('region', { name: 'Aguardando peça' });
    await waitFor(() => expect(within(coluna).getAllByRole('listitem')).toHaveLength(60));
    fireEvent.click(within(coluna).getByRole('button', { name: 'Carregar mais 10 de 10' }));
    await waitFor(() => expect(within(coluna).getAllByRole('listitem')).toHaveLength(70));

    await moverPeloSeletor(1, 'parada_setor', 'Aguardando pintura');
    await waitFor(() => expect(escritas).toHaveLength(1));
    await waitFor(() =>
      expect(pedidos.some((p) => p.includes('status=aguardando_peca') && p.includes('limit=70'))).toBe(true),
    );
  });
});

describe('GAP-PRD-188 — o card da OS fora das regras avisa e leva à ficha', () => {
  it('sem bancada e sem responsável aparecem no card, com link para a ficha', async () => {
    ordens = [
      osDo(1, {
        mechanic_id: null,
        mechanic_name: null,
        irregularidades: ['sem_bancada', 'sem_responsavel'],
      }),
    ];
    montar();
    const aviso = await screen.findByText(/Fora das regras: sem bancada, sem responsável/);
    expect(aviso.closest('a')?.getAttribute('href')).toBe('/sistema/oficina/os/os-1');
  });

  it('OS dentro das regras não ganha aviso nenhum', async () => {
    montar();
    await screen.findByText('OS #1');
    expect(screen.queryByText(/Fora das regras/)).toBeNull();
  });
});
