/**
 * Gerador do XML da NFC-e (modelo 65).
 *
 * A NFC-e é CONSEQUÊNCIA de uma venda que já existe. Este módulo lê
 * `core_sales` e monta o documento fiscal correspondente — não cria venda, não
 * baixa estoque, não gera receita. Esses fatos já aconteceram no fechamento do
 * caixa; repeti-los aqui produziria estoque negativo e faturamento em dobro.
 *
 * O QUE ELE RECUSA A FAZER
 *
 * Não inventa tributação. Sem NCM, CFOP ou origem no produto, o item não entra
 * na nota e a emissão é bloqueada ANTES de numerar. A alternativa — escolher um
 * valor "provável" — produz nota autorizada com imposto errado, que é pior que
 * nota recusada: a recusa aparece na hora, o imposto errado aparece na
 * fiscalização, com multa e retroativo.
 *
 * XML BEM FORMADO NÃO É XML FISCAL VÁLIDO. Este módulo garante o primeiro e
 * valida as regras que consegue verificar sozinho (obrigatoriedade, totais,
 * coerência de pagamento). A conformidade com o schema oficial é conferida
 * pelos XSDs do pacote de liberação embutido — ver `validateAgainstSchema`.
 */
import {
  acharCscDaOperacao,
  ambienteDoCsc,
  buildNfceQRCodeUrl,
  cscsDaOperacao,
  rotuloDoAmbiente,
  type AmbienteDoCsc,
} from '../nfce/NfceCscService.js';
import { UNIDADE_FISCAL } from './UnidadeFiscal.js';
import { DIGEST_PROVISORIO, qrCodeOffline } from './NfceQrOffline.js';
import { alcanceDoCfop, impostoXml, totaisDoIcms, tributacaoDoItem } from './TributacaoDoItem.js';
import { momentoFiscal } from './MomentoFiscal.js';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { validarLeiauteNfe, type ResultadoXsd } from './FiscalXsdValidator.js';
import { gtinValido, pareceGtin } from './Gtin.js';
import type { FiscalConfig } from './FiscalConfigService.js';
import {
  infAdProdXml,
  problemaDaIdentidadeNoItem,
  unidadesPorLinha,
  type UnidadeNoDocumento,
} from './IdentidadeDaUnidadeFiscal.js';
import {
  mensagemVendaSoDeServico,
  separarMercadoriaDeServico,
  type ServicoDaVenda,
} from './FiscalVendaDaOficina.js';
import {
  MODEL_NFCE,
  buildAccessKey,
  environmentCode,
  randomNumericCode,
} from './FiscalKeyService.js';

/** Código IBGE da UF. Necessário para o primeiro par de dígitos da chave. */
export const UF_CODE: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27',
  SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41',
  SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};

/**
 * Forma de pagamento -> código `tPag` do layout.
 *
 * Método desconhecido vira `99` (Outros) em vez de bloquear a venda: o cupom
 * sai com a forma genérica, que é aceitável, enquanto travar o caixa por causa
 * de um método novo não é. A tabela precisa ser conferida contra a versão do
 * layout em uso antes da homologação.
 */
export const TPAG: Record<string, string> = {
  dinheiro: '01',
  cheque: '02',
  credito: '03',
  cartao_credito: '03',
  debito: '04',
  cartao_debito: '04',
  credito_loja: '05',
  vale_alimentacao: '10',
  vale_refeicao: '11',
  vale_presente: '12',
  vale_combustivel: '13',
  boleto: '15',
  deposito: '16',
  pix: '17',
  transferencia: '18',
  fidelidade: '19',
  sem_pagamento: '90',
};

/** Escapa os cinco caracteres que quebram XML. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Compartilhado com a NF-e 55: os dois modelos formatam igual. */
export function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** Reais com 2 casas, a partir de centavos. O layout não aceita vírgula. */
export function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Quantidade com 4 casas, como o layout exige em qCom/qTrib. */
export function qty(value: number): string {
  return value.toFixed(4);
}

