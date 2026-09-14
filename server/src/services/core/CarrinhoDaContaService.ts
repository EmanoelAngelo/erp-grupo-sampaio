/**
 * O CARRINHO DA CONTA — no servidor, por conta, com fusão no login
 * (GAP-PRD-193).
 *
 * O carrinho vivia só no `localStorage` do navegador: trocar de aparelho
 * perdia o carrinho, e entrar na conta não trazia o que a pessoa montou no
 * outro. Com a conta obrigatória para comprar (GAP-PRD-028, padrão da loja),
 * o carrinho de quem entrou passa a morar NA CONTA:
 *
 *   - guarda-se só produto e quantidade. Preço, nome, foto e disponível são
 *     lidos da vitrine NA HORA de mostrar — o carrinho nunca congela preço
 *     (a lição do `carrinho-congelado-descongela`);
 *   - FUNDIR no login: o que o aparelho montou antes de entrar se junta ao
 *     que a conta já tinha. Mesmo produto nos dois = a MAIOR quantidade, não
 *     a soma — o mesmo carrinho sincronizado duas vezes não pode dobrar;
 *   - o que saiu da vitrine (despublicado, virou peça de bancada, modelo de
 *     grade sem tamanho) não entra e volta em `descartados`, para a tela
 *     dizer por que sumiu;
 *   - fechar o pedido tira da conta o que foi comprado.
 *
 * Quem compra sem conta (loja aberta para visitante, decisão do dono)
 * continua com o carrinho do navegador — não há conta onde guardá-lo.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  getStorefrontProduct,
  PRODUTO_VISIVEL_NA_LOJA,
  type StorefrontProduct,
} from './StorefrontService.js';

/** Teto de linhas e de quantidade — carrinho não é depósito. */
export const MAX_LINHAS_DO_CARRINHO = 60;
export const MAX_QUANTIDADE_POR_ITEM = 99;

export interface ItemDoCarrinho {
  productId: string;
  quantity: number;
}

export interface CarrinhoDaConta {
  items: { productId: string; quantity: number; product: StorefrontProduct }[];
  /** O que não pôde ficar, e por quê — a tela diz ao cliente. */
  descartados: { productId: string; motivo: 'indisponivel' | 'escolha_o_tamanho' }[];
  updatedAt: string | null;
}

/** Normaliza o que veio do navegador: ids de texto, quantidades inteiras. */
function normalizar(bruto: unknown): ItemDoCarrinho[] {
  if (!Array.isArray(bruto)) {
    throw new ApiError('PORTAL_CARRINHO_INVALIDO', 'Envie os itens do carrinho como lista.', 400);
  }
  const porProduto = new Map<string, number>();
  for (const item of bruto) {
    const productId = String((item as { productId?: unknown })?.productId ?? '').trim();
    const quantidade = Math.floor(Number((item as { quantity?: unknown })?.quantity));
    if (!productId || productId.length > 100) continue;
    if (!Number.isFinite(quantidade) || quantidade <= 0) continue;
    // O mesmo produto duas vezes na lista vira uma linha só, com a maior.
    porProduto.set(productId, Math.max(porProduto.get(productId) ?? 0, quantidade));
  }
  if (porProduto.size > MAX_LINHAS_DO_CARRINHO) {
    throw new ApiError(
      'PORTAL_CARRINHO_GRANDE',
      `O carrinho pode ter até ${MAX_LINHAS_DO_CARRINHO} produtos diferentes.`,
      400,
    );
  }
  return [...porProduto].map(([productId, quantity]) => ({
    productId,
    quantity: Math.min(quantity, MAX_QUANTIDADE_POR_ITEM),
  }));
}

/** O produto pode estar num carrinho? Visível na loja e sem grade a escolher. */
function situacao(productId: string): 'ok' | 'indisponivel' | 'escolha_o_tamanho' {
  const linha = getConnection()
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
         FROM core_products p
        WHERE p.id = ? AND ${PRODUTO_VISIVEL_NA_LOJA}`,
    )
    .get(productId) as { tem_grade: number } | undefined;
  if (!linha) return 'indisponivel';
  return Number(linha.tem_grade) ? 'escolha_o_tamanho' : 'ok';
}

function gravar(accountId: string, itens: ItemDoCarrinho[]): CarrinhoDaConta['descartados'] {
  const descartados: CarrinhoDaConta['descartados'] = [];
  const agora = new Date().toISOString();
  const db = getConnection();
  const inserir = db.prepare(
    `INSERT INTO core_customer_cart_items (account_id, product_id, quantity, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, product_id) DO UPDATE
        SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
  );
  for (const item of itens) {
    const s = situacao(item.productId);
    if (s !== 'ok') {
      descartados.push({ productId: item.productId, motivo: s });
      continue;
    }
    inserir.run(accountId, item.productId, item.quantity, agora, agora);
  }
  return descartados;
}

