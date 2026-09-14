/**
 * ============================================================================
 * O PIX INTEGRADO NA MAQUININHA, PELA TELA (GAP-V49)
 * ============================================================================
 *
 * ## O defeito
 *
 * O fluxo assíncrono do PIX no aparelho — QR, estado pendente, consulta,
 * confirmação — estava PRONTO e testado no servidor havia rodadas (doze casos
 * verdes em `pdv-pix-maquininha.test.ts`). No `PagamentoDialog` a decisão de
 * rota era literal:
 *
 *     const isCard = method === 'debito' || method === 'credito';
 *
 * PIX nunca ia para o aparelho. No dia em que a maquininha real chegasse, o
 * PIX integrado simplesmente não funcionaria — e o operador não teria nem o
 * copia-e-cola para ler ao cliente, porque o tipo `TerminalPayment` do
 * cliente descartava `qrPayload`, que o servidor devolvia desde sempre.
 *
 * ## O que estes casos cobram
 *
 * 1. Com maquininha integrada, o PIX vai para o APARELHO (e sem ela, não vai —
 *    o PIX do provedor de cobrança continua sendo lançado como sempre).
 * 2. Pendente é PENDENTE: o copia-e-cola aparece, nenhuma linha entra na
 *    venda, e o Finalizar não acende.
 * 3. Confirmado, a linha entra — AMARRADA à transação (GAP-V48).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PagamentoDialog, type PaymentLine } from '../PagamentoDialog';

const MEIOS = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
  { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
];

const QR = '00020126MOCK-PIX-5000';

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** O que a tela pediu ao servidor, na ordem. */
let cobrancas: Record<string, unknown>[] = [];
let consultas: number;
let confirmacoes: number;
/** Estado que a consulta seguinte vai devolver. */
let pixLiquidado = false;

function servidor({ comMaquininha }: { comMaquininha: boolean }) {
  cobrancas = [];
  consultas = 0;
  confirmacoes = 0;
  pixLiquidado = false;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/pdv/terminal/status')) {
        return json({
          configured: comMaquininha,
          provider: comMaquininha ? 'mock' : null,
          readiness: 'READY_FOR_HARDWARE',
          message: comMaquininha ? 'Maquininha mock integrada.' : 'Sem maquininha integrada.',
        });
      }
      if (u.includes('/pdv/terminal/charge')) {
        const corpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        cobrancas.push(corpo);
        if (corpo.method === 'pix') {
          // O PIX nasce PENDENTE, com o copia-e-cola. É o que o servidor faz.
          return json({
            transactionId: 'pttx-pix-1',
            state: 'processando',
            message: 'QR na maquininha. Aguardando o cliente pagar.',
            settled: false,
            needsReconciliation: false,
            amountInCents: corpo.amountInCents,
            method: 'pix',
            simulated: true,
            qrPayload: QR,
          });
        }
        return json({
          transactionId: 'pttx-cartao-1',
          state: 'aprovado',
          message: 'Pagamento aprovado.',
          settled: true,
          needsReconciliation: false,
          amountInCents: corpo.amountInCents,
          method: String(corpo.method),
          simulated: true,
          maskedCard: '****1234',
        });
      }
      if (u.includes('/confirmar-teste')) {
        confirmacoes += 1;
        pixLiquidado = true;
        return json({
          transactionId: 'pttx-pix-1',
          state: 'aprovado',
          message: 'Pagamento aprovado.',
          settled: true,
          needsReconciliation: false,
          amountInCents: 5000,
          method: 'pix',
          simulated: true,
        });
      }
      if (u.includes('/pdv/terminal/pttx-pix-1')) {
        consultas += 1;
        return json({
          transactionId: 'pttx-pix-1',
          state: pixLiquidado ? 'aprovado' : 'processando',
          message: pixLiquidado ? 'Pagamento aprovado.' : 'Aguardando o cliente pagar.',
          settled: pixLiquidado,
          needsReconciliation: false,
          amountInCents: 5000,
          method: 'pix',
          simulated: true,
          qrPayload: pixLiquidado ? null : QR,
        });
      }
      return json({ items: [] });
    }),
  );
}

let confirmado: { payments: PaymentLine[] } | null;

function montar(totalCents = 5000) {
  render(
    <PagamentoDialog
      totalCents={totalCents}
      onConfirm={(payments) => {
        confirmado = { payments };
      }}
      onCancel={() => undefined}
    />,
  );
}

/** Escolhe o meio e manda cobrar o valor que falta. */
async function cobrar(meio: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(meio, 'i') }));
  fireEvent.click(screen.getByRole('button', { name: /Cobrar na maquininha|Lançar/ }));
}

