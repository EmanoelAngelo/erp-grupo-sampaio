/**
 * QUANTO UMA DEVOLUÇÃO DEVOLVE — a mesma conta do servidor, para a tela mostrar
 * "A devolver" antes do clique (GAP-PRD-009, GAP-PRD-050).
 *
 * O servidor é quem decide (`SaleReturnService.valorDaParcelaDevolvida`); isto
 * é o espelho dele, e mudar lá é mudar aqui. A tela fazia
 * `round(total × qtd / vendida)` sobre o total BRUTO do desconto do rodapé e
 * sem olhar o que já tinha voltado — anunciava R$ 200,00 numa venda que
 * recebeu R$ 180,00.
 *
 *   - o valor de partida é o LÍQUIDO da linha (`net_total_cents`): o desconto
 *     do rodapé já rateado pelo servidor;
 *   - a conta é sobre o acumulado: quanto deveria ter voltado desta linha
 *     depois desta devolução, menos o que já voltou (`returned_cents`); a que
 *     esgota a linha devolve exatamente o que resta.
 *
 * Resposta antiga do servidor (sem os dois campos) cai no total da linha e em
 * "nada voltou ainda" — o mesmo número de antes, nunca um NaN na tela.
 */
export interface LinhaDevolvivel {
  quantity: number;
  total_cents: number;
  returned_quantity: number;
  net_total_cents?: number;
  returned_cents?: number;
}

export function valorDaDevolucaoDaLinha(item: LinhaDevolvivel, quantidade: number): number {
  if (!(quantidade > 0) || !(item.quantity > 0)) return 0;
  const liquido = typeof item.net_total_cents === 'number' ? item.net_total_cents : item.total_cents;
  const jaVoltou = typeof item.returned_cents === 'number' ? item.returned_cents : 0;
  const acumulada = item.returned_quantity + quantidade;
  const alvo =
    acumulada >= item.quantity - 1e-9 ? liquido : Math.round((liquido * acumulada) / item.quantity);
  return Math.max(0, Math.min(alvo, liquido) - jaVoltou);
}

/** A linha tem desconto do rodapé rateado — a tela explica por que o valor é menor. */
export function temDescontoDoRodape(item: LinhaDevolvivel): boolean {
  return typeof item.net_total_cents === 'number' && item.net_total_cents < item.total_cents;
}
