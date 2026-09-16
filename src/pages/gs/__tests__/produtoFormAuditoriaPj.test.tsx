/**
 * ============================================================================
 * O FORMULÁRIO DO PRODUTO DA AUDITORIA DA PREÇO JUSTO (trilha "produto")
 * ============================================================================
 *
 * O que o servidor passou a aceitar só vale se a TELA mandar — e cada defeito
 * abaixo era da tela:
 *
 *  - A-produto-01: falha depois do POST deixava a tela em "Novo" e o Salvar
 *    seguinte criava o produto de novo;
 *  - A-produto-03: `|| undefined` fazia a categoria/CEST/piso apagados voltarem;
 *  - A-produto-07: o formulário mandava o objeto inteiro e revertia o preço
 *    gravado por outra pessoa;
 *  - A-produto-08: o EAN principal era trocado sem pergunta nenhuma;
 *  - A-produto-09/10/26: grupo inativo oferecido; fornecedor e unidade livres;
 *  - A-produto-15: o botão "uma por unidade em estoque" nunca aparecia;
 *  - A-produto-16: margem + Salvar no mesmo gesto gravava o preço antigo;
 *  - A-produto-17: preço abaixo do piso gravado só com um aviso amarelo;
 *  - A-produto-18: histórico com ": — → —" e criação como "registro antigo";
 *  - A-produto-19: estoque mínimo "2,5" virava zero;
 *  - A-produto-25: depois de imprimir, a tela dizia que não havia EAN.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProdutoFormPage from '../ProdutoFormPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const PRODUTO_ID = 'prod-1';

let produto: Record<string, unknown>;
let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> | null }[];
let respostaDoPut: (() => Response) | null;
let respostaDoLote: (() => Response) | null;
let respostaDoPreview: (() => Promise<Response>) | null;
let respostaDoCodigoInterno: Record<string, unknown>;
let gruposTributarios: Record<string, unknown>[];
let unidades: Record<string, unknown>[];
let fornecedores: Record<string, unknown>[];
let personalizados: Record<string, unknown>[];
let historico: Record<string, unknown>[];
let estoque: Record<string, unknown>[];
let taxonomia: Record<string, unknown>;

const responder = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function produtoPadrao(): Record<string, unknown> {
  return {
    id: PRODUTO_ID,
    name: 'Camiseta Polo',
    internal_code: 'LJ-0009',
    barcode: null,
    sku: null,
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 2000,
    price_cents: 3990,
    effective_price_cents: 3990,
    on_sale: false,
    min_stock: 0,
    active: 1,
    publish_online: 0,
    kind: 'retail',
    workshop_id: null,
    tax_profile: null,
    stock_control: 1,
  };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const barra = respostaDaBarraDoShell(url);
    if (barra) return barra;
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push({ metodo, url: alvo, corpo: init?.body ? JSON.parse(init.body) : null });

    if (alvo.includes('/core/stock/batch-control/')) {
      return respostaDoLote ? respostaDoLote() : responder({ productId: 'x', tracksBatches: true });
    }
    if (alvo.includes('/catalog/pricing/preview')) {
      return respostaDoPreview ? respostaDoPreview() : responder({ priceCents: 0 });
    }
    if (alvo.includes('/catalog/tax-groups')) return responder({ taxGroups: gruposTributarios });
    if (alvo.includes('/catalog/aux')) {
      return responder({ units: unidades, taxGroups: [], taxRates: [], priceTables: [] });
    }
    if (alvo.includes('/core/suppliers')) return responder({ items: fornecedores });
    if (alvo.includes('/labels/sheet')) {
      // A folha grava um EAN interno em quem não tinha (ensureBarcode).
      produto = { ...produto, barcode: '2000000000015' };
      return responder({
        html: '<html>folha</html>',
        etiquetas: 1,
        folhas: 1,
        promocoes: [],
        semPreco: [],
        codigosGerados: [{ productId: PRODUTO_ID, name: 'Camiseta Polo', barcode: '2000000000015' }],
      });
    }
    if (alvo.includes('/labels/templates/preview')) return responder({ html: '', etiquetas: 1, folhas: 1 });
    if (alvo.includes('/labels/templates')) {
      return responder({
        items: [{ id: 'm-1', name: 'Padrão', widthMm: 50, heightMm: 30, columns: 1, isDefault: true }],
        campos: [],
      });
    }
    if (alvo.includes('/barcode/internal')) return responder(respostaDoCodigoInterno);
    if (alvo.includes('/custom-fields')) return responder({ values: personalizados });
    if (alvo.includes('/history')) return responder({ items: historico });
    if (alvo.includes('/price-tiers')) return responder({ tiers: [] });
    if (metodo === 'POST' && /\/core\/products$/.test(alvo)) {
      return responder({ ...produtoPadrao(), id: 'novo', internal_code: 'GS-000031' }, 201);
    }
    if (metodo === 'PUT' && /\/core\/products\/[^/]+$/.test(alvo)) {
      return respostaDoPut ? respostaDoPut() : responder(produto);
    }
    if (alvo.includes('/core/workshops')) return responder({ items: [] });
    if (alvo.includes('/core/taxonomy')) return responder(taxonomia);
    if (alvo.includes('/core/stock')) return responder({ items: estoque });
    if (alvo.includes('/barcodes')) return responder({ barcodes: [] });
    if (alvo.includes('/kit')) return responder({ components: [], costCents: 0 });
    if (alvo.includes('/images')) return responder({ items: [] });
    if (/\/core\/products\/[^/?]+$/.test(alvo)) return responder(produto);
    return responder({});
  });
}

beforeEach(() => {
  pedidos = [];
  produto = produtoPadrao();
  respostaDoPut = null;
  respostaDoLote = null;
  respostaDoPreview = null;
  respostaDoCodigoInterno = { productId: PRODUTO_ID, barcode: '2000000000015', generated: true };
  gruposTributarios = [];
  unidades = [];
  fornecedores = [];
  personalizados = [];
  historico = [];
  estoque = [];
  taxonomia = { categories: [], brands: [] };
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

async function montar(rota = `/sistema/produtos/${PRODUTO_ID}`) {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route path="/sistema/produtos/novo" element={<ProdutoFormPage />} />
        <Route path="/sistema/produtos/:id" element={<ProdutoFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
  if (rota.endsWith('/novo')) {
    await screen.findByRole('button', { name: 'Salvar' });
  } else {
    await screen.findByDisplayValue(String(produto.name));
  }
}

const abrir = (secao: string) => fireEvent.click(screen.getByRole('tab', { name: secao }));
const salvar = () => fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

/**
 * O Salvar DEPOIS de uma pergunta cancelada. O "Cancelar" some com a pergunta
 * na hora, mas o botão só é solto no `finally` do Salvar anterior
 * (`setBusy(false)`), que chega numa volta seguinte do React: o segundo clique,
 * dado assim que a pergunta sumia, caía no botão ainda travado — e a pergunta
 * nova nunca aparecia (A-produto-08 e 17 vermelhos sob carga). Espera o botão
 * aceitar o clique, como o caso do cadastro novo (A-produto-01) já fazia.
 */
