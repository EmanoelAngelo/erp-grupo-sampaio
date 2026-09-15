/**
 * A TRIBUTAÇÃO DE UM ITEM — resolvida pela configuração da operação.
 *
 * ============================================================================
 * POR QUE ISTO EXISTE
 * ============================================================================
 *
 * Os dois montadores de XML escreviam, para todo item de toda empresa:
 *
 *     <ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
 *
 * O comentário logo acima dizia — corretamente — que "os valores de CSOSN/CST
 * NÃO são inferidos aqui: entram pelo perfil tributário quando ele existir". O
 * perfil existe desde sempre: `core_tax_groups` guarda, por empresa, regime,
 * CSOSN, CST de ICMS, CST de PIS e de COFINS, CFOP interno e interestadual,
 * origem, NCM e CEST — e `core_products.tax_profile` liga cada produto ao
 * grupo pelo código.
 *
 * Só o CRUD lia essa tabela. Na hora de emitir, ninguém perguntava. Empresa do
 * Simples com CSOSN 101 emitia 102 — outro imposto, outra apuração, com a nota
 * já autorizada; e empresa fora do Simples emitia um grupo estruturalmente
 * errado.
 *
 * ============================================================================
 * O QUE ESTE MÓDULO RECUSA, E POR QUÊ
 * ============================================================================
 *
 * Ele nunca inventa. Quando falta um dado fiscal, a recusa diz **o nome do
 * dado e o nome do produto**, para o pedido ao contador sair de uma vez:
 *
 *   - produto sem perfil e empresa sem grupo → não há o que aplicar;
 *   - produto sem perfil e empresa com dois grupos → escolher seria adivinhar;
 *   - CSOSN 101 sem alíquota de crédito → o layout exige `pCredSN`, e
 *     inventar a alíquota é inventar imposto;
 *   - regime normal sem CST de ICMS → CSOSN não vale para quem não é Simples;
 *   - CST 00 ou 20 sem alíquota de ICMS, e CST 20 sem o percentual de redução
 *     → o destaque sairia sem quanto (GAP-PRD-021);
 *   - substituição tributária CALCULADA POR ESTA EMPRESA (CSOSN 201/202/203,
 *     CST 10/30/70) → o ICMS-ST é cobrado por fora e o total da nota deixaria
 *     de bater com o que o cliente pagou (a razão está em `TabelasDoIcms`);
 *   - grupo sem CST de PIS/COFINS → os dois grupos são obrigatórios no layout;
 *   - CST de PIS/COFINS tributado sem alíquota cadastrada → o destaque sairia
 *     zerado, que é a doença "cadastro com escritor e sem leitor";
 *   - CST de PIS/COFINS por UNIDADE DE MEDIDA → o cadastro guarda percentual,
 *     e reais por unidade é outra grandeza;
 *   - CST de PIS/COFINS de ENTRADA num grupo de saída → cadastro errado que a
 *     SEFAZ só rejeitaria meses depois.
 *
 * Um grupo ativo só, por outro lado, **não** é adivinhação: é a operação
 * declarando "é assim que eu tributo". Ele vale como padrão de quem não tem
 * perfil próprio, e o resultado diz de qual grupo veio.
 *
 * ============================================================================
 * UMA RÉGUA, DOIS JEITOS DE LER (GAP-PRD-095)
 * ============================================================================
 *
 * A emissão recusa na PRIMEIRA falta — é o que ela precisa. O checklist precisa
 * de TODAS de uma vez: o contador recebe a lista do que falta no grupo, e não
 * uma falta por reunião. As duas leituras passam pela MESMA função
 * (`avaliar`), com um "juiz" diferente: um que recusa, outro que anota. Não há
 * segunda cópia das regras para envelhecer longe desta.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { CST_IPI_COM_VALOR } from './CatalogAuxService.js';
import {
  CRTS_DO_SIMPLES,
  CSOSN_EMITIDOS,
  CSOSN_ST_POR_FORA,
  CST_ICMS_ALIQUOTA_OBRIGATORIA,
  CST_ICMS_COM_ALIQUOTA,
  CST_ICMS_EMITIDOS,
  CST_ICMS_ST_POR_FORA,
  NOME_DO_CST_ICMS,
  percentualDoLeiaute,
} from './TabelasDoIcms.js';
// UF_CODE é lido só dentro das funções: o ciclo com FiscalXmlNfce (que importa
// este módulo) não o toca durante a carga.
import { UF_CODE, type NfceSale } from './FiscalXmlNfce.js';

/**
 * ============================================================================
 * O CFOP TEM DE BATER COM O DESTINO DA NOTA (P0 fiscal — Preço Justo)
 * ============================================================================
 *
 * O primeiro dígito do CFOP diz o alcance da operação: 5 interna, 6
 * interestadual, 7 exterior (saídas); 1, 2 e 3 nas entradas. O `idDest` do XML
 * diz a mesma coisa pela UF do destinatário — e a SEFAZ recusa a nota em que os
 * dois discordam.
 *
 * O defeito: o CFOP do PRODUTO vencia o do grupo sem olhar o destino. Um
 * cadastro com 5102 no produto (o CFOP interno do grupo, copiado para o
 * produto) fazia a NF-e para outra UF — a do pedido online entregue em Santa
 * Catarina, a do cliente atacadista de Curitiba — sair com 5102 e idDest 2. O
 * grupo tinha o 6102 que o contador informou, e ninguém o lia; e o XML
 * escrevia `item.cfop`, não o CFOP que a tributação resolveu.
 *
 * A regra agora:
 *  - o CFOP do produto vale quando o alcance dele é o da nota;
 *  - quando não é e ele é só o CFOP do grupo do outro alcance (o 5102 do
 *    grupo copiado no produto), vale o do grupo para ESTE alcance (6102);
 *  - quando não é e ele é uma EXCEÇÃO do produto (um 5405, por exemplo), o
 *    sistema não adivinha o equivalente interestadual: recusa, nomeando os
 *    dois, antes de numerar — é pendência para o contador.
 */
export type DirecaoDaNota = 'saida' | 'entrada';

/** O primeiro dígito que o CFOP precisa ter para o destino e a direção da nota. */
export function digitoDoCfopEsperado(
  ufEmitente: string | null | undefined,
  ufDestino: string | null | undefined,
  direcao: DirecaoDaNota = 'saida',
): '1' | '2' | '3' | '5' | '6' | '7' {
  const emitente = String(ufEmitente ?? '').trim().toUpperCase();
  const destino = String(ufDestino ?? '').trim().toUpperCase();
  const alcance = !destino || destino === emitente ? 'interno' : UF_CODE[destino] ? 'interestadual' : 'exterior';
  if (direcao === 'entrada') return alcance === 'interno' ? '1' : alcance === 'interestadual' ? '2' : '3';
  return alcance === 'interno' ? '5' : alcance === 'interestadual' ? '6' : '7';
}

const ALCANCE_DO_DIGITO: Record<string, string> = {
  '1': 'entrada interna',
  '2': 'entrada interestadual',
  '3': 'entrada do exterior',
  '5': 'saída interna',
  '6': 'saída interestadual',
  '7': 'saída para o exterior',
};

/** O alcance que o CFOP declara, por extenso — para a recusa nomear. */
export function alcanceDoCfop(cfop: string): string {
  return ALCANCE_DO_DIGITO[String(cfop).trim().charAt(0)] ?? 'alcance desconhecido';
}

/**
 * O CFOP da linha para o alcance da nota — sem recusar nada (quem chama decide).
 *
 * `daOperacao` é o CFOP que a OPERAÇÃO declara (devolução, por exemplo) e vence
 * produto e grupo: numa devolução o CFOP é o da devolução, não o da venda.
 */
