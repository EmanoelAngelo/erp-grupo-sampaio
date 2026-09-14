/**
 * Telas administrativas do gestor: movimentações de estoque, promoções,
 * pedidos online (OMS) e status das integrações.
 *
 * Todas leem as APIs que já existem — nenhuma inventa dado. Onde o módulo
 * depende de credencial externa, a tela diz exatamente o que falta em vez de
 * fingir que está pronto.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
} from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { TitulosDoDocumento } from '@/components/gs/TitulosDoDocumento';
import { DespachoDoPedido } from '@/components/gs/DespachoDoPedido';
import { EnvioDoPedido } from '@/components/gs/EnvioDoPedido';
import {
  BotaoCancelarPedido,
  BotaoDesfazerEtapa,
  BotaoDevolverPedido,
} from '@/components/gs/AcoesDoPedido';
import { RecebimentoDaDevolucao } from '@/components/gs/RecebimentoDaDevolucao';
import { SolicitacoesDeDevolucao } from '@/components/gs/SolicitacoesDeDevolucao';
import type { SolicitacaoDeDevolucao } from '@/lib/api/posVenda';
import { ApiRequestError, apiRequest, envelope, exigirCampos } from '@/lib/api/client';
import {
  coreApi,
  type FinanceEntry,
  type MunicipioDaNotaDoPedido,
  type OrderInvoiceReadiness,
} from '@/lib/api/core';
import { CidadeComSugestoes } from '@/components/gs/CidadeComSugestoes';
import type { MunicipioDoIbge } from '@/lib/api/municipios';
import { PARAM_DA_ENCOMENDA } from '@/lib/rotasDeOrigem';
import { Paginacao } from '@/components/gs/Paginacao';
import { lerPagina, type Pagina } from '@/lib/api/paginas';

function useLoader<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loader());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os dados.');
    } finally {
      setLoading(false);
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

// ------------------------------------------------------- movimentações

interface Movement {
  id: string;
  product_id: string;
  movement_type: string;
  quantity: number;
  reference_type: string;
  reference_id: string;
  balance_after: number;
  note: string | null;
  created_at: string;
}

const MOVEMENT_LABEL: Record<string, string> = {
  in: 'Entrada',
  out: 'Saída',
  adjust: 'Ajuste',
};

export function MovimentacoesPage() {
  const { data, error, loading } = useLoader(
    // O desembrulho oficial, não `(r) => r.items`: corpo sem a chave tem de
    // virar erro no `catch` da tela, nunca `undefined` viajando até o `.map`.
    () => apiRequest<{ items: Movement[] }>('/core/stock/movements').then(envelope('items')),
    [],
  );

  return (
    <AppShell>
      <PageHeader breadcrumb={['Estoque', 'Movimentações']} title="Movimentações de estoque" />
      <Feedback error={error} loading={loading} />
      <Card padded={false}>
        <DataTable
          columns={[
            {
              header: 'Data',
              render: (r: Movement) => new Date(r.created_at).toLocaleString('pt-BR'),
            },
            {
              header: 'Tipo',
              render: (r: Movement) =>
                r.quantity >= 0 ? (
                  <Badge tone="success">{MOVEMENT_LABEL[r.movement_type] ?? r.movement_type}</Badge>
                ) : (
                  <Badge tone="warning">{MOVEMENT_LABEL[r.movement_type] ?? r.movement_type}</Badge>
                ),
            },
            { header: 'Origem', render: (r: Movement) => r.reference_type },
            {
              header: 'Qtd.',
              align: 'right',
              render: (r: Movement) => formatQuantity(r.quantity),
            },
            {
              header: 'Saldo após',
              align: 'right',
              render: (r: Movement) => formatQuantity(r.balance_after),
            },
            { header: 'Observação', render: (r: Movement) => r.note ?? '—' },
          ]}
          rows={data ?? []}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhuma movimentação"
              description="Entradas, vendas e ajustes aparecem aqui na ordem em que aconteceram."
            />
          }
        />
      </Card>
    </AppShell>
  );
}

// ------------------------------------------------------------ promoções

/*
  A tela de Promoções mora em `PromocoesPage.tsx` desde o lote E5 da remediação
  (GAP-PRD-032/033/197/194): seletor de produto, edição, horário, estoque
  promocional e a recusa do servidor com as palavras dele. O nome continua
  exportado daqui para quem já o importava.
*/
export { PromocoesPage } from "./PromocoesPage";

// -------------------------------------------------------- pedidos / OMS

interface Order {
  id: string;
  number: number;
  customer_name: string;
  total_cents: number;
  status: string;
  tracking_code: string | null;
  created_at: string;
  /**
   * Pagamento confirmado pelo provedor DEPOIS do cancelamento. Dinheiro na
   * conta sem pedido para entregar: alguém da operação precisa devolver ou
   * refazer, e ninguém faz o que não vê.
   */
  payment_after_cancel?: number;
  /** Como o pedido chega ao cliente: decide as etapas que ele percorre. */
  shipping_method?: string | null;
  /** Quem leva a encomenda (GAP-PRD-119). */
  shipping_carrier?: string | null;
  /** A página pública de rastreio, montada pelo SERVIDOR. */
  tracking_url?: string | null;
  /**
   * A mercadoria do pedido reembolsado (GAP-PRD-122): 'aguardando' é o pacote
   * que ainda não voltou conferido — o estoque espera por ele.
   */
  return_goods_status?: string | null;
  /** O último pedido de devolução que a cliente abriu no portal (GAP-PRD-125). */
  return_request_status?: string | null;
}

