/**
 * O LIMITE DE DESCONTO DE QUEM ESTÁ NO BALCÃO — por perfil, em % e em R$, na
 * venda inteira e em cada linha (P0 da Preço Justo).
 *
 * ## O defeito que este módulo fecha
 *
 * A alçada fazia UMA pergunta: "a concessão da venda passa de X% do bruto?",
 * com X igual para a operação inteira. Três coisas que o balcão precisa não
 * cabiam nela, e as três passavam sem gestor e sem rastro:
 *
 *   - LIMITE POR PERFIL. A atendente e o operador de caixa tinham o mesmo teto,
 *     e quem tinha perfil de gerente não tinha teto NENHUM;
 *   - LIMITE EM VALOR. 10% de uma moto de R$ 12.000 são R$ 1.200: o operador
 *     dava R$ 1.200 sem ninguém ver, porque o percentual cabia;
 *   - LIMITE POR ITEM. 10% da venda inteira cabem dando 60% numa linha barata
 *     escondida dentro de uma venda grande.
 *
 * ## O que NÃO muda para quem não configurou
 *
 * Operação sem linha em `core_discount_limits` tem exatamente o comportamento de
 * antes: quem não tem alçada fica com o `discount_limit_percent` da operação (10%
 * de padrão), sem teto em valor e sem teto por linha; quem tem alçada não tem
 * teto. Quem garante isso é `limiteDeUmPerfil`, e o caso "empresa que nunca
 * abriu a tela vende exatamente como ontem" (politica-do-balcao) continua de pé.
 *
 * ## Mais de um perfil, mais de uma pessoa
 *
 * O token pode trazer mais de um perfil da MESMA pessoa: cada teto é o MAIS
 * LARGO entre eles — a mesma regra de `temAlcadaParaLiberar` (basta um perfil
 * ter alçada). Duas PESSOAS diferentes (quem vendeu offline e quem reenviou a
 * fila) é outra pergunta, e ali vale o MAIS ESTREITO de cada teto: nenhuma das
 * duas pode abrir para a outra o que a própria régua não abre.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { emReais } from './Money.js';
import { passaDoPercentual, percentualDaConcessao, temAlcadaParaLiberar } from './AuthorizationService.js';
import { limitesPorPerfil, politicaDaEmpresa, type LimitePorPerfil } from './SalePolicyService.js';

/** Os quatro tetos de quem está no balcão. Nulo = sem este teto. */
export interface LimiteDeDesconto {
  /** Concessão da venda inteira, em % do bruto. */
  percentual: number | null;
  /** Concessão da venda inteira, em centavos. */
  valorCents: number | null;
  /** Concessão de UMA linha, em % do bruto dela. */
  itemPercentual: number | null;
  /** Concessão de UMA linha, em centavos. */
  itemValorCents: number | null;
  /** Algum dos tetos veio de uma linha de `core_discount_limits`. */
  doPerfil: boolean;
}

/** Uma linha da venda (ou do documento), medida pelo servidor. */
export interface LinhaDaConcessao {
  productId: string | null;
  nome: string;
  /** O que a linha cobraria sem abrir mão de nada. */
  brutoCents: number;
  /** Desconto da linha + preço rebaixado — o rodapé NÃO entra aqui. */
  concedidoCents: number;
}

/** A concessão do documento inteiro e a de cada linha. */
export interface MedidaDaConcessao {
  brutoCents: number;
  /** Rodapé + linhas + preço rebaixado — a venda inteira. */
  concedidoCents: number;
  linhas: LinhaDaConcessao[];
}

export type RegraDoLimite = 'percentual_venda' | 'valor_venda' | 'percentual_item' | 'valor_item';

/** Um teto ultrapassado, com os números que a recusa e a trilha mostram. */
export interface ExcessoDeDesconto {
  regra: RegraDoLimite;
  /** O teto: em % nas regras de percentual, em centavos nas de valor. */
  limite: number;
  /** O medido na mesma unidade do teto (percentual com duas casas). */
  medido: number;
  concedidoCents: number;
  brutoCents: number;
  productId?: string | null;
  nome?: string;
}

const SEM_TETO = {
  percentual: null,
  valorCents: null,
  itemPercentual: null,
  itemValorCents: null,
} as const;

export function semTeto(l: LimiteDeDesconto): boolean {
  return (
    l.percentual === null
    && l.valorCents === null
    && l.itemPercentual === null
    && l.itemValorCents === null
  );
}

/**
 * O limite de UM perfil — e é aqui que mora a garantia do "nada muda".
 *
 * Sem linha: quem tem alçada não tem teto (o de sempre); quem não tem fica com
 * o percentual da operação e mais nada (o de sempre). Com linha: o que o dono
 * escreveu, e o percentual vazio de quem não tem alçada continua sendo o da
 * operação — apagar o campo não pode virar "sem limite" para o caixa.
 */
