/**
 * ============================================================================
 * CONCILIAÇÃO PEDIDO × NF-e — a tela que faltava para a comparação existir
 * ============================================================================
 *
 * A auditoria (P3, reafirmado em audit-purchase.test.ts) encontrou o motor
 * inteiro pronto e NENHUMA porta: `linkNoteToPurchaseOrder` existia no cliente
 * sem chamador, e a conciliação pedido×nota era inalcançável pela interface —
 * na prática, pedido real nunca saía de "enviado". Esta tela é a porta, e
 * estes casos provam que ela:
 *
 *  1. mostra a régua CERTA por linha — a MESMA de `recalcReceived` no
 *     servidor: conferido COALESCE faturado, × fator de conversão. A tela não
 *     inventa motor; ela projeta o que o servidor já calcula;
 *  2. sinaliza cada espécie de divergência com nome: doca contou menos,
 *     sobra contra o pedido, preço que difere, item extra da nota, item do
 *     pedido que não veio, item da nota sem produto casado;
 *  3. só oferece as ações que o servidor SUPORTA, e chama as rotas certas:
 *     conferir, vincular, confirmar — nada fictício.
 *
 * Como cada caso quebra sem a tela certa:
 *  - some a coluna Estado → o comprador volta a comparar de cabeça;
 *  - a conferida ignorar o fator → 2 CX viram "faltam 22" com prateleira cheia
 *    (o MESMO defeito que recalcReceived já teve, do lado de lá);
 *  - o extra da nota sumir → mercadoria não pedida entra calada;
 *  - a ação chamar outra rota → o clique não faz o que a tela promete.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ConciliacaoRecebimentoPage from '../ConciliacaoRecebimentoPage';

// ------------------------------------------------------------------- massa
//
// Dinheiro SEMPRE em centavos inteiros, como no resto da casa.

const CHAVE = '35260814200166000187550010000045011000045011';

/** O pedido 41 concentra TODAS as espécies de divergência, uma por linha. */
const PEDIDO_41 = {
  id: 'o-1',
  number: 41,
  supplier_id: 'f-1',
  supplier_name: 'Distribuidora Riacho Ltda',
  supplier_trade_name: 'Riacho Autopeças',
  status: 'recebido_parcial',
  expected_at: '2026-08-20',
  notes: null,
  total_cents: 65_400,
  cancel_reason: null,
  created_at: '2026-08-15T12:00:00.000Z',
};

const DETALHE_41 = {
  ...PEDIDO_41,
  supplier: {
    name: 'Distribuidora Riacho Ltda',
    trade_name: 'Riacho Autopeças',
    document: '14200166000187',
  },
  items: [
    // A doca contou 8 do faturado 10 → DIVERGÊNCIA (contou menos).
    { id: 'i-pastilha', product_id: 'p-pastilha', internal_code: 'PST-01', description: 'Pastilha de freio', quantity: 10, unit_cost_cents: 2500, total_cents: 25_000, received_quantity: 8 },
    // Não veio em nota nenhuma → PENDENTE, sinalizado como faltante.
    { id: 'i-cabo', product_id: 'p-cabo', internal_code: 'CBO-02', description: 'Cabo de embreagem', quantity: 6, unit_cost_cents: 1000, total_cents: 6_000, received_quantity: 0 },
    // Nota fatura 2 CX com fator 12 = 24 UN → OK, e a célula DIZ a conversão.
    { id: 'i-parafuso', product_id: 'p-parafuso', internal_code: 'PRF-03', description: 'Parafuso M6', quantity: 24, unit_cost_cents: 100, total_cents: 2_400, received_quantity: 24 },
    // Quantidade fecha, preço não: nota cobra 35,00 num pedido de 30,00.
    { id: 'i-oleo', product_id: 'p-oleo', internal_code: 'OLE-04', description: 'Óleo 20W50', quantity: 4, unit_cost_cents: 3000, total_cents: 12_000, received_quantity: 4 },
    // A nota fatura 12 num pedido de 10 → DIVERGÊNCIA (sobra).
    { id: 'i-farol', product_id: 'p-farol', internal_code: 'FRL-05', description: 'Farol dianteiro', quantity: 10, unit_cost_cents: 2000, total_cents: 20_000, received_quantity: 12 },
  ],
  inboundNotes: [
    { id: 'n-1', access_key: CHAVE, number: '4501', series: '1', total_cents: 65_900, status: 'recebida', received_at: '2026-08-22T14:00:00.000Z' },
  ],
};

