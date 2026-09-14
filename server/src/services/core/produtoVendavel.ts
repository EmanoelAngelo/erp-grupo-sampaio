/**
 * O PRODUTO INATIVO (ARQUIVADO) FORA DE TODA PORTA DE USO — e a variante junto.
 *
 * `active = 0` é o arquivamento do produto: é a saída quando ele tem histórico
 * e por isso não pode ser excluído (`ProductDeletionService`). O PDV, o
 * orçamento, a consignação e a vitrine já recusavam o inativo; a locação, a
 * peça lançada na OS e o destaque da loja não olhavam.
 *
 * E a VARIANTE herda o modelo. Cada tamanho é uma linha própria de
 * `core_products` com `active` próprio, e inativar o MODELO pelo cadastro não
 * toca nas linhas dos tamanhos: sem esta condição, o tamanho de um modelo
 * arquivado continuava achado na busca do balcão, fechava venda e passava no
 * checkout online.
 *
 * Um módulo sem dependência de propósito: catálogo, venda, vitrine, locação e
 * oficina importam daqui sem que um serviço passe a depender do outro.
 */
import { ApiError } from '../../utils/errors.js';

/**
 * A condição "o modelo desta linha, se ela for variante, está ativo", em SQL,
 * sobre o apelido de `core_products` que a consulta usa.
 *
 * Linha sem `parent_id` (produto simples ou o próprio modelo) passa: a regra é
 * só da variante. O apelido interno é longo de propósito, para não colidir com
 * nenhum apelido da consulta que a embute.
 */
export function modeloAtivo(apelido: string): string {
  return `(${apelido}.parent_id IS NULL OR EXISTS (
            SELECT 1 FROM core_products modelo_da_variante
             WHERE modelo_da_variante.id = ${apelido}.parent_id
               AND modelo_da_variante.active = 1))`;
}

/**
 * A recusa de uso de produto inativo, com o nome dele e o gesto recusado.
 *
 * 409 e não 404: o produto existe — é consultável por id e continua no
 * histórico —, só não pode mais ENTRAR em documento novo. A frase não aponta
 * uma tela: quem lê pode ser o mecânico, e o cadastro é ambiente de gestão.
 */
export function recusaDeProdutoInativo(nome: string, gesto: string, productId: string): ApiError {
  return new ApiError(
    'CORE_PRODUCT_INACTIVE',
    `"${nome}" está inativo (arquivado) e não pode ${gesto}. Quem reativa é o cadastro do produto.`,
    409,
    { productId },
  );
}
