/**
 * A GAVETA ESQUECIDA É APONTADA E FECHADA (GAP-PRD-131).
 *
 * O banco operacional tinha a Gringa aberta desde 12/08 e a Preço Justo desde
 * 26/08, e nenhuma tela dizia. Estes casos provam:
 *
 *  - o Painel avisa quando há gaveta de outro dia — com caixa, quem abriu e a
 *    data — e leva à tela de Caixa; sem ela, não desenha nada;
 *  - a tela de Caixa lista TODAS as gavetas abertas, com o esperado, e fecha a
 *    esquecida com a contagem digitada (o corpo que sai é o que se confere).
 *
 * E as guardas do fechamento por esta lista (H-caixa-seguranca-M02, a metade
 * que faltou): "Fechar esta gaveta" chamava `closeCash` direto — sem pergunta,
 * contra o esperado de quando a lista carregou, com venda offline da gaveta na
 * fila e com trava de envio só por estado. Cada caso do bloco M02 falha com o
 * comportamento antigo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { enqueue } from '@/lib/api/offlineQueue';
import { formatCents } from '../format';
import { AvisoCaixasEsquecidos, GavetasAbertasCard } from '../GavetasAbertas';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ESQUECIDA = {
  sessionId: 's-agosto',
  terminalId: null,
  terminalName: null,
  terminalCode: null,
  openedAt: '2026-08-12T21:51:00.000Z',
  openedBy: 'u-pdv',
  openedByName: 'gringa.pdv',
  openingCents: 10_000,
  expectedCents: 48_000,
  deOutroDia: { abertaNoDia: '2026-08-12', hoje: '2026-09-11', dias: 30 },
};

const DE_HOJE = {
  ...ESQUECIDA,
  sessionId: 's-hoje',
  terminalId: 'cx2',
  terminalName: 'Caixa 2',
  terminalCode: 'gringa-cx2',
  openedAt: new Date().toISOString(),
  openedByName: 'Beto',
  expectedCents: 5_000,
  deOutroDia: null,
};

let gavetas: Record<string, unknown>[];
let fechamentos: { url: string; corpo: unknown }[];
/** A releitura da lista falha (servidor fora) enquanto ligado. */
let listaFalha: boolean;
/** Enquanto não resolvida, o fechamento fica "no ar". */
let segurar: Promise<void> | null;
/** Outro computador fechou a gaveta antes do Confirmar: o PRIMEIRO fechamento já volta 409. */
let fechadaPorOutro: boolean;

const pausa = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  fechamentos = [];
  listaFalha = false;
  segurar = null;
  fechadaPorOutro = false;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes('/core/cash/drawers')) {
        if (listaFalha) return json({ error: { code: 'INTERNAL_ERROR', message: 'Falha ao listar.' } }, 500);
        return json({ items: gavetas, deOutroDia: gavetas.filter((g) => g.deOutroDia).length });
      }
      if (u.includes('/close')) {
        const corpo = JSON.parse(String(init?.body ?? '{}')) as { countedCents: number };
        fechamentos.push({ url: u, corpo });
        if (segurar) await segurar;
        if (fechadaPorOutro) {
          gavetas = gavetas.filter((g) => !u.includes(String(g.sessionId)));
          return json({ error: { code: 'CORE_CASH_CLOSED', message: 'Caixa já fechado.' } }, 409);
        }
        if (fechamentos.length > 1) {
          // O que o servidor real responde ao segundo fechamento da mesma gaveta.
          return json({ error: { code: 'CORE_CASH_CLOSED', message: 'Caixa já fechado.' } }, 409);
        }
        gavetas = gavetas.filter((g) => !u.includes(String(g.sessionId)));
        return json({ id: 's-agosto', status: 'closed', expected_cents: 48_000, counted_cents: corpo.countedCents, difference_cents: corpo.countedCents - 48_000 });
      }
      return json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montarCard(props: { semAGaveta?: string | null; onFechou?: () => void } = {}) {
  render(
    <MemoryRouter>
      <GavetasAbertasCard {...props} />
    </MemoryRouter>,
  );
}

describe('o Painel aponta a gaveta de outro dia', () => {
  it('com a gaveta de agosto aberta, o aviso diz quem, desde quando, e leva ao Caixa', async () => {
    gavetas = [ESQUECIDA, DE_HOJE];
    render(
      <MemoryRouter>
        <AvisoCaixasEsquecidos />
      </MemoryRouter>,
    );
    const aviso = await screen.findByTestId('caixas-esquecidos');
    expect(aviso.textContent).toMatch(/Uma gaveta está aberta desde outro dia/);
    expect(aviso.textContent).toMatch(/gringa\.pdv/);
    expect(aviso.textContent).toMatch(/12\/08\/2026 \(há 30 dias\)/);
    // A de hoje não entra no aviso.
    expect(aviso.textContent).not.toMatch(/Caixa 2/);
    expect(within(aviso).getByRole('link', { name: /Ir para Vendas › Caixa/ }).getAttribute('href')).toBe('/sistema/caixa');
  });

  it('só gavetas de hoje: o Painel não desenha aviso nenhum', async () => {
    gavetas = [DE_HOJE];
    render(
      <MemoryRouter>
        <AvisoCaixasEsquecidos />
      </MemoryRouter>,
    );
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('caixas-esquecidos')).toBeNull();
  });
});

