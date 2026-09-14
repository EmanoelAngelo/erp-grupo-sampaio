/**
 * Loja pública do Grupo Sampaio.
 *
 * Rotas SEM autenticação — é a vitrine. Por isso aqui só entra o que pode ser
 * público: produto publicado, preço vigente e disponibilidade. Custo, margem,
 * fornecedor e qualquer dado interno não trafegam nestes endpoints.
 */
import { Router } from 'express';
import { rotaPublica } from '../../middleware/auth.js';
import { ipDeOrigem } from '../../middleware/ipDeOrigem.js';
import { ApiError } from '../../utils/errors.js';
import { getConnection } from '../../db/sqlite.js';
import {
  cancelOrder,
  checkout,
  getStorefrontProduct,
  getStorefrontProductDetail,
  listCategories,
  listStorefrontProducts,
  listStoreIdentification,
  listStorefronts,
  PRODUTO_VISIVEL_NA_LOJA,
  type ResolvedShipping,
  type StorefrontSort,
} from '../../services/core/StorefrontService.js';
import { handlePaymentWebhook } from '../../services/core/PaymentService.js';
import { buscarMunicipios } from '../../services/core/MunicipiosIbge.js';
import { publicEquipmentByToken } from '../../services/core/EquipmentPublicView.js';
import {
  promessaDaRecuperacao,
  promessaDoCodigo,
  situacaoDoEnvio,
} from '../../services/notifications/PromessaDoEnvio.js';
import {
  listProductReviews,
  myReview,
  submitReview,
} from '../../services/core/ProductReviewService.js';
import { cancelOrderCharges, createOrderCharge } from '../../services/core/OrderChargeService.js';
import { lerParcelasDoCheckout } from '../../services/core/ParcelamentoNoCartao.js';
import {
  danfeDoPedidoParaCliente,
  devolucaoNoPortal,
  linkDeRastreio,
  notaFiscalNoPortal,
  solicitarDevolucao,
  xmlDoPedidoParaCliente,
} from '../../services/core/PosVendaDoPortal.js';
import { prepareProductQuote } from '../../services/core/OrderShippingService.js';
import { backendLogisticsQuote } from '../../services/logistics/LogisticsService.js';
import {
  METODO_RETIRADA,
  listCheckoutShippingPorLoja,
  resolveCheckoutShipping,
} from '../../services/core/CheckoutShippingService.js';
import { effectivePriceCents } from '../../services/core/PricingService.js';
import {
  carrinhoExigeConta,
  conferirEntregaDaConta,
  conferirVisitante,
  enderecoDoCheckout,
  faturamentoPadraoDaConta,
  modoDoCheckout,
  prepararComprador,
  type RetratoDoEndereco,
} from '../../services/core/CheckoutIdentityService.js';
import {
  addAddress,
  changePassword,
  getProfile,
  listAddresses,
  removeAddress,
  setDefaultAddress,
  updateAddress,
  updateProfile,
} from '../../services/core/CustomerAccountService.js';
import {
  getCustomerOrder,
  confirmarEmail,
  listCustomerOrders,
  loginCustomer,
  logoutCustomer,
  pedirRecuperacaoSenha,
  pedirVerificacaoEmail,
  redefinirSenhaComToken,
  exigirAceiteDosTermos,
  registerCustomerAccount,
  registerWithInvite,
  resolveCustomerSession,
  revogarOutrasSessoes,
  vincularPorDocumento,
} from '../../services/core/CustomerPortalService.js';
import {
  aceitarTermosDoGoogle,
  concluirLoginGoogle,
  desligarGoogle,
  googleNaConta,
  iniciarLoginGoogle,
} from '../../services/core/GoogleLoginService.js';
import { clienteRegistradoParaTeste, googleDisponivel } from '../../services/core/GoogleLoginConfigService.js';
import {
  consumirLimite,
  origemDaRequisicao,
  tetosDoPortal,
} from '../../services/core/PortalLimiteService.js';
import { simularCupom } from '../../services/core/CupomService.js';
import {
  acrescentarAoCarrinho,
  lerCarrinho,
  mesclarCarrinho,
  substituirCarrinho,
  tirarDoCarrinho,
} from '../../services/core/CarrinhoDaContaService.js';
import {
  autorizarNoProvedorDeTeste,
  conferirPedidoDeAutorizacao,
  paginaDeConsentimento,
  provedorDeTestePermitido,
  recusarNoProvedorDeTeste,
} from '../../services/core/ProvedorGoogleDeTeste.js';
import {
  abrirChamado,
  cancelarChamado,
  clienteDoConvite,
  decidirOrcamento,
  marcarConviteUsado,
  equipamentoDoDono,
  listarChamadosDaConta,
  listarEquipamentosDoDono,
  resgatarConvite,
} from '../../services/core/EquipmentPortalService.js';

export const storefrontRouter = Router();

/** Portal: as lojas do grupo e a Oficina como serviço. */
/**
 * Identificação legal do fornecedor (Decreto 7.962/2013) — razão social,
 * CNPJ e endereço de cada loja, para o rodapé e as páginas de política.
 * Público porque a LEI manda mostrar; enxuto porque só isso é público.
 */
