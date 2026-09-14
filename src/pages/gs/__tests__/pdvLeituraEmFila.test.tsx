/**
 * O LEITOR EM SEQUÊNCIA — as leituras que se colavam, sumiam ou entravam na
 * venda errada.
 *
 *   D-pdv-teclado-01  bipe B com a busca de A no ar: o campo virava "AB", e B
 *                     não entrava ("Nenhum produto encontrado").
 *   D-pdv-teclado-02  bipe durante o Finalizar sumia com o clearSale; bipe e F8
 *                     no mesmo instante mandavam a venda SEM o item.
 *   D-pdv-teclado-03  o código ADICIONAL do cadastro virava lista de um item.
 *   D-pdv-teclado-04  "não encontrado" deixava o código no campo, e o próximo
 *                     bipe se colava atrás dele.
 *   D-pdv-teclado-11  a resposta atrasada substituía a lista nova.
 *   D-pdv-teclado-13  Quantidade e Preço Unitário sobreviviam à leitura falha.
 *   D-pdv-teclado-21  o preço digitado sumia quando o produto já estava na venda.
 *   D-pdv-teclado-22  Enter duplo na lista punha a MESMA peça duas vezes.
 *
 * O servidor é dublado (fetch) com atrasos controlados: é a tela que está
 * sendo provada. O "leitor" daqui escreve o código ATRÁS do que está no campo,
 * como o de verdade faz.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    ...extra,
  };
}

const ARROZ = produto('p1', 'ARROZ X 5kg', '7898215151784', 2190);
const FEIJAO = produto('p2', 'FEIJÃO CARIOCA 1kg', '7896006711116', 890);
const CABO = produto('p3', 'CABO HDMI', '7891000000031', 1500);
const CABO_USB = produto('p4', 'CABO USB', '7891000000048', 990);
const CELULAR = produto('p5', 'CELULAR X', '7891000000055', 99900, { serialized: 1 });
const TODOS = [ARROZ, FEIJAO, CABO, CABO_USB, CELULAR];
/** O código do fardo do feijão, cadastrado em "códigos adicionais" (core_product_barcodes). */
const CODIGO_DO_FARDO = '1234567';

