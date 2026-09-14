/**
 * O botão "Entrar com Google" da tela de entrar (GAP-PRD-027).
 *
 * Só aparece quando o servidor diz que a loja oferece — sem configuração, a
 * tela de entrar fica como sempre foi, sem botão que leva a um erro. O botão
 * pede ao servidor o endereço do Google, guarda na aba a chave do navegador
 * e sai para o Google; a volta cai em `/minha-conta/google`
 * (`RetornoDoGooglePage`), que conclui.
 *
 * Nenhuma senha do Google passa por aqui: quem digita a senha é a página do
 * próprio Google.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { googlePortalApi, guardarIda, type ModoDoGoogle } from '@/lib/api/loginGoogle';

/** Sair do site é efeito do navegador — separado para o teste poder olhar. */
function irPara(url: string): void {
  window.location.assign(url);
}

export function EntrarComGoogle({
  termsAccepted,
  returnTo,
  rotulo = 'Entrar com Google',
  navegar = irPara,
}: {
  /** O aceite marcado na tela de CRIAR — viaja como booleano. */
  termsAccepted?: boolean;
  /** Para onde voltar depois (o carrinho, quando veio de lá). */
  returnTo?: string | null;
  rotulo?: string;
  navegar?: (url: string) => void;
}) {
  const [modo, setModo] = useState<ModoDoGoogle | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    googlePortalApi
      .disponivel()
      .then((r) => {
        // Corpo sem o sim explícito é "não": botão que leva a erro é pior
        // que botão nenhum.
        if (vivo) setModo(r && r.disponivel === true ? (r.modo ?? 'google') : null);
      })
      .catch(() => {
        if (vivo) setModo(null);
      });
    return () => {
      vivo = false;
    };
  }, []);

  if (!modo) return null;

  const ir = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const inicio = await googlePortalApi.iniciar({
        intent: 'entrar',
        termsAccepted: termsAccepted === true,
        returnTo: returnTo ?? null,
      });
      guardarIda({ browserKey: inicio.browserKey, intent: 'entrar', returnTo: returnTo ?? null, em: Date.now() });
      navegar(inicio.authorizationUrl);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível abrir o Google agora.');
      setOcupado(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="entrar-com-google">
      <div className="flex items-center gap-3 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
        <span className="flex-1 border-t border-[var(--gs-border)]" aria-hidden />
        ou
        <span className="flex-1 border-t border-[var(--gs-border)]" aria-hidden />
      </div>
      <button
        type="button"
        onClick={() => void ir()}
        disabled={ocupado}
        className="bg-[var(--gs-surface)] border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]
          px-4 py-3 cursor-pointer font-semibold text-[var(--gs-text)] disabled:opacity-50
          flex items-center justify-center gap-2"
      >
        <span aria-hidden className="font-bold text-[var(--gs-purple-700)]">G</span>
        {ocupado ? 'Abrindo o Google…' : rotulo}
      </button>
      {modo === 'teste' && (
        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
          Ambiente de ensaio: este botão usa o provedor de TESTE, não o Google de verdade.
        </span>
      )}
      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
        Criou a conta pelo Google? Entre por este botão — a sua senha do Google é digitada só na página
        do Google.
      </span>
      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}
    </div>
  );
}
