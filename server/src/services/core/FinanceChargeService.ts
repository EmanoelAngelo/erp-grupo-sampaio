/**
 * COBRAR O TÍTULO DO CONTAS A RECEBER (GAP-V70).
 *
 * ## O buraco que isto fecha
 *
 * O fluxo central da cobrança online — lançar o título e cobrar o cliente por
 * PIX, boleto ou link — não existia. A cobrança só nascia do CHECKOUT da loja:
 * `createOrderCharge` era o único criador vivo, `createPaymentIntent` estava
 * escrito e sem um único chamador, e `FinanceService` não tinha uma linha
 * sobre o provedor. Cobrar aluguel, OS da oficina ou venda a prazo pelo Asaas
 * exigia sair do sistema, gerar a cobrança no portal do provedor e dar baixa à
 * mão aqui dentro — com a conciliação acusando "cobrado e não lançado" no fim
 * do mês.
 *
 * Toda a infraestrutura já existia para o pedido online: credencial por
 * operação no cofre, vínculo de cliente no provedor, webhook com token por
 * empresa, rank de eventos, idempotência, conferência de valor, conciliação.
 * O que faltava era o fio entre ela e o financeiro. É este arquivo.
 *
 * ## As regras que não se negociam
 *
 * 1. GERAR COBRANÇA NÃO É RECEBER. O título continua em aberto até o webhook
 *    confirmar. Quem baixa ao mostrar o QR fecha o mês com dinheiro que não
 *    entrou.
 * 2. UMA COBRANÇA POR TÍTULO E MEIO. A chave de idempotência é derivada do
 *    título, então dez cliques no botão não viram dez boletos no colo do
 *    cliente.
 * 3. A CONTA É DA OPERAÇÃO. A credencial vem do cofre da empresa dona do
 *    título — o PIX do cliente da Gringa não cai na conta do Preço Justo.
 * 4. SEM CREDENCIAL, RECUSA DECLARADA. Não se cria intenção fantasma nem se
 *    finge cobrança: hoje, nas seis operações, é `unconfigured` que é a
 *    verdade, e a tela diz isso com o caminho para resolver.
 *
 * ## O que este arquivo NÃO faz, e por quê
 *
 * RECORRÊNCIA (assinatura mensal) não entra aqui. `createSubscription` existe
 * no cliente HTTP e continua sem chamador, de propósito: a casa não tem
 * recorrência de LANÇAMENTO — não há título recorrente, não há agendador (o
 * servidor desliga à noite, como o próprio `EmailService` declara), e uma
 * assinatura no provedor geraria mês a mês cobranças cujos ids o ERP nunca
 * aprenderia. O webhook de cada mensalidade chegaria com `provider_ref`
 * desconhecido e morreria em "Cobrança não encontrada no ERP": o cliente
 * pagando e o financeiro sem baixa nenhuma. Meia assinatura é pior que
 * assinatura nenhuma, e a parede tem de vir antes do telhado.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import { resolveAsaasCustomer } from './AsaasCustomerLinkService.js';
import { parcelarEntrada, type ParcelaDoCarne } from './FinanceService.js';
import {
  carregarExibicaoDaCobranca,
  createPaymentIntent,
  getAsaasCredentials,
  type ChargeDisplay,
  type PaymentIntent,
} from './PaymentService.js';
import { cancelarCobrancasOrfas, tentouNoProvedor } from './AsaasCobrancaOrfa.js';

/** Os meios que o título sabe cobrar. `cartao` é pago na página do provedor. */
export type FinanceChargeMethod = 'pix' | 'boleto' | 'cartao';

export interface FinanceChargeInstallment extends ParcelaDoCarne {
  intentId: string;
  providerRef: string | null;
  status: string;
  invoiceUrl: string | null;
}

export interface FinanceCharge extends ChargeDisplay {
  /** A intenção da PRIMEIRA parcela — a que a tela mostra em destaque. */
  intent: PaymentIntent;
  invoiceUrl: string | null;
  status: string;
  environment: string;
  /** Uma linha por parcela. Sem parcelamento, uma só. */
  installments: FinanceChargeInstallment[];
}

interface EntryRow {
  id: string;
  company_id: string;
  direction: string;
  description: string;
  amount_cents: number;
  settled_cents: number;
  due_date: string | null;
  customer_id: string | null;
  cancelled_at: string | null;
  installment_number: number;
  installment_total: number;
}

