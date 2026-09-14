/**
 * "ESQUECI MINHA SENHA" NA TELA DE ENTRADA — GAP-PRD-160.
 *
 * Só aparece quando o servidor diz que o caminho existe (alguma operação ligou
 * a recuperação por e-mail e há SMTP para entregar o código). Sem isso, a tela
 * não oferece porta que não abre: a pessoa segue pedindo à gerência, como
 * sempre.
 *
 * Dois passos, na mesma caixa: pedir o código (login ou e-mail) e trocar a
 * senha com ele. A resposta do pedido é sempre a mesma — a tela não sabe, e
 * não diz, se a conta existe.
 */
import { useEffect, useState } from 'react';
import { Button, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { recuperacaoApi } from '@/lib/api/recuperacaoDeSenha';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';

type Passo = 'fechado' | 'pedir' | 'trocar' | 'feito';

export function EsqueciMinhaSenha() {
  const [disponivel, setDisponivel] = useState(false);
  const [passo, setPasso] = useState<Passo>('fechado');
  const [identificador, setIdentificador] = useState('');
  const [codigo, setCodigo] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    void recuperacaoApi.disponivel().then((d) => {
      if (vivo) setDisponivel(d);
    });
    return () => {
      vivo = false;
    };
  }, []);

  if (!disponivel) return null;

  if (passo === 'fechado') {
    return (
      <button
        type="button"
        onClick={() => setPasso('pedir')}
        className="mt-3 p-0 border-0 bg-transparent cursor-pointer underline
          text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]"
      >
        Esqueci minha senha
      </button>
    );
  }

  const pedir = async () => {
    setErro(null);
    setOcupado(true);
    try {
      const r = await recuperacaoApi.pedirCodigo(identificador.trim());
      setAviso(r.mensagem);
      setPasso('trocar');
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível pedir o código.');
    } finally {
      setOcupado(false);
    }
  };

  const trocar = async () => {
    setErro(null);
    if (novaSenha !== confirmacao) {
      setErro('A confirmação não bate com a senha nova.');
      return;
    }
    setOcupado(true);
    try {
      await recuperacaoApi.recuperar({
        identificador: identificador.trim(),
        codigo: codigo.trim(),
        novaSenha,
      });
      setNovaSenha('');
      setConfirmacao('');
      setCodigo('');
      setPasso('feito');
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível trocar a senha.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <section
      aria-label="Esqueci minha senha"
      className="mt-4 p-4 rounded-[var(--gs-radius)] border border-[var(--gs-border)] flex flex-col gap-3"
    >
      <p className="m-0 font-semibold">Esqueci minha senha</p>

      {passo === 'feito' ? (
        <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
          Senha trocada. Entre com a senha nova.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className={ROTULO}>Login ou e-mail</span>
            <Input
              value={identificador}
              onChange={(e) => setIdentificador(e.target.value)}
              autoComplete="username"
              disabled={passo === 'trocar'}
            />
          </label>

          {passo === 'pedir' && (
            <Button onClick={() => void pedir()} disabled={ocupado || !identificador.trim()}>
              Enviar código por e-mail
            </Button>
          )}

          {passo === 'trocar' && (
            <>
              {aviso && (
                <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                  {aviso}
                </p>
              )}
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Código recebido (8 dígitos)</span>
                <Input
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Senha nova</span>
                <Input
                  type="password"
                  value={novaSenha}
                  onChange={(e) => setNovaSenha(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Confirme a senha nova</span>
                <Input
                  type="password"
                  value={confirmacao}
                  onChange={(e) => setConfirmacao(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <Button
                onClick={() => void trocar()}
                disabled={ocupado || !codigo.trim() || !novaSenha || !confirmacao}
              >
                Trocar senha
              </Button>
            </>
          )}
        </>
      )}

      {erro && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
    </section>
  );
}
