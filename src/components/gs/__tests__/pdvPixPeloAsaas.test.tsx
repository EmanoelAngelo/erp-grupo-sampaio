/**
 * ============================================================================
 * O QR DO PIX NA TELA DO CAIXA, PELO ASAAS (GAP-PRD-077)
 * ============================================================================
 *
 * O diálogo prometia "o QR na tela do computador" e, sem maquininha, o PIX era
 * `addPayment('pix', cents)`: uma linha liquidada sem cobrança nenhuma,
 * lançada depois de o operador conferir o app do banco.
 *
 * Estes casos olham o FIO: com o Asaas configurado, o botão gera o QR na rota
 * do balcão (com o CPF de quem paga), o copia-e-cola aparece, nenhuma linha
 * entra antes de o servidor dizer, e a linha que entra leva a cobrança —
 * liquidada (pago) ou pendente ("receber depois"). Desistir cancela o QR no
 * provedor. Sem Asaas, a tela diz que o PIX é conferido no banco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PagamentoDialog, type PaymentLine } from '../PagamentoDialog';

const MEIOS = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
];
const QR = '00020126-PIX-pay_TEST_1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let pedidos: { url: string; method: string; body: Record<string, unknown> | null }[];
let statusDoPix: string;

function pix(status = statusDoPix) {
  return {
    intentId: 'int-balcao-1',
    status,
    amountCents: 5000,
    environment: 'sandbox',
    providerRef: 'pay_TEST_1',
    pixPayload: QR,
    pixImageBase64: null,
    expiresAt: null,
    saleId: null,
    lastError: null,
  };
}

function servidor({ asaas }: { asaas: boolean }) {
  pedidos = [];
  statusDoPix = 'pending';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const metodo = init?.method ?? 'GET';
      pedidos.push({ url: u, method: metodo, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/pdv/terminal/status')) {
        return json({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      if (u.includes('/pdv/pix-asaas/status')) {
        return json(
          asaas
            ? { disponivel: true, ambiente: 'sandbox', motivo: 'Asaas em ambiente de TESTES: o QR não cobra ninguém de verdade.' }
            : { disponivel: false, ambiente: null, motivo: 'Configure em Integrações › Asaas para gerar o QR pelo sistema.' },
        );
      }
      if (u.endsWith('/pdv/pix-asaas') && metodo === 'POST') return json(pix(), 201);
      if (u.includes('/pdv/pix-asaas/int-balcao-1/cancel')) {
        statusDoPix = 'cancelled';
        return json(pix('cancelled'));
      }
      if (u.includes('/pdv/pix-asaas/int-balcao-1')) return json(pix());
      return json({ items: [] });
    }),
  );
}

let confirmado: PaymentLine[] | null;

function montar() {
  render(
    <PagamentoDialog
      totalCents={5000}
      onConfirm={(payments) => {
        confirmado = payments;
      }}
      onCancel={() => undefined}
    />,
  );
}

async function gerarQr() {
  fireEvent.click(await screen.findByRole('button', { name: /PIX/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Gerar QR do PIX' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('CPF de quem paga'), { target: { value: '529.982.247-25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Gerar QR do PIX' }));
  return screen.findByTestId('pdv-pix-asaas');
}

beforeEach(() => {
  confirmado = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GAP-PRD-077 — com o Asaas na operação, o QR nasce na tela', () => {
  beforeEach(() => servidor({ asaas: true }));

  it('o botão gera o QR na rota do balcão, com o valor que falta e o CPF de quem paga', async () => {
    montar();
    const painel = await gerarQr();

    const pedido = pedidos.find((p) => p.url.endsWith('/pdv/pix-asaas') && p.method === 'POST')!;
    expect(pedido.body).toMatchObject({ amountCents: 5000, pagadorDocumento: '52998224725' });
    expect(String(pedido.body?.referencia)).toMatch(/\w{8,}/);
    expect(painel.textContent).toContain(QR);
    expect(painel.textContent).toMatch(/AGUARDANDO PAGAMENTO/);
    // Nenhuma linha entrou, e o Finalizar não acende com o QR na tela.
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
    expect((screen.getByRole('button', { name: /Finalizar/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('o provedor confirma: a linha entra LIQUIDADA e amarrada à cobrança', async () => {
    montar();
    await gerarQr();
    statusDoPix = 'confirmed';

    fireEvent.click(screen.getByRole('button', { name: 'Já pagou? Consultar o provedor' }));

    await waitFor(() => expect(screen.getByText(/PIX \(QR do sistema\)/)).toBeTruthy());
    const consulta = pedidos.find((p) => p.url.includes('/pdv/pix-asaas/int-balcao-1?consultar=1'));
    expect(consulta).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar/ }));
    expect(confirmado).toEqual([{ method: 'pix', amountCents: 5000, paymentIntentId: 'int-balcao-1', status: 'settled' }]);
  });

  it('"Receber depois" fecha com o PIX PENDENTE — a venda sai, o dinheiro não é afirmado', async () => {
    montar();
    await gerarQr();

    fireEvent.click(screen.getByRole('button', { name: 'Receber depois (fica pendente)' }));

    expect(await screen.findByText(/pendente — liquida quando o provedor confirmar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar/ }));
    expect(confirmado).toEqual([{ method: 'pix', amountCents: 5000, paymentIntentId: 'int-balcao-1', status: 'pending' }]);
  });

  it('desistir cancela o QR no provedor e libera a tela', async () => {
    montar();
    await gerarQr();

    fireEvent.click(screen.getByRole('button', { name: 'Desistir e cancelar o QR' }));

    await waitFor(() => expect(screen.queryByTestId('pdv-pix-asaas')).toBeNull());
    expect(pedidos.some((p) => p.url.includes('/pdv/pix-asaas/int-balcao-1/cancel') && p.method === 'POST')).toBe(true);
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
  });

  it('o caminho antigo continua existindo, mas não é mais o único', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /PIX/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lançar sem QR (já conferido no banco)' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalizar/ }));
    expect(confirmado).toEqual([{ method: 'pix', amountCents: 5000, providerRef: undefined }]);
  });
});

describe('GAP-PRD-077 — sem Asaas, a tela não promete QR', () => {
  beforeEach(() => servidor({ asaas: false }));

  it('o PIX é lançado à mão, e a tela diz que é conferido no banco — e onde configurar', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /PIX/ }));

    expect(await screen.findByText(/PIX sem QR pelo sistema: confira o pagamento no app do banco/)).toBeTruthy();
    expect(screen.getByText(/Integrações › Asaas/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Gerar QR do PIX' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Lançar' })).toBeTruthy();
  });
});