export function escolherCfop(input: {
  esperado: string;
  doProduto: string | null | undefined;
  grupoInterno: string | null | undefined;
  grupoExterno: string | null | undefined;
  daOperacao?: string | null;
}): string {
  const limpo = (v: string | null | undefined) => String(v ?? '').trim();
  const daOperacao = limpo(input.daOperacao);
  if (daOperacao) return daOperacao;
  const interno = limpo(input.grupoInterno);
  const externo = limpo(input.grupoExterno);
  const doGrupo = input.esperado === '5' || input.esperado === '1' ? interno : externo;
  const doProduto = limpo(input.doProduto);
  if (!doProduto) return doGrupo;
  if (doProduto.startsWith(input.esperado)) return doProduto;
  // O produto só repete o CFOP do grupo do OUTRO alcance: vale o do grupo para este.
  if (doGrupo && (doProduto === interno || doProduto === externo)) return doGrupo;
  // Exceção do produto em outro alcance: devolve como está, e a régua recusa.
  return doProduto;
}

/**
 * ============================================================================
 * O CST DE PIS/COFINS DECIDE O GRUPO DO LAYOUT — e a lista é TOTAL
 * ============================================================================
 *
 * Aqui morava um conjunto escrito à mão com seis códigos (`CST_SEM_VALOR`) e
 * um `else` que mandava TODO O RESTO para `<PISOutr>` com três zeros cravados.
 * Duas coisas quebravam nesse `else`:
 *
 *  - CST 01 e 02 são TRIBUTADOS por alíquota e pertencem a `<PISAliq>`. Saíam
 *    em `<PISOutr>` — grupo errado do layout — e com `pPIS` zero, enquanto
 *    `core_tax_rates` guardava a alíquota que o contador cadastrou;
 *  - CST 03 é tributado por UNIDADE DE MEDIDA (reais por unidade) e pertence a
 *    `<PISQtde>`. Saía como percentual zero, calado.
 *
 * Esta relação é um `Record` TOTAL sobre o união dos CST, e não mais um
 * conjunto por complemento: um código novo na tabela do layout quebra a
 * COMPILAÇÃO deste arquivo em vez de cair silenciosamente em "outras".
 *
 * As quatro formas são as quatro do layout, mais `entrada`: os CST de 50 a 67
 * são de APURAÇÃO DE CRÉDITO na entrada, e uma nota de SAÍDA que os declara é
 * cadastro errado que a SEFAZ só rejeitaria meses depois.
 */
type FormaDoCst = 'aliquota' | 'por_quantidade' | 'sem_valor' | 'outras' | 'entrada';

type CstPisCofins =
  | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09'
  | '49'
  | '50' | '51' | '52' | '53' | '54' | '55' | '56'
  | '60' | '61' | '62' | '63' | '64' | '65' | '66' | '67'
  | '70' | '71' | '72' | '73' | '74' | '75'
  | '98' | '99';

const FORMA_DO_CST: Record<CstPisCofins, FormaDoCst> = {
  // Tributadas por alíquota — as que exigem a alíquota do cadastro.
  '01': 'aliquota',
  '02': 'aliquota',
  // Tributada por unidade de medida: reais por unidade, e não percentual.
  '03': 'por_quantidade',
  // Monofásica revenda a zero, ST, alíquota zero, isenta, sem incidência,
  // suspensão: o grupo do layout leva só o código.
  '04': 'sem_valor',
  '05': 'sem_valor',
  '06': 'sem_valor',
  '07': 'sem_valor',
  '08': 'sem_valor',
  '09': 'sem_valor',
  // Outras operações de SAÍDA — o cadastro do Simples desta casa.
  '49': 'outras',
  // 50 a 67: crédito na ENTRADA. Não existem em nota de saída.
  '50': 'entrada',
  '51': 'entrada',
  '52': 'entrada',
  '53': 'entrada',
  '54': 'entrada',
  '55': 'entrada',
  '56': 'entrada',
  '60': 'entrada',
  '61': 'entrada',
  '62': 'entrada',
  '63': 'entrada',
  '64': 'entrada',
  '65': 'entrada',
  '66': 'entrada',
  '67': 'entrada',
  // 70 a 99: outras operações, sem destaque próprio.
  '70': 'outras',
  '71': 'outras',
  '72': 'outras',
  '73': 'outras',
  '74': 'outras',
  '75': 'outras',
  '98': 'outras',
  '99': 'outras',
};

export interface ProdutoParaTributar {
  id: string;
  description: string;
  taxProfile?: string | null;
  origin?: string | null;
  cfop?: string | null;
  ncm?: string | null;
  cest?: string | null;
  /** Base do crédito do Simples, em centavos. */
  totalCents: number;
}

/**
 * O ICMS PRÓPRIO do regime normal (GAP-PRD-021): o que os CST 00, 20 e 90
 * destacam. Por dentro — já está no preço, e o `vNF` não se move.
 */
export interface IcmsProprio {
  /**
   * Modalidade da base: SEMPRE 3, valor da operação. É a base do ICMS próprio
   * numa venda (LC 87/96, art. 13, I). Pauta, preço tabelado e margem são de
   * regimes específicos e da ST — o cadastro não os descreve, e oferecê-los
   * seria convidar a escolher uma base que o sistema não calcula.
   */
  modBC: '3';
  vBcCents: number;
  /** Percentual de redução da base (CST 20; opcional no 90). */
  pRedBc: string | null;
  pIcms: string;
  vIcmsCents: number;
  /** Fundo de combate à pobreza, quando o grupo o declara. */
  pFcp: string | null;
  vFcpCents: number;
}

export interface TributacaoDoItem {
  /** O código do grupo de onde tudo isto veio — vai para a auditoria. */
  origemDoGrupo: string;
  regime: string;
  origin: string;
  cfop: string;
  ncm: string | null;
  cest: string | null;
  /** Simples: preenchido. Regime normal: nulo. */
  csosn: string | null;
  /** Regime normal: preenchido. Simples: nulo. */
  cstIcms: string | null;
  /** Percentual de crédito do Simples, como texto ("2.50"). */
  pCredSn: string | null;
  /** O crédito calculado sobre o total do item, em centavos. */
  vCredIcmsSnCents: number;
  /**
   * O ICMS próprio destacado (CST 00, 20 e 90 com alíquota). Nulo em todo o
   * resto — Simples, isenta, ST já recolhida.
   */
  icms: IcmsProprio | null;
  /** Código de benefício fiscal da UF, quando o grupo o declara. */
  cBenef: string | null;
  cstPis: string;
  cstCofins: string;
  /**
   * Percentual de PIS, como texto ("1.65"). Nulo quando o CST não destaca.
   *
   * Vem de `core_tax_rates` com `kind = 'pis'` — a mesma tabela que a tela de
   * Catálogo › Alíquotas escreve e que, até esta rodada, ninguém lia na hora
   * de emitir.
   */
  pPis: string | null;
  /** Base de cálculo do PIS, em centavos. Zero quando não há destaque. */
  bcPisCents: number;
  /** O PIS calculado sobre a base, em centavos inteiros. */
  vPisCents: number;
  /** Percentual de COFINS, como texto ("7.60"). Nulo quando o CST não destaca. */
  pCofins: string | null;
  /** Base de cálculo da COFINS, em centavos. */
  bcCofinsCents: number;
  /** A COFINS calculada sobre a base, em centavos inteiros. */
  vCofinsCents: number;
  /**
   * CST do IPI, quando a operação declara IPI no grupo (GAP-V08).
   *
   * NULO é a resposta de quase todo mundo, e é a verdade do varejo do Simples:
   * quem não industrializa não destaca IPI, e o item sai sem bloco `<IPI>` —
   * exatamente como saía antes desta rodada.
   */
  cstIpi: string | null;
  /** Percentual da alíquota de IPI, como texto ("5.00"). Nulo sem destaque. */
  pIpi: string | null;
  /** O IPI calculado sobre o total do item, em centavos inteiros. */
  vIpiCents: number;
}

