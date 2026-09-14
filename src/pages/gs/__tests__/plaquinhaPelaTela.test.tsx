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

function entrarComo(profileCode: string, kind = 'workshop') {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Pessoa', profileCode },
      company: { id: 'co', slug: 'co', tradeName: 'Empresa', kind },
      companies: [{ id: 'co', slug: 'co', tradeName: 'Empresa', kind, profileCode }],
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

  it('empresa fora do pool: sem troca, com a explicação; bancada de celular: sem cartão de plaquinha', async () => {
    entrarComo('gerente_oficina');
    let flags = { empresaUsa: false, bancadaUsa: true };
    rotas = (p) => (p.url.endsWith('/core/equipment/eq-1') ? { body: ficha(flags) } : null);
    montarFicha();
    await screen.findByRole('button', { name: 'Reimprimir plaquinha' });
    expect(screen.queryByRole('button', { name: 'Trocar plaquinha' })).toBeNull();
    expect(screen.getByText(/não usa o pool de plaquinhas/)).toBeTruthy();
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
    entrarComo('gerente_loja', 'retail');
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
    entrarComo('operador_caixa_loja', 'retail');
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
});

// ---------------------------------------------------------------- GAP-PRD-185

describe('GAP-PRD-185 — a plaquinha da operação pela tela de Empresas', () => {
  const EMPRESAS = [
    { id: 'c1', slug: 'loja', legalName: 'Loja Ltda', tradeName: 'Loja', cnpj: null, kind: 'retail', active: true, usesEquipmentTags: false },
    { id: 'c2', slug: 'setima', legalName: 'Sétima Ltda', tradeName: 'Sétima Oficina', cnpj: null, kind: 'workshop', active: true, usesEquipmentTags: false },
  ];

  it('a lista mostra quem usa e liga a plaquinha da sétima oficina', async () => {
    let lista = EMPRESAS;
    rotas = (p) => {
      if (p.metodo === 'PATCH' && p.url.endsWith('/core/companies/c2/equipment-tags')) {
        lista = EMPRESAS.map((c) => (c.id === 'c2' ? { ...c, usesEquipmentTags: true } : c));
        return { body: { companyId: 'c2', usesEquipmentTags: true } };
      }
      if (p.url.endsWith('/core/companies')) return { body: { items: lista } };
      return null;
    };
    render(
      <MemoryRouter>
        <EmpresasPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ligar plaquinha de Sétima Oficina' }));
    await waitFor(() =>
      expect(pedidos.find((p) => p.metodo === 'PATCH')?.corpo).toEqual({ enabled: true }),
    );
    expect(await screen.findByText(/Sétima Oficina passou a usar plaquinha com QR/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Desligar plaquinha de Sétima Oficina' })).toBeTruthy();
  });

  it('desligar com adesivo no pool mostra a recusa do servidor', async () => {
    rotas = (p) => {
      if (p.metodo === 'PATCH') {
        return {
          status: 409,
          body: {
            error: {
              code: 'CORE_COMPANY_TAGS_PENDING',
              message: 'Sétima Oficina tem 5 plaquinha(s) no pool esperando máquina.',
            },
          },
        };
      }
      if (p.url.endsWith('/core/companies')) {
        return { body: { items: EMPRESAS.map((c) => ({ ...c, usesEquipmentTags: c.id === 'c2' })) } };
      }
      return null;
    };
    render(
      <MemoryRouter>
        <EmpresasPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Desligar plaquinha de Sétima Oficina' }));
    expect((await screen.findByRole('alert')).textContent).toContain('5 plaquinha(s) no pool');
  });

  it('criar oficina de mobilidade manda a plaquinha ligada; celular desmarca sozinho; a escolha manual vence', async () => {
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
    const caixa = screen.getByLabelText(/Esta operação usa plaquinha com QR/) as HTMLInputElement;
    // Loja: desmarcada.
    expect(caixa.checked).toBe(false);
    fireEvent.change(screen.getByLabelText(/Tipo de operação/), { target: { value: 'workshop' } });
    expect(caixa.checked).toBe(true);
    const aviso = screen.getByText('O que este botão faz').closest('div')!;
    expect(within(aviso).getByText(/Liga a plaquinha com QR/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Tipo da primeira bancada/), { target: { value: 'phones' } });
    expect(caixa.checked).toBe(false);
    fireEvent.change(screen.getByLabelText(/Tipo da primeira bancada/), { target: { value: 'mobility' } });

    fireEvent.change(screen.getByLabelText(/Razão social/), { target: { value: 'Oitava Oficina Ltda' } });
    fireEvent.change(screen.getByLabelText(/Nome de quem vai gerenciar/), { target: { value: 'Gerente' } });
    fireEvent.change(screen.getByLabelText(/^Login/), { target: { value: 'ger.oitava' } });
    fireEvent.change(screen.getByLabelText(/Senha provisória/), { target: { value: 'Senha@12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar empresa e primeiro gerente' }));

    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST')).toBe(true));
    const criacao = pedidos.find((p) => p.metodo === 'POST')!;
    expect(criacao.corpo).toMatchObject({ kind: 'workshop', workshopKind: 'mobility', usesEquipmentTags: true });
  });
});
