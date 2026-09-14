/**
 * ============================================================================
 * O ACESSO GRANULAR NA TELA — a URL direta respeita as páginas liberadas
 * ============================================================================
 *
 * Quem teve o acesso montado na tela de Usuários (os atalhos Somente PDV,
 * PDV + Painel, Estoque, ou um vínculo personalizado) tem a tela decidida pelas
 * CAPABILITIES que o servidor devolve em `access`. A URL digitada de uma página
 * não liberada mostra "Acesso negado" — não a tela vazia com 403 em cada
 * chamada, nem um redirecionamento mudo. Quem autoriza continua sendo o
 * servidor (tests/rbac/cenarios-da-entrega.test.ts); aqui se prova que a tela
 * reflete.
 *
 * Os perfis de hoje, com o modelo puro, não mudam: seguem o guarda por
 * ambiente e perfil de sempre.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Protected } from '../Protected';
import { ROTA_GESTAO, ROTA_PDV, type Environment } from '../environments';
import { setSession, type StoredSession } from '@/lib/api/client';
import { acessoPersonalizado, casaDaSessao, telaAbre } from '@/lib/acesso/acesso';

const SOMENTE_PDV = ['customers.contact.view', 'fiscal.sale.emit', 'pdv.cash.operate', 'pdv.payment.charge', 'pdv.sell'];
const ESTOQUE = ['inventory.adjust.approve', 'inventory.manage', 'inventory.units.manage', 'inventory.units.view', 'inventory.view'];
const GERENTE_SEM_FISCAL = ['dashboard.view', 'inventory.view', 'pdv.sell', 'products.view', 'sales.view'];

function sessaoDe(
  profileCode: string,
  capabilities: string[],
  opcoes: { personalizado?: boolean; casa?: string } = {},
): StoredSession {
  return {
    accessToken: 'sem-escopo',
    refreshToken: 'r-1',
    expiresAt: Date.now() + 3_600_000,
    user: { id: 'u-1', login: 'PESSOA', displayName: 'Pessoa', profileCode },
    company: { id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
    companies: [{ id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode }],
    access: {
      modelo: { code: profileCode, name: profileCode, personalizado: opcoes.personalizado ?? false },
      capabilities,
      terminais: 'todos',
      bancadas: 'todas',
      casa: opcoes.casa ?? '/pdv',
      carimbo: `c-${profileCode}`,
    },
  } as StoredSession;
}

function abrir(rota: string, environments: Environment[]) {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route
          path={rota}
          element={
            <Protected environments={environments}>
              <p>CONTEUDO</p>
            </Protected>
          }
        />
        <Route path="/login" element={<p>PORTA</p>} />
        <Route path="*" element={<p>OUTRA ROTA</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const negou = () => screen.queryByRole('heading', { name: /acesso negado/i }) !== null;
const abriu = () => screen.queryByText('CONTEUDO') !== null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })),
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste do acesso granular');
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a URL direta de quem tem acesso granular', () => {
  it('Somente PDV: o PDV abre; Painel, Estoque e Fiscal mostram "Acesso negado"', () => {
    setSession(sessaoDe('somente_pdv', SOMENTE_PDV), 'LOGIN', 'teste: somente PDV');
    abrir('/pdv', ROTA_PDV);
    expect(abriu()).toBe(true);
    cleanup();
    for (const rota of ['/sistema/painel', '/sistema/estoque', '/sistema/fiscal/configuracao']) {
      abrir(rota, ROTA_GESTAO);
      expect({ rota, negou: negou(), abriu: abriu() }).toEqual({ rota, negou: true, abriu: false });
      cleanup();
    }
  });

  it('Estoque: o Estoque abre; PDV e Painel mostram "Acesso negado"', () => {
    setSession(sessaoDe('estoque', ESTOQUE, { casa: '/sistema/estoque' }), 'LOGIN', 'teste: estoque');
    abrir('/sistema/estoque', ROTA_GESTAO);
    expect(abriu()).toBe(true);
    cleanup();
    abrir('/pdv', ROTA_PDV);
    expect(negou()).toBe(true);
    cleanup();
    abrir('/sistema/painel', ROTA_GESTAO);
    expect(negou()).toBe(true);
  });

  it('gerente de loja PERSONALIZADO sem Fiscal: o Painel abre, o Fiscal mostra "Acesso negado"', () => {
    setSession(
      sessaoDe('gerente_loja', GERENTE_SEM_FISCAL, { personalizado: true, casa: '/sistema/painel' }),
      'LOGIN',
      'teste: gerente sem fiscal',
    );
    abrir('/sistema/painel', ROTA_GESTAO);
    expect(abriu()).toBe(true);
    cleanup();
    abrir('/sistema/fiscal/configuracao', ROTA_GESTAO);
    expect(negou()).toBe(true);
  });

  it('o gerente de loja com o modelo puro segue o guarda de sempre', () => {
    setSession(sessaoDe('gerente_loja', GERENTE_SEM_FISCAL), 'LOGIN', 'teste: gerente puro');
    abrir('/sistema/fiscal/configuracao', ROTA_GESTAO);
    // O guarda de hoje (ambiente + perfil) abre; a capability não é consultada.
    expect(abriu()).toBe(true);
  });
});

describe('a casa e a leitura da tabela de telas', () => {
  it('a casa do acesso granular é a do servidor; a do perfil de hoje, a de sempre', () => {
    expect(casaDaSessao(sessaoDe('estoque', ESTOQUE, { casa: '/sistema/estoque' }))).toBe('/sistema/estoque');
    expect(casaDaSessao(sessaoDe('somente_pdv', [], { casa: '/sem-acesso' }))).toBe('/sem-acesso');
    expect(acessoPersonalizado(sessaoDe('gerente_loja', GERENTE_SEM_FISCAL))).toBe(false);
    expect(acessoPersonalizado(sessaoDe('gerente_loja', GERENTE_SEM_FISCAL, { personalizado: true }))).toBe(true);
    expect(acessoPersonalizado(sessaoDe('pdv_painel', SOMENTE_PDV))).toBe(true);
  });

  it('a tela com parâmetro casa pelo padrão, e tela fora da tabela não é decidida aqui', () => {
    expect(telaAbre(['inventory.view'], '/sistema/estoque')).toBe(true);
    expect(telaAbre(['pdv.sell'], '/sistema/estoque')).toBe(false);
    expect(telaAbre(['fiscal.sale.emit'], '/sistema/fiscal/documentos')).toBe(true);
    expect(telaAbre(['pdv.sell'], '/uma/tela/que/nao/existe')).toBeNull();
  });
});
