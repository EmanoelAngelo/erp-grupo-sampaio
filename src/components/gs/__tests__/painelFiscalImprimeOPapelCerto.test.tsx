/**
 * O PAINEL FISCAL DO PDV ENTREGA O PAPEL CERTO — F-cupom-fiscal-03/16/01.
 *
 *  - O "Imprimir" ao lado de "Ver DANFCE" e de "DANFCE de contingência"
 *    imprimia o comprovante NÃO fiscal; e os estados com documento na fila,
 *    enviando, recusado ou com erro não ofereciam papel nenhum.
 *  - "Ver DANFCE" abria a janela depois de um `await`, com 'noopener' (que
 *    sempre devolve nulo), e engolia o erro com `void`: o botão não fazia nada.
 *  - ERROR com a fila morta não anda mais, e o painel perguntava a cada 3 s
 *    pelo resto do expediente.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PainelFiscalPdv } from '@/components/gs/PainelFiscalPdv';
import { coreApi, type FiscalSaleStatus } from '@/lib/api/core';

function status(over: Partial<FiscalSaleStatus['document']>, extra: Partial<FiscalSaleStatus> = {}): FiscalSaleStatus {
  return {
    document: {
      id: 'doc-1',
      model: '65',
      serie: 1,
      number: 10,
      accessKey: '35260900000000000000650010000000101000000010',
      environment: 'homologation',
      status: 'AUTHORIZED',
      protocol: 'P-1',
      cStat: '100',
      xMotivo: 'Autorizado',
      saleId: 'sale-1',
      saleNumber: 1,
      customerName: null,
      recipientDocument: null,
      totalCents: 1000,
      authorizedAt: '2026-09-14T12:00:00.000Z',
      createdAt: '2026-09-14T12:00:00.000Z',
      ...over,
    },
    statusLabel: 'Situação',
    terminal: false,
    isTest: false,
    ...extra,
  };
}

let impresso: [string, string][];

function montar(terminalId?: string | null) {
  render(
    <PainelFiscalPdv
      saleId="sale-1"
      terminalId={terminalId}
      onDispensar={() => undefined}
      onImprimir={(tipo, id) => impresso.push([tipo, id])}
    />,
  );
}

beforeEach(() => {
  impresso = [];
  vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
    canEmit: false,
    alreadyEmitted: true,
    reasons: [],
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('o papel de cada estado', () => {
  it('autorizada: "Imprimir DANFCE" pede o DANFCE do documento', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(status({}, { terminal: true, statusLabel: 'NFC-e autorizada' }));
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir DANFCE' }));
    expect(impresso).toEqual([['DANFCE', 'doc-1']]);
  });

  it('contingência: o papel é o DANFCE de contingência, e não o comprovante', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      status(
        { id: 'doc-2', status: 'CONTINGENCY' },
        { statusLabel: 'Em contingência', contingencia: { offline: true, pendente: true, prazoDeTransmissao: null } },
      ),
    );
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir DANFCE' }));
    expect(impresso).toEqual([['DANFCE', 'doc-2']]);
  });

  it('na fila: há papel para o cliente — o comprovante da venda', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(status({ status: 'QUEUED' }, { statusLabel: 'Na fila' }));
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir comprovante' }));
    expect(impresso).toEqual([['SALE_RECEIPT', 'sale-1']]);
  });
});

describe('"Ver DANFCE" não falha em silêncio', () => {
  it('janela barrada pelo navegador: a tela diz para liberar pop-ups', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(status({}, { terminal: true, statusLabel: 'NFC-e autorizada' }));
    vi.stubGlobal('open', vi.fn(() => null));
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver DANFCE' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/bloqueou a janela/);
  });

  it('o documento não veio: a aba vazia fecha e o motivo aparece', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(status({}, { terminal: true, statusLabel: 'NFC-e autorizada' }));
    const aba = { close: vi.fn(), opener: {} as unknown, location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => aba));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'CORE_FISCAL_X', message: 'DANFCE indisponível agora.' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver DANFCE' }));
    await screen.findByRole('alert');
    expect(aba.close).toHaveBeenCalled();
  });
});

/*
  PED-pdv-08 — O DANFCE REABERTO DIZ DE QUAL CAIXA É O COMPUTADOR.

  A rota escolhe a largura da bobina pela impressora de cupom do caixa
  (`?terminalId=`); sem ele, usa o token de dispositivo ou o caixa DA VENDA — e
  o DANFCE de uma venda do caixa 1 (80 mm), reaberto no caixa 2 (58 mm), saía
  cortado. Como fica vermelho: tire o `terminalId` de `caminhoDoDanfce`.
*/
describe('PED-pdv-08 — o DANFCE reaberto sai na bobina deste caixa', () => {
  function capturar() {
    const aba = { close: vi.fn(), opener: {} as unknown, location: { href: '' } };
    vi.stubGlobal('open', vi.fn(() => aba));
    const pedidos: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        pedidos.push(String(url));
        return new Response('<html><body>DANFCE</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
    );
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:danfce'), revokeObjectURL: vi.fn() });
    return { aba, pedidos };
  }

  it('"Ver DANFCE" manda o caixa deste computador', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(status({}, { terminal: true, statusLabel: 'NFC-e autorizada' }));
    const { aba, pedidos } = capturar();
    montar('cx-2');
    fireEvent.click(await screen.findByRole('button', { name: 'Ver DANFCE' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0]).toMatch(/\/core\/fiscal\/documents\/doc-1\/danfce\?terminalId=cx-2$/);
    await waitFor(() => expect(aba.location.href).toBe('blob:danfce'));
  });

  it('a prévia do documento recusado combina o caixa com preview=1', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      status({ status: 'REJECTED', cStat: '539', xMotivo: 'Duplicidade' }, { terminal: true, statusLabel: 'Rejeitada' }),
    );
    const { pedidos } = capturar();
    montar('cx-2');
    fireEvent.click(await screen.findByRole('button', { name: 'Ver documento recusado' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0]).toMatch(/\/danfce\?terminalId=cx-2&preview=1$/);
  });

  it('sem caixa conhecido, a rota decide: nenhum parâmetro vai junto', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(status({}, { terminal: true, statusLabel: 'NFC-e autorizada' }));
    const { pedidos } = capturar();
    montar(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver DANFCE' }));
    await waitFor(() => expect(pedidos).toHaveLength(1));
    expect(pedidos[0]).toMatch(/\/core\/fiscal\/documents\/doc-1\/danfce$/);
  });
});

describe('ERROR com a fila morta encerra a consulta', () => {
  it('o painel pergunta uma vez e para — não bate no servidor pelo resto do dia', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const consulta = vi
      .spyOn(coreApi, 'getFiscalStatusForSale')
      .mockResolvedValue(status({ status: 'ERROR', cStat: null, xMotivo: 'Falha' }, { statusLabel: 'Com erro', queue: { attempts: 5, nextAttemptAt: null, status: 'dead' } }));
    montar();
    await screen.findByText('Com erro');
    await vi.advanceTimersByTimeAsync(12_000);
    await waitFor(() => expect(consulta).toHaveBeenCalledTimes(1));
  });
});
