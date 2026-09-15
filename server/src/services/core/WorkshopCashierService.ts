/**
 * O CAIXA DA OFICINA — a fila, o recebimento e o estorno da OS.
 *
 * ## O que havia (GAP-PRD-042, 104, 209, 105)
 *
 * A rota de checkout montava a venda na mão: uma lista de pagamentos, o caixa,
 * e mais nada. Desconto, alçada, crédito de loja, acréscimo, terminal —
 * tudo que `createSale` já sabe fazer para o balcão — ficava de fora porque a
 * rota não repassava. A venda e a baixa da OS eram duas transações. A chave
 * de idempotência descia crua. O replay respondia 409. E não havia volta.
 *
 * ## O que este módulo é
 *
 * O MESMO fato econômico do PDV (`createSale`), com a OS como documento de
 * origem. Não há regra de pagamento própria aqui: split, troco, maquininha,
 * crédito de loja e alçada de desconto são os de `createSale`, chamados com as
 * linhas da OS (a peça como mercadoria já baixada, a mão de obra como serviço
 * — `vendaDaOs`). O que é da OS mora aqui:
 *
 *   - a CHAVE, com o namespace do documento (ver `chaveDoRecebimento`);
 *   - o REPLAY, que devolve o que aconteceu em vez de 409;
 *   - a venda E a baixa da OS numa transação só;
 *   - o FIADO da OS, que é decisão do dono (`workshopCreditEnabled`);
 *   - o ESTORNO, que cancela a venda e devolve a OS à fila do caixa.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { chaveDoRecebimentoDaOs } from './ChavesDoServidor.js';
import {
  cancelSale,
  createSale,
  type Concessao,
  type SalePaymentInput,
  type SaleRecord,
  type TrilhaDaAlcada,
} from './SalesService.js';
import { getOrder, searchOrders, settleOrder, type ServiceOrder } from './WorkshopCoreService.js';
import { consumirPromessasDaOs } from './WorkshopPartsReservation.js';
import { descricaoDaMaoDeObra, vendaDaOs } from './VendaDaOficina.js';
import { impressaoDigitalDaMercadoria, outraMercadoria } from './ImpressaoDigitalDaVenda.js';
import { chaveReusada } from '../api/ImpressaoDaRequisicao.js';
import { politicaDaEmpresa } from './SalePolicyService.js';
import { estornosDaOs, reabrirOsDaVendaCancelada } from './WorkshopOrderReopen.js';

// ------------------------------------------------------------------ a fila

export interface FilaDeRecebimento {
  items: Record<string, unknown>[];
  total: number;
  /**
   * A empresa tem oficina? É o que decide se o PDV oferece o botão "OS a
   * receber" — num balcão sem bancada, o botão seria uma porta para lugar
   * nenhum.
   */
  temOficina: boolean;
  /**
   * A política do fiado, na rota que o CAIXA alcança. `/sale-policies` é de
   * gerente, e é o caixa quem precisa saber se pode faturar a OS.
   */
  faturamentoAPrazo: { habilitado: boolean; prazoDias: number };
}

/**
 * As OS que esperam o caixa, com cliente, aparelho, bancada e total.
 *
 * Era `listOrders(...).filter(...)`: a linha crua (sem nome de cliente nem de
 * aparelho, que a tela precisa para o caixa reconhecer a OS) e filtrada DEPOIS
 * de um LIMIT 300 por número — a OS antiga ainda por cobrar sumia da fila
 * quando a oficina passasse de 300 ordens. Aqui o filtro vai para o banco.
 */
export function filaDeRecebimento(
  companyId: string,
  workshopIds: string[] | null,
): FilaDeRecebimento {
  ensureCoreSchema();
  const busca = searchOrders(companyId, {
    workshopIds,
    statuses: ['aguardando_pagamento'],
    limit: 300,
  });
  const oficinas = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_workshops WHERE company_id = ? AND active = 1')
    .get(companyId) as { n: number };
  const politica = politicaDaEmpresa(companyId);
  return {
    items: busca.items,
    total: busca.total,
    temOficina: oficinas.n > 0,
    faturamentoAPrazo: {
      habilitado: politica.workshopCreditEnabled,
      prazoDias: politica.creditSaleDueDays,
    },
  };
}

