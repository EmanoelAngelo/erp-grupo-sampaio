/**
 * O vínculo do item da nota com o catálogo — o cliente da rota que não tinha
 * chamador (GAP-PRD-015).
 *
 * `POST /core/purchases/notes/:id/link` existia no servidor desde a primeira
 * entrada por XML, e nenhuma tela a chamava: o item que o casamento automático
 * não reconhecia virava produto novo com preço zero. Este módulo é a porta que
 * a conferência usa para ligar o item ao produto que JÁ existe — e para desfazer
 * o casamento automático que errou.
 *
 * Módulo próprio, e não mais uma entrada em `coreApi`, pela regra da casa: o
 * domínio novo nasce em arquivo novo e `core.ts` só é tocado no indispensável.
 */
import { apiRequest, envelope } from './client';
import type { InboundNoteItem } from './core';

/**
 * O item como a conferência o lê depois do vínculo: além do casamento, COM
 * QUAL produto ele casou — o id sozinho não diz nada a quem está na doca.
 * Opcionais porque servidor anterior a esta rodada não os devolve.
 */
export interface ItemDaNotaVinculado extends InboundNoteItem {
  productName?: string | null;
  productInternalCode?: string | null;
  productUnit?: string | null;
}

export const entradaNotasApi = {
  /**
   * Liga o item (pela POSIÇÃO no arquivo) a um produto do catálogo.
   *
   * `lembrar` (padrão: sim) grava o de-para do fornecedor: a próxima nota dele
   * com o mesmo código casa sozinha. Desligue para o item avulso — o brinde, a
   * promoção de uma vez só — que não deve ensinar nada às próximas notas.
   */
  linkInboundNoteItem: (
    noteId: string,
    input: { itemIndex: number; productId: string; lembrar?: boolean },
  ) =>
    apiRequest<{ items: ItemDaNotaVinculado[] }>(`/core/purchases/notes/${noteId}/link`, {
      method: 'POST',
      body: {
        itemIndex: input.itemIndex,
        productId: input.productId,
        lembrar: input.lembrar !== false,
      },
    }).then(envelope('items')),

  /**
   * Desfaz o vínculo: o item volta para "sem produto" e o de-para que apontava
   * para aquele produto é esquecido. Só em nota em conferência — depois da
   * entrada, o servidor recusa (e a frase dele diz o caminho: estorno).
   */
  unlinkInboundNoteItem: (noteId: string, itemIndex: number) =>
    apiRequest<{ items: ItemDaNotaVinculado[] }>(`/core/purchases/notes/${noteId}/link`, {
      method: 'POST',
      body: { itemIndex, productId: null },
    }).then(envelope('items')),
};
