/**
 * DE QUAL GAVETA SAI — OU PARA QUAL ENTRA — O DINHEIRO EM ESPÉCIE
 * (GAP-PRD-134, GAP-PRD-161).
 *
 * ## As três portas que mexem em espécie, e as três réguas que elas tinham
 *
 *   venda         aceitava dinheiro sem `cashSessionId` com o caixa ABERTO: a
 *                 venda nascia sem movimento de gaveta, e o fechamento não via
 *                 aquele dinheiro. A regra "tem de ter gaveta" morava só no PDV —
 *                 a tela de consignação, por exemplo, nunca mandou o id.
 *   devolução     só lançava o movimento quando a gaveta informada estava aberta;
 *                 fora disso gravava a devolução e a despesa e SE CALAVA. O
 *                 dinheiro saía da mão do operador e o fechamento acusava falta.
 *   cancelamento  era a única com a régua certa (gaveta da venda se aberta,
 *                 senão a aberta de agora, senão recusa) — mas escolhia "a aberta
 *                 mais recente da empresa", que com um caixa por computador
 *                 (GAP-PRD-039) é a gaveta do colega.
 *
 * Esta função é a régua, uma vez só, para as três.
 *
 * ## A régua
 *
 *  1. A gaveta INFORMADA, se é desta operação e está aberta. De outra operação
 *     é 400 (nunca foi seu). Fechada: a venda recusa (o PDV guardou um turno
 *     que acabou — 400 `CORE_CASH_SESSION_CLOSED`, como sempre); a devolução e
 *     o cancelamento procuram a gaveta de AGORA, porque é dela que a nota sai
 *     fisicamente para a mão do cliente.
 *  2. Sem gaveta informada: a gaveta aberta DO CAIXA do pedido (corpo ou token
 *     de dispositivo). Caixa sem gaveta aberta é recusa — nunca a do colega.
 *  3. Sem caixa no pedido: a ÚNICA gaveta aberta da operação. Duas ou mais é
 *     recusa nomeando as gavetas — escolher uma seria sortear em qual gaveta o
 *     dinheiro cai.
 *  4. Nenhuma gaveta aberta: recusa (409 `CORE_CASH_SESSION_REQUIRED`) dizendo
 *     o valor e o que fazer — na operação que TRABALHA com gaveta.
 *
 * ## A operação que nunca abriu gaveta
 *
 * Operação sem nenhuma gaveta na história não tem fechamento algum a desmentir
 * — o defeito que a regra existe para impedir ("o fechamento não bate") não tem
 * onde acontecer. Ela segue aceitando espécie sem gaveta, e a função devolve
 * `null`. O PDV já exige abrir o caixa antes da primeira venda; a partir da
 * primeira abertura, a régua acima vale para sempre naquela operação.
 *
 * O critério é a GAVETA, e não o cadastro de caixas: caixa cadastrado sem
 * nenhuma gaveta aberta ainda não tem fechamento, e o que a regra protege é o
 * fechamento. Conferido no banco operacional (11/09/2026, só leitura): Preço
 * Justo e Gringa têm gaveta na história (a régua já vale para elas); a Oficina
 * tem uma venda e nunca abriu gaveta; as outras três não venderam nada.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { emReais } from './Money.js';
import { assertTerminalDaEmpresa } from './TerminalRegistry.js';

export type OperacaoDeGaveta = 'venda' | 'devolucao' | 'cancelamento';

export interface GavetaDoDinheiroResolvida {
  sessionId: string;
  terminalId: string | null;
  /** Como ela foi achada: a do pedido, a do caixa do pedido, ou a única aberta. */
  origem: 'informada' | 'do_caixa' | 'unica_aberta';
  /**
   * A gaveta informada estava fechada e o dinheiro foi para a de agora
   * (devolução e cancelamento) — a nota do movimento diz isso.
   */
  informadaFechada: boolean;
}

/** A operação trabalha com gaveta: já abriu alguma, em qualquer dia. */
export function operacaoTrabalhaComGaveta(companyId: string): boolean {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT EXISTS (SELECT 1 FROM core_cash_sessions WHERE company_id = ?) AS usa')
    .get(companyId) as { usa: number };
  return linha.usa === 1;
}

/** O que a recusa diz sobre o dinheiro, por operação. */
function oQueODinheiroFaz(operacao: OperacaoDeGaveta, valorCents: number): string {
  const valor = emReais(valorCents);
  if (operacao === 'venda') return `A venda recebe ${valor} em dinheiro`;
  if (operacao === 'devolucao') return `A devolução entrega ${valor} em dinheiro ao cliente`;
  return `O cancelamento devolve ${valor} em dinheiro`;
}

function oQueFazer(operacao: OperacaoDeGaveta): string {
  if (operacao === 'venda') return 'Abra o caixa antes de vender.';
  if (operacao === 'devolucao') return 'Abra o caixa, ou devolva por outra forma (PIX, cartão ou crédito de loja).';
  return 'Abra o caixa antes de cancelar.';
}

