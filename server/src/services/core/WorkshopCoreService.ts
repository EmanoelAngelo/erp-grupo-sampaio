/**
 * Oficinas: ordens de serviço, Kanban e timeline.
 *
 * Escopo: TODO dado carrega `company_id` + `workshop_id`. É isso que impede a
 * Oficina de Celulares (dentro do Preço Justo) de ver qualquer coisa da
 * Oficina de Mobilidade, mesmo quando um usuário pertence às duas empresas.
 *
 * Regras de negócio que o código impõe, não apenas documenta:
 *
 *  - OS nasce EM ABERTO, inclusive quando aberta pelo proprietário.
 *  - Só técnico tira a OS de EM ABERTO, e ao fazê-lo a OS passa a ser dele
 *    (`mechanic_id`). Outro técnico não mexe mais.
 *  - Comentários são append-only: nada sobrescreve nada.
 *  - OS com custo NÃO chega a FINALIZADA sem pagamento — passa por
 *    AGUARDANDO PAGAMENTO e só é fechada pelo PDV.
 *  - OS sem custo exige motivo permitido (garantia).
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import {
  consumirPromessasDaOs,
  prometerPeca,
  reprometerPromessasDaOs,
} from './WorkshopPartsReservation.js';
import { recordEquipmentEvent } from './EquipmentService.js';
import { criarChecklistDaOs, itensPendentes } from './WorkshopChecklistService.js';
import {
  avisarConclusaoTecnica,
  avisarOrcamentoDisponivel,
  avisarOsPaga,
} from '../notifications/AvisosDaOficina.js';
import {
  exigirMesmaVersao,
  irregularidadesDaOs,
  type VersaoEsperada,
} from './WorkshopOrderVersion.js';
import { modeloAtivo, recusaDeProdutoInativo } from './produtoVendavel.js';

/**
 * Colunas do Kanban, na ordem operacional — a ordem do quadro que o dono
 * aprovou (rodada 51, portada do sistema anterior da oficina): Aberto → Em
 * andamento → Manutenção externa → Parada no setor → Aguardando peça. As duas
 * últimas são consequência de regra, não de arrasto: a fila do caixa nasce da
 * conclusão técnica, e FINALIZADA nasce do pagamento (ou do sem-custo).
 */
export const ORDER_STATUSES = [
  'em_aberto',
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
  'aguardando_pagamento',
  'finalizada',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Os estados em português, para papel e para gente (rodada 54).
 *
 * A ordem de serviço impressa saía com o código cru no cabeçalho —
 * "Situação: em_andamento" — num documento que o cliente leva para casa. O
 * mapa mora aqui, colado na lista que ele traduz: separado, o estado novo
 * entraria na lista e ficaria sem rótulo, que é exatamente como a coluna
 * `parada_setor` da rodada 51 apareceu no papel.
 *
 * Estado desconhecido volta como veio: inventar tradução esconderia um estado
 * que ninguém mapeou.
 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  em_aberto: 'Em aberto',
  em_andamento: 'Em andamento',
  manutencao_externa: 'Manutenção externa',
  parada_setor: 'Parada no setor',
  aguardando_peca: 'Aguardando peça',
  aguardando_pagamento: 'Aguardando pagamento',
  finalizada: 'Finalizada',
};

export function rotuloDoStatus(status: string | null | undefined): string {
  const s = String(status ?? '');
  return ORDER_STATUS_LABEL[s] ?? s;
}

const STATUS_SET = new Set<string>(ORDER_STATUSES);

/** Estados que o técnico move na mão. Os demais são consequência de regra. */
const MECHANIC_MOVABLE = new Set<string>([
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
]);

/**
 * A OS ESTÁ VIVA NA BANCADA — a única fonte desta pergunta (rodada 51).
 *
 * "Viva" = o aparelho está com a oficina e o serviço não terminou: nem virou
 * conta a receber (aguardando pagamento), nem fechou (finalizada).
 *
 * ## Por que uma constante exportada, e não a lista repetida
 *
 * A mesma lista existia copiada em QUATRO lugares — a trava que impede vender
 * uma moto desmontada, a regra que deixa o dono abrir chamado, o pedido de
 * aprovação do orçamento e a tela da OS. Todas escritas por COMPLEMENTO ("os
 * quatro que sobram"), e nenhuma delas soube da coluna nova `parada_setor`
 * quando ela nasceu nesta rodada: a moto parada no setor virava vendível, o
 * dono perdia o botão de chamado, e o orçamento dela levava 409.
 *
 * Uma cópia por leitor é uma bomba-relógio por leitor. Aqui há uma lista, e
 * quem precisar da pergunta importa a resposta.
 */
export const ORDER_STATUSES_ON_BENCH = [
  'em_aberto',
  'em_andamento',
  'manutencao_externa',
  'parada_setor',
  'aguardando_peca',
] as const;

export function isOrderOnBench(status: string | null | undefined): boolean {
  return (ORDER_STATUSES_ON_BENCH as readonly string[]).includes(String(status ?? ''));
}

/**
 * Prioridades da OS, da mais urgente para a mais leve (rodada 51).
 *
 * A ordem É a ordenação do quadro: dentro de cada coluna, urgente vem antes
 * de alta, que vem antes de média, que vem antes de baixa — igual ao sistema
 * anterior da oficina. `media` é o nascimento padrão.
 */
export const ORDER_PRIORITIES = ['urgente', 'alta', 'media', 'baixa'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];
const PRIORITY_SET = new Set<string>(ORDER_PRIORITIES);

function exigirPrioridade(valor: unknown): OrderPriority {
  const p = String(valor ?? '').trim();
  if (!PRIORITY_SET.has(p)) {
    throw new ApiError(
      'CORE_INVALID_PRIORITY',
      'Prioridade inválida: use urgente, alta, media ou baixa.',
      400,
    );
  }
  return p as OrderPriority;
}

/**
 * Prazo da OS: uma DATA (ou data-hora) ISO, ou nada.
 *
 * O prazo é promessa ao cliente, definida por gente — não é derivado do SLA,
 * que é régua interna de reação por coluna. Data ilegível é 400 na porta, não
 * um "Invalid Date" no card.
 */
function exigirPrazo(valor: unknown): string | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const bruto = String(valor).trim();
  /*
    FORMATO E CALENDÁRIO, não só "o Date não é NaN".

    `new Date('2026-13-45')` não é NaN em todo runtime, e mesmo quando o
    formato passa o JavaScript ROLA o excedente: '2026-02-31' vira 2 de
    março. O prazo é promessa ao cliente — gravar 2 de março porque alguém
    digitou 31 de fevereiro é prometer uma data que ninguém combinou.

    Só a forma AAAA-MM-DD (a que o campo de data da tela manda) é aceita, e
    ela é confirmada pela volta: se o dia rolou, o ISO reconstruído difere.
  */
  const formato = /^\d{4}-\d{2}-\d{2}$/.exec(bruto);
  const data = formato ? new Date(`${bruto}T00:00:00Z`) : null;
  if (!data || Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== bruto) {
    throw new ApiError(
      'CORE_INVALID_DUE_DATE',
      'Prazo inválido: use uma data no formato AAAA-MM-DD.',
      400,
    );
  }
  return bruto;
}

/** Motivos aceitos para encerrar sem cobrar. */
export const NO_COST_REASONS = new Set(['garantia', 'cortesia_autorizada', 'retrabalho']);

export interface ServiceOrder {
  id: string;
  company_id: string;
  workshop_id: string | null;
  number: number;
  customer_id: string | null;
  customer_name: string | null;
  equipment_id: string | null;
  equipment: string | null;
  complaint: string | null;
  diagnosis: string | null;
  status: string;
  mechanic_id: string | null;
  assigned_at: string | null;
  /** Prioridade do quadro (rodada 51): urgente | alta | media | baixa. */
  priority: string;
  /** Prazo prometido ao cliente (ISO), ou nulo. */
  due_date: string | null;
  /** Quando a OS ENTROU na coluna atual — a base do relógio do SLA. */
  status_changed_at: string | null;
  opened_by_customer: number;
  has_cost: number | null;
  no_cost_reason: string | null;
  labor_cents: number;
  parts_cents: number;
  total_cents: number;
  sale_id: string | null;
  paid_at: string | null;
  /** Quando a oficina PEDIU a aprovação do orçamento (migração 61), ou nulo. */
  approval_requested_at: string | null;
  /** Quando o cliente disse SIM — pelo portal ou registrado pelo balcão. */
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getOrder(companyId: string, orderId: string): ServiceOrder | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_service_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as ServiceOrder | undefined;
  return row ?? null;
}

/**
 * Confere que a OS existe E está no alcance de oficinas do usuário.
 *
 * Aceita uma LISTA porque quem atende duas oficinas tem alcance de duas. `null`
 * é "todas as da empresa" — escopo legítimo, e não ausência de verificação: a
 * empresa continua sendo conferida por `getOrder`.
 *
 * OS com `workshop_id` nulo passa sempre. Existe OS gravada antes de a coluna
 * existir, e ela não pertence a oficina nenhuma; excluí-la a tornaria
 * inalcançável para todo mundo, inclusive para o gestor.
 */
function requireScopedOrder(
  companyId: string,
  alcance: string | string[] | null,
  orderId: string,
): ServiceOrder {
  const order = getOrder(companyId, orderId);
  if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Ordem de serviço não encontrada.', 404);
  // Aceita uma oficina ou várias: as rotas de ação continuam resolvendo UMA
  // (é onde o trabalho acontece), e só a leitura precisa de alcance amplo.
  const workshopIds = alcance === null ? null : Array.isArray(alcance) ? alcance : [alcance];
  if (workshopIds && order.workshop_id && !workshopIds.includes(order.workshop_id)) {
    // 404 e não 403: o usuário não deve nem descobrir que a OS existe.
    throw new ApiError('CORE_ORDER_NOT_FOUND', 'Ordem de serviço não encontrada.', 404);
  }
  return order;
}