/**
 * O VOCABULÁRIO E AS ETAPAS VÊM DO SERVIDOR.
 *
 * Aqui moravam três mapas fixos: rótulo, cor e próxima etapa. O último dizia
 * `embalado → expedido` para TODO pedido — e o padrão de toda loja do grupo é
 * RETIRADA. O servidor recusava com 409 ("a etapa é 'pronto para retirada'"),
 * a tela não conhecia esse estado, e o pedido ficava parado em "Embalado" com
 * a mercadoria no balcão e o cliente sem aviso nenhum.
 *
 * A lista de pedidos passou a trazer o vocabulário junto. A tela não decide
 * mais nada sobre estados: ela pergunta.
 */
interface VocabularioDePedido {
  entrega: string[];
  retirada: string[];
  rotulos: Record<string, string>;
}

/**
 * A COR é da tela — é decoração, e o servidor não tem opinião sobre ela.
 *
 * Estado sem cor cai em 'neutral', e não em nada: um badge sem tom some da
 * tela, e um pedido invisível é pior que um pedido cinza.
 */
const ORDER_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'info' | 'danger'> = {
  aguardando_pagamento: 'warning',
  pago: 'success',
  separacao: 'info',
  conferencia: 'info',
  embalado: 'info',
  expedido: 'info',
  pronto_para_retirada: 'success',
  entregue: 'success',
  cancelado: 'danger',
  reembolsado: 'danger',
};

/** Retirada termina no balcão; entrega, numa transportadora. */
function ehRetirada(metodo: string | null | undefined): boolean {
  const m = (metodo ?? '').toLowerCase();
  return m === 'retirada' || m === 'pickup';
}

/** Uma linha do que foi comprado. */
interface OrderItem {
  id: string;
  product_id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
}

/** Um passo da vida do pedido, como o servidor o gravou. */
interface OrderEvent {
  id: string;
  status: string;
  note: string | null;
  created_at: string;
  /** 'operador' | 'provedor' | 'cliente' | 'sistema'; nulo em evento antigo. */
  origin?: string | null;
}

/**
 * O PEDIDO ABERTO — o papel, e não a linha da lista.
 *
 * `GET /core/orders/:id` devolve a linha de `core_orders` com os itens e os
 * eventos junto. É este objeto que a ficha mostra.
 */
interface OrderDetail extends Order {
  /** O cupom da loja online (GAP-PRD-123): o código e quanto descontou, já rateado nos itens. */
  coupon_code?: string | null;
  discount_cents?: number | null;
  customer_email?: string | null;
  shipping_address?: string | null;
  shipping_service_name?: string | null;
  items: OrderItem[];
  events: OrderEvent[];
  /**
   * OS TÍTULOS QUE ESTE PEDIDO GEROU — a VOLTA da rastreabilidade
   * (V04-FIN-016).
   *
   * ## O DEFEITO
   *
   * A IDA já estava: o título do contas a receber diz "Pedido online #1009" e
   * navega até esta ficha. A ficha, porém, mostrava itens, linha do tempo e
   * nota fiscal — dinheiro NENHUM. Para responder "esse pedido já foi pago?"
   * a pessoa saía daqui, ia ao contas a receber e procurava pelo número: o
   * gesto que a rastreabilidade existe para apagar. Era uma das DUAS fichas
   * que faltavam (a outra é a da devolução).
   *
   * ## POR QUE NA PRÓPRIA RESPOSTA, E NÃO NUMA SEGUNDA CONSULTA
   *
   * `GET /core/orders/:id` é a chamada que ESTA tela faz de qualquer jeito —
   * é ela que abre a ficha. Pendurar os títulos nela custa zero requisição a
   * mais, um estado de carregamento a menos e um 403 a menos: `GET
   * /finance/entries` não alcança todo perfil do escritório que abre Pedidos,
   * e a ficha ganharia um bloco vermelho para quem tem direito de ver o
   * pedido. É o caminho da ficha da VENDA.
   *
   * A ficha da DEVOLUÇÃO faz o oposto — pergunta depois — porque lá não há
   * detalhe nenhum sendo aberto: o motivo está escrito em `DevolucoesPage`.
   *
   * ## OPCIONAL NO TIPO, DE PROPÓSITO
   *
   * Servidor de versão anterior (ou proxy que cortou o corpo) responde sem o
   * campo. Declará-lo obrigatório faria `undefined` entrar na tela sem aviso
   * do compilador e desenhar "Nenhum título" — que diria que o pedido não
   * cobra ninguém. Opcional aqui obriga a ficha a decidir o que fazer com a
   * ausência, e ela declara a falha.
   */
  financeEntries?: FinanceEntry[];
  /** Os pedidos de devolução da cliente, abertos pelo portal (GAP-PRD-125). */
  returnRequests?: SolicitacaoDeDevolucao[];
}

