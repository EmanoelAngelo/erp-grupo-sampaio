/**
 * ============================================================================
 * DRE — O RESULTADO DO PERÍODO, POR COMPETÊNCIA
 * ============================================================================
 *
 * ## O que esta tela é, e o que ela recusa ser
 *
 * É receita por categoria, despesa por categoria e a subtração das duas. Nada
 * mais. Não há CMV, não há margem, não há rateio, não há provisão — e a
 * RESSALVA logo abaixo do resultado diz isso em palavras, sempre, sem poder
 * ser recolhida.
 *
 * Esse painel é a parte mais importante da tela, e não um rodapé de cortesia.
 * Um DRE tem uma propriedade rara entre relatórios: alguém copia o número dele
 * para uma guia de imposto. Um relatório que omite a própria limitação não é
 * um relatório incompleto — é um relatório que engana quem confia nele.
 *
 * ## Nenhuma aritmética mora aqui
 *
 * Todos os totais vêm do servidor: `revenue.totalCents`, `expense.totalCents`,
 * `resultCents` e as parcelas da conciliação. A tela NÃO soma linha nenhuma.
 *
 * Isto não é preguiça, é a regra da rodada: a versão anterior deste relatório
 * errava R$ 100,00 em nove lançamentos porque a mesma conta era feita em três
 * lugares que se pareciam. Somar aqui de novo — nem que fosse "só para
 * conferir" — criaria a quarta, e a primeira vez que ela divergisse a tela
 * mostraria dois números certos e um errado, sem dizer qual.
 *
 * O servidor já confere três invariantes antes de devolver (nenhum lançamento
 * em duas linhas, os dois lados somando o bruto, as linhas somando o lado) e
 * ESTOURA quando alguma falha. Um número que chega aqui já passou por elas.
 *
 * ## O período tem padrão, e o padrão nunca é "tudo"
 *
 * Mês corrente. Um DRE sem recorte somaria a história inteira da empresa numa
 * coluna só — que não é o resultado de período nenhum, e é o tipo de número
 * que parece grande e não significa nada.
 *
 * ## Quem entra
 *
 * A rota do navegador é `ROTA_GESTAO`, que abre para admin_geral, gestor,
 * gerente_loja, gerente_oficina, estoquista e atendente. A rota do servidor é
 * `abertaAo(escritorio)`, cujo conjunto é EXATAMENTE esse. Um guarda mais
 * estreito que a tela — `requireProfile` com os dois gerentes, por exemplo —
 * apareceria para estoquista e atendente como tela em branco com erro de
 * permissão, entrando por uma porta que o próprio sistema abriu. É o defeito
 * que a rodada 23 existe para impedir, e ele não pode nascer de novo na 24.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, EmptyState, Kpi, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CostCenterReport,
  type CostCenterReportLine,
  type IncomeStatement,
  type IncomeStatementLine,
  type IncomeStatementSide,
} from '@/lib/api/core';

/**
 * Hoje, no fuso de quem está olhando.
 *
 * `new Date().toISOString()` devolve UTC: às 21h em Brasília a data já é a de
 * amanhã. No limite superior isso é inofensivo, mas no primeiro dia do período
 * não é — no último dia do mês, depois das 21h, o padrão pularia para o mês
 * seguinte e a tela abriria num período vazio sem explicar por quê.
 */
