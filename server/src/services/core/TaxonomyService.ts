/**
 * Categorias, subcategorias e marcas — o vocabulário do catálogo.
 *
 * O problema que isto resolve: categoria e marca eram texto livre. Quem
 * digitasse "Masculino" num produto e "masculino" noutro criava duas, e o
 * filtro da vitrine passava a mostrar metade das peças em cada uma.
 *
 * DECISÃO: o produto continua guardando o TEXTO, não uma chave estrangeira.
 *
 * `PricingService` casa promoção por categoria em texto. Trocar para chave
 * agora desligaria em silêncio toda promoção por categoria já cadastrada — o
 * tipo de mudança que só aparece quando o cliente reclama do preço no caixa.
 * Aqui a tabela define o que PODE ser escolhido; o formulário grava o nome
 * canônico dela.
 *
 * `renameCategory` e `mergeCategory` existem porque criar a lista não conserta
 * o que já está torto: é preciso poder unificar "masculino" em "Masculino" e
 * ver os produtos migrarem junto.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  active: number;
  /** Quantos produtos usam este nome hoje. */
  usage: number;
  children?: Category[];
}

export interface Brand {
  id: string;
  name: string;
  active: number;
  usage: number;
}

function nome(valor: unknown): string {
  const limpo = String(valor ?? '').trim();
  if (!limpo) {
    throw new ApiError('CORE_TAXONOMY_NAME_REQUIRED', 'Informe o nome.', 400);
  }
  return limpo;
}

/**
 * Já existe algo com este nome, ignorando maiúsculas?
 *
 * A UNIQUE do banco é sensível a caixa, então sem esta checagem "Masculino" e
 * "masculino" entrariam as duas — exatamente o problema que a tela veio
 * resolver.
 */
function nomeEmUso(
  companyId: string,
  tabela: 'core_categories' | 'core_brands',
  valor: string,
  parentId: string | null,
  ignorarId?: string,
): boolean {
  const params: unknown[] = [companyId, valor.toLowerCase()];
  let sql = `SELECT id FROM ${tabela} WHERE company_id = ? AND lower(trim(name)) = ?`;
  if (tabela === 'core_categories') {
    sql += parentId ? ' AND parent_id = ?' : ' AND parent_id IS NULL';
    if (parentId) params.push(parentId);
  }
  if (ignorarId) {
    sql += ' AND id <> ?';
    params.push(ignorarId);
  }
  return Boolean(getConnection().prepare(sql).get(...(params as string[])));
}

// ------------------------------------------------------------- categorias

/** O nome da categoria-mãe, que é o que o produto guarda em `category`. */
function nomeDaMae(companyId: string, parentId: string): string {
  const mae = getConnection()
    .prepare('SELECT name FROM core_categories WHERE id = ? AND company_id = ?')
    .get(parentId, companyId) as { name: string } | undefined;
  return mae?.name ?? '';
}

/**
 * A PROMOÇÃO POR CATEGORIA ACOMPANHA A CATEGORIA (A-produto-11).
 *
 * O preço casa a promoção por IGUALDADE EXATA de texto (`pr.category = ?`, no
 * PricingService). Renomear "Perfumaria" para "Perfumes" levava os produtos e
 * deixava a promoção apontando para um nome que nenhum produto tem mais: o PDV
 * passava a cobrar o preço cheio enquanto a etiqueta "de/por" da prateleira
 * anunciava o promocional. Renomear e unir são o mesmo gesto para quem o faz —
 * "é a mesma categoria com outro nome" —, então a promoção vai junto, na mesma
 * transação. Devolve quantas promoções foram levadas.
 */
function levarAsPromocoes(companyId: string, de: string, para: string, agora: string): number {
  return Number(
    getConnection()
      .prepare(
        `UPDATE core_promotions SET category = ?, updated_at = ?
          WHERE company_id = ? AND product_id IS NULL AND category IS NOT NULL
            AND lower(trim(category)) = ?`,
      )
      .run(para, agora, companyId, de.trim().toLowerCase()).changes ?? 0,
  );
}

