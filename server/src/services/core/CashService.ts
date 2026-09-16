/**
 * Caixa: abertura, suprimento, sangria e fechamento com conferência.
 *
 * O valor esperado é sempre derivado dos movimentos registrados — nunca
 * informado pelo operador. A diferença entre esperado e contado é gravada
 * como fato, não corrigida silenciosamente.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { expireOverdueQuotes } from './QuoteService.js';
import {
  consumirLiberacaoDeAcao,
  consumirLiberacaoDeConcessao,
  temAlcadaParaLiberar,
} from './AuthorizationService.js';
import { diaDaLoja, hojeNaLoja } from './CalendarioOperacional.js';
import { emReais } from './Money.js';
import { politicaDaEmpresa } from './SalePolicyService.js';
import { assertTerminalDaEmpresa, contarTerminaisAtivos } from './TerminalRegistry.js';
import {
  pendenciasEletronicasDoTurno,
  ROTULO_DA_PENDENCIA,
  type PendenciasEletronicas,
} from './PendenciasDoTurno.js';

export interface CashSession {
  id: string;
  company_id: string;
  terminal_id: string | null;
  opening_cents: number;
  counted_cents: number | null;
  expected_cents: number | null;
  difference_cents: number | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  /** A trilha da reabertura — ver `reopenSession` e a DDL de `core_cash_sessions`. */
  reopened_at?: string | null;
  reopened_by?: string | null;
  reopen_reason?: string | null;
  reopen_count?: number;
  closing_trail?: string | null;
  /**
   * O fechamento que aconteceu COM dinheiro eletrônico indefinido (GAP-PRD-081):
   * JSON com o que estava pendente, o motivo e quem declarou estar ciente.
   * Nulo = fechou sem pendência nenhuma.
   */
  closed_with_pending?: string | null;
}

/**
 * Um fechamento DESFEITO, como ele fica arquivado em `closing_trail`.
 *
 * É o fato que a reabertura tira das colunas vivas: quem fechou, quando,
 * quanto era esperado, quanto foi contado e qual era a diferença — mais quem
 * reabriu e por quê. Guardar isto é o que separa "reabrir o turno" de "apagar
 * a conferência": a falta de R$ 40 que alguém já explicou continua no sistema
 * depois que a gaveta volta a aceitar movimento.
 */
export interface FechamentoArquivado {
  closed_by: string | null;
  closed_at: string | null;
  counted_cents: number | null;
  expected_cents: number | null;
  difference_cents: number | null;
  reopened_at: string;
  reopened_by: string;
  reopen_reason: string | null;
  /** As pendências eletrônicas declaradas naquele fechamento (GAP-PRD-081). */
  closed_with_pending?: string | null;
}

/**
 * A RÉGUA ÚNICA DO DINHEIRO DA GAVETA: centavos INTEIROS, nunca um número que
 * não existe, nunca negativo.
 *
 * As rotas fazem `Number(req.body...)` cru, e `Number('2z5')` é NaN. NaN
 * atravessa qualquer guarda de sinal — `NaN <= 0` e `NaN < 0` são os dois
 * false — e o desfecho dependia da coluna onde caía: NOT NULL (abertura,
 * movimento) estourava em 500 cru API_UNAVAILABLE; a NULLABLE do fechamento
 * era pior, porque nem estourava: node:sqlite binda NaN como NULL, e o turno
 * fechava "conferido" com counted NULL e difference NULL — sem conferência
 * nenhuma, sem erro nenhum. Fracionário (50,5 centavos) quebrava por outro
 * caminho: a coluna INTEGER é só afinidade e aceita REAL, o esperado virava
 * fracionário e nenhuma contagem inteira fechava em zero nunca mais — contra
 * a regra da casa de dinheiro em centavos inteiros.
 *
 * A checagem mora AQUI, no funil do serviço, e não nas rotas: todo chamador
 * passa por ela — o de hoje e o que ainda não foi escrito. O sinal de "maior
 * que zero" do movimento continua sendo checado no próprio `addMovement`,
 * porque abertura e contagem aceitam zero e ele não.
 */
function exigirCentavosInteiros(valor: number, oQue: string): void {
  if (!Number.isInteger(valor) || valor < 0) {
    throw new ApiError(
      'CORE_INVALID_AMOUNT',
      `${oQue} precisa ser um número inteiro de centavos, maior ou igual a zero.`,
      400,
    );
  }
}

/**
 * O TETO DO DINHEIRO QUE ENTRA NA GAVETA DE UMA VEZ — R$ 100.000,00.
 *
 * O DEFEITO (H-caixa-seguranca-14): o teto existia só na tela do PDV
 * (`CaixaPdvDialog`) e só na abertura. O servidor aceitava qualquer inteiro:
 * um código de barras bipado no campo "Valor" e um clique em Suprimento
 * lançavam R$ 78.945.612.300,12 na gaveta, e a abertura pela tela de Caixa da
 * gestão (que não tem o teto) também passava. O fechamento do dia inteiro
 * saía errado até alguém lançar o contrário.
 *
 * O teto mora AQUI, no funil, para valer para toda tela — a de hoje e a que
 * ainda não foi escrita. Vale para o que ENTRA (abertura, suprimento, ajuste):
 * a sangria já tem o próprio limite, que é o saldo da gaveta. É folgado de
 * propósito: nenhuma gaveta de balcão recebe cem mil reais de uma vez, e um
 * número redondo é o que o operador entende quando a recusa aparece.
 */
export const TETO_DE_DINHEIRO_NA_GAVETA_CENTS = 100_000_00;

function exigirDentroDoTetoDaGaveta(valor: number, oQue: string): void {
  if (valor > TETO_DE_DINHEIRO_NA_GAVETA_CENTS) {
    throw new ApiError(
      'CORE_CASH_AMOUNT_TOO_HIGH',
      `${oQue} de ${emReais(valor)} passa do teto de ${emReais(TETO_DE_DINHEIRO_NA_GAVETA_CENTS)} por lançamento. `
        + 'Confira o valor — um código de barras bipado no campo vira dinheiro na gaveta.',
      400,
      { valorCents: valor, tetoCents: TETO_DE_DINHEIRO_NA_GAVETA_CENTS },
    );
  }
}

/**
 * Os tipos de referência do movimento MANUAL da gaveta.
 *
 * `manual` é o que saiu sem gestor nenhum; `manual_com_gestor` é a sangria que
 * passou com alçada — a de quem tem alçada própria, ou a do operador que
 * trouxe a liberação de um gestor. A separação é o que deixa o teto da sangria
 * valer para o TURNO, e não para cada movimento (ver `addMovement`).
 */
