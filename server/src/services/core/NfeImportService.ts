/**
 * Entrada de estoque por XML de NF-e.
 *
 * O fluxo é deliberadamente em DUAS etapas, como no balcão real:
 *
 *   1. importar  -> lê o XML, casa os itens com o catálogo e guarda a nota
 *                   como CONFERÊNCIA. Nada de estoque acontece aqui.
 *   2. confirmar -> depois que alguém conferiu, aplica a entrada.
 *
 * Idempotência: a chave de acesso é única por empresa. Reimportar o mesmo
 * arquivo devolve a nota já existente em vez de duplicar entrada e contas a
 * pagar — o erro mais caro desse fluxo.
 */
import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement, getBalance } from './InventoryService.js';
import { createUnits, isSerialized } from './ProductUnitService.js';
import { systemCategoryId } from './FinanceSetupService.js';
import { NOTA_ESTORNADA, NOTA_IMPORTADA, NOTA_RECEBIDA } from './InboundNoteStatus.js';
import { getInboundConfig } from './InboundConfigService.js';
import { createProduct } from './CatalogService.js';
import { findProductByAnyBarcode } from './CatalogAuxService.js';
import { gtinValido, pareceGtin } from './Gtin.js';
import { loadSupplier } from './SupplierService.js';
import { recalcReceived } from './PurchaseOrderService.js';
import { diaDaLoja, somarDias } from './CalendarioOperacional.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { recordSuggestionsFromNote } from './FiscalSuggestionService.js';
import { limitarDeslocamento, limitarPagina } from './paginacao.js';
import { recordAudit } from '../audit/AuditService.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';

/**
 * Soma dias A UM INSTANTE, pelo calendário da loja.
 *
 * ## O DEFEITO QUE ESTA FUNÇÃO EXISTE PARA FECHAR
 *
 * O corpo daqui era `new Date(`${iso.slice(0, 10)}T12:00:00.000Z`)` — e esse
 * recorte responde o dia de GREENWICH. O meio-dia UTC protegia contra o
 * escorregão do horário de verão, que é um cuidado legítimo, mas o dia de onde
 * ele partia já vinha errado: quem chamava passava `now`, um INSTANTE.
 *
 * O estrago aparecia na MESMA instrução INSERT que grava a dívida da compra: a
 * competência sai de `diaDaLoja(now)` e o vencimento saía do dia de Greenwich.
 * Entre 21h e a meia-noite em Pelotas os dois discordam — e a carga
 * descarregada às 22h30 com trinta dias de prazo nascia vencendo TRINTA E UM
 * dias depois da própria entrada. O cadastro do fornecedor dizia "30 dias" na
 * tela e o sistema pagava no trigésimo primeiro.
 *
 * O conserto é o mesmo de `SalesService.diaMais`, e por isso a assinatura ficou
 * idêntica: converter o instante para o dia da LOJA antes de somar, e nomear o
 * parâmetro `instante` para que nenhum apelido futuro possa disfarçar um
 * instante de data de calendário. `somarDias` (em `CalendarioOperacional`) já
 * guarda o meio-dia UTC que este corpo protegia à mão.
 *
 * Continuam sendo duas funções pequenas e privadas: unificá-las num utilitário
 * criaria um acoplamento entre compras e vendas por uma linha de data.
 */
function diaMaisNaCompra(instante: string, dias: number): string {
  return somarDias(diaDaLoja(instante), dias);
}

export interface ParsedNfeItem {
  supplierCode: string | null;
  barcode: string | null;
  description: string;
  ncm: string | null;
  cfop: string | null;
  /**
   * O CEST e a ORIGEM que o fornecedor DECLAROU — lidos e jogados fora até
   * agora.
   *
   * Os dois descrevem A MERCADORIA (o que ela é, de onde ela veio), não a
   * tributação de quem a vende: por isso viajam, enquanto o CFOP do arquivo
   * fica onde está. O CFOP dele é a SAÍDA DELE.
   *
   * `origin` mora em `<imposto><ICMS><ICMS**><orig>`, e não em `<prod>`: é o
   * único dos três que vem de dentro do grupo de imposto, e procurá-lo no
   * lugar errado devolveria nulo em toda nota do mundo.
   */
  cest: string | null;
  origin: string | null;
  unit: string | null;
  quantity: number;
  /** A unidade tributável da nota — a menor unidade do item. */
  unitTrib: string | null;
  /** A quantidade NA unidade tributável. Com `qCom`, dá o fator. */
  quantityTrib: number | null;
  unitCostCents: number;
  totalCents: number;
  /**
   * A tributação que o FORNECEDOR declarou neste item (GAP-PRD-181) — a da
   * SAÍDA dele. Fica guardada como matéria do contador (crédito, conferência)
   * e NUNCA vira tributação do produto: a nossa venda é decisão do contador.
   * Opcional porque o item de uma entrada digitada não tem arquivo.
   */
  taxes?: ParsedNfeItemTaxes;
  /**
   * O GTIN DA UNIDADE TRIBUTÁVEL (`cEANTrib`) — B-estoque-entrada-05.
   *
   * Era ignorado: o parser lia só o `cEAN`. O distribuidor que fatura em caixa
   * manda no `cEAN` o DUN-14 da caixa (ou "SEM GTIN") e no `cEANTrib` o EAN da
   * UNIDADE — justamente o código que a loja cadastrou e bipa no PDV. Sem ele
   * o item não casava com o produto que já existia e virava duplicata, e o
   * produto criado pela nota nascia com o código da caixa. Nulo quando ausente,
   * "SEM GTIN" ou com verificador errado — a mesma régua do `cEAN`.
   */
  barcodeTrib?: string | null;
  /** `cEAN` declarado como "SEM GTIN" — diferente de "não veio código". */
  semGtin?: boolean;
  /**
   * AS PARCELAS DO VALOR DO ITEM QUE O CUSTO IGNORAVA — B-estoque-entrada-09.
   *
   * `vDesc`, `vFrete`, `vSeg` e `vOutro` de `<prod>`, em centavos (zero quando
   * a nota não declara). Com o IPI e o ICMS-ST de `taxes`, são o que separa o
   * preço de tabela do fornecedor (`vUnCom`) do que a mercadoria custou de
   * fato à loja. Ver `custoEfetivoDaLinhaCents`.
   */
  discountCents?: number;
  freightCents?: number;
  insuranceCents?: number;
  otherCents?: number;
}

/**
 * O PROTOCOLO DE AUTORIZAÇÃO DA SEFAZ que acompanha o XML (`protNFe/infProt`) —
 * B-estoque-entrada-M02. Nulo quando o arquivo é o `<NFe>` solto, sem
 * protocolo: o XML gerado ANTES da autorização, que o fisco pode nunca ter
 * aceitado.
 */
export interface ParsedNfeAuthorization {
  cStat: string | null;
  xMotivo: string | null;
  chNFe: string | null;
  protocol: string | null;
}

/** CST/CSOSN e valores declarados no item. Nulo é "não declarado", nunca zero. */
export interface ParsedNfeItemTaxes {
  icmsCst: string | null;
  icmsCsosn: string | null;
  icmsCents: number | null;
  icmsStCents: number | null;
  ipiCst: string | null;
  ipiCents: number | null;
  pisCst: string | null;
  pisCents: number | null;
  cofinsCst: string | null;
  cofinsCents: number | null;
}

/** O emitente além de nome e documento: o cadastro que o arquivo já traz. */
export interface ParsedNfeSupplier {
  tradeName: string | null;
  stateRegistration: string | null;
  crt: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  /** <cMun>: o código IBGE do município do emitente, 7 dígitos. */
  cityIbge: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
}

/** Para quem a nota foi emitida — a conferência de que ela é desta loja. */
export interface ParsedNfeRecipient {
  document: string | null;
  name: string | null;
  stateRegistration: string | null;
}

/**
 * O grupo <transp> da nota — quem trouxe a mercadoria até a porta.
 *
 * Era descartado inteiro. Quem confere na doca precisa saber quantos volumes
 * esperar e quanto deveriam pesar, e quem cobra falta precisa saber para quem
 * ligar; as duas respostas estavam no arquivo o tempo todo.
 */
export interface ParsedNfeTransport {
  carrierName: string | null;
  carrierDocument: string | null;
  carrierStateRegistration: string | null;
  carrierCity: string | null;
  carrierState: string | null;
  /**
   * Dígito cru do <modFrete>. Domínio {0,1,2,3,4,9} — 5, 6, 7 e 8 NÃO existem
   * no layout 4.00. Nulo quando a nota não declara o grupo.
   */
  freightMode: string | null;
  vehiclePlate: string | null;
  vehicleUf: string | null;
  volumesQty: number | null;
  grossWeightGrams: number | null;
  netWeightGrams: number | null;
}

export interface ParsedNfe {
  accessKey: string;
  number: string | null;
  series: string | null;
  issuedAt: string | null;
  supplierName: string | null;
  supplierDocument: string | null;
  /** O resto do emitente: IE, CRT, endereço, IBGE, telefone (GAP-PRD-181). */
  supplier: ParsedNfeSupplier;
  /** <ide><mod>: 55 (NF-e) ou 65 (NFC-e). */
  model: string | null;
  recipient: ParsedNfeRecipient;
  totalCents: number;
  /** Vem de ICMSTot/vFrete: o valor do frete nunca morou em <transp>. */
  freightCents: number;
  transport: ParsedNfeTransport;
  items: ParsedNfeItem[];
  /**
   * Em que ambiente a SEFAZ autorizou a nota: `ide/tpAmb` (1 produção, 2
   * homologação) e, sem ele, o `tpAmb` do protocolo. Nulo quando o arquivo não
   * diz — R3-DFE (GAP-PRD-168).
   */
  environment: AmbienteDaNota | null;
  /** O protocolo de autorização, quando o arquivo é o `nfeProc` (M02). */
  authorization: ParsedNfeAuthorization | null;
}

