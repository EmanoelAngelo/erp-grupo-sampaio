/**
 * A LISTA DIZ QUE CORTOU, NA TELA — GAP-PRD-070 e GAP-PRD-164.
 *
 * O servidor passou a responder `{ items, total, limit, offset }`. Este arquivo
 * cobra a outra metade: a tela USAR isso.
 *
 *   - Produtos, Clientes, Vendas, Entrada de Notas e Pedidos de compra dizem
 *     "mostrando 1–100 de 150" e andam de página;
 *   - o painel diz quantos produtos estão abaixo do mínimo além dos 10;
 *   - o F2 do PDV diz que a primeira carga é uma fatia;
 *   - Fidelidade, Locação e Orçamentos escolhem cliente por BUSCA, e não
 *     numa lista dos 100 primeiros — o 101º cliente existe para elas;
 *   - a nota ou a venda do link, fora da página carregada, é pedida pelo id.
 *
 * Como cada caso fica vermelho: volte qualquer tela ao wrapper antigo (que
 * devolve só o array) e a frase "de 150" some; volte o seletor ao
 * `listCustomers()` sem termo e o 101º cliente não aparece; tire o `?id=` da
 * Entrada de Notas e a nota do link não é pedida.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { ClientesPage, ProdutosPage, VendasPage } from '../OperacaoPages';
import EntradaNotasPage from '../EntradaNotasPage';
import PedidosCompraPage from '../PedidosCompraPage';
import PainelPage from '../PainelPage';
import FidelidadePage from '../FidelidadePage';
import LocacaoPage from '../LocacaoPage';
import OrcamentosPage from '../OrcamentosPage';
import { ClientePdvDialog } from '@/components/gs/ClientePdvDialog';
import EquipamentosPage from '../EquipamentosPage';
import MovimentacoesEstoquePage from '../MovimentacoesEstoquePage';
import { PedidosPage } from '../GestaoPages';

// ------------------------------------------------------------------ o dublê

let urls: string[] = [];
/** Responde sem `total` — o servidor anterior a esta rodada. */
let servidorAntigo = false;
let editados: Record<string, unknown>[] = [];

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Uma página de um universo de `total` linhas, como o servidor corta. */
function pagina<T>(
  todos: T[],
  alvo: string,
  padrao: number,
): { items: T[]; total?: number; limit?: number; offset?: number } {
  const qs = new URLSearchParams(alvo.split('?')[1] ?? '');
  const limit = Number(qs.get('limit')) || padrao;
  const offset = Number(qs.get('offset')) || 0;
  const items = todos.slice(offset, offset + limit);
  return servidorAntigo ? { items } : { items, total: todos.length, limit, offset };
}

const tres = (i: number) => String(i).padStart(3, '0');

const PRODUTOS = Array.from({ length: 150 }, (_, i) => ({
  id: `p-${i + 1}`,
  internal_code: `P${tres(i + 1)}`,
  name: `Produto ${tres(i + 1)}`,
  unit: 'UN',
  price_cents: 1000,
  stock_quantity: 1,
  active: 1,
}));

const CLIENTES = Array.from({ length: 150 }, (_, i) => ({
  id: `c-${i + 1}`,
  name: `Cliente ${tres(i + 1)}`,
  document: null,
  phone: null,
  email: null,
  active: 1,
  price_table_id: null,
}));
/** A cliente que o seletor dos 100 primeiros nunca mostrava. */
const ZULEIDE = { ...CLIENTES[0], id: 'c-zuleide', name: 'Zuleide Amaral', document: '39053344705' };

const VENDAS = Array.from({ length: 1180 }, (_, i) => ({
  id: `v-${i + 1}`,
  number: 1180 - i,
  created_at: '2026-09-01T12:00:00.000Z',
  status: 'completed',
  total_cents: 1000,
}));

const NOTAS = Array.from({ length: 205 }, (_, i) => ({
  id: `n-${i + 1}`,
  access_key: `3526${String(i + 1).padStart(40, '0')}`,
  number: String(1000 + i),
  series: '1',
  supplier_name: 'Distribuidora Alfa',
  total_cents: 1000,
  status: 'recebida',
  created_at: '2026-09-01T12:00:00.000Z',
  issued_at: '2026-09-01T12:00:00.000Z',
  carrier_name_xml: null,
  freight_mode: null,
  volumes_qty: null,
  gross_weight_grams: null,
  vehicle_plate: null,
  tem_xml: 1,
  doc_type: 'nfe',
}));

