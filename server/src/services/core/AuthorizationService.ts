/**
 * Autorização gerencial no balcão.
 *
 * Certas ações do PDV exigem liberação de quem tem alçada — desconto acima do
 * limite, cancelamento, alteração de preço. O operador NÃO sai da venda: um
 * gestor digita a própria credencial ali mesmo, a ação é liberada e o
 * responsável fica registrado.
 *
 * A credencial do gestor é verificada com o mesmo Argon2id do login. Ela não
 * cria sessão nem devolve token: autoriza aquela ação e nada mais.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { emReais } from './Money.js';
import { assertMembership, findUserByLogin } from '../auth/IdentityService.js';
import { verifyPassword, wasteVerificationTime } from '../auth/PasswordService.js';
import { politicaDaEmpresa } from './SalePolicyService.js';

/** Perfis com alçada para liberar ação restrita. */
const AUTHORIZERS = new Set(['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina']);

/**
 * Ações que exigem liberação — e SÓ entra aqui o que alguém cobra de verdade.
 *
 * A regra é essa, e ela existe porque a lista já prometeu cinco portas e
 * entregou uma: `cancelar_venda`, `alterar_preco` e `reabrir_caixa` ficaram
 * declaradas sem ninguém as exigir em lugar nenhum, e quem lia a lista
 * acreditava que o balcão estava protegido. Elas foram RETIRADAS na rodada da
 * alçada, cada uma com o motivo escrito. Duas voltam agora, e voltam porque o
 * motivo da saída deixou de valer — não porque a lista ficou bonita com elas.
 *
 * Quem entrar aqui declara, junto, ONDE é cobrado:
 *
 * - `desconto_acima_limite` — cobrado em `SalesService.createSale` e
 *   `QuoteService.createQuote`, pedido pelo `PdvPage` e pela aprovação de
 *   orçamento em `OrcamentosPage`.
 * - `sangria_especial` — cobrado em `CashService.addMovement`, no caminho
 *   `withdrawal`, pedido pelo `CaixaPdvDialog` (F3 do PDV).
 * - `cancelar_venda` — cobrado em `POST /core/sales/:id/cancel`, pedido pela
 *   `DevolucoesPage`.
 * - `devolver_venda` — cobrado em `POST /core/sale-returns`, pedido pela
 *   `DevolucoesPage`.
 * - `reabrir_caixa` — cobrado em `POST /core/cash/:sessionId/reopen`, pedido
 *   pela `CaixaPage`.
 *
 * ## Por que as três voltam a ser DUAS, e por que estas duas voltaram
 *
 * `cancelar_venda` saiu com este argumento, e ele era bom: a rota exigia
 * `gerente_loja`, e exigir liberação ali seria PIOR que nada, porque ninguém
 * autoriza a própria ação — o gerente que a rota já exigia teria de chamar um
 * SEGUNDO gerente para cancelar. O que mudou não foi a opinião: foi o desenho.
 * A rota deixou de exigir o perfil como ÚNICA porta e passa a aceitar DUAS —
 * quem tem alçada cancela DIRETO, sem pedir nada a ninguém, e quem não tem
 * chama um gestor ali mesmo, sem trocar de sessão. O argumento do segundo
 * gerente morre porque o gerente não pede nada; a liberação só existe para
 * quem ANTES tomava 403 e ia embora. `devolver_venda` é a mesma porta pelo
 * mesmo motivo, e as duas ficam lado a lado na mesma tela.
 *
 * `reabrir_caixa` saiu porque não existia rota, função nem botão, e o motivo
 * não era permissão — era desenho: `closeSession` grava esperado, contado e
 * diferença como FATO, e reabrir obrigava a decidir o destino daquela
 * conferência. A decisão foi tomada (a trilha `closing_trail`, na DDL de
 * `core_cash_sessions`), a rota existe, e agora a tranca tem o que trancar.
 *
 * `alterar_preco` continua FORA, e continua pelo mesmo motivo: preço abaixo do
 * vigente já é CONCESSÃO medida no servidor e já é cobrada por
 * `desconto_acima_limite`, com teto por operação. Declarar esta faria acreditar
 * numa segunda trava que não existe.
 */
export const RESTRICTED_ACTIONS = new Set([
  'desconto_acima_limite',
  'sangria_especial',
  'cancelar_venda',
  'devolver_venda',
  'reabrir_caixa',
]);

/**
 * As ações cujo "sim" vale para UM recurso, e não para a ação em geral.
 *
 * A diferença é a que separa uma liberação de um cheque em branco. As duas
 * ações de dinheiro (desconto e sangria) são presas pelo VALOR: o gestor libera
 * R$ 3.400 de concessão, e o consumo compara centavos e percentual. Cancelar,
 * devolver e reabrir não têm valor a comparar — o que elas têm é um ALVO. Um
 * "sim" para cancelar a venda #482 não pode cancelar a #483, e sem esta lista
 * ele podia: `reference_id` era escrita na liberação e NENHUMA decisão a lia.
 *
 * Por isso, para estas três, a referência é OBRIGATÓRIA na hora de pedir e
 * CONFERIDA na hora de gastar. Uma liberação sem alvo para uma ação de alvo
 * seria exatamente o cheque em branco.
 */
