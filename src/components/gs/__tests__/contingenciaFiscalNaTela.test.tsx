/**
 * A CONTINGÊNCIA DA NFC-e NA TELA — GAP-PRD-098, a metade que só se prova na tela.
 *
 * Sem gesto em Fiscal › Documentos e sem instrução ao caixa: a contingência
 * era um estado no banco. Agora:
 *
 *  - o quadro mostra a modalidade (decisão do contador, gravada pelo dono) e
 *    não deixa ligar a off-line sem prazo; o gerente que tenta gravar lê que
 *    é dos donos;
 *  - com a off-line decidida, o gerente entra em contingência com
 *    justificativa (15+) e sai por um botão; o período aberto aparece com a
 *    última resposta da SEFAZ;
 *  - a NFC-e off-line tem "DANFCE de contingência" na lista, e o PDV instrui o
 *    caixa a entregá-lo;
 *  - o selo do balcão diz EM CONTINGÊNCIA.
 *
 * ## Como fica vermelho
 *
 *  - tire o quadro da página, o botão da lista ou a faixa do PDV, e o caso
 *    correspondente não acha o texto;
 *  - deixe gravar off-line sem prazo e o caso do botão preso falha.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContingenciaFiscalCard } from '@/components/gs/ContingenciaFiscal';
import { FiscalBadgePdv } from '@/components/gs/FiscalBadgePdv';
import { PainelFiscalPdv } from '@/components/gs/PainelFiscalPdv';
import FiscalDocumentosPage from '@/pages/gs/FiscalDocumentosPage';
import { ApiRequestError } from '@/lib/api/client';
import type { PainelDaContingencia } from '@/lib/api/contingenciaFiscal';

const api = vi.hoisted(() => ({
  painel: vi.fn(),
  gravarPolitica: vi.fn(),
  entrar: vi.fn(),
  sair: vi.fn(),
  listFiscalDocuments: vi.fn(),
  getFiscalStatusForSale: vi.fn(),
  getFiscalPdvSummary: vi.fn(),
}));

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/api/contingenciaFiscal', () => ({
  contingenciaFiscalApi: {
    painel: api.painel,
    gravarPolitica: api.gravarPolitica,
    entrar: api.entrar,
    sair: api.sair,
  },
}));

vi.mock('@/lib/api/filaFiscal', () => ({
  filaFiscalApi: {
    painel: () => Promise.reject(new ApiRequestError('API_PERMISSION_DENIED', 'negado', 403)),
    transmitirAgora: vi.fn(),
    transmitirPendentes: vi.fn(),
  },
}));

vi.mock('@/lib/api/core', () => ({
  coreApi: {
    listFiscalDocuments: api.listFiscalDocuments,
    getFiscalReconciliation: () => Promise.reject(new Error('sem permissão')),
    getFiscalDocument: () => Promise.resolve(null),
    getFiscalStatusForSale: api.getFiscalStatusForSale,
    getFiscalPdvSummary: api.getFiscalPdvSummary,
    getEmissionReadinessForSale: () => Promise.resolve({ canEmit: false, alreadyEmitted: true, reasons: [] }),
  },
}));

const PERIODO = {
  id: 'per-1',
  motivo: 'SEFAZ_UNAVAILABLE' as const,
  motivoRotulo: 'SEFAZ indisponível',
  justificativa: 'SEFAZ indisponivel: Servico Paralisado Momentaneamente',
  iniciadoEm: '2026-09-11T13:00:00.000Z',
  origem: 'AUTOMATICA' as const,
  iniciadoPor: null,
  codigoDoGatilho: '108',
  encerradoEm: null,
  origemDoEncerramento: null,
  encerradoPor: null,
  ultimaSondagemEm: '2026-09-11T13:10:00.000Z',
  ultimaSondagemCStat: '108',
  ultimaSondagemMotivo: 'Servico Paralisado Momentaneamente',
};

function painel(parcial: Partial<PainelDaContingencia> = {}): PainelDaContingencia {
  return {
    politica: { modo: 'AGUARDAR', prazoHoras: null, observacao: null, atualizadoEm: null, atualizadoPor: null },
    periodo: null,
    historico: [],
    notasOffline: { pendentes: 0, prazoMaisProximo: null },
    ...parcial,
  };
}

const OFFLINE = {
  politica: {
    modo: 'OFFLINE_NFCE' as const,
    prazoHoras: 24,
    observacao: null,
    atualizadoEm: '2026-09-10T12:00:00.000Z',
    atualizadoPor: 'dono',
  },
};

const NOTA_OFFLINE = {
  id: 'doc-off',
  model: '65',
  serie: 1,
  number: 40,
  // Posição 35 da chave = 9: emitida em contingência off-line.
  accessKey: '4326091122233300018165001000000040' + '9' + '000000404',
  environment: 'homologation',
  status: 'CONTINGENCY',
  protocol: null,
  cStat: null,
  xMotivo: null,
  saleId: 'sale-40',
  saleNumber: 40,
  customerName: null,
  recipientDocument: null,
  totalCents: 10_000,
  authorizedAt: null,
  createdAt: '2026-09-11T13:05:00.000Z',
};

beforeEach(() => {
  cleanup();
  Object.values(api).forEach((f) => f.mockReset());
});

afterEach(() => cleanup());

describe('o quadro da contingência', () => {
  it('sem decisão: diz que o contador ainda não decidiu, e off-line sem prazo não grava', async () => {
    api.painel.mockResolvedValue(painel());
    render(<ContingenciaFiscalCard />);

    expect(await screen.findByText(/ainda não decidida/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/NFC-e em contingência off-line/));
    const gravar = screen.getByRole('button', { name: 'Gravar modalidade' }) as HTMLButtonElement;
    expect(gravar.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Prazo de transmissão/), { target: { value: '24' } });
    await waitFor(() => expect(gravar.disabled).toBe(false));
    api.gravarPolitica.mockResolvedValue(painel(OFFLINE));
    fireEvent.click(gravar);
    await waitFor(() =>
      expect(api.gravarPolitica).toHaveBeenCalledWith({ modo: 'OFFLINE_NFCE', prazoHoras: 24, observacao: '' }),
    );
    expect(await screen.findByText('Modalidade gravada.')).toBeTruthy();
  });

  it('o gerente que tenta gravar lê que a modalidade é dos donos', async () => {
    api.painel.mockResolvedValue(painel());
    api.gravarPolitica.mockRejectedValue(new ApiRequestError('API_PERMISSION_DENIED', 'Permissão negada', 403));
    render(<ContingenciaFiscalCard />);
    fireEvent.click(await screen.findByLabelText(/NFC-e em contingência off-line/));
    fireEvent.change(screen.getByLabelText(/Prazo de transmissão/), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gravar modalidade' }));
    expect(await screen.findByText(/Só os donos do grupo gravam a modalidade/)).toBeTruthy();
  });

  it('com a off-line decidida: entrar exige a justificativa de 15+ e a manda ao servidor', async () => {
    api.painel.mockResolvedValue(painel(OFFLINE));
    api.entrar.mockResolvedValue(painel({ ...OFFLINE, periodo: { ...PERIODO, origem: 'MANUAL' } }));
    render(<ContingenciaFiscalCard />);

    const entrar = (await screen.findByRole('button', { name: 'Entrar em contingência' })) as HTMLButtonElement;
    expect(entrar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Justificativa para entrar em contingência/), {
      target: { value: 'Internet da loja caiu no temporal' },
    });
    await waitFor(() => expect(entrar.disabled).toBe(false));
    fireEvent.click(entrar);
    await waitFor(() => expect(api.entrar).toHaveBeenCalledWith('Internet da loja caiu no temporal'));
    expect(await screen.findByText(/EM CONTINGÊNCIA desde/)).toBeTruthy();
  });

  it('período aberto: mostra a última resposta da SEFAZ e sai pelo botão', async () => {
    api.painel.mockResolvedValue(painel({ ...OFFLINE, periodo: PERIODO, notasOffline: { pendentes: 2, prazoMaisProximo: '2026-09-12T13:05:00.000Z' } }));
    api.sair.mockResolvedValue(painel(OFFLINE));
    render(<ContingenciaFiscalCard />);

    expect(await screen.findByText(/EM CONTINGÊNCIA desde/)).toBeTruthy();
    expect(screen.getByText(/aberta automaticamente/)).toBeTruthy();
    expect(screen.getByText(/Última verificação da SEFAZ/)).toBeTruthy();
    expect(screen.getByText('2 NFC-e off-line pendente(s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar contingência' }));
    await waitFor(() => expect(api.sair).toHaveBeenCalled());
    expect(await screen.findByText('Fora de contingência.')).toBeTruthy();
  });

  it('o caixa (403) não vê o quadro', async () => {
    api.painel.mockRejectedValue(new ApiRequestError('API_PERMISSION_DENIED', 'negado', 403));
    const { container } = render(<ContingenciaFiscalCard />);
    await waitFor(() => expect(api.painel).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('a NFC-e off-line na lista, no PDV e no selo', () => {
  it('a lista oferece o DANFCE de contingência (e não "Prévia técnica")', async () => {
    api.painel.mockResolvedValue(painel(OFFLINE));
    api.listFiscalDocuments.mockResolvedValue([NOTA_OFFLINE]);
    render(
      <MemoryRouter>
        <FiscalDocumentosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'DANFCE de contingência' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prévia técnica' })).toBeNull();
    expect(await screen.findByText('Contingência da NFC-e')).toBeTruthy();
  });

  it('o PDV instrui o caixa a entregar o DANFCE de contingência', async () => {
    api.getFiscalStatusForSale.mockResolvedValue({
      document: NOTA_OFFLINE,
      statusLabel: 'Emitida em contingência (off-line) — pendente de autorização',
      terminal: false,
      isTest: false,
      queue: { attempts: 0, nextAttemptAt: null, status: 'pending', errorMessage: null },
      contingencia: { offline: true, pendente: true, prazoDeTransmissao: '2026-09-12T13:05:00.000Z' },
    });
    render(
      <MemoryRouter>
        <PainelFiscalPdv saleId="sale-40" onDispensar={() => {}} onImprimir={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('EMITIDA EM CONTINGÊNCIA')).toBeTruthy();
    expect(screen.getByText(/Entregue ao cliente o DANFCE de contingência/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'DANFCE de contingência' })).toBeTruthy();
  });

  it('o selo do balcão diz EM CONTINGÊNCIA', async () => {
    api.getFiscalPdvSummary.mockResolvedValue({
      situacao: 'TEST_ONLY',
      readiness: 'READY_FOR_SEFAZ_HOMOLOGATION',
      canEmit: true,
      blocking: [],
      pendencies: [],
      pendencyCount: 0,
      contingencia: { iniciadoEm: PERIODO.iniciadoEm, motivoRotulo: 'SEFAZ indisponível', origem: 'AUTOMATICA' },
    });
    render(
      <MemoryRouter>
        <FiscalBadgePdv />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/EM CONTINGÊNCIA — entregue o DANFCE de contingência/)).toBeTruthy();
  });
});
