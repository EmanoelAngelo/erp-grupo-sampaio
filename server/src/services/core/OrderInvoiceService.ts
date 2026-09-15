/**
 * A nota fiscal do pedido online.
 *
 * O pipeline fiscal inteiro existia e só sabia partir de uma VENDA. Pedido não
 * é venda: tem financeiro próprio, lançado quando o pagamento entrou. Converter
 * pedido em venda para caber na coluna `sale_id` lançaria a mesma receita duas
 * vezes — e foi por isso que a ponte ficou de fora até aqui, com o diagnóstico
 * honesto no lugar dela.
 *
 * ESTE MÓDULO É A PONTE, e ela respeita a mesma regra do resto do fiscal:
 *
 *   O DOCUMENTO REFERENCIA O FATO ECONÔMICO; NÃO CRIA OUTRO.
 *
 * Nada aqui baixa estoque, lança receita ou muda o status do pedido. Estoque e
 * dinheiro já aconteceram no checkout e no pagamento. O que este módulo produz
 * é papel — e papel não move mercadoria.
 *
 * O DESTINATÁRIO VEM DO CADASTRO DO CLIENTE, não do texto do pedido. O pedido
 * guarda o endereço como uma linha só, boa para colar na etiqueta e inútil para
 * a nota: a NF-e quer logradouro, número, bairro, município COM CÓDIGO IBGE e
 * UF em campos separados. Quem tem isso é o endereço do portal.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { getFiscalConfig, assertCanEmit, buildReadiness, type FiscalConfig } from './FiscalConfigService.js';
import { MODEL_NFE, reserveNextNumber } from './FiscalKeyService.js';
import { getDocument, recordTransition, type FiscalDocument } from './FiscalDocumentService.js';
import { advanceDocument } from './FiscalPipelineService.js';
import type { NfceSale } from './FiscalXmlNfce.js';
import {
  buildNfeXml,
  validateNfe,
  type NfeRecipient,
  type NfeTransport,
  type PresenceIndicator,
} from './FiscalXmlNfe.js';
import { conferirLeiauteAntesDeNumerar } from './FiscalXsdValidator.js';
import { completarPeloGrupo } from './TributacaoDoItem.js';
import { motivosDaTributacaoDaVenda } from './ProntidaoTributaria.js';
import { unidadesPorLinha } from './IdentidadeDaUnidadeFiscal.js';
import { addOrderEvent } from './StorefrontService.js';
import {
  CODIGO_DA_UF,
  conferirMunicipio,
  contarMunicipios,
  municipioDaNotaQueNaoConfere,
  municipioPeloNome,
  porQueNaoConfere,
  type Municipio,
} from './MunicipiosIbge.js';

function digits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

interface OrderRow {
  id: string;
  company_id: string;
  number: number;
  status: string;
  customer_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_document: string | null;
  shipping_zip: string | null;
  shipping_cents: number;
  items_cents: number;
  total_cents: number;
  /** O cupom do pedido (GAP-PRD-123); `items_cents` já é líquido dele. */
  discount_cents?: number | null;
  payment_method: string | null;
  created_at: string;
}

function loadOrder(companyId: string, orderId: string): OrderRow {
  const row = getConnection()
    .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as OrderRow | undefined;
  if (!row) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
  return row;
}

/**
 * O pedido na forma que o montador de XML entende.
 *
 * `totalCents` recebe SÓ os itens. O frete não entra aí porque o layout o
 * declara em campo próprio (`vFrete`) e o validador confere a soma dos itens
 * contra este total — somar o frete aqui faria toda nota com entrega ser
 * recusada por total divergente.
 */
