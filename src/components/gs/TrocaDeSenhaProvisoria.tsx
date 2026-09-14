/**
 * A etapa da senha provisória — UMA etapa, para as DUAS portas.
 *
 * O login devolve `user.mustChangePassword` quando a senha que entrou foi
 * criada (ou reiniciada) pela gestão — ou seja, OUTRA pessoa a conhece.
 * Entrar direto era deixar essa senha valendo sem aviso; a etapa segura a
 * entrada até `POST /auth/password` trocá-la. A sessão emitida pelo login
 * provisório fica de pé enquanto isso: é ela que autentica a troca.
 *
 * POR QUE COMPONENTE, e não um bloco em cada tela: a etapa nasceu dentro da
 * `LoginPage`, e a porta da bancada (`/oficina/login`) ficou de fora — o
 * mecânico com senha provisória entrava direto, pela única porta por onde
 * mecânico entra. Duas cópias da etapa seriam duas réguas para divergir no
 * primeiro ajuste; aqui a régua é uma e as portas só decidem QUANDO mostrá-la.
 *
 * POR QUE RELOGAR, em vez de seguir com a sessão que já está na mão:
 *
 * A troca sobe `session_version` no servidor, o que REVOGA todos os refresh
 * tokens — inclusive o da sessão provisória que acabou de pedir a troca
 * (decisão de lá: se a senha vazou, a sessão do ladrão não pode sobreviver ao
 * gesto). E o access atual cai na requisição seguinte — o servidor confere a
 * versão da sessão a cada requisição (GAP-PRD-053). Relogar com a senha nova emite a
 * sessão COMPLETA — access e refresh vivos — e volta com a bandeira já limpa.
 * O login da reentrada vem da SESSÃO (`user.login`), não do formulário: quando
 * a pessoa chega aqui por um F5 — o guarda de rota manda a sessão provisória
 * para a porta, e a porta abre nesta etapa —, o campo de usuário nunca foi
 * digitado nesta visita.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Field, Input } from '@/components/gs/ui';
import { casaDaSessao } from '@/lib/acesso/acesso';
import { getSession, login, logout, trocarPropriaSenha } from '@/lib/api/client';

/**
 * A régua da senha nova — a MESMA do servidor (`assertPassword`, que conta os
 * caracteres depois do trim). Conferir aqui poupa a viagem e diz o motivo na
 * tela; quem manda continua sendo o servidor.
 */
const MINIMO_SENHA_NOVA = 8;

export function TrocaDeSenhaProvisoria({
  descreverErro,
  aoFalharReentrada,
  aoSairParaOutraConta,
}: {
  /** Cada porta descreve falha de rede do seu jeito; erro da API fala por si. */
  descreverErro: (err: unknown) => string;
  /**
   * A senha JÁ FOI trocada e só a reentrada automática falhou. A porta volta
   * ao formulário de credenciais com esta mensagem — dizer isso com todas as
   * letras evita a pessoa "trocar de novo": a senha atual agora é a nova.
   */
  aoFalharReentrada: (mensagem: string) => void;
  /**
   * A saída de emergência levou a sessão embora; a porta volta às credenciais.
   *
   * Sem ela, uma sessão provisória ENCALHADA — a gestão reiniciou a senha de
   * novo, ou o access venceu — trancava a porta para sempre: o guarda de rota
   * manda toda rota protegida para cá, e a etapa não tinha como ser vencida
   * nem abandonada. Sair não pula nada: a bandeira mora no servidor, e o
   * próximo login provisório reabre a etapa.
   */
  aoSairParaOutraConta: () => void;
}) {
  const navigate = useNavigate();
  const [senhaAtual, setSenhaAtual] = useState('');
  const [senhaNova, setSenhaNova] = useState('');
  const [senhaConfirma, setSenhaConfirma] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (senhaNova.trim().length < MINIMO_SENHA_NOVA) {
      setError(`A nova senha precisa ter ao menos ${MINIMO_SENHA_NOVA} caracteres.`);
      return;
    }
    if (senhaNova !== senhaConfirma) {
      setError('A confirmação não confere com a nova senha. Digite as duas iguais.');
      return;
    }
    setBusy(true);
    try {
      await trocarPropriaSenha(senhaAtual, senhaNova);
    } catch (err) {
      // "Senha atual incorreta." do servidor chega aqui como veio — legível,
      // e a etapa continua de pé para tentar de novo.
      setError(descreverErro(err));
      setBusy(false);
      return;
    }
    // O login canônico vem da sessão que autenticou a troca — ver o cabeçalho.
    const loginDaSessao = getSession()?.user.login ?? '';
    try {
      const session = await login(loginDaSessao, senhaNova);
      navigate(casaDaSessao(session), { replace: true });
    } catch {
      aoFalharReentrada(
        'Senha trocada com sucesso, mas não foi possível entrar automaticamente. '
          + 'Entre novamente com a nova senha.',
      );
    } finally {
      setBusy(false);
    }
  };

  const sair = async () => {
    setBusy(true);
    // `logout` derruba a sessão local mesmo com o servidor fora do ar.
    await logout();
    setBusy(false);
    aoSairParaOutraConta();
  };

  return (
    <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] shadow-[var(--gs-shadow-md)] p-6">
      <h2 className="mt-0 mb-2 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
        Troque a senha provisória
      </h2>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-5">
        A senha que você usou foi criada pela gestão — ela é provisória, e outra
        pessoa a conhece. Defina uma senha só sua para continuar.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
        >
          {error}
        </div>
      )}

      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Senha atual" required>
          {(props) => (
            <Input
              {...props}
              type="password"
              value={senhaAtual}
              onChange={(e) => setSenhaAtual(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          )}
        </Field>
        <Field
          label="Nova senha"
          required
          hint={`Mínimo de ${MINIMO_SENHA_NOVA} caracteres.`}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              value={senhaNova}
              onChange={(e) => setSenhaNova(e.target.value)}
              autoComplete="new-password"
            />
          )}
        </Field>
        <Field label="Confirme a nova senha" required>
          {(props) => (
            <Input
              {...props}
              type="password"
              value={senhaConfirma}
              onChange={(e) => setSenhaConfirma(e.target.value)}
              autoComplete="new-password"
            />
          )}
        </Field>
        <Button type="submit" size="lg" loading={busy}>
          Salvar e entrar
        </Button>
      </form>

      <p className="text-center text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-5 mb-0">
        Não é a sua conta?{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() => void sair()}
          className="bg-transparent border-0 p-0 cursor-pointer text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)] font-semibold no-underline hover:underline"
        >
          Entrar com outra conta
        </button>
      </p>
    </div>
  );
}
