/**
 * Telas operacionais conectadas ao núcleo: produtos, estoque, clientes,
 * caixa, vendas e financeiro.
 *
 * Todas seguem o mesmo esqueleto — cabeçalho, filtro, card com tabela e
 * estado vazio — para que a navegação entre módulos seja previsível.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from '@/components/gs/ui';
import { formatCents, formatQuantity, parseReaisToCents } from '@/components/gs/format';
// O MESMO bloco financeiro das fichas de nota de entrada e de pedido de
// compra. Ele não consulta nada — recebe a lista pronta —, então serve à ficha
// da venda sem custar uma segunda pergunta.
import { TitulosDoDocumento } from '@/components/gs/TitulosDoDocumento';
/*
  O MESMO diálogo do desconto do PDV e do cancelamento de venda — e é de
  propósito que seja o mesmo componente. Quem digita a senha de gestor no
  balcão vê exatamente esta caixa; uma segunda com outro texto ensinaria que
  existem duas "autorizações" no sistema. Existe uma.
*/
import { AutorizacaoGerenteDialog } from '@/components/gs/PagamentoDialog';
import { ConferenciaDeReservas } from '@/components/gs/ConferenciaDeReservas';
import { DireitosDoTitular } from '@/components/gs/DireitosDoTitular';
import {
  AvisoGavetaDeOutroDia,
  EscolhaDoCaixa,
  ImprimirFechamento,
  LinhaDoCaixa,
  TETO_FUNDO_DE_TROCO_CENTS,
} from '@/components/gs/CaixaDoComputador';
import { GavetasAbertasCard } from '@/components/gs/GavetasAbertas';
import { PendenciasDoFechamento } from '@/components/gs/PendenciasDoFechamento';
import { cienciaCompleta, pendenciasDoErro } from '@/lib/pendenciasDoFechamento';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { ApiRequestError, envelope, exigirCampos } from '@/lib/api/client';
// A fila das vendas guardadas offline: a tela de Caixa não fecha a gaveta com
// venda dela ainda neste computador (H-caixa-seguranca-M02).
import { subscribeQueue, type QueuedRequest } from '@/lib/api/offlineQueue';
import { caixaDesteComputador, guardarCaixaDesteComputador } from '@/lib/api/terminais';
import { dataBR, dataHoraBR } from '@/lib/datas';
// A MESMA ponte de impressão do PDV: o servidor decide o transporte (agente do
// caixa ou navegador) e a tela diz por onde o papel saiu.
import { printDocument } from '@/lib/print';
import { PARAM_DA_VENDA } from '@/lib/rotasDeOrigem';
import { Paginacao } from '@/components/gs/Paginacao';
import { paginaDeClientes, paginaDeProdutos, paginaDeVendas } from '@/lib/api/paginas';
import {
  coreApi,
  type CaixaDoComputador,
  type PendenciasEletronicas,
  type CashSession,
  type Customer,
  type CustomerCreditStatement,
  // O MESMO tipo que `ContasPage` e `TitulosDoDocumento` leem. A tela de
  // Lançamentos declarava um terceiro, em snake_case, e por isso mostrava
  // "R$ NaN" na coluna do dinheiro.
  type FinanceEntry,
  type EmissaoDaNotaDeDevolucao,
  type FiscalSaleStatus,
  type Product,
  type Sale,
  type SaleDetail,
  type SaleRemovedItem,
  type StockItem,
  type TabelaDePreco,
  type TurnoDeCaixa,
} from '@/lib/api/core';
import { useCan } from '@/hooks/useCan';
import { FormularioDoDestinatario } from '@/components/gs/DestinatarioDaNota';
import {
  avisoDoDifal,
  destinatarioCompleto,
  destinatarioParaEnvio,
  rascunhoDoDestinatario,
} from '@/lib/destinatarioDaNota';

/** Estado de carregamento/erro compartilhado pelas listagens. */
function useLoader<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /*
    SÓ A RESPOSTA MAIS RECENTE VALE (A-produto-23).

    A busca de Produtos recarrega a cada tecla, e cada recarga aplicava a
    resposta que chegasse — na ordem em que chegassem. Digitando "perfume"
    rápido, a resposta de "per" (mais lenta, mais linhas) podia chegar DEPOIS
    da de "perfume": a tabela e o "mostrando 1–100 de N" descreviam "per"
    enquanto o campo dizia "perfume". Cada recarga ganha um número; a que não é
    a última descarta o que recebeu.
  */
  const ultimaPergunta = useRef(0);

  const reload = useCallback(async () => {
    const minha = ++ultimaPergunta.current;
    setLoading(true);
    setError(null);
    try {
      const resposta = await loader();
      if (minha === ultimaPergunta.current) setData(resposta);
    } catch (err) {
      if (minha === ultimaPergunta.current) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os dados.');
      }
    } finally {
      if (minha === ultimaPergunta.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

function Feedback({ error, loading }: { error: string | null; loading: boolean }): ReactNode {
  if (error) {
    return (
      <div
        role="alert"
        className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
      >
        {error}
      </div>
    );
  }
  if (loading) {
    return (
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mb-3" role="status">
        Carregando…
      </p>
    );
  }
  return null;
}

// ------------------------------------------------------------------ produtos

/** Linhas por página do cadastro — o padrão que o servidor sempre usou. */
const PRODUTOS_POR_PAGINA = 100;

export function ProdutosPage() {
  /*
    O QUE ESTÁ NO CAMPO e O QUE FOI PERGUNTADO são dois estados (A-produto-23).

    A busca perguntava ao servidor a cada tecla: "perfume" eram sete consultas,
    e a resposta de uma letra antiga podia chegar por último. Agora o campo
    responde na hora, e a pergunta sai 250 ms depois da última tecla — uma por
    palavra digitada, não uma por letra. (O `useLoader` também descarta a
    resposta que não é a mais recente.)
  */
  const [buscaDigitada, setBuscaDigitada] = useState('');
  const [search, setSearch] = useState('');
  /** Filtro de pendência de envio — desligado por padrão. */
  const [soSemEnvio, setSoSemEnvio] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', price: '', barcode: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const canEdit = useHasProfile('gerente_loja', 'estoquista');
  /*
    A PÁGINA (GAP-PRD-070). A tela desenhava os 100 primeiros como o catálogo
    inteiro — o gestor concluía que "só tem 100 produtos". Agora o rodapé diz
    "mostrando 1–100 de 1.180" e anda; mudar a busca ou o filtro volta para a
    primeira página, porque a página 4 de outra busca não existe.
  */
  const [offset, setOffset] = useState(0);
  const mudarBusca = (valor: string) => {
    setBuscaDigitada(valor);
  };
  useEffect(() => {
    if (buscaDigitada === search) return undefined;
    const espera = setTimeout(() => {
      setSearch(buscaDigitada);
      setOffset(0);
    }, 250);
    return () => clearTimeout(espera);
  }, [buscaDigitada, search]);
  const mudarFiltro = (valor: boolean) => {
    setSoSemEnvio(valor);
    setOffset(0);
  };
  /*
    INATIVO É ARQUIVADO, e o arquivado não se mistura ao catálogo vivo.

    O produto com histórico não pode ser excluído — a saída é inativar. Sem
    este filtro ele continuava na lista como qualquer outro, e o gestor não
    distinguia o que vende do que foi aposentado. Padrão: só os ativos.
  */
  const [mostrarInativos, setMostrarInativos] = useState(false);
  const mudarInativos = (valor: boolean) => {
    setMostrarInativos(valor);
    setOffset(0);
  };

  const { data, error, loading, reload } = useLoader(
    () =>
      paginaDeProdutos({
        search,
        missingShippingData: soSemEnvio,
        situacao: mostrarInativos ? 'todos' : 'ativos',
        limit: PRODUTOS_POR_PAGINA,
        offset,
      }),
    [search, soSemEnvio, mostrarInativos, offset],
  );
  const produtos = data?.items ?? null;
  const semEnvio = data?.missingShippingDataCount ?? 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    /*
      O PREÇO DO CADASTRO RÁPIDO VIRAVA ZERO (A-produto-02).

      `Number(form.price.replace(',', '.'))` trocava só a primeira vírgula:
      "1.299,90" virava "1.299.90", que é NaN, e o `|| 0` engolia — o perfume
      nascia ativo a R$ 0,00, travava no balcão e saía na etiqueta a R$ 0,00.
      "R$ 10" também. O formulário completo já usa o interpretador da casa;
      aqui ele faltava. Campo preenchido e ilegível é recusado ANTES de enviar.
    */
    const precoTexto = form.price.trim();
    const priceCents = precoTexto ? parseReaisToCents(precoTexto) : 0;
    if (priceCents === null) {
      setFormError(
        `Preço inválido: "${precoTexto}". Digite o valor em reais, como 1.299,90 ou 10,00.`,
      );
      return;
    }
    try {
      await coreApi.createProduct({
        name: form.name.trim(),
        priceCents,
        barcode: form.barcode.trim() || undefined,
      });
      setForm({ name: '', price: '', barcode: '' });
      setCreating(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar o produto.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Cadastros', 'Produtos']}
        title="Produtos"
        actions={
          canEdit && (
            <div className="flex gap-2">
              {/* O cadastro completo tem seções, foto e grade. O formulário
                  curto abaixo continua para quem só quer lançar nome e preço
                  no meio do expediente. */}
              <Button onClick={() => { window.location.href = '/sistema/produtos/novo'; }}>
                Novo produto
              </Button>
              <Button variant="ghost" onClick={() => setCreating((v) => !v)}>
                {creating ? 'Fechar' : 'Cadastro rápido'}
              </Button>
            </div>
          )
        }
      />

      {creating && (
        <Card title="Novo produto" className="mb-5">
          <form onSubmit={(e) => void submit(e)} className="grid gap-4 sm:grid-cols-3">
            <Field label="Nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Preço de venda" hint="Ex.: 129,90">
              {(p) => (
                <Input
                  {...p}
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                />
              )}
            </Field>
            <Field label="Código de barras (EAN)">
              {(p) => (
                <Input
                  {...p}
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                />
              )}
            </Field>
            <div className="sm:col-span-3 flex items-center gap-3">
              <Button type="submit">Salvar</Button>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O código interno é gerado automaticamente.
              </span>
            </div>
            {formError && (
              <p role="alert" className="sm:col-span-3 text-[var(--gs-danger)] m-0">
                {formError}
              </p>
            )}
          </form>
        </Card>
      )}

      {/* A pendência aparece ANTES da lista, e leva direto a ela filtrada.
          Um número que o gestor precisa procurar não é um aviso. */}
      {semEnvio > 0 && !soSemEnvio && (
        <button
          type="button"
          onClick={() => mudarFiltro(true)}
          className="w-full text-left mb-5 px-4 py-3 rounded-[var(--gs-radius)] cursor-pointer
            border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]"
        >
          <strong>
            {semEnvio} produto{semEnvio > 1 ? 's' : ''} publicado{semEnvio > 1 ? 's' : ''} sem dados
            de envio
          </strong>
          <span className="block text-[length:var(--gs-text-sm)]">
            Sem peso e dimensões não há cálculo de frete — esses itens só saem por retirada. Clique
            para ver a lista.
          </span>
        </button>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[240px]">
            <Field label="Buscar">
              {(p) => (
                <Input
                  {...p}
                  value={buscaDigitada}
                  onChange={(e) => mudarBusca(e.target.value)}
                  placeholder="Nome, código interno ou código de barras"
                />
              )}
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={soSemEnvio}
              onChange={(e) => mudarFiltro(e.target.checked)}
            />
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              Só os sem dados de envio ({semEnvio})
            </span>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={mostrarInativos}
              onChange={(e) => mudarInativos(e.target.checked)}
            />
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              Mostrar inativos (arquivados)
            </span>
          </label>
        </div>
      </Card>

      <Feedback error={error} loading={loading} />

      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Código', render: (r: Product) => r.internal_code },
            { header: 'Produto', render: (r: Product) => r.name },
            { header: 'Un.', render: (r: Product) => r.unit },
            {
              header: 'Saldo',
              align: 'right',
              render: (r: Product) => formatQuantity(r.stock_quantity ?? 0),
            },
            { header: 'Preço', align: 'right', render: (r: Product) => formatCents(r.price_cents) },
            {
              header: 'Situação',
              // "Inativo" sozinho não dizia o que aconteceu: é o ARQUIVADO — fora
              // da venda, da busca e da loja, com o histórico de pé.
              render: (r: Product) =>
                r.active ? (
                  <Badge tone="success">Ativo</Badge>
                ) : (
                  <Badge tone="warning">Inativo (arquivado)</Badge>
                ),
            },
            {
              header: '',
              align: 'right',
              render: (r: Product) => (
                <div className="flex gap-1 justify-end">
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        // O clone abre direto, para a pessoa ajustar o que
                        // muda. Ficar na lista faria procurar o item novo no
                        // meio de todos os outros.
                        void coreApi
                          .cloneProduct(String(r.id))
                          .then((novo) => {
                            window.location.href = `/sistema/produtos/${novo.id}`;
                          })
                          .catch((err) =>
                            setFormError(
                              err instanceof ApiRequestError ? err.message : 'Falha ao clonar.',
                            ),
                          );
                      }}
                    >
                      Clonar
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { window.location.href = `/sistema/produtos/${r.id}`; }}
                  >
                    Abrir
                  </Button>
                </div>
              ),
            },
          ]}
          rows={produtos ?? []}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title={soSemEnvio ? 'Nenhuma pendência de envio' : 'Nenhum produto cadastrado'}
              description={
                mostrarInativos
                  ? 'Cadastre o primeiro produto para começar a vender.'
                  : 'Cadastre o primeiro produto para começar a vender. Os inativos (arquivados) aparecem em "Mostrar inativos".'
              }
            />
          }
        />
        <Paginacao
          pagina={data ? { ...data, quantidade: data.items.length } : null}
          rotulo={{ singular: 'produto', plural: 'produtos' }}
          onMudar={setOffset}
          carregando={loading}
          dica="Use a busca para ir direto a um item."
        />
      </Card>
    </AppShell>
  );
}

// ------------------------------------------------------------------- estoque