export const ACOES_PRESAS_AO_RECURSO = new Set([
  'cancelar_venda',
  'devolver_venda',
  'reabrir_caixa',
]);

/**
 * QUANTO TEMPO O "SIM" DO GESTOR VALE — quinze minutos.
 *
 * O consumo único já impedia a segunda venda, e por muito tempo isso pareceu
 * suficiente. Não é, e a diferença aparece nas ações sem valor: uma liberação
 * de `cancelar_venda` que nunca foi gasta continuava viva no banco para
 * sempre. O operador pede a senha do gerente às nove da manhã "para conferir
 * uma coisa", não usa, e às sete da noite — com a loja vazia e o gerente em
 * casa — cancela a venda com um bilhete que ninguém lembra de ter dado.
 *
 * Quinze minutos é o tempo de o gestor estar POR PERTO. A liberação nasce
 * porque alguém digitou uma senha ao lado do operador; ela deixa de valer
 * quando essa presença deixa de ser plausível. Vale para TODAS as ações, e não
 * só para as novas: o desconto tinha o mesmo buraco, só que escondido atrás do
 * consumo — o PDV que guardasse o id fechava com ele no dia seguinte.
 *
 * O relógio é o do `created_at` contra o instante do consumo, e não uma coluna
 * `expires_at`: prazo derivado não pode ser adulterado por um UPDATE, e mudar
 * a constante passa a valer para as liberações que já estão no banco em vez de
 * só para as próximas.
 */
export const VALIDADE_DA_LIBERACAO_MS = 15 * 60 * 1000;

/**
 * Tem alçada para liberar, e portanto não precisa pedir para si mesmo.
 *
 * Existe como função exportada porque a pergunta era feita por um truque:
 * "discountNeedsAuthorization(10000, 10000, perfis)" — um desconto de 100%
 * inventado só para ver se voltava falso. Funcionava, e escondia a pergunta
 * real atrás de dois números que não significam nada.
 */
export function temAlcadaParaLiberar(profileCodes: string[]): boolean {
  return profileCodes.some((p) => AUTHORIZERS.has(p));
}

/** Os perfis de alçada que moram NA operação — os que ficam no balcão. */
const AUTORIZADORES_DA_OPERACAO = new Set(['gerente_loja', 'gerente_oficina']);

export interface QuemLibera {
  nome: string;
  perfil: string;
}

/**
 * QUEM LIBERA NESTA OPERAÇÃO (GAP-PRD-054).
 *
 * A mesma régua de `registrarAutorizacao`: vínculo nesta operação com perfil
 * de `AUTHORIZERS`, conta ativa. Separa quem é DA operação (gerente de loja ou
 * de oficina — quem costuma estar no balcão) de quem é do GRUPO (admin_geral e
 * gestor). É o organograma que a alçada pressupõe, dito em voz alta: no banco
 * real só os dois donos respondem pelas seis operações, e toda liberação
 * depende de um deles digitar a senha ao lado do operador.
 *
 * Só o nome de exibição e o perfil. O LOGIN fica de fora de propósito: ele é
 * metade da credencial que o diálogo de liberação pede.
 */
export function quemLiberaNaOperacao(companyId: string): {
  daOperacao: QuemLibera[];
  doGrupo: QuemLibera[];
} {
  ensureCoreSchema();
  const perfis = [...AUTHORIZERS];
  const linhas = getConnection()
    .prepare(
      `SELECT u.display_name AS nome, uc.profile_code AS perfil
         FROM core_user_companies uc
         JOIN core_users u ON u.id = uc.user_id
        WHERE uc.company_id = ?
          AND u.active = 1
          AND uc.profile_code IN (${perfis.map(() => '?').join(', ')})
        ORDER BY u.display_name`,
    )
    .all(companyId, ...perfis) as unknown as QuemLibera[];
  return {
    daOperacao: linhas.filter((l) => AUTORIZADORES_DA_OPERACAO.has(l.perfil)),
    doGrupo: linhas.filter((l) => !AUTORIZADORES_DA_OPERACAO.has(l.perfil)),
  };
}

export interface AuthorizationResult {
  id: string;
  action: string;
  authorizedBy: string;
  authorizedByName: string;
  createdAt: string;
  /** Teto em dinheiro, quando quem pediu declarou o que estava liberando. */
  grantedConcessionCents: number | null;
  grantedGrossCents: number | null;
  /** O ALVO do "sim", quando a ação tem alvo (venda, devolução, turno). */
  referenceId: string | null;
  /** Onde a senha foi digitada. Nulo é a verdade quando não houve terminal. */
  terminalId: string | null;
  ip: string | null;
  /** Até quando este bilhete vale — derivado de `created_at`, não gravado. */
  expiresAt: string;
  /** O motivo digitado (`justification`). Nulo quando ninguém o disse. */
  justificativa: string | null;
}

/** O motivo mais curto que ainda diz alguma coisa ("ok" e "." não dizem). */
const MOTIVO_MINIMO = 3;
/** Motivo é uma frase de balcão; texto maior que isto é colagem por engano. */
const MOTIVO_MAXIMO = 500;

/**
 * O MOTIVO DIGITADO, conferido — nulo quando ninguém disse nada.
 *
 * Recusa alto o que passa do tamanho em vez de cortar: cortar em silêncio
 * guardaria na trilha uma frase que ninguém escreveu.
 */
