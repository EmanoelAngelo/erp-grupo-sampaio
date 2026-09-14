/**
 * ============================================================================
 * A HIERARQUIA DA EQUIPE, POR CAPACIDADE — e não por lista de exceções
 * ============================================================================
 *
 * ## O que estava errado (GAP-PRD-010)
 *
 * A regra "quem não pode CRIAR um dono não pode mexer na conta de um dono"
 * existia em duas listas soltas dentro de `TeamService`: `PERFIS_DE_DONO`
 * guardava a ATRIBUIÇÃO e `assertPodeMexerNoAlvo` guardava o ALVO. As duas
 * tinham o mesmo furo, medido com supertest e login Argon2id real:
 *
 *   - `admin_geral` não estava na lista. Um gerente de loja trocava a senha do
 *     administrador do sistema (200) e entrava como ele — alcance no grupo
 *     inteiro, certificado A1, produção do Asaas;
 *   - o PATCH de equipe nunca conferia o alvo. O mesmo gerente rebaixava o
 *     gestor a estoquista e o `admin_geral` a atendente (200 nos dois), e
 *     trocava nome e e-mail do gestor.
 *
 * Lista de exceção esquece o próximo caso por construção: o perfil que ninguém
 * lembrou de escrever passa. Aqui a pergunta é outra — QUANTO cada perfil
 * alcança na gestão de pessoas — e o perfil desconhecido cai no nível mais
 * alto de exigência. Falha fechada.
 *
 * ## Os três níveis
 *
 *   - RESPONDE PELO GRUPO — `admin_geral` e `gestor`. São PARES: o atalho de
 *     `requireProfile` já os trata igual em toda rota do núcleo.
 *   - MONTA O TIME — `gerente_loja` e `gerente_oficina`. Cadastram, editam,
 *     desativam e redefinem a senha de quem trabalha na operação, inclusive de
 *     outro gerente (é par, não escalada).
 *   - NENHUM — o resto. As rotas de equipe já os recusam no `requireProfile`;
 *     o nível existe para a conta fechar mesmo se uma rota nova esquecer.
 *
 * E a EXIGÊNCIA de cada perfil-alvo: os perfis da operação exigem "monta o
 * time"; os de dono (`admin_geral`, `gestor`, `contador`) e qualquer código que
 * este arquivo não conheça exigem "responde pelo grupo".
 *
 * ## A conta é UMA, as operações são várias (GAP-PRD-152)
 *
 * Senha, ativo, nome e e-mail moram em `core_users` — valem para TODAS as
 * operações da pessoa. O perfil e as bancadas moram no vínculo, uma linha por
 * operação. Por isso há duas perguntas, e não uma:
 *
 *   - `assertPodeMexerNaOperacao` — mexer no que é DESTA operação (perfil,
 *     bancadas, remover daqui). Basta a capacidade aqui vencer a exigência do
 *     perfil que o alvo tem aqui.
 *   - `assertPodeMexerNaConta` — mexer no que é da PESSOA (senha, desativação,
 *     nome, e-mail). Quem age precisa vencer a exigência do alvo em CADA
 *     operação em que ele entra. Sem isto, o gestor de uma loja só desativava o
 *     administrador do grupo nas seis — e o gerente da loja A trocava a senha
 *     de um mecânico que também trabalha na B, onde ele não manda em ninguém.
 *
 * Os perfis de quem age NESTA operação vêm do TOKEN (a mesma regra do resto do
 * núcleo — perfil pelo corpo seria a escalada pedindo licença); os das outras
 * operações vêm do vínculo no banco, porque o token só fala da operação ativa.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';

/** Quanto um perfil alcança na gestão de pessoas. Maior alcança mais. */
export const NIVEL = {
  NENHUM: 0,
  MONTA_O_TIME: 1,
  RESPONDE_PELO_GRUPO: 2,
} as const;

export type Nivel = (typeof NIVEL)[keyof typeof NIVEL];

/** Os pares do topo — o mesmo atalho de `requireProfile`. */
const RESPONDEM_PELO_GRUPO = new Set(['admin_geral', 'gestor']);

/** Quem monta o time de UMA operação. */
const MONTAM_O_TIME = new Set(['gerente_loja', 'gerente_oficina']);

/**
 * Os perfis DA OPERAÇÃO — os que um gerente administra.
 *
 * `operador_caixa` (o genérico, de instalação antiga) está aqui porque ainda
 * pode existir em banco antigo: é caixa como os outros dois, e deixá-lo fora
 * trancaria o gerente para fora do próprio caixa.
 */
