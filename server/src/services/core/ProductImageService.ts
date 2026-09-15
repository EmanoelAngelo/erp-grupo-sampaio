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
 *
 * ## A miniatura do balcão (P0 da Preço Justo)
 *
 * O DEFEITO: o PDV não mostrava foto nenhuma, e o único arquivo que existia
 * era o original normalizado (até 1600 px, centenas de KB). Desenhar a lista
 * da busca com ele seria baixar trinta originais a cada tecla no balcão — em
 * rede de loja, e de novo em cada caixa.
 *
 * A ESCOLHA: o servidor não tem biblioteca de imagem (e não ganha uma — o
 * `package.json` do servidor não traz nenhuma, e decodificar JPEG à mão não é
 * trabalho de ERP). Quem já tem o decodificador é o NAVEGADOR de quem sobe a
 * foto: `normalizeImage` (src/lib/image.ts) já desenha a imagem num canvas
 * para reduzi-la, e desenha uma segunda vez em 160 px para a miniatura. Ela
 * sobe JUNTO com o original e mora ao lado dele, com nome próprio.
 *
 * O servidor NÃO confia no que recebeu: lê o cabeçalho (JPEG ou WebP),
 * confere o lado máximo e o peso, e recusa o resto. Miniatura que não passa
 * nisto não existe — o balcão mostra o espaço neutro, nunca o original.
 *
 * AS FOTOS QUE JÁ EXISTIAM (o backfill): ficam sem miniatura até alguém que
 * gere o catálogo abrir a ficha do produto (a galeria gera as que faltam, em
 * segundo plano) ou usar "Gerar miniaturas" em Fotos em lote. As duas passam
 * por `setProductImageThumbnail`, a única porta de gravação de miniatura
 * avulsa, e só preenchem o que está VAZIO: miniatura existente não é trocada
 * nem apagada.
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
 * Formatos da MINIATURA. PNG fica de fora de propósito: foto em PNG de 160 px
 * pesa várias vezes o JPEG equivalente, e a miniatura existe para ser leve. O
 * navegador que não codifica WebP devolve PNG no `toDataURL` — e o gerador cai
 * para JPEG nesse caso (ver `gerarMiniatura` em src/lib/image.ts).
 */
const THUMB_ACCEPTED: Record<string, string> = {
  'image/jpeg': 'jpg',
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

/**
 * O teto da miniatura: 40 KB e 160 px no maior lado. Um WebP de 160 px de uma
 * foto de produto fica em 5–12 KB; 40 KB é folga para o JPEG do navegador sem
 * WebP, e é o que impede "miniatura" de virar um segundo original.
 *
 * Os mesmos números moram em src/lib/image.ts (quem gera); mudar um sem o
 * outro faz o navegador gerar o que o servidor recusa.
 */
export const MAX_THUMB_BYTES = 40 * 1024;
export const MAX_THUMB_SIDE = 160;

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
  /** A miniatura do balcão; nula em foto antiga que ainda não ganhou uma. */
  thumb_url: string | null;
  thumb_bytes: number | null;
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

/** O data URL decodificado: tipo, extensão no disco e os bytes. */
interface Decodificado {
  mime: string;
  extension: string;
  bytes: Buffer;
}

function decodificar(
  dataUrl: string,
  mimeType: string | undefined,
  aceitos: Record<string, string>,
  mensagemDeFormato: string,
  codigoDeFormato: string,
): Decodificado {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl ?? '');
  const mime = (match?.[1] ?? mimeType ?? '').toLowerCase();
  const base64 = match?.[2] ?? dataUrl ?? '';

  const extension = aceitos[mime];
  if (!extension) {
    throw new ApiError(codigoDeFormato, mensagemDeFormato, 400, { accepted: Object.keys(aceitos) });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem inválido.', 400);
  }
  return { mime, extension, bytes };
}

// ------------------------------------------------------------ o cabeçalho

/**
 * Largura e altura lidas do CABEÇALHO — sem decodificar a imagem.
 *
 * É o que o servidor consegue conferir sem biblioteca: o JPEG declara o
 * tamanho no marcador SOFn, o WebP no primeiro bloco (VP8, VP8L ou VP8X).
 * Nulo = não é o formato que diz ser, e a miniatura é recusada.
 */
export function dimensoesDaImagem(
  bytes: Buffer,
  mime: string,
): { width: number; height: number } | null {
  if (mime === 'image/jpeg') return dimensoesDoJpeg(bytes);
  if (mime === 'image/webp') return dimensoesDoWebp(bytes);
  return null;
}

function dimensoesDoJpeg(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marcador = b[i + 1];
    // 0xFF repetido é preenchimento permitido entre segmentos.
    if (marcador === 0xff) {
      i += 1;
      continue;
    }
    i += 2;
    // Marcadores sem tamanho (TEM e RSTn).
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) continue;
    // Fim da imagem ou começo dos dados sem ter passado por um SOF.
    if (marcador === 0xd9 || marcador === 0xda) return null;
    if (i + 2 > b.length) return null;
    const tamanho = b.readUInt16BE(i);
    if (tamanho < 2) return null;
    // SOF0..SOF15, menos DHT (C4), JPG (C8) e DAC (CC), que não são quadro.
    const ehQuadro =
      marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;
    if (ehQuadro) {
      if (i + 7 > b.length) return null;
      return { height: b.readUInt16BE(i + 3), width: b.readUInt16BE(i + 5) };
    }
    i += tamanho;
  }
  return null;
}