interface Grupo {
  code: string;
  regime: string;
  ncm: string | null;
  cest: string | null;
  cfop_internal: string | null;
  cfop_external: string | null;
  origin: string | null;
  cst_icms: string | null;
  csosn: string | null;
  p_cred_sn: string | null;
  cst_pis: string | null;
  cst_cofins: string | null;
  cst_ipi: string | null;
  ipi_rate_code: string | null;
  icms_rate_code: string | null;
  p_red_bc: string | null;
  fcp_rate_code: string | null;
  c_benef: string | null;
}

type Db = ReturnType<typeof getConnection>;

function faltou(produto: ProdutoParaTributar, oQue: string, ondeResolver: string): never {
  throw new ApiError(
    'CORE_FISCAL_TRIBUTACAO_INCOMPLETA',
    `${produto.description}: ${oQue}. ${ondeResolver}`,
    400,
    { productId: produto.id, campo: oQue },
  );
}

// ============================================================================
// O juiz: quem decide o que acontece com uma falta
// ============================================================================

/**
 * A NATUREZA DA FALTA.
 *
 * `classificacao` é o que descreve a MERCADORIA (CFOP e origem): o checklist
 * já os conta nos itens de catálogo, e a validação da nota os cobra item a
 * item. `tributacao` é a regra do GRUPO — o que o item de tributação do
 * checklist existe para mostrar.
 */
export type TipoDaFalta = 'tributacao' | 'classificacao';

export interface FaltaDeTributacao {
  tipo: TipoDaFalta;
  /** O que falta, sem o nome do produto — para agrupar por grupo. */
  oQue: string;
  /** Onde se resolve. */
  onde: string;
}

/** Interrompe o diagnóstico quando continuar não faz sentido (sem grupo, nada a conferir). */
class ParadaDoDiagnostico extends Error {}

interface Juiz {
  /** Uma falta depois da qual ainda dá para conferir o resto. */
  falha(oQue: string, onde: string, tipo?: TipoDaFalta): void;
  /** Uma falta depois da qual não há o que conferir. */
  pare(oQue: string, onde: string): never;
}

/** A emissão: a primeira falta recusa, com a frase de sempre. */
function juizQueRecusa(produto: ProdutoParaTributar): Juiz {
  return {
    falha: (oQue, onde) => faltou(produto, oQue, onde),
    pare: (oQue, onde) => faltou(produto, oQue, onde),
  };
}

/** O checklist: anota todas, e só para quando não há mais o que olhar. */
function juizQueAnota(faltas: FaltaDeTributacao[]): Juiz {
  return {
    falha: (oQue, onde, tipo = 'tributacao') => {
      faltas.push({ tipo, oQue, onde });
    },
    pare: (oQue, onde) => {
      faltas.push({ tipo: 'tributacao', oQue, onde });
      throw new ParadaDoDiagnostico();
    },
  };
}

const SEM_DESTAQUE = { percentual: null, bcCents: 0, valorCents: 0 } as const;

/**
 * O DESTAQUE DE UMA CONTRIBUIÇÃO (PIS ou COFINS), a partir do CST do grupo.
 *
 * ## Por que a alíquota vem da OPERAÇÃO, e não de uma coluna do grupo
 *
 * PIS e COFINS não têm alíquota por produto: a alíquota é do REGIME de quem
 * emite — 0,65% e 3% no cumulativo, 1,65% e 7,6% no não-cumulativo. É uma
 * propriedade da empresa, não do grupo tributário, e é por isso que ela é lida
 * de `core_tax_rates` por `kind` em vez de exigir uma coluna nova no grupo (o
 * caminho que o IPI tomou, porque o IPI VARIA por NCM e precisa dessa coluna).
 *
 * Uma alíquota ativa do tipo é a operação declarando "é assim que eu tributo"
 * — a mesma leitura que este módulo já faz com o grupo único, e pelo mesmo
 * motivo. DUAS é ambiguidade, e escolher seria adivinhar imposto: a recusa
 * nomeia as duas para o contador saber qual desativar.
 */
function destaqueDaContribuicao(
  db: Db,
  input: {
    companyId: string;
    produto: ProdutoParaTributar;
    grupo: Grupo;
    contribuicao: 'pis' | 'cofins';
    cst: string;
    juiz: Juiz;
  },
): { percentual: string | null; bcCents: number; valorCents: number } {
  const { produto, grupo, cst, juiz } = input;
  const nome = input.contribuicao === 'pis' ? 'PIS' : 'COFINS';
  const forma: FormaDoCst | undefined = FORMA_DO_CST[cst as CstPisCofins];

  if (!forma) {
    juiz.falha(
      `o grupo ${grupo.code} declara CST de ${nome} "${cst}", que não existe na tabela do `
        + 'layout — nenhum grupo do XML o aceita',
      'Corrija em Catálogo › Grupos tributários: na saída valem 01 a 09, 49 e 70 a 99.',
    );
    return SEM_DESTAQUE;
  }

  switch (forma) {
    case 'entrada':
      /*
        Os CST de 50 a 67 são de APURAÇÃO DE CRÉDITO na entrada. Gravados num
        grupo de saída, só apareceriam como rejeição da SEFAZ meses depois,
        com as vendas já feitas — a mesma recusa que o CST de IPI de entrada já
        leva, e pelo mesmo motivo.
      */
      juiz.falha(
        `o grupo ${grupo.code} declara CST de ${nome} ${cst}, que é de entrada (apuração de `
          + 'crédito) — esta é uma nota de saída',
        'Corrija em Catálogo › Grupos tributários: na saída valem 01 a 09, 49 e 70 a 99.',
      );
      return SEM_DESTAQUE;

    case 'por_quantidade':
      /*
        E AQUI O SISTEMA PARA, PELA MESMA RAZÃO QUE PAROU NO IPI.

        CST 03 é tributação por unidade de medida: o layout pede `qBCProd` (a
        quantidade) e `vAliqProd` (REAIS por unidade). O cadastro de alíquotas
        guarda percentual — um número de outra grandeza. Emitir o percentual no
        lugar dos reais produziria um `vPIS` que não se explica por nenhuma
        base declarada, e a apuração do mês não fecharia.

        Recusar é melhor que emitir errado: a recusa custa uma configuração; o
        número inventado custa uma retificação com a nota já autorizada.
      */
      juiz.falha(
        `o grupo ${grupo.code} declara CST de ${nome} ${cst}, que é tributado por unidade de `
          + 'medida (reais por unidade vendida), e o cadastro de alíquotas guarda percentual',
        'Use um CST por alíquota (01 ou 02) no grupo, ou emita esta nota fora do sistema '
          + 'enquanto a alíquota por unidade não existir no cadastro.',
      );
      return SEM_DESTAQUE;

    case 'aliquota': {
      const ativas = db
        .prepare(
          `SELECT code, percent FROM core_tax_rates
            WHERE company_id = ? AND kind = ? AND active = 1
            ORDER BY code`,
        )
        .all(input.companyId, input.contribuicao) as unknown as {
          code: string;
          percent: number;
        }[];

      if (ativas.length === 0) {
        juiz.falha(
          `o CST de ${nome} ${cst} é tributado e esta operação não tem alíquota de ${nome} `
            + 'ativa (ela pode nunca ter sido cadastrada, ou ter sido desativada depois)',
          `Cadastre a alíquota em Catálogo › Alíquotas com o tipo "${input.contribuicao}".`,
        );
        return SEM_DESTAQUE;
      }
      if (ativas.length > 1) {
        juiz.falha(
          `esta operação tem ${ativas.length} alíquotas de ${nome} ativas `
            + `(${ativas.map((a) => a.code).join(', ')}), e escolher uma seria adivinhar imposto`,
          `${nome} tem UMA alíquota por regime: deixe ativa só a que vale, em `
            + 'Catálogo › Alíquotas.',
        );
        return SEM_DESTAQUE;
      }

      const percentual = Number(ativas[0].percent).toFixed(2);
      const bcCents = produto.totalCents;
      /*
        Centavo inteiro, arredondado por ITEM — a mesma decisão do crédito do
        Simples e do IPI, e pelo mesmo motivo: a soma dos itens tem de conferir
        contra o total, que é o que a SEFAZ valida.
      */
      return {
        percentual,
        bcCents,
        valorCents: Math.round((bcCents * Number(percentual)) / 100),
      };
    }

    case 'sem_valor':
    case 'outras':
      /*
        O ZERO DAQUI É DECLARAÇÃO, E NÃO LITERAL ESQUECIDO.

        `sem_valor` (04 a 09) é alíquota zero, isenta, sem incidência, ST ou
        suspensão: o grupo do layout leva só o código. `outras` (49 e 70 a 99)
        é o cadastro real de todo mundo neste grupo — quem paga PIS e COFINS
        dentro do DAS do Simples não destaca contribuição nenhuma na nota.
      */
      return SEM_DESTAQUE;
  }

  // Inalcançável: todo `case` devolve. Existe para o compilador provar a totalidade.
  throw new Error(`forma de CST não tratada: ${forma}`);
}

