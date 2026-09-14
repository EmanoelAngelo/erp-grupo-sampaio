/**
 * EXCLUIR OU ARQUIVAR — A TELA DIZ O PORQUÊ E OFERECE A SAÍDA.
 *
 * O servidor passou a ter `DELETE /products/:id`: apaga o que nunca aconteceu
 * e responde 409 `CORE_PRODUCT_HAS_HISTORY` (com o que prende, já contado)
 * quando o produto tem histórico. Sem a tela, a pessoa via um erro e ficava
 * sem saber o que fazer — ou, pior, concluía que o sistema não deixa tirar o
 * produto de venda.
 *
 * O que se cobra:
 *   - "Excluir" pergunta antes, na caixa da casa (sem `window.confirm`), e
 *     Cancelar não manda nada ao servidor;
 *   - o 409 vira frase de operador com a contagem e o botão "Inativar
 *     (arquivar)", que grava `active: false` pelo PUT de sempre;
 *   - quem não gere o catálogo não vê o botão;
 *   - a lista do cadastro pede só os ativos por padrão, oferece "Mostrar
 *     inativos" e marca o arquivado com um selo que se lê.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ProdutoFormPage from '../ProdutoFormPage';
import { ProdutosPage } from '../OperacaoPages';
import { respostaDaBarraDoShell } from './barraDoShell';

const PRODUTO_ID = 'prod-1';

let produto: Record<string, unknown>;
let pedidos: { metodo: string; url: string; corpo: unknown }[];
let respostaDoDelete: { status: number; body: unknown };
let listaDoCadastro: Record<string, unknown>[];

function produtoPadrao(): Record<string, unknown> {
  return {
    id: PRODUTO_ID,
    name: 'Cinto de couro',
    internal_code: 'LJ-0042',
    barcode: '7890000000420',
    sku: null,
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 1800,
    price_cents: 3990,
    effective_price_cents: 3990,
    on_sale: false,
    min_stock: 0,
    stock_quantity: 3,
    active: 1,
    publish_online: 0,
    kind: 'retail',
    workshop_id: null,
  };
}

/**
 * O `access` que o servidor devolve no login — só as capabilities que esta tela
 * lê, como nos modelos de sistema: editar = `products.manage`; excluir ou
 * arquivar = `products.catalog.admin` (quem gere o catálogo).
 */
const GERE_CATALOGO = new Set(['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina']);
function acessoDoPerfil(perfil: string) {
  const capabilities = ['products.view'];
  if (GERE_CATALOGO.has(perfil) || perfil === 'estoquista') capabilities.push('products.manage');
  if (GERE_CATALOGO.has(perfil)) capabilities.push('products.catalog.admin');
  return {
    modelo: { code: perfil, name: perfil, personalizado: false },
    capabilities,
    terminais: 'todos',
    bancadas: 'todas',
    casa: '/sistema/painel',
    carimbo: `c-${perfil}`,
  };
}

function entrarComo(perfil: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: `u-${perfil}`, login: perfil, displayName: perfil, profileCode: perfil },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: perfil }],
      access: acessoDoPerfil(perfil),
    } as never,
    'LOGIN',
    'teste de excluir ou arquivar',
  );
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const barra = respostaDaBarraDoShell(url);
    if (barra) return barra;
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push({ metodo, url: alvo, corpo: init?.body ? JSON.parse(init.body) : null });

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (metodo === 'DELETE' && alvo.endsWith(`/core/products/${PRODUTO_ID}`)) {
      return responder(respostaDoDelete.body, respostaDoDelete.status);
    }
    if (metodo === 'PUT' && alvo.endsWith(`/core/products/${PRODUTO_ID}`)) {
      produto = { ...produto, active: 0 };
      return responder(produto);
    }
    if (alvo.includes('/core/workshops')) return responder({ items: [] });
    if (alvo.includes('/core/taxonomy')) return responder({ categories: [], brands: [] });
    if (alvo.includes('/core/stock')) return responder({ items: [] });
    if (alvo.includes('/barcodes')) return responder({ barcodes: [] });
    if (alvo.includes('/kit')) return responder({ components: [], costCents: 0 });
    if (/\/core\/products\/[^/?]+$/.test(alvo)) return responder(produto);
    if (/\/core\/products(\?|$)/.test(alvo)) {
      const params = new URLSearchParams(alvo.split('?')[1] ?? '');
      const situacao = params.get('situacao');
      const items = listaDoCadastro.filter((p) =>
        situacao === 'ativos' ? p.active === 1 : situacao === 'inativos' ? p.active === 0 : true,
      );
      return responder({ items, total: items.length, limit: 100, offset: 0, missingShippingDataCount: 0 });
    }
    return responder({});
  });
}

