/**
 * Loja online do Grupo Sampaio.
 *
 * Princípios que valem para todo este módulo:
 *
 *  - NÃO existe catálogo nem estoque de e-commerce. A vitrine lê os MESMOS
 *    produtos e o MESMO saldo das operações; publicar é só marcar
 *    `publish_online`.
 *  - O preço mostrado passa pelas promoções vigentes, que também valem no
 *    PDV. O preço-base do produto nunca é sobrescrito.
 *  - Pedido RESERVA estoque; só o pagamento confirmado baixa. Cancelar
 *    libera. Nunca há baixa dupla.
 *  - Peça de bancada NÃO É MERCADORIA e não aparece aqui. Ver
 *    `PRODUTO_VISIVEL_NA_LOJA`, logo abaixo dos tipos.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import {
  queueEmail,
  type ComoOValorVolta,
  type Contexto,
  type EmailTemplate,
  type OrigemDoCancelamento,
} from '../notifications/EmailService.js';
import { publicBaseUrl } from './PublicUrl.js';
import { linkDeRastreio, nomeDaTransportadora } from '../logistics/RastreioPublico.js';
import {
  cadastroDaConta,
  cadastroDoVisitante,
  type CompradorDaConta,
  type RetratoDoEndereco,
} from './CheckoutIdentityService.js';
import {
  effectivePriceCents,
  promocoesVigentes,
  type PromocaoVigente,
} from './PricingService.js';
import { systemCategoryId } from './FinanceSetupService.js';
// A VOLTA da rastreabilidade: a MESMA consulta que a tela de Contas usa para a
// ida (originType + originId). Ver `getOrderDetail`, no fim deste arquivo.
import { listEntries } from './FinanceService.js';
import { diaDaLoja } from './CalendarioOperacional.js';
import { lembrarDaVitrine } from './VitrineCache.js';
import {
  ORIGEM_DO_REEMBOLSO,
  lancarContrapartidaDoReembolso,
  type SituacaoDoDinheiro,
} from './OrderRefundLedger.js';
export { effectivePriceCents };
import {
  consumeReservation,
  getAvailable,
  releaseReservation,
  reserveStock,
} from './InventoryService.js';
import { getShippingSettings } from './CheckoutShippingService.js';
import type { StorefrontPreset } from './StorefrontPresets.js';
import { limitarDeslocamento, limitarPagina } from './paginacao.js';
import { conferirParcelasDaLoja } from './ParcelamentoNoCartao.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';
import {
  aplicarCupom,
  cupomInvalido,
  empresasComCupom,
  liberarUsoDoCupom,
  normalizarCodigo,
  registrarUsoDoCupom,
  type CupomAplicado,
} from './CupomService.js';
import { modeloAtivo } from './produtoVendavel.js';

/**
 * O QUE A VITRINE PODE MOSTRAR — a condição inteira, em UM lugar.
 *
 * POR QUE UMA CONSTANTE, E NÃO A CONDIÇÃO REPETIDA
 *
 * Esta regra é consultada em SETE lugares deste módulo e das rotas da loja:
 * a contagem de produtos por loja no portal, a listagem, o detalhe público, a
 * GRADE do detalhe, a lista de categorias, a leitura do carrinho na cotação de
 * frete e a conferência de cada item no checkout. Escrita sete vezes, ela
 * divergiria na primeira mudança — e foi exatamente o que aconteceu: seis
 * lugares conferiam `publish_online` e o sétimo, a grade do detalhe, conferia
 * só `active`. Bastava um modelo publicado para o cliente ver e escolher uma
 * variante despublicada, que o checkout então recusava com "produto
 * indisponível" — a loja oferecia o que ela mesma não vendia.
 *
 * POR QUE A PEÇA ENTRA NESTA CONDIÇÃO, E NÃO SÓ NO ESCRITOR
 *
 * `ProductKindService` já recusa publicar uma peça, e `updateProduct` também.
 * Isso protege contra o caminho normal — mas a vitrine é o lugar onde um
 * estado errado vira dinheiro do cliente. Importação de XML, migração antiga,
 * UPDATE feito à mão no banco para "resolver rápido": qualquer um deles pode
 * deixar uma linha com `kind = 'part'` e `publish_online = 1`, e o guarda do
 * escritor não olha para trás. Aqui é o LEITOR que se recusa, então o estado
 * inválido no banco não chega a virar uma venda.
 *
 * Peça de bancada tem preço de reposição, não tem foto, não tem medida de
 * envio e o saldo dela é o que sustenta os consertos em andamento. Vendê-la ao
 * consumidor esvazia a gaveta da oficina pela porta errada.
 *
 * Usa o apelido `p` — toda consulta que a aplica precisa apelidar
 * `core_products` como `p`.
 *
 * A VARIANTE HERDA O MODELO (`modeloAtivo`): o tamanho tem `active` próprio, e
 * inativar o modelo não o reescreve. Sem a condição, o tamanho de um modelo
 * arquivado continuava na grade do detalhe, no carrinho e passava no checkout.
 */
export const PRODUTO_VISIVEL_NA_LOJA = `p.active = 1 AND p.publish_online = 1 AND p.kind <> 'part'
  AND ${modeloAtivo('p')}`;

/**
 * O QUE É VERDADE SOBRE COMPRAR NESTA LOJA — os selos (rodada 56).
 *
 * Cada selo é uma afirmação que o cliente vai levar a sério. "Frete grátis
 * acima de R$ 200" que a loja não cumpre é cobrança surpresa no fim do
 * checkout; "parcele em 12x" sem regra cadastrada é promessa que o caixa não
 * honra. Então a régua é única e dura: SELO SÓ EXISTE COM DADO ATRÁS.
 *
 * A consequência é que hoje, com o cadastro vazio, quase toda loja mostra um
 * selo só — retirada. E está certo: é o que elas de fato oferecem. Os outros
 * aparecem sozinhos conforme o dono preenche entrega e parcelamento.
 */
export interface StoreSeal {
  /** Estável, para a tela escolher o ícone sem casar por texto. */
  id: 'retirada' | 'frete-gratis' | 'prazo' | 'parcelamento' | 'troca';
  label: string;
}

export interface StoreSummary {
  id: string;
  slug: string;
  tradeName: string;
  kind: string;
  productCount: number;
  /** Identidade escrita pelo gestor. Nulo quando ainda não foi preenchida. */
  headline: string | null;
  description: string | null;
  whatsapp: string | null;
  /** Só vem quando a faixa está LIGADA — desligada não chega ao cliente. */
  bannerText: string | null;
  /** Identidade visual da marca (rodada 40). Nulos até o gestor enviar. */
  logoUrl: string | null;
  coverUrl: string | null;
  /**
   * QUE NEGÓCIO ESTA LOJA FAZ (rodada 56) — é o que decide o ARRANJO da
   * vitrine. Nulo = ninguém declarou, e a tela cai no neutro.
   */
  storefrontPreset: StorefrontPreset | null;
  /** O que é verdade sobre comprar aqui. Ver `StoreSeal`. */
  seals: StoreSeal[];
  /**
   * Em quantas vezes o cartão parcela nesta loja (GAP-PRD-114). Nulo = só à
   * vista. É o número por trás do selo, para o checkout oferecer a escolha.
   */
  cardInstallmentsMax: number | null;
}

/**
 * O direito de arrependimento é DA LEI, não da loja.
 *
 * Sete dias corridos, artigo 49 do Código de Defesa do Consumidor. Vale para
 * toda compra pela internet e para as seis empresas do grupo igualmente — por
 * isso não é cadastro: cadastro seria oferecer ao dono a chance de declarar um
 * número que não é dele.
 *
 * A política completa que o cliente lê fica em `PaginasLegais` (rota
 * /trocas-e-devoluções), e o rodapé da loja linka para ela. Aqui o selo só
 * repete, ao lado do preço, o prazo que a página inteira detalha.
 */
export const DIAS_DE_ARREPENDIMENTO = 7;

/**
 * Monta os selos de uma loja a partir do que ela DE FATO declarou.
 *
 * A ordem é a da conversa de balcão: primeiro como o cliente recebe, depois
 * quanto custa e quando chega, depois como paga, e por fim a garantia de que
 * dá para desistir.
 */
function selosDaLoja(companyId: string, installmentsMax: number | null): StoreSeal[] {
  const entrega = getShippingSettings(companyId);
  const selos: StoreSeal[] = [];

  if (entrega.pickup_enabled) {
    selos.push({ id: 'retirada', label: 'Retire na loja' });
  }

  /*
    ENTREGA DESLIGADA NÃO VIRA SELO DE ENTREGA, mesmo com valor gravado.

    O cadastro guarda o número mesmo com a entrega desligada — é deliberado, para
    o dono não perder o que digitou ao desligar num feriado. Mas anunciar frete
    grátis de um serviço que a loja não presta é o pior tipo de selo: o cliente
    monta o carrinho contando com ele e descobre no fim que só tem retirada.
  */
  if (entrega.delivery_enabled) {
    /*
      A MESMA RÉGUA DO CHECKOUT, e não uma parecida.

      `listCheckoutShipping` dá frete grátis quando `free_above_cents` NÃO É
      NULO e o carrinho alcança o valor — então ZERO significa "grátis
      sempre", e o cadastro guarda essa distinção de propósito (campo em
      branco é "não configurado", que é diferente de zero).

      A primeira versão deste selo exigia `> 0` e engolia justamente o caso
      mais generoso: a loja dava frete grátis em tudo e a vitrine não dizia.
      Selo que esconde o que a loja oferece é tão ruim quanto o que promete o
      que ela não faz.
    */
    if (entrega.free_above_cents != null) {
      selos.push(
        entrega.free_above_cents > 0
          ? {
              id: 'frete-gratis',
              label: `Frete grátis acima de ${reaisPorExtenso(entrega.free_above_cents)}`,
            }
          : { id: 'frete-gratis', label: 'Frete grátis' },
      );
    }
    if (entrega.estimated_days != null && entrega.estimated_days > 0) {
      const dias = Number(entrega.estimated_days);
      // "1 dia úteis" é o tipo de erro que faz o cliente desconfiar do resto
      // da página. Os dois números concordam.
      selos.push({
        id: 'prazo',
        label: dias === 1 ? 'Chega em 1 dia útil' : `Chega em até ${dias} dias úteis`,
      });
    }
  }

  if (installmentsMax != null && installmentsMax > 1) {
    selos.push({ id: 'parcelamento', label: `Parcele em até ${installmentsMax}x` });
  }

  selos.push({ id: 'troca', label: `Troca em ${DIAS_DE_ARREPENDIMENTO} dias` });
  return selos;
}

/** Centavos em reais para dentro de uma frase — o selo é texto, não tabela. */
function reaisPorExtenso(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

/**
 * Lojas do portal. A Oficina aparece como serviço, não como loja de varejo —
 * por isso é devolvida separada.
 */
export function listStorefronts(): { stores: StoreSummary[]; services: StoreSummary[] } {
  ensureCoreSchema();
  // A identidade que o gestor escreve aparece AQUI. Sem isto, as seis lojas do
  // grupo saem iguais na home — nome e contagem de produtos, nada dizendo o que
  // cada uma vende.
  const rows = getConnection()
    .prepare(
      `SELECT c.id, c.slug, c.trade_name AS tradeName, c.kind,
              c.storefront_preset AS storefrontPreset,
              st.headline, st.description, st.whatsapp,
              st.logo_url AS logoUrl, st.cover_url AS coverUrl,
              st.installments_max AS installmentsMax,
              CASE WHEN st.banner_active = 1 THEN st.banner_text END AS bannerText,
              (SELECT COUNT(*) FROM core_products p
                WHERE p.company_id = c.id AND ${PRODUTO_VISIVEL_NA_LOJA})
              AS productCount
         FROM core_companies c
         LEFT JOIN core_storefront_settings st ON st.company_id = c.id
        WHERE c.active = 1
        ORDER BY c.trade_name`,
    )
    .all() as unknown as (Omit<StoreSummary, 'cardInstallmentsMax'> & { installmentsMax: number | null })[];

  /*
    Os selos saem de OUTRO cadastro (entrega), então não dá para trazê-los na
    mesma consulta sem repetir aqui a regra de "o que vale quando ninguém
    configurou" — que já mora em `getShippingSettings`. Uma segunda cópia dessa
    regra faria a vitrine e o checkout discordarem sobre a mesma loja.
  */
  const comSelos: StoreSummary[] = rows.map((r) => {
    const { installmentsMax, ...loja } = r;
    return {
      ...loja,
      seals: selosDaLoja(r.id, installmentsMax ?? null),
      cardInstallmentsMax: installmentsMax != null && installmentsMax > 1 ? installmentsMax : null,
    };
  });

  return {
    stores: comSelos.filter((r) => r.kind !== 'workshop'),
    services: comSelos.filter((r) => r.kind === 'workshop'),
  };
}

/** O que o Decreto 7.962 manda a loja mostrar — e NADA além disso. */
export interface StoreIdentification {
  slug: string;
  tradeName: string;
  legalName: string;
  cnpj: string | null;
  address: string | null;
  phone: string | null;
}

/**
 * Identificação legal das lojas — razão social, CNPJ, endereço.
 *
 * Os dados vêm do cadastro FISCAL, mas o objeto fiscal NUNCA é espalhado:
 * IE, IM, CRT e ambiente não são identificação, são configuração — e
 * configuração fiscal em endpoint público é vazamento. Cada campo é
 * copiado à mão, de propósito.
 */
export function listStoreIdentification(): StoreIdentification[] {
  ensureCoreSchema();
  const empresas = getConnection()
    .prepare(
      `SELECT id, slug, trade_name AS tradeName, legal_name AS legalName
         FROM core_companies
        WHERE active = 1 AND kind != 'workshop'
        ORDER BY trade_name`,
    )
    .all() as unknown as { id: string; slug: string; tradeName: string; legalName: string }[];

  return empresas.map((e) => {
    const fiscal = getFiscalConfig(e.id);
    const endereco = fiscal.street
      ? [
          `${fiscal.street}${fiscal.number ? `, ${fiscal.number}` : ''}`,
          fiscal.district,
          `${fiscal.cityName ?? ''}${fiscal.uf ? `/${fiscal.uf}` : ''}`,
          fiscal.zip ? `CEP ${fiscal.zip}` : null,
        ]
          .filter(Boolean)
          .join(' — ')
      : null;
    return {
      slug: e.slug,
      tradeName: e.tradeName,
      // Sem cadastro fiscal, a razão social de core_companies segura a
      // identificação mínima — melhor que rodapé em branco.
      legalName: fiscal.legalName ?? e.legalName,
      cnpj: fiscal.cnpj ?? null,
      address: endereco,
      phone: fiscal.phone ?? null,
    };
  });
}

export interface StorefrontProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  unit: string;
  imageUrl: string | null;
  basePriceCents: number;
  priceCents: number;
  onSale: boolean;
  available: number;
  storeSlug: string;
  storeName: string;
  /** Marcado como destaque pelo gestor. A vitrine ordena por isto. */
  featured: boolean;
  /** Produto-modelo com grade (tamanho/cor). O card leva à escolha. */
  hasVariants: boolean;
  /** Menor preço entre as variantes — o "a partir de" do card. */
  fromPriceCents: number | null;
}