/** Converte string monetária do XML (ponto decimal) para centavos inteiros. */
function toCents(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // Nó com filhos vira "[object Object]" no String(): devolver isso seria lixo
  // que passa em qualquer teste de "não é nulo". Grupo se percorre, não se lê.
  if (typeof value === 'object') return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/**
 * Quilos do XML para GRAMAS inteiras.
 *
 * O peso vem como texto com 3 casas ("12.500"), e 3 casas de quilo é
 * exatamente grama: a conversão é exata e não sobra float para arredondar
 * errado depois.
 *
 * Existe separada de `toCents` de propósito. Aquela multiplica por 100 porque
 * é helper de DINHEIRO; passar peso por ela transformaria 12,500 kg em 1250, e
 * ninguém notaria até a balança da doca discordar do papel.
 */
function toGrams(value: unknown): number | null {
  const t = text(value);
  if (t === null) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

/**
 * A ORIGEM DA MERCADORIA, de dentro do grupo de ICMS do item.
 *
 * O layout da NF-e não tem uma tag <orig> fixa: ela mora dentro de UM filho de
 * <ICMS>, e QUAL filho depende do regime do emitente — ICMS00, ICMS20, ICMS60
 * para o regime normal, ICMSSN101 até ICMSSN900 para o Simples. São mais de
 * vinte variantes, e listá-las aqui daria uma lista que envelhece sozinha: no
 * dia em que a Receita criasse a vigésima primeira, este código passaria a
 * devolver "sem origem" para notas perfeitamente válidas, e ninguém saberia
 * por quê.
 *
 * Por isso a busca é pelo NOME DO CAMPO dentro de qualquer filho de <ICMS>: o
 * layout garante que <orig> só existe ali, e que só há UM grupo de ICMS por
 * item. O que se procura é a informação, não o invólucro dela.
 *
 * Devolve `null` — e não '0' — quando a nota não declara. '0' significa
 * "nacional", e inventá-lo seria classificar como brasileira uma mercadoria
 * que ninguém examinou.
 */
function origemDoItem(det: Record<string, unknown>): string | null {
  const imposto = (det.imposto ?? {}) as Record<string, unknown>;
  const icms = imposto.ICMS as Record<string, unknown> | undefined;
  if (!icms || typeof icms !== 'object') return null;
  for (const grupo of Object.values(icms)) {
    if (!grupo || typeof grupo !== 'object') continue;
    const orig = text((grupo as Record<string, unknown>).orig);
    if (orig) return orig;
  }
  return null;
}

/** Dinheiro do XML em centavos — ou nulo quando a tag não veio. */
function centsOuNulo(value: unknown): number | null {
  const t = text(value);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Só os dígitos, ou nulo — CEP, telefone e código IBGE chegam com e sem máscara. */
function digitosOuNulo(value: unknown): string | null {
  const t = text(value);
  const d = t ? t.replace(/\D/g, '') : '';
  return d || null;
}

/**
 * Um campo de um grupo de imposto, onde quer que ele more (GAP-PRD-181).
 *
 * Cada grupo tem um filho que muda com o regime (ICMS00, ICMS10, ICMSSN102,
 * IPITrib, IPINT, PISAliq, PISNT...) e a lista cresce com o leiaute. Pelo mesmo
 * motivo de `origemDoItem`, procura-se o NOME DO CAMPO: primeiro no próprio
 * grupo (o IPI tem `cEnq` direto nele), depois em cada filho.
 */
function campoDoGrupo(grupo: unknown, campo: string): unknown {
  if (!grupo || typeof grupo !== 'object') return undefined;
  const g = grupo as Record<string, unknown>;
  if (g[campo] !== undefined) return g[campo];
  for (const filho of Object.values(g)) {
    if (filho && typeof filho === 'object') {
      const valor = (filho as Record<string, unknown>)[campo];
      if (valor !== undefined) return valor;
    }
  }
  return undefined;
}

/**
 * A tributação declarada no item — ICMS (com ST), IPI, PIS e COFINS.
 *
 * É a SAÍDA do fornecedor, guardada como ele a declarou. Nenhum destes
 * campos alcança o produto: CST, CSOSN e alíquota da nossa venda são decisão
 * do contador (ver o cabeçalho de FiscalSuggestionService).
 */
function tributosDoItem(det: Record<string, unknown>): ParsedNfeItemTaxes {
  const imposto = (det.imposto ?? {}) as Record<string, unknown>;
  return {
    icmsCst: text(campoDoGrupo(imposto.ICMS, 'CST')),
    icmsCsosn: text(campoDoGrupo(imposto.ICMS, 'CSOSN')),
    icmsCents: centsOuNulo(campoDoGrupo(imposto.ICMS, 'vICMS')),
    icmsStCents: centsOuNulo(campoDoGrupo(imposto.ICMS, 'vICMSST')),
    ipiCst: text(campoDoGrupo(imposto.IPI, 'CST')),
    ipiCents: centsOuNulo(campoDoGrupo(imposto.IPI, 'vIPI')),
    pisCst: text(campoDoGrupo(imposto.PIS, 'CST')),
    pisCents: centsOuNulo(campoDoGrupo(imposto.PIS, 'vPIS')),
    cofinsCst: text(campoDoGrupo(imposto.COFINS, 'CST')),
    cofinsCents: centsOuNulo(campoDoGrupo(imposto.COFINS, 'vCOFINS')),
  };
}

/** O <emit> inteiro, e não só nome e documento (GAP-PRD-181). */
function emitenteDoXml(emit: Record<string, unknown>): ParsedNfeSupplier {
  const ender = (emit.enderEmit ?? {}) as Record<string, unknown>;
  return {
    tradeName: text(emit.xFant),
    stateRegistration: text(emit.IE),
    crt: text(emit.CRT),
    street: text(ender.xLgr),
    number: text(ender.nro),
    complement: text(ender.xCpl),
    district: text(ender.xBairro),
    cityIbge: digitosOuNulo(ender.cMun),
    city: text(ender.xMun),
    state: text(ender.UF),
    zip: digitosOuNulo(ender.CEP),
    phone: digitosOuNulo(ender.fone),
  };
}

/** O <dest>: filho direto de infNFe, como o <emit>. */
function destinatarioDoXml(info: Record<string, unknown>): ParsedNfeRecipient {
  const dest = (info.dest ?? {}) as Record<string, unknown>;
  return {
    document: text(dest.CNPJ) ?? text(dest.CPF) ?? text(dest.idEstrangeiro),
    name: text(dest.xNome),
    stateRegistration: text(dest.IE),
  };
}

/** Os quatro dígitos do <modFrete>, ou nulo se vier fora do domínio real. */
const MODALIDADES_DE_FRETE = new Set(['0', '1', '2', '3', '4', '9']);

/**
 * Lê o grupo <transp>, que é filho DIRETO de infNFe — irmão de <total> e de
 * <pag>, e não de <det>. Procurar no lugar errado devolveria nulo em tudo e
 * pareceria "nota sem transporte" numa nota que declara transporte.
 */
function parseTransport(info: Record<string, unknown>): ParsedNfeTransport {
  const transp = (info.transp ?? {}) as Record<string, unknown>;
  const transporta = (transp.transporta ?? {}) as Record<string, unknown>;
  const veiculo = (transp.veicTransp ?? {}) as Record<string, unknown>;

  /*
    <vol> repete 0..N — uma linha por espécie de volume (caixa, palete, saco).
    Um volume chega como OBJETO e dois chegam como ARRAY, e é exatamente para
    isso que `asArray` existe. Esquecê-lo dá o clássico "funciona no teste com
    um volume e quebra na nota real com três".

    Os N viram três números porque é o que a doca usa: quantos volumes e quanto
    pesa, para bater com o romaneio. Volume por espécie não tem leitor no ERP.
  */
  const volumes = asArray(transp.vol as Record<string, unknown>[]);
  let qtd: number | null = null;
  let bruto: number | null = null;
  let liquido: number | null = null;
  for (const vol of volumes) {
    const q = text(vol.qVol);
    if (q !== null && Number.isFinite(Number(q))) qtd = (qtd ?? 0) + Number(q);
    const b = toGrams(vol.pesoB);
    if (b !== null) bruto = (bruto ?? 0) + b;
    const l = toGrams(vol.pesoL);
    if (l !== null) liquido = (liquido ?? 0) + l;
  }

  const modalidade = text(transp.modFrete);

  return {
    carrierName: text(transporta.xNome),
    // CNPJ ou CPF, nunca os dois: o transportador autônomo é o caso comum no
    // interior, e ler só CNPJ o perderia. Mesma regra já usada no emitente.
    carrierDocument: text(transporta.CNPJ) ?? text(transporta.CPF),
    carrierStateRegistration: text(transporta.IE),
    carrierCity: text(transporta.xMun),
    carrierState: text(transporta.UF),
    // Valor fora do domínio real é descartado em vez de guardado: gravar um
    // "7" que o layout não tem só empurra o erro para a tela.
    freightMode: modalidade && MODALIDADES_DE_FRETE.has(modalidade) ? modalidade : null,
    vehiclePlate: text(veiculo.placa),
    vehicleUf: text(veiculo.UF),
    volumesQty: qtd,
    grossWeightGrams: bruto,
    netWeightGrams: liquido,
  };
}

/**
 * Lê o XML e extrai o que interessa para a entrada de estoque.
 *
 * Aceita tanto `<nfeProc>` (nota autorizada, com protocolo) quanto `<NFe>`
 * solto, porque na prática chegam os dois formatos.
 */
export function parseNfeXml(xml: string): ParsedNfe {
  if (!xml?.trim()) {
    throw new ApiError('CORE_XML_EMPTY', 'Arquivo XML vazio.', 400);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    trimValues: true,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new ApiError('CORE_XML_INVALID', 'XML malformado.', 400);
  }

  const root = (doc.nfeProc ?? doc) as Record<string, unknown>;
  const nfe = (root.NFe ?? root) as Record<string, unknown>;
  const info = nfe.infNFe as Record<string, unknown> | undefined;
  if (!info) {
    throw new ApiError(
      'CORE_XML_NOT_NFE',
      'O arquivo não parece ser uma NF-e (elemento infNFe ausente).',
      400,
    );
  }

  // A chave vem no atributo Id no formato "NFe<44 dígitos>".
  const rawId = text(info['@Id']) ?? '';
  const accessKey = rawId.replace(/^NFe/i, '').replace(/\D/g, '');
  if (accessKey.length !== 44) {
    throw new ApiError(
      'CORE_XML_NO_KEY',
      'Chave de acesso ausente ou inválida (esperados 44 dígitos).',
      400,
    );
  }

  const ide = (info.ide ?? {}) as Record<string, unknown>;
  const emit = (info.emit ?? {}) as Record<string, unknown>;
  const total = ((info.total ?? {}) as Record<string, unknown>).ICMSTot as
    | Record<string, unknown>
    | undefined;

  const items: ParsedNfeItem[] = asArray(info.det as Record<string, unknown>[]).map((det) => {
    const prod = (det.prod ?? {}) as Record<string, unknown>;
    const ean = text(prod.cEAN);
    // GTIN com verificador errado no XML do fornecedor não é código lido por scanner:
    // vira ausente (o item entra sem código, e o cadastro não recusa a nota inteira).
    const eanConfiavel = gtinConfiavel(ean);
    return {
      supplierCode: text(prod.cProd),
      // "SEM GTIN" é o preenchimento padrão quando o item não tem código de
      // barras; tratar como ausente evita cadastrar um EAN falso.
      barcode: eanConfiavel,
      // O EAN da UNIDADE, quando o fornecedor o declara à parte (B-05).
      barcodeTrib: gtinConfiavel(text(prod.cEANTrib)),
      semGtin: (ean ?? '').toUpperCase() === 'SEM GTIN',
      discountCents: toCents(prod.vDesc),
      freightCents: toCents(prod.vFrete),
      insuranceCents: toCents(prod.vSeg),
      otherCents: toCents(prod.vOutro),
      description: text(prod.xProd) ?? 'Item sem descrição',
      ncm: text(prod.NCM),
      cfop: text(prod.CFOP),
      cest: text(prod.CEST),
      origin: origemDoItem(det),
      unit: text(prod.uCom),
      quantity: Number(prod.qCom ?? 0),
      /*
        O SEGUNDO PAR, que era jogado fora.

        `uTrib`/`qTrib` são obrigatórios no layout e trazem a MENOR unidade
        do item. É onde o fornecedor que fatura em caixa declara quantas
        unidades vão dentro — a conversão que faltava, escrita no arquivo
        desde sempre.
      */
      unitTrib: text(prod.uTrib),
      quantityTrib: prod.qTrib == null ? null : Number(prod.qTrib),
      unitCostCents: toCents(prod.vUnCom),
      totalCents: toCents(prod.vProd),
      taxes: tributosDoItem(det),
    };
  });

  if (items.length === 0) {
    throw new ApiError('CORE_XML_NO_ITEMS', 'A nota não possui itens.', 400);
  }

  /*
    O RATEIO DO QUE SÓ VEIO NO TOTAL (B-estoque-entrada-09).

    O leiaute manda declarar frete, seguro, desconto e outras despesas POR
    ITEM, e o total (`ICMSTot`) é a soma deles. Há emissor que escreve só o
    total: sem rateio, o frete dessa nota sumia do custo de todos os itens.
    Quando nenhum item declara a parcela e o total declara, ela é repartida
    pelo valor dos produtos (`vProd`) — o critério do próprio leiaute para o
    rateio do frete. A última linha leva a sobra do arredondamento, para a
    soma bater com o total centavo por centavo.
  */
  const somaDosProdutos = items.reduce((s, i) => s + i.totalCents, 0);
  const ratear = (campo: 'discountCents' | 'freightCents' | 'insuranceCents' | 'otherCents', totalDaNota: number) => {
    if (totalDaNota <= 0 || somaDosProdutos <= 0) return;
    if (items.some((i) => (i[campo] ?? 0) > 0)) return;
    let distribuido = 0;
    items.forEach((item, indice) => {
      const parte = indice === items.length - 1
        ? totalDaNota - distribuido
        : Math.round((totalDaNota * item.totalCents) / somaDosProdutos);
      item[campo] = parte;
      distribuido += parte;
    });
  };
  ratear('discountCents', toCents(total?.vDesc));
  ratear('freightCents', toCents(total?.vFrete));
  ratear('insuranceCents', toCents(total?.vSeg));
  ratear('otherCents', toCents(total?.vOutro));

  const infProt = (((root.protNFe ?? {}) as Record<string, unknown>).infProt ?? null) as
    | Record<string, unknown>
    | null;

  return {
    accessKey,
    number: text(ide.nNF),
    series: text(ide.serie),
    issuedAt: text(ide.dhEmi) ?? text(ide.dEmi),
    supplierName: text(emit.xNome),
    supplierDocument: text(emit.CNPJ) ?? text(emit.CPF),
    supplier: emitenteDoXml(emit),
    model: text(ide.mod),
    recipient: destinatarioDoXml(info),
    totalCents: toCents(total?.vNF),
    freightCents: toCents(total?.vFrete),
    transport: parseTransport(info),
    items,
    environment: ambienteDoTpAmb(
      text(ide.tpAmb)
        ?? text(((((root.protNFe ?? {}) as Record<string, unknown>).infProt ?? {}) as Record<string, unknown>).tpAmb),
    ),
    authorization: infProt && typeof infProt === 'object'
      ? {
          cStat: text(infProt.cStat),
          xMotivo: text(infProt.xMotivo),
          chNFe: digitosOuNulo(infProt.chNFe),
          protocol: text(infProt.nProt),
        }
      : null,
  };
}

/**
 * O GTIN em que se pode confiar: nem "SEM GTIN", nem verificador errado. O que
 * não tem cara de GTIN (código alfanumérico do fornecedor) passa como veio.
 */
function gtinConfiavel(codigo: string | null): string | null {
  if (!codigo || codigo.toUpperCase() === 'SEM GTIN') return null;
  return !pareceGtin(codigo) || gtinValido(codigo) ? codigo : null;
}

/**
 * O CUSTO DE VERDADE DA LINHA, em centavos — B-estoque-entrada-09.
 *
 * O custo gravado no produto era o `vUnCom`: o preço de tabela do fornecedor.
 * Desconto do item, frete, seguro, outras despesas, IPI e ICMS-ST ficavam de
 * fora — e numa nota com ST de 20% o custo saía 20% abaixo do real, com a
 * margem de "Revisar preços" e o relatório de lucro mostrando lucro que não
 * existe. Para a loja do Simples (a Preço Justo), IPI e ST não são crédito:
 * são custo da mercadoria, como o frete.
 *
 *   vProd − vDesc + vFrete + vSeg + vOutro + vIPI + vICMSST
 *
 * O ICMS próprio NÃO entra: ele já está dentro do `vProd`, e o crédito dele
 * (quando existe) é assunto do contador, não do custo de prateleira.
 */
export function custoEfetivoDaLinhaCents(item: ParsedNfeItem): number {
  const total = item.totalCents
    - (item.discountCents ?? 0)
    + (item.freightCents ?? 0)
    + (item.insuranceCents ?? 0)
    + (item.otherCents ?? 0)
    + (item.taxes?.ipiCents ?? 0)
    + (item.taxes?.icmsStCents ?? 0);
  return Math.max(0, total);
}

/**
 * O que o XML GUARDADO diz de cada linha e a tabela da nota não guarda — o
 * GTIN da unidade, o "SEM GTIN" declarado e o custo efetivo. Alinhado pela
 * POSIÇÃO: as linhas nascem na ordem dos `<det>` (`ORDER BY rowid`).
 *
 * Vazio para a entrada manual (não há arquivo), para a nota antiga sem
 * arquivo e para o arquivo que não se relê — quem chama cai no que a linha
 * gravou, o comportamento de sempre.
 */
interface ExtraDaLinha {
  barcodeTrib: string | null;
  semGtin: boolean;
  custoEfetivoUnitCents: number | null;
}

function extrasDoXmlGuardado(xml: string | null | undefined, linhas: number): ExtraDaLinha[] {
  if (!xml?.trim()) return [];
  try {
    const itens = parseNfeXml(xml).items;
    // Arquivo que não bate com as linhas gravadas não é fonte de nada.
    if (itens.length !== linhas) return [];
    return itens.map((item) => ({
      barcodeTrib: item.barcodeTrib ?? null,
      semGtin: Boolean(item.semGtin),
      custoEfetivoUnitCents:
        item.quantity > 0 ? Math.round(custoEfetivoDaLinhaCents(item) / item.quantity) : null,
    }));
  } catch {
    return [];
  }
}

/** O ambiente em que a SEFAZ autorizou a nota — R3-DFE (GAP-PRD-168). */
export type AmbienteDaNota = 'production' | 'homologation';

function ambienteDoTpAmb(valor: string | null): AmbienteDaNota | null {
  if (valor === '1') return 'production';
  if (valor === '2') return 'homologation';
  return null;
}

/** O ambiente de um XML guardado; nulo quando não diz ou nem se lê. */
export function ambienteDoXmlGuardado(xml: string | null | undefined): AmbienteDaNota | null {
  if (!xml?.trim()) return null;
  try {
    return parseNfeXml(xml).environment;
  } catch {
    return null;
  }
}

/**
 * ============================================================================
 * NOTA SEM VALIDADE FISCAL NÃO ENTRA NA PRODUÇÃO (R3-DFE, GAP-PRD-168)
 * ============================================================================
 *
 * A Distribuição DF-e já recusava documento de outro ambiente. O upload do
 * XML e o anexo do e-mail não olhavam o `tpAmb`: a nota de TESTE do fornecedor
 * (tpAmb=2 — sem validade fiscal) entrava no funil de conferência de uma
 * empresa em produção, e a confirmação dava entrada de estoque e gerava conta
 * a pagar de uma compra que não existe perante o fisco.
 *
 * A pergunta é "esta nota tem validade fiscal onde a empresa opera?", e a
 * resposta NÃO é simétrica:
 *
 *  - empresa em PRODUÇÃO: só a nota de produção. A de homologação é recusada
 *    antes de gravar qualquer coisa; o XML sem `tpAmb` legível também — o
 *    leiaute exige o campo e a assinatura do fornecedor o cobre, então a nota
 *    autorizada sempre o traz, e sem ele não há como afirmar validade fiscal;
 *  - empresa em HOMOLOGAÇÃO: entra tudo. A nota de produção é compra REAL (o
 *    fisco a reconhece em qualquer caso), e a produção só é liberada depois da
 *    autorização real em homologação (`CORE_FISCAL_PRODUCTION_LOCKED`): até lá
 *    a loja já recebe mercadoria de verdade, e recusar a nota de produção
 *    travaria a entrada de compras. A de homologação é o ensaio que o próprio
 *    ambiente declara.
 *
 * Um só lugar decide, e todas as entradas passam por ele: `importNfe` (upload,
 * e-mail e a nota completa da DF-e), a prévia da tela, a confirmação da nota
 * que entrou antes desta trava e a releitura do XML guardado.
 */
export function exigirNotaComValidadeFiscal(companyId: string, ambienteDaNota: AmbienteDaNota | null): void {
  if (getFiscalConfig(companyId).environment !== 'production') return;
  if (ambienteDaNota === 'production') return;
  if (ambienteDaNota === 'homologation') {
    throw new ApiError(
      'CORE_NFE_DE_HOMOLOGACAO',
      'Esta NF-e é de homologação (tpAmb 2) — não tem validade fiscal, e a empresa está em produção: '
        + 'nada foi gravado. Peça ao fornecedor a nota de produção.',
      409,
      { ambienteDaNota, ambienteDaEmpresa: 'production' },
    );
  }
  throw new ApiError(
    'CORE_NFE_AMBIENTE_ILEGIVEL',
    'O XML não diz em que ambiente a NF-e foi autorizada (o campo tpAmb da identificação está ausente ou '
      + 'inválido). A nota autorizada sempre o traz, e sem ele não há como afirmar que ela tem validade '
      + 'fiscal — a empresa está em produção: nada foi gravado. Peça ao fornecedor o XML autorizado, '
      + 'como a SEFAZ o devolveu.',
    400,
    { ambienteDaNota: null, ambienteDaEmpresa: 'production' },
  );
}

/** CNPJ/CPF com a máscara de leitura humana; o que não tem 14 ou 11 dígitos volta cru. */
function documentoLegivel(digitos: string): string {
  if (digitos.length === 14) {
    return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (digitos.length === 11) return digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return digitos;
}

/**
 * ============================================================================
 * A NOTA DE OUTRA EMPRESA DO GRUPO NÃO ENTRA NESTA (B-estoque-entrada-02)
 * ============================================================================
 *
 * O `<dest>` era lido e só GRAVADO (`recipient_document`) — nenhum caminho o
 * comparava com o CNPJ da empresa. A pasta de XMLs do e-mail do grupo traz as
 * notas da Gringa, da Me Mimei e da Preço Justo juntas: a NF-e cujo destinatário
 * é a Gringa entrava na Preço Justo, era confirmada, o estoque da Preço Justo
 * subia com mercadoria que está em outra loja e nascia uma conta a pagar da
 * Preço Justo por uma compra da Gringa. O próprio estorno cita esse caso ("a
 * nota do irmão da outra empresa do grupo") — o conserto era desfazer depois.
 *
 * A comparação é por DÍGITOS e EXATA: matriz e filial têm CNPJs diferentes, e o
 * estoque é de cada estabelecimento. Duas situações NÃO bloqueiam, de propósito:
 *
 *   - a empresa sem CNPJ configurado ainda: não há com o que comparar, e travar
 *     a entrada de compras da loja que está se implantando seria pior. A nota
 *     entra, e a conferência MOSTRA o destinatário (`listNotes` o devolve);
 *   - o XML sem `<dest>` legível: não há o que afirmar sobre ele.
 *
 * Um lugar decide, e todas as portas passam por ele: `importNfe` (upload,
 * e-mail e DF-e), a prévia da tela e a confirmação da nota que entrou antes
 * desta trava.
 */
export function exigirNotaDestaEmpresa(
  companyId: string,
  destinatario: { document: string | null; name: string | null },
): void {
  const cnpjDaEmpresa = String(getFiscalConfig(companyId).cnpj ?? '').replace(/\D/g, '');
  if (!cnpjDaEmpresa) return;
  const doDestinatario = String(destinatario.document ?? '').replace(/\D/g, '');
  if (!doDestinatario || doDestinatario === cnpjDaEmpresa) return;
  const nome = destinatario.name ? `${destinatario.name} (${documentoLegivel(doDestinatario)})` : documentoLegivel(doDestinatario);
  throw new ApiError(
    'CORE_NFE_OUTRO_DESTINATARIO',
    `Esta NF-e foi emitida para ${nome}, e não para esta empresa (CNPJ ${documentoLegivel(cnpjDaEmpresa)}): `
      + 'nada foi gravado. Se ela é de outra loja do grupo, troque a empresa no topo da tela e importe lá.',
    409,
    { destinatario: doDestinatario, empresa: cnpjDaEmpresa },
  );
}

/**
 * ============================================================================
 * NF-E SEM PROTOCOLO DE AUTORIZAÇÃO NÃO ENTRA NA PRODUÇÃO (B-estoque-entrada-M02)
 * ============================================================================
 *
 * O parser aceita o `<NFe>` solto (sem `protNFe`) e nada conferia o protocolo:
 * o XML que o sistema do fornecedor gera ANTES de a SEFAZ responder — ou o da
 * nota rejeitada ou denegada — entrava pelo e-mail, a doca confirmava, o
 * estoque subia e nascia conta a pagar de uma NF-e que não existe perante o
 * fisco (e o pacote do contador a incluía).
 *
 * Com a empresa em PRODUÇÃO, a importação exige o protocolo: `cStat` 100
 * (autorizada) ou 150 (autorizada fora de prazo), e a chave do protocolo igual
 * à da nota — protocolo de outra nota colado no arquivo não autoriza esta. Em
 * homologação nada muda: é o ensaio, como em `exigirNotaComValidadeFiscal`.
 *
 * A consulta de CANCELAMENTO posterior é da SEFAZ (a Distribuição DF-e traz o
 * evento): este arquivo só consegue afirmar o que o próprio XML prova.
 */
const CSTAT_AUTORIZADA = new Set(['100', '150']);

export function exigirNotaAutorizada(companyId: string, parsed: ParsedNfe): void {
  if (getFiscalConfig(companyId).environment !== 'production') return;
  const aut = parsed.authorization;
  if (aut && aut.cStat && CSTAT_AUTORIZADA.has(aut.cStat) && aut.chNFe === parsed.accessKey) return;

  const caminho =
    'Peça ao fornecedor o XML AUTORIZADO (o arquivo nfeProc, com o protocolo da SEFAZ) ou importe a nota '
    + 'pela Distribuição DF-e: nada foi gravado.';
  let motivo: string;
  if (!aut) {
    motivo = 'Este XML não traz o protocolo de autorização da SEFAZ (protNFe) — é o arquivo gerado antes da '
      + 'autorização, e não prova que a nota existe perante o fisco.';
  } else if (!aut.cStat || !CSTAT_AUTORIZADA.has(aut.cStat)) {
    motivo = `A SEFAZ não autorizou esta NF-e (situação ${aut.cStat ?? 'não informada'}`
      + `${aut.xMotivo ? `: ${aut.xMotivo}` : ''}).`;
  } else {
    motivo = 'O protocolo que acompanha este XML é de OUTRA nota (a chave do protocolo não é a desta NF-e).';
  }
  throw new ApiError('CORE_NFE_SEM_AUTORIZACAO', `${motivo} ${caminho}`, 409, {
    cStat: aut?.cStat ?? null,
    chaveDoProtocolo: aut?.chNFe ?? null,
  });
}

/**
 * A sigla da unidade, comparável.
 *
 * O fornecedor escreve "un", "UN", "Un " e "UNID" para a mesma coisa. As
 * três primeiras são o mesmo texto com casca diferente e têm de casar; a
 * quarta é outra sigla e NÃO casa — inventar sinônimo aqui seria adivinhar,
 * e adivinhar unidade é o defeito que esta rodada está consertando.
 */
function siglaDaUnidade(u: unknown): string {
  return String(u ?? '').trim().toUpperCase();
}

/**
 * QUANTAS UNIDADES DO CADASTRO CABEM EM UMA DA NOTA.
 *
 * Três caminhos, nesta ordem, e nenhum quarto:
 *
 *   1. o CONFERENTE disse. Quem está com a caixa aberta na doca sabe mais
 *      que o arquivo, e o que ele digitou vence;
 *   2. as unidades são a MESMA. Não há o que converter — é o caso comum e
 *      não pode custar cerimônia nenhuma;
 *   3. a NOTA diz. O par tributável (`uTrib`/`qTrib`) é obrigatório no
 *      layout e traz a menor unidade do item: quando ele bate com a
 *      unidade do cadastro, `qTrib / qCom` É a conversão, escrita pelo
 *      próprio emitente.
 *
 * Fora disso, `null` — e quem chamou RECUSA. Assumir 1:1 é exatamente o
 * defeito: dez caixas viram dez parafusos e ninguém fica sabendo.
 */
function fatorDeConversao(
  linha: {
    unit: unknown;
    quantity: unknown;
    unit_trib?: unknown;
    quantity_trib?: unknown;
    conversion_factor?: unknown;
  },
  unidadeDoCadastro: unknown,
  /**
   * A embalagem declarada no CADASTRO do produto (GAP-V06): "minha caixa é CX
   * e vem com 12". Entra como ÚLTIMO recurso, e só quando a nota está
   * exatamente naquela embalagem — nunca por cima do que a linha declara nem
   * do que o próprio emitente escreveu em qTrib/qCom, porque o fornecedor
   * pode mudar a caixa sem avisar e é a NOTA que descreve o que chegou.
   */
  embalagemDoCadastro?: { fator: unknown; unidade: unknown },
  /**
   * O FATOR QUE UMA PESSOA JÁ DEU para este item deste fornecedor, nesta mesma
   * unidade, numa nota anterior recebida (B-estoque-entrada-19). É a última
   * pergunta antes da recusa: o fornecedor que escreve "UND" onde o cadastro diz
   * "UN" recebia a recusa em TODA nota, e alguém digitava "1" em cada uma das
   * sessenta linhas, para sempre. Não é sinônimo embutido no código — é a
   * resposta humana dada uma vez, lembrada por (fornecedor, código dele,
   * unidade), como o de-para lembra o produto.
   *
   * Pode vir como FUNÇÃO: a consulta ao que foi aprendido só roda quando os
   * três caminhos acima não responderam — a leitura de uma nota de 60 linhas
   * não consulta a trilha 60 vezes para itens que a nota já resolve.
   */
  aprendido?: number | null | (() => number | null),
): number | null {
  const informado = linha.conversion_factor;
  if (informado !== null && informado !== undefined && Number(informado) > 0) {
    return Number(informado);
  }

  const daNota = siglaDaUnidade(linha.unit);
  const doCadastro = siglaDaUnidade(unidadeDoCadastro);
  /*
    Cadastro SEM unidade declarada não tem com o que conflitar. Recusar
    aqui travaria a entrada de todo produto antigo por um problema que não
    existe — o produto não afirma unidade nenhuma.
  */
  if (!doCadastro || !daNota || daNota === doCadastro) return 1;

  const tribut = siglaDaUnidade(linha.unit_trib);
  const qCom = Number(linha.quantity);
  const qTrib = Number(linha.quantity_trib);
  if (tribut === doCadastro && qCom > 0 && Number.isFinite(qTrib) && qTrib > 0) {
    return qTrib / qCom;
  }

  /*
    A embalagem do cadastro é a última pergunta antes da recusa — e ela só
    responde quando a nota veio NA MESMA embalagem que o cadastro declara.
    "Caixa com 12" com a nota em CX é a resposta exata que a recusa pediria à
    pessoa na doca; a mesma "caixa com 12" com a nota em FD não diz nada, e
    aí a recusa continua sendo o certo.
  */
  const fatorDaEmbalagem = Number(embalagemDoCadastro?.fator ?? 0);
  const unidadeDaEmbalagem = siglaDaUnidade(embalagemDoCadastro?.unidade);
  if (fatorDaEmbalagem > 0 && unidadeDaEmbalagem && unidadeDaEmbalagem === daNota) {
    return fatorDaEmbalagem;
  }

  const lembrado = typeof aprendido === 'function' ? aprendido() : aprendido;
  if (lembrado !== null && lembrado !== undefined && Number(lembrado) > 0) {
    return Number(lembrado);
  }

  return null;
}

/**
 * O FATOR QUE UMA PESSOA DECLAROU, registrado quando a confirmação o aplicou
 * (B-estoque-entrada-R02).
 *
 * DEFEITO QUE ISTO CORRIGE: a confirmação passou a gravar o fator resolvido em
 * TODA linha (B-04, para o pedido amarrado contar unidades) — inclusive o "1"
 * automático de quando a nota e o cadastro tinham a MESMA unidade, ou o
 * cadastro não tinha unidade. E `fatorAprendido` aprendia qualquer
 * `conversion_factor > 0`, sem saber se foi gente que disse nem qual era a
 * unidade do cadastro na época. A "Pilha AA" cadastrada em CX recebia três
 * notas em CX (fator 1, automático); o gerente passava o produto para UN; a
 * nota seguinte, 10 CX de 12, entrava como 10 UN — o "1" das caixas iguais
 * virava a resposta para caixa contra unidade, sem pergunta, com o custo da
 * caixa gravado como custo da pilha.
 *
 * Agora só é aprendido o que tem esta linha na trilha: o fator que estava na
 * linha ANTES da confirmação (a conferência digitada, o "Declarar 1 = 1"),
 * junto com a unidade do CADASTRO naquele momento. A trilha, e não uma coluna,
 * porque é um fato com autor e data — "fulano disse que 1 UND é 1 UN" — e é
 * nela que a mesma nota já busca o custo de antes no estorno (B-14).
 */
const ACAO_FATOR_DECLARADO = 'purchase.note_item.factor_declared';

/**
 * O fator que uma PESSOA declarou para o mesmo código do mesmo fornecedor, no
 * mesmo produto, na mesma unidade da nota — e com o cadastro na MESMA unidade
 * de hoje (B-19, revisto no R02). Nulo sem esse histórico — e aí quem confere
 * responde, como sempre. O fator que a confirmação resolveu sozinha nunca é
 * aprendido: ele respondia a outra pergunta (outro cadastro, outra unidade).
 */
function fatorAprendido(
  db: ReturnType<typeof getConnection>,
  input: {
    companyId: string;
    supplierId: string | null;
    supplierCode: unknown;
    productId: string;
    unidadeDaNota: unknown;
    /** A unidade do cadastro AGORA: a declaração feita contra outra não vale. */
    unidadeDoCadastro: unknown;
    noteId: string;
  },
): number | null {
  const codigo = String(input.supplierCode ?? '').trim();
  const unidade = siglaDaUnidade(input.unidadeDaNota);
  const doCadastro = siglaDaUnidade(input.unidadeDoCadastro);
  if (!input.supplierId || !codigo || !unidade || !doCadastro) return null;
  /*
    A DECLARAÇÃO É PROCURADA NA JANELA DA CONFIRMAÇÃO DAQUELA NOTA (revisão do R02).

    `core_audit_log` só tem índice por (empresa, data) — nenhum por entidade. O
    JOIN direto (`a.entity_id = i.id`) varria a trilha INTEIRA da empresa, e
    isso a cada linha sem fator, em cada leitura e em cada confirmação: com 300
    mil registros na trilha, ler uma nota de 60 linhas "UND" levou 22 s, e
    confirmá-la, 28 s. A linha da trilha é gravada pela própria `confirmNfe`,
    na mesma transação e segundos ANTES do `received_at` da nota (que é o
    último passo). Então a busca fica presa a uma janela em volta desse
    instante, pelo índice (company_id, created_at): uma hora antes (confirmação
    longa) e um minuto depois (relógio que volta). Mesmo formato ISO dos dois
    lados, e por isso a comparação de texto vale.
  */
  const linha = db
    .prepare(
      `SELECT i.conversion_factor
         FROM core_inbound_note_items i
         JOIN core_inbound_notes n ON n.id = i.note_id AND n.company_id = i.company_id
        WHERE i.company_id = ? AND n.supplier_id = ? AND n.status = ? AND n.id <> ?
          AND i.product_id = ? AND i.supplier_code = ? AND UPPER(TRIM(i.unit)) = ?
          AND i.conversion_factor > 0
          AND n.received_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM core_audit_log a
             WHERE a.company_id = i.company_id
               AND a.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', n.received_at, '-1 hour')
               AND a.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', n.received_at, '+1 minute')
               AND a.action = ? AND a.entity_type = 'inbound_note_item' AND a.entity_id = i.id
               AND UPPER(TRIM(COALESCE(json_extract(a.detail, '$.unidadeDoCadastro'), ''))) = ?
          )
        ORDER BY n.received_at DESC, i.rowid DESC
        LIMIT 1`,
    )
    .get(
      input.companyId,
      input.supplierId,
      NOTA_RECEBIDA,
      input.noteId,
      input.productId,
      codigo,
      unidade,
      ACAO_FATOR_DECLARADO,
      doCadastro,
    ) as { conversion_factor: number } | undefined;
  return linha ? Number(linha.conversion_factor) : null;
}

/**
 * COMO NASCE O PRODUTO QUE A NOTA CADASTRA — B-estoque-entrada-06 e M01.
 *
 * O produto novo nascia na UNIDADE COMERCIAL da nota, com o código de barras
 * da caixa e o custo da caixa: numa primeira compra de 10 CX de 12 (uTrib UN,
 * qTrib 120), nascia "X" em CX, com o DUN-14, saldo 10 e custo da caixa. No
 * balcão, bipar o EAN da unidade dava "não encontrado"; vender 1 baixava uma
 * caixa inteira, e custo e margem saíam 12 vezes maiores. E o fator que o
 * conferente DIGITAVA para essa linha ("12") era descartado sem aviso.
 *
 * A regra, na mesma ordem de `fatorDeConversao`:
 *
 *   1. o CONFERENTE disse quantas unidades vêm em uma da nota: o produto nasce
 *      com esse fator — na unidade tributável quando o fator é o do par
 *      tributável da nota, e em UN quando não é (ver a revisão abaixo);
 *   2. a NOTA diz — `uTrib` diferente de `uCom` e `qTrib/qCom` válido: nasce em
 *      `uTrib`, com fator `qTrib/qCom`;
 *   3. senão, nasce na unidade da nota, fator 1 — o caso comum de sempre.
 *
 * Com fator diferente de 1, o código de barras do produto é o da UNIDADE
 * (`cEANTrib`) e a embalagem do cadastro é a caixa da nota (`pack_unit` =
 * `uCom`, `pack_factor` = fator, quando inteiro).
 *
 * O CÓDIGO DA CAIXA NÃO ENTRA NO CADASTRO DA UNIDADE (PED-ent-01). A versão
 * anterior gravava o DUN-14 da caixa (`cEAN`) como código ADICIONAL do produto
 * que nasce em UN — e `core_product_barcodes` não tem multiplicador: a busca do
 * PDV achava o produto pelo código da caixa e o bipe de uma caixa de doze
 * vendia UMA unidade (a contagem também contava a caixa fechada como 1). A
 * próxima nota do mesmo fornecedor não precisa desse código para casar: o
 * produto que a nota cadastra entra no de-para fornecedor × produto
 * (`lembrarDePara`, pelo `cProd`), que é o primeiro caminho de `matchItems`, e
 * a nota que traz o EAN da unidade no `cEANTrib` casa por ele. Quem quiser
 * vender a caixa fechada cadastra a embalagem como produto próprio, com o
 * preço dela.
 */
interface PlanoDoProdutoNovo {
  unidade: string;
  fator: number;
  barcode: string | null;
  packUnit: string | null;
  packFactor: number | null;
}

/**
 * A PEÇA QUE SE CONTA — a unidade que se pega na mão e se bipa no balcão.
 * O fornecedor escreve de vários jeitos; aqui entram só as grafias de
 * "unidade" e "peça" (`siglaDaUnidade` já tirou caixa e espaço).
 */
const UNIDADES_DE_CONTAGEM = new Set([
  'UN', 'UND', 'UNID', 'UNIDADE', 'U', 'PC', 'PÇ', 'PCS', 'PECA', 'PEÇA', 'PECAS', 'PEÇAS',
]);

/** Peso, volume, comprimento e área: o que se MEDE, e não se conta. */
const UNIDADES_DE_MEDIDA = new Set([
  'KG', 'G', 'GR', 'MG', 'T', 'TON', 'L', 'LT', 'ML', 'M', 'MT', 'M2', 'M3', 'CM', 'MM', 'KM', 'AR',
]);

/**
 * O PAR TRIBUTÁVEL DESCREVE A PEÇA DENTRO DA EMBALAGEM? (B-estoque-entrada-R01)
 *
 * DEFEITO QUE ISTO CORRIGE: sem fator digitado, QUALQUER `uTrib` diferente do
 * `uCom` virava a unidade do produto novo. Era certo para o caso do B-06 (10
 * CX = 120 UN: o produto é a unidade) e errado para todo fornecedor que tributa
 * em peso ou volume: o "Sabão em pó 5 kg" (10 UN = 50 KG) nascia em KG, com
 * saldo 50, custo do quilo e embalagem "UN com 5" — e o EAN do pacote (`cEAN`)
 * era jogado fora, porque o código do produto passava a ser o `cEANTrib`. Com
 * `cEANTrib` "SEM GTIN", o pacote bipado no PDV dava "não encontrado"; com o
 * mesmo EAN nos dois, cada pacote vendido baixava 1 KG, um quinto do real. O
 * mesmo com DZ, MIL, L e M.
 *
 * A nota só decide a unidade quando descreve exatamente o caso do B-06: a
 * tributável é uma unidade de CONTAGEM, a comercial é uma EMBALAGEM (não é
 * contagem nem medida) e cabe mais de uma peça nela. Fora disso, o produto
 * nasce na unidade comercial, com fator 1 e o EAN dela — e quem sabe que a
 * caixa tem 12 digita o 12 na conferência (o caminho do M01).
 */
function tributavelEhAPecaDaEmbalagem(uCom: string, uTrib: string, fatorDaNota: number | null): boolean {
  return (
    fatorDaNota !== null
    && fatorDaNota > 1
    && UNIDADES_DE_CONTAGEM.has(uTrib)
    && !UNIDADES_DE_CONTAGEM.has(uCom)
    && !UNIDADES_DE_MEDIDA.has(uCom)
  );
}

function planoDoProdutoNovo(
  row: Record<string, unknown>,
  extra: ExtraDaLinha | undefined,
  usarInformado = true,
): PlanoDoProdutoNovo {
  const uCom = siglaDaUnidade(row.unit) || 'UN';
  const uTrib = siglaDaUnidade(row.unit_trib);
  const qCom = Number(row.quantity);
  const qTrib = Number(row.quantity_trib);
  const informado = usarInformado ? Number(row.conversion_factor ?? 0) : 0;
  const barrasCom = (row.barcode as string | null) ?? null;
  const barrasTrib = extra?.barcodeTrib ?? null;

  /** O par tributável da nota, quando ele descreve OUTRA unidade (10 CX = 120 UN → 12). */
  const fatorDaNota =
    uTrib && uTrib !== uCom && qCom > 0 && Number.isFinite(qTrib) && qTrib > 0 ? qTrib / qCom : null;

  /*
    O `cEANTrib` SÓ É O CÓDIGO DO PRODUTO NOVO QUANDO ELE NASCE NA UNIDADE
    TRIBUTÁVEL (revisão do M01).

    A primeira versão punha o `cEANTrib` como código principal sempre que o
    fator não era 1. Mas no caso do M01 — o fornecedor que fatura E tributa em
    CX (`uTrib` = `uCom` = CX) e o conferente digita 12 — o `cEANTrib` é o GTIN
    da CAIXA: o produto nascia em UN com o código da caixa como código dele, e o
    bipe da caixa fechada no balcão (e na contagem) valia UMA unidade, com a
    etiqueta da unidade imprimindo o código da caixa. E o fator digitado que não
    é o do par tributável (uTrib KG, 5 kg por caixa; o conferente diz 12 peças)
    fazia o produto nascer em KG com saldo de peças. A unidade tributável só vale
    quando é ela que o fator descreve; senão o produto nasce em UN, sem código
    principal — e o código da caixa fica FORA do cadastro (PED-ent-01).
  */
  let fator = 1;
  let unidade = uCom;
  let nasceNaTributavel = false;
  if (Number.isFinite(informado) && informado > 0) {
    fator = informado;
    if (fator !== 1) {
      nasceNaTributavel = fatorDaNota !== null && Math.abs(fatorDaNota - fator) < 1e-9;
      unidade = nasceNaTributavel ? (uTrib as string) : 'UN';
    }
  } else if (tributavelEhAPecaDaEmbalagem(uCom, uTrib, fatorDaNota)) {
    // Só o caso do B-06 (10 CX = 120 UN). Peso, volume, dúzia, milheiro: o
    // produto fica na unidade da nota, com o EAN dela (R01).
    fator = fatorDaNota as number;
    unidade = uTrib;
    nasceNaTributavel = true;
  }

  if (fator === 1) {
    return {
      unidade,
      fator: 1,
      // O `cEANTrib` é da MESMA unidade só quando o par tributável não descreve
      // outra (unidade igual, ou qTrib = qCom); o "1" digitado contra 10 CX =
      // 120 UN deixa a unidade na caixa, e aí o EAN da unidade não é dela.
      barcode: barrasCom ?? (fatorDaNota === null || fatorDaNota === 1 ? barrasTrib : null),
      packUnit: null,
      packFactor: null,
    };
  }
  /*
    Com fator, o produto é a UNIDADE: o único código que é dele é o `cEANTrib`
    quando ele nasce na unidade tributável. O `cEAN` (a caixa) — e o `cEANTrib`
    quando a unidade tributável também é a caixa — não é gravado em lugar
    nenhum do cadastro (PED-ent-01: bipar a caixa vendia uma unidade).
  */
  const barcode = nasceNaTributavel ? barrasTrib : null;
  return {
    unidade,
    fator,
    barcode,
    packUnit: uCom !== unidade ? uCom : null,
    packFactor: uCom !== unidade && Number.isInteger(fator) && fator > 1 ? fator : null,
  };
}

export interface MatchedItem extends ParsedNfeItem {
  productId: string | null;
  /**
   * `supplier_code` é o de-para do fornecedor (GAP-PRD-015): o código dele já
   * foi ligado a este produto numa conferência anterior.
   */
  matchedBy:
    | 'barcode'
    | 'barcode_trib'
    | 'internal_code'
    | 'name'
    | 'manual'
    | 'supplier_code'
    | null;
  /**
   * Por que o item não casou, quando ele QUASE casou.
   *
   * Sem isto, o item que bateria com um modelo de grade volta como "produto
   * não encontrado" — e quem confere a nota cadastra um produto novo,
   * duplicando a camisa que já existe no catálogo.
   */
  matchNote?: string | null;
}

/**
 * QUEM PODE RECEBER MERCADORIA DE NOTA.
 *
 * Modelo de grade e kit ficam de fora, e não é preciosismo: o modelo mantém o
 * código de barras, o código interno e o nome que tinha antes de a grade
 * existir — `generateVariants` não limpa nenhum dos três. Sem este predicado,
 * a nota do fornecedor com o código antigo continuava apontando para ele, e o
 * saldo entrava num produto que o balcão não vende, a contagem não alcança e
 * ninguém consegue corrigir por tela.
 *
 * A mesma condição já vivia em `CatalogService` (busca do PDV) e em
 * `InventoryCountService` (lista da contagem). Esta é a terceira leitura da
 * mesma regra — e a partir de agora `applyMovement` também a cobra, de modo que
 * um casamento errado não passa nem que alguém o force pela tela.
 */
const PODE_RECEBER_ESTOQUE = `
  (p.is_kit = 0 OR p.kit_explode_on_sale = 0)
  AND NOT EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id)`;

/** Por que o item não casou, quando ele quase casou. */
function motivoDaRecusa(
  db: ReturnType<typeof getConnection>,
  companyId: string,
  onde: string,
  ...valores: string[]
): string | null {
  const quase = db
    .prepare(
      `SELECT p.name, p.is_kit, p.active,
              EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
         FROM core_products p WHERE p.company_id = ? AND ${onde}`,
    )
    .get(companyId, ...valores) as
    | { name: string; is_kit: number; active: number; tem_grade: number }
    | undefined;
  if (!quase) return null;
  if (quase.tem_grade) {
    return `Casou com "${quase.name}", que é um modelo de grade. Escolha o tamanho/cor.`;
  }
  if (quase.is_kit) {
    return `Casou com "${quase.name}", que é um kit que desmembra na venda. `
      + 'Dê entrada nos componentes.';
  }
  /*
    O PRODUTO INATIVO (B-estoque-entrada-11). O casamento aceitava produto
    desativado: a mercadoria entrava num cadastro que o PDV não vende (a busca
    do balcão exige `active = 1`), e o bipe do código dava "não encontrado" sem
    que desse para recadastrar — o código já pertence ao inativo.
  */
  if (!quase.active) {
    return `Casou com "${quase.name}", que está INATIVO no cadastro — o PDV não vende produto inativo. `
      + 'Reative o produto e vincule, ou vincule a outro.';
  }
  return null;
}

/**
 * O fornecedor que JÁ está no cadastro, pelo documento — sem criar nada.
 *
 * Existe para a PRÉVIA do XML (`/purchases/nfe/preview`), que não grava: ela
 * precisa do fornecedor para consultar o de-para, e `findOrCreateSupplier`
 * criaria o cadastro só por alguém ter aberto um arquivo.
 */
export function fornecedorPeloDocumento(
  companyId: string,
  document: string | null,
): string | null {
  if (!document) return null;
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT id FROM core_suppliers WHERE company_id = ? AND document = ?')
    .get(companyId, document) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Casa cada item da nota com o catálogo da empresa.
 *
 * ## A ordem, e por que o de-para vem primeiro (GAP-PRD-015)
 *
 *   1. DE-PARA DO FORNECEDOR — "o `ALFA-778` desta distribuidora é o nosso
 *      cabo". É uma decisão HUMANA já tomada numa conferência anterior (ou o
 *      produto que a própria confirmação cadastrou). Se ela viesse depois do
 *      código de barras ou do nome, a correção de quem conferiu seria
 *      desobedecida na nota seguinte, e a doca teria de refazer o mesmo vínculo
 *      para sempre.
 *   2. CÓDIGO DE BARRAS — o principal E os adicionais do cadastro. O GTIN que o
 *      fornecedor manda é muitas vezes o do fabricante, que a loja guardou como
 *      código adicional; olhar só o principal jogava fora um casamento exato.
 *   3. CÓDIGO INTERNO igual ao `cProd` — a loja que cadastra pelo código do
 *      fornecedor.
 *   4. NOME idêntico — o mais fraco, e por isso o último.
 *
 * Nenhum caminho casa com modelo de grade nem com kit que desmembra (ver
 * `PODE_RECEBER_ESTOQUE`) — nem o de-para: um produto que virou modelo DEPOIS
 * do vínculo não recebe mais saldo, e a linha simplesmente deixa de valer.
 */
export function matchItems(
  companyId: string,
  items: ParsedNfeItem[],
  supplierId: string | null = null,
): MatchedItem[] {
  ensureCoreSchema();
  const db = getConnection();
  return items.map((item) => {
    let motivo: string | null = null;

    /*
      Todo caminho exige produto ATIVO (B-estoque-entrada-11): o casamento com
      o inativo punha saldo num cadastro que o balcão não vende. O inativo
      volta como MOTIVO ("casou com X, que está inativo"), nunca como vínculo.
    */
    if (supplierId && item.supplierCode) {
      const peloDePara = db
        .prepare(
          `SELECT p.id FROM core_supplier_item_codes m
             JOIN core_products p ON p.id = m.product_id AND p.company_id = m.company_id
            WHERE m.company_id = ? AND m.supplier_id = ? AND m.supplier_code = ?
              AND p.active = 1 AND ${PODE_RECEBER_ESTOQUE}`,
        )
        .get(companyId, supplierId, item.supplierCode) as { id: string } | undefined;
      if (peloDePara) return { ...item, productId: peloDePara.id, matchedBy: 'supplier_code' };
    }

    /*
      O GTIN da nota, e depois o GTIN da UNIDADE (B-estoque-entrada-05): o
      distribuidor que manda o DUN-14 da caixa no `cEAN` declara no `cEANTrib`
      o EAN da unidade — o código que a loja cadastrou e bipa.
    */
    const porBarras: [codigo: string | null | undefined, metodo: 'barcode' | 'barcode_trib'][] = [
      [item.barcode, 'barcode'],
      [item.barcodeTrib && item.barcodeTrib !== item.barcode ? item.barcodeTrib : null, 'barcode_trib'],
    ];
    for (const [codigo, metodo] of porBarras) {
      if (!codigo) continue;
      const byBarcode = db
        .prepare(
          `SELECT p.id FROM core_products p
            WHERE p.company_id = ? AND p.active = 1 AND ${PODE_RECEBER_ESTOQUE}
              AND (p.barcode = ?
                   OR EXISTS (SELECT 1 FROM core_product_barcodes b
                               WHERE b.product_id = p.id AND b.company_id = p.company_id
                                 AND b.barcode = ?))
            ORDER BY CASE WHEN p.barcode = ? THEN 0 ELSE 1 END
            LIMIT 1`,
        )
        .get(companyId, codigo, codigo, codigo) as { id: string } | undefined;
      if (byBarcode) return { ...item, productId: byBarcode.id, matchedBy: metodo };
      motivo ??= motivoDaRecusa(
        db,
        companyId,
        `(p.barcode = ? OR EXISTS (SELECT 1 FROM core_product_barcodes b
                                    WHERE b.product_id = p.id AND b.barcode = ?))`,
        codigo,
        codigo,
      );
    }
    if (item.supplierCode) {
      const byCode = db
        .prepare(
          `SELECT p.id FROM core_products p
            WHERE p.company_id = ? AND p.internal_code = ? AND p.active = 1 AND ${PODE_RECEBER_ESTOQUE}`,
        )
        .get(companyId, item.supplierCode) as { id: string } | undefined;
      if (byCode) return { ...item, productId: byCode.id, matchedBy: 'internal_code' };
      motivo ??= motivoDaRecusa(db, companyId, 'p.internal_code = ?', item.supplierCode);
    }
    /*
      O NOME É O CASAMENTO MAIS FRACO — e com HOMÔNIMO ele não escolhe
      (B-estoque-entrada-11). O `.get()` sem ORDER BY pegava um dos dois
      "Cabo USB" do catálogo, qualquer um; a mercadoria entrava no errado e
      ninguém via. Dois candidatos viram MOTIVO, e quem confere vincula o certo.
    */
    const byName = db
      .prepare(
        `SELECT p.id FROM core_products p
          WHERE p.company_id = ? AND p.name = ? COLLATE NOCASE AND p.active = 1
            AND ${PODE_RECEBER_ESTOQUE}
          LIMIT 2`,
      )
      .all(companyId, item.description) as unknown as { id: string }[];
    if (byName.length === 1) return { ...item, productId: byName[0].id, matchedBy: 'name' };
    if (byName.length > 1) {
      motivo ??= `Há mais de um produto chamado "${item.description}" no catálogo — vincule o certo.`;
    }
    motivo ??= motivoDaRecusa(db, companyId, 'p.name = ? COLLATE NOCASE', item.description);

    /*
      O MOTIVO ACOMPANHA A RECUSA.

      Sem ele, o item que casaria com o modelo de grade volta como "produto não
      encontrado" — e quem confere a nota cadastra um produto NOVO, duplicando
      a camisa que já existe. A frase diz com o que ele quase casou e o que
      fazer.
    */
    return { ...item, productId: null, matchedBy: null, matchNote: motivo };
  });
}

function findOrCreateSupplier(
  companyId: string,
  parsed: ParsedNfe,
  userId: string | null,
): string | null {
  const name = parsed.supplierName;
  const document = parsed.supplierDocument;
  if (!name) return null;
  const db = getConnection();
  if (document) {
    const existing = db
      .prepare('SELECT id FROM core_suppliers WHERE company_id = ? AND document = ?')
      .get(companyId, document) as { id: string } | undefined;
    if (existing) {
      completarFornecedorPeloXml({ companyId, supplierId: existing.id, parsed, userId });
      return existing.id;
    }
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_suppliers (id, company_id, name, document, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, companyId, name, document, new Date().toISOString());
  completarFornecedorPeloXml({ companyId, supplierId: id, parsed, userId });
  return id;
}

/** Os campos do cadastro que o <emit> preenche, e a coluna de cada um. */
const CAMPOS_DO_FORNECEDOR_NO_XML: [coluna: string, campo: keyof ParsedNfeSupplier][] = [
  ['trade_name', 'tradeName'],
  ['state_registration', 'stateRegistration'],
  ['street', 'street'],
  ['number', 'number'],
  ['complement', 'complement'],
  ['district', 'district'],
  ['city', 'city'],
  ['state', 'state'],
  ['zip', 'zip'],
  ['phone', 'phone'],
];

function nomeComparavel(valor: unknown): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

const campoVazio = (valor: unknown): boolean =>
  valor === null || valor === undefined || String(valor).trim() === '';

/**
 * O CADASTRO DO FORNECEDOR QUE O ARQUIVO JÁ TRAZIA (GAP-PRD-181).
 *
 * O fornecedor nascia só com nome e documento, e alguém redigitava IE,
 * endereço e telefone que estavam escritos no <emit> da nota. Agora o que o
 * XML declara preenche o cadastro — mas SÓ o que está em branco: o que alguém
 * digitou é decisão de gente, e nenhum arquivo de terceiro o revoga.
 *
 * O CÓDIGO IBGE só anda com a cidade dele: é gravado quando a cidade do
 * cadastro é a mesma do XML (ou quando ela também veio do XML agora). Grudar o
 * IBGE de São Paulo numa cidade digitada como Guarulhos seria inventar um
 * endereço fiscal que não existe.
 *
 * Cada preenchimento deixa trilha (`supplier.autofill_xml`, com a chave da
 * nota e as colunas) — é a procedência do dado. Devolve as colunas
 * preenchidas; vazio quando não havia nada a completar.
 */
export function completarFornecedorPeloXml(input: {
  companyId: string;
  supplierId: string;
  parsed: ParsedNfe;
  userId: string | null;
}): string[] {
  const db = getConnection();
  const atual = db
    .prepare('SELECT * FROM core_suppliers WHERE id = ? AND company_id = ?')
    .get(input.supplierId, input.companyId) as Record<string, unknown> | undefined;
  if (!atual) return [];

  const doXml = input.parsed.supplier;
  const preenchidos: [coluna: string, valor: string][] = [];
  for (const [coluna, campo] of CAMPOS_DO_FORNECEDOR_NO_XML) {
    const valor = doXml[campo];
    if (valor && campoVazio(atual[coluna])) preenchidos.push([coluna, valor]);
  }

  const cidade = campoVazio(atual.city) ? doXml.city : atual.city;
  const uf = campoVazio(atual.state) ? doXml.state : atual.state;
  const mesmaCidade =
    nomeComparavel(cidade) !== ''
    && nomeComparavel(cidade) === nomeComparavel(doXml.city)
    && nomeComparavel(uf) === nomeComparavel(doXml.state);
  if (doXml.cityIbge && campoVazio(atual.city_ibge) && mesmaCidade) {
    preenchidos.push(['city_ibge', doXml.cityIbge]);
  }

  if (preenchidos.length === 0) return [];

  db.prepare(
    `UPDATE core_suppliers
        SET ${preenchidos.map(([coluna]) => `${coluna} = ?`).join(', ')}, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    ...preenchidos.map(([, valor]) => valor),
    new Date().toISOString(),
    input.supplierId,
    input.companyId,
  );

  const colunas = preenchidos.map(([coluna]) => coluna);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'supplier.autofill_xml',
    entityType: 'supplier',
    entityId: input.supplierId,
    detail: { accessKey: input.parsed.accessKey, campos: colunas },
  });
  return colunas;
}

/**
 * A transportadora da nota, criada ou reaproveitada.
 *
 * Espelha `findOrCreateSupplier` com uma diferença deliberada: o documento é
 * NORMALIZADO antes de comparar e gravar. O fornecedor grava o valor cru, e o
 * `SupplierService` normaliza — assimetria conhecida que produz duplicata
 * quando o mesmo CNPJ chega com máscara por um caminho e sem por outro. A
 * transportadora nasce sem esse defeito em vez de herdá-lo.
 *
 * Sem documento, casa por NOME dentro da empresa. É heurística, e o mal menor:
 * o transportador autônomo costuma vir sem CNPJ, e sem esse casamento cada
 * nota criaria uma linha nova até a lista virar lixo. Duas homônimas de
 * cidades diferentes viram uma só — a tela permite separar depois.
 */
function findOrCreateCarrier(
  companyId: string,
  transporte: ParsedNfeTransport,
): string | null {
  if (!transporte.carrierName) return null;
  const db = getConnection();
  const documento = transporte.carrierDocument
    ? transporte.carrierDocument.replace(/\D/g, '') || null
    : null;

  const existente = documento
    ? (db
        .prepare('SELECT id FROM core_carriers WHERE company_id = ? AND document = ?')
        .get(companyId, documento) as { id: string } | undefined)
    : (db
        .prepare(
          'SELECT id FROM core_carriers WHERE company_id = ? AND name = ? COLLATE NOCASE',
        )
        .get(companyId, transporte.carrierName) as { id: string } | undefined);
  if (existente) return existente.id;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_carriers
       (id, company_id, name, document, state_registration, city, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    companyId,
    transporte.carrierName,
    documento,
    transporte.carrierStateRegistration,
    transporte.carrierCity,
    transporte.carrierState,
    new Date().toISOString(),
  );
  return id;
}

export interface ImportResult {
  noteId: string;
  duplicated: boolean;
  status: string;
  accessKey: string;
  items: MatchedItem[];
  /**
   * A nota ESTORNADA com o mesmo XML que esta importação substituiu
   * (B-estoque-entrada-08). Ausente no caso comum.
   */
  reabriuEstornada?: string;
}

/**
 * A chave com que a nota ESTORNADA fica no histórico quando o MESMO XML entra
 * de novo (B-estoque-entrada-08): os 44 dígitos seguidos de "-estornada-N".
 *
 * Os 44 dígitos continuam no começo — `slice(25, 34)` (o número da nota), a
 * busca por chave e o nome do arquivo no pacote do contador seguem lendo o
 * certo —, e a chave LIMPA passa para a nota nova, que é a viva: é por ela que
 * a Distribuição DF-e e o CT-e se ligam à nota.
 */
function chaveDaEstornada(db: ReturnType<typeof getConnection>, companyId: string, chave: string): string {
  const anteriores = db
    .prepare(
      "SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ? AND access_key LIKE ? || '-estornada-%'",
    )
    .get(companyId, chave) as { n: number };
  return `${chave}-estornada-${Number(anteriores.n) + 1}`;
}

/**
 * Grava a nota para conferência. NÃO mexe em estoque — é a etapa de preview
 * persistido, para que a conferência possa ser retomada depois.
 */
export function importNfe(input: {
  companyId: string;
  userId: string;
  xml: string;
  /**
   * O MESMO XML de uma nota ESTORNADA entra de novo, numa conferência nova
   * (B-estoque-entrada-08). Sem isto, a reimportação da estornada é recusada
   * com `CORE_NOTE_REVERSED_REOPENABLE` — a tela pergunta antes.
   */
  reabrirEstornada?: boolean;
}): ImportResult {
  ensureCoreSchema();
  const parsed = parseNfeXml(input.xml);
  // A nota de TESTE do fornecedor não entra numa empresa em produção — antes
  // de tudo, inclusive do "já importada" (R3-DFE, GAP-PRD-168).
  exigirNotaComValidadeFiscal(input.companyId, parsed.environment);
  // A nota de outra empresa do grupo não entra nesta (B-estoque-entrada-02).
  exigirNotaDestaEmpresa(input.companyId, parsed.recipient);
  // Nem o XML sem protocolo de autorização, com a empresa em produção (M02).
  exigirNotaAutorizada(input.companyId, parsed);

  return withTransaction(() => {
    const db = getConnection();

    // Reimportar o mesmo arquivo não cria uma segunda entrada.
    const existing = db
      .prepare(
        `SELECT id, status, reversed_at, reversal_reason
           FROM core_inbound_notes WHERE company_id = ? AND access_key = ?`,
      )
      .get(input.companyId, parsed.accessKey) as
      | { id: string; status: string; reversed_at: string | null; reversal_reason: string | null }
      | undefined;
    let reabriuEstornada: string | undefined;
    if (existing && existing.status === NOTA_ESTORNADA) {
      /*
        A NOTA ESTORNADA PODE ENTRAR DE NOVO COM O MESMO XML (B-08).

        O estorno mandava "lance a entrada de novo" e a reimportação devolvia o
        documento MORTO ("já havia sido importada. Nada foi duplicado") — cuja
        confirmação o próprio sistema recusa. Sobrava a entrada manual SEM XML,
        e o fechamento do contador passava a listar "Compra sem NF-e" para uma
        compra que tem NF-e.

        A nota estornada fica como está no histórico (movimentos, título
        cancelado, motivo) e cede a chave limpa para uma nota NOVA, com id novo:
        os movimentos, as unidades e o título da nova entrada têm referência
        própria e não esbarram nas UNIQUE do razão nem do financeiro. É gesto
        CONSCIENTE: sem `reabrirEstornada`, a resposta pergunta antes.
      */
      if (!input.reabrirEstornada) {
        const quando = existing.reversed_at ? ` em ${existing.reversed_at.slice(8, 10)}/${existing.reversed_at.slice(5, 7)}/${existing.reversed_at.slice(0, 4)}` : '';
        throw new ApiError(
          'CORE_NOTE_REVERSED_REOPENABLE',
          `Esta NF-e já entrou e foi ESTORNADA${quando}${existing.reversal_reason ? ` (motivo: ${existing.reversal_reason})` : ''}. `
            + 'Se a mercadoria chegou de verdade, confirme a NOVA CONFERÊNCIA com este mesmo XML — a nota '
            + 'estornada continua no histórico.',
          409,
          { noteId: existing.id },
        );
      }
      db.prepare('UPDATE core_inbound_notes SET access_key = ? WHERE id = ?').run(
        chaveDaEstornada(db, input.companyId, parsed.accessKey),
        existing.id,
      );
      reabriuEstornada = existing.id;
    } else if (existing) {
      return {
        noteId: existing.id,
        duplicated: true,
        status: existing.status,
        accessKey: parsed.accessKey,
        items: listNoteItems(input.companyId, existing.id),
      };
    }

    const supplierId = findOrCreateSupplier(input.companyId, parsed, input.userId);
    const noteId = randomUUID();
    const now = new Date().toISOString();

    const carrierId = findOrCreateCarrier(input.companyId, parsed.transport);

    /*
      O ARQUIVO É GRAVADO AQUI, E SÓ AQUI.

      `input.xml` é o texto que chegou, antes de qualquer coisa: `parseNfeXml`
      LÊ e não devolve o que leu, então o que entra na coluna é a string
      original, byte por byte. Nada de reserializar a árvore do parser — o XML
      vem assinado pelo fornecedor e a assinatura cobre os bytes exatos.
      Reimprimir reordena atributo e normaliza espaço, e a assinatura para de
      validar num arquivo que continua parecendo certo.

      UM ESCRITOR SÓ, e é por isso que ele fica no `INSERT`: `importNfe` é o
      funil por onde passam os DOIS caminhos de entrada — o upload manual da
      tela e o anexo que o `MailInboxService` extrai do e-mail (ele chama esta
      mesma função, com o XML do anexo). Gravar na rota cobriria um caminho e
      deixaria o outro sem arquivo, em silêncio.

      A nota DUPLICADA volta lá em cima sem passar por aqui, e é o certo: a
      linha que já existe não é reescrita. Uma nota importada antes desta
      rodada continua sem arquivo mesmo que alguém reenvie o mesmo XML — o
      remendo pareceria um conserto e criaria um segundo escritor para
      divergir do primeiro.
    */
    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, series, supplier_id, issued_at,
          total_cents, status, carrier_id, carrier_name_xml, freight_mode,
          freight_cents, vehicle_plate, vehicle_uf, volumes_qty,
          gross_weight_grams, net_weight_grams, xml_original, created_at,
          model, recipient_document, recipient_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      noteId,
      input.companyId,
      parsed.accessKey,
      parsed.number,
      parsed.series,
      supplierId,
      parsed.issuedAt,
      parsed.totalCents,
      NOTA_IMPORTADA,
      carrierId,
      parsed.transport.carrierName,
      parsed.transport.freightMode,
      parsed.freightCents || null,
      parsed.transport.vehiclePlate,
      parsed.transport.vehicleUf,
      parsed.transport.volumesQty,
      parsed.transport.grossWeightGrams,
      parsed.transport.netWeightGrams,
      input.xml,
      now,
      // O modelo e o destinatário da nota (GAP-PRD-181).
      parsed.model,
      parsed.recipient.document,
      parsed.recipient.name,
    );

    const matched = matchItems(input.companyId, parsed.items, supplierId);
    const stmt = db.prepare(
      `INSERT INTO core_inbound_note_items
         (id, note_id, company_id, product_id, supplier_code, barcode, description,
          ncm, cfop, cest, origin, unit, quantity, unit_trib, quantity_trib,
          unit_cost_cents, total_cents, matched, matched_by,
          icms_cst, icms_csosn, icms_cents, icms_st_cents, ipi_cst, ipi_cents,
          pis_cst, pis_cents, cofins_cst, cofins_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of matched) {
      stmt.run(
        randomUUID(),
        noteId,
        input.companyId,
        item.productId,
        item.supplierCode,
        item.barcode,
        item.description,
        item.ncm,
        item.cfop,
        item.cest,
        item.origin,
        item.unit,
        item.quantity,
        item.unitTrib ?? null,
        item.quantityTrib ?? null,
        item.unitCostCents,
        item.totalCents,
        item.productId ? 1 : 0,
        // O MÉTODO fica gravado: é ele que a leitura devolve — nunca mais fabricado.
        item.matchedBy,
        // A tributação que o fornecedor declarou (GAP-PRD-181): matéria do
        // contador, nunca a do produto.
        item.taxes?.icmsCst ?? null,
        item.taxes?.icmsCsosn ?? null,
        item.taxes?.icmsCents ?? null,
        item.taxes?.icmsStCents ?? null,
        item.taxes?.ipiCst ?? null,
        item.taxes?.ipiCents ?? null,
        item.taxes?.pisCst ?? null,
        item.taxes?.pisCents ?? null,
        item.taxes?.cofinsCst ?? null,
        item.taxes?.cofinsCents ?? null,
      );
    }

    /*
      O QUE O FORNECEDOR DECLAROU VIRA SUGESTÃO — AQUI, e não só na confirmação.

      Os itens que casaram sozinhos já têm produto, e é agora que quem confere a
      nota pode ver a classificação proposta. Os que forem vinculados à mão
      depois, e os produtos que a confirmação criar, entram na segunda passada
      dentro de `confirmNfe` — as duas chamadas são seguras porque a chave da
      sugestão inclui a LINHA DA NOTA (ver FiscalSuggestionService).

      NADA É ESCRITO NO CADASTRO AQUI. Sugerir é sugerir; confirmar é ato
      humano, e é o que a tela fiscal faz em lote.
    */
    recordSuggestionsFromNote(input.companyId, noteId);

    if (reabriuEstornada) {
      // O rastro do gesto: qual nota morta cedeu a chave para qual nota viva.
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action: 'purchase.note.reimportada_apos_estorno',
        entityType: 'inbound_note',
        entityId: noteId,
        detail: { accessKey: parsed.accessKey, notaEstornada: reabriuEstornada },
      });
    }

    return {
      noteId,
      duplicated: false,
      status: NOTA_IMPORTADA,
      accessKey: parsed.accessKey,
      items: matched,
      ...(reabriuEstornada ? { reabriuEstornada } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Entrada manual — a compra SEM nota fiscal (GAP-V17)
// ---------------------------------------------------------------------------

export interface ManualEntryItemInput {
  productId: string;
  quantity: number;
  unitCostCents: number;
}

export interface ManualEntryResult {
  noteId: string;
  duplicated: boolean;
  status: string;
  totalCents: number;
  items: NoteItemDetail[];
}

/**
 * Cria o documento de ENTRADA MANUAL — a compra do fornecedor que não emite
 * nota (feira, autônomo, produtor rural; o cadastro de fornecedor aceita gente
 * sem documento DE PROPÓSITO, ver compras.test.ts).
 *
 * ## Por que um documento, e não um movimento de estoque
 *
 * O movimento manual move saldo e para por aí: sem documento, sem vínculo com
 * o fornecedor, sem contas a pagar. A dívida dessa compra não existia em lugar
 * nenhum e o histórico do fornecedor não a via. O documento entra no MESMO
 * funil conferir → confirmar da NF-e — estoque, custo, prazo do fornecedor,
 * conciliação com pedido e auditoria são os músculos já provados.
 *
 * ## O que ele NUNCA faz: fingir ser NF-e
 *
 * `doc_type = 'manual'` é a espécie declarada; a chave sintética começa com
 * "manual:" (nunca 44 dígitos); `xml_original` fica NULL porque arquivo não
 * existe; a confirmação grava o financeiro com origem PRÓPRIA
 * ('entrada_manual') e o razão com PURCHASE_RECEIPT, não XML_RECEIPT.
 *
 * ## Idempotência
 *
 * A UNIQUE (company_id, access_key) — a mesma que segura o XML reimportado —
 * segura o formulário reenviado: a `idempotencyKey` vira a chave sintética, e
 * a segunda submissão devolve a MESMA nota com `duplicated: true`. Sem chave
 * informada, cada chamada cria um documento novo (é o clique consciente).
 *
 * ## Itens SÓ do catálogo
 *
 * A entrada manual é mercadoria que vai para a prateleira: sem produto não há
 * saldo, custo nem conciliação — descrição livre aqui produziria exatamente o
 * item fantasma que a conferência da NF-e existe para impedir. Quem compra
 * material que não é revenda usa o lançamento avulso do financeiro.
 */
export function createManualInboundNote(input: {
  companyId: string;
  userId: string;
  supplierId: string;
  documentNumber?: string | null;
  idempotencyKey?: string | null;
  items: ManualEntryItemInput[];
}): ManualEntryResult {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();

    // A dívida precisa de um credor de verdade — e da MESMA empresa.
    const fornecedor = loadSupplier(input.companyId, input.supplierId);

    const chaveIdem = String(input.idempotencyKey ?? '').trim();
    const accessKey = `manual:${chaveIdem || randomUUID()}`;
    /*
      O QUE O FORMULÁRIO PEDIU (RES-IDEM-VIZ): fornecedor, documento e itens,
      sem ordem. A mesma chave com outra compra devolvia a nota antiga, calada
      — e a compra nova nunca entrava. Agora é 422, antes de qualquer escrita;
      nota anterior à impressão (nula) segue a regra de sempre.
    */
    const impressao = chaveIdem
      ? Impressao.impressaoDe({
          fornecedor: String(input.supplierId ?? ''),
          documento: String(input.documentNumber ?? '').trim(),
          itens: (Array.isArray(input.items) ? input.items : [])
            .map((i) =>
              JSON.stringify([
                String(i?.productId ?? '').trim(),
                Impressao.numero(i?.quantity),
                Impressao.inteiro(i?.unitCostCents),
              ]),
            )
            .sort(Impressao.porCodigo),
        })
      : null;
    if (chaveIdem) {
      const existente = db
        .prepare(
          `SELECT id, status, total_cents, idempotency_fingerprint FROM core_inbound_notes
            WHERE company_id = ? AND access_key = ?`,
        )
        .get(input.companyId, accessKey) as
        | { id: string; status: string; total_cents: number; idempotency_fingerprint: string | null }
        | undefined;
      if (existente) {
        if (impressao && Impressao.outraImpressao(existente.idempotency_fingerprint, impressao)) {
          throw Impressao.chaveReusada('outra entrada manual', { noteId: existente.id });
        }
        return {
          noteId: existente.id,
          duplicated: true,
          status: existente.status,
          totalCents: Number(existente.total_cents),
          items: listNoteItems(input.companyId, existente.id),
        };
      }
    }

    const itens = Array.isArray(input.items) ? input.items : [];
    if (itens.length === 0) {
      throw new ApiError(
        'CORE_MANUAL_ENTRY_EMPTY',
        'A entrada manual precisa de ao menos um item do catálogo.',
        400,
      );
    }

    /*
      NOTA INTEIRA OU NOTA NENHUMA: tudo validado ANTES do primeiro INSERT.
      A recusa nomeia o problema enquanto o formulário ainda está na tela —
      e o cabeçalho não sobrevive a item podre (a transação garante).
    */
    interface LinhaValidada {
      productId: string;
      descricao: string;
      unidade: string | null;
      quantidade: number;
      custoCents: number;
      totalCents: number;
    }
    const linhas: LinhaValidada[] = itens.map((item) => {
      const productId = String(item.productId ?? '').trim();
      if (!productId) {
        throw new ApiError(
          'CORE_MANUAL_ENTRY_INVALID',
          'Todo item da entrada manual é um produto do catálogo.',
          400,
        );
      }
      const produto = db
        .prepare(
          `SELECT p.id, p.name, p.unit, p.is_kit, p.kit_explode_on_sale,
                  EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
             FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
        )
        .get(productId, input.companyId) as
        | {
            id: string;
            name: string;
            unit: string | null;
            is_kit: number;
            kit_explode_on_sale: number;
            tem_grade: number;
          }
        | undefined;
      if (!produto) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
      // As mesmas recusas do funil de estoque, só que ANTES de existir nota:
      // deixar para a confirmação criaria um documento que nunca confirma.
      if (produto.tem_grade) {
        throw new ApiError(
          'CORE_PRODUCT_IS_GRID_MODEL',
          `"${produto.name}" é um modelo de grade: dê entrada na variante (tamanho/cor).`,
          400,
        );
      }
      if (produto.is_kit && produto.kit_explode_on_sale) {
        throw new ApiError(
          'CORE_PRODUCT_IS_KIT',
          `"${produto.name}" é um kit que desmembra na venda: dê entrada nos componentes.`,
          400,
        );
      }

      const quantidade = Number(item.quantity);
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        throw new ApiError('CORE_MANUAL_ENTRY_INVALID', 'Quantidade deve ser maior que zero.', 400);
      }
      const custoCents = Math.round(Number(item.unitCostCents ?? 0));
      if (!Number.isFinite(custoCents) || custoCents < 0) {
        throw new ApiError('CORE_MANUAL_ENTRY_INVALID', 'Custo não pode ser negativo.', 400);
      }
      return {
        productId,
        descricao: produto.name,
        // A unidade do CADASTRO, para a tela — item digitado não tem unidade
        // de nota para divergir, e é isso que faz o fator de conversão ser 1.
        unidade: produto.unit ?? null,
        quantidade,
        custoCents,
        totalCents: Math.round(quantidade * custoCents),
      };
    });

    const total = linhas.reduce((soma, l) => soma + l.totalCents, 0);
    const noteId = randomUUID();
    const now = new Date().toISOString();
    // Sem número do recibo/pedido do fornecedor, o documento ganha número
    // próprio da casa — documento sem identidade não se acha depois.
    const numero =
      String(input.documentNumber ?? '').trim()
      || `EM-${nextSequenceValue(input.companyId, 'entrada_manual')}`;

    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, series, supplier_id, issued_at,
          total_cents, status, doc_type, xml_original, created_at, idempotency_fingerprint)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'manual', NULL, ?, ?)`,
    ).run(
      noteId,
      input.companyId,
      accessKey,
      numero,
      String(fornecedor.id),
      now,
      total,
      NOTA_IMPORTADA,
      now,
      impressao,
    );

    const stmt = db.prepare(
      `INSERT INTO core_inbound_note_items
         (id, note_id, company_id, product_id, supplier_code, barcode, description,
          ncm, cfop, unit, quantity, unit_cost_cents, total_cents, matched, matched_by)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?, 1, 'manual')`,
    );
    for (const linha of linhas) {
      stmt.run(
        randomUUID(),
        noteId,
        input.companyId,
        linha.productId,
        linha.descricao,
        linha.unidade,
        linha.quantidade,
        linha.custoCents,
        linha.totalCents,
      );
    }

    return {
      noteId,
      duplicated: false,
      status: NOTA_IMPORTADA,
      totalCents: total,
      items: listNoteItems(input.companyId, noteId),
    };
  });
}

/** O item como a tela precisa dele: o casamento E a conferência, juntos. */
export interface NoteItemDetail extends MatchedItem {
  receivedQuantity: number | null;
  divergenceNote: string | null;
  /** A unidade tributável da nota — a menor unidade do item. */
  unitTrib: string | null;
  /** A quantidade NA unidade tributável. */
  quantityTrib: number | null;
  /** Quantas unidades do cadastro cabem em uma da nota. */
  conversionFactor: number | null;
  /**
   * COM QUAL PRODUTO o item casou — pelo nome, pelo código e pela unidade.
   *
   * O id sozinho não diz nada a quem confere: "Vinculado" sem o nome do
   * produto obrigava a pessoa a confiar no casamento por descrição às cegas, e
   * é justamente esse o casamento que erra. Nulos para item sem produto.
   */
  productName: string | null;
  productInternalCode: string | null;
  productUnit: string | null;
  /** O produto vinculado está ativo? Nulo para item sem produto (B-11). */
  productActive: boolean | null;
  /** O que o CADASTRO diz, para a conferência comparar com a nota (B-10). */
  productNcm: string | null;
  productCest: string | null;
  productOrigin: string | null;
  /** O `cEAN` declarado como "SEM GTIN" — não é o mesmo que "sem código" (B-10). */
  semGtin: boolean;
  /** O GTIN da unidade tributável (`cEANTrib`), quando o XML guardado o traz (B-05). */
  barcodeTrib: string | null;
  /**
   * O ESTADO DE CADA DADO FISCAL DA LINHA — B-estoque-entrada-10.
   *
   * A conferência mostrava EAN e NCM crus: o produto com NCM 8517.62.77 e a
   * nota dizendo 8517.13.00 passavam sem aviso, e "SEM GTIN" aparecia igual a
   * um código que não veio. Cada campo diz agora a relação entre a NOTA e o
   * CADASTRO do produto vinculado.
   */
  fiscal: {
    barcode: EstadoDoDadoFiscal;
    ncm: EstadoDoDadoFiscal;
    cest: EstadoDoDadoFiscal;
    origin: EstadoDoDadoFiscal;
  };
  /**
   * O FATOR QUE A CONFIRMAÇÃO APLICARIA sem nada digitado — B-estoque-entrada-M05.
   *
   * O placeholder da tela era `qTrib/qCom` sempre: prometia "12" onde o
   * servidor aplica 1 (unidade igual) e "1" onde ele recusa (unidades
   * diferentes sem par tributável). Nulo = a confirmação vai pedir o número.
   */
  resolvedFactor: number | null;
}

/**
 * O estado de um dado fiscal na conferência (B-10):
 *
 *   AUTO_DETECTADO  a nota declara e o cadastro ainda não tem (ou não há
 *                   produto): é o que a sugestão fiscal vai propor;
 *   CONFIRMADO      nota e cadastro dizem o mesmo — ou a nota não declara e o
 *                   cadastro já decidiu;
 *   DIVERGENTE      os dois declaram, e diferente;
 *   PENDENTE        ninguém declara;
 *   NAO_APLICAVEL   não se aplica: "SEM GTIN" declarado, CEST de mercadoria
 *                   sem substituição tributária.
 */
export type EstadoDoDadoFiscal =
  | 'AUTO_DETECTADO'
  | 'CONFIRMADO'
  | 'PENDENTE'
  | 'DIVERGENTE'
  | 'NAO_APLICAVEL';

function estadoDoCampoFiscal(
  daNota: unknown,
  doCadastro: unknown,
  vinculado: boolean,
  normalizar: (v: string) => string,
  vazioNaoSeAplica = false,
): EstadoDoDadoFiscal {
  const nota = daNota === null || daNota === undefined ? '' : normalizar(String(daNota));
  const cadastro = doCadastro === null || doCadastro === undefined ? '' : normalizar(String(doCadastro));
  const vazio: EstadoDoDadoFiscal = vazioNaoSeAplica ? 'NAO_APLICAVEL' : 'PENDENTE';
  if (!vinculado) return nota ? 'AUTO_DETECTADO' : vazio;
  if (!nota && !cadastro) return vazio;
  if (!nota) return 'CONFIRMADO';
  if (!cadastro) return 'AUTO_DETECTADO';
  return nota === cadastro ? 'CONFIRMADO' : 'DIVERGENTE';
}

const soDigitos = (v: string) => v.replace(/\D/g, '');
const semEspaco = (v: string) => v.trim();

/** A tributação declarada, como a linha da nota a guardou (GAP-PRD-181). */
function tributosDaLinha(r: Record<string, unknown>): ParsedNfeItemTaxes {
  const t = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    icmsCst: t(r.icms_cst),
    icmsCsosn: t(r.icms_csosn),
    icmsCents: n(r.icms_cents),
    icmsStCents: n(r.icms_st_cents),
    ipiCst: t(r.ipi_cst),
    ipiCents: n(r.ipi_cents),
    pisCst: t(r.pis_cst),
    pisCents: n(r.pis_cents),
    cofinsCst: t(r.cofins_cst),
    cofinsCents: n(r.cofins_cents),
  };
}

export function listNoteItems(companyId: string, noteId: string): NoteItemDetail[] {
  ensureCoreSchema();
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.internal_code AS product_internal_code,
              p.unit AS product_unit, p.active AS product_active, p.ncm AS product_ncm,
              p.cest AS product_cest, p.origin AS product_origin, p.barcode AS product_barcode,
              p.pack_factor AS product_pack_factor, p.pack_unit AS product_pack_unit
         FROM core_inbound_note_items i
         LEFT JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
        WHERE i.note_id = ? AND i.company_id = ? ORDER BY i.rowid`,
    )
    .all(noteId, companyId) as unknown as Record<string, unknown>[];
  const nota = db
    .prepare('SELECT supplier_id, doc_type, xml_original FROM core_inbound_notes WHERE id = ? AND company_id = ?')
    .get(noteId, companyId) as
    | { supplier_id: string | null; doc_type: string | null; xml_original: string | null }
    | undefined;
  const ehManual = String(nota?.doc_type ?? 'nfe') === 'manual';
  const extras = extrasDoXmlGuardado(nota?.xml_original, rows.length);
  const codigosDoProduto = db.prepare(
    'SELECT barcode FROM core_product_barcodes WHERE product_id = ? AND company_id = ?',
  );
  return rows.map((r, indice) => {
    const extra = extras[indice];
    const productId = (r.product_id as string) ?? null;
    const vinculado = Boolean(productId);

    /*
      O CÓDIGO DE BARRAS DA NOTA ESTÁ NO CADASTRO? O principal ou um adicional,
      pelo `cEAN` ou pelo `cEANTrib` — o produto que casou pelo EAN da unidade
      não "diverge" só porque a nota também traz o código da caixa.
    */
    let estadoDoCodigo: EstadoDoDadoFiscal;
    if (extra?.semGtin && !extra.barcodeTrib) estadoDoCodigo = 'NAO_APLICAVEL';
    else if (!r.barcode && !extra?.barcodeTrib) estadoDoCodigo = 'PENDENTE';
    else if (!vinculado) estadoDoCodigo = 'AUTO_DETECTADO';
    else {
      const doCadastro = new Set<string>(
        [
          r.product_barcode as string | null,
          ...(codigosDoProduto.all(productId, companyId) as unknown as { barcode: string }[]).map((b) => b.barcode),
        ].filter((c): c is string => Boolean(c)),
      );
      estadoDoCodigo = [r.barcode as string | null, extra?.barcodeTrib ?? null].some((c) => c && doCadastro.has(c))
        ? 'CONFIRMADO'
        : doCadastro.size === 0
          ? 'AUTO_DETECTADO'
          : 'DIVERGENTE';
    }

    /*
      O fator que a confirmação aplicaria SEM nada digitado (M05) — a mesma
      conta de `confirmNfe`, com o que foi digitado deixado de fora (o digitado
      aparece como VALOR do campo, não como sugestão).
    */
    const semDigitado = { ...r, conversion_factor: null };
    const resolvedFactor = ehManual
      ? 1
      : vinculado
        ? fatorDeConversao(
            semDigitado as Parameters<typeof fatorDeConversao>[0],
            r.product_unit,
            { fator: r.product_pack_factor, unidade: r.product_pack_unit },
            () =>
              fatorAprendido(db, {
                companyId,
                supplierId: nota?.supplier_id ?? null,
                supplierCode: r.supplier_code,
                productId: productId as string,
                unidadeDaNota: r.unit,
                unidadeDoCadastro: r.product_unit,
                noteId,
              }),
          )
        : planoDoProdutoNovo(r, extra, false).fator;

    /*
      POR QUE O ITEM QUASE CASOU, AGORA (B-estoque-entrada-M04).

      O motivo só existia na resposta da IMPORTAÇÃO: não era gravado, e a nota
      reaberta mostrava a camiseta do modelo de grade só como "sem produto".
      Ele é refeito a cada leitura, contra o catálogo de AGORA — o que é melhor
      que gravado: se o produto certo nasceu depois, a frase diz isso.
    */
    let matchNote: string | null = null;
    if (!vinculado && !ehManual) {
      const [refeito] = matchItems(
        companyId,
        [
          {
            supplierCode: (r.supplier_code as string) ?? null,
            barcode: (r.barcode as string) ?? null,
            barcodeTrib: extra?.barcodeTrib ?? null,
            description: String(r.description),
            ncm: null,
            cfop: null,
            cest: null,
            origin: null,
            unit: (r.unit as string) ?? null,
            quantity: Number(r.quantity),
            unitTrib: null,
            quantityTrib: null,
            unitCostCents: 0,
            totalCents: 0,
          },
        ],
        nota?.supplier_id ?? null,
      );
      if (refeito.productId) {
        const nome = (db.prepare('SELECT name FROM core_products WHERE id = ?').get(refeito.productId) as
          | { name: string }
          | undefined)?.name;
        matchNote = `O catálogo já tem este item${nome ? ` ("${nome}")` : ''} — use "Vincular" em vez de cadastrar outro.`;
      } else {
        matchNote = refeito.matchNote ?? null;
      }
    }

    return {
    productName: (r.product_name as string) ?? null,
    productInternalCode: (r.product_internal_code as string) ?? null,
    productUnit: (r.product_unit as string) ?? null,
    productActive: vinculado ? Number(r.product_active) === 1 : null,
    productNcm: (r.product_ncm as string) ?? null,
    productCest: (r.product_cest as string) ?? null,
    productOrigin: (r.product_origin as string) ?? null,
    semGtin: Boolean(extra?.semGtin),
    barcodeTrib: extra?.barcodeTrib ?? null,
    fiscal: {
      barcode: estadoDoCodigo,
      ncm: estadoDoCampoFiscal(r.ncm, r.product_ncm, vinculado, soDigitos),
      cest: estadoDoCampoFiscal(r.cest, r.product_cest, vinculado, soDigitos, true),
      origin: estadoDoCampoFiscal(r.origin, r.product_origin, vinculado, semEspaco),
    },
    resolvedFactor,
    matchNote,
    supplierCode: (r.supplier_code as string) ?? null,
    barcode: (r.barcode as string) ?? null,
    description: r.description as string,
    ncm: (r.ncm as string) ?? null,
    cfop: (r.cfop as string) ?? null,
    // O que o fornecedor declarou sobre a MERCADORIA. Volta para a tela junto
    // do resto: é dele que a sugestão de classificação nasce, e quem confere
    // precisa poder ver a matéria-prima da sugestão na própria linha da nota.
    cest: (r.cest as string) ?? null,
    origin: (r.origin as string) ?? null,
    taxes: tributosDaLinha(r),
    unit: (r.unit as string) ?? null,
    quantity: Number(r.quantity),
    /*
      A CONVERSÃO VOLTA PARA A TELA.

      Sem ela, quem reabre a nota vê "10" e não sabe se são 10 caixas ou
      10 parafusos — e o fator que o conferente informou some, como a
      conferência sumia antes da rodada 44.
    */
    unitTrib: (r.unit_trib as string) ?? null,
    quantityTrib:
      r.quantity_trib === null || r.quantity_trib === undefined
        ? null
        : Number(r.quantity_trib),
    conversionFactor:
      r.conversion_factor === null || r.conversion_factor === undefined
        ? null
        : Number(r.conversion_factor),
    unitCostCents: Number(r.unit_cost_cents),
    totalCents: Number(r.total_cents),
    productId: (r.product_id as string) ?? null,
    /*
      O método vem da COLUNA, nunca mais fabricado. A linha antiga dizia
      `r.product_id ? 'barcode' : null` — todo item vinculado voltava como
      código de barras, mesmo casado por código interno, descrição ou mão.
      Item anterior à coluna (e produto CRIADO pela confirmação, que não
      casou com nada) volta NULL: não se inventa história retroativa.
    */
    matchedBy: (r.matched_by as NoteItemDetail['matchedBy']) ?? null,
    /*
      A conferência VOLTA. Era gravada e descartada neste map — a coluna
      "Diferença" da tela mostrava "—" para sempre, e reabrir a nota
      apagava (na tela) a contagem recém-feita. NULL é "ninguém contou";
      zero é "contei e não veio" — e o zero precisa voltar como zero.
    */
    receivedQuantity: r.received_quantity === null || r.received_quantity === undefined
      ? null
      : Number(r.received_quantity),
    divergenceNote: (r.divergence_note as string) ?? null,
    };
  });
}

/**
 * Registra o que o conferente CONTOU num item da nota.
 *
 * Existe porque nem sempre chega o que foi faturado. Sem este passo o estoque
 * entrava pela quantidade do arquivo, e um saldo maior que a prateleira só
 * apareceria na contagem seguinte — quando ninguém mais lembra de qual nota
 * veio.
 *
 * Só vale antes de receber: depois da entrada aplicada, corrigir quantidade é
 * ajuste de inventário, com rastro próprio, e não uma edição silenciosa da
 * nota.
 */
export function conferirItem(input: {
  companyId: string;
  noteId: string;
  itemIndex: number;
  /**
   * O que chegou. AUSENTE (B-estoque-entrada-18) é "não mexi na quantidade":
   * o blur do campo de fator mandava `receivedQuantity = quantity` junto, e só
   * atravessar o campo com Tab gravava "chegou tudo" num item que ninguém
   * contou — a coluna passava a dizer "Conferido".
   */
  receivedQuantity?: number | null;
  divergenceNote?: string;
  /**
   * Quantas unidades do CADASTRO vêm em uma unidade da NOTA.
   *
   * Só é preciso quando as duas unidades diferem e a própria nota não
   * resolve — o fornecedor que fatura EM caixa e tributa EM caixa. Sem
   * isso a entrada é recusada, porque assumir 1:1 é o defeito.
   */
  conversionFactor?: number | null;
}): void {
  ensureCoreSchema();
  const db = getConnection();

  const nota = db
    .prepare('SELECT status FROM core_inbound_notes WHERE id = ? AND company_id = ?')
    .get(input.noteId, input.companyId) as { status: string } | undefined;
  if (!nota) throw new ApiError('CORE_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);
  if (nota.status === 'recebida') {
    throw new ApiError(
      'CORE_NOTE_ALREADY_RECEIVED',
      'Nota já recebida. Diferença encontrada depois da entrada é ajuste de inventário.',
      409,
    );
  }
  // Documento morto não recebe contagem: a conferência de uma nota estornada
  // seria gravada em cima de um retrato que já foi desfeito.
  if (nota.status === NOTA_ESTORNADA) {
    throw new ApiError(
      'CORE_NOTE_REVERSED',
      'Nota estornada não se confere. Se a mercadoria realmente chegou, importe o mesmo XML de novo: '
        + 'a tela oferece uma nova conferência.',
      409,
    );
  }
  const informouQuantidade = input.receivedQuantity !== undefined && input.receivedQuantity !== null;
  const recebida = Number(input.receivedQuantity);
  if (informouQuantidade && (!Number.isFinite(recebida) || recebida < 0)) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade conferida inválida.', 400);
  }
  /*
    Fator zero ou negativo não é conversão — é saldo apagado ou saldo
    negativo entrando pela porta da doca. `undefined` é "não informou", e
    aí a coluna fica NULL e a confirmação decide pelo que a nota diz.
  */
  const fator =
    input.conversionFactor === undefined || input.conversionFactor === null
      ? null
      : Number(input.conversionFactor);
  if (fator !== null && (!Number.isFinite(fator) || fator <= 0)) {
    throw new ApiError(
      'CORE_INVALID_CONVERSION',
      'Quantas unidades vêm em uma da nota? O número precisa ser maior que zero.',
      400,
    );
  }

  const rows = db
    .prepare(
      'SELECT id FROM core_inbound_note_items WHERE note_id = ? AND company_id = ? ORDER BY rowid',
    )
    .all(input.noteId, input.companyId) as unknown as { id: string }[];
  const row = rows[input.itemIndex];
  if (!row) throw new ApiError('CORE_ITEM_NOT_FOUND', 'Item da nota não encontrado.', 404);

  if (!informouQuantidade && fator === null && input.divergenceNote === undefined) {
    throw new ApiError(
      'CORE_CONFERENCIA_VAZIA',
      'Nada a registrar: informe a quantidade que chegou, o fator de conversão ou o motivo da diferença.',
      400,
    );
  }

  if (informouQuantidade) {
    // Com a quantidade, o motivo vai junto como sempre foi: omiti-lo o apaga
    // (a tela reenvia o motivo já gravado quando só a quantidade muda).
    db.prepare(
      `UPDATE core_inbound_note_items
          SET received_quantity = ?, divergence_note = ?,
              conversion_factor = COALESCE(?, conversion_factor)
        WHERE id = ?`,
    ).run(recebida, input.divergenceNote ?? null, fator, row.id);
    return;
  }
  // Sem quantidade: só o que veio — o fator, o motivo — e a contagem fica como estava.
  if (fator !== null) {
    db.prepare('UPDATE core_inbound_note_items SET conversion_factor = ? WHERE id = ?').run(fator, row.id);
  }
  if (input.divergenceNote !== undefined) {
    db.prepare('UPDATE core_inbound_note_items SET divergence_note = ? WHERE id = ?').run(
      String(input.divergenceNote ?? '').trim() || null,
      row.id,
    );
  }
}

export interface LinkResult {
  /** O produto em que o item estava antes deste gesto (nulo = sem produto). */
  anterior: string | null;
  /** O de-para do fornecedor foi gravado (vínculo) ou esquecido (desvínculo)? */
  lembrado: boolean;
  /** `true` quando o gesto foi DESFAZER o vínculo. */
  desvinculado: boolean;
}

/**
 * Grava (ou reescreve) o de-para "código do fornecedor → produto".
 *
 * Só existe quando há de quem e do quê: nota sem fornecedor (XML sem emitente
 * legível) ou item sem `cProd` não ensinam nada. A entrada manual nunca chega
 * aqui — os itens dela já nascem do catálogo, sem código de fornecedor.
 */
function lembrarDePara(
  db: ReturnType<typeof getConnection>,
  input: {
    companyId: string;
    supplierId: string | null;
    supplierCode: string | null;
    productId: string;
    origin: 'vinculo_manual' | 'cadastro_pela_nota';
    noteId: string;
    userId: string | null;
    /** `false` = só grava se ainda não existe (a confirmação não atropela gente). */
    sobrescrever: boolean;
  },
): boolean {
  if (!input.supplierId || !input.supplierCode) return false;
  const agora = new Date().toISOString();
  const conflito = input.sobrescrever
    ? `DO UPDATE SET product_id = excluded.product_id, origin = excluded.origin,
                     source_note_id = excluded.source_note_id,
                     created_by = excluded.created_by, updated_at = excluded.updated_at`
    : 'DO NOTHING';
  db.prepare(
    `INSERT INTO core_supplier_item_codes
       (id, company_id, supplier_id, supplier_code, product_id, origin, source_note_id,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, supplier_id, supplier_code) ${conflito}`,
  ).run(
    randomUUID(),
    input.companyId,
    input.supplierId,
    input.supplierCode,
    input.productId,
    input.origin,
    input.noteId,
    input.userId,
    agora,
    agora,
  );
  return true;
}

/**
 * Vincula um item da nota a um produto do catálogo — ou DESFAZ o vínculo.
 *
 * ## Só em conferência (GAP-PRD-085)
 *
 * Era o vizinho de `conferirItem` que não lia o status. Numa nota RECEBIDA o
 * item mudava de produto: o razão continuava dizendo que entrou o produto
 * original (e está certo), mas a nota passava a afirmar outro — o
 * `recalcReceived` do pedido amarrado somava o produto errado e a conciliação
 * mostrava divergência inexistente. Depois da entrada, trocar o produto é
 * estorno + nova entrada, com rastro; nunca edição silenciosa do documento.
 *
 * ## O vínculo APRENDE (GAP-PRD-015)
 *
 * Com `lembrar` (padrão), o gesto grava o de-para do fornecedor e a próxima
 * nota dele casa sozinha. Desfazer (`productId: null`) esquece o de-para que
 * apontava para aquele produto — quem desfaz está dizendo que aquele código
 * NÃO é aquele produto.
 *
 * ## As mesmas recusas do funil de estoque, ANTES da confirmação
 *
 * Modelo de grade e kit que desmembra não recebem saldo (`applyMovement`
 * recusa). Deixar a recusa para a confirmação mandaria a pessoa para o fim da
 * nota com um vínculo que nunca vai entrar.
 */
export function linkNoteItem(input: {
  companyId: string;
  noteId: string;
  itemIndex: number;
  /** `null` desfaz o vínculo: o item volta para "sem produto". */
  productId: string | null;
  userId?: string | null;
  /** Gravar o de-para do fornecedor para as próximas notas. Padrão: sim. */
  lembrar?: boolean;
}): LinkResult {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();

    const nota = db
      .prepare(
        'SELECT status, supplier_id, doc_type FROM core_inbound_notes WHERE id = ? AND company_id = ?',
      )
      .get(input.noteId, input.companyId) as
      | { status: string; supplier_id: string | null; doc_type: string | null }
      | undefined;
    if (!nota) throw new ApiError('CORE_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);
    if (nota.status === NOTA_RECEBIDA) {
      throw new ApiError(
        'CORE_NOTE_ALREADY_RECEIVED',
        'Nota já recebida: o item não troca mais de produto. Se a mercadoria entrou no produto '
          + 'errado, estorne a entrada e importe o mesmo XML de novo — a tela oferece uma nova conferência.',
        409,
      );
    }
    if (nota.status === NOTA_ESTORNADA) {
      throw new ApiError(
        'CORE_NOTE_REVERSED',
        'Nota estornada não se vincula. Se a mercadoria realmente chegou, importe o mesmo XML de novo: '
          + 'a tela oferece uma nova conferência.',
        409,
      );
    }
    if (nota.status !== NOTA_IMPORTADA) {
      throw new ApiError(
        'CORE_NOTE_NOT_IN_CONFERENCE',
        'Só nota em conferência tem item vinculado ou desvinculado.',
        409,
      );
    }

    const rows = db
      .prepare(
        `SELECT id, product_id, supplier_code FROM core_inbound_note_items
          WHERE note_id = ? AND company_id = ? ORDER BY rowid`,
      )
      .all(input.noteId, input.companyId) as unknown as {
      id: string;
      product_id: string | null;
      supplier_code: string | null;
    }[];
    const row = Number.isInteger(input.itemIndex) ? rows[input.itemIndex] : undefined;
    if (!row) throw new ApiError('CORE_ITEM_NOT_FOUND', 'Item da nota não encontrado.', 404);

    const anterior = row.product_id ?? null;
    // O de-para é do FORNECEDOR que emitiu a nota. A entrada manual não tem
    // código de fornecedor nos itens, e mesmo assim fica de fora explicitamente.
    const fornecedor = String(nota.doc_type ?? 'nfe') === 'manual' ? null : nota.supplier_id;

    if (input.productId === null) {
      db.prepare(
        `UPDATE core_inbound_note_items
            SET product_id = NULL, matched = 0, matched_by = NULL
          WHERE id = ?`,
      ).run(row.id);
      let esquecido = false;
      if (fornecedor && row.supplier_code && anterior) {
        const r = db
          .prepare(
            `DELETE FROM core_supplier_item_codes
              WHERE company_id = ? AND supplier_id = ? AND supplier_code = ? AND product_id = ?`,
          )
          .run(input.companyId, fornecedor, row.supplier_code, anterior);
        esquecido = Number(r.changes) > 0;
      }
      return { anterior, lembrado: esquecido, desvinculado: true };
    }

    const produto = db
      .prepare(
        `SELECT p.id, p.name, p.is_kit, p.kit_explode_on_sale, p.active,
                EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
           FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
      )
      .get(input.productId, input.companyId) as
      | {
          id: string;
          name: string;
          is_kit: number;
          kit_explode_on_sale: number;
          active: number;
          tem_grade: number;
        }
      | undefined;
    if (!produto) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
    /*
      PRODUTO INATIVO NÃO RECEBE VÍNCULO (B-estoque-entrada-11). A mercadoria
      ficaria parada num cadastro que o PDV não vende — e o bipe dela no
      balcão diria "não encontrado".
    */
    if (!produto.active) {
      throw new ApiError(
        'CORE_PRODUCT_INACTIVE',
        `"${produto.name}" está inativo no cadastro — o PDV não vende produto inativo, e a mercadoria `
          + 'ficaria parada nele. Reative o produto antes de vincular, ou escolha outro.',
        400,
      );
    }
    if (produto.tem_grade) {
      throw new ApiError(
        'CORE_PRODUCT_IS_GRID_MODEL',
        `"${produto.name}" é um modelo de grade: vincule a variante (tamanho/cor).`,
        400,
      );
    }
    if (produto.is_kit && produto.kit_explode_on_sale) {
      throw new ApiError(
        'CORE_PRODUCT_IS_KIT',
        `"${produto.name}" é um kit que desmembra na venda: dê entrada nos componentes.`,
        400,
      );
    }

    // Vínculo feito por GENTE fica registrado como manual — quem auditar a
    // entrada distingue o casamento automático da decisão humana.
    db.prepare(
      "UPDATE core_inbound_note_items SET product_id = ?, matched = 1, matched_by = 'manual' WHERE id = ?",
    ).run(produto.id, row.id);

    const lembrado =
      input.lembrar === false
        ? false
        : lembrarDePara(db, {
            companyId: input.companyId,
            supplierId: fornecedor,
            supplierCode: row.supplier_code,
            productId: produto.id,
            origin: 'vinculo_manual',
            noteId: input.noteId,
            userId: input.userId ?? null,
            sobrescrever: true,
          });
    return { anterior, lembrado, desvinculado: false };
  });
}

export interface ConfirmResult {
  noteId: string;
  status: string;
  createdProducts: number;
  movedItems: number;
  divergentItems?: number;
  alreadyReceived: boolean;
  /**
   * Por que a nota NÃO gerou conta a pagar (B-estoque-entrada-03): todos os
   * itens são de remessa sem ônus (bonificação, amostra, demonstração,
   * consignação). Nulo quando gerou — ou quando o total é zero.
   */
  semContaAPagar?: string | null;
  /** O que quem confirmou precisa saber, mas não impediu a entrada (nota mista). */
  aviso?: string | null;
}

/**
 * OS CFOPS DE ENTRADA SEM ÔNUS — B-estoque-entrada-03.
 *
 * O CFOP do item é o da SAÍDA do fornecedor (5xxx dentro do estado, 6xxx fora).
 * Os três últimos dígitos dizem a natureza, e estes não são venda: a
 * mercadoria veio de graça ou continua sendo do fornecedor. A confirmação
 * criava conta a pagar pelo `vNF` de TODA nota com total maior que zero — e a
 * NF-e de bonificação real tem `vNF` maior que zero (o comentário antigo
 * supunha "bonificação = total zero"). O financeiro podia pagar o que era
 * brinde.
 */
const CFOP_SEM_ONUS: Record<string, string> = {
  '910': 'bonificação, doação ou brinde',
  '911': 'amostra grátis',
  '912': 'demonstração',
  '917': 'consignação mercantil',
  '949': 'outra saída não especificada (remessa)',
};

function naturezaSemOnus(cfop: unknown): string | null {
  const d = String(cfop ?? '').replace(/\D/g, '');
  if (d.length !== 4 || !['5', '6', '7'].includes(d[0])) return null;
  return CFOP_SEM_ONUS[d.slice(1)] ?? null;
}

/**
 * Confirma o recebimento: cria os produtos que faltam e dá entrada no estoque.
 *
 * A referência do movimento é a nota, então a entrada acontece uma única vez
 * mesmo que a confirmação seja reenviada.
 */
export function confirmNfe(input: {
  companyId: string;
  noteId: string;
  userId: string;
  /** Itens sem produto que o conferente autorizou cadastrar. */
  createMissing?: boolean;
}): ConfirmResult {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const note = db
      .prepare('SELECT * FROM core_inbound_notes WHERE id = ? AND company_id = ?')
      .get(input.noteId, input.companyId) as
      | {
          id: string;
          status: string;
          access_key: string;
          number: string | null;
          doc_type: string | null;
          purchase_order_id: string | null;
          supplier_id: string | null;
          xml_original: string | null;
          recipient_document: string | null;
          recipient_name: string | null;
        }
      | undefined;
    if (!note) throw new ApiError('CORE_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);
    if (note.status === 'recebida') {
      return {
        noteId: note.id,
        status: note.status,
        createdProducts: 0,
        movedItems: 0,
        alreadyReceived: true,
      };
    }
    /*
      A NOTA DE OUTRA EMPRESA QUE ENTROU ANTES DA TRAVA (B-estoque-entrada-02):
      é aqui que o estoque anda e a dívida nasce, então o destinatário gravado
      na importação é conferido de novo.
    */
    if (String(note.doc_type ?? 'nfe') !== 'manual') {
      exigirNotaDestaEmpresa(input.companyId, {
        document: note.recipient_document,
        name: note.recipient_name,
      });
    }
    /*
      NOTA ESTORNADA NÃO RESSUSCITA POR CONFIRMAÇÃO.

      Sem esta recusa, o reconfirmar seria um zumbi silencioso: o movimento
      de entrada seria DEDUPLICADO (a referência é a mesma — nada entraria no
      estoque), a dívida cancelada continuaria cancelada (a UNIQUE segura o
      segundo INSERT), e mesmo assim o status voltaria a 'recebida' — uma
      nota afirmando entrada que o razão nega. Quem errou o estorno lança a
      entrada DE NOVO, com documento novo e rastro novo.
    */
    if (note.status === NOTA_ESTORNADA) {
      throw new ApiError(
        'CORE_NOTE_REVERSED',
        'Nota estornada não volta a entrar por aqui. Se a mercadoria realmente chegou, importe o mesmo '
          + 'XML de novo: a tela oferece uma nova conferência, e a nota estornada fica no histórico.',
        409,
      );
    }

    /*
      A NOTA DE HOMOLOGAÇÃO QUE ENTROU ANTES DA TRAVA (R3-DFE, GAP-PRD-168).

      A importação recusa a nota de teste numa empresa em produção, mas a que
      entrou antes (ou com a empresa ainda em homologação) continua no funil —
      e é AQUI que o estoque anda e a conta a pagar nasce. Só a homologação
      EXPLÍCITA barra: a nota antiga sem arquivo, ou com arquivo sem tpAmb,
      segue como sempre seguiu.
    */
    if (String(note.doc_type ?? 'nfe') !== 'manual') {
      const xmlGuardado = (note as { xml_original?: string | null }).xml_original;
      if (ambienteDoXmlGuardado(xmlGuardado) === 'homologation') {
        exigirNotaComValidadeFiscal(input.companyId, 'homologation');
      }
    }

    /*
      A ESPÉCIE DO DOCUMENTO decide o vocabulário — nunca o comportamento.

      A entrada manual (doc_type 'manual', GAP-V17) passa por ESTE MESMO funil
      de propósito: estoque, custo, prazo do fornecedor e pedido amarrado são
      os músculos provados da NF-e. O que muda é o que fica ESCRITO: a chave
      sintética "manual:…" não tem os 9 dígitos de número da chave de acesso
      (o slice sairia lixo), o razão não pode afirmar "Entrada por XML" de um
      arquivo que não existe, e o financeiro nasce com origem própria — quem
      lê o contas a pagar sabe que ali não há XML por trás.
    */
    const ehManual = String(note.doc_type ?? 'nfe') === 'manual';
    const referenciaDaEntrada = ehManual ? 'entrada_manual' : 'nfe_entrada';
    const rotuloDoc = ehManual
      ? `Entrada manual ${note.number ?? note.id.slice(0, 8)}`
      : `NF-e ${note.access_key.slice(25, 34)}`;

    const rows = db
      .prepare('SELECT * FROM core_inbound_note_items WHERE note_id = ? ORDER BY rowid')
      .all(input.noteId) as unknown as Record<string, unknown>[];

    const unmatched = rows.filter((r) => !r.product_id);
    if (unmatched.length > 0 && !input.createMissing) {
      throw new ApiError(
        'CORE_UNMATCHED_ITEMS',
        `${unmatched.length} item(ns) sem produto vinculado. Vincule ou autorize o cadastro.`,
        409,
        { unmatched: unmatched.map((r) => r.description) },
      );
    }

    /*
      ================================================================
      A UNIDADE É CONFERIDA ANTES DE QUALQUER ESCRITA
      ================================================================

      Nota inteira ou nota nenhuma. Recusar no meio do laço deixaria metade
      da nota dentro do estoque (a transação desfaz, mas a mensagem sairia
      do meio de um trabalho já feito, e o conferente não saberia quantas
      linhas ainda têm o mesmo problema).

      Aqui todas as linhas são examinadas e a recusa nomeia as que faltam
      resolver — porque quem está na doca resolve tudo de uma vez.
    */
    const fatorPorLinha = new Map<string, number>();
    /**
     * A unidade do CADASTRO com que cada linha foi resolvida — a do produto
     * vinculado, ou a do produto que a nota vai cadastrar. Vai para a trilha
     * junto com o fator que uma pessoa declarou (B-estoque-entrada-R02).
     */
    const unidadeDoCadastroPorLinha = new Map<string, string | null>();
    const semConversao: string[] = [];
    /*
      O que o XML GUARDADO diz e a linha não guarda: o GTIN da unidade (B-05/06)
      e o custo efetivo (B-09). A entrada manual não tem arquivo, e a nota
      antiga também não: as duas seguem com o que a linha gravou.
    */
    const extras = ehManual ? [] : extrasDoXmlGuardado(note.xml_original, rows.length);
    /** Como nasce cada produto que esta confirmação vai cadastrar (B-06/M01). */
    const planoPorLinha = new Map<string, PlanoDoProdutoNovo>();
    const codigoDeOutro: string[] = [];
    const inativos: string[] = [];
    for (let indice = 0; indice < rows.length; indice += 1) {
      const row = rows[indice];
      const productId = row.product_id as string | null;
      /*
        O PRODUTO QUE AINDA NÃO EXISTE nascia SEMPRE na unidade da nota, com
        fator 1 fixo — e o fator que o conferente digitou nesta linha era jogado
        fora (B-estoque-entrada-M01). Agora nasce pelo plano: o digitado, o par
        tributável da nota, ou a unidade da nota, nesta ordem.
      */
      if (!productId) {
        const plano = planoDoProdutoNovo(row, extras[indice]);
        planoPorLinha.set(String(row.id), plano);
        fatorPorLinha.set(String(row.id), plano.fator);
        unidadeDoCadastroPorLinha.set(String(row.id), plano.unidade);
        /*
          O CÓDIGO QUE JÁ É DE OUTRO PRODUTO, NOMEADO ANTES DE QUALQUER ESCRITA
          (B-estoque-entrada-M04).

          A linha cujo EAN é o de um modelo de grade (ou de um kit, ou de um
          produto inativo) chegava aqui sem produto, e o `createProduct` a
          derrubava NO MEIO DO LAÇO com "Este código de barras já pertence a
          outro produto." — sem dizer qual linha, qual código nem o que fazer.
          A nota de 40 itens era recusada inteira por um que ninguém achava.
        */
        if (input.createMissing) {
          // Só o código que o cadastro vai GRAVAR: o da caixa não entra mais
          // no produto da unidade (PED-ent-01), então não tem com quem colidir.
          for (const codigo of [plano.barcode]) {
            if (!codigo) continue;
            const dono = findProductByAnyBarcode(input.companyId, codigo);
            if (!dono) continue;
            const outro = db
              .prepare(
                `SELECT p.name, p.is_kit, p.kit_explode_on_sale, p.active,
                        EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
                   FROM core_products p WHERE p.id = ?`,
              )
              .get(dono) as
              | { name: string; is_kit: number; kit_explode_on_sale: number; active: number; tem_grade: number }
              | undefined;
            const oQueFazer = outro?.tem_grade
              ? 'um modelo de grade: vincule a linha à variante (tamanho/cor)'
              : outro?.is_kit && outro.kit_explode_on_sale
                ? 'um kit que desmembra na venda: vincule aos componentes'
                : outro && !outro.active
                  ? 'um produto INATIVO: reative-o e vincule a linha a ele'
                  : 'vincule a linha a ele em vez de cadastrar outro';
            codigoDeOutro.push(
              `"${String(row.description)}" (código ${codigo}) já é de "${outro?.name ?? dono}" — ${oQueFazer}`,
            );
          }
        }
        continue;
      }
      const produto = db
        .prepare('SELECT name, unit, pack_factor, pack_unit, active FROM core_products WHERE id = ?')
        .get(productId) as
        | {
            name: string;
            unit: string | null;
            pack_factor: number | null;
            pack_unit: string | null;
            active: number;
          }
        | undefined;
      /*
        PRODUTO QUE FICOU INATIVO DEPOIS DO VÍNCULO (B-estoque-entrada-11): o
        saldo entraria num cadastro que o PDV não vende.
      */
      if (produto && !produto.active) {
        inativos.push(`"${String(row.description)}" está vinculado a "${produto.name}", que está inativo`);
        continue;
      }
      const fator = fatorDeConversao(
        row as {
          unit: unknown;
          quantity: unknown;
          unit_trib?: unknown;
          quantity_trib?: unknown;
          conversion_factor?: unknown;
        },
        produto?.unit,
        { fator: produto?.pack_factor, unidade: produto?.pack_unit },
        ehManual
          ? null
          : () =>
              fatorAprendido(db, {
                companyId: input.companyId,
                supplierId: note.supplier_id,
                supplierCode: row.supplier_code,
                productId,
                unidadeDaNota: row.unit,
                unidadeDoCadastro: produto?.unit,
                noteId: input.noteId,
              }),
      );
      if (fator === null) {
        semConversao.push(
          `"${String(row.description)}": a nota está em ${siglaDaUnidade(row.unit)} e o `
            + `cadastro em ${siglaDaUnidade(produto?.unit)}`,
        );
        continue;
      }
      fatorPorLinha.set(String(row.id), fator);
      unidadeDoCadastroPorLinha.set(String(row.id), produto?.unit ?? null);
    }
    if (codigoDeOutro.length > 0) {
      throw new ApiError(
        'CORE_BARCODE_BELONGS_TO',
        `${codigoDeOutro.length} item(ns) sem vínculo têm código de barras que já pertence a um produto `
          + `do catálogo — nada entrou: ${codigoDeOutro.join('; ')}.`,
        409,
        { itens: codigoDeOutro },
      );
    }
    if (inativos.length > 0) {
      throw new ApiError(
        'CORE_PRODUCT_INACTIVE',
        `${inativos.length} item(ns) vinculado(s) a produto inativo — o PDV não vende produto inativo, e a `
          + `mercadoria ficaria parada nele. Reative o produto ou troque o vínculo: ${inativos.join('; ')}.`,
        409,
        { itens: inativos },
      );
    }
    if (semConversao.length > 0) {
      throw new ApiError(
        'CORE_UNIT_MISMATCH',
        `${semConversao.length} item(ns) em unidade diferente da do cadastro. Informe `
          + 'quantas unidades vêm em uma da nota, na conferência: '
          + semConversao.join('; ') + '.',
        409,
        { itens: semConversao },
      );
    }

    let createdProducts = 0;
    let movedItems = 0;
    let divergentItems = 0;

    // Resolvida UMA vez, fora do laço: é a mesma resposta para todos os itens,
    // e consultar por item seria N idas ao banco para o mesmo valor.
    const config = getInboundConfig(input.companyId);

    /*
      ================================================================
      O MESMO PRODUTO EM DOIS ITENS DA NOTA
      ================================================================

      Fornecedor fatura a mesma peça em dois `<det>` — dois lotes, dois preços
      — e a nota diz 4 + 6. A prateleira recebe 10.

      Aplicar um movimento POR ITEM, como este laço fazia, produzia duas
      chamadas com a MESMA chave de idempotência: `applyMovement` distingue por
      (empresa, referência, id da referência, produto, tipo), e aqui a
      referência é a NOTA. A segunda voltava com `duplicated: true`, a
      quantidade dela era descartada, e o estoque ficava com 4.

      Não havia erro nem aviso: a tela dizia "entrada confirmada". A diferença
      só apareceria na contagem seguinte, sem ninguém conseguir ligá-la a uma
      nota de semanas antes. Medido: 4 no lugar de 10.

      E havia a outra face, essa barulhenta: quando o produto AINDA NÃO existe,
      a segunda linha tentava cadastrar de novo o mesmo código de barras e a
      nota inteira era recusada com "este código de barras já pertence a outro
      produto" — mensagem que não diz nada a quem está na doca.

      As duas se resolvem no mesmo lugar: o laço RESOLVE e ACUMULA, e o estoque
      é movido depois, uma vez por produto. É o mesmo desenho que a importação
      de planilha já usava.
    */
    interface EntradaAgrupada {
      quantidade: number;
      /**
       * O custo da ÚLTIMA linha PAGA que entrou — a regra que o balcão entende.
       * Nulo quando todas as linhas deste produto são de remessa sem ônus
       * (B-estoque-entrada-03): nada foi pago, e o custo do cadastro fica.
       */
      custoCents: number | null;
      /** Quantas linhas da nota caíram neste produto. */
      linhas: number;
    }
    const porProduto = new Map<string, EntradaAgrupada>();
    /*
      Produtos criados por ESTA confirmação, indexados pelo que os identifica na
      nota. Sem isto, a segunda linha do mesmo produto tenta cadastrar de novo.
      A chave é o código de barras quando existe — é ele que o cadastro exige
      único — e o código do fornecedor quando não há barras.
    */
    const criadosAgora = new Map<string, string>();

    for (let indice = 0; indice < rows.length; indice += 1) {
      const row = rows[indice];
      let productId = row.product_id as string | null;
      const plano = planoPorLinha.get(String(row.id));

      const identidadeNaNota = String(
        plano?.barcode ?? row.barcode ?? row.supplier_code ?? row.description ?? '',
      );
      if (!productId && criadosAgora.has(identidadeNaNota)) {
        productId = criadosAgora.get(identidadeNaNota) as string;
        db.prepare(
          'UPDATE core_inbound_note_items SET product_id = ?, matched = 1 WHERE id = ?',
        ).run(productId, String(row.id));
      }

      /*
        O CUSTO DA LINHA NA UNIDADE DA NOTA: o efetivo do XML guardado (B-09) —
        com desconto, frete, seguro, outras despesas, IPI e ICMS-ST —, e o
        `vUnCom` gravado quando não há arquivo (entrada manual, nota antiga).
      */
      const custoDaLinhaNaNota = extras[indice]?.custoEfetivoUnitCents ?? Number(row.unit_cost_cents);
      /*
        A LINHA DE REMESSA SEM ÔNUS NÃO É CUSTO (B-estoque-entrada-03).

        O conserto anterior dispensou o título a pagar da bonificação, mas o
        custo continuava sendo reescrito pelo `vUnCom` dela: o produto de custo
        10,00 que recebia 12 unidades de brinde declaradas a 0,00 (ou a um valor
        de referência qualquer) passava a custar isso — e margem, markup e
        lucro mentiam a partir de mercadoria que a loja não pagou. A linha
        sem ônus põe QUANTIDADE no estoque e não toca no custo do cadastro.
      */
      const semOnusDaLinha = !ehManual && naturezaSemOnus(row.cfop) !== null;

      if (!productId) {
        const planoDaCriacao = plano ?? planoDoProdutoNovo(row, extras[indice]);
        const created = createProduct(input.companyId, {
          name: String(row.description),
          // O código da UNIDADE quando a nota fatura em caixa (B-06); o da
          // caixa NÃO entra no cadastro (PED-ent-01, ver logo abaixo).
          barcode: planoDaCriacao.barcode ?? undefined,
          unit: planoDaCriacao.unidade,
          packUnit: planoDaCriacao.packFactor ? planoDaCriacao.packUnit : undefined,
          packFactor: planoDaCriacao.packFactor ?? undefined,
          ncm: (row.ncm as string) ?? undefined,
          /*
            O CFOP do CADASTRO é o com que a LOJA VENDE — não o com que o
            fornecedor vendeu para ela.

            Herdar o do item era o comportamento antigo e produz erro fiscal
            silencioso: nota de outro estado traz 6102, o produto nasce 6102, e
            `FiscalXmlNfce` joga esse valor direto no cupom de uma venda de
            balcão. O código é válido e a SEFAZ autoriza; o erro só aparece na
            apuração do contador.

            Sem configuração, o produto nasce SEM CFOP (GAP-PRD-129). Herdar o
            do fornecedor era a única alternativa a recusar a entrada enquanto
            o grupo tributário não supria o CFOP na emissão — e agora supre: o
            CFOP interno (ou interestadual) do grupo vale para quem não tem o
            seu, e o checklist o conta. A nota entra, e nenhum produto nasce
            com a operação de saída de outra empresa.
          */
          cfop: config.defaultSaleCfop ?? undefined,
          // O custo da UNIDADE DO CADASTRO: o da caixa dividido pelo fator. A
          // linha de remessa sem ônus (B-03) não é preço pago: o produto que
          // ela cadastra nasce sem custo, e a primeira compra o define.
          costCents: semOnusDaLinha ? 0 : Math.round(custoDaLinhaNaNota / planoDaCriacao.fator),
          // Sem preço de venda definido: quem cadastra decide depois. Não
          // inventamos margem.
          priceCents: 0,
        });
        productId = String(created.id);
        createdProducts += 1;
        /*
          O CÓDIGO DA CAIXA NÃO VIRA CÓDIGO DO PRODUTO (PED-ent-01).

          Aqui o DUN-14 do `cEAN` era gravado como código adicional do produto
          que acabou de nascer em UN. Sem multiplicador em
          `core_product_barcodes`, o bipe da caixa fechada no balcão achava o
          produto e vendia UMA unidade. O recebimento seguinte não depende
          dele: o `lembrarDePara` logo abaixo liga o `cProd` deste fornecedor a
          este produto, e o casamento pelo de-para vem antes do código de barras.
        */
        /*
          O NCM DESTE PRODUTO VEIO DO XML (GAP-PRD-181), e o cadastro tem de
          dizer isso. Sem a procedência, a classificação aparecia "do cadastro"
          — como se alguém a tivesse decidido. Não é confirmação: quem confirma
          continua sendo gente, na tela fiscal.
        */
        if (row.ncm) {
          db.prepare(
            `UPDATE core_products SET fiscal_classification_source = 'xml_fornecedor'
              WHERE id = ? AND company_id = ?`,
          ).run(productId, input.companyId);
        }
        // A próxima linha do mesmo produto reaproveita este cadastro em vez de
        // tentar criar outro com o mesmo código de barras.
        criadosAgora.set(identidadeNaNota, productId);
        db.prepare('UPDATE core_inbound_note_items SET product_id = ?, matched = 1 WHERE id = ?').run(
          productId,
          String(row.id),
        );
        /*
          O PRODUTO QUE A NOTA CADASTROU ENTRA NO DE-PARA (GAP-PRD-015).

          Ele nasce com o nome da nota, e a primeira coisa que a loja faz é
          renomeá-lo ("PSTLH FREIO DIANT" vira "Pastilha de freio dianteira").
          Sem esta linha, a próxima nota do mesmo fornecedor sem GTIN não casaria
          mais pelo nome e cadastraria a segunda pastilha. `sobrescrever: false`:
          se já existe um de-para para este código, ele é decisão de gente e a
          confirmação não o atropela.
        */
        lembrarDePara(db, {
          companyId: input.companyId,
          supplierId: ehManual ? null : note.supplier_id,
          supplierCode: (row.supplier_code as string | null) ?? null,
          productId,
          origin: 'cadastro_pela_nota',
          noteId: note.id,
          userId: input.userId,
          sobrescrever: false,
        });
      }

      /**
       * O estoque entra com o que CHEGOU, não com o que o arquivo diz.
       *
       * Quando o fornecedor fatura 10 e descarrega 8, dar entrada de 10 faz o
       * saldo mentir sobre a prateleira — e a mentira só aparece na próxima
       * contagem, semanas depois, sem ninguém saber de onde veio.
       *
       * `received_quantity` nulo significa "ninguém conferiu": aí vale a nota.
       * Zero é diferente — é "conferi e não veio nada".
       */
      const conferida = row.received_quantity;
      const quantidadeEntrada =
        conferida === null || conferida === undefined ? Number(row.quantity) : Number(conferida);

      /*
        O ESTOQUE NÃO SE MOVE AQUI — só se acumula.

        Mover dentro do laço era o que fazia a segunda linha do mesmo produto
        sumir. A soma acontece agora e o movimento sai depois, uma vez por
        produto, com o total.
      */
      /*
        DA UNIDADE DA NOTA PARA A UNIDADE DO CADASTRO.

        `quantidadeEntrada` está na unidade em que o fornecedor faturou —
        e é nela que o conferente conta, porque é a caixa que ele tem na
        mão. O saldo é do cadastro. Dez caixas de doze são cento e vinte
        parafusos, e era esta multiplicação que faltava.
      */
      const fatorDaLinha = fatorPorLinha.get(String(row.id)) ?? 1;
      const quantidadeNoCadastro = quantidadeEntrada * fatorDaLinha;
      /*
        O FATOR APLICADO FICA GRAVADO NA LINHA (B-estoque-entrada-04).

        Ele era resolvido só em memória: a coluna `conversion_factor` só era
        escrita pela conferência digitada. Só que `recalcReceived` (o pedido de
        compra) e a origem de etiquetas 'compra' multiplicam por
        `COALESCE(conversion_factor, 1)` — a nota de 10 CX com qTrib 120,
        confirmada sem ninguém digitar o fator, punha 120 no estoque e 10 no
        pedido, que ficava "faltam 110" para sempre, e o comprador pedia de novo.
        `IS NULL`: o que o conferente digitou nunca é reescrito. Antes do
        `recalcReceived`, que roda depois deste laço.
      */
      db.prepare(
        'UPDATE core_inbound_note_items SET conversion_factor = ? WHERE id = ? AND conversion_factor IS NULL',
      ).run(fatorDaLinha, String(row.id));
      /*
        O FATOR QUE UMA PESSOA DECLAROU vai para a trilha, com a unidade do
        cadastro de agora (B-estoque-entrada-R02) — e SÓ ele: o que estava na
        linha antes desta confirmação foi digitado na conferência (a importação
        não escreve a coluna). O fator que a confirmação acabou de resolver
        sozinha fica na linha para o pedido (B-04), mas não é aprendido: é essa
        linha da trilha que `fatorAprendido` exige.
      */
      const declarado = row.conversion_factor;
      if (!ehManual && declarado !== null && declarado !== undefined && Number(declarado) > 0) {
        recordAudit({
          companyId: input.companyId,
          userId: input.userId,
          action: ACAO_FATOR_DECLARADO,
          entityType: 'inbound_note_item',
          entityId: String(row.id),
          detail: {
            noteId: input.noteId,
            productId,
            supplierCode: (row.supplier_code as string | null) ?? null,
            fator: Number(declarado),
            unidadeDaNota: siglaDaUnidade(row.unit),
            unidadeDoCadastro: siglaDaUnidade(unidadeDoCadastroPorLinha.get(String(row.id))),
          },
        });
      }
      /*
        E o custo vai junto, na direção contrária: `vUnCom` é o preço da
        CAIXA. Guardá-lo como custo do parafuso faria markup, margem e o
        relatório de lucro mentirem por doze — para MAIS, que é o lado que
        ninguém questiona.
      */
      const custoNoCadastro = Math.round(custoDaLinhaNaNota / fatorDaLinha);

      if (quantidadeNoCadastro > 0) {
        const antes = porProduto.get(productId);
        porProduto.set(productId, {
          quantidade: (antes?.quantidade ?? 0) + quantidadeNoCadastro,
          /*
            O CUSTO É O DA ÚLTIMA LINHA QUE ENTROU.

            Com o produto repetido em dois lotes a preços diferentes, alguma
            regra tem de vencer, e esta é a que o balcão já conhecia antes
            desta mudança: o custo do produto é o da carga mais recente. Média
            ponderada seria defensável e seria uma regra NOVA — mudar o custo
            de todo o catálogo não é assunto de uma rodada de higiene.

            A linha SEM ÔNUS (B-03) não é carga paga: ela soma quantidade e
            deixa o custo com a última linha paga — a bonificação que vem
            depois da compra, na mesma nota, não zera o custo dela.
          */
          custoCents: semOnusDaLinha ? (antes?.custoCents ?? null) : custoNoCadastro,
          linhas: (antes?.linhas ?? 0) + 1,
        });
      }

      if (quantidadeEntrada !== Number(row.quantity)) {
        divergentItems += 1;
      }
    }

    /*
      ================================================================
      A ENTRADA POR XML NÃO DECLARA LOTE — e é decisão, não esquecimento
      ================================================================

      O módulo de validade (GAP-V35, `BatchService`) põe o lote como dimensão do
      razão, e a entrada é onde ele naturalmente nasceria. Aqui ele NÃO nasce, e
      a mercadoria cai no balde "sem lote declarado". Dois motivos, e o segundo
      é o que decide:

      1. O XML QUASE NUNCA TRAZ. O grupo `rastro` (nLote/dFab/dVal) é opcional
         no layout 4.00 e obrigatório só para medicamento — a nota de hortifrúti
         e de mercearia do dia a dia não o tem. Ler dali cobriria uma minoria e
         daria a impressão de cobrir todas.

      2. O AGRUPAMENTO POR PRODUTO NÃO CABERIA. `porProduto` soma as linhas do
         mesmo produto (duas linhas de 2 motos viram quatro plaquinhas), e a
         chave de idempotência do razão é
         UNIQUE (empresa, tipo, referência, produto, tipo de movimento): existe
         UM movimento por (nota, produto). Uma nota com dois lotes do mesmo
         iogurte não teria como registrar os dois — um deles sumiria em
         silêncio, e lote perdido em silêncio é pior que lote não declarado.

      O caminho honesto é o outro: a mercadoria entra sem lote, a tela de
      Validade a NOMEIA como pendência da doca, e a alocação
      (`allocateToBatch`) reparte o saldo entre quantos lotes forem precisos —
      12 no L2409, 8 no L2410 —, cada repartição com o seu par de movimentos.
      É estritamente mais correto que ler `rastro` pela metade, e é o gesto que
      o conferente faz de qualquer jeito: abrir a caixa e ler a data impressa.
    */
    for (const [productId, entrada] of porProduto) {
      /*
        Produto serializado: as unidades NASCEM aqui, sem identidade.

        A nota diz "3 motos" muito antes de alguém ir ao pátio ler os chassis.
        Exigir a identidade na entrada travaria o recebimento e empurraria o
        conferente a inventar número — que é o defeito que se quer evitar. A
        unidade entra anônima e a tela cobra a identificação depois.

        Com o agrupamento, as unidades são criadas UMA vez com o total: duas
        linhas de 2 motos cada viram quatro plaquinhas, e não duas.
      */
      const unidades = isSerialized(input.companyId, productId)
        ? createUnits(input.companyId, productId, entrada.quantidade, {
            entryReferenceType: referenciaDaEntrada,
            entryReferenceId: input.noteId,
            costCents: entrada.custoCents,
            note: rotuloDoc,
          })
        : undefined;

      applyMovement({
        companyId: input.companyId,
        productId,
        movementType: 'in',
        quantity: entrada.quantidade,
        unitIds: unidades,
        referenceType: referenciaDaEntrada,
        referenceId: input.noteId,
        // O rótulo do razão diz a espécie: "Entrada por XML" para a NF-e,
        // "Recebimento de compra" para a entrada digitada — o histórico de
        // estoque não afirma arquivo que não existe.
        kind: ehManual ? 'PURCHASE_RECEIPT' : 'XML_RECEIPT',
        documentNumber: rotuloDoc,
        /*
          Nulo quando só entrou remessa sem ônus (B-03): o razão não afirma um
          custo que ninguém pagou. Zero não serviria — `custoMedioPorProduto`
          conta toda entrada de custo >= 0, e o brinde puxaria o custo médio
          para baixo; sem custo, a média passa por ele sem mudar.
        */
        unitCostCents: entrada.custoCents ?? undefined,
        userId: input.userId,
        note: rotuloDoc,
      });
      /*
        `movedItems` conta LINHAS DA NOTA, e não produtos — é o número que a
        tela mostra como "itens que entraram", e quem confere está olhando
        para as linhas do papel.
      */
      movedItems += entrada.linhas;

      /*
        O CUSTO SÓ MUDA SE ALGUMA COISA ENTROU — e este UPDATE morava fora do
        `if`, o que era defeito e não configuração.

        Item conferido com ZERO recebido é o caso do fornecedor que faturou e
        não mandou. Reescrever `cost_cents` ali dizia ao sistema inteiro "o
        custo desta peça agora é o desta nota" a partir de mercadoria que nunca
        chegou à prateleira. E o custo não fica parado num campo: ele é o que a
        margem do formulário calcula, o que o markup sugere e o que o relatório
        de lucro subtrai da venda. Um custo vindo de carga não recebida
        contamina os três em silêncio, e ninguém liga o preço errado de hoje ao
        recebimento cancelado de três semanas atrás.

        Como só produto com quantidade recebida entra no mapa, a regra continua
        valendo: o custo do produto é o da última carga que ENTROU.
      */
      /*
        O CUSTO ANTERIOR FICA NA TRILHA (B-estoque-entrada-14).

        O UPDATE apagava o custo de antes sem registro, e o estorno dizia, com
        razão, que "o custo anterior não está gravado em lugar nenhum": a nota
        com vUnCom 10x errado, confirmada e estornada, deixava o custo 10x para
        sempre. Agora a troca é auditada com o ANTES, o DEPOIS e a nota — e é
        daqui que o estorno o devolve.
      */
      /*
        SÓ LINHA PAGA MEXE NO CUSTO (B-estoque-entrada-03): o produto que só
        recebeu bonificação, amostra, demonstração ou consignação nesta nota
        fica com o custo que tinha — e sem trilha de troca, porque não houve.
      */
      if (entrada.custoCents === null) continue;
      const custoAnterior = (
        db.prepare('SELECT cost_cents FROM core_products WHERE id = ? AND company_id = ?').get(
          productId,
          input.companyId,
        ) as { cost_cents: number | null } | undefined
      )?.cost_cents;
      db.prepare('UPDATE core_products SET cost_cents = ? WHERE id = ? AND company_id = ?').run(
        entrada.custoCents,
        productId,
        input.companyId,
      );
      if (custoAnterior !== undefined && Number(custoAnterior ?? 0) !== entrada.custoCents) {
        recordAudit({
          companyId: input.companyId,
          userId: input.userId,
          action: 'product.cost_changed',
          entityType: 'product',
          entityId: productId,
          detail: {
            antes: Number(custoAnterior ?? 0),
            depois: entrada.custoCents,
            noteId: input.noteId,
            origem: rotuloDoc,
          },
        });
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      // A constante, e não o texto: quem escreve e quem lê usam a MESMA
      // fonte, então um erro de digitação vira erro de compilação em vez de
      // relatório vazio meses depois.
      'UPDATE core_inbound_notes SET status = ?, received_at = ?, received_by = ? WHERE id = ?',
    ).run(NOTA_RECEBIDA, now, input.userId, input.noteId);

    /*
      O PEDIDO AMARRADO ANDA JUNTO.

      A ordem natural da doca é amarrar a nota NA CHEGADA (a rota de amarrar
      aceita nota em conferência, e é para aceitar), conferir e confirmar. Só
      que a amarração recalcula na hora do clique — e uma nota ainda não
      confirmada conta zero. Sem este passo, quem amarrou antes de confirmar
      ficava com estoque e financeiro andando e o pedido parado em 'enviado'
      com received_quantity zero PARA SEMPRE: o comprador achava que nada veio
      e pedia de novo.

      Depois do UPDATE de status logo acima, porque o recálculo só enxerga
      nota 'recebida' — e na MESMA transação: se o financeiro abaixo falhar, o
      rollback desfaz o pedido junto com a nota.
    */
    if (note.purchase_order_id) {
      recalcReceived(input.companyId, note.purchase_order_id);
    }

    /**
     * A nota entra no FINANCEIRO junto com o estoque.
     *
     * Antes disto a mercadoria chegava na prateleira e a divida com o
     * fornecedor nao existia em lugar nenhum: contas a pagar ficava vazio, o
     * fluxo de caixa nao previa a saida, e a conta so aparecia quando o
     * fornecedor cobrava.
     *
     * O valor e o da NOTA, mesmo quando chegou menos: e o que esta faturado, e
     * quem negocia abatimento e gente, nao o sistema. A divergencia fica
     * registrada para essa conversa acontecer.
     *
     * A UNIQUE (origin_type, origin_id, direction) de core_finance_entries e o
     * que impede a segunda confirmacao de criar uma segunda divida.
     */
    const notaCompleta = db
      .prepare('SELECT total_cents, supplier_id, number FROM core_inbound_notes WHERE id = ?')
      .get(input.noteId) as { total_cents: number; supplier_id: string | null; number: string | null };

    /*
      O PRAZO DO FORNECEDOR FINALMENTE TEM LEITOR.

      `core_suppliers.payment_term_days` existia desde a rodada de compras: tem
      coluna com comentário dizendo "alimenta o vencimento da dívida", é gravado
      pelo cadastro e a tela do fornecedor mostra "30 dias" para quem abre. Não
      tinha UM leitor no servidor. O vencimento aqui era `now.slice(0, 10)` —
      hoje —, então TODA compra nascia vencida no dia em que a mercadoria
      chegava, e o painel de contas a pagar abria com atraso que não existia. O
      efeito é o mesmo de qualquer alarme que toca sempre: o dono para de olhar,
      e o atraso de verdade passa junto.

      Campo com escritor e sem leitor é a dívida que este projeto já pagou duas
      vezes. Nenhuma coluna nova e nenhuma tela nova entram aqui: o dado já é
      digitado, já é exibido, e só faltava alguém usá-lo.

      PRAZO ZERO É "À VISTA", e é o DEFAULT da coluna: vence hoje, exatamente
      como antes. Quem nunca preencheu o cadastro não é surpreendido por
      vencimento novo.

      Fornecedor nulo (nota sem emitente casado) cai no mesmo zero — sem
      cadastro não há prazo combinado, e inventar um adiaria uma cobrança real.

      O QUE NÃO É REESCRITO: nota JÁ CONFIRMADA continua com o vencimento que
      recebeu. O dono vai perguntar por que o atraso antigo continua no painel,
      e a resposta é que aquilo é um lançamento financeiro que pode já ter sido
      pago, renegociado ou conciliado. Reescrever o passado para embelezar o
      painel é mexer no que o financeiro já usou. O prazo vale das próximas
      entradas em diante.
    */
    const prazoFornecedor = notaCompleta.supplier_id
      ? ((
          db
            .prepare('SELECT payment_term_days FROM core_suppliers WHERE id = ? AND company_id = ?')
            .get(notaCompleta.supplier_id, input.companyId) as
            | { payment_term_days: number | null }
            | undefined
        )?.payment_term_days ?? 0)
      : 0;
    const vencimentoDaCompra = diaMaisNaCompra(now, Math.max(0, Number(prazoFornecedor) || 0));

    /*
      GAP-V21, a investigação registrada onde ela pertence: o banco
      operacional tem UMA nota real (NF 9991) em 'recebida' SEM lançamento —
      ela foi confirmada ANTES de este INSERT existir, e a decisão (acima, em
      "O QUE NÃO É REESCRITO") é não fabricar dívida retroativa: aquele valor
      pode já ter sido pago por fora, e cobrá-lo de novo seria pior que a
      lacuna. Desde esta rodada, o buraco não reabre POR CONSTRUÇÃO: estoque,
      status e dívida andam na MESMA transação, e a varredura de
      nfe-conferencia-financeiro ("recebida sem dívida não volta a nascer")
      fica vermelha se qualquer caminho novo pular esta escrita. A exceção
      declarada é a nota de total ZERO (bonificação/brinde) — dívida de zero
      centavos não é dívida. A NF 9991 em si é conferência HUMANA: o dono
      verifica se foi paga e, se preciso, lança a conta manualmente.

      A NOTA DE REMESSA SEM ÔNUS (B-estoque-entrada-03) é a segunda exceção, e
      ela NÃO passa em silêncio: quando TODOS os itens têm CFOP de bonificação,
      amostra, demonstração ou consignação, a mercadoria entra e a dívida não
      nasce — e a dispensa é GRAVADA na mesma transação (as colunas
      `finance_waiver_*` que o gesto "esta nota não gera conta" já usa), com o
      CFOP como motivo. A varredura e a tela de nota sem conta a entendem como
      decidida, e o dono ainda pode lançar a conta se discordar. A nota MISTA
      (compra + brinde) cria o título pelo total, como sempre, e AVISA.
    */
    const naturezas = ehManual ? [] : rows.map((r) => naturezaSemOnus(r.cfop));
    const todasSemOnus = naturezas.length > 0 && naturezas.every((n) => n !== null);
    const algumasSemOnus = naturezas.filter((n) => n !== null).length;
    let semContaAPagar: string | null = null;
    let aviso: string | null = null;
    if (notaCompleta.total_cents > 0 && todasSemOnus) {
      const cfops = [...new Set(rows.map((r) => String(r.cfop ?? '').replace(/\D/g, '')))];
      semContaAPagar = `Sem conta a pagar: CFOP ${cfops
        .map((c) => `${c} (${naturezaSemOnus(c)})`)
        .join(', ')} — a mercadoria não foi vendida à loja.`;
      db.prepare(
        `UPDATE core_inbound_notes
            SET finance_waiver_reason = ?, finance_waiver_by = ?, finance_waiver_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(semContaAPagar, input.userId, now, input.noteId, input.companyId);
    } else if (notaCompleta.total_cents > 0 && algumasSemOnus > 0) {
      aviso = `Nota mista: ${algumasSemOnus} item(ns) com CFOP de remessa sem ônus (bonificação, amostra, `
        + 'demonstração ou consignação) entraram na conta a pagar pelo total da nota. Se parte do valor não '
        + 'é devida, ajuste o título no financeiro.';
    }
    if (notaCompleta.total_cents > 0 && !todasSemOnus) {
      db.prepare(
        // O alvo do ON CONFLICT tem de casar com a UNIQUE INTEIRA. Ela ganhou
        // `installment_number` quando a tabela abriu para o crediário; deixar
        // o alvo de três colunas faria o SQLite recusar a instrução com
        // "does not match any PRIMARY KEY or UNIQUE constraint" — e a entrada
        // de nota pararia de importar.
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, due_date, settled_cents,
            supplier_id, description, origin_type, origin_id,
            category_id, competence_date, created_at)
         VALUES (?, ?, 'out', ?, 'open', ?, 0, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (origin_type, origin_id, direction, installment_number) DO NOTHING`,
      ).run(
        randomUUID(),
        input.companyId,
        notaCompleta.total_cents,
        vencimentoDaCompra,
        notaCompleta.supplier_id,
        // A descrição diz a espécie do papel: quem lê o contas a pagar sabe
        // se há XML por trás ("NF-e 1024") ou digitação ("Entrada manual…").
        ehManual
          ? `Entrada manual ${notaCompleta.number ?? note.id.slice(0, 8)}`
          : `NF-e ${notaCompleta.number ?? note.access_key.slice(25, 34)}`,
        // A ORIGEM é própria por espécie ('entrada_manual' × 'nfe_entrada'):
        // é o que impede a compra digitada de se apresentar como NF-e em
        // relatório, conciliação e estorno.
        referenciaDaEntrada,
        input.noteId,
        systemCategoryId(input.companyId, 'fornecedor'),
        // Competência no dia da LOJA em que a nota entrou — `now.slice(0, 10)`
        // seria o dia de Greenwich, e a nota recebida às 22h da virada do mês
        // pesaria no DRE do mês seguinte.
        diaDaLoja(now),
        now,
      );
    }

    /*
      SEGUNDA PASSADA DA SUGESTÃO FISCAL — a que fecha o ciclo.

      A importação já registrou o que os itens JÁ CASADOS declaravam. Faltavam
      dois grupos, e os dois só existem agora: os itens vinculados à mão entre
      a conferência e a confirmação, e os produtos que ESTA confirmação acabou
      de criar — que nascem com o NCM do arquivo do fornecedor no cadastro e
      SEM confirmação humana nenhuma, porque arquivo de terceiro não é decisão
      da casa.

      Chamar duas vezes não infla contagem: a chave da sugestão inclui a linha
      da nota, e o INSERT OR IGNORE da segunda passada não faz nada sobre o que
      a primeira já gravou.
    */
    recordSuggestionsFromNote(input.companyId, input.noteId);

    return {
      noteId: input.noteId,
      status: NOTA_RECEBIDA,
      createdProducts,
      movedItems,
      divergentItems,
      alreadyReceived: false,
      semContaAPagar,
      aviso,
    };
  });
}

/**
 * O FATOR DAS NOTAS JÁ RECEBIDAS ANTES DA CORREÇÃO — B-estoque-entrada-04.
 *
 * A nota confirmada antes de `confirmNfe` gravar o fator ficou com
 * `conversion_factor` nulo, e o pedido amarrado a ela conta caixas como
 * unidades ("faltam 110" para sempre). Esta releitura é idempotente: grava,
 * SÓ onde está nulo, o fator pela MESMA régua da confirmação, e recalcula os
 * pedidos amarrados. A linha em que a régua não chega a um número (unidades
 * diferentes, sem par tributável nem embalagem) fica como está — inventar o
 * fator seria o defeito ao contrário.
 */
export function completarFatoresDasNotasRecebidas(companyId: string): {
  linhasCompletadas: number;
  pedidosRecalculados: number;
} {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const linhas = db
      .prepare(
        `SELECT i.*, n.purchase_order_id, n.supplier_id AS nota_fornecedor,
                p.unit AS product_unit, p.pack_factor, p.pack_unit
           FROM core_inbound_note_items i
           JOIN core_inbound_notes n ON n.id = i.note_id AND n.company_id = i.company_id
           JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
          WHERE i.company_id = ? AND n.status = ? AND i.conversion_factor IS NULL`,
      )
      .all(companyId, NOTA_RECEBIDA) as unknown as Record<string, unknown>[];
    let linhasCompletadas = 0;
    const pedidos = new Set<string>();
    for (const linha of linhas) {
      const fator = fatorDeConversao(
        linha as Parameters<typeof fatorDeConversao>[0],
        linha.product_unit,
        { fator: linha.pack_factor, unidade: linha.pack_unit },
      );
      if (fator === null) continue;
      db.prepare(
        'UPDATE core_inbound_note_items SET conversion_factor = ? WHERE id = ? AND conversion_factor IS NULL',
      ).run(fator, String(linha.id));
      linhasCompletadas += 1;
      if (linha.purchase_order_id) pedidos.add(String(linha.purchase_order_id));
    }
    for (const pedido of pedidos) recalcReceived(companyId, pedido);
    return { linhasCompletadas, pedidosRecalculados: pedidos.size };
  });
}

/**
 * A lista da tela de Entrada de Notas.
 *
 * ## Por que as colunas passaram a ser nomeadas uma a uma
 *
 * Isto era `SELECT n.*`, e `n.*` estava prestes a virar um defeito de
 * desempenho difícil de rastrear: `core_inbound_notes` ganhou nesta rodada a
 * coluna `xml_original`, que guarda o arquivo INTEIRO da nota. Um XML de NF-e
 * com trinta itens passa de 100 KB; a lista traz 200 notas. A tela puxaria
 * dezenas de megabytes a cada carregamento para exibir uma tabela de sete
 * colunas — e ninguém veria a causa, porque `n.*` não menciona o XML em lugar
 * nenhum. A consulta ficaria lenta "sem motivo".
 *
 * `n.*` também é frágil por natureza: ele promete à tela toda coluna futura da
 * tabela, sem que ninguém decida isso. A lista explícita transforma "o que a
 * tela recebe" numa decisão escrita aqui.
 *
 * ## `tem_xml` em vez do arquivo
 *
 * A tela precisa saber se o botão de baixar existe para aquela linha — não
 * precisa do conteúdo. Um booleano responde isso em bytes, e o arquivo só
 * viaja quando alguém clica, por `GET /purchases/notes/:id/xml`.
 *
 * `issued_at` entra na lista pela mesma razão: a nota antiga não tem arquivo e
 * nunca terá, e a tela conta isso com a data DA PRÓPRIA NOTA. Uma frase com
 * data chumbada no código envelheceria em silêncio.
 *
 * ## `received_by_name` e `received_at`
 *
 * A coluna `received_by` era escrita na conferência e nenhuma tela a nomeava.
 * "Quem conferiu esta nota" é a pergunta de quando a doca recebeu 4 e a nota
 * dizia 10 — o nome sai do JOIN com `core_users`, porque um id não responde
 * a ninguém.
 */
export function listNotes(
  companyId: string,
  options: FiltroDasNotas & { limit?: number; offset?: number } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const filtro = filtroDasNotas(companyId, options);
  return getConnection()
    .prepare(
      `SELECT n.id, n.access_key, n.number, n.series, n.issued_at, n.total_cents,
              n.status, n.created_at, n.carrier_name_xml, n.freight_mode,
              n.volumes_qty, n.gross_weight_grams, n.vehicle_plate,
              -- A espécie e o estorno viajam para a tela: é por eles que a
              -- linha se rotula "entrada manual (sem nota fiscal)" ou
              -- "estornada" em vez de fingir NF-e viva (GAP-V17/V20). O
              -- MOTIVO e o AUTOR do estorno vão juntos — coluna gravada sem
              -- leitor é a dívida que este projeto já pagou; quem olha a
              -- linha estornada precisa saber quem desfez e por quê, sem
              -- abrir a Auditoria.
              n.doc_type, n.reversed_at, n.reversal_reason,
              ur.display_name AS reversed_by_name,
              -- PARA QUEM a nota foi emitida (B-estoque-entrada-02): a
              -- conferência mostra o destinatário, e é o alerta visível da
              -- empresa que ainda não configurou o CNPJ — a trava de
              -- destinatário só compara quando há com o que comparar.
              n.recipient_document, n.recipient_name,
              -- A nota que entrou sem conta a pagar, e por quê (B-03).
              n.finance_waiver_reason,
              CASE WHEN n.xml_original IS NULL OR n.xml_original = '' THEN 0 ELSE 1 END
                AS tem_xml,
              s.name AS supplier_name,
              n.received_at,
              u.display_name AS received_by_name
         FROM core_inbound_notes n
         LEFT JOIN core_suppliers s ON s.id = n.supplier_id
         LEFT JOIN core_users u ON u.id = n.received_by
         LEFT JOIN core_users ur ON ur.id = n.reversed_by
        WHERE ${filtro.where}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
    )
    .all(
      ...(filtro.params as never[]),
      limitarPagina(options.limit, 200),
      limitarDeslocamento(options.offset),
    ) as unknown as Record<string, unknown>[];
}

/**
 * O recorte da lista de notas — GAP-PRD-164.
 *
 * `id` é a nota do LINK: o contas a pagar navega até `?nota=<id>`, e a nota
 * antiga, fora da primeira página, não estava na lista que a tela carregou —
 * a ficha abria sem saber a espécie, o status nem o fornecedor dela. Com o
 * filtro, a tela pergunta pela nota do link pela MESMA consulta da lista, com
 * as mesmas colunas.
 *
 * `search` acha a nota antiga sem folhear página por página: número, chave de
 * acesso ou fornecedor.
 */
export interface FiltroDasNotas {
  id?: string;
  search?: string;
}

function filtroDasNotas(
  companyId: string,
  options: FiltroDasNotas,
): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let where = 'n.company_id = ?';
  if (options.id) {
    where += ' AND n.id = ?';
    params.push(options.id);
  }
  const termo = options.search?.trim();
  if (termo) {
    where += ` AND (n.number = ? OR n.access_key LIKE ?
                 OR n.supplier_id IN (SELECT s2.id FROM core_suppliers s2
                                       WHERE s2.company_id = n.company_id
                                         AND (s2.name LIKE ? OR s2.trade_name LIKE ?)))`;
    params.push(termo, `%${termo}%`, `%${termo}%`, `%${termo}%`);
  }
  return { where, params };
}

/** Quantas notas o recorte de `listNotes` tem — o `total` da página. */
export function countNotes(companyId: string, options: FiltroDasNotas = {}): number {
  ensureCoreSchema();
  const filtro = filtroDasNotas(companyId, options);
  const linha = getConnection()
    .prepare(`SELECT COUNT(*) AS total FROM core_inbound_notes n WHERE ${filtro.where}`)
    .get(...(filtro.params as never[])) as { total: number };
  return Number(linha.total);
}

/**
 * O arquivo de UMA nota, para download.
 *
 * Devolve `null` quando a nota não é desta empresa — mesma resposta de quando
 * ela não existe, de propósito. Distinguir os dois casos contaria a quem tem o
 * id que a nota existe em outra operação.
 *
 * `xmlOriginal` nulo é resposta legítima e comum: toda nota importada antes da
 * rodada 27 está assim. Quem chama decide o que dizer — a rota devolve 404 com
 * código próprio, para a tela não confundir "nota inexistente" com "nota sem
 * arquivo guardado".
 */
export function getNoteXml(
  companyId: string,
  noteId: string,
): {
  accessKey: string;
  number: string | null;
  xmlOriginal: string | null;
  /**
   * A ESPÉCIE do documento (GAP-PRD-204): 'manual' nunca teve arquivo, e a
   * rota precisa dizer isso em vez da frase da nota antiga que o perdeu.
   */
  docType: string;
} | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT access_key, number, xml_original, doc_type
         FROM core_inbound_notes WHERE id = ? AND company_id = ?`,
    )
    .get(noteId, companyId) as Record<string, string | null> | undefined;
  if (!row) return null;
  return {
    accessKey: String(row.access_key),
    number: row.number ?? null,
    xmlOriginal: row.xml_original ? String(row.xml_original) : null,
    docType: String(row.doc_type ?? 'nfe'),
  };
}

// ---------------------------------------------------------------------------
// Estorno da entrada confirmada (GAP-V20)
// ---------------------------------------------------------------------------

export interface EstornoResult {
  noteId: string;
  status: string;
  /** Quantos movimentos de saída o estorno gravou no razão. */
  reversedMovements: number;
  /** A dívida aberta foi cancelada nesta chamada? */
  financeCancelled: boolean;
  alreadyReversed: boolean;
  /** Quantos produtos voltaram ao custo de antes desta nota (B-14). */
  custosRestaurados?: number;
}

/**
 * Desfaz uma entrada CONFIRMADA — o espelho do confirmNfe, numa transação só.
 *
 * O caso real: o XML confirmado por engano (a nota do irmão da outra empresa
 * do grupo, o arquivo duplicado com chave diferente). Antes disto, o conserto
 * eram dois gestos desconectados — ajuste manual de estoque + cancelamento
 * avulso do lançamento — sem vínculo entre si nem com a nota, e o histórico
 * do fornecedor continuava contando a compra.
 *
 * ## O que o estorno faz, na ordem — e por quê nessa ordem
 *
 *   1. RECUSA cedo o que não pode andar: dívida já BAIXADA (dinheiro pago não
 *      some por decreto — estorne a baixa no financeiro primeiro) e estoque
 *      insuficiente (mercadoria da nota que JÁ SAIU não volta por decreto —
 *      o caminho aí é o ajuste com motivo, que tem trilha própria). Nota
 *      inteira ou nota nenhuma: recusar no meio deixaria meio estorno.
 *   2. REVERTE cada movimento de entrada com movimento CONTRÁRIO no razão —
 *      NUNCA apaga: a entrada aconteceu e o estorno também; o histórico conta
 *      os dois. Produto serializado devolve as PRÓPRIAS unidades que a nota
 *      criou (status 'baixada' — elas nunca foram vendidas).
 *   3. CANCELA a dívida aberta pelo carimbo `cancelled_at` — o mesmo desenho
 *      da venda cancelada: o fato é cancelado, não apagado.
 *   4. Carimba a nota 'estornada' com quem/quando/por quê, e REPROJETA o
 *      pedido amarrado — recalcReceived só conta nota 'recebida', então o
 *      pedido volta ao retrato sem esta nota (inclusive de 'recebido' para
 *      trás).
 *
 * ## Idempotência
 *
 * Estornar o já estornado devolve `alreadyReversed` sem tocar em nada — e,
 * abaixo dela, o `applyMovement` deduplica por referência: mesmo que duas
 * chamadas atravessem juntas, o razão não desce duas vezes.
 *
 * ## O custo do produto VOLTA — quando ninguém mexeu nele depois (B-14)
 *
 * Era a exceção declarada: "o custo anterior não está gravado em lugar
 * nenhum". A nota com custo 10x errado, confirmada e estornada, deixava o
 * custo 10x — margem, sugestão de preço e valor do estoque errados até alguém
 * perceber e corrigir sem saber o valor antigo. A confirmação agora audita a
 * troca (`product.cost_changed`, com antes/depois/nota), e o estorno devolve o
 * ANTES — só quando o custo ATUAL ainda é o que esta nota gravou. Se outra
 * nota ou alguém na ficha já mudou o custo depois, aquele é o custo real mais
 * novo e fica.
 */
export function estornarNota(input: {
  companyId: string;
  noteId: string;
  userId: string;
  reason: string;
}): EstornoResult {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const note = db
      .prepare('SELECT * FROM core_inbound_notes WHERE id = ? AND company_id = ?')
      .get(input.noteId, input.companyId) as
      | {
          id: string;
          status: string;
          number: string | null;
          access_key: string;
          doc_type: string | null;
          purchase_order_id: string | null;
        }
      | undefined;
    if (!note) throw new ApiError('CORE_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);

    if (note.status === NOTA_ESTORNADA) {
      return {
        noteId: note.id,
        status: note.status,
        reversedMovements: 0,
        financeCancelled: false,
        alreadyReversed: true,
      };
    }
    if (note.status !== NOTA_RECEBIDA) {
      throw new ApiError(
        'CORE_NOTE_NOT_RECEIVED',
        'Só entrada confirmada tem o que estornar — esta nota ainda está em conferência.',
        409,
      );
    }

    /*
      NOTA COM DEVOLUÇÃO AO FORNECEDOR NÃO SE ESTORNA (GAP-PRD-089).

      O estorno lê do razão o que a nota PÔS no estoque e tira tudo de novo —
      inclusive a parte que já saiu pela devolução. A mercadoria sairia duas
      vezes, e o crédito/abatimento da devolução ficaria apontando para uma
      compra que o estorno diz nunca ter existido.
    */
    const temDevolucao = db
      .prepare('SELECT 1 FROM core_supplier_returns WHERE company_id = ? AND note_id = ? LIMIT 1')
      .get(input.companyId, input.noteId);
    if (temDevolucao) {
      throw new ApiError(
        'CORE_NOTE_HAS_SUPPLIER_RETURN',
        'Esta nota já tem devolução ao fornecedor registrada: o estorno tiraria do estoque, de novo, '
          + 'a parte que já voltou. Para desfazer o resto da compra, registre outra devolução.',
        409,
      );
    }

    const motivo = String(input.reason ?? '').trim();
    if (motivo.length < 3) {
      throw new ApiError(
        'CORE_ESTORNO_INVALID',
        'Informe o motivo do estorno — é ele que explica o retrato desfeito.',
        400,
      );
    }

    const ehManual = String(note.doc_type ?? 'nfe') === 'manual';
    const referenciaDaEntrada = ehManual ? 'entrada_manual' : 'nfe_entrada';
    const rotuloDoc = ehManual
      ? `Entrada manual ${note.number ?? note.id.slice(0, 8)}`
      : `NF-e ${note.access_key.slice(25, 34)}`;

    /*
      A DÍVIDA PRIMEIRO, porque é a recusa mais barata: se já houve baixa, o
      estorno inteiro morre aqui, antes de qualquer conta de estoque. Baixa
      parcial também recusa — parte do dinheiro saiu, e decidir o destino
      dela é do financeiro, não deste botão.
    */
    const contas = db
      .prepare(
        `SELECT id, settled_cents, cancelled_at FROM core_finance_entries
          WHERE company_id = ? AND origin_type IN ('nfe_entrada', 'entrada_manual')
            AND origin_id = ? AND direction = 'out'`,
      )
      .all(input.companyId, input.noteId) as unknown as {
      id: string;
      settled_cents: number;
      cancelled_at: string | null;
    }[];
    if (contas.some((c) => !c.cancelled_at && Number(c.settled_cents) > 0)) {
      throw new ApiError(
        'CORE_NOTE_ENTRY_SETTLED',
        'A dívida desta nota já tem baixa registrada. Estorne a baixa no financeiro primeiro — '
          + 'dinheiro pago não some por decreto.',
        409,
      );
    }

    /*
      O QUE ENTROU é lido do RAZÃO, não recalculado dos itens: é o razão que
      diz o que de fato se moveu (conferência, fator de conversão e
      agrupamento por produto já aplicados na confirmação). Reverter qualquer
      outra conta poderia divergir do que entrou.
    */
    const entradas = db
      .prepare(
        `SELECT product_id, quantity, unit_cost_cents, location_id
           FROM core_stock_movements
          WHERE company_id = ? AND reference_type = ? AND reference_id = ?
            AND movement_type = 'in'`,
      )
      .all(input.companyId, referenciaDaEntrada, input.noteId) as unknown as {
      product_id: string;
      quantity: number;
      unit_cost_cents: number | null;
      location_id: string | null;
    }[];

    /*
      NOTA INTEIRA OU NOTA NENHUMA: todos os saldos conferidos ANTES da
      primeira escrita, e a recusa NOMEIA o que falta — quem está com o
      problema na mão resolve tudo de uma vez, como na confirmação.
    */
    const semSaldo: string[] = [];
    const unidadesPorProduto = new Map<string, string[]>();
    for (const mov of entradas) {
      const qtd = Math.abs(Number(mov.quantity));
      if (qtd === 0) continue;
      const saldo = getBalance(input.companyId, mov.product_id);
      const nome = (db
        .prepare('SELECT name FROM core_products WHERE id = ?')
        .get(mov.product_id) as { name: string } | undefined)?.name ?? mov.product_id;
      if (saldo < qtd) {
        semSaldo.push(`"${nome}": a nota pôs ${qtd} e o saldo atual é ${saldo}`);
        continue;
      }
      /*
        O RESERVADO TAMBÉM CONTA (B-estoque-entrada-21).

        O pré-cheque olhava só o saldo físico: com 10 da nota e 6 reservados
        numa pré-venda, o estorno passava (10 ≥ 10) e deixava quantity 0 com
        reserved 6 — o banco só guarda `reserved >= 0`, não `reserved <=
        quantity`. A conversão da pré-venda falhava depois por "estoque
        insuficiente", sem ligação visível com o estorno. A recusa agora vem
        antes de qualquer escrita e diz QUEM segura a mercadoria.
      */
      const reservado = Number(
        (db
          .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
          .get(input.companyId, mov.product_id) as { reserved: number } | undefined)?.reserved ?? 0,
      );
      if (saldo - reservado < qtd) {
        const quem = (db
          .prepare(
            `SELECT reference_type, MAX(document_number) AS documento, SUM(reserved_delta) AS liquido
               FROM core_stock_movements
              WHERE company_id = ? AND product_id = ? AND movement_type IN ('reserve', 'release')
              GROUP BY reference_type, reference_id
             HAVING SUM(reserved_delta) > 0
              ORDER BY MIN(created_at)
              LIMIT 3`,
          )
          .all(input.companyId, mov.product_id) as unknown as {
          reference_type: string;
          documento: string | null;
          liquido: number;
        }[])
          .map((r) => `${r.documento ?? r.reference_type}: ${Number(r.liquido)}`)
          .join(', ');
        semSaldo.push(
          `"${nome}": a nota pôs ${qtd}, o saldo é ${saldo} e ${reservado} está(ão) reservado(s)`
            + `${quem ? ` (${quem})` : ''} — solte ou fature as reservas antes de estornar`,
        );
        continue;
      }
      if (isSerialized(input.companyId, mov.product_id)) {
        // As PRÓPRIAS unidades que esta entrada criou, ainda em estoque.
        const unidades = db
          .prepare(
            `SELECT id FROM core_product_units
              WHERE company_id = ? AND product_id = ? AND status = 'in_stock'
                AND entry_reference_type = ? AND entry_reference_id = ?
              ORDER BY created_at LIMIT ?`,
          )
          .all(input.companyId, mov.product_id, referenciaDaEntrada, input.noteId, qtd)
          .map((u) => String((u as { id: string }).id));
        if (unidades.length < qtd) {
          semSaldo.push(
            `"${nome}": das ${qtd} unidade(s) desta nota, só ${unidades.length} ainda estão em estoque`,
          );
          continue;
        }
        unidadesPorProduto.set(mov.product_id, unidades);
      }
    }
    if (semSaldo.length > 0) {
      throw new ApiError(
        'CORE_ESTORNO_INSUFFICIENT_STOCK',
        'Mercadoria desta nota já saiu do estoque e o estorno não a traz de volta por decreto: '
          + semSaldo.join('; ')
          + '. Para a parte que saiu, o caminho é o ajuste de inventário com motivo.',
        409,
        { itens: semSaldo },
      );
    }

    const now = new Date().toISOString();
    let reversedMovements = 0;
    for (const mov of entradas) {
      const qtd = Math.abs(Number(mov.quantity));
      if (qtd === 0) continue;
      applyMovement({
        companyId: input.companyId,
        productId: mov.product_id,
        movementType: 'out',
        quantity: qtd,
        unitIds: unidadesPorProduto.get(mov.product_id),
        // Referência PRÓPRIA ('estorno_entrada'): é ela que deduplica o
        // segundo clique e que deixa o razão dizer "isto desfez aquilo".
        referenceType: 'estorno_entrada',
        referenceId: input.noteId,
        /*
          KIND PRÓPRIO, e antes ele era emprestado. A perna saía como
          MANUAL_EXIT — "Saída manual" na tela —, que é outro fato: saída
          manual é mercadoria que deixou a prateleira (perda, consumo interno,
          brinde), e quem lê isso repõe. Aqui a mercadoria NUNCA entrou, porque
          a entrada que a trouxe foi desfeita. No filtro por tipo era pior
          ainda: estorno e perda no mesmo balde, sem como separá-los fora do
          banco.
        */
        kind: 'ENTRY_REVERSAL',
        documentNumber: `Estorno ${rotuloDoc}`,
        unitCostCents: mov.unit_cost_cents ?? undefined,
        // A saída volta do MESMO local em que a entrada caiu — nulo cai no
        // padrão, exatamente como caiu na entrada.
        locationId: mov.location_id ?? undefined,
        userId: input.userId,
        reason: motivo,
        note: `Estorno da entrada — ${rotuloDoc}`,
      });
      reversedMovements += 1;
    }

    // O carimbo, nunca o DELETE — o desenho da venda cancelada.
    let financeCancelled = false;
    for (const conta of contas) {
      if (conta.cancelled_at) continue;
      db.prepare(
        `UPDATE core_finance_entries
            SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?)
          WHERE id = ?`,
      ).run(now, conta.id);
      financeCancelled = true;
    }

    db.prepare(
      `UPDATE core_inbound_notes
          SET status = ?, reversed_at = ?, reversed_by = ?, reversal_reason = ?
        WHERE id = ?`,
    ).run(NOTA_ESTORNADA, now, input.userId, motivo, input.noteId);

    // O pedido amarrado volta ao retrato SEM esta nota — o recálculo só
    // enxerga 'recebida', e desde o GAP-V20 ele também rebaixa 'recebido'.
    if (note.purchase_order_id) {
      recalcReceived(input.companyId, note.purchase_order_id);
    }

    /*
      A NOTA ESTORNADA PARA DE SUSTENTAR A CLASSIFICAÇÃO.

      DELETE, e não carimbo — e a exceção à regra da casa ("carimbe, não
      apague") é justificada pela natureza da linha: a sugestão não é um FATO
      DO NEGÓCIO com histórico próprio, como um lançamento financeiro ou um
      movimento de estoque. Ela é uma OPINIÃO derivada de um documento, e o
      documento foi retirado — a nota do irmão da outra empresa, o arquivo
      duplicado com chave diferente. Manter a opinião de um papel que não vale
      mais é o que inflaria a confiança com apoio que não existe: "dois
      fornecedores concordam" contando uma nota estornada é confiança
      fabricada, e é exatamente ela que autoriza a confirmação em lote.

      O que a nota JÁ classificou não é desfeito: valor confirmado no cadastro
      tem autor e data, e desfazê-lo aqui seria revogar decisão humana por
      causa de um estorno de estoque. O que some é o APOIO, não a decisão.
    */
    db.prepare(
      'DELETE FROM core_product_fiscal_suggestions WHERE company_id = ? AND note_id = ?',
    ).run(input.companyId, input.noteId);

    /*
      O CUSTO DE ANTES DESTA NOTA VOLTA (B-estoque-entrada-14) — produto a
      produto, e só onde o custo atual ainda é o que ELA gravou.
    */
    let custosRestaurados = 0;
    const produtosDaNota = [...new Set(entradas.map((m) => m.product_id))];
    for (const productId of produtosDaNota) {
      const troca = db
        .prepare(
          `SELECT detail FROM core_audit_log
            WHERE company_id = ? AND action = 'product.cost_changed' AND entity_type = 'product'
              AND entity_id = ? AND json_extract(detail, '$.noteId') = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(input.companyId, productId, input.noteId) as { detail: string | null } | undefined;
      if (!troca?.detail) continue;
      const { antes, depois } = JSON.parse(troca.detail) as { antes: number; depois: number };
      const atual = (db
        .prepare('SELECT cost_cents FROM core_products WHERE id = ? AND company_id = ?')
        .get(productId, input.companyId) as { cost_cents: number | null } | undefined)?.cost_cents;
      if (Number(atual ?? 0) !== Number(depois)) continue;
      db.prepare('UPDATE core_products SET cost_cents = ? WHERE id = ? AND company_id = ?').run(
        Number(antes),
        productId,
        input.companyId,
      );
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action: 'product.cost_restored',
        entityType: 'product',
        entityId: productId,
        detail: { antes: Number(depois), depois: Number(antes), noteId: input.noteId, motivo: 'estorno da entrada' },
      });
      custosRestaurados += 1;
    }

    return {
      noteId: input.noteId,
      status: NOTA_ESTORNADA,
      reversedMovements,
      financeCancelled,
      alreadyReversed: false,
      custosRestaurados,
    };
  });
}
