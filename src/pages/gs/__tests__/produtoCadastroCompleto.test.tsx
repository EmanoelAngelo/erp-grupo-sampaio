/**
 * ============================================================================
 * O CADASTRO DE PRODUTO GANHA OS CAMPOS QUE O SERVIDOR JÁ ESPERAVA
 * ============================================================================
 *
 * Cinco buracos da MESMA tela, e todos da mesma família: o servidor sabia
 * fazer, e a tela não tinha por onde pedir.
 *
 *  - GAP-V01: `PUT /products/:id` aceita `taxProfile` desde sempre, e nenhuma
 *    tela o mandava. A emissão recusava todo produto sem perfil quando a
 *    operação tem dois grupos ativos, com a frase "escolha o perfil no cadastro
 *    do produto" — apontando um campo que não existia;
 *  - GAP-V02: não havia como dizer que um item é SERVIÇO;
 *  - GAP-V04: não havia onde criar "3 por R$ 10";
 *  - GAP-V05: o histórico do produto não tinha tela nenhuma (a Auditoria é
 *    restrita aos donos do grupo);
 *  - GAP-V06/V07: embalagem e campos próprios não existiam no formulário.
 *
 * ## POR QUE TESTE DE TELA, E NÃO SÓ DE ROTA
 *
 * Porque o defeito INTEIRO era de tela: o servidor de V01 estava pronto, e o
 * produto continuava sem perfil. Um teste de rota provaria o que já
 * funcionava. Só um teste de tela prova que o campo existe, que o valor
 * escolhido viaja no corpo, e que o que o servidor devolve chega aos olhos de
 * quem cadastra.
 *
 * ## COMO CADA GUARDA FALHA
 *
 *  - tire `taxProfile` do payload do Salvar e o primeiro caso fica vermelho —
 *    exatamente o defeito original;
 *  - tire o `stockControl` e o serviço volta a ser impossível de cadastrar;
 *  - tire a aba de histórico e o diff volta a existir só no banco.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProdutoFormPage from '../ProdutoFormPage';

const PRODUTO_ID = 'prod-1';

let produto: Record<string, unknown>;
let gruposTributarios: Record<string, unknown>[];
let faixas: Record<string, unknown>[];
let personalizados: Record<string, unknown>[];
let historico: Record<string, unknown>[];
/** Método, URL e corpo de tudo que a tela pediu. É por aqui que se prova. */
let pedidos: { metodo: string; url: string; body: Record<string, unknown> | null }[];

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
    pack_factor: null,
    pack_unit: null,
  };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push({
      metodo,
      url: alvo,
      body: init?.body ? JSON.parse(init.body) : null,
    });

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/catalog/tax-groups')) return responder({ taxGroups: gruposTributarios });
    if (alvo.includes('/price-tiers')) return responder({ tiers: faixas });
    if (alvo.includes('/custom-fields')) return responder({ values: personalizados });
    if (alvo.includes('/history')) return responder({ items: historico });
    if (metodo === 'PUT' && /\/core\/products\/[^/]+$/.test(alvo)) return responder(produto);
    if (alvo.includes('/core/workshops')) return responder({ items: [] });
    if (alvo.includes('/core/taxonomy')) return responder({ categories: [], brands: [] });
    if (alvo.includes('/core/stock')) return responder({ items: [] });
    if (alvo.includes('/barcodes')) return responder({ barcodes: [] });
    if (alvo.includes('/kit')) return responder({ components: [], costCents: 0 });
    if (/\/core\/products\/[^/]+$/.test(alvo)) return responder(produto);

    return responder({});
  });
}

