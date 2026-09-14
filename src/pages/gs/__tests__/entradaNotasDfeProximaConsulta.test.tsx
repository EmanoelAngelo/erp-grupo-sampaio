/**
 * O BOTÃO DA SEFAZ DIZ QUANDO PODE BUSCAR DE NOVO (R3-DFE, GAP-PRD-168).
 *
 * A regra do Ambiente Nacional: em dia (cStat 137, ou ultNSU = maxNSU), a
 * próxima consulta só depois de uma hora — consultar antes é consumo indevido
 * (cStat 656) e bloqueia o CNPJ por uma hora. O servidor guarda a espera e a
 * manda junto com a lista; a Entrada de Notas mostra a hora no botão, em vez
 * de deixar clicar para tomar a recusa.
 *
 * ## Como fica vermelho
 *
 *  - ignore `distribuicao` e o botão continua "Buscar agora", habilitado;
 *  - mostre a espera sempre e o terceiro caso acha o botão desabilitado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';
import { respostaDaBarraDoShell } from './barraDoShell';

let distribuicao: Record<string, unknown> | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request) => {
    const barra = respostaDaBarraDoShell(url);
    if (barra) return barra;
    const alvo = String(url);
    if (alvo.endsWith('/purchases/dfe')) {
      return json({
        items: [
          {
            nsu: '25',
            ambiente: 'homologation',
            schemaType: 'resNFe',
            accessKey: '5'.repeat(44),
            supplierCnpj: '14200166000187',
            supplierName: 'Fornecedor do Cursor',
            totalCents: 1000,
            issuedAt: '2026-09-10T10:00:00-03:00',
            manifestStatus: null,
            manifestProtocol: null,
            manifestedAt: null,
            importedNoteId: null,
            noteStatus: null,
            temXmlCompleto: false,
            receivedAt: '2026-09-10T13:00:00.000Z',
          },
        ],
        plano: null,
        ambiente: 'homologation',
        outroAmbiente: { ambiente: 'production', total: 0 },
        distribuicao,
      });
    }
    return json({ items: [] });
  });
}

function entrar() {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste do cursor da DF-e',
  );
}

async function montar() {
  render(
    <MemoryRouter>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findByText('Fornecedor do Cursor');
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

beforeEach(() => {
  distribuicao = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrar();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do cursor da DF-e');
  localStorage.clear();
});

describe('a espera da SEFAZ aparece no botão', () => {
  it('em dia: o botão diz a hora da próxima busca, fica desabilitado, e o quadro explica por quê', async () => {
    const proxima = new Date(Date.now() + 45 * 60_000).toISOString();
    distribuicao = { ultimoNsu: 25, maxNsu: 25, ultimoCStat: '137', proximaConsultaEm: proxima, motivoDaEspera: 'em_dia' };
    await montar();

    const botao = await screen.findByRole('button', { name: `Buscar às ${hora(proxima)}` });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    const aviso = await screen.findByText(/A SEFAZ já entregou tudo/);
    expect(aviso.textContent).toContain(hora(proxima));
    expect(aviso.textContent).toMatch(/656/);
  });

  it('bloqueado por consumo indevido: o botão diz até quando e o quadro diz que foi a SEFAZ', async () => {
    const ate = new Date(Date.now() + 50 * 60_000).toISOString();
    distribuicao = { ultimoNsu: 3, maxNsu: 9, ultimoCStat: '656', proximaConsultaEm: ate, motivoDaEspera: 'consumo_indevido' };
    await montar();

    const botao = await screen.findByRole('button', { name: `Buscar às ${hora(ate)}` });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    const aviso = await screen.findByText(/consumo indevido/);
    expect(aviso.textContent).toContain(hora(ate));
  });

  it('sem espera (ou já vencida): Buscar agora, habilitado, e nenhum aviso', async () => {
    distribuicao = {
      ultimoNsu: 25,
      maxNsu: 25,
      ultimoCStat: '137',
      proximaConsultaEm: new Date(Date.now() - 60_000).toISOString(),
      motivoDaEspera: 'em_dia',
    };
    await montar();

    const botao = await screen.findByRole('button', { name: 'Buscar agora' });
    expect((botao as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/A SEFAZ já entregou tudo/)).toBeNull();
  });
});
