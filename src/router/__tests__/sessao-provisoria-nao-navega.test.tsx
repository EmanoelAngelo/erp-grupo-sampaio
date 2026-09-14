/**
 * ============================================================================
 * SESSÃO PROVISÓRIA NÃO NAVEGA — o guarda fecha o que a porta prometeu
 * ============================================================================
 *
 * ## O buraco medido
 *
 * A etapa de troca segurava a pessoa NA TELA DE LOGIN (estado local `etapa`),
 * e só ali. A sessão emitida pelo login provisório já estava no localStorage —
 * precisa estar: é ela que autentica o `POST /auth/password`. Um F5 no meio da
 * etapa, uma URL digitada (`/sistema/...`) ou o botão voltar montavam qualquer
 * rota protegida com essa sessão, e a etapa virava um aviso que só aparece uma
 * vez — a senha que a gestão conhece continuava valendo, com o app inteiro
 * aberto.
 *
 * ## O desenho do conserto (o menor caminho honesto)
 *
 * Não há rota nova nem tela nova: `Protected` — que já é o único portão de
 * toda rota protegida — passa a mandar a sessão com `mustChangePassword` para
 * a PORTA do ambiente da pessoa (`/oficina/login` para a bancada, `/login`
 * para o resto), e as duas portas já abrem direto na etapa quando a sessão
 * guardada carrega a bandeira. O botão voltar cai no mesmo funil: voltar
 * re-renderiza a rota, a rota re-renderiza o guarda.
 *
 * ## Por que os primeiros casos usam o localStorage CRU, e por que vêm primeiro
 *
 * `getSession()` hidrata do armazenamento UMA vez por processo, na primeira
 * chamada. Escrever a sessão no localStorage antes do primeiro render é o que
 * faz estes casos atravessarem `restaurarSessao()` de verdade — o caminho do
 * F5 —, em vez de lerem uma sessão que o teste já tinha em memória. Por isso
 * os casos de restauração abrem o arquivo: depois da primeira hidratação, o
 * módulo não relê o armazenamento.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useRoutes } from 'react-router-dom';
import { Protected } from '../Protected';
import { gsRoutes } from '../gsRoutes';
import { ROTA_GESTAO, ROTA_OFICINA, type Environment } from '../environments';
import { logout, setSession, type StoredSession } from '@/lib/api/client';

/**
 * Uma sessão como o login grava. O token `sem-escopo` não tem as três partes
 * de um JWT, então `scopeFromToken` devolve nulos e a validação de escopo
 * passa — igual às sessões de mentira do resto da suíte.
 */
function sessaoDe(
  profileCode: string,
  loginName: string,
  user: { mustChangePassword?: boolean } = {},
): StoredSession {
  return {
    accessToken: 'sem-escopo',
    refreshToken: 'r-1',
    expiresAt: Date.now() + 3_600_000,
    user: {
      id: 'u-1',
      login: loginName,
      displayName: loginName,
      profileCode,
      ...user,
    },
    company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
    companies: [
      {
        id: 'oficina',
        slug: 'oficina',
        tradeName: 'Oficina',
        kind: 'workshop',
        profileCode,
      },
    ],
  };
}

/** O roteador REAL, inteiro — URL direta cai onde cairia no navegador. */
function AppReal() {
  return useRoutes(gsRoutes);
}

function abrirNoRoteadorReal(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <AppReal />
    </MemoryRouter>,
  );
}

/**
 * O guarda isolado, no estilo de `environments.test.tsx` — mas com o cliente
 * REAL: aqui a sessão vem de `setSession`/localStorage, porque a pergunta é
 * sobre a bandeira que a sessão de verdade carrega.
 */
