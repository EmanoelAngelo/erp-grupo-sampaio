/**
 * A VERSÃO DA OS NO QUADRO — quem move sobre um retrato velho é avisado
 * (GAP-PRD-183), e a OS fora das regras se declara (GAP-PRD-188).
 *
 * ## O defeito do "último grito"
 *
 * O gerente abre o quadro, o mecânico também. O gerente move a OS #47 para
 * "aguardando peça"; um minuto depois o mecânico, ainda com o quadro da
 * manhã na tela, arrasta a mesma OS de "em andamento" para "manutenção
 * externa". O servidor aceitava os dois: a coluna final era a de quem clicou
 * por último, e o card "pulava" entre os dois sem ninguém entender por quê.
 *
 * ## A versão é a COLUNA, e não o `updated_at`
 *
 * O quadro decide sobre a situação da OS. Comentário, foto e peça mexem em
 * `updated_at` o dia inteiro — usar esse carimbo como versão faria todo
 * movimento depois de um comentário alheio levar 409 sem motivo, e a pessoa
 * aprenderia a recarregar e clicar de novo sem ler, que é o hábito que a trava
 * existe para quebrar.
 *
 * O que o card mostrava é a situação (`status`) e o instante em que ela
 * começou (`status_changed_at`). Os dois juntos pegam também a volta
 * completa: A → B → A em outro computador muda o instante mesmo que a coluna
 * seja a mesma — e quem está com o retrato velho não sabe o que houve no meio.
 *
 * A pré-condição é OPCIONAL no contrato: quem não manda (integração, teste
 * antigo) segue como antes. O quadro e a ficha mandam sempre.
 *
 * Este módulo é folha: não importa serviço nenhum da oficina, e por isso
 * `WorkshopCoreService` pode chamá-lo sem ciclo.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';

/** O retrato que o cliente tinha da OS quando pediu o movimento. */
export interface VersaoEsperada {
  status?: string;
  /** `null` é valor legítimo: OS antiga, de antes da coluna existir. */
  statusChangedAt?: string | null;
}

/** O que a OS precisa ter para a conferência — os campos, e só eles. */
interface OsComVersao {
  id: string;
  number: number;
  status: string;
  status_changed_at: string | null;
}

const ROTULO: Record<string, string> = {
  em_aberto: 'Em aberto',
  em_andamento: 'Em andamento',
  manutencao_externa: 'Manutenção externa',
  parada_setor: 'Parada no setor',
  aguardando_peca: 'Aguardando peça',
  aguardando_pagamento: 'Aguardando pagamento',
  finalizada: 'Finalizada',
};

/**
 * Lê a pré-condição do corpo: `expectedStatus` e `expectedStatusChangedAt`.
 *
 * Ausente = sem pré-condição (contrato antigo). Presente mas malformada é 400:
 * uma trava que aceita qualquer coisa não trava nada.
 */
export function lerVersaoEsperada(body: Record<string, unknown> | undefined | null): VersaoEsperada | null {
  if (!body) return null;
  const temStatus = body.expectedStatus !== undefined;
  const temInstante = body.expectedStatusChangedAt !== undefined;
  if (!temStatus && !temInstante) return null;

  const esperado: VersaoEsperada = {};
  if (temStatus) {
    if (typeof body.expectedStatus !== 'string' || !body.expectedStatus.trim()) {
      throw new ApiError(
        'CORE_ORDER_VERSION_INVALID',
        'A situação esperada da OS veio vazia ou num formato inválido.',
        400,
      );
    }
    esperado.status = body.expectedStatus.trim();
  }
  if (temInstante) {
    const bruto = body.expectedStatusChangedAt;
    if (bruto !== null && typeof bruto !== 'string') {
      throw new ApiError(
        'CORE_ORDER_VERSION_INVALID',
        'O instante esperado da OS veio num formato inválido.',
        400,
      );
    }
    esperado.statusChangedAt = bruto === null || bruto === '' ? null : bruto;
  }
  return esperado;
}

/**
 * Recusa com 409 quando a OS mudou de coluna desde o retrato do cliente.
 *
 * A mensagem diz ONDE a OS está agora e QUEM a moveu por último — é o que a
 * pessoa precisa para decidir se o movimento dela ainda faz sentido, sem ter
 * de abrir a linha do tempo.
 */
export function exigirMesmaVersao(order: OsComVersao, esperado: VersaoEsperada | null): void {
  if (!esperado) return;
  const mudouColuna = esperado.status !== undefined && esperado.status !== order.status;
  const mudouInstante =
    esperado.statusChangedAt !== undefined
    && (esperado.statusChangedAt ?? null) !== (order.status_changed_at ?? null);
  if (!mudouColuna && !mudouInstante) return;

  const ultimo = getConnection()
    .prepare(
      `SELECT u.display_name AS nome, e.created_at AS quando
         FROM core_service_order_events e
         LEFT JOIN core_users u ON u.id = e.user_id
        WHERE e.order_id = ?
        ORDER BY e.created_at DESC, e.rowid DESC
        LIMIT 1`,
    )
    .get(order.id) as { nome: string | null; quando: string } | undefined;

  const onde = ROTULO[order.status] ?? order.status;
  const quem = ultimo?.nome ? ` (último movimento: ${ultimo.nome})` : '';
  throw new ApiError(
    'CORE_ORDER_STALE',
    `A OS #${order.number} mudou desde que você abriu o quadro: agora está em "${onde}"${quem}. `
      + 'Recarregue e confira antes de mover.',
    409,
    {
      statusAtual: order.status,
      statusChangedAt: order.status_changed_at,
      ultimoMovimentoPor: ultimo?.nome ?? null,
    },
  );
}

// ------------------------------------------------ OS fora das regras (188)

/**
 * O que está fora das regras atuais nesta OS — calculado, nunca gravado.
 *
 *   sem_bancada      OS gravada antes de `workshop_id` existir: ela aparece
 *                    para todas as bancadas (a busca aceita o nulo de
 *                    propósito) e não é de nenhuma;
 *   sem_responsavel  OS numa coluna de trabalho sem ninguém que a tenha
 *                    assumido — ninguém consegue concluí-la
 *                    (`CORE_ORDER_NOT_ASSIGNED`) e o card não diz de quem é.
 *
 * O caminho para consertar é `regularizarOs` (WorkshopOrderRegularization).
 */
export type IrregularidadeDaOs = 'sem_bancada' | 'sem_responsavel';

const COLUNAS_DE_TRABALHO = new Set([
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
]);

export function irregularidadesDaOs(order: {
  workshop_id?: unknown;
  mechanic_id?: unknown;
  status?: unknown;
}): IrregularidadeDaOs[] {
  const lista: IrregularidadeDaOs[] = [];
  if (!order.workshop_id) lista.push('sem_bancada');
  if (COLUNAS_DE_TRABALHO.has(String(order.status ?? '')) && !order.mechanic_id) {
    lista.push('sem_responsavel');
  }
  return lista;
}
