/**
 * ============================================================================
 * PLAQUINHA SÓ NA PJ MOTORS, NA TELA (P0 das plaquinhas)
 * ============================================================================
 *
 * O servidor recusa toda rota de plaquinha fora da PJ Motors com 403
 * (`server/tests/plaquinhas-so-na-pj.test.ts`). Nada disso alcança o que mora
 * aqui: o item do menu, a aba de Etiquetas, o seletor do cadastro de máquina e
 * o selo da bancada apareciam em qualquer empresa, e a tela só descobria no
 * 403 — ou pior, mostrava a função e uma lista vazia.
 *
 * O que cada bloco derruba:
 *   - tire `empresas` do item "Plaquinhas" (ou o filtro em `canSeeChild`) e a
 *     Oficina, a Preço Justo e as lojas voltam a ver o item;
 *   - tire o `temPlaquinha` da aba de Etiquetas e a Oficina volta a imprimir
 *     "Plaquinha de oficina" por ali;
 *   - tire o `temPlaquinha` do cadastro de máquina e a Oficina volta a pedir o
 *     pool (`/equipment-tags?status=disponivel`) a cada formulário aberto.
 *
 * A rota digitada à mão (`/sistema/equipamentos/plaquinhas`) é coberta em
 * `Plaquinhas.test.tsx`: "não disponível nesta empresa" e zero chamadas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { AppShell } from '@/components/gs/AppShell';
import EtiquetasPage from '../EtiquetasPage';
import EquipamentosPage from '../EquipamentosPage';
import OficinasPage from '../OficinasPage';

const FORA_DA_PJ = [
  { slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
  { slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
  { slug: 'gringa', tradeName: 'Gringa', kind: 'retail' },
  { slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail' },
  { slug: 'conceito', tradeName: 'Conceito', kind: 'retail' },
];
const PJ = { slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail' };

let pedidos: string[];
let respostas: (url: string) => unknown;

function entrar(empresa: { slug: string; tradeName: string; kind: string }, profileCode = 'gestor') {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'u', displayName: 'Pessoa', profileCode },
      company: { id: empresa.slug, ...empresa },
      companies: [{ id: empresa.slug, ...empresa, profileCode }],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  respostas = () => null;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      pedidos.push(alvo);
      /*
        Um corpo que serve a quase toda leitura: lista vazia, total zero e o
        catálogo de etiquetas vazio. O que o caso precisa de específico vem de
        `respostas`.
      */
      const corpo = respostas(alvo) ?? {
        items: [],
        total: 0,
        sources: [],
        formats: [],
        quantityModes: [],
        defaultFormat: '',
      };
      return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Abre a casca e expande o grupo Oficina, onde o item mora. */
function abrirGrupoOficina() {
  render(
    <MemoryRouter>
      <AppShell>
        <p>PAGINA</p>
      </AppShell>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Oficina/ }));
}

describe('o item "Plaquinhas" do menu', () => {
  for (const empresa of FORA_DA_PJ) {
    it(`${empresa.tradeName} não vê o item — o resto do grupo Oficina continua`, () => {
      entrar(empresa);
      abrirGrupoOficina();
      // O grupo abriu de verdade: o vizinho está lá.
      expect(screen.getByText('Ordens de serviço')).toBeTruthy();
      expect(screen.queryByText('Plaquinhas')).toBeNull();
      expect(screen.queryByRole('link', { name: /Plaquinhas/ })).toBeNull();
    });
  }

  it('a PJ Motors vê o item, e ele leva à tela do pool', () => {
    entrar(PJ);
    abrirGrupoOficina();
    const link = screen.getByRole('link', { name: /Plaquinhas/ });
    expect(link.getAttribute('href')).toBe('/sistema/equipamentos/plaquinhas');
  });

  it('o slug decide, e não a caixa: "PJ-Motors " com espaço e maiúscula ainda é a PJ; "pj-motors-2" não é', () => {
    entrar({ ...PJ, slug: ' PJ-Motors ' });
    abrirGrupoOficina();
    expect(screen.getByRole('link', { name: /Plaquinhas/ })).toBeTruthy();
    cleanup();
    entrar({ ...PJ, slug: 'pj-motors-2' });
    abrirGrupoOficina();
    expect(screen.queryByRole('link', { name: /Plaquinhas/ })).toBeNull();
  });
});

describe('a aba de plaquinha em Etiquetas', () => {
  it('a Oficina (com bancada) não tem a aba "Plaquinha de oficina", e não pede formato de plaquinha', async () => {
    entrar(FORA_DA_PJ[0]!, 'gerente_oficina');
    render(
      <MemoryRouter>
        <EtiquetasPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('tab', { name: 'Etiqueta comercial' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Plaquinha de oficina' })).toBeNull();
    await waitFor(() => expect(pedidos.length).toBeGreaterThan(0));
    expect(pedidos.some((u) => u.includes('/labels/equipment'))).toBe(false);
  });

  it('a PJ Motors continua vendo a aba', async () => {
    entrar(PJ, 'gerente_loja');
    render(
      <MemoryRouter>
        <EtiquetasPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('tab', { name: 'Plaquinha de oficina' })).toBeTruthy();
  });
});

describe('o cadastro de máquina', () => {
  it('na Oficina: sem seletor de adesivo, sem pedir o pool, e o botão não promete plaquinha', async () => {
    entrar(FORA_DA_PJ[0]!, 'gerente_oficina');
    render(
      <MemoryRouter>
        <EquipamentosPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar equipamento' }));
    expect(await screen.findByRole('button', { name: 'Salvar equipamento' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar e gerar plaquinha' })).toBeNull();
    expect(screen.queryByLabelText(/Plaquinha colada na máquina/)).toBeNull();
    expect(screen.getByText('O número do equipamento é gerado pelo sistema ao salvar.')).toBeTruthy();
    expect(pedidos.some((u) => u.includes('/equipment-tags'))).toBe(false);
  });

  it('na PJ Motors o formulário pergunta ao pool, como antes', async () => {
    entrar(PJ, 'gerente_oficina');
    render(
      <MemoryRouter>
        <EquipamentosPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar equipamento' }));
    expect(await screen.findByRole('button', { name: 'Salvar e gerar plaquinha' })).toBeTruthy();
    await waitFor(() => expect(pedidos.some((u) => u.includes('/core/equipment-tags?status=disponivel'))).toBe(true));
  });
});

describe('o retrato das bancadas', () => {
  it('a Oficina não lê "Plaquinha do equipamento" na bancada de mobilidade', async () => {
    entrar(FORA_DA_PJ[0]!, 'gestor');
    respostas = (url) =>
      url.endsWith('/core/workshops')
        ? {
            items: [
              {
                id: 'wk',
                slug: 'oficina-mobilidade',
                name: 'Oficina de Mobilidade Elétrica',
                kind: 'mobility',
                active: true,
                capabilities: { kanban: true, parts: true, equipmentTags: true },
              },
            ],
          }
        : null;
    render(
      <MemoryRouter>
        <OficinasPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Oficina de Mobilidade Elétrica')).toBeTruthy();
    expect(screen.getByText('Ordens de serviço')).toBeTruthy();
    expect(screen.queryByText('Plaquinha do equipamento')).toBeNull();
    expect(screen.queryByText('Sem plaquinha')).toBeNull();
    expect(screen.queryByText(/a plaquinha é como se acha/)).toBeNull();
  });
});
