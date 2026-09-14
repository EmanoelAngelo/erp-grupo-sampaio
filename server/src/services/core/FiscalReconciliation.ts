/**
 * Reconciliação fiscal: encontra incoerências, não as conserta sozinha.
 *
 * A tentação aqui é o botão "corrigir tudo". Ele seria um desastre: corrigir
 * um documento fiscal sem evidência externa significa DECIDIR o que a SEFAZ
 * respondeu — exatamente o que o autorizador falso fazia. Quando o conserto
 * depende do fisco, o caminho é CONSULTAR, e a consulta tem lugar próprio.
 *
 * Cada achado explica o que está errado, por que importa e o que fazer. Um
 * relatório que só lista códigos obriga quem lê a adivinhar a gravidade.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { TEST_PROTOCOL_PREFIX } from './SefazTestAdapter.js';

export type IssueSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface ReconciliationIssue {
  check: string;
  severity: IssueSeverity;
  /** O que foi encontrado, em português de gente. */
  summary: string;
  /** Por que isso importa — a consequência de deixar como está. */
  impact: string;
  /** O que fazer. Nunca "corrigir automaticamente". */
  action: string;
  documentIds: string[];
  count: number;
}

/** Documentos parados em envio há tempo demais. */
const SENDING_STALE_MINUTES = 30;

/**
 * Incoerências que o BANCO já torna impossíveis — e por isso NÃO viram
 * checagem aqui.
 *
 * Uma verificação que nunca pode disparar dá falsa sensação de cobertura e
 * ainda custa uma consulta a cada abertura da tela. Ficam documentadas para
 * que ninguém as adicione achando que faltavam.
 */
export const DB_ENFORCED_INVARIANTS = [
  'CANCEL_EVENT_WITHOUT_DOCUMENT — core_fiscal_events.document_id tem chave estrangeira '
    + 'para core_fiscal_documents(id); evento órfão não é gravável.',
  'QUEUE_WITHOUT_DOCUMENT — mesma chave estrangeira em core_fiscal_queue.document_id.',
  'DUPLICATE_ACCESS_KEY — UNIQUE (access_key) no documento.',
  'DUPLICATE_NUMBER — UNIQUE (company_id, model, serie, number).',
  'Documento duplicado para a mesma venda e modelo — UNIQUE (company_id, idempotency_key).',
] as const;

function query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
}

