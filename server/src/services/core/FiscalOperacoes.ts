/**
 * AS OPERAÇÕES FISCAIS DA EMPRESA — parâmetros do contador, por empresa (P0 fiscal).
 *
 * ## O defeito
 *
 * A natureza da operação era literal no XML ("VENDA AO CONSUMIDOR", "VENDA DE
 * MERCADORIA") para toda empresa do grupo; a devolução nem existia como
 * operação; e o prazo de cancelamento que a UF aceita não tinha onde morar.
 * Parâmetro do contador escrito no código é regra GLOBAL — exatamente o que o
 * Preço Justo não pode ter: o que o contador dele diz vale para ele, e não para
 * a Gringa.
 *
 * ## O que mora aqui (e o que NÃO mora)
 *
 * Por empresa e por operação (`core_fiscal_operations`): natureza da operação,
 * CFOP da DEVOLUÇÃO (interno e interestadual), o grupo tributário que a
 * devolução usa, o prazo de cancelamento e se o CONTADOR confirmou.
 *
 * O CFOP e a tributação da VENDA continuam no grupo tributário do produto —
 * eles variam por mercadoria, e uma segunda cópia aqui divergiria dela.
 *
 * ## Os padrões e a pendência contábil
 *
 * Sem linha gravada, valem os padrões do sistema: na venda, os mesmos textos
 * de sempre (nada muda para quem não mexer); na devolução, os CFOP da tabela
 * (1202/2202 na devolução de venda, 5202/6202 na de compra). Todo padrão não
 * confirmado aparece como PENDÊNCIA CONTÁBIL — e a devolução só sai em
 * PRODUÇÃO com a operação confirmada pelo contador (em homologação, sai com a
 * pendência declarada).
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import type { DirecaoDaNota } from './TributacaoDoItem.js';

export type OperacaoFiscal = 'venda_nfce' | 'venda_nfe' | 'devolucao_venda' | 'devolucao_compra';

export const OPERACOES_FISCAIS: readonly OperacaoFiscal[] = [
  'venda_nfce',
  'venda_nfe',
  'devolucao_venda',
  'devolucao_compra',
];

interface Padrao {
  rotulo: string;
  natOp: string;
  cfopInterno: string | null;
  cfopInterestadual: string | null;
  direcao: DirecaoDaNota;
  /** O primeiro dígito que o CFOP interno e o interestadual precisam ter. */
  digitos: { interno: string; interestadual: string };
  devolucao: boolean;
}

const PADRAO: Record<OperacaoFiscal, Padrao> = {
  venda_nfce: {
    rotulo: 'Venda com NFC-e (balcão)',
    natOp: 'VENDA AO CONSUMIDOR',
    cfopInterno: null,
    cfopInterestadual: null,
    direcao: 'saida',
    digitos: { interno: '5', interestadual: '6' },
    devolucao: false,
  },
  venda_nfe: {
    rotulo: 'Venda com NF-e',
    natOp: 'VENDA DE MERCADORIA',
    cfopInterno: null,
    cfopInterestadual: null,
    direcao: 'saida',
    digitos: { interno: '5', interestadual: '6' },
    devolucao: false,
  },
  devolucao_venda: {
    rotulo: 'Devolução de venda (NF-e de entrada, finalidade 4)',
    natOp: 'DEVOLUCAO DE VENDA',
    cfopInterno: '1202',
    cfopInterestadual: '2202',
    direcao: 'entrada',
    digitos: { interno: '1', interestadual: '2' },
    devolucao: true,
  },
  devolucao_compra: {
    rotulo: 'Devolução de compra (NF-e de saída, finalidade 4)',
    natOp: 'DEVOLUCAO DE COMPRA',
    cfopInterno: '5202',
    cfopInterestadual: '6202',
    direcao: 'saida',
    digitos: { interno: '5', interestadual: '6' },
    devolucao: true,
  },
};

/** Teto do prazo de cancelamento que a tela aceita: 30 dias. O prazo real é da UF. */
export const PRAZO_DE_CANCELAMENTO_MAXIMO_MIN = 30 * 24 * 60;

/** O `xNatOp` do leiaute tem até 60 caracteres. */
const NAT_OP_MAX = 60;

