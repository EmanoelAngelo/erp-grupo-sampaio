/**
 * A ESCOLHA DO DONO NA TELA DE EQUIPE — GAP-PRD-160.
 *
 * Só o dono vê o cartão (é quem o servidor aceita no PUT); ligar e desligar
 * chamam a rota; sem SMTP, o cartão avisa que o código fica na fila.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

let perfil = 'gestor';

vi.mock('@/hooks/useSession', async (original) => ({
  ...(await original<typeof import('@/hooks/useSession')>()),
  useProfile: () => perfil,
  useHasProfile: (...allowed: string[]) =>
    perfil === 'admin_geral' || perfil === 'gestor' || allowed.includes(perfil),
}));

const { RecuperacaoDeSenhaDaOperacao } = await import('../RecuperacaoDeSenhaDaOperacao');

let ligado = false;
const puts: unknown[] = [];

function servidor(carteiroPronto: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
        const corpo = JSON.parse(init!.body!);
        puts.push(corpo);
        ligado = corpo.emailLigado;
      }
      return new Response(
        JSON.stringify({
          emailLigado: ligado,
          atualizadoEm: null,
          atualizadoPor: null,
          carteiroPronto,
          faltaNoCarteiro: carteiroPronto ? [] : ['EMAIL_SMTP_HOST'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

beforeEach(() => {
  ligado = false;
  puts.length = 0;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a escolha do dono', () => {
  it('desligada por padrão; Ligar manda emailLigado: true e o selo muda', async () => {
    perfil = 'gestor';
    servidor(true);
    render(<RecuperacaoDeSenhaDaOperacao />);
    expect(await screen.findByText('DESLIGADA — SÓ A GESTÃO REDEFINE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ligar' }));
    expect(await screen.findByText('LIGADA NESTA OPERAÇÃO')).toBeTruthy();
    expect(puts).toEqual([{ emailLigado: true }]);
    expect(screen.queryByTestId('recuperacao-sem-smtp')).toBeNull();
  });

  it('sem SMTP, o cartão diz o que falta e o que isso significa', async () => {
    perfil = 'admin_geral';
    servidor(false);
    render(<RecuperacaoDeSenhaDaOperacao />);
    const aviso = await screen.findByTestId('recuperacao-sem-smtp');
    expect(aviso.textContent).toMatch(/EMAIL_SMTP_HOST/);
    expect(aviso.textContent).toMatch(/não oferece o caminho/);
  });

  it('o gerente da loja não vê o cartão (o servidor lhe recusa o PUT)', async () => {
    perfil = 'gerente_loja';
    servidor(true);
    const { container } = render(<RecuperacaoDeSenhaDaOperacao />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });
});
