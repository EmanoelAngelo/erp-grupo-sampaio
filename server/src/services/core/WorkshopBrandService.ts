/**
 * QUEM ASSINA O PAPEL DA BANCADA — e por que isso é configuração, não código.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * A Ordem de Serviço da Oficina saía com o nome PJ MOTORS. O dado estava
 * errado (`core_workshops.brand_company_id` da bancada de mobilidade apontava
 * para `pj-motors`), mas trocar o dado não bastava: quem o punha lá era uma
 * MIGRAÇÃO, com o vínculo cravado em código, reimpondo-o a cada execução.
 *
 *     UPDATE core_workshops SET ..., brand_company_id = ? WHERE id = ?
 *
 * Corrigir pela tela duraria até o próximo deploy. Semear é escrever o que
 * ainda não existe; o que já existe tem dono, e o dono é quem opera.
 *
 * ============================================================================
 * POR QUE O VÍNCULO EXISTE
 * ============================================================================
 *
 * Ele NÃO é um erro de modelagem: uma bancada pode legitimamente assinar em
 * nome de outra operação do grupo — quem vendeu a moto é quem responde pela
 * garantia dela. O que estava errado era a escolha estar fora do alcance de
 * quem opera, e ser silenciosa: o papel saía com outro nome e nada na tela
 * dizia por quê.
 *
 * Aqui a escolha vira um ato explícito, com auditoria, recusando empresa que
 * não existe e bancada que não é da operação.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';

export interface MarcaDaBancada {
  workshopId: string;
  workshopName: string;
  /** Nulo quando a bancada assina em nome próprio. */
  brandCompanyId: string | null;
  brandName: string | null;
}

/** Como cada bancada da operação assina hoje. Para a tela administrativa. */
export function listarMarcasDasBancadas(companyId: string): MarcaDaBancada[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT w.id AS workshopId, w.name AS workshopName,
              w.brand_company_id AS brandCompanyId,
              c.trade_name AS brandName
         FROM core_workshops w
         LEFT JOIN core_companies c ON c.id = w.brand_company_id
        WHERE w.company_id = ?
        ORDER BY w.name COLLATE NOCASE`,
    )
    .all(companyId) as unknown as MarcaDaBancada[];
}

/**
 * Define em nome de quem esta bancada imprime.
 *
 * @param brandCompanyId nulo devolve a bancada ao nome próprio — que é o
 * padrão, e o que a Oficina passou a usar por decisão do dono.
 */
export function definirMarcaDaBancada(input: {
  companyId: string;
  workshopId: string;
  brandCompanyId: string | null;
  userId?: string | null;
}): MarcaDaBancada {
  ensureCoreSchema();
  const db = getConnection();

  /*
    A bancada tem de ser DESTA operação. Sem esta conferência, um gerente
    trocaria a identidade impressa da oficina vizinha — e o papel dela sairia
    com o nome da empresa dele, sem ninguém do outro lado saber.
  */
  const bancada = db
    .prepare('SELECT id, name, brand_company_id FROM core_workshops WHERE id = ? AND company_id = ?')
    .get(input.workshopId, input.companyId) as
    | { id: string; name: string; brand_company_id: string | null }
    | undefined;
  if (!bancada) {
    throw new ApiError('CORE_WORKSHOP_NOT_FOUND', 'Bancada não encontrada nesta operação.', 404);
  }

  const marca = input.brandCompanyId?.trim() || null;
  if (marca) {
    const empresa = db
      .prepare('SELECT id, trade_name FROM core_companies WHERE id = ? AND active = 1')
      .get(marca) as { id: string; trade_name: string } | undefined;
    if (!empresa) {
      throw new ApiError(
        'CORE_BRAND_COMPANY_NOT_FOUND',
        'Empresa da marca não encontrada. Escolha uma operação ativa do grupo.',
        404,
      );
    }
  }

  db.prepare('UPDATE core_workshops SET brand_company_id = ? WHERE id = ?').run(
    marca,
    bancada.id,
  );

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'workshop.brand.set',
    entityType: 'core_workshops',
    entityId: bancada.id,
    detail: { de: bancada.brand_company_id, para: marca, bancada: bancada.name },
  });

  const [atual] = listarMarcasDasBancadas(input.companyId).filter((b) => b.workshopId === bancada.id);
  return atual;
}