interface CustomerRow {
  id: string;
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
}

function carregarTitulo(companyId: string, entryId: string): EntryRow {
  const row = getConnection()
    .prepare('SELECT * FROM core_finance_entries WHERE id = ? AND company_id = ?')
    .get(entryId, companyId) as unknown as EntryRow | undefined;
  // 404 e não 403: dizer "existe, mas não é seu" já conta ao vizinho que o id
  // existe. Título de outra operação simplesmente não está aqui.
  if (!row) {
    throw new ApiError('CORE_FINANCE_ENTRY_NOT_FOUND', 'Lançamento não encontrado.', 404);
  }
  return row;
}

/**
 * O vencimento que vai ao provedor.
 *
 * O título pode estar VENCIDO — é justamente o caso em que alguém corre para
 * cobrar. Mandar uma data passada faria o provedor recusar a cobrança inteira,
 * e o cobrador levaria um erro de API onde deveria ver um boleto. O vencimento
 * do TÍTULO não muda: quem envelhece na régua de atraso continua envelhecendo.
 */
function vencimentoDoProvedor(dueDate: string | null): string {
  const hoje = hojeNaLoja();
  if (!dueDate) return somarDias(hoje, 1);
  return dueDate < hoje ? hoje : dueDate;
}

/*
  ============================================================================
  O QUE É UMA COBRANÇA MORTA — e por que a lista é TOTAL
  ============================================================================

  Três perguntas deste arquivo dependem de saber se uma intenção ainda está de
  pé: se o título pode ser parcelado, se há o que cancelar no provedor, e qual
  chave de idempotência a próxima cobrança deve usar. Se cada uma respondesse
  com a sua própria lista de status, a terceira divergiria das outras duas no
  primeiro status novo — e é exatamente assim que uma lista escrita à mão
  envelhece calada.

  O mapa é um `Record` sobre a UNIÃO FECHADA dos status que `PaymentService`
  escreve. Nascer um status novo lá quebra a COMPILAÇÃO aqui, e quem o criou
  decide, no mesmo dia, o que ele significa para a cobrança do título.
*/

/** Todo status que `PaymentService` grava em `core_payment_intents`. */
export type StatusDaCobranca =
  | 'unconfigured'
  | 'failed'
  | 'pending'
  | 'overdue'
  | 'confirmed'
  | 'amount_mismatch'
  | 'paid_after_cancel'
  | 'refunded'
  | 'chargeback'
  | 'cancelled';

/** O que se pode fazer com uma cobrança neste estado. */
type VidaDaCobranca =
  /** De pé no provedor (ou a caminho): cancelar faz sentido, parcelar não. */
  | 'viva'
  /** Dinheiro já entrou por ela: não se cancela, o caminho é o estorno. */
  | 'paga'
  /** Acabou. Não tranca o título nem para parcelar nem para cobrar de novo. */
  | 'morta';

const VIDA_DA_COBRANCA: Record<StatusDaCobranca, VidaDaCobranca> = {
  // `unconfigured` e `failed` nunca chegaram a existir lá fora, mas SEGURAM a
  // chave de idempotência do título: a parcela 1 reencontraria justamente essa
  // intenção, com o valor cheio. Por isso contam como vivas até alguém as
  // encerrar pelo cancelamento.
  unconfigured: 'viva',
  failed: 'viva',
  pending: 'viva',
  overdue: 'viva',
  confirmed: 'paga',
  // Pagou valor diferente e o título NÃO foi baixado: o dinheiro entrou do
  // mesmo jeito e quem regulariza é quem controla o caixa.
  amount_mismatch: 'paga',
  paid_after_cancel: 'paga',
  // Estorno e chargeback são fatos POSTERIORES ao pagamento: a cobrança não
  // está mais de pé, e o título volta a poder ser cobrado.
  refunded: 'morta',
  chargeback: 'morta',
  cancelled: 'morta',
};

function vidaDe(status: string): VidaDaCobranca {
  // Status desconhecido é tratado como VIVO de propósito: na dúvida, não se
  // parcela em cima dele nem se reaproveita a chave. Chutar 'morta' criaria
  // uma segunda cobrança ao lado de uma que talvez esteja viva no provedor.
  return VIDA_DA_COBRANCA[status as StatusDaCobranca] ?? 'viva';
}

