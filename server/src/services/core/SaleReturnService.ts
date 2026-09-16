/**
 * Devolução de venda.
 *
 * DEVOLVER NÃO É CANCELAR, e a diferença decide tudo o que este arquivo faz.
 *
 *   CANCELAR   a venda passa a não valer. É o mesmo dia, antes de o dinheiro
 *              assentar: erro de digitação, cliente desistiu no balcão. O
 *              `SalesService.cancelSale` já faz isso, e desfaz tudo.
 *
 *   DEVOLVER   a venda ACONTECEU e continua tendo acontecido. O cliente levou,
 *              usou, e voltou dias depois com parte da mercadoria. A venda está
 *              no fechamento do mês, na comissão que já foi paga e, quando
 *              houver, na nota fiscal emitida. Reescrevê-la faria o passado
 *              mudar de forma — o relatório de ontem passaria a dizer outra
 *              coisa hoje.
 *
 * Por isso a devolução é registro NOVO apontando para a venda, e a venda não é
 * tocada em nenhum momento. O que se conta como faturamento continua sendo a
 * venda; a devolução aparece ao lado, diminuindo o resultado, sem apagar nada.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement } from './InventoryService.js';
import {
  isSerialized,
  markUnitsWrittenOff,
  unitsByExitReference,
} from './ProductUnitService.js';
import { baixarPelaUnidade, devolverPelaUnidade } from './EquipmentStockLink.js';
import { systemCategoryId } from './FinanceSetupService.js';
import { estornarComissaoDaDevolucao } from './CommissionService.js';
import { diaDaLoja } from './CalendarioOperacional.js';
import { reversePoints } from './LoyaltyService.js';
import { grantCredit } from './CustomerCreditService.js';
import { inserirBaixaEspelho } from './FinanceService.js';
import { gavetaDoDinheiro } from './GavetaDoDinheiro.js';
import { emReais } from './Money.js';
import { marcarCobrancasAEstornar } from './EstornoNaMaquininha.js';
import { listKitComponents, produtoControlaEstoque } from './CatalogAuxService.js';
import { fluxoDaDevolucao } from './SalePolicyService.js';
import { fiscalStatusForSale } from './FiscalPipelineService.js';
import {
  destinatarioSugeridoDaDevolucaoDeVenda,
  notaDeDevolucaoDoRegistro,
} from './SituacaoFiscalDaDevolucao.js';
import {
  chaveReusada,
  impressaoDe,
  jsonCanonico,
  numero,
  outraImpressao,
  porCodigo,
  texto,
} from '../api/ImpressaoDaRequisicao.js';

export type RefundMethod = 'dinheiro' | 'credito' | 'estorno_cartao' | 'pix';

/**
 * O QUE UMA LINHA DEVOLVIDA MEXE NA PRATELEIRA — o espelho de `baixasDaLinha`
 * da venda (E-venda-servidor-04).
 *
 * O DEFEITO: a devolução empilhava o `product_id` da LINHA e mandava entrada
 * dele. Duas linhas da venda falavam por outra coisa:
 *
 *   - o KIT QUE DESMEMBRA: a linha é o kit, e quem saiu da prateleira foram as
 *     peças. `applyMovement` recusa movimento de kit desmembrado
 *     (CORE_PRODUCT_IS_KIT), e como a tela nasce com "volta ao estoque"
 *     marcado, devolver um kit em bom estado dava 400 — o único contorno era
 *     marcar "com defeito", e as peças boas nunca voltavam ao saldo;
 *   - o SERVIÇO DE BALCÃO (stock_control = 0): a venda não baixou nada, e a
 *     devolução dava entrada de 1 no serviço — saldo fantasma de uma coisa que
 *     não existe na prateleira.
 *
 * A regra é a da venda, lida do cadastro de agora: serviço não fala por nada,
 * kit desmembrado fala pelas peças (quantidade da composição × devolvida),
 * kit sem peça cadastrada e produto comum falam por si. O cancelamento usa a
 * MESMA função para descontar o que voltou com defeito.
 */
export function pecasDaLinhaDevolvida(
  companyId: string,
  productId: string,
  quantidade: number,
): { productId: string; name: string; quantity: number; doKit: string | null }[] {
  const produto = getConnection()
    .prepare(
      `SELECT id, name, is_kit, kit_explode_on_sale, stock_control
         FROM core_products WHERE id = ? AND company_id = ?`,
    )
    .get(productId, companyId) as
    | { id: string; name: string; is_kit: number; kit_explode_on_sale: number; stock_control: number }
    | undefined;
  if (!produto) return [{ productId, name: productId, quantity: quantidade, doKit: null }];
  if (!produtoControlaEstoque(produto)) return [];
  if (produto.is_kit === 1 && produto.kit_explode_on_sale !== 0) {
    const pecas = listKitComponents(companyId, produto.id);
    if (pecas.length > 0) {
      return pecas.map((p) => ({
        productId: p.component_id,
        name: p.name,
        quantity: Number(p.quantity) * quantidade,
        doKit: produto.name,
      }));
    }
  }
  return [{ productId: produto.id, name: produto.name, quantity: quantidade, doKit: null }];
}

const METODOS = new Set<RefundMethod>(['dinheiro', 'credito', 'estorno_cartao', 'pix']);

export interface SaleReturnItemInput {
  saleItemId: string;
  quantity: number;
  /**
   * A peça volta para o estoque vendável?
   *
   * Falso para mercadoria com defeito. Somar peça quebrada ao saldo cria
   * estoque que não existe, e a falta só aparece quando alguém for vender e
   * não achar — meses depois, sem ninguém saber de onde veio.
   */
  restock?: boolean;
  /**
   * Em que condição a mercadoria voltou: intacto, defeituoso, quebrado,
   * avariado ou impróprio. Só o intacto pode voltar ao estoque disponível — a
   * peça avariada marcada para voltar é recusada. Obrigatória na devolução em
   * duas etapas quando a mercadoria NÃO volta ao estoque.
   */
  condition?: string | null;
  /**
   * QUAL peça está voltando, para produto serializado.
   *
   * Obrigatório, e sem padrão: ver `unidadesQueVoltam`. A quantidade tem de
   * bater exatamente com o tamanho desta lista.
   */
  unitIds?: string[];
}

/**
 * QUAIS peças estão voltando desta linha — e por que o sistema NÃO escolhe.
 *
 * ## O sorteio que isto substitui
 *
 * Antes, a devolução pegava as unidades da venda e cortava a lista pela
 * quantidade (`.slice(0, quantity)`), numa consulta que nem ordem tinha. O
 * cliente que comprou duas motos iguais na mesma venda e devolveu a de chassi B
 * podia ter a A registrada como devolvida. As consequências não são de
 * relatório:
 *
 *   - o pátio fica com a B e o sistema afirma que tem a A;
 *   - a plaquinha da A volta a ser vendável e sai para outro comprador
 *     carregando o chassi de uma moto que está na garagem do primeiro;
 *   - e o portal do primeiro passa a mostrar a moto que está no pátio da loja.
 *
 * Nada disso aparece em saldo nenhum: as duas contas fecham. Só aparece no dia
 * em que alguém confere o chassi — no emplacamento, no seguro ou numa blitz.
 *
 * ## É A MESMA REGRA QUE A SAÍDA JÁ IMPÕE
 *
 * `applyMovement` recusa toda saída de serializado sem `unitIds`
 * (`CORE_UNITS_REQUIRED`) pelo mesmo motivo: o funil não escolhe peça sozinho,
 * porque escolher esconderia a decisão de quem lê o código. A devolução era a
 * única ENTRADA que contornava essa regra — e é entrada de peça IDENTIFICADA,
 * com alguém no balcão e a moto na frente para bipar o chassi.
 *
 * ## O que é conferido, e por quê
 *
 *   tamanho exato    — devolver 1 de 2 sem dizer qual é o sorteio de novo.
 *   saiu NESTA venda — id de outra venda devolveria peça que este cliente nunca
 *                      levou, com dinheiro saindo do caixa por isso.
 *   é DESTE produto  — a linha fala de um produto só; aceitar peça de outro
 *                      creditaria o saldo errado.
 *   ainda `sold`     — peça já devolvida, ou já baixada por defeito, voltaria
 *                      duas vezes, e a segunda criaria estoque do nada.
 *   sem repetição    — a mesma peça em duas linhas devolveria uma moto como se
 *                      fossem duas.
 */
function unidadesQueVoltam(entrada: {
  companyId: string;
  saleId: string;
  productId: string;
  descricao: string;
  quantidade: number;
  pedidas: string[] | undefined;
  jaEscolhidas: Set<string>;
}): string[] {
  const pedidas = Array.isArray(entrada.pedidas) ? entrada.pedidas.map((id) => String(id)) : [];

  if (pedidas.length !== entrada.quantidade) {
    throw new ApiError(
      'CORE_RETURN_UNITS_REQUIRED',
      `"${entrada.descricao}" é controlado por unidade: informe qual peça está voltando — ` +
        `bipe o chassi ou o número de série. São ${entrada.quantidade} nesta linha e ` +
        `vieram ${pedidas.length}.`,
      400,
      { productId: entrada.productId, esperado: entrada.quantidade, recebido: pedidas.length },
    );
  }

  // O que saiu NESTA venda, deste produto, e ainda não voltou. É a mesma leitura
  // por referência de saída que o cancelamento usa — não uma escolha nova.
  const daVenda = new Set(
    unitsByExitReference(entrada.companyId, 'sale', entrada.saleId)
      .filter((u) => u.product_id === entrada.productId && u.status === 'sold')
      .map((u) => u.id),
  );

  for (const id of pedidas) {
    if (entrada.jaEscolhidas.has(id)) {
      throw new ApiError(
        'CORE_UNIT_REPEATED',
        'A mesma peça foi informada duas vezes nesta devolução.',
        400,
      );
    }
    if (!daVenda.has(id)) {
      throw new ApiError(
        'CORE_RETURN_UNIT_NOT_IN_SALE',
        `Esta peça de "${entrada.descricao}" não saiu nesta venda, ou já voltou antes. ` +
          'Confira o chassi ou o número de série bipado.',
        409,
        { unitId: id },
      );
    }
    entrada.jaEscolhidas.add(id);
  }

  return pedidas;
}

