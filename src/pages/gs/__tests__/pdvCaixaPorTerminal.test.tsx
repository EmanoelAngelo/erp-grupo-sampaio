/**
 * O PDV SABE DE QUAL CAIXA É — e aponta a gaveta de outro dia.
 * (GAP-PRD-039, GAP-PRD-150, GAP-PRD-131)
 *
 * O servidor passou a ter uma gaveta por caixa e a recusar abrir gaveta sem
 * dizer qual (`CORE_TERMINAL_REQUIRED`) quando a operação cadastrou caixas.
 * Estes casos provam a metade da tela:
 *
 *  - sem caixa escolhido, o PDV PERGUNTA — e a escolha vai para a consulta, a
 *    abertura e a venda;
 *  - o caixa guardado que foi desligado é esquecido, e o motivo aparece;
 *  - o computador registrado por token não escolhe: o caixa é o do token;
 *  - a gaveta aberta de outro dia vira faixa com a data e sobe o diálogo na
 *    entrada — o primeiro gesto do dia é fechar a gaveta de agosto.
 *
 * Tire o `getOpenCash(caixaDesteComputador(...))` do PDV e o primeiro caso fica
 * vermelho (a consulta não leva o caixa); tire o `terminalId` do corpo da venda
 * e o segundo fica vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const SESSAO_KEY = 'gs.session';
const CHAVE_CAIXA = 'gs.pdv.terminal.c1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CAIXAS = [
  { id: 'cx1', code: 'preco-justo-cx1', name: 'Caixa 1', active: true, caixaAberto: null, tokensAtivos: 0 },
  { id: 'cx2', code: 'preco-justo-cx2', name: 'Caixa 2', active: true, caixaAberto: null, tokensAtivos: 0 },
];

const PRODUTO = {
  id: 'p-1',
  internal_code: 'PJ-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Fone de ouvido',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1000,
  price_cents: 2500,
  effective_price_cents: 2500,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** O que cada caixa tem de gaveta aberta. */
