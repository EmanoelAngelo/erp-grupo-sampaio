/**
 * Relatórios › BI.
 *
 * O painel mostra o dia a dia de UMA operação. Esta tela responde a pergunta
 * que nenhuma outra respondia: como as operações do grupo se comparam.
 *
 * DUAS HONESTIDADES QUE A TELA PRECISA MANTER:
 *
 *   MARGEM SÓ ONDE O CUSTO EXISTE. Produto cadastrado sem custo devolveria 100%
 *   de margem — bonito e falso. Esses itens ficam de fora, e a tela DIZ quantos
 *   ficaram: 40% calculado sobre 3 de 300 itens não é a margem da loja, e quem
 *   decide preço em cima disso perde dinheiro.
 *
 *   FATURAMENTO NÃO É O QUE FICOU. A devolução aparece ao lado, e o líquido
 *   também — misturar os dois esconderia justamente a operação que vende muito
 *   e recebe tudo de volta.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type BrandSummary,
  type InsightProduct,
  type MarginSummary,
  type OperationSummary,
  type OperationTotals,
} from '@/lib/api/core';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function BiPage() {
  const [operacoes, setOperacoes] = useState<OperationSummary[] | null>(null);
  const [totais, setTotais] = useState<OperationTotals | null>(null);
  const [produtos, setProdutos] = useState<InsightProduct[]>([]);
  const [marcas, setMarcas] = useState<BrandSummary[]>([]);
  const [margem, setMargem] = useState<MarginSummary | null>(null);
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      /*
        A DATA VAI PURA. Montar o instante aqui usava o relógio do NAVEGADOR —
        e o painel do grupo compara as seis operações: bastava o contador abrir
        de outra máquina para os números mudarem sem nada ter mudado.
      */
      const inicio = de || undefined;
      const fim = ate || undefined;
      const res = await coreApi.insightsOperations(inicio, fim);
      setOperacoes(res.operations);
      setTotais(res.totals);
      setProdutos(await coreApi.insightsProducts(inicio, fim));
      setMarcas(await coreApi.insightsBrands(inicio, fim));
      setMargem(await coreApi.insightsMargin(inicio, fim));
    } catch (err) {
      setOperacoes(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os números.');
    }
  }, [de, ate]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Relatórios', 'BI']}
        title="Comparativo das operações"
        subtitle="As operações a que você tem acesso, lado a lado — faturamento, o que voltou e o que de fato ficou."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}

      <Card title="Período">
        <div className="flex flex-wrap gap-4">
          <Field label="De">
            {(p) => <Input {...p} type="date" value={de} onChange={(e) => setDe(e.target.value)} />}
          </Field>
          <Field label="Até">
            {(p) => (
              <Input {...p} type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
            )}
          </Field>
        </div>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Sem período, considera tudo. Venda cancelada não entra em nenhum número.
        </p>
        {/* O que entra no faturamento, dito na tela (GAP-PRD-132). */}
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mb-0">
          O faturamento junta balcão, oficina e os pedidos da loja online pagos no período (pelo
          dia do pagamento, como no DRE); a coluna “Loja online” mostra a parte deles, e as
          devoluções incluem os reembolsos da loja. Produtos, marcas e margem abaixo contam só
          balcão e oficina — os itens da loja online estão em Relatórios › Produtos vendidos.
        </p>
      </Card>

      <Card title="Por operação">
        {operacoes === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : operacoes.length === 0 ? (
          <EmptyState
            title="Nenhuma operação"
            description="Você não está vinculado a nenhuma operação ativa."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Operação</th>
                  <th className="py-2 text-right">Vendas</th>
                  <th className="py-2 text-right">Faturamento</th>
                  <th className="py-2 text-right">Loja online</th>
                  <th className="py-2 text-right">Ticket médio</th>
                  <th className="py-2 text-right">Devoluções</th>
                  <th className="py-2 text-right">Ficou</th>
                </tr>
              </thead>
              <tbody>
                {operacoes.map((o) => (
                  <tr key={o.companyId} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{o.tradeName}</td>
                    <td className="py-2 text-right">{o.salesCount}</td>
                    <td className="py-2 text-right">{formatCents(o.revenueCents)}</td>
                    <td className="py-2 text-right" data-testid="bi-loja-online">
                      {(o.onlineRevenueCents ?? 0) > 0
                        ? `${formatCents(o.onlineRevenueCents ?? 0)} (${o.onlineOrdersCount ?? 0})`
                        : '—'}
                    </td>
                    <td className="py-2 text-right">{formatCents(o.averageTicketCents)}</td>
                    <td
                      className={`py-2 text-right ${
                        o.returnsCents > 0 ? 'text-[var(--gs-warning)]' : ''
                      }`}
                    >
                      {o.returnsCents > 0 ? `- ${formatCents(o.returnsCents)}` : '—'}
                    </td>
                    <td className="py-2 text-right font-semibold">{formatCents(o.netCents)}</td>
                  </tr>
                ))}
                {totais && operacoes.length > 1 && (
                  <tr className="border-t-2 border-[var(--gs-border-strong)] font-bold">
                    <td className="py-2">Grupo</td>
                    <td className="py-2 text-right">{totais.salesCount}</td>
                    <td className="py-2 text-right">{formatCents(totais.revenueCents)}</td>
                    <td className="py-2 text-right">{formatCents(totais.onlineRevenueCents ?? 0)}</td>
                    <td className="py-2 text-right">{formatCents(totais.averageTicketCents)}</td>
                    <td className="py-2 text-right">{formatCents(totais.returnsCents)}</td>
                    <td className="py-2 text-right">{formatCents(totais.netCents)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {margem && (
        /*
          O CUSTO É O DO DIA DA VENDA (GAP-PRD-086) — o mesmo do CMV do DRE.
          O cartão multiplicava a quantidade pelo custo de HOJE do cadastro, e a
          margem de março mudava quando entrava a nota de agosto: 40% aqui e
          60% no DRE sobre as mesmas vendas.
        */
        <Card
          title="Margem"
          subtitle="Com o custo gravado no dia de cada venda — a mesma régua do CMV no resultado do período."
        >
          {margem.marginPercent === null ? (
            <p className="m-0">
              {/*
                Nulo é "não dá para saber", e é diferente de margem zero. Mostrar
                0% aqui faria alguém concluir que a loja vende sem lucro.
              */}
              <strong>Não há como calcular a margem</strong> deste período: nenhum item vendido tem
              custo gravado.
              {margem.skippedNoCost > 0 && (
                <> {margem.skippedNoCost} item(ns) foram vendidos sem custo cadastrado.</>
              )}
              {(margem.skippedBeforeSnapshot ?? 0) > 0 && (
                <>
                  {' '}
                  {margem.skippedBeforeSnapshot} item(ns) são de antes de o sistema gravar custo na
                  venda, ou são serviço.
                </>
              )}
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <div>
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    Receita considerada
                  </p>
                  <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                    {formatCents(margem.revenueCents)}
                  </p>
                </div>
                <div>
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Custo</p>
                  <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                    {formatCents(margem.costCents)}
                  </p>
                </div>
                <div>
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Margem</p>
                  <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                    {formatCents(margem.marginCents)}
                  </p>
                </div>
                <div>
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Percentual</p>
                  <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{margem.marginPercent}%</p>
                </div>
              </div>
              {margem.skippedNoCost > 0 && (
                <p className="text-[var(--gs-warning)] text-[length:var(--gs-text-sm)] font-semibold">
                  Atenção: {margem.skippedNoCost} item(ns) vendidos ficaram FORA deste cálculo por
                  não ter custo cadastrado. A margem acima vale sobre{' '}
                  {margem.consideredItems} item(ns), não sobre tudo o que foi vendido.
                </p>
              )}
              {(margem.skippedBeforeSnapshot ?? 0) > 0 && (
                <p className="text-[var(--gs-warning)] text-[length:var(--gs-text-sm)] font-semibold">
                  {margem.skippedBeforeSnapshot} item(ns) ficaram fora por não ter custo gravado na
                  venda (vendas anteriores ao registro do custo, ou serviços). O custo de hoje do
                  cadastro não é usado no lugar: seria um custo que ninguém pagou naquele dia.
                </p>
              )}
            </>
          )}
        </Card>
      )}

      <Card title="O que mais saiu">
        {produtos.length === 0 ? (
          <EmptyState
            title="Nenhuma venda no período"
            description="Ajuste o período ou registre vendas para comparar."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Produto</th>
                  <th className="py-2 text-right">Quantidade</th>
                  <th className="py-2 text-right">Faturamento</th>
                  <th className="py-2 text-right">Operações</th>
                </tr>
              </thead>
              <tbody>
                {produtos.map((p, i) => (
                  <tr key={`${p.name}-${i}`} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right">{p.quantity}</td>
                    <td className="py-2 text-right">{formatCents(p.revenue_cents)}</td>
                    <td className="py-2 text-right">{p.operations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Ordenado por faturamento. O que mais sai em peça nem sempre é o que traz mais dinheiro —
          por isso as duas colunas.
        </p>
      </Card>

      {/*
        POR MARCA — GAP-V44.

        O recorte que o gerente pedia e nenhuma superfície respondia. É o mesmo
        agrupamento do painel (o SQL mora num lugar só, em `GroupInsights`),
        aqui somando as operações do VÍNCULO em vez de uma empresa.
      */}
      <Card title="Por marca">
        {marcas.length === 0 ? (
          <EmptyState
            title="Nenhuma venda no período"
            description="Quando houver venda, cada marca aparece aqui."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Marca</th>
                  <th className="py-2 text-right">Quantidade</th>
                  <th className="py-2 text-right">Vendas</th>
                  <th className="py-2 text-right">Faturamento</th>
                </tr>
              </thead>
              <tbody>
                {marcas.map((m) => (
                  <tr key={m.brand} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{m.brand}</td>
                    <td className="py-2 text-right">{m.quantity}</td>
                    <td className="py-2 text-right">{m.sales_count}</td>
                    <td className="py-2 text-right">{formatCents(m.revenue_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          &ldquo;Sem marca&rdquo; é um GRUPO, e não um filtro: produto sem marca cadastrada, campo em
          branco e linha de serviço caem nele. Sem isso o relatório nasceria vazio — e a soma das
          marcas deixaria de bater com o faturamento.
        </p>
      </Card>
    </AppShell>
  );
}
