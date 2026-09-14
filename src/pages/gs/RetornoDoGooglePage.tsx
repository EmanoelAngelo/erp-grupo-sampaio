/**
 * A volta do Google — `/minha-conta/google` (GAP-PRD-027).
 *
 * É o endereço de retorno cadastrado no cliente OAuth. O Google devolve a
 * pessoa para cá com `code` e `state` na URL; esta tela manda os dois ao
 * servidor junto com a CHAVE DO NAVEGADOR que a aba guardou na ida, e o
 * servidor faz o resto (troca o código, confere o id_token, decide a conta).
 *
 * TRÊS DESFECHOS:
 *   - sessão: guarda a sessão do portal e segue para onde a pessoa ia (o
 *     carrinho, quando veio de lá) ou para "Minha conta";
 *   - conta nova sem o aceite: pede o aceite dos termos aqui mesmo;
 *   - Google ligado a uma conta já aberta: diz que ligou e volta à conta.
 *
 * O `code` da URL vale uma vez: a tela manda UMA vez (o React em modo estrito
 * monta duas) e tira o código da barra de endereço assim que usa.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CascaDaLoja } from '@/components/gs/CascaDaLoja';
import { ApiRequestError } from '@/lib/api/client';
import { esquecerIda, googlePortalApi, lerIda, voltaInterna } from '@/lib/api/loginGoogle';
import { guardarSessaoPortal, tokenDoPortal, type SessaoPortal } from '@/lib/portalSession';

type Etapa =
  | { tipo: 'concluindo' }
  | { tipo: 'erro'; mensagem: string }
  | { tipo: 'recusado' }
  | { tipo: 'termos'; ticket: string; browserKey: string; email: string; name: string | null; returnTo: string | null }
  | { tipo: 'vinculado'; googleEmail: string };

export default function RetornoDoGooglePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [etapa, setEtapa] = useState<Etapa>({ tipo: 'concluindo' });
  const [aceitei, setAceitei] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const enviado = useRef(false);

  const code = params.get('code');
  const state = params.get('state');
  const erroDoGoogle = params.get('error');

  useEffect(() => {
    if (enviado.current) return;
    enviado.current = true;

    const entrar = (sessao: SessaoPortal, returnTo: string | null) => {
      guardarSessaoPortal(sessao);
      esquecerIda();
      navigate(voltaInterna(returnTo) ?? '/minha-conta', { replace: true });
    };

    if (erroDoGoogle) {
      esquecerIda();
      setEtapa(erroDoGoogle === 'access_denied' ? { tipo: 'recusado' } : { tipo: 'erro', mensagem: 'O Google não concluiu a entrada. Tente de novo.' });
      return;
    }
    const ida = lerIda();
    if (!code || !state) {
      setEtapa({ tipo: 'erro', mensagem: 'Não há entrada pelo Google para concluir aqui.' });
      return;
    }
    if (!ida) {
      setEtapa({
        tipo: 'erro',
        mensagem:
          'Esta volta do Google não começou neste navegador (ou demorou demais). Por segurança, comece de novo por aqui.',
      });
      return;
    }
    // O código sai da barra de endereço já: ele vale uma vez e não precisa
    // ficar no histórico.
    window.history.replaceState(null, '', window.location.pathname);

    googlePortalApi
      .concluir(
        { code, state, browserKey: ida.browserKey },
        ida.intent === 'vincular' ? tokenDoPortal() : null,
      )
      .then((r) => {
        if (r.status === 'sessao') {
          entrar(r.session, r.returnTo ?? ida.returnTo);
          return;
        }
        if (r.status === 'vinculado') {
          esquecerIda();
          setEtapa({ tipo: 'vinculado', googleEmail: r.googleEmail });
          return;
        }
        setEtapa({
          tipo: 'termos',
          ticket: r.ticket,
          browserKey: ida.browserKey,
          email: r.email,
          name: r.name,
          returnTo: r.returnTo ?? ida.returnTo,
        });
      })
      .catch((err) => {
        esquecerIda();
        setEtapa({
          tipo: 'erro',
          mensagem: err instanceof ApiRequestError ? err.message : 'Não foi possível concluir a entrada pelo Google.',
        });
      });
  }, [code, state, erroDoGoogle, navigate]);

  const aceitar = async () => {
    if (etapa.tipo !== 'termos') return;
    setOcupado(true);
    try {
      const r = await googlePortalApi.aceitarTermos({
        ticket: etapa.ticket,
        browserKey: etapa.browserKey,
        termsAccepted: aceitei,
      });
      guardarSessaoPortal(r.session);
      esquecerIda();
      navigate(voltaInterna(r.returnTo ?? etapa.returnTo) ?? '/minha-conta', { replace: true });
    } catch (err) {
      setEtapa({
        tipo: 'erro',
        mensagem: err instanceof ApiRequestError ? err.message : 'Não foi possível criar a conta agora.',
      });
    } finally {
      setOcupado(false);
    }
  };

  return (
    <CascaDaLoja larguraMax="max-w-4xl">
      <div className="max-w-md mx-auto bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-6">
        <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] mt-0 mb-3">
          Entrar com Google
        </h1>

        {etapa.tipo === 'concluindo' && (
          <p role="status" className="m-0 text-[var(--gs-muted)]">
            Conferindo com o Google…
          </p>
        )}

        {etapa.tipo === 'recusado' && (
          <>
            <p className="mt-0">Você cancelou a entrada pelo Google. Nada foi alterado.</p>
            <Link to="/minha-conta" className="text-[var(--gs-purple-700)] font-semibold">
              Voltar para entrar
            </Link>
          </>
        )}

        {etapa.tipo === 'erro' && (
          <>
            <p role="alert" className="mt-0 text-[var(--gs-danger)]">
              {etapa.mensagem}
            </p>
            <Link to="/minha-conta" className="text-[var(--gs-purple-700)] font-semibold">
              Voltar para entrar
            </Link>
          </>
        )}

        {etapa.tipo === 'vinculado' && (
          <>
            <p role="status" className="mt-0">
              Pronto: a sua conta agora também entra pelo Google <strong>{etapa.googleEmail}</strong>.
            </p>
            <Link to="/minha-conta" className="text-[var(--gs-purple-700)] font-semibold">
              Voltar para a minha conta
            </Link>
          </>
        )}

        {etapa.tipo === 'termos' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void aceitar();
            }}
            className="flex flex-col gap-3"
          >
            <p className="m-0">
              O Google confirmou <strong>{etapa.email}</strong>
              {etapa.name ? ` (${etapa.name})` : ''}. Ainda não há conta com esse e-mail — falta só o
              seu aceite para criá-la.
            </p>
            <label className="flex items-start gap-2 text-[length:var(--gs-text-sm)]">
              <input
                type="checkbox"
                checked={aceitei}
                onChange={(e) => setAceitei(e.target.checked)}
                aria-label="Aceito os termos e a política de privacidade"
                className="mt-1"
              />
              <span>
                Li e aceito os{' '}
                <Link to="/termos-de-uso" target="_blank">
                  Termos de Uso
                </Link>{' '}
                e a{' '}
                <Link to="/politica-de-privacidade" target="_blank">
                  Política de Privacidade
                </Link>
                . A data do aceite fica registrada.
              </span>
            </label>
            <button
              type="submit"
              disabled={!aceitei || ocupado}
              className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
                px-4 py-3 cursor-pointer font-semibold disabled:opacity-50"
            >
              {ocupado ? 'Criando…' : 'Criar minha conta'}
            </button>
          </form>
        )}
      </div>
    </CascaDaLoja>
  );
}
