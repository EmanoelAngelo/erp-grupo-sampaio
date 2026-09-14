/**
 * TROCA E DEVOLUÇÃO NO PORTAL (GAP-PRD-125).
 *
 * A vitrine anuncia "Troca em 7 dias" (CDC, art. 49) e o portal parava no
 * "Entregue": devolver era "falar com a loja". Agora a cliente pede por aqui,
 * depois de receber — por desistência (dentro de 7 dias do recebimento) ou por
 * defeito —, e acompanha a resposta da loja. Quem decide o prazo e a posse é o
 * servidor; a tela só mostra o que ele disse.
 */
import { useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import {
  diaDoPrazo,
  posVendaApi,
  type DevolucaoNoPortal,
  type TipoDaDevolucao,
} from '@/lib/api/posVenda';

interface Props {
  orderId: string;
  token: string;
  devolucao: DevolucaoNoPortal;
  /** Depois de pedir: a tela recarrega o pedido. */
  aoMudar: () => void | Promise<void>;
}

export function DevolucaoDoPedido({ orderId, token, devolucao, aoMudar }: Props) {
  const [abrindo, setAbrindo] = useState(false);
  const [tipo, setTipo] = useState<TipoDaDevolucao>(
    devolucao.arrependimentoNoPrazo ? 'arrependimento' : 'defeito',
  );
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = async () => {
    setErro(null);
    if (motivo.trim().length < 10) {
      setErro('Conte em poucas palavras o que aconteceu (pelo menos 10 caracteres).');
      return;
    }
    setEnviando(true);
    try {
      await posVendaApi.solicitarDevolucao(orderId, token, { tipo, motivo: motivo.trim() });
      setAbrindo(false);
      setMotivo('');
      await aoMudar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível enviar agora.');
    } finally {
      setEnviando(false);
    }
  };

  // Antes de receber, e sem nada pedido, a seção não tem o que dizer.
  if (!devolucao.podeSolicitar && devolucao.solicitacoes.length === 0 && !devolucao.prazoArrependimentoAte) {
    return null;
  }

  return (
    <section
      data-testid="devolucao-do-pedido"
      className="mt-5 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5"
    >
      <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0">
        Troca e devolução
      </h2>

      {devolucao.prazoArrependimentoAte && (
        <p className="text-[length:var(--gs-text-sm)] m-0 mb-3">
          {devolucao.arrependimentoNoPrazo
            ? `Você pode desistir da compra até ${diaDoPrazo(devolucao.prazoArrependimentoAte)} (7 dias a contar do recebimento).`
            : `O prazo de desistência terminou em ${diaDoPrazo(devolucao.prazoArrependimentoAte)}. Produto com defeito continua podendo ser devolvido.`}
        </p>
      )}

      {devolucao.solicitacoes.length > 0 && (
        <ul className="list-none p-0 m-0 mb-3 flex flex-col gap-2">
          {devolucao.solicitacoes.map((s) => (
            <li
              key={s.id}
              className="text-[length:var(--gs-text-sm)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3"
            >
              <strong>{s.kindLabel}</strong> — {s.statusLabel}
              <span className="block text-[var(--gs-muted)]">Seu relato: {s.reason}</span>
              {s.decisionNote && <span className="block">Resposta da loja: {s.decisionNote}</span>}
            </li>
          ))}
        </ul>
      )}

      {!devolucao.podeSolicitar && devolucao.motivoIndisponivel && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          {devolucao.motivoIndisponivel}
        </p>
      )}

      {devolucao.podeSolicitar && !abrindo && (
        <button
          type="button"
          onClick={() => setAbrindo(true)}
          className="bg-transparent border border-[var(--gs-purple-700)] text-[var(--gs-purple-700)]
            rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
        >
          Pedir devolução
        </button>
      )}

      {devolucao.podeSolicitar && abrindo && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
          className="flex flex-col gap-3"
        >
          <fieldset className="border-0 p-0 m-0 flex flex-col gap-1">
            <legend className="text-[length:var(--gs-text-sm)] font-semibold mb-1">Motivo</legend>
            <label className="text-[length:var(--gs-text-sm)]">
              <input
                type="radio"
                name="tipo-devolucao"
                value="arrependimento"
                checked={tipo === 'arrependimento'}
                disabled={!devolucao.arrependimentoNoPrazo}
                onChange={() => setTipo('arrependimento')}
              />{' '}
              Desisti da compra (arrependimento)
            </label>
            <label className="text-[length:var(--gs-text-sm)]">
              <input
                type="radio"
                name="tipo-devolucao"
                value="defeito"
                checked={tipo === 'defeito'}
                onChange={() => setTipo('defeito')}
              />{' '}
              Produto com defeito
            </label>
          </fieldset>
          <label className="text-[length:var(--gs-text-sm)] font-semibold" htmlFor={`motivo-devolucao-${orderId}`}>
            O que aconteceu?
          </label>
          <textarea
            id={`motivo-devolucao-${orderId}`}
            rows={3}
            maxLength={1000}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
          {erro && (
            <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)] m-0">
              {erro}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={enviando}
              className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-4 py-2
                cursor-pointer font-semibold disabled:opacity-60"
            >
              {enviando ? 'Enviando…' : 'Enviar pedido de devolução'}
            </button>
            <button
              type="button"
              onClick={() => setAbrindo(false)}
              disabled={enviando}
              className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer"
            >
              Voltar
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