interface IntentDoTitulo {
  id: string;
  method: string;
  status: string;
  provider_ref: string | null;
  environment: string;
  amount_cents: number;
  /** Idas ao provedor: sem referência e com ida, pode haver órfã (GAP-PRD-049). */
  attempts: number;
}

/** As intenções de cobrança DESTE título, na ordem em que nasceram. */
function cobrancasDoTitulo(companyId: string, entryId: string): IntentDoTitulo[] {
  return getConnection()
    .prepare(
      `SELECT id, method, status, provider_ref, environment, amount_cents, attempts
         FROM core_payment_intents
        WHERE company_id = ? AND origin_type = 'finance_entry' AND origin_id = ?
        ORDER BY created_at`,
    )
    .all(companyId, entryId) as unknown as IntentDoTitulo[];
}

/**
 * A CHAVE DE IDEMPOTÊNCIA DO TÍTULO, com GERAÇÃO.
 *
 * `finance_entry:<id>:<meio>` é o que impede dez cliques em "Cobrar" de virarem
 * dez boletos — e é para continuar assim. O problema aparece DEPOIS do
 * cancelamento: a intenção cancelada continua guardando a chave, e uma nova
 * cobrança do mesmo título pelo mesmo meio receberia de volta a cobrança MORTA,
 * com o link que o provedor já não honra. O botão diria "cobrança criada" e o
 * cliente receberia um boleto cancelado.
 *
 * A geração é a CONTAGEM de cobranças já encerradas deste título e meio. Ela é
 * estável dentro de uma geração (dois cliques seguidos = mesma chave = mesma
 * cobrança) e avança uma única vez a cada encerramento.
 */
function chaveDaCobranca(companyId: string, entryId: string, method: string): string {
  const encerradas = cobrancasDoTitulo(companyId, entryId).filter(
    (i) => i.method === method && vidaDe(i.status) === 'morta',
  ).length;
  const base = `finance_entry:${entryId}:${method}`;
  return encerradas === 0 ? base : `${base}#${encerradas + 1}`;
}

