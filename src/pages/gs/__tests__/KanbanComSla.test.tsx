/**
 * O QUADRO DA OFICINA NA TELA — prioridade, SLA e observação (rodada 51).
 *
 * ## Por que este arquivo nasce agora
 *
 * O kanban nunca teve teste de tela: nenhum `__tests__` montava `OficinaPage`.
 * A rodada muda justamente o comportamento dele — a ordem dos cards, o alerta
 * do relógio, e o fato de que soltar um card NÃO move mais nada até a
 * observação ser escrita. Um teste de servidor não alcança isso: lá o guarda
 * já existe e devolve 400; aqui se prova que a tela PERGUNTA em vez de deixar
 * a requisição falhar.
 *
 * Cada caso morre com uma mutação concreta:
 *   - tire a ordenação por prioridade e o urgente deixa de vir primeiro;
 *   - troque `status_changed_at` por `updated_at` no cálculo e o card recém
 *     movido volta a acender (é o defeito do sistema antigo);
 *   - mande o movimento direto no `onChange` e o POST sai sem observação;
 *   - deixe o botão habilitado com o campo vazio e o quadro anda calado.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OficinaPage from '../OficinaPage';

/** Uma OS como o board a devolve. */
function osDo(
  n: number,
  extra: Partial<{
    status: string;
    priority: string;
    due_date: string | null;
    status_changed_at: string;
    mechanic_id: string | null;
  }> = {},
) {
  const agora = new Date().toISOString();
  return {
    id: `os-${n}`,
    number: n,
    customer_name: `Cliente ${n}`,
    equipment: null,
    plate: null,
    complaint: 'Não liga',
    status: 'em_andamento',
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
    ...extra,
  };
}

const SLA_PADRAO = {
  em_andamento: { urgente: 4, alta: 8, media: 16, baixa: 24 },
  manutencao_externa: { urgente: 24, alta: 48, media: 72, baixa: 96 },
  parada_setor: { urgente: 8, alta: 16, media: 24, baixa: 48 },
  aguardando_peca: { urgente: 48, alta: 72, media: 96, baixa: 120 },
};

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
/** Toda escrita que a tela fez: método, caminho e corpo. */
let escritas: { url: string; body: Record<string, unknown> }[];