const REFERENCIA_SEM_GESTOR = 'manual';
const REFERENCIA_COM_GESTOR = 'manual_com_gestor';

export function openSession(input: {
  companyId: string;
  userId: string;
  terminalId?: string | null;
  openingCents: number;
  note?: string;
}): CashSession {
  ensureCoreSchema();
  exigirCentavosInteiros(input.openingCents, 'Valor de abertura');
  exigirDentroDoTetoDaGaveta(input.openingCents, 'Fundo de troco');

  /*
    A GAVETA É DO CAIXA (GAP-PRD-039).

    O terminal precisa ser DESTA operação e estar ligado — a recusa nomeada mora
    em TerminalRegistry. E a operação que cadastrou caixas passa a abrir gaveta
    SÓ por caixa: sem esta recusa, o segundo operador que esquecesse de escolher
    o caixa do computador cairia na gaveta "sem terminal" — a mesma mistura de
    dinheiro que o cadastro veio acabar. Operação sem caixa cadastrado segue com
    a gaveta única de sempre, sem mudar um clique.
  */
  const terminal = assertTerminalDaEmpresa(input.companyId, input.terminalId, { exigirAtivo: true });
  if (!terminal && contarTerminaisAtivos(input.companyId) > 0) {
    throw new ApiError(
      'CORE_TERMINAL_REQUIRED',
      'Esta operação tem caixas cadastrados: escolha em qual caixa esta gaveta abre.',
      400,
    );
  }

  /*
    ================================================================
    A EXPIRAÇÃO DE PRÉ-VENDAS RODA AQUI, E FALHAR NELA NÃO PODE
    IMPEDIR A LOJA DE ABRIR. LEIA ANTES DE MEXER.
    ================================================================

    POR QUE NA ABERTURA DE CAIXA. Este servidor roda dentro da loja e é
    desligado à noite; não há agendador. A varredura que solta o estoque
    segurado por pré-venda vencida precisa de um evento que aconteça todo dia e
    ANTES da primeira venda — e abrir o caixa é o único que tem as duas
    propriedades. Sem ela, a peça reservada por um cliente que nunca voltou fica
    fora do disponível indefinidamente.

    POR QUE ENGOLIDA, e por que isso não é preguiça. Isto é uma faxina, não uma
    pré-condição da abertura. Se `expireOverdueQuotes` lançar — um item de
    documento apontando para produto apagado, uma reserva já solta à mão, o que
    for —, deixar a exceção subir significa que NINGUÉM ABRE O CAIXA E A LOJA
    NÃO VENDE. A loja parada custa o dia inteiro; a reserva presa custa uma
    peça, e continua consertável. Entre os dois, a escolha é óbvia, e é preciso
    que esteja escrita: a próxima pessoa que ler este catch vai querer "tratar
    o erro direito" e propagá-lo.

    POR QUE FORA DA TRANSAÇÃO DA ABERTURA. Roda antes, com transação própria.
    Se estivesse dentro, um erro dela — mesmo capturado — teria desfeito
    trabalho junto com o da abertura no mesmo escopo, e a faxina passaria a
    poder derrubar o caixa por um caminho indireto. Separada, o pior caso é
    ela não ter feito nada.

    O ERRO NÃO SOME: vai para o log com o `companyId`. Falha silenciosa de
    verdade é a que não deixa rastro nenhum.
  */
  try {
    expireOverdueQuotes(input.companyId);
  } catch (err) {
    console.warn(
      `[caixa] expiração de pré-vendas falhou na abertura da empresa ${input.companyId}, `
        + `e o caixa foi aberto assim mesmo: ${(err as Error).message}`,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const open = db
      .prepare(
        `SELECT s.id, s.opened_at, u.display_name AS opened_by_name
           FROM core_cash_sessions s
           LEFT JOIN core_users u ON u.id = s.opened_by
          WHERE s.company_id = ? AND s.status = 'open' AND s.terminal_id IS ?`,
      )
      .get(input.companyId, terminal?.id ?? null) as
      | { id: string; opened_at: string; opened_by_name: string | null }
      | undefined;
    if (open) {
      // A DATA NA RECUSA (GAP-PRD-131): "já existe um caixa aberto" sem dizer
      // desde quando escondia justamente a gaveta de agosto esquecida aberta.
      throw new ApiError(
        'CORE_CASH_ALREADY_OPEN',
        `Já existe um caixa aberto neste terminal, aberto desde ${dataBr(diaDaLoja(open.opened_at))}`
          + (open.opened_by_name ? ` por ${open.opened_by_name}` : '')
          + '. Feche-o em Vendas › Caixa antes de abrir outro.',
        409,
        { sessionId: open.id, openedAt: open.opened_at },
      );
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_cash_sessions
         (id, company_id, terminal_id, opened_by, opening_cents, status, opened_at, note)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      id,
      input.companyId,
      terminal?.id ?? null,
      input.userId,
      input.openingCents,
      now,
      input.note ?? null,
    );

    // A abertura entra como movimento para que o esperado seja sempre a soma
    // dos movimentos, sem tratar o fundo de troco como caso especial.
    if (input.openingCents > 0) {
      db.prepare(
        `INSERT INTO core_cash_movements
           (id, session_id, company_id, movement_type, amount_cents, payment_method,
            reference_type, reference_id, user_id, note, created_at)
         VALUES (?, ?, ?, 'opening', ?, 'dinheiro', 'cash_session', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        id,
        input.companyId,
        input.openingCents,
        id,
        input.userId,
        'Abertura de caixa',
        now,
      );
    }
    return getSession(input.companyId, id)!;
  });
}

export function getSession(companyId: string, sessionId: string): CashSession | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_cash_sessions WHERE id = ? AND company_id = ?')
    .get(sessionId, companyId) as CashSession | undefined;
  return row ?? null;
}

export function getOpenSession(companyId: string, terminalId?: string | null): CashSession | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      "SELECT * FROM core_cash_sessions WHERE company_id = ? AND status = 'open' AND terminal_id IS ?",
    )
    .get(companyId, terminalId ?? null) as CashSession | undefined;
  return row ?? null;
}

/** Saldo esperado em gaveta: soma de todos os movimentos da sessão. */
export function expectedCents(sessionId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM core_cash_movements WHERE session_id = ?',
    )
    .get(sessionId) as { total: number };
  return row.total;
}

export type CashMovementType = 'supply' | 'withdrawal' | 'adjustment';

/**
 * OS TRÊS TIPOS, EM EXECUÇÃO — e não só no compilador.
 *
 * A rota repassa `req.body?.movementType` cru, e o sinal era decidido por
 * `=== 'withdrawal' ? -abs : +abs`. Um tipo TypeScript não existe em tempo de
 * execução: qualquer outro texto — 'sale', 'ajuste', 'x' — caía no ramo
 * POSITIVO e virava dinheiro ENTRANDO na gaveta, com um tipo que nenhum
 * relatório sabe ler e que ninguém consegue explicar no fechamento.
 */
const TIPOS_DE_MOVIMENTO: readonly CashMovementType[] = ['supply', 'withdrawal', 'adjustment'];

export function addMovement(input: {
  companyId: string;
  sessionId: string;
  userId: string;
  movementType: CashMovementType;
  amountCents: number;
  note?: string;
  /**
   * Quem está pedindo, e a liberação que ele traz — para a sangria com teto.
   *
   * Opcional porque suprimento e ajuste não têm teto: dinheiro ENTRANDO na
   * gaveta não é risco, e ajuste é a correção que já nasce com motivo. Só a
   * retirada precisa saber quem está retirando.
   */
  alcada?: { profileCodes: string[]; authorizationId?: string | null };
  /**
   * A chave de idempotência do pedido (cabeçalho `Idempotency-Key`).
   *
   * O DEFEITO (H-caixa-seguranca-09): o movimento não tinha idempotência
   * nenhuma — `reference_id` era um uuid novo a cada chamada, então o UNIQUE
   * da tabela nunca pegava um reenvio. No Wi-Fi da loja o POST da sangria de
   * R$ 500 chegava e era gravado, a resposta se perdia, a tela mostrava erro
   * com o valor ainda no campo, e o segundo clique deixava o turno com −R$ 1.000.
   * Com a chave, o reenvio do MESMO pedido devolve o saldo sem gravar de novo.
   */
  chave?: string | null;
}): { balance: number; repetido?: boolean } {
  ensureCoreSchema();
  // A régua dos centavos inteiros primeiro (NaN e fração param aqui), e só
  // depois o sinal — movimento de zero centavo não move nada.
  exigirCentavosInteiros(input.amountCents, 'Valor do movimento');
  if (input.amountCents <= 0) {
    throw new ApiError('CORE_INVALID_AMOUNT', 'Valor deve ser maior que zero.', 400);
  }
  if (!TIPOS_DE_MOVIMENTO.includes(input.movementType)) {
    throw new ApiError(
      'CORE_INVALID_MOVEMENT_TYPE',
      `Tipo de movimento inválido: ${String(input.movementType)}. ` +
        `A gaveta aceita ${TIPOS_DE_MOVIMENTO.join(', ')}.`,
      400,
    );
  }
  // O que ENTRA na gaveta tem teto por lançamento (H-caixa-seguranca-14). A
  // sangria não precisa: o limite dela é o saldo, conferido mais abaixo.
  if (input.movementType !== 'withdrawal') {
    exigirDentroDoTetoDaGaveta(input.amountCents, input.movementType === 'supply' ? 'Suprimento' : 'Ajuste');
  }

  /*
    A SANGRIA DIZ PARA ONDE O DINHEIRO FOI (H-caixa-seguranca-08).

    O DEFEITO: o movimento gravava `note ?? null` sem exigir texto, e a tela
    rotulava o campo como "Observação", opcional. No fechamento e na auditoria
    só aparecia "Sangria −R$ 180", sem destino — depósito no banco, pagamento
    de fornecedor, troco para o outro caixa —, e o gestor não tinha contra o
    que conferir o comprovante. A regra da casa para o estoque ("o que
    desaparece precisa de motivo") não valia para o dinheiro. Suprimento e
    ajuste seguem com a observação opcional: o suprimento é dinheiro entrando,
    e o ajuste é a correção que já nasce explicada.
  */
  const motivo = String(input.note ?? '').trim();
  if (input.movementType === 'withdrawal' && motivo.length < 3) {
    throw new ApiError(
      'CORE_CASH_REASON_REQUIRED',
      'Diga o motivo da sangria (ex.: "depósito no banco", "pagamento do fornecedor"): '
        + 'é o que o gestor confere contra o comprovante no fechamento.',
      400,
    );
  }

  const chave = typeof input.chave === 'string' && input.chave.trim() !== '' ? input.chave.trim() : null;
  if (chave !== null && chave.length > 200) {
    throw new ApiError(
      'CORE_IDEMPOTENCY_KEY_INVALID',
      'A chave de idempotência do movimento passa de 200 caracteres. Gere uma chave nova e repita.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const session = getSession(input.companyId, input.sessionId);
    if (!session) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);

    // Vem sinalizado desde já: é com ele que o reenvio é comparado.
    const signed =
      input.movementType === 'withdrawal' ? -Math.abs(input.amountCents) : Math.abs(input.amountCents);

    /*
      O REENVIO É CONFERIDO ANTES DE TUDO — antes do "caixa já fechado" e antes
      de a liberação do gestor ser gasta. Se o primeiro envio já gravou, a
      resposta certa é a mesma de antes (e não um 409 de gaveta fechada, nem
      uma liberação "já usada" pelo próprio pedido). Mesma chave com OUTRO
      conteúdo é um pedido novo com chave velha: recusa, nada gravado — o mesmo
      idioma de `CORE_IDEMPOTENCY_KEY_REUSED` da venda.
    */
    if (chave !== null) {
      const anterior = db
        .prepare(
          `SELECT session_id, movement_type, amount_cents FROM core_cash_movements
            WHERE company_id = ? AND reference_type IN (?, ?) AND reference_id = ?
            LIMIT 1`,
        )
        .get(input.companyId, REFERENCIA_SEM_GESTOR, REFERENCIA_COM_GESTOR, chave) as
        | { session_id: string; movement_type: string; amount_cents: number }
        | undefined;
      if (anterior) {
        if (
          anterior.session_id === input.sessionId
          && anterior.movement_type === input.movementType
          && anterior.amount_cents === signed
        ) {
          return { balance: expectedCents(input.sessionId), repetido: true };
        }
        throw new ApiError(
          'CORE_IDEMPOTENCY_KEY_REUSED',
          'Esta chave de idempotência já registrou outro movimento de gaveta — nada foi registrado agora. '
            + 'Um movimento novo precisa de chave nova.',
          422,
          { sessionId: anterior.session_id, movementType: anterior.movement_type },
        );
      }
    }

    if (session.status !== 'open') {
      throw new ApiError('CORE_CASH_CLOSED', 'Caixa já fechado.', 409);
    }

    // Sangria e retirada saem da gaveta; suprimento entra (o sinal está em `signed`).
    if (input.movementType === 'withdrawal' && expectedCents(input.sessionId) + signed < 0) {
      throw new ApiError('CORE_CASH_INSUFFICIENT', 'Saldo em caixa insuficiente para a sangria.', 409);
    }

    /*
      O TETO DA SANGRIA, e a única trava que a gaveta passa a ter.

      Antes disto as recusas eram duas: valor menor ou igual a zero, e saldo
      insuficiente. Quer dizer que qualquer operador com caixa aberto retirava
      até zerar, e a única testemunha era o movimento que ele mesmo lançou.
      `sangria_especial` estava declarada em `RESTRICTED_ACTIONS` desde o começo
      e não era exigida em lugar nenhum: a lista dizia que havia uma tranca ali.

      ## Quem já tem alçada NÃO pede liberação para si

      Esta linha é o que separa uma trava de uma armadilha, e o precedente é a
      razão de ela existir: `cancelar_venda` foi RETIRADA da lista de ações
      restritas justamente porque a rota já exige gerente e ninguém autoriza a
      própria ação — o gerente teria de chamar um segundo gerente.

      Na sangria o desfecho seria pior. Em loja pequena o gerente É quem fica no
      caixa, e a sangria existe para tirar dinheiro da gaveta por SEGURANÇA:
      recusá-la a ele deixaria o dinheiro exposto exatamente no momento em que
      alguém decidiu protegê-lo. Uma trava cujo efeito prático é manter o
      dinheiro na gaveta trabalha contra o próprio motivo de existir.

      O teto continua valendo para ele em outro sentido, que é o que importa: o
      movimento fica gravado com o nome dele, e a conferência do fechamento
      compara o esperado com o contado do mesmo jeito.
    */
    /*
      O TETO VALE PARA O TURNO, E NÃO PARA CADA MOVIMENTO (H-caixa-seguranca-04).

      O DEFEITO: a conta comparava só `Math.abs(amountCents) > teto` — o valor
      DESTE movimento. Com teto de R$ 200, cinco sangrias de R$ 200 em
      sequência passavam todas sem liberação (200 não é maior que 200) e saíam
      R$ 1.000 da gaveta sem gestor nenhum. Fracionar contornava a trava.

      Agora o que se compara com o teto é o ACUMULADO do turno: as sangrias
      desta gaveta que saíram SEM gestor (`reference_type = 'manual'`) mais a
      que está sendo pedida. A sangria que passou com gestor — alçada própria
      ou liberação — fica marcada `manual_com_gestor` e não entra na soma: um
      gestor já olhou para ela, e a liberação cobre o valor daquele movimento.
    */
    let comGestor = false;
    if (input.movementType === 'withdrawal') {
      const teto = politicaDaEmpresa(input.companyId).cashWithdrawalLimitCents;
      const perfis = input.alcada?.profileCodes ?? [];
      const temAlcada = temAlcadaParaLiberar(perfis);
      comGestor = temAlcada;
      const jaSangradoSemGestor =
        teto === null || temAlcada
          ? 0
          : (
              db
                .prepare(
                  `SELECT COALESCE(SUM(-amount_cents), 0) AS total FROM core_cash_movements
                    WHERE session_id = ? AND movement_type = 'withdrawal' AND reference_type = ?`,
                )
                .get(input.sessionId, REFERENCIA_SEM_GESTOR) as { total: number }
            ).total;
      const precisaLiberacao =
        teto !== null && !temAlcada && jaSangradoSemGestor + Math.abs(input.amountCents) > teto;

      if (precisaLiberacao) {
        const liberacao = input.alcada?.authorizationId
          ? consumirLiberacaoDeConcessao({
              companyId: input.companyId,
              authorizationId: input.alcada.authorizationId,
              requestedBy: input.userId,
              action: 'sangria_especial',
              concedidoCents: Math.abs(input.amountCents),
              // Sem bruto: o teto da gaveta é absoluto, não uma fatia de nada.
              // A comparação de percentual lá dentro se cala quando este é zero.
              brutoCents: 0,
              refType: 'cash_movement',
              refId: input.sessionId,
              now: new Date().toISOString(),
            })
          : null;

        if (!liberacao) {
          // Com sangria anterior no turno, a frase diz a soma — senão o
          // operador lê "R$ 100 passa do teto de R$ 200" e não entende.
          throw new ApiError(
            'CORE_WITHDRAWAL_NEEDS_AUTHORIZATION',
            `Sangria de ${emReais(Math.abs(input.amountCents))}`
              + (jaSangradoSemGestor > 0
                ? `, somada a ${emReais(jaSangradoSemGestor)} já sangrados sem gestor neste turno,`
                : '')
              + ` passa do teto de ${emReais(teto)} desta operação. Peça a liberação de um gestor `
              + 'ou retire um valor menor.',
            403,
            {
              tetoCents: teto,
              pedidoCents: Math.abs(input.amountCents),
              jaSangradoSemGestorCents: jaSangradoSemGestor,
            },
          );
        }
        comGestor = true;
      }
    }

    db.prepare(
      `INSERT INTO core_cash_movements
         (id, session_id, company_id, movement_type, amount_cents, payment_method,
          reference_type, reference_id, user_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, 'dinheiro', ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.sessionId,
      input.companyId,
      input.movementType,
      signed,
      comGestor ? REFERENCIA_COM_GESTOR : REFERENCIA_SEM_GESTOR,
      // A chave do pedido vira a identidade do movimento: é o que o reenvio
      // encontra. Sem chave, um uuid — o comportamento de antes.
      chave ?? randomUUID(),
      input.userId,
      input.movementType === 'withdrawal' ? motivo : (input.note ?? null),
      new Date().toISOString(),
    );

    return { balance: expectedCents(input.sessionId) };
  });
}

/** A recusa do fechamento, dita com cada pendência pelo nome e pelo valor. */
export function fraseDasPendencias(p: PendenciasEletronicas): string {
  const partes: string[] = [
    ...p.cobrancas.map((c) => `${ROTULO_DA_PENDENCIA[c.tipo]} de ${emReais(c.amountInCents)}`),
    ...p.pagamentosPendentes.map(
      (pg) => `${pg.method.toUpperCase()} pendente de ${emReais(pg.amountCents)} na venda #${pg.saleNumber ?? '?'}`,
    ),
    // GAP-PRD-045: dinheiro NA gaveta de venda que o servidor recusou.
    ...(p.vendasOffline ?? []).map(
      (v) => `venda guardada sem servidor e recusada, de ${emReais(v.receivedCents)} (relance ou descarte em Vendas guardadas)`,
    ),
    /*
      A devolução em duas etapas que ainda não pagou o cliente (auditoria do
      PDV): dinheiro que a loja DEVE, e que continua na gaveta enquanto o
      reembolso for em espécie. Ver `devolucoesAguardandoReembolsoDoTurno`.
    */
    ...(p.devolucoesAguardandoReembolso ?? []).map(
      (d) =>
        `devolução #${d.number} da venda #${d.saleNumber ?? '?'} com ${emReais(d.pendenteCents)} `
        + 'ainda não devolvidos ao cliente (registre o reembolso em Vendas › Devoluções)',
    ),
  ];
  return (
    `Este turno tem ${p.quantidade} pendência(s), somando ${emReais(p.totalCents)}: `
    + `${partes.join('; ')}. Resolva em Vendas › Conferência de maquininha ou em Vendas › Devoluções, `
    + 'ou feche declarando que está ciente, com o motivo — a pendência continua na fila do gestor.'
  );
}

export function closeSession(input: {
  companyId: string;
  sessionId: string;
  userId: string;
  countedCents: number;
  note?: string;
  /** Declara estar ciente das pendências eletrônicas do turno (GAP-PRD-081). */
  pendenciasCiente?: boolean;
  /** Por que fechar com elas — obrigatório quando há pendência. */
  pendenciasMotivo?: string | null;
}): CashSession {
  ensureCoreSchema();
  /*
    A CONTAGEM AUSENTE TEM NOME NO FUNIL, NÃO SÓ NA ROTA (H-caixa-seguranca-01, as duas telas).

    O DEFEITO: `CORE_CASH_COUNT_REQUIRED` existia só em `POST /cash/:id/close`.
    Quem chamasse este serviço por outro caminho sem a contagem — uma rota nova,
    um fechamento em lote, uma tela que montasse o corpo errado — caía na régua
    genérica e lia "precisa ser um número inteiro de centavos", sem dizer que o
    que faltou foi CONTAR a gaveta. A regra "não se fecha turno sem contagem"
    passa a valer aqui, com a mesma mensagem da rota, para toda tela.
  */
  /*
    ...E "NÃO INFORMADA" É CONFERIDO NO VALOR CRU (H-caixa-seguranca-R01).

    O DEFEITO: a guarda comparava com `''` depois de a rota já ter convertido
    o corpo com `Number()` — `' '`, `false` e `[]` chegavam aqui como 0 e
    fechavam o turno com a gaveta inteira em falta. A rota agora não converte
    o que não é número; e aqui, para o chamador que ainda não existe, o que não
    é número nem texto com conteúdo (texto só de espaços, booleano, lista,
    objeto) é contagem que não veio. Texto com conteúdo que não é inteiro
    segue para a régua dos centavos logo abaixo.
  */
  const contagem: unknown = input.countedCents;
  const informada =
    typeof contagem === 'number' || (typeof contagem === 'string' && contagem.trim() !== '');
  if (!informada) {
    throw new ApiError(
      'CORE_CASH_COUNT_REQUIRED',
      'Informe quanto foi contado na gaveta para fechar o turno (0 se ela foi esvaziada).',
      400,
    );
  }
  // Uma contagem ilegível ou negativa NÃO fecha a gaveta às cegas: sem esta
  // linha, NaN virava NULL nas colunas NULLABLE `counted_cents` e
  // `difference_cents` e o turno fechava "conferido" sem contagem nenhuma.
  // Contar zero é legítimo (gaveta esvaziada); contar −R$ 1,00 não existe.
  exigirCentavosInteiros(input.countedCents, 'Contagem do fechamento');
  return withTransaction(() => {
    const db = getConnection();
    const session = getSession(input.companyId, input.sessionId);
    if (!session) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);
    if (session.status !== 'open') {
      throw new ApiError('CORE_CASH_CLOSED', 'Caixa já fechado.', 409);
    }

    const now = new Date().toISOString();

    /*
      DINHEIRO ELETRÔNICO INDEFINIDO NÃO FECHA EM SILÊNCIO (GAP-PRD-081).

      O turno fechava "conferido" com cobrança da maquininha sem resposta,
      cobrança ainda no aparelho, cobrança aprovada que venda nenhuma usou ou
      PIX pendente numa venda desta gaveta — e o gestor descobria no dia
      seguinte. Nada disso está NA gaveta (cartão e PIX caem na conta), por
      isso a trava não é "não fecha nunca": o operador não resolve uma
      cobrança sem resposta (quem concilia é o gestor) e não pode ficar preso
      no balcão por ela. É "não fecha SEM DIZER": a primeira tentativa volta
      409 com cada pendência pelo nome; fechar exige declarar que está ciente,
      com o motivo — e o que ficou pendente é gravado no turno e na auditoria,
      e continua na fila do gestor.
    */
    const pendencias = pendenciasEletronicasDoTurno(input.companyId, session);
    let registroDasPendencias: string | null = null;
    if (pendencias.quantidade > 0) {
      if (!input.pendenciasCiente) {
        throw new ApiError('CORE_CASH_CLOSE_ELECTRONIC_PENDING', fraseDasPendencias(pendencias), 409, {
          pendencias,
        });
      }
      const motivo = String(input.pendenciasMotivo ?? '').trim();
      if (motivo.length < 3) {
        throw new ApiError(
          'CORE_CASH_CLOSE_PENDING_REASON_REQUIRED',
          'Para fechar o turno com pendência eletrônica, diga por quê (ex.: "o gerente confere o extrato '
            + 'amanhã cedo").',
          400,
          { pendencias },
        );
      }
      /*
        O QUE FICA GRAVADO PRECISA NOMEAR A DÍVIDA (P00-caixa-divida).

        O DEFEITO MEDIDO: este registro guardava só `cobrancas` e
        `pagamentosPendentes`. A venda guardada recusada e a devolução sem
        reembolso entravam apenas no `totalCents`, e o turno ficava com
        {"totalCents":5000,"cobrancas":[],"pagamentosPendentes":[]} — "fechei
        devendo R$ 50,00" sem dizer a quem, de que venda nem de que devolução.
        Como este campo é o ÚNICO traço durável do que foi declarado (é dele
        que vivem o papel do fechamento e a auditoria), "trava até ser DITA"
        virava "trava até ser dita a ninguém".

        As quatro listas vão inteiras, com o mesmo nome que têm em
        `PendenciasEletronicas`: quem ler o turno meses depois lê o mesmo
        vocabulário da tela que recusou o fechamento.
      */
      registroDasPendencias = JSON.stringify({
        motivo,
        cientePor: input.userId,
        cienteEm: now,
        totalCents: pendencias.totalCents,
        quantidade: pendencias.quantidade,
        cobrancas: pendencias.cobrancas,
        pagamentosPendentes: pendencias.pagamentosPendentes,
        vendasOffline: pendencias.vendasOffline,
        devolucoesAguardandoReembolso: pendencias.devolucoesAguardandoReembolso,
      });
    }

    const expected = expectedCents(input.sessionId);
    const difference = input.countedCents - expected;

    db.prepare(
      `UPDATE core_cash_sessions
          SET status = 'closed', closed_by = ?, closed_at = ?,
              counted_cents = ?, expected_cents = ?, difference_cents = ?,
              note = COALESCE(?, note), closed_with_pending = ?
        WHERE id = ?`,
    ).run(
      input.userId,
      now,
      input.countedCents,
      expected,
      difference,
      input.note ?? null,
      registroDasPendencias,
      input.sessionId,
    );

    return getSession(input.companyId, input.sessionId)!;
  });
}

/**
 * ============================================================================
 * REABRIR O TURNO — a porta que a lista de ações restritas prometia e não tinha
 * ============================================================================
 *
 * ## Por que ela não existia, e o que mudou
 *
 * `reabrir_caixa` esteve declarada em `RESTRICTED_ACTIONS` desde o começo e foi
 * RETIRADA de lá com um motivo que não era permissão: era desenho. `closeSession`
 * grava esperado, contado e diferença como FATO, e reabrir obrigava a decidir o
 * destino daquela conferência. Enquanto a decisão não fosse tomada, uma tranca
 * sobre a reabertura só faria acreditar que o recurso existia atrás de uma senha.
 *
 * A decisão está aqui, e é a terceira saída — nem manter, nem apagar: ARQUIVAR.
 * O fechamento desfeito é empilhado em `closing_trail` e as colunas vivas voltam
 * a nulo. Manter a contagem na linha faria a gaveta ABERTA exibir o contado de um
 * fechamento que não vale mais (estado que mente, e é justamente o que o
 * fechamento de NaN produzia antes da régua dos centavos); apagar sumiria com a
 * falta de R$ 40 que alguém já explicou. O fechamento seguinte recalcula o
 * esperado a partir dos MOVIMENTOS — inclusive os que entrarem depois da
 * reabertura —, que é a mesma regra de sempre e não precisou de exceção nenhuma.
 *
 * ## As três recusas, e por que cada uma é o que é
 *
 * SÓ A ÚLTIMA FECHADA (409). Reabrir um turno do meio do histórico é reescrever
 * o passado com o presente: os movimentos novos entrariam num turno que já foi
 * conferido, fechado e comparado com o dia seguinte. A última é a única que
 * ainda "encosta" no agora.
 *
 * SÓ NO MESMO DIA DA LOJA (409). O dia é o do calendário da operação
 * (`diaDaLoja`), e não 24 horas corridas: o que autoriza reabrir é a gaveta
 * ainda estar ali, com o mesmo dinheiro e as mesmas pessoas. Amanhã de manhã o
 * fato do dia anterior já virou fechamento do mês, e desfazê-lo é assunto de
 * lançamento contábil, não de botão.
 *
 * OUTRA EMPRESA NÃO EXISTE (404). `getSession` já é escopado pela empresa, e a
 * resposta é a mesma que para um id inventado — de propósito: "existe, mas não é
 * sua" é informação que ninguém precisa dar.
 *
 * ## Quem reabre
 *
 * Quem tem alçada reabre DIRETO. Quem não tem traz a liberação pontual de um
 * gestor — o mesmo bilhete de uma viagem só do desconto e da sangria, preso a
 * ESTE turno (`reference_id`) e gasto aqui dentro. Não há um segundo mecanismo:
 * generalizar o que já existia era a única saída honesta.
 */
export function reopenSession(input: {
  companyId: string;
  sessionId: string;
  userId: string;
  reason?: string | null;
  /** Quem está pedindo, e o bilhete que ele traz. Perfis vêm do TOKEN. */
  alcada?: { profileCodes: string[]; authorizationId?: string | null };
  /** O relógio, injetável para o teste do dia seguinte não depender do calendário. */
  agora?: Date;
}): { session: CashSession; authorizationId: string | null; authorizedBy: string | null } {
  ensureCoreSchema();
  const agora = input.agora ?? new Date();
  const now = agora.toISOString();

  return withTransaction(() => {
    const db = getConnection();
    const session = getSession(input.companyId, input.sessionId);
    if (!session) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);

    if (session.status !== 'closed') {
      throw new ApiError(
        'CORE_CASH_ALREADY_OPEN',
        'Este turno não está fechado — não há o que reabrir.',
        409,
        { status: session.status },
      );
    }

    /*
      A ÚLTIMA FECHADA é a de maior `closed_at`, com `opened_at` desempatando.

      O desempate não é enfeite: dois turnos de terminais diferentes fechados no
      mesmo segundo (a loja fecha às 18h e os dois caixas clicam junto) dariam
      uma ordem instável, e "a última" mudaria de identidade entre uma consulta e
      a seguinte. Com o desempate, a resposta é sempre a mesma.
    */
    /*
      ...DESTE CAIXA (GAP-PRD-039). Com uma gaveta por caixa, "a última da loja"
      deixou de ser a pergunta: o Caixa 2 fechando um minuto depois do Caixa 1
      tornaria o turno do Caixa 1 irreabrível sem que nada do Caixa 1 tivesse
      mudado. Na gaveta única (terminal nulo) a resposta é a mesma de antes.
    */
    const ultimaFechada = db
      .prepare(
        `SELECT id FROM core_cash_sessions
          WHERE company_id = ? AND status = 'closed' AND terminal_id IS ?
          ORDER BY closed_at DESC, opened_at DESC, id DESC
          LIMIT 1`,
      )
      .get(input.companyId, session.terminal_id ?? null) as { id: string } | undefined;

    if (!ultimaFechada || ultimaFechada.id !== session.id) {
      throw new ApiError(
        'CORE_CASH_NOT_LAST_SESSION',
        'Só o último turno fechado deste caixa pode ser reaberto. '
          + 'Reabrir um turno anterior misturaria movimento de hoje com uma conferência '
          + 'que já foi fechada e comparada.',
        409,
        { pedido: session.id, ultimaFechada: ultimaFechada?.id ?? null },
      );
    }

    const diaDoFechamento = session.closed_at ? diaDaLoja(session.closed_at) : null;
    const hoje = hojeNaLoja(agora);
    if (diaDoFechamento !== hoje) {
      throw new ApiError(
        'CORE_CASH_REOPEN_TOO_LATE',
        `Este turno foi fechado em ${diaDoFechamento ?? 'data desconhecida'} e hoje é ${hoje}. `
          + 'A reabertura vale só no mesmo dia da loja: depois disso o fechamento já é o '
          + 'fato do dia, e desfazê-lo é lançamento, não botão.',
        409,
        { fechadoEm: diaDoFechamento, hoje },
      );
    }

    /*
      O ÍNDICE ÚNICO `ux_cash_open_per_terminal` recusa duas sessões abertas no
      mesmo terminal, e ele recusaria com um erro cru de constraint. A recusa
      nomeada vem antes para que quem está no balcão leia o motivo em vez de
      "SQLITE_CONSTRAINT" — e o caso é real: fecha-se o turno da manhã, abre-se o
      da tarde, e alguém tenta reabrir o da manhã.
    */
    const aberta = db
      .prepare(
        "SELECT id FROM core_cash_sessions WHERE company_id = ? AND status = 'open' AND terminal_id IS ?",
      )
      .get(input.companyId, session.terminal_id ?? null) as { id: string } | undefined;
    if (aberta) {
      throw new ApiError(
        'CORE_CASH_ALREADY_OPEN',
        'Já existe um caixa aberto neste terminal. Feche-o antes de reabrir o turno anterior.',
        409,
        { abertaEm: aberta.id },
      );
    }

    // Quem tem alçada reabre direto; quem não tem gasta o bilhete do gestor.
    const perfis = input.alcada?.profileCodes ?? [];
    let liberacao: { id: string; authorizedBy: string } | null = null;
    if (!temAlcadaParaLiberar(perfis)) {
      if (!input.alcada?.authorizationId) {
        throw new ApiError(
          'CORE_REOPEN_NEEDS_AUTHORIZATION',
          'Reabrir um turno de caixa é decisão de quem responde pela operação. '
            + 'Peça a liberação de um gestor para este turno.',
          403,
          { sessionId: session.id, action: 'reabrir_caixa' },
        );
      }
      const gasta = consumirLiberacaoDeAcao({
        companyId: input.companyId,
        authorizationId: input.alcada.authorizationId,
        requestedBy: input.userId,
        action: 'reabrir_caixa',
        refType: 'cash_session',
        refId: session.id,
        now,
      });
      liberacao = { id: gasta.id, authorizedBy: gasta.authorizedBy };
    }

    // O fechamento desfeito vai para a pilha ANTES de as colunas vivas serem
    // limpas — ler e escrever na mesma transação é o que garante que nenhum
    // fechamento se perca entre as duas escritas.
    const anterior: FechamentoArquivado = {
      closed_by: (session as CashSession & { closed_by?: string | null }).closed_by ?? null,
      closed_at: session.closed_at,
      counted_cents: session.counted_cents,
      expected_cents: session.expected_cents,
      difference_cents: session.difference_cents,
      reopened_at: now,
      reopened_by: input.userId,
      reopen_reason: input.reason?.trim() || null,
      closed_with_pending: session.closed_with_pending ?? null,
    };
    const trilha: FechamentoArquivado[] = (() => {
      const cru = session.closing_trail;
      if (!cru) return [];
      try {
        const lido: unknown = JSON.parse(cru);
        return Array.isArray(lido) ? (lido as FechamentoArquivado[]) : [];
      } catch {
        // Trilha ilegível não pode DERRUBAR a reabertura — ela é o arquivo, não
        // a regra. O fechamento de agora entra numa pilha nova, e o texto velho
        // continua no `detail` da auditoria desta reabertura.
        return [];
      }
    })();
    trilha.push(anterior);

    db.prepare(
      `UPDATE core_cash_sessions
          SET status = 'open',
              closed_by = NULL, closed_at = NULL,
              counted_cents = NULL, expected_cents = NULL, difference_cents = NULL,
              reopened_at = ?, reopened_by = ?, reopen_reason = ?,
              reopen_count = COALESCE(reopen_count, 0) + 1,
              closing_trail = ?,
              closed_with_pending = NULL
        WHERE id = ? AND status = 'closed'`,
    ).run(
      now,
      input.userId,
      anterior.reopen_reason,
      JSON.stringify(trilha),
      session.id,
    );

    return {
      session: getSession(input.companyId, input.sessionId)!,
      authorizationId: liberacao?.id ?? null,
      authorizedBy: liberacao?.authorizedBy ?? null,
    };
  });
}