function hojeLocal(): string {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** O primeiro dia do mês corrente — o começo do padrão. */
function inicioDoMes(): string {
  return `${hojeLocal().slice(0, 7)}-01`;
}

/** "2026-08-01" → "01/08/2026", sem passar por `Date` (que mudaria o fuso). */
function dataLegivel(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split('-');
  return `${dia}/${mes}/${ano}`;
}

export default function DrePage() {
  const [from, setFrom] = useState(inicioDoMes);
  const [to, setTo] = useState(hojeLocal);
  const [dre, setDre] = useState<IncomeStatement | null>(null);
  /**
   * O MESMO período, pela outra pergunta: por centro de custo (GAP-V25).
   *
   * Busca separada porque é OUTRA partição do mesmo dinheiro, e não uma linha
   * dentro do DRE: "de quem é" ao lado de "para que foi". Enfiá-la na
   * estrutura por categoria faria a mesma quantia aparecer duas vezes na mesma
   * conta — que é como aquele relatório contou a devolução em dobro na
   * primeira versão.
   *
   * Falha calada de propósito: um recorte auxiliar indisponível não pode
   * derrubar o DRE, que é o produto principal da tela.
   */
  const [centros, setCentros] = useState<CostCenterReport | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [semPermissao, setSemPermissao] = useState(false);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    setSemPermissao(false);
    try {
      setDre(await coreApi.incomeStatement(from, to));
      // O recorte por centro é auxiliar: se ele falhar, o DRE continua na tela.
      setCentros(await coreApi.costCenterReport(from, to).catch(() => null));
    } catch (e) {
      setDre(null);
      setCentros(null);
      // 403 mostrado como "falha ao carregar" faz a pessoa chamar o suporte
      // por um sistema que está funcionando exatamente como deveria.
      if (e instanceof ApiRequestError && e.status === 403) setSemPermissao(true);
      else setErro(e instanceof ApiRequestError ? e.message : 'Falha ao montar o resultado.');
    } finally {
      setCarregando(false);
    }
  }, [from, to]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const periodo = useMemo(
    () => `${dataLegivel(from)} a ${dataLegivel(to)}`,
    [from, to],
  );

  return (
    <AppShell>
      <PageHeader
        /*
          A trilha diz "DRE", e não "Resultado", porque "Resultado" já é o
          rótulo do indicador logo abaixo. Duas coisas diferentes com o mesmo
          nome na mesma tela confundem quem lê e tornam ambíguo qualquer teste
          que aponte para uma delas — foi assim que o teste de ordem desta tela
          quase passou comparando a posição da MIGALHA, e não a do número.
        */
        breadcrumb={['Financeiro', 'DRE']}
        /*
          O REGIME ESTÁ NO TÍTULO, e não numa nota de rodapé.

          Competência e caixa produzem números diferentes sobre os mesmos
          fatos, e quem lê um relatório financeiro sem saber qual dos dois está
          vendo não tem como usá-lo. Escondê-lo na ressalva seria correto e
          tarde demais: a leitura do número acontece antes.
        */
        title="Resultado do período (DRE) — regime de COMPETÊNCIA"
        subtitle={
          <>
            Conta o mês do FATO, não o dia em que o dinheiro entrou ou saiu.
            Período: {periodo}.
          </>
        }
      />

      <Card
        title="Período"
        subtitle="Começa no mês corrente. Um DRE sem recorte não é resultado de período nenhum."
      >
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2">
            <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
              De:
            </span>
            <input
              type="date"
              value={from}
              aria-label="Início do período"
              onChange={(e) => setFrom(e.target.value)}
              className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] text-[var(--gs-text)]"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
              Até:
            </span>
            <input
              type="date"
              value={to}
              aria-label="Fim do período"
              onChange={(e) => setTo(e.target.value)}
              className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] text-[var(--gs-text)]"
            />
          </label>
          <Button variant="secondary" onClick={() => void carregar()} loading={carregando}>
            Atualizar
          </Button>
        </div>
      </Card>

      {semPermissao && (
        <div className="mt-5">
          <EmptyState
            title="Seu perfil não abre o resultado do período"
            description="O DRE é do escritório. Quem responde pelo financeiro consegue abri-lo."
          />
        </div>
      )}

      {erro && (
        <p
          role="alert"
          className="mt-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      {dre && (
        <>
          <div className="grid gap-5 mt-5 grid-cols-1 sm:grid-cols-3">
            {/*
              Os três números vêm PRONTOS do servidor. Recalcular
              `receita - despesa` aqui daria certo hoje e seria a segunda
              aritmética sobre o mesmo fato — a que diverge da primeira no dia
              em que alguém mudar o que entra no relatório.
            */}
            <Kpi
              label="Receita"
              value={formatCents(dre.revenue.totalCents)}
              hint={`${dre.revenue.entryCount} lançamento(s) de entrada`}
            />
            <Kpi
              label="Despesa"
              value={formatCents(dre.expense.totalCents)}
              hint={`${dre.expense.entryCount} lançamento(s) de saída`}
            />
            <Kpi
              label="Resultado"
              value={formatCents(dre.resultCents)}
              tone={dre.resultCents >= 0 ? 'positive' : 'warning'}
              hint={dre.resultCents >= 0 ? 'Receita maior que despesa' : 'Prejuízo no período'}
            />
          </div>

          {/* A ressalva vem GRUDADA no resultado, e nesta ordem de propósito. */}
          <Ressalva dre={dre} />

          <CustoDoVendido dre={dre} />

          <PainelXDre dre={dre} />

          <div className="grid gap-5 mt-5 grid-cols-1 xl:grid-cols-2">
            <LadoCard
              titulo="Receita por categoria"
              subtitulo="Entradas do período, agrupadas pelo plano de contas."
              lado={dre.revenue}
              vazio="Nenhuma entrada com competência neste período."
              classificarEm="/sistema/financeiro/contas-a-receber"
            />
            <LadoCard
              titulo="Despesa por categoria"
              subtitulo="Saídas do período — a devolução aparece aqui, na categoria dela."
              lado={dre.expense}
              vazio="Nenhuma saída com competência neste período."
              classificarEm="/sistema/financeiro/contas-a-pagar"
            />
          </div>

          {centros && <CentrosDeCustoCard relatorio={centros} />}
        </>
      )}
    </AppShell>
  );
}

