/**
 * COMISSÕES › FECHAMENTOS — o histórico que nenhuma tela lia (GAP-PRD-174).
 *
 * O fechamento de comissão gravava histórico em `core_commission_closings`, e
 * a própria documentação da casa registrava: "o fechamento grava histórico que
 * nenhuma tela lê de volta". Do fechamento se chegava ao título a pagar; do
 * título não se chegava ao fechamento, e auditar "que fechamento gerou esta
 * conta" exigia SQL.
 *
 * Aqui estão os fechamentos, com o título que cada um gerou e o quanto falta
 * pagar dele, e o fechamento aberto mostra as vendas (e os estornos) que ele
 * levou. O título da comissão no contas a pagar agora é link para cá, com
 * `?fechamento=<id>` — e a tela escreve o mesmo parâmetro quando alguém abre
 * um fechamento pela lista, para o endereço descrever o que está na tela.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  fechamentosDeComissaoApi,
  type FechamentoDeComissao,
  type LinhaDoFechamento,
} from '@/lib/api/fechamentosDeComissao';
import { PARAM_DO_FECHAMENTO } from '@/lib/rotasDeOrigem';
import { dataBR } from '@/lib/datas';

const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';

const ESPECIE: Record<string, string> = {
  sale: 'Venda',
  sale_cancel: 'Estorno (venda cancelada)',
  sale_return: 'Estorno (devolução)',
  ajuste: 'Ajuste',
};

function situacaoDoTitulo(f: FechamentoDeComissao) {
  if (!f.financeEntryId) return <Badge tone="neutral">sem conta a pagar</Badge>;
  if (f.entryCancelled) return <Badge tone="warning">título cancelado</Badge>;
  if ((f.entryBalanceCents ?? 0) <= 0) return <Badge tone="success">pago</Badge>;
  return <Badge tone="info">a pagar {formatCents(f.entryBalanceCents ?? 0)}</Badge>;
}

export function FechamentosDeComissao() {
  const [params, setParams] = useSearchParams();
  const aberto = params.get(PARAM_DO_FECHAMENTO);
  const [itens, setItens] = useState<FechamentoDeComissao[] | null>(null);
  const [detalhe, setDetalhe] = useState<{
    closing: FechamentoDeComissao;
    lines: LinhaDoFechamento[];
  } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    fechamentosDeComissaoApi
      .listar()
      .then((r) => {
        if (vivo) setItens(r);
      })
      .catch((e) => {
        if (!vivo) return;
        setItens([]);
        setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar os fechamentos.');
      });
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    if (!aberto) {
      setDetalhe(null);
      return;
    }
    let vivo = true;
    setErro(null);
    fechamentosDeComissaoApi
      .abrir(aberto)
      .then((r) => {
        if (vivo) setDetalhe(r);
      })
      .catch((e) => {
        if (!vivo) return;
        setDetalhe(null);
        setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível abrir o fechamento.');
      });
    return () => {
      vivo = false;
    };
  }, [aberto]);

  const abrir = useCallback(
    (id: string | null) => {
      const proximos = new URLSearchParams(params);
      if (id) proximos.set(PARAM_DO_FECHAMENTO, id);
      else proximos.delete(PARAM_DO_FECHAMENTO);
      setParams(proximos);
    },
    [params, setParams],
  );

  return (
    <div className="flex flex-col gap-5">
      {erro && (
        <div role="alert" className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]">
          {erro}
        </div>
      )}

      {detalhe && (
        <Card
          title={`Fechamento — ${detalhe.closing.sellerName ?? 'pessoa removida'}`}
          subtitle={`Período de ${dataBR(detalhe.closing.periodFrom)} a ${dataBR(detalhe.closing.periodTo)} · fechado em ${dataBR(detalhe.closing.createdAt)}${
            detalhe.closing.closedByName ? ` por ${detalhe.closing.closedByName}` : ''
          }`}
          actions={
            <Button variant="ghost" size="sm" onClick={() => abrir(null)}>
              Fechar
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <strong className="text-[length:var(--gs-text-lg)]">{formatCents(detalhe.closing.totalCents)}</strong>
            {situacaoDoTitulo(detalhe.closing)}
            {detalhe.closing.financeEntryId && (
              <Link
                to="/sistema/financeiro/contas-a-pagar"
                className="text-[var(--gs-purple-700)] font-semibold underline text-[length:var(--gs-text-sm)]"
              >
                Ver no contas a pagar
              </Link>
            )}
          </div>
          {detalhe.lines.length === 0 ? (
            <EmptyState title="Sem linhas" description="Este fechamento não levou nenhuma linha de comissão." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]" aria-label="Linhas do fechamento">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Data</th>
                    <th className={TH}>O que é</th>
                    <th className={TH}>Venda</th>
                    <th className={`${TH} text-right`}>Base</th>
                    <th className={`${TH} text-right`}>Comissão</th>
                  </tr>
                </thead>
                <tbody>
                  {detalhe.lines.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--gs-border)] last:border-0">
                      <td className={TD}>{dataBR(l.competenceDate)}</td>
                      <td className={TD}>{ESPECIE[l.originType] ?? l.originType}</td>
                      <td className={TD}>{l.saleNumber !== null ? `#${l.saleNumber}` : '—'}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatCents(l.baseCents)}</td>
                      <td
                        className={`${TD} text-right tabular-nums font-semibold ${
                          l.amountCents < 0 ? 'text-[var(--gs-warning)]' : ''
                        }`}
                      >
                        {formatCents(l.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card
        title="Fechamentos"
        subtitle="Cada fechamento gerou uma conta a pagar. O título da comissão no contas a pagar leva de volta para cá."
      >
        {itens === null ? (
          <p className="text-[var(--gs-text-soft)]">Carregando…</p>
        ) : itens.length === 0 ? (
          <EmptyState
            title="Nenhum fechamento"
            description="Os fechamentos aparecem aqui depois do primeiro “Fechar e gerar a pagar” na apuração."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className={TH}>Vendedor</th>
                  <th className={TH}>Período</th>
                  <th className={`${TH} text-right`}>Total</th>
                  <th className={TH}>Título</th>
                  <th className={`${TH} text-right`} />
                </tr>
              </thead>
              <tbody>
                {itens.map((f) => (
                  <tr
                    key={f.id}
                    className={`border-b border-[var(--gs-border)] last:border-0 ${
                      f.id === aberto ? 'bg-[var(--gs-surface-hover)]' : ''
                    }`}
                  >
                    <td className={TD}>{f.sellerName ?? <Badge tone="warning">pessoa removida</Badge>}</td>
                    <td className={TD}>
                      {dataBR(f.periodFrom)} a {dataBR(f.periodTo)}
                    </td>
                    <td className={`${TD} text-right tabular-nums font-semibold`}>{formatCents(f.totalCents)}</td>
                    <td className={TD}>{situacaoDoTitulo(f)}</td>
                    <td className={`${TD} text-right`}>
                      <Button variant="ghost" size="sm" onClick={() => abrir(f.id)}>
                        Abrir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
