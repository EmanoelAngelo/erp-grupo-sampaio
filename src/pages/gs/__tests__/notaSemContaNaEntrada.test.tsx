/**
 * A NOTA RECEBIDA SEM CONTA A PAGAR NA TELA — GAP-PRD-088.
 *
 * A NF 9991 estava recebida e o contas a pagar não sabia da dívida; a tela não
 * dizia nada. O cartão da Entrada de notas lista a pendência para a GERÊNCIA e
 * leva a decisão ao servidor com o que cada gesto exige: vencimento para
 * lançar, data (e forma) para "já foi paga", justificativa para "não gera
 * conta". Para o estoquista, o cartão não existe — a rota o recusa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { NotasSemContaAPagar } from '@/components/gs/NotasSemContaAPagar';

const NF_9991 = {
  id: 'n-9991',
  number: '9991',
  docType: 'nfe',
  accessKey: '35260814200166000187550010000099911234567890',
  supplierId: 'f-1',
  supplierName: 'Distribuidora da NF 9991',
  totalCents: 148560,
  receivedAt: '2026-08-12T20:27:11.000Z',
  vencimentoSugerido: '2026-09-11',
};

let pedidos: { url: string; method: string; body: unknown }[] = [];
let decidida = false;

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    pedidos.push({ url: alvo, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (alvo.includes('/conta-a-pagar') && method === 'POST') {
      decidida = true;
      return json({ noteId: 'n-9991', acao: 'lancar', entryId: 't-1' });
    }
    if (alvo.includes('/core/purchases/notas-sem-conta')) return json({ items: decidida ? [] : [NF_9991] });
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
      company: { id: 'pj', slug: 'pj', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [{ id: 'pj', slug: 'pj', tradeName: 'Preço Justo', kind: 'retail', profileCode: perfil }],
    } as never,
    'LOGIN',
    'teste da nota sem conta',
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  decidida = false;
  vi.stubGlobal('fetch', servidor());
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
    <MemoryRouter>
      <NotasSemContaAPagar />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-088 — a pendência aparece para quem decide', () => {
  it('a NF 9991 aparece com fornecedor, valor e data de recebimento', async () => {
    entrarComo('gerente_loja');
    renderizar();
    expect(await screen.findByText('Notas recebidas sem conta a pagar')).toBeTruthy();
    expect(screen.getByText(/NF-e 9991/)).toBeTruthy();
    expect(screen.getByText(/1\.485,60/)).toBeTruthy();
  });

  it('lançar a conta leva o vencimento sugerido (editável) e o cartão some', async () => {
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Decidir' }));
    const vencimento = screen.getByLabelText('Vencimento') as HTMLInputElement;
    expect(vencimento.value).toBe('2026-09-11');
    fireEvent.change(vencimento, { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar decisão' }));

    await waitFor(() => expect(pedidos.some((p) => p.method === 'POST')).toBe(true));
    const post = pedidos.find((p) => p.method === 'POST')!;
    expect(post.url).toContain('/core/purchases/notes/n-9991/conta-a-pagar');
    expect(post.body).toEqual({ acao: 'lancar', dueDate: '2026-09-30' });
    expect(await screen.findByText(/Conta a pagar lançada/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Notas recebidas sem conta a pagar')).toBeNull());
  });

  it('"já foi paga" exige a data; "não gera conta" exige a justificativa', async () => {
    entrarComo('gerente_loja');
    renderizar();
    fireEvent.click(await screen.findByRole('button', { name: 'Decidir' }));
    const decisao = screen.getByLabelText(/Decisão sobre a nota/) as HTMLSelectElement;

    fireEvent.change(decisao, { target: { value: 'ja_paga' } });
    const confirmar = screen.getByRole('button', { name: 'Confirmar decisão' }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Paga em'), { target: { value: '2026-08-20' } });
    fireEvent.change(screen.getByLabelText('Forma de pagamento'), { target: { value: 'pix' } });
    expect((screen.getByRole('button', { name: 'Confirmar decisão' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(decisao, { target: { value: 'sem_divida' } });
    expect((screen.getByRole('button', { name: 'Confirmar decisão' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Por que a nota não gera conta'), {
      target: { value: 'Mercadoria em consignação' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar decisão' }));
    await waitFor(() => expect(pedidos.some((p) => p.method === 'POST')).toBe(true));
    expect(pedidos.find((p) => p.method === 'POST')!.body).toEqual({
      acao: 'sem_divida',
      reason: 'Mercadoria em consignação',
    });
  });

  it('para o estoquista o cartão não existe, e nada é pedido ao servidor', async () => {
    entrarComo('estoquista');
    renderizar();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Notas recebidas sem conta a pagar')).toBeNull();
    expect(pedidos.some((p) => p.url.includes('notas-sem-conta'))).toBe(false);
  });
});
