/**
 * ============================================================================
 * PDV — AS SOBRAS DA AUDITORIA PJ, NA TELA
 * ============================================================================
 *
 *   G-offline-sync-02   F5 com o servidor fora: a venda ia para a fila sem gaveta
 *                       e sem caixa (fora do fechamento do turno).
 *   G-offline-sync-M01  a faixa de preço por quantidade nunca chegava ao PDV.
 *   H-caixa-seguranca-M01  turno fechado em outra máquina: o PDV ficava com a
 *                       gaveta velha e toda venda era recusada.
 *   F-cupom-fiscal-M02  o Imprimir escolhia o papel pelo estado fiscal velho.
 *   F-cupom-fiscal-M03  depois de faturar a pré-venda, o painel apontava a venda
 *                       anterior; F6 fazia o painel da anterior reaparecer.
 *   F-cupom-fiscal-M04  o resumo do cupom usava o preço da tela, não o gravado.
 *   PED-pdv-01          largura da bobina no offline; PIX pendente rotulado; vale.
 *   D-pdv-teclado-14    fração em produto vendido por unidade.
 *   PED-pdv-02          preço mudou entre o bipe e o Finalizar (409).
 *   PED-pdv-03          busca sem conexão dizia só "Falha na busca".
 *   PED-pdv-04          o comprovante offline sem o código da venda guardada.
 *   PED-pdv-06          tecla segurada contava como bipe do leitor.
 *   PED-pdv-07          a vigília da NFC-e acompanhava só a última venda.
 *   D-pdv-teclado-12    o F6 apagava o carrinho montado sem rastro.
 *   E-venda-servidor-10 / G-offline-sync-01 / F-cupom-fiscal-M01  offline com
 *                       vale: troco e total do pagamento.
 *
 * Cada caso diz, no nome, o que a tela fazia de errado; o comentário de cada
 * conserto no `PdvPage.tsx` diz o que tirar para ele voltar a falhar.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { codigoDaVendaGuardada } from '@/lib/api/offlineQueue';
import PdvPage from '../PdvPage';

const printDocument = vi.fn(async (..._args: unknown[]) => ({ via: 'navegador', aviso: null as string | null }));
vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: (...args: unknown[]) => printDocument(...args),
}));

function produto(id: string, nome: string, barcode: string, preco: number, unit = 'UN') {
  return {
    id,
    company_id: 'loja',
    name: nome,
    internal_code: `GS-${id}`,
    sku: null,
    barcode,
    category: null,
    brand: null,
    cost_cents: 0,
    min_stock: 0,
    price_cents: preco,
    effective_price_cents: preco,
    on_sale: false,
    stock_quantity: 500,
    unit,
    kind: 'retail',
    active: 1,
    serialized: 0,
    is_kit: 0,
    open_price: 0,
    weighable: 0,
    stock_control: 1,
    workshop_name: null,
  };
}
const ARROZ = produto('p1', 'ARROZ X 5kg', '7898215151784', 2190);
const FEIJAO = produto('p2', 'FEIJÃO CARIOCA 1kg', '7896006711116', 890);
const SABONETE = produto('p3', 'SABONETE', '7890000000303', 400);
const CESTA = produto('p4', 'CESTA BÁSICA', '7890000000404', 10000);
const VESTIDO = produto('p7', 'VESTIDO LONGO', '7890000000077', 8700);
const TODOS = [ARROZ, FEIJAO, SABONETE, CESTA, VESTIDO];

type Corpo = Record<string, unknown> & {
  items?: { productId: string; quantity: number; unitPriceCents: number }[];
  payments?: { method: string; amountCents: number }[];
  cashSessionId?: string | null;
  terminalId?: string;
  surchargeCents?: number;
};

let vendas: { corpo: Corpo; chave: string }[];
let respostaDaVenda: ((n: number) => Response | null) | null;
let redeForaNaVenda: boolean;
let caixaForaDoAr: boolean;
let chamadasDoCaixa: number;
let sessaoDoCaixa: Record<string, unknown> | null;
let pedidosDePreco: { customerId: string | null; items: { productId: string; quantity: number }[] }[];
let faixa: Record<string, { min: number; preco: number }>;
let statusDaNota: Record<string, unknown>;
let fichaDaVenda: Record<string, unknown>;
let disparo: { modo: string; disparada: boolean; motivos: string[] };
let buscaForaDoAr: boolean;
let buscas: string[];
let abandonos: Record<string, unknown>[];
let abandonoFalha: boolean;
let larguraDaBobina: number | undefined;
/** A loja que a resposta da gaveta devolve (F-cupom-fiscal-20#reauditoria). */
let lojaDaGaveta: { nome: string; cnpj: string | null; endereco: string | null; telefone: string | null } | undefined;
/** Quanto o POST da venda demora (D-pdv-teclado-R01: o bipe com o F8 no ar). */
let atrasoDaVenda: number;
let creditos: number;
let valorDoPix: number;

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

