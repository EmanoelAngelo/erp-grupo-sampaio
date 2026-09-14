/**
 * Os botões do pedido que pedem MOTIVO antes de chamar o servidor.
 *
 *   Cancelar (GAP-PRD-124) — o pedido aguardando pagamento só se cancelava
 *   pelo portal do cliente ou pela expiração de 25 h; a rota existia e a tela
 *   não. O produto acabou, o cliente desistiu por telefone: a reserva ficava
 *   presa. Agora o gestor cancela, com motivo, e a reserva sai na hora.
 *
 *   Desfazer etapa (GAP-PRD-121) — o servidor passou a aceitar só a PRÓXIMA
 *   etapa. O clique errado ("entregue" antes de o cliente chegar) tem a sua
 *   porta: volta UMA etapa, com motivo, e só a gerência pode.
 *
 *   Devolver (GAP-PRD-122, GAP-PRD-031) — o dinheiro volta; a mercadoria, só
 *   se estiver na mão.
 *
 * As perguntas são da TELA (`PerguntaDaTela`, GAP-PRD-158), e não do diálogo
 * do navegador: prendem o foco, têm a mesma cara em todo navegador e conferem
 * o tamanho mínimo do motivo ANTES de o servidor ser chamado — ele recusaria,
 * e a pessoa ficaria sem saber por quê. Fechar o diálogo é desistir.
 */
import { useState } from 'react';
import { Button } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { useConfirmar, usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import { ApiRequestError } from '@/lib/api/client';
import { pedidosApi, resumoDaDevolucao } from '@/lib/api/pedidos';

interface Props {
  pedido: { id: string; number: number };
  aoConcluir: () => void | Promise<void>;
  aoFalhar: (mensagem: string) => void;
}

function mensagemDe(err: unknown, padrao: string): string {
  return err instanceof ApiRequestError ? err.message : padrao;
}

export function BotaoCancelarPedido({ pedido, aoConcluir, aoFalhar }: Props) {
  const [enviando, setEnviando] = useState(false);
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();

  const cancelar = async () => {
    // O servidor exige o motivo (GAP-PRD-124): o diálogo não fecha em branco.
    const motivo = await pedirMotivo({
      titulo: `Cancelar o pedido #${pedido.number}`,
      explicacao:
        'A reserva do estoque é liberada na hora e a cobrança deixa de valer. O motivo fica na linha do tempo do pedido.',
      rotulo: 'Motivo do cancelamento',
      confirmar: 'Cancelar o pedido',
      perigoso: true,
    });
    if (motivo === null) return;
    setEnviando(true);
    try {
      await pedidosApi.cancelar(pedido.id, motivo);
      await aoConcluir();
    } catch (err) {
      aoFalhar(mensagemDe(err, 'Não foi possível cancelar o pedido.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      {dialogoDeMotivo}
      <Button size="sm" variant="ghost" onClick={() => void cancelar()} disabled={enviando}>
        {enviando ? 'Cancelando…' : 'Cancelar'}
      </Button>
    </>
  );
}

/** Etapas em que a mercadoria já saiu da loja: devolver pede conferência. */
const SAIU_DA_LOJA = new Set(['expedido', 'entregue']);

/**
 * DEVOLVER — o dinheiro volta; a mercadoria, só se estiver na mão.
 *
 * Pedido expedido ou entregue pergunta se o pacote já voltou e foi conferido:
 * sim devolve ao estoque agora; não deixa o estoque esperando o recebimento.
 * Nas etapas em que a mercadoria nunca saiu da loja, a pergunta não existe.
 */
export function BotaoDevolverPedido({
  pedido,
  aoConcluir,
  aoFalhar,
}: {
  pedido: { id: string; number: number; status: string; total_cents: number };
  aoConcluir: (resumo: string) => void | Promise<void>;
  aoFalhar: (mensagem: string) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  const { confirmar, dialogoDeConfirmacao } = useConfirmar();

  const devolver = async () => {
    // Dinheiro saindo pede confirmação com o número na frente. O motivo segue
    // opcional, como o servidor aceita — só desistir cancela a devolução.
    const motivo = await pedirMotivo({
      titulo: `Devolver o pedido #${pedido.number} (${formatCents(pedido.total_cents)})`,
      explicacao: 'O dinheiro volta ao cliente (estorno no provedor, quando houver cobrança online).',
      rotulo: 'Motivo da devolução (fica na linha do tempo do pedido)',
      opcional: true,
      confirmar: 'Devolver o dinheiro',
      perigoso: true,
    });
    if (motivo === null) return;
    let mercadoriaNaMao: boolean | undefined;
    if (SAIU_DA_LOJA.has(pedido.status)) {
      // O foco começa em "Ainda não voltou" (a pergunta da tela começa pelo
      // lado seguro): Enter por reflexo não põe no estoque o que não chegou.
      mercadoriaNaMao = await confirmar({
        titulo: 'A mercadoria já voltou para a loja e foi conferida?',
        mensagem:
          'Se voltou, ela entra no estoque agora. Se ainda não, o estoque espera o recebimento, na ficha do pedido.',
        confirmar: 'Voltou e foi conferida',
        cancelar: 'Ainda não voltou',
      });
    }
    setEnviando(true);
    try {
      const r = await pedidosApi.devolver(pedido.id, { reason: motivo, mercadoriaNaMao });
      await aoConcluir(resumoDaDevolucao(pedido.number, r));
    } catch (err) {
      aoFalhar(mensagemDe(err, 'Falha ao devolver o pedido.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      {dialogoDeMotivo}
      {dialogoDeConfirmacao}
      <Button size="sm" variant="ghost" onClick={() => void devolver()} disabled={enviando}>
        {enviando ? 'Devolvendo…' : 'Devolver'}
      </Button>
    </>
  );
}

export function BotaoDesfazerEtapa({
  pedido,
  rotuloAtual,
  rotuloAnterior,
  aoConcluir,
  aoFalhar,
}: Props & { rotuloAtual: string; rotuloAnterior: string }) {
  const [enviando, setEnviando] = useState(false);
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();

  const desfazer = async () => {
    const motivo = await pedirMotivo({
      titulo: `Voltar o pedido #${pedido.number} de "${rotuloAtual}" para "${rotuloAnterior}"`,
      explicacao: 'O motivo fica na linha do tempo e na auditoria.',
      rotulo: 'Por que a etapa está sendo desfeita',
      minimo: 5,
      confirmar: 'Voltar a etapa',
    });
    if (motivo === null) return;
    setEnviando(true);
    try {
      await pedidosApi.desfazerEtapa(pedido.id, motivo);
      await aoConcluir();
    } catch (err) {
      aoFalhar(mensagemDe(err, 'Não foi possível desfazer a etapa.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      {dialogoDeMotivo}
      <Button size="sm" variant="ghost" onClick={() => void desfazer()} disabled={enviando}>
        {enviando ? 'Voltando…' : `Desfazer etapa (voltar para ${rotuloAnterior})`}
      </Button>
    </>
  );
}