const PERFIS_DA_OPERACAO = new Set([
  'gerente_loja',
  'gerente_oficina',
  'mecanico',
  'atendente',
  'estoquista',
  'operador_caixa',
  'operador_caixa_loja',
  'operador_caixa_oficina',
]);

/**
 * Por que cada perfil de dono é de dono — a frase que vai na recusa.
 *
 * `admin_geral` entrou aqui com o GAP-PRD-010. Ele não é atribuível pela tela
 * (`ASSIGNABLE_PROFILES` não o lista), e a ausência na lista de ATRIBUIÇÃO foi
 * lida como se bastasse; mas o alvo de um reset de senha não precisa ser
 * atribuído, só precisa existir.
 */
export const POR_QUE_E_DE_DONO: Record<string, string> = {
  admin_geral:
    'O perfil "admin_geral" administra o sistema: certificado A1, integração de pagamento, '
    + 'abertura de operações. Só quem responde pelo grupo mexe nesta conta.',
  gestor:
    'O perfil "gestor" alcança todas as operações do grupo, inclusive criar novas. '
    + 'Só quem já responde pelo grupo pode entregá-lo.',
  contador:
    'O perfil "contador" dá login a uma pessoa de FORA da empresa, que leva para fora o '
    + 'pacote fiscal do mês inteiro. Só quem responde pelo grupo escolhe a quem entregá-lo.',
};

/** O maior nível entre os perfis de quem age. */
export function capacidadeDe(perfis: readonly string[]): Nivel {
  if (perfis.some((p) => RESPONDEM_PELO_GRUPO.has(p))) return NIVEL.RESPONDE_PELO_GRUPO;
  if (perfis.some((p) => MONTAM_O_TIME.has(p))) return NIVEL.MONTA_O_TIME;
  return NIVEL.NENHUM;
}

/**
 * O nível que é preciso ter para mexer em quem tem este perfil (ou para
 * entregá-lo). Perfil desconhecido exige o topo — falha fechada.
 */
export function exigenciaDe(perfil: string): Nivel {
  return PERFIS_DA_OPERACAO.has(perfil) ? NIVEL.MONTA_O_TIME : NIVEL.RESPONDE_PELO_GRUPO;
}

/** O perfil é de dono (ou desconhecido, que é tratado igual)? */
export function eDeDono(perfil: string): boolean {
  return exigenciaDe(perfil) === NIVEL.RESPONDE_PELO_GRUPO;
}

/**
 * Quem age pode ENTREGAR este perfil? A régua da criação e da promoção.
 *
 * Não confere se o perfil é atribuível — isso é `ASSIGNABLE_PROFILES`, que
 * continua em `TeamService` e continua recusando `admin_geral` com 400.
 */
export function assertPodeAtribuir(perfil: string, perfisDeQuemAge: readonly string[]): void {
  if (capacidadeDe(perfisDeQuemAge) >= exigenciaDe(perfil)) return;
  throw new ApiError(
    'CORE_PROFILE_ABOVE_YOURS',
    POR_QUE_E_DE_DONO[perfil] ?? 'Só quem responde pelo grupo pode entregar este perfil.',
    403,
    { profileCode: perfil },
  );
}

interface Vinculo {
  company_id: string;
  profile_code: string;
}

function vinculosDe(userId: string): Vinculo[] {
  return getConnection()
    .prepare('SELECT company_id, profile_code FROM core_user_companies WHERE user_id = ?')
    .all(userId) as unknown as Vinculo[];
}

function recusaDeAlvo(perfilDoAlvo: string): ApiError {
  return new ApiError(
    'CORE_TARGET_ABOVE_YOURS',
    `Esta conta tem o perfil "${perfilDoAlvo}", e só quem responde pelo grupo mexe nela. `
      + (POR_QUE_E_DE_DONO[perfilDoAlvo] ?? ''),
    403,
    { profileCode: perfilDoAlvo },
  );
}

function recusaDeAlcance(outrasOperacoes: number): ApiError {
  return new ApiError(
    'CORE_TARGET_BEYOND_YOUR_REACH',
    `Esta conta também entra em ${outrasOperacoes} outra(s) operação(ões) do grupo, e em ao menos `
      + 'uma delas você não responde pela equipe. Senha, desativação, nome e e-mail valem para '
      + 'todas — peça a quem responde por elas, ou use "Remover desta operação" para tirar a '
      + 'pessoa só daqui.',
    403,
    { outrasOperacoes },
  );
}

