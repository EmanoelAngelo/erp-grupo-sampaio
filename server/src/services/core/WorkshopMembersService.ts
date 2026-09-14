/**
 * Quem trabalha em qual bancada.
 *
 * `core_workshop_members` existia e o comentário dele já dizia a regra: "um
 * mecânico de celulares não ganha acesso à oficina de mobilidade por pertencer
 * à mesma empresa". O que não existia era como MEXER nisso — o vínculo só
 * nascia pelo seed, e não havia caminho para incluir alguém novo.
 *
 * A empresa diz onde a pessoa trabalha; a oficina diz em qual bancada. As duas
 * coisas são necessárias, e é a segunda que faltava.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

function loadWorkshop(companyId: string, workshopId: string): { id: string; name: string } {
  const row = getConnection()
    .prepare('SELECT id, name FROM core_workshops WHERE id = ? AND company_id = ?')
    .get(workshopId, companyId) as { id: string; name: string } | undefined;
  if (!row) throw new ApiError('CORE_WORKSHOP_NOT_FOUND', 'Oficina não encontrada.', 404);
  return row;
}

export function listWorkshopMembers(
  companyId: string,
  workshopId: string,
): Record<string, unknown>[] {
  ensureCoreSchema();
  loadWorkshop(companyId, workshopId);
  return getConnection()
    .prepare(
      `SELECT m.id, m.user_id, m.role, m.created_at,
              u.display_name, u.login
         FROM core_workshop_members m
         JOIN core_users u ON u.id = m.user_id
        WHERE m.workshop_id = ?
        ORDER BY u.display_name`,
    )
    .all(workshopId) as unknown as Record<string, unknown>[];
}

export function addWorkshopMember(input: {
  companyId: string;
  workshopId: string;
  userId: string;
  role?: string;
}): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    loadWorkshop(input.companyId, input.workshopId);
    const db = getConnection();

    // A pessoa tem de pertencer à operação. Sem isto, o vínculo com a bancada
    // daria acesso a dados de uma empresa onde ela não trabalha.
    const vinculo = db
      .prepare(
        `SELECT u.id, u.display_name FROM core_users u
           JOIN core_user_companies uc ON uc.user_id = u.id
          WHERE u.id = ? AND uc.company_id = ?`,
      )
      .get(input.userId, input.companyId) as { id: string; display_name: string } | undefined;
    if (!vinculo) {
      throw new ApiError(
        'CORE_USER_NOT_IN_COMPANY',
        'Esta pessoa não pertence a esta operação.',
        404,
      );
    }

    const jaEsta = db
      .prepare('SELECT id FROM core_workshop_members WHERE workshop_id = ? AND user_id = ?')
      .get(input.workshopId, input.userId) as { id: string } | undefined;
    // Já estar na bancada não é erro: é o resultado desejado.
    if (jaEsta) return { id: jaEsta.id, user_id: input.userId, alreadyMember: true };

    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.workshopId, input.userId, input.role ?? 'mecanico', new Date().toISOString());

    return { id, user_id: input.userId, alreadyMember: false };
  });
}

export function removeWorkshopMember(
  companyId: string,
  workshopId: string,
  userId: string,
): void {
  ensureCoreSchema();
  loadWorkshop(companyId, workshopId);
  const r = getConnection()
    .prepare('DELETE FROM core_workshop_members WHERE workshop_id = ? AND user_id = ?')
    .run(workshopId, userId);
  if (!r.changes) {
    throw new ApiError('CORE_MEMBER_NOT_FOUND', 'Esta pessoa não está nesta oficina.', 404);
  }
}
