/**
 * A TELA DA FILA MOSTRA DE QUEM SÃO AS CONTAGENS, E NÃO OFERECE O QUE O
 * SERVIDOR FECHA — GAP-PRD-136.
 *
 * O servidor devolve `escopo` e `acoes` em `GET /core/sync/status`. O gerente
 * da loja vê a fila da SUA operação e não recebe o botão da carga inicial (que
 * é do nó inteiro); o gerente da oficina também não recebe "Conferir schema" e
 * "Tentar novamente" (rotas do gerente de loja). Quem responde pelo grupo vê o
 * nó e os botões todos. Servidor antigo (sem `acoes`) continua como sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SincronizacaoPage from '../SincronizacaoPage';

function status(extra: Record<string, unknown>) {
  return {
    readiness: 'SYNC_READY',
    missing: [],
    transport: 'supabase',
    isTestTransport: false,
    centralSchemaCheckedAt: '2026-08-14T12:00:00.000Z',
    bootstrapCompletedAt: '2026-08-14T12:05:00.000Z',
    workerRunning: true,
    outbox: {
      nodeId: 'no-loja',
      pending: 1,
      processing: 0,
      retry: 0,
      synced: 3,
      dead: 2,
      oldestPendingAt: null,
      lastSyncedAt: null,
      lastSyncedEventType: null,
      lastError: null,
      lagSeconds: null,
    },
    ...extra,
  };
}

function servidor(corpo: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function montar() {
  render(
    <MemoryRouter>
      <SincronizacaoPage />
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

describe('escopo da operação', () => {
  it('gerente de loja: diz que as contagens são desta operação e não oferece a carga inicial', async () => {
    servidor(
      status({
        escopo: 'operacao',
        acoes: { cargaInicial: false, conferirSchema: true, reviver: true, sincronizar: true },
      }),
    );
    montar();
    await screen.findByText('SINCRONIZANDO');
    expect(screen.getByTestId('sync-escopo').textContent).toMatch(/desta operação/);
    expect(screen.queryByRole('button', { name: 'Carga inicial' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Conferir schema' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('gerente da oficina: sem "Conferir schema" e sem "Tentar novamente", e a tela diz a quem pedir', async () => {
    servidor(
      status({
        escopo: 'operacao',
        acoes: { cargaInicial: false, conferirSchema: false, reviver: false, sincronizar: true },
      }),
    );
    montar();
    await screen.findByText('SINCRONIZANDO');
    expect(screen.queryByRole('button', { name: 'Conferir schema' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    expect(screen.getByText(/Quem devolve à fila é o gerente da loja/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sincronizar agora' })).toBeTruthy();
  });

  it('quem responde pelo grupo: sem aviso de recorte e com todos os botões', async () => {
    servidor(
      status({
        escopo: 'no',
        acoes: { cargaInicial: true, conferirSchema: true, reviver: true, sincronizar: true },
      }),
    );
    montar();
    await screen.findByText('SINCRONIZANDO');
    expect(screen.queryByTestId('sync-escopo')).toBeNull();
    expect(screen.getByRole('button', { name: 'Carga inicial' })).toBeTruthy();
  });

  it('servidor anterior (sem acoes): oferece o que sempre ofereceu', async () => {
    servidor(status({}));
    montar();
    await screen.findByText('SINCRONIZANDO');
    expect(screen.getByRole('button', { name: 'Carga inicial' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conferir schema' })).toBeTruthy();
  });
});