export interface CashSummary {
  session: CashSession;
  expectedCents: number;
  byMethod: { method: string; total: number }[];
  /**
   * O troco devolvido no turno — a ponte entre os outros dois números.
   *
   * `byMethod.dinheiro` responde quanto o cliente ENTREGOU em espécie;
   * `expectedCents` responde quanto FICOU na gaveta. Numa venda de R$ 50 paga
   * com uma nota de R$ 100 o primeiro diz 100 e o segundo diz 50, e nada na
   * tela explicava a diferença: quem confere lê "recebido em dinheiro R$ 100",
   * conta R$ 50 na gaveta e vai procurar um erro que não existe.
   *
   * Com o troco no resumo, a tela escreve a conta inteira:
   * entregue − troco = gaveta.
   */
  changeCents: number;
  movements: Record<string, unknown>[];
  /**
   * O dinheiro eletrônico do turno ainda indefinido (GAP-PRD-081) — a mesma
   * conta que trava o fechamento, para a tela avisar ANTES de o operador
   * contar a gaveta. Nulo em turno já fechado.
   */
  pendenciasEletronicas: PendenciasEletronicas | null;
}

export function getSummary(companyId: string, sessionId: string): CashSummary | null {
  ensureCoreSchema();
  const session = getSession(companyId, sessionId);
  if (!session) return null;
  const db = getConnection();
  // Totais por forma de pagamento consideram a venda inteira, não só a gaveta.
  //
  // Os DOIS status importam, e por muito tempo só um era olhado. `s.status`
  // diz se a VENDA se concretizou; `p.status` diz se o DINHEIRO chegou. Um PIX
  // fica em `pending` até o provedor confirmar, e sem o segundo filtro ele
  // entrava na conferência como valor recebido — o operador fechava a gaveta
  // conferindo contra um total que incluía dinheiro que ainda não existia.
  //
  // O resto do fluxo de venda já tratava isso: `SalesService` filtra
  // `(p.status ?? 'settled') === 'settled'` em seis pontos antes de creditar
  // caixa ou gerar financeiro. Só o fechamento tinha ficado de fora.
  const byMethod = db
    .prepare(
      `SELECT p.method AS method, COALESCE(SUM(p.amount_cents), 0) AS total
         FROM core_sale_payments p
         JOIN core_sales s ON s.id = p.sale_id
        WHERE s.cash_session_id = ? AND s.status = 'completed'
          AND p.status = 'settled'
        GROUP BY p.method`,
    )
    .all(sessionId) as unknown as { method: string; total: number }[];
  /*
    O TROCO DO TURNO — mesma janela de vendas do `byMethod`.

    Os mesmos dois filtros: só venda concretizada conta. Venda cancelada devolve
    o líquido à gaveta e sai da conferência; deixar o troco dela aqui quebraria
    a aritmética que a tela escreve, e quem lê acharia que falta dinheiro.
  */
  const troco = db
    .prepare(
      `SELECT COALESCE(SUM(change_cents), 0) AS total
         FROM core_sales
        WHERE cash_session_id = ? AND status = 'completed'`,
    )
    .get(sessionId) as { total: number };
  const movements = db
    .prepare('SELECT * FROM core_cash_movements WHERE session_id = ? ORDER BY created_at')
    .all(sessionId) as unknown as Record<string, unknown>[];
  return {
    session,
    expectedCents: expectedCents(sessionId),
    byMethod,
    changeCents: troco.total,
    movements,
    pendenciasEletronicas: session.status === 'open' ? pendenciasEletronicasDoTurno(companyId, session) : null,
  };
}

