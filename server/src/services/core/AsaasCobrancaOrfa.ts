/**
 * A COBRANÇA QUE NASCEU LÁ E NÃO CHEGOU AQUI (GAP-PRD-049).
 *
 * ## O defeito
 *
 * O `POST /payments` sai, o Asaas cria a cobrança, e a resposta não volta a
 * tempo — o `AbortController` do cliente HTTP corta em `ASAAS_TIMEOUT_MS`. A
 * intenção ficava `failed` sem `provider_ref`, que é justamente o estado que o
 * "tentar de novo" aceita re-cobrar: a retentativa criava a SEGUNDA cobrança, e
 * o pagamento da primeira chegava pelo webhook como "Cobrança não encontrada no
 * ERP". Cliente com dois boletos; dinheiro na conta sem título vinculado.
 *
 * ## A pergunta que faltava
 *
 * Toda criação manda o id da origem como `externalReference`. Antes de criar
 * de novo — e antes de dar como cancelada uma cobrança que talvez exista —,
 * pergunta-se ao provedor por ela. Este módulo faz só a pergunta e a leitura
 * da resposta; o que fazer com o achado é de quem chamou.
 *
 * ## O que conta como "a mesma cobrança"
 *
 * Mesma referência externa, mesmo meio, mesmo valor, viva (não apagada nem
 * estornada) e SEM vínculo com outra intenção desta base. Cada filtro fecha
 * um erro conhecido: o PIX avulso do mesmo título não é o boleto que se
 * procura; a cobrança já vinculada a outra intenção não pode ser adotada duas
 * vezes; a cancelada não é a que o cliente vai pagar.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import type { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';

/** A cobrança como o provedor a descreve, só com o que se usa aqui. */
export interface CobrancaNoProvedor {
  id: string;
  status: string;
  valueCents: number | null;
  billingType: string | null;
  invoiceUrl: string | null;
  externalReference: string | null;
  dateCreated: string | null;
  /**
   * Plano de parcelas do cartão (GAP-PRD-114): todas as parcelas de um plano
   * vêm com a mesma referência externa e este mesmo id. Nulo à vista.
   */
  installment?: string | null;
}

/** Como cada meio se chama do lado do provedor. */
const TIPO_DO_MEIO: Record<string, string> = {
  pix: 'PIX',
  boleto: 'BOLETO',
  cartao: 'CREDIT_CARD',
};

/** Status em que a cobrança está de pé — pode ser paga, ou já foi. */
const STATUS_VIVOS = new Set([
  'PENDING',
  'OVERDUE',
  'AWAITING_RISK_ANALYSIS',
  'CONFIRMED',
  'RECEIVED',
  'RECEIVED_IN_CASH',
]);

/** Status em que o dinheiro já entrou por ela. */
export const STATUS_PAGOS_NO_PROVEDOR = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);

/**
 * O texto que a intenção guarda quando a criação tem desfecho INCERTO.
 *
 * "Falha de conexão" sozinha diz a quem lê que a cobrança não existe — e ela
 * pode existir. A frase diz as duas coisas que importam: talvez exista, e o
 * sistema vai conferir antes de gerar outra.
 */
export function motivoDeResultadoIncerto(erro: string): string {
  return (
    `${erro.trim().replace(/\.?$/, '.')} A cobrança pode ter sido criada no provedor mesmo assim: a próxima tentativa `
    + 'confere pela referência externa antes de gerar outra.'
  );
}

/**
 * A falha deixa a dúvida "criou ou não criou"?
 *
 * Recusa 4xx é resposta: o provedor disse não, e a cobrança não existe. Falta
 * de resposta (conexão, timeout) e erro 5xx não dizem nada — o pedido pode ter
 * sido gravado antes de a resposta se perder.
 */
export function falhaDeResultadoIncerto(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.code === 'ASAAS_CONNECTION_FAILED') return true;
  return err.code === 'ASAAS_REMOTE_ERROR' && Number(err.status) >= 500;
}

function lerCobranca(bruta: Record<string, unknown>): CobrancaNoProvedor {
  const valor = typeof bruta.value === 'number' ? bruta.value : Number(bruta.value);
  return {
    id: String(bruta.id ?? ''),
    status: String(bruta.status ?? ''),
    valueCents: Number.isFinite(valor) ? Math.round(valor * 100) : null,
    billingType: (bruta.billingType as string | undefined) ?? null,
    invoiceUrl: (bruta.invoiceUrl as string | undefined) ?? null,
    externalReference: (bruta.externalReference as string | undefined) ?? null,
    dateCreated: (bruta.dateCreated as string | undefined) ?? null,
    installment: (bruta.installment as string | undefined) ?? null,
  };
}

/** `provider_ref` já usado por alguma intenção desta base. */
function jaVinculada(providerRef: string): boolean {
  return Boolean(
    getConnection()
      .prepare('SELECT 1 AS n FROM core_payment_intents WHERE provider_ref = ? LIMIT 1')
      .get(providerRef),
  );
}

export interface ResultadoDaProcura {
  /** A cobrança a adotar — a mais antiga das que batem. */
  adotar: CobrancaNoProvedor | null;
  /** Outras que também batem: órfãs a mais, que alguém precisa cancelar. */
  sobrando: CobrancaNoProvedor[];
}