interface ProductRow {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  unit: string;
  image_url: string | null;
  price_cents: number;
  slug: string;
  trade_name: string;
  featured_online?: number;
  /** O galho da árvore de categorias — filtro da vitrine (rodada 56). */
  subcategory?: string | null;
}

/**
 * SEM TABELA DE PREÇO NA VITRINE, e escrito explicitamente para que a próxima
 * pessoa não ache que foi esquecimento.
 *
 * A vitrine é pública: quem navega não está autenticado, e o portal do cliente
 * é OUTRA autenticação (`core_customer_accounts`), que não é a mesma coisa que
 * o cadastro comercial `core_customers` onde a tabela mora. Não existe, aqui,
 * quem responda "de qual cliente é este preço".
 *
 * Passar nulo é a resposta certa e não um contorno: o preço anunciado na
 * vitrine é o preço de todo mundo. Uma condição combinada com um revendedor
 * específico não pode virar vitrine pública — seria publicar o desconto de um
 * cliente para os outros, e todos passariam a exigi-lo.
 */
const SEM_TABELA_NA_VITRINE = { priceTableId: null } as const;

/**
 * As variantes publicadas de um modelo, para agregar no card da vitrine.
 * Devolve preço e disponível de cada uma — o card mostra a soma e o menor preço.
 */
/**
 * O QUE A LISTAGEM PRECISA SABER, LIDO DE UMA VEZ.
 *
 * `decorate` ia ao banco três vezes por produto: a promoção vigente, os
 * filhos da grade e o saldo (dele e de cada filho). Com o catálogo do grupo
 * na home isso passa de mil idas para montar uma página — e `node:sqlite` é
 * síncrono, no MESMO processo que atende `/core/sales`. Vitrine lenta aqui
 * não é vitrine lenta: é o PDV parado com o cliente na frente.
 *
 * A passada em memória (busca sem acento, faixa de preço, ordenação por
 * preço com promoção) continua onde estava e pelo mesmo motivo de sempre:
 * nada disso é coluna. O que sai do laço é a IDA AO BANCO.
 */
interface PrecargaDaVitrine {
  /** Promoções vigentes por empresa. */
  promocoes: Map<string, PromocaoVigente[]>;
  /** Saldo vendável por produto — só quem tem linha em core_stock aparece. */
  disponivel: Map<string, number>;
  /** Filhos visíveis de cada modelo de grade, por id do modelo. */
  variantes: Map<string, { id: string; price_cents: number }[]>;
}

function precarregar(rows: ProductRow[]): PrecargaDaVitrine {
  const db = getConnection();
  const empresas = [...new Set(rows.map((r) => r.company_id))];

  const promocoes = new Map<string, PromocaoVigente[]>();
  for (const empresa of empresas) promocoes.set(empresa, promocoesVigentes(empresa));

  /*
    UMA consulta para o saldo de todos, e outra para as variantes de todos.

    O `IN` é montado com um marcador por id (nunca por interpolação): a
    lista vem do próprio banco, mas o hábito de concatenar SQL é o que abre
    a porta que ninguém vê.
  */
  const disponivel = new Map<string, number>();
  const variantes = new Map<string, { id: string; price_cents: number }[]>();
  if (empresas.length > 0) {
    const marcadores = empresas.map(() => '?').join(', ');

    const saldos = db
      .prepare(
        `SELECT product_id, quantity - reserved AS available
           FROM core_stock WHERE company_id IN (${marcadores})`,
      )
      .all(...(empresas as never[])) as unknown as {
      product_id: string;
      available: number;
    }[];
    for (const s of saldos) disponivel.set(s.product_id, Math.max(0, Number(s.available)));

    const filhos = db
      .prepare(
        // Aliasada como `p` porque PRODUTO_VISIVEL_NA_LOJA fala em `p.active`.
        `SELECT p.id, p.parent_id, p.price_cents FROM core_products p
          WHERE p.parent_id IS NOT NULL AND p.company_id IN (${marcadores})
            AND ${PRODUTO_VISIVEL_NA_LOJA}`,
      )
      .all(...(empresas as never[])) as unknown as {
      id: string;
      parent_id: string;
      price_cents: number;
    }[];
    for (const f of filhos) {
      const lista = variantes.get(f.parent_id) ?? [];
      lista.push({ id: f.id, price_cents: f.price_cents });
      variantes.set(f.parent_id, lista);
    }
  }

  return { promocoes, disponivel, variantes };
}

function variantesVisiveis(companyId: string, modeloId: string): { priceCents: number; available: number }[] {
  return (
    getConnection()
      .prepare(
        // Tabela aliasada como `p` porque PRODUTO_VISIVEL_NA_LOJA fala em `p.active`.
        `SELECT p.id, p.price_cents FROM core_products p
          WHERE p.company_id = ? AND p.parent_id = ? AND ${PRODUTO_VISIVEL_NA_LOJA}`,
      )
      .all(companyId, modeloId) as unknown as { id: string; price_cents: number }[]
  ).map((v) => ({ priceCents: v.price_cents, available: getAvailable(companyId, v.id) }));
}

function decorate(row: ProductRow, pre?: PrecargaDaVitrine): StorefrontProduct {
  const { priceCents, onSale } = effectivePriceCents(
    row.company_id,
    row.id,
    row.price_cents,
    row.category,
    // Com a pré-carga, a regra do preço é a MESMA — só as linhas já
    // estavam lidas. Sem ela (a página de um produto só), nada muda.
    pre
      ? { ...SEM_TABELA_NA_VITRINE, promocoes: pre.promocoes.get(row.company_id) ?? [] }
      : SEM_TABELA_NA_VITRINE,
  );

  /*
    GRADE NUM CARD SÓ.

    Um produto-modelo (o pai da grade) tem estoque ZERO — o estoque mora nas
    variantes. Se o card mostrasse o próprio disponível, diria "Indisponível"
    para uma camisa que tem P, M e G na prateleira. Então, quando há variantes
    visíveis, o disponível do card é a SOMA delas e o preço é o MENOR — o "a
    partir de" que a loja de verdade mostra. A escolha do tamanho acontece na
    página do produto.
  */
  const variantes = pre
    ? (pre.variantes.get(row.id) ?? []).map((v) => ({
      priceCents: v.price_cents,
      available: pre.disponivel.get(v.id) ?? 0,
    }))
    : variantesVisiveis(row.company_id, row.id);
  const temGrade = variantes.length > 0;
  const disponivel = temGrade
    ? variantes.reduce((s, v) => s + Math.max(0, v.available), 0)
    : (pre ? (pre.disponivel.get(row.id) ?? 0) : getAvailable(row.company_id, row.id));
  const menorPreco = temGrade ? Math.min(...variantes.map((v) => v.priceCents)) : null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    brand: row.brand,
    unit: row.unit,
    imageUrl: row.image_url,
    basePriceCents: row.price_cents,
    priceCents: menorPreco ?? priceCents,
    onSale,
    available: disponivel,
    storeSlug: row.slug,
    storeName: row.trade_name,
    featured: row.featured_online === 1,
    hasVariants: temGrade,
    fromPriceCents: menorPreco,
  };
}

const PRODUCT_SELECT = `
  SELECT p.id, p.company_id, p.name, p.description, p.category, p.brand, p.unit,
         p.image_url, p.price_cents, p.featured_online, p.subcategory, c.slug, c.trade_name
    FROM core_products p
    JOIN core_companies c ON c.id = p.company_id
   WHERE ${PRODUTO_VISIVEL_NA_LOJA}`;

/** Como a vitrine ordena o resultado. */
export type StorefrontSort = 'nome' | 'menor_preco' | 'maior_preco' | 'promocoes';

/** Tira acento e caixa: "Açúcar" e "acucar" viram a mesma coisa para comparar. */
function dobrar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * O TETO DA PÁGINA DA VITRINE (GAP-PRD-071).
 *
 * A rota é pública e aceitava qualquer `limit`: `?limit=100000` devolvia o
 * catálogo inteiro de uma vez. A tela pagina de 12 em 12; 60 cobre com folga
 * qualquer grade de vitrine, e o `total` continua dizendo quantos há.
 * O teto mora AQUI, e não só na rota, para nenhum chamador novo escapar dele.
 */
export const TETO_DA_PAGINA = 60;

function tamanhoDaPagina(pedido: number | undefined): number {
  if (pedido === undefined || !Number.isFinite(pedido) || pedido < 0) return TETO_DA_PAGINA;
  return Math.min(TETO_DA_PAGINA, Math.floor(pedido));
}

/**
 * Caixa e espaço dobrados pela MESMA régua da árvore de departamentos
 * (`chave`, que imita o `LOWER` do SQLite e só dobra ASCII) — a pílula e o
 * clique precisam contar igual. Nulo continua nulo.
 */
function caixaESpaco(texto: string | null | undefined): string | null {
  return texto === null || texto === undefined ? null : chave(texto);
}

/** Um produto do catálogo guardado, com o que os filtros precisam já pronto. */
interface LinhaDoCatalogo {
  item: StorefrontProduct;
  departamento: string | null;
  galho: string | null;
  /** Nome, marca e descrição já dobrados (sem acento, caixa baixa). */
  busca: string;
}

/**
 * O CATÁLOGO DECORADO DE UMA LOJA (ou do grupo inteiro), montado uma vez e
 * guardado enquanto o banco não muda — ver `VitrineCache` (GAP-PRD-071).
 *
 * Antes cada visita lia e decorava todos os produtos publicados — promoção,
 * grade, saldo — para só no fim fatiar a página. Agora a montagem acontece
 * quando alguma coisa foi gravada (ou o minuto virou), e as visitas no meio
 * filtram, ordenam e fatiam o que já está pronto. Departamento, galho,
 * destaque e o produto a excluir viraram filtros em memória justamente para a
 * chave ser só a loja: com eles no SQL, cada página de produto (que exclui a
 * si mesma dos relacionados) seria uma chave nova.
 */
function catalogoDecorado(storeSlug?: string): LinhaDoCatalogo[] {
  return lembrarDaVitrine(`vitrine:${storeSlug || '*'}`, () => {
    const params: unknown[] = [];
    // GRADE NUM CARD SÓ: a vitrine lista MODELOS e produtos soltos, nunca as
    // variantes-filho. Sem isto, uma camisa com P/M/G virava quatro cards (o
    // modelo, "Indisponível", mais um por tamanho).
    let sql = `${PRODUCT_SELECT} AND p.parent_id IS NULL`;
    if (storeSlug) {
      sql += ' AND c.slug = ?';
      params.push(storeSlug);
    }
    sql += ' ORDER BY p.name';
    const rows = getConnection().prepare(sql).all(...(params as never[])) as unknown as ProductRow[];

    /**
     * Faixa de preço, busca e ordenação acontecem DEPOIS de `decorate`, não em
     * SQL. É `decorate` quem aplica a promoção vigente e agrega a grade, e nada
     * disso existe como coluna.
     */
    const pre = precarregar(rows);
    return rows.map((row) => {
      const item = decorate(row, pre);
      return {
        item,
        departamento: caixaESpaco(row.category),
        galho: caixaESpaco(row.subcategory),
        busca: [item.name, item.brand, item.description]
          .filter((campo): campo is string => Boolean(campo))
          .map(dobrar)
          .join('\u0000'),
      };
    });
  });
}

export interface StorefrontPage {
  items: StorefrontProduct[];
  /** Total DEPOIS dos filtros, antes da paginação — para a tela numerar. */
  total: number;
}