/**
 * O histórico de turnos da gaveta: abertura, fechamento e diferença, com quem
 * abriu e quem fechou PELO NOME — `opened_by` cru é um id, e a pergunta de
 * quem olha o histórico ("de quem era o caixa que fechou faltando 40?") se
 * responde com gente, não com uuid.
 */
export function listSessions(
  companyId: string,
  limit = 50,
): (CashSession & { opened_by_name: string | null; closed_by_name: string | null })[] {
  ensureCoreSchema();
  // O teto protege a consulta de um `?limit=abc` (NaN não entra em bind) e de
  // um pedido desmedido; o histórico completo é caso de exportação, não de tela.
  const teto = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 50;
  return getConnection()
    .prepare(
      `SELECT s.*, ua.display_name AS opened_by_name, uf.display_name AS closed_by_name
         FROM core_cash_sessions s
         LEFT JOIN core_users ua ON ua.id = s.opened_by
         LEFT JOIN core_users uf ON uf.id = s.closed_by
        WHERE s.company_id = ?
        ORDER BY s.opened_at DESC
        LIMIT ?`,
    )
    .all(companyId, teto) as unknown as (CashSession & {
    opened_by_name: string | null;
    closed_by_name: string | null;
  })[];
}

// ============================================================================
// A GAVETA ESQUECIDA (GAP-PRD-131)
// ============================================================================

