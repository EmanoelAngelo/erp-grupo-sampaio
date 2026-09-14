/**
 * DE QUANDO É A VERDADE DA CONCILIAÇÃO — e o botão que pergunta ao provedor
 * (GAP-PRD-016).
 *
 * A conciliação compara o que o ERP SABE do provedor com o financeiro. Até
 * aqui, o ERP só sabia o que o webhook trazia: com o webhook quebrado, o
 * dinheiro entrava, o título ficava em aberto e a tela dizia "tudo confere".
 *
 * Este cartão diz a data da última consulta ao provedor, quantas cobranças em
 * aberto esperam consulta, e oferece "Consultar o provedor agora".
 *
 * NÃO É UM BOTÃO DE CORRIGIR. Ele não empurra nenhum lado para bater: pergunta
 * ao provedor o status de cada cobrança em aberto e aplica a resposta pelo
 * MESMO caminho do webhook — pagamento confirmado baixa o título, com a mesma
 * conferência de valor. O que muda é mostrado linha a linha, com o antes e o
 * depois.
 */
import { useCallback, useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { cobrancasApi, type SincronizacaoAsaas } from '@/lib/api/cobrancas';
import { dataHoraBR } from '@/lib/datas';

const STATUS_LEGIVEL: Record<string, string> = {
  pending: 'aguardando pagamento',
  overdue: 'vencida',
  confirmed: 'paga',
  amount_mismatch: 'paga com valor divergente',
  paid_after_cancel: 'paga depois de cancelada',
  refunded: 'estornada',
  chargeback: 'contestada',
  cancelled: 'cancelada',
};

const legivel = (status: string) => STATUS_LEGIVEL[status] ?? status;

export interface ResumoDaSincronizacao {
  last: SincronizacaoAsaas | null;
  pendingWithRef: number;
}

export function SincronizacaoAsaasCard({
  resumo,
  onConsultou,
}: {
  /** Vem junto do relatório; servidor antigo não manda. */
  resumo: ResumoDaSincronizacao | undefined;
  onConsultou: () => Promise<void> | void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<SincronizacaoAsaas | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const consultar = useCallback(async () => {
    setOcupado(true);
    setErro(null);
    try {
      const r = await cobrancasApi.sincronizarComOProvedor();
      setResultado(r);
      await onConsultou();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível consultar o provedor.');
    } finally {
      setOcupado(false);
    }
  }, [onConsultou]);

  const ultima = resumo?.last ?? null;

  return (
    <section
      aria-label="Consulta ao provedor"
      className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-4 mb-6
        flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <strong className="text-[var(--gs-purple-900)]">Consulta ao provedor</strong>
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {ultima
              ? ultima.unconfigured
                ? `Última tentativa em ${dataHoraBR(ultima.startedAt)}: sem credencial do Asaas nesta operação, nada foi consultado.`
                : `Última consulta em ${dataHoraBR(ultima.startedAt)} (${ultima.trigger === 'automatico' ? 'automática' : 'pedida na tela'}): `
                  + `${ultima.checked} perguntada(s), ${ultima.changed} mudaram, ${ultima.failed} sem resposta.`
              : 'O ERP ainda não consultou o provedor nesta operação: o relatório abaixo só conhece o que o webhook trouxe.'}
          </span>
          {resumo && resumo.pendingWithRef > 0 && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning,var(--gs-danger))]">
              {resumo.pendingWithRef} cobrança(s) em aberto no ERP esperam a resposta do provedor — se alguma já foi paga,
              ela ainda não aparece aqui.
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void consultar()}
          disabled={ocupado}
          className="bg-[var(--gs-surface)] text-[var(--gs-purple-700)] border border-[var(--gs-purple-700)]
            rounded-[var(--gs-radius)] px-4 py-2 font-semibold cursor-pointer disabled:opacity-50"
        >
          {ocupado ? 'Consultando…' : 'Consultar o provedor agora'}
        </button>
      </div>

      {erro && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      {resultado && (
        <div role="status" className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
          {resultado.unconfigured ? (
            <p className="m-0 text-[var(--gs-danger)]">
              Sem credencial do Asaas nesta operação: nada foi consultado. Configure em Integrações › Asaas.
            </p>
          ) : (
            <p className="m-0">
              {resultado.checked} cobrança(s) consultada(s); {resultado.changed} mudaram;{' '}
              {resultado.failed} ficaram sem resposta
              {resultado.skipped > 0 ? `; ${resultado.skipped} ficaram para a próxima passada` : ''}.
            </p>
          )}
          {resultado.changes.length > 0 && (
            <ul className="list-none p-0 m-0 flex flex-col gap-1">
              {resultado.changes.map((m) => (
                <li key={m.intentId}>
                  <strong>{m.originLabel ?? m.originId}</strong>: {legivel(m.antes)} → {legivel(m.depois)}
                  <span className="text-[var(--gs-muted)]"> — {m.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {resultado.errors.length > 0 && (
            <ul className="list-none p-0 m-0 flex flex-col gap-1 text-[var(--gs-danger)]">
              {resultado.errors.map((e) => (
                <li key={e.intentId}>
                  <span className="font-mono">{e.providerRef}</span>: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
