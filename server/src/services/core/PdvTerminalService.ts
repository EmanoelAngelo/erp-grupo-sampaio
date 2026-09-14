/**
 * Ponte entre o PDV e a maquininha.
 *
 * NÃO reimplementa nada: o domínio de terminal já existe em
 * `services/payment-terminal/` (configuração, credencial, adaptador de
 * provedor, agente local, homologação). Aqui só se traduz aquilo para o que o
 * balcão precisa saber, com os estados que o operador enxerga na tela.
 *
 * A REGRA QUE NÃO PODE CAIR
 * -------------------------
 * Clicar em "Crédito" não é receber. Quando existe maquininha configurada, o
 * pagamento em cartão só entra na venda depois que o provedor confirmar. Sem
 * isso, o caixa fecharia com dinheiro que o banco nunca vai repassar.
 *
 * E quando o sistema NÃO SABE se aprovou — a maquininha respondeu tarde, caiu
 * a rede no meio — o estado é `timeout_nao_confirmado`, e ele não avança
 * sozinho para lugar nenhum:
 *
 *   não finaliza a venda        (poderia entregar mercadoria sem receber)
 *   não cobra de novo           (poderia cobrar o cliente duas vezes)
 *   não marca como recusado     (poderia perder uma venda já paga)
 *
 * A única saída é alguém conferir no extrato do provedor e dizer o que houve.
 * Isso é `reconcileTerminalPayment`, e fica registrado em auditoria.
 */
import { ApiError } from '../../utils/errors.js';
import { getConnection } from '../../db/sqlite.js';
import { recordAudit } from '../audit/AuditService.js';
import {
  createAndProcessPaymentTerminalTransactionBackend,
  getPaymentTerminalTransactionBackend,
  isTerminalChargeOrphan,
  listPaymentTerminalConfigurationsBackend,
  listPaymentTerminalConfigurationsRaw,
  listPaymentTerminalTransactionsBackend,
  setPaymentTerminalConfigurationActiveBackend,
  updatePaymentTerminalTransactionBackend,
} from '../payment-terminal/PaymentTerminalService.js';
import {
  ambienteQueBloqueiaOMock,
  assertMockProviderAllowed,
} from '../payment-terminal/PaymentTerminalCredentialService.js';
import { driverDe } from '../payment-terminal/PaymentTerminalChannels.js';
import { agenteDoCaixa, agenteOnline } from '../payment-terminal/PaymentTerminalLocalAgentService.js';
import { prontidaoDasConfiguracoes } from '../payment-terminal/PaymentTerminalReadinessService.js';
import { expirarComandosVencidos } from '../payment-terminal/PaymentTerminalAgentChannel.js';

/** Estados que o operador vê. */
export type TerminalState =
  | 'aguardando_terminal'
  | 'aguardando_cliente'
  | 'processando'
  | 'aprovado'
  | 'recusado'
  | 'cancelado'
  | 'timeout_nao_confirmado'
  | 'erro';

/** Estados em que a venda NÃO pode ser fechada. */
const NOT_SETTLED = new Set<TerminalState>([
  'aguardando_terminal',
  'aguardando_cliente',
  'processando',
  'recusado',
  'cancelado',
  'timeout_nao_confirmado',
  'erro',
]);

/** O que o provedor devolve → o que o balcão entende. */
const STATUS_MAP: Record<string, TerminalState> = {
  authorized: 'aprovado',
  confirmed: 'aprovado',
  approved: 'aprovado',
  declined: 'recusado',
  cancelled: 'cancelado',
  canceled: 'cancelado',
  // Estornada (inteira ou em parte) não paga venda nenhuma: para o balcão é
  // uma cobrança desfeita. Sem estas duas linhas ela cairia em "erro".
  refunded: 'cancelado',
  partially_refunded: 'cancelado',
  timeout_uncertain: 'timeout_nao_confirmado',
  failed: 'erro',
  created: 'aguardando_terminal',
  in_progress: 'processando',
};

/** Mensagem que o operador lê, por estado. */
const STATE_MESSAGE: Record<TerminalState, string> = {
  aguardando_terminal: 'Enviando para a maquininha…',
  aguardando_cliente: 'Peça para o cliente passar o cartão.',
  processando: 'Processando na operadora…',
  aprovado: 'Pagamento aprovado.',
  recusado: 'Pagamento recusado pela operadora. Tente outro meio.',
  cancelado: 'Operação cancelada na maquininha.',
  timeout_nao_confirmado:
    'STATUS DO PAGAMENTO NÃO CONFIRMADO. Não repita a cobrança: confira no extrato da operadora e registre o resultado.',
  erro: 'Falha na comunicação com a maquininha.',
};

/** Cartão sempre passa pela maquininha. */
const CARD_METHODS = new Set(['debito', 'credito']);