/**
 * A MESMA conferência, para quem mexe na OS de fora deste arquivo — a
 * devolução de peça (GAP-PRD-103) conferia só a empresa, e o mecânico de
 * outra bancada devolvia peça de OS que ele nem enxerga.
 */
export function exigirOsNoAlcance(
  companyId: string,
  alcance: string | string[] | null,
  orderId: string,
): ServiceOrder {
  ensureCoreSchema();
  return requireScopedOrder(companyId, alcance, orderId);
}

/**
 * A MUDANÇA DE SITUAÇÃO VAI PARA A CENTRAL (GAP-PRD-100).
 *
 * O catálogo tinha `service_order.status_changed` e o projetor sabia
 * consumi-lo — e ninguém o emitia: só a abertura saía, e o consolidado via
 * toda OS "em aberto" com total zero para sempre. Toda porta que muda a
 * situação da OS chama isto DENTRO da sua transação (o `enqueue` recusa fora
 * dela): o fato e o evento existem ou desaparecem juntos.
 *
 * O payload é a OS inteira, como está depois da mudança — a projeção
 * `erp_service_orders` é um retrato (situação e totais), e a guarda de ordem
 * do projetor garante que um retrato antigo não sobrescreve o novo.
 */
export function registrarSituacaoNaCentral(companyId: string, orderId: string): void {
  const ordem = getOrder(companyId, orderId);
  if (!ordem) return;
  recordDomainEvent({
    eventType: 'service_order.status_changed',
    aggregateType: 'service_order',
    aggregateId: orderId,
    companyId,
    // A oficina é a unidade operacional, como na abertura.
    operationalUnitId: ordem.workshop_id,
    operation: 'update',
    payload: ordem as unknown as Record<string, unknown>,
    occurredAt: ordem.status_changed_at ?? ordem.updated_at,
  });
}

/** Trim que transforma vazio em ausência. Vazio e nulo não são a mesma coisa. */
function texto(valor: unknown): string | null {
  const s = String(valor ?? '').trim();
  return s.length ? s : null;
}

/**
 * Resolve cliente e equipamento antes de abrir a OS.
 *
 * ## O vínculo é OPCIONAL, e continua sendo
 *
 * A oficina atende quem chega. Exigir cliente cadastrado para abrir uma OS
 * travaria o balcão no pior momento — com a pessoa na frente e o aparelho na
 * mão. Por isso o texto livre permanece: ele é o que sobra quando não há
 * cadastro, não uma etapa que se pula.
 *
 * ## Mas quando o id VEM, ele é conferido
 *
 * Antes, um `customerId` de outra empresa ia direto para o INSERT e a chave
 * estrangeira estourava como erro 500 "Erro interno" — a pessoa no balcão via
 * o sistema quebrar sem saber o que fazer. Agora vira 404 com texto que diz o
 * que houve.
 *
 * ## E o vínculo MANDA sobre o texto
 *
 * Com cliente vinculado, o nome exibido é o do cadastro: guardar os dois
 * criaria duas verdades sobre a mesma pessoa, e a divergência apareceria meses
 * depois, quando o cadastro fosse corrigido e a OS continuasse com o nome
 * velho. O mesmo vale para o equipamento.
 */
function resolveVinculos(
  companyId: string,
  workshopId: string,
  input: { customerId?: string | null; customerName?: string; equipmentId?: string | null; equipment?: string },
): { customerId: string | null; customerName: string | null; equipmentId: string | null; equipment: string | null } {
  const db = getConnection();

  let customerId: string | null = null;
  let customerName = texto(input.customerName);
  if (input.customerId) {
    const cliente = db
      .prepare('SELECT id, name FROM core_customers WHERE id = ? AND company_id = ?')
      .get(input.customerId, companyId) as { id: string; name: string } | undefined;
    if (!cliente) {
      throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta empresa.', 404);
    }
    customerId = cliente.id;
    customerName = cliente.name;
  }

  let equipmentId: string | null = null;
  let equipment = texto(input.equipment);
  if (input.equipmentId) {
    const eq = db
      .prepare(
        `SELECT id, workshop_id, origin, sale_status, public_id
           FROM core_equipment WHERE id = ? AND company_id = ?`,
      )
      .get(input.equipmentId, companyId) as
      | { id: string; workshop_id: string | null; origin: string; sale_status: string; public_id: number }
      | undefined;
    if (!eq) {
      throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado nesta empresa.', 404);
    }
    // Aparelho de celular não abre OS na bancada de moto. O equipamento sem
    // oficina definida passa — é herança de cadastro antigo, não erro.
    if (eq.workshop_id && eq.workshop_id !== workshopId) {
      throw new ApiError(
        'CORE_EQUIPMENT_OTHER_WORKSHOP',
        'Este equipamento pertence a outra oficina.',
        400,
      );
    }
    /*
      A MOTO DO ESTOQUE NÃO É MOTO DE CLIENTE (GAP-PRD-109).

      Plaquinha interna ainda não vendida é unidade comercial do grupo — no
      pátio da PJ Motors ou montando na bancada antes de ir para lá. A OS dela
      é de MONTAGEM ou PREPARAÇÃO interna. Aceitar um cliente do cadastro aqui
      punha a OS em nome de uma pessoa sobre uma moto que a loja ainda vende:
      a cobrança ia para ela, o portal dela não mostrava a moto (dono nulo), e
      ninguém avisava na abertura — a guarda só existia na venda.

      O que se recusa é o VÍNCULO com o cadastro (é ele que dá titularidade:
      portal, cobrança, fiado). O nome da OS continua livre, e vazio vira
      "Montagem interna".
    */
    if (eq.origin === 'INTERNAL_PJ_MOTORS' && eq.sale_status === 'NOT_SOLD') {
      if (customerId) {
        const loja = db
          .prepare(
            `SELECT c.trade_name FROM core_product_units u
               JOIN core_companies c ON c.id = u.company_id
              WHERE u.equipment_id = ? AND u.status = 'in_stock' LIMIT 1`,
          )
          .get(eq.id) as { trade_name: string } | undefined;
        throw new ApiError(
          'CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER',
          `A #${String(eq.public_id).padStart(4, '0')} é moto do estoque ` +
            `${loja ? `da ${loja.trade_name}` : 'do grupo'}, ainda não vendida: a OS dela é de montagem ou ` +
            'preparação interna, sem cliente. Abra sem cliente — ela entra como "Montagem interna". ' +
            'Depois da venda, a moto passa a ser do comprador e a OS dele abre normalmente.',
          409,
          { equipmentId: eq.id, loja: loja?.trade_name ?? null },
        );
      }
      if (!customerName) customerName = 'Montagem interna';
    }
    equipmentId = eq.id;
    // O texto livre some: quem exibe passa a ser o JOIN com o cadastro.
    equipment = null;
  }

  return { customerId, customerName, equipmentId, equipment };
}

export function createOrder(input: {
  companyId: string;
  workshopId: string;
  userId: string;
  customerName?: string;
  customerId?: string | null;
  equipmentId?: string | null;
  equipment?: string;
  /**
   * Placa da moto, número da gaveta, etiqueta do balcão.
   *
   * Mora na OS e não no equipamento porque é atributo da VISITA: na oficina de
   * celulares o campo é o número da gaveta onde o aparelho está guardado, e
   * muda a cada atendimento. E `core_equipment` não tem coluna de placa — criar
   * uma agora é que produziria duas fontes de verdade.
   *
   * Era digitada na tela e descartada aqui: `createOrder` não tinha este
   * parâmetro e o INSERT não listava a coluna, enquanto a listagem exibia
   * `order.plate` — uma coluna que nunca era preenchida.
   */
  plate?: string;
  complaint?: string;
  openedByCustomer?: boolean;
  /** Prioridade do quadro (rodada 51). Ausente = media, o nascimento padrão. */
  priority?: string;
  /** Prazo prometido ao cliente (ISO), opcional. */
  dueDate?: string | null;
}): ServiceOrder {
  ensureCoreSchema();
  const priority = input.priority == null ? 'media' : exigirPrioridade(input.priority);
  const dueDate = exigirPrazo(input.dueDate);
  return withTransaction(() => {
    const db = getConnection();
    const workshop = db
      .prepare('SELECT id FROM core_workshops WHERE id = ? AND company_id = ?')
      .get(input.workshopId, input.companyId) as { id: string } | undefined;
    if (!workshop) {
      throw new ApiError('CORE_WORKSHOP_NOT_FOUND', 'Oficina não encontrada nesta empresa.', 404);
    }

    const vinculos = resolveVinculos(input.companyId, input.workshopId, input);

    const id = randomUUID();
    const now = new Date().toISOString();
    const number = nextSequenceValue(input.companyId, 'service_order');

    // Toda OS nasce EM ABERTO e sem responsável — inclusive a que o
    // proprietário abre pelo portal.
    db.prepare(
      `INSERT INTO core_service_orders
         (id, company_id, workshop_id, number, customer_id, customer_name, equipment_id,
          equipment, plate, complaint, status, mechanic_id, opened_by_customer,
          priority, due_date, status_changed_at,
          labor_cents, parts_cents, total_cents, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'em_aberto', NULL, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.workshopId,
      number,
      vinculos.customerId,
      vinculos.customerName,
      vinculos.equipmentId,
      vinculos.equipment,
      texto(input.plate),
      texto(input.complaint),
      input.openedByCustomer ? 1 : 0,
      priority,
      dueDate,
      now,
      input.userId,
      now,
      now,
    );

    addEvent(id, input.companyId, null, 'em_aberto', input.userId, 'Ordem aberta');

    /*
      O CHECKLIST DE ENTRADA NASCE COM A OS (rodada 52).

      Depois ninguém lembra: a máquina já entrou, o cliente já foi embora, e a
      conferência que evitaria a discussão de balcão vira memória de quem
      atendeu. A lista vem do modelo da BANCADA — moto tem chave e retrovisor,
      celular tem chip e senha —, e a bancada sem modelo não ganha lista.
    */
    criarChecklistDaOs({
      companyId: input.companyId,
      orderId: id,
      workshopId: input.workshopId,
    });

    // O id VALIDADO, e não o que veio no corpo: são o mesmo valor hoje, mas
    // ler o resolvido é o que mantém a linha do tempo do equipamento presa ao
    // que de fato foi gravado na OS.
    if (vinculos.equipmentId) {
      recordEquipmentEvent({
        equipmentId: vinculos.equipmentId,
        companyId: input.companyId,
        eventType: 'order_opened',
        description: `OS #${number} aberta`,
        userId: input.userId,
        orderId: id,
      });
    }

    const ordem = getOrder(input.companyId, id)!;
    recordDomainEvent({
      eventType: 'service_order.opened',
      aggregateType: 'service_order',
      aggregateId: id,
      companyId: input.companyId,
      // A oficina é a unidade operacional: duas oficinas do grupo não são
      // duas empresas, e o consolidado precisa saber separar as duas.
      operationalUnitId: input.workshopId,
      payload: ordem as unknown as Record<string, unknown>,
      occurredAt: now,
    });
    return ordem;
  });
}

