/**
 * ============================================================================
 * O CARTÃO NO PINPAD DO CAIXA, PELA TELA (GAP-PRD-014)
 * ============================================================================
 *
 * Pelo agente local a cobrança não volta aprovada na hora: ela sai
 * "aguardando a maquininha", passa por "aguardando o cliente" e só então é
 * aprovada ou recusada. O `PagamentoDialog` tratava toda resposta não
 * liquidada de cartão como fim de conversa — a venda ficaria sem o cartão que
 * o cliente acabou de passar.
 *
 * Os casos cobram:
 *
 * 1. A cobrança leva o CAIXA deste computador (a maquininha é por caixa) e a
 *    consulta de status também.
 * 2. Em andamento, a tela consulta sozinha, não lança nada e não deixa
 *    finalizar; aprovado, a linha entra amarrada à cobrança.
 * 3. Recusado encerra a espera sem lançar nada.
 * 4. Agente fora do ar é avisado ANTES de cobrar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PagamentoDialog, type PaymentLine } from '../PagamentoDialog';

const MEIOS = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
  { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let urls: string[];
let cobrancas: Record<string, unknown>[];
/** O que as consultas seguintes devolvem, na ordem (a última se repete). */
let respostas: Array<Record<string, unknown>>;
let agenteOnline: boolean;

function transacao(state: string, extra: Record<string, unknown> = {}) {
  const liquidada = state === 'aprovado';
  return {
    transactionId: 'pttx-agente-1',
    state,
    message: state,
    settled: liquidada,
    needsReconciliation: false,
    amountInCents: 5000,
    method: 'credit',
    simulated: false,
    pending: ['aguardando_terminal', 'aguardando_cliente', 'processando'].includes(state),
    channel: 'local_agent',
    ...extra,
  };
}

function servidor() {
  urls = [];
  cobrancas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/pdv/terminal/status')) {
        return json({
          configured: true,
          provider: 'stone',
          readiness: 'READY_FOR_HARDWARE',
          simulated: false,
          channel: 'local_agent',
          channelReady: agenteOnline,
          message: agenteOnline
            ? 'Maquininha PinPad do Caixa 1 integrada pelo agente local.'
            : 'O agente local da maquininha PinPad do Caixa 1 está fora do ar. Ligue o computador do caixa/agente antes de cobrar.',
        });
      }
      if (u.includes('/pdv/terminal/charge')) {
        cobrancas.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return json(transacao('aguardando_terminal', { message: 'Enviando para a maquininha…' }));
      }
      if (u.includes('/pdv/terminal/pttx-agente-1')) {
        const proxima = respostas.length > 1 ? respostas.shift()! : respostas[0];
        return json(proxima);
      }
      return json({ items: [] });
    }),
  );
}

let confirmado: { payments: PaymentLine[] } | null;

function montar() {
  render(
    <PagamentoDialog
      totalCents={5000}
      terminalId="cx-1"
      onConfirm={(payments) => {
        confirmado = { payments };
      }}
      onCancel={() => undefined}
    />,
  );
}

async function cobrarNoCredito() {
  fireEvent.click(await screen.findByRole('button', { name: /Crédito/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Cobrar na maquininha/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Cobrar na maquininha/ }));
}

beforeEach(() => {
  confirmado = null;
  agenteOnline = true;
  respostas = [transacao('aguardando_cliente'), transacao('aprovado', { authorizationCode: 'A1B2C3' })];
  servidor();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GAP-PRD-014 — o cartão pelo agente local', () => {
  it('a consulta de status e a cobrança levam o caixa deste computador', async () => {
    montar();
    await waitFor(() => expect(urls.some((u) => u.includes('/pdv/terminal/status?terminalId=cx-1'))).toBe(true));
    await cobrarNoCredito();
    await waitFor(() => expect(cobrancas).toHaveLength(1));
    expect(cobrancas[0]).toMatchObject({ method: 'credito', amountInCents: 5000, terminalId: 'cx-1' });
  });

  it('em andamento a tela espera sem lançar nada; aprovado, a linha entra amarrada à cobrança', async () => {
    montar();
    await cobrarNoCredito();
    expect(await screen.findByRole('status', { name: 'Cobrança no aparelho' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Finalizar/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();

    // Duas consultas (a cada 2 s): "aguardando o cliente", depois "aprovado".
    await waitFor(() => expect(screen.getByRole('button', { name: /^Remover/ })).toBeTruthy(), { timeout: 7000 });
    expect(screen.queryByRole('status', { name: 'Cobrança no aparelho' })).toBeNull();
    // Uma cobrança só: a espera nunca vira segunda cobrança.
    expect(cobrancas).toHaveLength(1);

    const finalizar = screen.getByRole('button', { name: /Finalizar/ }) as HTMLButtonElement;
    await waitFor(() => expect(finalizar.disabled).toBe(false));
    fireEvent.click(finalizar);
    expect(confirmado?.payments).toEqual([
      expect.objectContaining({ method: 'credito', amountCents: 5000, providerRef: 'pttx-agente-1' }),
    ]);
  }, 15_000);

  it('recusado no aparelho encerra a espera e não lança nada', async () => {
    respostas = [transacao('recusado', { message: 'Pagamento recusado pela operadora. SALDO INSUFICIENTE' })];
    montar();
    await cobrarNoCredito();
    // Primeiro a espera aparece (a cobrança foi para o aparelho)…
    expect(await screen.findByRole('status', { name: 'Cobrança no aparelho' })).toBeTruthy();
    // …e a primeira consulta (2 s) traz a recusa, que encerra a espera.
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Cobrança no aparelho' })).toBeNull(), {
      timeout: 5000,
    });
    expect(await screen.findByText(/SALDO INSUFICIENTE/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
  }, 10_000);

  it('agente fora do ar é avisado antes de cobrar', async () => {
    agenteOnline = false;
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Crédito/ }));
    const aviso = await screen.findByRole('alert', { name: 'Maquininha sem resposta' });
    expect(aviso.textContent).toMatch(/fora do ar/);
  });
});
