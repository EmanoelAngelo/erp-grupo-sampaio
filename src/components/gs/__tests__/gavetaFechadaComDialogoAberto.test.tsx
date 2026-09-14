/**
 * A GAVETA FECHOU EM OUTRO LUGAR COM O DIÁLOGO DE CAIXA ABERTO.
 *
 *   H-caixa-seguranca-M01 (o diálogo)  o PDV relê a gaveta ao abrir o diálogo e
 *                                      ao ver a venda recusada, mas não enquanto
 *                                      ele fica aberto. O gestor fecha o turno
 *                                      pela lista de gavetas abertas; o caixa,
 *                                      com o diálogo na tela, tenta a sangria,
 *                                      o suprimento ou o fechamento e recebe
 *                                      `CORE_CASH_CLOSED` (409) ou
 *                                      `CORE_CASH_NOT_FOUND` (404). A tela
 *                                      mostrava "Caixa já fechado." e seguia
 *                                      desenhando a gaveta morta, com os três
 *                                      botões que só repetiam a recusa.
 *
 * Agora a recusa zera a gaveta no PDV (`onChanged(null)`), o diálogo passa a
 * "Abrir caixa" dizendo o que houve e o que NÃO foi gravado, e o valor digitado
 * sai do campo — que vira "Fundo de troco", onde um Enter abriria a gaveta nova
 * com o valor da sangria como fundo.
 *
 * Cada caso falha com o comportamento antigo: sem o conserto, `onChanged` nunca
 * é chamado, o título continua "Caixa aberto" e a mensagem é a crua do servidor.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
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
}
let enviados: Enviado[] = [];
/** O que o servidor responde a movimentos e fechamento: a gaveta já morreu? */
let recusa: { code: string; message: string; status: number } | null = null;
/** A sangria acima do teto pede gestor ANTES de a gaveta ser consultada. */
let pedirLiberacao = false;

const movimentos = () => enviados.filter((e) => e.url.includes('/movements') && e.metodo === 'POST');
const aberturas = () => enviados.filter((e) => e.url.endsWith('/core/cash/open') && e.metodo === 'POST');

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

const FECHADA = { code: 'CORE_CASH_CLOSED', message: 'Caixa já fechado.', status: 409 };
const SUMIU = { code: 'CORE_CASH_NOT_FOUND', message: 'Caixa não encontrado.', status: 404 };

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (metodo !== 'GET') enviados.push({ url: alvo, metodo, corpo });
      const gavetaDaRota = alvo.includes('/movements') || alvo.includes('/close');
      if (gavetaDaRota && metodo === 'POST') {
        // Como o `CashService.addMovement`: sem liberação, a sangria acima do
        // teto é recusada por alçada — a gaveta ainda estava aberta nessa hora.
        if (pedirLiberacao && alvo.includes('/movements') && !corpo?.authorizationId) {
          return json(
            {
              error: {
                code: 'CORE_WITHDRAWAL_NEEDS_AUTHORIZATION',
                message: 'Sangria de R$ 800,00 passa do teto de R$ 500,00 desta operação.',
                details: { tetoCents: 50000, pedidoCents: 80000 },
              },
            },
            403,
          );
        }
        if (recusa) return json({ error: { code: recusa.code, message: recusa.message } }, recusa.status);
        if (alvo.includes('/close')) return json({ ...SESSAO, status: 'closed' });
        return json({ balance: 12000 }, 201);
      }
      if (alvo.includes('/core/authorizations') && metodo === 'POST') {
        return json({ id: 'auth-1', action: 'sangria_especial', authorizedBy: 'u-g', createdAt: '2026-09-14T12:00:00.000Z' }, 201);
      }
      if (alvo.endsWith('/core/cash/open') && metodo === 'POST') return json({ ...SESSAO, id: 'cash-2' }, 201);
      if (alvo.includes('/summary')) {
        return json({ session: SESSAO, expectedCents: 100000, byMethod: [], changeCents: 0, movements: [] });
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
    'teste da gaveta morta',
  );
}