/**
 * A nota fiscal do pedido, no lugar onde o pedido é tratado.
 *
 * A prontidão é consultada por CLIQUE, e não para a lista inteira: são cem
 * pedidos na tela, e perguntar por todos faria cem chamadas para responder uma
 * pergunta que interessa a um.
 *
 * Só há dois desfechos honestos: ou o botão emite, ou a tela diz o que falta.
 * Oferecer e falhar depois é o pior dos três — o gestor clica, espera, e só
 * então descobre que o cliente nunca completou o endereço.
 */
/** Onde está o endereço da nota, dito para quem trata o pedido. */
const ONDE_ESTA_O_ENDERECO: Record<MunicipioDaNotaDoPedido['lado'], string> = {
  faturamento: 'endereço de faturamento do pedido',
  entrega: 'endereço de entrega do pedido',
  cadastro: 'endereço da conta do cliente',
};

/**
 * A CORREÇÃO DO MUNICÍPIO DA NOTA, ali mesmo (R3-IBGE, GAP-PRD-028).
 *
 * O pedido fechado antes da tabela oficial do IBGE guarda o código que o
 * cliente digitou. O servidor o aponta e recusa a emissão sem numerar; sem
 * esta porta, o pedido não se faturaria nunca. A cidade vem sugerida pelo
 * nome escrito (quando há uma só na UF) ou é escolhida na lista, DENTRO da UF
 * do endereço — o servidor confere de novo. Só o município muda.
 */
