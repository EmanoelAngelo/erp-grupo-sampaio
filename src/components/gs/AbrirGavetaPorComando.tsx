/**
 * ABRIR A GAVETA SEM VENDA, pelo agente local do caixa (GAP-PRD-082).
 *
 * Troco, conferência do fundo, sangria: a gaveta abre por comando — o pulso
 * vai para a térmica deste caixa pelo agente local. O botão só EXISTE quando o
 * servidor diz que este caixa abre a gaveta por comando AGORA (térmica de
 * agente com endereço e o agente no ar): um botão que às vezes não abre nada
 * ensina o operador a não confiar na tela (GAP-V55). Sem ele, a gaveta abre
 * pela chave, como sempre.
 *
 * O motivo é obrigatório e fica na trilha com o nome de quem pediu; a
 * abertura confirmada pelo agente também.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import { acompanharNoAgente, impressaoApi } from '@/lib/api/impressao';

export function AbrirGavetaPorComando({
  terminalId,
  acompanhamento,
}: {
  terminalId: string | null;
  /** Só para o teste encurtar a espera. */
  acompanhamento?: { intervaloMs?: number; prazoMs?: number };
}) {
  const [porComando, setPorComando] = useState(false);
  const [pedindo, setPedindo] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<{ tom: 'ok' | 'erro'; texto: string } | null>(null);

  useEffect(() => {
    let vivo = true;
    void coreApi
      .drawerReadiness(terminalId)
      .then((r) => {
        if (vivo) setPorComando(r?.byCommand === true);
      })
      // Sem resposta, não há botão: o silêncio é melhor que um palpite sobre hardware.
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [terminalId]);

  const abrir = useCallback(async () => {
    setOcupado(true);
    setAviso(null);
    try {
      const job = await impressaoApi.abrirGaveta(motivo.trim(), terminalId);
      const final = await acompanharNoAgente(job.id, { prazoMs: 15_000, ...acompanhamento });
      if (final.status === 'printed') {
        setAviso({ tom: 'ok', texto: 'Gaveta aberta. O motivo ficou na trilha.' });
        setPedindo(false);
        setMotivo('');
      } else {
        setAviso({
          tom: 'erro',
          texto: final.error ?? 'O agente não confirmou a abertura. Abra pela chave e avise o gerente.',
        });
      }
    } catch (err) {
      setAviso({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Não foi possível pedir a abertura da gaveta.',
      });
    } finally {
      setOcupado(false);
    }
  }, [acompanhamento, motivo, terminalId]);

  if (!porComando) return null;

  return (
    <div data-testid="abrir-gaveta-por-comando" className="flex flex-col gap-2 text-[length:var(--gs-text-sm)]">
      {!pedindo ? (
        <button
          type="button"
          onClick={() => setPedindo(true)}
          className="self-start bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer"
        >
          Abrir gaveta
        </button>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Por que abrir sem venda</span>
            <input
              aria-label="Motivo para abrir a gaveta"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder='Ex.: "troco para o caixa 2"'
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>
          <button
            type="button"
            disabled={ocupado || motivo.trim().length < 3}
            onClick={() => void abrir()}
            className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-2 cursor-pointer font-semibold disabled:opacity-50"
          >
            {ocupado ? 'Abrindo…' : 'Abrir agora'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPedindo(false);
              setMotivo('');
            }}
            className="bg-transparent border-0 underline cursor-pointer"
          >
            Cancelar
          </button>
        </div>
      )}
      {aviso && (
        <p
          role={aviso.tom === 'erro' ? 'alert' : 'status'}
          className={`m-0 ${aviso.tom === 'erro' ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-success)]'}`}
        >
          {aviso.texto}
        </p>
      )}
    </div>
  );
}
