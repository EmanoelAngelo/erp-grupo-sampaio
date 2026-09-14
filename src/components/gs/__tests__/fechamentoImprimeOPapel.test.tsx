/**
 * O FECHAMENTO TERMINA COM O PAPEL NA MÃO — e o resumo fala a língua do balcão.
 *
 *   H-caixa-seguranca-11 (tela)  o servidor já desenhava o papel do fechamento
 *                                (`CASH_CLOSING`), e nenhuma tela o pedia: o
 *                                operador fechava o turno e ia embora sem nada
 *                                para assinar. Agora as TRÊS portas que fecham
 *                                gaveta — o diálogo do PDV, a tela de Caixa e a
 *                                lista de gavetas abertas — oferecem
 *                                "Imprimir fechamento" com o foco no botão:
 *                                Enter imprime, Esc segue. A impressão que falha
 *                                diz o motivo e não desfaz o fechamento.
 *   PED-caixa-01                 "Recebido no turno, por meio" mostrava o código
 *                                cru do banco ("debito", "crediario").
 *
 * Cada caso falha com o comportamento antigo: sem a oferta não há botão para
 * achar, e sem o rótulo a lista diz "debito".
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { CaixaPage } from '@/pages/gs/OperacaoPages';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { GavetasAbertasCard } from '../GavetasAbertas';

type Impressao = { via: 'agente' | 'navegador'; aviso: string | null };
const printDocument = vi.fn(async (..._args: unknown[]): Promise<Impressao> => ({ via: 'agente', aviso: null }));
vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: (...args: unknown[]) => printDocument(...args),
}));

/** A gaveta do Caixa 1 no PDV. */
const GAVETA_DO_PDV = {
  id: 'cash-1',
  company_id: 'loja',
  terminal_id: 'cx-1',
  opened_by: 'u-caixa',
  opening_cents: 20000,
  status: 'open',
  opened_at: '2026-09-14T08:00:00.000Z',
  closed_at: null,
  expected_cents: null,
  counted_cents: null,
  difference_cents: null,
};

/** A gaveta única, vista pela tela de Caixa da gestão. */
const GAVETA_DA_GESTAO = { ...GAVETA_DO_PDV, id: 's-aberta', terminal_id: null };

const ESQUECIDA = {
  sessionId: 's-agosto',
  terminalId: 'cx-2',
  terminalName: 'Caixa 2',
  terminalCode: 'loja-cx2',
  openedAt: '2026-08-12T21:51:00.000Z',
  openedBy: 'u-pdv',
  openedByName: 'Beto',
  openingCents: 10_000,
  expectedCents: 48_000,
  deOutroDia: { abertaNoDia: '2026-08-12', hoje: '2026-09-14', dias: 33 },
};

let fechamentos: { url: string; corpo: Record<string, unknown> }[];
let reaberturas: string[];
let porMeio: { method: string; total: number }[];
let caixaDaGestaoAberto: boolean;
let gavetas: Record<string, unknown>[];

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (u.includes('/summary')) {
        return json({ session: GAVETA_DO_PDV, expectedCents: 45275, changeCents: 0, byMethod: porMeio, movements: [] });
      }
      if (u.includes('/reopen') && metodo === 'POST') {
        reaberturas.push(u);
        return json({});
      }
      if (u.includes('/close') && metodo === 'POST') {
        fechamentos.push({ url: u, corpo });
        caixaDaGestaoAberto = false;
        gavetas = gavetas.filter((g) => !u.includes(String(g.sessionId)));
        const contado = Number(corpo.countedCents);
        return json({ ...GAVETA_DO_PDV, status: 'closed', expected_cents: 45275, counted_cents: contado, difference_cents: contado - 45275 });
      }
      if (u.includes('/core/cash/open')) {
        return json({ session: caixaDaGestaoAberto ? GAVETA_DA_GESTAO : null, cashWithdrawalLimitCents: null });
      }
      if (u.includes('/core/cash/drawers')) return json({ items: gavetas, deOutroDia: 0 });
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
    'teste do papel do fechamento',
  );
}

beforeEach(() => {
  fechamentos = [];
  reaberturas = [];
  porMeio = [];
  caixaDaGestaoAberto = true;
  gavetas = [];
  printDocument.mockReset();
  printDocument.mockImplementation(async () => ({ via: 'agente', aviso: null }));
  localStorage.clear();
  entrarComo('operador_caixa_loja');
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do papel do fechamento');
  localStorage.clear();
});

