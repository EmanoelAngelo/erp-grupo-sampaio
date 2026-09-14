/**
 * O RECEBIMENTO DA MERCADORIA DEVOLVIDA, na ficha do pedido (GAP-PRD-122).
 *
 * O reembolso não mexe mais no estoque do pedido que saiu da loja: o pacote
 * pode estar na transportadora, e somar saldo agora venderia ao próximo cliente
 * o que não está na prateleira. Quando a mercadoria chega, quem confere diz
 * quanto de cada item voltou VENDÁVEL; o resto (avaria, extravio) fica
 * registrado na linha do tempo e não vira saldo.
 */
import { useMemo, useState } from 'react';
import { Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { pedidosApi } from '@/lib/api/pedidos';

interface ItemDoPedido {
  product_id: string;
  description: string;
  quantity: number;
}

interface Props {
  orderId: string;
  itens: ItemDoPedido[];
  aoConcluir: (mensagem: string) => void | Promise<void>;
  aoFalhar: (mensagem: string) => void;
}

/** Um produto por linha: o pedido pode repetir o mesmo produto. */
function agrupar(itens: ItemDoPedido[]): ItemDoPedido[] {
  const porProduto = new Map<string, ItemDoPedido>();
  for (const i of itens) {
    const atual = porProduto.get(i.product_id);
    porProduto.set(
      i.product_id,
      atual ? { ...atual, quantity: atual.quantity + Number(i.quantity) } : { ...i, quantity: Number(i.quantity) },
    );
  }
  return [...porProduto.values()];
}

export function RecebimentoDaDevolucao({ orderId, itens, aoConcluir, aoFalhar }: Props) {
  const linhas = useMemo(() => agrupar(itens), [itens]);
  const [quantidades, setQuantidades] = useState<Record<string, string>>(() =>
    Object.fromEntries(linhas.map((l) => [l.product_id, String(l.quantity)])),
  );
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);

  const confirmar = async () => {
    const pedidos: { productId: string; quantidade: number }[] = [];
    for (const l of linhas) {
      const q = Number(String(quantidades[l.product_id] ?? '').replace(',', '.'));
      if (!Number.isFinite(q) || q < 0 || q > l.quantity) {
        aoFalhar(`"${l.description}": a quantidade que volta ao estoque vai de 0 a ${l.quantity}.`);
        return;
      }
      pedidos.push({ productId: l.product_id, quantidade: q });
    }
    setEnviando(true);
    try {
      const r = await pedidosApi.receberDevolucao(orderId, {
        itens: pedidos,
        nota: nota.trim() || undefined,
      });
      await aoConcluir(
        `Recebimento registrado: ${r.unidadesDeVolta} unidade(s) de volta ao estoque`
          + (r.unidadesQueNaoVoltaram > 0
            ? `; ${r.unidadesQueNaoVoltaram} não voltaram (avaria ou extravio).`
            : '.'),
      );
    } catch (err) {
      aoFalhar(err instanceof ApiRequestError ? err.message : 'Não foi possível registrar o recebimento.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Card
      title="Mercadoria devolvida a conferir"
      subtitle="O pedido foi reembolsado. O estoque só volta com o que for conferido aqui — o que não voltar vendável fica registrado como avaria ou extravio."
    >
      <div data-testid="recebimento-da-devolucao" className="flex flex-col gap-3">
        {linhas.map((l) => (
          <Field key={l.product_id} label={`${l.description} — volta ao estoque (de ${l.quantity})`}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={l.quantity}
                step="any"
                value={quantidades[l.product_id] ?? ''}
                onChange={(e) =>
                  setQuantidades((atual) => ({ ...atual, [l.product_id]: e.target.value }))
                }
              />
            )}
          </Field>
        ))}
        <Field label="Observação (opcional)">
          {(p) => <Input {...p} value={nota} onChange={(e) => setNota(e.target.value)} />}
        </Field>
        <div>
          <Button onClick={() => void confirmar()} disabled={enviando}>
            {enviando ? 'Registrando…' : 'Confirmar recebimento'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
