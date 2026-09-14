/**
 * Fotos da ordem de serviço — a prova do que chegou e do que foi feito.
 *
 * ## Por que elas existem
 *
 * A discussão de balcão que a oficina conhece: "esse risco já era assim
 * quando eu trouxe", "o carregador veio junto", "o aparelho ligava". A foto
 * da ENTRADA encerra o assunto sem ninguém precisar levantar a voz; a foto do
 * SERVIÇO mostra ao dono o que ele pagou.
 *
 * ## Onde os bytes moram, e por que NÃO no banco
 *
 * O sistema anterior guardava a foto em base64 dentro do MESMO blob JSON de
 * todas as ordens, no `localStorage` do navegador. Duas fotos de celular
 * estouravam a cota e derrubavam a persistência de TODAS as OS — não só das
 * fotos. Aqui vale o desenho das fotos de produto (rodada 45): o arquivo vai
 * para o disco do servidor, com nome gerado, e o banco guarda o endereço.
 *
 * ## O endereço gravado não abre sozinho (GAP-PRD-184)
 *
 * O banco guarda o caminho `/uploads/os/<uuid>.<ext>`, mas ele deixou de ser
 * público: o guarda de `FotoDaOsAssinada.ts` só serve a foto com a assinatura
 * de uma hora que a listagem da OS (com sessão e alcance) entrega. A foto
 * continua fora da página pública do QR.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

/** Formatos aceitos, com a extensão que cada um recebe no disco. */
const ACCEPTED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Teto do arquivo JÁ NORMALIZADO — o mesmo das fotos de produto.
 *
 * A tela reduz a imagem antes de enviar; 3 MB é folga larga para uma foto de
 * bancada tirada do celular. O limite existe para barrar o arquivo cru de
 * 12 MP que o telefone produz por padrão.
 */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/**
 * Teto por OS.
 *
 * O sistema anterior não tinha limite nenhum — e era ele que estourava a
 * cota do navegador. Vinte fotos cobrem entrada, defeito e serviço de
 * qualquer conserto; passar disso é sinal de que a bancada está usando a OS
 * como álbum.
 */
export const MAX_PHOTOS_POR_OS = 20;

