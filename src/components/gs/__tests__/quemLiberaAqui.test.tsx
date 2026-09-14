/**
 * O CARTÃO "QUEM LIBERA NESTA OPERAÇÃO" — GAP-PRD-054.
 *
 * O organograma que a alçada pressupõe, dito na tela onde ele se decide: sem
 * gerente com alçada na operação, o cartão diz de quem toda liberação depende e
 * como resolver; com gerente, diz quem libera. Leitura que falha não vira
 * bloqueio: o cartão some.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QuemLiberaAqui } from '../QuemLiberaAqui';

function servidor(status: number, corpo: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(corpo), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

const ACOES = ['desconto_acima_limite', 'sangria_especial', 'cancelar_venda', 'devolver_venda', 'reabrir_caixa'];

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('quem libera nesta operação', () => {
  it('só os donos do grupo: aviso nomeado, com as ações e o caminho', async () => {
    servidor(200, {
      daOperacao: [],
      doGrupo: [
        { nome: 'ADMIN', perfil: 'admin_geral' },
        { nome: 'CARLOS', perfil: 'gestor' },
      ],
      semAlcadaNaOperacao: true,
      acoes: ACOES,
    });
    render(<QuemLiberaAqui />);
    const aviso = await screen.findByTestId('alcada-sem-gerente');
    expect(aviso.textContent).toMatch(/Nenhum gerente desta operação tem alçada/);
    expect(aviso.textContent).toMatch(/ADMIN \(administrador do sistema\), CARLOS \(gestor do grupo\)/);
    expect(aviso.textContent).toMatch(/desconto acima da política/);
    expect(aviso.textContent).toMatch(/cadastre um Gerente de loja ou Gerente de oficina/);
  });

  it('com gerente da operação: diz quem libera, sem aviso', async () => {
    servidor(200, {
      daOperacao: [{ nome: 'Ana', perfil: 'gerente_loja' }],
      doGrupo: [{ nome: 'CARLOS', perfil: 'gestor' }],
      semAlcadaNaOperacao: false,
      acoes: ACOES,
    });
    render(<QuemLiberaAqui />);
    const presente = await screen.findByTestId('alcada-presente');
    expect(presente.textContent).toMatch(/Ana \(gerente da loja\)/);
    expect(screen.queryByTestId('alcada-sem-gerente')).toBeNull();
  });

  it('leitura recusada (403): o cartão não aparece — é aviso, não bloqueio', async () => {
    servidor(403, { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } });
    const { container } = render(<QuemLiberaAqui />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });
});
