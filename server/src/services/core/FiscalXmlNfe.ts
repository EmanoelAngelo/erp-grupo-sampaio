/**
 * Gerador do XML da NF-e (modelo 55).
 *
 * COMPARTILHA com a NFC-e tudo que é comum — chave de acesso, formatação,
 * códigos de UF e de pagamento, validação de item. O que está aqui é só a
 * DIFERENÇA, e ela não é cosmética:
 *
 *  - DESTINATÁRIO É OBRIGATÓRIO. A NFC-e aceita consumidor não identificado;
 *    a NF-e não. Sem destinatário completo a nota é rejeitada.
 *  - `idDest` depende de comparar a UF do emitente com a do destinatário:
 *    operação interna, interestadual ou exterior mudam a tributação.
 *  - `tpImp` é retrato (1), não o formato de cupom (4).
 *  - `indPres` distingue venda presencial de venda pela internet — e é isso
 *    que permite a mesma NF-e servir ao balcão e ao e-commerce.
 *  - Transporte tem bloco próprio, com transportadora quando houver.
 *
 * Trocar apenas o número do modelo na NFC-e produziria um XML que a SEFAZ
 * recusa — e a recusa viria depois da venda.
 */
import {
  alcanceDoCfop,
  digitoDoCfopEsperado,
  impostoXml,
  totaisDoIcms,
  tributacaoDoItem,
  type DirecaoDaNota,
} from './TributacaoDoItem.js';
import { momentoFiscal } from './MomentoFiscal.js';
import { infAdProdXml, problemaDaIdentidadeNoItem } from './IdentidadeDaUnidadeFiscal.js';
import { mensagemVendaSoDeServico } from './FiscalVendaDaOficina.js';
import { ApiError } from '../../utils/errors.js';
import type { FiscalConfig } from './FiscalConfigService.js';
import {
  MODEL_NFE,
  buildAccessKey,
  environmentCode,
  isValidAccessKey,
  randomNumericCode,
} from './FiscalKeyService.js';
import { lerOperacao, natOpDaOperacao } from './FiscalOperacoes.js';
import {
  TPAG,
  UF_CODE,
  digits,
  gtinFiscal,
  money,
  qty,
  xmlEscape,
  type NfceSale,
  type ValidationProblem,
} from './FiscalXmlNfce.js';

/** Destinatário da NF-e. Diferente da NFC-e, não é opcional. */
export interface NfeRecipient {
  /** CPF (11) ou CNPJ (14) — só dígitos. */
  document: string;
  name: string;
  /**
   * Indicador de IE: 1 contribuinte, 2 isento, 9 não contribuinte.
   * Errar isto muda a tributação da operação.
   */
  ieIndicator: '1' | '2' | '9';
  ie?: string | null;
  /**
   * A mercadoria é para USO/CONSUMO do destinatário (indFinal 1), e não para
   * revenda ou industrialização (indFinal 0)?
   *
   * O defeito: o indFinal era deduzido só do indIEDest (contribuinte → 0). O
   * contribuinte que compra para uso próprio — a oficina que compra o
   * compressor que vai usar — é consumidor final, e a nota dizia revenda.
   * Ausente, vale a dedução de sempre; não contribuinte é sempre 1.
   */
  consumidorFinal?: boolean | null;
  street: string;
  number: string;
  complement?: string | null;
  district: string;
  cityName: string;
  cityIbge: string;
  uf: string;
  zip?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface NfeTransport {
  /**
   * 0 emitente, 1 destinatário, 2 terceiros, 3 próprio por conta do emitente,
   * 4 próprio por conta do destinatário, 9 sem frete.
   */
  modFrete: '0' | '1' | '2' | '3' | '4' | '9';
  carrierName?: string | null;
  carrierDocument?: string | null;
  freightCents?: number;
}

/** Presença do comprador — é o que distingue balcão de e-commerce. */
export type PresenceIndicator = '1' | '2' | '3' | '4' | '9';

export const PRESENCE_IN_PERSON: PresenceIndicator = '1';
export const PRESENCE_INTERNET: PresenceIndicator = '2';

/**
 * Valida o destinatário.
 *
 * Feito no BACKEND porque é o único lugar que não dá para pular. Um CNPJ com
 * 13 dígitos passa despercebido no formulário e vira rejeição depois da venda.
 */
export function validateRecipient(dest: NfeRecipient | null): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  if (!dest) {
    return [{ field: 'dest', message: 'NF-e exige destinatário identificado.' }];
  }

