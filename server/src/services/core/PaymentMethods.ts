/**
 * As formas de recebimento — uma fonte de verdade, no servidor.
 *
 * ## O problema que isto resolve
 *
 * `method` era string livre: sem enum, sem validação na rota, sem CHECK no
 * banco. A única lista de meios de pagamento do projeto vivia no FRONTEND
 * (`PagamentoDialog.tsx`), e o servidor nunca a lia.
 *
 * Na prática isso significava que um método digitado errado — por uma
 * integração, por um teste, por um cliente de API futuro — entrava no banco em
 * silêncio. Depois ele não aparecia em nenhum relatório que agrupasse por
 * forma de pagamento, e o dinheiro parecia ter sumido. O erro nunca aparecia
 * no momento em que dava para consertar.
 *
 * ## Por que catálogo em código, e não tabela
 *
 * Cada método aqui tem COMPORTAMENTO amarrado no código: `dinheiro` mexe na
 * gaveta e admite troco, `debito` e `credito` passam pela maquininha, `pix`
 * depende de haver terminal. Uma tabela deixaria o lojista cadastrar
 * "Cheque" — e nenhuma linha de código saberia o que fazer com ele.
 *
 * O que É de cadastro, e virá em rodada própria, é a OPERADORA de cartão e o
 * prazo de recebimento: taxa, dias para cair, bandeira. Isso são dados. O
 * método é comportamento.
 */
import { ApiError } from '../../utils/errors.js';

export interface PaymentMethod {
  code: string;
  label: string;
  /** Atalho no balcão. Mantido igual ao que o caixa já decorou. */
  key: string;
  /** Entra na gaveta e admite troco. */
  cash: boolean;
  /**
   * Gera conta a receber em aberto em vez de dinheiro na hora.
   *
   * Nenhum método marcado assim está ativo: é o gancho declarado para quando
   * a venda a prazo entrar, e existe para o comportamento não precisar ser
   * inventado às pressas naquele dia.
   */
  deferred: boolean;
  /** Aparece no balcão. Um método desligado continua LEGÍVEL no histórico. */
  active: boolean;
}

/**
 * A ordem é a que o caixa usa, e os atalhos são os que ele já decorou —
 * trocar a numeração para "organizar" custaria mais que qualquer ganho.
 */
export const PAYMENT_METHODS: PaymentMethod[] = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
  { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
  /*
    CREDIÁRIO ESTÁ DESLIGADO, e isso é decisão declarada.

    O dono do sistema disse que não vende a prazo. Deixá-lo ligado seria pior
    que não tê-lo: ele já era aceito e tratado como DINHEIRO NA MÃO — a venda
    fechava, o financeiro nascia quitado e não havia parcela, cobrança nem
    carnê. Uma venda a prazo registrada assim some do contas a receber.

    A linha fica aqui, e não some do código, por dois motivos: o histórico
    pode ter vendas antigas com este método e elas precisam continuar
    legíveis; e o dia em que o crediário entrar, o gancho `deferred` já diz o
    que ele tem de fazer.
  */
  { code: 'crediario', label: 'Crediário', key: '5', cash: false, deferred: true, active: false },
];

const PORCODIGO = new Map(PAYMENT_METHODS.map((m) => [m.code, m]));

export function findPaymentMethod(code: string): PaymentMethod | undefined {
  return PORCODIGO.get(String(code ?? '').trim().toLowerCase());
}

/** Os que o balcão pode oferecer agora. */
export function activePaymentMethods(): PaymentMethod[] {
  return PAYMENT_METHODS.filter((m) => m.active);
}

export function isCashMethod(code: string): boolean {
  return findPaymentMethod(code)?.cash === true;
}

/**
 * Recusa forma de pagamento que o sistema não sabe processar.
 *
 * A checagem é na ENTRADA, porque é o único momento em que dá para corrigir.
 * Um método desconhecido gravado no banco vira relatório com buraco, e aí
 * ninguém sabe mais qual venda foi.
 *
 * Método existente mas DESLIGADO recebe mensagem própria: quem tenta usar
 * crediário precisa saber que ele foi desligado, e não que digitou errado.
 */
export function assertPaymentMethod(code: string): PaymentMethod {
  const metodo = findPaymentMethod(code);
  if (!metodo) {
    throw new ApiError(
      'CORE_PAYMENT_METHOD_UNKNOWN',
      `Forma de pagamento desconhecida: "${code}". Aceitas: ${activePaymentMethods()
        .map((m) => m.label)
        .join(', ')}.`,
      400,
      { method: code, accepted: activePaymentMethods().map((m) => m.code) },
    );
  }
  if (!metodo.active) {
    throw new ApiError(
      'CORE_PAYMENT_METHOD_DISABLED',
      `${metodo.label} está desligado nesta instalação e não pode ser usado em venda nova.`,
      400,
      { method: metodo.code },
    );
  }
  return metodo;
}
