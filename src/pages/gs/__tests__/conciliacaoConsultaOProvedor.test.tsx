/**
 * ============================================================================
 * A CONCILIAÇÃO DIZ DE QUANDO É, E PERGUNTA AO PROVEDOR (GAP-PRD-016)
 * ============================================================================
 *
 * A tela apresentava o relatório como "provedor × financeiro" quando ele era,
 * na verdade, "o que o webhook trouxe × financeiro". Com o webhook quebrado, o
 * dinheiro entrava e a tela dizia "tudo confere".
 *
 * Aqui se confere pelo FIO: a data da última consulta aparece, as cobranças
 * que esperam resposta são contadas, o botão "Consultar o provedor agora"
 * chama a rota certa, a resposta (o que mudou, o que falhou) é mostrada linha a
 * linha, e o relatório é recarregado depois.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConciliacaoAsaasPage from '../ConciliacaoAsaasPage';

let chamadas: { url: string; method: string }[];
let relatorio: Record<string, unknown>;
let passada: Record<string, unknown>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  chamadas = [];
  relatorio = {
    from: '2026-08-12',
    to: '2026-09-11',
    providerCents: 0,
    financeCents: 0,
    differenceCents: 0,
    matched: 0,
    rows: [],
    sincronizacao: { last: null, pendingWithRef: 2 },
  };
  passada = {
    id: 'run-1',
    startedAt: '2026-09-11T14:00:00.000Z',
    finishedAt: '2026-09-11T14:00:02.000Z',
    trigger: 'manual',
    checked: 2,
    changed: 1,
    failed: 1,
    skipped: 0,
    unconfigured: false,
    changes: [
      {
        intentId: 'int-1',
        originType: 'finance_entry',
        originId: 'fin-1',
        originLabel: 'Aluguel da sala 2',
        providerRef: 'pay_1',
        antes: 'pending',
        depois: 'confirmed',
        statusNoProvedor: 'RECEIVED',
        detail: 'Título baixado pelo pagamento do provedor.',
      },
    ],
    errors: [{ intentId: 'int-2', providerRef: 'pay_2', error: 'Falha de conexão com Asaas.' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const alvo = String(url);
      const metodo = init?.method ?? 'GET';
      chamadas.push({ url: alvo, method: metodo });
      if (alvo.includes('/conciliacao/sincronizar') && metodo === 'POST') {
        relatorio = {
          ...relatorio,
          providerCents: 30000,
          financeCents: 30000,
          matched: 1,
          sincronizacao: { last: passada, pendingWithRef: 1 },
        };
        return json(passada);
      }
      if (alvo.includes('/core/asaas/conciliacao')) return json(relatorio);
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
      <ConciliacaoAsaasPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-016 — a consulta ao provedor na tela da conciliação', () => {
  it('sem consulta nenhuma, a tela DIZ que só conhece o que o webhook trouxe — e conta o que espera', async () => {
    montar();
    expect(await screen.findByText(/ainda não consultou o provedor/)).toBeTruthy();
    expect(screen.getByText(/2 cobrança\(s\) em aberto no ERP esperam/)).toBeTruthy();
  });

  it('"Consultar o provedor agora" chama a rota, mostra o que mudou e o que falhou, e recarrega o relatório', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Consultar o provedor agora' }));

    await waitFor(() =>
      expect(chamadas.some((c) => c.method === 'POST' && c.url.includes('/core/asaas/conciliacao/sincronizar'))).toBe(true),
    );
    expect(await screen.findByText(/2 cobrança\(s\) consultada\(s\); 1 mudaram; 1 ficaram sem resposta/)).toBeTruthy();
    expect(screen.getByText('Aluguel da sala 2')).toBeTruthy();
    expect(screen.getByText(/aguardando pagamento → paga/)).toBeTruthy();
    expect(screen.getByText(/Falha de conexão com Asaas/)).toBeTruthy();
    // O relatório foi relido depois da consulta: agora há o que bater.
    expect(await screen.findByText(/1 recebimento\(s\) batendo nos dois lados/)).toBeTruthy();
    expect(screen.getByText(/Última consulta em .* \(pedida na tela\)/)).toBeTruthy();
  });

  it('operação sem credencial: a consulta diz que nada foi consultado, com o caminho', async () => {
    passada = { ...passada, unconfigured: true, checked: 0, changed: 0, failed: 0, changes: [], errors: [] };
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Consultar o provedor agora' }));
    expect(await screen.findByText(/Configure em Integrações › Asaas/)).toBeTruthy();
  });

  it('servidor antigo, sem o resumo: a tela não quebra e ainda oferece a consulta', async () => {
    delete relatorio.sincronizacao;
    montar();
    expect(await screen.findByRole('button', { name: 'Consultar o provedor agora' })).toBeTruthy();
  });
});