/** Quanto de um item de venda já voltou — em quantidade e em dinheiro. */
function jaDevolvido(saleItemId: string): { quantidade: number; cents: number } {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS q, COALESCE(SUM(total_cents), 0) AS c
         FROM core_sale_return_items WHERE sale_item_id = ?`,
    )
    .get(saleItemId) as { q: number; c: number };
  return { quantidade: row.q, cents: row.c };
}

/**
 * O LÍQUIDO DE CADA LINHA — o desconto do rodapé rateado (GAP-PRD-009).
 *
 * `core_sale_items.total_cents` é líquido só do desconto DA LINHA. O desconto
 * do rodapé (`core_sales.discount_cents`) mora no cabeçalho, e a devolução que
 * lia só a linha devolvia o bruto dele: a venda de 2 × R$ 100 com R$ 20 de
 * desconto — R$ 180 pagos — devolvia R$ 200. Os R$ 20 saíam do caixa em
 * silêncio, com 201.
 *
 * O rateio é pela proporção de cada linha no subtotal (a soma das linhas, que é
 * o `subtotal_cents` da venda), em centavos inteiros e sem ponto flutuante:
 *
 *   parcela = ⌊desconto × linha / subtotal⌋, e o resto — sempre menor que o
 *   número de linhas — vai um centavo por linha para as MAIORES frações; no
 *   empate, para a que veio primeiro na venda.
 *
 * A soma dos líquidos é exatamente `subtotal − desconto`, e nenhuma parcela
 * passa do valor da própria linha. É o mesmo líquido que a comissão já usava
 * como base (`subtotal − desconto`), agora também para o dinheiro.
 *
 * O acréscimo (juros de parcelamento, frete) NÃO volta: não é mercadoria, e a
 * comissão já o trata do mesmo jeito.
 */
export function liquidoDasLinhas(saleId: string): Map<string, number> {
  const db = getConnection();
  const venda = db
    .prepare('SELECT discount_cents FROM core_sales WHERE id = ?')
    .get(saleId) as { discount_cents: number | null } | undefined;
  const linhas = db
    .prepare('SELECT id, total_cents FROM core_sale_items WHERE sale_id = ? ORDER BY rowid')
    .all(saleId) as unknown as { id: string; total_cents: number }[];

  const liquidos = new Map<string, number>();
  const base = linhas.reduce((acc, l) => acc + Math.max(0, l.total_cents), 0);
  const desconto = Math.min(Math.max(0, Math.round(Number(venda?.discount_cents ?? 0))), base);
  if (desconto === 0 || base === 0) {
    for (const l of linhas) liquidos.set(l.id, l.total_cents);
    return liquidos;
  }

  const baseB = BigInt(base);
  const parcelas = linhas.map((l, ordem) => {
    const produto = BigInt(desconto) * BigInt(Math.max(0, l.total_cents));
    return { id: l.id, total: l.total_cents, ordem, parcela: Number(produto / baseB), resto: produto % baseB };
  });
  let sobra = desconto - parcelas.reduce((acc, p) => acc + p.parcela, 0);
  const porFracao = [...parcelas].sort((a, b) =>
    a.resto === b.resto ? a.ordem - b.ordem : a.resto > b.resto ? -1 : 1,
  );
  for (const p of porFracao) {
    if (sobra <= 0) break;
    p.parcela += 1;
    sobra -= 1;
  }
  for (const p of parcelas) liquidos.set(p.id, p.total - p.parcela);
  return liquidos;
}

/**
 * QUANTO VALE ESTA PARCELA DA LINHA — sem resíduo acumulado (GAP-PRD-050).
 *
 * Cada devolução parcial arredondava sozinha (`round(total × qtd / vendida)`):
 * a linha de 3 un. que custou R$ 29,99, devolvida 1 + 1 + 1, somava R$ 30,00.
 *
 * A conta é sobre o ACUMULADO, como o estorno de comissão: quanto DEVERIA ter
 * voltado desta linha depois desta devolução, menos o que já voltou. O
 * arredondamento de uma etapa é absorvido na seguinte, e a que esgota a linha
 * devolve exatamente o que resta. 1 + 1 + 1 de 2999 = 1000 + 999 + 1000.
 *
 * Nunca negativa e nunca acima do líquido da linha — uma devolução antiga,
 * gravada pela conta velha, que já devolveu a mais, não faz a próxima pagar
 * de novo.
 *
 * A tela de devoluções faz a MESMA conta para mostrar "A devolver"
 * (`src/lib/valorDaDevolucao.ts`); mudar aqui é mudar lá.
 */
export function valorDaParcelaDevolvida(entrada: {
  liquidoDaLinha: number;
  quantidadeVendida: number;
  quantidadeJaDevolvida: number;
  valorJaDevolvido: number;
  quantidade: number;
}): number {
  const acumulada = entrada.quantidadeJaDevolvida + entrada.quantidade;
  const esgota = acumulada >= entrada.quantidadeVendida - 1e-9;
  const alvo = esgota
    ? entrada.liquidoDaLinha
    : Math.round((entrada.liquidoDaLinha * acumulada) / entrada.quantidadeVendida);
  return Math.max(0, Math.min(alvo, entrada.liquidoDaLinha) - entrada.valorJaDevolvido);
}

/*
  ============================================================================
  A DEVOLUÇÃO NÃO SE REPETE PELO REENVIO (E-venda-servidor-09)
  ============================================================================

  O DEFEITO: `POST /sale-returns` não tinha chave de idempotência. A resposta
  perdida DEPOIS do commit (rede do balcão caindo, o 504 do proxy) virava, no
  reenvio, uma SEGUNDA devolução: mais dinheiro saindo da gaveta, o estoque
  subindo de novo, o vale concedido duas vezes. A tela passou a conferir o
  histórico antes de reenviar, mas conferir na tela é a metade que depende da
  rede estar de volta; a outra metade é o servidor reconhecer o pedido.

  A chave (cabeçalho `Idempotency-Key`) aponta, em `core_sale_return_requests`,
  para a devolução que ela criou, gravada na MESMA transação da devolução — a
  devolução que não aconteceu não deixa chave, e a chave nunca aponta para uma
  devolução desfeita. O reenvio com a mesma chave:

    - e o MESMO pedido: devolve a devolução já gravada (200), sem mexer em
      gaveta, estoque, crédito, comissão ou cartão;
    - e OUTRO pedido: 422 CORE_IDEMPOTENCY_KEY_REUSED, e nada é gravado — a
      régua do rascunho IETF que a venda e os vizinhos dela já seguem
      (`ImpressaoDaRequisicao`).

  Sem chave, é o comportamento de sempre.
*/

/** A chave do pedido, aparada; ausente ou vazia é `null` (sem idempotência). */
export function chaveDaDevolucao(bruta: unknown): string | null {
  const chave = typeof bruta === 'string' ? bruta.trim() : '';
  if (!chave) return null;
  if (chave.length > 200) {
    throw new ApiError(
      'CORE_IDEMPOTENCY_KEY_INVALID',
      'A chave de idempotência da devolução passa de 200 caracteres. Gere uma chave nova (um UUID basta) e envie de novo.',
      400,
    );
  }
  return chave;
}

/**
 * A impressão digital do pedido de devolução: o que ela FAZ — a venda, a forma
 * e cada linha (item, quantidade, volta ao estoque, quais peças).
 *
 * Ficam de fora a gaveta e o caixa (circunstância de quem reenvia: o turno
 * pode ter virado entre um envio e outro), o motivo (texto livre, como a
 * observação da venda) e a liberação do gestor (é gasta no primeiro envio). A
 * ordem das linhas e das peças não é informação: as duas são ordenadas.
 */
export function impressaoDaDevolucao(pedido: {
  saleId: unknown;
  refundMethod?: unknown;
  items: unknown;
}): string {
  const itens = Array.isArray(pedido.items) ? pedido.items : [];
  const linhas = itens
    .map((bruto) => {
      const item = (bruto ?? {}) as Partial<SaleReturnItemInput>;
      return {
        saleItemId: texto(item.saleItemId),
        quantity: numero(item.quantity),
        restock: item.restock !== false,
        unitIds: Array.isArray(item.unitIds) ? item.unitIds.map((u) => texto(u)).sort(porCodigo) : [],
      };
    })
    .sort((a, b) => porCodigo(jsonCanonico(a), jsonCanonico(b)));
  return impressaoDe({
    saleId: texto(pedido.saleId),
    refundMethod: texto(pedido.refundMethod) || 'dinheiro',
    items: linhas,
  });
}

/**
 * A devolução que esta chave já registrou — ou `null` quando a chave é nova.
 *
 * Com outro pedido, recusa (422). A rota chama ANTES da liberação pontual: a
 * liberação do gestor foi gasta pelo primeiro envio, e sem esta leitura o
 * reenvio de quem não tem alçada tomaria "liberação já usada" em vez de ouvir
 * que a devolução está registrada. `createSaleReturn` repete a leitura dentro
 * da transação — é ali que dois envios simultâneos se resolvem.
 */
export function devolucaoDaChave(entrada: {
  companyId: string;
  idempotencyKey: unknown;
  pedido: { saleId: unknown; refundMethod?: unknown; items: unknown };
}): (Record<string, unknown> & { duplicated: true }) | null {
  const chave = chaveDaDevolucao(entrada.idempotencyKey);
  if (!chave) return null;
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT q.return_id, q.fingerprint, r.number
         FROM core_sale_return_requests q
         JOIN core_sale_returns r ON r.id = q.return_id
        WHERE q.company_id = ? AND q.idempotency_key = ?`,
    )
    .get(entrada.companyId, chave) as
    | { return_id: string; fingerprint: string; number: number }
    | undefined;
  if (!linha) return null;
  if (outraImpressao(linha.fingerprint, impressaoDaDevolucao(entrada.pedido))) {
    throw chaveReusada(`a devolução #${linha.number}`, {
      returnId: linha.return_id,
      returnNumber: linha.number,
    });
  }
  return { ...getSaleReturn(entrada.companyId, linha.return_id), duplicated: true };
}