function motivoDigitado(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).replace(/\s+/g, ' ').trim();
  if (texto.length > MOTIVO_MAXIMO) {
    throw new ApiError(
      'CORE_AUTHORIZATION_REASON_INVALID',
      `O motivo da liberação passa de ${MOTIVO_MAXIMO} caracteres. Resuma em uma frase.`,
      400,
      { maximo: MOTIVO_MAXIMO },
    );
  }
  return texto === '' ? null : texto;
}

/**
 * Quanto foi liberado, quando quem pede sabe dizer.
 *
 * O PDV de hoje pede a liberação com um `reason` em texto — "Concessão de
 * R$ 3.400,00 (28%) sobre R$ 12.000,00…" —, e texto não se compara com número.
 * Este campo é o mesmo fato em forma conferível, e é ele que faz a liberação
 * valer para AQUELA concessão em vez de valer para qualquer uma.
 */
function tetoDeclarado(
  valor: unknown,
  campo: string,
): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  // Recusa alto em vez de gravar nulo: um teto que virou NaN e foi guardado
  // como "não declarado" é uma liberação SEM teto nascida de um erro de
  // digitação — a trava falhando aberta, que é o modo de falha que esta
  // rodada existe para eliminar.
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(
      'CORE_AUTHORIZATION_INVALID_AMOUNT',
      `${campo}: informe o valor em centavos, ou deixe em branco.`,
      400,
      { campo },
    );
  }
  return Math.round(n);
}

export async function authorizeAction(input: {
  companyId: string;
  requestedBy: string;
  action: string;
  login: string;
  password: string;
  reason?: string;
  /**
   * O ALVO do "sim". Obrigatório nas ações de `ACOES_PRESAS_AO_RECURSO`.
   *
   * Era opcional para todas e escrito sem leitor: a coluna `reference_id`
   * recebia o id da venda e nenhuma decisão a consultava. Nas ações de dinheiro
   * ela continua sendo só informação (o que prende a liberação lá é o valor);
   * nas de alvo ela é a trava, e por isso a ausência é RECUSADA aqui em vez de
   * virar uma liberação que serve para qualquer venda.
   */
  referenceId?: string;
  detail?: unknown;
  /** O endereço do SOCKET de quem pediu — nunca o de um cabeçalho. */
  ip?: string | null;
  /** O terminal da sessão de quem pediu, quando a sessão é de terminal. */
  terminalId?: string | null;
  /**
   * O QUE está sendo liberado, em dinheiro.
   *
   * Opcional porque a tela do PDV ainda não o envia e a tela não é desta
   * rodada. Ausente, a liberação nasce sem teto — e continua valendo UMA vez
   * só, porque o consumo (abaixo) não depende deste campo. Presente, ela vale
   * até este valor e nem um centavo além: liberar R$ 1.800 e vender concedendo
   * R$ 7.200 passa a ser recusado.
   */
  concessao?: { concedidoCents?: unknown; brutoCents?: unknown } | null;
  /**
   * O PORQUÊ, digitado por gente (P0 da Preço Justo) — vai para `justification`.
   *
   * `reason` é a frase que a tela monta com os números; esta é a que alguém
   * escreveu. Obrigatória no desconto quando a operação liga
   * `core_sale_policies.discount_reason_required`.
   */
  justificativa?: unknown;
}): Promise<AuthorizationResult> {
  ensureCoreSchema();

  if (!RESTRICTED_ACTIONS.has(input.action)) {
    throw new ApiError('CORE_UNKNOWN_ACTION', `Ação não reconhecida: ${input.action}`, 400);
  }

  /*
    O MOTIVO É CONFERIDO ANTES DA SENHA, pela mesma razão do alvo logo abaixo:
    recusar depois faria o gestor digitar a credencial para nada, e a recusa
    cairia no ponto em que `wasteVerificationTime` gasta tempo de propósito.

    O DEFEITO: a liberação de desconto não exigia porquê nenhum. A trilha dizia
    QUANTO foi liberado e QUEM assinou, e a frase de `reason` era montada pela
    tela com os números — "cliente antigo" e "o gerente é amigo do cliente"
    ficavam indistinguíveis. Onde a operação exige, sem motivo não há senha.
  */
  const justificativa = motivoDigitado(input.justificativa);
  if (
    input.action === 'desconto_acima_limite'
    && (justificativa === null || justificativa.length < MOTIVO_MINIMO)
    && politicaDaEmpresa(input.companyId).discountReasonRequired
  ) {
    throw new ApiError(
      'CORE_AUTHORIZATION_REASON_REQUIRED',
      'Nesta operação a liberação de desconto exige o motivo: diga por que este desconto '
        + 'está sendo dado (ex.: "cliente fiel, compra de atacado"). Ele fica na trilha com o '
        + 'nome de quem liberou.',
      400,
      { action: input.action, minimo: MOTIVO_MINIMO },
    );
  }

  /*
    O ALVO É CONFERIDO ANTES DA SENHA, e a ordem é deliberada.

    Recusar depois faria o gestor digitar a credencial para nada, e — pior —
    faria a recusa acontecer no ponto onde `wasteVerificationTime` gasta tempo
    de propósito: quem estivesse sondando descobriria a diferença entre "pedido
    malformado" e "senha errada" pelo relógio. Antes da senha, o pedido sem alvo
    é um erro de programa, e responde como erro de programa.
  */
  const alvo = String(input.referenceId ?? '').trim();
  if (ACOES_PRESAS_AO_RECURSO.has(input.action) && !alvo) {
    throw new ApiError(
      'CORE_AUTHORIZATION_NEEDS_REFERENCE',
      `A liberação de "${input.action}" vale para UM recurso, e nenhum foi informado. `
        + 'Sem o alvo, o mesmo "sim" serviria para qualquer venda.',
      400,
      { action: input.action },
    );
  }

  const manager = findUserByLogin(input.login ?? '');
  if (!manager || !manager.active) {
    // Mesmo custo de tempo do caminho válido, para não revelar quais logins
    // de gestor existem a quem estiver no balcão.
    await wasteVerificationTime();
    throw new ApiError('CORE_AUTHORIZATION_DENIED', 'Credencial não autorizada.', 403);
  }

  const verification = await verifyPassword(input.password ?? '', manager.password_hash);
  if (!verification.valid) {
    throw new ApiError('CORE_AUTHORIZATION_DENIED', 'Credencial não autorizada.', 403);
  }

  // A alçada é na EMPRESA da venda: gerente de outra operação não libera.
  const membership = assertMembership(manager.id, input.companyId);
  if (!membership || !AUTHORIZERS.has(membership.profile_code)) {
    throw new ApiError(
      'CORE_AUTHORIZATION_DENIED',
      'Este usuário não tem alçada para autorizar nesta operação.',
      403,
    );
  }

  // Ninguém autoriza a própria ação restrita.
  if (manager.id === input.requestedBy) {
    throw new ApiError(
      'CORE_SELF_AUTHORIZATION',
      'A ação precisa ser autorizada por outro usuário.',
      403,
    );
  }

  const concedido = tetoDeclarado(input.concessao?.concedidoCents, 'Valor da concessão');
  const bruto = tetoDeclarado(input.concessao?.brutoCents, 'Valor bruto da venda');

  const id = randomUUID();
  const now = new Date().toISOString();
  const terminal = input.terminalId ?? null;
  const ip = input.ip ?? null;
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by, reason, detail, reference_id,
          granted_concession_cents, granted_gross_cents, terminal_id, ip, created_at,
          justification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.companyId,
      input.action,
      input.requestedBy,
      manager.id,
      input.reason ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      alvo || null,
      concedido,
      bruto,
      terminal,
      ip,
      now,
      justificativa,
    );

  return {
    id,
    action: input.action,
    authorizedBy: manager.id,
    authorizedByName: manager.display_name,
    createdAt: now,
    grantedConcessionCents: concedido,
    grantedGrossCents: bruto,
    referenceId: alvo || null,
    terminalId: terminal,
    ip,
    expiresAt: new Date(Date.parse(now) + VALIDADE_DA_LIBERACAO_MS).toISOString(),
    justificativa,
  };
}

