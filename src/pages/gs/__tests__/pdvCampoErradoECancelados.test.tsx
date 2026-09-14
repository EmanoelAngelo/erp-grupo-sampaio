/**
 * O CARRINHO NÃO PERDE ITEM, NÃO ESCONDE SAÍDA E NÃO SOME.
 *
 *   D-pdv-teclado-05  o bipe que caía no campo da linha virava quantidade
 *                     astronômica, e o produto bipado não entrava.
 *   D-pdv-teclado-07  reduzir a quantidade (campo, Alt+↓, quantidade negativa)
 *                     tirava mercadoria sem rastro em "Itens cancelados".
 *   D-pdv-teclado-M02 o rascunho do campo da linha ficava velho e mostrava um
 *                     número enquanto a venda cobrava outro.
 *   D-pdv-teclado-M06 o pesável não aceitava a correção decimal na linha.
 *   D-pdv-teclado-12  F6 apagava a venda sem perguntar.
 *   D-pdv-teclado-M01 retomar/pôr em espera com documento no balcão.
 *   D-pdv-teclado-M05 o rastro de cancelados trocava de carrinho na espera.
 *   D-pdv-teclado-06  F5 no meio da venda perdia o carrinho.
 *   D-pdv-teclado-20  a piscada de rede na volta do foco escondia as esperas.
 *   D-pdv-teclado-18  F6/F1/F3 com diálogo aberto iam para o navegador.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: vi.fn(async () => ({ via: 'navegador', aviso: null })),
}));

function produto(id: string, nome: string, barcode: string, preco: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    company_id: 'loja',
    name: nome,
    internal_code: `GS-00000${id.slice(-1)}`,
    sku: null,
    barcode,
    category: null,
    brand: null,
    cost_cents: 0,
    min_stock: 0,
    price_cents: preco,
    effective_price_cents: preco,
    on_sale: false,
    stock_quantity: 50,
    unit: 'UN',
    kind: 'retail',
    active: 1,
    serialized: 0,
    is_kit: 0,
    open_price: 0,
    weighable: 0,
    stock_control: 1,
    workshop_name: null,
    ...extra,
  };
}

const ARROZ = produto('p1', 'ARROZ X 5kg', '7898215151784', 2190);
const FEIJAO = produto('p2', 'FEIJÃO CARIOCA 1kg', '7896006711116', 890);
const CABO = produto('p3', 'CABO HDMI', '7891000000031', 1500);
const BANANA = produto('p6', 'BANANA PRATA KG', '2000000000060', 599, { weighable: 1, unit: 'KG' });
const TODOS = [ARROZ, FEIJAO, CABO, BANANA];

const PRE_VENDA = {
  id: 'q-pre',
  number: 12,
  kind: 'pre_venda',
  status: 'aberto',
  customer_id: null,
  total_cents: 1500,
  discount_cents: 0,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

let vendas: { corpo: Record<string, unknown>; chave: string | null }[];
let caixaFalha: boolean;

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      const exato = TODOS.filter((p) => p.barcode === q || p.internal_code === q);
      const porNome = TODOS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
      return responder({ items: exato.length ? exato : porNome, catalogoVazio: false });
    }
    const umProduto = alvo.match(/\/core\/products\/(p\d)$/);
    if (umProduto) return responder(TODOS.find((p) => p.id === umProduto[1]));
    if (alvo.includes('/core/units')) return responder({ items: [] });
    const documento = alvo.match(/\/core\/quotes\/([^/?]+)$/);
    if (documento && metodo === 'GET') {
      return responder({
        ...PRE_VENDA,
        expired: false,
        liberacao: null,
        items: [{ id: 'i-1', product_id: 'p3', description: 'CABO HDMI', quantity: 1, unit_price_cents: 1500, total_cents: 1500 }],
      });
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}');
      vendas.push({ corpo, chave: init?.headers?.['Idempotency-Key'] ?? null });
      const n = vendas.length;
      return responder(
        {
          id: `venda-${n}`,
          number: 100 + n,
          subtotal_cents: 0,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: 1000,
          change_cents: 0,
          nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: [] },
        },
        201,
      );
    }
    if (alvo.includes('/core/cash/open')) {
      if (caixaFalha) return responder({ error: { code: 'API_UNAVAILABLE', message: 'Servidor ocupado.' } }, 503);
      return responder({ session: { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' }, cashWithdrawalLimitCents: null });
    }
    if (alvo.includes('/core/payment-methods')) {
      return responder({
        methods: [
          { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
          { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
        ],
      });
    }
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
    'teste do carrinho que não perde item',
  );
}

function abrirPdv(entrada = '/pdv') {
  render(
    <MemoryRouter initialEntries={[entrada]}>
      <PdvPage />
    </MemoryRouter>,
  );
  return screen.getByLabelText(/Pesquise por código/) as HTMLInputElement;
}

function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: campo.value + codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

const qtdDa = (nome: string) => screen.queryByLabelText(`Quantidade de ${nome}`) as HTMLInputElement | null;

function itensCancelados(): string {
  return screen.getByText('Itens cancelados:').parentElement!.querySelector('strong')!.textContent ?? '';
}

/** Uma tecla com o carimbo de tempo escolhido — o ritmo é o que distingue o leitor da pessoa. */
function tecla(alvo: Element, key: string, quando: number) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'timeStamp', { value: quando });
  fireEvent(alvo, ev);
}

