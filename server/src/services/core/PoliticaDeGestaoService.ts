/**
 * ============================================================================
 * A POLÍTICA DE GESTÃO — duas decisões que o código tomava sozinho
 * ============================================================================
 *
 * ## Quem vê dinheiro (GAP-PRD-165)
 *
 * O painel (faturamento, ticket médio, recebíveis em aberto) e a posição de
 * estoque com custo abriam para o escritório inteiro: atendente e estoquista
 * inclusos. A decisão estava no código com justificativa ("é ROTA_GESTAO") e
 * nunca foi do dono. Agora é, com PADRÃO SEGURO: sem decisão registrada, só a
 * gerência (gerentes, e os donos por cima) vê os números de dinheiro. A rota
 * continua aberta ao escritório — a contagem de vendas, os alertas de estoque e
 * o saldo seguem úteis para quem atende e para quem arruma a prateleira; o que
 * sai da resposta é o DINHEIRO, no servidor, e não escondido na tela.
 *
 * O recorte é o que a ficha pediu, e está escrito na tela: o painel e a posição
 * de estoque (custo por linha, valor por linha, valor total). O custo que o
 * estoquista enxerga trabalhando — na entrada da nota, no pedido de compra, no
 * cadastro do produto — é ferramenta do trabalho dele e não entra aqui.
 *
 * ## A régua do valor do estoque (GAP-PRD-166)
 *
 * O valor do estoque era saldo × custo do CADASTRO (o último custo), por
 * decisão declarada. O contador pode exigir custo MÉDIO para balanço e
 * inventário anual. As duas réguas existem agora; quem escolhe é o dono, e
 * quem CONFIRMA é o contador — a tela registra quem e quando, e mostra a
 * pendência até lá. "Não invente tributação": o sistema não decide pelo
 * contador; ele oferece as duas contas e pergunta.
 *
 * O custo médio é MÓVEL e sai do razão, que sempre guardou o custo de cada
 * entrada (`core_stock_movements.unit_cost_cents`): a cada entrada com custo, a
 * média é refeita ponderando o saldo anterior; saídas não mudam a média;
 * transferência entre locais não é compra. Produto sem nenhuma entrada com
 * custo cai no custo do cadastro — e é CONTADO na resposta, para a pendência
 * aparecer em vez de se esconder dentro do total.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export type ReguaDeValorizacao = 'ultimo_custo' | 'custo_medio';

export interface PoliticaDeGestao {
  /** Atendente e estoquista veem faturamento, ticket e recebíveis no painel. */
  painelFinanceiroEquipe: boolean;
  /** Atendente e estoquista veem custo e valor na posição de estoque. */
  custoDoEstoqueEquipe: boolean;
  reguaDeValorizacao: ReguaDeValorizacao;
  /** Quem (o contador, pelo nome) confirmou a régua, e quando. */
  reguaConfirmadaPor: string | null;
  reguaConfirmadaEm: string | null;
  /** Falso enquanto o dono nunca salvou — valem os padrões seguros. */
  decidida: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

const PADRAO: PoliticaDeGestao = {
  painelFinanceiroEquipe: false,
  custoDoEstoqueEquipe: false,
  reguaDeValorizacao: 'ultimo_custo',
  reguaConfirmadaPor: null,
  reguaConfirmadaEm: null,
  decidida: false,
  updatedBy: null,
  updatedAt: null,
};