/** `2026-08-12` → `12/08/2026`: a data como o balcão lê. */
function dataBr(dia: string): string {
  const [ano, mes, d] = dia.split('-');
  return `${d}/${mes}/${ano}`;
}

/**
 * A gaveta foi aberta num dia da loja ANTERIOR a hoje?
 *
 * O banco operacional tinha duas gavetas abertas havia semanas (a Gringa desde
 * 12/08, a Preço Justo desde 26/08), e nenhuma tela dizia isso: a primeira
 * venda de setembro cairia no turno de agosto, com o esperado somando trinta
 * dias. O dia é o do calendário da loja (`diaDaLoja`), não o texto UTC — uma
 * gaveta aberta às 21h30 não vira "de ontem" por causa de Greenwich.
 *
 * Devolve nulo para a gaveta de hoje: é o que a tela usa para não desenhar
 * aviso nenhum.
 */
export function deOutroDia(
  openedAt: string,
  agora: Date = new Date(),
): { abertaNoDia: string; hoje: string; dias: number } | null {
  const abertaNoDia = diaDaLoja(openedAt);
  const hoje = hojeNaLoja(agora);
  if (abertaNoDia >= hoje) return null;
  const [a1, m1, d1] = abertaNoDia.split('-').map(Number);
  const [a2, m2, d2] = hoje.split('-').map(Number);
  const dias = Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
  return { abertaNoDia, hoje, dias };
}

