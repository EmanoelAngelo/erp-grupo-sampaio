/**
 * Checklist de ENTRADA da OS — o que chegou junto com o aparelho.
 *
 * ## Isto NÃO veio do sistema anterior
 *
 * Lá existia um "checklist" de TAREFAS digitado à mão dentro da OS ("trocar
 * pneu dianteiro", "teste de rodagem"), que bloqueava a finalização quando
 * ficava pela metade — e que só podia ser preenchido no card do quadro,
 * enquanto a tela de detalhe bloqueava sem oferecer onde completar. Útil, mas
 * é outra coisa.
 *
 * O que faltava, e o que esta lista é: a CONFERÊNCIA DE ENTRADA. A discussão
 * que a oficina conhece — "o carregador veio junto", "esse risco já era
 * assim", "o aparelho ligava quando eu trouxe" — se resolve com uma lista
 * conferida na frente do cliente, no dia em que a máquina entrou.
 *
 * ## O modelo depende da BANCADA, não da empresa
 *
 * Moto tem chave, retrovisor e carregador; celular tem chip, cartão e senha
 * de desbloqueio. `capabilitiesFor` já separa as duas bancadas por `kind`
 * (mobility/phones) desde a rodada 18 — o modelo do checklist segue a mesma
 * divisão, e é por isso que ele nasce COM a OS: depois, ninguém lembra.
 *
 * ## O que bloqueia, e o que não
 *
 * Item `pendente` é item que ninguém conferiu — e é só ele que segura a
 * conclusão técnica. Responder "não veio" é resposta legítima: o que não pode
 * é a lista chegar no fim do serviço sem ninguém ter olhado. E, como no
 * sistema anterior, existe a saída de emergência: concluir com
 * `forcarChecklist`, que fica REGISTRADO na linha do tempo — a bancada não
 * fica presa, mas a decisão tem nome e hora.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

/** As respostas possíveis. `pendente` é o único que bloqueia. */
export const CHECKLIST_ANSWERS = ['pendente', 'sim', 'nao'] as const;
export type ChecklistAnswer = (typeof CHECKLIST_ANSWERS)[number];
const ANSWER_SET = new Set<string>(CHECKLIST_ANSWERS);

/**
 * Os modelos, por tipo de bancada.
 *
 * Escritos como a pessoa pergunta no balcão, não como um formulário fala.
 * Mudar esta lista NÃO mexe nas OS já abertas: o checklist é copiado para a
 * OS no nascimento, e a lista de uma OS de março continua sendo a de março.
 */
export const CHECKLIST_TEMPLATES: Record<string, string[]> = {
  mobility: [
    'Chave / controle remoto',
    'Carregador',
    'Bateria (e trava)',
    'Retrovisores',
    'Espelho, lanterna e sinaleiras funcionando',
    'Pneus e freios em uso normal',
    'Riscos, amassados ou trincas já existentes',
    'Bagageiro, baú ou acessórios',
    'Documento do veículo',
  ],
  phones: [
    'Chip (SIM)',
    'Cartão de memória',
    'Capa e película',
    'Carregador e cabo',
    'Aparelho liga',
    'Tela trincada ou riscada',
    'Marcas de água ou queda',
    'Senha / desbloqueio informado',
  ],
};

/** Bancada de tipo desconhecido não inventa lista — nasce sem checklist. */
export function templateFor(kind: string | null | undefined): string[] {
  return CHECKLIST_TEMPLATES[String(kind ?? '')] ?? [];
}

export interface ChecklistItem {
  id: string;
  order_id: string;
  item: string;
  answer: string;
  note: string | null;
  position: number;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
}

export function listChecklist(companyId: string, orderId: string): ChecklistItem[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_service_order_checklist
        WHERE company_id = ? AND order_id = ?
        ORDER BY position, created_at`,
    )
    .all(companyId, orderId) as unknown as ChecklistItem[];
}

/**
 * Cria o checklist da OS a partir do modelo da bancada.
 *
 * Roda DENTRO da transação que abre a OS. Bancada sem modelo (ou OS sem
 * bancada) simplesmente não ganha lista — não existe checklist vazio de
 * enfeite.
 */
export function criarChecklistDaOs(input: {
  companyId: string;
  orderId: string;
  workshopId: string | null;
}): void {
  if (!input.workshopId) return;
  const db = getConnection();
  const bancada = db
    .prepare('SELECT kind FROM core_workshops WHERE id = ? AND company_id = ?')
    .get(input.workshopId, input.companyId) as { kind: string } | undefined;
  const itens = templateFor(bancada?.kind);
  if (itens.length === 0) return;

  const agora = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO core_service_order_checklist
       (id, order_id, company_id, item, answer, position, created_at)
     VALUES (?, ?, ?, ?, 'pendente', ?, ?)`,
  );
  itens.forEach((item, i) => {
    stmt.run(randomUUID(), input.orderId, input.companyId, item, i, agora);
  });
}

/** Quantos itens ninguém conferiu ainda. */
export function itensPendentes(companyId: string, orderId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COUNT(*) AS c FROM core_service_order_checklist
        WHERE company_id = ? AND order_id = ? AND answer = 'pendente'`,
    )
    .get(companyId, orderId) as { c: number };
  return Number(row?.c ?? 0);
}

/**
 * Responde UM item — e registra quem conferiu.
 *
 * A resposta é substituível: conferir de novo e corrigir é o comportamento
 * esperado enquanto a OS está viva (o cliente volta com o carregador que
 * tinha esquecido no carro).
 */
export function responderItem(input: {
  companyId: string;
  orderId: string;
  itemId: string;
  userId: string;
  answer: string;
  note?: string | null;
}): ChecklistItem {
  ensureCoreSchema();
  if (!ANSWER_SET.has(input.answer)) {
    throw new ApiError(
      'CORE_CHECKLIST_ANSWER_INVALID',
      'Resposta inválida: use pendente, sim ou nao.',
      400,
    );
  }
  const db = getConnection();
  const item = db
    .prepare(
      `SELECT * FROM core_service_order_checklist
        WHERE id = ? AND order_id = ? AND company_id = ?`,
    )
    .get(input.itemId, input.orderId, input.companyId) as ChecklistItem | undefined;
  if (!item) throw new ApiError('CORE_CHECKLIST_ITEM_NOT_FOUND', 'Item não encontrado.', 404);

  const ordem = db
    .prepare('SELECT status FROM core_service_orders WHERE id = ? AND company_id = ?')
    .get(input.orderId, input.companyId) as { status: string } | undefined;
  if (ordem?.status === 'finalizada') {
    throw new ApiError(
      'CORE_ORDER_CLOSED',
      'OS finalizada: a conferência de entrada já não muda.',
      409,
    );
  }

  const agora = new Date().toISOString();
  db.prepare(
    `UPDATE core_service_order_checklist
        SET answer = ?, note = ?, answered_by = ?, answered_at = ?
      WHERE id = ?`,
  ).run(
    input.answer,
    input.note?.trim() || null,
    // Voltar para "pendente" é desconferir: o nome de quem conferiu sai
    // junto, senão a lista mentiria dizendo que alguém olhou.
    input.answer === 'pendente' ? null : input.userId,
    input.answer === 'pendente' ? null : agora,
    input.itemId,
  );

  return db
    .prepare('SELECT * FROM core_service_order_checklist WHERE id = ?')
    .get(input.itemId) as unknown as ChecklistItem;
}
