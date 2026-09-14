/**
 * ============================================================================
 * A MOTO DA PRÉ-VENDA — qual unidade o documento segura e qual sai na conversão
 * (GAP-PRD-025, GAP-PRD-111)
 * ============================================================================
 *
 * ## Os dois defeitos, e por que moram juntos
 *
 * GAP-PRD-025. `convertQuote` mandava os itens a `createSale` sem `unitIds`, e o
 * funil do estoque recusa toda saída de produto controlado por unidade sem dizer
 * QUAL peça sai (`CORE_UNITS_REQUIRED`). Pré-venda de moto nunca faturava: o
 * sinal ficava preso numa reserva que só se soltava cancelando o documento.
 *
 * GAP-PRD-111. A reserva da pré-venda é por QUANTIDADE (`core_stock.reserved`).
 * A concessionária promete AQUELA moto — a vermelha, o chassi que o cliente viu
 * no pátio — e nada no sistema dizia isso: o pedido online capturado escolhia a
 * mais antiga por FIFO, o caixa ao lado bipava a mesma, e "a moto vermelha era
 * minha" virava discussão de balcão.
 *
 * As duas perguntas são a mesma — "qual unidade é deste documento?" — e por
 * isso a resposta mora num lugar só.
 *
 * ## O desenho
 *
 *   - A pré-venda PODE segurar unidades específicas (`core_product_unit_holds`).
 *     Não é obrigatório: quem não escolhe continua com a reserva por quantidade
 *     de sempre, e a conversão escolhe por FIFO à vista.
 *   - A reserva só vale enquanto o documento está ABERTO e dentro da validade.
 *     Quem lê junta com `core_quotes` (ver `sqlReservadaPorOutro`), então a
 *     pré-venda vencida solta a moto no mesmo instante, sem varredura.
 *   - Segurada, a unidade some do FIFO de quem não é o documento (pedido online,
 *     peça de OS) e é RECUSADA na venda de balcão (`exigirUnidadesLivres`), com
 *     o número da pré-venda e o nome do cliente na mensagem.
 *   - Na conversão: o chassi bipado manda; sem bipe, as seguradas; faltando,
 *     FIFO entre as livres.
 *
 * ## O que NÃO muda, e fica dito
 *
 * A moto que está na bancada e sai vendida pela loja online continua saindo com
 * evento `sold_in_workshop` em vez de recusa — é a decisão documentada em
 * `EquipmentStockLink.ts` (o webhook roda depois de o dinheiro ser capturado).
 * A reserva por unidade não mexe nisso: ela só tira a moto SEGURADA do FIFO.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { isSerialized, pickUnitsFifo } from './ProductUnitService.js';

export interface ReservaDaUnidade {
  unitId: string;
  productId: string;
  quoteId: string;
  quoteNumber: number;
  customerName: string | null;
  validUntil: string | null;
  /** Chassi, IMEI, série, motor ou placa — o que houver, para o balcão conferir. */
  rotulo: string;
}

/** O que o caixa bipou na conversão, por produto. */
export interface UnidadesPedidas {
  productId: string;
  unitIds: string[];
}

const agora = () => new Date().toISOString();

/** "Viva" = aberta e dentro da validade. A mesma régua de `sqlReservadaPorOutro`. */
const SQL_DOCUMENTO_VIVO = `q.status = 'aberto' AND (q.valid_until IS NULL OR q.valid_until >= ?)`;

interface LinhaDeReserva {
  unit_id: string;
  product_id: string;
  quote_id: string;
  quote_number: number;
  customer_name: string | null;
  valid_until: string | null;
  chassis: string | null;
  imei: string | null;
  serial_number: string | null;
  motor_number: string | null;
  plate: string | null;
  unit_status: string;
  created_at: string;
}

