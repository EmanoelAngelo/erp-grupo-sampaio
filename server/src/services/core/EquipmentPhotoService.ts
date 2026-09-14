/**
 * FOTOS DA MÁQUINA — o estado dela, que acompanha a máquina e não a visita
 * (GAP-PRD-106).
 *
 * As fotos existiam só na OS: a lataria riscada, o painel e o chassi gravado
 * ficavam presos a uma visita, e a OS seguinte começava sem nada. Estas são do
 * EQUIPAMENTO: a oficina fotografa uma vez (na entrada, na montagem) e a ficha
 * as mostra em toda visita, e depois da venda.
 *
 * O desenho é o das fotos da OS (`WorkshopPhotoService`), e pelos mesmos
 * motivos: os bytes vão para o disco do servidor com nome gerado (um UUID v4,
 * imprevisível — é ele que protege o endereço público), o banco guarda o
 * endereço, e a foto NÃO aparece na página pública do QR. A pasta é
 * redirecionável por `DEVORA_UPLOADS_DIR`, para a suíte não sujar a pasta real.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

const ACCEPTED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** O mesmo teto da foto da OS: a tela reduz antes; 3 MB é folga larga. */
export const MAX_EQUIPMENT_PHOTO_BYTES = 3 * 1024 * 1024;

/** Doze cobrem os quatro lados, painel, chassi, bateria e os detalhes. */
export const MAX_FOTOS_POR_MAQUINA = 12;

export const EQUIPMENT_PHOTO_KINDS = ['frente', 'lateral', 'traseira', 'painel', 'chassi', 'outra'] as const;
const KIND_SET = new Set<string>(EQUIPMENT_PHOTO_KINDS);

const PUBLIC_PREFIX = '/uploads/equipamentos';

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

export function equipmentPhotosDir(): string {
  const raiz = process.env.DEVORA_UPLOADS_DIR || join(repoRoot(), 'data', 'uploads');
  return join(raiz, 'equipamentos');
}

export interface EquipmentPhoto {
  id: string;
  equipment_id: string;
  url: string;
  file_name: string | null;
  byte_size: number;
  kind: string;
  caption: string | null;
  uploaded_by: string | null;
  created_at: string;
}

function exigirMaquina(companyId: string, equipmentId: string): void {
  const row = getConnection()
    .prepare('SELECT id FROM core_equipment WHERE id = ? AND company_id = ?')
    .get(equipmentId, companyId) as { id: string } | undefined;
  if (!row) throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
}

export function listEquipmentPhotos(companyId: string, equipmentId: string): EquipmentPhoto[] {
  ensureCoreSchema();
  exigirMaquina(companyId, equipmentId);
  return getConnection()
    .prepare(
      `SELECT * FROM core_equipment_photos
        WHERE company_id = ? AND equipment_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(companyId, equipmentId) as unknown as EquipmentPhoto[];
}

export function addEquipmentPhoto(input: {
  companyId: string;
  equipmentId: string;
  userId: string;
  dataUrl: string;
  fileName?: string | null;
  mimeType?: string;
  kind?: string;
  caption?: string | null;
}): EquipmentPhoto {
  ensureCoreSchema();
  exigirMaquina(input.companyId, input.equipmentId);

  const kind = String(input.kind ?? 'outra');
  if (!KIND_SET.has(kind)) {
    throw new ApiError(
      'CORE_PHOTO_KIND_INVALID',
      `Tipo de foto inválido: use ${EQUIPMENT_PHOTO_KINDS.join(', ')}.`,
      400,
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
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    throw new ApiError('CORE_IMAGE_INVALID', 'Arquivo de imagem vazio.', 400);
  }
  if (bytes.length > MAX_EQUIPMENT_PHOTO_BYTES) {
    throw new ApiError(
      'CORE_IMAGE_TOO_LARGE',
      `Imagem acima de ${Math.round(MAX_EQUIPMENT_PHOTO_BYTES / 1024 / 1024)} MB.`,
      413,
      { bytes: bytes.length, max: MAX_EQUIPMENT_PHOTO_BYTES },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const existentes = (
      db
        .prepare('SELECT COUNT(*) AS n FROM core_equipment_photos WHERE equipment_id = ? AND company_id = ?')
        .get(input.equipmentId, input.companyId) as { n: number }
    ).n;
    if (existentes >= MAX_FOTOS_POR_MAQUINA) {
      throw new ApiError(
        'CORE_PHOTOS_LIMIT',
        `Esta máquina já tem ${MAX_FOTOS_POR_MAQUINA} fotos — apague alguma antes de subir outra.`,
        409,
      );
    }
    const id = randomUUID();
    // O nome no disco é gerado: nome vindo do cliente não decide caminho.
    const stored = `${id}.${extension}`;
    mkdirSync(equipmentPhotosDir(), { recursive: true });
    writeFileSync(join(equipmentPhotosDir(), stored), bytes);

    db.prepare(
      `INSERT INTO core_equipment_photos
         (id, equipment_id, company_id, url, file_name, byte_size, kind, caption, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.equipmentId,
      input.companyId,
      `${PUBLIC_PREFIX}/${stored}`,
      input.fileName ?? null,
      bytes.length,
      kind,
      input.caption?.trim() || null,
      input.userId,
      new Date().toISOString(),
    );
    return db.prepare('SELECT * FROM core_equipment_photos WHERE id = ?').get(id) as unknown as EquipmentPhoto;
  });
}

export function removeEquipmentPhoto(input: {
  companyId: string;
  equipmentId: string;
  photoId: string;
}): EquipmentPhoto {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    exigirMaquina(input.companyId, input.equipmentId);
    const row = db
      .prepare('SELECT * FROM core_equipment_photos WHERE id = ? AND equipment_id = ? AND company_id = ?')
      .get(input.photoId, input.equipmentId, input.companyId) as EquipmentPhoto | undefined;
    if (!row) throw new ApiError('CORE_PHOTO_NOT_FOUND', 'Foto não encontrada.', 404);
    db.prepare('DELETE FROM core_equipment_photos WHERE id = ?').run(input.photoId);
    try {
      const nome = row.url.split('/').pop() ?? '';
      if (nome && !nome.includes('/')) unlinkSync(join(equipmentPhotosDir(), nome));
    } catch {
      // Arquivo já ausente não é motivo para falhar a remoção do registro.
    }
    return row;
  });
}