function guardarEspera(id: string, rotulo: string, lines: unknown[]) {
  const atuais = JSON.parse(localStorage.getItem('gs.pdv.emEspera') ?? '[]') as unknown[];
  localStorage.setItem(
    'gs.pdv.emEspera',
    JSON.stringify([
      ...atuais,
      { id, escopo: 'sessao-teste', rotulo, criadoEm: new Date().toISOString(), lines, customerId: null, customerName: null, discount: 0, note: '' },
    ]),
  );
}

beforeEach(() => {
  vendas = [];
  caixaFalha = false;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste do carrinho');
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('D-05: o bipe no campo errado', () => {
  it('rajada do leitor no campo da linha: a linha volta ao que era, e o produto bipado entra', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    const qtd = qtdDa(ARROZ.name)!;
    qtd.focus();
    fireEvent.change(qtd, { target: { value: '3' } });

    let quando = 1_000_000;
    let escrito = '3';
    for (const c of FEIJAO.barcode) {
      tecla(qtd, c, (quando += 5));
      escrito += c;
      fireEvent.change(qtd, { target: { value: escrito } });
    }
    tecla(qtd, 'Enter', (quando += 5));

    await waitFor(() => expect(qtdDa(FEIJAO.name)).toBeTruthy());
    expect(qtdDa(ARROZ.name)!.value).toBe('3');
    expect(document.activeElement).toBe(campo);
  });

  it('Enter no campo da linha devolve o leitor ao campo de leitura', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    const qtd = qtdDa(ARROZ.name)!;
    qtd.focus();
    fireEvent.change(qtd, { target: { value: '2' } });
    fireEvent.keyDown(qtd, { key: 'Enter' });
    expect(document.activeElement).toBe(campo);
  });
});

