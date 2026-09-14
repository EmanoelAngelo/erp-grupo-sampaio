/**
 * ACESSO NEGADO — a tela que a URL digitada (ou o link velho) mostra quando o
 * acesso da pessoa não inclui aquela página (RBAC granular). Não redireciona
 * calado para outra tela: diz o que aconteceu e oferece a saída — a casa dela.
 *
 * Esconder a página não é a proteção: o servidor recusa com 403 de qualquer
 * jeito. Esta tela só evita que a pessoa monte uma página que não vai carregar.
 */
import { Link } from 'react-router-dom';
import { useSession } from '@/hooks/useSession';
import { homeOf } from '@/router/environments';

export default function AcessoNegadoPage() {
  const session = useSession();
  const casa = session?.access?.casa && session.access.casa !== '/sem-acesso'
    ? session.access.casa
    : session ? homeOf(session.user.profileCode) : '/login';
  const semNenhuma = session?.access?.casa === '/sem-acesso';
  return (
    <main
      role="main"
      aria-labelledby="acesso-negado-titulo"
      className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16 text-[var(--gs-text)]"
    >
      <h1 id="acesso-negado-titulo" className="text-[length:var(--gs-text-xl)] font-semibold">
        Acesso negado
      </h1>
      <p>
        {semNenhuma
          ? 'Seu usuário ainda não tem nenhuma página liberada nesta empresa. Peça a quem administra os usuários para liberar o que você usa.'
          : 'Esta página não está no seu acesso nesta empresa. Se você precisa dela, peça a quem administra os usuários.'}
      </p>
      {!semNenhuma && (
        <p>
          <Link to={casa} className="font-semibold underline">
            Voltar para a minha página inicial
          </Link>
        </p>
      )}
    </main>
  );
}
