/**
 * Contas a receber e a pagar.
 *
 * UMA tela para os dois lados: o lançamento é o mesmo, muda a direção. Duas
 * telas separadas duplicariam a regra de baixa, e a segunda cópia divergiria
 * da primeira no primeiro ajuste.
 *
 * O QUE A TELA PRECISA RESPONDER, nesta ordem: quanto está em aberto, quanto
 * está vencido, e o que vence primeiro. Por isso os totais vêm somados do
 * servidor (a lista traz 500 linhas; somar no navegador daria um número menor
 * e silenciosamente errado) e a ordenação padrão é por vencimento.
 *
 * BAIXA PARCIAL É A REGRA, não a exceção: quem paga metade hoje e metade no
 * fim do mês é o caso comum. O campo de valor já vem preenchido com o saldo,
 * mas é editável.
 *
 * ## A CATEGORIA, e por que ela chegou aqui nesta rodada
 *
 * O DRE agrupa receita e despesa por categoria. Enquanto o lançamento avulso
 * nascia sem classificação, tudo que se lança à mão caía na linha "Sem
 * categoria" do relatório — e a categoria automática das vendas, que já
 * existia, não bastava para o mês fechar legível.
 *
 * Três coisas andam juntas por isso, e nenhuma funciona sozinha:
 *
 *   1. o FORMULÁRIO oferece a categoria (e a competência, que é o mês em que o
 *      fato conta no DRE, e a conta bancária, que move o saldo em Cadastros);
 *   2. a LISTA mostra a categoria de cada linha;
 *   3. o FILTRO recorta por categoria — inclusive pelo avesso, "sem
 *      categoria", que é como se chega nas linhas que o DRE aponta na ressalva.
 *
 * Sem (2), o filtro de (3) não teria como ser conferido; sem (3), saber que
 * existem quarenta lançamentos sem categoria não ajudaria ninguém a
 * classificá-los.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Kpi,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { destinoDaOrigem } from '@/lib/rotasDeOrigem';
import { uuid } from '@/lib/uuid';
import {
  coreApi,
  type FinanceAccount,
  type FinanceAging,
  type FinanceCategory,
  type FinanceCharge,
  type FinanceEntry,
  type FinanceSettlement,
  type FinanceSummary,
  type PaymentIntentRow,
  type PaymentIntentView,
} from '@/lib/api/core';
import { cobrancasApi } from '@/lib/api/cobrancas';
import { PixPendentesDoBalcaoCard } from '@/components/gs/PixPendentesDoBalcaoCard';

const SITUACOES = [
  { valor: '', rotulo: 'Todas' },
  { valor: 'open', rotulo: 'Em aberto' },
  { valor: 'overdue', rotulo: 'Vencidas' },
  { valor: 'settled', rotulo: 'Quitadas' },
];

/**
 * O avesso do filtro: o que ninguém classificou.
 *
 * O texto é o mesmo que o servidor entende (`FinanceService.SEM_CATEGORIA`).
 * Duas grafias — uma aqui, outra lá — devolveriam a lista inteira em silêncio,
 * que é exatamente o modo de falha desta rodada: filtro que a rota engole e
 * quem filtrou acreditando ter recortado.
 */
const SEM_CATEGORIA = 'sem-categoria';

/**
 * O mesmo avesso, para o centro de custo (GAP-V25).
 *
 * O texto é o que o servidor entende (`FinanceService.SEM_CENTRO_DE_CUSTO`), e
 * ele importa mais aqui do que na categoria: o banco real tem ZERO lançamentos
 * com centro atribuído. O primeiro recorte útil desta tela é justamente "o que
 * ainda não tem dono" — sem esta opção, o filtro nasceria bonito e inútil.
 */
const SEM_CENTRO_DE_CUSTO = 'sem-centro-de-custo';

const CAIXA_SELECT =
  'h-[52px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]';

/*
  Para onde cada origem navega — e o DOCUMENTO vai junto.

  Aqui morava um `Record<string, string>` de origem → TELA. Ele tinha dois
  buracos, e os dois deixavam a pessoa a meio caminho:

  1. A COMPRA DA FEIRA NÃO TINHA PORTA. O servidor passou a rotular
     'entrada_manual' ('Entrada manual EM-7 — Seu Zé'), a quinta origem que a
     entrada sem nota fiscal grava de propósito (GAP-V17) — e o mapa conhecia
     quatro. Rótulo na tela, nenhum caminho: texto morto.

  2. O LINK LEVAVA À SALA, NÃO À GAVETA. `/sistema/compras/entrada-notas` abre
     a lista inteira; quem clicou em "Nota 4711" ainda tinha de procurar a 4711
     entre duzentas. O gesto que sobrava era exatamente o que o link prometia
     evitar.

  `destinoDaOrigem` (src/lib/rotasDeOrigem) devolve o endereço COM o id, e as
  telas de destino sabem abrir o documento. Origem sem superfície continua
  devolvendo `null` e continua sem virar link — porta desenhada que não abre é
  o defeito que este repo já documentou no botão de cancelar.
*/

function data(iso: string | null): string {
  if (!iso) return '—';
  // Sem fuso: 'YYYY-MM-DD' interpretado como UTC voltaria um dia em BRT, e o
  // vencimento apareceria errado justamente na virada do mês.
  const [ano, mes, dia] = iso.slice(0, 10).split('-');
  return `${dia}/${mes}/${ano}`;
}

/**
 * Centavos a partir do que a pessoa digita.
 *
 * O leitor que morava aqui apagava TODO ponto: `1234.56` virava `123456` e o
 * campo lançava R$ 123.456,00 — cem vezes o valor, sem erro na tela. E
 * `parseReaisToCents` já resolvia a ambiguidade do ponto pela regra do grupo de
 * três, com teste próprio. Eram duas cópias do mesmo leitor de dinheiro, e a
 * errada estava justamente na tela onde se digita valor.
 *
 * `NaN` em vez de `null` porque é o que as duas chamadas já conferem.
 */
function paraCentavos(texto: string): number {
  return parseReaisToCents(texto) ?? NaN;
}

/**
 * Como cada estado da cobrança se apresenta — e o tom NÃO é decorativo.
 *
 * `failed` e `amount_mismatch` são vermelhos porque exigem alguém: um é
 * cobrança que não chegou a existir no provedor, o outro é dinheiro que entrou
 * com valor diferente do cobrado e por isso NÃO baixou o título. Chamar os
 * dois de "pendente" — que era o efeito de não os mostrar em lugar nenhum —
 * é o defeito que esta rodada fecha.
 *
 * ## Por que o FILTRO sai daqui, e não de uma segunda lista
 *
 * O DEFEITO: o `<select>` de situação era uma lista escrita à mão, com SEIS
 * opções, ao lado deste mapa, que conhecia DEZ. `refunded`, `chargeback`,
 * `cancelled` e `paid_after_cancel` não eram filtráveis — e `paid_after_cancel`
 * é justamente o que alguém procura ao abrir esta tela: dinheiro recebido
 * DEPOIS do cancelamento, que o próprio servidor descreve como "pendente de
 * regularização". Duas listas para a mesma coisa, e a segunda envelheceu
 * calada.
 *
 * Agora a situação nova ganha rótulo E filtro no mesmo lugar. `filtro` é o
 * nome em frase, porque `<option>` não é crachá: "PAGA APÓS CANCELAR" gritando
 * dentro de uma caixa de seleção é ruído.
 */
