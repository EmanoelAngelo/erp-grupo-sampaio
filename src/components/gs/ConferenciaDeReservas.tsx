/**
 * ============================================================================
 * RESERVAS QUE SEGURAM MERCADORIA — o cartão da Posição de estoque (GAP-PRD-087)
 * ============================================================================
 *
 * A coluna "Reservado" da posição dizia QUANTO estava preso e nunca POR QUÊ. Uma
 * reserva sem origem (o pedido online que sumiu sem soltá-la) tirava a peça da
 * venda para sempre, e o único diagnóstico era um serviço do servidor que
 * ninguém chamava.
 *
 * O cartão só aparece quando há o que conferir — reserva saudável não ocupa a
 * tela de quem abre a posição todo dia. Quando aparece, diz o produto, a conta
 * e as referências do razão com a situação de cada documento, e oferece à
 * GERÊNCIA (o mesmo recorte da rota) o gesto de soltar a parte sem origem, com
 * motivo. Pedido aberto sem reserva não tem botão: o conserto é no pedido.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Input } from '@/components/gs/ui';
import { formatQuantity } from '@/components/gs/format';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';
import {
  reservasApi,
  type ConferenciaDeReservas as Conferencia,
  type ProblemaDeReserva,
  type SituacaoDaOrigem,
} from '@/lib/api/reservas';

const TOM_DA_SITUACAO: Record<SituacaoDaOrigem, 'danger' | 'warning' | 'success' | 'neutral'> = {
  inexistente: 'danger',
  encerrada: 'warning',
  aberta: 'success',
  nao_verificada: 'neutral',
};

const ROTULO_DA_SITUACAO: Record<SituacaoDaOrigem, string> = {
  inexistente: 'documento não existe',
  encerrada: 'documento encerrado',
  aberta: 'documento aberto',
  nao_verificada: 'não conferido',
};

const TITULO_DA_CHECAGEM: Record<ProblemaDeReserva['check'], string> = {
  STOCK_RESERVATION_WITHOUT_SOURCE: 'Reserva sem origem',
  OPEN_ORDER_WITHOUT_RESERVATION: 'Pedido aberto sem reserva',
  RESERVATION_WITHOUT_LEDGER: 'Reserva sem rastro no histórico',
};

export function ConferenciaDeReservas({ onMudou }: { onMudou?: () => void }) {
  const [conferencia, setConferencia] = useState<Conferencia | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** O produto cuja liberação está sendo confirmada, e o motivo em digitação. */
  const [liberando, setLiberando] = useState<{ productId: string; motivo: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // O MESMO recorte de POST /stock/reservations/:id/liberar-sem-origem.
  const solta = useHasProfile('gerente_loja', 'gerente_oficina');

  const carregar = useCallback(async () => {
    try {
      const recebida = await reservasApi.conferir();
      // Servidor anterior a esta rota (ou dublê que não a conhece) devolve
      // outra forma: sem lista de problemas não há o que mostrar, e o cartão
      // simplesmente não aparece — em vez de derrubar a posição de estoque.
      setConferencia({
        healthy: Boolean(recebida?.healthy ?? true),
        critical: Number(recebida?.critical ?? 0),
        warnings: Number(recebida?.warnings ?? 0),
        issues: Array.isArray(recebida?.issues)
          ? recebida.issues.map((i) => ({
              ...i,
              referencias: Array.isArray(i.referencias) ? i.referencias : [],
            }))
          : [],
      });
      setErro(null);
    } catch (err) {
      setConferencia(null);
      setErro(
        err instanceof ApiRequestError ? err.message : 'Falha ao conferir as reservas do estoque.',
      );
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function confirmarLiberacao(problema: ProblemaDeReserva) {
    if (!liberando) return;
    setOcupado(true);
    setErro(null);
    try {
      const r = await reservasApi.liberarSemOrigem(problema.productId, {
        reason: liberando.motivo.trim(),
      });
      setAviso(
        `${formatQuantity(r.liberado)} de "${r.productName}" voltou a ficar disponível. `
          + 'O histórico de movimentações registra a liberação com o seu nome e o motivo.',
      );
      setLiberando(null);
      await carregar();
      onMudou?.();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao liberar a reserva.');
    } finally {
      setOcupado(false);
    }
  }

  // Falha de leitura é dita, e não confundida com "tudo certo" — em tom de
  // aviso, porque a posição de estoque logo abaixo continua valendo.
  if (erro && !conferencia) {
    return (
      <p role="status" className="mb-5 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
        Não foi possível conferir as reservas agora: {erro}
      </p>
    );
  }
  if (!conferencia) return null;
  if (conferencia.issues.length === 0) {
    return aviso ? (
      <p role="status" className="mb-5 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
        {aviso}
      </p>
    ) : null;
  }

  return (
    <Card
      className="mb-5"
      title="Reservas que precisam de conferência"
      subtitle="Reserva segura mercadoria: enquanto existe, a peça não aparece disponível. Cada linha diz quanto está preso e qual documento prendeu."
    >
      {erro && (
        <p role="alert" className="mt-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="mt-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
          {aviso}
        </p>
      )}
      <ul className="m-0 p-0 list-none flex flex-col gap-4">
        {conferencia.issues.map((p) => (
          <li
            key={`${p.productId}-${p.check}`}
            className="border-t border-[var(--gs-border)] pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={p.severity === 'critical' ? 'danger' : 'warning'}>
                {TITULO_DA_CHECAGEM[p.check]}
              </Badge>
              <strong>{p.productName}</strong>
            </div>
            <p className="my-1 text-[length:var(--gs-text-sm)]">{p.detail}</p>
            {p.referencias.length > 0 && (
              <ul className="my-1 pl-5 text-[length:var(--gs-text-sm)]">
                {p.referencias.map((r) => (
                  <li key={`${r.referenceType}:${r.referenceId}`}>
                    <Badge tone={TOM_DA_SITUACAO[r.situacao]}>{ROTULO_DA_SITUACAO[r.situacao]}</Badge>{' '}
                    {r.explicacao}{' '}
                    <span className="text-[var(--gs-muted)]">(desde {dataBR(r.desde)})</span>
                  </li>
                ))}
              </ul>
            )}
            {p.check === 'OPEN_ORDER_WITHOUT_RESERVATION' && (
              <p className="my-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O conserto é no documento: confira o pedido ou a pré-venda aberta antes de vender
                esta peça de novo.
              </p>
            )}
            {p.check === 'STOCK_RESERVATION_WITHOUT_SOURCE' && p.semOrigem > 0 && (
              solta ? (
                liberando?.productId === p.productId ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)] min-w-[18rem]">
                      Motivo da liberação
                      <Input
                        aria-label={`Motivo para liberar a reserva de ${p.productName}`}
                        value={liberando.motivo}
                        onChange={(e) => setLiberando({ productId: p.productId, motivo: e.target.value })}
                        placeholder="Pedido online apagado sem soltar a reserva"
                      />
                    </label>
                    <Button
                      size="sm"
                      loading={ocupado}
                      disabled={liberando.motivo.trim().length < 3}
                      onClick={() => void confirmarLiberacao(p)}
                    >
                      Liberar {formatQuantity(p.semOrigem)} sem origem
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLiberando(null)}>
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    onClick={() => {
                      setAviso(null);
                      setLiberando({ productId: p.productId, motivo: '' });
                    }}
                  >
                    Liberar reserva sem origem
                  </Button>
                )
              ) : (
                <p className="my-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Soltar reserva sem origem é decisão da gerência: chame o gerente para liberar
                  {` ${formatQuantity(p.semOrigem)}`} unidade(s).
                </p>
              )
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
