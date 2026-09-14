/**
 * Tela da sincronização com o banco central.
 *
 * O que não pode falhar:
 *
 * 1. Os estados são DISTINTOS e honestos. "Tem credencial" não é "tem schema",
 *    e nenhum deles é "os dados batem". Um rótulo único tipo ONLINE esconderia
 *    exatamente a pergunta que o gestor precisa fazer.
 * 2. Atraso aparece em palavras. "Central 2 horas atrasada" é acionável;
 *    "pendentes: 340" sozinho não é.
 * 3. Evento parado (dead) não fica escondido — ele exige uma pessoa.
 * 4. A credencial não aparece na tela em hipótese nenhuma.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SincronizacaoPage from '../SincronizacaoPage';

function status(over: Record<string, unknown> = {}, outbox: Record<string, unknown> = {}) {
  return {
    readiness: 'SYNC_READY',
    missing: [],
    transport: 'supabase',
    isTestTransport: false,
    centralSchemaCheckedAt: '2026-08-14T12:00:00.000Z',
    bootstrapCompletedAt: '2026-08-14T12:05:00.000Z',
    ...over,
    outbox: {
      nodeId: 'no-loja-centro',
      pending: 0,
      processing: 0,
      retry: 0,
      synced: 120,
      dead: 0,
      oldestPendingAt: null,
      lastSyncedAt: '2026-08-14T13:00:00.000Z',
      lastSyncedEventType: 'sale.registered',
      lastError: null,
      lagSeconds: null,
      ...outbox,
    },
  };
}

function servidor(rotas: Record<string, () => unknown>) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const alvo = String(url);
      chamadas.push(`${(init?.method ?? 'GET').toUpperCase()} ${alvo}`);
      for (const [padrao, responder] of Object.entries(rotas)) {
        if (alvo.includes(padrao)) {
          return new Response(JSON.stringify(responder()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
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

describe('estados honestos', () => {
  it('sem credencial: nomeia as variáveis que faltam', async () => {
    servidor({
      '/core/sync/status': () =>
        status(
          {
            readiness: 'READY_FOR_CREDENTIAL',
            missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
            transport: 'none',
          },
          { pending: 42 },
        ),
    });
    montar();

    await screen.findByText('AGUARDANDO CREDENCIAL');
    expect(screen.getByText(/SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY/)).toBeTruthy();
    expect(screen.getByText(/chave publicável usada pelo navegador não serve/)).toBeTruthy();
    // Não convida para uma ação que vai falhar.
    expect(
      (screen.getByRole('button', { name: 'Sincronizar agora' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('sem credencial: diz que o servidor relê o .env e NÃO precisa reiniciar (GAP-PRD-065)', async () => {
    /*
      A tela mandava preencher e parava aí; o servidor só lia no boot, e o dono
      preenchia o arquivo e continuava vendo "falta configurar". Agora o
      servidor relê a credencial a cada ciclo — e a tela diz o que acontece
      depois de salvar, com a exceção honesta do ambiente do sistema.
    */
    servidor({
      '/core/sync/status': () =>
        status({ readiness: 'READY_FOR_CREDENTIAL', missing: ['DEVORA_SUPABASE_URL'], transport: 'none' }),
    });
    montar();

    await screen.findByText('AGUARDANDO CREDENCIAL');
    expect(screen.getByText(/não precisa reiniciar a API/)).toBeTruthy();
    expect(screen.getByText(/ambiente do sistema/)).toBeTruthy();
  });

  it('com credencial, o recado do .env some — não há o que preencher', async () => {
    servidor({ '/core/sync/status': () => status() });
    montar();
    await screen.findByText('SINCRONIZANDO');
    expect(screen.queryByText(/não precisa reiniciar a API/)).toBeNull();
  });

  it('com credencial e sem schema: AGUARDANDO SCHEMA, não "online"', async () => {
    servidor({
      '/core/sync/status': () =>
        status({ readiness: 'READY_FOR_SCHEMA', centralSchemaCheckedAt: null }),
    });
    montar();

    await screen.findByText('AGUARDANDO SCHEMA');
    expect(screen.getByText(/docs\/supabase/)).toBeTruthy();
    expect(screen.queryByText('SINCRONIZANDO')).toBeNull();
  });

  it('com schema e sem carga: AGUARDANDO CARGA INICIAL', async () => {
    servidor({
      '/core/sync/status': () =>
        status({ readiness: 'READY_FOR_BOOTSTRAP', bootstrapCompletedAt: null }),
    });
    montar();

    await screen.findByText('AGUARDANDO CARGA INICIAL');
    // A explicação diz POR QUE a carga existe.
    expect(screen.getByText(/só carrega o que aconteceu depois/)).toBeTruthy();
  });

  it('tudo no lugar: SINCRONIZANDO', async () => {
    servidor({ '/core/sync/status': () => status() });
    montar();

    await screen.findByText('SINCRONIZANDO');
    expect(screen.getByText('CENTRAL EM DIA')).toBeTruthy();
  });

  it('central de TESTE se identifica — não pode passar por produção', async () => {
    servidor({
      '/core/sync/status': () => status({ isTestTransport: true, transport: 'test-central' }),
    });
    montar();

    await screen.findByText('CENTRAL DE TESTE — NÃO É PRODUÇÃO');
  });
});