// ------------------------------------------------------------ o recebimento

/**
 * A chave do recebimento, com o namespace da OS.
 *
 * `createSale` procura venda por chave NA EMPRESA INTEIRA — e o cabeçalho dele
 * avisa que o namespace mora em quem conhece o documento. Descendo crua, a
 * Idempotency-Key de uma venda de balcão reenviada aqui devolvia AQUELA venda
 * como "duplicada", e a OS era finalizada apontando para a venda de outra
 * pessoa (medido em `caixa-da-oficina.test.ts`).
 *
 * Sem cabeçalho, a chave é a da OS — `os-<id>`, a mesma de sempre, para o
 * reenvio de um cliente antigo continuar sendo reconhecido. Depois de um
 * estorno ela ganha o número do ciclo: sem isso, cobrar de novo a OS reaberta
 * encontraria a venda CANCELADA pela mesma chave.
 */
export function chaveDoRecebimento(
  orderId: string,
  cabecalho: string | null,
  estornos: number,
): string {
  return chaveDoRecebimentoDaOs(orderId, cabecalho, estornos);
}

export interface ReceberOsInput {
  companyId: string;
  userId: string;
  orderId: string;
  /** A Idempotency-Key do pedido, crua. Nula quando o cliente não mandou. */
  idempotencyKey: string | null;
  payments: SalePaymentInput[];
  cashSessionId?: string | null;
  terminalId?: string | null;
  sellerId?: string | null;
  discountCents?: number;
  surchargeCents?: number;
  customerCreditCents?: number;
  alcada?: { profileCodes: string[]; authorizationId?: string | null };
}

export interface RecebimentoDaOs {
  order: ServiceOrder;
  sale: SaleRecord;
  /** Verdadeiro quando a resposta é a do recebimento que já tinha acontecido. */
  replay: boolean;
  /** A concessão medida — nula no replay, como em `createSale`. */
  concessao: Concessao | null;
  /**
   * A trilha da alçada (limite, excessos, quem liberou e por quê) — a mesma da
   * venda do balcão, lida do servidor. Nula no replay (P0 da Preço Justo).
   */
  alcada: TrilhaDaAlcada | null;
}

type VendaComChave = SaleRecord & { idempotency_key: string; idempotency_fingerprint: string | null };

function vendaPorId(companyId: string, saleId: string): VendaComChave {
  return getConnection()
    .prepare(
      `SELECT id, number, total_cents, change_cents, status, created_at, idempotency_key,
              idempotency_fingerprint
         FROM core_sales WHERE id = ? AND company_id = ?`,
    )
    .get(saleId, companyId) as unknown as VendaComChave;
}

function vendaPorChave(companyId: string, chave: string): VendaComChave | null {
  const linha = getConnection()
    .prepare(
      `SELECT id, number, total_cents, change_cents, status, created_at, idempotency_key,
              idempotency_fingerprint
         FROM core_sales WHERE company_id = ? AND idempotency_key = ?`,
    )
    .get(companyId, chave) as VendaComChave | undefined;
  return linha ?? null;
}

/**
 * A impressão digital do pedido de venda que ESTE recebimento desceria para
 * `createSale` — a mesma conta que ela faz na criação (RES-IDEM-VIZ).
 */
function impressaoDoRecebimento(input: ReceberOsInput): string {
  const daOs = vendaDaOs(input.companyId, input.orderId);
  return impressaoDigitalDaMercadoria({
    items: [],
    payments: Array.isArray(input.payments) ? input.payments : [],
    discountCents: input.discountCents,
    surchargeCents: input.surchargeCents,
    customerCreditCents: input.customerCreditCents,
    linhasJaBaixadas: daOs.pecas,
    serviceTotalCents: daOs.maoDeObraCents,
  });
}

function semChave(venda: VendaComChave): SaleRecord {
  return {
    id: venda.id,
    number: venda.number,
    total_cents: venda.total_cents,
    change_cents: venda.change_cents,
    status: venda.status,
    created_at: venda.created_at,
  };
}

