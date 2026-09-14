/**
 * A FILA DE TRANSMISSÃO NA TELA DE DOCUMENTOS — GAP-PRD-020.
 *
 * Antes, a nota presa pela SEFAZ fora do ar só andava na próxima venda da
 * mesma empresa, e a contingência era beco sem saída: a rota de reenfileirar
 * existia sem nenhum botão. O servidor agora transmite sozinho; esta tela diz
 * ao gestor:
 *
 *  - se a transmissão automática está ligada e quando passou por último;
 *  - o que a SEFAZ respondeu na última pergunta (no ar, fora, sem resposta);
 *  - cada nota que espera, com tentativas, próxima tentativa e o motivo;
 *  - as pendências que só uma pessoa resolve;
 *
 * e dá os dois gestos: transmitir AGORA uma nota, ou a fila inteira.
 *
 * O caixa não vê este quadro (a rota responde 403 e o quadro some): ele vê a
 * situação da própria nota no PDV.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  filaFiscalApi,
  type ItemDaFilaFiscal,
  type PainelDaFilaFiscal,
} from '@/lib/api/filaFiscal';
import { dataHoraBR } from '@/lib/datas';

const SITUACAO_DO_ITEM: Record<string, { texto: string; tom: 'warning' | 'danger' | 'info' | 'neutral' }> = {
  pending: { texto: 'Aguardando a primeira tentativa', tom: 'info' },
  retry: { texto: 'Nova tentativa automática', tom: 'warning' },
  sending: { texto: 'Enviando', tom: 'warning' },
  dead: { texto: 'Desistiu — precisa de você', tom: 'danger' },
};

function nomeDoModelo(model: string): string {
  return model === '65' ? 'NFC-e' : 'NF-e';
}

export function FilaFiscalCard({ onMudou }: { onMudou?: () => void | Promise<void> }) {
  const [painel, setPainel] = useState<PainelDaFilaFiscal | null>(null);
  const [semAcesso, setSemAcesso] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setPainel(await filaFiscalApi.painel());
      setSemAcesso(false);
    } catch (err) {
      // Sem permissão: o quadro é de gestão e simplesmente não aparece.
      if (err instanceof ApiRequestError && err.status === 403) {
        setSemAcesso(true);
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível consultar a fila.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const transmitirUma = useCallback(
    async (item: ItemDaFilaFiscal) => {
      setOcupado(item.documentId);
      setErro(null);
      setAviso(null);
      try {
        const r = await filaFiscalApi.transmitirAgora(item.documentId);
        setAviso(`${nomeDoModelo(item.model)} ${item.number}: ${r.statusLabel}.`);
        await carregar();
        await onMudou?.();
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao transmitir a nota.');
      } finally {
        setOcupado(null);
      }
    },
    [carregar, onMudou],
  );

  const transmitirTodas = useCallback(async () => {
    setOcupado('todas');
    setErro(null);
    setAviso(null);
    try {
      const r = await filaFiscalApi.transmitirPendentes();
      setPainel(r.painel);
      setAviso(
        r.resultado.paradaPor
          ? `${r.resultado.transmitidos} nota(s) tentada(s); a SEFAZ não respondeu e a fila parou para não gastar tentativas — ela tenta sozinha de novo.`
          : `${r.resultado.transmitidos} nota(s) transmitida(s).`
          + (r.resultado.esperando > 0 ? ` ${r.resultado.esperando} esperando o certificado no cofre.` : ''),
      );
      await onMudou?.();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao transmitir a fila.');
    } finally {
      setOcupado(null);
    }
  }, [onMudou]);

  if (semAcesso) return null;

  const t = painel?.trabalhador;
  const s = painel?.sefaz;
  const esperando = painel?.itens ?? [];

  return (
    <Card
      title="Transmissão à SEFAZ"
      subtitle={
        t
          ? t.ligado
            ? `Transmissão automática ligada${t.ultimaPassada ? ` — última passada ${dataHoraBR(t.ultimaPassada)}` : ''}. Nota que a SEFAZ não recebeu é tentada de novo sozinha.`
            : 'Transmissão automática DESLIGADA neste servidor — as notas só saem pelos botões abaixo.'
          : 'Consultando a fila…'
      }
      actions={
        esperando.length > 0 ? (
          <Button size="sm" loading={ocupado === 'todas'} onClick={() => void transmitirTodas()}>
            Transmitir pendentes agora
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {s && (
          <p
            role="status"
            className={`m-0 px-3 py-2 rounded-[var(--gs-radius)] text-[length:var(--gs-text-sm)] ${
              s.online
                ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
                : 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
            }`}
          >
            {s.online ? 'SEFAZ no ar' : 'SEFAZ fora do ar ou sem resposta'} na última verificação (
            {dataHoraBR(s.em)}){s.cStat ? ` — cStat ${s.cStat}` : ''}
            {s.xMotivo ? `: ${s.xMotivo}` : ''}
            {s.fonte === 'test' ? ' (simulador)' : ''}.
          </p>
        )}

        {painel && (
          <div className="flex gap-2 flex-wrap text-[length:var(--gs-text-sm)]">
            <Badge tone="info">{painel.contagem.aguardando} aguardando</Badge>
            <Badge tone="warning">{painel.contagem.novaTentativa} com nova tentativa</Badge>
            <Badge tone={painel.contagem.desistiu > 0 ? 'danger' : 'neutral'}>
              {painel.contagem.desistiu} desistiram
            </Badge>
            {painel.contagem.enviando > 0 && <Badge tone="warning">{painel.contagem.enviando} enviando</Badge>}
          </div>
        )}

        {painel && esperando.length === 0 && (
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Nenhuma nota esperando transmissão.
          </p>
        )}

        {esperando.length > 0 && (
          <ul className="list-none p-0 m-0 flex flex-col gap-2" aria-label="Notas esperando transmissão">
            {esperando.map((i) => {
              const sit = SITUACAO_DO_ITEM[i.queueStatus] ?? { texto: i.queueStatus, tom: 'neutral' as const };
              return (
                <li
                  key={i.documentId}
                  className="flex items-start justify-between gap-3 flex-wrap p-3 rounded-[var(--gs-radius)]
                    border border-[var(--gs-border)]"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="flex items-center gap-2 flex-wrap">
                      <strong>
                        {nomeDoModelo(i.model)} {i.number}/{i.serie}
                      </strong>
                      <Badge tone={sit.tom}>{sit.texto}</Badge>
                      {i.documentStatus === 'CONTINGENCY' && <Badge tone="warning">Contingência</Badge>}
                    </span>
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                      {i.attempts} tentativa(s)
                      {i.queueStatus === 'retry' && i.nextAttemptAt
                        ? ` · próxima ${dataHoraBR(i.nextAttemptAt)}`
                        : ''}
                      {i.lastAttemptAt ? ` · última ${dataHoraBR(i.lastAttemptAt)}` : ''}
                    </span>
                    {i.errorMessage && (
                      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                        {i.errorMessage}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={ocupado === i.documentId}
                    disabled={ocupado !== null && ocupado !== i.documentId}
                    onClick={() => void transmitirUma(i)}
                  >
                    Transmitir agora
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {painel && painel.pendencias.length > 0 && (
          <div>
            <p className="m-0 mb-1 font-semibold text-[length:var(--gs-text-sm)]">
              Notas precisando de atenção ({painel.pendencias.length})
            </p>
            <ul className="list-none p-0 m-0 flex flex-col gap-1">
              {painel.pendencias.slice(0, 10).map((p) => (
                <li key={p.documentId} className="text-[length:var(--gs-text-sm)]">
                  Nota {p.number} — {p.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {aviso && (
          <p
            role="status"
            className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-info)]"
          >
            {aviso}
          </p>
        )}
        {erro && (
          <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
      </div>
    </Card>
  );
}