/**
 * A LINHA DA LIBERAÇÃO, com as três recusas que valem para TODA ação.
 *
 * Extraída de `consumirLiberacaoDeConcessao` porque as ações sem valor
 * (cancelar, devolver, reabrir) precisam exatamente destas e de mais nada — e
 * a alternativa era copiar as três. Copiar as regras de um bilhete de uma
 * viagem só é como duas verdades sobre "liberação usada" nascem: a cópia
 * envelhece, alguém conserta uma e não a outra, e o contorno reaparece pela
 * porta que ninguém está olhando.
 *
 * Devolve a linha CONFERIDA e ainda não gasta. Quem chama decide o resto — os
 * tetos de dinheiro, no caso da concessão; o alvo, no caso das outras.
 */
interface LinhaDaLiberacao {
  id: string;
  requested_by: string;
  authorized_by: string;
  reference_id: string | null;
  granted_concession_cents: number | null;
  granted_gross_cents: number | null;
  consumed_ref_type: string | null;
  consumed_ref_id: string | null;
  terminal_id: string | null;
  ip: string | null;
  created_at: string;
  justification: string | null;
}

function liberacaoValida(input: {
  companyId: string;
  authorizationId: string;
  requestedBy: string;
  action: string;
  now: string;
}): LinhaDaLiberacao | null {
  const linha = getConnection()
    .prepare(
      `SELECT id, requested_by, authorized_by, reference_id,
              granted_concession_cents, granted_gross_cents,
              consumed_ref_type, consumed_ref_id, terminal_id, ip, created_at, justification
         FROM core_authorizations
        WHERE id = ? AND company_id = ? AND action = ?`,
    )
    .get(input.authorizationId, input.companyId, input.action) as LinhaDaLiberacao | undefined;

  if (!linha) return null;

  if (linha.consumed_ref_id) {
    throw new ApiError(
      'CORE_AUTHORIZATION_ALREADY_USED',
      'Esta liberação já foi usada e não vale para um segundo documento. '
        + 'Peça uma nova autorização ao gestor.',
      409,
      { authorizationId: linha.id, usadaEm: linha.consumed_ref_id, tipo: linha.consumed_ref_type },
    );
  }

  // A liberação foi pedida POR alguém, contra a credencial de um gestor. Passar
  // o id para outro operador é o mesmo contorno da reutilização, só que entre
  // duas pessoas em vez de dois momentos.
  if (linha.requested_by !== input.requestedBy) {
    throw new ApiError(
      'CORE_AUTHORIZATION_NOT_YOURS',
      'Esta liberação foi dada a outro operador. Peça a sua ao gestor.',
      403,
      { authorizationId: linha.id },
    );
  }

  const idade = Date.parse(input.now) - Date.parse(linha.created_at);
  // `Number.isFinite` cobre a linha com `created_at` ilegível: sem ele, um NaN
  // faria a comparação ser false e o bilhete velho passaria — a trava falhando
  // aberta, que é o modo de falha que este módulo inteiro existe para eliminar.
  if (!Number.isFinite(idade) || idade > VALIDADE_DA_LIBERACAO_MS) {
    throw new ApiError(
      'CORE_AUTHORIZATION_EXPIRED',
      `Esta liberação foi dada em ${linha.created_at} e vale por `
        + `${Math.round(VALIDADE_DA_LIBERACAO_MS / 60000)} minutos. Peça uma nova ao gestor.`,
      403,
      { authorizationId: linha.id, criadaEm: linha.created_at },
    );
  }

  return linha;
}