export function listStorefrontProducts(options: {
  storeSlug?: string;
  search?: string;
  /** O DEPARTAMENTO: traz tudo que está debaixo dele, galhos inclusive. */
  category?: string;
  /** O GALHO: traz só ele. Vale junto com o departamento ou sozinho. */
  subcategory?: string;
  /** Não relacionar o produto consigo mesmo — ver `related` no detalhe. */
  excludeProductId?: string;
  /**
   * Faixa de preço, em centavos, sobre o preço QUE O CLIENTE PAGA.
   *
   * Filtrar pelo preço de tabela esconderia justamente o que a loja quer
   * vender: um produto de R$ 120 em promoção por R$ 80 não apareceria no
   * filtro "até R$ 100", que é onde o cliente está procurando.
   */
  minPriceCents?: number;
  maxPriceCents?: number;
  sort?: StorefrontSort;
  limit?: number;
  offset?: number;
  /** Só destaques — o carrossel do topo pede assim. */
  onlyFeatured?: boolean;
  /** Só o que está em promoção VIGENTE — a seção de ofertas da home. */
  onlyOnSale?: boolean;
}): StorefrontPage {
  ensureCoreSchema();
  // O catálogo da loja, decorado uma vez e guardado enquanto o banco não muda
  // (GAP-PRD-071). Tudo daqui para baixo é filtro sobre ele, em memória.
  let linhas = catalogoDecorado(options.storeSlug);

  /*
    DEPARTAMENTO e GALHO são filtros DIFERENTES (rodada 56).

    Clicar em "Vestuário" tem de trazer as camisas e as calças; clicar em
    "Camisas" tem de trazer só as camisas. Antes só existia o primeiro, então
    a subcategoria era invisível na loja mesmo com a árvore montada no
    escritório.

    A comparação é dobrada por caixa e espaço porque o texto do produto foi
    digitado por gente: "camisas" e "Camisas " são o mesmo departamento para
    quem está comprando.
  */
  if (options.category) {
    const alvo = caixaESpaco(options.category);
    linhas = linhas.filter((l) => l.departamento === alvo);
  }
  if (options.subcategory) {
    const alvo = caixaESpaco(options.subcategory);
    linhas = linhas.filter((l) => l.galho === alvo);
  }
  if (options.excludeProductId) {
    linhas = linhas.filter((l) => l.item.id !== options.excludeProductId);
  }
  if (options.onlyFeatured) {
    linhas = linhas.filter((l) => l.item.featured);
  }
  if (options.onlyOnSale) {
    // A promoção não é coluna: ela é calculada por effectivePriceCents, com
    // vigência conferida. Vencida/futura não entra.
    linhas = linhas.filter((l) => l.item.onSale);
  }
  if (options.search?.trim()) {
    // A busca NÃO vai no SQL: LIKE não tira acento, e "acucar" nunca acharia
    // "Açúcar". O texto de cada produto já vem dobrado do catálogo guardado.
    const alvo = dobrar(options.search.trim());
    linhas = linhas.filter((l) => l.busca.includes(alvo));
  }
  // Array novo: a ordenação abaixo não pode mexer no catálogo guardado.
  let itens = linhas.map((l) => l.item);
  if (options.minPriceCents !== undefined) {
    itens = itens.filter((p) => p.priceCents >= options.minPriceCents!);
  }
  if (options.maxPriceCents !== undefined) {
    itens = itens.filter((p) => p.priceCents <= options.maxPriceCents!);
  }

  switch (options.sort) {
    case 'menor_preco':
      itens.sort((a, b) => a.priceCents - b.priceCents);
      break;
    case 'maior_preco':
      itens.sort((a, b) => b.priceCents - a.priceCents);
      break;
    case 'promocoes':
      itens.sort((a, b) => Number(b.onSale) - Number(a.onSale) || a.priceCents - b.priceCents);
      break;
    default:
      // Padrão: DESTAQUE primeiro, depois nome. É onde o "Destacar" do gestor
      // finalmente vale — antes ele era gravado e a vitrine nunca o lia.
      itens.sort(
        (a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name, 'pt-BR'),
      );
      break;
  }

  const total = itens.length;
  const offset =
    options.offset !== undefined && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  const limit = tamanhoDaPagina(options.limit);
  // Cópia rasa de cada item: o catálogo guardado é compartilhado entre
  // visitas, e quem recebe a página pode mexer no que recebeu.
  return { items: itens.slice(offset, offset + limit).map((p) => ({ ...p })), total };
}

export function getStorefrontProduct(productId: string): StorefrontProduct | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(`${PRODUCT_SELECT} AND p.id = ?`)
    .get(productId) as ProductRow | undefined;
  return row ? decorate(row) : null;
}

/** Uma opção da grade, do jeito que a vitrine precisa mostrar. */
export interface StorefrontVariant {
  id: string;
  name: string;
  barcode: string | null;
  attributes: Record<string, string>;
  priceCents: number;
  available: number;
}

export interface StorefrontProductDetail extends StorefrontProduct {
  companyId: string;
  subcategory: string | null;
  images: { url: string; isPrimary: boolean }[];
  variants: StorefrontVariant[];
  /**
   * Entrega externa só existe com peso e dimensões cadastrados. Sem eles a
   * cotação inventaria uma caixa — e o transportador cobra pela real.
   */
  shippingReadiness: 'READY_FOR_SHIPPING' | 'SHIPPING_DATA_INCOMPLETE';
  missingShippingFields: string[];
  /**
   * Se a loja DE FATO faz retirada no balcão (rodada 57).
   *
   * A página do produto dizia a quem não pode receber em casa "retire sem
   * custo, é só fechar o pedido escolhendo a retirada" — sem nunca perguntar
   * se a loja oferece retirada. É o mesmo `pickup_enabled` que decide o selo
   * "Retire na loja"; prometer no detalhe o que o selo não afirma é a tela
   * garantindo o que o cadastro nega, e o cliente descobre no fim do
   * checkout, com o carrinho montado.
   */
  pickupEnabled: boolean;
  /**
   * O QUE MAIS TEM NESSA PRATELEIRA (rodada 56).
   *
   * Mesma loja, mesmo departamento, sem ele mesmo. Não é recomendação: é a
   * prateleira ao lado, que é o que uma loja de verdade oferece a quem parou
   * na frente de uma peça.
   *
   * VAZIO quando o produto não tem departamento — e vazio é a resposta certa.
   * "Sem categoria" não é uma categoria: relacionar tudo que não tem categoria
   * juntaria batom com pneu, e o cliente leria isso como sistema quebrado.
   */
  related: StorefrontProduct[];
}

const CAMPOS_ENVIO: { coluna: string; rotulo: string }[] = [
  { coluna: 'weight_grams', rotulo: 'peso' },
  { coluna: 'height_cm', rotulo: 'altura' },
  { coluna: 'width_cm', rotulo: 'largura' },
  { coluna: 'length_cm', rotulo: 'comprimento' },
];

/**
 * Produto de UMA loja, para a página pública.
 *
 * O `storeSlug` é conferido no SERVIDOR, não escondido na tela: sem isso, a
 * URL da Gringa serviria produto do Preço Justo, e a página mostraria a loja
 * errada como vendedora. Produto de outra operação simplesmente não existe
 * nesta URL.
 */
