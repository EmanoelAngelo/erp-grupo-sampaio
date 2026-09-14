/**
 * A PLAQUINHA DEPOIS DA VENDA E O DIA 1 DA PJ MOTORS, NA TELA DE UNIDADES
 * (GAP-PRD-108, GAP-PRD-112).
 *
 * O que cada bloco derruba:
 *   - tire o "Vincular plaquinha (já vendida)" e a moto que saiu sem plaquinha
 *     volta a não ter gesto nenhum (o servidor aceitaria, a tela não pede);
 *   - tire o `unitId` da busca de candidatas e a moto vendida recebe a lista de
 *     qualquer plaquinha, em vez da que tem o mesmo número;
 *   - tire o cartão do dia 1 e a operação sem produto controlado por unidade
 *     volta a vender moto como item comum sem ninguém avisar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import UnidadesEstoquePage from '../UnidadesEstoquePage';

interface Pedido {
  metodo: string;
  url: string;
  corpo: Record<string, unknown>;
}

let pedidos: Pedido[];
let resumo: Record<string, number>;

const VENDIDA = {
  id: 'u-1',
  company_id: 'pj',
  product_id: 'p-moto',
  status: 'sold',
  serial_number: null,
  imei: null,
  chassis: 'CH-TARDIA',
  motor_number: null,
  plate: null,
  location_id: null,
  cost_cents: null,
  entry_reference_type: 'ajuste',
  exit_reference_type: 'sale',
  equipment_id: null,
  note: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

const CANDIDATA = {
  id: 'eq-7',
  publicId: 7,
  publicIdLabel: '#0007',
  brand: 'PJ Motors',
  model: 'Sport 3000',
  chassis: 'CH-TARDIA',
  motorNumber: null,
  serialNumber: null,
  workshopName: 'Mobilidade',
  workshopCompanyName: 'Oficina',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  pedidos = [];
  resumo = { semPlaquinha: 0, vendidasSemPlaquinha: 1, produtosSerializados: 0, semIdentidade: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const p: Pedido = {
        metodo: (init?.method ?? 'GET').toUpperCase(),
        url: String(url),
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      pedidos.push(p);
      if (p.url.includes('/core/units/summary')) return json(resumo);
      if (p.url.includes('/core/units/equipment-candidates')) return json({ items: [CANDIDATA] });
      if (p.url.includes('/core/units/u-1/equipment') && p.metodo === 'POST') {
        return json(
          {
            plaquinha: {
              id: 'eq-7',
              publicId: 7,
              publicIdLabel: '#0007',
              brand: 'PJ Motors',
              model: 'Sport 3000',
              saleStatus: 'SOLD',
              status: 'ativo',
              workshopName: 'Mobilidade',
              workshopCompanyName: 'Oficina',
              ordensAbertas: 0,
            },
          },
          201,
        );
      }
      if (p.url.includes('/core/units?q=')) return json({ items: [VENDIDA] });
      return json({ items: [] });
    }),
  );
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'pj', slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail' },
      companies: [{ id: 'pj', slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail', profileCode: 'gerente_loja' }],
    },
    'LOGIN',
    'client.login',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function montar() {
  render(
    <MemoryRouter>
      <UnidadesEstoquePage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-112 — o dia 1 da operação de motos, dito na tela', () => {
  it('sem produto controlado por unidade, o cartão diz o que falta; com a configuração feita, some', async () => {
    montar();
    const cartao = await screen.findByRole('region', { name: 'Dia 1 da operação de motos' });
    expect(cartao.textContent).toMatch(/Nenhum produto desta empresa é controlado por unidade/);

    cleanup();
    resumo = { semPlaquinha: 0, vendidasSemPlaquinha: 0, produtosSerializados: 2, semIdentidade: 3 };
    montar();
    const pendente = await screen.findByRole('region', { name: 'Dia 1 da operação de motos' });
    expect(pendente.textContent).toMatch(/3 moto\(s\) no pátio sem chassi nem número/);
    expect(pendente.textContent).not.toMatch(/Nenhum produto/);

    cleanup();
    resumo = { semPlaquinha: 0, vendidasSemPlaquinha: 0, produtosSerializados: 2, semIdentidade: 0 };
    montar();
    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/core/units/summary'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Dia 1 da operação de motos' })).toBeNull();
  });
});

describe('GAP-PRD-108 — a moto vendida sem plaquinha ganha o vínculo pela tela', () => {
  it('a fila avisa, o chassi bipado abre o vínculo tardio e a lista vem pela identidade da moto vendida', async () => {
    montar();
    expect(await screen.findByText(/1 moto\(s\) vendida\(s\) sem plaquinha da oficina/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Chassi, IMEI, placa ou número de série'), {
      target: { value: 'CH-TARDIA' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Vincular plaquinha (já vendida)' }));

    expect(await screen.findByText(/Esta moto já foi vendida/)).toBeTruthy();
    await screen.findByText('#0007');
    const busca = pedidos.find((p) => p.url.includes('/core/units/equipment-candidates'));
    expect(busca?.url).toContain('unitId=u-1');

    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() =>
      expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/units/u-1/equipment'))).toBe(true),
    );
    const post = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/units/u-1/equipment'))!;
    expect(post.corpo).toEqual({ equipmentId: 'eq-7', confirmarPelaUnidade: false });
    expect(await screen.findByText(/Plaquinha #0007 vinculada/)).toBeTruthy();
  });
});
