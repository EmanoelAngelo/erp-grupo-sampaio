/**
 * A CHAVE DA TENTATIVA DE DEVOLUÇÃO (E-venda-servidor-09).
 *
 * O servidor passou a reconhecer o reenvio da mesma devolução pelo cabeçalho
 * `Idempotency-Key` — mas só se a tela mandar a MESMA chave em todo envio da
 * mesma tentativa. Sem chave, o reenvio depois de uma resposta perdida grava a
 * SEGUNDA devolução; com chave nova a cada clique, também. A tela gera a chave
 * quando a venda é aberta para devolver, repete-a no reenvio e a descarta
 * quando a devolução é registrada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA = {
  id: 's-1',
  number: 42,
  company_id: 'loja',
  customer_id: null,
  seller_id: null,
  cash_session_id: null,
  subtotal_cents: 10000,
  discount_cents: 0,
  total_cents: 10000,
  change_cents: 0,
  status: 'completed',
  note: null,
  created_at: '2026-09-14T10:00:00.000Z',
};

const ITEM = {
  sale_item_id: 'si-1',
  product_id: 'p-1',
  description: 'Jaqueta jeans',
  quantity: 2,
  total_cents: 10000,
  net_total_cents: 10000,
  returned_quantity: 0,
  returned_cents: 0,
  serialized: 0,
  units: [],
};

interface Enviado {
  url: string;
  metodo: string;
  chave: string | null;
}
let enviados: Enviado[] = [];

const json = (dado: unknown, status = 200) =>
  new Response(JSON.stringify(dado), { status, headers: { 'Content-Type': 'application/json' } });

const registrada = (numero: number) => ({
  id: `r-${numero}`,
  number: numero,
  sale_id: 's-1',
  sale_number: 42,
  reason: 'Tamanho errado',
  total_cents: 5000,
  refund_method: 'pix',
  created_at: '2026-09-14T10:05:00.000Z',
  items: [],
  estornosNaMaquininha: [],
});

function servidor(rotas: (url: string, metodo: string) => Response | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') {
        enviados.push({ url: alvo, metodo, chave: init?.headers?.['Idempotency-Key'] ?? null });
      }
      const propria = rotas(alvo, metodo);
      if (propria) return propria;
      if (alvo.includes('/returnable')) return json({ items: [ITEM] });
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
      return json({ items: [] });
    }),
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste da chave da tentativa de devolução',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da chave da tentativa de devolução');
  localStorage.clear();
});

async function preencherDevolucaoPorPix() {
  await screen.findByText('#42');
  fireEvent.click(screen.getByRole('button', { name: 'Devolver desta' }));
  await screen.findByLabelText('Devolver quantos de Jaqueta jeans');
  fireEvent.change(screen.getByLabelText('Devolver quantos de Jaqueta jeans'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: 'Tamanho errado' } });
  fireEvent.change(screen.getByLabelText('Como o dinheiro volta'), { target: { value: 'pix' } });
  fireEvent.click(screen.getByRole('button', { name: 'Registrar devolução' }));
}

const postsDeDevolucao = () =>
  enviados.filter((e) => e.url.includes('/core/sale-returns') && e.metodo === 'POST');

describe('E-venda-servidor-09 — a tela manda uma chave por tentativa de devolução', () => {
  it('o reenvio depois de uma resposta perdida leva a MESMA chave do primeiro envio', async () => {
    let tentativas = 0;
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') {
        tentativas += 1;
        if (tentativas === 1) throw new TypeError('Failed to fetch');
        return json(registrada(9), 200);
      }
      return null;
    });
    render(
      <MemoryRouter>
        <DevolucoesPage />
      </MemoryRouter>,
    );
    await preencherDevolucaoPorPix();

    // A conferência não achou devolução nova: a tela deixa tentar de novo.
    await screen.findByText(/ela não foi registrada/);
    fireEvent.click(screen.getByRole('button', { name: 'Registrar devolução' }));
    await screen.findByText(/Devolução #9 registrada/);

    const posts = postsDeDevolucao();
    expect(posts).toHaveLength(2);
    // Antes: nenhum cabeçalho — o servidor não tinha como reconhecer o reenvio.
    expect(posts[0].chave).toBeTruthy();
    expect(posts[1].chave).toBe(posts[0].chave);
  });

  /*
    REVISÃO: o 422 da mesma chave com outro pedido aparecia com a frase técnica
    ("chave de idempotência") e a tentativa seguia com a MESMA chave — todo clique
    seguinte tomava o mesmo 422, e a tela ficava presa.
  */
  it('a mesma chave com outro pedido (422) encerra a tentativa: nomeia a devolução que existe e a próxima leva chave nova', async () => {
    let tentativas = 0;
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') {
        tentativas += 1;
        if (tentativas === 1) {
          return json(
            {
              error: {
                code: 'CORE_IDEMPOTENCY_KEY_REUSED',
                message:
                  'Esta chave de idempotência já registrou a devolução #7, com outro conteúdo — nada foi '
                  + 'registrado agora. Um pedido novo precisa de chave nova.',
                details: { returnId: 'r-7', returnNumber: 7 },
              },
            },
            422,
          );
        }
        return json(registrada(8), 201);
      }
      return null;
    });
    render(
      <MemoryRouter>
        <DevolucoesPage />
      </MemoryRouter>,
    );
    await preencherDevolucaoPorPix();

    await screen.findByText(/A devolução #7 desta venda já tinha sido registrada/);
    expect(screen.queryByText(/chave de idempotência/)).toBeNull();
    // O formulário fechou: não há como reenviar o mesmo pedido com a chave gasta.
    expect(screen.queryByRole('button', { name: 'Registrar devolução' })).toBeNull();

    await preencherDevolucaoPorPix();
    await screen.findByText(/Devolução #8 registrada/);
    const posts = postsDeDevolucao();
    expect(posts).toHaveLength(2);
    expect(posts[1].chave).toBeTruthy();
    expect(posts[1].chave).not.toBe(posts[0].chave);
  });

  it('a devolução registrada encerra a tentativa: a próxima leva chave nova', async () => {
    let numero = 0;
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') {
        numero += 1;
        return json(registrada(numero), 201);
      }
      return null;
    });
    render(
      <MemoryRouter>
        <DevolucoesPage />
      </MemoryRouter>,
    );
    await preencherDevolucaoPorPix();
    await screen.findByText(/Devolução #1 registrada/);

    await preencherDevolucaoPorPix();
    await screen.findByText(/Devolução #2 registrada/);

    const posts = postsDeDevolucao();
    expect(posts).toHaveLength(2);
    expect(posts[0].chave).toBeTruthy();
    expect(posts[1].chave).toBeTruthy();
    expect(posts[1].chave).not.toBe(posts[0].chave);
  });
});
