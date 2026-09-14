/**
 * Como o pedido da loja chega ao cliente — e quanto isso custa DE VERDADE.
 *
 * EXISTE POR CAUSA DE DUAS FALHAS DE DINHEIRO NO MESMO TRECHO DO CHECKOUT
 *
 * 1. O frete vinha do CORPO DA REQUISIÇÃO (`input.shippingCents`), três linhas
 *    abaixo do comentário que garante que "o cliente não define valor". O
 *    preço do item era do servidor; o do frete, do navegador. Qualquer cliente
 *    podia mandar zero.
 *
 * 2. Ninguém escolhia entrega ou retirada, e nada era cobrado. Como
 *    `shipping_method` ficava nulo e nulo não é retirada, TODO pedido online
 *    nascia como "entrega" com frete R$ 0,00 — a operação pagava o envio de
 *    cada venda, e o valor não aparecia em lugar nenhum para ninguém perceber.
 *
 * AS TRÊS ORIGENS DE PREÇO, E POR QUE SIMULAÇÃO NÃO É UMA DELAS
 *
 *   `transportadora` — cotação real, com credencial. É o preço do
 *       transportador; o prazo também é dele.
 *   `tabela_da_loja` — frete fixo declarado pelo dono. É preço de gente, não
 *       estimativa de robô: pode ser cobrado hoje, sem credencial nenhuma.
 *   `retirada` — zero, porque não há envio.
 *
 * Quando não há credencial, o adapter devolve uma cotação SIMULADA. Aquele
 * número serve para o gestor ver a tela funcionando; cobrar por ele seria
 * inventar preço de transporte e descobrir a diferença depois, com a
 * mercadoria já despachada. Por isso simulação NUNCA vira opção de compra —
 * se não há transportadora conectada e o dono não declarou tabela, a loja
 * oferece retirada e diz que entrega está indisponível.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { backendLogisticsQuote } from '../logistics/LogisticsService.js';
import { buildOrderPackageFromItems, resolveOriginZip, normalizeZip } from './OrderShippingService.js';

/** Origem do preço. `simulacao` existe no tipo só para ser recusada. */
export type ShippingSource = 'retirada' | 'transportadora' | 'tabela_da_loja';

export interface CheckoutShippingOption {
  /** Chave que o cliente devolve na hora de fechar. */
  method: string;
  label: string;
  priceCents: number;
  /** Prazo em dias úteis. `null` quando ninguém sabe — melhor que um chute. */
  estimatedDays: number | null;
  source: ShippingSource;
}

export interface CheckoutShippingItem {
  productId: string;
  quantity: number;
}

export interface CheckoutShippingResult {
  options: CheckoutShippingOption[];
  /** Por que a entrega não está disponível, quando não está. */
  deliveryUnavailable: { code: string; message: string; missing?: unknown } | null;
}

export const METODO_RETIRADA = 'retirada';
export const PREFIXO_TRANSPORTADORA = 'transportadora:';
export const METODO_TABELA = 'tabela_da_loja';

interface ShippingSettingsRow {
  pickup_enabled: number;
  delivery_enabled: number;
  flat_rate_cents: number | null;
  free_above_cents: number | null;
  estimated_days: number | null;
}

