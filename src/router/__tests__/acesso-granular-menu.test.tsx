/**
 * O MENU de quem tem acesso granular mostra só as páginas liberadas.
 *
 * Para o acesso montado na tela de Usuários, cada item do menu aparece se a
 * tela dele abre para as capabilities do vínculo (a mesma tabela que o guarda
 * usa), e o grupo sem nenhum filho liberado some — a regra estrutural do
 * `AppShell`. Esconder menu não é segurança (o servidor recusa com 403); é só
 * não oferecer porta que bate na cara.
 *
 * A sessão é dublada no hook, como em `grupo-sem-filho-visivel.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';

vi.mock('@/hooks/useSession', () => ({
  useSession: () => sessaoAtual,
  useProfile: () => sessaoAtual?.user.profileCode ?? null,
  useHasProfile: () => false,
}));

let sessaoAtual: {
  user: { id: string; displayName: string; profileCode: string };
  company: { id: string; tradeName: string };
  companies: { id: string; tradeName: string; profileCode: string }[];
  access?: { modelo: { code: string; name: string; personalizado: boolean }; capabilities: string[]; casa: string };
} | null = null;

function entrarComo(profileCode: string, capabilities: string[] | null, personalizado = false): void {
  sessaoAtual = {
    user: { id: 'u1', displayName: 'Fulano', profileCode },
    company: { id: 'c1', tradeName: 'Preço Justo' },
    companies: [{ id: 'c1', tradeName: 'Preço Justo', profileCode }],
    ...(capabilities
      ? { access: { modelo: { code: profileCode, name: profileCode, personalizado }, capabilities, casa: '/' } }
      : {}),
  };
}

function abrirCasca(): void {
  render(
    <MemoryRouter>
      <AppShell>
        <p>PAGINA</p>
      </AppShell>
    </MemoryRouter>,
  );
}

const grupo = (nome: RegExp) => screen.queryByRole('button', { name: nome });

beforeEach(() => {
  sessaoAtual = null;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o menu do acesso granular', () => {
  it('Estoque: o grupo Estoque aparece; Fiscal, Financeiro e Pessoas não', () => {
    entrarComo('estoque', ['inventory.adjust.approve', 'inventory.manage', 'inventory.units.manage', 'inventory.units.view', 'inventory.view']);
    abrirCasca();
    expect(grupo(/estoque/i)).not.toBeNull();
    expect(grupo(/fiscal/i)).toBeNull();
    expect(grupo(/financeiro/i)).toBeNull();
    expect(grupo(/pessoas/i)).toBeNull();
  });

  it('gerente de loja personalizado sem Fiscal: o Fiscal some, o Estoque fica', () => {
    entrarComo('gerente_loja', ['dashboard.view', 'inventory.view', 'products.view', 'sales.view'], true);
    abrirCasca();
    expect(grupo(/fiscal/i)).toBeNull();
    expect(grupo(/estoque/i)).not.toBeNull();
  });

  it('o gerente de loja com o modelo puro vê o menu de sempre (Fiscal incluído)', () => {
    entrarComo('gerente_loja', ['dashboard.view'], false);
    abrirCasca();
    expect(grupo(/fiscal/i)).not.toBeNull();
  });
});