/**
 * Recebe a OS: cria a venda (o fato econômico) e finaliza a ordem, JUNTOS.
 */
export function receberOs(input: ReceberOsInput): RecebimentoDaOs {
  ensureCoreSchema();
  const order = getOrder(input.companyId, input.orderId);
  if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'OS não encontrada.', 404);

  const chave = chaveDoRecebimento(
    input.orderId,
    input.idempotencyKey,
    estornosDaOs(input.companyId, input.orderId),
  );

  /*
    O REPLAY DEVOLVE O QUE ACONTECEU (GAP-PRD-209).

    O caixa que perdeu a resposta — rede caiu depois do commit — reenvia o mesmo
    pedido com a mesma chave. Responder 409 "a OS não está aguardando
    pagamento" era verdade e era inútil: a tela ficava sem saber se recebeu.
    Agora a resposta é a do recebimento original, com 200 e `replay: true`.

    A chave antiga (crua, anterior a esta correção) também é reconhecida: a OS
    finalizada guarda a venda, e a venda guarda a chave.
  */
  let anterior = vendaPorChave(input.companyId, chave);
  if (!anterior && input.idempotencyKey && order.sale_id) {
    const daOs = vendaPorId(input.companyId, order.sale_id);
    if (daOs?.idempotency_key === input.idempotencyKey) anterior = daOs;
  }
  if (anterior) {
    if (anterior.status === 'cancelled') {
      throw new ApiError(
        'CORE_CHECKOUT_REVERSED',
        'Este recebimento foi estornado. Para cobrar a OS de novo, comece um recebimento novo.',
        409,
        { saleId: anterior.id },
      );
    }
    if (order.sale_id !== anterior.id) {
      throw new ApiError(
        'CORE_CHECKOUT_KEY_CONFLICT',
        'Esta chave de recebimento pertence a outro documento. Comece um recebimento novo.',
        409,
      );
    }
    /*
      A MESMA CHAVE COM OUTRO DINHEIRO NÃO É O REPLAY (RES-IDEM-VIZ).

      O replay devolvia a venda da chave sem olhar o corpo: o recebimento em
      PIX repetido com a mesma chave em dinheiro respondia 200 com a venda do
      PIX, e a gaveta ficava esperando um dinheiro que não entrou nela. A
      comparação é a de `createSale` — que este atalho nunca alcança —, pela
      impressão digital gravada na venda. Venda sem impressão (anterior à
      coluna, ou a da chave crua antiga) segue a regra de sempre.
    */
    if (
      anterior.idempotency_fingerprint
      && outraMercadoria(anterior.idempotency_fingerprint, impressaoDoRecebimento(input))
    ) {
      throw chaveReusada(`a venda #${anterior.number} desta OS`, { saleId: anterior.id, saleNumber: anterior.number });
    }
    return { order, sale: semChave(anterior), replay: true, concessao: null, alcada: null };
  }

  if (order.status !== 'aguardando_pagamento') {
    throw new ApiError(
      'CORE_ORDER_NOT_AWAITING_PAYMENT',
      'A OS não está aguardando pagamento.',
      409,
    );
  }

  const payments = Array.isArray(input.payments) ? input.payments : [];

  /*
    O FIADO DA OS É DECISÃO DO DONO.

    `createSale` aceita venda sem pagamento nenhum quando há cliente — é o
    "a receber" que vence no prazo da política. No balcão da oficina isso é
    faturar o serviço para o cliente, e é crédito concedido: sem a política
    ligada, a lista vazia é recusada aqui com o caminho para ligá-la. E sem
    cliente do CADASTRO não há de quem cobrar — nome digitado no balcão não
    vira título.

    Lista vazia com o VALE do cliente cobrindo tudo não é fiado: não sobra
    nada a receber, e o crédito de loja passa sem a política. A conta aqui é
    só para decidir se há dívida; quem confere valor e saldo é `createSale`.
  */
  const sobraParaReceber =
    order.total_cents
    - Math.max(0, Math.round(Number(input.discountCents ?? 0)) || 0)
    + Math.max(0, Math.round(Number(input.surchargeCents ?? 0)) || 0)
    - Math.max(0, Math.round(Number(input.customerCreditCents ?? 0)) || 0);
  if (payments.length === 0 && sobraParaReceber > 0) {
    if (!politicaDaEmpresa(input.companyId).workshopCreditEnabled) {
      throw new ApiError(
        'CORE_WORKSHOP_CREDIT_DISABLED',
        'Faturar a OS a prazo está desligado nesta operação. Receba pelos meios de pagamento, '
          + 'ou peça ao gerente para ligar "Faturar OS a prazo" em Política de venda.',
        400,
      );
    }
    if (!order.customer_id) {
      throw new ApiError(
        'CORE_WORKSHOP_CREDIT_NEEDS_CUSTOMER',
        'Para faturar a prazo, a OS precisa de um cliente do cadastro — o nome digitado no balcão '
          + 'não tem de quem cobrar. Vincule o cliente à OS, ou receba pelos meios de pagamento.',
        400,
      );
    }
  }

  /*
    A VENDA E A BAIXA DA OS NUMA TRANSAÇÃO SÓ.

    Eram duas: se `settleOrder` falhasse depois de `createSale`, ficava uma
    venda paga com a OS na fila do caixa — e o próximo clique, com chave nova,
    cobraria o cliente de novo.
  */
  return withTransaction(() => {
    /*
      A PEÇA SAI ANTES DA VENDA (GAP-PRD-101).

      Em operação normal a conclusão técnica já baixou tudo e isto não faz
      nada. Mas a rede de segurança de `settleOrder` consumia DEPOIS da venda
      — e a venda precisa do custo com que a peça saiu para itemizá-la. Chamar
      aqui primeiro põe a saída (e o retrato do custo) antes da venda; a
      chamada de `settleOrder` fica sem o que fazer, e o razão recusa repetição.
    */
    consumirPromessasDaOs({
      companyId: input.companyId,
      orderId: input.orderId,
      orderNumber: order.number,
      userId: input.userId,
    });

    /*
      A VENDA SAI ITEMIZADA — uma conta só para duas frentes.

      GAP-PRD-024 (fiscal): cada peça é uma linha COM produto — é mercadoria,
      e a NFC-e tira dela NCM, CFOP e origem —, e a mão de obra é a linha de
      serviço, que vai para a NFS-e. GAP-PRD-101 (oficina): a peça leva o custo
      com que SAIU da gaveta (o retrato da baixa), o que leva a oficina ao CMV.
      Nenhuma das linhas move estoque: a peça baixou na conclusão técnica (ou
      logo acima, pela rede de segurança).

      OS CUJA CONTA NÃO FECHA É RECUSADA (409 CORE_ORDER_TOTAL_MISMATCH), antes
      de qualquer escrita — a transação desfaz a rede de segurança acima. A
      saída antiga (linha única "Ordem de serviço #N") não é mais oferecida:
      com a nota das peças e a NFS-e da mão de obra lendo a venda, uma linha só
      faria a NFS-e declarar a peça como serviço. O gerente devolve a OS à
      bancada para refazer a conta.
    */
    const daOs = vendaDaOs(input.companyId, input.orderId);

    const result = createSale({
      companyId: input.companyId,
      userId: input.userId,
      idempotencyKey: chave,
      // As peças já baixaram na conclusão técnica: a venda registra o fato
      // econômico com o total apurado na OS, sem repetir a baixa.
      items: [],
      payments,
      customerId: order.customer_id,
      sellerId: input.sellerId ?? null,
      terminalId: input.terminalId ?? null,
      cashSessionId: input.cashSessionId ?? null,
      discountCents: input.discountCents,
      surchargeCents: input.surchargeCents,
      customerCreditCents: input.customerCreditCents,
      origin: 'oficina',
      note: `OS #${order.number}`,
      linhasJaBaixadas: daOs.pecas,
      serviceTotalCents: daOs.maoDeObraCents,
      serviceDescription: descricaoDaMaoDeObra(order.number),
      alcada: input.alcada,
    });

    const settled = settleOrder({
      companyId: input.companyId,
      orderId: input.orderId,
      userId: input.userId,
      saleId: result.sale.id,
    });

    return {
      order: settled,
      sale: result.sale,
      replay: result.duplicated,
      concessao: result.concessao,
      alcada: result.alcada,
    };
  });
}

