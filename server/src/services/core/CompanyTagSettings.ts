/**
 * QUEM USA PLAQUINHA COM QR — escolhido pela tela, não por migração
 * (GAP-PRD-185).
 *
 * ## O defeito
 *
 * `core_companies.uses_equipment_tags` só tinha um escritor: o passo de
 * migração que marca os slugs `oficina` e `pj-motors`. A sétima operação de
 * oficina nascia pela tela de Empresas (a promessa "empresa nova sem código") e
 * batia em `CORE_COMPANY_NO_TAGS` na primeira folha de plaquinhas — ligar a
 * marca pedia um UPDATE à mão no banco.
 *
 * ## A escolha, e o padrão
 *
 * Quem abre a operação escolhe na criação; quem responde pelo grupo liga ou
 * desliga depois. Sem escolha explícita, o padrão é o que a própria bancada já
 * diz: `capabilitiesFor('mobility').equipmentTags` é verdadeiro (moto passa
 * dias no pátio e ganha plaquinha), e celular e loja nascem sem. É o mesmo
 * critério que `/labels/equipment` usa para decidir se a máquina ganha QR —
 * uma oficina de mobilidade sem a marca imprimia a plaquinha de cada máquina e
 * não conseguia usar o pool, que é a contradição que o padrão elimina.
 *
 * ## Desligar tem uma recusa
 *
 * Plaquinha já impressa esperando máquina (`gerada` ou `disponivel`) é adesivo
 * que existe no mundo com número do grupo. Desligar a marca com elas no pool
 * as deixaria sem caminho — a marcação de danificada passa pelo mesmo guarda.
 * A recusa diz quantas são e o que fazer. As plaquinhas já COLADAS continuam
 * respondendo pelo QR: desligar só fecha o pool para lotes novos.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { capabilitiesFor } from './WorkshopCapabilities.js';

/** O padrão de uma operação nova, derivado do que a bancada dela faz. */
export function plaquinhaPadraoDaEmpresaNova(kind: string, workshopKind?: string | null): boolean {
  if (kind !== 'workshop') return false;
  return capabilitiesFor(workshopKind === 'phones' ? 'phones' : 'mobility').equipmentTags;
}

/**
 * A escolha vinda do corpo. Ausente = usar o padrão; booleano = a escolha;
 * qualquer outra coisa é 400 — "sim" em texto não liga numeração do grupo.
 */
export function lerEscolhaDePlaquinha(valor: unknown): boolean | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== 'boolean') {
    throw new ApiError(
      'CORE_COMPANY_TAGS_INVALID',
      'Diga se a operação usa plaquinha com QR com verdadeiro ou falso.',
      400,
    );
  }
  return valor;
}

/** Grava a marca — chamada dentro da transação que cria a empresa. */
export function gravarPlaquinhaDaEmpresa(companyId: string, usa: boolean): void {
  getConnection()
    .prepare('UPDATE core_companies SET uses_equipment_tags = ?, updated_at = ? WHERE id = ?')
    .run(usa ? 1 : 0, new Date().toISOString(), companyId);
}

export interface MudancaDePlaquinha {
  companyId: string;
  tradeName: string;
  antes: boolean;
  depois: boolean;
}

/** Liga ou desliga a plaquinha de uma operação que já existe. */
export function definirPlaquinhaDaEmpresa(input: { companyId: string; enabled: unknown }): MudancaDePlaquinha {
  ensureCoreSchema();
  const escolha = lerEscolhaDePlaquinha(input.enabled);
  if (escolha === undefined) {
    throw new ApiError(
      'CORE_COMPANY_TAGS_INVALID',
      'Diga se a operação usa plaquinha com QR com verdadeiro ou falso.',
      400,
    );
  }
  const db = getConnection();
  const empresa = db
    .prepare('SELECT id, trade_name, uses_equipment_tags FROM core_companies WHERE id = ? AND active = 1')
    .get(input.companyId) as { id: string; trade_name: string; uses_equipment_tags: number } | undefined;
  if (!empresa) {
    throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Empresa não encontrada.', 404);
  }
  const antes = Number(empresa.uses_equipment_tags) === 1;

  if (antes && !escolha) {
    const pendentes = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM core_equipment_tags
          WHERE company_id = ? AND status IN ('gerada', 'disponivel')
          GROUP BY status`,
      )
      .all(input.companyId) as unknown as { status: string; n: number }[];
    const total = pendentes.reduce((s, p) => s + Number(p.n), 0);
    if (total > 0) {
      throw new ApiError(
        'CORE_COMPANY_TAGS_PENDING',
        `${empresa.trade_name} tem ${total} plaquinha(s) no pool esperando máquina. `
          + 'Associe-as ou marque-as como danificadas em Plaquinhas antes de desligar.',
        409,
        { pendentes },
      );
    }
  }

  if (antes !== escolha) gravarPlaquinhaDaEmpresa(input.companyId, escolha);
  return { companyId: empresa.id, tradeName: empresa.trade_name, antes, depois: escolha };
}