async function salvarDeNovo() {
  const botao = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
  await waitFor(() => expect(botao.disabled).toBe(false));
  fireEvent.click(botao);
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const puts = () => pedidos.filter((p) => p.metodo === 'PUT' && /\/core\/products\/[^/]+$/.test(p.url));

async function corpoDoPut(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(puts().length).toBeGreaterThan(0));
  return puts().at(-1)!.corpo!;
}

function seletorComOpcao(nomeDaOpcao: string): HTMLSelectElement {
  const opcao = screen.getByRole('option', { name: nomeDaOpcao }) as HTMLOptionElement;
  return opcao.closest('select') as HTMLSelectElement;
}

// --------------------------------------------------------------- A-produto-03
describe('limpar um campo na edição LIMPA (A-produto-03)', () => {
  it('categoria, CEST e preço mínimo esvaziados vão como vazio/nulo — não somem do corpo', async () => {
    taxonomia = {
      categories: [{ id: 'c-1', name: 'Liquidação', parent_id: null, active: 1, usage: 1, children: [] }],
      brands: [],
    };
    produto = { ...produtoPadrao(), category: 'Liquidação', cest: '2800100', min_price_cents: 2500 };
    await montar();
    await screen.findByRole('option', { name: 'Liquidação' });

    fireEvent.change(seletorComOpcao('Sem categoria'), { target: { value: '' } });
    abrir('Fiscal');
    fireEvent.change(screen.getByLabelText(/^CEST/), { target: { value: '' } });
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Preço mínimo/), { target: { value: '' } });
    salvar();

    const corpo = await corpoDoPut();
    // Com `|| undefined` estes três sumiam do corpo, e o servidor PRESERVAVA.
    expect(corpo.category).toBe('');
    expect(corpo.cest).toBe('');
    expect(corpo.minPriceCents).toBeNull();
    expect(corpo.expected).toMatchObject({ category: 'Liquidação', cest: '2800100', minPriceCents: 2500 });
  });
});

