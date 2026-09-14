/**
 * A DECISÃO DO ORÇAMENTO NA MÃO DO DONO — rodada 43.
 *
 * O lado do portal do que a OrdemServicoFechamento prova do lado da oficina:
 * o pedido de aprovação chega na ficha do aparelho, e o dono decide ALI —
 * aprovar ou recusar — sem telefone, sem "combinado de boca".
 *
 * Também se prova aqui o elo do QR: a plaquinha manda o dono para esta tela
 * com `?equipamento=#0001`, e a ficha daquele aparelho abre sozinha. Sem isso,
 * o caminho da calçada até o histórico termina numa LISTA — e a rodada 37 já
 * mediu o que acontece com beco: ninguém entra.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MeusEquipamentosPage from '../MeusEquipamentosPage';

const PORTAL_KEY = 'gs.portal';

function sessaoValida() {
  return {
    token: 'tok-portal-teste',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    account: { id: 'acc-1', email: 'marta@exemplo.com' },
  };
}

interface OrdemDoPortal {
  id: string;
  number: number;
  status: string;
  complaint: string | null;
  diagnosis: string | null;
  laborCents: number;
  partsCents: number;
  totalCents: number;
  createdAt: string;
  closedAt: string | null;
  approvalRequestedAt: string | null;
  approvedAt: string | null;
}

const EQUIPAMENTO = {
  id: 'eq-1',
  publicIdLabel: '#0007',
  brand: 'Shineray',
  model: 'PT2',
  color: 'preta',
  workshopName: 'Oficina de Mobilidade',
  companyName: 'Oficina',
  serialNumber: null,
  plate: null,
};

/** A lista do servidor (`ORDER_STATUSES_ON_BENCH`). */
const NA_BANCADA = ['em_aberto', 'em_andamento', 'manutencao_externa', 'parada_setor', 'aguardando_peca'];

let ordens: OrdemDoPortal[];
/** POSTs que a tela fez — a prova de qual rota decidiu o quê. */
let decisoes: string[];

function ordemPedida(): OrdemDoPortal {
  return {
    id: 'os-9',
    number: 9,
    status: 'em_andamento',
    complaint: 'não liga',
    diagnosis: null,
    laborCents: 15000,
    partsCents: 0,
    totalCents: 15000,
    createdAt: '2026-08-20T12:00:00.000Z',
    closedAt: null,
    approvalRequestedAt: '2026-08-23T10:00:00.000Z',
    approvedAt: null,
  };
}

/** O dublê decide como o servidor: aprovar preenche, recusar limpa. */
function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    const decisao = alvo.match(/\/loja\/portal\/ordens\/([^/]+)\/(aprovar|recusar)$/);
    if (metodo === 'POST' && decisao) {
      decisoes.push(`${decisao[2]} ${decisao[1]}`);
      const ordem = ordens.find((o) => o.id === decisao[1])!;
      if (decisao[2] === 'aprovar') {
        ordem.approvedAt = '2026-08-23T11:00:00.000Z';
      } else {
        ordem.approvalRequestedAt = null;
        ordem.approvedAt = null;
      }
      return responder({ ordem });
    }
    if (/\/loja\/portal\/equipamentos\/[^/]+$/.test(alvo)) {
      // `aguardandoDecisao` vem pronto, como o servidor o calcula (GAP-PRD-182):
      // pedido de pé, sem resposta, e a OS ainda na bancada.
      return responder({
        equipamento: EQUIPAMENTO,
        ordens: ordens.map((o) => ({
          ...o,
          aguardandoDecisao:
            Boolean(o.approvalRequestedAt) && !o.approvedAt && NA_BANCADA.includes(o.status),
        })),
      });
    }
    if (alvo.includes('/loja/portal/equipamentos')) {
      return responder({ items: [EQUIPAMENTO] });
    }
    if (alvo.includes('/loja/portal/chamados')) return responder({ items: [] });
    return responder({});
  });
}

beforeEach(() => {
  ordens = [ordemPedida()];
  decisoes = [];
  localStorage.clear();
  localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar(entrada = '/minha-conta/equipamentos') {
  render(
    <MemoryRouter initialEntries={[entrada]}>
      <Routes>
        <Route path="/minha-conta/equipamentos" element={<MeusEquipamentosPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function abrirFicha() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Ver histórico e pedir serviço' }),
  );
  await screen.findByText('Serviços feitos para você');
}

describe('a decisão do orçamento', () => {
  it('o pedido pendente aparece com o VALOR, e aprovar chama a rota certa', async () => {
    montar();
    await abrirFicha();
    // O valor é o que se aprova — sem ele a decisão seria às cegas.
    await screen.findByText('Orçamento de R$ 150,00 aguardando a sua aprovação.');

    fireEvent.click(screen.getByRole('button', { name: 'Aprovar orçamento' }));
    await waitFor(() => {
      expect(decisoes).toEqual(['aprovar os-9']);
    });
    // A ficha recarregou: o registro com data fica no lugar dos botões.
    await screen.findByText(/Orçamento aprovado por você em/);
    expect(screen.queryByRole('button', { name: 'Aprovar orçamento' })).toBeNull();
  });

  it('recusar chama a rota de recusa — e o convite some, como o servidor limpou', async () => {
    montar();
    await abrirFicha();
    await screen.findByText('Orçamento de R$ 150,00 aguardando a sua aprovação.');

    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    await waitFor(() => {
      expect(decisoes).toEqual(['recusar os-9']);
    });
    await waitFor(() => {
      expect(
        screen.queryByText('Orçamento de R$ 150,00 aguardando a sua aprovação.'),
      ).toBeNull();
    });
  });

  it('OS que já saiu da bancada não oferece a decisão, mesmo com o pedido pendurado (GAP-PRD-182)', async () => {
    // O estado que o código antigo deixava: pedido de pé numa OS na fila do caixa.
    ordens = [{ ...ordemPedida(), status: 'aguardando_pagamento' }];
    montar();
    await abrirFicha();
    expect(screen.queryByText('Orçamento de R$ 150,00 aguardando a sua aprovação.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aprovar orçamento' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recusar' })).toBeNull();
    expect(decisoes).toEqual([]);
  });

  it('sem pedido pendente não há botão nenhum — não se decide o que não foi pedido', async () => {
    ordens = [{ ...ordemPedida(), approvalRequestedAt: null }];
    montar();
    await abrirFicha();
    expect(screen.queryByRole('button', { name: 'Aprovar orçamento' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recusar' })).toBeNull();
  });
});

describe('o elo do QR', () => {
  it('?equipamento=#0007 abre a ficha daquele aparelho sozinho', async () => {
    montar('/minha-conta/equipamentos?equipamento=%230007');
    // Sem clique nenhum: a ficha do aparelho da plaquinha já está aberta.
    await screen.findByText('Serviços feitos para você');
    await screen.findByText('Orçamento de R$ 150,00 aguardando a sua aprovação.');
  });

  it('etiqueta desconhecida não abre ficha nenhuma — só a lista', async () => {
    montar('/minha-conta/equipamentos?equipamento=%230099');
    await screen.findByRole('button', { name: 'Ver histórico e pedir serviço' });
    expect(screen.queryByText('Serviços feitos para você')).toBeNull();
  });
});
