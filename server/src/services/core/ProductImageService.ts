/**
 * Fotos do produto.
 *
 * O arquivo vai para o disco do backend (`data/uploads/produtos/`) e o banco
 * guarda o caminho público. Não vai para IndexedDB nem para o banco em base64:
 * imagem em coluna de texto incha o backup, atrapalha a replicação e não é
 * servida com cache pelo navegador.
 *
 * A MESMA foto alimenta o balcão e a vitrine. Não existe imagem de e-commerce
 * separada — se existisse, um dia as duas divergiriam e o cliente veria na loja
 * um produto diferente do que está na prateleira.
 *
 * O que este módulo NÃO faz: inventar imagem. Produto sem foto é produto sem
 * foto, e a vitrine mostra o espaço vazio — colocar uma imagem genérica no
 * lugar enganaria o cliente sobre o que ele está comprando.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { findProductByAnyBarcode } from './CatalogAuxService.js';

/** Formatos aceitos, com a extensão que cada um recebe no disco. */
const ACCEPTED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Teto do arquivo JÁ NORMALIZADO.
 *
 * O navegador redimensiona e recomprime antes de enviar, então 3 MB é folga
 * larga para uma foto de vitrine. O limite existe para barrar envio de arquivo
 * cru — não para apertar o uso legítimo.
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Caminho público servido pela API. */
const PUBLIC_PREFIX = '/uploads/produtos';

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

/**
 * A pasta no disco — REDIRECIONÁVEL, como o banco.
 *
 * `DEVORA_UPLOADS_DIR` existe pelo mesmo motivo que `DEVORA_DATABASE_PATH`: a
 * suíte roda contra banco temporário, mas os ARQUIVOS iam para a pasta real e
 * ficavam lá. Teste que suja a pasta de produção é banco temporário vazado,
 * do outro lado.
 *
 * O padrão NÃO muda: é o caminho histórico, e os links já gravados no banco
 * apontam para ele.
 */
export function uploadsDir(): string {
  const raiz = process.env.DEVORA_UPLOADS_DIR || join(repoRoot(), 'data', 'uploads');
  return join(raiz, 'produtos');
}

export interface ProductImage {
  id: string;
  product_id: string;
  url: string;
  file_name: string | null;
  byte_size: number | null;
  position: number;
  is_primary: number;
  created_at: string;
}