const SESSAO = {
  id: 'sessao-teste',
  terminal_id: 'cx1',
  opening_cents: 20000,
  counted_cents: null,
  expected_cents: null,
  difference_cents: null,
  status: 'aberto',
  opened_at: new Date().toISOString(),
  closed_at: null,
};

const QUOTE = {
  id: 'q-pre',
  number: 12,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: null,
  total_cents: 8700,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
  expired: false,
  liberacao: null,
};

function servidor() {
  // `HeadersInit` é só tipo (sem valor em tempo de execução) e o no-undef do lint não o conhece:
  // o mesmo tipo, tirado do construtor global `Headers`.
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: ConstructorParameters<typeof Headers>[0] }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      buscas.push(q);
      if (buscaForaDoAr) throw new TypeError('Failed to fetch');
      return responder({ items: TODOS.filter((p) => p.barcode === q), catalogoVazio: false });
    }
    const umProduto = alvo.match(/\/core\/products\/(p\d)$/);
    if (umProduto) return responder(TODOS.find((p) => p.id === umProduto[1]));
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}') as (typeof pedidosDePreco)[number];
      pedidosDePreco.push(corpo);
      return responder({
        items: corpo.items.map((i) => {
          const p = TODOS.find((x) => x.id === i.productId)!;
          const f = faixa[i.productId];
          const naFaixa = f && i.quantity >= f.min;
          return {
            productId: i.productId,
            priceCents: naFaixa ? f.preco : p.effective_price_cents,
            listPriceCents: p.price_cents,
            onSale: Boolean(naFaixa),
            fonte: naFaixa ? 'faixa' : 'cadastro',
          };
        }),
        priceTable: null,
      });
    }
    if (alvo.includes('/core/sales/abandoned') && metodo === 'POST') {
      abandonos.push(JSON.parse(init?.body ?? '{}'));
      if (abandonoFalha) {
        return responder({ error: { code: 'CORE_INTERNAL', message: 'Servidor indisponível.' } }, 500);
      }
      return responder({ ok: true, totalCents: 0 }, 201);
    }
    if (alvo.includes('/core/quotes/q-pre/convert') && metodo === 'POST') {
      return responder({ saleId: 'venda-conv', number: 345, nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: [] } }, 201);
    }
    if (alvo.match(/\/core\/quotes\/q-pre$/)) {
      return responder({
        ...QUOTE,
        items: [{ id: 'i-1', product_id: 'p7', description: 'VESTIDO LONGO', quantity: 1, unit_price_cents: 8700, total_cents: 8700 }],
      });
    }
    if (alvo.includes('/core/quotes')) return responder({ items: [QUOTE] });
    const ficha = alvo.match(/\/core\/sales\/(venda-[\w-]+)$/);
    if (ficha && metodo === 'GET') return responder(fichaDaVenda[ficha[1]] ?? {});
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}') as Corpo;
      const chave = new Headers(init?.headers).get('Idempotency-Key') ?? '';
      vendas.push({ corpo, chave });
      if (redeForaNaVenda) throw new TypeError('Failed to fetch');
      const n = vendas.length;
      if (atrasoDaVenda > 0) await new Promise((r) => setTimeout(r, atrasoDaVenda));
      const especial = respostaDaVenda?.(n);
      if (especial) return especial;
      const total =
        (corpo.items ?? []).reduce((s, i) => s + Math.round(i.unitPriceCents * i.quantity), 0)
        + Number(corpo.surchargeCents ?? 0);
      const pago = (corpo.payments ?? []).reduce((s, p) => s + p.amountCents, 0);
      return responder(
        {
          id: `venda-${n}`,
          number: 100 + n,
          subtotal_cents: total,
          discount_cents: 0,
          surcharge_cents: Number(corpo.surchargeCents ?? 0),
          total_cents: total,
          change_cents: Math.max(0, pago - total),
          nfceNoFinalizar: disparo,
        },
        201,
      );
    }
    const fiscal = alvo.match(/\/core\/fiscal\/sales\/([^/]+)\/status/);
    if (fiscal) return responder(statusDaNota[fiscal[1]] ?? null);
    if (alvo.includes('/core/cash/open')) {
      chamadasDoCaixa += 1;
      if (caixaForaDoAr) throw new TypeError('Failed to fetch');
      return responder({
        session: sessaoDoCaixa,
        cashWithdrawalLimitCents: null,
        terminal: { id: 'cx1', code: '01', name: 'Caixa 1' },
      });
    }
    if (alvo.includes('/core/print/drawer')) {
      return responder({ byCommand: false, agentPrinters: 0, message: 'A gaveta abre pela chave.', command: '', paperWidthMm: larguraDaBobina, loja: lojaDaGaveta });
    }
    if (alvo.includes('/core/payment-methods')) {
      return responder({
        methods: [
          { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
          { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
          { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
        ],
      });
    }
    if (alvo.includes('/core/customers/c-1/credits')) return responder({ balance: creditos, entries: [] });
    if (alvo.includes('/pdv/terminal/status')) {
      return responder({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
    }
    if (alvo.includes('/pdv/pix-asaas/status')) {
      return responder({ disponivel: true, ambiente: 'sandbox', motivo: 'Asaas em testes.' });
    }
    const pix = () => ({
      intentId: 'int-1',
      status: 'pending',
      amountCents: valorDoPix,
      environment: 'sandbox',
      providerRef: 'pay_1',
      pixPayload: '000201-PIX',
      pixImageBase64: null,
      expiresAt: null,
      saleId: null,
      lastError: null,
    });
    if (alvo.endsWith('/pdv/pix-asaas') && metodo === 'POST') {
      valorDoPix = Number(JSON.parse(init?.body ?? '{}').amountCents ?? 0);
      return responder(pix(), 201);
    }
    if (alvo.includes('/pdv/pix-asaas/int-1')) return responder(pix());
    return responder({});
  });
}

function entrarComoCaixa() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-caixa', login: 'PREÇO JUSTO', displayName: 'PREÇO JUSTO', profileCode: 'operador_caixa_loja' },
      company: { id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'operador_caixa_loja' }],
      access: {
        modelo: { code: 'operador_caixa_loja', name: 'Operador de Caixa (loja)', personalizado: false },
        capabilities: ['pdv.sell', 'pdv.cash.operate'],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/pdv',
        carimbo: 'c-caixa',
      },
    } as never,
    'LOGIN',
    'teste das sobras do PDV',
  );
}