/**
 * A ST QUE ESTA EMPRESA CALCULARIA — cobrada por fora, e por isso recusada.
 *
 * A frase antiga ("envolve substituição tributária, que o cadastro ainda não
 * descreve") mandava falar com o contador sobre um cadastro que nenhum
 * contador consegue preencher: o que falta não é campo, é a venda saber cobrar
 * imposto por fora. E ela valia também para o CSOSN 500, que não tem nada a
 * cobrar — o que travava justamente o caso comum do varejo.
 */
function stPorFora(codigo: string, grupo: Grupo): [string, string] {
  return [
    `${codigo} do grupo ${grupo.code} é substituição tributária CALCULADA POR ESTA EMPRESA: o `
      + 'ICMS-ST é cobrado por fora, somaria ao total da nota, e ela deixaria de bater com o que o '
      + 'cliente pagou',
    'Se o fornecedor já recolheu a ST (o caso do varejo), o código certo é o CSOSN 500 ou o CST '
      + '60, que este sistema emite. Se esta empresa é a substituta, emita estas notas fora do '
      + 'sistema enquanto a cobrança por fora não existir.',
  ];
}

/**
 * O ICMS PRÓPRIO dos CST 00, 20 e 90 (GAP-PRD-021).
 *
 * A alíquota vem do CADASTRO (`core_tax_rates`, kind 'icms'), ligada ao grupo
 * pelo código — o mesmo desenho do IPI, e pelo mesmo motivo: o ICMS varia por
 * mercadoria (17%, 12%, 25%...), então mora no grupo, e não na empresa.
 *
 * Tudo arredondado ao centavo POR ITEM, antes da formatação: a soma dos itens
 * é o que o `<ICMSTot>` declara, e é essa soma que a SEFAZ confere.
 */
function icmsProprio(
  db: Db,
  companyId: string,
  grupo: Grupo,
  cst: string,
  produto: ProdutoParaTributar,
  juiz: Juiz,
): IcmsProprio | null {
  const codigo = String(grupo.icms_rate_code ?? '').trim().toUpperCase();
  if (!codigo) {
    if (CST_ICMS_ALIQUOTA_OBRIGATORIA.has(cst)) {
      juiz.falha(
        `o CST de ICMS ${cst} (${NOME_DO_CST_ICMS[cst]}) destaca ICMS, e o grupo ${grupo.code} `
          + 'não tem alíquota de ICMS',
        'Cadastre a alíquota em Catálogo › Alíquotas com o tipo "icms" e escolha-a no grupo — '
          + 'o percentual é o contador quem informa.',
      );
    }
    // CST 90 sem alíquota: a declaração sai só com origem e CST.
    return null;
  }

  const aliquota = db
    .prepare(
      `SELECT percent FROM core_tax_rates
        WHERE company_id = ? AND code = ? AND kind = 'icms' AND active = 1`,
    )
    .get(companyId, codigo) as { percent?: number } | undefined;
  if (aliquota?.percent == null) {
    juiz.falha(
      `o grupo ${grupo.code} usa a alíquota de ICMS ${codigo}, que não existe ou foi desativada `
        + 'nesta operação',
      'Cadastre (ou reative) a alíquota em Catálogo › Alíquotas com o tipo "icms".',
    );
    return null;
  }

  const reducao = String(grupo.p_red_bc ?? '').trim();
  let pRedBc: string | null = null;
  if (reducao) {
    const n = Number(reducao);
    if (!(n > 0 && n < 100)) {
      juiz.falha(
        `o percentual de redução da base do grupo ${grupo.code} ("${reducao}") não está entre 0 e 100`,
        'Corrija em Catálogo › Grupos tributários.',
      );
      return null;
    }
    pRedBc = percentualDoLeiaute(n);
  } else if (cst === '20') {
    juiz.falha(
      `o CST de ICMS 20 é "com redução de base de cálculo", e o grupo ${grupo.code} não tem o `
        + 'percentual de redução',
      'Peça o percentual ao contador e preencha em Catálogo › Grupos tributários.',
    );
    return null;
  }

  const pIcms = percentualDoLeiaute(Number(aliquota.percent));
  const vBcCents = pRedBc
    ? Math.round((produto.totalCents * (100 - Number(pRedBc))) / 100)
    : produto.totalCents;
  const vIcmsCents = Math.round((vBcCents * Number(pIcms)) / 100);

  let pFcp: string | null = null;
  let vFcpCents = 0;
  const codigoFcp = String(grupo.fcp_rate_code ?? '').trim().toUpperCase();
  if (codigoFcp) {
    const fcp = db
      .prepare(
        `SELECT percent FROM core_tax_rates
          WHERE company_id = ? AND code = ? AND kind = 'fcp' AND active = 1`,
      )
      .get(companyId, codigoFcp) as { percent?: number } | undefined;
    if (fcp?.percent == null) {
      juiz.falha(
        `o grupo ${grupo.code} usa a alíquota de FCP ${codigoFcp}, que não existe ou foi `
          + 'desativada nesta operação',
        'Cadastre (ou reative) a alíquota em Catálogo › Alíquotas com o tipo "fcp".',
      );
    } else {
      pFcp = percentualDoLeiaute(Number(fcp.percent));
      vFcpCents = Math.round((vBcCents * Number(pFcp)) / 100);
    }
  }

  return { modBC: '3', vBcCents, pRedBc, pIcms, vIcmsCents, pFcp, vFcpCents };
}

// ============================================================================
// O grupo do produto
// ============================================================================

type Achado = { grupo: Grupo } | { oQue: string; onde: string };

/**
 * O grupo que vale para o produto — sem recusar nada: quem chama decide.
 *
 * O `tax_profile` é um CÓDIGO, e código se repete entre empresas. Buscar o
 * grupo sem o `company_id` faria a nota do Preço Justo sair com a tributação
 * da Gringa — do jeito mais silencioso possível, porque o código bate.
 */
function acharGrupo(db: Db, companyId: string, taxProfile: string | null | undefined): Achado {
  const perfil = String(taxProfile ?? '').trim();

  if (perfil) {
    const grupo = db
      .prepare(
        `SELECT * FROM core_tax_groups
          WHERE company_id = ? AND code = ? AND active = 1`,
      )
      .get(companyId, perfil.toUpperCase()) as Grupo | undefined;
    return grupo
      ? { grupo }
      : {
          oQue: `o perfil tributário "${perfil}" não existe ou está inativo nesta operação`,
          onde: 'Cadastre em Catálogo › Grupos tributários.',
        };
  }

  const ativos = db
    .prepare('SELECT * FROM core_tax_groups WHERE company_id = ? AND active = 1 ORDER BY code')
    .all(companyId) as unknown as Grupo[];

  if (ativos.length === 0) {
    return {
      oQue: 'não tem perfil tributário, e esta operação não cadastrou nenhum grupo',
      onde: 'Cadastre em Catálogo › Grupos tributários.',
    };
  }
  if (ativos.length > 1) {
    return {
      oQue: `não tem perfil tributário, e esta operação tem ${ativos.length} grupos ativos `
        + `(${ativos.map((g) => g.code).join(', ')})`,
      onde: 'Escolha o perfil no cadastro do produto.',
    };
  }
  return { grupo: ativos[0] };
}

