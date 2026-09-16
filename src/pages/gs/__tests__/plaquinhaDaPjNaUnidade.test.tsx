/**
 * A PLAQUINHA DA PJ MOTORS NA MOTO DO ESTOQUE, PELA TELA (P0 das plaquinhas).
 *
 * A PJ gerava, imprimia e liberava o lote em Plaquinhas — e o adesivo não
 * tinha onde entrar: só o cadastro de máquina o associava, e a PJ não tem
 * bancada. O servidor ganhou colar, soltar e trocar pela unidade; esta tela é
 * onde a gestão da PJ faz isso (Estoque › Unidades). O que só a tela prova:
 *
 *   - a moto sem plaquinha oferece "Colar plaquinha do lote", a busca vai pelo
 *     número (busca=42) e o colar manda o id do adesivo escolhido;
 *   - a moto com o adesivo mostra o número e "adesivo da PJ Motors", reimprime,
 *     troca (motivo obrigatório: o botão fica apagado sem ele) e solta;
 *   - a Preço Justo não vê nada disso e não pergunta ao pool;
 *   - o caixa do PDV da PJ vê o número e nenhum botão (PDV não administra);
 *   - o modelo "Estoque" (cola e troca por `inventory.units.manage`, sem a
 *     leitura do pool) acha os adesivos livres pela leitura estreita da
 *     unidade, e a recusa dessa leitura aparece como recusa — nunca como
 *     "nenhuma plaquinha livre" (resíduo do P0).
 *
 * Mordidas: tire o `useCan('inventory.units.manage')` e o caso do PDV fica
 * vermelho; tire o `temPlaquinha` e o caso da Preço Justo fica vermelho; volte
 * o painel para `livres()` (o pool) e os casos do modelo Estoque ficam
 * vermelhos; volte o `.catch(() => setLivres([]))` e o caso da recusa fica
 * vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import UnidadesEstoquePage from '../UnidadesEstoquePage';

interface Pedido {
  metodo: string;
  url: string;
  corpo: Record<string, unknown>;
}

let pedidos: Pedido[];
let rotas: (p: Pedido) => { status?: number; body: unknown } | null;
let escrito: string;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const p: Pedido = {
        metodo: (init?.method ?? 'GET').toUpperCase(),
        url: String(url),
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      pedidos.push(p);
      const r = rotas(p);
      if (r) return r.status === 204 ? new Response(null, { status: 204 }) : json(r.body, r.status ?? 200);
      return json({ items: [] });
    }),
  );
}

const GESTAO = ['inventory.units.manage', 'inventory.units.view', 'workshop.tags.view'];

function entrarComo(profileCode: string, slug: string, capabilities: string[]) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Pessoa', profileCode },
      company: { id: 'co', slug, tradeName: 'Empresa', kind: 'retail' },
      companies: [{ id: 'co', slug, tradeName: 'Empresa', kind: 'retail', profileCode }],
      access: {
        modelo: { code: profileCode, name: profileCode, personalizado: false },
        capabilities,
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/sistema',
        carimbo: `c-${profileCode}`,
      },
    } as never,
    'LOGIN',
    'client.login',
  );
}

function unidade(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    company_id: 'co',
    product_id: 'p-moto',
    status: 'in_stock',
    serial_number: null,
    imei: null,
    chassis: `9C2KC1670NR00000${id.slice(-1)}`,
    motor_number: null,
    plate: null,
    location_id: null,
    cost_cents: null,
    entry_reference_type: 'ajuste',
    exit_reference_type: null,
    equipment_id: null,
    note: null,
    created_at: '2026-09-01T10:00:00.000Z',
    plaquinha: null,
    plaquinhaDoPool: null,
    ...extra,
  };
}

const COLADA = { tagId: 'tag-42', publicId: 42, publicIdLabel: '#0042', associatedAt: '2026-09-10T10:00:00.000Z' };

/** As rotas comuns: o resumo, a busca do produto e as unidades dele. */
function rotasDaTela(itens: unknown[], extra: (p: Pedido) => { status?: number; body: unknown } | null = () => null) {
  rotas = (p) => {
    const r = extra(p);
    if (r) return r;
    if (p.url.includes('/core/units/summary')) return { body: { semPlaquinha: 1 } };
    if (p.url.includes('/core/stock?')) {
      return {
        body: {
          items: [{ product_id: 'p-moto', internal_code: 'M', name: 'Honda CG 160', unit: 'UN', quantity: 2, reserved: 0, min_stock: 0, price_cents: 1, cost_cents: 1 }],
        },
      };
    }
    if (p.url.endsWith('/core/units/p-moto')) return { body: { items: itens } };
    return null;
  };
}

