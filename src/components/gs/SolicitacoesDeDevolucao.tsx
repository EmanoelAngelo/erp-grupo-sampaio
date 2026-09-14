/**
 * OS PEDIDOS DE DEVOLUÇÃO DA CLIENTE, na ficha do pedido (GAP-PRD-125).
 *
 * A cliente pede pelo portal; aqui a loja aprova ou recusa. Recusar exige
 * motivo, porque a cliente o lê no portal. Aprovar não move dinheiro nem
 * estoque: o reembolso é o "Devolver", que conclui a solicitação.
 */
import { useState } from 'react';
import { Button, Card } from '@/components/gs/ui';
import { usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import { ApiRequestError } from '@/lib/api/client';
import { pedidosApi } from '@/lib/api/pedidos';
import type { SolicitacaoDeDevolucao } from '@/lib/api/posVenda';

interface Props {
  orderId: string;
  solicitacoes: SolicitacaoDeDevolucao[];
  aoConcluir: (mensagem: string) => void | Promise<void>;
  aoFalhar: (mensagem: string) => void;
}

export function SolicitacoesDeDevolucao({ orderId, solicitacoes, aoConcluir, aoFalhar }: Props) {
  const [enviando, setEnviando] = useState<string | null>(null);
  // Antes do retorno cedo: a ordem dos ganchos não muda com a lista vazia.
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();

  if (solicitacoes.length === 0) return null;

  const decidir = async (s: SolicitacaoDeDevolucao, decisao: 'aprovar' | 'recusar') => {
    // A pergunta é da TELA (GAP-PRD-158). Recusar exige motivo, porque a cliente
    // o lê no portal; aprovar aceita a instrução em branco.
    const nota = await pedirMotivo(
      decisao === 'aprovar'
        ? {
            titulo: 'Aprovar a devolução',
            explicacao:
              'Aprovar não move dinheiro nem estoque: o reembolso é o "Devolver", quando a mercadoria chegar.',
            rotulo: 'Instrução para a cliente (opcional — ex.: "traga na loja com a etiqueta")',
            opcional: true,
            confirmar: 'Aprovar',
          }
        : {
            titulo: 'Recusar a devolução',
            explicacao: 'A cliente lê o motivo no portal.',
            rotulo: 'Motivo da recusa',
            minimo: 5,
            confirmar: 'Recusar a devolução',
            perigoso: true,
          },
    );
    if (nota === null) return;
    setEnviando(s.id);
    try {
      await pedidosApi.decidirSolicitacao(orderId, s.id, { decisao, nota: nota || undefined });
      await aoConcluir(
        decisao === 'aprovar'
          ? 'Devolução aprovada. Quando a mercadoria chegar, use "Devolver" para reembolsar.'
          : 'Devolução recusada. A cliente vê o motivo no portal.',
      );
    } catch (err) {
      aoFalhar(err instanceof ApiRequestError ? err.message : 'Não foi possível registrar a decisão.');
    } finally {
      setEnviando(null);
    }
  };

  return (
    <Card title="Pedidos de devolução da cliente" subtitle="Abertos pelo portal, depois da entrega.">
      {dialogoDeMotivo}
      <ul data-testid="solicitacoes-de-devolucao" className="list-none p-0 m-0 flex flex-col gap-3">
        {solicitacoes.map((s) => (
          <li key={s.id} className="text-[length:var(--gs-text-sm)]">
            <strong>{s.kindLabel}</strong> — {s.statusLabel}
            <span className="block">Relato da cliente: {s.reason}</span>
            {s.decisionNote && <span className="block text-[var(--gs-muted)]">Resposta: {s.decisionNote}</span>}
            {s.status === 'aberta' && (
              <span className="inline-flex gap-2 mt-2">
                <Button size="sm" onClick={() => void decidir(s, 'aprovar')} disabled={enviando === s.id}>
                  Aprovar devolução
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void decidir(s, 'recusar')}
                  disabled={enviando === s.id}
                >
                  Recusar
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
