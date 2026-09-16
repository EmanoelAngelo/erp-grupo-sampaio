/**
 * ============================================================================
 * O CUPOM E A GAVETA PELO AGENTE LOCAL, NA TELA (GAP-PRD-082)
 * ============================================================================
 *
 * O servidor passou a decidir o transporte e o agente local passou a imprimir;
 * a tela precisava parar de abrir o diálogo do navegador quando quem imprime é
 * o agente, e dizer a verdade sobre cada impressora. Os casos cobram:
 *
 *   - Configurações › Impressoras: o caixa, o endereço e o agente de cada
 *     impressora de agente; o que falta quando falta; a página de teste
 *     pedida pela gerência e acompanhada até o agente confirmar; e o cadastro
 *     que leva o caixa e o endereço (sem endereço, não salva);
 *   - `printDocument`: job do agente não abre janela e espera o `printed`; a
 *     falha do agente vira erro com o motivo dele;
 *   - "Abrir gaveta" só existe com o agente do caixa no ar, e leva o motivo;
 *   - o PDV: com a térmica de agente deste caixa no ar, o Finalizar manda o
 *     cupom ao agente com o pulso da gaveta (venda em dinheiro); sem ela, nada
 *     sai sozinho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ImpressorasPage from '../ImpressorasPage';
import PdvPage from '../PdvPage';
import { AbrirGavetaPorComando } from '@/components/gs/AbrirGavetaPorComando';
import { setSession } from '@/lib/api/client';
import { printDocument } from '@/lib/print';

type Pedido = { url: string; metodo: string; corpo: Record<string, unknown> | null };
let pedidos: Pedido[];
let rotas: Record<string, (p: Pedido) => Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const pedido: Pedido = {
        url: String(url),
        metodo: (init?.method ?? 'GET').toUpperCase(),
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      pedidos.push(pedido);
      const caminho = new URL(pedido.url, 'http://x').pathname.replace(/^\/api\/v1/, '');
      const chave = `${pedido.metodo} ${caminho}`;
      const rota = rotas[chave] ?? Object.entries(rotas).find(([k]) => k.endsWith('*') && chave.startsWith(k.slice(0, -1)))?.[1];
      return rota ? rota(pedido) : json({ items: [] });
    }),
  );
}

/**
 * O acesso que o perfil realmente tem no produto — a tela de Impressoras pergunta
 * pela CAPABILITY `settings.printers.manage`, que é a mesma que as rotas cobram
 * (P00 das etiquetas). Uma lista vazia descreveria um gerente que não existe.
 */
const ACESSO_DE_HOJE: Record<string, string[]> = {
  gerente_loja: ['settings.printers.view', 'settings.printers.manage', 'pdv.sell'],
  operador_caixa_loja: ['settings.printers.view', 'pdv.sell'],
};

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: {
        capabilities: ACESSO_DE_HOJE[profileCode] ?? [],
        modelo: { personalizado: false },
        casa: '/sistema',
      },
    } as never,
    'LOGIN',
    'teste do agente de impressão',
  );
}

const RAPIDO = { intervaloMs: 5, prazoMs: 2000 };

const TERMICA = {
  id: 'imp-1',
  name: 'Térmica do Caixa 1',
  kind: 'cupom',
  transport: 'agent',
  paper_width_mm: 80,
  is_default: 1,
  active: 1,
  pdv_terminal_id: 'cx1',
  agent_device: 'tcp:192.168.0.50:9100',
};

function situacao(extra: Record<string, unknown> = {}) {
  return {
    printerId: 'imp-1',
    name: 'Térmica do Caixa 1',
    kind: 'cupom',
    transport: 'agent',
    active: true,
    pdvTerminalId: 'cx1',
    pdvTerminalName: 'Caixa 1',
    agentDevice: 'tcp:192.168.0.50:9100',
    agent: { agentId: 'ag-1', online: true, lastSeenAt: new Date().toISOString() },
    lastTest: null,
    ready: true,
    problem: null,
    ...extra,
  };
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  rotas = {};
  servidor();
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste do agente de impressão');
  localStorage.clear();
});

function montarImpressoras() {
  render(
    <MemoryRouter>
      <ImpressorasPage acompanhamento={RAPIDO} />
    </MemoryRouter>,
  );
}

