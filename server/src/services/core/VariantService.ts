/**
 * Grade de produto — tamanho, cor, e o que mais a operação usar.
 *
 * Quatro das seis operações vendem roupa (Gringa, Me Mimei, Conceito, Preço
 * Justo). Sem grade, "Camiseta Polo Azul" tem um saldo só e o estoque está
 * errado: vende-se o P quando só restava GG.
 *
 * DECISÃO: variante É um produto, com pai.
 *
 * Não existe tabela paralela de variante. Cada combinação vira uma linha em
 * `core_products` com `parent_id` apontando para o modelo. Com isso, tudo que
 * já funciona continua funcionando sem alteração — estoque, ledger de
 * movimento, reserva, item de venda, código de barras, etiqueta, vitrine,
 * importação de XML. É também como o varejo funciona de fato: cada tamanho/cor
 * tem o próprio EAN, e o leitor do PDV cai na peça exata.
 *
 * O produto-modelo deixa de ser vendável assim que ganha filhos: vender "a
 * camiseta" sem dizer o tamanho não significa nada no balcão.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { reservarCodigoInterno } from './CatalogService.js';
import { ensureBarcode } from './BarcodeService.js';
import { exigirTipoCoerente } from './ProductKindService.js';
import { getBalance } from './InventoryService.js';

/** Eixos da grade: {"tamanho": ["P","M","G"], "cor": ["Azul","Preto"]}. */
export type VariantAxes = Record<string, string[]>;

export interface VariantRow {
  id: string;
  internal_code: string;
  barcode: string | null;
  name: string;
  price_cents: number;
  variant_attributes: string | null;
  active: number;
  /**
   * 1 quando o tamanho pode ser vendido: ele ativo E o modelo ativo. Inativar o
   * modelo arquiva a grade inteira sem reescrever o `active` de cada tamanho —
   * reativar o modelo devolve a grade como estava.
   */
  vendavel?: number;
}

/** Nome legível da variante: "Camiseta Polo · M · Azul". */
function variantName(baseName: string, combo: Record<string, string>): string {
  const parts = Object.keys(combo)
    .sort()
    .map((k) => combo[k]);
  return [baseName, ...parts].join(' · ');
}

/**
 * Produto cartesiano dos eixos, em ordem estável.
 *
 * A ordem importa: gerar a grade duas vezes tem que produzir a mesma sequência
 * de códigos internos, senão reimportar uma planilha renomeia tudo.
 */
export function combinations(axes: VariantAxes): Record<string, string>[] {
  const keys = Object.keys(axes).sort();
  if (keys.length === 0) return [];

  let out: Record<string, string>[] = [{}];
  for (const key of keys) {
    const values = axes[key];
    if (!Array.isArray(values) || values.length === 0) {
      throw new ApiError('CORE_INVALID_VARIANT_AXIS', `O eixo "${key}" está vazio.`, 400);
    }
    const next: Record<string, string>[] = [];
    for (const partial of out) {
      for (const value of values) {
        next.push({ ...partial, [key]: String(value).trim() });
      }
    }
    out = next;
  }
  return out;
}

/** Chave canônica de uma combinação, para comparar sem depender da ordem. */
function comboKey(combo: Record<string, string>): string {
  return Object.keys(combo)
    .sort()
    .map((k) => `${k}=${combo[k]}`)
    .join('|');
}

/**
 * Campos do modelo que a variante herda.
 *
 * Tipado de propósito: `SELECT *` devolve `unknown`, e passar `unknown` para o
 * driver do SQLite não compila. Declarar aqui também deixa explícito o que é
 * herdado e o que a variante define por conta própria (código, EAN, nome).
 */
interface ParentProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  unit: string;
  cost_cents: number;
  price_cents: number;
  min_stock: number;
  supplier_id: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  origin: string | null;
  tax_profile: string | null;
  image_url: string | null;
  publish_online: number;
  kind: string;
  workshop_id: string | null;
  parent_id: string | null;
}

function loadProduct(companyId: string, productId: string): ParentProduct {
  const row = getConnection()
    .prepare(
      `SELECT id, name, description, category, brand, unit, cost_cents, price_cents,
              min_stock, supplier_id, ncm, cest, cfop, origin, tax_profile, image_url,
              publish_online, kind, workshop_id, parent_id
         FROM core_products WHERE id = ? AND company_id = ?`,
    )
    .get(productId, companyId) as ParentProduct | undefined;
  if (!row) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
  return row;
}