export function getStorefrontProductDetail(
  storeSlug: string,
  productId: string,
  /**
   * A PRATELEIRA AO LADO É OPCIONAL, e quem cota frete não a pede.
   *
   * Montá-la custa uma varredura do departamento inteiro — que é o desenho
   * deliberado desta listagem: promoção e grade não são coluna, então tudo
   * passa por `decorate`. Vale a pena na página do produto, onde a pessoa vai
   * olhar; não vale em `POST /shipping-quote`, que roda a cada CEP digitado,
   * usa duas linhas da resposta e joga o resto fora.
   */
  comRelacionados = true,
): StorefrontProductDetail | null {
  ensureCoreSchema();
  const db = getConnection();

  const row = db
    .prepare(
      `SELECT p.id, p.company_id, p.name, p.description, p.category, p.brand, p.unit,
              p.image_url, p.price_cents, p.subcategory, p.online_description,
              p.weight_grams, p.height_cm, p.width_cm, p.length_cm,
              c.slug, c.trade_name
         FROM core_products p
         JOIN core_companies c ON c.id = p.company_id
        WHERE ${PRODUTO_VISIVEL_NA_LOJA} AND p.id = ? AND c.slug = ?`,
    )
    .get(productId, storeSlug) as
    | (ProductRow & {
      subcategory: string | null;
      online_description: string | null;
      weight_grams: number | null;
      height_cm: number | null;
      width_cm: number | null;
      length_cm: number | null;
    })
    | undefined;
  if (!row) return null;

  const imagens = db
    .prepare(
      `SELECT url, is_primary FROM core_product_images
        WHERE product_id = ? ORDER BY is_primary DESC, position`,
    )
    .all(productId) as unknown as { url: string; is_primary: number }[];

  /*
    Variantes são produtos-filho com saldo próprio. Vender o P não pode
    consumir o G — por isso cada uma traz o próprio disponível.

    A GRADE PASSA PELA MESMA PORTA QUE O RESTO DA VITRINE.

    Esta consulta conferia só `active = 1`. Era a sétima leitura de produto da
    loja e a única fora da regra: mostrava a variante despublicada e mostraria a
    variante que fosse peça de bancada, porque a filtragem parecia já ter
    acontecido no produto-pai. Não acontece — cada variante é uma linha própria
    de `core_products`, com o próprio `publish_online` e o próprio `kind`.

    `generateVariants` copia o `publish_online` do modelo na criação, então a
    grade de um modelo publicado nasce inteira publicada: o caso que some daqui
    é o da variante que alguém tirou da loja de propósito — a cor que saiu de
    linha —, e essa é justamente a que o checkout já recusava três cliques
    depois, com um "produto indisponível" que o cliente não tinha como prever.
  */
  const variantes = db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.price_cents, p.variant_attributes
         FROM core_products p
        WHERE p.company_id = ? AND p.parent_id = ? AND ${PRODUTO_VISIVEL_NA_LOJA}
        ORDER BY p.internal_code`,
    )
    .all(row.company_id, productId) as unknown as {
    id: string;
    name: string;
    barcode: string | null;
    price_cents: number;
    variant_attributes: string | null;
  }[];

  const faltando = CAMPOS_ENVIO.filter(({ coluna }) => {
    const valor = (row as unknown as Record<string, number | null>)[coluna];
    return valor === null || valor === undefined || Number(valor) <= 0;
  }).map(({ rotulo }) => rotulo);

  return {
    ...decorate(row),
    companyId: row.company_id,
    // A descrição de vitrine é escrita para o cliente; a interna é para quem
    // opera. Mostrar a errada expõe anotação de estoque na loja.
    description: row.online_description ?? row.description,
    subcategory: row.subcategory,
    images: imagens.map((i) => ({ url: i.url, isPrimary: i.is_primary === 1 })),
    variants: variantes.map((v) => ({
      id: v.id,
      name: v.name,
      barcode: v.barcode,
      attributes: parseAtributos(v.variant_attributes),
      priceCents: effectivePriceCents(
        row.company_id,
        v.id,
        v.price_cents,
        row.category,
        SEM_TABELA_NA_VITRINE,
      ).priceCents,
      available: getAvailable(row.company_id, v.id),
    })),
    shippingReadiness: faltando.length === 0 ? 'READY_FOR_SHIPPING' : 'SHIPPING_DATA_INCOMPLETE',
    missingShippingFields: faltando,
    // Mesma fonte do selo "Retire na loja" — uma pergunta, uma resposta.
    pickupEnabled: getShippingSettings(row.company_id).pickup_enabled === 1,
    /*
      A prateleira ao lado. Passa pela MESMA `listStorefrontProducts`, e não
      por uma consulta própria, porque é ela que carrega a regra de
      visibilidade, o preço com promoção e a agregação de grade. Uma segunda
      consulta traria produto despublicado ou preço de tabela — a diferença que
      só aparece com o cliente no carrinho.
    */
    related: comRelacionados && String(row.category ?? '').trim()
      ? listStorefrontProducts({
          storeSlug,
          category: row.category ?? undefined,
          excludeProductId: row.id,
          limit: 8,
        }).items
      : [],
  };
}

function parseAtributos(bruto: string | null): Record<string, string> {
  if (!bruto) return {};
  try {
    return JSON.parse(bruto) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Um departamento da vitrine, com os galhos dentro.
 *
 * `productCount` do PAI inclui as filhas, porque é o número que o cliente
 * espera ao clicar num departamento: ele quer ver tudo que está lá dentro, não
 * só o que ficou solto na raiz.
 */
export interface StorefrontDepartment {
  name: string;
  productCount: number;
  children: { name: string; productCount: number }[];
}

/**
 * OS DEPARTAMENTOS DA LOJA — a ÁRVORE, e não texto solto (rodada 56).
 *
 * ## O que estava errado
 *
 * Esta função devolvia `SELECT DISTINCT p.category`: uma lista de strings, sem
 * nível, sem ordem que alguém tenha decidido, sem contagem. A vitrine então
 * desenhava pílulas achatadas, e "Camisas" — que é um galho de "Vestuário" —
 * apareceria ao lado do próprio pai como se fossem irmãos.
 *
 * E o sistema JÁ SABIA a hierarquia. `TaxonomyService` mantém `core_categories`
 * com pai e filha, tem tela própria, renomeia, funde e conta uso; o cadastro de
 * produto escolhe a categoria a partir dela. O que faltava era a LOJA usar: a
 * árvore existia no escritório e a vitrine mostrava texto solto.
 *
 * ## Por que a junção é por NOME
 *
 * Porque é a doutrina declarada do repositório (ver o cabeçalho de
 * `TaxonomyService`): o produto guarda o TEXTO, e a tabela é a lista do que
 * PODE ser escolhido. Trocar para chave estrangeira desligaria em silêncio
 * toda promoção por categoria já cadastrada, que casa por texto — o tipo de
 * mudança que só aparece quando o cliente reclama do preço no caixa.
 *
 * ## Departamento vazio não vira gaveta
 *
 * A regra que já valia para peça de bancada vale para o vocabulário inteiro:
 * categoria sem NADA que dê para comprar não é filtro, é uma gaveta que o
 * cliente abre e fecha sem nada. Some da vitrine e continua no cadastro.
 */
export function listCategories(storeSlug?: string): StorefrontDepartment[] {
  ensureCoreSchema();
  const params: unknown[] = [];
  let filtroDaLoja = '';
  if (storeSlug) {
    filtroDaLoja = ' AND c.slug = ?';
    params.push(storeSlug);
  }

  /*
    A contagem sai do PRODUTO, não da tabela de categorias: é o produto que
    está publicado ou não. `lower(trim(...))` dos dois lados porque a UNIQUE do
    banco é sensível a caixa e o texto do produto foi digitado por gente —
    a mesma dobra que `TaxonomyService` usa para contar uso.
  */
  const linhas = getConnection()
    .prepare(
      `SELECT c.id AS companyId,
              p.category AS categoria,
              p.subcategory AS subcategoria,
              COUNT(*) AS quantos
         FROM core_products p
         JOIN core_companies c ON c.id = p.company_id
        WHERE ${PRODUTO_VISIVEL_NA_LOJA}
          -- A MESMA RÉGUA DA GRADE: variante de grade não é card.
          --
          -- A listagem da vitrine filtra parent_id IS NULL porque a
          -- grade inteira aparece num card só. Sem esta linha o departamento
          -- contava cada tamanho e cada cor: "Vestuário (12)" ao lado de uma
          -- grade com três cards. O número que o cliente lê tem de ser o
          -- número do que ele vai ver ao clicar.
          AND p.parent_id IS NULL
          AND p.category IS NOT NULL AND TRIM(p.category) <> ''${filtroDaLoja}
        GROUP BY c.id, p.category, p.subcategory`,
    )
    .all(...(params as never[])) as unknown as {
    companyId: string;
    categoria: string;
    subcategoria: string | null;
    quantos: number;
  }[];

  if (linhas.length === 0) return [];

  /*
    A ORDEM é a que o vocabulário declara, e não a alfabética.

    Alfabética coloca "Acessórios" antes de "Motos" numa loja de motos. Quem
    decide o que vem primeiro é quem cadastrou os departamentos — e essa ordem
    já existe no índice da tabela.
  */
  const ordem = new Map<string, number>();
  const vocabulario = getConnection()
    .prepare(
      `SELECT k.company_id AS companyId, k.name, k.parent_id AS parentId
         FROM core_categories k
        WHERE k.active = 1
        ORDER BY k.company_id, k.parent_id, k.name`,
    )
    .all() as unknown as { companyId: string; name: string; parentId: string | null }[];
  vocabulario.forEach((v, i) => {
    ordem.set(chaveDoDepartamento(storeSlug, v.companyId, v.name), i);
  });

  const porNome = new Map<string, StorefrontDepartment>();
  const filhasVistas = new Map<string, Set<string>>();

  for (const linha of linhas) {
    const raiz = String(linha.categoria).trim();
    const idRaiz = chaveDoDepartamento(storeSlug, linha.companyId, raiz);
    let dep = porNome.get(idRaiz);
    if (!dep) {
      dep = { name: raiz, productCount: 0, children: [] };
      porNome.set(idRaiz, dep);
      filhasVistas.set(idRaiz, new Set());
    }
    // O pai conta tudo que está debaixo dele, inclusive o que está nos galhos.
    dep.productCount += Number(linha.quantos);

    const galho = String(linha.subcategoria ?? '').trim();
    if (!galho) continue;
    const jaVistas = filhasVistas.get(idRaiz)!;
    if (jaVistas.has(chave(galho))) {
      const existente = dep.children.find((f) => chave(f.name) === chave(galho))!;
      existente.productCount += Number(linha.quantos);
      continue;
    }
    jaVistas.add(chave(galho));
    dep.children.push({ name: galho, productCount: Number(linha.quantos) });
  }

  const departamentos = [...porNome.entries()].map(([id, dep]) => ({ id, dep }));
  departamentos.sort(
    (a, b) =>
      (ordem.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ordem.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      || a.dep.name.localeCompare(b.dep.name, 'pt-BR'),
  );

  return departamentos.map(({ dep }) => ({
    ...dep,
    children: [...dep.children].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
  }));
}

/**
 * A identidade de um departamento na resposta.
 *
 * NA PÁGINA DA MARCA a empresa entra na chave: cada loja tem a própria árvore,
 * e duas lojas do grupo podem ter departamentos de mesmo nome sem se
 * misturarem.
 *
 * NA HOME DO GRUPO, não. Ali o filtro não tem loja — `?category=Vestuário`
 * traz o vestuário das cinco —, e separar por empresa desenhava DUAS pílulas
 * "Vestuário" lado a lado, cada uma com uma contagem que não batia com o que o
 * clique devolvia. O departamento da home é do grupo, e a contagem soma.
 */
function chaveDoDepartamento(
  storeSlug: string | undefined,
  companyId: string,
  nome: string,
): string {
  return storeSlug ? `${companyId}::${chave(nome)}` : chave(nome);
}

/**
 * Dobra de caixa e espaço — a MESMA que o SQL faz, e não uma melhor.
 *
 * ## Por que não `toLowerCase()`
 *
 * O filtro da listagem compara com `LOWER(TRIM(...))`, e o `LOWER` do SQLite
 * só dobra ASCII: `LOWER('CALÇADOS')` devolve `calÇados`, com o Ç intacto. O
 * `toLowerCase()` do JavaScript devolve `calçados`.
 *
 * Com as duas dobras diferentes, a árvore JUNTAVA "CALÇADOS" e "Calçados" num
 * departamento só e o filtro SEPARAVA: o cliente clicava numa pílula que dizia
 * ter cinco peças e recebia duas, sem nada explicando a diferença. Duas dobras
 * para a mesma pergunta é o defeito que este repositório mais encontra — e
 * aqui a resposta certa é a MENOS esperta, porque é a que as duas pontas
 * conseguem fazer igual.
 *
 * A consequência aceita: variante de caixa em palavra acentuada aparece como
 * dois departamentos. O vocabulário já defende disso (`TaxonomyService` recusa
 * cadastrar "masculino" quando "Masculino" existe), e a tela de categorias tem
 * o gesto de FUNDIR para o que escapou por outro caminho.
 */
function chave(valor: string): string {
  return String(valor ?? '')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// ------------------------------------------------------------------- pedidos

export interface CheckoutItem {
  productId: string;
  quantity: number;
}

export interface CheckoutInput {
  idempotencyKey: string;
  customerName: string;
  customerEmail?: string;
  customerDocument?: string;
  customerPhone?: string;
  shippingZip?: string;
  shippingAddress?: string;
  /**
   * A entrega JÁ RESOLVIDA pelo servidor, UMA POR OPERAÇÃO.
   *
   * Antes eram dois campos soltos, `shippingMethod` e `shippingCents`, e a
   * rota preenchia o segundo com o número que vinha do navegador — três linhas
   * abaixo do comentário que garante que o cliente não define valor. Só entra
   * aqui o que `resolveCheckoutShipping` devolveu, e essa função só devolve
   * preço de cotação real ou da tabela do dono.
   *
   * E era UM frete para o carrinho inteiro, aplicado ao primeiro pedido da
   * divisão. Carrinho de duas lojas são duas encomendas, de dois endereços:
   * cada operação traz a sua, cotada com o peso e a origem dela.
   */
  shippingPorEmpresa?: Record<string, ResolvedShipping>;
  paymentMethod: string;
  /**
   * Parcelas no cartão (GAP-PRD-114). Conferidas contra o teto de CADA loja e
   * contra a parcela mínima, antes de o pedido nascer. Ausente = à vista.
   */
  installments?: number;
  items: CheckoutItem[];
  /**
   * A CONTA que está comprando, já conferida (`prepararComprador`): e-mail
   * provado e cadastro completo. Presente, o pedido nasce dela; ausente, é
   * pedido de visitante — só quando a loja permite (GAP-PRD-028).
   */
  comprador?: CompradorDaConta;
  /**
   * O RETRATO dos endereços salvos escolhidos (GAP-PRD-115) — entrega e
   * faturamento, já conferidos (da própria conta, tipo que serve para o uso).
   * O pedido guarda cada campo na sua coluna; editar ou apagar o endereço
   * depois não o muda. Ausentes = endereço digitado em texto (visitante) ou
   * nenhum.
   */
  enderecoDeEntrega?: RetratoDoEndereco | null;
  enderecoDeFaturamento?: RetratoDoEndereco | null;
  /**
   * O cupom digitado no checkout (GAP-PRD-123). Desconta só o pedido da
   * empresa que tem este código; nenhuma loja do carrinho com ele = recusa
   * antes de reservar qualquer coisa. Ver `CupomService`.
   */
  couponCode?: string;
}

/** O frete que o SERVIDOR decidiu. Ver `CheckoutShippingService`. */
export interface ResolvedShipping {
  method: string;
  label: string;
  priceCents: number;
  estimatedDays: number | null;
  /** Prazo de transportadora real? Só então o pedido promete data ao cliente. */
  real: boolean;
}

export interface OrderRecord {
  id: string;
  company_id: string;
  number: number;
  total_cents: number;
  status: string;
  created_at: string;
}

/**
 * A impressão do CHECKOUT INTEIRO (R2-IDEM) — todas as lojas de uma vez.
 *
 * A de cada pedido (`idempotency_fingerprint`) só vê a parte da loja dele, e
 * por isso não enxergava a loja que SAIU nem a que ENTROU no carrinho. Esta
 * leva o pedido como o comprador o fez: os itens de todas as lojas (sem
 * ordem), o frete escolhido de cada loja, o CEP, o endereço digitado e os
 * endereços salvos escolhidos, a forma de pagamento, as parcelas, o cupom e
 * quem compra. O PREÇO do frete fica de fora: é o servidor que cota de novo, e
 * a cotação que oscila entre o clique e o reenvio não é outro pedido.
 */
function impressaoDoCheckoutInteiro(
  input: CheckoutInput,
  comprador: CompradorDaConta | undefined,
  documentoDoPedido: string | null | undefined,
): string {
  const retrato = (e: RetratoDoEndereco | null | undefined) =>
    e
      ? [e.addressId, e.recipientName, e.zip, e.street, e.number, e.complement, e.district, e.city, e.state].map(
          (v) => Impressao.texto(v),
        )
      : null;
  const fretes = input.shippingPorEmpresa ?? {};
  return Impressao.impressaoDe({
    itens: (input.items ?? [])
      .map((i) => JSON.stringify([String(i.productId), Impressao.numero(i.quantity)]))
      .sort(Impressao.porCodigo),
    fretes: Object.keys(fretes)
      .sort(Impressao.porCodigo)
      .map((empresa) => [empresa, fretes[empresa]?.method ?? 'retirada']),
    cep: Impressao.texto(input.shippingZip),
    endereco: Impressao.texto(input.shippingAddress),
    entrega: retrato(input.enderecoDeEntrega),
    faturamento: retrato(input.enderecoDeFaturamento),
    pagamento: String(input.paymentMethod ?? ''),
    parcelas: Math.round(Number(input.installments ?? 1)) || 1,
    cupom: normalizarCodigo(input.couponCode) ?? '',
    comprador: comprador?.accountId ?? Impressao.texto(documentoDoPedido),
  });
}

/**
 * Fecha o pedido de UMA loja.
 *
 * Carrinho com itens de operações diferentes é dividido em um pedido por
 * operação — cada empresa precisa receber seu próprio pedido, estoque e
 * financeiro; misturar faturamento entre empresas seria erro contábil.
 */
export function checkout(input: CheckoutInput): OrderRecord[] {
  ensureCoreSchema();
  if (!input.items?.length) {
    throw new ApiError('CORE_EMPTY_CART', 'Carrinho vazio.', 400);
  }
  if (!input.idempotencyKey) {
    throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Chave de idempotência obrigatória.', 400);
  }
  /*
    QUEM COMPRA (GAP-PRD-028/043). Com conta, nome, e-mail e documento do
    pedido são os da CONTA — o e-mail é o provado, não o que o corpo mandar —,
    e o pedido nasce dela. Sem conta, valem os digitados, como sempre.
  */
  const comprador = input.comprador;
  const nomeDoPedido = (comprador?.name ?? input.customerName ?? '').trim();
  const emailDoPedido = comprador ? comprador.email : (input.customerEmail ?? null);
  const documentoDoPedido = comprador ? comprador.document : (input.customerDocument ?? null);
  if (!nomeDoPedido) {
    throw new ApiError('CORE_CUSTOMER_REQUIRED', 'Informe o nome do cliente.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();

    /*
      O MESMO CHECKOUT É O MESMO CARRINHO INTEIRO (R2-IDEM).

      Os pedidos desta chave são os de TODAS as lojas (`<chave>:<empresa>`). A
      conferência por loja, logo abaixo, só via a parte de cada uma: a mesma
      chave com a loja B retirada respondia só o pedido da A — e o da B seguia
      reservando, sem aparecer na resposta —, e com a B acrescentada criava um
      pedido novo para ela. Aqui, ANTES de ler produto ou reservar qualquer
      coisa: o mesmo carrinho devolve TODOS os pedidos da primeira vez; outro
      carrinho é 422. Pedido sem esta impressão (anterior à coluna) segue a
      regra por loja, a de antes.
    */
    const impressaoDoCheckout = impressaoDoCheckoutInteiro(input, comprador, documentoDoPedido);
    const doCheckout = db
      .prepare(`SELECT * FROM core_orders WHERE idempotency_key = (? || ':' || company_id) ORDER BY rowid`)
      .all(input.idempotencyKey) as unknown as (OrderRecord & { checkout_fingerprint?: string | null })[];
    if (doCheckout.some((o) => o.checkout_fingerprint)) {
      if (doCheckout.some((o) => Impressao.outraImpressao(o.checkout_fingerprint, impressaoDoCheckout))) {
        const numeros = doCheckout.map((o) => `#${o.number}`).join(', ');
        throw Impressao.chaveReusada(doCheckout.length > 1 ? `os pedidos ${numeros}` : `o pedido ${numeros}`, {
          orderIds: doCheckout.map((o) => o.id),
          orderNumbers: doCheckout.map((o) => o.number),
        });
      }
      return doCheckout;
    }

    // Agrupa por empresa dona do produto.
    const byCompany = new Map<string, { productId: string; quantity: number }[]>();
    for (const item of input.items) {
      // A ÚLTIMA PORTA. Tudo que a vitrine mostrou passa por aqui de novo, com
      // a mesma condição: entre ver a tela e apertar "finalizar", o produto
      // pode ter saído da loja ou virado peça de bancada.
      const product = db
        .prepare(
          `SELECT p.id, p.company_id, p.name,
                  EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
             FROM core_products p
            WHERE p.id = ? AND ${PRODUTO_VISIVEL_NA_LOJA}`,
        )
        .get(item.productId) as
        | { id: string; company_id: string; name: string; tem_grade: number }
        | undefined;
      if (!product) {
        throw new ApiError(
          'CORE_PRODUCT_NOT_AVAILABLE',
          'Produto indisponível para venda online.',
          404,
          { productId: item.productId },
        );
      }

      /*
        MODELO DE GRADE NÃO É ITEM DE PEDIDO.

        A vitrine mostra o MODELO num card só — é a decisão certa, senão uma
        camisa com P/M/G viraria quatro cards —, e a página do produto oferece
        a variante. Mas esta função se anuncia como "A ÚLTIMA PORTA", e a porta
        só conferia `PRODUTO_VISIVEL_NA_LOJA`, que não olha grade.

        Um POST de checkout com o id do modelo passava, reservava o saldo que
        ficou preso nele e o consumia num pedido de "a camisa" sem tamanho —
        a única saída que aquele saldo tinha, e pela porta errada. O balcão
        recusa a mesma venda desde sempre (`CORE_PRODUCT_HAS_VARIANTS`).
      */
      if (product.tem_grade) {
        throw new ApiError(
          'CORE_PRODUCT_HAS_VARIANTS',
          `"${product.name}" tem grade: escolha o tamanho/cor antes de finalizar.`,
          400,
          { productId: item.productId },
        );
      }
      if (!(item.quantity > 0)) {
        throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade inválida.', 400);
      }
      const list = byCompany.get(product.company_id) ?? [];
      list.push({ productId: product.id, quantity: item.quantity });
      byCompany.set(product.company_id, list);
    }

    const orders: OrderRecord[] = [];

    /*
      O CUPOM (GAP-PRD-123) é conferido ANTES de reservar qualquer coisa: se
      nenhuma loja do carrinho tem este código, a recusa sai aqui e nada é
      numerado. Cada pedido novo aplica o cupom da PRÓPRIA empresa.
    */
    const codigoDoCupom = normalizarCodigo(input.couponCode);
    const lojasComCupom = codigoDoCupom
      ? new Set(empresasComCupom(codigoDoCupom, [...byCompany.keys()]))
      : new Set<string>();
    if (codigoDoCupom && lojasComCupom.size === 0) throw cupomInvalido(codigoDoCupom);

    for (const [companyId, items] of byCompany) {
      // Chave derivada por empresa: reenviar o mesmo checkout devolve os
      // mesmos pedidos em vez de criar um segundo jogo.
      const key = `${input.idempotencyKey}:${companyId}`;
      /*
        O MESMO CHECKOUT É O MESMO CARRINHO (RES-IDEM-VIZ).

        O pedido da chave era devolvido sem olhar o carrinho: o reenvio com
        outra quantidade, outro produto ou outra forma de pagamento respondia o
        pedido antigo, e o comprador achava que tinha comprado o que não foi
        pedido — nem reservado. A impressão é da parte DESTA loja (itens sem
        ordem, pagamento, parcelas, entrega, cupom e comprador); a recusa é 422
        e desfaz o carrinho inteiro, como toda recusa desta transação. Pedido
        anterior à impressão (nula) segue a regra de sempre.
      */
      const impressaoDoPedido = Impressao.impressaoDe({
        itens: items
          .map((i) => JSON.stringify([String(i.productId), Impressao.numero(i.quantity)]))
          .sort(Impressao.porCodigo),
        pagamento: String(input.paymentMethod ?? ''),
        parcelas: Math.round(Number(input.installments ?? 1)) || 1,
        entrega: input.shippingPorEmpresa?.[companyId]?.method ?? 'retirada',
        cupom: codigoDoCupom && lojasComCupom.has(companyId) ? codigoDoCupom : '',
        comprador: comprador?.accountId ?? String(documentoDoPedido ?? ''),
      });
      const existing = db
        .prepare('SELECT * FROM core_orders WHERE company_id = ? AND idempotency_key = ?')
        .get(companyId, key) as unknown as (OrderRecord & { idempotency_fingerprint?: string | null }) | undefined;
      if (existing) {
        if (Impressao.outraImpressao(existing.idempotency_fingerprint, impressaoDoPedido)) {
          throw Impressao.chaveReusada(`o pedido #${existing.number}`, {
            orderId: existing.id,
            orderNumber: existing.number,
          });
        }
        orders.push(existing);
        continue;
      }

      const orderId = randomUUID();
      const now = new Date().toISOString();
      const number = nextSequenceValue(companyId, 'ecommerce_order');

      // O cliente é o OFICIAL da operação, não um texto solto no pedido.
      // Sem isso, o histórico de compras do cliente não existe e a cobrança
      // não tem a quem se vincular no provedor. Achar o cadastro pelo CPF
      // NÃO o reescreve (GAP-PRD-006) — ver `CheckoutIdentityService`.
      const cliente = comprador
        ? cadastroDaConta(companyId, comprador, input.shippingAddress)
        : cadastroDoVisitante(companyId, {
            name: nomeDoPedido,
            document: input.customerDocument,
            email: input.customerEmail,
            phone: input.customerPhone,
            address: input.shippingAddress,
          });

      const priced = items.map((item) => {
        const product = db
          .prepare('SELECT id, name, price_cents, category FROM core_products WHERE id = ?')
          .get(item.productId) as {
          id: string;
          name: string;
          price_cents: number;
          category: string | null;
        };
        // Preço vem do servidor, com promoção — o cliente não define valor. E
        // sem tabela: o pedido da loja online é cobrado pelo preço público,
        // que é o que o comprador viu na tela (ver SEM_TABELA_NA_VITRINE). A
        // linha inteira disputa o estoque promocional (GAP-PRD-194).
        const vigente = effectivePriceCents(
          companyId,
          product.id,
          product.price_cents,
          product.category,
          { ...SEM_TABELA_NA_VITRINE, unidadesDaLinha: item.quantity },
        );
        const total = Math.round(vigente.priceCents * item.quantity);
        return {
          product,
          quantity: item.quantity,
          unit: vigente.priceCents,
          total,
          onSale: vigente.onSale,
          promotionId: vigente.promocaoId ?? null,
          /** A parte do cupom desta linha; o valor gravado é total − desconto. */
          discount: 0,
        };
      });

      /*
        O CUPOM DESTA EMPRESA (GAP-PRD-123), rateado nos itens. O pedido guarda
        a soma LÍQUIDA em items_cents e cada item o seu total líquido — é assim
        que a cobrança, a NF-e (vProd/vDesc) e os relatórios ficam certos sem
        aprender o que é cupom.
      */
      const quemUsa = { accountId: comprador?.accountId ?? null, email: emailDoPedido };
      let cupom: CupomAplicado | null = null;
      if (codigoDoCupom && lojasComCupom.has(companyId)) {
        cupom = aplicarCupom({
          companyId,
          code: codigoDoCupom,
          linhas: priced.map((l) => ({
            productId: l.product.id,
            totalCents: l.total,
            emPromocao: l.onSale,
          })),
          quem: quemUsa,
        });
        cupom.porLinha.forEach((d, i) => {
          priced[i].discount = d;
        });
      }
      const itemsCents = priced.reduce((s, l) => s + l.total - l.discount, 0);
      const descontoDoCupom = cupom?.discountCents ?? 0;

      /**
       * O FRETE DESTA OPERAÇÃO — e só dela.
       *
       * Aqui era `index === 0 ? frete.priceCents : 0`, com o método da
       * primeira loja copiado para todas. O comentário justificava: "o frete
       * só entra no primeiro pedido da divisão, para não cobrar o mesmo envio
       * uma vez por empresa".
       *
       * Só que não é o mesmo envio. São duas encomendas, de dois endereços,
       * com dois pesos — e o cliente pagava uma. A segunda operação despachava
       * por conta dela, com um prazo prometido que veio da cotação da
       * primeira. Cada pedido passa a carregar o frete que foi cotado PARA ELE.
       *
       * SEM ENTREGA ARRANJADA, É RETIRADA — nunca entrega grátis.
       *
       * O método ficava NULL quando ninguém escolhia, e NULL não é retirada:
       * `isPickup(null)` é falso, então o pedido nascia "entrega" com frete
       * zero e a operação pagava o envio. O default seguro é o que não gasta
       * dinheiro de ninguém: o cliente busca no balcão. Quem quer entrega
       * escolhe, e aí o frete tem preço e origem.
       */
      const frete = input.shippingPorEmpresa?.[companyId];
      const entrega = input.enderecoDeEntrega ?? null;
      const fatura = input.enderecoDeFaturamento ?? null;
      const metodo = frete?.method ?? 'retirada';
      const shipping = Math.max(0, Math.round(frete?.priceCents ?? 0));

      // O selo "Parcele em até Nx" passa a ter execução (GAP-PRD-114): a
      // escolha precisa caber no teto DESTA loja e na parcela mínima. Recusar
      // aqui desfaz o carrinho inteiro — nenhum pedido nasce pela metade.
      conferirParcelasDaLoja({
        companyId,
        totalCents: itemsCents + shipping,
        parcelas: input.installments ?? 1,
      });

      db.prepare(
        `INSERT INTO core_orders
           (id, company_id, number, customer_id, customer_name, customer_email, customer_document,
            shipping_zip, shipping_address, shipping_method, shipping_cents,
            shipping_service_name, shipping_estimated_days, shipping_quote_real,
            items_cents, total_cents, status, payment_method, idempotency_key,
            customer_account_id,
            shipping_address_id, shipping_recipient_name, shipping_street, shipping_number,
            shipping_complement, shipping_district, shipping_city, shipping_state, shipping_city_ibge,
            billing_address_id, billing_name, billing_zip, billing_street, billing_number,
            billing_complement, billing_district, billing_city, billing_state, billing_city_ibge,
            coupon_id, coupon_code, discount_cents, idempotency_fingerprint, checkout_fingerprint,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_pagamento', ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, ?)`,
      ).run(
        orderId,
        companyId,
        number,
        String(cliente.id),
        nomeDoPedido,
        emailDoPedido,
        documentoDoPedido,
        input.shippingZip ?? null,
        input.shippingAddress ?? null,
        metodo,
        shipping,
        frete?.label ?? null,
        // Prazo e origem do prazo acompanham o pedido: sem eles não há como,
        // depois, distinguir data prometida de data adivinhada.
        frete?.estimatedDays ?? null,
        frete?.real ? 1 : 0,
        itemsCents,
        itemsCents + shipping,
        input.paymentMethod,
        key,
        // O pedido é DA CONTA que o fechou — é esta coluna que o portal lê.
        comprador?.accountId ?? null,
        // O retrato da ENTREGA (GAP-PRD-115): quem recebe é o destinatário
        // declarado no endereço, ou quem comprou.
        entrega?.addressId ?? null,
        entrega ? entrega.recipientName || nomeDoPedido : null,
        entrega?.street ?? null,
        entrega?.number ?? null,
        entrega?.complement ?? null,
        entrega?.district ?? null,
        entrega?.city ?? null,
        entrega?.state ?? null,
        entrega?.cityIbge ?? null,
        // O retrato do FATURAMENTO: o destinatário da nota é quem comprou.
        fatura?.addressId ?? null,
        fatura ? nomeDoPedido : null,
        fatura?.zip ?? null,
        fatura?.street ?? null,
        fatura?.number ?? null,
        fatura?.complement ?? null,
        fatura?.district ?? null,
        fatura?.city ?? null,
        fatura?.state ?? null,
        fatura?.cityIbge ?? null,
        // O retrato do cupom (GAP-PRD-123): qual código e quanto descontou.
        cupom?.cupomId ?? null,
        cupom?.code ?? null,
        descontoDoCupom,
        impressaoDoPedido,
        impressaoDoCheckout,
        now,
        now,
      );

      const itemStmt = db.prepare(
        `INSERT INTO core_order_items
           (id, order_id, company_id, product_id, description, quantity, unit_price_cents,
            total_cents, discount_cents, promotion_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // O uso do cupom nasce com o pedido, na mesma transação (GAP-PRD-123).
      if (cupom) registrarUsoDoCupom({ companyId, cupom, orderId, quem: quemUsa });
      for (const line of priced) {
        itemStmt.run(
          randomUUID(),
          orderId,
          companyId,
          line.product.id,
          line.product.name,
          line.quantity,
          line.unit,
          // Líquido do cupom: unitário × quantidade − a parte do desconto.
          line.total - line.discount,
          line.discount,
          line.promotionId,
        );
        // Reserva já: o item fica indisponível para outro comprador enquanto
        // o pagamento não resolve.
        reserveStock({
          companyId,
          productId: line.product.id,
          quantity: line.quantity,
          kind: 'ECOMMERCE_RESERVATION',
          referenceType: 'ecommerce_order',
          referenceId: orderId,
        });
      }

      addOrderEvent(orderId, companyId, 'aguardando_pagamento', 'Pedido criado');
      const pedido = db
        .prepare('SELECT * FROM core_orders WHERE id = ?')
        .get(orderId) as unknown as OrderRecord;

      recordDomainEvent({
        eventType: 'order.placed',
        aggregateType: 'ecommerce_order',
        aggregateId: orderId,
        companyId,
        payload: pedido as unknown as Record<string, unknown>,
      });

      // A mensagem é montada AGORA, com o pedido como ele nasceu. Montar na
      // hora do envio leria um pedido que pode ter mudado.
      enfileirarEmailDoPedido(pedido, 'pedido_recebido', `pedido_recebido:${orderId}`);

      orders.push(pedido);
    }

    return orders;
  });
}

/**
 * Enfileira o e-mail de um marco do pedido.
 *
 * Nunca lança: falta de e-mail, endereço torto ou fila indisponível não podem
 * derrubar a venda. Perder um pedido porque o cliente digitou o e-mail errado
 * seria trocar um problema pequeno por um grande.
 *
 * A chave de deduplicação amarra a mensagem AO FATO, não ao instante: dez
 * webhooks repetidos do mesmo pagamento geram um e-mail só.
 */
function enfileirarEmailDoPedido(
  pedido: OrderRecord,
  template: EmailTemplate,
  dedupeKey: string,
  /** O que só alguns marcos dizem: quem cancelou, como o dinheiro volta (GAP-PRD-037). */
  extra: Partial<Contexto> = {},
): void {
  try {
    const p = pedido as unknown as Record<string, unknown>;
    const loja = getConnection()
      .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
      .get(pedido.company_id) as { trade_name: string } | undefined;

    queueEmail({
      companyId: pedido.company_id,
      template,
      toAddress: p.customer_email as string | null,
      dedupeKey,
      context: {
        storeName: loja?.trade_name ?? 'Grupo Sampaio',
        customerName: String(p.customer_name ?? 'Cliente'),
        orderNumber: Number(pedido.number),
        totalCents: Number(pedido.total_cents),
        trackingCode: (p.tracking_code as string | null) ?? null,
        // O link e o nome da transportadora (GAP-PRD-119): o código sozinho
        // mandava o cliente adivinhar em que site procurar.
        trackingUrl: linkDeRastreio(p.shipping_carrier as string | null, p.tracking_code as string | null),
        carrierName: nomeDaTransportadora(p.shipping_carrier as string | null),
        estimatedDays:
          p.shipping_estimated_days === null || p.shipping_estimated_days === undefined
            ? null
            : Number(p.shipping_estimated_days),
        retirada: isPickup(p.shipping_method as string | null | undefined),
        linkDoPedido: `${publicBaseUrl()}/minha-conta/pedidos/${pedido.id}`,
        linkDaLoja: `${publicBaseUrl()}/loja`,
        ...extra,
      },
    });
  } catch (err) {
    // A venda vale mais que a notificação.
    console.warn(`[email] não foi possível enfileirar ${template}: ${(err as Error).message}`);
  }
}

/**
 * De onde veio a mudança do pedido (GAP-PRD-119). "Entregue" dito pela
 * transportadora e "entregue" clicado no balcão não valem o mesmo.
 */
export type OrigemDoEvento = 'operador' | 'provedor' | 'cliente' | 'sistema';

export function addOrderEvent(
  orderId: string,
  companyId: string,
  status: string,
  note?: string,
  userId?: string,
  origin?: OrigemDoEvento,
): void {
  // Transacional em si mesma: o evento do pedido e o fato para a central
  // precisam existir ou desaparecer juntos, seja qual for o caminho que chamou.
  // Aninhada dentro de outra transação, vira SAVEPOINT — ver withTransaction.
  withTransaction(() => registrarEventoDoPedido(orderId, companyId, status, note, userId, origin));
}

function registrarEventoDoPedido(
  orderId: string,
  companyId: string,
  status: string,
  note?: string,
  userId?: string,
  origin?: OrigemDoEvento,
): void {
  const eventoId = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_order_events (id, order_id, company_id, status, note, user_id, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(eventoId, orderId, companyId, status, note ?? null, userId ?? null, origin ?? null, agora);

  /*
    Toda mudança de estado do pedido é fato para a central. Concentrar aqui
    cobre pagamento, separação, expedição, cancelamento e o pagamento tardio
    sem espalhar chamada por cada writer.

    E O FATO CARREGA O RETRATO DO PEDIDO. O payload era só {order_id,
    event_id, status, note} — suficiente para a linha de histórico, magro
    demais para o estado em `erp_orders`, cujo INSERT exige total_cents.
    Três eventos reais assim falharam a projeção em 29/08/2026 (23502).

    Não é invenção de dado: o pedido ESTÁ no banco neste exato momento, uma
    consulta de distância. Pedido que não existe mais (deletado entre a
    mudança e a emissão) segue sem retrato — o histórico é fato de qualquer
    jeito, e não se inventa um total para um pedido que sumiu.
  */
  const retrato = getConnection()
    .prepare(
      `SELECT number, customer_id, customer_name, items_cents, shipping_cents,
              total_cents, payment_method, tracking_code
         FROM core_orders WHERE id = ? AND company_id = ?`,
    )
    .get(orderId, companyId) as Record<string, unknown> | undefined;

  recordDomainEvent({
    eventType: 'order.status_changed',
    aggregateType: 'ecommerce_order',
    aggregateId: orderId,
    companyId,
    operation: 'update',
    payload: {
      order_id: orderId,
      event_id: eventoId,
      status,
      note: note ?? null,
      ...(retrato ?? {}),
    },
    occurredAt: agora,
  });
}

/**
 * Confirma o pagamento do pedido: converte as reservas em saída de estoque e
 * cria o lançamento financeiro. Só deve ser chamada por confirmação
 * confiável (webhook do provedor ou baixa manual autorizada) — nunca pelo
 * frontend do comprador.
 */
export function markOrderPaid(input: {
  companyId: string;
  orderId: string;
  userId?: string | null;
  provider?: string;
  providerRef?: string;
}): OrderRecord {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const order = db
      .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
      .get(input.orderId, input.companyId) as unknown as OrderRecord | undefined;
    if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    if (order.status !== 'aguardando_pagamento') {
      // Idempotente: reprocessar o mesmo webhook não baixa estoque de novo.
      return order;
    }

    const items = db
      .prepare('SELECT product_id, quantity, description FROM core_order_items WHERE order_id = ?')
      .all(input.orderId) as unknown as {
      product_id: string;
      quantity: number;
      description: string;
    }[];

    for (const item of items) {
      consumeReservation({
        companyId: input.companyId,
        productId: item.product_id,
        quantity: item.quantity,
        referenceType: 'ecommerce_order',
        referenceId: input.orderId,
        userId: input.userId,
        note: `Pedido #${order.number}`,
      });
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_orders
          SET status = 'pago', paid_at = ?, payment_provider = ?, payment_ref = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, input.provider ?? null, input.providerRef ?? null, now, input.orderId);

    // Um único fato econômico para o pedido, igual à venda de balcão.
    db.prepare(
      // O alvo do ON CONFLICT casa com a UNIQUE INTEIRA, que ganhou
      // `installment_number` quando a tabela abriu para o crediário. Alvo
      // parcial faz o SQLite recusar a instrução inteira.
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at,
          settled_cents, customer_id, description, origin_type, origin_id,
          category_id, competence_date, created_at)
       VALUES (?, ?, 'in', ?, 'settled', ?, ?, ?, ?, ?, 'ecommerce_order', ?, ?, ?, ?)
       ON CONFLICT (origin_type, origin_id, direction, installment_number) DO NOTHING`,
    ).run(
      randomUUID(),
      input.companyId,
      order.total_cents,
      // Vencimento e competência são DIA DE CALENDÁRIO, e o dia é o da loja.
      // `now.slice(0, 10)` responde o dia de Greenwich: o pedido pago às 21h30
      // do dia 31 entrava na competência do mês seguinte.
      diaDaLoja(now),
      now,
      order.total_cents,
      null,
      `Pedido online #${order.number}`,
      input.orderId,
      systemCategoryId(input.companyId, 'venda'),
      diaDaLoja(now),
      now,
    );

    addOrderEvent(input.orderId, input.companyId, 'pago', 'Pagamento confirmado', input.userId ?? undefined);
    const pago = db
      .prepare('SELECT * FROM core_orders WHERE id = ?')
      .get(input.orderId) as unknown as OrderRecord;

    // A chave amarra a mensagem AO PEDIDO: dez webhooks repetidos do mesmo
    // pagamento geram um e-mail, não dez.
    enfileirarEmailDoPedido(pago, 'pagamento_confirmado', `pagamento_confirmado:${input.orderId}`);
    return pago;
  });
}