  const doc = digits(dest.document);
  if (doc.length !== 11 && doc.length !== 14) {
    problems.push({
      field: 'dest.CPF/CNPJ',
      message: 'Documento do destinatário deve ter 11 (CPF) ou 14 (CNPJ) dígitos.',
    });
  }
  if (!dest.name?.trim()) {
    problems.push({ field: 'dest.xNome', message: 'Nome ou razão social do destinatário ausente.' });
  }
  if (!['1', '2', '9'].includes(dest.ieIndicator)) {
    problems.push({
      field: 'dest.indIEDest',
      message: 'Indicador de inscrição estadual inválido (1 contribuinte, 2 isento, 9 não contribuinte).',
    });
  }
  // Contribuinte sem IE é contradição: ou tem inscrição, ou não é contribuinte.
  if (dest.ieIndicator === '1' && !dest.ie?.trim()) {
    problems.push({
      field: 'dest.IE',
      message: 'Destinatário marcado como contribuinte precisa da inscrição estadual.',
    });
  } else if (dest.ieIndicator === '1' && !digits(dest.ie)) {
    /*
      A IE VAI SÓ COM DÍGITOS (no RS, o CGC/TE). O defeito: "ISENTO" (ou
      qualquer texto sem dígito) passava pela conferência de "tem IE" e o XML
      saía com <IE></IE> — recusado pelo leiaute com o número já reservado.
    */
    problems.push({
      field: 'dest.IE',
      message:
        'A inscrição estadual do contribuinte vai só com dígitos na nota (no RS, o CGC/TE). '
        + '"ISENTO" não é inscrição: destinatário isento usa o indicador 2.',
    });
  }
  // Não contribuinte é sempre consumidor final (a SEFAZ recusa o contrário).
  if (dest.ieIndicator === '9' && dest.consumidorFinal === false) {
    problems.push({
      field: 'ide.indFinal',
      message:
        'Destinatário não contribuinte (indicador 9) é sempre consumidor final — a operação não '
        + 'pode ser marcada como revenda.',
    });
  }
  if (!dest.street?.trim() || !dest.number?.trim() || !dest.district?.trim()) {
    problems.push({ field: 'dest.enderDest', message: 'Endereço do destinatário incompleto.' });
  }
  if (digits(dest.cityIbge).length !== 7) {
    problems.push({
      field: 'dest.cMun',
      message: 'Código IBGE do município do destinatário ausente ou inválido.',
    });
  }
  if (!dest.uf || !UF_CODE[dest.uf.toUpperCase()]) {
    problems.push({ field: 'dest.UF', message: 'UF do destinatário ausente ou desconhecida.' });
  }

  return problems;
}

/**
 * Destino da operação.
 *
 * 1 interna, 2 interestadual, 3 exterior. Não é enfeite: a alíquota e o CFOP
 * dependem disso, e uma operação interestadual declarada como interna é
 * imposto recolhido a menor.
 */
export function destinationIndicator(emitUf: string, destUf: string): '1' | '2' | '3' {
  const a = emitUf.toUpperCase();
  const b = destUf.toUpperCase();
  if (!UF_CODE[b]) return '3';
  return a === b ? '1' : '2';
}

/**
 * O indFinal da nota: 1 consumidor final, 0 normal (revenda/industrialização).
 * Não contribuinte é sempre 1; o resto segue a declaração do destinatário e,
 * sem ela, a dedução de sempre (contribuinte → 0).
 */
