/**
 * Cancelar e desfazer etapa pedem MOTIVO antes de chamar o servidor
 * (GAP-PRD-124 e GAP-PRD-121) — pela pergunta da TELA, e não pelo diálogo do
 * navegador (GAP-PRD-158).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BotaoCancelarPedido, BotaoDesfazerEtapa } from '../AcoesDoPedido';

type Chamada = { url: string; method: string; body: unknown };

function servidor(resposta: () => Response) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      chamadas.push({
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return resposta();
    }),
  );
  return chamadas;
}

const ok = () =>
  new Response(JSON.stringify({ id: 'o1', number: 7, status: 'cancelado' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Responde a pergunta do motivo: escreve e confirma — ou desiste, com `null`. */
async function responder(titulo: string | RegExp, texto: string | null, confirmar: string) {
  const dialogo = await screen.findByRole('dialog', { name: titulo });
  if (texto === null) {
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
  } else {
    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: texto } });
    fireEvent.click(within(dialogo).getByRole('button', { name: confirmar }));
  }
  return dialogo;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cancelar pedido pelo ERP', () => {
  it('pede o motivo na tela e manda para o servidor; concluído, avisa quem chamou', async () => {
    const chamadas = servidor(ok);
    const aoConcluir = vi.fn();
    const aoFalhar = vi.fn();
    render(<BotaoCancelarPedido pedido={{ id: 'o1', number: 7 }} aoConcluir={aoConcluir} aoFalhar={aoFalhar} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await responder('Cancelar o pedido #7', '  Produto acabou no balcão  ', 'Cancelar o pedido');

    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toContain('/core/orders/o1/cancel');
    expect(chamadas[0].method).toBe('POST');
    expect(chamadas[0].body).toEqual({ reason: 'Produto acabou no balcão' });
    expect(aoFalhar).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('desistir no diálogo não manda nada ao servidor', async () => {
    const chamadas = servidor(ok);
    render(<BotaoCancelarPedido pedido={{ id: 'o1', number: 7 }} aoConcluir={vi.fn()} aoFalhar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await responder('Cancelar o pedido #7', null, '');
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('motivo em branco não chama o servidor e diz o que falta', async () => {
    const chamadas = servidor(ok);
    render(<BotaoCancelarPedido pedido={{ id: 'o1', number: 7 }} aoConcluir={vi.fn()} aoFalhar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    const dialogo = await responder('Cancelar o pedido #7', '   ', 'Cancelar o pedido');
    // O diálogo fica aberto e diz o que falta — o servidor recusaria.
    expect(within(dialogo).getByRole('alert').textContent).toBe('Escreva o motivo.');
    expect(screen.getByRole('dialog', { name: 'Cancelar o pedido #7' })).toBeTruthy();
    expect(chamadas).toHaveLength(0);
  });

  it('a recusa do servidor chega com as palavras dele', async () => {
    servidor(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'CORE_ORDER_ALREADY_PAID', message: 'Pedido já pago: use devolução em vez de cancelamento.' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const aoFalhar = vi.fn();
    render(<BotaoCancelarPedido pedido={{ id: 'o1', number: 7 }} aoConcluir={vi.fn()} aoFalhar={aoFalhar} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await responder('Cancelar o pedido #7', 'cliente desistiu', 'Cancelar o pedido');
    await vi.waitFor(() =>
      expect(aoFalhar).toHaveBeenCalledWith('Pedido já pago: use devolução em vez de cancelamento.'),
    );
  });
});

describe('desfazer etapa', () => {
  it('diz de onde para onde, pede motivo e chama /fulfillment/voltar', async () => {
    const chamadas = servidor(ok);
    const aoConcluir = vi.fn();
    render(
      <BotaoDesfazerEtapa
        pedido={{ id: 'o2', number: 8 }}
        rotuloAtual="Entregue"
        rotuloAnterior="Pronto para retirada"
        aoConcluir={aoConcluir}
        aoFalhar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Desfazer etapa \(voltar para Pronto para retirada\)/ }));
    // O título do diálogo diz de onde para onde.
    await responder(
      'Voltar o pedido #8 de "Entregue" para "Pronto para retirada"',
      'Marcado entregue antes da hora',
      'Voltar a etapa',
    );
    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(chamadas[0].url).toContain('/core/orders/o2/fulfillment/voltar');
    expect(chamadas[0].body).toEqual({ reason: 'Marcado entregue antes da hora' });
  });

  it('motivo curto não chama o servidor', async () => {
    const chamadas = servidor(ok);
    render(
      <BotaoDesfazerEtapa
        pedido={{ id: 'o2', number: 8 }}
        rotuloAtual="Separação"
        rotuloAnterior="Pago"
        aoConcluir={vi.fn()}
        aoFalhar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Desfazer etapa/ }));
    const dialogo = await responder(/Voltar o pedido #8/, 'ok', 'Voltar a etapa');
    expect(within(dialogo).getByRole('alert').textContent).toBe('Escreva o motivo com pelo menos 5 caracteres.');
    expect(chamadas).toHaveLength(0);
  });
});
