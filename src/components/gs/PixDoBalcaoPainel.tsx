/**
 * O QR DO PIX NA TELA DO CAIXA (GAP-PRD-077).
 *
 * O diálogo de pagamento prometia "o QR na tela do computador" e não havia QR
 * nenhum: o operador conferia o app do banco e lançava como recebido. Este
 * painel mostra o QR que o provedor gerou NA CONTA DA OPERAÇÃO e acompanha:
 *
 *   - a cada 3 segundos LÊ o que o ERP sabe (o webhook pode ter confirmado);
 *   - "Já pagou?" PERGUNTA AO PROVEDOR — o webhook não é a única porta;
 *   - pago → a linha entra na venda liquidada;
 *   - o cliente precisa ir → "Receber depois" põe a linha PENDENTE, e o
 *     webhook (ou a consulta automática) a liquida quando o dinheiro cair;
 *   - "Desistir" CANCELA a cobrança no provedor: QR largado vivo é dinheiro
 *     entrando sem venda.
 *
 * A tela nunca decide que o PIX foi pago: quem diz é o servidor, e ele só diz
 * depois do provedor.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';
import { formatCents } from './format';
import { ApiRequestError } from '@/lib/api/client';
import { pixBalcaoApi, type PixDoBalcao } from '@/lib/api/pixBalcao';

export function PixDoBalcaoPainel({
  pix,
  onAtualizou,
  onPago,
  onReceberDepois,
  onDesistiu,
}: {
  pix: PixDoBalcao;
  onAtualizou: (pix: PixDoBalcao) => void;
  onPago: (pix: PixDoBalcao) => void;
  onReceberDepois: (pix: PixDoBalcao) => void;
  onDesistiu: () => void;
}) {
  const [ocupado, setOcupado] = useState<'consultar' | 'cancelar' | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const tratar = useCallback(
    (atual: PixDoBalcao) => {
      onAtualizou(atual);
      if (atual.status === 'confirmed') onPago(atual);
    },
    [onAtualizou, onPago],
  );

  // A leitura automática: só o que o ERP já sabe, sem ir ao provedor a cada
  // três segundos (o limite de requisições do provedor é da conta inteira).
  useEffect(() => {
    const relogio = setInterval(() => {
      void pixBalcaoApi
        .situacao(pix.intentId)
        .then(tratar)
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(relogio);
  }, [pix.intentId, tratar]);

  const consultar = useCallback(async () => {
    setOcupado('consultar');
    setErro(null);
    try {
      tratar(await pixBalcaoApi.situacao(pix.intentId, true));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível consultar o provedor.');
    } finally {
      setOcupado(null);
    }
  }, [pix.intentId, tratar]);

  const desistir = useCallback(async () => {
    setOcupado('cancelar');
    setErro(null);
    try {
      await pixBalcaoApi.cancelar(pix.intentId);
      onDesistiu();
    } catch (err) {
      // Não cancelou lá: o QR continua pagável, e a tela não pode fingir que não.
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível cancelar o PIX.');
    } finally {
      setOcupado(null);
    }
  }, [pix.intentId, onDesistiu]);

  const parado = pix.status !== 'pending' && pix.status !== 'overdue' && pix.status !== 'confirmed';

  return (
    <div
      data-testid="pdv-pix-asaas"
      className="p-4 rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] flex flex-col gap-3"
    >
      <strong className="text-[var(--gs-purple-900)]">
        PIX de {formatCents(pix.amountCents)} — QR gerado pelo sistema
      </strong>
      {pix.environment === 'sandbox' && (
        <span className="text-[length:var(--gs-text-xs)] font-semibold text-[var(--gs-warning)]">
          Ambiente de testes do provedor: este QR não cobra ninguém de verdade.
        </span>
      )}
      {pix.pixImageBase64 && (
        <img
          src={`data:image/png;base64,${pix.pixImageBase64}`}
          alt="QR Code do PIX da venda"
          className="w-44 h-44 self-start bg-white"
        />
      )}
      {pix.pixPayload && (
        <code
          aria-label="Copia e cola do PIX da venda"
          className="break-all px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-surface)]
            border border-[var(--gs-border)] text-[length:var(--gs-text-xs)]"
        >
          {pix.pixPayload}
        </code>
      )}
      <p role="status" className="m-0 font-semibold text-[length:var(--gs-text-sm)]">
        {pix.status === 'confirmed'
          ? 'PAGO — confirmado pelo provedor.'
          : parado
            ? `Este PIX está como "${pix.status}" e não fecha a venda. Desista e gere outro, ou receba por outro meio.`
            : 'AGUARDANDO PAGAMENTO — a venda fecha quando o provedor confirmar.'}
      </p>
      {erro && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      <span className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          loading={ocupado === 'consultar'}
          disabled={parado}
          onClick={() => void consultar()}
        >
          Já pagou? Consultar o provedor
        </Button>
        <Button type="button" variant="ghost" disabled={parado} onClick={() => onReceberDepois(pix)}>
          Receber depois (fica pendente)
        </Button>
        <Button type="button" variant="ghost" loading={ocupado === 'cancelar'} onClick={() => void desistir()}>
          Desistir e cancelar o QR
        </Button>
      </span>
      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
        "Receber depois" fecha a venda com o PIX pendente: a gerência acompanha em Contas a receber, e o
        pagamento que cair depois liquida a venda sozinho.
      </span>
    </div>
  );
}
