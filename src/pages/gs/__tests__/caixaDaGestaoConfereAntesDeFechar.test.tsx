/**
 * A TELA DE CAIXA DA GESTÃO (Vendas › Caixa) — o fechamento com as guardas do
 * diálogo do PDV.
 *
 *   H-caixa-seguranca-01   o leitor da tela tirava todos os pontos e terminava
 *                          em `|| 0`: campo vazio ou "abc" fechava o turno com
 *                          contagem 0 (a gaveta inteira em falta), "350.50"
 *                          virava R$ 35.050,00 e o fundo "100.50" abria a
 *                          gaveta com R$ 10.050,00 — tudo sem confirmação.
 *   H-caixa-seguranca-M02  sem as guardas do diálogo do PDV: resumo que falha
 *                          virava "Esperado R$ 0,00", o esperado ficava
 *                          congelado desde a abertura da página, o clique
 *                          duplo virava "Caixa já fechado." e a gaveta fechava
 *                          com venda offline dela ainda na fila.
 *
 * Cada caso falha com o comportamento antigo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { enqueue } from '@/lib/api/offlineQueue';
import { formatCents } from '@/components/gs/format';
import { CaixaPage } from '../OperacaoPages';

const SESSAO = {
  id: 's-aberta',
  terminal_id: null,
  opening_cents: 10000,
  counted_cents: null,
  expected_cents: null,
  difference_cents: null,
  status: 'open',
  opened_at: '2026-09-14T11:00:00.000Z',
  closed_at: null,
};

/** O esperado que cada pedido de resumo devolve, em ordem; o último se repete. */
let resumos: Array<number | 'falha'> = [];
let pedidosDeResumo = 0;
let caixaAberto = true;
let fechamentos: Record<string, unknown>[] = [];
let aberturas: Record<string, unknown>[] = [];
/** Enquanto não resolvida, a abertura e o fechamento ficam "no ar". */
let segurar: Promise<void> | null = null;
/** O que `GET /core/cash/drawers` devolve — todas as gavetas abertas da operação. */
let gavetasAbertas: Record<string, unknown>[] = [];

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;

      if (alvo.includes('/summary')) {
        const r = resumos[Math.min(pedidosDeResumo, resumos.length - 1)];
        pedidosDeResumo += 1;
        if (r === 'falha') {
          return json({ error: { code: 'INTERNAL_ERROR', message: 'Falha ao montar o resumo.' } }, 500);
        }
        return json({ session: SESSAO, expectedCents: r, byMethod: [], changeCents: 0, movements: [] });
      }
      if (alvo.includes('/close') && metodo === 'POST') {
        fechamentos.push(corpo ?? {});
        if (segurar) await segurar;
        if (fechamentos.length > 1) {
          // O que o servidor real responde ao segundo fechamento do mesmo turno.
          return json({ error: { code: 'CORE_CASH_CLOSED', message: 'Caixa já fechado.' } }, 409);
        }
        caixaAberto = false;
        const contado = Number(corpo?.countedCents);
        return json({ ...SESSAO, status: 'closed', expected_cents: 52000, counted_cents: contado, difference_cents: contado - 52000 });
      }
      if (alvo.includes('/core/cash/open') && metodo === 'POST') {
        aberturas.push(corpo ?? {});
        if (segurar) await segurar;
        if (aberturas.length > 1) {
          return json({ error: { code: 'CORE_CASH_ALREADY_OPEN', message: 'Já existe um caixa aberto. Feche-o.' } }, 409);
        }
        caixaAberto = true;
        return json(SESSAO, 201);
      }
      if (alvo.includes('/core/cash/open')) {
        return json({ session: caixaAberto ? SESSAO : null, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/core/cash/sessions')) return json({ items: [] });
      if (alvo.includes('/core/cash/drawers')) return json({ items: gavetasAbertas, deOutroDia: 0 });
      // A barra do topo tenta subir a venda guardada: o servidor "não responde",
      // e a venda continua na fila — que é o cenário do teste da fila.
      if (alvo.includes('/core/sales')) return json({ error: { code: 'UNAVAILABLE', message: 'fora' } }, 503);
      return json({ items: [] });
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
    'teste do caixa da gestão',
  );
}

function montar() {
  render(
    <MemoryRouter>
      <CaixaPage />
    </MemoryRouter>,
  );
}

const campoContado = () => screen.getByLabelText('Valor contado no fechamento') as HTMLInputElement;
const botaoFechar = () => screen.getByRole('button', { name: 'Fechar caixa' }) as HTMLButtonElement;
const esperadoNaTela = () => screen.getByTestId('caixa-gestao-esperado').textContent ?? '';
const confirmacao = () => screen.findByRole('alertdialog', { name: 'Confirmar fechamento do turno' });
const pausa = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  resumos = [52000];
  pedidosDeResumo = 0;
  caixaAberto = true;
  fechamentos = [];
  aberturas = [];
  segurar = null;
  gavetasAbertas = [];
  localStorage.clear();
  entrarComo('gerente_loja');
  servidor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ============================================================================

describe('H-caixa-seguranca-01 — o valor digitado é lido como dinheiro, e fechar pede confirmação', () => {
  it('campo vazio ou texto que não é dinheiro: "Fechar caixa" desabilitado e nenhum fechamento', async () => {
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));

    // Vazio: antes virava contagem 0 — a gaveta inteira em falta.
    expect(botaoFechar().disabled).toBe(true);
    fireEvent.click(botaoFechar());

    for (const lixo of ['abc', '1.234,5x', '-10']) {
      fireEvent.change(campoContado(), { target: { value: lixo } });
      expect(botaoFechar().disabled).toBe(true);
      fireEvent.click(botaoFechar());
    }
    await pausa();
    expect(fechamentos).toHaveLength(0);
  });

  it('"350.50" é R$ 350,50 — e só fecha depois da confirmação com contado × esperado', async () => {
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));

    fireEvent.change(campoContado(), { target: { value: '350.50' } });
    fireEvent.click(botaoFechar());

    const pergunta = await confirmacao();
    // Nada foi enviado ainda: o clique em "Fechar caixa" só pergunta.
    expect(fechamentos).toHaveLength(0);
    expect(pergunta.textContent).toContain(formatCents(35050));
    expect(pergunta.textContent).toContain(formatCents(52000));
    expect(pergunta.textContent).toContain(`falta ${formatCents(16950)}`);

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar fechamento' }));
    await waitFor(() => expect(fechamentos).toHaveLength(1));
    // Antes: 3.505.000 centavos (R$ 35.050,00 contados).
    expect(fechamentos[0].countedCents).toBe(35050);
    expect((await screen.findByRole('status')).textContent).toContain('Caixa fechado.');
  });

  it('"Voltar" desfaz a pergunta sem fechar nada', async () => {
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    fireEvent.change(campoContado(), { target: { value: '520,00' } });
    fireEvent.click(botaoFechar());
    await confirmacao();

    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await pausa();
    expect(fechamentos).toHaveLength(0);
  });

  it('mexer na contagem com a pergunta na tela desfaz a pergunta; a nova relê o esperado', async () => {
    // Revisão: apagar o campo escondia a pergunta mas deixava "Fechar caixa"
    // desabilitado sem motivo; ao redigitar, a pergunta voltava sozinha com o
    // esperado velho.
    resumos = [52000, 52000, 60000];
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    fireEvent.change(campoContado(), { target: { value: '520,00' } });
    fireEvent.click(botaoFechar());
    await confirmacao();

    fireEvent.change(campoContado(), { target: { value: '' } });
    fireEvent.change(campoContado(), { target: { value: '600,00' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(botaoFechar().disabled).toBe(false);

    fireEvent.click(botaoFechar());
    const pergunta = await confirmacao();
    expect(pergunta.textContent).toContain(formatCents(60000));
    expect(pergunta.textContent).not.toContain('sobra');
    expect(fechamentos).toHaveLength(0);
  });

  it('zero contado vale — desde que DIGITADO', async () => {
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    fireEvent.change(campoContado(), { target: { value: '0,00' } });
    expect(botaoFechar().disabled).toBe(false);
    fireEvent.click(botaoFechar());
    await confirmacao();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar fechamento' }));
    await waitFor(() => expect(fechamentos).toHaveLength(1));
    expect(fechamentos[0].countedCents).toBe(0);
  });

  it('fundo de troco "100.50" abre com R$ 100,50; "abc" deixa "Abrir caixa" desabilitado', async () => {
    caixaAberto = false;
    montar();
    const abrir = (await screen.findByRole('button', { name: 'Abrir caixa' })) as HTMLButtonElement;
    const fundo = screen.getByLabelText('Fundo de troco');

    fireEvent.change(fundo, { target: { value: 'abc' } });
    expect(abrir.disabled).toBe(true);
    fireEvent.click(abrir);
    await pausa();
    expect(aberturas).toHaveLength(0);

    fireEvent.change(fundo, { target: { value: '100.50' } });
    expect(abrir.disabled).toBe(false);
    fireEvent.click(abrir);
    await waitFor(() => expect(aberturas).toHaveLength(1));
    // Antes: 1.005.000 centavos (R$ 10.050,00 de fundo).
    expect(aberturas[0].openingCents).toBe(10050);
  });
});

// ============================================================================

describe('H-caixa-seguranca-M02 — as guardas do diálogo de caixa do PDV', () => {
  it('resumo que falha: esperado "não carregado" (nunca R$ 0,00) e "Fechar caixa" travado até ele voltar', async () => {
    resumos = ['falha', 30000];
    montar();

    await screen.findByTestId('caixa-gestao-resumo-falhou');
    expect(esperadoNaTela()).toBe('não carregado');
    expect(esperadoNaTela()).not.toContain(formatCents(0));

    fireEvent.change(campoContado(), { target: { value: '100,00' } });
    expect(botaoFechar().disabled).toBe(true);
    fireEvent.click(botaoFechar());
    await pausa();
    expect(fechamentos).toHaveLength(0);

    // "Tentar de novo" relê; com o esperado de volta, o fechamento destrava.
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(30000)));
    expect(screen.queryByTestId('caixa-gestao-resumo-falhou')).toBeNull();
    expect(botaoFechar().disabled).toBe(false);
  });

  it('o esperado é relido na hora de fechar: a confirmação mostra o número de AGORA', async () => {
    // Página aberta às 14h com R$ 100,00 esperados; às 18h o servidor diz 250,00.
    resumos = [10000, 25000];
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(10000)));

    fireEvent.change(campoContado(), { target: { value: '250,00' } });
    fireEvent.click(botaoFechar());

    const pergunta = await confirmacao();
    expect(pergunta.textContent).toContain(formatCents(25000));
    // Contra o número velho a tela acusaria sobra de R$ 150,00.
    expect(pergunta.textContent).not.toContain('sobra');
    expect(esperadoNaTela()).toContain(formatCents(25000));
  });

  it('dois cliques em "Confirmar fechamento": um fechamento só, e a faixa diz "Caixa fechado."', async () => {
    let soltar!: () => void;
    segurar = new Promise<void>((r) => {
      soltar = r;
    });
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    fireEvent.change(campoContado(), { target: { value: '520,00' } });
    fireEvent.click(botaoFechar());
    await confirmacao();

    const confirmar = screen.getByRole('button', { name: 'Confirmar fechamento' });
    fireEvent.click(confirmar);
    fireEvent.click(confirmar);
    await pausa();
    expect(fechamentos).toHaveLength(1);

    soltar();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Caixa fechado.'));
    expect(screen.queryByText('Caixa já fechado.')).toBeNull();
    expect(fechamentos).toHaveLength(1);
  });

  it('dois cliques em "Abrir caixa": uma abertura só', async () => {
    caixaAberto = false;
    let soltar!: () => void;
    segurar = new Promise<void>((r) => {
      soltar = r;
    });
    montar();
    const abrir = await screen.findByRole('button', { name: 'Abrir caixa' });
    fireEvent.click(abrir);
    fireEvent.click(abrir);
    await pausa();
    expect(aberturas).toHaveLength(1);
    soltar();
    await screen.findByTestId('caixa-gestao-esperado');
    expect(screen.queryByText(/Já existe um caixa aberto/)).toBeNull();
  });

  it('venda offline DESTA gaveta na fila: "Fechar caixa" travado, com o aviso', async () => {
    enqueue({
      path: '/core/sales',
      method: 'POST',
      body: { items: [], payments: [{ method: 'dinheiro', amountCents: 5000 }], cashSessionId: 's-aberta' },
      idempotencyKey: 'venda-da-queda',
      label: 'venda do PDV',
      escopo: { userId: 'u-x', companyId: 'loja' },
    });
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));

    const aviso = await screen.findByTestId('caixa-gestao-fila-offline');
    expect(aviso.textContent).toMatch(/1 venda\(s\) guardada\(s\) neste computador/);

    fireEvent.change(campoContado(), { target: { value: '520,00' } });
    expect(botaoFechar().disabled).toBe(true);
    fireEvent.click(botaoFechar());
    await pausa();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fechamentos).toHaveLength(0);
  });

  it('venda de OUTRA operação na fila não trava a gaveta desta', async () => {
    enqueue({
      path: '/core/sales',
      method: 'POST',
      body: { items: [], payments: [{ method: 'dinheiro', amountCents: 5000 }], cashSessionId: 's-da-oficina' },
      idempotencyKey: 'venda-da-oficina',
      label: 'venda do PDV',
      escopo: { userId: 'u-x', companyId: 'oficina' },
    });
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    fireEvent.change(campoContado(), { target: { value: '520,00' } });
    expect(screen.queryByTestId('caixa-gestao-fila-offline')).toBeNull();
    expect(botaoFechar().disabled).toBe(false);
  });
});

