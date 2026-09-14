/**
 * AS TABELAS DO ICMS DO LEIAUTE — o que este sistema monta, o que recusa, e
 * por quê (GAP-PRD-021).
 *
 * Moram num módulo sem dependências porque três lados precisam da MESMA
 * resposta: o cadastro do grupo (que recusa código fora da tabela no momento
 * em que ele é escrito), a tributação do item (que monta o grupo do XML) e o
 * checklist (que avisa antes da venda). Uma lista por lado divergiria no
 * primeiro código novo — e a divergência apareceria com o cliente no caixa.
 *
 * ## A fronteira do que sai
 *
 * Sai tudo o que é imposto POR DENTRO — o que já está no preço da etiqueta e
 * não mexe no total que o cliente paga:
 *
 *  - Simples: 101, 102, 103, 300, 400, 500 (ST já recolhida pelo fornecedor —
 *    o varejo de autopeças e de cosméticos) e 900;
 *  - regime normal: 00, 20 (com redução de base), 40, 41, 50, 60 (ST já
 *    recolhida) e 90.
 *
 * O que NÃO sai é a substituição tributária CALCULADA POR ESTA EMPRESA (CSOSN
 * 201/202/203, CST 10/30/70). O ICMS-ST é cobrado POR FORA: o leiaute o soma
 * ao `vNF`, e a venda do balcão tem o total fechado no preço da etiqueta — a
 * nota deixaria de bater com os pagamentos. É a mesma razão do IPI destacado,
 * e a recusa a diz por extenso. Varejo é SUBSTITUÍDO (500/60), não substituto.
 *
 * Também não saem o monofásico de combustíveis (02, 15, 53, 61) e o
 * diferimento (51): o primeiro é de outro ramo; o segundo exige percentual e
 * valor diferidos que o cadastro não descreve.
 */

/** Os CSOSN que a emissão monta. */
export const CSOSN_EMITIDOS: ReadonlySet<string> = new Set([
  '101', '102', '103', '300', '400', '500', '900',
]);

/** Os CSOSN com ST calculada pelo emitente — cobrada por fora, recusada com a razão. */
export const CSOSN_ST_POR_FORA: ReadonlySet<string> = new Set(['201', '202', '203']);

/** A tabela inteira do leiaute: o que o cadastro aceita gravar. */
export const CSOSN_DA_TABELA: ReadonlySet<string> = new Set([
  ...CSOSN_EMITIDOS,
  ...CSOSN_ST_POR_FORA,
]);

/** Os CST de ICMS (regime normal) que a emissão monta. */
export const CST_ICMS_EMITIDOS: ReadonlySet<string> = new Set([
  '00', '20', '40', '41', '50', '60', '90',
]);

/** Os CST de ICMS com ST calculada pelo emitente — cobrada por fora. */
export const CST_ICMS_ST_POR_FORA: ReadonlySet<string> = new Set(['10', '30', '70']);

/** Monofásico de combustíveis e diferimento: fora do ramo e do cadastro. */
export const CST_ICMS_FORA_DO_VAREJO: ReadonlySet<string> = new Set([
  '02', '15', '51', '53', '61',
]);

/** A tabela inteira do leiaute: o que o cadastro aceita gravar. */
export const CST_ICMS_DA_TABELA: ReadonlySet<string> = new Set([
  ...CST_ICMS_EMITIDOS,
  ...CST_ICMS_ST_POR_FORA,
  ...CST_ICMS_FORA_DO_VAREJO,
]);

/**
 * Os CST que destacam ICMS PRÓPRIO — e, por isso, os únicos em que a alíquota
 * de ICMS do grupo é lida. 00 e 20 a exigem; no 90 ela é opcional.
 */
export const CST_ICMS_COM_ALIQUOTA: ReadonlySet<string> = new Set(['00', '20', '90']);
export const CST_ICMS_ALIQUOTA_OBRIGATORIA: ReadonlySet<string> = new Set(['00', '20']);

/** Os CST em que a redução de base se aplica: obrigatória no 20, opcional no 90. */
export const CST_ICMS_COM_REDUCAO: ReadonlySet<string> = new Set(['20', '90']);

/**
 * Os quatro CRT do leiaute 4.00: 1 Simples, 2 Simples com excesso de
 * sublimite, 3 regime normal, 4 MEI. Os três do Simples tributam pelo CSOSN.
 */
export const CRTS_DO_LEIAUTE: readonly string[] = ['1', '2', '3', '4'];
export const CRTS_DO_SIMPLES: ReadonlySet<string> = new Set(['1', '2', '4']);

/** O formato do cBenef no leiaute: 8 ou 10 caracteres, ou o literal "SEM CBENEF". */
export const FORMATO_DO_CBENEF = /^(?:[!-ÿ]{8}|[!-ÿ]{10}|SEM CBENEF)$/;

/**
 * Um percentual no formato do leiaute (`TDec_0302a04`): de 2 a 4 casas.
 *
 * 17 vira "17.00"; 41,1765 continua "41.1765". Cortar em duas casas mudaria a
 * base de quem o contador informou com quatro — e a base errada é imposto
 * errado.
 */
export function percentualDoLeiaute(valor: number): string {
  return valor.toFixed(4).replace(/0{1,2}$/, '');
}

/** O nome de cada CST de ICMS, para a recusa dizer do que se trata. */
export const NOME_DO_CST_ICMS: Readonly<Record<string, string>> = {
  '00': 'tributada integralmente',
  '02': 'monofásico próprio de combustíveis',
  '10': 'tributada e com cobrança de ICMS por substituição tributária',
  '15': 'monofásico próprio e com responsabilidade pela retenção sobre combustíveis',
  '20': 'com redução de base de cálculo',
  '30': 'isenta ou não tributada e com cobrança de ICMS por substituição tributária',
  '40': 'isenta',
  '41': 'não tributada',
  '50': 'suspensão',
  '51': 'diferimento',
  '53': 'monofásico sobre combustíveis com recolhimento diferido',
  '60': 'ICMS cobrado anteriormente por substituição tributária',
  '61': 'monofásico sobre combustíveis cobrado anteriormente',
  '70': 'com redução de base de cálculo e cobrança de ICMS por substituição tributária',
  '90': 'outras',
};