/**
 * GASTA o bilhete, com a escrita condicional que torna a segunda vez
 * impossível — mesmo quando as duas tentativas chegam juntas.
 *
 * `UPDATE ... WHERE consumed_ref_id IS NULL` com a contagem de linhas
 * conferida, e não um `if` sobre a leitura: ler-e-depois-escrever teria uma
 * janela entre as duas.
 */
function gastarBilhete(input: {
  linha: LinhaDaLiberacao;
  refType: string;
  refId: string;
  now: string;
}): void {
  const gasto = getConnection()
    .prepare(
      `UPDATE core_authorizations
          SET consumed_ref_type = ?, consumed_ref_id = ?, consumed_at = ?
        WHERE id = ? AND consumed_ref_id IS NULL`,
    )
    .run(input.refType, input.refId, input.now, input.linha.id);

  // Zero linhas significa que outra transação gastou a liberação entre a
  // leitura e a escrita. É o caso raro, e é justamente o que um `if` sobre a
  // leitura deixaria passar.
  if (Number(gasto.changes) !== 1) {
    throw new ApiError(
      'CORE_AUTHORIZATION_ALREADY_USED',
      'Esta liberação acabou de ser usada em outro documento. Peça uma nova ao gestor.',
      409,
      { authorizationId: input.linha.id },
    );
  }
}

export interface LiberacaoGasta {
  id: string;
  authorizedBy: string;
  requestedBy: string;
  terminalId: string | null;
  ip: string | null;
}

/**
 * GASTA a liberação de uma ação SEM VALOR, presa ao recurso que ela nomeia.
 *
 * O irmão de `consumirLiberacaoDeConcessao` para cancelar, devolver e reabrir.
 * Compartilha com ele as três recusas de `liberacaoValida` (já gasta, de outro
 * operador, vencida) e a escrita condicional de `gastarBilhete`; o que ele tem
 * de próprio é a ÚNICA pergunta que resta quando não há dinheiro para comparar:
 * este "sim" era para ESTE recurso?
 *
 * ## Por que ele ESTOURA onde o da concessão devolve nulo
 *
 * Lá, o nulo existia porque quem chamava tinha uma mensagem melhor — a da
 * alçada, que diz quanto se está concedendo, de onde vem e qual é o limite.
 * Aqui não há mensagem melhor: "cancelar exige gestor" já é tudo o que a rota
 * sabe dizer, e devolver nulo obrigaria cada chamador a reinventar a mesma
 * recusa. Um id inventado, de outra empresa ou de outra ação é a MESMA
 * tentativa de passar sem liberação, e responde como tal.
 *
 * ## E por que a referência é conferida aqui, e não na rota
 *
 * Porque a rota que esquecesse de conferir ficaria verde: a liberação existe,
 * é do operador, está no prazo e não foi gasta. O "sim" da venda #482
 * cancelaria a #483 sem nenhum sintoma — e esse é exatamente o defeito que
 * `reference_id` escrita sem leitor deixava passar.
 */
export function consumirLiberacaoDeAcao(input: {
  companyId: string;
  authorizationId: string;
  requestedBy: string;
  action: 'cancelar_venda' | 'devolver_venda' | 'reabrir_caixa';
  /**
   * ONDE o bilhete foi gasto. `sale` cobre cancelar E devolver: as duas são
   * feitas sobre o MESMO registro, e a devolução ainda não existe na hora em
   * que o gestor digita a senha. Quem separa os dois "sim" é a AÇÃO, que entra
   * na consulta acima.
   */
  refType: 'sale' | 'cash_session';
  /** O recurso de verdade: TEM de ser o mesmo que o gestor liberou. */
  refId: string;
  now: string;
}): LiberacaoGasta {
  const linha = liberacaoValida(input);
  if (!linha) {
    throw new ApiError(
      'CORE_AUTHORIZATION_INVALID',
      'Liberação não encontrada para esta ação nesta operação. Peça uma nova ao gestor.',
      403,
      { authorizationId: input.authorizationId, action: input.action },
    );
  }

  if (linha.reference_id !== input.refId) {
    throw new ApiError(
      'CORE_AUTHORIZATION_OTHER_RESOURCE',
      'Esta liberação foi dada para outro registro e não vale para este. '
        + 'Peça ao gestor a liberação deste.',
      403,
      {
        authorizationId: linha.id,
        liberadoPara: linha.reference_id,
        pedidoPara: input.refId,
      },
    );
  }

  gastarBilhete({ linha, refType: input.refType, refId: input.refId, now: input.now });

  return {
    id: linha.id,
    authorizedBy: linha.authorized_by,
    requestedBy: linha.requested_by,
    terminalId: linha.terminal_id,
    ip: linha.ip,
  };
}

