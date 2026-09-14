/**
 * ============================================================================
 * O BOTÃO "COBRAR VIA ASAAS" EXISTE NA TELA — E FAZ O QUE PROMETE (GAP-V70)
 * ============================================================================
 *
 * ## Por que este teste é de TELA, e não só de rota
 *
 * O servidor já tinha tudo: credencial por operação, cliente no provedor,
 * webhook, idempotência, conferência de valor. E `createPaymentIntent` estava
 * escrito, íntegro, SEM UM ÚNICO CHAMADOR. Um gap de fio solto não aparece em
 * teste de serviço — o serviço passa verde exatamente como estava. Ele aparece
 * na tela, que é onde a pessoa procura o botão e não acha.
 *
 * É o mesmo formato de defeito que a casa já pagou caro: a tela de produto
 * mandava "lançar um movimento em Estoque › Movimentações" e a página era só
 * leitura. Aqui o caminho é conferido de ponta a ponta pelo navegador: o botão
 * aparece para quem o servidor deixa cobrar, o copia-e-cola volta para a tela,
 * a falha do provedor é DITA com as palavras do servidor, e a recusa por falta
 * de credencial não vira um "gerando..." que nunca termina.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContasPage from '../ContasPage';
import { setSession } from '@/lib/api/client';

const TITULO = {
  id: 'fin-1',
  direction: 'in',
  description: 'Aluguel da sala 2',
  amountCents: 30000,
  settledCents: 0,
  balanceCents: 30000,
  status: 'open',
  dueDate: '2026-09-10',
  settledAt: null,
  overdue: false,
  counterpartyName: 'Dona Marlene',
  originType: 'manual',
  originId: 'fin-1',
  originLabel: null,
  installmentNumber: 1,
  installmentTotal: 1,
  categoryId: null,
  categoryName: null,
  cancelledAt: null,
  createdAt: '2026-08-01T12:00:00.000Z',
};

const RESUMO = { openCents: 30000, overdueCents: 0, settledCents: 0, count: 1 };
const FAIXAS = {
  notDueCents: 30000,
  days1to30Cents: 0,
  days31to60Cents: 0,
  days61to90Cents: 0,
  over90Cents: 0,
};

interface Enviado {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let enviados: Enviado[];
/** O que o POST de cobrança responde neste cenário. */
let respostaDaCobranca: () => Response;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      enviados.push({
        url: alvo,
        method: metodo,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      });

      if (alvo.includes('/core/finance/entries/fin-1/charge') && metodo === 'POST') {
        return respostaDaCobranca();
      }
      if (alvo.includes('/core/finance/entries/fin-1/charges')) {
        return json({ items: [] });
      }
      if (alvo.includes('/core/finance/entries')) {
        return json({ items: [TITULO], summary: RESUMO, aging: FAIXAS });
      }
      if (alvo.includes('/core/finance/categories')) return json({ items: [] });
      if (alvo.includes('/core/payment-intents')) return json({ items: [] });
      if (alvo.includes('/core/finance/entries/fin-1/settlements')) return json({ items: [] });
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
    'teste da cobrança do título',
  );
}

function montar() {
  return render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-receber']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

/** Abre o detalhe do título — é lá que a cobrança mora. */
async function abrirDetalhe() {
  fireEvent.click((await screen.findAllByRole('button', { name: /Detalhes/i }))[0]);
  await screen.findByText('Cobrança online');
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
  respostaDaCobranca = () =>
    json(
      {
        intent: {
          id: 'int-1',
          company_id: 'loja',
          provider: 'asaas',
          environment: 'sandbox',
          origin_type: 'finance_entry',
          origin_id: 'fin-1',
          method: 'pix',
          amount_cents: 30000,
          status: 'pending',
          provider_ref: 'pay_1',
          qr_payload: null,
          invoice_url: 'https://sandbox.asaas.com/i/TESTE',
          last_error: null,
          created_at: '2026-08-30T12:00:00.000Z',
        },
        pixPayload: '00020126TESTE-COPIA-E-COLA',
        pixImageBase64: null,
        bankSlipUrl: null,
        identificationField: null,
        dueDate: '2026-09-10',
        invoiceUrl: 'https://sandbox.asaas.com/i/TESTE',
        status: 'pending',
        environment: 'sandbox',
        installments: [],
      },
      201,
    );
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da cobrança do título');
  localStorage.clear();
});

// ===========================================================================