storefrontRouter.get('/identificacao', rotaPublica('identificação legal do fornecedor: o Decreto 7.962 manda expor razão social, CNPJ e endereço a quem navega'), (_req, res, next) => {
  try {
    res.json({ stores: listStoreIdentification() });
  } catch (err) {
    next(err);
  }
});
storefrontRouter.get('/stores', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (_req, res, next) => {
  try {
    res.json(listStorefronts());
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/products', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (req, res, next) => {
  try {
    // Devolve { items, total }: o total é o que a tela precisa para numerar
    // "1–12 de 48" e saber se há próxima página.
    res.json(
      listStorefrontProducts({
        storeSlug: req.query.store as string | undefined,
        search: req.query.q as string | undefined,
        category: req.query.category as string | undefined,
        // O GALHO é filtro separado do DEPARTAMENTO (rodada 56): clicar em
        // "Vestuário" traz camisas e calças; clicar em "Camisas" traz só as
        // camisas.
        subcategory: req.query.subcategory as string | undefined,
        // A faixa chega em REAIS na URL, porque é o que o cliente digita; o
        // serviço trabalha em centavos, como o resto do sistema.
        minPriceCents: req.query.min ? Math.round(Number(req.query.min) * 100) : undefined,
        maxPriceCents: req.query.max ? Math.round(Number(req.query.max) * 100) : undefined,
        sort: req.query.sort as StorefrontSort | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Só o que está em promoção vigente — a seção de ofertas da home. */
storefrontRouter.get('/ofertas', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (req, res, next) => {
  try {
    const { items } = listStorefrontProducts({
      storeSlug: req.query.store as string | undefined,
      onlyOnSale: true,
      limit: req.query.limit ? Number(req.query.limit) : 12,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/** Só os destaques — o carrossel do topo da vitrine. */
storefrontRouter.get('/destaques', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (req, res, next) => {
  try {
    const { items } = listStorefrontProducts({
      storeSlug: req.query.store as string | undefined,
      onlyFeatured: true,
      limit: req.query.limit ? Number(req.query.limit) : 12,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/categories', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (req, res, next) => {
  try {
    res.json({ items: listCategories(req.query.store as string | undefined) });
  } catch (err) {
    next(err);
  }
});

/*
  OS MUNICÍPIOS DO IBGE (IBGE-MUNICIPIOS). O formulário do endereço — Minha
  conta, o checkout e o cadastro fiscal do emitente — acha a cidade pelo nome
  e leva o código IBGE junto: o cliente nunca digita o código. Sem acento e
  sem caixa, dentro da UF, no máximo 20. `carregada` diz se a tabela oficial
  já foi carregada pelo dono (`scripts/carregar-municipios-ibge`); vazia, a
  tela volta ao campo digitado. Dado público, sob o limite de taxa global.
*/
storefrontRouter.get('/municipios', rotaPublica('busca pública de municípios do IBGE: o formulário do endereço acha a cidade pelo nome antes de haver conta ou sessão — dado público, até 20 por busca'), (req, res, next) => {
  try {
    res.json(buscarMunicipios({ uf: req.query.uf, q: req.query.q }));
  } catch (err) {
    next(err);
  }
});

/**
 * Página pública de um produto.
 *
 * A loja vai na URL e é conferida no servidor. Produto de outra operação não
 * existe aqui: sem essa checagem, a URL da Gringa serviria item do Preço Justo
 * e a página anunciaria a loja errada como vendedora.
 */
storefrontRouter.get('/stores/:storeSlug/products/:id', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (req, res, next) => {
  try {
    const product = getStorefrontProductDetail(
      String(req.params.storeSlug),
      String(req.params.id),
    );
    if (!product) {
      throw new ApiError(
        'CORE_PRODUCT_NOT_FOUND',
        'Produto não encontrado nesta loja.',
        404,
      );
    }
    res.json(product);
  } catch (err) {
    next(err);
  }
});

/**
 * Simulação de frete de um produto.
 *
 * É ESTIMATIVA e a resposta diz isso. O frete que vale é o do checkout, sobre
 * o carrinho fechado: aqui o cliente só descobre se compensa comprar.
 *
 * Nada vai ao provedor antes de existirem CEP de origem, CEP de destino e as
 * quatro medidas — a alternativa seria cotar uma caixa imaginária.
 */
storefrontRouter.post('/stores/:storeSlug/products/:id/shipping-quote', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), async (req, res, next) => {
  try {
    // Sem a prateleira ao lado: esta rota roda a cada CEP digitado e usa duas
    // linhas da resposta.
    const produto = getStorefrontProductDetail(
      String(req.params.storeSlug),
      String(req.params.id),
      false,
    );
    if (!produto) {
      throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado nesta loja.', 404);
    }

    const preparo = prepareProductQuote({
      companyId: produto.companyId,
      productId: produto.id,
      destinationZip: String(req.body?.zip ?? ''),
    });

    if (!preparo.ok) {
      res.json({ estimate: true, options: [], code: preparo.code, missing: preparo.missing });
      return;
    }

    const cotacao = await backendLogisticsQuote(produto.companyId, {
      originZipCode: preparo.originZip,
      destinationZipCode: preparo.destinationZip,
      weightGrams: preparo.package.weightGrams,
      heightCm: preparo.package.heightCm,
      widthCm: preparo.package.widthCm,
      lengthCm: preparo.package.lengthCm,
      declaredValueInCents: preparo.package.declaredValueInCents,
    });

    res.json({
      // A tela precisa saber que é estimativa e que pode ser simulação.
      estimate: true,
      options: cotacao.options ?? [],
      simulated: 'simulated' in cotacao ? cotacao.simulated : true,
      real: 'real' in cotacao ? cotacao.real : false,
      code: 'code' in cotacao ? cotacao.code : undefined,
      missing: 'missing' in cotacao ? cotacao.missing : undefined,
      message: cotacao.message,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * O carrinho, visto pelo servidor: operação dona e valor real das mercadorias.
 *
 * O valor sai de `effectivePriceCents` — o mesmo do balcão e o mesmo que o
 * checkout vai usar. Somar aqui pelo preço que o navegador mandou faria o
 * "frete grátis acima de X" disparar com um X que o cliente escolheu.
 */
/**
 * O ITEM DO CARRINHO, COM O PREÇO DE AGORA.
 *
 * O carrinho vive no `localStorage` do navegador com o produto inteiro
 * congelado dentro — nome, preço, disponível. É o que faz ele sobreviver a
 * um refresh, e é o que faz o cliente que deixou a aba aberta desde ontem
 * continuar vendo o preço da promoção que já acabou.
 *
 * O `checkout` reprecifica tudo pelo banco, então o pedido nasce certo e a
 * cobrança sai no valor certo — outro valor, o que o cliente nunca viu.
 *
 * Esta cotação já pergunta ao banco o preço de cada item (é dele que sai o
 * `itemsCents` de cada loja) e jogava o número fora. Devolvê-lo custa zero
 * consulta a mais e é o que permite a tela mostrar, ANTES do clique, o
 * mesmo número que vai ser cobrado.
 */
interface ItemRevalidado {
  productId: string;
  companyId: string;
  name: string;
  quantity: number;
  priceCents: number;
  /** Saldo vendável AGORA: o que sobrou depois do que vendeu no intervalo. */
  available: number;
  /**
   * O preço está abaixo do cadastro (promoção)? O cupom não cumulativo
   * (GAP-PRD-123) não alcança esta linha — a simulação precisa saber.
   */
  onSale: boolean;
}

interface LojaDoCarrinho {
  companyId: string;
  storeName: string;
  itemsCents: number;
  items: { productId: string; quantity: number }[];
}

/**
 * O CARRINHO, DIVIDIDO POR LOJA — todas elas.
 *
 * Isto lia SÓ A PRIMEIRA operação:
 *
 *     companyId ??= p.company_id;
 *     if (p.company_id !== companyId) continue;
 *
 * com o comentário "o frete é do pacote que sai de UMA operação; carrinho com
 * duas lojas vira dois pedidos, e o envio do primeiro é o que se cota aqui".
 *
 * A primeira metade da frase está certa e a segunda é o defeito: são DUAS
 * encomendas, de dois endereços, com dois pesos — e o cliente pagava uma só. O
 * pedido da segunda loja nascia com o método da primeira e R$ 0,00 de frete,
 * de modo que a operação despachava por conta dela e o prazo prometido vinha de
 * uma cotação que nunca foi feita para aquele pacote.
 *
 * A divisão aqui é a MESMA que o `checkout` faz — por `company_id` do produto.
 */
function dividirCarrinho(
  items: { productId: string; quantity: number }[],
  revalidados?: ItemRevalidado[],
): LojaDoCarrinho[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('CORE_ORDER_EMPTY', 'Carrinho sem itens.', 400);
  }
  const db = getConnection();
  const porLoja = new Map<string, LojaDoCarrinho>();

  for (const item of items) {
    // A MESMA condição do checkout, e por isso importada dele em vez de
    // reescrita: a cotação de frete roda ANTES do fechamento e não pode ter uma
    // opinião própria sobre o que está à venda. Divergir aqui faria a loja cotar
    // entrega de um item que o checkout recusa em seguida.
    const p = db
      .prepare(
        `SELECT p.id, p.company_id, p.name, p.price_cents, p.category,
                COALESCE(c.trade_name, c.legal_name) AS store_name,
                COALESCE(s.quantity, 0) - COALESCE(s.reserved, 0) AS available
           FROM core_products p
           JOIN core_companies c ON c.id = p.company_id
           LEFT JOIN core_stock s
                  ON s.company_id = p.company_id AND s.product_id = p.id
          WHERE p.id = ? AND ${PRODUTO_VISIVEL_NA_LOJA}`,
      )
      .get(String(item.productId)) as
      | {
          id: string;
          company_id: string;
          name: string;
          price_cents: number;
          category: string | null;
          store_name: string;
          available: number;
        }
      | undefined;
    if (!p) {
      // Produto fora da loja é 404, como sempre foi. Engolir aqui e devolver
      // "carrinho vazio" esconderia do cliente qual item saiu de linha.
      // Mesmo código que o `checkout` usa — E COM OS MESMOS DETAILS: esta
      // recusa roda ANTES da do serviço (o frete é resolvido primeiro) e é a
      // que o cliente de fato recebe. Sem o productId no envelope, um carrinho
      // de oito itens não tinha como marcar o item morto na tela — a promessa
      // do parágrafo acima ("qual item saiu de linha") ficava só no comentário.
      throw new ApiError(
        'CORE_PRODUCT_NOT_AVAILABLE',
        'Produto não está disponível na loja.',
        404,
        { productId: String(item.productId) },
      );
    }
    // Nulo de propósito na tabela de preço: a cotação de frete é da vitrine
    // pública, onde não há cliente identificado para ter tabela. A doutrina
    // inteira está em `SEM_TABELA_NA_VITRINE`, no StorefrontService.
    // A linha INTEIRA disputa o estoque promocional (GAP-PRD-194), como no
    // checkout — senão a gaveta mostraria o preço da promoção para 5 unidades
    // quando só restam 3, e o fechamento cobraria outro.
    const { priceCents, onSale } = effectivePriceCents(
      p.company_id,
      p.id,
      p.price_cents,
      p.category,
      { priceTableId: null, unidadesDaLinha: Number(item.quantity) },
    );

    const atual = porLoja.get(p.company_id) ?? {
      companyId: p.company_id,
      storeName: p.store_name,
      itemsCents: 0,
      items: [],
    };
    atual.itemsCents += Math.round(priceCents * Number(item.quantity));
    atual.items.push({ productId: p.id, quantity: Number(item.quantity) });
    porLoja.set(p.company_id, atual);

    // O preço que acabou de sair do banco, para quem quiser devolvê-lo à
      // tela em vez de deixá-la mostrar o que congelou ontem.
    revalidados?.push({
      productId: p.id,
      companyId: p.company_id,
      name: p.name,
      quantity: Number(item.quantity),
      priceCents,
      available: Math.max(0, Number(p.available ?? 0)),
      onSale,
    });
  }

  if (porLoja.size === 0) {
    throw new ApiError('CORE_ORDER_EMPTY', 'Nenhum item do carrinho está à venda.', 400);
  }
  return [...porLoja.values()];
}

/**
 * As formas de entrega de um carrinho, com preço do servidor — UMA POR LOJA.
 *
 * Antes devolvia uma lista só, cotada no pacote da primeira operação. Carrinho
 * de duas lojas são duas encomendas, de dois endereços, com dois pesos: uma
 * cotação não descreve nenhuma das duas.
 *
 * `options` e `deliveryUnavailable` continuam no topo, apontando para a
 * PRIMEIRA loja, porque é isso que a tela antiga lê — e um carrinho de uma
 * loja só, que é o caso comum, tem exatamente o mesmo formato de antes.
 */
storefrontRouter.post('/checkout/frete', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), async (req, res, next) => {
  try {
    const itens: ItemRevalidado[] = [];
    const lojas = await listCheckoutShippingPorLoja(
      dividirCarrinho(req.body?.items ?? [], itens),
      req.body?.zip,
    );
    res.json({
      /*
        CADA LOJA DIZ SE EXIGE CONTA (GAP-PRD-028). A tela pede o login ANTES
        de o cliente preencher tudo — e o servidor recusa de novo no
        fechamento, que é quem decide.
      */
      lojas: lojas.map((l) => ({ ...l, exigeConta: modoDoCheckout(l.companyId) === 'conta' })),
      exigeConta: carrinhoExigeConta(lojas.map((l) => l.companyId)),
      /*
        O CARRINHO DESCONGELADO. Cada item com preço, nome e disponível do
        BANCO, no instante em que o cliente está olhando a gaveta. É o
        mesmo número que o checkout vai cobrar — e a tela adota este, em
        vez do que guardou no navegador.
      */
      itens,
      options: lojas[0]?.options ?? [],
      deliveryUnavailable: lojas[0]?.deliveryUnavailable ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * "Aplicar cupom" na gaveta do carrinho (GAP-PRD-123).
 *
 * O MESMO cálculo do checkout — preço do banco, promoção, rateio —, sem
 * gravar nada: a tela mostra o desconto de cada loja e o total ANTES do
 * clique. O checkout confere de novo (entre um e outro o cupom pode esgotar).
 *
 * Com sessão do portal, o limite "uma vez por cliente" é conferido pela conta;
 * o visitante pode mandar o e-mail que vai usar. O teto de cupons errados por
 * origem vale aqui como no checkout: só o código que não existe conta.
 */
storefrontRouter.post('/checkout/cupom', rotaPublica('vitrine pública da loja: o cupom é simulado antes do login, e o teto de códigos errados por origem protege os cupons de uso único'), (req, res, next) => {
  try {
    const origem = origemDaRequisicao(req);
    const teto = tetosDoPortal().cuponsErradosPorOrigemHora;
    consumirLimite({ acao: 'cupom', origem, maximo: teto, registrar: false });

    const token = portalToken(req);
    const sessao = token ? resolveCustomerSession(token) : null;
    const itens: ItemRevalidado[] = [];
    const lojas = dividirCarrinho(req.body?.items ?? [], itens);
    try {
      res.json(
        simularCupom({
          code: req.body?.code,
          lojas: lojas.map((l) => ({
            companyId: l.companyId,
            storeName: l.storeName,
            linhas: itens
              .filter((i) => i.companyId === l.companyId)
              .map((i) => ({
                productId: i.productId,
                totalCents: Math.round(i.priceCents * i.quantity),
                emPromocao: i.onSale,
              })),
          })),
          quem: sessao
            ? { accountId: sessao.account.id, email: sessao.account.email }
            : { email: typeof req.body?.customerEmail === 'string' ? req.body.customerEmail : null },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHECKOUT_CUPOM_INVALIDO') {
        consumirLimite({ acao: 'cupom', origem, maximo: teto });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Resolve o frete do carrinho para o checkout.
 *
 * Entrega EXIGE endereço. Sem isso o pedido nasce com CEP e nada mais, e a
 * separação descobre que não tem para onde mandar depois de já ter cobrado.
 */
async function resolverFretesDoCarrinho(input: {
  items: { productId: string; quantity: number }[];
  zip?: string;
  /** A escolha por loja. É esta a forma correta. */
  methods?: Record<string, string>;
  /**
   * A escolha ÚNICA, do formato antigo da rota.
   *
   * Continua aceita e passou a valer para cada loja SEPARADAMENTE: a mesma
   * chave é resolvida contra as opções de cada uma, e cada pedido cobra o
   * preço dela. Antes, a chave carregava o preço da primeira para todas — que
   * é o defeito. Loja que não oferece aquele método recusa dizendo o nome.
   */
  method?: string;
  address?: string;
  /**
   * Quem compra tem CONTA (GAP-PRD-028): a loja que entrega exige o endereço
   * SALVO da conta (`enderecoSalvo`), completo — o texto solto não vale.
   */
  comConta?: boolean;
  enderecoSalvo?: RetratoDoEndereco | null;
}): Promise<Record<string, ResolvedShipping>> {
  const lojas = dividirCarrinho(input.items);
  const porEmpresa: Record<string, ResolvedShipping> = {};
  /** A chave PEDIDA para a loja — vazia é retirada, como na cotação. */
  const metodoPedido = (companyId: string): string =>
    String(input.methods?.[companyId] ?? input.method ?? '').trim() || METODO_RETIRADA;

  // Com conta, entregar é para um endereço salvo e completo (rua, número,
  // bairro, cidade, UF, CEP e IBGE) — conferido ANTES de cotar qualquer loja
  // (GAP-PRD-028, verificação): depois da cotação, o texto solto sem CEP saía
  // como "informe um CEP" (o código genérico), e o frete de um pedido que
  // seria recusado já tinha ido ao provedor.
  if (input.comConta && lojas.some((loja) => metodoPedido(loja.companyId) !== METODO_RETIRADA)) {
    conferirEntregaDaConta(input.enderecoSalvo ?? null);
  }

  for (const loja of lojas) {
    const escolhido = await resolveCheckoutShipping({
      companyId: loja.companyId,
      storeName: loja.storeName,
      items: loja.items,
      destinationZip: input.zip,
      itemsCents: loja.itemsCents,
      method: metodoPedido(loja.companyId),
    });

    if (escolhido.method !== METODO_RETIRADA && !String(input.address ?? '').trim()) {
      throw new ApiError(
        'CORE_SHIPPING_ADDRESS_REQUIRED',
        'Para entrega é preciso informar o endereço completo.',
        400,
      );
    }

    porEmpresa[loja.companyId] = {
      method: escolhido.method,
      label: escolhido.label,
      priceCents: escolhido.priceCents,
      estimatedDays: escolhido.estimatedDays,
      // Só cotação de transportadora vira promessa de data ao cliente.
      real: escolhido.source === 'transportadora',
    };
  }

  return porEmpresa;
}

storefrontRouter.get('/products/:id', rotaPublica('vitrine pública da loja: quem navega e compra ainda não tem conta nem sessão'), (req, res, next) => {
  try {
    const product = getStorefrontProduct(String(req.params.id));
    if (!product) {
      throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
    }
    res.json(product);
  } catch (err) {
    next(err);
  }
});

/**
 * Fecha o carrinho. Devolve um pedido por operação, porque cada empresa tem
 * seu próprio faturamento, estoque e fulfillment.
 */
storefrontRouter.post('/checkout', rotaPublica('checkout da vitrine: a sessão do portal (x-portal-token) é conferida dentro do handler — a loja exige conta por padrão e só aceita visitante se o dono ligou; preço e frete são do servidor'), async (req, res, next) => {
  try {
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    if (!idempotencyKey) {
      throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key é obrigatório.', 400);
    }

    const itens = (req.body?.items ?? []) as { productId: string; quantity: number }[];

    /*
      QUEM ESTÁ COMPRANDO (GAP-PRD-006/028/043).

      A rota era pública e não lia a sessão do portal: o cliente logado
      comprava como visitante, o pedido não ia para a conta dele, e o CPF
      digitado achava (e reescrevia) o cadastro de quem fosse. Agora:

        - token enviado e inválido/vencido → 401, e não "vira visitante": o
          pedido sumiria da conta de quem acha que está logado;
        - sem sessão, basta UMA loja do carrinho exigir conta (o padrão)
          para recusar — antes de reservar qualquer coisa;
        - com sessão, a conta é conferida (e-mail provado, cadastro
          completo) e o pedido nasce dela.
    */
    const token = portalToken(req);
    const sessao = token ? resolveCustomerSession(token) : null;
    if (token && !sessao) {
      throw new ApiError(
        'PORTAL_UNAUTHENTICATED',
        'Sua sessão expirou. Entre de novo na sua conta para finalizar — o carrinho continua aqui.',
        401,
      );
    }
    if (!sessao) {
      const lojas = dividirCarrinho(itens);
      if (carrinhoExigeConta(lojas.map((l) => l.companyId))) {
        throw new ApiError(
          'CHECKOUT_CONTA_OBRIGATORIA',
          'Para comprar nesta loja, entre na sua conta ou crie uma — o carrinho continua aqui.',
          401,
          { lojas: lojas.map((l) => ({ companyId: l.companyId, storeName: l.storeName })) },
        );
      }
    }
    const comprador = sessao
      ? prepararComprador(sessao.account.id, {
          name: req.body?.customerName,
          phone: req.body?.customerPhone,
          document: req.body?.customerDocument,
        })
      : undefined;
    /*
      O VISITANTE É CONFERIDO ANTES DE TUDO (GAP-PRD-191): CPF/CNPJ com dígito
      verificador e e-mail válido, antes de cotar frete, reservar estoque ou
      numerar pedido. Sem isso nascia pedido com cobrança `failed` e 25 h de
      estoque preso.
    */
    const visitante = sessao
      ? undefined
      : conferirVisitante({
          name: req.body?.customerName,
          document: req.body?.customerDocument,
          email: req.body?.customerEmail,
          phone: req.body?.customerPhone,
        });

    /*
      O ENDEREÇO SALVO DA CONTA. Com `shippingAddressId`, o endereço e o CEP
      do pedido saem do cadastro da conta — não do texto digitado — e o frete
      é cotado para esse CEP. O pedido guarda a cópia.

      Com conta e alguma loja ENTREGANDO, o endereço salvo é OBRIGATÓRIO e
      precisa estar completo, com IBGE (GAP-PRD-028, reauditoria): o texto
      solto sem `shippingAddressId` era aceito — só a tela obrigava. A recusa
      sai de `resolverFretesDoCarrinho` antes de cotar o frete de qualquer
      loja, reservar estoque ou emitir cobrança. O texto digitado ficou só
      para o visitante.
    */
    let shippingAddress: string | undefined = req.body?.shippingAddress;
    let shippingZip: string | undefined = req.body?.shippingZip;
    let enderecoDeEntrega: RetratoDoEndereco | null = null;
    if (req.body?.shippingAddressId) {
      if (!sessao) {
        throw new ApiError('PORTAL_UNAUTHENTICATED', 'Entre na sua conta para usar um endereço salvo.', 401);
      }
      enderecoDeEntrega = enderecoDoCheckout(sessao.account.id, String(req.body.shippingAddressId), 'entrega');
      shippingAddress = enderecoDeEntrega.texto;
      shippingZip = enderecoDeEntrega.zip;
    }
    /*
      O ENDEREÇO DE FATURAMENTO (GAP-PRD-115): o que vai na nota, com IBGE.
      Escolhido (`billingAddressId`) ou, na falta, o de entrega se ele também
      fatura, ou o de faturamento da conta. O pedido guarda o retrato dos
      dois, e a NF-e do pedido lê o retrato — não o endereço vivo.
    */
    let enderecoDeFaturamento: RetratoDoEndereco | null = null;
    if (req.body?.billingAddressId) {
      if (!sessao) {
        throw new ApiError('PORTAL_UNAUTHENTICATED', 'Entre na sua conta para usar um endereço salvo.', 401);
      }
      enderecoDeFaturamento = enderecoDoCheckout(
        sessao.account.id,
        String(req.body.billingAddressId),
        'faturamento',
      );
    } else if (sessao) {
      enderecoDeFaturamento = faturamentoPadraoDaConta(sessao.account.id, enderecoDeEntrega);
    }

    /**
     * O FRETE É COTADO AQUI, NO SERVIDOR.
     *
     * `req.body.shippingCents` não é lido — nem para conferir. O navegador
     * manda só a CHAVE da opção escolhida; o preço sai de
     * `resolveCheckoutShipping`, que recusa cotação simulada e só aceita
     * cotação real de transportadora ou a tabela declarada pelo dono.
     *
     * A cotação é do carrinho inteiro, na operação do primeiro item: é assim
     * que a encomenda sai, num pacote só.
     */
    const shippingPorEmpresa = await resolverFretesDoCarrinho({
      items: itens,
      zip: shippingZip,
      methods: req.body?.shippingMethods,
      method: req.body?.shippingMethod,
      address: shippingAddress,
      comConta: Boolean(sessao),
      enderecoSalvo: enderecoDeEntrega,
    });

    /*
      O CUPOM (GAP-PRD-123). A porta confere o teto de cupons ERRADOS desta
      origem antes de olhar o código, e conta a passagem só quando o código não
      vale em loja nenhuma — quem varre códigos para no 21º erro da hora; quem
      acerta o cupom da campanha não gasta vaga de ninguém.
    */
    const couponCode =
      typeof req.body?.couponCode === 'string' && req.body.couponCode.trim()
        ? req.body.couponCode
        : undefined;
    const origem = origemDaRequisicao(req);
    const tetoDeCupom = tetosDoPortal().cuponsErradosPorOrigemHora;
    if (couponCode) {
      consumirLimite({ acao: 'cupom', origem, maximo: tetoDeCupom, registrar: false });
    }

    // pix, boleto ou cartao — qualquer outra coisa vira pix, o método mais
    // universal. O cartão é pago na página do provedor: o ERP nunca vê o número.
    // Calculado ANTES do checkout: as parcelas dependem dele.
    const pedidoMetodo = String(req.body?.paymentMethod ?? 'pix');
    const method =
      pedidoMetodo === 'boleto' ? 'boleto' : pedidoMetodo === 'cartao' ? 'cartao' : 'pix';

    // Parcelas no cartão (GAP-PRD-114): lidas e recusadas ANTES do pedido
    // nascer. O teto de cada loja e a parcela mínima são conferidos dentro do
    // checkout, na mesma transação que cria os pedidos.
    const installments = lerParcelasDoCheckout(req.body?.installments, method);

    let orders;
    try {
      orders = checkout({
        idempotencyKey,
        customerName: visitante?.name ?? String(req.body?.customerName ?? ''),
        customerEmail: visitante ? visitante.email : req.body?.customerEmail,
        customerDocument: visitante ? visitante.document : req.body?.customerDocument,
        customerPhone: req.body?.customerPhone,
        shippingZip,
        shippingAddress,
        shippingPorEmpresa,
        paymentMethod: String(req.body?.paymentMethod ?? 'pix'),
        installments,
        items: itens,
        comprador,
        enderecoDeEntrega,
        enderecoDeFaturamento,
        couponCode,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHECKOUT_CUPOM_INVALIDO') {
        consumirLimite({ acao: 'cupom', origem, maximo: tetoDeCupom });
      }
      throw err;
    }

    // UMA COBRANÇA POR PEDIDO, na conta da operação dona dele. Carrinho com
    // duas empresas gera duas cobranças separadas — nunca uma só somando o
    // faturamento de CNPJs diferentes.
    //
    // Falha de cobrança NÃO desfaz o pedido: o pedido existe, o estoque está
    // reservado, e o comprador pode tentar pagar de novo. Perder o pedido
    // porque o provedor oscilou seria trocar um problema pequeno por um
    // grande.
    // O que foi comprado sai do carrinho da CONTA (GAP-PRD-193) — o outro
    // aparelho não pode continuar mostrando o que já virou pedido.
    if (sessao) tirarDoCarrinho(sessao.account.id, itens.map((i) => String(i.productId)));

    const charges = [];
    for (const order of orders) {
      try {
        charges.push(
          await createOrderCharge({
            companyId: order.company_id,
            orderId: order.id,
            method,
            installments,
          }),
        );
      } catch (err) {
        charges.push({ orderId: order.id, failed: true, reason: (err as Error).message });
      }
    }

    res.status(201).json({
      orders,
      payments: charges.map((c) =>
        'failed' in c
          ? { orderId: c.orderId, status: 'failed', detail: c.reason }
          : {
              orderId: c.intent.origin_id,
              method: c.intent.method,
              // Em quantas vezes a cobrança foi ao provedor (GAP-PRD-114).
              installments: c.intent.installment_count ?? 1,
              // "pending" é o certo aqui: mostrar o QR não é receber.
              status: c.status,
              environment: c.environment,
              pixPayload: c.pixPayload,
              pixImageBase64: c.pixImageBase64,
              bankSlipUrl: c.bankSlipUrl,
              identificationField: c.identificationField,
              dueDate: c.dueDate,
              // Até quando os itens são deste pedido (GAP-PRD-029): no boleto,
              // passa do vencimento — o banco ainda precisa confirmar.
              reservedUntil: c.reservedUntil,
              invoiceUrl: c.intent.invoice_url,
            },
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- portal do cliente
//
// Sessão SEPARADA da administrativa. O token vem no header próprio e é
// resolvido por consulta: conhecer o id de um pedido nunca dá acesso a ele.

/** Token do portal — header próprio, para não se confundir com o do ERP. */
function portalToken(req: { headers: Record<string, unknown> }): string | undefined {
  const bruto = req.headers['x-portal-token'];
  return typeof bruto === 'string' && bruto.length > 0 ? bruto : undefined;
}

function exigirCliente(req: { headers: Record<string, unknown> }) {
  const sessao = resolveCustomerSession(portalToken(req));
  if (!sessao) {
    throw new ApiError('PORTAL_UNAUTHENTICATED', 'Entre na sua conta para continuar.', 401);
  }
  return sessao;
}

storefrontRouter.post('/portal/registrar', rotaPublica('portal do cliente: cria/abre a conta do comprador — quando esta rota roda, não existe sessão'), async (req, res, next) => {
  try {
    // O consentimento é o PRIMEIRO portão: antes de resolver convite,
    // antes de qualquer efeito. Os serviços validam de novo (defesa em
    // profundidade para quem os chama direto).
    exigirAceiteDosTermos(req.body?.termsAccepted);
    /*
      Dois caminhos para a mesma porta, e a diferença é a PROVA.

      Sem código: e-mail + documento no mesmo cadastro — quem comprou no site
      prova assim, e é o caminho que já existia.

      Com código: o convite entregue no balcão. Existe porque o cliente de
      oficina é cadastrado com nome e telefone, sem e-mail, e nunca passaria
      pela primeira prova. Este caminho liga UM cadastro — o do convite — e
      nunca chama `syncLinks`, que casaria pelo e-mail escolhido por quem
      resgatou.
    */
    const codigo = String(req.body?.code ?? '').trim();
    if (codigo) {
      const convite = clienteDoConvite(codigo);
      const sessao = await registerWithInvite({
        // O valor CRU: o serviço é quem decide o que é aceite de verdade.
        termsAccepted: req.body?.termsAccepted,
        email: String(req.body?.email ?? ''),
        password: String(req.body?.password ?? ''),
        customerId: convite.customerId,
        companyId: convite.companyId,
        name: req.body?.name,
        nomeDoCadastro: convite.name,
        origem: origemDaRequisicao(req),
      });
      marcarConviteUsado(convite.customerId);
      res.status(201).json(sessao);
      return;
    }

    res.status(201).json(
      await registerCustomerAccount({
        termsAccepted: req.body?.termsAccepted,
        email: String(req.body?.email ?? ''),
        document: String(req.body?.document ?? ''),
        password: String(req.body?.password ?? ''),
        // O nome nasce na conta (GAP-PRD-192); a origem conta no teto.
        name: req.body?.name,
        origem: origemDaRequisicao(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/entrar', rotaPublica('portal do cliente: cria/abre a conta do comprador — quando esta rota roda, não existe sessão'), async (req, res, next) => {
  try {
    res.json(
      await loginCustomer({
        email: String(req.body?.email ?? ''),
        password: String(req.body?.password ?? ''),
        // A origem do bloqueio por par (GAP-PRD-074): socket sem proxy
        // declarado; atrás do proxy, o endereço que ele acrescentou.
        ip: ipDeOrigem(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/sair', rotaPublica('portal do cliente: encerra a sessão do x-portal-token enviado; sem token é inofensiva'), (req, res) => {
  // Encerra só a sessão do portal: carrinho, pedidos e cadastro seguem.
  logoutCustomer(portalToken(req));
  res.status(204).end();
});

/*
  A verificação do e-mail (rodada 50). O código de 6 dígitos chega na caixa
  de entrada e volta por aqui — é a prova de que o e-mail tem dono. É esta
  prova que destrava puxar pedidos por documento digitado: sem ela, e-mail
  alheio + CPF alheio entregavam o histórico de compras de outra pessoa.
*/
storefrontRouter.post('/portal/verificar-email', rotaPublica('portal do cliente: o x-portal-token é a credencial, e o código prova a caixa de entrada'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    confirmarEmail({
      accountId: sessao.account.id,
      codigo: String(req.body?.code ?? ''),
      // A origem do bloqueio por par (GAP-PRD-074): socket sem proxy
      // declarado; atrás do proxy, o endereço que ele acrescentou.
      ip: ipDeOrigem(req),
    });
    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/reenviar-verificacao', rotaPublica('portal do cliente: o x-portal-token é a credencial; reenvio com teto por hora'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    // "Código novo enviado" só quando o envio está ligado (GAP-PRD-200).
    res.json({ ...pedirVerificacaoEmail(sessao.account.id), ...promessaDoCodigo() });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- os equipamentos do proprietário
//
// A PLAQUINHA continua pública e mínima. Estas rotas são a outra porta: o dono
// entra com a conta e vê o que o anônimo não pode — seus aparelhos, o histórico
// completo e quanto custou cada serviço.
//
// Endereço próprio, e não a mesma rota lendo um cabeçalho opcional: resposta
// pública cujo corpo muda por header é defeito de cache esperando acontecer, e
// a rota da plaquinha é justamente a desenhada para ser compartilhável.

/**
 * Resgata o convite numa conta que JÁ EXISTE.
 *
 * Sem este caminho o código vira papel morto para o cliente que já comprou no
 * site: `core_customer_accounts` tem UNIQUE no e-mail e o registro recusaria
 * com "já existe acesso para este e-mail".
 */
storefrontRouter.post('/portal/convite/resgatar', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(resgatarConvite(sessao.account.id, String(req.body?.code ?? '')));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/portal/equipamentos', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json({ items: listarEquipamentosDoDono(sessao.customerIds) });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/portal/equipamentos/:id', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    const ficha = equipamentoDoDono(sessao.customerIds, String(req.params.id));
    // 404 e não 403: quem não é dono não deve nem descobrir que o id existe.
    if (!ficha) {
      throw new ApiError('PORTAL_EQUIPAMENTO_NAO_ENCONTRADO', 'Equipamento não encontrado.', 404);
    }
    res.json(ficha);
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/portal/chamados', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json({ items: listarChamadosDaConta(sessao.account.id) });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/equipamentos/:id/chamados', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.status(201).json(
      abrirChamado({
        accountId: sessao.account.id,
        customerIds: sessao.customerIds,
        equipmentId: String(req.params.id),
        description: String(req.body?.description ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/chamados/:id/cancelar', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    cancelarChamado(sessao.account.id, String(req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * A decisão do orçamento é do DONO — rodada 43. A posse é conferida pelo
 * customer_id da sessão dentro de `decidirOrcamento`; quem não é dono recebe
 * 404 e nem descobre que a OS existe.
 */
storefrontRouter.post('/portal/ordens/:id/aprovar', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(decidirOrcamento(sessao.customerIds, String(req.params.id), 'aprovar'));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/ordens/:id/recusar', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(decidirOrcamento(sessao.customerIds, String(req.params.id), 'recusar'));
  } catch (err) {
    next(err);
  }
});
storefrontRouter.get('/portal/pedidos', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json({
      account: sessao.account,
      items: listCustomerOrders(sessao.account),
    });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/portal/pedidos/:id', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    const pedido = getCustomerOrder(sessao.account, String(req.params.id));
    if (!pedido) {
      // 404, não 403: dizer "existe mas não é seu" já entrega que existe.
      throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    }
    /*
      O PÓS-VENDA NO DETALHE (GAP-PRD-125): o link de rastreio (objeto dos
      Correios), a nota fiscal que a cliente pode baixar e o pedido de
      devolução. A operação dona vem do PEDIDO já provado, nunca da URL.
    */
    const orderId = String(req.params.id);
    const { company_id: empresa, shipping_carrier: transportadora } = getConnection()
      .prepare('SELECT company_id, shipping_carrier FROM core_orders WHERE id = ?')
      .get(orderId) as { company_id: string; shipping_carrier: string | null };
    res.json({
      ...pedido,
      /*
        UM LINK SÓ, e o da transportadora ganha (GAP-PRD-119 + GAP-PRD-125).
        O detalhe já traz o link montado pela transportadora do despacho
        (Correios, Jadlog, Melhor Envio). O padrão do objeto dos Correios só
        entra no pedido SEM transportadora gravada (anterior ao campo): com
        transportadora conhecida e sem página, não se inventa link.
      */
      trackingUrl:
        (pedido.trackingUrl as string | null | undefined)
        ?? (transportadora ? null : linkDeRastreio(pedido.trackingCode as string | null)),
      notaFiscal: notaFiscalNoPortal(empresa, orderId),
      devolucao: devolucaoNoPortal(empresa, orderId, String(pedido.status)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Cancelamento pelo próprio cliente.
 *
 * Só vale para pedido ainda não pago — é a política que já existia no writer
 * oficial, e este endpoint não cria outra. Depois do pagamento o caminho é
 * devolução, que envolve mercadoria de volta e estorno, e não cabe num botão
 * do portal.
 *
 * A cobrança é cancelada no provedor ANTES: um PIX que continua válido depois
 * do pedido cancelado é dinheiro entrando sem pedido para entregar.
 */
storefrontRouter.post('/portal/pedidos/:id/cancelar', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), async (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    const orderId = String(req.params.id);

    // A dona do pedido decide, não a URL: `getCustomerOrder` só devolve o que
    // a conta fechou ou o que foi feito com o e-mail que ela provou — NUNCA
    // o que só está no mesmo cadastro por CPF (GAP-PRD-006). Pedido de outra
    // pessoa é 404, e não um 403 que confirmaria a existência do id.
    const pedido = getCustomerOrder(sessao.account, orderId);
    if (!pedido) {
      throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    }

    // A operação dona vem do pedido — nunca do corpo da requisição, que o
    // cliente controla.
    const dono = getConnection()
      .prepare('SELECT company_id FROM core_orders WHERE id = ?')
      .get(orderId) as { company_id: string };

    // Falha ao cancelar no provedor NÃO impede o cancelamento do pedido: o
    // erro fica na intenção, e manter estoque preso por causa do provedor
    // seria pior. Ver `cancelOrderCharges`.
    await cancelOrderCharges({ companyId: dono.company_id, orderId });
    const atualizado = cancelOrder({
      companyId: dono.company_id,
      orderId,
      reason: 'Cancelado pelo cliente no portal',
      origem: 'cliente',
    });

    res.json({ status: atualizado.status, statusLabel: 'Cancelado' });
  } catch (err) {
    next(err);
  }
});

/**
 * O pedido da SESSÃO, com a operação dona — ou 404 (GAP-PRD-125).
 *
 * A mesma porta de `/portal/pedidos/:id`: `getCustomerOrder` só devolve o que a
 * conta fechou ou o que foi feito com o e-mail que ela provou. Pedido de outra
 * pessoa é 404, sem confirmar que o id existe.
 */
function pedidoDaSessao(req: import('express').Request): {
  accountId: string;
  orderId: string;
  companyId: string;
  status: string;
} {
  const sessao = exigirCliente(req);
  const orderId = String(req.params.id);
  const pedido = getCustomerOrder(sessao.account, orderId);
  if (!pedido) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
  const { company_id: companyId } = getConnection()
    .prepare('SELECT company_id FROM core_orders WHERE id = ?')
    .get(orderId) as { company_id: string };
  return { accountId: sessao.account.id, orderId, companyId, status: String(pedido.status) };
}

/** O DANFE da compra, para a dona do pedido imprimir ou salvar (GAP-PRD-125). */
storefrontRouter.get('/portal/pedidos/:id/nfe/danfe', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const { orderId, companyId } = pedidoDaSessao(req);
    // O documento ANTES do tipo: `res.type('html')` avaliado primeiro faria a
    // recusa (nota não emitida) sair como JSON rotulado de text/html.
    const html = danfeDoPedidoParaCliente(companyId, orderId);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

/** O XML autorizado da compra (nota + protocolo), como arquivo (GAP-PRD-125). */
storefrontRouter.get('/portal/pedidos/:id/nfe/xml', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const { orderId, companyId } = pedidoDaSessao(req);
    const { nomeDoArquivo, conteudo } = xmlDoPedidoParaCliente(companyId, orderId);
    res.setHeader('Content-Disposition', `attachment; filename="${nomeDoArquivo}"`);
    res.type('application/xml').send(conteudo);
  } catch (err) {
    next(err);
  }
});

/**
 * O pedido de devolução pela cliente (GAP-PRD-125): depois de entregue, por
 * arrependimento (7 dias do recebimento) ou defeito. Vai para a loja decidir.
 */
storefrontRouter.post('/portal/pedidos/:id/devolucao', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const { accountId, orderId, companyId } = pedidoDaSessao(req);
    const solicitacao = solicitarDevolucao({
      companyId,
      orderId,
      accountId,
      tipo: req.body?.tipo,
      motivo: req.body?.motivo,
    });
    const status = (
      getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as {
        status: string;
      }
    ).status;
    res.status(201).json({ solicitacao, devolucao: devolucaoNoPortal(companyId, orderId, status) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- avaliações

/** Resumo público: média, total e as mais recentes. Vitrine lê sem sessão. */
storefrontRouter.get('/products/:id/avaliacoes', rotaPublica('resumo público de avaliações: a vitrine lê sem sessão'), (req, res, next) => {
  try {
    res.json(listProductReviews(String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Avaliar exige sessão do portal E um pedido entregue com o produto — a regra
 * mora no serviço, não aqui.
 */
storefrontRouter.post('/products/:id/avaliacoes', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.status(201).json(
      submitReview({
        accountId: sessao.account.id,
        customerIds: sessao.customerIds,
        productId: String(req.params.id),
        rating: Number(req.body?.rating),
        comment: req.body?.comment,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** A avaliação da própria conta, para a tela pré-preencher a edição. */
storefrontRouter.get('/products/:id/minha-avaliacao', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json({ review: myReview(sessao.account.id, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------ conta do cliente

storefrontRouter.get('/portal/enderecos', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json({ items: listAddresses(sessao.account.id) });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/enderecos', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.status(201).json(addAddress(sessao.account.id, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

/**
 * Edita um endereço (GAP-PRD-115) — o formulário inteiro, com a mesma
 * validação do POST. Endereço de outra conta é 404. Pedidos já feitos não
 * mudam: guardam o retrato do endereço.
 */
storefrontRouter.put('/portal/enderecos/:id', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(updateAddress(sessao.account.id, String(req.params.id), req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/enderecos/:id/padrao', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    setDefaultAddress(sessao.account.id, String(req.params.id));
    res.json({ items: listAddresses(sessao.account.id) });
  } catch (err) {
    next(err);
  }
});

storefrontRouter.delete('/portal/enderecos/:id', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    removeAddress(sessao.account.id, String(req.params.id));
    res.json({ items: listAddresses(sessao.account.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Troca de senha.
 *
 * Exige a senha atual — o token de sessão sozinho não prova identidade
 * suficiente para mudar credencial.
 */
storefrontRouter.post('/portal/senha', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler — perfil do ERP não existe aqui'), async (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    await changePassword({
      accountId: sessao.account.id,
      currentSessionToken: portalToken(req) ?? '',
      currentPassword: String(req.body?.currentPassword ?? ''),
      newPassword: String(req.body?.newPassword ?? ''),
    });
    res.json({ ok: true, message: 'Senha alterada. As outras sessões foram encerradas.' });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- conta completa (rodada 38)

/** Perfil (nome/telefone/e-mail) do cliente logado. */
storefrontRouter.get('/portal/perfil', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(getProfile(sessao.account.id));
  } catch (err) {
    next(err);
  }
});

/**
 * Edita nome, telefone e o CPF/CNPJ da conta (GAP-PRD-133). Os dados moram na
 * CONTA — a conta sem cadastro vinculado também guarda — e nome e telefone
 * refletem nos cadastros vinculados. O documento se declara uma vez.
 */
storefrontRouter.put('/portal/perfil', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(
      updateProfile(sessao.account.id, {
        name: req.body?.name === undefined ? undefined : String(req.body.name),
        phone: req.body?.phone === undefined ? undefined : String(req.body.phone),
        document: req.body?.document === undefined ? undefined : String(req.body.document),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Vincula à conta os pedidos de um documento — a co-prova (e-mail+documento). */
storefrontRouter.post('/portal/vincular', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    const r = vincularPorDocumento({
      accountId: sessao.account.id,
      document: String(req.body?.document ?? ''),
    });
    res.json({
      linked: r.linked,
      novos: r.novos,
      message:
        r.novos > 0
          ? r.novos === 1
            ? 'Encontramos 1 cadastro seu com esse documento e o seu e-mail — ele foi ligado à sua conta.'
            : `Encontramos ${r.novos} cadastros seus com esse documento e o seu e-mail — eles foram ligados à sua conta.`
          : 'Nada novo com esse documento e o seu e-mail. Comprou no balcão sem e-mail? Peça o código de acesso na loja.',
    });
  } catch (err) {
    next(err);
  }
});

/** Sai de todos os outros dispositivos, mantendo o atual. */
storefrontRouter.post('/portal/sair-outros', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    revogarOutrasSessoes(sessao.account.id, portalToken(req) ?? '');
    res.json({ ok: true, message: 'As outras sessões foram encerradas.' });
  } catch (err) {
    next(err);
  }
});

/*
  A SESSÃO DESLIZA (GAP-PRD-193). Toda chamada do portal já empurra o
  vencimento (`resolveCustomerSession`); esta rota existe para a TELA saber o
  vencimento novo — a vitrine navega sem chamar o portal, e a sessão guardada
  no navegador precisa acompanhar o servidor. É um GET: lê a própria sessão,
  e o deslize é o mesmo que qualquer outra leitura do portal já faz.
*/
storefrontRouter.get('/portal/sessao', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json({ expiresAt: sessao.expiresAt, absoluteExpiresAt: sessao.absoluteExpiresAt });
  } catch (err) {
    next(err);
  }
});

/*
  O CARRINHO DA CONTA (GAP-PRD-193): no servidor, por conta. Só produto e
  quantidade; preço e disponível vêm da vitrine a cada leitura. O login funde
  o carrinho do aparelho com o da conta (`mesclar`, a maior quantidade).
*/
storefrontRouter.get('/portal/carrinho', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(lerCarrinho(sessao.account.id));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.put('/portal/carrinho', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(substituirCarrinho(sessao.account.id, req.body?.items));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/carrinho/mesclar', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(mesclarCarrinho(sessao.account.id, req.body?.items));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/carrinho/itens', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(acrescentarAoCarrinho(sessao.account.id, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

/**
 * O envio de e-mails da loja está ligado? (GAP-PRD-200)
 *
 * O portal pergunta ANTES de prometer link ou código. Público e igual para
 * todo mundo: é o estado do carteiro da loja, não diz nada sobre conta
 * nenhuma — e nenhum detalhe da configuração (o que falta fica na tela de
 * gestão, não aqui).
 */
storefrontRouter.get('/portal/envio-de-email', rotaPublica('portal do cliente: a tela de acesso pergunta antes de prometer e-mail, sem sessão; não revela conta nem configuração'), (_req, res, next) => {
  try {
    res.json(situacaoDoEnvio());
  } catch (err) {
    next(err);
  }
});

/**
 * Pede a recuperação de senha. Público, e SEMPRE 200 — dizer "esse e-mail não
 * tem conta" entrega a lista de quem tem. O token vai pelo e-mail.
 */
storefrontRouter.post('/portal/recuperar-senha', rotaPublica('portal do cliente: sem sessão — a recuperação existe justamente para quem não consegue entrar'), (req, res, next) => {
  try {
    // A origem conta no teto de pedidos por hora (GAP-PRD-116).
    pedirRecuperacaoSenha(String(req.body?.email ?? ''), { origem: origemDaRequisicao(req) });
    // A frase depende do envio estar LIGADO — e é a mesma com ou sem conta
    // (GAP-PRD-200): o que muda é o estado da loja, não o do e-mail digitado.
    res.json({ ok: true, ...promessaDaRecuperacao() });
  } catch (err) {
    next(err);
  }
});

/** Redefine a senha com o token do e-mail. Público: o token é a credencial. */
storefrontRouter.post('/portal/redefinir-senha', rotaPublica('portal do cliente: sem sessão — o token do e-mail é a credencial desta rota'), async (req, res, next) => {
  try {
    await redefinirSenhaComToken({
      token: String(req.body?.token ?? ''),
      password: String(req.body?.password ?? ''),
    });
    res.json({ ok: true, message: 'Senha redefinida. Entre com a nova senha.' });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------ entrar com Google (GAP-PRD-027)
//
// Todas públicas pelo mesmo motivo do /portal/entrar: quando rodam, a pessoa
// ainda não tem sessão. A prova é outra em cada uma, e está dita no motivo.
// O fluxo inteiro mora em `GoogleLoginService`; aqui só se traduz HTTP.

/** A vitrine pergunta se mostra o botão. Nada da configuração sai daqui. */
storefrontRouter.get('/portal/google/disponivel', rotaPublica('portal do cliente: a tela de entrar pergunta se mostra o botão do Google — responde só sim/não e o modo'), (_req, res, next) => {
  try {
    res.json(googleDisponivel());
  } catch (err) {
    next(err);
  }
});

/** Onde mora a tela de consentimento do provedor de teste, vista do navegador. */
function enderecoDoProvedorDeTeste(req: { protocol: string; get(nome: string): string | undefined; baseUrl: string }): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}${req.baseUrl}/portal/google/teste/autorizar`;
}

storefrontRouter.post('/portal/google/iniciar', rotaPublica('portal do cliente: começa a entrada pelo Google — sem sessão ainda; para LIGAR a uma conta aberta o x-portal-token é exigido dentro do serviço'), (req, res, next) => {
  try {
    res.json(
      iniciarLoginGoogle({
        intent: req.body?.intent,
        termsAccepted: req.body?.termsAccepted,
        returnTo: req.body?.returnTo,
        sessionToken: portalToken(req),
        enderecoDoProvedorDeTeste: enderecoDoProvedorDeTeste(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/google/concluir', rotaPublica('portal do cliente: a volta do Google — o code, o state e a chave do navegador que começou são a credencial, e o id_token é conferido pela chave do Google'), async (req, res, next) => {
  try {
    const r = await concluirLoginGoogle({
      code: req.body?.code,
      state: req.body?.state,
      browserKey: req.body?.browserKey,
      sessionToken: portalToken(req),
      // Socket, não req.ip: cabeçalho forjado não escolhe o IP da trilha.
      ip: req.socket?.remoteAddress ?? null,
    });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/portal/google/aceitar-termos', rotaPublica('portal do cliente: conta nova pelo Google esperando o aceite — o ticket de uso único e a chave do navegador são a credencial'), (req, res, next) => {
  try {
    res.status(201).json({
      status: 'sessao',
      ...aceitarTermosDoGoogle({
        ticket: req.body?.ticket,
        browserKey: req.body?.browserKey,
        termsAccepted: req.body?.termsAccepted,
        ip: req.socket?.remoteAddress ?? null,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** O Google na conta aberta: ligado ou não, e se a conta tem senha. */
storefrontRouter.get('/portal/google/conta', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(googleNaConta(sessao.account.id));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.delete('/portal/google/conta', rotaPublica('portal do cliente: sessão própria via x-portal-token, exigida pelo exigirCliente dentro do handler'), (req, res, next) => {
  try {
    const sessao = exigirCliente(req);
    res.json(desligarGoogle(sessao.account.id, req.socket?.remoteAddress ?? null));
  } catch (err) {
    next(err);
  }
});

/*
  O PROVEDOR DE TESTE — a tela que faz o papel do Google. Fora de produção
  apenas: em produção/homologação (DEVORA_API_ENV) ou com NODE_ENV=production
  estas duas rotas respondem 404, como qualquer rota que não existe.
*/
storefrontRouter.get('/portal/google/teste/autorizar', rotaPublica('provedor de TESTE do Google (só fora de produção; 404 em produção): faz o papel da tela de consentimento do Google'), (req, res, next) => {
  try {
    if (!provedorDeTestePermitido()) throw new ApiError('API_NOT_FOUND', 'Rota não encontrada.', 404);
    conferirPedidoDeAutorizacao(req.query as Record<string, unknown>, clienteRegistradoParaTeste());
    res
      .status(200)
      .type('html')
      .send(paginaDeConsentimento(`${req.baseUrl}/portal/google/teste/autorizar/confirmar`, req.query as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
});

storefrontRouter.get('/portal/google/teste/autorizar/confirmar', rotaPublica('provedor de TESTE do Google (só fora de produção; 404 em produção): a decisão da tela de consentimento de teste volta para o endereço de retorno cadastrado'), (req, res, next) => {
  try {
    if (!provedorDeTestePermitido()) throw new ApiError('API_NOT_FOUND', 'Rota não encontrada.', 404);
    const q = req.query as Record<string, unknown>;
    const pedido = conferirPedidoDeAutorizacao(q, clienteRegistradoParaTeste());
    const destino =
      q.decisao === 'recusar'
        ? recusarNoProvedorDeTeste(pedido)
        : autorizarNoProvedorDeTeste(pedido, {
            email: String(q.email ?? ''),
            name: typeof q.name === 'string' && q.name.trim() ? q.name.trim() : undefined,
            emailVerified: q.email_verified === 'true',
          });
    res.redirect(302, destino);
  } catch (err) {
    next(err);
  }
});

/*
  Aqui morava GET /orders/:id, pública, com o comentário "o id opaco do pedido é a
  credencial". Apagada na rodada 34: devolvia SELECT * de core_orders — CPF em
  claro, e-mail, endereço, referência de pagamento — a quem soubesse o id, e o
  id circula em URL, histórico e log. A rota irmã do portal (/portal/pedidos/:id)
  já entregava o mesmo pedido com sessão e documento mascarado, e era a única que
  alguma tela chamava. Quem acompanha pedido entra na conta.
*/

/**
 * Webhook do provedor de pagamento — POR OPERAÇÃO.
 *
 * É o ÚNICO caminho pelo qual um pedido online passa a "pago": o navegador do
 * comprador nunca decide isso.
 *
 * A operação vai na URL porque cada uma registra a própria no painel do
 * provedor, com o próprio token. Um endpoint só, com um token só para as seis,
 * significaria que quem tem o token de uma empresa pode confirmar pedido de
 * outra.
 *
 * A rota sem operação continua existindo para instalações que ainda não
 * migraram a URL registrada no provedor. Nela, a operação sai do TOKEN (o do
 * cofre de cada uma); o token do ambiente só vale fora de produção e nunca
 * para operação que tem o próprio (GAP-PRD-113). A URL a cadastrar aparece em
 * Integrações › Asaas (GAP-PRD-002).
 */
storefrontRouter.post('/webhooks/payments/:provider/:companyId', rotaPublica('webhook do provedor de pagamento: quem chama é o provedor, autenticado pelo token dele dentro do handler'), (req, res, next) => {
  try {
    res.status(200).json(
      handlePaymentWebhook({
        provider: String(req.params.provider),
        companyId: String(req.params.companyId),
        token: req.headers['asaas-access-token'] as string | undefined,
        payload: req.body ?? {},
      }),
    );
  } catch (err) {
    next(err);
  }
});

storefrontRouter.post('/webhooks/payments/:provider', rotaPublica('webhook do provedor de pagamento: quem chama é o provedor, autenticado pelo token dele dentro do handler'), (req, res, next) => {
  try {
    const result = handlePaymentWebhook({
      provider: String(req.params.provider),
      token: req.headers['asaas-access-token'] as string | undefined,
      payload: req.body ?? {},
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * A PLAQUINHA LEVA AQUI.
 *
 * Rota pública de propósito: o cliente escaneia o QR colado no equipamento e
 * acompanha o serviço sem ter conta. Exigir login aqui mataria a plaquinha —
 * ninguém cria conta na calçada para saber se a moto ficou pronta.
 *
 * O token é opaco e é a ÚNICA credencial. Por isso a resposta traz apenas o que
 * pode ficar exposto: identificação do aparelho e andamento. Nada do dono,
 * nenhum valor, nenhum diagnóstico interno.
 */
storefrontRouter.get('/equipamento/:token', rotaPublica('plaquinha do equipamento: o QR colado no aparelho é a credencial — token opaco, resposta mínima'), (req, res, next) => {
  try {
    const view = publicEquipmentByToken(String(req.params.token));
    if (!view) {
      // Mesma resposta para token inválido e inexistente: distinguir os dois
      // diria a quem tenta adivinhar que chegou perto.
      throw new ApiError('LOJA_EQUIPAMENTO_NAO_ENCONTRADO', 'Equipamento não encontrado.', 404);
    }
    res.json(view);
  } catch (err) {
    next(err);
  }
});
