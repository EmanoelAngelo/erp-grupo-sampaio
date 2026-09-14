/**
 * O pacote de um pedido, para cotar frete.
 *
 * EXISTE POR CAUSA DE UM DEFAULT SILENCIOSO. `backendLogisticsQuote` assumia
 * `weightGrams ?? 500`, `heightCm ?? 10`, `widthCm ?? 15`, `lengthCm ?? 20`.
 * Quer dizer: sem nenhum dado cadastrado, o sistema cotava uma caixa
 * imaginária de meio quilo e mostrava um preço ao cliente. O transportador
 * cobra pelo pacote REAL — a diferença aparece depois, com a mercadoria já
 * vendida, e quem paga é a operação.
 *
 * A regra aqui é simples: ou os dados existem, ou não se cota. `SHIPPING_DATA_
 * REQUIRED` diz exatamente quais produtos estão sem o quê, para o gestor
 * resolver em vez de adivinhar.
 *
 * O cálculo do volume é o do mercado: soma o peso, empilha as alturas e toma a
 * maior largura e o maior comprimento. Não é exato para qualquer arrumação de
 * caixa, mas é PREVISÍVEL e nunca subestima — subestimar é que gera cobrança
 * extra na entrega.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface ShippingPackage {
  weightGrams: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  declaredValueInCents: number;
}

export interface MissingShippingData {
  productId: string;
  productName: string;
  missing: string[];
}

export type OrderPackageResult =
  | { ok: true; package: ShippingPackage }
  | { ok: false; code: 'SHIPPING_DATA_REQUIRED'; missing: MissingShippingData[] };

interface ItemRow {
  product_id: string;
  description: string;
  quantity: number;
  total_cents: number;
  weight_grams: number | null;
  height_cm: number | null;
  width_cm: number | null;
  length_cm: number | null;
}

const CAMPOS: { coluna: keyof ItemRow; rotulo: string }[] = [
  { coluna: 'weight_grams', rotulo: 'peso' },
  { coluna: 'height_cm', rotulo: 'altura' },
  { coluna: 'width_cm', rotulo: 'largura' },
  { coluna: 'length_cm', rotulo: 'comprimento' },
];

/**
 * Monta o pacote do pedido, ou diz o que falta.
 *
 * Nunca lança por falta de dado: falta de cadastro é resposta, não exceção —
 * o checkout precisa exibir a lista, não uma tela de erro.
 */
export function buildOrderPackage(input: {
  companyId: string;
  orderId: string;
}): OrderPackageResult {
  ensureCoreSchema();
  const db = getConnection();

  const pedido = db
    .prepare('SELECT id FROM core_orders WHERE id = ? AND company_id = ?')
    .get(input.orderId, input.companyId) as { id: string } | undefined;
  if (!pedido) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);

  const itens = db
    .prepare(
      `SELECT i.product_id, i.description, i.quantity, i.total_cents,
              p.weight_grams, p.height_cm, p.width_cm, p.length_cm
         FROM core_order_items i
         JOIN core_products p ON p.id = i.product_id
        WHERE i.order_id = ?`,
    )
    .all(input.orderId) as unknown as ItemRow[];

  if (itens.length === 0) {
    throw new ApiError('CORE_ORDER_EMPTY', 'Pedido sem itens.', 409);
  }

  return empacotar(itens);
}

/**
 * A conta do volume, a partir das linhas já lidas.
 *
 * Separada porque o carrinho precisa da MESMA conta antes do pedido existir —
 * cotar no checkout por uma regra e no pedido por outra é como cobrar um frete
 * e pagar outro.
 */
function empacotar(itens: ItemRow[]): OrderPackageResult {
  const faltando: MissingShippingData[] = [];
  for (const item of itens) {
    const ausentes = CAMPOS.filter((c) => {
      const valor = item[c.coluna];
      return valor === null || valor === undefined || Number(valor) <= 0;
    }).map((c) => c.rotulo);
    if (ausentes.length > 0) {
      faltando.push({
        productId: item.product_id,
        productName: item.description,
        missing: ausentes,
      });
    }
  }

  if (faltando.length > 0) {
    return { ok: false, code: 'SHIPPING_DATA_REQUIRED', missing: faltando };
  }

  let peso = 0;
  let altura = 0;
  let largura = 0;
  let comprimento = 0;
  let valor = 0;

  for (const item of itens) {
    peso += Number(item.weight_grams) * item.quantity;
    // Empilhados: a altura soma, a base é a maior.
    altura += Number(item.height_cm) * item.quantity;
    largura = Math.max(largura, Number(item.width_cm));
    comprimento = Math.max(comprimento, Number(item.length_cm));
    valor += item.total_cents;
  }

  return {
    ok: true,
    package: {
      weightGrams: Math.round(peso),
      heightCm: Number(altura.toFixed(2)),
      widthCm: Number(largura.toFixed(2)),
      lengthCm: Number(comprimento.toFixed(2)),
      // O valor declarado é o do conteúdo. Errar aqui muda o seguro e o
      // ressarcimento em caso de extravio.
      declaredValueInCents: valor,
    },
  };
}

/**
 * O pacote de um CARRINHO — antes de existir pedido.
 *
 * Produto que não está publicado na loja simplesmente não entra na conta: o
 * checkout já o recusa em seguida, e cotar frete de item que não vai ser
 * vendido só produziria um número errado.
 */