/**
 * O diálogo como o PDV o monta: `onChanged(null)` ZERA a gaveta — é o que o
 * PdvPage faz no fechamento. A oferta do papel precisa sobreviver a isso.
 */
function PdvComDialogo({ onClose }: { onClose?: () => void }) {
  const [cash, setCash] = useState<unknown>(GAVETA_DO_PDV);
  return (
    <CaixaPdvDialog
      cash={cash as never}
      tetoSangriaCents={null}
      vendasEmEspera={0}
      onClose={onClose ?? (() => undefined)}
      onChanged={(proximo) => setCash(proximo)}
    />
  );
}

/** Conta a gaveta e confirma o fechamento no diálogo do PDV. */
async function fecharNoDialogo() {
  await screen.findByTestId('caixa-esperado');
  fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '452,75' } });
  fireEvent.click(screen.getByRole('button', { name: /Fechar caixa/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Confirmar fechamento/i }));
  return screen.findByTestId('imprimir-fechamento');
}

// ============================================================================

describe('H-caixa-seguranca-11 — o diálogo de caixa do PDV oferece o papel do fechamento', () => {
  it('fechou: a oferta aparece com o foco em "Imprimir fechamento", e Enter imprime O TURNO QUE FECHOU', async () => {
    render(<PdvComDialogo />);
    const oferta = await fecharNoDialogo();

    // O PDV já zerou a gaveta (o diálogo voltou a "Abrir caixa") — e o papel
    // continua sendo do turno que fechou, no caixa dele.
    expect(screen.getByRole('heading', { name: 'Abrir caixa' })).toBeTruthy();
    const imprimir = within(oferta).getByRole('button', { name: 'Imprimir fechamento' });
    await waitFor(() => expect(document.activeElement).toBe(imprimir));

    fireEvent.keyDown(imprimir, { key: 'Enter' });
    await waitFor(() => expect(printDocument).toHaveBeenCalledTimes(1));
    expect(printDocument).toHaveBeenCalledWith('CASH_CLOSING', 'cash-1', { terminalId: 'cx-1' });
    expect((await within(oferta).findByRole('status')).textContent).toMatch(/saiu na impressora do caixa/);
    expect(fechamentos).toHaveLength(1);
  });

  it('a impressão que falha diz o motivo, NÃO desfaz o fechamento, e deixa tentar de novo', async () => {
    printDocument.mockRejectedValueOnce(new Error('Impressora sem papel.'));
    render(<PdvComDialogo />);
    const oferta = await fecharNoDialogo();

    fireEvent.click(within(oferta).getByRole('button', { name: 'Imprimir fechamento' }));
    const aviso = await within(oferta).findByRole('alert');
    expect(aviso.textContent).toMatch(/não desfaz o fechamento do turno/);
    expect(aviso.textContent).toMatch(/Impressora sem papel\./);
    // Nada foi desfeito: um fechamento só, nenhuma reabertura.
    expect(fechamentos).toHaveLength(1);
    expect(reaberturas).toHaveLength(0);

    fireEvent.click(within(oferta).getByRole('button', { name: 'Imprimir fechamento' }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledTimes(2));
    expect(await within(oferta).findByRole('status')).toBeTruthy();
  });

  it('o agente ainda imprimindo: a tela NÃO diz que o papel não saiu nem manda tentar de novo', async () => {
    // Revisão: a frase fixa antiga era "só o papel não saiu. <motivo> Confira a
    // impressora e tente de novo." — contradizendo o motivo e convidando a um
    // segundo papel com o foco no botão.
    printDocument.mockRejectedValueOnce(
      new Error('O agente do caixa está imprimindo e ainda não confirmou — aguarde o papel antes de imprimir de novo.'),
    );
    render(<PdvComDialogo />);
    const oferta = await fecharNoDialogo();

    fireEvent.click(within(oferta).getByRole('button', { name: 'Imprimir fechamento' }));
    const aviso = await within(oferta).findByRole('alert');
    expect(aviso.textContent).toMatch(/aguarde o papel antes de imprimir de novo/);
    expect(aviso.textContent).not.toMatch(/papel não saiu/);
    expect(aviso.textContent).not.toMatch(/tente de novo/);
    expect(fechamentos).toHaveLength(1);
  });

  it('Esc segue sem imprimir: a oferta sai e o diálogo fica; o Esc seguinte fecha o diálogo', async () => {
    const onClose = vi.fn();
    render(<PdvComDialogo onClose={onClose} />);
    const oferta = await fecharNoDialogo();
    const imprimir = within(oferta).getByRole('button', { name: 'Imprimir fechamento' });
    await waitFor(() => expect(document.activeElement).toBe(imprimir));

    fireEvent.keyDown(imprimir, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('imprimir-fechamento')).toBeNull());
    expect(printDocument).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('caixa-pdv')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================

describe('H-caixa-seguranca-11 — a tela de Caixa da gestão oferece o papel do fechamento', () => {
  it('fechou pela tela de Caixa: "Imprimir fechamento" com o foco, e imprime a sessão que fechou', async () => {
    entrarComo('gerente_loja');
    render(
      <MemoryRouter>
        <CaixaPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('caixa-gestao-esperado').textContent).toMatch(/452,75/));
    fireEvent.change(screen.getByLabelText('Valor contado no fechamento'), { target: { value: '452,75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar caixa' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar fechamento' }));

    const oferta = await screen.findByTestId('imprimir-fechamento');
    const imprimir = within(oferta).getByRole('button', { name: 'Imprimir fechamento' });
    await waitFor(() => expect(document.activeElement).toBe(imprimir));
    fireEvent.keyDown(imprimir, { key: 'Enter' });

    await waitFor(() => expect(printDocument).toHaveBeenCalledTimes(1));
    expect(printDocument).toHaveBeenCalledWith('CASH_CLOSING', 's-aberta', { terminalId: null });
    expect(fechamentos).toHaveLength(1);
    // O fechamento continua anunciado — o papel não substitui a faixa.
    expect(screen.getByText(/Caixa fechado\./)).toBeTruthy();
  });
});

// ============================================================================

describe('H-caixa-seguranca-11 — a lista de gavetas abertas também fecha, e também imprime', () => {
  /*
    MUDOU (revisor da trilha caixa): o papel ia para a impressora do caixa DA
    GAVETA (cx-2). Esta lista existe para o gestor fechar a gaveta esquecida sem
    ir até ela (GAP-PRD-131); o papel para assinar sai NESTE computador — e,
    sem caixa registrado aqui, pelo navegador.
  */
  it('o gestor fecha a gaveta esquecida do Caixa 2 e imprime o papel DELA neste computador, não no caixa dela', async () => {
    entrarComo('gerente_loja');
    gavetas = [ESQUECIDA];
    render(
      <MemoryRouter>
        <GavetasAbertasCard />
      </MemoryRouter>,
    );
    const lista = await screen.findByTestId('gavetas-abertas');
    fireEvent.change(within(lista).getByLabelText('Valor contado — Caixa 2'), { target: { value: '480,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));
    // MUDOU (H-caixa-seguranca-M02): "Fechar esta gaveta" só pergunta, com o
    // esperado relido no servidor; quem envia é "Confirmar fechamento".
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar fechamento' }));

    const oferta = await screen.findByTestId('imprimir-fechamento');
    const imprimir = within(oferta).getByRole('button', { name: 'Imprimir fechamento' });
    await waitFor(() => expect(document.activeElement).toBe(imprimir));
    fireEvent.keyDown(imprimir, { key: 'Enter' });

    const { caixaDesteComputador } = await import('@/lib/api/terminais');
    const { getSession } = await import('@/lib/api/client');
    const desteComputador = caixaDesteComputador(getSession()?.company.id) ?? null;
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('CASH_CLOSING', 's-agosto', { terminalId: desteComputador }));
    expect(desteComputador).not.toBe('cx-2');
    expect(fechamentos[0].url).toContain('/core/cash/s-agosto/close');
  });
});

// ============================================================================

describe('PED-caixa-01 — o resumo do turno mostra o meio de pagamento pelo nome', () => {
  it('"debito" vira "Cartão de débito", "pix" vira "PIX"; código desconhecido aparece como veio', async () => {
    porMeio = [
      { method: 'dinheiro', total: 40000 },
      { method: 'debito', total: 12000 },
      { method: 'credito', total: 9000 },
      { method: 'pix', total: 30000 },
      { method: 'crediario', total: 5000 },
      { method: 'transferencia', total: 1000 },
      { method: 'cheque_do_cliente', total: 700 },
    ];
    render(<PdvComDialogo />);
    const titulo = await screen.findByRole('heading', { name: 'Recebido no turno, por meio' });
    const itens = within(titulo.closest('section') as HTMLElement)
      .getAllByRole('listitem')
      .map((li) => li.firstElementChild?.textContent);

    expect(itens).toEqual([
      'Dinheiro',
      'Cartão de débito',
      'Cartão de crédito',
      'PIX',
      'Crediário',
      'Transferência',
      'cheque_do_cliente',
    ]);
  });
});