/**
 * PIX tem DOIS caminhos, e a diferença importa para o operador.
 *
 * Com maquininha integrada, o QR aparece no aparelho e o cliente escaneia ali
 * — é o que o balcão espera. Sem ela, o PIX continua sendo o do provedor de
 * cobrança, com o QR na tela do computador.
 *
 * O método na venda é o mesmo (): quem muda é por onde ele passa. Criar
 * dois métodos de pagamento faria o relatório financeiro separar em duas
 * linhas o que é uma coisa só.
 */
export function methodNeedsTerminal(method: string, companyId?: string, pdvTerminalId?: string | null): boolean {
  if (CARD_METHODS.has(method)) return true;
  if (method !== 'pix' || !companyId) return false;
  return getTerminalStatus(companyId, pdvTerminalId).configured;
}

export interface TerminalStatus {
  /** Existe maquininha configurada para esta operação? */
  configured: boolean;
  provider: string | null;
  /**
   * `READY_FOR_HARDWARE` enquanto não houver equipamento e credencial reais.
   * Nunca `HOMOLOGATED` — isso exige teste com maquininha física.
   */
  readiness: 'READY_FOR_HARDWARE' | 'CONFIGURED';
  message: string;
  /**
   * A maquininha integrada é a de TESTE (provider mock): as cobranças são
   * simuladas e nenhum dinheiro troca de mãos. Só é `true` em dev/teste — em
   * produção a configuração de teste é ignorada (ver `getTerminalStatus`).
   */
  simulated: boolean;
  /** A configuração que atende este caixa — é ela que a cobrança usa (GAP-PRD-014). */
  configurationId?: string | null;
  /** Por onde a cobrança chega ao aparelho. */
  channel?: 'mock' | 'local_agent' | 'cloud' | null;
  /**
   * O caminho está de pé AGORA? No agente local: pareado e falando. `false`
   * com `configured: true` quer dizer "o cartão exige o aparelho, e o aparelho
   * não está alcançável" — a tela avisa antes de o operador tentar cobrar.
   */
  channelReady?: boolean;
  /** Só maquininhas presas a caixas, e o pedido não disse de qual caixa é. */
  requiresTerminal?: boolean;
  /** O caixa (`core_terminals`) para o qual esta resposta vale. */
  pdvTerminalId?: string | null;
}

const SEM_MAQUININHA =
  'Nenhuma maquininha integrada nesta operação. O cartão será lançado manualmente — confira o comprovante da maquininha avulsa antes de finalizar.';

/** Entre várias ligadas no mesmo nível, a principal; depois a mais antiga. */
function porPreferencia(a: Record<string, unknown>, b: Record<string, unknown>): number {
  if ((a.primary === true) !== (b.primary === true)) return a.primary === true ? -1 : 1;
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
}

/**
 * O PDV pergunta isso ao abrir o pagamento.
 *
 * Sem maquininha configurada, cartão continua sendo lançado à mão (a loja
 * pode ter uma maquininha avulsa da adquirente) — mas a tela precisa dizer
 * isso ao operador, e não fingir que houve confirmação automática.
 *
 * DUAS COISAS QUE ESTA LEITURA NÃO FAZIA (GAP-PRD-001):
 *
 * 1. Ler `active`. Ela passava pela lista SANITIZADA, que descartava o campo,
 *    e `undefined !== false` fazia toda configuração contar como ligada.
 *    Agora lê a linha como está gravada.
 *
 * 2. Ignorar a maquininha de TESTE onde existe dinheiro. O banco real da
 *    Preço Justo tem uma configuração `mock` ativa; em produção ela ligava a
 *    exigência de cobrança no aparelho, a cobrança batia na trava do mock
 *    (403) e o balcão não fechava cartão nenhum. A trava existia na escrita e
 *    na cobrança — faltava na LEITURA. Agora, em produção/homologação (pelos
 *    dois nomes, `DEVORA_API_ENV` e `NODE_ENV`), a configuração de teste não
 *    conta: o balcão volta ao cartão lançado à mão, como nas outras cinco
 *    operações, e a mensagem diz que existe uma configuração de teste
 *    ignorada para o gestor desligar.
 *
 * E DUAS QUE ELA PASSOU A FAZER (GAP-PRD-014):
 *
 * 3. Ignorar configuração cujo CAMINHO não existe (nuvem sem adaptador).
 *    Antes ela contava, e o balcão exigia no cartão uma cobrança que nenhum
 *    código sabia fazer: a loja parava de vender cartão.
 *
 * 4. Responder POR CAIXA. A maquininha pode ser da operação inteira ou de um
 *    caixa (`pdvTerminalId`). O Caixa 2 usa a dele, ou a da operação; nunca a
 *    do Caixa 1. Sem caixa no pedido, vale a da operação — e se só houver
 *    maquininhas presas a caixas, a resposta é `configured` com
 *    `requiresTerminal`: omitir o caixa nunca afrouxa a exigência do cartão.
 */