function servidor() {
  escritas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const responder = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (metodo !== 'GET') {
        escritas.push({ url: alvo, body: corpo });
        return responder({ ok: true });
      }
      if (alvo.includes('/core/workshop/chamados')) return responder({ items: [] });
      if (alvo.includes('/core/workshop/orders')) {
        /*
          O SERVIDOR FILTRA PELA SITUAÇÃO PEDIDA.

          O quadro passou a pedir uma lista POR COLUNA — antes ele pedia tudo
          de uma vez e as cem OS de número mais alto engoliam a cota das
          outras colunas. Devolver a lista inteira em cada pedido faria o
          mesmo card aparecer nas sete colunas, que é este dublê mentindo, e
          não a tela errando.
        */
        const filtro = (new URLSearchParams(alvo.split('?')[1] ?? '').get('status') ?? '')
          .split(',')
          .filter(Boolean);
        const itens = filtro.length ? ordens.filter((o) => filtro.includes(o.status)) : ordens;
        return responder({
          statuses: STATUSES,
          workshops: [{ id: 'ws-mob', name: 'Mobilidade' }],
          items: itens,
          total: itens.length,
          sla: SLA_PADRAO,
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
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-mec', login: 'ze', displayName: 'Zé Mecânico', profileCode },
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
  ordens = [osDo(1)];
  entrarComo('mecanico');
  servidor();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o quadro mostra prioridade, relógio e prazo', () => {
  it('urgente vem primeiro na coluna, e a mais antiga desempata', async () => {
    ordens = [
      osDo(10, { priority: 'baixa' }),
      osDo(11, { priority: 'urgente' }),
      osDo(12, { priority: 'media' }),
      osDo(9, { priority: 'urgente' }),
    ];
    montar();

    const coluna = await screen.findByRole('region', { name: 'Em andamento' });
    const cards = within(coluna).getAllByRole('listitem');
    const numeros = cards.map((c) => within(c).getByRole('link').textContent);
    expect(numeros).toEqual(['OS #9', 'OS #11', 'OS #12', 'OS #10']);
  });

  it('OS parada além da régua acende; a recém-movida NÃO acende', async () => {
    const vinteHorasAtras = new Date(Date.now() - 20 * 3_600_000).toISOString();
    ordens = [
      // 20h na coluna com régua de 16h (media) → estourado.
      osDo(20, { status_changed_at: vinteHorasAtras }),
      // Acabou de entrar na coluna — mesmo tendo sido tocada agora.
      osDo(21, { status_changed_at: new Date().toISOString() }),
    ];
    montar();

    await screen.findByText('OS #20');
    expect(screen.getByText('⏱ 20h/16h')).toBeTruthy();
    // Um alerta, e um só: a OS #21 acabou de entrar na coluna e fica limpa.
    expect(screen.getAllByText(/⏱/)).toHaveLength(1);
  });

  it('o relógio é a COLUNA, não o toque: updated_at velho não acende card novo', async () => {
    /*
      O defeito do sistema antigo, que ficou lá: lá o alerta contava do
      updatedAt. Aqui a OS foi movida agora (status_changed_at recente) e o
      updated_at é antigo — o card tem de ficar limpo.
    */
    ordens = [
      osDo(30, {
        status_changed_at: new Date().toISOString(),
      }),
    ];
    ordens[0].updated_at = new Date(Date.now() - 90 * 3_600_000).toISOString();
    montar();

    await screen.findByText('OS #30');
    expect(screen.queryByText(/⏱/)).toBeNull();
  });

  it('o prazo prometido aparece, e o vencido fala em atraso', async () => {
    /*
      A data é montada a partir do dia LOCAL, não de `Date.now()` menos
      milissegundos: a conta do card é entre dias de calendário do fuso de
      quem lê, e montar em UTC faria o teste dizer 2d ou 3d conforme a hora em
      que a suíte roda (o defeito de fuso que a rodada 52 consertou).
    */
    const hoje = new Date();
    const tresDiasAtras = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 3);
    const iso = `${tresDiasAtras.getFullYear()}-${String(tresDiasAtras.getMonth() + 1).padStart(2, '0')}-${String(tresDiasAtras.getDate()).padStart(2, '0')}`;
    ordens = [osDo(40, { due_date: iso })];
    montar();

    await screen.findByText('OS #40');
    expect(screen.getByText(/3d atraso/)).toBeTruthy();
  });

  it('o prazo de HOJE é hoje o dia inteiro — inclusive às 22h', async () => {
    /*
      A conta era `new Date('2026-08-30') - Date.now()`: meia-noite UTC contra
      hora local. No Brasil (UTC-3), das 21h em diante o prazo de hoje já
      aparecia como "1d atraso" — o card mentia toda noite. A conta é entre
      DIAS locais.
    */
    // `shouldAdvanceTime` deixa o relógio falso andar sozinho — sem isso o
    // `findByText` (que espera em timer) trava para sempre.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // 22h da noite no fuso local, num dia qualquer.
      const noite = new Date(2026, 7, 30, 22, 0, 0);
      vi.setSystemTime(noite);
      ordens = [osDo(41, { due_date: '2026-08-30' })];
      montar();

      await screen.findByText('OS #41');
      expect(screen.getByText(/📅 Hoje/)).toBeTruthy();
      expect(screen.queryByText(/atraso/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a régua vem do SERVIDOR: personalizada, o alerta muda de faixa', async () => {
    /*
      Sem ler `data.sla`, a tela poderia ter a matriz padrão embutida e passar
      no resto dos casos. Aqui a empresa personalizou "em andamento/média"
      para 100h: uma OS de 20h que acenderia no padrão (16h) fica limpa.
    */
    const vinteHoras = new Date(Date.now() - 20 * 3_600_000).toISOString();
    ordens = [osDo(50, { status_changed_at: vinteHoras })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const alvo = String(url);
        const responder = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        if (alvo.includes('/core/workshop/chamados')) return responder({ items: [] });
        if (alvo.includes('/core/workshop/orders')) {
          // O mesmo filtro por situação do dublê principal: o quadro pede uma
          // lista por coluna.
          const filtro = (new URLSearchParams(alvo.split('?')[1] ?? '').get('status') ?? '')
            .split(',')
            .filter(Boolean);
          const itens = filtro.length ? ordens.filter((o) => filtro.includes(o.status)) : ordens;
          return responder({
            statuses: STATUSES,
            workshops: [{ id: 'ws-mob', name: 'Mobilidade' }],
            items: itens,
            total: itens.length,
            sla: { ...SLA_PADRAO, em_andamento: { ...SLA_PADRAO.em_andamento, media: 100 } },
            priorities: ['urgente', 'alta', 'media', 'baixa'],
          });
        }
        return responder({});
      }),
    );
    montar();

    await screen.findByText('OS #50');
    expect(screen.queryByText(/⏱/)).toBeNull();
  });
});

describe('o arrasto tem a mesma régua do seletor', () => {
  it('coluna que não se move NÃO aceita o card — nem abre o bloco de observação', async () => {
    /*
      O `select` já filtrava por MOVABLE; o arrasto não filtrava nada. Soltar
      em "Finalizada" abria o bloco, a pessoa escrevia o porquê, e só então
      levava 409 do servidor. Duas portas para a mesma ação, mesma régua.
    */
    montar();
    const card = await screen.findByText('OS #1');
    const li = card.closest('li')!;

    fireEvent.dragStart(li);
    const finalizada = screen.getByRole('region', { name: 'Finalizada' });
    fireEvent.dragOver(finalizada);
    fireEvent.drop(finalizada);

    await waitFor(() => expect(screen.queryByText(/Mover a OS #1/)).toBeNull());
    expect(escritas).toHaveLength(0);
  });

  it('coluna operacional aceita: arrastar abre o bloco e confirma o movimento', async () => {
    montar();
    const card = await screen.findByText('OS #1');
    fireEvent.dragStart(card.closest('li')!);
    const alvo = screen.getByRole('region', { name: 'Aguardando peça' });
    fireEvent.dragOver(alvo);
    fireEvent.drop(alvo);

    await screen.findByText(/Mover a OS #1 para "Aguardando peça"/);
    fireEvent.change(screen.getByLabelText(/Observação obrigatória/), {
      target: { value: 'Peça pedida ao fornecedor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar mudança' }));

    await waitFor(() => expect(escritas).toHaveLength(1));
    expect(escritas[0].body.status).toBe('aguardando_peca');
  });
});

describe('o quadro não anda calado', () => {
  it('escolher outra coluna PERGUNTA a observação — e nada é enviado antes dela', async () => {
    montar();
    await screen.findByText('OS #1');

    fireEvent.change(screen.getByLabelText('Situação da OS 1'), {
      target: { value: 'aguardando_peca' },
    });

    // O bloco apareceu e NENHUMA escrita saiu ainda.
    await screen.findByText(/Mover a OS #1 para "Aguardando peça"/);
    expect(escritas).toHaveLength(0);
    // Confirmar fica bloqueado enquanto o campo estiver vazio.
    expect(
      (screen.getByRole('button', { name: 'Confirmar mudança' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('com a observação escrita, o movimento vai ao servidor COM ela', async () => {
    montar();
    await screen.findByText('OS #1');

    fireEvent.change(screen.getByLabelText('Situação da OS 1'), {
      target: { value: 'aguardando_peca' },
    });
    await screen.findByText(/Mover a OS #1/);
    fireEvent.change(screen.getByLabelText(/Observação obrigatória/), {
      target: { value: 'Peça encomendada no fornecedor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar mudança' }));

    await waitFor(() => expect(escritas).toHaveLength(1));
    expect(escritas[0].url).toContain('/core/workshop/orders/os-1/move');
    // O retrato do card vai junto (GAP-PRD-183): situação e instante que a
    // tela mostrava — é com eles que o servidor recusa o movimento velho.
    expect(escritas[0].body).toEqual({
      status: 'aguardando_peca',
      comment: 'Peça encomendada no fornecedor',
      expectedStatus: 'em_andamento',
      expectedStatusChangedAt: ordens[0].status_changed_at,
    });
  });

  it('cancelar descarta o movimento — o card fica onde estava', async () => {
    montar();
    await screen.findByText('OS #1');

    fireEvent.change(screen.getByLabelText('Situação da OS 1'), {
      target: { value: 'parada_setor' },
    });
    await screen.findByText(/Mover a OS #1/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByText(/Mover a OS #1/)).toBeNull());
    expect(escritas).toHaveLength(0);
  });

  it('OS em aberto: o bloco fala em ASSUMIR e chama a rota do assumir', async () => {
    ordens = [osDo(2, { status: 'em_aberto', mechanic_id: null })];
    montar();
    await screen.findByText('OS #2');

    fireEvent.change(screen.getByLabelText('Situação da OS 2'), {
      target: { value: 'em_andamento' },
    });
    await screen.findByText(/Assumir a OS #2/);
    fireEvent.change(screen.getByLabelText(/Observação obrigatória/), {
      target: { value: 'Bateria inchada, troca do pack' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assumir e mover' }));

    await waitFor(() => expect(escritas).toHaveLength(1));
    expect(escritas[0].url).toContain('/core/workshop/orders/os-2/assume');
  });
});

describe('a régua do SLA na tela', () => {
  it('o mecânico não vê o botão de editar os tempos', async () => {
    montar();
    await screen.findByText('OS #1');
    expect(screen.queryByRole('button', { name: 'Tempos de resposta' })).toBeNull();
  });

  it('o gerente edita e salva a matriz inteira', async () => {
    entrarComo('gerente_oficina');
    montar();
    await screen.findByText('OS #1');

    fireEvent.click(screen.getByRole('button', { name: 'Tempos de resposta' }));
    const celula = await screen.findByLabelText('Em andamento · Urgente');
    expect((celula as HTMLInputElement).value).toBe('4');

    fireEvent.change(celula, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar tempos' }));

    await waitFor(() => expect(escritas).toHaveLength(1));
    expect(escritas[0].url).toContain('/core/workshop/sla');
    expect(
      (escritas[0].body.matrix as Record<string, Record<string, number>>).em_andamento.urgente,
    ).toBe(2);
  });
});
