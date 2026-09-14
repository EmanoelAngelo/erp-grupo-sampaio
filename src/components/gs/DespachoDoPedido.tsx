/**
 * O DESPACHO do pedido — no lugar do `window.prompt` (GAP-PRD-119/120).
 *
 * O prompt pedia só um código, em texto solto: ninguém dizia QUEM levava a
 * encomenda, e o portal não tinha para que site mandar o cliente. Aqui:
 *
 *   - com etiqueta do Melhor Envio já gerada, o código vem DELA — o operador
 *     só confirma o despacho;
 *   - sem etiqueta (postado no balcão da agência, motoboy, transportadora
 *     local), o operador escolhe quem leva e informa o código, que para os
 *     Correios o servidor confere (AA123456789BR);
 *   - com etiqueta paga mas não gerada, não despacha: a tela diz o que falta.
 *
 * Cancelar é desistir do despacho — nada é enviado ao servidor.
 */
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { enviosApi, TRANSPORTADORAS_DO_DESPACHO, type Envio } from '@/lib/api/envios';

export function DespachoDoPedido({
  order,
  onFeito,
  onCancelar,
}: {
  order: { id: string; number: number };
  onFeito: () => void;
  onCancelar: () => void;
}) {
  const [etiqueta, setEtiqueta] = useState<Envio | null>(null);
  const [consultado, setConsultado] = useState(false);
  const [carrier, setCarrier] = useState('');
  const [codigo, setCodigo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    enviosApi
      .doPedido(order.id)
      .then((r) => {
        if (!vivo) return;
        const doProvedor = (Array.isArray(r?.items) ? r.items : []).find(
          (e) => e && e.channel === 'melhor_envio' && e.status !== 'cancelado',
        );
        setEtiqueta(doProvedor ?? null);
      })
      // Sem acesso à logística (ou servidor antigo): despacha pelo formulário.
      .catch(() => undefined)
      .finally(() => {
        if (vivo) setConsultado(true);
      });
    return () => {
      vivo = false;
    };
  }, [order.id]);

  const pendente = etiqueta && (etiqueta.status === 'pendente' || etiqueta.status === 'paga');

  const despachar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      await apiRequest(`/core/orders/${order.id}/fulfillment`, {
        method: 'POST',
        body: etiqueta
          ? { status: 'expedido' }
          : { status: 'expedido', carrier, trackingCode: codigo.trim() || undefined },
      });
      onFeito();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao despachar o pedido.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card title={`Despachar o pedido #${order.number}`} className="mb-5">
      {!consultado ? (
        <p role="status" className="m-0 text-[var(--gs-muted)]">
          Conferindo se o pedido tem etiqueta…
        </p>
      ) : etiqueta ? (
        <p className="m-0" data-testid="despacho-com-etiqueta">
          {pendente
            ? `A etiqueta do Melhor Envio ainda não foi gerada (${etiqueta.statusLabel}). Termine a compra na ficha do pedido, ou cancele a etiqueta, antes de despachar.`
            : `Etiqueta do Melhor Envio${etiqueta.serviceName ? ` (${etiqueta.serviceName})` : ''}: `
              + (etiqueta.trackingCode ? `rastreio ${etiqueta.trackingCode}.` : 'o código de rastreio chega na consulta ao provedor.')}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quem leva a encomenda" required>
            {(p) => (
              <select
                {...p}
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-[var(--gs-text)]"
              >
                <option value="">Escolha…</option>
                {TRANSPORTADORAS_DO_DESPACHO.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.rotulo}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Código de rastreio"
            hint={
              carrier === 'correios'
                ? 'Correios: 13 caracteres, como AA123456789BR.'
                : 'Opcional: entrega própria e motoboy costumam não ter.'
            }
          >
            {(p) => <Input {...p} value={codigo} onChange={(e) => setCodigo(e.target.value)} />}
          </Field>
        </div>
      )}

      {erro && (
        <p role="alert" className="mt-3 mb-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          loading={ocupado}
          disabled={!consultado || Boolean(pendente) || (!etiqueta && !carrier)}
          onClick={() => void despachar()}
        >
          Despachar
        </Button>
        <Button variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </Card>
  );
}
