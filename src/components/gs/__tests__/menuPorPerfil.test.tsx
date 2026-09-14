/**
 * ============================================================================
 * O MENU RENDERIZADO ESCONDE MESMO — não basta o dado dizer que esconde
 * ============================================================================
 *
 * `environments.test.tsx` prova que "Empresas do grupo" DECLARA a lista de
 * perfis, e `menu-e-rotas.test.tsx` prova que a declaração bate com a da rota.
 * Nenhum dos dois toca no `AppShell`.
 *
 * Isso deixa um buraco do tamanho da rodada 22: `canSeeChild` poderia ignorar
 * `profiles` por inteiro e os dois arquivos continuariam verdes, porque ambos
 * leem a LISTA e não a TELA. A declaração estaria perfeita, o dado correto, e
 * o estoquista veria o item assim mesmo — configuração inerte.
 *
 * Este arquivo abre o menu de verdade, com sessão de cada perfil, e olha o que
 * aparece na coluna. Ele fica vermelho se o filtro de perfil sair do
 * `AppShell` — conferido apagando a linha do `perfilAtende` em `canSeeChild`:
 * o caso do estoquista passa a achar o item.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../AppShell';

/**
 * A sessão é dublada no hook, e não no `localStorage`.
 *
 * `getSession()` exige a forma exata que o servidor emite, token JWT incluso.
 * Imitar isso aqui amarraria o teste do MENU à hidratação do cliente HTTP —
 * mesma decisão, e mesmo motivo, do dublê em `environments.test.tsx`.
 */
vi.mock('@/hooks/useSession', () => ({
  useSession: () => sessaoAtual,
  useProfile: () => sessaoAtual?.user.profileCode ?? null,
  useHasProfile: () => false,
}));

let sessaoAtual: {
  user: { id: string; displayName: string; profileCode: string };
  company: { id: string; tradeName: string };
  companies: { id: string; tradeName: string; profileCode: string }[];
} | null = null;

function entrarComo(profileCode: string): void {
  sessaoAtual = {
    user: { id: 'u1', displayName: 'Fulano', profileCode },
    company: { id: 'c1', tradeName: 'Sampaio Centro' },
    companies: [{ id: 'c1', tradeName: 'Sampaio Centro', profileCode }],
  };
}

/** Abre a casca e expande o grupo Configurações, onde o item mora. */
function abrirConfiguracoes() {
  render(
    <MemoryRouter>
      <AppShell>
        <p>PAGINA</p>
      </AppShell>
    </MemoryRouter>,
  );
  const grupo = screen.queryByRole('button', { name: /Configurações/ });
  if (grupo) fireEvent.click(grupo);
  return grupo;
}

beforeEach(() => {
  sessaoAtual = null;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('"Empresas do grupo" só aparece para quem o servidor atende', () => {
  it('o gestor vê o item', () => {
    entrarComo('gestor');
    abrirConfiguracoes();
    expect(screen.getByText('Empresas do grupo')).toBeTruthy();
  });

  it('o administrador do grupo vê o item', () => {
    entrarComo('admin_geral');
    abrirConfiguracoes();
    expect(screen.getByText('Empresas do grupo')).toBeTruthy();
  });

  it('o estoquista NÃO vê — a rota do servidor o recusa com 403', () => {
    entrarComo('estoquista');
    abrirConfiguracoes();
    expect(screen.queryByText('Empresas do grupo')).toBeNull();
  });

  it('o gerente de loja NÃO vê', () => {
    entrarComo('gerente_loja');
    abrirConfiguracoes();
    expect(screen.queryByText('Empresas do grupo')).toBeNull();
  });

  it('o atendente NÃO vê', () => {
    entrarComo('atendente');
    abrirConfiguracoes();
    expect(screen.queryByText('Empresas do grupo')).toBeNull();
  });
});

describe('o filtro novo não levou nada junto', () => {
  it('o estoquista continua vendo o resto de Configurações', () => {
    // Esta é a metade que quase ninguém escreve, e é a que impede a dimensão
    // nova de virar uma tesoura: se `profiles` tivesse nascido com padrão
    // restritivo, o menu do escritório inteiro sumiria e nenhum teste acima
    // perceberia — todos eles só sabem dizer que algo NÃO está lá.
    entrarComo('estoquista');
    abrirConfiguracoes();

    expect(screen.getByText('Impressoras')).toBeTruthy();
    expect(screen.getByText('Política do balcão')).toBeTruthy();
    expect(screen.getByText('Integrações')).toBeTruthy();
  });

  it('o gestor vê o grupo inteiro, com o item novo dentro', () => {
    entrarComo('gestor');
    abrirConfiguracoes();

    expect(screen.getByText('Impressoras')).toBeTruthy();
    expect(screen.getByText('Empresas do grupo')).toBeTruthy();
  });

  it('o mecânico não chega nem a ver o grupo Configurações', () => {
    // O recorte por ambiente, que já existia, continua valendo por cima do de
    // perfil: bancada não abre configuração nenhuma.
    entrarComo('mecanico');
    expect(abrirConfiguracoes()).toBeNull();
    expect(screen.queryByText('Empresas do grupo')).toBeNull();
  });
});