/**
 * O dinheiro chegou DEPOIS do cancelamento.
 *
 * Acontece de verdade: o cliente cancela, e o PIX que ele já tinha mandado
 * cai três minutos depois. O provedor avisa, e o aviso está certo — o
 * pagamento aconteceu.
 *
 * O que NÃO pode acontecer é o pedido voltar a "pago" e seguir para
 * expedição: a reserva já foi liberada, o item pode ter sido vendido para
 * outra pessoa, e ninguém decidiu reativar nada. Um pedido cancelado que
 * ressuscita sozinho manda mercadoria que a loja talvez não tenha.
 *
 * O que também não pode é ignorar: é dinheiro do cliente na conta da empresa.
 * Por isso o fato fica REGISTRADO e VISÍVEL, com o pedido parado, esperando
 * decisão humana — devolver ou refazer o pedido. O estorno não é automático
 * porque devolver dinheiro é decisão de quem controla o caixa.
 */
export function registerPaymentAfterCancel(input: {
  companyId: string;
  orderId: string;
  providerRef?: string;
  amountCents?: number;
}): void {
  ensureCoreSchema();
  const db = getConnection();
  const order = db
    .prepare('SELECT status, number FROM core_orders WHERE id = ? AND company_id = ?')
    .get(input.orderId, input.companyId) as { status: string; number: number } | undefined;
  if (!order) return;

  // Um aviso por cobrança: o provedor reenvia, e a pendência é uma só.
  const jaRegistrado = db
    .prepare(
      `SELECT 1 AS n FROM core_order_events
        WHERE order_id = ? AND status = 'pagamento_apos_cancelamento' LIMIT 1`,
    )
    .get(input.orderId) as { n?: number } | undefined;
  if (jaRegistrado?.n) return;

  addOrderEvent(
    input.orderId,
    input.companyId,
    'pagamento_apos_cancelamento',
    `Pagamento confirmado pelo provedor DEPOIS do cancelamento`
      + `${input.providerRef ? ` (cobrança ${input.providerRef})` : ''}. `
      + 'O pedido continua cancelado e o estoque não foi reservado de novo. '
      + 'Devolução ou novo pedido dependem de decisão da operação.',
  );
  // O cliente pagou um pedido que não existe mais: ele precisa saber que o
  // dinheiro foi visto e que não precisa pagar de novo (GAP-PRD-037).
  const cancelado = db
    .prepare('SELECT * FROM core_orders WHERE id = ?')
    .get(input.orderId) as unknown as OrderRecord;
  enfileirarEmailDoPedido(
    cancelado,
    'pagamento_apos_cancelamento',
    `pagamento_apos_cancelamento:${input.orderId}`,
    { valorRecebidoCents: input.amountCents ?? null },
  );
}