/**
 * ============================================================================
 * O PERÍODO POR CENTRO DE CUSTO (GAP-V25)
 * ============================================================================
 *
 * ## O defeito que este bloco fecha
 *
 * `core_cost_centers` tinha cadastro completo, `createEntry` gravava
 * `cost_center_id` em todo lançamento, a rota o repassava — e NENHUM relatório
 * o lia. Preencher centro de custo era trabalho sem retorno.
 *
 * ## Por que ele é um bloco IRMÃO, e não uma coluna do DRE
 *
 * O DRE tem uma regra de uma frase: cada lançamento entra em EXATAMENTE UMA
 * linha, e a linha é a categoria. Centro de custo é outra pergunta sobre o
 * mesmo dinheiro. Enfiá-la lá dentro faria a mesma quantia aparecer em duas
 * partições da mesma estrutura — foi assim que a primeira versão daquele
 * relatório contou a devolução duas vezes.
 *
 * Mesma competência, mesmo período, mesmo critério de cancelamento: os totais
 * daqui BATEM com os do DRE acima, e é isso que permite ler as duas tabelas na
 * mesma tela sem desconfiar de nenhuma.
 *
 * ## Nenhuma aritmética mora aqui
 *
 * Como no resto da tela: todos os números vêm somados do servidor, que já
 * confere que as linhas somam os totais e ESTOURA se não somarem.
 */
