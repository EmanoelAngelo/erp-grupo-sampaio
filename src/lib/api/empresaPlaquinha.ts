/**
 * QUEM USA PLAQUINHA COM QR — a marca da operação, pela tela (GAP-PRD-185).
 *
 * `PATCH /core/companies/:id/equipment-tags` liga ou desliga; só quem responde
 * pelo grupo. Desligar com plaquinha impressa esperando máquina é recusado
 * (`CORE_COMPANY_TAGS_PENDING`), e a mensagem diz quantas são.
 *
 * Desde o P0 das plaquinhas só a PJ Motors pode LIGAR: em outra empresa o
 * servidor responde 403 `CORE_COMPANY_TAGS_PJ_ONLY`. O `plaquinhaPadrao` que
 * morava aqui (oficina de mobilidade nascia com a marca ligada) saiu junto: a
 * operação nova nasce sem plaquinha, e a tela de Empresas não oferece a caixa.
 */
import { apiRequest } from './client';

export const empresaPlaquinhaApi = {
  definir: (companyId: string, enabled: boolean) =>
    apiRequest<{ companyId: string; usesEquipmentTags: boolean }>(
      `/core/companies/${companyId}/equipment-tags`,
      { method: 'PATCH', body: { enabled } },
    ),
};