export function buildOrderPackageFromItems(input: {
  companyId: string;
  items: { productId: string; quantity: number }[];
}): OrderPackageResult {
  ensureCoreSchema();
  if (input.items.length === 0) {
    throw new ApiError('CORE_ORDER_EMPTY', 'Carrinho sem itens.', 409);
  }
  const db = getConnection();
  const stmt = db.prepare(
    `SELECT id, name, price_cents, weight_grams, height_cm, width_cm, length_cm
       FROM core_products
      WHERE id = ? AND company_id = ? AND active = 1 AND publish_online = 1`,
  );

  const itens: ItemRow[] = [];
  for (const item of input.items) {
    const p = stmt.get(item.productId, input.companyId) as
      | {
        id: string;
        name: string;
        price_cents: number;
        weight_grams: number | null;
        height_cm: number | null;
        width_cm: number | null;
        length_cm: number | null;
      }
      | undefined;
    if (!p) continue;
    itens.push({
      product_id: p.id,
      description: p.name,
      quantity: item.quantity,
      total_cents: p.price_cents * item.quantity,
      weight_grams: p.weight_grams,
      height_cm: p.height_cm,
      width_cm: p.width_cm,
      length_cm: p.length_cm,
    });
  }

  if (itens.length === 0) {
    throw new ApiError('CORE_ORDER_EMPTY', 'Nenhum item do carrinho é vendável nesta loja.', 409);
  }
  return empacotar(itens);
}

/** O CEP de onde a encomenda sai. Sem ele não há cotação possível. */
export function resolveOriginZip(companyId: string): string | null {
  ensureCoreSchema();
  const config = getConnection()
    .prepare('SELECT zip FROM core_fiscal_configs WHERE company_id = ?')
    .get(companyId) as { zip: string | null } | undefined;
  return normalizeZip(config?.zip);
}

/** CEP com ou sem hífen vira oito dígitos. Fora disso, não é CEP. */
export function normalizeZip(bruto: string | null | undefined): string | null {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  return digitos.length === 8 ? digitos : null;
}

export type ProductQuoteResult =
  | { ok: false; code: 'SHIPPING_DATA_REQUIRED'; missing: string[] }
  | { ok: false; code: 'INVALID_ZIP'; missing: string[] }
  | { ok: false; code: 'ORIGIN_NOT_CONFIGURED'; missing: string[] }
  | { ok: true; package: ShippingPackage; originZip: string; destinationZip: string };

/**
 * Prepara a simulação de frete de UM produto, para a página pública.
 *
 * É estimativa: o frete que vale é o do checkout, sobre o carrinho fechado.
 * Aqui só se responde "quanto custaria mandar este item para este CEP".
 *
 * Nada é chamado no provedor antes de tudo existir — CEP de origem, CEP de
 * destino e as quatro medidas. Faltando qualquer um, a resposta diz o que
 * falta em vez de inventar uma caixa.
 */
export function prepareProductQuote(input: {
  companyId: string;
  productId: string;
  destinationZip: string;
}): ProductQuoteResult {
  ensureCoreSchema();
  const db = getConnection();

  const destino = normalizeZip(input.destinationZip);
  if (!destino) {
    return { ok: false, code: 'INVALID_ZIP', missing: ['CEP de destino'] };
  }

  const config = db
    .prepare('SELECT zip FROM core_fiscal_configs WHERE company_id = ?')
    .get(input.companyId) as { zip: string | null } | undefined;
  const origem = normalizeZip(config?.zip);
  if (!origem) {
    // Sem endereço da operação não há de onde sair a encomenda. É pendência de
    // cadastro do gestor, não erro do cliente.
    return { ok: false, code: 'ORIGIN_NOT_CONFIGURED', missing: ['CEP de origem da loja'] };
  }

  const produto = db
    .prepare(
      `SELECT id, name, price_cents, weight_grams, height_cm, width_cm, length_cm
         FROM core_products
        WHERE id = ? AND company_id = ? AND active = 1 AND publish_online = 1`,
    )
    .get(input.productId, input.companyId) as
    | {
      id: string;
      name: string;
      price_cents: number;
      weight_grams: number | null;
      height_cm: number | null;
      width_cm: number | null;
      length_cm: number | null;
    }
    | undefined;
  if (!produto) {
    throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
  }

  const faltando = CAMPOS.filter((c) => {
    const valor = (produto as unknown as Record<string, number | null>)[c.coluna as string];
    return valor === null || valor === undefined || Number(valor) <= 0;
  }).map((c) => c.rotulo);

  if (faltando.length > 0) {
    return { ok: false, code: 'SHIPPING_DATA_REQUIRED', missing: faltando };
  }

  return {
    ok: true,
    originZip: origem,
    destinationZip: destino,
    package: {
      weightGrams: Number(produto.weight_grams),
      heightCm: Number(produto.height_cm),
      widthCm: Number(produto.width_cm),
      lengthCm: Number(produto.length_cm),
      declaredValueInCents: produto.price_cents,
    },
  };
}

/**
 * Produtos publicados online sem dados de envio.
 *
 * É a lista de trabalho do gestor: enquanto ela não zerar, esses produtos não
 * podem ser vendidos com entrega — só com retirada.
 */
export function listProductsMissingShippingData(companyId: string): MissingShippingData[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT id AS product_id, name AS description, 1 AS quantity, 0 AS total_cents,
              weight_grams, height_cm, width_cm, length_cm
         FROM core_products
        WHERE company_id = ? AND active = 1 AND publish_online = 1
        ORDER BY name`,
    )
    .all(companyId) as unknown as ItemRow[];

  const faltando: MissingShippingData[] = [];
  for (const linha of linhas) {
    const ausentes = CAMPOS.filter((c) => {
      const valor = linha[c.coluna];
      return valor === null || valor === undefined || Number(valor) <= 0;
    }).map((c) => c.rotulo);
    if (ausentes.length > 0) {
      faltando.push({
        productId: linha.product_id,
        productName: linha.description,
        missing: ausentes,
      });
    }
  }
  return faltando;
}