/** O que a foto conta. */
export const PHOTO_KINDS = ['entrada', 'defeito', 'servico', 'saida'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
const KIND_SET = new Set<string>(PHOTO_KINDS);

const PUBLIC_PREFIX = '/uploads/os';

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

/**
 * A pasta no disco — e ela é REDIRECIONÁVEL, como o banco.
 *
 * Fica sob `server/data/uploads/` — a mesma raiz das fotos de produto, e a
 * que o `.gitignore` já cobre. (O logo da loja mora numa raiz diferente por
 * acidente histórico; não vale repetir o acidente.)
 *
 * `DEVORA_UPLOADS_DIR` existe pelo mesmo motivo que `DEVORA_DATABASE_PATH`: a
 * suíte roda contra banco temporário, mas os ARQUIVOS iam para a pasta real e
 * ficavam lá. Cada rodada da suíte deixava 21 imagens de 1x1 órfãs em
 * `server/data/uploads/os` — órfãs porque o banco que as conhecia era
 * descartado no fim do teste. Teste que suja a pasta de produção é o mesmo
 * defeito do banco temporário vazado, na outra ponta.
 */
export function photosDir(): string {
  const raiz = process.env.DEVORA_UPLOADS_DIR || join(repoRoot(), 'data', 'uploads');
  return join(raiz, 'os');
}

export interface OrderPhoto {
  id: string;
  order_id: string;
  url: string;
  file_name: string | null;
  byte_size: number;
  kind: string;
  caption: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export function listOrderPhotos(companyId: string, orderId: string): OrderPhoto[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_service_order_photos
        WHERE company_id = ? AND order_id = ?
        ORDER BY created_at`,
    )
    .all(companyId, orderId) as unknown as OrderPhoto[];
}

function assertOrder(companyId: string, orderId: string): { status: string } {
  const row = getConnection()
    .prepare('SELECT status FROM core_service_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as { status: string } | undefined;
  if (!row) throw new ApiError('CORE_ORDER_NOT_FOUND', 'OS não encontrada.', 404);
  return row;
}

/**
 * Recebe a foto em base64 e grava no disco.
 *
 * OS finalizada não recebe foto nova: a conta fechou e o dono já levou o
 * aparelho — acrescentar prova depois disso é reescrever a história do
 * serviço. (Ver a mesma régua em peças: `addPart` recusa OS fechada.)
 */
export function addOrderPhoto(input: {
  companyId: string;
  orderId: string;
  userId: string;
  /** `data:image/jpeg;base64,...` ou só o base64 com `mimeType` informado. */
  dataUrl: string;
  fileName?: string | null;
  mimeType?: string;
  kind?: string;
  caption?: string | null;
}): OrderPhoto {
  ensureCoreSchema();
  const order = assertOrder(input.companyId, input.orderId);
  if (order.status === 'finalizada') {
    throw new ApiError(
      'CORE_ORDER_CLOSED',
      'OS finalizada não recebe foto nova — o serviço já foi entregue.',
      409,
    );
  }

  const kind = String(input.kind ?? 'servico');
  if (!KIND_SET.has(kind)) {
    throw new ApiError(
      'CORE_PHOTO_KIND_INVALID',
      'Tipo de foto inválido: use entrada, defeito, servico ou saida.',
      400,
    );
  }

  const existentes = listOrderPhotos(input.companyId, input.orderId);
  if (existentes.length >= MAX_PHOTOS_POR_OS) {
    throw new ApiError(
      'CORE_PHOTOS_LIMIT',
      `Esta OS já tem ${MAX_PHOTOS_POR_OS} fotos — apague alguma antes de subir outra.`,
      409,
    );
  }

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
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new ApiError(
      'CORE_IMAGE_TOO_LARGE',
      `Imagem acima de ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`,
      413,
      { bytes: bytes.length, max: MAX_PHOTO_BYTES },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const id = randomUUID();
    // O nome no disco é gerado: nome vindo do cliente não decide caminho de
    // arquivo, senão "../../" viraria escrita fora da pasta.
    const stored = `${id}.${extension}`;

    mkdirSync(photosDir(), { recursive: true });
    writeFileSync(join(photosDir(), stored), bytes);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_service_order_photos
         (id, order_id, company_id, url, file_name, byte_size, kind, caption, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.orderId,
      input.companyId,
      `${PUBLIC_PREFIX}/${stored}`,
      input.fileName ?? null,
      bytes.length,
      kind,
      input.caption?.trim() || null,
      input.userId,
      now,
    );

    return db
      .prepare('SELECT * FROM core_service_order_photos WHERE id = ?')
      .get(id) as unknown as OrderPhoto;
  });
}

/**
 * Apaga a foto — a linha e o arquivo.
 *
 * OS finalizada não perde foto, pela mesma razão que não recebe: a foto de
 * entrada é o que prova que o risco na lataria já existia, e o serviço já foi
 * entregue. A entrada estava fechada e a saída não — a regra vivia só no
 * navegador, escondendo o botão, e um DELETE direto respondia 204 e sumia com
 * o arquivo para sempre.
 */
export function removeOrderPhoto(input: {
  companyId: string;
  orderId: string;
  photoId: string;
}): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const order = assertOrder(input.companyId, input.orderId);
    if (order.status === 'finalizada') {
      throw new ApiError(
        'CORE_ORDER_CLOSED',
        'OS finalizada não perde foto — o serviço já foi entregue.',
        409,
      );
    }
    const row = db
      .prepare(
        `SELECT * FROM core_service_order_photos
          WHERE id = ? AND order_id = ? AND company_id = ?`,
      )
      .get(input.photoId, input.orderId, input.companyId) as OrderPhoto | undefined;
    if (!row) throw new ApiError('CORE_PHOTO_NOT_FOUND', 'Foto não encontrada.', 404);

    db.prepare('DELETE FROM core_service_order_photos WHERE id = ?').run(input.photoId);
    try {
      // Só o nome simples: qualquer coisa com barra não é nosso arquivo.
      const nome = row.url.split('/').pop() ?? '';
      if (nome && !nome.includes('/')) unlinkSync(join(photosDir(), nome));
    } catch {
      // Arquivo já ausente não é motivo para falhar a remoção do registro.
    }
  });
}
