/**
 * ============================================================================
 * CAIXAS E TERMINAIS — o cadastro que `core_terminals` esperava
 * (GAP-PRD-039, GAP-PRD-146)
 * ============================================================================
 *
 * ## O defeito
 *
 * A tabela existia desde o começo, com três chaves estrangeiras apontando para
 * ela (`core_cash_sessions`, `core_sales`, `core_device_tokens`) e nenhum
 * escritor. O efeito prático era uma gaveta por empresa: o segundo operador
 * levava 409 ao abrir o próprio caixa e vendia na gaveta do primeiro — o
 * dinheiro dos dois num fechamento só, e a diferença sem dono.
 *
 * ## O que é um terminal aqui
 *
 * É o CAIXA: o ponto de venda com a sua gaveta, o seu fundo, a sua sangria e o
 * seu fechamento. Não é a maquininha (isso é `payment_terminal_*`) nem o
 * computador (o computador escolhe qual caixa é, ou é preso a um pelo token de
 * dispositivo).
 *
 * ## As regras, e por que cada uma
 *
 * - CÓDIGO GERADO: `code` é UNIQUE no banco inteiro (DDL antiga), então dois
 *   "CX1" em lojas diferentes colidiriam. O código nasce `<slug>-cx<n>` — lido
 *   por gente, único por construção — e ninguém precisa inventá-lo.
 * - NOME OBRIGATÓRIO E ÚNICO NA OPERAÇÃO (sem olhar maiúscula): dois "Caixa 1"
 *   na mesma lista seriam dois caixas que o operador não sabe distinguir.
 * - DESATIVAR, NUNCA APAGAR: vendas e turnos antigos apontam para o caixa; a
 *   linha fica, com quem desligou, quando e por quê.
 * - NÃO SE DESLIGA CAIXA COM GAVETA ABERTA: o dinheiro dela ficaria num caixa
 *   que ninguém mais consegue abrir — feche primeiro.
 * - OUTRA OPERAÇÃO NÃO EXISTE: toda busca é por (empresa, id), e o id alheio
 *   responde o mesmo 404 do inventado.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { deOutroDia } from './CashService.js';

export interface TerminalDeCaixa {
  id: string;
  code: string;
  name: string;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
  deactivationReason: string | null;
  /** A gaveta aberta deste caixa agora, se houver. */
  caixaAberto: {
    sessionId: string;
    openedAt: string;
    openedByName: string | null;
    deOutroDia: ReturnType<typeof deOutroDia>;
  } | null;
  /** Tokens de dispositivo NÃO revogados presos a este caixa. */
  tokensAtivos: number;
}

interface Linha {
  id: string;
  code: string;
  name: string;
  active: number;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  session_id: string | null;
  session_opened_at: string | null;
  session_opened_by_name: string | null;
  tokens_ativos: number;
}

const SELECT_TERMINAL = `
  SELECT t.id, t.code, t.name, t.active, t.created_at, t.created_by, t.updated_at,
         t.deactivated_at, t.deactivated_by, t.deactivation_reason,
         s.id AS session_id, s.opened_at AS session_opened_at,
         u.display_name AS session_opened_by_name,
         (SELECT COUNT(*) FROM core_device_tokens d
           WHERE d.terminal_id = t.id AND d.revoked = 0) AS tokens_ativos
    FROM core_terminals t
    LEFT JOIN core_cash_sessions s
      ON s.terminal_id = t.id AND s.company_id = t.company_id AND s.status = 'open'
    LEFT JOIN core_users u ON u.id = s.opened_by`;

function paraTerminal(l: Linha): TerminalDeCaixa {
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    active: l.active === 1,
    createdAt: l.created_at,
    createdBy: l.created_by,
    updatedAt: l.updated_at,
    deactivatedAt: l.deactivated_at,
    deactivatedBy: l.deactivated_by,
    deactivationReason: l.deactivation_reason,
    caixaAberto: l.session_id
      ? {
          sessionId: l.session_id,
          openedAt: String(l.session_opened_at),
          openedByName: l.session_opened_by_name,
          deOutroDia: deOutroDia(String(l.session_opened_at)),
        }
      : null,
    tokensAtivos: Number(l.tokens_ativos ?? 0),
  };
}

export function listTerminals(
  companyId: string,
  opcoes: { somenteAtivos?: boolean } = {},
): TerminalDeCaixa[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `${SELECT_TERMINAL}
        WHERE t.company_id = ? ${opcoes.somenteAtivos ? 'AND t.active = 1' : ''}
        ORDER BY t.active DESC, t.created_at, t.code`,
    )
    .all(companyId) as unknown as Linha[];
  return linhas.map(paraTerminal);
}

export function getTerminal(companyId: string, terminalId: string): TerminalDeCaixa {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(`${SELECT_TERMINAL} WHERE t.company_id = ? AND t.id = ?`)
    .get(companyId, terminalId) as Linha | undefined;
  if (!linha) {
    throw new ApiError('CORE_TERMINAL_NOT_FOUND', 'Caixa não encontrado nesta operação.', 404);
  }
  return paraTerminal(linha);
}

const NOME_MAX = 60;

function nomeValido(bruto: unknown): string {
  const nome = typeof bruto === 'string' ? bruto.trim().replace(/\s+/g, ' ') : '';
  if (!nome) {
    throw new ApiError(
      'CORE_TERMINAL_NAME_REQUIRED',
      'Dê um nome ao caixa — é o que o operador escolhe no PDV (ex.: "Caixa 2 — balcão").',
      400,
    );
  }
  if (nome.length > NOME_MAX) {
    throw new ApiError(
      'CORE_TERMINAL_NAME_TOO_LONG',
      `O nome do caixa passa de ${NOME_MAX} caracteres.`,
      400,
    );
  }
  return nome;
}