let atrasoDaBusca: (q: string) => number;
let atrasoDaVenda: number;
let atrasoDasPecas: number;
let pecas: { id: string; imei: string }[];
/** O que a busca pela IDENTIDADE da peça (`GET /core/units?q=`) devolve. */
let identidades: Record<string, unknown>[];
let vendas: { corpo: { items: { productId: string; quantity: number; unitPriceCents: number }[]; payments: { amountCents: number }[] }; chave: string | null }[];

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      await esperar(atrasoDaBusca(q));
      // O servidor casa o código adicional como EXATO, mas devolve só `p.*`.
      if (q === CODIGO_DO_FARDO) return responder({ items: [FEIJAO], catalogoVazio: false });
      const exato = TODOS.filter((p) => p.barcode === q || p.internal_code === q);
      const porNome = TODOS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
      return responder({ items: exato.length ? exato : porNome, catalogoVazio: false });
    }
    if (alvo.includes('/core/units/')) {
      await esperar(atrasoDasPecas);
      return responder({
        items: pecas.map((p) => ({
          id: p.id,
          product_id: 'p5',
          status: 'in_stock',
          imei: p.imei,
          chassis: null,
          plate: null,
          serial_number: null,
          motor_number: null,
          equipment_id: null,
        })),
      });
    }
    if (alvo.includes('/core/units?q=')) return responder({ items: identidades });
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      const corpo = JSON.parse(init?.body ?? '{}');
      vendas.push({ corpo, chave: init?.headers?.['Idempotency-Key'] ?? null });
      const n = vendas.length;
      await esperar(atrasoDaVenda);
      const total = (corpo.items as { quantity: number; unitPriceCents: number }[]).reduce(
        (s, i) => s + i.unitPriceCents * i.quantity,
        0,
      );
      return responder(
        {
          id: `venda-${n}`,
          number: 100 + n,
          subtotal_cents: total,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: total,
          change_cents: 0,
          nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: [] },
        },
        201,
      );
    }
    if (alvo.includes('/core/cash/open')) {
      return responder({ session: { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' }, cashWithdrawalLimitCents: null });
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
    'teste das leituras em fila',
  );
}

function abrirPdv() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
  return screen.getByLabelText(/Pesquise por código/) as HTMLInputElement;
}

/** O leitor: escreve o código ATRÁS do que está no campo e aperta Enter. */
function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: campo.value + codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

const linha = (nome: string) => screen.queryByLabelText(`Quantidade de ${nome}`) as HTMLInputElement | null;

beforeEach(() => {
  atrasoDaBusca = () => 0;
  atrasoDaVenda = 0;
  atrasoDasPecas = 0;
  pecas = [{ id: 'u1', imei: 'IMEI-1' }];
  identidades = [];
  vendas = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste das leituras em fila');
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('D-01: a segunda leitura com a primeira no ar', () => {
  it('os dois produtos entram, e o campo termina limpo — sem "Nenhum produto encontrado"', async () => {
    atrasoDaBusca = (q) => (q === ARROZ.barcode ? 150 : 0);
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    // A primeira ainda está no ar: os dígitos da segunda entram atrás dela.
    bipar(campo, FEIJAO.barcode);

    await waitFor(() => {
      expect(linha(ARROZ.name)).toBeTruthy();
      expect(linha(FEIJAO.name)).toBeTruthy();
    });
    expect(screen.queryByText(/Nenhum produto encontrado/)).toBeNull();
    await waitFor(() => expect(campo.value).toBe(''));
  });

  /*
    Revisão: com a fila, a segunda leitura começava com a primeira no ar e lia o
    MESMO Preço Unitário digitado para ela — o segundo produto entrava pelo
    preço do primeiro. Como fica vermelho: volte `runSearch` a ler os campos
    sem olhar `leiturasPendentes`.
  */
  it('o preço digitado vale para a leitura que o encontrou: a segunda, com a primeira no ar, vai pelo vigente', async () => {
    atrasoDaBusca = (q) => (q === ARROZ.barcode ? 150 : 0);
    const campo = abrirPdv();
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '50,00' } });
    bipar(campo, ARROZ.barcode);
    bipar(campo, FEIJAO.barcode);
    await waitFor(() => {
      expect(linha(ARROZ.name)).toBeTruthy();
      expect(linha(FEIJAO.name)).toBeTruthy();
    });

    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    const precos = Object.fromEntries(vendas[0].corpo.items.map((i) => [i.productId, i.unitPriceCents]));
    expect(precos).toEqual({ p1: 5000, p2: 890 });
  });
});

describe('D-02: a leitura e o Finalizar', () => {
  it('bipe com o F8 no ar é do PRÓXIMO cliente: fica no carrinho novo, fora da venda que saiu', async () => {
    atrasoDaVenda = 200;
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());

    fireEvent.keyDown(campo, { key: 'F8' });
    bipar(campo, FEIJAO.barcode);

    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas).toHaveLength(1);
    expect(vendas[0].corpo.items.map((i) => i.productId)).toEqual(['p1']);
    await waitFor(() => expect(linha(FEIJAO.name)).toBeTruthy());
    expect(linha(ARROZ.name)).toBeNull();
  });

  it('bipe e F8 no mesmo instante: a venda espera a leitura e sai COM o item', async () => {
    atrasoDaBusca = (q) => (q === FEIJAO.barcode ? 150 : 0);
    const campo = abrirPdv();
    bipar(campo, FEIJAO.barcode);
    fireEvent.keyDown(campo, { key: 'F8' });

    await screen.findByRole('dialog', { name: 'Venda concluída' }, { timeout: 3000 });
    expect(vendas).toHaveLength(1);
    expect(vendas[0].corpo.items.map((i) => i.productId)).toEqual(['p2']);
    expect(vendas[0].corpo.payments[0].amountCents).toBe(890);
  });

  /*
    Revisão: a leitura que o F8 esperou e que terminou SEM item (não encontrado)
    deixava a venda sair sem ele, e o "Nenhum produto encontrado" era apagado
    pelo começo do Finalizar. Como fica vermelho: tire de `finalize` a conferência
    de `leiturasSemItem` e a venda sai (um POST) sem o item bipado.
  */
  it('bipe que NÃO entra e F8 no mesmo instante: a venda não sai, e a faixa diz o motivo', async () => {
    atrasoDaBusca = (q) => (q === '7890000000001' ? 150 : 0);
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
    bipar(campo, '7890000000001');
    fireEvent.keyDown(campo, { key: 'F8' });

    await screen.findByText(/Nenhum produto encontrado para "7890000000001".*A venda NÃO foi finalizada/);
    await esperar(50);
    expect(vendas).toHaveLength(0);
    expect(linha(ARROZ.name)).toBeTruthy();
  });
});

