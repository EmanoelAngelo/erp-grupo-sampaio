/**
 * Tela de promoções.
 *
 * O QUE ELA NÃO FAZIA
 *
 * Criava só promoção por CATEGORIA e só por PERCENTUAL, sem data de início e
 * sem como encerrar — enquanto o servidor sempre aceitou produto específico,
 * preço fixo, período completo e desativação. O gerente não conseguia baixar
 * o preço de um item só, nem programar a promoção da semana que vem, nem
 * parar uma promoção errada antes do prazo.
 *
 * E a situação mostrava só "Ativa": uma promoção programada para daqui a três
 * dias aparecia igual a uma valendo agora, o que faz o gerente achar que o
 * preço já caiu.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PromocoesPage } from '../GestaoPages';

const DIA = 86_400_000;

function promocao(over: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    product_id: null,
    category: 'Vestuário',
    price_cents: null,
    percent_off: 20,
    starts_at: new Date(Date.now() - DIA).toISOString(),
    ends_at: null,
    active: 1,
    ...over,
  };
}

function servidor(items: unknown[]) {
  const chamadas: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      chamadas.push({
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body) : null,
      });
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ items }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'nova' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
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

describe('a situação diz o que está acontecendo agora', () => {
  it('promoção programada NÃO aparece como valendo', async () => {
    servidor([promocao({ starts_at: new Date(Date.now() + 3 * DIA).toISOString() })]);
    montar();

    // Mostrar "Ativa" faria o gerente achar que o preço já caiu.
    await screen.findByText('Programada');
    expect(screen.queryByText('Valendo agora')).toBeNull();
  });

  it('promoção no período aparece como valendo agora', async () => {
    servidor([promocao()]);
    montar();
    await screen.findByText('Valendo agora');
  });

  it('promoção com prazo passado aparece como vencida', async () => {
    servidor([
      promocao({
        starts_at: new Date(Date.now() - 10 * DIA).toISOString(),
        ends_at: new Date(Date.now() - DIA).toISOString(),
      }),
    ]);
    montar();
    await screen.findByText('Vencida');
  });

  it('promoção desativada aparece como encerrada', async () => {
    servidor([promocao({ active: 0 })]);
    montar();
    await screen.findByText('Encerrada');
  });
});

describe('criar promoção', () => {
  it('por PRODUTO específico, não só por categoria', async () => {
    const chamadas = servidor([]);
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText('Aplica a'), { target: { value: 'produto' } });
    fireEvent.change(await screen.findByLabelText(/^Produto/), {
      target: { value: 'prod-123' },
    });
    fireEvent.change(screen.getByLabelText(/Desconto/), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    const post = chamadas.find((c) => c.method === 'POST');
    expect((post!.body as Record<string, unknown>).productId).toBe('prod-123');
    expect((post!.body as Record<string, unknown>).category).toBeUndefined();
  });

  it('com PREÇO FIXO, não só percentual', async () => {
    const chamadas = servidor([]);
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'Vestuário' } });
    fireEvent.change(screen.getByLabelText('Tipo de desconto'), { target: { value: 'preco' } });
    fireEvent.change(await screen.findByLabelText(/Preço promocional/), {
      target: { value: '89,90' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    const post = chamadas.find((c) => c.method === 'POST');
    expect((post!.body as Record<string, unknown>).priceCents).toBe(8990);
    expect((post!.body as Record<string, unknown>).percentOff).toBeUndefined();
  });

  it('com data de INÍCIO, para programar a promoção da semana que vem', async () => {
    const chamadas = servidor([]);
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'Vestuário' } });
    fireEvent.change(screen.getByLabelText(/Desconto/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Começa em'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    const post = chamadas.find((c) => c.method === 'POST');
    expect(String((post!.body as Record<string, unknown>).startsAt)).toContain('2026-12-01');
  });

  it('preço fixo em branco é recusado antes de chamar a API', async () => {
    const chamadas = servidor([]);
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Nova promoção' }));
    fireEvent.change(screen.getByLabelText('Tipo de desconto'), { target: { value: 'preco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar promoção' }));

    await screen.findByText('Informe o preço promocional.');
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('encerrar', () => {
  it('desativa e avisa que o preço volta ao de tabela', async () => {
    const chamadas = servidor([promocao()]);
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));

    await screen.findByText(/preço volta ao de tabela nos dois canais/);
    const del = chamadas.find((c) => c.method === 'DELETE');
    expect(del!.url).toContain('/core/promotions/promo-1');
  });

  it('promoção já encerrada não oferece o botão de novo', async () => {
    servidor([promocao({ active: 0 })]);
    montar();

    await screen.findByText('Encerrada');
    expect(screen.queryByRole('button', { name: 'Encerrar' })).toBeNull();
  });
});
