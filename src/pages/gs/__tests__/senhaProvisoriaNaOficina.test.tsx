/**
 * SENHA PROVISÓRIA NA PORTA DA BANCADA — o espelho que faltava.
 *
 * A etapa de troca nasceu na tela de entrada do escritório (o precedente é
 * `senhaProvisoriaNoLogin.test.tsx`, e os casos daqui espelham os de lá de
 * propósito: mesma régua nas duas portas), e a bancada ficou de fora: o
 * mecânico com senha provisória entrava DIRETO pela `/oficina/login`, com a
 * senha que a gestão conhece continuando a valer — exatamente o buraco que a
 * etapa existe para fechar, aberto na única porta por onde mecânico entra.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem a etapa na porta da bancada, o login provisório navega direto — o
 *     primeiro caso falha;
 *   - a troca DERRUBA o refresh antigo no servidor (`session_version` sobe),
 *     então o caso da troca bem-sucedida exige a sessão RELOGADA com a senha
 *     nova, nunca a sessão provisória;
 *   - recarregar no meio da etapa reabria o formulário de credenciais — e a
 *     sessão provisória seguia guardada, pronta para navegar por URL direta.
 *     A metade do GUARDA dessa história mora em
 *     `src/router/__tests__/sessao-provisoria-nao-navega.test.tsx`; aqui se
 *     cobra a metade da PORTA: quem volta com a bandeira de pé volta para a
 *     etapa, não para as credenciais;
 *   - sem a saída "entrar com outra conta", uma sessão provisória encalhada
 *     (senha já reiniciada de novo pela gestão, access vencido) trancava esta
 *     tela para sempre: o guarda manda toda rota para cá, e daqui não havia
 *     porta nenhuma para fora.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OficinaLoginPage from '../OficinaLoginPage';

const SENHA_PROVISORIA = 'provisoria1';
const SENHA_NOVA = 'NovaSenhaForte1';

function respostaDeLogin(mustChangePassword: boolean, sufixo = '') {
  return {
    accessToken: `sem-escopo${sufixo}`,
    refreshToken: `r-1${sufixo}`,
    expiresIn: 3600,
    user: {
      id: 'u-mecanico',
      login: 'ROBERTOMECANICO',
      displayName: 'Roberto',
      profileCode: 'mecanico',
      mustChangePassword,
    },
    company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
    companies: [
      {
        id: 'oficina',
        slug: 'oficina',
        tradeName: 'Oficina',
        kind: 'workshop',
        profileCode: 'mecanico',
      },
    ],
  };
}

/**
 * Servidor de mentira que responde por rota e ANOTA o corpo de cada chamada.
 * Rota não declarada cai em 404 — o suficiente para provar que a régua local
 * barrou ANTES da viagem, e para o logout do "entrar com outra conta" seguir
 * limpando a sessão local mesmo sem servidor.
 */