export function getTerminalStatus(companyId: string, pdvTerminalId?: string | null): TerminalStatus {
  const ligadas = listPaymentTerminalConfigurationsRaw(companyId).filter((c) => c.active !== false);
  const bloqueioDoMock = ambienteQueBloqueiaOMock();
  const semTesteBloqueado = bloqueioDoMock ? ligadas.filter((c) => c.provider !== 'mock') : ligadas;
  const utilizaveis = semTesteBloqueado.filter((c) => driverDe(c).implemented).sort(porPreferencia);
  const semCaminho = semTesteBloqueado.filter((c) => !driverDe(c).implemented);
  const caixa = pdvTerminalId ?? null;
  const daOperacao = utilizaveis.filter((c) => !c.pdvTerminalId);
  const doCaixa = caixa ? utilizaveis.filter((c) => c.pdvTerminalId === caixa) : [];
  const active = doCaixa[0] ?? daOperacao[0];

  if (!active) {
    if (!caixa && utilizaveis.length > 0) {
      // Só maquininhas presas a caixas, e o pedido não disse de qual. A
      // exigência do cartão vale (senão bastaria omitir o caixa para lançar
      // cartão sem cobrança); a cobrança é que pede o caixa.
      const primeira = utilizaveis[0];
      return {
        configured: true,
        provider: (primeira.provider as string | undefined) ?? null,
        readiness: 'READY_FOR_HARDWARE',
        simulated: primeira.provider === 'mock',
        configurationId: null,
        channel: driverDe(primeira).channel,
        channelReady: false,
        requiresTerminal: true,
        pdvTerminalId: null,
        message:
          'As maquininhas desta operação estão presas a caixas. Escolha o caixa deste computador para cobrar no aparelho.',
      };
    }
    const testeIgnorada = bloqueioDoMock !== null && ligadas.some((c) => c.provider === 'mock');
    const nomes = semCaminho.map((c) => String(c.displayName ?? c.provider)).join(', ');
    return {
      configured: false,
      provider: null,
      readiness: 'READY_FOR_HARDWARE',
      simulated: false,
      configurationId: null,
      channel: null,
      channelReady: false,
      pdvTerminalId: caixa,
      message: testeIgnorada
        ? `Há uma maquininha de TESTE ligada nesta operação, ignorada em ${bloqueioDoMock}: ela aprovaria sem dinheiro. `
          + 'O cartão será lançado manualmente — confira o comprovante da maquininha avulsa. '
          + 'Peça ao gestor para desligá-la em Vendas › Conferência de maquininha.'
        : semCaminho.length
          ? `A maquininha ${nomes} está cadastrada num caminho que este sistema não opera (integração pela nuvem). `
            + 'O cartão será lançado manualmente — confira o comprovante da maquininha avulsa.'
          : SEM_MAQUININHA,
    };
  }

  const provider = (active.provider as string | undefined) ?? null;
  const driver = driverDe(active);
  if (provider === 'mock') {
    return {
      configured: true,
      provider,
      readiness: 'READY_FOR_HARDWARE',
      simulated: true,
      configurationId: String(active.id),
      channel: 'mock',
      channelReady: true,
      pdvTerminalId: caixa,
      message:
        'Maquininha de TESTE (simulada): as cobranças NÃO movimentam dinheiro. Use só para ensaio — '
        + 'nunca para vender de verdade.',
    };
  }

  if (driver.channel === 'local_agent') {
    const agente = agenteDoCaixa(companyId, (active.pdvTerminalId as string | null | undefined) ?? null);
    const online = agenteOnline(agente);
    const nome = String(active.displayName ?? provider ?? '');
    return {
      configured: true,
      provider,
      readiness: 'READY_FOR_HARDWARE',
      simulated: false,
      configurationId: String(active.id),
      channel: 'local_agent',
      channelReady: online,
      pdvTerminalId: caixa,
      message: !agente
        ? `Maquininha ${nome} ligada, mas sem agente local pareado. O cartão NÃO pode ser cobrado até o agente ser `
          + 'pareado — ou até o gestor desligar a maquininha.'
        : !online
          ? `O agente local da maquininha ${nome} está fora do ar. Ligue o computador do caixa/agente antes de cobrar `
            + 'no cartão — ou peça ao gestor para desligar a maquininha.'
          : `Maquininha ${nome} integrada pelo agente local. O pagamento só entra na venda após a confirmação da operadora.`,
    };
  }

  return {
    configured: true,
    provider,
    readiness: 'READY_FOR_HARDWARE',
    simulated: false,
    configurationId: String(active.id),
    channel: driver.channel,
    channelReady: true,
    pdvTerminalId: caixa,
    message: `Maquininha ${provider ?? ''} integrada. O pagamento só entra na venda após a confirmação da operadora.`,
  };
}