function abrirProtegida(rota: string, environments: Environment[]) {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route
          path={rota}
          element={
            <Protected environments={environments}>
              <p>CONTEUDO</p>
            </Protected>
          }
        />
        <Route path="/login" element={<p>PORTA DA GESTAO</p>} />
        <Route path="/oficina/login" element={<p>PORTA DA BANCADA</p>} />
        <Route path="/pdv" element={<p>CASA PDV</p>} />
        <Route path="/sistema/oficina" element={<p>CASA OFICINA</p>} />
        <Route path="/sistema/painel" element={<p>CASA GESTAO</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // As portas reais perguntam ao montar se há "Esqueci minha senha"; 404 em
  // tudo é "não há", e nada aparece.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rota não mockada' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste de sessão provisória');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a sessão restaurada do localStorage com a bandeira de pé', () => {
  it('URL direta da bancada cai na porta da bancada, com a etapa já aberta', async () => {
    // O F5 de verdade: a sessão só existe no armazenamento quando o primeiro
    // getSession() do processo roda. Ver o cabeçalho para a ordem dos casos.
    localStorage.setItem(
      'gs.session',
      JSON.stringify(sessaoDe('mecanico', 'ROBERTOMECANICO', { mustChangePassword: true })),
    );

    abrirNoRoteadorReal('/sistema/oficina');

    await screen.findByRole('heading', { name: 'Troque a senha provisória' });
    // A porta é a da bancada — não a do escritório, que oferece Gestão e PDV.
    expect(screen.getByText('Acesso da bancada')).toBeTruthy();
    // E é a etapa, não o formulário de credenciais: relogar com a MESMA senha
    // provisória não é o caminho.
    expect(screen.queryByLabelText(/^Usuário\s*\*?$/)).toBeNull();
    // O Kanban da oficina não montou.
    expect(screen.queryByText('Ordens de serviço')).toBeNull();
  });

  it('URL direta do escritório, com sessão provisória do escritório, cai na porta da gestão', async () => {
    setSession(
      sessaoDe('gestor', 'CARLOSGERENTE', { mustChangePassword: true }),
      'LOGIN',
      'teste: gestor provisório',
    );

    abrirNoRoteadorReal('/sistema/painel');

    await screen.findByRole('heading', { name: 'Troque a senha provisória' });
    // A porta do escritório, reconhecível pela lateral institucional.
    expect(screen.getByText('Sistema de gestão')).toBeTruthy();
    expect(screen.queryByText('Acesso da bancada')).toBeNull();
  });

  it('o mecânico provisório que digitar URL do escritório volta para a porta DELE', async () => {
    /*
      A porta vem do PERFIL da sessão, não da rota tentada: com sessão na mão o
      guarda sabe quem é a pessoa, e despejar a bancada na tela do escritório é
      o defeito que `/oficina/login` existe para evitar.
    */
    setSession(
      sessaoDe('mecanico', 'ROBERTOMECANICO', { mustChangePassword: true }),
      'LOGIN',
      'teste: mecânico provisório',
    );

    abrirNoRoteadorReal('/sistema/painel');

    await screen.findByRole('heading', { name: 'Troque a senha provisória' });
    expect(screen.getByText('Acesso da bancada')).toBeTruthy();
  });

  it('no guarda isolado: a bandeira manda para a porta, nunca para o CONTEUDO', () => {
    setSession(
      sessaoDe('mecanico', 'ROBERTOMECANICO', { mustChangePassword: true }),
      'LOGIN',
      'teste: mecânico provisório',
    );

    abrirProtegida('/sistema/oficina', ROTA_OFICINA);

    expect(screen.getByText('PORTA DA BANCADA')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });
});

describe('a bandeira ausente não muda nada', () => {
  it('sessão sem a bandeira navega normal', () => {
    setSession(
      sessaoDe('mecanico', 'ROBERTOMECANICO', { mustChangePassword: false }),
      'LOGIN',
      'teste: mecânico com senha própria',
    );

    abrirProtegida('/sistema/oficina', ROTA_OFICINA);

    expect(screen.getByText('CONTEUDO')).toBeTruthy();
    expect(screen.queryByText('PORTA DA BANCADA')).toBeNull();
  });

  it('sessão de antes do contrato — sem o campo — navega normal', () => {
    // Ausência significa "não precisa trocar": o contrato do campo opcional em
    // `SessionUser`. Barrar aqui derrubaria todo mundo no primeiro deploy.
    setSession(
      sessaoDe('gestor', 'CARLOSGERENTE'),
      'LOGIN',
      'teste: sessão de antes do contrato',
    );

    abrirProtegida('/sistema/painel', ROTA_GESTAO);

    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });
});

describe('logout limpa', () => {
  it('depois do logout, a rota protegida volta a pedir credenciais — não a etapa', async () => {
    setSession(
      sessaoDe('mecanico', 'ROBERTOMECANICO', { mustChangePassword: true }),
      'LOGIN',
      'teste: mecânico provisório',
    );
    await logout();

    abrirNoRoteadorReal('/sistema/oficina');

    // Sem sessão não há bandeira: a porta abre no formulário de sempre.
    await screen.findByLabelText(/^Usuário\s*\*?$/);
    expect(screen.getByText('Acesso da bancada')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Troque a senha provisória' })).toBeNull();
    expect(localStorage.getItem('gs.session')).toBeNull();
  });
});
