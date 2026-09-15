/**
 * A PLAQUINHA PELA TELA — trocar na ficha, reimprimir pela unidade e ligar a
 * operação (GAP-PRD-107, GAP-PRD-190, GAP-PRD-185).
 *
 * O que cada bloco derruba:
 *   - tire o "Trocar plaquinha" da ficha e o adesivo descascado volta a ser
 *     beco (a tela de plaquinhas recusa danificar a que está colada);
 *   - tire o "Reimprimir plaquinha" da unidade e a PJ volta a depender da
 *     Oficina para um adesivo descolado no pátio;
 *   - tire a coluna "Plaquinha com QR" e o campo da criação e a sétima oficina
 *     volta a precisar de UPDATE à mão.
 *
 * ## O que mudou no P0 das plaquinhas
 *
 * Plaquinha é EXCLUSIVA da PJ Motors. A ficha da máquina fora dela (a Oficina)
 * não tem mais cartão de plaquinha — só o número, para leitura; a tela de
 * Unidades só mostra plaquinha na sessão da PJ; e a tela de Empresas só tem o
 * botão na linha da PJ, e a criação não oferece mais a caixa. Os blocos abaixo
 * cobravam o contrário e foram reescritos dizendo o porquê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EquipamentoFichaPage from '../EquipamentoFichaPage';
import UnidadesEstoquePage from '../UnidadesEstoquePage';
import EmpresasPage from '../EmpresasPage';

interface Pedido {
  metodo: string;
  url: string;
  corpo: Record<string, unknown>;
}

let pedidos: Pedido[];
let rotas: (p: Pedido) => { status?: number; body: unknown } | null;
let janela: { document: { open: () => void; write: (h: string) => void; close: () => void } };
let escrito: string;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
      if (r) return json(r.body, r.status ?? 200);
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string, kind = 'workshop', slug = 'co') {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Pessoa', profileCode },
      company: { id: 'co', slug, tradeName: 'Empresa', kind },
      companies: [{ id: 'co', slug, tradeName: 'Empresa', kind, profileCode }],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  escrito = '';
  janela = {
    document: {
      open: () => undefined,
      write: (h: string) => {
        escrito += h;
      },
      close: () => undefined,
    },
  };
  vi.spyOn(window, 'open').mockImplementation(() => janela as unknown as Window);
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

// ---------------------------------------------------------------- GAP-PRD-107

function ficha(plaquinha: { empresaUsa: boolean; bancadaUsa: boolean }, rotulo = '#0007') {
  return {
    equipment: { id: 'eq-1', brand: 'Shineray', model: 'PT2', public_id: 7, workshop_id: 'wk' },
    warranty: { months: null, baseKind: null, baseDate: null, expiresAt: null, status: 'sem_garantia', daysLeft: null },
    assemblyMechanicName: null,
    ownerName: null,
    workshopName: 'Mobilidade',
    publicIdLabel: rotulo,
    plaquinha,
    events: [],
    orders: [],
  };
}

function montarFicha() {
  render(
    <MemoryRouter initialEntries={['/sistema/equipamentos/eq-1']}>
      <Routes>
        <Route path="/sistema/equipamentos/:id" element={<EquipamentoFichaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GAP-PRD-107 — trocar a plaquinha pela ficha da máquina', () => {
  it('o mecânico troca: escolhe a plaquinha livre, diz o motivo, e a ficha passa a mostrar o número novo', async () => {
    entrarComo('mecanico');
    let rotuloAtual = '#0007';
    rotas = (p) => {
      if (p.url.endsWith('/core/equipment/eq-1')) return { body: ficha({ empresaUsa: true, bancadaUsa: true }, rotuloAtual) };
      if (p.url.includes('/core/equipment-tags?status=disponivel')) {
        return {
          body: {
            items: [
              { id: 'tag-30', public_id: 30, publicIdLabel: '#0030' },
              { id: 'tag-31', public_id: 31, publicIdLabel: '#0031' },
            ],
            usaPlaquinha: true,
          },
        };
      }
      if (p.metodo === 'POST' && p.url.includes('/replace')) {
        rotuloAtual = '#0030';
        return { body: { anterior: '#0007', atual: '#0030' } };
      }
      return null;
    };
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Trocar plaquinha' }));

    fireEvent.change(await screen.findByLabelText(/Plaquinha nova/), { target: { value: 'tag-30' } });
    fireEvent.change(screen.getByLabelText(/Motivo da troca/), { target: { value: 'Adesivo descascou no sol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar a plaquinha' }));

    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/replace'))).toBe(true));
    const troca = pedidos.find((p) => p.url.includes('/replace'))!;
    expect(troca.url).toContain('/core/equipment-tags/tag-30/replace');
    expect(troca.corpo).toEqual({ equipmentId: 'eq-1', motivo: 'Adesivo descascou no sol' });
    expect(await screen.findByText(/A máquina agora é #0030/)).toBeTruthy();
    // A ficha recarregou com o número novo.
    await waitFor(() => expect(screen.getAllByText('#0030').length).toBeGreaterThan(0));
  });

  it('sem plaquinha livre no pool, a tela diz onde gerar em vez de oferecer um seletor vazio', async () => {
    entrarComo('gerente_oficina');
    rotas = (p) => {
      if (p.url.endsWith('/core/equipment/eq-1')) return { body: ficha({ empresaUsa: true, bancadaUsa: true }) };
      if (p.url.includes('/core/equipment-tags?status=disponivel')) return { body: { items: [], usaPlaquinha: true } };
      return null;
    };
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Trocar plaquinha' }));
    const link = await screen.findByRole('link', { name: /Gere e libere um lote em Plaquinhas/ });
    expect(link.getAttribute('href')).toBe('/sistema/equipamentos/plaquinhas');
    expect(screen.queryByRole('button', { name: 'Trocar a plaquinha' })).toBeNull();
  });

  it('reimprimir abre a folha da MESMA plaquinha', async () => {
    entrarComo('mecanico');
    rotas = (p) => {
      if (p.url.endsWith('/core/equipment/eq-1')) return { body: ficha({ empresaUsa: true, bancadaUsa: true }) };
      if (p.metodo === 'POST' && p.url.includes('/core/labels/equipment/sheet')) {
        return { body: { html: '<html>#0007</html>', plaquinhas: 1 } };
      }
      return null;
    };
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Reimprimir plaquinha' }));
    await waitFor(() => expect(escrito).toContain('#0007'));
    const pedido = pedidos.find((p) => p.url.includes('/core/labels/equipment/sheet'))!;
    expect(pedido.corpo).toEqual({ equipmentIds: ['eq-1'] });
  });

  it('empresa fora do pool (a Oficina): sem cartão, o número só leitura; bancada de celular: sem cartão', async () => {
    /*
      P0 DAS PLAQUINHAS. Antes, a empresa fora do pool ainda via "Reimprimir
      plaquinha" e uma frase mandando ligar a plaquinha em Empresas — as duas
      coisas o servidor agora recusa (403). A ficha fica com o número da
      máquina no topo, rotulado "Número", e nenhum gesto de plaquinha; nenhum
      pedido de plaquinha ou de etiqueta sai da tela.
    */
    entrarComo('gerente_oficina');
    let flags = { empresaUsa: false, bancadaUsa: true };
    rotas = (p) => (p.url.endsWith('/core/equipment/eq-1') ? { body: ficha(flags) } : null);
    montarFicha();
    await screen.findByText('Identificação');
    expect(screen.queryByRole('button', { name: 'Reimprimir plaquinha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trocar plaquinha' })).toBeNull();
    expect(screen.queryByText(/não usa o pool de plaquinhas/)).toBeNull();
    expect(screen.getByText('Número')).toBeTruthy();
    expect(screen.getAllByText('#0007').length).toBeGreaterThan(0);
    expect(pedidos.some((p) => p.url.includes('/equipment-tags') || p.url.includes('/labels/equipment'))).toBe(false);
    cleanup();

    flags = { empresaUsa: true, bancadaUsa: false };
    montarFicha();
    await screen.findByText('Identificação');
    expect(screen.queryByRole('button', { name: 'Reimprimir plaquinha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trocar plaquinha' })).toBeNull();
  });

  it('o caixa da oficina não recebe o botão de troca (a rota é de mecânico e gerente)', async () => {
    entrarComo('operador_caixa_oficina');
    rotas = (p) => (p.url.endsWith('/core/equipment/eq-1') ? { body: ficha({ empresaUsa: true, bancadaUsa: true }) } : null);
    montarFicha();
    await screen.findByText('Identificação');
    expect(screen.queryByRole('button', { name: 'Trocar plaquinha' })).toBeNull();
  });
});