export function indicadorDeConsumidorFinal(
  dest: Pick<NfeRecipient, 'ieIndicator' | 'consumidorFinal'>,
): '0' | '1' {
  if (dest.ieIndicator === '9') return '1';
  if (typeof dest.consumidorFinal === 'boolean') return dest.consumidorFinal ? '1' : '0';
  return dest.ieIndicator === '1' ? '0' : '1';
}

export interface BuiltNfe {
  xml: string;
  accessKey: string;
  numericCode: string;
  emissionType: string;
}

/**
 * Valida a NF-e inteira: emitente, destinatário, itens e totais.
 *
 * Reusa a validação de item da NFC-e — as regras de NCM, CFOP e origem são as
 * mesmas — e acrescenta o que só a NF-e exige.
 */
export function validateNfe(input: {
  sale: NfceSale;
  config: FiscalConfig;
  recipient: NfeRecipient | null;
  /** 'entrada' na nota de entrada emitida pela loja (devolução de venda). Padrão: saída. */
  direcao?: DirecaoDaNota;
}): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if (!input.config.legalName) {
    problems.push({ field: 'emit.xNome', message: 'Razão social ausente.' });
  }
  if (digits(input.config.cnpj).length !== 14) {
    problems.push({ field: 'emit.CNPJ', message: 'CNPJ do emitente ausente ou inválido.' });
  }
  if (!input.config.ie) problems.push({ field: 'emit.IE', message: 'Inscrição estadual ausente.' });
  if (!input.config.crt) problems.push({ field: 'emit.CRT', message: 'CRT ausente.' });
  if (!input.config.uf || !UF_CODE[input.config.uf.toUpperCase()]) {
    problems.push({ field: 'emit.UF', message: 'UF do emitente ausente ou desconhecida.' });
  }
  if (digits(input.config.cityIbge).length !== 7) {
    problems.push({ field: 'emit.cMun', message: 'Código IBGE do emitente ausente ou inválido.' });
  }
  // Mesmo portão da NFC-e: sem CEP o emitente não cumpre o leiaute (GAP-PRD-097).
  if (digits(input.config.zip).length !== 8) {
    problems.push({ field: 'emit.CEP', message: 'CEP do emitente ausente ou inválido (8 dígitos).' });
  }

  problems.push(...validateRecipient(input.recipient));

  // Venda que mistura peça e serviço com desconto no total, e venda só de
  // serviço: a nota de mercadoria diz o motivo, e o serviço vai à NFS-e
  // (GAP-PRD-024).
  if (input.sale.recusaDaSeparacao) {
    problems.push({ field: 'det', message: input.sale.recusaDaSeparacao });
  }
  if (input.sale.items.length === 0) {
    problems.push({
      field: 'det',
      message: input.sale.servicos?.length
        ? mensagemVendaSoDeServico(input.sale.servicos)
        : 'A operação não tem itens.',
    });
  }

  input.sale.items.forEach((item, index) => {
    const onde = `det[${index + 1}] ${item.description}`;
    if (digits(item.ncm).length !== 8) {
      problems.push({ field: `${onde} > NCM`, message: 'NCM ausente ou fora do formato.', itemIndex: index });
    }
    // A identidade da unidade cabe no campo do leiaute (GAP-PRD-026).
    const identidade = problemaDaIdentidadeNoItem(item);
    if (identidade) {
      problems.push({ field: `${onde} > infAdProd`, message: identidade, itemIndex: index });
    }
    if (digits(item.cfop).length !== 4) {
      problems.push({ field: `${onde} > CFOP`, message: 'CFOP ausente ou fora do formato.', itemIndex: index });
    } else if (input.recipient?.uf) {
      // O alcance do CFOP e o idDest dizem a mesma coisa — e a SEFAZ recusa
      // quando discordam. Conferido antes de numerar.
      const esperado = digitoDoCfopEsperado(input.config.uf, input.recipient.uf, input.direcao ?? 'saida');
      if (!digits(item.cfop).startsWith(esperado)) {
        problems.push({
          field: `${onde} > CFOP`,
          message:
            `CFOP ${digits(item.cfop)} é de ${alcanceDoCfop(digits(item.cfop))}, e esta nota é de `
            + `${alcanceDoCfop(esperado)} (idDest ${destinationIndicator(input.config.uf ?? '', input.recipient.uf)}). `
            + 'Informe o CFOP deste alcance no produto ou no grupo tributário.',
          itemIndex: index,
        });
      }
    }
    if (!item.origin || !/^[0-8]$/.test(String(item.origin).trim())) {
      problems.push({ field: `${onde} > origem`, message: 'Origem ausente ou inválida.', itemIndex: index });
    }
    if (!(item.quantity > 0)) {
      problems.push({ field: `${onde} > qCom`, message: 'Quantidade precisa ser maior que zero.', itemIndex: index });
    }
  });

  const somaItens = input.sale.items.reduce((s, i) => s + i.totalCents, 0);
  if (somaItens !== input.sale.totalCents) {
    problems.push({
      field: 'total.vNF',
      message: `A soma dos itens (${money(somaItens)}) não bate com o total (${money(input.sale.totalCents)}).`,
    });
  }

  return problems;
}

