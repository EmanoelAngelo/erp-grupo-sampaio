/**
 * OS ATOS COM A SEFAZ NA TELA — GAP-PRD-005, a metade que só se prova na tela.
 *
 * A tela não tinha como chegar à SEFAZ: mandava `developmentMode: true` e não
 * tinha onde digitar a senha do certificado. Agora ela PERGUNTA ao servidor
 * como o ato vai sair (`/fiscal/acts/plan`) e mostra isso antes do botão:
 *
 *  - SEFAZ, com o ambiente — e a senha do A1 quando a política do dono pede
 *    (ou quando o cofre não tem a senha selada); o botão só libera com ela;
 *  - SIMULADOR, para nota de ensaio, dito "sem valor fiscal";
 *  - BLOQUEADO, com o motivo — e o botão não libera.
 *
 * E o dono escolhe, na tela do certificado, entre o cofre e a senha digitada.
 *
 * ## Como fica vermelho
 *
 *  - tire o quadro do diálogo e os casos que procuram "Vai à SEFAZ" falham;
 *  - ignore `podeEnviarAtoFiscal` no botão e o caso BLOQUEADO/OBRIGATORIA
 *    deixa o botão habilitado;
 *  - esqueça a senha no envio e o `cancelFiscalDocument` sai sem ela.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FiscalDocumentosPage from '../FiscalDocumentosPage';
import FiscalInutilizacoesPage from '../FiscalInutilizacoesPage';
import { PoliticaDosAtosFiscaisCard } from '@/components/gs/PoliticaDosAtosFiscais';
import type { PlanoDoAtoFiscal } from '@/lib/api/fiscalAtos';

const NOTA = {
  id: 'doc-real',
  model: '65',
  serie: 1,
  number: 7,
  accessKey: '43260911222333000181650010000000071000000070',
  environment: 'homologation',
  status: 'AUTHORIZED',
  protocol: '143260000000071',
  cStat: '100',
  xMotivo: 'Autorizado o uso da NF-e',
  saleId: 'sale-1',
  saleNumber: 7,
  customerName: null,
  recipientDocument: null,
  totalCents: 12_990,
  authorizedAt: '2026-09-10T15:00:00.000Z',
  createdAt: '2026-09-10T15:00:00.000Z',
};

const POLITICA = { exigirSenhaDigitada: false, atualizadoEm: null, atualizadoPor: null };

function plano(parcial: Partial<PlanoDoAtoFiscal>): PlanoDoAtoFiscal {
  return {
    caminho: 'SEFAZ',
    ambiente: 'homologation',
    senha: 'OPCIONAL',
    cofre: 'SELADO',
    codigo: null,
    motivo: 'Vai à SEFAZ (homologação) com o certificado A1 do cofre desta operação.',
    politica: POLITICA,
    ...parcial,
  };
}

const api = vi.hoisted(() => ({
  cancelFiscalDocument: vi.fn(),
  createVoidRange: vi.fn(),
  plano: vi.fn(),
  gravarPolitica: vi.fn(),
}));

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/api/core', () => ({
  coreApi: {
    listFiscalDocuments: () => Promise.resolve([NOTA]),
    getFiscalReconciliation: () => Promise.reject(new Error('sem permissão')),
    getFiscalDocument: () => Promise.resolve({ document: NOTA, events: [] }),
    cancelFiscalDocument: api.cancelFiscalDocument,
    getCorrectionLetterNotice: () => Promise.resolve('aviso'),
    listVoidRanges: () => Promise.resolve([]),
    createVoidRange: api.createVoidRange,
  },
}));

vi.mock('@/lib/api/fiscalAtos', () => ({
  fiscalAtosApi: { plano: api.plano, gravarPolitica: api.gravarPolitica },
}));

async function abrirCancelamento() {
  render(
    <MemoryRouter>
      <FiscalDocumentosPage />
    </MemoryRouter>,
  );
  const linha = (await screen.findByText('NFC-e 7/1')).closest('tr')!;
  fireEvent.click(linha.querySelector('button')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancelar NFC-e' }));
  fireEvent.change(screen.getByLabelText(/Justificativa/), {
    target: { value: 'Venda digitada em duplicidade no caixa' },
  });
}

function botaoConfirmar(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Confirmar cancelamento' }) as HTMLButtonElement;
}

beforeEach(() => {
  cleanup();
  api.cancelFiscalDocument.mockReset().mockResolvedValue({
    document: { ...NOTA, status: 'CANCELLED' },
    accepted: true,
    eventId: 'ev-1',
    cStat: '135',
    xMotivo: 'Evento registrado',
    protocol: '143260000000500',
  });
  api.createVoidRange.mockReset().mockResolvedValue({
    accepted: true,
    eventId: 'ev-2',
    cStat: '102',
    xMotivo: 'Inutilizacao homologada',
    protocol: '143260000000777',
  });
  api.plano.mockReset();
  api.gravarPolitica.mockReset();
});

describe('o cancelamento diz para onde vai, e leva a senha quando é pedida', () => {
  it('SEFAZ pelo cofre: mostra o destino, a senha é opcional, e o pedido sai sem ela', async () => {
    api.plano.mockResolvedValue(plano({}));
    await abrirCancelamento();

    expect(await screen.findByText('Vai à SEFAZ (homologação — sem valor fiscal).')).toBeTruthy();
    expect(api.plano).toHaveBeenCalledWith('doc-real');
    await waitFor(() => expect(botaoConfirmar().disabled).toBe(false));

    fireEvent.click(botaoConfirmar());
    await waitFor(() =>
      expect(api.cancelFiscalDocument).toHaveBeenCalledWith(
        'doc-real',
        'Venda digitada em duplicidade no caixa',
        undefined,
      ),
    );
    expect(await screen.findByText(/Nota cancelada. Protocolo do evento: 143260000000500/)).toBeTruthy();
  });

  it('senha OBRIGATÓRIA: o botão só libera com ela, e ela vai no pedido', async () => {
    api.plano.mockResolvedValue(
      plano({
        senha: 'OBRIGATORIA',
        motivo: 'Vai à SEFAZ (homologação). A política desta operação exige a senha do certificado a cada ato.',
        politica: { ...POLITICA, exigirSenhaDigitada: true },
      }),
    );
    await abrirCancelamento();

    const senha = await screen.findByLabelText(/Senha do certificado A1/);
    expect(botaoConfirmar().disabled).toBe(true);

    fireEvent.change(senha, { target: { value: 'senha-do-a1' } });
    await waitFor(() => expect(botaoConfirmar().disabled).toBe(false));
    fireEvent.click(botaoConfirmar());
    await waitFor(() =>
      expect(api.cancelFiscalDocument).toHaveBeenCalledWith(
        'doc-real',
        'Venda digitada em duplicidade no caixa',
        'senha-do-a1',
      ),
    );
  });

  it('BLOQUEADO: o motivo aparece e o botão não libera', async () => {
    api.plano.mockResolvedValue(
      plano({
        caminho: 'BLOQUEADO',
        senha: 'NAO_SE_APLICA',
        cofre: 'AUSENTE',
        codigo: 'CORE_SEFAZ_CERTIFICATE_MISSING',
        motivo: 'Este ato vai à SEFAZ (homologação) e precisa do certificado A1 da operação, que não está no cofre. Envie o .pfx em Fiscal › Certificado.',
      }),
    );
    await abrirCancelamento();

    expect(await screen.findByText(/não está no cofre/)).toBeTruthy();
    expect(screen.getByText('Este ato não pode sair agora.')).toBeTruthy();
    expect(botaoConfirmar().disabled).toBe(true);
    expect(screen.queryByLabelText(/Senha do certificado A1/)).toBeNull();
  });

  it('SIMULADOR: a nota de ensaio é dita sem valor fiscal', async () => {
    api.plano.mockResolvedValue(
      plano({
        caminho: 'SIMULADOR',
        senha: 'NAO_SE_APLICA',
        motivo: 'Esta nota foi autorizada pelo simulador: o ato também será simulado, sem valor fiscal.',
      }),
    );
    await abrirCancelamento();
    expect(await screen.findByText('Simulador — sem valor fiscal.')).toBeTruthy();
    await waitFor(() => expect(botaoConfirmar().disabled).toBe(false));
  });
});

describe('a inutilização pergunta o plano da operação', () => {
  it('mostra o destino, pede a senha quando o cofre não a tem, e a leva no pedido com o ano', async () => {
    api.plano.mockResolvedValue(
      plano({
        senha: 'OBRIGATORIA',
        cofre: 'SEM_SENHA_SELADA',
        motivo: 'Vai à SEFAZ (homologação). O certificado foi guardado sem a senha selada: digite a senha.',
      }),
    );
    render(
      <MemoryRouter>
        <FiscalInutilizacoesPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Nova inutilização' }));
    await waitFor(() => expect(api.plano).toHaveBeenCalledWith(null));

    fireEvent.change(screen.getByLabelText(/Número inicial/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Número final/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/^Justificativa/), {
      target: { value: 'Queda de energia no meio da emissao' },
    });

    const revisar = screen.getByRole('button', { name: 'Revisar e confirmar' }) as HTMLButtonElement;
    expect(await screen.findByText(/sem a senha selada/)).toBeTruthy();
    expect(revisar.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Senha do certificado A1/), { target: { value: 'senha-do-a1' } });
    await waitFor(() => expect(revisar.disabled).toBe(false));
    fireEvent.click(revisar);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar e inutilizar' }));

    await waitFor(() => expect(api.createVoidRange).toHaveBeenCalled());
    expect(api.createVoidRange.mock.calls[0][0]).toMatchObject({
      model: '55',
      from: 10,
      to: 12,
      year: new Date().getFullYear(),
      certificatePassword: 'senha-do-a1',
    });
  });
});

describe('o dono escolhe entre o cofre e a senha digitada', () => {
  it('mostra a escolha atual e grava a nova', async () => {
    api.plano.mockResolvedValue(plano({}));
    api.gravarPolitica.mockResolvedValue({ ...POLITICA, exigirSenhaDigitada: true });
    render(<PoliticaDosAtosFiscaisCard />);

    const cofre = (await screen.findByLabelText(/Usar o certificado do cofre/)) as HTMLInputElement;
    expect(cofre.checked).toBe(true);
    const gravar = screen.getByRole('button', { name: 'Gravar escolha' }) as HTMLButtonElement;
    expect(gravar.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/Pedir a senha do certificado a cada ato/));
    await waitFor(() => expect(gravar.disabled).toBe(false));
    fireEvent.click(gravar);
    await waitFor(() => expect(api.gravarPolitica).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/passam a pedir a senha do certificado/)).toBeTruthy();
  });
});
