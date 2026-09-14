/**
 * ============================================================================
 * PDV — AS RECUSAS DO FINALIZAR QUE O SERVIDOR PASSOU A MANDAR (auditoria PJ,
 * trilha "pdv", lote 6)
 * ============================================================================
 *
 *   A-produto-17#conversao-pdv  a conversão de pré-venda recusada pelo PISO
 *                       abria o diálogo do gestor, e a nova tentativa saía SEM
 *                       `authorizationId`: recusada de novo, num laço.
 *   G-offline-sync-07#pdv  a tela não dizia ao servidor quais preços foram
 *                       negociados (`precoNegociado`), e a venda retomada da
 *                       espera voltava com o preço da hora em que foi guardada.
 *   G-offline-sync-09#pdv  produto inativado entre o bipe e o Finalizar: a
 *                       recusa genérica, sem marcar a linha.
 *   E-venda-servidor-08#pdv  venda sem gaveta aberta (409
 *                       CORE_CASH_SESSION_REQUIRED): a frase no pagamento e
 *                       nenhuma saída — agora o caixa abre com o carrinho e a
 *                       chave intactos.
 *   H-caixa-seguranca-06#pdv  a gaveta de outro dia só abria o diálogo na
 *                       montagem, e não na releitura por foco da janela.
 *
 * Cada caso falha com o conserto tirado do `PdvPage.tsx`: o comentário de cada
 * conserto lá cita o id do achado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const SESSAO_KEY = 'gs.session';

function produto(id: string, nome: string, barcode: string, preco: number) {
  return {
    id,
    company_id: 'c1',
    name: nome,
    internal_code: `PJ-${id}`,
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
    unit: 'UN',
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
const TODOS = [ARROZ, FEIJAO];

type Corpo = Record<string, unknown> & {
  items?: { productId: string; quantity: number; unitPriceCents: number; precoNegociado?: boolean }[];
  payments?: { method: string; amountCents: number }[];
  cashSessionId?: string | null;
  authorizationId?: string;
};

const PRE_VENDA = {
  id: 'q-pre',
  number: 12,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: null,
  total_cents: 1780,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
  expired: false,
  liberacao: null,
};

/*
  A RECUSA DA CONVERSÃO PELO PISO, no formato de `SalesService` (403 com a
  concessão e `abaixoDoPiso`). O dublê é RIGOROSO: só aceita a conversão que traz
  a liberação — aceitar sem conferir deixaria o teste verde com a tela reenviando
  vazio, que é exatamente o defeito.
*/
const RECUSA_DO_PISO = {
  error: {
    code: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
    message:
      '"FEIJÃO CARIOCA 1kg" sai a R$ 8,90 a unidade, abaixo do piso de R$ 9,50 (preço mínimo do produto). '
      + 'Documento abaixo do piso de preço do produto precisa da liberação de um gestor.',
    details: {
      percentual: 0,
      concedidoCents: 0,
      brutoCents: 1780,
      origens: { cabecalho: 0, itens: 0, precoRebaixado: 0 },
      limite: 10,
      abaixoDoPiso: [{ productId: 'p2', name: 'FEIJÃO CARIOCA 1kg', pisoCents: 950 }],
    },
  },
};

const LIBERACAO = {
  id: 'auth-1',
  action: 'desconto_acima_limite',
  authorizedBy: 'u-gerente',
  authorizedByName: 'Gerente',
  createdAt: '2026-09-14T12:00:00.000Z',
  grantedConcessionCents: 0,
  grantedGrossCents: 1780,
};

