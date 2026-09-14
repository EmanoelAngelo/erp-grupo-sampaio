/**
 * ============================================================================
 * A TELA DE EQUIPE DIZ QUANDO O CORTE VALE — NA HORA (GAP-PRD-053)
 * ============================================================================
 *
 * O servidor passou a conferir a conta a cada requisição: desativar, redefinir
 * a senha e remover da operação derrubam a sessão aberta na requisição
 * seguinte, e o perfil novo vale na próxima ação. A ficha registrava que a
 * tela não dizia nada disso ao gestor ("cai em até uma hora", sem aviso).
 *
 * Estes casos cobram que a tela diga o QUANDO, com a verdade de agora.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import EquipePage from '../EquipePage';

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const LIVRE = { gerirNaOperacao: true, gerirConta: true, removerDaOperacao: false, outrasOperacoes: 0, motivo: null };

const ATENDENTE = {
  id: 'u-atd',
  login: 'ATENDENTE.SIMPLES',
  displayName: 'Atendente Simples',
  email: null,
  profileCode: 'atendente',
  active: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  workshops: [],
  acoes: LIVRE,
};

const DUPLO = {
  ...ATENDENTE,
  id: 'u-mec',
  login: 'TECNICO.DUPLO',
  displayName: 'Técnico Duplo',
  profileCode: 'estoquista',
  acoes: { ...LIVRE, gerirConta: false, removerDaOperacao: true, outrasOperacoes: 1 },
};

function responder(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const caminho = new URL(url).pathname.replace(/^\/api\/v1/, '');
      if (metodo === 'GET' && caminho === '/core/team') return responder(200, { items: [ATENDENTE, DUPLO] });
      if (metodo === 'GET' && caminho === '/core/team/profiles') {
        return responder(200, { items: ['atendente', 'estoquista', 'gerente_loja'] });
      }
      if (metodo === 'GET' && caminho === '/core/workshops') return responder(200, { items: [] });
      if (metodo === 'POST' && caminho.endsWith('/active')) return responder(200, { ...ATENDENTE, active: false });
      if (metodo === 'POST' && caminho.endsWith('/password')) return responder(200, ATENDENTE);
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
  await waitFor(() => expect(screen.getByText('Atendente Simples')).toBeTruthy());
}

function linhaDe(nome: string): HTMLElement {
  const linha = screen.getByText(nome).closest('tr');
  if (!linha) throw new Error(`linha de ${nome} não encontrada`);
  return linha as HTMLElement;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o gestor lê QUANDO o corte vale', () => {
  it('Desativar avisa que a sessão aberta cai na hora — e confirma depois de feito', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Atendente Simples')).getByRole('button', { name: 'Desativar' }));

    const bloco = screen.getByRole('group', { name: /Desativar Atendente Simples/ });
    expect(bloco.textContent).toContain('A sessão que estiver aberta cai na hora, em qualquer aparelho.');
    // A frase antiga do sistema — "em até uma hora" — não pode aparecer.
    expect(bloco.textContent).not.toMatch(/uma hora/);

    fireEvent.click(within(bloco).getByRole('button', { name: 'Confirmar desativação' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('caiu na hora'));
  });

  it('Resetar senha diz que as sessões abertas caíram', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Atendente Simples')).getByRole('button', { name: 'Resetar senha' }));
    fireEvent.change(screen.getByLabelText('Senha provisória de Atendente Simples'), {
      target: { value: 'Provisoria@2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('caíram na hora'));
  });

  it('Remover desta operação diz que a sessão daqui cai na hora', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Técnico Duplo')).getByRole('button', { name: 'Remover desta operação' }));
    const bloco = screen.getByRole('group', { name: /Remover Técnico Duplo desta operação/ });
    expect(bloco.textContent).toContain('A sessão aberta nesta operação cai na hora.');
  });

  it('no Editar, o perfil avisa que o novo vale já na próxima ação', async () => {
    servidor();
    await montar();
    fireEvent.click(within(linhaDe('Atendente Simples')).getByRole('button', { name: 'Editar' }));
    expect(screen.getByText(/O perfil novo vale já na próxima ação da pessoa/)).toBeTruthy();
  });
});