function addEvent(
  orderId: string,
  companyId: string,
  fromStatus: string | null,
  toStatus: string,
  userId: string,
  note?: string,
): void {
  getConnection()
    .prepare(
      `INSERT INTO core_service_order_events
         (id, order_id, company_id, from_status, to_status, user_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      orderId,
      companyId,
      fromStatus,
      toStatus,
      userId,
      note ?? null,
      new Date().toISOString(),
    );
}

/**
 * Comentário na timeline. Append-only: cada chamada acrescenta uma entrada
 * com autor e data; nenhuma entrada anterior é alterada.
 *
 * ## A VOZ DO BALCÃO (GAP-PRD-102)
 *
 * Eram três vozes — técnico, gestão e proprietário — e o atendente e o caixa
 * da oficina, que a rota sempre aceitou, caíam em "técnico". A trava de
 * responsável existe para o TÉCNICO (quem assumiu a OS é quem fala pelo
 * serviço), e com ela o balcão levava 403 em toda OS já assumida — a maioria.
 * "Cliente ligou", "cliente deixou sinal" é informação de quem atende o
 * cliente, sobre qualquer OS da empresa: `balcao` é voz própria, sem a trava.
 */
export function addComment(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  authorName: string;
  authorKind?: 'tecnico' | 'gestor' | 'proprietario' | 'balcao';
  body: string;
  attachments?: string[];
}): void {
  ensureCoreSchema();
  const body = input.body?.trim();
  if (!body) throw new ApiError('CORE_EMPTY_COMMENT', 'Comentário vazio.', 400);

  const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);

  // Comentário técnico só do responsável; o proprietário, a gestão e o
  // balcão sempre podem falar.
  const kind = input.authorKind ?? 'tecnico';
  if (kind === 'tecnico' && order.mechanic_id && order.mechanic_id !== input.userId) {
    throw new ApiError(
      'CORE_ORDER_NOT_ASSIGNED_TO_YOU',
      'Esta OS está atribuída a outro técnico.',
      403,
    );
  }

  getConnection()
    .prepare(
      `INSERT INTO core_service_order_comments
         (id, order_id, company_id, author_id, author_name, author_kind, body,
          attachments, status_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.orderId,
      input.companyId,
      input.userId,
      input.authorName,
      kind,
      body,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      order.status,
      new Date().toISOString(),
    );
}

/**
 * Assume a OS. É o único caminho para sair de EM ABERTO, e exige comentário —
 * o primeiro avanço registra quem pegou o serviço e o que foi constatado.
 */
export function assumeOrder(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  toStatus: string;
  comment: string;
  /** O retrato que o quadro tinha da OS (GAP-PRD-183). Ausente = sem trava. */
  esperado?: VersaoEsperada | null;
}): ServiceOrder {
  ensureCoreSchema();
  if (!input.comment?.trim()) {
    throw new ApiError(
      'CORE_COMMENT_REQUIRED',
      'Para assumir a OS é obrigatório registrar um comentário.',
      400,
    );
  }
  if (!MECHANIC_MOVABLE.has(input.toStatus)) {
    throw new ApiError(
      'CORE_INVALID_STATUS',
      'Ao assumir, a OS deve ir para em andamento, aguardando peça ou manutenção externa.',
      400,
    );
  }

  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    exigirMesmaVersao(order, input.esperado ?? null);
    /*
      ASSUMIR É SÓ PARA QUEM ESTÁ NO QUADRO (GAP-PRD-188).

      A porta não conferia a situação: o técnico responsável "assumia" de novo
      a própria OS na fila do caixa ou já FINALIZADA, e ela voltava para a
      bancada sem passar pelo gerente nem pelo estorno — é assim que a OS #1 do
      banco da loja ganhou o evento finalizada → em andamento. Tirar da fila do
      caixa é do gerente (`moveOrder`), e reabrir OS paga é o estorno.
    */
    if (order.status === 'aguardando_pagamento' || order.status === 'finalizada') {
      throw new ApiError(
        'CORE_ORDER_PAST_BOARD',
        order.status === 'finalizada'
          ? 'OS finalizada não se assume: o serviço já foi entregue. Se o recebimento estava errado, '
            + 'o caminho é o estorno na ficha da OS.'
          : 'OS na fila de pagamento não se assume: tirá-la da fila é decisão do gerente da oficina.',
        409,
      );
    }
    if (order.mechanic_id && order.mechanic_id !== input.userId) {
      throw new ApiError(
        'CORE_ORDER_ALREADY_ASSIGNED',
        'Esta OS já foi assumida por outro técnico.',
        409,
      );
    }
    // Assumir de novo a própria OS gravava um evento de uma coluna para ela
    // mesma, sem observação de movimento — a linha do tempo mentia um passo.
    if (order.mechanic_id === input.userId && order.status !== 'em_aberto') {
      throw new ApiError(
        'CORE_ORDER_ALREADY_YOURS',
        'Esta OS já é sua. Para mudar de coluna, mova o card com a observação.',
        409,
      );
    }

    const now = new Date().toISOString();
    getConnection()
      .prepare(
        `UPDATE core_service_orders
            SET status = ?, mechanic_id = ?, assigned_at = COALESCE(assigned_at, ?),
                status_changed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(input.toStatus, input.userId, now, now, now, input.orderId);

    addEvent(
      input.orderId,
      input.companyId,
      order.status,
      input.toStatus,
      input.userId,
      // A OS de coluna de trabalho sem responsável (dado antigo) também se
      // assume — é o conserto dela —, e a linha do tempo diz que era isso.
      order.status === 'em_aberto' ? 'OS assumida' : 'OS assumida (estava sem responsável)',
    );
    addComment({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      authorName: input.userName,
      body: input.comment,
    });
    registrarSituacaoNaCentral(input.companyId, input.orderId);

    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * Move a OS entre colunas operacionais. Só o responsável move — e todo
 * movimento EXIGE observação (rodada 51): o quadro é lido por quem não estava
 * lá na hora, e um card que mudou de coluna sem uma linha de porquê é um
 * quadro que mente por omissão. É a regra do sistema anterior da oficina,
 * agora imposta pelo servidor e não pela boa vontade da tela.
 */
export function moveOrder(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  toStatus: string;
  comment?: string;
  isManager?: boolean;
  /** O retrato que o quadro tinha da OS (GAP-PRD-183). Ausente = sem trava. */
  esperado?: VersaoEsperada | null;
}): ServiceOrder {
  ensureCoreSchema();
  if (!STATUS_SET.has(input.toStatus)) {
    throw new ApiError('CORE_INVALID_STATUS', `Situação inválida: ${input.toStatus}`, 400);
  }
  if (!input.comment?.trim()) {
    throw new ApiError(
      'CORE_COMMENT_REQUIRED',
      'Todo movimento no quadro exige uma observação — é ela que explica a mudança a quem ler a OS depois.',
      400,
    );
  }
  // Voltar para EM ABERTO é devolver a OS ao quadro — ação própria, com
  // justificativa e limpeza do responsável (`releaseOrder`).
  if (input.toStatus === 'em_aberto') {
    throw new ApiError(
      'CORE_REOPEN_VIA_RELEASE',
      'Para devolver a OS ao quadro use a ação de largar, com justificativa.',
      409,
    );
  }
  // A fila do caixa nasce da conclusão técnica, que confere custo e
  // diagnóstico — arrastar para lá pularia a conferência.
  if (input.toStatus === 'aguardando_pagamento') {
    throw new ApiError(
      'CORE_AWAIT_PAYMENT_VIA_COMPLETE',
      'A OS entra na fila de pagamento pela conclusão técnica, não pelo arrasto.',
      409,
    );
  }

  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    // Antes de qualquer outra recusa: quem está com o quadro velho precisa
    // saber que a OS mudou, e não ler uma regra que nem se aplica mais a ela.
    exigirMesmaVersao(order, input.esperado ?? null);

    // Sair de EM ABERTO é "assumir", e tem regra própria.
    if (order.status === 'em_aberto') {
      throw new ApiError(
        'CORE_MUST_ASSUME_FIRST',
        'Para tirar a OS de "em aberto" use a ação de assumir, informando um comentário.',
        409,
      );
    }
    if (order.mechanic_id && order.mechanic_id !== input.userId && !input.isManager) {
      throw new ApiError(
        'CORE_ORDER_NOT_ASSIGNED_TO_YOU',
        'Esta OS está atribuída a outro técnico.',
        403,
      );
    }
    // Tirar a OS da fila do caixa desfaz uma conclusão técnica — decisão de
    // gestão, não do técnico: o caixa pode estar com o cliente na frente.
    if (order.status === 'aguardando_pagamento' && !input.isManager) {
      throw new ApiError(
        'CORE_LEAVE_PAYMENT_MANAGER_ONLY',
        'Tirar a OS da fila de pagamento é ação do gerente da oficina.',
        403,
      );
    }
    // Fechar a OS é consequência do pagamento, não uma escolha no quadro.
    if (input.toStatus === 'finalizada') {
      throw new ApiError(
        'CORE_FINALIZE_VIA_PAYMENT',
        'A OS é finalizada pela conclusão técnica e, havendo custo, pela baixa do pagamento no PDV.',
        409,
      );
    }
    if (order.status === 'finalizada') {
      throw new ApiError('CORE_ORDER_CLOSED', 'OS finalizada não pode ser movida.', 409);
    }
    if (order.status === input.toStatus) return order;

    const now = new Date().toISOString();
    getConnection()
      .prepare(
        'UPDATE core_service_orders SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(input.toStatus, now, now, input.orderId);

    addEvent(input.orderId, input.companyId, order.status, input.toStatus, input.userId, input.comment);
    if (input.comment?.trim()) {
      addComment({
        companyId: input.companyId,
        workshopId: input.workshopId,
        orderId: input.orderId,
        userId: input.userId,
        authorName: input.userName,
        authorKind: input.isManager ? 'gestor' : 'tecnico',
        body: input.comment,
      });
    }
    registrarSituacaoNaCentral(input.companyId, input.orderId);

    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * LARGA a OS: devolve ao quadro (EM ABERTO), sem responsável — rodada 51.
 *
 * É o inverso do assumir, e exige JUSTIFICATIVA sempre: um técnico que solta
 * um serviço no meio deve dizer por quê ("não tenho experiência com este
 * defeito", "saio de férias") — é o que o próximo a assumir vai ler primeiro.
 * O gerente também larga OS de outro (remanejamento). OS na fila do caixa ou
 * finalizada não se larga: já saiu da alçada do quadro.
 */
export function releaseOrder(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  reason: string;
  isManager?: boolean;
  /** O retrato que a tela tinha da OS (GAP-PRD-183). Ausente = sem trava. */
  esperado?: VersaoEsperada | null;
}): ServiceOrder {
  ensureCoreSchema();
  if (!input.reason?.trim()) {
    throw new ApiError(
      'CORE_REASON_REQUIRED',
      'Para largar a OS é obrigatória uma justificativa — é ela que o próximo técnico vai ler.',
      400,
    );
  }

  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    exigirMesmaVersao(order, input.esperado ?? null);
    if (order.status === 'em_aberto' || !order.mechanic_id) {
      throw new ApiError('CORE_ORDER_UNASSIGNED', 'Esta OS já está no quadro, sem responsável.', 409);
    }
    if (order.status === 'aguardando_pagamento' || order.status === 'finalizada') {
      throw new ApiError(
        'CORE_ORDER_PAST_BOARD',
        'OS na fila de pagamento ou finalizada já saiu do quadro — não há o que largar.',
        409,
      );
    }
    if (order.mechanic_id !== input.userId && !input.isManager) {
      throw new ApiError(
        'CORE_ORDER_NOT_ASSIGNED_TO_YOU',
        'Esta OS está atribuída a outro técnico.',
        403,
      );
    }

    const now = new Date().toISOString();
    getConnection()
      .prepare(
        `UPDATE core_service_orders
            SET status = 'em_aberto', mechanic_id = NULL, assigned_at = NULL,
                status_changed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, input.orderId);

    addEvent(
      input.orderId,
      input.companyId,
      order.status,
      'em_aberto',
      input.userId,
      'OS devolvida ao quadro',
    );
    addComment({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      authorName: input.userName,
      authorKind: input.isManager ? 'gestor' : 'tecnico',
      body: `Devolveu a OS ao quadro. Motivo: ${input.reason.trim()}`,
    });
    registrarSituacaoNaCentral(input.companyId, input.orderId);

    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * Prioridade e prazo da OS — rodada 51.
 *
 * A mudança fica na LINHA DO TEMPO como comentário automático (o molde do
 * sistema anterior): quadro que reordena sozinho sem dizer quem mandou é
 * quadro em que ninguém confia. Prioridade decide a ordem dentro da coluna e
 * a régua do SLA; o prazo é a promessa ao cliente, visível no card.
 */
export function setOrderPlan(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  priority?: unknown;
  dueDate?: unknown;
  isManager?: boolean;
}): ServiceOrder {
  ensureCoreSchema();
  const temPrioridade = input.priority !== undefined;
  const temPrazo = input.dueDate !== undefined;
  if (!temPrioridade && !temPrazo) {
    throw new ApiError('CORE_PLAN_EMPTY', 'Informe a prioridade ou o prazo.', 400);
  }
  const priority = temPrioridade ? exigirPrioridade(input.priority) : null;
  const dueDate = temPrazo ? exigirPrazo(input.dueDate) : null;

  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    if (order.status === 'finalizada') {
      throw new ApiError('CORE_ORDER_CLOSED', 'OS finalizada não muda de prioridade nem de prazo.', 409);
    }
    // Quem replaneja é o responsável ou a gestão — OS sem dono (em aberto)
    // qualquer técnico pode priorizar: é assim que o quadro triagem-se.
    if (
      order.mechanic_id &&
      order.mechanic_id !== input.userId &&
      !input.isManager
    ) {
      throw new ApiError(
        'CORE_ORDER_NOT_ASSIGNED_TO_YOU',
        'Esta OS está atribuída a outro técnico.',
        403,
      );
    }

    const now = new Date().toISOString();
    const mudancas: string[] = [];
    if (temPrioridade && priority !== order.priority) {
      getConnection()
        .prepare('UPDATE core_service_orders SET priority = ?, updated_at = ? WHERE id = ?')
        .run(priority, now, input.orderId);
      mudancas.push(`prioridade ${rotuloPrioridade(order.priority)} → ${rotuloPrioridade(priority!)}`);
    }
    if (temPrazo && dueDate !== order.due_date) {
      getConnection()
        .prepare('UPDATE core_service_orders SET due_date = ?, updated_at = ? WHERE id = ?')
        .run(dueDate, now, input.orderId);
      mudancas.push(dueDate ? `prazo definido para ${dueDate.slice(0, 10)}` : 'prazo removido');
    }
    if (mudancas.length > 0) {
      addComment({
        companyId: input.companyId,
        workshopId: input.workshopId,
        orderId: input.orderId,
        userId: input.userId,
        authorName: input.userName,
        authorKind: input.isManager ? 'gestor' : 'tecnico',
        body: `Replanejou a OS: ${mudancas.join('; ')}.`,
      });
    }

    return getOrder(input.companyId, input.orderId)!;
  });
}