export function createSaleReturn(input: {
  companyId: string;
  userId: string;
  saleId: string;
  reason: string;
  /** Duas etapas: o motivo em lista (ver `MOTIVOS_DA_DEVOLUCAO`) e a observação. */
  reasonCode?: string | null;
  reasonNote?: string | null;
  refundMethod?: RefundMethod;
  items: SaleReturnItemInput[];
  cashSessionId?: string | null;
  /**
   * O caixa do pedido (corpo ou token de dispositivo). Decide de qual gaveta
   * sai a devolução em dinheiro quando a informada não serve — ver
   * `GavetaDoDinheiro`.
   */
  terminalId?: string | null;
  /**
   * A chave do pedido (cabeçalho `Idempotency-Key`) — E-venda-servidor-09. O
   * reenvio com a mesma chave e o mesmo pedido devolve a devolução já gravada,
   * marcada `duplicated: true`, sem mexer em nada.
   */
  idempotencyKey?: string | null;
}): Record<string, unknown> {
  const chaveDoPedido = chaveDaDevolucao(input.idempotencyKey);
  ensureCoreSchema();

  /*
    A DEVOLUÇÃO EM DUAS ETAPAS (Preço Justo — `fluxoDaDevolucao`).

    O fluxo imediato dá o dinheiro por devolvido no próprio registro, num meio
    só — e para PIX e cartão isso é afirmar algo que ninguém fez ainda. Em duas
    etapas, ESTE registro trata só a MERCADORIA (itens, motivo, condição,
    estoque) e o valor devolvível; o reembolso é registrado depois, pelo que
    de fato aconteceu (`registrarReembolso`). Aqui a chave do pedido é
    obrigatória e o motivo vem da lista.
  */
  const emEtapas = fluxoDaDevolucao(input.companyId) === 'duas_etapas';
  let motivo = String(input.reason ?? '').trim();
  let codigoDoMotivo: string | null = null;
  let observacaoDoMotivo: string | null = null;
  if (emEtapas) {
    if (!chaveDoPedido) {
      throw new ApiError(
        'CORE_IDEMPOTENCY_KEY_REQUIRED',
        'A devolução precisa da chave da tentativa (cabeçalho Idempotency-Key) — é ela que impede '
          + 'a mesma devolução duas vezes no clique duplo. Recarregue a tela e registre de novo.',
        400,
      );
    }
    codigoDoMotivo = String(input.reasonCode ?? '').trim();
    const rotuloDoMotivo = MOTIVOS_DA_DEVOLUCAO[codigoDoMotivo];
    if (!rotuloDoMotivo) {
      throw new ApiError(
        'CORE_RETURN_REASON_REQUIRED',
        'Escolha o motivo da devolução: defeito, produto incorreto, desistência, troca ou outro.',
        400,
      );
    }
    observacaoDoMotivo = String(input.reasonNote ?? '').trim().slice(0, 500) || null;
    if (codigoDoMotivo === 'outro' && (observacaoDoMotivo?.length ?? 0) < 3) {
      throw new ApiError(
        'CORE_RETURN_REASON_NOTE_REQUIRED',
        'Motivo "outro": escreva na observação o que aconteceu.',
        400,
      );
    }
    motivo = observacaoDoMotivo ? `${rotuloDoMotivo} — ${observacaoDoMotivo}` : rotuloDoMotivo;
  }
  if (motivo.length < 3) {
    throw new ApiError('CORE_RETURN_REASON_REQUIRED', 'Informe o motivo da devolução.', 400);
  }
  const metodo: RefundMethod | 'em_etapas' = emEtapas
    ? 'em_etapas'
    : ((input.refundMethod ?? 'dinheiro') as RefundMethod);
  if (metodo !== 'em_etapas' && !METODOS.has(metodo)) {
    throw new ApiError('CORE_RETURN_METHOD_INVALID', 'Forma de devolução inválida.', 400);
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('CORE_RETURN_EMPTY', 'Selecione ao menos um item para devolver.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();

    // O reenvio do mesmo pedido devolve o que já foi gravado, antes de qualquer
    // escrita — dentro da transação, onde o segundo de dois envios simultâneos
    // já enxerga a chave do primeiro (E-venda-servidor-09).
    if (chaveDoPedido) {
      const jaRegistrada = devolucaoDaChave({
        companyId: input.companyId,
        idempotencyKey: chaveDoPedido,
        pedido: input,
      });
      if (jaRegistrada) return jaRegistrada;
    }

    const sale = db
      .prepare('SELECT * FROM core_sales WHERE id = ? AND company_id = ?')
      .get(input.saleId, input.companyId) as
      | {
          id: string;
          number: number;
          status: string;
          customer_id: string | null;
          subtotal_cents: number;
          discount_cents: number;
          total_cents: number;
        }
      | undefined;
    if (!sale) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);

    // Venda cancelada já devolveu tudo, pelo caminho do cancelamento. Aceitar
    // devolução em cima disso repor o estoque duas vezes.
    if (sale.status === 'cancelled') {
      throw new ApiError(
        'CORE_SALE_CANCELLED',
        'Venda cancelada não admite devolução: o cancelamento já repôs o estoque.',
        409,
      );
    }

    /*
      CRÉDITO DE LOJA EXIGE CLIENTE — e a recusa vem ANTES de qualquer gravação.

      O crédito é um vale: alguém entregou a mercadoria e vai voltar para
      gastá-lo. Sem cliente identificado ele seria dinheiro que a loja deve a
      ninguém — não há saldo a somar, não há extrato a mostrar, não há venda que
      o consuma. Foi exatamente esse o buraco desta rodada (GAP-V10/V47), e
      permiti-lo de novo por omissão o reabriria pela porta do balcão.

      A transação já protegeria contra a devolução meio escrita; a recusa sobe
      até aqui pela mensagem: quem está no balcão precisa ouvir "identifique o
      cliente" ANTES de escolher item, e não depois de montar a devolução
      inteira. As outras três formas seguem aceitando venda anônima — dinheiro,
      PIX e estorno no cartão saem na hora e não deixam dívida pendurada.
    */
    if (metodo === 'credito' && !sale.customer_id) {
      throw new ApiError(
        'CORE_RETURN_CREDIT_NEEDS_CUSTOMER',
        'Esta venda não tem cliente identificado, e crédito de loja precisa de dono: '
          + 'sem ele o vale não vira saldo de ninguém e o cliente não teria como gastá-lo. '
          + 'Devolva em dinheiro, PIX ou estorno no cartão.',
        409,
        { saleId: input.saleId },
      );
    }

    const returnId = randomUUID();
    const now = new Date().toISOString();
    const numero = nextSequenceValue(input.companyId, 'sale_return');

    // O cabeçalho vem ANTES dos itens: `core_sale_return_items.return_id`
    // aponta para cá, e inserir o filho primeiro derruba a chave estrangeira.
    // O total nasce zero e é fechado depois de somar as linhas; a gaveta
    // também — ela é a de onde o dinheiro SAIU, e só se sabe depois de
    // resolvida (GAP-PRD-161), não a que o corpo mandou.
    db.prepare(
      `INSERT INTO core_sale_returns
         (id, company_id, number, sale_id, reason, total_cents, refund_method,
          cash_session_id, created_by, created_at, refund_flow, reason_code, reason_note)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      returnId,
      input.companyId,
      numero,
      input.saleId,
      motivo,
      metodo,
      input.userId,
      now,
      emEtapas ? 'duas_etapas' : null,
      codigoDoMotivo,
      observacaoDoMotivo,
    );

    // O líquido de cada linha, com o desconto do rodapé rateado (GAP-PRD-009).
    const liquidos = liquidoDasLinhas(input.saleId);

    let total = 0;
    /**
     * As linhas que mexem em PEÇA — as com produto. Serviço não entra.
     *
     * `volta` separa as duas metades: quem volta ao vendável passa por
     * `applyMovement`, quem não volta passa pela baixa da unidade. As duas
     * precisam da MESMA lista de unidades conferida, e é por isso que ela é
     * resolvida aqui em cima, junto com a gravação da linha.
     */
    const linhas: {
      productId: string;
      quantity: number;
      descricao: string;
      volta: boolean;
      unitIds?: string[];
      /** A peça veio de um kit desmembrado — o nome do kit, para a recusa. */
      doKit?: string | null;
    }[] = [];
    /** As peças já escolhidas nesta devolução — uma moto não volta por duas linhas. */
    const unidadesEscolhidas = new Set<string>();

    for (const pedido of input.items) {
      const quantidade = Number(pedido.quantity);
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        throw new ApiError('CORE_RETURN_QUANTITY_INVALID', 'Quantidade inválida.', 400);
      }

      const item = db
        .prepare('SELECT * FROM core_sale_items WHERE id = ? AND sale_id = ?')
        .get(pedido.saleItemId, input.saleId) as
        | {
            id: string;
            product_id: string | null;
            description: string;
            quantity: number;
            total_cents: number;
          }
        | undefined;
      // Item de outra venda deixaria devolver mercadoria que este cliente nunca
      // levou, com dinheiro saindo do caixa por isso.
      if (!item) {
        throw new ApiError('CORE_RETURN_ITEM_NOT_FOUND', 'Item não pertence a esta venda.', 404);
      }

      const voltou = jaDevolvido(item.id);
      const disponivel = item.quantity - voltou.quantidade;
      if (quantidade > disponivel + 1e-9) {
        throw new ApiError(
          'CORE_RETURN_EXCEEDS_SOLD',
          `Devolução maior que o vendido: restam ${disponivel} de "${item.description}".`,
          409,
        );
      }

      // Proporcional ao LÍQUIDO da linha — desconto da linha e a parte dela no
      // desconto do rodapé (GAP-PRD-009) —, sobre o acumulado, para as
      // parciais não somarem centavo a mais (GAP-PRD-050). Usar o preço do
      // cadastro devolveria a mais depois de um aumento e a menos depois de
      // uma promoção — nos dois casos com dinheiro real.
      const valorLinha = valorDaParcelaDevolvida({
        liquidoDaLinha: liquidos.get(item.id) ?? item.total_cents,
        quantidadeVendida: item.quantity,
        quantidadeJaDevolvida: voltou.quantidade,
        valorJaDevolvido: voltou.cents,
        quantidade,
      });
      const unitario = Math.round(valorLinha / quantidade);
      total += valorLinha;

      const volta = pedido.restock !== false;

      /*
        A CONDIÇÃO DA MERCADORIA. Quebrado, defeituoso, avariado ou impróprio
        NÃO volta ao estoque disponível — marcar para voltar é recusado, em
        qualquer fluxo. Em duas etapas, a mercadoria que não volta diz em que
        condição ficou; a que volta é a intacta.
      */
      const condicaoPedida =
        pedido.condition === undefined || pedido.condition === null || String(pedido.condition).trim() === ''
          ? null
          : String(pedido.condition).trim();
      if (condicaoPedida !== null && !CONDICOES_DA_MERCADORIA.has(condicaoPedida)) {
        throw new ApiError(
          'CORE_RETURN_CONDITION_INVALID',
          'Condição da mercadoria inválida: intacto, defeituoso, quebrado, avariado ou impróprio.',
          400,
        );
      }
      if (volta && condicaoPedida !== null && condicaoPedida !== 'intacto') {
        throw new ApiError(
          'CORE_RETURN_DAMAGED_TO_STOCK',
          `"${item.description}" voltou ${ROTULO_DA_CONDICAO[condicaoPedida] ?? condicaoPedida} e não pode `
            + 'voltar ao estoque disponível. Marque "Retornar ao estoque disponível: NÃO".',
          409,
          { saleItemId: item.id, condition: condicaoPedida },
        );
      }
      if (emEtapas && !volta && condicaoPedida === null) {
        throw new ApiError(
          'CORE_RETURN_CONDITION_REQUIRED',
          `"${item.description}" não volta ao estoque: diga em que condição a mercadoria voltou `
            + '(defeituoso, quebrado, avariado ou impróprio).',
          400,
          { saleItemId: item.id },
        );
      }
      const condicao = condicaoPedida ?? (emEtapas && volta ? 'intacto' : null);

      // QUAL peça voltou, conferida ANTES de gravar qualquer coisa desta linha:
      // recusar depois de inserir deixaria a devolução meio escrita se algum dia
      // alguém tirar a transação daqui de fora. Vale para as DUAS metades — a
      // peça com defeito também precisa ser identificada, senão a baixa cai na
      // moto errada. Ver `unidadesQueVoltam`.
      const serializado = Boolean(item.product_id) && isSerialized(input.companyId, item.product_id!);
      const unidades = serializado
        ? unidadesQueVoltam({
            companyId: input.companyId,
            saleId: input.saleId,
            productId: item.product_id!,
            descricao: item.description,
            quantidade: quantidade,
            pedidas: pedido.unitIds,
            jaEscolhidas: unidadesEscolhidas,
          })
        : undefined;

      db.prepare(
        `INSERT INTO core_sale_return_items
           (id, return_id, company_id, sale_item_id, product_id, quantity, unit_price_cents,
            total_cents, restock, created_at, item_condition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        returnId,
        input.companyId,
        item.id,
        item.product_id,
        quantidade,
        unitario,
        valorLinha,
        volta ? 1 : 0,
        now,
        condicao,
      );

      // Linha de serviço (mão de obra) não tem produto e não mexe em peça
      // nenhuma — nem no saldo, nem em unidade, nem em plaquinha. O serviço de
      // balcão (stock_control = 0) e o kit desmembrado falam pelo que de fato
      // sai da prateleira: ver `pecasDaLinhaDevolvida` (E-venda-servidor-04).
      // A linha do documento continua sendo a do kit — é o que o cliente
      // devolveu e o que o cancelamento lê.
      if (item.product_id) {
        for (const peca of pecasDaLinhaDevolvida(input.companyId, item.product_id, quantidade)) {
          const aPropria = peca.productId === item.product_id;
          linhas.push({
            productId: peca.productId,
            quantity: peca.quantity,
            descricao: aPropria ? item.description : `${peca.name} (do kit ${peca.doKit ?? item.description})`,
            volta,
            unitIds: aPropria ? unidades : undefined,
            doKit: peca.doKit,
          });
        }
      }
    }

    /*
      A SOMA DAS DEVOLUÇÕES NUNCA PASSA DO QUE ENTROU (GAP-PRD-009).

      Com o rateio e o acumulado acima, uma venda devolvida inteira devolve
      exatamente `subtotal − desconto`, que nunca passa do total. Esta trava é a
      última linha para o que o rateio não alcança: devolução gravada pela conta
      antiga (bruta do desconto) numa linha, e a próxima vindo pela nova em
      outra. Recusar com o valor que resta é melhor que tirar da gaveta um
      dinheiro que a venda nunca trouxe.
    */
    const devolvidoAntes = (
      db
        .prepare(
          `SELECT COALESCE(SUM(total_cents), 0) AS t FROM core_sale_returns
            WHERE company_id = ? AND sale_id = ? AND id <> ?`,
        )
        .get(input.companyId, input.saleId, returnId) as { t: number }
    ).t;
    if (devolvidoAntes + total > sale.total_cents) {
      const resta = Math.max(0, sale.total_cents - devolvidoAntes);
      throw new ApiError(
        'CORE_RETURN_EXCEEDS_PAID',
        `Esta devolução de ${emReais(total)} somaria ${emReais(devolvidoAntes + total)} devolvidos `
          + `numa venda de ${emReais(sale.total_cents)}. Devoluções anteriores já devolveram `
          + `${emReais(devolvidoAntes)}; o que ainda resta desta venda é ${emReais(resta)}.`,
        409,
        { saleId: input.saleId, totalVenda: sale.total_cents, devolvidoAntes, pedido: total, resta },
      );
    }

    /*
      DE QUAL GAVETA SAI A DEVOLUÇÃO EM DINHEIRO (GAP-PRD-161).

      Antes: só quando a gaveta informada estava aberta; fora disso a
      devolução, a despesa e o estorno de estoque eram gravados e a gaveta
      ficava de fora, EM SILÊNCIO — o fechamento do dia acusava a falta exata.
      Agora é a régua do cancelamento, num lugar só (`GavetaDoDinheiro`): a
      informada se aberta; fechada ou ausente, a de agora (do caixa do pedido,
      ou a única aberta); nenhuma é recusa nomeada, e a transação desfaz tudo.
    */
    let gavetaDaDevolucao: string | null = null;
    let notaDaGaveta = `Devolução #${numero} da venda #${sale.number}`;
    if (metodo === 'dinheiro' && total > 0) {
      const gaveta = gavetaDoDinheiro({
        companyId: input.companyId,
        operacao: 'devolucao',
        valorCents: total,
        informada: input.cashSessionId ?? null,
        terminalId: input.terminalId ?? null,
        seInformadaFechada: 'procurar_a_de_agora',
      });
      if (gaveta) {
        gavetaDaDevolucao = gaveta.sessionId;
        if (gaveta.informadaFechada) notaDaGaveta += ' · turno já fechado: saiu da gaveta de agora';
      }
    }

    db.prepare('UPDATE core_sale_returns SET total_cents = ?, cash_session_id = ? WHERE id = ?').run(
      total,
      gavetaDaDevolucao,
      returnId,
    );

    /*
      COMISSÃO — estorno PROPORCIONAL, na mesma transação.

      O denominador é a BASE COMISSIONÁVEL da venda — subtotal menos o
      desconto de cabeçalho —, não o total (que traz o acréscimo) nem o
      subtotal. Desde o GAP-PRD-009 a devolução devolve o LÍQUIDO do rateio do
      desconto, que é exatamente a medida da base: a venda devolvida inteira
      estorna a comissão inteira. Dividir pelo subtotal (como quando a
      devolução era bruta) estornaria a menos em toda venda com desconto de
      balcão; dividir pelo total, também.

      Quem for "padronizar" isto com o `reversePoints` logo abaixo, que usa
      `total_cents`, vai reintroduzir esse erro.
    */
    const baseComissionavel = sale.subtotal_cents - (sale.discount_cents ?? 0);
    if (baseComissionavel > 0) {
      estornarComissaoDaDevolucao({
        companyId: input.companyId,
        saleId: input.saleId,
        returnId,
        devolvidoCents: total,
        subtotalCents: baseComissionavel,
      });
    }

    /*
      ================================================================
      O MESMO PRODUTO EM DUAS LINHAS DA DEVOLUÇÃO — e aqui sai DINHEIRO
      ================================================================

      A venda registra o mesmo produto em duas linhas sempre que o operador o
      bipa duas vezes, e o sistema já lida com isso na SAÍDA: as baixas são
      somadas por produto. A devolução é montada a partir dessas linhas, então
      ela herda as duas.

      Aplicar um movimento POR LINHA produzia duas chamadas com a MESMA chave
      de idempotência — `applyMovement` distingue por
      (empresa, referência, id da referência, produto, tipo), e aqui a
      referência é a DEVOLUÇÃO. A segunda voltava como repetida e a quantidade
      dela era descartada.

      O que torna este caso pior que o da entrada de nota: o dinheiro JÁ SAIU.
      O total da devolução é calculado sobre as duas linhas e devolvido ao
      cliente; só o estoque ficava com uma. A loja pagava por mercadoria que
      nunca voltou ao saldo, uma vez por devolução, sem erro em lugar nenhum.

      As unidades serializadas são concatenadas junto: duas linhas de uma moto
      cada devolvem as DUAS plaquinhas, e não uma.
    */
    interface VoltaAgrupada {
      quantity: number;
      unitIds: string[] | undefined;
    }
    const voltaPorProduto = new Map<string, VoltaAgrupada>();
    for (const linha of linhas) {
      if (!linha.volta) continue;
      const antes = voltaPorProduto.get(linha.productId);
      const unidades =
        antes?.unitIds || linha.unitIds
          ? [...(antes?.unitIds ?? []), ...(linha.unitIds ?? [])]
          : undefined;
      voltaPorProduto.set(linha.productId, {
        quantity: (antes?.quantity ?? 0) + linha.quantity,
        unitIds: unidades,
      });
    }

    /*
      A PEÇA DO KIT SÓ VOLTA ATÉ O QUE SAIU DELA NESTA VENDA.

      As peças são lidas da composição de AGORA (`pecasDaLinhaDevolvida`); se
      o kit mudou depois da venda, a conta pela composição nova poderia pôr na
      prateleira uma peça que nunca saiu. O teto é o movimento: o que saiu por
      esta venda menos o que devoluções anteriores já puseram de volta.
    */
    const pecasDeKit = new Set(linhas.filter((l) => l.volta && l.doKit).map((l) => l.productId));
    if (pecasDeKit.size > 0) {
      const saiu = db.prepare(
        `SELECT COALESCE(ABS(SUM(quantity)), 0) AS q FROM core_stock_movements
          WHERE company_id = ? AND reference_type = 'sale' AND reference_id = ?
            AND movement_type = 'out' AND product_id = ?`,
      );
      const jaVoltou = db.prepare(
        `SELECT COALESCE(ABS(SUM(m.quantity)), 0) AS q FROM core_stock_movements m
           JOIN core_sale_returns r ON r.id = m.reference_id
          WHERE m.company_id = ? AND m.reference_type = 'sale_return' AND m.movement_type = 'in'
            AND r.sale_id = ? AND m.product_id = ?`,
      );
      for (const productId of pecasDeKit) {
        const saida = Number((saiu.get(input.companyId, input.saleId, productId) as { q: number }).q);
        const voltou = Number(
          (jaVoltou.get(input.companyId, input.saleId, productId) as { q: number }).q,
        );
        const pedida = voltaPorProduto.get(productId)?.quantity ?? 0;
        if (pedida + voltou > saida + 1e-9) {
          const linha = linhas.find((l) => l.productId === productId);
          throw new ApiError(
            'CORE_RETURN_EXCEEDS_SOLD',
            `"${linha?.descricao ?? productId}": saíram ${saida} nesta venda e ${voltou} já voltaram, `
              + `então não dá para voltar mais ${pedida}. A composição do kit mudou depois da venda — `
              + 'devolva marcando "com defeito" e acerte o estoque pela contagem.',
            409,
            { productId, saiu: saida, jaVoltou: voltou, pedida },
          );
        }
      }
    }

    for (const [productId, volta] of voltaPorProduto) {
      // O que volta é a MESMA peça que saiu nesta venda — agora dita pelo
      // operador e conferida contra a referência de saída, não escolhida pelo
      // sistema. Ver `unidadesQueVoltam`.
      applyMovement({
        companyId: input.companyId,
        productId,
        movementType: 'in',
        quantity: volta.quantity,
        unitIds: volta.unitIds,
        referenceType: 'sale_return',
        referenceId: returnId,
        kind: 'SALE_RETURN',
        documentNumber: `Devolução #${numero}`,
        userId: input.userId,
        reason: motivo,
        note: `Devolução da venda #${sale.number}`,
      });
    }

    for (const linha of linhas) {
      if (linha.volta) continue;

      /*
        A DEVOLUÇÃO "COM DEFEITO" TAMBÉM PRECISA SOLTAR A PLAQUINHA.

        A caixinha desmarcada no balcão ("Não — com defeito") quer dizer UMA
        coisa: o saldo não sobe. Peça quebrada somada ao vendável é estoque que
        não existe, e a falta só aparece quando alguém for vender e não achar.

        Só que a linha inteira ficava de fora do estoque, e com ela ficava de fora
        a moto. O cliente recebia o dinheiro, entregava a moto, e CONTINUAVA sendo
        o dono dela no portal da oficina: via o histórico e podia abrir chamado
        para uma moto parada no pátio da loja. E não havia saída — `desvincular`
        recusa por status da unidade e por `sale_status` da plaquinha. A única
        correção possível era no banco, à mão.

        O que muda aqui é só a PROPRIEDADE, nunca o saldo:

          `devolverPelaUnidade` tira o dono — a venda foi desfeita para esta moto,
            e é isso que o portal precisa saber. Decide por estado, então unidade
            sem plaquinha, ou com plaquinha que nunca foi vendida, não faz nada.

          `baixarPelaUnidade` desfaz o vínculo, e é o que impede a plaquinha de
            CONGELAR: unidade fora do estoque apontando para a plaquinha some da
            lista de adotáveis para sempre. Depois de `devolverPelaUnidade` de
            propósito — ela só age em plaquinha `NOT_SOLD`, que é o estado que a
            linha de cima acabou de restabelecer.

          `markUnitsWrittenOff` deixa a unidade `baixada`: a moto voltou
            fisicamente e NÃO é vendável. Sem tocar em `core_stock`, que é a razão
            de existir da caixinha.
      */
      if (!linha.unitIds) continue;

      devolverPelaUnidade({
        companyId: input.companyId,
        unitIds: linha.unitIds,
        userId: input.userId,
      });
      baixarPelaUnidade({
        companyId: input.companyId,
        unitIds: linha.unitIds,
        referenceType: 'sale_return',
        userId: input.userId,
      });
      markUnitsWrittenOff(
        input.companyId,
        linha.unitIds,
        `Devolução #${numero} da venda #${sale.number}: voltou com defeito e não é vendável — ${motivo}`,
      );
    }

    /*
      O ESTORNO NO CARTÃO VAI PARA A MAQUININHA (GAP-PRD-080).

      Era só o documento, com o comentário "volta pela operadora" — e a
      cobrança da maquininha continuava `authorized`, sem pedido de estorno
      nem rastro. Agora o valor devolvido é marcado "a estornar" nas cobranças
      de cartão da venda, dentro desta transação; quem chamou pede o estorno à
      operadora depois do commit (`executarEstornosPendentes`). Pedir no
      cartão mais do que o cartão integrado pagou é recusado aqui, antes de
      qualquer gravação valer. Venda sem cobrança integrada (maquininha
      avulsa) não tem o que marcar: o estorno continua sendo no aparelho.
    */
    if (metodo === 'estorno_cartao') {
      marcarCobrancasAEstornar({
        companyId: input.companyId,
        saleId: input.saleId,
        saleNumber: sale.number,
        userId: input.userId,
        origem: 'devolucao',
        referenciaId: returnId,
        motivo: `Devolução #${numero} da venda #${sale.number} — ${motivo}`,
        valorCents: total,
      });
    }

    /*
      A DEVOLUÇÃO SÓ DEVOLVE, EM CADA MEIO, O QUE ENTROU NELE
      (E-venda-servidor-03).

      O DEFEITO: o único teto era "a soma das devoluções não passa do total da
      venda". Venda de R$ 200 paga só com vale, devolvida dois dias depois: a
      forma já vinha "Dinheiro" e R$ 200 saíam da gaveta — o vale virava
      espécie, exatamente a porta que `createSale` fecha com "crédito de loja
      não vira troco". O mesmo com a venda no cartão devolvida em dinheiro (o
      cliente fica com o estorno da operadora E com a nota) e com o PIX
      "receber depois" que nunca caiu, devolvido em dinheiro sem nunca ter
      entrado.

      A regra: dinheiro e PIX voltam até o que entrou em dinheiro e PIX; o
      estorno no cartão, até o que entrou no cartão; o crédito de loja, até
      tudo o que foi recebido — trocar por vale é sempre possível; e o que
      ainda está em aberto não volta por meio nenhum. Depois do estorno na
      maquininha de propósito: ali a recusa é mais precisa (o que a cobrança
      INTEGRADA ainda pode estornar), e as duas moram na mesma transação.
    */
    const limites = limitesDeReembolso(input.companyId, input.saleId, returnId);
    const recebido = Math.max(0, sale.total_cents - limites.emAbertoCents);
    const cabeNoRecebido = recebido - limites.devolvido.todos;
    const tetoDoMeio =
      metodo === 'dinheiro' || metodo === 'pix'
        ? limites.dinheiroOuPixCents - limites.devolvido.dinheiroOuPix
        : metodo === 'estorno_cartao'
          ? limites.cartaoCents - limites.devolvido.cartao
          : cabeNoRecebido;
    const teto = Math.max(0, Math.min(tetoDoMeio, cabeNoRecebido));
    // Em duas etapas o meio ainda não existe: o teto é o que a venda RECEBEU,
    // menos o que devoluções anteriores já tornaram devolvível. O meio é
    // conferido no registro de cada reembolso.
    if (total > teto && metodo === 'em_etapas') {
      throw new ApiError(
        'CORE_RETURN_EXCEEDS_RECEIVED',
        `Esta devolução de ${emReais(total)} passa do que a venda recebeu: `
          + `entraram ${emReais(recebido)}`
          + (limites.devolvido.todos > 0
            ? ` e devoluções anteriores já somam ${emReais(limites.devolvido.todos)}`
            : '')
          + `, então o máximo que ainda pode ser devolvido é ${emReais(teto)}. O que não foi `
          + 'recebido não volta — receba antes em Contas a receber, ou cancele a venda se ela não aconteceu.',
        409,
        { pedidoCents: total, tetoCents: teto, limites },
      );
    }
    if (total > teto) {
      const entrou: string[] = [];
      if (limites.dinheiroOuPixCents > 0) entrou.push(`${emReais(limites.dinheiroOuPixCents)} em dinheiro ou PIX`);
      if (limites.cartaoCents > 0) entrou.push(`${emReais(limites.cartaoCents)} no cartão`);
      if (limites.valeCents > 0) entrou.push(`${emReais(limites.valeCents)} em crédito de loja`);
      if (limites.emAbertoCents > 0) entrou.push(`${emReais(limites.emAbertoCents)} ainda em aberto`);
      const rotulo =
        metodo === 'dinheiro' ? 'dinheiro' : metodo === 'pix' ? 'PIX' : metodo === 'estorno_cartao' ? 'estorno no cartão' : 'crédito de loja';
      const dica =
        metodo === 'estorno_cartao'
          ? 'O que entrou em dinheiro ou PIX volta em dinheiro ou PIX; o vale volta como crédito de loja.'
          : metodo === 'credito'
            ? 'O que não foi recebido não volta — receba antes em Contas a receber, ou cancele a venda se ela não aconteceu.'
            : 'O que foi pago no cartão volta por estorno no cartão; o vale volta como crédito de loja; o que não foi recebido não volta.';
      throw new ApiError(
        'CORE_RETURN_METHOD_EXCEEDS_RECEIVED',
        `Esta devolução de ${emReais(total)} por ${rotulo} passa do que a venda recebeu nesse meio. `
          + `A venda entrou com ${entrou.join(', ') || 'nada recebido'}`
          + (limites.devolvido.todos > 0
            ? `, e devoluções anteriores já devolveram ${emReais(limites.devolvido.todos)}`
            : '')
          + `: o máximo que ainda pode voltar por ${rotulo} é ${emReais(teto)}. ${dica}`,
        409,
        { metodo, pedidoCents: total, tetoCents: teto, limites },
      );
    }

    // O dinheiro que volta é lançamento PRÓPRIO, na direção contrária.
    //
    // Mexer no lançamento da venda seria reescrever receita de um mês que pode
    // já estar fechado. Aqui a venda continua valendo o que valeu, e a
    // devolução aparece ao lado, diminuindo o resultado do mês em que
    // aconteceu — que é onde ela de fato aconteceu.
    //
    // Crédito na loja não sai do caixa: vira saldo do cliente (razão própria,
    // logo abaixo), e o dinheiro só se move quando ele usar. Lançar como saída
    // agora contaria duas vezes.
    //
    // Em duas etapas também não: nenhum dinheiro saiu ainda. Cada reembolso
    // registrado depois lança a sua saída, no meio em que aconteceu.
    if (metodo !== 'credito' && !emEtapas) {
      const lancamentoId = randomUUID();
      db.prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents, settled_at,
            customer_id, description, origin_type, origin_id,
            category_id, competence_date, created_at)
         VALUES (?, ?, 'out', ?, 'settled', ?, ?, ?, ?, 'sale_return', ?, ?, ?, ?)`,
      ).run(
        lancamentoId,
        input.companyId,
        total,
        total,
        now,
        sale.customer_id,
        `Devolução #${numero} da venda #${sale.number}`,
        returnId,
        systemCategoryId(input.companyId, 'devolucao'),
        // O "mês em que aconteceu" é o mês da LOJA: `now.slice(0, 10)` daria
        // o dia de Greenwich, e a devolução das 22h30 do dia 31 desceria o
        // resultado do mês SEGUINTE.
        diaDaLoja(now),
        now,
      );

      /*
        O QUE NASCE QUITADO NASCE COM A BAIXA (V29) — a devolução era a última
        que faltava.

        A regra é do cabeçalho de `inserirBaixaEspelho`: `settled_cents` cheio
        SEM linha em `core_finance_settlements` fecha o saldo e não conta a
        história. A conciliação bancária compara extrato contra BAIXAS, e para
        ela a devolução em PIX — que sai da conta e aparece no extrato — não
        existia; o regime de caixa, idem. A venda à vista foi consertada na V29
        e a devolução ficou para trás, com o agravante de ser a ponta em que o
        dinheiro SAI: uma saída invisível é pior que uma entrada invisível.

        Na MESMA transação do lançamento, porque a baixa nasce ou morre junto
        com ele. E o método é o da devolução, que aqui é sempre UM só — não há
        devolução mista —, então a baixa carrega a verdade e não um nulo.
      */
      // Devolução de valor zero (item que a venda deu de graça) não move
      // dinheiro nenhum: baixa de zero seria uma linha sem fato.
      if (total > 0) {
        inserirBaixaEspelho({
          companyId: input.companyId,
          entryId: lancamentoId,
          amountCents: total,
          method: metodo,
          settledAt: now,
          userId: input.userId,
          note: `Devolução #${numero} da venda #${sale.number}`,
        });
      }
    }

    /*
      O CRÉDITO DE LOJA VIRA SALDO — a metade que faltava do ciclo (GAP-V10/V47).

      O comentário acima prometia "vira saldo do cliente" desde a rodada 21, e o
      saldo não existia em lugar nenhum: `refund_method='credito'` era gravado, o
      DRE nomeava o valor numa ressalva e o vale vivia no papel do balcão.

      A concessão entra na MESMA transação da devolução — vale concedido por uma
      devolução que não aconteceu seria dinheiro do nada — e é IDEMPOTENTE por
      origem: `grantCredit` lê antes de gravar, e a chave única da razão prende a
      concessão a ESTA devolução. Reenviar não concede duas vezes.

      Não há lançamento financeiro aqui, e é a mesma decisão de sempre: nenhum
      dinheiro saiu do caixa. A contabilidade inteira está escrita no cabeçalho
      de `CustomerCreditService`.
    */
    if (metodo === 'credito' && total > 0) {
      grantCredit({
        companyId: input.companyId,
        customerId: sale.customer_id,
        amountCents: total,
        originType: 'sale_return',
        originId: returnId,
        description: `Devolução #${numero} da venda #${sale.number}`,
        userId: input.userId,
      });
    }

    // Só sai da gaveta o que voltou EM DINHEIRO — pela gaveta resolvida lá em
    // cima (GAP-PRD-161). Estorno de cartão volta pela operadora, não pela
    // gaveta. `null` só na operação que nunca trabalhou com gaveta.
    if (gavetaDaDevolucao) {
      db.prepare(
        `INSERT INTO core_cash_movements
           (id, session_id, company_id, movement_type, amount_cents, payment_method,
            reference_type, reference_id, user_id, note, created_at)
         VALUES (?, ?, ?, 'sale_return', ?, 'dinheiro', 'sale_return', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        gavetaDaDevolucao,
        input.companyId,
        -total,
        returnId,
        input.userId,
        notaDaGaveta,
        now,
      );
    }

    // Devolveu, perde o ponto proporcional ao que voltou.
    //
    // Proporcional e não integral: devolver uma peça de três não pode zerar o
    // ponto da compra inteira, que o cliente ganhou pelas duas que ficaram.
    // A razão sai do valor, não da quantidade — é sobre valor que o ponto foi
    // concedido.
    const totalVenda = db
      .prepare('SELECT total_cents FROM core_sales WHERE id = ?')
      .get(input.saleId) as { total_cents: number } | undefined;
    if (totalVenda && totalVenda.total_cents > 0) {
      reversePoints({
        companyId: input.companyId,
        saleId: input.saleId,
        returnId,
        ratio: total / totalVenda.total_cents,
        userId: input.userId,
        reason: `Devolução #${numero} da venda #${sale.number}`,
      });
    }

    // A chave nasce com a devolução, na mesma transação: devolução desfeita
    // não deixa chave apontando para o nada (E-venda-servidor-09).
    if (chaveDoPedido) {
      db.prepare(
        `INSERT INTO core_sale_return_requests
           (company_id, idempotency_key, return_id, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(input.companyId, chaveDoPedido, returnId, impressaoDaDevolucao(input), now);
    }

    return getSaleReturn(input.companyId, returnId);
  });
}

/**
 * Quanto a venda recebeu, por meio, e quanto as devoluções já devolveram —
 * a régua de `createSaleReturn` (E-venda-servidor-03).
 *
 *   - cartão: as linhas de crédito e débito liquidadas;
 *   - vale: o crédito de loja que a venda gastou;
 *   - em aberto: o que o título da venda ainda não recebeu (PIX que não caiu,
 *     venda a prazo) — as parcelas da operadora ficam de fora, porque o
 *     cartão foi cobrado, só não foi depositado;
 *   - dinheiro ou PIX: o resto do total. Por diferença, e não pelas linhas,
 *     porque a venda a prazo recebida depois (baixa em Contas a receber) e o
 *     PIX confirmado pelo webhook entram por aí, e não em `core_sale_payments`.
 */
export function limitesDeReembolso(
  companyId: string,
  saleId: string,
  excetoDevolucao?: string,
): {
  totalCents: number;
  dinheiroOuPixCents: number;
  cartaoCents: number;
  valeCents: number;
  emAbertoCents: number;
  devolvido: { dinheiroOuPix: number; cartao: number; credito: number; todos: number };
} {
  const db = getConnection();
  const venda = db
    .prepare('SELECT total_cents FROM core_sales WHERE id = ? AND company_id = ?')
    .get(saleId, companyId) as { total_cents: number } | undefined;
  const total = Number(venda?.total_cents ?? 0);
  const vale = Math.abs(
    Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_cents), 0) AS v FROM core_customer_credits
              WHERE company_id = ? AND kind = 'redeem' AND origin_type = 'sale' AND origin_id = ?`,
          )
          .get(companyId, saleId) as { v: number }
      ).v,
    ),
  );
  const cartao = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM core_sale_payments
            WHERE sale_id = ? AND company_id = ? AND status = 'settled'
              AND method IN ('credito', 'debito')`,
        )
        .get(saleId, companyId) as { c: number }
    ).c,
  );
  const emAberto = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(MAX(amount_cents - COALESCE(settled_cents, 0), 0)), 0) AS a
             FROM core_finance_entries
            WHERE company_id = ? AND origin_type = 'sale' AND origin_id = ? AND direction = 'in'
              AND status <> 'cancelled' AND cancelled_at IS NULL
              AND (payment_method IS NULL OR payment_method NOT IN ('credito', 'debito'))`,
        )
        .get(companyId, saleId) as { a: number }
    ).a,
  );
  const porMeio = db
    .prepare(
      `SELECT refund_method AS metodo, COALESCE(SUM(total_cents), 0) AS t FROM core_sale_returns
        WHERE company_id = ? AND sale_id = ? AND id <> ?
        GROUP BY refund_method`,
    )
    .all(companyId, saleId, excetoDevolucao ?? '') as unknown as { metodo: string; t: number }[];
  const em = (m: string) => Number(porMeio.find((d) => d.metodo === m)?.t ?? 0);
  // O que os reembolsos das devoluções em duas etapas já devolveram, por meio.
  // `todos` continua sendo o valor DEVOLVÍVEL das devoluções (o teto da
  // mercadoria); os meios somam o que de fato saiu em cada um.
  const registrados = db
    .prepare(
      `SELECT method AS metodo, COALESCE(SUM(amount_cents), 0) AS t FROM core_sale_return_refunds
        WHERE company_id = ? AND sale_id = ?
        GROUP BY method`,
    )
    .all(companyId, saleId) as unknown as { metodo: string; t: number }[];
  const reg = (m: string) => Number(registrados.find((d) => d.metodo === m)?.t ?? 0);
  const devolvido = {
    dinheiroOuPix: em('dinheiro') + em('pix') + reg('dinheiro') + reg('pix'),
    cartao: em('estorno_cartao') + reg('debito') + reg('credito'),
    credito: em('credito') + reg('vale'),
    todos: porMeio.reduce((acc, d) => acc + Number(d.t), 0),
  };
  return {
    totalCents: total,
    dinheiroOuPixCents: Math.max(0, total - vale - cartao - Math.max(0, emAberto)),
    cartaoCents: cartao,
    valeCents: vale,
    emAbertoCents: Math.max(0, emAberto),
    devolvido,
  };
}