describe('a tela de Caixa fecha a gaveta esquecida', () => {
  it('lista as abertas com o esperado e fecha a de agosto com a contagem digitada', async () => {
    gavetas = [ESQUECIDA, DE_HOJE];
    const aoFechar = vi.fn();
    montarCard({ onFechou: aoFechar });

    const lista = await screen.findByTestId('gavetas-abertas');
    expect(within(lista).getByText('Gaveta única (sem caixa)')).toBeTruthy();
    expect(within(lista).getByText('Caixa 2')).toBeTruthy();
    expect(within(lista).getByText(/De outro dia — desde 12\/08\/2026/)).toBeTruthy();
    expect(lista.textContent).toMatch(/R\$\s*480,00/);

    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '470,00' } });
    fireEvent.click(within(lista).getAllByRole('button', { name: 'Fechar esta gaveta' })[0]);
    // MUDOU (H-caixa-seguranca-M02): "Fechar esta gaveta" só pergunta; quem
    // envia é "Confirmar fechamento".
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar fechamento' }));

    await waitFor(() => expect(fechamentos).toHaveLength(1));
    expect(fechamentos[0].url).toContain('/core/cash/s-agosto/close');
    expect(fechamentos[0].corpo).toMatchObject({ countedCents: 47_000 });
    expect(await screen.findByText(/diferença/)).toBeTruthy();
    expect(aoFechar).toHaveBeenCalled();
  });
});

// ============================================================================