export function EstoquePage() {
  const [lowOnly, setLowOnly] = useState(false);
  /*
    A BUSCA QUE FALTAVA. O parâmetro `search` de `listStock` existia e era
    usado por TRÊS outras telas (Locais, Unidades, formulário de produto) —
    só a posição, a tela principal do estoque, não o expunha: achar um produto
    era rolar a tabela inteira. O mesmo padrão vivo da tela de Produtos:
    digitar refaz a consulta.
  */
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useLoader(
    () => coreApi.listStock({ low: lowOnly, search }),
    [lowOnly, search],
  );

  /*
    O VALOR DO ESTOQUE, que não existia em superfície nenhuma. O total vem de
    `GET /core/stock/valuation` — a MESMA conta das linhas, somada no servidor
    (saldo × custo do cadastro, arredondado por item). A tela não soma as
    linhas visíveis: com filtro ou busca aplicados, o recorte da tabela não é
    a empresa, e um "total" do recorte com cara de total geral mentiria.
  */
  const { data: valor } = useLoader(() => coreApi.stockValuation(), []);

  return (
    <AppShell>
      <PageHeader breadcrumb={['Estoque', 'Posição']} title="Posição de estoque" />

      <Card className="mb-5">
        <div className="grid gap-3 sm:grid-cols-2 items-end">
          <Field label="Buscar produto">
            {(p) => (
              <Input
                {...p}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nome, código ou código de barras"
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-[length:var(--gs-text-base)] cursor-pointer pb-2">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
            Mostrar somente itens abaixo do estoque mínimo
          </label>
        </div>
        {valor && (valor.oculto || valor.totalCents === null) && (
          /*
            O CUSTO É DA GERÊNCIA NESTA EMPRESA (GAP-PRD-165) — decisão do dono,
            em Configurações › Política de gestão. A tela diz isso, em vez de
            mostrar um zero que pareceria estoque sem valor.
          */
          <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            {valor.produtosComSaldo} produto(s) com saldo · o custo e o valor do estoque são
            reservados à gerência pela política da empresa (Configurações › Política de gestão).
          </p>
        )}
        {valor && !valor.oculto && valor.totalCents !== null && (
          <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Valor total do estoque da empresa:{' '}
            <strong>{formatCents(valor.totalCents)}</strong>
            {' · '}
            {valor.produtosComSaldo} produto(s) com saldo
            {' · '}
            {/* A RÉGUA EM PALAVRAS (GAP-PRD-166): o número diz como foi feito. */}
            {valor.regua === 'custo_medio'
              ? 'calculado pelo custo médio das entradas registradas'
              : 'calculado pelo custo do cadastro (não é custo médio)'}
            {valor.regua && !valor.reguaConfirmadaPor && ' · régua ainda não confirmada pelo contador'}
            {valor.regua === 'custo_medio' && (valor.semCustoNoRazao ?? 0) > 0 &&
              ` · ${valor.semCustoNoRazao} produto(s) sem entrada com custo usam o custo do cadastro`}
          </p>
        )}
      </Card>

      {/* GAP-PRD-087: o "Reservado" da tabela ganha o porquê — e, para a
          gerência, o gesto de soltar a parte sem origem. */}
      <ConferenciaDeReservas onMudou={() => void reload()} />

      <Feedback error={error} loading={loading} />

      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Código', render: (r: StockItem) => r.internal_code },
            { header: 'Produto', render: (r: StockItem) => r.name },
            { header: 'Saldo', align: 'right', render: (r: StockItem) => formatQuantity(r.quantity) },
            {
              /*
               * RESERVADO E DISPONÍVEL, que o dado já trazia e a tela escondia.
               *
               * Saldo sozinho mente para quem está no balcão: com 3 na
               * prateleira e 3 reservados para uma pré-venda, "Saldo 3" faz
               * prometer entrega de mercadoria que já tem dono. O servidor
               * recusa a venda na hora — e aí a recusa parece defeito, porque
               * a tela dizia que tinha.
               */
              header: 'Reservado',
              align: 'right',
              render: (r: StockItem) =>
                r.reserved > 0 ? (
                  <span className="text-[var(--gs-warning)] font-semibold">
                    {formatQuantity(r.reserved)}
                  </span>
                ) : (
                  <span className="text-[var(--gs-muted)]">—</span>
                ),
            },
            {
              header: 'Disponível',
              align: 'right',
              render: (r: StockItem) => (
                <strong>{formatQuantity(Math.max(0, r.quantity - r.reserved))}</strong>
              ),
            },
            {
              header: 'Mínimo',
              align: 'right',
              render: (r: StockItem) => formatQuantity(r.min_stock),
            },
            {
              /*
               * Saldo × custo do cadastro, calculado NO SERVIDOR (value_cents).
               * A tela não refaz a multiplicação: quantidade fracionada
               * (0,5 kg × custo ímpar) arredondaria diferente aqui e no total
               * geral — e as duas contas estariam "certas".
               */
              header: 'Valor em estoque',
              align: 'right',
              // Valor nulo = a política reserva o custo à gerência (GAP-PRD-165).
              render: (r: StockItem) =>
                r.quantity > 0 && r.value_cents !== null ? (
                  <span className="tabular-nums">{formatCents(r.value_cents)}</span>
                ) : (
                  <span className="text-[var(--gs-muted)]">—</span>
                ),
            },
            {
              header: 'Situação',
              render: (r: StockItem) => {
                // A situação olha o DISPONÍVEL, não o saldo: item inteiramente
                // reservado não está "normal" para quem quer vender.
                const disponivel = r.quantity - r.reserved;
                if (disponivel <= 0 && r.quantity > 0) {
                  return <Badge tone="warning">Todo reservado</Badge>;
                }
                if (r.quantity <= 0) return <Badge tone="danger">Sem saldo</Badge>;
                // QUEM DECIDE É O SERVIDOR. A conta feita aqui divergia da do
                // filtro desta mesma tela e da das peças da bancada — três
                // respostas para "está acabando?", e a tela contradizia o
                // próprio botão de filtrar.
                if (r.below_minimum) return <Badge tone="warning">Abaixo do mínimo</Badge>;
                return <Badge tone="success">Normal</Badge>;
              },
            },
            {
              header: '',
              align: 'right',
              render: (r: StockItem) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // Leva ao histórico JÁ FILTRADO por este produto. Sem o
                    // atalho, responder "por que tinha 10 e agora tem 7" exige
                    // abrir outra tela e procurar o item no meio de todos.
                    window.location.href =
                      `/sistema/estoque/movimentacoes?produto=${encodeURIComponent(r.product_id)}`;
                  }}
                >
                  Histórico
                </Button>
              ),
            },
          ]}
          rows={data ?? []}
          keyOf={(r) => r.product_id}
          empty={
            <EmptyState
              title="Sem itens em estoque"
              description="Registre uma entrada para que os saldos apareçam aqui."
            />
          }
        />
      </Card>
    </AppShell>
  );
}

// ------------------------------------------------------------------ clientes

/**
 * ONDE O CLIENTE É LIGADO À TABELA DE PREÇO — a peça que faltava para a
 * funcionalidade existir.
 *
 * O cadastro de tabela de preço existia inteiro, com tela e texto explicando a
 * regra de atacado, e não era lido por ninguém: não havia elo entre cliente e
 * tabela em lugar nenhum do sistema. O dono continuava digitando o desconto
 * combinado à mão em cada venda. Este seletor é o elo.
 *
 * ## Por que só gerência vê o seletor
 *
 * Porque a rota é de gerência, e telas que oferecem o que o servidor recusa
 * ensinam o operador a desconfiar da tela. Conceder condição comercial é a
 * decisão que muda dinheiro: da próxima venda em diante aquela pessoa passa a
 * pagar outro preço. O cadastro do cliente continua sendo do balcão; a tabela,
 * não.
 *
 * ## Por que a lista de tabelas pode simplesmente não chegar
 *
 * `GET /core/catalog/aux` é rota de escritório. Se a leitura falhar — por
 * permissão ou por rede —, a tela mostra a coluna com o nome da tabela e não
 * mostra o seletor. Ficar sem editar é aceitável; oferecer um seletor vazio,
 * que parece dizer "este cliente não tem tabela nenhuma disponível", não é.
 */
/**
 * A ficha aberta no formulário — strings porque é o que o formulário segura.
 *
 * `id` nulo é CADASTRO: a mesma ficha serve para criar e para editar, com os
 * mesmos campos e o mesmo tratamento de recusa — só muda a rota na saída
 * (`POST` na coleção, `PUT` na ficha). No PUT a ficha viaja INTEIRA, e campo
 * vazio LIMPA no servidor (menos o nome, obrigatório sempre). É essa a
 * distinção que o contrato pede: quem corrige um telefone não apaga o e-mail
 * sem querer, e quem apaga o e-mail no formulário está decidindo apagá-lo.
 */
interface FichaEmEdicao {
  id: string | null;
  name: string;
  document: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
}

/** Linhas por página da carteira — o padrão que o servidor sempre usou. */
const CLIENTES_POR_PAGINA = 100;

/** A ficha em branco do cadastro novo — nada herdado de edição anterior. */
function fichaVazia(): FichaEmEdicao {
  return { id: null, name: '', document: '', email: '', phone: '', address: '', notes: '' };
}