let gavetas: Record<string, Record<string, unknown> | null>;
/** A resposta de `GET /cash/open` sobrescrita por caso (token, recusa, outro dia). */
let respostaFixa: Record<string, unknown> | null;
let consultas: string[];
let aberturas: Record<string, unknown>[];
let vendas: Record<string, unknown>[];

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (u.includes('/core/cash/open') && metodo === 'GET') {
      consultas.push(u);
      if (respostaFixa) return json(respostaFixa);
      const terminalId = new URL(u, 'http://x').searchParams.get('terminalId');
      if (!terminalId) {
        return json({
          session: null,
          cashWithdrawalLimitCents: null,
          terminal: null,
          terminalDoDispositivo: false,
          terminalRecusado: null,
          terminaisAtivos: 2,
          exigeTerminal: true,
          deOutroDia: null,
        });
      }
      const caixa = CAIXAS.find((c) => c.id === terminalId)!;
      return json({
        session: gavetas[terminalId] ?? null,
        cashWithdrawalLimitCents: null,
        terminal: { id: caixa.id, code: caixa.code, name: caixa.name },
        terminalDoDispositivo: false,
        terminalRecusado: null,
        terminaisAtivos: 2,
        exigeTerminal: false,
        deOutroDia: null,
      });
    }
    if (u.includes('/core/cash/open') && metodo === 'POST') {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      aberturas.push(corpo);
      const sessao = {
        id: `sessao-${String(corpo.terminalId)}`,
        terminal_id: corpo.terminalId,
        opening_cents: corpo.openingCents,
        status: 'open',
        opened_at: new Date().toISOString(),
      };
      gavetas[String(corpo.terminalId)] = sessao;
      return json(sessao, 201);
    }
    if (u.includes('/core/terminals')) return json({ items: CAIXAS });
    if (u.includes('/summary')) return json({ expectedCents: 5000, byMethod: [], movements: [], changeCents: 0 });
    if (u.includes('/core/fiscal/pdv-summary')) return json({ situacao: 'READY', pendencyCount: 0, motivos: [] });
    if (u.includes('/core/products/search')) return json({ items: [PRODUTO] });
    if (u.includes('/core/sales') && metodo === 'POST') {
      vendas.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({ id: 's-1', number: 1, total_cents: 2500, change_cents: 0 }, 201);
    }
    return json({ items: [] });
  });
}

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  gavetas = {};
  respostaFixa = null;
  consultas = [];
  aberturas = [];
  vendas = [];
  localStorage.setItem(
    SESSAO_KEY,
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Beto', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a operação tem mais de um caixa', () => {
  it('sem caixa escolhido, o PDV pergunta — e a escolha vai para a consulta e para a abertura', async () => {
    montar();
    const dialogo = await screen.findByTestId('caixa-pdv');
    // Nada de fundo de troco antes de dizer qual caixa: o servidor recusaria.
    const escolha = await within(dialogo).findByTestId('escolha-do-caixa');
    expect(within(dialogo).queryByLabelText('Fundo de troco')).toBeNull();
    // A faixa do balcão diz o mesmo.
    expect(screen.getByText(/diga qual caixa é este computador/i)).toBeTruthy();

    fireEvent.click(await within(escolha).findByRole('button', { name: /Caixa 2/ }));

    expect(localStorage.getItem(CHAVE_CAIXA)).toBe('cx2');
    await waitFor(() => expect(consultas.some((u) => u.includes('terminalId=cx2'))).toBe(true));
    expect(await within(dialogo).findByTestId('linha-do-caixa')).toHaveProperty(
      'textContent',
      expect.stringContaining('Caixa 2'),
    );

    fireEvent.change(within(dialogo).getByLabelText('Fundo de troco'), { target: { value: '100,00' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Abrir caixa' }));

    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect(aberturas[0]).toMatchObject({ openingCents: 10_000, terminalId: 'cx2' });
    // A faixa do topo nomeia a gaveta.
    await waitFor(() => expect(screen.getByText(/Caixa aberto · Caixa 2/)).toBeTruthy());
  });

  it('com a gaveta do Caixa 2 aberta, a venda leva o caixa E a gaveta dele', async () => {
    localStorage.setItem(CHAVE_CAIXA, 'cx2');
    gavetas.cx2 = { id: 'sessao-cx2', terminal_id: 'cx2', opening_cents: 5000, status: 'open', opened_at: new Date().toISOString() };
    montar();

    const busca = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
    await waitFor(() => expect(screen.getByText(/Caixa aberto · Caixa 2/)).toBeTruthy());
    fireEvent.change(busca, { target: { value: '7890000001111' } });
    fireEvent.keyDown(busca, { key: 'Enter' });
    await screen.findByText('Fone de ouvido');
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    await waitFor(() => expect(vendas).toHaveLength(1));
    expect(vendas[0]).toMatchObject({ terminalId: 'cx2', cashSessionId: 'sessao-cx2' });
  });

  it('o caixa guardado que foi desligado é esquecido, e o motivo aparece na escolha', async () => {
    localStorage.setItem(CHAVE_CAIXA, 'cx9');
    respostaFixa = {
      session: null,
      cashWithdrawalLimitCents: null,
      terminal: null,
      terminalDoDispositivo: false,
      terminalRecusado: { id: 'cx9', motivo: 'O caixa "Caixa 9" está desativado.' },
      terminaisAtivos: 2,
      exigeTerminal: true,
      deOutroDia: null,
    };
    montar();

    const escolha = await screen.findByTestId('escolha-do-caixa');
    expect(within(escolha).getByText('O caixa "Caixa 9" está desativado.')).toBeTruthy();
    expect(localStorage.getItem(CHAVE_CAIXA)).toBeNull();
  });

  it('o computador registrado por token não escolhe: o caixa é o do token', async () => {
    respostaFixa = {
      session: { id: 'sessao-cx1', terminal_id: 'cx1', opening_cents: 0, status: 'open', opened_at: new Date().toISOString() },
      cashWithdrawalLimitCents: null,
      terminal: { id: 'cx1', code: 'preco-justo-cx1', name: 'Caixa 1' },
      terminalDoDispositivo: true,
      terminalRecusado: null,
      terminaisAtivos: 2,
      exigeTerminal: false,
      deOutroDia: null,
    };
    montar();

    fireEvent.click(await screen.findByRole('button', { name: /Caixa aberto · Caixa 1/ }));
    const linha = await screen.findByTestId('linha-do-caixa');
    expect(linha.textContent).toMatch(/registrado neste computador/);
    expect(within(linha).queryByRole('button', { name: 'Trocar' })).toBeNull();
  });
});

describe('a gaveta esquecida de outro dia (GAP-PRD-131)', () => {
  it('vira faixa com a data e os dias — e o diálogo sobe na entrada para fechar', async () => {
    respostaFixa = {
      session: { id: 'sessao-velha', opening_cents: 10000, status: 'open', opened_at: '2026-08-12T21:51:00.000Z' },
      cashWithdrawalLimitCents: null,
      terminal: null,
      terminalDoDispositivo: false,
      terminalRecusado: null,
      terminaisAtivos: 0,
      exigeTerminal: false,
      deOutroDia: { abertaNoDia: '2026-08-12', hoje: '2026-09-11', dias: 30 },
    };
    montar();

    const dialogo = await screen.findByTestId('caixa-pdv');
    // Dentro do diálogo e na faixa do balcão: a mesma frase.
    expect(within(dialogo).getByTestId('gaveta-de-outro-dia').textContent).toMatch(/12\/08\/2026 \(há 30 dias\)/);
    fireEvent.click(within(dialogo).getByRole('button', { name: /^fechar$/i }));

    const faixa = await screen.findByTestId('gaveta-de-outro-dia');
    expect(faixa.textContent).toMatch(/aberta desde 12\/08\/2026/);
    fireEvent.click(within(faixa).getByRole('button', { name: /Fechar o turno antigo/ }));
    expect(await screen.findByTestId('caixa-pdv')).toBeTruthy();
  });

  it('a gaveta de hoje não tem faixa nenhuma', async () => {
    respostaFixa = {
      session: { id: 'sessao-hoje', opening_cents: 0, status: 'open', opened_at: new Date().toISOString() },
      cashWithdrawalLimitCents: null,
      terminal: null,
      terminaisAtivos: 0,
      exigeTerminal: false,
      deOutroDia: null,
    };
    montar();
    await waitFor(() => expect(consultas.length).toBeGreaterThan(0));
    await screen.findByPlaceholderText(/c.digo|barras|produto/i);
    expect(screen.queryByTestId('gaveta-de-outro-dia')).toBeNull();
    expect(screen.queryByTestId('caixa-pdv')).toBeNull();
  });
});