function exigirNomeLivre(companyId: string, nome: string, exceto: string | null): void {
  const repetido = getConnection()
    .prepare(
      `SELECT id FROM core_terminals
        WHERE company_id = ? AND lower(name) = lower(?) AND (? IS NULL OR id <> ?)`,
    )
    .get(companyId, nome, exceto, exceto) as { id: string } | undefined;
  if (repetido) {
    throw new ApiError(
      'CORE_TERMINAL_NAME_TAKEN',
      `Já existe um caixa chamado "${nome}" nesta operação.`,
      409,
      { terminalId: repetido.id },
    );
  }
}

/**
 * O próximo código livre: `<slug>-cx<n>`.
 *
 * O número é o maior já usado + 1 (desativados contam — o código de um caixa
 * aposentado não volta a nascer em outro, ou o turno antigo mudaria de dono na
 * leitura). O laço cobre a corrida teórica com a coluna UNIQUE do banco.
 */
function proximoCodigo(companyId: string): string {
  const db = getConnection();
  const empresa = db
    .prepare('SELECT slug FROM core_companies WHERE id = ?')
    .get(companyId) as { slug: string } | undefined;
  const prefixo = `${empresa?.slug ?? companyId}-cx`;
  const usados = db
    .prepare('SELECT code FROM core_terminals WHERE code LIKE ?')
    .all(`${prefixo}%`) as unknown as { code: string }[];
  let n = 0;
  for (const { code } of usados) {
    const numero = Number(code.slice(prefixo.length));
    if (Number.isInteger(numero) && numero > n) n = numero;
  }
  for (;;) {
    n += 1;
    const candidato = `${prefixo}${n}`;
    const existe = db.prepare('SELECT 1 FROM core_terminals WHERE code = ?').get(candidato);
    if (!existe) return candidato;
  }
}

export function createTerminal(input: {
  companyId: string;
  userId: string;
  name: unknown;
}): TerminalDeCaixa {
  ensureCoreSchema();
  const nome = nomeValido(input.name);
  const id = withTransaction(() => {
    exigirNomeLivre(input.companyId, nome, null);
    const novo = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_terminals
           (id, company_id, code, name, active, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(novo, input.companyId, proximoCodigo(input.companyId), nome, agora, input.userId, agora);
    return novo;
  });
  return getTerminal(input.companyId, id);
}

export function renameTerminal(input: {
  companyId: string;
  terminalId: string;
  name: unknown;
}): { antes: string; terminal: TerminalDeCaixa } {
  ensureCoreSchema();
  const nome = nomeValido(input.name);
  return withTransaction(() => {
    const atual = getTerminal(input.companyId, input.terminalId);
    exigirNomeLivre(input.companyId, nome, atual.id);
    getConnection()
      .prepare('UPDATE core_terminals SET name = ?, updated_at = ? WHERE id = ? AND company_id = ?')
      .run(nome, new Date().toISOString(), atual.id, input.companyId);
    return { antes: atual.name, terminal: getTerminal(input.companyId, atual.id) };
  });
}

export function setTerminalActive(input: {
  companyId: string;
  userId: string;
  terminalId: string;
  active: boolean;
  reason?: unknown;
}): TerminalDeCaixa {
  ensureCoreSchema();
  const motivo = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!input.active && motivo.length < 3) {
    throw new ApiError(
      'CORE_TERMINAL_REASON_REQUIRED',
      'Diga por que este caixa está sendo desativado — fica na auditoria e na ficha do caixa.',
      400,
    );
  }
  return withTransaction(() => {
    const atual = getTerminal(input.companyId, input.terminalId);
    if (atual.active === input.active) {
      throw new ApiError(
        'CORE_TERMINAL_ALREADY_IN_STATE',
        input.active ? 'Este caixa já está ativo.' : 'Este caixa já está desativado.',
        409,
      );
    }
    const agora = new Date().toISOString();
    if (!input.active) {
      if (atual.caixaAberto) {
        throw new ApiError(
          'CORE_TERMINAL_HAS_OPEN_CASH',
          `O caixa "${atual.name}" está com a gaveta aberta. Feche o turno em Vendas › Caixa `
            + 'antes de desativá-lo — o dinheiro dela ficaria num caixa que ninguém abre.',
          409,
          { sessionId: atual.caixaAberto.sessionId },
        );
      }
      getConnection()
        .prepare(
          `UPDATE core_terminals
              SET active = 0, deactivated_at = ?, deactivated_by = ?, deactivation_reason = ?,
                  updated_at = ?
            WHERE id = ? AND company_id = ?`,
        )
        .run(agora, input.userId, motivo, agora, atual.id, input.companyId);
    } else {
      // Religar limpa as colunas VIVAS da desativação; o histórico fica na
      // auditoria (`terminal.deactivate` com o motivo), que é onde se pergunta.
      getConnection()
        .prepare(
          `UPDATE core_terminals
              SET active = 1, deactivated_at = NULL, deactivated_by = NULL,
                  deactivation_reason = NULL, updated_at = ?
            WHERE id = ? AND company_id = ?`,
        )
        .run(agora, atual.id, input.companyId);
    }
    return getTerminal(input.companyId, atual.id);
  });
}