/** O carrinho da conta, com cada produto como a vitrine o mostra AGORA. */
export function lerCarrinho(
  accountId: string,
  descartados: CarrinhoDaConta['descartados'] = [],
): CarrinhoDaConta {
  ensureCoreSchema();
  const db = getConnection();
  const linhas = db
    .prepare(
      `SELECT product_id, quantity, updated_at FROM core_customer_cart_items
        WHERE account_id = ? ORDER BY added_at, product_id`,
    )
    .all(accountId) as { product_id: string; quantity: number; updated_at: string }[];

  const items: CarrinhoDaConta['items'] = [];
  const sumiram: string[] = [];
  for (const l of linhas) {
    const s = situacao(l.product_id);
    const product = s === 'ok' ? getStorefrontProduct(l.product_id) : null;
    if (!product) {
      sumiram.push(l.product_id);
      descartados.push({ productId: l.product_id, motivo: s === 'ok' ? 'indisponivel' : s });
      continue;
    }
    items.push({ productId: l.product_id, quantity: Number(l.quantity), product });
  }
  // O que saiu da vitrine desde a última vez sai do carrinho também — senão
  // voltaria a cada leitura como "descartado".
  if (sumiram.length > 0) {
    const apagar = db.prepare(
      'DELETE FROM core_customer_cart_items WHERE account_id = ? AND product_id = ?',
    );
    for (const id of sumiram) apagar.run(accountId, id);
  }
  const updatedAt = linhas.reduce<string | null>(
    (maior, l) => (maior && maior > l.updated_at ? maior : l.updated_at),
    null,
  );
  return { items, descartados, updatedAt };
}

/** Troca o carrinho inteiro pelo que o aparelho mostra (a tela é a verdade do gesto). */
export function substituirCarrinho(accountId: string, bruto: unknown): CarrinhoDaConta {
  ensureCoreSchema();
  const itens = normalizar(bruto);
  const descartados = withTransaction(() => {
    getConnection()
      .prepare('DELETE FROM core_customer_cart_items WHERE account_id = ?')
      .run(accountId);
    return gravar(accountId, itens);
  });
  return lerCarrinho(accountId, descartados);
}

/**
 * Funde o carrinho do aparelho com o da conta (o login).
 *
 * Mesmo produto nos dois lados fica com a MAIOR quantidade: o carrinho que
 * já foi sincronizado e volta pelo mesmo aparelho não pode dobrar.
 */
export function mesclarCarrinho(accountId: string, bruto: unknown): CarrinhoDaConta {
  ensureCoreSchema();
  const locais = normalizar(bruto);
  const descartados = withTransaction(() => {
    const db = getConnection();
    const naConta = new Map(
      (
        db
          .prepare('SELECT product_id, quantity FROM core_customer_cart_items WHERE account_id = ?')
          .all(accountId) as { product_id: string; quantity: number }[]
      ).map((l) => [l.product_id, Number(l.quantity)]),
    );
    const fundidos = locais.map((i) => ({
      productId: i.productId,
      quantity: Math.min(Math.max(i.quantity, naConta.get(i.productId) ?? 0), MAX_QUANTIDADE_POR_ITEM),
    }));
    const total = new Set([...naConta.keys(), ...fundidos.map((f) => f.productId)]).size;
    if (total > MAX_LINHAS_DO_CARRINHO) {
      throw new ApiError(
        'PORTAL_CARRINHO_GRANDE',
        `O carrinho pode ter até ${MAX_LINHAS_DO_CARRINHO} produtos diferentes.`,
        400,
      );
    }
    return gravar(accountId, fundidos);
  });
  return lerCarrinho(accountId, descartados);
}

/** Acrescenta ao carrinho da conta (a página do produto). */
export function acrescentarAoCarrinho(accountId: string, bruto: unknown): CarrinhoDaConta {
  ensureCoreSchema();
  const [item] = normalizar([bruto]);
  if (!item) {
    throw new ApiError('PORTAL_CARRINHO_INVALIDO', 'Informe o produto e a quantidade.', 400);
  }
  const descartados = withTransaction(() => {
    const atual = getConnection()
      .prepare('SELECT quantity FROM core_customer_cart_items WHERE account_id = ? AND product_id = ?')
      .get(accountId, item.productId) as { quantity: number } | undefined;
    const quantidade = Math.min((atual?.quantity ?? 0) + item.quantity, MAX_QUANTIDADE_POR_ITEM);
    const linhas = (
      getConnection()
        .prepare('SELECT COUNT(*) c FROM core_customer_cart_items WHERE account_id = ?')
        .get(accountId) as { c: number }
    ).c;
    if (!atual && linhas >= MAX_LINHAS_DO_CARRINHO) {
      throw new ApiError(
        'PORTAL_CARRINHO_GRANDE',
        `O carrinho pode ter até ${MAX_LINHAS_DO_CARRINHO} produtos diferentes.`,
        400,
      );
    }
    return gravar(accountId, [{ productId: item.productId, quantity: quantidade }]);
  });
  return lerCarrinho(accountId, descartados);
}

/** Depois do pedido: sai da conta o que foi comprado. */
export function tirarDoCarrinho(accountId: string, productIds: string[]): void {
  ensureCoreSchema();
  const apagar = getConnection().prepare(
    'DELETE FROM core_customer_cart_items WHERE account_id = ? AND product_id = ?',
  );
  withTransaction(() => {
    for (const id of productIds) apagar.run(accountId, id);
  });
}