function CentrosDeCustoCard({ relatorio }: { relatorio: CostCenterReport }) {
  const semCentro = relatorio.lines.find((l) => l.costCenterId === null);
  return (
    <div className="mt-5">
      <Card
        title="Por centro de custo"
        subtitle={
          'De quem é o gasto — a outra pergunta sobre o mesmo dinheiro. '
          + 'Mesmo período e mesma competência do DRE acima: os totais batem.'
        }
      >
        <DataTable<CostCenterReportLine>
          rows={relatorio.lines}
          keyOf={(l) => l.costCenterId ?? 'sem-centro'}
          empty={
            <EmptyState
              title="Nada neste período"
              description="Nenhum lançamento com competência no período escolhido."
            />
          }
          columns={[
            {
              header: 'Centro de custo',
              render: (l) =>
                l.costCenterId === null ? (
                  <Badge tone="warning">SEM CENTRO DE CUSTO</Badge>
                ) : (
                  <span className="font-semibold text-[var(--gs-purple-900)]">
                    {l.costCenterCode ? `${l.costCenterCode} · ` : ''}
                    {l.costCenterName}
                  </span>
                ),
            },
            { header: 'Lançamentos', align: 'right', render: (l) => String(l.entryCount) },
            { header: 'Receita', align: 'right', render: (l) => formatCents(l.revenueCents) },
            { header: 'Despesa', align: 'right', render: (l) => formatCents(l.expenseCents) },
            {
              header: 'Resultado',
              align: 'right',
              render: (l) => (
                <span
                  className={
                    l.resultCents < 0
                      ? 'text-[var(--gs-danger)] tabular-nums'
                      : 'tabular-nums'
                  }
                >
                  {formatCents(l.resultCents)}
                </span>
              ),
            },
          ]}
        />

        <div
          className="flex flex-wrap items-center justify-between gap-4 mt-3 pt-3
            border-t border-[var(--gs-border-strong)]"
        >
          <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
            Total do período
          </span>
          <span className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] tabular-nums">
            {formatCents(relatorio.revenueTotalCents)} de receita ·{' '}
            {formatCents(relatorio.expenseTotalCents)} de despesa
          </span>
        </div>

        {semCentro && (
          /*
            A LINHA "SEM CENTRO DE CUSTO" É A MAIS IMPORTANTE no primeiro mês —
            no banco real ela é o período inteiro. Ela mede o quanto do rateio
            ainda não foi feito, e por isso ganha o atalho para a lista onde se
            atribui, do mesmo jeito que "Sem categoria" ganhou o dele.
          */
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-3 mb-0">
            {semCentro.entryCount} lançamento(s) sem centro de custo, somando{' '}
            {formatCents(semCentro.expenseCents)} de despesa e{' '}
            {formatCents(semCentro.revenueCents)} de receita.{' '}
            <Link
              to="/sistema/financeiro/contas-a-pagar"
              className="text-[var(--gs-purple-700)] font-semibold underline"
            >
              Atribuir o centro
            </Link>{' '}
            no lançamento é o que faz esta linha encolher.
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * Um lado do relatório: as categorias e o total.
 *
 * A LINHA "SEM CATEGORIA" APARECE NOS DOIS LADOS, e marcada. Ela é o que
 * precisa de ação — não o que precisa sumir. Escondê-la faria o total não
 * bater com a soma visível das linhas, que é a forma mais rápida de fazer
 * alguém desconfiar de um relatório inteiro por causa de uma decisão de
 * layout. O servidor já a manda por último; aqui ela ganha rótulo e um atalho
 * para a lista onde se classifica.
 */
function LadoCard({
  titulo,
  subtitulo,
  lado,
  vazio,
  classificarEm,
}: {
  titulo: string;
  subtitulo: string;
  lado: IncomeStatementSide;
  vazio: string;
  /** A lista onde ESTE lado se classifica: receber para receita, pagar para despesa. */
  classificarEm: string;
}) {
  const semCategoria = lado.lines.find((l) => l.categoryId === null);
  return (
    <Card title={titulo} subtitle={subtitulo}>
      <DataTable<IncomeStatementLine>
        rows={lado.lines}
        keyOf={(l) => l.categoryId ?? 'sem-categoria'}
        empty={<EmptyState title="Nada neste lado" description={vazio} />}
        columns={[
          {
            header: 'Categoria',
            render: (l) =>
              l.categoryId === null ? (
                <Badge tone="warning">SEM CATEGORIA</Badge>
              ) : (
                <span className="font-semibold text-[var(--gs-purple-900)]">{l.categoryName}</span>
              ),
          },
          { header: 'Lançamentos', align: 'right', render: (l) => String(l.entryCount) },
          { header: 'Valor', align: 'right', render: (l) => formatCents(l.totalCents) },
        ]}
      />

      <div
        className="flex items-center justify-between gap-4 mt-3 pt-3
          border-t border-[var(--gs-border-strong)]"
      >
        <span className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-text-soft)]">
          Total
        </span>
        {/* O total do LADO, como o servidor o devolveu — não a soma das linhas. */}
        <span className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] tabular-nums">
          {formatCents(lado.totalCents)}
        </span>
      </div>

      {semCategoria && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-3 mb-0">
          {semCategoria.entryCount} lançamento(s) sem categoria, somando{' '}
          {formatCents(semCategoria.totalCents)}.{' '}
          <Link to={classificarEm} className="text-[var(--gs-purple-700)] font-semibold underline">
            Classificar
          </Link>{' '}
          é o que faz esta linha encolher.
        </p>
      )}
    </Card>
  );
}