/**
 * Cria (ou completa) a grade de um produto.
 *
 * Idempotente por combinação: rodar de novo com um tamanho a mais acrescenta
 * só o que falta e não mexe no que já existe — inclusive não recria código de
 * barras já impresso em etiqueta.
 */
export function generateVariants(input: {
  companyId: string;
  productId: string;
  axes: VariantAxes;
  companyPrefix?: string;
  /** Preço da variante, quando difere do modelo (tamanho especial, p. ex.). */
  priceByCombo?: Record<string, number>;
}): { created: VariantRow[]; existing: VariantRow[] } {
  ensureCoreSchema();

  const combos = combinations(input.axes);
  if (combos.length === 0) {
    throw new ApiError('CORE_INVALID_VARIANT_AXIS', 'Informe ao menos um eixo de grade.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const parent = loadProduct(input.companyId, input.productId);

    // Grade de grade não existe: a variante é sempre folha.
    if (parent.parent_id) {
      throw new ApiError(
        'CORE_VARIANT_OF_VARIANT',
        'Uma variante não pode ter grade própria.',
        400,
      );
    }

    /*
      GRADE É COISA DE MERCADORIA DE VENDA.

      Este INSERT é o SEGUNDO escritor de `kind` e `workshop_id` no sistema — o
      primeiro é o cadastro. Ele copia os dois do pai por SQL cru, sem passar
      por invariante nenhum, e era por aqui que dava para produzir peças em
      lote: gerar a grade de uma peça criaria seis peças na mesma bancada, cada
      uma com o próprio saldo, sem ninguém ter escolhido nada — e tamanho e cor
      não descrevem um parafuso.

      Recusar é a resposta certa, e não "gerar como mercadoria": as variantes
      herdam preço, custo e fornecedor do pai, e um pai que é peça produziria
      filhos que ninguém sabe dizer se são de loja ou de bancada.
    */
    if (String(parent.kind ?? 'retail') === 'part') {
      throw new ApiError(
        'CORE_PART_CANNOT_HAVE_VARIANTS',
        'Peça de oficina não tem grade: tamanho e cor descrevem mercadoria de venda, não item de bancada.',
        409,
      );
    }

    // O par normalizado passa a valer também aqui. Um pai de revenda que ainda
    // carregasse `workshop_id` de cadastro antigo deixaria de contaminar cada
    // filho gerado.
    const tipo = exigirTipoCoerente({
      companyId: input.companyId,
      kind: parent.kind,
      workshopId: parent.workshop_id,
    });

    /*
      ================================================================
      O MODELO NÃO PODE ENTRAR NA GRADE COM MERCADORIA EM CIMA
      ================================================================

      Este arquivo decide, no cabeçalho, que "o produto-modelo deixa de ser
      vendável assim que ganha filhos" — e o resto do sistema cumpre. O que
      faltava era tratar a CONSEQUÊNCIA: se o modelo já tinha saldo, ele fica
      órfão. Aparece na tela de Estoque, some do PDV, e a contagem de
      inventário — o único mecanismo que faz sistema e prateleira concordarem —
      nem o lista.

      E é o caminho normal, não um caso raro: a loja cadastra a camisa, dá
      entrada da nota, e só depois percebe que precisa separar por tamanho.

      RECUSAR É MAIS HONESTO QUE MIGRAR SOZINHO. Quem gera a grade sabe onde a
      mercadoria está; o sistema não sabe qual tamanho são as dez camisas da
      prateleira, e distribuí-las por conta própria seria inventar estoque.
    */
    const saldoDoModelo = getBalance(input.companyId, input.productId);
    if (saldoDoModelo > 0) {
      throw new ApiError(
        'CORE_MODEL_HAS_STOCK',
        `"${parent.name}" tem ${saldoDoModelo} em estoque. Gerar a grade deixaria essa `
          + 'mercadoria num produto que o balcão não vende e a contagem não alcança. '
          + 'Dê saída do saldo do modelo e lance a entrada em cada tamanho, ou zere o '
          + 'modelo antes de criar a grade.',
        409,
        { productId: input.productId, saldo: saldoDoModelo },
      );
    }

    const current = db
      .prepare('SELECT * FROM core_products WHERE company_id = ? AND parent_id = ?')
      .all(input.companyId, input.productId) as unknown as Record<string, unknown>[];

    const byKey = new Map<string, Record<string, unknown>>();
    for (const row of current) {
      const attrs = row.variant_attributes
        ? (JSON.parse(String(row.variant_attributes)) as Record<string, string>)
        : {};
      byKey.set(comboKey(attrs), row);
    }

    const created: VariantRow[] = [];
    const existing: VariantRow[] = [];
    const now = new Date().toISOString();

    for (const combo of combos) {
      const key = comboKey(combo);
      const already = byKey.get(key);
      if (already) {
        existing.push(already as unknown as VariantRow);
        continue;
      }

      const id = randomUUID();
      /*
        A SEQUÊNCIA CRUA ESBARRAVA NO CÓDIGO DIGITADO À MÃO (A-produto-13).

        `generateInternalCode` devolve o próximo número sem olhar se ele já foi
        usado. O cadastro convida a digitar o próprio código ("Digite o seu"), e
        quem migra do sistema antigo digita "GS-000031": quando a sequência
        chegava a 31, o INSERT batia no UNIQUE e a grade inteira morria num 500
        "Erro interno." sem explicação. `reservarCodigoInterno` é o gerador que
        o cadastro já usa, e que pula o código ocupado.
      */
      const code = reservarCodigoInterno(input.companyId, input.companyPrefix ?? 'GS');
      const price = input.priceByCombo?.[key] ?? Number(parent.price_cents ?? 0);

      db.prepare(
        `INSERT INTO core_products
           (id, company_id, internal_code, sku, barcode, name, description, category, brand,
            unit, cost_cents, price_cents, min_stock, supplier_id, ncm, cest, cfop, origin,
            tax_profile, image_url, active, publish_online, kind, workshop_id,
            parent_id, variant_attributes, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?)`,
      ).run(
        id,
        input.companyId,
        code,
        variantName(parent.name, combo),
        parent.description,
        parent.category,
        parent.brand,
        parent.unit ?? 'UN',
        parent.cost_cents ?? 0,
        price,
        parent.min_stock ?? 0,
        parent.supplier_id,
        parent.ncm,
        parent.cest,
        parent.cfop,
        parent.origin,
        parent.tax_profile,
        parent.image_url,
        1,
        parent.publish_online ?? 0,
        tipo.kind,
        tipo.workshopId,
        input.productId,
        JSON.stringify(combo),
        now,
        now,
      );

      // Cada variante nasce com o próprio EAN — é o que o leitor vai ler.
      ensureBarcode(input.companyId, id);

      created.push(
        db.prepare('SELECT * FROM core_products WHERE id = ?').get(id) as unknown as VariantRow,
      );
    }

    // O modelo deixa de ser vendável: no balcão, "a camiseta" sem tamanho não
    // é um item. Ele continua ativo como agrupador de catálogo.
    db.prepare('UPDATE core_products SET updated_at = ? WHERE id = ?').run(now, input.productId);

    return { created, existing };
  });
}

