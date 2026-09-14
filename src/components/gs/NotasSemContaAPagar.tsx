/**
 * ============================================================================
 * NOTAS RECEBIDAS SEM CONTA A PAGAR — a decisão do dono na Entrada de notas
 * ============================================================================
 *
 * GAP-PRD-088. A NF 9991 da Preço Justo entrou antes de o financeiro nascer
 * junto com o estoque, e o contas a pagar não sabe dessa dívida. O sistema não
 * a inventa de volta — pode já ter sido paga por fora —; ele PERGUNTA, aqui,
 * a quem responde pelo dinheiro, e cada resposta deixa prova:
 *
 *   Lançar a conta     o título nasce em aberto, com o vencimento escolhido;
 *   Já foi paga        o título nasce e a baixa inteira é registrada;
 *   Não gera conta     a justificativa fica gravada na nota.
 *
 * Só a gerência vê (o recorte das duas rotas). Sem pendência, não aparece.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';
import { notasSemContaApi, type NotaSemConta } from '@/lib/api/notasSemConta';

type Acao = 'lancar' | 'ja_paga' | 'sem_divida';

interface Rascunho {
  noteId: string;
  acao: Acao;
  data: string;
  forma: string;
  motivo: string;
}

export function NotasSemContaAPagar({ onDecidiu }: { onDecidiu?: () => void }) {
  const gerencia = useHasProfile('gerente_loja', 'gerente_oficina');
  const [notas, setNotas] = useState<NotaSemConta[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    if (!gerencia) return;
    try {
      setNotas(await notasSemContaApi.listar());
    } catch {
      // A lista é um aviso sobre o passado: falhar em lê-la não pode derrubar a
      // entrada de notas de hoje. Sem lista, sem cartão.
      setNotas([]);
    }
  }, [gerencia]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function confirmar() {
    if (!rascunho) return;
    setSalvando(true);
    setErro(null);
    try {
      const decisao =
        rascunho.acao === 'lancar'
          ? { acao: 'lancar' as const, ...(rascunho.data ? { dueDate: rascunho.data } : {}) }
          : rascunho.acao === 'ja_paga'
            ? { acao: 'ja_paga' as const, paidOn: rascunho.data, ...(rascunho.forma ? { method: rascunho.forma } : {}) }
            : { acao: 'sem_divida' as const, reason: rascunho.motivo.trim() };
      await notasSemContaApi.decidir(rascunho.noteId, decisao);
      setAviso(
        rascunho.acao === 'lancar'
          ? 'Conta a pagar lançada — ela aparece em Contas a pagar, ligada à nota.'
          : rascunho.acao === 'ja_paga'
            ? 'Conta lançada já paga — o título e a baixa ficam no financeiro, ligados à nota.'
            : 'Decisão registrada na nota: ela não gera conta a pagar.',
      );
      setRascunho(null);
      await carregar();
      onDecidiu?.();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a decisão.');
    } finally {
      setSalvando(false);
    }
  }

  if (!gerencia) return null;
  if (notas.length === 0) {
    return aviso ? (
      <p role="status" className="mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">{aviso}</p>
    ) : null;
  }

  const podeConfirmar =
    rascunho !== null
    && (rascunho.acao === 'lancar'
      || (rascunho.acao === 'ja_paga' && /^\d{4}-\d{2}-\d{2}$/.test(rascunho.data))
      || (rascunho.acao === 'sem_divida' && rascunho.motivo.trim().length >= 5));

  return (
    <Card
      className="mb-5"
      title="Notas recebidas sem conta a pagar"
      subtitle="Entraram no estoque antes de o financeiro nascer junto. O sistema não inventa a dívida de volta — decida cada uma."
    >
      {erro && <p role="alert" className="mt-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">{erro}</p>}
      {aviso && <p role="status" className="mt-0 text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}
      <ul className="m-0 p-0 list-none flex flex-col gap-3">
        {notas.map((n) => (
          <li key={n.id} className="border-t border-[var(--gs-border)] pt-3 first:border-t-0 first:pt-0">
            <p className="m-0 text-[length:var(--gs-text-sm)]">
              <strong>
                {n.docType === 'manual' ? 'Entrada manual' : 'NF-e'} {n.number ?? '—'}
              </strong>
              {' · '}
              {n.supplierName ?? 'fornecedor não identificado'}
              {' · '}
              <strong>{formatCents(n.totalCents)}</strong>
              {n.receivedAt ? ` · recebida em ${dataBR(n.receivedAt)}` : ''}
            </p>
            {rascunho?.noteId === n.id ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                  O que fazer
                  <select
                    aria-label={`Decisão sobre a nota ${n.number ?? ''}`}
                    value={rascunho.acao}
                    onChange={(e) =>
                      setRascunho({
                        ...rascunho,
                        acao: e.target.value as Acao,
                        data: e.target.value === 'lancar' ? n.vencimentoSugerido : '',
                      })
                    }
                    className="h-10 px-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)]"
                  >
                    <option value="lancar">Lançar a conta a pagar</option>
                    <option value="ja_paga">Já foi paga (fora do sistema)</option>
                    <option value="sem_divida">Esta nota não gera conta</option>
                  </select>
                </label>
                {rascunho.acao !== 'sem_divida' && (
                  <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                    {rascunho.acao === 'lancar' ? 'Vencimento' : 'Paga em'}
                    <Input
                      type="date"
                      aria-label={rascunho.acao === 'lancar' ? 'Vencimento' : 'Paga em'}
                      value={rascunho.data}
                      onChange={(e) => setRascunho({ ...rascunho, data: e.target.value })}
                    />
                  </label>
                )}
                {rascunho.acao === 'ja_paga' && (
                  <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                    Forma
                    <Input
                      aria-label="Forma de pagamento"
                      value={rascunho.forma}
                      onChange={(e) => setRascunho({ ...rascunho, forma: e.target.value })}
                      placeholder="pix, boleto, transferência…"
                    />
                  </label>
                )}
                {rascunho.acao === 'sem_divida' && (
                  <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)] min-w-[18rem]">
                    Por quê
                    <Input
                      aria-label="Por que a nota não gera conta"
                      value={rascunho.motivo}
                      onChange={(e) => setRascunho({ ...rascunho, motivo: e.target.value })}
                      placeholder="Bonificação, consignação, troca em garantia…"
                    />
                  </label>
                )}
                <Button size="sm" loading={salvando} disabled={!podeConfirmar} onClick={() => void confirmar()}>
                  Confirmar decisão
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRascunho(null)}>
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
                  setRascunho({ noteId: n.id, acao: 'lancar', data: n.vencimentoSugerido, forma: '', motivo: '' });
                }}
              >
                Decidir
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
