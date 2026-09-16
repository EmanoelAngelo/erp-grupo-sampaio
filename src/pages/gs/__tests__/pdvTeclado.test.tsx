/**
 * O PDV DA PREÇO JUSTO, SÓ NO TECLADO E NO SCANNER.
 *
 * O scanner é um teclado que digita o código e aperta Enter. O caixa passa
 * vários produtos em sequência sem tocar no mouse, fecha no F10, lança o valor
 * recebido, confirma — e vê a tela de VENDA CONCLUÍDA, onde Enter imprime e Esc
 * começa a próxima venda com o foco de volta no campo de leitura.
 *
 * O servidor aqui é dublado (fetch): é a tela que está sendo provada. O que o
 * servidor faz com a venda está em server/tests/preco-justo-balcao.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { queued } from '@/lib/api/offlineQueue';
import PdvPage from '../PdvPage';

const printDocument = vi.fn(async () => ({ via: 'navegador', aviso: null }));
vi.mock('@/lib/print', async (original) => ({
  ...(await original<typeof import('@/lib/print')>()),
  printDocument: (...args: unknown[]) => printDocument(...(args as [])),
}));

const produto = (id: string, nome: string, barcode: string, preco: number) => ({
  id,
  company_id: 'loja',
  name: nome,
  internal_code: `GS-00000${id.slice(-1)}`,
  barcode,
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
});
const ARROZ = produto('p1', 'ARROZ X 5kg', '7898215151784', 2190);
const FEIJAO = produto('p2', 'FEIJÃO CARIOCA 1kg', '7896006711116', 890);
const ARROZ_INTEGRAL = produto('p3', 'ARROZ INTEGRAL 1kg', '7896006711123', 1290);

let vendas: { corpo: unknown; chave: string | null }[] = [];
let redeFora = false;
let disparoDaNota: { modo: string; disparada: boolean; motivos: string[] } = { modo: 'MANUAL', disparada: false, motivos: ['Emissão manual nesta loja'] };
let statusDaNota: unknown = null;

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (alvo.includes('/core/products/search')) {
      const q = decodeURIComponent(alvo.split('q=')[1]?.split('&')[0] ?? '');
      const todos = [ARROZ, FEIJAO, ARROZ_INTEGRAL];
      const exato = todos.filter((p) => p.barcode === q || p.internal_code === q);
      const porNome = todos.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
      return responder({ items: exato.length ? exato : porNome, catalogoVazio: false });
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      if (redeFora) throw new TypeError('Failed to fetch');
      const corpo = JSON.parse(init?.body ?? '{}') as { items: { quantity: number; unitPriceCents?: number }[]; payments: { amountCents: number }[] };
      vendas.push({ corpo, chave: (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? null });
      return responder(
        {
          id: 'venda-1',
          number: 101,
          subtotal_cents: 5270,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: 5270,
          change_cents: 730,
          nfceNoFinalizar: disparoDaNota,
        },
        201,
      );
    }
    if (alvo.includes('/core/fiscal/sales/venda-1/status')) return responder(statusDaNota);
    if (alvo.includes('/core/cash/open')) {
      return responder({ session: { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' }, cashWithdrawalLimitCents: null });
    }
    if (alvo.includes('/core/payment-methods')) {
      return responder({
        methods: [
          { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
          { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
          { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
          { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
        ],
      });
    }
    if (alvo.includes('/core/team') || alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/core/fiscal/pdv-summary')) {
      return responder({ situacao: 'NOT_CONFIGURED', readiness: 'READY_FOR_CERTIFICATE', canEmit: false, blocking: [], pendencies: [], pendencyCount: 0 });
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
    'teste do PDV no teclado',
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

/** O scanner: digita o código e aperta Enter, no campo que está com o foco. */
async function bipar(campo: HTMLInputElement, codigo: string) {
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
}

async function pagarEmDinheiro(recebido: string) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });
  // Com a suíte inteira em paralelo o diálogo demora mais que o 1s padrão.
  const valor = (await screen.findByPlaceholderText(/Vazio =/)) as HTMLInputElement;
  fireEvent.change(valor, { target: { value: recebido } });
  fireEvent.submit(valor.closest('form')!);
  await waitFor(() => expect(screen.getAllByText(/Dinheiro/).length).toBeGreaterThan(0));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F10' });
}

beforeEach(() => {
  vendas = [];
  redeFora = false;
  disparoDaNota = { modo: 'MANUAL', disparada: false, motivos: ['Emissão manual nesta loja'] };
  statusDaNota = null;
  printDocument.mockClear();
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste do PDV no teclado');
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('M. scanner em sequência, sem mouse', () => {
  it('cada bipe entra no carrinho e o foco volta ao campo de leitura para o próximo', async () => {
    const campo = abrirPdv();
    await bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getAllByText(ARROZ.name).length).toBeGreaterThan(0));
    await waitFor(() => expect(document.activeElement).toBe(campo));
    expect(campo.value).toBe('');
    await bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getAllByText(FEIJAO.name).length).toBeGreaterThan(0));
    expect(document.activeElement).toBe(campo);
  });

  it('"3*código" lança três unidades pelo próprio campo', async () => {
    const campo = abrirPdv();
    await bipar(campo, `3*${FEIJAO.barcode}`);
    await waitFor(() => expect(screen.getAllByText(FEIJAO.name).length).toBeGreaterThan(0));
    expect(screen.getByDisplayValue('3')).toBeTruthy();
  });

  it('a faixa de atalhos está na tela para o operador aprender', () => {
    abrirPdv();
    const faixa = screen.getByTestId('pdv-atalhos');
    for (const tecla of ['Enter', 'F10', 'F8', 'Esc', 'Ctrl+Del']) expect(faixa.textContent).toContain(tecla);
  });
});