/** Centavos em reais, para a nota da linha do tempo. */
function reais(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

/**
 * Pedido cujo pagamento voltou para o cliente.
 *
 * Estorno e chargeback não são cancelamento: a venda ACONTECEU, o estoque saiu,
 * e o dinheiro voltou depois. Por isso o estoque NÃO retorna sozinho — a
 * mercadoria pode estar com o cliente, a caminho, ou de volta no depósito, e só
 * quem conferiu sabe qual dos três. O pedido fica com a mercadoria "a
 * conferir" (`return_goods_status = 'aguardando'`), e o saldo só volta pelo
 * recebimento conferido (`OrderReturnService`) — é a MESMA história que
 * `refundOrder` conta agora (GAP-PRD-122).
 *
 * E O DINHEIRO QUE VOLTOU GANHA LANÇAMENTO (GAP-PRD-031). A receita do pedido
 * continuava liquidada depois do reembolso, e o DRE contava dinheiro devolvido.
 * A contrapartida (`OrderRefundLedger`) sai na mesma transação: quitada quando
 * o provedor devolveu — é o caso do webhook de estorno ou contestação —, em
 * aberto (conta a pagar ao cliente) quando ainda falta devolver.
 *
 * Tudo numa transação: status, mercadoria a conferir, contrapartida e evento
 * existem juntos ou não existem.
 */
export function markOrderRefunded(input: {
  companyId: string;
  orderId: string;
  reason: string;
  providerRef?: string;
  userId?: string | null;
  /**
   * Como o dinheiro volta — o que o e-mail ao cliente pode prometer
   * (GAP-PRD-037). Ausente, sai do motivo do provedor: `refunded` é estorno
   * confirmado, `chargeback` é contestação, o resto é a loja quem devolve.
   */
  comoOValorVolta?: ComoOValorVolta;
  /** Onde está o dinheiro. Sem dizer, é o aviso do provedor: já voltou. */
  dinheiro?: SituacaoDoDinheiro;
  /** O meio da cobrança — vai na baixa da contrapartida. */
  metodo?: string | null;
}): OrderRecord | null {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const order = db
      .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
      .get(input.orderId, input.companyId) as unknown as OrderRecord | undefined;
    if (!order) return null;
    const situacao: SituacaoDoDinheiro = input.dinheiro ?? 'devolvido_pelo_provedor';

    if (order.status === 'reembolsado') {
      // Repetição (webhook reenviado, clique duplo) não muda nada — exceto o
      // estorno que tinha ficado a pagar e o provedor agora confirmou: a conta
      // a pagar ao cliente se quita, uma vez.
      if (situacao === 'devolvido_pelo_provedor') {
        lancarContrapartidaDoReembolso({
          companyId: input.companyId,
          orderId: input.orderId,
          situacao,
          metodo: input.metodo ?? null,
          userId: input.userId ?? null,
        });
      }
      return order;
    }

    // Pedido que chegou a ser pago teve o estoque baixado no pagamento: a
    // mercadoria existe em algum lugar e precisa ser conferida.
    const baixouEstoque =
      Boolean((order as unknown as { paid_at: string | null }).paid_at)
      || (FULFILLMENT_STATUSES as readonly string[]).includes(order.status);

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_orders
          SET status = 'reembolsado',
              return_goods_status = CASE WHEN ? = 1 THEN 'aguardando' ELSE return_goods_status END,
              updated_at = ?
        WHERE id = ?`,
    ).run(baixouEstoque ? 1 : 0, now, input.orderId);

    // O pedido de devolução que a cliente abriu no portal (GAP-PRD-125) se
    // conclui com o reembolso — aberto ou já aprovado pela loja.
    db.prepare(
      `UPDATE core_order_return_requests SET status = 'concluida', updated_at = ?
        WHERE order_id = ? AND status IN ('aberta', 'aprovada')`,
    ).run(now, input.orderId);

    const contrapartida = lancarContrapartidaDoReembolso({
      companyId: input.companyId,
      orderId: input.orderId,
      situacao,
      metodo: input.metodo ?? null,
      userId: input.userId ?? null,
    });
    const doDinheiro = !contrapartida.entryId
      ? ''
      : contrapartida.quitada
        ? ` Saída de ${reais(contrapartida.amountCents)} lançada como devolução a cliente, já quitada.`
        : ` Reembolso de ${reais(contrapartida.amountCents)} lançado em Contas a pagar: `
          + 'devolva ao cliente e dê a baixa lá.';
    addOrderEvent(
      input.orderId,
      input.companyId,
      'reembolsado',
      `Pagamento ${input.reason}${input.providerRef ? ` (cobrança ${input.providerRef})` : ''}.`
        + doDinheiro
        + (baixouEstoque ? ' A mercadoria volta ao estoque só quando for conferida.' : ''),
      input.userId ?? undefined,
    );
    const reembolsado = db
      .prepare('SELECT * FROM core_orders WHERE id = ?')
      .get(input.orderId) as unknown as OrderRecord;
    // O cliente fica sabendo, e só do que se SABE sobre o dinheiro (GAP-PRD-037).
    // Dentro da transação do fato: a fila é gravada junto, ou não é.
    enfileirarEmailDoPedido(reembolsado, 'pedido_reembolsado', `pedido_reembolsado:${input.orderId}`, {
      comoOValorVolta:
        input.comoOValorVolta
        ?? (input.reason === 'refunded'
          ? 'estorno_confirmado'
          : input.reason === 'chargeback'
            ? 'contestacao'
            : 'devolucao_pela_loja'),
    });
    return reembolsado;
  });
}

/*
 * A situação fiscal do pedido saiu daqui.
 *
 * O que existia neste ponto era um DIAGNÓSTICO: uma função sem chamador que
 * explicava por que o pedido online não emitia nota — a NF-e partia de uma
 * venda, e transformar pedido em venda duplicaria a receita. A ponte agora
 * existe em OrderInvoiceService, e manter o diagnóstico ao lado dela deixaria
 * duas respostas para a mesma pergunta, sendo que uma delas ficou errada.
 */

/** Cancela o pedido e devolve as reservas. */
export function cancelOrder(input: {
  companyId: string;
  orderId: string;
  userId?: string | null;
  reason?: string;
  /**
   * Quem cancelou — é o que o e-mail ao cliente diz, e o que ele precisa
   * fazer (GAP-PRD-037). Padrão: a loja.
   */
  origem?: OrigemDoCancelamento;
}): OrderRecord {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const order = db
      .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
      .get(input.orderId, input.companyId) as unknown as OrderRecord | undefined;
    if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    // Repetir o cancelamento não é erro nem faz nada de novo: dez cliques
    // liberam a reserva uma vez só.
    if (order.status === 'cancelado') return order;
    if (order.status === 'pago') {
      throw new ApiError(
        'CORE_ORDER_ALREADY_PAID',
        'Pedido já pago: use devolução em vez de cancelamento.',
        409,
      );
    }
    // SÓ pedido ainda não pago se cancela por aqui.
    //
    // Antes, um pedido já em separação passava direto: o caminho liberava uma
    // reserva que o pagamento já tinha consumido, gravando devolução de um
    // estoque que saiu — e sem devolver dinheiro nenhum ao cliente. Pedido em
    // andamento se desfaz por devolução, com mercadoria de volta e estorno.
    if (order.status !== 'aguardando_pagamento') {
      throw new ApiError(
        'CORE_ORDER_IN_FULFILLMENT',
        `Pedido já está em "${order.status}" e não pode ser cancelado. `
          + 'Depois do pagamento, o caminho é devolução.',
        409,
      );
    }

    const items = db
      .prepare('SELECT product_id, quantity FROM core_order_items WHERE order_id = ?')
      .all(input.orderId) as unknown as { product_id: string; quantity: number }[];
    for (const item of items) {
      releaseReservation({
        companyId: input.companyId,
        productId: item.product_id,
        quantity: item.quantity,
        kind: 'ECOMMERCE_RESERVATION_RELEASE',
        referenceType: 'ecommerce_order',
        referenceId: input.orderId,
        documentNumber: `Pedido #${order.number}`,
      });
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE core_orders SET status = 'cancelado', updated_at = ? WHERE id = ?").run(
      now,
      input.orderId,
    );
    // O cupom volta a valer para quem o usou (GAP-PRD-123): pelo cliente, pela
    // loja ou pela reserva vencida, o pedido cancelado não gasta o uso.
    liberarUsoDoCupom(input.orderId);
    addOrderEvent(input.orderId, input.companyId, 'cancelado', input.reason, input.userId ?? undefined);
    const cancelado = db
      .prepare('SELECT * FROM core_orders WHERE id = ?')
      .get(input.orderId) as unknown as OrderRecord;
    // Cancelado pelo cliente, pela loja ou pelo prazo: o cliente fica sabendo
    // — com o "não pague" e, no prazo vencido, o como refazer (GAP-PRD-037).
    enfileirarEmailDoPedido(cancelado, 'pedido_cancelado', `pedido_cancelado:${input.orderId}`, {
      origemDoCancelamento: input.origem ?? 'loja',
    });
    return cancelado;
  });
}

