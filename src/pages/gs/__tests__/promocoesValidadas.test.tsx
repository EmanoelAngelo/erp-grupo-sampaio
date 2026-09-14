/**
 * A tela de Promoções — GAP-PRD-032, GAP-PRD-033, GAP-PRD-197, GAP-PRD-194.
 *
 * O que se cobra na tela:
 *   - o produto se BUSCA e se escolhe na lista, e vai o id dele (033);
 *   - a recusa do servidor aparece com as palavras dele (032/197);
 *   - o GRÁTIS pede confirmação antes de chamar a API (032);
 *   - a promoção se EDITA (PATCH), com horário e limite visíveis na lista, e a
 *     data que ninguém mexeu não é reenviada (194);
 *   - a linha legada que a regra de hoje recusaria aparece como "Inválida",
 *     com o motivo; e o produto de outra empresa não vira "Produto específico".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PromocoesPage } from '../GestaoPages';

const DIA = 86_400_000;

function promocao(over: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    product_id: 'uuid-jaq',
    product_name: 'Jaqueta Corta-Vento',
    product_code: 'JQ-1',
    category: null,
    price_cents: null,
    percent_off: 10,
    starts_at: new Date(Date.now() - DIA).toISOString(),
    ends_at: null,
    weekdays: null,
    starts_time: null,
    ends_time: null,
    max_units: null,
    units_used: 0,
    units_left: null,
    free_confirmed: 0,
    active: 1,
    problemas: [],
    ...over,
  };
}

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

function servidor(opcoes: {
  lista?: unknown[];
  produtos?: unknown[];
  post?: () => Response;
  patch?: () => Response;
}) {
  const chamadas: Chamada[] = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      chamadas.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'GET' && u.includes('/core/products')) return json({ items: opcoes.produtos ?? [] });
      if (method === 'GET' && u.includes('/core/taxonomy')) {
        return json({ categories: [{ name: 'Vestuário', children: [] }] });
      }
      if (method === 'GET') return json({ items: opcoes.lista ?? [] });
      if (method === 'POST') return opcoes.post ? opcoes.post() : json({ id: 'nova', sobreposicoes: [] }, 201);
      if (method === 'PATCH') return opcoes.patch ? opcoes.patch() : json({ id: 'promo-1', mudancas: {} });
      return new Response(null, { status: 204 });
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <PromocoesPage />
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

describe('GAP-PRD-033 — o produto se busca e se escolhe', () => {
  it('busca pelo nome, escolhe na lista, e vai o ID do produto', async () => {
    const chamadas = servidor({
      produtos: [{ id: 'uuid-jaq', name: 'Jaqueta Corta-Vento', internal_code: 'JQ-1', price_cents: 32900 }],
    });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText('Aplica a'), { target: { value: 'produto' } });
    fireEvent.change(await screen.findByLabelText(/^Produto/), { target: { value: 'jaq' } });

    fireEvent.click(await screen.findByRole('button', { name: /Jaqueta Corta-Vento/ }));
    expect((screen.getByLabelText(/^Produto/) as HTMLInputElement).value).toBe(
      'Jaqueta Corta-Vento (JQ-1)',
    );
    expect(chamadas.some((c) => c.url.includes('/core/products?search=jaq'))).toBe(true);

    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    await waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body).toMatchObject({
      productId: 'uuid-jaq',
      percentOff: 10,
    });
  });
});

describe('GAP-PRD-032/197 — a recusa do servidor, com as palavras dele', () => {
  it('mostra a mensagem do 400 no formulário', async () => {
    servidor({
      post: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'CORE_PROMOTION_PRODUCT_NOT_FOUND',
              message: 'Nenhum produto desta empresa com o código "PJ-1".',
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText('Aplica a'), { target: { value: 'produto' } });
    fireEvent.change(await screen.findByLabelText(/^Produto/), { target: { value: 'PJ-1' } });
    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Nenhum produto desta empresa com o código "PJ-1"');
  });

  it('100 % pede a confirmação do grátis ANTES de chamar a API', async () => {
    const chamadas = servidor({});
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'Vestuário' } });
    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '100' } });

    const confirmacao = await screen.findByLabelText(/Confirmo o grátis/);
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));
    await screen.findByText(/deixa o produto de graça/);
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(0);

    fireEvent.click(confirmacao);
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));
    await waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body).toMatchObject({
      percentOff: 100,
      confirmarGratis: true,
    });
  });

  it('a criação avisa a sobreposição com outra promoção', async () => {
    servidor({
      post: () =>
        new Response(
          JSON.stringify({ id: 'nova', sobreposicoes: [{ id: 'x', alvo: 'Categoria Vestuário' }] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'Vestuário' } });
    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    const aviso = await screen.findByText(/se sobrepõe a outra promoção/);
    expect(aviso.textContent).toContain('o cliente paga o menor preço');
  });
});

describe('GAP-PRD-194 — editar, horário e limite', () => {
  it('a lista mostra o produto pelo nome, o horário e o quanto do limite já saiu', async () => {
    servidor({
      lista: [promocao({ starts_time: '18:00', ends_time: '20:00', max_units: 50, units_used: 12, units_left: 38 })],
    });
    montar();
    await screen.findByText('Jaqueta Corta-Vento (JQ-1)');
    expect(screen.getByText('Todos os dias · 18:00–20:00')).toBeTruthy();
    expect(screen.getByText('12 de 50 un.')).toBeTruthy();
  });

  it('Editar abre o formulário preenchido e salva por PATCH, sem reenviar a data intocada', async () => {
    const chamadas = servidor({ lista: [promocao({ ends_at: new Date(Date.now() + 10 * DIA).toISOString() })] });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    await screen.findByText('Editar promoção');
    expect((screen.getByLabelText(/Desconto \(%\)/) as HTMLInputElement).value).toBe('10');

    fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Horário de início'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(chamadas.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = chamadas.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/core/promotions/promo-1');
    expect(patch.body).toMatchObject({ productId: 'uuid-jaq', percentOff: 25, startsTime: '18:00' });
    expect(patch.body).not.toHaveProperty('startsAt');
    expect(patch.body).not.toHaveProperty('endsAt');
    await screen.findByText(/Promoção atualizada/);
  });

  it('esgotada aparece como esgotada, e não como valendo', async () => {
    servidor({ lista: [promocao({ max_units: 5, units_used: 5, units_left: 0 })] });
    montar();
    await screen.findByText('Esgotada');
    expect(screen.queryByText('Valendo agora')).toBeNull();
  });
});

describe('o legado aparece como é', () => {
  it('linha que a regra de hoje recusaria: "Inválida", com o motivo', async () => {
    servidor({
      lista: [
        promocao({
          percent_off: 100,
          problemas: ['100 % sem a confirmação do grátis: não vale no preço.'],
        }),
      ],
    });
    montar();
    await screen.findByText('Inválida');
    expect(screen.getByText(/100 % sem a confirmação do grátis/)).toBeTruthy();
    expect(screen.queryByText('Valendo agora')).toBeNull();
  });

  it('produto de outra empresa (linha antiga) não vira "Produto específico"', async () => {
    servidor({
      lista: [
        promocao({
          product_name: null,
          product_code: null,
          problemas: ['O produto não é desta empresa ou foi removido: esta promoção não vale para nada.'],
        }),
      ],
    });
    montar();
    await screen.findByText('Produto de outra empresa ou removido');
  });
});