/*
  O GTIN QUE A NOTA DECLARA (auditoria do produto, A-produto-05).

  Era `digits(barcode).length >= 8 ? digits(barcode) : 'SEM GTIN'`, na NFC-e e
  na NF-e. Três defeitos numa linha:

  - o EAN INTERNO que o botão "Gerar código de barras" cria (prefixo 2, faixa
    de circulação RESTRITA à loja — `BarcodeService`) ia para <cEAN>. Não é
    GTIN registrado; o leiaute pede "SEM GTIN", e a SEFAZ confere o GTIN
    (NT 2017.001): a nota é rejeitada;
  - `digits()` arrancava as letras, então o código interno "PJ12345678" saía
    como cEAN 12345678 — um GTIN que ninguém emitiu;
  - qualquer sequência de 9 a 11 dígitos, ou com o dígito verificador errado,
    também saía.

  Agora só vai para a nota o código com FORMATO de GTIN (8/12/13/14 dígitos),
  verificador certo (a mesma conta do cadastro, `Gtin.ts`) e fora das faixas
  de circulação restrita. O resto — que continua servindo à etiqueta e ao
  scanner da loja — é "SEM GTIN", em <cEAN> e em <cEANTrib>.
*/
export function gtinFiscal(barcode: string | null | undefined): string {
  const codigo = String(barcode ?? '').trim();
  if (!pareceGtin(codigo) || !gtinValido(codigo)) return 'SEM GTIN';
  if (/^0+$/.test(codigo) || gtinDeCirculacaoRestrita(codigo)) return 'SEM GTIN';
  return codigo;
}

/**
 * Faixas GS1 que não identificam produto no comércio: código de balança e
 * código interno da loja (circulação restrita), cupons e recibos.
 */
function gtinDeCirculacaoRestrita(codigo: string): boolean {
  // GTIN-8: os prefixos 0 e 2 são RCN-8, números de circulação restrita.
  if (codigo.length === 8) return codigo[0] === '0' || codigo[0] === '2';
  // GTIN-12 e GTIN-14 lidos na forma de 13 dígitos, onde começa o prefixo GS1:
  // o UPC-A ganha o zero da frente; o GTIN-14 perde o dígito indicador.
  const treze = codigo.length === 12 ? `0${codigo}` : codigo.length === 14 ? codigo.slice(1) : codigo;
  const prefixo = Number(treze.slice(0, 3));
  return (
    // 200–299: circulação restrita (balança, código interno — o do botão da loja).
    treze[0] === '2'
    // 020–029 e 040–049: as mesmas faixas na forma UPC (números 2 e 4);
    // 050–059: cupons.
    || (prefixo >= 20 && prefixo <= 29)
    || (prefixo >= 40 && prefixo <= 59)
    // 980: recibo de devolução; 981–984 e 990–999: cupons.
    || prefixo >= 980
  );
}

export interface NfceSaleItem {
  productId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  origin: string | null;
  unit: string | null;
  barcode: string | null;
  internalCode: string | null;
  /** O grupo tributário do produto — o código de `core_tax_groups`. */
  taxProfile: string | null;
  /** `core_sale_items.id` — nulo em operação que não é venda (pedido online). */
  saleItemId?: string | null;
  /**
   * As unidades serializadas que saíram por esta linha (GAP-PRD-026): o
   * chassi, o motor, a série, o IMEI que vão para o `infAdProd` e para o papel.
   */
  unidades?: UnidadeNoDocumento[];
}

export interface NfceSale {
  id: string;
  number: number;
  companyId: string;
  createdAt: string;
  subtotalCents: number;
  discountCents: number;
  /** Juros e frete lançados no pagamento. Vão para `vOutro` no total. */
  surchargeCents: number;
  totalCents: number;
  changeCents: number;
  customerId: string | null;
  customerDocument: string | null;
  customerName: string | null;
  items: NfceSaleItem[];
  payments: { method: string; amountCents: number }[];
  /**
   * A mão de obra da venda (GAP-PRD-024): fica FORA da nota de mercadoria e é
   * o que a NFS-e declara. Presente só quando a venda tem serviço.
   */
  servicos?: ServicoDaVenda[];
  /** Por que a venda não pôde ser separada em mercadoria e serviço, se não pôde. */
  recusaDaSeparacao?: string | null;
}