export interface GavetaAberta {
  sessionId: string;
  terminalId: string | null;
  terminalName: string | null;
  terminalCode: string | null;
  openedAt: string;
  openedBy: string;
  openedByName: string | null;
  openingCents: number;
  expectedCents: number;
  deOutroDia: { abertaNoDia: string; hoje: string; dias: number } | null;
}

/**
 * Todas as gavetas abertas da operação, uma por caixa — a lista que o Painel e
 * a tela de Caixa leem para apontar a esquecida e deixar o gestor fechá-la.
 *
 * O esperado vem da mesma soma de movimentos do fechamento (`expectedCents`):
 * uma segunda conta aqui seria uma segunda verdade sobre a mesma gaveta.
 */
export function listarGavetasAbertas(companyId: string, agora: Date = new Date()): GavetaAberta[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT s.id, s.terminal_id, s.opened_at, s.opened_by, s.opening_cents,
              t.name AS terminal_name, t.code AS terminal_code,
              u.display_name AS opened_by_name
         FROM core_cash_sessions s
         LEFT JOIN core_terminals t ON t.id = s.terminal_id
         LEFT JOIN core_users u ON u.id = s.opened_by
        WHERE s.company_id = ? AND s.status = 'open'
        ORDER BY s.opened_at`,
    )
    .all(companyId) as unknown as {
    id: string;
    terminal_id: string | null;
    opened_at: string;
    opened_by: string;
    opening_cents: number;
    terminal_name: string | null;
    terminal_code: string | null;
    opened_by_name: string | null;
  }[];
  return linhas.map((l) => ({
    sessionId: l.id,
    terminalId: l.terminal_id,
    terminalName: l.terminal_name,
    terminalCode: l.terminal_code,
    openedAt: l.opened_at,
    openedBy: l.opened_by,
    openedByName: l.opened_by_name,
    openingCents: l.opening_cents,
    expectedCents: expectedCents(l.id),
    deOutroDia: deOutroDia(l.opened_at, agora),
  }));
}
