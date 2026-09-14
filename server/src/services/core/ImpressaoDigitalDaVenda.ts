/**
 * ============================================================================
 * A IMPRESSÃO DIGITAL DE UM PEDIDO DE VENDA (item IDEM, RES-IDEM-VIZ)
 * ============================================================================
 *
 * ## O defeito
 *
 * A trava de idempotência da venda buscava só por (empresa, chave). O E2E de
 * API (verificação E.5) mandou a MESMA Idempotency-Key com o corpo DIFERENTE —
 * quantidade 3 em vez de 2 — e recebeu 200 com a venda ORIGINAL, calado: o
 * caixa acha que registrou a venda nova, e ela não existe. O rascunho IETF "The
 * Idempotency-Key HTTP Header Field" manda recusar a reutilização da chave com
 * carga diferente (422).
 *
 * ## O que entra, e por quê
 *
 * O que se vende e o dinheiro que paga por isso:
 *
 *   - itens: produto, quantidade e as unidades escolhidas (o chassi da moto);
 *   - peças já baixadas da OS (`linhasJaBaixadas`): produto e quantidade;
 *   - serviço itemizado (`serviceLines`): descrição e quantidade;
 *   - o valor do serviço (`serviceTotalCents`) — na venda só de serviço não
 *     há outra coisa que diga o que foi vendido;
 *   - desconto, acréscimo e crédito de loja do CABEÇALHO (RES-IDEM-VIZ);
 *   - os pagamentos: forma e valor de cada linha, sem ordem (RES-IDEM-VIZ).
 *
 * O dinheiro entrou depois que o verificador do IDEM perguntou: a mesma chave
 * com a mesma mercadoria e OUTRO pagamento devolvia a venda original com 200 —
 * o caixa que refez em cartão o que tinha lançado em dinheiro via "venda
 * finalizada", e a gaveta esperava um dinheiro que nunca entrou nela. Nenhum
 * fluxo legítimo reenvia a mesma chave com outro dinheiro (a busca está no
 * commit, por arquivo e linha): o relançamento da venda offline usa o CORPO
 * GUARDADO; o PIX do balcão e a maquininha reenviam a MESMA linha, e o que o
 * servidor reescreve nela (status, provedor, referência) não entra aqui; a
 * conversão da pré-venda é recusada inteira quando o documento já virou venda;
 * o recebimento da OS e o faturamento da consignação descem com o documento no
 * nome da chave, e o corpo deles é o mesmo no reenvio.
 *
 * NÃO entram gaveta, caixa (terminal), cliente, vendedor, observação, preço e
 * desconto de LINHA, nem o status/provedor/referência do pagamento. O
 * relançamento da venda offline reusa a MESMA chave com o CORPO ORIGINAL numa
 * gaveta que não é a do turno em que a venda foi feita. O preço de linha fica
 * fora pelo motivo que o comentário da trava sempre deu — a mesma cesta
 * reenviada com o preço reajustado no meio do caminho é o mesmo pedido.
 *
 * ## Sem ordem
 *
 * Cada linha vira um texto canônico e cada lista é ORDENADA antes do hash: os
 * mesmos itens (ou pagamentos) em outra ordem são o mesmo pedido. A ordenação
 * é por código de caractere, e não por `localeCompare`: a impressão fica
 * gravada no banco, e uma troca de biblioteca de idioma numa atualização do
 * Node não pode fazer o reenvio legítimo de ontem parecer outra venda hoje.
 *
 * ## Por que NÃO se reconstrói o pedido a partir de `core_sale_items`
 *
 * Kit desmembrado, linha de serviço e peça já baixada são gravados de jeitos
 * diferentes do que chegam; comparar o reenvio com a venda gravada recusaria
 * reenvio legítimo. A impressão é do PEDIDO, tirada na criação.
 *
 * ## A versão na frente
 *
 * O valor gravado é `v1:<sha-256>`. A receita v1 ganhou o dinheiro ANTES de a
 * coluna ir para produção (ela nasceu no d622b6d e ainda não saiu da
 * remediação), então não há impressão gravada com a receita anterior. Se a
 * receita mudar um dia, a versão muda junto, e impressão de receita antiga é
 * tratada como a venda sem impressão: sem como comparar, o reenvio segue a
 * regra de antes (devolve a venda) em vez de recusar um reenvio legítimo por
 * uma diferença que é da receita.
 */