// --------------------------------------------------------------- A-produto-07
describe('só o que a pessoa mudou vai no PUT (A-produto-07)', () => {
  it('mudar só a descrição manda SÓ a descrição — o preço que outro gravou não é reenviado', async () => {
    await montar();
    fireEvent.change(screen.getByPlaceholderText(/Anotação para a equipe/), { target: { value: 'Nova' } });
    salvar();

    const corpo = await corpoDoPut();
    expect(Object.keys(corpo).sort()).toEqual(['description', 'expected']);
    expect(corpo.description).toBe('Nova');
    expect(corpo.expected).toEqual({ description: '' });
  });

  it('409 de concorrência: a tela diz o que houve e oferece recarregar', async () => {
    respostaDoPut = () =>
      responder(
        {
          error: {
            code: 'CORE_PRODUCT_STALE',
            message:
              'Enquanto você editava, este produto foi alterado por outra pessoa ou outra tela: Preço de venda (agora R$ 29,90).',
          },
        },
        409,
      );
    await montar();
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '35,00' } });
    salvar();

    expect(await screen.findByText(/alterado por outra pessoa/)).toBeTruthy();
    const leituras = () =>
      pedidos.filter((p) => p.metodo === 'GET' && p.url.endsWith(`/core/products/${PRODUTO_ID}`)).length;
    const antes = leituras();
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar o produto' }));
    await waitFor(() => expect(leituras()).toBeGreaterThan(antes));
  });
});

// --------------------------------------------------------------- A-produto-08
describe('trocar o EAN principal pergunta antes (A-produto-08)', () => {
  it('Cancelar não grava; confirmar grava e avisa que o antigo continua valendo', async () => {
    produto = { ...produtoPadrao(), barcode: '7890000000024' };
    await montar();
    fireEvent.change(screen.getByLabelText('EAN / GTIN'), { target: { value: '7891000100103' } });

    salvar();
    const caixa = await screen.findByRole('dialog');
    expect(caixa.textContent).toContain('continua valendo como adicional');
    fireEvent.click(within(caixa).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts()).toHaveLength(0);

    await salvarDeNovo();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Trocar o código' }));
    expect((await corpoDoPut()).barcode).toBe('7891000100103');
    expect(await screen.findByText(/código antigo 7890000000024 continua valendo/)).toBeTruthy();
  });
});

