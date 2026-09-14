/**
 * A TELA DE INTEGRAÇÕES DIZ QUAL URL CADASTRAR NO ASAAS (GAP-PRD-002).
 *
 * O dono cadastrou no painel do Asaas o endereço que o papel anunciava, e
 * aquele endereço gravava o aviso sem baixar nada. A tela tinha o token e
 * nenhuma URL. O que esta tela não pode deixar de dizer:
 *
 *   1. a URL DESTA operação, copiável;
 *   2. que `localhost` não é alcançável pelo Asaas, e o que configurar;
 *   3. se algum aviso chegou — e quando;
 *   4. que o token do ambiente é atalho de desenvolvimento.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IntegracaoAsaasPage from '../IntegracaoAsaasPage';

const URL_DA_OPERACAO = 'https://erp.exemplo.com.br/api/v1/loja/webhooks/payments/asaas/empresa-1';

function integracao(parcial: Record<string, unknown> = {}, webhook: Record<string, unknown> | null = {}) {
  return {
    status: {
      provider: 'asaas',
      configured: true,
      environment: 'sandbox',
      readiness: 'READY_FOR_SANDBOX_TEST',
      productionBlockedBy: [],
    },
    credentials: {
      sandbox: { configured: true, maskedHint: '****1234', source: 'vault' },
      production: { configured: false, source: 'none' },
      webhook: { configured: true, maskedHint: '****abcd', source: 'vault' },
    },
    state: {
      environment: 'sandbox',
      connectionVerified: true,
      sandboxHomologated: false,
      lastConnectionTestAt: null,
      lastHomologationAt: null,
    },
    envFallbackAllowed: true,
    ...(webhook === null
      ? {}
      : {
          webhook: {
            url: URL_DA_OPERACAO,
            legacyUrl: 'https://erp.exemplo.com.br/api/v1/webhooks/asaas',
            baseSource: 'GRUPO_SAMPAIO_PUBLIC_URL',
            publiclyReachable: true,
            warning: null,
            lastEvent: null,
            eventsLast30Days: 0,
            pendingWithError: 0,
            ...webhook,
          },
        }),
    ...parcial,
  };
}

function servidor(corpo: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const endereco = String(url);
      const dados = endereco.includes('/core/integrations/asaas') ? corpo : {};
      return new Response(JSON.stringify(dados), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function montar() {
  render(
    <MemoryRouter>
      <IntegracaoAsaasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a URL do webhook aparece na tela', () => {
  it('mostra a URL DESTA operação e o endereço antigo que continua valendo', async () => {
    servidor(integracao());
    montar();

    expect((await screen.findByTestId('webhook-url')).textContent).toContain(URL_DA_OPERACAO);
    expect(screen.getByText(/api\/v1\/webhooks\/asaas/)).toBeTruthy();
    expect(screen.getByText(/Não\s+precisa trocar/)).toBeTruthy();
  });

  it('o botão copia exatamente a URL da operação', async () => {
    const escrever = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: escrever } });
    servidor(integracao());
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Copiar URL' }));

    expect(escrever).toHaveBeenCalledWith(URL_DA_OPERACAO);
    await screen.findByRole('button', { name: 'Copiada' });
  });

  it('endereço que o Asaas não alcança vira alerta com o que configurar', async () => {
    servidor(
      integracao({}, {
        url: 'http://localhost:8787/api/v1/loja/webhooks/payments/asaas/empresa-1',
        publiclyReachable: false,
        warning: 'O endereço http://localhost:8787 não é alcançável pelo Asaas. Defina DEVORA_PUBLIC_BASE_URL.',
      }),
    );
    montar();

    expect(await screen.findByText(/Defina DEVORA_PUBLIC_BASE_URL/)).toBeTruthy();
  });
});

describe('o aviso está chegando?', () => {
  it('sem nenhum aviso, a tela diz que nada chegou — "configurado" não basta', async () => {
    servidor(integracao());
    montar();

    expect(await screen.findByText(/Nenhum aviso do Asaas chegou para esta operação ainda/)).toBeTruthy();
  });

  it('o último aviso aparece com o tipo e se foi processado', async () => {
    servidor(
      integracao({}, {
        lastEvent: {
          eventType: 'PAYMENT_RECEIVED',
          receivedAt: '2026-09-10T14:30:00.000Z',
          processed: true,
          error: null,
        },
        eventsLast30Days: 3,
      }),
    );
    montar();

    expect(await screen.findByText('Último aviso processado')).toBeTruthy();
    expect(screen.getByTestId('webhook-ultimo-aviso').textContent).toContain('PAYMENT_RECEIVED');
    expect(screen.getByText(/3 aviso\(s\) nos últimos 30 dias/)).toBeTruthy();
  });

  it('aviso que falhou mostra o motivo e quantos esperam reenvio', async () => {
    servidor(
      integracao({}, {
        lastEvent: {
          eventType: 'PAYMENT_CONFIRMED',
          receivedAt: '2026-09-10T14:30:00.000Z',
          processed: false,
          error: 'Cobrança pertence a outra operação.',
        },
        eventsLast30Days: 1,
        pendingWithError: 1,
      }),
    );
    montar();

    expect(await screen.findByText('Último aviso com erro')).toBeTruthy();
    expect(screen.getByTestId('webhook-ultimo-aviso').textContent).toContain('Cobrança pertence a outra operação.');
    expect(screen.getByText(/1 esperando o reenvio do Asaas/)).toBeTruthy();
  });
});

describe('o token do webhook', () => {
  it('token vindo do AMBIENTE é dito como atalho de desenvolvimento', async () => {
    servidor(
      integracao({
        credentials: {
          sandbox: { configured: true, source: 'vault' },
          production: { configured: false, source: 'none' },
          webhook: { configured: true, maskedHint: '****abcd', source: 'env' },
        },
      }),
    );
    montar();

    expect(await screen.findByText(/O token em uso é o do AMBIENTE do servidor/)).toBeTruthy();
  });

  it('sem token, a tela avisa que todo aviso é recusado', async () => {
    servidor(
      integracao({
        credentials: {
          sandbox: { configured: true, source: 'vault' },
          production: { configured: false, source: 'none' },
          webhook: { configured: false, source: 'none' },
        },
      }),
    );
    montar();

    expect(await screen.findByText(/Sem token guardado, o servidor recusa todo aviso/)).toBeTruthy();
  });

  it('servidor antigo, sem o campo webhook: a tela abre sem o card, sem quebrar', async () => {
    servidor(integracao({}, null));
    montar();

    expect(await screen.findByText('Credenciais')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('webhook-url')).toBeNull());
  });
});