/** Árvore de categorias com a contagem de uso em cada nó. */
export function listCategories(companyId: string): Category[] {
  ensureCoreSchema();
  const db = getConnection();

  const raizes = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM core_products p
                WHERE p.company_id = c.company_id
                  AND lower(trim(p.category)) = lower(trim(c.name))) AS usage
         FROM core_categories c
        WHERE c.company_id = ? AND c.parent_id IS NULL
        ORDER BY c.name`,
    )
    .all(companyId) as unknown as Category[];

  for (const raiz of raizes) {
    /*
      A SUBCATEGORIA É CONTADA DENTRO DA SUA MÃE (A-produto-12).

      O esquema permite o mesmo nome sob mães diferentes ("Roupas › Infantil" e
      "Calçados › Infantil"), e a contagem olhava só a subcategoria: cada uma
      dizia o total das duas, e a remoção era recusada por produtos da outra.
    */
    raiz.children = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM core_products p
                  WHERE p.company_id = s.company_id
                    AND lower(trim(p.subcategory)) = lower(trim(s.name))
                    AND lower(trim(p.category)) = lower(trim(?))) AS usage
           FROM core_categories s
          WHERE s.company_id = ? AND s.parent_id = ?
          ORDER BY s.name`,
      )
      .all(raiz.name, companyId, raiz.id) as unknown as Category[];
  }
  return raizes;
}

export function upsertCategory(input: {
  companyId: string;
  id?: string;
  name: string;
  parentId?: string | null;
  active?: boolean;
}): Category {
  ensureCoreSchema();
  const valor = nome(input.name);
  const parentId = input.parentId ?? null;

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();

    if (parentId) {
      const pai = db
        .prepare(
          'SELECT id, parent_id FROM core_categories WHERE id = ? AND company_id = ?',
        )
        .get(parentId, input.companyId) as { id: string; parent_id: string | null } | undefined;
      if (!pai) throw new ApiError('CORE_CATEGORY_NOT_FOUND', 'Categoria não encontrada.', 404);
      // Dois níveis bastam: categoria e subcategoria. Uma árvore mais funda
      // não tem para onde ir no cadastro de produto.
      if (pai.parent_id) {
        throw new ApiError(
          'CORE_CATEGORY_TOO_DEEP',
          'Subcategoria não pode ter subcategoria.',
          400,
        );
      }
    }

    if (nomeEmUso(input.companyId, 'core_categories', valor, parentId, input.id)) {
      throw new ApiError(
        'CORE_CATEGORY_DUPLICATE',
        `Já existe "${valor}" aqui. Para unificar as duas, use a fusão.`,
        409,
      );
    }

    if (input.id) {
      const atual = db
        .prepare('SELECT * FROM core_categories WHERE id = ? AND company_id = ?')
        .get(input.id, input.companyId) as Category | undefined;
      if (!atual) throw new ApiError('CORE_CATEGORY_NOT_FOUND', 'Categoria não encontrada.', 404);

      // Renomear leva os produtos junto — senão o cadastro apontaria para um
      // nome que não existe mais na lista.
      if (atual.name !== valor) {
        if (atual.parent_id) {
          /*
            SUBCATEGORIA: SÓ OS PRODUTOS DA MÃE DELA (A-produto-12).

            O UPDATE casava só pelo nome da subcategoria. Renomear
            "Calçados › Infantil" para "Kids" arrastava também os produtos de
            "Roupas › Infantil" — que viravam órfãos de uma "Kids" que nem
            existe sob Roupas.
          */
          db.prepare(
            `UPDATE core_products SET subcategory = ?, updated_at = ?
              WHERE company_id = ? AND lower(trim(subcategory)) = ?
                AND lower(trim(category)) = lower(trim(?))`,
          ).run(
            valor,
            now,
            input.companyId,
            atual.name.trim().toLowerCase(),
            nomeDaMae(input.companyId, atual.parent_id),
          );
        } else {
          db.prepare(
            `UPDATE core_products SET category = ?, updated_at = ?
              WHERE company_id = ? AND lower(trim(category)) = ?`,
          ).run(valor, now, input.companyId, atual.name.trim().toLowerCase());
          levarAsPromocoes(input.companyId, atual.name, valor, now);
        }
      }

      db.prepare(
        'UPDATE core_categories SET name = ?, active = ?, updated_at = ? WHERE id = ?',
      ).run(valor, input.active === false ? 0 : 1, now, input.id);
      return findCategory(input.companyId, input.id);
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_categories (id, company_id, name, parent_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.companyId, valor, parentId, input.active === false ? 0 : 1, now, now);
    return findCategory(input.companyId, id);
  });
}

function findCategory(companyId: string, id: string): Category {
  const row = getConnection()
    .prepare(
      // Subcategoria conta só os produtos da MÃE dela (A-produto-12): é esta
      // contagem que `removeCategory` usa para recusar a remoção.
      `SELECT c.*,
              (SELECT COUNT(*) FROM core_products p
                WHERE p.company_id = c.company_id
                  AND lower(trim(CASE WHEN c.parent_id IS NULL THEN p.category ELSE p.subcategory END))
                      = lower(trim(c.name))
                  AND (c.parent_id IS NULL
                       OR lower(trim(p.category)) = (SELECT lower(trim(m.name))
                                                       FROM core_categories m
                                                      WHERE m.id = c.parent_id))) AS usage
         FROM core_categories c WHERE c.id = ? AND c.company_id = ?`,
    )
    .get(id, companyId) as Category | undefined;
  if (!row) throw new ApiError('CORE_CATEGORY_NOT_FOUND', 'Categoria não encontrada.', 404);
  return row;
}