function rotuloPrioridade(valor: string | null | undefined): string {
  const rotulos: Record<string, string> = {
    urgente: 'Urgente',
    alta: 'Alta',
    media: 'Média',
    baixa: 'Baixa',
  };
  return rotulos[String(valor ?? '')] ?? String(valor ?? 'média');
}

/**
 * Quantidade como a bancada fala.
 *
 * Existe para a MENSAGEM, não para o cálculo: "tem 2" e "tem 2.5" são frases
 * que a pessoa lê no meio do conserto, e "2.0000000001" — que é o que o
 * SQLite devolve para meio metro de fio somado três vezes — faria a recusa
 * parecer defeito. Nunca arredonda para cima: dizer que há mais do que há é
 * exatamente o erro que a recusa existe para impedir.
 */
function quantidadeLegivel(valor: number): string {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Math.trunc(n * 1000) / 1000).replace('.', ',');
}

/**
 * Adiciona peça à OS e PROMETE a peça na mesma transação (rodada 55).
 *
 * Não é baixa: o lançamento acontece antes de o cliente decidir, e o que muda
 * é `reserved`, não `quantity`. A baixa vem quando o serviço é autorizado —
 * aprovação do orçamento ou conclusão técnica. O ciclo inteiro mora em
 * `WorkshopPartsReservation`.
 *
 * A peça precisa pertencer à MESMA oficina — peça de celular não entra em OS
 * de moto.
 *
 * ## DUAS RECUSAS QUE FALTAVAM, e o que cada uma impedia
 *
 * A PEÇA DE GRAÇA. Esta função cobra `product.price_cents`. Produto criado
 * pela importação de XML nasce com preço ZERO de propósito — a nota traz o
 * custo, e o sistema não inventa margem. O encontro das duas coisas dava uma
 * corrente inteira de silêncio: a peça entrava na OS por R$ 0,00, `parts_cents`
 * e `total_cents` ficavam em zero, e `completeTechnical` encerrava "sem custo"
 * sem reclamar, porque a recusa `CORE_HAS_PARTS_COST` só dispara com total
 * maior que zero. A loja dava a peça, e o guarda que existe para impedir isso
 * nunca era chamado. A recusa vem AQUI, no lançamento, e não no fechamento:
 * é neste clique que a pessoa ainda pode resolver o problema, e é aqui que ela
 * descobre que o cadastro está pela metade — não meia hora depois, com a moto
 * montada.
 *
 * FALTA DE PEÇA. É o cenário mais comum da bancada de celular: o aparelho está
 * aberto e o conector acabou. `applyMovement` já recusava, pelo CHECK
 * `quantity >= 0` do saldo, mas com uma frase que não serve a quem está com a
 * chave na mão: "Estoque insuficiente para concluir a operação" não diz QUAL
 * peça nem QUANTO tem. A conferência passou a ser feita antes, com os números
 * na mensagem, e olhando o DISPONÍVEL — o que existe menos o que já está
 * prometido. Consumir o reservado calado quebraria uma promessa registrada em
 * outro lugar, e a promessa tem TRÊS origens (pedido da loja, orçamento e
 * locação): por isso o texto lista as três em vez de culpar uma. O guarda de
 * `applyMovement` continua onde está — este aqui melhora a frase, não substitui
 * a última linha de defesa.
 */
