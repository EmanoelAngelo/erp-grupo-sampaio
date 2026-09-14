/**
 * O PEDIDO DE COMPRA SAI DO SISTEMA — GAP-PRD-090, o lado da tela.
 *
 * O botão "Enviar ao fornecedor" só mudava o status e a tela dizia "Pedido
 * enviado". Agora: "Imprimir pedido" abre o A4 que o servidor montou; "Enviar
 * por e-mail ao fornecedor" põe a mensagem na fila e a frase diz a VERDADE —
 * sem SMTP, "ficou na fila", nunca "enviado"; e o antigo gesto virou "Marcar
 * como enviado", com a frase dizendo que nada saiu do sistema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PedidosCompraPage from '../PedidosCompraPage';

const DETALHE = {
  id: 'pc-1',
  company_id: 'loja',
  number: 12,
  supplier_id: 'f-1',
  status: 'rascunho',
  expected_at: null,
  notes: null,
  total_cents: 45000,
  cancel_reason: null,
  created_at: '2026-09-10T12:00:00.000Z',
  supplier: { name: 'Distribuidora Alfa', trade_name: null, document: null },
  items: [
    {
      id: 'i-1',
      product_id: 'p-1',
      internal_code: 'PAR-6',
      description: 'Parafuso 6mm',
      quantity: 100,
      unit_cost_cents: 450,
      total_cents: 45000,
      received_quantity: 0,
    },
  ],
  inboundNotes: [],
};

let pedidos: { url: string; method: string; body: unknown }[] = [];
let respostaDoEmail: Record<string, unknown> = {};
let janela: { document: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    pedidos.push({ url: alvo, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (alvo.includes('/core/purchase-orders/pc-1/impressao')) {
      return json({ html: '<html><body>PEDIDO 12 EM A4</body></html>', numero: 12, status: 'rascunho', fornecedor: 'Distribuidora Alfa', emailDoFornecedor: 'vendas@alfa.com.br' });
    }
    if (alvo.includes('/core/purchase-orders/pc-1/email') && method === 'POST') {
      return json({ ...respostaDoEmail, order: { ...DETALHE, status: 'enviado' } });
    }
    if (alvo.includes('/core/purchase-orders/pc-1/send') && method === 'POST') {
      return json({ ...DETALHE, status: 'enviado' });
    }
    if (alvo.includes('/core/purchase-orders/pc-1')) return json(DETALHE);
    if (alvo.includes('/core/purchase-orders')) return json({ items: [], total: 0, limit: 200, offset: 0 });
    if (alvo.includes('/core/suppliers')) return json({ items: [] });
    return json({ items: [] });
  });
}

function entrarComo(perfil: string) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: perfil, displayName: perfil, profileCode: perfil },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: perfil }],
    } as never,
    'LOGIN',
    'teste do pedido que sai do sistema',
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  respostaDoEmail = {
    queued: true,
    toAddress: 'vendas@alfa.com.br',
    readiness: 'READY_FOR_CREDENTIAL',
    missing: ['EMAIL_SMTP_HOST'],
  };
  janela = { document: { write: vi.fn(), close: vi.fn() } };
  vi.stubGlobal('fetch', servidor());
  vi.spyOn(window, 'open').mockImplementation(() => janela as never);
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderizar() {
  render(
    <MemoryRouter initialEntries={['/sistema/compras/pedidos?pedido=pc-1']}>
      <PedidosCompraPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-090 — os três gestos com os três nomes', () => {
  it('o antigo "Enviar ao fornecedor" não existe mais; os três rótulos honestos sim', async () => {
    entrarComo('gerente_loja');
    renderizar();
    expect(await screen.findByRole('button', { name: 'Imprimir pedido' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar por e-mail ao fornecedor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Marcar como enviado' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar ao fornecedor' })).toBeNull();
  });

  it('Imprimir abre a janela com o A4 que o servidor montou', async () => {
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir pedido' }));
    await waitFor(() => expect(janela.document.write).toHaveBeenCalled());
    expect(janela.document.write.mock.calls[0][0]).toContain('PEDIDO 12 EM A4');
    expect(pedidos.some((p) => p.url.includes('/core/purchase-orders/pc-1/impressao'))).toBe(true);
  });

  it('sem SMTP, a frase diz que ficou na fila — e não que foi enviado', async () => {
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar por e-mail ao fornecedor' }));
    expect(await screen.findByText(/ficou na fila/)).toBeTruthy();
    expect(screen.getByText(/vendas@alfa\.com\.br/)).toBeTruthy();
    expect(screen.queryByText(/Pedido enviado por e-mail/)).toBeNull();
    expect(pedidos.some((p) => p.method === 'POST' && p.url.includes('/pc-1/email'))).toBe(true);
  });

  it('com SMTP pronto, a frase diz enviado, com o anexo', async () => {
    respostaDoEmail = { ...respostaDoEmail, readiness: 'READY', missing: [] };
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar por e-mail ao fornecedor' }));
    expect(await screen.findByText(/Pedido enviado por e-mail para vendas@alfa\.com\.br/)).toBeTruthy();
  });

  it('Marcar como enviado avisa que o sistema não mandou nada', async () => {
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Marcar como enviado' }));
    expect(await screen.findByText(/o sistema não mandou nada/)).toBeTruthy();
    expect(pedidos.some((p) => p.method === 'POST' && p.url.includes('/pc-1/send'))).toBe(true);
  });

  it('o estoquista imprime, mas não envia nem marca (a rota é da gerência)', async () => {
    entrarComo('estoquista');
    renderizar();
    expect(await screen.findByRole('button', { name: 'Imprimir pedido' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar por e-mail ao fornecedor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Marcar como enviado' })).toBeNull();
  });
});