export function politicaDeGestao(companyId: string): PoliticaDeGestao {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_management_policies WHERE company_id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  if (!row) return { ...PADRAO };
  return {
    painelFinanceiroEquipe: Number(row.painel_financeiro_equipe) === 1,
    custoDoEstoqueEquipe: Number(row.custo_estoque_equipe) === 1,
    reguaDeValorizacao: row.regua_valorizacao === 'custo_medio' ? 'custo_medio' : 'ultimo_custo',
    reguaConfirmadaPor: (row.regua_confirmada_por as string | null) ?? null,
    reguaConfirmadaEm: (row.regua_confirmada_em as string | null) ?? null,
    decidida: true,
    updatedBy: (row.updated_by as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

export function salvarPoliticaDeGestao(input: {
  companyId: string;
  userId: string;
  painelFinanceiroEquipe?: unknown;
  custoDoEstoqueEquipe?: unknown;
  reguaDeValorizacao?: unknown;
  /** Nome de quem confirmou a régua (o contador). Vazio desfaz a confirmação. */
  reguaConfirmadaPor?: unknown;
}): PoliticaDeGestao {
  ensureCoreSchema();
  const atual = politicaDeGestao(input.companyId);
  const booleano = (v: unknown, padrao: boolean): boolean => {
    if (v === undefined) return padrao;
    if (typeof v !== 'boolean') {
      throw new ApiError('CORE_MANAGEMENT_POLICY_INVALID', 'Os interruptores aceitam só sim ou não.', 400);
    }
    return v;
  };
  const regua = input.reguaDeValorizacao === undefined ? atual.reguaDeValorizacao : input.reguaDeValorizacao;
  if (regua !== 'ultimo_custo' && regua !== 'custo_medio') {
    throw new ApiError(
      'CORE_MANAGEMENT_POLICY_INVALID',
      'A régua do valor do estoque é "ultimo_custo" (custo do cadastro) ou "custo_medio" (média das entradas).',
      400,
    );
  }
  /*
    A CONFIRMAÇÃO É DA RÉGUA, NÃO DA PESSOA: trocar a régua derruba a
    confirmação anterior — o contador confirmou a OUTRA conta. Só volta a valer
    com um nome informado junto da régua nova.
  */
  const nomeInformado =
    input.reguaConfirmadaPor === undefined ? undefined : String(input.reguaConfirmadaPor ?? '').trim();
  const trocouRegua = regua !== atual.reguaDeValorizacao;
  let confirmadaPor = trocouRegua ? null : atual.reguaConfirmadaPor;
  let confirmadaEm = trocouRegua ? null : atual.reguaConfirmadaEm;
  if (nomeInformado !== undefined) {
    confirmadaPor = nomeInformado || null;
    confirmadaEm = nomeInformado ? new Date().toISOString() : null;
  }

  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_management_policies
         (company_id, painel_financeiro_equipe, custo_estoque_equipe, regua_valorizacao,
          regua_confirmada_por, regua_confirmada_em, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         painel_financeiro_equipe = excluded.painel_financeiro_equipe,
         custo_estoque_equipe = excluded.custo_estoque_equipe,
         regua_valorizacao = excluded.regua_valorizacao,
         regua_confirmada_por = excluded.regua_confirmada_por,
         regua_confirmada_em = excluded.regua_confirmada_em,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.companyId,
      booleano(input.painelFinanceiroEquipe, atual.painelFinanceiroEquipe) ? 1 : 0,
      booleano(input.custoDoEstoqueEquipe, atual.custoDoEstoqueEquipe) ? 1 : 0,
      regua,
      confirmadaPor,
      confirmadaEm,
      input.userId,
      agora,
    );
  return politicaDeGestao(input.companyId);
}

/** Gerência (e os donos por cima) sempre vê; o resto do escritório, conforme a política. */
const QUEM_SEMPRE_VE = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'];

function ehGerencia(perfis: string[]): boolean {
  return perfis.some((p) => QUEM_SEMPRE_VE.includes(p));
}

export function veDinheiroDoPainel(companyId: string, perfis: string[]): boolean {
  return ehGerencia(perfis) || politicaDeGestao(companyId).painelFinanceiroEquipe;
}

export function veCustoDoEstoque(companyId: string, perfis: string[]): boolean {
  return ehGerencia(perfis) || politicaDeGestao(companyId).custoDoEstoqueEquipe;
}

// ----------------------------------------------------------- o custo médio

/** Entradas que NÃO são compra: mudam o local ou devolvem o que já tinha custo. */
const ENTRADAS_QUE_NAO_SAO_COMPRA = new Set([
  'TRANSFER_IN',
  'CONSIGNMENT_RETURN',
  'CONSIGNMENT_SYMBOLIC_RETURN',
  'SALE_CANCEL',
  'SALE_RETURN',
  'WORKSHOP_PART_RETURN',
]);

/**
 * O custo médio móvel de cada produto da empresa, reconstruído do razão.
 *
 * Devolve só os produtos que tiveram ao menos UMA entrada com custo; os outros
 * ficam de fora e quem chama cai no custo do cadastro (e conta a pendência).
 */
export function custoMedioPorProduto(companyId: string): Map<string, number> {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT product_id, kind, quantity, quantity_before, unit_cost_cents
         FROM core_stock_movements
        WHERE company_id = ? AND movement_type IN ('in', 'out', 'adjust')
        ORDER BY product_id, created_at, rowid`,
    )
    .all(companyId) as unknown as {
    product_id: string;
    kind: string | null;
    quantity: number;
    quantity_before: number | null;
    unit_cost_cents: number | null;
  }[];

  const medias = new Map<string, number>();
  let produto = '';
  let saldo = 0;
  let media: number | null = null;
  const fechar = () => {
    if (produto && media !== null) medias.set(produto, Math.round(media));
  };
  for (const l of linhas) {
    if (l.product_id !== produto) {
      fechar();
      produto = l.product_id;
      saldo = 0;
      media = null;
    }
    const antes = l.quantity_before === null || l.quantity_before === undefined ? saldo : Number(l.quantity_before);
    const q = Number(l.quantity);
    const custo = l.unit_cost_cents === null || l.unit_cost_cents === undefined ? null : Number(l.unit_cost_cents);
    if (q > 0 && custo !== null && custo >= 0 && !ENTRADAS_QUE_NAO_SAO_COMPRA.has(String(l.kind ?? ''))) {
      const base = Math.max(0, antes);
      media = media === null || base === 0 ? custo : (base * media + q * custo) / (base + q);
    }
    saldo = antes + q;
  }
  fechar();
  return medias;
}

export interface ItemValorizado {
  product_id: string;
  quantity: number;
  cost_cents: number;
  value_cents: number;
  /** O custo que a régua usou para esta linha. */
  valuation_cost_cents: number;
}

/**
 * Aplica a régua às linhas da posição — o MESMO arredondamento por item de
 * `SQL_VALOR_DO_ITEM`, para a linha e o total continuarem batendo.
 */
export function aplicarRegua<T extends { product_id: string; quantity: number; cost_cents: number; value_cents: number }>(
  companyId: string,
  linhas: T[],
): { linhas: (T & { valuation_cost_cents: number })[]; regua: ReguaDeValorizacao; semCustoNoRazao: number } {
  const regua = politicaDeGestao(companyId).reguaDeValorizacao;
  if (regua === 'ultimo_custo') {
    return {
      linhas: linhas.map((l) => ({ ...l, valuation_cost_cents: Number(l.cost_cents) })),
      regua,
      semCustoNoRazao: 0,
    };
  }
  const medias = custoMedioPorProduto(companyId);
  let semCusto = 0;
  const valorizadas = linhas.map((l) => {
    const media = medias.get(l.product_id);
    if (media === undefined && Number(l.quantity) !== 0) semCusto += 1;
    const custo = media ?? Number(l.cost_cents);
    return {
      ...l,
      valuation_cost_cents: custo,
      value_cents: Math.round(Number(l.quantity) * custo),
    };
  });
  return { linhas: valorizadas, regua, semCustoNoRazao: semCusto };
}