/**
 * As maquininhas da operação, para o GESTOR (GAP-PRD-001 + GAP-PRD-014).
 *
 * Forma sanitizada (nada de credencial) com a leitura do ambiente ao lado:
 * `blockedInThisEnvironment` diz que a configuração de teste está gravada mas
 * não opera aqui — que é o caso da linha da Preço Justo em produção. E, desde
 * o GAP-PRD-014, cada uma vem com o caminho (canal), o agente do caixa dela e
 * a prontidão medida (homologação por evidência).
 */
export function listTerminalConfigurationsForManager(companyId: string) {
  const bloqueioDoMock = ambienteQueBloqueiaOMock();
  const prontidao = new Map(prontidaoDasConfiguracoes(companyId).map((p) => [p.configurationId, p]));
  return {
    environmentBlocksTestProvider: bloqueioDoMock,
    items: listPaymentTerminalConfigurationsBackend(companyId).map((c) => {
      const p = prontidao.get(String(c.id));
      return {
        ...c,
        blockedInThisEnvironment: c.provider === 'mock' && bloqueioDoMock !== null,
        readinessStatus: p?.status ?? null,
        agent: p?.agent ?? null,
        homologation: p?.homologation ?? null,
        blockingReasons: p?.blockingReasons ?? [],
      };
    }),
  };
}

/** Liga/desliga pela porta do gestor. As regras moram no serviço do módulo. */
export function setTerminalConfigurationActive(input: {
  companyId: string;
  userId: string;
  configurationId: string;
  active: boolean;
  reason: string;
}) {
  return setPaymentTerminalConfigurationActiveBackend(input);
}

export interface TerminalPaymentResult {
  transactionId: string;
  state: TerminalState;
  message: string;
  /** Só `true` quando o provedor confirmou. É isto que libera a venda. */
  settled: boolean;
  /** `true` quando ninguém sabe o que aconteceu — exige conferência humana. */
  needsReconciliation: boolean;
  amountInCents: number;
  method: string;
  maskedCard?: string | null;
  authorizationCode?: string | null;
  /** Resposta simulada por adaptador mock, não cobrança real. */
  simulated: boolean;
  /**
   * Copia-e-cola do PIX, enquanto pendente. A maquininha exibe em QR; a tela
   * mostra o mesmo código para o caso de o aparelho estar longe do operador.
   */
  qrPayload?: string | null;
  /**
   * A cobrança ainda está andando no aparelho (agente local): a tela consulta
   * de novo em alguns segundos, sem cobrar outra vez (GAP-PRD-014).
   */
  pending?: boolean;
  /** Por onde esta cobrança foi feita. */
  channel?: string | null;
}

/** Estados que ainda vão mudar sozinhos — a tela consulta de novo. */
const EM_ANDAMENTO = new Set<TerminalState>(['aguardando_terminal', 'aguardando_cliente', 'processando']);

/**
 * A cobrança como o balcão a enxerga — a MESMA tradução que o PDV usa, para
 * a fila de cobranças sem venda e o fechamento do turno (GAP-PRD-078/081)
 * não inventarem uma segunda leitura do estado do provedor.
 */
export function vistaDaCobranca(row: Record<string, unknown>): TerminalPaymentResult {
  return toResult(row);
}

/**
 * A gaveta aberta de onde esta cobrança sai (GAP-PRD-081): a do caixa do
 * pedido; sem caixa no pedido, a gaveta sem caixa — ou a ÚNICA aberta. É o
 * carimbo que liga a cobrança ao turno, para o fechamento saber o que é dele.
 * Nenhuma, ou várias sem caixa no pedido: nulo, e o fechamento cai na janela
 * de tempo do turno.
 */
function gavetaAbertaDaCobranca(companyId: string, caixa: string | null): string | null {
  const db = getConnection();
  const doCaixa = db
    .prepare(
      "SELECT id FROM core_cash_sessions WHERE company_id = ? AND status = 'open' AND terminal_id IS ?",
    )
    .get(companyId, caixa) as { id: string } | undefined;
  if (doCaixa) return doCaixa.id;
  if (caixa) return null;
  const abertas = db
    .prepare("SELECT id FROM core_cash_sessions WHERE company_id = ? AND status = 'open'")
    .all(companyId) as unknown as { id: string }[];
  return abertas.length === 1 ? abertas[0].id : null;
}