/**
 * Quem age pode mexer no que é DESTA operação — perfil, bancadas, vínculo?
 *
 * `perfilDoAlvo` vazio (vínculo inexistente) exige o topo; na prática quem
 * chama já passou por `assertSameCompany`, que devolve 404 antes.
 */
export function assertPodeMexerNaOperacao(
  perfilDoAlvoAqui: string,
  perfisDeQuemAge: readonly string[],
): void {
  if (capacidadeDe(perfisDeQuemAge) >= exigenciaDe(perfilDoAlvoAqui)) return;
  throw recusaDeAlvo(perfilDoAlvoAqui);
}

/**
 * Quem age pode mexer no que é DA PESSOA — senha, ativo, nome, e-mail?
 *
 * Três condições, na ordem em que a recusa é mais útil de ler:
 *
 *   1. vence a exigência do alvo NESTA operação (a mesma de cima);
 *   2. se o alvo é a própria pessoa que age, basta — ninguém é "de fora" de
 *      si mesmo (e desativar a si mesmo continua recusado em outro lugar);
 *   3. em CADA outra operação do alvo, quem age tem ali um vínculo cujo nível
 *      vence a exigência do perfil que o alvo tem ali.
 */
export function assertPodeMexerNaConta(input: {
  companyId: string;
  alvoId: string;
  actorId: string;
  perfisDeQuemAge: readonly string[];
}): void {
  const vinculosDoAlvo = vinculosDe(input.alvoId);
  const aqui = vinculosDoAlvo.find((v) => v.company_id === input.companyId);
  assertPodeMexerNaOperacao(aqui?.profile_code ?? '', input.perfisDeQuemAge);

  if (input.alvoId === input.actorId) return;

  const outras = vinculosDoAlvo.filter((v) => v.company_id !== input.companyId);
  if (outras.length === 0) return;

  const doAtor = new Map(vinculosDe(input.actorId).map((v) => [v.company_id, v.profile_code]));
  const alcancaTodas = outras.every((v) => {
    const perfilDoAtorLa = doAtor.get(v.company_id);
    return perfilDoAtorLa !== undefined && capacidadeDe([perfilDoAtorLa]) >= exigenciaDe(v.profile_code);
  });
  if (!alcancaTodas) throw recusaDeAlcance(outras.length);
}

/** O que a tela pode oferecer sobre um membro — espelho exato das recusas. */
export interface AcoesSobreMembro {
  /** Perfil e bancadas nesta operação. */
  gerirNaOperacao: boolean;
  /** Senha, desativação, nome e e-mail — valem para todas as operações. */
  gerirConta: boolean;
  /** Tirar a pessoa só desta operação, mantendo as outras. */
  removerDaOperacao: boolean;
  /** Em quantas OUTRAS operações a conta entra. Número, não nomes: não vaza o grupo. */
  outrasOperacoes: number;
  /** Quando `gerirConta` é falso, a frase que a recusa do servidor diria. */
  motivo: string | null;
}

/**
 * As ações permitidas, calculadas pelas MESMAS funções que recusam — a tela
 * nunca oferece o que o servidor nega, e nunca esconde o que ele aceita.
 */
export function acoesSobre(input: {
  companyId: string;
  alvoId: string;
  actorId: string;
  perfisDeQuemAge: readonly string[];
}): AcoesSobreMembro {
  const vinculosDoAlvo = vinculosDe(input.alvoId);
  const aqui = vinculosDoAlvo.find((v) => v.company_id === input.companyId);
  const perfilAqui = aqui?.profile_code ?? '';
  const outrasOperacoes = vinculosDoAlvo.filter((v) => v.company_id !== input.companyId).length;

  const tentar = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  };

  const motivoOperacao = tentar(() => assertPodeMexerNaOperacao(perfilAqui, input.perfisDeQuemAge));
  const motivoConta = tentar(() => assertPodeMexerNaConta(input));

  return {
    gerirNaOperacao: motivoOperacao === null,
    gerirConta: motivoConta === null,
    removerDaOperacao:
      motivoOperacao === null
      && outrasOperacoes > 0
      && input.alvoId !== input.actorId
      && perfilAqui !== 'admin_geral',
    outrasOperacoes,
    motivo: motivoConta,
  };
}
