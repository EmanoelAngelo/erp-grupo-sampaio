/**
 * Painel do gestor — /sistema/painel
 *
 * Só exibe métrica que o backend consegue calcular a partir de venda
 * registrada. Nada de KPI fixo no código: quando não há dado no período, a
 * área mostra estado vazio em vez de zero inventado.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Card, ChartEmpty, DataTable, EmptyState, Kpi } from '@/components/gs/ui';
import { AvisoDeVencimento } from '@/components/gs/CertificadoValidado';
import { AvisoCaixasEsquecidos } from '@/components/gs/GavetasAbertas';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { coreApi, type DashboardData } from '@/lib/api/core';
import { diasAtras, hojeNaLoja } from '@/lib/datas';

/**
 * "37 produtos abaixo do mínimo (mostrando 10)" — ou nada, quando cabe tudo.
 *
 * Sem `total` (servidor anterior) não há o que dizer além da tabela: inventar
 * "mostrando 10 de 10" seria afirmar que não há outros.
 */
function subtituloDoEstoqueBaixo(mostrados: number, total: number | undefined): string | undefined {
  if (total === undefined || total <= mostrados) return undefined;
  return `${total.toLocaleString('pt-BR')} produtos abaixo do mínimo (mostrando ${mostrados}).`;
}