/**
 * A RESSALVA — painel FIXO, sempre aberto, nunca recolhível.
 *
 * ## Por que ela não usa `collapsible`
 *
 * Porque um painel que recolhe é um painel que fica recolhido. A pessoa fecha
 * uma vez para ver o número inteiro e nunca mais abre — e a partir daí o DRE
 * volta a ser um total sem contexto, com a limitação tecnicamente presente e
 * praticamente ausente. Recolher aqui não é uma comodidade, é a desativação da
 * única parte da tela que impede o número de ser usado errado.
 *
 * ## Por que as frases vêm do servidor
 *
 * Porque a tela renderiza a LISTA INTEIRA e não escolhe nenhuma. Frase escrita
 * aqui dentro é frase que a próxima reescrita da tela pode deixar cair — em
 * geral justamente a que incomoda. As condicionais (quantos lançamentos estão
 * sem categoria, quanto voltou como crédito na loja) só existem quando são
 * verdade, porque ressalva que aparece sempre vira paisagem.
 */
/**
 * O CUSTO DA MERCADORIA VENDIDA — GAP-V28.
 *
 * ## Por que este bloco fica FORA dos três KPIs de cima
 *
 * Ele não é o quarto número do resultado: é uma medida GERENCIAL, com régua
 * própria e alcance próprio, e misturá-lo produziria dois erros de uma vez.
 *
 *   1. A RÉGUA É OUTRA. Os três de cima contam LANÇAMENTOS por competência; o
 *      CMV conta MERCADORIA pela data da venda (dia da loja) — a mesma régua
 *      do painel. Uma venda de 30 de junho com lançamento de competência de
 *      julho fica em meses diferentes nas duas contas, e é assim que tem de
 *      ser.
 *
 *   2. ELE NÃO É DESCONTADO DO RESULTADO, e a tela DIZ isso. A compra da
 *      mercadoria já entrou como despesa neste mesmo relatório, no título da
 *      nota de entrada; deduzir o CMV também tiraria a mesma compra duas vezes.
 *      Um card sem essa frase seria lido como "resultado − CMV", que é a conta
 *      errada com a cara mais convincente possível.
 *
 * ## E as três contagens não são detalhe
 *
 * `itemsWithCost` diz sobre quantas linhas a margem foi calculada;
 * `itemsWithoutCost`, quantas saíram por o produto não ter custo cadastrado
 * (pendência que tem conserto); `itemsBeforeSnapshot`, quantas são de antes de
 * o sistema fotografar custo (que não tem). Sem as três, "CMV do mês" é lido
 * como o custo do mês inteiro quando é o custo das linhas que TÊM custo.
 */
