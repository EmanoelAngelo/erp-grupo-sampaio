/**
 * ============================================================================
 * O DINHEIRO ELETRÔNICO SEM DONO, PELA TELA (GAP-PRD-078, GAP-PRD-080, GAP-PRD-081)
 * ============================================================================
 *
 * O que estes casos cobram:
 *
 * 1. "Desistir desta cobrança" CANCELA na maquininha (chama o servidor) — e
 *    tirar da venda a linha que veio do aparelho também. Se a operadora não
 *    cancela, a cobrança continua na tela, com a recusa e onde procurá-la.
 * 2. A Conferência de maquininha tem as filas "Cobranças sem venda" e
 *    "Estornos a fazer", com as saídas (tratativa, amarrar pelo número da
 *    venda, cancelar/estornar, estorno no aparelho) e o erro do servidor como
 *    veio. Falha ao carregar não vira "nada pendente".
 * 3. As três telas que fecham gaveta mostram as pendências do turno e só
 *    fecham com ciência e motivo — e a lista que o servidor manda na recusa
 *    vale mais que a do resumo.
 * 4. Cancelar/devolver diz o que aconteceu com o estorno na maquininha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { fraseDosEstornosNaMaquininha } from '@/lib/api/maquininhas';
import { formatCents } from '../format';
import { PagamentoDialog } from '../PagamentoDialog';
import { PendenciasDaMaquininhaCard } from '../PendenciasDaMaquininhaCard';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { GavetasAbertasCard } from '../GavetasAbertas';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function recusa(status: number, code: string, message: string, details?: unknown) {
  return json({ error: { code, message, details } }, status);
}

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };
let chamadas: Chamada[];

function servidor(rotear: (u: string, method: string, body: Record<string, unknown> | null) => Response | undefined) {
  chamadas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ url: u, method, body });
      return rotear(u, method, body) ?? json({ items: [] });
    }),
  );
}

const chamou = (trecho: string, method = 'POST') => chamadas.filter((c) => c.url.includes(trecho) && c.method === method);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================
describe('GAP-PRD-078 — desistir no balcão cancela na maquininha', () => {
  const MEIOS = [
    { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
    { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
    { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
  ];
  const PIX_PENDENTE = {
    transactionId: 'pttx-pix-1',
    state: 'processando',
    message: 'QR na maquininha.',
    settled: false,
    needsReconciliation: false,
    amountInCents: 5000,
    method: 'pix',
    simulated: true,
    qrPayload: '00020126MOCK-PIX-5000',
  };
  const CARTAO_APROVADO = {
    transactionId: 'pttx-cartao-1',
    state: 'aprovado',
    message: 'Pagamento aprovado.',
    settled: true,
    needsReconciliation: false,
    amountInCents: 5000,
    method: 'credit',
    simulated: true,
  };

  function balcao(desistir: () => Response) {
    servidor((u) => {
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/pdv/terminal/status')) {
        return json({ configured: true, provider: 'mock', readiness: 'CONFIGURED', message: 'Maquininha mock.' });
      }
      if (u.includes('/desistir')) return desistir();
      if (u.includes('/pdv/terminal/charge')) {
        const ultimo = chamadas[chamadas.length - 1];
        return json(ultimo.body?.method === 'pix' ? PIX_PENDENTE : CARTAO_APROVADO);
      }
      if (u.includes('/pdv/terminal/pttx-pix-1')) return json(PIX_PENDENTE);
      return undefined;
    });
  }

  async function cobrar(meio: RegExp) {
    render(<PagamentoDialog totalCents={5000} onConfirm={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: meio }));
    fireEvent.click(screen.getByRole('button', { name: /Cobrar na maquininha/ }));
  }

  it('desistir do PIX pede o cancelamento ao servidor e tira a espera da tela', async () => {
    balcao(() => json({ ...PIX_PENDENTE, state: 'cancelado', message: 'Operação cancelada na maquininha.', qrPayload: null }));
    await cobrar(/^PIX/);
    await screen.findByTestId('pdv-pix-na-maquininha');

    fireEvent.click(screen.getByRole('button', { name: /Desistir desta cobrança/ }));
    await waitFor(() => expect(screen.queryByTestId('pdv-pix-na-maquininha')).toBeNull());
    const pedidos = chamou('/core/pdv/terminal/pttx-pix-1/desistir');
    expect(pedidos).toHaveLength(1);
    expect(String(pedidos[0].body?.reason)).toMatch(/desistiu/i);
    expect(screen.getByText(/Operação cancelada na maquininha/)).toBeTruthy();
  });

  it('se a operadora não cancela, o PIX continua na tela com a recusa e onde procurá-lo', async () => {
    balcao(() =>
      recusa(409, 'PAYMENT_TERMINAL_PROVIDER_PENDING', 'A operadora não confirmou o cancelamento.'),
    );
    await cobrar(/^PIX/);
    await screen.findByTestId('pdv-pix-na-maquininha');
    fireEvent.click(screen.getByRole('button', { name: /Desistir desta cobrança/ }));
    await waitFor(() => expect(chamou('/desistir')).toHaveLength(1));
    expect(await screen.findByText(/A operadora não confirmou o cancelamento\..*Conferência de maquininha/)).toBeTruthy();
    expect(screen.getByTestId('pdv-pix-na-maquininha')).toBeTruthy();
  });

  it('tirar da venda o cartão aprovado desfaz a cobrança; recusado, a linha fica', async () => {
    let resposta = () => recusa(409, 'PAYMENT_TERMINAL_OPERATION_IN_PROGRESS', 'Já existe um pedido em curso.');
    balcao(() => resposta());
    await cobrar(/^Crédito/);
    const remover = await screen.findByRole('button', { name: /Remover Crédito/ });

    fireEvent.click(remover);
    await waitFor(() => expect(chamou('/core/pdv/terminal/pttx-cartao-1/desistir')).toHaveLength(1));
    expect(await screen.findByText(/Já existe um pedido em curso/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Remover Crédito/ })).toBeTruthy();

    resposta = () => json({ ...CARTAO_APROVADO, state: 'cancelado', settled: false, message: 'Operação cancelada na maquininha.' });
    fireEvent.click(screen.getByRole('button', { name: /Remover Crédito/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Remover Crédito/ })).toBeNull());
    expect(chamou('/desistir')).toHaveLength(2);
  });
});

// ============================================================================
describe('GAP-PRD-078/080 — as filas do gestor na Conferência de maquininha', () => {
  const SEM_VENDA = {
    transactionId: 'pttx-pix-9',
    state: 'aprovado',
    message: 'Pagamento aprovado.',
    settled: true,
    needsReconciliation: false,
    amountInCents: 5000,
    method: 'pix',
    simulated: true,
    provider: 'mock',
    startedAt: '2026-09-11T12:00:00.000Z',
    idadeMinutos: 42,
    createdBy: 'u1',
    pdvTerminalId: null,
    cashSessionId: null,
    saleId: null,
    saleNumber: null,
    refundedAmountInCents: 0,
    aEstornarCents: 0,
    ultimoPedido: null,
    pedidoNoAgente: false,
  };
  const A_ESTORNAR = {
    ...SEM_VENDA,
    transactionId: 'pttx-stone-1',
    method: 'credit',
    simulated: false,
    provider: 'stone',
    amountInCents: 8000,
    aEstornarCents: 8000,
    saleId: 'v-41',
    saleNumber: 41,
    ultimoPedido: {
      origem: 'cancelamento',
      referenciaId: 'v-41',
      amountInCents: 8000,
      requestedAt: '2026-09-11T12:30:00.000Z',
      reason: 'Cliente desistiu',
    },
  };

  function fila(extra: (u: string) => Response | undefined = () => undefined) {
    servidor((u) => {
      const outro = extra(u);
      if (outro) return outro;
      if (u.includes('/core/pdv/terminal/pendencias')) {
        return json({ minutos: 10, semVenda: [SEM_VENDA], aEstornar: [A_ESTORNAR] });
      }
      return json({ transactionId: 'x', state: 'aprovado', settled: true, saleNumber: 1042 });
    });
  }

  async function abrirAcao(linha: string, botao: RegExp) {
    render(<PendenciasDaMaquininhaCard />);
    const celula = await screen.findByText(linha);
    const tr = celula.closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('button', { name: botao }));
    return screen.getByRole('dialog');
  }

  it('mostra a cobrança sem venda e o estorno a fazer, cada um com o seu valor', async () => {
    fila();
    render(<PendenciasDaMaquininhaCard />);
    const pix = (await screen.findByText('pttx-pix-9')).closest('tr') as HTMLElement;
    expect(pix.textContent).toMatch(/PIX/);
    expect(pix.textContent).toMatch(/Aprovada, sem venda/);
    expect(pix.textContent).toContain(formatCents(5000));
    expect(within(pix).getByText('TESTE')).toBeTruthy();
    const estorno = screen.getByText('pttx-stone-1').closest('tr') as HTMLElement;
    expect(estorno.textContent).toMatch(/Venda #41 · cancelamento/);
    expect(estorno.textContent).toContain(formatCents(8000));
  });

  it('falha ao carregar NÃO vira "nenhuma cobrança sem venda"', async () => {
    fila((u) => (u.includes('/pendencias') ? recusa(500, 'API_UNAVAILABLE', 'Servidor fora do ar.') : undefined));
    render(<PendenciasDaMaquininhaCard />);
    expect(await screen.findByText('Servidor fora do ar.')).toBeTruthy();
    expect(screen.queryByText('Nenhuma cobrança sem venda')).toBeNull();
  });

  it('o prazo escolhido vai para o servidor', async () => {
    fila();
    render(<PendenciasDaMaquininhaCard />);
    await screen.findByText('pttx-pix-9');
    fireEvent.change(screen.getByRole('combobox', { name: /Prazo/ }), { target: { value: '0' } });
    await waitFor(() => expect(chamou('/pendencias?minutos=0', 'GET').length).toBeGreaterThan(0));
  });

  it('registrar a tratativa exige motivo e manda o motivo', async () => {
    fila();
    const dialogo = await abrirAcao('pttx-pix-9', /Registrar tratativa/);
    const confirmar = within(dialogo).getByRole('button', { name: /^Registrar$/ }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'PIX devolvido pelo banco' } });
    expect(confirmar.disabled).toBe(false);
    fireEvent.click(confirmar);
    await waitFor(() => expect(chamou('/core/pdv/terminal/pttx-pix-9/tratativa')).toHaveLength(1));
    expect(chamou('/tratativa')[0].body).toEqual({ reason: 'PIX devolvido pelo banco' });
    expect(await screen.findByText(/Tratativa registrada/)).toBeTruthy();
  });

  it('amarrar à venda vai pelo NÚMERO da venda', async () => {
    fila();
    const dialogo = await abrirAcao('pttx-pix-9', /Amarrar à venda/);
    fireEvent.change(within(dialogo).getByLabelText('Número da venda'), { target: { value: '1042' } });
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'NSU confere' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /^Amarrar$/ }));
    await waitFor(() => expect(chamou('/core/pdv/terminal/pttx-pix-9/vincular-venda')).toHaveLength(1));
    expect(chamou('/vincular-venda')[0].body).toEqual({ saleNumber: 1042, reason: 'NSU confere' });
    expect(await screen.findByText(/amarrada à venda #1042/)).toBeTruthy();
  });

  it('cancelar na operadora usa a porta do módulo', async () => {
    fila();
    const dialogo = await abrirAcao('pttx-pix-9', /Cancelar na operadora/);
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'Cliente pagou em dinheiro' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Pedir o cancelamento/ }));
    await waitFor(() => expect(chamou('/payment-terminals/transactions/pttx-pix-9/cancel')).toHaveLength(1));
  });

  it('o estorno a fazer: pedir de novo mostra a recusa como veio; estorno no aparelho é registrado', async () => {
    fila((u) =>
      u.includes('/refund')
        ? recusa(409, 'PAYMENT_TERMINAL_PROVIDER_PENDING', 'A operadora não confirmou o estorno.')
        : undefined,
    );
    let dialogo = await abrirAcao('pttx-stone-1', /Pedir o estorno de novo/);
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'Operadora voltou' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Pedir o estorno/ }));
    expect(await within(dialogo).findByText('A operadora não confirmou o estorno.')).toBeTruthy();
    expect(chamou('/payment-terminals/transactions/pttx-stone-1/refund')[0].body).toEqual({
      reason: 'Operadora voltou',
      amountInCents: 8000,
    });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Voltar' }));

    const tr = screen.getByText('pttx-stone-1').closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('button', { name: /Estornado no aparelho/ }));
    dialogo = screen.getByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'NSU 991122 no aparelho' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Registrar o estorno/ }));
    await waitFor(() => expect(chamou('/core/pdv/terminal/pttx-stone-1/estorno-manual')).toHaveLength(1));
  });
});

// ============================================================================
describe('GAP-PRD-081 — o turno só fecha com as pendências ditas e declaradas', () => {
  const PENDENCIAS = {
    cobrancas: [
      {
        transactionId: 't-incerta',
        tipo: 'nao_confirmada',
        state: 'timeout_nao_confirmado',
        method: 'credit',
        amountInCents: 7000,
        simulated: false,
        startedAt: null,
        saleId: null,
      },
    ],
    pagamentosPendentes: [{ paymentId: 'p1', saleId: 'v1', saleNumber: 41, method: 'pix', amountCents: 5000 }],
    quantidade: 2,
    totalCents: 12000,
  };
  const CAIXA = { id: 'sessao-1', company_id: 'c1', opening_cents: 0, status: 'open', opened_at: '2026-09-11T11:00:00.000Z' };
  const RESUMO = { expectedCents: 0, changeCents: 0, byMethod: [], movements: [] };

  beforeEach(() => {
    setSession(
      {
        accessToken: 'tok',
        refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000,
        user: { id: 'u1', login: 'caixa', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
        company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
        companies: [],
      } as never,
      'LOGIN',
      'teste de pendências',
    );
  });

  function caixa(opcoes: { resumoComPendencias: boolean; fechar: (body: Record<string, unknown> | null) => Response }) {
    servidor((u, _m, body) => {
      if (u.includes('/summary')) {
        return json({ ...RESUMO, pendenciasEletronicas: opcoes.resumoComPendencias ? PENDENCIAS : null });
      }
      if (u.includes('/close')) return opcoes.fechar(body);
      return undefined;
    });
  }

  async function pedirFechamento() {
    render(
      <CaixaPdvDialog cash={CAIXA as never} tetoSangriaCents={null} vendasEmEspera={0} onClose={() => undefined} onChanged={() => undefined} />,
    );
    fireEvent.change(await screen.findByLabelText('Valor'), { target: { value: '0,00' } });
    await waitFor(() => expect((screen.getByRole('button', { name: /^Fechar caixa$/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^Fechar caixa$/ }));
    return screen.getByRole('button', { name: /Confirmar fechamento/ }) as HTMLButtonElement;
  }

  it('o diálogo do PDV mostra as pendências e só confirma com ciência e motivo', async () => {
    caixa({ resumoComPendencias: true, fechar: () => json({ ...CAIXA, status: 'closed' }) });
    const confirmar = await pedirFechamento();
    const bloco = screen.getByTestId('pendencias-do-fechamento');
    expect(bloco.textContent).toMatch(/Cobrança sem resposta da operadora/);
    expect(bloco.textContent).toMatch(/PIX pendente na venda #41/);
    expect(confirmar.disabled).toBe(true);

    fireEvent.click(within(bloco).getByLabelText(/Estou ciente/));
    fireEvent.change(within(bloco).getByLabelText('Motivo para fechar com pendências'), {
      target: { value: 'Gerente confere amanhã' },
    });
    expect(confirmar.disabled).toBe(false);
    fireEvent.click(confirmar);
    await waitFor(() => expect(chamou('/close')).toHaveLength(1));
    expect(chamou('/close')[0].body).toMatchObject({
      countedCents: 0,
      pendenciasCiente: true,
      pendenciasMotivo: 'Gerente confere amanhã',
    });
  });

  /*
    A DEVOLUÇÃO EM DUAS ETAPAS QUE AINDA NÃO PAGOU O CLIENTE (auditoria do PDV).

    O DEFEITO: na Preço Justo a devolução trata a MERCADORIA na hora e o
    dinheiro depois. Entre uma coisa e outra a loja deve aquele valor — e em
    espécie ele continua DENTRO da gaveta, sem ser da loja. O fechamento passava
    calado: diferença zero, "conferido", e o operador ia embora sem saber. O
    servidor passou a devolvê-la junto das outras pendências do turno; aqui se
    prova que o bloco do fechamento a ESCREVE, com a venda e o valor que falta.
  */
  it('a devolução sem reembolso aparece no bloco, com a venda e o que falta devolver', async () => {
    caixa({
      resumoComPendencias: false,
      fechar: () =>
        recusa(409, 'CORE_CASH_CLOSE_ELECTRONIC_PENDING', 'Este turno tem 1 pendência(s).', {
          pendencias: {
            cobrancas: [],
            pagamentosPendentes: [],
            vendasOffline: [],
            devolucoesAguardandoReembolso: [
              {
                id: 'dev-1',
                number: 7,
                saleId: 'v-9',
                saleNumber: 9,
                devolvivelCents: 5000,
                reembolsadoCents: 2000,
                pendenteCents: 3000,
                createdAt: '2026-09-11T12:00:00.000Z',
              },
            ],
            quantidade: 1,
            totalCents: 3000,
          },
        }),
    });
    const confirmar = await pedirFechamento();
    fireEvent.click(confirmar);
    const bloco = await screen.findByTestId('pendencias-do-fechamento');
    // O título deixa de falar só em "dinheiro eletrônico": esta não é.
    expect(bloco.textContent).toMatch(/Pendências deste turno/);
    expect(bloco.textContent).toMatch(/Devolução #7 da venda #9/);
    expect(bloco.textContent).toMatch(/R\$\s?30,00 ainda\s*não devolvidos ao cliente/);
    // O parcial diz o que já voltou, senão o operador não sabe o que conferir.
    expect(bloco.textContent).toMatch(/já voltaram/);
    expect(bloco.textContent).toMatch(/Vendas › Devoluções/);

    // E ela também só passa com ciência e motivo, como as outras.
    fireEvent.click(within(bloco).getByLabelText(/Estou ciente/));
    fireEvent.change(within(bloco).getByLabelText('Motivo para fechar com pendências'), {
      target: { value: 'o gerente faz o PIX amanhã cedo' },
    });
    fireEvent.click(confirmar);
    await waitFor(() => expect(chamou('/close')).toHaveLength(2));
    expect(chamou('/close')[1].body).toMatchObject({
      pendenciasCiente: true,
      pendenciasMotivo: 'o gerente faz o PIX amanhã cedo',
    });
  });

  it('sem pendência no resumo, a recusa do servidor traz a lista e pede a ciência', async () => {
    caixa({
      resumoComPendencias: false,
      fechar: () =>
        recusa(409, 'CORE_CASH_CLOSE_ELECTRONIC_PENDING', 'Este turno tem 2 pendência(s) eletrônica(s).', {
          pendencias: PENDENCIAS,
        }),
    });
    const confirmar = await pedirFechamento();
    expect(screen.queryByTestId('pendencias-do-fechamento')).toBeNull();
    fireEvent.click(confirmar);
    expect(await screen.findByText(/Este turno tem 2 pendência/)).toBeTruthy();
    expect(await screen.findByTestId('pendencias-do-fechamento')).toBeTruthy();
    expect(chamou('/close')[0].body?.pendenciasCiente).toBeUndefined();
  });

  it('as gavetas abertas da operação: a recusa traz a lista, e o segundo pedido vai com a ciência', async () => {
    const GAVETA = {
      sessionId: 's-hoje',
      terminalId: 'cx2',
      terminalName: 'Caixa 2',
      terminalCode: 'loja-cx2',
      openedAt: new Date().toISOString(),
      openedBy: 'u2',
      openedByName: 'Beto',
      openingCents: 0,
      expectedCents: 0,
      deOutroDia: null,
    };
    let tentativas = 0;
    servidor((u, _m, body) => {
      if (u.includes('/core/cash/drawers')) return json({ items: tentativas >= 2 ? [] : [GAVETA], deOutroDia: 0 });
      if (u.includes('/close')) {
        tentativas += 1;
        if (!body?.pendenciasCiente) {
          return recusa(409, 'CORE_CASH_CLOSE_ELECTRONIC_PENDING', 'Este turno tem 2 pendência(s) eletrônica(s).', {
            pendencias: PENDENCIAS,
          });
        }
        return json({ id: 's-hoje', status: 'closed', expected_cents: 0, counted_cents: 0, difference_cents: 0 });
      }
      return undefined;
    });
    render(<GavetasAbertasCard />);
    fireEvent.change(await screen.findByLabelText(/Valor contado — Caixa 2/), { target: { value: '0,00' } });
    fireEvent.click(screen.getByRole('button', { name: /Fechar esta gaveta/ }));
    // MUDOU (H-caixa-seguranca-M02): "Fechar esta gaveta" só pergunta, com o
    // esperado relido; quem envia — e fica travado até a ciência — é
    // "Confirmar fechamento", que continua na tela depois da recusa.
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar fechamento' }));
    const bloco = await screen.findByTestId('pendencias-do-fechamento');
    const botao = screen.getByRole('button', { name: 'Confirmar fechamento' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(within(bloco).getByLabelText(/Estou ciente/));
    fireEvent.change(within(bloco).getByLabelText('Motivo para fechar com pendências'), {
      target: { value: 'Gerente confere amanhã' },
    });
    expect(botao.disabled).toBe(false);
    fireEvent.click(botao);
    expect(await screen.findByText(/Fechada com pendência eletrônica declarada/)).toBeTruthy();
    expect(chamou('/close')[1].body).toMatchObject({ pendenciasCiente: true, pendenciasMotivo: 'Gerente confere amanhã' });
  });
});

// ============================================================================
describe('GAP-PRD-080 — cancelar/devolver diz o que houve com o estorno', () => {
  it('estornado, enviado ao aparelho e pendente têm cada um a sua frase', () => {
    const frase = fraseDosEstornosNaMaquininha(
      [
        { transactionId: 'a', amountInCents: 5000, resultado: 'estornado', message: '' },
        { transactionId: 'b', amountInCents: 2000, resultado: 'enviado_ao_agente', message: '' },
        {
          transactionId: 'c',
          amountInCents: 1000,
          resultado: 'pendente',
          message: 'A operadora não confirmou o estorno. O estorno fica em Vendas › Conferência de maquininha › Estornos a fazer.',
        },
      ],
      formatCents,
    );
    expect(frase).toContain(`Estorno de ${formatCents(5000)} confirmado na maquininha.`);
    expect(frase).toContain(`Estorno de ${formatCents(2000)} enviado ao aparelho`);
    expect(frase).toMatch(/NÃO confirmado pela operadora: A operadora não confirmou o estorno\..*Estornos a fazer/);
    expect(fraseDosEstornosNaMaquininha([], formatCents)).toBe('');
  });
});
