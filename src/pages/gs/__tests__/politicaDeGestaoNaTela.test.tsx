/**
 * A POLÍTICA DE GESTÃO NA TELA — GAP-PRD-165 (quem vê dinheiro) e GAP-PRD-166
 * (a régua do valor do estoque).
 *
 * As duas decisões moravam no código. Estes casos cobram que:
 *
 *   - a tela da política mostra os padrões seguros como "não decidida", deixa o
 *     DONO decidir (e manda a decisão inteira ao servidor), e para o gerente é
 *     leitura — sem botão;
 *   - o painel, com o dinheiro reservado à gerência, diz por quê e não mostra
 *     "R$ 0,00" que pareceria dia sem venda;
 *   - a posição de estoque diz a régua que fez o número, e que o contador ainda
 *     não a confirmou — ou que o valor é da gerência.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { setSession } from '@/lib/api/client';
import PoliticaGestaoPage from '../PoliticaGestaoPage';
import PainelPage from '../PainelPage';
import { EstoquePage } from '../OperacaoPages';

const PADRAO = {
  painelFinanceiroEquipe: false,
  custoDoEstoqueEquipe: false,
  reguaDeValorizacao: 'ultimo_custo',
  reguaConfirmadaPor: null,
  reguaConfirmadaEm: null,
  decidida: false,
  updatedBy: null,
  updatedAt: null,
};

let pedidos: { url: string; method: string; body: unknown }[] = [];
let respostas: Record<string, unknown> = {};

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    pedidos.push({ url: alvo, method, body });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (alvo.includes('/core/management-policy') && method === 'PUT') {
      return json({
        policy: {
          ...PADRAO,
          ...body,
          decidida: true,
          reguaConfirmadaEm: body.reguaConfirmadaPor ? '2026-09-11T12:00:00.000Z' : null,
          updatedAt: '2026-09-11T12:00:00.000Z',
        },
      });
    }
    if (alvo.includes('/core/management-policy')) return json({ policy: PADRAO });
    for (const [trecho, resposta] of Object.entries(respostas)) {
      if (alvo.includes(trecho)) return json(resposta);
    }
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
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: perfil }],
    } as never,
    'LOGIN',
    'teste da política de gestão',
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  respostas = {};
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar(tela: ReactElement) {
  render(<MemoryRouter>{tela}</MemoryRouter>);
}

describe('GAP-PRD-165/166 — a tela da política', () => {
  it('o dono vê os padrões como "não decidida", decide, e a decisão inteira viaja', async () => {
    entrarComo('admin_geral');
    montar(<PoliticaGestaoPage />);
    expect(await screen.findByText(/O dono ainda não decidiu/)).toBeTruthy();
    expect(screen.getByText('Aguardando o contador')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /faturamento, ticket médio e contas a receber/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Custo médio/ }));
    fireEvent.change(screen.getByLabelText(/Confirmada pelo contador/), { target: { value: 'Contabilidade Silva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar política' }));

    await waitFor(() => expect(pedidos.some((p) => p.method === 'PUT')).toBe(true));
    expect(pedidos.find((p) => p.method === 'PUT')!.body).toEqual({
      painelFinanceiroEquipe: true,
      custoDoEstoqueEquipe: false,
      reguaDeValorizacao: 'custo_medio',
      reguaConfirmadaPor: 'Contabilidade Silva',
    });
    // O selo troca: a pendência some e a confirmação aparece (o rótulo do campo
    // tem o mesmo texto, por isso são dois).
    await waitFor(() => expect(screen.queryByText('Aguardando o contador')).toBeNull());
    expect(screen.getAllByText('Confirmada pelo contador')).toHaveLength(2);
  });

  it('para o gerente é leitura: tudo travado e sem botão de salvar', async () => {
    entrarComo('gerente_loja');
    montar(<PoliticaGestaoPage />);
    expect(await screen.findByText(/Só o dono do grupo altera/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /faturamento, ticket médio/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Salvar política' })).toBeNull();
  });
});

describe('GAP-PRD-165 — o painel com o dinheiro reservado à gerência', () => {
  it('diz por quê, mostra as vendas e não mostra faturamento, ticket nem recebíveis', async () => {
    respostas['/core/dashboard'] = {
      revenueCents: null,
      salesCount: 7,
      averageTicketCents: null,
      openReceivablesCents: null,
      dinheiroOculto: true,
      byDay: [{ day: '2026-09-10', sales_count: 7, revenue_cents: null }],
      topProducts: [],
      bySeller: [{ seller_id: 's-1', seller_name: 'Ana', sales_count: 7, revenue_cents: null }],
      byBrand: [],
      byBrandUnallocatedCents: null,
      companyId: 'loja',
      companies: [{ id: 'loja', tradeName: 'Loja' }],
      lowStock: [],
      lowStockTotal: 0,
      certificateAlert: null,
    };
    entrarComo('atendente');
    montar(<PainelPage />);
    expect(await screen.findByText(/reservados à gerência pela política/)).toBeTruthy();
    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.queryByText('Faturamento')).toBeNull();
    expect(screen.queryByText('Ticket médio')).toBeNull();
    expect(screen.queryByText('A receber em aberto')).toBeNull();
    expect(screen.queryByText(/R\$/)).toBeNull();
  });
});

describe('GAP-PRD-165/166 — a posição de estoque diz a régua, ou que o valor é da gerência', () => {
  it('custo médio sem confirmação do contador: a frase diz as duas coisas', async () => {
    respostas['/core/stock/valuation'] = {
      totalCents: 30000,
      produtosComSaldo: 1,
      oculto: false,
      regua: 'custo_medio',
      reguaConfirmadaPor: null,
      semCustoNoRazao: 0,
    };
    entrarComo('gerente_loja');
    montar(<EstoquePage />);
    expect(await screen.findByText(/custo médio das entradas registradas/)).toBeTruthy();
    expect(screen.getByText(/ainda não confirmada pelo contador/)).toBeTruthy();
  });

  it('valor oculto: a frase manda à política, e não mostra R$ 0,00', async () => {
    respostas['/core/stock/valuation'] = { totalCents: null, produtosComSaldo: 3, oculto: true, regua: 'ultimo_custo' };
    entrarComo('estoquista');
    montar(<EstoquePage />);
    expect(await screen.findByText(/reservados à gerência pela política da empresa/)).toBeTruthy();
    expect(screen.queryByText(/Valor total do estoque/)).toBeNull();
  });
});