// ============================================================================
// A régua
// ============================================================================

/**
 * Descobre como este item é tributado nesta operação — com o juiz dizendo o
 * que acontece com cada falta.
 */
/** O que a régua recebe: o item, o destino e, quando a operação manda, direção, CFOP e grupo. */
export interface EntradaDaTributacao {
  companyId: string;
  produto: ProdutoParaTributar;
  /**
   * Decide o alcance do CFOP (interno, interestadual, exterior). Ausente é o
   * cupom do balcão, que é sempre interno — o cliente leva a mercadoria na mão.
   */
  ufDestinatario?: string | null;
  /** 'entrada' nas notas de entrada que a própria loja emite (devolução de venda). */
  direcao?: DirecaoDaNota;
  /** O CFOP que a OPERAÇÃO declara (devolução) — vence o do produto e o do grupo. */
  cfopDaOperacao?: { interno: string | null; interestadual: string | null } | null;
  /** O grupo tributário que a OPERAÇÃO manda usar no lugar do perfil do produto. */
  grupoDaOperacao?: string | null;
}

function avaliar(
  input: EntradaDaTributacao,
  juiz: Juiz,
  aoAcharOGrupo?: (code: string) => void,
): TributacaoDoItem {
  ensureCoreSchema();
  const { companyId, produto } = input;
  const db = getConnection();

  const achado = acharGrupo(db, companyId, String(input.grupoDaOperacao ?? '').trim() || produto.taxProfile);
  if (!('grupo' in achado)) juiz.pare(achado.oQue, achado.onde);
  const grupo = achado.grupo;
  aoAcharOGrupo?.(grupo.code);

  const config = getFiscalConfig(companyId);
  const crt = String(config.crt ?? '').trim();
  // Simples, Simples com excesso e MEI (CRT 1, 2 e 4) tributam pelo CSOSN.
  const simples = CRTS_DO_SIMPLES.has(crt);

  // ---------------------------------------------------------------- ICMS
  let csosn: string | null = null;
  let cstIcms: string | null = null;
  let pCredSn: string | null = null;
  let vCredIcmsSnCents = 0;
  let icms: IcmsProprio | null = null;

  if (simples) {
    csosn = grupo.csosn;
    if (!csosn) {
      juiz.falha(
        `o grupo ${grupo.code} não tem CSOSN, e esta operação é do Simples (CRT ${crt})`,
        'Preencha em Catálogo › Grupos tributários.',
      );
    } else if (CSOSN_ST_POR_FORA.has(csosn)) {
      juiz.falha(...stPorFora(`o CSOSN ${csosn}`, grupo));
    } else if (!CSOSN_EMITIDOS.has(csosn)) {
      juiz.falha(
        `o grupo ${grupo.code} declara CSOSN "${csosn}", que não existe na tabela do leiaute`,
        'Corrija em Catálogo › Grupos tributários: valem 101, 102, 103, 300, 400, 500 e 900.',
      );
    } else if (csosn === '101' || (csosn === '900' && String(grupo.p_cred_sn ?? '').trim())) {
      /*
        O 101 EXIGE o crédito; o 900 o leva quando o grupo o declara — no
        leiaute o par pCredSN/vCredICMSSN do 900 é opcional, e só o contador
        sabe se a operação dele o usa.
      */
      pCredSn = String(grupo.p_cred_sn ?? '').trim() || null;
      if (!pCredSn) {
        juiz.falha(
          `o CSOSN ${csosn} é "com permissão de crédito" e exige a alíquota de crédito do `
            + `Simples (pCredSN), que o grupo ${grupo.code} não tem`,
          'Peça o percentual ao contador e preencha em Catálogo › Grupos tributários.',
        );
      } else {
        /*
          O crédito é percentual sobre o valor do item. Arredondar para o
          centavo aqui — e não na formatação — mantém a soma dos itens
          conferível contra o total, que é o que a SEFAZ valida.
        */
        vCredIcmsSnCents = Math.round((produto.totalCents * Number(pCredSn)) / 100);
      }
    }
  } else {
    cstIcms = grupo.cst_icms;
    if (!cstIcms) {
      juiz.falha(
        `esta operação está fora do Simples (CRT ${crt}) e o grupo ${grupo.code} não tem CST `
          + 'de ICMS — CSOSN não vale para regime normal',
        'Preencha em Catálogo › Grupos tributários.',
      );
    } else if (CST_ICMS_ST_POR_FORA.has(cstIcms)) {
      juiz.falha(...stPorFora(`o CST de ICMS ${cstIcms}`, grupo));
    } else if (!CST_ICMS_EMITIDOS.has(cstIcms)) {
      juiz.falha(
        NOME_DO_CST_ICMS[cstIcms]
          ? `o CST de ICMS ${cstIcms} (${NOME_DO_CST_ICMS[cstIcms]}) do grupo ${grupo.code} não `
            + 'é montado por este sistema: é de combustível ou de diferimento, e o cadastro não '
            + 'descreve os valores que o grupo do leiaute exige'
          : `o grupo ${grupo.code} declara CST de ICMS "${cstIcms}", que não existe na tabela do `
            + 'leiaute',
        'Corrija em Catálogo › Grupos tributários: este sistema emite os CST 00, 20, 40, 41, 50, '
          + '60 e 90.',
      );
    } else if (CST_ICMS_COM_ALIQUOTA.has(cstIcms)) {
      icms = icmsProprio(db, companyId, grupo, cstIcms, produto, juiz);
    }
  }

  // ----------------------------------------------------------- PIS/COFINS
  const cstPis = grupo.cst_pis;
  const cstCofins = grupo.cst_cofins;
  // Cada uma nomeada: o checklist entrega as duas faltas de uma vez.
  if (!cstPis) {
    juiz.falha(
      `o grupo ${grupo.code} não tem CST de PIS — os dois grupos são obrigatórios no layout da nota`,
      'Preencha em Catálogo › Grupos tributários.',
    );
  }
  if (!cstCofins) {
    juiz.falha(
      `o grupo ${grupo.code} não tem CST de COFINS — os dois grupos são obrigatórios no layout `
        + 'da nota',
      'Preencha em Catálogo › Grupos tributários.',
    );
  }

  /*
    A ALÍQUOTA DE PIS/COFINS TINHA CADASTRO E NÃO TINHA LEITOR.

    `core_tax_rates` aceita `kind = 'pis'` e `kind = 'cofins'` desde sempre, a
    tela de Catálogo › Alíquotas grava, e na hora de emitir NINGUÉM perguntava:
    com CST tributado o item saía com `<vBC>0.00</vBC><pPIS>0.00</pPIS>
    <vPIS>0.00</vPIS>` cravados no código. O contador cadastrava a alíquota, a
    tela aceitava, e a nota dizia que o tributo era zero.

    POR QUE AQUI O VALOR SAI, E NO IPI ELE É RECUSADO. A regra é a mesma nos
    dois — nunca emitir total que não fecha com o que o cliente pagou —, e o
    que muda é a natureza do imposto:

      - o IPI é cobrado POR FORA, e o layout SOMA `vIPI` ao `vNF`. Numa venda
        de balcão cujo total já está fechado, destacá-lo faria `vNF` divergir
        dos `<pag>`; por isso o destaque continua recusado logo abaixo;
      - PIS e COFINS são cobrados POR DENTRO: já estão no preço, e `vPIS` e
        `vCOFINS` do `<ICMSTot>` são INFORMATIVOS — não entram na soma do
        `vNF`. Emitir o valor verdadeiro não move o total em um centavo.

    Onde a conta NÃO fecharia, a recusa continua: CST 03 é tributação por
    UNIDADE DE MEDIDA (reais por unidade) e o cadastro guarda PERCENTUAL. Usar
    um pelo outro seria inventar imposto, que é o que este módulo existe para
    não fazer.
  */
  const pis = cstPis
    ? destaqueDaContribuicao(db, { companyId, produto, grupo, contribuicao: 'pis', cst: cstPis, juiz })
    : SEM_DESTAQUE;
  const cofins = cstCofins
    ? destaqueDaContribuicao(db, {
        companyId,
        produto,
        grupo,
        contribuicao: 'cofins',
        cst: cstCofins,
        juiz,
      })
    : SEM_DESTAQUE;

  // ----------------------------------------------------------------- CFOP
  /*
    O CFOP do PRÓPRIO produto vence o do grupo: ele é mais específico, e é onde
    a exceção mora (uma venda de ativo, uma remessa). O grupo responde pelo
    caso geral, e a UF do destinatário decide entre interno e interestadual.
  */
  const uf = String(config.uf ?? '').toUpperCase();
  const destino = String(input.ufDestinatario ?? '').toUpperCase();
  const interestadual = Boolean(destino) && destino !== uf;
  // O alcance que o CFOP precisa ter (ver `digitoDoCfopEsperado`): o CFOP do
  // produto não vence mais o destino da nota.
  const esperado = digitoDoCfopEsperado(uf, destino, input.direcao ?? 'saida');
  const daOperacao = input.cfopDaOperacao
    ? esperado === '5' || esperado === '1'
      ? input.cfopDaOperacao.interno
      : input.cfopDaOperacao.interestadual
    : null;
  const cfop = escolherCfop({
    esperado,
    doProduto: produto.cfop,
    grupoInterno: grupo.cfop_internal,
    grupoExterno: grupo.cfop_external,
    daOperacao,
  });

  if (!cfop) {
    juiz.falha(
      `não tem CFOP, e o grupo ${grupo.code} não tem CFOP `
        + `${interestadual ? 'interestadual' : 'interno'}`,
      'Preencha no produto ou em Catálogo › Grupos tributários.',
      'classificacao',
    );
  } else if (!cfop.startsWith(esperado)) {
    juiz.falha(
      `o CFOP ${cfop} é de ${alcanceDoCfop(cfop)} e esta nota é de ${alcanceDoCfop(esperado)} — o `
        + 'sistema não adivinha o CFOP equivalente de outro alcance',
      'Informe o CFOP deste alcance no produto ou no grupo tributário — quem diz qual é o contador '
        + '(pendência contábil).',
      'classificacao',
    );
  }

  const origin = String(produto.origin ?? '').trim() || grupo.origin || '';
  if (!origin) {
    juiz.falha(
      'não tem origem da mercadoria (0 a 8)',
      'Preencha no cadastro do produto — o contador informa qual é.',
      'classificacao',
    );
  }

  // ------------------------------------------------------------------ IPI
  /*
    O IPI SAI DO GRUPO — e até esta rodada não saía de lugar nenhum (GAP-V08).

    O XML levava `<vIPI>0.00</vIPI>` cravado no total e nenhum bloco `<IPI>` nos
    itens, enquanto `core_tax_rates` aceitava `kind = 'ipi'` e NINGUÉM a lia na
    emissão: alíquota com escritor e sem leitor, que é a doença que esta casa
    remove em vez de manter.

    Grupo sem CST de IPI continua saindo exatamente como saía. Não é omissão: é
    a tributação correta do varejo do Simples, que não industrializa nada. Só
    quem DECLARA o CST passa a destacar.
  */
  const cstIpi = String(grupo.cst_ipi ?? '').trim() || null;
  let pIpi: string | null = null;
  let vIpiCents = 0;

  if (cstIpi && CST_IPI_COM_VALOR.has(cstIpi)) {
    const codigo = String(grupo.ipi_rate_code ?? '').trim().toUpperCase();
    const aliquota = codigo
      ? (db
        .prepare(
          `SELECT percent FROM core_tax_rates
            WHERE company_id = ? AND code = ? AND kind = 'ipi' AND active = 1`,
        )
        .get(companyId, codigo) as { percent?: number } | undefined)
      : undefined;
    if (aliquota?.percent == null) {
      juiz.falha(
        `o CST de IPI ${cstIpi} é tributado e o grupo ${grupo.code} não tem alíquota de IPI `
          + 'ativa (ela pode ter sido desativada depois de escolhida)',
        'Cadastre a alíquota em Catálogo › Alíquotas com o tipo "ipi" e escolha-a no grupo.',
      );
    } else {
      pIpi = Number(aliquota.percent).toFixed(2);
      // Centavo inteiro, arredondado por ITEM — a mesma decisão do crédito do
      // Simples logo acima, e pelo mesmo motivo: a soma dos itens tem de
      // conferir contra o total, que é o que a SEFAZ valida.
      vIpiCents = Math.round((produto.totalCents * Number(pIpi)) / 100);

      /*
        E AQUI ESTA CASA PARA, DE PROPÓSITO.

        IPI destacado é imposto cobrado POR FORA: no layout, `vNF` soma `vIPI`
        ao valor dos produtos. Só que a nota que este sistema emite é a de uma
        venda cujo TOTAL já está fechado — o cupom do balcão cobra o preço da
        etiqueta, e `<pag>` sai da lista do que o cliente efetivamente pagou.
        Somar o IPI ao `vNF` faria o total da nota não bater com os pagamentos
        (rejeição na hora, com o cliente no caixa); NÃO somar produziria um XML
        que se contradiz e que a validação de schema recusa.

        As duas saídas são erradas, e a terceira — embutir o IPI no preço —
        seria INVENTAR tributação, que é exatamente o que este módulo existe
        para não fazer.

        A recusa acontece AQUI porque é o ponto por onde os dois montadores
        passam, e porque `conferirExigenciasDaMontagem` a executa ANTES de
        reservar o número fiscal: erro de configuração não queima numeração.

        O que falta para ligar o destaque não é este arquivo — é a venda saber
        cobrar o imposto por fora, e o total dela nascer com ele dentro.
      */
      juiz.falha(
        `o grupo ${grupo.code} destaca IPI (CST ${cstIpi}, ${pIpi}%), e este sistema ainda não `
          + 'cobra imposto por fora: o total da nota passaria a divergir do que o cliente pagou',
        'Use um CST de IPI sem valor (51 a 55) no grupo, ou emita a nota fora do sistema '
          + 'enquanto a cobrança por fora não existir.',
      );
    }
  }
  /*
    CST SEM VALOR É EMISSÃO DE VERDADE, e não meia solução: alíquota zero,
    isento, não-tributado, imune e suspensão são declarações fiscais que o
    layout exige por extenso no bloco `<IPI>`, e que esta operação passa a
    fazer. Elas não somam nada ao total — por isso cabem inteiras aqui.
  */

  return {
    origemDoGrupo: grupo.code,
    regime: grupo.regime,
    origin,
    cfop,
    ncm: String(produto.ncm ?? '').trim() || grupo.ncm,
    cest: String(produto.cest ?? '').trim() || grupo.cest,
    csosn,
    cstIcms,
    pCredSn,
    vCredIcmsSnCents,
    icms,
    cBenef: String(grupo.c_benef ?? '').trim() || null,
    cstPis: cstPis ?? '',
    cstCofins: cstCofins ?? '',
    pPis: pis.percentual,
    bcPisCents: pis.bcCents,
    vPisCents: pis.valorCents,
    pCofins: cofins.percentual,
    bcCofinsCents: cofins.bcCents,
    vCofinsCents: cofins.valorCents,
    cstIpi,
    pIpi,
    vIpiCents,
  };
}

