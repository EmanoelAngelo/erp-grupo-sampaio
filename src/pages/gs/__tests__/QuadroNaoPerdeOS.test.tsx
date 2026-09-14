/**
 * A OS QUE SOME DO QUADRO E CONTINUA CORRENDO.
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 * `OficinaPage.load` pedia `/core/workshop/orders` SEM filtro de situação e SEM
 * limite. O servidor tem um padrão — 100 — e ordena por `number DESC`. Ou seja:
 * o quadro recebia as CEM OS DE NÚMERO MAIS ALTO, finalizadas incluídas, e
 * distribuía o que veio pelas sete colunas.
 *
 * Numa oficina que fecha 15 OS por dia, a centésima é de uma semana atrás. A OS
 * parada em "Aguardando peça" desde segunda tem número baixo, fica fora das
 * cem, e simplesmente NÃO APARECE em coluna nenhuma. Nada avisa: a coluna não
 * diz "mostrando 12 de 30", o quadro não diz "faltam 40". Some.
 *
 * E o relógio dela continua correndo. O SLA da rodada 51 é calculado no card —
 * card que não existe não acende, então a OS mais atrasada da oficina é
 * exatamente a que ninguém vê.
 *
 * O agravante é que o mecanismo se realimenta: quanto mais OS a oficina fecha,
 * mais fundo a antiga afunda. Some primeiro justamente na oficina movimentada.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Cada coluna pede a SUA lista, com a sua situação e o seu limite. Uma coluna
 * não pode mais engolir a cota da outra, e cada uma sabe o próprio total — que
 * o cabeçalho mostra quando há mais do que coube.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OficinaPage from '../OficinaPage';

const STATUSES = [
  'em_aberto',
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
  'aguardando_pagamento',
  'finalizada',
];

const SLA_PADRAO = {
  em_andamento: { urgente: 4, alta: 8, media: 16, baixa: 24 },
  manutencao_externa: { urgente: 24, alta: 48, media: 72, baixa: 96 },
  parada_setor: { urgente: 8, alta: 16, media: 24, baixa: 48 },
  aguardando_peca: { urgente: 48, alta: 72, media: 96, baixa: 120 },
};

function osDo(n: number, status: string) {
  const agora = new Date().toISOString();
  return {
    id: `os-${n}`,
    number: n,
    customer_name: `Cliente ${n}`,
    equipment: null,
    plate: null,
    complaint: 'Não liga',
    status,
    mechanic_id: 'user-mec',
    total_cents: 0,
    updated_at: agora,
    priority: 'media',
    due_date: null,
    status_changed_at: agora,
    customer_display: `Cliente ${n}`,
    customer_vinculado: 1,
    equipment_display: 'Scooter 1000W',
    mechanic_name: 'Zé Mecânico',
    workshop_name: 'Mobilidade',
  };
}

/**
 * A oficina movimentada: 120 finalizadas de número alto e UMA esperando peça
 * desde segunda, com número baixo.
 */
const OFICINA_MOVIMENTADA = [
  ...Array.from({ length: 120 }, (_, i) => osDo(200 + i, 'finalizada')),
  osDo(7, 'aguardando_peca'),
];

/** Os caminhos que a tela pediu — é aqui que se lê a decisão dela. */
let pedidos: string[] = [];

function servidor(base = OFICINA_MOVIMENTADA) {
  pedidos = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const alvo = String(url);
      const responder = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return responder({ ok: true });
      if (alvo.includes('/core/workshop/chamados')) return responder({ items: [] });
      if (alvo.includes('/core/workshop/orders')) {
        pedidos.push(alvo);
        const qs = new URLSearchParams(alvo.split('?')[1] ?? '');
        const filtro = (qs.get('status') ?? '').split(',').filter(Boolean);
        /*
          O SERVIDOR DE VERDADE: filtra pela situação pedida, ordena por número
          DESC e corta no limite. É este corte que fazia a OS antiga sumir
          quando a tela pedia tudo de uma vez.
        */
        const doFiltro = filtro.length
          ? base.filter((o) => filtro.includes(o.status))
          : base;
        const limite = Math.min(Number(qs.get('limit') ?? 100), 300);
        const ordenado = [...doFiltro].sort((a, b) => b.number - a.number);
        return responder({
          statuses: STATUSES,
          workshops: [{ id: 'ws-mob', name: 'Mobilidade' }],
          items: ordenado.slice(0, limite),
          total: doFiltro.length,
          sla: SLA_PADRAO,
          priorities: ['urgente', 'alta', 'media', 'baixa'],
        });
      }
      return responder({});
    }),
  );
}

function entrar() {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-mec', login: 'ze', displayName: 'Zé Mecânico', profileCode: 'mecanico' },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        {
          id: 'oficina',
          slug: 'oficina',
          tradeName: 'Oficina',
          kind: 'workshop',
          profileCode: 'mecanico',
        },
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
  entrar();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ============================================================================

describe('nenhuma coluna engole a cota da outra', () => {
  it('a OS de uma semana atrás continua no quadro depois de 120 finalizadas', async () => {
    montar();

    const coluna = await screen.findByRole('region', { name: 'Aguardando peça' });
    // Antes: as 120 finalizadas ocupavam as cem vagas, e a OS #7 não vinha na
    // resposta — coluna vazia, relógio correndo, ninguém sabendo.
    await waitFor(() => expect(within(coluna).getByText('OS #7')).toBeTruthy());
  });

  it('cada coluna pede a SUA situação', async () => {
    montar();
    await screen.findByRole('region', { name: 'Aguardando peça' });

    await waitFor(() => {
      const pedidas = pedidos
        .map((p) => new URLSearchParams(p.split('?')[1] ?? '').get('status'))
        .filter(Boolean);
      for (const status of STATUSES) {
        expect(pedidas, `nenhum pedido para a coluna ${status}`).toContain(status);
      }
    });
  });

  it('e nenhum pedido sai sem situação — pedir tudo é o defeito', async () => {
    montar();
    await screen.findByRole('region', { name: 'Aguardando peça' });

    await waitFor(() => expect(pedidos.length).toBeGreaterThan(0));
    for (const p of pedidos) {
      const qs = new URLSearchParams(p.split('?')[1] ?? '');
      expect(qs.get('status'), `pedido sem situação: ${p}`).toBeTruthy();
      // E com limite explícito: depender do padrão do servidor é como o
      // defeito nasceu.
      expect(qs.get('limit'), `pedido sem limite: ${p}`).toBeTruthy();
    }
  });
});

// ============================================================================

describe('o quadro diz quando não mostrou tudo', () => {
  it('a coluna com mais OS do que coube mostra o total', async () => {
    montar();

    const coluna = await screen.findByRole('region', { name: 'Finalizada' });
    /*
      120 finalizadas não cabem numa coluna de quadro, e não deveriam mesmo. O
      que não pode é o quadro FINGIR que são as que couberam: sem o total, quem
      olha conclui que a oficina fechou 60 esta semana.
    */
    await waitFor(() => expect(within(coluna).getByText(/120/)).toBeTruthy());
  });

  it('coluna que coube inteira não anuncia total nenhum', async () => {
    servidor([osDo(7, 'aguardando_peca'), osDo(8, 'aguardando_peca')]);
    montar();

    const coluna = await screen.findByRole('region', { name: 'Aguardando peça' });
    await waitFor(() => expect(within(coluna).getByText('OS #8')).toBeTruthy());
    expect(within(coluna).queryByText(/de 2$/)).toBeNull();
  });
});