function toResult(row: Record<string, unknown>): TerminalPaymentResult {
  const raw = String(row.status ?? 'failed');
  /*
    A cobrança que ficou "falando com o provedor" sem ninguém esperando por
    ela (GAP-PRD-008) é NÃO CONFIRMADA, e não "processando": o processo que
    aguardava a resposta morreu, e ninguém sabe se o cliente foi cobrado.
    Mostrá-la como processando para sempre deixaria o PDV esperando algo que
    não vem — e fora da fila de conferência do gestor.
  */
  let state: TerminalState = isTerminalChargeOrphan(row) ? 'timeout_nao_confirmado' : (STATUS_MAP[raw] ?? 'erro');
  /*
    Pelo agente local (GAP-PRD-014) a cobrança anda em etapas que o operador
    precisa ver: ainda na fila (o agente não pegou), no aparelho esperando o
    cartão, processando na operadora. E a mensagem do próprio PinPad ("INSIRA
    OU PASSE O CARTÃO", "SENHA") vale mais que a genérica.
  */
  const peloAgente = row.channel === 'local_agent';
  if (peloAgente && raw === 'in_progress' && row.providerCallState === 'awaiting_agent') {
    state = row.agentStage === 'queued'
      ? 'aguardando_terminal'
      : row.agentStage === 'awaiting_customer'
        ? 'aguardando_cliente'
        : 'processando';
  }
  const doAparelho = peloAgente
    ? ((EM_ANDAMENTO.has(state) ? row.agentMessage : row.providerMessage) as string | null | undefined)
    : null;
  const mensagem = state === 'timeout_nao_confirmado' || !doAparelho
    ? STATE_MESSAGE[state]
    : state === 'aprovado'
      ? STATE_MESSAGE[state]
      : `${STATE_MESSAGE[state]} ${doAparelho}`.trim();
  return {
    transactionId: String(row.id),
    state,
    message: mensagem,
    settled: !NOT_SETTLED.has(state),
    needsReconciliation: state === 'timeout_nao_confirmado',
    amountInCents: Number(row.amountInCents ?? 0),
    method: String(row.paymentMethod ?? ''),
    maskedCard: (row.maskedCard as string | null) ?? null,
    authorizationCode: (row.providerAuthorizationCode as string | null) ?? null,
    simulated: row.simulated === true,
    qrPayload: (row.qrPayload as string | null) ?? null,
    pending: EM_ANDAMENTO.has(state),
    channel: (row.channel as string | undefined) ?? (row.provider === 'mock' ? 'mock' : null),
  };
}

/**
 * Dispara a cobrança na maquininha.
 *
 * A chave de idempotência é do PDV: reenvio por queda de rede devolve a mesma
 * transação em vez de cobrar o cliente outra vez.
 *
 * O CAIXA ENTRA NA CONTA (GAP-PRD-014): a cobrança vai para a maquininha do
 * caixa deste pedido (ou a da operação) — nunca para o PinPad do caixa ao
 * lado. Pelo agente local, a resposta volta `processando` e a tela consulta
 * `GET /core/pdv/terminal/:id` até o aparelho responder.
 */
export async function chargeOnTerminal(input: {
  companyId: string;
  userId: string;
  method: string;
  amountInCents: number;
  installments?: number;
  idempotencyKey: string;
  /** Cenário de teste do adaptador mock (`decline`, `timeout`…). */
  scenario?: string;
  storeId?: string | null;
  /** O caixa (`core_terminals`) de onde o operador cobra. */
  pdvTerminalId?: string | null;
}): Promise<TerminalPaymentResult> {
  if (!methodNeedsTerminal(input.method, input.companyId, input.pdvTerminalId)) {
    throw new ApiError(
      'CORE_TERMINAL_METHOD_INVALID',
      `${input.method} não passa pela maquininha.`,
      400,
    );
  }
  if (!(input.amountInCents > 0)) {
    throw new ApiError('CORE_TERMINAL_AMOUNT_INVALID', 'Valor deve ser maior que zero.', 400);
  }

  const status = getTerminalStatus(input.companyId, input.pdvTerminalId);
  if (!status.configured) {
    throw new ApiError(
      'CORE_TERMINAL_NOT_CONFIGURED',
      'Nenhuma maquininha integrada nesta operação.',
      409,
      { readiness: 'READY_FOR_HARDWARE' },
    );
  }
  if (status.requiresTerminal) {
    throw new ApiError('CORE_TERMINAL_CAIXA_REQUIRED', status.message, 409);
  }

  const row = (await createAndProcessPaymentTerminalTransactionBackend({
    companyId: input.companyId,
    provider: status.provider ?? 'mock',
    configurationId: status.configurationId ?? undefined,
    // O domínio de terminal fala em credit/debit.
    paymentMethod:
      input.method === 'credito' ? 'credit' : input.method === 'pix' ? 'pix' : 'debit',
    amountInCents: input.amountInCents,
    installments: input.installments ?? 1,
    idempotencyKey: input.idempotencyKey,
    scenario: input.scenario,
    storeId: input.storeId ?? undefined,
    createdBy: input.userId,
    // O caixa e o turno de onde se cobrou (GAP-PRD-081): o fechamento da
    // gaveta confere as cobranças DELE, não as do caixa ao lado.
    pdvTerminalId: input.pdvTerminalId ?? null,
    cashSessionId: gavetaAbertaDaCobranca(input.companyId, input.pdvTerminalId ?? null),
  })) as Record<string, unknown>;

  const result = toResult(row);

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: `pdv.terminal.${result.state}`,
    entityType: 'payment_terminal_transaction',
    entityId: result.transactionId,
    detail: {
      amountInCents: result.amountInCents,
      method: input.method,
      simulated: result.simulated,
      channel: result.channel ?? null,
      pdvTerminalId: input.pdvTerminalId ?? null,
    },
  });

  return result;
}