describe('Configurações › Impressoras mostra o agente de cada impressora', () => {
  it('caixa, endereço, agente no ar — e a página de teste acompanhada até o agente confirmar', async () => {
    let leituras = 0;
    let testada = false;
    rotas = {
      'GET /core/print/printers': () => json({ items: [TERMICA] }),
      'GET /core/print/readiness': () =>
        json({
          configured: true,
          readiness: testada ? 'AGENT_READY' : 'READY_FOR_HARDWARE',
          message: testada ? 'Impressão direta pelo agente local.' : 'Imprima a página de teste.',
          printers: [situacao(testada ? { lastTest: { jobId: 'job-t', status: 'printed', at: new Date().toISOString(), error: null } } : {})],
        }),
      'GET /core/terminals': () => json({ items: [{ id: 'cx1', name: 'Caixa 1' }] }),
      'POST /core/print/printers/imp-1/test': () => json({ id: 'job-t', transport: 'agent', status: 'ready' }, 201),
      'GET /core/print/jobs/job-t': () => {
        leituras += 1;
        if (leituras >= 2) testada = true;
        return json({ id: 'job-t', transport: 'agent', status: leituras >= 2 ? 'printed' : 'printing' });
      },
    };
    montarImpressoras();

    const linha = await screen.findByTestId('situacao-imp-1');
    expect(linha.textContent).toMatch(/Caixa: Caixa 1/);
    expect(linha.textContent).toMatch(/tcp:192\.168\.0\.50:9100/);
    expect(linha.textContent).toMatch(/Agente local no ar/);
    expect(linha.textContent).toMatch(/Ainda sem página de teste/);

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir teste' }));
    await screen.findByText(/Página de teste impressa em "Térmica do Caixa 1"/);
    expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/print/printers/imp-1/test'))).toBe(true);
    await screen.findByText('AGENT_READY');
  });

  it('o que falta aparece pelo nome, e o teste recusado diz por quê', async () => {
    rotas = {
      'GET /core/print/printers': () => json({ items: [TERMICA] }),
      'GET /core/print/readiness': () =>
        json({
          configured: true,
          readiness: 'READY_FOR_HARDWARE',
          message: 'O agente local do caixa "Caixa 1" está fora do ar.',
          printers: [situacao({ ready: false, problem: 'O agente local do caixa "Caixa 1" está fora do ar.' })],
        }),
      'POST /core/print/printers/imp-1/test': () =>
        json({ error: { code: 'CORE_PRINT_AGENT_UNAVAILABLE', message: 'O agente local do caixa "Caixa 1" está fora do ar.' } }, 409),
    };
    montarImpressoras();
    const linha = await screen.findByTestId('situacao-imp-1');
    expect(within(linha).getByText(/está fora do ar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir teste' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/fora do ar/);
  });

  it('o operador de caixa não vê o botão de teste', async () => {
    entrarComo('operador_caixa_loja');
    rotas = {
      'GET /core/print/printers': () => json({ items: [TERMICA] }),
      'GET /core/print/readiness': () => json({ configured: true, readiness: 'READY_FOR_HARDWARE', message: 'x', printers: [situacao()] }),
    };
    montarImpressoras();
    await screen.findByTestId('situacao-imp-1');
    expect(screen.queryByRole('button', { name: 'Imprimir teste' })).toBeNull();
  });

  it('o cadastro de agente leva o caixa e o endereço — sem endereço, não salva', async () => {
    rotas = {
      'GET /core/print/printers': () => json({ items: [] }),
      'GET /core/print/readiness': () => json({ configured: false, readiness: 'READY_FOR_HARDWARE', message: 'Nenhuma.', printers: [] }),
      'GET /core/terminals': () => json({ items: [{ id: 'cx1', name: 'Caixa 1' }, { id: 'cx2', name: 'Caixa 2' }] }),
      'POST /core/print/printers': (p) => json({ id: 'nova', ...p.corpo }, 201),
    };
    montarImpressoras();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    const dialogo = screen.getByRole('dialog', { name: 'Nova impressora' });
    fireEvent.change(within(dialogo).getByPlaceholderText('Ex.: Cupom do balcão'), { target: { value: 'Térmica 2' } });
    fireEvent.change(within(dialogo).getByLabelText('Como imprime'), { target: { value: 'agent' } });
    const salvar = within(dialogo).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);
    await waitFor(() => expect(within(dialogo).getByRole('option', { name: 'Caixa 2' })).toBeTruthy());
    fireEvent.change(within(dialogo).getByLabelText('Caixa da impressora'), { target: { value: 'cx2' } });
    fireEvent.change(within(dialogo).getByLabelText('Endereço da impressora'), { target: { value: 'COM3' } });
    expect(salvar.disabled).toBe(false);
    fireEvent.click(salvar);
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/print/printers'))).toBe(true));
    const corpo = pedidos.find((p) => p.metodo === 'POST' && p.url.endsWith('/core/print/printers'))!.corpo;
    expect(corpo).toMatchObject({ name: 'Térmica 2', transport: 'agent', pdvTerminalId: 'cx2', agentDevice: 'COM3' });
  });
});

describe('printDocument com o agente', () => {
  it('job do agente não abre janela e espera o impresso', async () => {
    const abrir = vi.spyOn(window, 'open');
    let leituras = 0;
    rotas = {
      'POST /core/print/jobs': (p) => json({ id: 'job-c', transport: 'agent', status: 'ready', ...p.corpo }, 201),
      'GET /core/print/jobs/job-c': () => {
        leituras += 1;
        return json({ id: 'job-c', transport: 'agent', status: leituras > 1 ? 'printed' : 'printing' });
      },
    };
    const r = await printDocument('SALE_RECEIPT', 'venda-1', { terminalId: 'cx1', openDrawer: true, acompanhamento: RAPIDO });
    expect(r).toMatchObject({ via: 'agente', status: 'printed' });
    expect(abrir).not.toHaveBeenCalled();
    expect(pedidos.find((p) => p.metodo === 'POST')!.corpo).toMatchObject({
      documentType: 'SALE_RECEIPT',
      documentId: 'venda-1',
      terminalId: 'cx1',
      openDrawer: true,
    });
  });

  it('a falha do agente vira erro com o motivo dele', async () => {
    rotas = {
      'POST /core/print/jobs': () => json({ id: 'job-f', transport: 'agent', status: 'ready' }, 201),
      'GET /core/print/jobs/job-f': () =>
        json({ id: 'job-f', transport: 'agent', status: 'failed', error: 'Falha ao imprimir em "Térmica" (COM3): sem papel' }),
    };
    await expect(printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO })).rejects.toThrow(/sem papel/);
  });
});