describe('L. busca por nome e escolha pela seta', () => {
  it('↓ destaca o segundo resultado e Enter põe ele no carrinho', async () => {
    const campo = abrirPdv();
    await bipar(campo, 'arroz');
    await waitFor(() => expect(document.querySelectorAll('[aria-selected]').length).toBe(2));
    fireEvent.keyDown(campo, { key: 'ArrowDown' });
    await waitFor(() => expect(document.querySelector('[data-destaque="sim"]')?.textContent).toContain(ARROZ_INTEGRAL.name));
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(document.querySelectorAll('[aria-selected]').length).toBe(0));
    expect(screen.getAllByText(ARROZ_INTEGRAL.name).length).toBeGreaterThan(0);
  });

  it('Ctrl+Del tira o último item do carrinho', async () => {
    const campo = abrirPdv();
    await bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getAllByText(ARROZ.name).length).toBeGreaterThan(0));
    fireEvent.keyDown(campo, { key: 'Delete', ctrlKey: true });
    await waitFor(() => expect(screen.getByText(/Item removido: ARROZ X 5kg/)).toBeTruthy());
  });
});

describe('N, O, P, Q. pagamento em dinheiro, venda concluída, imprimir ou não', () => {
  it('troco correto, tela de venda concluída; Esc = não imprimir e nova venda com o foco no campo', async () => {
    const campo = abrirPdv();
    await bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getAllByText(ARROZ.name).length).toBeGreaterThan(0));
    await bipar(campo, `3*${FEIJAO.barcode}`);
    await waitFor(() => expect(screen.getAllByText(FEIJAO.name).length).toBeGreaterThan(0));
    await pagarEmDinheiro('60,00');

    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(vendas).toHaveLength(1);
    expect(within(dialogo).getByTestId('venda-concluida-numero').textContent).toContain('101');
    expect(within(dialogo).getByTestId('venda-concluida-troco').textContent).toMatch(/7,30/);
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('nao_fiscal');
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').textContent).toContain('COMPROVANTE NÃO FISCAL');
    // O botão Imprimir nasce com o foco: Enter imprimiria.
    // O foco entra num efeito do diálogo, depois do render que o desenha — no
    // mesmo lote de efeitos que liga o Esc dele. Lido logo depois do
    // `findByRole`, ainda estava fora; e o Esc abaixo caía sem ouvinte.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Imprimir'));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());
    expect(printDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Pesquise por código/)));
  });

  it('Imprimir envia o comprovante da venda (e não refaz a venda)', async () => {
    const campo = abrirPdv();
    await bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getAllByText(ARROZ.name).length).toBeGreaterThan(0));
    await pagarEmDinheiro('');
    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('SALE_RECEIPT', 'venda-1', expect.anything()));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());
    expect(vendas).toHaveLength(1);
  });

  it('NFC-e enviada: aparece PENDENTE e vira AUTORIZADA quando a SEFAZ responde — Imprimir entrega o DANFE', async () => {
    disparoDaNota = { modo: 'AUTOMATICA', disparada: true, motivos: [] };
    statusDaNota = { document: { id: 'doc-1', status: 'AUTHORIZED' }, statusLabel: 'Autorizada', terminal: true, isTest: false };
    const campo = abrirPdv();
    await bipar(campo, ARROZ.barcode);
    await waitFor(() => expect(screen.getAllByText(ARROZ.name).length).toBeGreaterThan(0));
    await pagarEmDinheiro('');
    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('pendente');
    await waitFor(() => expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('autorizada'));
    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(printDocument).toHaveBeenCalledWith('DANFCE', 'doc-1', expect.anything()));
  });
});

describe('R. sem conexão com o servidor: venda guardada e comprovante NÃO FISCAL', () => {
  it('a venda vai para a fila, a tela diz OFFLINE, e Imprimir sai no navegador como comprovante não fiscal', async () => {
    redeFora = true;
    const escrito: string[] = [];
    const janela = {
      document: { open: vi.fn(), write: (html: string) => escrito.push(html), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      // A janela fecha no afterprint (F-cupom-fiscal-20#reauditoria).
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal('open', vi.fn(() => janela));
    const campo = abrirPdv();
    await bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getAllByText(FEIJAO.name).length).toBeGreaterThan(0));
    await pagarEmDinheiro('10,00');

    const dialogo = await screen.findByRole('dialog', { name: 'Venda concluída' });
    expect(within(dialogo).getByTestId('venda-concluida-fiscal').getAttribute('data-estado')).toBe('offline');
    expect(within(dialogo).getByTestId('venda-concluida-troco').textContent).toMatch(/1,10/);
    // A venda está guardada na fila deste computador, com a chave dela, para subir sozinha.
    expect(queued()).toHaveLength(1);
    expect(queued()[0]?.idempotencyKey).toBeTruthy();

    fireEvent.click(within(dialogo).getByRole('button', { name: /Imprimir/ }));
    expect(janela.print).toHaveBeenCalled();
    const html = escrito.join('');
    expect(html).toContain('COMPROVANTE NÃO FISCAL');
    expect(html).toContain('VENDA OFFLINE — PENDENTE DE SINCRONIZAÇÃO');
    expect(html).toContain('FEIJÃO CARIOCA 1kg');
    expect(html).not.toMatch(/NFC-e autorizada|DANFE/i);
    expect(printDocument).not.toHaveBeenCalled();
  });
});