const SELECT_RESERVA = `
  SELECT h.unit_id, h.product_id, q.id AS quote_id, q.number AS quote_number,
         c.name AS customer_name, q.valid_until,
         u.chassis, u.imei, u.serial_number, u.motor_number, u.plate,
         u.status AS unit_status, h.created_at
    FROM core_product_unit_holds h
    JOIN core_quotes q ON q.id = h.reference_id AND q.company_id = h.company_id
    JOIN core_product_units u ON u.id = h.unit_id AND u.company_id = h.company_id
    LEFT JOIN core_customers c ON c.id = q.customer_id`;

function rotuloDaUnidade(l: {
  chassis: string | null;
  imei: string | null;
  serial_number: string | null;
  motor_number: string | null;
  plate: string | null;
}): string {
  return l.chassis ?? l.imei ?? l.serial_number ?? l.motor_number ?? l.plate ?? 'sem identidade';
}

function paraReserva(l: LinhaDeReserva): ReservaDaUnidade {
  return {
    unitId: l.unit_id,
    productId: l.product_id,
    quoteId: l.quote_id,
    quoteNumber: Number(l.quote_number),
    customerName: l.customer_name,
    validUntil: l.valid_until,
    rotulo: rotuloDaUnidade(l),
  };
}

/** A data como o balcão fala: 15/09. */
function diaEMes(iso: string | null): string {
  if (!iso) return 'sem prazo';
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * As reservas VIVAS destas unidades, por unidade. É o que a lista de unidades
 * mostra ao lado do chassi e o que o PDV lê para não escolher a moto de outro.
 */
export function reservasAtivas(companyId: string, unitIds: string[]): Map<string, ReservaDaUnidade> {
  ensureCoreSchema();
  const mapa = new Map<string, ReservaDaUnidade>();
  if (unitIds.length === 0) return mapa;
  const marcas = unitIds.map(() => '?').join(', ');
  const linhas = getConnection()
    .prepare(
      `${SELECT_RESERVA}
        WHERE h.company_id = ? AND h.reference_type = 'pre_venda'
          AND h.unit_id IN (${marcas}) AND ${SQL_DOCUMENTO_VIVO}`,
    )
    .all(...([companyId, ...unitIds, agora()] as never[])) as unknown as LinhaDeReserva[];
  for (const l of linhas) mapa.set(l.unit_id, paraReserva(l));
  return mapa;
}

/**
 * As unidades que ESTE documento segura e que ainda estão no pátio, na ordem em
 * que foram seguradas. A validade não entra aqui: quem pergunta é o próprio
 * documento, e as recusas de documento vencido já moram em quem o converte.
 */
export function reservasDoDocumento(companyId: string, quoteId: string): ReservaDaUnidade[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `${SELECT_RESERVA}
        WHERE h.company_id = ? AND h.reference_type = 'pre_venda' AND h.reference_id = ?
          AND u.status = 'in_stock'
        ORDER BY h.created_at, h.rowid`,
    )
    .all(companyId, quoteId) as unknown as LinhaDeReserva[];
  return linhas.map(paraReserva);
}

/**
 * Quanto de cada produto o documento leva. Duas linhas do mesmo produto somam:
 * a moto não sabe em qual linha do papel foi escrita.
 */
function quantidadesDoDocumento(quoteId: string): Map<string, number> {
  const linhas = getConnection()
    .prepare(
      `SELECT product_id, SUM(quantity) AS quantidade
         FROM core_quote_items WHERE quote_id = ? AND product_id IS NOT NULL
        GROUP BY product_id`,
    )
    .all(quoteId) as unknown as { product_id: string; quantidade: number }[];
  return new Map(linhas.map((l) => [l.product_id, Number(l.quantidade)]));
}

/**
 * A recusa com o nome da pré-venda que segura a moto. Mensagem que diz "está
 * reservada" sem dizer para quem manda o operador procurar documento por
 * documento; esta diz o número, o cliente e até quando.
 */
function recusaDeReservada(r: ReservaDaUnidade): ApiError {
  return new ApiError(
    'CORE_UNIT_HELD',
    `A unidade ${r.rotulo} está reservada para a pré-venda #${r.quoteNumber}` +
      `${r.customerName ? ` de ${r.customerName}` : ''} até ${diaEMes(r.validUntil)}. ` +
      'Fature pela pré-venda (F9 no PDV) ou solte a reserva no documento antes de vender esta moto.',
    409,
    { unitId: r.unitId, quoteId: r.quoteId, quoteNumber: r.quoteNumber },
  );
}