/** Variantes de um modelo, na ordem em que foram criadas. */
export function listVariants(companyId: string, productId: string): VariantRow[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT p.id, p.internal_code, p.barcode, p.name, p.price_cents, p.variant_attributes,
              p.active, (p.active = 1 AND m.active = 1) AS vendavel
         FROM core_products p
         JOIN core_products m ON m.id = p.parent_id
        WHERE p.company_id = ? AND p.parent_id = ?
        ORDER BY p.internal_code`,
    )
    .all(companyId, productId) as unknown as VariantRow[];
}

/** True quando o produto é um modelo com grade — logo, não vendável direto. */
export function hasVariants(companyId: string, productId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT 1 AS n FROM core_products WHERE company_id = ? AND parent_id = ? LIMIT 1')
    .get(companyId, productId) as { n?: number } | undefined;
  return Boolean(row?.n);
}

/**
 * Saldo da grade inteira, para a tela do modelo.
 *
 * Mostra o total e a quebra por variante — é o que o gestor olha para decidir
 * reposição ("tenho 40 peças, mas nenhuma no P").
 */
export function variantStock(
  companyId: string,
  productId: string,
): { totalQuantity: number; items: (VariantRow & { quantity: number; reserved: number })[] } {
  ensureCoreSchema();
  const items = getConnection()
    .prepare(
      `SELECT p.id, p.internal_code, p.barcode, p.name, p.price_cents,
              p.variant_attributes, p.active,
              (p.active = 1 AND m.active = 1) AS vendavel,
              COALESCE(s.quantity, 0) AS quantity,
              COALESCE(s.reserved, 0) AS reserved
         FROM core_products p
         JOIN core_products m ON m.id = p.parent_id
         LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
        WHERE p.company_id = ? AND p.parent_id = ?
        ORDER BY p.internal_code`,
    )
    .all(companyId, productId) as unknown as (VariantRow & {
    quantity: number;
    reserved: number;
  })[];

  return {
    totalQuantity: items.reduce((acc, i) => acc + Number(i.quantity), 0),
    items,
  };
}
