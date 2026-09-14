/**
 * A FILA FISCAL NA TELA — GAP-PRD-020, a metade que só se prova na tela.
 *
 * A contingência era beco sem saída pela UI (a rota de reenfileirar não tinha
 * chamador em `src/`) e a nota presa só andava na próxima venda. Agora:
 *
 *  - a tela de documentos mostra a fila: transmissão automática ligada, a
 *    última resposta da SEFAZ, cada nota que espera com o motivo, e o botão
 *    "Transmitir agora" (uma) e "Transmitir pendentes agora" (todas);
 *  - o detalhe da nota na fila ou em contingência tem o gesto;
 *  - o caixa não vê o quadro (403 some com ele);
 *  - o PDV diz quando é a próxima tentativa automática.
 *
 * ## Como fica vermelho
 *
 *  - tire o `FilaFiscalCard` da página e os casos da fila não acham o quadro;
 *  - tire o botão do detalhe e o caso da contingência não acha o gesto;
 *  - tire a frase do PDV e o último caso falha.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FiscalDocumentosPage from '@/pages/gs/FiscalDocumentosPage';
import { FilaFiscalCard } from '@/components/gs/FilaFiscal';
import { PainelFiscalPdv } from '@/components/gs/PainelFiscalPdv';
import { ApiRequestError } from '@/lib/api/client';
import type { PainelDaFilaFiscal } from '@/lib/api/filaFiscal';

const api = vi.hoisted(() => ({
  painel: vi.fn(),
  transmitirAgora: vi.fn(),
  transmitirPendentes: vi.fn(),
  listFiscalDocuments: vi.fn(),
  getFiscalDocument: vi.fn(),
  getFiscalStatusForSale: vi.fn(),
}));

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/api/filaFiscal', () => ({
  filaFiscalApi: {
    painel: api.painel,
    transmitirAgora: api.transmitirAgora,
    transmitirPendentes: api.transmitirPendentes,
  },
}));

vi.mock('@/lib/api/core', () => ({
  coreApi: {
    listFiscalDocuments: api.listFiscalDocuments,
    getFiscalReconciliation: () => Promise.reject(new Error('sem permissão')),
    getFiscalDocument: api.getFiscalDocument,
    getFiscalStatusForSale: api.getFiscalStatusForSale,
    getEmissionReadinessForSale: () => Promise.resolve({ canEmit: false, alreadyEmitted: true, reasons: [] }),
  },
}));

const NOTA_NA_FILA = {
  id: 'doc-fila',
  model: '65',
  serie: 1,
  number: 31,
  accessKey: '43260911222333000181650010000000311000000310',
  environment: 'homologation',
  status: 'QUEUED',
  protocol: null,
  cStat: null,
  xMotivo: null,
  saleId: 'sale-31',
  saleNumber: 31,
  customerName: null,
  recipientDocument: null,
  totalCents: 10_000,
  authorizedAt: null,
  createdAt: '2026-09-11T13:00:00.000Z',
};

function painel(parcial: Partial<PainelDaFilaFiscal> = {}): PainelDaFilaFiscal {
  return {
    trabalhador: { ligado: true, tickMs: 60_000, ultimaPassada: '2026-09-11T13:05:00.000Z', ultimoErro: null },
    sefaz: {
      em: '2026-09-11T13:04:00.000Z',
      online: false,
      cStat: '108',
      xMotivo: 'Servico Paralisado Momentaneamente',
      fonte: 'sefaz',
    },
    contagem: { aguardando: 0, novaTentativa: 1, desistiu: 0, enviando: 0 },
    itens: [
      {
        documentId: 'doc-fila',
        model: '65',
        serie: 1,
        number: 31,
        documentStatus: 'QUEUED',
        queueStatus: 'retry',
        attempts: 2,
        nextAttemptAt: '2026-09-11T13:20:00.000Z',
        lastAttemptAt: '2026-09-11T13:05:00.000Z',
        errorCode: 'NETWORK_ERROR',
        errorMessage: 'Falha de rede ao contatar a SEFAZ.',
        createdAt: '2026-09-11T13:00:00.000Z',
      },
    ],
    pendencias: [],
    ...parcial,
  };
}

beforeEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.values(api).forEach((f) => f.mockReset());
  api.listFiscalDocuments.mockResolvedValue([NOTA_NA_FILA]);
  api.getFiscalDocument.mockResolvedValue({ document: NOTA_NA_FILA, events: [] });
});

afterEach(() => {
  cleanup();
});

describe('o quadro da fila na tela de documentos', () => {
  it('mostra a transmissão automática, a SEFAZ fora e a nota com o motivo', async () => {
    api.painel.mockResolvedValue(painel());
    render(
      <MemoryRouter>
        <FiscalDocumentosPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Transmissão à SEFAZ')).toBeTruthy();
    expect(screen.getByText(/Transmissão automática ligada/)).toBeTruthy();
    expect(screen.getByText(/SEFAZ fora do ar ou sem resposta/)).toBeTruthy();
    expect(screen.getByText(/cStat 108/)).toBeTruthy();
    expect(screen.getByText('Falha de rede ao contatar a SEFAZ.')).toBeTruthy();
    expect(screen.getByText('Nova tentativa automática')).toBeTruthy();
  });

  it('"Transmitir agora" leva a nota ao servidor e diz o desfecho', async () => {
    api.painel.mockResolvedValue(painel());
    api.transmitirAgora.mockResolvedValue({
      document: { ...NOTA_NA_FILA, status: 'AUTHORIZED' },
      statusLabel: 'NFC-e autorizada',
      outcome: 'AUTHORIZED',
    });
    render(<FilaFiscalCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Transmitir agora' }));
    await waitFor(() => expect(api.transmitirAgora).toHaveBeenCalledWith('doc-fila'));
    expect(await screen.findByText('NFC-e 31: NFC-e autorizada.')).toBeTruthy();
    // E recarrega o painel.
    expect(api.painel).toHaveBeenCalledTimes(2);
  });

  it('"Transmitir pendentes agora" drena a fila da operação', async () => {
    api.painel.mockResolvedValue(painel());
    api.transmitirPendentes.mockResolvedValue({
      resultado: { transmitidos: 1, esperando: 0, paradaPor: null },
      painel: painel({ itens: [], contagem: { aguardando: 0, novaTentativa: 0, desistiu: 0, enviando: 0 } }),
    });
    render(<FilaFiscalCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Transmitir pendentes agora' }));
    await waitFor(() => expect(api.transmitirPendentes).toHaveBeenCalled());
    expect(await screen.findByText('1 nota(s) transmitida(s).')).toBeTruthy();
    expect(screen.getByText('Nenhuma nota esperando transmissão.')).toBeTruthy();
  });

  it('servidor sem o trabalhador: a tela diz que a transmissão automática está desligada', async () => {
    api.painel.mockResolvedValue(
      painel({ trabalhador: { ligado: false, tickMs: null, ultimaPassada: null, ultimoErro: null } }),
    );
    render(<FilaFiscalCard />);
    expect(await screen.findByText(/Transmissão automática DESLIGADA/)).toBeTruthy();
  });

  it('o caixa (403) não vê o quadro', async () => {
    api.painel.mockRejectedValue(new ApiRequestError('API_PERMISSION_DENIED', 'Permissão negada', 403));
    const { container } = render(<FilaFiscalCard />);
    await waitFor(() => expect(api.painel).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('o gesto no detalhe da nota', () => {
  async function abrirDetalhe() {
    render(
      <MemoryRouter>
        <FiscalDocumentosPage />
      </MemoryRouter>,
    );
    const linha = (await screen.findByText('NFC-e 31/1')).closest('tr')!;
    fireEvent.click(linha.querySelector('button')!);
  }

  it('nota na fila: "Transmitir agora" no detalhe', async () => {
    api.painel.mockResolvedValue(painel({ itens: [] }));
    api.transmitirAgora.mockResolvedValue({
      document: { ...NOTA_NA_FILA, status: 'AUTHORIZED' },
      statusLabel: 'NFC-e autorizada',
      outcome: 'AUTHORIZED',
    });
    await abrirDetalhe();
    const botoes = await screen.findAllByRole('button', { name: 'Transmitir agora' });
    fireEvent.click(botoes[botoes.length - 1]);
    await waitFor(() => expect(api.transmitirAgora).toHaveBeenCalledWith('doc-fila'));
    expect(await screen.findByText('NFC-e autorizada.')).toBeTruthy();
  });

  it('nota em contingência: o detalhe devolve à fila — deixou de ser beco sem saída', async () => {
    const emContingencia = { ...NOTA_NA_FILA, status: 'CONTINGENCY' };
    api.listFiscalDocuments.mockResolvedValue([emContingencia]);
    api.getFiscalDocument.mockResolvedValue({ document: emContingencia, events: [] });
    api.painel.mockResolvedValue(painel({ itens: [] }));
    api.transmitirAgora.mockResolvedValue({
      document: { ...NOTA_NA_FILA, status: 'AUTHORIZED' },
      statusLabel: 'NFC-e autorizada',
      outcome: 'AUTHORIZED',
    });
    await abrirDetalhe();
    fireEvent.click(await screen.findByRole('button', { name: 'Devolver à fila e transmitir' }));
    await waitFor(() => expect(api.transmitirAgora).toHaveBeenCalledWith('doc-fila'));
  });

  it('nota autorizada não tem o gesto', async () => {
    const autorizada = { ...NOTA_NA_FILA, status: 'AUTHORIZED', protocol: '143260000000031' };
    api.listFiscalDocuments.mockResolvedValue([autorizada]);
    api.getFiscalDocument.mockResolvedValue({ document: autorizada, events: [] });
    api.painel.mockResolvedValue(painel({ itens: [] }));
    await abrirDetalhe();
    expect(await screen.findByRole('button', { name: 'Cancelar NFC-e' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Transmitir agora' })).toBeNull();
  });
});

describe('o PDV diz quando é a próxima tentativa', () => {
  it('nota em nova tentativa: a frase traz a hora', async () => {
    api.getFiscalStatusForSale.mockResolvedValue({
      document: NOTA_NA_FILA,
      statusLabel: 'Aguardando transmissão',
      terminal: false,
      isTest: false,
      queue: {
        attempts: 2,
        nextAttemptAt: '2026-09-11T13:20:00.000Z',
        status: 'retry',
        errorMessage: 'Falha de rede ao contatar a SEFAZ.',
      },
    });
    render(
      <MemoryRouter>
        <PainelFiscalPdv saleId="sale-31" onDispensar={() => {}} onImprimir={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Nova tentativa automática às/)).toBeTruthy();
  });
});
