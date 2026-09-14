/**
 * A HOMOLOGAÇÃO DO ASAAS NA TELA DIZ O QUE EXECUTOU (GAP-PRD-169).
 *
 * A tela prometia que a homologação "escreve em Contas a Receber, concilia e
 * recebe o próprio webhook", e três desses passos eram verdes por atribuição.
 * E a homologação que PASSAVA aparecia como "não passou", porque a tela lia um
 * `status` que o serviço nunca mandava. Aqui se cobra:
 *
 *   - `status: 'passed'` vira "Homologação concluída";
 *   - passo `not_applicable` e `awaiting_external` não aparecem como verdes;
 *   - o aviso do Asaas ainda a caminho oferece "Conferir se o aviso chegou",
 *     que chama a rota da conferência e atualiza o passo;
 *   - os passos da última corrida aparecem ao abrir a tela (estado gravado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IntegracaoAsaasPage from '../IntegracaoAsaasPage';

type Passo = { key: string; label: string; category: string; status: string; message?: string };

const PASSOS: Passo[] = [
  { key: 'connection', label: 'API Asaas', category: 'CONEXÃO', status: 'success', message: 'Conexão Sandbox OK' },
  { key: 'ar_bridge', label: 'Cobrança do título (corpo do ERP)', category: 'ERP', status: 'success', message: 'Nenhum título foi criado no Contas a Receber.' },
  { key: 'ecommerce_bridge', label: 'Pedido online', category: 'ERP', status: 'not_applicable', message: 'Não há chamada própria do pedido online.' },
  { key: 'webhook_external', label: 'Aviso do Asaas chegando ao servidor', category: 'WEBHOOK', status: 'awaiting_external', message: 'Aguardando o aviso do Asaas sobre as cobranças de teste (pay_1).' },
];

let passosGravados: Passo[];
let chamadas: string[];

function integracao() {
  return {
    status: { provider: 'asaas', configured: true, environment: 'sandbox', readiness: 'READY_FOR_SANDBOX_TEST', productionBlockedBy: ['CONFIGURACAO_EM_SANDBOX'] },
    credentials: {
      sandbox: { configured: true, maskedHint: '****1234', source: 'vault' },
      production: { configured: false, source: 'none' },
      webhook: { configured: true, maskedHint: '****abcd', source: 'vault' },
    },
    state: {
      environment: 'sandbox',
      connectionVerified: true,
      sandboxHomologated: true,
      lastConnectionTestAt: null,
      lastHomologationAt: null,
      homologationSteps: passosGravados,
    },
    envFallbackAllowed: false,
  };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  passosGravados = [];
  chamadas = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const alvo = String(url);
      chamadas.push(`${init?.method ?? 'GET'} ${alvo}`);
      if (alvo.includes('/homologar/conferir-aviso')) {
        const passo = { ...PASSOS[3], status: 'success', message: 'O Asaas alcançou este servidor: aviso PAYMENT_CREATED da cobrança de teste pay_1.' };
        return json({ step: passo, steps: [...PASSOS.slice(0, 3), passo] });
      }
      if (alvo.includes('/integrations/asaas/homologar')) {
        return json({ status: 'passed', sandboxHomologated: true, steps: PASSOS });
      }
      if (alvo.includes('/core/integrations/asaas')) return json(integracao());
      return json({});
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

describe('GAP-PRD-169 — a tela da homologação diz o que foi executado', () => {
  it('homologação que passa aparece como concluída (antes: "não passou")', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Rodar homologação' }));
    expect(await screen.findByText('Homologação concluída — esta trava está aberta.')).toBeTruthy();
    expect(screen.queryByText(/A homologação não passou/)).toBeNull();
  });

  it('"não se aplica" e "aguardando" não são verdes, e a promessa antiga saiu', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Rodar homologação' }));
    await screen.findByText('Homologação concluída — esta trava está aberta.');

    expect(screen.getByTestId('passo-ecommerce_bridge').textContent).toContain('não se aplica');
    expect(screen.getByTestId('passo-webhook_external').textContent).toContain('aguardando');
    expect(screen.getByTestId('passo-webhook_external').textContent).not.toContain('✓');
    expect(screen.queryByText(/escreve em Contas a Receber/)).toBeNull();
  });

  it('o aviso a caminho oferece a conferência, que atualiza o passo', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Rodar homologação' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Conferir se o aviso do Asaas chegou' }));

    await waitFor(() => expect(chamadas.some((c) => c.startsWith('POST') && c.includes('/homologar/conferir-aviso'))).toBe(true));
    expect(await screen.findByText(/O Asaas alcançou este servidor/)).toBeTruthy();
    expect(screen.getByTestId('passo-webhook_external').textContent).toContain('✓');
  });

  it('os passos da última corrida aparecem ao abrir a tela', async () => {
    passosGravados = PASSOS;
    montar();
    expect(await screen.findByTestId('passo-ar_bridge')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conferir se o aviso do Asaas chegou' })).toBeTruthy();
  });
});
