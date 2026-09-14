/**
 * ============================================================================
 * A TELA DE EQUIPE OFERECE SÓ O QUE O SERVIDOR ACEITA — GAP-PRD-010 e 152
 * ============================================================================
 *
 * A tela oferecia Editar, Resetar senha e Desativar para qualquer pessoa da
 * lista — inclusive o administrador do sistema e o gestor do grupo, que o
 * gerente de loja não pode tocar. E "Desativar" não dizia que corta a pessoa
 * em TODAS as operações dela.
 *
 * O servidor passou a mandar, em cada pessoa, `acoes` — calculado pelas mesmas
 * funções que recusam. Estes casos cobram que a tela obedeça:
 *
 *  - conta de dono: nenhum botão, e a frase dizendo por quê;
 *  - conta que entra em outra operação: Editar sim, senha e Desativar não, e
 *    "Remover desta operação" aparece e chama a rota do vínculo;
 *  - Desativar pede confirmação e diz o alcance;
 *  - login repetido no cadastro oferece "dar acesso a esta conta", que chama
 *    `/core/team/link` sem mandar senha nenhuma.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import EquipePage from '../EquipePage';

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function membro(
  id: string,
  displayName: string,
  profileCode: string,
  acoes: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    login: displayName.toUpperCase().replace(/\s+/g, '.'),
    displayName,
    email: null,
    profileCode,
    active: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    workshops: [],
    acoes,
    ...extra,
  };
}

const LIVRE = { gerirNaOperacao: true, gerirConta: true, removerDaOperacao: false, outrasOperacoes: 0, motivo: null };

const EQUIPE = [
  membro('u-admin', 'Administrador', 'admin_geral', {
    gerirNaOperacao: false,
    gerirConta: false,
    removerDaOperacao: false,
    outrasOperacoes: 5,
    motivo: 'Esta conta tem o perfil "admin_geral", e só quem responde pelo grupo mexe nela.',
  }),
  membro('u-mec', 'Técnico Duplo', 'mecanico', {
    gerirNaOperacao: true,
    gerirConta: false,
    removerDaOperacao: true,
    outrasOperacoes: 1,
    motivo: 'Esta conta também entra em 1 outra(s) operação(ões) do grupo…',
  }),
  membro('u-atd', 'Atendente Simples', 'atendente', LIVRE),
];

interface Chamada {
  metodo: string;
  caminho: string;
  corpo: unknown;
}
let chamadas: Chamada[] = [];

function responder(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(opcoes: { criacao?: { status: number; body: unknown } } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const caminho = new URL(url).pathname.replace(/^\/api\/v1/, '');
      chamadas.push({ metodo, caminho, corpo: init?.body ? JSON.parse(init.body) : null });

      if (metodo === 'GET' && caminho === '/core/team') return responder(200, { items: EQUIPE });
      if (metodo === 'GET' && caminho === '/core/team/profiles') {
        return responder(200, { items: ['mecanico', 'atendente', 'estoquista'] });
      }
      if (metodo === 'GET' && caminho === '/core/workshops') return responder(200, { items: [] });
      if (metodo === 'POST' && caminho === '/core/team') {
        const r = opcoes.criacao ?? { status: 201, body: EQUIPE[2] };
        return responder(r.status, r.body);
      }
      if (metodo === 'POST' && caminho === '/core/team/link') return responder(201, EQUIPE[2]);
      if (metodo === 'POST' && caminho.endsWith('/remove-from-company')) {
        return responder(200, { id: 'u-mec', removedFromCompany: true, outrasOperacoes: 1 });
      }
      if (metodo === 'POST' && caminho.endsWith('/active')) return responder(200, EQUIPE[2]);
      return responder(404, { error: { code: 'NAO_DUBLADO', message: caminho } });
    }),
  );
}

async function montar() {
  render(
    <MemoryRouter>
      <EquipePage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Administrador')).toBeTruthy());
}

/** A linha da tabela onde a pessoa aparece. */
function linhaDe(nome: string): HTMLElement {
  const celula = screen.getByText(nome);
  const linha = celula.closest('tr');
  if (!linha) throw new Error(`linha de ${nome} não encontrada`);
  return linha as HTMLElement;
}

