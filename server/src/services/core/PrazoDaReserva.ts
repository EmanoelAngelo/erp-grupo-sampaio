/**
 * ATÉ QUANDO O PEDIDO SEGURA O ESTOQUE — por meio de pagamento (GAP-PRD-029).
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * A reserva do pedido online morria 25 horas depois do checkout, qualquer que
 * fosse o meio de pagamento. O relógio foi calibrado para o PIX (a cobrança
 * vence em D+1 e morre junto no provedor quando o pedido expira), e o boleto
 * herdou o mesmo relógio. Só que boleto pago no vencimento é COMPENSADO pelo
 * banco em D+1 útil — e o provedor só avisa depois disso. A rotina cancelava
 * o pedido do boleto que o cliente ainda podia pagar ("Válido até amanhã"),
 * soltava o estoque e pedia ao provedor para baixar o boleto. Quando o
 * pagamento feito antes da baixa chegava, virava `paid_after_cancel`:
 * dinheiro recebido sem mercadoria reservada e regularização manual.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * - PIX e cartão: 25 horas (as 24h da cobrança + 1h para o aviso atrasado).
 *   Segurar mais seria vitrine esgotada por pedido que ninguém vai pagar, e o
 *   cancelamento no provedor mata o QR e a página do cartão junto.
 * - Boleto EMITIDO no provedor e ainda não resolvido: a reserva vai até o fim
 *   do dia da loja do SEGUNDO dia útil depois do último dia em que o boleto
 *   pode ser pago. O último dia é o vencimento, ou o próximo dia útil quando o
 *   vencimento cai em fim de semana ou feriado (é a regra dos bancos).
 * - Cobrança sem vencimento guardado (anterior a esta regra): o vencimento é o
 *   D+1 da criação, que é o que o código sempre mandou ao provedor.
 * - O pedido nunca expira ANTES das 25 horas — o prazo do boleto só alonga.
 *
 * Esta é a ÚNICA definição do prazo. A rotina de expiração a usa para decidir
 * e a cobrança a devolve para a tela dizer ao cliente até quando os itens são
 * dele — as duas não podem discordar.
 */
import { getConnection } from '../../db/sqlite.js';
import { diaDaLoja, fimDoDia, somarDias } from './CalendarioOperacional.js';
import { proximoDiaUtil, somarDiasUteis } from './DiasUteis.js';

/** 24h da cobrança PIX + 1h de folga para o aviso atrasado do provedor. */
export const PRAZO_CURTO_MS = 25 * 60 * 60 * 1000;

/** Dias úteis que o banco leva para confirmar o boleto pago no último dia. */
export const DIAS_UTEIS_DE_COMPENSACAO = 2;

/** Uma cobrança que ainda pode ser paga (emitida no provedor e pendente). */
export interface CobrancaViva {
  method: string;
  /** Vencimento enviado ao provedor, AAAA-MM-DD; nulo nas linhas antigas. */
  dueDate: string | null;
  createdAt: string;
}

export interface PrazoDaReserva {
  /** Instante UTC (ISO) até o qual a reserva vale. */
  ate: string;
  /** Qual regra deu o prazo — para a tela e para o log. */
  regra: 'curta' | 'boleto';
  /** Boleto: o último dia em que o banco aceita o pagamento (AAAA-MM-DD). */
  pagavelAte: string | null;
}

const DATA = /^\d{4}-\d{2}-\d{2}/;

/** O prazo, calculado só com os fatos — sem banco, para o teste provar a regra. */
export function prazoDaReserva(input: {
  pedidoCriadoEm: string;
  cobrancas: CobrancaViva[];
}): PrazoDaReserva {
  const curta = new Date(new Date(input.pedidoCriadoEm).getTime() + PRAZO_CURTO_MS).toISOString();
  let prazo: PrazoDaReserva = { ate: curta, regra: 'curta', pagavelAte: null };

  for (const cobranca of input.cobrancas) {
    if (cobranca.method !== 'boleto') continue;
    const vencimento =
      cobranca.dueDate && DATA.test(cobranca.dueDate)
        ? cobranca.dueDate.slice(0, 10)
        : somarDias(diaDaLoja(cobranca.createdAt), 1);
    const pagavelAte = proximoDiaUtil(vencimento);
    const ate = fimDoDia(somarDiasUteis(pagavelAte, DIAS_UTEIS_DE_COMPENSACAO));
    // Textos ISO no mesmo formato comparam como instantes.
    if (ate > prazo.ate) prazo = { ate, regra: 'boleto', pagavelAte };
  }
  return prazo;
}

/**
 * As cobranças do pedido que o cliente ainda consegue pagar.
 *
 * `overdue` entra de propósito: é o boleto cujo vencimento passou e que o
 * provedor ainda não viu compensar — exatamente a janela que este arquivo
 * existe para proteger. Sem `provider_ref` não houve boleto emitido (loja sem
 * credencial, ou falha na criação), e não há o que esperar.
 */
export function cobrancasVivasDoPedido(companyId: string, orderId: string): CobrancaViva[] {
  const linhas = getConnection()
    .prepare(
      `SELECT method, due_date, created_at FROM core_payment_intents
        WHERE company_id = ? AND origin_type = 'ecommerce_order' AND origin_id = ?
          AND provider_ref IS NOT NULL AND status IN ('pending', 'overdue')`,
    )
    .all(companyId, orderId) as unknown as {
    method: string;
    due_date: string | null;
    created_at: string;
  }[];
  return linhas.map((l) => ({ method: l.method, dueDate: l.due_date, createdAt: l.created_at }));
}

/** O prazo da reserva deste pedido, lido do banco. */
export function prazoDaReservaDoPedido(companyId: string, orderId: string): PrazoDaReserva {
  const pedido = getConnection()
    .prepare('SELECT created_at FROM core_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as { created_at: string } | undefined;
  const criadoEm = pedido?.created_at ?? new Date().toISOString();
  return prazoDaReserva({
    pedidoCriadoEm: criadoEm,
    cobrancas: cobrancasVivasDoPedido(companyId, orderId),
  });
}