describe('D-07: reduzir quantidade deixa rastro', () => {
  it('5 → 2 no campo da linha: 3 em "Itens cancelados", e no POST', async () => {
    const campo = abrirPdv();
    bipar(campo, `5*${ARROZ.barcode}`);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('5'));
    const qtd = qtdDa(ARROZ.name)!;
    qtd.focus();
    fireEvent.change(qtd, { target: { value: '2' } });
    fireEvent.blur(qtd);
    await waitFor(() => expect(itensCancelados()).toBe('3'));

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    const cancelados = vendas[0].corpo.cancelledItems as { productId: string; quantity: number }[];
    expect(cancelados).toHaveLength(1);
    expect(cancelados[0]).toMatchObject({ productId: 'p1', quantity: 3 });
  });

  /*
    Revisão: a redução só era medida no blur/Enter do campo da linha. F8 (ou F7)
    com o foco AINDA no campo não tira o foco dele, e a venda saía com o rastro
    vazio. Como fica vermelho: tire `fecharReducoesEmDigitacao` do Finalizar (ou
    da espera).
  */
  it('5 → 2 e F8 com o foco AINDA no campo da linha: a saída vai no POST, uma vez só', async () => {
    const campo = abrirPdv();
    bipar(campo, `5*${ARROZ.barcode}`);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('5'));
    const qtd = qtdDa(ARROZ.name)!;
    qtd.focus();
    fireEvent.change(qtd, { target: { value: '2' } });
    // Sem blur e sem Enter: o F8 sai do próprio campo da linha.
    fireEvent.keyDown(qtd, { key: 'F8' });

    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(campo).toBeTruthy();
    const cancelados = vendas[0].corpo.cancelledItems as { productId: string; quantity: number }[];
    expect(cancelados).toHaveLength(1);
    expect(cancelados[0]).toMatchObject({ productId: 'p1', quantity: 3 });
  });

  it('5 → 2 e F7 com o foco no campo da linha: a espera leva a saída junto', async () => {
    const campo = abrirPdv();
    bipar(campo, `5*${ARROZ.barcode}`);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('5'));
    const qtd = qtdDa(ARROZ.name)!;
    qtd.focus();
    fireEvent.change(qtd, { target: { value: '2' } });
    fireEvent.keyDown(qtd, { key: 'F7' });

    await screen.findByText(/Em espera: \d+ item/);
    expect(campo).toBeTruthy();
    const esperas = JSON.parse(localStorage.getItem('gs.pdv.emEspera') ?? '[]') as {
      removidos?: { productId: string; quantity: number }[];
    }[];
    expect(esperas).toHaveLength(1);
    expect(esperas[0].removidos).toEqual([expect.objectContaining({ productId: 'p1', quantity: 3 })]);
  });

  it('Alt+↓ tira uma unidade e registra a saída', async () => {
    const campo = abrirPdv();
    bipar(campo, `3*${ARROZ.barcode}`);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('3'));
    fireEvent.keyDown(campo, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('2'));
    expect(itensCancelados()).toBe('1');
  });

  it('quantidade negativa não tira item da venda: a tela recusa e a linha fica', async () => {
    const campo = abrirPdv();
    bipar(campo, `2*${ARROZ.barcode}`);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('2'));
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '-2' } });
    bipar(campo, ARROZ.barcode);
    await screen.findByText(/Quantidade inválida/);
    expect(qtdDa(ARROZ.name)?.value).toBe('2');
  });
});

describe('M02: o campo da linha mostra o que a venda cobra', () => {
  it('Alt+↑ e nova leitura do mesmo produto: o campo acompanha a linha', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('2'));
    fireEvent.keyDown(campo, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('3'));
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)?.value).toBe('4'));
  });

  it('desconto digitado numa linha removida não reaparece na linha nova', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(`Desconto de ${ARROZ.name}`), { target: { value: '5,00' } });
    fireEvent.keyDown(campo, { key: 'Delete', ctrlKey: true });
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeNull());
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    expect((screen.getByLabelText(`Desconto de ${ARROZ.name}`) as HTMLInputElement).value).toBe('');
  });
});

describe('M06: o pesável corrige na linha', () => {
  it('1,25 kg corrigido para 1,5 kg: a venda leva 1,5', async () => {
    const campo = abrirPdv();
    bipar(campo, `1,25*${BANANA.barcode}`);
    await waitFor(() => expect(qtdDa(BANANA.name)?.value).toBe('1,25'));
    const qtd = qtdDa(BANANA.name)!;
    qtd.focus();
    fireEvent.change(qtd, { target: { value: '1,5' } });
    fireEvent.blur(qtd);
    await waitFor(() => expect(qtdDa(BANANA.name)?.value).toBe('1,5'));

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect((vendas[0].corpo.items as { quantity: number }[])[0].quantity).toBe(1.5);
  });
});

describe('D-12: F6 pergunta antes de apagar', () => {
  it('F6 com itens: pergunta com o foco em "Voltar"; Esc mantém; F6 de novo cancela', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());

    fireEvent.keyDown(campo, { key: 'F6' });
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    expect(qtdDa(ARROZ.name)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Voltar ao carrinho'));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pdv-confirmar-cancelamento')).toBeNull());
    expect(qtdDa(ARROZ.name)).toBeTruthy();
    expect(pergunta.isConnected).toBe(false);

    fireEvent.keyDown(campo, { key: 'F6' });
    await screen.findByTestId('pdv-confirmar-cancelamento');
    fireEvent.keyDown(document.activeElement!, { key: 'F6' });
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeNull());
  });

  it('o botão "Cancelar a venda" da pergunta limpa o carrinho', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Cancelar \(F6\)$/ }));
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    fireEvent.click(within(pergunta).getByRole('button', { name: /Cancelar a venda/ }));
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeNull());
  });
});