/** Os itens da nota 4501, na ordem do arquivo (o índice É o contrato do conferir). */
const ITENS_N1 = [
  { description: 'Pastilha de freio', productId: 'p-pastilha', quantity: 10, receivedQuantity: 8, conversionFactor: null, unitCostCents: 2500, totalCents: 25_000, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: 'name', divergenceNote: 'Duas caixas não desceram', barcode: null, ncm: null, cfop: null, supplierCode: null },
  { description: 'Parafuso M6 CX12', productId: 'p-parafuso', quantity: 2, receivedQuantity: null, conversionFactor: 12, unitCostCents: 1200, totalCents: 2_400, unit: 'CX', unitTrib: 'UN', quantityTrib: 24, matchedBy: 'manual', divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
  { description: 'Óleo 20W50', productId: 'p-oleo', quantity: 4, receivedQuantity: 4, conversionFactor: null, unitCostCents: 3500, totalCents: 14_000, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: 'barcode', divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
  { description: 'Farol dianteiro', productId: 'p-farol', quantity: 12, receivedQuantity: 12, conversionFactor: null, unitCostCents: 2000, totalCents: 24_000, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: 'name', divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
  // Produto casado no catálogo, mas FORA do pedido: item extra.
  { description: 'Brinde caneta', productId: 'p-caneta', quantity: 5, receivedQuantity: null, conversionFactor: null, unitCostCents: 0, totalCents: 0, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: 'name', divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
  // Sem produto casado: a régua do recalc não o conta, e a tela precisa dizer.
  { description: 'Peça misteriosa', productId: null, quantity: 1, receivedQuantity: null, conversionFactor: null, unitCostCents: 500, totalCents: 500, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: null, divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
];

/** O pedido 42 chegou inteiro, contado e no preço: linha OK, pedido concluído. */
const PEDIDO_42 = { ...PEDIDO_41, id: 'o-2', number: 42, status: 'recebido', total_cents: 25_000 };
const DETALHE_42 = {
  ...PEDIDO_42,
  supplier: DETALHE_41.supplier,
  items: [
    { id: 'i-so', product_id: 'p-pastilha', internal_code: 'PST-01', description: 'Pastilha de freio', quantity: 10, unit_cost_cents: 2500, total_cents: 25_000, received_quantity: 10 },
  ],
  inboundNotes: [
    { id: 'n-9', access_key: CHAVE.replace(/1$/, '9'), number: '4509', series: '1', total_cents: 25_000, status: 'recebida', received_at: '2026-08-23T09:00:00.000Z' },
  ],
};
const ITENS_N9 = [
  { description: 'Pastilha de freio', productId: 'p-pastilha', quantity: 10, receivedQuantity: 10, conversionFactor: null, unitCostCents: 2500, totalCents: 25_000, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: 'name', divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
];

/** O pedido 43 tem nota amarrada AINDA EM CONFERÊNCIA: é onde as ações vivem. */
const PEDIDO_43 = { ...PEDIDO_41, id: 'o-3', number: 43, status: 'enviado', total_cents: 25_000 };
const DETALHE_43 = {
  ...PEDIDO_43,
  supplier: DETALHE_41.supplier,
  items: [
    { id: 'i-p43', product_id: 'p-pastilha', internal_code: 'PST-01', description: 'Pastilha de freio', quantity: 10, unit_cost_cents: 2500, total_cents: 25_000, received_quantity: 0 },
  ],
  inboundNotes: [
    { id: 'n-2', access_key: CHAVE.replace(/1$/, '2'), number: '4502', series: '1', total_cents: 25_000, status: 'importada', received_at: null },
  ],
};
const ITENS_N2 = [
  { description: 'Pastilha de freio', productId: 'p-pastilha', quantity: 10, receivedQuantity: null, conversionFactor: null, unitCostCents: 2500, totalCents: 25_000, unit: 'UN', unitTrib: null, quantityTrib: null, matchedBy: 'name', divergenceNote: null, barcode: null, ncm: null, cfop: null, supplierCode: null },
];

/** A lista de notas da casa — é dela que sai a candidata a vincular (n-3). */
const NOTAS = [
  { id: 'n-1', access_key: CHAVE, number: '4501', series: '1', supplier_name: 'Distribuidora Riacho Ltda', total_cents: 65_900, status: 'recebida', created_at: '2026-08-22T08:00:00.000Z' },
  { id: 'n-2', access_key: CHAVE.replace(/1$/, '2'), number: '4502', series: '1', supplier_name: 'Distribuidora Riacho Ltda', total_cents: 25_000, status: 'importada', created_at: '2026-08-24T08:00:00.000Z' },
  { id: 'n-3', access_key: CHAVE.replace(/1$/, '3'), number: '4503', series: '1', supplier_name: 'Distribuidora Riacho Ltda', total_cents: 9_900, status: 'importada', created_at: '2026-08-25T08:00:00.000Z' },
];

// ---------------------------------------------------------------- servidor

/** O que o teste precisa ler de cada chamada — sem depender do tipo global do DOM. */
interface Chamada {
  method?: string;
  body?: string;
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: Chamada) => {
    const alvo = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    // As ações devolvem o suficiente para a tela recarregar sem quebrar.
    if (init?.method === 'POST') {
      if (alvo.includes('/conferir')) return json({ items: ITENS_N2 });
      if (alvo.includes('/confirm')) return json({ noteId: 'n-2', movedItems: 1, createdProducts: 0, divergentItems: 0 });
      if (alvo.includes('/purchase-orders/o-3/notes/')) return json(DETALHE_43);
      return json({});
    }

    if (alvo.includes('/core/purchase-orders/o-1')) return json(DETALHE_41);
    if (alvo.includes('/core/purchase-orders/o-2')) return json(DETALHE_42);
    if (alvo.includes('/core/purchase-orders/o-3')) return json(DETALHE_43);
    if (alvo.includes('/core/purchase-orders')) return json({ items: [PEDIDO_41, PEDIDO_42, PEDIDO_43] });
    if (alvo.includes('/core/purchases/notes/n-1/items')) return json({ items: ITENS_N1 });
    if (alvo.includes('/core/purchases/notes/n-9/items')) return json({ items: ITENS_N9 });
    if (alvo.includes('/core/purchases/notes/n-2/items')) return json({ items: ITENS_N2 });
    if (alvo.includes('/core/purchases/notes')) return json({ items: NOTAS });
    return json({ items: [] });
  });
}

function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da conciliação de recebimento',
  );
}

let fetchMock: ReturnType<typeof servidor>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = servidor();
  vi.stubGlobal('fetch', fetchMock);
  entrar('estoquista');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <ConciliacaoRecebimentoPage />
    </MemoryRouter>,
  );
}