// ------------------------------------------------------- A-produto-09/10/26
describe('seletores no lugar de texto livre (A-produto-09, 10 e 26)', () => {
  const grupos = () => [
    { id: 'g-1', code: 'PADRAO', name: 'Padrão', regime: 'simples', active: 1, usage: 1 },
    { id: 'g-2', code: 'ST', name: 'Substituição', regime: 'simples', active: 0, usage: 0 },
  ];

  it('grupo tributário INATIVO não é oferecido para escolha', async () => {
    gruposTributarios = grupos();
    await montar();
    abrir('Fiscal');
    const seletor = screen.getByLabelText('Grupo tributário') as HTMLSelectElement;
    expect([...seletor.options].map((o) => o.value)).toEqual(['', 'PADRAO']);
  });

  it('o grupo inativo que o produto JÁ tem aparece, marcado para ser trocado', async () => {
    gruposTributarios = grupos();
    produto = { ...produtoPadrao(), tax_profile: 'ST' };
    await montar();
    abrir('Fiscal');
    const seletor = screen.getByLabelText('Grupo tributário') as HTMLSelectElement;
    expect(seletor.value).toBe('ST');
    expect(seletor.selectedOptions[0].textContent).toContain('inativo — escolha outro');
  });

  it('o fornecedor é escolhido da lista e viaja como id', async () => {
    fornecedores = [{ id: 'f-1', name: 'Distribuidora Beleza Ltda', trade_name: 'Beleza' }];
    await montar();
    await screen.findByRole('option', { name: 'Beleza' });
    fireEvent.change(screen.getByLabelText('Fornecedor'), { target: { value: 'f-1' } });
    salvar();
    expect((await corpoDoPut()).supplierId).toBe('f-1');
  });

  it('o nome antigo gravado no lugar do id aparece marcado, e não some', async () => {
    produto = { ...produtoPadrao(), supplier_id: 'Distribuidora Beleza' };
    await montar();
    const seletor = screen.getByLabelText('Fornecedor') as HTMLSelectElement;
    expect(seletor.value).toBe('Distribuidora Beleza');
    expect(seletor.selectedOptions[0].textContent).toContain('não é um fornecedor cadastrado');
  });

  it('a unidade vem do vocabulário; a fora da lista aparece marcada; a escolhida viaja', async () => {
    unidades = [
      { id: 'u-1', code: 'UN', name: 'Unidade', decimals: 0, active: 1, usage: 0 },
      { id: 'u-2', code: 'KG', name: 'Quilograma', decimals: 3, active: 1, usage: 0 },
    ];
    produto = { ...produtoPadrao(), unit: 'Un' };
    await montar();
    const seletor = screen.getByLabelText('Unidade') as HTMLSelectElement;
    await waitFor(() => expect([...seletor.options].map((o) => o.value)).toEqual(['UN', 'KG', 'Un']));
    expect(seletor.selectedOptions[0].textContent).toContain('fora da lista');

    fireEvent.change(seletor, { target: { value: 'KG' } });
    salvar();
    expect((await corpoDoPut()).unit).toBe('KG');
  });
});

// --------------------------------------------------------------- A-produto-15
describe('a aba Etiqueta usa o saldo da ficha (A-produto-15)', () => {
  it('24 em estoque: o botão "uma por unidade em estoque (24)" aparece', async () => {
    estoque = [
      {
        product_id: PRODUTO_ID,
        internal_code: 'LJ-0009',
        name: 'Camiseta Polo',
        unit: 'UN',
        quantity: 24,
        reserved: 0,
        min_stock: 0,
        price_cents: 3990,
        cost_cents: 2000,
      },
    ];
    await montar();
    abrir('Etiqueta');
    expect(await screen.findByRole('button', { name: /Uma por unidade em estoque \(24\)/ })).toBeTruthy();
  });
});

// --------------------------------------------------------------- A-produto-16
describe('margem digitada e Salvar no mesmo gesto (A-produto-16)', () => {
  it('o PUT espera o cálculo do servidor e grava o preço CALCULADO', async () => {
    let soltar: (() => void) | null = null;
    respostaDoPreview = () =>
      new Promise<Response>((resolve) => {
        soltar = () => resolve(responder({ priceCents: 4000, markupPercent: 100, marginPercent: 50 }));
      });
    await montar();
    abrir('Preços');

    const margem = screen.getByLabelText('Margem (%)');
    fireEvent.change(margem, { target: { value: '50' } });
    fireEvent.blur(margem);
    salvar();

    // Antes: o PUT saía na hora, com o preço antigo (39,90).
    await esperar(50);
    expect(puts()).toHaveLength(0);
    soltar!();
    expect((await corpoDoPut()).priceCents).toBe(4000);
  });
});

