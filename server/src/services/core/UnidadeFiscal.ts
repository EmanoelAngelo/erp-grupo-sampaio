/**
 * ============================================================================
 * A UNIDADE FISCAL É A DA OPERAÇÃO — GAP-PRD-180
 * ============================================================================
 *
 * O certificado A1 e o CSC moram em `fiscal_certificate_references` e
 * `nfce_settings` com um campo `operationalUnitId`. Tudo que EMITE — a
 * prontidão, a lista do grupo, o pipeline, a montagem do QR, o cofre dos atos,
 * a NFC-e off-line — lê a mesma unidade: `unit-default`. Mas as rotas que
 * GRAVAM aceitavam qualquer valor no corpo (ou `?unit=`), e as legadas de
 * integração caíam no `storeId` do token. Resultado: 201 "configurado" para um
 * arquivo que nenhuma emissão enxergava.
 *
 * Não existe cadastro de unidades operacionais — "loja-2" não é nada que o
 * sistema saiba vender, numerar ou emitir. Honrar o parâmetro na cadeia
 * inteira exigiria esse cadastro e a ligação venda → unidade; até ele existir,
 * o contrato honesto é UM lugar, e pedir outro é recusado com o motivo em vez
 * de gravar onde ninguém lê.
 *
 * Esta é a régua única: toda rota que recebe `operationalUnitId` para o
 * certificado ou o CSC passa por aqui.
 */
import { ApiError } from '../../utils/errors.js';

/** O único lugar onde o certificado e o CSC de uma operação moram. */
export const UNIDADE_FISCAL = 'unit-default';

export type UnidadeFiscal = typeof UNIDADE_FISCAL;

/**
 * A unidade que o pedido pode usar.
 *
 * Ausente, vazia ou `unit-default` → a da operação. Qualquer outra → 400
 * `CORE_FISCAL_UNIT_NOT_SUPPORTED`, dizendo por quê. Recusar (em vez de
 * ignorar em silêncio) é deliberado: quem mandou "loja-2" achava que estava
 * guardando outro arquivo, e sobrescrever o da operação sem avisar trocaria o
 * certificado de quem emite.
 */
export function unidadeFiscalDoPedido(valor: unknown): UnidadeFiscal {
  const texto = valor == null ? '' : String(valor).trim();
  if (texto === '' || texto === UNIDADE_FISCAL) return UNIDADE_FISCAL;
  throw new ApiError(
    'CORE_FISCAL_UNIT_NOT_SUPPORTED',
    `A unidade "${texto.slice(0, 60)}" não existe para o fiscal: o certificado A1 e o CSC são `
      + 'da operação inteira, e o sistema ainda não tem cadastro de unidades operacionais. '
      + 'Envie sem "operationalUnitId" — o arquivo fica na operação, que é onde a emissão o procura.',
    400,
  );
}