/**
 * Procura no provedor a cobrança que uma tentativa anterior pode ter criado.
 *
 * Falha da CONSULTA é relançada como `ASAAS_CONSULTA_INCERTA`: sem resposta,
 * não há como provar a ausência — e criar outra no escuro é exatamente o
 * defeito que isto existe para fechar.
 */
export async function procurarCobrancaJaCriada(input: {
  gateway: Pick<AsaasHttpClient, 'listPayments'>;
  originId: string;
  method: string;
  amountCents: number;
}): Promise<ResultadoDaProcura> {
  let resposta: Record<string, unknown>;
  try {
    resposta = await input.gateway.listPayments({
      externalReference: input.originId,
      limit: '100',
    });
  } catch {
    throw new ApiError(
      'ASAAS_CONSULTA_INCERTA',
      'Não foi possível conferir no provedor se a tentativa anterior criou a cobrança — '
        + 'nada foi gerado de novo. Tente outra vez em instantes.',
      502,
    );
  }

  const lista = Array.isArray(resposta?.data) ? (resposta.data as Record<string, unknown>[]) : [];
  const tipo = TIPO_DO_MEIO[input.method] ?? null;

  const candidatas = lista
    .filter((c) => c && c.deleted !== true)
    .map(lerCobranca)
    .filter(
      (c) =>
        c.id !== ''
        && c.externalReference === input.originId
        && STATUS_VIVOS.has(c.status)
        && (tipo === null || c.billingType === null || c.billingType === tipo)
        && c.valueCents === input.amountCents
        && !jaVinculada(c.id),
    )
    .sort((a, b) => String(a.dateCreated ?? '').localeCompare(String(b.dateCreated ?? '')));

  /*
    UM PLANO DE PARCELAS É UMA COBRANÇA SÓ (GAP-PRD-114). As parcelas de um
    mesmo plano podem ter o mesmo valor; contá-las como "órfãs a mais" mandaria
    cancelar a parcela 2 de uma compra legítima. Fica uma por plano.
  */
  const planosVistos = new Set<string>();
  const unicas = candidatas.filter((c) => {
    if (!c.installment) return true;
    if (planosVistos.has(c.installment)) return false;
    planosVistos.add(c.installment);
    return true;
  });

  return { adotar: unicas[0] ?? null, sobrando: unicas.slice(1) };
}

/**
 * A intenção sem `provider_ref` chegou a ir ao provedor?
 *
 * `attempts` conta as idas. Intenção que nunca foi (operação sem credencial)
 * não tem órfã possível; a que foi e voltou sem referência pode ter.
 */
export function tentouNoProvedor(intent: { attempts?: number | null }): boolean {
  return Number(intent.attempts ?? 0) > 0;
}

/**
 * Cancela no provedor a(s) cobrança(s) que uma criação incerta deixou lá.
 *
 * Quem cancela o título ou o pedido está dizendo "o cliente não deve pagar
 * isto". Marcar cancelada só aqui dentro, com a órfã viva lá fora, deixaria o
 * boleto pagável — e o pagamento cairia num título que ninguém persegue mais.
 *
 * Devolve o id da primeira cancelada (para a intenção guardar a referência),
 * ou nulo quando lá não havia nada. Falha da consulta ou do cancelamento é
 * relançada: quem chama decide se isso trava ou só se registra.
 */
export async function cancelarCobrancasOrfas(input: {
  gateway: Pick<AsaasHttpClient, 'listPayments' | 'cancelPayment'>
    & Partial<Pick<AsaasHttpClient, 'cancelInstallment'>>;
  originId: string;
  method: string;
  amountCents: number;
}): Promise<string | null> {
  const achado = await procurarCobrancaJaCriada(input);
  const orfas = [achado.adotar, ...achado.sobrando].filter(
    (c): c is CobrancaNoProvedor => c !== null && !STATUS_PAGOS_NO_PROVEDOR.has(c.status),
  );
  if (achado.adotar && STATUS_PAGOS_NO_PROVEDOR.has(achado.adotar.status)) {
    // Já PAGA: cancelar apagaria o rastro do dinheiro que entrou. O caminho é
    // o estorno, com contrapartida — e isso é decisão de quem controla o caixa.
    throw new ApiError(
      'ASAAS_ORFA_JA_PAGA',
      `A cobrança ${achado.adotar.id} já foi paga no provedor: não se cancela, estorna-se.`,
      409,
    );
  }
  for (const orfa of orfas) {
    // Órfã parcelada: derruba o PLANO, senão as parcelas 2..N ficam pagáveis.
    if (orfa.installment && input.gateway.cancelInstallment) await input.gateway.cancelInstallment(orfa.installment);
    else await input.gateway.cancelPayment(orfa.id);
  }
  return orfas[0]?.id ?? null;
}

/** Frase para as órfãs a mais, que o sistema não adota e ninguém pode esquecer. */
export function avisoDasSobrando(sobrando: CobrancaNoProvedor[]): string | null {
  if (sobrando.length === 0) return null;
  return (
    `Há mais ${sobrando.length} cobrança(s) desta origem no provedor sem vínculo no ERP `
    + `(${sobrando.map((c) => c.id).join(', ')}). Cancele-a(s) no painel do Asaas para o `
    + 'cliente não pagar em dobro.'
  );
}
