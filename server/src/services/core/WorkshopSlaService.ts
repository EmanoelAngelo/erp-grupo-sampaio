/**
 * SLA da oficina — os tempos de resposta por coluna × prioridade (rodada 51).
 *
 * ## O que o SLA é, e o que ele não é
 *
 * O SLA é a régua de REAÇÃO do quadro: quantas horas uma OS pode ficar numa
 * coluna, dada a prioridade, antes de o card acender (75% = atenção âmbar,
 * 100% = estourado vermelho). Ele NÃO é o prazo prometido ao cliente — esse é
 * `due_date`, definido por gente, OS a OS.
 *
 * Só quatro colunas têm SLA — as em que a OS está ESPERANDO alguém: em
 * andamento, manutenção externa, parada no setor e aguardando peça. Em
 * aberto, fila de pagamento e finalizada ficam fora, como no sistema anterior
 * da oficina, de onde esta tabela inteira foi portada (valores verbatim).
 *
 * ## Onde a configuração mora — e por que no banco
 *
 * No sistema anterior o gestor editava o SLA num modal e o valor ficava no
 * localStorage DO NAVEGADOR: cada máquina podia ter uma régua diferente, e o
 * quadro discordava de si mesmo entre o balcão e o escritório. Aqui a régua é
 * POR EMPRESA, no banco (`core_workshop_sla_configs`) — célula ausente vale o
 * padrão, empresa sem linha nenhuma opera exatamente como sempre operou. É a
 * mesma filosofia do `core_sale_policies`: nulo significa "o comportamento de
 * hoje", e preencher é decisão do gestor, não default inventado.
 *
 * O ALERTA em si é calculado na tela (o quadro já tem os cards na mão e o
 * relógio anda sem requisição); o que o servidor garante é a régua única e a
 * base honesta do relógio — `status_changed_at`, gravado a cada mudança de
 * coluna. O sistema anterior contava do `updatedAt`, que reiniciava a cada
 * comentário ou foto: o card "esquecia" o atraso toda vez que alguém tocava
 * na OS. Esse defeito ficou lá.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { ORDER_PRIORITIES, type OrderPriority } from './WorkshopCoreService.js';

/** As colunas que têm SLA — a OS está esperando alguém nelas. */
export const SLA_STATUSES = [
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
] as const;
export type SlaStatus = (typeof SLA_STATUSES)[number];

const SLA_STATUS_SET = new Set<string>(SLA_STATUSES);
const PRIORITY_SET = new Set<string>(ORDER_PRIORITIES);

/** Menor e maior régua aceitas: 1 hora a 30 dias — os limites do antigo. */
const MIN_HOURS = 1;
const MAX_HOURS = 720;

/**
 * A tabela padrão, portada VERBATIM do sistema anterior da oficina — cada
 * número foi calibrado lá pelo uso real (ex.: "4 horas — entrega não pode
 * esperar"; "120 horas — peça pode ser importada").
 */
export const DEFAULT_SLA: Record<SlaStatus, Record<OrderPriority, number>> = {
  em_andamento: { urgente: 4, alta: 8, media: 16, baixa: 24 },
  manutencao_externa: { urgente: 24, alta: 48, media: 72, baixa: 96 },
  parada_setor: { urgente: 8, alta: 16, media: 24, baixa: 48 },
  aguardando_peca: { urgente: 48, alta: 72, media: 96, baixa: 120 },
};

export type SlaMatrix = Record<SlaStatus, Record<OrderPriority, number>>;

/**
 * A régua RESOLVIDA da empresa: padrão + células que o gestor personalizou.
 *
 * Devolve também quais células são personalizadas — a tela pinta a célula
 * alterada e mostra o padrão dela, para o gestor saber o que mexeu.
 */