/** Monta o XML da NF-e modelo 55. */
export function buildNfeXml(input: {
  sale: NfceSale;
  config: FiscalConfig;
  recipient: NfeRecipient;
  serie: number;
  number: number;
  transport?: NfeTransport;
  presence?: PresenceIndicator;
  emissionType?: string;
  numericCode?: string;
  issuedAt?: Date;
  additionalInfo?: string;
  /** A natureza da operação. Ausente: a da operação desta empresa (venda ou devolução). */
  natOp?: string;
  /**
   * A NF-e de DEVOLUÇÃO (finNFe 4) — P0 fiscal. A devolução de VENDA é nota de
   * ENTRADA emitida pela loja (tpNF 0, CFOP 1202/2202 por padrão); a de COMPRA
   * é de saída (tpNF 1, 5202/6202). O CFOP, a natureza e o grupo tributário
   * vêm da operação fiscal da empresa (`FiscalOperacoes`), e a chave da nota
   * devolvida vai no NFref.
   */
  devolucao?: { operacao: 'devolucao_venda' | 'devolucao_compra'; chaveReferenciada: string };
}): BuiltNfe {
  const { sale, config, recipient, serie, number } = input;

  const operacaoDaDevolucao = input.devolucao ? lerOperacao(sale.companyId, input.devolucao.operacao) : null;
  const direcao = operacaoDaDevolucao?.direcao ?? 'saida';
  const problems = validateNfe({ sale, config, recipient, direcao });
  if (input.devolucao && !isValidAccessKey(digits(input.devolucao.chaveReferenciada))) {
    problems.push({
      field: 'ide.NFref',
      message:
        'A chave da nota devolvida não é uma chave de acesso válida (44 dígitos, com o dígito verificador certo).',
    });
  }
  if (problems.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_DOCUMENT_INVALID',
      `A NF-e não pode ser montada: ${problems.map((p) => `${p.field} — ${p.message}`).join(' | ')}`,
      409,
      { problems },
    );
  }

  const issuedAt = input.issuedAt ?? new Date();
  const emissionType = input.emissionType ?? '1';
  const numericCode = input.numericCode ?? randomNumericCode(number);
  const uf = config.uf!.toUpperCase();
  const ufCode = UF_CODE[uf];

  /*
    O INSTANTE DA EMISSÃO, NO RELÓGIO DE QUEM EMITE.

    Daqui saem as DUAS respostas: o `dhEmi` do XML e o AAMM da chave. Elas
    saíam de lugares diferentes e discordavam — e cada uma, sozinha,
    bastava para a SEFAZ rejeitar a nota.
  */
  const { dhEmi, aamm } = momentoFiscal(issuedAt, uf);
  const destUf = recipient.uf.toUpperCase();

  const accessKey = buildAccessKey({
    ufCode,
    aamm,
    cnpj: config.cnpj!,
    model: MODEL_NFE,
    serie,
    number,
    emissionType,
    numericCode,
  });

  const doc = digits(recipient.document);
  const tagDoc = doc.length === 14 ? 'CNPJ' : 'CPF';
  const transport = input.transport ?? { modFrete: '9' as const };
  const presence = input.presence ?? PRESENCE_IN_PERSON;

  /*
    A TRIBUTAÇÃO VEM DA OPERAÇÃO, e o bloco <imposto> é montado num lugar
    só — NF-e e NFC-e carregam o mesmo. Duas cópias divergiriam no dia em
    que a legislação mudasse, e a divergência apareceria como rejeição em
    um dos dois modelos.

    A resolução acontece AQUI, UMA vez por linha e ANTES do `<det>`, porque o
    TOTAL precisa dos mesmos números (`vIpiCents`, `vPisCents`, `vCofinsCents`)
    que o item declara. Foi o contrário disto que produziu a incoerência que
    esta rodada remove: a NFC-e passou a somar o IPI e a NF-e ficou com o
    literal `0.00`, porque nada obrigava os dois a saírem da mesma conta.
  */
  const tributacoes = sale.items.map((item, index) =>
    tributacaoDoItem({
      companyId: sale.companyId,
      ufDestinatario: destUf,
      // Na devolução, o CFOP e o grupo são os da OPERAÇÃO, e a direção decide o alcance (1/2 ou 5/6).
      direcao,
      cfopDaOperacao: operacaoDaDevolucao
        ? { interno: operacaoDaDevolucao.cfopInterno, interestadual: operacaoDaDevolucao.cfopInterestadual }
        : null,
      grupoDaOperacao: operacaoDaDevolucao?.grupoTributario ?? null,
      produto: {
        id: item.productId ?? item.internalCode ?? String(index + 1),
        description: item.description,
        taxProfile: item.taxProfile ?? null,
        origin: item.origin,
        cfop: item.cfop,
        ncm: item.ncm,
        cest: item.cest,
        totalCents: item.totalCents,
      },
    }),
  );

  const det = sale.items
    .map((item, index) => {
      const impostoDoItem = impostoXml(tributacoes[index], {
        id: item.productId ?? String(index + 1),
        description: item.description,
        totalCents: item.totalCents,
      });

      // A mesma régua da NFC-e (A-produto-05): o EAN interno da loja (prefixo 2),
      // o código alfanumérico e o verificador errado são "SEM GTIN".
      const gtin = gtinFiscal(item.barcode);
      const unidade = (item.unit ?? 'UN').trim().toUpperCase().slice(0, 6);
      const cest = item.cest ? `\n          <CEST>${digits(item.cest)}</CEST>` : '';

      return `    <det nItem="${index + 1}">
      <prod>
        <cProd>${xmlEscape(item.internalCode || item.productId || String(index + 1))}</cProd>
        <cEAN>${gtin}</cEAN>
        <xProd>${xmlEscape(item.description)}</xProd>
        <NCM>${digits(item.ncm)}</NCM>${cest}${
          // O benefício fiscal da UF, quando o grupo o declara (GAP-PRD-021):
          // no leiaute ele vem depois do CEST e antes do CFOP.
          tributacoes[index].cBenef
            ? `\n        <cBenef>${xmlEscape(tributacoes[index].cBenef!)}</cBenef>`
            : ''
        }
        <CFOP>${digits(tributacoes[index].cfop)}</CFOP>
        <uCom>${xmlEscape(unidade)}</uCom>
        <qCom>${qty(item.quantity)}</qCom>
        <vUnCom>${money(item.unitPriceCents)}</vUnCom>
        <vProd>${money(item.totalCents + item.discountCents)}</vProd>
        <cEANTrib>${gtin}</cEANTrib>
        <uTrib>${xmlEscape(unidade)}</uTrib>
        <qTrib>${qty(item.quantity)}</qTrib>
        <vUnTrib>${money(item.unitPriceCents)}</vUnTrib>${
          item.discountCents > 0 ? `\n        <vDesc>${money(item.discountCents)}</vDesc>` : ''
        }
        <indTot>1</indTot>
      </prod>
${impostoDoItem}${infAdProdXml(item.unidades, xmlEscape)}
    </det>`;
    })
    .join('\n');

  const pag = sale.payments.length
    ? sale.payments
        .map(
          (p) => `      <detPag>
        <tPag>${TPAG[p.method] ?? '99'}</tPag>
        <vPag>${money(p.amountCents)}</vPag>
      </detPag>`,
        )
        .join('\n')
    : `      <detPag>
        <tPag>90</tPag>
        <vPag>0.00</vPag>
      </detPag>`;

  const vDesc = sale.items.reduce((s, i) => s + i.discountCents, 0);
  const frete = transport.freightCents ?? 0;

  /*
    OS TOTAIS DE IMPOSTO SOMAM O QUE OS ITENS DECLARAM — e deixam de ser
    literais no modelo 55 (GAP-V08, a metade que tinha ficado para trás).

    `<vIPI>` virou `money(...)` na NFC-e numa rodada anterior e AQUI continuou
    `0.00` cravado, apesar de os dois modelos usarem o mesmo `tributacaoDoItem`.
    Era inofensivo só porque o destaque de IPI é recusado por desenho — e era
    justamente por isso que ninguém percebia.

    `<vPIS>` e `<vCOFINS>` são INFORMATIVOS no `<ICMSTot>`: não entram na soma
    do `vNF`, que continua sendo `vProd − vDesc + vFrete`. Por isso o valor
    verdadeiro pode sair sem que o total deixe de bater com os `<pag>`.
  */
  const vIpi = tributacoes.reduce((soma, t) => soma + t.vIpiCents, 0);
  const vPis = tributacoes.reduce((soma, t) => soma + t.vPisCents, 0);
  const vCofins = tributacoes.reduce((soma, t) => soma + t.vCofinsCents, 0);
  // E o ICMS (GAP-PRD-021): base, valor e FCP somam o que os itens declaram.
  const icmsTotal = totaisDoIcms(tributacoes);

  const transportadora =
    transport.carrierName && transport.carrierDocument
      ? `\n      <transporta>
        <${digits(transport.carrierDocument).length === 14 ? 'CNPJ' : 'CPF'}>${digits(
          transport.carrierDocument,
        )}</${digits(transport.carrierDocument).length === 14 ? 'CNPJ' : 'CPF'}>
        <xNome>${xmlEscape(transport.carrierName)}</xNome>
      </transporta>`
      : '';

  const infAdic = input.additionalInfo
    ? `
    <infAdic>
      <infCpl>${xmlEscape(input.additionalInfo)}</infCpl>
    </infAdic>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe versao="4.00" Id="NFe${accessKey}">
    <ide>
      <cUF>${ufCode}</cUF>
      <cNF>${numericCode}</cNF>
      <natOp>${xmlEscape(input.natOp ?? natOpDaOperacao(sale.companyId, input.devolucao?.operacao ?? 'venda_nfe'))}</natOp>
      <mod>${MODEL_NFE}</mod>
      <serie>${serie}</serie>
      <nNF>${number}</nNF>
      <dhEmi>${dhEmi}</dhEmi>
      <tpNF>${direcao === 'entrada' ? '0' : '1'}</tpNF>
      <idDest>${destinationIndicator(uf, destUf)}</idDest>
      <cMunFG>${digits(config.cityIbge)}</cMunFG>
      <tpImp>1</tpImp>
      <tpEmis>${emissionType}</tpEmis>
      <cDV>${accessKey.slice(-1)}</cDV>
      <tpAmb>${environmentCode(config.environment)}</tpAmb>
      <finNFe>${input.devolucao ? '4' : '1'}</finNFe>
      <indFinal>${indicadorDeConsumidorFinal(recipient)}</indFinal>
      <indPres>${presence}</indPres>
      <procEmi>0</procEmi>
      <verProc>GrupoSampaio-1.0</verProc>${
        // O NFref é o último filho do <ide> no leiaute 4.00.
        input.devolucao
          ? `
      <NFref>
        <refNFe>${digits(input.devolucao.chaveReferenciada)}</refNFe>
      </NFref>`
          : ''
      }
    </ide>
    <emit>
      <CNPJ>${digits(config.cnpj)}</CNPJ>
      <xNome>${xmlEscape(config.legalName!)}</xNome>${
        config.tradeName ? `\n      <xFant>${xmlEscape(config.tradeName)}</xFant>` : ''
      }
      <enderEmit>
        <xLgr>${xmlEscape(config.street!)}</xLgr>
        <nro>${xmlEscape(config.number!)}</nro>${
          config.complement ? `\n        <xCpl>${xmlEscape(config.complement)}</xCpl>` : ''
        }
        <xBairro>${xmlEscape(config.district!)}</xBairro>
        <cMun>${digits(config.cityIbge)}</cMun>
        <xMun>${xmlEscape(config.cityName!)}</xMun>
        <UF>${uf}</UF>${config.zip ? `\n        <CEP>${digits(config.zip)}</CEP>` : ''}
        <cPais>1058</cPais>
        <xPais>BRASIL</xPais>
      </enderEmit>
      <IE>${digits(config.ie)}</IE>
      <CRT>${digits(config.crt)}</CRT>
    </emit>
    <dest>
      <${tagDoc}>${doc}</${tagDoc}>
      <xNome>${xmlEscape(recipient.name)}</xNome>
      <enderDest>
        <xLgr>${xmlEscape(recipient.street)}</xLgr>
        <nro>${xmlEscape(recipient.number)}</nro>${
          recipient.complement ? `\n        <xCpl>${xmlEscape(recipient.complement)}</xCpl>` : ''
        }
        <xBairro>${xmlEscape(recipient.district)}</xBairro>
        <cMun>${digits(recipient.cityIbge)}</cMun>
        <xMun>${xmlEscape(recipient.cityName)}</xMun>
        <UF>${destUf}</UF>${recipient.zip ? `\n        <CEP>${digits(recipient.zip)}</CEP>` : ''}
        <cPais>1058</cPais>
        <xPais>BRASIL</xPais>${
          recipient.phone ? `\n        <fone>${digits(recipient.phone)}</fone>` : ''
        }
      </enderDest>
      <indIEDest>${recipient.ieIndicator}</indIEDest>${
        recipient.ieIndicator === '1' && recipient.ie
          ? `\n      <IE>${digits(recipient.ie)}</IE>`
          : ''
      }${recipient.email ? `\n      <email>${xmlEscape(recipient.email)}</email>` : ''}
    </dest>
${det}
    <total>
      <ICMSTot>
        <vBC>${money(icmsTotal.vBcCents)}</vBC>
        <vICMS>${money(icmsTotal.vIcmsCents)}</vICMS>
        <vICMSDeson>0.00</vICMSDeson>
        <vFCP>${money(icmsTotal.vFcpCents)}</vFCP>
        <vBCST>0.00</vBCST>
        <vST>0.00</vST>
        <vFCPST>0.00</vFCPST>
        <vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${money(sale.totalCents + vDesc)}</vProd>
        <vFrete>${money(frete)}</vFrete>
        <vSeg>0.00</vSeg>
        <vDesc>${money(vDesc)}</vDesc>
        <vII>0.00</vII>
        <vIPI>${money(vIpi)}</vIPI>
        <vIPIDevol>0.00</vIPIDevol>
        <vPIS>${money(vPis)}</vPIS>
        <vCOFINS>${money(vCofins)}</vCOFINS>
        <vOutro>0.00</vOutro>
        <vNF>${money(sale.totalCents + frete)}</vNF>
      </ICMSTot>
    </total>
    <transp>
      <modFrete>${transport.modFrete}</modFrete>${transportadora}
    </transp>
    <pag>
${pag}
    </pag>${infAdic}
  </infNFe>
</NFe>`;

  return { xml, accessKey, numericCode, emissionType };
}
