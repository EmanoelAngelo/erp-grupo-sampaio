/**
 * Loja pública do Grupo Sampaio.
 *
 * A home é o PORTAL DO GRUPO — não a vitrine de uma operação. As lojas
 * aparecem como áreas comerciais e a Oficina como serviço, corrigindo a home
 * anterior, que apresentava mobilidade elétrica como se fosse a identidade do
 * grupo inteiro.
 *
 * Tudo aqui lê o catálogo e o estoque reais das operações: não existe
 * cadastro nem saldo paralelo de e-commerce.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { contar, formatCents } from '@/components/gs/format';
import { CascaDaLoja, type MarcaDaLoja } from '@/components/gs/CascaDaLoja';
import { FotoDeProduto } from '@/components/gs/LugarDaFoto';
import { arranjoDaVitrine, classesDaGrade } from '@/components/gs/arranjoDaVitrine';
import { coreApi } from '@/lib/api/core';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { uuid } from '../../lib/uuid';
import { descreverParcelas, maximoDeParcelas, type LojaDoCarrinho } from '@/lib/parcelasDoCarrinho';
import {
  PORTAL_EVENT,
  lerSessaoPortal,
  limparSessaoPortal,
  type SessaoPortal,
} from '@/lib/portalSession';
import {
  CompradorDaConta,
  EnderecoDaConta,
  EntreParaComprar,
  FaturamentoDaConta,
} from '@/components/gs/CheckoutDaConta';
import { useEnderecosDaConta } from '@/hooks/useEnderecosDaConta';
import { descreverFalta, faltaParaEntregar } from '@/lib/api/enderecos';
import { useCarrinhoDaConta } from '@/hooks/useCarrinhoDaConta';
import { CupomDoCarrinho } from '@/components/gs/CupomDoCarrinho';
import type { CupomSimulado } from '@/lib/api/cupons';
import { dataBR } from '@/lib/datas';
import { TentativaJaRegistrada } from '@/components/gs/TentativaJaRegistrada';
import { ehTentativaJaRegistrada } from '@/lib/api/tentativaJaRegistrada';

interface Store {
  id: string;
  slug: string;
  tradeName: string;
  kind: string;
  productCount: number;
  /** Identidade escrita pelo gestor. Nula quando ainda não foi preenchida. */
  headline: string | null;
  description: string | null;
  whatsapp: string | null;
  /** Só chega quando a faixa está ligada — desligada não sai do servidor. */
  bannerText: string | null;
  logoUrl?: string | null;
  coverUrl?: string | null;
  /** QUE NEGÓCIO esta loja faz — decide o ARRANJO da vitrine (rodada 56). */
  storefrontPreset?: string | null;
  /** O que é verdade sobre comprar aqui. Vem pronto; a tela não inventa. */
  seals?: { id: string; label: string }[];
  /**
   * Em quantas vezes o cartão parcela nesta loja — o número por trás do selo
   * (GAP-PRD-114). Nulo = só à vista. Opcional: servidor antigo não manda.
   */
  cardInstallmentsMax?: number | null;
}

interface StoreProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  subcategory?: string | null;
  brand: string | null;
  imageUrl: string | null;
  basePriceCents: number;
  priceCents: number;
  onSale: boolean;
  available: number;
  storeSlug: string;
  storeName: string;
  featured?: boolean;
  hasVariants?: boolean;
  fromPriceCents?: number | null;
}

/**
 * Um departamento da vitrine, com os galhos dentro.
 *
 * `productCount` do PAI inclui as filhas — é o número que o cliente espera ao
 * clicar num departamento.
 */
interface Departamento {
  name: string;
  productCount: number;
  children: { name: string; productCount: number }[];
}

interface CartLine {
  product: StoreProduct;
  quantity: number;
}

/**
 * O item do carrinho conferido pelo servidor, na cotação de frete.
 *
 * O carrinho vive no `localStorage` com o produto inteiro congelado dentro,
 * e nunca perguntava de novo: a promoção acabava, o preço de tabela
 * voltava, e quem deixou a aba aberta desde ontem continuava vendo o preço
 * velho. O pedido nascia — corretamente — pelo preço de hoje, com o PIX
 * emitido num valor que o cliente nunca leu.
 */
interface ItemRevalidado {
  productId: string;
  companyId: string;
  name: string;
  quantity: number;
  priceCents: number;
  available: number;
}

/**
 * Uma forma de entrega, do jeito que o servidor devolve.
 *
 * `method` é a CHAVE — é só isso que volta ao servidor no checkout. O
 * `priceCents` daqui serve para mostrar o total; quem cobra é o servidor, que
 * cota de novo na hora de fechar. `estimatedDays` é `null` quando ninguém sabe
 * o prazo, e nesse caso a tela não inventa um.
 */
interface OpcaoEntrega {
  method: string;
  label: string;
  priceCents: number;
  estimatedDays: number | null;
  source: 'retirada' | 'transportadora' | 'tabela_da_loja';
}

/**
 * As formas de entrega de UMA loja do carrinho.
 *
 * O carrinho pode ter itens de duas operações, e cada uma despacha do próprio
 * endereço, com o próprio peso e a própria política. A cotação vinha uma só,
 * do pacote da primeira — e o pedido da segunda nascia com R$ 0,00 de frete.
 */
interface FreteDaLoja {
  companyId: string;
  storeName: string;
  itemsCents: number;
  options: OpcaoEntrega[];
  deliveryUnavailable: { code: string; message: string } | null;
  /** Esta loja só vende para quem entrou na conta? (GAP-PRD-028) */
  exigeConta?: boolean;
}

/**
 * Cobrança devolvida pelo checkout.
 *
 * `status` vem do servidor e é a única fonte: `pending` enquanto o provedor
 * não confirmar, `unconfigured` quando a operação ainda não tem credencial.
 * A tela nunca decide que algo foi pago.
 */
interface PaymentView {
  orderId: string;
  method?: string;
  /** Em quantas vezes a cobrança foi ao provedor (GAP-PRD-114). */
  installments?: number;
  status: string;
  environment?: string;
  pixPayload?: string | null;
  pixImageBase64?: string | null;
  bankSlipUrl?: string | null;
  identificationField?: string | null;
  dueDate?: string | null;
  /** Até quando os itens são deste pedido (instante) — ver `PrazoDoPagamento`. */
  reservedUntil?: string | null;
  detail?: string;
}

const CART_KEY = 'gs.loja.carrinho';

function loadCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]') as CartLine[];
  } catch {
    return [];
  }
}

function newOrderKey(): string {
  return `loja-${uuid()}`;
}

