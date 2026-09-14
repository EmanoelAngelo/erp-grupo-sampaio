/**
 * A TELA DO ASAAS MOSTRA UM SELO POR CHAVE (GAP-PRD-170).
 *
 * "Conexão verificada" era um selo só, carimbado pelo teste do ambiente
 * efetivo (o sandbox, enquanto a produção estava trancada), e abria a tranca
 * de produção sem ninguém ter testado a chave de produção. A tela passa a
 * mostrar o selo de cada chave, a tranca nova em português, e o resultado do
 * teste de cada ambiente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IntegracaoAsaasPage from '../IntegracaoAsaasPage';

let testes: { method: string; body: unknown }[];
let respostaDoTeste: Record<string, unknown>;

function integracao() {
  return {
    status: {
      provider: 'asaas',
      configured: true,
      environment: 'sandbox',
      readiness: 'READY_FOR_SANDBOX_TEST',
      productionBlockedBy: ['CREDENCIAL_DE_PRODUCAO_NAO_TESTADA'],
    },
    credentials: {
      sandbox: { configured: true, maskedHint: '****1234', source: 'vault' },
      production: { configured: true, maskedHint: '****9999', source: 'vault' },
      webhook: { configured: true, maskedHint: '****abcd', source: 'vault' },
    },
    state: {
      environment: 'production',
      connectionVerified: true,
      productionConnectionVerified: false,
      productionConnectionTestedAt: null,
      productionConnectionError: null,
      sandboxHomologated: true,
      lastConnectionTestAt: '2026-09-10T12:00:00.000Z',
      lastHomologationAt: '2026-09-10T12:10:00.000Z',
    },
    envFallbackAllowed: false,
  };
}

beforeEach(() => {
  testes = [];
  respostaDoTeste = {
    ok: false,
    detail: 'Sandbox: Conexão OK (sandbox). Produção: O Asaas recusou a credencial. Confira se a chave é deste ambiente e se ainda está ativa (HTTP 401).',
    results: [
      { environment: 'sandbox', tested: true, ok: true, detail: 'Conexão OK (sandbox).' },
      { environment: 'production', tested: true, ok: false, detail: 'O Asaas recusou a credencial (HTTP 401).' },
    ],
    status: integracao().status,
  };
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      if (alvo.includes('/core/integrations/asaas/test')) {
        testes.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        return new Response(JSON.stringify(respostaDoTeste), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const dados = alvo.includes('/core/integrations/asaas') ? integracao() : {};
      return new Response(JSON.stringify(dados), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar() {
  render(
    <MemoryRouter>
      <IntegracaoAsaasPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-170 — cada chave com o próprio selo', () => {
  it('sandbox verificado e produção não testada aparecem separados, com a tranca em português', async () => {
    montar();
    expect(await screen.findByText('Sandbox: conexão verificada')).toBeTruthy();
    expect(screen.getByText('Produção: chave não testada')).toBeTruthy();
    expect(
      screen.getByText('A chave de produção ainda não foi testada contra o Asaas de produção. Use "Testar conexão".'),
    ).toBeTruthy();
  });

  it('"Testar conexão" testa as chaves e mostra o que cada ambiente respondeu', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Testar conexão' }));

    await waitFor(() => expect(testes).toHaveLength(1));
    expect(testes[0]).toEqual({ method: 'POST', body: {} });
    expect(await screen.findByText(/Produção: O Asaas recusou a credencial/)).toBeTruthy();
  });

  it('a explicação da troca de chave diz qual selo cai', async () => {
    montar();
    expect(await screen.findByText(/a de produção derruba só o teste da produção/)).toBeTruthy();
  });
});