// --------------------------------------------------------------- A-produto-17
describe('preço abaixo do piso pede confirmação (A-produto-17)', () => {
  it('Cancelar não grava; "Salvar mesmo assim" grava', async () => {
    produto = { ...produtoPadrao(), min_price_cents: 2500 };
    await montar();
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '19,90' } });

    salvar();
    const caixa = await screen.findByRole('dialog');
    expect(caixa.textContent).toContain('preço abaixo do mínimo de 25.00');
    fireEvent.click(within(caixa).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts()).toHaveLength(0);

    await salvarDeNovo();
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Salvar mesmo assim' }),
    );
    expect((await corpoDoPut()).priceCents).toBe(1990);
  });

  it('no cadastro NOVO, preço abaixo do piso também pergunta — Cancelar não cria nada', async () => {
    // Revisão: a pergunta só existia na edição; o produto novo nascia abaixo
    // do piso só com o aviso amarelo.
    await montar('/sistema/produtos/novo');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Perfume 100ml' } });
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '19,90' } });
    fireEvent.change(screen.getByLabelText(/Preço mínimo/), { target: { value: '25,00' } });

    salvar();
    const caixa = await screen.findByRole('dialog');
    expect(caixa.textContent).toContain('preço abaixo do mínimo de 25.00');
    fireEvent.click(within(caixa).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await esperar(50);
    expect(pedidos.some((p) => p.metodo === 'POST' && /\/core\/products$/.test(p.url))).toBe(false);
  });

  it('"30%" no markup mínimo é trinta — e não o nulo que TIRA o piso', async () => {
    await montar();
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Markup mínimo/), { target: { value: '30%' } });
    salvar();
    // O preço (39,90 sobre custo 20,00) está acima de 30% de markup: não pergunta.
    const corpo = await corpoDoPut();
    expect(corpo.minMarkupPercent).toBe(30);
  });

  it('piso que não é número é recusado ANTES de gravar, dizendo o campo', async () => {
    produto = { ...produtoPadrao(), min_markup_percent: 30 };
    await montar();
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Markup mínimo/), { target: { value: 'trinta' } });
    salvar();
    expect(await screen.findByText(/Markup mínimo inválido/)).toBeTruthy();
    await esperar(50);
    expect(puts()).toHaveLength(0);
  });

  /*
    P00-prod-03: a tara tinha o MESMO defeito do piso, no campo ao lado, e
    ninguém o tinha olhado. `Number('doze')` é NaN, e NaN viaja no JSON como
    `null` — que o servidor lê como "limpe a tara". Digitar texto no campo
    APAGAVA a embalagem declarada, com "Produto atualizado." na tela, e a
    balança voltava a cobrar do cliente o peso da bandeja.
  */
  it('tara que não é número é recusada ANTES de gravar — e não apaga a tara gravada', async () => {
    produto = { ...produtoPadrao(), weighable: 1, plu_code: '105', tare_grams: 12 };
    await montar();
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Tara/), { target: { value: 'doze' } });
    salvar();
    expect(await screen.findByText(/Tara inválida/)).toBeTruthy();
    await esperar(50);
    expect(puts()).toHaveLength(0);
  });

  it('a tara em gramas inteiras vai como número; "12 g" também', async () => {
    produto = { ...produtoPadrao(), weighable: 1, plu_code: '105', tare_grams: null };
    await montar();
    abrir('Preços');
    fireEvent.change(screen.getByLabelText(/Tara/), { target: { value: '12 g' } });
    salvar();
    expect((await corpoDoPut()).tareGrams).toBe(12);
  });

  it('corrigir só a descrição de um produto que JÁ estava abaixo não pergunta nada', async () => {
    produto = { ...produtoPadrao(), min_price_cents: 5000 };
    await montar();
    fireEvent.change(screen.getByPlaceholderText(/Anotação para a equipe/), { target: { value: 'x' } });
    salvar();
    await corpoDoPut();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// --------------------------------------------------------------- A-produto-18
describe('o histórico e os campos próprios (A-produto-18)', () => {
  it('códigos soltos não viram ": — → —", e a criação diz "Produto cadastrado."', async () => {
    historico = [
      {
        id: 'h-1',
        action: 'product.custom_fields.set',
        created_at: '2026-09-10T12:00:00.000Z',
        user_id: null,
        user_name: 'Marina',
        fields: [],
        resumo: 'Campos alterados: VOLTAGEM (os valores não foram guardados neste registro).',
      },
      {
        id: 'h-2',
        action: 'fiscal.product_updated',
        created_at: '2026-09-09T12:00:00.000Z',
        user_id: null,
        user_name: 'Marina',
        // Um servidor antigo ainda mandando os CÓDIGOS crus.
        fields: ['ncm'],
        resumo: null,
      },
      {
        id: 'h-3',
        action: 'product.create',
        created_at: '2026-09-01T12:00:00.000Z',
        user_id: null,
        user_name: 'Marina',
        fields: [],
        resumo: 'Produto cadastrado.',
      },
    ];
    await montar();
    abrir('Histórico');

    // A trilha é a ÚLTIMA leitura do `carregar` (depois do estoque e das
    // seções), e o `montar()` só espera o nome: lida síncrona, ela corria
    // contra a resposta — e as negativas abaixo valiam para a trilha vazia.
    // A linha da criação vem da trilha.
    expect(await screen.findByText('Produto cadastrado.')).toBeTruthy();
    expect(screen.getByText(/Campos alterados: VOLTAGEM/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('→');
    expect(screen.queryByText(/Registro anterior ao detalhamento/)).toBeNull();
  });

  it('Salvar sem mexer nos campos próprios não os regrava', async () => {
    personalizados = [
      { field_id: 'c-1', code: 'VOLTAGEM', label: 'Voltagem', kind: 'select', options: '110V\n220V', value: '110V' },
    ];
    await montar();
    salvar();
    await screen.findByText('Produto atualizado.');
    expect(pedidos.some((p) => p.metodo === 'PUT' && p.url.includes('/custom-fields'))).toBe(false);
  });
});

// --------------------------------------------------------------- A-produto-19
describe('estoque mínimo com vírgula (A-produto-19)', () => {
  it('"2,5" vai como 2.5 — e não como zero', async () => {
    await montar();
    abrir('Estoque');
    fireEvent.change(screen.getByLabelText(/Estoque mínimo/), { target: { value: '2,5' } });
    salvar();
    expect((await corpoDoPut()).minStock).toBe(2.5);
  });

  it('texto que não é número é recusado ANTES de gravar', async () => {
    await montar();
    abrir('Estoque');
    fireEvent.change(screen.getByLabelText(/Estoque mínimo/), { target: { value: 'dois' } });
    salvar();
    expect(await screen.findByText(/Estoque mínimo inválido/)).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });
});

// --------------------------------------------------------------- A-produto-24
describe('o SKU tem onde ser digitado (A-produto-24)', () => {
  it('o SKU gravado aparece na ficha, e o alterado viaja no Salvar com o que a tela viu', async () => {
    produto = { ...produtoPadrao(), sku: 'SKU-ANTIGO' };
    await montar();
    const campo = screen.getByLabelText('SKU') as HTMLInputElement;
    expect(campo.value).toBe('SKU-ANTIGO');

    fireEvent.change(campo, { target: { value: 'SKU-NOVO' } });
    salvar();

    const corpo = await corpoDoPut();
    expect(corpo.sku).toBe('SKU-NOVO');
    expect(corpo.expected).toMatchObject({ sku: 'SKU-ANTIGO' });
  });
});

// --------------------------------------------------------------- A-produto-25
describe('o EAN que a impressão gravou aparece no formulário (A-produto-25)', () => {
  it('sair da aba Etiqueta traz o código gravado para a aba Códigos', async () => {
    await montar();
    abrir('Etiqueta');
    await screen.findByRole('button', { name: /Imprimir/ });
    // A impressão gravou um EAN interno (ensureBarcode).
    produto = { ...produto, barcode: '2000000000015' };

    abrir('Códigos e kit');
    expect(await screen.findByText('2000000000015')).toBeTruthy();
  });

  it('imprimir na aba Etiqueta traz o código gerado para o cadastro SEM precisar sair da aba (C-etiquetas-16)', async () => {
    const janela = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(() => janela as never);
    await montar();
    // Antes de imprimir, o cabeçalho não tem EAN nenhum.
    expect(screen.queryByText(/EAN 2000000000015/)).toBeNull();

    abrir('Etiqueta');
    // O texto do botão sai antes de os modelos de etiqueta chegarem, com o
    // botão DESLIGADO (`!modeloId`): o clique caía num botão travado, nada era
    // impresso e o cabeçalho nunca era relido. Espera o botão aceitar o clique
    // — o modelo padrão lido é a condição dele.
    const imprimir = (await screen.findByRole('button', { name: 'Imprimir 1 etiqueta(s)' })) as HTMLButtonElement;
    await waitFor(() => expect(imprimir.disabled).toBe(false));
    fireEvent.click(imprimir);

    // Sem `onImpresso`, a tela só relia o produto ao SAIR da aba: o cabeçalho
    // continuava "Código LJ-0009", sem o EAN que a etiqueta acabou de usar.
    expect(await screen.findByText(/Código LJ-0009 · EAN 2000000000015/)).toBeTruthy();
    expect(janela.print).toHaveBeenCalled();

    // E o campo "EAN / GTIN" de Dados gerais mostra o código gravado.
    abrir('Dados gerais');
    expect(((await screen.findByLabelText('EAN / GTIN')) as HTMLInputElement).value).toBe('2000000000015');
  });

  it('"Gerar código de barras" num produto que JÁ tinha código não diz "gerado"', async () => {
    respostaDoCodigoInterno = { productId: PRODUTO_ID, barcode: '2000000000015', generated: false };
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar código de barras' }));
    expect(await screen.findByText(/já tinha código de barras: 2000000000015/)).toBeTruthy();
  });
});

// --------------------------------------------------------------- A-produto-01
describe('o cadastro novo não nasce duas vezes (A-produto-01)', () => {
  it('os códigos vão no POST; o que falha depois vira aviso; o segundo Salvar não cria outro', async () => {
    respostaDoLote = () => responder({ error: { code: 'CORE_BATCH_X', message: 'Lote recusado.' } }, 400);
    await montar('/sistema/produtos/novo');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Perfume 100ml' } });
    abrir('Códigos e kit');
    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), { target: { value: '7891000100103' } });
    fireEvent.click(screen.getByRole('button', { name: 'Acrescentar' }));
    await screen.findByText('entra ao salvar');
    abrir('Preços');
    fireEvent.click(screen.getByLabelText(/Tem validade/));

    salvar();
    const postsDeProduto = () =>
      pedidos.filter((p) => p.metodo === 'POST' && /\/core\/products$/.test(p.url));
    await waitFor(() => expect(postsDeProduto()).toHaveLength(1));
    expect(postsDeProduto()[0].corpo).toMatchObject({
      name: 'Perfume 100ml',
      extraBarcodes: ['7891000100103'],
    });
    // Nada de subir o código DEPOIS, um a um: era esse o passo que falhava.
    expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/barcodes'))).toBe(false);

    // O lote recusado virou AVISO guardado para a ficha do produto novo.
    await waitFor(() =>
      expect(sessionStorage.getItem('gs:produto-criado:novo') ?? '').toContain('controle de lote'),
    );

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false),
    );
    salvar();
    await esperar(50);
    expect(postsDeProduto()).toHaveLength(1);
  });

  it('a ficha do produto recém-criado mostra o que ficou pendente', async () => {
    sessionStorage.setItem(
      `gs:produto-criado:${PRODUTO_ID}`,
      JSON.stringify(['A foto "frente.jpg" não subiu (recusada). Envie de novo na aba Fotos.']),
    );
    await montar();
    const avisos = await screen.findByTestId('avisos-da-criacao');
    expect(avisos.textContent).toContain('frente.jpg');
    expect(sessionStorage.getItem(`gs:produto-criado:${PRODUTO_ID}`)).toBeNull();
  });
});