/**
 * GASTA a liberação do gestor no documento que a está usando.
 *
 * ## O contorno que esta função existe para fechar
 *
 * A conferência antiga era uma pergunta de EXISTÊNCIA:
 *
 *     SELECT id FROM core_authorizations
 *      WHERE id = ? AND company_id = ? AND action = 'desconto_acima_limite'
 *
 * Um `SELECT` que nunca escreve nada. A liberação não era consumida, não era
 * vinculada à venda e não tinha valor. Consequências, todas verificadas no
 * código: o mesmo id liberava a venda de hoje, a de amanhã e a da semana que
 * vem, para clientes diferentes; e um "sim" dado para 15% autorizava 60%,
 * porque não havia com o que comparar. Um PDV que guardasse o id — e o nosso
 * guarda, em `authorizationId` — transformava uma senha de gerente digitada uma
 * vez em desconto ilimitado até a aba ser fechada.
 *
 * ## Por que o consumo é uma ESCRITA CONDICIONAL, e não um "if"
 *
 * `UPDATE ... WHERE consumed_ref_id IS NULL` com a contagem de linhas conferida
 * é o que torna a segunda tentativa impossível mesmo se duas chegarem juntas —
 * ler-e-depois-escrever teria uma janela entre as duas. E ela roda DENTRO da
 * transação do documento: se a venda falhar depois (saldo, caixa fechado), o
 * rollback devolve a liberação intacta, e o operador não precisa chamar o
 * gerente de novo por causa de um erro que não foi dele.
 *
 * ## O que devolve nulo e o que estoura
 *
 * Nulo é "não há liberação válida" — id inventado, de outra empresa, de outra
 * ação. Quem chamou tem uma mensagem muito melhor para dar nesse caso: a dela
 * diz quanto foi concedido, de onde veio e qual é o limite. Repetir aqui uma
 * mensagem pobre seria piorar o balcão.
 *
 * Estoura o que a pessoa PRECISA entender: liberação já gasta, de outro
 * operador, VENCIDA, e pequena demais para a concessão. As quatro são
 * tentativas de reutilizar um "sim" que não cobre este documento — e as três
 * primeiras vieram morar em `liberacaoValida`, compartilhadas com as ações que
 * não têm valor a comparar (cancelar, devolver, reabrir).
 */
