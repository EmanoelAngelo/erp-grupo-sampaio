/**
 * CONFIGURAÇÕES › CAIXAS E TERMINAIS (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150).
 *
 * O cadastro de caixas não tinha tela (nem escritor), e o token de dispositivo
 * só se criava com `curl`. Os casos olham o FIO — o corpo que sai para o
 * servidor — e a recusa dele mostrada como veio:
 *
 *  - o gerente cadastra, vê a gaveta aberta de cada caixa (e a de outro dia),
 *    e desativa com motivo; a recusa "gaveta aberta" aparece;
 *  - o gerente NÃO vê o formulário do token (a rota é só do dono do grupo), e
 *    sim a explicação;
 *  - o dono registra o computador, vê o código UMA vez, guarda neste
 *    computador — e a tela de login passa a oferecer "Entrar no PDV deste
 *    terminal" (a mesma chave do `localStorage`);
 *  - revogar leva o motivo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TerminaisPage from '../TerminaisPage';
import LoginPage from '../LoginPage';
import { setSession } from '@/lib/api/client';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessao(profileCode: string) {
  // Pelo `setSession`, e não pelo localStorage: a sessão fica em memória depois
  // da primeira leitura, e o perfil do caso anterior vazaria para o seguinte.
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'quem', displayName: 'Quem', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste de caixas e terminais',
  );
}

const CX1 = {
  id: 'cx1',
  code: 'preco-justo-cx1',
  name: 'Caixa 1',
  active: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  createdBy: 'u1',
  updatedAt: null,
  deactivatedAt: null,
  deactivatedBy: null,
  deactivationReason: null,
  caixaAberto: {
    sessionId: 's-velha',
    openedAt: '2026-08-12T21:51:00.000Z',
    openedByName: 'preco-justo.pdv',
    deOutroDia: { abertaNoDia: '2026-08-12', hoje: '2026-09-11', dias: 30 },
  },
  tokensAtivos: 1,
};

let caixas: Record<string, unknown>[];
let chamadas: { metodo: string; url: string; corpo: unknown }[];
let recusaDesativar: boolean;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? JSON.parse(init.body) : null;
    chamadas.push({ metodo, url: u, corpo });

    if (u.endsWith('/core/terminals') && metodo === 'GET') return json({ items: caixas });
    if (u.endsWith('/core/terminals') && metodo === 'POST') {
      const novo = { ...CX1, id: 'cx2', code: 'preco-justo-cx2', name: corpo.name, caixaAberto: null, tokensAtivos: 0 };
      caixas = [...caixas, novo];
      return json(novo, 201);
    }
    if (u.includes('/deactivate')) {
      if (recusaDesativar) {
        return json(
          {
            error: {
              code: 'CORE_TERMINAL_HAS_OPEN_CASH',
              message: 'O caixa "Caixa 1" está com a gaveta aberta. Feche o turno em Vendas › Caixa antes de desativá-lo.',
            },
          },
          409,
        );
      }
      return json({ ...CX1, active: false, caixaAberto: null });
    }
    if (u.includes('/auth/devices')) {
      return json({
        items: [
          {
            id: 'tok-1',
            label: 'micro do balcão 1',
            userId: 'op1',
            userLogin: 'pj.caixa1',
            userDisplayName: 'Ana',
            terminalId: 'cx1',
            terminalName: 'Caixa 1',
            terminalActive: true,
            revoked: false,
            createdAt: '2026-09-01T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
          },
        ],
      });
    }
    if (u.includes('/auth/device/enroll')) {
      return json({ id: 'tok-2', deviceToken: 'TOKEN-OPACO-123', label: corpo.label, terminalId: corpo.terminalId }, 201);
    }
    if (u.includes('/revoke')) return json({ id: 'tok-1', revoked: true });
    if (u.includes('/core/team')) {
      return json({
        items: [
          { id: 'op1', login: 'pj.caixa1', displayName: 'Ana', profileCode: 'operador_caixa_loja', active: true },
          { id: 'g1', login: 'pj.gerente', displayName: 'Gil', profileCode: 'gerente_loja', active: true },
        ],
      });
    }
    return json({ items: [] });
  });
}

function montar() {
  render(
    <MemoryRouter>
      <TerminaisPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  caixas = [CX1];
  chamadas = [];
  recusaDesativar = false;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o gerente cuida dos caixas da operação', () => {
  it('lista com a gaveta aberta de outro dia, e cadastra um caixa pelo nome', async () => {
    sessao('gerente_loja');
    montar();

    expect(await screen.findByText('preco-justo-cx1')).toBeTruthy();
    expect(screen.getByText(/De outro dia — desde 12\/08\/2026/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Nome do caixa'), { target: { value: 'Caixa 2 — balcão' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar caixa' }));

    await waitFor(() =>
      expect(chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/core/terminals'))?.corpo).toEqual({
        name: 'Caixa 2 — balcão',
      }),
    );
    expect(await screen.findByText(/Caixa "Caixa 2 — balcão" cadastrado/)).toBeTruthy();
  });

  it('desativar pede motivo — e a recusa de gaveta aberta aparece como veio', async () => {
    sessao('gerente_loja');
    recusaDesativar = true;
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Desativar' }));
    const dialogo = await screen.findByRole('dialog', { name: /Desativar — Caixa 1/ });
    const botao = within(dialogo).getByRole('button', { name: 'Desativar' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);

    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'computador no conserto' } });
    fireEvent.click(botao);

    expect(await within(dialogo).findByText(/está com a gaveta aberta/)).toBeTruthy();
    const pedido = chamadas.find((c) => c.url.includes('/deactivate'));
    expect(pedido?.corpo).toEqual({ reason: 'computador no conserto' });
  });

  it('o gerente vê a explicação do acesso sem senha, e não um formulário que levaria 403', async () => {
    sessao('gerente_loja');
    montar();
    await screen.findByText('preco-justo-cx1');
    expect(screen.getByText(/feito por quem responde pelo grupo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Registrar computador' })).toBeNull();
    expect(chamadas.some((c) => c.url.includes('/auth/devices'))).toBe(false);
  });
});

describe('o dono registra o computador do caixa (token de dispositivo)', () => {
  it('registra no Caixa 1, mostra o código uma vez, guarda neste computador — e o login oferece a entrada sem senha', async () => {
    sessao('gestor');
    montar();

    expect(await screen.findByText('micro do balcão 1')).toBeTruthy();
    // Só usuário de CAIXA é oferecido: token de gerente seria gestão sem senha no balcão.
    const usuario = (await screen.findByLabelText('Usuário do caixa')) as HTMLSelectElement;
    await waitFor(() => expect(usuario.options.length).toBe(2));
    expect([...usuario.options].map((o) => o.textContent)).not.toContain('Gil (pj.gerente)');

    fireEvent.change(usuario, { target: { value: 'op1' } });
    fireEvent.change(screen.getByLabelText('Caixa do computador'), { target: { value: 'cx1' } });
    fireEvent.change(screen.getByLabelText('Nome do computador'), { target: { value: 'micro do balcão 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar computador' }));

    const aviso = await screen.findByTestId('token-novo');
    expect(aviso.textContent).toContain('TOKEN-OPACO-123');
    expect(chamadas.find((c) => c.url.includes('/auth/device/enroll'))?.corpo).toEqual({
      userId: 'op1',
      label: 'micro do balcão 2',
      terminalId: 'cx1',
    });

    fireEvent.click(within(aviso).getByRole('button', { name: 'Guardar neste computador' }));
    expect(localStorage.getItem('gs.deviceToken')).toBe('TOKEN-OPACO-123');

    // A mesma chave que a tela de login lê: a entrada sem senha aparece.
    cleanup();
    setSession(null, 'LOGOUT', 'o dono saiu para o caixa entrar');
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('tab', { name: /^PDV/ }));
    expect(await screen.findByRole('button', { name: /Entrar no PDV deste terminal/ })).toBeTruthy();
  });

  it('revogar leva o motivo ao servidor', async () => {
    sessao('gestor');
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
    const dialogo = await screen.findByRole('dialog', { name: /Revogar — micro do balcão 1/ });
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'computador trocado' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Revogar' }));

    await waitFor(() =>
      expect(chamadas.find((c) => c.url.includes('/auth/device/tok-1/revoke'))?.corpo).toEqual({
        reason: 'computador trocado',
      }),
    );
  });
});