describe('cobrar o título pela tela', () => {
  it('o gerente cobra e o copia-e-cola volta para a tela', async () => {
    entrarComo('gerente_loja');
    montar();
    await abrirDetalhe();

    fireEvent.click(screen.getByRole('button', { name: /Cobrar via Asaas/i }));

    await waitFor(() => {
      expect(
        enviados.some((e) => e.url.includes('/finance/entries/fin-1/charge') && e.method === 'POST'),
      ).toBe(true);
    });
    const pedido = enviados.find((e) => e.url.includes('/charge') && e.method === 'POST');
    expect(pedido?.body?.method).toBe('pix');
    // Sem parcelar, o campo NÃO viaja como 1: viaja como nulo, que é a
    // ausência que o servidor entende.
    expect(pedido?.body?.installmentCount).toBeNull();

    // O que o cliente precisa receber está na tela.
    expect(
      await screen.findByDisplayValue('00020126TESTE-COPIA-E-COLA'),
    ).toBeTruthy();
    expect(screen.getByText(/Abrir a fatura no provedor/i)).toBeTruthy();
    // E a tela não promete recebimento: mostrar o QR não é receber.
    expect(screen.getByText(/Mostrar a cobrança não é receber/i)).toBeTruthy();
  });

  it('parcelar manda o número de parcelas e a tela lista o carnê', async () => {
    entrarComo('gerente_loja');
    respostaDaCobranca = () =>
      json(
        {
          intent: {
            id: 'int-1',
            company_id: 'loja',
            provider: 'asaas',
            environment: 'sandbox',
            origin_type: 'finance_entry',
            origin_id: 'fin-1',
            method: 'boleto',
            amount_cents: 10000,
            status: 'pending',
            provider_ref: 'pay_1',
            qr_payload: null,
            invoice_url: 'https://sandbox.asaas.com/i/TESTE',
            last_error: null,
            created_at: '2026-08-30T12:00:00.000Z',
          },
          pixPayload: null,
          pixImageBase64: null,
          bankSlipUrl: null,
          identificationField: '34191.79001 01043.510047 91020.150008 1 96610000010000',
          dueDate: '2026-09-10',
          invoiceUrl: 'https://sandbox.asaas.com/i/TESTE',
          status: 'pending',
          environment: 'sandbox',
          installments: [
            { entryId: 'fin-1', number: 1, total: 3, amountCents: 3334, dueDate: '2026-09-10', intentId: 'i1', providerRef: 'p1', status: 'pending', invoiceUrl: null },
            { entryId: 'fin-2', number: 2, total: 3, amountCents: 3333, dueDate: '2026-10-10', intentId: 'i2', providerRef: 'p2', status: 'pending', invoiceUrl: null },
            { entryId: 'fin-3', number: 3, total: 3, amountCents: 3333, dueDate: '2026-11-10', intentId: 'i3', providerRef: 'p3', status: 'pending', invoiceUrl: null },
          ],
        },
        201,
      );
    montar();
    await abrirDetalhe();

    fireEvent.change(screen.getByLabelText(/Parcelar em/i), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Cobrar via Asaas/i }));

    await waitFor(() => {
      const pedido = enviados.find((e) => e.url.includes('/charge') && e.method === 'POST');
      expect(pedido?.body?.installmentCount).toBe(3);
    });
    // A régua de centavos aparece na tela: 33,34 + 33,33 + 33,33.
    expect(await screen.findByText(/3 parcelas geradas/i)).toBeTruthy();
    expect(screen.getByText(/33,34/)).toBeTruthy();
    // E a linha digitável do boleto, que é o que se manda para o cliente.
    expect(screen.getByText(/34191\.79001/)).toBeTruthy();
  });

  it('sem credencial, a tela REPETE a recusa do servidor em vez de fingir', async () => {
    entrarComo('gerente_loja');
    respostaDaCobranca = () =>
      json(
        {
          error: {
            code: 'CORE_ASAAS_UNCONFIGURED',
            message:
              'Integração Asaas não configurada nesta operação: sem chave, não há como gerar a '
              + 'cobrança. Configure em Integrações › Asaas.',
          },
        },
        409,
      );
    montar();
    await abrirDetalhe();

    fireEvent.click(screen.getByRole('button', { name: /Cobrar via Asaas/i }));

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent ?? '').toContain('Integração Asaas não configurada');
    // O caminho para resolver vem junto: mensagem sem saída é mensagem pela metade.
    expect(alerta.textContent ?? '').toContain('Integrações › Asaas');
  });

  it('estoquista NÃO vê o botão de cobrar, e a ausência se explica', async () => {
    entrarComo('estoquista');
    montar();
    await abrirDetalhe();

    // O servidor recusaria (403). Desenhar o botão faria a pessoa escolher o
    // meio, digitar as parcelas e levar a recusa no fim.
    expect(screen.queryByRole('button', { name: /Cobrar via Asaas/i })).toBeNull();
    expect(screen.getByText(/Gerar cobrança no provedor é da gerência e do caixa/i)).toBeTruthy();
  });
});

