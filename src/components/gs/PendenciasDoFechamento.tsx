/**
 * ============================================================================
 * FECHAR O TURNO COM DINHEIRO ELETRÔNICO INDEFINIDO (GAP-PRD-081)
 * ============================================================================
 *
 * O servidor passou a recusar o fechamento quando o turno tem cobrança da
 * maquininha sem resposta, cobrança ainda no aparelho, cobrança aprovada que
 * venda nenhuma usou, estorno de venda desfeita não confirmado ou PIX
 * pendente numa venda da gaveta. Fechar assim mesmo exige declarar que está
 * ciente, com o motivo — e é esta peça que diz O QUÊ, pelo nome e pelo valor,
 * e colhe a declaração. As três telas que fecham gaveta (o diálogo do PDV, a
 * tela de Caixa e as gavetas abertas da operação) usam a mesma.
 */
import { formatCents } from '@/components/gs/format';
import type { PendenciasEletronicas, TipoDePendenciaEletronica } from '@/lib/api/core';

const ROTULO: Record<TipoDePendenciaEletronica, string> = {
  nao_confirmada: 'Cobrança sem resposta da operadora',
  em_andamento: 'Cobrança ainda em andamento no aparelho',
  aprovada_sem_venda: 'Cobrança aprovada que nenhuma venda usou',
  estorno_pendente: 'Estorno de venda desfeita ainda não confirmado',
};

const MEIO: Record<string, string> = { credit: 'crédito', debit: 'débito', pix: 'PIX' };

export function PendenciasDoFechamento({
  pendencias,
  ciente,
  motivo,
  onCiente,
  onMotivo,
  idBase = 'pendencias',
}: {
  pendencias: PendenciasEletronicas;
  ciente: boolean;
  motivo: string;
  onCiente: (v: boolean) => void;
  onMotivo: (v: string) => void;
  /** Para dar nomes únicos quando há mais de uma gaveta na tela. */
  idBase?: string;
}) {
  return (
    <div
      role="alert"
      data-testid="pendencias-do-fechamento"
      className="rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)]
        px-4 py-3 flex flex-col gap-2 text-[length:var(--gs-text-sm)]"
    >
      <strong className="text-[var(--gs-warning)]">
        {(pendencias.vendasOffline?.length ?? 0) > 0
          ? 'Pendências deste turno'
          : 'Dinheiro eletrônico ainda indefinido neste turno'}{' '}
        — {pendencias.quantidade} pendência(s), {formatCents(pendencias.totalCents)}
      </strong>
      <ul className="m-0 pl-5 flex flex-col gap-0.5">
        {pendencias.cobrancas.map((c) => (
          <li key={c.transactionId}>
            {ROTULO[c.tipo]} — {formatCents(c.amountInCents)} ({MEIO[c.method] ?? c.method})
            {c.simulated ? ' · TESTE' : ''}
          </li>
        ))}
        {pendencias.pagamentosPendentes.map((p) => (
          <li key={p.paymentId}>
            {p.method.toUpperCase()} pendente na venda #{p.saleNumber ?? '?'} — {formatCents(p.amountCents)}
          </li>
        ))}
        {/* GAP-PRD-045: o dinheiro desta está NA gaveta, e a venda não existe. */}
        {(pendencias.vendasOffline ?? []).map((v) => (
          <li key={v.id}>
            Venda guardada sem servidor e recusada — {formatCents(v.receivedCents)} na gaveta, sem venda
            {v.errorMessage ? ` (${v.errorMessage})` : ''}. Relance ou descarte em Regularizar.
          </li>
        ))}
      </ul>
      <span className="text-[var(--gs-text-soft)]">
        Cartão e PIX não estão na gaveta: a contagem continua sendo só do dinheiro. Estas pendências
        são do gerente, em Vendas › Conferência de maquininha — fechar agora não as resolve, só registra
        que você fechou sabendo delas.
      </span>
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          checked={ciente}
          onChange={(e) => onCiente(e.target.checked)}
          aria-label="Estou ciente das pendências eletrônicas deste turno"
          id={`${idBase}-ciente`}
        />
        Estou ciente e vou fechar o turno com estas pendências
      </label>
      {ciente && (
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Por quê</span>
          <input
            aria-label="Motivo para fechar com pendências"
            value={motivo}
            onChange={(e) => onMotivo(e.target.value)}
            placeholder='Ex.: "o gerente confere o extrato amanhã cedo"'
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
        </label>
      )}
    </div>
  );
}