beforeEach(() => {
  pedidos = [];
  produto = produtoPadrao();
  gruposTributarios = [
    {
      id: 'g-1',
      code: 'PADRAO',
      name: 'Padrão da loja',
      regime: 'simples',
      active: 1,
      usage: 3,
    },
    {
      id: 'g-2',
      code: 'MONOFASICO',
      name: 'Bebida monofásica',
      regime: 'simples',
      active: 1,
      usage: 0,
    },
  ];
  faixas = [];
  personalizados = [];
  historico = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function montar() {
  render(
    <MemoryRouter initialEntries={[`/sistema/produtos/${PRODUTO_ID}`]}>
      <Routes>
        <Route path="/sistema/produtos/:id" element={<ProdutoFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
  // O formulário só está pronto quando o produto chegou: agir antes disso
  // dispararia o `setForm` da carga por cima do que o teste escolheu.
  await screen.findByDisplayValue('Camiseta Polo');
}

const abrir = (secao: string) => fireEvent.click(screen.getByRole('tab', { name: secao }));
const salvar = () => fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

/** O corpo do último PUT do cadastro — o que a tela realmente mandou. */
async function corpoDoSalvar(): Promise<Record<string, unknown>> {
  await waitFor(() => {
    expect(
      pedidos.some((p) => p.metodo === 'PUT' && /\/core\/products\/[^/]+$/.test(p.url)),
    ).toBe(true);
  });
  return pedidos.filter(
    (p) => p.metodo === 'PUT' && /\/core\/products\/[^/]+$/.test(p.url),
  ).at(-1)!.body!;
}

describe('o grupo tributário existe na tela (GAP-V01)', () => {
  it('o seletor lista os grupos da operação e o escolhido viaja no Salvar', async () => {
    await montar();
    abrir('Fiscal');

    const seletor = screen.getByLabelText('Grupo tributário') as HTMLSelectElement;
    expect([...seletor.options].map((o) => o.value)).toEqual(['', 'PADRAO', 'MONOFASICO']);

    fireEvent.change(seletor, { target: { value: 'MONOFASICO' } });
    salvar();

    // ESTE é o defeito original: o campo existia no servidor e nunca chegava
    // até ele porque a tela não o tinha.
    expect((await corpoDoSalvar()).taxProfile).toBe('MONOFASICO');
  });

  it('com DOIS grupos ativos a dica diz que o produto precisa escolher', async () => {
    await montar();
    abrir('Fiscal');
    // É a frase que a emissão manda cumprir. Sem ela, o gerente não sabe por
    // que o campo deixou de ser opcional na operação dele.
    expect(screen.getByText(/precisa dizer qual é o dele/i)).toBeTruthy();
  });

  it('com UM grupo só, a dica diz que o vazio já resolve', async () => {
    gruposTributarios = [gruposTributarios[0]];
    await montar();
    abrir('Fiscal');
    expect(screen.getByText(/vale o único grupo ativo/i)).toBeTruthy();
  });

  it('"Padrão da operação" MANDA vazio — limpar precisa ser possível', async () => {
    produto = { ...produtoPadrao(), tax_profile: 'PADRAO' };
    await montar();
    abrir('Fiscal');

    const seletor = screen.getByLabelText('Grupo tributário') as HTMLSelectElement;
    expect(seletor.value).toBe('PADRAO');
    fireEvent.change(seletor, { target: { value: '' } });
    salvar();

    // String vazia, e não `undefined`: ausente PRESERVA no servidor, e escolher
    // um grupo por engano viraria decisão irreversível pela tela.
    expect((await corpoDoSalvar()).taxProfile).toBe('');
  });

  it('sem grupo nenhum cadastrado, a tela avisa antes de a emissão recusar', async () => {
    gruposTributarios = [];
    await montar();
    abrir('Fiscal');
    expect(screen.getByText(/ainda não tem grupo tributário cadastrado/i)).toBeTruthy();
  });

  it('e explica de onde vem o IPI (GAP-V08)', async () => {
    await montar();
    abrir('Fiscal');
    // O zero do XML não é defeito: é a tributação do varejo no Simples. Dizê-lo
    // aqui é o que impede a pergunta virar suspeita.
    expect(screen.getByText(/quem define é o grupo tributário, não o produto/i)).toBeTruthy();
  });
});

describe('o serviço de balcão (GAP-V02)', () => {
  it('desmarcar "controla estoque" manda stockControl false', async () => {
    await montar();
    abrir('Estoque');

    fireEvent.click(screen.getByLabelText(/Este produto controla estoque/i));
    salvar();

    expect((await corpoDoSalvar()).stockControl).toBe(false);
  });

  it('desmarcado, saldo e mínimo SOMEM — eles não querem dizer nada num serviço', async () => {
    await montar();
    abrir('Estoque');
    expect(screen.getByText('Em estoque')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Este produto controla estoque/i));

    expect(screen.queryByText('Em estoque')).toBeNull();
    expect(screen.getByText(/Serviço: sem saldo, sem mínimo/i)).toBeTruthy();
  });

  it('o produto que JÁ É serviço abre com a caixa desmarcada', async () => {
    produto = { ...produtoPadrao(), stock_control: 0 };
    await montar();
    abrir('Estoque');
    expect(
      (screen.getByLabelText(/Este produto controla estoque/i) as HTMLInputElement).checked,
    ).toBe(false);
  });
});

describe('embalagem e faixa de preço (GAP-V06 e V04)', () => {
  it('o fator da caixa viaja no Salvar', async () => {
    await montar();
    abrir('Estoque');

    fireEvent.change(screen.getByLabelText(/Unidades por embalagem/i), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText(/Sigla da embalagem/i), { target: { value: 'cx' } });
    salvar();

    const corpo = await corpoDoSalvar();
    expect(corpo.packFactor).toBe(12);
    expect(corpo.packUnit).toBe('CX');
  });

  it('a tela explica que o fator é SUGESTÃO, e não regra', async () => {
    produto = { ...produtoPadrao(), pack_factor: 12, pack_unit: 'CX' };
    await montar();
    abrir('Estoque');
    // O fornecedor pode mudar a caixa sem avisar: quem manda continua sendo a
    // linha da nota.
    expect(screen.getByText(/fator da linha da nota continua mandando/i)).toBeTruthy();
  });

  it('a faixa existente aparece com quantidade e preço', async () => {
    faixas = [
      { id: 'f-1', product_id: PRODUTO_ID, min_quantity: 3, price_cents: 1000, active: 1 },
    ];
    await montar();
    abrir('Preços');
    expect(screen.getByText(/A partir de 3/)).toBeTruthy();
  });

  it('criar a faixa chama a rota PRÓPRIA — ela não espera o Salvar do cadastro', async () => {
    await montar();
    abrir('Preços');

    fireEvent.change(screen.getByLabelText(/A partir de \(quantidade\)/i), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText(/Preço unitário na faixa/i), {
      target: { value: '10,00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar faixa' }));

    await waitFor(() => {
      expect(pedidos.some((p) => p.metodo === 'PUT' && p.url.includes('/price-tiers'))).toBe(true);
    });
    const chamada = pedidos.find((p) => p.metodo === 'PUT' && p.url.includes('/price-tiers'))!;
    // Centavos inteiros, como todo dinheiro desta casa.
    expect(chamada.body).toEqual({ minQuantity: 3, priceCents: 1000 });
  });

  it('a tela diz que a faixa NÃO empilha — é a primeira dúvida de quem a cria', async () => {
    await montar();
    abrir('Preços');
    expect(screen.getByText(/Não soma com promoção nem com tabela de preço/i)).toBeTruthy();
  });
});

describe('campos próprios e histórico (GAP-V07 e V05)', () => {
  it('o campo próprio aparece com o valor do produto e é editável', async () => {
    personalizados = [
      {
        field_id: 'c-1',
        code: 'VOLTAGEM',
        label: 'Voltagem',
        kind: 'select',
        options: '110V\n220V\nBivolt',
        value: '110V',
      },
    ];
    await montar();
    abrir('Campos próprios');

    const seletor = screen.getByLabelText('Voltagem') as HTMLSelectElement;
    expect(seletor.value).toBe('110V');
    fireEvent.change(seletor, { target: { value: 'Bivolt' } });
    salvar();

    await waitFor(() => {
      expect(pedidos.some((p) => p.metodo === 'PUT' && p.url.includes('/custom-fields'))).toBe(
        true,
      );
    });
    const chamada = pedidos.find((p) => p.metodo === 'PUT' && p.url.includes('/custom-fields'))!;
    // Vai no MESMO gesto do Salvar: um segundo botão faria o valor digitado se
    // perder sem nenhum aviso.
    expect(chamada.body).toEqual({ values: { VOLTAGEM: 'Bivolt' } });
  });

  it('sem campo criado, a tela diz ONDE se cria — e não fica em branco', async () => {
    await montar();
    abrir('Campos próprios');
    expect(screen.getByText(/ainda não criou nenhum campo próprio/i)).toBeTruthy();
  });

  it('o histórico mostra de → para, com quem e quando', async () => {
    historico = [
      {
        id: 'a-1',
        action: 'product.update',
        created_at: '2026-08-30T12:00:00.000Z',
        user_id: 'u-1',
        user_name: 'Marina',
        fields: [
          { field: 'price_cents', label: 'Preço de venda', from: '39,90', to: '29,90' },
        ],
      },
    ];
    await montar();
    abrir('Histórico');

    expect(screen.getByText('Marina')).toBeTruthy();
    // A pergunta que o gap nomeia: "quem baixou o preço de 39,90 para 29,90?".
    expect(screen.getByText('39,90')).toBeTruthy();
    expect(screen.getByText('29,90')).toBeTruthy();
    expect(screen.getByText(/Preço de venda/)).toBeTruthy();
  });

  it('registro antigo SEM diff diz que não sabe, em vez de fingir que nada mudou', async () => {
    historico = [
      {
        id: 'a-velha',
        action: 'product.update',
        created_at: '2026-01-02T12:00:00.000Z',
        user_id: null,
        user_name: null,
        fields: [],
      },
    ];
    await montar();
    abrir('Histórico');
    expect(screen.getByText(/o que mudou não foi guardado/i)).toBeTruthy();
  });
});