export async function chargeFinanceEntry(input: {
  companyId: string;
  entryId: string;
  method: FinanceChargeMethod;
  /**
   * PARCELAR A COBRANÇA EM N (GAP-V73).
   *
   * O parcelamento é REFLETIDO no contas a receber: o título vira um carnê de
   * N parcelas (`parcelarEntrada`, com a régua de centavos da casa) e CADA
   * parcela ganha a sua própria cobrança, com o seu valor e o seu vencimento.
   *
   * ## Por que N cobranças e não um `installmentCount` no provedor
   *
   * O provedor aceita um plano de parcelas e devolve o id da PRIMEIRA cobrança
   * apenas. As outras N-1 nascem lá com ids que o ERP nunca aprende — e o
   * webhook de cada uma chegaria aqui com `provider_ref` desconhecido, morrendo
   * em "Cobrança não encontrada no ERP". O cliente pagaria as três parcelas e o
   * financeiro baixaria uma. Uma cobrança por parcela mantém o vínculo
   * cobrança↔título que faz a baixa automática existir, e ainda deixa os
   * centavos fecharem pela régua daqui em vez de pela aritmética do provedor.
   */
  installmentCount?: number | null;
  fetchImpl?: typeof fetch;
}): Promise<FinanceCharge> {
  ensureCoreSchema();
  const db = getConnection();
  const titulo = carregarTitulo(input.companyId, input.entryId);

  if (titulo.direction !== 'in') {
    throw new ApiError(
      'CORE_FINANCE_CHARGE_DIRECTION',
      'Cobrança online é do que se RECEBE. Esta é uma conta a pagar.',
      409,
    );
  }
  if (titulo.cancelled_at) {
    throw new ApiError(
      'CORE_FINANCE_ENTRY_CANCELLED',
      'Este lançamento foi cancelado e não aceita cobrança.',
      409,
    );
  }
  const saldo = Number(titulo.amount_cents) - Number(titulo.settled_cents ?? 0);
  if (saldo <= 0) {
    throw new ApiError(
      'CORE_FINANCE_ENTRY_SETTLED',
      'Este título já está quitado — não há o que cobrar.',
      409,
    );
  }
  if (!titulo.customer_id) {
    throw new ApiError(
      'CORE_FINANCE_CHARGE_WITHOUT_CUSTOMER',
      'O título não tem cliente vinculado, e o provedor pendura a cobrança em alguém. '
        + 'Informe o cliente no lançamento.',
      400,
    );
  }

  /*
    SEM CREDENCIAL, A AÇÃO É RECUSADA — e o estado é honesto.

    Este é o retrato real das seis operações hoje: a integração está inativa
    (as chaves ficaram em cópias seladas do banco e precisam ser reemitidas no
    portal do provedor). O checkout da loja DEGRADA nesse caso, porque lá o
    pedido já existe e não pode ser perdido; aqui não há nada a preservar — o
    gerente clicou "cobrar" e precisa saber que não há como cobrar. Registrar
    uma intenção `unconfigured` só encheria a tela de status com cobranças que
    nunca existiram.
  */
  const creds = getAsaasCredentials({ companyId: input.companyId });
  if (!creds) {
    throw new ApiError(
      'CORE_ASAAS_UNCONFIGURED',
      'Integração Asaas não configurada nesta operação: sem chave, não há como gerar a cobrança. '
        + 'Configure em Integrações › Asaas.',
      409,
    );
  }

  const cliente = db
    .prepare('SELECT id, name, document, email, phone FROM core_customers WHERE id = ? AND company_id = ?')
    .get(titulo.customer_id, input.companyId) as unknown as CustomerRow | undefined;
  if (!cliente) {
    throw new ApiError(
      'CORE_FINANCE_CHARGE_WITHOUT_CUSTOMER',
      'O cliente do título não foi encontrado nesta operação.',
      400,
    );
  }

  const gateway = new AsaasHttpClient({
    environment: creds.environment,
    companyId: input.companyId,
    fetchImpl: input.fetchImpl,
  });

  // O cliente é resolvido ANTES de partir o título: cliente sem CPF/CNPJ é
  // recusado aqui, e um carnê não fica criado por uma cobrança que nem chegou
  // a ser tentada.
  const vinculo = await resolveAsaasCustomer({
    companyId: input.companyId,
    environment: creds.environment,
    gateway,
    customer: {
      id: cliente.id,
      name: cliente.name,
      document: cliente.document,
      email: cliente.email,
      phone: cliente.phone,
    },
  });

  /*
    ========================================================================
    PARCELAR DEPOIS DE JÁ TER COBRADO DEIXAVA A PARCELA 1 COM O VALOR CHEIO
    ========================================================================

    O DEFEITO, em três passos silenciosos:

      1. o título de R$ 300 já cobrado vira carnê de 3 × R$ 100;
      2. a parcela 1 MANTÉM O ID do título (`parcelarEntrada` preserva o id de
         propósito, para não apagar a trilha), então reencontra a MESMA chave
         de idempotência e recebe de volta a intenção ANTIGA — a de R$ 300,
         viva no provedor;
      3. se o cliente pagar os R$ 300, `settleEntry` recusa por exceder o saldo
         da parcela e o desfecho é "Pagamento confirmado, título NÃO baixado":
         dinheiro na conta do provedor e contas a receber em aberto. É o pior
         estado possível — pior que não ter cobrado.

    A tela travava o campo de parcelas por `installmentTotal > 1` ou
    `settledCents > 0`, e nenhum dos dois é o caso aqui. Trava de tela não
    protege outro cliente HTTP: a recusa mora NO SERVIDOR, e DENTRO da mesma
    transação que parte o título — senão outra requisição cria a cobrança no
    intervalo entre conferir e partir.

    A recusa não é uma porta trancada para sempre: cobrança MORTA (cancelada,
    estornada, com chargeback) não segura nada, e o cancelamento logo abaixo é
    o caminho declarado para refazer a cobrança em parcelas.
  */
  const parcelas: ParcelaDoCarne[] =
    input.installmentCount && input.installmentCount > 1
      ? withTransaction(() => {
          /*
            A ORDEM DAS RECUSAS. Título que JÁ É PARCELA, título COM BAIXA e
            título sem vencimento são recusados por `parcelarEntrada`, que é o
            dono da regra do carnê e explica cada um com o seu motivo. Este
            guarda só se pronuncia sobre o caso que sobrou — o título ainda
            inteiro, que `parcelarEntrada` aceitaria partir — e é justamente
            nele que a parcela 1 herdaria a cobrança de valor cheio.
          */
          const atual = carregarTitulo(input.companyId, input.entryId);
          const aindaInteiro =
            Number(atual.installment_total ?? 1) <= 1 && Number(atual.settled_cents ?? 0) === 0;
          const viva = cobrancasDoTitulo(input.companyId, input.entryId).find(
            (i) => vidaDe(i.status) !== 'morta',
          );
          if (aindaInteiro && viva) {
            throw new ApiError(
              'CORE_FINANCE_CHARGE_ALREADY_OPEN',
              'Este título já tem cobrança no provedor, e parcelá-lo agora deixaria a '
                + 'primeira parcela com a cobrança do valor cheio. Cancele a cobrança atual '
                + 'antes de parcelar.',
              409,
            );
          }
          return parcelarEntrada({
            companyId: input.companyId,
            entryId: input.entryId,
            installments: input.installmentCount as number,
          });
        })
      : [
          {
            entryId: titulo.id,
            number: Number(titulo.installment_number ?? 1),
            total: Number(titulo.installment_total ?? 1),
            // O SALDO, não o valor original: título com baixa parcial se cobra
            // pelo que falta. Cobrar o cheio pediria ao cliente dinheiro que
            // ele já pagou.
            amountCents: saldo,
            dueDate: titulo.due_date,
          },
        ];

  const geradas: FinanceChargeInstallment[] = [];
  for (const parcela of parcelas) {
    const descricao = db
      .prepare('SELECT description FROM core_finance_entries WHERE id = ?')
      .get(parcela.entryId) as { description: string };

    const intent = await createPaymentIntent({
      companyId: input.companyId,
      originType: 'finance_entry',
      originId: parcela.entryId,
      method: input.method,
      amountCents: parcela.amountCents,
      // Uma cobrança por título e meio. A chave é do TÍTULO (a parcela é um
      // título), então re-clicar devolve a mesma cobrança — e a geração faz a
      // cobrança CANCELADA parar de segurar a chave.
      idempotencyKey: chaveDaCobranca(input.companyId, parcela.entryId, input.method),
      asaasCustomerId: vinculo.asaasCustomerId,
      description: descricao.description,
      dueDate: vencimentoDoProvedor(parcela.dueDate),
      fetchImpl: input.fetchImpl,
    });

    geradas.push({
      ...parcela,
      intentId: intent.id,
      providerRef: intent.provider_ref,
      status: intent.status,
      invoiceUrl: intent.invoice_url || null,
    });
  }

  const primeira = geradas[0];
  const intent = getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE id = ?')
    .get(primeira.intentId) as unknown as PaymentIntent;

  const exibicao = await carregarExibicaoDaCobranca({
    intent,
    companyId: input.companyId,
    environment: creds.environment,
    fetchImpl: input.fetchImpl,
  });

  return {
    ...exibicao,
    intent,
    invoiceUrl: intent.invoice_url || null,
    status: intent.status,
    environment: creds.environment,
    installments: geradas,
  };
}

