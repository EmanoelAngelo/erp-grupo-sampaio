/**
 * "Entrar com Google" na tela — GAP-PRD-027.
 *
 * O que se cobra com o servidor dublado (nenhuma chamada ao Google):
 *
 *   - o botão só aparece quando a loja oferece; o de teste se declara;
 *   - clicar pede o endereço ao servidor, guarda a CHAVE DO NAVEGADOR na aba
 *     e sai para o Google; na tela de criar, o aceite marcado vai junto;
 *   - a volta (`/minha-conta/google`) manda code + state + a chave guardada,
 *     guarda a sessão e segue para onde a pessoa ia; sem a chave (a volta
 *     aberta em outro navegador) não manda nada; recusa e erro têm voz;
 *   - a conta nova sem aceite pede o aceite antes de criar;
 *   - na conta aberta: ligar (com o token do portal), e desligar recusado na
 *     tela quando a conta não tem senha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EntrarComGoogle } from '../EntrarComGoogle';
import { GoogleNaConta } from '../GoogleNaConta';
import { ContaDoCliente } from '../ContaDoCliente';
import RetornoDoGooglePage from '@/pages/gs/RetornoDoGooglePage';
import MinhaContaPage from '@/pages/gs/MinhaContaPage';

type Chamada = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(rotas: Record<string, (c: Chamada) => Response>) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const c: Chamada = {
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: init?.headers ?? {},
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      chamadas.push(c);
      for (const [padrao, responder] of Object.entries(rotas)) {
        const [m, caminho] = padrao.split(' ');
        if (m === c.method && c.url.includes(caminho!)) return responder(c);
      }
      return json({ items: [] });
    }),
  );
  return chamadas;
}

const SESSAO = {
  token: 'token-do-portal',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  account: { id: 'conta-1', email: 'ana@gmail.com', emailVerifiedAt: '2026-09-11T10:00:00.000Z' },
  customers: [],
};

const INICIO = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s',
  browserKey: 'chave-deste-navegador',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  modo: 'google',
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('o botão', () => {
  it('não aparece quando a loja não oferece — nem quando o corpo não diz sim', async () => {
    const chamadas = servidor({ 'GET /loja/portal/google/disponivel': () => json({ disponivel: false, modo: null }) });
    const { container } = render(<EntrarComGoogle />);
    await waitFor(() => expect(chamadas.length).toBe(1));
    expect(container.textContent).toBe('');
  });

  it('pede o endereço, guarda a chave do navegador na aba e sai para o Google', async () => {
    const chamadas = servidor({
      'GET /loja/portal/google/disponivel': () => json({ disponivel: true, modo: 'google' }),
      'POST /loja/portal/google/iniciar': () => json(INICIO),
    });
    const navegar = vi.fn();
    render(<EntrarComGoogle returnTo="/gringa?carrinho=1" navegar={navegar} />);

    fireEvent.click(await screen.findByRole('button', { name: /Entrar com Google/ }));
    await waitFor(() => expect(navegar).toHaveBeenCalledWith(INICIO.authorizationUrl));

    const iniciar = chamadas.find((c) => c.url.includes('/google/iniciar'))!;
    expect(iniciar.body).toEqual({ intent: 'entrar', termsAccepted: false, returnTo: '/gringa?carrinho=1' });
    // A requisição é do portal: sem o Bearer do ERP.
    expect(iniciar.headers.Authorization).toBeUndefined();
    const ida = JSON.parse(sessionStorage.getItem('gs.portal.google')!);
    expect(ida).toMatchObject({ browserKey: 'chave-deste-navegador', intent: 'entrar', returnTo: '/gringa?carrinho=1' });
  });

  it('o provedor de teste se declara na tela', async () => {
    servidor({ 'GET /loja/portal/google/disponivel': () => json({ disponivel: true, modo: 'teste' }) });
    render(<EntrarComGoogle />);
    await screen.findByText(/provedor de TESTE, não o Google de verdade/);
  });

  it('na tela de criar, o aceite marcado viaja com o pedido', async () => {
    const chamadas = servidor({
      'GET /loja/portal/google/disponivel': () => json({ disponivel: true, modo: 'google' }),
      'POST /loja/portal/google/iniciar': () => json({ error: { code: 'PORTAL_GOOGLE_DESLIGADO', message: 'A entrada pelo Google não está disponível nesta loja.' } }, 503),
    });
    render(
      <MemoryRouter initialEntries={['/minha-conta']}>
        <MinhaContaPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ainda não tenho acesso' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Aceito os termos/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Criar conta com Google/ }));

    await screen.findByText('A entrada pelo Google não está disponível nesta loja.');
    expect(chamadas.find((c) => c.url.includes('/google/iniciar'))!.body).toMatchObject({ termsAccepted: true });
  });
});

describe('a volta do Google', () => {
  function montarVolta(busca: string) {
    render(
      <MemoryRouter initialEntries={[`/minha-conta/google${busca}`]}>
        <Routes>
          <Route path="/minha-conta/google" element={<RetornoDoGooglePage />} />
          <Route path="/minha-conta" element={<p>TELA DA CONTA</p>} />
          <Route path="/gringa" element={<p>O CARRINHO DA GRINGA</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  function idaGuardada(intent: 'entrar' | 'vincular' = 'entrar', returnTo: string | null = '/gringa?carrinho=1') {
    sessionStorage.setItem('gs.portal.google', JSON.stringify({ browserKey: 'chave-deste-navegador', intent, returnTo, em: Date.now() }));
  }

  it('conclui com code, state e a chave desta aba — guarda a sessão e volta ao carrinho', async () => {
    idaGuardada();
    const chamadas = servidor({
      'POST /loja/portal/google/concluir': () => json({ status: 'sessao', session: SESSAO, returnTo: '/gringa?carrinho=1', contaNova: false }),
    });
    montarVolta('?code=codigo-1&state=estado-1');

    await screen.findByText('O CARRINHO DA GRINGA');
    const concluir = chamadas.find((c) => c.url.includes('/google/concluir'))!;
    expect(concluir.body).toEqual({ code: 'codigo-1', state: 'estado-1', browserKey: 'chave-deste-navegador' });
    expect(JSON.parse(localStorage.getItem('gs.portal')!).token).toBe('token-do-portal');
    expect(sessionStorage.getItem('gs.portal.google')).toBeNull();
    // O código foi mandado uma vez só.
    expect(chamadas.filter((c) => c.url.includes('/google/concluir'))).toHaveLength(1);
  });

  it('sem a chave desta aba (a volta aberta em outro navegador), não manda nada', async () => {
    const chamadas = servidor({});
    montarVolta('?code=codigo-1&state=estado-1');
    await screen.findByText(/não começou neste navegador/);
    expect(chamadas.some((c) => c.url.includes('/google/concluir'))).toBe(false);
    expect(localStorage.getItem('gs.portal')).toBeNull();
  });

  it('quem cancelou no Google lê que cancelou', async () => {
    idaGuardada();
    servidor({});
    montarVolta('?error=access_denied&state=estado-1');
    await screen.findByText(/Você cancelou a entrada pelo Google/);
  });

  it('a recusa do servidor aparece com a mensagem dele', async () => {
    idaGuardada();
    servidor({
      'POST /loja/portal/google/concluir': () =>
        json({ error: { code: 'PORTAL_GOOGLE_EMAIL_NAO_VERIFICADO', message: 'A conta Google não tem o e-mail verificado.' } }, 403),
    });
    montarVolta('?code=c&state=s');
    await screen.findByText('A conta Google não tem o e-mail verificado.');
  });

  it('conta nova sem aceite: pede o aceite, e só cria depois dele', async () => {
    idaGuardada('entrar', null);
    const chamadas = servidor({
      'POST /loja/portal/google/concluir': () =>
        json({ status: 'termos_pendentes', ticket: 'ticket-1', email: 'bia@gmail.com', name: 'Bia', returnTo: null }),
      'POST /loja/portal/google/aceitar-termos': () =>
        json({ status: 'sessao', session: SESSAO, returnTo: null, contaNova: true }, 201),
    });
    montarVolta('?code=c&state=s');

    await screen.findByText(/Ainda não há conta com esse e-mail/);
    const criar = screen.getByRole('button', { name: 'Criar minha conta' }) as HTMLButtonElement;
    expect(criar.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Aceito os termos/ }));
    fireEvent.click(criar);

    await screen.findByText('TELA DA CONTA');
    expect(chamadas.find((c) => c.url.includes('/aceitar-termos'))!.body).toEqual({
      ticket: 'ticket-1',
      browserKey: 'chave-deste-navegador',
      termsAccepted: true,
    });
    expect(JSON.parse(localStorage.getItem('gs.portal')!).token).toBe('token-do-portal');
  });

  it('ligar à conta aberta: a volta leva o token do portal e diz que ligou', async () => {
    localStorage.setItem('gs.portal', JSON.stringify(SESSAO));
    idaGuardada('vincular', '/minha-conta');
    const chamadas = servidor({
      'POST /loja/portal/google/concluir': () => json({ status: 'vinculado', googleEmail: 'ana.pessoal@gmail.com', returnTo: '/minha-conta' }),
    });
    montarVolta('?code=c&state=s');
    await screen.findByText(/agora também entra pelo Google/);
    expect(chamadas.find((c) => c.url.includes('/google/concluir'))!.headers['x-portal-token']).toBe('token-do-portal');
  });

  it('sem code nem state, diz que não há o que concluir', async () => {
    servidor({});
    montarVolta('');
    await screen.findByText('Não há entrada pelo Google para concluir aqui.');
  });
});

describe('o Google na conta aberta', () => {
  it('não ligado: "Ligar" pede o endereço com o token do portal e a intenção de ligar', async () => {
    const chamadas = servidor({
      'GET /loja/portal/google/conta': () => json({ disponivel: true, modo: 'google', ligado: null, temSenha: true }),
      'POST /loja/portal/google/iniciar': () => json(INICIO),
    });
    const navegar = vi.fn();
    render(<GoogleNaConta token="token-do-portal" navegar={navegar} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ligar minha conta Google' }));
    await waitFor(() => expect(navegar).toHaveBeenCalledWith(INICIO.authorizationUrl));
    const iniciar = chamadas.find((c) => c.url.includes('/google/iniciar'))!;
    expect(iniciar.body).toMatchObject({ intent: 'vincular' });
    expect(iniciar.headers['x-portal-token']).toBe('token-do-portal');
    expect(JSON.parse(sessionStorage.getItem('gs.portal.google')!).intent).toBe('vincular');
  });

  it('conta que só entra pelo Google: desligar fica travado e a tela diz como criar a senha', async () => {
    servidor({
      'GET /loja/portal/google/conta': () =>
        json({ disponivel: true, modo: 'google', ligado: { email: 'h@gmail.com', desde: '2026-09-01T10:00:00.000Z', ultimaEntrada: null }, temSenha: false }),
    });
    render(<GoogleNaConta token="t" />);
    const desligar = (await screen.findByRole('button', { name: 'Desligar o Google' })) as HTMLButtonElement;
    expect(desligar.disabled).toBe(true);
    screen.getByText(/ainda não tem senha/);
    screen.getByText(/h@gmail.com/);
  });

  it('com senha: desligar chama o servidor e confirma', async () => {
    const chamadas = servidor({
      'GET /loja/portal/google/conta': () =>
        json({ disponivel: true, modo: 'google', ligado: { email: 'i@gmail.com', desde: '2026-09-01T10:00:00.000Z', ultimaEntrada: null }, temSenha: true }),
      'DELETE /loja/portal/google/conta': () => json({ disponivel: true, modo: 'google', ligado: null, temSenha: true }),
    });
    render(<GoogleNaConta token="t" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Desligar o Google' }));
    await screen.findByText(/O Google foi desligado/);
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(true);
    screen.getByRole('button', { name: 'Ligar minha conta Google' });
  });

  it('conta sem senha: "Trocar senha" vira o caminho da recuperação', async () => {
    servidor({
      'GET /loja/portal/perfil': () =>
        json({ email: 'h@gmail.com', name: 'H', phone: null, emailVerified: true, hasPassword: false, faltando: [] }),
    });
    render(<ContaDoCliente token="t" />);
    await screen.findByTestId('conta-sem-senha');
    expect(screen.queryByLabelText('Senha atual')).toBeNull();
  });

  it('some quando a loja não oferece e a conta não está ligada', async () => {
    const chamadas = servidor({
      'GET /loja/portal/google/conta': () => json({ disponivel: false, modo: null, ligado: null, temSenha: true }),
    });
    const { container } = render(<GoogleNaConta token="t" />);
    await waitFor(() => expect(chamadas.length).toBe(1));
    expect(container.textContent).toBe('');
  });
});