const PEDIDOS = Array.from({ length: 205 }, (_, i) => ({
  id: `po-${i + 1}`,
  number: 205 - i,
  supplier_id: 's-1',
  supplier_name: 'Distribuidora Alfa',
  supplier_trade_name: null,
  status: 'rascunho',
  expected_at: null,
  total_cents: 1000,
}));

const ORCAMENTO_DA_ZULEIDE = {
  id: 'q-z',
  number: 90,
  kind: 'orcamento',
  status: 'aberto',
  customer_id: ZULEIDE.id,
  total_cents: 20000,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      urls.push(`${metodo} ${alvo}`);

      if (alvo.includes('/core/catalog/aux')) {
        return json({ units: [], taxGroups: [], taxRates: [], priceTables: [] });
      }
      if (alvo.includes('/core/products/search')) {
        const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
        return json({ items: PRODUTOS.filter((p) => p.name.includes(q)).slice(0, 20) });
      }
      const umProduto = alvo.match(/\/core\/products\/(p-\d+)$/);
      if (umProduto) {
        const achado = PRODUTOS.find((p) => p.id === umProduto[1]);
        return json({
          ...achado,
          sku: null,
          barcode: null,
          category: null,
          brand: null,
          cost_cents: 500,
          effective_price_cents: 20000,
          min_stock: 0,
        });
      }
      if (alvo.includes('/core/products')) {
        return json({ ...pagina(PRODUTOS, alvo, 100), missingShippingDataCount: 0 });
      }

      const ficha = alvo.match(/\/core\/customers\/([^/?]+)$/);
      if (ficha && metodo === 'GET') {
        return ficha[1] === ZULEIDE.id
          ? json(ZULEIDE)
          : json({ error: { code: 'CORE_CUSTOMER_NOT_FOUND', message: 'Não achei.' } }, 404);
      }
      if (alvo.includes('/core/customers')) {
        const termo = new URLSearchParams(alvo.split('?')[1] ?? '').get('search') ?? '';
        // O banco inteiro tem a Zuleide DEPOIS dos 150 "Cliente NNN": sem
        // termo, ela nunca cai na primeira página.
        const base = [...CLIENTES, ZULEIDE].filter(
          (c) => !termo || c.name.toLowerCase().includes(termo.toLowerCase()),
        );
        // A busca por "a" casa com muitos — é o caso do "mostrando 20 de N".
        return json(pagina(base, alvo, 100));
      }

      if (alvo.includes('/core/loyalty/program')) {
        return json({
          program: {
            active: 1,
            cents_per_point: 100,
            point_value_cents: 1,
            min_points_to_redeem: 0,
          },
          liability: { points: 0, estimatedCents: 0, customers: 0 },
        });
      }
      if (alvo.includes('/core/loyalty')) return json({ balance: 42, entries: [] });

      const venda = alvo.match(/\/core\/sales\/([^/?]+)$/);
      if (venda) {
        const achada = VENDAS.find((v) => v.id === venda[1]);
        return achada ? json({ ...achada, items: [] }) : json({ error: {} }, 404);
      }
      if (alvo.includes('/core/sales')) return json(pagina(VENDAS, alvo, 200));

      // As rotas de UMA nota (itens, sugestões de preço): vazias, não importam aqui.
      if (/\/core\/purchases\/notes\/[^/?]+\/items/.test(alvo)) return json({ items: [] });
      if (/\/core\/purchases\/notes\/[^/?]+\//.test(alvo)) return json({ suggestions: [] });
      if (alvo.includes('/core/purchases/notes')) {
        const qs = new URLSearchParams(alvo.split('?')[1] ?? '');
        const id = qs.get('id');
        const busca = qs.get('search');
        const base = id
          ? NOTAS.filter((n) => n.id === id)
          : busca
            ? NOTAS.filter((n) => n.number === busca)
            : NOTAS;
        return json(pagina(base, alvo, 200));
      }
      if (alvo.includes('/core/purchase-orders')) return json(pagina(PEDIDOS, alvo, 200));
      if (alvo.includes('/core/suppliers')) return json({ items: [] });

      if (alvo.includes('/core/dashboard')) {
        const baixos = Array.from({ length: 10 }, (_, i) => ({
          product_id: `b-${i}`,
          name: `Baixo ${i}`,
          quantity: 1,
          min_stock: 5,
        }));
        return json({
          revenueCents: 0,
          salesCount: 0,
          averageTicketCents: 0,
          openReceivablesCents: 0,
          byDay: [],
          topProducts: [],
          bySeller: [],
          byBrand: [],
          byBrandUnallocatedCents: 0,
          lowStock: baixos,
          ...(servidorAntigo ? {} : { lowStockTotal: 12 }),
          certificateAlert: null,
          companyId: 'loja',
          companies: [],
        });
      }

      if (alvo.includes('/core/rentals')) return json({ items: [] });

      if (alvo.includes('/core/equipment')) {
        // Uma página curta de um universo de 350: é o total que os cartões mostram.
        const maquina = (i: number, origin: string) => ({
          id: `e-${i}`,
          public_id: i,
          publicIdLabel: `#${String(i).padStart(4, '0')}`,
          origin,
          brand: 'Honda',
          model: 'CG',
          category: null,
          chassis: null,
          serial_number: null,
          sale_status: 'NOT_APPLICABLE',
          status: 'active',
          estoque: null,
          warranty: { status: 'sem_garantia', months: null, baseKind: null, baseDate: null, expiresAt: null, daysLeft: null },
        });
        return json({
          items: [maquina(1, 'INTERNAL_PJ_MOTORS'), maquina(2, 'EXTERNAL_CUSTOMER')],
          total: 350,
          limit: 2,
          offset: 0,
          totalPorOrigem: { INTERNAL_PJ_MOTORS: 200, EXTERNAL_CUSTOMER: 150 },
        });
      }
      if (alvo.includes('/core/stock/movement-kinds')) return json({ items: [] });
      if (alvo.includes('/core/stock/movements')) {
        const mov = (i: number) => ({
          id: `m-${i}`,
          product_name: `Produto ${i}`,
          internal_code: `P${i}`,
          kind_label: 'Entrada manual',
          movement_type: 'in',
          quantity: 1,
          quantity_before: 0,
          balance_after: 1,
          reserved_delta: 0,
          reference_type: 'manual',
          reference_id: `r-${i}`,
          document_number: null,
          unit_cost_cents: null,
          user_name: 'Fulano',
          batch_code: null,
          batch_expires_on: null,
          created_at: '2026-09-01T12:00:00.000Z',
        });
        return json({ items: [mov(1), mov(2)], total: 120, limit: 50, offset: 0 });
      }
      if (alvo.includes('/core/orders')) {
        return json({
          items: [
            {
              id: 'ord-1',
              number: 1001,
              customer_name: 'Ana Compradora',
              total_cents: 20000,
              status: 'aguardando_pagamento',
              tracking_code: null,
              created_at: '2026-08-10T12:00:00.000Z',
            },
          ],
          total: 205,
          limit: 200,
          offset: 0,
          vocabulario: { entrega: [], retirada: [], rotulos: { aguardando_pagamento: 'Aguardando pagamento' } },
        });
      }

      if (alvo.includes('/core/sale-policies')) {
        return json({ discountLimitPercent: 10, creditSaleDueDays: 0, reservationValidDays: 3, definidos: {} });
      }
      if (alvo.includes('/core/sellers')) return json({ items: [] });
      const orcamento = alvo.match(/\/core\/quotes\/([^/?]+)$/);
      if (orcamento && metodo === 'PATCH') {
        editados.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return json(ORCAMENTO_DA_ZULEIDE);
      }
      if (orcamento) {
        return json({
          ...ORCAMENTO_DA_ZULEIDE,
          expired: false,
          liberacao: null,
          items: [
            {
              id: 'i-1',
              product_id: 'p-1',
              description: 'Produto 001',
              quantity: 1,
              unit_price_cents: 20000,
              total_cents: 20000,
            },
          ],
        });
      }
      if (alvo.includes('/core/quotes')) return json(pagina([ORCAMENTO_DA_ZULEIDE], alvo, 100));

      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'token',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste das listas em página',
  );
}