export function addPart(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName?: string;
  isManager?: boolean;
  productId: string;
  quantity: number;
}): ServiceOrder {
  ensureCoreSchema();
  if (!(input.quantity > 0)) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    if (order.mechanic_id && order.mechanic_id !== input.userId) {
      throw new ApiError(
        'CORE_ORDER_NOT_ASSIGNED_TO_YOU',
        'Esta OS está atribuída a outro técnico.',
        403,
      );
    }
    if (order.status === 'finalizada') {
      throw new ApiError('CORE_ORDER_CLOSED', 'OS finalizada não aceita novas peças.', 409);
    }

    const product = db
      .prepare(
        `SELECT p.id, p.name, p.price_cents, p.workshop_id, p.active,
                ${modeloAtivo('p')} AS modelo_ativo
           FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
      )
      .get(input.productId, input.companyId) as
      | {
          id: string;
          name: string;
          price_cents: number;
          workshop_id: string | null;
          active: number;
          modelo_ativo: number;
        }
      | undefined;
    if (!product) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Peça não encontrada.', 404);

    // Peça ARQUIVADA não entra em OS nova: a peça que já foi lançada continua
    // na OS antiga (é histórico), mas o cadastro que a loja tirou de uso não
    // volta a baixar saldo por esta porta.
    if (Number(product.active) !== 1 || Number(product.modelo_ativo) !== 1) {
      throw recusaDeProdutoInativo(product.name, 'entrar numa ordem de serviço', product.id);
    }

    if (product.workshop_id && order.workshop_id && product.workshop_id !== order.workshop_id) {
      throw new ApiError(
        'CORE_PART_OTHER_WORKSHOP',
        'Esta peça pertence ao estoque de outra oficina.',
        403,
      );
    }

    /*
      SEM PREÇO DE VENDA, A PEÇA SAI DE GRAÇA.

      A mensagem diz quem resolve — o cadastro do produto — e NÃO manda o
      leitor a uma tela: quem lê isto quase sempre é o mecânico, e o roteador
      fecha o ambiente de gestão para ele. Mandá-lo a "/sistema/produtos" seria
      apontar uma porta que não abre.
    */
    if (!(Number(product.price_cents) > 0)) {
      throw new ApiError(
        'CORE_PART_WITHOUT_PRICE',
        `A peça "${product.name}" está sem preço de venda: ela entraria na OS por R$ 0,00 e o `
          + 'conserto fecharia sem custo nenhum. Quem define o preço é o cadastro do produto — '
          + 'peça a quem cuida do catálogo antes de lançar.',
        409,
        { productId: product.id, name: product.name },
      );
    }

    /*
      O QUE TEM NA GAVETA, DITO COM NÚMERO.

      Lido aqui e não em `getAvailable` porque já estamos dentro da transação e
      com a conexão em mão — e porque a recusa precisa dos DOIS números
      separados para conseguir explicar a diferença entre "não tem" e "tem, mas
      é de outro compromisso".
    */
    const saldo = db
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(input.companyId, product.id) as { quantity: number; reserved: number } | undefined;
    const emEstoque = Number(saldo?.quantity ?? 0);
    const reservado = Number(saldo?.reserved ?? 0);
    const disponivel = emEstoque - reservado;

    // A folga de 1e-9 é a mesma tolerância que a devolução usa: peça vendida
    // por metro acumula erro de ponto flutuante, e recusar a última unidade por
    // causa do último bit seria mentira do mesmo tamanho.
    if (input.quantity > disponivel + 1e-9) {
      const pedido = quantidadeLegivel(input.quantity);
      // Disponível negativo existe: a reserva pode ficar maior que o saldo se
      // alguém deu baixa por fora. Escrever "tem -1 na gaveta" faria a pessoa
      // achar que o sistema perdeu a conta — o que ela precisa saber é que não
      // há peça, e a conciliação de reserva é problema de outra tela.
      const sobra = quantidadeLegivel(Math.max(0, disponivel));
      const detalhe = {
        productId: product.id,
        name: product.name,
        emEstoque,
        reservado,
        disponivel,
        solicitado: input.quantity,
      };

      /*
        Reservado é promessa de OUTRO compromisso, e a lista mudou duas vezes.

        Ela dizia "pedido da loja, ORÇAMENTO ou contrato de locação" — e
        orçamento NÃO reserva, é papel; quem reserva é a PRÉ-VENDA. A mensagem
        nomeava uma origem impossível e omitia a real.

        E desde a rodada 55 a causa mais provável de todas é OUTRA OS: peça
        prometida a um conserto que ainda não foi autorizado. É por isso que
        ela vem primeiro. Culpar uma origem só descreveria o estado errado, e
        mensagem que descreve o estado errado é pior que nenhuma.
      */
      if (reservado > 0 && emEstoque + 1e-9 >= input.quantity) {
        throw new ApiError(
          'CORE_INSUFFICIENT_STOCK',
          `A peça "${product.name}" tem ${quantidadeLegivel(emEstoque)} na gaveta, mas `
            + `${quantidadeLegivel(reservado)} já está prometida a um compromisso assumido `
            + '(outra OS, pedido da loja online, pré-venda ou contrato de locação). '
            + `Sobra ${sobra} e a OS pediu ${pedido}.`,
          409,
          detalhe,
        );
      }
      throw new ApiError(
        'CORE_INSUFFICIENT_STOCK',
        `Falta peça: "${product.name}" tem ${sobra} na gaveta e a OS pediu ${pedido}.`,
        409,
        detalhe,
      );
    }

    const partId = randomUUID();
    const total = Math.round(product.price_cents * input.quantity);
    db.prepare(
      `INSERT INTO core_service_order_parts
         (id, order_id, company_id, product_id, description, quantity,
          unit_price_cents, total_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      partId,
      input.orderId,
      input.companyId,
      product.id,
      product.name,
      input.quantity,
      product.price_cents,
      total,
      new Date().toISOString(),
    );

    /*
      A PEÇA É PROMETIDA, NÃO BAIXADA (rodada 55).

      Lançar acontece ANTES de o cliente decidir — esta mesma OS precisa de
      peça ou mão de obra para poder pedir a aprovação do orçamento. Baixar
      aqui esvaziava a gaveta para montar uma conta que o cliente ainda podia
      recusar, e a recusa não devolvia nada.

      A promessa não mente sobre a prateleira: a peça continua lá, com dono. O
      que cai é o disponível — e é isso que impede o balcão de vender o que a
      bancada está contando para terminar o serviço. A baixa vem quando o
      serviço é autorizado a acontecer (aprovação ou conclusão técnica).

      A escolha da UNIDADE serializada foi junto com a baixa, e é onde ela tem
      de estar: o mecânico pega a peça da prateleira na hora de montar, não na
      hora de orçar.
    */
    prometerPeca({
      companyId: input.companyId,
      orderId: input.orderId,
      partId,
      productId: product.id,
      quantity: input.quantity,
      orderNumber: order.number,
      userId: input.userId,
    });

    recalculateTotals(input.orderId);
    // Peça nova muda o total: se havia aprovação de pé, ela cai — o aceite
    // velho não cobre o valor novo (a doutrina inteira mora no helper).
    derrubarAprovacaoSeOValorMudou({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      userName: input.userName,
      isManager: input.isManager,
      antes: order,
    });
    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * A conta das peças da OS.
 *
 * ## O QUE VOLTOU PARA A GAVETA NÃO É COBRADO
 *
 * A soma era `SUM(total_cents)` — o total da linha como ela foi requisitada. A
 * devolução existia no servidor e nenhuma tela a chamava, então ninguém tinha
 * como perceber: agora que a OS tem o botão de devolver, o defeito ficaria à
 * vista no primeiro parafuso que voltasse. O mecânico pega três, usa dois,
 * devolve um — e o cliente pagava os três.
 *
 * Pior que a cobrança a mais: a OS ficava com `total_cents > 0` mesmo com TUDO
 * devolvido, e `completeTechnical` recusava encerrá-la sem custo por
 * `CORE_HAS_PARTS_COST`. Uma OS de garantia em que nada foi usado não fechava.
 *
 * A linha guarda a HISTÓRIA (quanto saiu, quanto voltou, a que preço) e a
 * conta é derivada dela. Reescrever `total_cents` da linha apagaria o que foi
 * requisitado, que é o que a devolução parcial precisa ter para saber quanto
 * ainda pode voltar.
 */
function recalculateTotals(orderId: string): void {
  const db = getConnection();
  const totals = db
    .prepare(
      `SELECT COALESCE(
                SUM(ROUND(unit_price_cents * (quantity - COALESCE(returned_quantity, 0)))),
                0
              ) AS parts
         FROM core_service_order_parts
        WHERE order_id = ?`,
    )
    .get(orderId) as { parts: number };
  db.prepare(
    `UPDATE core_service_orders
        SET parts_cents = ?, total_cents = labor_cents + ?, updated_at = ?
      WHERE id = ?`,
  ).run(totals.parts, totals.parts, new Date().toISOString(), orderId);
}

/**
 * Refaz a conta da OS de fora — para quem mexe nas peças por outro caminho.
 *
 * Existe por causa de UM chamador: a devolução de peça, que mora em
 * `WorkshopPartsService` e altera `returned_quantity`. Sem esta porta, a conta
 * só seria refeita no próximo lançamento de peça, e a OS ficaria cobrando pelo
 * que já está de volta na prateleira até que alguém, por acaso, lançasse outra
 * coisa.
 *
 * ## E A APROVAÇÃO CAI JUNTO (GAP-PRD-103)
 *
 * A devolução mudava o total e deixava `approved_at` de pé: a OS seguia
 * "aprovada" sobre um valor que o cliente nunca viu. É a mesma doutrina de
 * `addPart` e `setLabor` — mudou o valor com aprovação de pé, a aprovação cai
 * —, e por isso quem chama passa a OS COMO ERA (`mudanca.antes`) e quem assina.
 */
export function recalcularTotaisDaOS(
  orderId: string,
  mudanca?: {
    companyId: string;
    workshopId: string | string[] | null;
    userId: string;
    userName?: string;
    isManager?: boolean;
    antes: ServiceOrder;
  },
): void {
  ensureCoreSchema();
  recalculateTotals(orderId);
  if (mudanca) {
    derrubarAprovacaoSeOValorMudou({ ...mudanca, orderId });
  }
}

/**
 * A oficina PEDE a aprovação do orçamento — o primeiro dos dois tempos.
 *
 * `approved_at` nasceu na DDL e ficou MORTA por 42 rodadas: zero leitores,
 * zero escritores. O aprovar acontecia por telefone e não deixava rastro. O
 * desenho da rodada 43: esta função registra O PEDIDO (`approval_requested_at`,
 * migração 61) e o cliente decide NO PORTAL DELE (`decidirOrcamento` em
 * `EquipmentPortalService`) — a decisão é de quem paga, não de quem cobra.
 *
 * Pedir de novo APAGA a aprovação anterior: se a oficina mexeu no orçamento,
 * o "sim" antigo valia para OUTRO valor. Manter a aprovação velha seria
 * cobrar R$ 900 com o aceite dos R$ 300.
 */
export function pedirAprovacaoOrcamento(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  isManager: boolean;
}): ServiceOrder {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    // Só faz sentido enquanto o serviço está vivo. Depois de concluída,
    // aguardando pagamento ou entregue, o orçamento já virou conta.
    if (!isOrderOnBench(order.status)) {
      throw new ApiError(
        'CORE_ORDER_NOT_OPEN',
        'A OS não está em andamento — o orçamento já virou conta.',
        409,
      );
    }
    // Orçamento zerado não tem o que aprovar — e mandaria o cliente decidir
    // sobre um valor que ainda não existe.
    if (order.total_cents <= 0) {
      throw new ApiError(
        'CORE_BUDGET_EMPTY',
        'Lance mão de obra ou peças antes de pedir a aprovação.',
        409,
      );
    }
    /*
      REORÇAR REPROMETE A PEÇA — a aresta que faltava no ciclo.

      Quem chega aqui pela SEGUNDA vez está reorçando: o cliente recusou, a
      oficina negociou, e agora pede aprovação de novo. A recusa tinha SOLTADO
      as peças (`soltarPromessasDaOs`), e nada as reservava de volta.

      A linha da peça continuava na conta — no `total_cents` que o cliente está
      sendo convidado a aprovar — sem nenhuma reserva atrás dela. O balcão
      vendia a mesma peça, e o cliente que apertasse "Aprovar" recebia 409
      falando de estoque, sobre o qual ele não tem ação nenhuma. Pior: o
      rollback desfazia o `approved_at` junto, então o botão ficava quebrado
      para sempre naquela OS.

      A recusa por falta de estoque passa a acontecer AQUI, onde quem está na
      frente da tela é a oficina — que pode comprar a peça, trocá-la ou tirar a
      linha. Na mesma transação do `approval_requested_at`: ou o pedido de
      aprovação sai com as peças guardadas, ou não sai.

      Primeira volta não faz nada: não há peça solta para reprometer.
    */
    const repromedidas = reprometerPromessasDaOs({
      companyId: input.companyId,
      orderId: input.orderId,
      orderNumber: order.number,
      userId: input.userId,
    });

    getConnection()
      .prepare(
        `UPDATE core_service_orders
            SET approval_requested_at = ?, approved_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), input.orderId);
    // O cliente precisa SABER (GAP-PRD-036): o aviso entra na fila junto com o
    // pedido — e a linha do tempo diz por onde ele foi, ou que não há por onde.
    const aviso = avisarOrcamentoDisponivel(input.companyId, input.orderId, {
      estavaPendente: Boolean(order.approval_requested_at) && !order.approved_at,
    });
    addComment({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      authorName: input.userName,
      authorKind: input.isManager ? 'gestor' : 'tecnico',
      body:
        `Orçamento de R$ ${(order.total_cents / 100).toFixed(2).replace('.', ',')} aguardando aprovação do cliente.`
        + (aviso.para
          ? ` Aviso por e-mail para ${aviso.para}.`
          : ' Cliente sem e-mail cadastrado: avise por telefone.')
        + (repromedidas > 0
          ? ` ${repromedidas === 1 ? 'A peça voltou a ficar reservada' : `${repromedidas} peças voltaram a ficar reservadas`} na gaveta.`
          : ''),
    });
    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * O ACEITE POR TELEFONE, REGISTRADO PELO BALCÃO — a porta que não existia.
 *
 * O desenho da rodada 43 deixou a decisão só no portal (`decidirOrcamento`,
 * EquipmentPortalService): a decisão é de quem paga. Só que metade dos aceites
 * chega por TELEFONE — e o balcão não tinha onde registrá-los: `approved_at`
 * ficava vazio, e o "sim" do cliente virava memória de quem atendeu. O achado
 * da auditoria: a OS aprovada por telefone era indistinguível da nunca
 * aprovada.
 *
 * A DECISÃO EM SI continua sendo UMA — a do portal, injetada como `decidir`
 * pelo mesmo motivo que `converterChamado` injeta `criarOrdem`: o serviço do
 * portal já importa este arquivo, e importá-lo de volta fecharia um ciclo.
 * Reusar (e não copiar) é o que garante que aprovar no balcão consome as
 * mesmas promessas de peça, respeita o mesmo "não há orçamento pendente" e a
 * mesma idempotência do clique repetido.
 *
 * O que esta função ACRESCENTA é a autoria: quem atendeu o telefone assina a
 * linha do tempo com a voz DA LOJA (gestor/técnico — a fala 'proprietario'
 * continua sendo só do portal, onde é o dono quem clica), e a rota grava
 * auditoria de quem registrou. Tudo na MESMA transação: decisão sem autoria
 * seria exatamente o buraco que se está fechando.
 *
 * OS sem cliente vinculado não passa: o aceite é DE ALGUÉM, e sem cadastro
 * não há quem tenha aceitado — nem portal, nem telefone.
 */
export function decidirOrcamentoNoBalcao(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  approved: boolean;
  note?: string | null;
  isManager?: boolean;
  /** A decisão do portal (`decidirOrcamento`), injetada para não fechar ciclo de import. */
  decidir: (
    customerIds: string[],
    orderId: string,
    decisao: 'aprovar' | 'recusar',
  ) => unknown;
}): ServiceOrder {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    if (!order.customer_id) {
      throw new ApiError(
        'CORE_ORDER_WITHOUT_CUSTOMER',
        'A OS não tem cliente vinculado — vincule o cadastro antes de registrar o aceite dele.',
        409,
      );
    }

    // A mesma régua do portal: pendência conferida, promessa consumida (ou
    // solta), clique repetido sem efeito novo.
    input.decidir([order.customer_id], input.orderId, input.approved ? 'aprovar' : 'recusar');

    const note = texto(input.note);
    addComment({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      authorName: input.userName,
      authorKind: input.isManager ? 'gestor' : 'tecnico',
      body:
        (input.approved
          ? 'Aceite do orçamento registrado pelo balcão — o cliente confirmou por telefone.'
          : 'Recusa do orçamento registrada pelo balcão — o cliente respondeu por telefone.')
        + (note ? ` Obs.: ${note}` : ''),
    });

    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * MUDOU O VALOR COM A APROVAÇÃO DE PÉ? A APROVAÇÃO CAI.
 *
 * A regra já estava escrita em `pedirAprovacaoOrcamento` ("Manter a aprovação
 * velha seria cobrar R$ 900 com o aceite dos R$ 300") — mas só o RE-PEDIDO a
 * cumpria. Mexer no orçamento por fora (mão de obra ou peça) mudava
 * `total_cents` e deixava `approved_at` intacto: a OS seguia "aprovada" com um
 * total que o cliente nunca viu, e o checkout cobrava o valor novo sobre o
 * aceite do valor velho.
 *
 * Derrubar (e não recusar a mudança) é o menos disruptivo para a bancada: o
 * serviço continua, a conta fica certa, e o que a OS perde é só a AFIRMAÇÃO
 * que deixou de ser verdade. O caminho de volta é o mesmo de sempre — pedir a
 * aprovação de novo, que repromete peça solta e registra o valor novo. Por
 * isso o pedido também é limpo: "pendente de novo aceite" é orçamento em
 * edição, não orçamento na mesa do cliente.
 *
 * A peça que o aceite antigo JÁ CONSUMIU não volta sozinha para a gaveta —
 * ela pode estar dentro da moto. Devolvê-la é decisão de gente (a rota de
 * devolução), não efeito colateral de digitar outra mão de obra.
 */
function derrubarAprovacaoSeOValorMudou(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName?: string;
  isManager?: boolean;
  /** A OS COMO ERA antes da mudança de valor — é dela que sai o total aprovado. */
  antes: ServiceOrder;
}): void {
  if (!input.antes.approved_at) return;
  const depois = getOrder(input.companyId, input.orderId)!;
  if (Number(depois.total_cents) === Number(input.antes.total_cents)) return;

  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `UPDATE core_service_orders
          SET approved_at = NULL, approval_requested_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(agora, input.orderId);

  const de = (Number(input.antes.total_cents) / 100).toFixed(2).replace('.', ',');
  const para = (Number(depois.total_cents) / 100).toFixed(2).replace('.', ',');
  addComment({
    companyId: input.companyId,
    workshopId: input.workshopId,
    orderId: input.orderId,
    userId: input.userId,
    authorName: input.userName ?? 'Oficina',
    authorKind: input.isManager ? 'gestor' : 'tecnico',
    body:
      `Orçamento alterado (de R$ ${de} para R$ ${para}) com aprovação de pé — `
      + 'a aprovação caiu e requer novo aceite do cliente.',
  });
}

export function setLabor(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName?: string;
  laborCents: number;
  isManager?: boolean;
}): ServiceOrder {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    if (order.mechanic_id && order.mechanic_id !== input.userId) {
      throw new ApiError('CORE_ORDER_NOT_ASSIGNED_TO_YOU', 'OS de outro técnico.', 403);
    }
    /*
      A GUARDA QUE FALTAVA. Toda porta vizinha recusa OS finalizada — `addPart`
      (CORE_ORDER_CLOSED), a devolução (CORE_ORDER_FINISHED), o movimento, o
      plano, a foto — e a mão de obra passava: um POST reescrevia `labor_cents`
      e `total_cents` de uma OS FINALIZADA E PAGA, e a ordem passava a divergir
      da venda e do financeiro que ela mesma gerou, sem erro e sem rastro.
    */
    if (order.status === 'finalizada') {
      throw new ApiError(
        'CORE_ORDER_CLOSED',
        'OS finalizada não muda de mão de obra — o total dela já virou venda e financeiro.',
        409,
      );
    }
    getConnection()
      .prepare('UPDATE core_service_orders SET labor_cents = ? WHERE id = ?')
      .run(Math.max(0, Math.round(input.laborCents)), input.orderId);
    recalculateTotals(input.orderId);
    derrubarAprovacaoSeOValorMudou({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      userName: input.userName,
      isManager: input.isManager,
      antes: order,
    });
    return getOrder(input.companyId, input.orderId)!;
  });
}

