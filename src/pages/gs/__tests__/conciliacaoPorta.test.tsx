/**
 * A PORTA da conciliação de recebimento — menu e rota espelhando o servidor.
 *
 * O guarda do servidor para o que esta tela LÊ e AMARRA é o das rotas de
 * pedido de compra: `GET /core/purchase-orders`, `GET /purchase-orders/:id` e
 * `POST /purchase-orders/:id/notes/:noteId` nomeiam `gerente_loja`,
 * `gerente_oficina` e `estoquista` (core.ts). O atendente é escritório, mas o
 * servidor o recusa em TODA chamada — oferecer o item a ele repete o defeito
 * das quinze portas que `audit-portas.test.tsx` fechou: tela que monta
 * inteira e responde 403 em tudo.
 *
 * O mesmo desenho e os mesmos dublês daquele arquivo, porque o que se mede é
 * o mesmo par: o excluído não vê o item nem alcança a rota; o permitido
 * continua vendo — o recorte não pode virar tesoura.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, type RouteObject } from 'react-router-dom';
import { Protected } from '@/router/Protected';
import { gsRoutes } from '@/router/gsRoutes';
import { AppShell } from '@/components/gs/AppShell';
import type { Environment } from '@/router/environments';

const CAMINHO = '/sistema/compras/conciliacao';

let perfilAtual: { user: { profileCode: string } } | null = null;

vi.mock('@/lib/api/client', () => ({
  getSession: () => perfilAtual,
  // A casca monta o EstadoConexao, que escuta o aviso de servidor sem resposta
  // e confere as vendas guardadas: o módulo falso precisa ter os dois.
  EVENTO_SERVIDOR_SEM_RESPOSTA: 'gs:servidor-caiu',
  apiRequest: async () => ({ items: [] }),
}));

vi.mock('@/hooks/useSession', () => ({
  useSession: () =>
    perfilAtual
      ? {
          user: { id: 'u1', displayName: 'Pessoa da Casa', ...perfilAtual.user },
          company: { id: 'c1', tradeName: 'Me Mimei Modas' },
          companies: [{ id: 'c1', tradeName: 'Me Mimei Modas', ...perfilAtual.user }],
        }
      : null,
  useProfile: () => perfilAtual?.user.profileCode ?? null,
  useHasProfile: () => false,
}));

function entrarComo(profileCode: string): void {
  perfilAtual = { user: { profileCode } };
}

function exigenciaDaRota(): {
  environments: Environment[] | null;
  profiles: readonly string[] | null;
} {
  for (const rota of gsRoutes as RouteObject[]) {
    if (rota.path !== CAMINHO) continue;
    const props = (rota.element as ReactElement | undefined)?.props as
      | { environments?: Environment[]; profiles?: readonly string[] }
      | undefined;
    return {
      environments: props?.environments ?? null,
      profiles: props?.profiles ?? null,
    };
  }
  throw new Error(`rota não encontrada no roteador: ${CAMINHO}`);
}

function abrir(): void {
  const exigencia = exigenciaDaRota();
  render(
    <MemoryRouter initialEntries={[CAMINHO]}>
      <Routes>
        <Route
          path={CAMINHO}
          element={
            <Protected
              environments={exigencia.environments ?? undefined}
              profiles={exigencia.profiles ?? undefined}
            >
              <p>CONTEUDO</p>
            </Protected>
          }
        />
        <Route path="/login" element={<p>TELA DE LOGIN</p>} />
        <Route path="/sistema/painel" element={<p>CASA GESTAO</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function caminhosOferecidosPeloMenu(): string[] {
  const { container } = render(
    <MemoryRouter>
      <AppShell>
        <p>PAGINA</p>
      </AppShell>
    </MemoryRouter>,
  );

  for (const botao of Array.from(container.querySelectorAll('nav button'))) {
    fireEvent.click(botao);
  }

  return Array.from(container.querySelectorAll('nav a'))
    .map((a) => a.getAttribute('href') ?? '')
    .filter(Boolean);
}

beforeEach(() => {
  perfilAtual = null;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a porta da conciliação de recebimento', () => {
  it('atendente não vê o item de menu', () => {
    entrarComo('atendente');
    expect(
      caminhosOferecidosPeloMenu(),
      `o menu oferece ${CAMINHO} ao atendente, e o servidor responde 403 em tudo`,
    ).not.toContain(CAMINHO);
  });

  it('atendente não alcança a rota — o guarda o devolve para casa', () => {
    entrarComo('atendente');
    abrir();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
    expect(screen.getByText('CASA GESTAO')).toBeTruthy();
    expect(screen.queryByText('TELA DE LOGIN')).toBeNull();
  });

  for (const perfil of ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista']) {
    it(`${perfil} continua vendo o item e abrindo a rota`, () => {
      entrarComo(perfil);
      expect(caminhosOferecidosPeloMenu(), `o item sumiu do menu de ${perfil}`).toContain(CAMINHO);
      cleanup();
      entrarComo(perfil);
      abrir();
      expect(screen.getByText('CONTEUDO'), `${perfil} perdeu ${CAMINHO}`).toBeTruthy();
    });
  }
});
