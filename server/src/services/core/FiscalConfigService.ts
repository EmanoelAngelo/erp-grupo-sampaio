/**
 * Configuração fiscal por operação, e o checklist honesto do que falta.
 *
 * CADA OPERAÇÃO EMITE COM O PRÓPRIO CNPJ. Não há emitente padrão nem fallback:
 * faturar da Oficina usando o CNPJ do Preço Justo é emitir nota por quem não
 * fez a venda, e o erro só aparece na fiscalização.
 *
 * O READINESS É O PORTÃO. Ele existe para que a resposta a "posso emitir?" seja
 * uma lista de campos faltantes, e não uma tentativa que morre na SEFAZ com a
 * venda já registrada. Enquanto qualquer item estiver FAIL, a emissão é
 * recusada aqui — antes de numerar, antes de assinar.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: decidir tributação. NCM, CFOP, CST/CSOSN e origem
 * vêm do cadastro do produto e do regime da empresa. Se faltarem, o checklist
 * aponta o campo; ele não escolhe um valor "provável".
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getCertificateView, type CertificateAlert } from './CertificateStatusService.js';
import {
  ambienteDoCsc,
  cscsDaOperacao,
  rotuloDoAmbiente,
  type AmbienteDoCsc,
} from '../nfce/NfceCscService.js';
import {
  MODEL_NFCE,
  MODEL_NFE,
  getSeries,
  rotuloDoAmbienteDaSerie,
  seriesDoAmbiente,
  type FiscalEnvironment,
} from './FiscalKeyService.js';
import { ieDoRsConfere } from './InscricaoEstadualRs.js';

// A conta do CGC/TE mora no módulo dela; o checklist a usa e a expõe a quem
// já importa daqui.
export { ieDoRsConfere };
import { TEST_PROTOCOL_PREFIX } from './SefazTestAdapter.js';
/*
  AS DUAS MARCAS DE ENSAIO VÊM DE QUEM AS PRODUZ — nunca digitadas aqui.

  `TEST_PROTOCOL_PREFIX` é o carimbo do simulador; `FIXTURE_SIGNATURE_MARK` é
  o da assinatura de desenvolvimento. Copiar os literais criaria uma segunda
  verdade que envelhece sozinha: no dia em que uma delas mudasse, o portão da
  produção passaria a aceitar exatamente o documento que existe para recusar.

  `FiscalPipelineService` importa este módulo de volta, e o ciclo é conhecido e
  inofensivo: as duas pontas só se usam DENTRO de funções, e as declarações de
  função são içadas antes de qualquer corpo de módulo rodar.
*/
import { FIXTURE_SIGNATURE_MARK } from './FiscalPipelineService.js';
import { itemDeProntidaoDaContingencia } from './FiscalContingenciaOffline.js';
import { CRTS_DO_LEIAUTE } from './TabelasDoIcms.js';
import { itemDeProntidaoDaTributacao } from './ProntidaoTributaria.js';
import { municipioDoEmitenteQueNaoConfere } from './MunicipiosIbge.js';

export interface FiscalConfig {
  companyId: string;
  legalName: string | null;
  tradeName: string | null;
  cnpj: string | null;
  ie: string | null;
  im: string | null;
  crt: string | null;
  zip: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  cityName: string | null;
  cityIbge: string | null;
  uf: string | null;
  phone: string | null;
  environment: FiscalEnvironment;
  productionUnlocked: boolean;
  updatedAt: string | null;
}

const EMPTY: Omit<FiscalConfig, 'companyId'> = {
  legalName: null,
  tradeName: null,
  cnpj: null,
  ie: null,
  im: null,
  crt: null,
  zip: null,
  street: null,
  number: null,
  complement: null,
  district: null,
  cityName: null,
  cityIbge: null,
  uf: null,
  phone: null,
  environment: 'homologation',
  productionUnlocked: false,
  updatedAt: null,
};