export function gavetaDoDinheiro(entrada: {
  companyId: string;
  operacao: OperacaoDeGaveta;
  /** Quanto de espécie passa pela gaveta — só para a recusa dizer o valor. */
  valorCents: number;
  /** A gaveta que o pedido informou (`cashSessionId`). */
  informada?: string | null;
  /** O caixa do pedido — corpo ou token de dispositivo, já conferido. */
  terminalId?: string | null;
  /** O que fazer com a informada fechada: a venda recusa, as outras procuram a de agora. */
  seInformadaFechada: 'recusar' | 'procurar_a_de_agora';
}): GavetaDoDinheiroResolvida | null {
  ensureCoreSchema();
  const db = getConnection();
  const terminalId =
    typeof entrada.terminalId === 'string' && entrada.terminalId !== '' ? entrada.terminalId : null;
  let informadaFechada = false;

  if (entrada.informada) {
    const sessao = db
      .prepare('SELECT id, company_id, status, terminal_id FROM core_cash_sessions WHERE id = ?')
      .get(String(entrada.informada)) as
      | { id: string; company_id: string; status: string; terminal_id: string | null }
      | undefined;
    if (!sessao || sessao.company_id !== entrada.companyId) {
      throw new ApiError('CORE_CASH_SESSION_INVALID', 'O caixa informado não é desta operação.', 400);
    }
    if (sessao.status === 'open') {
      if (terminalId && sessao.terminal_id !== terminalId) {
        throw new ApiError(
          'CORE_CASH_SESSION_OTHER_TERMINAL',
          'A gaveta informada é de outro caixa. Cada caixa opera a própria gaveta — '
            + 'abra o caixa deste computador.',
          409,
          { terminalDoPedido: terminalId, terminalDaGaveta: sessao.terminal_id },
        );
      }
      return { sessionId: sessao.id, terminalId: sessao.terminal_id, origem: 'informada', informadaFechada: false };
    }
    if (entrada.seInformadaFechada === 'recusar') {
      throw new ApiError(
        'CORE_CASH_SESSION_CLOSED',
        'O caixa informado já foi fechado — abra um caixa para vender.',
        400,
      );
    }
    informadaFechada = true;
  }

  const prefixo = informadaFechada ? 'O caixa do turno informado já foi fechado. ' : '';

  if (terminalId) {
    // Caixa de outra operação é o mesmo 400 de caixa inexistente (TerminalRegistry).
    assertTerminalDaEmpresa(entrada.companyId, terminalId);
    const doCaixa = db
      .prepare(
        `SELECT s.id, t.name AS terminal_name
           FROM core_terminals t
           LEFT JOIN core_cash_sessions s
             ON s.terminal_id = t.id AND s.company_id = t.company_id AND s.status = 'open'
          WHERE t.id = ? AND t.company_id = ?`,
      )
      .get(terminalId, entrada.companyId) as { id: string | null; terminal_name: string } | undefined;
    if (doCaixa?.id) {
      return { sessionId: doCaixa.id, terminalId, origem: 'do_caixa', informadaFechada };
    }
    if (!informadaFechada && !operacaoTrabalhaComGaveta(entrada.companyId)) return null;
    throw new ApiError(
      'CORE_CASH_SESSION_REQUIRED',
      `${prefixo}${oQueODinheiroFaz(entrada.operacao, entrada.valorCents)}, e o caixa `
        + `"${doCaixa?.terminal_name ?? terminalId}" não tem gaveta aberta. ${oQueFazer(entrada.operacao)}`,
      409,
      { terminalId, valorCents: entrada.valorCents },
    );
  }

  const abertas = db
    .prepare(
      `SELECT s.id, s.terminal_id, t.name AS terminal_name
         FROM core_cash_sessions s
         LEFT JOIN core_terminals t ON t.id = s.terminal_id
        WHERE s.company_id = ? AND s.status = 'open'
        ORDER BY s.opened_at`,
    )
    .all(entrada.companyId) as unknown as {
    id: string;
    terminal_id: string | null;
    terminal_name: string | null;
  }[];

  if (abertas.length === 1) {
    return {
      sessionId: abertas[0].id,
      terminalId: abertas[0].terminal_id,
      origem: 'unica_aberta',
      informadaFechada,
    };
  }

  if (abertas.length > 1) {
    const nomes = abertas.map((a) => (a.terminal_name ? `"${a.terminal_name}"` : 'a gaveta sem caixa'));
    throw new ApiError(
      'CORE_CASH_SESSION_REQUIRED',
      `${prefixo}${oQueODinheiroFaz(entrada.operacao, entrada.valorCents)}, e há `
        + `${abertas.length} gavetas abertas nesta operação (${nomes.join(', ')}). `
        + 'Informe de qual caixa é este computador para o dinheiro cair na gaveta certa.',
      409,
      {
        valorCents: entrada.valorCents,
        gavetasAbertas: abertas.map((a) => ({
          sessionId: a.id,
          terminalId: a.terminal_id,
          terminalName: a.terminal_name,
        })),
      },
    );
  }

  if (!informadaFechada && !operacaoTrabalhaComGaveta(entrada.companyId)) return null;

  throw new ApiError(
    'CORE_CASH_SESSION_REQUIRED',
    `${prefixo}${oQueODinheiroFaz(entrada.operacao, entrada.valorCents)}, e não há caixa aberto `
      + `agora — o fechamento do dia não veria esse dinheiro. ${oQueFazer(entrada.operacao)}`,
    409,
    { valorCents: entrada.valorCents },
  );
}
