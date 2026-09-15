/**
 * A PLAQUINHA DA MOTO, REIMPRESSA POR QUEM A VENDE (GAP-PRD-190).
 *
 * ## O defeito
 *
 * A moto do pátio da PJ Motors é duas linhas: a UNIDADE na loja (o que o
 * balcão vende) e o EQUIPAMENTO na Oficina (plaquinha, QR, histórico). As duas
 * rotas de impressão procuram o equipamento pela empresa da SESSÃO — e a da PJ
 * não tem equipamento nenhum: a folha voltava "Equipamento não encontrado" e o
 * adesivo descolado no pátio exigia ir até a Oficina.
 *
 * ## A autorização é a unidade, como em `plaquinhaDaUnidade`
 *
 * A unidade é conferida contra a empresa da sessão (404 se não for dela); a
 * plaquinha é lida pelo vínculo da própria unidade — é a travessia que a ponte
 * do estoque já faz, e só ela: nenhum id de equipamento vem do corpo.
 *
 * ## A mesma cara da folha da Oficina
 *
 * O adesivo reimpresso é o MESMO adesivo: mesmo número, mesmo QR (o token da
 * máquina não muda — reimprimir não é trocar), mesma identidade visual. Por
 * isso o layout e o nome no rodapé são os da empresa DONA da plaquinha, e não
 * os da loja que pediu. Trocar o número (adesivo perdido, QR vazado) continua
 * sendo a substituição, que é da Oficina.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { exigirEmpresaComPlaquinha, formatTagId } from './EquipmentTagPoolService.js';
import { plaquinhaDaUnidade } from './EquipmentStockLink.js';
import { capabilitiesFor } from './WorkshopCapabilities.js';
import { equipmentTagFormat } from './EquipmentTagFormats.js';
import { layoutDaEmpresa } from './EquipmentTagLayoutService.js';
import { renderEquipmentTagSheet, type FolhaDePlaquinhas } from './EquipmentTagSheet.js';
import { publicBaseUrl, publicBaseUrlConfigurada } from './PublicUrl.js';
import { recordEquipmentEvent } from './EquipmentService.js';

export interface FolhaDaUnidade extends FolhaDePlaquinhas {
  formatId: string;
  publicIdLabel: string;
  equipmentId: string;
  baseUrl: string;
  baseUrlConfigurada: boolean;
}

export function folhaDaPlaquinhaDaUnidade(input: {
  companyId: string;
  unitId: string;
  userId: string;
  formatId?: string;
}): FolhaDaUnidade {
  exigirEmpresaComPlaquinha(input.companyId);
  // Confere a unidade contra a empresa da sessão — 404 se não for dela.
  const vinculo = plaquinhaDaUnidade(input.companyId, input.unitId);
  if (!vinculo) {
    throw new ApiError(
      'CORE_UNIT_WITHOUT_TAG',
      'Esta unidade não tem plaquinha vinculada. Vincule a plaquinha da Oficina antes de imprimir.',
      409,
    );
  }

  const db = getConnection();
  const maquina = db
    .prepare(
      `SELECT e.id, e.company_id, e.public_id, e.public_token, e.brand, e.model,
              w.kind AS workshop_kind, w.name AS workshop_name
         FROM core_equipment e
         JOIN core_workshops w ON w.id = e.workshop_id AND w.company_id = e.company_id
        WHERE e.id = ?`,
    )
    .get(vinculo.id) as
    | {
        id: string;
        company_id: string;
        public_id: number;
        public_token: string;
        brand: string | null;
        model: string | null;
        workshop_kind: string;
        workshop_name: string;
      }
    | undefined;
  if (!maquina) throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Plaquinha não encontrada.', 404);
  if (!capabilitiesFor(maquina.workshop_kind).equipmentTags) {
    throw new ApiError(
      'CORE_WORKSHOP_NO_TAGS',
      `${maquina.workshop_name} não usa plaquinha: o aparelho é identificado pela própria OS.`,
      409,
    );
  }

  const formato = equipmentTagFormat(input.formatId);
  const rotulo = formatTagId(maquina.public_id);
  /*
    A CARA DO ADESIVO É A DA PJ MOTORS (P0 das plaquinhas).

    O cabeçalho deste arquivo dizia que o layout é o da empresa DONA da
    máquina — a Oficina. Com a plaquinha exclusiva da PJ, a Oficina não edita
    mais layout nenhum (`PUT /equipment-tags/layout` recusa), e a reimpressão
    sairia para sempre com o layout congelado de lá, enquanto o editor da tela
    de Plaquinhas — o da PJ — mudaria um desenho que nenhuma folha usa. A
    empresa que gere a plaquinha é a que chama esta função (já conferida por
    `exigirEmpresaComPlaquinha` acima), e é dela o layout e o nome no papel.
    O número e o QR continuam os da máquina: reimprimir não é trocar.
  */
  const folha = renderEquipmentTagSheet({
    companyId: input.companyId,
    format: formato,
    layout: layoutDaEmpresa(input.companyId),
    items: [
      {
        publicIdLabel: rotulo,
        // O endereço sai da configuração, nunca do host de quem imprime: o
        // adesivo fica anos no guidão da moto.
        qrUrl: `${publicBaseUrl()}/equipamento/${maquina.public_token}`,
        brand: maquina.brand,
        model: maquina.model,
      },
    ],
  });

  // O histórico da máquina mora na empresa DELA, e diz quem reimprimiu.
  const loja = db
    .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
    .get(input.companyId) as { trade_name: string } | undefined;
  recordEquipmentEvent({
    equipmentId: maquina.id,
    companyId: maquina.company_id,
    eventType: 'label_printed',
    description: `Plaquinha ${rotulo} reimpressa por ${loja?.trade_name ?? 'outra operação'}, pela unidade de estoque`,
    userId: input.userId,
  });

  return {
    ...folha,
    formatId: formato.id,
    publicIdLabel: rotulo,
    equipmentId: maquina.id,
    baseUrl: publicBaseUrl(),
    baseUrlConfigurada: publicBaseUrlConfigurada(),
  };
}
