/**
 * Tela de acesso do Grupo Sampaio.
 *
 * Dois contextos, e os DOIS exigem senha: Gestão e PDV. Não há outra entrada.
 *
 * O único caminho que dispensa digitar a senha é o TOKEN DE TERMINAL: o
 * dispositivo é registrado uma vez por um administrador, guarda um token opaco
 * e o token é revogável. Quem autoriza é o cadastro do terminal.
 *
 * A EQUIPE DA OFICINA NÃO ENTRA POR AQUI. Tem porta própria em
 * `/oficina/login` — a bancada não deve encarar um formulário que oferece
 * escritório e balcão.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '@/components/gs/ui';
import { EsqueciMinhaSenha } from '@/components/gs/EsqueciMinhaSenha';
import { TrocaDeSenhaProvisoria } from '@/components/gs/TrocaDeSenhaProvisoria';
import { casaDaSessao } from '@/lib/acesso/acesso';
import {
  ApiRequestError,
  getSession,
  login,
  loginWithDeviceToken,
} from '@/lib/api/client';

type Tab = 'gestao' | 'pdv';

const TABS: { id: Tab; label: string; hint: string }[] = [
  {
    id: 'gestao',
    label: 'Gestão',
    /*
      A CONTABILIDADE ENTRA POR AQUI, e a linha diz isso.

      A aba é rótulo — ela não filtra perfil nenhum, e as duas mandam o mesmo
      formulário para a mesma rota. Mas o contador é gente de FORA: ele lê
      "Gerentes e administração do grupo", conclui que errou de endereço e
      liga para a loja perguntando qual é o portal dele. Uma terceira aba
      seria pior — sugeriria um portal separado, que é exatamente a decisão
      que esta rodada recusou ao fazer dele um perfil de `core_users`.
    */
    hint: 'Gerentes, administração do grupo e contabilidade',
  },
  {
    id: 'pdv',
    label: 'PDV',
    hint: 'Ponto de venda das operações',
  },
];

/**
 * O campo não sugere login de ninguém. Os exemplos que ficavam aqui eram
 * logins que existem no banco de demonstração — escritos na porta de entrada
 * para quem quisesse tentar.
 */
const PLACEHOLDER_DO_LOGIN = 'seu login';

const DEVICE_TOKEN_KEY = 'gs.deviceToken';

/**
 * Para onde cada perfil vai depois de autenticar.
 *
 * Delega a `environments.ts`, que é a fonte única. Aqui havia uma SEGUNDA
 * cópia do mapeamento (`startsWith('operador_caixa')`, `mecanico`…) — duas
 * verdades sobre a mesma coisa acabam divergindo, e a divergência apareceria
 * como "entrei e caí na tela errada", ou pior: o login mandando para uma rota
 * que o guarda devolve, num pingue-pongue.
 *
 * Acesso personalizado na tela de Usuários: a casa é a que o servidor calculou
 * (a primeira tela liberada) — ver `casaDaSessao`.
 */
const destinationFor = casaDaSessao;