export function consumirLiberacaoDeConcessao(input: {
  companyId: string;
  authorizationId: string;
  /** Quem está no balcão. A liberação é DELE, e não da loja. */
  requestedBy: string;
  /**
   * Qual ação está sendo liberada. Padrão: o desconto, que era a única.
   *
   * A sangria acima do teto usa a MESMA mecânica — liberação de um gestor,
   * gasta uma vez, presa a quem pediu e ao documento — e trocar a mecânica por
   * uma cópia seria duas verdades sobre o que "liberação usada" significa. O
   * que a sangria não tem é percentual: o teto da gaveta é absoluto, e a
   * comparação de percentual abaixo já se cala sozinha quando `brutoCents` é
   * zero.
   *
   * A ação faz parte da consulta de propósito: liberação de desconto não paga
   * sangria, e vice-versa. Sem isso, um "sim" para tirar R$ 800 da gaveta
   * autorizaria R$ 800 de desconto numa venda.
   */
  action?: 'desconto_acima_limite' | 'sangria_especial';
  concedidoCents: number;
  /**
   * O BRUTO DESTE documento — sem ele o teto do gestor não vira percentual.
   *
   * Ver a recusa `CORE_AUTHORIZATION_ABOVE_PERCENT` mais abaixo: é este número
   * que transforma "liberei R$ 3.400" em "liberei 28% de uma venda de
   * R$ 12.000", e é a segunda coisa que a liberação precisa cobrar.
   */
  brutoCents: number;
  refType: 'sale' | 'quote' | 'cash_movement';
  refId: string;
  now: string;
}): {
  id: string;
  grantedConcessionCents: number | null;
  /** Quem ASSINOU — lido da liberação gravada, nunca do corpo da requisição. */
  authorizedBy: string;
  /** O motivo digitado na liberação (`justification`). */
  justificativa: string | null;
} | null {
  const acao = input.action ?? 'desconto_acima_limite';
  // As três recusas que valem para toda ação — já gasta, de outro operador,
  // vencida — moram em `liberacaoValida`, com as das ações sem valor. Uma cópia
  // aqui seria a segunda verdade sobre o que "liberação usada" significa.
  const linha = liberacaoValida({
    companyId: input.companyId,
    authorizationId: input.authorizationId,
    requestedBy: input.requestedBy,
    action: acao,
    now: input.now,
  });

  if (!linha) return null;

  // Nulo aqui é a liberação que não declarou valor — o caminho do PDV atual.
  // Ela continua servindo, e continua servindo UMA vez: o consumo abaixo não
  // depende deste campo. O que ela não faz é autorizar um valor que ninguém
  // chegou a dizer em voz alta.
  if (
    linha.granted_concession_cents !== null
    && input.concedidoCents > linha.granted_concession_cents
  ) {
    throw new ApiError(
      'CORE_AUTHORIZATION_BELOW_CONCESSION',
      `O gestor liberou ${emReais(linha.granted_concession_cents)} de concessão, e este `
        + `documento concede ${emReais(input.concedidoCents)}. Peça uma liberação para o `
        + 'valor atual ou reduza a concessão.',
      403,
      {
        authorizationId: linha.id,
        autorizadoCents: linha.granted_concession_cents,
        concedidoCents: input.concedidoCents,
      },
    );
  }

  /*
    O TETO EM CENTAVOS SOZINHO NÃO DIZ O QUE O GESTOR APROVOU — e esta é a
    leitura que faltava a `granted_gross_cents`.

    A coluna era escrita na liberação e devolvida na resposta, e NENHUMA decisão
    a consultava: a conferência acima comparava só centavos. Coluna com escritor
    e sem leitor é exatamente o que o cabeçalho de `SalePolicyService` proíbe, e
    aqui ela custava um contorno de verdade:

      O gestor olha a tela — "R$ 3.400,00 de concessão sobre R$ 12.000,00", os
      28,3% da moto — e digita a senha. Antes de fechar, o operador tira a moto
      do carrinho e deixa só os acessórios: bruto R$ 5.000,00, e a MESMA
      concessão de R$ 3.400,00. São 68%. O teto em centavos não é ultrapassado
      (R$ 3.400 = R$ 3.400) e a venda fecha com a assinatura de um gestor que
      aprovou outra venda.

    O percentual é o que o gestor de fato decidiu; os centavos são a forma como
    aquela decisão apareceu naquele carrinho. Comparar os dois fecha o vão.

    NULO CONTINUA PASSANDO, e é a mesma porta estreita do teto em centavos: a
    liberação que não declarou bruto (o caminho do PDV de hoje) vale para a
    concessão do documento que a consumir — uma vez. O que não se faz é INVENTAR
    um denominador para ela.

    E `brutoCents <= 0` também não compara: conceder sobre bruto zero já é caso
    de `discountNeedsAuthorization` devolver `true` sempre, e uma divisão por
    zero aqui só produziria um percentual sem significado.
  */
  if (
    linha.granted_gross_cents !== null
    && linha.granted_gross_cents > 0
    && input.brutoCents > 0
  ) {
    const liberado = percentualDaConcessao(
      linha.granted_gross_cents,
      linha.granted_concession_cents ?? 0,
    );
    const pedido = percentualDaConcessao(input.brutoCents, input.concedidoCents);
    if (pedido > liberado) {
      throw new ApiError(
        'CORE_AUTHORIZATION_ABOVE_PERCENT',
        `O gestor liberou ${liberado}% (${emReais(linha.granted_concession_cents ?? 0)} sobre `
          + `${emReais(linha.granted_gross_cents)}), e este documento concede ${pedido}% `
          + `(${emReais(input.concedidoCents)} sobre ${emReais(input.brutoCents)}). `
          + 'O carrinho mudou depois da liberação: peça uma nova ao gestor com o valor de agora.',
        403,
        {
          authorizationId: linha.id,
          percentualAutorizado: liberado,
          percentualPedido: pedido,
          autorizadoCents: linha.granted_concession_cents,
          autorizadoBrutoCents: linha.granted_gross_cents,
          concedidoCents: input.concedidoCents,
          brutoCents: input.brutoCents,
        },
      );
    }
  }

  gastarBilhete({ linha, refType: input.refType, refId: input.refId, now: input.now });

  return {
    id: linha.id,
    grantedConcessionCents: linha.granted_concession_cents,
    authorizedBy: linha.authorized_by,
    justificativa: linha.justification ?? null,
  };
}

/**
 * QUANTO DA VENDA A LOJA ABRIU MÃO, em percentual — a conta, em um lugar só.
 *
 * Ela existia escrita três vezes com a mesma forma (createSale, createQuote e o
 * consumo da liberação), e três cópias de uma conta que PRECISA dar o mesmo
 * número são três chances de divergirem: basta alguém arredondar uma delas para
 * uma casa, e a liberação passa a comparar 28,3% com 28,33%.
 *
 * As duas convenções ficam aqui, e as duas são deliberadas:
 *
 *   DUAS CASAS   é o que cabe numa mensagem de balcão, e é o número que vai
 *                para a auditoria e para a tela do PDV.
 *   BRUTO ZERO   com algo concedido é 100% por definição — deu-se tudo o que
 *                havia. Zero concedido sobre zero bruto é 0%: não houve venda
 *                de que abrir mão.
 */
export function percentualDaConcessao(brutoCents: number, concedidoCents: number): number {
  if (brutoCents > 0) return Math.round((concedidoCents / brutoCents) * 10000) / 100;
  return concedidoCents > 0 ? 100 : 0;
}

