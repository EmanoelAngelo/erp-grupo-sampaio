/**
 * A FILA DOS PIX PENDENTES DO BALCÃO (GAP-PRD-077).
 *
 * A linha de PIX `pending` era um beco: nada a liquidava, nenhuma tela a
 * mostrava, e o caixa fechava sem ela. Aqui a gerência vê cada PIX que a venda
 * deixou pendente — do mais antigo para o mais novo — e resolve:
 *
 *   - PIX com cobrança no provedor: "Consultar o provedor". Quem diz se pagou
 *     é o provedor; pago, a venda é liquidada na hora. Ninguém "aprova no
 *     braço" um PIX que o provedor diz não ter recebido.
 *   - PIX declarado pendente sem provedor: "Confirmar recebimento", com a nota
 *     de como foi conferido — é ela que fica na baixa, com quem confirmou.
 *
 * O pagamento que cair sozinho (webhook ou consulta automática) some da fila
 * sem ninguém fazer nada.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState } from './ui';
import { formatCents } from './format';
import { ApiRequestError } from '@/lib/api/client';
import { pixBalcaoApi, type PixPendenteDoBalcao } from '@/lib/api/pixBalcao';

export function PixPendentesDoBalcaoCard() {
  const [itens, setItens] = useState<PixPendenteDoBalcao[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [anotando, setAnotando] = useState<string | null>(null);
  const [nota, setNota] = useState('');

  const carregar = useCallback(async () => {
    try {
      setItens(await pixBalcaoApi.pendentes());
    } catch (err) {
      setItens(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os PIX pendentes.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const resolver = useCallback(
    async (item: PixPendenteDoBalcao, comNota?: string) => {
      setOcupado(item.paymentId);
      setErro(null);
      setAviso(null);
      try {
        const r = await pixBalcaoApi.confirmarPendente(item.saleId, item.paymentId, comNota);
        setAviso(r.detail);
        setAnotando(null);
        setNota('');
        await carregar();
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao resolver o PIX pendente.');
      } finally {
        setOcupado(null);
      }
    },
    [carregar],
  );

  return (
    <Card
      title="PIX do balcão aguardando confirmação"
      subtitle="Vendas que fecharam com PIX pendente. O que o provedor confirmar sai daqui sozinho."
    >
      {erro && (
        <p role="alert" className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] m-0">
          {aviso}
        </p>
      )}
      {itens && itens.length === 0 && (
        <EmptyState title="Nenhum PIX pendente" description="Toda venda de balcão com PIX está liquidada." />
      )}
      {itens && itens.length > 0 && (
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {itens.map((i) => (
            <li
              key={i.paymentId}
              className="flex flex-col gap-2 py-2 border-b border-[var(--gs-border)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex flex-col">
                  <strong className="text-[var(--gs-purple-900)]">
                    Venda #{i.saleNumber} · {formatCents(i.amountCents)}
                  </strong>
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    {i.viaProvedor ? `PIX pelo provedor${i.providerRef ? ` · ${i.providerRef}` : ''}` : 'PIX declarado pendente, sem provedor'}
                    {' · '}
                    {i.ageDays === 0 ? 'hoje' : `há ${i.ageDays} dia(s)`}
                  </span>
                  {i.lastError && (
                    <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">{i.lastError}</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {i.ageDays > 0 && <Badge tone="warning">vencido</Badge>}
                  {i.viaProvedor ? (
                    <Button size="sm" variant="ghost" loading={ocupado === i.paymentId} onClick={() => void resolver(i)}>
                      Consultar o provedor
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setAnotando(i.paymentId)}>
                      Confirmar recebimento
                    </Button>
                  )}
                </span>
              </div>
              {anotando === i.paymentId && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 flex-1 min-w-60">
                    <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      Como o recebimento foi conferido (vai para a baixa)
                    </span>
                    <input
                      aria-label="Como o recebimento foi conferido"
                      value={nota}
                      maxLength={180}
                      onChange={(e) => setNota(e.target.value)}
                      className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
                    />
                  </label>
                  <Button size="sm" loading={ocupado === i.paymentId} onClick={() => void resolver(i, nota)}>
                    Confirmar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAnotando(null)}>
                    Voltar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