export default function LojaPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [services, setServices] = useState<Store[]>([]);
  /*
    As lojas também têm os TRÊS estados (rodada 57). O catch antigo era
    `setStores([])`, silencioso: na home, "Nossas lojas" com nada embaixo; na
    página da marca era pior — a busca nunca montava, o herói nunca aparecia,
    e nada avisava nem tentava de novo, para sempre.
  */
  const [statusLojas, setStatusLojas] = useState<'carregando' | 'pronto' | 'erro'>('carregando');
  /** A capa do herói que falhou ao carregar some — sem ícone quebrado. */
  const [capaQuebrada, setCapaQuebrada] = useState(false);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  // Três estados distintos, porque "vazio" pode ser três coisas diferentes: a
  // vitrine ainda carregando, o servidor fora do ar, ou a busca sem resultado.
  const [statusVitrine, setStatusVitrine] = useState<'carregando' | 'pronto' | 'erro'>(
    'carregando',
  );
  const [totalProdutos, setTotalProdutos] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [destaques, setDestaques] = useState<StoreProduct[]>([]);
  const [ofertas, setOfertas] = useState<StoreProduct[]>([]);
  /**
   * OS DEPARTAMENTOS, EM ÁRVORE (rodada 56).
   *
   * Era `string[]` — uma lista achatada em que "Camisas", que é galho de
   * "Vestuário", aparecia ao lado do próprio pai como se fossem irmãos. O
   * sistema já mantinha a hierarquia no escritório (TaxonomyService, com tela
   * própria); a loja é que mostrava texto solto.
   */
  const [categorias, setCategorias] = useState<Departamento[]>([]);
  /** O galho escolhido dentro do departamento aberto. */
  const [subcategoria, setSubcategoria] = useState<string | null>(null);
  /*
    A página da MARCA (rodada 40): /preco-justo, /me-mimei… é a mesma vitrine,
    travada numa loja e vestida com a paleta dela. O slug vem da rota; sem
    slug, esta é a home do grupo e não há loja ativa.
  */
  const { storeSlug: lojaFixa } = useParams<{ storeSlug?: string }>();
  const activeStore = lojaFixa ?? null;
  const [categoria, setCategoria] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Faixa em REAIS: e o que o cliente digita. O servidor converte para
  // centavos e filtra pelo preco COM promocao — ver listStorefrontProducts.
  const [filtro, setFiltro] = useState({ min: '', max: '', sort: 'nome' });
  /** No celular a faixa de preço + ordenação fica atrás de um botão. */
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const filtrosAtivos =
    (filtro.min ? 1 : 0) + (filtro.max ? 1 : 0) + (filtro.sort !== 'nome' ? 1 : 0);
  const [cart, setCart] = useState<CartLine[]>(loadCart);
  const [cartOpen, setCartOpen] = useState(false);
  /*
    `?carrinho=1` abre o carrinho ao chegar — é o elo do "Ver carrinho" da
    página do produto, que antes apontava para a home do GRUPO com o carrinho
    fechado: dois saltos de contexto para ver o que acabou de guardar.
  */
  const [paramsDaUrl, setParamsDaUrl] = useSearchParams();
  useEffect(() => {
    if (!paramsDaUrl.get('carrinho')) return;
    setCartOpen(true);
    // Some da URL depois de cumprir: recarregar a página não deve reabrir.
    const limpos = new URLSearchParams(paramsDaUrl);
    limpos.delete('carrinho');
    setParamsDaUrl(limpos, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [checkoutForm, setCheckoutForm] = useState({
    name: '',
    document: '',
    email: '',
    phone: '',
    zip: '',
    address: '',
  });
  /**
   * As formas de entrega, cotadas pelo SERVIDOR — uma lista por loja.
   *
   * A tela nunca calcula frete e nunca manda preço: manda a chave da opção
   * escolhida. O preço que vale é o que voltou daqui — antes o checkout aceitava
   * `shippingCents` do navegador, e o comprador podia mandar zero.
   */
  const [frete, setFrete] = useState<{ lojas: FreteDaLoja[] } | null>(null);
  /**
   * O que mudou desde que o carrinho foi montado.
   *
   * Adotar o preço novo em silêncio seria o mesmo defeito com outra cara:
   * o cliente veria um total diferente do que leu, sem uma palavra. A tela
   * troca o número E diz que trocou.
   */
  const [mudouNoCarrinho, setMudouNoCarrinho] = useState<string[]>([]);
  /**
   * A ESCOLHA É POR LOJA, e não uma só para o carrinho.
   *
   * Era `metodoEntrega` — uma string. Carrinho de duas lojas são duas
   * encomendas, de dois endereços, com dois pesos: o servidor cotava a
   * primeira e o pedido da segunda nascia com o método dela e R$ 0,00 de
   * frete. O cliente pagava um frete e recebia dois pacotes.
   */
  const [entregaPorLoja, setEntregaPorLoja] = useState<Record<string, string>>({});
  /*
    A cotação que falha PRECISA falar (rodada 57): o catch fazia só
    `setFrete(null)`, e o quadro "Como você quer receber" ficava vazio — sem
    opção, sem aviso, sem retry — no momento de maior intenção de compra. O
    cliente lia um checkout quebrado e o total somava frete zero em silêncio.
  */
  const [erroFrete, setErroFrete] = useState(false);
  // pix | boleto | cartao. O cartão é pago na página do provedor — o número
  // nunca passa por aqui, e por isso também não há o que 'salvar'.
  const [metodoPagamento, setMetodoPagamento] = useState<'pix' | 'boleto' | 'cartao'>('pix');
  /** Parcelas no cartão (GAP-PRD-114). Só viaja quando é cartão e mais de 1. */
  const [parcelas, setParcelas] = useState(1);
  const [cotandoFrete, setCotandoFrete] = useState(false);
  const [orderKey, setOrderKey] = useState(newOrderKey);
  /**
   * O servidor recusou a chave por ela já ter registrado pedidos com OUTRO
   * carrinho (422, R2-IDEM): os números que ele devolveu.
   */
  const [tentativaReusada, setTentativaReusada] = useState<{ numeros: number[] } | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  /*
    O banner mora no TOPO da vitrine — e quem clica no "+" de um card na
    quarta linha, ou no "Finalizar pedido" no fim do formulário do celular,
    não o vê aparecer. Aviso que ninguém vê não é aviso: quando a mensagem
    muda, a tela rola até ela.
  */
  const bannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!message) return;
    // Chamada opcional: o jsdom dos testes não implementa scrollIntoView, e
    // um aviso que derruba a tela é pior que um aviso fora do olho.
    bannerRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [message]);
  const [busy, setBusy] = useState(false);
  /*
    A CONTA DO PORTAL, NO CHECKOUT (GAP-PRD-028/043).

    O checkout ia sempre como visitante: o cliente logado comprava, e o
    pedido não ia para a conta dele. A sessão é lida aqui e acompanhada pelo
    evento do portal — entrar em outra aba ou na página da conta troca o
    formulário na hora, sem recarregar.
  */
  const [sessaoPortal, setSessaoPortal] = useState<SessaoPortal | null>(lerSessaoPortal);
  useEffect(() => {
    const reler = () => setSessaoPortal(lerSessaoPortal());
    window.addEventListener(PORTAL_EVENT, reler);
    window.addEventListener('storage', reler);
    return () => {
      window.removeEventListener(PORTAL_EVENT, reler);
      window.removeEventListener('storage', reler);
    };
  }, []);
  /** O endereço salvo escolhido para a entrega; nulo = nenhum escolhido ainda. */
  const [enderecoSalvo, setEnderecoSalvo] = useState<string | null>(null);
  /**
   * O endereço da NOTA FISCAL (GAP-PRD-115) — com IBGE. A lista da conta é
   * lida uma vez e serve às duas escolhas (entrega e nota).
   */
  const [enderecoDaNota, setEnderecoDaNota] = useState<string | null>(null);
  const { enderecos: enderecosDaConta, recarregar: recarregarEnderecos } = useEnderecosDaConta(
    sessaoPortal?.token,
  );
  /*
    O CARRINHO DE QUEM ENTROU MORA NA CONTA (GAP-PRD-193): entrar funde o
    carrinho deste aparelho com o da conta, e cada mudança vai para lá — o
    outro aparelho abre com o mesmo carrinho. Preço e disponível continuam
    vindo do servidor na cotação, como antes.
  */
  const { aviso: avisoDoCarrinho } = useCarrinhoDaConta<CartLine>({
    sessao: sessaoPortal,
    cart,
    setCart,
    paraLinha: (product, quantity) => ({ product: product as StoreProduct, quantity }),
  });
  /** O que impede a conta de fechar agora (e-mail não confirmado), ou nulo. */
  const [bloqueioDaConta, setBloqueioDaConta] = useState<string | null>(null);
  /** Cobranças criadas no checkout — é onde o cliente vê o PIX. */
  const [pagamentos, setPagamentos] = useState<PaymentView[]>([]);
  /**
   * O cupom aplicado na gaveta (GAP-PRD-123), com o desconto que o SERVIDOR
   * calculou para este carrinho. O checkout confere de novo.
   */
  const [cupom, setCupom] = useState<CupomSimulado | null>(null);

  const POR_PAGINA = 12;

  /*
    O ARRANJO DO NEGÓCIO (rodada 56).

    Uma linha de tabela decide a densidade da grade, a proporção do card e se a
    busca abre a página. Sem loja ativa — a home do grupo — vale o neutro: a
    home apresenta as cinco lojas, não vende por uma delas.
  */
  const lojaAtiva = lojaFixa ? stores.find((s) => s.slug === lojaFixa) : undefined;
  const arranjo = arranjoDaVitrine(lojaFixa ? lojaAtiva?.storefrontPreset : null);
  /*
    A home do grupo não tem loja para consultar, então o arranjo dela é sabido
    de saída. Na página da marca, ele só existe depois que `/loja/stores`
    responde — e é essa espera que a busca respeita para não pular de lugar.
  */
  const arranjoConhecido = !lojaFixa || stores.length > 0;

  const carregarLojas = useCallback(async () => {
    setStatusLojas('carregando');
    try {
      const d = await apiRequest<{ stores: Store[]; services: Store[] }>('/loja/stores', {
        anonymous: true,
      }).then((r) => exigirCampos(r, 'stores', 'services'));
      setStores(d.stores);
      setServices(d.services);
      setStatusLojas('pronto');
    } catch {
      setStatusLojas('erro');
    }
  }, []);

  useEffect(() => {
    void carregarLojas();
  }, [carregarLojas]);

  /*
    Destaques, ofertas e departamentos acompanham a loja escolhida (ou o grupo
    todo). São enfeites da vitrine: falhando, somem sem derrubar a página —
    mas o "Tentar de novo" da vitrine também os traz de volta, para que um
    clique cure a tela inteira e não só a grade.
  */
  const carregarColecoes = useCallback(() => {
    const q = activeStore ? `?store=${activeStore}` : '';
    apiRequest<{ items: StoreProduct[] }>(`/loja/destaques${q}`, { anonymous: true })
      .then((d) => setDestaques(d.items ?? []))
      .catch(() => setDestaques([]));
    apiRequest<{ items: StoreProduct[] }>(`/loja/ofertas${q}`, { anonymous: true })
      .then((d) => setOfertas(d.items ?? []))
      .catch(() => setOfertas([]));
    apiRequest<{ items: Departamento[] }>(`/loja/categories${q}`, { anonymous: true })
      .then((d) => setCategorias(d.items ?? []))
      .catch(() => setCategorias([]));
  }, [activeStore]);

  useEffect(() => {
    carregarColecoes();
  }, [carregarColecoes]);

  // Trocar loja, busca, filtro ou categoria volta para a primeira página —
  // senão a pessoa fica "presa" na página 3 de um resultado que agora tem 1.
  useEffect(() => {
    setPagina(0);
  }, [activeStore, search, filtro, categoria, subcategoria]);

  /*
    Trocar de departamento LARGA o galho: continuar filtrando por "Camisas"
    dentro de "Calçados" devolveria vazio, e o cliente leria isso como loja sem
    produto em vez de filtro incoerente.
  */
  useEffect(() => {
    setSubcategoria(null);
  }, [categoria]);

  /*
    E trocar de LOJA larga os dois.

    O departamento sobrevivia à troca: sair da Gringa filtrando "Vestuário" e
    entrar na PJ Motors mantinha o filtro ligado — com nenhuma pílula marcada,
    porque "Vestuário" não é departamento de lá. A vitrine devolvia vazio e o
    cliente lia "loja sem produto", sem ver o filtro que causou.
  */
  useEffect(() => {
    setCategoria(null);
    setSubcategoria(null);
    // A capa quebrada era DAQUELA loja; a próxima merece tentar a dela.
    setCapaQuebrada(false);
  }, [activeStore]);

  const loadProducts = useCallback(async () => {
    const params = new URLSearchParams();
    if (activeStore) params.set('store', activeStore);
    if (categoria) params.set('category', categoria);
    // O GALHO é filtro à parte: "Vestuário" traz camisas e calças, "Camisas"
    // traz só as camisas.
    if (subcategoria) params.set('subcategory', subcategoria);
    if (search.trim()) params.set('q', search.trim());
    if (filtro.min) params.set('min', filtro.min);
    if (filtro.max) params.set('max', filtro.max);
    if (filtro.sort !== 'nome') params.set('sort', filtro.sort);
    params.set('limit', String(POR_PAGINA));
    params.set('offset', String(pagina * POR_PAGINA));
    setStatusVitrine('carregando');
    try {
      const data = await apiRequest<{ items: StoreProduct[]; total: number }>(
        `/loja/products?${params.toString()}`,
        { anonymous: true },
      ).then((r) => exigirCampos(r, 'items', 'total'));
      setProducts(data.items);
      setTotalProdutos(data.total);
      setStatusVitrine('pronto');
    } catch {
      setStatusVitrine('erro');
    }
  }, [activeStore, categoria, subcategoria, search, filtro, pagina]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      // carrinho segue só em memória se o storage estiver indisponível
    }
  }, [cart]);

  const addToCart = (product: StoreProduct) => {
    setCart((prev) => {
      const found = prev.find((l) => l.product.id === product.id);
      // Não deixa o carrinho passar do disponível — o servidor recusaria
      // depois, e é melhor avisar aqui.
      if (found) {
        if (found.quantity >= product.available) {
          setMessage({ tone: 'error', text: `Só há ${product.available} em estoque.` });
          return prev;
        }
        return prev.map((l) =>
          l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
    setMessage(null);
  };

  const totalItens = cart.reduce((acc, l) => acc + l.product.priceCents * l.quantity, 0);

  /** A opção escolhida em cada loja, já com o preço que o servidor cotou. */
  const escolhaDaLoja = (companyId: string): OpcaoEntrega | null =>
    frete?.lojas
      .find((l) => l.companyId === companyId)
      ?.options.find((o) => o.method === entregaPorLoja[companyId]) ?? null;

  /*
    O FRETE DO CARRINHO É A SOMA DOS FRETES DAS LOJAS.

    Era o preço de UMA opção. Com duas lojas, o total na tela mostrava um frete
    e o cliente recebia dois pacotes — a segunda operação despachava por conta
    dela, e ninguém via.
  */
  const freteCents = (frete?.lojas ?? []).reduce(
    (soma, l) => soma + (escolhaDaLoja(l.companyId)?.priceCents ?? 0),
    0,
  );
  // O cupom desconta os ITENS, nunca a entrega (GAP-PRD-123).
  const descontoDoCupom = cupom?.discountCents ?? 0;
  const total = totalItens - descontoDoCupom + freteCents;

  /**
   * Alguma loja do carrinho exige conta, e ninguém entrou? A tela pede o login
   * ANTES de o cliente preencher tudo — o servidor recusa de novo no fechamento.
   */
  const precisaEntrar = !sessaoPortal && (frete?.lojas ?? []).some((l) => l.exigeConta);
  /** Com conta e endereço salvo escolhido, o texto digitado não vale. */
  const usaEnderecoSalvo = Boolean(sessaoPortal) && enderecoSalvo !== null;


  /** Alguma das lojas do carrinho vai ENTREGAR? Aí o endereço é obrigatório. */
  const algumaEntrega = (frete?.lojas ?? []).some(
    (l) => (escolhaDaLoja(l.companyId)?.source ?? 'retirada') !== 'retirada',
  );
  /** O endereço salvo escolhido para a entrega, e o que falta nele para receber. */
  const enderecoDeEntregaEscolhido =
    sessaoPortal && algumaEntrega
      ? ((enderecosDaConta ?? []).find((e) => e.id === enderecoSalvo) ?? null)
      : null;
  const faltaNaEntrega = enderecoDeEntregaEscolhido ? faltaParaEntregar(enderecoDeEntregaEscolhido) : [];
  /**
   * O que impede a conta de fechar agora: o e-mail não confirmado, a entrega
   * sem endereço salvo escolhido, ou o endereço escolhido incompleto (sem
   * número, bairro ou o código IBGE do município, GAP-PRD-028).
   *
   * A tela avisa antes do clique, e o servidor confere de novo no fechamento,
   * antes de reservar estoque ou emitir cobrança: com conta e alguma loja
   * entregando, texto solto ou nenhum endereço salvo é 422
   * CHECKOUT_ENDERECO_SALVO_OBRIGATORIO, e endereço incompleto é 422
   * CHECKOUT_ENDERECO_INCOMPLETO (`resolverFretesDoCarrinho`, em
   * server/src/routes/v1/storefront.ts).
   */
  const bloqueioDoFechamento =
    bloqueioDaConta
    ?? (sessaoPortal && algumaEntrega && !enderecoSalvo
      ? 'Escolha ou cadastre o endereço de entrega.'
      : faltaNaEntrega.length > 0
        ? `Complete o endereço de entrega${
          enderecoDeEntregaEscolhido?.label ? ` "${enderecoDeEntregaEscolhido.label}"` : ''
        }: falta ${descreverFalta(faltaNaEntrega)}.`
        : null);

  /**
   * Pergunta ao servidor como este carrinho pode chegar ao cliente.
   *
   * Roda quando o carrinho ou o CEP mudam: opção cotada para outro carrinho
   * não vale para este, e deixar a antiga na tela mostraria um total que o
   * servidor vai recusar na hora de fechar.
   */
  const cotarFrete = useCallback(async () => {
    if (cart.length === 0) {
      setFrete(null);
      setErroFrete(false);
      setMudouNoCarrinho([]);
      return;
    }
    setCotandoFrete(true);
    setErroFrete(false);
    try {
      const r = await apiRequest<{ lojas: FreteDaLoja[]; itens?: ItemRevalidado[] }>(
        '/loja/checkout/frete',
        {
          method: 'POST',
          anonymous: true,
          body: {
            items: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
            zip: checkoutForm.zip,
          },
        },
      ).then((r) => exigirCampos(r, 'lojas'));
      /*
        A LISTA É NORMALIZADA NA ENTRADA, uma vez.

        `r.lojas` vem do servidor e o resto desta função a percorre com
        `for...of`. Um corpo sem a chave — servidor de outra versão, proxy que
        engoliu a resposta, 200 com página de erro — derrubaria a VITRINE, que
        é a tela do cliente. Normalizar aqui é o que faz o `catch` abaixo
        continuar sendo o único caminho de falha.
      */
      const lojas = Array.isArray(r.lojas) ? r.lojas : [];
      setFrete({ lojas });

      /*
        O CARRINHO ADOTA O PREÇO DO SERVIDOR.

        Esta chamada roda a cada mudança do carrinho e a cada abertura da
        gaveta — que é exatamente quando o cliente vai olhar os valores. O
        servidor acabou de dizer quanto custa cada item AGORA; guardar o
        número congelado ao lado dele seria escolher mostrar o errado.
      */
      const conferidos = r.itens ?? [];
      if (conferidos.length > 0) {
        /*
          A CONTA É FEITA AQUI, e não dentro do `setCart`.

          O React chama o atualizador `prev => ...` quando quiser — depois
          desta linha, e em modo estrito duas vezes. Colher os nomes lá
          dentro devolvia lista vazia para quem lê logo abaixo: o preço era
          trocado e o aviso nunca aparecia.
        */
        const mudaram: string[] = [];
        const revisto = cart
          .map((linha) => {
            const novo = conferidos.find((i) => i.productId === linha.product.id);
            if (!novo) return linha;
            if (
              novo.priceCents === linha.product.priceCents
              && novo.available === linha.product.available
            ) {
              return linha;
            }
            if (novo.priceCents !== linha.product.priceCents) mudaram.push(novo.name);
            return {
              ...linha,
              // A quantidade não pode passar do que existe agora: o servidor
              // recusaria no checkout, e é melhor dizer aqui.
              quantity: Math.min(linha.quantity, Math.max(0, novo.available)),
              product: {
                ...linha.product,
                priceCents: novo.priceCents,
                available: novo.available,
                // O preço mudou: o selo de promoção do produto congelado não
                // vale mais para ele.
                onSale: novo.priceCents < linha.product.basePriceCents,
              },
            };
          })
          .filter((linha) => linha.quantity > 0);

        /*
          O AVISO NÃO PODE SE APAGAR SOZINHO.

          Adotar o preço novo muda o carrinho, e mudar o carrinho dispara
          outra cotação — que agora encontra tudo igual. Zerar aqui apagaria a
          frase meio segundo depois de escrevê-la, e o cliente veria o total
          novo sem nunca ler por que ele mudou.
        */
        if (mudaram.length > 0) setMudouNoCarrinho(mudaram);
        // Só grava quando há o que gravar: `setCart` com um array novo e
        // igual dispararia outra cotação, e outra, sem fim.
        if (mudaram.length > 0 || revisto.length !== cart.length
          || revisto.some((l, i) => l !== cart[i])) {
          setCart(revisto);
        }
      }

      /*
        Se a opção escolhida sumiu da lista nova, volta para a primeira DAQUELA
        loja: manter a antiga selecionada mostraria um preço que não existe
        mais. E a escolha de uma loja não pode vazar para a outra — foi
        exatamente assim que o frete da primeira acabava no pedido da segunda.
      */
      setEntregaPorLoja((antes) => {
        const novo: Record<string, string> = {};
        for (const loja of lojas) {
          const atual = antes[loja.companyId];
          novo[loja.companyId] = loja.options.some((o) => o.method === atual)
            ? atual
            : (loja.options[0]?.method ?? 'retirada');
        }
        return novo;
      });
    } catch {
      setFrete(null);
      setErroFrete(true);
    } finally {
      setCotandoFrete(false);
    }
  }, [cart, checkoutForm.zip]);

  useEffect(() => {
    void cotarFrete();
    // `cotarFrete` muda a cada seleção; depender dela aqui daria laço.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, checkoutForm.zip]);

  /**
   * O carrinho, agrupado por loja.
   *
   * O checkout divide o pedido por operação — cada empresa entrega, cobra e
   * fatura por conta própria. Mostrar uma lista corrida esconderia isso até o
   * cliente receber dois pedidos e dois pagamentos sem entender por quê.
   */
  const porLoja = useMemo(() => {
    const grupos = new Map<string, { slug: string; storeName: string; linhas: CartLine[] }>();
    for (const linha of cart) {
      const chave = linha.product.storeSlug;
      const grupo = grupos.get(chave) ?? {
        slug: chave,
        storeName: linha.product.storeName,
        linhas: [],
      };
      grupo.linhas.push(linha);
      grupos.set(chave, grupo);
    }
    return [...grupos.values()].map((g) => ({
      ...g,
      subtotal: g.linhas.reduce((a, l) => a + l.product.priceCents * l.quantity, 0),
    }));
  }, [cart]);

  /*
    EM QUANTAS VEZES ESTE CARRINHO PODE IR NO CARTÃO (GAP-PRD-114).

    Cada loja do carrinho vira um pedido e uma cobrança; a escolha vale para
    todas, então o máximo é o menor entre elas — e nenhuma parcela abaixo da
    mínima. Com a cotação de frete na mão, o total de cada loja já inclui a
    entrega; antes dela, é o subtotal dos itens.
  */
  const lojasDoCarrinho: LojaDoCarrinho[] = frete?.lojas.length
    ? frete.lojas.map((l) => ({
        nome: l.storeName,
        totalCents: l.itemsCents + (escolhaDaLoja(l.companyId)?.priceCents ?? 0),
        teto: stores.find((s) => s.id === l.companyId)?.cardInstallmentsMax ?? null,
      }))
    : porLoja.map((g) => ({
        nome: g.storeName,
        totalCents: g.subtotal,
        teto: stores.find((s) => s.slug === g.slug)?.cardInstallmentsMax ?? null,
      }));
  const maxParcelas = metodoPagamento === 'cartao' ? maximoDeParcelas(lojasDoCarrinho) : 1;
  // Trocar de meio ou esvaziar o carrinho não pode deixar uma escolha que o
  // servidor recusaria: vale sempre o que ainda cabe.
  const parcelasEscolhidas = Math.min(parcelas, maxParcelas);

  /** O checkout com a chave desta tentativa: a do carrinho, ou a nova que o comprador escolheu. */
  const enviarCheckout = async (chave: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiRequest<{
        orders: { id: string; number: number; total_cents: number }[];
        payments: PaymentView[];
      }>('/loja/checkout', {
        method: 'POST',
        // `anonymous` só quer dizer "sem o Bearer do ERP". Com conta, vai o
        // token do PORTAL — é ele que põe o pedido na conta (GAP-PRD-043).
        anonymous: true,
        headers: sessaoPortal ? { 'x-portal-token': sessaoPortal.token } : undefined,
        idempotencyKey: chave,
        body: {
          customerName: checkoutForm.name,
          // O CPF/CNPJ é obrigatório para a cobrança: sem ele o provedor
          // recusa, e o pedido nasceria sem como ser pago. Com conta que já
          // tem documento, vai vazio: vale o da conta.
          customerDocument: checkoutForm.document,
          // Com conta, o e-mail do pedido é o da conta — o servidor ignora
          // qualquer outro.
          customerEmail: sessaoPortal ? undefined : checkoutForm.email,
          customerPhone: checkoutForm.phone,
          shippingZip: checkoutForm.zip,
          shippingAddress: algumaEntrega && usaEnderecoSalvo ? undefined : checkoutForm.address,
          shippingAddressId: algumaEntrega && usaEnderecoSalvo ? enderecoSalvo : undefined,
          // O endereço da nota (GAP-PRD-115): o pedido guarda o retrato dele.
          billingAddressId: sessaoPortal && enderecoDaNota ? enderecoDaNota : undefined,
          // Só as CHAVES, uma por loja. O preço é o que o servidor cotar de
          // novo agora — a tela não tem como cobrar um frete diferente do que
          // ele calculou, nem aplicar o de uma loja ao pedido da outra.
          shippingMethods: entregaPorLoja,
          paymentMethod: metodoPagamento,
          // Só o número: o valor de cada parcela é conta do provedor, e o teto
          // de cada loja é conferido de novo no servidor.
          installments: parcelasEscolhidas > 1 ? parcelasEscolhidas : undefined,
          // O código vai CRU; quem decide se vale e quanto desconta é o servidor.
          couponCode: cupom?.code,
          items: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        },
      }).then((r) => exigirCampos(r, 'orders', 'payments'));
      const numbers = result.orders.map((o) => `#${o.number}`).join(', ');
      setPagamentos(result.payments ?? []);
      setMessage({
        tone: 'ok',
        text:
          result.orders.length > 1
            ? `Pedidos ${numbers} registrados — um para cada loja. Cada um tem o próprio pagamento.`
            : `Pedido ${numbers} registrado. O pagamento é confirmado pelo provedor antes do envio.`,
      });
      setCart([]);
      setOrderKey(newOrderKey());
      setCupom(null);
      setCartOpen(false);
      await loadProducts();
    } catch (err) {
      /*
        A TENTATIVA JÁ REGISTROU PEDIDOS COM OUTRO CARRINHO (R2-IDEM).

        A chave só troca no sucesso: a resposta perdida seguida de um carrinho
        mudado (uma loja a menos, outro endereço) ouvia 422 a cada clique, com o
        texto do servidor. Agora a recusa é lida pelo código e vira a pergunta:
        voltar ao carrinho, ou registrar como pedido novo — nada é reenviado sem
        a escolha, porque o pedido anterior existe e está reservado.
      */
      if (ehTentativaJaRegistrada(err)) {
        const d = err.details as { orderNumbers?: unknown } | undefined;
        const numeros = Array.isArray(d?.orderNumbers)
          ? d.orderNumbers.filter((n): n is number => typeof n === 'number')
          : [];
        setTentativaReusada({ numeros });
        return;
      }
      // Sessão do portal vencida: a tela volta a pedir o login, e o carrinho
      // fica. Continuar "logado" na tela faria o próximo clique falhar igual.
      if (err instanceof ApiRequestError && err.status === 401 && sessaoPortal) {
        limparSessaoPortal();
        setSessaoPortal(null);
      }
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao finalizar o pedido.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitCheckout = (event: React.FormEvent) => {
    event.preventDefault();
    void enviarCheckout(orderKey);
  };

  /** "Registrar como pedido novo": o carrinho ATUAL, com chave nova — só por escolha. */
  const registrarComoPedidoNovo = () => {
    const nova = newOrderKey();
    setOrderKey(nova);
    setTentativaReusada(null);
    void enviarCheckout(nova);
  };

  const pedidosDaTentativa = (tentativaReusada?.numeros ?? []).map((n) => `#${n}`);

  /**
   * O CAMPO DE BUSCA — declarado uma vez, desenhado onde o negócio pede.
   *
   * Na IMPORTADORA ele abre a página: quem entra numa loja de variedades sabe
   * o que quer e procura, e enterrar a busca abaixo do herói faz o cliente
   * rolar por uma vitrine que não é o que ele veio buscar.
   *
   * Nas outras ele fica DEPOIS do herói: numa loja de moda, pedir que a pessoa
   * digite o nome de uma peça que ela ainda não viu é pedir o impossível.
   *
   * Um pedaço só, e não dois campos condicionais: dois divergiriam no primeiro
   * ajuste de placeholder, e o estado é o mesmo dos dois lados.
   */
  const campoDeBusca = (
    <input
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="Buscar produto…"
      aria-label="Buscar produto"
      className="w-full mb-3 px-4 py-3 text-[length:var(--gs-text-lg)] rounded-[var(--gs-radius)]
        border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
    />
  );

  const botaoCarrinho = (
    <button
      type="button"
      onClick={() => setCartOpen((v) => !v)}
      /*
        aria-expanded/controls: o botão abre e fecha uma seção, e sem os dois
        o leitor de tela ouve um botão que não diz o que fez. A tipografia
        acompanha o vizinho "Entre ou cadastre-se" (sm semibold) — eram dois
        botões colados com a mesma anatomia e letras diferentes.
      */
      aria-expanded={cartOpen}
      aria-controls="secao-carrinho"
      className="bg-white/15 hover:bg-white/25 border border-white/30 text-white
        text-[length:var(--gs-text-sm)] font-semibold
        rounded-[var(--gs-radius)] px-3 sm:px-4 py-2 cursor-pointer whitespace-nowrap"
    >
      Carrinho ({cart.reduce((a, l) => a + l.quantity, 0)}) · {formatCents(total)}
    </button>
  );

  const lojaAtual = lojaFixa ? stores.find((s) => s.slug === lojaFixa) : undefined;
  const marca: MarcaDaLoja | null = lojaAtual
    ? { slug: lojaAtual.slug, nome: lojaAtual.tradeName, logoUrl: lojaAtual.logoUrl ?? null }
    : null;

  return (
    <CascaDaLoja direita={botaoCarrinho} marca={marca}>
      {/*
        O ARRANJO fica no DOM porque ele é uma decisão de negócio, não um
        detalhe de estilo: dá para medir que a loja de moda não está saindo com
        a página da importadora, e dá para o CSS pendurar regra nele sem que
        nenhuma tela precise de condicional.
      */}
      <div data-testid="vitrine" data-arranjo={arranjo.id}>

        {message && (
          <div
            ref={bannerRef}
            role="status"
            className={`mb-5 px-4 py-3 rounded-[var(--gs-radius)] ${
              message.tone === 'ok'
                ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
                : 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
            }`}
          >
            {message.text}
          </div>
        )}

        {tentativaReusada && (
          <TentativaJaRegistrada
            titulo="Esta tentativa já registrou um pedido"
            rotuloDoVoltar="Voltar ao carrinho"
            onVoltar={() => setTentativaReusada(null)}
            rotuloDoNovo="Registrar como pedido novo"
            onNovo={registrarComoPedidoNovo}
            ocupado={busy}
            testId="loja-tentativa-reusada"
          >
            <p className="m-0">
              <strong>
                {pedidosDaTentativa.length > 1
                  ? `Esta tentativa já registrou os pedidos ${pedidosDaTentativa.join(' e ')}, com outro carrinho.`
                  : pedidosDaTentativa.length === 1
                    ? `Esta tentativa já registrou o pedido ${pedidosDaTentativa[0]}, com outro carrinho.`
                    : 'Esta tentativa já registrou um pedido, com outro carrinho.'}
              </strong>{' '}
              Nada foi registrado agora.
            </p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Se você quer comprar este carrinho também, registre-o como pedido novo. Se o pedido anterior era esta
              mesma compra antes de você mudar o carrinho ou o endereço, não registre de novo: ele já está reservado,
              aguardando o pagamento.
            </p>
          </TentativaJaRegistrada>
        )}

        {pagamentos.length > 0 && (
          <section className="mb-7 flex flex-col gap-4">
            {pagamentos.map((p) => (
              <PagamentoCard key={p.orderId} pagamento={p} />
            ))}
            {/*
              O caminho de volta ao pedido, que faltava: quem fecha a aba depois
              de pagar precisava achar o PIX de novo, e não tinha como. Na conta,
              o cliente vê o andamento e o pagamento — criando o acesso com o
              MESMO e-mail e CPF do pedido.
            */}
            <Link
              to="/minha-conta"
              className="self-start no-underline text-[var(--gs-purple-700)] font-semibold underline"
            >
              Acompanhe seus pedidos na sua conta →
            </Link>
          </section>
        )}

        {cartOpen && (
          <section
            id="secao-carrinho"
            className="mb-7 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] shadow-[var(--gs-shadow-md)] p-5"
          >
            <h2 className="text-[length:var(--gs-text-xl)] font-semibold text-[var(--gs-purple-900)] mt-0">
              Seu carrinho
            </h2>
            {/*
              O PREÇO MUDOU ENQUANTO A ABA ESTAVA ABERTA.

              O carrinho é guardado no navegador com o produto congelado
              dentro. A cotação de frete confere tudo com o servidor a cada
              abertura desta gaveta, e a tela adota o valor de agora — que é
              o que o checkout vai cobrar. Trocar em silêncio seria o mesmo
              defeito com outra cara: o cliente veria um total diferente do
              que leu, sem uma palavra.
            */}
            {avisoDoCarrinho && (
              <p
                role="status"
                className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                  text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] m-0"
              >
                {avisoDoCarrinho}
              </p>
            )}
            {mudouNoCarrinho.length > 0 && (
              <p
                role="status"
                className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                  text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] m-0"
              >
                {`O preço de ${mudouNoCarrinho.join(", ")} mudou desde que você colocou no `
                  + `carrinho. Os valores abaixo já são os de agora.`}
              </p>
            )}
            {cart.length === 0 ? (
              <p className="text-[var(--gs-muted)]">Carrinho vazio.</p>
            ) : (
              <>
                {/* Agrupado por loja porque o checkout divide por loja. Uma
                    lista corrida esconderia isso até o cliente ver dois
                    pedidos e dois pagamentos sem entender por quê. */}
                {porLoja.map((grupo) => (
                  <div key={grupo.slug} className="mb-4">
                    <h3
                      className="text-[length:var(--gs-text-xs)] uppercase tracking-wide
                        text-[var(--gs-purple-700)] font-semibold m-0 mb-1"
                    >
                      {grupo.storeName}
                    </h3>
                    <ul className="list-none p-0 m-0">
                      {grupo.linhas.map((line) => (
                        <li
                          key={line.product.id}
                          className="flex items-center justify-between gap-3 py-2 border-b border-[var(--gs-border)]"
                        >
                          <span>
                            <strong>{line.product.name}</strong>
                            <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                              {line.quantity} × {formatCents(line.product.priceCents)}
                            </span>
                          </span>
                          <button
                            type="button"
                            aria-label={`Remover ${line.product.name}`}
                            onClick={() =>
                              setCart((prev) =>
                                prev.filter((l) => l.product.id !== line.product.id),
                              )
                            }
                            /* px-2: o glifo sozinho era um alvo de ~16px —
                               miúdo demais para o dedo que quer só tirar UM
                               item, não errar no vizinho. */
                            className="bg-transparent border-0 text-[var(--gs-danger)] cursor-pointer px-2 py-1"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] text-right m-0 mt-1">
                      Subtotal {formatCents(grupo.subtotal)}
                    </p>
                  </div>
                ))}

                {porLoja.length > 1 && (
                  <p
                    role="status"
                    className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
                      text-[length:var(--gs-text-sm)] text-[var(--gs-info)] m-0"
                  >
                    Seu carrinho será dividido em <strong>{porLoja.length} pedidos</strong>, um para
                    cada loja — cada loja entrega e cobra separadamente.
                  </p>
                )}

                <form onSubmit={(e) => void submitCheckout(e)} className="grid gap-3 sm:grid-cols-3">
                  {/*
                    QUEM COMPRA (GAP-PRD-028/043). Com conta: os dados da conta,
                    pré-preenchidos. Loja que exige conta e ninguém entrou: o
                    convite para entrar, com o carrinho guardado. Loja aberta
                    para visitante: os campos soltos de sempre.
                  */}
                  {sessaoPortal ? (
                    <CompradorDaConta
                      sessao={sessaoPortal}
                      dados={checkoutForm}
                      onCampo={(c) => setCheckoutForm((f) => ({ ...f, ...c }))}
                      onPerfil={(p) =>
                        setCheckoutForm((f) => ({
                          ...f,
                          name: f.name || p.name || '',
                          phone: f.phone || p.phone || '',
                        }))
                      }
                      onBloqueio={setBloqueioDaConta}
                    />
                  ) : precisaEntrar ? (
                    <EntreParaComprar />
                  ) : (
                    <>
                  <input
                    required
                    placeholder="Seu nome"
                    aria-label="Nome"
                    value={checkoutForm.name}
                    onChange={(e) => setCheckoutForm({ ...checkoutForm, name: e.target.value })}
                    className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  />
                  <input
                    required
                    placeholder="CPF ou CNPJ"
                    aria-label="CPF ou CNPJ"
                    inputMode="numeric"
                    value={checkoutForm.document}
                    onChange={(e) =>
                      setCheckoutForm({ ...checkoutForm, document: e.target.value })
                    }
                    className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  />
                  <input
                    placeholder="Telefone"
                    aria-label="Telefone"
                    inputMode="tel"
                    value={checkoutForm.phone}
                    onChange={(e) => setCheckoutForm({ ...checkoutForm, phone: e.target.value })}
                    className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  />
                  {/* Obrigatório (GAP-PRD-191): é por ele que o pedido e o PIX
                      chegam, e o servidor recusa o pedido sem e-mail válido
                      antes de reservar o estoque. */}
                  <input
                    required
                    type="email"
                    placeholder="E-mail"
                    aria-label="E-mail"
                    value={checkoutForm.email}
                    onChange={(e) => setCheckoutForm({ ...checkoutForm, email: e.target.value })}
                    className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  />
                    </>
                  )}
                  <input
                    placeholder="CEP"
                    aria-label="CEP"
                    value={checkoutForm.zip}
                    onChange={(e) => setCheckoutForm({ ...checkoutForm, zip: e.target.value })}
                    className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  />

                  {/*
                    COMO CHEGA. Sem esta escolha o pedido nascia "entrega" com
                    frete zero, e a loja despachava de graça sem ninguém ver.
                  */}
                  <fieldset className="sm:col-span-3 border border-[var(--gs-border)]
                    rounded-[var(--gs-radius)] p-3 m-0">
                    <legend className="text-[length:var(--gs-text-sm)] font-semibold px-1">
                      Como você quer receber
                    </legend>



                    {cotandoFrete && (
                      <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        Calculando as formas de entrega…
                      </p>
                    )}

                    {!cotandoFrete && erroFrete && (
                      <div role="alert" className="text-[length:var(--gs-text-sm)]">
                        <p className="m-0 text-[var(--gs-danger)]">
                          Não foi possível calcular as formas de entrega.
                        </p>
                        <button
                          type="button"
                          aria-label="Tentar calcular de novo"
                          onClick={() => void cotarFrete()}
                          className="mt-1 bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                            rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold"
                        >
                          Tentar de novo
                        </button>
                      </div>
                    )}

                    {/*
                      UM BLOCO POR LOJA. Com duas operações no carrinho são
                      duas encomendas, de dois endereços — e o cliente escolhe
                      (e paga) o envio de cada uma. Com uma loja só, o título
                      da loja não aparece: seria ruído para o caso comum.
                    */}
                    {(frete?.lojas ?? []).map((loja) => (
                      <div key={loja.companyId} className="py-1">
                        {(frete?.lojas.length ?? 0) > 1 && (
                          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] font-semibold">
                            {loja.storeName}
                          </p>
                        )}
                        {loja.options.map((o) => (
                          <label
                            key={o.method}
                            className="flex items-center gap-2 py-1 cursor-pointer"
                          >
                            <input
                              type="radio"
                              name={`entrega-${loja.companyId}`}
                              value={o.method}
                              checked={entregaPorLoja[loja.companyId] === o.method}
                              onChange={() =>
                                setEntregaPorLoja((antes) => ({
                                  ...antes,
                                  [loja.companyId]: o.method,
                                }))
                              }
                            />
                            <span className="text-[length:var(--gs-text-sm)]">
                              <strong>{o.label}</strong>
                              {' — '}
                              {o.priceCents === 0 ? 'sem custo' : formatCents(o.priceCents)}
                              {/* Prazo só quando existe. Inventar data é dívida. */}
                              {o.estimatedDays !== null && (
                                <span className="text-[var(--gs-muted)]">
                                  {' '}· até {contar(o.estimatedDays, 'dia útil', 'dias úteis')} após a postagem
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                        {loja.deliveryUnavailable && (
                          <p
                            role="status"
                            className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
                          >
                            {loja.deliveryUnavailable.message}
                          </p>
                        )}
                      </div>
                    ))}


                    {/*
                      BASTA UMA loja entregar para o endereço ser obrigatório —
                      é o que o servidor cobra, loja por loja. Pedir só quando
                      TODAS entregam deixaria passar o carrinho misto, e o
                      checkout recusaria depois de o cliente já ter preenchido
                      tudo.
                    */}
                    {/* Com conta: os endereços salvos, o padrão já escolhido. */}
                    {algumaEntrega && sessaoPortal && (
                      <EnderecoDaConta
                        token={sessaoPortal.token}
                        enderecos={enderecosDaConta}
                        onCadastrado={recarregarEnderecos}
                        escolhido={enderecoSalvo}
                        onEscolher={(e) => {
                          setEnderecoSalvo(e?.id ?? null);
                          // O frete é cotado para o CEP do endereço escolhido.
                          if (e) setCheckoutForm((f) => (f.zip === e.zip ? f : { ...f, zip: e.zip }));
                        }}
                      />
                    )}
                    {/* O texto solto é do VISITANTE: com conta, o endereço é
                        um endereço salvo, e o pedido guarda o retrato dele. */}
                    {algumaEntrega && !sessaoPortal && (
                      <input
                        required
                        placeholder="Endereço completo com número, bairro e cidade"
                        aria-label="Endereço de entrega"
                        value={checkoutForm.address}
                        onChange={(e) =>
                          setCheckoutForm({ ...checkoutForm, address: e.target.value })
                        }
                        className="mt-2 w-full px-3 py-2 rounded-[var(--gs-radius)]
                          border border-[var(--gs-border-strong)]"
                      />
                    )}
                  </fieldset>

                  {/* O endereço da nota fiscal (GAP-PRD-115) — só com conta:
                      do visitante a loja não guarda endereço estruturado. */}
                  {sessaoPortal && (
                    <FaturamentoDaConta
                      token={sessaoPortal.token}
                      enderecos={enderecosDaConta}
                      entrega={algumaEntrega ? enderecoSalvo : null}
                      escolhido={enderecoDaNota}
                      onEscolher={setEnderecoDaNota}
                      onCadastrado={recarregarEnderecos}
                    />
                  )}

                  {/* Como pagar. O cartão abre a página segura do provedor —
                      o número do cartão nunca passa pela loja. */}
                  <fieldset className="sm:col-span-3 border-0 p-0 m-0">
                    <legend className="text-[length:var(--gs-text-sm)] font-semibold mb-1">
                      Forma de pagamento
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          ['pix', 'PIX'],
                          ['boleto', 'Boleto'],
                          ['cartao', 'Cartão de crédito'],
                        ] as const
                      ).map(([valor, rotulo]) => (
                        /*
                          O rádio é sr-only (1px, clipado): o anel global de
                          :focus-visible caía NELE e ficava invisível — quem
                          navega por teclado não sabia qual pílula segurava o
                          foco. O rádio vira `peer` e a pílula visível (o
                          <span>) reage com peer-focus-visible.
                        */
                        <label key={valor} className="cursor-pointer">
                          <input
                            type="radio"
                            name="metodo-pagamento"
                            value={valor}
                            checked={metodoPagamento === valor}
                            onChange={() => setMetodoPagamento(valor)}
                            className="sr-only peer"
                          />
                          <span
                            className={`inline-block px-3 py-2 rounded-[var(--gs-radius)] border
                              text-[length:var(--gs-text-sm)]
                              peer-focus-visible:outline peer-focus-visible:outline-2
                              peer-focus-visible:outline-offset-2
                              peer-focus-visible:outline-[var(--gs-focus-ring)] ${
                              metodoPagamento === valor
                                ? 'bg-[var(--gs-purple-700)] text-white border-transparent'
                                : 'bg-[var(--gs-surface)] border-[var(--gs-border-strong)]'
                            }`}
                          >
                            {rotulo}
                          </span>
                        </label>
                      ))}
                    </div>
                    {metodoPagamento === 'cartao' && (
                      <p className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        Você digita o cartão na página segura do provedor — a loja nunca vê o
                        número, e nada fica salvo.
                      </p>
                    )}
                    {/*
                      A ESCOLHA DAS PARCELAS (GAP-PRD-114). O selo "Parcele em
                      até Nx" existia e o checkout não perguntava nada: a
                      cobrança nascia à vista. Só aparece quando o carrinho
                      inteiro comporta mais de 1x.
                    */}
                    {metodoPagamento === 'cartao' && maxParcelas > 1 && (
                      <label className="flex flex-col gap-1 mt-2 max-w-xs">
                        <span className="text-[length:var(--gs-text-sm)] font-semibold">Parcelas</span>
                        <select
                          value={parcelasEscolhidas}
                          onChange={(e) => setParcelas(Number(e.target.value))}
                          className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                            bg-[var(--gs-surface)]"
                        >
                          {Array.from({ length: maxParcelas }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>
                              {lojasDoCarrinho.length === 1
                                ? descreverParcelas(lojasDoCarrinho[0].totalCents, n)
                                : n === 1
                                  ? 'À vista'
                                  : `${n}x`}
                            </option>
                          ))}
                        </select>
                        {lojasDoCarrinho.length > 1 && parcelasEscolhidas > 1 && (
                          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                            {lojasDoCarrinho
                              .map((l) => `${l.nome}: ${descreverParcelas(l.totalCents, parcelasEscolhidas)}`)
                              .join(' · ')}
                          </span>
                        )}
                      </label>
                    )}
                  </fieldset>

                  {/*
                    flex-wrap + botão de largura cheia em base: no celular os
                    três filhos disputavam ~327px — e o total do formatCents é
                    UMA palavra (espaço não-separável), que não quebra.
                  */}
                  <CupomDoCarrinho
                    itens={cart.map((l) => ({ productId: l.product.id, quantity: l.quantity }))}
                    portalToken={sessaoPortal?.token ?? null}
                    email={sessaoPortal ? undefined : checkoutForm.email}
                    aplicado={cupom}
                    onAplicado={setCupom}
                    quantasLojas={porLoja.length}
                  />

                  <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-4">
                    <strong className="text-[length:var(--gs-text-xl)] text-[var(--gs-orange-600)]">
                      {/* Itens e frete separados: total só com o somatório
                          esconde quanto o envio custou. */}
                      {(freteCents > 0 || descontoDoCupom > 0) && (
                        <span className="block text-[length:var(--gs-text-sm)] font-normal
                          text-[var(--gs-muted)]">
                          Itens {formatCents(totalItens)}
                          {descontoDoCupom > 0 ? ` − cupom ${formatCents(descontoDoCupom)}` : ''}
                          {freteCents > 0 ? ` + entrega ${formatCents(freteCents)}` : ''}
                        </span>
                      )}
                      Total {formatCents(total)}
                    </strong>
                    {/*
                      Contrato de adesão avisado ANTES do clique (CDC): quem
                      finaliza sabe a que está aderindo, com os textos a um
                      toque de distância.
                    */}
                    <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      Ao finalizar, você concorda com os{' '}
                      <Link to="/termos-de-uso" target="_blank">Termos de Uso</Link> e a{' '}
                      <Link to="/trocas-e-devolucoes" target="_blank">
                        Política de Trocas e Devoluções
                      </Link>
                      .
                    </span>
                    {bloqueioDoFechamento && sessaoPortal && (
                      <p role="status" className="w-full m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                        {bloqueioDoFechamento}
                      </p>
                    )}
                    <button
                      type="submit"
                      disabled={busy || precisaEntrar || Boolean(sessaoPortal && bloqueioDoFechamento)}
                      className="w-full sm:w-auto bg-[var(--gs-orange-500)] hover:bg-[var(--gs-orange-600)]
                        text-white border-0 rounded-[var(--gs-radius)] px-6 py-3 font-semibold
                        cursor-pointer disabled:opacity-50"
                    >
                      Finalizar pedido ({metodoPagamento === 'pix' ? 'PIX' : metodoPagamento === 'boleto' ? 'Boleto' : 'Cartão'})
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        )}

        {/*
          NA IMPORTADORA A BUSCA ABRE A PÁGINA. É a única em que ela vem antes
          do herói: quem entra numa loja de variedades chega procurando, e a
          vitrine que ele quer ver é o resultado da busca dele.

          O campo só é MONTADO depois de o arranjo ser conhecido (ver
          `arranjoConhecido`). Montá-lo antes o faria pular de lugar quando a
          lista de lojas chegasse — e pular de lugar, em React, é destruir e
          recriar: quem começasse a digitar perderia o texto e o cursor.

          Ordenar por CSS resolveria o pulo e criaria outro problema: `order`
          muda a ordem VISUAL e não a de LEITURA, então o Tab e o leitor de
          tela continuariam achando a busca antes do herói.
        */}
        {arranjoConhecido && arranjo.buscaPrimeiro && campoDeBusca}

        {lojaFixa ? (
          /*
            O HERÓI DA MARCA: capa (se o gestor enviou), chamada e faixa.
            A paleta inteira já veio pelo data-marca da casca — aqui é só o
            conteúdo. Loja sem capa não mostra buraco: o herói encolhe.
          */
          (() => {
            /*
              As lojas falhando NÃO podem sumir com o herói em silêncio: antes
              o catch deixava `stores` vazio para sempre — sem busca, sem
              identidade, sem aviso. O erro fala e oferece a volta; a vitrine
              de produtos, que vem de outro endpoint, continua embaixo.
            */
            if (statusLojas === 'erro') {
              return (
                <section className="mb-7 bg-[var(--gs-danger-bg)] border border-[var(--gs-danger)] rounded-[var(--gs-radius)] p-6 text-center">
                  <p className="text-[var(--gs-danger)] font-semibold m-0">
                    Não foi possível carregar as lojas agora.
                  </p>
                  <button
                    type="button"
                    aria-label="Tentar carregar as lojas de novo"
                    onClick={() => void carregarLojas()}
                    className="mt-3 bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                      rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
                  >
                    Tentar de novo
                  </button>
                </section>
              );
            }
            const atual = stores.find((s) => s.slug === lojaFixa);
            if (statusLojas === 'pronto' && !atual) {
              return (
                <section className="mb-7 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-10 text-center">
                  <p className="text-[length:var(--gs-text-lg)] font-semibold m-0">
                    Esta loja não existe.
                  </p>
                  <Link to="/loja" className="text-[var(--gs-purple-700)] underline">
                    Ver as lojas do Grupo Sampaio
                  </Link>
                </section>
              );
            }
            if (!atual) return null;
            /*
              O HERÓI PRECISA FUNCIONAR VAZIO — porque vazio é o estado real.

              Nenhuma das cinco lojas do grupo tem capa, chamada ou descrição
              no banco. O herói anterior só desenhava o que estivesse
              preenchido, então na prática ele era uma seção invisível: um
              herói que ninguém nunca viu.

              Agora ele sempre diz QUE LOJA É ESSA e QUE NEGÓCIO ELA FAZ. O
              nome vem do cadastro; a segunda linha é a chamada do gestor
              quando existe, e a frase do tipo de negócio quando não — que o
              sistema sabe sem ninguém digitar. Nada inventado: "Moda e
              vestuário" é o que a Gringa é.
            */
            return (
              <section className="mb-7" data-testid="heroi-da-loja">
                {atual.coverUrl && !capaQuebrada && (
                  <img
                    src={coreApi.imageUrl(atual.coverUrl)}
                    alt={`Capa da ${atual.tradeName}`}
                    /*
                      Altura FIXA por breakpoint, não max-h: com a altura vinda
                      da imagem, o herói tinha altura zero até a capa chegar e
                      empurrava título, WhatsApp e selos ao carregar — e cada
                      loja sairia com um herói de altura diferente conforme o
                      arquivo enviado. Capa morta some sem deixar buraco: o
                      herói já funciona sem capa, que é o estado de hoje.
                    */
                    className="w-full h-40 sm:h-56 object-cover rounded-[var(--gs-radius-lg)] mb-3"
                    onError={() => setCapaQuebrada(true)}
                  />
                )}
                {atual.bannerText && (
                  <p className="m-0 mb-2 px-3 py-1.5 rounded-[var(--gs-radius)] font-semibold bg-[var(--gs-purple-700)] text-white inline-block">
                    {atual.bannerText}
                  </p>
                )}
                <h1 className="m-0 font-bold text-[length:var(--gs-text-2xl)] text-[var(--gs-purple-900)] leading-tight">
                  {atual.tradeName}
                </h1>
                <p className="m-0 mt-1 text-[length:var(--gs-text-lg)] text-[var(--gs-purple-800)]">
                  {atual.headline ?? arranjo.chamadaPadrao}
                </p>
                {atual.description && (
                  <p className="m-0 mt-1 text-[var(--gs-muted)]">{atual.description}</p>
                )}

                {/*
                  O WHATSAPP QUE O GESTOR DIGITAVA PARA NINGUÉM.

                  A tela do painel diz, no campo, "Aparece para o cliente falar
                  com a loja" — e nenhuma tela pública o mostrava. O dono
                  preenchia acreditando que o cliente veria; o único leitor de
                  verdade era o rodapé da ordem de serviço impressa.

                  Duas saídas eram possíveis: rebaixar o texto do painel para
                  dizer a verdade, ou cumprir a promessa. Cumprir é o certo —
                  loja de bairro vende por WhatsApp, o dado existe, e esconder
                  o botão é jogar fora o canal que mais converte em Pelotas.

                  Só o dígito vai para o link: o dono digita "53 99999-0000" e
                  o wa.me não aceita nada além de número.
                */}
                {atual.whatsapp && (
                  <a
                    href={`https://wa.me/55${atual.whatsapp.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 mt-3 px-4 py-2 no-underline
                      rounded-[var(--gs-radius)] font-semibold
                      bg-[var(--gs-purple-700)] text-white"
                  >
                    Falar com a {atual.tradeName} no WhatsApp
                  </a>
                )}

                {/*
                  OS SELOS vêm prontos do servidor, e a tela não acrescenta
                  nenhum. Cada selo é uma afirmação que o cliente leva a sério:
                  "frete grátis acima de R$ 200" que a loja não cumpre é
                  cobrança surpresa no fim do checkout. Lista vazia = sem faixa,
                  porque faixa vazia ocupa espaço e não diz nada.
                */}
                {(atual.seals?.length ?? 0) > 0 && (
                  <ul
                    data-testid="selos-da-loja"
                    className="list-none flex flex-wrap gap-2 p-0 m-0 mt-3"
                  >
                    {atual.seals!.map((selo) => (
                      <li
                        key={selo.id}
                        className="text-[length:var(--gs-text-sm)] font-semibold px-3 py-1 rounded-full
                          bg-[var(--gs-purple-100)] text-[var(--gs-purple-800)]
                          border border-[var(--gs-border)]"
                      >
                        {selo.label}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })()
        ) : (
          <section className="mb-7">
            <h2 className="text-[length:var(--gs-text-xl)] font-semibold text-[var(--gs-purple-900)] mt-0 mb-3">
              Nossas lojas
            </h2>
            {/* Cada loja É um endereço: o card NAVEGA para a página da marca,
                com a cara dela. Capa e logo vêm do painel do gestor; sem capa,
                o topo do card fica tipográfico — nada de buraco cinza nem de
                card torto ao lado de quem já tem capa. A Oficina não entra na
                vitrine — decisão do dono. */}
            {statusLojas === 'carregando' ? (
              <p role="status" className="text-[var(--gs-muted)] m-0">
                Carregando as lojas…
              </p>
            ) : statusLojas === 'erro' ? (
              <div className="bg-[var(--gs-danger-bg)] border border-[var(--gs-danger)] rounded-[var(--gs-radius)] p-6 text-center">
                <p className="text-[var(--gs-danger)] font-semibold m-0">
                  Não foi possível carregar as lojas agora.
                </p>
                <button
                  type="button"
                  aria-label="Tentar carregar as lojas de novo"
                  onClick={() => void carregarLojas()}
                  className="mt-3 bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                    rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
                >
                  Tentar de novo
                </button>
              </div>
            ) : (
              <div
                className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
                data-testid="cards-das-lojas"
              >
                {stores.map((store) => (
                  <Link
                    key={store.slug}
                    to={`/${store.slug}`}
                    className="no-underline text-[var(--gs-text)] bg-[var(--gs-surface)] border
                      border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] overflow-hidden
                      shadow-[var(--gs-shadow)] hover:shadow-[var(--gs-shadow-md)]
                      hover:border-[var(--gs-purple-700)] flex flex-col"
                  >
                    <CapaDoCardDeLoja store={store} />
                    <div className="p-4 flex items-center gap-3">
                      {store.logoUrl && (
                        <img
                          src={coreApi.imageUrl(store.logoUrl)}
                          alt=""
                          aria-hidden
                          loading="lazy"
                          decoding="async"
                          className="h-12 w-12 rounded-full object-cover border border-[var(--gs-border)]"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="m-0 font-bold text-[length:var(--gs-text-lg)]">{store.tradeName}</p>
                        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] truncate">
                          {store.headline ?? contar(store.productCount, 'produto online', 'produtos online')}
                        </p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}

        {/*
          OFERTAS. Na home são as do GRUPO inteiro; na página da marca, as
          DAQUELA loja — e é a mesma consulta, que já recebia o slug e tinha o
          resultado jogado fora (rodada 56). A Gringa tinha produto em promoção
          e a vitrine dela não dizia em lugar nenhum.

          Some quando não há oferta: seção vazia é promessa quebrada.
        */}
        {ofertas.length > 0 && pagina === 0 && !search.trim() && !categoria && (
          /*
            Título no MESMO degrau de "Nossas lojas" (xl): seções irmãs em
            degraus diferentes eram acidente, não hierarquia. E a moldura da
            foto segue a PROPORÇÃO do negócio — medido na tela, a grade da
            Gringa saía em 3/4 e a oferta, o mesmo produto uma seção acima,
            saía quadrada.
          */
          <section aria-label="Ofertas" className="mb-7">
            <h2 className="text-[length:var(--gs-text-xl)] font-semibold text-[var(--gs-orange-600)] mb-3">
              Ofertas
            </h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {ofertas.map((d) => (
                <Link
                  key={d.id}
                  to={`/loja/${d.storeSlug}/produto/${d.id}`}
                  className="shrink-0 w-40 no-underline text-[var(--gs-text)]"
                >
                  <FotoDeProduto
                    url={d.imageUrl}
                    alt={d.name}
                    loja={d.storeName}
                    proporcao={arranjo.proporcao}
                    testId={`sem-foto-${d.id}`}
                  />
                  <p className="text-[length:var(--gs-text-sm)] font-semibold mt-1 mb-0 line-clamp-2">
                    {d.name}
                    {/*
                      A loja do produto só existia dentro do lugar da foto,
                      que é aria-hidden — na home do GRUPO, onde o carrossel
                      mistura as cinco lojas, quem usa leitor de tela ouvia
                      "Jaqueta, R$ 246,75" sem saber de quem é. O card da
                      grade diz a loja em texto; aqui ela entra invisível,
                      porque o espaço de 160px não comporta mais uma linha.
                    */}
                    <span className="sr-only"> — {d.storeName}</span>
                  </p>
                  <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] line-through m-0">
                    {formatCents(d.basePriceCents)}
                  </p>
                  {/* O preço um degrau ACIMA do nome: é o número que decide, e
                      empatado com o nome ele desaparecia no card. */}
                  <p className="text-[length:var(--gs-text-base)] text-[var(--gs-orange-600)] font-bold m-0">
                    {formatCents(d.priceCents)}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {arranjoConhecido && !arranjo.buscaPrimeiro && campoDeBusca}

        {/*
          OS DEPARTAMENTOS, EM DOIS NÍVEIS (rodada 56).

          Era uma fila de pílulas achatada: "Camisas", que é galho de
          "Vestuário", aparecia ao lado do próprio pai como se fossem irmãos.
          A árvore já existia no escritório — o cadastro de produto escolhe a
          categoria a partir dela — e a loja mostrava texto solto.

          O galho só aparece DEPOIS de o departamento ser escolhido, que é
          como uma loja funciona: o cliente entra no corredor e só então vê as
          prateleiras. Mostrar todos os galhos de uma vez encheria a tela de
          opções antes de ele decidir o corredor.

          A CONTAGEM vem junto porque é o que faz alguém entrar: "Vestuário"
          sozinho não diz se tem três peças ou trezentas.
        */}
        {categorias.length > 0 && (
          <div className="mb-4">
            {/*
              No celular a fila vira FAIXA ROLÁVEL: 6+ departamentos com
              contagem são 3–5 linhas de pílulas em 375px — empilhadas em cima
              dos filtros, empurravam o primeiro produto para duas telas de
              rolagem. Rolar de lado é o gesto que toda loja mobile ensina; no
              md volta a quebrar linha.
            */}
            <nav
              aria-label="Departamentos"
              /* p-1 -m-1: o anel de foco tem 2px e 2px de deslocamento, e o
                 overflow-x-auto cortava o de cima e o dos lados — quem navega
                 por teclado perdia de vista a pílula focada. O respiro entra
                 por padding e sai por margem negativa: layout intacto. */
              className="flex gap-2 overflow-x-auto p-1 -m-1 md:flex-wrap md:overflow-x-visible"
            >
              <button
                type="button"
                onClick={() => setCategoria(null)}
                aria-pressed={categoria === null}
                className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[length:var(--gs-text-sm)] cursor-pointer border ${
                  categoria === null
                    ? 'bg-[var(--gs-purple-700)] text-white border-[var(--gs-purple-700)]'
                    : 'bg-[var(--gs-surface)] border-[var(--gs-border-strong)]'
                }`}
              >
                Todos
              </button>
              {categorias.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setCategoria(c.name)}
                  aria-pressed={categoria === c.name}
                  className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[length:var(--gs-text-sm)] cursor-pointer border ${
                    categoria === c.name
                      ? 'bg-[var(--gs-purple-700)] text-white border-[var(--gs-purple-700)]'
                      : 'bg-[var(--gs-surface)] border-[var(--gs-border-strong)]'
                  }`}
                >
                  {c.name}
                  <span className="opacity-70"> ({c.productCount})</span>
                </button>
              ))}
            </nav>

            {(() => {
              const aberto = categorias.find((c) => c.name === categoria);
              if (!aberto || aberto.children.length === 0) return null;
              return (
                <nav
                  aria-label={`Dentro de ${aberto.name}`}
                  className="flex gap-2 mt-2 overflow-x-auto p-1 md:flex-wrap md:overflow-x-visible"
                >
                  <button
                    type="button"
                    onClick={() => setSubcategoria(null)}
                    aria-pressed={subcategoria === null}
                    className={`shrink-0 whitespace-nowrap px-3 py-1 rounded-full text-[length:var(--gs-text-sm)] cursor-pointer border ${
                      subcategoria === null
                        ? 'bg-[var(--gs-purple-100)] border-[var(--gs-purple-700)] text-[var(--gs-purple-800)] font-semibold'
                        : 'bg-[var(--gs-surface)] border-[var(--gs-border)]'
                    }`}
                  >
                    Tudo em {aberto.name}
                  </button>
                  {aberto.children.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => setSubcategoria(f.name)}
                      aria-pressed={subcategoria === f.name}
                      className={`shrink-0 whitespace-nowrap px-3 py-1 rounded-full text-[length:var(--gs-text-sm)] cursor-pointer border ${
                        subcategoria === f.name
                          ? 'bg-[var(--gs-purple-100)] border-[var(--gs-purple-700)] text-[var(--gs-purple-800)] font-semibold'
                          : 'bg-[var(--gs-surface)] border-[var(--gs-border)]'
                      }`}
                    >
                      {f.name}
                      <span className="opacity-70"> ({f.productCount})</span>
                    </button>
                  ))}
                </nav>
              );
            })()}
          </div>
        )}

        {/* Vitrine de destaques: o que o gestor marcou como destaque, rolando
            na horizontal. Só aparece na primeira página e sem busca ativa —
            senão competiria com o resultado que a pessoa pediu. */}
        {destaques.length > 0 && pagina === 0 && !search.trim() && !categoria && (
          <section aria-label="Destaques" className="mb-7">
            <h2 className="text-[length:var(--gs-text-xl)] font-semibold text-[var(--gs-purple-900)] mb-3">
              Destaques
            </h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {destaques.map((d) => (
                <Link
                  key={d.id}
                  to={`/loja/${d.storeSlug}/produto/${d.id}`}
                  className="shrink-0 w-40 no-underline text-[var(--gs-text)]"
                >
                  <FotoDeProduto
                    url={d.imageUrl}
                    alt={d.name}
                    loja={d.storeName}
                    proporcao={arranjo.proporcao}
                    testId={`sem-foto-${d.id}`}
                  />
                  <p className="text-[length:var(--gs-text-sm)] font-semibold mt-1 mb-0 line-clamp-2">
                    {d.name}
                    {/* Ver a nota no carrossel de Ofertas: a loja só vivia
                        dentro do quadro decorativo. */}
                    <span className="sr-only"> — {d.storeName}</span>
                  </p>
                  <p className="text-[length:var(--gs-text-base)] text-[var(--gs-orange-600)] font-bold m-0">
                    {d.hasVariants ? (
                      <span className="text-[length:var(--gs-text-xs)] font-normal text-[var(--gs-muted)]">
                        a partir de{' '}
                      </span>
                    ) : null}
                    {formatCents(d.priceCents)}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/*
          NO CELULAR OS FILTROS FICAM ATRÁS DE UM BOTÃO. Medido em 375px: o
          preço + a ordenação eram mais duas linhas na pilha que enterrava o
          primeiro produto a duas telas de rolagem. Recolher por CSS (hidden,
          não desmontar) preserva o que foi digitado; `order` foi descartado
          na rodada 56 porque separa a ordem visual da de leitura.
        */}
        <button
          type="button"
          onClick={() => setFiltrosAbertos((v) => !v)}
          aria-expanded={filtrosAbertos}
          aria-controls="loja-filtros"
          className="md:hidden mb-2 px-3 py-2 rounded-[var(--gs-radius)] border
            border-[var(--gs-border-strong)] bg-[var(--gs-surface)] cursor-pointer
            text-[length:var(--gs-text-sm)] font-semibold"
        >
          Filtrar e ordenar{filtrosAtivos > 0 ? ` (${filtrosAtivos})` : ''}
        </button>

        {/* A faixa é em reais porque é o que o cliente pensa. O servidor filtra
            pelo preço COM promoção — item de R$ 120 por R$ 80 tem que aparecer
            em "até R$ 100", que é onde a pessoa está procurando. */}
        <div
          id="loja-filtros"
          className={`${filtrosAbertos ? 'flex' : 'hidden'} md:flex flex-wrap items-end gap-3 mb-4`}
          data-testid="loja-filtros"
        >
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">De R$</span>
            <input
              inputMode="decimal"
              aria-label="Preço mínimo"
              value={filtro.min}
              onChange={(e) => setFiltro({ ...filtro, min: e.target.value })}
              className="w-28 px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">até R$</span>
            <input
              inputMode="decimal"
              aria-label="Preço máximo"
              value={filtro.max}
              onChange={(e) => setFiltro({ ...filtro, max: e.target.value })}
              className="w-28 px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Ordenar por</span>
            <select
              aria-label="Ordenar por"
              value={filtro.sort}
              onChange={(e) => setFiltro({ ...filtro, sort: e.target.value })}
              className="px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
            >
              <option value="nome">Nome</option>
              <option value="menor_preco">Menor preço</option>
              <option value="maior_preco">Maior preço</option>
              <option value="promocoes">Promoções primeiro</option>
            </select>
          </label>

          {(filtro.min || filtro.max || filtro.sort !== 'nome') && (
            <button
              type="button"
              onClick={() => setFiltro({ min: '', max: '', sort: 'nome' })}
              className="px-3 py-2 rounded-[var(--gs-radius)] bg-transparent
                border border-[var(--gs-border-strong)] cursor-pointer"
            >
              Limpar filtros
            </button>
          )}
        </div>

        {statusVitrine === 'carregando' ? (
          <div
            role="status"
            className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-10 text-center"
          >
            <p className="text-[var(--gs-muted)] m-0">Carregando a vitrine…</p>
          </div>
        ) : statusVitrine === 'erro' ? (
          <div
            role="alert"
            className="bg-[var(--gs-danger-bg)] border border-[var(--gs-danger)] rounded-[var(--gs-radius)] p-10 text-center"
          >
            <p className="text-[var(--gs-danger)] font-semibold m-0">
              Não foi possível carregar a loja agora.
            </p>
            <button
              type="button"
              /* Recarrega TUDO que pode ter caído junto — ofertas, destaques
                 e departamentos somem em silêncio quando falham, e um botão
                 que promete "tentar de novo" curando só a grade deixa a
                 página pela metade sem dizer. */
              onClick={() => {
                carregarColecoes();
                void loadProducts();
              }}
              className="mt-3 bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
            >
              Tentar de novo
            </button>
          </div>
        ) : products.length === 0 ? (
          <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-10 text-center">
            <p className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] m-0">
              {search.trim() || categoria || filtro.min || filtro.max
                ? 'Nada encontrado com esses filtros'
                : 'Nenhum produto disponível no momento.'}
            </p>
            {/* Frase de CLIENTE, não de administrador: quem compra não sabe o
                que é "marcar para venda online no ERP" e lia que a loja estava
                quebrada. A instalação nova nasce assim — sem produto. */}
            <p className="text-[var(--gs-muted)] mt-1 mb-0">
              {search.trim() || categoria || filtro.min || filtro.max
                ? 'Tente outra palavra ou limpe os filtros.'
                : 'Volte em breve para conferir as novidades.'}
            </p>
            {/*
              A frase acima manda limpar — e a tela antes não oferecia o
              botão: o cliente tinha de achar o campo lá em cima, apagar a
              busca na mão, desmarcar a pílula e zerar os dois preços. A mesma
              família do hint do WhatsApp da rodada 56: texto prometendo o que
              a tela não faz.
            */}
            {(search.trim() || categoria || filtro.min || filtro.max) && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setCategoria(null);
                  setSubcategoria(null);
                  setFiltro({ min: '', max: '', sort: 'nome' });
                }}
                className="mt-3 bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
              >
                Limpar a busca e os filtros
              </button>
            )}
          </div>
        ) : (
          /*
            gap-4 e raio-lg: a MESMA página usava gap-5 só aqui e 8px de raio
            no card de produto contra 12px no card de loja — divergência por
            acidente, não por desenho.
          */
          <ul className={`list-none p-0 m-0 grid gap-4 ${classesDaGrade(arranjo)}`}>
            {products.map((product) => (
              <li
                key={product.id}
                className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
                  rounded-[var(--gs-radius-lg)] shadow-[var(--gs-shadow)] overflow-hidden flex flex-col"
              >
                {/*
                  ZERO dos produtos publicados do grupo tem foto — e no dia em
                  que as fotos chegarem, a que falhar volta sozinha para o
                  lugar da foto, na mesma moldura (rodada 57).
                */}
                <FotoDeProduto
                  url={product.imageUrl}
                  alt={product.name}
                  loja={product.storeName}
                  proporcao={arranjo.proporcao}
                  testId={`sem-foto-${product.id}`}
                />
                <div className="p-4 flex flex-col gap-1 flex-1">
                  <span className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-purple-700)]">
                    {product.storeName}
                  </span>
                  {/* line-clamp-2 como nos carrosséis: um nome de três linhas
                      desalinhava a grade inteira. */}
                  <strong className="text-[length:var(--gs-text-base)] line-clamp-2">{product.name}</strong>
                  {product.onSale && (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] line-through">
                      {formatCents(product.basePriceCents)}
                    </span>
                  )}
                  <strong
                    className={`text-[length:var(--gs-text-xl)] ${
                      product.onSale
                        ? 'text-[var(--gs-orange-600)]'
                        : 'text-[var(--gs-purple-900)]'
                    }`}
                  >
                    {/* "a partir de" quando é grade: o preço é o da variante
                        mais barata, e o cliente escolhe o tamanho na página. */}
                    {product.hasVariants && (
                      <span className="text-[length:var(--gs-text-sm)] font-normal text-[var(--gs-muted)]">
                        a partir de{' '}
                      </span>
                    )}
                    {formatCents(product.priceCents)}
                  </strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-auto">
                    {product.available > 0
                      ? contar(product.available, 'disponível', 'disponíveis')
                      : 'Indisponível'}
                  </span>
                  {/* O card leva à PÁGINA do produto. Jogar direto no
                      carrinho é vender às cegas: quem compra online quer ver o
                      item, as opções e se chega em casa antes de decidir. */}
                  <div className="mt-2 flex gap-2">
                    <Link
                      to={`/loja/${product.storeSlug}/produto/${product.id}`}
                      /*
                        sm + nowrap: medido no celular, "Ver produto" quebrava
                        em duas linhas no card de 152px — botão de duas linhas
                        lê como defeito. Em base o rótulo encurta para "Ver";
                        o destino é o mesmo e o aria-label diz por extenso.
                      */
                      aria-label={
                        product.hasVariants
                          ? `Escolher ${product.name}`
                          : `Ver ${product.name}`
                      }
                      className="flex-1 text-center bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)]
                        text-white no-underline rounded-[var(--gs-radius)] px-3 py-2 font-semibold
                        text-[length:var(--gs-text-sm)] whitespace-nowrap"
                    >
                      {product.hasVariants ? (
                        'Escolher'
                      ) : (
                        <>
                          <span className="min-[480px]:hidden">Ver</span>
                          <span className="hidden min-[480px]:inline">Ver produto</span>
                        </>
                      )}
                    </Link>
                    {/* Grade não entra direto no carrinho: qual tamanho? A
                        escolha acontece na página do produto. */}
                    {!product.hasVariants && (
                      <button
                        type="button"
                        disabled={product.available <= 0}
                        onClick={() => addToCart(product)}
                        aria-label={`Adicionar ${product.name} ao carrinho`}
                        className="bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                          disabled:opacity-40 disabled:cursor-not-allowed
                          rounded-[var(--gs-radius)] px-3 py-2 cursor-pointer font-semibold"
                      >
                        +
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Paginação: só aparece quando há mais de uma página. "1–12 de 48". */}
        {statusVitrine === 'pronto' && totalProdutos > POR_PAGINA && (
          <nav
            aria-label="Paginação"
            className="mt-6 flex flex-wrap items-center justify-center gap-4"
          >
            <button
              type="button"
              disabled={pagina === 0}
              onClick={() => setPagina((p) => Math.max(0, p - 1))}
              className="px-4 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              ← Anterior
            </button>
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {pagina * POR_PAGINA + 1}–{Math.min(totalProdutos, (pagina + 1) * POR_PAGINA)} de {totalProdutos}
            </span>
            <button
              type="button"
              disabled={(pagina + 1) * POR_PAGINA >= totalProdutos}
              onClick={() => setPagina((p) => p + 1)}
              className="px-4 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Próxima →
            </button>
          </nav>
        )}
      </div>
    </CascaDaLoja>
  );
}

/**
 * O topo do card de loja na home — capa quando existe, tipografia quando não.
 *
 * O bloco tem SEMPRE a mesma altura: no dia em que o dono subir a capa de UMA
 * loja, o grid estica os cards da linha — e o card sem capa ficava com o
 * texto colado no topo e um vazio embaixo. Capa que falha ao carregar cai no
 * mesmo bloco tipográfico, nunca no ícone quebrado do navegador.
 */
function CapaDoCardDeLoja({ store }: { store: Store }) {
  const [morta, setMorta] = useState(false);

  if (store.coverUrl && !morta) {
    return (
      <img
        src={coreApi.imageUrl(store.coverUrl)}
        alt={`Capa da ${store.tradeName}`}
        loading="lazy"
        decoding="async"
        onError={() => setMorta(true)}
        className="h-28 w-full object-cover"
      />
    );
  }

  const inicial = store.tradeName.trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      aria-hidden="true"
      data-testid={`capa-tipografica-${store.slug}`}
      className="h-28 w-full flex items-center justify-center bg-[var(--gs-purple-100)]"
    >
      <span className="text-[length:var(--gs-text-3xl)] font-bold text-[var(--gs-purple-700)] opacity-70">
        {inicial}
      </span>
    </div>
  );
}

/**
 * ATÉ QUANDO — a promessa de prazo que a tela faz ao cliente (GAP-PRD-029).
 *
 * No boleto a tela dizia só "Válido até amanhã", e o pedido era cancelado
 * 25 horas depois do checkout — antes de o banco conseguir confirmar o boleto
 * pago no vencimento. O servidor passou a segurar a reserva até o fim do
 * segundo dia útil depois do último dia de pagamento e devolve esse instante
 * (`reservedUntil`); a tela diz as duas datas, cada uma com o nome certo.
 * As datas passam por `dataBR`: o vencimento é dia de calendário e a reserva
 * é instante, e os dois saem no dia da loja.
 */
function PrazoDoPagamento({ pagamento }: { pagamento: PaymentView }) {
  const estilo = 'text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-3 mb-0';
  if (pagamento.method === 'boleto') {
    return (
      <>
        {pagamento.dueDate && (
          <p className={estilo}>
            Pague até <strong>{dataBR(pagamento.dueDate)}</strong>. Vencimento em fim de semana ou
            feriado pode ser pago no dia útil seguinte.
          </p>
        )}
        {pagamento.reservedUntil && (
          <p className={estilo}>
            Seus itens ficam reservados até {dataBR(pagamento.reservedUntil)} — o tempo de o banco
            confirmar o pagamento do boleto.
          </p>
        )}
      </>
    );
  }
  return pagamento.dueDate ? <p className={estilo}>Válido até {pagamento.dueDate}.</p> : null;
}

/**
 * Como pagar o pedido.
 *
 * A regra que manda aqui: MOSTRAR O QR NÃO É RECEBER. O estado vem do
 * servidor, e enquanto o provedor não confirmar ele diz "aguardando
 * pagamento" — com todas as letras, porque um cliente que acha que já pagou
 * some, e a mercadoria fica reservada esperando um dinheiro que não vem.
 *
 * Sem credencial na operação, a tela também não finge: diz que o pagamento
 * online está indisponível e que a loja vai combinar o pagamento.
 */
function PagamentoCard({ pagamento }: { pagamento: PaymentView }) {
  const [copiado, setCopiado] = useState(false);

  if (pagamento.status === 'unconfigured' || pagamento.status === 'failed') {
    return (
      <div
        role="status"
        className="bg-[var(--gs-surface)] border border-[var(--gs-warning)]
          rounded-[var(--gs-radius-lg)] p-5"
      >
        <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-warning)] mt-0 mb-1">
          Pagamento online indisponível nesta loja
        </h2>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
          Seu pedido está registrado e os itens, reservados. A loja vai entrar em contato para
          combinar o pagamento.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] shadow-[var(--gs-shadow-md)] p-5">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] m-0">
          {pagamento.method === 'cartao'
            ? (pagamento.installments ?? 1) > 1
              ? `Pague com cartão em ${pagamento.installments}x`
              : 'Pague com cartão'
            : pagamento.method === 'boleto'
              ? 'Pague o boleto'
              : 'Pague com PIX'}
        </h2>
        <span
          className="px-2 py-1 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
            text-[length:var(--gs-text-xs)] font-semibold text-[var(--gs-warning)]"
        >
          AGUARDANDO PAGAMENTO
        </span>
        {pagamento.environment === 'sandbox' && (
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            ambiente de testes — nenhuma cobrança real
          </span>
        )}
      </div>

      {pagamento.pixImageBase64 && (
        <img
          src={`data:image/png;base64,${pagamento.pixImageBase64}`}
          alt="QR Code do PIX"
          className="w-48 h-48 mb-3"
        />
      )}

      {/* Cartão e boleto pagam na página do provedor. O número do cartão é
          digitado LÁ — nunca nesta loja, e nada fica salvo aqui. */}
      {(pagamento.method === 'cartao' || pagamento.method === 'boleto') &&
        pagamento.bankSlipUrl && (
          <a
            href={pagamento.bankSlipUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block mb-3 bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)]
              text-white no-underline rounded-[var(--gs-radius)] px-5 py-3 font-semibold"
          >
            {pagamento.method === 'cartao'
              ? 'Pagar com cartão na página segura'
              : 'Abrir o boleto'}
          </a>
        )}

      {pagamento.pixPayload ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="pix-copia-e-cola"
            className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text)]"
          >
            PIX copia e cola
          </label>
          <textarea
            id="pix-copia-e-cola"
            readOnly
            value={pagamento.pixPayload}
            rows={3}
            /*
              O xs (12px) só a partir do md. A classe é mais específica que a
              regra de 16px do toque e derrotava o piso JUSTAMENTE aqui — no
              campo do PIX, que é onde o cliente toca para copiar e onde o
              zoom do iOS mais atrapalha. No celular ele herda os 16px e o
              código quebra em mais linhas, o que não custa nada: quem copia
              usa o botão, não lê o payload.
            */
            className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
              font-mono md:text-[length:var(--gs-text-xs)] break-all"
          />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(pagamento.pixPayload ?? '').then(
                () => setCopiado(true),
                // Sem permissão de área de transferência o texto continua
                // selecionável: o cliente copia à mão.
                () => setCopiado(false),
              );
            }}
            className="self-start bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white
              border-0 rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
          >
            {copiado ? 'Copiado' : 'Copiar código'}
          </button>
        </div>
      ) : pagamento.method === 'boleto' ? (
        pagamento.identificationField ? (
          <p className="text-[length:var(--gs-text-sm)] m-0">
            <span className="block font-semibold text-[var(--gs-text)]">Linha digitável</span>
            <span className="font-mono break-all">{pagamento.identificationField}</span>
          </p>
        ) : null
      ) : (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
          A cobrança foi criada. O código do PIX aparece aqui assim que o provedor responder.
        </p>
      )}

      <PrazoDoPagamento pagamento={pagamento} />

      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] mt-3 mb-0">
        O pedido é liberado para separação quando o provedor confirmar o pagamento — não ao gerar
        o código.
      </p>
    </div>
  );
}