/**
 * Conclusão TÉCNICA — não é o fim da OS.
 *
 * Com custo  -> AGUARDANDO PAGAMENTO, e a OS aparece no PDV da oficina.
 * Sem custo  -> FINALIZADA, mas só com motivo permitido (garantia).
 */
export function completeTechnical(input: {
  companyId: string;
  workshopId: string | string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  diagnosis: string;
  hasCost: boolean;
  noCostReason?: string;
  /** Conclui apesar da conferência de entrada incompleta (fica registrado). */
  forcarChecklist?: boolean;
}): ServiceOrder {
  ensureCoreSchema();
  if (!input.diagnosis?.trim()) {
    throw new ApiError('CORE_DIAGNOSIS_REQUIRED', 'Informe o diagnóstico/conclusão.', 400);
  }

  return withTransaction(() => {
    const order = requireScopedOrder(input.companyId, input.workshopId, input.orderId);
    if (!order.mechanic_id) {
      throw new ApiError('CORE_ORDER_NOT_ASSIGNED', 'A OS ainda não foi assumida.', 409);
    }
    if (order.mechanic_id !== input.userId) {
      throw new ApiError('CORE_ORDER_NOT_ASSIGNED_TO_YOU', 'OS de outro técnico.', 403);
    }
    if (order.status === 'finalizada') return order;

    /*
      O CHECKLIST DE ENTRADA SEGURA A CONCLUSÃO (rodada 52).

      Item PENDENTE é item que ninguém conferiu — e a conferência de entrada
      só serve se acontecer. Responder "não veio" é resposta legítima e não
      bloqueia nada; o que não pode é a lista chegar no fim do serviço em
      branco, quando o cliente já não está para confirmar.

      A saída de emergência existe (`forcarChecklist`), como no sistema
      anterior — e, como lá, ela fica REGISTRADA: a bancada não trava, mas a
      decisão tem nome e hora na linha do tempo.
    */
    const pendentes = itensPendentes(input.companyId, input.orderId);
    if (pendentes > 0 && !input.forcarChecklist) {
      throw new ApiError(
        'CORE_CHECKLIST_PENDING',
        `A conferência de entrada tem ${pendentes} item(ns) sem resposta.`,
        409,
        { pendentes },
      );
    }

    const db = getConnection();
    const now = new Date().toISOString();

    if (!input.hasCost) {
      const reason = (input.noCostReason ?? '').trim();
      // Sem isto, qualquer serviço cobrável poderia ser "perdoado" no clique.
      if (!NO_COST_REASONS.has(reason)) {
        throw new ApiError(
          'CORE_NO_COST_REASON_REQUIRED',
          `OS sem custo exige motivo válido (${[...NO_COST_REASONS].join(', ')}).`,
          400,
        );
      }
      if (order.total_cents > 0) {
        throw new ApiError(
          'CORE_HAS_PARTS_COST',
          'A OS possui peças lançadas; não pode ser encerrada sem custo.',
          409,
        );
      }
      db.prepare(
        `UPDATE core_service_orders
            SET status = 'finalizada', diagnosis = ?, has_cost = 0, no_cost_reason = ?,
                status_changed_at = ?, closed_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(input.diagnosis, reason, now, now, now, input.orderId);
      addEvent(input.orderId, input.companyId, order.status, 'finalizada', input.userId, `Sem custo: ${reason}`);
    } else {
      /*
        O SERVIÇO ACONTECEU: a peça prometida saiu de verdade.

        É aqui, e não no pagamento, que a peça deixa a prateleira — porque é
        aqui que o mecânico declara que montou. Esperar o pagamento faria o
        sistema dizer que há três controladores na gaveta enquanto um deles já
        está dentro de uma moto, e a contagem de inventário acusaria uma
        diferença que não existe.

        A OS que passou pela aprovação do cliente já consumiu lá; esta chamada
        pega só o que sobrou prometido — a OS que o cliente autorizou por
        telefone, ou a que nunca precisou de orçamento.
      */
      consumirPromessasDaOs({
        companyId: input.companyId,
        orderId: input.orderId,
        orderNumber: order.number,
        userId: input.userId,
      });

      db.prepare(
        `UPDATE core_service_orders
            SET status = 'aguardando_pagamento', diagnosis = ?, has_cost = 1,
                status_changed_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(input.diagnosis, now, now, input.orderId);
      addEvent(
        input.orderId,
        input.companyId,
        order.status,
        'aguardando_pagamento',
        input.userId,
        'Conclusão técnica — aguardando pagamento',
      );
    }

    addComment({
      companyId: input.companyId,
      workshopId: input.workshopId,
      orderId: input.orderId,
      userId: input.userId,
      authorName: input.userName,
      body: input.diagnosis,
    });

    // Concluiu com a conferência pela metade: quem decidiu, e quantos itens
    // ficaram sem resposta, ficam ditos na linha do tempo.
    if (pendentes > 0) {
      addComment({
        companyId: input.companyId,
        workshopId: input.workshopId,
        orderId: input.orderId,
        userId: input.userId,
        authorName: input.userName,
        body: `Concluiu com a conferência de entrada incompleta (${pendentes} item(ns) sem resposta).`,
      });
    }

    /*
      O PEDIDO DE APROVAÇÃO SEM RESPOSTA SE ENCERRA AQUI (GAP-PRD-182).

      A OS saiu da bancada: o orçamento virou conta (ou garantia), e não há
      mais o que o cliente decidir. Deixar `approval_requested_at` de pé
      mantinha os botões de aprovar e recusar no portal do dono — e a recusa
      dele, registrada numa OS já na fila do caixa, fazia a linha do tempo
      contradizer o estado. O pedido se encerra com o motivo escrito; a
      aprovação JÁ DADA fica, porque ela é um fato.
    */
    if (order.approval_requested_at && !order.approved_at) {
      db.prepare(
        'UPDATE core_service_orders SET approval_requested_at = NULL, updated_at = ? WHERE id = ?',
      ).run(now, input.orderId);
      addComment({
        companyId: input.companyId,
        workshopId: input.workshopId,
        orderId: input.orderId,
        userId: input.userId,
        authorName: input.userName,
        body:
          'Pedido de aprovação encerrado sem resposta do cliente: a OS foi concluída tecnicamente '
          + 'e o orçamento deixou de estar em decisão.',
      });
    }

    registrarSituacaoNaCentral(input.companyId, input.orderId);

    const updated = getOrder(input.companyId, input.orderId)!;
    if (updated.equipment_id) {
      recordEquipmentEvent({
        equipmentId: updated.equipment_id,
        companyId: input.companyId,
        eventType: 'service_completed',
        description: `OS #${updated.number}: ${input.diagnosis}`,
        userId: input.userId,
        orderId: updated.id,
      });
    }
    // Pronta (com custo) ou concluída (sem custo): o cliente fica sabendo (GAP-PRD-036).
    avisarConclusaoTecnica(input.companyId, input.orderId);
    return updated;
  });
}

/**
 * Baixa do pagamento, chamada pelo PDV da oficina depois da venda.
 * É o único caminho para FINALIZADA quando há custo.
 */
export function settleOrder(input: {
  companyId: string;
  orderId: string;
  userId: string;
  saleId: string;
}): ServiceOrder {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = getOrder(input.companyId, input.orderId);
    if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'OS não encontrada.', 404);
    if (order.status === 'finalizada') return order;
    if (order.status !== 'aguardando_pagamento') {
      throw new ApiError(
        'CORE_ORDER_NOT_AWAITING_PAYMENT',
        'A OS não está aguardando pagamento.',
        409,
      );
    }

    const now = new Date().toISOString();

    /*
      A REDE DE SEGURANÇA DA PROMESSA.

      Em operação normal não sobra nada: a única porta para "aguardando
      pagamento" é a conclusão técnica, e ela já consumiu. Mas OS antiga —
      aberta antes desta rodada, ou que chegou aqui por caminho que ainda não
      existe — pode ter promessa de pé, e uma OS finalizada com peça ainda
      "prometida" seguraria a gaveta para sempre. Consumir aqui é barato e o
      razão recusa a repetição.
    */
    consumirPromessasDaOs({
      companyId: input.companyId,
      orderId: input.orderId,
      orderNumber: order.number,
      userId: input.userId,
    });

    getConnection()
      .prepare(
        `UPDATE core_service_orders
            SET status = 'finalizada', sale_id = ?, paid_at = ?, status_changed_at = ?,
                closed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(input.saleId, now, now, now, now, input.orderId);

    addEvent(
      input.orderId,
      input.companyId,
      'aguardando_pagamento',
      'finalizada',
      input.userId,
      'Pagamento confirmado no PDV',
    );
    // A OS terminou — o cliente recebe o registro (GAP-PRD-036).
    avisarOsPaga(input.companyId, input.orderId);
    registrarSituacaoNaCentral(input.companyId, input.orderId);
    return getOrder(input.companyId, input.orderId)!;
  });
}

export function listOrders(
  companyId: string,
  options: { workshopId?: string | null; mechanicId?: string; customerId?: string } = {},
): ServiceOrder[] {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = 'SELECT * FROM core_service_orders WHERE company_id = ?';
  if (options.workshopId) {
    sql += ' AND workshop_id = ?';
    params.push(options.workshopId);
  }
  if (options.mechanicId) {
    sql += ' AND mechanic_id = ?';
    params.push(options.mechanicId);
  }
  if (options.customerId) {
    sql += ' AND customer_id = ?';
    params.push(options.customerId);
  }
  sql += ' ORDER BY number DESC LIMIT 300';
  return getConnection().prepare(sql).all(...(params as never[])) as unknown as ServiceOrder[];
}

export interface OrderSearchFilters {
  /**
   * As oficinas que esta sessão pode ver. `null` significa "todas as da
   * empresa" — e é um escopo LEGÍTIMO, não a ausência de filtro.
   *
   * A diferença importa: o caixa da oficina não é membro de oficina nenhuma
   * (conferido no banco da loja: só os mecânicos têm vínculo), e é ele quem
   * atende a fila de pagamento. Traduzir "não é membro" para lista vazia
   * fecharia o caixa junto com o buraco que se queria fechar.
   */
  workshopIds?: string[] | null;
  statuses?: string[];
  mechanicId?: string;
  customerId?: string;
  equipmentId?: string;
  /** Busca livre: número da OS, nome do cliente, placa ou queixa. */
  q?: string;
  limit?: number;
  offset?: number;
  /**
   * A ordem da lista (GAP-PRD-187).
   *
   *   'recentes' (padrão)  número DESC — a lista de OS e a coluna de
   *                        finalizadas, onde o que interessa é o que acabou
   *                        de acontecer;
   *   'quadro'             prioridade (urgente → baixa) e, dentro dela, a
   *                        MAIS ANTIGA primeiro — a ordem que o card já tinha
   *                        na tela. Com o número DESC, a coluna cheia cortava
   *                        justamente as antigas, que são as de SLA estourado.
   */
  ordem?: 'recentes' | 'quadro';
}

export interface OrderSearchResult {
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Busca de OS com filtros, servindo o quadro e a lista.
 *
 * ## Por que a projeção, e não `SELECT *`
 *
 * O cartão precisa dizer QUAL aparelho é. Com o vínculo, `equipment` (texto
 * livre) passa a ser nulo — quem sabe o nome é o cadastro. Projetar
 * `equipment_display` aqui evita que cada tela refaça o mesmo COALESCE e evite
 * que a que esquecer mostre o cartão em branco.
 *
 * O mesmo vale para o cliente: `customer_display` é o nome do cadastro quando
 * há vínculo, e o texto digitado quando não há.
 *
 * ## A OS sem oficina não some
 *
 * Existe OS gravada antes de `workshop_id` existir. Ela não pertence a oficina
 * nenhuma, e um `IN (...)` puro a excluiria para sempre — inclusive do gestor.
 * Por isso o filtro sempre aceita `workshop_id IS NULL` junto.
 */
export function searchOrders(
  companyId: string,
  filtros: OrderSearchFilters = {},
): OrderSearchResult {
  ensureCoreSchema();
  const where: string[] = ['o.company_id = ?'];
  const params: unknown[] = [companyId];

  if (filtros.workshopIds && filtros.workshopIds.length > 0) {
    const marcas = filtros.workshopIds.map(() => '?').join(', ');
    where.push(`(o.workshop_id IN (${marcas}) OR o.workshop_id IS NULL)`);
    params.push(...filtros.workshopIds);
  } else if (filtros.workshopIds && filtros.workshopIds.length === 0) {
    // Lista vazia explícita é "nenhuma oficina permitida" — diferente de
    // `null`, que é "todas". Quem passar isso quer mesmo zero resultados.
    where.push('1 = 0');
  }

  if (filtros.statuses?.length) {
    where.push(`o.status IN (${filtros.statuses.map(() => '?').join(', ')})`);
    params.push(...filtros.statuses);
  }
  if (filtros.mechanicId) {
    where.push('o.mechanic_id = ?');
    params.push(filtros.mechanicId);
  }
  if (filtros.customerId) {
    where.push('o.customer_id = ?');
    params.push(filtros.customerId);
  }
  if (filtros.equipmentId) {
    where.push('o.equipment_id = ?');
    params.push(filtros.equipmentId);
  }
  if (filtros.q?.trim()) {
    const termo = `%${filtros.q.trim()}%`;
    // O número entra na busca porque é como o balcão chama a OS ("a 47 ficou
    // pronta?"). Comparado como texto para casar busca parcial.
    where.push(
      `(CAST(o.number AS TEXT) LIKE ? OR o.plate LIKE ? COLLATE NOCASE
        OR COALESCE(c.name, o.customer_name) LIKE ? COLLATE NOCASE
        OR o.complaint LIKE ? COLLATE NOCASE)`,
    );
    params.push(termo, termo, termo, termo);
  }

  const filtro = where.join(' AND ');
  const db = getConnection();

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM core_service_orders o
           LEFT JOIN core_customers c ON c.id = o.customer_id
          WHERE ${filtro}`,
      )
      .get(...(params as never[])) as { n: number }
  ).n;

  const limit = Math.min(Math.max(Number(filtros.limit ?? 100), 1), 300);
  const offset = Math.max(Number(filtros.offset ?? 0), 0);

  const items = db
    .prepare(
      `SELECT o.*,
              COALESCE(c.name, o.customer_name)                    AS customer_display,
              CASE WHEN o.customer_id IS NOT NULL THEN 1 ELSE 0 END AS customer_vinculado,
              COALESCE(NULLIF(TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')), ''), o.equipment)
                                                                    AS equipment_display,
              e.public_id                                          AS equipment_public_id,
              u.display_name                                       AS mechanic_name,
              w.name                                               AS workshop_name
         FROM core_service_orders o
         LEFT JOIN core_customers c ON c.id = o.customer_id
         LEFT JOIN core_equipment e ON e.id = o.equipment_id
         LEFT JOIN core_users     u ON u.id = o.mechanic_id
         LEFT JOIN core_workshops w ON w.id = o.workshop_id AND w.company_id = o.company_id
        WHERE ${filtro}
        ORDER BY ${
          filtros.ordem === 'quadro'
            ? `CASE o.priority WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2
                               WHEN 'baixa' THEN 3 ELSE 9 END, o.number ASC`
            : 'o.number DESC'
        }
        LIMIT ? OFFSET ?`,
    )
    .all(...([...params, limit, offset] as never[])) as unknown as Record<string, unknown>[];

  // O que está fora das regras (GAP-PRD-188) vai pronto: o card e a ficha
  // leem a MESMA conta, feita aqui.
  for (const item of items) item.irregularidades = irregularidadesDaOs(item);

  return { items, total, limit, offset };
}