/** O nome de quem, dentro da empresa — o mesmo cerco da ficha da venda. */
function nomeNaEmpresa(companyId: string, userId: unknown): string | null {
  if (!userId) return null;
  const linha = getConnection()
    .prepare(
      `SELECT u.display_name FROM core_user_companies uc
         JOIN core_users u ON u.id = uc.user_id
        WHERE uc.user_id = ? AND uc.company_id = ?`,
    )
    .get(String(userId), companyId) as { display_name: string | null } | undefined;
  return linha?.display_name ?? null;
}

export function getSaleReturn(companyId: string, returnId: string): Record<string, unknown> {
  ensureCoreSchema();
  const db = getConnection();
  const registro = db
    .prepare(
      `SELECT r.*, s.number AS sale_number
         FROM core_sale_returns r
         JOIN core_sales s ON s.id = r.sale_id
        WHERE r.id = ? AND r.company_id = ?`,
    )
    .get(returnId, companyId) as Record<string, unknown> | undefined;
  if (!registro) throw new ApiError('CORE_RETURN_NOT_FOUND', 'Devolução não encontrada.', 404);

  const items = db
    .prepare(
      `SELECT ri.*, si.description
         FROM core_sale_return_items ri
         JOIN core_sale_items si ON si.id = ri.sale_item_id
        WHERE ri.return_id = ? ORDER BY ri.created_at`,
    )
    .all(returnId) as unknown as Record<string, unknown>[];

  /*
    MERCADORIA, REEMBOLSO E FISCAL SÃO TRÊS ESTADOS — e a ficha mostra os três.
    A mercadoria voltou (e foi, ou não, ao estoque) no ato do registro; o
    reembolso pode estar pendente, parcial ou concluído; o fiscal depende do
    documento da venda. Um não conclui o outro.
  */
  const registros = db
    .prepare(
      `SELECT f.*, u.display_name AS created_by_name
         FROM core_sale_return_refunds f
         LEFT JOIN core_user_companies uc ON uc.user_id = f.created_by AND uc.company_id = f.company_id
         LEFT JOIN core_users u ON u.id = uc.user_id
        WHERE f.return_id = ? AND f.company_id = ?
        ORDER BY f.created_at`,
    )
    .all(returnId, companyId) as unknown as Record<string, unknown>[];
  const reembolsado = registros.reduce((s, f) => s + Number(f.amount_cents ?? 0), 0);
  const resumo = resumoDoReembolso({ ...registro, reembolsado_cents: reembolsado });
  const saleId = String(registro.sale_id);
  const meiosDaVenda = meiosDaVendaParaReembolso(companyId, saleId);

  const voltaram = items.filter((i) => Number(i.restock) === 1).length;
  const estoque =
    items.length === 0 ? 'sem_itens' : voltaram === items.length ? 'retornou' : voltaram === 0 ? 'nao_retornou' : 'parcial';

  return {
    ...registro,
    items,
    created_by_name: nomeNaEmpresa(companyId, registro.created_by),
    approved_by_name: nomeNaEmpresa(companyId, registro.approved_by),
    mercadoria: { situacao: 'concluida', estoque },
    reembolso: {
      ...resumo,
      registros,
      meiosDaVenda,
      sugestao: resumo.fluxo === 'duas_etapas' ? sugestaoDeReembolso(meiosDaVenda, resumo.pendenteCents) : [],
    },
    fiscal: estadoFiscalDaVenda(companyId, saleId),
    // A NF-e de devolução DESTE registro, quando já existe (P0 fiscal).
    notaDeDevolucao: notaDeDevolucaoDoRegistro(companyId, 'devolucao_venda', returnId),
    /*
      QUEM A LOJA JÁ SABE QUE COMPROU (P0 fiscal). A NF-e de devolução de venda
      exige o endereço do destinatário com código IBGE, e a loja não o tem — o
      balcão vende com CPF e pronto. O que ela tem é o nome e o documento que
      foram para a NFC-e, e é com eles que o formulário da tela nasce
      preenchido, em vez de a pessoa redigitar o que o sistema já sabe.
    */
    destinatarioSugerido: destinatarioSugeridoDaDevolucaoDeVenda(companyId, returnId),
  };
}