/** Abre o pedido pelo botão da lista — a ação "abrir pedido" da tela. */
async function abrirPedido(numero: string) {
  const linha = (await screen.findByText(numero)).closest('tr')!;
  fireEvent.click(
    Array.from(linha.querySelectorAll('button')).find((b) => b.textContent === 'Conciliar')!,
  );
}

/**
 * A célula de uma coluna na linha de um item — pela POSIÇÃO do cabeçalho, não
 * pelo texto da linha inteira: um "Divergência" no motivo da linha vizinha
 * deixaria um teste de substring verde com a coluna errada.
 */
function celula(item: string, coluna: string): string {
  const linha = screen.getByText(item).closest('tr')!;
  const cabecalhos = Array.from(linha.closest('table')!.querySelectorAll('thead th')).map(
    (th) => th.textContent?.trim(),
  );
  const indice = cabecalhos.indexOf(coluna);
  expect(indice, `coluna "${coluna}" não existe na tabela`).toBeGreaterThan(-1);
  return linha.querySelectorAll('td')[indice]?.textContent ?? '';
}

function linhaDe(item: string): HTMLElement {
  return screen.getByText(item).closest('tr')! as HTMLElement;
}

/** As chamadas de escrita que o clique disparou: [url, corpo]. */
function escritas(): [string, Record<string, unknown>][] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => [
      String(url),
      JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    ]);
}