export interface ParametrosDaOperacao {
  operacao: OperacaoFiscal;
  rotulo: string;
  direcao: DirecaoDaNota;
  natOp: string;
  cfopInterno: string | null;
  cfopInterestadual: string | null;
  /** O grupo tributário que a operação usa no lugar do perfil do produto (só devolução). */
  grupoTributario: string | null;
  /** Nulo: nenhum prazo informado — a SEFAZ decide, e é pendência contábil. */
  prazoCancelamentoMinutos: number | null;
  confirmadaPeloContador: boolean;
  /** 'cadastro' quando a empresa gravou a operação; 'padrao' quando vale o do sistema. */
  origem: 'cadastro' | 'padrao';
  observacao: string | null;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  /** O que ainda depende do contador nesta operação, em palavras. */
  pendencias: string[];
}

function ehOperacao(valor: unknown): valor is OperacaoFiscal {
  return typeof valor === 'string' && (OPERACOES_FISCAIS as readonly string[]).includes(valor);
}

function pendenciasDa(p: Omit<ParametrosDaOperacao, 'pendencias'>): string[] {
  const pendencias: string[] = [];
  const padrao = PADRAO[p.operacao];
  if (!p.confirmadaPeloContador) {
    pendencias.push(
      padrao.devolucao
        ? `${padrao.rotulo}: natureza da operação, CFOP (${p.cfopInterno ?? '—'}/${p.cfopInterestadual ?? '—'}) e `
          + 'tributação ainda não confirmados pelo contador — em produção a devolução não sai sem a confirmação.'
        : `${padrao.rotulo}: a natureza da operação ("${p.natOp}") ainda não foi confirmada pelo contador.`,
    );
  }
  if (padrao.devolucao && !p.grupoTributario) {
    pendencias.push(
      `${padrao.rotulo}: sem grupo tributário próprio, a devolução usa o grupo do produto (o mesmo CSOSN, `
        + 'pCredSN e CST de PIS/COFINS da venda/compra) — o contador confirma se é assim.',
    );
  }
  if (p.prazoCancelamentoMinutos === null && !padrao.devolucao) {
    pendencias.push(
      `${padrao.rotulo}: o prazo de cancelamento aceito pela UF não foi informado — o sistema não barra `
        + 'o pedido fora do prazo e a SEFAZ decide.',
    );
  }
  return pendencias;
}

/** Os parâmetros de uma operação desta empresa — os gravados, ou os padrões. */
export function lerOperacao(companyId: string, operacao: OperacaoFiscal): ParametrosDaOperacao {
  ensureCoreSchema();
  const padrao = PADRAO[operacao];
  const row = getConnection()
    .prepare('SELECT * FROM core_fiscal_operations WHERE company_id = ? AND operation = ?')
    .get(companyId, operacao) as Record<string, unknown> | undefined;
  const texto = (v: unknown): string | null => {
    const s = String(v ?? '').trim();
    return s || null;
  };
  const base = {
    operacao,
    rotulo: padrao.rotulo,
    direcao: padrao.direcao,
    natOp: texto(row?.nat_op) ?? padrao.natOp,
    cfopInterno: texto(row?.cfop_internal) ?? padrao.cfopInterno,
    cfopInterestadual: texto(row?.cfop_external) ?? padrao.cfopInterestadual,
    grupoTributario: texto(row?.tax_group_code),
    prazoCancelamentoMinutos:
      row?.cancel_deadline_minutes === null || row?.cancel_deadline_minutes === undefined
        ? null
        : Number(row.cancel_deadline_minutes),
    confirmadaPeloContador: Number(row?.confirmed_by_accountant ?? 0) === 1,
    origem: (row ? 'cadastro' : 'padrao') as 'cadastro' | 'padrao',
    observacao: texto(row?.note),
    atualizadoEm: (row?.updated_at as string | undefined) ?? null,
    atualizadoPor: (row?.updated_by as string | undefined) ?? null,
  };
  return { ...base, pendencias: pendenciasDa(base) };
}

export function listarOperacoes(companyId: string): ParametrosDaOperacao[] {
  return OPERACOES_FISCAIS.map((o) => lerOperacao(companyId, o));
}

/** A natureza da operação que vai no `<natOp>` — a gravada pela empresa, ou o padrão. */
export function natOpDaOperacao(companyId: string, operacao: OperacaoFiscal): string {
  return lerOperacao(companyId, operacao).natOp;
}