describe('Abrir gaveta por comando', () => {
  it('sem o agente no ar, não há botão', async () => {
    rotas = { 'GET /core/print/drawer': () => json({ byCommand: false, message: 'Nenhuma térmica de agente.' }) };
    render(<AbrirGavetaPorComando terminalId="cx1" acompanhamento={RAPIDO} />);
    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/core/print/drawer'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Abrir gaveta' })).toBeNull();
  });

  it('com o agente no ar, abre com o motivo e diz quando abriu', async () => {
    rotas = {
      'GET /core/print/drawer': () => json({ byCommand: true, message: 'ok' }),
      'POST /core/print/drawer/open': (p) => json({ id: 'job-g', transport: 'agent', status: 'ready', reason: p.corpo?.reason }, 201),
      'GET /core/print/jobs/job-g': () => json({ id: 'job-g', transport: 'agent', status: 'printed' }),
    };
    render(<AbrirGavetaPorComando terminalId="cx1" acompanhamento={RAPIDO} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir gaveta' }));
    const abrir = screen.getByRole('button', { name: 'Abrir agora' }) as HTMLButtonElement;
    expect(abrir.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo para abrir a gaveta'), { target: { value: 'troco para o caixa 2' } });
    fireEvent.click(abrir);
    await screen.findByText(/Gaveta aberta/);
    expect(pedidos.find((p) => p.url.includes('/drawer/open'))!.corpo).toEqual({ reason: 'troco para o caixa 2', terminalId: 'cx1' });
    expect(pedidos.find((p) => p.url.includes('/core/print/drawer?'))?.url).toContain('terminalId=cx1');
  });
});