/**
 * Descobre como este item é tributado nesta operação — e recusa na primeira
 * falta, nomeando o dado e o produto.
 *
 * @param ufDestinatario decide entre CFOP interno e interestadual. Ausente é o
 * cupom do balcão, que é sempre interno — o cliente leva a mercadoria na mão.
 */
export function tributacaoDoItem(input: EntradaDaTributacao): TributacaoDoItem {
  return avaliar(input, juizQueRecusa(input.produto));
}

/** O que a régua diria deste item — todas as faltas, sem recusar nada. */
export interface DiagnosticoDaTributacao {
  /** O grupo que vale para o produto; nulo quando nem ele se resolve. */
  grupo: string | null;
  faltas: FaltaDeTributacao[];
}

/**
 * A MESMA régua de `tributacaoDoItem`, lida pelo checklist (GAP-PRD-095).
 *
 * Não recusa: anota cada falta e segue conferindo o que dá, para o contador
 * receber a lista inteira de uma vez. Só para quando não há grupo — sem ele,
 * não existe regra nenhuma para conferir.
 */
export function diagnosticarTributacao(input: EntradaDaTributacao): DiagnosticoDaTributacao {
  const faltas: FaltaDeTributacao[] = [];
  let grupo: string | null = null;
  try {
    avaliar(input, juizQueAnota(faltas), (code) => {
      grupo = code;
    });
  } catch (err) {
    if (!(err instanceof ParadaDoDiagnostico)) throw err;
  }
  return { grupo, faltas };
}

