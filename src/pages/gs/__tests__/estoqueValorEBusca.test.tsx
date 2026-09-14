/**
 * POSIÇÃO DE ESTOQUE — o valor que faltava e a busca que faltava.
 *
 * ============================================================================
 * GAP-V11: "quanto vale meu estoque" não existia em superfície nenhuma
 * ============================================================================
 *
 * A rota trazia `cost_cents` por item e ninguém somava. Agora o SERVIDOR
 * responde as duas contas — `value_cents` por linha e o total da empresa em
 * `GET /core/stock/valuation` — e a tela só as MOSTRA. Se a tela refizesse a
 * multiplicação, quantidade fracionada faria a linha divergir do rodapé.
 *
 * A decisão declarada: custo do CADASTRO, não custo médio — e a tela diz isso
 * em palavras, porque um número sem régua parece contabilidade sem ser.
 *
 * ============================================================================
 * GAP-V13: achar um produto era rolar a tabela inteira
 * ============================================================================
 *
 * O parâmetro `search` de `listStock` existia e era usado por TRÊS outras
 * telas — só a posição, a tela principal do estoque, não o expunha.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { EstoquePage } from '../OperacaoPages';

const ITENS = [
  {
    product_id: 'p-1',
    internal_code: 'OLE-01',
    name: 'Óleo 20W50',
    unit: 'UN',
    quantity: 3,
    reserved: 0,
    min_stock: 0,
    price_cents: 4_500,
    cost_cents: 1_099,
    value_cents: 3_297,
    below_minimum: 0,
  },
  {
    product_id: 'p-2',
    internal_code: 'QUE-01',
    name: 'Queijo por kg',
    unit: 'KG',
    quantity: 0.5,
    reserved: 0,
    min_stock: 0,
    price_cents: 700,
    cost_cents: 333,
    // 0,5 × 333 = 166,5 → o SERVIDOR arredondou para 167. A tela não refaz.
    value_cents: 167,
    below_minimum: 0,
  },
];

/** URLs de listagem chamadas, para conferir o parâmetro de busca. */
let chamadasDeStock: string[] = [];

function servidor() {
  return vi.fn(async (url: unknown) => {
    const alvo = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/stock/valuation')) {
      return json({ totalCents: 3_464, produtosComSaldo: 2 });
    }
    if (alvo.includes('/core/stock')) {
      chamadasDeStock.push(alvo);
      const busca = new URL(alvo, 'http://x').searchParams.get('search');
      return json({
        items: busca ? ITENS.filter((i) => i.name.includes(busca)) : ITENS,
      });
    }
    return json({ items: [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  chamadasDeStock = [];
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do valor e da busca na posição',
  );
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
      <EstoquePage />
    </MemoryRouter>,
  );
}

function celula(linhaTexto: string, coluna: string): string {
  const linha = screen.getByText(linhaTexto).closest('tr')!;
  const cabecalhos = Array.from(linha.closest('table')!.querySelectorAll('thead th')).map(
    (th) => th.textContent,
  );
  const indice = cabecalhos.indexOf(coluna);
  expect(indice).toBeGreaterThan(-1);
  return linha.querySelectorAll('td')[indice].textContent ?? '';
}

describe('o valor do estoque (GAP-V11)', () => {
  it('cada linha mostra o valor que o SERVIDOR calculou — fracionado incluso', async () => {
    renderizar();
    await screen.findByText('Óleo 20W50');

    expect(celula('Óleo 20W50', 'Valor em estoque')).toMatch(/32,97/);
    // 166,5 arredondado no servidor: a tela mostra 1,67, não 1,665 nem 1,66.
    expect(celula('Queijo por kg', 'Valor em estoque')).toMatch(/1,67/);
  });

  it('o total geral da empresa vem da rota de valorização, com a régua declarada', async () => {
    renderizar();
    await screen.findByText('Óleo 20W50');

    // R$ 34,64 — a soma dos itens já arredondados, vinda do servidor.
    expect((await screen.findByText(/34,64/)).textContent).toBeTruthy();
    // A régua em palavras: custo do cadastro, não custo médio.
    expect(screen.getByText(/custo do cadastro/i)).toBeTruthy();
  });
});

describe('a busca na posição (GAP-V13)', () => {
  it('digitar refaz a consulta com ?search= e a lista encolhe', async () => {
    renderizar();
    await screen.findByText('Óleo 20W50');

    fireEvent.change(screen.getByPlaceholderText(/nome, código ou código de barras/i), {
      target: { value: 'Queijo' },
    });

    await waitFor(() =>
      expect(chamadasDeStock.some((u) => u.includes('search=Queijo'))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Óleo 20W50')).toBeNull());
    expect(screen.getByText('Queijo por kg')).toBeTruthy();
  });
});