// ---------------------------------------------------------------- o estorno

/**
 * Confere se a OS tem recebimento a estornar e devolve a venda dele.
 *
 * Separada do estorno porque a ROTA precisa da venda ANTES de estornar: é ela
 * o alvo da liberação do gestor (`cancelar_venda` presa a ESTA venda), e a
 * recusa de estado precisa sair antes do pedido de senha — pedir a senha do
 * gestor para depois dizer "esta OS não está paga" gasta o gestor à toa.
 */
export function vendaAEstornar(companyId: string, orderId: string): { order: ServiceOrder; saleId: string } {
  ensureCoreSchema();
  const order = getOrder(companyId, orderId);
  if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'OS não encontrada.', 404);
  if (order.status !== 'finalizada') {
    throw new ApiError(
      'CORE_ORDER_NOT_PAID',
      'Só OS finalizada e paga tem recebimento a estornar.',
      409,
      { status: order.status },
    );
  }
  if (!order.sale_id) {
    throw new ApiError(
      'CORE_ORDER_WITHOUT_SALE',
      'Esta OS foi encerrada sem cobrança (garantia, cortesia ou retrabalho): não há recebimento a estornar.',
      409,
    );
  }
  return { order, saleId: order.sale_id };
}

export interface EstornoDaOs {
  order: ServiceOrder;
  sale: SaleRecord;
  /** A OS apontava para uma venda JÁ cancelada (estado deixado pelo código antigo). */
  reparo: boolean;
}