function montar(elemento: React.ReactElement, rota = '/') {
  render(<MemoryRouter initialEntries={[rota]}>{elemento}</MemoryRouter>);
}

const pedidosDe = (trecho: string) => urls.filter((u) => u.includes(trecho));

beforeEach(() => {
  urls = [];
  servidorAntigo = false;
  editados = [];
  localStorage.clear();
  servidor();
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// =========================================================== produtos

describe('Produtos: a página se declara e anda', () => {
  it('"Mostrando 1–100 de 150", e a próxima traz o 101º', async () => {
    montar(<ProdutosPage />);
    expect(await screen.findByText(/Mostrando 1–100 de 150 produtos/)).toBeTruthy();
    expect(screen.queryByText('Produto 101')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));

    expect(await screen.findByText(/Mostrando 101–150 de 150 produtos/)).toBeTruthy();
    expect(screen.getByText('Produto 101')).toBeTruthy();
    expect(pedidosDe('/core/products').some((u) => u.includes('offset=100'))).toBe(true);
  });

  it('outra busca volta para a primeira página', async () => {
    montar(<ProdutosPage />);
    await screen.findByText(/Mostrando 1–100 de 150/);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    await screen.findByText(/Mostrando 101–150/);

    fireEvent.change(screen.getByPlaceholderText(/Nome, código interno/), {
      target: { value: 'Produto' },
    });

    await waitFor(() => {
      const ultimo = pedidosDe('/core/products').at(-1) ?? '';
      expect(ultimo).toContain('search=Produto');
      expect(ultimo).toContain('offset=0');
    });
  });

  it('servidor que não conta: a frase não inventa um "de N"', async () => {
    servidorAntigo = true;
    montar(<ProdutosPage />);
    expect(await screen.findByText(/Mostrando 1–100 produtos\./)).toBeTruthy();
    expect(screen.queryByText(/ de 150/)).toBeNull();
    // A página veio cheia: pode haver mais, e "Próxima" continua oferecida.
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeTruthy();
  });
});

// =========================================================== clientes

describe('Clientes: a carteira não para no 100º', () => {
  it('"Mostrando 1–100 de 151 clientes", e a segunda página existe', async () => {
    montar(<ClientesPage />);
    expect(await screen.findByText(/Mostrando 1–100 de 151 clientes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Zuleide Amaral')).toBeTruthy();
  });
});

// ============================================================= vendas

describe('Vendas: o total que a rota sempre mandou chega à tela', () => {
  it('"Mostrando 1–200 de 1.180 vendas"', async () => {
    montar(<VendasPage />, '/sistema/vendas');
    expect(await screen.findByText(/Mostrando 1–200 de 1\.180 vendas/)).toBeTruthy();
  });

  it('a venda do link fora da página é pedida pelo id, e aparece', async () => {
    montar(<VendasPage />, '/sistema/vendas?venda=v-900');
    // v-900 é a de número 281: longe da primeira página de 200.
    expect(await screen.findByText('#281')).toBeTruthy();
    expect(pedidosDe('/core/sales/v-900').length).toBeGreaterThan(0);
    expect(screen.queryByText(/não está nesta listagem/)).toBeNull();
  });
});

// ================================================== entrada de notas

describe('Entrada de Notas: a 201ª nota não some', () => {
  it('"Mostrando 1–200 de 205 notas", e a próxima traz as cinco', async () => {
    montar(<EntradaNotasPage />);
    expect(await screen.findByText(/Mostrando 1–200 de 205 notas/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText(/Mostrando 201–205 de 205 notas/)).toBeTruthy();
  });

  it('a busca pergunta ao servidor pelo número da nota antiga', async () => {
    montar(<EntradaNotasPage />);
    await screen.findByText(/de 205 notas/);
    fireEvent.change(screen.getByLabelText('Buscar nota'), { target: { value: '1204' } });
    await waitFor(
      () => expect(pedidosDe('/core/purchases/notes?search=1204').length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    expect(await screen.findByText('1204/1')).toBeTruthy();
  });

  it('a nota do link fora da página é pedida pelo id', async () => {
    montar(<EntradaNotasPage />, '/sistema/compras/entrada-notas?nota=n-205');
    await waitFor(() =>
      expect(pedidosDe('/core/purchases/notes?id=n-205').length).toBeGreaterThan(0),
      // A Entrada de Notas faz meia dúzia de perguntas ao abrir; sob carga, passa de 1 s.
      { timeout: 5000 },
    );
  });
});

// ================================================== pedidos de compra

describe('Pedidos de compra: o 201º pedido existe', () => {
  it('"Mostrando 1–200 de 205 pedidos"', async () => {
    montar(<PedidosCompraPage />);
    expect(await screen.findByText(/Mostrando 1–200 de 205 pedidos/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('#1')).toBeTruthy();
  });
});

// ============================================================= painel

describe('Painel: quantos estão abaixo do mínimo além dos dez', () => {
  it('diz o total e leva ao relatório que lista todos', async () => {
    montar(<PainelPage />);
    expect(await screen.findByText(/12 produtos abaixo do mínimo \(mostrando 10\)/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Ver todos no relatório/ });
    expect(link.getAttribute('href')).toBe('/sistema/relatorios/central?relatorio=minimo');
  });

  it('o estoquista vê o total, mas não o link para uma tela que ele não abre', async () => {
    entrarComo('estoquista');
    montar(<PainelPage />);
    expect(await screen.findByText(/12 produtos abaixo do mínimo/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Ver todos no relatório/ })).toBeNull();
  });

  it('servidor que não conta: nenhuma frase inventada', async () => {
    servidorAntigo = true;
    montar(<PainelPage />);
    await screen.findByText('Baixo 0');
    expect(screen.queryByText(/abaixo do mínimo \(mostrando/)).toBeNull();
  });
});

// ============================================================ o F2 do PDV

describe('F2 do PDV: a primeira carga é uma fatia, e diz', () => {
  it('"Mostrando 100 de 151 clientes — digite…"', async () => {
    render(<ClientePdvDialog onSelect={() => undefined} onClose={() => undefined} />);
    expect(await screen.findByText(/Mostrando 100 de 151 clientes/)).toBeTruthy();
  });
});

// ========================================= seletores de cliente por busca

describe('Fidelidade: o extrato de qualquer cliente, por busca', () => {
  it('não carrega a lista dos 100 primeiros; acha a Zuleide pelo nome', async () => {
    montar(<FidelidadePage />);
    const campo = await screen.findByLabelText(/Cliente do extrato/);
    // Nenhuma lista sem termo: o seletor antigo era exatamente isso.
    expect(urls.some((u) => /\/core\/customers(\?limit=\d+)?$/.test(u))).toBe(false);

    fireEvent.change(campo, { target: { value: 'Zul' } });
    fireEvent.click(await screen.findByRole('button', { name: /Zuleide Amaral/ }));

    expect(await screen.findByText('42 ponto(s)')).toBeTruthy();
    expect(pedidosDe('/core/customers?search=Zul').length).toBeGreaterThan(0);
  });

  it('muitos resultados: diz quantos ficaram de fora', async () => {
    montar(<FidelidadePage />);
    fireEvent.change(await screen.findByLabelText(/Cliente do extrato/), {
      target: { value: 'Cliente' },
    });
    expect(
      await screen.findByText(/Mostrando 20 de 150 — continue digitando para achar os outros 130/),
    ).toBeTruthy();
  });
});

describe('Locação: cliente e item por busca', () => {
  it('o contrato abre sem listar cliente nem produto, e acha os dois pela busca', async () => {
    montar(<LocacaoPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Novo contrato/ }));
    expect(pedidosDe('/core/customers').length).toBe(0);
    expect(urls.some((u) => /\/core\/products(\?|$)/.test(u))).toBe(false);

    fireEvent.change(screen.getByLabelText(/^Cliente/), { target: { value: 'Zul' } });
    fireEvent.click(await screen.findByRole('button', { name: /Zuleide Amaral/ }));
    expect(screen.getByRole('button', { name: /Trocar cliente/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Item/), { target: { value: 'Produto 14' } });
    fireEvent.click(await screen.findByRole('button', { name: /Produto 140/ }));
    expect(screen.getByRole('button', { name: /Trocar item/ })).toBeTruthy();
  });
});

describe('Orçamentos: o cliente do documento aparece pelo nome, mesmo fora da lista', () => {
  it('abrir para editar pede a ficha pelo id e salva o mesmo cliente', async () => {
    montar(<OrcamentosPage />);
    const editar = await screen.findAllByRole('button', { name: /^Editar$/ });
    fireEvent.click(editar[0]);

    expect(await screen.findByText('Zuleide Amaral')).toBeTruthy();
    expect(pedidosDe(`/core/customers/${ZULEIDE.id}`).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText(/Quantidade de Produto 001/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Salvar /i }));
    await waitFor(() => expect(editados).toHaveLength(1));
    expect(editados[0].customerId).toBe(ZULEIDE.id);
  });
});

// ======================= as listas que cortavam em 300/200 sem dizer

describe('Equipamentos: os cartões contam o banco, não a página', () => {
  it('"Cadastrados" diz 350 com 2 na tela, e o rodapé declara o corte', async () => {
    montar(<EquipamentosPage />);
    expect(await screen.findByText(/Mostrando 1–2 de 350 equipamentos/)).toBeTruthy();
    expect(screen.getByText('350')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
  });
});

describe('Histórico de estoque: a página sabe quantas são', () => {
  it('"Página 1 de 3 · 120 movimentos"', async () => {
    montar(<MovimentacoesEstoquePage />);
    expect(await screen.findByText(/Página 1 de 3 · 120 movimentos/)).toBeTruthy();
  });
});

describe('Pedidos online: o 201º pedido existe', () => {
  it('"Mostrando 1–1 de 205 pedidos" com a página que veio', async () => {
    montar(<PedidosPage />);
    expect(await screen.findByText(/de 205 pedidos/)).toBeTruthy();
  });
});