function toConfig(row: Record<string, unknown> | undefined, companyId: string): FiscalConfig {
  if (!row) return { companyId, ...EMPTY };
  return {
    companyId,
    legalName: (row.legal_name as string | null) ?? null,
    tradeName: (row.trade_name as string | null) ?? null,
    cnpj: (row.cnpj as string | null) ?? null,
    ie: (row.ie as string | null) ?? null,
    im: (row.im as string | null) ?? null,
    crt: (row.crt as string | null) ?? null,
    zip: (row.zip as string | null) ?? null,
    street: (row.street as string | null) ?? null,
    number: (row.number as string | null) ?? null,
    complement: (row.complement as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    cityName: (row.city_name as string | null) ?? null,
    cityIbge: (row.city_ibge as string | null) ?? null,
    uf: (row.uf as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    environment: (row.environment as FiscalEnvironment) ?? 'homologation',
    productionUnlocked: row.production_unlocked === 1,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

export function getFiscalConfig(companyId: string): FiscalConfig {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_fiscal_configs WHERE company_id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  return toConfig(row, companyId);
}

/** Dígitos verificadores do CNPJ — módulo 11, como manda a Receita. */
export function isValidCnpj(value: string | null | undefined): boolean {
  const cnpj = (value ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return false;
  // Todos os dígitos iguais passam na conta e não são CNPJ.
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const dv = (base: string, pesos: number[]): string => {
    const soma = base
      .split('')
      .reduce((acc, digito, i) => acc + Number(digito) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? '0' : String(11 - resto);
  };

  const primeiro = dv(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = dv(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return cnpj[12] === primeiro && cnpj[13] === segundo;
}

export function updateFiscalConfig(input: {
  companyId: string;
  patch: Partial<Omit<FiscalConfig, 'companyId' | 'productionUnlocked' | 'updatedAt'>>;
}): FiscalConfig {
  ensureCoreSchema();

  // CNPJ inválido gravado agora vira rejeição na SEFAZ depois, com a venda
  // feita. Barrar aqui é o único momento barato.
  if (input.patch.cnpj !== undefined && input.patch.cnpj && !isValidCnpj(input.patch.cnpj)) {
    throw new ApiError('CORE_FISCAL_CNPJ_INVALID', 'CNPJ inválido: os dígitos não conferem.', 400);
  }
  /*
    O AMBIENTE SÓ TEM DOIS VALORES — e a conferência precisa vir ANTES do
    portão da produção.

    A rota entrega `req.body` cru, e este serviço só se pronunciava sobre o
    valor 'production'. Qualquer outra string caía no mapa lá embaixo e era
    GRAVADA literal: `environment: 'contingencia'` persistia, e 'PRODUCTION' em
    caixa alta escapava do portão do desbloqueio por não ser idêntico a
    'production' — passando por cima da única trava que existe para impedir
    emissão real antes da hora.

    O estrago não é fiscal: a emissão é fail-safe (`env === 'production' ? '1' :
    '2'`), então ambiente estranho emite em homologação e o DANFE sai com a
    tarja de sem valor fiscal. O estrago é de SAÍDA — a tela não reconhece o
    ambiente, não oferece gesto nenhum, e a operação fica sem caminho de volta
    pelo navegador. É o "UPDATE na mão no banco" que a virada do ambiente
    existe justamente para eliminar.

    Lista fechada e não lista de proibidos: um terceiro ambiente (contingência,
    por exemplo) só passa a existir quando alguém o declarar aqui e decidir o
    que ele significa para a chave de acesso, para o DANFE e para a tela.
  */
  const AMBIENTES: readonly string[] = ['homologation', 'production'];
  if (input.patch.environment !== undefined && !AMBIENTES.includes(input.patch.environment)) {
    throw new ApiError(
      'CORE_FISCAL_ENVIRONMENT_INVALID',
      `Ambiente "${String(input.patch.environment)}" não existe. `
        + 'Os valores possíveis são "homologation" e "production".',
      400,
    );
  }

  /*
    O CRT SÓ TEM OS QUATRO VALORES DO LEIAUTE (GAP-PRD-021).

    O campo era texto livre: "simples" ou "5" eram gravados, o checklist os
    marcava PASS por estarem preenchidos, e a emissão os lia como "fora do
    Simples" — exigindo CST de ICMS de quem nunca teve. Vazio continua valendo
    (é o campo ainda não respondido pelo contador).
  */
  if (input.patch.crt !== undefined && input.patch.crt !== null) {
    const crt = String(input.patch.crt).trim();
    if (crt && !CRTS_DO_LEIAUTE.includes(crt)) {
      throw new ApiError(
        'CORE_FISCAL_CRT_INVALID',
        `CRT "${crt}" não existe no leiaute. Os valores são 1 (Simples Nacional), 2 (Simples `
          + 'Nacional com excesso de sublimite), 3 (regime normal) e 4 (MEI).',
        400,
      );
    }
    input = { ...input, patch: { ...input.patch, crt } };
  }

  /*
    O MUNICÍPIO DO EMITENTE CONFERE NA TABELA OFICIAL (R3-IBGE, GAP-PRD-028).

    Qualquer código de 7 dígitos era gravado. Um cMun errado no emitente vai
    em TODA nota (cMunFG e o endereço do emitente, na NF-e e na NFC-e; o Id da
    DPS na NFS-e): a SEFAZ recusa cada uma depois de numerada — ou aceita um
    código válido de outra cidade da mesma UF, e a nota sai com o município
    errado. Com a tabela carregada, o código tem de existir, ser da UF e ser da
    cidade escrita. Conferido sobre o cadastro COMO FICARÁ (o que já estava
    mais o que chegou), e só quando um dos três campos veio — trocar só a UF
    também pode desfazer o par. Sem a tabela, a regra de antes.
  */
  const mexeNoMunicipio = (['cityIbge', 'uf', 'cityName'] as const).some((k) => input.patch[k] !== undefined);
  if (mexeNoMunicipio) {
    const atual = getFiscalConfig(input.companyId);
    const valor = <K extends 'cityIbge' | 'uf' | 'cityName'>(k: K) =>
      input.patch[k] !== undefined ? input.patch[k] : atual[k];
    const errado = municipioDoEmitenteQueNaoConfere({
      codigo: valor('cityIbge'),
      uf: valor('uf'),
      cidade: valor('cityName'),
    });
    if (errado) {
      throw new ApiError(
        'CORE_FISCAL_IBGE_NAO_CONFERE',
        `O município do emitente não confere com a tabela oficial do IBGE: ${errado}. `
          + 'Em Fiscal › Emitente, escolha a UF e o município na lista — o código IBGE vem junto.',
        422,
        { campo: 'cityIbge' },
      );
    }
  }

  // Produção NUNCA é ligada por aqui: exige o desbloqueio administrativo.
  if (input.patch.environment === 'production') {
    const atual = getFiscalConfig(input.companyId);
    if (!atual.productionUnlocked) {
      throw new ApiError(
        'CORE_FISCAL_PRODUCTION_LOCKED',
        'Produção bloqueada. Exige configuração completa, certificado válido e '
          + 'autorização real na homologação antes de ser liberada.',
        409,
        { readiness: 'READY_FOR_CERTIFICATE' },
      );
    }
  }

  const mapa: Record<string, string> = {
    legalName: 'legal_name',
    tradeName: 'trade_name',
    cnpj: 'cnpj',
    ie: 'ie',
    im: 'im',
    crt: 'crt',
    zip: 'zip',
    street: 'street',
    number: 'number',
    complement: 'complement',
    district: 'district',
    cityName: 'city_name',
    cityIbge: 'city_ibge',
    uf: 'uf',
    phone: 'phone',
    environment: 'environment',
  };

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO core_fiscal_configs (company_id, updated_at) VALUES (?, ?)
       ON CONFLICT (company_id) DO NOTHING`,
    ).run(input.companyId, now);

    const entradas = Object.entries(input.patch).filter(([chave]) => chave in mapa);
    if (entradas.length > 0) {
      const sets = entradas.map(([chave]) => `${mapa[chave]} = ?`).join(', ');
      db.prepare(
        `UPDATE core_fiscal_configs SET ${sets}, updated_at = ? WHERE company_id = ?`,
      ).run(...entradas.map(([, v]) => (v as string | null) ?? null), now, input.companyId);
    }

    return getFiscalConfig(input.companyId);
  });
}

// ------------------------------------------------------------------ readiness

export type CheckStatus = 'PASS' | 'FAIL' | 'PENDING';

/**
 * DE ONDE VEIO O DADO — a procedência.
 *
 * A pergunta parece burocrática e não é: dentro das MESMAS colunas do cadastro,
 * um NCM digitado pelo contador e um NCM lido do XML de um fornecedor eram
 * indistinguíveis. O primeiro é decisão da casa; o segundo é palpite de
 * terceiro, bom o bastante para sugerir e nunca para responder pela empresa
 * numa fiscalização. Dado sem origem é dado sem responsável.
 */
export type ReadinessSource =
  /** Alguém digitou no cadastro desta operação. */
  | 'cadastro'
  /** Lido do arquivo .pfx — titular, emissor, validade. */
  | 'certificado'
  /** Declarado no XML de entrada de um fornecedor. */
  | 'xml_fornecedor'
  /** Um humano olhou a sugestão e assinou embaixo. */
  | 'confirmacao_humana'
  /** Resposta real do fisco, com protocolo. */
  | 'sefaz'
  /** Vive cifrado no cofre; aqui só se pergunta se existe. */
  | 'cofre';

/**
 * QUEM RESOLVE.
 *
 * Sem este campo a tela empurrava o gestor a tentar resolver, clicando, o que
 * só a SEFAZ resolve — e a lista de pendências virava uma lista de frustrações
 * de tamanho igual.
 */
export type ReadinessOwner =
  /** O dono do sistema: certificado, senha do A1, CSC, contratos. */
  | 'dono'
  /** Quem opera a empresa: cadastro do emitente, série, endereço. */
  | 'gestor'
  /** Quem responde pela tributação: NCM, CFOP, CEST, regime. */
  | 'contador'
  /** Ninguém aqui dentro. Depende de resposta do fisco. */
  | 'sefaz';

export type ReadinessState =
  | 'AUTO_DETECTADO'
  | 'CONFIRMADO'
  | 'PENDENTE'
  | 'DIVERGENTE'
  | 'NAO_APLICAVEL'
  | 'BLOQUEADO_EXTERNAMENTE';

/** "93% dos produtos classificados" — acionável; "produtos sem NCM" — susto. */
export interface ReadinessCounts {
  done: number;
  total: number;
  /** Inteiro de 0 a 100. Catálogo vazio é 100: não há o que classificar. */
  percent: number;
}

export interface ReadinessItem {
  key: string;
  label: string;
  /**
   * O PORTÃO. É por este campo, e só por ele, que a emissão é barrada — a régua
   * do que BLOQUEIA não pode ser a mesma do que INFORMA.
   */
  status: CheckStatus;
  /** O que exatamente falta. Vazio quando PASS. */
  detail: string | null;
  /**
   * O ASSISTENTE. Estes quatro campos não decidem nada: respondem, item a item,
   * as perguntas que a lista de pendências deixava em aberto — o que já
   * sabemos, de onde veio, quem resolve e quanto falta.
   */
  state: ReadinessState;
  source: ReadinessSource | null;
  owner: ReadinessOwner;
  /** O valor que está lá hoje. Nulo quando não se sabe nada ainda. */
  known: string | null;
  /** Só nos itens de catálogo, onde a pergunta é "quantos de quantos". */
  counts: ReadinessCounts | null;
}

export type FiscalReadiness =
  | 'READY_FOR_CERTIFICATE'
  | 'READY_FOR_SEFAZ_HOMOLOGATION'
  | 'HOMOLOGATED';

export interface ReadinessReport {
  companyId: string;
  model: string;
  /**
   * NUNCA é 'HOMOLOGATED' sem resposta real da SEFAZ registrada. O campo é
   * calculado, não configurável.
   */
  readiness: FiscalReadiness;
  canEmit: boolean;
  items: ReadinessItem[];
  blockingReasons: string[];
  /**
   * A faixa de aviso do certificado (GAP-V40), ou `null` quando há folga.
   *
   * Viaja no relatório para que a tela pinte um banner sem uma segunda
   * chamada — e para que o aviso alcance quem abre a CONFIGURAÇÃO, não só quem
   * abre a tela do certificado.
   */
  certificateAlert: CertificateAlert | null;
}

/**
 * O item do checklist, agora com as quatro respostas do assistente.
 *
 * O estado PADRÃO de um item de cadastro é CONFIRMADO quando preenchido: quem
 * digitou razão social, IE ou endereço é gente da casa, e digitação é decisão.
 * Os itens que fogem disso (certificado, SEFAZ, catálogo) dizem o próprio
 * estado — é justamente por eles serem diferentes que o campo existe.
 */
function check(
  key: string,
  label: string,
  ok: boolean,
  detail: string,
  assistente: {
    owner: ReadinessOwner;
    source?: ReadinessSource;
    known?: string | null;
    state?: ReadinessState;
    counts?: ReadinessCounts | null;
  },
): ReadinessItem {
  const known = assistente.known ?? null;
  return {
    key,
    label,
    status: ok ? 'PASS' : 'FAIL',
    detail: ok ? null : detail,
    state: assistente.state ?? (ok ? 'CONFIRMADO' : 'PENDENTE'),
    // Procedência só existe quando há dado: dizer "veio do cadastro" sobre um
    // campo vazio seria atribuir origem ao nada.
    source: known || ok ? (assistente.source ?? 'cadastro') : null,
    owner: assistente.owner,
    known,
    counts: assistente.counts ?? null,
  };
}

/**
 * O CSC DO AMBIENTE DA OPERAÇÃO — GAP-PRD-022.
 *
 * O item dizia PASS para qualquer CSC gravado: depois da virada para
 * produção, com só o de homologação no cofre, a tela dizia CONFIGURADO e o
 * cupom saía com um QR que o portal não confere. Agora a pergunta é "existe o
 * CSC DO AMBIENTE em que esta operação emite?":
 *
 *  - existe → PASS, e o `known` diz qual (ID e ambiente). Em homologação sem o
 *    de produção ainda gravado, o PASS vem com o aviso da virada: é o momento
 *    barato de gravá-lo, e não o dia da troca;
 *  - só existe o do OUTRO ambiente → FAIL, DIVERGENTE: há um código no cofre, e
 *    é o código errado — nomeá-lo é o que evita o dono regravar o mesmo;
 *  - não existe nenhum → FAIL, PENDENTE.
 *
 * Quem resolve é o DONO: o CSC sai do portal da SEFAZ com o login dele.
 */
function itemDoCsc(companyId: string, environment: FiscalEnvironment): ReadinessItem {
  const ambiente: AmbienteDoCsc = ambienteDoCsc(environment);
  const outro: AmbienteDoCsc = ambiente === 'production' ? 'homologation' : 'production';
  const cscs = cscsDaOperacao(companyId);
  const doAmbiente = cscs[ambiente];
  const doOutro = cscs[outro];
  const base = {
    key: 'csc',
    label: 'CSC (código de segurança do contribuinte)',
    owner: 'dono' as const,
    counts: null,
  };

  if (doAmbiente) {
    return {
      ...base,
      status: 'PASS',
      detail:
        ambiente === 'homologation' && !doOutro
          ? 'O CSC de produção ainda não foi gravado. A SEFAZ emite um código para cada ambiente: '
            + 'grave o de produção antes da virada — depois dela, a NFC-e só aceita o de produção.'
          : null,
      state: 'CONFIRMADO',
      source: 'cofre',
      known: `CSC ID ${doAmbiente.cscId} (${rotuloDoAmbiente(ambiente)})`,
    };
  }
  if (doOutro) {
    return {
      ...base,
      status: 'FAIL',
      detail:
        `A operação emite em ${rotuloDoAmbiente(ambiente)} e o único CSC gravado é o de `
        + `${rotuloDoAmbiente(outro)} (CSC ID ${doOutro.cscId}). A SEFAZ emite um CSC para cada `
        + `ambiente, e o QR montado com o de ${rotuloDoAmbiente(outro)} não confere no portal. `
        + `Grave o CSC de ${rotuloDoAmbiente(ambiente)} em Fiscal › Configuração.`,
      state: 'DIVERGENTE',
      source: 'cofre',
      known: `CSC ID ${doOutro.cscId} (${rotuloDoAmbiente(outro)})`,
    };
  }
  return {
    ...base,
    status: 'FAIL',
    detail:
      `CSC e CSC ID de ${rotuloDoAmbiente(ambiente)} não configurados. Sem eles o QR Code do `
      + 'cupom não pode ser gerado, e sem QR o cupom não vale.',
    state: 'PENDENTE',
    source: null,
    known: null,
  };
}

/** A conta de "quantos de quantos", com o catálogo vazio tratado com honestidade. */
function contar(done: number, total: number): ReadinessCounts {
  return {
    done,
    total,
    // Catálogo vazio é 100%, e não 0%: não há produto por classificar. Zero
    // ali seria um alarme sobre um trabalho que não existe — e alarme que toca
    // sem motivo é alarme que se aprende a ignorar.
    percent: total === 0 ? 100 : Math.round((done / total) * 100),
  };
}

/**
 * Checklist de emissão para uma operação e um modelo.
 *
 * A ordem importa: são os itens na sequência em que travam a emissão. Quem lê
 * de cima para baixo resolve na ordem certa.
 */
export function buildReadiness(
  companyId: string,
  model: string,
  /**
   * O relógio da avaliação. Existe para que o teste consiga pôr o certificado
   * dentro de cada faixa de aviso sem fabricar seis arquivos com validades
   * diferentes — e para que, um dia, um relatório de data passada seja
   * possível sem reescrever nada.
   */
  now = new Date(),
): ReadinessReport {
  ensureCoreSchema();
  const cfg = getFiscalConfig(companyId);
  const cert = getCertificateView(companyId, 'unit-default', now);
  /*
    A SENHA SELADA É PARTE DO CERTIFICADO UTILIZÁVEL (GAP-PRD-023).

    O A1 gravado antes de a senha passar a ser selada tem o arquivo e não tem a
    senha: o PDV e a fila param em FISCAL_CERTIFICATE_PASSWORD_REQUIRED na
    primeira venda. O item dizia PASS, AUTO_DETECTADO, sem uma palavra — e a
    frase certa já existia, só que no erro da hora da venda. Ela vem para cá,
    antes da venda. FAIL (e não PENDING) porque sem a senha a emissão
    automática não sai; o reenvio pela tela resolve sem código.
  */
  const senhaSelada = cert.certificate?.senhaGuardada === true;

  /*
    O A1 DE OUTRO CNPJ (auditoria P0 da Preço Justo). A conferência do upload
    compara com o CNPJ do emitente DAQUELE momento; trocar o CNPJ do emitente
    depois deixava no checklist um certificado de outra raiz como utilizável, e
    a recusa só chegava na assinatura, com a venda feita. Raiz igual continua
    aceita — a SEFAZ compara a raiz, e o A1 da matriz assina pela filial.
  */
  const cnpjDoA1 = String(cert.certificate?.documentNumber ?? cert.certificate?.cnpj ?? '').replace(/\D/g, '');
  const cnpjDoEmitente = String(cfg.cnpj ?? '').replace(/\D/g, '');
  const a1DeOutroCnpj =
    cert.configured
    && cnpjDoA1.length === 14
    && cnpjDoEmitente.length === 14
    && cnpjDoA1.slice(0, 8) !== cnpjDoEmitente.slice(0, 8)
      ? cnpjDoA1.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
      : null;

  const endereco = [cfg.street, cfg.number, cfg.district, cfg.cityName, cfg.uf]
    .filter(Boolean)
    .join(', ');

  /*
    O CÓDIGO IBGE QUE A TABELA DESMENTE (R3-IBGE). O emitente gravado antes da
    tabela passou só pelo formato. Com a tabela carregada, o item confere o
    código contra ela (existe, é da UF, é da cidade) e, divergente, é FAIL —
    o item está no portão de MONTAGEM, então NF-e e NFC-e recusam ANTES de
    numerar, em vez de a SEFAZ recusar depois.
  */
  const ibgeNoFormato = Boolean(cfg.cityIbge && /^\d{7}$/.test(cfg.cityIbge));
  const municipioErrado = ibgeNoFormato
    ? municipioDoEmitenteQueNaoConfere({ codigo: cfg.cityIbge, uf: cfg.uf, cidade: cfg.cityName })
    : null;

  const items: ReadinessItem[] = [
    check(
      'emitter',
      'Razão social',
      Boolean(cfg.legalName),
      'Informe a razão social do emitente.',
      { owner: 'gestor', known: cfg.legalName },
    ),
    check(
      'cnpj',
      'CNPJ',
      isValidCnpj(cfg.cnpj),
      cfg.cnpj ? 'O CNPJ informado é inválido.' : 'Informe o CNPJ do emitente.',
      {
        owner: 'gestor',
        known: cfg.cnpj,
        /*
          CNPJ GRAVADO E INVÁLIDO É DIVERGÊNCIA, não pendência — e a diferença
          muda o que a pessoa faz. "Pendente" manda preencher um campo vazio;
          "divergente" manda conferir um campo que ALGUÉM JÁ PREENCHEU e que a
          conta dos dígitos desmente. A rota de gravação recusa CNPJ inválido
          desde a rodada do readiness, então o único jeito de chegar aqui é
          banco herdado — que é exatamente o caso em que a tela precisa ser
          clara sobre o que aconteceu.
        */
        state: cfg.cnpj && !isValidCnpj(cfg.cnpj) ? 'DIVERGENTE' : undefined,
      },
    ),
    /*
      A INSCRIÇÃO ESTADUAL — no RS, o CGC/TE (auditoria P0 da Preço Justo).

      O contador passou "CGC/TE 093/0491475": no Rio Grande do Sul a IE se
      chama CGC/TE e é escrita 999/9999999. O item só perguntava "tem IE?", e
      um número com o dígito trocado passava verde até a SEFAZ recusá-lo
      (rejeição 209), com a nota já numerada. O rótulo agora diz o nome que o
      dono conhece, e o dígito verificador do RS é conferido.

      O NÚMERO NÃO É REESCRITO: a barra é formatação, o XML já leva só os
      dígitos, e o cadastro guarda o que foi digitado.

      Ausente continua travando (FAIL). Presente com o dígito errado é
      DIVERGENTE, mas PENDING e não FAIL: a conta é local, a palavra final é do
      cadastro da SEFAZ, e travar a loja inteira por uma conta nossa seria ser
      mais severo que o fisco. O aviso fica no checklist, com a consequência.
    */
    ((): ReadinessItem => {
      const doRs = String(cfg.uf ?? '').trim().toUpperCase() === 'RS';
      const rotulo = doRs ? 'Inscrição estadual (CGC/TE)' : 'Inscrição estadual';
      if (!cfg.ie) {
        return check(
          'ie',
          rotulo,
          false,
          doRs
            ? 'Informe a inscrição estadual — no RS, o número do CGC/TE (formato 999/9999999).'
            : 'Informe a inscrição estadual.',
          { owner: 'gestor', known: null },
        );
      }
      if (doRs && !ieDoRsConfere(cfg.ie)) {
        return {
          key: 'ie',
          label: rotulo,
          status: 'PENDING',
          detail:
            `A inscrição estadual gravada (${cfg.ie}) não confere com o dígito verificador do CGC/TE `
            + 'do RS: são 10 dígitos (3 do município, 6 do contribuinte e 1 verificador), no formato '
            + '999/9999999. Confira no cartão do CGC/TE — com a IE do emitente inválida, a SEFAZ '
            + 'recusa a nota depois de numerada (rejeição 209).',
          state: 'DIVERGENTE',
          source: 'cadastro',
          owner: 'gestor',
          known: cfg.ie,
          counts: null,
        };
      }
      return check('ie', rotulo, true, '', { owner: 'gestor', known: cfg.ie });
    })(),
    check(
      'crt',
      'Regime tributário (CRT)',
      CRTS_DO_LEIAUTE.includes(String(cfg.crt ?? '').trim()),
      cfg.crt
        ? `O CRT gravado ("${cfg.crt}") não existe no leiaute: os valores são 1 (Simples), 2 `
          + '(Simples com excesso de sublimite), 3 (regime normal) e 4 (MEI).'
        : 'Informe o CRT. Ele decide se o item usa CSOSN ou CST.',
      // O regime é decisão do CONTADOR, não do balcão: é ele que responde se a
      // empresa está no Simples e qual anexo. CRT fora do leiaute só chega por
      // banco herdado — a gravação o recusa — e é DIVERGENTE, não pendente.
      {
        owner: 'contador',
        known: cfg.crt,
        state:
          cfg.crt && !CRTS_DO_LEIAUTE.includes(String(cfg.crt).trim()) ? 'DIVERGENTE' : undefined,
      },
    ),
    check(
      'address',
      'Endereço',
      // O CEP entrou na régua com o XSD (GAP-PRD-097): o leiaute do emitente o
      // exige, e a nota sem ele é recusada antes de numerar.
      Boolean(
        cfg.street && cfg.number && cfg.district && cfg.cityName && cfg.uf
        && String(cfg.zip ?? '').replace(/\D/g, '').length === 8,
      ),
      'Endereço incompleto: logradouro, número, bairro, município, UF e CEP (8 dígitos) são obrigatórios.',
      { owner: 'gestor', known: endereco || null },
    ),
    check(
      'ibge',
      'Código IBGE do município',
      ibgeNoFormato && !municipioErrado,
      municipioErrado
        ? `O código IBGE do emitente não confere com a tabela oficial do IBGE: ${municipioErrado}. Com ele, `
          + 'a SEFAZ recusa a nota depois de numerada — ou a aceita com o município errado. Em Fiscal › '
          + 'Emitente, escolha a UF e o município na lista (o código vem junto) e salve.'
        : 'Informe o código IBGE do município (7 dígitos).',
      // Gravado e desmentido pela tabela é DIVERGENTE, não pendente: há um
      // código lá, e é o código errado.
      { owner: 'gestor', known: cfg.cityIbge, state: municipioErrado ? 'DIVERGENTE' : undefined },
    ),
    check(
      'certificate',
      'Certificado A1',
      cert.configured && senhaSelada && !a1DeOutroCnpj,
      !cert.configured
        ? 'Nenhum certificado carregado nesta operação.'
        : a1DeOutroCnpj
          ? `O certificado carregado é do CNPJ ${a1DeOutroCnpj}, de raiz diferente da do emitente `
            + 'desta operação. A SEFAZ recusa a assinatura por CNPJ que não é o do emitente: envie '
            + 'em Fiscal › Certificado o A1 desta operação, ou corrija o CNPJ do emitente.'
          : 'O arquivo está no cofre, mas a senha não: ele foi gravado antes de a senha passar a '
          + 'ser selada. Sem ela, o PDV e a fila não assinam sozinhos — cada nota pediria a senha. '
          + 'Reenvie o mesmo .pfx com a senha em Fiscal › Certificado: o reenvio sela a senha e '
          + 'preenche o titular e a conferência do CNPJ.',
      {
        owner: 'dono',
        source: 'certificado',
        /*
          O CERTIFICADO SE APRESENTA SOZINHO — é o exemplo mais puro da regra
          mestre desta rodada. Titular, emissor e validade estão DENTRO do
          arquivo: ninguém precisa digitá-los, e perguntá-los ao usuário seria
          pedir que ele copiasse à mão o que o sistema já leu.

          AUTO_DETECTADO, e não CONFIRMADO: o que se sabe veio do arquivo, não
          de alguém que respondeu por ele. A confirmação de que este é o
          certificado CERTO vem da conferência de CNPJ e, no fim, da SEFAZ.
        */
        // Sem a senha selada ainda há um gesto do dono a fazer: PENDENTE.
        // A1 de outra raiz é DIVERGENTE: há um arquivo lá, e é o arquivo errado.
        state: a1DeOutroCnpj
          ? 'DIVERGENTE'
          : cert.configured && senhaSelada
            ? 'AUTO_DETECTADO'
            : 'PENDENTE',
        known: cert.configured
          ? (String(cert.certificate?.subject ?? '') || 'certificado carregado')
          : null,
      },
    ),
    /*
      A VALIDADE DEIXOU DE SER UM PASS MUDO (GAP-V40).

      O item marcava PASS com `detail: null` enquanto o certificado estava a
      dias de vencer — o checklist ficava calado exatamente quando tinha algo
      a dizer, e o gestor só descobria pela tela do certificado da operação
      certa, se abrisse.

      Continua PASS de propósito: o certificado É válido, e virar FAIL travaria
      a emissão semanas antes da hora — a régua do que BLOQUEIA não pode ser a
      mesma do que AVISA. O que muda é o `detail`, que passa a carregar a frase
      da faixa.
    */
    {
      key: 'certificate_validity',
      label: 'Validade do certificado',
      status: cert.configured && cert.situation !== 'vencido' ? 'PASS' : 'FAIL',
      detail:
        !cert.configured
          ? 'Depende do certificado.'
          : cert.situation === 'vencido'
            ? cert.message
            : (cert.alerta?.message ?? null),
      /*
        DIVERGENTE quando VENCIDO, e não apenas pendente: a data está no
        arquivo e o relógio a desmente. Não há campo a preencher — há um
        certificado a trocar, e quem troca é o dono.
      */
      state: !cert.configured
        ? 'PENDENTE'
        : cert.situation === 'vencido'
          ? 'DIVERGENTE'
          : 'AUTO_DETECTADO',
      source: cert.configured ? 'certificado' : null,
      owner: 'dono',
      known: cert.configured
        ? (String(cert.certificate?.validTo ?? '') || `${cert.daysRemaining ?? '?'} dia(s)`)
        : null,
      counts: null,
    },
  ];

  /**
   * Certificado autoassinado é fixture, não credencial.
   *
   * Sem esta checagem o painel diria "Certificado A1 ✓" para um .pfx gerado em
   * teste, e o gestor só descobriria na primeira transmissão — a SEFAZ só
   * aceita cadeia ICP-Brasil. "Tem certificado" e "tem certificado que a SEFAZ
   * aceita" são coisas diferentes, e o checklist precisa dizer qual das duas.
   *
   * O que dá para afirmar localmente é o caso inequívoco: emissor igual ao
   * titular. A cadeia completa até a AC Raiz só se confirma na transmissão.
   */
  if (cert.configured) {
    const subject = String(cert.certificate?.subject ?? '');
    const issuer = String(cert.certificate?.issuer ?? '');
    const autoassinado = Boolean(subject) && subject === issuer;

    items.push(
      autoassinado
        ? {
            key: 'certificate_icp',
            label: 'Cadeia do certificado',
            status: 'FAIL',
            detail:
              'O certificado carregado é autoassinado (emissor igual ao titular). Serve para '
              + 'teste local; a SEFAZ só aceita cadeia ICP-Brasil.',
            // DIVERGENTE, e não pendente: o arquivo EXISTE e é o arquivo
            // errado. Não há campo a preencher — há um .pfx a substituir.
            state: 'DIVERGENTE',
            source: 'certificado',
            owner: 'dono',
            known: issuer,
            counts: null,
          }
        : {
            key: 'certificate_icp',
            label: 'Cadeia do certificado',
            // PENDING, e não PASS: a cadeia até a AC Raiz não é verificável
            // aqui sem o bundle da ICP-Brasil. Dizer PASS seria afirmar mais
            // do que se sabe, e o desmentido viria na transmissão.
            status: 'PENDING',
            detail:
              `Emissor: ${issuer || 'desconhecido'}. A cadeia até a AC Raiz só se confirma na `
              + 'transmissão à SEFAZ.'
              + (/teste|test/i.test(issuer)
                ? ' ATENÇÃO: o nome do emissor indica hierarquia de TESTE — a SEFAZ recusa.'
                : ''),
            /*
              BLOQUEADO EXTERNAMENTE é a resposta honesta: o que falta aqui não
              é trabalho de ninguém desta casa. Sem o bundle da ICP-Brasil,
              quem confirma a cadeia é a SEFAZ, na transmissão — e a tela que
              deixasse este item parecendo tarefa faria o gestor procurar por
              horas um botão que não existe.
            */
            state: 'BLOQUEADO_EXTERNAMENTE',
            source: 'certificado',
            owner: 'sefaz',
            known: issuer || null,
            counts: null,
          },
    );
  }

  /*
    A SÉRIE DO AMBIENTE (auditoria P0 da Preço Justo).

    O item perguntava só "existe série?" — contando até série inativa — e
    ficava verde com a série da produção servindo aos testes. Agora pergunta
    "existe série ATIVA para o ambiente em que esta operação emite?", com a
    mesma régua da emissão (`seriesDoAmbiente`), e avisa quando o teste da
    homologação está gastando a numeração que a produção vai usar.
  */
  const series = getSeries(companyId, model);
  const ativas = series.filter((s) => s.active);
  const doAmbiente = seriesDoAmbiente(companyId, model, cfg.environment);
  const ambienteDaOperacao = rotuloDoAmbienteDaSerie(cfg.environment);
  const usada = doAmbiente.length === 1 ? doAmbiente[0] : null;
  const avisoDaSerie =
    usada && usada.environment === null && cfg.environment === 'homologation'
      ? `A série ${usada.serie} serve aos dois ambientes: cada nota de teste da homologação gasta um `
        + 'número que a produção não poderá usar'
        + (usada.usadas.homologation > 0 ? ` (${usada.usadas.homologation} já gasto(s))` : '')
        + '. Para a primeira nota de produção sair no número definido pelo contador, marque a série '
        + `${usada.serie} como "só produção" e cadastre outra série "só homologação" para os testes, `
        + 'em Fiscal › Configuração › Numeração das notas.'
      : usada && cfg.environment === 'production' && usada.usadas.homologation > 0
        ? `${usada.usadas.homologation} nota(s) de homologação usaram números da série ${usada.serie}: `
          + `a produção segue do nº ${usada.nextNumber}, e os números anteriores nunca emitidos em `
          + 'produção pedem inutilização — confirme com o contador.'
        : null;
  const serieItem = check(
    'serie',
    model === MODEL_NFCE ? 'Série NFC-e' : 'Série NF-e',
    doAmbiente.length > 0,
    ativas.length > 0
      ? `Nenhuma série de ${ambienteDaOperacao} para este modelo: `
        + ativas
          .map((s) => `a série ${s.serie} está reservada para ${rotuloDoAmbienteDaSerie(s.environment!)}`)
          .join('; ')
        + `. Cadastre uma série "só ${ambienteDaOperacao}" em Fiscal › Configuração › Numeração das notas.`
      : 'Nenhuma série configurada para este modelo.',
    {
      owner: 'gestor',
      // O legado continua dito como sempre ("série 1"); a série marcada diz o ambiente.
      known:
        series.length > 0
          ? series
            .map((s) => (s.environment ? `série ${s.serie} (${rotuloDoAmbienteDaSerie(s.environment)})` : `série ${s.serie}`))
            .join(', ')
          : null,
    },
  );
  items.push(serieItem.status === 'PASS' && avisoDaSerie ? { ...serieItem, detail: avisoDaSerie } : serieItem);

  if (model === MODEL_NFCE) {
    // O CSC vive cifrado no cofre do NfceCscService. Aqui só se pergunta QUAL
    // existe em cada ambiente — o resumo nunca traz o token, justamente para o
    // checklist não ter motivo de tocar no segredo.
    items.push(itemDoCsc(companyId, cfg.environment));
    // O que fazer quando a SEFAZ cai com o cliente no balcão é pergunta do
    // CONTADOR (GAP-PRD-098): PENDING até ele decidir, nunca bloqueia.
    items.push(itemDeProntidaoDaContingencia(companyId));
  }

  /*
    ==========================================================================
    OS ITENS DE CATÁLOGO — onde a pergunta é "quantos de quantos"
    ==========================================================================

    "12 produtos sem NCM" é um susto sem tamanho: 12 de 15 é uma emergência,
    12 de 4 000 é uma tarde. A contagem com o total e o percentual é o que
    torna a lista acionável, e é a razão de `counts` existir.

    A PROCEDÊNCIA aqui separa o que a casa decidiu do que o arquivo do
    fornecedor sugeriu — dentro das MESMAS colunas do cadastro, os dois eram
    indistinguíveis até esta rodada.
  */
  /*
    A CLASSIFICAÇÃO QUE CONTA É A QUE A EMISSÃO USA (GAP-PRD-129).

    O produto sem NCM, CFOP ou origem próprios leva os do grupo tributário que
    vale para ele (o do perfil, ou o grupo único da operação) — é assim que a
    nota é montada (`completarPeloGrupo`). Contar só o produto fazia o checklist
    cobrar o que o grupo já resolve, e o gesto que classifica o catálogo
    inteiro de uma vez (preencher o CFOP no grupo) não mexia na contagem.
  */
  const catalogo = getConnection()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(NULLIF(TRIM(p.ncm), ''), NULLIF(TRIM(g.ncm), '')) IS NOT NULL
                       THEN 1 ELSE 0 END) AS com_ncm,
              SUM(CASE WHEN COALESCE(NULLIF(TRIM(p.cfop), ''), NULLIF(TRIM(g.cfop_internal), ''))
                            IS NOT NULL THEN 1 ELSE 0 END) AS com_cfop,
              SUM(CASE WHEN COALESCE(NULLIF(TRIM(p.origin), ''), NULLIF(TRIM(g.origin), ''))
                            IS NOT NULL THEN 1 ELSE 0 END) AS com_origem,
              SUM(CASE WHEN COALESCE(NULLIF(TRIM(p.cest), ''), NULLIF(TRIM(g.cest), '')) IS NOT NULL
                       THEN 1 ELSE 0 END) AS com_cest,
              SUM(CASE WHEN COALESCE(TRIM(p.cfop), '') = '' AND COALESCE(TRIM(g.cfop_internal), '') <> ''
                       THEN 1 ELSE 0 END) AS cfop_do_grupo,
              SUM(CASE WHEN COALESCE(TRIM(p.origin), '') = '' AND COALESCE(TRIM(g.origin), '') <> ''
                       THEN 1 ELSE 0 END) AS origem_do_grupo,
              SUM(CASE WHEN p.fiscal_confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmados
         FROM core_products p
         LEFT JOIN core_tax_groups g
                ON g.company_id = p.company_id AND g.active = 1
               AND g.code = COALESCE(
                     NULLIF(UPPER(TRIM(p.tax_profile)), ''),
                     (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(u.code) END
                        FROM core_tax_groups u
                       WHERE u.company_id = p.company_id AND u.active = 1))
        WHERE p.company_id = ? AND p.active = 1`,
    )
    .get(companyId) as Record<string, number | null>;

  const totalProdutos = Number(catalogo.total ?? 0);
  const comNcm = Number(catalogo.com_ncm ?? 0);
  const comCfop = Number(catalogo.com_cfop ?? 0);
  const comOrigem = Number(catalogo.com_origem ?? 0);
  const comCest = Number(catalogo.com_cest ?? 0);
  const confirmados = Number(catalogo.confirmados ?? 0);

  /*
    Quantos produtos têm sugestão do XML esperando um clique, e quantos têm
    valores em conflito. Uma consulta agregada, e não uma por produto: esta
    função roda a cada abertura da tela fiscal, duas vezes (um relatório por
    modelo), e um N+1 aqui apareceria no primeiro catálogo de verdade.
  */
  const sugestoes = getConnection()
    .prepare(
      `SELECT p.id,
              s.field,
              COUNT(DISTINCT s.value) AS valores,
              COALESCE(TRIM(CASE s.field WHEN 'ncm' THEN p.ncm WHEN 'cest' THEN p.cest
                                         ELSE p.origin END), '') AS atual
         FROM core_product_fiscal_suggestions s
         JOIN core_products p ON p.id = s.product_id AND p.active = 1
        WHERE s.company_id = ?
        GROUP BY p.id, s.field`,
    )
    .all(companyId) as unknown as { id: string; field: string; valores: number; atual: string }[];

  const sugeridosPorCampo = new Map<string, number>();
  const divergentesPorCampo = new Map<string, number>();
  for (const s of sugestoes) {
    const alvo = s.valores > 1 || (s.atual !== '' && s.valores >= 1) ? null : s.field;
    // Divergência: mais de um valor sugerido, ou um valor que contradiz o
    // cadastro. A comparação exata com o cadastro fica no serviço de
    // sugestões; aqui basta a contagem para o checklist não mentir por
    // omissão.
    if (s.valores > 1) {
      divergentesPorCampo.set(s.field, (divergentesPorCampo.get(s.field) ?? 0) + 1);
    } else if (alvo && s.atual === '') {
      sugeridosPorCampo.set(s.field, (sugeridosPorCampo.get(s.field) ?? 0) + 1);
    }
  }

  const semNcmC = totalProdutos - comNcm;
  const ncmSugeridos = sugeridosPorCampo.get('ncm') ?? 0;
  const ncmDivergentes = divergentesPorCampo.get('ncm') ?? 0;
  items.push({
    key: 'product_ncm',
    label: 'NCM dos produtos',
    status: semNcmC === 0 ? 'PASS' : 'FAIL',
    detail:
      semNcmC === 0
        ? null
        : `${semNcmC} de ${totalProdutos} produto(s) ativo(s) sem NCM. A emissão recusa item sem `
          + 'classificação fiscal.'
          + (ncmSugeridos > 0
            ? ` ${ncmSugeridos} já tem NCM sugerido pelo XML do fornecedor — confirme em lote.`
            : ''),
    state:
      ncmDivergentes > 0
        ? 'DIVERGENTE'
        : totalProdutos === 0
          ? 'NAO_APLICAVEL'
          : ncmSugeridos > 0
            ? 'AUTO_DETECTADO'
            : semNcmC > 0
              ? 'PENDENTE'
              : confirmados >= comNcm
                ? 'CONFIRMADO'
                : 'AUTO_DETECTADO',
    source: ncmSugeridos > 0 ? 'xml_fornecedor' : totalProdutos > 0 ? 'cadastro' : null,
    // O NCM é classificação fiscal da mercadoria: quem responde por ele é
    // quem responde pela apuração, não o balcão.
    owner: 'contador',
    known: null,
    counts: contar(comNcm, totalProdutos),
  });

  const semCfopC = totalProdutos - comCfop;
  items.push({
    key: 'product_cfop',
    label: 'CFOP dos produtos',
    status: semCfopC === 0 ? 'PASS' : 'FAIL',
    detail:
      (semCfopC === 0
        ? `${comCfop} produto(s) com CFOP de saída definido. `
        : `${semCfopC} de ${totalProdutos} produto(s) ativo(s) sem CFOP. `)
      + 'Este campo NUNCA é sugerido pelo XML de entrada: o CFOP que vem no arquivo do '
      + 'fornecedor é a operação de SAÍDA DELE, e a nossa depende do regime desta empresa e '
      + 'do destino da mercadoria. Quem o decide é o contador.',
    /*
      O CFOP NUNCA É AUTO-DETECTADO, e a frase abaixo existe para que ninguém
      "melhore" isto depois: o CFOP que vem no XML de entrada é a operação de
      SAÍDA DO FORNECEDOR (venda dele para nós). O nosso é o da nossa venda ao
      cliente, e depende do regime desta empresa e do destino da mercadoria.
      Herdá-lo produz nota autorizada com tributação errada — pior que nota
      recusada, porque a recusa aparece na hora e o imposto errado aparece na
      fiscalização.
    */
    state: totalProdutos === 0 ? 'NAO_APLICAVEL' : semCfopC > 0 ? 'PENDENTE' : 'CONFIRMADO',
    source: comCfop > 0 ? 'cadastro' : null,
    owner: 'contador',
    known: null,
    counts: contar(comCfop, totalProdutos),
  });

  const semOrigem = totalProdutos - comOrigem;
  const origemDoGrupo = Number(catalogo.origem_do_grupo ?? 0);
  const origemSugerida = sugeridosPorCampo.get('origin') ?? 0;
  items.push({
    key: 'product_origin',
    label: 'Origem da mercadoria',
    /*
      FAIL QUANDO A ORIGEM NÃO EXISTE EM LUGAR NENHUM (GAP-PRD-129).

      O item era PENDING "porque o grupo tributário supre" — e contava só o
      produto, sem olhar se havia grupo, nem se o grupo tinha origem. Quando
      nenhum dos dois a tem, a validação da nota RECUSA a venda (origem 0 a 8),
      e o checklist dizia "não bloqueia". Agora a contagem é a da emissão (o
      produto, ou o grupo que vale para ele), e o que falta nos dois trava — o
      mesmo tratamento do NCM e do CFOP.
    */
    status: semOrigem === 0 ? 'PASS' : 'FAIL',
    detail:
      semOrigem === 0
        ? (origemDoGrupo > 0
          ? `${origemDoGrupo} produto(s) sem origem própria usam a do grupo tributário.`
          : null)
        : `${semOrigem} de ${totalProdutos} produto(s) ativo(s) sem origem — nem no produto, nem `
          + 'no grupo tributário. A emissão recusa item sem origem (0 a 8).'
          + (origemSugerida > 0
            ? ` ${origemSugerida} já tem origem sugerida pelo XML do fornecedor.`
            : ''),
    state:
      (divergentesPorCampo.get('origin') ?? 0) > 0
        ? 'DIVERGENTE'
        : totalProdutos === 0
          ? 'NAO_APLICAVEL'
          : origemSugerida > 0
            ? 'AUTO_DETECTADO'
            : semOrigem > 0
              ? 'PENDENTE'
              : 'CONFIRMADO',
    source: origemSugerida > 0 ? 'xml_fornecedor' : comOrigem > 0 ? 'cadastro' : null,
    owner: 'contador',
    known: null,
    counts: contar(comOrigem, totalProdutos),
  });

  const cestSugerido = sugeridosPorCampo.get('cest') ?? 0;
  items.push({
    key: 'product_cest',
    label: 'CEST (substituição tributária)',
    /*
      PASS SEMPRE, e o estado é que fala.

      O CEST só existe para mercadoria sujeita a substituição tributária. Num
      catálogo em que nenhuma está, o campo vazio é a resposta CERTA — e um
      item vermelho cobrando o preenchimento seria uma pendência inventada,
      exatamente o tipo de alarme que ensina a ignorar todos os outros.
    */
    status: 'PASS',
    detail:
      comCest === 0 && cestSugerido === 0
        ? 'Nenhum produto declara CEST. Só se aplica a mercadoria sujeita a substituição '
          + 'tributária — vazio aqui é o normal do varejo comum.'
        : `${comCest} produto(s) com CEST.`
          + (cestSugerido > 0
            ? ` ${cestSugerido} com CEST sugerido pelo XML do fornecedor, aguardando confirmação.`
            : ''),
    state:
      (divergentesPorCampo.get('cest') ?? 0) > 0
        ? 'DIVERGENTE'
        : cestSugerido > 0
          ? 'AUTO_DETECTADO'
          : comCest > 0
            ? 'CONFIRMADO'
            : 'NAO_APLICAVEL',
    source: cestSugerido > 0 ? 'xml_fornecedor' : comCest > 0 ? 'cadastro' : null,
    owner: 'contador',
    known: null,
    counts: contar(comCest, totalProdutos),
  });

  /*
    A TRIBUTAÇÃO DO CATÁLOGO, pela régua da emissão (GAP-PRD-095).

    Sem este item o checklist dizia "pode emitir" com o grupo tributário sem
    pCredSN e sem CST de PIS/COFINS, e toda venda morria no clique. Ele roda a
    MESMA avaliação de `tributacaoDoItem` sobre o catálogo e diz, por grupo,
    tudo o que falta — dono: o contador.
  */
  items.push(itemDeProntidaoDaTributacao(companyId));

  // SEFAZ: PENDING de propósito. Só vira PASS com resposta real registrada.
  const autorizado = getConnection()
    .prepare(
      `SELECT COUNT(*) AS c FROM core_fiscal_documents
        WHERE company_id = ? AND model = ? AND status = 'AUTHORIZED' AND protocol IS NOT NULL`,
    )
    .get(companyId, model) as { c: number };

  const jaAutorizou = Number(autorizado.c) > 0;
  items.push({
    key: 'sefaz',
    label: 'Autorização real na SEFAZ',
    status: jaAutorizou ? 'PASS' : 'PENDING',
    detail: jaAutorizou
      ? null
      : 'Nenhum documento autorizado ainda. Exige certificado real e transmissão à SEFAZ de homologação.',
    /*
      BLOQUEADO EXTERNAMENTE — o estado que faltava para esta lista ser honesta.

      Este item nunca foi tarefa de ninguém desta casa, e a tela não tinha como
      dizer isso: ao lado de "informe a inscrição estadual", ele parecia mais
      um campo a preencher. Não é. Só uma transmissão real, com protocolo do
      fisco, o resolve — e é por isso que o dono dele é a SEFAZ.
    */
    state: jaAutorizou ? 'CONFIRMADO' : 'BLOQUEADO_EXTERNAMENTE',
    source: jaAutorizou ? 'sefaz' : null,
    owner: 'sefaz',
    known: null,
    counts: null,
  });

  const blocking = items.filter((i) => i.status === 'FAIL');
  const temCertificado = items.find((i) => i.key === 'certificate')?.status === 'PASS';

  // O readiness é DERIVADO. Não existe caminho para 'HOMOLOGATED' que não seja
  // um documento realmente autorizado, com protocolo, gravado no banco.
  const readiness: FiscalReadiness = jaAutorizou
    ? 'HOMOLOGATED'
    : blocking.length === 0 && temCertificado
      ? 'READY_FOR_SEFAZ_HOMOLOGATION'
      : 'READY_FOR_CERTIFICATE';

  return {
    companyId,
    model,
    readiness,
    canEmit: blocking.length === 0,
    items,
    blockingReasons: blocking.map((i) => `${i.label}: ${i.detail}`),
    certificateAlert: cert.alerta,
  };
}

/**
 * Portão de emissão.
 *
 * Chamado ANTES de numerar. Numerar e só então descobrir que falta o CNPJ
 * queimaria um número fiscal por erro de cadastro — e número queimado só se
 * resolve por inutilização.
 */
/**
 * Itens que travam a MONTAGEM do documento.
 *
 * Certificado e CSC não estão aqui de propósito: eles são necessários para
 * ASSINAR e para gerar o QR, não para montar o rascunho. Exigi-los na criação
 * impediria o PDV de registrar documentos enquanto o certificado está sendo
 * renovado — e é justamente aí que a fila precisa acumular para transmitir
 * depois, em vez de perder as vendas.
 *
 * NCM e CFOP dos produtos TAMBÉM não estão aqui, e essa ausência é deliberada.
 * O checklist conta os produtos incompletos do CATÁLOGO INTEIRO, o que serve
 * para o gestor priorizar — mas não pode barrar uma venda cujos itens estão
 * completos. Barrar assim pararia a loja toda por causa de um produto que
 * ninguém vendeu hoje. Quem valida a venda é `validateNfce`, item por item, e
 * aponta exatamente qual deles falta.
 */
const DOCUMENT_STAGE_KEYS = new Set([
  'emitter',
  'cnpj',
  'ie',
  'crt',
  'address',
  'ibge',
  'serie',
]);

export type EmissionStage = 'document' | 'transmission';

/**
 * Portão de emissão.
 *
 * `document` roda ANTES de numerar: descobrir que falta o CNPJ depois de
 * numerar queimaria um número fiscal por erro de cadastro, e número queimado
 * só se resolve por inutilização.
 *
 * `transmission` roda antes de assinar e enviar, e aí sim cobra certificado e
 * CSC.
 */
export function assertCanEmit(
  companyId: string,
  model: string,
  stage: EmissionStage = 'transmission',
  now = new Date(),
): ReadinessReport {
  const report = buildReadiness(companyId, model, now);

  const bloqueios = report.items.filter(
    (i) => i.status === 'FAIL' && (stage === 'transmission' || DOCUMENT_STAGE_KEYS.has(i.key)),
  );

  if (bloqueios.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_NOT_READY',
      `Emissão bloqueada. Pendências: ${bloqueios
        .map((i) => `${i.label}: ${i.detail}`)
        .join(' | ')}`,
      409,
      { readiness: report.readiness, stage, items: bloqueios },
    );
  }
  return report;
}

export const FISCAL_MODELS = [MODEL_NFCE, MODEL_NFE] as const;

// ------------------------------------------------- a chave da produção (V42)

/**
 * A PROVA de que a homologação aconteceu de verdade.
 *
 * Um documento autorizado, no ambiente de homologação, com protocolo do fisco.
 */
export interface HomologationEvidence {
  model: string;
  serie: number;
  number: number;
  protocol: string;
  authorizedAt: string | null;
}

export interface ProductionUnlockAssessment {
  companyId: string;
  /** Já destravada? */
  unlocked: boolean;
  unlockedAt: string | null;
  unlockedBy: string | null;
  /** Pode destravar AGORA? */
  canUnlock: boolean;
  /** O que falta, na ordem em que trava. Vazio quando `canUnlock`. */
  blockingReasons: string[];
  evidence: HomologationEvidence | null;
  /**
   * O QUE AINDA FALTA DEPOIS DESTE ATO.
   *
   * Destravar NÃO liga produção, e a tela precisa dizer isso com todas as
   * letras — senão o botão vira uma promessa que o sistema não cumpre, que é
   * o defeito que esta base já documentou em outras telas.
   */
  remainingSteps: string[];
}

/**
 * O DOCUMENTO REAL DE HOMOLOGAÇÃO — a régua que separa prova de ensaio.
 *
 * `buildReadiness` chama de HOMOLOGATED qualquer empresa com um AUTHORIZED com
 * protocolo, e o simulador produz exatamente isso. Usar aquele estado como
 * condição do desbloqueio deixaria a produção a um clique de um ENSAIO — nota
 * com valor jurídico emitida por quem só provou que o simulador responde.
 *
 * Aqui as marcas de ensaio são excluídas nominalmente, no espelho do filtro
 * que o pacote do contador usa para não entregar documento fabricado ao fisco.
 *
 * `COALESCE` em volta das colunas anuláveis não é zelo decorativo: em SQL,
 * `NULL NOT LIKE 'TEST-%'` é NULL, e NULL não passa no WHERE.
 */
function provaDaHomologacao(companyId: string): HomologationEvidence | null {
  const row = getConnection()
    .prepare(
      `SELECT model, serie, number, protocol, authorized_at
         FROM core_fiscal_documents
        WHERE company_id = ?
          AND status = 'AUTHORIZED'
          AND environment = 'homologation'
          AND COALESCE(TRIM(protocol), '') <> ''
          AND COALESCE(protocol, '') NOT LIKE ?
          AND COALESCE(xml_signed, '') NOT LIKE ?
        ORDER BY authorized_at DESC
        LIMIT 1`,
    )
    .get(companyId, `${TEST_PROTOCOL_PREFIX}%`, `%${FIXTURE_SIGNATURE_MARK}%`) as
    | Record<string, unknown>
    | undefined;

  if (!row) return null;
  return {
    model: String(row.model),
    serie: Number(row.serie),
    number: Number(row.number),
    protocol: String(row.protocol),
    authorizedAt: (row.authorized_at as string | null) ?? null,
  };
}

/**
 * A CADEIA INTEIRA, e não só o elo que este ato resolve.
 *
 * Três coisas precisam ser verdade para uma nota de VALOR JURÍDICO sair daqui,
 * e o desbloqueio é a primeira. Esconder as outras duas faria o botão prometer
 * o que ele não entrega.
 */
const PASSOS_RESTANTES = [
  'Virar o ambiente desta operação para "produção" em Fiscal › Configuração — outro ato, '
    + 'depois deste. Enquanto ele estiver em homologação, a nota emitida não tem valor fiscal.',
  'Gravar o CSC de PRODUÇÃO em Fiscal › Configuração — pode ser antes da virada, sem mexer no '
    + 'servidor: a SEFAZ emite códigos diferentes para homologação e produção, e em produção a '
    + 'NFC-e só aceita o de produção.',
  'Ter o servidor rodando fora do modo de desenvolvimento: com o ambiente em produção, o '
    + 'simulador é recusado na transmissão — nota autorizada por provider de teste não existe '
    + 'para o fisco.',
];

/**
 * O parecer honesto sobre o desbloqueio da produção.
 *
 * Não escreve nada. É a resposta que a tela mostra ANTES de existir botão para
 * clicar — e é ela que diz por que o botão está desligado.
 */
export function assessProductionUnlock(
  companyId: string,
  now = new Date(),
): ProductionUnlockAssessment {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT production_unlocked, production_unlocked_at, production_unlocked_by
         FROM core_fiscal_configs WHERE company_id = ?`,
    )
    .get(companyId) as Record<string, unknown> | undefined;

  const unlocked = row?.production_unlocked === 1;
  const evidence = provaDaHomologacao(companyId);
  const blocking: string[] = [];

  if (!evidence) {
    blocking.push(
      'Nenhuma nota autorizada de verdade na homologação. É preciso transmitir à SEFAZ de '
        + 'homologação e receber um protocolo real — autorização do simulador (protocolo '
        + `${TEST_PROTOCOL_PREFIX}…) não conta, e é por isso que ela não abre a produção.`,
    );
  } else {
    /*
      O CHECKLIST DO MODELO QUE FOI HOMOLOGADO, e só dele.

      Exigir os DOIS modelos prontos foi a primeira escrita, e estava errada:
      uma loja de varejo que só emite cupom nunca configura série de NF-e, e
      ficaria trancada para sempre por causa de um documento que ela não emite.
      A prova diz qual modelo atravessou a SEFAZ de verdade; é o cadastro DELE
      que precisa continuar de pé.
      O outro modelo não fica desprotegido: `assertCanEmit` cobra o checklist
      dele na hora de emitir, item por item — e é lá que a cobrança pertence.
    */
    const relatorio = buildReadiness(companyId, evidence.model, now);
    for (const item of relatorio.items) {
      if (item.status === 'FAIL') blocking.push(`${item.label}: ${item.detail}`);
    }
  }

  return {
    companyId,
    unlocked,
    unlockedAt: (row?.production_unlocked_at as string | null) ?? null,
    unlockedBy: (row?.production_unlocked_by as string | null) ?? null,
    canUnlock: !unlocked && blocking.length === 0,
    blockingReasons: blocking,
    evidence,
    remainingSteps: [...PASSOS_RESTANTES],
  };
}

/**
 * O ATO ADMINISTRATIVO DE DESTRAVAR A PRODUÇÃO — GAP-V42.
 *
 * As colunas `production_unlocked_at` e `production_unlocked_by` existiam desde
 * o schema e NENHUMA linha de código as escrevia: a produção só se ligava por
 * UPDATE na mão no banco, sem autor, sem data e sem trilha. Esta é a chave que
 * faltava para o portão que sempre existiu.
 *
 * IDEMPOTENTE, e não "já destravada é erro": o carimbo do PRIMEIRO ato é o que
 * vale — ele diz quem respondeu pela decisão. Reescrevê-lo a cada clique
 * apagaria justamente a informação pela qual a coluna existe.
 */
export function unlockProduction(input: {
  companyId: string;
  userId: string;
  now?: Date;
}): ProductionUnlockAssessment & { alreadyUnlocked: boolean } {
  ensureCoreSchema();
  const antes = assessProductionUnlock(input.companyId, input.now ?? new Date());

  if (antes.unlocked) return { ...antes, alreadyUnlocked: true };

  if (!antes.canUnlock) {
    throw new ApiError(
      'CORE_FISCAL_PRODUCTION_NOT_HOMOLOGATED',
      'Produção não pode ser liberada ainda. '
        + `Pendências: ${antes.blockingReasons.join(' | ')}`,
      409,
      { blockingReasons: antes.blockingReasons, evidence: antes.evidence },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const agora = (input.now ?? new Date()).toISOString();
    db.prepare(
      `UPDATE core_fiscal_configs
          SET production_unlocked = 1,
              production_unlocked_at = ?,
              production_unlocked_by = ?,
              updated_at = ?
        WHERE company_id = ?`,
    ).run(agora, input.userId, agora, input.companyId);

    return { ...assessProductionUnlock(input.companyId, input.now ?? new Date()), alreadyUnlocked: false };
  });
}

// ------------------------------------------------------- pendências fiscais

export interface ProductFiscalPendency {
  id: string;
  name: string;
  sku: string | null;
  internalCode: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  origin: string | null;
  taxProfile: string | null;
  /** O que impede este produto de entrar numa nota. */
  missing: string[];
}

/**
 * Produtos que bloqueiam a emissão.
 *
 * NÃO preenche nada. NCM, CFOP e origem são classificação fiscal: chutar um
 * valor "provável" produz nota autorizada com tributação errada, que é pior
 * que nota recusada — a recusa aparece na hora, o imposto errado aparece na
 * fiscalização.
 *
 * O papel desta lista é dizer, produto a produto, exatamente qual campo falta,
 * para que quem sabe a resposta preencha.
 */
export function listProductFiscalPendencies(companyId: string): ProductFiscalPendency[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT id, name, sku, internal_code, ncm, cest, cfop, origin, tax_profile
         FROM core_products
        WHERE company_id = ? AND active = 1
          AND ((ncm IS NULL OR TRIM(ncm) = '')
            OR (cfop IS NULL OR TRIM(cfop) = '')
            OR (origin IS NULL OR TRIM(origin) = ''))
        ORDER BY name`,
    )
    .all(companyId) as unknown as Record<string, unknown>[];

  return rows.map((r) => {
    const vazio = (v: unknown) => !v || String(v).trim() === '';
    const missing: string[] = [];
    if (vazio(r.ncm)) missing.push('NCM');
    if (vazio(r.cfop)) missing.push('CFOP');
    if (vazio(r.origin)) missing.push('origem');
    return {
      id: String(r.id),
      name: String(r.name),
      sku: (r.sku as string | null) ?? null,
      internalCode: (r.internal_code as string | null) ?? null,
      ncm: (r.ncm as string | null) ?? null,
      cest: (r.cest as string | null) ?? null,
      cfop: (r.cfop as string | null) ?? null,
      origin: (r.origin as string | null) ?? null,
      taxProfile: (r.tax_profile as string | null) ?? null,
      missing,
    };
  });
}

/**
 * Grava a classificação fiscal de um produto.
 *
 * NCM tem 8 dígitos e CFOP tem 4 — conferidos aqui porque um NCM de 7 dígitos
 * só seria recusado pela SEFAZ, depois da venda.
 */
export function updateProductFiscal(input: {
  companyId: string;
  productId: string;
  ncm?: string | null;
  cest?: string | null;
  cfop?: string | null;
  origin?: string | null;
  taxProfile?: string | null;
}): ProductFiscalPendency | null {
  ensureCoreSchema();

  const so = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
  if (input.ncm && so(input.ncm).length !== 8) {
    throw new ApiError('CORE_FISCAL_NCM_INVALID', 'O NCM tem 8 dígitos.', 400);
  }
  if (input.cfop && so(input.cfop).length !== 4) {
    throw new ApiError('CORE_FISCAL_CFOP_INVALID', 'O CFOP tem 4 dígitos.', 400);
  }
  if (input.cest && so(input.cest).length !== 7) {
    throw new ApiError('CORE_FISCAL_CEST_INVALID', 'O CEST tem 7 dígitos.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const existe = db
      .prepare('SELECT id FROM core_products WHERE id = ? AND company_id = ?')
      .get(input.productId, input.companyId) as { id?: string } | undefined;
    if (!existe?.id) {
      throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado nesta operação.', 404);
    }

    const mapa: Record<string, string> = {
      ncm: 'ncm',
      cest: 'cest',
      cfop: 'cfop',
      origin: 'origin',
      taxProfile: 'tax_profile',
    };
    const entradas = Object.entries(input).filter(([k]) => k in mapa);
    if (entradas.length > 0) {
      const sets = entradas.map(([k]) => `${mapa[k]} = ?`).join(', ');
      db.prepare(`UPDATE core_products SET ${sets}, updated_at = ? WHERE id = ?`).run(
        ...entradas.map(([, v]) => (v as string | null) ?? null),
        new Date().toISOString(),
        input.productId,
      );
    }

    return listProductFiscalPendencies(input.companyId).find((p) => p.id === input.productId) ?? null;
  });
}
