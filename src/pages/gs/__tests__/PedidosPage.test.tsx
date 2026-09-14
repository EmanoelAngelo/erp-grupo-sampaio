/**
 * Pedidos online — o lado da operação.
 *
 * O que esta tela não pode deixar passar: pedido cancelado que RECEBEU
 * pagamento. O cliente vê essa pendência no portal dele; se aqui ela não
 * aparecer, o dinheiro fica na conta da empresa e ninguém devolve nem refaz o
 * pedido. Aviso no topo com os números, e marca na linha.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PedidosPage } from '../GestaoPages';

function pedido(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    number: 1001,
    customer_name: 'Ana Compradora',
    total_cents: 20000,
    status: 'aguardando_pagamento',
    tracking_code: null,
    created_at: '2026-08-10T12:00:00.000Z',
    ...over,
  };
}

/**
 * O VOCABULÁRIO VEM DO SERVIDOR, e por isso o dublê o manda.
 *
 * A tela tinha os próprios mapas de rótulo e de próxima etapa, e o de etapas
 * dizia `embalado → expedido` para TODO pedido — enquanto o padrão de toda
 * loja do grupo é RETIRADA. O pedido parava em "Embalado" com a mercadoria no
 * balcão. Agora a lista de pedidos traz as duas ordens e os rótulos.
 */
const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: {
    aguardando_pagamento: 'Aguardando pagamento',
    pago: 'Pago',
    separacao: 'Separação',
    conferencia: 'Conferência',
    embalado: 'Embalado',
    expedido: 'Expedido',
    pronto_para_retirada: 'Pronto para retirada',
    entregue: 'Entregue',
    cancelado: 'Cancelado',
    reembolsado: 'Reembolsado',
  },
};

function servidor(items: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ items, vocabulario: VOCABULARIO }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

