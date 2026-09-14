/**
 * Painel fiscal do PDV — os estados que o caixa lê.
 *
 * Estes testes existem porque o painel foi verificado só no navegador nas
 * rodadas anteriores. Verificação manual não pega regressão: basta alguém
 * trocar um rótulo para o operador voltar a ver enum cru, e ninguém descobrir
 * até o balcão reclamar.
 *
 * O QUE MAIS IMPORTA AQUI: a tarja de teste. Um cupom do provider de teste que
 * pareça autorizado de verdade faz alguém entregar ao cliente um documento que
 * não existe para o fisco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PainelFiscalPdv } from '@/components/gs/PainelFiscalPdv';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type FiscalSaleStatus } from '@/lib/api/core';

function statusFalso(over: Partial<FiscalSaleStatus> = {}): FiscalSaleStatus {
  return {
    document: {
      id: 'doc-1',
      model: '65',
      serie: 1,
      number: 42,
      accessKey: '1'.repeat(44),
      environment: 'homologation',
      status: 'AUTHORIZED',
      protocol: 'TEST-abc123',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      saleId: 'sale-1',
      saleNumber: 7,
      customerName: null,
      totalCents: 10000,
      authorizedAt: '2026-08-13T12:00:00.000Z',
      createdAt: '2026-08-13T12:00:00.000Z',
      ...(over.document ?? {}),
    },
    statusLabel: 'NFC-e autorizada',
    terminal: true,
    isTest: true,
    queue: null,
    ...over,
  } as FiscalSaleStatus;
}

function montar(saleId = 'sale-1') {
  return render(
    <MemoryRouter>
      <PainelFiscalPdv saleId={saleId} onDispensar={() => {}} onImprimir={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('estados em português', () => {
  it('autorizada mostra a frase, o protocolo e as ações de impressão', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(statusFalso());
    montar();

    expect(await screen.findByText('NFC-e autorizada')).toBeTruthy();
    expect(screen.getByText(/Protocolo TEST-abc123/)).toBeTruthy();
    expect(screen.getByText('Ver DANFCE')).toBeTruthy();
    // "Imprimir DANFCE", e não "Imprimir": ao lado de "Ver DANFCE" o botão
    // imprimia o comprovante NÃO fiscal (F-cupom-fiscal-03). Agora imprime o
    // DANFCE, e o rótulo diz qual papel sai.
    expect(screen.getByText('Imprimir DANFCE')).toBeTruthy();
  });

  it('rejeitada mostra cStat e motivo, e NÃO oferece DANFCE', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      statusFalso({
        statusLabel: 'NFC-e rejeitada',
        document: { status: 'REJECTED', protocol: null, cStat: '539', xMotivo: 'Duplicidade' } as never,
      }),
    );
    montar();

    expect(await screen.findByText('NFC-e rejeitada')).toBeTruthy();
    expect(screen.getByText(/cStat 539/)).toBeTruthy();
    expect(screen.getByText(/Duplicidade/)).toBeTruthy();
    // Rejeitada não pode ter caminho para cupom autorizado.
    expect(screen.queryByText('Ver DANFCE')).toBeNull();
    expect(screen.getByText('Ver documento recusado')).toBeTruthy();
  });

  /** Enviando sem desfecho é o caso em que a resposta pode ter se perdido. */
  it('SENDING vira "Resposta da SEFAZ não confirmada", não "enviando" eterno', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      statusFalso({
        statusLabel: 'Enviando à SEFAZ',
        terminal: false,
        document: { status: 'SENDING', protocol: null } as never,
      }),
    );
    montar();

    expect(await screen.findByText('Resposta da SEFAZ não confirmada')).toBeTruthy();
    // E a instrução que evita a nota duplicada.
    expect(screen.getByText(/Não emita de novo/i)).toBeTruthy();
  });

  it('contingência mostra a frase do estado', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      statusFalso({
        statusLabel: 'Em contingência',
        terminal: false,
        document: { status: 'CONTINGENCY', protocol: null } as never,
      }),
    );
    montar();
    expect(await screen.findByText('Em contingência')).toBeTruthy();
  });

  it('venda sem nota diz isso, sem parecer erro', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(null);
    montar();
    expect(await screen.findByText(/Nenhuma NFC-e emitida para ela/)).toBeTruthy();
  });
});

describe('tarja de ambiente de teste', () => {
  it('cupom de teste avisa em destaque que não vale para o fisco', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(statusFalso({ isTest: true }));
    montar();

    expect(await screen.findByText('AMBIENTE DE TESTE')).toBeTruthy();
    expect(screen.getByText(/NÃO É DOCUMENTO FISCAL HOMOLOGADO/)).toBeTruthy();
  });

  it('documento que não é de teste não mostra a tarja', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(statusFalso({ isTest: false }));
    montar();

    await screen.findByText('NFC-e autorizada');
    expect(screen.queryByText('AMBIENTE DE TESTE')).toBeNull();
  });
});