function dimensoesDoWebp(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const bloco = b.toString('ascii', 12, 16);
  if (bloco === 'VP8 ') {
    // Quadro-chave: 3 bytes de etiqueta, o código de início 9d 01 2a, e os
    // lados em 14 bits (os 2 de cima são a escala).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (bloco === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (bloco === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * Confere a miniatura INTEIRA antes de qualquer byte ir para o disco: formato,
 * peso e o lado lido do cabeçalho. É a mesma régua no envio junto com a foto e
 * no preenchimento das fotos antigas.
 */
function validarMiniatura(dataUrl: string): Decodificado {
  const mini = decodificar(
    dataUrl,
    undefined,
    THUMB_ACCEPTED,
    'A miniatura precisa ser WebP ou JPEG.',
    'CORE_THUMB_FORMAT_INVALID',
  );
  if (mini.bytes.length === 0) {
    throw new ApiError('CORE_THUMB_INVALID', 'Miniatura vazia.', 400);
  }
  if (mini.bytes.length > MAX_THUMB_BYTES) {
    throw new ApiError(
      'CORE_THUMB_TOO_LARGE',
      `A miniatura passa de ${Math.round(MAX_THUMB_BYTES / 1024)} KB — ela existe para ser leve no balcão.`,
      413,
      { bytes: mini.bytes.length, max: MAX_THUMB_BYTES },
    );
  }
  const lados = dimensoesDaImagem(mini.bytes, mini.mime);
  if (!lados || lados.width <= 0 || lados.height <= 0) {
    throw new ApiError('CORE_THUMB_INVALID', 'A miniatura não é uma imagem legível.', 400);
  }
  if (Math.max(lados.width, lados.height) > MAX_THUMB_SIDE) {
    throw new ApiError(
      'CORE_THUMB_TOO_BIG',
      `A miniatura tem ${lados.width}×${lados.height} px; o maior lado aceito é ${MAX_THUMB_SIDE} px.`,
      400,
      { width: lados.width, height: lados.height, max: MAX_THUMB_SIDE },
    );
  }
  return mini;
}

/**
 * O nome no disco da miniatura: o id da foto e um sufixo aleatório.
 *
 * O sufixo é o que faz a troca de foto CHEGAR ao balcão sem recarregar nada:
 * os arquivos de /uploads/produtos saem com cache de dias, e nome novo é URL
 * nova — o navegador nunca serve a miniatura velha no lugar da nova.
 */
function nomeDaMiniatura(imageId: string, extension: string): string {
  return `${imageId}-mini-${randomBytes(4).toString('hex')}.${extension}`;
}

/**
 * Recebe a imagem em base64 e grava no disco.
 *
 * A primeira foto de um produto vira automaticamente a principal: obrigar o
 * usuário a marcar "principal" logo depois de enviar a única foto que existe
 * seria burocracia sem propósito.
 *
 * `thumbDataUrl` é a miniatura do balcão, gerada no navegador. Opcional — quem
 * não a manda (cliente antigo, clone de foto sem miniatura) grava só o
 * original, e a foto entra na fila do preenchimento.
 */
export function addProductImage(input: {
  companyId: string;
  productId: string;
  /** `data:image/jpeg;base64,...` ou só o base64 com `mimeType` informado. */
  dataUrl: string;
  fileName?: string | null;
  mimeType?: string;
  thumbDataUrl?: string | null;
}): ProductImage {
  ensureCoreSchema();
  assertProduct(input.companyId, input.productId);

  const original = decodificar(
    input.dataUrl,
    input.mimeType,
    ACCEPTED,
    'Formato não aceito. Envie JPEG, PNG ou WebP.',
    'CORE_IMAGE_FORMAT_INVALID',
  );
  if (original.bytes.length === 0) {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem vazio.', 400);
  }
  if (original.bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError(
      'CORE_IMAGE_TOO_LARGE',
      `Imagem acima de ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`,
      413,
      { bytes: original.bytes.length, max: MAX_IMAGE_BYTES },
    );
  }
  // A miniatura é conferida ANTES de qualquer escrita: recusada ela, o
  // original não pode ficar órfão no disco.
  const miniatura = input.thumbDataUrl ? validarMiniatura(input.thumbDataUrl) : null;

  return withTransaction(() => {
    const db = getConnection();
    const id = randomUUID();
    // O nome no disco é gerado: nome vindo do cliente não decide caminho de
    // arquivo, senão "../../" viraria escrita fora da pasta.
    const stored = `${id}.${original.extension}`;
    const storedThumb = miniatura ? nomeDaMiniatura(id, miniatura.extension) : null;

    mkdirSync(uploadsDir(), { recursive: true });
    writeFileSync(join(uploadsDir(), stored), original.bytes);
    if (miniatura && storedThumb) writeFileSync(join(uploadsDir(), storedThumb), miniatura.bytes);

    const existing = listProductImages(input.companyId, input.productId);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO core_product_images
         (id, company_id, product_id, url, file_name, byte_size, position, is_primary, created_at,
          thumb_url, thumb_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.productId,
      `${PUBLIC_PREFIX}/${stored}`,
      input.fileName ?? null,
      original.bytes.length,
      existing.length,
      existing.length === 0 ? 1 : 0,
      now,
      storedThumb ? `${PUBLIC_PREFIX}/${storedThumb}` : null,
      miniatura ? miniatura.bytes.length : null,
    );

    if (existing.length === 0) syncPrimaryOnProduct(input.companyId, input.productId);

    return db
      .prepare('SELECT * FROM core_product_images WHERE id = ?')
      .get(id) as unknown as ProductImage;
  });
}

/**
 * Preenche a miniatura de uma foto que ainda não tem — o backfill das fotos
 * antigas.
 *
 * SÓ PREENCHE O VAZIO. Miniatura existente é recusada (409), e não trocada:
 * trocar exigiria apagar o arquivo anterior, e esta porta não apaga imagem
 * nenhuma. Foto e produto são conferidos pela empresa da sessão — o id de uma
 * foto de outra loja responde "não encontrada", igual a um id inventado.
 */
export function setProductImageThumbnail(
  companyId: string,
  productId: string,
  imageId: string,
  thumbDataUrl: string,
): ProductImage {
  ensureCoreSchema();
  const miniatura = validarMiniatura(String(thumbDataUrl ?? ''));
  return withTransaction(() => {
    const db = getConnection();
    const alvo = db
      .prepare('SELECT * FROM core_product_images WHERE id = ? AND company_id = ? AND product_id = ?')
      .get(imageId, companyId, productId) as ProductImage | undefined;
    if (!alvo) throw new ApiError('CORE_IMAGE_NOT_FOUND', 'Imagem não encontrada.', 404);
    if (alvo.thumb_url) {
      throw new ApiError(
        'CORE_THUMB_EXISTS',
        'Esta foto já tem miniatura.',
        409,
        { imageId, thumbUrl: alvo.thumb_url },
      );
    }
    const stored = nomeDaMiniatura(imageId, miniatura.extension);
    mkdirSync(uploadsDir(), { recursive: true });
    writeFileSync(join(uploadsDir(), stored), miniatura.bytes);
    db.prepare(
      'UPDATE core_product_images SET thumb_url = ?, thumb_bytes = ? WHERE id = ? AND company_id = ?',
    ).run(`${PUBLIC_PREFIX}/${stored}`, miniatura.bytes.length, imageId, companyId);
    return db
      .prepare('SELECT * FROM core_product_images WHERE id = ?')
      .get(imageId) as unknown as ProductImage;
  });
}

/** Uma foto sem miniatura, com o que a tela do backfill precisa para gerá-la. */
export interface FotoSemMiniatura {
  id: string;
  product_id: string;
  product_name: string;
  url: string;
}

/**
 * As fotos DESTA empresa que ainda não têm miniatura — a fila do backfill.
 *
 * Principal primeiro: é ela que o balcão mostra, então é a que mais vale
 * preencher quando o lote for interrompido no meio.
 */
export function listImagesWithoutThumbnail(
  companyId: string,
  limit = 200,
): { items: FotoSemMiniatura[]; total: number } {
  ensureCoreSchema();
  const db = getConnection();
  const teto = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200)));
  const items = db
    .prepare(
      `SELECT i.id, i.product_id, p.name AS product_name, i.url
         FROM core_product_images i
         JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
        WHERE i.company_id = ? AND i.thumb_url IS NULL
        ORDER BY i.is_primary DESC, p.name, i.position
        LIMIT ?`,
    )
    .all(companyId, teto) as unknown as FotoSemMiniatura[];
  const total = Number(
    (db
      .prepare('SELECT COUNT(*) AS n FROM core_product_images WHERE company_id = ? AND thumb_url IS NULL')
      .get(companyId) as { n: number }).n,
  );
  return { items, total };
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

/**
 * Remove a imagem do banco e o arquivo do disco — e a miniatura dela junto:
 * sem a linha, nada mais cita aquele arquivo, e ele ficaria órfão na pasta.
 */
export function removeProductImage(companyId: string, productId: string, imageId: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const row = db
      .prepare('SELECT * FROM core_product_images WHERE id = ? AND company_id = ? AND product_id = ?')
      .get(imageId, companyId, productId) as ProductImage | undefined;
    if (!row) throw new ApiError('CORE_IMAGE_NOT_FOUND', 'Imagem não encontrada.', 404);

    db.prepare('DELETE FROM core_product_images WHERE id = ?').run(imageId);

    for (const caminho of [row.url, row.thumb_url]) {
      if (!caminho) continue;
      try {
        unlinkSync(join(uploadsDir(), caminho.split('/').pop() ?? ''));
      } catch {
        // Arquivo já ausente não é motivo para falhar a remoção do registro —
        // o objetivo é o produto deixar de mostrar aquela foto.
      }
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