/** Barras simples em SVG — sem dependência de biblioteca de gráfico. */
function SalesByDayChart({ data }: { data: DashboardData['byDay'] }) {
  const max = Math.max(...data.map((d) => d.revenue_cents), 1);
  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-2 h-56 min-w-[420px] px-1">
        {data.map((point) => {
          const heightPct = Math.max((point.revenue_cents / max) * 100, 2);
          return (
            <div key={point.day} className="flex-1 flex flex-col items-center gap-2 min-w-[36px]">
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] tabular-nums">
                {formatCents(point.revenue_cents)}
              </span>
              <div
                className="w-full rounded-t-[var(--gs-radius-sm)] bg-[var(--gs-purple-700)]"
                style={{ height: `${heightPct}%` }}
                role="img"
                aria-label={`${point.day}: ${formatCents(point.revenue_cents)} em ${point.sales_count} vendas`}
              />
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] whitespace-nowrap">
                {point.day.slice(8, 10)}/{point.day.slice(5, 7)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PainelPage() {
  const session = useSession();
  // O link do relatório só para quem a Central abre — o mesmo recorte do menu.
  const abreACentral = useHasProfile('gerente_loja', 'gerente_oficina');
  const [from, setFrom] = useState(diasAtras(30));
  const [to, setTo] = useState(hojeNaLoja());
  /*
    A OPERAÇÃO QUE O PAINEL ESTÁ OLHANDO — GAP-V46.

    Comparar o dia de duas lojas custava uma troca no seletor "Operação ativa"
    da topbar MAIS um `window.location.reload()` inteiro por empresa. O reload
    existe por um motivo legítimo (garantir que TODAS as telas releiam o
    escopo), e ele CONTINUA valendo para a troca de sessão — o que muda aqui é
    que olhar o painel de outra operação deixou de exigir trocar de sessão.

    Vazio = a empresa do token. Nada muda para quem tem uma loja só, e o
    seletor nem aparece.
  */
  const [operacao, setOperacao] = useState('');
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /*
        A DATA VAI PURA, e isso mudou nesta rodada.

        Aqui se mandava `${to}T23:59:59.999Z` para contornar um defeito do
        servidor: ele comparava `created_at <= ?` com `created_at` sendo
        timestamp e o limite chegando como data, e
        `'2026-08-31T14:00:00Z' <= '2026-08-31'` é FALSO — o último dia do
        período sumia do faturamento, em silêncio. O contorno funcionava e
        escondia a causa.

        O servidor passou a comparar a data pura, e o recorte ficou inclusivo de
        verdade. Mandar a data como ela é importa porque o DRE usa exatamente
        este mesmo recorte para calcular a diferença entre os dois números —
        duas grafias do mesmo dia seriam duas contas ligeiramente diferentes
        sobre o mesmo período.

        E a data pura é a do RELÓGIO DA LOJA: o servidor converte a coluna antes
        de comparar, então a venda das 21h30 fica no dia em que o operador a
        fez. Ver `CalendarioOperacional` no servidor e `lib/datas` aqui.
      */
      setData(await coreApi.dashboard(from, to, operacao || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar o painel.');
    } finally {
      setLoading(false);
    }
  }, [from, to, operacao]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasSales = (data?.salesCount ?? 0) > 0;
  /*
    OS NÚMEROS DE DINHEIRO SÃO DA GERÊNCIA NESTA EMPRESA (GAP-PRD-165).

    O servidor já não os manda — `dinheiroOculto` diz por quê. A tela mostra o
    que continua sendo trabalho de quem abriu o painel (quantas vendas, o que
    saiu, o que está abaixo do mínimo) e diz, no lugar do faturamento, onde a
    decisão mora. Um "R$ 0,00" aqui leria como dia sem venda.
  */
  const dinheiroOculto = Boolean(data?.dinheiroOculto);

  const emptyChart = useMemo(
    () => (
      <ChartEmpty
        title="Gráfico sem dados"
        description="Faça vendas ou altere o filtro de datas para gerar informações."
      />
    ),
    [],
  );

  return (
    <AppShell>
      {/* Cabeçalho no padrão da referência: título simples e os filtros De/Até
          logo abaixo, em linha, antes de qualquer número. */}
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold text-[var(--gs-text)] m-0">Dashboard</h1>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-4">
          {session ? session.company.tradeName : ''}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          {/*
            O SELETOR DE OPERAÇÃO — GAP-V46, e ele só aparece para quem tem
            mais de uma.

            A lista vem do MESMO payload do painel: `GET /core/companies` é
            rota de DONO, e o gerente com duas lojas não conseguiria montar o
            próprio seletor com ela. E a troca aqui NÃO recarrega a página —
            trocar de operação para olhar não é trocar de sessão para operar; a
            sessão continua sendo a da empresa em que a pessoa está trabalhando.

            O escopo é conferido no servidor pelo VÍNCULO: pedir uma empresa
            fora dele recebe 403, não os números dela.
          */}
          {(data?.companies?.length ?? 0) > 1 && (
            <label className="flex items-center gap-2">
              <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
                Operação:
              </span>
              <select
                value={operacao || (data?.companyId ?? '')}
                onChange={(e) => setOperacao(e.target.value)}
                className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
              >
                {data?.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.tradeName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
              De:
            </span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
              Até:
            </span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
            />
          </label>
          {loading && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Atualizando…</span>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      {/*
        O AVISO DO CERTIFICADO CHEGA A QUEM NÃO FOI PROCURÁ-LO — GAP-V40.

        A frase de renovação existia desde sempre e só aparecia em Fiscal ›
        Certificado, da operação certa. Com seis empresas isso é não avisar
        ninguém: o A1 vence, a emissão para, e a descoberta acontece no balcão
        com o cliente esperando o cupom.

        Este é o painel que o gestor abre todo dia. O aviso vem calculado do
        servidor, só a partir de 90 dias do fim, e some sozinho quando há
        folga — banner permanente deixa de ser lido, e aí o de sete dias também
        passa despercebido. Nada do titular nem do CNPJ viaja até aqui: o
        cartão do certificado continua atrás do perfil de dono.
      */}
      {data?.certificateAlert && (
        <div className="mb-5">
          <AvisoDeVencimento alerta={data.certificateAlert} />
        </div>
      )}

      {/* A gaveta esquecida aberta desde outro dia (GAP-PRD-131): some sozinho sem ela. */}
      <AvisoCaixasEsquecidos />

      {/* Os gráficos vêm primeiro, como na referência: quem abre o painel
          quer ver a curva do período, não uma fileira de números. Os
          indicadores ficam logo abaixo, como apoio. */}
      {dinheiroOculto && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)] text-[length:var(--gs-text-sm)]"
        >
          Faturamento, ticket médio e contas a receber são reservados à gerência pela política
          desta empresa (Configurações › Política de gestão). Aqui continuam as vendas, os
          produtos que saíram e os alertas de estoque.
        </div>
      )}

      <div className="grid gap-5 grid-cols-1 xl:grid-cols-2 mb-5">
        {!dinheiroOculto && (
          <Card title="Vendas por dia" collapsible>
            {hasSales && data?.byDay ? <SalesByDayChart data={data.byDay} /> : emptyChart}
          </Card>
        )}

        <Card title="Vendas por vendedor" padded={false} collapsible>
          <DataTable
            columns={[
              { header: 'Vendedor', render: (r) => r.seller_name },
              { header: 'Vendas', align: 'right', render: (r) => String(r.sales_count) },
              ...(dinheiroOculto
                ? []
                : [
                    {
                      header: 'Valor',
                      align: 'right' as const,
                      render: (r: DashboardData['bySeller'][number]) => formatCents(r.revenue_cents),
                    },
                  ]),
            ]}
            rows={data?.bySeller ?? []}
            keyOf={(r) => r.seller_id}
            empty={emptyChart}
          />
        </Card>
      </div>

      <div className="grid gap-5 mb-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        {!dinheiroOculto && (
          <Kpi
            label="Faturamento"
            value={formatCents(data?.revenueCents ?? 0)}
            hint="Só venda concluída, pela data da venda"
          />
        )}
        <Kpi label="Vendas" value={String(data?.salesCount ?? 0)} />
        {!dinheiroOculto && (
          <Kpi label="Ticket médio" value={formatCents(data?.averageTicketCents ?? 0)} />
        )}
        {!dinheiroOculto && (
          <Kpi
            label="A receber em aberto"
            value={formatCents(data?.openReceivablesCents ?? 0)}
            tone={(data?.openReceivablesCents ?? 0) > 0 ? 'warning' : 'neutral'}
          />
        )}
      </div>

      {/*
        O LINK PARA O DRE NÃO PODE SER MUDO.

        As duas telas mostram faturamentos diferentes do mesmo mês, e sempre
        mostrarão: este painel soma VENDAS de balcão pela data da venda; o DRE
        soma LANÇAMENTOS de entrada pela competência, e enxerga pedido online,
        receita de serviço e lançamento manual, que não são venda de balcão.

        Um link seco entre dois números que discordam produz a conclusão
        errada — "o sistema está com defeito" — e depois a escolha do número
        preferido. Por isso o motivo vem ANTES do link, e é no DRE que a
        diferença aparece decomposta em parcelas com nome e valor.
      */}
      <p
        className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mb-5"
        // Sem faturamento na tela, a frase que explica o faturamento sobra.
        hidden={dinheiroOculto}
      >
        Este faturamento conta apenas venda de balcão concluída, pela data da venda. O{' '}
        <Link
          to="/sistema/financeiro/dre"
          className="text-[var(--gs-purple-700)] font-semibold underline"
        >
          resultado do período (DRE)
        </Link>{' '}
        mostra um número maior porque conta também pedido online, serviço e lançamento
        manual de receita, e usa a competência no lugar da data da venda — lá a diferença
        aparece parcela por parcela.
      </p>
      {/* A loja online, dita ao lado com o próprio número (GAP-PRD-132): ela
          entra em Relatórios › Vendas do período e no DRE pelo dia do
          pagamento, e não some deste painel. */}
      {typeof data?.onlineRevenueCents === 'number' && (
        <p
          data-testid="painel-loja-online"
          className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] -mt-3 mb-5"
        >
          Loja online no período: {formatCents(data.onlineRevenueCents)} em{' '}
          {data.onlineOrdersCount ?? 0} pedido(s) pago(s), pelo dia do pagamento — fora do
          faturamento acima e dentro de Relatórios › Vendas do período e do DRE.
        </p>
      )}

      <div className="grid gap-5 grid-cols-1 xl:grid-cols-2">
        <Card title="Produtos vendidos" padded={false} collapsible>
          <DataTable
            columns={[
              { header: 'Produto', render: (r) => r.description },
              { header: 'Qtd.', align: 'right', render: (r) => formatQuantity(r.quantity) },
              ...(dinheiroOculto
                ? []
                : [
                    {
                      header: 'Valor',
                      align: 'right' as const,
                      render: (r: DashboardData['topProducts'][number]) => formatCents(r.revenue_cents),
                    },
                  ]),
            ]}
            rows={data?.topProducts ?? []}
            keyOf={(r) => r.product_id}
            empty={emptyChart}
          />
        </Card>

        {/*
          OS DEZ, E QUANTOS FICARAM DE FORA (GAP-PRD-164). O cartão mostra
          dez; com 37 produtos abaixo do mínimo, os outros 27 não existiam
          para quem olhava o painel. A frase diz o total e o link leva ao
          relatório que lista todos, com o quanto falta de cada um.
        */}
        <Card
          title="Alertas de estoque"
          padded={false}
          collapsible
          /*
            `lowStock?.length`, e não `lowStock.length`: com um corpo sem a
            chave (o contrato quebrado do deploy, `toda-tela-monta`), o painel
            inteiro estourava aqui em vez de mostrar a lista vazia.
          */
          subtitle={subtituloDoEstoqueBaixo(data?.lowStock?.length ?? 0, data?.lowStockTotal)}
          actions={
            abreACentral && (data?.lowStockTotal ?? 0) > (data?.lowStock?.length ?? 0) ? (
              <Link
                to="/sistema/relatorios/central?relatorio=minimo"
                className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)] font-semibold underline"
              >
                Ver todos no relatório
              </Link>
            ) : undefined
          }
        >
          <DataTable
            columns={[
              { header: 'Produto', render: (r) => r.name },
              { header: 'Saldo', align: 'right', render: (r) => formatQuantity(r.quantity) },
              { header: 'Mínimo', align: 'right', render: (r) => formatQuantity(r.min_stock) },
            ]}
            rows={data?.lowStock ?? []}
            keyOf={(r) => r.product_id}
            empty={
              <EmptyState
                title="Nenhum alerta"
                description="Nenhum produto está abaixo do estoque mínimo."
              />
            }
          />
        </Card>
      </div>

      {/*
        VENDAS POR MARCA — GAP-V44.

        "Qual marca vende mais" não tinha resposta em superfície nenhuma: os
        insights agregavam por produto, por operação e por margem, e nunca por
        marca. O ingrediente sempre esteve em `core_products.brand`.

        A barra é desenhada contra a MAIOR do recorte, e não contra o
        faturamento total: com uma marca dominante, todas as outras virariam
        traços de um pixel e o gráfico deixaria de comparar o que existe.
      */}
      {!dinheiroOculto && (
      <div className="mt-5">
        <Card
          title="Vendas por marca"
          collapsible
          subtitle={
            (data?.byBrandUnallocatedCents ?? 0) !== 0
              ? `${formatCents(data!.byBrandUnallocatedCents)} de desconto ou acréscimo de rodapé não `
                + 'pertencem a marca nenhuma — o valor fica fora das barras em vez de ser rateado por '
                + 'um critério que ninguém escolheu.'
              : undefined
          }
        >
          {(data?.byBrand?.length ?? 0) === 0 ? (
            <EmptyState
              title="Nenhuma venda no período"
              description="Quando houver venda, cada marca aparece aqui. Produto sem marca cadastrada entra como “Sem marca”."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {data!.byBrand.map((linha) => {
                const maior = Math.max(...data!.byBrand.map((l) => l.revenue_cents), 1);
                const largura = Math.max((linha.revenue_cents / maior) * 100, 2);
                return (
                  <div key={linha.brand} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 truncate text-[length:var(--gs-text-sm)]">
                      {linha.brand}
                    </span>
                    <div className="flex-1 h-5 bg-[var(--gs-surface-soft)] rounded-[var(--gs-radius-sm)] overflow-hidden">
                      <div
                        className="h-full bg-[var(--gs-purple-700)]"
                        style={{ width: `${largura}%` }}
                        role="img"
                        aria-label={`${linha.brand}: ${formatCents(linha.revenue_cents)} em ${formatQuantity(linha.quantity)} unidade(s)`}
                      />
                    </div>
                    <span className="w-28 shrink-0 text-right tabular-nums text-[length:var(--gs-text-sm)] font-semibold">
                      {formatCents(linha.revenue_cents)}
                    </span>
                    <span className="w-20 shrink-0 text-right tabular-nums text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {formatQuantity(linha.quantity)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
      )}
    </AppShell>
  );
}
