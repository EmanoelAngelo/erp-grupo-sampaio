/**
 * QUEM RECUSOU A NOTA — GAP-PRD-097, a metade que só se prova na tela.
 *
 * O servidor passou a recusar localmente o que antes só a SEFAZ recusava: XML
 * fora do leiaute oficial (XSD), mal formado, ou assinado que não passou na
 * autoconferência. O motivo cai em `xMotivo`, sem cStat — o documento nem
 * chegou ao fisco. A tela chamava QUALQUER motivo de "Retorno da SEFAZ":
 * quem lesse iria procurar o problema no portal, onde ele não existe.
 *
 * ## Como fica vermelho
 *
 *  - volte o rótulo fixo "Retorno da SEFAZ:" e o primeiro caso falha;
 *  - troque a condição por `status === 'ERROR'` e o segundo caso (rejeição da
 *    SEFAZ, com cStat) passa a dizer "conferência local" — falha.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FiscalDocumentosPage from '../FiscalDocumentosPage';

const base = {
  model: '65',
  serie: 1,
  accessKey: '43260911222333000181650010000000071000000070',
  environment: 'homologation',
  protocol: null,
  saleId: 'sale-1',
  saleNumber: 7,
  customerName: null,
  recipientDocument: null,
  totalCents: 12_990,
  authorizedAt: null,
  createdAt: '2026-09-10T15:00:00.000Z',
};

const LOCAL = {
  ...base,
  id: 'doc-local',
  number: 7,
  status: 'ERROR',
  cStat: null,
  xMotivo:
    "Fora do leiaute oficial (PL_010b_V1.30): Element 'indTot': [facet 'enumeration'] The value '7' is not an element of the set {'0', '1'}.",
};

const SEFAZ = {
  ...base,
  id: 'doc-sefaz',
  number: 8,
  status: 'REJECTED',
  cStat: '539',
  xMotivo: 'Rejeição: Duplicidade de NF-e, com diferença na Chave de Acesso',
};

let documentos: Record<string, typeof LOCAL | typeof SEFAZ>;

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/api/core', () => ({
  coreApi: {
    listFiscalDocuments: () => Promise.resolve(Object.values(documentos)),
    getFiscalReconciliation: () => Promise.reject(new Error('sem permissão')),
    getFiscalDocument: (id: string) => Promise.resolve({ document: documentos[id], events: [] }),
  },
}));

async function abrirDetalhe(numero: string) {
  render(
    <MemoryRouter>
      <FiscalDocumentosPage />
    </MemoryRouter>,
  );
  const linha = (await screen.findByText(numero)).closest('tr')!;
  fireEvent.click(linha.querySelector('button')!);
}

beforeEach(() => {
  cleanup();
  documentos = { [LOCAL.id]: LOCAL, [SEFAZ.id]: SEFAZ };
});

describe('o detalhe diz quem recusou', () => {
  it('recusa da conferência local (sem cStat) NÃO é apresentada como retorno da SEFAZ', async () => {
    await abrirDetalhe('NFC-e 7/1');
    await waitFor(() =>
      expect(screen.getByText('Recusado na conferência local, antes da SEFAZ:')).toBeTruthy(),
    );
    expect(screen.getByText(/Fora do leiaute oficial \(PL_010b_V1\.30\)/)).toBeTruthy();
    expect(screen.queryByText('Retorno da SEFAZ:')).toBeNull();
  });

  it('rejeição da SEFAZ (com cStat) continua sendo retorno da SEFAZ', async () => {
    await abrirDetalhe('NFC-e 8/1');
    await waitFor(() => expect(screen.getByText('Retorno da SEFAZ:')).toBeTruthy());
    expect(screen.getByText(/Duplicidade de NF-e/)).toBeTruthy();
    expect(screen.queryByText('Recusado na conferência local, antes da SEFAZ:')).toBeNull();
  });
});