describe('atraso da central', () => {
  it('mostra o atraso em palavras, não só a contagem', async () => {
    servidor({
      '/core/sync/status': () =>
        status({}, { pending: 340, lagSeconds: 7200, oldestPendingAt: '2026-08-14T10:00:00.000Z' }),
    });
    montar();

    const lag = await screen.findByTestId('sync-lag');
    expect(lag.textContent).toContain('2 hora(s) atrasada');
    expect(screen.getByText('CENTRAL ATRASADA')).toBeTruthy();
    expect(screen.getByText('340')).toBeTruthy();
  });

  it('fila com nova tentativa também conta como atrasada', async () => {
    servidor({ '/core/sync/status': () => status({}, { pending: 0, retry: 3, lagSeconds: 90 }) });
    montar();

    await screen.findByText('CENTRAL ATRASADA');
    expect((await screen.findByTestId('sync-lag')).textContent).toContain('1 minuto(s)');
  });

  it('mostra a última falha em vez de engolir o motivo', async () => {
    servidor({
      '/core/sync/status': () =>
        status({}, { pending: 5, retry: 5, lastError: 'Central recusou o lote (HTTP 503)' }),
    });
    montar();

    await screen.findByText(/Central recusou o lote \(HTTP 503\)/);
  });
});

describe('eventos parados', () => {
  it('evento morto aparece com destaque e explicação', async () => {
    servidor({ '/core/sync/status': () => status({}, { dead: 4 }) });
    montar();

    await screen.findByText(/4 evento\(s\) parado\(s\)/);
    // Precisa dizer que insistir não resolve — senão o gestor só clica de novo.
    expect(screen.getByText(/insistir não resolveria/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('sem eventos mortos, nenhum alarme — alarme que toca sempre ninguém escuta', async () => {
    servidor({ '/core/sync/status': () => status() });
    montar();

    await screen.findByText('SINCRONIZANDO');
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });
});

describe('ações', () => {
  it('sincronizar agora envia, informa o resultado e relê a situação', async () => {
    let sincronizou = false;
    const chamadas = servidor({
      '/core/sync/run': () => {
        sincronizou = true;
        return { attempted: 3, sent: 3, failed: 0, readiness: 'SYNC_READY' };
      },
      '/core/sync/status': () =>
        sincronizou ? status() : status({}, { pending: 3, lagSeconds: 30 }),
    });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar agora' }));

    /**
     * ENTREGAR E PROJETAR SÃO COISAS DIFERENTES.
     *
     * Este teste cobrava só "3 enviados" — e o gestor lendo isso acreditaria
     * que o consolidado do grupo já mostra as três vendas. Mostraria zero: os
     * fatos chegavam à aterrissagem e nunca viravam linha de negócio, porque
     * nada chamava o projetor. A resposta agora diz as duas coisas, e a falta
     * de projeção tem que aparecer.
     */
    await screen.findByText(/3 evento\(s\) enviado\(s\), 0 pendente\(s\)\./);
    expect(screen.getByText(/Projeção não executada/)).toBeTruthy();
    // Relê depois: sem isso a tela continuaria mostrando o atraso antigo e o
    // gestor clicaria de novo achando que não funcionou.
    await screen.findByText('CENTRAL EM DIA');
    expect(chamadas.filter((c) => c.includes('/core/sync/run'))).toHaveLength(1);
  });

  it('a carga inicial informa quantos fatos foram enfileirados', async () => {
    servidor({
      '/core/sync/bootstrap': () => ({ enqueued: 1875, skipped: 0, completed: true }),
      '/core/sync/status': () => status({ readiness: 'READY_FOR_BOOTSTRAP' }),
    });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Carga inicial' }));
    await screen.findByText(/1875 fato\(s\) do histórico enfileirado\(s\)/);
  });

  it('a recusa da central aparece com o motivo', async () => {
    servidor({
      '/core/sync/run': () => ({ sent: 0, failed: 3, error: 'conexão recusada' }),
      '/core/sync/status': () => status({}, { pending: 3 }),
    });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar agora' }));
    await screen.findByText(/A central recusou: conexão recusada/);
  });

  it('conferir schema diz o que a central respondeu', async () => {
    servidor({
      '/core/sync/probe': () => ({ ok: false, detail: 'Nenhuma migration aplicada na central.' }),
      '/core/sync/status': () => status({ readiness: 'READY_FOR_SCHEMA' }),
    });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Conferir schema' }));
    await screen.findByText(/Nenhuma migration aplicada na central/);
  });
});

describe('a credencial nunca aparece', () => {
  it('nem em formato de chave, nem de JWT', async () => {
    servidor({ '/core/sync/status': () => status() });
    montar();

    await screen.findByText('SINCRONIZANDO');
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/service_role/i);
    expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(html).not.toMatch(/sb_secret|sb_publ/i);
  });
});

describe('a projeção na central (GAP-PRD-048)', () => {
  it('o erro de projeção aparece com a hora e o que fazer — entregar não é projetar', async () => {
    servidor({
      '/core/sync/status': () =>
        status({
          projecao: {
            ultimoErro: 'A central recusou a projeção (HTTP 404). {"code":"PGRST202"}',
            ultimoErroEm: '2026-08-30T01:37:00.000Z',
            ultimaAceitaEm: null,
          },
        }),
    });
    montar();

    const bloco = await screen.findByTestId('sync-projecao');
    expect(bloco.textContent).toContain('PROJEÇÃO FALHANDO');
    expect(bloco.textContent).toContain('PGRST202');
    expect(bloco.textContent).toContain('03-projecao.sql');
    expect(bloco.textContent).toMatch(/nenhuma projeção aceita/i);
  });

  it('erro guardado por versão anterior, sem hora: diz que a hora não se sabe', async () => {
    servidor({
      '/core/sync/status': () =>
        status({ projecao: { ultimoErro: 'PGRST202', ultimoErroEm: null, ultimaAceitaEm: null } }),
    });
    montar();

    const bloco = await screen.findByTestId('sync-projecao');
    expect(bloco.textContent).toMatch(/data desconhecida/);
  });

  it('a projeção aceita aparece com a hora, sem alarme', async () => {
    servidor({
      '/core/sync/status': () =>
        status({
          projecao: { ultimoErro: null, ultimoErroEm: null, ultimaAceitaEm: '2026-09-11T13:00:00.000Z' },
        }),
    });
    montar();

    const bloco = await screen.findByTestId('sync-projecao');
    expect(bloco.textContent).toContain('PROJEÇÃO ACEITA');
    expect(bloco.textContent).not.toContain('PGRST');
  });

  it('a falha de transporte diz que a fila insiste sozinha (GAP-PRD-047)', async () => {
    servidor({
      '/core/sync/status': () =>
        status({}, { retry: 2, lastError: 'fetch failed', lastErrorKind: 'TRANSPORTE' }),
    });
    montar();

    await screen.findByText(/fetch failed/);
    expect(screen.getByText(/a central não respondeu/)).toBeTruthy();
  });
});