// ================================================================== A RÉGUA

describe('a régua por linha — a mesma do recalcReceived, projetada na tela', () => {
  it('o pedido 41 mostra cada espécie de divergência com nome, linha a linha', async () => {
    montar();
    await abrirPedido('#41');

    // O quadro identifica fornecedor e nota: número/série, chave e data.
    // (getAll: o nome do fornecedor também aparece nas candidatas a vincular.)
    await screen.findByText('Pastilha de freio');
    expect(screen.getAllByText(/Distribuidora Riacho Ltda/).length).toBeGreaterThan(0);
    expect(screen.getByText(/4501\/1/)).toBeTruthy();
    expect(screen.getByText(new RegExp(CHAVE))).toBeTruthy();
    expect(screen.getByText(/22\/08\/2026/)).toBeTruthy();

    // Doca contou 8 do faturado 10: divergência, dita com as palavras da doca.
    expect(celula('Pastilha de freio', 'Estado')).toContain('Divergência');
    expect(celula('Pastilha de freio', 'Conferida')).toContain('8');
    expect(linhaDe('Pastilha de freio').textContent).toContain('contou menos');

    // Não veio em nota nenhuma: pendente, sinalizado como faltante.
    expect(celula('Cabo de embreagem', 'Estado')).toContain('Pendente');
    expect(linhaDe('Cabo de embreagem').textContent).toContain('não veio em nota');

    // 2 CX × fator 12 = 24 UN: OK — e a conversão é DITA na célula.
    expect(celula('Parafuso M6', 'Estado')).toContain('OK');
    expect(celula('Parafuso M6', 'Faturada')).toMatch(/2\s*×\s*12\s*=\s*24/);
    expect(celula('Parafuso M6', 'Conferida')).toContain('24');

    // Quantidade fecha, preço não: 35,00 contra 30,00 pedidos.
    expect(celula('Óleo 20W50', 'Estado')).toContain('Divergência');
    expect(linhaDe('Óleo 20W50').textContent).toContain('preço difere');
    expect(celula('Óleo 20W50', 'Preço pedido')).toContain('30,00');
    expect(celula('Óleo 20W50', 'Preço nota')).toContain('35,00');

    // A nota fatura 12 num pedido de 10: sobra é divergência, não prêmio.
    expect(celula('Farol dianteiro', 'Estado')).toContain('Divergência');
    expect(linhaDe('Farol dianteiro').textContent).toContain('sobra');

    // Item da nota FORA do pedido: aparece, e aparece como extra.
    expect(linhaDe('Brinde caneta').textContent).toContain('item extra');

    // Item sem produto casado: a régua não o conta, e a tela diz por quê.
    expect(linhaDe('Peça misteriosa').textContent).toContain('sem produto casado');

    // E o pedido inteiro carrega o pior estado das linhas.
    expect(screen.getByTestId('estado-do-pedido').textContent).toContain('Divergência');
  });

  it('o pedido 42, inteiro e no preço, é linha OK e pedido Concluído', async () => {
    montar();
    await abrirPedido('#42');
    await screen.findByText('Pastilha de freio');

    expect(celula('Pastilha de freio', 'Estado')).toContain('OK');
    expect(screen.getByTestId('estado-do-pedido').textContent).toContain('Concluído');
  });

  it('o pedido 43, com nota em conferência que bate item a item, é OK aguardando confirmação', async () => {
    montar();
    await abrirPedido('#43');
    await screen.findByText('Pastilha de freio');

    // A régua COALESCE: ninguém conferiu ainda, vale o faturado — 10 de 10.
    expect(celula('Pastilha de freio', 'Estado')).toContain('OK');
    expect(screen.getByTestId('estado-do-pedido').textContent).toContain('OK');
  });
});

