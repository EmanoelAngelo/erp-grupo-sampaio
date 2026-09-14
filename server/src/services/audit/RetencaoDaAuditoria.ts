/**
 * ============================================================================
 * A TRILHA DE AUDITORIA TEM PRAZO — e o prazo está escrito (GAP-PRD-073)
 * ============================================================================
 *
 * `core_audit_log` nunca era podada. Não carrega CPF (a auditoria leu o banco
 * real: nenhum detalhe de cliente traz documento), mas carrega QUEM fez o quê
 * e quando — o login de cada funcionário, o id de cada cliente tocado —, e a
 * LGPD pede que dado pessoal tenha prazo declarado (art. 15 e 16), não "para
 * sempre por omissão".
 *
 * ## Por que cinco anos
 *
 * É o prazo em que a trilha ainda responde a uma pergunta que alguém pode
 * fazer com força de lei: a decadência tributária (CTN, art. 173) e a guarda
 * dos documentos fiscais que muitas destas linhas explicam — cancelamento de
 * venda, inutilização de numeração, estorno. Antes disso apagar seria jogar
 * fora a defesa da loja; depois disso guardar é só acumular dado de gente.
 * A declaração que o dono lê na tela (`PoliticaDeRetencao`) cita esta mesma
 * constante — o texto não tem como divergir do código.
 *
 * ## Por que uma vez por dia, e amortizada na emissão de sessão
 *
 * O índice da tabela é `(company_id, created_at)`: um DELETE por data sozinha
 * varre a trilha inteira. Rodar a cada login seria o defeito do GAP-PRD-069 de
 * volta (varredura síncrona no processo do PDV). Uma vez a cada 24 horas de
 * processo, pendurada na mesma poda amortizada das sessões, custa uma
 * varredura por dia — e nenhum agendador para alguém esquecer de subir.
 *
 * A poda nunca derruba um login: quem chama engole e registra a falha.
 */
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection } from '../../db/sqlite.js';

/** Por quantos anos a trilha de auditoria é guardada. */
export const RETENCAO_DA_AUDITORIA_ANOS = 5;

const UM_DIA_MS = 24 * 3600 * 1000;

/** Quando a última poda rodou neste processo (0 = ainda não rodou). */
let ultimaPodaEm = 0;

/**
 * Apaga as linhas da trilha mais velhas que o prazo. Devolve quantas saíram.
 *
 * ISO-8601 em UTC ordena como texto. Linha sem data não é apagada — não há
 * idade que se leia nela (o mesmo critério de `api_request_logs`).
 */
export function podarTrilhaDeAuditoria(agora: number = Date.now()): number {
  ensureCoreSchema();
  const limite = new Date(agora);
  limite.setUTCFullYear(limite.getUTCFullYear() - RETENCAO_DA_AUDITORIA_ANOS);
  const r = getConnection()
    .prepare('DELETE FROM core_audit_log WHERE created_at IS NOT NULL AND created_at < ?')
    .run(limite.toISOString());
  ultimaPodaEm = agora;
  return Number(r.changes ?? 0);
}

/** A poda da trilha, no máximo uma vez a cada 24 horas de processo. */
export function podarTrilhaDeAuditoriaSeForAHora(agora: number = Date.now()): void {
  if (ultimaPodaEm !== 0 && agora - ultimaPodaEm < UM_DIA_MS) return;
  podarTrilhaDeAuditoria(agora);
}