/** Avança o pedido pago pelas etapas de fulfillment (OMS). */
export const FULFILLMENT_STATUSES = [
  'pago',
  'separacao',
  'conferencia',
  'embalado',
  'expedido',
  'pronto_para_retirada',
  'entregue',
] as const;

/**
 * Como o pedido chega ao cliente.
 *
 * Retirada e entrega não são variações da mesma etapa: uma termina no balcão,
 * a outra numa transportadora. Marcar um pedido de retirada como "expedido"
 * mandaria alguém procurar rastreio de uma encomenda que nunca foi postada —
 * e o cliente esperando na loja.
 */
export function isPickup(shippingMethod: string | null | undefined): boolean {
  const metodo = (shippingMethod ?? '').toLowerCase();
  return metodo === 'retirada' || metodo === 'pickup';
}

/** Etapas que só existem em um dos dois caminhos. */
const ETAPA_SO_ENTREGA = 'expedido';
const ETAPA_SO_RETIRADA = 'pronto_para_retirada';

/**
 * OS DOIS CAMINHOS, EM ORDEM — e a lista é do SERVIDOR.
 *
 * A tela de pedidos tinha a própria, fixa: `embalado → expedido`, para todo
 * pedido. E o padrão de toda loja do grupo é `pickup_enabled: 1,
 * delivery_enabled: 0` — quer dizer, **todo pedido online nasce sendo de
 * retirada**. O resultado era o beco do dia 1: o pedido parava em "Embalado",
 * a mercadoria ficava no balcão, e o cliente nunca era avisado.
 *
 * `advanceFulfillment` sempre recusou a etapa errada com a mensagem certa. O
 * que faltava era a tela saber qual é a etapa certa — e saber PERGUNTANDO, em
 * vez de manter uma segunda cópia da regra que envelhece sozinha.
 */
export const ETAPAS_DA_ENTREGA = [
  'pago',
  'separacao',
  'conferencia',
  'embalado',
  'expedido',
  'entregue',
] as const;

export const ETAPAS_DA_RETIRADA = [
  'pago',
  'separacao',
  'conferencia',
  'embalado',
  'pronto_para_retirada',
  'entregue',
] as const;

/** As etapas deste pedido, na ordem em que ele as percorre. */
export function etapasDoPedido(shippingMethod: string | null | undefined): readonly string[] {
  return isPickup(shippingMethod) ? ETAPAS_DA_RETIRADA : ETAPAS_DA_ENTREGA;
}

/** A próxima etapa, ou nulo quando não há para onde ir. */
export function proximaEtapa(
  status: string,
  shippingMethod: string | null | undefined,
): string | null {
  const etapas = etapasDoPedido(shippingMethod);
  const atual = etapas.indexOf(status);
  if (atual < 0 || atual === etapas.length - 1) return null;
  return etapas[atual + 1];
}

/**
 * O vocabulário dos estados do pedido, em português.
 *
 * Mora junto das listas que ele traduz, pelo mesmo motivo do vocabulário da
 * oficina: separado, um estado novo entra na lista e fica sem rótulo — e a
 * tela mostra o código cru para o gestor.
 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  aguardando_pagamento: 'Aguardando pagamento',
  pago: 'Pago',
  separacao: 'Separação',
  conferencia: 'Conferência',
  embalado: 'Embalado',
  expedido: 'Expedido',
  pronto_para_retirada: 'Pronto para retirada',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
  reembolsado: 'Reembolsado',
};

/**
 * Estados em que o pedido NÃO anda mais.
 *
 * `reembolsado` entrou aqui nesta rodada: a função recusava
 * `aguardando_pagamento` e `cancelado` e deixava o reembolsado passar. O
 * dinheiro já tinha voltado ao cliente, e o pedido seguia para "expedido" —
 * com o e-mail "seu pedido está a caminho" indo para quem acabou de ser
 * reembolsado, e a mercadoria saindo do estoque.
 */
const ESTADOS_PARADOS: Record<string, string> = {
  aguardando_pagamento: 'O pedido ainda não foi pago.',
  cancelado: 'Pedido cancelado.',
  reembolsado: 'Pedido reembolsado: o dinheiro já voltou ao cliente e ele não avança mais.',
};

