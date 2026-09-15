/**
 * Devolver e receber a mercadoria — a tela conta o que o servidor fez
 * (GAP-PRD-122, GAP-PRD-031).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BotaoDevolverPedido } from '../AcoesDoPedido';
import { resumoDaDevolucao } from '@/lib/api/pedidos';
import { RecebimentoDaDevolucao } from '../RecebimentoDaDevolucao';

type Chamada = { url: string; body: Record<string, unknown> | null };

function servidor(resposta: Record<string, unknown>, status = 200) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { body?: string }) => {
      chamadas.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify(resposta), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const RESULTADO = {
  status: 'reembolsado',
  providerRefund: 'not_applicable',
  dinheiro: 'a_devolver',
  mercadoria: 'recebida',
  pendenciaFiscal: null,
};

describe('o resumo da devolução diz para onde foi o dinheiro e a mercadoria', () => {
  it('a pagar em Contas e de volta ao estoque', () => {
    const t = resumoDaDevolucao(12, RESULTADO as never);
    expect(t).toContain('Pedido #12 devolvido.');
    expect(t).toContain('Contas a pagar');
    expect(t).toContain('voltou ao estoque');
  });

  it('estorno pelo provedor, mercadoria a conferir e pendência fiscal', () => {
    const t = resumoDaDevolucao(13, {
      ...RESULTADO,
      providerRefund: 'done',
      dinheiro: 'devolvido_pelo_provedor',
      mercadoria: 'aguardando',
      pendenciaFiscal: 'A NF-e nº 9 deste pedido está autorizada.',
    } as never);
    expect(t).toContain('quitada no financeiro');
    expect(t).toContain('Confirmar recebimento');
    expect(t).toContain('NF-e nº 9');
  });

  it('estorno que falhou é dito com todas as letras', () => {
    expect(resumoDaDevolucao(1, { ...RESULTADO, providerRefund: 'failed' } as never)).toContain('FALHOU');
  });
});

const MERCADORIA = 'A mercadoria já voltou para a loja e foi conferida?';

/** Responde a pergunta do motivo da devolução (opcional) — ou desiste, com `null`. */
async function responderMotivo(titulo: RegExp, texto: string | null) {
  const dialogo = await screen.findByRole('dialog', { name: titulo });
  if (texto === null) {
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    return;
  }
  fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: texto } });
  fireEvent.click(within(dialogo).getByRole('button', { name: 'Devolver o dinheiro' }));
}