/**
 * A venda de balcão não leva moto segurada por pré-venda viva.
 *
 * Chamada pelo funil do estoque só na VENDA (`sale`): a conversão da própria
 * pré-venda solta as reservas dela ANTES de criar a venda, então o que sobra
 * aqui é sempre de outro documento. Baixa e transferência não passam por aqui —
 * a moto roubada precisa poder sair do estoque, e a que muda de prateleira nem
 * sai.
 */
export function exigirUnidadesLivres(companyId: string, unitIds: string[]): void {
  const reservas = reservasAtivas(companyId, unitIds);
  for (const id of unitIds) {
    const r = reservas.get(id);
    if (r) throw recusaDeReservada(r);
  }
}

/**
 * O que veio no corpo, conferido na FORMA. O conteúdo (é deste documento? é
 * desta empresa? está no pátio?) é conferido por quem usa.
 */
export function lerUnidadesPedidas(valor: unknown): UnidadesPedidas[] | undefined {
  if (valor === undefined || valor === null) return undefined;
  const invalido = () =>
    new ApiError(
      'CORE_QUOTE_UNITS_INVALID',
      'Informe as unidades como uma lista de { productId, unitIds }.',
      400,
    );
  if (!Array.isArray(valor)) throw invalido();
  return valor.map((v) => {
    const item = v as { productId?: unknown; unitIds?: unknown };
    if (typeof item?.productId !== 'string' || !Array.isArray(item.unitIds)) throw invalido();
    if (!item.unitIds.every((u) => typeof u === 'string' && u.trim() !== '')) throw invalido();
    return { productId: item.productId, unitIds: item.unitIds.map(String) };
  });
}

/**
 * QUAIS unidades saem na conversão, por produto — GAP-PRD-025.
 *
 * A ordem de quem manda:
 *   1. o chassi que o caixa BIPOU na conversão (tem de ser exatamente a
 *      quantidade do documento, senão a linha mentiria sobre qual moto saiu);
 *   2. as unidades que a pré-venda SEGURA (a moto prometida ao cliente);
 *   3. o que faltar, por FIFO à vista entre as LIVRES — o mesmo critério de
 *      `consumeReservation`, e nunca a moto segurada para outro cliente.
 *
 * Não confere status nem dono das unidades bipadas: quem faz isso é o funil do
 * estoque, dentro da mesma transação da venda (`assertUnitsSellable` e
 * `exigirUnidadesLivres`), e uma segunda conferência aqui divergiria dela.
 */
export function resolverUnidadesDaConversao(input: {
  companyId: string;
  quoteId: string;
  pedidas?: UnidadesPedidas[];
}): Map<string, string[]> {
  ensureCoreSchema();
  const quantidades = quantidadesDoDocumento(input.quoteId);
  const pedidasPorProduto = new Map<string, string[]>();

  for (const p of input.pedidas ?? []) {
    if (!quantidades.has(p.productId)) {
      throw new ApiError(
        'CORE_QUOTE_UNITS_WRONG_PRODUCT',
        'Uma das unidades informadas é de um produto que não está neste documento.',
        400,
        { productId: p.productId },
      );
    }
    if (!isSerialized(input.companyId, p.productId)) {
      throw new ApiError(
        'CORE_UNITS_NOT_APPLICABLE',
        'Este produto não é controlado por unidade.',
        400,
        { productId: p.productId },
      );
    }
    pedidasPorProduto.set(p.productId, [...(pedidasPorProduto.get(p.productId) ?? []), ...p.unitIds]);
  }

  const seguradas = reservasDoDocumento(input.companyId, input.quoteId);
  const resultado = new Map<string, string[]>();

  for (const [productId, quantidade] of quantidades) {
    if (!isSerialized(input.companyId, productId)) continue;

    const pedidas = pedidasPorProduto.get(productId);
    if (pedidas) {
      if (pedidas.length !== quantidade) {
        throw new ApiError(
          'CORE_UNITS_REQUIRED',
          `O documento leva ${quantidade} unidade(s) deste produto: bipe exatamente ${quantidade} ` +
            `chassi(s). Vieram ${pedidas.length}.`,
          400,
          { productId, esperado: quantidade, recebido: pedidas.length },
        );
      }
      resultado.set(productId, pedidas);
      continue;
    }

    const doDocumento = seguradas
      .filter((r) => r.productId === productId)
      .map((r) => r.unitId)
      .slice(0, quantidade);
    const faltam = quantidade - doDocumento.length;
    const completar =
      faltam > 0
        ? pickUnitsFifo(input.companyId, productId, faltam, undefined, {
            documento: input.quoteId,
            excetoIds: doDocumento,
          })
        : [];
    resultado.set(productId, [...doDocumento, ...completar]);
  }
  return resultado;
}

