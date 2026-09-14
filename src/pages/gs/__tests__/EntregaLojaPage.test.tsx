/**
 * A tela onde o dono decide se a loja entrega.
 *
 * O que ela não pode errar:
 *
 * 1. Campo VAZIO não é zero. Vazio é "não configurado"; zero, em frete grátis
 *    acima de X, seria "grátis sempre". Mandar zero no lugar de nulo daria
 *    frete grátis para a loja inteira sem ninguém ter pedido.
 *
 * 2. A recusa do servidor aparece. Ligar entrega sem valor é 400, e se a tela
 *    engolisse isso o gestor sairia achando que ligou.
 *
 * 3. A tela diz o estado ATUAL em palavras, não só nos campos: "não entrega
 *    pelo site" é a informação que evita o dono esperar pedidos que não vêm.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EntregaLojaPage from '../EntregaLojaPage';

const PADRAO = {
  pickupEnabled: true,
  deliveryEnabled: false,
  flatRateCents: null,
  freeAboveCents: null,
  estimatedDays: null,
};

/** Servidor de mentira que registra o PUT para o teste conferir o corpo. */
function servidor(resposta: (corpo: unknown) => { status?: number; body: unknown }) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo === 'GET') {
        return new Response(JSON.stringify(PADRAO), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const corpo = init?.body ? JSON.parse(init.body) : null;
      puts.push(corpo);
      const r = resposta(corpo);
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return puts;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('estado atual', () => {
  it('diz em palavras que a loja não entrega', async () => {
    servidor(() => ({ body: PADRAO }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    // Sem esta frase o dono espera pedidos de entrega que nunca chegam.
    await screen.findByText(/não entrega pelo site/);
  });

  it('os campos da tabela ficam desabilitados enquanto a entrega está desligada', async () => {
    servidor(() => ({ body: PADRAO }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    const frete = (await screen.findByLabelText('Frete')) as HTMLInputElement;
    // O bloqueio vem do <fieldset disabled>, que desabilita os descendentes
    // sem marcar o atributo em cada um — por isso a conferência é no grupo.
    expect(frete.closest('fieldset')?.disabled).toBe(true);
  });
});

describe('salvar', () => {
  it('campo vazio vira null, NUNCA zero', async () => {
    const puts = servidor(() => ({ body: { ...PADRAO, deliveryEnabled: true, flatRateCents: 1990 } }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText(/Entregar pelo site/));
    fireEvent.change(screen.getByLabelText('Frete'), { target: { value: '19,90' } });
    // "Frete grátis acima de" e "Prazo" ficam vazios de propósito.
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    const corpo = puts[0] as Record<string, unknown>;
    expect(corpo.flatRateCents).toBe(1990);
    // Zero aqui daria frete grátis para a loja inteira.
    expect(corpo.freeAboveCents).toBeNull();
    expect(corpo.estimatedDays).toBeNull();
  });

  it('a recusa do servidor aparece na tela', async () => {
    servidor(() => ({
      status: 400,
      body: {
        error: {
          code: 'SHIPPING_FLAT_RATE_REQUIRED',
          message: 'Para ligar a entrega é preciso informar o valor do frete da tabela da loja.',
        },
      },
    }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText(/Entregar pelo site/));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    // Engolir o erro faria o gestor sair achando que ligou a entrega.
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/valor do frete/i);
  });

  /*
    GAP-PRD-195: prazo negativo era gravado com 200 e a loja perdia o selo de
    prazo sem aviso; texto virava NaN, que o JSON manda como null. A tela
    recusa antes de chamar o servidor — e o servidor recusa de novo.
  */
  it('prazo negativo, fracionado ou texto é recusado na tela, sem ir ao servidor', async () => {
    const puts = servidor(() => ({ body: PADRAO }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText(/Entregar pelo site/));
    fireEvent.change(screen.getByLabelText('Frete'), { target: { value: '10,00' } });
    for (const errado of ['-3', '2,5', 'dois']) {
      fireEvent.change(screen.getByLabelText('Prazo em dias úteis'), { target: { value: errado } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      const alerta = await screen.findByRole('alert');
      expect(alerta.textContent).toMatch(/número inteiro/);
    }
    expect(puts).toHaveLength(0);
  });

  it('prazo inteiro vai ao servidor como número', async () => {
    const puts = servidor(() => ({ body: { ...PADRAO, deliveryEnabled: true, flatRateCents: 1000, estimatedDays: 5 } }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText(/Entregar pelo site/));
    fireEvent.change(screen.getByLabelText('Frete'), { target: { value: '10,00' } });
    fireEvent.change(screen.getByLabelText('Prazo em dias úteis'), { target: { value: ' 5 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0] as Record<string, unknown>).estimatedDays).toBe(5);
  });

  it('depois de salvar, a tela passa a dizer por quanto a loja entrega', async () => {
    servidor(() => ({ body: { ...PADRAO, deliveryEnabled: true, flatRateCents: 2500 } }));
    render(
      <MemoryRouter>
        <EntregaLojaPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText(/Entregar pelo site/));
    fireEvent.change(screen.getByLabelText('Frete'), { target: { value: '25,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await screen.findByText(/entrega por R\$ 25,00/);
  });
});