/**
 * CANCELA AS COBRANÇAS VIVAS DE UM TÍTULO NO PROVEDOR (defeito v13-3).
 *
 * ## O buraco que isto fecha
 *
 * `cancelOrderCharges` existia para o PEDIDO e ganhou os três chamadores
 * (portal do cliente, cancelamento pelo ERP, expiração da reserva). Do lado do
 * TÍTULO não havia nada: `FinanceChargeService` apenas RECUSAVA cobrar um
 * lançamento já cancelado, e a própria tela declarava a ausência — "não há rota
 * para isso no título". Efeito: um PIX ou boleto de título que perdeu a razão
 * de ser continuava vivo no provedor, e o cliente podia pagá-lo. O dinheiro não
 * some (vira divergência na conciliação e `settleEntry` recusa a baixa
 * indevida), mas cada um desses vira regularização manual — e é a cobrança
 * velha que a parcela 1 herdava quando alguém parcelava depois de cobrar.
 *
 * ## As três decisões, e o que cada uma evita
 *
 * 1. SÓ COBRANÇA VIVA. Cobrança PAGA não se cancela: o dinheiro já entrou e
 *    apagar a cobrança apagaria o rastro dele. Quem quer desfazer pagamento usa
 *    o estorno, que deixa contrapartida. Cobrança já morta é no-op silencioso —
 *    cancelar duas vezes não é erro.
 * 2. INTENÇÃO SEM `provider_ref` MORRE AQUI MESMO. Ela nunca chegou a existir
 *    lá fora (falha na criação, ou operação sem credencial): pedir cancelamento
 *    ao provedor de uma cobrança que ele não conhece devolveria erro e
 *    esconderia o fato de que não há nada a cancelar.
 * 3. FALHA DO PROVEDOR NÃO MENTE. Se o Asaas não responde, a intenção continua
 *    como estava, com o erro registrado. Marcá-la "cancelada" aqui diria que o
 *    boleto morreu enquanto ele segue vivo lá fora — e é justamente a tela onde
 *    alguém decide não perseguir mais aquela cobrança.
 *
 * A diferença para `cancelOrderCharges`: lá a falha do provedor NÃO pode travar
 * o cancelamento do pedido (a alternativa seria manter reservado um estoque que
 * ninguém vai comprar). Aqui não há nada preso esperando — o título continua
 * onde está — então a verdade cabe inteira no resultado.
 */