describe('o painel de status das cobranças (GAP-V75)', () => {
  it('mostra o erro e a tentativa, e oferece re-tentar só o que dá para re-tentar', async () => {
    entrarComo('gerente_loja');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const alvo = String(url);
        const metodo = init?.method ?? 'GET';
        enviados.push({ url: alvo, method: metodo, body: undefined });
        if (alvo.includes('/core/payment-intents/int-falha/retry')) {
          return json({ intent: { id: 'int-falha' }, status: 'pending' });
        }
        if (alvo.includes('/core/payment-intents')) {
          return json({
            items: [
              {
                id: 'int-falha',
                originType: 'finance_entry',
                originId: 'fin-1',
                originLabel: 'Aluguel da sala 2',
                method: 'pix',
                provider: 'asaas',
                environment: 'sandbox',
                amountCents: 30000,
                status: 'failed',
                providerRef: null,
                invoiceUrl: null,
                lastError: 'Erro Asaas 500',
                attempts: 1,
                createdAt: '2026-08-30T12:00:00.000Z',
                updatedAt: '2026-08-30T12:00:00.000Z',
                confirmedAt: null,
              },
              {
                id: 'int-viva',
                originType: 'ecommerce_order',
                originId: 'ped-9',
                originLabel: 'Pedido online #9',
                method: 'boleto',
                provider: 'asaas',
                environment: 'sandbox',
                amountCents: 12000,
                status: 'pending',
                providerRef: 'pay_9',
                invoiceUrl: 'https://sandbox.asaas.com/i/9',
                lastError: null,
                attempts: 1,
                createdAt: '2026-08-30T12:00:00.000Z',
                updatedAt: '2026-08-30T12:00:00.000Z',
                confirmedAt: null,
              },
            ],
          });
        }
        if (alvo.includes('/core/finance/entries')) {
          return json({ items: [TITULO], summary: RESUMO, aging: FAIXAS });
        }
        return json({ items: [] });
      }),
    );
    montar();

    // O erro do provedor aparece INTEIRO — é ele que diz qual ação resolve.
    expect(await screen.findByText('Erro Asaas 500')).toBeTruthy();
    expect(screen.getByText('FALHOU')).toBeTruthy();

    // Uma só oferece "tentar de novo": a que ainda não existe no provedor.
    // Re-tentar a que já tem cobrança cobraria o cliente duas vezes.
    const botoes = screen.getAllByRole('button', { name: /Tentar de novo/i });
    expect(botoes).toHaveLength(1);

    fireEvent.click(botoes[0]);
    await waitFor(() => {
      expect(enviados.some((e) => e.url.includes('/payment-intents/int-falha/retry'))).toBe(true);
    });
  });
});

// ===========================================================================

/** Uma linha do painel de cobranças, com o que a tela precisa ler. */
function cobranca(patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'int-1',
    originType: 'finance_entry',
    originId: 'fin-1',
    originLabel: 'Aluguel da sala 2',
    method: 'pix',
    provider: 'asaas',
    environment: 'sandbox',
    amountCents: 30000,
    status: 'pending',
    providerRef: 'pay_1',
    invoiceUrl: null,
    lastError: null,
    attempts: 1,
    createdAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T12:00:00.000Z',
    confirmedAt: null,
    ...patch,
  };
}

/** Serve o painel de cobranças com as linhas dadas. */
function servidorDoPainel(itens: Record<string, unknown>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      enviados.push({
        url: alvo,
        method: metodo,
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      });
      if (alvo.includes('/charges/cancel') && metodo === 'POST') {
        return json({ cancelled: 1, failed: 0 });
      }
      if (alvo.includes('/core/payment-intents')) return json({ items: itens });
      if (alvo.includes('/core/finance/entries')) {
        return json({ items: [TITULO], summary: RESUMO, aging: FAIXAS });
      }
      return json({ items: [] });
    }),
  );
}

