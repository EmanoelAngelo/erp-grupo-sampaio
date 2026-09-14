/**
 * ============================================================================
 * O QUE ESTE DOCUMENTO GEROU NO FINANCEIRO — a VOLTA da rastreabilidade
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * A ida existia: o título do contas a pagar diz de onde veio e navega até lá.
 * A VOLTA foi construída no servidor na mesma rodada — `GET
 * /finance/entries?originType=&originId=` devolve exatamente os lançamentos de
 * um documento, com teste próprio — e NENHUMA tela a chamava.
 *
 * O efeito na loja: quem abria a nota de entrada não via a dívida que ela
 * criou, e quem abria o pedido de compra não via dinheiro nenhum. Para
 * responder "essa nota já foi paga?" a pessoa saía da ficha, ia ao contas a
 * pagar e procurava pelo número — que é exatamente o gesto que a
 * rastreabilidade existe para apagar.
 *
 * Consulta pronta, testada e sem leitor é a dívida que este projeto já pagou
 * várias vezes (a categoria que não chegava ao serviço, o centro de custo
 * escrito e nunca lido, o rastro de item cancelado sem tela).
 *
 * ## O QUE ELE MOSTRA, E O QUE NÃO INVENTA
 *
 * Valor, vencimento e situação — o suficiente para saber se aquilo ainda
 * cobra alguém. Nada é somado aqui: o total é a soma das linhas que vieram, e
 * a lista é curta por natureza (um documento gera um punhado de parcelas).
 *
 * **Lista vazia e falha de rede são estados DIFERENTES.** "Este documento não
 * gerou título" é uma resposta legítima e frequente (nota de bonificação, nota
 * ainda em conferência); "não consegui perguntar" é outra coisa, e mostrá-las
 * com a mesma cara ensinaria a ler ausência de dívida onde houve ausência de
 * resposta.
 */
import { Badge, Card, DataTable, EmptyState } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { dataBR } from '@/lib/datas';
import type { FinanceEntry } from '@/lib/api/core';

/** O estado do bloco, com a distinção que importa. */
export interface TitulosDoDocumentoEstado {
  /** Nulo enquanto a resposta não chegou. */
  titulos: FinanceEntry[] | null;
  /** Preenchido quando a consulta FALHOU — que não é o mesmo que vazia. */
  erro: string | null;
}

export function TitulosDoDocumento({
  titulos,
  erro,
  titulo = 'O que este documento gerou no financeiro',
  subtitulo,
}: TitulosDoDocumentoEstado & { titulo?: string; subtitulo?: string }) {
  const total = (titulos ?? []).reduce((soma, t) => soma + t.amountCents, 0);
  const emAberto = (titulos ?? []).reduce((soma, t) => soma + t.balanceCents, 0);

  return (
    <Card title={titulo} subtitle={subtitulo} className="mb-5">
      {erro ? (
        /*
          A FALHA SE DECLARA. Sem esta linha, um 403 ou uma piscada de rede
          apareceria como "nenhum título" — e quem lesse concluiria que o
          documento não cobra ninguém.
        */
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      ) : titulos === null ? (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
      ) : titulos.length === 0 ? (
        <EmptyState
          title="Nenhum título"
          description="Este documento não gerou lançamento no financeiro — o que é o esperado enquanto ele não for confirmado, e também para documento de valor zero."
        />
      ) : (
        <>
          <DataTable
            columns={[
              { header: 'Descrição', render: (t: FinanceEntry) => t.description },
              {
                header: 'Parcela',
                render: (t: FinanceEntry) =>
                  t.installmentTotal > 1 ? `${t.installmentNumber}/${t.installmentTotal}` : '—',
              },
              { header: 'Vencimento', render: (t: FinanceEntry) => dataBR(t.dueDate) },
              {
                header: 'Situação',
                render: (t: FinanceEntry) =>
                  t.cancelledAt ? (
                    <Badge tone="neutral">Cancelado</Badge>
                  ) : t.balanceCents <= 0 ? (
                    <Badge tone="success">Pago</Badge>
                  ) : t.overdue ? (
                    <Badge tone="danger">Vencido</Badge>
                  ) : (
                    <Badge tone="info">Em aberto</Badge>
                  ),
              },
              {
                header: 'Valor',
                align: 'right',
                render: (t: FinanceEntry) => formatCents(t.amountCents),
              },
              {
                header: 'Falta',
                align: 'right',
                render: (t: FinanceEntry) => formatCents(t.balanceCents),
              },
            ]}
            rows={titulos}
            keyOf={(t) => t.id}
          />
          <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)]">
            Total: <strong>{formatCents(total)}</strong> · ainda em aberto:{' '}
            <strong>{formatCents(emAberto)}</strong>
          </p>
        </>
      )}
    </Card>
  );
}
