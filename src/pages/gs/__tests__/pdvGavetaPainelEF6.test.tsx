/**
 * ============================================================================
 * PDV — A GAVETA QUE O SERVIDOR RECUSOU, O F6 NO CARRINHO VAZIO E O DANFCE DO
 * CAIXA DESTE COMPUTADOR
 * ============================================================================
 *
 *   PED-pdv-09  qualquer erro do GET /cash/open virava "servidor fora de
 *               alcance" e punha na tela a gaveta da lembrança (18 h, talvez
 *               fechada em outra máquina). Como fica vermelho: troque o
 *               `if (!semServidor(err))` do `recarregarCaixa` por `if (false)`.
 *   PED-pdv-10  F6 por reflexo com o carrinho vazio sumia com o painel fiscal
 *               da venda que acabou de fechar. Como fica vermelho: volte o
 *               `limparVenda()` do `pedirCancelamento` para `clearSale()`, ou
 *               tire o `setLastSaleId(null)` do começo do carrinho em
 *               `addProduct`.
 *   PED-pdv-08  "Ver DANFCE" no painel do PDV não dizia o caixa: a bobina era a
 *               da venda, e não a deste computador. Como fica vermelho: tire o
 *               `terminalId` do `<PainelFiscalPdv>` no `PdvPage.tsx`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

function produto(id: string, nome: string, barcode: string, preco: number) {
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

const CHAVE_DA_LEMBRANCA = 'gs.pdv.ultimoCaixa:loja';

type RespostaDoCaixa = 'ok' | 'rede' | 'proxy' | { status: number; code: string; message: string };

let respostaDoCaixa: RespostaDoCaixa;
let sessaoDoCaixa: Record<string, unknown> | null;
let statusDaNota: Record<string, unknown>;
let documentosPedidos: string[];
let vendas: number;

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
    if (alvo.includes('/core/units')) return responder({ items: [] });
    if (alvo.includes('/danfce')) {
      documentosPedidos.push(alvo);
      return new Response('<html><body>DANFCE</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      vendas += 1;
      return responder(
        {
          id: `venda-${vendas}`,
          number: 100 + vendas,
          subtotal_cents: 2190,
          discount_cents: 0,
          surcharge_cents: 0,
          total_cents: 2190,
          change_cents: 0,
          nfceNoFinalizar: { modo: 'MANUAL', disparada: false, motivos: ['Emissão manual nesta loja'] },
        },
        201,
      );
    }
    const fiscal = alvo.match(/\/core\/fiscal\/sales\/([^/]+)\/status/);
    if (fiscal) return responder(statusDaNota[fiscal[1]] ?? null);
    if (alvo.includes('/core/cash/open') && metodo === 'POST') {
      // A ABERTURA pelo diálogo do F3: o servidor aceita, mesmo com a leitura
      // (GET) quebrada — é o caso da revisão de PED-pdv-09 abaixo.
      sessaoDoCaixa = { ...SESSAO, id: 'S-ABERTA-AGORA' };
      return responder(sessaoDoCaixa, 201);
    }
    if (alvo.includes('/core/cash/open')) {
      if (respostaDoCaixa === 'rede') throw new TypeError('Failed to fetch');
      if (respostaDoCaixa === 'proxy') {
        // O proxy na frente da API caída responde no lugar dela, com HTML.
        return new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (typeof respostaDoCaixa === 'object') {
        return responder({ error: { code: respostaDoCaixa.code, message: respostaDoCaixa.message } }, respostaDoCaixa.status);
      }
      return responder({
        session: sessaoDoCaixa,
        cashWithdrawalLimitCents: null,
        terminal: { id: 'cx1', code: '01', name: 'Caixa 1' },
      });
    }
    if (alvo.includes('/core/print/drawer')) {
      return responder({ byCommand: false, agentPrinters: 0, message: 'A gaveta abre pela chave.', command: '' });
    }
    if (alvo.includes('/core/payment-methods')) {
      return responder({
        methods: [{ code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true }],
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
    'teste da gaveta, do F6 e do DANFCE',
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

/** Vende o arroz no F8 e fecha a tela de venda concluída: fica o painel fiscal. */
async function venderEFecharAConcluida(campo: HTMLInputElement) {
  bipar(campo, ARROZ.barcode);
  await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${ARROZ.name}`)).toBeTruthy());
  fireEvent.keyDown(campo, { key: 'F8' });
  await screen.findByRole('dialog', { name: 'Venda concluída' });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

function guardarLembranca() {
  localStorage.setItem(
    CHAVE_DA_LEMBRANCA,
    JSON.stringify({
      session: { ...SESSAO, id: 'S-LEMBRADA' },
      terminal: { id: 'cx1', code: '01', name: 'Caixa 1' },
      confirmadoEm: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  respostaDoCaixa = 'ok';
  sessaoDoCaixa = SESSAO;
  statusDaNota = {};
  documentosPedidos = [];
  vendas = 0;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste da gaveta, do F6 e do DANFCE');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

// ============================================================================

describe('PED-pdv-09 — só a falta de servidor usa a lembrança da gaveta', () => {
  it('403 na entrada, com a lembrança guardada: a tela NÃO inventa a gaveta e diz o que o servidor disse', async () => {
    guardarLembranca();
    respostaDoCaixa = { status: 403, code: 'AUTH_FORBIDDEN', message: 'Seu perfil não consulta o caixa.' };
    abrirPdv();
    expect(
      await screen.findByText(
        'Não foi possível confirmar o caixa: o servidor recusou a consulta do caixa: Seu perfil não consulta o caixa.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Caixa fechado/ })).toBeTruthy();
    expect(screen.queryByTestId('pdv-caixa-nao-confirmado')).toBeNull();
  });

  it('500 na volta do foco, com a gaveta na tela: "não confirmado" com a frase do servidor, e não "fora de alcance"', async () => {
    abrirPdv();
    await waitFor(() => expect(localStorage.getItem(CHAVE_DA_LEMBRANCA)).not.toBeNull());
    respostaDoCaixa = { status: 500, code: 'CORE_INTERNAL', message: 'Erro interno ao ler o caixa.' };
    fireEvent.focus(window);
    const aviso = await screen.findByTestId('pdv-caixa-erro');
    expect(aviso.textContent).toContain('Erro interno ao ler o caixa.');
    expect(screen.queryByTestId('pdv-caixa-nao-confirmado')).toBeNull();
  });

  it('rede fora na entrada usa a lembrança; o servidor de volta dizendo "fechada" a substitui', async () => {
    guardarLembranca();
    respostaDoCaixa = 'rede';
    abrirPdv();
    expect(await screen.findByTestId('pdv-caixa-nao-confirmado')).toBeTruthy();

    // O turno foi fechado em outra máquina durante a queda.
    respostaDoCaixa = 'ok';
    sessaoDoCaixa = null;
    fireEvent.focus(window);
    expect(await screen.findByText(/Nenhum caixa aberto/)).toBeTruthy();
    expect(screen.queryByTestId('pdv-caixa-nao-confirmado')).toBeNull();
    expect(localStorage.getItem(CHAVE_DA_LEMBRANCA)).toBeNull();
  });

  it('o 502 do proxy na frente da API caída é servidor fora: vale a lembrança', async () => {
    guardarLembranca();
    respostaDoCaixa = 'proxy';
    abrirPdv();
    expect(await screen.findByTestId('pdv-caixa-nao-confirmado')).toBeTruthy();
    expect(screen.queryByTestId('pdv-caixa-erro')).toBeNull();
  });

  /*
    REVISÃO: o erro da leitura não sobrevive à resposta do próprio servidor.
    Como fica vermelho: tire o `setErroDoCaixa(null)` do `onChanged` do
    <CaixaPdvDialog> no `PdvPage.tsx` — o cabeçalho segue "(não confirmado — o
    servidor recusou…)" sobre a gaveta que o servidor acabou de abrir.
  */
  it('a leitura dá 500, mas o caixa aberto pelo F3 foi aceito: o cabeçalho não diz mais "não confirmado"', async () => {
    respostaDoCaixa = { status: 500, code: 'CORE_INTERNAL', message: 'Erro interno ao ler o caixa.' };
    abrirPdv();
    expect(
      await screen.findByText(
        'Não foi possível confirmar o caixa: o servidor recusou a consulta do caixa: Erro interno ao ler o caixa.',
      ),
    ).toBeTruthy();

    fireEvent.keyDown(window, { key: 'F3' });
    const dialogo = await screen.findByTestId('caixa-pdv');
    fireEvent.change(within(dialogo).getByLabelText('Fundo de troco'), { target: { value: '100,00' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /^Abrir caixa$/i }));

    await screen.findByRole('button', { name: /^Caixa aberto/ });
    expect(screen.queryByTestId('pdv-caixa-erro')).toBeNull();
    expect(screen.queryByText(/Não foi possível confirmar o caixa/)).toBeNull();
  });
});

// ============================================================================

describe('PED-pdv-10 — o F6 por reflexo não apaga o painel da venda que acabou de fechar', () => {
  it('venda fechada, carrinho vazio, F6: o painel fiscal da venda continua na tela', async () => {
    const campo = abrirPdv();
    await venderEFecharAConcluida(campo);
    await screen.findByRole('button', { name: 'imprimir comprovante' });

    fireEvent.keyDown(campo, { key: 'F6' });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('button', { name: 'imprimir comprovante' })).toBeTruthy();
    // Nada a cancelar: nem pergunta.
    expect(screen.queryByTestId('pdv-confirmar-cancelamento')).toBeNull();
  });

  it('o primeiro item do próximo cliente aposenta o painel: tirar esse item não devolve o painel de outro cliente', async () => {
    const campo = abrirPdv();
    await venderEFecharAConcluida(campo);
    await screen.findByRole('button', { name: 'imprimir comprovante' });

    bipar(campo, FEIJAO.barcode);
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: `Remover ${FEIJAO.name}` }));
    await waitFor(() => expect(screen.queryByLabelText(`Quantidade de ${FEIJAO.name}`)).toBeNull());
    expect(screen.queryByRole('button', { name: 'imprimir comprovante' })).toBeNull();
  });
});

// ============================================================================

describe('PED-pdv-08 — o DANFCE reaberto no painel do PDV sai na bobina deste caixa', () => {
  it('"Ver DANFCE" pede o documento com o caixa deste computador', async () => {
    statusDaNota['venda-1'] = {
      document: {
        id: 'doc-9',
        model: '65',
        serie: 1,
        number: 10,
        accessKey: '35260900000000000000650010000000101000000010',
        environment: 'homologation',
        status: 'AUTHORIZED',
        protocol: 'P-1',
        cStat: '100',
        xMotivo: 'Autorizado',
        saleId: 'venda-1',
        saleNumber: 101,
        customerName: null,
        recipientDocument: null,
        totalCents: 2190,
        authorizedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      statusLabel: 'NFC-e autorizada',
      terminal: true,
      isTest: false,
    };
    const aba = { close: vi.fn(), opener: {} as unknown, location: { href: '' } };
    const campo = abrirPdv();
    await venderEFecharAConcluida(campo);
    const ver = await screen.findByRole('button', { name: 'Ver DANFCE' });

    vi.spyOn(window, 'open').mockImplementation(() => aba as unknown as Window);
    const criarUrl = vi.fn(() => 'blob:danfce');
    Object.assign(URL, { createObjectURL: criarUrl, revokeObjectURL: vi.fn() });
    fireEvent.click(ver);

    await waitFor(() => expect(documentosPedidos).toHaveLength(1));
    expect(documentosPedidos[0]).toContain('/core/fiscal/documents/doc-9/danfce?terminalId=cx1');
    await waitFor(() => expect(aba.location.href).toBe('blob:danfce'));
  });
});
