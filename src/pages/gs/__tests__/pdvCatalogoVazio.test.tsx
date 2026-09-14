/**
 * O BALCÃO SEM PRODUTO NENHUM DIZ ISSO — E MOSTRA O CAMINHO A QUEM PODE.
 *
 * Instalação nova de produção nasce sem produto (o bootstrap não cria). O
 * operador bipava, digitava, e lia "Nenhum produto encontrado" — a frase de
 * quem procurou errado. Procurar de outro jeito não resolve: falta cadastrar.
 *
 * A busca do servidor agora responde `catalogoVazio` quando a operação não tem
 * produto ativo. A tela troca a frase e, para quem gere o catálogo, oferece o
 * cadastro; para o caixa, diz a quem pedir. A busca que só não casou continua
 * com a frase de sempre.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

let catalogoVazio = true;
let buscas: string[] = [];

function servidor() {
  return vi.fn(async (url: string | URL | Request) => {
    const alvo = String(url);
    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      buscas.push(alvo);
      corpo = { items: [], catalogoVazio };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/team') || alvo.includes('/core/units')) {
      // Busca vazia de produto vira busca pela IDENTIDADE da peça
      // (`/core/units?q=`): sem `items` aqui, o guarda do envelope escreveria
      // a própria recusa na faixa do PDV por cima da frase que se quer ler.
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/**
 * O `access` que o servidor devolve no login — só as capabilities que esta tela
 * lê (cadastrar produto no PDV = `products.manage`), como nos modelos de sistema.
 */
const CADASTRA_PRODUTO = new Set(['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista']);
function acessoDoPerfil(perfil: string) {
  return {
    modelo: { code: perfil, name: perfil, personalizado: false },
    capabilities: ['pdv.sell', ...(CADASTRA_PRODUTO.has(perfil) ? ['products.manage'] : [])],
    terminais: 'todos',
    bancadas: 'todas',
    casa: '/pdv',
    carimbo: `c-${perfil}`,
  };
}

function entrarComo(perfil: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: `u-${perfil}`, login: perfil, displayName: perfil, profileCode: perfil },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: perfil }],
      access: acessoDoPerfil(perfil),
    } as never,
    'LOGIN',
    'teste do PDV sem catálogo',
  );
}

beforeEach(() => {
  catalogoVazio = true;
  buscas = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste do PDV sem catálogo');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function buscar(termo: string) {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: termo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() => expect(buscas.length).toBeGreaterThan(0));
}

describe('PDV com o catálogo vazio', () => {
  it('gerente: "Nenhum produto cadastrado" com o caminho para cadastrar', async () => {
    entrarComo('gerente_loja');
    await buscar('camiseta');

    const aviso = await screen.findByTestId('pdv-catalogo-vazio');
    expect(aviso.textContent).toContain('Nenhum produto cadastrado');
    const link = screen.getByRole('link', { name: 'Cadastrar produto' });
    expect(link.getAttribute('href')).toBe('/sistema/produtos/novo');
  });

  it('caixa: a mesma frase, sem a porta que ele não abre — e diz a quem pedir', async () => {
    entrarComo('operador_caixa_loja');
    await buscar('camiseta');

    const aviso = await screen.findByTestId('pdv-catalogo-vazio');
    expect(aviso.textContent).toContain('Nenhum produto cadastrado');
    expect(aviso.textContent).toContain('quem cuida do catálogo');
    expect(screen.queryByRole('link', { name: 'Cadastrar produto' })).toBeNull();
  });

  it('com catálogo, a busca que não casou continua dizendo "Nenhum produto encontrado"', async () => {
    catalogoVazio = false;
    entrarComo('gerente_loja');
    await buscar('naoexiste');

    expect(await screen.findByText(/Nenhum produto encontrado/)).toBeTruthy();
    expect(screen.queryByTestId('pdv-catalogo-vazio')).toBeNull();
  });
});
