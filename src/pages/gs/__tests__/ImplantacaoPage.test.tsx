/**
 * Tela da conferência da implantação (GAP-PRD-013).
 *
 * O que não pode falhar:
 *
 * 1. O que BLOQUEIA vem primeiro e com o "como resolver" — é o que a pessoa
 *    veio procurar. Um bloqueio no fim de uma lista de OKs passa batido.
 * 2. O veredito geral é honesto: "NÃO VÁ AO AR ASSIM" quando algo bloqueia.
 * 3. A recusa do servidor (403 para quem não é do grupo) aparece como texto,
 *    não como tela vazia.
 * 4. "Conferir de novo" pergunta ao servidor de novo — é o gesto depois de
 *    mexer no `.env` e reiniciar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ImplantacaoPage from '../ImplantacaoPage';
import { respostaDaBarraDoShell } from './barraDoShell';

function conferencia(over: Record<string, unknown> = {}) {
  return {
    conferidoEm: '2026-09-11T13:00:00.000Z',
    pronto: false,
    resumo: { OK: 1, INFO: 1, ATENCAO: 1, BLOQUEIA: 1 },
    itens: [
      { id: 'ambiente', titulo: 'Ambiente', estado: 'OK', detalhe: 'DEVORA_API_ENV=production.' },
      {
        id: 'frontend',
        titulo: 'Telas',
        estado: 'INFO',
        detalhe: 'A API não serve as telas.',
        comoResolver: 'Exemplos em deploy/.',
      },
      {
        id: 'supervisor',
        titulo: 'Quem levanta a API se ela cair',
        estado: 'ATENCAO',
        detalhe: 'Ninguém: a API foi aberta à mão.',
        comoResolver: 'Rode deploy/windows/instalar-servico.ps1 como administrador.',
      },
      {
        id: 'variavel_aposentada',
        titulo: 'Variável aposentada presente',
        estado: 'BLOQUEIA',
        detalhe: 'DEVORA_DEV_QUICK_LOGIN ligada: o acesso sem senha foi removido, e em produção a API não sobe com ela.',
        comoResolver: 'Apague a linha DEVORA_DEV_QUICK_LOGIN do .env e reinicie.',
      },
    ],
    ...over,
  };
}

function servidor(responder: () => { status: number; corpo: unknown }) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      chamadas.push(String(url));
      const { status, corpo } = responder();
      return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <ImplantacaoPage />
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

describe('ImplantacaoPage', () => {
  it('pergunta à rota da conferência e diz que não é para ir ao ar quando algo bloqueia', async () => {
    const chamadas = servidor(() => ({ status: 200, corpo: conferencia() }));
    montar();
    expect(await screen.findByText('NÃO VÁ AO AR ASSIM')).toBeTruthy();
    expect(chamadas.some((c) => c.endsWith('/api/v1/system/implantacao'))).toBe(true);
  });

  it('o que bloqueia vem primeiro, com o como resolver; o OK não repete receita', async () => {
    servidor(() => ({ status: 200, corpo: conferencia() }));
    montar();
    await screen.findByText('NÃO VÁ AO AR ASSIM');
    const ordem = screen.getAllByTestId(/^item-/).map((el) => el.getAttribute('data-testid'));
    expect(ordem).toEqual(['item-variavel_aposentada', 'item-supervisor', 'item-frontend', 'item-ambiente']);
    expect(screen.getByText(/Apague a linha DEVORA_DEV_QUICK_LOGIN/)).toBeTruthy();
    expect(screen.getByText(/instalar-servico\.ps1/)).toBeTruthy();
  });

  it('sem bloqueio, o veredito muda', async () => {
    servidor(() => ({
      status: 200,
      corpo: conferencia({
        pronto: true,
        resumo: { OK: 1, INFO: 0, ATENCAO: 0, BLOQUEIA: 0 },
        itens: [{ id: 'ambiente', titulo: 'Ambiente', estado: 'OK', detalhe: 'DEVORA_API_ENV=production.' }],
      }),
    }));
    montar();
    expect(await screen.findByText('NADA BLOQUEIA')).toBeTruthy();
    expect(screen.getByText(/como produção deve ser/)).toBeTruthy();
  });

  it('a recusa do servidor aparece escrita, não como tela vazia', async () => {
    servidor(() => ({
      status: 403,
      corpo: { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada: system-readiness.view.' } },
    }));
    montar();
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/Permissão negada/);
  });

  it('"Conferir de novo" pergunta ao servidor outra vez', async () => {
    let vez = 0;
    const chamadas = servidor(() => {
      vez += 1;
      return {
        status: 200,
        corpo: vez === 1 ? conferencia() : conferencia({ pronto: true, resumo: { OK: 4, INFO: 0, ATENCAO: 0, BLOQUEIA: 0 } }),
      };
    });
    montar();
    await screen.findByText('NÃO VÁ AO AR ASSIM');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir de novo' }));
    await waitFor(() => expect(screen.getByText('NADA BLOQUEIA')).toBeTruthy());
    expect(chamadas.filter((c) => c.endsWith('/system/implantacao'))).toHaveLength(2);
  });
});
