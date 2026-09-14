/**
 * ============================================================================
 * ORIGEM NAVEGÁVEL, AGING E CARNÊ NA TELA DE CONTAS (V22/V18, V23, V24)
 * ============================================================================
 *
 * ## Os três defeitos que estes testes existem para impedir
 *
 * 1. O TÍTULO NÃO NAVEGAVA ATÉ A ORIGEM. O servidor passou a mandar
 *    `originId` e `originLabel` ('Venda #12', 'Nota 4711 — Fornecedor X') e a
 *    linha precisa virar LINK para a superfície certa — venda, entrada de
 *    notas, pedidos. Um rótulo sem link deixaria a pessoa caçando pelo texto,
 *    que era exatamente o defeito.
 *
 * 2. O VENCIDO NÃO TINHA IDADE. A rota devolve `aging` com as cinco faixas;
 *    a tela precisa MOSTRÁ-LAS — número que só existe na resposta é número
 *    que ninguém prioriza.
 *
 * 3. O CARNÊ NÃO EXISTIA. O formulário ganha "Parcelar em"; o valor precisa
 *    CHEGAR no corpo do POST (o formato de defeito já cometido três vezes
 *    nesta tela: campo na tela, valor no chão), e parcelar sem o primeiro
 *    vencimento é recusado ANTES de viajar — o servidor recusaria igual, mas
 *    a pessoa não deve preencher tudo para descobrir no fim.
 *
 * Como no arquivo irmão (contasCategoria), TODO teste olha o que sai no FIO —
 * URL e corpo — e nenhum se contenta com a mensagem de sucesso.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ContasPage from '../ContasPage';

/** Três origens diferentes: venda (link), nota (link) e manual (sem link). */
const LANCAMENTOS = [
  {
    id: 'e-venda',
    direction: 'in',
    description: 'Venda #12',
    amountCents: 50_000,
    settledCents: 0,
    balanceCents: 50_000,
    status: 'open',
    dueDate: '2026-08-10',
    settledAt: null,
    overdue: true,
    counterpartyName: 'Maria',
    originType: 'sale',
    originId: 'venda-12',
    originLabel: 'Venda #12',
    installmentNumber: 1,
    installmentTotal: 1,
    categoryId: null,
    categoryName: null,
    cancelledAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'e-nota',
    direction: 'in',
    description: 'NF-e 4711',
    amountCents: 98_700,
    settledCents: 0,
    balanceCents: 98_700,
    status: 'open',
    dueDate: '2026-09-10',
    settledAt: null,
    overdue: false,
    counterpartyName: 'Distribuidora Alfa',
    originType: 'nfe_entrada',
    originId: 'nota-4711',
    originLabel: 'Nota 4711 — Distribuidora Alfa',
    installmentNumber: 1,
    installmentTotal: 1,
    categoryId: null,
    categoryName: null,
    cancelledAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'e-manual',
    direction: 'in',
    description: 'Carnê da geladeira (2/3)',
    amountCents: 3_333,
    settledCents: 0,
    balanceCents: 3_333,
    status: 'open',
    dueDate: '2026-10-10',
    settledAt: null,
    overdue: false,
    counterpartyName: null,
    originType: 'manual',
    originId: 'grupo-carne',
    originLabel: null,
    installmentNumber: 2,
    installmentTotal: 3,
    categoryId: null,
    categoryName: null,
    cancelledAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
  },
];

const RESUMO = { openCents: 152_033, overdueCents: 50_000, settledCents: 0, count: 3 };

/** Valores distintos por faixa: qualquer troca de coluna denuncia. */
const AGING = {
  notDueCents: 102_033,
  days1to30Cents: 50_000,
  days31to60Cents: 7_700,
  days61to90Cents: 880,
  over90Cents: 99,
};

let requisicoes: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

function lancamentosCriados(): Record<string, unknown>[] {
  return requisicoes
    .filter((r) => r.metodo === 'POST' && r.url.includes('/finance/entries'))
    .map((r) => r.corpo ?? {});
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      requisicoes.push({
        url: alvo,
        metodo,
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });

      const responder = (corpo: unknown, status = 200) =>
        new Response(JSON.stringify(corpo), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/finance/categories')) {
        return responder({ items: [] });
      }
      if (alvo.includes('/core/finance/setup')) {
        return responder({ categories: [], costCenters: [], accounts: [] });
      }
      if (alvo.includes('/core/finance/entries') && metodo === 'POST') {
        return responder({ ...LANCAMENTOS[2], id: 'e-novo' }, 201);
      }
      if (alvo.includes('/core/finance/entries')) {
        return responder({ items: LANCAMENTOS, summary: RESUMO, aging: AGING });
      }
      return responder({ items: [] });
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
    'teste de origem e parcelas',
  );
}

beforeEach(() => {
  requisicoes = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de origem e parcelas');
  localStorage.clear();
});

