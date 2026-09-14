/**
 * ATALHOS DE SANGRIA E SUPRIMENTO — a gaveta a uma tecla do balcão.
 *
 * F3 abria o caixa genérico; sangria e suprimento ficavam a dois cliques e uma
 * leitura de diálogo de distância. Os atalhos novos abrem o MESMO diálogo já
 * apontando a ação — com o campo de valor focado e a ação nomeada na tela,
 * para não ser decorativo:
 *
 *   Ctrl+F3  → caixa direto na SANGRIA
 *   Shift+F3 → caixa direto no SUPRIMENTO
 *
 * E a ajuda ('?') os lista — atalho que só existe na cabeça de quem programou
 * não é atalho, é segredo.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    let corpo: unknown = {};
    if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: 80000 };
    } else if (alvo.includes('/core/cash/') && alvo.includes('/summary')) {
      corpo = { session: CAIXA_ABERTO, expectedCents: 20000, byMethod: [], changeCents: 0, movements: [] };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/sellers')) {
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

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
  // Espera a consulta do caixa aterrissar, senão o teste digita antes da tela.
  await screen.findByText(/Caixa aberto/);
}

describe('os atalhos abrem o caixa já na ação', () => {
  it('Ctrl+F3 abre o diálogo do caixa apontando a SANGRIA', async () => {
    await montar();
    fireEvent.keyDown(window, { key: 'F3', ctrlKey: true });

    await screen.findByTestId('caixa-pdv');
    const aviso = await screen.findByTestId('caixa-acao-do-atalho');
    expect(aviso.textContent).toMatch(/sangria/i);
  });

  it('Shift+F3 abre o diálogo do caixa apontando o SUPRIMENTO', async () => {
    await montar();
    fireEvent.keyDown(window, { key: 'F3', shiftKey: true });

    await screen.findByTestId('caixa-pdv');
    const aviso = await screen.findByTestId('caixa-acao-do-atalho');
    expect(aviso.textContent).toMatch(/suprimento/i);
  });

  it('F3 puro continua abrindo o caixa SEM apontar ação nenhuma', async () => {
    await montar();
    fireEvent.keyDown(window, { key: 'F3' });

    await screen.findByTestId('caixa-pdv');
    expect(screen.queryByTestId('caixa-acao-do-atalho')).toBeNull();
  });
});

describe('a ajuda declara o que o teclado faz', () => {
  it('a lista do "?" ensina Ctrl+F3 e Shift+F3', async () => {
    await montar();
    fireEvent.click(screen.getByRole('button', { name: /Ajuda/ }));

    const ajuda = await screen.findByText(/apertar as seguintes teclas/);
    const painel = ajuda.closest('div')!.parentElement!;
    expect(painel.textContent).toContain('Ctrl+F3');
    expect(painel.textContent).toContain('Shift+F3');
    expect(painel.textContent).toMatch(/sangria/i);
    expect(painel.textContent).toMatch(/suprimento/i);
  });
});