export function runReconciliation(companyId: string): ReconciliationIssue[] {
  ensureCoreSchema();
  const issues: ReconciliationIssue[] = [];

  const add = (
    check: string,
    severity: IssueSeverity,
    rows: Record<string, unknown>[],
    summary: (n: number) => string,
    impact: string,
    action: string,
    idKey = 'id',
  ): void => {
    if (rows.length === 0) return;
    issues.push({
      check,
      severity,
      summary: summary(rows.length),
      impact,
      action,
      documentIds: rows.map((r) => String(r[idKey])).slice(0, 50),
      count: rows.length,
    });
  };

  const limite = new Date(Date.now() - SENDING_STALE_MINUTES * 60_000).toISOString();

  add(
    'SENDING_TOO_LONG',
    'CRITICAL',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND status = 'SENDING' AND updated_at < ?`,
      [companyId, limite],
    ),
    (n) => `${n} documento(s) parado(s) em envio há mais de ${SENDING_STALE_MINUTES} minutos.`,
    'A SEFAZ pode já ter autorizado sem que a resposta tenha chegado. Enquanto o estado '
      + 'local não for resolvido, a venda fica sem nota e um reenvio às cegas duplicaria.',
    'Consultar a chave na SEFAZ. NÃO reenviar antes da consulta.',
  );

  // A invariante mais importante: autorizado sem protocolo não é autorizado.
  add(
    'AUTHORIZED_WITHOUT_PROTOCOL',
    'CRITICAL',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND status = 'AUTHORIZED'
          AND (protocol IS NULL OR TRIM(protocol) = '')`,
      [companyId],
    ),
    (n) => `${n} documento(s) marcado(s) como autorizado(s) sem protocolo.`,
    'Autorização sem protocolo não é autorização. Se isso existe, algum caminho gravou o '
      + 'estado sem evidência da SEFAZ — a mesma falha do autorizador que foi removido.',
    'Investigar a origem do registro e consultar a chave. Não imprimir DANFCE.',
  );

  add(
    'AUTHORIZED_WITHOUT_XML',
    'WARNING',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND status = 'AUTHORIZED'
          AND (xml_authorized IS NULL OR TRIM(xml_authorized) = '')`,
      [companyId],
    ),
    (n) => `${n} documento(s) autorizado(s) sem o XML de retorno guardado.`,
    'O XML autorizado é o que comprova a nota perante o fisco e o cliente. Sem ele, uma '
      + 'contestação futura não tem como ser respondida.',
    'Consultar a chave para recuperar o XML protocolado.',
  );

  /*
    A VENDA CANCELADA NO ERP COM A NOTA AINDA VÁLIDA NA SEFAZ (E-venda-servidor-05).

    `cancelSale` passou a recusar a venda que tem NFC-e autorizada (ou a caminho),
    mandando cancelar a nota primeiro. Esta checagem pega o que ficou de ANTES da
    trava: a venda sumiu do caixa e do estoque, e a nota segue emitida — o fisco
    cobra o imposto de uma venda que a loja diz não ter feito.
  */
  add(
    'SALE_CANCELLED_WITH_AUTHORIZED_DOCUMENT',
    'CRITICAL',
    query(
      `SELECT d.id FROM core_fiscal_documents d
         JOIN core_sales s ON s.id = d.sale_id AND s.company_id = d.company_id
        WHERE d.company_id = ? AND d.status = 'AUTHORIZED' AND s.status = 'cancelled'`,
      [companyId],
    ),
    (n) => `${n} nota(s) autorizada(s) de venda(s) cancelada(s) no sistema.`,
    'A venda saiu do caixa e do estoque, mas a nota continua válida na SEFAZ: o imposto é '
      + 'devido sobre uma venda que a loja registra como desfeita.',
    'Cancelar a nota na SEFAZ (evento de cancelamento, dentro do prazo) ou, fora do prazo, '
      + 'emitir a nota de devolução/entrada correspondente com o contador.',
  );

  add(
    'REJECTED_WITH_PROTOCOL',
    'CRITICAL',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND status = 'REJECTED'
          AND protocol IS NOT NULL AND TRIM(protocol) <> ''`,
      [companyId],
    ),
    (n) => `${n} documento(s) rejeitado(s) que carregam protocolo.`,
    'Rejeição não gera protocolo de autorização. A combinação sugere que uma resposta foi '
      + 'aplicada por cima de outra — e o estado atual pode estar invertido.',
    'Consultar a chave para saber a situação real antes de qualquer ação.',
  );

  add(
    'DUPLICATE_ACCESS_KEY',
    'CRITICAL',
    query(
      `SELECT MIN(id) AS id, access_key FROM core_fiscal_documents
        WHERE company_id = ? AND access_key IS NOT NULL
        GROUP BY access_key HAVING COUNT(*) > 1`,
      [companyId],
    ),
    (n) => `${n} chave(s) de acesso repetida(s).`,
    'A chave identifica o documento perante a SEFAZ. Duas locais com a mesma chave '
      + 'significam que uma delas será rejeitada por duplicidade.',
    'Identificar qual foi efetivamente transmitida e inutilizar a numeração da outra.',
  );

  add(
    'DUPLICATE_NUMBER',
    'CRITICAL',
    query(
      `SELECT MIN(id) AS id FROM core_fiscal_documents
        WHERE company_id = ?
        GROUP BY model, serie, number HAVING COUNT(*) > 1`,
      [companyId],
    ),
    (n) => `${n} numeração(ões) repetida(s) no mesmo modelo e série.`,
    'Número repetido é rejeição certa na SEFAZ, com a venda já registrada.',
    'Verificar a série e inutilizar a faixa afetada.',
  );

  add(
    'QUEUE_WITHOUT_DOCUMENT',
    'WARNING',
    query(
      `SELECT q.id FROM core_fiscal_queue q
        LEFT JOIN core_fiscal_documents d ON d.id = q.document_id
       WHERE q.company_id = ? AND d.id IS NULL`,
      [companyId],
    ),
    (n) => `${n} item(ns) na fila apontando para documento inexistente.`,
    'O worker tentará processar algo que não existe, gastando tentativas e poluindo a '
      + 'auditoria até morrer por esgotamento.',
    'Remover os itens órfãos da fila.',
  );

  add(
    'DOCUMENT_WITHOUT_QUEUE',
    'WARNING',
    query(
      `SELECT d.id FROM core_fiscal_documents d
        LEFT JOIN core_fiscal_queue q ON q.document_id = d.id
       WHERE d.company_id = ? AND d.status IN ('QUEUED', 'SENDING') AND q.id IS NULL`,
      [companyId],
    ),
    (n) => `${n} documento(s) em fila sem item correspondente.`,
    'O documento nunca será transmitido: ninguém vai buscá-lo. A venda fica sem nota e '
      + 'sem ninguém perceber.',
    'Reenfileirar o documento.',
  );

  add(
    'CONTINGENCY_PENDING',
    'WARNING',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND contingency_mode IS NOT NULL
          AND status NOT IN ('AUTHORIZED', 'CANCELLED')`,
      [companyId],
    ),
    (n) => `${n} documento(s) em contingência ainda não transmitido(s).`,
    'Contingência tem prazo. Documento que não for transmitido dentro dele deixa de ser '
      + 'regularizável pelo caminho normal.',
    'Transmitir assim que a conexão permitir.',
  );

  /**
   * A checagem que impede o pior cenário: cupom de teste circulando como nota.
   */
  add(
    'TEST_PROVIDER_IN_PRODUCTION',
    'CRITICAL',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND environment = 'production'
          AND protocol LIKE ?`,
      [companyId, `${TEST_PROTOCOL_PREFIX}%`],
    ),
    (n) => `${n} documento(s) de PRODUÇÃO com protocolo do provider de teste.`,
    'Essas notas NÃO existem para o fisco. As vendas correspondentes estão sem documento '
      + 'fiscal válido, e o cliente recebeu um cupom que não vale.',
    'Interromper a emissão, apurar o período afetado e regularizar com o contador.',
  );

  add(
    'LOCAL_REMOTE_STATUS_MISMATCH',
    'WARNING',
    query(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND status = 'AUTHORIZED' AND c_stat IS NOT NULL
          AND c_stat NOT IN ('100', '150')`,
      [companyId],
    ),
    (n) => `${n} documento(s) autorizado(s) localmente com cStat que não é de autorização.`,
    'O estado local diz uma coisa e o código do fisco diz outra. Uma das duas informações '
      + 'está errada, e a nota pode não valer.',
    'Consultar a chave e reconciliar pelo que a SEFAZ responder.',
  );

  // ------------------------------------------------ eventos fiscais

  add(
    'CANCELLED_WITHOUT_PROTOCOL',
    'CRITICAL',
    query(
      `SELECT d.id FROM core_fiscal_documents d
        WHERE d.company_id = ? AND d.status = 'CANCELLED'
          AND NOT EXISTS (
            SELECT 1 FROM core_fiscal_events e
             WHERE e.document_id = d.id AND e.event_type = 'cancelled'
               AND e.protocol IS NOT NULL AND TRIM(e.protocol) <> ''
          )`,
      [companyId],
    ),
    (n) => `${n} documento(s) cancelado(s) sem protocolo do evento.`,
    'Cancelamento sem protocolo não é cancelamento. A nota pode continuar válida para o '
      + 'fisco enquanto o sistema a trata como cancelada.',
    'Consultar a chave na SEFAZ e reconciliar pelo que ela responder.',
  );

  /** O inverso do anterior, e igualmente grave. */
  add(
    'CANCEL_REJECTED_BUT_DOCUMENT_CANCELLED',
    'CRITICAL',
    query(
      `SELECT d.id FROM core_fiscal_documents d
        WHERE d.company_id = ? AND d.status = 'CANCELLED'
          AND EXISTS (SELECT 1 FROM core_fiscal_events e
                       WHERE e.document_id = d.id AND e.event_type = 'cancel_rejected')
          AND NOT EXISTS (SELECT 1 FROM core_fiscal_events e2
                           WHERE e2.document_id = d.id AND e2.event_type = 'cancelled')`,
      [companyId],
    ),
    (n) => `${n} documento(s) marcado(s) como cancelado(s) apesar de o evento ter sido recusado.`,
    'O fisco recusou o cancelamento, mas o sistema o aplicou. A nota vale e está sendo '
      + 'tratada como se não valesse.',
    'Consultar a chave e corrigir o estado local pelo que a SEFAZ responder.',
  );

  add(
    'CCE_WITHOUT_AUTHORIZED_NFE',
    'WARNING',
    query(
      `SELECT e.document_id AS id FROM core_fiscal_events e
         JOIN core_fiscal_documents d ON d.id = e.document_id
        WHERE e.company_id = ? AND e.event_type = 'cce_authorized'
          AND d.status NOT IN ('AUTHORIZED', 'CANCELLED')`,
      [companyId],
    ),
    (n) => `${n} carta(s) de correção em documento que não está autorizado.`,
    'Carta de correção só existe para nota autorizada. A combinação sugere que o estado '
      + 'do documento regrediu depois da carta.',
    'Verificar a linha do tempo do documento antes de qualquer ação.',
  );

  add(
    'CCE_AUTHORIZED_WITHOUT_PROTOCOL',
    'CRITICAL',
    query(
      `SELECT document_id AS id FROM core_fiscal_events
        WHERE company_id = ? AND event_type = 'cce_authorized'
          AND (protocol IS NULL OR TRIM(protocol) = '')`,
      [companyId],
    ),
    (n) => `${n} carta(s) registrada(s) como aceita(s) sem protocolo.`,
    'Sem protocolo o evento não foi aceito. A correção não existe para o fisco.',
    'Reenviar a carta ou consultar os eventos da chave.',
  );

  add(
    'CCE_SEQUENCE_DUPLICATE',
    'CRITICAL',
    query(
      `SELECT MIN(document_id) AS id FROM core_fiscal_events
        WHERE company_id = ? AND event_type = 'cce_authorized'
        GROUP BY document_id, sequence HAVING COUNT(*) > 1`,
      [companyId],
    ),
    (n) => `${n} sequência(s) de carta de correção repetida(s) no mesmo documento.`,
    'Sequência repetida é rejeição na SEFAZ, e indica que duas cartas foram numeradas '
      + 'ao mesmo tempo.',
    'Conferir a linha do tempo e reenviar com a sequência seguinte.',
  );

  add(
    'VOID_WITHOUT_PROTOCOL',
    'WARNING',
    query(
      `SELECT id FROM core_fiscal_events
        WHERE company_id = ? AND event_type = 'void_authorized'
          AND (protocol IS NULL OR TRIM(protocol) = '')`,
      [companyId],
    ),
    (n) => `${n} inutilização(ões) tida(s) como aceita(s) sem protocolo.`,
    'A faixa foi queimada localmente sem confirmação do fisco. Se a SEFAZ não registrou, '
      + 'os números continuam disponíveis para ela e indisponíveis aqui.',
    'Consultar a inutilização na SEFAZ.',
  );

  /**
   * Faixa inutilizada que contém número já emitido.
   *
   * O writer impede isso na criação; a checagem existe para bases antigas e
   * para o caso de a emissão ter acontecido por outro caminho.
   */
  add(
    'VOID_AUTHORIZED_NUMBER',
    'CRITICAL',
    query(
      `SELECT e.id FROM core_fiscal_events e
        WHERE e.company_id = ? AND e.event_type = 'void_authorized'
          AND EXISTS (
            SELECT 1 FROM core_fiscal_documents d
             WHERE d.company_id = e.company_id AND d.model = e.model AND d.serie = e.serie
               AND d.number BETWEEN e.number_from AND e.number_to
          )`,
      [companyId],
    ),
    (n) => `${n} faixa(s) inutilizada(s) que contém número já emitido.`,
    'Um número não pode estar inutilizado e virado nota ao mesmo tempo. Uma das duas '
      + 'informações está errada perante o fisco.',
    'Consultar a chave da nota e a inutilização; não alterar nada antes disso.',
  );

  add(
    'VOID_PENDING_TOO_LONG',
    'WARNING',
    query(
      `SELECT e.id FROM core_fiscal_events e
        WHERE e.company_id = ? AND e.event_type = 'void_requested' AND e.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM core_fiscal_events r
             WHERE r.company_id = e.company_id AND r.model = e.model AND r.serie = e.serie
               AND r.number_from = e.number_from AND r.number_to = e.number_to
               AND r.event_type IN ('void_authorized', 'void_rejected')
          )`,
      [companyId, limite],
    ),
    (n) => `${n} inutilização(ões) pedida(s) e sem desfecho há mais de ${SENDING_STALE_MINUTES} minutos.`,
    'A faixa está reservada localmente — os números não serão emitidos — mas o fisco '
      + 'pode não ter registrado nada.',
    'Consultar a inutilização e concluir ou liberar a faixa.',
  );

  /**
   * Faixas de inutilização que se sobrepõem.
   *
   * O writer impede na criação, mas não há constraint de banco para intervalo —
   * SQLite não tem exclusão por range. A checagem cobre base migrada e
   * gravação feita por fora.
   */
  add(
    'VOID_RANGE_OVERLAP',
    'CRITICAL',
    query(
      `SELECT a.id FROM core_fiscal_events a
         JOIN core_fiscal_events b
           ON b.company_id = a.company_id AND b.model = a.model AND b.serie = a.serie
          AND b.event_type = 'void_authorized' AND b.id <> a.id
          AND b.number_from <= a.number_to AND b.number_to >= a.number_from
        WHERE a.company_id = ? AND a.event_type = 'void_authorized'`,
      [companyId],
    ),
    (n) => `${n} faixa(s) de inutilização sobreposta(s).`,
    'A mesma numeração aparece inutilizada duas vezes. Uma das solicitações pode ter sido '
      + 'recusada pelo fisco sem o sistema registrar.',
    'Consultar as inutilizações na SEFAZ antes de qualquer ajuste.',
  );

  // Ordena por gravidade: quem abre a tela precisa ver o crítico primeiro.
  const peso: Record<IssueSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return issues.sort((a, b) => peso[a.severity] - peso[b.severity]);
}

export interface ReconciliationReport {
  companyId: string;
  checkedAt: string;
  healthy: boolean;
  critical: number;
  warnings: number;
  issues: ReconciliationIssue[];
}

export function reconciliationReport(companyId: string): ReconciliationReport {
  const issues = runReconciliation(companyId);
  return {
    companyId,
    checkedAt: new Date().toISOString(),
    healthy: issues.length === 0,
    critical: issues.filter((i) => i.severity === 'CRITICAL').length,
    warnings: issues.filter((i) => i.severity === 'WARNING').length,
    issues,
  };
}
