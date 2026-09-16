/**
 * ============================================================================
 * A SEGUNDA VIA DO COMPROVANTE, EM VENDAS (P00 da impressão da loja)
 * ============================================================================
 *
 * O DEFEITO: o comprovante de uma venda só saía no painel de "venda concluída"
 * do PDV, que vive os segundos entre fechar a venda e o caixa apertar Esc.
 * Passado isso, NÃO havia no sistema inteiro um jeito de imprimir de novo o
 * cupom da venda #340 — a ficha de Vendas mostrava itens, pagamentos e títulos,
 * e nenhum botão de papel. O cliente que volta pedindo a via (troca, garantia,
 * reembolso da empresa) ouvia que o sistema não imprime, embora o motor
 * soubesse fazê-lo desde sempre: rota sem tela.
 *
 * O papel é escolhido pelo estado fiscal de AGORA, como no PDV: com NFC-e
 * autorizada (ou contingência pendente), a via é o DANFCE; sem nota, o
 * comprovante não fiscal.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido):
 *
 *   - tire o botão e os três casos ficam vermelhos;
 *   - troque a escolha por `SALE_RECEIPT` fixo e o caso da NFC-e autorizada
 *     fica vermelho: o cliente com nota receberia o papel não fiscal;
 *   - devolva `printed` sem passar por `printing` e nada muda aqui — quem
 *     cobra o ciclo do job é `src/lib/__tests__/print.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { VendasPage } from '../OperacaoPages';

const SEM_NOTA = {
  id: 'v-10', number: 10, total_cents: 5_000, change_cents: 0, status: 'completed',
  created_at: '2026-09-01T12:00:00.000Z', customer_id: null,
};
const COM_NOTA = { ...SEM_NOTA, id: 'v-11', number: 11 };
const CANCELADA = { ...SEM_NOTA, id: 'v-12', number: 12, status: 'cancelled' };

const CORPO = {
  items: [{ id: 'si-1', product_id: 'p1', description: 'Sabão', quantity: 1, unit_price_cents: 5_000, total_cents: 5_000 }],
  payments: [],
  customerCreditCents: 0,
  removedItems: [],
  financeEntries: [],
};

const FICHAS: Record<string, Record<string, unknown>> = {
  'v-10': { ...SEM_NOTA, ...CORPO },
  'v-11': { ...COM_NOTA, ...CORPO },
  'v-12': { ...CANCELADA, ...CORPO },
};

/** O estado fiscal de cada venda, como `GET /core/fiscal/sales/:id/status` responde. */
const FISCAL: Record<string, unknown> = {
  'v-10': null,
  'v-11': { document: { id: 'doc-11', status: 'AUTHORIZED' }, statusLabel: 'Autorizada', terminal: true, isTest: false },
  'v-12': null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let jobsCriados: { documentType: string; documentId: string }[];
let estados: string[];

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    const fiscal = alvo.match(/\/core\/fiscal\/sales\/([^/?]+)\/status$/);
    if (fiscal) return json(FISCAL[fiscal[1]] ?? null);

    if (metodo === 'POST' && /\/core\/print\/jobs$/.test(alvo)) {
      const corpo = JSON.parse(init?.body ?? '{}') as { documentType: string; documentId: string };
      jobsCriados.push({ documentType: corpo.documentType, documentId: corpo.documentId });
      return json({ id: 'job-1', status: 'ready', transport: 'browser', fallback_reason: null }, 201);
    }
    if (metodo === 'POST' && /\/core\/print\/jobs\/job-1\/status$/.test(alvo)) {
      estados.push(String(JSON.parse(init?.body ?? '{}').status));
      return json({ id: 'job-1', status: 'printing' });
    }
    if (/\/core\/print\/jobs\/job-1\/document$/.test(alvo)) {
      return new Response('<html>cupom</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    const detalhe = alvo.match(/\/core\/sales\/([^/?]+)$/);
    if (detalhe) return json(FICHAS[detalhe[1]] ?? {});
    if (alvo.includes('/core/sales')) return json({ items: [SEM_NOTA, COM_NOTA, CANCELADA], total: 3 });
    return json({});
  });
}

function entrar() {
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
      access: { capabilities: ['sales.view'], modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste da segunda via do comprovante',
  );
}

let janela: { addEventListener: (nome: string, fn: () => void) => void; print: () => void; close: () => void };

beforeEach(() => {
  jobsCriados = [];
  estados = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  janela = { addEventListener: vi.fn(), print: vi.fn(), close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => janela as never);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:cupom'), revokeObjectURL: vi.fn() }),
  );
  entrar();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste da segunda via');
});

async function abrir(numero: number) {
  render(
    <MemoryRouter>
      <VendasPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByLabelText(`Abrir a venda #${numero}`));
  return screen.findByRole('dialog', { name: `Venda #${numero}` });
}

describe('a ficha da venda imprime a segunda via', () => {
  it('venda sem nota: sai o comprovante NÃO fiscal daquela venda', async () => {
    await abrir(10);
    fireEvent.click(screen.getByRole('button', { name: 'Segunda via do comprovante' }));
    await waitFor(() => expect(jobsCriados).toEqual([{ documentType: 'SALE_RECEIPT', documentId: 'v-10' }]));
    const aviso = await screen.findByTestId('papel-da-venda');
    expect(aviso.textContent).toMatch(/comprovante não fiscal/);
    // O ciclo do job é respeitado: `printing` antes de abrir a janela.
    expect(estados).toEqual(['printing']);
  });

  it('venda com NFC-e autorizada: sai o DANFCE, e não o comprovante', async () => {
    await abrir(11);
    fireEvent.click(screen.getByRole('button', { name: 'Segunda via do comprovante' }));
    await waitFor(() => expect(jobsCriados).toEqual([{ documentType: 'DANFCE', documentId: 'doc-11' }]));
    expect((await screen.findByTestId('papel-da-venda')).textContent).toMatch(/DANFCE/);
  });

  it('venda cancelada: a ficha avisa da tarja antes, e a via sai assim mesmo', async () => {
    const dialogo = await abrir(12);
    expect(dialogo.textContent).toMatch(/VENDA CANCELADA/);
    fireEvent.click(screen.getByRole('button', { name: 'Segunda via do comprovante' }));
    await waitFor(() => expect(jobsCriados).toEqual([{ documentType: 'SALE_RECEIPT', documentId: 'v-12' }]));
  });
});