/** A configuração da operação. Sem linha, o padrão é só retirada. */
export function getShippingSettings(companyId: string): ShippingSettingsRow {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT pickup_enabled, delivery_enabled, flat_rate_cents, free_above_cents, estimated_days
         FROM core_shipping_settings WHERE company_id = ?`,
    )
    .get(companyId) as ShippingSettingsRow | undefined;

  // Operação que nunca configurou entrega não entrega. O padrão precisa ser o
  // seguro: ligar entrega por omissão repetiria o frete grátis involuntário.
  return (
    linha ?? {
      pickup_enabled: 1,
      delivery_enabled: 0,
      flat_rate_cents: null,
      free_above_cents: null,
      estimated_days: null,
    }
  );
}

/** O maior prazo que a tabela da loja aceita: um ano de dias úteis já é engano. */
export const PRAZO_MAXIMO_EM_DIAS = 365;

export function saveShippingSettings(input: {
  companyId: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  flatRateCents?: number | null;
  freeAboveCents?: number | null;
  estimatedDays?: number | null;
}): void {
  ensureCoreSchema();

  if (input.deliveryEnabled && input.flatRateCents === null) {
    // Ligar entrega sem preço é voltar ao frete zero involuntário.
    throw new ApiError(
      'SHIPPING_FLAT_RATE_REQUIRED',
      'Para ligar a entrega é preciso informar o valor do frete da tabela da loja.',
      400,
    );
  }
  for (const [campo, valor] of [
    ['flatRateCents', input.flatRateCents],
    ['freeAboveCents', input.freeAboveCents],
  ] as const) {
    if (valor !== null && valor !== undefined && (!Number.isFinite(valor) || valor < 0)) {
      throw new ApiError('SHIPPING_INVALID_VALUE', `Valor inválido em ${campo}.`, 400);
    }
  }
  /*
    PRAZO É CONTAGEM DE DIAS ÚTEIS (GAP-PRD-195): inteiro, de zero a um ano.
    Negativo era gravado com 200 e a loja perdia o selo de prazo sem aviso (a
    vitrine e o portal tratam <= 0 como "sem prazo"); meio dia não existe em
    prazo de transportadora; texto não é número. Vazio (nulo) continua valendo:
    é "não sei", e a loja diz que o prazo é confirmado no envio.
  */
  const dias: unknown = input.estimatedDays;
  if (
    dias !== null
    && dias !== undefined
    && (typeof dias !== 'number' || !Number.isInteger(dias) || dias < 0 || dias > PRAZO_MAXIMO_EM_DIAS)
  ) {
    throw new ApiError(
      'SHIPPING_INVALID_DAYS',
      `Prazo de entrega inválido: informe um número inteiro de dias úteis, de 0 a ${PRAZO_MAXIMO_EM_DIAS}, ou deixe em branco.`,
      400,
    );
  }

  getConnection()
    .prepare(
      `INSERT INTO core_shipping_settings
         (company_id, pickup_enabled, delivery_enabled, flat_rate_cents,
          free_above_cents, estimated_days, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         pickup_enabled = excluded.pickup_enabled,
         delivery_enabled = excluded.delivery_enabled,
         flat_rate_cents = excluded.flat_rate_cents,
         free_above_cents = excluded.free_above_cents,
         estimated_days = excluded.estimated_days,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.companyId,
      input.pickupEnabled ? 1 : 0,
      input.deliveryEnabled ? 1 : 0,
      input.flatRateCents ?? null,
      input.freeAboveCents ?? null,
      input.estimatedDays ?? null,
      new Date().toISOString(),
    );
}

/**
 * As opções de entrega de um carrinho, com preço do SERVIDOR.
 *
 * É a única função autorizada a dizer quanto custa o frete. A rota chama, o
 * checkout recebe o resultado — o navegador nunca entra no meio.
 */
export async function listCheckoutShipping(input: {
  companyId: string;
  items: CheckoutShippingItem[];
  destinationZip?: string | null;
  itemsCents: number;
}): Promise<CheckoutShippingResult> {
  ensureCoreSchema();
  const config = getShippingSettings(input.companyId);
  const options: CheckoutShippingOption[] = [];

  if (config.pickup_enabled) {
    options.push({
      method: METODO_RETIRADA,
      label: 'Retirar na loja',
      priceCents: 0,
      estimatedDays: null,
      source: 'retirada',
    });
  }

  if (!config.delivery_enabled) {
    return {
      options,
      deliveryUnavailable: {
        code: 'DELIVERY_DISABLED',
        message: 'Esta loja ainda não entrega pelo site. A retirada continua disponível.',
      },
    };
  }

  const destino = normalizeZip(input.destinationZip);
  if (!destino) {
    return {
      options,
      deliveryUnavailable: {
        code: 'INVALID_ZIP',
        message: 'Informe um CEP de 8 dígitos para calcular a entrega.',
      },
    };
  }

  // Frete grátis acima de um valor é decisão do dono, e vale mesmo quando a
  // transportadora responderia mais caro: quem prometeu foi a loja.
  const gratis =
    config.free_above_cents !== null && input.itemsCents >= Number(config.free_above_cents);

  const pacote = buildOrderPackageFromItems({ companyId: input.companyId, items: input.items });
  const origem = resolveOriginZip(input.companyId);

  if (pacote.ok && origem) {
    const cotacao = await backendLogisticsQuote(input.companyId, {
      originZipCode: origem,
      destinationZipCode: destino,
      weightGrams: pacote.package.weightGrams,
      heightCm: pacote.package.heightCm,
      widthCm: pacote.package.widthCm,
      lengthCm: pacote.package.lengthCm,
      declaredValueInCents: pacote.package.declaredValueInCents,
    });

    // `simulated` é o adapter avisando que inventou o número. Cobrar por ele
    // seria vender transporte a preço de chute.
    for (const o of cotacao.options ?? []) {
      if (o.simulated || !Number.isFinite(o.priceInCents)) continue;
      options.push({
        method: `${PREFIXO_TRANSPORTADORA}${o.carrier}:${o.serviceCode}`,
        label: o.serviceName,
        priceCents: gratis ? 0 : Math.round(o.priceInCents),
        estimatedDays: Number.isFinite(o.estimatedDays) ? Number(o.estimatedDays) : null,
        source: 'transportadora',
      });
    }
  }

  const temTransportadora = options.some((o) => o.source === 'transportadora');
  if (!temTransportadora && config.flat_rate_cents !== null) {
    options.push({
      method: METODO_TABELA,
      label: 'Entrega pela loja',
      priceCents: gratis ? 0 : Math.round(Number(config.flat_rate_cents)),
      estimatedDays: config.estimated_days === null ? null : Number(config.estimated_days),
      source: 'tabela_da_loja',
    });
  }

  if (options.every((o) => o.source === 'retirada')) {
    return {
      options,
      deliveryUnavailable: {
        code: pacote.ok ? 'NO_CARRIER_AVAILABLE' : 'SHIPPING_DATA_REQUIRED',
        message: pacote.ok
          ? 'Nenhuma transportadora disponível para este CEP no momento.'
          : 'Faltam dados de embalagem nos produtos deste carrinho.',
        missing: pacote.ok ? undefined : pacote.missing,
      },
    };
  }

  return { options, deliveryUnavailable: null };
}

