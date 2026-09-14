/**
 * Compras › Conciliação de recebimento — pedido de compra × NF-e, item a item.
 *
 * ## Por que uma PÁGINA, e não uma seção de Pedidos de compra
 *
 * A tela de Pedidos cuida do COMPROMISSO: criar, enviar, cancelar. Esta cuida
 * do CONFRONTO: o que a nota fatura contra o que foi pedido, o que a doca
 * contou contra o que a nota fatura. São gestos de momentos diferentes — quem
 * compra não é necessariamente quem recebe — e o confronto precisa dos itens
 * de CADA nota amarrada (uma consulta por nota), que a lista de pedidos não
 * tem motivo para pagar. A página nova entra no menu de Compras ao lado de
 * Pedidos e de Entrada de notas, que são as duas pontas que ela costura.
 *
 * ## A tela NÃO tem motor próprio
 *
 * A régua daqui é a MESMA de `recalcReceived` no servidor: o que conta é o
 * CONFERIDO, e onde ninguém conferiu vale o faturado (COALESCE), multiplicado
 * pelo fator de conversão quando o fornecedor fatura em caixa. A tela só
 * projeta essa conta linha a linha e dá nome ao que ela revela:
 *
 *   - OK ............ conferido = pedido, contagem bate com o faturado, preço bate;
 *   - PARCIAL ....... veio menos do que o pedido, sem outra divergência — o resto vem;
 *   - DIVERGÊNCIA ... doca contou diferente do faturado, sobra contra o pedido,
 *                     preço que difere, item extra da nota, item sem produto casado;
 *   - PENDENTE ...... o item do pedido não veio em nota nenhuma;
 *   - CONCLUÍDO ..... (por pedido) o servidor já o carimbou 'recebido' e nada diverge.
 *
 * E as AÇÕES são só as que o servidor suporta: abrir pedido, abrir a NF-e (a
 * conferência completa mora na Entrada de notas), conferir item, vincular nota
 * ao pedido e confirmar o recebimento. Nada aqui inventa estado: cada clique é
 * uma rota que já existia — o que faltava era a porta.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type InboundNoteItem,
  type InboundNoteSummary,
  type PurchaseOrder,
  type PurchaseOrderDetail,
  type PurchaseOrderStatus,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';

// ------------------------------------------------------------------ rótulos

const TOM_STATUS: Record<PurchaseOrderStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  rascunho: 'neutral',
  enviado: 'info',
  recebido_parcial: 'warning',
  recebido: 'success',
  cancelado: 'danger',
};

const ROTULO_STATUS: Record<PurchaseOrderStatus, string> = {
  rascunho: 'Rascunho',
  enviado: 'Enviado',
  recebido_parcial: 'Recebido em parte',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

/** Os cinco estados da conciliação — 'concluido' só existe por pedido. */
type EstadoLinha = 'ok' | 'divergencia' | 'pendente' | 'parcial';
type EstadoPedido = EstadoLinha | 'concluido';

const TOM_ESTADO: Record<EstadoPedido, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  ok: 'success',
  divergencia: 'danger',
  pendente: 'neutral',
  parcial: 'warning',
  concluido: 'success',
};

const ROTULO_ESTADO: Record<EstadoPedido, string> = {
  ok: 'OK',
  divergencia: 'Divergência',
  pendente: 'Pendente',
  parcial: 'Parcial',
  concluido: 'Concluído',
};

// -------------------------------------------------------------------- régua

/** Um item de nota com o endereço de onde ele veio — o índice É o contrato do conferir. */
interface ItemDaNota extends InboundNoteItem {
  noteId: string;
  noteNumber: string;
  index: number;
}

/** Uma linha da tabela de conciliação, já com a régua aplicada. */
interface Linha {
  key: string;
  descricao: string;
  /** Nulo para item que só existe na nota (extra ou sem produto casado). */
  pedida: number | null;
  precoPedidoCents: number | null;
  /** A quantidade da NOTA, na unidade da nota — a conversão é dita na célula. */
  faturadaTexto: string;
  conferida: number | null;
  precosNota: number[];
  estado: EstadoLinha;
  motivos: string[];
}

const fatorDe = (m: InboundNoteItem): number => m.conversionFactor ?? 1;

/** A MESMA régua de recalcReceived: conferido COALESCE faturado, × fator. */
const conferidaDe = (m: InboundNoteItem): number =>
  (m.receivedQuantity ?? m.quantity) * fatorDe(m);