function limiteDeUmPerfil(
  perfil: string,
  linha: LimitePorPerfil | undefined,
  daOperacao: number,
): LimiteDeDesconto {
  const alcada = temAlcadaParaLiberar([perfil]);
  if (!linha) {
    return alcada
      ? { ...SEM_TETO, doPerfil: false }
      : { ...SEM_TETO, percentual: daOperacao, doPerfil: false };
  }
  return {
    percentual: linha.maxPercent ?? (alcada ? null : daOperacao),
    valorCents: linha.maxCents,
    itemPercentual: linha.itemMaxPercent,
    itemValorCents: linha.itemMaxCents,
    doPerfil: true,
  };
}

/** O mais LARGO de dois tetos da mesma pessoa: "sem teto" ganha. */
function maisLargo(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

/** O mais ESTREITO de dois tetos de pessoas diferentes: "sem teto" perde. */
function maisEstreito(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * O limite de quem tem ESTES perfis nesta operação.
 *
 * Os perfis vêm do TOKEN (ou da conferência da venda guardada), nunca do corpo
 * da requisição: quem se declara não é quem decide.
 */
export function limiteDosPerfis(companyId: string, profileCodes: string[]): LimiteDeDesconto {
  const daOperacao = politicaDaEmpresa(companyId).discountLimitPercent;
  const perfis = [...new Set((profileCodes ?? []).filter((p) => typeof p === 'string' && p !== ''))];
  // Sem perfil nenhum é quem não tem alçada: o limite da operação, como antes.
  if (perfis.length === 0) return { ...SEM_TETO, percentual: daOperacao, doPerfil: false };
  const porPerfil = new Map(limitesPorPerfil(companyId).map((l) => [l.profileCode, l]));
  return perfis
    .map((p) => limiteDeUmPerfil(p, porPerfil.get(p), daOperacao))
    .reduce((a, b) => ({
      percentual: maisLargo(a.percentual, b.percentual),
      valorCents: maisLargo(a.valorCents, b.valorCents),
      itemPercentual: maisLargo(a.itemPercentual, b.itemPercentual),
      itemValorCents: maisLargo(a.itemValorCents, b.itemValorCents),
      doPerfil: a.doPerfil || b.doPerfil,
    }));
}

/** Os tetos de DUAS pessoas juntas: cada um, o mais estreito. */
export function limiteMaisEstreito(a: LimiteDeDesconto, b: LimiteDeDesconto): LimiteDeDesconto {
  return {
    percentual: maisEstreito(a.percentual, b.percentual),
    valorCents: maisEstreito(a.valorCents, b.valorCents),
    itemPercentual: maisEstreito(a.itemPercentual, b.itemPercentual),
    itemValorCents: maisEstreito(a.itemValorCents, b.itemValorCents),
    doPerfil: a.doPerfil || b.doPerfil,
  };
}

/**
 * O limite da ALÇADA de uma venda ou documento.
 *
 * `perfisDeQuemVendeu` só existe na venda guardada sem servidor que a fila
 * reenvia com a sessão de OUTRA pessoa (G-offline-sync-M03): o limite é o mais
 * estreito das duas. Declarar um gerente como vendedor não abre nada — o campo
 * só pode ESTREITAR a régua de quem envia.
 */
export function limiteDaAlcada(
  companyId: string,
  alcada: { profileCodes: string[]; perfisDeQuemVendeu?: string[] | null },
): LimiteDeDesconto {
  const deQuemPede = limiteDosPerfis(companyId, alcada.profileCodes);
  if (!Array.isArray(alcada.perfisDeQuemVendeu)) return deQuemPede;
  return limiteMaisEstreito(deQuemPede, limiteDosPerfis(companyId, alcada.perfisDeQuemVendeu));
}

/**
 * QUAIS TETOS A CONCESSÃO ULTRAPASSA — vazio quando ela cabe.
 *
 * O percentual é comparado em CENTAVOS INTEIROS (`passaDoPercentual`), e não em
 * ponto flutuante: `(7 / 100) * 100` é 7,000000000000001 em JavaScript, e o
 * desconto de exatos 7% num limite de 7% pedia gestor. O item mede só o que a
 * LINHA concede (desconto da linha + preço rebaixado); o rodapé é da venda e
 * entra no teto da venda, junto com as linhas — é por isso que "item dentro,
 * rodapé dentro, os dois juntos fora" é recusado.
 */
export function excessosDaConcessao(
  limite: LimiteDeDesconto,
  medida: MedidaDaConcessao,
): ExcessoDeDesconto[] {
  const excessos: ExcessoDeDesconto[] = [];
  const { brutoCents, concedidoCents } = medida;
  if (concedidoCents > 0) {
    if (limite.percentual !== null && passaDoPercentual(brutoCents, concedidoCents, limite.percentual)) {
      excessos.push({
        regra: 'percentual_venda',
        limite: limite.percentual,
        medido: percentualDaConcessao(brutoCents, concedidoCents),
        concedidoCents,
        brutoCents,
      });
    }
    if (limite.valorCents !== null && concedidoCents > limite.valorCents) {
      excessos.push({
        regra: 'valor_venda',
        limite: limite.valorCents,
        medido: concedidoCents,
        concedidoCents,
        brutoCents,
      });
    }
  }
  for (const l of medida.linhas) {
    if (!(l.concedidoCents > 0)) continue;
    if (
      limite.itemPercentual !== null
      && passaDoPercentual(l.brutoCents, l.concedidoCents, limite.itemPercentual)
    ) {
      excessos.push({
        regra: 'percentual_item',
        limite: limite.itemPercentual,
        medido: percentualDaConcessao(l.brutoCents, l.concedidoCents),
        concedidoCents: l.concedidoCents,
        brutoCents: l.brutoCents,
        productId: l.productId,
        nome: l.nome,
      });
    }
    if (limite.itemValorCents !== null && l.concedidoCents > limite.itemValorCents) {
      excessos.push({
        regra: 'valor_item',
        limite: limite.itemValorCents,
        medido: l.concedidoCents,
        concedidoCents: l.concedidoCents,
        brutoCents: l.brutoCents,
        productId: l.productId,
        nome: l.nome,
      });
    }
  }
  return excessos;
}

/** O teto ultrapassado em uma frase de balcão, com os números. */
export function fraseDoExcesso(e: ExcessoDeDesconto): string {
  switch (e.regra) {
    case 'percentual_venda':
      return `a venda concede ${emReais(e.concedidoCents)} sobre ${emReais(e.brutoCents)} `
        + `(${e.medido}%), acima do teto de ${e.limite}% por venda`;
    case 'valor_venda':
      return `a venda concede ${emReais(e.concedidoCents)}, acima do teto de ${emReais(e.limite)} por venda`;
    case 'percentual_item':
      return `"${e.nome}" concede ${emReais(e.concedidoCents)} sobre ${emReais(e.brutoCents)} `
        + `(${e.medido}%), acima do teto de ${e.limite}% por item`;
    case 'valor_item':
      return `"${e.nome}" concede ${emReais(e.concedidoCents)}, acima do teto de ${emReais(e.limite)} por item`;
    default:
      return 'a concessão passa do limite';
  }
}

/** A operação configurou algum limite por perfil? */
export function operacaoTemLimitePorPerfil(companyId: string): boolean {
  return Boolean(
    getConnection()
      .prepare('SELECT 1 AS n FROM core_discount_limits WHERE company_id = ? LIMIT 1')
      .get(companyId),
  );
}

/**
 * QUEM LIBERA SÓ LIBERA DENTRO DA PRÓPRIA ALÇADA.
 *
 * O DEFEITO: com limite por perfil, o gerente passou a poder ter teto — e a
 * senha dele continuava liberando QUALQUER concessão para o caixa. Um gerente de
 * loja limitado a 20% autorizava 70% para outra pessoa, e a trava do perfil dele
 * valia só quando ele mesmo vendia.
 *
 * Roda quando a liberação é GASTA, dentro da transação da venda/documento, com a
 * medida inteira (venda e cada linha): se passar do teto de quem assinou, a
 * transação desfaz o consumo e o operador recebe o nome de quem precisa chamar.
 *
 * Só vale para a operação que configurou limite por perfil. Sem configuração,
 * quem tem alçada não tem teto — o comportamento de sempre —, e a pergunta nem
 * precisa ser feita. Com configuração, quem assinou e não é mais vínculo ativo
 * da operação fica com a régua de quem não tem perfil: falha FECHADA.
 */
export function conferirAlcadaDoAutorizador(input: {
  companyId: string;
  authorizedBy: string;
  medida: MedidaDaConcessao;
}): void {
  if (!operacaoTemLimitePorPerfil(input.companyId)) return;
  const vinculo = getConnection()
    .prepare(
      `SELECT uc.profile_code, u.display_name FROM core_user_companies uc
         JOIN core_users u ON u.id = uc.user_id
        WHERE uc.user_id = ? AND uc.company_id = ? AND u.active = 1`,
    )
    .get(input.authorizedBy, input.companyId) as
    | { profile_code: string; display_name: string | null }
    | undefined;
  const limite = limiteDosPerfis(input.companyId, vinculo ? [vinculo.profile_code] : []);
  const excessos = excessosDaConcessao(limite, input.medida);
  if (excessos.length === 0) return;
  throw new ApiError(
    'CORE_AUTHORIZATION_ABOVE_AUTHORIZER_LIMIT',
    `${vinculo?.display_name ?? 'Quem liberou'} não tem alçada para esta concessão: `
      + `${excessos.map(fraseDoExcesso).join('; ')}. `
      + 'Peça a liberação a quem tem alçada maior nesta operação, ou reduza o desconto.',
    403,
    { authorizedBy: input.authorizedBy, excessos },
  );
}
