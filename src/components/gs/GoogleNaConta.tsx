/**
 * "Entrar com Google" dentro da conta (GAP-PRD-027): ligar, ver e desligar.
 *
 * Quem tem conta com e-mail e senha liga o Google para entrar em um clique —
 * inclusive um Google de outro e-mail. Quem criou a conta pelo Google vê que
 * ainda não tem senha e como criar uma (a recuperação, que vai para a caixa
 * provada). Desligar o Google da conta sem senha é recusado pelo servidor,
 * e a tela diz antes por quê.
 *
 * Some inteiro quando a loja não oferece o Google e a conta não está ligada:
 * uma seção que só leva a erro não ajuda ninguém.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';
import { googlePortalApi, guardarIda, type GoogleNaConta as Estado } from '@/lib/api/loginGoogle';

function irPara(url: string): void {
  window.location.assign(url);
}

export function GoogleNaConta({ token, navegar = irPara }: { token: string; navegar?: (url: string) => void }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await googlePortalApi.naConta(token);
      // Corpo sem o formato combinado é tratado como "nada a mostrar".
      setEstado(r && typeof r.disponivel === 'boolean' ? r : null);
    } catch {
      setEstado(null);
    }
  }, [token]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (!estado || (!estado.disponivel && !estado.ligado)) return null;

  const ligar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const inicio = await googlePortalApi.iniciar({ intent: 'vincular', returnTo: '/minha-conta' }, token);
      guardarIda({ browserKey: inicio.browserKey, intent: 'vincular', returnTo: '/minha-conta', em: Date.now() });
      navegar(inicio.authorizationUrl);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível abrir o Google agora.');
      setOcupado(false);
    }
  };

  const desligar = async () => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      setEstado(await googlePortalApi.desligar(token));
      setAviso('O Google foi desligado. A conta segue entrando com e-mail e senha.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível desligar agora.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <section
      aria-label="Entrar com Google"
      className="mt-8 pt-6 border-t border-[var(--gs-border)]"
      data-testid="google-na-conta"
    >
      <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mb-2">
        Entrar com Google
      </h2>

      {estado.ligado ? (
        <p className="text-[length:var(--gs-text-sm)] mt-0 mb-3">
          Ligado à conta Google <strong>{estado.ligado.email ?? '—'}</strong> desde{' '}
          {dataBR(estado.ligado.desde)}.
        </p>
      ) : (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-3">
          Ligue a sua conta Google para entrar em um clique, sem digitar senha aqui. Pode ser um Google
          de outro e-mail.
        </p>
      )}

      {!estado.temSenha && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-3">
          Esta conta ainda não tem senha — ela entra pelo Google. Para criar uma senha, saia e use
          "Esqueci minha senha" na tela de entrar: o link chega no seu e-mail.
        </p>
      )}

      {estado.ligado ? (
        <button
          type="button"
          onClick={() => void desligar()}
          disabled={ocupado || !estado.temSenha}
          title={estado.temSenha ? undefined : 'Crie uma senha antes: sem ela a conta ficaria sem entrada.'}
          className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
        >
          Desligar o Google
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void ligar()}
          disabled={ocupado}
          className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
        >
          Ligar minha conta Google
        </button>
      )}
      {estado.modo === 'teste' && (
        <span className="block mt-2 text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
          Ambiente de ensaio: usa o provedor de TESTE, não o Google de verdade.
        </span>
      )}

      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] mt-2 mb-0">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-[length:var(--gs-text-sm)] mt-2 mb-0">
          {aviso}
        </p>
      )}
    </section>
  );
}
