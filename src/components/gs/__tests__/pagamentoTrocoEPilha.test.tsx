/**
 * ============================================================================
 * O TROCO COM PIX PENDENTE, E O ESC DE QUEM ESTÁ POR CIMA
 * ============================================================================
 *
 * E-venda-servidor-07 — o troco da tela divergia do troco gravado. O diálogo
 * somava o PIX "receber depois" (pendente) no recebido e mandava dar troco; o
 * servidor tira o troco SÓ do liquidado, gravava zero e punha a nota inteira na
 * gaveta. O caixa entregava o troco, e o fechamento acusava a falta. Agora a
 * tela tem a regra do servidor, e receber a mais com PIX pendente não fecha.
 *
 * Como fica vermelho: volte `change` a `paid − aCobrar` (e tire
 * `trocoContraPendente` do `canConfirm`) e o Finalizar acende com "Troco
 * R$ 10,00" numa venda em que o servidor grava troco zero.
 *
 * PED-pdv-05 — o Esc do diálogo de pagamento vazava: com outra tela por cima
 * dele, o Esc dado para fechar a de cima fechava também o pagamento, e seguia
 * para os outros ouvintes da janela. Como fica vermelho: tire `estaNoTopo` do
 * ouvinte do Esc e o primeiro caso vê o pagamento fechar por baixo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PagamentoDialog, type PaymentLine } from '../PagamentoDialog';
import { prenderFoco } from '../armadilhaDeFoco';

const MEIOS = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let valorDoPix = 0;

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const metodo = init?.method ?? 'GET';
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/pdv/terminal/status')) {
        return json({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      if (u.includes('/pdv/pix-asaas/status')) {
        return json({ disponivel: true, ambiente: 'sandbox', motivo: 'Asaas em testes.' });
      }
      const pix = () => ({
        intentId: 'int-1',
        status: 'pending',
        amountCents: valorDoPix,
        environment: 'sandbox',
        providerRef: 'pay_1',
        pixPayload: '000201-PIX',
        pixImageBase64: null,
        expiresAt: null,
        saleId: null,
        lastError: null,
      });
      if (u.endsWith('/pdv/pix-asaas') && metodo === 'POST') {
        valorDoPix = Number(JSON.parse(String(init?.body ?? '{}')).amountCents ?? 0);
        return json(pix(), 201);
      }
      if (u.includes('/pdv/pix-asaas/int-1')) return json(pix());
      return json({ items: [] });
    }),
  );
}

let confirmado: { payments: PaymentLine[]; troco: number } | null;
let cancelado: number;

function montar(totalCents: number) {
  return render(
    <PagamentoDialog
      totalCents={totalCents}
      onConfirm={(payments, troco) => {
        confirmado = { payments, troco };
      }}
      onCancel={() => {
        cancelado += 1;
      }}
    />,
  );
}

const finalizar = () => screen.getByRole('button', { name: /^Finalizar/i }) as HTMLButtonElement;

beforeEach(() => {
  confirmado = null;
  cancelado = 0;
  valorDoPix = 0;
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('E-venda-servidor-07 — PIX "receber depois" não banca troco', () => {
  it('PIX pendente pelo total e mais R$ 10,00 em dinheiro: sem troco na tela, e a venda NÃO fecha', async () => {
    montar(10000);
    fireEvent.click(await screen.findByRole('button', { name: /PIX/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gerar QR do PIX' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('CPF de quem paga'), { target: { value: '529.982.247-25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar QR do PIX' }));
    await screen.findByTestId('pdv-pix-asaas');
    fireEvent.click(screen.getByRole('button', { name: 'Receber depois (fica pendente)' }));
    expect(await screen.findByText(/pendente — liquida quando o provedor confirmar/)).toBeTruthy();

    // O cliente ainda entrega uma nota de R$ 10,00.
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    fireEvent.change(screen.getByLabelText(/Valor recebido em/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /^Lançar$/i }));

    const aviso = await screen.findByTestId('pagamento-troco-com-pix-pendente');
    expect(aviso.textContent).toMatch(/Troco não sai contra PIX pendente/);
    expect(aviso.textContent).toContain('100,00');
    // O troco da tela é o do servidor: zero — e não os R$ 10,00 da nota.
    const troco = screen.getByText('Troco').parentElement!;
    expect(troco.textContent).toMatch(/R\$\s*0,00/);
    expect(finalizar().disabled).toBe(true);
    fireEvent.click(finalizar());
    expect(confirmado).toBeNull();

    // O F10 também não fecha — e diz por quê.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });
    expect(confirmado).toBeNull();
    expect(await screen.findByText(/ajuste o dinheiro lançado/)).toBeTruthy();
  });

  it('PIX pendente pelo total, sem sobra: fecha normalmente, com troco zero', async () => {
    montar(10000);
    fireEvent.click(await screen.findByRole('button', { name: /PIX/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gerar QR do PIX' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('CPF de quem paga'), { target: { value: '529.982.247-25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar QR do PIX' }));
    await screen.findByTestId('pdv-pix-asaas');
    fireEvent.click(screen.getByRole('button', { name: 'Receber depois (fica pendente)' }));
    await screen.findByText(/pendente — liquida quando o provedor confirmar/);

    expect(screen.queryByTestId('pagamento-troco-com-pix-pendente')).toBeNull();
    fireEvent.click(finalizar());
    expect(confirmado?.troco).toBe(0);
    expect(confirmado?.payments[0]).toMatchObject({ method: 'pix', status: 'pending', amountCents: 10000 });
  });

  it('dinheiro a mais SEM pendência continua dando troco (nada muda na venda comum)', async () => {
    montar(8000);
    await screen.findByRole('button', { name: /Dinheiro/ });
    fireEvent.change(screen.getByLabelText(/Valor recebido em/i), { target: { value: '100,00' } });
    fireEvent.click(screen.getByRole('button', { name: /^Lançar$/i }));
    await waitFor(() => expect(finalizar().disabled).toBe(false));
    fireEvent.click(finalizar());
    expect(confirmado?.troco).toBe(2000);
  });
});

/** Uma tela qualquer por cima do pagamento — a autorização do gestor, uma pergunta. */
function TelaPorCima() {
  return (
    <div role="dialog" aria-modal="true" aria-label="Tela por cima" ref={prenderFoco} tabIndex={-1}>
      <button type="button">ok</button>
    </div>
  );
}

describe('PED-pdv-05 — o Esc é de quem está por cima', () => {
  it('com outra tela por cima, o Esc NÃO fecha o pagamento nem vaza para os outros ouvintes', async () => {
    const { rerender } = montar(5000);
    await screen.findByRole('button', { name: /Dinheiro/ });
    rerender(
      <>
        <PagamentoDialog totalCents={5000} onConfirm={() => undefined} onCancel={() => { cancelado += 1; }} />
        <TelaPorCima />
      </>,
    );
    await screen.findByRole('dialog', { name: 'Tela por cima' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(cancelado).toBe(0);
  });

  it('no topo, o Esc fecha o pagamento e para ali — o ouvinte ao lado não o recebe', async () => {
    montar(5000);
    await screen.findByRole('button', { name: /Dinheiro/ });
    const vizinho = vi.fn();
    window.addEventListener('keydown', vizinho, true);
    try {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(cancelado).toBe(1);
      expect(vizinho.mock.calls.some(([e]) => (e as KeyboardEvent).key === 'Escape')).toBe(false);
    } finally {
      window.removeEventListener('keydown', vizinho, true);
    }
  });
});