type SituacaoDaCobranca =
  | 'pending'
  | 'confirmed'
  | 'overdue'
  | 'failed'
  | 'amount_mismatch'
  | 'unconfigured'
  | 'cancelled'
  | 'refunded'
  | 'chargeback'
  | 'paid_after_cancel';

interface ApresentacaoDaCobranca {
  rotulo: string;
  filtro: string;
  tom: 'neutral' | 'success' | 'warning' | 'danger';
}

const COBRANCA: Record<SituacaoDaCobranca, ApresentacaoDaCobranca> = {
  pending: { rotulo: 'AGUARDANDO PAGAMENTO', filtro: 'Aguardando pagamento', tom: 'neutral' },
  confirmed: { rotulo: 'PAGA', filtro: 'Pagas', tom: 'success' },
  overdue: { rotulo: 'VENCIDA', filtro: 'Vencidas', tom: 'warning' },
  failed: { rotulo: 'FALHOU', filtro: 'Falharam', tom: 'danger' },
  amount_mismatch: { rotulo: 'VALOR DIVERGENTE', filtro: 'Valor divergente', tom: 'danger' },
  unconfigured: { rotulo: 'SEM INTEGRAÇÃO', filtro: 'Sem integração', tom: 'warning' },
  cancelled: { rotulo: 'CANCELADA', filtro: 'Canceladas', tom: 'neutral' },
  refunded: { rotulo: 'ESTORNADA', filtro: 'Estornadas', tom: 'warning' },
  chargeback: { rotulo: 'CHARGEBACK', filtro: 'Chargeback', tom: 'danger' },
  paid_after_cancel: {
    rotulo: 'PAGA APÓS CANCELAR',
    filtro: 'Pagas após cancelar',
    tom: 'danger',
  },
};

/** As opções do filtro, na ordem do mapa. Uma lista só, e é a de cima. */
const SITUACOES_DA_COBRANCA = Object.entries(COBRANCA) as [
  SituacaoDaCobranca,
  ApresentacaoDaCobranca,
][];

function situacaoDaCobranca(status: string): ApresentacaoDaCobranca {
  return (
    COBRANCA[status as SituacaoDaCobranca]
    ?? { rotulo: status.toUpperCase(), filtro: status, tom: 'neutral' as const }
  );
}

const MEIO_DA_COBRANCA: Record<string, string> = {
  pix: 'PIX',
  boleto: 'Boleto',
  cartao: 'Cartão',
  manual: 'Manual',
};

/** Uma cobrança só é RE-tentável se ela não existe do lado do provedor. */
function podeRetentar(status: string, providerRef: string | null): boolean {
  return !providerRef && (status === 'failed' || status === 'unconfigured');
}

/**
 * Uma cobrança de TÍTULO ainda de pé no provedor é a que se pode cancelar.
 *
 * Cobrança PAGA não entra: o dinheiro já está na conta e apagar a cobrança
 * apagaria o rastro dele — o caminho ali é o estorno, que deixa contrapartida.
 * Cobrança de PEDIDO também não: cancelar a cobrança sem cancelar o pedido
 * deixaria o pedido esperando um pagamento que não pode mais chegar, e quem
 * cancela pedido é a tela do pedido.
 *
 * A lista de estados espelha `VIDA_DA_COBRANCA`, no servidor, que é quem
 * decide de verdade — aqui ela só evita desenhar um botão que levaria recusa.
 */
const COBRANCAS_VIVAS = new Set<SituacaoDaCobranca>([
  'pending',
  'overdue',
  'failed',
  'unconfigured',
]);

function podeCancelarNoProvedor(originType: string, status: string): boolean {
  return originType === 'finance_entry' && COBRANCAS_VIVAS.has(status as SituacaoDaCobranca);
}

/**
 * O caminho do dinheiro que ENTROU é o estorno (GAP-PRD-092).
 *
 * A frase acima estava escrita e o botão não existia: devolver o PIX de um
 * título pago era estornar no portal do Asaas e, depois, lembrar de estornar a
 * baixa aqui. Agora o estorno se pede daqui, para cobrança de TÍTULO paga — e
 * também para a já estornada no portal cuja baixa continua de pé
 * (`settlementStanding`), onde o gesto só desfaz a baixa.
 */
const COBRANCAS_PAGAS = new Set<SituacaoDaCobranca>(['confirmed', 'amount_mismatch', 'paid_after_cancel']);

function podeEstornarCobranca(i: PaymentIntentView): boolean {
  if (i.originType !== 'finance_entry' || !i.providerRef) return false;
  if (COBRANCAS_PAGAS.has(i.status as SituacaoDaCobranca)) return true;
  return i.status === 'refunded' && i.settlementStanding === true;
}