/**
 * A linha de um ITEM DO PEDIDO contra tudo o que as notas amarradas trazem
 * daquele produto. A comparação de preço multiplica o preço do pedido pelo
 * fator — pedido em UN, nota em CX — para ficar em centavos INTEIROS dos dois
 * lados, em vez de dividir e arredondar.
 */
function linhaDoPedido(
  item: PurchaseOrderDetail['items'][number],
  casados: ItemDaNota[],
): Linha {
  const base = {
    key: item.id,
    descricao: item.description,
    pedida: item.quantity,
    precoPedidoCents: item.unit_cost_cents,
    precosNota: [...new Set(casados.map((m) => m.unitCostCents))],
  };

  if (casados.length === 0) {
    return {
      ...base,
      faturadaTexto: '—',
      conferida: null,
      estado: 'pendente',
      motivos: ['não veio em nota'],
    };
  }

  const faturada = casados.reduce((soma, m) => soma + m.quantity * fatorDe(m), 0);
  const conferida = casados.reduce((soma, m) => soma + conferidaDe(m), 0);

  // A conversão é DITA na célula: "2 × 12 = 24" — quem lê 2 numa linha de 24
  // pedidos precisa saber que são caixas, não unidades faltando.
  const faturadaTexto =
    casados.length === 1 && fatorDe(casados[0]) !== 1
      ? `${formatQuantity(casados[0].quantity)} × ${formatQuantity(fatorDe(casados[0]))} = ${formatQuantity(faturada)}`
      : formatQuantity(faturada);

  const motivos: string[] = [];
  if (conferida > item.quantity) motivos.push('sobra contra o pedido');
  if (conferida < faturada) motivos.push('a doca contou menos que o faturado');
  if (conferida > faturada) motivos.push('a doca contou mais que o faturado');
  if (casados.some((m) => m.unitCostCents !== item.unit_cost_cents * fatorDe(m))) {
    motivos.push('preço difere do pedido');
  }

  if (motivos.length > 0) return { ...base, faturadaTexto, conferida, estado: 'divergencia', motivos };
  if (conferida < item.quantity) {
    return {
      ...base,
      faturadaTexto,
      conferida,
      estado: 'parcial',
      motivos: [`faltam ${formatQuantity(item.quantity - conferida)}`],
    };
  }
  return { ...base, faturadaTexto, conferida, estado: 'ok', motivos: [] };
}

/** A linha de um item que SÓ existe na nota: extra (produto fora do pedido) ou sem casamento. */
function linhaDaNota(m: ItemDaNota, key: string, motivo: string): Linha {
  return {
    key,
    descricao: m.description,
    pedida: null,
    precoPedidoCents: null,
    faturadaTexto:
      fatorDe(m) !== 1
        ? `${formatQuantity(m.quantity)} × ${formatQuantity(fatorDe(m))} = ${formatQuantity(m.quantity * fatorDe(m))}`
        : formatQuantity(m.quantity),
    conferida: conferidaDe(m),
    precosNota: [m.unitCostCents],
    estado: 'divergencia',
    motivos: [motivo],
  };
}

function montarLinhas(detalhe: PurchaseOrderDetail, itensDasNotas: ItemDaNota[]): Linha[] {
  const produtosDoPedido = new Set(
    detalhe.items.map((i) => i.product_id).filter((p): p is string => p !== null),
  );

  const linhas = detalhe.items.map((item) =>
    linhaDoPedido(
      item,
      itensDasNotas.filter((m) => m.productId !== null && m.productId === item.product_id),
    ),
  );

  for (const m of itensDasNotas) {
    if (m.productId && !produtosDoPedido.has(m.productId)) {
      // Produto casado no catálogo, mas que NINGUÉM pediu: é a divergência
      // mais silenciosa — sem esta linha, ele entraria no estoque calado.
      linhas.push(
        linhaDaNota(m, `extra-${m.noteId}-${m.index}`, 'item extra da nota — produto fora do pedido'),
      );
    } else if (!m.productId) {
      // Sem produto casado a régua do recalc não o conta — e a tela precisa
      // dizer isso, senão o item some da comparação sem deixar rastro.
      linhas.push(
        linhaDaNota(m, `solto-${m.noteId}-${m.index}`, 'sem produto casado — não conta para o pedido'),
      );
    }
  }

  return linhas;
}

