/**
 * "TODA QUARTA EM OFERTA" — na tela (GAP-V03).
 *
 * A tela de promoções tinha começo e fim, e nada mais. A oferta semanal do
 * hortifrúti — o formato mais comum do varejo de bairro — exigia recriar a
 * promoção a cada semana: esquecer de criar é preço cheio na quarta, esquecer
 * de encerrar é preço promocional na quinta, e nenhum dos dois dá erro.
 *
 * O QUE ESTE ARQUIVO COBRA
 *
 *  1. os dias vão para o servidor como NÚMEROS (a normalização é de lá);
 *  2. NENHUM dia marcado significa "todos os dias" — e o formulário DIZ isso,
 *     porque é o estado em que ele abre e o gerente precisa saber o que criou;
 *  3. a lista mostra os dias em palavras, e nulo aparece como "Todos os dias";
 *  4. a promoção de OUTRO dia não aparece como "Valendo agora": ela está no
 *     prazo e não desconta nada hoje, e dizer o contrário faria o gerente
 *     conferir o PDV e achar que o sistema está errado.
 *
 * COMO CADA GUARDA FALHA
 *  - tire o `weekdays` do corpo do POST e o caso 1 fica vermelho;
 *  - mande `[0,1,2,3,4,5,6]` quando nada está marcado e o caso 2 fica vermelho;
 *  - tire a peneira de dia do badge e o caso 4 volta a dizer "Valendo agora".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PromocoesPage } from '../GestaoPages';

const DIA = 86_400_000;
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function promocao(over: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    product_id: null,
    category: 'Hortifrúti',
    price_cents: null,
    percent_off: 20,
    starts_at: new Date(Date.now() - DIA).toISOString(),
    ends_at: null,
    weekdays: null,
    active: 1,
    ...over,
  };
}

function servidor(items: unknown[]) {
  const chamadas: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
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

async function abrirFormulario() {
  fireEvent.click(await screen.findByText('Nova promoção'));
  fireEvent.change(screen.getByLabelText(/Categoria/i), {
    target: { value: 'Hortifrúti' },
  });
  fireEvent.change(screen.getByLabelText(/Desconto \(%\)/), { target: { value: '20' } });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o gerente escolhe os dias', () => {
  it('marcar "Qua" manda weekdays [3] — e a normalização fica no servidor', async () => {
    const chamadas = servidor([]);
    montar();
    await abrirFormulario();

    fireEvent.click(screen.getByLabelText('Qua'));
    fireEvent.click(screen.getByText('Ativar promoção'));

    await vi.waitFor(() => {
      expect(chamadas.some((c) => c.method === 'POST')).toBe(true);
    });
    const post = chamadas.find((c) => c.method === 'POST')!;
    // Números, e não a string '3': quem grava é quem decide o formato canônico
    // — se um dia a forma mudar (bitmask, tabela filha), a tela não muda.
    expect(post.body?.weekdays).toEqual([3]);
  });

  it('dois dias vão ORDENADOS, mesmo marcados fora de ordem', async () => {
    const chamadas = servidor([]);
    montar();
    await abrirFormulario();

    fireEvent.click(screen.getByLabelText('Sex'));
    fireEvent.click(screen.getByLabelText('Ter'));
    fireEvent.click(screen.getByText('Ativar promoção'));

    await vi.waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body?.weekdays).toEqual([2, 5]);
  });

  it('NENHUM dia marcado não manda o campo — e o formulário diz o que isso significa', async () => {
    const chamadas = servidor([]);
    montar();
    await abrirFormulario();

    // A frase é o que impede o gerente de sair sem saber se criou uma promoção
    // para todo dia ou para dia nenhum.
    expect(screen.getByText(/nenhum marcado: vale todos os dias/i)).toBeTruthy();

    fireEvent.click(screen.getByText('Ativar promoção'));
    await vi.waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body?.weekdays).toBeUndefined();
  });

  it('desmarcar volta atrás: o dia sai da lista enviada', async () => {
    const chamadas = servidor([]);
    montar();
    await abrirFormulario();

    fireEvent.click(screen.getByLabelText('Qua'));
    fireEvent.click(screen.getByLabelText('Qui'));
    fireEvent.click(screen.getByLabelText('Qua'));
    fireEvent.click(screen.getByText('Ativar promoção'));

    await vi.waitFor(() => expect(chamadas.some((c) => c.method === 'POST')).toBe(true));
    expect(chamadas.find((c) => c.method === 'POST')!.body?.weekdays).toEqual([4]);
  });
});

describe('a lista explica quando a promoção vale', () => {
  it('mostra os dias em palavras', async () => {
    servidor([promocao({ weekdays: '35' })]);
    montar();
    await screen.findByText('Qua, Sex');
  });

  it('sem dias declarados, diz "Todos os dias" — não uma célula vazia', async () => {
    servidor([promocao({ weekdays: null })]);
    montar();
    await screen.findByText('Todos os dias');
  });

  it('promoção de OUTRO dia da semana NÃO aparece como valendo agora', async () => {
    const outroDia = (new Date().getDay() + 1) % 7;
    servidor([promocao({ weekdays: String(outroDia) })]);
    montar();

    // Ela está no prazo e não desconta nada hoje. Dizer "Valendo agora" faria
    // o gerente conferir o preço no PDV e achar que o sistema está errado.
    await screen.findByText('Fora do dia');
    expect(screen.queryByText('Valendo agora')).toBeNull();
  });

  it('e a do dia de HOJE aparece como valendo agora', async () => {
    servidor([promocao({ weekdays: String(new Date().getDay()) })]);
    montar();
    await screen.findByText('Valendo agora');
  });

  it('o rótulo do dia bate com o número gravado — um mapa só, sem tradução paralela', async () => {
    servidor([promocao({ weekdays: '0' })]);
    montar();
    await screen.findByText(DIAS[0]);
  });
});
