/**
 * DEPOIS DO PAGAMENTO — a tela de venda concluída, a nota e o papel.
 *
 *   F-cupom-fiscal-01  REJEITADA/ERRO apareciam como "pendente — será
 *                      transmitida"; e a rejeição que chegava depois de a tela
 *                      fechar nunca aparecia no balcão.
 *   F-cupom-fiscal-02  contingência imprimia o comprovante NÃO fiscal.
 *   F-cupom-fiscal-03  o painel imprimia sem o caixa do computador.
 *   F-cupom-fiscal-05  faturar pré-venda fechava sem tela, sem troco, sem papel.
 *   D-pdv-teclado-M04  depois da venda offline o painel apontava a anterior.
 *   D-pdv-teclado-08   offline com acréscimo mostrava troco errado.
 *   D-pdv-teclado-19   o resumo do cupom usava o preço digitado, e não o cobrado.
 *   F-cupom-fiscal-10  o motivo da falha de impressão virava "Confira a impressora".
 *   F-cupom-fiscal-11  a impressão da venda A fechava ou sujava a tela da venda B.
 *   F-cupom-fiscal-18  o motivo de o papel ter caído no navegador sumia.
 *   F-cupom-fiscal-12  bipe com a tela aberta (pagamento aberto pelo mouse):
 *                      o foco voltava ao botão Finalizar e o código se perdia.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

const printDocument = vi.fn(async (..._args: unknown[]) => ({ via: 'navegador', aviso: null as string | null }));
vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: (...args: unknown[]) => printDocument(...args),
}));

function produto(id: string, nome: string, barcode: string, preco: number) {
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
  };
}
const ARROZ = produto('p1', 'ARROZ X 5kg', '7898215151784', 2190);
const FEIJAO = produto('p2', 'FEIJÃO CARIOCA 1kg', '7896006711116', 890);
const VESTIDO = produto('p7', 'VESTIDO LONGO', '7890000000077', 8700);
const TODOS = [ARROZ, FEIJAO, VESTIDO];

let vendas: { corpo: Record<string, unknown> }[];
let redeFora: boolean;
let disparo: { modo: string; disparada: boolean; motivos: string[] };
let statusDaNota: Record<string, unknown>;

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      return responder({ items: TODOS.filter((p) => p.barcode === q), catalogoVazio: false });
    }
    const umProduto = alvo.match(/\/core\/products\/(p\d)$/);
    if (umProduto) return responder(TODOS.find((p) => p.id === umProduto[1]));
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/quotes/q-pre/convert') && metodo === 'POST') {
      return responder({ saleId: 'venda-conv', number: 345, nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: [] } }, 201);
    }
    if (alvo.match(/\/core\/quotes\/q-pre$/)) {
      return responder({
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
        items: [{ id: 'i-1', product_id: 'p7', description: 'VESTIDO LONGO', quantity: 1, unit_price_cents: 8700, total_cents: 8700 }],
      });
    }
    if (alvo.match(/\/core\/sales\/venda-conv$/)) {
      return responder({
        id: 'venda-conv',
        number: 345,
        status: 'completed',
        subtotal_cents: 8700,
        discount_cents: 0,
        surcharge_cents: 0,
        total_cents: 8700,
        change_cents: 1300,
        items: [{ id: 'si-1', product_id: 'p7', description: 'VESTIDO LONGO', quantity: 1, unit_price_cents: 8700, total_cents: 8700 }],
        payments: [{ id: 'pg-1', method: 'dinheiro', amount_cents: 10000, status: 'settled' }],
      });
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      if (redeFora) throw new TypeError('Failed to fetch');
      const corpo = JSON.parse(init?.body ?? '{}');
      vendas.push({ corpo });
      const n = vendas.length;
      return responder(
        {
          id: `venda-${n}`,
          number: 100 + n,
          subtotal_cents: 2190,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: 2190,
          change_cents: 0,
          nfceNoFinalizar: disparo,
        },
        201,
      );
    }
    const fiscal = alvo.match(/\/core\/fiscal\/sales\/([^/]+)\/status/);
    if (fiscal) return responder(statusDaNota[fiscal[1]] ?? null);
    if (alvo.includes('/core/cash/open')) {
      return responder({
        session: { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' },
        cashWithdrawalLimitCents: null,
        terminal: { id: 'cx1', name: 'Caixa 1' },
      });
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
    'teste da venda concluída',
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

async function venderRapido(campo: HTMLInputElement, codigo: string, nome: string) {
  bipar(campo, codigo);
  await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${nome}`)).toBeTruthy());
  fireEvent.keyDown(campo, { key: 'F8' });
  return screen.findByRole('dialog', { name: 'Venda concluída' });
}

async function pagarNoDialogo(recebido: string, acrescimo?: string) {
  const valor = (await screen.findByPlaceholderText(/Vazio =/, {}, { timeout: 4000 })) as HTMLInputElement;
  if (acrescimo) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Acréscimo (juros, frete)' }), { target: { value: acrescimo } });
  }
  fireEvent.change(valor, { target: { value: recebido } });
  fireEvent.submit(valor.closest('form')!);
  await waitFor(() => expect(screen.getAllByText(/Dinheiro/).length).toBeGreaterThan(0));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });
}

beforeEach(() => {
  vendas = [];
  redeFora = false;
  disparo = { modo: 'MANUAL', disparada: false, motivos: ['Emissão manual nesta loja'] };
  statusDaNota = {};
  printDocument.mockReset();
  printDocument.mockImplementation(async () => ({ via: 'navegador', aviso: null }));
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste da venda concluída');
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('F-01: a nota que não vai sair', () => {
  it('REJEITADA: vermelha, com cStat e motivo, sem "será transmitida" — e a faixa fica no balcão', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = {
      document: { id: 'doc-1', status: 'REJECTED', cStat: '778', xMotivo: 'NCM inexistente' },
      statusLabel: 'NFC-e rejeitada',
      terminal: true,
      isTest: false,
    };
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    const fiscal = within(dialogo).getByTestId('venda-concluida-fiscal');
    await waitFor(() => expect(fiscal.getAttribute('data-estado')).toBe('rejeitada'), { timeout: 4000 });
    expect(fiscal.textContent).toContain('REJEITADA');
    expect(fiscal.textContent).toContain('778');
    expect(fiscal.textContent).not.toMatch(/será transmitida/);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect((await screen.findByTestId('pdv-nota-sem-nota')).textContent).toContain('#101');
  });

  it('a rejeição que chega DEPOIS de a tela fechar também aparece', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = {
      document: { id: 'doc-1', status: 'REJECTED', cStat: '778', xMotivo: 'NCM inexistente' },
      statusLabel: 'NFC-e rejeitada',
      terminal: true,
      isTest: false,
    };
    const campo = abrirPdv();
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    // O caixa fecha a tela na hora — antes de a SEFAZ responder.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    const faixa = await screen.findByTestId('pdv-nota-sem-nota', {}, { timeout: 4000 });
    expect(faixa.textContent).toContain('REJEITADA');
  });

  it('ERRO com a fila morta: "sem nota", com o motivo', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = {
      document: { id: 'doc-1', status: 'ERROR', cStat: null, xMotivo: null },
      statusLabel: 'Com erro',
      terminal: false,
      isTest: false,
      queue: { attempts: 5, nextAttemptAt: null, status: 'dead', errorMessage: 'Certificado vencido' },
    };
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    const fiscal = within(dialogo).getByTestId('venda-concluida-fiscal');
    await waitFor(() => expect(fiscal.getAttribute('data-estado')).toBe('erro'), { timeout: 4000 });
    expect(fiscal.textContent).toContain('Certificado vencido');
  });
});

describe('F-02: contingência entrega o DANFCE de contingência', () => {
  it('o Imprimir da tela pede o DANFCE do documento, pela impressora deste caixa', async () => {
    disparo = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota['venda-1'] = {
      document: { id: 'doc-9', status: 'CONTINGENCY', cStat: null, xMotivo: null },
      statusLabel: 'Em contingência',
      terminal: false,
      isTest: false,
      contingencia: { offline: true, pendente: true, prazoDeTransmissao: null },
    };
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    const fiscal = within(dialogo).getByTestId('venda-concluida-fiscal');
    await waitFor(() => expect(fiscal.getAttribute('data-estado')).toBe('contingencia'), { timeout: 4000 });
    expect(fiscal.textContent).not.toMatch(/NÃO fiscal/);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('DANFCE', 'doc-9', { terminalId: 'cx1' }));
  });
});

describe('F-05 / D-09 / M04: faturar a pré-venda', () => {
  it('abre a tela de venda concluída com o troco, imprime o cupom DESTA venda, e o painel aponta para ela', async () => {
    const campo = abrirPdv('/pdv?documento=q-pre');
    await screen.findByText(/Faturando/);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${VESTIDO.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    await pagarNoDialogo('100,00');

    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(within(dialogo).getByTestId('venda-concluida-numero').textContent).toContain('345');
    expect(within(dialogo).getByTestId('venda-concluida-troco').textContent).toMatch(/13,00/);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('SALE_RECEIPT', 'venda-conv', { terminalId: 'cx1' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());

    // O painel do comprovante é o DESTA venda — e imprime pela térmica deste caixa.
    printDocument.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'imprimir comprovante' }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('SALE_RECEIPT', 'venda-conv', { terminalId: 'cx1' }));
  });
});

describe('M04 / D-08: a venda offline', () => {
  it('depois da venda offline o painel não aponta mais para a venda anterior', async () => {
    const campo = abrirPdv();
    await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await screen.findByRole('button', { name: 'imprimir comprovante' });

    redeFora = true;
    await venderRapido(campo, FEIJAO.barcode, FEIJAO.name);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'imprimir comprovante' })).toBeNull();
  });

  it('offline com acréscimo: total com o acréscimo e troco ZERO quando o cliente pagou o certo', async () => {
    redeFora = true;
    const campo = abrirPdv();
    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeTruthy());
    fireEvent.keyDown(campo, { key: 'F10' });
    // R$ 8,90 + R$ 1,10 de frete = R$ 10,00, pagos com R$ 10,00.
    await pagarNoDialogo('10,00', '1,10');

    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('offline');
    expect(within(dialogo).getByTestId('venda-concluida-troco').textContent).toMatch(/0,00/);
    expect(within(dialogo).getByTestId('venda-concluida-total').textContent).toMatch(/10,00/);
  });
});

describe('D-19: o resumo do cupom mostra o preço cobrado', () => {
  it('preço digitado acima do vigente: o item aparece pelo vigente', async () => {
    const campo = abrirPdv();
    fireEvent.change(screen.getByPlaceholderText('R$ 0,00'), { target: { value: '50,00' } });
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    const resumo = within(dialogo).getByText(/Resumo do cupom/).closest('details')!;
    expect(resumo.textContent).toContain('21,90');
    expect(resumo.textContent).not.toContain('50,00');
  });
});

describe('a impressão da venda concluída', () => {
  it('F-10: o motivo de verdade aparece (sem papel), e não "Confira a impressora"', async () => {
    printDocument.mockRejectedValueOnce(new Error('Impressora sem papel'));
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    expect((await within(dialogo).findByRole('alert')).textContent).toContain('sem papel');
  });

  it('F-11: a falha do cupom da venda A não suja a tela da venda B — vai para a faixa, com o número', async () => {
    let falharA: (e: Error) => void = () => undefined;
    printDocument.mockImplementationOnce(
      () => new Promise((_, rejeitar) => {
        falharA = rejeitar;
      }),
    );
    const campo = abrirPdv();
    const dialogoA = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogoA).getByRole('button', { name: /Imprimir/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());

    const dialogoB = await venderRapido(campo, FEIJAO.barcode, FEIJAO.name);
    expect(within(dialogoB).getByTestId('venda-concluida-numero').textContent).toContain('102');
    falharA(new Error('Impressora sem papel'));

    await screen.findByText(/cupom da venda #101 não saiu: Impressora sem papel/);
    expect(screen.getByRole('dialog', { name: 'Venda concluída' })).toBeTruthy();
    expect(within(dialogoB).queryByRole('alert')).toBeNull();
  });

  it('F-11: o fim da impressão da venda A não fecha a tela da venda B', async () => {
    let terminarA: (v: { via: string; aviso: null }) => void = () => undefined;
    printDocument.mockImplementationOnce(
      () => new Promise((resolver) => {
        terminarA = resolver;
      }),
    );
    const campo = abrirPdv();
    const dialogoA = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogoA).getByRole('button', { name: /Imprimir/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());

    await venderRapido(campo, FEIJAO.barcode, FEIJAO.name);
    terminarA({ via: 'agente', aviso: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('dialog', { name: 'Venda concluída' })).toBeTruthy();
  });

  it('F-18: o papel que caiu no navegador diz por quê', async () => {
    printDocument.mockResolvedValueOnce({ via: 'navegador', aviso: 'A térmica do Caixa 1 está sem endereço.' });
    const campo = abrirPdv();
    const dialogo = await venderRapido(campo, ARROZ.barcode, ARROZ.name);
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    expect(await screen.findByText(/sem endereço/)).toBeTruthy();
  });
});

describe('F-12 / D-10: bipe com a tela aberta, pagamento aberto pelo MOUSE', () => {
  it('o código inteiro chega ao campo de leitura — o foco não volta ao botão Finalizar', async () => {
    const campo = abrirPdv();
    bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
    const finalizar = screen.getByRole('button', { name: 'Finalizar (F10)' });
    finalizar.focus();
    fireEvent.click(finalizar);
    await pagarNoDialogo('');
    await screen.findByRole('dialog', { name: 'Venda concluída' });

    // O leitor digita no que estiver com o foco; só um campo de texto recebe o caractere.
    for (const c of ['7', '8', '9']) {
      const alvo = document.activeElement ?? document.body;
      const naoCancelada = fireEvent.keyDown(alvo, { key: c });
      if (naoCancelada && alvo === campo) fireEvent.change(campo, { target: { value: campo.value + c } });
    }
    expect(document.activeElement).toBe(campo);
    expect(campo.value).toBe('789');
  });
});