/** Lê a venda oficial e tudo que a nota precisa dela. */
export function loadSaleForNfce(
  companyId: string,
  saleId: string,
  /**
   * `aceitarCancelada`: SÓ para REPRESENTAR a nota que já existe (o DANFCE de
   * uma NFC-e cancelada depois da emissão). Emitir continua exigindo venda
   * concluída.
   */
  opcoes: { aceitarCancelada?: boolean } = {},
): NfceSale {
  ensureCoreSchema();
  const db = getConnection();

  const sale = db
    .prepare('SELECT * FROM core_sales WHERE id = ? AND company_id = ?')
    .get(saleId, companyId) as Record<string, unknown> | undefined;
  if (!sale) {
    throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada nesta operação.', 404);
  }
  // Venda cancelada não gera nota. Se já houver nota, o caminho é o
  // cancelamento do documento fiscal, não uma emissão nova.
  const canceladaParaRepresentar = Boolean(opcoes.aceitarCancelada) && String(sale.status) === 'cancelled';
  if (String(sale.status) !== 'completed' && !canceladaParaRepresentar) {
    throw new ApiError(
      'CORE_SALE_NOT_EMITTABLE',
      `Só venda concluída gera NFC-e. Esta está como "${String(sale.status)}".`,
      409,
    );
  }

  const items = db
    .prepare(
      `SELECT i.*, p.ncm, p.cest, p.cfop, p.origin, p.unit, p.barcode, p.internal_code, p.tax_profile
         FROM core_sale_items i
         LEFT JOIN core_products p ON p.id = i.product_id
        WHERE i.sale_id = ?
        ORDER BY i.rowid`,
    )
    .all(saleId) as unknown as Record<string, unknown>[];

  const payments = db
    .prepare('SELECT method, amount_cents FROM core_sale_payments WHERE sale_id = ?')
    .all(saleId) as unknown as { method: string; amount_cents: number }[];

  /*
    O VALE QUE PAGOU PARTE DA VENDA É PAGAMENTO NA NOTA (auditoria do cupom, F-04).

    O crédito de loja fica FORA de `core_sale_payments` por projeto — não é
    instrumento de pagamento, é dívida extinta, e o resgate mora em
    `core_customer_credits` (kind 'redeem'). Esta leitura só via os meios, e a
    conferência de `validateNfce` (pagamentos − troco = total) falhava SEMPRE:
    a venda de R$ 100 com R$ 30 de vale e R$ 70 em dinheiro nunca podia ter
    NFC-e, e o motivo na tela era "Pagamentos (R$ 70,00) ... não fecham com o
    total (R$ 100,00)". A venda paga inteira com vale falhava também em "sem
    pagamento".

    Na nota o vale é uma forma de pagamento como outra: `tPag 05`, "Crédito
    Loja", que o leiaute tem exatamente para isto. A soma dos `detPag` volta a
    fechar com o `vNF`.
  */
  const valeUsado = Math.abs(
    Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_cents), 0) AS usado
               FROM core_customer_credits
              WHERE company_id = ? AND kind = 'redeem'
                AND origin_type = 'sale' AND origin_id = ?`,
          )
          .get(companyId, saleId) as { usado: number }
      ).usado,
    ),
  );

  // Qual moto, qual celular saiu por cada linha (GAP-PRD-026).
  const unidades = unidadesPorLinha(
    companyId,
    { tipo: 'sale', id: saleId },
    items.map((i) => ({ id: String(i.id), productId: (i.product_id as string | null) ?? null })),
  );

  let customerDocument: string | null = null;
  let customerName: string | null = null;
  if (sale.customer_id) {
    const c = db
      .prepare('SELECT name, document FROM core_customers WHERE id = ?')
      .get(String(sale.customer_id)) as { name?: string; document?: string } | undefined;
    customerName = c?.name ?? null;
    customerDocument = c?.document ?? null;
  }

  /*
    A NOTA DE MERCADORIA LEVA SÓ MERCADORIA (GAP-PRD-024).

    A venda da OS tem peça e mão de obra. A peça vai para esta nota; a mão de
    obra (linha sem produto) vai para a NFS-e, com o pagamento rateado — ver
    `FiscalVendaDaOficina`. Venda sem serviço passa intacta.
  */
  return separarMercadoriaDeServico({
    id: String(sale.id),
    number: Number(sale.number),
    companyId,
    createdAt: String(sale.created_at),
    subtotalCents: Number(sale.subtotal_cents),
    discountCents: Number(sale.discount_cents ?? 0),
    surchargeCents: Number(sale.surcharge_cents ?? 0),
    totalCents: Number(sale.total_cents),
    changeCents: Number(sale.change_cents ?? 0),
    customerId: (sale.customer_id as string | null) ?? null,
    customerDocument,
    customerName,
    items: items.map((i, indice) => ({
      saleItemId: String(i.id),
      unidades: unidades[indice],
      productId: String(i.product_id ?? ''),
      description: String(i.description ?? ''),
      quantity: Number(i.quantity),
      unitPriceCents: Number(i.unit_price_cents),
      discountCents: Number(i.discount_cents ?? 0),
      totalCents: Number(i.total_cents),
      ncm: (i.ncm as string | null) ?? null,
      cest: (i.cest as string | null) ?? null,
      cfop: (i.cfop as string | null) ?? null,
      origin: (i.origin as string | null) ?? null,
      unit: (i.unit as string | null) ?? null,
      barcode: (i.barcode as string | null) ?? null,
      internalCode: (i.internal_code as string | null) ?? null,
      taxProfile: (i.tax_profile as string | null) ?? null,
    })),
    payments: [
      ...payments.map((p) => ({
        method: String(p.method),
        amountCents: Number(p.amount_cents),
      })),
      ...(valeUsado > 0 ? [{ method: 'credito_loja', amountCents: valeUsado }] : []),
    ],
  });
}

export interface ValidationProblem {
  field: string;
  message: string;
  /** Índice do item, quando o problema é de um item específico. */
  itemIndex?: number;
}

/**
 * Validação que NÃO depende de XSD.
 *
 * Roda ANTES de numerar. Numerar e só então descobrir que falta um NCM
 * queimaria um número fiscal por erro de cadastro, e número queimado só se
 * resolve por inutilização.
 */
export function validateNfce(sale: NfceSale, config: FiscalConfig): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if (!config.legalName) problems.push({ field: 'emit.xNome', message: 'Razão social ausente.' });
  if (digits(config.cnpj).length !== 14) {
    problems.push({ field: 'emit.CNPJ', message: 'CNPJ do emitente ausente ou inválido.' });
  }
  if (!config.ie) problems.push({ field: 'emit.IE', message: 'Inscrição estadual ausente.' });
  if (!config.crt) problems.push({ field: 'emit.CRT', message: 'Regime tributário (CRT) ausente.' });
  if (!config.uf || !UF_CODE[config.uf.toUpperCase()]) {
    problems.push({ field: 'emit.UF', message: 'UF do emitente ausente ou desconhecida.' });
  }
  if (digits(config.cityIbge).length !== 7) {
    problems.push({ field: 'emit.cMun', message: 'Código IBGE do município ausente ou inválido.' });
  }
  if (!config.street || !config.number || !config.district || !config.cityName) {
    problems.push({ field: 'emit.enderEmit', message: 'Endereço do emitente incompleto.' });
  }
  // O CEP do emitente é OBRIGATÓRIO no leiaute (TEnderEmi, sem minOccurs=0):
  // a nota sem ele não passa no XSD. Cobrado aqui, antes de numerar, com o
  // nome do campo — e não como a mensagem crua do validador (GAP-PRD-097).
  if (digits(config.zip).length !== 8) {
    problems.push({ field: 'emit.CEP', message: 'CEP do emitente ausente ou inválido (8 dígitos).' });
  }

  // A venda da OS separa peça (esta nota) de mão de obra (NFS-e) — GAP-PRD-024.
  if (sale.recusaDaSeparacao) {
    problems.push({ field: 'det', message: sale.recusaDaSeparacao });
  }
  if (sale.items.length === 0) {
    problems.push({
      field: 'det',
      message: sale.servicos?.length ? mensagemVendaSoDeServico(sale.servicos) : 'A venda não tem itens.',
    });
  }

  sale.items.forEach((item, index) => {
    const onde = `det[${index + 1}] ${item.description}`;
    if (digits(item.ncm).length !== 8) {
      problems.push({ field: `${onde} > NCM`, message: 'NCM ausente ou fora do formato (8 dígitos).', itemIndex: index });
    }
    if (digits(item.cfop).length !== 4) {
      problems.push({ field: `${onde} > CFOP`, message: 'CFOP ausente ou fora do formato (4 dígitos).', itemIndex: index });
    } else if (!digits(item.cfop).startsWith('5')) {
      // A NFC-e é sempre operação interna com o consumidor presente (idDest 1):
      // CFOP de outro alcance é rejeição certa, com o número já reservado.
      problems.push({
        field: `${onde} > CFOP`,
        message:
          `A NFC-e é sempre operação interna: o CFOP ${digits(item.cfop)} é de `
          + `${alcanceDoCfop(digits(item.cfop))}. Use o CFOP interno (5xxx) do grupo tributário.`,
        itemIndex: index,
      });
    }
    if (!item.origin || !/^[0-8]$/.test(String(item.origin).trim())) {
      problems.push({ field: `${onde} > origem`, message: 'Origem da mercadoria ausente ou inválida (0 a 8).', itemIndex: index });
    }
    if (item.cest && digits(item.cest).length !== 7) {
      problems.push({ field: `${onde} > CEST`, message: 'CEST fora do formato (7 dígitos).', itemIndex: index });
    }
    // A identidade da unidade cabe no campo do leiaute (GAP-PRD-026).
    const identidade = problemaDaIdentidadeNoItem(item);
    if (identidade) {
      problems.push({ field: `${onde} > infAdProd`, message: identidade, itemIndex: index });
    }
    if (!(item.quantity > 0)) {
      problems.push({ field: `${onde} > qCom`, message: 'Quantidade precisa ser maior que zero.', itemIndex: index });
    }
  });

  // Coerência de totais: a nota tem que fechar com a venda. Divergência aqui
  // vira rejeição na SEFAZ, e é o tipo de erro que só se descobre somando.
  /*
    A CONTA INTEIRA, e não só a soma dos itens.

    Era `soma(itens) === total`. Mas o total de uma venda é
    `subtotal − desconto de rodapé + acréscimo`, e o PDV manda os dois. Toda
    venda com desconto no total — que o balcão dá o dia inteiro — morria aqui
    com "a soma dos itens não bate", sem que nada dissesse que a causa era o
    desconto. O acréscimo da rodada 71 entrou no mesmo buraco.
  */
  const somaItens = sale.items.reduce((s, i) => s + i.totalCents, 0);
  const esperado = somaItens - sale.discountCents + sale.surchargeCents;
  if (esperado !== sale.totalCents) {
    problems.push({
      field: 'total.vNF',
      message:
        `A soma dos itens (${money(somaItens)}) menos o desconto `
        + `(${money(sale.discountCents)}) mais o acréscimo (${money(sale.surchargeCents)}) `
        + `dá ${money(esperado)}, e o total da venda é ${money(sale.totalCents)}.`,
    });
  }

  const somaPagamentos = sale.payments.reduce((s, p) => s + p.amountCents, 0);
  // O troco JÁ está embutido no que o cliente entregou: pagamentos menos troco
  // é o que efetivamente quitou a nota.
  if (somaPagamentos - sale.changeCents !== sale.totalCents) {
    problems.push({
      field: 'pag',
      message:
        `Pagamentos (${money(somaPagamentos)}) menos troco (${money(sale.changeCents)}) `
        + `não fecham com o total (${money(sale.totalCents)}).`,
    });
  }
  if (sale.payments.length === 0) {
    problems.push({ field: 'pag', message: 'A venda não tem pagamento registrado.' });
  }

  return problems;
}

export interface BuiltNfce {
  xml: string;
  accessKey: string;
  numericCode: string;
  /** 1 = normal, 9 = contingência. */
  emissionType: string;
}

/*
  O CUPOM SEM QR CODE NÃO É CUPOM.

  O XML da NFC-e saía de `<ide>` a `<pag>` sem `<infNFeSupl>`, que é onde
  moram o QR Code e a URL de consulta. Modelo 65 sem QR é recusado pela
  SEFAZ e, mesmo que passasse, o consumidor não teria como conferir o
  cupom. O gerador de QR existia (`buildNfceQRCodeUrl`) e só era chamado
  pelo módulo legado, que não emite nada.

  Sem CSC cadastrado não há QR possível — e aí a recusa nomeia o que falta,
  em vez de montar um cupom que nasce inválido. A recusa mora numa função
  própria porque ela roda em DOIS momentos: antes de reservar o número
  (`conferirExigenciasDaMontagem`) e dentro da montagem. Uma régua só.
*/
export function exigirCscDaOperacao(
  companyId: string,
  /**
   * O ambiente da OPERAÇÃO (GAP-PRD-022). Obrigatório: a SEFAZ emite um CSC
   * para cada ambiente, e o QR de produção montado com o de homologação é um
   * hash que o portal não confere.
   */
  environment: AmbienteDoCsc,
  operationalUnitId: string = UNIDADE_FISCAL,
): { cscId: string; cscToken: string } {
  const csc = acharCscDaOperacao(companyId, operationalUnitId, environment);
  if (csc) return csc;

  const outro: AmbienteDoCsc = environment === 'production' ? 'homologation' : 'production';
  const doOutro = cscsDaOperacao(companyId, operationalUnitId)[outro];
  if (doOutro) {
    /*
      "Não tem" e "tem o do outro ambiente" são problemas diferentes, e o
      segundo é o que acontece no dia da virada. Nomear o ID que existe é o que
      faz o dono entender que falta OUTRO código, não repetir o mesmo.
    */
    throw new ApiError(
      'NFCE_CSC_REQUIRED',
      `Esta operação emite em ${rotuloDoAmbiente(environment)}, e o único CSC cadastrado é o de `
        + `${rotuloDoAmbiente(outro)} (CSC ID ${doOutro.cscId}). A SEFAZ emite um CSC para cada `
        + `ambiente, e o QR Code montado com o de ${rotuloDoAmbiente(outro)} não confere no portal. `
        + `Cadastre o CSC de ${rotuloDoAmbiente(environment)} em Fiscal › Configuração — ele vem do `
        + 'portal da SEFAZ.',
      400,
      { environment, cscDoOutroAmbiente: doOutro.cscId },
    );
  }
  throw new ApiError(
    'NFCE_CSC_REQUIRED',
    `Esta operação não tem CSC de ${rotuloDoAmbiente(environment)} cadastrado, e a NFC-e exige o `
      + 'QR Code montado com ele. Cadastre o CSC e o CSC ID em Fiscal › Configuração — eles vêm do '
      + 'portal da SEFAZ.',
    400,
    { environment },
  );
}

/*
  A TRIBUTAÇÃO VEM DA OPERAÇÃO, e o bloco <imposto> é montado num lugar
  só — NF-e e NFC-e carregam o mesmo. Duas cópias divergiriam no dia em
  que a legislação mudasse, e a divergência apareceria como rejeição em
  um dos dois modelos.

  É aqui dentro (`tributacaoDoItem`) que nascem as recusas de tributação
  incompleta — pCredSN ausente, grupo sem CST, CFOP faltando. Por isso a
  função existe à parte do montador: a pré-validação de `createNfceForSale`
  roda EXATAMENTE ela antes de reservar o número, sem cópia da regra.
*/
function impostoDoItemDaVenda(sale: NfceSale, item: NfceSaleItem, index: number): string {
  return impostoXml(tributacaoDaLinha(sale, item, index), {
    id: item.productId ?? String(index + 1),
    description: item.description,
    totalCents: item.totalCents,
  });
}

/**
 * A tributação resolvida de uma linha — separada do XML dela (GAP-V08).
 *
 * O TOTAL da nota precisa de um número que só a tributação sabe (`vIpiCents`),
 * e até esta rodada `<vIPI>` era o literal `0.00`. Um literal no total é a
 * mesma família de defeito do `<ICMSSN102>` cravado no item: o dia em que
 * alguém ligasse o destaque, o total continuaria dizendo zero — e a nota se
 * contradiria sem nenhum erro visível.
 *
 * A função é a MESMA que monta o `<imposto>` do item, chamada uma vez por
 * linha: o total, por construção, soma o que os itens declaram.
 */
function tributacaoDaLinha(sale: NfceSale, item: NfceSaleItem, index: number) {
  return tributacaoDoItem({
    companyId: sale.companyId,
    // Cupom do balcão: o cliente leva a mercadoria na mão, então a
    // operação é sempre interna.
    ufDestinatario: null,
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
  });
}

/**
 * PRÉ-VALIDA o que a montagem vai exigir, SEM montar nada.
 *
 * A chave de acesso depende do nNF, então `buildNfceXml` só pode rodar DEPOIS
 * de `reserveNextNumber`. Mas era dentro do build que a falta de CSC
 * (`NFCE_CSC_REQUIRED`) e a tributação incompleta
 * (`CORE_FISCAL_TRIBUTACAO_INCOMPLETA`) eram descobertas — e recusa por erro
 * de CONFIGURAÇÃO queimava um número fiscal, que só se resolve por
 * inutilização. `createNfceForSale` chama isto antes de reservar.
 *
 * Nenhuma regra vive aqui: as funções chamadas são AS MESMAS que o build usa,
 * na mesma ordem (tributação por item, depois CSC). Só o MOMENTO da recusa
 * mudou de lugar.
 */
export function conferirExigenciasDaMontagem(
  sale: NfceSale,
  /** O ambiente da operação — o CSC exigido é o dele (GAP-PRD-022). */
  environment: string,
): void {
  sale.items.forEach((item, index) => void impostoDoItemDaVenda(sale, item, index));
  exigirCscDaOperacao(sale.companyId, ambienteDoCsc(environment));
}

/**
 * Monta o XML.
 *
 * `Id` do infNFe é `NFe` + a chave — é assim que a assinatura referencia o
 * documento, e é por isso que a chave precisa estar correta antes de assinar.
 */
export function buildNfceXml(input: {
  sale: NfceSale;
  config: FiscalConfig;
  serie: number;
  number: number;
  emissionType?: string;
  /**
   * A entrada em contingência (GAP-PRD-098): obrigatória quando `emissionType`
   * não é 1 — o leiaute exige `dhCont` e `xJust` no `ide` de toda nota fora
   * da emissão normal, e o sistema não inventa nenhum dos dois.
   */
  contingency?: { dhCont: string; xJust: string };
  numericCode?: string;
  issuedAt?: Date;
}): BuiltNfce {
  const { sale, config, serie, number } = input;

  const problems = validateNfce(sale, config);
  if (problems.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_DOCUMENT_INVALID',
      `A nota não pode ser montada: ${problems.map((p) => `${p.field} — ${p.message}`).join(' | ')}`,
      409,
      { problems },
    );
  }

  const issuedAt = input.issuedAt ?? new Date();
  const emissionType = input.emissionType ?? '1';
  if (emissionType !== '1' && !input.contingency) {
    throw new ApiError(
      'CORE_FISCAL_CONTINGENCY_DATA_MISSING',
      'NFC-e fora da emissão normal exige a data de entrada em contingência e a justificativa.',
      500,
    );
  }
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

  const accessKey = buildAccessKey({
    ufCode,
    aamm,
    cnpj: config.cnpj!,
    model: MODEL_NFCE,
    serie,
    number,
    emissionType,
    numericCode,
  });

  const tpAmb = environmentCode(config.environment);

  /*
    A tributação de cada linha, resolvida UMA vez e ANTES do `<det>`, porque o
    total precisa dos mesmos números que o item declara — `vIpiCents`,
    `vPisCents` e `vCofinsCents`. Resolver duas vezes (uma no item, outra no
    total) é o que permite as duas metades divergirem sem ninguém ver.
  */
  const tributacoes = sale.items.map((item, index) => tributacaoDaLinha(sale, item, index));

  const det = sale.items
    .map((item, index) => {
      // cEAN é obrigatório: sem código de barras, o layout exige a literal
      // "SEM GTIN" — deixar vazio é rejeição.
      //
      // O bloco <imposto> sai da MESMA resolução que alimenta o total, e a
      // MESMA função que a pré-validação de `createNfceForSale` roda antes de
      // reservar o número (`impostoDoItemDaVenda`).
      const impostoDoItem = impostoXml(tributacoes[index], {
        id: item.productId ?? String(index + 1),
        description: item.description,
        totalCents: item.totalCents,
      });

      // Só GTIN de verdade vai para a nota — o EAN interno da loja é "SEM GTIN".
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
${impostoDoItem}${
      // O chassi, o motor, o IMEI da unidade (GAP-PRD-026) — no leiaute o
      // `infAdProd` vem depois do `<imposto>`, ainda dentro do `<det>`.
      infAdProdXml(item.unidades, xmlEscape)
    }
    </det>`;
    })
    .join('\n');

  const pag = sale.payments
    .map(
      (p) => `      <detPag>
        <tPag>${TPAG[p.method] ?? '99'}</tPag>
        <vPag>${money(p.amountCents)}</vPag>
      </detPag>`,
    )
    .join('\n');

  const troco = sale.changeCents > 0 ? `\n      <vTroco>${money(sale.changeCents)}</vTroco>` : '';

  // O consumidor só é identificado quando tem documento. NFC-e sem CPF é o
  // caso comum e o layout aceita — inventar um destinatário seria pior.
  const dest =
    digits(sale.customerDocument).length === 11
      ? `\n    <dest>
      <CPF>${digits(sale.customerDocument)}</CPF>${
        sale.customerName ? `\n      <xNome>${xmlEscape(sale.customerName)}</xNome>` : ''
      }
      <indIEDest>9</indIEDest>
    </dest>`
      : '';

  /*
    O TOTAL DA NOTA FECHA COM A CONTA DA VENDA.

    `vDesc` somava só os descontos de LINHA e o desconto de rodapé ficava de
    fora — a nota declarava vProd e vNF que não se explicavam entre si. E o
    acréscimo não tinha lugar nenhum: juros e frete lançados no pagamento vão
    para `vOutro`, que é onde o layout guarda despesa acessória.

    vProd − vDesc + vOutro = vNF, sempre. É essa igualdade que a SEFAZ confere.
  */
  const descontoDasLinhas = sale.items.reduce((s, i) => s + i.discountCents, 0);
  const vDesc = descontoDasLinhas + sale.discountCents;
  const vOutro = sale.surchargeCents;
  const vProd = sale.items.reduce((s, i) => s + i.totalCents + i.discountCents, 0);

  /*
    O IPI DO TOTAL É A SOMA DO QUE OS ITENS DECLARAM (GAP-V08).

    Era o literal `0.00`, ao lado de um `<imposto>` que também não tinha bloco
    `<IPI>` nenhum — os dois concordavam por acaso, e não por construção. Agora
    o número vem da MESMA resolução que monta cada item, então eles não podem
    divergir.

    Hoje esta soma é zero em toda empresa do grupo, e continuará sendo enquanto
    ninguém declarar CST de IPI no grupo tributário — o padrão do varejo do
    Simples. A diferença é que o zero passou a ser um RESULTADO, e não uma
    promessa cravada no XML.

    O IPI COM VALOR não chega aqui: `tributacaoDoItem` o recusa antes, porque
    imposto cobrado por fora somaria ao `vNF` e o total da nota deixaria de
    bater com os pagamentos — a razão está por extenso lá.
  */
  const vIpi = tributacoes.reduce((soma, t) => soma + t.vIpiCents, 0);

  /*
    E O MESMO VALE PARA PIS E COFINS, que continuavam literais aqui.

    A diferença em relação ao IPI é a natureza do imposto: PIS e COFINS são
    cobrados POR DENTRO e `<vPIS>`/`<vCOFINS>` do `<ICMSTot>` são INFORMATIVOS
    — não entram na soma do `vNF`. Emitir o valor verdadeiro não move o total
    da nota em um centavo, e por isso aqui o número SAI em vez de ser recusado.
  */
  const vPis = tributacoes.reduce((soma, t) => soma + t.vPisCents, 0);
  const vCofins = tributacoes.reduce((soma, t) => soma + t.vCofinsCents, 0);
  // E o ICMS (GAP-PRD-021): base, valor e FCP somam o que os itens declaram.
  const icmsTotal = totaisDoIcms(tributacoes);

  // Sem CSC não há QR possível — a recusa nomeada mora em
  // `exigirCscDaOperacao`, que também é o portão da pré-validação. O CSC é o
  // do ambiente da OPERAÇÃO, com o mesmo fail-safe do tpAmb (GAP-PRD-022).
  const csc = exigirCscDaOperacao(sale.companyId, ambienteDoCsc(config.environment));
  /*
    NFC-e OFF-LINE (tpEmis 9) LEVA O QR DA VERSÃO OFF-LINE (GAP-PRD-098): dia
    da emissão, valor e o digVal da assinatura — que só existe depois de
    assinar. A montagem sai com o digVal provisório (só para o XSD antes de
    numerar); a assinatura troca pelo verdadeiro (`aplicarQrOffline`).
  */
  const qr = emissionType === '9'
    ? qrCodeOffline({
        accessKey,
        environment: config.environment as 'homologation' | 'production',
        dhEmi,
        vNF: money(sale.totalCents),
        digestValue: DIGEST_PROVISORIO,
        cscId: csc.cscId,
        cscToken: csc.cscToken,
        uf,
      })
    : buildNfceQRCodeUrl(accessKey, config.environment as never, csc.cscId, csc.cscToken, uf);
  const infNFeSupl = `  <infNFeSupl>
    <qrCode><![CDATA[${qr.url}]]></qrCode>
    <urlChave>${qr.urlChave}</urlChave>
  </infNFeSupl>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe versao="4.00" Id="NFe${accessKey}">
    <ide>
      <cUF>${ufCode}</cUF>
      <cNF>${numericCode}</cNF>
      <natOp>VENDA AO CONSUMIDOR</natOp>
      <mod>${MODEL_NFCE}</mod>
      <serie>${serie}</serie>
      <nNF>${number}</nNF>
      <dhEmi>${dhEmi}</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>${digits(config.cityIbge)}</cMunFG>
      <tpImp>4</tpImp>
      <tpEmis>${emissionType}</tpEmis>
      <cDV>${accessKey.slice(-1)}</cDV>
      <tpAmb>${tpAmb}</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>1</indFinal>
      <indPres>1</indPres>
      <procEmi>0</procEmi>
      <verProc>GrupoSampaio-1.0</verProc>${
        input.contingency && emissionType !== '1'
          ? `
      <dhCont>${input.contingency.dhCont}</dhCont>
      <xJust>${xmlEscape(input.contingency.xJust)}</xJust>`
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
        <xPais>BRASIL</xPais>${
          config.phone ? `\n        <fone>${digits(config.phone)}</fone>` : ''
        }
      </enderEmit>
      <IE>${digits(config.ie)}</IE>
      <CRT>${digits(config.crt)}</CRT>
    </emit>${dest}
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
        <vProd>${money(vProd)}</vProd>
        <vFrete>0.00</vFrete>
        <vSeg>0.00</vSeg>
        <vDesc>${money(vDesc)}</vDesc>
        <vII>0.00</vII>
        <vIPI>${money(vIpi)}</vIPI>
        <vIPIDevol>0.00</vIPIDevol>
        <vPIS>${money(vPis)}</vPIS>
        <vCOFINS>${money(vCofins)}</vCOFINS>
        <vOutro>${money(vOutro)}</vOutro>
        <vNF>${money(sale.totalCents)}</vNF>
      </ICMSTot>
    </total>
    <transp>
      <modFrete>9</modFrete>
    </transp>
    <pag>
${pag}${troco}
    </pag>
  </infNFe>
${infNFeSupl}
</NFe>`;

  return { xml, accessKey, numericCode, emissionType };
}

export type SchemaValidationResult = ResultadoXsd;

/**
 * Validação contra o schema oficial — GAP-PRD-097.
 *
 * Os XSDs do Pacote de Liberação vigente estão no projeto
 * (`server/fiscal-schemas`) e o validador é a libxml2: ordem de elementos,
 * cardinalidade, tamanho, padrão e domínio de cada campo são conferidos aqui,
 * antes da SEFAZ. Nota ainda não assinada é validada com a assinatura-molde
 * (ver `validarLeiauteNfe`).
 *
 * `validated` continua só ficando `true` quando o XSD real foi aplicado:
 * com o pacote ausente ou adulterado, a resposta diz isso em `note` em vez de
 * reportar "XSD VALID" sem XSD — a mesma classe de mentira do autorizador
 * que fabricava protocolo.
 */
export function validateAgainstSchema(xml: string): SchemaValidationResult {
  return validarLeiauteNfe(xml);
}