/** A operação fiscal de um documento que já existe — é dela o prazo de cancelamento. */
export function operacaoDoDocumento(doc: { model: string; originType?: string | null }): OperacaoFiscal {
  if (doc.originType === 'devolucao_venda' || doc.originType === 'devolucao_compra') return doc.originType;
  return doc.model === '65' ? 'venda_nfce' : 'venda_nfe';
}

function cfopDaOperacao(operacao: OperacaoFiscal, valor: unknown, alcance: 'interno' | 'interestadual'): string | null {
  const s = String(valor ?? '').replace(/\D/g, '');
  if (!s) return null;
  const padrao = PADRAO[operacao];
  const digito = padrao.digitos[alcance];
  if (s.length !== 4 || !s.startsWith(digito)) {
    throw new ApiError(
      'CORE_FISCAL_OPERATION_CFOP',
      `O CFOP ${alcance} de "${padrao.rotulo}" tem 4 dígitos e começa com ${digito}: "${String(valor)}" não serve.`,
      400,
    );
  }
  return s;
}

/**
 * Grava os parâmetros de uma operação — com trilha. O que o corpo não traz
 * continua como estava; `null` explícito volta ao padrão.
 */
export function gravarOperacao(input: {
  companyId: string;
  operacao: unknown;
  natOp?: unknown;
  cfopInterno?: unknown;
  cfopInterestadual?: unknown;
  grupoTributario?: unknown;
  prazoCancelamentoMinutos?: unknown;
  confirmadaPeloContador?: unknown;
  observacao?: unknown;
  userId?: string | null;
}): ParametrosDaOperacao {
  ensureCoreSchema();
  if (!ehOperacao(input.operacao)) {
    throw new ApiError(
      'CORE_FISCAL_OPERATION_INVALID',
      `Operação fiscal desconhecida. Valem: ${OPERACOES_FISCAIS.join(', ')}.`,
      400,
    );
  }
  const operacao = input.operacao;
  const padrao = PADRAO[operacao];
  const antes = lerOperacao(input.companyId, operacao);
  const db = getConnection();
  const atual = db
    .prepare('SELECT * FROM core_fiscal_operations WHERE company_id = ? AND operation = ?')
    .get(input.companyId, operacao) as Record<string, unknown> | undefined;
  const veio = (campo: keyof typeof input) => Object.prototype.hasOwnProperty.call(input, campo) && input[campo] !== undefined;

  let natOp = (atual?.nat_op as string | null | undefined) ?? null;
  if (veio('natOp')) {
    const s = input.natOp === null ? '' : String(input.natOp).trim();
    if (s.length > NAT_OP_MAX) {
      throw new ApiError('CORE_FISCAL_OPERATION_NATOP', `A natureza da operação tem até ${NAT_OP_MAX} caracteres.`, 400);
    }
    natOp = s || null;
  }

  let cfopInterno = (atual?.cfop_internal as string | null | undefined) ?? null;
  let cfopInterestadual = (atual?.cfop_external as string | null | undefined) ?? null;
  let grupo = (atual?.tax_group_code as string | null | undefined) ?? null;
  if (!padrao.devolucao && (veio('cfopInterno') || veio('cfopInterestadual') || veio('grupoTributario'))) {
    const informado = [input.cfopInterno, input.cfopInterestadual, input.grupoTributario].some(
      (v) => v !== null && String(v ?? '').trim() !== '',
    );
    if (informado) {
      throw new ApiError(
        'CORE_FISCAL_OPERATION_SALE_CFOP',
        'O CFOP e a tributação da VENDA moram no grupo tributário de cada produto (Catálogo › Grupos '
          + 'tributários) — uma segunda cópia aqui divergiria dele.',
        400,
      );
    }
  }
  if (padrao.devolucao) {
    if (veio('cfopInterno')) cfopInterno = cfopDaOperacao(operacao, input.cfopInterno, 'interno');
    if (veio('cfopInterestadual')) cfopInterestadual = cfopDaOperacao(operacao, input.cfopInterestadual, 'interestadual');
    if (veio('grupoTributario')) {
      const code = String(input.grupoTributario ?? '').trim().toUpperCase();
      if (code) {
        const existe = db
          .prepare('SELECT 1 FROM core_tax_groups WHERE company_id = ? AND code = ? AND active = 1')
          .get(input.companyId, code);
        if (!existe) {
          throw new ApiError(
            'CORE_FISCAL_OPERATION_TAX_GROUP',
            `O grupo tributário "${code}" não existe ou está inativo nesta operação.`,
            400,
          );
        }
      }
      grupo = code || null;
    }
  }

  let prazo = atual?.cancel_deadline_minutes === undefined || atual?.cancel_deadline_minutes === null
    ? null
    : Number(atual.cancel_deadline_minutes);
  if (veio('prazoCancelamentoMinutos')) {
    if (input.prazoCancelamentoMinutos === null || input.prazoCancelamentoMinutos === '') {
      prazo = null;
    } else {
      const n = Number(input.prazoCancelamentoMinutos);
      if (!Number.isInteger(n) || n < 1 || n > PRAZO_DE_CANCELAMENTO_MAXIMO_MIN) {
        throw new ApiError(
          'CORE_FISCAL_OPERATION_CANCEL_DEADLINE',
          `Informe o prazo de cancelamento em minutos inteiros (1 a ${PRAZO_DE_CANCELAMENTO_MAXIMO_MIN}) — `
            + 'o que a UF aceita, conforme o contador.',
          400,
        );
      }
      prazo = n;
    }
  }

  let confirmada = Number(atual?.confirmed_by_accountant ?? 0) === 1;
  if (veio('confirmadaPeloContador')) {
    if (typeof input.confirmadaPeloContador !== 'boolean') {
      throw new ApiError(
        'CORE_FISCAL_OPERATION_CONFIRMATION',
        'Informe confirmadaPeloContador como verdadeiro ou falso.',
        400,
      );
    }
    confirmada = input.confirmadaPeloContador;
  }

  let observacao = (atual?.note as string | null | undefined) ?? null;
  if (veio('observacao')) observacao = String(input.observacao ?? '').trim().slice(0, 500) || null;

  const agora = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_fiscal_operations
       (company_id, operation, nat_op, cfop_internal, cfop_external, tax_group_code,
        cancel_deadline_minutes, confirmed_by_accountant, note, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, operation) DO UPDATE SET
       nat_op = excluded.nat_op,
       cfop_internal = excluded.cfop_internal,
       cfop_external = excluded.cfop_external,
       tax_group_code = excluded.tax_group_code,
       cancel_deadline_minutes = excluded.cancel_deadline_minutes,
       confirmed_by_accountant = excluded.confirmed_by_accountant,
       note = excluded.note,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(
    input.companyId,
    operacao,
    natOp,
    cfopInterno,
    cfopInterestadual,
    grupo,
    prazo,
    confirmada ? 1 : 0,
    observacao,
    input.userId ?? null,
    agora,
  );

  const depois = lerOperacao(input.companyId, operacao);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.operation_updated',
    entityType: 'fiscal_config',
    entityId: `${input.companyId}:${operacao}`,
    detail: {
      operacao,
      antes: {
        natOp: antes.natOp,
        cfopInterno: antes.cfopInterno,
        cfopInterestadual: antes.cfopInterestadual,
        grupoTributario: antes.grupoTributario,
        prazoCancelamentoMinutos: antes.prazoCancelamentoMinutos,
        confirmadaPeloContador: antes.confirmadaPeloContador,
      },
      depois: {
        natOp: depois.natOp,
        cfopInterno: depois.cfopInterno,
        cfopInterestadual: depois.cfopInterestadual,
        grupoTributario: depois.grupoTributario,
        prazoCancelamentoMinutos: depois.prazoCancelamentoMinutos,
        confirmadaPeloContador: depois.confirmadaPeloContador,
      },
    },
  });
  return depois;
}

/**
 * A devolução em PRODUÇÃO exige a operação confirmada pelo contador.
 *
 * Em homologação ela sai com a pendência declarada — é para isso que a
 * homologação existe: o contador confere a nota de ensaio antes de confirmar.
 */
export function exigirOperacaoConfirmadaEmProducao(
  companyId: string,
  operacao: OperacaoFiscal,
  environment: string,
): void {
  if (environment !== 'production') return;
  const p = lerOperacao(companyId, operacao);
  if (p.confirmadaPeloContador) return;
  throw new ApiError(
    'CORE_FISCAL_OPERATION_NOT_CONFIRMED',
    `${p.rotulo}: em produção esta nota só sai com a operação confirmada pelo contador (natureza, CFOP e `
      + 'tributação). Confirme em Fiscal › Operações fiscais depois de o contador conferir.',
    409,
    { operacao, pendencias: p.pendencias },
  );
}
