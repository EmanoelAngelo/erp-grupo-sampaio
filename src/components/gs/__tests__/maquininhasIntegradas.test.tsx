/**
 * ============================================================================
 * O GESTOR DESLIGA A MAQUININHA PELA TELA (GAP-PRD-001)
 * ============================================================================
 *
 * Não existia tela nem rota para desligar uma configuração de maquininha — a
 * linha `mock` ativa no banco real da Preço Justo só sairia com alguém
 * abrindo o SQLite. Estes casos cobram o card da conferência:
 *
 * 1. Mostra cada maquininha com o estado REAL (ligada, desligada, ignorada
 *    neste ambiente) e marca a de TESTE — com o aviso em destaque.
 * 2. Desligar exige motivo antes de o botão acender, manda o motivo ao
 *    servidor e recarrega a lista.
 * 3. A recusa do servidor (religar a de teste em produção) aparece como veio.
 * 4. Falha ao carregar NÃO vira "nenhuma maquininha".
 * 5. No PDV, a maquininha de teste é dita ANTES de cobrar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MaquininhasIntegradasCard } from '../MaquininhasIntegradasCard';
import { PagamentoDialog } from '../PagamentoDialog';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MOCK_LIGADA = {
  id: 'ptcfg-1786588515956',
  provider: 'mock',
  displayName: 'Maquininha do balcao',
  active: true,
  simulated: true,
  blockedInThisEnvironment: false,
};

let chamadas: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

function servidor(opts: {
  lista?: () => Response;
  desligar?: () => Response;
  religar?: () => Response;
}) {
  chamadas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      chamadas.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null });
      if (u.includes('/configurations/') && u.endsWith('/deactivate')) {
        return opts.desligar?.() ?? json({ ...MOCK_LIGADA, active: false });
      }
      if (u.includes('/configurations/') && u.endsWith('/activate')) {
        return opts.religar?.() ?? json({ ...MOCK_LIGADA, active: true });
      }
      if (u.endsWith('/core/pdv/terminal/configurations')) {
        return opts.lista?.() ?? json({ environmentBlocksTestProvider: null, items: [MOCK_LIGADA] });
      }
      return json({ items: [] });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('o card das maquininhas integradas', () => {
  it('mostra a de TESTE ligada, com o aviso de que ela aprova sem dinheiro', async () => {
    servidor({});
    render(<MaquininhasIntegradasCard />);

    expect(await screen.findByText('Maquininha do balcao')).toBeTruthy();
    expect(screen.getByText(/TESTE — simulada/)).toBeTruthy();
    expect(screen.getByText('Ligada')).toBeTruthy();
    const aviso = screen.getByRole('alert', { name: /Maquininha de teste ligada/i });
    expect(aviso.textContent).toMatch(/SEM dinheiro/);
    expect(screen.getByRole('button', { name: 'Desligar' })).toBeTruthy();
  });

  it('em produção, diz que o ambiente a ignora mas que ela continua gravada', async () => {
    servidor({
      lista: () =>
        json({
          environmentBlocksTestProvider: 'production',
          items: [{ ...MOCK_LIGADA, blockedInThisEnvironment: true }],
        }),
    });
    render(<MaquininhasIntegradasCard />);

    expect(await screen.findByText(/Ligada, ignorada neste ambiente/)).toBeTruthy();
    const aviso = screen.getByRole('alert', { name: /Maquininha de teste ligada/i });
    expect(aviso.textContent).toMatch(/production/);
    expect(aviso.textContent).toMatch(/continua gravada/);
  });

  it('desligar exige motivo, manda o motivo ao servidor e recarrega', async () => {
    let desligada = false;
    servidor({
      lista: () =>
        json({
          environmentBlocksTestProvider: null,
          items: [
            desligada
              ? {
                  ...MOCK_LIGADA,
                  active: false,
                  deactivatedAt: '2026-09-11T10:00:00.000Z',
                  deactivationReason: 'teste esquecido',
                }
              : MOCK_LIGADA,
          ],
        }),
      desligar: () => {
        desligada = true;
        return json({ ...MOCK_LIGADA, active: false });
      },
    });
    render(<MaquininhasIntegradasCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Desligar' }));
    const dialogo = screen.getByRole('dialog', { name: /Desligar maquininha/ });
    const confirmar = within(dialogo).getByRole('button', { name: 'Desligar' }) as HTMLButtonElement;
    // Sem motivo, o botão não acende: desligar tira a exigência de cobrança.
    expect(confirmar.disabled).toBe(true);

    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: 'teste esquecido' } });
    expect(confirmar.disabled).toBe(false);
    fireEvent.click(confirmar);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const pedido = chamadas.find((c) => c.url.endsWith('/deactivate'));
    expect(pedido?.method).toBe('POST');
    expect(pedido?.url).toContain('/core/pdv/terminal/configurations/ptcfg-1786588515956/deactivate');
    expect(pedido?.body).toEqual({ reason: 'teste esquecido' });

    expect((await screen.findByRole('status')).textContent).toMatch(/desligada/);
    expect(await screen.findByText('Desligada')).toBeTruthy();
    expect(screen.getByText(/teste esquecido/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Religar' })).toBeTruthy();
    // E o aviso de teste LIGADA some junto.
    expect(screen.queryByRole('alert', { name: /Maquininha de teste ligada/i })).toBeNull();
  });

  it('a recusa do servidor ao religar aparece como veio, e o diálogo fica aberto', async () => {
    servidor({
      lista: () =>
        json({
          environmentBlocksTestProvider: 'production',
          items: [{ ...MOCK_LIGADA, active: false, blockedInThisEnvironment: true }],
        }),
      religar: () =>
        json(
          {
            error: {
              code: 'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION',
              message: 'O provider mock não pode ser configurado nem cobrar em produção/homologação.',
            },
          },
          403,
        ),
    });
    render(<MaquininhasIntegradasCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Religar' }));
    const dialogo = screen.getByRole('dialog', { name: /Religar maquininha/ });
    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: 'quero de volta' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Religar' }));

    expect((await within(dialogo).findByRole('alert')).textContent).toMatch(/não pode ser configurado/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('falha ao carregar não vira "nenhuma maquininha"', async () => {
    servidor({
      lista: () => json({ error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } }, 403),
    });
    render(<MaquininhasIntegradasCard />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Permissão negada/);
    expect(screen.queryByText(/Nenhuma maquininha integrada/)).toBeNull();
    expect(screen.getByText(/Não foi possível listar/)).toBeTruthy();
  });
});

// ============================================================================

const MEIOS = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
];

function pdv(simulated: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/pdv/terminal/status')) {
        return json({
          configured: true,
          provider: simulated ? 'mock' : 'stone',
          readiness: 'READY_FOR_HARDWARE',
          simulated,
          message: simulated
            ? 'Maquininha de TESTE (simulada): as cobranças NÃO movimentam dinheiro.'
            : 'Maquininha stone integrada.',
        });
      }
      return json({ items: [] });
    }),
  );
}

describe('no PDV, a maquininha de teste é dita ANTES de cobrar', () => {
  beforeEach(() => undefined);

  it('com a de teste ligada, o cartão mostra o aviso em destaque', async () => {
    pdv(true);
    render(<PagamentoDialog totalCents={5000} onConfirm={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /Crédito/ }));
    const aviso = await screen.findByRole('alert', { name: /Maquininha de teste/i });
    expect(aviso.textContent).toMatch(/NÃO movimentam dinheiro/);
  });

  it('com maquininha real, não há aviso de teste', async () => {
    pdv(false);
    render(<PagamentoDialog totalCents={5000} onConfirm={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /Crédito/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Cobrar na maquininha/ })).toBeTruthy(),
    );
    expect(screen.queryByRole('alert', { name: /Maquininha de teste/i })).toBeNull();
  });
});