export function advanceFulfillment(input: {
  companyId: string;
  orderId: string;
  toStatus: string;
  userId?: string | null;
  trackingCode?: string;
  /**
   * Quem leva a encomenda (GAP-PRD-119). Sem ela o código é texto solto: o
   * portal não sabe para que site mandar o cliente. Ver `RastreioPublico`.
   */
  shippingCarrier?: string | null;
  /** De onde veio a mudança — operador, provedor, sistema. */
  origin?: OrigemDoEvento;
  /** A frase da linha do tempo ("Entrega confirmada pela transportadora"). */
  note?: string;
}): OrderRecord {
  ensureCoreSchema();
  if (!FULFILLMENT_STATUSES.includes(input.toStatus as (typeof FULFILLMENT_STATUSES)[number])) {
    throw new ApiError('CORE_INVALID_STATUS', `Etapa inválida: ${input.toStatus}`, 400);
  }
  return withTransaction(() => {
    const db = getConnection();
    const order = db
      .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
      .get(input.orderId, input.companyId) as unknown as OrderRecord | undefined;
    if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    // Separação só começa depois do pagamento — não se separa o que não foi
    // pago —, e pedido cancelado ou reembolsado não anda mais.
    const parado = ESTADOS_PARADOS[order.status];
    if (parado) {
      const codigo =
        order.status === 'aguardando_pagamento'
          ? 'CORE_ORDER_NOT_PAID'
          : order.status === 'cancelado'
            ? 'CORE_ORDER_CANCELLED'
            : 'CORE_ORDER_REFUNDED';
      throw new ApiError(codigo, parado, 409);
    }

    const retirada = isPickup(
      (order as unknown as { shipping_method: string | null }).shipping_method,
    );
    if (retirada && input.toStatus === ETAPA_SO_ENTREGA) {
      throw new ApiError(
        'CORE_ORDER_IS_PICKUP',
        'Pedido é de retirada: não há expedição. A etapa é "pronto para retirada".',
        409,
      );
    }
    if (!retirada && input.toStatus === ETAPA_SO_RETIRADA) {
      throw new ApiError(
        'CORE_ORDER_IS_DELIVERY',
        'Pedido é de entrega: a etapa é "expedido", não "pronto para retirada".',
        409,
      );
    }

    /*
      SÓ A PRÓXIMA ETAPA (GAP-PRD-121).

      A lista de etapas existia e a tela só oferecia o botão da seguinte — mas
      a regra morava na TELA. Pela API, `pago → entregue` e `entregue → pago`
      respondiam 200: o pedido entregue voltava a "pago" e podia ser separado e
      expedido de novo. Agora o servidor exige `proximaEtapa`.

      Repetir a etapa atual continua aceito, como sempre foi: a linha do tempo
      é append-only (o reprocessamento do operador é fato) e é assim que o
      rastreio de um pedido já expedido se corrige; o e-mail não se repete (a
      chave é por pedido). Voltar é outra ação (`regressFulfillment`), com
      motivo e gerente.
    */
    const metodo = (order as unknown as { shipping_method: string | null }).shipping_method;
    const esperada = proximaEtapa(order.status, metodo);
    /*
      O FATO DA TRANSPORTADORA NÃO PEDE LICENÇA ÀS ETAPAS DE DENTRO
      (GAP-PRD-121 × GAP-PRD-119).

      A regra acima é contra o CLIQUE errado do operador. A postagem ou a
      entrega que a transportadora informa (`origin: 'provedor'`) não é
      clique: é o que aconteceu com o pacote. Recusá-la porque ninguém marcou
      "separação" deixaria o pedido em "pago" com a encomenda viajando — sem o
      e-mail "a caminho", sem rastreio no portal e com o ERP contando outra
      história. Por isso ela anda o pedido para a FRENTE, pulando as etapas de
      dentro; para trás, nunca.
    */
    const etapas = etapasDoPedido(metodo);
    const fatoDoProvedorParaFrente =
      input.origin === 'provedor'
      && etapas.indexOf(order.status) >= 0
      && etapas.indexOf(input.toStatus) > etapas.indexOf(order.status);
    if (input.toStatus !== order.status && input.toStatus !== esperada && !fatoDoProvedorParaFrente) {
      throw new ApiError(
        'CORE_ORDER_INVALID_TRANSITION',
        esperada
          ? `Pedido está em "${ORDER_STATUS_LABEL[order.status] ?? order.status}": `
            + `a próxima etapa é "${ORDER_STATUS_LABEL[esperada] ?? esperada}". `
            + 'Para voltar uma etapa, use "Desfazer etapa", com o motivo.'
          : `Pedido está em "${ORDER_STATUS_LABEL[order.status] ?? order.status}" e não avança mais.`,
        409,
        { atual: order.status, pedida: input.toStatus, esperada },
      );
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_orders
          SET status = ?, tracking_code = COALESCE(?, tracking_code),
              shipping_carrier = COALESCE(?, shipping_carrier), updated_at = ?
        WHERE id = ?`,
    ).run(input.toStatus, input.trackingCode ?? null, input.shippingCarrier ?? null, now, input.orderId);
    addOrderEvent(
      input.orderId,
      input.companyId,
      input.toStatus,
      input.note,
      input.userId ?? undefined,
      input.origin ?? (input.userId ? 'operador' : undefined),
    );
    const atualizado = db
      .prepare('SELECT * FROM core_orders WHERE id = ?')
      .get(input.orderId) as unknown as OrderRecord;

    /**
     * Três etapas avisam o cliente, e só elas.
     *
     * "Expedido" e "pronto para retirada" são os momentos em que ele precisa
     * fazer alguma coisa — acompanhar o rastreio ou ir até a loja. "Entregue"
     * fecha o caminho e é o canal do "não recebi" (GAP-PRD-037). Avisar a
     * cada etapa interna (separação, conferência, embalado) transformaria a
     * notificação em ruído, e ruído ensina a ignorar também o aviso que
     * importa.
     */
    const AVISAM: Record<string, EmailTemplate> = {
      expedido: 'pedido_expedido',
      pronto_para_retirada: 'pedido_pronto_retirada',
      entregue: 'pedido_entregue',
    };
    const template = AVISAM[input.toStatus];
    if (template) {
      enfileirarEmailDoPedido(atualizado, template, `${template}:${input.orderId}`);
    }

    return atualizado;
  });
}

/** Motivo curto demais não explica nada a quem ler a linha do tempo depois. */
const MOTIVO_MINIMO = 5;

/**
 * DESFAZER UMA ETAPA (GAP-PRD-121) — a regressão com nome, motivo e rastro.
 *
 * Erro de clique acontece: "entregue" marcado antes de o cliente chegar,
 * pacote expedido que voltou do balcão da transportadora. O avanço não serve
 * para isso (ele só aceita a próxima etapa), e é de propósito que a volta seja
 * OUTRA porta: ela anda UMA etapa para trás, exige motivo e fica na linha do
 * tempo com quem fez. A rota a restringe à gerência.
 *
 * Não reenvia e-mail e não mexe em estoque nem em dinheiro: as etapas de
 * fulfillment são de armazém. Avançar de novo depois não duplica o aviso ao
 * cliente — a chave do e-mail é por pedido.
 */
export function regressFulfillment(input: {
  companyId: string;
  orderId: string;
  reason: unknown;
  userId?: string | null;
}): { order: OrderRecord; de: string; para: string; motivo: string } {
  ensureCoreSchema();
  const motivo = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (motivo.length < MOTIVO_MINIMO) {
    throw new ApiError(
      'CORE_ORDER_REGRESS_REASON',
      `Diga por que a etapa está sendo desfeita (pelo menos ${MOTIVO_MINIMO} caracteres).`,
      400,
    );
  }
  return withTransaction(() => {
    const db = getConnection();
    const order = db
      .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
      .get(input.orderId, input.companyId) as unknown as OrderRecord | undefined;
    if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    const parado = ESTADOS_PARADOS[order.status];
    if (parado) {
      throw new ApiError('CORE_ORDER_INVALID_TRANSITION', parado, 409, {
        atual: order.status,
        anterior: null,
      });
    }
    const etapas = etapasDoPedido(
      (order as unknown as { shipping_method: string | null }).shipping_method,
    );
    const atual = etapas.indexOf(order.status);
    if (atual <= 0) {
      throw new ApiError(
        'CORE_ORDER_INVALID_TRANSITION',
        `Pedido está em "${ORDER_STATUS_LABEL[order.status] ?? order.status}": não há etapa anterior.`,
        409,
        { atual: order.status, anterior: null },
      );
    }
    const para = etapas[atual - 1];
    const now = new Date().toISOString();
    db.prepare('UPDATE core_orders SET status = ?, updated_at = ? WHERE id = ?').run(
      para,
      now,
      input.orderId,
    );
    addOrderEvent(
      input.orderId,
      input.companyId,
      para,
      `Etapa desfeita: voltou de "${ORDER_STATUS_LABEL[order.status] ?? order.status}" para `
        + `"${ORDER_STATUS_LABEL[para] ?? para}". Motivo: ${motivo}`,
      input.userId ?? undefined,
    );
    const atualizado = db
      .prepare('SELECT * FROM core_orders WHERE id = ?')
      .get(input.orderId) as unknown as OrderRecord;
    return { order: atualizado, de: order.status, para, motivo };
  });
}

/**
 * Pedidos da operação para a tela de gestão.
 *
 * Cada linha carrega `payment_after_cancel`: pagamento que o provedor
 * confirmou DEPOIS do cancelamento. É dinheiro na conta da empresa sem pedido
 * para entregar, e só a operação pode resolver — devolvendo ou refazendo. Se
 * essa marca não viesse na lista, o cliente veria a pendência no portal e
 * ninguém do outro lado saberia que ela existe.
 */
export function listOrders(
  companyId: string,
  status?: string,
  pagina: { limit?: number; offset?: number } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = `
    SELECT o.*,
           EXISTS (
             SELECT 1 FROM core_payment_intents pi
              WHERE pi.origin_type = 'ecommerce_order'
                AND pi.origin_id = o.id
                AND pi.status = 'paid_after_cancel'
           ) AS payment_after_cancel,
           -- O último pedido de devolução da cliente (GAP-PRD-125): a lista
           -- marca o que espera decisão da loja.
           (SELECT r.status FROM core_order_return_requests r
             WHERE r.order_id = o.id
             ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS return_request_status
      FROM core_orders o
     WHERE o.company_id = ?`;
  if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }
  // Padrão de 200, como sempre; agora com `offset` e com o total contado por
  // `countOrders` — o 201º pedido sumia da tela sem aviso (GAP-PRD-070).
  sql += ' ORDER BY o.number DESC LIMIT ? OFFSET ?';
  params.push(limitarPagina(pagina.limit, 200), limitarDeslocamento(pagina.offset));
  return getConnection().prepare(sql).all(...(params as never[])) as unknown as Record<
    string,
    unknown
  >[];
}

/** Quantos pedidos online o recorte de `listOrders` tem — o `total` da página. */
export function countOrders(companyId: string, status?: string): number {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = 'SELECT COUNT(*) AS total FROM core_orders o WHERE o.company_id = ?';
  if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }
  const linha = getConnection().prepare(sql).get(...(params as never[])) as { total: number };
  return Number(linha.total);
}

/**
 * ============================================================================
 * O PAPEL DO PEDIDO — com o que ele gerou no financeiro (V04-FIN-016)
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * A IDA da rastreabilidade fechou nas cinco origens com documento: o título do
 * contas a receber diz "Pedido online #1009" e navega até esta ficha. A VOLTA —
 * a ficha mostrar os títulos que o documento gerou — fechava em três de cinco,
 * e o pedido da loja era uma das duas que faltavam: ele mostrava itens, linha
 * do tempo e nota fiscal, e dinheiro NENHUM. Para responder "esse pedido já foi
 * pago?" a pessoa saía da ficha, ia ao contas a receber e procurava pelo
 * número — exatamente o gesto que a rastreabilidade existe para apagar.
 *
 * ## POR QUE O BLOCO VEM AQUI, E NÃO DE UMA SEGUNDA CONSULTA DA TELA
 *
 * A ficha JÁ faz `GET /core/orders/:id` para existir — é a chamada que
 * acontece de qualquer jeito. Pendurar os títulos nela custa ZERO requisição a
 * mais, um estado de carregamento a menos e um 403 a menos: `GET
 * /finance/entries` não alcança todo perfil do escritório que abre Pedidos, e
 * a ficha ficaria com um bloco vermelho para quem tem direito de ver o pedido.
 * É o mesmo caminho da ficha da VENDA (`SalesService`).
 *
 * A ficha da DEVOLUÇÃO escolheu o caminho oposto — segunda consulta — e o
 * motivo está escrito lá: aquela tela não abre detalhe nenhum.
 *
 * ## O `companyId` VEM DO TOKEN, E O CERCO MUDOU DE LUGAR
 *
 * Esta função recebia só o `orderId` e devolvia o pedido de QUALQUER empresa; a
 * rota é que comparava `company_id` depois. Isso não dava para manter com o
 * bloco financeiro: a lista de títulos precisa de um `companyId` para ser
 * recortada, e o único aceitável é o do token — usar o `company_id` da linha
 * lida faria a consulta do financeiro rodar no escopo do VIZINHO antes de a
 * rota recusar. Agora o recorte é da consulta: pedido de outra empresa é
 * `null` aqui, e a rota continua devolvendo o mesmo 404 de sempre.
 */
export function getOrderDetail(
  orderId: string,
  companyId: string,
): Record<string, unknown> | null {
  ensureCoreSchema();
  const db = getConnection();
  const order = db
    .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as Record<string, unknown> | undefined;
  if (!order) return null;
  return {
    ...order,
    items: db.prepare('SELECT * FROM core_order_items WHERE order_id = ?').all(orderId),
    events: db
      .prepare('SELECT * FROM core_order_events WHERE order_id = ? ORDER BY created_at')
      .all(orderId),
    /*
      Lista VAZIA é resposta legítima e frequente — pedido aguardando pagamento
      ainda não cobra ninguém. O campo, porém, vem SEMPRE: ausência e vazio são
      fatos diferentes na tela, e o bloco declara falha quando o campo não vem.
    */
    financeEntries: [
      ...listEntries(companyId, { originType: 'ecommerce_order', originId: orderId }),
      // O dinheiro que voltou ao cliente (GAP-PRD-031): lançamento próprio,
      // da mesma ficha — sem ele a ficha mostraria só a receita.
      ...listEntries(companyId, { originType: ORIGEM_DO_REEMBOLSO, originId: orderId }),
    ],
  };
}