function CustoDoVendido({ dre }: { dre: IncomeStatement }) {
  const { cogs } = dre;
  const semRetrato = cogs.itemsWithCost === 0 && cogs.itemsBeforeSnapshot > 0;

  return (
    <section
      aria-label="Custo da mercadoria vendida"
      className="mt-5 p-5 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
        bg-[var(--gs-surface)]"
    >
      <h2 className="text-[17px] font-semibold text-[var(--gs-purple-900)] m-0">
        Custo da mercadoria vendida (CMV) e margem
      </h2>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-4">
        Medido pela data da VENDA, e <strong>não descontado do resultado acima</strong>: a compra da
        mercadoria já entra no DRE como despesa, no título da nota de entrada.
      </p>

      {semRetrato ? (
        <p className="m-0 text-[length:var(--gs-text-base)]">
          <strong>Não há CMV para este período.</strong> As {cogs.itemsBeforeSnapshot} linha(s) de
          venda são anteriores ao dia em que o sistema passou a gravar o custo na hora da venda — e
          não há conserto retroativo: reconstruir o custo de então com o custo de hoje seria inventar
          número.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Receita considerada
            </p>
            <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
              {formatCents(cogs.revenueCents)}
            </p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">CMV</p>
            <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
              {formatCents(cogs.costCents)}
            </p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Margem bruta</p>
            <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
              {formatCents(cogs.marginCents)}
            </p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Percentual</p>
            <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
              {/*
                Nulo é "não dá para saber", e é diferente de zero. Escrever 0%
                aqui afirmaria que a loja vendeu sem lucro.
              */}
              {cogs.marginPercent === null ? '—' : `${cogs.marginPercent}%`}
            </p>
          </div>
        </div>
      )}

      {(cogs.itemsWithoutCost > 0 || cogs.itemsBeforeSnapshot > 0) && !semRetrato && (
        <p className="text-[var(--gs-warning)] text-[length:var(--gs-text-sm)] font-semibold mt-4 mb-0">
          A margem acima vale sobre {cogs.itemsWithCost} linha(s) de venda.
          {cogs.itemsWithoutCost > 0 && (
            <> {cogs.itemsWithoutCost} ficaram de fora por o produto estar sem custo cadastrado.</>
          )}
          {cogs.itemsBeforeSnapshot > 0 && (
            <>
              {' '}
              {cogs.itemsBeforeSnapshot} são de vendas anteriores ao dia em que o sistema passou a
              gravar o custo — essas não têm conserto.
            </>
          )}
        </p>
      )}
    </section>
  );
}

function Ressalva({ dre }: { dre: IncomeStatement }) {
  return (
    <section
      aria-label="O que este resultado não inclui"
      className="mt-5 p-5 rounded-[var(--gs-radius)] border-2 border-[var(--gs-warning)]
        bg-[var(--gs-warning-bg)]"
    >
      <h2 className="text-[17px] font-bold text-[var(--gs-warning)] m-0">
        O que este número NÃO inclui
      </h2>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] mt-1 mb-3">
        Leia antes de copiar o resultado para qualquer lugar — guia de imposto,
        contador, planilha.
      </p>
      <ul className="list-disc pl-5 m-0 flex flex-col gap-1.5">
        {dre.caveats.map((frase) => (
          <li key={frase} className="text-[length:var(--gs-text-base)] text-[var(--gs-text)]">
            {frase}
          </li>
        ))}
      </ul>
      {dre.uncategorized.entryCount > 0 && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] mt-3 mb-0">
          Os lançamentos sem categoria estão em{' '}
          <Link
            to="/sistema/financeiro/contas-a-receber"
            className="text-[var(--gs-purple-700)] font-semibold underline"
          >
            Contas a receber
          </Link>{' '}
          e{' '}
          <Link
            to="/sistema/financeiro/contas-a-pagar"
            className="text-[var(--gs-purple-700)] font-semibold underline"
          >
            Contas a pagar
          </Link>
          , no filtro “Sem categoria”.
        </p>
      )}
    </section>
  );
}