export function getSlaConfig(companyId: string): {
  matrix: SlaMatrix;
  custom: { status: SlaStatus; priority: OrderPriority; hours: number }[];
} {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      'SELECT status, priority, hours FROM core_workshop_sla_configs WHERE company_id = ?',
    )
    .all(companyId) as unknown as { status: string; priority: string; hours: number }[];

  const matrix: SlaMatrix = structuredClone(DEFAULT_SLA);
  const custom: { status: SlaStatus; priority: OrderPriority; hours: number }[] = [];
  for (const linha of linhas) {
    // Linha fora da grade (status que perdeu SLA numa rodada futura) é
    // ignorada em vez de estourar: régua velha não derruba o quadro.
    if (!SLA_STATUS_SET.has(linha.status) || !PRIORITY_SET.has(linha.priority)) continue;
    matrix[linha.status as SlaStatus][linha.priority as OrderPriority] = linha.hours;
    custom.push({
      status: linha.status as SlaStatus,
      priority: linha.priority as OrderPriority,
      hours: linha.hours,
    });
  }
  return { matrix, custom };
}

/**
 * Grava a régua da empresa — a MATRIZ INTEIRA, célula a célula.
 *
 * Célula igual ao padrão é APAGADA em vez de gravada: assim "personalizado"
 * significa de verdade "diferente do padrão", e restaurar o padrão de uma
 * célula é simplesmente devolvê-la ao valor de fábrica.
 */
export function saveSlaConfig(
  companyId: string,
  matrix: unknown,
): ReturnType<typeof getSlaConfig> {
  ensureCoreSchema();
  const bruto = (matrix ?? {}) as Record<string, Record<string, unknown>>;

  const celulas: { status: SlaStatus; priority: OrderPriority; hours: number }[] = [];
  for (const status of SLA_STATUSES) {
    for (const priority of ORDER_PRIORITIES) {
      const valor = bruto?.[status]?.[priority];
      if (valor === undefined) continue;
      const hours = Number(valor);
      if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
        throw new ApiError(
          'CORE_SLA_INVALID_HOURS',
          `SLA inválido em ${status}/${priority}: use um número inteiro de ${MIN_HOURS} a ${MAX_HOURS} horas.`,
          400,
        );
      }
      celulas.push({ status, priority, hours });
    }
  }
  // Chave fora da grade (status inventado, prioridade errada) é 400, não
  // silêncio: o gestor digitou num lugar que não existe.
  for (const status of Object.keys(bruto)) {
    if (!SLA_STATUS_SET.has(status)) {
      throw new ApiError(
        'CORE_SLA_INVALID_CELL',
        `"${status}" não tem SLA — só em andamento, manutenção externa, parada no setor e aguardando peça.`,
        400,
      );
    }
    for (const priority of Object.keys(bruto[status] ?? {})) {
      if (!PRIORITY_SET.has(priority)) {
        throw new ApiError(
          'CORE_SLA_INVALID_CELL',
          `Prioridade desconhecida no SLA: ${priority}.`,
          400,
        );
      }
    }
  }

  const db = getConnection();
  const agora = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO core_workshop_sla_configs (company_id, status, priority, hours, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (company_id, status, priority)
       DO UPDATE SET hours = excluded.hours, updated_at = excluded.updated_at`,
  );
  const apagar = db.prepare(
    'DELETE FROM core_workshop_sla_configs WHERE company_id = ? AND status = ? AND priority = ?',
  );
  for (const c of celulas) {
    if (c.hours === DEFAULT_SLA[c.status][c.priority]) {
      apagar.run(companyId, c.status, c.priority);
    } else {
      upsert.run(companyId, c.status, c.priority, c.hours, agora);
    }
  }
  return getSlaConfig(companyId);
}

/** Restaura o padrão inteiro da empresa — apaga toda personalização. */
export function resetSlaConfig(companyId: string): ReturnType<typeof getSlaConfig> {
  ensureCoreSchema();
  getConnection()
    .prepare('DELETE FROM core_workshop_sla_configs WHERE company_id = ?')
    .run(companyId);
  return getSlaConfig(companyId);
}
