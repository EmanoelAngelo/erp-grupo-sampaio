/**
 * A FRONTEIRA ENTRE A PJ MOTORS E A OFICINA, NA TELA
 * (GAP-PRD-109, GAP-PRD-189, GAP-PRD-110).
 *
 * O que cada bloco derruba:
 *   - tire o aviso da moto do estoque no "Abrir OS" e o balcão volta a pôr a
 *     OS de montagem em nome de um cliente (o servidor recusaria, a tela não
 *     diria por quê);
 *   - tire o cartão "Venda registrada à mão" e a plaquinha vendida sem venda
 *     volta a só ter conserto no banco;
 *   - volte a esconder "Gerar lote" quando o pool diz `temBancada: false` e a
 *     PJ Motors — sem bancada, e que agora gera as dela por decisão do dono —
 *     perde o botão de novo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { AbrirOsDialog } from '@/components/gs/AbrirOsDialog';
import EquipamentoFichaPage from '../EquipamentoFichaPage';
import OficinaPage from '../OficinaPage';
import PlaquinhasPage from '../PlaquinhasPage';

interface Pedido {
  metodo: string;
  url: string;
  corpo: Record<string, unknown>;
}

let pedidos: Pedido[];
let rotas: (p: Pedido) => { status?: number; body: unknown } | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  rotas = () => null;
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
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- GAP-PRD-109

const MOTO_DO_ESTOQUE = {
  id: 'eq-7',
  public_id: 7,
  publicIdLabel: '#0007',
  origin: 'INTERNAL_PJ_MOTORS',
  brand: 'PJ Motors',
  model: 'Sport 3000',
  sale_status: 'NOT_SOLD',
  estoque: { unitId: 'u-1', unitStatus: 'in_stock', productName: 'Honda CG 160', companyName: 'PJ Motors' },
};

describe('GAP-PRD-109 — a moto do estoque abre OS interna, sem cliente', () => {
  it('escolher a moto do estoque avisa, trava o cliente e a OS vai sem cadastro', async () => {
    entrarComo('operador_caixa_oficina');
    rotas = (p) => {
      if (p.url.includes('/core/workshop/entrada')) {
        return { body: { items: [{ id: 'wk', slug: 'oficina-mobilidade', name: 'Mobilidade', kind: 'mobility' }] } };
      }
      if (p.url.includes('/core/equipment?search=')) return { body: { items: [MOTO_DO_ESTOQUE] } };
      if (p.url.includes('/core/workshop/orders') && p.metodo === 'POST') {
        return { status: 201, body: { id: 'os-1', number: 5, status: 'em_aberto' } };
      }
      return null;
    };
    const aberta = vi.fn();
    render(<AbrirOsDialog onAberta={aberta} onClose={() => undefined} />);

    fireEvent.change(screen.getByLabelText(/^Aparelho/), { target: { value: 'Sport' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Aparelho: PJ Motors Sport 3000' }));

    expect(await screen.findByText(/Moto do estoque da PJ Motors, ainda não vendida/)).toBeTruthy();
    const cliente = screen.getByLabelText(/^Cliente/) as HTMLInputElement;
    expect(cliente.value).toBe('Montagem interna');
    expect(cliente.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir OS' }));
    await waitFor(() => expect(aberta).toHaveBeenCalled());
    const post = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/workshop/orders'))!;
    expect(post.corpo).toMatchObject({ customerId: null, customerName: 'Montagem interna', equipmentId: 'eq-7' });
  });

  it('no quadro da bancada, a "Nova OS" da moto do estoque também avisa e vai sem cliente', async () => {
    entrarComo('gerente_oficina');
    rotas = (p) => {
      if (p.url.includes('/core/workshop/entrada')) {
        return { body: { items: [{ id: 'wk', slug: 'oficina-mobilidade', name: 'Mobilidade', kind: 'mobility' }] } };
      }
      if (p.url.includes('/core/equipment?search=')) return { body: { items: [MOTO_DO_ESTOQUE] } };
      if (p.url.includes('/core/workshop/orders') && p.metodo === 'POST') {
        return { status: 201, body: { id: 'os-2', number: 6, status: 'em_aberto' } };
      }
      return null;
    };
    render(
      <MemoryRouter>
        <OficinaPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Nova OS' }));
    const equipamento = await screen.findByLabelText(/^Equipamento/);
    fireEvent.change(equipamento, { target: { value: 'Sport' } });
    fireEvent.click(await screen.findByRole('button', { name: /#7 PJ Motors Sport 3000/ }));

    expect(await screen.findByText(/Moto do estoque da PJ Motors, ainda não vendida/)).toBeTruthy();
    const cliente = screen.getByLabelText(/Cliente/) as HTMLInputElement;
    expect(cliente.value).toBe('Montagem interna');
    expect(cliente.disabled).toBe(true);

    fireEvent.submit(equipamento.closest('form')!);
    await waitFor(() =>
      expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/workshop/orders'))).toBe(true),
    );
    const post = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/workshop/orders'))!;
    expect(post.corpo).toMatchObject({ customerId: null, customerName: 'Montagem interna', equipmentId: 'eq-7' });
  });
});

// ---------------------------------------------------------------- GAP-PRD-189

function ficha(vendaAMao: boolean) {
  return {
    equipment: {
      id: 'eq-1',
      brand: 'PJ Motors',
      model: 'Sport 3000',
      public_id: 1,
      workshop_id: 'wk',
      origin: 'INTERNAL_PJ_MOTORS',
      sale_status: vendaAMao ? 'SOLD' : 'NOT_SOLD',
      sold_at: vendaAMao ? '2025-03-10T12:00:00.000Z' : null,
    },
    warranty: { months: null, baseKind: null, baseDate: null, expiresAt: null, status: 'sem_garantia', daysLeft: null },
    assemblyMechanicName: null,
    ownerName: vendaAMao ? 'Dono Registrado' : null,
    workshopName: 'Mobilidade',
    publicIdLabel: '#0001',
    plaquinha: { empresaUsa: true, bancadaUsa: true },
    vendaAMao,
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

describe('GAP-PRD-189 — a venda à mão tem volta pela ficha', () => {
  it('o gerente da oficina desfaz com motivo, e a ficha relê sem o cartão', async () => {
    entrarComo('gerente_oficina');
    let desfeita = false;
    rotas = (p) => {
      if (p.url.endsWith('/core/equipment/eq-1/owner/desfazer') && p.metodo === 'POST') {
        desfeita = true;
        return { body: { id: 'eq-1', sale_status: 'NOT_SOLD' } };
      }
      if (/\/core\/equipment\/eq-1$/.test(p.url)) return { body: ficha(!desfeita) };
      return null;
    };
    montarFicha();

    const cartao = await screen.findByRole('region', { name: 'Venda registrada à mão' });
    expect(cartao.textContent).toContain('Dono Registrado');
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer registro de venda' }));
    fireEvent.change(screen.getByLabelText(/^Motivo/), { target: { value: 'A moto ainda está no pátio da PJ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(desfeita).toBe(true));
    const post = pedidos.find((p) => p.metodo === 'POST' && p.url.endsWith('/owner/desfazer'))!;
    expect(post.corpo).toEqual({ motivo: 'A moto ainda está no pátio da PJ' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Venda registrada à mão' })).toBeNull());
  });

  it('o mecânico vê o aviso, mas não o botão — o servidor só aceita a gestão da oficina', async () => {
    entrarComo('mecanico');
    rotas = (p) => (/\/core\/equipment\/eq-1$/.test(p.url) ? { body: ficha(true) } : null);
    montarFicha();
    await screen.findByRole('region', { name: 'Venda registrada à mão' });
    expect(screen.queryByRole('button', { name: 'Desfazer registro de venda' })).toBeNull();
  });
});

// ---------------------------------------------------------------- GAP-PRD-110

/*
  A DECISÃO DO DONO VIROU ESTE CASO. Ele cobrava o aviso "Operação sem bancada"
  no lugar de "Gerar lote": a PJ Motors, sem bancada, só adotava plaquinha da
  Oficina. O dono decidiu que a PJ gera as plaquinhas dela sem bancada, e o
  servidor parou de recusar e de mandar `temBancada`. O pool dublado aqui
  ainda manda `temBancada: false`, como o servidor antigo — e a tela não pode
  mais obedecê-lo.
*/
describe('GAP-PRD-110 — a PJ Motors sem bancada gera lote (decisão do dono)', () => {
  it('a tela oferece "Gerar lote" ao gestor da PJ, sem aviso de bancada', async () => {
    // A PJ Motors (P0 das plaquinhas): fora dela a rota nem abre o pool — a
    // sessão de loja genérica ('co') cairia no estado "não disponível".
    entrarComo('gerente_loja', 'retail', 'pj-motors');
    rotas = (p) => {
      if (/\/core\/equipment-tags(\?|$)/.test(p.url)) {
        return {
          body: {
            items: [],
            total: 0,
            resumo: { total: 0 },
            usaPlaquinha: true,
            temBancada: false,
          },
        };
      }
      if (p.url.includes('/core/equipment-tags/layout')) return { body: { layout: { widthMm: 63, heightMm: 33 } } };
      return null;
    };
    render(
      <MemoryRouter>
        <PlaquinhasPage />
      </MemoryRouter>,
    );
    // Espera a leitura do pool TERMINAR: antes dela a tela antiga também
    // mostrava o cartão, e só o escondia quando chegava `temBancada: false`.
    await screen.findByText('Nenhuma plaquinha');
    expect(screen.getByText('Gerar lote')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gerar' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Operação sem bancada' })).toBeNull();
    expect(screen.queryByText(/não tem bancada/)).toBeNull();
  });
});