/**
 * A entrega de UMA loja dentro de um carrinho que tem várias.
 *
 * O nome da loja vai junto porque a recusa e a tela precisam dele: "a Me Mimei
 * não entrega pelo site" resolve; "a entrega não está disponível" manda o
 * cliente adivinhar qual dos dois itens tirar do carrinho.
 */
export interface FreteDaLoja extends CheckoutShippingResult {
  companyId: string;
  storeName: string;
  /** O valor dos itens DESTA loja — a base do frete grátis acima de X. */
  itemsCents: number;
}

/**
 * COTA CADA LOJA DO CARRINHO, SEPARADAMENTE.
 *
 * O checkout divide o carrinho por operação — "cada empresa tem seu próprio
 * faturamento, estoque e fulfillment". O frete não era dividido junto: a
 * cotação saía do pacote da PRIMEIRA loja, e o pedido da segunda nascia com o
 * método dela e R$ 0,00.
 *
 * São duas encomendas, de dois endereços, com dois pesos. Uma cotação só não
 * descreve nenhuma das duas — e o cliente pagava um frete para receber dois
 * pacotes, com a segunda operação despachando por conta dela.
 *
 * Cada loja é cotada com a origem, o peso e as dimensões DELA, e com o valor
 * dos itens DELA — senão o frete grátis acima de X de uma loja seria disparado
 * pela compra feita na outra.
 */
export async function listCheckoutShippingPorLoja(
  lojas: { companyId: string; storeName: string; items: CheckoutShippingItem[]; itemsCents: number }[],
  destinationZip?: string | null,
): Promise<FreteDaLoja[]> {
  const resultados: FreteDaLoja[] = [];
  for (const loja of lojas) {
    const r = await listCheckoutShipping({
      companyId: loja.companyId,
      items: loja.items,
      destinationZip,
      itemsCents: loja.itemsCents,
    });
    resultados.push({
      companyId: loja.companyId,
      storeName: loja.storeName,
      itemsCents: loja.itemsCents,
      ...r,
    });
  }
  return resultados;
}

/**
 * Resolve o método que o cliente escolheu contra as opções do SERVIDOR.
 *
 * O cliente devolve a chave, nunca o preço. Chave que não está na lista é
 * recusa — inclusive quando ela existia há um minuto e a cotação mudou.
 */
export async function resolveCheckoutShipping(input: {
  companyId: string;
  items: CheckoutShippingItem[];
  destinationZip?: string | null;
  itemsCents: number;
  method?: string | null;
  /**
   * O nome da loja, para a recusa dizer QUAL delas.
   *
   * Num carrinho de uma loja só, "esta loja" basta. Em dois, o cliente precisa
   * saber qual dos itens tirar ou qual seleção mudar — e sem o nome ele fica
   * olhando para uma mensagem que não aponta para nada.
   */
  storeName?: string | null;
}): Promise<CheckoutShippingOption> {
  const escolhido = String(input.method ?? '').trim() || METODO_RETIRADA;
  const { options, deliveryUnavailable } = await listCheckoutShipping(input);

  const achado = options.find((o) => o.method === escolhido);
  if (achado) return achado;

  const qualLoja = String(input.storeName ?? '').trim();
  const aLoja = qualLoja ? `A loja ${qualLoja}` : 'Esta loja';

  if (escolhido === METODO_RETIRADA) {
    throw new ApiError(
      'SHIPPING_PICKUP_DISABLED',
      `${aLoja} não está aceitando retirada no momento.`,
      400,
    );
  }

  throw new ApiError(
    'SHIPPING_OPTION_UNAVAILABLE',
    qualLoja
      ? `${aLoja}: ${deliveryUnavailable?.message ?? 'a forma de entrega escolhida não está mais disponível.'}`
      : (deliveryUnavailable?.message
        ?? 'A forma de entrega escolhida não está mais disponível. Calcule o frete de novo.'),
    400,
  );
}
