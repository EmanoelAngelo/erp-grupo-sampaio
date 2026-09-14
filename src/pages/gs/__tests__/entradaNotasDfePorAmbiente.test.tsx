/**
 * A ENTRADA DE NOTAS MOSTRA O AMBIENTE ATUAL DA DISTRIBUIÇÃO DF-e — DFE-AMBIENTE.
 *
 * A SEFAZ numera homologação e produção à parte. O servidor passou a listar só
 * os documentos do ambiente fiscal atual e a dizer quantos do OUTRO ambiente
 * ficaram guardados fora da lista. A tela diz isso ao lado do quadro da SEFAZ:
 * sem o aviso, quem homologou com notas reais e virou para produção veria a
 * lista "sumir" sem saber por quê.
 *
 * ## Como fica vermelho
 *
 *  - tire o aviso e o primeiro caso não acha o texto;
 *  - mostre o aviso sempre e o segundo caso o acha sem haver o que dizer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const CHAVE = '5'.repeat(44);

let outroAmbiente: { ambiente: string; total: number } | null;

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
            nsu: '1',
            ambiente: 'production',
            schemaType: 'resNFe',
            accessKey: CHAVE,
            supplierCnpj: '14200166000187',
            supplierName: 'Fornecedor de Producao',
            totalCents: 10000,
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
        ambiente: 'production',
        outroAmbiente,
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
    'teste do DFE-AMBIENTE',
  );
}

async function montar() {
  render(
    <MemoryRouter>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findByText('Fornecedor de Producao');
}

beforeEach(() => {
  outroAmbiente = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrar();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do DFE-AMBIENTE');
  localStorage.clear();
});

describe('os documentos do outro ambiente ficam fora da lista, e a tela diz quantos', () => {
  it('em produção, com 3 documentos de homologação guardados: o aviso diz quantos e por quê', async () => {
    outroAmbiente = { ambiente: 'homologation', total: 3 };
    await montar();

    const aviso = await screen.findByText(/3 documento\(s\) da homologação ficam guardados fora desta lista/);
    expect(aviso.textContent).toMatch(/Mostrando os documentos da produção/);
    expect(aviso.textContent).toMatch(/não se manifesta nem se importa na produção/);
  });

  it('sem documento do outro ambiente, não há aviso', async () => {
    outroAmbiente = { ambiente: 'homologation', total: 0 };
    await montar();
    expect(screen.queryByText(/ficam guardados fora desta lista/)).toBeNull();
  });
});