function abrirPdv() {
  render(
    <MemoryRouter initialEntries={['/pdv']}>
      <PdvPage />
    </MemoryRouter>,
  );
  return screen.getByLabelText(/Pesquise por código/) as HTMLInputElement;
}

function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: campo.value + codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

/**
 * A venda concluída PRONTA para o teclado. O Esc dela e o foco no Imprimir são
 * ligados no mesmo lote de efeitos, DEPOIS do render que desenha a tela: o Esc
 * disparado logo depois do `findByRole` caía sem ouvinte, e a tela não fechava
 * (M03 e PED-pdv-07 vermelhos sob carga). O foco dentro dela é a prova de que
 * o lote rodou.
 */
async function vendaConcluidaPronta(): Promise<HTMLElement> {
  const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
  await waitFor(() => expect(dialogo.contains(document.activeElement)).toBe(true));
  return dialogo;
}

async function venderRapido(campo: HTMLInputElement, codigo: string, nome: string) {
  bipar(campo, codigo);
  await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${nome}`)).toBeTruthy());
  fireEvent.keyDown(campo, { key: 'F8' });
  return vendaConcluidaPronta();
}

/** A janela do comprovante offline: o HTML que o navegador mandaria imprimir. */
function capturarJanelaDoComprovante() {
  const escrito: string[] = [];
  vi.spyOn(window, 'open').mockImplementation(
    () =>
      ({
        document: { open() {}, write: (h: string) => escrito.push(h), close() {} },
        focus() {},
        print() {},
        // A janela fecha no afterprint (F-cupom-fiscal-20#reauditoria).
        addEventListener() {},
        close() {},
      }) as unknown as Window,
  );
  return escrito;
}

beforeEach(() => {
  vendas = [];
  respostaDaVenda = null;
  redeForaNaVenda = false;
  caixaForaDoAr = false;
  chamadasDoCaixa = 0;
  sessaoDoCaixa = SESSAO;
  pedidosDePreco = [];
  faixa = {};
  statusDaNota = {};
  fichaDaVenda = {};
  disparo = { modo: 'MANUAL', disparada: false, motivos: ['Emissão manual nesta loja'] };
  buscaForaDoAr = false;
  buscas = [];
  abandonos = [];
  abandonoFalha = false;
  larguraDaBobina = undefined;
  lojaDaGaveta = undefined;
  atrasoDaVenda = 0;
  creditos = 0;
  valorDoPix = 0;
  printDocument.mockReset();
  printDocument.mockImplementation(async () => ({ via: 'navegador', aviso: null }));
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste das sobras do PDV');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

// ============================================================================

describe('G-offline-sync-02 — com o servidor fora, a venda não perde a gaveta', () => {
  it('F5 durante a queda: a venda vai para a fila com a gaveta e o caixa da última confirmação', async () => {
    localStorage.setItem(
      'gs.pdv.ultimoCaixa:loja',
      JSON.stringify({
        session: { ...SESSAO, id: 'S1' },
        terminal: { id: 'cx1', code: '01', name: 'Caixa 1' },
        confirmadoEm: new Date().toISOString(),
      }),
    );
    caixaForaDoAr = true;
    redeForaNaVenda = true;
    const campo = abrirPdv();
    // A faixa não afirma o que não confirmou.
    expect(await screen.findByTestId('pdv-caixa-nao-confirmado')).toBeTruthy();

    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('offline');
    expect(vendas[0].corpo.cashSessionId).toBe('S1');
    expect(vendas[0].corpo.terminalId).toBe('cx1');
  });

  it('a volta do foco com o servidor fora não troca a gaveta nem esconde as esperas do turno', async () => {
    const campo = abrirPdv();
    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F7' });
    expect(await screen.findByTestId('pdv-esperas')).toBeTruthy();

    caixaForaDoAr = true;
    fireEvent.focus(window);
    expect(await screen.findByTestId('pdv-caixa-nao-confirmado')).toBeTruthy();
    expect(screen.getByTestId('pdv-esperas')).toBeTruthy();

    redeForaNaVenda = true;
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    expect(vendas[0].corpo.cashSessionId).toBe('sessao-teste');
  });

  it('o servidor respondeu "sem caixa": a lembrança é apagada e não volta na próxima queda', async () => {
    localStorage.setItem(
      'gs.pdv.ultimoCaixa:loja',
      JSON.stringify({ session: { ...SESSAO, id: 'S1' }, terminal: null, confirmadoEm: new Date().toISOString() }),
    );
    sessaoDoCaixa = null;
    abrirPdv();
    await screen.findByText(/Nenhum caixa aberto/);
    expect(localStorage.getItem('gs.pdv.ultimoCaixa:loja')).toBeNull();
  });
});

// ============================================================================

describe('G-offline-sync-M01 — a faixa de preço por quantidade chega ao balcão', () => {
  it('três bipes do mesmo item: a tela pergunta o preço de 3, mostra R$ 9,99 e cobra R$ 9,99', async () => {
    faixa = { p3: { min: 3, preco: 333 } };
    const campo = abrirPdv();
    for (const esperado of ['1', '2', '3']) {
      bipar(campo, SABONETE.barcode);
      await waitFor(() =>
        expect((screen.getByLabelText(`Quantidade de ${SABONETE.name}`) as HTMLInputElement).value).toBe(esperado),
      );
    }
    await waitFor(() =>
      expect(pedidosDePreco.some((p) => p.items.some((i) => i.productId === 'p3' && i.quantity === 3))).toBe(true),
    );
    await waitFor(() => expect(screen.getAllByText(/9,99/).length).toBeGreaterThan(0));

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].corpo.items?.[0]).toMatchObject({ productId: 'p3', quantity: 3, unitPriceCents: 333 });
    expect(vendas[0].corpo.payments?.[0]).toMatchObject({ method: 'dinheiro', amountCents: 999 });
  });

  it('um bipe só (a venda comum) não vai ao servidor perguntar preço', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    expect(pedidosDePreco.some((p) => p.items.length > 0)).toBe(false);
  });
});

// ============================================================================

describe('H-caixa-seguranca-M01 — o turno fechado em outra máquina', () => {
  it('a recusa "caixa fechado" relê a gaveta, abre o caixa e mantém o carrinho', async () => {
    respostaDaVenda = () =>
      responder(
        { error: { code: 'CORE_CASH_SESSION_CLOSED', message: 'O caixa informado já foi fechado — abra um caixa para vender.' } },
        400,
      );
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    await waitFor(() => expect(chamadasDoCaixa).toBeGreaterThan(0));
    const antes = chamadasDoCaixa;
    // O gerente fechou o turno no computador dele.
    sessaoDoCaixa = null;
    fireEvent.keyDown(campo, { key: 'F8' });

    expect(await screen.findByText(/A venda NÃO foi registrada; o carrinho continua na tela/)).toBeTruthy();
    await waitFor(() => expect(chamadasDoCaixa).toBeGreaterThan(antes));
    expect(await screen.findByRole('dialog', { name: /Caixa · Preço Justo/ })).toBeTruthy();
    expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy();
  });

  it('abrir o caixa (F3) relê a gaveta — o diálogo não mostra a sessão velha', async () => {
    const campo = abrirPdv();
    await waitFor(() => expect(chamadasDoCaixa).toBeGreaterThan(0));
    const antes = chamadasDoCaixa;
    fireEvent.keyDown(campo, { key: 'F3' });
    await waitFor(() => expect(chamadasDoCaixa).toBeGreaterThan(antes));
  });
});

// ============================================================================

describe('F-cupom-fiscal-M02 — o Imprimir confere a nota antes de escolher o papel', () => {
  it('estado velho "pendente" e a nota JÁ autorizada: sai o DANFCE, e não o comprovante', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = { document: { id: 'doc-1', status: 'PENDING' }, statusLabel: 'Na fila' };
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('pendente');

    // A SEFAZ autorizou enquanto o cliente contava o dinheiro.
    statusDaNota['venda-1'] = { document: { id: 'doc-1', status: 'AUTHORIZED' }, statusLabel: 'Autorizada' };
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('DANFCE', 'doc-1', { terminalId: 'cx1' }));
    expect(printDocument).not.toHaveBeenCalledWith('SALE_RECEIPT', 'venda-1', expect.anything());
  });

  it('ainda pendente no clique: sai o comprovante NÃO fiscal', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = { document: { id: 'doc-1', status: 'PENDING' }, statusLabel: 'Na fila' };
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('SALE_RECEIPT', 'venda-1', { terminalId: 'cx1' }));
  });
});

// ============================================================================

describe('F-cupom-fiscal-M03 — o painel é da venda que acabou de sair', () => {
  it('vender A e faturar a pré-venda B: o cupom e o painel são de B', async () => {
    const campo = abrirPdv();
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await screen.findByRole('button', { name: 'imprimir comprovante' });

    fireEvent.keyDown(campo, { key: 'F9' });
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda #12/ }));
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${VESTIDO.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    const valor = (await screen.findByPlaceholderText(/Vazio =/)) as HTMLInputElement;
    fireEvent.change(valor, { target: { value: '100,00' } });
    fireEvent.submit(valor.closest('form')!);
    await waitFor(() => expect(screen.getAllByText(/Dinheiro/).length).toBeGreaterThan(0));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });

    const dialogo = await vendaConcluidaPronta();
    expect(within(dialogo).getByTestId('venda-concluida-numero').textContent).toContain('345');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('button', { name: 'imprimir comprovante' }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('SALE_RECEIPT', 'venda-conv', { terminalId: 'cx1' }));
    expect(printDocument).not.toHaveBeenCalledWith('SALE_RECEIPT', 'venda-1', expect.anything());
  });

  it('F6 no carrinho do próximo cliente: o painel da venda anterior NÃO reaparece', async () => {
    const campo = abrirPdv();
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await screen.findByRole('button', { name: 'imprimir comprovante' });

    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F6' });
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    fireEvent.click(within(pergunta).getByRole('button', { name: /Cancelar a venda/ }));
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeNull());
    expect(screen.queryByRole('button', { name: 'imprimir comprovante' })).toBeNull();
  });
});

// ============================================================================

describe('F-cupom-fiscal-M04 — o resumo do cupom é o que o servidor gravou', () => {
  it('o servidor cobrou R$ 19,90 num item que a tela mostrava a R$ 21,90: o resumo mostra R$ 19,90', async () => {
    respostaDaVenda = (n) =>
      responder(
        {
          id: `venda-${n}`,
          number: 100 + n,
          subtotal_cents: 1990,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: 1990,
          change_cents: 200,
          nfceNoFinalizar: disparo,
        },
        201,
      );
    fichaDaVenda['venda-1'] = {
      id: 'venda-1',
      number: 101,
      total_cents: 1990,
      items: [{ id: 'si-1', product_id: 'p1', description: 'ARROZ X 5kg', quantity: 1, unit_price_cents: 1990, total_cents: 1990 }],
    };
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    const resumo = within(dialogo).getByText(/Resumo do cupom/).closest('details')!;
    await waitFor(() => expect(resumo.textContent).toContain('19,90'));
    expect(resumo.textContent).not.toContain('21,90');
  });
});

// ============================================================================

describe('PED-pdv-01 — o papel e a tela da venda concluída dizem a verdade', () => {
  it('offline: o comprovante sai na largura da bobina deste caixa (58 mm)', async () => {
    larguraDaBobina = 58;
    const escrito = capturarJanelaDoComprovante();
    const campo = abrirPdv();
    await waitFor(() => expect(localStorage.getItem('gs.pdv.larguraDoCupom:loja')).toBe('58'));
    redeForaNaVenda = true;
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(escrito.length).toBeGreaterThan(0));
    expect(escrito.join('')).toContain('size: 58mm');
  });

  /*
    F-cupom-fiscal-20#reauditoria: o comprovante offline saía só com o nome
    fantasia da sessão. A loja vem da resposta da gaveta, guardada enquanto o
    servidor respondia — e o papel diz CNPJ, endereço e telefone.
  */
  it('offline: o comprovante diz o CNPJ, o endereço e o telefone da loja', async () => {
    lojaDaGaveta = {
      nome: 'Preco Justo Centro',
      cnpj: '12.345.678/0001-95',
      endereco: 'Rua XV de Novembro, 100, Pelotas/RS',
      telefone: '(53) 3222-0000',
    };
    const escrito = capturarJanelaDoComprovante();
    const campo = abrirPdv();
    await waitFor(() => expect(localStorage.getItem('gs.pdv.lojaDoPapel:loja')).toContain('12.345.678/0001-95'));
    redeForaNaVenda = true;
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(escrito.length).toBeGreaterThan(0));
    const papel = escrito.join('');
    expect(papel).toContain('Preco Justo Centro');
    expect(papel).toContain('CNPJ 12.345.678/0001-95');
    expect(papel).toContain('Rua XV de Novembro, 100');
    expect(papel).toContain('Fone (53) 3222-0000');
  });

  it('o PIX "receber depois" aparece como aguardando confirmação, e não como pago', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    const pagamento = await screen.findByRole('dialog', { name: 'Pagamento' });
    fireEvent.click(await within(pagamento).findByRole('button', { name: /PIX/ }));
    await waitFor(() => expect(within(pagamento).getByRole('button', { name: 'Gerar QR do PIX' })).toBeTruthy());
    fireEvent.change(within(pagamento).getByLabelText('CPF de quem paga'), { target: { value: '529.982.247-25' } });
    fireEvent.click(within(pagamento).getByRole('button', { name: 'Gerar QR do PIX' }));
    fireEvent.click(await within(pagamento).findByRole('button', { name: 'Receber depois (fica pendente)' }));
    await within(pagamento).findByText(/pendente — liquida quando o provedor confirmar/);
    fireEvent.click(within(pagamento).getByRole('button', { name: /^Finalizar/ }));

    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(within(dialogo).getByTestId('venda-concluida-pagamentos').textContent).toContain(
      'PIX — aguardando confirmação',
    );
  });
});

// ============================================================================

describe('offline com vale (E-venda-servidor-10 / G-offline-sync-01 / F-cupom-fiscal-M01 / PED-pdv-04)', () => {
  it('vale de R$ 30,00 e R$ 100,00 em dinheiro numa venda de R$ 100,00: troco R$ 30,00, o vale no papel e o código', async () => {
    const chave = 'pdv-chave-do-teste-vale-0001';
    sessionStorage.setItem(
      'gs.pdv.rascunho:loja:u-caixa',
      JSON.stringify({
        lines: [{ product: CESTA, quantity: 1, unitPriceCents: 10000, precificadaPara: 'c-1' }],
        customer: { id: 'c-1', name: 'Zuleide' },
        descontoTexto: '',
        note: '',
        removidos: [],
        saleKey: chave,
        loadedQuote: null,
        guardadoEm: new Date().toISOString(),
      }),
    );
    creditos = 3000;
    redeForaNaVenda = true;
    const escrito = capturarJanelaDoComprovante();
    const campo = abrirPdv();
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${CESTA.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    const pagamento = await screen.findByRole('dialog', { name: 'Pagamento' });
    fireEvent.click(await within(pagamento).findByRole('button', { name: /Usar crédito/ }));
    const valor = within(pagamento).getByPlaceholderText(/Vazio =/) as HTMLInputElement;
    fireEvent.change(valor, { target: { value: '100,00' } });
    fireEvent.submit(valor.closest('form')!);
    await waitFor(() => expect(within(pagamento).getAllByText(/Dinheiro/).length).toBeGreaterThan(0));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });

    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(within(dialogo).getByTestId('venda-concluida-troco').textContent).toMatch(/30,00/);
    expect(within(dialogo).getByTestId('venda-concluida-total').textContent).toMatch(/100,00/);
    expect(within(dialogo).getByTestId('venda-concluida-pagamentos').textContent).toContain('vale do cliente');

    const codigo = codigoDaVendaGuardada(chave);
    // O aviso da fila leva o mesmo código do papel.
    expect(screen.getAllByText(new RegExp(codigo)).length).toBeGreaterThan(0);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(escrito.length).toBeGreaterThan(0));
    const html = escrito.join('');
    expect(html).toContain(`código ${codigo}`);
    expect(html).not.toMatch(/<td>Desconto<\/td>/);
    expect(html).toMatch(/TOTAL<\/td><td class="r">R\$\s*100,00/);
  });
});

// ============================================================================

describe('D-pdv-teclado-14 — produto vendido por unidade não entra em pedaço', () => {
  it('"2,5*código" numa camiseta UN: a tela recusa com a frase do servidor, e nada entra', async () => {
    const campo = abrirPdv();
    bipar(campo, `2,5*${ARROZ.barcode}`);
    expect(await screen.findByText(/é vendido por unidade \(UN\): a quantidade precisa ser inteira/)).toBeTruthy();
    expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull();
  });
});

// ============================================================================

describe('PED-pdv-02 — o preço mudou entre o bipe e o Finalizar', () => {
  it('o 409 põe o preço novo na linha, fecha o pagamento, diz o que mudou — e o reenvio usa a mesma chave', async () => {
    respostaDaVenda = (n) =>
      n === 1
        ? responder(
            {
              error: {
                code: 'CORE_SALE_TOTAL_CHANGED',
                message: 'O preço mudou depois que o item entrou no carrinho.',
                details: {
                  linhas: [{ productId: 'p1', name: 'ARROZ X 5kg', informadoCents: 2190, vigenteCents: 1990, fonte: 'promocao' }],
                },
              },
            },
            409,
          )
        : null;
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    await screen.findByRole('dialog', { name: 'Pagamento' });
    await screen.findByPlaceholderText(/Vazio =/);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });

    expect(await screen.findByText(/mudou de R\$\s*21,90 para R\$\s*19,90 — confira com o cliente/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pagamento' })).toBeNull());
    expect(screen.getAllByText(/19,90/).length).toBeGreaterThan(0);

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas).toHaveLength(2);
    expect(vendas[1].chave).toBe(vendas[0].chave);
    expect(vendas[1].corpo.items?.[0].unitPriceCents).toBe(1990);
  });
});

// ============================================================================

describe('PED-pdv-03 — a busca sem conexão diz o que está acontecendo', () => {
  it('rede fora na busca: a faixa diz que é o servidor, e o que ainda dá para fazer', async () => {
    buscaForaDoAr = true;
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    expect(
      await screen.findByText(
        'Sem conexão com o servidor da loja — a busca de produto não funciona agora. Dá para finalizar só o carrinho que já está na tela.',
      ),
    ).toBeTruthy();
  });
});

// ============================================================================

describe('PED-pdv-06 — tecla segurada não é bipe', () => {
  /*
    O RELÓGIO DAS TECLAS É DO TESTE, E NÃO DA MÁQUINA.

    A tela reconhece o leitor pelo ritmo: menos de 50 ms entre uma tecla e a
    outra, medidos pelo `e.timeStamp` do evento. O `fireEvent.keyDown` deixa o
    jsdom carimbar cada evento com o relógio de parede — e aí o ritmo era o da
    CPU. Com a máquina saturada, o processo perdia a vez por mais de 50 ms no
    meio das treze teclas, a rajada zerava e a busca recebia só o pedaço final
    ("98215151784" no lugar de "7898215151784"): 6 de 25 rodadas vermelhas, sem
    defeito nenhum. E o caso da tecla segurada, pelo mesmo motivo, podia passar
    com o guarda do `repeat` fora — a pausa da CPU zerava a rajada no lugar dele.

    Cada tecla sai aqui com o carimbo escolhido (5 ms entre elas, o ritmo de um
    leitor): o limite de 50 ms é exercitado de propósito, não pela sorte do
    agendador.
  */
  const RITMO_DO_LEITOR_MS = 5;
  function tecla(alvo: Element, key: string, quando: number, extra: KeyboardEventInit = {}) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    Object.defineProperty(ev, 'timeStamp', { value: quando });
    fireEvent(alvo, ev);
  }

  it('seis repetições de uma tecla segurada e Enter no campo Quantidade não viram leitura', async () => {
    abrirPdv();
    const quantidade = screen.getByText('Quantidade').closest('label')!.querySelector('input')!;
    quantidade.focus();
    let quando = 1_000_000;
    for (let i = 0; i < 6; i += 1) tecla(quantidade, '1', (quando += RITMO_DO_LEITOR_MS), { repeat: true });
    tecla(quantidade, 'Enter', (quando += RITMO_DO_LEITOR_MS));
    await new Promise((r) => setTimeout(r, 30));
    expect(buscas).not.toContain('111111');
  });

  it('a rajada do leitor (sem repetição) continua sendo reconhecida', async () => {
    abrirPdv();
    const quantidade = screen.getByText('Quantidade').closest('label')!.querySelector('input')!;
    quantidade.focus();
    let quando = 1_000_000;
    for (const c of ARROZ.barcode) tecla(quantidade, c, (quando += RITMO_DO_LEITOR_MS));
    tecla(quantidade, 'Enter', (quando += RITMO_DO_LEITOR_MS));
    await waitFor(() => expect(buscas).toContain(ARROZ.barcode));
  });
});

// ============================================================================

describe('PED-pdv-07 — a vigília acompanha as últimas vendas, e não só a última', () => {
  it('a rejeição da venda A chega depois de a venda B fechar — e a faixa aparece com o número de A', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = { document: { id: 'doc-1', status: 'PENDING' }, statusLabel: 'Na fila' };
    statusDaNota['venda-2'] = { document: { id: 'doc-2', status: 'AUTHORIZED' }, statusLabel: 'Autorizada' };
    const campo = abrirPdv();
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());
    await venderRapido(campo, FEIJAO.barcode, FEIJAO.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    statusDaNota['venda-1'] = {
      document: { id: 'doc-1', status: 'REJECTED', cStat: '778', xMotivo: 'NCM inexistente' },
      statusLabel: 'NFC-e rejeitada',
    };
    const faixa = await screen.findByTestId('pdv-nota-sem-nota', {}, { timeout: 6000 });
    expect(faixa.textContent).toContain('#101');
    expect(faixa.textContent).toContain('REJEITADA');
  }, 10000);
});

// ============================================================================

describe('D-pdv-teclado-12 — o F6 deixa rastro', () => {
  it('cancelar o carrinho montado conta ao servidor o que saiu, com a chave e o caixa', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F6' });
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    fireEvent.click(within(pergunta).getByRole('button', { name: /Cancelar a venda/ }));

    await waitFor(() => expect(abandonos).toHaveLength(1));
    expect(abandonos[0]).toMatchObject({
      terminalId: 'cx1',
      items: [{ productId: 'p1', name: 'ARROZ X 5kg', quantity: 1, unitPriceCents: 2190 }],
    });
    expect(String(abandonos[0].saleKey)).toMatch(/^pdv-/);
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull());
  });

  it('o registro falhou: o carrinho sai mesmo assim, e a faixa diz que o rastro não subiu', async () => {
    abandonoFalha = true;
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F6' });
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    fireEvent.click(within(pergunta).getByRole('button', { name: /Cancelar a venda/ }));
    expect(await screen.findByText(/o registro do cancelamento não chegou ao servidor/)).toBeTruthy();
    expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull();
  });

  it('F6 com o carrinho vazio não registra nada', async () => {
    const campo = abrirPdv();
    fireEvent.keyDown(campo, { key: 'F6' });
    await new Promise((r) => setTimeout(r, 30));
    expect(abandonos).toHaveLength(0);
  });

  /*
    D-pdv-teclado-R02: com a pré-venda carregada, o F6 confirmado mandava as
    linhas DO DOCUMENTO para `POST /core/sales/abandoned` — a trilha ganhava um
    "carrinho cancelado" de R$ 87,00 de um documento que continua aberto e
    reservado, e que depois é faturado em outro caixa. O "soltar do balcão" do
    banner faz o mesmo gesto sem gravar nada. Como fica vermelho: tire de
    `cancelarVendaMontada` o desvio do documento carregado.
  */
  it('F6 com a pré-venda carregada: solta o documento do balcão, NÃO grava abandono, e a faixa diz que ela continua aberta', async () => {
    const campo = abrirPdv();
    fireEvent.keyDown(campo, { key: 'F9' });
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda #12/ }));
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${VESTIDO.name}`)).toBeTruthy());

    fireEvent.keyDown(campo, { key: 'F6' });
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    // A pergunta já não fala em cancelar: o documento não é cancelado.
    expect(pergunta.textContent).toMatch(/Pré-venda #12 NÃO é cancelada/);
    fireEvent.click(within(pergunta).getByRole('button', { name: /\(F6\)$/ }));

    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${VESTIDO.name}`)).toBeNull());
    expect(
      await screen.findByText(/Pré-venda #12 liberada do balcão\. Ela continua aberta no servidor, com a mercadoria reservada/),
    ).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(abandonos).toHaveLength(0);
  });

  /*
    Revisão do R02: a conversão fatura o DOCUMENTO (pagamentos, unidades e
    liberação — não as linhas). O item bipado por cima da pré-venda aparecia no
    carrinho e no total, não era vendido, e no F6 saía sem rastro. Como fica
    vermelho: tire de `addProduct` a recusa do documento no balcão.
  */
  it('pré-venda carregada: o bipe de um item a mais é recusado, com o caminho, e o carrinho segue o do documento', async () => {
    const campo = abrirPdv();
    fireEvent.keyDown(campo, { key: 'F9' });
    fireEvent.click(await screen.findByRole('button', { name: /Pré-venda #12/ }));
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${VESTIDO.name}`)).toBeTruthy());

    bipar(campo, ARROZ.barcode);
    expect(await screen.findByText(/Pré-venda #12 está no balcão, e o documento é faturado como foi escrito/)).toBeTruthy();
    expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull();
    expect(screen.getByLabelText(`Quantidade de ${VESTIDO.name}`)).toBeTruthy();
  });
});

