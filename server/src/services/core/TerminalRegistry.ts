/**
 * A guarda de `core_terminals` — quem pode apontar para um caixa cadastrado.
 *
 * ## O que ela era, e o que mudou (GAP-PRD-039/146)
 *
 * A tabela não tinha escritor: três chaves estrangeiras (`core_cash_sessions`,
 * `core_sales`, `core_device_tokens`) apontavam para uma tabela vazia, e esta
 * função existia só para trocar o estouro de FK por um 400 com nome, dizendo
 * "deixe o campo vazio". O cadastro agora existe (`TerminalService`), e a
 * guarda passou a responder a pergunta que importa: o caixa é DESTA operação?
 *
 * ## Por que a empresa entra na conta
 *
 * A checagem antiga era `SELECT 1 FROM core_terminals WHERE id = ?` — sem
 * empresa. Enquanto a tabela estava vazia isso não tinha consequência; com
 * cadastro, seria a gaveta da Preço Justo aceitando o caixa da Gringa. Caixa de
 * outra operação responde o MESMO 400 de caixa inexistente: "existe, mas não é
 * seu" é informação que ninguém precisa dar.
 *
 * ## Por que "ativo" é opção, e não regra
 *
 * Abrir gaveta e registrar token pedem caixa LIGADO (409 nomeado). A venda não:
 * uma venda feita offline num caixa que o gerente desligou à tarde ainda
 * aconteceu, e recusar a regularização perderia o registro do dinheiro.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface TerminalConferido {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/**
 * Confere que `terminalId` é um caixa desta operação (e, se pedido, ligado).
 * Nulo e texto vazio passam calados: "sem terminal" é a gaveta única de hoje.
 */
export function assertTerminalDaEmpresa(
  companyId: string,
  terminalId: string | null | undefined,
  opcoes: { exigirAtivo?: boolean } = {},
): TerminalConferido | null {
  if (terminalId == null || terminalId === '') return null;
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT id, code, name, active FROM core_terminals WHERE id = ? AND company_id = ?')
    .get(String(terminalId), companyId) as
    | { id: string; code: string; name: string; active: number }
    | undefined;
  if (!linha) {
    throw new ApiError(
      'CORE_TERMINAL_NOT_REGISTERED',
      `O caixa "${terminalId}" não está cadastrado nesta operação. `
        + 'Confira em Configurações › Caixas e terminais.',
      400,
    );
  }
  if (opcoes.exigirAtivo && linha.active !== 1) {
    throw new ApiError(
      'CORE_TERMINAL_INACTIVE',
      `O caixa "${linha.name}" está desativado. Um gerente pode reativá-lo em `
        + 'Configurações › Caixas e terminais.',
      409,
      { terminalId: linha.id },
    );
  }
  return { id: linha.id, code: linha.code, name: linha.name, active: linha.active === 1 };
}

/** Quantos caixas LIGADOS a operação tem. Zero é a gaveta única de sempre. */
export function contarTerminaisAtivos(companyId: string): number {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_terminals WHERE company_id = ? AND active = 1')
    .get(companyId) as { n: number };
  return linha.n;
}

/**
 * DE QUAL CAIXA É ESTE PEDIDO — o terminal do token vence o do corpo.
 *
 * Duas fontes dizem o terminal: o corpo/consulta (o PDV que guardou "este
 * computador é o Caixa 2") e o TOKEN de dispositivo (`storeId`, gravado quando
 * o dono registrou a máquina). Quando as duas existem e discordam, a recusa é
 * nomeada em vez de uma escolher em silêncio: o computador registrado como
 * Caixa 2 pedindo a gaveta do Caixa 1 é exatamente o "vender na gaveta do
 * colega" que o cadastro veio impedir.
 */
export function terminalDoPedido(input: {
  informado: unknown;
  doDispositivo: string | null | undefined;
}): string | null {
  const informado =
    typeof input.informado === 'string' && input.informado.trim() !== ''
      ? input.informado.trim()
      : null;
  const doDispositivo = input.doDispositivo ? String(input.doDispositivo) : null;
  if (doDispositivo && informado && informado !== doDispositivo) {
    throw new ApiError(
      'CORE_TERMINAL_MISMATCH',
      'Este computador entrou como terminal registrado de outro caixa. '
        + 'Ele só opera a gaveta do próprio caixa.',
      409,
      { terminalDoDispositivo: doDispositivo, pedido: informado },
    );
  }
  return doDispositivo ?? informado;
}