describe('D-03: o código adicional do cadastro é bipagem', () => {
  it('o fardo bipado entra direto no carrinho, sem lista de um item', async () => {
    const campo = abrirPdv();
    bipar(campo, CODIGO_DO_FARDO);
    await waitFor(() => expect(linha(FEIJAO.name)).toBeTruthy());
    expect(document.querySelectorAll('[aria-selected]').length).toBe(0);
  });
});

describe('D-04: o que não entrou sai do caminho do próximo bipe', () => {
  it('não encontrado: o código vai para a faixa, o campo esvazia, e o próximo bipe funciona', async () => {
    const campo = abrirPdv();
    bipar(campo, '7890000000001');
    await screen.findByText(/Nenhum produto encontrado para "7890000000001"/);
    await waitFor(() => expect(campo.value).toBe(''));

    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
  });

  it('lista por texto: o termo fica SELECIONADO — Enter ainda escolhe, e o próximo bipe o substitui', async () => {
    const campo = abrirPdv();
    bipar(campo, 'arroz');
    await waitFor(() => expect(document.querySelectorAll('[aria-selected]').length).toBe(1));
    expect(campo.value).toBe('arroz');
    expect(campo.selectionStart).toBe(0);
    expect(campo.selectionEnd).toBe(5);
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
  });
});

describe('D-11: a resposta atrasada não substitui a lista nova', () => {
  it('"cabo" lento e "cabo usb" rápido: a lista final é a do último, e o Enter põe o item dela', async () => {
    atrasoDaBusca = (q) => (q === 'cabo' ? 150 : 0);
    const campo = abrirPdv();
    fireEvent.change(campo, { target: { value: 'cabo' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    fireEvent.change(campo, { target: { value: 'cabo usb' } });
    fireEvent.keyDown(campo, { key: 'Enter' });

    // Tempo para a resposta lenta chegar — é ela que estragava a lista.
    await esperar(300);
    await waitFor(() => {
      const itens = [...document.querySelectorAll('[aria-selected]')].map((b) => b.textContent ?? '');
      expect(itens).toHaveLength(1);
      expect(itens[0]).toContain(CABO_USB.name);
    });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(linha(CABO_USB.name)).toBeTruthy());
    expect(linha(CABO.name)).toBeNull();
  });
});

describe('D-13: leitura sem item não deixa quantidade e preço para o próximo', () => {
  it('preço digitado, bipe não encontrado, bipe válido: o produto entra pelo preço vigente', async () => {
    const campo = abrirPdv();
    const preco = screen.getByPlaceholderText('R$ 0,00') as HTMLInputElement;
    fireEvent.change(preco, { target: { value: '5,00' } });
    bipar(campo, '7890000000009');
    await screen.findByText(/Nenhum produto encontrado/);
    expect(preco.value).toBe('');

    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].corpo.items[0].unitPriceCents).toBe(2190);
  });

  it('"3*cabo" e Esc: a quantidade volta a 1', async () => {
    const campo = abrirPdv();
    fireEvent.change(campo, { target: { value: '3*cabo' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(document.querySelectorAll('[aria-selected]').length).toBe(2));
    expect((screen.getByLabelText('Quantidade') as HTMLInputElement).value).toBe('3');
    fireEvent.keyDown(campo, { key: 'Escape' });
    expect((screen.getByLabelText('Quantidade') as HTMLInputElement).value).toBe('1');
  });

  /*
    Reauditoria: o IMEI de uma peça que não pode ser vendida (já vendida, com
    baixa) dava a recusa e deixava "3" em Quantidade e "5,00" em Preço
    Unitário — o próximo produto bipado entrava com 3 unidades a R$ 5,00,
    marcado como preço digitado (concessão de 77%). Como fica vermelho: tire do
    ramo "não pode ser vendida" de `runSearch` a volta dos campos ao padrão.
  */
  it('IMEI de peça já vendida: a recusa leva junto quantidade e preço — o próximo produto entra por 1 × vigente', async () => {
    identidades = [
      {
        id: 'u9',
        product_id: 'p5',
        status: 'sold',
        imei: '356789012345678',
        chassis: null,
        plate: null,
        serial_number: null,
        motor_number: null,
        equipment_id: null,
      },
    ];
    const campo = abrirPdv();
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '5,00' } });
    bipar(campo, '356789012345678');
    await screen.findByText(/Essa peça está como "vendida" e não pode ser vendida/);
    expect((screen.getByLabelText('Quantidade') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Preço Unitário') as HTMLInputElement).value).toBe('');

    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
    expect(linha(ARROZ.name)?.value).toBe('1');
    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].corpo.items[0]).toMatchObject({ productId: 'p1', quantity: 1, unitPriceCents: 2190 });
  });
});

