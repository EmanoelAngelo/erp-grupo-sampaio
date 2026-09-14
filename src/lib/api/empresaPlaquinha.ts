/**
 * QUEM USA PLAQUINHA COM QR — a marca da operação, pela tela (GAP-PRD-185).
 *
 * `PATCH /core/companies/:id/equipment-tags` liga ou desliga; só quem responde
 * pelo grupo. Desligar com plaquinha impressa esperando máquina é recusado
 * (`CORE_COMPANY_TAGS_PENDING`), e a mensagem diz quantas são.
 */
import { apiRequest } from './client';

/** O padrão de uma operação nova — o mesmo que o servidor aplica. */
export function plaquinhaPadrao(kind: string, workshopKind: 'mobility' | 'phones'): boolean {
  return kind === 'workshop' && workshopKind === 'mobility';
}

export const empresaPlaquinhaApi = {
  definir: (companyId: string, enabled: boolean) =>
    apiRequest<{ companyId: string; usesEquipmentTags: boolean }>(
      `/core/companies/${companyId}/equipment-tags`,
      { method: 'PATCH', body: { enabled } },
    ),
};