export function listSaleReturns(
  companyId: string,
  filters: { saleId?: string; limit?: number } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  let sql = `SELECT r.*, s.number AS sale_number,
                    (SELECT COALESCE(SUM(f.amount_cents), 0) FROM core_sale_return_refunds f
                      WHERE f.return_id = r.id) AS reembolsado_cents
               FROM core_sale_returns r
               JOIN core_sales s ON s.id = r.sale_id
              WHERE r.company_id = ?`;
  const params: (string | number)[] = [companyId];

  if (filters.saleId) {
    sql += ' AND r.sale_id = ?';
    params.push(filters.saleId);
  }
  sql += ' ORDER BY r.number DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(filters.limit ?? 100), 1), 200));

  const linhas = getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
  return linhas.map((l) => ({ ...l, reembolso: resumoDoReembolso(l) }));
}

/* ============================================================================
   A DEVOLUÇÃO EM DUAS ETAPAS — o reembolso registrado pelo que aconteceu
   ============================================================================

   Ligada só na Preço Justo nesta entrega (`fluxoDaDevolucao`). A devolução
   registrou a mercadoria e o valor devolvível; aqui cada reembolso diz o que
   de fato voltou ao cliente, em qual meio, por quem e quando:

     dinheiro   sai da gaveta aberta — movimento VINCULADO ao reembolso
                ("DEVOLUÇÃO AO CLIENTE"), que baixa o esperado do fechamento;
     PIX        confirmação do PIX feito pela conta da loja — o DEVORA não
                envia PIX, e não finge que enviou;
     débito /   confirmação do estorno feito NA MAQUININHA — sem TEF, sem
     crédito    estorno automático (com cobrança integrada na venda, o pedido
                de estorno à operadora segue o caminho de sempre);
     vale       crédito de loja para o cliente identificado.

   Cada um lança a saída no financeiro (o vale vira saldo do cliente), nunca
   mexe em estoque, nunca passa do saldo pendente, e a chave do pedido impede
   o mesmo reembolso duas vezes. Meio diferente do que a venda recebeu é
   decisão de gestor, com justificativa — nunca silenciosa.
*/