export function getOrderDetail(
  companyId: string,
  alcance: string | string[] | null,
  orderId: string,
): Record<string, unknown> | null {
  ensureCoreSchema();
  const order = requireScopedOrder(companyId, alcance, orderId);
  const db = getConnection();

  // Os mesmos nomes que a busca projeta. A tela de detalhe e o cartão do quadro
  // têm de dizer a MESMA coisa sobre o mesmo aparelho — com o vínculo, o texto
  // livre fica nulo e quem sabe o nome é o cadastro.
  const vinculo = db
    .prepare(
      `SELECT COALESCE(c.name, o.customer_name) AS customer_display,
              c.phone                           AS customer_phone,
              COALESCE(NULLIF(TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, '')), ''), o.equipment)
                                                AS equipment_display,
              e.public_id                       AS equipment_public_id,
              e.serial_number                   AS equipment_serial,
              u.display_name                    AS mechanic_name,
              w.name                            AS workshop_name
         FROM core_service_orders o
         LEFT JOIN core_customers c ON c.id = o.customer_id
         LEFT JOIN core_equipment e ON e.id = o.equipment_id
         LEFT JOIN core_users     u ON u.id = o.mechanic_id
         LEFT JOIN core_workshops w ON w.id = o.workshop_id AND w.company_id = o.company_id
        WHERE o.id = ?`,
    )
    .get(orderId) as Record<string, unknown>;

  return {
    ...order,
    ...vinculo,
    irregularidades: irregularidadesDaOs(order),
    parts: db
      .prepare('SELECT * FROM core_service_order_parts WHERE order_id = ? ORDER BY created_at')
      .all(orderId),
    comments: db
      .prepare(
        'SELECT * FROM core_service_order_comments WHERE order_id = ? ORDER BY created_at',
      )
      .all(orderId),
    events: db
      .prepare('SELECT * FROM core_service_order_events WHERE order_id = ? ORDER BY created_at')
      .all(orderId),
  };
}
