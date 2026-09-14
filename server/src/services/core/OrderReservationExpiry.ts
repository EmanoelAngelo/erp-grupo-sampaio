/**
 * Expiração da reserva de estoque de pedidos não pagos.
 *
 * O checkout reserva o item na hora: "fica indisponível para outro comprador
 * enquanto o pagamento não resolve". Até a rodada 34, NADA resolvia a reserva
 * quando o pagamento simplesmente não vinha. Medido: um visitante sem conta
 * fechava pedidos do estoque inteiro, não pagava, e a vitrine ficava
 * "esgotada" para quem pagaria — até alguém achar e cancelar um a um.
 *
 * O PRAZO DEPENDE DO MEIO DE PAGAMENTO (GAP-PRD-029). PIX e cartão vencem em
 * 24 horas no provedor, e a reserva segue esse relógio com uma hora de folga.
 * O boleto, não: pago no vencimento, ele é compensado pelo banco em D+1 útil,
 * e cancelar antes disso transformava o pagamento do cliente em
 * `paid_after_cancel`. Quem sabe o prazo de cada pedido é `PrazoDaReserva` —
 * a mesma conta que a tela usa para dizer ao cliente até quando os itens são
 * dele. Aqui só se pergunta "já passou?".
 *
 * ESTE MÓDULO NÃO SABE SOLTAR RESERVA. Quem sabe é `cancelOrder`, que já
 * existia, já devolve o saldo pela mesma porta (`releaseReservation`), já
 * recusa pedido pago e já é idempotente. Reescrever isso aqui seria um
 * segundo escritor de estoque — exatamente o que este projeto não tem.
 *
 * `agora` vem de fora para que a rotina agendada e o teste provem a MESMA
 * função, sem o teste ter de esperar um dia.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { logError, logInfo } from '../../utils/errors.js';
import { cancelOrder } from './StorefrontService.js';
import { cancelOrderCharges } from './OrderChargeService.js';
import { PRAZO_CURTO_MS, prazoDaReservaDoPedido } from './PrazoDaReserva.js';

/**
 * O relógio curto (PIX e cartão): 24h da cobrança + 1h de folga para o
 * webhook atrasado chegar. É também o PISO de qualquer reserva — nenhum pedido
 * expira antes disso, e por isso a busca abaixo pode filtrar por ele.
 */
export const PRAZO_DA_RESERVA_MS = PRAZO_CURTO_MS;

/** De quanto em quanto tempo a rotina olha. */
const INTERVALO_MS = 15 * 60 * 1000;

export interface ResultadoDaExpiracao {
  cancelados: number;
  falhas: number;
  /**
   * Pedidos que passaram das 25 horas mas têm boleto que o banco ainda pode
   * confirmar — deixados em paz nesta volta (GAP-PRD-029).
   */
  emCompensacao: number;
}

/**
 * Cancela, um a um, os pedidos em `aguardando_pagamento` cujo prazo de
 * reserva passou. Um a um de propósito: se um falhar (e `cancelOrder` tem
 * motivos legítimos para recusar), os outros não ficam presos com ele.
 *
 * ## A COBRANÇA MORRE JUNTO COM A RESERVA (GAP-V72)
 *
 * Este era um dos DOIS caminhos que cancelavam pedido sem tocar no provedor —
 * `cancelOrderCharges` existia e só o portal do cliente a chamava. Quer dizer:
 * o pedido expirava aqui, o estoque voltava à vitrine, e o PIX continuava VIVO
 * no Asaas. O comprador que voltasse ao aplicativo do banco no dia seguinte
 * pagava um pedido que não existe mais. O dinheiro não some (vira
 * `paid_after_cancel` e aparece na conciliação), mas gera uma regularização
 * manual que ninguém precisava ter.
 *
 * A ORDEM IMPORTA: cancela lá fora ANTES de soltar a reserva aqui, como já faz
 * o portal. E falha do provedor NÃO segura o cancelamento — `cancelOrderCharges`
 * é tolerante por construção e registra o erro na intenção. Manter estoque
 * preso por causa de uma API de fora seria trocar um problema pequeno por um
 * grande.
 *
 * A função virou `async` por causa disso, e é por isso que ela aceita
 * `fetchImpl`: o teste prova o caminho inteiro com um dublê, sem rede.
 */
export async function expirarPedidosNaoPagos(
  agora: Date,
  opcoes: { fetchImpl?: typeof fetch } = {},
): Promise<ResultadoDaExpiracao> {
  ensureCoreSchema();
  // Só é candidato quem já passou do piso: nenhum prazo é menor que ele.
  const limite = new Date(agora.getTime() - PRAZO_DA_RESERVA_MS).toISOString();
  const candidatos = getConnection()
    .prepare(
      `SELECT id, company_id, number FROM core_orders
        WHERE status = 'aguardando_pagamento' AND created_at < ?
        ORDER BY created_at`,
    )
    .all(limite) as unknown as { id: string; company_id: string; number: number }[];

  let cancelados = 0;
  let falhas = 0;
  let emCompensacao = 0;
  for (const pedido of candidatos) {
    try {
      const prazo = prazoDaReservaDoPedido(pedido.company_id, pedido.id);
      if (agora.getTime() <= new Date(prazo.ate).getTime()) {
        // Boleto que o banco ainda pode confirmar: a reserva continua dele.
        emCompensacao += 1;
        continue;
      }
      await cancelOrderCharges({
        companyId: pedido.company_id,
        orderId: pedido.id,
        fetchImpl: opcoes.fetchImpl,
      });
      cancelOrder({
        companyId: pedido.company_id,
        orderId: pedido.id,
        reason: 'Cancelado automaticamente: prazo de pagamento vencido. O estoque voltou à loja.',
        // O e-mail diz que venceu e como refazer (GAP-PRD-037).
        origem: 'prazo',
      });
      cancelados += 1;
    } catch (err) {
      falhas += 1;
      logError('reserva_expiracao_falhou', { orderId: pedido.id, number: pedido.number, err });
    }
  }
  if (cancelados > 0 || falhas > 0) {
    logInfo('reserva_expiracao', { cancelados, falhas, emCompensacao });
  }
  return { cancelados, falhas, emCompensacao };
}

// ------------------------------------------------------------- agendamento

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Liga a rotina. Roda uma vez ao subir — o servidor pode ter passado a noite
 * desligado — e depois a cada intervalo. `unref` para não segurar o processo
 * vivo no desligamento.
 */
export function startReservationExpiry(): void {
  if (timer) return;
  // O laço não espera o resultado — ele é um relógio, não um chamador. O
  // `catch` fica no `then` da promessa porque a rotina passou a ser async
  // (ela conversa com o provedor antes de soltar a reserva): um `try/catch`
  // síncrono aqui deixaria a rejeição escapar como unhandled e derrubar o
  // processo em vez de virar linha de log.
  const rodar = () => {
    void expirarPedidosNaoPagos(new Date()).catch((err) => {
      logError('reserva_expiracao_laco', { err });
    });
  };
  rodar();
  timer = setInterval(rodar, INTERVALO_MS);
  timer.unref();
}

export function stopReservationExpiry(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
