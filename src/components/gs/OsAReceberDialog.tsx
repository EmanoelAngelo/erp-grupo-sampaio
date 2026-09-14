/**
 * "OS A RECEBER" NO PDV — GAP-PRD-042.
 *
 * ## O defeito
 *
 * O caixa da oficina (`operador_caixa_oficina`) mora no ambiente `pdv`. O
 * único botão de recebimento da OS ficava na ficha da OS, que é rota da
 * bancada e da gestão — o caixa que a abria era devolvido ao `/pdv`. E o PDV
 * não listava OS nenhuma: `GET /workshop/pending-payment` não tinha tela. O
 * único perfil de balcão autorizado a receber não chegava a botão nenhum.
 *
 * ## O conserto
 *
 * A fila vem para o balcão. Este diálogo lista as OS em "aguardando
 * pagamento" (cliente, aparelho, bancada, total), filtra pelo que o caixa
 * ouve no balcão ("a 47", o nome, a placa) e abre o recebimento — o
 * `RecebimentoOsDialog`, que é o fechamento do PDV com a OS como documento.
 *
 * A abertura da ficha da OS ao ambiente `pdv` foi a outra saída que a
 * auditoria apontou, e ficou de fora de propósito: a ficha é a tela da
 * bancada (peças, mão de obra, fotos) e o caixa só precisa de UMA coisa dela.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Button } from './ui';
import { formatCents } from './format';
import { RecebimentoOsDialog } from './RecebimentoOsDialog';
import type { FilaDeRecebimento, OsAReceber, RecebimentoDaOs } from '@/lib/api/oficinaCaixa';

function casa(os: OsAReceber, termo: string): boolean {
  const t = termo.trim().toLowerCase().replace(/^#/, '');
  if (!t) return true;
  return [String(os.number), os.customer_display, os.equipment_display, os.plate, os.workshop_name]
    .filter(Boolean)
    .some((campo) => String(campo).toLowerCase().includes(t));
}

export function OsAReceberDialog({
  fila,
  cashSessionId,
  onRecebido,
  onClose,
}: {
  fila: FilaDeRecebimento;
  cashSessionId: string | null;
  onRecebido: (r: RecebimentoDaOs) => void;
  onClose: () => void;
}) {
  const [termo, setTermo] = useState('');
  const [recebendo, setRecebendo] = useState<OsAReceber | null>(null);
  const buscaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recebendo) buscaRef.current?.focus();
  }, [recebendo]);

  // Esc fecha a lista — mas não enquanto o recebimento está aberto por cima.
  useEffect(() => {
    if (recebendo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recebendo, onClose]);

  const visiveis = useMemo(() => fila.items.filter((os) => casa(os, termo)), [fila.items, termo]);

  if (recebendo) {
    return (
      <RecebimentoOsDialog
        os={recebendo}
        cashSessionId={cashSessionId}
        faturamentoAPrazo={fila.faturamentoAPrazo}
        onCancel={() => setRecebendo(null)}
        onRecebido={(r) => {
          setRecebendo(null);
          onRecebido(r);
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label="OS a receber"
    >
      <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            OS a receber
          </h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Serviços concluídos pela bancada esperando o caixa. Receber cria a venda da OS neste
            caixa e finaliza a ordem — o mesmo fato, registrado uma vez.
          </p>
        </header>
        <div className="px-6 py-4 flex flex-col gap-3">
          <input
            ref={buscaRef}
            aria-label="Buscar OS a receber"
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Número da OS, cliente, aparelho ou placa"
            className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
              bg-[var(--gs-surface)] text-[var(--gs-text)]"
          />
          {fila.items.length === 0 ? (
            <p className="m-0 text-[var(--gs-muted)]">
              Nenhuma OS esperando pagamento agora.
            </p>
          ) : visiveis.length === 0 ? (
            <p className="m-0 text-[var(--gs-muted)]">Nenhuma OS da fila casa com “{termo}”.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col divide-y divide-[var(--gs-border)]">
              {visiveis.map((os) => (
                <li key={os.id} className="flex items-center justify-between gap-4 py-3">
                  <span className="flex flex-col">
                    <strong>OS #{os.number}</strong>
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                      {[os.customer_display ?? 'Sem cliente', os.equipment_display, os.plate]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {os.workshop_name && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {os.workshop_name}
                        {os.mechanic_name ? ` · ${os.mechanic_name}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <strong className="tabular-nums">{formatCents(os.total_cents)}</strong>
                    <Button
                      size="sm"
                      aria-label={`Receber OS #${os.number}`}
                      onClick={() => setRecebendo(os)}
                    >
                      Receber
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>
              Fechar (Esc)
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