describe('poll', () => {
  /** Estado terminal encerra o poll: nada mais vai mudar. */
  it('para de consultar quando o documento alcança desfecho', async () => {
    const spy = vi
      .spyOn(coreApi, 'getFiscalStatusForSale')
      .mockResolvedValue(statusFalso({ terminal: true }));
    montar();

    await screen.findByText('NFC-e autorizada');
    const chamadasIniciais = spy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(spy.mock.calls.length).toBe(chamadasIniciais);
  });

  it('continua consultando enquanto não há desfecho', async () => {
    const spy = vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      statusFalso({
        terminal: false,
        statusLabel: 'Aguardando transmissão',
        document: { status: 'QUEUED', protocol: null } as never,
      }),
    );
    montar();

    await screen.findByText('Aguardando transmissão');
    const antes = spy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy.mock.calls.length).toBeGreaterThan(antes);
  });

  /** Um poll que sobrevive ao componente vira vazamento. */
  it('desmontar encerra o poll', async () => {
    const spy = vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      statusFalso({ terminal: false, document: { status: 'QUEUED' } as never }),
    );
    const { unmount } = montar();
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(0));

    unmount();
    const aoDesmontar = spy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy.mock.calls.length).toBe(aoDesmontar);
  });

  it('erro na consulta encerra o poll em vez de martelar o servidor', async () => {
    const spy = vi
      .spyOn(coreApi, 'getFiscalStatusForSale')
      .mockRejectedValue(new Error('rede fora'));
    montar();

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(0));
    const antes = spy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy.mock.calls.length).toBe(antes);
  });

  /**
   * Venda sem documento continua sendo observada por um tempo — a nota pode
   * ser emitida segundos depois — mas não para sempre.
   */
  it('venda sem documento é reconsultada, com limite', async () => {
    const spy = vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(null);
    montar();

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(12_000);
    const durante = spy.mock.calls.length;
    expect(durante).toBeGreaterThan(1);

    // Passado o limite (~20 voltas de 3s), para.
    await vi.advanceTimersByTimeAsync(120_000);
    const depois = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.length).toBe(depois);
  });
});

describe('detalhes', () => {
  it('mostra chave, protocolo e tentativas sem vazar segredo', async () => {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(
      statusFalso({ queue: { attempts: 3, nextAttemptAt: '2026-08-13T13:00:00.000Z' } }),
    );
    const { container } = montar();

    (await screen.findByText('Detalhes')).click();

    await waitFor(() => expect(screen.queryByText('Chave de acesso')).toBeTruthy());
    expect(screen.getByText('Tentativas')).toBeTruthy();

    const html = container.innerHTML;
    expect(html).not.toMatch(/cscToken|privateKey|senha|\.pfx/i);
  });
});

/**
 * O gatilho que faltava.
 *
 * O pipeline fiscal inteiro existia e nenhuma tela o acionava: a venda saía
 * sempre sem nota. O botão fecha esse buraco — mas ele só pode aparecer quando
 * a emissão de fato anda. Oferecer e falhar no meio do atendimento é pior do
 * que não oferecer, porque o caixa clica, espera e só então descobre.
 */
describe('emitir a NFC-e a partir da venda', () => {
  function semNota() {
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(null);
  }

  it('com tudo em ordem, oferece o botão e emite a venda que está na tela', async () => {
    semNota();
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
      canEmit: true,
      alreadyEmitted: false,
      reasons: [],
    });
    const emitir = vi
      .spyOn(coreApi, 'emitNfceForSale')
      .mockResolvedValue(statusFalso({ terminal: false }));

    montar('sale-42');
    (await screen.findByText('emitir NFC-e')).click();

    await waitFor(() => expect(emitir).toHaveBeenCalled());
    // A venda emitida é a do painel. Emitir a nota da venda errada é pior do
    // que não emitir: sai documento fiscal do cliente que já foi embora.
    expect(emitir.mock.calls[0][0]).toBe('sale-42');
  });

  it('sem poder emitir, mostra o motivo e NÃO mostra o botão', async () => {
    semNota();
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
      canEmit: false,
      alreadyEmitted: false,
      reasons: ['Certificado A1: Nenhum certificado carregado nesta operação.'],
    });

    montar();

    expect(await screen.findByText(/Certificado A1/)).toBeTruthy();
    expect(screen.queryByText('emitir NFC-e')).toBeNull();
  });

  it('enquanto não se sabe a prontidão, não oferece emissão', async () => {
    semNota();
    // Servidor fora do ar, resposta lenta, offline: o painel não sabe. Não
    // saber e oferecer mesmo assim é o caminho do erro no balcão.
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockRejectedValue(new Error('rede'));

    montar();

    expect(await screen.findByText(/Nenhuma NFC-e emitida para ela/)).toBeTruthy();
    expect(screen.queryByText('emitir NFC-e')).toBeNull();
    expect(screen.queryByText(/Emissão indisponível/)).toBeNull();
  });

  it('venda que já tem nota não vira aviso de pendência', async () => {
    semNota();
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
      canEmit: false,
      alreadyEmitted: true,
      reasons: ['Esta venda já tem NFC-e.'],
    });

    montar();

    await screen.findByText(/Nenhuma NFC-e emitida para ela/);
    // "Emissão indisponível" aqui faria o caixa procurar um problema que não
    // existe: a nota está emitida, o painel só ainda não a leu.
    expect(screen.queryByText(/Emissão indisponível/)).toBeNull();
    expect(screen.queryByText('emitir NFC-e')).toBeNull();
  });

  it('falha na emissão aparece na tela, com o texto do servidor', async () => {
    semNota();
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
      canEmit: true,
      alreadyEmitted: false,
      reasons: [],
    });
    vi.spyOn(coreApi, 'emitNfceForSale').mockRejectedValue(
      new ApiRequestError('CORE_FISCAL_NOT_READY', 'Emissão bloqueada. Pendências: CSC', 409),
    );

    montar();
    (await screen.findByText('emitir NFC-e')).click();

    // Sem isto o clique não faria nada visível e o caixa clicaria de novo.
    expect(await screen.findByText(/Emissão bloqueada/)).toBeTruthy();
  });
});