describe('D-21: o preço digitado não some quando o produto já está na venda', () => {
  it('a soma é recusada com o motivo, e a linha continua como estava', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
    // Com a linha no carrinho, "R$ 0,00" também é o placeholder do desconto dela.
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '10,00' } });
    bipar(campo, ARROZ.barcode);

    await screen.findByText(/já está nesta venda por R\$\s?21,90/);
    expect(linha(ARROZ.name)?.value).toBe('1');
  });

  /*
    Revisão: a soma recusada deixava o valor no Preço Unitário, e o PRÓXIMO
    produto bipado entrava por ele (preço digitado). Como fica vermelho: tire
    do ramo da recusa em `addProduct` a volta dos campos ao padrão.
  */
  it('recusada a soma, o preço sai do campo (e fica na faixa): o próximo produto entra pelo vigente', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(linha(ARROZ.name)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '10,00' } });
    bipar(campo, ARROZ.barcode);
    await screen.findByText(/preço digitado \(R\$\s?10,00\) não foi somado/);
    expect((screen.getByLabelText('Preço Unitário') as HTMLInputElement).value).toBe('');

    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(linha(FEIJAO.name)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F8' });
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas[0].corpo.items.find((i) => i.productId === 'p2')?.unitPriceCents).toBe(890);
  });
});

describe('D-22: a mesma peça não entra duas vezes', () => {
  it('Enter duplo na lista, com a consulta das peças lenta: UMA peça na linha', async () => {
    atrasoDasPecas = 100;
    const campo = abrirPdv();
    fireEvent.change(campo, { target: { value: 'celular' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(document.querySelectorAll('[aria-selected]').length).toBe(1));
    fireEvent.keyDown(campo, { key: 'Enter' });
    fireEvent.keyDown(campo, { key: 'Enter' });

    expect(await screen.findByText('IMEI-1')).toBeTruthy();
    await esperar(250);
    expect(screen.queryByText(/IMEI-1, IMEI-1/)).toBeNull();
  });

  it('dois bipes do mesmo celular com duas peças no estoque: duas peças DIFERENTES', async () => {
    pecas = [
      { id: 'u1', imei: 'IMEI-1' },
      { id: 'u2', imei: 'IMEI-2' },
    ];
    atrasoDasPecas = 60;
    const campo = abrirPdv();
    bipar(campo, CELULAR.barcode);
    bipar(campo, CELULAR.barcode);
    expect(await screen.findByText('IMEI-1, IMEI-2')).toBeTruthy();
  });
});