function CorrecaoDoMunicipioDaNota({
  orderId,
  municipio,
  onCorrigido,
}: {
  orderId: string;
  municipio: MunicipioDaNotaDoPedido;
  onCorrigido: (prontidao: OrderInvoiceReadiness) => void;
}) {
  const [nome, setNome] = useState(municipio.sugestao?.nome ?? '');
  const [escolhido, setEscolhido] = useState<MunicipioDoIbge | null>(municipio.sugestao);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // O código é de OUTRA UF (retrato da 84 com a UF marcada errada): pode ser a
  // UF que está errada, e o servidor aceita manter o código e trocar a UF.
  const doCodigo = municipio.doCodigo && municipio.doCodigo.uf !== municipio.uf ? municipio.doCodigo : null;

  const corrigir = async (codigo: string | undefined = escolhido?.codigo) => {
    if (!codigo) return;
    setEnviando(true);
    setErro(null);
    try {
      onCorrigido(await coreApi.corrigirMunicipioDaNotaDoPedido(orderId, codigo));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível corrigir o município agora.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div
      role="group"
      aria-label="Corrigir o município do endereço da nota"
      className="mt-3 p-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
    >
      <p className="m-0 mb-2 text-[length:var(--gs-text-sm)]">
        O {ONDE_ESTA_O_ENDERECO[municipio.lado]} diz {municipio.cidade || 'uma cidade'}/{municipio.uf}, mas{' '}
        {municipio.motivo}. Escolha o município certo: só o município muda — rua, número, bairro e CEP ficam
        como o cliente deu.
      </p>
      {municipio.sugestao && (
        <p className="m-0 mb-2 text-[length:var(--gs-text-sm)] font-semibold">
          Pelo nome escrito, é {municipio.sugestao.nome} (código {municipio.sugestao.codigo}).
        </p>
      )}
      {doCodigo && (
        <div className="mb-3">
          <p className="m-0 mb-2 text-[length:var(--gs-text-sm)]">
            Se o cliente é mesmo de {doCodigo.nome} ({doCodigo.uf}), o código está certo e é a UF do endereço que
            foi marcada errada: mantenha o código {municipio.codigo}, e a UF passa a ser {doCodigo.uf}.
          </p>
          <Button onClick={() => void corrigir(doCodigo.codigo)} disabled={enviando}>
            Manter o código e corrigir a UF para {doCodigo.uf}
          </Button>
        </div>
      )}
      <CidadeComSugestoes
        uf={municipio.uf}
        valor={nome}
        onDigitar={(texto) => {
          setNome(texto);
          setEscolhido(null);
        }}
        onEscolher={(m) => {
          setNome(m.nome);
          setEscolhido(m);
        }}
        aria-label="Município do endereço da nota"
        className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
          bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]
          placeholder:text-[var(--gs-muted)] focus:border-[var(--gs-purple-700)]"
      />
      {erro && (
        <p role="alert" className="mt-2 mb-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      <div className="mt-2">
        <Button onClick={() => void corrigir()} disabled={!escolhido || enviando}>
          Corrigir o município
        </Button>
      </div>
    </div>
  );
}

function FaturamentoPedido({ orderId, onEmitida }: { orderId: string; onEmitida: () => void }) {
  const [prontidao, setProntidao] = useState<OrderInvoiceReadiness | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [emitindo, setEmitindo] = useState(false);

  const consultar = useCallback(async () => {
    setErro(null);
    try {
      setProntidao(await coreApi.getOrderInvoiceReadiness(orderId));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao consultar a nota.');
    }
  }, [orderId]);

  useEffect(() => {
    void consultar();
  }, [consultar]);

  const emitir = async () => {
    setEmitindo(true);
    setErro(null);
    try {
      await coreApi.emitNfeForOrder(orderId);
      await consultar();
      onEmitida();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível emitir agora.');
    } finally {
      setEmitindo(false);
    }
  };

  return (
    <Card>
      <h2 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">Nota fiscal do pedido</h2>
      {erro && (
        <p role="alert" className="mt-2 mb-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      {prontidao?.alreadyEmitted && (
        <p className="mt-2 mb-0">
          Este pedido já tem NF-e. Ela aparece em Fiscal → Documentos emitidos.
        </p>
      )}

      {prontidao && !prontidao.canEmit && !prontidao.alreadyEmitted && (
        <>
          <p className="mt-2 mb-1">Ainda não dá para faturar. Falta:</p>
          <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
            {prontidao.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {prontidao.municipio && (
            <CorrecaoDoMunicipioDaNota
              key={`${prontidao.municipio.lado}-${prontidao.municipio.codigo}`}
              orderId={orderId}
              municipio={prontidao.municipio}
              onCorrigido={setProntidao}
            />
          )}
        </>
      )}

      {prontidao?.canEmit && (
        <div className="mt-3">
          <Button onClick={() => void emitir()} disabled={emitindo}>
            {emitindo ? 'Emitindo…' : 'Emitir NF-e'}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function PedidosPage() {
  const [message, setMessage] = useState<string | null>(null);
  /** O que uma ação fez, dito pelo servidor — não é erro, é o resumo. */
  const [aviso, setAviso] = useState<string | null>(null);
  const [vocabulario, setVocabulario] = useState<VocabularioDePedido | null>(null);
  /*
    A PÁGINA (GAP-PRD-070): a lista parava no 200º pedido sem dizer. A
    primeira página vai sem parâmetro (o padrão do servidor é o mesmo); o
    rodapé conta e anda.
  */
  const [offset, setOffset] = useState(0);
  const [pagina, setPagina] = useState<Pagina<Order> | null>(null);
  const { data, error, loading, reload } = useLoader(
    () =>
      apiRequest<{ items: Order[]; vocabulario: VocabularioDePedido; total?: number }>(
        offset > 0 ? `/core/orders?offset=${offset}` : '/core/orders',
      ).then((r) => {
        setVocabulario(r.vocabulario);
        const recebida = lerPagina(r, { offset });
        setPagina(recebida);
        return recebida.items;
      }),
    [offset],
  );

  /*
    A FICHA DO PEDIDO — e os TRÊS estados que ela pode estar.

    `ficha` nulo com `abrindo` falso é "nenhum pedido aberto"; `abrindo` é "fui
    perguntar"; `erroDaFicha` é "perguntei e não deu". São estados DIFERENTES, e
    é por isso que não são um só: mostrar a ficha vazia enquanto a resposta não
    chegou diria "este pedido não tem itens" sobre um pedido que ninguém leu, e
    é exatamente o que um link velho produziria.
  */
  const [ficha, setFicha] = useState<OrderDetail | null>(null);
  const [erroDaFicha, setErroDaFicha] = useState<string | null>(null);
  const [abrindo, setAbrindo] = useState(false);
  /** O pedido cujo despacho está sendo preenchido (quem leva + código). */
  const [despachando, setDespachando] = useState<Order | null>(null);

  const abrir = useCallback(async (id: string) => {
    setErroDaFicha(null);
    setAbrindo(true);
    try {
      const documento = await apiRequest<OrderDetail>(`/core/orders/${id}`);
      // `exigirCampos`, e não confiança: corpo sem `items` viraria `undefined`
      // no `.map` do render, longe daqui e sem dizer o que houve.
      setFicha(exigirCampos(documento, 'id', 'number', 'items', 'events'));
    } catch (err) {
      // A ficha antiga SAI. Deixá-la na tela ao falhar mostraria o pedido
      // anterior sob o número do novo — a pior forma de estar errado.
      setFicha(null);
      setErroDaFicha(
        err instanceof ApiRequestError ? err.message : 'Não foi possível abrir este pedido.',
      );
    } finally {
      setAbrindo(false);
    }
  }, []);

  /*
    O PEDIDO QUE VEIO PELO LINK — `/sistema/pedidos?encomenda=<id>`.

    O título do contas a receber já dizia "Pedido #1009 — Ana Compradora" e
    navegava até AQUI: a lista inteira, com o 1009 perdido no meio dela. Era a
    ÚNICA origem do financeiro que parava na tela em vez de abrir o papel, e
    ficou assim de propósito enquanto esta tela não sabia ler parâmetro nenhum —
    escrever um endereço que ninguém consome seria a porta desenhada que não
    abre.

    `encomenda` e não `pedido`: `?pedido=` já é do pedido de COMPRA
    (`/sistema/compras/pedidos`), e é o nome que a casa usa para o pedido da
    loja (ver `src/lib/rotasDeOrigem.ts`).

    O parâmetro NÃO é consumido: abrir um pedido não destrói nada, e um F5 — ou
    o link colado num grupo — tem de continuar mostrando o mesmo papel.
  */
  const [paramsDaUrl, setParamsDaUrl] = useSearchParams();
  const pedidoPedido = paramsDaUrl.get(PARAM_DA_ENCOMENDA);
  /*
    Qual parâmetro já foi honrado. Sem a marca, abrir pela lista leria o pedido
    DUAS vezes — uma pelo clique, outra pelo efeito, quando o parâmetro que o
    clique acabou de escrever chegasse. Ref e não estado porque isto não desenha
    nada: guardar em `useState` provocaria uma renderização a mais só para
    registrar o que já aconteceu.
  */
  const urlJaHonrada = useRef<string | null>(null);
  useEffect(() => {
    if (!pedidoPedido || urlJaHonrada.current === pedidoPedido) return;
    urlJaHonrada.current = pedidoPedido;
    void abrir(pedidoPedido);
  }, [pedidoPedido, abrir]);

  /** Abrir pela lista também escreve o endereço: a URL descreve a tela. */
  const abrirEEnderecar = useCallback(
    async (id: string) => {
      // O efeito acima não repete o que este clique já está fazendo.
      urlJaHonrada.current = id;
      setParamsDaUrl({ [PARAM_DA_ENCOMENDA]: id }, { replace: true });
      await abrir(id);
    },
    [abrir, setParamsDaUrl],
  );

  /** As etapas deste pedido, na ordem em que ele as percorre. */
  const etapasDe = (order: Order): string[] => {
    if (!vocabulario) return [];
    return ehRetirada(order.shipping_method) ? vocabulario.retirada : vocabulario.entrega;
  };

  /** A próxima etapa, ou nulo quando não há para onde ir. */
  const proximaDe = (order: Order): string | null => {
    const etapas = etapasDe(order);
    const atual = etapas.indexOf(order.status);
    if (atual < 0 || atual === etapas.length - 1) return null;
    return etapas[atual + 1];
  };

  /**
   * A etapa ANTERIOR — para o "Desfazer etapa" (GAP-PRD-121). O servidor só
   * aceita a próxima no avanço; voltar é outra porta, com motivo.
   */
  const anteriorDe = (order: Order): string | null => {
    const etapas = etapasDe(order);
    const atual = etapas.indexOf(order.status);
    return atual > 0 ? etapas[atual - 1] : null;
  };

  const rotuloDe = (status: string): string => vocabulario?.rotulos[status] ?? status;

  const advance = async (order: Order) => {
    const next = proximaDe(order);
    if (!next) return;
    setMessage(null);

    /**
     * EXPEDIR É DESPACHAR — com QUEM leva (GAP-PRD-119/120).
     *
     * Aqui morava um `window.prompt` que pedia só o código, em texto solto: o
     * portal não sabia para que site mandar o cliente, e ninguém registrava
     * se a encomenda foi pelos Correios ou pelo motoboy. O despacho agora é um
     * formulário (`DespachoDoPedido`): com etiqueta do provedor, o código vem
     * dela; sem etiqueta, o operador escolhe a transportadora e informa o
     * código — opcional, porque entrega própria não tem, e exigir faria
     * alguém inventar.
     */
    if (next === 'expedido') {
      setDespachando(order);
      return;
    }

    try {
      await apiRequest(`/core/orders/${order.id}/fulfillment`, {
        method: 'POST',
        body: { status: next },
      });
      await reload();
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : 'Falha ao avançar o pedido.');
    }
  };

  const pay = async (order: Order) => {
    setMessage(null);
    try {
      await apiRequest(`/core/orders/${order.id}/pay`, { method: 'POST', body: {} });
      await reload();
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : 'Falha na baixa do pagamento.');
    }
  };

  /**
   * Depois de devolver, o resumo do SERVIDOR na tela: para onde foi o dinheiro
   * (quitado pelo provedor ou a pagar em Contas) e se a mercadoria voltou ao
   * estoque ou espera conferência (GAP-PRD-031, GAP-PRD-122).
   */
  const aposDevolver = async (resumo: string) => {
    setMessage(null);
    setAviso(resumo);
    await reload();
  };

  const pendencias = (data ?? []).filter((o) => o.payment_after_cancel);

  return (
    <AppShell>
      <PageHeader breadcrumb={['E-commerce', 'Pedidos']} title="Pedidos online" />

      {pendencias.length > 0 && (
        <div
          role="status"
          data-testid="pedidos-pagos-apos-cancelamento"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
            text-[var(--gs-warning)]"
        >
          <strong>
            {pendencias.length === 1
              ? '1 pedido cancelado recebeu pagamento'
              : `${pendencias.length} pedidos cancelados receberam pagamento`}
          </strong>
          <span className="block text-[length:var(--gs-text-sm)]">
            O provedor confirmou depois do cancelamento. O dinheiro está na conta e o pedido
            não existe mais: é preciso devolver ao cliente ou refazer o pedido. Nº{' '}
            {pendencias.map((p) => `#${p.number}`).join(', ')}.
          </span>
        </div>
      )}

      {message && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {message}
        </div>
      )}
      {aviso && (
        <div
          role="status"
          data-testid="pedidos-aviso"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)]"
        >
          {aviso}
        </div>
      )}
      <Feedback error={error} loading={loading} />

      {/*
        O QUE ACONTECEU COM O PEDIDO PEDIDO — nos três estados, sem confundi-los.

        "Abrindo…" é sinal de vida enquanto a resposta não chega; o erro é o
        recado do SERVIDOR (`Pedido não encontrado.` cobre o id que não existe e
        o pedido de outra empresa com a mesma frase, de propósito: dizer "existe
        mas não é sua" já entrega que existe). Nenhum dos dois desenha ficha.
      */}
      {abrindo && (
        <p className="mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]" role="status">
          Abrindo o pedido…
        </p>
      )}
      {erroDaFicha && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)]"
        >
          {erroDaFicha}
        </div>
      )}

      {ficha && (
        <Card
          title={`Pedido #${ficha.number}`}
          subtitle={`${ficha.customer_name}${ficha.customer_email ? ` — ${ficha.customer_email}` : ''}`}
          className="mb-5"
        >
          <div className="grid gap-3 sm:grid-cols-3 mb-4">
            <div>
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Situação
              </span>
              <Badge tone={ORDER_TONE[ficha.status] ?? 'neutral'}>{rotuloDe(ficha.status)}</Badge>
            </div>
            <div>
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Total
              </span>
              {formatCents(ficha.total_cents)}
              {Number(ficha.discount_cents ?? 0) > 0 && (
                <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Cupom {ficha.coupon_code}: −{formatCents(Number(ficha.discount_cents))} nos itens
                </span>
              )}
            </div>
            <div>
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {ehRetirada(ficha.shipping_method) ? 'Retirada' : 'Entrega'}
              </span>
              {/* Endereço vazio na entrega não vira traço mudo: é o que falta
                  para despachar, e quem abre o pedido precisa ver isso. */}
              {ehRetirada(ficha.shipping_method)
                ? 'No balcão da loja'
                : (ficha.shipping_address ?? 'Sem endereço informado')}
            </div>
          </div>

          <DataTable
            columns={[
              { header: 'Item', render: (i: OrderItem) => i.description },
              { header: 'Qtd.', align: 'right', render: (i: OrderItem) => formatQuantity(i.quantity) },
              {
                header: 'Unitário',
                align: 'right',
                render: (i: OrderItem) => formatCents(i.unit_price_cents),
              },
              {
                header: 'Total',
                align: 'right',
                render: (i: OrderItem) => formatCents(i.total_cents),
              },
            ]}
            rows={ficha.items}
            keyOf={(i) => i.id}
            empty={
              <EmptyState
                title="Pedido sem itens"
                description="Nenhuma linha foi gravada neste pedido."
              />
            }
          />

          {/* A linha do tempo do pedido, com o vocabulário do servidor — o
              código cru ('pronto_para_retirada') não é palavra de gente. */}
          {ficha.events.length > 0 && (
            <ul className="mt-4 m-0 pl-5 text-[length:var(--gs-text-sm)]">
              {ficha.events.map((ev) => (
                <li key={ev.id}>
                  {new Date(ev.created_at).toLocaleString('pt-BR')} — {rotuloDe(ev.status)}
                  {ev.note ? `: ${ev.note}` : ''}
                  {/* Quem disse (GAP-PRD-119): "entregue" pela transportadora e
                      pela loja não valem o mesmo. Evento antigo fica sem. */}
                  {ev.origin === 'provedor' && (
                    <span className="text-[var(--gs-muted)]"> (pela transportadora)</span>
                  )}
                  {ev.origin === 'operador' && <span className="text-[var(--gs-muted)]"> (pela loja)</span>}
                </li>
              ))}
            </ul>
          )}

          {/*
            ------------------------------------ o que o pedido gerou a cobrar

            A VOLTA da rastreabilidade, na quarta das cinco fichas. O título
            do contas a receber já apontava para cá; daqui não se via o
            título. Quem abria o pedido para conferir se o cliente pagou tinha
            de sair da ficha e caçar no financeiro pelo número — o gesto que o
            link do financeiro existe para apagar.

            O MESMO `TitulosDoDocumento` das fichas de venda, nota e pedido de
            compra: ele NÃO CONSULTA NADA, recebe a lista pronta. Reusá-lo aqui
            não custa a segunda requisição que se poderia temer — o pedido já
            traz os títulos na própria resposta do detalhe.

            LISTA AUSENTE NÃO É LISTA VAZIA. Servidor de versão anterior não
            manda o campo, e desenhar "Nenhum título" nesse caso diria que o
            pedido não cobra ninguém — a mentira mais cara que uma tela de
            cobrança conta. Aí o bloco declara a falha, no lugar da lista.
          */}
          <div className="mt-4" data-testid="pedido-titulos-do-financeiro">
            <TitulosDoDocumento
              titulo="O que este pedido gerou no financeiro"
              subtitulo="Os títulos criados pelo pedido — com o que ainda cobra o cliente."
              titulos={ficha.financeEntries ?? null}
              erro={
                ficha.financeEntries
                  ? null
                  : 'O servidor respondeu sem "financeEntries": não dá para dizer se este pedido '
                    + 'gerou título. A versão da tela pode estar diferente da versão do servidor.'
              }
            />
          </div>

          {/*
            O BLOCO FISCAL MORA NA FICHA, e não solto acima da lista.

            Ele já existia, aberto por um botão da coluna "Nota" que não deixava
            rastro no endereço: um F5 fechava o cartão e ninguém sabia de qual
            pedido ele era. Dentro da ficha ele é o que sempre foi — a nota
            DAQUELE papel —, e o endereço diz de quem.

            Pedido pago é pedido faturável: nota antes do dinheiro declara
            operação que ainda pode não acontecer.
          */}
          {ficha.status !== 'aguardando_pagamento' && ficha.status !== 'cancelado' && (
            <div className="mt-4">
              <FaturamentoPedido orderId={ficha.id} onEmitida={() => void reload()} />
            </div>
          )}

          {/*
            O ENVIO MORA NA FICHA (GAP-PRD-120/119): o que falta para comprar a
            etiqueta, a compra, e cada envio com rastreio, falha da consulta e
            eventos com origem. Pedido de retirada não tem envio.
          */}
          {!ehRetirada(ficha.shipping_method)
            && ficha.status !== 'aguardando_pagamento'
            && ficha.status !== 'cancelado' && (
            <div className="mt-4">
              <EnvioDoPedido key={ficha.id} orderId={ficha.id} onMudou={() => void reload()} />
            </div>
          )}

          {/* O que a cliente pediu pelo portal (GAP-PRD-125): a loja aprova
              ou recusa; o "Devolver" conclui. */}
          {(ficha.returnRequests ?? []).length > 0 && (
            <div className="mt-4">
              <SolicitacoesDeDevolucao
                orderId={ficha.id}
                solicitacoes={ficha.returnRequests ?? []}
                aoConcluir={async (mensagem) => {
                  setMessage(null);
                  setAviso(mensagem);
                  await reload();
                  await abrir(ficha.id);
                }}
                aoFalhar={setMessage}
              />
            </div>
          )}

          {/* O pedido reembolsado cuja mercadoria ainda não foi conferida: o
              estoque só volta com o que for recebido aqui (GAP-PRD-122). */}
          {ficha.return_goods_status === 'aguardando' && (
            <div className="mt-4">
              <RecebimentoDaDevolucao
                orderId={ficha.id}
                itens={ficha.items}
                aoConcluir={async (mensagem) => {
                  setMessage(null);
                  setAviso(mensagem);
                  await reload();
                  await abrir(ficha.id);
                }}
                aoFalhar={setMessage}
              />
            </div>
          )}

          {/* O clique errado tem porta própria (GAP-PRD-121): UMA etapa para
              trás, com motivo; o servidor recusa perfil que não é gerência. */}
          {anteriorDe(ficha) && (
            <div className="mt-4">
              <BotaoDesfazerEtapa
                pedido={ficha}
                rotuloAtual={rotuloDe(ficha.status)}
                rotuloAnterior={rotuloDe(anteriorDe(ficha)!)}
                aoConcluir={async () => {
                  await reload();
                  await abrir(ficha.id);
                }}
                aoFalhar={setMessage}
              />
            </div>
          )}
        </Card>
      )}

      {despachando && (
        <DespachoDoPedido
          key={despachando.id}
          order={despachando}
          onCancelar={() => setDespachando(null)}
          onFeito={() => {
            setDespachando(null);
            void reload();
          }}
        />
      )}

      <Card padded={false}>
        <DataTable
          columns={[
            {
              /*
                O NÚMERO É A PORTA. A lista mostrava `#1009` como texto morto: a
                única maneira de ver o que o cliente comprou era sair da tela.
                Abrir daqui escreve o endereço, e o endereço reabre o mesmo
                papel — inclusive para quem chegou pelo link do financeiro.
              */
              header: 'Nº',
              render: (r: Order) => (
                <Button size="sm" variant="ghost" onClick={() => void abrirEEnderecar(r.id)}>
                  {`#${r.number}`}
                </Button>
              ),
            },
            { header: 'Cliente', render: (r: Order) => r.customer_name },
            {
              header: 'Data',
              render: (r: Order) => new Date(r.created_at).toLocaleString('pt-BR'),
            },
            { header: 'Total', align: 'right', render: (r: Order) => formatCents(r.total_cents) },
            {
              header: 'Situação',
              render: (r: Order) => (
                <>
                  <Badge tone={ORDER_TONE[r.status] ?? 'neutral'}>
                    {rotuloDe(r.status)}
                  </Badge>
                  {r.payment_after_cancel ? (
                    <span className="block mt-1">
                      <Badge tone="warning">Pago após cancelar</Badge>
                    </span>
                  ) : null}
                  {r.return_goods_status === 'aguardando' ? (
                    <span className="block mt-1">
                      <Badge tone="warning">Mercadoria a conferir</Badge>
                    </span>
                  ) : null}
                  {r.return_request_status === 'aberta' ? (
                    <span className="block mt-1">
                      <Badge tone="warning">Devolução solicitada</Badge>
                    </span>
                  ) : null}
                </>
              ),
            },
            {
              // O link vem do servidor, pela transportadora do despacho
              // (GAP-PRD-119): sem ela, o código era texto solto.
              header: 'Rastreio',
              render: (r: Order) =>
                !r.tracking_code ? (
                  '—'
                ) : r.tracking_url ? (
                  <a href={r.tracking_url} target="_blank" rel="noreferrer" className="text-[var(--gs-purple-700)] font-mono">
                    {r.tracking_code}
                  </a>
                ) : (
                  <span className="font-mono">{r.tracking_code}</span>
                ),
            },
            {
              // Pedido pago é pedido faturável. Antes disso não há o que
              // declarar: nota antes do dinheiro declara operação que ainda
              // pode não acontecer.
              //
              // O botão abre a FICHA (onde o bloco fiscal agora mora) em vez de
              // um cartão solto: assim o gesto deixa endereço, e o F5 volta ao
              // mesmo pedido em vez de fechar tudo.
              header: 'Nota',
              render: (r: Order) =>
                r.status === 'aguardando_pagamento' || r.status === 'cancelado' ? (
                  <span className="text-[var(--gs-muted)]">—</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => void abrirEEnderecar(r.id)}>
                    NF-e
                  </Button>
                ),
            },
            {
              header: '',
              render: (r: Order) =>
                r.status === 'aguardando_pagamento' ? (
                  <span className="inline-flex gap-2">
                    <Button size="sm" onClick={() => void pay(r)}>
                      Baixar pagamento
                    </Button>
                    {/* A reserva não precisa esperar 25 h nem o cliente
                        (GAP-PRD-124): o gestor cancela, com motivo. */}
                    <BotaoCancelarPedido
                      pedido={r}
                      aoConcluir={reload}
                      aoFalhar={setMessage}
                    />
                  </span>
                ) : proximaDe(r) ? (
                  <span className="inline-flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void advance(r)}>
                      {rotuloDe(proximaDe(r)!)}
                    </Button>
                    <BotaoDevolverPedido pedido={r} aoConcluir={aposDevolver} aoFalhar={setMessage} />
                  </span>
                ) : r.status === 'entregue' ? (
                  <BotaoDevolverPedido pedido={r} aoConcluir={aposDevolver} aoFalhar={setMessage} />
                ) : null,
            },
          ]}
          rows={data ?? []}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhum pedido online"
              description="Os pedidos feitos na loja aparecem aqui para separação e expedição."
            />
          }
        />
        <Paginacao
          pagina={pagina ? { ...pagina, quantidade: pagina.items.length } : null}
          rotulo={{ singular: 'pedido', plural: 'pedidos' }}
          onMudar={setOffset}
          carregando={loading}
        />
      </Card>
    </AppShell>
  );
}

