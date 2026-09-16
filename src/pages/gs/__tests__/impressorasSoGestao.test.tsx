/**
 * CONFIGURAÇÕES › IMPRESSORAS — o que a auditoria da Preço Justo achou.
 *
 *   - "Nova impressora", "Editar" e "Tornar padrão" apareciam para quem só
 *     pode VER (estoquista, atendente) e davam 403 ao salvar (C-etiquetas-18);
 *   - a impressora de ETIQUETA podia ser cadastrada "de agente local", e a
 *     página de teste em ESC/POS saía como lixo numa PPLA/ZPL (C-etiquetas-11);
 *   - a tela perguntava pelo PERFIL e o servidor cobra a CAPABILITY
 *     `settings.printers.manage` (P00 das etiquetas): o acesso entregue em
 *     Usuários › Acesso não abria os botões, e a capability tirada de um
 *     gerente não os fechava.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ImpressorasPage from '../ImpressorasPage';
import { setSession } from '@/lib/api/client';

const ETIQUETADORA = {
  id: 'imp-e', name: 'Argox OS-214', kind: 'etiqueta', transport: 'browser', paper_width_mm: null,
  is_default: 0, active: 1, pdv_terminal_id: null, agent_device: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** O acesso de hoje de cada perfil, como o servidor o entrega no login. */
const ACESSO_DE_HOJE: Record<string, string[]> = {
  estoquista: ['settings.printers.view'],
  gerente_loja: ['settings.printers.view', 'settings.printers.manage'],
};

function entrarComo(profileCode: string, capabilities = ACESSO_DE_HOJE[profileCode] ?? []) {
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste de impressoras',
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      if (alvo.includes('/core/print/printers')) return json({ items: [ETIQUETADORA] });
      if (alvo.includes('/core/print/readiness')) return json({ configured: true, readiness: 'BROWSER_ONLY', message: 'Pelo navegador.', printers: [] });
      return json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste de impressoras');
});

function montar() {
  render(
    <MemoryRouter>
      <ImpressorasPage />
    </MemoryRouter>,
  );
}

describe('só quem gere a impressão vê as ações de gestão (C-etiquetas-18)', () => {
  it('o estoquista vê a lista, mas não "Nova impressora", "Editar" nem "Tornar padrão"', async () => {
    entrarComo('estoquista');
    montar();
    await screen.findByText('Argox OS-214');
    expect(screen.queryByRole('button', { name: 'Nova impressora' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tornar padrão' })).toBeNull();
  });

  it('o gerente vê as três', async () => {
    entrarComo('gerente_loja');
    montar();
    await screen.findByText('Argox OS-214');
    expect(screen.getByRole('button', { name: 'Nova impressora' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tornar padrão' })).toBeTruthy();
  });

  /*
    QUEM DECIDE É A CAPABILITY (P00 das etiquetas). O perfil é o mesmo dos dois
    casos abaixo; o que muda é o acesso que o dono entregou em Usuários › Acesso
    — e é ele que as rotas cobram.
  */
  it('o estoquista COM "Impressoras (cadastrar, testar)" vê as ações que o servidor já lhe aceita', async () => {
    entrarComo('estoquista', ['settings.printers.view', 'settings.printers.manage']);
    montar();
    await screen.findByText('Argox OS-214');
    expect(screen.getByRole('button', { name: 'Nova impressora' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tornar padrão' })).toBeTruthy();
  });

  it('o gerente SEM a capability não vê botão que daria 403', async () => {
    entrarComo('gerente_loja', ['settings.printers.view']);
    montar();
    await screen.findByText('Argox OS-214');
    expect(screen.queryByRole('button', { name: 'Nova impressora' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tornar padrão' })).toBeNull();
  });
});

describe('impressora de etiqueta não imprime pelo agente (C-etiquetas-11)', () => {
  it('com a finalidade "Etiqueta", "Como imprime" não oferece o agente local e diz por quê', async () => {
    entrarComo('gerente_loja');
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    const dialogo = screen.getByRole('dialog', { name: 'Nova impressora' });
    const comoImprime = within(dialogo).getByLabelText('Como imprime') as HTMLSelectElement;
    expect(within(comoImprime).queryByRole('option', { name: /Agente local/ })).not.toBeNull();
    fireEvent.change(comoImprime, { target: { value: 'agent' } });
    fireEvent.change(within(dialogo).getByLabelText('Finalidade'), { target: { value: 'etiqueta' } });
    expect(within(comoImprime).queryByRole('option', { name: /Agente local/ })).toBeNull();
    expect(comoImprime.value).toBe('browser');
    expect(within(dialogo).getByText(/sai pelo driver da impressora/)).toBeTruthy();
  });
});