export const MOTIVOS_DA_DEVOLUCAO: Record<string, string> = {
  defeito: 'Defeito',
  produto_incorreto: 'Produto incorreto',
  desistencia: 'Desistência',
  troca: 'Troca',
  outro: 'Outro',
};

export const CONDICOES_DA_MERCADORIA = new Set(['intacto', 'defeituoso', 'quebrado', 'avariado', 'improprio']);

const ROTULO_DA_CONDICAO: Record<string, string> = {
  intacto: 'intacto',
  defeituoso: 'defeituoso',
  quebrado: 'quebrado',
  avariado: 'avariado',
  improprio: 'impróprio',
};

export type MeioDoReembolso = 'dinheiro' | 'pix' | 'debito' | 'credito' | 'vale';
const MEIOS_DO_REEMBOLSO: readonly MeioDoReembolso[] = ['dinheiro', 'pix', 'debito', 'credito', 'vale'];

export const ROTULO_DO_MEIO_DO_REEMBOLSO: Record<MeioDoReembolso, string> = {
  dinheiro: 'dinheiro',
  pix: 'PIX',
  debito: 'estorno no débito',
  credito: 'estorno no crédito',
  vale: 'crédito de loja',
};

export type SituacaoDoReembolso = 'pendente' | 'parcial' | 'concluido' | 'nao_se_aplica';

export interface ResumoDoReembolso {
  fluxo: 'imediato' | 'duas_etapas';
  devolvivelCents: number;
  reembolsadoCents: number;
  pendenteCents: number;
  situacao: SituacaoDoReembolso;
}

/**
 * O estado do reembolso de uma devolução, da linha dela e da soma dos
 * registros. A devolução imediata (a de antes, e a das outras operações) deu o
 * valor por devolvido no próprio ato: concluída.
 */
export function resumoDoReembolso(linha: Record<string, unknown>): ResumoDoReembolso {
  const devolvivel = Number(linha.total_cents ?? 0);
  if (linha.refund_flow !== 'duas_etapas') {
    return {
      fluxo: 'imediato',
      devolvivelCents: devolvivel,
      reembolsadoCents: devolvivel,
      pendenteCents: 0,
      situacao: devolvivel > 0 ? 'concluido' : 'nao_se_aplica',
    };
  }
  const reembolsado = Number(linha.reembolsado_cents ?? 0);
  const pendente = Math.max(0, devolvivel - reembolsado);
  return {
    fluxo: 'duas_etapas',
    devolvivelCents: devolvivel,
    reembolsadoCents: reembolsado,
    pendenteCents: pendente,
    situacao: devolvivel <= 0 ? 'nao_se_aplica' : reembolsado <= 0 ? 'pendente' : pendente > 0 ? 'parcial' : 'concluido',
  };
}

export interface MeioDaVendaParaReembolso {
  method: MeioDoReembolso;
  /** O que a venda recebeu neste meio. */
  recebidoCents: number;
  /** O que devoluções desta venda já devolveram neste meio. */
  reembolsadoCents: number;
  /** O que ainda pode voltar por este meio sem trocar de meio. */
  disponivelCents: number;
}

/**
 * Como a venda foi paga, meio a meio, e quanto de cada meio ainda pode voltar.
 *
 * Cartão e PIX pelas linhas de pagamento liquidadas; o vale pelo crédito que a
 * venda gastou; o dinheiro é o resto do que entrou em dinheiro ou PIX (a mesma
 * régua de `limitesDeReembolso`, que conta o troco e o recebido depois). O que
 * já voltou soma as devoluções imediatas (pelo meio delas) e os reembolsos.
 */
export function meiosDaVendaParaReembolso(companyId: string, saleId: string): MeioDaVendaParaReembolso[] {
  const db = getConnection();
  const limites = limitesDeReembolso(companyId, saleId);
  const pagos = db
    .prepare(
      `SELECT method, COALESCE(SUM(amount_cents), 0) AS c FROM core_sale_payments
        WHERE sale_id = ? AND company_id = ? AND status = 'settled'
        GROUP BY method`,
    )
    .all(saleId, companyId) as unknown as { method: string; c: number }[];
  const pago = (m: string) => Number(pagos.find((p) => p.method === m)?.c ?? 0);
  const pix = Math.min(pago('pix'), limites.dinheiroOuPixCents);
  const recebido: Record<MeioDoReembolso, number> = {
    dinheiro: Math.max(0, limites.dinheiroOuPixCents - pix),
    pix,
    debito: pago('debito'),
    credito: pago('credito'),
    vale: limites.valeCents,
  };

  const imediatas = db
    .prepare(
      `SELECT refund_method AS metodo, COALESCE(SUM(total_cents), 0) AS t FROM core_sale_returns
        WHERE company_id = ? AND sale_id = ? AND (refund_flow IS NULL OR refund_flow <> 'duas_etapas')
        GROUP BY refund_method`,
    )
    .all(companyId, saleId) as unknown as { metodo: string; t: number }[];
  const imediata = (m: string) => Number(imediatas.find((d) => d.metodo === m)?.t ?? 0);
  const registrados = db
    .prepare(
      `SELECT method AS metodo, COALESCE(SUM(amount_cents), 0) AS t FROM core_sale_return_refunds
        WHERE company_id = ? AND sale_id = ?
        GROUP BY method`,
    )
    .all(companyId, saleId) as unknown as { metodo: string; t: number }[];
  const reg = (m: string) => Number(registrados.find((d) => d.metodo === m)?.t ?? 0);

  // O estorno no cartão da devolução imediata não diz débito ou crédito: sai
  // primeiro do crédito, e o que sobrar, do débito.
  const cartaoImediato = imediata('estorno_cartao');
  const doCredito = Math.min(cartaoImediato, Math.max(0, recebido.credito - reg('credito')));
  const reembolsado: Record<MeioDoReembolso, number> = {
    dinheiro: imediata('dinheiro') + reg('dinheiro'),
    pix: imediata('pix') + reg('pix'),
    credito: reg('credito') + doCredito,
    debito: reg('debito') + (cartaoImediato - doCredito),
    vale: imediata('credito') + reg('vale'),
  };

  return MEIOS_DO_REEMBOLSO.filter((m) => recebido[m] > 0 || reembolsado[m] > 0).map((m) => ({
    method: m,
    recebidoCents: recebido[m],
    reembolsadoCents: reembolsado[m],
    disponivelCents: Math.max(0, recebido[m] - reembolsado[m]),
  }));
}