describe('H-caixa-seguranca-M02 — o fechamento pela lista tem as guardas do card principal', () => {
  it('"Fechar esta gaveta" não envia: pergunta "contado × esperado" com o esperado RELIDO no servidor', async () => {
    gavetas = [ESQUECIDA];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    expect(within(lista).getByTestId('gaveta-esperado-s-agosto').textContent).toContain(formatCents(48_000));

    // A lista na tela é das 14h; às 18h o servidor já diz R$ 600,00.
    gavetas = [{ ...ESQUECIDA, expectedCents: 60_000 }];
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '600,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));

    const pergunta = await screen.findByRole('alertdialog', { name: /Confirmar fechamento/ });
    // Antes: o clique fechava na hora, contra os R$ 480,00 congelados.
    expect(fechamentos).toHaveLength(0);
    expect(pergunta.textContent).toContain(formatCents(60_000));
    expect(pergunta.textContent).not.toMatch(/sobra|falta/);
    expect(screen.getByTestId('gaveta-esperado-s-agosto').textContent).toContain(formatCents(60_000));

    fireEvent.click(within(pergunta).getByRole('button', { name: 'Confirmar fechamento' }));
    await waitFor(() => expect(fechamentos).toHaveLength(1));
    expect(fechamentos[0].corpo).toMatchObject({ countedCents: 60_000 });
  });

  it('"Voltar" desfaz a pergunta, e mexer na contagem também — nada é enviado', async () => {
    gavetas = [ESQUECIDA];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '480,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));
    await screen.findByRole('alertdialog', { name: /Confirmar fechamento/ });
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));
    await screen.findByRole('alertdialog', { name: /Confirmar fechamento/ });
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '490,00' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await pausa();
    expect(fechamentos).toHaveLength(0);
  });

  it('a releitura falha: nenhuma pergunta, nenhum fechamento, e a lista continua na tela', async () => {
    gavetas = [ESQUECIDA];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    listaFalha = true;
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '470,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Não foi possível reler o esperado de Gaveta única/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('gavetas-abertas')).toBeTruthy();
    await pausa();
    expect(fechamentos).toHaveLength(0);
  });

  it('a gaveta que já fechou em outro computador: a tela diz isso e não envia nada', async () => {
    gavetas = [ESQUECIDA, DE_HOJE];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    gavetas = [DE_HOJE];
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '470,00' } });
    fireEvent.click(within(lista).getAllByRole('button', { name: 'Fechar esta gaveta' })[0]);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Gaveta única já foi fechada/);
    expect(screen.queryByLabelText('Valor contado — gaveta única')).toBeNull();
    expect(fechamentos).toHaveLength(0);
  });

  it('esperado que o servidor não mandou é "não carregado" — nunca R$ 0,00 — e não fecha', async () => {
    const { expectedCents: _semEsperado, ...semEsperado } = ESQUECIDA;
    gavetas = [semEsperado];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    expect(within(lista).getByTestId('gaveta-esperado-s-agosto').textContent).toBe('não carregado');
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '480,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/não devolveu o esperado/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fechamentos).toHaveLength(0);
  });

  it('dois cliques em "Confirmar fechamento": um fechamento só, e a faixa diz "fechada"', async () => {
    let soltar!: () => void;
    segurar = new Promise<void>((r) => {
      soltar = r;
    });
    gavetas = [ESQUECIDA];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '480,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));
    const confirmar = await screen.findByRole('button', { name: 'Confirmar fechamento' });
    fireEvent.click(confirmar);
    fireEvent.click(confirmar);
    await pausa();
    expect(fechamentos).toHaveLength(1);

    soltar();
    expect(await screen.findByText(/Gaveta única fechada\./)).toBeTruthy();
    expect(screen.queryByText('Caixa já fechado.')).toBeNull();
    expect(fechamentos).toHaveLength(1);
  });

  it('dois cliques ANTES de a tela redesenhar: é o ref que barra o segundo envio', async () => {
    /*
      O caso acima não separa o ref do estado: `fireEvent` redesenha entre um
      clique e outro, e o segundo já encontra o botão desabilitado. No navegador,
      o clique duplo pode chegar antes do redesenho — com o botão ainda
      habilitado e `fechando` ainda nulo. Os dois cliques dentro do MESMO `act`
      reproduzem isso: sem o ref, saem dois fechamentos.
    */
    let soltar!: () => void;
    segurar = new Promise<void>((r) => {
      soltar = r;
    });
    gavetas = [ESQUECIDA];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '480,00' } });
    fireEvent.click(within(lista).getByRole('button', { name: 'Fechar esta gaveta' }));
    const confirmar = (await screen.findByRole('button', { name: 'Confirmar fechamento' })) as HTMLButtonElement;
    act(() => {
      confirmar.click();
      confirmar.click();
    });
    await pausa();
    expect(fechamentos).toHaveLength(1);

    soltar();
    expect(await screen.findByText(/Gaveta única fechada\./)).toBeTruthy();
    expect(screen.queryByText('Caixa já fechado.')).toBeNull();
    expect(fechamentos).toHaveLength(1);
  });

  it('outro computador fecha entre a pergunta e o Confirmar: a faixa diz, a lista é relida e a gaveta sai', async () => {
    gavetas = [ESQUECIDA, DE_HOJE];
    const onFechou = vi.fn();
    montarCard({ onFechou });
    const lista = await screen.findByTestId('gavetas-abertas');
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '480,00' } });
    const [fecharAgosto] = within(lista).getAllByRole('button', { name: 'Fechar esta gaveta' });
    fireEvent.click(fecharAgosto);
    const confirmar = await screen.findByRole('button', { name: 'Confirmar fechamento' });
    // Entre a pergunta e o clique, o Caixa 1 fechou esta gaveta.
    fechadaPorOutro = true;
    fireEvent.click(confirmar);

    expect(await screen.findByText(/Gaveta única já foi fechada — por outra tela ou outro computador/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText('Valor contado — gaveta única')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Confirmar fechamento' })).toBeNull();
    expect(screen.queryByText('Caixa já fechado.')).toBeNull();
    expect(onFechou).toHaveBeenCalled();
  });

  it('venda offline DESTA gaveta na fila trava o fechamento dela; a outra gaveta segue fechável', async () => {
    enqueue({
      path: '/core/sales',
      method: 'POST',
      body: { items: [], payments: [{ method: 'dinheiro', amountCents: 5000 }], cashSessionId: 's-agosto' },
      idempotencyKey: 'venda-da-queda',
      label: 'venda do PDV',
      escopo: { userId: 'u-x', companyId: 'loja' },
    });
    gavetas = [ESQUECIDA, DE_HOJE];
    montarCard();
    const lista = await screen.findByTestId('gavetas-abertas');

    const aviso = await screen.findByTestId('gaveta-fila-offline-s-agosto');
    expect(aviso.textContent).toMatch(/1 venda\(s\) guardada\(s\) neste computador/);
    const [fecharAgosto, fecharHoje] = within(lista).getAllByRole('button', { name: 'Fechar esta gaveta' }) as HTMLButtonElement[];
    fireEvent.change(within(lista).getByLabelText('Valor contado — gaveta única'), { target: { value: '480,00' } });
    expect(fecharAgosto.disabled).toBe(true);
    fireEvent.click(fecharAgosto);
    await pausa();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fechamentos).toHaveLength(0);

    // A venda é da gaveta de agosto: a do Caixa 2 não trava.
    expect(screen.queryByTestId('gaveta-fila-offline-s-hoje')).toBeNull();
    fireEvent.change(within(lista).getByLabelText('Valor contado — Caixa 2'), { target: { value: '50,00' } });
    expect(fecharHoje.disabled).toBe(false);
  });

  it('a gaveta que a tela já fecha no card principal fica fora da lista', async () => {
    gavetas = [ESQUECIDA, DE_HOJE];
    montarCard({ semAGaveta: 's-hoje' });
    const lista = await screen.findByTestId('gavetas-abertas');
    expect(within(lista).getByText('Gaveta única (sem caixa)')).toBeTruthy();
    expect(within(lista).queryByText('Caixa 2')).toBeNull();
    expect(within(lista).queryByLabelText('Valor contado — Caixa 2')).toBeNull();
    cleanup();

    gavetas = [DE_HOJE];
    montarCard({ semAGaveta: 's-hoje' });
    expect(await screen.findByText(/Nenhuma outra gaveta aberta — a deste caixa está no card acima/)).toBeTruthy();
    expect(screen.queryByTestId('gavetas-abertas')).toBeNull();
  });
});
