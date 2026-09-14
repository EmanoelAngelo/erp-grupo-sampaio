/**
 * Tela do estado do backup (GAP-PRD-011, GAP-PRD-068).
 *
 * O que não pode falhar:
 *
 * 1. A tela pergunta à rota de estado de verdade e mostra o veredito geral:
 *    FALHOU quando alguma etapa falhou — nunca "em dia" por omissão.
 * 2. O que FALHOU vem primeiro, com o motivo e o como resolver; o PRONTO não
 *    repete receita.
 * 3. Backup no mesmo disco do banco aparece como PENDENTE, com o
 *    DEVORA_BACKUP_DIR como saída (GAP-PRD-068).
 * 4. "Conferir o bucket agora" só aparece com cópia remota configurada, faz
 *    o POST e mostra o que achou.
 * 5. As falhas dos últimos 30 dias aparecem com a data e o motivo.
 * 6. A recusa do servidor (403) aparece escrita, não como tela vazia.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BackupPage from '../BackupPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const FALHA = {
  id: 'exec-2',
  gatilho: 'agenda',
  iniciadoEm: '2026-09-11T06:00:00.000Z',
  terminadoEm: '2026-09-11T06:00:03.000Z',
  local: { estado: 'ok', arquivo: 'grupo-sampaio-2026-09-11T06-00-00-000Z-diario.db', bytes: 5_200_000, detalhe: null, mesmoDisco: true },
  remoto: { estado: 'falhou', objeto: null, detalhe: 'O bucket recusou o envio (HTTP 401).' },
  uploads: { estado: 'sem_mudanca', arquivos: 12, enviados: 0, bytes: 900_000, manifesto: null, detalhe: null },
};

function estado(over: Record<string, unknown> = {}) {
  return {
    conferidoEm: '2026-09-11T13:00:00.000Z',
    geral: 'FALHOU',
    itens: [
      {
        id: 'copia_local',
        titulo: 'Cópia diária do banco',
        estado: 'PRONTO',
        quando: '2026-09-11T06:00:00.000Z',
        detalhe: 'grupo-sampaio-2026-09-11T06-00-00-000Z-diario.db (5,0 MB).',
      },
      {
        id: 'outro_disco',
        titulo: 'Backup em outro disco',
        estado: 'PENDENTE',
        quando: null,
        detalhe: 'A pasta C:/sistema/server/data/backups está no MESMO disco do banco.',
        comoResolver: 'Aponte DEVORA_BACKUP_DIR para outro disco (ex.: DEVORA_BACKUP_DIR=E:/backups-grupo-sampaio) e reinicie.',
      },
      {
        id: 'copia_remota',
        titulo: 'Cópia fora deste computador (bucket)',
        estado: 'FALHOU',
        quando: '2026-09-11T06:00:00.000Z',
        detalhe: 'O último envio ao bucket falhou: O bucket recusou o envio (HTTP 401).',
        comoResolver: 'HTTP 401/403: a chave do .env não vale mais.',
      },
      {
        id: 'fotos',
        titulo: 'Fotos e logos (uploads)',
        estado: 'PRONTO',
        quando: '2026-09-10T06:00:00.000Z',
        detalhe: '12 arquivo(s) no bucket.',
        comoResolver: 'não deveria aparecer',
      },
      {
        id: 'bucket_conferido',
        titulo: 'Bucket conferido',
        estado: 'PENDENTE',
        quando: null,
        detalhe: 'Ninguém conferiu ainda se as cópias estão mesmo lá.',
        comoResolver: 'Clique em "Conferir o bucket agora".',
      },
    ],
    local: {
      pasta: 'C:/sistema/server/data/backups',
      mesmoDiscoDoBanco: true,
      bancoDescartavel: false,
      quantidade: 9,
      bytes: 47_000_000,
      ultimo: { arquivo: 'grupo-sampaio-2026-09-11T06-00-00-000Z-diario.db', bytes: 5_200_000, criadoEm: '2026-09-11T06:00:00.000Z', motivo: 'diario' },
    },
    remoto: { configurado: true, bucket: 'backups' },
    fotos: { arquivos: 12, bytes: 900_000, ultimoConjunto: null },
    bucket: null,
    agenda: { hora: 3, proxima: '2026-09-12T06:00:00.000Z' },
    execucoes: [FALHA],
    falhas: [FALHA],
    ...over,
  };
}

type Pedido = { method?: string };

function servidor(responder: (url: string, init?: Pedido) => { status: number; corpo: unknown }) {
  const chamadas: Array<{ url: string; metodo: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: Pedido) => {
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      chamadas.push({ url: String(url), metodo: init?.method ?? 'GET' });
      const { status, corpo } = responder(String(url), init);
      return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <BackupPage />
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

describe('BackupPage', () => {
  it('pergunta à rota de estado e diz que o backup tem falha quando uma etapa falhou', async () => {
    const chamadas = servidor(() => ({ status: 200, corpo: estado() }));
    montar();
    expect(await screen.findByText('O BACKUP TEM FALHA')).toBeTruthy();
    expect(chamadas.some((c) => c.url.endsWith('/api/v1/system/backup/status'))).toBe(true);
    expect(screen.getByText(/todo dia às 03:00/)).toBeTruthy();
  });

  it('o que FALHOU vem primeiro, com motivo e como resolver; o PRONTO não repete receita', async () => {
    servidor(() => ({ status: 200, corpo: estado() }));
    montar();
    await screen.findByText('O BACKUP TEM FALHA');
    const ordem = screen.getAllByTestId(/^item-/).map((el) => el.getAttribute('data-testid'));
    expect(ordem[0]).toBe('item-copia_remota');
    expect(ordem.slice(-2).sort()).toEqual(['item-copia_local', 'item-fotos']);
    expect(screen.getAllByText(/HTTP 401/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/não deveria aparecer/)).toBeNull();
  });

  it('backup no mesmo disco do banco: PENDENTE, com o DEVORA_BACKUP_DIR como saída (GAP-PRD-068)', async () => {
    servidor(() => ({ status: 200, corpo: estado() }));
    montar();
    await screen.findByText('O BACKUP TEM FALHA');
    const item = screen.getByTestId('item-outro_disco');
    expect(item.textContent).toMatch(/PENDENTE/);
    expect(item.textContent).toMatch(/MESMO disco/);
    expect(item.textContent).toMatch(/DEVORA_BACKUP_DIR=E:/);
  });

  it('as falhas dos últimos 30 dias aparecem com o motivo, e as execuções em tabela', async () => {
    servidor(() => ({ status: 200, corpo: estado() }));
    montar();
    await screen.findByText('O BACKUP TEM FALHA');
    const falhas = screen.getByRole('region', { name: 'Falhas dos últimos 30 dias' });
    expect(falhas.textContent).toMatch(/Envio ao bucket: O bucket recusou o envio \(HTTP 401\)/);
    const execucoes = screen.getByRole('region', { name: 'Últimas execuções do diário' });
    expect(execucoes.textContent).toMatch(/agendada/);
    expect(execucoes.textContent).toMatch(/sem mudança/);
  });

  it('"Conferir o bucket agora" faz o POST e mostra o que achou', async () => {
    const chamadas = servidor((url, init) => {
      if (url.endsWith('/system/backup/conferir-bucket') && init?.method === 'POST') {
        return {
          status: 200,
          corpo: {
            conferencia: {
              conferidoEm: '2026-09-11T13:05:00.000Z',
              ok: false,
              motivo: '1 foto(s) do último conjunto não estão no bucket',
              bancos: 14,
              ultimoBanco: null,
              ultimoEnvioPresente: true,
              manifesto: 'uploads/manifesto-x.json',
              fotosNoManifesto: 12,
              objetosFaltando: 1,
            },
            estado: estado(),
          },
        };
      }
      return { status: 200, corpo: estado() };
    });
    montar();
    await screen.findByText('O BACKUP TEM FALHA');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir o bucket agora' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/1 foto\(s\) do último conjunto não estão no bucket/);
    expect(chamadas.some((c) => c.url.endsWith('/system/backup/conferir-bucket') && c.metodo === 'POST')).toBe(true);
  });

  it('sem cópia remota configurada, não oferece conferir o bucket', async () => {
    servidor(() => ({
      status: 200,
      corpo: estado({ geral: 'PENDENTE', remoto: { configurado: false, bucket: null }, falhas: [], execucoes: [] }),
    }));
    montar();
    expect(await screen.findByText('BACKUP INCOMPLETO')).toBeTruthy();
    expect(screen.getByText(/sem cópia remota/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conferir o bucket agora' })).toBeNull();
  });

  it('tudo em dia: o veredito diz', async () => {
    servidor(() => ({
      status: 200,
      corpo: estado({
        geral: 'PRONTO',
        itens: [{ id: 'copia_local', titulo: 'Cópia diária do banco', estado: 'PRONTO', quando: null, detalhe: 'ok' }],
        falhas: [],
      }),
    }));
    montar();
    expect(await screen.findByText('BACKUP EM DIA')).toBeTruthy();
  });

  it('a recusa do servidor aparece escrita, não como tela vazia', async () => {
    servidor(() => ({
      status: 403,
      corpo: { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada: system-backup.view.' } },
    }));
    montar();
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/Permissão negada/);
  });

  it('"Atualizar" pergunta ao servidor outra vez', async () => {
    let vez = 0;
    const chamadas = servidor(() => {
      vez += 1;
      return { status: 200, corpo: vez === 1 ? estado() : estado({ geral: 'PRONTO', itens: [], falhas: [] }) };
    });
    montar();
    await screen.findByText('O BACKUP TEM FALHA');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(screen.getByText('BACKUP EM DIA')).toBeTruthy());
    expect(chamadas.filter((c) => c.url.endsWith('/system/backup/status'))).toHaveLength(2);
  });
});