/** A proposta: o saldo pendente pelos meios em que a venda entrou, na ordem deles. */
export function sugestaoDeReembolso(
  meios: MeioDaVendaParaReembolso[],
  pendenteCents: number,
): { method: MeioDoReembolso; cents: number }[] {
  const sugestao: { method: MeioDoReembolso; cents: number }[] = [];
  let falta = pendenteCents;
  for (const m of meios) {
    if (falta <= 0) break;
    const parte = Math.min(m.disponivelCents, falta);
    if (parte > 0) {
      sugestao.push({ method: m.method, cents: parte });
      falta -= parte;
    }
  }
  return sugestao;
}

export interface EstadoFiscalDaDevolucao {
  estado: 'nao_fiscal' | 'pendente_regularizacao' | 'nfce_pendente' | 'nfce_cancelada' | 'nfce_rejeitada';
  rotulo: string;
  detalhe: string;
  /** O status do documento da venda, como o fiscal o grava — nulo sem NFC-e. */
  documentoStatus: string | null;
}

/**
 * O FISCAL É UM TERCEIRO ESTADO, separado da mercadoria e do dinheiro.
 *
 * O DEVORA não emite nota de devolução nem cancela a NFC-e por causa de uma
 * devolução — e esta função não finge que faz. Ela diz, pelo documento da
 * venda, o que a devolução deixa em aberto no fiscal.
 */
export function estadoFiscalDaVenda(companyId: string, saleId: string): EstadoFiscalDaDevolucao {
  const nota = fiscalStatusForSale(companyId, saleId);
  if (!nota) {
    return {
      estado: 'nao_fiscal',
      rotulo: 'NÃO FISCAL',
      detalhe: 'A venda saiu com comprovante não fiscal: não há documento fiscal a regularizar.',
      documentoStatus: null,
    };
  }
  const status = String(nota.document.status);
  if (status === 'AUTHORIZED') {
    return {
      estado: 'pendente_regularizacao',
      rotulo: 'PENDENTE DE REGULARIZAÇÃO',
      /*
        A frase dizia que o DEVORA não emite a nota de devolução — e agora emite
        (P0 fiscal, `FiscalDevolucao`): NF-e de entrada, finalidade 4,
        referenciando a NFC-e, com CFOP e tributação da operação que o contador
        confirma. Cancelar a NFC-e por uma devolução continua fora de questão.
      */
      detalhe:
        'A venda tem NFC-e autorizada. A devolução é regularizada com a NF-e de devolução (nota de '
        + 'entrada, finalidade 4, referenciando a NFC-e), emitida pela devolução com a operação fiscal '
        + 'confirmada pelo contador. A NFC-e não é cancelada por uma devolução. Estoque e reembolso '
        + 'seguem à parte.',
      documentoStatus: status,
    };
  }
  if (status === 'CANCELLED') {
    return {
      estado: 'nfce_cancelada',
      rotulo: 'NFC-E CANCELADA',
      detalhe: 'A NFC-e desta venda foi cancelada: não há o que regularizar pela devolução.',
      documentoStatus: status,
    };
  }
  if (status === 'REJECTED' || status === 'ERROR') {
    return {
      estado: 'nfce_rejeitada',
      rotulo: 'NFC-E REJEITADA',
      detalhe: 'A NFC-e desta venda não foi autorizada. Acompanhe em Fiscal; a devolução não mexe nela.',
      documentoStatus: status,
    };
  }
  return {
    estado: 'nfce_pendente',
    rotulo: 'NFC-E PENDENTE',
    detalhe:
      'A NFC-e desta venda ainda não foi autorizada (' + nota.statusLabel + '). Quando for, a devolução '
      + 'precisará ser regularizada com o contador.',
    documentoStatus: status,
  };
}

/** A venda que está sendo devolvida — o que a tela mostra antes de escolher os itens. */
export function vendaParaDevolucao(companyId: string, saleId: string): Record<string, unknown> {
  ensureCoreSchema();
  const db = getConnection();
  const venda = db
    .prepare(
      `SELECT s.id, s.number, s.created_at, s.status, s.subtotal_cents, s.discount_cents,
              s.surcharge_cents, s.total_cents, s.change_cents, s.customer_id,
              c.name AS customer_name, s.seller_id, cs.opened_by AS operator_id
         FROM core_sales s
         LEFT JOIN core_customers c ON c.id = s.customer_id AND c.company_id = s.company_id
         LEFT JOIN core_cash_sessions cs ON cs.id = s.cash_session_id AND cs.company_id = s.company_id
        WHERE s.id = ? AND s.company_id = ?`,
    )
    .get(saleId, companyId) as Record<string, unknown> | undefined;
  if (!venda) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);
  const pagamentos = db
    .prepare(
      `SELECT method, amount_cents, status FROM core_sale_payments
        WHERE sale_id = ? AND company_id = ? ORDER BY created_at`,
    )
    .all(saleId, companyId) as unknown as Record<string, unknown>[];
  return {
    ...venda,
    seller_name: nomeNaEmpresa(companyId, venda.seller_id),
    operator_name: nomeNaEmpresa(companyId, venda.operator_id),
    payments: pagamentos,
    customerCreditCents: limitesDeReembolso(companyId, saleId).valeCents,
    fiscal: estadoFiscalDaVenda(companyId, saleId),
    devolucoes: listSaleReturns(companyId, { saleId }),
  };
}

/** Quem aprovou a devolução: o gestor da liberação, ou o próprio gestor que registrou. */
export function marcarAprovacaoDaDevolucao(companyId: string, returnId: string, aprovadoPor: string): void {
  getConnection()
    .prepare(
      'UPDATE core_sale_returns SET approved_by = ? WHERE id = ? AND company_id = ? AND approved_by IS NULL',
    )
    .run(aprovadoPor, returnId, companyId);
}

function impressaoDoReembolso(pedido: { returnId: unknown; method: unknown; amountCents: unknown }): string {
  return impressaoDe({
    returnId: texto(pedido.returnId),
    method: texto(pedido.method),
    amountCents: numero(pedido.amountCents),
  });
}

/**
 * O reembolso que esta chave já registrou — ou `null` quando a chave é nova.
 * Mesma chave com outro pedido é 422. A rota chama ANTES da liberação do
 * gestor, pelo mesmo motivo de `devolucaoDaChave`.
 */