import { createHash } from 'node:crypto';

/** A receita desta impressão. Mudou o que entra, muda a versão. */
export const VERSAO_DA_IMPRESSAO_DIGITAL = 'v1';

/** O pedido de venda como chega — forma solta, para ler corpo cru. */
export interface MercadoriaDoPedido {
  items?: ReadonlyArray<{ productId?: unknown; quantity?: unknown; unitIds?: unknown }> | null;
  linhasJaBaixadas?: ReadonlyArray<{ productId?: unknown; quantity?: unknown }> | null;
  serviceLines?: ReadonlyArray<{ description?: unknown; quantity?: unknown }> | null;
  serviceTotalCents?: unknown;
  discountCents?: unknown;
  surchargeCents?: unknown;
  customerCreditCents?: unknown;
  payments?: ReadonlyArray<{ method?: unknown; amountCents?: unknown }> | null;
}

function lista<T>(v: ReadonlyArray<T> | null | undefined): ReadonlyArray<T> {
  return Array.isArray(v) ? v : [];
}

/** "2" e 2 são a mesma quantidade; o que não é número fica como texto. */
function quantidade(v: unknown): number | string {
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

/** Centavos como `createSale` os lê: ausente é zero, e arredonda. */
function centavos(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Ordem por código de caractere — estável entre versões do Node. */
function porCodigo(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * `v1:<sha-256>` do JSON canônico do pedido de venda.
 *
 * Normaliza como `createSale` normaliza: sem itens é lista vazia, o valor do
 * serviço é arredondado e nunca negativo, e desconto, acréscimo e crédito
 * ausentes são zero.
 */
export function impressaoDigitalDaMercadoria(pedido: MercadoriaDoPedido): string {
  const itens = lista(pedido.items).map((i) =>
    JSON.stringify([
      String(i?.productId ?? ''),
      quantidade(i?.quantity),
      Array.isArray(i?.unitIds) ? (i.unitIds as unknown[]).map(String).sort(porCodigo) : [],
    ]),
  );
  const jaBaixadas = lista(pedido.linhasJaBaixadas).map((l) =>
    JSON.stringify([String(l?.productId ?? ''), quantidade(l?.quantity)]),
  );
  const servico = lista(pedido.serviceLines).map((l) =>
    JSON.stringify([String(l?.description ?? '').trim(), quantidade(l?.quantity)]),
  );
  const totalDoServico = Math.max(0, Math.round(Number(pedido.serviceTotalCents ?? 0)) || 0);
  const pagamentos = lista(pedido.payments).map((p) =>
    JSON.stringify([String(p?.method ?? ''), centavos(p?.amountCents)]),
  );

  const canonico = JSON.stringify({
    itens: itens.sort(porCodigo),
    jaBaixadas: jaBaixadas.sort(porCodigo),
    servico: servico.sort(porCodigo),
    totalDoServico,
    desconto: centavos(pedido.discountCents),
    acrescimo: centavos(pedido.surchargeCents),
    credito: centavos(pedido.customerCreditCents),
    pagamentos: pagamentos.sort(porCodigo),
  });
  return `${VERSAO_DA_IMPRESSAO_DIGITAL}:${createHash('sha256').update(canonico).digest('hex')}`;
}

/**
 * A chave foi reusada com OUTRO pedido?
 *
 * Só responde sim quando dá para comparar: a impressão gravada existe e é da
 * mesma receita. Venda anterior à coluna (nula) ou de receita antiga responde
 * não — o reenvio segue a regra de sempre.
 */
export function outraMercadoria(gravada: string | null | undefined, agora: string): boolean {
  if (!gravada) return false;
  if (!gravada.startsWith(`${VERSAO_DA_IMPRESSAO_DIGITAL}:`)) return false;
  return gravada !== agora;
}