const HISTORICO_409 = {
  error: {
    code: 'CORE_PRODUCT_HAS_HISTORY',
    message:
      '"Cinto de couro" não pode ser excluído: ele já tem histórico (1 venda, 2 movimentos de estoque). '
      + 'Excluir apagaria o que já aconteceu. Inative (arquive) o produto: ele sai da venda, da busca e da loja, e o histórico continua de pé.',
    details: {
      productId: PRODUTO_ID,
      historico: [
        { codigo: 'vendas', rotulo: '1 venda', quantidade: 1 },
        { codigo: 'movimentos_estoque', rotulo: '2 movimentos de estoque', quantidade: 2 },
      ],
      saida: 'inativar',
      ativo: true,
    },
  },
};

beforeEach(() => {
  pedidos = [];
  produto = produtoPadrao();
  respostaDoDelete = { status: 409, body: HISTORICO_409 };
  listaDoCadastro = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste de excluir ou arquivar');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function montarFicha() {
  render(
    <MemoryRouter initialEntries={[`/sistema/produtos/${PRODUTO_ID}`]}>
      <Routes>
        <Route path="/sistema/produtos/:id" element={<ProdutoFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByDisplayValue('Cinto de couro');
}

const deletes = () => pedidos.filter((p) => p.metodo === 'DELETE');
const puts = () => pedidos.filter((p) => p.metodo === 'PUT');

describe('Excluir, na ficha do produto', () => {
  it('pergunta na caixa da casa — e Cancelar não manda nada', async () => {
    entrarComo('gerente_loja');
    await montarFicha();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    const caixa = await screen.findByRole('dialog');
    expect(caixa.textContent).toContain('Cinto de couro');

    fireEvent.click(within(caixa).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes()).toHaveLength(0);
  });

  it('409 com histórico: diz o porquê em língua de balcão e oferece Inativar (arquivar), que grava active=false', async () => {
    entrarComo('gerente_loja');
    await montarFicha();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    const caixa = await screen.findByRole('dialog');
    fireEvent.click(within(caixa).getByRole('button', { name: 'Excluir definitivamente' }));

    // O porquê, com a contagem que o servidor mandou.
    const aviso = await screen.findByTestId('produto-tem-historico');
    expect(aviso.textContent).toContain('não pode ser excluído');
    expect(aviso.textContent).toContain('1 venda');
    expect(aviso.textContent).toContain('2 movimentos de estoque');
    expect(deletes()).toHaveLength(1);
    // Nada foi gravado ainda: a saída é oferecida, não aplicada.
    expect(puts()).toHaveLength(0);

    fireEvent.click(within(aviso).getByRole('button', { name: 'Inativar (arquivar)' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].corpo).toEqual({ active: false });
    expect(await screen.findByText(/inativado \(arquivado\)/i)).toBeTruthy();
  });

  it('sem histórico: exclui e volta para a lista', async () => {
    entrarComo('gerente_loja');
    respostaDoDelete = {
      status: 200,
      body: { deleted: true, id: PRODUTO_ID, name: 'Cinto de couro' },
    };
    await montarFicha();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    const caixa = await screen.findByRole('dialog');
    fireEvent.click(within(caixa).getByRole('button', { name: 'Excluir definitivamente' }));

    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(screen.queryByTestId('produto-tem-historico')).toBeNull();
  });

  it('quem não gere o catálogo não vê o botão', async () => {
    entrarComo('estoquista');
    await montarFicha();
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
  });
});

describe('a lista do cadastro esconde o arquivado por padrão', () => {
  beforeEach(() => {
    listaDoCadastro = [
      { ...produtoPadrao(), id: 'p-ativo', name: 'Blusa', active: 1 },
      { ...produtoPadrao(), id: 'p-inativo', name: 'Saia antiga', active: 0 },
    ];
  });

  function montarLista() {
    render(
      <MemoryRouter>
        <ProdutosPage />
      </MemoryRouter>,
    );
  }

  it('pede só os ativos; "Mostrar inativos" traz o arquivado com o selo', async () => {
    entrarComo('gerente_loja');
    montarLista();

    expect(await screen.findByText('Blusa')).toBeTruthy();
    const listas = () => pedidos.filter((p) => /\/core\/products(\?|$)/.test(p.url));
    expect(listas()[0].url).toContain('situacao=ativos');
    expect(screen.queryByText('Saia antiga')).toBeNull();

    fireEvent.click(screen.getByLabelText(/Mostrar inativos/));

    expect(await screen.findByText('Saia antiga')).toBeTruthy();
    expect(listas().at(-1)!.url).not.toContain('situacao=');
    expect(screen.getByText('Inativo (arquivado)')).toBeTruthy();
  });
});
