/**
 * A LISTA DE PRODUTOS: o CADASTRO RÁPIDO e a BUSCA (trilha "produto").
 *
 *  - A-produto-02: o preço do cadastro rápido trocava só a primeira vírgula:
 *    "1.299,90" virava NaN e o `|| 0` gravava R$ 0,00, sem erro nenhum. O
 *    produto nascia ativo, travava no balcão e saía na etiqueta a R$ 0,00.
 *  - A-produto-23: a busca perguntava a cada tecla e aplicava a resposta que
 *    chegasse por último — a de "per", mais lenta, cobria a de "perfume".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { ProdutosPage } from '../OperacaoPages';
import { respostaDaBarraDoShell } from './barraDoShell';

let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> | null }[];
/** Quando definida, decide COMO cada busca responde (para embaralhar a ordem). */
let responderBusca: ((termo: string) => Promise<Response>) | null;

const responder = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function linha(id: string, name: string) {
  return {
    id,
    name,
    internal_code: id.toUpperCase(),
    barcode: null,
    sku: null,
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 0,
    price_cents: 1000,
    min_stock: 0,
    stock_quantity: 0,
    active: 1,
  };
}

function pagina(items: unknown[]) {
  return { items, total: items.length, limit: 100, offset: 0, missingShippingDataCount: 0 };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const barra = respostaDaBarraDoShell(url);
    if (barra) return barra;
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push({ metodo, url: alvo, corpo: init?.body ? JSON.parse(init.body) : null });

    if (metodo === 'POST' && /\/core\/products$/.test(alvo)) {
      return responder({ ...linha('novo', 'Perfume 100ml'), internal_code: 'GS-000031' }, 201);
    }
    if (metodo === 'GET' && /\/core\/products(\?|$)/.test(alvo)) {
      const termo = new URLSearchParams(alvo.split('?')[1] ?? '').get('search') ?? '';
      if (responderBusca) return responderBusca(termo);
      return responder(pagina([]));
    }
    return responder({});
  });
}

function entrarComoGerente() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-gerente', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' }],
      access: {
        modelo: { code: 'gerente_loja', name: 'gerente_loja', personalizado: false },
        capabilities: ['products.view', 'products.manage', 'products.catalog.admin'],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/sistema/painel',
        carimbo: 'c-gerente',
      },
    } as never,
    'LOGIN',
    'teste do cadastro rápido',
  );
}

beforeEach(() => {
  pedidos = [];
  responderBusca = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGerente();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste do cadastro rápido');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <ProdutosPage />
    </MemoryRouter>,
  );
}

const posts = () => pedidos.filter((p) => p.metodo === 'POST' && /\/core\/products$/.test(p.url));
const buscas = () =>
  pedidos.filter((p) => p.metodo === 'GET' && /\/core\/products(\?|$)/.test(p.url));
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cadastrarRapido(nome: string, preco: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Cadastro rápido' }));
  fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: nome } });
  fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: preco } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
}

describe('o preço do cadastro rápido (A-produto-02)', () => {
  it('"1.299,90" chega ao servidor como 129990 centavos — e não como zero', async () => {
    montar();
    await cadastrarRapido('  Perfume 100ml ', '1.299,90');

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].corpo).toMatchObject({ name: 'Perfume 100ml', priceCents: 129990 });
  });

  it('"R$ 10" também é lido: 1000 centavos', async () => {
    montar();
    await cadastrarRapido('Sabonete', 'R$ 10');

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].corpo?.priceCents).toBe(1000);
  });

  it('preço ilegível NÃO envia nada e diz o que houve', async () => {
    montar();
    await cadastrarRapido('Sabonete', 'abc');

    const erro = await screen.findByText(/Preço inválido/);
    expect(erro.textContent).toContain('1.299,90');
    expect(posts()).toHaveLength(0);
  });
});

describe('a busca da lista (A-produto-23)', () => {
  it('digitar uma palavra pergunta UMA vez, e não uma por letra', async () => {
    montar();
    await waitFor(() => expect(buscas().length).toBeGreaterThan(0));
    const antes = buscas().length;

    const campo = screen.getByPlaceholderText(/Nome, código interno/);
    for (const parcial of ['p', 'pe', 'per', 'perf', 'perfume']) {
      fireEvent.change(campo, { target: { value: parcial } });
    }
    /*
      A ESPERA É PELO PEDIDO, E NÃO POR UM RELÓGIO.

      A busca sai 250 ms depois da ÚLTIMA tecla, num timer que o efeito arma; o
      pedido só nasce no render seguinte, com o `useLoader`. A pausa fixa de
      400 ms apostava que timer + render + pedido cabiam nela: com a máquina
      saturada não cabiam, e o teste caía sem defeito nenhum. Espera-se o pedido
      do termo final. Se a tela perguntasse a cada letra, os pedidos de "p" a
      "perf" teriam saído ANTES dele — cada troca acima é síncrona —, e a
      contagem de baixo continua caindo.
    */
    await waitFor(() =>
      expect(buscas().slice(antes).some((b) => b.url.includes('search=perfume'))).toBe(true),
    );

    const novas = buscas().slice(antes);
    expect(novas).toHaveLength(1);
    expect(novas[0].url).toContain('search=perfume');
  });

  it('a resposta LENTA de um termo antigo não cobre a do termo atual', async () => {
    let soltarPer: (() => void) | null = null;
    responderBusca = (termo) => {
      if (termo === 'per') {
        // "per" demora: só responde quando o teste mandar, DEPOIS de "perfume".
        return new Promise<Response>((resolve) => {
          soltarPer = () => resolve(responder(pagina([linha('p-1', 'Pera (resultado velho)')])));
        });
      }
      if (termo === 'perfume') return Promise.resolve(responder(pagina([linha('p-2', 'Perfume 100ml')])));
      return Promise.resolve(responder(pagina([])));
    };
    montar();
    const campo = await screen.findByPlaceholderText(/Nome, código interno/);

    fireEvent.change(campo, { target: { value: 'per' } });
    await waitFor(() => expect(buscas().some((b) => b.url.includes('search=per&') || b.url.endsWith('search=per'))).toBe(true));
    fireEvent.change(campo, { target: { value: 'perfume' } });
    expect(await screen.findByText('Perfume 100ml')).toBeTruthy();

    // Agora a resposta velha chega — e é descartada.
    soltarPer!();
    await esperar(50);
    expect(screen.queryByText('Pera (resultado velho)')).toBeNull();
    expect(screen.getByText('Perfume 100ml')).toBeTruthy();
  });
});