beforeEach(() => {
  enviados = [];
  recusa = null;
  pedirLiberacao = false;
  localStorage.clear();
  entrarComo('operador_caixa_loja');
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da gaveta morta');
  localStorage.clear();
});

/**
 * O diálogo como o PDV o monta: `onChanged` troca a gaveta de verdade. O
 * espião diz COM O QUE ele foi chamado — `null` é o "a gaveta acabou" que faz o
 * PdvPage esquecer a lembrança dela.
 */
function montar(opcoes: { teto?: number | null; vendasEmEspera?: number } = {}) {
  const onChanged = vi.fn();
  function PdvComDialogo() {
    const [cash, setCash] = useState<unknown>(SESSAO);
    return (
      <CaixaPdvDialog
        cash={cash as never}
        tetoSangriaCents={opcoes.teto ?? null}
        vendasEmEspera={opcoes.vendasEmEspera ?? 0}
        onClose={() => undefined}
        onChanged={(proximo) => {
          onChanged(proximo);
          setCash(proximo);
        }}
      />
    );
  }
  render(<PdvComDialogo />);
  return onChanged;
}

const campoValor = () => screen.getByLabelText('Valor') as HTMLInputElement;
const campoMotivo = () => screen.getByLabelText('Motivo (obrigatório na sangria)') as HTMLInputElement;

/** A frase inteira que o operador lê no alto do diálogo. */
async function avisoDaGavetaMorta() {
  return waitFor(() => {
    const aviso = screen
      .getAllByRole('alert')
      .find((a) => /abra uma nova para continuar/.test(a.textContent ?? ''));
    expect(aviso).toBeTruthy();
    return aviso!;
  });
}