/**
 * Estorna o recebimento: cancela a venda e devolve a OS à fila do caixa.
 *
 * Quem desfaz estoque, título, gaveta, comissão, pontos e crédito é
 * `cancelSale` — o MESMO cancelamento da tela de vendas, e é ele quem reabre a
 * OS (`reabrirOsDaVendaCancelada`, na transação dele). Este serviço acrescenta
 * o que é da OS: o motivo obrigatório e o reparo do estado legado.
 *
 * O cartão: o cancelamento da venda não estorna a transação na operadora (a
 * tela avisa); isso é da maquininha/adquirente, fora deste módulo.
 */
export function estornarRecebimentoDaOs(input: {
  companyId: string;
  userId: string;
  orderId: string;
  reason: string;
}): EstornoDaOs {
  const motivo = String(input.reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError(
      'CORE_REVERSAL_REASON_REQUIRED',
      'Diga por que o recebimento está sendo estornado — é o que explica a OS de volta na fila.',
      400,
    );
  }
  return withTransaction(() => {
    const { order, saleId } = vendaAEstornar(input.companyId, input.orderId);
    const venda = vendaPorId(input.companyId, saleId);
    const razao = `Estorno da OS #${order.number}: ${motivo}`;

    if (venda.status === 'cancelled') {
      /*
        O REPARO DO ESTADO LEGADO.

        Antes desta correção, cancelar a venda da OS pela tela de vendas deixava
        a OS finalizada apontando para a venda cancelada. A venda já está
        desfeita — cancelar de novo não faria nada, e o hook de `cancelSale`
        não rodaria. A OS é reaberta direto, com o mesmo registro.
      */
      reabrirOsDaVendaCancelada({
        companyId: input.companyId,
        saleId,
        userId: input.userId,
        reason: `${motivo} (a venda já estava cancelada)`,
      });
      return {
        order: getOrder(input.companyId, input.orderId)!,
        sale: semChave(venda),
        reparo: true,
      };
    }

    const cancelada = cancelSale({
      companyId: input.companyId,
      saleId,
      userId: input.userId,
      reason: razao,
    });
    return { order: getOrder(input.companyId, input.orderId)!, sale: cancelada, reparo: false };
  });
}