/**
 * A CLASSIFICAÇÃO QUE O PRODUTO NÃO TEM, TIRADA DO GRUPO (GAP-PRD-129).
 *
 * `tributacaoDoItem` sempre soube usar o CFOP, a origem, o NCM e o CEST do
 * grupo quando o produto não declara os dele — e a validação da nota e o XML
 * liam só o produto. Preencher o CFOP no grupo, o gesto que resolveria o
 * catálogo inteiro de uma vez, não destravava nada, e o checklist dizia que a
 * origem "vem do grupo" enquanto a validação recusava a venda por falta dela.
 *
 * Isto devolve a venda com cada lacuna do produto preenchida pelo grupo que
 * vale para ele — a MESMA resolução de `tributacaoDoItem` (perfil do produto,
 * ou o grupo único da operação), com o CFOP interestadual quando o destino é
 * outra UF. O que o produto declara continua vencendo. Sem grupo resolvido,
 * o item volta como veio, e a validação diz o que falta.
 */
export function completarPeloGrupo(sale: NfceSale, ufDestinatario: string | null): NfceSale {
  ensureCoreSchema();
  const db = getConnection();
  // O mesmo alcance que a régua cobra: o 5102 copiado no produto não vai para
  // a nota interestadual quando o grupo tem o 6102 (ver `escolherCfop`).
  const esperado = digitoDoCfopEsperado(getFiscalConfig(sale.companyId).uf, ufDestinatario);
  const vazio = (v: string | null | undefined) => !String(v ?? '').trim();

  const cache = new Map<string, Grupo | null>();
  const grupoDe = (perfil: string | null | undefined): Grupo | null => {
    const chave = String(perfil ?? '').trim().toUpperCase();
    if (!cache.has(chave)) {
      const achado = acharGrupo(db, sale.companyId, perfil);
      cache.set(chave, 'grupo' in achado ? achado.grupo : null);
    }
    return cache.get(chave) ?? null;
  };

  return {
    ...sale,
    items: sale.items.map((item) => {
      const g = grupoDe(item.taxProfile);
      if (!g) return item;
      return {
        ...item,
        ncm: vazio(item.ncm) ? g.ncm : item.ncm,
        cest: vazio(item.cest) ? g.cest : item.cest,
        origin: vazio(item.origin) ? g.origin : item.origin,
        cfop:
          escolherCfop({
            esperado,
            doProduto: item.cfop,
            grupoInterno: g.cfop_internal,
            grupoExterno: g.cfop_external,
          }) || item.cfop,
      };
    }),
  };
}

/** Uma linha curta do que o grupo declara — o "o que já sabemos" do checklist. */
export function resumoDoGrupo(grupo: {
  code: string;
  csosn: string | null;
  cst_icms: string | null;
  icms_rate_code?: string | null;
}): string {
  const icms = grupo.csosn
    ? `CSOSN ${grupo.csosn}`
    : grupo.cst_icms
      ? `CST ${grupo.cst_icms}${grupo.icms_rate_code ? `, ${grupo.icms_rate_code}` : ''}`
      : 'sem ICMS';
  return `${grupo.code} (${icms})`;
}

// ============================================================================
// O XML do bloco <imposto>
// ============================================================================