/**
 * A CONCESSÃO PASSA DO LIMITE EM PERCENTUAL? — em inteiros, e não em ponto
 * flutuante (P0 da Preço Justo).
 *
 * O DEFEITO: a comparação era `(concedido / bruto) * 100 > limite`. Em
 * JavaScript, `(7 / 100) * 100` é 7,000000000000001: numa operação com limite de
 * 7%, o desconto de EXATOS 7% (R$ 7,00 sobre R$ 100,00) pedia gestor — a trava
 * errava para o lado de fechar o balcão sem motivo, e o operador aprendia que o
 * número da tela não é o número do servidor.
 *
 * Aqui tudo vira inteiro: o limite em centésimos de ponto (2,5% → 250) e a
 * comparação cruzada `concedido × 10000 > limite × bruto`, que não arredonda
 * nada. Com centavos até a casa do bilhão o produto fica abaixo de 2^53.
 *
 * Bruto zero com algo concedido passa do limite por definição — deu-se
 * mercadoria cujo preço a loja nunca definiu. Nada concedido nunca passa.
 */
export function passaDoPercentual(
  brutoCents: number,
  concedidoCents: number,
  limitePercent: number,
): boolean {
  if (!(concedidoCents > 0)) return false;
  if (!(brutoCents > 0)) return true;
  const limiteEmCentesimos = Math.round(limitePercent * 100);
  return Math.round(concedidoCents) * 10000 > limiteEmCentesimos * Math.round(brutoCents);
}

/**
 * Concessão acima do limite do balcão precisa de liberação.
 *
 * O LIMITE AGORA VEM DE FORA, e isso é a rodada inteira em uma linha: ele era
 * uma constante deste arquivo, o dono não alcançava, e cada operação do grupo
 * era obrigada a viver com os mesmos 10%. Quem chama passa o limite vigente da
 * empresa (SalePolicyService.politicaDaEmpresa), e este módulo volta a fazer
 * só o que sabe fazer: comparar e decidir.
 *
 * O DENOMINADOR NÃO É MAIS O TOTAL DA VENDA, e é por isso que o parâmetro se
 * chama "bruto". Total é o que o cliente paga DEPOIS da concessão; medir a
 * concessão contra ele infla o percentual. Bruto é o preço vigente vezes a
 * quantidade, calculado no servidor — o que a loja cobraria se não tivesse
 * aberto mão de nada. Quem produz esse número é o createSale, que é o único
 * lugar que conhece o preço vigente de cada linha.
 */
export function discountNeedsAuthorization(
  brutoCents: number,
  concedidoCents: number,
  profileCodes: string[],
  limitePercent: number,
): boolean {
  if (concedidoCents <= 0) return false;
  // Quem já tem alçada não precisa pedir para si mesmo.
  if (temAlcadaParaLiberar(profileCodes)) return false;
  // Conceder alguma coisa sobre bruto zero é dar mercadoria cujo preço a loja
  // nunca definiu. Não há percentual que descreva isso, e passar em silêncio
  // seria a trava falhando aberta — então pede gestor. E a conta é em
  // inteiros: ver `passaDoPercentual`.
  return passaDoPercentual(brutoCents, concedidoCents, limitePercent);
}

/**
 * AS LIBERAÇÕES DA OPERAÇÃO, com os DOIS nomes — a consulta que virou tela.
 *
 * A rota `GET /core/authorizations` existia desde a primeira rodada da alçada e
 * NENHUMA tela a chamava: cada senha de gerente digitada no balcão virava linha
 * no banco e ninguém tinha como ler. O dono só descobria a liberação abrindo o
 * SQLite, e por isso nunca descobria.
 *
 * Duas coisas mudam aqui, e as duas são o que faltava para a lista responder a
 * pergunta que se faz olhando para ela:
 *
 *   OS DOIS NOMES. `authorized_by_name` sozinho conta metade — quem assinou.
 *   A outra metade é quem PEDIU, e ela é a que interessa numa lista de
 *   liberações: "o caixa novo pediu seis liberações esta semana" é um fato que
 *   um uuid em `requested_by` não deixa ninguém ver.
 *
 *   O TETO DA CONSULTA. `limit` entrava cru no bind. Um `?limit=abc` chega
 *   como NaN, o SQLite recusa com "datatype mismatch" e a tela toma 500 — o
 *   mesmo defeito que `listSessions` e `listAudit` já tinham fechado, cada uma
 *   com o seu guarda. Esta é a terceira, e agora as três se parecem.
 */
export function listAuthorizations(companyId: string, limit = 100): Record<string, unknown>[] {
  ensureCoreSchema();
  const teto = Number.isFinite(Number(limit))
    ? Math.min(Math.max(1, Math.floor(Number(limit))), 200)
    : 100;
  return getConnection()
    .prepare(
      `SELECT a.*, u.display_name AS authorized_by_name, p.display_name AS requested_by_name
         FROM core_authorizations a
         LEFT JOIN core_users u ON u.id = a.authorized_by
         LEFT JOIN core_users p ON p.id = a.requested_by
        WHERE a.company_id = ?
        ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(companyId, teto) as unknown as Record<string, unknown>[];
}