// ------------------------------------------------------------ integrações

interface Provider {
  provider: string;
  configured: boolean;
  environment: string;
  readiness: string;
  missing: string;
}

const READINESS_LABEL: Record<string, string> = {
  READY_FOR_CREDENTIAL: 'Aguardando credencial',
  READY_FOR_CERTIFICATE: 'Aguardando certificado',
  READY_FOR_HARDWARE: 'Aguardando hardware',
  READY_FOR_SANDBOX_TEST: 'Pronto para teste em sandbox',
  PRODUCTION_ENABLED: 'Produção habilitada',
  // Credencial de produção guardada, esperando a trava do servidor.
  BLOCKED_BY_PROCESS: 'Aguardando liberação no servidor',
  // Correios direto (GAP-PRD-118): não há cliente HTTP; os serviços chegam
  // pelo Melhor Envio. Credencial nenhuma muda este estado.
  NOT_IMPLEMENTED: 'Sem integração direta',
};

const PROVIDER_LABEL: Record<string, string> = {
  asaas: 'Asaas',
  nfe: 'NF-e',
  nfce: 'NFC-e',
  correios: 'Correios',
  'melhor-envio': 'Melhor Envio',
  tef: 'TEF / maquininhas',
  impressao: 'Impressão',
};

export function IntegracoesPage() {
  const { data, error, loading } = useLoader(
    () =>
      // `envelope`, e não `(r) => r.providers`: um corpo que não traz a lista
      // é contrato quebrado, e a tela já sabe mostrar erro — `undefined` ela
      // não sabe.
      apiRequest<{ providers: Provider[] }>('/core/integrations/status').then(envelope('providers')),
    [],
  );

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Integrações']}
        title="Integrações e prontidão"
      />
      <Feedback error={error} loading={loading} />

      <Card className="mb-5">
        <p className="m-0 text-[length:var(--gs-text-base)] text-[var(--gs-text-soft)]">
          Nenhuma integração externa está homologada. O código de cada uma vai até a fronteira
          possível sem credencial ou equipamento; abaixo está exatamente o que falta para
          concluir cada homologação.
        </p>
      </Card>

      <Card padded={false}>
        <DataTable
          columns={[
            {
              header: 'Integração',
              render: (r: Provider) => PROVIDER_LABEL[r.provider] ?? r.provider,
            },
            { header: 'Ambiente', render: (r: Provider) => r.environment },
            {
              header: 'Situação',
              render: (r: Provider) =>
                r.readiness === 'PRODUCTION_ENABLED' ? (
                  <Badge tone="success">{READINESS_LABEL[r.readiness]}</Badge>
                ) : r.readiness === 'READY_FOR_SANDBOX_TEST' ? (
                  <Badge tone="info">{READINESS_LABEL[r.readiness]}</Badge>
                ) : (
                  <Badge tone="warning">{READINESS_LABEL[r.readiness] ?? r.readiness}</Badge>
                ),
            },
            { header: 'O que falta', render: (r: Provider) => r.missing },
          ]}
          rows={data ?? []}
          keyOf={(r) => r.provider}
          empty={<EmptyState title="Sem integrações" description="Nada configurado." />}
        />
      </Card>
    </AppShell>
  );
}
