/**
 * O AGENTE QUE SÓ IMPRIME (GAP-PRD-082).
 *
 * Caixa com impressora térmica e sem PinPad integrado: o agente é pareado com
 * `--sem-tef` e roda só a fila de impressão. Esta ponte ocupa o lugar do
 * cliente TEF e diz a verdade — não há gerenciador —; se alguma cobrança
 * chegar a este agente, ela volta recusada, sem nada cobrado.
 */
import type { PonteTef, ResultadoDaPonte, SaudeDaPonte } from './PonteTef.js';

export class PonteSemTef implements PonteTef {
  readonly nome = 'sem-tef';

  async saude(): Promise<SaudeDaPonte> {
    return {
      tefClient: 'unavailable',
      pinpad: null,
      bridge: 'nenhuma',
      message: 'Este agente só imprime: nenhum gerenciador TEF configurado.',
    };
  }

  private recusa(): ResultadoDaPonte {
    return {
      status: 'failed',
      message: 'Este agente foi pareado sem gerenciador TEF (--sem-tef): nada foi cobrado nem cancelado.',
    };
  }

  // Os pedidos são ignorados de propósito: sem gerenciador, a resposta é a mesma.
  async cobrar(): Promise<ResultadoDaPonte> {
    return this.recusa();
  }

  async cancelar(): Promise<ResultadoDaPonte> {
    return this.recusa();
  }

  async consultar(): Promise<ResultadoDaPonte> {
    return this.recusa();
  }

  async confirmar(): Promise<void> {
    // Sem transação no gerenciador, nada a confirmar.
  }

  async desfazer(): Promise<void> {
    // Sem transação no gerenciador, nada a desfazer.
  }
}
