/**
 * O CAMPO DE VALOR TEM TETO, E O F10 FECHA O QUE A AJUDA PROMETE.
 *
 * D-pdv-teclado-M03 — o foco do diálogo mora no campo de valor e o Enter do
 * leitor submete o formulário: o cliente entregava mais um item com o
 * pagamento aberto, o caixa bipava, e entrava R$ 7.891.234.567.895,00 em
 * dinheiro (com troco do mesmo tamanho), ou essa cobrança ia para o PinPad.
 *
 * D-pdv-teclado-17 — "F10 abre o pagamento e o finaliza quando fecha". Com o
 * diálogo recém-aberto, o segundo F10 não fazia nada, e não dizia nada.
 *
 * Como fica vermelho: tire `conferirValor` de `submitAmount` e o bipe vira
 * lançamento (e cobrança na maquininha); tire o ramo `lancaSozinho` do F10 e o
 * diálogo recém-aberto volta a ignorar a tecla.
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

let comMaquininha: boolean;
let posts: string[];
let confirmado: { payments: PaymentLine[]; change: number } | null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const u = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        // Qualquer POST aqui seria uma COBRANÇA saindo para a maquininha.
        posts.push(u);
        return json({ transactionId: 't-1', state: 'aprovado', settled: true, needsReconciliation: false });
      }
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/terminal')) {
        return comMaquininha
          ? json({ configured: true, provider: 'mock', message: 'Maquininha integrada.', channelReady: true })
          : json({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      return json({ items: [] });
    }),
  );
}

function montar(totalCents = 5270) {
  render(
    <PagamentoDialog
      totalCents={totalCents}
      onConfirm={(payments, change) => {
        confirmado = { payments, change };
      }}
      onCancel={() => undefined}
    />,
  );
}

const campoValor = () => screen.getByLabelText(/Valor recebido em/i) as HTMLInputElement;
const aviso = () => screen.queryByTestId('pagamento-aviso');

function f10() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });
}

beforeEach(() => {
  comMaquininha = false;
  posts = [];
  confirmado = null;
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('um código de barras no campo de valor não vira dinheiro', () => {
  it('em dinheiro: nada é lançado, a tela diz o que houve, e o F10 não fecha a venda', async () => {
    montar();
    await screen.findByRole('button', { name: /^PIX/ });
    fireEvent.change(campoValor(), { target: { value: '7891234567895' } });
    fireEvent.submit(campoValor().closest('form')!);

    expect((await screen.findByTestId('pagamento-aviso')).textContent).toMatch(/código de barras/);
    f10();
    expect(confirmado).toBeNull();
  });

  it('em débito com maquininha integrada: a cobrança NÃO vai para o PinPad', async () => {
    comMaquininha = true;
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /^Débito/ }));
    await screen.findByRole('button', { name: /Cobrar na maquininha/ });
    fireEvent.change(campoValor(), { target: { value: '7891234567895' } });
    fireEvent.click(screen.getByRole('button', { name: /Cobrar na maquininha/ }));

    await screen.findByTestId('pagamento-aviso');
    expect(posts).toHaveLength(0);
  });

  it('cartão acima do que falta é recusado — troco só sai de dinheiro', async () => {
    montar(5270);
    fireEvent.click(await screen.findByRole('button', { name: /^Débito/ }));
    fireEvent.change(campoValor(), { target: { value: '100,00' } });
    fireEvent.submit(campoValor().closest('form')!);
    expect((await screen.findByTestId('pagamento-aviso')).textContent).toMatch(/não pode passar do que falta receber/);
  });

  it('dinheiro MUITO acima do que falta é recusado; a nota de R$ 100 continua valendo', async () => {
    montar(5270);
    await screen.findByRole('button', { name: /^PIX/ });
    fireEvent.change(campoValor(), { target: { value: '5000,00' } });
    fireEvent.submit(campoValor().closest('form')!);
    expect((await screen.findByTestId('pagamento-aviso')).textContent).toMatch(/muito acima/);

    fireEvent.change(campoValor(), { target: { value: '100,00' } });
    fireEvent.submit(campoValor().closest('form')!);
    await waitFor(() => expect(aviso()).toBeNull());
    f10();
    await waitFor(() => expect(confirmado?.change).toBe(4730));
  });
});

describe('F10 no diálogo recém-aberto', () => {
  it('em Dinheiro, sem nada lançado: lança o que falta e fecha a venda', async () => {
    montar(5270);
    await screen.findByRole('button', { name: /^PIX/ });
    f10();
    expect(confirmado?.payments).toEqual([{ method: 'dinheiro', amountCents: 5270 }]);
    expect(confirmado?.change).toBe(0);
  });

  it('com valor digitado e não lançado: avisa, e não fecha', async () => {
    montar(5270);
    await screen.findByRole('button', { name: /^PIX/ });
    fireEvent.change(campoValor(), { target: { value: '10,00' } });
    f10();
    expect(confirmado).toBeNull();
    expect((await screen.findByTestId('pagamento-aviso')).textContent).toMatch(/Lance o valor com Enter/);
  });

  it('em débito com maquininha: não cobra sozinho — avisa o que falta', async () => {
    comMaquininha = true;
    montar(5270);
    fireEvent.click(await screen.findByRole('button', { name: /^Débito/ }));
    await screen.findByRole('button', { name: /Cobrar na maquininha/ });
    f10();
    expect(confirmado).toBeNull();
    expect(posts).toHaveLength(0);
    expect((await screen.findByTestId('pagamento-aviso')).textContent).toMatch(/Ainda falta receber/);
  });
});
