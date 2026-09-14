/**
 * BOTÃO QUE O SERVIDOR FECHA NÃO APARECE — GAP-PRD-149.
 *
 * Três telas ROTA_GESTAO ofereciam ações que o guarda da rota recusa para
 * parte de quem chega nelas:
 *
 *   - Orçamentos: Faturar e Cancelar (`/quotes/:id/convert` e `/cancel`,
 *     BALCAO_E_GERENCIA), Novo/Editar/Renovar/Aprovar (BALCAO_E_GERENCIA +
 *     atendente) e Liberar vencidos (os dois gerentes). O estoquista via todos;
 *     o atendente via Faturar, Cancelar e Liberar vencidos.
 *   - Locais de estoque: Adicionar, Desativar e Transferir (gerentes +
 *     estoquista). O atendente via os três.
 *   - Usuários e equipe: o seletor de perfil — resolvido no SERVIDOR (`GET
 *     /core/team/profiles` só devolve o que quem pergunta pode entregar), com
 *     prova em `seletor-de-perfil-so-oferece-o-que-se-pode-dar.test.ts`.
 *
 * Cada caso cobra também o perfil PERMITIDO: recorte que esconde de todo mundo
 * passaria nos casos de exclusão e quebraria a tela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let perfil = 'estoquista';

vi.mock('@/hooks/useSession', async (original) => {
  const real = await original<typeof import('@/hooks/useSession')>();
  return {
    ...real,
    useProfile: () => perfil,
    useHasProfile: (...allowed: string[]) =>
      perfil === 'admin_geral' || perfil === 'gestor' || allowed.includes(perfil),
  };
});

const hoje = new Date();
const amanha = new Date(hoje.getTime() + 86_400_000).toISOString();

vi.mock('@/lib/api/core', async (original) => {
  const real = await original<typeof import('@/lib/api/core')>();
  return {
    ...real,
    coreApi: {
      ...real.coreApi,
      listQuotes: vi.fn(async () => [
        {
          id: 'q1',
          number: 7,
          kind: 'orcamento',
          status: 'aberto',
          customer_id: null,
          total_cents: 12_000,
          discount_cents: 0,
          valid_until: amanha,
          converted_sale_id: null,
          note: null,
          created_at: hoje.toISOString(),
        },
      ]),
      listStockLocations: vi.fn(async () => [
        { id: 'l1', company_id: 'c1', code: 'LOJA', name: 'Loja', note: null, is_default: 1, active: 1 },
        { id: 'l2', company_id: 'c1', code: 'DEP', name: 'Depósito', note: null, is_default: 0, active: 1 },
      ]),
    },
  };
});

// A tela de Orçamentos lê pela PÁGINA desde a paginação (GAP-PRD-070, EST): o
// dublê monta a página com o lerPagina de verdade, sobre o mesmo #7 do listQuotes.
vi.mock('@/lib/api/paginas', async (original) => {
  const real = await original<typeof import('@/lib/api/paginas')>();
  const { coreApi } = await import('@/lib/api/core');
  return {
    ...real,
    paginaDeOrcamentos: vi.fn(async () => real.lerPagina({ items: await coreApi.listQuotes() })),
  };
});

const { default: OrcamentosPage } = await import('../OrcamentosPage');
const { default: LocaisEstoquePage } = await import('../LocaisEstoquePage');

function montar(el: React.ReactElement) {
  render(<MemoryRouter>{el}</MemoryRouter>);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Orçamentos', () => {
  it('estoquista (nenhuma escrita de orçamento é dele): nenhum botão de ação', async () => {
    perfil = 'estoquista';
    montar(<OrcamentosPage />);
    const linha = (await screen.findByText('#7')).closest('tr')!;
    for (const nome of ['Faturar', 'Cancelar', 'Editar', 'Aprovar']) {
      expect(within(linha).queryByRole('button', { name: nome }), nome).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Novo orçamento/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liberar vencidos' })).toBeNull();
  });

  it('atendente: escreve (Novo, Editar, Aprovar), mas não fatura, não cancela e não libera vencidos', async () => {
    perfil = 'atendente';
    montar(<OrcamentosPage />);
    const linha = (await screen.findByText('#7')).closest('tr')!;
    expect(within(linha).getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(within(linha).getByRole('button', { name: 'Aprovar' })).toBeTruthy();
    expect(within(linha).queryByRole('button', { name: 'Faturar' })).toBeNull();
    expect(within(linha).queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(screen.getByRole('button', { name: /Novo orçamento/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Liberar vencidos' })).toBeNull();
  });

  it('gerente de loja: tudo continua lá', async () => {
    perfil = 'gerente_loja';
    montar(<OrcamentosPage />);
    const linha = (await screen.findByText('#7')).closest('tr')!;
    for (const nome of ['Faturar', 'Cancelar', 'Editar', 'Aprovar']) {
      expect(within(linha).getByRole('button', { name: nome }), nome).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Liberar vencidos' })).toBeTruthy();
  });
});

describe('Locais de estoque', () => {
  it('atendente consulta: sem Adicionar, sem Desativar, e a tela diz de quem é', async () => {
    perfil = 'atendente';
    montar(<LocaisEstoquePage />);
    await screen.findByText('Depósito');
    expect(screen.queryByRole('button', { name: 'Adicionar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desativar' })).toBeNull();
    expect(screen.getByTestId('locais-so-consulta').textContent).toMatch(/estoque e da gerência/);
  });

  it('estoquista mexe: Adicionar e Desativar continuam', async () => {
    perfil = 'estoquista';
    montar(<LocaisEstoquePage />);
    await screen.findByText('Depósito');
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Desativar' })).toBeTruthy();
    expect(screen.queryByTestId('locais-so-consulta')).toBeNull();
  });
});