describe('M01: documento no balcão e a espera', () => {
  it('com a pré-venda carregada, as esperas somem da tela e o F7 recusa', async () => {
    guardarEspera('e-1', 'Espera da manhã', [{ product: FEIJAO, quantity: 1, unitPriceCents: 890, precificadaPara: null }]);
    const campo = abrirPdv('/pdv?documento=q-pre');
    await screen.findByText(/Faturando/);
    expect(screen.queryByTestId('pdv-esperas')).toBeNull();

    fireEvent.keyDown(campo, { key: 'F7' });
    await screen.findByText(/está no balcão/);
    expect(screen.getByText(/Faturando/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('gs.pdv.emEspera') ?? '[]')).toHaveLength(1);
  });
});

describe('M05: o rastro de cancelados é do carrinho', () => {
  it('retomar a espera B por cima de A: B sai sem o rastro de A, e A volta com o dele', async () => {
    guardarEspera('e-b', 'Espera B', [{ product: FEIJAO, quantity: 1, unitPriceCents: 890, precificadaPara: null }]);
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    bipar(campo, CABO.barcode);
    await waitFor(() => expect(qtdDa(CABO.name)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: `Remover ${CABO.name}` }));
    await waitFor(() => expect(itensCancelados()).toBe('1'));

    fireEvent.click(await screen.findByRole('button', { name: 'Espera B' }));
    await waitFor(() => expect(qtdDa(FEIJAO.name)).toBeTruthy());
    expect(itensCancelados()).toBe('0');

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].corpo.cancelledItems).toBeUndefined();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());

    // O rótulo da espera de A ("1 item(ns) · 14:05"), e não o "Descartar espera …" ao lado.
    fireEvent.click(await screen.findByRole('button', { name: /^\d+ item\(ns\) · / }));
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    expect(itensCancelados()).toBe('1');
  });
});

describe('D-06: o F5 no meio da venda', () => {
  it('recarregar a página devolve o carrinho com a MESMA chave da venda', async () => {
    let campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(qtdDa(FEIJAO.name)).toBeTruthy());
    const guardado = JSON.parse(sessionStorage.getItem('gs.pdv.rascunho:loja:u-caixa') ?? 'null') as { saleKey: string } | null;
    expect(guardado?.saleKey).toBeTruthy();

    // Com venda montada, fechar ou recarregar a aba pergunta antes.
    const saida = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saida);
    expect(saida.defaultPrevented).toBe(true);

    // O recarregar: a página sai (pagehide) e a tela nasce de novo.
    window.dispatchEvent(new Event('pagehide'));
    cleanup();
    campo = abrirPdv();
    await waitFor(() => {
      expect(qtdDa(ARROZ.name)).toBeTruthy();
      expect(qtdDa(FEIJAO.name)).toBeTruthy();
    });
    expect(screen.getByText(/Venda recuperada/)).toBeTruthy();

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].chave).toBe(guardado!.saleKey);
  });

  it('sair do PDV por dentro do sistema não deixa rascunho para depois', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    cleanup();
    expect(sessionStorage.getItem('gs.pdv.rascunho:loja:u-caixa')).toBeNull();
  });
});

describe('D-20: a piscada de rede na volta do foco', () => {
  it('a consulta do caixa falha depois de uma resposta boa: as esperas continuam na tela', async () => {
    guardarEspera('e-1', 'Espera da manhã', [{ product: FEIJAO, quantity: 1, unitPriceCents: 890, precificadaPara: null }]);
    abrirPdv();
    await screen.findByTestId('pdv-esperas');

    caixaFalha = true;
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('pdv-esperas')).toBeTruthy();
    expect(screen.queryByText(/Não foi possível confirmar o caixa/)).toBeNull();
  });
});

describe('D-18: as teclas de função não vão para o navegador', () => {
  it('com o pagamento aberto, F6, F1 e F3 ficam com o PDV; F5 continua do navegador', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(qtdDa(ARROZ.name)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    await screen.findByPlaceholderText(/Vazio =/, {}, { timeout: 4000 });

    for (const key of ['F6', 'F1', 'F3']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(ev);
      expect(ev.defaultPrevented, `${key} escapou para o navegador`).toBe(true);
    }
    const f5 = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(f5);
    expect(f5.defaultPrevented).toBe(false);
  });

  it('F1 abre a ajuda do PDV (e não a do navegador)', async () => {
    const campo = abrirPdv();
    fireEvent.keyDown(campo, { key: 'F1' });
    expect(await screen.findByText(/Você pode apertar as seguintes teclas/)).toBeTruthy();
  });
});
