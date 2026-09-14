/**
 * Endereço que não existe.
 *
 * A página anterior era resíduo do gerador: dizia, em inglês, "This page has
 * not been generated — tell me more about this page, so I can generate it".
 * Quem digitasse um endereço errado no balcão leria uma mensagem dirigida a
 * quem escreveu o sistema, não a quem usa.
 *
 * Aqui não há menu nem casca: o caminho não existe, então não se sabe em que
 * ambiente a pessoa deveria estar. O que dá para oferecer é a volta.
 */
import { Link, useLocation } from 'react-router-dom';

export default function NaoEncontradaPage() {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-[var(--gs-canvas)] flex flex-col items-center justify-center px-4 text-center">
      <p className="m-0 font-bold text-[22px] tracking-tight">GRUPO SAMPAIO</p>
      <h1 className="mt-6 mb-0 text-[length:var(--gs-text-xl)] font-semibold">
        Esta página não existe.
      </h1>
      <p className="mt-2 mb-0 font-mono text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        {pathname}
      </p>
      <p className="mt-4 mb-0 text-[var(--gs-muted)]">
        Confira o endereço. Se você chegou aqui por um link do próprio sistema, avise quem cuida
        dele — link interno quebrado é defeito, não engano de quem clicou.
      </p>
      <Link
        to="/"
        className="mt-6 font-semibold text-[var(--gs-purple-700)] no-underline"
      >
        Voltar ao início
      </Link>
    </div>
  );
}
