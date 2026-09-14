/**
 * Configurações › Entrar com Google (loja) — GAP-PRD-027.
 *
 * A tela onde o insumo externo (o cliente OAuth do Google) entra sem uma
 * linha de código. O que se cobra:
 *
 *   - diz a situação e o que falta, como o servidor mediu;
 *   - o segredo nunca volta: o campo começa vazio, a dica aparece, e salvar
 *     em branco manda vazio (o servidor mantém o guardado);
 *   - o provedor de teste só é oferecido onde o servidor permite;
 *   - a recusa do servidor aparece com a mensagem dele.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginGooglePage from '../LoginGooglePage';

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

const DESLIGADO = {
  enabled: false,
  providerMode: 'google',
  clientId: null,
  secretConfigured: false,
  secretHint: null,
  redirectUri: null,
  redirectUriSugerido: 'https://loja.gruposampaio.com.br/minha-conta/google',
  enderecoPublicoConfigurado: true,
  provedorDeTestePermitido: false,
  prontidao: {
    estado: 'desligado',
    falta: ['Client ID do cliente OAuth', 'Segredo do cliente OAuth', 'Endereço de retorno (redirect URI)'],
    mensagem: 'Desligado. A loja não mostra o botão do Google até a configuração ficar completa e ser ligada.',
  },
  updatedAt: null,
  updatedBy: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(inicial: Record<string, unknown>, aoSalvar?: (corpo: Record<string, unknown>) => Response) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const c: Chamada = {
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      chamadas.push(c);
      if (c.url.includes('/core/portal/login-google')) {
        if (c.method === 'PUT' && aoSalvar) return aoSalvar(c.body ?? {});
        return json(inicial);
      }
      return json({ items: [] });
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <LoginGooglePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a configuração do Google', () => {
  it('diz que está desligado e o que falta, e sugere o endereço de retorno', async () => {
    servidor(DESLIGADO);
    montar();
    await screen.findByText('Desligado');
    const falta = screen.getByRole('list', { name: 'O que falta' });
    expect(falta.textContent).toContain('Client ID do cliente OAuth');
    expect((screen.getByLabelText('Endereço de retorno (redirect URI)') as HTMLInputElement).value).toBe(
      'https://loja.gruposampaio.com.br/minha-conta/google',
    );
    // Produção: o provedor de teste nem é oferecido.
    expect(screen.queryByText(/Provedor de teste/)).toBeNull();
  });

  it('salvar manda os campos; o segredo digitado vai e o campo esvazia', async () => {
    const chamadas = servidor(DESLIGADO, (corpo) =>
      json({
        ...DESLIGADO,
        enabled: true,
        clientId: corpo.clientId,
        redirectUri: corpo.redirectUri,
        secretConfigured: true,
        secretHint: '••••1234',
        prontidao: { estado: 'pronto', falta: [], mensagem: 'Ligado. O botão "Entrar com Google" aparece na tela de entrar da loja.' },
      }),
    );
    montar();
    await screen.findByText('Desligado');

    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: '123-abc.apps.googleusercontent.com' } });
    fireEvent.change(screen.getByLabelText('Segredo do cliente'), { target: { value: 'GOCSPX-segredo-1234' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Ligado/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await screen.findByText(/já aparece na loja/);
    const put = chamadas.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      enabled: true,
      providerMode: 'google',
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-segredo-1234',
      redirectUri: 'https://loja.gruposampaio.com.br/minha-conta/google',
    });
    expect((screen.getByLabelText('Segredo do cliente') as HTMLInputElement).value).toBe('');
    await screen.findByText('Ligado — Google');
    screen.getByText(/Guardado \(••••1234\)/);
  });

  it('o provedor de teste é oferecido onde o servidor permite', async () => {
    servidor({ ...DESLIGADO, provedorDeTestePermitido: true });
    montar();
    fireEvent.click(await screen.findByRole('radio', { name: /Provedor de teste/ }));
    expect((screen.getByRole('radio', { name: /Provedor de teste/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('a recusa do servidor aparece com a mensagem dele', async () => {
    servidor(DESLIGADO, () =>
      json({ error: { code: 'PORTAL_GOOGLE_CONFIGURACAO_INCOMPLETA', message: 'Para ligar falta: Segredo do cliente OAuth.' } }, 422),
    );
    montar();
    await screen.findByText('Desligado');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ligado/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByText('Para ligar falta: Segredo do cliente OAuth.');
  });
});