/** O documento deixou de segurar moto: converteu, cancelou ou venceu. */
export function soltarReservasDoDocumento(companyId: string, quoteId: string): number {
  ensureCoreSchema();
  const r = getConnection()
    .prepare(
      `DELETE FROM core_product_unit_holds
        WHERE company_id = ? AND reference_type = 'pre_venda' AND reference_id = ?`,
    )
    .run(companyId, quoteId);
  return Number(r.changes ?? 0);
}

/**
 * A EDIÇÃO QUE ENCOLHEU O DOCUMENTO não deixa moto segurada à toa.
 *
 * Produto que saiu do documento solta todas; produto que caiu de quantidade
 * solta as seguradas por último. Sem isto a moto ficaria presa por um documento
 * que já não a leva — some do FIFO e ninguém sabe por quê.
 */
export function aparaReservasDoDocumento(companyId: string, quoteId: string): void {
  ensureCoreSchema();
  const db = getConnection();
  const quantidades = quantidadesDoDocumento(quoteId);
  const linhas = db
    .prepare(
      `SELECT id, product_id FROM core_product_unit_holds
        WHERE company_id = ? AND reference_type = 'pre_venda' AND reference_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(companyId, quoteId) as unknown as { id: string; product_id: string }[];
  const contagem = new Map<string, number>();
  const apagar = db.prepare('DELETE FROM core_product_unit_holds WHERE id = ?');
  for (const l of linhas) {
    const ja = (contagem.get(l.product_id) ?? 0) + 1;
    contagem.set(l.product_id, ja);
    if (ja > (quantidades.get(l.product_id) ?? 0)) apagar.run(l.id);
  }
}

/**
 * Segura AQUELAS unidades para a pré-venda — GAP-PRD-111.
 *
 * Substitui o que o documento segurava deste produto: escolher de novo é trocar
 * a moto, não acrescentar. Lista vazia solta tudo do produto (o cliente aceitou
 * qualquer uma).
 *
 * As recusas, e por quê:
 *   - só PRÉ-VENDA segura: orçamento é papel e não tira nada de ninguém;
 *   - documento aberto e dentro da validade — a reserva nasceria morta;
 *   - o produto tem de estar no documento, ser controlado por unidade, e não se
 *     segura mais motos do que o documento leva;
 *   - a unidade tem de ser desta empresa, deste produto, estar no pátio e não
 *     estar segurada por OUTRA pré-venda viva (a mensagem diz qual).
 */
export function reservarUnidadesDaPreVenda(input: {
  companyId: string;
  quoteId: string;
  productId: string;
  unitIds: string[];
  userId: string;
}): ReservaDaUnidade[] {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const quote = db
      .prepare('SELECT id, kind, status, valid_until, number FROM core_quotes WHERE id = ? AND company_id = ?')
      .get(input.quoteId, input.companyId) as
      | { id: string; kind: string; status: string; valid_until: string | null; number: number }
      | undefined;
    if (!quote) throw new ApiError('CORE_QUOTE_NOT_FOUND', 'Documento não encontrado.', 404);
    if (quote.kind !== 'pre_venda') {
      throw new ApiError(
        'CORE_QUOTE_UNITS_ONLY_PRE_SALE',
        'Orçamento não segura mercadoria. Aprove como pré-venda para reservar o chassi do cliente.',
        409,
      );
    }
    if (quote.status !== 'aberto') {
      throw new ApiError(
        'CORE_QUOTE_NOT_OPEN',
        `Documento ${quote.status} não segura moto.`,
        409,
        { status: quote.status },
      );
    }
    if (quote.valid_until && new Date(quote.valid_until).getTime() < Date.now()) {
      throw new ApiError(
        'CORE_QUOTE_EXPIRED',
        'Documento vencido. Renove a validade antes de reservar o chassi.',
        409,
        { validUntil: quote.valid_until },
      );
    }

    const quantidade = quantidadesDoDocumento(input.quoteId).get(input.productId) ?? 0;
    if (quantidade === 0) {
      throw new ApiError(
        'CORE_QUOTE_UNITS_WRONG_PRODUCT',
        'Este produto não está nesta pré-venda.',
        400,
        { productId: input.productId },
      );
    }
    if (!isSerialized(input.companyId, input.productId)) {
      throw new ApiError('CORE_UNITS_NOT_APPLICABLE', 'Este produto não é controlado por unidade.', 400);
    }

    const ids = input.unitIds.map((u) => String(u).trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      throw new ApiError('CORE_UNIT_REPEATED', 'A mesma unidade foi informada duas vezes.', 400);
    }
    if (ids.length > quantidade) {
      throw new ApiError(
        'CORE_QUOTE_UNITS_TOO_MANY',
        `A pré-venda leva ${quantidade} unidade(s) deste produto: não dá para segurar ${ids.length}.`,
        400,
        { esperado: quantidade, recebido: ids.length },
      );
    }

    const outras = reservasAtivas(input.companyId, ids);
    for (const id of ids) {
      const u = db
        .prepare('SELECT id, product_id, status FROM core_product_units WHERE id = ? AND company_id = ?')
        .get(id, input.companyId) as { id: string; product_id: string; status: string } | undefined;
      if (!u) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
      if (u.product_id !== input.productId) {
        throw new ApiError('CORE_UNIT_WRONG_PRODUCT', 'Esta unidade pertence a outro produto.', 409);
      }
      if (u.status !== 'in_stock') {
        throw new ApiError(
          'CORE_UNIT_NOT_AVAILABLE',
          u.status === 'sold' ? 'Esta unidade já foi vendida.' : 'Esta unidade recebeu baixa e não está em estoque.',
          409,
        );
      }
      const r = outras.get(id);
      if (r && r.quoteId !== input.quoteId) throw recusaDeReservada(r);
    }

    // Troca do que ESTE documento segurava deste produto…
    db.prepare(
      `DELETE FROM core_product_unit_holds
        WHERE company_id = ? AND reference_type = 'pre_venda' AND reference_id = ? AND product_id = ?`,
    ).run(input.companyId, input.quoteId, input.productId);
    // …e a reserva MORTA (documento vencido, cancelado, convertido) que ainda
    // aponta para estas unidades sai junto: `unit_id` é único, e a viva já foi
    // recusada acima.
    const apagarMorta = db.prepare('DELETE FROM core_product_unit_holds WHERE unit_id = ? AND company_id = ?');
    const inserir = db.prepare(
      `INSERT INTO core_product_unit_holds
         (id, company_id, unit_id, product_id, reference_type, reference_id, created_by, created_at)
       VALUES (?, ?, ?, ?, 'pre_venda', ?, ?, ?)`,
    );
    const ts = agora();
    for (const id of ids) {
      apagarMorta.run(id, input.companyId);
      inserir.run(randomUUID(), input.companyId, id, input.productId, input.quoteId, input.userId, ts);
    }

    return reservasDoDocumento(input.companyId, input.quoteId);
  });
}