export function orderAsFiscalOperation(companyId: string, orderId: string): NfceSale {
  ensureCoreSchema();
  const db = getConnection();
  const order = loadOrder(companyId, orderId);

  const itens = db
    .prepare(
      `SELECT i.*, p.ncm, p.cest, p.cfop, p.origin, p.unit, p.barcode, p.internal_code, p.tax_profile
         FROM core_order_items i
         LEFT JOIN core_products p ON p.id = i.product_id
        WHERE i.order_id = ?
        ORDER BY i.rowid`,
    )
    .all(orderId) as unknown as Record<string, unknown>[];

  /*
    A MOTO VENDIDA PELA LOJA ONLINE TAMBÉM SAI COM O CHASSI (GAP-PRD-026).
    A unidade do pedido sai com a referência `ecommerce_order` (a separação
    escolhe por FIFO); o leitor é o mesmo da venda de balcão.
  */
  const unidades = unidadesPorLinha(
    companyId,
    { tipo: 'ecommerce_order', id: order.id },
    itens.map((i) => ({ id: null, productId: (i.product_id as string | null) ?? null })),
  );

  /*
    O CUPOM ENTRA COMO DESCONTO DO ITEM (GAP-PRD-123). O pedido guarda cada
    item LÍQUIDO (`total_cents`) com a sua parte do cupom ao lado
    (`discount_cents`) — que é exatamente o que o montador espera: vProd do item
    = total + desconto, vDesc = desconto, e o total da nota = soma dos líquidos.
    Pedido sem cupom tem desconto zero e tudo continua como era.
  */
  const descontoDoCupom = Number(order.discount_cents ?? 0);
  return {
    id: order.id,
    number: Number(order.number),
    companyId,
    createdAt: String(order.created_at),
    subtotalCents: Number(order.items_cents) + descontoDoCupom,
    discountCents: descontoDoCupom,
    // Pedido online não tem acréscimo de balcão: juros e frete vivem no frete.
    surchargeCents: 0,
    totalCents: Number(order.items_cents),
    changeCents: 0,
    customerId: order.customer_id,
    customerDocument: order.customer_document,
    customerName: order.customer_name,
    items: itens.map((i, indice) => ({
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
    payments: order.payment_method
      ? [{ method: String(order.payment_method), amountCents: Number(order.total_cents) }]
      : [],
  };
}

/**
 * O destinatário, montado do cadastro do cliente.
 *
 * Escolhe o endereço pelo CEP do pedido — é aquele que o cliente usou na
 * compra. Sem correspondência, cai no padrão da conta. Devolve `null` quando
 * não há endereço estruturado nenhum: inventar município ou completar campo em
 * branco produziria uma nota aceita pela SEFAZ e ERRADA, que é o pior desfecho
 * possível — o fisco registra o que foi enviado, não o que se quis enviar.
 */
export function recipientForOrder(companyId: string, orderId: string): NfeRecipient | null {
  return destinatarioDoPedido(companyId, orderId)?.recipient ?? null;
}

/** De onde saiu o destinatário da nota do pedido. */
type LadoDoDestinatario = 'billing' | 'shipping' | 'conta';

interface DestinatarioDoPedido {
  recipient: NfeRecipient;
  /** O retrato do faturamento, o da entrega, ou o endereço da conta (pedido anterior ao retrato). */
  lado: LadoDoDestinatario;
  /** O endereço da conta usado — só no lado 'conta'. */
  enderecoId: string | null;
}

/**
 * O destinatário E de onde ele saiu: a correção do município (R3-IBGE)
 * precisa saber qual retrato mudar.
 */
function destinatarioDoPedido(companyId: string, orderId: string): DestinatarioDoPedido | null {
  ensureCoreSchema();
  const db = getConnection();
  const order = loadOrder(companyId, orderId);

  /*
    O RETRATO DO PEDIDO PRIMEIRO (GAP-PRD-115). Desde que o checkout grava o
    endereço de faturamento em colunas, a nota sai do endereço COMO ESTAVA na
    compra — não do endereço vivo da conta, que a pessoa pode ter editado ou
    apagado depois. Sem faturamento, o retrato da entrega com IBGE serve.
    Pedido anterior à regra (sem retrato) segue pelo caminho antigo abaixo.
  */
  const retrato = db
    .prepare(
      `SELECT billing_name, billing_zip, billing_street, billing_number, billing_complement,
              billing_district, billing_city, billing_state, billing_city_ibge,
              shipping_zip, shipping_street, shipping_number, shipping_complement,
              shipping_district, shipping_city, shipping_state, shipping_city_ibge
         FROM core_orders WHERE id = ?`,
    )
    .get(orderId) as Record<string, string | null> | undefined;
  const lado = retrato?.billing_city_ibge ? 'billing' : retrato?.shipping_city_ibge ? 'shipping' : null;
  if (retrato && lado) {
    const campo = (nome: string) => retrato[`${lado}_${nome}`] ?? null;
    return {
      lado,
      enderecoId: null,
      recipient: {
        document: digits(order.customer_document),
        name: (lado === 'billing' ? retrato.billing_name : null) ?? order.customer_name,
        // Consumidor final de loja online: não contribuinte (ver abaixo).
        ieIndicator: '9',
        ie: null,
        street: String(campo('street') ?? ''),
        number: String(campo('number') ?? ''),
        complement: campo('complement'),
        district: String(campo('district') ?? ''),
        cityName: String(campo('city') ?? ''),
        cityIbge: String(campo('city_ibge') ?? ''),
        uf: String(campo('state') ?? ''),
        zip: String(campo('zip') ?? ''),
        email: order.customer_email,
      },
    };
  }

  if (!order.customer_email) return null;

  const conta = db
    .prepare('SELECT id FROM core_customer_accounts WHERE lower(email) = lower(?)')
    .get(order.customer_email) as { id: string } | undefined;
  if (!conta) return null;

  const cep = digits(order.shipping_zip);
  const enderecos = db
    .prepare(
      `SELECT * FROM core_customer_addresses
        WHERE account_id = ? ORDER BY is_default DESC, created_at`,
    )
    .all(conta.id) as unknown as Record<string, unknown>[];
  if (enderecos.length === 0) return null;

  const escolhido =
    enderecos.find((e) => cep && digits(String(e.zip)) === cep) ?? enderecos[0];

  return {
    lado: 'conta',
    enderecoId: String(escolhido.id ?? '') || null,
    recipient: {
      document: digits(order.customer_document),
      name: order.customer_name,
      // Consumidor final de loja online: não contribuinte. Marcar contribuinte
      // sem inscrição mudaria a tributação da operação inteira.
      ieIndicator: '9',
      ie: null,
      street: String(escolhido.street ?? ''),
      number: String(escolhido.number ?? ''),
      complement: (escolhido.complement as string | null) ?? null,
      district: String(escolhido.district ?? ''),
      cityName: String(escolhido.city ?? ''),
      cityIbge: String(escolhido.city_ibge ?? ''),
      uf: String(escolhido.state ?? ''),
      zip: String(escolhido.zip ?? ''),
      email: order.customer_email,
    },
  };
}

/**
 * O município do endereço da nota que a tabela oficial desmente (R3-IBGE).
 *
 * O pedido fechado ANTES de a tabela ser carregada guarda no retrato o código
 * que o cliente digitou — só o formato era conferido. A prontidão o aponta, a
 * emissão recusa sem numerar, e a tela oferece a correção
 * (`corrigirMunicipioDaNotaDoPedido`) com a cidade sugerida pelo nome escrito.
 */
export interface MunicipioDaNotaDoPedido {
  /** De onde o destinatário sai: o retrato do faturamento, o da entrega, ou o endereço da conta. */
  lado: 'faturamento' | 'entrega' | 'cadastro';
  uf: string;
  /** A cidade como está escrita no endereço. */
  cidade: string;
  /** O código que a tabela desmente. */
  codigo: string;
  motivo: string;
  /** A cidade da UF com o nome escrito, quando há uma só — a tela a oferece. */
  sugestao: Municipio | null;
  /**
   * O município do PRÓPRIO código, quando ele existe em OUTRA UF: o banco da
   * 84 guardava o código conferindo só os 7 dígitos (a UF só tinha de ter duas
   * letras) — cliente de Pelotas que marcou SC. Aí pode ser a UF que está
   * errada, e a correção aceita manter o código e trocar a UF para a dele.
   */
  doCodigo: Municipio | null;
}

const NOME_DO_LADO: Record<LadoDoDestinatario, MunicipioDaNotaDoPedido['lado']> = {
  billing: 'faturamento',
  shipping: 'entrega',
  conta: 'cadastro',
};

function municipioDaNota(d: DestinatarioDoPedido): MunicipioDaNotaDoPedido | null {
  const errado = municipioDaNotaQueNaoConfere(d.recipient.cityIbge, d.recipient.uf, d.recipient.cityName);
  if (!errado) return null;
  const uf = d.recipient.uf.trim().toUpperCase();
  return {
    lado: NOME_DO_LADO[d.lado],
    uf,
    cidade: d.recipient.cityName,
    codigo: digits(d.recipient.cityIbge),
    motivo: errado.motivo,
    sugestao: municipioPeloNome(d.recipient.cityName, uf),
    doCodigo: errado.municipio && errado.municipio.uf !== uf ? errado.municipio : null,
  };
}

/** O motivo da prontidão: o que está errado, por que importa e ONDE corrigir. */
function fraseDoMunicipio(m: MunicipioDaNotaDoPedido): string {
  return (
    `Município do destinatário: ${m.motivo}. O endereço da nota deste pedido foi gravado sem a conferência `
    + 'da tabela oficial do IBGE, e a SEFAZ recusaria a nota depois de numerada. Corrija em Pedidos › este '
    + 'pedido › Nota fiscal do pedido, escolhendo a cidade na lista'
    + (m.sugestao
      ? ` (pelo nome escrito, "${m.cidade}" é ${m.sugestao.nome}, código ${m.sugestao.codigo}).`
      : '.')
    + (m.doCodigo
      ? ` Se o cliente é mesmo de ${m.doCodigo.nome} (${m.doCodigo.uf}), é a UF do endereço que está errada: `
        + `mantenha o código ${m.codigo}, e a UF passa a ser ${m.doCodigo.uf}.`
      : '')
  );
}

export interface OrderInvoiceReadiness {
  canEmit: boolean;
  /** Já existe NF-e deste pedido: não é caso de emitir, é caso de consultar. */
  alreadyEmitted: boolean;
  documentId: string | null;
  reasons: string[];
  /**
   * O município do endereço da nota que a tabela oficial desmente, com a
   * sugestão pelo nome — a tela oferece a correção ali mesmo (R3-IBGE).
   * `null` quando não há o que corrigir (ou a tabela está vazia).
   */
  municipio: MunicipioDaNotaDoPedido | null;
}

/** Chaves do checklist que descrevem o CATÁLOGO, não este pedido. */
const CHAVES_DE_CATALOGO = new Set([
  'product_ncm',
  'product_cfop',
  // Catálogo inteiro (GAP-PRD-095/129); os itens DESTE pedido são conferidos
  // abaixo, pela mesma régua da emissão.
  'product_origin',
  'product_tax_group',
]);

/**
 * Dá para faturar ESTE pedido?
 *
 * A pergunta é por pedido, e não pela operação, porque as duas respostas
 * divergem — e a divergência é o que interessa ao gestor: pendência de catálogo
 * não pode esconder o botão de um pedido completo, e operação em ordem não
 * autoriza faturar pedido cujo cliente não tem endereço fiscal.
 */
export function orderInvoiceReadiness(companyId: string, orderId: string): OrderInvoiceReadiness {
  ensureCoreSchema();
  const order = loadOrder(companyId, orderId);

  const existente = getConnection()
    .prepare(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND order_id = ? AND model = ?`,
    )
    .get(companyId, orderId, MODEL_NFE) as { id: string } | undefined;
  if (existente) {
    return {
      canEmit: false,
      alreadyEmitted: true,
      documentId: existente.id,
      reasons: ['Este pedido já tem NF-e.'],
      municipio: null,
    };
  }

  // Pedido não pago não se fatura. A nota declara uma operação que aconteceu;
  // emitir antes do dinheiro seria declarar uma venda que ainda pode não haver.
  if (order.status !== 'pago') {
    return {
      canEmit: false,
      alreadyEmitted: false,
      documentId: null,
      reasons: [`Pedido está como "${order.status}"; só pedido pago é faturável.`],
      municipio: null,
    };
  }

  const relatorio = buildReadiness(companyId, MODEL_NFE);
  const motivos = relatorio.items
    .filter((i) => i.status === 'FAIL' && !CHAVES_DE_CATALOGO.has(i.key))
    .map((i) => `${i.label}: ${i.detail}`);

  const doPedido = destinatarioDoPedido(companyId, orderId);
  const destinatario = doPedido?.recipient ?? null;
  // O código do retrato contra a tabela oficial (R3-IBGE): sem a tabela, nulo.
  const municipio = doPedido ? municipioDaNota(doPedido) : null;
  if (!destinatario) {
    motivos.push(
      'O cliente não tem endereço cadastrado com os campos que a NF-e exige. '
        + 'Peça a ele para completar o endereço no portal, ou complete pelo cadastro.',
    );
  } else {
    // O pedido como a nota o monta: lacunas do produto vêm do grupo, com o
    // CFOP interestadual quando o cliente é de outra UF (GAP-PRD-129).
    const venda = completarPeloGrupo(
      orderAsFiscalOperation(companyId, orderId),
      destinatario.uf,
    );
    const config = getFiscalConfig(companyId);
    for (const p of validateNfe({ sale: venda, config, recipient: destinatario })) {
      // O emitente já foi cobrado pelo checklist acima; repetir com outro texto
      // faria o gestor procurar dois problemas onde há um.
      if (p.field.startsWith('emit.')) continue;
      motivos.push(`${p.field} — ${p.message}`);
    }
    // E a tributação dos itens, pela régua da emissão (GAP-PRD-095).
    motivos.push(...motivosDaTributacaoDaVenda(venda, destinatario.uf));
    if (municipio) motivos.push(fraseDoMunicipio(municipio));
  }

  return {
    canEmit: motivos.length === 0,
    alreadyEmitted: false,
    documentId: null,
    reasons: motivos,
    municipio,
  };
}

/**
 * Monta a NF-e do pedido. Idempotente: dois cliques, um documento.
 *
 * O número fiscal é reservado FORA da transação, de propósito: ele é queimado.
 * Devolvê-lo depois de uma falha permitiria que outro pedido o reutilizasse
 * enquanto a SEFAZ já o viu.
 */
export function createNfeForOrder(input: {
  companyId: string;
  orderId: string;
  serie?: number;
  userId?: string | null;
}): { document: FiscalDocument; created: boolean } {
  ensureCoreSchema();
  const db = getConnection();

  const existente = db
    .prepare(
      `SELECT id FROM core_fiscal_documents
        WHERE company_id = ? AND order_id = ? AND model = ?`,
    )
    .get(input.companyId, input.orderId, MODEL_NFE) as { id: string } | undefined;
  if (existente) {
    return { document: getDocument(input.companyId, existente.id)!, created: false };
  }

  // As conferências da montagem moram em `prepararNfeDoPedido` — a reemissão
  // de uma rejeitada passa pelas mesmas, sem cópia (P0 fiscal).
  const montagem = prepararNfeDoPedido(input.companyId, input.orderId);
  const destinatario = montagem.recipient;
  const serie = input.serie ?? 1;

  // O leiaute pelo XSD antes do número — o portão comum da NF-e (GAP-PRD-097).
  conferirLeiauteAntesDeNumerar(
    (provisorio) => buildNfeXml({ ...montagem, serie, number: provisorio }).xml,
  );

  const numero = reserveNextNumber({ companyId: input.companyId, model: MODEL_NFE, serie });
  const emitidoEm = new Date();
  const construido = buildNfeXml({ ...montagem, serie, number: numero, issuedAt: emitidoEm });

  try {
    return withTransaction(() => {
      const id = randomUUID();
      const agora = new Date().toISOString();

      db.prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, order_id, model, serie, number, access_key, environment, status,
            xml_original, issued_at, recipient_name, recipient_document,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.companyId,
        input.orderId,
        MODEL_NFE,
        serie,
        numero,
        construido.accessKey,
        montagem.config.environment,
        construido.xml,
        emitidoEm.toISOString(),
        // Gravado na emissão: é o destinatário DAQUELA nota. Buscar depois no
        // cadastro traria o nome de hoje, não o que foi para o fisco.
        destinatario.name,
        destinatario.document,
        `order:${input.orderId}:${MODEL_NFE}`,
        agora,
        agora,
      );

      recordTransition({
        companyId: input.companyId,
        documentId: id,
        from: 'DRAFT',
        to: 'DRAFT',
        detail: { orderId: input.orderId, number: numero, serie, model: MODEL_NFE },
        userId: input.userId,
      });

      const documento = getDocument(input.companyId, id)!;
      // Sobe SEM XML, sem certificado e sem chave privada — a central precisa
      // do fato, não do documento.
      recordDomainEvent({
        eventType: 'fiscal.document_issued',
        aggregateType: 'fiscal_document',
        aggregateId: id,
        companyId: input.companyId,
        payload: {
          id,
          model: documento.model,
          serie: documento.serie,
          number: documento.number,
          access_key: documento.accessKey,
          status: documento.status,
          environment: documento.environment,
          order_id: input.orderId,
          issued_at: documento.issuedAt,
        },
      });
      return { document: documento, created: true };
    });
  } catch (err) {
    const jaExiste = db
      .prepare(
        `SELECT id FROM core_fiscal_documents
          WHERE company_id = ? AND order_id = ? AND model = ?`,
      )
      .get(input.companyId, input.orderId, MODEL_NFE) as { id: string } | undefined;
    if (jaExiste) {
      return { document: getDocument(input.companyId, jaExiste.id)!, created: false };
    }
    throw err;
  }
}

/** O que a NF-e do pedido precisa para ser montada — conferido, ainda sem número. */
export interface MontagemDaNfeDoPedido {
  sale: NfceSale;
  config: FiscalConfig;
  recipient: NfeRecipient;
  transport: NfeTransport;
  presence: PresenceIndicator;
  additionalInfo: string;
}

/**
 * A MONTAGEM DA NF-e DO PEDIDO, sem número.
 *
 * Separada de `createNfeForOrder` (P0 fiscal) para que a REEMISSÃO de uma nota
 * rejeitada — mesmo número, chave nova, cadastro corrigido — passe pelas
 * MESMAS conferências da primeira emissão. Nenhuma regra nova: é o trecho que
 * morava dentro de `createNfeForOrder`, com o mesmo texto de recusa.
 */
export function prepararNfeDoPedido(companyId: string, orderId: string): MontagemDaNfeDoPedido {
  const order = loadOrder(companyId, orderId);
  if (order.status !== 'pago') {
    throw new ApiError(
      'CORE_ORDER_NOT_INVOICEABLE',
      `Só pedido pago gera NF-e. Este está como "${order.status}".`,
      409,
    );
  }

  // Portão de montagem: emitente e série. Certificado e CSC são cobrados na
  // assinatura — exigi-los aqui faria o gestor perder o faturamento enquanto o
  // certificado é renovado, em vez de acumular na fila.
  assertCanEmit(companyId, MODEL_NFE, 'document');

  const destinatario = recipientForOrder(companyId, orderId);
  if (!destinatario) {
    throw new ApiError(
      'CORE_ORDER_RECIPIENT_MISSING',
      'O cliente não tem endereço cadastrado com os campos que a NF-e exige.',
      409,
    );
  }

  const config = getFiscalConfig(companyId);
  // Lacunas do produto vêm do grupo — CFOP interestadual para outra UF (GAP-PRD-129).
  const operacao = completarPeloGrupo(orderAsFiscalOperation(companyId, orderId), destinatario.uf);

  // VALIDA ANTES DE NUMERAR: descobrir um NCM faltando depois de reservar o
  // número queimaria um número por erro de cadastro, e número queimado só se
  // resolve por inutilização.
  const problemas = validateNfe({ sale: operacao, config, recipient: destinatario });
  /*
    E O MUNICÍPIO DO RETRATO NA TABELA OFICIAL (R3-IBGE). O pedido fechado
    antes da tabela passou só pelo formato; com um código que não é município
    da UF, a SEFAZ recusaria a nota com o número já queimado. Recusa aqui,
    antes da reserva, dizendo onde corrigir. Sem a tabela, nada muda.
  */
  const municipioErrado = municipioDaNotaQueNaoConfere(destinatario.cityIbge, destinatario.uf, destinatario.cityName);
  if (municipioErrado) {
    problemas.push({
      field: 'dest.cMun',
      message:
        `${municipioErrado.motivo} — corrija o município em Pedidos › este pedido › Nota fiscal do pedido `
        + '(escolha a cidade na lista) e emita de novo.',
    });
  }
  if (problemas.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_DOCUMENT_INVALID',
      `A NF-e não pode ser emitida: ${problemas
        .map((p) => `${p.field} — ${p.message}`)
        .join(' | ')}`,
      409,
      { problems: problemas },
    );
  }

  const frete = Number(order.shipping_cents ?? 0);
  const transporte: NfeTransport = frete > 0
    // Frete cobrado do cliente na loja: por conta do destinatário.
    ? { modFrete: '1', freightCents: frete }
    // Retirada no balcão não tem transporte. Declarar frete zero com modalidade
    // de entrega diria que houve envio grátis, o que não aconteceu.
    : { modFrete: '9', freightCents: 0 };

  return {
    sale: operacao,
    config,
    recipient: destinatario,
    transport: transporte,
    presence: '2',
    additionalInfo: `Pedido online nº ${order.number}.`,
  };
}

/** Monta, valida, assina e enfileira a NF-e do pedido. */
export async function emitNfeForOrder(input: {
  companyId: string;
  orderId: string;
  userId?: string | null;
  certificatePassword?: string;
  developmentMode?: boolean;
}) {
  ensureCoreSchema();
  const config = getFiscalConfig(input.companyId);
  const dev = Boolean(input.developmentMode);

  // A trava mais importante: nota assinada com fixture não existe para o fisco.
  if (dev && config.environment === 'production') {
    throw new ApiError(
      'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION',
      'Modo de desenvolvimento não é permitido em produção.',
      409,
    );
  }

  const { document } = createNfeForOrder({
    companyId: input.companyId,
    orderId: input.orderId,
    userId: input.userId,
  });

  return advanceDocument(
    document.id,
    {
      companyId: input.companyId,
      userId: input.userId,
      certificatePassword: input.certificatePassword,
      developmentMode: dev,
    },
    dev,
  );
}

export interface CorrecaoDoMunicipio {
  lado: MunicipioDaNotaDoPedido['lado'];
  /** O código que estava no endereço da nota ('' quando não havia). */
  de: string;
  para: Municipio;
  /** A UF que estava no endereço — difere de `para.uf` só quando o código do cliente era de outra UF. */
  ufDe: string;
}

/**
 * O CAMINHO PARA CORRIGIR o município do endereço da nota (R3-IBGE).
 *
 * O retrato do pedido é congelado de propósito (GAP-PRD-115): a nota sai do
 * endereço como estava na compra, e o cliente não o edita depois. Mas o
 * pedido fechado antes da tabela pode ter no retrato um código que ela
 * desmente — e, sem caminho, esse pedido não se faturava nunca (a emissão
 * recusa; antes, a SEFAZ recusava com o número queimado).
 *
 * A gerência escolhe o município na lista, e só o MUNICÍPIO muda (nome e
 * código; rua, número, bairro, CEP e UF ficam como o cliente deu). Com três
 * travas: só com a tabela carregada; só quando o código de hoje NÃO confere
 * (município certo não se troca por aqui); só antes da nota (o endereço da
 * nota emitida é o que foi para o fisco). E o município escolhido tem de ser
 * da UF do endereço — com UMA exceção: o município do PRÓPRIO código do
 * cliente, quando ele é de outra UF (retrato da 84 com a UF marcada errada);
 * aí a UF passa a ser a dele. Fica no histórico do pedido quem trocou, de quê
 * para quê.
 *
 * Pedido de antes do retrato (o destinatário sai do endereço da conta): a
 * correção grava o retrato do faturamento a partir desse endereço, com o
 * município certo — dali em diante a nota sai dele, e não do endereço vivo.
 */
export function corrigirMunicipioDaNotaDoPedido(input: {
  companyId: string;
  orderId: string;
  cityIbge: unknown;
  userId?: string | null;
}): CorrecaoDoMunicipio {
  ensureCoreSchema();
  const db = getConnection();
  const order = loadOrder(input.companyId, input.orderId);

  const codigo =
    typeof input.cityIbge === 'string' || typeof input.cityIbge === 'number' ? digits(String(input.cityIbge)) : '';
  if (codigo.length !== 7) {
    throw new ApiError(
      'CORE_ORDER_MUNICIPIO_INVALIDO',
      'Informe o código IBGE do município (7 dígitos): escolha a cidade na lista.',
      400,
    );
  }

  const nota = db
    .prepare('SELECT id FROM core_fiscal_documents WHERE company_id = ? AND order_id = ? AND model = ?')
    .get(input.companyId, input.orderId, MODEL_NFE);
  if (nota) {
    throw new ApiError(
      'CORE_ORDER_NFE_JA_EXISTE',
      'Este pedido já tem NF-e: o endereço da nota é o que foi para o fisco e não muda mais.',
      409,
    );
  }

  if (contarMunicipios() === 0) {
    throw new ApiError(
      'CORE_ORDER_MUNICIPIOS_SEM_TABELA',
      'A tabela oficial de municípios do IBGE não está carregada: não há contra o que conferir o município. '
        + 'Carregue-a no servidor (node server/dist/scripts/carregar-municipios-ibge.js --baixar) e tente de novo.',
      409,
    );
  }

  const atual = destinatarioDoPedido(input.companyId, input.orderId);
  if (!atual) {
    throw new ApiError(
      'CORE_ORDER_RECIPIENT_MISSING',
      'O cliente não tem endereço cadastrado com os campos que a NF-e exige.',
      409,
    );
  }
  const uf = atual.recipient.uf.trim().toUpperCase();
  if (!CODIGO_DA_UF[uf]) {
    throw new ApiError(
      'CORE_ORDER_MUNICIPIO_SEM_UF',
      `O endereço da nota deste pedido está com a UF "${atual.recipient.uf}", que não é uma UF: sem ela o `
        + 'município não se confere.',
      409,
    );
  }
  const codigoAtual = digits(atual.recipient.cityIbge);
  if (codigoAtual.length === 7 && !municipioDaNotaQueNaoConfere(codigoAtual, uf, atual.recipient.cityName)) {
    throw new ApiError(
      'CORE_ORDER_MUNICIPIO_JA_CONFERE',
      `O município do endereço da nota deste pedido já confere com a tabela oficial do IBGE `
        + `(${atual.recipient.cityName}, código ${codigoAtual}): não há o que corrigir.`,
      409,
    );
  }

  const conferido = conferirMunicipio(codigo, uf);
  const achado = conferido.tabela === 'carregada' ? conferido.municipio : null;
  const daUf = conferido.tabela === 'carregada' && conferido.confere;
  /*
    A UF ERRADA COM O CÓDIGO CERTO (verificação do R3-IBGE). O banco da 84
    guardava o código do endereço conferindo só os 7 dígitos, e a UF só tinha
    de ter duas letras: cliente de Pelotas que marcou SC fica com o retrato
    "Pelotas / SC / 4314407". Só município de SC não o corrige nunca — ou
    inventa uma cidade de SC para a nota. A única saída de UF que se aceita é o
    município do PRÓPRIO código do cliente: a UF passa a ser a dele, e o
    histórico diz de qual para qual.
  */
  const oCodigoDoClienteEmOutraUf = !daUf && achado !== null && codigo === codigoAtual;
  if (!achado || (!daUf && !oCodigoDoClienteEmOutraUf)) {
    throw new ApiError(
      'CORE_ORDER_MUNICIPIO_NAO_CONFERE',
      `O endereço da nota é de ${uf}: ${porQueNaoConfere(codigo, uf, achado)}. Escolha um município de ${uf}.`,
      422,
      { uf },
    );
  }
  const para = achado;
  const agora = new Date().toISOString();
  const lado = NOME_DO_LADO[atual.lado];

  withTransaction(() => {
    if (atual.lado === 'billing') {
      db.prepare(
        `UPDATE core_orders SET billing_city = ?, billing_state = ?, billing_city_ibge = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(para.nome, para.uf, para.codigo, agora, input.orderId, input.companyId);
    } else if (atual.lado === 'shipping') {
      db.prepare(
        `UPDATE core_orders SET shipping_city = ?, shipping_state = ?, shipping_city_ibge = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(para.nome, para.uf, para.codigo, agora, input.orderId, input.companyId);
    } else {
      const r = atual.recipient;
      db.prepare(
        `UPDATE core_orders
            SET billing_address_id = ?, billing_name = ?, billing_zip = ?, billing_street = ?,
                billing_number = ?, billing_complement = ?, billing_district = ?, billing_city = ?,
                billing_state = ?, billing_city_ibge = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(
        atual.enderecoId,
        r.name,
        digits(r.zip) || null,
        r.street,
        r.number,
        r.complement ?? null,
        r.district,
        para.nome,
        para.uf,
        para.codigo,
        agora,
        input.orderId,
        input.companyId,
      );
    }
    addOrderEvent(
      input.orderId,
      input.companyId,
      order.status,
      `Município do endereço da nota corrigido pela gerência (${lado}): ${codigoAtual || 'sem código'} → `
        + `${para.codigo} (${para.nome}/${para.uf}).`
        + (para.uf !== uf
          ? ` A UF do endereço passou de ${uf} para ${para.uf}: o código ${codigoAtual} do cliente é de lá.`
          : ''),
      input.userId ?? undefined,
      'operador',
    );
  });

  return { lado, de: codigoAtual, para, ufDe: uf };
}
