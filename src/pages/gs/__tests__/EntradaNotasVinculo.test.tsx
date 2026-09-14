/**
 * A CONFERÊNCIA CASA O ITEM COM O PRODUTO QUE JÁ EXISTE — GAP-PRD-015 e 085.
 *
 * ## O que estava em jogo
 *
 * A tela só tinha "Dar entrada no estoque", e ele mandava `createMissing: true`
 * sempre. Todo item que o casamento automático não reconhecia virava produto
 * novo com preço zero — e o saldo subia nele, enquanto o produto verdadeiro
 * ficava com o saldo velho. A rota de vínculo existia no servidor e nenhuma
 * tela a chamava.
 *
 * ## Como cada caso fica vermelho
 *
 *   - tire o botão "Vincular" da linha e o primeiro caso não acha o que clicar;
 *   - volte a mandar `createMissing: true` no primeiro clique e o caso do
 *     pedido de cadastro vê a confirmação sair sem ninguém autorizar;
 *   - ofereça o vínculo em nota recebida e o caso da nota fechada acha o botão
 *     que o servidor recusaria com 409;
 *   - esqueça o `lembrar` e o caso da caixinha desmarcada manda o de-para
 *     mesmo assim.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';

interface Chamada {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let chamadas: Chamada[];
let statusDaNota: string;
let itens: Record<string, unknown>[];
let respostaDoVinculo: (body: Record<string, unknown>) => Response;
let respostaDaConfirmacao: () => Response;

const CABO = {
  id: 'p-cabo',
  internal_code: 'CAB-160',
  sku: null,
  barcode: null,
  name: 'Cabo de Acelerador CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 2000,
  price_cents: 4500,
  min_stock: 0,
  stock_quantity: 3,
  active: 1,
};

function itemSemProduto(sobrescreve: Record<string, unknown> = {}) {
  return {
    supplierCode: 'ALFA-778',
    description: 'CABO ACEL CG160 REF 778',
    barcode: null,
    ncm: '87141000',
    cfop: '5102',
    unit: 'UN',
    quantity: 4,
    unitCostCents: 2225,
    totalCents: 8900,
    productId: null,
    matchedBy: null,
    receivedQuantity: null,
    divergenceNote: null,
    productName: null,
    productInternalCode: null,
    ...sobrescreve,
  };
}

function itemVinculado(sobrescreve: Record<string, unknown> = {}) {
  return itemSemProduto({
    productId: 'p-cabo',
    matchedBy: 'manual',
    productName: 'Cabo de Acelerador CG 160',
    productInternalCode: 'CAB-160',
    ...sobrescreve,
  });
}

function nota() {
  return {
    id: 'n-conf',
    access_key: '35260814200166000187550010000000011000000017',
    number: '11',
    series: '1',
    supplier_name: 'Distribuidora Alfa',
    total_cents: 8900,
    status: statusDaNota,
    created_at: '2026-09-10T10:00:00.000Z',
    issued_at: '2026-09-10T09:00:00.000Z',
    carrier_name_xml: null,
    freight_mode: null,
    volumes_qty: null,
    gross_weight_grams: null,
    vehicle_plate: null,
    tem_xml: 1,
  };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ url: u, method, body });

      if (u.includes('/core/products/search')) return json({ items: [CABO] });
      if (u.includes('/purchases/notes/n-conf/link')) return respostaDoVinculo(body ?? {});
      if (u.includes('/purchases/notes/n-conf/confirm')) return respostaDaConfirmacao();
      if (u.includes('/purchases/notes/n-conf/items')) return json({ items: itens });
      if (u.includes('/purchases/notes/n-conf/repricing')) return json({ suggestions: [] });
      if (u.includes('/purchases/notes')) return json({ items: [nota()] });
      return json({ items: [] });
    }),
  );
}

function entrar(profileCode = 'estoquista') {
  setSession(
    {
      accessToken: 'token-da-doca',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'doca', displayName: 'Doca', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do vínculo do item da nota',
  );
}

async function montar(profileCode = 'estoquista') {
  entrar(profileCode);
  servidor();
  render(
    <MemoryRouter initialEntries={['/sistema/compras/entrada-notas?nota=n-conf']}>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findByText('CABO ACEL CG160 REF 778');
  // A lista de notas precisa ter chegado: é dela que sai o status da nota.
  await screen.findByText('Distribuidora Alfa');
}

function chamadasA(trecho: string, method = 'POST'): Chamada[] {
  return chamadas.filter((c) => c.url.includes(trecho) && c.method === method);
}

beforeEach(() => {
  chamadas = [];
  statusDaNota = 'conferencia';
  itens = [itemSemProduto()];
  respostaDoVinculo = (body) => {
    itens = [body.productId === null ? itemSemProduto() : itemVinculado()];
    return json({ items: itens });
  };
  respostaDaConfirmacao = () =>
    json({ noteId: 'n-conf', status: 'recebida', createdProducts: 0, movedItems: 1, alreadyReceived: false });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o item sem casamento encontra o produto que já existe (GAP-PRD-015)', () => {
  it('procura no catálogo, vincula, e a linha passa a dizer COM QUAL produto casou', async () => {
    await montar();

    fireEvent.click(
      screen.getByRole('button', { name: 'Vincular CABO ACEL CG160 REF 778 a um produto do catálogo' }),
    );
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Procurar no catálogo o produto de CABO ACEL CG160 REF 778' }),
      { target: { value: 'cabo' } },
    );
    // A busca é a do PDV, com as peças de oficina incluídas.
    await screen.findByText('Cabo de Acelerador CG 160');
    const busca = chamadasA('/core/products/search', 'GET');
    expect(busca.at(-1)?.url).toContain('q=cabo');
    expect(busca.at(-1)?.url).toContain('includeParts=1');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Vincular CABO ACEL CG160 REF 778 a Cabo de Acelerador CG 160',
      }),
    );

    await waitFor(() => expect(chamadasA('/link')).toHaveLength(1));
    expect(chamadasA('/link')[0].body).toEqual({
      itemIndex: 0,
      productId: 'p-cabo',
      lembrar: true,
    });
    expect(await screen.findByText(/por vínculo manual/)).toBeTruthy();
    expect(screen.getByText('Cabo de Acelerador CG 160 · CAB-160')).toBeTruthy();
    expect(screen.getByText('Todos os itens já estão vinculados a produtos do catálogo.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/casam sozinhas/);
  });

  it('a caixinha desmarcada vincula sem ensinar o de-para às próximas notas', async () => {
    await montar();
    fireEvent.click(
      screen.getByRole('button', { name: 'Vincular CABO ACEL CG160 REF 778 a um produto do catálogo' }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Lembrar o código ALFA-778 para as próximas notas deste fornecedor',
      }),
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cabo' } });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Vincular CABO ACEL CG160 REF 778 a Cabo de Acelerador CG 160',
      }),
    );
    await waitFor(() => expect(chamadasA('/link')).toHaveLength(1));
    expect(chamadasA('/link')[0].body?.lembrar).toBe(false);
  });

  it('a recusa do servidor (kit que desmembra) chega com a frase dele e a busca continua aberta', async () => {
    respostaDoVinculo = () =>
      json(
        {
          error: {
            code: 'CORE_PRODUCT_IS_KIT',
            message: '"Kit Revisão" é um kit que desmembra na venda: dê entrada nos componentes.',
          },
        },
        400,
      );
    await montar();
    fireEvent.click(
      screen.getByRole('button', { name: 'Vincular CABO ACEL CG160 REF 778 a um produto do catálogo' }),
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kit' } });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Vincular CABO ACEL CG160 REF 778 a Cabo de Acelerador CG 160',
      }),
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/desmembra na venda/);
    // A busca fica aberta para a pessoa escolher o componente certo, e nada
    // foi vinculado.
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(screen.queryByText(/por vínculo manual/)).toBeNull();
  });

  it('o casamento automático que errou pode ser desfeito — o item volta para "sem produto"', async () => {
    itens = [itemVinculado({ matchedBy: 'name' })];
    await montar();
    expect(screen.getByText(/por descrição/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Desfazer o vínculo de CABO ACEL CG160 REF 778' }),
    );
    await waitFor(() => expect(chamadasA('/link')).toHaveLength(1));
    expect(chamadasA('/link')[0].body).toEqual({ itemIndex: 0, productId: null });
    expect(await screen.findByText('Sem produto no catálogo')).toBeTruthy();
  });

  it('o de-para aprendido aparece com o nome dele', async () => {
    itens = [itemVinculado({ matchedBy: 'supplier_code' })];
    await montar();
    expect(screen.getByText(/código do fornecedor \(vínculo anterior\)/)).toBeTruthy();
  });
});

describe('produto novo só nasce com autorização, e com a lista na tela (GAP-PRD-015)', () => {
  it('o primeiro clique NÃO confirma: mostra o que vai virar cadastro novo', async () => {
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));

    const pedido = await screen.findByRole('alertdialog', { name: 'Cadastrar produtos novos' });
    expect(within(pedido).getByText(/CABO ACEL CG160 REF 778/)).toBeTruthy();
    expect(within(pedido).getByText(/código do fornecedor ALFA-778/)).toBeTruthy();
    expect(chamadasA('/confirm')).toHaveLength(0);

    // "Voltar e vincular" fecha o pedido sem confirmar nada.
    fireEvent.click(within(pedido).getByRole('button', { name: 'Voltar e vincular' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(chamadasA('/confirm')).toHaveLength(0);
  });

  it('autorizado, a entrada vai com createMissing: true', async () => {
    respostaDaConfirmacao = () =>
      json({ noteId: 'n-conf', status: 'recebida', createdProducts: 1, movedItems: 1, alreadyReceived: false });
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar 1 e dar entrada' }));

    await waitFor(() => expect(chamadasA('/confirm')).toHaveLength(1));
    expect(chamadasA('/confirm')[0].body).toEqual({ createMissing: true });
    expect((await screen.findByRole('status')).textContent).toMatch(/1 produto\(s\) cadastrado/);
  });

  it('com tudo vinculado, a entrada vai direto e SEM autorização para cadastrar', async () => {
    itens = [itemVinculado()];
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));
    await waitFor(() => expect(chamadasA('/confirm')).toHaveLength(1));
    expect(chamadasA('/confirm')[0].body).toEqual({ createMissing: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lista velha: o servidor recusa com CORE_UNMATCHED_ITEMS e a tela relê a nota e pergunta', async () => {
    itens = [itemVinculado()];
    respostaDaConfirmacao = () => {
      // Outra pessoa desfez o vínculo enquanto esta tela estava aberta.
      itens = [itemSemProduto()];
      return json(
        {
          error: {
            code: 'CORE_UNMATCHED_ITEMS',
            message: '1 item(ns) sem produto vinculado. Vincule ou autorize o cadastro.',
          },
        },
        409,
      );
    };
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));

    expect(await screen.findByRole('alertdialog', { name: 'Cadastrar produtos novos' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Vincule ou autorize/);
  });
});

describe('o vínculo só existe onde o servidor aceita (GAP-PRD-085)', () => {
  it('nota RECEBIDA não oferece vincular, trocar nem desfazer', async () => {
    statusDaNota = 'recebida';
    itens = [itemVinculado()];
    await montar();
    expect(screen.getByText('Cabo de Acelerador CG 160 · CAB-160')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Trocar o produto/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Desfazer o vínculo/ })).toBeNull();
  });

  it('nota ESTORNADA com item sem produto não oferece vincular', async () => {
    statusDaNota = 'estornada';
    await montar();
    expect(screen.queryByRole('button', { name: /a um produto do catálogo/ })).toBeNull();
  });

  it('o atendente, que a rota recusa, não vê o botão', async () => {
    await montar('atendente');
    expect(screen.queryByRole('button', { name: /a um produto do catálogo/ })).toBeNull();
  });
});
