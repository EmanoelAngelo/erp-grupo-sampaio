/**
 * Redefinir a senha a partir do link do e-mail.
 *
 * O token vem na URL (`?token=...`) — é a credencial desta tela, e é o que o
 * cliente recebeu no e-mail de recuperação. A tela só pede a nova senha; quem
 * confere o token é o servidor, que o aceita UMA vez e por uma hora.
 *
 * Sem token na URL, não há o que fazer: a tela diz isso em vez de mostrar um
 * formulário que falharia no envio.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { CascaDaLoja } from '@/components/gs/CascaDaLoja';
import { SenhaNovaComConfirmacao } from '@/components/gs/SenhaNova';
import { problemaDaSenhaNova } from '@/lib/senhaNova';

export default function RedefinirSenhaPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();

  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [pronto, setPronto] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    // Digitada duas vezes, conferida antes de gastar o link (GAP-PRD-192).
    const problema = problemaDaSenhaNova(senha, confirmacao);
    if (problema) {
      setErro(problema);
      return;
    }
    setOcupado(true);
    setErro(null);
    try {
      await apiRequest('/loja/portal/redefinir-senha', {
        method: 'POST',
        anonymous: true,
        body: { token, password: senha },
      });
      setPronto(true);
      // Leva para o login depois de um instante para a pessoa entrar com a nova.
      setTimeout(() => navigate('/minha-conta'), 1800);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível redefinir a senha.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <CascaDaLoja larguraMax="max-w-4xl">
      <div className="max-w-md mx-auto bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-6">
        <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] mt-0 mb-1">
          Nova senha
        </h1>

        {!token ? (
          <>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Este link está incompleto. Peça a recuperação de novo na sua conta.
            </p>
            <Link to="/minha-conta" className="text-[var(--gs-purple-700)] underline">
              Ir para a conta
            </Link>
          </>
        ) : pronto ? (
          <p role="status" className="text-[var(--gs-success)]">
            Senha redefinida. Levando você para o login…
          </p>
        ) : (
          <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-3">
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-1">
              Escolha uma nova senha para a sua conta.
            </p>
            <SenhaNovaComConfirmacao
              rotulo="Nova senha"
              rotuloConfirmacao="Confirme a nova senha"
              senha={senha}
              confirmacao={confirmacao}
              onSenha={setSenha}
              onConfirmacao={setConfirmacao}
            />
            {erro && (
              <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">
                {erro}
              </p>
            )}
            <button
              type="submit"
              disabled={ocupado}
              className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white border-0
                rounded-[var(--gs-radius)] px-4 py-3 cursor-pointer font-semibold disabled:opacity-50"
            >
              {ocupado ? 'Aguarde…' : 'Redefinir senha'}
            </button>
          </form>
        )}
      </div>
    </CascaDaLoja>
  );
}
