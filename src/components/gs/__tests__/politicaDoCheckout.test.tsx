/**
 * "Quem pode comprar" — a decisão do dono, na tela (GAP-PRD-028).
 *
 * O padrão seguro é "só com conta", e a tela diz quando é o padrão que está
 * valendo (ninguém escolheu). Trocar chama o servidor e mostra o que ficou.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PoliticaDoCheckoutCard } from '../PoliticaDoCheckout';

type Chamada = { url: string; method: string; body: unknown };

function servidor(inicial: Record<string, unknown>, aoSalvar?: (corpo: Record<string, unknown>) => Response) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ url: String(url), method, body });
      if (method === 'PUT' && aoSalvar) return aoSalvar(body ?? {});
      return new Response(JSON.stringify(inicial), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('quem pode comprar', () => {
  it('sem escolha do dono, diz que vale o padrão — só com conta', async () => {
    servidor({ mode: 'conta', padrao: 'conta', configurado: false });
    render(<PoliticaDoCheckoutCard />);

    await screen.findByText('Valendo o padrão: só com conta');
    expect((screen.getByRole('radio', { name: /Só com conta/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('abrir para visitante chama o servidor e confirma o que ficou', async () => {
    const chamadas = servidor({ mode: 'conta', padrao: 'conta', configurado: false }, (corpo) =>
      new Response(JSON.stringify({ mode: corpo.mode, padrao: 'conta', configurado: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<PoliticaDoCheckoutCard />);
    await screen.findByText('Valendo o padrão: só com conta');

    fireEvent.click(screen.getByRole('radio', { name: /Também sem conta/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar quem pode comprar' }));

    await screen.findByText(/passa a aceitar também quem compra sem conta/);
    const put = chamadas.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('/core/storefront/checkout-policy');
    expect(put.body).toEqual({ mode: 'visitante' });
  });

  it('a recusa do servidor aparece com a mensagem dele', async () => {
    servidor({ mode: 'conta', padrao: 'conta', configurado: true }, () =>
      new Response(JSON.stringify({ error: { code: 'CORE_FORBIDDEN', message: 'Seu perfil não pode alterar isto.' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<PoliticaDoCheckoutCard />);
    await screen.findByRole('radio', { name: /Também sem conta/ });

    fireEvent.click(screen.getByRole('radio', { name: /Também sem conta/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar quem pode comprar' }));

    await screen.findByText('Seu perfil não pode alterar isto.');
  });
});