/**
 * Une duas categorias.
 *
 * É o que efetivamente conserta o catálogo já sujo: os produtos da origem
 * passam a apontar para o destino, e a origem some. Sem isto, criar a lista só
 * impediria erros NOVOS — os antigos continuariam lá.
 */
export function mergeCategory(input: {
  companyId: string;
  sourceId: string;
  targetId: string;
}): Category {
  ensureCoreSchema();
  if (input.sourceId === input.targetId) {
    throw new ApiError('CORE_CATEGORY_MERGE_SELF', 'Escolha duas categorias diferentes.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const origem = findCategory(input.companyId, input.sourceId);
    const destino = findCategory(input.companyId, input.targetId);

    // Não se funde categoria com subcategoria: são níveis diferentes e o
    // produto guarda cada um numa coluna.
    if (Boolean(origem.parent_id) !== Boolean(destino.parent_id)) {
      throw new ApiError(
        'CORE_CATEGORY_MERGE_LEVEL',
        'Só é possível unir categoria com categoria, ou subcategoria com subcategoria.',
        400,
      );
    }

    const now = new Date().toISOString();

    if (origem.parent_id && destino.parent_id) {
      /*
        SUBCATEGORIA: SÓ OS PRODUTOS DA MÃE DA ORIGEM, e eles vão para a MÃE
        DO DESTINO (A-produto-12).

        Casar só pelo nome arrastava os produtos de outra "Infantil" (de outra
        categoria). E unir "Calçados › Infantil" em "Roupas › Kids" trocando só a
        subcategoria deixaria o produto em "Calçados › Kids", que não existe:
        a categoria acompanha o destino.
      */
      db.prepare(
        `UPDATE core_products SET category = ?, subcategory = ?, updated_at = ?
          WHERE company_id = ? AND lower(trim(subcategory)) = ?
            AND lower(trim(category)) = lower(trim(?))`,
      ).run(
        nomeDaMae(input.companyId, destino.parent_id),
        destino.name,
        now,
        input.companyId,
        origem.name.trim().toLowerCase(),
        nomeDaMae(input.companyId, origem.parent_id),
      );
    } else {
      db.prepare(
        `UPDATE core_products SET category = ?, updated_at = ?
          WHERE company_id = ? AND lower(trim(category)) = ?`,
      ).run(destino.name, now, input.companyId, origem.name.trim().toLowerCase());
      // A promoção da categoria unida passa a valer na de destino, como os
      // produtos (A-produto-11). Sem isto ela ficava apontando para um nome
      // que deixou de existir.
      levarAsPromocoes(input.companyId, origem.name, destino.name, now);
    }

    // As subcategorias da origem passam para o destino antes de apagar — o
    // CASCADE as levaria embora junto.
    if (!origem.parent_id) {
      db.prepare('UPDATE core_categories SET parent_id = ? WHERE parent_id = ?').run(
        destino.id,
        origem.id,
      );
    }

    db.prepare('DELETE FROM core_categories WHERE id = ?').run(origem.id);
    return findCategory(input.companyId, destino.id);
  });
}

/**
 * Remove a categoria.
 *
 * Bloqueia quando há produto usando: apagar deixaria o produto apontando para
 * um nome fora da lista, e o gestor descobriria isso ao abrir o cadastro e ver
 * o campo vazio. Para esse caso existe a fusão.
 */
export function removeCategory(companyId: string, id: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const alvo = findCategory(companyId, id);
    if (alvo.usage > 0) {
      throw new ApiError(
        'CORE_CATEGORY_IN_USE',
        `"${alvo.name}" está em ${alvo.usage} produto(s). Uma a outra categoria antes de remover.`,
        409,
        { usage: alvo.usage },
      );
    }
    getConnection().prepare('DELETE FROM core_categories WHERE id = ?').run(id);
  });
}

// ----------------------------------------------------------------- marcas