// ============================================================================

describe('H-caixa-seguranca-M02 (a metade que faltou) — a gaveta do turno não tem um segundo botão de fechar', () => {
  /*
    `/cash/drawers` devolve TODAS as gavetas abertas, inclusive a do turno
    corrente. Antes, o card "Gavetas abertas nesta operação" desenhava a mesma
    gaveta do card "Caixa aberto" com o próprio "Fechar esta gaveta" — o
    caminho sem as guardas acima.
  */
  const GAVETA_DO_TURNO = {
    sessionId: 's-aberta',
    terminalId: null,
    terminalName: null,
    terminalCode: null,
    openedAt: SESSAO.opened_at,
    openedBy: 'u-1',
    openedByName: 'Fulano',
    openingCents: 10000,
    expectedCents: 52000,
    deOutroDia: null,
  };
  const DO_CAIXA_2 = {
    ...GAVETA_DO_TURNO,
    sessionId: 's-cx2',
    terminalId: 'cx2',
    terminalName: 'Caixa 2',
    terminalCode: 'loja-cx2',
    openedByName: 'Beto',
  };

  it('a gaveta do card "Caixa aberto" fica fora da lista; a do Caixa 2 continua nela', async () => {
    gavetasAbertas = [GAVETA_DO_TURNO, DO_CAIXA_2];
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    const lista = await screen.findByTestId('gavetas-abertas');
    await waitFor(() => expect(lista.textContent).not.toMatch(/Gaveta única \(sem caixa\)/));
    expect(screen.queryByLabelText('Valor contado — gaveta única')).toBeNull();
    expect(lista.textContent).toMatch(/Caixa 2/);
    expect(screen.getAllByRole('button', { name: 'Fechar esta gaveta' })).toHaveLength(1);
  });

  it('só a gaveta do turno aberta: a lista diz que ela está no card acima', async () => {
    gavetasAbertas = [GAVETA_DO_TURNO];
    montar();
    await waitFor(() => expect(esperadoNaTela()).toContain(formatCents(52000)));
    expect(await screen.findByText(/Nenhuma outra gaveta aberta — a deste caixa está no card acima/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fechar esta gaveta' })).toBeNull();
  });
});