/** A gaveta morreu: o diálogo virou "Abrir caixa", com o campo vazio. */
function passouAAbrirCaixa() {
  expect(screen.getByRole('heading', { name: 'Abrir caixa' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Caixa aberto' })).toBeNull();
  // Os botões da gaveta morta sumiram — eles só repetiriam a recusa.
  expect(screen.queryByRole('button', { name: /^Sangria/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Suprimento' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Fechar caixa/ })).toBeNull();
  expect((screen.getByLabelText('Fundo de troco') as HTMLInputElement).value).toBe('');
}

// ============================================================================

describe('H-caixa-seguranca-M01 — a ação no diálogo com a gaveta já fechada em outro lugar', () => {
  it('SANGRIA recusada com CORE_CASH_CLOSED: o PDV zera a gaveta e o diálogo passa a "Abrir caixa"', async () => {
    recusa = FECHADA;
    const onChanged = montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '150,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));

    const aviso = await avisoDaGavetaMorta();
    expect(aviso.textContent).toContain('Esta gaveta já foi fechada');
    expect(aviso.textContent).toContain('abra uma nova para continuar');
    // O que NÃO entrou, com o valor: o operador ainda tem as notas na mão.
    expect(aviso.textContent).toContain(`A sangria de ${formatCents(15000)} NÃO foi registrada.`);
    // O movimento não fecha gaveta: a frase do envio anterior é só do fechamento.
    expect(aviso.textContent).not.toContain('envio anterior');
    // É o `null` que faz o PdvPage esquecer a gaveta (e a lembrança dela).
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(null);
    passouAAbrirCaixa();
    expect(movimentos()).toHaveLength(1);
  });

  it('o valor da sangria NÃO vira fundo de troco: Enter no campo vazio não abre gaveta nenhuma', async () => {
    recusa = FECHADA;
    montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '800,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await avisoDaGavetaMorta();

    // O mesmo campo, agora "Fundo de troco". Com o 800,00 ainda nele, este
    // Enter abriria a gaveta nova com R$ 800 que ninguém contou como fundo.
    fireEvent.keyDown(screen.getByLabelText('Fundo de troco'), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(aberturas()).toHaveLength(0);

    // E abrir a nova é o caminho de sempre, com o valor que a pessoa digita.
    fireEvent.change(screen.getByLabelText('Fundo de troco'), { target: { value: '100,00' } });
    fireEvent.keyDown(screen.getByLabelText('Fundo de troco'), { key: 'Enter' });
    await waitFor(() => expect(aberturas()).toHaveLength(1));
    expect(aberturas()[0].corpo?.openingCents).toBe(10000);
  });

  it('SUPRIMENTO recusado com CORE_CASH_NOT_FOUND: a mesma saída, com a razão certa', async () => {
    recusa = SUMIU;
    const onChanged = montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '50,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suprimento' }));

    const aviso = await avisoDaGavetaMorta();
    expect(aviso.textContent).toContain('Esta gaveta não existe mais nesta operação');
    expect(aviso.textContent).toContain(`O suprimento de ${formatCents(5000)} NÃO foi registrado.`);
    expect(onChanged).toHaveBeenCalledWith(null);
    passouAAbrirCaixa();
  });

  it('FECHAMENTO recusado com CORE_CASH_CLOSED: a pergunta some e a frase não acusa perda de contagem', async () => {
    recusa = FECHADA;
    const onChanged = montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '1000,00' } });
    fireEvent.click(screen.getByRole('button', { name: /Fechar caixa/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar fechamento/ }));

    const aviso = await avisoDaGavetaMorta();
    expect(aviso.textContent).toContain('Esta gaveta já foi fechada');
    // O fechamento não tem chave: o "já fechado" pode ser o do primeiro envio
    // DESTE computador, com a resposta perdida. A frase não pode dizer que a
    // contagem se perdeu.
    expect(aviso.textContent).toContain('Esta tentativa de fechamento não gravou nada');
    // Revisão: no fechamento, o "já fechado" do segundo clique pode ser o do
    // PRIMEIRO envio deste computador (resposta perdida no Wi-Fi). A frase não
    // pode mandar o operador procurar "outro computador" que fechou a gaveta
    // dele — ela nomeia esse envio também.
    expect(aviso.textContent).toContain('envio anterior deste mesmo fechamento');
    expect(screen.queryByTestId('caixa-confirmar-fechamento')).toBeNull();
    // O papel do fechamento é de quem fechou — esta tela não o oferece.
    expect(screen.queryByTestId('imprimir-fechamento')).toBeNull();
    expect(onChanged).toHaveBeenCalledWith(null);
    passouAAbrirCaixa();
  });

  it('as vendas em espera daquele turno são ditas na mesma frase — o PDV as descarta junto', async () => {
    recusa = FECHADA;
    montar({ vendasEmEspera: 2 });
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '50,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suprimento' }));

    const aviso = await avisoDaGavetaMorta();
    expect(aviso.textContent).toContain('As 2 venda(s) em espera eram daquele turno');
  });

  it('com o pedido de senha do gestor na tela, a gaveta morta fecha o pedido também', async () => {
    pedirLiberacao = true;
    const onChanged = montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '800,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await screen.findByLabelText('Autorização do gestor');

    // Enquanto o gestor chegava, a gaveta foi fechada pela lista de gavetas.
    recusa = FECHADA;
    fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'gerente' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    const aviso = await avisoDaGavetaMorta();
    expect(aviso.textContent).toContain(`A sangria de ${formatCents(80000)} NÃO foi registrada.`);
    // O pedido não fica pendurado sobre uma gaveta que não existe mais.
    await waitFor(() => expect(screen.queryByLabelText('Autorização do gestor')).toBeNull());
    expect(onChanged).toHaveBeenCalledWith(null);
    passouAAbrirCaixa();
  });

  it('outra recusa (saldo insuficiente) NÃO derruba a gaveta: ela continua aberta, com o valor no campo', async () => {
    recusa = { code: 'CORE_CASH_INSUFFICIENT', message: 'Saldo em caixa insuficiente para a sangria.', status: 409 };
    const onChanged = montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(campoValor(), { target: { value: '5000,00' } });
    fireEvent.change(campoMotivo(), { target: { value: 'depósito no banco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));

    expect(await screen.findByText('Saldo em caixa insuficiente para a sangria.')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Caixa aberto' })).toBeTruthy();
    expect(campoValor().value).toBe('5000,00');
  });
});