// ---------------------------------------------------------------- GAP-PRD-190

describe('GAP-PRD-190 — a PJ reimprime a plaquinha pela unidade', () => {
  function unidade(extra: Record<string, unknown> = {}) {
    return {
      id: 'un-1',
      company_id: 'co',
      product_id: 'p-moto',
      status: 'in_stock',
      serial_number: null,
      imei: null,
      chassis: '9C2XXXX',
      motor_number: 'M1',
      plate: null,
      location_id: null,
      cost_cents: null,
      entry_reference_type: 'ajuste',
      exit_reference_type: null,
      equipment_id: 'eq-9',
      note: null,
      created_at: '2026-09-01T10:00:00.000Z',
      plaquinha: {
        id: 'eq-9',
        publicId: 9,
        publicIdLabel: '#0009',
        brand: 'Shineray',
        model: 'Jet',
        saleStatus: 'NOT_SOLD',
        status: 'ativo',
        workshopName: 'Mobilidade',
        workshopCompanyName: 'Oficina',
        ordensAbertas: 0,
      },
      ...extra,
    };
  }

  it('o gerente da loja escolhe o produto, vê a plaquinha da unidade e reimprime pela unidade', async () => {
    // A sessão é a da PJ Motors (P0 das plaquinhas): só nela a tela de Unidades
    // mostra plaquinha.
    entrarComo('gerente_loja', 'retail', 'pj-motors');
    rotas = (p) => {
      if (p.url.includes('/core/units/summary')) return { body: { semPlaquinha: 0 } };
      if (p.url.includes('/core/stock?')) {
        return { body: { items: [{ product_id: 'p-moto', internal_code: 'M', name: 'Shineray Jet 50', unit: 'UN', quantity: 1, reserved: 0, min_stock: 0, price_cents: 1, cost_cents: 1 }] } };
      }
      if (p.url.endsWith('/core/units/p-moto')) return { body: { items: [unidade()] } };
      if (p.metodo === 'POST' && p.url.endsWith('/core/units/un-1/equipment/sheet')) {
        return { body: { html: '<html>#0009</html>', publicIdLabel: '#0009', plaquinhas: 1 } };
      }
      return null;
    };
    render(
      <MemoryRouter>
        <UnidadesEstoquePage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('Nome ou código do produto'), { target: { value: 'Shin' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Shineray Jet 50' }, { timeout: 2000 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reimprimir plaquinha' }));

    await waitFor(() => expect(escrito).toContain('#0009'));
    expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/units/un-1/equipment/sheet'))).toBe(true);
    expect(await screen.findByText(/mesmo número e mesmo QR/)).toBeTruthy();
  });

  it('o caixa da loja não recebe o botão (a rota é de gerente e estoquista)', async () => {
    entrarComo('operador_caixa_loja', 'retail', 'pj-motors');
    rotas = (p) => {
      if (p.url.includes('/core/units/summary')) return { body: { semPlaquinha: 0 } };
      if (p.url.includes('/core/stock?')) {
        return { body: { items: [{ product_id: 'p-moto', internal_code: 'M', name: 'Shineray Jet 50', unit: 'UN', quantity: 1, reserved: 0, min_stock: 0, price_cents: 1, cost_cents: 1 }] } };
      }
      if (p.url.endsWith('/core/units/p-moto')) return { body: { items: [unidade()] } };
      return null;
    };
    render(
      <MemoryRouter>
        <UnidadesEstoquePage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('Nome ou código do produto'), { target: { value: 'Shin' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Shineray Jet 50' }, { timeout: 2000 }));
    await screen.findByText('#0009');
    expect(screen.queryByRole('button', { name: 'Reimprimir plaquinha' })).toBeNull();
  });

  /*
    A LOJA FORA DA PJ MOTORS (P0 das plaquinhas): a mesma tela, com a mesma
    unidade — até com o bloco da plaquinha que um servidor antigo mandaria —,
    não mostra coluna, número, reimpressão nem vínculo. É a tela de identidade
    da unidade, e nada mais.
  */
  it('a Preço Justo não vê plaquinha na unidade: sem coluna, sem reimprimir, sem vincular', async () => {
    entrarComo('gerente_loja', 'retail', 'preco-justo');
    rotas = (p) => {
      if (p.url.includes('/core/units/summary')) return { body: { semPlaquinha: 3, vendidasSemPlaquinha: 2 } };
      if (p.url.includes('/core/stock?')) {
        return { body: { items: [{ product_id: 'p-moto', internal_code: 'M', name: 'Shineray Jet 50', unit: 'UN', quantity: 1, reserved: 0, min_stock: 0, price_cents: 1, cost_cents: 1 }] } };
      }
      if (p.url.endsWith('/core/units/p-moto')) {
        return { body: { items: [unidade(), unidade({ id: 'un-2', equipment_id: null, plaquinha: null })] } };
      }
      return null;
    };
    render(
      <MemoryRouter>
        <UnidadesEstoquePage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('Nome ou código do produto'), { target: { value: 'Shin' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Shineray Jet 50' }, { timeout: 2000 }));
    await screen.findAllByRole('button', { name: 'Identificar' });
    expect(screen.queryByText('#0009')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Plaquinha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reimprimir plaquinha' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Vincular plaquinha/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desvincular' })).toBeNull();
    expect(screen.queryByText(/sem plaquinha da oficina/)).toBeNull();
    expect(pedidos.some((p) => p.url.includes('/equipment-candidates') || p.url.includes('/equipment/sheet'))).toBe(false);
  });
});

// ---------------------------------------------------------------- GAP-PRD-185

describe('GAP-PRD-185 — a plaquinha da operação pela tela de Empresas (só a PJ Motors, P0)', () => {
  const EMPRESAS = [
    { id: 'c1', slug: 'loja', legalName: 'Loja Ltda', tradeName: 'Loja', cnpj: null, kind: 'retail', active: true, usesEquipmentTags: false },
    { id: 'c2', slug: 'setima', legalName: 'Sétima Ltda', tradeName: 'Sétima Oficina', cnpj: null, kind: 'workshop', active: true, usesEquipmentTags: false },
    { id: 'c3', slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors', cnpj: null, kind: 'retail', active: true, usesEquipmentTags: false },
  ];

  /*
    Antes: "a lista mostra quem usa e liga a plaquinha da sétima oficina". O
    P0 das plaquinhas tirou o botão das operações que não são a PJ Motors — o
    servidor as recusa com 403 — e a linha delas diz de quem a plaquinha é.
  */
  it('só a linha da PJ Motors tem o botão; as outras dizem que é exclusiva dela', async () => {
    let lista = EMPRESAS;
    rotas = (p) => {
      if (p.metodo === 'PATCH' && p.url.endsWith('/core/companies/c3/equipment-tags')) {
        lista = EMPRESAS.map((c) => (c.id === 'c3' ? { ...c, usesEquipmentTags: true } : c));
        return { body: { companyId: 'c3', usesEquipmentTags: true } };
      }
      if (p.url.endsWith('/core/companies')) return { body: { items: lista } };
      return null;
    };
    render(
      <MemoryRouter>
        <EmpresasPage />
      </MemoryRouter>,
    );
    await screen.findByText('Sétima Oficina');
    expect(screen.queryByRole('button', { name: 'Ligar plaquinha de Sétima Oficina' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ligar plaquinha de Loja' })).toBeNull();
    expect(screen.getAllByText('Exclusiva da PJ Motors')).toHaveLength(2);

    fireEvent.click(await screen.findByRole('button', { name: 'Ligar plaquinha de PJ Motors' }));
    await waitFor(() =>
      expect(pedidos.find((p) => p.metodo === 'PATCH')?.corpo).toEqual({ enabled: true }),
    );
    expect(pedidos.filter((p) => p.metodo === 'PATCH').map((p) => p.url)).toEqual([
      expect.stringContaining('/core/companies/c3/equipment-tags'),
    ]);
    expect(await screen.findByText(/PJ Motors passou a usar plaquinha com QR/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Desligar plaquinha de PJ Motors' })).toBeTruthy();
  });

  it('desligar a da PJ com adesivo no pool mostra a recusa do servidor', async () => {
    rotas = (p) => {
      if (p.metodo === 'PATCH') {
        return {
          status: 409,
          body: {
            error: {
              code: 'CORE_COMPANY_TAGS_PENDING',
              message: 'PJ Motors tem 5 plaquinha(s) no pool esperando máquina.',
            },
          },
        };
      }
      if (p.url.endsWith('/core/companies')) {
        return { body: { items: EMPRESAS.map((c) => ({ ...c, usesEquipmentTags: c.id === 'c3' })) } };
      }
      return null;
    };
    render(
      <MemoryRouter>
        <EmpresasPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Desligar plaquinha de PJ Motors' }));
    expect((await screen.findByRole('alert')).textContent).toContain('5 plaquinha(s) no pool');
  });

  /*
    Antes: "criar oficina de mobilidade manda a plaquinha ligada; celular
    desmarca sozinho; a escolha manual vence". A caixa saiu (P0): operação nova
    nunca é a PJ Motors, e o servidor recusaria a marca. O aviso diz que ela
    nasce sem, e o pedido não carrega o campo.
  */
  it('criar operação não oferece plaquinha, e o pedido não liga a marca', async () => {
    rotas = (p) => {
      if (p.metodo === 'POST') {
        return {
          status: 201,
          body: {
            company: { ...EMPRESAS[1], id: 'c9' },
            workshop: null,
            manager: { id: 'u', login: 'g', displayName: 'G', email: null, profileCode: 'gerente_oficina', active: true, mustChangePassword: true, lastLoginAt: null, createdAt: '', workshops: [] },
            linkedGroupAdmins: [],
          },
        };
      }
      if (p.url.endsWith('/core/companies')) return { body: { items: EMPRESAS } };
      return null;
    };
    render(
      <MemoryRouter>
        <EmpresasPage />
      </MemoryRouter>,
    );
    await screen.findByText('Sétima Oficina');
    expect(screen.queryByLabelText(/Esta operação usa plaquinha com QR/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Tipo de operação/), { target: { value: 'workshop' } });
    expect(screen.queryByLabelText(/Esta operação usa plaquinha com QR/)).toBeNull();
    const aviso = screen.getByText('O que este botão faz').closest('div')!;
    expect(within(aviso).getByText(/exclusiva da PJ Motors/)).toBeTruthy();
    expect(within(aviso).queryByText(/Liga a plaquinha com QR/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Tipo da primeira bancada/), { target: { value: 'mobility' } });

    fireEvent.change(screen.getByLabelText(/Razão social/), { target: { value: 'Oitava Oficina Ltda' } });
    fireEvent.change(screen.getByLabelText(/Nome de quem vai gerenciar/), { target: { value: 'Gerente' } });
    fireEvent.change(screen.getByLabelText(/^Login/), { target: { value: 'ger.oitava' } });
    fireEvent.change(screen.getByLabelText(/Senha provisória/), { target: { value: 'Senha@12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar empresa e primeiro gerente' }));

    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST')).toBe(true));
    const criacao = pedidos.find((p) => p.metodo === 'POST')!;
    expect(criacao.corpo).toMatchObject({ kind: 'workshop', workshopKind: 'mobility' });
    expect(criacao.corpo).not.toHaveProperty('usesEquipmentTags');
  });
});
