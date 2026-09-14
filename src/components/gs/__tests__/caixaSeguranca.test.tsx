/**
 * O DIÁLOGO DE CAIXA DO PDV — os defeitos de teclado, fila e controle.
 *
 *   D-pdv-teclado-23       Enter em "Fundo de troco" não abria o caixa.
 *   G-offline-sync-12      a fila INTEIRA do navegador travava o fechamento,
 *                          inclusive a venda de outra operação que a barra
 *                          nunca envia aqui.
 *   H-caixa-seguranca-15   Esc no pedido de senha do gestor fechava também o
 *                          diálogo de caixa, com o valor e o motivo digitados.
 *   H-caixa-seguranca-04   o teto da sangria na tela olhava só o valor digitado.
 *   H-caixa-seguranca-08   sangria sem motivo.
 *   H-caixa-seguranca-09   o reenvio depois da falha de rede ia sem chave.
 *   H-caixa-seguranca-14   Suprimento sem teto: o código de barras bipado virava
 *                          dinheiro na gaveta.
 *
 * Cada caso falha com o comportamento antigo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { enqueue } from '@/lib/api/offlineQueue';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { formatCents } from '../format';

const SESSAO = {
  id: 'cash-1',
  company_id: 'loja',
  terminal_id: null,
  opened_by: 'u-caixa',
  opening_cents: 20000,
  status: 'open',
  opened_at: '2026-09-14T08:00:00.000Z',
  closed_at: null,
  expected_cents: null,
  counted_cents: null,
  difference_cents: null,
};

interface Enviado {
  url: string;
  metodo: string;
  corpo: Record<string, unknown> | null;
  headers: Record<string, string>;
}
let enviados: Enviado[] = [];
let movimentosDoResumo: unknown[] = [];
let falharMovimentosPorRede = 0;

const movimentos = () => enviados.filter((e) => e.url.includes('/movements') && e.metodo === 'POST');

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (metodo !== 'GET') enviados.push({ url: alvo, metodo, corpo, headers: { ...(init?.headers ?? {}) } });
      if (alvo.includes('/movements') && metodo === 'POST') {
        if (falharMovimentosPorRede > 0) {
          falharMovimentosPorRede -= 1;
          // A resposta que se perdeu no Wi-Fi da loja.
          throw new TypeError('Failed to fetch');
        }
        return json({ balance: 12000 }, 201);
      }
      if (alvo.includes('/core/cash/open') && metodo === 'POST') return json(SESSAO, 201);
      if (alvo.includes('/core/authorizations') && metodo === 'POST') {
        return json({ id: 'auth-1', action: 'sangria_especial', authorizedBy: 'u-g', createdAt: '2026-09-14T12:00:00.000Z' }, 201);
      }
      if (alvo.includes('/summary')) {
        return json({ session: SESSAO, expectedCents: 100000, byMethod: [], changeCents: 0, movements: movimentosDoResumo });
      }
      return json({});
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
    'teste do caixa',
  );
}

beforeEach(() => {
  enviados = [];
  movimentosDoResumo = [];
  falharMovimentosPorRede = 0;
  localStorage.clear();
  entrarComo('operador_caixa_loja');
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do caixa');
  localStorage.clear();
});

function montar(opcoes: { cash?: unknown; teto?: number | null; onClose?: () => void } = {}) {
  render(
    <CaixaPdvDialog
      cash={(opcoes.cash === undefined ? SESSAO : opcoes.cash) as never}
      tetoSangriaCents={opcoes.teto ?? null}
      vendasEmEspera={0}
      onClose={opcoes.onClose ?? (() => {})}
      onChanged={() => {}}
    />,
  );
}

const campoValor = () => screen.getByLabelText('Valor') as HTMLInputElement;
const campoMotivo = () => screen.getByLabelText('Motivo (obrigatório na sangria)') as HTMLInputElement;

// ============================================================================

describe('D-pdv-teclado-23 — Enter no fundo de troco abre o caixa', () => {
  it('digitar 200 e Enter abre com 20000 centavos, sem Tab nem mouse', async () => {
    const onClose = vi.fn();
    montar({ cash: null, onClose });
    const fundo = screen.getByLabelText('Fundo de troco');
    fireEvent.change(fundo, { target: { value: '200' } });
    fireEvent.keyDown(fundo, { key: 'Enter' });
    await waitFor(() => expect(enviados.some((e) => e.url.includes('/core/cash/open'))).toBe(true));
    const abertura = enviados.find((e) => e.url.includes('/core/cash/open'))!;
    expect(abertura.corpo?.openingCents).toBe(20000);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('com o caixa ABERTO, Enter não lança nada nem pede o fechamento', async () => {
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '50,00' } });
    fireEvent.keyDown(campoValor(), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(enviados).toHaveLength(0);
    expect(screen.queryByTestId('caixa-confirmar-fechamento')).toBeNull();
  });
});

// ============================================================================

describe('G-offline-sync-12 — só a venda que sobe nesta gaveta trava o fechamento', () => {
  function vendaGuardada(chave: string, cashSessionId: string | null, companyId: string) {
    enqueue({
      path: '/core/sales',
      method: 'POST',
      body: { items: [], payments: [{ method: 'dinheiro', amountCents: 5000 }], cashSessionId },
      idempotencyKey: chave,
      label: 'venda do PDV',
      escopo: { userId: 'u-x', companyId },
    });
  }

  it('venda de OUTRA operação na fila: o Fechar fica habilitado, e o aviso é à parte', async () => {
    vendaGuardada('da-gringa', 'gaveta-da-gringa', 'gringa');
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '0,00' } });
    expect((screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('caixa-fila-offline')).toBeNull();
    expect(screen.getByTestId('caixa-fila-de-outra-operacao').textContent).toMatch(/1 venda\(s\) de outra operação/);
  });

  it('venda desta operação de OUTRO turno também não trava; a DESTA gaveta trava', async () => {
    vendaGuardada('turno-de-ontem', 'gaveta-de-ontem', 'loja');
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '0,00' } });
    expect((screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement).disabled).toBe(false);
    // A venda é DESTA operação: o aviso não pode mandá-la "voltar àquela operação".
    expect(screen.queryByTestId('caixa-fila-de-outra-operacao')).toBeNull();
    expect(screen.getByTestId('caixa-fila-de-outra-gaveta').textContent).toMatch(/1 venda\(s\) guardada\(s\) de outra gaveta desta operação/);
    cleanup();

    vendaGuardada('deste-turno', SESSAO.id, 'loja');
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '0,00' } });
    expect((screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('caixa-fila-offline').textContent).toMatch(/^1 venda\(s\) guardada\(s\)/);
  });
});

// ============================================================================

describe('H-caixa-seguranca-15 — Esc no pedido do gestor fecha só o pedido', () => {
  it('o diálogo de caixa fica, com o valor e o motivo digitados', async () => {
    const onClose = vi.fn();
    montar({ teto: 50000, onClose });
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '800,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria (pede gestor)' }));
    await screen.findByLabelText('Autorização do gestor');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByLabelText('Autorização do gestor')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('caixa-pdv')).toBeTruthy();
    expect(campoValor().value).toBe('800,00');
    expect(campoMotivo().value).toBe('depósito no banco');
    expect(movimentos()).toHaveLength(0);
  });

  it('sem pedido por cima, Esc continua fechando o diálogo de caixa', async () => {
    const onClose = vi.fn();
    montar({ onClose });
    await screen.findByTestId('caixa-esperado');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================

describe('H-caixa-seguranca-04 — o teto na tela é do turno', () => {
  it('R$ 150 já sangrados sem gestor + R$ 100 digitados passam do teto de R$ 200: a tela avisa antes', async () => {
    movimentosDoResumo = [
      { movement_type: 'opening', amount_cents: 20000, note: null, reference_type: 'cash_session' },
      { movement_type: 'withdrawal', amount_cents: -15000, note: 'cofre', reference_type: 'manual' },
      // A que passou com gestor não gasta o teto do sem-gestor.
      { movement_type: 'withdrawal', amount_cents: -90000, note: 'banco', reference_type: 'manual_com_gestor' },
    ];
    montar({ teto: 20000 });
    expect((await screen.findByTestId('caixa-ja-sangrado')).textContent).toContain(formatCents(15000));

    fireEvent.change(campoValor(), { target: { value: '50,00' } });
    expect(screen.queryByTestId('caixa-sangria-acima-do-teto')).toBeNull();

    fireEvent.change(campoValor(), { target: { value: '100,00' } });
    const aviso = await screen.findByTestId('caixa-sangria-acima-do-teto');
    expect(aviso.textContent).toContain(formatCents(15000));
    expect(screen.getByRole('button', { name: 'Sangria (pede gestor)' })).toBeTruthy();
  });
});

// ============================================================================

describe('H-caixa-seguranca-08 — a sangria pede o motivo', () => {
  it('sem motivo o botão fica desabilitado e diz por quê; com motivo, o motivo vai no corpo', async () => {
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '30,00' } });
    const botao = screen.getByRole('button', { name: 'Sangria' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect(screen.getByTestId('caixa-sangria-sem-motivo')).toBeTruthy();

    fireEvent.change(campoMotivo(), { target: { value: '  depósito no banco ' } });
    expect(botao.disabled).toBe(false);
    fireEvent.click(botao);
    await waitFor(() => expect(movimentos()).toHaveLength(1));
    expect(movimentos()[0].corpo).toMatchObject({ movementType: 'withdrawal', amountCents: 3000, note: 'depósito no banco' });
  });
});

// ============================================================================

describe('H-caixa-seguranca-09 — o reenvio leva a MESMA chave', () => {
  it('a sangria que falhou na rede é reenviada com a chave do primeiro envio; a próxima ganha chave nova', async () => {
    falharMovimentosPorRede = 1;
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '500,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await screen.findByRole('alert');
    expect(movimentos()).toHaveLength(1);
    const primeiraChave = movimentos()[0].headers['Idempotency-Key'];
    expect(primeiraChave).toBeTruthy();

    // O segundo clique — o gesto natural depois do erro — vai com a mesma chave.
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await waitFor(() => expect(movimentos()).toHaveLength(2));
    expect(movimentos()[1].headers['Idempotency-Key']).toBe(primeiraChave);

    // Deu certo: a próxima sangria de mesmo valor é outro movimento, com outra chave.
    await waitFor(() => expect(campoValor().value).toBe(''));
    fireEvent.change(campoValor(), { target: { value: '500,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await waitFor(() => expect(movimentos()).toHaveLength(3));
    expect(movimentos()[2].headers['Idempotency-Key']).not.toBe(primeiraChave);
  });
});

// ============================================================================

describe('H-caixa-seguranca-14 — o Suprimento tem o teto da abertura', () => {
  it('um código de barras no campo e um clique em Suprimento: recusa na tela, nada enviado', async () => {
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '7894561230012' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suprimento' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Suprimento acima de/);
    expect(movimentos()).toHaveLength(0);
  });

  it('suprimento normal passa, com chave', async () => {
    montar();
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(campoValor(), { target: { value: '100,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suprimento' }));
    await waitFor(() => expect(movimentos()).toHaveLength(1));
    expect(movimentos()[0].corpo).toMatchObject({ movementType: 'supply', amountCents: 10000 });
    expect(movimentos()[0].headers['Idempotency-Key']).toBeTruthy();
  });
});