export default function ContasPage() {
  const direction: 'in' | 'out' = useLocation().pathname.includes('receber') ? 'in' : 'out';
  const receber = direction === 'in';

  /*
    Quem LANÇA é quem o servidor deixa lançar.

    `POST /core/finance/entries` exige gerente_loja ou gerente_oficina (com
    admin_geral e gestor por cima). A tela é ROTA_GESTAO e deixa entrar também
    estoquista e atendente — para ler, cobrar e dar baixa, que é trabalho
    deles. Desenhar o botão "Lançar conta" para os seis faria três deles
    preencherem descrição, valor, vencimento e categoria para receber 403 no
    fim. O botão sai, e a ausência dele se EXPLICA logo abaixo.

    Note a direção do ajuste: aqui a tela se estreita para caber no servidor,
    porque criar dinheiro a pagar é decisão de gestão. É o oposto de estreitar
    o SERVIDOR abaixo da tela, que é o defeito que a rodada 23 fechou.
  */
  const podeLancar = useHasProfile('gerente_loja', 'gerente_oficina');

  /*
    Quem COBRA é quem o servidor deixa cobrar.

    `POST /core/finance/entries/:id/charge` tem o mesmo alcance da baixa —
    gerência das duas operações e os caixas —, porque cobrar e dar baixa são o
    mesmo trabalho, feito pelas mesmas pessoas. Estoquista e atendente
    alcançam a tela e LEEM a lista de cobranças; gerar cobrança no provedor,
    não. Desenhar o botão para eles seria escolher o meio, digitar as parcelas
    e levar 403 no fim.
  */
  const podeCobrar = useHasProfile(
    'gerente_loja',
    'gerente_oficina',
    'operador_caixa',
    'operador_caixa_loja',
    'operador_caixa_oficina',
  );

  /*
    Quem ESTORNA é a gerência (GAP-PRD-092). `POST /charges/refund` exige
    gerente_loja ou gerente_oficina (com admin_geral e gestor por cima):
    devolver dinheiro ao cliente e mexer em receita já reconhecida é decisão de
    quem responde pelo caixa, não do caixa. O botão só aparece para eles.
  */
  const podeEstornar = useHasProfile('gerente_loja', 'gerente_oficina');

  const [itens, setItens] = useState<FinanceEntry[] | null>(null);
  const [resumo, setResumo] = useState<FinanceSummary | null>(null);
  const [faixas, setFaixas] = useState<FinanceAging | null>(null);
  const [situacao, setSituacao] = useState('open');
  const [categoria, setCategoria] = useState('');
  const [categorias, setCategorias] = useState<FinanceCategory[]>([]);
  /**
   * O filtro por centro de custo (GAP-V25).
   *
   * A coluna era gravada em todo lançamento e nenhuma tela a lia. Este filtro
   * e o recorte do DRE são os dois primeiros leitores dela.
   */
  const [centro, setCentro] = useState('');
  const [centros, setCentros] = useState<{ id: string; code: string; name: string }[]>([]);
  const [busca, setBusca] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aberta, setAberta] = useState<FinanceEntry | null>(null);
  const [criando, setCriando] = useState(false);

  const carregar = useCallback(async () => {
    setError(null);
    try {
      const r = await coreApi.listFinanceEntries({
        direction,
        situation: situacao || undefined,
        search: busca.trim() || undefined,
        // O filtro CHEGA na consulta. Escrevê-lo na tela e não mandá-lo é o
        // formato de defeito que esta rodada existe para consertar.
        categoryId: categoria || undefined,
        // Idem para o centro de custo: escrito na tela e não repassado é o
        // formato de defeito que a rodada da categoria já consertou uma vez.
        costCenterId: centro || undefined,
      });
      setItens(r.items);
      setResumo(r.summary);
      setFaixas(r.aging);
    } catch (err) {
      setItens(null);
      setResumo(null);
      setFaixas(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar.');
    }
  }, [direction, situacao, busca, categoria, centro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /*
    As categorias do LADO desta tela.

    Saem de `/core/finance/categories`, e não de `/core/finance/setup`: aquela
    exige gerente e devolve o saldo de todas as contas bancárias junto, e esta
    tela abre para estoquista e atendente. Um seletor que responde 403 para
    quem a tela deixou entrar é tela quebrada em produção.

    Falha aqui não derruba a lista: sem categorias o filtro some, e as contas
    continuam sendo cobradas e baixadas.
  */
  useEffect(() => {
    let vivo = true;
    void coreApi
      .financeCategories(direction)
      .then((lista) => {
        if (vivo) setCategorias(lista);
      })
      .catch(() => {
        if (vivo) setCategorias([]);
      });
    return () => {
      vivo = false;
    };
  }, [direction]);

  /*
    Os centros de custo, para o filtro e para o formulário (GAP-V25).

    Rota própria (`/core/finance/cost-centers`), e não `/finance/setup`, pelo
    mesmo motivo das categorias: aquela exige gerente e traz saldo bancário
    junto, e esta tela recebe estoquista e atendente.

    Falha calada: sem a lista o filtro some, e as contas continuam sendo
    cobradas e baixadas. E LISTA VAZIA ESCONDE O FILTRO de propósito — a
    empresa que não usa centro de custo não precisa ver um seletor de uma
    opção só.
  */
  useEffect(() => {
    let vivo = true;
    void coreApi
      .financeCostCenters()
      .then((lista) => {
        if (vivo) setCentros(lista);
      })
      .catch(() => {
        if (vivo) setCentros([]);
      });
    return () => {
      vivo = false;
    };
  }, []);

  // Trocar de lado precisa limpar o que estava aberto: o detalhe de uma conta
  // a receber não faz sentido na tela de pagar. E o filtro por categoria vai
  // junto — categoria de receita não existe do lado de pagar, e mantê-la
  // devolveria uma lista vazia que pareceria "não há contas".
  useEffect(() => {
    setAberta(null);
    setCriando(false);
    setCategoria('');
  }, [direction]);

  const titulo = receber ? 'Contas a receber' : 'Contas a pagar';

  const proximas = useMemo(
    () => (itens ?? []).filter((e) => e.balanceCents > 0 && !e.overdue).length,
    [itens],
  );
  // Só para servidor antigo, que ainda não manda `openCount`: conta os abertos
  // da própria lista em vez de cair no total, que é o número errado.
  const abertosNaLista = useMemo(
    () => (itens ?? []).filter((e) => e.balanceCents > 0).length,
    [itens],
  );

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Financeiro', receber ? 'A receber' : 'A pagar']}
        title={titulo}
        subtitle={
          <>
            O que entra aqui alimenta o{' '}
            <Link
              to="/sistema/financeiro/dre"
              className="text-[var(--gs-purple-700)] font-semibold underline"
            >
              resultado do período
            </Link>
            , agrupado pela categoria de cada lançamento.
          </>
        }
        actions={
          podeLancar ? (
            <Button onClick={() => setCriando(true)}>Lançar conta</Button>
          ) : undefined
        }
      />

      {!podeLancar && (
        // A ausência do botão se explica. Um botão que some sem motivo lê-se
        // como tela quebrada, e a pessoa abre chamado por um sistema correto.
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] -mt-3 mb-5">
          Lançar conta avulsa é do gerente. Cobrar, dar baixa e consultar
          continuam sendo seus.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        {/*
          O SUBTÍTULO CONTA OS ABERTOS (GAP-PRD-208). Ele mostrava
          `summary.count` — todos os lançamentos do lado, quitados inclusive —,
          e a tela dizia "R$ 0,00 · 1 lançamento(s)" com o único lançamento já
          liquidado. O número ao lado do valor em aberto tem de contar a mesma
          coisa que o valor.
        */}
        <Kpi
          label="Em aberto"
          value={formatCents(resumo?.openCents ?? 0)}
          hint={`${resumo?.openCount ?? abertosNaLista} em aberto`}
        />
        <Kpi
          label="Vencido"
          value={formatCents(resumo?.overdueCents ?? 0)}
          tone={resumo && resumo.overdueCents > 0 ? 'warning' : 'neutral'}
          hint={receber ? 'Cobrar primeiro' : 'Pagar primeiro'}
        />
        <Kpi
          label={receber ? 'Já recebido' : 'Já pago'}
          value={formatCents(resumo?.settledCents ?? 0)}
          tone="positive"
          hint={`${proximas} a vencer`}
        />
      </div>

      {faixas && (
        /*
          O VENCIDO POR IDADE. O total vencido já aparece no KPI acima; estas
          faixas respondem a pergunta seguinte — há quanto tempo — que é a que
          decide para quem se liga primeiro. Os números vêm prontos do
          servidor, pela mesma régua do dia da loja que marca "vencida" na
          lista logo abaixo: duas réguas divergiriam perto da meia-noite.
        */
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5" aria-label="Vencido por idade">
          {(
            [
              ['A vencer', faixas.notDueCents, false],
              ['1–30 dias', faixas.days1to30Cents, true],
              ['31–60 dias', faixas.days31to60Cents, true],
              ['61–90 dias', faixas.days61to90Cents, true],
              ['Mais de 90', faixas.over90Cents, true],
            ] as const
          ).map(([rotulo, cents, vencida]) => (
            <div
              key={rotulo}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                bg-[var(--gs-surface)] flex flex-col gap-0.5"
            >
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                {rotulo}
              </span>
              <span
                className={`text-[length:var(--gs-text-base)] font-semibold ${
                  vencida && cents > 0 ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-purple-900)]'
                }`}
              >
                {formatCents(cents)}
              </span>
            </div>
          ))}
        </div>
      )}

      {criando && (
        <div className="mb-5">
          <NovaContaCard
            direction={direction}
            categorias={categorias}
            centros={centros}
            onCancelar={() => setCriando(false)}
            onCriada={async () => {
              setCriando(false);
              setAviso('Lançamento criado.');
              await carregar();
            }}
          />
        </div>
      )}

      {aberta && (
        <div className="mb-5">
          <DetalheCard
            entry={aberta}
            receber={receber}
            podeCobrar={podeCobrar}
            onFechar={() => setAberta(null)}
            onMudou={async (atualizada, mensagem) => {
              setAberta(atualizada);
              setAviso(mensagem);
              await carregar();
            }}
            onCobrou={async (mensagem) => {
              setAviso(mensagem);
              await carregar();
            }}
          />
        </div>
      )}

      <Card title="Lançamentos" subtitle="Ordenados pelo que vence primeiro.">
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="flex-1">
            <SearchInput
              value={busca}
              onChange={setBusca}
              placeholder={receber ? 'Descrição ou cliente…' : 'Descrição ou fornecedor…'}
            />
          </div>
          <select
            value={situacao}
            onChange={(e) => setSituacao(e.target.value)}
            aria-label="Filtrar por situação"
            className={CAIXA_SELECT}
          >
            {SITUACOES.map((s) => (
              <option key={s.valor} value={s.valor}>
                {s.rotulo}
              </option>
            ))}
          </select>
          {categorias.length > 0 && (
            <select
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              aria-label="Filtrar por categoria"
              className={CAIXA_SELECT}
            >
              <option value="">Todas as categorias</option>
              {/*
                O AVESSO VEM PRIMEIRO, e antes da lista, porque é o recorte que
                alguém veio buscar: é ele que a ressalva do DRE aponta. Sem esta
                opção, saber que há lançamentos sem categoria seria um número
                sem porta.
              */}
              <option value={SEM_CATEGORIA}>Sem categoria</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {centros.length > 0 && (
            <select
              value={centro}
              onChange={(e) => setCentro(e.target.value)}
              aria-label="Filtrar por centro de custo"
              className={CAIXA_SELECT}
            >
              <option value="">Todos os centros de custo</option>
              {/*
                O AVESSO VEM PRIMEIRO, e aqui ele é o recorte mais provável: o
                banco real tem zero lançamentos com centro atribuído. Quem abre
                este filtro no primeiro mês está procurando exatamente o que
                ainda falta ratear.
              */}
              <option value={SEM_CENTRO_DE_CUSTO}>Sem centro de custo</option>
              {centros.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
          >
            {error}
          </p>
        )}
        {aviso && (
          <p
            role="status"
            className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
          >
            {aviso}
          </p>
        )}

        {itens && (
          <DataTable
            rows={itens}
            keyOf={(e) => e.id}
            empty={
              <EmptyState
                title="Nada aqui"
                description={
                  situacao === 'overdue'
                    ? 'Nenhuma conta vencida — é uma boa notícia.'
                    : 'Nenhum lançamento com esse filtro.'
                }
              />
            }
            columns={[
              {
                header: 'Vencimento',
                render: (e) => (
                  <div className="flex flex-col">
                    <span className={e.overdue ? 'font-semibold text-[var(--gs-danger)]' : ''}>
                      {data(e.dueDate)}
                    </span>
                    {e.overdue && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
                        vencida
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Descrição',
                render: (e) => (
                  <div className="flex flex-col">
                    <span className="font-semibold text-[var(--gs-purple-900)]">
                      {e.description}
                      {e.installmentTotal > 1 && (
                        /*
                          O carnê se apresenta: quem olha a lista sabe que a
                          linha é uma parcela e de quantas — sem isso, três
                          irmãs de R$ 33,33 parecem três contas soltas.
                        */
                        <span
                          className="ml-2 font-normal text-[length:var(--gs-text-xs)]
                            text-[var(--gs-muted)]"
                        >
                          parcela {e.installmentNumber}/{e.installmentTotal}
                        </span>
                      )}
                    </span>
                    {e.counterpartyName && (
                      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        {e.counterpartyName}
                      </span>
                    )}
                    {e.originLabel && destinoDaOrigem(e.originType, e.originId) && (
                      /*
                        A ORIGEM É LINK, e o link abre o DOCUMENTO. `origin_id`
                        sempre esteve no banco; sem a porta na tela, conferir a
                        dívida contra a nota exigia navegar de memória e buscar
                        pelo número na mão — a metade que faltava da
                        rastreabilidade (V22). E um link que parava na LISTA
                        deixava esse "buscar pelo número na mão" de pé: o
                        destino carrega o id, e a tela de lá abre o papel.

                        Só vira link o que tem destino: porta desenhada que não
                        abre é pior que porta nenhuma.
                      */
                      <Link
                        to={destinoDaOrigem(e.originType, e.originId)!}
                        className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)]
                          underline w-fit"
                      >
                        {e.originLabel}
                      </Link>
                    )}
                  </div>
                ),
              },
              {
                /*
                  A categoria na LINHA, e não só no filtro.

                  Filtrar por um campo invisível deixa quem filtrou sem como
                  conferir se o recorte é o que pediu — e "sem categoria"
                  aparece marcado, porque é o que precisa de ação: é a linha
                  que engorda o balde anônimo do DRE.
                */
                header: 'Categoria',
                render: (e) => (
                  <div className="flex flex-col gap-0.5">
                    {e.categoryName ? (
                      <span className="text-[var(--gs-text-soft)]">{e.categoryName}</span>
                    ) : (
                      <Badge tone="warning">SEM CATEGORIA</Badge>
                    )}
                    {/*
                      O CENTRO DE CUSTO NA MESMA CÉLULA (GAP-V25).

                      Ele é a segunda classificação do mesmo lançamento — "de
                      quem é" ao lado de "para que foi" —, e aparece aqui pelo
                      mesmo motivo da categoria: o filtro novo precisa poder ser
                      conferido linha a linha. Quando ninguém usa centro de
                      custo, a linha continua com a cara de sempre: só o nome do
                      centro aparece, e a ausência dele não vira ruído.
                    */}
                    {e.costCenterName && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {e.costCenterName}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Valor',
                align: 'right',
                render: (e) => formatCents(e.amountCents),
              },
              {
                header: receber ? 'Recebido' : 'Pago',
                align: 'right',
                render: (e) => (
                  <span className="text-[var(--gs-text-soft)]">{formatCents(e.settledCents)}</span>
                ),
              },
              {
                header: 'Saldo',
                align: 'right',
                render: (e) => (
                  <span
                    className={
                      e.balanceCents > 0 ? 'font-semibold text-[var(--gs-purple-900)]' : ''
                    }
                  >
                    {formatCents(e.balanceCents)}
                  </span>
                ),
              },
              {
                header: 'Situação',
                render: (e) =>
                  e.balanceCents <= 0 ? (
                    <Badge tone="success">{receber ? 'RECEBIDA' : 'PAGA'}</Badge>
                  ) : e.overdue ? (
                    <Badge tone="danger">VENCIDA</Badge>
                  ) : e.settledCents > 0 ? (
                    <Badge tone="warning">PARCIAL</Badge>
                  ) : (
                    <Badge tone="neutral">EM ABERTO</Badge>
                  ),
              },
              {
                header: 'Ações',
                align: 'right',
                render: (e) => (
                  <Button size="sm" variant="ghost" onClick={() => setAberta(e)}>
                    Detalhes
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/*
        AS COBRANÇAS ONLINE, e por que elas moram AQUI.

        Status, `last_error` e tentativas de `core_payment_intents` eram
        gravados e não apareciam em tela nenhuma: o gestor só descobria a
        cobrança quebrada pela reclamação de quem ia pagar ou pela divergência
        da conciliação, sempre tarde. A lista fica do lado de RECEBER porque é
        aqui que a cobrança nasce e é aqui que a pessoa está quando pergunta
        "e o boleto que mandei ontem?".
      */}
      {receber && <CobrancasCard podeCobrar={podeCobrar} podeEstornar={podeEstornar} />}

      {/*
        A FILA DOS PIX PENDENTES DO BALCÃO (GAP-PRD-077). A linha pendente da
        venda era um beco que nenhuma tela mostrava. Mora aqui, do lado de
        receber, para a gerência — é quem cobra o que não caiu.
      */}
      {receber && podeEstornar && <PixPendentesDoBalcaoCard />}
    </AppShell>
  );
}

/**
 * O painel de status das cobranças (GAP-V75).
 *
 * Só ações REAIS: re-tentar existe porque a rota existe e é idempotente, e
 * CANCELAR passou a existir porque a rota do título passou a existir. Até esta
 * rodada a ausência estava declarada aqui — "não há rota para isso no título" —
 * e o PIX/boleto de um título que perdeu a razão de ser continuava vivo no
 * provedor, com o cliente ainda podendo pagá-lo. Cobrança de PEDIDO continua
 * sem botão daqui, e a razão está em `podeCancelarNoProvedor`.
 */
function CobrancasCard({ podeCobrar, podeEstornar }: { podeCobrar: boolean; podeEstornar: boolean }) {
  const [itens, setItens] = useState<PaymentIntentView[] | null>(null);
  const [status, setStatus] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupada, setOcupada] = useState<string | null>(null);
  /** A cobrança cujo estorno está sendo confirmado — o painel abre sob a lista. */
  const [estornando, setEstornando] = useState<PaymentIntentView | null>(null);
  const [desfazerBaixa, setDesfazerBaixa] = useState(true);
  const [motivo, setMotivo] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setItens(await coreApi.listPaymentIntents({ status: status || undefined }));
    } catch (err) {
      setItens(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as cobranças.');
    }
  }, [status]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const retentar = useCallback(
    async (intentId: string) => {
      setOcupada(intentId);
      setErro(null);
      setAviso(null);
      try {
        const r = await coreApi.retryPaymentIntent(intentId);
        setAviso(
          r.status === 'pending'
            ? 'Cobrança gerada no provedor.'
            : `A nova tentativa terminou em "${r.status}".`,
        );
        await carregar();
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao tentar de novo.');
      } finally {
        setOcupada(null);
      }
    },
    [carregar],
  );

  /**
   * CANCELAR A COBRANÇA NO PROVEDOR — o gesto que faltava (defeito v13-3).
   *
   * O servidor é quem decide o que morre: aqui a resposta é REPETIDA como veio.
   * "Nenhuma cobrança viva para cancelar" e "o provedor recusou" são fatos
   * diferentes, e dizer "cancelada" nos dois casos ensinaria a não confiar na
   * tela — que é a mesma tela onde alguém decide parar de perseguir a cobrança.
   */
  const cancelar = useCallback(
    async (intent: PaymentIntentView) => {
      setOcupada(intent.id);
      setErro(null);
      setAviso(null);
      try {
        const r = await coreApi.cancelFinanceEntryCharges(intent.originId);
        setAviso(
          r.failed > 0
            ? `O provedor não derrubou ${r.failed} cobrança(s). Elas continuam vivas — tente de novo.`
            : r.cancelled > 0
              ? `${r.cancelled} cobrança(s) cancelada(s) no provedor.`
              : 'Não havia cobrança viva para cancelar neste título.',
        );
        await carregar();
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao cancelar a cobrança.');
      } finally {
        setOcupada(null);
      }
    },
    [carregar],
  );

  /**
   * ESTORNAR (GAP-PRD-092). A pergunta "desfazer também a baixa?" é a
   * confirmação que o servidor exige: estornar receita mexe em competência, e
   * quem decide é quem clica. A resposta é repetida como veio — "o provedor
   * recusou" e "a baixa continua de pé" são fatos diferentes.
   */
  const estornar = useCallback(async () => {
    if (!estornando) return;
    setOcupada(estornando.id);
    setErro(null);
    setAviso(null);
    try {
      const r = await cobrancasApi.estornarCobrancaDoTitulo(estornando.originId, {
        desfazerBaixa,
        motivo: motivo.trim() || undefined,
      });
      setAviso(r.detail);
      setEstornando(null);
      setMotivo('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao estornar a cobrança.');
    } finally {
      setOcupada(null);
    }
  }, [estornando, desfazerBaixa, motivo, carregar]);

  return (
    <Card
      title="Cobranças online"
      subtitle="O que foi gerado no provedor, o que falhou e o que já foi pago."
    >
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filtrar cobranças por situação"
          className={CAIXA_SELECT}
        >
          <option value="">Todas as situações</option>
          {SITUACOES_DA_COBRANCA.map(([valor, apresentacao]) => (
            <option key={valor} value={valor}>
              {apresentacao.filtro}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={() => void carregar()}>
          Atualizar
        </Button>
      </div>

      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}
      {aviso && (
        <p
          role="status"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
        >
          {aviso}
        </p>
      )}

      {itens && (
        <DataTable
          rows={itens}
          keyOf={(i) => i.id}
          empty={
            <EmptyState
              title="Nenhuma cobrança"
              description="Cobranças aparecem aqui assim que um título ou pedido for cobrado pelo provedor."
            />
          }
          columns={[
            {
              header: 'Origem',
              render: (i) => (
                <div className="flex flex-col">
                  <span className="font-semibold text-[var(--gs-purple-900)]">
                    {i.originLabel ?? '—'}
                  </span>
                  <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    {i.originType === 'finance_entry' ? 'Título' : 'Pedido online'}
                    {' · '}
                    {MEIO_DA_COBRANCA[i.method] ?? i.method}
                    {(i.installmentCount ?? 1) > 1 ? ` em ${i.installmentCount}x` : ''}
                    {' · '}
                    {i.environment}
                  </span>
                </div>
              ),
            },
            {
              header: 'Valor',
              align: 'right',
              render: (i) => formatCents(i.amountCents),
            },
            {
              header: 'Situação',
              render: (i) => {
                const s = situacaoDaCobranca(i.status);
                return <Badge tone={s.tom}>{s.rotulo}</Badge>;
              },
            },
            {
              header: 'Último erro',
              render: (i) =>
                i.lastError ? (
                  // O erro INTEIRO, não truncado: "HTTP 500" e "cliente sem
                  // CPF" pedem ações diferentes, e cortar a frase esconde
                  // justamente a parte que diz qual das duas é.
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                    {i.lastError}
                  </span>
                ) : (
                  <span className="text-[var(--gs-muted)]">—</span>
                ),
            },
            {
              header: 'Tentativas',
              align: 'right',
              render: (i) => <span className="text-[var(--gs-text-soft)]">{i.attempts}</span>,
            },
            {
              header: 'Ações',
              align: 'right',
              render: (i) => (
                <div className="flex gap-2 justify-end">
                  {i.invoiceUrl && (
                    <a
                      href={i.invoiceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)] underline"
                    >
                      Fatura
                    </a>
                  )}
                  {podeCobrar && podeRetentar(i.status, i.providerRef) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={ocupada === i.id}
                      onClick={() => void retentar(i.id)}
                    >
                      Tentar de novo
                    </Button>
                  )}
                  {podeCobrar && podeCancelarNoProvedor(i.originType, i.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={ocupada === i.id}
                      onClick={() => void cancelar(i)}
                    >
                      Cancelar cobrança
                    </Button>
                  )}
                  {podeEstornar && podeEstornarCobranca(i) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEstornando(i);
                        setDesfazerBaixa(true);
                        setMotivo('');
                      }}
                    >
                      {i.status === 'refunded' ? 'Desfazer a baixa' : 'Estornar cobrança'}
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}

      {estornando && (
        <section
          aria-label="Confirmar estorno da cobrança"
          className="mt-4 px-4 py-4 rounded-[var(--gs-radius)] border border-[var(--gs-border)] flex flex-col gap-3"
        >
          <h3 className="m-0 text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)]">
            {estornando.status === 'refunded' ? 'Desfazer a baixa do estorno' : 'Estornar a cobrança'}
            {' · '}
            {estornando.originLabel ?? 'Título'} · {formatCents(estornando.amountCents)}
          </h3>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            {estornando.status === 'refunded'
              ? 'O dinheiro desta cobrança já voltou ao cliente pelo provedor. Falta desfazer a baixa que ela deixou no título.'
              : 'O provedor devolve o valor ao cliente pelo mesmo meio do pagamento. Isso não se desfaz daqui.'}
          </p>
          <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
            <input
              type="checkbox"
              checked={desfazerBaixa}
              onChange={(e) => setDesfazerBaixa(e.target.checked)}
            />
            Desfazer também a baixa do título (ele volta a ficar em aberto, com a contrapartida no histórico)
          </label>
          <Field label="Motivo (vai para o histórico da baixa)">
            {(props) => (
              <Input
                {...props}
                value={motivo}
                maxLength={200}
                onChange={(e) => setMotivo(e.target.value)}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button loading={ocupada === estornando.id} onClick={() => void estornar()}>
              {estornando.status === 'refunded' ? 'Desfazer a baixa' : 'Confirmar estorno'}
            </Button>
            <Button variant="ghost" onClick={() => setEstornando(null)}>
              Voltar
            </Button>
          </div>
        </section>
      )}
    </Card>
  );
}

/**
 * Detalhe: dar baixa e ver o histórico.
 *
 * O histórico mostra as baixas ESTORNADAS também, riscadas. Sumir com elas
 * faria o extrato do mês fechar diferente do que fechou no dia — e é
 * justamente o estorno que alguém vai querer entender depois.
 */
function DetalheCard({
  entry,
  receber,
  podeCobrar,
  onFechar,
  onMudou,
  onCobrou,
}: {
  entry: FinanceEntry;
  receber: boolean;
  podeCobrar: boolean;
  onFechar: () => void;
  onMudou: (atualizada: FinanceEntry, mensagem: string) => Promise<void>;
  /** Cobrar pode ter PARTIDO o título em parcelas — a lista precisa reler. */
  onCobrou: (mensagem: string) => Promise<void>;
}) {
  const [settlements, setSettlements] = useState<FinanceSettlement[]>([]);
  const [valor, setValor] = useState('');
  const [metodo, setMetodo] = useState('dinheiro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // O campo já vem com o saldo: o caso comum é quitar de uma vez.
    setValor((entry.balanceCents / 100).toFixed(2).replace('.', ','));
    void coreApi
      .listSettlements(entry.id)
      .then(setSettlements)
      .catch(() => setSettlements([]));
  }, [entry.id, entry.balanceCents]);

  /*
    A CHAVE DO PEDIDO DE BAIXA (GAP-PRD-173).

    Nasce no primeiro clique e é REUSADA enquanto o pedido for o mesmo (mesmo
    título, valor e forma): se a resposta se perdeu na rede e a pessoa clica de
    novo, o servidor reconhece o reenvio e devolve a baixa já feita em vez de
    gravar outra. Depois de uma baixa bem-sucedida a chave morre — a próxima
    baixa parcial do mesmo título é um pedido novo, com chave nova.

    O `emVoo` fecha a janela do clique duplo antes de o React redesenhar o
    botão como ocupado.
  */
  const pedidoDaBaixa = useRef<{ assinatura: string; chave: string } | null>(null);
  const emVoo = useRef(false);

  const baixar = useCallback(async () => {
    const centavos = paraCentavos(valor);
    if (!Number.isFinite(centavos) || centavos <= 0) {
      setError('Informe um valor maior que zero.');
      return;
    }
    if (emVoo.current) return;
    const assinatura = `${entry.id}|${centavos}|${metodo}`;
    if (pedidoDaBaixa.current?.assinatura !== assinatura) {
      pedidoDaBaixa.current = { assinatura, chave: `baixa-${uuid()}` };
    }
    emVoo.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await coreApi.settleEntry(
        entry.id,
        centavos,
        metodo,
        undefined,
        pedidoDaBaixa.current.chave,
      );
      pedidoDaBaixa.current = null;
      setSettlements(r.settlements);
      await onMudou(
        r.entry,
        r.entry.balanceCents > 0
          ? `Baixa parcial registrada. Saldo de ${formatCents(r.entry.balanceCents)}.`
          : receber
            ? 'Conta recebida.'
            : 'Conta paga.',
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao dar baixa.');
    } finally {
      emVoo.current = false;
      setBusy(false);
    }
  }, [valor, metodo, entry.id, receber, onMudou]);

  const estornar = useCallback(
    async (settlementId: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await coreApi.reverseSettlement(settlementId);
        setSettlements(r.settlements);
        await onMudou(r.entry, 'Baixa estornada. O histórico foi preservado.');
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao estornar.');
      } finally {
        setBusy(false);
      }
    },
    [onMudou],
  );

  return (
    <Card
      title={entry.description}
      subtitle={`${formatCents(entry.amountCents)} · vence ${data(entry.dueDate)}${
        entry.counterpartyName ? ` · ${entry.counterpartyName}` : ''
      }`}
    >
      <div className="flex flex-col gap-5">
        {entry.balanceCents > 0 ? (
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1">
              <Field
                label={receber ? 'Valor a receber' : 'Valor a pagar'}
                hint={`Saldo devedor: ${formatCents(entry.balanceCents)}. Pode ser parcial.`}
              >
                {(props) => (
                  <Input
                    {...props}
                    value={valor}
                    onChange={(e) => setValor(e.target.value)}
                    inputMode="decimal"
                  />
                )}
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Forma">
                {(props) => (
                  <select
                    {...props}
                    value={metodo}
                    onChange={(e) => setMetodo(e.target.value)}
                    className="h-11 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                      bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
                  >
                    <option value="dinheiro">Dinheiro</option>
                    <option value="pix">PIX</option>
                    <option value="debito">Débito</option>
                    <option value="credito">Crédito</option>
                    <option value="boleto">Boleto</option>
                    <option value="transferencia">Transferência</option>
                  </select>
                )}
              </Field>
            </div>
            <Button loading={busy} onClick={() => void baixar()}>
              {receber ? 'Registrar recebimento' : 'Registrar pagamento'}
            </Button>
          </div>
        ) : (
          <p className="text-[length:var(--gs-text-base)] text-[var(--gs-success)] font-semibold m-0">
            {receber ? 'Conta totalmente recebida.' : 'Conta totalmente paga.'}
          </p>
        )}

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        {receber && (
          <CobrarNoProvedor
            entry={entry}
            podeCobrar={podeCobrar}
            onCobrou={onCobrou}
          />
        )}

        <div>
          <h3 className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)] m-0 mb-2">
            Histórico
          </h3>
          {settlements.length === 0 ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              Nenhuma baixa registrada.
            </p>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-2">
              {settlements.map((s) => {
                const estorno = Boolean(s.reversesId);
                return (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-2 border-b border-[var(--gs-border)]"
                  >
                    <div className="flex flex-col">
                      <span
                        className={`font-semibold ${
                          estorno
                            ? 'text-[var(--gs-danger)]'
                            : s.reversedAt
                              ? 'line-through text-[var(--gs-muted)]'
                              : 'text-[var(--gs-purple-900)]'
                        }`}
                      >
                        {formatCents(s.amountCents)}
                        {estorno && ' (estorno)'}
                      </span>
                      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        {new Date(s.settledAt).toLocaleString('pt-BR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                        {s.method ? ` · ${s.method}` : ''}
                        {s.reversedAt && !estorno ? ' · estornada' : ''}
                      </span>
                    </div>
                    {!estorno && !s.reversedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy}
                        onClick={() => void estornar(s.id)}
                      >
                        Estornar
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <Button variant="ghost" onClick={onFechar}>
            Fechar
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * COBRAR VIA ASAAS — o botão que faltava (GAP-V70).
 *
 * O título do contas a receber vira PIX, boleto ou link de cartão na conta DA
 * OPERAÇÃO, e o webhook baixa o título sozinho quando o dinheiro entra. Até
 * aqui a cobrança só nascia do checkout da loja online: cobrar aluguel, OS da
 * oficina ou venda a prazo exigia sair do sistema, gerar no portal do provedor
 * e dar baixa à mão — com a conciliação acusando divergência no fim do mês.
 *
 * ## O que a tela mostra, e o que ela NÃO promete
 *
 * GERAR NÃO É RECEBER: a cobrança nasce "aguardando pagamento" e o título
 * continua em aberto. Quem baixa é o webhook, e só com o valor conferido.
 *
 * SEM CREDENCIAL, o servidor recusa com uma frase que diz o que fazer, e a
 * tela a repete inteira — é o estado real das operações hoje. Inventar um
 * "gerando..." que nunca termina seria a versão bonita da mesma mentira.
 */
function CobrarNoProvedor({
  entry,
  podeCobrar,
  onCobrou,
}: {
  entry: FinanceEntry;
  podeCobrar: boolean;
  onCobrou: (mensagem: string) => Promise<void>;
}) {
  const [metodo, setMetodo] = useState<'pix' | 'boleto' | 'cartao'>('pix');
  const [parcelas, setParcelas] = useState('1');
  const [cobranca, setCobranca] = useState<FinanceCharge | null>(null);
  const [existentes, setExistentes] = useState<PaymentIntentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const recarregar = useCallback(async () => {
    try {
      setExistentes(await coreApi.financeEntryCharges(entry.id));
    } catch {
      // Lista auxiliar indisponível não pode impedir a cobrança nem a baixa.
      setExistentes([]);
    }
  }, [entry.id]);

  useEffect(() => {
    setCobranca(null);
    setErro(null);
    void recarregar();
  }, [recarregar]);

  const cobrar = useCallback(async () => {
    const n = Number(parcelas || '1');
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      setErro('Informe um número de parcelas entre 1 e 60.');
      return;
    }
    setBusy(true);
    setErro(null);
    try {
      const r = await coreApi.chargeFinanceEntry(entry.id, {
        method: metodo,
        installmentCount: n > 1 ? n : null,
      });
      setCobranca(r);
      await recarregar();
      await onCobrou(
        r.status === 'failed'
          ? 'O provedor não aceitou a cobrança agora. Ela ficou registrada para nova tentativa.'
          : n > 1
            ? `Cobrança criada em ${n} parcelas. O título virou carnê.`
            : 'Cobrança criada. O título será baixado quando o pagamento entrar.',
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gerar a cobrança.');
    } finally {
      setBusy(false);
    }
  }, [entry.id, metodo, parcelas, onCobrou, recarregar]);

  const jaCobrado = existentes.some((i) => i.provider_ref);

  return (
    <div className="border-t border-[var(--gs-border)] pt-4">
      <h3 className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)] m-0 mb-2">
        Cobrança online
      </h3>

      {entry.balanceCents <= 0 ? (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          Título quitado: não há o que cobrar.
        </p>
      ) : podeCobrar ? (
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end mb-3">
          <div className="flex-1">
            <Field label="Meio de cobrança">
              {(props) => (
                <select
                  {...props}
                  value={metodo}
                  onChange={(e) => setMetodo(e.target.value as 'pix' | 'boleto' | 'cartao')}
                  className={`w-full ${CAIXA_SELECT} h-11`}
                >
                  <option value="pix">PIX (copia e cola)</option>
                  <option value="boleto">Boleto</option>
                  <option value="cartao">Cartão (link do provedor)</option>
                </select>
              )}
            </Field>
          </div>
          <div className="flex-1">
            <Field
              label="Parcelar em"
              hint="Cada parcela vira um título com o seu vencimento e a sua cobrança."
            >
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={parcelas}
                  onChange={(e) => setParcelas(e.target.value)}
                  disabled={entry.installmentTotal > 1 || entry.settledCents > 0}
                />
              )}
            </Field>
          </div>
          <Button loading={busy} onClick={() => void cobrar()}>
            {jaCobrado ? 'Ver cobrança' : 'Cobrar via Asaas'}
          </Button>
        </div>
      ) : (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 mb-3">
          Gerar cobrança no provedor é da gerência e do caixa. A situação das
          cobranças deste título continua visível abaixo.
        </p>
      )}

      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      {cobranca && (
        <div
          className="px-3 py-3 mb-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
            bg-[var(--gs-surface-soft,var(--gs-surface))] flex flex-col gap-2"
        >
          {/*
            O QUE O CLIENTE PRECISA RECEBER. Copia-e-cola do PIX, linha
            digitável do boleto ou a página do provedor para o cartão — o
            número do cartão nunca passa por aqui.
          */}
          {cobranca.pixPayload && (
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                PIX copia e cola
              </span>
              <textarea
                readOnly
                value={cobranca.pixPayload}
                rows={2}
                className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                  bg-[var(--gs-surface)] text-[length:var(--gs-text-sm)] text-[var(--gs-text)]"
              />
            </label>
          )}
          {cobranca.pixImageBase64 && (
            <img
              src={`data:image/png;base64,${cobranca.pixImageBase64}`}
              alt="QR Code do PIX da cobrança"
              className="w-40 h-40 self-start"
            />
          )}
          {cobranca.identificationField && (
            <p className="m-0 text-[length:var(--gs-text-sm)]">
              <span className="text-[var(--gs-muted)]">Linha digitável: </span>
              <span className="font-mono">{cobranca.identificationField}</span>
            </p>
          )}
          {cobranca.invoiceUrl && (
            <a
              href={cobranca.invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-700)] underline w-fit"
            >
              Abrir a fatura no provedor
            </a>
          )}
          {cobranca.installments.length > 1 && (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {cobranca.installments.length} parcelas geradas:{' '}
              {cobranca.installments
                .map((p) => `${p.number}/${p.total} ${formatCents(p.amountCents)}`)
                .join(' · ')}
            </p>
          )}
          <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Mostrar a cobrança não é receber: o título só é baixado quando o
            provedor confirmar o pagamento, com o valor conferido.
          </p>
        </div>
      )}

      {existentes.length > 0 && (
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {existentes.map((i) => {
            const s = situacaoDaCobranca(i.status);
            return (
              <li
                key={i.id}
                className="flex items-center justify-between gap-3 py-2 border-b border-[var(--gs-border)]"
              >
                <div className="flex flex-col">
                  <span className="font-semibold text-[var(--gs-purple-900)]">
                    {MEIO_DA_COBRANCA[i.method] ?? i.method} · {formatCents(i.amount_cents)}
                  </span>
                  {i.last_error && (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                      {i.last_error}
                    </span>
                  )}
                </div>
                <Badge tone={s.tom}>{s.rotulo}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Lançamento avulso: a conta que não nasce de uma venda.
 *
 * ## Os três campos novos, e o que cada um faz no relatório
 *
 * CATEGORIA decide em que LINHA do DRE o lançamento aparece. Sem ela, tudo que
 * se lança à mão cai no balde "Sem categoria" — o relatório fecha certo no
 * total e não explica nada.
 *
 * COMPETÊNCIA decide em que MÊS ele conta. Em branco, o servidor cai para o
 * vencimento e, na falta dele, para a data do lançamento — a escada existe
 * para que nenhum lançamento desapareça do relatório por esquecimento, e é
 * justamente por isso que o campo é opcional aqui: quem não sabe a competência
 * não deve ser obrigado a inventá-la.
 *
 * CONTA move o SALDO que aparece em Financeiro › Cadastros › Contas, à medida
 * que a conta for sendo baixada. Não é enfeite e não é o DRE — é a outra
 * pergunta: onde o dinheiro está.
 *
 * ## Por que a conta bancária só aparece para quem a lista responde
 *
 * A única rota que lista contas bancárias é `/core/finance/setup`, que exige
 * gerente porque devolve o saldo de todas elas. Este formulário só existe para
 * gerente — `POST /core/finance/entries` exige o mesmo perfil —, então os dois
 * conjuntos são o mesmo, e o seletor nunca aparece para quem receberia 403.
 * Se a chamada falhar por qualquer outro motivo, o campo some e o lançamento
 * continua possível: uma lista auxiliar indisponível não pode impedir o
 * registro de uma conta a pagar.
 */
function NovaContaCard({
  direction,
  categorias,
  centros,
  onCancelar,
  onCriada,
}: {
  direction: 'in' | 'out';
  /** Já carregadas pela tela, no lado certo — uma busca só para filtro e formulário. */
  categorias: FinanceCategory[];
  /**
   * Os centros de custo ativos (GAP-V25).
   *
   * O campo nasce no formulário JUNTO com o leitor, e não antes dele: pedir
   * uma classificação que nenhum relatório responde é fabricar trabalho que
   * ninguém confere — e campo que ninguém confere acaba preenchido de qualquer
   * jeito, e aí passa a mentir. Agora há filtro na lista e recorte no DRE.
   */
  centros: { id: string; code: string; name: string }[];
  onCancelar: () => void;
  onCriada: () => Promise<void>;
}) {
  const [description, setDescription] = useState('');
  const [valor, setValor] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [parcelas, setParcelas] = useState('1');
  const [categoryId, setCategoryId] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [competenceDate, setCompetenceDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [contas, setContas] = useState<FinanceAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void coreApi
      .financeSetup()
      .then((r) => {
        if (vivo) setContas(r.accounts.filter((c) => c.active === 1));
      })
      .catch(() => {
        if (vivo) setContas([]);
      });
    return () => {
      vivo = false;
    };
  }, []);

  const salvar = useCallback(async () => {
    const centavos = paraCentavos(valor);
    if (!description.trim()) {
      setError('Descreva o lançamento.');
      return;
    }
    if (!Number.isFinite(centavos) || centavos <= 0) {
      setError('Informe um valor maior que zero.');
      return;
    }
    /*
      O CARNÊ PRECISA DE CALENDÁRIO. O servidor recusa parcelar sem o
      primeiro vencimento (400) — mas deixar a pessoa preencher o formulário
      inteiro para descobrir isso no fim seria a versão educada do mesmo
      defeito. A regra é dita aqui, antes de viajar, com a mesma mensagem.
    */
    const numParcelas = Number(parcelas || '1');
    if (!Number.isInteger(numParcelas) || numParcelas < 1 || numParcelas > 60) {
      setError('Informe um número de parcelas entre 1 e 60.');
      return;
    }
    if (numParcelas > 1 && !dueDate) {
      setError('Informe o primeiro vencimento para parcelar.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      /*
        OS QUATRO CAMPOS OPCIONAIS VÃO COMO NULO QUANDO VAZIOS, e não como
        texto vazio.

        `''` é um id que não existe, e o servidor o trataria como categoria
        inexistente (404) em vez de "não classificado". Nulo é a ausência que
        a coluna aceita.
      */
      await coreApi.createFinanceEntry({
        direction,
        description,
        // O TOTAL viaja inteiro: quem divide em centavos exatos (resto na
        // primeira parcela) é o servidor. Dividir aqui criaria uma segunda
        // aritmética para divergir da primeira.
        amountCents: centavos,
        dueDate: dueDate || null,
        categoryId: categoryId || null,
        // O centro de custo SAI DA TELA agora (GAP-V25). A rota e o serviço já
        // o gravavam; só a API tinha como preenchê-lo.
        costCenterId: costCenterId || null,
        competenceDate: competenceDate || null,
        accountId: accountId || null,
        installments: numParcelas,
      });
      await onCriada();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao lançar.');
    } finally {
      setBusy(false);
    }
  }, [
    description,
    valor,
    dueDate,
    parcelas,
    categoryId,
    costCenterId,
    competenceDate,
    accountId,
    direction,
    onCriada,
  ]);

  return (
    <Card
      title={direction === 'in' ? 'Nova conta a receber' : 'Nova conta a pagar'}
      subtitle="Para o que não nasce de uma venda: aluguel, energia, nota avulsa."
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Field label="Descrição" required>
            {(props) => (
              <Input
                {...props}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <Field label="Valor" required>
            {(props) => (
              <Input
                {...props}
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                inputMode="decimal"
                placeholder="0,00"
              />
            )}
          </Field>
          <Field label="Vencimento" hint="Em branco = à vista. Parcelando, é o da 1ª parcela.">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Parcelar em"
            hint="O carnê: N parcelas mensais. O total é dividido em centavos exatos; o resto vai na 1ª."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={60}
                step={1}
                value={parcelas}
                onChange={(e) => setParcelas(e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field
            label="Categoria"
            hint={
              direction === 'in'
                ? 'A linha em que esta receita aparece no DRE. Em branco cai em "Sem categoria".'
                : 'A linha em que esta despesa aparece no DRE. Em branco cai em "Sem categoria".'
            }
          >
            {(props) => (
              <select
                {...props}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className={`w-full ${CAIXA_SELECT} h-11`}
              >
                <option value="">Sem categoria</option>
                {categorias.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            label="Competência"
            hint="O mês em que o fato conta no resultado. Em branco, usa o vencimento."
          >
            {(props) => (
              <Input
                {...props}
                type="date"
                value={competenceDate}
                onChange={(e) => setCompetenceDate(e.target.value)}
              />
            )}
          </Field>

          {centros.length > 0 && (
            <Field
              label="Centro de custo"
              hint="De quem é o gasto. Aparece no recorte por centro, no DRE."
            >
              {(props) => (
                <select
                  {...props}
                  value={costCenterId}
                  onChange={(e) => setCostCenterId(e.target.value)}
                  className={`w-full ${CAIXA_SELECT} h-11`}
                >
                  <option value="">Sem centro de custo</option>
                  {centros.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          {contas.length > 0 ? (
            <Field
              label="Conta"
              hint="Onde o dinheiro entra ou sai. Move o saldo em Financeiro › Cadastros."
            >
              {(props) => (
                <select
                  {...props}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className={`w-full ${CAIXA_SELECT} h-11`}
                >
                  <option value="">Não informar</option>
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <div />
          )}
        </div>

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <Button loading={busy} onClick={() => void salvar()}>
            Lançar
          </Button>
          <Button variant="ghost" onClick={onCancelar}>
            Cancelar
          </Button>
        </div>
      </div>
    </Card>
  );
}