/**
 * Cobranças que ficaram sem resposta e travam o caixa.
 *
 * É a fila de trabalho do gestor: cada linha aqui é uma venda que não fechou
 * porque ninguém sabe se o cliente pagou.
 */
export function listUncertainPayments(companyId: string): TerminalPaymentResult[] {
  // A cobrança do agente que venceu o prazo de resposta entra na fila AGORA,
  // e não na próxima vez que alguém mexer na fila de comandos.
  expirarComandosVencidos(companyId);
  const rows = listPaymentTerminalTransactionsBackend(companyId) as unknown as Record<
    string,
    unknown
  >[];
  return rows.map(toResult).filter((r) => r.needsReconciliation);
}

/** Consulta o estado atual — usada quando o operador manda "consultar de novo". */
export function getTerminalPayment(companyId: string, transactionId: string): TerminalPaymentResult {
  expirarComandosVencidos(companyId);
  const row = getPaymentTerminalTransactionBackend(companyId, transactionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new ApiError('CORE_TERMINAL_TX_NOT_FOUND', 'Transação não encontrada.', 404);
  }
  return toResult(row);
}

/**
 * Fecha à mão uma transação que ficou sem resposta.
 *
 * Alguém olhou o extrato da operadora e está afirmando o que aconteceu. Por
 * isso exige motivo e fica na auditoria com o nome de quem afirmou: se depois
 * o extrato disser outra coisa, dá para saber quem decidiu e com base em quê.
 *
 * O sistema NUNCA faz isso sozinho.
 */
export function reconcileTerminalPayment(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  outcome: 'aprovado' | 'recusado';
  reason: string;
}): TerminalPaymentResult {
  const current = getTerminalPayment(input.companyId, input.transactionId);

  if (!current.needsReconciliation) {
    throw new ApiError(
      'CORE_TERMINAL_NOT_UNCERTAIN',
      `Esta transação já está ${current.state}. Só o estado não confirmado é reconciliado.`,
      409,
    );
  }
  if (!input.reason?.trim()) {
    throw new ApiError(
      'CORE_TERMINAL_REASON_REQUIRED',
      'Informe o que foi verificado no extrato da operadora.',
      400,
    );
  }

  // O desfecho é GRAVADO. Sem isto a transação continuaria na fila de
  // conferência para sempre, e o gestor reconciliaria a mesma cobrança de novo
  // a cada vez que abrisse a tela.
  updatePaymentTerminalTransactionBackend(input.transactionId, {
    status: input.outcome === 'aprovado' ? 'authorized' : 'declined',
    // A órfã (GAP-PRD-008) sai do estado "esperando o provedor": quem
    // respondeu agora foi o extrato, lido por gente.
    providerCallState: 'reconciled',
    reconciledAt: new Date().toISOString(),
    reconciledBy: input.userId,
    reconciliationReason: input.reason,
  });

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: `pdv.terminal.reconciliado.${input.outcome}`,
    entityType: 'payment_terminal_transaction',
    entityId: input.transactionId,
    detail: { reason: input.reason, previousState: current.state },
  });

  return {
    ...current,
    state: input.outcome,
    message:
      input.outcome === 'aprovado'
        ? 'Confirmado manualmente pelo extrato da operadora.'
        : 'Confirmado como não pago pelo extrato da operadora.',
    settled: input.outcome === 'aprovado',
    needsReconciliation: false,
  };
}

/*
  Aqui existiram `terminalIdempotencyKey` e `newTerminalKey`, geradores de
  chave que nenhum código jamais chamou: a cobrança na maquininha recebe a
  chave de idempotência de quem a cria (o PDV manda a dele), e um gerador
  paralelo no servidor era uma segunda origem de verdade esperando divergir.
  Saíram MEDIDOS, com zero chamadores em código, tela e teste.
*/