/** O estado do PEDIDO é o pior estado das linhas — e 'concluido' vem do servidor. */
function estadoDoPedido(detalhe: PurchaseOrderDetail, linhas: Linha[]): EstadoPedido {
  if (linhas.some((l) => l.estado === 'divergencia')) return 'divergencia';
  if (detalhe.status === 'recebido') return 'concluido';
  if (detalhe.status === 'recebido_parcial' || linhas.some((l) => l.estado === 'parcial')) {
    return 'parcial';
  }
  if (linhas.length > 0 && linhas.every((l) => l.estado === 'ok')) return 'ok';
  return 'pendente';
}

// -------------------------------------------------------------------- tela

export default function ConciliacaoRecebimentoPage() {
  const [pedidos, setPedidos] = useState<PurchaseOrder[] | null>(null);
  const [notas, setNotas] = useState<InboundNoteSummary[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [detalhe, setDetalhe] = useState<PurchaseOrderDetail | null>(null);
  const [itensDasNotas, setItensDasNotas] = useState<ItemDaNota[]>([]);
  const [notaAVincular, setNotaAVincular] = useState('');
  const [agindo, setAgindo] = useState(false);

  // Conferência: o valor digitado por item de nota, antes de virar POST.
  const [contagens, setContagens] = useState<Record<string, string>>({});
  const [fatores, setFatores] = useState<Record<string, string>>({});

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setPedidos(await coreApi.listPurchaseOrders());
      setNotas(await coreApi.listInboundNotes());
    } catch (err) {
      setPedidos(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os pedidos.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrir = useCallback(async (id: string) => {
    setErro(null);
    try {
      const pedido = await coreApi.getPurchaseOrder(id);
      // Uma consulta por nota amarrada: é dos ITENS delas que a régua vive.
      const porNota = await Promise.all(
        pedido.inboundNotes.map(async (n) => {
          const itens = await coreApi.listInboundNoteItems(n.id);
          return itens.map((item, index) => ({
            ...item,
            noteId: n.id,
            noteNumber: n.number ?? n.access_key.slice(-8),
            index,
          }));
        }),
      );
      setDetalhe(pedido);
      setItensDasNotas(porNota.flat());
      setNotaAVincular('');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir o pedido.');
    }
  }, []);

  const conferir = async (item: ItemDaNota) => {
    const chave = `${item.noteId}:${item.index}`;
    const contado = Number(contagens[chave]);
    if (!Number.isFinite(contado) || contado < 0) {
      setErro('Informe a quantidade contada para conferir.');
      return;
    }
    setAgindo(true);
    setErro(null);
    setAviso(null);
    try {
      const fator = Number(fatores[chave]);
      await coreApi.conferirInboundNoteItem(item.noteId, {
        itemIndex: item.index,
        receivedQuantity: contado,
        // O fator só viaja quando alguém o informou — em branco, o servidor
        // continua decidindo pela unidade da nota e do cadastro.
        ...(Number.isFinite(fator) && fator > 0 ? { conversionFactor: fator } : {}),
      });
      setAviso('Conferência registrada.');
      if (detalhe) await abrir(detalhe.id);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao conferir o item.');
    } finally {
      setAgindo(false);
    }
  };

  const confirmarRecebimento = async (noteId: string) => {
    setAgindo(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.confirmInboundNote(noteId);
      setAviso('Recebimento confirmado: estoque e financeiro andaram, e o pedido junto.');
      await carregar();
      if (detalhe) await abrir(detalhe.id);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao confirmar o recebimento.');
    } finally {
      setAgindo(false);
    }
  };

  const vincular = async () => {
    if (!detalhe || !notaAVincular) return;
    setAgindo(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.linkNoteToPurchaseOrder(detalhe.id, notaAVincular);
      setAviso('Nota vinculada ao pedido.');
      await carregar();
      await abrir(detalhe.id);
    } catch (err) {
      // O servidor é quem decide: fornecedor errado e pedido cancelado voltam
      // daqui com a frase deles — a tela só a repete.
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao vincular a nota.');
    } finally {
      setAgindo(false);
    }
  };

  const linhas = detalhe ? montarLinhas(detalhe, itensDasNotas) : [];
  const estadoGeral = detalhe ? estadoDoPedido(detalhe, linhas) : null;

  // Candidatas a vincular: toda nota que não está NESTE pedido. A lista não
  // diz a qual pedido cada nota já pertence (a resposta não traz o vínculo);
  // re-amarrar é suportado — o servidor reprojeta os dois pedidos.
  const jaAmarradas = new Set(detalhe?.inboundNotes.map((n) => n.id) ?? []);
  const candidatas = notas.filter((n) => !jaAmarradas.has(n.id));

  // As notas amarradas que ainda NÃO viraram entrada: é nelas que se confere.
  // A ESTORNADA fica de fora (GAP-V20): documento morto não se confere nem
  // ganha botão de confirmar — oferecer o gesto seria prometer o que o
  // servidor recusa com 409.
  const emConferencia =
    detalhe?.inboundNotes.filter((n) => n.status !== 'recebida' && n.status !== 'estornada') ?? [];

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Compras', 'Conciliação']}
        title="Conciliação de recebimento"
        subtitle="O pedido é o combinado, a nota é o que chegou — esta tela mostra a diferença"
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {detalhe && (
        <Card title={`Pedido #${detalhe.number}`}>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <span data-testid="estado-do-pedido">
              {estadoGeral && <Badge tone={TOM_ESTADO[estadoGeral]}>{ROTULO_ESTADO[estadoGeral]}</Badge>}
            </span>
            <Badge tone={TOM_STATUS[detalhe.status]}>{ROTULO_STATUS[detalhe.status]}</Badge>
            <span className="text-[length:var(--gs-text-sm)]">
              {detalhe.supplier?.name ?? '—'}
              {detalhe.supplier?.document ? ` · ${detalhe.supplier.document}` : ''}
            </span>
          </div>

          {detalhe.inboundNotes.length === 0 ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Nenhuma nota amarrada a este pedido ainda — vincule abaixo quando ela chegar.
            </p>
          ) : (
            <ul className="list-none p-0 m-0 mb-3 flex flex-col gap-2">
              {detalhe.inboundNotes.map((n) => (
                <li
                  key={n.id}
                  className="flex flex-wrap items-center gap-3 text-[length:var(--gs-text-sm)]
                    border border-[var(--gs-border)] rounded-[var(--gs-radius)] px-3 py-2"
                >
                  <span className="font-semibold">NF {n.number ?? '—'}/{n.series ?? '—'}</span>
                  <span className="font-mono text-[var(--gs-muted)] break-all">{n.access_key}</span>
                  <Badge
                    tone={
                      n.status === 'estornada'
                        ? 'danger'
                        : n.status === 'recebida'
                          ? 'success'
                          : 'info'
                    }
                  >
                    {/* O terceiro estado tem selo próprio (GAP-V20): chamar a
                        estornada de "Em conferência" convidaria a conferir um
                        documento morto. */}
                    {n.status === 'estornada'
                      ? 'Estornada'
                      : n.status === 'recebida'
                        ? 'Recebida'
                        : 'Em conferência'}
                  </Badge>
                  {n.received_at && <span>recebida em {dataBR(n.received_at)}</span>}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="font-semibold">{formatCents(n.total_cents)}</span>
                    {/* A conferência COMPLETA (vincular produto, marcar peça,
                        baixar XML) mora na Entrada de notas — duplicá-la aqui
                        seria duas telas envelhecendo separadas. */}
                    <Link
                      to="/sistema/compras/entrada-notas"
                      className="text-[var(--gs-primary)] underline"
                    >
                      Abrir NF-e
                    </Link>
                    {n.status !== 'recebida' && n.status !== 'estornada' && (
                      <Button
                        size="sm"
                        onClick={() => void confirmarRecebimento(n.id)}
                        disabled={agindo}
                      >
                        Confirmar recebimento
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Pedida</th>
                  <th className="py-2 text-right">Faturada</th>
                  <th className="py-2 text-right">Conferida</th>
                  <th className="py-2 text-right">Preço pedido</th>
                  <th className="py-2 text-right">Preço nota</th>
                  <th className="py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.key} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">
                      <span>{l.descricao}</span>
                    </td>
                    <td className="py-2 text-right">
                      {l.pedida === null ? '—' : formatQuantity(l.pedida)}
                    </td>
                    <td className="py-2 text-right">{l.faturadaTexto}</td>
                    <td className="py-2 text-right">
                      {l.conferida === null ? '—' : formatQuantity(l.conferida)}
                    </td>
                    <td className="py-2 text-right">
                      {l.precoPedidoCents === null ? '—' : formatCents(l.precoPedidoCents)}
                    </td>
                    <td className="py-2 text-right">
                      {l.precosNota.length === 0
                        ? '—'
                        : l.precosNota.map((p) => formatCents(p)).join(' / ')}
                    </td>
                    <td className="py-2">
                      <Badge tone={TOM_ESTADO[l.estado]}>{ROTULO_ESTADO[l.estado]}</Badge>
                      {l.motivos.length > 0 && (
                        <span className="block text-[var(--gs-muted)]">{l.motivos.join('; ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            A régua é a mesma do servidor: vale o que a doca CONTOU, e onde ninguém conferiu vale o
            faturado — multiplicado pelo fator quando o fornecedor fatura em caixa. O pedido só
            anda quando a nota é confirmada.
          </p>

          {emConferencia.length > 0 && (
            <div className="mt-3">
              <h3 className="text-[length:var(--gs-text-base)] font-semibold m-0 mb-2">
                Conferência da doca
              </h3>
              {emConferencia.map((n) => (
                <div key={n.id} className="mb-3">
                  <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 mb-1">
                    NF {n.number ?? '—'}/{n.series ?? '—'} — registre o que foi contado; a entrada
                    só acontece na confirmação.
                  </p>
                  <ul className="list-none p-0 m-0 flex flex-col gap-2">
                    {itensDasNotas
                      .filter((m) => m.noteId === n.id)
                      .map((m) => {
                        const chave = `${m.noteId}:${m.index}`;
                        return (
                          <li key={chave} className="flex flex-wrap items-center gap-2">
                            {/* Prefixado com a posição de propósito: é o
                                itemIndex que o servidor recebe. */}
                            <span className="text-[length:var(--gs-text-sm)]">
                              {m.index + 1}. {m.description} — faturado {formatQuantity(m.quantity)}
                              {m.unit ? ` ${m.unit}` : ''}
                            </span>
                            <Input
                              type="number"
                              min={0}
                              step="any"
                              className="w-24"
                              aria-label={`Conferida do item ${m.index + 1} da nota ${n.number ?? n.access_key.slice(-8)}`}
                              value={contagens[chave] ?? ''}
                              onChange={(e) =>
                                setContagens((atual) => ({ ...atual, [chave]: e.target.value }))
                              }
                            />
                            <Input
                              type="number"
                              min={0}
                              step="any"
                              className="w-20"
                              placeholder="fator"
                              aria-label={`Fator do item ${m.index + 1} da nota ${n.number ?? n.access_key.slice(-8)}`}
                              value={fatores[chave] ?? ''}
                              onChange={(e) =>
                                setFatores((atual) => ({ ...atual, [chave]: e.target.value }))
                              }
                            />
                            <Button size="sm" onClick={() => void conferir(m)} disabled={agindo}>
                              Conferir
                            </Button>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 mt-4">
            <Field
              label="Nota a vincular"
              hint="Só aparecem notas que ainda não estão neste pedido; fornecedor errado o servidor recusa"
            >
              {(p) => (
                <select
                  {...p}
                  value={notaAVincular}
                  onChange={(e) => setNotaAVincular(e.target.value)}
                  className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                    bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-base)]"
                >
                  <option value="">Selecione…</option>
                  {candidatas.map((n) => (
                    <option key={n.id} value={n.id}>
                      NF {n.number ?? n.access_key.slice(-8)}/{n.series ?? '—'} · {n.supplier_name ?? 'sem fornecedor'} · {formatCents(n.total_cents)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="flex items-end gap-2">
              <Button onClick={() => void vincular()} disabled={!notaAVincular || agindo}>
                Vincular ao pedido
              </Button>
              <Button variant="ghost" onClick={() => setDetalhe(null)}>
                Fechar
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Pedidos">
        {pedidos === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : pedidos.length === 0 ? (
          <EmptyState
            title="Nenhum pedido de compra"
            description="A conciliação compara nota com pedido — sem pedido, a nota entra pela Entrada de notas, sem contra o que conferir."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nº</th>
                  <th className="py-2">Fornecedor</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {pedidos.map((p) => (
                  <tr key={p.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono">#{p.number}</td>
                    <td className="py-2">{p.supplier_trade_name || p.supplier_name}</td>
                    <td className="py-2">
                      <Badge tone={TOM_STATUS[p.status]}>{ROTULO_STATUS[p.status]}</Badge>
                    </td>
                    <td className="py-2 text-right">{formatCents(p.total_cents)}</td>
                    <td className="py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void abrir(p.id)}>
                        Conciliar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