function montar() {
  render(
    <MemoryRouter>
      <PedidosPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('pagamento recebido depois do cancelamento', () => {
  it('avisa no topo, com o número do pedido', async () => {
    servidor([
      pedido({ id: 'ord-9', number: 1009, status: 'cancelado', payment_after_cancel: 1 }),
    ]);
    montar();

    const aviso = await screen.findByTestId('pedidos-pagos-apos-cancelamento');
    expect(aviso.textContent).toContain('1 pedido cancelado recebeu pagamento');
    expect(aviso.textContent).toContain('#1009');
    expect(aviso.textContent).toContain('devolver ao cliente ou refazer');
  });

  it('marca a linha do pedido, não só o topo', async () => {
    servidor([
      pedido({ id: 'ord-9', number: 1009, status: 'cancelado', payment_after_cancel: 1 }),
    ]);
    montar();

    await screen.findByText('Pago após cancelar');
  });

  it('conta os pedidos certos quando há mais de um', async () => {
    servidor([
      pedido({ id: 'a', number: 1, status: 'cancelado', payment_after_cancel: 1 }),
      pedido({ id: 'b', number: 2, status: 'pago' }),
      pedido({ id: 'c', number: 3, status: 'cancelado', payment_after_cancel: 1 }),
    ]);
    montar();

    const aviso = await screen.findByTestId('pedidos-pagos-apos-cancelamento');
    expect(aviso.textContent).toContain('2 pedidos cancelados receberam pagamento');
    expect(aviso.textContent).toContain('#1, #3');
    expect(aviso.textContent).not.toContain('#2');
  });

  it('sem pendência não há aviso — alarme que toca sempre ninguém escuta', async () => {
    servidor([
      pedido({ status: 'pago' }),
      pedido({ id: 'x', number: 2, status: 'cancelado', customer_name: 'Bruno Comprador' }),
    ]);
    montar();

    await screen.findByText('Bruno Comprador');
    expect(screen.queryByTestId('pedidos-pagos-apos-cancelamento')).toBeNull();
    expect(screen.queryByText('Pago após cancelar')).toBeNull();
  });
});

/**
 * EXPEDIR É DESPACHAR — com QUEM leva (GAP-PRD-119/120).
 *
 * Aqui estavam os testes do `window.prompt` que pedia só o código. O código
 * sozinho, sem transportadora, deixava o portal sem link e ninguém sabia se a
 * encomenda foi pelos Correios ou pelo motoboy. Agora "Expedido" abre o
 * formulário de despacho: quem leva é obrigatório, o código é opcional (entrega
 * própria não tem, e exigir faria alguém inventar), e cancelar não expede.
 */
describe('despacho ao expedir', () => {
  /**
   * O dublê conta as LEITURAS da lista além de guardar os envios.
   *
   * A contagem é o único sinal de que a recarga da tela terminou: esperar só o
   * POST devolveria o controle no meio da corrente (POST → recarga →
   * `setState`), e o `setState` atrasado cairia num jsdom já desmontado — uma
   * "Unhandled Rejection" atribuída a outro arquivo.
   */
  function servidorQueRegistra(items: unknown[], envios: unknown[] = []) {
    const chamadas: { url: string; body: unknown }[] = [];
    const leituras = { total: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
        if (init?.method === 'POST') {
          chamadas.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (String(url).includes('/logistics/orders/')) {
          return new Response(JSON.stringify({ readiness: null, items: envios }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        leituras.total += 1;
        return new Response(JSON.stringify({ items, vocabulario: VOCABULARIO }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    return { chamadas, leituras };
  }

  async function telaParada(leituras: { total: number }) {
    await vi.waitFor(() => expect(leituras.total).toBeGreaterThanOrEqual(2));
    await act(async () => {});
  }

  async function abrirDespacho() {
    (await screen.findByRole('button', { name: 'Expedido' })).click();
    return screen.findByLabelText(/Quem leva a encomenda/);
  }

  it('não usa mais o prompt: pede QUEM leva e o código, e manda os dois', async () => {
    const { chamadas, leituras } = servidorQueRegistra([pedido({ id: 'ord-5', status: 'embalado' })]);
    const perguntou = vi.fn(() => 'x');
    vi.stubGlobal('prompt', perguntou);
    montar();

    const quem = await abrirDespacho();
    expect(perguntou).not.toHaveBeenCalled();
    // Sem escolher quem leva, não despacha.
    expect((screen.getByRole('button', { name: 'Despachar' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(quem, { target: { value: 'correios' } });
    fireEvent.change(screen.getByLabelText(/Código de rastreio/), { target: { value: 'BR123456789BR' } });
    screen.getByRole('button', { name: 'Despachar' }).click();

    await vi.waitFor(() => expect(chamadas.length).toBeGreaterThan(0));
    const envio = chamadas.find((c) => c.url.includes('/fulfillment'))!;
    expect(envio.body).toEqual({ status: 'expedido', carrier: 'correios', trackingCode: 'BR123456789BR' });
    await telaParada(leituras);
  });

  it('entrega da loja despacha sem código — motoboy não tem', async () => {
    const { chamadas, leituras } = servidorQueRegistra([pedido({ id: 'ord-6', status: 'embalado' })]);
    montar();

    fireEvent.change(await abrirDespacho(), { target: { value: 'propria' } });
    screen.getByRole('button', { name: 'Despachar' }).click();

    await vi.waitFor(() => expect(chamadas.length).toBeGreaterThan(0));
    const envio = chamadas.find((c) => c.url.includes('/fulfillment'))!;
    expect((envio.body as { trackingCode?: string }).trackingCode).toBeUndefined();
    expect((envio.body as { carrier?: string }).carrier).toBe('propria');
    await telaParada(leituras);
  });

  it('cancelar o despacho NÃO expede', async () => {
    const { chamadas } = servidorQueRegistra([pedido({ id: 'ord-7', status: 'embalado' })]);
    montar();

    await abrirDespacho();
    screen.getByRole('button', { name: 'Cancelar' }).click();

    // Uma vez marcado "expedido", o e-mail já saiu para o cliente.
    await new Promise((r) => setTimeout(r, 30));
    expect(chamadas.filter((c) => c.url.includes('/fulfillment'))).toHaveLength(0);
    expect(screen.queryByLabelText(/Quem leva a encomenda/)).toBeNull();
  });

  it('com etiqueta do Melhor Envio gerada, o código vem dela — só se confirma', async () => {
    const { chamadas, leituras } = servidorQueRegistra(
      [pedido({ id: 'ord-9', status: 'embalado' })],
      [{ id: 'env-1', channel: 'melhor_envio', status: 'etiqueta_gerada', statusLabel: 'Etiqueta gerada', trackingCode: 'AA123456789BR', serviceName: 'Correios PAC' }],
    );
    montar();

    (await screen.findByRole('button', { name: 'Expedido' })).click();
    expect((await screen.findByTestId('despacho-com-etiqueta')).textContent).toContain('AA123456789BR');
    expect(screen.queryByLabelText(/Quem leva a encomenda/)).toBeNull();
    screen.getByRole('button', { name: 'Despachar' }).click();

    await vi.waitFor(() => expect(chamadas.length).toBeGreaterThan(0));
    expect(chamadas.find((c) => c.url.includes('/fulfillment'))!.body).toEqual({ status: 'expedido' });
    await telaParada(leituras);
  });

  it('as outras etapas não abrem despacho nenhum', async () => {
    const { chamadas, leituras } = servidorQueRegistra([pedido({ id: 'ord-8', status: 'pago' })]);
    montar();

    (await screen.findByText('Separação')).click();

    await vi.waitFor(() => expect(chamadas.length).toBeGreaterThan(0));
    expect(chamadas[0].body).toEqual({ status: 'separacao' });
    expect(screen.queryByLabelText(/Quem leva a encomenda/)).toBeNull();
    await telaParada(leituras);
  });

  it('o rastreio da lista vira link quando o servidor manda a página da transportadora', async () => {
    servidor([
      pedido({
        id: 'ord-10',
        status: 'expedido',
        tracking_code: 'AA123456789BR',
        tracking_url: 'https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR',
      }),
      pedido({ id: 'ord-11', number: 1011, status: 'expedido', tracking_code: 'MOTOBOY-7', tracking_url: null }),
    ]);
    montar();

    const link = await screen.findByRole('link', { name: 'AA123456789BR' });
    expect(link.getAttribute('href')).toBe('https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR');
    expect(link.getAttribute('target')).toBe('_blank');
    // Sem página conhecida, o código fica em texto — nada de link inventado.
    expect(screen.getByText('MOTOBOY-7').closest('a')).toBeNull();
  });
});

/**
 * O BECO SEM SAÍDA DO PEDIDO DE RETIRADA.
 *
 * O padrão de toda loja do grupo é `pickup_enabled: 1, delivery_enabled: 0`:
 * todo pedido online nasce sendo de RETIRADA. A tela avançava por um mapa fixo
 * — `embalado → expedido` — e "expedido" é etapa de entrega. O servidor recusa
 * com 409, a tela não conhecia "pronto para retirada", e o pedido ficava parado
 * em "Embalado": a mercadoria no balcão, o cliente sem aviso nenhum.
 */
describe('o pedido de retirada tem para onde ir', () => {
  it('depois de embalado, o botão oferece "Pronto para retirada"', async () => {
    servidor([pedido({ status: 'embalado', shipping_method: 'retirada' })]);
    montar();

    expect(await screen.findByRole('button', { name: 'Pronto para retirada' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Expedido' })).toBeNull();
  });

  it('e no de ENTREGA continua oferecendo "Expedido"', async () => {
    servidor([pedido({ status: 'embalado', shipping_method: 'sedex' })]);
    montar();

    expect(await screen.findByRole('button', { name: 'Expedido' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pronto para retirada' })).toBeNull();
  });

  it('o pedido pronto para retirada ainda pode ser marcado como entregue', async () => {
    servidor([pedido({ status: 'pronto_para_retirada', shipping_method: 'retirada' })]);
    montar();

    expect(await screen.findByRole('button', { name: 'Entregue' })).toBeTruthy();
  });

  it('o estado "pronto para retirada" aparece com rótulo, e não com o código cru', async () => {
    servidor([pedido({ status: 'pronto_para_retirada', shipping_method: 'retirada' })]);
    montar();

    expect(await screen.findByText('Pronto para retirada')).toBeTruthy();
    expect(screen.queryByText('pronto_para_retirada')).toBeNull();
  });

  it('o reembolsado também tem rótulo — e não oferece etapa nenhuma', async () => {
    servidor([pedido({ status: 'reembolsado', shipping_method: 'sedex' })]);
    montar();

    expect(await screen.findByText('Reembolsado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Separação' })).toBeNull();
  });

  it('sem método de envio, vale o caminho da entrega', async () => {
    // Pedido antigo, anterior ao campo. O caminho de entrega é o que a loja
    // fazia até então — e "expedido" recusado é melhor que botão nenhum.
    servidor([pedido({ status: 'embalado', shipping_method: null })]);
    montar();

    expect(await screen.findByRole('button', { name: 'Expedido' })).toBeTruthy();
  });
});