describe('o filtro de situação conhece TODAS as situações que a tela rotula', () => {
  /**
   * O DEFEITO: o `<select>` oferecia SEIS situações e o mapa de rótulos
   * conhecia DEZ. `refunded`, `chargeback`, `cancelled` e `paid_after_cancel`
   * só apareciam em "Todas as situações" — e `paid_after_cancel` é justamente
   * o que alguém procura quando abre esta tela: dinheiro recebido depois do
   * cancelamento, pendente de regularização.
   *
   * Eram duas listas escritas à mão para a mesma coisa, e a segunda envelheceu
   * calada. Agora a lista do filtro SAI do mapa de rótulos: situação nova
   * ganha filtro no mesmo commit em que ganha rótulo, por construção.
   */
  it('oferece o filtro de cada situação conhecida, inclusive paga após cancelar', async () => {
    entrarComo('gerente_loja');
    servidorDoPainel([]);
    montar();

    const filtro = (await screen.findByLabelText(
      /Filtrar cobranças por situação/i,
    )) as HTMLSelectElement;
    const valores = [...filtro.options].map((o) => o.value);

    // As quatro que faltavam — e a que mais importa é a primeira.
    expect(valores).toContain('paid_after_cancel');
    expect(valores).toContain('refunded');
    expect(valores).toContain('chargeback');
    expect(valores).toContain('cancelled');
    // As seis que já existiam continuam lá.
    for (const antiga of [
      'pending',
      'confirmed',
      'overdue',
      'failed',
      'amount_mismatch',
      'unconfigured',
    ]) {
      expect(valores).toContain(antiga);
    }
    // Mais "Todas as situações", que é a ausência de filtro.
    expect(valores[0]).toBe('');
  });

  it('escolher "paga após cancelar" pergunta ao servidor por esse status', async () => {
    entrarComo('gerente_loja');
    servidorDoPainel([]);
    montar();

    const filtro = await screen.findByLabelText(/Filtrar cobranças por situação/i);
    fireEvent.change(filtro, { target: { value: 'paid_after_cancel' } });

    await waitFor(() => {
      expect(
        enviados.some((e) => e.url.includes('status=paid_after_cancel')),
      ).toBe(true);
    });
  });
});

describe('a cobrança do título se cancela pela tela', () => {
  /**
   * O DEFEITO: a própria tela declarava a ausência — "não há rota para isso no
   * título". Existia `cancelOrderCharges` para o pedido, com três chamadores, e
   * nada para o título: um PIX/boleto de título que perdeu a razão de ser
   * continuava vivo no provedor, e o cliente podia pagá-lo.
   */
  it('a cobrança VIVA de um título oferece cancelar, e o clique chama o servidor', async () => {
    entrarComo('gerente_loja');
    servidorDoPainel([cobranca()]);
    montar();

    const botao = await screen.findByRole('button', { name: /Cancelar cobrança/i });
    fireEvent.click(botao);

    await waitFor(() => {
      expect(
        enviados.some(
          (e) =>
            e.url.includes('/core/finance/entries/fin-1/charges/cancel') && e.method === 'POST',
        ),
      ).toBe(true);
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('cobrança JÁ PAGA não oferece cancelar — o caminho do dinheiro é o estorno', async () => {
    entrarComo('gerente_loja');
    servidorDoPainel([cobranca({ status: 'confirmed', confirmedAt: '2026-08-30T13:00:00.000Z' })]);
    montar();

    expect(await screen.findByText('PAGA')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancelar cobrança/i })).toBeNull();
  });

  it('cobrança de PEDIDO não oferece cancelar aqui — quem cancela pedido é o pedido', async () => {
    entrarComo('gerente_loja');
    servidorDoPainel([
      cobranca({ id: 'int-ped', originType: 'ecommerce_order', originId: 'ped-9' }),
    ]);
    montar();

    // Cancelar a cobrança sem cancelar o pedido deixaria o pedido esperando um
    // pagamento que não pode mais chegar. Botão que faz meio gesto é pior que
    // botão nenhum.
    expect(await screen.findByText('AGUARDANDO PAGAMENTO')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancelar cobrança/i })).toBeNull();
  });

  it('estoquista lê o painel e não cancela nada', async () => {
    entrarComo('estoquista');
    servidorDoPainel([cobranca()]);
    montar();

    expect(await screen.findByText('AGUARDANDO PAGAMENTO')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancelar cobrança/i })).toBeNull();
  });
});