/*
  ==========================================================================
  O VÍNCULO ENTRE A COBRANÇA E A VENDA (GAP-V48)
  ==========================================================================

  O QUE HAVIA ANTES

  A garantia "a venda só fecha depois da confirmação da operadora" morava
  INTEIRA na tela: era o `PagamentoDialog` que, ao ver `settled: false`, não
  lançava a linha de pagamento. O servidor conferia método e valor da linha
  `credito`/`debito` e nada mais — nem de onde ela veio.

  Consequência, medida por leitura: com maquininha configurada, um POST
  /core/sales com `{"method":"credito","amountCents":15000}` fechava a venda,
  baixava o estoque e liquidava o financeiro sem que UMA ÚNICA cobrança
  tivesse ido ao aparelho. A regra mais cara do balcão dependia de o cliente
  ser a nossa própria tela.

  E o inverso também faltava: `payment_terminal_transactions` não sabia de que
  VENDA era cada cobrança. Depois de uma reconciliação aprovada (o gestor
  confere o extrato e afirma que passou), não havia como fechar o ciclo — a
  transação aprovada e a venda ficavam duas ilhas.

  O QUE PASSA A VALER

  Com maquininha configurada na operação, toda linha de cartão precisa apontar
  (por `providerRef`) uma transação DESTA empresa, APROVADA, do MESMO valor e
  do MESMO método, AINDA NÃO gasta em outra venda. Depois que a venda existe,
  o id dela é carimbado na transação — e é esse carimbo que impede a segunda
  venda de reaproveitar a mesma cobrança.

  SEM MAQUININHA CONFIGURADA NADA MUDA. A loja pode ter uma maquininha avulsa
  da adquirente, e o cartão continua sendo lançado à mão contra o comprovante
  de papel: exigir transação de um aparelho que não existe pararia o balcão de
  cinco das seis operações.

  O PIX FICA DE FORA, de propósito. PIX tem DOIS caminhos (ver
  `methodNeedsTerminal`), e o de fora do aparelho — QR do provedor de cobrança
  na tela do computador — é legítimo e continua não tendo transação de
  terminal nenhuma. Exigir vínculo ali recusaria um recebimento verdadeiro.
*/

/** Transação de maquininha já amarrada a uma venda: qual, e de quem. */
export interface TerminalTransactionForSale {
  transactionId: string;
  provider: string | null;
  amountInCents: number;
  method: string;
  simulated: boolean;
  saleId: string | null;
}

/** O que o balcão chama de método × o que o domínio de terminal grava. */
const METHOD_NO_TERMINAL: Record<string, string> = {
  credito: 'credit',
  debito: 'debit',
  pix: 'pix',
};

/**
 * Confere que uma linha de cartão está lastreada numa cobrança aprovada.
 *
 * Não escreve nada: quem carimba a venda é `bindTerminalTransactionToSale`,
 * depois que a venda existe. Aqui só se responde "esta cobrança serve para
 * esta linha?" — e cada recusa diz o que fazer.
 */
export function assertCardPaymentBackedByTerminal(input: {
  companyId: string;
  method: string;
  amountInCents: number;
  transactionId?: string | null;
}): TerminalTransactionForSale {
  const id = String(input.transactionId ?? '').trim();
  if (!id) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_REF_REQUIRED',
      `Esta operação tem maquininha integrada: o pagamento em ${input.method} só entra na `
        + 'venda com a transação aprovada da operadora. Cobre no aparelho e envie a '
        + 'transação em providerRef.',
      400,
      { method: input.method },
    );
  }

  const row = getPaymentTerminalTransactionBackend(input.companyId, id) as
    | Record<string, unknown>
    | undefined;
  /*
    A CONSULTA JÁ VEM CERCADA POR EMPRESA, e é isso que responde à falsificação
    mais óbvia: pegar o id de uma cobrança aprovada da loja vizinha e colá-lo
    na venda daqui. Para quem tenta, a transação simplesmente não existe.
  */
  if (!row) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_NOT_FOUND',
      'A transação da maquininha informada não existe nesta operação.',
      400,
      { transactionId: id },
    );
  }

  const atual = toResult(row);

  if (!atual.settled) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_NOT_APPROVED',
      `A cobrança da maquininha está "${atual.state}". ${STATE_MESSAGE[atual.state]}`,
      409,
      { transactionId: id, state: atual.state },
    );
  }

  const esperado = METHOD_NO_TERMINAL[input.method] ?? input.method;
  if (atual.method !== esperado) {
    // Débito cobrado no aparelho não fecha uma linha de crédito: o dinheiro
    // cai em prazo diferente, e a conferência de maquininha compararia peras
    // com maçãs.
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_METHOD_MISMATCH',
      `A cobrança da maquininha é de "${atual.method}" e a linha da venda é de `
        + `"${input.method}".`,
      409,
      { transactionId: id, expected: esperado, found: atual.method },
    );
  }

  if (atual.amountInCents !== input.amountInCents) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_AMOUNT_MISMATCH',
      `A cobrança aprovada foi de ${(atual.amountInCents / 100).toFixed(2)} e a linha da `
        + `venda diz ${(input.amountInCents / 100).toFixed(2)}.`,
      409,
      { transactionId: id, approved: atual.amountInCents, requested: input.amountInCents },
    );
  }

  const jaUsada = (row.saleId as string | null) ?? null;
  if (jaUsada) {
    // Uma cobrança paga UMA venda. Sem esta trava, o mesmo comprovante fecharia
    // duas vendas e a loja entregaria mercadoria de graça na segunda.
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_ALREADY_USED',
      'Esta cobrança da maquininha já foi usada em outra venda.',
      409,
      { transactionId: id, saleId: jaUsada },
    );
  }

  return {
    transactionId: atual.transactionId,
    provider: (row.provider as string | null) ?? null,
    amountInCents: atual.amountInCents,
    method: atual.method,
    simulated: atual.simulated,
    saleId: null,
  };
}