export async function cancelFinanceEntryCharges(input: {
  companyId: string;
  entryId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ cancelled: number; failed: number }> {
  ensureCoreSchema();
  const db = getConnection();
  // Confere o TÍTULO antes de tocar em cobrança: título de outra operação é
  // 404, pelo mesmo motivo de `carregarTitulo` — dizer "existe, mas não é seu"
  // já conta ao vizinho que o id existe.
  carregarTitulo(input.companyId, input.entryId);

  const vivas = cobrancasDoTitulo(input.companyId, input.entryId).filter(
    (i) => vidaDe(i.status) === 'viva',
  );

  let cancelled = 0;
  let failed = 0;

  for (const intent of vivas) {
    const agora = new Date().toISOString();
    if (!intent.provider_ref) {
      /*
        A DECISÃO 2 TINHA UMA EXCEÇÃO QUE ELA NÃO VIA (GAP-PRD-049). "Nunca
        chegou a existir lá fora" vale para a intenção que nunca FOI ao
        provedor. A que foi e voltou sem resposta (timeout) pode ter deixado a
        cobrança viva: procura-se pela referência externa e cancela-se lá. Se
        a consulta falhar, vale a decisão 3 — a intenção continua como estava,
        com o erro, e ninguém lê "cancelada" sobre um boleto que talvez viva.
      */
      let referencia: string | null = null;
      if (tentouNoProvedor(intent)) {
        try {
          referencia = await cancelarCobrancasOrfas({
            gateway: new AsaasHttpClient({
              environment: intent.environment as 'sandbox' | 'production',
              companyId: input.companyId,
              fetchImpl: input.fetchImpl,
            }),
            originId: input.entryId,
            method: intent.method,
            amountCents: intent.amount_cents,
          });
        } catch (err) {
          db.prepare(
            'UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?',
          ).run(`cancelamento: ${(err as Error).message}`, agora, intent.id);
          failed += 1;
          continue;
        }
      }
      db.prepare(
        `UPDATE core_payment_intents
            SET status = 'cancelled', provider_ref = COALESCE(provider_ref, ?), updated_at = ?
          WHERE id = ?`,
      ).run(referencia, agora, intent.id);
      cancelled += 1;
      continue;
    }
    try {
      const gateway = new AsaasHttpClient({
        environment: intent.environment as 'sandbox' | 'production',
        companyId: input.companyId,
        fetchImpl: input.fetchImpl,
      });
      await gateway.cancelPayment(intent.provider_ref);
      db.prepare(
        "UPDATE core_payment_intents SET status = 'cancelled', updated_at = ? WHERE id = ?",
      ).run(agora, intent.id);
      cancelled += 1;
    } catch (err) {
      // A mensagem do cliente HTTP nunca carrega a chave da operação.
      db.prepare(
        'UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?',
      ).run(`cancelamento: ${(err as Error).message}`, agora, intent.id);
      failed += 1;
    }
  }

  return { cancelled, failed };
}