async function abrirOProduto() {
  render(
    <MemoryRouter>
      <UnidadesEstoquePage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText('Nome ou código do produto'), { target: { value: 'Hon' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Honda CG 160' }, { timeout: 2000 }));
  await screen.findAllByRole('button', { name: 'Identificar' });
}

beforeEach(() => {
  pedidos = [];
  escrito = '';
  vi.spyOn(window, 'open').mockImplementation(
    () =>
      ({
        document: { open: () => undefined, write: (h: string) => (escrito += h), close: () => undefined },
        close: () => undefined,
      }) as unknown as Window,
  );
  rotas = () => null;
  servidor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a gestão da PJ Motors cola o adesivo do lote na moto', () => {
  it('a moto sem plaquinha oferece colar; a busca vai pelo número e o colar manda o adesivo escolhido', async () => {
    entrarComo('gerente_loja', 'pj-motors', GESTAO);
    let colada = false;
    rotasDaTela([unidade('u1')], (p) => {
      if (p.url.includes('/core/units/u1/tag/livres')) {
        return { body: { items: [{ id: 'tag-42', public_id: 42, publicIdLabel: '#0042' }] } };
      }
      if (p.metodo === 'POST' && p.url.endsWith('/core/units/u1/tag')) {
        colada = true;
        return { status: 201, body: { plaquinha: COLADA } };
      }
      if (colada && p.url.endsWith('/core/units/p-moto')) return { body: { items: [unidade('u1', { plaquinhaDoPool: COLADA })] } };
      return null;
    });
    await abrirOProduto();

    fireEvent.click(screen.getByRole('button', { name: 'Colar plaquinha do lote' }));
    fireEvent.change(await screen.findByPlaceholderText('Nº do adesivo (#0042)'), { target: { value: '42' } });
    await waitFor(() =>
      expect(pedidos.some((p) => p.url.includes('/core/units/u1/tag/livres?busca=42'))).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Colar nesta moto' }));

    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/units/u1/tag'))).toBe(true));
    expect(pedidos.find((p) => p.metodo === 'POST' && p.url.endsWith('/core/units/u1/tag'))!.corpo).toEqual({ tagId: 'tag-42' });
    expect(await screen.findByText('Plaquinha #0042 colada nesta moto — o QR já abre a página dela.')).toBeTruthy();
    // A lista recarregou: a moto tem o adesivo, e o botão de colar saiu.
    expect(await screen.findByText('adesivo da PJ Motors')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Colar plaquinha do lote' })).toBeNull();
    // O painel da MÁQUINA não foi usado: nenhuma candidata da Oficina pedida.
    expect(pedidos.some((p) => p.url.includes('/equipment-candidates'))).toBe(false);
    // E o pool inteiro não foi lido: a lista é a leitura estreita da unidade.
    expect(pedidos.some((p) => p.url.includes('/core/equipment-tags'))).toBe(false);
  });

  it('adesivo ainda não liberado: a tela diz o caminho, em vez do código do servidor', async () => {
    entrarComo('gerente_loja', 'pj-motors', GESTAO);
    rotasDaTela([unidade('u1')], (p) => {
      if (p.url.includes('/core/units/u1/tag/livres')) {
        return { body: { items: [{ id: 'tag-42', public_id: 42, publicIdLabel: '#0042' }] } };
      }
      if (p.metodo === 'POST' && p.url.endsWith('/core/units/u1/tag')) {
        return { status: 409, body: { error: { code: 'CORE_TAG_NOT_RELEASED', message: 'A plaquinha #0042 ainda não foi liberada.' } } };
      }
      return null;
    });
    await abrirOProduto();
    fireEvent.click(screen.getByRole('button', { name: 'Colar plaquinha do lote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Colar nesta moto' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Imprima e libere o lote em Plaquinhas antes de colar.');
  });

  it('a moto com o adesivo mostra o número, reimprime, troca com motivo obrigatório e solta', async () => {
    entrarComo('gerente_loja', 'pj-motors', GESTAO);
    rotasDaTela([unidade('u2', { plaquinhaDoPool: COLADA })], (p) => {
      if (p.url.includes('/core/units/u2/tag/livres')) {
        return { body: { items: [{ id: 'tag-43', public_id: 43, publicIdLabel: '#0043' }] } };
      }
      if (p.metodo === 'POST' && p.url.endsWith('/core/units/u2/equipment/sheet')) {
        return { body: { html: '<html>#0042</html>', publicIdLabel: '#0042', plaquinhas: 1 } };
      }
      if (p.metodo === 'POST' && p.url.endsWith('/core/units/u2/tag/replace')) {
        return { body: { anterior: '#0042', atual: '#0043' } };
      }
      if (p.metodo === 'DELETE' && p.url.endsWith('/core/units/u2/tag')) return { status: 204, body: null };
      return null;
    });
    await abrirOProduto();

    const celula = screen.getByText('adesivo da PJ Motors').closest('td') as HTMLElement;
    expect(within(celula).getByText('#0042')).toBeTruthy();
    // Com adesivo, a moto não oferece vincular máquina nem colar outro.
    expect(screen.queryByRole('button', { name: 'Vincular plaquinha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Colar plaquinha do lote' })).toBeNull();

    fireEvent.click(within(celula).getByRole('button', { name: 'Reimprimir plaquinha' }));
    await waitFor(() => expect(escrito).toContain('#0042'));

    fireEvent.click(within(celula).getByRole('button', { name: 'Trocar adesivo' }));
    const escolha = await screen.findByLabelText('Adesivo novo');
    await screen.findByRole('option', { name: '#0043' });
    const trocar = screen.getByRole('button', { name: 'Trocar o adesivo' }) as HTMLButtonElement;
    expect(trocar.disabled).toBe(true);
    fireEvent.change(escolha, { target: { value: 'tag-43' } });
    // Sem motivo o botão continua apagado: a troca muda o número da moto.
    expect(trocar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo da troca'), { target: { value: 'descascou no sol' } });
    expect(trocar.disabled).toBe(false);
    fireEvent.click(trocar);
    await waitFor(() =>
      expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/units/u2/tag/replace'))).toBe(true),
    );
    expect(pedidos.find((p) => p.url.endsWith('/core/units/u2/tag/replace'))!.corpo).toEqual({
      novaTagId: 'tag-43',
      motivo: 'descascou no sol',
    });
    expect(await screen.findByText('Plaquinha #0042 trocada por #0043 — o adesivo antigo deixou de valer.')).toBeTruthy();

    fireEvent.click(within(screen.getByText('adesivo da PJ Motors').closest('td') as HTMLElement).getByRole('button', { name: 'Soltar plaquinha' }));
    const pergunta = await screen.findByTestId('confirmar');
    expect(within(pergunta).getByText(/volta a ficar livre no pool da PJ Motors/)).toBeTruthy();
    fireEvent.click(within(pergunta).getByRole('button', { name: 'Soltar plaquinha' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'DELETE' && p.url.endsWith('/core/units/u2/tag'))).toBe(true));
  });
});

/*
  O MODELO "ESTOQUE" SEM BECO (resíduo do P0 das plaquinhas).

  O modelo Estoque tem `inventory.units.manage` — o servidor aceita dele colar e
  trocar o adesivo — e não tem `workshop.tags.view`, a leitura do pool. O painel
  listava os livres pelo pool: 403, a tela engolia a recusa e dizia "Nenhuma
  plaquinha livre com esse número" com o pool cheio. Agora a lista é a leitura
  estreita da unidade (mesma capability de colar), e a recusa aparece.
*/
const MODELO_ESTOQUE = ['inventory.adjust.approve', 'inventory.manage', 'inventory.units.manage', 'inventory.units.view', 'inventory.view'];

describe('o modelo Estoque cola o adesivo sem cair num beco', () => {
  it('sem a leitura do pool, acha o adesivo livre pela unidade e cola', async () => {
    entrarComo('estoque', 'pj-motors', MODELO_ESTOQUE);
    rotasDaTela([unidade('u1')], (p) => {
      // O pool recusaria este modelo, como o servidor de verdade recusa.
      if (p.url.includes('/core/equipment-tags')) {
        return { status: 403, body: { error: { code: 'API_PERMISSION_DENIED', message: 'Seu acesso nesta empresa não inclui: Plaquinhas (ver).' } } };
      }
      if (p.url.includes('/core/units/u1/tag/livres')) {
        return { body: { items: [{ id: 'tag-42', public_id: 42, publicIdLabel: '#0042' }] } };
      }
      if (p.metodo === 'POST' && p.url.endsWith('/core/units/u1/tag')) return { status: 201, body: { plaquinha: COLADA } };
      return null;
    });
    await abrirOProduto();

    fireEvent.click(screen.getByRole('button', { name: 'Colar plaquinha do lote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Colar nesta moto' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/units/u1/tag'))).toBe(true));
    expect(await screen.findByText('Plaquinha #0042 colada nesta moto — o QR já abre a página dela.')).toBeTruthy();
    expect(pedidos.some((p) => p.url.includes('/core/equipment-tags'))).toBe(false);
  });

  it('a recusa da lista aparece como recusa — e não como "nenhuma plaquinha livre"', async () => {
    entrarComo('estoque', 'pj-motors', MODELO_ESTOQUE);
    rotasDaTela([unidade('u1')], (p) => {
      if (p.url.includes('/core/units/u1/tag/livres')) {
        return { status: 403, body: { error: { code: 'CORE_COMPANY_NO_TAGS', message: 'Plaquinha com QR e número é exclusiva da PJ Motors.' } } };
      }
      return null;
    });
    await abrirOProduto();

    fireEvent.click(screen.getByRole('button', { name: 'Colar plaquinha do lote' }));
    const recusa = await screen.findByRole('alert');
    expect(recusa.textContent).toContain('Não foi possível ler as plaquinhas livres');
    expect(recusa.textContent).toContain('exclusiva da PJ Motors');
    // O que a tela dizia antes, com a recusa engolida: um pool vazio que não existe.
    expect(screen.queryByText(/Nenhuma plaquinha livre/)).toBeNull();
    expect(screen.queryByText('Carregando…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Colar nesta moto' })).toBeNull();
  });
});

describe('quem não administra plaquinha da PJ não recebe nada disso', () => {
  it('a Preço Justo não vê colar, número nem troca — e não pergunta ao pool', async () => {
    entrarComo('gerente_loja', 'preco-justo', GESTAO);
    // Até com o bloco que um servidor errado mandaria.
    rotasDaTela([unidade('u1'), unidade('u2', { plaquinhaDoPool: COLADA })]);
    await abrirOProduto();
    expect(screen.queryByRole('button', { name: 'Colar plaquinha do lote' })).toBeNull();
    expect(screen.queryByText('#0042')).toBeNull();
    expect(screen.queryByText('adesivo da PJ Motors')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trocar adesivo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Soltar plaquinha' })).toBeNull();
    expect(pedidos.some((p) => p.url.includes('/equipment-tags'))).toBe(false);
  });

  it('o caixa do PDV da PJ vê o número e nenhum botão (PDV não administra)', async () => {
    entrarComo('operador_caixa_loja', 'pj-motors', ['pdv.sell']);
    rotasDaTela([unidade('u1'), unidade('u2', { plaquinhaDoPool: COLADA })]);
    await abrirOProduto();
    expect(screen.getByText('#0042')).toBeTruthy();
    expect(screen.getByText('adesivo da PJ Motors')).toBeTruthy();
    for (const nome of ['Colar plaquinha do lote', 'Reimprimir plaquinha', 'Trocar adesivo', 'Soltar plaquinha']) {
      expect(screen.queryByRole('button', { name: nome }), nome).toBeNull();
    }
    expect(pedidos.some((p) => p.url.includes('/equipment-tags'))).toBe(false);
  });
});
