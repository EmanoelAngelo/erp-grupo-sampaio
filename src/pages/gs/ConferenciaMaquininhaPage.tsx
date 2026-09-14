/**
 * Conferência de maquininha.
 *
 * Fila das cobranças que ficaram sem resposta. Cada linha aqui é uma venda que
 * não fechou porque ninguém sabe se o cliente pagou — a maquininha respondeu
 * tarde, ou a rede caiu no meio.
 *
 * O sistema não decide isso sozinho, de propósito. Chutar "aprovado" entrega
 * mercadoria sem receber; chutar "recusado" joga fora uma venda já paga; cobrar
 * de novo cobra o cliente duas vezes. Quem resolve é um gestor, olhando o
 * extrato da operadora — e o que ele afirmar fica registrado com o nome dele.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { AppShell } from '@/components/gs/AppShell';
import { Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type TerminalPayment } from '@/lib/api/core';
import { MaquininhasIntegradasCard } from '@/components/gs/MaquininhasIntegradasCard';
import { PendenciasDaMaquininhaCard } from '@/components/gs/PendenciasDaMaquininhaCard';

export default function ConferenciaMaquininhaPage() {
  const [items, setItems] = useState<TerminalPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<TerminalPayment | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await coreApi.listUncertainTerminalPayments());
    } catch (err) {
      // `items` fica nulo de propósito: mostrar "nada pendente" depois de uma
      // falha faria o usuário concluir que está tudo certo quando, na verdade,
      // ele apenas não conseguiu ver.
      setItems(null);
      setError(
        err instanceof ApiRequestError ? err.message : 'Falha ao carregar as pendências.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell>
      <PageHeader
        title="Conferência de maquininha"
        subtitle="Cobranças sem resposta da operadora. Enquanto estiverem aqui, a venda não fecha — e não devem ser cobradas de novo."
        actions={
          <Button variant="ghost" onClick={() => void load()}>
            Atualizar
          </Button>
        }
      />

      {message && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {message}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      <Card
        title="Pendentes de conferência"
        subtitle="Confira no extrato da operadora antes de registrar o resultado."
      >
        {items === null ? (
          <p role="status" className="text-[var(--gs-muted)]">
            {error ? 'Não foi possível listar as pendências.' : 'Carregando…'}
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nada pendente"
            description="Nenhuma cobrança ficou sem resposta. Quando isso acontecer, ela aparece aqui e a venda correspondente fica travada até alguém conferir."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className="py-2.5 pr-4 font-semibold">Transação</th>
                  <th className="py-2.5 pr-4 font-semibold">Meio</th>
                  <th className="py-2.5 pr-4 font-semibold">Cartão</th>
                  <th className="py-2.5 pr-4 font-semibold text-right">Valor</th>
                  <th className="py-2.5 font-semibold text-right">Ação</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.transactionId} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className="py-3 pr-4 font-mono text-[length:var(--gs-text-xs)]">
                      {t.transactionId}
                    </td>
                    <td className="py-3 pr-4">{t.method}</td>
                    <td className="py-3 pr-4">{t.maskedCard ?? '—'}</td>
                    <td className="py-3 pr-4 text-right font-bold tabular-nums">
                      {formatCents(t.amountInCents)}
                    </td>
                    <td className="py-3 text-right">
                      <Button size="sm" onClick={() => setSelected(t)}>
                        Registrar resultado
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Cobranças sem venda e estornos a fazer (GAP-PRD-078/080): o dinheiro
          da operadora que não tem venda, ou que a venda desfeita deve devolver. */}
      <div className="mt-5">
        <PendenciasDaMaquininhaCard />
      </div>

      {/* Ligar/desligar maquininha (GAP-PRD-001): mesmo público, mesmo assunto. */}
      <div className="mt-5">
        <MaquininhasIntegradasCard />
      </div>

      {selected && (
        <ReconcileDialog
          payment={selected}
          onClose={() => setSelected(null)}
          onDone={(texto) => {
            setSelected(null);
            setMessage(texto);
            void load();
          }}
        />
      )}
    </AppShell>
  );
}

function ReconcileDialog({
  payment,
  onClose,
  onDone,
}: {
  payment: TerminalPayment;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState<'aprovado' | 'recusado'>('aprovado');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmar = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await coreApi.reconcileTerminalPayment(payment.transactionId, outcome, reason);
      onDone(
        outcome === 'aprovado'
          ? `Cobrança de ${formatCents(payment.amountInCents)} confirmada como paga.`
          : `Cobrança de ${formatCents(payment.amountInCents)} confirmada como NÃO paga.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao registrar.');
    } finally {
      setBusy(false);
    }
  }, [payment, outcome, reason, onDone]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label="Registrar resultado da cobrança"
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Registrar resultado — {formatCents(payment.amountInCents)}
          </h2>
        </header>

        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Consulte o extrato da operadora e diga o que aconteceu com esta cobrança. O registro
            fica na auditoria com o seu nome.
          </p>

          <div className="flex gap-2">
            {(['aprovado', 'recusado'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOutcome(o)}
                aria-pressed={outcome === o}
                className={`px-5 py-2.5 rounded-[var(--gs-radius)] border font-semibold text-[length:var(--gs-text-sm)]
                  ${
                    outcome === o
                      ? 'bg-[var(--gs-purple-800)] text-white border-[var(--gs-purple-800)]'
                      : 'bg-[var(--gs-surface)] text-[var(--gs-text)] border-[var(--gs-border)]'
                  }`}
              >
                {o === 'aprovado' ? 'Foi paga' : 'Não foi paga'}
              </button>
            ))}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              O que você verificou no extrato
            </span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: NSU 88213 aprovado às 14h02, cartão final 1234"
            />
          </label>

          {error && (
            <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!reason.trim()} onClick={() => void confirmar()}>
              Registrar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