export function listBrands(companyId: string): Brand[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM core_products p
                WHERE p.company_id = b.company_id
                  AND lower(trim(p.brand)) = lower(trim(b.name))) AS usage
         FROM core_brands b
        WHERE b.company_id = ?
        ORDER BY b.name`,
    )
    .all(companyId) as unknown as Brand[];
}

export function upsertBrand(input: {
  companyId: string;
  id?: string;
  name: string;
  active?: boolean;
}): Brand {
  ensureCoreSchema();
  const valor = nome(input.name);

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();

    if (nomeEmUso(input.companyId, 'core_brands', valor, null, input.id)) {
      throw new ApiError(
        'CORE_BRAND_DUPLICATE',
        `Já existe a marca "${valor}". Para unificar as duas, use a fusão.`,
        409,
      );
    }

    if (input.id) {
      const atual = db
        .prepare('SELECT * FROM core_brands WHERE id = ? AND company_id = ?')
        .get(input.id, input.companyId) as Brand | undefined;
      if (!atual) throw new ApiError('CORE_BRAND_NOT_FOUND', 'Marca não encontrada.', 404);

      if (atual.name !== valor) {
        db.prepare(
          `UPDATE core_products SET brand = ?, updated_at = ?
            WHERE company_id = ? AND lower(trim(brand)) = ?`,
        ).run(valor, now, input.companyId, atual.name.trim().toLowerCase());
      }
      db.prepare('UPDATE core_brands SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(
        valor,
        input.active === false ? 0 : 1,
        now,
        input.id,
      );
      return findBrand(input.companyId, input.id);
    }

    const id = randomUUID();
    db.prepare(
      'INSERT INTO core_brands (id, company_id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, input.companyId, valor, input.active === false ? 0 : 1, now, now);
    return findBrand(input.companyId, id);
  });
}

function findBrand(companyId: string, id: string): Brand {
  const row = getConnection()
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM core_products p
                WHERE p.company_id = b.company_id
                  AND lower(trim(p.brand)) = lower(trim(b.name))) AS usage
         FROM core_brands b WHERE b.id = ? AND b.company_id = ?`,
    )
    .get(id, companyId) as Brand | undefined;
  if (!row) throw new ApiError('CORE_BRAND_NOT_FOUND', 'Marca não encontrada.', 404);
  return row;
}

export function mergeBrand(input: {
  companyId: string;
  sourceId: string;
  targetId: string;
}): Brand {
  ensureCoreSchema();
  if (input.sourceId === input.targetId) {
    throw new ApiError('CORE_BRAND_MERGE_SELF', 'Escolha duas marcas diferentes.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const origem = findBrand(input.companyId, input.sourceId);
    const destino = findBrand(input.companyId, input.targetId);

    db.prepare(
      `UPDATE core_products SET brand = ?, updated_at = ?
        WHERE company_id = ? AND lower(trim(brand)) = ?`,
    ).run(destino.name, new Date().toISOString(), input.companyId, origem.name.trim().toLowerCase());

    db.prepare('DELETE FROM core_brands WHERE id = ?').run(origem.id);
    return findBrand(input.companyId, destino.id);
  });
}

export function removeBrand(companyId: string, id: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const alvo = findBrand(companyId, id);
    if (alvo.usage > 0) {
      throw new ApiError(
        'CORE_BRAND_IN_USE',
        `"${alvo.name}" está em ${alvo.usage} produto(s). Una a outra marca antes de remover.`,
        409,
        { usage: alvo.usage },
      );
    }
    getConnection().prepare('DELETE FROM core_brands WHERE id = ?').run(id);
  });
}

/**
 * Nomes escritos nos produtos que NÃO estão na lista.
 *
 * Aparece na tela como pendência: são os que entraram antes do vocabulário
 * existir, ou por importação. Mostrar isso é o que impede a lista de virar
 * decoração enquanto o catálogo real segue solto.
 */
export function listOrphanValues(companyId: string): {
  categories: string[];
  subcategories: string[];
  brands: string[];
} {
  ensureCoreSchema();
  const db = getConnection();

  const soltos = (coluna: 'category' | 'subcategory' | 'brand', tabela: string): string[] =>
    (
      db
        .prepare(
          `SELECT DISTINCT trim(p.${coluna}) AS valor
             FROM core_products p
            WHERE p.company_id = ?
              AND p.${coluna} IS NOT NULL AND trim(p.${coluna}) <> ''
              AND NOT EXISTS (
                SELECT 1 FROM ${tabela} t
                 WHERE t.company_id = p.company_id
                   AND lower(trim(t.name)) = lower(trim(p.${coluna}))
              )
            ORDER BY valor`,
        )
        .all(companyId) as unknown as { valor: string }[]
    ).map((r) => r.valor);

  return {
    categories: soltos('category', 'core_categories'),
    subcategories: soltos('subcategory', 'core_categories'),
    brands: soltos('brand', 'core_brands'),
  };
}