describe('Devolver', () => {
  it('pedido que nunca saiu da loja não pergunta pela mercadoria — o servidor decide', async () => {
    const chamadas = servidor(RESULTADO);
    const aoConcluir = vi.fn();
    render(
      <BotaoDevolverPedido
        pedido={{ id: 'p1', number: 5, status: 'separacao', total_cents: 10000 }}
        aoConcluir={aoConcluir}
        aoFalhar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    await responderMotivo(/Devolver o pedido #5/, 'cliente desistiu');
    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: MERCADORIA })).toBeNull();
    expect(chamadas[0].url).toContain('/core/orders/p1/devolver');
    expect(chamadas[0].body).toEqual({ reason: 'cliente desistiu' });
    expect(String(aoConcluir.mock.calls[0][0])).toContain('voltou ao estoque');
  });

  it('pedido expedido pergunta se a mercadoria voltou; "não" deixa o estoque esperando', async () => {
    const chamadas = servidor({ ...RESULTADO, mercadoria: 'aguardando' });
    const aoConcluir = vi.fn();
    render(
      <BotaoDevolverPedido
        pedido={{ id: 'p2', number: 6, status: 'expedido', total_cents: 10000 }}
        aoConcluir={aoConcluir}
        aoFalhar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    await responderMotivo(/Devolver o pedido #6/, 'desistiu com o pacote a caminho');
    const pergunta = await screen.findByRole('dialog', { name: MERCADORIA });
    // O foco começa em "Ainda não voltou": Enter por reflexo não põe no estoque o que não chegou.
    // O foco entra no diálogo num efeito, depois do render que o desenha: lido
    // logo depois do `findByRole`, ele ainda podia estar no corpo da página.
    const naoVoltou = within(pergunta).getByRole('button', { name: 'Ainda não voltou' });
    await waitFor(() => expect(document.activeElement).toBe(naoVoltou));
    fireEvent.click(within(pergunta).getByRole('button', { name: 'Ainda não voltou' }));
    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(chamadas[0].body).toEqual({ reason: 'desistiu com o pacote a caminho', mercadoriaNaMao: false });
    expect(String(aoConcluir.mock.calls[0][0])).toContain('Confirmar recebimento');
  });

  it('"voltou e foi conferida" devolve a mercadoria ao estoque no ato', async () => {
    const chamadas = servidor(RESULTADO);
    render(
      <BotaoDevolverPedido
        pedido={{ id: 'p4', number: 9, status: 'entregue', total_cents: 10000 }}
        aoConcluir={vi.fn()}
        aoFalhar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    await responderMotivo(/Devolver o pedido #9/, 'veio com defeito');
    const pergunta = await screen.findByRole('dialog', { name: MERCADORIA });
    fireEvent.click(within(pergunta).getByRole('button', { name: 'Voltou e foi conferida' }));
    await vi.waitFor(() => expect(chamadas).toHaveLength(1));
    expect(chamadas[0].body).toEqual({ reason: 'veio com defeito', mercadoriaNaMao: true });
  });

  it('desistir no diálogo do motivo não devolve nada', async () => {
    const chamadas = servidor(RESULTADO);
    render(
      <BotaoDevolverPedido
        pedido={{ id: 'p3', number: 7, status: 'pago', total_cents: 10000 }}
        aoConcluir={vi.fn()}
        aoFalhar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    await responderMotivo(/Devolver o pedido #7/, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas).toHaveLength(0);
  });
});

describe('Confirmar recebimento', () => {
  const ITENS = [
    { product_id: 'a', description: 'Camiseta', quantity: 2 },
    { product_id: 'b', description: 'Boné', quantity: 1 },
  ];

  it('manda quanto de cada item voltou vendável, e diz o que não voltou', async () => {
    const chamadas = servidor({
      orderId: 'o9',
      itens: [],
      unidadesDeVolta: 2,
      unidadesQueNaoVoltaram: 1,
    });
    const aoConcluir = vi.fn();
    render(<RecebimentoDaDevolucao orderId="o9" itens={ITENS} aoConcluir={aoConcluir} aoFalhar={vi.fn()} />);

    const camiseta = screen.getByLabelText('Camiseta — volta ao estoque (de 2)') as HTMLInputElement;
    expect(camiseta.value).toBe('2');
    fireEvent.change(camiseta, { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Observação (opcional)'), { target: { value: 'uma rasgada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar recebimento' }));

    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(chamadas[0].url).toContain('/core/orders/o9/devolucao/receber');
    expect(chamadas[0].body).toEqual({
      itens: [
        { productId: 'a', quantidade: 1 },
        { productId: 'b', quantidade: 1 },
      ],
      nota: 'uma rasgada',
    });
    expect(String(aoConcluir.mock.calls[0][0])).toContain('1 não voltaram');
  });

  it('quantidade acima da comprada não vai ao servidor', async () => {
    const chamadas = servidor({});
    const aoFalhar = vi.fn();
    render(<RecebimentoDaDevolucao orderId="o9" itens={ITENS} aoConcluir={vi.fn()} aoFalhar={aoFalhar} />);
    fireEvent.change(screen.getByLabelText('Boné — volta ao estoque (de 1)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar recebimento' }));
    await vi.waitFor(() => expect(aoFalhar).toHaveBeenCalled());
    expect(String(aoFalhar.mock.calls[0][0])).toContain('de 0 a 1');
    expect(chamadas).toHaveLength(0);
  });
});