/** O lado de RECEBER, onde vivem as três origens do dublê. */
function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-receber']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

describe('a origem é LINK para a superfície certa', () => {
  it('venda navega para Vendas; nota, para Entrada de notas — cada uma com o SEU documento', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('NF-e 4711');
    const tabela = within(screen.getByRole('table'));

    /*
      O rótulo sem link seria o defeito original de volta: a pessoa lê
      "Venda #12" e sai caçando pelo texto em outra tela. O href é o que
      transforma rastreabilidade em navegação.

      E o href carrega o ID: até esta rodada ele parava na TELA
      (`/sistema/vendas`), e quem clicava chegava na lista inteira com a #12
      perdida no meio — meia navegação, com o "caçar pelo número na mão" de
      pé. Quem cobra o outro lado (a tela de destino abrindo o documento) é
      `origemAbreODocumento`.
    */
    const linkVenda = tabela.getByRole('link', { name: 'Venda #12' });
    expect(linkVenda.getAttribute('href')).toBe('/sistema/vendas?venda=venda-12');

    const linkNota = tabela.getByRole('link', { name: 'Nota 4711 — Distribuidora Alfa' });
    expect(linkNota.getAttribute('href')).toBe('/sistema/compras/entrada-notas?nota=nota-4711');
  });

  it('lançamento manual não finge origem: sem link nenhum', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('NF-e 4711');
    const tabela = within(screen.getByRole('table'));
    // A linha do carnê existe, mas link de origem não — não há para onde ir.
    expect(screen.getByText('Carnê da geladeira (2/3)')).toBeTruthy();
    expect(tabela.queryByRole('link', { name: /carnê/i })).toBeNull();
  });

  it('a parcela se apresenta: a linha 2/3 mostra qual é e de quantas', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('NF-e 4711');
    const tabela = within(screen.getByRole('table'));
    // O agrupamento visual prometido: quem olha a lista sabe que é um carnê.
    expect(tabela.getByText('parcela 2/3')).toBeTruthy();
  });
});

describe('o vencido tem idade na tela', () => {
  it('as cinco faixas aparecem com os valores da rota', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('NF-e 4711');

    // As cinco faixas da casa, nomeadas.
    expect(screen.getByText('A vencer')).toBeTruthy();
    expect(screen.getByText('1–30 dias')).toBeTruthy();
    expect(screen.getByText('31–60 dias')).toBeTruthy();
    expect(screen.getByText('61–90 dias')).toBeTruthy();
    expect(screen.getByText('Mais de 90')).toBeTruthy();

    // E com os NÚMEROS de cada uma — valores distintos por construção, para
    // uma troca de coluna não passar despercebida.
    expect(screen.getByText('R$ 1.020,33')).toBeTruthy();
    expect(screen.getByText('R$ 77,00')).toBeTruthy();
    expect(screen.getByText('R$ 8,80')).toBeTruthy();
    expect(screen.getByText('R$ 0,99')).toBeTruthy();
  });
});

describe('o carnê no formulário: o que sai no fio', () => {
  async function abrirFormulario() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(screen.getByLabelText(/^Parcelar em\s*\*?$/)).toBeTruthy());
  }

  function preencherObrigatorios() {
    fireEvent.change(screen.getByLabelText(/^Descrição\s*\*?$/), {
      target: { value: 'Carnê da TV' },
    });
    fireEvent.change(screen.getByLabelText(/^Valor\s*\*?$/), { target: { value: '900,00' } });
  }

  it('parcelar em 3 CHEGA no corpo do POST, junto do total e do vencimento', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.change(screen.getByLabelText(/^Vencimento/), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByLabelText(/^Parcelar em/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(lancamentosCriados()).toHaveLength(1));
    const corpo = lancamentosCriados()[0];
    // O total viaja INTEIRO — quem divide em centavos exatos é o servidor,
    // que põe o resto na primeira parcela. Dividir aqui daria duas contas.
    expect(corpo.amountCents).toBe(90_000);
    expect(corpo.installments).toBe(3);
    expect(corpo.dueDate).toBe('2026-09-10');
  });

  it('sem mexer no campo, o lançamento é o único de sempre: installments 1', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(lancamentosCriados()).toHaveLength(1));
    expect(lancamentosCriados()[0].installments).toBe(1);
  });

  it('parcelar sem o primeiro vencimento é recusado ANTES de viajar', async () => {
    servidor();
    entrarComo('gerente_loja');
    montar();
    await abrirFormulario();

    preencherObrigatorios();
    fireEvent.change(screen.getByLabelText(/^Parcelar em/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    // O servidor recusaria igual (400) — mas a pessoa não deve preencher o
    // formulário inteiro para descobrir no fim o que a tela já sabia.
    await screen.findByText(/primeiro vencimento/i);
    expect(lancamentosCriados()).toHaveLength(0);
  });
});