// ============================================================================

describe('D-pdv-teclado-R01 — o bipe feito com o F8 no ar aposenta o painel da venda que saiu', () => {
  /*
    A leitura feita durante o POST espera a venda voltar e entra no carrinho
    novo — mas `addProduct` decidia aposentar o painel olhando `linhasRef`, que
    só é atualizada no render: o `setLines([])` do fim da venda ainda não tinha
    sido renderizado, a ref trazia o carrinho da venda que saiu, e o painel não
    era aposentado. Tirar o item com o ✕ devolvia à tela o painel da venda
    anterior — e o "imprimir comprovante" entregava ao próximo cliente o cupom
    do anterior. Como fica vermelho: tire de `limparVenda` o
    `linhasRef.current = []`.
  */
  it('bipe durante o POST e ✕ no item: o painel (e o "imprimir comprovante") da venda anterior NÃO volta', async () => {
    atrasoDaVenda = 150;
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F8' });
    bipar(campo, FEIJAO.barcode);

    await screen.findByRole('dialog', { name: 'Venda concluída' });
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeTruthy());
    expect(vendas).toHaveLength(1);
    expect(vendas[0].corpo.items?.map((i) => i.productId)).toEqual(['p1']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: `Remover ${FEIJAO.name}` }));
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('button', { name: 'imprimir comprovante' })).toBeNull();
  });

  it('sem a corrida (bipe depois da resposta), o mesmo gesto também não traz o painel de volta', async () => {
    const campo = abrirPdv();
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await screen.findByRole('button', { name: 'imprimir comprovante' });

    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: `Remover ${FEIJAO.name}` }));
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeNull());
    expect(screen.queryByRole('button', { name: 'imprimir comprovante' })).toBeNull();
  });
});