let vendas: { corpo: Corpo; chave: string }[];
let conversoes: { corpo: Corpo; chave: string }[];
let respostaDaVenda: ((n: number) => Response | null) | null;
/** Resposta especial para a n-ésima conversão de documento (revisão do G-offline-sync-09). */
let respostaDaConversao: ((n: number) => Response | null) | null;
let precoAtual: Record<string, number>;
let pedidosDePreco: { customerId: string | null; items: { productId: string; quantity: number }[] }[];
/** A pergunta de preço cai por falta de rede (G-offline-sync-07, reauditoria). */
let precoForaDoAr: boolean;
/** O que `GET /core/cash/open` responde agora. */
let estadoDoCaixa: 'aberto' | 'erro' | 'sem-gaveta' | 'de-outro-dia';
let sessaoAtual: Record<string, unknown>;
let consultasDoCaixa: number;
let aberturas: Record<string, unknown>[];

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(
    // `HeadersInit` é só tipo e o no-undef do lint não o conhece: o mesmo tipo, pelo construtor `Headers`.
    async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: ConstructorParameters<typeof Headers>[0] }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpoDoPedido = () => JSON.parse(init?.body ?? '{}') as Corpo;
      const chaveDoPedido = () => new Headers(init?.headers).get('Idempotency-Key') ?? '';

      if (alvo.includes('/core/products/search')) {
        const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
        return responder({ items: TODOS.filter((p) => p.barcode === q), catalogoVazio: false });
      }
      const umProduto = alvo.match(/\/core\/products\/(p\d)$/);
      if (umProduto) return responder(TODOS.find((p) => p.id === umProduto[1]));
      if (alvo.includes('/core/units')) return responder({ items: [] });
      if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
        const corpo = JSON.parse(init?.body ?? '{}') as (typeof pedidosDePreco)[number];
        pedidosDePreco.push(corpo);
        if (precoForaDoAr) throw new TypeError('Failed to fetch');
        return responder({
          items: corpo.items.map((i) => {
            const p = TODOS.find((x) => x.id === i.productId)!;
            return {
              productId: i.productId,
              priceCents: precoAtual[i.productId] ?? p.effective_price_cents,
              listPriceCents: p.price_cents,
              onSale: false,
              fonte: 'cadastro',
            };
          }),
          priceTable: null,
        });
      }
      if (alvo.includes('/core/authorizations') && metodo === 'POST') return responder(LIBERACAO, 201);
      if (alvo.includes('/core/quotes/q-pre/convert') && metodo === 'POST') {
        const corpo = corpoDoPedido();
        conversoes.push({ corpo, chave: chaveDoPedido() });
        const especial = respostaDaConversao?.(conversoes.length);
        if (especial) return especial;
        if (!corpo.authorizationId) return responder(RECUSA_DO_PISO, 403);
        return responder({ saleId: 'venda-conv', number: 345 }, 201);
      }
      if (/\/core\/quotes\/q-pre$/.test(alvo)) {
        return responder({
          ...PRE_VENDA,
          items: [
            { id: 'i-1', product_id: 'p2', description: 'FEIJÃO CARIOCA 1kg', quantity: 2, unit_price_cents: 890, total_cents: 1780 },
          ],
        });
      }
      if (alvo.includes('/core/quotes')) return responder({ items: [PRE_VENDA] });
      if (alvo.includes('/core/sales/discount-policy')) {
        return responder({ operatorLimitPercent: 10, canAuthorizeSelf: false });
      }
      if (/\/core\/sales\/venda-[\w-]+$/.test(alvo) && metodo === 'GET') return responder({});
      if (alvo.includes('/core/sales') && metodo === 'POST') {
        const corpo = corpoDoPedido();
        vendas.push({ corpo, chave: chaveDoPedido() });
        const n = vendas.length;
        const especial = respostaDaVenda?.(n);
        if (especial) return especial;
        const total = (corpo.items ?? []).reduce((s, i) => s + Math.round(i.unitPriceCents * i.quantity), 0);
        const pago = (corpo.payments ?? []).reduce((s, p) => s + p.amountCents, 0);
        return responder(
          {
            id: `venda-${n}`,
            number: 100 + n,
            subtotal_cents: total,
            discount_cents: 0,
            surcharge_cents: 0,
            total_cents: total,
            change_cents: Math.max(0, pago - total),
            nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: [] },
          },
          201,
        );
      }
      if (alvo.includes('/core/cash/open') && metodo === 'GET') {
        consultasDoCaixa += 1;
        if (estadoDoCaixa === 'erro') {
          return responder({ error: { code: 'CORE_INTERNAL', message: 'Falha interna ao ler o caixa.' } }, 500);
        }
        return responder({
          session: estadoDoCaixa === 'sem-gaveta' ? null : sessaoAtual,
          cashWithdrawalLimitCents: null,
          terminal: null,
          terminalDoDispositivo: false,
          terminalRecusado: null,
          terminaisAtivos: 0,
          exigeTerminal: false,
          deOutroDia:
            estadoDoCaixa === 'de-outro-dia' ? { abertaNoDia: '2026-09-13', hoje: '2026-09-14', dias: 1 } : null,
        });
      }
      if (alvo.includes('/core/cash/open') && metodo === 'POST') {
        const corpo = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        aberturas.push(corpo);
        sessaoAtual = {
          id: 'sessao-nova',
          terminal_id: null,
          opening_cents: corpo.openingCents,
          status: 'open',
          opened_at: new Date().toISOString(),
        };
        estadoDoCaixa = 'aberto';
        return responder(sessaoAtual, 201);
      }
      if (alvo.includes('/summary')) {
        return responder({ expectedCents: 20000, byMethod: [], movements: [], changeCents: 0 });
      }
      if (alvo.includes('/core/fiscal/pdv-summary')) {
        return responder({ situacao: 'READY', pendencyCount: 0, motivos: [] });
      }
      if (alvo.includes('/core/print/drawer')) {
        return responder({ byCommand: false, agentPrinters: 0, message: 'A gaveta abre pela chave.', command: '' });
      }
      if (alvo.includes('/core/payment-methods')) {
        return responder({
          methods: [
            { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
            { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
          ],
        });
      }
      if (alvo.includes('/pdv/terminal/status')) {
        return responder({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      if (alvo.includes('/pdv/pix-asaas/status')) {
        return responder({ disponivel: false, ambiente: null, motivo: 'Sem PIX integrado.' });
      }
      return responder({ items: [] });
    },
  );
}

function abrirPdv(rota = '/pdv') {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <PdvPage />
    </MemoryRouter>,
  );
  return screen.getByLabelText(/Pesquise por código/) as HTMLInputElement;
}

function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: campo.value + codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

async function biparEEsperar(campo: HTMLInputElement, p: { barcode: string; name: string }) {
  bipar(campo, p.barcode);
  await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${p.name}`)).toBeTruthy());
}

/** Abre o pagamento (F10) e finaliza pelo valor que ele propõe. */
async function pagarPeloDialogo(campo: HTMLInputElement) {
  fireEvent.keyDown(campo, { key: 'F10' });
  await screen.findByRole('dialog', { name: 'Pagamento' });
  await screen.findByPlaceholderText(/Vazio =/, {}, { timeout: 4000 });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });
}

function linhaDe(nome: string) {
  return screen.getByLabelText(`Quantidade de ${nome}`).closest('li');
}

beforeEach(() => {
  vendas = [];
  conversoes = [];
  respostaDaVenda = null;
  respostaDaConversao = null;
  precoAtual = {};
  pedidosDePreco = [];
  precoForaDoAr = false;
  estadoDoCaixa = 'aberto';
  sessaoAtual = {
    id: 'sessao-teste',
    terminal_id: null,
    opening_cents: 20000,
    status: 'open',
    opened_at: new Date().toISOString(),
  };
  consultasDoCaixa = 0;
  aberturas = [];
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    SESSAO_KEY,
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

// ============================================================================

describe('A-produto-17#conversao-pdv — a liberação do gestor vai na conversão', () => {
  it('pré-venda abaixo do piso: o gestor libera e a NOVA tentativa leva o authorizationId e fatura', async () => {
    abrirPdv('/pdv?documento=q-pre');
    await waitFor(() => expect(screen.getAllByText(/pré-venda #12/i)[0]).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
    await screen.findByLabelText('Autorização do gestor');
    expect(conversoes).toHaveLength(1);
    expect(conversoes[0].corpo.authorizationId).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'gerente' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    // Sem o conserto a segunda conversão sai sem a liberação, o dublê recusa de
    // novo e a pré-venda nunca é faturada.
    expect((await screen.findAllByText(/#12 faturad[oa] — venda #345/i)).length).toBeGreaterThan(0);
    expect(conversoes).toHaveLength(2);
    expect(conversoes[1].corpo.authorizationId).toBe('auth-1');
    // A mesma finalização: nada foi gravado na recusa, e a chave é a mesma.
    expect(conversoes[1].chave).toBe(conversoes[0].chave);
  });
});

// ============================================================================

describe('G-offline-sync-07#pdv — quem escreveu o preço, e a espera no preço de agora', () => {
  it('a linha da busca vai com precoNegociado:false; a de preço digitado, com true', async () => {
    const campo = abrirPdv();
    await biparEEsperar(campo, ARROZ);
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '8,90' } });
    await biparEEsperar(campo, FEIJAO);

    fireEvent.keyDown(campo, { key: 'F8' });
    await waitFor(() => expect(vendas).toHaveLength(1));
    const itens = vendas[0].corpo.items ?? [];
    expect(itens.find((i) => i.productId === 'p1')?.precoNegociado).toBe(false);
    expect(itens.find((i) => i.productId === 'p2')?.precoNegociado).toBe(true);
  });

  it('retomar a espera pergunta o preço de TODAS as linhas, diz o que mudou e a venda sai pelo vigente', async () => {
    const campo = abrirPdv();
    // A espera é do turno: sem a gaveta carregada ela iria para o escopo "sem caixa".
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await screen.findAllByText(/Caixa aberto/);
    await biparEEsperar(campo, ARROZ);
    fireEvent.click(screen.getByRole('button', { name: 'Aguardar (F7)' }));
    const faixa = await screen.findByTestId('pdv-esperas');
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull());

    // O gestor subiu o preço enquanto a venda estava parada.
    precoAtual.p1 = 2390;
    const pedidosAntes = pedidosDePreco.length;
    fireEvent.click(within(faixa).getByRole('button', { name: /^1 item\(ns\)/ }));

    expect(
      await screen.findByText(
        /O preço mudou desde que a venda foi guardada — "ARROZ X 5kg" de R\$\s*21,90 para R\$\s*23,90/,
      ),
    ).toBeTruthy();
    // A linha da espera tinha a marca "em dia" — sem o conserto ninguém perguntava.
    expect(pedidosDePreco.slice(pedidosAntes).some((p) => p.items.some((i) => i.productId === 'p1'))).toBe(true);

    fireEvent.keyDown(campo, { key: 'F8' });
    await waitFor(() => expect(vendas).toHaveLength(1));
    expect(vendas[0].corpo.items?.[0]).toMatchObject({ productId: 'p1', unitPriceCents: 2390, precoNegociado: false });
  });

  /*
    Reauditoria: a pergunta de preço da retomada FALHOU (sem rede) e a linha
    continuava com a marca "em dia" gravada na espera. A faixa dizia "o
    Finalizar confere", mas o Finalizar não via linha pendente: a venda saía
    pelo preço da hora em que foi guardada, e o servidor lançava a diferença
    como concessão do operador ("preço de tela desatualizado"). Como fica
    vermelho: tire de `pdvEmEspera.retomar` a remoção da marca de preço.
  */
  it('reauditoria — a pergunta da retomada falhou: o Finalizar pergunta de novo e a venda sai pelo vigente', async () => {
    const campo = abrirPdv();
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await screen.findAllByText(/Caixa aberto/);
    await biparEEsperar(campo, ARROZ);
    fireEvent.click(screen.getByRole('button', { name: 'Aguardar (F7)' }));
    const faixa = await screen.findByTestId('pdv-esperas');
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull());

    precoAtual.p1 = 2390;
    precoForaDoAr = true;
    fireEvent.click(within(faixa).getByRole('button', { name: /^1 item\(ns\)/ }));
    expect(
      await screen.findByText(/os preços da venda guardada não foram conferidos; o Finalizar confere/),
    ).toBeTruthy();
    expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy();

    // A rede voltou. O Finalizar é quem confere — como a faixa prometeu.
    precoForaDoAr = false;
    const pedidosAntes = pedidosDePreco.length;
    fireEvent.keyDown(campo, { key: 'F8' });
    await waitFor(() => expect(vendas).toHaveLength(1));
    expect(pedidosDePreco.slice(pedidosAntes).some((p) => p.items.some((i) => i.productId === 'p1'))).toBe(true);
    expect(vendas[0].corpo.items?.[0]).toMatchObject({ productId: 'p1', unitPriceCents: 2390, precoNegociado: false });
  });

  it('reauditoria — enquanto a retomada pergunta, o efeito do carrinho não repete a MESMA pergunta', async () => {
    const campo = abrirPdv();
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await screen.findAllByText(/Caixa aberto/);
    await biparEEsperar(campo, ARROZ);
    fireEvent.click(screen.getByRole('button', { name: 'Aguardar (F7)' }));
    const faixa = await screen.findByTestId('pdv-esperas');
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull());

    precoAtual.p1 = 2390;
    const pedidosAntes = pedidosDePreco.length;
    fireEvent.click(within(faixa).getByRole('button', { name: /^1 item\(ns\)/ }));
    await screen.findByText(/O preço mudou desde que a venda foi guardada/);
    await new Promise((r) => setTimeout(r, 30));
    const perguntasDoArroz = pedidosDePreco
      .slice(pedidosAntes)
      .filter((p) => p.items.some((i) => i.productId === 'p1'));
    expect(perguntasDoArroz).toHaveLength(1);
  });
});

// ============================================================================

describe('G-offline-sync-09#pdv — o produto inativado entre o bipe e o Finalizar', () => {
  it('fecha o pagamento, marca a linha, diz o nome — e tirar a linha deixa finalizar', async () => {
    respostaDaVenda = (n) =>
      n === 1
        ? responder(
            {
              error: {
                code: 'CORE_PRODUCT_NOT_FOUND',
                message:
                  '"ARROZ X 5kg" não pode mais ser vendido: ele foi inativado em Produtos. Tire a linha do carrinho '
                  + '— ou, se a venda já aconteceu, reative o produto e relance.',
                details: { productId: 'p1', name: 'ARROZ X 5kg', inativo: true },
              },
            },
            404,
          )
        : null;
    const campo = abrirPdv();
    await biparEEsperar(campo, ARROZ);
    await biparEEsperar(campo, FEIJAO);
    await pagarPeloDialogo(campo);

    expect(
      await screen.findByText(
        'A venda NÃO foi registrada: "ARROZ X 5kg" foi inativado no cadastro — tire do carrinho para finalizar.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pagamento' })).toBeNull());
    expect(linhaDe(ARROZ.name)?.getAttribute('data-linha-ofensora')).toBe('sim');
    expect(linhaDe(FEIJAO.name)?.getAttribute('data-linha-ofensora')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Tirar do carrinho' }));
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${ARROZ.name}`)).toBeNull());
    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[1].corpo.items?.map((i) => i.productId)).toEqual(['p2']);
  });

  it('revisão — com pré-venda no balcão: a frase fala "da pré-venda", manda editar o documento e não oferece o botão', async () => {
    respostaDaConversao = () =>
      responder(
        {
          error: {
            code: 'CORE_PRODUCT_NOT_FOUND',
            message:
              '"FEIJÃO CARIOCA 1kg" não pode mais ser vendido: ele foi inativado em Produtos. Tire a linha do '
              + 'carrinho — ou, se a venda já aconteceu, reative o produto e relance.',
            details: { productId: 'p2', name: 'FEIJÃO CARIOCA 1kg', inativo: true },
          },
        },
        404,
      );
    abrirPdv('/pdv?documento=q-pre');
    await waitFor(() => expect(screen.getAllByText(/pré-venda #12/i)[0]).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
    // Era "tire o item do Pré-venda em Orçamentos": maiúscula no meio da frase e no masculino.
    expect(
      await screen.findByText(
        'A venda NÃO foi registrada: "FEIJÃO CARIOCA 1kg" da pré-venda foi inativado no cadastro — tire o '
          + 'item da pré-venda em Orçamentos (ou reative o produto) para faturar.',
      ),
    ).toBeTruthy();
    // Tirar a linha da tela não muda o documento que a conversão fatura.
    expect(screen.queryByRole('button', { name: 'Tirar do carrinho' })).toBeNull();
  });
});

// ============================================================================

describe('E-venda-servidor-08#pdv — a venda sem gaveta aberta abre o caixa, e a venda continua', () => {
  it('409 CORE_CASH_SESSION_REQUIRED: fecha o pagamento, abre o caixa com o carrinho, e finaliza a MESMA venda', async () => {
    // A consulta do caixa falhou na entrada: a tela não sabe da gaveta e não
    // trava a venda — é o servidor quem recusa.
    estadoDoCaixa = 'erro';
    respostaDaVenda = (n) => {
      if (n !== 1) return null;
      // Relida a gaveta depois da recusa, o servidor diz que não há nenhuma.
      estadoDoCaixa = 'sem-gaveta';
      return responder(
        {
          error: {
            code: 'CORE_CASH_SESSION_REQUIRED',
            message:
              'Não há caixa aberto agora. Abra o caixa antes de vender: a venda no cartão ou no PIX também entra '
              + 'no fechamento do turno, e sem turno ela some da conferência da maquininha.',
            details: { valorCents: 0 },
          },
        },
        409,
      );
    };
    const campo = abrirPdv();
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await biparEEsperar(campo, ARROZ);
    await pagarPeloDialogo(campo);

    const dialogo = await screen.findByTestId('caixa-pdv');
    expect(within(dialogo).getByTestId('caixa-aviso-da-venda').textContent).toMatch(
      /Não há caixa aberto agora\..*A venda NÃO foi registrada; o carrinho continua na tela/,
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pagamento' })).toBeNull());
    expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy();

    fireEvent.change(await within(dialogo).findByLabelText('Fundo de troco'), { target: { value: '100,00' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Abrir caixa' }));
    await waitFor(() => expect(aberturas).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('caixa-pdv')).toBeNull());

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas).toHaveLength(2);
    // A mesma venda: mesma chave, agora com a gaveta que acabou de abrir.
    expect(vendas[1].chave).toBe(vendas[0].chave);
    expect(vendas[1].corpo.cashSessionId).toBe('sessao-nova');
  });

  it('revisão — várias gavetas abertas: o aviso manda ESCOLHER o caixa, e não abrir outro', async () => {
    estadoDoCaixa = 'erro';
    respostaDaVenda = (n) => {
      if (n !== 1) return null;
      estadoDoCaixa = 'sem-gaveta';
      return responder(
        {
          error: {
            code: 'CORE_CASH_SESSION_REQUIRED',
            message:
              'Há 2 gavetas abertas e a venda não disse de qual caixa ela é. Escolha o caixa deste computador '
              + 'no PDV: a venda no cartão ou no PIX também entra no fechamento do turno.',
            details: {
              valorCents: 0,
              gavetasAbertas: [
                { sessionId: 's-a', terminalId: 't-a', terminalName: 'Caixa 1' },
                { sessionId: 's-b', terminalId: 't-b', terminalName: 'Caixa 2' },
              ],
            },
          },
        },
        409,
      );
    };
    const campo = abrirPdv();
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await biparEEsperar(campo, ARROZ);
    await pagarPeloDialogo(campo);

    const dialogo = await screen.findByTestId('caixa-pdv');
    const aviso = within(dialogo).getByTestId('caixa-aviso-da-venda').textContent ?? '';
    expect(aviso).toMatch(/o carrinho continua na tela — escolha o caixa deste computador e finalize de novo\.$/);
    expect(aviso).not.toMatch(/abra o caixa/);
  });
});

// ============================================================================

describe('H-caixa-seguranca-06#pdv — a gaveta que vira "de outro dia" com o PDV aberto', () => {
  it('a releitura por foco abre o diálogo com o aviso — uma vez por gaveta', async () => {
    abrirPdv();
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await screen.findAllByText(/Caixa aberto/);
    expect(screen.queryByTestId('caixa-pdv')).toBeNull();

    // Meia-noite passou com o computador ligado: a mesma gaveta agora é de ontem.
    estadoDoCaixa = 'de-outro-dia';
    fireEvent.focus(window);

    const dialogo = await screen.findByTestId('caixa-pdv');
    expect(within(dialogo).getByTestId('gaveta-de-outro-dia').textContent).toMatch(/13\/09\/2026/);
    fireEvent.click(within(dialogo).getByRole('button', { name: /^fechar$/i }));
    await waitFor(() => expect(screen.queryByTestId('caixa-pdv')).toBeNull());

    // Fechar é decisão do operador: a próxima volta de foco não reabre.
    const antes = consultasDoCaixa;
    fireEvent.focus(window);
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(antes));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('caixa-pdv')).toBeNull();
    // A faixa do balcão continua dizendo.
    expect(screen.getByTestId('gaveta-de-outro-dia')).toBeTruthy();
  });

  it('revisão — com o pagamento na tela o aviso espera: não sobe por trás do pagamento, e sobe quando ele fecha', async () => {
    const campo = abrirPdv();
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(0));
    await screen.findAllByText(/Caixa aberto/);
    await biparEEsperar(campo, ARROZ);
    fireEvent.keyDown(campo, { key: 'F10' });
    await screen.findByRole('dialog', { name: 'Pagamento' });

    // O operador volta do aplicativo da maquininha depois da meia-noite.
    estadoDoCaixa = 'de-outro-dia';
    const antes = consultasDoCaixa;
    fireEvent.focus(window);
    await waitFor(() => expect(consultasDoCaixa).toBeGreaterThan(antes));
    await new Promise((r) => setTimeout(r, 30));
    // Sem a espera, o diálogo do caixa subia no topo da pilha de foco, por trás
    // do pagamento — e o pagamento parava de responder às teclas.
    expect(screen.queryByTestId('caixa-pdv')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Pagamento' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Voltar \(Esc\)/ }));
    const dialogo = await screen.findByTestId('caixa-pdv');
    expect(within(dialogo).getByTestId('gaveta-de-outro-dia').textContent).toMatch(/13\/09\/2026/);
    // O carrinho continua.
    expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy();
  });
});