export function reembolsoDaChave(entrada: {
  companyId: string;
  idempotencyKey: unknown;
  pedido: { returnId: unknown; method: unknown; amountCents: unknown };
}): (Record<string, unknown> & { duplicated: true; refundId: string }) | null {
  const chave = chaveDaDevolucao(entrada.idempotencyKey);
  if (!chave) return null;
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT id, return_id, fingerprint FROM core_sale_return_refunds
        WHERE company_id = ? AND idempotency_key = ?`,
    )
    .get(entrada.companyId, chave) as { id: string; return_id: string; fingerprint: string } | undefined;
  if (!linha) return null;
  if (outraImpressao(linha.fingerprint, impressaoDoReembolso(entrada.pedido))) {
    throw chaveReusada('um reembolso', { refundId: linha.id, returnId: linha.return_id });
  }
  return { ...getSaleReturn(entrada.companyId, linha.return_id), refundId: linha.id, duplicated: true };
}

/** A venda da devolução — o alvo da liberação do gestor. */
export function vendaDaDevolucao(companyId: string, returnId: string): string {
  const linha = getConnection()
    .prepare('SELECT sale_id FROM core_sale_returns WHERE id = ? AND company_id = ?')
    .get(returnId, companyId) as { sale_id: string } | undefined;
  if (!linha) throw new ApiError('CORE_RETURN_NOT_FOUND', 'Devolução não encontrada.', 404);
  return linha.sale_id;
}

function textoCurto(v: unknown, max: number): string | null {
  const t = texto(v);
  return t ? t.slice(0, max) : null;
}

/**
 * REGISTRAR DEVOLUÇÃO AO CLIENTE — o que de fato voltou, em um meio.
 */
export function registrarReembolso(input: {
  companyId: string;
  userId: string;
  returnId: string;
  method: unknown;
  amountCents: unknown;
  reference?: unknown;
  note?: unknown;
  justification?: unknown;
  /** Quem pode devolver por um meio que a venda não recebeu — o gestor. */
  podeTrocarMeio: boolean;
  cashSessionId?: string | null;
  terminalId?: string | null;
  idempotencyKey: unknown;
}): Record<string, unknown> & {
  refundId: string;
  saleId: string;
  duplicated?: true;
  pedirEstornoNaMaquininha: boolean;
} {
  const chave = chaveDaDevolucao(input.idempotencyKey);
  if (!chave) {
    throw new ApiError(
      'CORE_IDEMPOTENCY_KEY_REQUIRED',
      'O registro do reembolso precisa da chave da tentativa (cabeçalho Idempotency-Key) — é ela que '
        + 'impede o mesmo reembolso duas vezes no clique duplo. Recarregue a tela e registre de novo.',
      400,
    );
  }
  const metodo = texto(input.method) as MeioDoReembolso;
  if (!MEIOS_DO_REEMBOLSO.includes(metodo)) {
    throw new ApiError(
      'CORE_REFUND_METHOD_INVALID',
      'Meio do reembolso inválido: dinheiro, PIX, estorno no débito, estorno no crédito ou crédito de loja.',
      400,
    );
  }
  const valor = Number(input.amountCents);
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new ApiError('CORE_REFUND_AMOUNT_INVALID', 'Informe o valor do reembolso, maior que zero.', 400);
  }
  const referencia = textoCurto(input.reference, 120);
  const observacao = textoCurto(input.note, 500);
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const pedido = { returnId: input.returnId, method: metodo, amountCents: valor };
    const jaRegistrado = reembolsoDaChave({ companyId: input.companyId, idempotencyKey: chave, pedido });
    if (jaRegistrado) {
      return { ...jaRegistrado, saleId: String(jaRegistrado.sale_id), pedirEstornoNaMaquininha: false };
    }

    const dev = db
      .prepare(
        `SELECT r.id, r.number, r.sale_id, r.total_cents, r.refund_flow, r.refund_method,
                s.number AS sale_number, s.customer_id
           FROM core_sale_returns r
           JOIN core_sales s ON s.id = r.sale_id
          WHERE r.id = ? AND r.company_id = ?`,
      )
      .get(input.returnId, input.companyId) as
      | {
          id: string;
          number: number;
          sale_id: string;
          total_cents: number;
          refund_flow: string | null;
          refund_method: string;
          sale_number: number;
          customer_id: string | null;
        }
      | undefined;
    if (!dev) throw new ApiError('CORE_RETURN_NOT_FOUND', 'Devolução não encontrada.', 404);
    if (dev.refund_flow !== 'duas_etapas') {
      throw new ApiError(
        'CORE_RETURN_REFUND_NOT_PENDING',
        `A devolução #${dev.number} já deu o valor por devolvido no próprio registro: não há reembolso a registrar.`,
        409,
        { returnId: dev.id },
      );
    }

    const jaReembolsado = Number(
      (
        db
          .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM core_sale_return_refunds WHERE return_id = ?')
          .get(dev.id) as { t: number }
      ).t,
    );
    const pendente = Math.max(0, dev.total_cents - jaReembolsado);
    if (pendente <= 0) {
      throw new ApiError(
        'CORE_REFUND_ALREADY_DONE',
        `O reembolso da devolução #${dev.number} já está concluído: ${emReais(jaReembolsado)} de `
          + `${emReais(dev.total_cents)}. Nada foi registrado agora.`,
        409,
        { devolvivelCents: dev.total_cents, reembolsadoCents: jaReembolsado },
      );
    }
    if (valor > pendente) {
      throw new ApiError(
        'CORE_REFUND_EXCEEDS_PENDING',
        `Este reembolso de ${emReais(valor)} passa do que falta devolver: a devolução #${dev.number} é de `
          + `${emReais(dev.total_cents)}, já foram reembolsados ${emReais(jaReembolsado)} e o saldo `
          + `pendente é ${emReais(pendente)}.`,
        409,
        { devolvivelCents: dev.total_cents, reembolsadoCents: jaReembolsado, pendenteCents: pendente, pedidoCents: valor },
      );
    }
    if (metodo === 'vale' && !dev.customer_id) {
      throw new ApiError(
        'CORE_RETURN_CREDIT_NEEDS_CUSTOMER',
        'Esta venda não tem cliente identificado, e crédito de loja precisa de dono. '
          + 'Devolva em dinheiro, PIX ou estorno no cartão.',
        409,
        { returnId: dev.id },
      );
    }

    /*
      O MEIO ORIGINAL. Devolver pelo meio em que a venda entrou, até o que
      entrou nele, é o caminho de todo dia. Outro meio — o cartão que venceu, o
      cliente que prefere PIX a dinheiro — é decisão de GESTOR, com
      justificativa, e o registro guarda o meio original e o porquê.
    */
    const rotulo = ROTULO_DO_MEIO_DO_REEMBOLSO[metodo];
    const meios = meiosDaVendaParaReembolso(input.companyId, dev.sale_id);
    const doMeio = meios.find((m) => m.method === metodo);
    const mesmoMeio = Boolean(doMeio && doMeio.disponivelCents >= valor);
    let meioOriginal: string | null = null;
    let justificativa: string | null = null;
    if (!mesmoMeio) {
      meioOriginal =
        meios
          .filter((m) => m.disponivelCents > 0)
          .map((m) => `${ROTULO_DO_MEIO_DO_REEMBOLSO[m.method]} ${emReais(m.disponivelCents)}`)
          .join(', ') || 'nada recebido';
      if (!input.podeTrocarMeio) {
        throw new ApiError(
          'CORE_REFUND_METHOD_CHANGE_NEEDS_MANAGER',
          `A venda #${dev.sale_number} não recebeu ${emReais(valor)} em ${rotulo}`
            + (doMeio ? ` (por esse meio ainda cabem ${emReais(doMeio.disponivelCents)})` : '')
            + `. Pelo meio original ainda cabem: ${meioOriginal}. Devolver por outro meio é decisão de `
            + 'gestor, com justificativa.',
          403,
          { meios },
        );
      }
      justificativa = texto(input.justification).slice(0, 500);
      if (justificativa.length < 10) {
        throw new ApiError(
          'CORE_REFUND_METHOD_JUSTIFICATION_REQUIRED',
          `Devolver em ${rotulo} quando a venda entrou por ${meioOriginal} precisa de justificativa `
            + '(ao menos 10 letras): ela fica no registro, com o seu nome.',
          400,
          { meios },
        );
      }
      const recebidoTotal = meios.reduce((s, m) => s + m.recebidoCents, 0);
      const devolvidoTotal = meios.reduce((s, m) => s + m.reembolsadoCents, 0);
      if (valor > recebidoTotal - devolvidoTotal) {
        throw new ApiError(
          'CORE_REFUND_EXCEEDS_RECEIVED',
          `A venda #${dev.sale_number} recebeu ${emReais(recebidoTotal)} e já devolveu `
            + `${emReais(devolvidoTotal)}: não cabe um reembolso de ${emReais(valor)}.`,
          409,
          { meios },
        );
      }
    }

    const refundId = randomUUID();
    const now = new Date().toISOString();
    const descricao = `Devolução ao cliente — devolução #${dev.number} da venda #${dev.sale_number} (${rotulo})`;

    // Dinheiro sai da gaveta aberta — a mesma régua da devolução e do
    // cancelamento (`GavetaDoDinheiro`). Sem gaveta aberta é recusa.
    let gaveta: string | null = null;
    if (metodo === 'dinheiro') {
      gaveta =
        gavetaDoDinheiro({
          companyId: input.companyId,
          operacao: 'devolucao',
          valorCents: valor,
          informada: input.cashSessionId ?? null,
          terminalId: input.terminalId ?? null,
          seInformadaFechada: 'procurar_a_de_agora',
        })?.sessionId ?? null;
    }

    let lancamento: string | null = null;
    if (metodo === 'vale') {
      grantCredit({
        companyId: input.companyId,
        customerId: dev.customer_id,
        amountCents: valor,
        originType: 'sale_return_refund',
        originId: refundId,
        description: descricao,
        userId: input.userId,
      });
    } else {
      lancamento = randomUUID();
      // Cada reembolso é uma PARCELA da saída da devolução: o lançamento é um
      // por (origem, direção, parcela), e o reembolso em duas vezes são duas.
      const parcela =
        Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM core_finance_entries
                  WHERE company_id = ? AND origin_type = 'sale_return' AND origin_id = ? AND direction = 'out'`,
              )
              .get(input.companyId, dev.id) as { n: number }
          ).n,
        ) + 1;
      db.prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents, settled_at,
            customer_id, description, origin_type, origin_id,
            category_id, competence_date, payment_method, installment_number, installment_total, created_at)
         VALUES (?, ?, 'out', ?, 'settled', ?, ?, ?, ?, 'sale_return', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        lancamento,
        input.companyId,
        valor,
        valor,
        now,
        dev.customer_id,
        descricao,
        dev.id,
        systemCategoryId(input.companyId, 'devolucao'),
        diaDaLoja(now),
        metodo,
        parcela,
        parcela,
        now,
      );
      inserirBaixaEspelho({
        companyId: input.companyId,
        entryId: lancamento,
        amountCents: valor,
        method: metodo,
        settledAt: now,
        userId: input.userId,
        note: referencia ? `${descricao} · ref. ${referencia}` : descricao,
      });
    }

    // Cartão com cobrança INTEGRADA na venda: o pedido de estorno à operadora
    // segue o caminho de sempre, depois do commit. Sem cobrança integrada (a
    // maquininha avulsa da Preço Justo), este registro é a confirmação do
    // estorno feito no aparelho — nada é pedido a ninguém.
    let pedirEstornoNaMaquininha = false;
    if (metodo === 'debito' || metodo === 'credito') {
      pedirEstornoNaMaquininha =
        marcarCobrancasAEstornar({
          companyId: input.companyId,
          saleId: dev.sale_id,
          saleNumber: dev.sale_number,
          userId: input.userId,
          origem: 'devolucao',
          referenciaId: refundId,
          motivo: descricao,
          valorCents: valor,
        }).length > 0;
    }

    db.prepare(
      `INSERT INTO core_sale_return_refunds
         (id, company_id, return_id, sale_id, method, amount_cents, original_method,
          method_justification, reference, note, cash_session_id, finance_entry_id,
          idempotency_key, fingerprint, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      refundId,
      input.companyId,
      dev.id,
      dev.sale_id,
      metodo,
      valor,
      meioOriginal,
      justificativa,
      referencia,
      observacao,
      gaveta,
      lancamento,
      chave,
      impressaoDoReembolso(pedido),
      input.userId,
      now,
    );

    // A saída da gaveta, VINCULADA ao reembolso — não uma sangria genérica. O
    // tipo é o da devolução (o resumo do turno já o chama "Devolução"), e o
    // valor negativo baixa o esperado do fechamento.
    if (gaveta) {
      db.prepare(
        `INSERT INTO core_cash_movements
           (id, session_id, company_id, movement_type, amount_cents, payment_method,
            reference_type, reference_id, user_id, note, created_at)
         VALUES (?, ?, ?, 'sale_return', ?, 'dinheiro', 'sale_return_refund', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        gaveta,
        input.companyId,
        -valor,
        refundId,
        input.userId,
        `DEVOLUÇÃO AO CLIENTE — devolução #${dev.number} da venda #${dev.sale_number}`,
        now,
      );
    }

    return {
      ...getSaleReturn(input.companyId, dev.id),
      refundId,
      saleId: dev.sale_id,
      pedirEstornoNaMaquininha,
    };
  });
}

/**
 * O que ainda pode ser devolvido de uma venda.
 *
 * É o que a tela precisa para não oferecer o que já voltou: sem isto, o
 * operador digitaria a quantidade cheia de novo e só descobriria o erro quando
 * o servidor recusasse.
 *
 * ## Por que as UNIDADES vêm junto
 *
 * Produto serializado passou a exigir que o operador diga QUAL peça está
 * voltando (ver `unidadesQueVoltam`). Exigir sem oferecer a lista seria pedir que
 * ele adivinhasse um UUID: a tela precisa mostrar chassi e número de série das
 * peças daquela venda para que a escolha seja bipar o número que está na moto.
 *
 * A lista traz só o que ainda está `sold` — peça já devolvida não pode voltar de
 * novo, e oferecê-la seria oferecer a recusa.
 */
export function returnableItems(companyId: string, saleId: string): Record<string, unknown>[] {
  ensureCoreSchema();
  const db = getConnection();
  const sale = db
    .prepare('SELECT id FROM core_sales WHERE id = ? AND company_id = ?')
    .get(saleId, companyId) as { id: string } | undefined;
  if (!sale) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);

  const itens = db
    .prepare(
      `SELECT si.id AS sale_item_id, si.product_id, si.description, si.quantity,
              si.unit_price_cents, si.total_cents,
              COALESCE((SELECT SUM(ri.quantity) FROM core_sale_return_items ri
                         WHERE ri.sale_item_id = si.id), 0) AS returned_quantity,
              COALESCE((SELECT SUM(ri.total_cents) FROM core_sale_return_items ri
                         WHERE ri.sale_item_id = si.id), 0) AS returned_cents
         FROM core_sale_items si
        WHERE si.sale_id = ?
        ORDER BY si.description`,
    )
    .all(saleId) as unknown as Record<string, unknown>[];

  // Uma leitura só das unidades da venda inteira, e não uma por linha: a venda de
  // três motos faria três varreduras iguais para filtrar a mesma tabela.
  const unidadesDaVenda = unitsByExitReference(companyId, 'sale', saleId).filter(
    (u) => u.status === 'sold',
  );

  // O líquido de cada linha com o desconto do rodapé rateado (GAP-PRD-009): é
  // dele — e do que já voltou em dinheiro — que a tela tira o "A devolver",
  // pela mesma conta do servidor (`valorDaParcelaDevolvida`).
  const liquidos = liquidoDasLinhas(saleId);

  return itens.map((item) => {
    const productId = item.product_id ? String(item.product_id) : null;
    const serializado = productId ? isSerialized(companyId, productId) : false;
    return {
      ...item,
      net_total_cents: liquidos.get(String(item.sale_item_id)) ?? Number(item.total_cents),
      serialized: serializado ? 1 : 0,
      // As peças são da VENDA e do produto, não da linha: `core_product_units`
      // não guarda de qual item de venda a peça saiu. Duas linhas do mesmo
      // produto oferecem a mesma lista, e o servidor recusa a peça escolhida
      // duas vezes.
      units: serializado
        ? unidadesDaVenda
            .filter((u) => u.product_id === productId)
            .map((u) => ({
              id: u.id,
              serial_number: u.serial_number,
              chassis: u.chassis,
              motor_number: u.motor_number,
              imei: u.imei,
              plate: u.plate,
            }))
        : [],
    };
  });
}