beforeEach(() => {
  confirmado = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('com maquininha integrada, o PIX passa pelo aparelho', () => {
  beforeEach(() => servidor({ comMaquininha: true }));

  it('o botão do PIX manda cobrar na maquininha', async () => {
    montar();
    // Sem maquininha o rótulo era "Lançar" para o PIX, e a cobrança nunca saía.
    fireEvent.click(await screen.findByRole('button', { name: /PIX/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Cobrar na maquininha/ })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Cobrar na maquininha/ }));
    await waitFor(() => expect(cobrancas).toHaveLength(1));
    expect(cobrancas[0].method).toBe('pix');
    expect(cobrancas[0].amountInCents).toBe(5000);
  });

  it('pendente mostra o copia-e-cola e NÃO lança nada na venda', async () => {
    montar();
    await cobrar('PIX');

    const bloco = await screen.findByTestId('pdv-pix-na-maquininha');
    expect(bloco.textContent).toContain(QR);
    // Nenhuma linha de pagamento: dizer "recebido" antes da confirmação é
    // afirmar que entrou dinheiro que ninguém pagou.
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
  });

  it('com o QR na tela, o Finalizar continua apagado', async () => {
    montar();
    await cobrar('PIX');
    await screen.findByTestId('pdv-pix-na-maquininha');

    const finalizar = screen.getByRole('button', { name: /Finalizar/ }) as HTMLButtonElement;
    expect(finalizar.disabled).toBe(true);
  });

  it('confirmado, a linha entra AMARRADA à transação', async () => {
    montar();
    await cobrar('PIX');
    await screen.findByTestId('pdv-pix-na-maquininha');

    fireEvent.click(screen.getByRole('button', { name: /Confirmar \(provedor de teste\)/ }));

    await waitFor(() => expect(confirmacoes).toBe(1));
    await waitFor(() =>
      expect(screen.queryByTestId('pdv-pix-na-maquininha')).toBeNull(),
    );

    const finalizar = screen.getByRole('button', { name: /Finalizar/ }) as HTMLButtonElement;
    await waitFor(() => expect(finalizar.disabled).toBe(false));
    fireEvent.click(finalizar);

    expect(confirmado?.payments).toHaveLength(1);
    expect(confirmado?.payments[0].method).toBe('pix');
    expect(confirmado?.payments[0].amountCents).toBe(5000);
    // GAP-V48: é esta referência que o servidor confere para aceitar a linha.
    expect(confirmado?.payments[0].providerRef).toBe('pttx-pix-1');
  });

  it('"Já pagou? Consultar" pergunta ao servidor e fecha quando ele confirmar', async () => {
    montar();
    await cobrar('PIX');
    await screen.findByTestId('pdv-pix-na-maquininha');

    // Consultar não decide nada: enquanto o provedor não confirmar, continua
    // pendente por mais que se clique.
    fireEvent.click(screen.getByRole('button', { name: /Já pagou\? Consultar/ }));
    await waitFor(() => expect(consultas).toBeGreaterThan(0));
    expect(screen.getByTestId('pdv-pix-na-maquininha')).toBeTruthy();

    // Agora o cliente pagou de verdade.
    pixLiquidado = true;
    fireEvent.click(screen.getByRole('button', { name: /Já pagou\? Consultar/ }));
    await waitFor(() => expect(screen.queryByTestId('pdv-pix-na-maquininha')).toBeNull());
  });

  it('o cartão continua amarrando a transação que o aprovou', async () => {
    montar();
    await cobrar('Crédito');

    await waitFor(() => expect(cobrancas).toHaveLength(1));
    const finalizar = screen.getByRole('button', { name: /Finalizar/ }) as HTMLButtonElement;
    await waitFor(() => expect(finalizar.disabled).toBe(false));
    fireEvent.click(finalizar);

    expect(confirmado?.payments[0].providerRef).toBe('pttx-cartao-1');
  });
});

describe('sem maquininha integrada, nada muda para o PIX', () => {
  beforeEach(() => servidor({ comMaquininha: false }));

  it('o PIX do provedor de cobrança é lançado como sempre foi', async () => {
    /*
      PIX tem dois caminhos, e o de fora do aparelho — QR do provedor na tela
      do computador — é legítimo. Mandá-lo para uma maquininha que não existe
      pararia o balcão de cinco das seis operações.
    */
    montar();
    await cobrar('PIX');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Remover PIX/ })).toBeTruthy(),
    );
    expect(cobrancas).toHaveLength(0);
    expect(screen.queryByTestId('pdv-pix-na-maquininha')).toBeNull();
  });
});