describe('o PDV manda o cupom ao agente no Finalizar', () => {
  const PRODUTO = {
    id: 'p-1',
    internal_code: 'PJ-0001',
    sku: null,
    barcode: '7890000001111',
    name: 'Fone de ouvido',
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 1000,
    price_cents: 2500,
    effective_price_cents: 2500,
    on_sale: false,
    min_stock: 0,
    stock_quantity: 10,
    active: 1,
    kind: 'retail',
    workshop_name: null,
    open_price: 0,
  };

  function pdv(gavetaPorComando: boolean) {
    entrarComo('operador_caixa_loja');
    localStorage.setItem('gs.pdv.terminal.c1', 'cx2');
    rotas = {
      'GET /core/cash/open': () =>
        json({
          session: { id: 'sessao-cx2', terminal_id: 'cx2', opening_cents: 5000, status: 'open', opened_at: new Date().toISOString() },
          cashWithdrawalLimitCents: null,
          terminal: { id: 'cx2', code: 'pj-cx2', name: 'Caixa 2' },
          terminalDoDispositivo: false,
          terminalRecusado: null,
          terminaisAtivos: 2,
          exigeTerminal: false,
          deOutroDia: null,
        }),
      'GET /core/print/drawer': (p) =>
        json({
          byCommand: gavetaPorComando && p.url.includes('terminalId=cx2'),
          agentPrinters: 1,
          message: gavetaPorComando ? 'Cupom direto na térmica.' : 'Nenhuma térmica de agente.',
          command: '',
        }),
      'GET /core/products/search': () => json({ items: [PRODUTO] }),
      'GET /core/fiscal/pdv-summary': () => json({ situacao: 'READY', pendencyCount: 0, motivos: [] }),
      'POST /core/sales': () => json({ id: 's-1', number: 1, total_cents: 2500, change_cents: 0 }, 201),
      'POST /core/print/jobs': (p) => json({ id: 'job-pdv', transport: 'agent', status: 'ready', ...p.corpo }, 201),
      'GET /core/print/jobs/job-pdv': () => json({ id: 'job-pdv', transport: 'agent', status: 'printed' }),
    };
    render(
      <MemoryRouter>
        <PdvPage />
      </MemoryRouter>,
    );
  }

  async function venderEmDinheiro() {
    const busca = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
    await waitFor(() => expect(screen.getByText(/Caixa aberto · Caixa 2/)).toBeTruthy());
    fireEvent.change(busca, { target: { value: '7890000001111' } });
    fireEvent.keyDown(busca, { key: 'Enter' });
    await screen.findByText('Fone de ouvido');
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/sales'))).toBe(true));
  }

  /*
    O CUPOM NÃO SAI MAIS SOZINHO (preparação da Preço Justo): o operador decide
    na tela de venda concluída. A GAVETA continua abrindo no Finalizar quando
    entrou dinheiro — e o Imprimir, com a térmica de agente deste caixa no ar,
    manda o cupom ao agente, sem janela do navegador.
  */
  it('com a térmica de agente deste caixa no ar: a gaveta abre no Finalizar; o cupom vai ao agente quando o operador escolhe Imprimir', async () => {
    const abrir = vi.spyOn(window, 'open');
    pdv(true);
    rotas['POST /core/print/drawer/open'] = (p) => json({ id: 'job-gaveta', transport: 'agent', status: 'ready', ...p.corpo }, 201);
    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/core/print/drawer?terminalId=cx2'))).toBe(true));
    await venderEmDinheiro();
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/print/drawer/open'))).toBe(true));
    expect(pedidos.find((p) => p.url.includes('/drawer/open'))!.corpo).toMatchObject({ terminalId: 'cx2' });
    // Nenhum papel ainda: imprimir é escolha do operador.
    expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/print/jobs'))).toBe(false);

    const concluida = await screen.findByRole('dialog', { name: 'Venda concluída' });
    fireEvent.click(within(concluida).getByRole('button', { name: /Imprimir/ }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/print/jobs'))).toBe(true));
    const cupom = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/print/jobs'))!.corpo;
    expect(cupom).toMatchObject({ documentType: 'SALE_RECEIPT', documentId: 's-1', terminalId: 'cx2' });
    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/core/print/jobs/job-pdv'))).toBe(true));
    expect(abrir).not.toHaveBeenCalled();
    expect(screen.getByText(/Venda #1 finalizada/)).toBeTruthy();
  });

  it('sem a térmica de agente, nada sai sozinho: o cupom continua no botão Imprimir', async () => {
    pdv(false);
    await venderEmDinheiro();
    await screen.findByText(/Venda #1 finalizada/);
    expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/print/jobs'))).toBe(false);
  });
});