/**
 * Carimba a venda na transação — o outro lado do vínculo.
 *
 * Roda na MESMA transação de banco da venda: se a venda falhar depois disto, o
 * carimbo volta atrás e a cobrança continua disponível para a próxima
 * tentativa. Uma cobrança marcada como gasta numa venda que não existe seria
 * dinheiro do cliente preso sem documento.
 */
export function bindTerminalTransactionToSale(input: {
  companyId: string;
  transactionId: string;
  saleId: string;
  saleNumber?: number | null;
}): void {
  // A cerca por empresa é conferida DE NOVO aqui, e não herdada da chamada
  // anterior: `updatePaymentTerminalTransactionBackend` grava por id puro, e
  // um chamador futuro que pulasse a conferência escreveria na transação de
  // outra operação.
  if (!getPaymentTerminalTransactionBackend(input.companyId, input.transactionId)) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_NOT_FOUND',
      'A transação da maquininha informada não existe nesta operação.',
      400,
      { transactionId: input.transactionId },
    );
  }
  updatePaymentTerminalTransactionBackend(input.transactionId, {
    saleId: input.saleId,
    saleNumber: input.saleNumber ?? null,
    boundAt: new Date().toISOString(),
  });
}

/** Esta referência é uma cobrança da maquininha DESTA empresa? (GAP-PRD-078) */
export function ehCobrancaDaMaquininha(companyId: string, transactionId: string): boolean {
  return Boolean(getPaymentTerminalTransactionBackend(companyId, transactionId));
}

/**
 * Consulta o estado do PIX na maquininha.
 *
 * O PDV chama isto em intervalos enquanto o QR está na tela do aparelho. O
 * resultado é o que o PROVEDOR diz — esta função não decide nada sozinha, e é
 * por isso que ela pode ser chamada quantas vezes for preciso sem efeito
 * colateral nenhum.
 */
export function consultarPagamentoTerminal(
  companyId: string,
  transactionId: string,
): TerminalPaymentResult {
  return getTerminalPayment(companyId, transactionId);
}

/**
 * Confirmação de PIX em ambiente de TESTE.
 *
 * Por que isto existe e por que é assim:
 *
 * O PIX na maquininha é assíncrono — o QR aparece, o cliente paga e o provedor
 * avisa. Sem aparelho físico e sem SDK da adquirente, não há quem avise. Se o
 * mock confirmasse sozinho depois de alguns segundos, o sistema estaria
 * SIMULANDO APROVAÇÃO DE PAGAMENTO: diria que recebeu dinheiro que ninguém
 * pagou, e é esse exato defeito que este ERP não pode ter.
 *
 * Então a confirmação de teste exige uma ação explícita de quem está testando,
 * fica marcada como simulada até a venda, e é RECUSADA fora do provedor mock —
 * em produção esta porta não existe.
 */
export function confirmarPixDeTeste(input: {
  companyId: string;
  userId: string;
  transactionId: string;
}): TerminalPaymentResult {
  const status = getTerminalStatus(input.companyId);
  if (status.provider !== 'mock') {
    throw new ApiError(
      'CORE_TERMINAL_CONFIRM_NOT_ALLOWED',
      'Confirmação manual de PIX só existe no provedor de teste. Com maquininha real, '
        + 'quem confirma é a adquirente.',
      409,
    );
  }

  const atual = getTerminalPayment(input.companyId, input.transactionId);
  if (atual.settled) return atual;

  // A cobrança em si tem de ser do provider de teste — não basta a
  // configuração de hoje ser mock: uma cobrança feita por adquirente real não
  // se "confirma no braço". E a trava do mock vale aqui também (GAP-PRD-001):
  // esta porta aprova PIX sem dinheiro, e em produção ela não existe.
  const linha = getPaymentTerminalTransactionBackend(input.companyId, input.transactionId) as
    | Record<string, unknown>
    | null;
  if (linha?.provider !== 'mock') {
    throw new ApiError(
      'CORE_TERMINAL_CONFIRM_NOT_ALLOWED',
      'Esta cobrança não é do provedor de teste: quem confirma é a adquirente.',
      409,
    );
  }
  assertMockProviderAllowed('mock');

  updatePaymentTerminalTransactionBackend(input.transactionId, {
    status: 'authorized',
    authorizationCode: 'PIX-TESTE',
  });

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'pdv.terminal.pix_confirmado_teste',
    entityType: 'payment_terminal_transaction',
    entityId: input.transactionId,
    detail: { simulated: true },
  });

  return getTerminalPayment(input.companyId, input.transactionId);
}