// ================================================================== AS AÇÕES

describe('as ações chamam as rotas que o servidor de fato tem', () => {
  it('conferir manda itemIndex e receivedQuantity para /purchases/notes/:id/conferir', async () => {
    montar();
    await abrirPedido('#43');
    await screen.findByText('Pastilha de freio');

    const entrada = screen.getByLabelText(/Conferida do item 1 da nota 4502/);
    fireEvent.change(entrada, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir' }));

    await waitFor(() => {
      const chamada = escritas().find(([url]) => url.includes('/core/purchases/notes/n-2/conferir'));
      expect(chamada, 'nenhum POST em /purchases/notes/n-2/conferir').toBeTruthy();
      expect(chamada![1].itemIndex).toBe(0);
      expect(chamada![1].receivedQuantity).toBe(8);
    });
  });

  it('confirmar recebimento chama /purchases/notes/:id/confirm', async () => {
    montar();
    await abrirPedido('#43');
    await screen.findByText('Pastilha de freio');

    fireEvent.click(screen.getByRole('button', { name: /Confirmar recebimento/ }));

    await waitFor(() => {
      expect(
        escritas().some(([url]) => url.includes('/core/purchases/notes/n-2/confirm')),
        'nenhum POST em /purchases/notes/n-2/confirm',
      ).toBe(true);
    });
  });

  it('vincular amarra pela rota do pedido: POST /purchase-orders/:id/notes/:noteId', async () => {
    montar();
    await abrirPedido('#43');
    await screen.findByText('Pastilha de freio');

    // A nota já amarrada (4502) não é candidata; a 4503 é.
    const seletor = screen.getByLabelText(/Nota a vincular/) as HTMLSelectElement;
    expect(Array.from(seletor.options).map((o) => o.value)).not.toContain('n-2');
    fireEvent.change(seletor, { target: { value: 'n-3' } });
    fireEvent.click(screen.getByRole('button', { name: /Vincular ao pedido/ }));

    await waitFor(() => {
      expect(
        escritas().some(([url]) => url.includes('/core/purchase-orders/o-3/notes/n-3')),
        'nenhum POST em /purchase-orders/o-3/notes/n-3',
      ).toBe(true);
    });
  });

  it('abrir a NF-e leva para a Entrada de notas — a tela não duplica a conferência inteira', async () => {
    montar();
    await abrirPedido('#41');
    await screen.findByText('Pastilha de freio');

    const link = screen.getByRole('link', { name: /Abrir NF-e/ });
    expect(link.getAttribute('href')).toBe('/sistema/compras/entrada-notas');
  });

  it('nota ESTORNADA amarrada aparece com o selo próprio e SEM ações — documento morto (GAP-V20)', async () => {
    /*
      O estorno da entrada nasceu no servidor com três recusas (conferir,
      reconfirmar, amarrar — todas 409). A tela não pode oferecer o que o
      servidor nega: a nota estornada não entra na "Conferência da doca" nem
      ganha o botão de confirmar, e o selo diz o que houve — chamá-la de "Em
      conferência" convidaria alguém a conferi-la de novo.
    */
    DETALHE_43.inboundNotes = [
      { id: 'n-2', access_key: CHAVE.replace(/1$/, '2'), number: '4502', series: '1', total_cents: 25_000, status: 'estornada', received_at: null },
    ];
    try {
      montar();
      await abrirPedido('#43');
      await screen.findByText('Pastilha de freio');

      expect(screen.getByText('Estornada')).toBeTruthy();
      expect(screen.queryByText('Em conferência')).toBeNull();
      expect(screen.queryByRole('button', { name: /Confirmar recebimento/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Conferir' })).toBeNull();
    } finally {
      // A massa é módulo-viva: devolve o retrato original para os vizinhos.
      DETALHE_43.inboundNotes = [
        { id: 'n-2', access_key: CHAVE.replace(/1$/, '2'), number: '4502', series: '1', total_cents: 25_000, status: 'importada', received_at: null },
      ];
    }
  });
});
