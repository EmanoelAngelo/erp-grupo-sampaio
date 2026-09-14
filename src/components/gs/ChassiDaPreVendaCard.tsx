/**
 * O CHASSI QUE A PRÉ-VENDA SEGURA — GAP-PRD-111.
 *
 * ## O defeito
 *
 * A reserva da pré-venda era por quantidade: "uma Honda CG 160 está
 * prometida". A concessionária promete AQUELA moto — a vermelha, o chassi que o
 * cliente do sinal viu no pátio —, e nada no sistema dizia isso: o pedido
 * online capturado levava a mais antiga, o caixa ao lado bipava a mesma.
 *
 * ## O gesto
 *
 * No detalhe da pré-venda aberta, cada item de moto (produto controlado por
 * unidade) mostra o chassi segurado e "Escolher chassi": a lista das motos do
 * pátio, com as seguradas por OUTRA pré-venda travadas e dizendo de quem são.
 * Escolher não é obrigatório — sem escolha, o faturamento leva a mais antiga
 * livre, como sempre.
 */
import { useState } from 'react';
import { Badge, Button } from './ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type ProductUnit, type QuoteDetail } from '@/lib/api/core';
import { motoDaPreVendaApi } from '@/lib/api/motoDaPreVenda';

function identidade(u: ProductUnit): string {
  return u.chassis ?? u.imei ?? u.serial_number ?? u.motor_number ?? u.plate ?? 'sem identidade';
}

export function ChassiDaPreVendaCard({
  detail,
  onAlterado,
}: {
  detail: QuoteDetail;
  onAlterado: () => void;
}) {
  const [escolhendo, setEscolhendo] = useState<string | null>(null);
  const [opcoes, setOpcoes] = useState<ProductUnit[] | null>(null);
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Um grupo por produto: duas linhas da mesma moto somam no mesmo chassi.
  const grupos = new Map<string, { descricao: string; quantidade: number }>();
  for (const item of detail.items) {
    if (item.serialized !== 1 || !item.product_id) continue;
    const g = grupos.get(item.product_id);
    grupos.set(item.product_id, {
      descricao: g?.descricao ?? item.description,
      quantidade: (g?.quantidade ?? 0) + Number(item.quantity),
    });
  }

  if (detail.kind !== 'pre_venda' || detail.status !== 'aberto' || detail.expired || grupos.size === 0) {
    return null;
  }

  const reservas = detail.unidadesReservadas ?? [];

  const abrir = async (productId: string) => {
    setErro(null);
    setEscolhendo(productId);
    setOpcoes(null);
    setMarcadas(reservas.filter((r) => r.productId === productId).map((r) => r.unitId));
    try {
      setOpcoes(await coreApi.listUnits(productId, 'in_stock'));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível listar as motos do pátio.');
      setOpcoes([]);
    }
  };

  const alternar = (id: string, limite: number) =>
    setMarcadas((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Troca a mais antiga marcada quando o limite já foi atingido: com uma
      // moto só no documento, clicar noutra é trocar de moto.
      return prev.length >= limite ? [...prev.slice(1), id] : [...prev, id];
    });

  const salvar = async (productId: string, unitIds: string[]) => {
    setSalvando(true);
    setErro(null);
    try {
      await motoDaPreVendaApi.segurar(detail.id, productId, unitIds);
      setEscolhendo(null);
      onAlterado();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível reservar o chassi.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <section
      aria-label="Chassi reservado"
      className="px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] flex flex-col gap-3"
    >
      <div>
        <h3 className="m-0 font-bold text-[var(--gs-purple-900)]">Chassi reservado para o cliente</h3>
        <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Sem chassi escolhido, o faturamento leva a moto livre mais antiga do pátio. Escolhido,
          AQUELA moto sai do PDV, da loja online e das outras pré-vendas até este documento ser
          faturado, cancelado ou vencer.
        </p>
      </div>

      {[...grupos].map(([productId, g]) => {
        const doProduto = reservas.filter((r) => r.productId === productId);
        return (
          <div key={productId} className="flex flex-col gap-2">
            <p className="m-0">
              <strong>{g.descricao}</strong>
              {' — '}
              {doProduto.length > 0 ? (
                <span className="font-mono">{doProduto.map((r) => r.rotulo).join(', ')}</span>
              ) : (
                <span className="text-[var(--gs-text-soft)]">nenhum chassi segurado</span>
              )}
            </p>

            {escolhendo === productId ? (
              <div className="flex flex-col gap-2">
                {opcoes === null ? (
                  <p className="m-0 text-[length:var(--gs-text-sm)]">Carregando as motos do pátio…</p>
                ) : opcoes.length === 0 ? (
                  <p className="m-0 text-[length:var(--gs-text-sm)]">Nenhuma moto deste produto no pátio.</p>
                ) : (
                  <ul className="list-none m-0 p-0 flex flex-col gap-1">
                    {opcoes.map((u) => {
                      const deOutro = u.reserva && u.reserva.quoteId !== detail.id ? u.reserva : null;
                      return (
                        <li key={u.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            aria-label={`Segurar ${identidade(u)}`}
                            checked={marcadas.includes(u.id)}
                            disabled={Boolean(deOutro)}
                            onChange={() => alternar(u.id, g.quantidade)}
                          />
                          <span className="font-mono">{identidade(u)}</span>
                          {deOutro && (
                            <Badge tone="warning">
                              {`reservada p/ pré-venda #${deOutro.quoteNumber}`}
                              {deOutro.customerName ? ` de ${deOutro.customerName}` : ''}
                            </Badge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={salvando}
                    disabled={opcoes === null}
                    onClick={() => void salvar(productId, marcadas)}
                  >
                    Segurar chassi
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEscolhendo(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void abrir(productId)}>
                  Escolher chassi
                </Button>
                {doProduto.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={salvando}
                    onClick={() => void salvar(productId, [])}
                  >
                    Soltar chassi
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {erro && (
        <p role="alert" className="m-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
    </section>
  );
}