beforeEach(() => {
  chamadas = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('conta de dono — a tela não oferece mexer', () => {
  it('nenhum botão na linha do admin_geral, e a frase diz por quê', async () => {
    servidor();
    await montar();
    const linha = within(linhaDe('Administrador'));

    expect(linha.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(linha.queryByRole('button', { name: 'Resetar senha' })).toBeNull();
    expect(linha.queryByRole('button', { name: 'Desativar' })).toBeNull();
    expect(linha.queryByRole('button', { name: 'Remover desta operação' })).toBeNull();
    expect(linha.getByText(/só outro dono do grupo altera/)).toBeTruthy();
  });

  it('a pessoa comum continua com os três botões de sempre', async () => {
    servidor();
    await montar();
    const linha = within(linhaDe('Atendente Simples'));

    expect(linha.getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(linha.getByRole('button', { name: 'Resetar senha' })).toBeTruthy();
    expect(linha.getByRole('button', { name: 'Desativar' })).toBeTruthy();
    expect(linha.queryByRole('button', { name: 'Remover desta operação' })).toBeNull();
  });
});

describe('conta que entra em outra operação', () => {
  it('Editar sim; senha e Desativar não; e diz que ela entra em outra operação', async () => {
    servidor();
    await montar();
    const linha = within(linhaDe('Técnico Duplo'));

    expect(linha.getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(linha.queryByRole('button', { name: 'Resetar senha' })).toBeNull();
    expect(linha.queryByRole('button', { name: 'Desativar' })).toBeNull();
    expect(linha.getByText(/também entra em 1 outra operação do grupo/)).toBeTruthy();
  });

  it('no Editar, nome e e-mail vêm travados — são da conta, não do vínculo', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Técnico Duplo')).getByRole('button', { name: 'Editar' }));

    expect((screen.getByLabelText(/^Nome(?! ou)/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^E-mail/) as HTMLInputElement).disabled).toBe(true);
  });

  it('"Remover desta operação" confirma, diz que o resto continua, e chama a rota do vínculo', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Técnico Duplo')).getByRole('button', { name: 'Remover desta operação' }));

    const bloco = screen.getByRole('group', { name: /Remover Técnico Duplo desta operação/ });
    expect(bloco.textContent).toContain('O acesso à outra operação continua');
    expect(chamadas.some((c) => c.caminho.endsWith('/remove-from-company'))).toBe(false);

    fireEvent.click(within(bloco).getByRole('button', { name: 'Confirmar remoção' }));
    await waitFor(() =>
      expect(
        chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/core/team/u-mec/remove-from-company'),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('removido desta operação'));
  });
});

describe('Desativar diz o alcance antes de cortar', () => {
  it('pede confirmação, e só então chama a rota', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Atendente Simples')).getByRole('button', { name: 'Desativar' }));

    const bloco = screen.getByRole('group', { name: /Desativar Atendente Simples/ });
    expect(bloco.textContent).toContain('Desativar corta o acesso de Atendente Simples a esta operação');
    expect(chamadas.some((c) => c.caminho.endsWith('/active'))).toBe(false);

    fireEvent.click(within(bloco).getByRole('button', { name: 'Confirmar desativação' }));
    await waitFor(() => {
      const chamada = chamadas.find((c) => c.caminho === '/core/team/u-atd/active');
      expect(chamada?.corpo).toEqual({ active: false });
    });
  });
});

describe('login repetido no cadastro', () => {
  it('oferece dar acesso à conta existente, pelo login, sem mandar senha', async () => {
    servidor({
      criacao: {
        status: 409,
        body: { error: { code: 'CORE_LOGIN_TAKEN', message: 'Já existe um usuário com este login.' } },
      },
    });
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar pessoa' }));
    fireEvent.change(screen.getByLabelText(/^Nome(?! ou)/), { target: { value: 'Pessoa da Gringa' } });
    fireEvent.change(screen.getByLabelText(/^Login/), { target: { value: 'pessoa.gringa' } });
    fireEvent.change(screen.getByLabelText(/Perfil/), { target: { value: 'atendente' } });
    fireEvent.change(screen.getByLabelText(/Senha provisória/), { target: { value: 'Provisoria@2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));

    const oferta = await screen.findByRole('button', { name: 'Dar acesso a esta conta nesta operação' });
    fireEvent.click(oferta);

    await waitFor(() => {
      const chamada = chamadas.find((c) => c.caminho === '/core/team/link');
      expect(chamada?.corpo).toEqual({ login: 'pessoa.gringa', profileCode: 'atendente', workshopIds: [] });
    });
    const enviada = chamadas.find((c) => c.caminho === '/core/team/link');
    expect(JSON.stringify(enviada?.corpo)).not.toContain('Provisoria@2026');
  });
});