export function listProductImages(companyId: string, productId: string): ProductImage[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_product_images
        WHERE company_id = ? AND product_id = ?
        ORDER BY is_primary DESC, position, created_at`,
    )
    .all(companyId, productId) as unknown as ProductImage[];
}

function assertProduct(companyId: string, productId: string): void {
  const row = getConnection()
    .prepare('SELECT id FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { id: string } | undefined;
  if (!row) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
}

/**
 * Recebe a imagem em base64 e grava no disco.
 *
 * A primeira foto de um produto vira automaticamente a principal: obrigar o
 * usuário a marcar "principal" logo depois de enviar a única foto que existe
 * seria burocracia sem propósito.
 */
export function addProductImage(input: {
  companyId: string;
  productId: string;
  /** `data:image/jpeg;base64,...` ou só o base64 com `mimeType` informado. */
  dataUrl: string;
  fileName?: string | null;
  mimeType?: string;
}): ProductImage {
  ensureCoreSchema();
  assertProduct(input.companyId, input.productId);

  const match = /^data:([^;]+);base64,(.*)$/s.exec(input.dataUrl ?? '');
  const mime = (match?.[1] ?? input.mimeType ?? '').toLowerCase();
  const base64 = match?.[2] ?? input.dataUrl ?? '';

  const extension = ACCEPTED[mime];
  if (!extension) {
    throw new ApiError(
      'CORE_IMAGE_FORMAT_INVALID',
      'Formato não aceito. Envie JPEG, PNG ou WebP.',
      400,
      { accepted: Object.keys(ACCEPTED) },
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem inválido.', 400);
  }
  if (bytes.length === 0) {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem vazio.', 400);
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError(
      'CORE_IMAGE_TOO_LARGE',
      `Imagem acima de ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`,
      413,
      { bytes: bytes.length, max: MAX_IMAGE_BYTES },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const id = randomUUID();
    // O nome no disco é gerado: nome vindo do cliente não decide caminho de
    // arquivo, senão "../../" viraria escrita fora da pasta.
    const stored = `${id}.${extension}`;

    mkdirSync(uploadsDir(), { recursive: true });
    writeFileSync(join(uploadsDir(), stored), bytes);

    const existing = listProductImages(input.companyId, input.productId);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO core_product_images
         (id, company_id, product_id, url, file_name, byte_size, position, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.productId,
      `${PUBLIC_PREFIX}/${stored}`,
      input.fileName ?? null,
      bytes.length,
      existing.length,
      existing.length === 0 ? 1 : 0,
      now,
    );

    if (existing.length === 0) syncPrimaryOnProduct(input.companyId, input.productId);

    return db
      .prepare('SELECT * FROM core_product_images WHERE id = ?')
      .get(id) as unknown as ProductImage;
  });
}

/**
 * Espelha a foto principal em `core_products.image_url`.
 *
 * A vitrine e o PDV já leem esse campo. Mantê-lo em dia evita ter que mudar
 * todos os consumidores de imagem agora — e a galeria continua sendo a fonte.
 */
function syncPrimaryOnProduct(companyId: string, productId: string): void {
  const [principal] = listProductImages(companyId, productId);
  getConnection()
    .prepare('UPDATE core_products SET image_url = ?, updated_at = ? WHERE id = ?')
    .run(principal?.url ?? null, new Date().toISOString(), productId);
}

export function setPrimaryImage(companyId: string, productId: string, imageId: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const alvo = db
      .prepare('SELECT id FROM core_product_images WHERE id = ? AND company_id = ? AND product_id = ?')
      .get(imageId, companyId, productId) as { id: string } | undefined;
    if (!alvo) throw new ApiError('CORE_IMAGE_NOT_FOUND', 'Imagem não encontrada.', 404);

    db.prepare('UPDATE core_product_images SET is_primary = 0 WHERE product_id = ?').run(productId);
    db.prepare('UPDATE core_product_images SET is_primary = 1 WHERE id = ?').run(imageId);
    syncPrimaryOnProduct(companyId, productId);
  });
}

/** Remove a imagem do banco e o arquivo do disco. */
export function removeProductImage(companyId: string, productId: string, imageId: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const row = db
      .prepare('SELECT * FROM core_product_images WHERE id = ? AND company_id = ? AND product_id = ?')
      .get(imageId, companyId, productId) as ProductImage | undefined;
    if (!row) throw new ApiError('CORE_IMAGE_NOT_FOUND', 'Imagem não encontrada.', 404);

    db.prepare('DELETE FROM core_product_images WHERE id = ?').run(imageId);

    try {
      unlinkSync(join(uploadsDir(), row.url.split('/').pop() ?? ''));
    } catch {
      // Arquivo já ausente não é motivo para falhar a remoção do registro —
      // o objetivo é o produto deixar de mostrar aquela foto.
    }

    // Removida a principal, a próxima da fila assume: produto não pode ficar
    // com galeria cheia e nenhuma foto marcada.
    const restantes = listProductImages(companyId, productId);
    if (row.is_primary && restantes.length > 0) {
      db.prepare('UPDATE core_product_images SET is_primary = 1 WHERE id = ?').run(restantes[0].id);
    }
    syncPrimaryOnProduct(companyId, productId);
  });
}

/** Reordena a galeria. Ids ausentes da lista mantêm a posição atual. */
export function reorderProductImages(
  companyId: string,
  productId: string,
  orderedIds: string[],
): ProductImage[] {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    orderedIds.forEach((id, index) => {
      db.prepare(
        'UPDATE core_product_images SET position = ? WHERE id = ? AND company_id = ? AND product_id = ?',
      ).run(index, id, companyId, productId);
    });
    return listProductImages(companyId, productId);
  });
}

/** Um nome de arquivo resolvido contra o catálogo. */
export interface NomeResolvido {
  name: string;
  code: string;
  productId: string | null;
  productName: string | null;
  internalCode: string | null;
  temFoto: boolean;
}

/** Foto de loja inteira cabe em 500; acima disso não é lote, é abuso. */
export const MAX_NOMES_POR_LOTE = 500;

/**
 * Resolve nomes de arquivo em produtos — o coração do envio em lote.
 *
 * O código é o nome SEM a extensão: quem fotografa nomeia cada arquivo com
 * o código de barras ou o código interno da etiqueta. A ordem de casamento
 * é a mesma da entrada de notas (barras primeiro, que é a identificação
 * mais confiável), e o corte por empresa é o de sempre: a foto da Gringa
 * não veste produto de outra loja.
 *
 * SÓ LEITURA: o upload continua passando, foto a foto, pela rota que já
 * existia — um único escritor de imagem.
 */
export function resolverNomesDeFotos(companyId: string, names: string[]): NomeResolvido[] {
  if (!Array.isArray(names) || names.length === 0) {
    throw new ApiError('CORE_BATCH_EMPTY', 'Envie os nomes dos arquivos.', 400);
  }
  if (names.length > MAX_NOMES_POR_LOTE) {
    throw new ApiError(
      'CORE_BATCH_TOO_LARGE',
      `O lote aceita até ${MAX_NOMES_POR_LOTE} arquivos por vez.`,
      400,
    );
  }
  const db = getConnection();
  /*
    A REVISÃO MORDEU AQUI: o UNIQUE de internal_code é case-sensitive, então
    'PB-1' e 'pb-1' coexistem legalmente — e o NOCASE sozinho devolvia o
    PRIMEIRO da varredura, vestindo a foto no produto errado em silêncio.
    A caixa EXATA decide primeiro; o NOCASE é só a cortesia para o arquivo
    nomeado à mão quando não há ambiguidade possível.
  */
  const porCodigoExato = db.prepare(
    'SELECT id FROM core_products WHERE company_id = ? AND internal_code = ?',
  );
  const porCodigoInterno = db.prepare(
    'SELECT id FROM core_products WHERE company_id = ? AND internal_code = ? COLLATE NOCASE',
  );
  const ficha = db.prepare(
    `SELECT p.name, p.internal_code,
            (SELECT COUNT(*) FROM core_product_images i WHERE i.product_id = p.id) AS fotos
       FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
  );

  return names.map((bruto) => {
    const name = String(bruto ?? '');
    // O código é o nome sem a ÚLTIMA extensão — 'PB-1.v2.jpg' vira 'PB-1.v2'.
    const code = name.replace(/\.[^.]+$/, '').trim();
    if (!code) {
      return { name, code, productId: null, productName: null, internalCode: null, temFoto: false };
    }
    const porBarras = findProductByAnyBarcode(companyId, code);
    const productId =
      porBarras ??
      ((porCodigoExato.get(companyId, code) as { id: string } | undefined)?.id ??
        ((porCodigoInterno.get(companyId, code) as { id: string } | undefined)?.id ?? null));
    if (!productId) {
      return { name, code, productId: null, productName: null, internalCode: null, temFoto: false };
    }
    const dados = ficha.get(productId, companyId) as
      | { name: string; internal_code: string; fotos: number }
      | undefined;
    return {
      name,
      code,
      productId,
      productName: dados?.name ?? null,
      internalCode: dados?.internal_code ?? null,
      temFoto: Number(dados?.fotos ?? 0) > 0,
    };
  });
}