function servidor(rotas: Record<string, () => Response | Promise<Response>>) {
  const chamadas: { url: string; method: string; body: unknown }[] = [];
  const fake = vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: unknown }) => {
    const alvo = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    chamadas.push({ url: alvo, method, body });
    for (const [padrao, responder] of Object.entries(rotas)) {
      const [m, caminho] = padrao.split(' ');
      if (m === method && alvo.includes(caminho)) return responder();
    }
    return new Response(JSON.stringify({ error: { message: 'rota não mockada' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fake);
  return { chamadas, fake };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/oficina/login']}>
      <Routes>
        <Route path="/oficina/login" element={<OficinaLoginPage />} />
        {/* A casa do mecânico (`homeOf('mecanico')`): chegar aqui é "entrou". */}
        <Route path="/sistema/oficina" element={<div>BANCADA-DE-MENTIRA</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// Os rótulos dos campos obrigatórios carregam o asterisco do `Field`; o
// regex com `\*?` é o padrão da casa para mirar neles.
function entrarComSenha(senha: string) {
  fireEvent.change(screen.getByLabelText(/^Usuário\s*\*?$/), {
    target: { value: 'ROBERTOMECANICO' },
  });
  fireEvent.change(screen.getByLabelText(/^Senha\s*\*?$/), { target: { value: senha } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

async function chegarNaEtapaDeTroca() {
  entrarComSenha(SENHA_PROVISORIA);
  await screen.findByRole('heading', { name: 'Troque a senha provisória' });
}

function preencherTroca(atual: string, nova: string, confirma: string) {
  fireEvent.change(screen.getByLabelText(/^Senha atual\s*\*?$/), { target: { value: atual } });
  fireEvent.change(screen.getByLabelText(/^Nova senha\s*\*?$/), { target: { value: nova } });
  fireEvent.change(screen.getByLabelText(/^Confirme a nova senha\s*\*?$/), {
    target: { value: confirma },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar e entrar' }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste de senha provisória da oficina');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('login da oficina com senha provisória', () => {
  it('NÃO entra direto: mostra a etapa de troca, com a régua dita na tela', async () => {
    servidor({ 'POST /auth/login': () => json(respostaDeLogin(true)) });
    montar();

    entrarComSenha(SENHA_PROVISORIA);

    await screen.findByRole('heading', { name: 'Troque a senha provisória' });
    // Não navegou: a bandeira segura a entrada até a senha ser trocada.
    expect(screen.queryByText('BANCADA-DE-MENTIRA')).toBeNull();
    // A régua mínima é dita na tela, antes de qualquer erro.
    expect(screen.getByText(/m[íi]nimo de 8 caracteres/i)).toBeTruthy();
  });

  it('sem a bandeira, o mecânico entra direto — como sempre entrou', async () => {
    servidor({ 'POST /auth/login': () => json(respostaDeLogin(false)) });
    montar();

    entrarComSenha('senha-normal-8');

    await screen.findByText('BANCADA-DE-MENTIRA');
    expect(
      screen.queryByRole('heading', { name: 'Troque a senha provisória' }),
    ).toBeNull();
  });

  it('troca bem-sucedida entra na bancada com sessão RELOGADA — o refresh antigo já morreu no servidor', async () => {
    let logins = 0;
    const { chamadas } = servidor({
      'POST /auth/login': () => {
        logins += 1;
        // 1º login: senha provisória, bandeira levantada. 2º: já com a senha
        // nova, bandeira limpa e tokens NOVOS — porque a troca subiu
        // `session_version` e revogou o refresh anterior.
        return json(logins === 1 ? respostaDeLogin(true) : respostaDeLogin(false, '-novo'));
      },
      'POST /auth/password': () => new Response(null, { status: 204 }),
    });
    montar();

    await chegarNaEtapaDeTroca();
    preencherTroca(SENHA_PROVISORIA, SENHA_NOVA, SENHA_NOVA);

    await screen.findByText('BANCADA-DE-MENTIRA');

    // A troca viajou com as duas credenciais que o servidor exige.
    const troca = chamadas.find((c) => c.method === 'POST' && c.url.includes('/auth/password'));
    expect(troca?.body).toEqual({
      currentPassword: SENHA_PROVISORIA,
      newPassword: SENHA_NOVA,
    });

    // E a entrada foi RELOGADA com a senha nova — não a sessão provisória.
    const entradas = chamadas.filter(
      (c) => c.method === 'POST' && c.url.includes('/auth/login'),
    );
    expect(entradas).toHaveLength(2);
    expect((entradas[1].body as { password: string }).password).toBe(SENHA_NOVA);

    // A sessão guardada é a do segundo login: refresh vivo, não o revogado.
    const guardada = JSON.parse(localStorage.getItem('gs.session')!) as {
      refreshToken: string;
      user: { mustChangePassword?: boolean };
    };
    expect(guardada.refreshToken).toBe('r-1-novo');
    expect(guardada.user.mustChangePassword).toBe(false);
  });

  it('senha nova curta: a régua barra AQUI — o servidor nem é chamado', async () => {
    const { chamadas } = servidor({ 'POST /auth/login': () => json(respostaDeLogin(true)) });
    montar();

    await chegarNaEtapaDeTroca();
    preencherTroca(SENHA_PROVISORIA, 'curta', 'curta');

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/ao menos 8 caracteres/);
    expect(chamadas.filter((c) => c.url.includes('/auth/password'))).toHaveLength(0);
    // Continua na etapa, pronta para corrigir.
    expect(screen.getByRole('heading', { name: 'Troque a senha provisória' })).toBeTruthy();
  });

  it('confirmação diferente da nova: barra aqui e diz o quê', async () => {
    const { chamadas } = servidor({ 'POST /auth/login': () => json(respostaDeLogin(true)) });
    montar();

    await chegarNaEtapaDeTroca();
    preencherTroca(SENHA_PROVISORIA, SENHA_NOVA, 'OutraCoisa123');

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/confirma/i);
    expect(chamadas.filter((c) => c.url.includes('/auth/password'))).toHaveLength(0);
  });

  it('senha atual errada: o erro do servidor aparece legível, sem queimar refresh', async () => {
    const { chamadas } = servidor({
      'POST /auth/login': () => json(respostaDeLogin(true)),
      'POST /auth/password': () =>
        json({ error: { code: 'API_INVALID_CREDENTIALS', message: 'Senha atual incorreta.' } }, 401),
    });
    montar();

    await chegarNaEtapaDeTroca();
    preencherTroca('chute-errado', SENHA_NOVA, SENHA_NOVA);

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Senha atual incorreta.');
    // Continua na etapa — dá para tentar de novo.
    expect(screen.getByRole('heading', { name: 'Troque a senha provisória' })).toBeTruthy();
    expect(screen.queryByText('BANCADA-DE-MENTIRA')).toBeNull();

    /*
      NESTA rota, 401 é credencial extra errada — não access token vencido. Se
      o cliente tratasse como vencido, tentaria /auth/refresh e REENVIARIA a
      mesma senha errada: um refresh queimado por tentativa. Uma chamada só.
    */
    expect(chamadas.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(0);
    expect(chamadas.filter((c) => c.url.includes('/auth/password'))).toHaveLength(1);
  });

  it('recarregar no meio da etapa volta PARA A ETAPA — não para as credenciais', async () => {
    servidor({ 'POST /auth/login': () => json(respostaDeLogin(true)) });
    montar();
    await chegarNaEtapaDeTroca();

    /*
      O "reload": desmonta tudo e monta de novo, com a sessão provisória ainda
      guardada — que é exatamente o que o F5 faz. Se a porta reabrisse nas
      credenciais, a pessoa relogava com a MESMA senha provisória e a etapa
      virava um aviso que só aparece uma vez.
    */
    cleanup();
    montar();

    expect(screen.getByRole('heading', { name: 'Troque a senha provisória' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Usuário\s*\*?$/)).toBeNull();
    expect(screen.queryByText('BANCADA-DE-MENTIRA')).toBeNull();
  });

  it('"entrar com outra conta" abandona a sessão provisória e reabre as credenciais', async () => {
    servidor({ 'POST /auth/login': () => json(respostaDeLogin(true)) });
    montar();
    await chegarNaEtapaDeTroca();

    /*
      A saída de emergência. Sem ela, uma sessão provisória encalhada — a
      gestão reiniciou a senha DE NOVO, o access venceu — trancava a porta:
      o guarda manda toda rota para cá, e a etapa não tinha como ser vencida
      nem abandonada. Sair derruba a sessão local; a bandeira continua no
      servidor, então o próximo login provisório reabre a etapa.
    */
    fireEvent.click(screen.getByRole('button', { name: 'Entrar com outra conta' }));

    await screen.findByLabelText(/^Usuário\s*\*?$/);
    expect(screen.queryByRole('heading', { name: 'Troque a senha provisória' })).toBeNull();
    expect(localStorage.getItem('gs.session')).toBeNull();
  });
});