function reais(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/**
 * O bloco `<PIS>`/`<COFINS>` de um item — o grupo do layout que o CST manda.
 *
 * Os dois têm a MESMA forma e nomes de tag diferentes (`pPIS`/`pCOFINS`,
 * `PISAliq`/`COFINSAliq`). Escrevê-los duas vezes foi o que deixou passar o
 * `<PISOutr>` com CST 01 dentro: a segunda cópia nunca é revista junto com a
 * primeira.
 */
function contribuicaoXml(
  tag: 'PIS' | 'COFINS',
  cst: string,
  percentual: string | null,
  bcCents: number,
  valorCents: number,
  produto: ProdutoParaTributar,
): string {
  const forma: FormaDoCst | undefined = FORMA_DO_CST[cst as CstPisCofins];

  /*
    `tributacaoDoItem` já recusou entrada, CST 03 e código desconhecido, com o
    motivo por extenso. Se um deles chegar aqui, alguém montou a tributação à
    mão — e emitir seria pior que recusar de novo.
  */
  if (forma !== 'aliquota' && forma !== 'sem_valor' && forma !== 'outras') {
    faltou(
      produto,
      `o CST de ${tag} ${cst} não tem grupo montável neste sistema`,
      'Corrija o CST em Catálogo › Grupos tributários.',
    );
  }

  if (forma === 'sem_valor') {
    return `        <${tag}NT><CST>${cst}</CST></${tag}NT>`;
  }

  /*
    `PISAliq` para o tributado (01/02) e `PISOutr` para "outras" (49, 70 a 99).
    O que mudou não foi só o grupo: o percentual e o valor deixaram de ser o
    literal `0.00` e passam a vir do cadastro, quando existe destaque.
  */
  const grupoXml = forma === 'aliquota' ? `${tag}Aliq` : `${tag}Outr`;
  return `        <${grupoXml}>
            <CST>${cst}</CST>
            <vBC>${reais(bcCents)}</vBC>
            <p${tag}>${percentual ?? '0.00'}</p${tag}>
            <v${tag}>${reais(valorCents)}</v${tag}>
          </${grupoXml}>`;
}

/**
 * O `<ICMS>` do Simples: um grupo do leiaute por CSOSN.
 *
 * 500 e 900 só exigem origem e CSOSN no leiaute 4.00 — os valores da ST retida
 * (vBCSTRet, pST, vICMSSTRet) e o grupo "efetivo" são OPCIONAIS no XSD, e o
 * cadastro não os tem; a homologação da SEFAZ-RS confirma se a UF os cobra.
 */
function icmsDoSimples(t: TributacaoDoItem, orig: string, produto: ProdutoParaTributar): string {
  switch (t.csosn) {
    case '101':
      return `        <ICMSSN101>
            <orig>${orig}</orig>
            <CSOSN>101</CSOSN>
            <pCredSN>${Number(t.pCredSn).toFixed(2)}</pCredSN>
            <vCredICMSSN>${reais(t.vCredIcmsSnCents)}</vCredICMSSN>
          </ICMSSN101>`;
    case '102':
    case '103':
    case '300':
    case '400':
      return `        <ICMSSN102>
            <orig>${orig}</orig>
            <CSOSN>${t.csosn}</CSOSN>
          </ICMSSN102>`;
    case '500':
      return `        <ICMSSN500>
            <orig>${orig}</orig>
            <CSOSN>500</CSOSN>
          </ICMSSN500>`;
    case '900':
      return `        <ICMSSN900>
            <orig>${orig}</orig>
            <CSOSN>900</CSOSN>${
              t.pCredSn
                ? `
            <pCredSN>${Number(t.pCredSn).toFixed(2)}</pCredSN>
            <vCredICMSSN>${reais(t.vCredIcmsSnCents)}</vCredICMSSN>`
                : ''
            }
          </ICMSSN900>`;
    default:
      // `tributacaoDoItem` já recusou com o motivo; chegar aqui é montagem à mão.
      return faltou(
        produto,
        `o CSOSN ${String(t.csosn)} não tem grupo montável neste sistema`,
        'Corrija o CSOSN em Catálogo › Grupos tributários.',
      );
  }
}

/** Base, alíquota e valor do ICMS próprio, na ordem que cada grupo do leiaute pede. */
function linhasDoIcmsProprio(i: IcmsProprio, comReducaoAntesDaBase: boolean): string {
  const reducao = i.pRedBc ? `\n            <pRedBC>${i.pRedBc}</pRedBC>` : '';
  return `
            <modBC>${i.modBC}</modBC>${comReducaoAntesDaBase ? reducao : ''}
            <vBC>${reais(i.vBcCents)}</vBC>${comReducaoAntesDaBase ? '' : reducao}
            <pICMS>${i.pIcms}</pICMS>
            <vICMS>${reais(i.vIcmsCents)}</vICMS>`;
}

/**
 * O FCP do item. No ICMS00 o leiaute leva só percentual e valor (a base é a
 * do ICMS); no 20 e no 90 leva a base do FCP antes deles.
 */
function linhasDoFcp(i: IcmsProprio, comBase: boolean): string {
  if (!i.pFcp) return '';
  return `${comBase ? `\n            <vBCFCP>${reais(i.vBcCents)}</vBCFCP>` : ''}
            <pFCP>${i.pFcp}</pFCP>
            <vFCP>${reais(i.vFcpCents)}</vFCP>`;
}

/** O `<ICMS>` do regime normal: um grupo do leiaute por CST (GAP-PRD-021). */
function icmsDoRegimeNormal(t: TributacaoDoItem, orig: string, produto: ProdutoParaTributar): string {
  const cst = String(t.cstIcms);
  const i = t.icms;
  switch (cst) {
    case '00':
    case '20': {
      if (!i) {
        return faltou(
          produto,
          `o CST de ICMS ${cst} exige base, alíquota e valor, e a tributação veio sem eles`,
          'Escolha a alíquota de ICMS em Catálogo › Grupos tributários.',
        );
      }
      const tag = `ICMS${cst}`;
      return `        <${tag}>
            <orig>${orig}</orig>
            <CST>${cst}</CST>${linhasDoIcmsProprio(i, cst === '20')}${linhasDoFcp(i, cst === '20')}
          </${tag}>`;
    }
    case '40':
    case '41':
    case '50':
      return `        <ICMS40>
            <orig>${orig}</orig>
            <CST>${cst}</CST>
          </ICMS40>`;
    case '60':
      return `        <ICMS60>
            <orig>${orig}</orig>
            <CST>60</CST>
          </ICMS60>`;
    case '90':
      return `        <ICMS90>
            <orig>${orig}</orig>
            <CST>90</CST>${i ? `${linhasDoIcmsProprio(i, false)}${linhasDoFcp(i, true)}` : ''}
          </ICMS90>`;
    default:
      return faltou(
        produto,
        `o CST de ICMS ${cst} não tem grupo montável neste sistema`,
        'Corrija o CST em Catálogo › Grupos tributários.',
      );
  }
}

/**
 * O bloco `<imposto>` de um item, montado a partir da tributação resolvida.
 *
 * Mora aqui, e não em cada montador de XML, porque NF-e e NFC-e carregam o
 * MESMO bloco — duas cópias divergiriam no dia em que a legislação mudasse, e
 * a divergência apareceria como rejeição em um dos dois modelos.
 *
 * O que este bloco NÃO monta já foi recusado em `tributacaoDoItem`, com o
 * motivo por extenso: a ST calculada pelo próprio emitente (cobrada por fora),
 * o monofásico de combustíveis e o diferimento. As recusas daqui existem só
 * para quem montar a tributação à mão.
 */
export function impostoXml(t: TributacaoDoItem, produto: ProdutoParaTributar): string {
  const orig = String(t.origin).replace(/\D/g, '');

  /*
    O REGIME NORMAL DEIXOU DE SER RECUSA (GAP-PRD-021).

    Aqui morava "o ICMS por CST ainda não é emitido por este sistema" — frase
    verdadeira, que custava a operação inteira de quem saísse do Simples, e que
    o checklist nunca repetia: CRT 3 ficava PASS. O que faltava era o que a
    frase dizia: base, modalidade de base, os grupos ICMS00/20/40/60/90 e um
    vínculo alíquota↔grupo. Os quatro existem agora; o que ficou de fora é só
    o que não pode sair sem mentir no total, e está dito em `TabelasDoIcms`.
  */
  const icms = t.csosn ? icmsDoSimples(t, orig, produto) : icmsDoRegimeNormal(t, orig, produto);

  const pis = contribuicaoXml('PIS', t.cstPis, t.pPis, t.bcPisCents, t.vPisCents, produto);
  const cofins = contribuicaoXml(
    'COFINS',
    t.cstCofins,
    t.pCofins,
    t.bcCofinsCents,
    t.vCofinsCents,
    produto,
  );

  /*
    O BLOCO `<IPI>` SÓ EXISTE QUANDO A OPERAÇÃO O DECLARA (GAP-V08).

    Ausência não é omissão: o grupo `<IPI>` é OPCIONAL no layout, e quem não
    industrializa não o manda. Emitir um `<IPINT>` inventado para toda empresa
    do Simples seria escrever declaração fiscal por conta própria — e faria toda
    nota já emitida por este sistema mudar de forma sem ninguém pedir.

    `<IPITrib>` (o destaque com valor) não é montado aqui porque
    `tributacaoDoItem` recusa antes de chegar: o motivo está por extenso lá, e
    é o total da nota que não fecharia com o que o cliente pagou. `cIEnq` é
    obrigatório no bloco e vale "999" para quem não é enquadrado na TIPI — que
    é o caso de toda empresa deste grupo.
  */
  const ipi = t.cstIpi
    ? `
        <IPI>
          <cEnq>999</cEnq>
          <IPINT>
            <CST>${t.cstIpi}</CST>
          </IPINT>
        </IPI>`
    : '';

  return `      <imposto>
        <ICMS>
${icms}
        </ICMS>
        <PIS>
${pis}
        </PIS>
        <COFINS>
${cofins}
        </COFINS>${ipi}
      </imposto>`;
}

/**
 * Os totais de ICMS do `<ICMSTot>`: a soma do que os itens declaram.
 *
 * Eram os literais `0.00` nos dois montadores — verdade enquanto só o Simples
 * emitia, e mentira no primeiro CST 00. Saem da MESMA resolução que monta cada
 * item, então total e itens não conseguem divergir.
 */
export function totaisDoIcms(tributacoes: TributacaoDoItem[]): {
  vBcCents: number;
  vIcmsCents: number;
  vFcpCents: number;
} {
  return tributacoes.reduce(
    (soma, t) => ({
      vBcCents: soma.vBcCents + (t.icms?.vBcCents ?? 0),
      vIcmsCents: soma.vIcmsCents + (t.icms?.vIcmsCents ?? 0),
      vFcpCents: soma.vFcpCents + (t.icms?.vFcpCents ?? 0),
    }),
    { vBcCents: 0, vIcmsCents: 0, vFcpCents: 0 },
  );
}
