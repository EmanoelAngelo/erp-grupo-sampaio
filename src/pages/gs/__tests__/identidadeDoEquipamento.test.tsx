/**
 * A IDENTIDADE DA MÁQUINA NA TELA — tipo, placa, km, fotos, contato do dono e
 * correção com motivo (GAP-PRD-106).
 *
 * O que cada caso derruba:
 *   - tire o "Corrigir identidade" e o chassi digitado errado volta a exigir
 *     SQL;
 *   - mande o formulário inteiro em vez do que mudou e o histórico passa a
 *     dizer que tudo foi corrigido;
 *   - deixe o chassi editável na máquina vinculada à loja e o servidor recusa
 *     com a pessoa já tendo digitado;
 *   - volte a categoria para texto livre e cada atendente escreve de um jeito.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';

vi.mock('@/lib/image', () => ({
  normalizeImage: vi.fn(async () => ({
    dataUrl: 'data:image/jpeg;base64,AAAA',
    mimeType: 'image/jpeg',
    width: 10,
    height: 10,
    bytes: 3,
  })),
  dataUrlBytes: () => 3,
}));

import EquipamentoFichaPage from '../EquipamentoFichaPage';
import EquipamentosPage from '../EquipamentosPage';

interface Pedido {
  metodo: string;
  url: string;
  corpo: Record<string, unknown>;
}

let pedidos: Pedido[];
let ficha: Record<string, unknown>;
let fotos: Record<string, unknown>[];

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fichaDe(eq: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    equipment: {
      id: 'eq-1',
      brand: 'Shineray',
      model: 'Jet 50',
      category: 'moto',
      chassis: 'CH-ERRADO',
      plate: 'ABC1D23',
      odometer_km: 1200,
      odometer_at: '2026-09-01',
      serial_number: null,
      motor_number: 'M-1',
      public_id: 7,
      workshop_id: 'wk',
      ...eq,
    },
    warranty: { months: null, baseKind: null, baseDate: null, expiresAt: null, status: 'sem_garantia', daysLeft: null },
    assemblyMechanicName: null,
    ownerName: 'Seu Jorge',
    ownerPhone: '53 98888-0000',
    workshopName: 'Mobilidade',
    publicIdLabel: '#0007',
    plaquinha: { empresaUsa: true, bancadaUsa: true },
    vinculoDeEstoque: null,
    events: [],
    orders: [],
    ...extra,
  };
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
      if (p.metodo === 'PATCH' && p.url.endsWith('/core/equipment/eq-1/identidade')) {
        const eq = { ...(ficha.equipment as Record<string, unknown>) };
        if ('chassis' in p.corpo) eq.chassis = p.corpo.chassis;
        if ('model' in p.corpo) eq.model = p.corpo.model;
        ficha = { ...ficha, equipment: eq };
        return json({ mudancas: [{ campo: 'chassis' }] });
      }
      if (p.url.endsWith('/core/equipment/eq-1/photos')) {
        if (p.metodo === 'POST') {
          fotos.push({ id: `f-${fotos.length + 1}`, url: '/uploads/equipamentos/x.jpg', kind: p.corpo.kind, caption: null, created_at: '' });
          return json(fotos.at(-1), 201);
        }
        return json({ items: fotos });
      }
      if (p.metodo === 'DELETE' && p.url.includes('/core/equipment/eq-1/photos/')) {
        fotos = fotos.filter((f) => !p.url.endsWith(String(f.id)));
        return new Response(null, { status: 204 });
      }
      if (p.url.endsWith('/core/equipment/eq-1')) return json(ficha);
      if (p.metodo === 'POST' && p.url.endsWith('/core/equipment')) {
        return json({ id: 'eq-novo', public_id: 12, publicIdLabel: '#0012' }, 201);
      }
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Pessoa', profileCode },
      // Uma oficina que não é a PJ Motors: o botão do cadastro é "Salvar
      // equipamento" — "Salvar e gerar plaquinha" só na PJ (P0 das plaquinhas).
      company: { id: 'co', slug: 'co', tradeName: 'Oficina', kind: 'workshop' },
      companies: [{ id: 'co', slug: 'co', tradeName: 'Oficina', kind: 'workshop', profileCode }],
    },
    'LOGIN',
    'client.login',
  );
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

beforeEach(() => {
  pedidos = [];
  ficha = fichaDe();
  fotos = [];
  entrarComo('mecanico');
  servidor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('GAP-PRD-106 — a ficha mostra a identidade inteira', () => {
  it('tipo pelo nome, placa legível, km com a data da leitura e o telefone do dono', async () => {
    montarFicha();
    await screen.findByText('Identificação');
    expect(screen.getByText('Moto')).toBeTruthy();
    expect(screen.getByText('ABC-1D23')).toBeTruthy();
    expect(screen.getByText('1.200 km (em 01/09/2026)')).toBeTruthy();
    const telefone = screen.getByRole('link', { name: '53 98888-0000' });
    expect(telefone.getAttribute('href')).toBe('tel:53988880000');
  });

  it('celular: a ficha não fala em placa nem km', async () => {
    ficha = fichaDe({ category: 'celular', plate: null, odometer_km: null });
    montarFicha();
    await screen.findByText('Identificação');
    expect(screen.queryByText('Placa')).toBeNull();
    expect(screen.queryByText('Quilometragem')).toBeNull();
  });
});

describe('GAP-PRD-106 — corrigir a identidade pela ficha', () => {
  it('manda só o que mudou, com o motivo; sem motivo a tela barra antes', async () => {
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Corrigir identidade' }));
    fireEvent.change(screen.getByLabelText('Chassi'), { target: { value: 'CH-CERTO' } });
    fireEvent.change(screen.getByLabelText('Modelo'), { target: { value: 'Jet 50 Plus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar correção' }));
    expect(await screen.findByText(/Diga o motivo da correção/)).toBeTruthy();
    expect(pedidos.some((p) => p.metodo === 'PATCH')).toBe(false);

    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'Chassi digitado errado' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar correção' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'PATCH')).toBe(true));
    const patch = pedidos.find((p) => p.metodo === 'PATCH')!;
    expect(patch.url).toContain('/core/equipment/eq-1/identidade');
    expect(patch.corpo).toEqual({ chassis: 'CH-CERTO', model: 'Jet 50 Plus', motivo: 'Chassi digitado errado' });
    // A ficha recarregou com o chassi novo e o formulário fechou.
    expect(await screen.findByText('CH-CERTO')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar correção' })).toBeNull();
  });

  it('quilometragem nova vai sem motivo', async () => {
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Corrigir identidade' }));
    fireEvent.change(screen.getByLabelText('Quilometragem'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar correção' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'PATCH')).toBe(true));
    expect(pedidos.find((p) => p.metodo === 'PATCH')!.corpo).toEqual({ odometerKm: 1500 });
  });

  it('máquina vinculada à loja: chassi, motor e série travados, dizendo onde corrigir', async () => {
    ficha = fichaDe({}, { vinculoDeEstoque: { unitId: 'un-1', companyName: 'PJ Motors' } });
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Corrigir identidade' }));
    for (const rotulo of ['Chassi', 'Número do motor', 'Número de série']) {
      expect((screen.getByLabelText(rotulo) as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getAllByText(/Vem da unidade de estoque da PJ Motors/).length).toBe(3);
    expect((screen.getByLabelText('Modelo') as HTMLInputElement).disabled).toBe(false);
  });

  it('o tipo antigo em texto livre aparece como antigo, e virar celular leva placa e km embora', async () => {
    ficha = fichaDe({ category: 'moto_eletrica' });
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Corrigir identidade' }));
    const tipo = screen.getByLabelText('Tipo') as HTMLSelectElement;
    expect(tipo.value).toBe('moto_eletrica');
    expect(screen.getByRole('option', { name: 'moto_eletrica (antigo)' })).toBeTruthy();

    fireEvent.change(tipo, { target: { value: 'celular' } });
    expect(screen.queryByLabelText('Placa')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Motivo da correção/), { target: { value: 'Era um celular' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar correção' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'PATCH')).toBe(true));
    expect(pedidos.find((p) => p.metodo === 'PATCH')!.corpo).toEqual({
      category: 'celular',
      plate: null,
      odometerKm: null,
      motivo: 'Era um celular',
    });
  });

  it('o balcão não recebe o botão de corrigir (a rota é da bancada)', async () => {
    entrarComo('atendente');
    montarFicha();
    await screen.findByText('Identificação');
    expect(screen.queryByRole('button', { name: 'Corrigir identidade' })).toBeNull();
  });
});

describe('GAP-PRD-106 — fotos da máquina', () => {
  it('sobe a foto reduzida com o tipo escolhido, lista e apaga', async () => {
    montarFicha();
    await screen.findByText('Nenhuma foto da máquina ainda.');
    fireEvent.change(screen.getByLabelText('Tipo da foto'), { target: { value: 'painel' } });
    fireEvent.change(screen.getByLabelText(/Arquivo da foto/), {
      target: { files: [new File(['x'], 'painel.jpg', { type: 'image/jpeg' })] },
    });
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/photos'))).toBe(true));
    const post = pedidos.find((p) => p.metodo === 'POST' && p.url.endsWith('/photos'))!;
    expect(post.corpo).toEqual({ dataUrl: 'data:image/jpeg;base64,AAAA', kind: 'painel' });
    expect(await screen.findByAltText('Foto da máquina: Painel')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }));
    // A certeza é pedida NA TELA (GAP-PRD-158), não pelo window.confirm.
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar a foto' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'DELETE')).toBe(true));
    expect(await screen.findByText('Nenhuma foto da máquina ainda.')).toBeTruthy();
  });

  it('o atendente sobe mas não apaga', async () => {
    entrarComo('atendente');
    fotos = [{ id: 'f-1', url: '/uploads/equipamentos/a.jpg', kind: 'frente', caption: null, created_at: '' }];
    montarFicha();
    await screen.findByAltText('Foto da máquina: Frente');
    expect(screen.getByLabelText(/Arquivo da foto/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apagar' })).toBeNull();
  });
});

describe('GAP-PRD-106 — o cadastro pergunta o tipo, a placa e o km', () => {
  function montarCadastro() {
    render(
      <MemoryRouter>
        <EquipamentosPage />
      </MemoryRouter>,
    );
  }

  it('moto com placa e km: o corpo leva o tipo do vocabulário, a placa e o km como número', async () => {
    montarCadastro();
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar equipamento' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Do grupo' }));
    fireEvent.change(screen.getByLabelText(/^Tipo/), { target: { value: 'moto' } });
    fireEvent.change(screen.getByLabelText(/^Placa/), { target: { value: 'abc1d23' } });
    fireEvent.change(screen.getByLabelText(/^Quilometragem/), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar equipamento' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/equipment'))).toBe(true));
    const post = pedidos.find((p) => p.metodo === 'POST' && p.url.endsWith('/core/equipment'))!;
    expect(post.corpo).toMatchObject({ category: 'moto', plate: 'ABC1D23', odometerKm: 1200 });
  });

  it('celular não pergunta placa nem km; "Outro" sem marca nem modelo é barrado antes do servidor', async () => {
    montarCadastro();
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar equipamento' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Do grupo' }));
    fireEvent.change(screen.getByLabelText(/^Tipo/), { target: { value: 'celular' } });
    expect(screen.queryByLabelText(/^Placa/)).toBeNull();
    expect(screen.queryByLabelText(/^Quilometragem/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/^Tipo/), { target: { value: 'outro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar equipamento' }));
    expect(await screen.findByText(/Para o tipo "Outro", informe ao menos a marca ou o modelo/)).toBeTruthy();
    expect(pedidos.some((p) => p.metodo === 'POST' && p.url.endsWith('/core/equipment'))).toBe(false);
  });
});
