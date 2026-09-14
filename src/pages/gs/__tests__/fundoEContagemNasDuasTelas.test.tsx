/**
 * O FUNDO DE TROCO E A CONTAGEM VALEM IGUAL NAS DUAS TELAS DE GAVETA
 * (H-caixa-seguranca-01, as duas telas).
 *
 * O DEFEITO, em duas metades:
 *
 *   - a tela de Caixa da gestão não conhecia o teto de R$ 100.000,00 do fundo
 *     de troco: o código de barras bipado no "Fundo de troco" ia inteiro para o
 *     servidor, com o botão ativo, e a recusa voltava longe do campo;
 *   - no diálogo de caixa do PDV, com a confirmação do fechamento na tela,
 *     apagar o "Valor" deixava "Confirmar fechamento" ativo — e o envio ia com
 *     `centavos ?? 0`: turno fechado com contagem ZERO, sem ninguém ter contado.
 *
 * O que o servidor faz está em server/tests/caixa-contagem-no-funil.test.ts.
 * Cada caso aqui falha com o comportamento antigo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { CaixaPdvDialog } from '@/components/gs/CaixaPdvDialog';
import { CaixaPage } from '../OperacaoPages';

const SESSAO = {
  id: 's-aberta',
  company_id: 'loja',
  terminal_id: null,
  opened_by: 'u-caixa',
  opening_cents: 10000,
  status: 'open',
  opened_at: '2026-09-14T11:00:00.000Z',
  closed_at: null,
  expected_cents: null,
  counted_cents: null,
  difference_cents: null,
};

let caixaAberto: boolean;
let aberturas: Record<string, unknown>[];
let fechamentos: Record<string, unknown>[];

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (alvo.includes('/summary')) {
        return json({ session: SESSAO, expectedCents: 52000, byMethod: [], changeCents: 0, movements: [] });
      }
      if (alvo.includes('/close') && metodo === 'POST') {
        fechamentos.push(corpo);
        return json({ ...SESSAO, status: 'closed', counted_cents: corpo.countedCents, expected_cents: 52000 });
      }
      if (alvo.includes('/core/cash/open') && metodo === 'POST') {
        aberturas.push(corpo);
        caixaAberto = true;
        return json(SESSAO, 201);
      }
      if (alvo.includes('/core/cash/open')) {
        return json({ session: caixaAberto ? SESSAO : null, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/core/cash/drawers')) return json({ items: [], deOutroDia: 0 });
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
    'teste das duas telas de gaveta',
  );
}

beforeEach(() => {
  caixaAberto = true;
  aberturas = [];
  fechamentos = [];
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

const pausa = () => new Promise((r) => setTimeout(r, 30));

// ============================================================================

describe('a tela de Caixa da gestão cobra o teto do fundo de troco, no campo', () => {
  it('um código de barras no "Fundo de troco": o campo diz o teto, o botão trava e nada vai ao servidor', async () => {
    caixaAberto = false;
    render(
      <MemoryRouter>
        <CaixaPage />
      </MemoryRouter>,
    );
    const abrir = (await screen.findByRole('button', { name: 'Abrir caixa' })) as HTMLButtonElement;
    const fundo = screen.getByLabelText('Fundo de troco') as HTMLInputElement;

    fireEvent.change(fundo, { target: { value: '7894561230012' } });
    expect(fundo.getAttribute('aria-invalid')).toBe('true');
    const erro = document.getElementById(fundo.getAttribute('aria-describedby') ?? '');
    expect(erro?.textContent).toMatch(/Fundo de troco acima de R\$\s*100\.000,00/);
    expect(abrir.disabled).toBe(true);
    fireEvent.click(abrir);
    await pausa();
    expect(aberturas).toHaveLength(0);

    // O valor de verdade passa, e o aviso some.
    fireEvent.change(fundo, { target: { value: '150,00' } });
    expect(fundo.getAttribute('aria-invalid')).toBeNull();
    expect(abrir.disabled).toBe(false);
    fireEvent.click(abrir);
    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect(aberturas[0].openingCents).toBe(15000);
  });

  it('no teto exato abre (o servidor aceita R$ 100.000,00 cravados)', async () => {
    caixaAberto = false;
    render(
      <MemoryRouter>
        <CaixaPage />
      </MemoryRouter>,
    );
    const abrir = (await screen.findByRole('button', { name: 'Abrir caixa' })) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Fundo de troco'), { target: { value: '100.000,00' } });
    expect(abrir.disabled).toBe(false);
    fireEvent.click(abrir);
    await waitFor(() => expect(aberturas).toHaveLength(1));
    expect(aberturas[0].openingCents).toBe(100_000_00);
  });

  it('contagem que não é dinheiro: o campo diz por que "Fechar caixa" não anda', async () => {
    render(
      <MemoryRouter>
        <CaixaPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('caixa-gestao-esperado').textContent).toMatch(/520,00/));
    const contado = screen.getByLabelText('Valor contado no fechamento') as HTMLInputElement;
    fireEvent.change(contado, { target: { value: 'abc' } });
    const erro = document.getElementById(contado.getAttribute('aria-describedby') ?? '');
    expect(erro?.textContent).toMatch(/Valor contado inválido/);
    expect((screen.getByRole('button', { name: 'Fechar caixa' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// ============================================================================

describe('o diálogo de caixa do PDV não fecha com uma contagem que ninguém digitou', () => {
  function montarDialogo(cash: unknown = SESSAO) {
    render(
      <CaixaPdvDialog
        cash={cash as never}
        tetoSangriaCents={null}
        vendasEmEspera={0}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    );
  }

  it('apagar o "Valor" com a confirmação na tela derruba a pergunta — nada de fechar com zero', async () => {
    entrarComo('operador_caixa_loja');
    montarDialogo();
    await screen.findByTestId('caixa-esperado');
    const valor = screen.getByLabelText('Valor') as HTMLInputElement;
    fireEvent.change(valor, { target: { value: '520,00' } });
    fireEvent.click(screen.getByRole('button', { name: /Fechar caixa/i }));
    await screen.findByTestId('caixa-confirmar-fechamento');

    fireEvent.change(valor, { target: { value: '' } });
    // Antes: a pergunta ficava, dizendo "Contado R$ 0,00", e confirmar enviava 0.
    screen.queryByRole('button', { name: /Confirmar fechamento/i })?.click();
    await pausa();
    expect(screen.queryByTestId('caixa-confirmar-fechamento')).toBeNull();
    expect(fechamentos).toHaveLength(0);
    expect((screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('texto que não é dinheiro no "Valor": o campo diz o que está errado', async () => {
    entrarComo('operador_caixa_loja');
    montarDialogo();
    await screen.findByTestId('caixa-esperado');
    const valor = screen.getByLabelText('Valor') as HTMLInputElement;
    fireEvent.change(valor, { target: { value: 'abc' } });
    expect(valor.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(valor.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /Valor inválido/,
    );
    expect((screen.getByRole('button', { name: /Fechar caixa/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('o teto do fundo de troco é dito NO CAMPO do diálogo, e some quando o valor muda', async () => {
    entrarComo('operador_caixa_loja');
    montarDialogo(null);
    const fundo = (await screen.findByLabelText('Fundo de troco')) as HTMLInputElement;
    fireEvent.change(fundo, { target: { value: '7894561230012' } });
    fireEvent.click(screen.getByRole('button', { name: /^Abrir caixa$/i }));

    await waitFor(() => expect(fundo.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(fundo.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /Fundo de troco acima de R\$\s*100\.000,00/,
    );
    expect(aberturas).toHaveLength(0);

    fireEvent.change(fundo, { target: { value: '200,00' } });
    expect(fundo.getAttribute('aria-invalid')).toBeNull();
  });
});