export function ClientesPage() {
  const [search, setSearch] = useState('');
  /*
    A PÁGINA (GAP-PRD-070). Sem termo, a lista parava no 100º cliente e não
    dizia: a carteira parecia ter 100 pessoas. A busca continua sendo a do
    balcão (máscara dos dois lados); a página anda sobre o que ela achar.
  */
  const [offset, setOffset] = useState(0);
  const { data: pagina, error, loading, reload } = useLoader(
    () => paginaDeClientes({ search, limit: CLIENTES_POR_PAGINA, offset }),
    [search, offset],
  );
  const data = pagina?.items ?? null;
  const podeVincular = useHasProfile('gerente_loja', 'gerente_oficina');
  /**
   * Quem atende o TITULAR (LGPD, art. 18) — o espelho do `requireProfile` de
   * `GET /customers/:id/dados-do-titular` e `POST /customers/:id/anonimizar`
   * (GAP-PRD-073). Mesmo conjunto do vínculo de tabela, por outro motivo: a
   * resposta ao titular é de quem responde pela operação.
   */
  const podeAtenderTitular = useHasProfile('gerente_loja', 'gerente_oficina');
  /**
   * Quem pode mexer na ficha — o espelho do `POST /core/customers` e do
   * `PUT /core/customers/:id`, que compartilham os mesmos perfis: quem
   * cadastra a pessoa no balcão corrige o telefone que digitou errado. Isto é
   * navegação, não autorização: desenhar o botão para o estoquista só
   * deixaria o 403 explicar a regra.
   */
  const podeEditar = useHasProfile(
    'gerente_loja',
    'gerente_oficina',
    'atendente',
    'operador_caixa_loja',
    'operador_caixa_oficina',
  );

  /**
   * As tabelas oferecíveis.
   *
   * Só as ATIVAS: o servidor recusa vincular cliente a tabela desativada (ela
   * não teria efeito nenhum na precificação, e o vínculo existiria no banco
   * jurando um desconto que não acontece). Oferecer o que vai ser recusado é
   * pedir para o gerente descobrir a regra pelo erro.
   */
  const [tabelas, setTabelas] = useState<TabelaDePreco[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** Recusa fora do formulário: vínculo de tabela, abertura da ficha, inativação. */
  const [erroAcao, setErroAcao] = useState<string | null>(null);

  const [ficha, setFicha] = useState<FichaEmEdicao | null>(null);
  const [erroFicha, setErroFicha] = useState<string | null>(null);
  const [salvandoFicha, setSalvandoFicha] = useState(false);
  /** O cliente esperando a confirmação de inativação. */
  const [inativando, setInativando] = useState<Customer | null>(null);
  const [inativandoBusy, setInativandoBusy] = useState(false);
  /**
   * O último inativado, enquanto o desfazer ainda alcança.
   *
   * A lista só devolve ativos — inativado, o cliente some dela, e some JUNTO o
   * único lugar de onde um botão "Reativar" poderia agir. Este aviso é a mão
   * ainda estendida: um engano se desfaz aqui, na hora, em vez de virar
   * chamado ao suporte.
   */
  const [reativavel, setReativavel] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!podeVincular) return;
    void coreApi
      .getCatalogAux()
      .then((aux) => setTabelas(aux.priceTables.filter((t) => t.active === 1)))
      .catch(() => setTabelas(null));
  }, [podeVincular]);

  const vincular = async (cliente: Customer, priceTableId: string | null) => {
    setAviso(null);
    setErroAcao(null);
    try {
      await coreApi.setCustomerPriceTable(cliente.id, priceTableId);
      const tabela = tabelas?.find((t) => t.id === priceTableId);
      setAviso(
        tabela
          ? `${cliente.name} passa a comprar pela tabela "${tabela.name}" (-${tabela.percent_off.toFixed(2)}%) a partir da próxima venda.`
          : `${cliente.name} volta ao preço normal a partir da próxima venda.`,
      );
      await reload();
    } catch (err) {
      setErroAcao(
        err instanceof ApiRequestError ? err.message : 'Não foi possível trocar a tabela.',
      );
    }
  };

  /**
   * Abre a ficha para editar — preenchida pelo GET, nunca pela linha da lista.
   *
   * A linha pode estar velha: o que outro balcão corrigiu depois do último
   * carregamento seria sobrescrito de volta por quem editasse em cima dela. O
   * formulário parte do que o servidor tem AGORA, endereço e observações
   * inclusive, que a lista nem mostra.
   */
  /**
   * O EXTRATO DE CRÉDITO DE LOJA do cliente aberto (GAP-V10/V47).
   *
   * Mora ao lado da ficha porque é a mesma pergunta do balcão: "quanto a loja
   * deve a esta pessoa, e por quê?". Antes desta rodada a resposta não existia —
   * a devolução em crédito gravava um rótulo e o vale vivia no papel.
   *
   * Nulo enquanto não carrega; um extrato vazio (saldo zero, sem linhas) é o
   * caso normal e não vira bloco na tela.
   */
  const [creditos, setCreditos] = useState<CustomerCreditStatement | null>(null);

  const abrirFicha = async (cliente: Customer) => {
    setErroAcao(null);
    setErroFicha(null);
    setAviso(null);
    setReativavel(null);
    setInativando(null);
    setCreditos(null);
    try {
      const atual = await coreApi.getCustomer(cliente.id);
      setFicha({
        id: atual.id,
        name: atual.name,
        document: atual.document ?? '',
        email: atual.email ?? '',
        phone: atual.phone ?? '',
        address: atual.address ?? '',
        notes: atual.notes ?? '',
      });
      // O extrato não derruba a ficha: quem veio corrigir um telefone não pode
      // ficar sem o formulário porque a razão de crédito falhou.
      coreApi
        .customerCredits(cliente.id)
        .then(setCreditos)
        .catch(() => setCreditos(null));
    } catch (err) {
      setErroAcao(
        err instanceof ApiRequestError ? err.message : 'Não foi possível abrir a ficha.',
      );
    }
  };

  /**
   * Abre a ficha em branco para cadastrar — a metade que faltava do balcão.
   *
   * Sem este botão, `POST /core/customers` era código morto: a venda para
   * cliente novo com CPF exigia cadastrá-lo primeiro, e não havia onde. É o
   * MESMO formulário da edição, com os mesmos campos e as mesmas recusas
   * legíveis — só a rota de saída muda.
   */
  const novaFicha = () => {
    setErroAcao(null);
    setErroFicha(null);
    setAviso(null);
    setReativavel(null);
    setInativando(null);
    // Cliente novo não tem extrato, e deixar o do anterior na tela mostraria o
    // vale de uma pessoa no cadastro de outra.
    setCreditos(null);
    setFicha(fichaVazia());
  };

  const campoDaFicha = (chave: keyof FichaEmEdicao, valor: string) =>
    setFicha((atual) => (atual ? { ...atual, [chave]: valor } : atual));

  const salvarFicha = async () => {
    if (!ficha) return;
    setSalvandoFicha(true);
    setErroFicha(null);
    setAviso(null);
    try {
      const campos = {
        name: ficha.name,
        document: ficha.document,
        email: ficha.email,
        phone: ficha.phone,
        address: ficha.address,
        notes: ficha.notes,
      };
      if (ficha.id) {
        await coreApi.updateCustomer(ficha.id, campos);
        setAviso(`Ficha de ${ficha.name} atualizada.`);
      } else {
        await coreApi.createCustomer(campos);
        setAviso(`Cliente ${ficha.name} cadastrado.`);
      }
      setFicha(null);
      await reload();
    } catch (err) {
      // A recusa fica NO formulário, com a ficha aberta: `CORE_INVALID_DOCUMENT`
      // e `CORE_DUPLICATE_DOCUMENT` chegam como frase do servidor, e fechar
      // jogaria fora a correção (ou o cadastro) inteira por causa de um dígito.
      setErroFicha(
        err instanceof ApiRequestError ? err.message : 'Não foi possível salvar a ficha.',
      );
    } finally {
      setSalvandoFicha(false);
    }
  };

  const inativar = async () => {
    if (!inativando) return;
    setInativandoBusy(true);
    setErroAcao(null);
    setAviso(null);
    try {
      await coreApi.updateCustomer(inativando.id, { active: false });
      setReativavel({ id: inativando.id, name: inativando.name });
      setInativando(null);
      await reload();
    } catch (err) {
      setInativando(null);
      setErroAcao(
        err instanceof ApiRequestError ? err.message : 'Não foi possível inativar o cliente.',
      );
    } finally {
      setInativandoBusy(false);
    }
  };

  const reativar = async () => {
    if (!reativavel) return;
    setErroAcao(null);
    try {
      await coreApi.updateCustomer(reativavel.id, { active: true });
      setAviso(`${reativavel.name} voltou à lista de clientes.`);
      setReativavel(null);
      await reload();
    } catch (err) {
      setErroAcao(
        err instanceof ApiRequestError ? err.message : 'Não foi possível reativar o cliente.',
      );
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Cadastros', 'Clientes']}
        title="Clientes"
        subtitle="Quem compra — e por qual tabela de preço"
        actions={
          podeEditar ? <Button onClick={novaFicha}>Novo cliente</Button> : undefined
        }
      />

      <Card className="mb-5">
        <Field label="Buscar">
          {(p) => (
            <Input
              {...p}
              value={search}
              onChange={(e) => {
                // Outra busca, outro universo: a página 3 dela não existe.
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Nome, CPF/CNPJ ou telefone"
            />
          )}
        </Field>
      </Card>

      {ficha && (
        <Card title={ficha.id ? 'Editar cliente' : 'Novo cliente'} className="mb-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void salvarFicha();
            }}
            className="grid gap-4 md:grid-cols-2"
          >
            <Field label="Nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={ficha.name}
                  onChange={(e) => campoDaFicha('name', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="CPF/CNPJ"
              hint="Com ou sem máscara — o servidor guarda só os dígitos e confere o verificador"
            >
              {(p) => (
                <Input
                  {...p}
                  value={ficha.document}
                  onChange={(e) => campoDaFicha('document', e.target.value)}
                />
              )}
            </Field>
            <Field label="Telefone">
              {(p) => (
                <Input
                  {...p}
                  value={ficha.phone}
                  onChange={(e) => campoDaFicha('phone', e.target.value)}
                />
              )}
            </Field>
            <Field label="E-mail">
              {(p) => (
                <Input
                  {...p}
                  value={ficha.email}
                  onChange={(e) => campoDaFicha('email', e.target.value)}
                />
              )}
            </Field>
            <Field label="Endereço">
              {(p) => (
                <Input
                  {...p}
                  value={ficha.address}
                  onChange={(e) => campoDaFicha('address', e.target.value)}
                />
              )}
            </Field>
            <Field label="Observações">
              {(p) => (
                <Input
                  {...p}
                  value={ficha.notes}
                  onChange={(e) => campoDaFicha('notes', e.target.value)}
                />
              )}
            </Field>
            <div className="md:col-span-2 flex items-center gap-2">
              <Button type="submit" loading={salvandoFicha} disabled={!ficha.name.trim()}>
                Salvar
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setFicha(null);
                  setErroFicha(null);
                }}
              >
                Cancelar
              </Button>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {ficha.id
                  ? 'Campo apagado aqui é apagado no cadastro. A tabela de preço troca-se na lista.'
                  : 'Só o nome é obrigatório — o resto completa-se depois, na própria ficha.'}
              </span>
            </div>
            {erroFicha && (
              <p role="alert" className="md:col-span-2 text-[var(--gs-danger)] m-0">
                {erroFicha}
              </p>
            )}
          </form>
        </Card>
      )}

      {ficha?.id && podeAtenderTitular && (
        <DireitosDoTitular
          cliente={{ id: ficha.id, name: ficha.name }}
          onExportado={(nome) =>
            setAviso(`Dados de ${nome} exportados — o arquivo foi para a pasta de downloads.`)
          }
          onAnonimizado={(nome) => {
            // A ficha fecha: o que ela mostrava não existe mais, e deixá-la
            // aberta convidaria a "Salvar" o contato de volta.
            setFicha(null);
            setCreditos(null);
            setAviso(
              `${nome} foi anonimizado. O cadastro saiu da lista; vendas, notas e ordens de serviço continuam, apontando para "Titular anonimizado".`,
            );
            void reload();
          }}
        />
      )}

      {/*
        ------------------------------------------- crédito de loja do cliente

        Só aparece quando existe movimento. Um bloco "Crédito de loja: R$ 0,00"
        em toda ficha seria ruído em 99% dos cadastros — e, pior, ensinaria a
        pessoa a não olhar o lugar em que o número importa.

        O bloco é da FICHA ABERTA, e não da linha da lista: é aqui que a pergunta
        "de onde veio esse crédito?" é feita, e é aqui que a resposta cabe — com
        o número da devolução que concedeu e o da venda que gastou.
      */}
      {ficha?.id && creditos && creditos.entries.length > 0 && (
        <ExtratoDeCredito extrato={creditos} />
      )}

      <Feedback error={error} loading={loading} />

      {erroAcao && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
        >
          {erroAcao}
        </div>
      )}
      {aviso && (
        <div
          role="status"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)] text-[length:var(--gs-text-sm)]"
        >
          {aviso}
        </div>
      )}
      {/*
        A linha mascarada explica a si mesma (GAP-PRD-073). Sem esta frase, quem
        vê "••• 4705" acharia que o cadastro está incompleto — e alguém
        "corrigiria" o CPF de uma pessoa que ele não tem por que ver.
      */}
      {data?.some((c) => c.dados_mascarados) && (
        <p
          data-testid="clientes-mascarados"
          className="mb-4 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
        >
          Os dados de contato aparecem mascarados para o seu perfil (LGPD): CPF/CNPJ e telefone só
          com os últimos dígitos; e-mail, endereço e observações ficam com quem atende o cadastro. A
          busca continua achando pelo número inteiro.
        </p>
      )}
      {reativavel && (
        <div
          role="status"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)] text-[length:var(--gs-text-sm)] flex flex-wrap items-center gap-3"
        >
          <span>
            {`${reativavel.name} foi inativado e saiu da lista — a busca do balcão para de encontrá-lo. Foi engano?`}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void reativar()}>
            Reativar
          </Button>
        </div>
      )}

      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Nome', render: (r: Customer) => r.name },
            { header: 'CPF/CNPJ', render: (r: Customer) => r.document ?? '—' },
            { header: 'Telefone', render: (r: Customer) => r.phone ?? '—' },
            { header: 'E-mail', render: (r: Customer) => r.email ?? '—' },
            {
              header: 'Tabela de preço',
              render: (r: Customer) =>
                // O seletor SÓ com a lista em mãos. Sem ela, o nome da tabela
                // ainda é informação útil — e é o que o `SELECT *` do servidor
                // já traz — mas trocar às cegas, não.
                podeVincular && tabelas ? (
                  <select
                    aria-label={`Tabela de preço de ${r.name}`}
                    value={r.price_table_id ?? ''}
                    onChange={(e) => void vincular(r, e.target.value || null)}
                    className="h-9 px-2 rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)]
                      bg-[var(--gs-surface)] text-[var(--gs-text)] max-w-[220px]"
                  >
                    {/* Vazio é uma escolha de verdade, e é a que DESFAZ o
                        vínculo. Sem ela o gerente conseguiria conceder atacado
                        e nunca mais tirá-lo. */}
                    <option value="">Preço normal</option>
                    {tabelas.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} (-{t.percent_off.toFixed(2)}%)
                      </option>
                    ))}
                  </select>
                ) : (
                  <NomeDaTabela id={r.price_table_id ?? null} tabelas={tabelas} />
                ),
            },
            ...(podeEditar
              ? [
                  {
                    header: '',
                    align: 'right' as const,
                    render: (r: Customer) => (
                      <div className="flex gap-1 justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Editar cadastro de ${r.name}`}
                          onClick={() => void abrirFicha(r)}
                        >
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Inativar ${r.name}`}
                          onClick={() => setInativando(r)}
                        >
                          Inativar
                        </Button>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
          rows={data ?? []}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhum cliente"
              description="Os clientes cadastrados nesta operação aparecem aqui."
            />
          }
        />
        <Paginacao
          pagina={pagina ? { ...pagina, quantidade: pagina.items.length } : null}
          rotulo={{ singular: 'cliente', plural: 'clientes' }}
          onMudar={setOffset}
          carregando={loading}
          dica="Use a busca para ir direto a uma pessoa."
        />
      </Card>

      {inativando && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          ref={prenderFoco}
          tabIndex={-1}
          aria-label={`Inativar ${inativando.name}`}
        >
          <div className="w-full max-w-lg rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
            <header className="px-6 py-4 border-b border-[var(--gs-border)]">
              <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">
                Inativar {inativando.name}?
              </h2>
            </header>
            <div className="px-6 py-5 flex flex-col gap-4">
              <p className="m-0 text-[length:var(--gs-text-base)]">
                O cadastro não é apagado — as vendas antigas e o histórico continuam fazendo
                sentido —, mas ele <strong>sai da lista</strong> e a busca do balcão para de
                encontrá-lo: não dá mais para vincular este cliente a uma venda nova.
              </p>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Mudou de ideia logo depois? O aviso que fica nesta tela oferece o Reativar.
              </p>
              <div className="flex justify-end gap-3">
                <Button variant="ghost" onClick={() => setInativando(null)}>
                  Cancelar
                </Button>
                <Button variant="danger" loading={inativandoBusy} onClick={() => void inativar()}>
                  Inativar cliente
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

/**
 * O EXTRATO DE CRÉDITO DE LOJA de um cliente (GAP-V10/V47).
 *
 * ## O que este bloco responde
 *
 * "Quanto a loja deve a esta pessoa, e por quê?" — a pergunta que, até esta
 * rodada, só tinha resposta no papel do balcão. A devolução em crédito gravava
 * `refund_method='credito'`, o DRE nomeava o valor numa ressalva, e não havia
 * saldo, extrato nem forma de gastar.
 *
 * ## A ORIGEM É NAVEGÁVEL, e é isso que o torna útil
 *
 * "R$ 250,00 concedidos" sem dizer de onde manda quem lê procurar num histórico
 * inteiro. Cada linha traz o documento: a concessão diz a devolução, o resgate
 * diz a venda. É a mesma lição do extrato de pontos.
 *
 * ## SALDO NEGATIVO EXISTE, e aparece
 *
 * Quando a venda que originou a devolução é cancelada, o vale é revogado — e se
 * o cliente já o gastou, o saldo fica abaixo de zero. É dívida real: a loja
 * entregou mercadoria contra um crédito que a anulação desfez. Mostrar em
 * vermelho é o mínimo; esconder por baixo faria o rombo sumir justamente do
 * único lugar capaz de revelá-lo.
 */
function ExtratoDeCredito({ extrato }: { extrato: CustomerCreditStatement }) {
  const positivo = extrato.balance >= 0;
  return (
    <Card title="Crédito de loja" className="mb-5">
      <p data-testid="credito-saldo" className="m-0 mb-3 text-[length:var(--gs-text-base)]">
        Saldo atual:{' '}
        <strong style={{ color: positivo ? 'var(--gs-success)' : 'var(--gs-danger)' }}>
          {formatCents(extrato.balance)}
        </strong>
        {positivo ? (
          <span className="text-[var(--gs-muted)]">
            {' '}
            — o PDV oferece este valor como abatimento na próxima compra.
          </span>
        ) : (
          <span className="text-[var(--gs-muted)]">
            {' '}
            — saldo negativo: um crédito já gasto foi revogado pelo cancelamento da venda que o
            concedeu.
          </span>
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
          <thead>
            <tr className="text-left text-[var(--gs-muted)]">
              <th className="py-2">Quando</th>
              <th className="py-2">O quê</th>
              <th className="py-2">Origem</th>
              <th className="py-2 text-right">Valor</th>
            </tr>
          </thead>
          <tbody>
            {extrato.entries.map((linha) => (
              <tr key={linha.id} className="border-t border-[var(--gs-border)]">
                <td className="py-2">{dataHoraBR(linha.created_at)}</td>
                <td className="py-2">
                  <Badge tone={linha.amount_cents >= 0 ? 'success' : 'neutral'}>
                    {linha.kind === 'grant'
                      ? 'Concedido'
                      : linha.kind === 'redeem'
                        ? 'Usado'
                        : 'Estorno'}
                  </Badge>
                </td>
                <td className="py-2 font-mono">
                  {linha.return_number != null
                    ? `Devolução #${linha.return_number}`
                    : linha.sale_number != null
                      ? `Venda #${linha.sale_number}`
                      : '—'}
                </td>
                <td className="py-2 text-right font-semibold">
                  {formatCents(linha.amount_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * O nome da tabela para quem não pode (ou não consegue) trocá-la.
 *
 * Sem a lista carregada resta o id, e id não diz nada a ninguém — por isso o
 * fallback é "Tabela vinculada" e não o UUID: afirmar QUE existe condição
 * especial já responde a pergunta que se faz olhando esta coluna, e um
 * identificador na tela só pareceria defeito.
 */
function NomeDaTabela({ id, tabelas }: { id: string | null; tabelas: TabelaDePreco[] | null }) {
  if (!id) return <span className="text-[var(--gs-muted)]">Preço normal</span>;
  const tabela = tabelas?.find((t) => t.id === id);
  return <Badge tone="info">{tabela ? tabela.name : 'Tabela vinculada'}</Badge>;
}

// --------------------------------------------------------------------- caixa

/**
 * Quantos turnos a lista pede por vez. O primeiro pedido é comedido e o
 * "Mostrar mais" alarga de dez em dez — o servidor corta em 200 de qualquer
 * forma, porque o histórico completo é caso de exportação, não de tela.
 */
const TURNOS_POR_PAGINA = 10;

export function CaixaPage() {
  const [opening, setOpening] = useState('0,00');
  const [counted, setCounted] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ expectedCents: number } | null>(null);
  const [limiteDeTurnos, setLimiteDeTurnos] = useState(TURNOS_POR_PAGINA);

  // Só a sessão interessa aqui: o teto da sangria que vem junto na resposta é
  // assunto do modal do PDV, que é onde se sangra. Esta tela abre e fecha o
  // turno.
  //
  // `exigirCampos`, e não `envelope`: `session: null` é resposta legítima —
  // significa caixa fechado, e é o estado que o botão de abrir atende. O que
  // não pode passar calado é a CHAVE não vir: aí `r.session` viraria
  // `undefined`, a tela diria "caixa fechado" com o caixa aberto, e o operador
  // abriria um segundo turno em cima do primeiro.
  //
  // O CAIXA DESTE COMPUTADOR (GAP-PRD-039): com caixas cadastrados, a gaveta é
  // a de UM caixa, e a consulta vai com o caixa que este computador guardou.
  const empresa = useSession()?.company.id ?? null;
  const [caixaDaTela, setCaixaDaTela] = useState<string | null>(() => caixaDesteComputador(empresa));
  const [infoDoCaixa, setInfoDoCaixa] = useState<CaixaDoComputador | null>(null);
  const [gavetasTick, setGavetasTick] = useState(0);
  const { data: current, error, loading, reload } = useLoader(
    () =>
      coreApi.getOpenCash(caixaDaTela).then((r) => {
        const conferido = exigirCampos(r, 'session');
        setInfoDoCaixa(conferido);
        return conferido.session;
      }),
    [caixaDaTela],
  );
  const escolherCaixa = (terminalId: string | null) => {
    if (empresa) guardarCaixaDesteComputador(empresa, terminalId);
    setCaixaDaTela(terminalId);
  };
  const precisaEscolherCaixa = !current && Boolean(infoDoCaixa?.exigeTerminal) && !infoDoCaixa?.terminal;

  /*
    O HISTÓRICO DE TURNOS — a metade de tela que `GET /core/cash/sessions`
    esperava. A rota devolve quem abriu e quem fechou PELO NOME, e a diferença
    de cada fechamento, desde a rodada 32; o comentário dela afirmava que esta
    tela a consumia, e nenhuma tela chamava. "De quem era o caixa que fechou
    faltando 40?" se responde aqui, não no banco.
  */
  const {
    data: turnos,
    error: turnosError,
    loading: turnosLoading,
    reload: recarregarTurnos,
  } = useLoader(
    () => coreApi.listCashSessions(limiteDeTurnos).then(envelope('items')),
    [limiteDeTurnos],
  );

  /*
    O RESUMO DO TURNO — sem ele, "não carregado", nunca R$ 0,00
    (H-caixa-seguranca-M02).

    O DEFEITO: `cashSummary(...).then(...)` não tinha catch e só rodava quando
    `current` mudava. Com a consulta falhando, `summary` ficava nulo e o card
    escrevia "Esperado em gaveta R$ 0,00" — um número que o servidor nunca
    disse: o gestor contava a gaveta contra zero, ou fechava achando que não
    houve venda. E com a página aberta desde as 14h, as vendas das 14h às 18h
    nunca entravam no esperado mostrado.

    Agora a falha aparece como falha (e sem esperado não se fecha — a mesma
    regra do diálogo de caixa do PDV), e o resumo é RELIDO na hora de pedir o
    fechamento. Só a resposta mais recente vale: a do turno anterior, chegando
    atrasada, não pinta o turno de agora.
  */
  const [resumoFalhou, setResumoFalhou] = useState(false);
  const ultimoResumo = useRef(0);
  const carregarResumo = useCallback(async (sessao: CashSession | null): Promise<number | null> => {
    const minha = ++ultimoResumo.current;
    if (!sessao) {
      setSummary(null);
      setResumoFalhou(false);
      return null;
    }
    try {
      const s = await coreApi.cashSummary(sessao.id);
      const esperado = Number(s?.expectedCents);
      // Resposta sem o número é resposta sem resumo: "0" inventado aqui é
      // exatamente o defeito que este bloco fecha.
      if (s?.expectedCents === null || s?.expectedCents === undefined || !Number.isFinite(esperado)) {
        throw new Error('resumo sem o esperado');
      }
      if (minha === ultimoResumo.current) {
        setSummary({ expectedCents: esperado });
        setResumoFalhou(false);
      }
      return esperado;
    } catch {
      if (minha === ultimoResumo.current) {
        setSummary(null);
        setResumoFalhou(true);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void carregarResumo(current);
  }, [current, carregarResumo]);

  /*
    O VALOR DIGITADO (H-caixa-seguranca-01).

    O DEFEITO: o leitor desta tela tirava TODOS os pontos e terminava em
    `|| 0`. Campo vazio, "abc" ou "1.234,5x" viravam 0 — e o turno fechava com
    a gaveta inteira em falta, sem pergunta nenhuma. "350.50", o ponto decimal
    do teclado numérico, virava R$ 35.050,00 contados; o fundo de troco
    "100.50" abria a gaveta com R$ 10.050,00.

    `parseReaisToCents` é o leitor do resto do sistema — o do diálogo de caixa
    do PDV, o das gavetas abertas e o gêmeo do servidor: "350.50" é 350,50,
    "1.500" é mil e quinhentos, e texto que não é dinheiro é `null`. Com
    `null` o botão fica desabilitado: zero contado precisa ser DIGITADO.
  */
  const aberturaCents = parseReaisToCents(opening);
  const contadoCents = parseReaisToCents(counted);

  /*
    O TETO DO FUNDO DE TROCO E A CONTAGEM, DITOS NO CAMPO (H-caixa-seguranca-01, as duas telas).

    O DEFEITO: o teto de R$ 100.000,00 do fundo de troco só existia no diálogo
    de caixa do PDV. Aqui, um código de barras bipado no "Fundo de troco"
    ("7894561230012" = R$ 7.894.561.230,12) seguia inteiro para o servidor com o
    botão ativo, e a recusa voltava numa faixa longe do campo. E o texto que não
    é dinheiro, nos dois campos, só desabilitava o botão, sem dizer por quê.

    Agora o MESMO teto do diálogo (`TETO_FUNDO_DE_TROCO_CENTS`) vale aqui, e os
    dois campos dizem o problema embaixo deles, antes de qualquer envio. O
    servidor continua recusando os dois casos por conta própria
    (`CORE_CASH_AMOUNT_TOO_HIGH` e `CORE_CASH_COUNT_REQUIRED`).
  */
  const erroDoFundo: string | undefined =
    aberturaCents === null
      ? opening.trim() === ''
        ? undefined
        : 'Fundo de troco inválido. Digite o valor em reais, por exemplo 100,00 (ou 0,00 sem fundo).'
      : aberturaCents > TETO_FUNDO_DE_TROCO_CENTS
        ? `Fundo de troco acima de ${formatCents(TETO_FUNDO_DE_TROCO_CENTS)}. `
          + 'Confira o valor — um código de barras bipado aqui vira dinheiro na gaveta.'
        : undefined;
  const erroDoContado: string | undefined =
    counted.trim() !== '' && contadoCents === null
      ? 'Valor contado inválido. Digite em reais, por exemplo 350,50 (ou 0,00 se a gaveta foi esvaziada).'
      : undefined;

  /*
    UM CLIQUE, UMA REQUISIÇÃO (H-caixa-seguranca-M02).

    O DEFEITO: abrir e fechar não tinham estado de envio e o botão seguia
    ativo durante a requisição. No clique duplo em "Fechar caixa" o primeiro
    fechava, o segundo voltava 409 e a faixa trocava o "Caixa fechado…" por
    "Caixa já fechado." — o gestor lia que tinha falhado. Em "Abrir caixa" o
    segundo clique respondia "Já existe um caixa aberto… Feche-o".

    O ref barra o segundo clique que chega antes de o React redesenhar o botão
    desabilitado (leitor rápido, mouse com repique); o estado desenha o botão.
  */
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);
  const comTrava = async (acao: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await acao();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  /*
    A VENDA GUARDADA NESTE COMPUTADOR QUE AINDA NÃO SUBIU (H-caixa-seguranca-M02).

    O DEFEITO: o diálogo de caixa do PDV trava o fechamento enquanto há venda
    offline desta gaveta na fila (GAP-PRD-045), e esta tela — que é
    `ROTA_CAIXA`, aberta no MESMO computador do balcão — fechava assim mesmo.
    O servidor passava a recusar a venda no reenvio, com o dinheiro dela já
    contado na gaveta.

    A regra é a do diálogo (G-offline-sync-12), escrita igual: trava a venda
    desta operação (ou a antiga, sem escopo gravado) que sobe NESTA gaveta — ou
    em gaveta nenhuma, que o servidor resolve no reenvio. A de outra operação
    ou de outro turno não trava.
  */
  const [fila, setFila] = useState<QueuedRequest[]>([]);
  useEffect(() => subscribeQueue(setFila), []);
  const vendasNaFila = fila.filter((q) => {
    const empresaDaVenda = q.escopo?.companyId ?? null;
    const gaveta = (q.body as { cashSessionId?: string | null } | null)?.cashSessionId ?? null;
    const daOperacao = !empresaDaVenda || !empresa || empresaDaVenda === empresa;
    return daOperacao && (gaveta === null || gaveta === current?.id);
  }).length;

  /*
    O TURNO QUE ACABOU DE FECHAR, PARA O PAPEL (H-caixa-seguranca-11).

    O DEFEITO: fechar por aqui terminava na faixa "Caixa fechado. Esperado…,
    contado…" e mais nada — o papel do fechamento, com as sangrias e o espaço
    para assinar, não era pedido por tela nenhuma. O id da sessão e o caixa dela
    ficam guardados no fechamento, antes de a tela reler a gaveta e esquecê-la.
  */
  const [fechamentoParaImprimir, setFechamentoParaImprimir] = useState<
    { sessionId: string; terminalId: string | null } | null
  >(null);

  const open = () =>
    comTrava(async () => {
      if (aberturaCents === null) {
        setFeedback('Fundo de troco inválido. Digite o valor em reais, por exemplo 100,00 (ou 0,00 sem fundo).');
        return;
      }
      // O teto do fundo (H-caixa-seguranca-01, as duas telas): o campo já diz
      // por quê, e nada vai ao servidor — o botão também fica desabilitado.
      if (aberturaCents > TETO_FUNDO_DE_TROCO_CENTS) return;
      setFeedback(null);
      try {
        await coreApi.openCash(aberturaCents, infoDoCaixa?.terminal?.id ?? caixaDaTela);
        // O turno novo não tem papel de fechamento: a oferta do anterior sai.
        setFechamentoParaImprimir(null);
        await reload();
        // O turno recém-aberto já é histórico: aparece na lista como "ainda
        // aberto" sem esperar ninguém recarregar a página.
        await recarregarTurnos();
        setGavetasTick((n) => n + 1);
      } catch (err) {
        setFeedback(err instanceof ApiRequestError ? err.message : 'Falha ao abrir o caixa.');
      }
    });

  /*
    Pendência eletrônica do turno (GAP-PRD-081): o servidor recusa o
    fechamento e manda a lista; fechar assim mesmo exige ciência e motivo.
  */
  const [pendFechamento, setPendFechamento] = useState<
    { p: PendenciasEletronicas; ciente: boolean; motivo: string } | null
  >(null);

  /*
    FECHAR PEDE CONFIRMAÇÃO, COM A CONTA NA FRENTE (H-caixa-seguranca-01/M02).

    O DEFEITO: um clique em "Fechar caixa" fechava o turno na hora, com o que
    estivesse no campo — inclusive nada —, e o fechamento só volta por
    reabertura no mesmo dia, com alçada. Agora o clique RELÊ o esperado no
    servidor (o do card pode ser de horas atrás) e mostra "Contado X contra o
    esperado Y" antes; só a confirmação envia. É o mesmo passo do diálogo de
    caixa do PDV, para a mesma gaveta.
  */
  const [confirmandoFechamento, setConfirmandoFechamento] = useState(false);

  const pedirFechamento = () =>
    comTrava(async () => {
      if (!current || contadoCents === null || vendasNaFila > 0) return;
      setFeedback(null);
      const esperado = await carregarResumo(current);
      if (esperado === null) {
        setFeedback(
          'Não foi possível carregar o esperado do turno, e sem ele não dá para conferir a gaveta. '
            + 'Tente de novo em instantes.',
        );
        return;
      }
      setConfirmandoFechamento(true);
    });

  const close = () =>
    comTrava(async () => {
      if (!current || contadoCents === null) return;
      // As travas do botão, conferidas de novo no envio: a fila e o resumo podem
      // ter mudado com a confirmação já na tela.
      if (!summary || vendasNaFila > 0) return;
      if (pendFechamento && !cienciaCompleta(pendFechamento.ciente, pendFechamento.motivo)) return;
      setFeedback(null);
      try {
        const closed = await coreApi.closeCash(
          current.id,
          contadoCents,
          undefined,
          pendFechamento ? { ciente: pendFechamento.ciente, motivo: pendFechamento.motivo } : undefined,
        );
        setConfirmandoFechamento(false);
        // O papel do fechamento para assinar (H-caixa-seguranca-11): o id vem
        // do turno que ESTAVA aberto, antes de `reload()` esquecê-lo.
        setFechamentoParaImprimir({
          sessionId: current.id,
          terminalId: current.terminal_id ?? infoDoCaixa?.terminal?.id ?? caixaDaTela ?? null,
        });
        setFeedback(
          `Caixa fechado. Esperado ${formatCents(closed.expected_cents ?? 0)}, contado ${formatCents(
            closed.counted_cents ?? 0,
          )}, diferença ${formatCents(closed.difference_cents ?? 0)}.`
            + (pendFechamento ? ' Fechado com pendência eletrônica declarada.' : ''),
        );
        setPendFechamento(null);
        // A contagem era DESTE turno: o próximo não herda o número no campo.
        setCounted('');
        await reload();
        // O fechamento que acabou de acontecer é a primeira linha da lista — e é
        // exatamente o que quem fechou quer conferir.
        await recarregarTurnos();
        setGavetasTick((n) => n + 1);
      } catch (err) {
        const p = pendenciasDoErro(err);
        if (p) {
          // A recusa por pendência eletrônica pede ciência e motivo: a
          // confirmação FICA, com o botão travado até os dois virem.
          setPendFechamento((antes) => ({ p, ciente: antes?.ciente ?? false, motivo: antes?.motivo ?? '' }));
        } else {
          // Qualquer outra recusa desfaz a pergunta; a faixa diz o porquê.
          setConfirmandoFechamento(false);
        }
        setFeedback(err instanceof ApiRequestError ? err.message : 'Falha ao fechar o caixa.');
      }
    });

  /**
   * ==========================================================================
   * REABRIR O TURNO — o botão da rota que acabou de nascer (GAP-V64)
   * ==========================================================================
   *
   * ## Por que ele existe, e por que aparece em UMA linha só
   *
   * Fechar era definitivo, e o desfecho real disso não era disciplina: era o
   * operador que esqueceu de lançar uma venda ou uma sangria e resolvia o
   * problema no turno SEGUINTE, com o movimento caindo no dia errado. A saída
   * agora tem nome, exige gestor (ou a liberação dele) e vale só no mesmo dia.
   *
   * A tela oferece o botão apenas no ÚLTIMO turno fechado e apenas quando ele
   * fechou hoje — que são exatamente as duas condições que o servidor cobra. Não
   * é validação duplicada: é não convidar alguém a clicar num botão que só
   * responde 409. A decisão continua sendo do servidor, e as recusas dele
   * aparecem aqui pela mensagem, com todas as letras.
   *
   * ## O que a reabertura NÃO faz
   *
   * Não apaga a conferência. O esperado, o contado e a diferença daquele
   * fechamento vão para a trilha da sessão (`closing_trail`) — é por isso que a
   * lista mostra "reaberto" na linha em vez de a linha simplesmente voltar a
   * parecer um turno que nunca fechou.
   *
   * ## O DEFEITO QUE ESTE BLOCO FECHA: a tela não sabia PEDIR a liberação
   *
   * A metade do servidor estava inteira: quem tem alçada reabre direto, quem
   * não tem recebe 403 `CORE_REOPEN_NEEDS_AUTHORIZATION` e reabre com o
   * bilhete do gestor. A metade da tela não existia. O botão era desenhado sem
   * nenhum recorte de perfil, `/sistema/caixa` é `ROTA_CAIXA` (o operador de
   * caixa CHEGA), e o handler chamava `coreApi.reopenCash(sessionId, motivo)`
   * com DOIS argumentos — enquanto a assinatura do cliente tem TRÊS, e o
   * terceiro é justamente o `authorizationId`. O caminho existia inteiro e
   * morria na última linha: o operador clicava, lia "peça a liberação de um
   * gestor" numa faixa e não tinha onde o gestor digitar.
   *
   * E não era caso raro. Na operação real, os únicos perfis de balcão que
   * existem são `operador_caixa_loja` e `operador_caixa_oficina` — isto é, TODO
   * usuário que abre a gaveta cai exatamente neste ramo.
   *
   * O idioma é o mesmo da `DevolucoesPage`, de propósito e não por preguiça:
   * `pedeGestor` separa o 403 que PEDE do 403 que apenas nega, e
   * `autorizarEContinuar` repete A MESMA ação com o bilhete. Um segundo idioma
   * para a mesma liberação seria uma segunda ideia de autorização no sistema.
   */
  const [reabrindo, setReabrindo] = useState<string | null>(null);

  /**
   * QUEM REABRE SOZINHO — o espelho de `temAlcadaParaLiberar` do servidor.
   *
   * `AUTHORIZERS` é {admin_geral, gestor, gerente_loja, gerente_oficina}, e
   * `useHasProfile` já embute os dois primeiros por cima de qualquer lista.
   * Isto é NAVEGAÇÃO, não autorização: a rota continua conferindo os perfis do
   * TOKEN, e é ela que recusa quando falta o bilhete.
   */
  const reabreDireto = useHasProfile('gerente_loja', 'gerente_oficina');

  /** A reabertura pendurada esperando a assinatura do gestor. */
  const [liberacaoPedida, setLiberacaoPedida] = useState<{
    sessionId: string;
    motivo: string;
  } | null>(null);
  const [liberacaoBusy, setLiberacaoBusy] = useState(false);
  const [liberacaoErro, setLiberacaoErro] = useState<string | null>(null);

  /**
   * O 403 que PEDE gestor, separado do 403 que apenas nega.
   *
   * Sem esta distinção a tela trata os dois como erro e escreve a mensagem do
   * servidor numa faixa — que é exatamente o "o sistema está com defeito" que
   * quem opera reporta quando a permissão não se explica.
   */
  const pedeGestor = (err: unknown): boolean =>
    err instanceof ApiRequestError && err.code === 'CORE_REOPEN_NEEDS_AUTHORIZATION';

  const reabrir = async (sessionId: string, authorizationId?: string) => {
    setFeedback(null);
    setReabrindo(sessionId);
    const motivo = motivoDaReabertura.trim();
    try {
      await coreApi.reopenCash(sessionId, motivo, authorizationId);
      // O fechamento reaberto não vale mais: o papel dele o servidor recusa
      // (`CORE_CASH_CLOSING_NOT_CLOSED`), então a oferta sai da tela.
      setFechamentoParaImprimir(null);
      setFeedback(
        'Turno reaberto. A conferência anterior ficou guardada na trilha do turno, e o '
          + 'fechamento seguinte recalcula o esperado com os movimentos novos.',
      );
      setMotivoDaReabertura('');
      await reload();
      await recarregarTurnos();
    } catch (err) {
      /*
        A RECUSA QUE PEDE GESTOR NÃO É UM ERRO NA TELA — é o próximo passo.

        O motivo já digitado fica pendurado junto: fazer o operador redigitá-lo
        depois da assinatura seria cobrar dele o preço da permissão que ele não
        tem.
      */
      if (pedeGestor(err)) {
        setLiberacaoErro(null);
        setLiberacaoPedida({ sessionId, motivo });
        return;
      }
      setFeedback(err instanceof ApiRequestError ? err.message : 'Falha ao reabrir o turno.');
    } finally {
      setReabrindo(null);
    }
  };

  /**
   * O gestor digitou a credencial: pede o bilhete e repete a ação com ele.
   *
   * A SENHA NÃO PASSA POR AQUI como estado desta página —
   * `AutorizacaoGerenteDialog` a entrega direto a `coreApi.authorize` e a
   * esquece ao desmontar.
   *
   * `referenceId` é o TURNO, e não é enfeite: `reabrir_caixa` está em
   * `ACOES_PRESAS_AO_RECURSO`, então o servidor confere que o bilhete foi dado
   * para ESTE turno. Um "sim" solto serviria para qualquer gaveta.
   */
  const autorizarEContinuar = async (login: string, password: string) => {
    if (!liberacaoPedida) return;
    const pendente = liberacaoPedida;
    setLiberacaoBusy(true);
    setLiberacaoErro(null);
    try {
      const bilhete = await coreApi.authorize({
        action: 'reabrir_caixa',
        login,
        password,
        referenceId: pendente.sessionId,
        reason: pendente.motivo || 'Reabertura do turno de caixa.',
      });
      setLiberacaoPedida(null);
      await reabrir(pendente.sessionId, bilhete.id);
    } catch (err) {
      // O diálogo FICA: credencial errada se redigita, e fechar a caixa
      // obrigaria a repetir o caminho inteiro por um erro de digitação.
      setLiberacaoErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.',
      );
    } finally {
      setLiberacaoBusy(false);
    }
  };

  const [motivoDaReabertura, setMotivoDaReabertura] = useState('');

  /*
    O ÚLTIMO TURNO FECHADO, e "hoje" pelo relógio da LOJA.

    A lista vem ordenada por abertura (mais recente primeiro), então o primeiro
    fechado dela é o candidato. A comparação de dia usa `dataBR` dos dois lados
    — o mesmo formatador no fuso da loja — porque comparar por UTC abriria o
    botão depois das 21h para um turno que a loja considera de ontem.
  */
  const hojeNaLoja = dataBR(new Date().toISOString());
  const ultimoFechado = (turnos ?? []).find((t) => t.status === 'closed');
  const podeReabrir = (t: TurnoDeCaixa): boolean =>
    !!ultimoFechado
    && t.id === ultimoFechado.id
    && !current
    && dataBR(t.closed_at) === hojeNaLoja;

  return (
    <AppShell>
      <PageHeader breadcrumb={['Vendas', 'Caixa']} title="Caixa" />
      <Feedback error={error} loading={loading} />

      {feedback && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)]"
        >
          {feedback}
        </div>
      )}

      {/* O papel do fechamento para assinar, com o foco no botão (H-caixa-seguranca-11). */}
      {fechamentoParaImprimir && (
        <div className="mb-5">
          <ImprimirFechamento
            key={fechamentoParaImprimir.sessionId}
            sessionId={fechamentoParaImprimir.sessionId}
            terminalId={fechamentoParaImprimir.terminalId}
            onSeguir={() => setFechamentoParaImprimir(null)}
          />
        </div>
      )}

      {infoDoCaixa?.terminal && (
        <div className="mb-4">
          <LinhaDoCaixa
            nome={infoDoCaixa.terminal.name}
            fixo={Boolean(infoDoCaixa.terminalDoDispositivo)}
            onTrocar={() => escolherCaixa(null)}
          />
        </div>
      )}

      {/* A gaveta esquecida (GAP-PRD-131): o fechamento é o card logo abaixo. */}
      {current && infoDoCaixa?.deOutroDia && (
        <div className="mb-4">
          <AvisoGavetaDeOutroDia gaveta={infoDoCaixa.deOutroDia} />
        </div>
      )}

      {current ? (
        <Card title={infoDoCaixa?.terminal ? `Caixa aberto — ${infoDoCaixa.terminal.name}` : 'Caixa aberto'}>
          <dl className="grid gap-4 sm:grid-cols-3 m-0">
            <div>
              <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Abertura</dt>
              <dd className="m-0 text-[length:var(--gs-text-xl)] font-semibold">
                {formatCents(current.opening_cents)}
              </dd>
            </div>
            <div>
              <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Esperado em gaveta</dt>
              {/* Sem resumo, "não carregado" — nunca um R$ 0,00 que o servidor não disse. */}
              <dd className="m-0 text-[length:var(--gs-text-xl)] font-semibold" data-testid="caixa-gestao-esperado">
                {summary ? formatCents(summary.expectedCents) : resumoFalhou ? 'não carregado' : '…'}
              </dd>
            </div>
            <div>
              <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Aberto em</dt>
              <dd className="m-0 text-[length:var(--gs-text-base)]">
                {new Date(current.opened_at).toLocaleString('pt-BR')}
              </dd>
            </div>
          </dl>

          <div className="mt-6 flex flex-wrap items-end gap-4">
            <div className="w-56">
              <Field
                label="Valor contado no fechamento"
                hint="Obrigatório para fechar: 0,00 se a gaveta foi esvaziada."
                error={erroDoContado}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={counted}
                    onChange={(e) => {
                      setCounted(e.target.value);
                      /*
                        MEXEU NA CONTAGEM, A PERGUNTA CAI (revisão do H-caixa-seguranca-01).

                        O DEFEITO: com a confirmação na tela, apagar o campo
                        escondia a pergunta (contado nulo) mas deixava
                        `confirmandoFechamento` ligado — "Fechar caixa" ficava
                        desabilitado sem motivo à vista, e ao redigitar a
                        pergunta voltava sozinha com o esperado de quando foi
                        feita, sem reler. A pergunta era sobre o número de
                        antes: número novo, pergunta nova, com esperado relido.
                      */
                      setConfirmandoFechamento(false);
                    }}
                    placeholder="0,00"
                    className="text-right"
                  />
                )}
              </Field>
            </div>
            <Button
              variant="danger"
              loading={ocupado && !confirmandoFechamento}
              disabled={
                ocupado
                || confirmandoFechamento
                || contadoCents === null
                || !summary
                || vendasNaFila > 0
                || Boolean(pendFechamento && !cienciaCompleta(pendFechamento.ciente, pendFechamento.motivo))
              }
              onClick={() => void pedirFechamento()}
            >
              Fechar caixa
            </Button>
          </div>
          {resumoFalhou && (
            <div
              role="alert"
              data-testid="caixa-gestao-resumo-falhou"
              className="mt-4 flex flex-wrap items-center gap-3 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
            >
              <span>
                Não foi possível carregar o resumo do turno. Sem o esperado não dá para conferir a gaveta,
                e o fechamento fica travado até ele carregar.
              </span>
              <Button size="sm" variant="secondary" onClick={() => void carregarResumo(current)}>
                Tentar de novo
              </Button>
            </div>
          )}
          {vendasNaFila > 0 && (
            <p
              role="alert"
              data-testid="caixa-gestao-fila-offline"
              className="mt-4 mb-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
            >
              {vendasNaFila} venda(s) guardada(s) neste computador ainda não subiram para o servidor. Envie pela
              barra do topo antes de fechar: fechada a gaveta, o servidor recusa a venda deste turno.
            </p>
          )}
          {confirmandoFechamento && contadoCents !== null && (
            <div
              role="alertdialog"
              aria-label="Confirmar fechamento do turno"
              data-testid="caixa-gestao-confirmar-fechamento"
              className="mt-4 rounded-[var(--gs-radius)] border border-[var(--gs-danger)]
                bg-[var(--gs-danger-bg)] px-4 py-3 flex flex-col gap-2"
            >
              <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                Fechar o turno grava a contagem; desfazer só pela reabertura, no mesmo dia e com alçada.
              </p>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text)]">
                Contado <strong>{formatCents(contadoCents)}</strong> contra o esperado{' '}
                <strong>{summary ? formatCents(summary.expectedCents) : '—'}</strong>
                {summary && contadoCents !== summary.expectedCents && (
                  <>
                    {' '}({contadoCents > summary.expectedCents ? 'sobra' : 'falta'}{' '}
                    {formatCents(Math.abs(contadoCents - summary.expectedCents))})
                  </>
                )}
                .
              </p>
              <div className="flex flex-wrap gap-2 justify-end">
                <Button variant="secondary" disabled={ocupado} onClick={() => setConfirmandoFechamento(false)}>
                  Voltar
                </Button>
                <Button
                  variant="danger"
                  loading={ocupado}
                  disabled={
                    !summary
                    || vendasNaFila > 0
                    || Boolean(pendFechamento && !cienciaCompleta(pendFechamento.ciente, pendFechamento.motivo))
                  }
                  onClick={() => void close()}
                >
                  Confirmar fechamento
                </Button>
              </div>
            </div>
          )}
          {pendFechamento && (
            <div className="mt-4">
              <PendenciasDoFechamento
                pendencias={pendFechamento.p}
                ciente={pendFechamento.ciente}
                motivo={pendFechamento.motivo}
                onCiente={(v) => setPendFechamento((a) => (a ? { ...a, ciente: v } : a))}
                onMotivo={(v) => setPendFechamento((a) => (a ? { ...a, motivo: v } : a))}
              />
            </div>
          )}
        </Card>
      ) : (
        <Card title="Abertura de caixa">
          {precisaEscolherCaixa ? (
            // Com caixas cadastrados, a gaveta abre NUM caixa (GAP-PRD-039).
            <EscolhaDoCaixa
              onEscolher={(id) => escolherCaixa(id)}
              recusado={infoDoCaixa?.terminalRecusado ?? null}
            />
          ) : (
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-56">
              <Field label="Fundo de troco" hint="Aceita 0,00" error={erroDoFundo}>
                {(p) => (
                  <Input
                    {...p}
                    value={opening}
                    onChange={(e) => setOpening(e.target.value)}
                    className="text-right"
                  />
                )}
              </Field>
            </div>
            <Button
              loading={ocupado}
              disabled={aberturaCents === null || Boolean(erroDoFundo)}
              onClick={() => void open()}
            >
              Abrir caixa
            </Button>
          </div>
          )}
        </Card>
      )}

      {/*
        TODAS AS GAVETAS ABERTAS (GAP-PRD-131): a esquecida de outro dia — de
        qualquer caixa — aparece aqui, e o gestor a conta e fecha sem ir ao
        computador dela.

        MENOS A DO TURNO CORRENTE (H-caixa-seguranca-M02, a metade que faltou):
        `/cash/drawers` devolve todas as abertas, inclusive a do card "Caixa
        aberto" logo acima — e a mesma gaveta ganhava um segundo botão de
        fechar, sem as guardas daquele card. Ela é fechada lá, só lá.
      */}
      <div className="mt-6">
        <GavetasAbertasCard
          semAGaveta={current?.id ?? null}
          recarregarEm={gavetasTick}
          onFechou={() => {
            void reload();
            void recarregarTurnos();
          }}
        />
      </div>

      <div className="mt-6">
        <Card
          title="Turnos anteriores"
          subtitle="Quem abriu, quem fechou e a diferença de cada fechamento"
          padded={false}
        >
          {turnosError ? (
            <p role="alert" className="m-0 px-4 py-3 text-[var(--gs-danger)]">
              {turnosError}
            </p>
          ) : (
            <>
              {/*
                O MOTIVO DA REABERTURA fica FORA da linha e ANTES do botão.

                Reabrir um turno é desfazer uma conferência já assinada, e a
                pergunta que alguém vai fazer daqui a um mês é "por que este
                turno foi reaberto?". O campo vive aqui, e não dentro da célula,
                porque só existe UM turno reabrível por vez — repeti-lo em cada
                linha sugeriria que qualquer uma delas aceita.
              */}
              {ultimoFechado && podeReabrir(ultimoFechado) && (
                <div className="px-4 py-3 border-b border-[var(--gs-border)] flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[240px]">
                    <Field
                      label="Motivo da reabertura"
                      hint="Vai para a auditoria e para a trilha do turno — é o que responde 'por que este turno foi reaberto?' depois."
                    >
                      {(p) => (
                        <Input
                          {...p}
                          value={motivoDaReabertura}
                          onChange={(e) => setMotivoDaReabertura(e.target.value)}
                          placeholder="Ex.: faltou lançar a sangria do fim da tarde"
                        />
                      )}
                    </Field>
                  </div>
                  <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] max-w-md">
                    Só o último turno fechado hoje pode ser reaberto, e a conferência dele não é
                    apagada: fica guardada na trilha do turno.
                    {/*
                      A CONDIÇÃO SE EXPLICA ANTES DO CLIQUE, em vez de virar 403
                      depois dele. O botão continua existindo para quem não tem
                      alçada — escondê-lo negaria uma saída que o servidor
                      oferece, e o balcão voltaria a resolver chamando o gerente
                      para trocar de usuário no terminal (nenhum rastro dos dois
                      nomes) ou empurrando o lançamento para o turno seguinte,
                      que é o defeito de origem.
                    */}
                    {!reabreDireto && (
                      <>
                        {' '}
                        Reabrir é decisão de quem responde pela operação: você pode fazer por aqui
                        com a liberação de um gestor — ele digita a credencial na hora, o sistema
                        registra os dois nomes, e a liberação vale uma vez só para este turno.
                      </>
                    )}
                  </p>
                </div>
              )}
              <DataTable
                columns={[
                  {
                    header: 'Aberto por',
                    render: (r: TurnoDeCaixa) => r.opened_by_name ?? '—',
                  },
                  {
                    // Turno aberto não tem fechador — e inventar um nome aqui
                    // seria apontar dedo para quem ainda está trabalhando.
                    header: 'Fechado por',
                    render: (r: TurnoDeCaixa) =>
                      r.closed_by_name ?? <span className="text-[var(--gs-muted)]">—</span>,
                  },
                  {
                    header: 'Esperado',
                    align: 'right',
                    render: (r: TurnoDeCaixa) =>
                      r.expected_cents === null ? '—' : formatCents(r.expected_cents),
                  },
                  {
                    header: 'Contado',
                    align: 'right',
                    render: (r: TurnoDeCaixa) =>
                      r.counted_cents === null ? '—' : formatCents(r.counted_cents),
                  },
                  {
                    header: 'Diferença',
                    align: 'right',
                    // Vermelho SÓ quando não bate: pintar o zero também
                    // ensinaria o olho a ignorar a cor.
                    render: (r: TurnoDeCaixa) =>
                      r.difference_cents === null ? (
                        '—'
                      ) : (
                        <span
                          className={
                            r.difference_cents !== 0
                              ? 'text-[var(--gs-danger)] font-semibold'
                              : undefined
                          }
                        >
                          {formatCents(r.difference_cents)}
                        </span>
                      ),
                  },
                  {
                    header: 'Quando',
                    render: (r: TurnoDeCaixa) => (
                      <span className="text-[length:var(--gs-text-sm)]">
                        {`${dataHoraBR(r.opened_at)} → ${
                          r.closed_at ? dataHoraBR(r.closed_at) : 'ainda aberto'
                        }`}
                        {/*
                          O turno reaberto se declara. Sem esta marca, uma
                          gaveta que foi fechada, reaberta e fechada de novo
                          teria a mesma cara de uma que fechou uma vez — e a
                          conferência guardada na trilha ficaria invisível.
                        */}
                        {(r.reopen_count ?? 0) > 0 && (
                          <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
                            reaberto {r.reopen_count}
                            {r.reopen_count === 1 ? ' vez' : ' vezes'}
                            {r.reopen_reason ? ` — ${r.reopen_reason}` : ''}
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    header: '',
                    render: (r: TurnoDeCaixa) =>
                      podeReabrir(r) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={reabrindo === r.id}
                          onClick={() => void reabrir(r.id)}
                        >
                          Reabrir turno
                        </Button>
                      ) : null,
                  },
                ]}
                rows={turnos ?? []}
                keyOf={(r) => r.id}
                empty={
                  <EmptyState
                    title="Nenhum turno registrado"
                    description="Cada abertura e fechamento de caixa desta operação aparece aqui."
                  />
                }
              />
              {/*
                Lista do tamanho do pedido = pode haver mais no servidor; menor
                = o histórico acabou e o botão só prometeria o nada.
              */}
              {(turnos?.length ?? 0) >= limiteDeTurnos && (
                <div className="px-4 py-3 border-t border-[var(--gs-border)]">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={turnosLoading}
                    onClick={() => setLimiteDeTurnos((l) => l + TURNOS_POR_PAGINA)}
                  >
                    Mostrar mais
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {/*
        O DIÁLOGO DA LIBERAÇÃO — a última linha que faltava do caminho.

        O servidor recusa com `CORE_REOPEN_NEEDS_AUTHORIZATION` justamente para
        que aqui se possa abrir isto em vez de pintar uma faixa. É o MESMO
        componente do desconto do PDV e do cancelamento de venda: existe uma
        autorização neste sistema, e ela tem uma cara só.
      */}
      {liberacaoPedida && (
        <AutorizacaoGerenteDialog
          motivo={
            `Reabertura do turno de caixa${
              liberacaoPedida.motivo ? ` — ${liberacaoPedida.motivo}` : ''
            }. O fechamento atual vai para a trilha do turno, e os dois nomes ficam registrados.`
          }
          busy={liberacaoBusy}
          error={liberacaoErro}
          onCancel={() => {
            setLiberacaoPedida(null);
            setLiberacaoErro(null);
          }}
          onConfirm={(login, password) => void autorizarEContinuar(login, password)}
        />
      )}
    </AppShell>
  );
}

// -------------------------------------------------------------------- vendas

/**
 * ============================================================================
 * O RASTRO DO ITEM CANCELADO, LIDO POR GENTE — GAP-V52/V63
 * ============================================================================
 *
 * ## O defeito
 *
 * `core_sale_removed_items` guarda cada linha que saiu do carrinho antes do
 * Finalizar, `GET /core/sales/:id` devolve o bloco `removedItems` — e nenhuma
 * tela de gestão o exibia. O rastro existe para PREVENÇÃO DE PERDA: o desvio de
 * balcão clássico é bipar, mostrar o total ao cliente, remover uma linha e
 * fechar por menos. Um rastro que só o SQLite lê não previne nada; ele apenas
 * permite reconstruir a história depois que alguém já desconfiou por outro
 * caminho — e ninguém desconfia, porque não há de onde.
 *
 * ## O que a tela mostra, e por que cada coluna está aqui
 *
 *   PRODUTO em texto, do retrato gravado na remoção: o cadastro pode ter sido
 *   renomeado ou apagado desde então, e a pergunta é sobre o que foi mostrado
 *   ao cliente naquele dia.
 *   QUANTIDADE, porque a unidade da suspeita é a peça e não o clique.
 *   VALOR unitário e o total da linha — é o total que dimensiona a suspeita:
 *   uma remoção de R$ 4,90 é engano de balcão, uma de R$ 900,00 não é.
 *   QUEM tirou, por NOME. A pergunta é sobre gente, e um UUID não a responde.
 *   QUANDO, com hora: a distância entre a remoção e o fechamento é parte da
 *   leitura.
 *
 * ## "NENHUM" É UMA RESPOSTA, e por isso o bloco não some
 *
 * Esconder a seção na venda limpa faria "nenhuma remoção" ficar
 * indistinguível de "esta tela não sabe" — que é exatamente o pecado do rodapé
 * do PDV com o "0" literal, o defeito que originou esta tabela.
 */
function ItensCanceladosDaVenda({ itens }: { itens: SaleRemovedItem[] }) {
  return (
    <section data-testid="venda-itens-cancelados" className="flex flex-col gap-2">
      <h3 className="m-0 text-[length:var(--gs-text-base)] font-bold text-[var(--gs-purple-900)]">
        Itens cancelados no carrinho
      </h3>
      {itens.length === 0 ? (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Nenhum item saiu do carrinho antes do Finalizar nesta venda.
        </p>
      ) : (
        <>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Foram mostrados ao cliente e retirados antes de fechar. Não foram cobrados e não
            baixaram estoque.
          </p>
          <DataTable
            columns={[
              { header: 'Produto', render: (r: SaleRemovedItem) => r.name },
              {
                header: 'Qtd.',
                align: 'right',
                render: (r: SaleRemovedItem) => formatQuantity(r.quantity),
              },
              {
                header: 'Valor unit.',
                align: 'right',
                render: (r: SaleRemovedItem) => formatCents(r.unit_price_cents),
              },
              {
                header: 'Total retirado',
                align: 'right',
                // Os centavos são inteiros e a quantidade pode ser fracionada
                // (granel): arredondar aqui é o mesmo que o servidor faz na
                // venda, e não uma conta nova.
                render: (r: SaleRemovedItem) =>
                  formatCents(Math.round(r.unit_price_cents * r.quantity)),
              },
              {
                header: 'Quem tirou',
                /*
                  O NOME VEM DA FICHA, e não de uma segunda consulta.

                  Esta coluna cruzava o id com `GET /core/sellers` — rota de
                  BALCÃO, que não alcança todo perfil que chega a esta tela: o
                  estoquista tomava 403 e lia UUID. Agora o servidor devolve
                  `removed_by_name` junto do rastro, resolvido onde a tabela de
                  usuários mora.

                  Nulo continua sendo estado: conta apagada ou id de fora da
                  operação não têm nome, e aí o identificador é o que há — é
                  melhor que uma linha em branco, que faria parecer que ninguém
                  removeu nada. O rastro vale mais que o nome.
                */
                render: (r: SaleRemovedItem) =>
                  r.removed_by ? (r.removed_by_name ?? r.removed_by) : 'não identificado',
              },
              {
                header: 'Quando',
                render: (r: SaleRemovedItem) => dataHoraBR(r.removed_at),
              },
            ]}
            rows={itens}
            keyOf={(r) => r.id}
          />
        </>
      )}
    </section>
  );
}

/** Linhas por página de Vendas — o padrão que a rota sempre usou. */
const VENDAS_POR_PAGINA = 200;

export function VendasPage() {
  /*
    A PÁGINA (GAP-PRD-070). A rota sempre devolveu `total`, e o wrapper o
    jogava fora: um dia com 1.180 vendas mostrava 200 sem dizer. Agora o
    rodapé conta e anda.
  */
  const [offset, setOffset] = useState(0);
  const { data: pagina, error, loading } = useLoader(
    () => paginaDeVendas({ limit: VENDAS_POR_PAGINA, offset }),
    [offset],
  );
  const data = pagina?.items ?? null;

  /**
   * A VENDA QUE VEIO PELO LINK — `/sistema/vendas?venda=<id>`.
   *
   * O contas a receber diz "Venda #12" e agora navega até ELA. Antes o link
   * parava na lista inteira, e quem clicou tinha de procurar a #12 no meio de
   * quinhentas linhas — o mesmo gesto que o link prometia poupar.
   *
   * O recorte é feito no que JÁ chegou, e não numa segunda consulta: a lista é
   * a mesma resposta de sempre, e uma rota nova só para "uma venda" criaria um
   * segundo caminho para a mesma pergunta. Se o id não existir na lista (venda
   * de outro período, por exemplo), o recorte fica vazio e o aviso continua na
   * tela dizendo qual venda foi pedida — vazio silencioso seria lido como
   * "sumiram as vendas".
   */
  const [paramsDaUrl] = useSearchParams();
  const vendaPedida = paramsDaUrl.get(PARAM_DA_VENDA);
  /*
    A VENDA DO LINK FORA DA PÁGINA. Com a lista em página, a venda antiga do
    contas a receber pode não estar entre as que chegaram — e o recorte ficaria
    vazio. Nesse caso (e só nele) a tela pergunta pela venda em si, pela mesma
    ficha que o botão "Abrir" usa.
  */
  const [vendaDoLink, setVendaDoLink] = useState<Sale | null>(null);
  useEffect(() => {
    if (!vendaPedida || !data || data.some((v) => v.id === vendaPedida)) {
      setVendaDoLink(null);
      return;
    }
    let vivo = true;
    coreApi
      .getSale(vendaPedida)
      .then((venda) => {
        if (vivo && venda?.id === vendaPedida) setVendaDoLink(venda);
      })
      .catch(() => {
        if (vivo) setVendaDoLink(null);
      });
    return () => {
      vivo = false;
    };
  }, [vendaPedida, data]);
  const recorteDoLink = (data ?? []).filter((v) => v.id === vendaPedida);
  const vendas = vendaPedida
    ? recorteDoLink.length > 0
      ? recorteDoLink
      : vendaDoLink
        ? [vendaDoLink]
        : []
    : (data ?? []);

  /**
   * A ficha da venda aberta.
   *
   * Vem do GET, e nunca da linha da lista: a lista traz número, data, situação
   * e total, e mais nada — itens, pagamentos e o rastro dos cancelados só
   * existem no detalhe. Montar a ficha em cima da linha produziria blocos
   * vazios com cara de verdade.
   */
  const [ficha, setFicha] = useState<SaleDetail | null>(null);
  const [abrindo, setAbrindo] = useState<number | null>(null);
  const [erroFicha, setErroFicha] = useState<string | null>(null);

  /*
    A CONSULTA À EQUIPE SAIU DAQUI — costura fechada.

    Esta tela buscava `GET /core/sellers` só para virar o `removed_by` do rastro
    em nome. A rota é de BALCÃO e não alcança todo perfil que chega a Vendas: o
    estoquista tomava 403, o catch engolia, e a coluna "quem tirou" mostrava
    UUID justamente para quem mais precisa lê-la. Agora o NOME vem na própria
    ficha (`removed_by_name`), resolvido pelo servidor, que é quem tem a tabela
    de usuários — uma pergunta a menos e uma régua a menos fora do servidor.
  */

  const abrirFicha = useCallback(async (venda: Sale) => {
    setErroFicha(null);
    setPapel(null);
    setAbrindo(venda.number);
    try {
      setFicha(await coreApi.getSale(venda.id));
    } catch (err) {
      setFicha(null);
      setErroFicha(
        err instanceof ApiRequestError ? err.message : 'Falha ao abrir a ficha da venda.',
      );
    } finally {
      setAbrindo(null);
    }
  }, []);

  /*
    ============================================================================
    A SEGUNDA VIA DO COMPROVANTE (P00 da impressão da loja)
    ============================================================================

    O DEFEITO: o comprovante de uma venda só podia ser impresso no painel de
    "venda concluída" do PDV, que existe pelos segundos entre fechar a venda e
    o caixa apertar Esc (ou começar a próxima). Passado esse instante, NÃO
    HAVIA no sistema inteiro um jeito de imprimir de novo o cupom da venda #340:
    a lista de Vendas abre a ficha com itens, pagamentos e títulos, e nenhum
    botão de papel. O cliente que volta pedindo a via — para a troca, para a
    garantia, para o reembolso da empresa dele — ouvia que o sistema não
    imprime. O motor sempre soube fazê-lo (`POST /print/jobs` aceita
    SALE_RECEIPT e DANFCE, e alcança todo perfil que chega a esta tela): era
    rota sem tela.

    O PAPEL É ESCOLHIDO PELO ESTADO FISCAL DE AGORA, e não pela linha da lista
    — o mesmo cuidado de `escolherPapel` no PDV (F-cupom-fiscal-M02). Com a
    NFC-e autorizada (ou em contingência, cujo DANFCE já vale no balcão), a via
    é o DANFCE; sem nota, é o comprovante NÃO fiscal, que é o que aquela venda
    gerou. Entregar o comprovante a quem tem nota autorizada seria dar ao
    cliente o papel errado.

    Venda CANCELADA imprime com a tarja "VENDA CANCELADA — não vale como
    comprovante de compra" (o renderizador já a põe, F-19): o pedido é legítimo
    (a troca precisa do papel do que foi desfeito) e o papel não mente.
  */
  const [papel, setPapel] = useState<{ tom: 'ok' | 'erro'; texto: string } | null>(null);
  const [imprimindo, setImprimindo] = useState(false);

  const segundaVia = useCallback(async (venda: SaleDetail) => {
    setPapel(null);
    setImprimindo(true);
    try {
      // Sem resposta do fiscal (rede, servidor antigo), o papel é o comprovante
      // — o mesmo desfecho do PDV: nunca deixar o cliente sem nada na mão.
      const s = await coreApi.getFiscalStatusForSale(venda.id).catch(() => null);
      const doc = s?.document;
      const temDanfce = Boolean(doc && (doc.status === 'AUTHORIZED' || s?.contingencia?.pendente));
      const feita = temDanfce
        ? await printDocument('DANFCE', String(doc!.id))
        : await printDocument('SALE_RECEIPT', venda.id);
      setPapel({
        tom: 'ok',
        texto:
          `Segunda via da venda #${venda.number}: ${temDanfce ? 'DANFCE da NFC-e' : 'comprovante não fiscal'}`
          + `${feita?.aviso ? ` — saiu pelo navegador: ${feita.aviso}` : '.'}`,
      });
    } catch (err) {
      setPapel({
        tom: 'erro',
        texto: `Não foi possível imprimir a segunda via: ${
          err instanceof Error && err.message ? err.message : 'confira a impressora e tente de novo.'
        }`,
      });
    } finally {
      setImprimindo(false);
    }
  }, []);

  return (
    <AppShell>
      <PageHeader breadcrumb={['Vendas']} title="Vendas" />
      <Feedback error={error} loading={loading} />
      {erroFicha && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erroFicha}
        </div>
      )}
      {/*
        O RECORTE SE DECLARA, e tem saída.

        Filtrar em silêncio é a mesma doença do link que não chega: quem abriu
        esta tela por outro caminho leria "sumiram as vendas". A frase diz o que
        está na tela e o link ao lado devolve a lista inteira em um clique.
      */}
      {vendaPedida && (
        <div className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-muted)]
          flex flex-wrap items-center gap-3 text-[length:var(--gs-text-sm)]">
          <span>
            Mostrando só a venda que veio do link
            {vendas.length === 1 ? ` — #${vendas[0].number}` : ''}.
            {vendas.length === 0 && ' Ela não está nesta listagem.'}
          </span>
          <Link to="/sistema/vendas" className="text-[var(--gs-purple-700)] underline">
            Ver todas as vendas
          </Link>
        </div>
      )}
      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Nº', render: (r: Sale) => `#${r.number}` },
            {
              header: 'Data',
              render: (r: Sale) => new Date(r.created_at).toLocaleString('pt-BR'),
            },
            {
              header: 'Situação',
              render: (r: Sale) =>
                r.status === 'cancelled' ? (
                  <Badge tone="danger">Cancelada</Badge>
                ) : (
                  <Badge tone="success">Concluída</Badge>
                ),
            },
            { header: 'Total', align: 'right', render: (r: Sale) => formatCents(r.total_cents) },
            {
              header: 'Ficha',
              align: 'right',
              render: (r: Sale) => (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={abrindo === r.number}
                  aria-label={`Abrir a venda #${r.number}`}
                  onClick={() => void abrirFicha(r)}
                >
                  Abrir
                </Button>
              ),
            },
          ]}
          rows={vendas}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhuma venda registrada"
              description="As vendas concluídas no PDV aparecem aqui."
            />
          }
        />
        {/* O rodapé é da LISTA; com o recorte do link na tela ele mentiria. */}
        {!vendaPedida && (
          <Paginacao
            pagina={pagina ? { ...pagina, quantidade: pagina.items.length } : null}
            rotulo={{ singular: 'venda', plural: 'vendas' }}
            onMudar={setOffset}
            carregando={loading}
          />
        )}
      </Card>

      {ficha && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          ref={prenderFoco}
          tabIndex={-1}
          aria-label={`Venda #${ficha.number}`}
        >
          <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
            <header className="px-6 py-4 border-b border-[var(--gs-border)] flex items-center justify-between gap-4">
              <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
                Venda #{ficha.number} — {formatCents(ficha.total_cents)}
              </h2>
              <span className="flex gap-2">
                {/* Segunda via NÃO refaz a venda: é um papel novo para o mesmo
                    documento — sem estoque, sem caixa, sem nota nova. */}
                <Button
                  variant="secondary"
                  size="sm"
                  loading={imprimindo}
                  onClick={() => void segundaVia(ficha)}
                  title="Imprime de novo o papel desta venda: o DANFCE, se houver NFC-e autorizada; senão, o comprovante não fiscal."
                >
                  Segunda via do comprovante
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Fechar a ficha da venda"
                  onClick={() => setFicha(null)}
                >
                  Fechar
                </Button>
              </span>
            </header>
            <div className="px-6 py-5 flex flex-col gap-6">
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {dataHoraBR(ficha.created_at)}
                {ficha.status === 'cancelled' ? ' · venda cancelada' : ''}
              </p>
              {papel && (
                <p
                  data-testid="papel-da-venda"
                  role={papel.tom === 'erro' ? 'alert' : 'status'}
                  className={`m-0 px-4 py-3 rounded-[var(--gs-radius)] text-[length:var(--gs-text-sm)] ${
                    papel.tom === 'erro'
                      ? 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
                      : 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
                  }`}
                >
                  {papel.texto}
                </p>
              )}
              {ficha.status === 'cancelled' && (
                <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                  Esta venda foi cancelada: a segunda via sai com a tarja &quot;VENDA CANCELADA — não vale como
                  comprovante de compra&quot;.
                </p>
              )}

              <section className="flex flex-col gap-2">
                <h3 className="m-0 text-[length:var(--gs-text-base)] font-bold text-[var(--gs-purple-900)]">
                  Itens vendidos
                </h3>
                <DataTable
                  columns={[
                    { header: 'Produto', render: (i: SaleDetail['items'][number]) => i.description },
                    {
                      header: 'Qtd.',
                      align: 'right',
                      render: (i: SaleDetail['items'][number]) => formatQuantity(i.quantity),
                    },
                    {
                      header: 'Valor unit.',
                      align: 'right',
                      render: (i: SaleDetail['items'][number]) => formatCents(i.unit_price_cents),
                    },
                    {
                      header: 'Total',
                      align: 'right',
                      render: (i: SaleDetail['items'][number]) => formatCents(i.total_cents),
                    },
                  ]}
                  rows={ficha.items ?? []}
                  keyOf={(i) => i.id}
                />
                {/*
                  O VALE NÃO ESTÁ EM `payments`, e a ficha teria de mentir sem
                  esta linha: a venda de R$ 100 paga com R$ 30 de crédito
                  mostraria R$ 70 recebidos contra R$ 100 de total, e quem
                  lesse concluiria que faltou dinheiro.
                */}
                {ficha.customerCreditCents > 0 && (
                  <p className="m-0 text-[length:var(--gs-text-sm)]">
                    Crédito de loja usado:{' '}
                    <strong>{formatCents(ficha.customerCreditCents)}</strong> — abateu o total sem
                    entrar como pagamento, porque é dívida da loja extinta, não dinheiro que
                    entrou.
                  </p>
                )}
              </section>

              {/*
                ------------------------------------- o que a venda gerou a cobrar

                O SERVIDOR SEMPRE MANDOU; NINGUÉM LIA. `GET /core/sales/:id`
                devolve `financeEntries` — os títulos daquela venda — com teste
                de servidor verde desde a V22, e a única ocorrência do campo em
                `src/` inteiro estava em mocks de teste. Quem abria a venda para
                responder "isso já foi pago?" saía da ficha, ia ao contas a
                receber e procurava pelo texto da descrição: exatamente o gesto
                que a rastreabilidade existe para apagar.

                POR QUE `TitulosDoDocumento`, o mesmo das fichas de nota e de
                pedido: ele NÃO CONSULTA NADA. Recebe a lista pronta por
                propriedade; quem pergunta é a tela. Reusá-lo aqui não custa a
                segunda requisição que se poderia temer — a venda já traz os
                títulos na própria resposta. Perguntar de novo em
                `GET /finance/entries` seria uma segunda pergunta para uma
                resposta já na mão, com um estado de carregamento a mais e um
                403 a mais: aquela rota não alcança todo perfil que chega a
                Vendas, e foi por isso que `GET /core/sellers` teve de sair
                deste mesmo modal.

                LISTA AUSENTE NÃO É LISTA VAZIA. Servidor de versão anterior
                (ou proxy que cortou o corpo) não manda o campo, e desenhar
                "Nenhum título" nesse caso diria que a venda não cobra ninguém
                — a mentira mais cara que uma tela de cobrança pode contar. Aí
                o bloco declara a falha, no mesmo lugar onde mostraria a lista.
              */}
              <section data-testid="venda-titulos-do-financeiro">
                <TitulosDoDocumento
                  titulo="O que esta venda gerou no financeiro"
                  subtitulo="Os títulos criados no fechamento — parcela a parcela, com o que ainda cobra o cliente."
                  titulos={ficha.financeEntries ?? null}
                  erro={
                    ficha.financeEntries
                      ? null
                      : 'O servidor respondeu sem "financeEntries": não dá para dizer se esta venda '
                        + 'gerou título. A versão da tela pode estar diferente da versão do servidor.'
                  }
                />
              </section>

              <NotaDaVendaDeBalcao venda={ficha} />

              <ItensCanceladosDaVenda itens={ficha.removedItems ?? []} />
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

/**
 * ============================================================================
 * A NF-e (MODELO 55) DESTA VENDA — P0 fiscal
 * ============================================================================
 *
 * ## O defeito
 *
 * `createNfeForSale` existia inteiro no servidor — série do cadastro,
 * destinatário validado, município conferido na tabela do IBGE e a trava de
 * "um documento vivo por venda" — e NENHUM caminho o chamava fora dos testes.
 * A NF-e do sistema só saía de PEDIDO ONLINE. O cliente que compra no balcão
 * com CNPJ e pede a nota ficava sem caminho, embora o próprio domínio escreva
 * a regra do caso: quem vendeu no balcão e precisa da NF-e cancela o cupom,
 * dentro do prazo, e só então emite a nota.
 *
 * ## O DEFEITO QUE ESTA VERSÃO CONSERTA
 *
 * A seção perguntava por `/fiscal/sales/:id/status`, que responde SÓ pela
 * NFC-e. Para a venda documentada com a própria NF-e desta seção a resposta
 * era `null`: reaberta a ficha, a nota autorizada não aparecia em lugar
 * nenhum e o botão "Emitir NF-e desta venda" voltava a ser oferecido. Quem
 * errasse o CNPJ na primeira emissão "corrigia" e recebia a confirmação de
 * sucesso — com a nota antiga, que já tinha ido ao fisco.
 *
 * Agora a pergunta é `/fiscal/sales/:id/documentos`, que responde pelos DOIS
 * modelos e sob a MESMA capability do gesto (`fiscal.manage`), para que a
 * leitura e o botão nunca divirjam.
 *
 * ## O que esta seção mostra, e por quê
 *
 *  - NF-e desta venda, em qualquer estado: ela é mostrada, com número, série,
 *    situação e chave, e a emissão NÃO se oferece — uma venda tem uma nota. Se
 *    a nota estiver cancelada ou rejeitada, a tela diz onde se resolve
 *    (Fiscal › Documentos fiscais), que é onde estão o cancelamento e a
 *    reemissão;
 *  - NFC-e viva (qualquer estado que não seja cancelada ou rejeitada): a venda
 *    JÁ está documentada, e emitir a NF-e documentaria a mesma mercadoria duas
 *    vezes — faturamento e ICMS em dobro na apuração. A tela diz isso e diz o
 *    caminho: cancelar o cupom primeiro, dentro do prazo;
 *  - sem documento: o formulário do destinatário e o botão;
 *  - LEITURA QUE FALHOU NÃO É VENDA SEM NOTA: se o servidor não responde, a
 *    seção declara a falha e não oferece a emissão. Oferecer ali seria apostar
 *    que não há nota — a aposta que produziu este defeito.
 *
 * O ENDEREÇO É DIGITADO porque a loja não o tem — inventá-lo seria pôr dado
 * falso numa nota fiscal.
 */
/** O que a ficha sabe dos documentos desta venda: lendo, a leitura, ou a falha. */
type DocumentosDaVenda =
  | 'lendo'
  | 'falhou'
  | { items: FiscalSaleStatus[]; ufDoEmitente: string | null };

function NotaDaVendaDeBalcao({ venda }: { venda: SaleDetail }) {
  const podeEmitir = useCan('fiscal.manage');
  const [documentos, setDocumentos] = useState<DocumentosDaVenda>('lendo');
  // A nota que ACABOU de sair. Ela não substitui a leitura — some assim que a
  // releitura traz o mesmo fato —, mas garante que quem clicou veja o número
  // mesmo se a releitura falhar.
  const [emitida, setEmitida] = useState<EmissaoDaNotaDeDevolucao['document'] | null>(null);
  // O que o contador ainda deve nesta operação, como o servidor as declara na
  // emissão — a mesma régua das NF-e de devolução.
  const [pendencias, setPendencias] = useState<string[]>([]);
  const [form, setForm] = useState(() => rascunhoDoDestinatario(null));
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [emitindo, setEmitindo] = useState(false);

  useEffect(() => {
    if (!podeEmitir) return undefined;
    let vivo = true;
    setDocumentos('lendo');
    coreApi
      .getDocumentosFiscaisDaVenda(venda.id)
      .then((r) => vivo && setDocumentos(r))
      // Leitura que falhou NÃO é venda sem nota: a seção declara a falha e não
      // oferece a emissão. Oferecer aqui seria apostar que não há documento.
      .catch(() => vivo && setDocumentos('falhou'));
    return () => {
      vivo = false;
    };
  }, [venda.id, podeEmitir]);

  if (!podeEmitir || documentos === 'lendo') return null;

  const lidos = documentos === 'falhou' ? [] : documentos.items;
  const ufDoEmitente = documentos === 'falhou' ? null : documentos.ufDoEmitente;
  // A NF-e da venda em QUALQUER estado: uma venda tem uma nota, e cancelada ou
  // rejeitada se resolve em Fiscal › Documentos fiscais, não com uma segunda.
  const daLeitura = lidos.find((d) => d.document.model === '55') ?? null;
  const cupom = lidos.find((d) => d.document.model === '65') ?? null;
  const cupomVivo = cupom && !['CANCELLED', 'REJECTED'].includes(cupom.document.status) ? cupom : null;
  const difal = avisoDoDifal(form, ufDoEmitente);
  // A leitura manda; a nota recém-emitida só cobre o instante entre o clique e
  // a releitura (e a releitura que falhou).
  const nota = daLeitura
    ? { ...daLeitura.document, rotulo: daLeitura.statusLabel }
    : emitida
      ? { ...emitida, rotulo: emitida.status }
      : null;

  async function emitir() {
    setEmitindo(true);
    setErro(null);
    try {
      const r = await coreApi.emitirNfeDaVenda(venda.id, destinatarioParaEnvio(form));
      setEmitida(r.document);
      setPendencias(r.pendencias ?? []);
      /*
        A ficha é RELIDA do servidor: é a leitura que decide o que a seção
        mostra daqui em diante. Foi por confiar na memória da tela — e não na
        resposta do servidor — que a nota sumia ao reabrir a ficha.
      */
      const relida = await coreApi.getDocumentosFiscaisDaVenda(venda.id).catch(() => null);
      if (relida) setDocumentos(relida);
      setAberto(false);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao emitir a NF-e desta venda.');
    } finally {
      setEmitindo(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="nfe-da-venda">
      <h3 className="m-0 text-[length:var(--gs-text-base)] font-bold text-[var(--gs-purple-900)]">
        NF-e desta venda
      </h3>

      {documentos === 'falhou' ? (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          Não foi possível ler os documentos fiscais desta venda. Sem essa resposta não dá para
          dizer se ela já tem nota — e emitir sem saber criaria a segunda. Recarregue a ficha.
        </p>
      ) : nota ? (
        <>
          <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold" data-testid="nfe-da-venda-emitida">
            NF-e {nota.number}, série {nota.serie} — {nota.status}
            {nota.protocol ? ` · protocolo ${nota.protocol}` : ''}
          </p>
          {nota.accessKey && (
            <p className="m-0 font-mono break-all text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {nota.accessKey}
            </p>
          )}
          {['CANCELLED', 'REJECTED'].includes(nota.status) && (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Esta venda não recebe uma segunda NF-e: a nota ({nota.rotulo}) se resolve em Fiscal ›
              Documentos fiscais, onde ficam a reemissão da rejeitada (mesmo número) e o histórico
              do cancelamento.
            </p>
          )}
          {/* O que o contador ainda deve, declarado junto da nota que saiu. */}
          {pendencias.map((p) => (
            <p key={p} className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              {p}
            </p>
          ))}
        </>
      ) : cupomVivo ? (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Esta venda já tem NFC-e nº {cupomVivo.document.number} ({cupomVivo.statusLabel}). Emitir
          também a NF-e documentaria a mesma mercadoria duas vezes. Para trocar de documento,
          cancele o cupom em Fiscal › Documentos fiscais — dentro do prazo de cancelamento.
        </p>
      ) : !aberto ? (
        <div>
          <p className="m-0 mb-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Para o cliente que pediu nota com CNPJ. A NF-e leva o endereço do destinatário com o
            código IBGE do município — a loja não o tem, então ele é informado aqui.
          </p>
          <Button size="sm" onClick={() => setAberto(true)}>
            Emitir NF-e desta venda
          </Button>
          {erro && (
            <p role="alert" className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
        </div>
      ) : (
        <div className="p-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]">
          <FormularioDoDestinatario valor={form} onMudar={setForm} />
          {/*
            O DIFAL NÃO É MONTADO POR NINGUÉM, e a tela diz isso ONDE se clica.
            A pendência já está declarada em Fiscal › Operações fiscais; aqui
            ela aparece no instante em que a UF do destinatário a torna real.
          */}
          {difal && (
            <p role="status" className="m-0 mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              {difal}
            </p>
          )}
          {erro && (
            <p role="alert" className="m-0 mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              loading={emitindo}
              disabled={!destinatarioCompleto(form)}
              onClick={() => void emitir()}
            >
              Emitir NF-e desta venda
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- financeiro

/*
  ============================================================================
  A INTERFACE LOCAL QUE MENTIA — e por que ela deixou de existir
  ============================================================================

  Esta tela declarava um `FinanceEntry` PRÓPRIO, em snake_case:

      amount_cents, settled_cents, due_date

  `GET /core/finance/entries` serializa SÓ camelCase — `FinanceService.toEntry`
  monta um objeto novo (`amountCents`, `settledCents`, `dueDate`), ele não
  devolve a linha crua do banco. Os nomes nunca bateram.

  O estrago era do tipo CONVINCENTE, que é o pior: descrição, tipo e situação
  têm o mesmo nome nos dois lados e funcionavam, então a tabela abria inteira,
  com os badges certos. Só o dinheiro e o vencimento quebravam — a coluna
  "Valor" caía em `formatCents(undefined)`, que não estoura: imprime "R$ NaN".
  E a coluna "Vencimento" imprimia "—" em TODA linha, que se lê como "nenhum
  destes títulos vence", e não como "a tela não sabe ler a resposta".

  O compilador não tinha como avisar: um tipo escrito à mão dentro da tela não
  é confrontado com nada. Por isso o conserto não foi renomear três campos —
  foi APAGAR o tipo local e usar o `FinanceEntry` já exportado por
  `@/lib/api/core`, o mesmo que `ContasPage` e `TitulosDoDocumento` leem. Um
  terceiro tipo para a mesma resposta é a próxima divergência marcada para
  acontecer; com um só, renomear um campo no contrato quebra a COMPILAÇÃO
  desta tela em vez de quebrar a coluna do dinheiro em silêncio.
*/
export function FinanceiroPage() {
  const { data, error, loading } = useLoader(
    // O desembrulho oficial: corpo sem `items` é contrato quebrado e tem de
    // cair no `catch` da tela — não virar `undefined` a caminho da tabela.
    () => coreApi.listFinanceEntries({}).then(envelope('items')),
    [],
  );

  return (
    <AppShell>
      <PageHeader breadcrumb={['Financeiro']} title="Financeiro" />
      <Feedback error={error} loading={loading} />
      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Descrição', render: (r: FinanceEntry) => r.description },
            {
              header: 'Tipo',
              render: (r: FinanceEntry) =>
                r.direction === 'in' ? (
                  <Badge tone="success">A receber</Badge>
                ) : (
                  <Badge tone="warning">A pagar</Badge>
                ),
            },
            {
              /*
                VENCIMENTO É DATA DE CALENDÁRIO, e `dataBR` é quem sabe disso.
                `new Date('2026-12-31')` é meia-noite de Greenwich, que em
                Pelotas é dia 30 — o erro que `src/lib/datas.ts` existe para
                impedir. Nulo continua virando "—", que aqui é resposta
                legítima (título à vista já quitado não tem vencimento).
              */
              header: 'Vencimento',
              render: (r: FinanceEntry) => dataBR(r.dueDate),
            },
            {
              header: 'Situação',
              render: (r: FinanceEntry) =>
                r.status === 'settled' ? (
                  <Badge tone="success">Liquidado</Badge>
                ) : r.status === 'cancelled' ? (
                  <Badge tone="danger">Cancelado</Badge>
                ) : (
                  <Badge tone="info">Em aberto</Badge>
                ),
            },
            {
              header: 'Valor',
              align: 'right',
              render: (r: FinanceEntry) => formatCents(r.amountCents),
            },
          ]}
          rows={data ?? []}
          keyOf={(r) => r.id}
          empty={
            /*
              VAZIO E "NÃO CONSEGUI PERGUNTAR" SÃO ESTADOS DIFERENTES.

              A falha já aparecia na faixa do `Feedback` — e logo abaixo dela a
              tabela afirmava "Nenhum lançamento", com a mesma cara de um dia
              sem cobrança. Duas frases contraditórias na mesma tela: quem lê a
              de baixo (que é a que ocupa o corpo da página) conclui que o
              financeiro está limpo. Sob erro, o corpo não afirma nada.
            */
            error ? (
              <EmptyState
                title="Não foi possível ler os lançamentos"
                description="A lista acima não está vazia — ela não chegou. Veja a mensagem no topo da tela."
              />
            ) : (
              <EmptyState
                title="Nenhum lançamento"
                description="Cada venda gera um único lançamento financeiro, que aparece aqui."
              />
            )
          }
        />
      </Card>
    </AppShell>
  );
}
