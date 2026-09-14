/**
 * ESTORNAR O RECEBIMENTO DE UMA OS PAGA — GAP-PRD-105.
 *
 * Antes, o erro do caixa na OS paga ("lancei dinheiro, o cliente pagou no
 * PIX") só se corrigia por SQL: a OS finalizada era imutável e cancelar a
 * venda deixava a OS apontando para venda cancelada.
 *
 * Aqui o estorno cancela a venda da OS — o MESMO cancelamento da tela de
 * vendas — e a OS volta para a fila do caixa, com o motivo na linha do tempo.
 * O gerente da oficina faz direto; o caixa chama um gestor (o servidor
 * responde `CORE_CANCEL_NEEDS_AUTHORIZATION` e este diálogo abre a senha).
 *
 * O texto diz o que o sistema NÃO faz: cancelar a venda não devolve o cartão
 * nem o PIX na operadora. Botão que promete estorno completo e deixa a
 * transação viva lá fora é o tipo de promessa que custa dinheiro.
 */
import { useEffect, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Button } from './ui';
import { formatCents } from './format';
import { AutorizacaoGerenteDialog } from './PagamentoDialog';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import { oficinaCaixaApi, type OsDoCaixa } from '@/lib/api/oficinaCaixa';

export function EstornoOsDialog({
  os,
  onEstornado,
  onCancel,
}: {
  os: { id: string; number: number; total_cents: number };
  onEstornado: (r: { order: OsDoCaixa }) => void;
  onCancel: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  /** A venda que o gestor precisa liberar — vem na recusa do servidor. */
  const [pedindoGestor, setPedindoGestor] = useState<{ vendaId: string; texto: string } | null>(
    null,
  );
  const [erroGestor, setErroGestor] = useState<string | null>(null);

  useEffect(() => {
    if (pedindoGestor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pedindoGestor, onCancel]);

  const estornar = async (authorizationId?: string) => {
    if (motivo.trim().length < 3) {
      setErro('Diga por que o recebimento está sendo estornado.');
      return;
    }
    setOcupado(true);
    setErro(null);
    try {
      const r = await oficinaCaixaApi.estornar(os.id, motivo.trim(), authorizationId);
      setPedindoGestor(null);
      onEstornado(r);
    } catch (err) {
      const api = err instanceof ApiRequestError ? err : null;
      if (api?.code === 'CORE_CANCEL_NEEDS_AUTHORIZATION') {
        const d = (api.details ?? {}) as { referenceId?: string };
        setErroGestor(null);
        setPedindoGestor({ vendaId: String(d.referenceId ?? ''), texto: api.message });
        return;
      }
      setErro(api ? api.message : 'Não foi possível estornar. Tente de novo.');
    } finally {
      setOcupado(false);
    }
  };

  const autorizar = async (login: string, password: string) => {
    if (!pedindoGestor) return;
    setOcupado(true);
    setErroGestor(null);
    try {
      const bilhete = await coreApi.authorize({
        action: 'cancelar_venda',
        login,
        password,
        referenceId: pedindoGestor.vendaId,
        reason: `Estorno do recebimento da OS #${os.number} — ${motivo.trim()}`,
      });
      await estornar(bilhete.id);
    } catch (err) {
      setErroGestor(err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={`Estornar recebimento da OS #${os.number}`}
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Estornar o recebimento da OS #{os.number}
          </h2>
        </header>
        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            A venda de {formatCents(os.total_cents)} desta OS é cancelada: o título a receber cai e
            o dinheiro em espécie sai da gaveta aberta. A OS volta para a fila do caixa, para ser
            recebida do jeito certo — e, se a conta estava errada, o gerente a devolve à bancada.
          </p>
          <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
            Cartão e PIX: devolva também na maquininha ou no banco. O sistema desfaz a venda, não a
            transação na operadora.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Motivo do estorno
            </span>
            <textarea
              aria-label="Motivo do estorno"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] text-[var(--gs-text)]"
            />
          </label>
          {erro && (
            <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Voltar (Esc)
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={ocupado}
              disabled={motivo.trim().length < 3}
              onClick={() => void estornar()}
            >
              Estornar recebimento
            </Button>
          </div>
        </div>
      </div>
      {pedindoGestor && (
        <AutorizacaoGerenteDialog
          motivo={pedindoGestor.texto}
          onConfirm={(login, password) => void autorizar(login, password)}
          onCancel={() => setPedindoGestor(null)}
          busy={ocupado}
          error={erroGestor}
        />
      )}
    </div>
  );
}
