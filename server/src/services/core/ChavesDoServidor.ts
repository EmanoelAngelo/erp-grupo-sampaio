/**
 * ============================================================================
 * AS CHAVES QUE O SERVIDOR DERIVA PARA `core_sales` — num lugar só (R2-IDEM)
 * ============================================================================
 *
 * `core_sales.idempotency_key` é UM espaço de nomes com duas fontes:
 *
 *   - a chave CRUA do cliente: `POST /sales` e a venda guardada offline (que
 *     sobe, e é relançada, com a chave com que foi feita);
 *   - as chaves que o SERVIDOR monta nos caminhos que partem de um documento,
 *     com o documento no nome, para que dois documentos nunca dividam uma venda
 *     (ver o cabeçalho de `createSale`).
 *
 * O prefixo só separa os documentos entre si se o cliente não puder escrever a
 * mesma forma. Não podia ser impedido antes: o balcão que vendia com a chave
 * "venda-nova:<pendência>" (outra mercadoria) ocupava a venda nova daquela
 * pendência, e o relançamento dela virava 422 para sempre; "os-<ordem>" (a
 * chave do recebimento sem cabeçalho, determinística) prendia a OS do mesmo
 * jeito, e "quote:<id>:<chave>" a conversão da pré-venda.
 *
 * Por isso a DERIVAÇÃO e a RESERVA moram aqui, juntas: quem monta uma chave
 * nova para `createSale` a partir de um documento acrescenta a forma dela a
 * `PREFIXOS_DO_SERVIDOR`, e as rotas de chave crua passam a recusá-la sem
 * ninguém lembrar de mais nada. Os outros espaços de chave (cobranças,
 * pedidos da loja, movimentos de estoque, fila fiscal) não recebem chave crua
 * do cliente no mesmo espaço de uma derivada — ver o teste
 * `chave-derivada-pelo-servidor`.
 */
import { ApiError } from '../../utils/errors.js';

/** As formas de chave de `core_sales` que só o servidor escreve. */
export const PREFIXOS_DO_SERVIDOR = ['quote:', 'consignacao:', 'venda-nova:', 'os:', 'os-'] as const;

/** Conversão de orçamento/pré-venda: o documento na frente da chave do pedido. */
export function chaveDaConversaoDoDocumento(quoteId: string, chaveDoPedido: string): string {
  return `quote:${quoteId}:${chaveDoPedido}`;
}

/** Faturamento da consignação: o documento na frente da chave do pedido. */
export function chaveDoFaturamentoDaConsignacao(consignmentId: string, chaveDoPedido: string): string {
  return `consignacao:${consignmentId}:${chaveDoPedido}`;
}

/** A venda nova de uma venda guardada offline: da pendência, e sempre a mesma. */
export function chaveDaVendaNovaDaPendenciaOffline(pendenciaId: string): string {
  return `venda-nova:${pendenciaId}`;
}

/**
 * O recebimento da OS: com o cabeçalho do pedido, o documento na frente dele;
 * sem cabeçalho, uma por OS — e uma por estorno, para o recebimento depois do
 * estorno não achar a venda estornada.
 */
export function chaveDoRecebimentoDaOs(orderId: string, cabecalho: string | null, estornos: number): string {
  if (cabecalho) return `os:${orderId}:${cabecalho}`;
  return estornos > 0 ? `os-${orderId}:${estornos}` : `os-${orderId}`;
}

/** Esta chave tem uma forma que só o servidor escreve? Comparação exata, como a do banco. */
export function ehChaveDoServidor(chave: string): boolean {
  return PREFIXOS_DO_SERVIDOR.some((prefixo) => chave.startsWith(prefixo));
}

/**
 * A recusa, para as rotas que recebem a chave do cliente e a gravam crua em
 * `core_sales`. Antes de qualquer escrita; 400 porque o pedido é inválido pela
 * forma, e não por conflito com algo que exista.
 */
export function recusarChaveDoServidor(chave: string): void {
  const prefixo = PREFIXOS_DO_SERVIDOR.find((p) => chave.startsWith(p));
  if (!prefixo) return;
  throw new ApiError(
    'CORE_IDEMPOTENCY_KEY_RESERVED',
    `A identificação desta venda começa com "${prefixo}", que o sistema reserva para as vendas que nascem de `
      + 'um documento (pré-venda, consignação, OS, venda guardada relançada). Nada foi registrado: envie a venda '
      + 'com outra identificação.',
    400,
    { prefixo },
  );
}
