/**
 * Porta da bancada.
 *
 * POR QUE UMA PÁGINA SEPARADA
 *
 * O mecânico entrava pela mesma tela do escritório e do balcão, numa terceira
 * aba, e por card — sem senha. Agora exige senha, e a tela é dele: uma
 * pergunta só, sem abas oferecendo Gestão e PDV para quem nunca vai usar
 * nenhum dos dois.
 *
 * ISTO É NAVEGAÇÃO, NÃO AUTORIZAÇÃO.
 *
 * A página não recusa outros perfis, e não deveria: quem autoriza é o servidor,
 * em cada requisição. Se um gerente digitar as credenciais dele aqui, entra e
 * vai para a casa DELE — `homeOf` decide pelo perfil, como em todo o resto do
 * sistema. Recusar aqui criaria uma segunda regra de acesso para manter em dia,
 * e duas verdades sobre quem entra onde acabam divergindo.
 *
 * `Protected` manda para cá quem tentar abrir rota de oficina sem sessão —
 * e também quem chegar com SENHA PROVISÓRIA: a mesma etapa de troca da porta
 * do escritório (`TrocaDeSenhaProvisoria`) segura o mecânico antes do app.
 * Sem ela, esta porta era a única por onde a senha que a gestão conhece
 * entrava direto.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '@/components/gs/ui';
import { TrocaDeSenhaProvisoria } from '@/components/gs/TrocaDeSenhaProvisoria';
import { casaDaSessao } from '@/lib/acesso/acesso';
import { ApiRequestError, getSession, login } from '@/lib/api/client';

export default function OficinaLoginPage() {
  const navigate = useNavigate();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
    A ETAPA DA SENHA PROVISÓRIA — a mesma das duas portas; aqui só se decide
    QUANDO mostrá-la. Ela abre pelo login desta visita OU por uma sessão
    guardada que já carrega a bandeira: `Protected` manda a sessão provisória
    para cá em vez de deixá-la navegar, e reabrir no formulário faria o
    mecânico relogar com a MESMA senha provisória, como se nada devesse.
  */
  const [etapa, setEtapa] = useState<'credenciais' | 'trocaSenha'>(() =>
    getSession()?.user.mustChangePassword ? 'trocaSenha' : 'credenciais',
  );

  // Erro da API traz a mensagem do servidor; qualquer outra coisa é falha de
  // rede — e a orientação útil na bancada é chamar quem cuida do sistema.
  const describeError = (err: unknown) =>
    err instanceof ApiRequestError
      ? err.message
      : 'Não foi possível conectar ao servidor. Avise a gestão.';

  const submit = async (event: React.FormEvent) => {
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
      navigate(casaDaSessao(session), { replace: true });
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

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--gs-canvas)]">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <p className="uppercase tracking-[0.2em] text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
            Grupo Sampaio
          </p>
          <h1 className="text-[32px] leading-tight font-bold text-[var(--gs-purple-800)] mt-2 mb-1">
            Oficina
          </h1>
          <p className="text-[length:var(--gs-text-base)] text-[var(--gs-muted)] m-0">
            Acesso da bancada
          </p>
        </div>

        {etapa === 'trocaSenha' ? (
          // A etapa toma o lugar do formulário — e do atalho para a outra
          // porta. Quem está aqui tem UMA tarefa antes do app.
          <TrocaDeSenhaProvisoria
            descreverErro={describeError}
            aoFalharReentrada={voltarParaCredenciais}
            aoSairParaOutraConta={() => voltarParaCredenciais(null)}
          />
        ) : (
          <>
            <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] shadow-[var(--gs-shadow-md)] p-6">
              {error && (
                <div
                  role="alert"
                  className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
                >
                  {error}
                </div>
              )}

              <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
                <Field label="Usuário" required>
                  {(props) => (
                    <Input
                      {...props}
                      value={loginName}
                      onChange={(e) => setLoginName(e.target.value)}
                      autoComplete="username"
                      autoFocus
                      placeholder="seu login"
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
            </div>

            <p className="text-center text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-5 mb-0">
              Gestão e balcão entram{' '}
              <Link
                to="/login"
                className="text-[var(--gs-purple-700)] font-semibold no-underline hover:underline"
              >
                por aqui
              </Link>
              .
            </p>
          </>
        )}
      </div>
    </div>
  );
}