/**
 * PAINEL × DRE — a diferença com NOME, ou nenhum link.
 *
 * ## O que este bloco impede
 *
 * O painel do dono e este relatório mostram faturamentos diferentes, e sempre
 * mostrarão: o painel soma VENDAS concluídas pela data da venda; o DRE soma
 * LANÇAMENTOS de entrada pela competência. Pedido online, receita de serviço e
 * lançamento manual existem no segundo e não no primeiro.
 *
 * Duas telas do mesmo sistema mostrando dois faturamentos do mesmo mês, sem
 * explicação, produzem uma conclusão previsível: "o sistema está errado". A
 * pessoa então escolhe o número de que gosta mais, e é aí que a contabilidade
 * paralela começa.
 *
 * Por isso a diferença é DECOMPOSTA em parcelas com nome — e o servidor
 * confere que elas somam exatamente a diferença, estourando se não somarem.
 * Uma lista de motivos que não fecha com o número é pior do que motivo nenhum,
 * porque tem cara de explicação.
 *
 * Quando os dois números coincidem, o bloco diz isso — e continua existindo,
 * porque "hoje bate" é informação, e some no dia em que deixar de bater.
 */
function PainelXDre({ dre }: { dre: IncomeStatement }) {
  const { panelRevenueCents, statementRevenueCents, differenceCents, lines } = dre.reconciliation;
  const divergem = differenceCents !== 0;

  return (
    <div className="mt-5">
      <Card
        title="Por que o Painel mostra outro faturamento"
        subtitle="Duas contas legítimas sobre conjuntos diferentes. A diferença é decomposta abaixo, parcela por parcela."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <div>
            <p className="text-[length:var(--gs-text-sm)] font-semibold uppercase text-[var(--gs-muted)] m-0">
              Painel (vendas)
            </p>
            <p className="text-[length:var(--gs-text-xl)] font-bold text-[var(--gs-purple-900)] mt-1 mb-0 tabular-nums">
              {formatCents(panelRevenueCents)}
            </p>
          </div>
          <div>
            <p className="text-[length:var(--gs-text-sm)] font-semibold uppercase text-[var(--gs-muted)] m-0">
              DRE (lançamentos)
            </p>
            <p className="text-[length:var(--gs-text-xl)] font-bold text-[var(--gs-purple-900)] mt-1 mb-0 tabular-nums">
              {formatCents(statementRevenueCents)}
            </p>
          </div>
          <div>
            <p className="text-[length:var(--gs-text-sm)] font-semibold uppercase text-[var(--gs-muted)] m-0">
              Diferença
            </p>
            <p
              className={`text-[length:var(--gs-text-xl)] font-bold mt-1 mb-0 tabular-nums ${
                divergem ? 'text-[var(--gs-warning)]' : 'text-[var(--gs-success)]'
              }`}
            >
              {formatCents(differenceCents)}
            </p>
          </div>
        </div>

        {divergem ? (
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {lines.map((l) => (
              <li
                key={l.key}
                className="flex items-start justify-between gap-4 py-2
                  border-b border-[var(--gs-border)]"
              >
                <span className="text-[length:var(--gs-text-base)] text-[var(--gs-text)]">{l.label}</span>
                <span className="font-semibold tabular-nums whitespace-nowrap text-[var(--gs-purple-900)]">
                  {formatCents(l.cents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[length:var(--gs-text-base)] text-[var(--gs-success)] font-semibold m-0">
            Neste período os dois números coincidem.
          </p>
        )}

        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-4 mb-0">
          {/*
            O link vem DEPOIS da explicação, e nunca sozinho: mandar alguém do
            DRE para o painel sem dizer por que os números diferem é o link
            mudo que este bloco existe para impedir.
          */}
          Abrir o{' '}
          <Link to="/sistema/painel" className="text-[var(--gs-purple-700)] font-semibold underline">
            Painel
          </Link>{' '}
          — lembrando que ele mede pela data da venda e só conta venda de balcão.
        </p>
      </Card>
    </div>
  );
}