export default function LoginPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('gestao');
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
    A ETAPA DA SENHA PROVISÓRIA — a régua mora em `TrocaDeSenhaProvisoria`,
    compartilhada com a porta da bancada; aqui só se decide QUANDO mostrá-la.

    Ela abre por dois caminhos, e o segundo é o que fecha o buraco do F5:

      - o login desta visita devolveu `user.mustChangePassword` — o caso de
        `submitCredentials`;
      - a sessão GUARDADA já carrega a bandeira. `Protected` manda a sessão
        provisória para cá em vez de deixá-la navegar, e reabrir a porta no
        formulário de credenciais faria a pessoa relogar com a MESMA senha
        provisória — a etapa viraria um aviso que só aparece uma vez.
  */
  const [etapa, setEtapa] = useState<'credenciais' | 'trocaSenha'>(() =>
    getSession()?.user.mustChangePassword ? 'trocaSenha' : 'credenciais',
  );

  const deviceToken = (() => {
    try {
      return localStorage.getItem(DEVICE_TOKEN_KEY);
    } catch {
      return null;
    }
  })();

  // Erro da API traz a mensagem do servidor; qualquer outra coisa é falha de
  // rede, e aí a orientação útil é sobre a API não estar no ar.
  const describeError = (err: unknown) =>
    err instanceof ApiRequestError
      ? err.message
      : 'Não foi possível conectar ao servidor. Verifique se a API está em execução '
        + '(npm run dev:api) e se VITE_API_BASE_URL aponta para ela.';

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await login(loginName.trim(), password);
      if (session.user.mustChangePassword) {
        // Senha provisória: nada de app antes da troca. Os campos da etapa
        // começam vazios de propósito — digitar a atual de novo é a
        // credencial extra que a rota exige, não burocracia da tela.
        setEtapa('trocaSenha');
        return;
      }
      navigate(destinationFor(session), { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // A etapa terminou sem sessão de pé — reentrada falhou, ou a pessoa saiu
  // para entrar com outra conta. Volta ao formulário, com a senha zerada.
  const voltarParaCredenciais = (mensagem: string | null) => {
    setEtapa('credenciais');
    setPassword('');
    setError(mensagem);
  };

  const submitDevice = async () => {
    if (!deviceToken) return;
    setError(null);
    setBusy(true);
    try {
      const session = await loginWithDeviceToken(deviceToken);
      navigate(destinationFor(session), { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      <aside
        className="lg:w-[40%] px-8 py-12 lg:py-0 flex flex-col justify-center text-white"
        style={{ background: 'var(--gs-header-gradient)' }}
      >
        <div className="max-w-md mx-auto lg:mx-0">
          <p className="uppercase tracking-[0.2em] text-[length:var(--gs-text-sm)] opacity-80 m-0">
            Sistema de gestão
          </p>
          <h1 className="text-[40px] leading-tight font-bold mt-2 mb-3">GRUPO SAMPAIO</h1>
          <p className="text-[length:var(--gs-text-lg)] opacity-90 m-0">Gestão Empresarial</p>
          <p className="text-[length:var(--gs-text-base)] opacity-75 mt-6 mb-0">
            Estoque, vendas, caixa, financeiro e oficina das operações do grupo em um só lugar.
          </p>
        </div>
      </aside>

      <main className="flex-1 flex items-center justify-center p-6 bg-[var(--gs-canvas)]">
        {etapa === 'trocaSenha' ? (
          /*
            A etapa toma a coluna inteira: sem abas, sem atalho de terminal.
            Quem está aqui tem UMA tarefa antes do app.
          */
          <div className="w-full max-w-lg">
            <TrocaDeSenhaProvisoria
              descreverErro={describeError}
              aoFalharReentrada={voltarParaCredenciais}
              aoSairParaOutraConta={() => voltarParaCredenciais(null)}
            />
          </div>
        ) : (
        <div className="w-full max-w-lg">
          <div
            role="tablist"
            aria-label="Formas de acesso"
            className="flex gap-1 p-1 bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius)] mb-6"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setError(null);
                }}
                className={`flex-1 px-3 py-2 rounded-[var(--gs-radius-sm)] border-0 cursor-pointer
                  text-[length:var(--gs-text-sm)] font-semibold transition-colors ${
                    tab === t.id
                      ? 'bg-[var(--gs-surface)] text-[var(--gs-purple-800)] shadow-[var(--gs-shadow-sm)]'
                      : 'bg-transparent text-[var(--gs-muted)]'
                  }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] shadow-[var(--gs-shadow-md)] p-6">
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-5">
              {current.hint}
            </p>

            {error && (
              <div
                role="alert"
                className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
              >
                {error}
              </div>
            )}

            <form onSubmit={(e) => void submitCredentials(e)} className="flex flex-col gap-4">
              <Field label="Usuário" required>
                {(props) => (
                  <Input
                    {...props}
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    placeholder={PLACEHOLDER_DO_LOGIN}
                  />
                )}
              </Field>
              <Field label="Senha" required>
                {(props) => (
                  <Input
                    {...props}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                )}
              </Field>
              <Button type="submit" size="lg" loading={busy}>
                Entrar
              </Button>
            </form>

            {/*
              ESQUECI MINHA SENHA (GAP-PRD-160): só aparece quando o servidor diz
              que o caminho existe (alguma operação ligou e há SMTP). Sem isso,
              a senha continua sendo redefinida pela gerência.
            */}
            <EsqueciMinhaSenha />

            {/*
              O token de terminal só aparece na aba do PDV e só quando ESTE
              computador já foi registrado. Oferecer o botão sem token seria
              prometer um atalho que devolve erro.
            */}
            {tab === 'pdv' && deviceToken && (
              <div className="mt-6 pt-5 border-t border-[var(--gs-border)]">
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-3">
                  Este computador está registrado como terminal confiável.
                </p>
                <Button
                  size="lg"
                  variant="success"
                  loading={busy}
                  onClick={() => void submitDevice()}
                >
                  Entrar no PDV deste terminal
                </Button>
              </div>
            )}
          </div>

          <p className="text-center text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-5 mb-2">
            É da bancada?{' '}
            <Link
              to="/oficina/login"
              className="text-[var(--gs-purple-700)] font-semibold no-underline hover:underline"
            >
              Entrar pela Oficina
            </Link>
          </p>
          <p className="text-center text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-0">
            Grupo Sampaio · Gestão Empresarial
          </p>
        </div>
        )}
      </main>
    </div>
  );
}
