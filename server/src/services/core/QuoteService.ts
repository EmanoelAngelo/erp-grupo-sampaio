/**
 * Orçamento e pré-venda.
 *
 * São os dois documentos que antecedem a venda no balcão, e a diferença entre
 * eles é uma só, mas decisiva:
 *
 *   ORÇAMENTO  o cliente leva o papel para pensar. NÃO segura estoque — se
 *              segurasse, meia dúzia de orçamentos abertos travaria a loja
 *              inteira com mercadoria que ninguém comprou.
 *
 *   PRÉ-VENDA  o cliente já fechou e vai pagar. SEGURA o estoque, senão a peça
 *              é vendida no caixa ao lado enquanto ele busca o dinheiro.
 *
 * Nenhum dos dois é venda: não geram receita, não movimentam caixa e não dão
 * baixa. A baixa acontece na conversão, e quem faz a venda continua sendo o
 * `SalesService` — este módulo não duplica nenhuma regra de venda.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { chaveDaConversaoDoDocumento } from './ChavesDoServidor.js';
import { getAvailable, releaseReservation, reserveStock } from './InventoryService.js';
import { effectivePriceCents } from './PricingService.js';
import { priceTableForCustomer } from './CatalogAuxService.js';
import {
  origemDoPrecoDaGestao,
  pisoDoPreco,
  validadeDaReserva,
} from './SalePolicyService.js';
import {
  consumirLiberacaoDeConcessao,
  percentualDaConcessao,
  temAlcadaParaLiberar,
} from './AuthorizationService.js';
import {
  conferirAlcadaDoAutorizador,
  excessosDaConcessao,
  fraseDoExcesso,
  limiteDaAlcada,
  type MedidaDaConcessao,
} from './LimiteDeDesconto.js';
import { createSale, exigirVendedorDaCasa } from './SalesService.js';
import { recordAudit } from '../audit/AuditService.js';
import { emReais } from './Money.js';
import { limitarDeslocamento, limitarPagina } from './paginacao.js';
import { modeloAtivo } from './produtoVendavel.js';
import {
  aparaReservasDoDocumento,
  reservasDoDocumento,
  resolverUnidadesDaConversao,
  soltarReservasDoDocumento,
  type UnidadesPedidas,
} from './UnitHoldService.js';

export type QuoteKind = 'orcamento' | 'pre_venda';

/** Aberto vira convertido, expirado ou cancelado — e para por aí. */
export type QuoteStatus = 'aberto' | 'convertido' | 'expirado' | 'cancelado';

export interface QuoteItemInput {
  productId: string;
  quantity: number;
  unitPriceCents?: number;
}

export interface QuoteRecord {
  id: string;
  number: number;
  kind: QuoteKind;
  status: QuoteStatus;
  total_cents: number;
  valid_until: string | null;
  converted_sale_id: string | null;
  created_at: string;
}

const KINDS = new Set<QuoteKind>(['orcamento', 'pre_venda']);

/** Só a pré-venda segura mercadoria. */
function holdsStock(kind: QuoteKind): boolean {
  return kind === 'pre_venda';
}

/**
 * PEÇA DE BANCADA NÃO ENTRA EM PRÉ-VENDA — e entra em orçamento.
 *
 * A MESMA REGRA DA LOCAÇÃO, PELO MESMO MOTIVO
 *
 * `RentalContractService` recusa peça com `CORE_PART_CANNOT_BE_RENTED`, e o
 * argumento de lá é a RESERVA: o contrato tira do disponível a bateria que a
 * oficina está contando para terminar um conserto, e nada na tela de peças diz
 * para onde ela foi. A pré-venda reserva exatamente do mesmo jeito, pelo mesmo
 * `reserveStock` — e a recusa de `addPart`, quando falta peça, chega a citar
 * "orçamento" como um dos três compromissos que podem ter comido o saldo. Dois
 * documentos que fazem o mesmo à mesma gaveta não podem ter regras diferentes:
 * era só o acaso de a locação ter sido escrita depois.
 *
 * A pré-venda TINHA uma agravante que a locação não tem: nascia sem
 * `valid_until`, nunca expirava, e a reserva ficava de pé até alguém cancelar o
 * documento à mão — peça presa assim sumia do disponível da bancada para
 * sempre. Isso foi fechado: todo documento nasce com validade e a expiração
 * roda na abertura de caixa. A recusa continua de pé mesmo assim, porque uma
 * pré-venda que expira em sete dias ainda tira a peça da bancada por sete dias,
 * e ninguém na oficina saberia para onde ela foi.
 *
 * POR QUE O ORÇAMENTO PASSA
 *
 * Orçamento é papel: não chama `reserveStock`, não mexe em `reserved` e não
 * tira nada de ninguém — é literalmente o preço escrito para o cliente pensar.
 * Recusar ali seria proibir RESPONDER QUANTO CUSTA a tela do celular, que é a
 * pergunta mais comum do balcão de uma loja com bancada. E a venda de balcão
 * da peça continua permitida (ver `destinoDaBusca` no PDV): proibir o
 * orçamento e permitir a venda seria a incoerência ao contrário.
 *
 * O orçamento que vira pré-venda passa por `createQuote` de novo, com
 * `kind: 'pre_venda'` — então a recusa acontece na aprovação, e não em
 * silêncio. Por isso a mensagem diz o que fazer no lugar: fechar no balcão,
 * que não segura nada.
 */
function exigirQueNaoSejaPecaDeBancada(
  companyId: string,
  produto: { id: string; name: string; kind: string | null; workshop_id: string | null },
): void {
  if (String(produto.kind ?? 'retail') !== 'part') return;

  const bancada = getConnection()
    .prepare('SELECT name FROM core_workshops WHERE id = ? AND company_id = ?')
    .get(produto.workshop_id ?? '', companyId) as { name: string } | undefined;

  throw new ApiError(
    'CORE_PART_CANNOT_BE_PRE_SOLD',
    `"${produto.name}" é peça de ${bancada?.name ?? 'oficina'} e não entra em pré-venda: `
      + 'a reserva tiraria do disponível da bancada uma peça que sustenta os consertos, e a tela '
      + 'de peças não diria para onde ela foi. Feche a venda no balcão, que não segura saldo, ou '
      + 'requisite a peça na ordem de serviço.',
    409,
    { productId: produto.id },
  );
}

function loadQuote(companyId: string, quoteId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_quotes WHERE id = ? AND company_id = ?')
    .get(quoteId, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_QUOTE_NOT_FOUND', 'Documento não encontrado.', 404);
  return row;
}

function quoteItems(quoteId: string): {
  product_id: string | null;
  quantity: number;
  unit_price_cents: number;
  /** De onde veio o preço escrito (A-produto-R01) — ver `fonteDoPrecoEscrito`. */
  price_source: string | null;
}[] {
  return getConnection()
    .prepare(
      'SELECT product_id, quantity, unit_price_cents, price_source FROM core_quote_items WHERE quote_id = ?',
    )
    .all(quoteId) as unknown as {
    product_id: string | null;
    quantity: number;
    unit_price_cents: number;
    price_source: string | null;
  }[];
}

/** Vencido é vencido, mesmo que o status no banco ainda diga "aberto". */
function isExpired(validUntil: string | null | undefined, now = new Date()): boolean {
  if (!validUntil) return false;
  return new Date(validUntil).getTime() < now.getTime();
}

/**
 * TUDO que a loja abriu mão neste documento, medido com o preço do servidor.
 *
 * É a mesma conta do `Concessao` de SalesService, e de propósito: dois lugares
 * medindo "quanto se deu de desconto" divergem no primeiro dia em que alguém
 * mexe num deles, e o sintoma é o orçamento passando pela alçada e a venda
 * dele não passando (ou o contrário, que é pior). A diferença é só a matéria
 * prima: aqui não existe desconto de LINHA — o documento tem preço unitário e
 * um desconto de rodapé, e nada mais.
 */
interface ConcessaoDoDocumento {
  brutoCents: number;
  concedidoCents: number;
  percentual: number;
  origens: { cabecalho: number; precoRebaixado: number };
}

/** Uma linha do documento já precificada PELO SERVIDOR. */
interface LinhaPrecificada {
  product: {
    id: string;
    name: string;
    price_cents: number;
    category: string | null;
    kind: string | null;
    workshop_id: string | null;
    open_price?: number;
    // Os três mínimos e o custo decidem o PISO da linha (A-produto-17#orcamento).
    cost_cents?: number | null;
    min_price_cents?: number | null;
    min_markup_percent?: number | null;
    min_margin_percent?: number | null;
  };
  quantity: number;
  unit: number;
  total: number;
  brutoLinha: number;
  rebaixado: number;
  /**
   * O preço vigente de AGORA, quando o preço é fechado (nulo no preço aberto).
   * A venda da conversão corta a linha nele (o `Math.min` de `createSale`), e
   * é por isso que o piso do documento precisa dele — ver `linhasAbaixoDoPiso`.
   */
  vigenteCents: number | null;
  /**
   * De onde veio o vigente (A-produto-R01): promoção, tabela e faixa são preço
   * da GESTÃO, e o piso não os trata como concessão de quem escreve.
   */
  fonteDoVigente: string;
  /** A promoção que deu o vigente, para a recusa dizer qual. */
  promotionId: string | null;
  /** O nome da tabela do cliente, quando foi ela que deu o vigente. */
  tabelaDoVigente: string | null;
}

/** Uma linha do documento que cobra menos do que o piso do produto. */
interface LinhaAbaixoDoPiso {
  productId: string;
  name: string;
  unitarioCobradoCents: number;
  pisoCents: number;
  regra: string;
  /**
   * O preço de venda do CADASTRO, quando ele mesmo está abaixo do piso — aí
   * "escreva ao menos o piso" não é saída: a venda corta no cadastro.
   */
  precoDoCadastroCents: number | null;
  /**
   * A promoção, a tabela ou a faixa que já fixa um preço abaixo do piso
   * (A-produto-R01): é o mínimo sem liberação da linha.
   */
  precoDaGestao: { fonte: string; precoCents: number; origem: string } | null;
}

/**
 * AS LINHAS ABAIXO DO PISO DE PREÇO DO PRODUTO (A-produto-17#orcamento).
 *
 * O DEFEITO: a venda do balcão passou a conferir o piso que o dono declara no
 * cadastro (`pisoDoPreco`), e o documento não — `createQuote` e `updateQuote`
 * mediam só a CONCESSÃO. Uma camiseta de R$ 26,00 com piso de R$ 25,00, escrita
 * a R$ 23,92 num orçamento (8%, dentro dos 10% do operador), passava sem
 * liberação; convertida no PDV, a venda saía abaixo do piso — e a conversão não
 * cobra de novo o que o documento "já conferiu". O piso tinha voltado a ter a
 * porta dos fundos que a rodada da alçada fechou para a concessão.
 *
 * A conta é a MESMA de `createSale`: o que a linha cobra por unidade é o preço
 * escrito menos a parte dela no desconto do rodapé, pela proporção da linha no
 * subtotal. Duas contas diferentes para a mesma pergunta fariam o documento
 * passar e a venda dele não (ou o contrário).
 */
function linhasAbaixoDoPiso(
  companyId: string,
  linhas: LinhaPrecificada[],
  discount: number,
): LinhaAbaixoDoPiso[] {
  /*
    REVISÃO: o que se mede é o que a VENDA da conversão vai cobrar, e não o
    preço escrito. O DEFEITO da primeira versão: aqui o preço podia ser escrito
    ACIMA da tabela e a conta usava o escrito; `createSale` corta a linha de
    preço fechado no vigente (`Math.min`). Produto com o próprio preço de venda
    abaixo do piso (R$ 24,00 com piso de R$ 25,00) era escrito a R$ 25,00, o
    documento passava sem liberação — seguindo o conselho "escreva ao menos o
    piso" — e a conversão cobrava R$ 24,00 e recusava o operador, dizendo que o
    documento tinha sido escrito abaixo do piso. O subtotal que reparte o
    rodapé é o da venda pelo mesmo motivo.
  */
  const naVenda = (l: LinhaPrecificada): number =>
    l.vigenteCents !== null && l.unit > l.vigenteCents
      ? Math.round(l.vigenteCents * l.quantity)
      : l.total;
  const subtotal = linhas.reduce((acc, l) => acc + naVenda(l), 0);
  return linhas.flatMap((l) => {
    const piso = pisoDoPreco(l.product);
    if (!piso) return [];
    /*
      O PREÇO DA GESTÃO NÃO É CONCESSÃO DE QUEM ESCREVE (A-produto-R01) — a
      mesma regra de `createSale`, pelo mesmo motivo: duas contas para a mesma
      pergunta fariam o documento passar e a venda dele não. A promoção, a
      tabela ou a faixa abaixo do piso é o mínimo sem liberação da linha; o
      desconto escrito por cima dela continua pedindo gestor.
    */
    const precoDaGestaoAbaixo =
      l.vigenteCents !== null && l.fonteDoVigente !== 'cadastro' && l.vigenteCents < piso.pisoCents;
    const minimoSemLiberacao = precoDaGestaoAbaixo ? (l.vigenteCents as number) : piso.pisoCents;
    const totalNaVenda = naVenda(l);
    const parcelaDoRodape = subtotal > 0 ? Math.round((discount * totalNaVenda) / subtotal) : 0;
    const cobrado = totalNaVenda - parcelaDoRodape;
    if (cobrado >= Math.round(minimoSemLiberacao * l.quantity)) return [];
    const cadastroAbaixo =
      l.vigenteCents !== null && l.fonteDoVigente === 'cadastro' && l.vigenteCents < piso.pisoCents;
    return [
      {
        productId: l.product.id,
        name: l.product.name,
        unitarioCobradoCents: Math.round(cobrado / l.quantity),
        pisoCents: piso.pisoCents,
        regra: piso.regra,
        precoDoCadastroCents: cadastroAbaixo ? l.vigenteCents : null,
        precoDaGestao: precoDaGestaoAbaixo
          ? {
              fonte: l.fonteDoVigente,
              precoCents: l.vigenteCents as number,
              origem: origemDoPrecoDaGestao(companyId, {
                fonte: l.fonteDoVigente,
                promotionId: l.promotionId,
                tabela: l.tabelaDoVigente,
              }),
            }
          : null,
      },
    ];
  });
}

/**
 * DE ONDE VEIO O PREÇO ESCRITO NA LINHA (A-produto-R01) — o que vai para
 * `core_quote_items.price_source`.
 *
 * O DEFEITO: o caixa escreve a pré-venda pelo preço da promoção, abaixo do
 * piso — e pode, porque o preço é da GESTÃO (ver `linhasAbaixoDoPiso`). Se a
 * promoção acaba antes da conversão, `createSale` corta a linha no preço do
 * documento e recusa o caixa, e a recusa dizia que o documento "foi escrito
 * abaixo do piso sem liberação". O bloqueio está certo (a promoção não existe
 * mais); a frase, não: o documento foi escrito certo, pelo preço que a gestão
 * tinha definido. A conversão não tinha como saber, porque a linha guardava só
 * o número.
 *
 * O CONSERTO: a linha grava a fonte do preço vigente QUANDO É ELE o preço
 * escrito — o preço que o servidor deu, mandado ausente ou digitado igual. Se
 * alguém escreveu OUTRO preço (abaixo, que é concessão, ou acima), a linha
 * grava 'digitado', o mesmo nome que a venda dá ao preço que alguém digitou
 * (`SaleItemInput.precoNegociado`): a gestão não responde por um número que ela
 * não definiu, e a conversão segue dizendo que o preço veio do documento.
 * Preço aberto grava 'aberto', que é a fonte que `effectivePriceCents` devolve
 * para ele.
 */
function fonteDoPrecoEscrito(linha: LinhaPrecificada): string {
  if (linha.vigenteCents !== null && linha.unit !== linha.vigenteCents) return 'digitado';
  return linha.fonteDoVigente;
}

/**
 * ============================================================================
 * A PRECIFICAÇÃO DO DOCUMENTO, EM UM LUGAR SÓ — e é por isso que a EDIÇÃO
 * pôde nascer sem abrir uma segunda porta dos fundos (GAP-V66)
 * ============================================================================
 *
 * Este bloco morava INTEIRO dentro de `createQuote`. Enquanto só existia um
 * escritor de documento isso era arrumação; a partir do momento em que o
 * documento aberto passa a ser EDITÁVEL, deixa de ser: `updateQuote` reescreve
 * itens, preço unitário e desconto de rodapé — exatamente os três campos que a
 * alçada mede — e um segundo caminho com a própria conta seria a repetição
 * literal do defeito que a rodada da trava fechou.
 *
 * O cabeçalho de `convertQuote` diz a frase que sustenta a casa inteira: "a
 * honestidade desta decisão depende INTEIRAMENTE da regra 1 estar de pé. Se um
 * dia alguém criar um segundo caminho de escrita de documento sem alçada, a
 * conversão volta a ser a porta dos fundos." A edição É esse segundo caminho —
 * e passa por aqui, na mesma função, com a mesma conta.
 *
 * Duas passagens, e a separação não é gosto: a concessão é a soma de TODAS as
 * linhas mais o desconto de rodapé, e o número só existe depois da última.
 * Recusar o documento pelo QUE ELE É, antes de tocar em saldo de ninguém,
 * depende disso — e é por isso que a recusa da peça de bancada mora aqui.
 */
function precificarItens(input: {
  companyId: string;
  kind: QuoteKind;
  items: QuoteItemInput[];
  customerId: string | null;
}): {
  linhas: LinhaPrecificada[];
  tabelaDoCliente: { id: string; percentOff: number } | null;
} {
  const db = getConnection();

  /*
    A CONDIÇÃO DO CLIENTE, lida uma vez, antes das linhas.

    O documento é escrito PARA alguém, e é essa a diferença em relação ao
    balcão anônimo: se o cliente é revendedor, o orçamento tem de sair com o
    preço de revendedor, senão o vendedor volta a digitar o desconto à mão —
    e desconto digitado num documento é concessão que chama gestor, agora
    também aqui (a alçada do documento mede o rebaixamento igual à venda).
  */
  const tabelaDoCliente = priceTableForCustomer(input.companyId, input.customerId ?? null);

  const linhas = input.items.map((item) => {
    // `kind` e `workshop_id` entram no SELECT porque a pré-venda precisa
    // deles para recusar peça de bancada — ver o comentário da recusa.
    // `open_price` entra porque decide se o preço do cadastro é TETO ou
    // SUGESTÃO, e disso depende se a diferença é concessão ou não.
    // O tamanho de um modelo INATIVO também fica fora (`modeloAtivo`): a
    // variante herda o arquivamento do modelo, como no balcão e na venda — a
    // pré-venda reservaria saldo de um produto que a loja tirou de uso.
    const product = db
      .prepare(
        `SELECT p.id, p.name, p.price_cents, p.category, p.kind, p.workshop_id, p.open_price,
                p.cost_cents, p.min_price_cents, p.min_markup_percent, p.min_margin_percent
           FROM core_products p
          WHERE p.id = ? AND p.company_id = ? AND p.active = 1 AND ${modeloAtivo('p')}`,
      )
      .get(item.productId, input.companyId) as LinhaPrecificada['product'] | undefined;
    if (!product) {
      throw new ApiError('CORE_PRODUCT_NOT_FOUND', `Produto não encontrado: ${item.productId}`, 404);
    }
    // Modelo com grade não entra nem em orçamento: o cliente precisa saber
    // qual tamanho está sendo cotado.
    const isModel = db
      .prepare('SELECT 1 AS n FROM core_products WHERE parent_id = ? LIMIT 1')
      .get(product.id) as { n?: number } | undefined;
    if (isModel?.n) {
      throw new ApiError(
        'CORE_PRODUCT_HAS_VARIANTS',
        `"${product.name}" tem grade. Escolha o tamanho/cor.`,
        400,
      );
    }
    if (!(item.quantity > 0)) {
      throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
    }

    /*
      A recusa vem ANTES de gravar o item e antes de reservar.

      Mesmo dentro da transação — que desfaria tudo — a ordem importa para
      quem lê: o documento é recusado por causa do QUE ele é, não por um
      efeito colateral no meio da gravação. É a mesma ordem da locação, e é
      por isso que o teste consegue cobrar que `reserved` continua zero.
    */
    if (holdsStock(input.kind)) exigirQueNaoSejaPecaDeBancada(input.companyId, product);

    /*
      O QUE VEM DA TELA TEM DE SER NÚMERO, e aqui isso vale ainda mais do que
      na venda.

      `unitPriceCents` chegava e entrava direto em `Math.round(unit * qtd)`.
      Um valor que não é número vira NaN, e NaN atravessa toda trava sem
      acionar nenhuma: NaN <= 0 é false, NaN > limite é false. O documento
      nasceria com total NaN — e, agora que a alçada mora aqui, uma alçada
      que aprovaria qualquer coisa. Ausente continua legítimo: significa
      "usa o preço vigente".
    */
    const informado = (() => {
      if (item.unitPriceCents === undefined || item.unitPriceCents === null) return null;
      const n = Number(item.unitPriceCents);
      if (!Number.isFinite(n)) {
        throw new ApiError(
          'CORE_INVALID_LINE_VALUE',
          `Valor inválido em "${product.name}": preço unitário precisa ser um número.`,
          400,
          { productId: product.id },
        );
      }
      return Math.round(n);
    })();

    /*
      O MESMO PREÇO DO BALCÃO E DA VITRINE — e, agora, a mesma tabela.

      `openPrice` desce junto pela razão do bloco logo abaixo: mão de obra
      não recebe desconto de atacado, e o cadastro dela costuma valer zero.
      Sem esta linha, cotar um serviço para um revendedor devolveria o
      serviço por zero.
    */
    const precoVigente = effectivePriceCents(
      input.companyId,
      product.id,
      product.price_cents,
      product.category,
      {
        priceTableId: tabelaDoCliente?.id ?? null,
        openPrice: product.open_price === 1,
      },
    );
    const vigente = precoVigente.priceCents;
    const unit = informado ?? vigente;
    const total = Math.round(unit * item.quantity);

    /*
      O BRUTO E A REBAIXA, com a MESMA regra de preço aberto da venda.

      Produto de preço aberto (mão de obra, serviço, o que se combina no
      balcão) tem o cadastro como SUGESTÃO, não como teto — e em geral o
      cadastro é zero. Medir "abaixo do vigente" ali faria toda cotação de
      serviço parecer uma concessão gigante e mandaria a oficina chamar o
      gestor para orçar qualquer coisa. Para ele, o bruto é o que foi
      combinado.

      O `Math.max(0, ...)` existe porque aqui, ao contrário da venda, o preço
      informado NÃO é limitado ao vigente: um documento pode ser escrito
      acima da tabela. Sem o piso, essa linha entraria com concessão NEGATIVA
      e abateria a concessão real de outra linha — dando desconto de graça em
      um item para pagar o de outro.
    */
    const precoAberto = product.open_price === 1;
    const brutoLinha = Math.round((precoAberto ? unit : vigente) * item.quantity);
    const rebaixado = precoAberto ? 0 : Math.max(0, Math.round((vigente - unit) * item.quantity));

    return {
      product,
      quantity: item.quantity,
      unit,
      total,
      brutoLinha,
      rebaixado,
      // O teto que a venda da conversão aplica — ver `linhasAbaixoDoPiso`.
      vigenteCents: precoAberto ? null : vigente,
      // De onde ele veio (A-produto-R01) — ver `linhasAbaixoDoPiso`.
      fonteDoVigente: precoVigente.fonte,
      promotionId: precoVigente.promocaoId ?? null,
      tabelaDoVigente: precoVigente.fonte === 'tabela' ? (tabelaDoCliente?.name ?? null) : null,
    };
  });

  return { linhas, tabelaDoCliente: tabelaDoCliente ?? null };
}

/** Fecha os totais e mede a concessão — a mesma conta para criar e para editar. */
function fecharAConta(
  linhas: LinhaPrecificada[],
  discountCents: number | undefined,
): { discount: number; subtotal: number; total: number; concessao: ConcessaoDoDocumento } {
  // Mesmo motivo do preço unitário: desconto de rodapé que não é número vira
  // NaN e zera a alçada inteira — ele é a maior das duas parcelas.
  const descontoInformado = Number(discountCents ?? 0);
  if (!Number.isFinite(descontoInformado)) {
    throw new ApiError('CORE_INVALID_LINE_VALUE', 'Desconto do documento precisa ser um número.', 400);
  }
  const discount = Math.max(0, Math.round(descontoInformado));
  const subtotal = linhas.reduce((acc, l) => acc + l.total, 0);
  const total = Math.max(0, subtotal - discount);

  const brutoDoc = linhas.reduce((acc, l) => acc + l.brutoLinha, 0);
  const rebaixaDoc = linhas.reduce((acc, l) => acc + l.rebaixado, 0);
  const concedidoDoc = discount + rebaixaDoc;

  return {
    discount,
    subtotal,
    total,
    concessao: {
      brutoCents: brutoDoc,
      concedidoCents: concedidoDoc,
      // A conta é a mesma da venda e a mesma que a liberação do gestor compara,
      // e por isso mora num lugar só (ver `percentualDaConcessao`).
      percentual: percentualDaConcessao(brutoDoc, concedidoDoc),
      origens: { cabecalho: discount, precoRebaixado: rebaixaDoc },
    },
  };
}

/**
 * A TRAVA DO DOCUMENTO — o bloqueio da venda em duas etapas, fechado aqui.
 *
 * O contorno era simples de executar e impossível de ver no relatório: o
 * operador escrevia a moto de R$ 12.000 por R$ 1,00 num orçamento (nenhuma
 * checagem), convertia em seguida (`createSale` sem alçada) e a venda saía
 * com o preço rebaixado e sem assinatura de ninguém. Duas chamadas HTTP.
 *
 * Medir AQUI é medir onde o preço é escrito. Quem digita um orçamento não
 * tem cliente esperando troco — tem tempo de chamar o gerente. É essa
 * diferença de MOMENTO que permite ser rigoroso aqui e generoso na
 * conversão, e não o contrário.
 *
 * Devolve a liberação CONSUMIDA (ou nulo, quando a concessão coube no limite).
 */
function cobrarAlcadaDoDocumento(input: {
  companyId: string;
  userId: string;
  quoteId: string;
  kind: QuoteKind;
  concessao: ConcessaoDoDocumento;
  /**
   * As linhas abaixo do piso do produto (A-produto-17#orcamento) — a mesma
   * porta da concessão, com a mesma liberação, como na venda do balcão.
   */
  abaixoDoPiso: LinhaAbaixoDoPiso[];
  /**
   * As linhas precificadas, para o teto POR ITEM (P0 da Preço Justo). No
   * documento a linha concede o preço rebaixado — não há desconto de linha.
   */
  linhas: LinhaPrecificada[];
  alcada?: { profileCodes: string[]; authorizationId?: string | null };
  now: string;
}): string | null {
  if (!input.alcada) return null;
  /*
    A MESMA RÉGUA DA VENDA (P0 da Preço Justo): o limite do PERFIL de quem
    escreve, em % e em R$, no documento inteiro e em cada linha. Uma régua mais
    frouxa aqui reabriria a venda em duas etapas — escrever no orçamento o que
    o balcão recusaria e converter depois.
  */
  const limiteDoDocumento = limiteDaAlcada(input.companyId, input.alcada);
  const medida: MedidaDaConcessao = {
    brutoCents: input.concessao.brutoCents,
    concedidoCents: input.concessao.concedidoCents,
    linhas: input.linhas.map((l) => ({
      productId: l.product.id,
      nome: l.product.name,
      brutoCents: l.brutoLinha,
      concedidoCents: l.rebaixado,
    })),
  };
  const excessos = excessosDaConcessao(limiteDoDocumento, medida);
  const limite = limiteDoDocumento.percentual;
  const precisaPelaConcessao = excessos.length > 0;
  // Quem tem alçada não pede a si mesmo — a mesma regra do piso na venda.
  const precisaPeloPiso =
    input.abaixoDoPiso.length > 0 && !temAlcadaParaLiberar(input.alcada.profileCodes);
  if (!precisaPelaConcessao && !precisaPeloPiso) {
    return null;
  }

  const consumida = input.alcada.authorizationId
    ? consumirLiberacaoDeConcessao({
        companyId: input.companyId,
        authorizationId: input.alcada.authorizationId,
        requestedBy: input.userId,
        concedidoCents: input.concessao.concedidoCents,
        // O bruto do documento, pelo mesmo motivo da venda: o teto do
        // gestor vale como PERCENTUAL, e sem denominador ele não existe.
        brutoCents: input.concessao.brutoCents,
        refType: 'quote',
        refId: input.quoteId,
        now: input.now,
      })
    : null;

  // Quem assinou só libera dentro da própria alçada — a mesma conferência da
  // venda, dentro da transação do documento (P0 da Preço Justo).
  if (consumida) {
    conferirAlcadaDoAutorizador({
      companyId: input.companyId,
      authorizedBy: consumida.authorizedBy,
      medida,
    });
  }

  if (!consumida) {
    const de: string[] = [];
    if (input.concessao.origens.cabecalho > 0) {
      de.push(`${emReais(input.concessao.origens.cabecalho)} de desconto no rodapé`);
    }
    if (input.concessao.origens.precoRebaixado > 0) {
      de.push(`${emReais(input.concessao.origens.precoRebaixado)} de preço abaixo do vigente`);
    }
    const documento = input.kind === 'pre_venda' ? 'Esta pré-venda' : 'Este orçamento';
    // O piso diz a linha, o preço escrito e de qual mínimo veio — "precisa de
    // gestor" sem o produto manda procurar um desconto que talvez nem exista.
    const doPiso = input.abaixoDoPiso.map(
      (l) =>
        `"${l.name}" sai a ${emReais(l.unitarioCobradoCents)} a unidade, abaixo do piso de `
        + `${emReais(l.pisoCents)} (${l.regra})`
        + (l.precoDoCadastroCents !== null
          ? ` — e o próprio preço de venda do cadastro, ${emReais(l.precoDoCadastroCents)}, já está `
            + 'abaixo desse piso (a venda do documento cobra no máximo o preço do cadastro)'
          : '')
        // A-produto-R01: o preço abaixo do piso é da GESTÃO — a frase diz qual.
        + (l.precoDaGestao
          ? ` — ${l.precoDaGestao.origem} já fixa ${emReais(l.precoDaGestao.precoCents)}, abaixo `
            + 'desse piso: esse preço sai sem liberação, mas o desconto escrito por cima dele, não'
          : ''),
    );
    /*
      REVISÃO: "escreva ao menos o piso" só é saída para a linha que o documento
      escreveu abaixo. Quando é o CADASTRO que está abaixo do piso, escrever o
      piso não adianta — a conversão corta no cadastro (ver `linhasAbaixoDoPiso`)
      — e a correção é em Produtos.
    */
    const semLiberacao: string[] = [];
    if (input.abaixoDoPiso.some((l) => l.precoDoCadastroCents === null && l.precoDaGestao === null)) {
      semLiberacao.push('escreva ao menos o piso na linha');
    }
    if (input.abaixoDoPiso.some((l) => l.precoDaGestao !== null)) {
      semLiberacao.push('tire o desconto escrito sobre o preço da promoção, da tabela ou da faixa');
    }
    if (input.abaixoDoPiso.some((l) => l.precoDoCadastroCents !== null)) {
      semLiberacao.push('corrija em Produtos o preço de venda que está abaixo do piso');
    }
    // Os tetos nomeados, como na venda: o percentual com a frase de sempre, os
    // novos (valor, por linha) depois, cada um com os números.
    const excessoDoDocumento = excessos.find((e) => e.regra === 'percentual_venda');
    const outrosTetos = excessos.filter((e) => e.regra !== 'percentual_venda').map(fraseDoExcesso);
    const deQuem = limiteDoDocumento.doPerfil ? 'do seu perfil nesta operação' : 'desta operação';
    const mensagem = precisaPelaConcessao
      ? `${documento} concede ${emReais(input.concessao.concedidoCents)} sobre `
        + `${emReais(input.concessao.brutoCents)} (${input.concessao.percentual}%)`
        + (excessoDoDocumento ? `, acima do limite de ${excessoDoDocumento.limite}% ${deQuem}. ` : '. ')
        + (outrosTetos.length > 0
          ? `Passa ${excessoDoDocumento ? 'também ' : ''}dos tetos ${deQuem}: ${outrosTetos.join('; ')}. `
          : '')
        + (de.length > 0 ? `Vem de ${de.join(', ')}. ` : '')
        + (doPiso.length > 0 ? `Além disso, ${doPiso.join('; ')}. ` : '')
        + 'Peça a liberação de um gestor agora — depois de aprovado, o documento fecha '
        + 'a venda sem pedir nada de novo.'
      // As saídas sem liberação dependem de onde está o preço baixo — ver
      // `semLiberacao` acima.
      : `${input.kind === 'pre_venda' ? 'Nesta pré-venda' : 'Neste orçamento'}, `
        + `${doPiso.join('; ')}. Documento abaixo do piso de preço do produto precisa da `
        + `liberação de um gestor agora — ou, sem liberação, ${semLiberacao.join(' e ')}. `
        + 'Depois de liberado, o documento fecha a venda sem pedir nada de novo.';
    throw new ApiError(
      'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
      mensagem,
      403,
      {
        percentual: input.concessao.percentual,
        concedidoCents: input.concessao.concedidoCents,
        brutoCents: input.concessao.brutoCents,
        origens: input.concessao.origens,
        limite,
        limites: limiteDoDocumento,
        ...(excessos.length > 0 ? { excessos } : {}),
        kind: input.kind,
        ...(input.abaixoDoPiso.length > 0 ? { abaixoDoPiso: input.abaixoDoPiso } : {}),
      },
    );
  }
  return consumida.id;
}

/**
 * QUEM ASSINOU O PREÇO ABAIXO DO PISO NESTE DOCUMENTO (A-produto-17#assinado).
 *
 * O DEFEITO: o gerente escreve a pré-venda abaixo do piso para um cliente
 * especial. Ele tem alçada, então `cobrarAlcadaDoDocumento` não pede — e não
 * gasta — liberação nenhuma: `authorization_id` fica nulo. A conversão confere
 * o piso (A-produto-17#orcamento) e só deixa passar sem pedir de novo o
 * documento com `authorization_id`; o caixa que faturava aquela pré-venda era
 * barrado pedindo a liberação que o gerente já tinha dado ao escrever. O
 * fluxo legítimo mais comum do piso — a gerência decidindo o preço especial e
 * o caixa só recebendo — virava um segundo chamado ao gerente, com o cliente
 * esperando.
 *
 * A assinatura é o `userId` de quem escreveu, e SÓ existe quando as duas
 * coisas são verdade na MESMA escrita:
 *   - alguma linha fica abaixo do piso (senão não há o que assinar), e
 *   - quem escreve TEM alçada (`temAlcadaParaLiberar`).
 *
 * Nulo em todo o resto, e nulo apaga a assinatura anterior — de propósito:
 *   - documento no piso não precisa de assinatura;
 *   - quem não tem alçada não assina, e a escrita dele MUDOU as linhas que o
 *     gerente assinou (a edição reescreve todas). O que o gerente decidiu foi
 *     aquele preço, naquele documento; o que ficou depois é de outra pessoa, e
 *     ou veio com liberação própria (`authorization_id`), ou pede na conversão;
 *   - `alcada` ausente é chamador interno sem nome de perfil: sem saber quem
 *     escreveu, não há de quem ser a assinatura — a trava falha FECHADA.
 *
 * É por isso que a conversão pode tratar a assinatura do documento inteiro: se
 * ela não é nula, as linhas de `core_quote_items` são exatamente as que o
 * signatário escreveu (ver o bloco do piso em `convertQuote`).
 */
function assinaturaDoPiso(input: {
  userId: string;
  abaixoDoPiso: LinhaAbaixoDoPiso[];
  alcada?: { profileCodes: string[] };
}): string | null {
  if (input.abaixoDoPiso.length === 0) return null;
  if (!input.alcada || !temAlcadaParaLiberar(input.alcada.profileCodes)) return null;
  return input.userId;
}

/**
 * A trilha da assinatura: quem assinou, e QUAIS linhas a que preço. A coluna
 * guarda só o nome; a pergunta da conferência de caixa ("quem deixou esta
 * camiseta sair a R$ 23,92?") precisa também do preço que foi assinado.
 */
function registrarAssinaturaDoPiso(input: {
  companyId: string;
  userId: string;
  quoteId: string;
  kind: QuoteKind;
  number: unknown;
  acao: 'criacao' | 'edicao';
  abaixoDoPiso: LinhaAbaixoDoPiso[];
}): void {
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'quote.piso_assinado',
    entityType: 'quote',
    entityId: input.quoteId,
    detail: {
      kind: input.kind,
      number: input.number,
      acao: input.acao,
      pisoAssinadoPor: input.userId,
      linhas: input.abaixoDoPiso.map((l) => ({
        productId: l.productId,
        unitarioCobradoCents: l.unitarioCobradoCents,
        pisoCents: l.pisoCents,
        regra: l.regra,
      })),
    },
  });
}

export function createQuote(input: {
  companyId: string;
  userId: string;
  kind?: QuoteKind;
  items: QuoteItemInput[];
  customerId?: string | null;
  sellerId?: string | null;
  discountCents?: number;
  validUntil?: string | null;
  note?: string | null;
  /**
   * QUEM está escrevendo o documento, para a alçada da concessão.
   *
   * ## Por que a alçada mora AQUI e não só na venda
   *
   * Porque este era o contorno inteiro: `convertQuote` chamava `createSale`
   * sem alçada, e o MESMO operador escrevia o preço rebaixado num orçamento e
   * o convertia segundos depois. A porta da frente (POST /core/sales) recusava
   * a moto de R$ 12.000 por R$ 1,00; esta não recusava nada. Duas chamadas
   * HTTP, e a trava da rodada inteira sumia.
   *
   * A criação do documento é o lugar CERTO para conferir, e não um lugar a
   * mais: é aqui que o preço é digitado, e é aqui que NÃO há cliente no balcão
   * esperando o troco. Pedir o gestor agora custa uma conversa; pedir na hora
   * do pagamento custa a venda.
   *
   * Ausente = documento HERDADO de outro que já foi conferido (é o caso de
   * `promoteToPreSale`, que reusa esta função com os preços já congelados no
   * orçamento). A concessão continua sendo MEDIDA e gravada; o que não se faz
   * é cobrar de novo por uma decisão que já foi tomada.
   */
  alcada?: {
    profileCodes: string[];
    authorizationId?: string | null;
  };
}): QuoteRecord {
  ensureCoreSchema();

  const kind = (input.kind ?? 'orcamento') as QuoteKind;
  if (!KINDS.has(kind)) {
    throw new ApiError('CORE_INVALID_QUOTE_KIND', `Tipo de documento inválido: ${kind}`, 400);
  }
  if (!input.items?.length) {
    throw new ApiError('CORE_EMPTY_QUOTE', 'Informe ao menos um item.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();

    /*
      O VENDEDOR É CONFERIDO ANTES DE O DOCUMENTO EXISTIR.

      O DEFEITO: aqui se gravava `input.sellerId ?? null` cru, enquanto
      `createSale` conferia de verdade. Um id inventado — ou de alguém de OUTRA
      empresa — entrava no orçamento sem erro e só estourava na CONVERSÃO, com
      o cliente esperando no balcão. O documento ficava infaturável até alguém
      editar o vendedor, e a mensagem chegava no momento errado: este arquivo
      já argumenta, no cabeçalho de `convertQuote`, que o balcão é o pior lugar
      para descobrir um problema que a criação podia ter recusado.

      A conferência é a MESMA de `createSale` (`exigirVendedorDaCasa`), e não
      uma segunda escrita da pergunta — duas cópias divergiriam no primeiro
      ajuste, e metade dos caminhos protegida dá sensação de proteção inteira.

      Antes do `nextSequenceValue`: recusar depois de puxar o número deixaria
      um buraco na numeração do balcão a cada digitação errada.
    */
    exigirVendedorDaCasa({
      companyId: input.companyId,
      userId: input.userId,
      sellerId: input.sellerId ?? null,
    });

    const quoteId = randomUUID();
    const number = nextSequenceValue(input.companyId, `quote_${kind}`);

    /*
      TODO DOCUMENTO NASCE COM VALIDADE — e nascer sem era o defeito mais caro
      deste arquivo.

      `expireOverdueQuotes` filtra `valid_until IS NOT NULL`. Um documento sem
      validade não é "válido para sempre": é INVISÍVEL para a varredura que
      solta reservas. E a pré-venda RESERVA. A peça reservada por um documento
      que a varredura nunca enxerga some do disponível da loja de forma
      definitiva — não aparece em falta de estoque, não aparece em venda, não
      aparece em contagem; simplesmente nunca mais pode ser vendida até alguém
      lembrar de cancelar o documento à mão. O próprio cabeçalho deste módulo
      já descrevia esse desfecho como inaceitável enquanto o código o produzia:
      a aprovação de orçamento chamava esta função sem `validUntil` nenhum.

      Os SETE DIAS não são inventados aqui. Eram a constante que morava no
      formulário de orçamento do navegador — ou seja, a regra existia, e valia
      só para quem abria o documento por aquela tela. Documento criado por
      qualquer outro caminho nascia eterno. Agora o padrão é do SERVIDOR e o
      dono pode mudá-lo em `core_sale_policies`; nulo lá continua significando
      os mesmos sete dias.

      O ORÇAMENTO ganha validade pelo mesmo motivo, embora não segure estoque:
      preço cotado tem prazo. Orçamento de janeiro convertido em julho fecharia
      a venda pelo preço de janeiro — e a conversão já recusa documento vencido,
      então o que faltava era o vencimento existir.

      Validade explícita do chamador manda: quem digitou uma data sabe o que
      quer. Só a AUSÊNCIA cai no padrão.
    */
    const validUntil = input.validUntil ?? validadeDaReserva(input.companyId, new Date(now));

    /*
      A PRECIFICAÇÃO INTEIRA ACONTECE ANTES DE QUALQUER ESCRITA — e mora em
      `precificarItens`, que é onde a EDIÇÃO também passa (ver lá).
    */
    const { linhas: precificados, tabelaDoCliente } = precificarItens({
      companyId: input.companyId,
      kind,
      items: input.items,
      customerId: input.customerId ?? null,
    });

    const { discount, total, concessao } = fecharAConta(precificados, input.discountCents);
    const abaixoDoPiso = linhasAbaixoDoPiso(input.companyId, precificados, discount);

    const liberacao = cobrarAlcadaDoDocumento({
      companyId: input.companyId,
      userId: input.userId,
      quoteId,
      kind,
      concessao,
      abaixoDoPiso,
      linhas: precificados,
      alcada: input.alcada,
      now,
    });
    // O gerente que escreve abaixo do piso não gasta liberação — e a decisão
    // dele fica gravada para a conversão (A-produto-17#assinado).
    const pisoAssinadoPor = assinaturaDoPiso({
      userId: input.userId,
      abaixoDoPiso,
      alcada: input.alcada,
    });

    // O cabeçalho entra primeiro: o item referencia o documento, e o SQLite
    // cobra a chave estrangeira na hora do INSERT. Os totais já estão fechados
    // porque a precificação inteira aconteceu acima.
    db.prepare(
      `INSERT INTO core_quotes
         (id, company_id, number, kind, status, customer_id, seller_id, valid_until,
          discount_cents, total_cents, note, converted_sale_id, converted_at,
          concession_cents, concession_gross_cents, authorization_id, floor_authorized_by,
          price_table_id, price_table_percent_off,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'aberto', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      quoteId,
      input.companyId,
      number,
      kind,
      input.customerId ?? null,
      input.sellerId ?? null,
      validUntil,
      discount,
      total,
      input.note ?? null,
      // A concessão fica gravada no documento MESMO quando não precisou de
      // liberação. É ela que a conversão compara depois; sem o número guardado,
      // a conversão só teria duas saídas ruins — pedir gestor toda vez que a
      // tabela de preços mudasse, ou não conferir nada.
      concessao.concedidoCents,
      concessao.brutoCents,
      liberacao,
      pisoAssinadoPor,
      /*
        SOB QUAL CONDIÇÃO ESTE PAPEL FOI ESCRITO.

        O orçamento é aprovado hoje e convertido semanas depois. Os preços de
        linha já vão congelados em `core_quote_items` — é isso que faz o cliente
        pagar o número que aprovou —, mas o número sozinho não explica NADA
        quando alguém confere: um preço 10% abaixo do vigente de hoje é
        indistinguível de um desconto que ninguém autorizou.

        Guardado aqui, o mesmo preço passa a ter procedência. E a diferença
        aparece na conversão pelo caminho que já existe: se a tabela mudou de
        10% para 5% no meio, o preço do papel vira "rebaixamento" na venda, e a
        concessão gravada acima é o que cobre essa diferença sem chamar gestor
        de novo por uma decisão que já foi tomada.
      */
      tabelaDoCliente?.id ?? null,
      tabelaDoCliente?.percentOff ?? null,
      input.userId,
      now,
      now,
    );

    const itemStmt = db.prepare(
      `INSERT INTO core_quote_items
         (id, quote_id, company_id, product_id, description, quantity, unit_price_cents, total_cents,
          price_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const linha of precificados) {
      itemStmt.run(
        randomUUID(),
        quoteId,
        input.companyId,
        linha.product.id,
        linha.product.name,
        linha.quantity,
        linha.unit,
        linha.total,
        // A procedência do preço (A-produto-R01) — ver `fonteDoPrecoEscrito`.
        fonteDoPrecoEscrito(linha),
      );

      // A pré-venda segura agora. Se não houver saldo, o documento inteiro é
      // recusado — prometer o que não existe é pior que recusar na hora.
      if (holdsStock(kind)) {
        const available = getAvailable(input.companyId, linha.product.id);
        if (available < linha.quantity) {
          throw new ApiError(
            'CORE_INSUFFICIENT_STOCK',
            `Estoque insuficiente para "${linha.product.name}": disponível ${available}.`,
            409,
            { productId: linha.product.id, available },
          );
        }
        reserveStock({
          companyId: input.companyId,
          productId: linha.product.id,
          quantity: linha.quantity,
          kind: 'PRE_SALE_RESERVATION',
          referenceType: 'pre_venda',
          referenceId: quoteId,
          documentNumber: `Pré-venda #${number}`,
          userId: input.userId,
        });
      }
    }

    if (pisoAssinadoPor) {
      registrarAssinaturaDoPiso({
        companyId: input.companyId,
        userId: input.userId,
        quoteId,
        kind,
        number,
        acao: 'criacao',
        abaixoDoPiso,
      });
    }

    return db
      .prepare(
        `SELECT id, number, kind, status, total_cents, valid_until, converted_sale_id, created_at
           FROM core_quotes WHERE id = ?`,
      )
      .get(quoteId) as unknown as QuoteRecord;
  });
}

/**
 * O documento ABERTO não pode ser mexido? Diz por quê, com o nome do estado.
 *
 * A pergunta é feita por `updateQuote` e por `renewQuote`, e a resposta tem de
 * ser a MESMA nos dois: um documento que aceita renovar a validade e recusa a
 * edição (ou o contrário) faz o operador aprender uma regra por botão.
 */
function exigirDocumentoAberto(quote: Record<string, unknown>, verbo: string): void {
  if (quote.status === 'convertido') {
    throw new ApiError(
      'CORE_QUOTE_ALREADY_CONVERTED',
      quote.converted_sale_id
        ? `Este documento já virou a venda #${quote.converted_sale_id} e não pode ser ${verbo}.`
        : `Este documento já foi convertido e não pode ser ${verbo}.`,
      409,
      { saleId: quote.converted_sale_id },
    );
  }
  if (quote.status !== 'aberto') {
    throw new ApiError(
      'CORE_QUOTE_NOT_OPEN',
      `Documento ${String(quote.status)} não pode ser ${verbo}.`,
      409,
      { status: quote.status },
    );
  }
}

/**
 * ============================================================================
 * EDITAR O DOCUMENTO ABERTO — GAP-V66
 * ============================================================================
 *
 * ## O que existia: cancelar e redigitar
 *
 * Não havia `updateQuote`, nem PUT nem PATCH em `/quotes`. Um item trocado, uma
 * quantidade errada ou um preço renegociado custavam o documento inteiro — e
 * "cancelar e recriar" não é a mesma coisa com outro nome. Três coisas se
 * perdem no caminho, e as três importam:
 *
 *   O NÚMERO. É como o balcão fala ("o orçamento 47"), é o que está no papel
 *   que o cliente levou, e é por ele que o telefone pergunta. A numeração é
 *   por tipo e sequencial: o documento novo nasce 48, e o 47 vira um cancelado
 *   que ninguém acha.
 *
 *   O HISTÓRICO. A trilha de quem escreveu, quando, e o que mudou entre uma
 *   versão e outra some — ficam dois documentos sem relação declarada.
 *
 *   A LIBERAÇÃO DO GESTOR. Ela é gasta UMA vez (`consumirLiberacaoDeConcessao`
 *   marca como usada e não devolve). Cancelar o documento não a devolve: o
 *   gerente tem de ser chamado de novo para reautorizar a MESMA decisão que já
 *   tomou. Em loja com movimento, isso é o que ensina o operador a arredondar o
 *   desconto para caber no limite em vez de chamar alguém.
 *
 * ## A regra que NÃO se afrouxou
 *
 * A edição reescreve itens, quantidades, preço unitário e desconto de rodapé —
 * exatamente os campos que a alçada mede. Por isso ela passa pela MESMA
 * `cobrarAlcadaDoDocumento` da criação, com os mesmos números e a mesma recusa:
 * o cabeçalho de `convertQuote` avisa, por escrito, que a conversão só pode ser
 * generosa enquanto a ESCRITA for rigorosa, e um segundo escritor sem alçada
 * reabriria a porta dos fundos inteira. Editar um documento para R$ 1,00 e
 * convertê-lo em seguida não passa por aqui.
 *
 * ## A reserva anda junto, e por DIFERENÇA
 *
 * A pré-venda segura mercadoria. Se a edição não mexesse na reserva, a peça
 * ficaria presa pela quantidade ANTIGA — some do disponível e ninguém sabe por
 * quê — ou, pior, a quantidade nova sairia da loja sem nunca ter sido
 * segurada.
 *
 * O ajuste é por DIFERENÇA (subiu reserva o que faltava, caiu devolve o que
 * sobra) e não "solta tudo e segura de novo", por dois motivos concretos:
 *
 *   1. A UNIQUE do razão é (empresa, tipo de referência, referência, produto,
 *      tipo de movimento). Soltar e re-segurar sob a MESMA referência daria
 *      colisão — e `reserveStock` tem um pré-cheque que devolve em silêncio
 *      quando já existe reserva daquela referência: a mercadoria ficaria solta
 *      e o documento diria que está segurada. Silencioso, e do pior tipo.
 *   2. O histórico fica legível. Uma edição que só acrescenta uma peça produz
 *      UMA linha ("reservou mais 1"), e não duas linhas por item dizendo que
 *      tudo voltou e tudo saiu de novo.
 *
 * A referência das linhas de ajuste é a da EDIÇÃO (`pre_venda_edicao` + o id
 * daquela edição), o que dá idempotência natural a cada ajuste e mantém livre
 * a referência do documento para o cancelamento e para o vencimento — que
 * continuam soltando a reserva INTEIRA, pela quantidade de agora.
 *
 * ## Vencido não se edita: renova-se primeiro
 *
 * A recusa é a mesma de converter e de aprovar, com a mesma frase — e agora ela
 * deixou de ser um beco, porque `renewQuote` existe.
 */
export function updateQuote(input: {
  companyId: string;
  userId: string;
  quoteId: string;
  items: QuoteItemInput[];
  customerId?: string | null;
  sellerId?: string | null;
  discountCents?: number;
  note?: string | null;
  /** A MESMA alçada da criação. Ausente = chamador interno já conferido. */
  alcada?: {
    profileCodes: string[];
    authorizationId?: string | null;
  };
}): QuoteRecord {
  ensureCoreSchema();

  if (!input.items?.length) {
    throw new ApiError('CORE_EMPTY_QUOTE', 'Informe ao menos um item.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const quote = loadQuote(input.companyId, input.quoteId);
    exigirDocumentoAberto(quote, 'editado');

    if (isExpired(quote.valid_until as string | null)) {
      throw new ApiError(
        'CORE_QUOTE_EXPIRED',
        'Documento vencido. Renove a validade antes de editar.',
        409,
        { validUntil: quote.valid_until },
      );
    }

    const kind = String(quote.kind) as QuoteKind;
    const now = new Date().toISOString();

    /*
      O CLIENTE PODE MUDAR, e mudar o cliente muda o PREÇO.

      A tabela de preço é do cliente (`priceTableForCustomer`), e por isso a
      precificação inteira depende de quem é ele. `undefined` significa "não
      mexa"; `null` significa "consumidor final" — e são coisas diferentes:
      confundi-las faria toda edição que não cita o cliente rebaixar o
      documento do revendedor para o preço de balcão, calada.
    */
    const customerId =
      input.customerId === undefined
        ? ((quote.customer_id as string | null) ?? null)
        : input.customerId;
    const sellerId =
      input.sellerId === undefined ? ((quote.seller_id as string | null) ?? null) : input.sellerId;

    // A MESMA conferência da criação e da venda — a fresta não pode reabrir no
    // PATCH. Ver `exigirVendedorDaCasa` no SalesService.
    exigirVendedorDaCasa({ companyId: input.companyId, userId: input.userId, sellerId });

    /*
      A OBSERVAÇÃO SE APAGA — e o COALESCE era o que a prendia.

      O DEFEITO: o UPDATE usava `note = COALESCE(?, note)`. Quem limpasse o
      campo na tela e salvasse via o texto ANTIGO voltar; não existia caminho
      nenhum para remover a observação de um documento aberto. E não é
      cosmético: a observação carrega instrução de trabalho ("trocar o zíper",
      "cliente pediu sem embalagem"), e uma que não sai continua sendo
      executada depois de cancelada.

      O COALESCE está CERTO para `authorization_id` logo abaixo (liberação de
      gestor não se apaga por edição que coube no limite) e a régua de
      customerId/sellerId é a mesma que vale aqui: `undefined` é "não mandou o
      campo" e `null` é "mandou vazio". A rota agora separa os dois, como já
      fazia para os outros dois.
    */
    const note =
      input.note === undefined ? ((quote.note as string | null) ?? null) : input.note;

    const { linhas, tabelaDoCliente } = precificarItens({
      companyId: input.companyId,
      kind,
      items: input.items,
      customerId,
    });
    const { discount, total, concessao } = fecharAConta(
      linhas,
      input.discountCents === undefined ? Number(quote.discount_cents ?? 0) : input.discountCents,
    );

    // A edição reescreve preço e desconto: o piso é medido de novo, pela
    // mesma conta da criação (A-produto-17#orcamento).
    const abaixoDoPiso = linhasAbaixoDoPiso(input.companyId, linhas, discount);
    const liberacao = cobrarAlcadaDoDocumento({
      companyId: input.companyId,
      userId: input.userId,
      quoteId: input.quoteId,
      kind,
      concessao,
      abaixoDoPiso,
      linhas,
      alcada: input.alcada,
      now,
    });
    /*
      A ASSINATURA DO PISO É DESTA VERSÃO, e não herdada (A-produto-17#assinado).

      Ao contrário de `authorization_id` (COALESCE lá embaixo), aqui o valor
      novo SUBSTITUI o antigo, inclusive por nulo: a edição reescreve TODAS as
      linhas, e a assinatura do gerente valia para as linhas que ele escreveu.
      Quem tem alçada e deixa o documento abaixo do piso assina de novo; quem
      não tem, ou deixa o documento no piso, apaga — ver `assinaturaDoPiso`.
      Herdar faria a assinatura do gerente cobrir, na conversão, um preço que
      outra pessoa escreveu depois.
    */
    const pisoAssinadoAntes = (quote.floor_authorized_by as string | null | undefined) ?? null;
    const pisoAssinadoPor = assinaturaDoPiso({
      userId: input.userId,
      abaixoDoPiso,
      alcada: input.alcada,
    });

    // O RETRATO DO ANTES, lido enquanto ainda existe: é o que a trilha compara
    // e é a base do ajuste de reserva.
    const antes = quoteItems(input.quoteId);
    const totalAnterior = Number(quote.total_cents ?? 0);

    /*
      A RESERVA ANDA POR DIFERENÇA, e as SOLTURAS vêm ANTES das TOMADAS.

      Ordem não é detalhe: `reserveStock` cobra o disponível. Uma edição que
      troca 5 unidades do vestido por 5 do mesmo vestido em outra linha — ou
      que devolve 3 de um produto para pegar 3 de outro — seria recusada por
      falta de saldo se as tomadas rodassem primeiro, com a mercadoria ainda
      presa por ela mesma.
    */
    if (holdsStock(kind)) {
      const edicaoId = randomUUID();
      const antigas = new Map<string, number>();
      for (const item of antes) {
        if (!item.product_id) continue;
        antigas.set(item.product_id, (antigas.get(item.product_id) ?? 0) + item.quantity);
      }
      const novas = new Map<string, number>();
      for (const linha of linhas) {
        novas.set(linha.product.id, (novas.get(linha.product.id) ?? 0) + linha.quantity);
      }

      const numero = String(quote.number);
      for (const [productId, antiga] of antigas) {
        const nova = novas.get(productId) ?? 0;
        if (nova >= antiga) continue;
        releaseReservation({
          companyId: input.companyId,
          productId,
          quantity: antiga - nova,
          kind: 'PRE_SALE_RELEASE',
          referenceType: 'pre_venda_edicao',
          referenceId: edicaoId,
          documentNumber: `Pré-venda #${numero} (edição)`,
          userId: input.userId,
        });
      }
      for (const [productId, nova] of novas) {
        const antiga = antigas.get(productId) ?? 0;
        if (nova <= antiga) continue;
        const falta = nova - antiga;
        const available = getAvailable(input.companyId, productId);
        if (available < falta) {
          const nome = linhas.find((l) => l.product.id === productId)?.product.name ?? 'item';
          throw new ApiError(
            'CORE_INSUFFICIENT_STOCK',
            `Estoque insuficiente para "${nome}": disponível ${available}, faltam ${falta}.`,
            409,
            { productId, available, requested: falta },
          );
        }
        reserveStock({
          companyId: input.companyId,
          productId,
          quantity: falta,
          kind: 'PRE_SALE_RESERVATION',
          referenceType: 'pre_venda_edicao',
          referenceId: edicaoId,
          documentNumber: `Pré-venda #${numero} (edição)`,
          userId: input.userId,
        });
      }
    }

    db.prepare('DELETE FROM core_quote_items WHERE quote_id = ? AND company_id = ?').run(
      input.quoteId,
      input.companyId,
    );
    const itemStmt = db.prepare(
      `INSERT INTO core_quote_items
         (id, quote_id, company_id, product_id, description, quantity, unit_price_cents, total_cents,
          price_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const linha of linhas) {
      itemStmt.run(
        randomUUID(),
        input.quoteId,
        input.companyId,
        linha.product.id,
        linha.product.name,
        linha.quantity,
        linha.unit,
        linha.total,
        // A edição reescreve todas as linhas, e a procedência vai junto — é a
        // DESTA versão (A-produto-R01). Ver `fonteDoPrecoEscrito`.
        fonteDoPrecoEscrito(linha),
      );
    }

    /*
      A LIBERAÇÃO ANTIGA NÃO É APAGADA quando a edição não precisou de uma nova.

      `COALESCE` e não `?`: uma edição que cabe no limite (baixar o desconto, por
      exemplo) não pode fazer sumir o registro de quem assinou o desconto que
      ainda está no documento. Quando há liberação nova, ela entra — é a
      assinatura desta versão.

      `note` NÃO usa COALESCE (ver acima): o valor já chega resolvido, com
      "não mandou" separado de "mandou vazio". Aqui o COALESCE era o defeito.
    */
    db.prepare(
      `UPDATE core_quotes
          SET customer_id = ?, seller_id = ?, discount_cents = ?, total_cents = ?,
              note = ?,
              concession_cents = ?, concession_gross_cents = ?,
              authorization_id = COALESCE(?, authorization_id),
              floor_authorized_by = ?,
              price_table_id = ?, price_table_percent_off = ?,
              updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(
      customerId,
      sellerId,
      discount,
      total,
      note,
      concessao.concedidoCents,
      concessao.brutoCents,
      liberacao,
      pisoAssinadoPor,
      tabelaDoCliente?.id ?? null,
      tabelaDoCliente?.percentOff ?? null,
      now,
      input.quoteId,
      input.companyId,
    );

    /*
      A TRILHA GUARDA O ANTES E O DEPOIS, e não só "alguém editou".

      A pergunta que a conferência de caixa faz meses depois é "por que este
      documento fechou por menos do que o papel que o cliente trouxe?". Sem o
      total anterior e a quantidade de linhas, a resposta exigiria reconstruir
      o documento a partir de nada.
    */
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'quote.update',
      entityType: 'quote',
      entityId: input.quoteId,
      detail: {
        kind,
        number: quote.number,
        totalAnteriorCents: totalAnterior,
        totalCents: total,
        descontoAnteriorCents: Number(quote.discount_cents ?? 0),
        descontoCents: discount,
        itensAntes: antes.length,
        itens: linhas.length,
        concessaoCents: concessao.concedidoCents,
        percentual: concessao.percentual,
        authorizationId: liberacao,
        // Quem respondia pelo piso antes e depois desta edição — é aqui que se
        // vê a assinatura do gerente sumindo quando outra pessoa reescreve.
        pisoAssinadoAntes,
        pisoAssinadoPor,
        sellerId,
      },
    });
    if (pisoAssinadoPor) {
      registrarAssinaturaDoPiso({
        companyId: input.companyId,
        userId: input.userId,
        quoteId: input.quoteId,
        kind,
        number: quote.number,
        acao: 'edicao',
        abaixoDoPiso,
      });
    }

    // A edição que tirou a moto do documento (ou baixou a quantidade) solta a
    // unidade que ele segurava (GAP-PRD-111).
    aparaReservasDoDocumento(input.companyId, input.quoteId);

    return db
      .prepare(
        `SELECT id, number, kind, status, total_cents, valid_until, converted_sale_id, created_at
           FROM core_quotes WHERE id = ?`,
      )
      .get(input.quoteId) as unknown as QuoteRecord;
  });
}

/**
 * ============================================================================
 * RENOVAR A VALIDADE — o beco que três mensagens anunciavam (GAP-V66)
 * ============================================================================
 *
 * `convertQuote` recusa com "Renove a validade antes de converter".
 * `promoteToPreSale` recusa com "Renove a validade antes de aprovar". E a tela
 * de orçamentos repetia a segunda frase numa faixa vermelha. Nenhuma das três
 * tinha para onde mandar o operador: não existia rota, serviço nem botão que
 * renovasse coisa alguma. Três mensagens ensinando um gesto que o sistema não
 * sabia fazer — que é a definição de beco anunciado.
 *
 * ## Só a VALIDADE, e é isso que a torna barata
 *
 * Não mexe em preço, não mexe em item, não mexe em reserva e não passa pela
 * alçada. O documento continua concedendo exatamente o que já concedia, com a
 * mesma liberação de gestor que já tinha; o que muda é até quando ele vale. Por
 * isso a renovação pode ser um botão de balcão e a edição não pode.
 *
 * ## EXPIRADO não renova, e a diferença com "aberto e vencido" é material
 *
 *   ABERTO E VENCIDO: a varredura ainda não passou. A pré-venda continua
 *   SEGURANDO a mercadoria — nada foi solto —, e esticar o prazo é só isso:
 *   esticar o prazo. É o caso do cliente que volta no oitavo dia.
 *
 *   EXPIRADO: a varredura já passou (abertura de caixa) e já SOLTOU a reserva.
 *   A mercadoria voltou ao disponível e pode ter sido vendida para outra
 *   pessoa há três dias. Ressuscitar o documento aqui devolveria um papel que
 *   promete mercadoria que a loja não tem mais — sem conferir saldo, sem
 *   reservar nada, e com uma data nova dando a entender que está tudo em
 *   ordem. Quem quer o mesmo negócio abre o documento de novo, e aí o saldo é
 *   conferido na hora.
 */
export function renewQuote(input: {
  companyId: string;
  userId: string;
  quoteId: string;
  /** Ausente = a validade padrão da operação, contada de HOJE. */
  validUntil?: string | null;
  reason?: string | null;
}): QuoteRecord {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const quote = loadQuote(input.companyId, input.quoteId);
    exigirDocumentoAberto(quote, 'renovado');

    const now = new Date().toISOString();
    /*
      O PRAZO NOVO CONTA DE HOJE, e quem o calcula é o SERVIDOR.

      `validadeDaReserva` é a mesma função que data o documento na criação e na
      aprovação, e é a política da operação que ela lê. Repetir os dias aqui
      criaria o segundo dono da mesma regra — e o dia em que o dono mudasse a
      política, a renovação continuaria com o número velho.
    */
    const validUntil = input.validUntil ?? validadeDaReserva(input.companyId, new Date(now));
    const anterior = (quote.valid_until as string | null) ?? null;

    db.prepare('UPDATE core_quotes SET valid_until = ?, updated_at = ? WHERE id = ?').run(
      validUntil,
      now,
      input.quoteId,
    );

    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'quote.renew',
      entityType: 'quote',
      entityId: input.quoteId,
      detail: {
        kind: quote.kind,
        number: quote.number,
        validadeAnterior: anterior,
        validUntil,
        reason: input.reason ?? null,
      },
    });

    return db
      .prepare(
        `SELECT id, number, kind, status, total_cents, valid_until, converted_sale_id, created_at
           FROM core_quotes WHERE id = ?`,
      )
      .get(input.quoteId) as unknown as QuoteRecord;
  });
}

/**
 * Converte o documento em venda.
 *
 * A venda é feita pelo `SalesService`, com as mesmas regras de sempre — preço
 * do cadastro, baixa de estoque, lançamento financeiro, idempotência. Aqui só
 * se cuida do que é próprio do documento: soltar a reserva da pré-venda antes
 * (para a baixa da venda não bater contra a própria reserva) e marcar o
 * documento como convertido, o que impede converter de novo.
 *
 * ============================================================================
 * A DECISÃO DA RODADA: ONDE A ALÇADA MEDE, E ONDE ELA NÃO MEDE
 * ============================================================================
 *
 * ## O contorno
 *
 * Esta função chamava `createSale` SEM alçada. O mesmo operador escrevia a moto
 * de R$ 12.000 por R$ 1,00 num orçamento e convertia segundos depois: a porta
 * da frente (POST /core/sales) recusava, esta não. Duas chamadas HTTP, e a
 * trava da rodada inteira sumia.
 *
 * ## Por que a saída ÓBVIA está errada
 *
 * A saída óbvia é barrar na conversão. Ela quebra o balcão, e quebra de um
 * jeito que ninguém consegue explicar ao cliente: o preço do documento está
 * CONGELADO, e o preço da tabela não. Todo orçamento cujo produto encareceu
 * desde a aprovação passaria a acusar concessão — sem que ninguém tivesse dado
 * desconto nenhum — e pediria gestor com o cliente parado no caixa, de manhã
 * cedo, com o gerente ainda em casa. O operador aprende rápido a fugir disso:
 * cancela o documento e digita a venda na mão. Uma trava que empurra a operação
 * para fora do caminho auditado é pior que não ter trava.
 *
 * ## O que foi feito, em três regras
 *
 * 1. A CONCESSÃO É CONFERIDA NA CRIAÇÃO do orçamento e da pré-venda
 *    (`createQuote`), que é onde o preço é ESCRITO e onde não há cliente
 *    esperando. Ali, pedir o gerente custa uma conversa, não uma venda.
 *
 * 2. NA CONVERSÃO VALE O QUE O DOCUMENTO JÁ TEM AUTORIZADO. Se a concessão de
 *    hoje não passou de `concession_cents`, nada é pedido de novo. É o caso
 *    normal: os preços não mudaram, e a resposta correta é silêncio.
 *
 * 3. SE O PREÇO VIGENTE CAIU, a concessão diminuiu — a loja está abrindo mão de
 *    MENOS do que já tinha sido aprovado. Também não se pede nada. Uma trava
 *    que reagisse a isso estaria punindo a loja por ter baixado o próprio
 *    preço.
 *
 * ## E QUANDO O PREÇO SUBIU? (a pergunta que a rodada tinha que responder)
 *
 * O produto encareceu entre a aprovação e o pagamento. A concessão medida hoje
 * é MAIOR que a aprovada, e ninguém concedeu nada — a diferença é do reajuste,
 * não do operador.
 *
 * DECISÃO: **não barra, e REGISTRA.** A conversão grava em auditoria
 * `quote.convert.concessao_aumentou` com o aprovado, o medido e a diferença, e
 * seguimos com a venda.
 *
 * O motivo é que barrar aqui não protegeria nada que já não esteja protegido.
 * Para um operador transformar isso em contorno, ele precisaria fazer o preço
 * de tabela SUBIR — e ele não mexe em preço; quem mexe é o cadastro, que tem a
 * própria alçada. Todas as três coisas que ele controla — preço unitário
 * digitado, desconto de rodapé, quantidade — já foram medidas na criação, e a
 * conversão não aceita nenhuma delas do corpo da requisição: os itens vêm de
 * `core_quote_items` e o desconto vem do cabeçalho do documento. Não existe
 * caminho em que a concessão cresça por ato de quem está convertendo.
 *
 * O que o registro compra é a outra metade: um reajuste que faça a loja vender
 * muito abaixo da tabela nova é um FATO ECONÔMICO que o dono precisa enxergar,
 * mesmo sendo legítimo. Barrado, ele viraria uma venda cancelada e redigitada,
 * e sumiria. Auditado, ele vira uma linha que responde "por que esta venda saiu
 * 40% abaixo da tabela?" — com data, documento e valor.
 *
 * A honestidade desta decisão depende INTEIRAMENTE da regra 1 estar de pé. Se
 * um dia alguém criar um segundo caminho de escrita de documento sem alçada, a
 * conversão volta a ser a porta dos fundos — e é por isso que o teste que
 * prova a recusa na criação é o teste mais importante desta rodada.
 *
 * ============================================================================
 * O VALE DO CLIENTE TAMBÉM PAGA A CONVERSÃO (GAP-V10/V47)
 * ============================================================================
 *
 * ## O defeito
 *
 * `POST /core/sales` aceitava `customerCreditCents` desde a rodada do crédito
 * de loja; esta função não. E não RECUSAVA: o campo não era lido, então quem o
 * mandasse na conversão via a venda fechar pelo total CHEIO com o saldo do
 * cliente intacto — sem erro em lugar nenhum. O PDV chegou a preferir recusar
 * na tela ("Pré-venda ainda não aceita crédito de loja"), o que ao menos era
 * honesto; qualquer outro cliente HTTP perdia o número em silêncio.
 *
 * O caso é corriqueiro e é o pior de explicar ao cliente: ele devolveu uma peça
 * de manhã, aprovou a pré-venda à tarde, e ouve no caixa que o vale dele não
 * vale hoje. A loja cobra o valor inteiro e continua devendo.
 *
 * ## O conserto: repasse, e NÃO um segundo caminho de resgate
 *
 * O valor desce inteiro para `createSale`, que já sabe gastá-lo. Nada é
 * conferido aqui em cima — nem saldo, nem dono, nem teto —, e isso é decisão:
 *
 *   A TRAVA DE CONCORRÊNCIA é a mesma porque a transação é a mesma.
 *   `withTransaction` abre BEGIN IMMEDIATE na primeira linha desta função, e o
 *   `redeemCredit` que roda lá dentro lê o saldo e grava o resgate sob esse
 *   mesmo lock. Duas conversões simultâneas do mesmo cliente não dividem o
 *   mesmo vale: a segunda espera, lê o saldo já debitado e é recusada.
 *
 *   O RESGATE FICA AMARRADO À VENDA GERADA, pelo id dela — é essa amarra que
 *   impede o dobro (a chave única da razão) e é ela que o cancelamento segue
 *   para devolver o vale. Um resgate escrito aqui, antes da venda existir, não
 *   teria a que se amarrar.
 *
 *   DE QUEM É O SALDO NÃO VEM DO CORPO. O cliente é o do DOCUMENTO
 *   (`quote.customer_id`), o mesmo que já vai para a venda. Aceitar um dono de
 *   crédito pela requisição deixaria o balcão pagar a pré-venda de um cliente
 *   com o vale de outro — e a recusa por saldo insuficiente, que é o que se vê
 *   hoje nesse caso, deixaria de acontecer.
 *
 * E a falha volta atrás inteira: saldo insuficiente derruba a transação da
 * conversão, o que devolve a reserva solta lá em cima e deixa o documento
 * aberto. Sem isso a peça ficaria livre na prateleira com o documento ainda
 * prometendo-a a este cliente.
 */
export function convertQuote(input: {
  companyId: string;
  userId: string;
  quoteId: string;
  idempotencyKey: string;
  payments: { method: string; amountCents: number; status?: 'settled' | 'pending' }[];
  cashSessionId?: string | null;
  /**
   * Quanto do CRÉDITO DE LOJA do cliente do documento esta conversão consome.
   *
   * Só o VALOR viaja: de quem é o saldo já está dito pelo documento. As
   * recusas — sem cliente, acima do total, acima do saldo — moram em
   * `CustomerCreditService`, dentro da transação, e não são repetidas aqui.
   */
  customerCreditCents?: number;
  /**
   * O CHASSI BIPADO NA CONVERSÃO (GAP-PRD-025), por produto.
   *
   * Ausente, sai a moto que a pré-venda segura e, faltando, a mais antiga
   * LIVRE do pátio — ver `resolverUnidadesDaConversao`.
   */
  unidades?: UnidadesPedidas[];
  /**
   * QUEM está convertendo — só para o PISO DE PREÇO do produto
   * (A-produto-17#orcamento). A concessão continua não sendo cobrada aqui (ver
   * o cabeçalho); o piso é, porque é o mínimo que o dono escreveu no produto e
   * vale onde o preço é cobrado.
   *
   * Ausente = nenhum perfil, e não "todos": a trava falha FECHADA, como em
   * `promoteToPreSale`. Produto sem piso declarado não é afetado.
   */
  alcada?: {
    profileCodes: string[];
    authorizationId?: string | null;
  };
}): {
  saleId: string;
  number: number;
  /** O que o documento tinha aprovado, e o que a venda de hoje mede. */
  concessaoAutorizadaCents: number | null;
  concessaoNaVendaCents: number;
  /** Positivo só quando o preço de tabela SUBIU desde a aprovação. */
  diferencaCents: number;
  /**
   * A MESMA comparação em percentual — e é este par que decide se a conversão
   * vira linha de auditoria (ver o bloco da comparação, mais abaixo).
   *
   * `percentualAutorizado` é nulo em documento que nunca foi medido, e só nele.
   */
  percentualAutorizado: number | null;
  percentualNaVenda: number;
  /**
   * Quanto do vale do cliente esta conversão gastou — zero quando não houve.
   *
   * Volta para quem chamou porque é o número que a trilha registra e o que a
   * tela mostra ao operador. Ele é o PEDIDO, que só chega aqui depois de a
   * venda ter sido criada com ele: se o saldo não cobrisse, a transação
   * inteira teria caído antes desta linha.
   */
  customerCreditCents: number;
} {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const quote = loadQuote(input.companyId, input.quoteId);

    if (quote.status === 'convertido') {
      throw new ApiError(
        'CORE_QUOTE_ALREADY_CONVERTED',
        `Este documento já virou a venda #${quote.converted_sale_id}.`,
        409,
        { saleId: quote.converted_sale_id },
      );
    }
    if (quote.status !== 'aberto') {
      throw new ApiError(
        'CORE_QUOTE_NOT_OPEN',
        `Documento ${String(quote.status)} não pode ser convertido.`,
        409,
      );
    }
    if (isExpired(quote.valid_until as string | null)) {
      throw new ApiError(
        'CORE_QUOTE_EXPIRED',
        'Documento vencido. Renove a validade antes de converter.',
        409,
        { validUntil: quote.valid_until },
      );
    }

    const items = quoteItems(input.quoteId);
    const kind = String(quote.kind) as QuoteKind;

    /*
      QUAL MOTO SAI — GAP-PRD-025.

      O funil do estoque recusa toda saída de produto controlado por unidade
      sem dizer QUAIS peças (`CORE_UNITS_REQUIRED`), e esta função mandava os
      itens sem `unitIds`: pré-venda de moto nunca faturava. A escolha é feita
      aqui, à vista — o chassi bipado, a moto que o documento segura, ou a
      mais antiga LIVRE —, e ANTES de soltar as reservas do documento, que é
      de onde a segunda opção lê.
    */
    const unidadesPorProduto = resolverUnidadesDaConversao({
      companyId: input.companyId,
      quoteId: input.quoteId,
      pedidas: input.unidades,
    });
    // A moto segurada deixa de ser "deste documento" no momento em que vira
    // venda dele; soltar antes de `createSale` é o que deixa a trava de balcão
    // (`exigirUnidadesLivres`) enxergar só reserva de OUTRO documento. Se a
    // venda cair, o rollback devolve a reserva junto com o resto.
    soltarReservasDoDocumento(input.companyId, input.quoteId);
    const retirarUnidades = (productId: string, quantidade: number): string[] | undefined => {
      const fila = unidadesPorProduto.get(productId);
      if (!fila) return undefined;
      return fila.splice(0, quantidade);
    };

    // A reserva sai ANTES da venda: senão o saldo disponível estaria comprometido
    // pela própria pré-venda e a baixa acusaria falta de estoque.
    if (holdsStock(kind)) {
      for (const item of items) {
        if (!item.product_id) continue;
        releaseReservation({
          companyId: input.companyId,
          productId: item.product_id,
          quantity: item.quantity,
          kind: 'PRE_SALE_CONSUMPTION',
          referenceType: 'pre_venda',
          referenceId: input.quoteId,
          documentNumber: `Pré-venda #${quote.number}`,
          userId: input.userId,
        });
      }
    }

    /*
      A CHAVE DE IDEMPOTÊNCIA DESCE COM O DOCUMENTO NO NOME — e sem isso duas
      pré-vendas viravam UMA venda só, com uma moto sumindo pelo caminho.

      MEDIDO ASSIM, contra banco de teste: duas pré-vendas da MESMA moto (saldo
      {quantity: 50, reserved: 2}), convertidas com a MESMA Idempotency-Key.
      Resultado: UMA venda só; as DUAS pré-vendas ficaram status='convertido'
      apontando para o MESMO `converted_sale_id`; e o saldo andou de
      {quantity: 49, reserved: 1} para {quantity: 49, reserved: 0}.

      Lido em português: a segunda moto SAIU DA RESERVA, voltou a contar como
      DISPONÍVEL — e não gerou venda, nem pagamento, nem lançamento financeiro.
      O documento dela diz "faturada" e aponta para a venda do OUTRO cliente. A
      loja fica com uma moto a mais no sistema, uma a menos na prateleira, e um
      papel que jura que ela foi vendida. Nenhum relatório acusa nada: os
      totais fecham, porque a venda que não existiu também não aparece.

      A ORIGEM é a busca de idempotência do `SalesService` (a que casa por
      company_id + idempotency_key, sem olhar CONTEÚDO). Ela está CERTA para o
      que foi feita: o PDV que reenvia a mesma venda depois de uma queda de
      rede manda a mesma chave e precisa receber a mesma venda de volta. O que
      ela não tem como saber é que duas conversões com a mesma chave podem ser
      dois DOCUMENTOS diferentes — e chave repetida entre documentos não é
      hipótese remota: é o cliente HTTP que repete o header, a aba duplicada, o
      script que gera a chave uma vez por sessão.

      O prefixo resolve os dois lados com a mesma linha:
        - MESMO documento + MESMA chave -> mesma chave final, MESMA venda. A
          idempotência legítima (o reenvio depois da queda de rede) continua
          inteira.
        - documentos DIFERENTES -> chaves finais diferentes, e a colisão passa
          a ser impossível por construção, não por disciplina de quem chama.

      Vale para o orçamento e para a pré-venda: é o `quoteId` que separa.
    */
    const chaveDoDocumento = chaveDaConversaoDoDocumento(input.quoteId, input.idempotencyKey);

    /*
      O PISO DE PREÇO VALE NA CONVERSÃO (A-produto-17#orcamento).

      O DEFEITO: o piso só era conferido quando a venda recebia `alcada`, e esta
      chamada não recebe (pela concessão, de propósito). Um documento com a
      linha abaixo do `min_price_cents` do produto — escrito antes de o piso
      ser conferido no documento, ou por um caminho interno sem alçada —
      virava venda abaixo do piso, convertida por quem não tem alçada, sem
      liberação de ninguém.

      Agora a venda confere SÓ o piso, com a alçada de quem converte
      (`alcadaDoPiso`). Três saídas, e nenhuma pede gestor à toa:
        - quem converte tem alçada (gerente) — não pede a si mesmo;
        - o documento já foi LIBERADO por um gestor quando foi escrito
          (`authorization_id`): o preço abaixo do piso é a decisão que aquele
          gestor assinou, e cobrar de novo é a regra 2 do cabeçalho;
        - quem converte traz a liberação agora (`authorizationId`), gasta nesta
          venda.
      Produto sem piso declarado segue exatamente como antes.
    */
    const liberadoNaEscrita =
      typeof quote.authorization_id === 'string' && quote.authorization_id !== '';
    /*
      A QUARTA SAÍDA: o documento ASSINADO por quem tem alçada
      (A-produto-17#assinado).

      O DEFEITO: as três saídas acima deixavam de fora o caso mais comum do
      piso. O gerente escreve a pré-venda abaixo do piso — tem alçada, não gasta
      liberação, `authorization_id` fica nulo — e o caixa que converte era
      barrado pedindo a liberação que o gerente já tinha dado ao escrever.

      `floor_authorized_by` não nulo quer dizer que as linhas deste documento
      são EXATAMENTE as que o signatário escreveu: toda edição reescreve todas
      as linhas e grava a assinatura DAQUELA versão — de novo, se quem editou
      tem alçada; nula, se não tem (ver `assinaturaDoPiso`). Os itens da venda
      vêm de `core_quote_items` e o desconto do cabeçalho do documento; nada do
      corpo da requisição mexe em preço. Então "a linha tem o mesmo preço que
      foi assinado" vale para o documento inteiro, e a assinatura cobre o piso
      como a liberação cobre. A linha alterada depois por quem não tem alçada
      apagou a assinatura — e esse documento segue pedindo liberação aqui.
    */
    const assinadoNaEscrita =
      typeof quote.floor_authorized_by === 'string' && quote.floor_authorized_by !== '';
    const alcadaDoPiso = liberadoNaEscrita || assinadoNaEscrita
      ? undefined
      : (input.alcada ?? { profileCodes: [] });

    /*
      SEM `alcada`, e agora isso é uma decisão e não uma omissão — o texto
      inteiro está no cabeçalho desta função. Em uma linha: a conversão não
      aceita nenhum valor do corpo da requisição (os itens vêm de
      `core_quote_items`, o desconto vem do cabeçalho do documento), então não
      existe concessão NOVA para medir aqui. O que houver de novo veio do
      cadastro de preços, e não de quem está no caixa.
    */
    const { sale, duplicated, concessao } = createSale({
      companyId: input.companyId,
      userId: input.userId,
      idempotencyKey: chaveDoDocumento,
      items: items
        .filter((i) => i.product_id)
        .map((i) => ({
          productId: String(i.product_id),
          quantity: i.quantity,
          unitPriceCents: i.unit_price_cents,
          // De onde veio esse preço quando o documento foi escrito
          // (A-produto-R01). Só muda a FRASE da recusa do piso quando a
          // promoção, a tabela ou a faixa do documento já acabou — ver
          // `precoDaGestaoQueAcabou` em `createSale`. Linha anterior à coluna
          // desce nula, e a frase é a de antes.
          fonteNoDocumento: i.price_source,
          // Duas linhas do mesmo produto dividem as motos escolhidas em ordem.
          unitIds: retirarUnidades(String(i.product_id), i.quantity),
        })),
      payments: input.payments,
      customerId: (quote.customer_id as string | null) ?? null,
      sellerId: (quote.seller_id as string | null) ?? null,
      cashSessionId: input.cashSessionId ?? null,
      discountCents: Number(quote.discount_cents ?? 0),
      /*
        O VALE DESCE JUNTO, e é o cliente DO DOCUMENTO que o gasta.

        `customerId` acima e este campo andam no mesmo objeto de propósito:
        quem paga com o vale é quem está no documento, e não há como o corpo da
        requisição apontar um terceiro. Todas as recusas do crédito (sem
        cliente, acima do total, acima do saldo) acontecem lá dentro, na mesma
        transação — ver o cabeçalho desta função.
      */
      customerCreditCents: input.customerCreditCents,
      // Só o piso — ver o bloco acima da chamada.
      alcadaDoPiso,
      origin: kind,
      note:
        kind === 'pre_venda'
          ? `Convertido da pré-venda #${quote.number}`
          : `Convertido do orçamento #${quote.number}`,
    });

    /*
      CINTO E SUSPENSÓRIO — a conferência que existe para o dia em que o
      prefixo acima não bastar.

      `duplicated` significa "esta chave já tinha uma venda gravada". Com o
      prefixo, isso só pode se referir a ESTE documento — e este documento
      estava 'aberto' quando entramos, porque as recusas do topo já barram
      'convertido'. As duas coisas juntas são impossíveis por construção: a
      venda e o UPDATE que marca o documento moram na MESMA transação, então
      nunca existe uma sem o outro.

      Com a impressão digital da mercadoria (item IDEM), a venda de OUTRA
      mercadoria ocupando esta chave nem chega aqui: `createSale` a recusa
      antes (422 CORE_IDEMPOTENCY_KEY_REUSED), dentro desta mesma transação e
      com o mesmo desfecho — reserva de volta, documento aberto. Esta
      conferência segue valendo para o que a impressão não separa: a venda
      anterior à coluna (impressão nula) e a de mesma mercadoria.

      Se ainda assim vier `true`, o banco não está no estado que este código
      supõe, e o desfecho que NÃO se pode aceitar é exatamente o medido: soltar
      a reserva e devolver a venda de outro documento como se fosse desta. A
      reserva já foi solta algumas linhas acima — estourar aqui derruba a
      transação inteira e a devolve ao lugar, que é a diferença entre uma moto
      que continua reservada e uma moto que some.

      Recusar é seguro porque não há nada a perder: nenhuma venda nova foi
      criada neste caminho, e quem está no balcão recebe um documento intacto
      para conferir em vez de uma baixa silenciosa.
    */
    if (duplicated) {
      throw new ApiError(
        'CORE_QUOTE_CONVERT_KEY_CONFLICT',
        `Esta conversão esbarrou na venda #${sale.number}, que já existe para uma chave que `
          + 'deveria ser exclusiva deste documento — e o documento ainda consta aberto. '
          + 'Nada foi alterado: nem estoque, nem reserva, nem financeiro. Confira o '
          + 'documento e a venda antes de tentar de novo.',
        409,
        { quoteId: input.quoteId, saleId: sale.id, saleNumber: sale.number },
      );
    }

    const agora = new Date().toISOString();
    db.prepare(
      `UPDATE core_quotes
          SET status = 'convertido', converted_sale_id = ?, converted_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(sale.id, agora, agora, input.quoteId);

    /*
      A VENDA QUE PASSOU PELA ASSINATURA DIZ DE QUEM ELA É (A-produto-17#assinado).

      Quem converte não respondeu pelo piso — o signatário respondeu, quando
      escreveu. Sem esta linha, a conferência veria uma venda do caixa abaixo do
      piso sem liberação de ninguém, e teria de ir ao documento descobrir por
      quê. A liberação (`authorization_id`) já tem o seu próprio rastro no
      detalhe do documento; aqui fica só o caso que não gastou liberação.
    */
    if (assinadoNaEscrita && !liberadoNaEscrita) {
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action: 'quote.convert.piso_assinado',
        entityType: 'quote',
        entityId: input.quoteId,
        detail: {
          saleId: sale.id,
          saleNumber: sale.number,
          kind,
          pisoAssinadoPor: quote.floor_authorized_by,
        },
      });
    }

    /*
      A DIFERENÇA VIRA LINHA DE AUDITORIA, e é ela que paga o preço de não
      barrar aqui.

      `concessao` é nula só no reenvio da mesma venda (idempotência), e ali não
      há o que comparar: nada foi reprecificado.

      Documento anterior a esta rodada tem `concession_cents` nulo — nunca foi
      medido. Registrar isso como diferença seria inventar um aumento que
      ninguém provocou; o que se registra é que ele não foi conferido, e a
      auditoria diz isso com todas as letras em vez de fingir zero.
    */
    const autorizada =
      quote.concession_cents === null || quote.concession_cents === undefined
        ? null
        : Number(quote.concession_cents);
    const naVenda = concessao?.concedidoCents ?? 0;
    const diferenca = autorizada === null ? 0 : Math.max(0, naVenda - autorizada);

    /*
      A COMPARAÇÃO É DE PERCENTUAL, e é aqui que `concession_gross_cents` ganha
      o leitor que não tinha.

      A coluna era gravada no INSERT do documento e mais ninguém a lia — o
      bruto aprovado ficava no banco enquanto a conversão comparava CENTAVOS
      ABSOLUTOS. Comparar centavos erra dos dois lados, e os dois casos são
      corriqueiros numa loja que reajusta tabela:

        PREÇO SUBIU. Orçamento de R$ 100 com R$ 10 de desconto (10%). A tabela
        vai a R$ 120 e o preço congelado vira concessão: o bruto de hoje é
        R$ 120, o concedido é R$ 30 — 25%. Sobe nos dois critérios, e continua
        virando linha de auditoria como antes.

        PREÇO CAIU, e este é o que passava em branco. O mesmo orçamento com o
        produto agora a R$ 80: o concedido continua sendo os R$ 10 do rodapé —
        diferença ZERO em centavos, nenhuma linha de auditoria — mas eles agora
        são 12,5% de um bruto menor, e não 10%. A loja está abrindo mão de uma
        FATIA maior do que a que foi aprovada, e ninguém ficava sabendo.

      Percentual é o que o gestor de fato aprova, e é a mesma unidade em que a
      alçada e a liberação decidem. O `diferencaCents` continua no detalhe
      porque é o número que se lê em dinheiro na conferência do caixa; o que
      mudou é quem DISPARA o registro.

      BRUTO NULO CAI NO CRITÉRIO ANTIGO. Documento com `concession_cents`
      preenchido e `concession_gross_cents` nulo não existe hoje — as duas
      colunas nasceram no mesmo passo de migração e são escritas na mesma
      linha —, mas um banco restaurado pela metade é exatamente o estado que
      este arquivo já aprendeu a não supor. Sem denominador não há percentual, e
      voltar aos centavos registra menos do que se quer em vez de não registrar
      nada.
    */
    const brutoAutorizado =
      quote.concession_gross_cents === null || quote.concession_gross_cents === undefined
        ? null
        : Number(quote.concession_gross_cents);
    const percentualAutorizado =
      autorizada === null || brutoAutorizado === null
        ? null
        : percentualDaConcessao(brutoAutorizado, autorizada);
    const percentualNaVenda = concessao?.percentual ?? 0;
    const concessaoCresceu =
      percentualAutorizado === null
        ? diferenca > 0
        : percentualNaVenda > percentualAutorizado;

    if (concessao && (concessaoCresceu || autorizada === null)) {
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action:
          autorizada === null
            ? 'quote.convert.concessao_nao_conferida'
            : 'quote.convert.concessao_aumentou',
        entityType: 'quote',
        entityId: input.quoteId,
        detail: {
          saleId: sale.id,
          saleNumber: sale.number,
          kind,
          // O que o documento tinha aprovado quando foi escrito...
          concessaoAutorizadaCents: autorizada,
          brutoAutorizadoCents: brutoAutorizado,
          percentualAutorizado,
          // ...e o que a mesma cesta concede aos preços de HOJE.
          concessaoNaVendaCents: naVenda,
          diferencaCents: diferenca,
          brutoCents: concessao.brutoCents,
          percentual: concessao.percentual,
        },
      });
    }

    return {
      saleId: sale.id,
      number: sale.number,
      concessaoAutorizadaCents: autorizada,
      concessaoNaVendaCents: naVenda,
      diferencaCents: diferenca,
      percentualAutorizado,
      percentualNaVenda,
      // Chegar até aqui já prova que o vale coube: `createSale` teria estourado
      // a transação inteira antes, e nada disto seria devolvido.
      customerCreditCents: Math.max(0, Math.round(Number(input.customerCreditCents ?? 0))),
    };
  });
}

/**
 * Promove um orçamento a pré-venda.
 *
 * O cliente aprovou e vai pagar, mas ainda não pagou. A mercadoria passa a ser
 * segurada a partir daqui — e é exatamente por isso que o estoque é conferido
 * agora: entre o orçamento e a aprovação pode ter sido vendida.
 *
 * O orçamento não é apagado. Ele fica marcado como convertido e aponta para a
 * pré-venda, de modo que o histórico continua contando a história inteira:
 * quem cotou, quando, e o que virou.
 *
 * ============================================================================
 * O ORÇAMENTO ANTERIOR À RODADA ERA A PORTA DOS FUNDOS INTEIRA — E SEM RASTRO
 * ============================================================================
 *
 * ## O que foi medido
 *
 * Gravei um orçamento exatamente como a rodada anterior gravava — sem
 * `concession_cents` (a coluna nem existia) e com a moto de R$ 12.000 a
 * `unit_price_cents = 100` — e rodei `promoteToPreSale` + `convertQuote`. Saiu
 * venda de R$ 1,00, estoque baixado, e `auditoria: []`. Vazia. Nem a recusa,
 * nem a linha de "não conferido": NADA.
 *
 * ## A mecânica do apagamento, que é a parte sutil
 *
 * Esta função reusa `createQuote` SEM `alcada`. E `createQuote` MEDE a
 * concessão mesmo quando não cobra por ela — de propósito, é o número que a
 * conversão compara depois. Então a pré-venda nasce com `concession_cents`
 * PREENCHIDO.
 *
 * Na conversão, `autorizada` deixa de ser nula, `diferenca` dá 0, e a condição
 *
 *     if (concessao && (diferenca > 0 || autorizada === null))
 *
 * não dispara. O documento NOVO apaga o rastro de que o ANTIGO nunca foi
 * conferido: a pré-venda parece um documento conferido e aprovado porque
 * carrega um número que nasceu de uma medição que ninguém autorizou.
 *
 * ## O conserto, e por que `concession_cents IS NULL` é a pergunta certa
 *
 * "Herdar sem cobrar de novo" é a regra certa — cobrar duas vezes pela mesma
 * decisão pararia o balcão. Mas ela pressupõe que houve UMA vez. A coluna diz
 * exatamente isso, sem precisar de nenhum campo novo:
 *
 *   - `concession_cents` NÃO NULO  = documento JÁ CONFERIDO na criação. Herda
 *     sem cobrar, como sempre.
 *   - `concession_cents` NULO      = documento NUNCA CONFERIDO (é anterior à
 *     coluna existir). A aprovação é a PRIMEIRA vez que alguém olha para este
 *     preço — então é aqui que a alçada cobra.
 *
 * E aprovar é o momento CERTO para cobrar num caso desses: quem aprova está
 * decidindo segurar mercadoria, não está com cliente esperando troco. É a
 * mesma razão que pôs a trava na criação.
 */
export function promoteToPreSale(input: {
  companyId: string;
  userId: string;
  quoteId: string;
  validUntil?: string | null;
  /**
   * QUEM está aprovando — só usado quando o orçamento de origem NUNCA foi
   * conferido (ver o cabeçalho).
   *
   * Ausente num orçamento nunca conferido significa "não sei quem aprova", e a
   * resposta a isso é NENHUM perfil, não "todos": a lista vazia não tem alçada
   * para liberar nada, e a trava cobra. Uma trava que falha ABERTA quando o
   * chamador esquece um parâmetro é a trava que não existe — foi assim que a
   * porta dos fundos nasceu da primeira vez.
   */
  alcada?: {
    profileCodes: string[];
    authorizationId?: string | null;
  };
}): QuoteRecord {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const quote = loadQuote(input.companyId, input.quoteId);

    if (quote.kind !== 'orcamento') {
      throw new ApiError(
        'CORE_NOT_A_QUOTE',
        'Só orçamento vira pré-venda.',
        400,
      );
    }
    if (quote.status !== 'aberto') {
      throw new ApiError(
        'CORE_QUOTE_NOT_OPEN',
        `Orçamento ${String(quote.status)} não pode virar pré-venda.`,
        409,
      );
    }
    if (isExpired(quote.valid_until as string | null)) {
      throw new ApiError(
        'CORE_QUOTE_EXPIRED',
        'Orçamento vencido. Renove a validade antes de aprovar.',
        409,
      );
    }

    const items = quoteItems(input.quoteId);

    /*
      "JÁ CONFERIDO" E "NUNCA CONFERIDO" NÃO SÃO A MESMA COISA, e tratá-los
      igual era a porta dos fundos inteira — o cabeçalho conta a medição.

      A coluna responde a pergunta sozinha: `concession_cents` só é nula em
      documento anterior a esta rodada, porque `createQuote` SEMPRE grava o
      número, mesmo quando não cobra por ele. Nulo aqui não é "concedeu zero";
      é "ninguém nunca mediu".
    */
    const nuncaConferido =
      quote.concession_cents === null || quote.concession_cents === undefined;

    /*
      A alçada só desce no caminho do documento NUNCA conferido. O documento já
      conferido continua herdando sem cobrar de novo, exatamente como antes —
      esse é o comportamento que faz o balcão funcionar, e mexer nele traria de
      volta o pedido de gestor a cada reajuste de tabela.

      O `?? { profileCodes: [] }` é o lado que falha FECHADO: chamador que não
      diz quem aprova não ganha alçada nenhuma. Lista vazia não passa por
      `temAlcadaParaLiberar`, então a trava de `createQuote` cobra — e um
      orçamento antigo SEM concessão (preço de tabela, que é a maioria deles)
      continua passando liso, porque a trava não dispara com concessão zero.
    */
    const alcadaDaAprovacao = nuncaConferido
      ? (input.alcada ?? { profileCodes: [] })
      : undefined;

    /*
      Reusa createQuote para não duplicar nenhuma regra: é ele que conhece a
      reserva, a checagem de grade, a numeração por tipo — e, agora, a
      VALIDADE.

      Este era o caminho que produzia a pré-venda eterna: a aprovação passava
      `validUntil` nulo, e nulo ia direto para a coluna. Continua passando
      nulo quando o gerente não escolheu data, mas nulo agora significa "use a
      política da empresa" lá dentro, em um lugar só. Repetir aqui o cálculo
      dos dias criaria o segundo dono da mesma regra, e no dia em que o dono
      mudasse a política um dos dois continuaria com o número velho.

      A validade da pré-venda conta a partir da APROVAÇÃO, não da cotação:
      o compromisso de segurar a mercadoria nasce agora.

      A `alcada` desce CONDICIONAL, e a condição é o `nuncaConferido` acima.

      No caso normal ela continua ausente, pelo mesmo argumento da conversão:
      os preços que descem daqui são os CONGELADOS no orçamento, que já
      passaram pela alçada quando foram digitados. Aprovar não é escrever preço
      — é dizer "o cliente fechou" —, e nada nesta chamada vem do corpo da
      requisição além da data de validade. A concessão continua sendo medida e
      gravada na pré-venda, pelos preços de hoje; o que não se faz é cobrar
      duas vezes pela mesma decisão.

      No caso do documento nunca conferido ela desce preenchida, e aí não há
      "duas vezes": esta é a PRIMEIRA.
    */
    const preSale = createQuote({
      companyId: input.companyId,
      userId: input.userId,
      kind: 'pre_venda',
      items: items
        .filter((i) => i.product_id)
        .map((i) => ({
          productId: String(i.product_id),
          quantity: i.quantity,
          unitPriceCents: i.unit_price_cents,
        })),
      customerId: (quote.customer_id as string | null) ?? null,
      sellerId: (quote.seller_id as string | null) ?? null,
      discountCents: Number(quote.discount_cents ?? 0),
      validUntil: input.validUntil ?? null,
      note: `Aprovado do orçamento #${quote.number}`,
      alcada: alcadaDaAprovacao,
    });

    /*
      O RASTRO DE QUE A ORIGEM NUNCA FOI CONFERIDA, gravado agora porque depois
      não dá mais.

      A pré-venda nasce com `concession_cents` preenchido — é ela quem a
      conversão vai comparar —, e a partir daí ninguém consegue distinguir
      "conferida na criação" de "herdada de um documento que ninguém mediu". A
      auditoria da conversão (`quote.convert.concessao_nao_conferida`) só vê a
      pré-venda, e a pré-venda parece em ordem.

      Esta linha é o único lugar do sistema em que essa distinção ainda existe.
      Ela responde, meses depois: "esta venda veio de um orçamento anterior à
      trava, e quem carimbou foi fulano, com estes perfis, nesta liberação."
    */
    /*
      A LIBERAÇÃO DO ORÇAMENTO ACOMPANHA A PRÉ-VENDA (A-produto-17#orcamento).

      A conversão passou a conferir o piso de preço, e deixa passar o documento
      que um gestor liberou quando foi escrito (`authorization_id`). A
      pré-venda nasce por `createQuote` SEM alçada — os preços são os do
      orçamento, já conferidos — e por isso nasceria sem a liberação: o
      orçamento abaixo do piso que o gestor assinou viraria uma pré-venda que
      pede gestor de novo no caixa, com o cliente esperando.

      Os preços são os mesmos, então a assinatura é a mesma. Só preenche o que
      está vazio: se a aprovação gastou uma liberação própria, é ela que fica.
    */
    const liberacaoDoOrcamento = quote.authorization_id;
    if (typeof liberacaoDoOrcamento === 'string' && liberacaoDoOrcamento !== '') {
      db.prepare(
        `UPDATE core_quotes SET authorization_id = ?
          WHERE id = ? AND company_id = ? AND authorization_id IS NULL`,
      ).run(liberacaoDoOrcamento, preSale.id, input.companyId);
    }
    /*
      A ASSINATURA DO PISO ACOMPANHA TAMBÉM (A-produto-17#assinado), pelo mesmo
      motivo da liberação acima: a pré-venda nasce de `createQuote` sem alçada,
      com os preços do orçamento — os que o gerente assinou. Sem isto, o
      orçamento que o gerente escreveu abaixo do piso viraria uma pré-venda que
      pede liberação no caixa. Só preenche o vazio: se quem aprovou um orçamento
      nunca conferido tem alçada, a assinatura dele (desta aprovação) fica.
    */
    const assinaturaDoOrcamento = quote.floor_authorized_by;
    if (typeof assinaturaDoOrcamento === 'string' && assinaturaDoOrcamento !== '') {
      db.prepare(
        `UPDATE core_quotes SET floor_authorized_by = ?
          WHERE id = ? AND company_id = ? AND floor_authorized_by IS NULL`,
      ).run(assinaturaDoOrcamento, preSale.id, input.companyId);
    }

    if (nuncaConferido) {
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action: 'quote.promote.origem_nao_conferida',
        entityType: 'quote',
        entityId: input.quoteId,
        detail: {
          preSaleId: preSale.id,
          preSaleNumber: preSale.number,
          perfis: alcadaDaAprovacao?.profileCodes ?? [],
          authorizationId: alcadaDaAprovacao?.authorizationId ?? null,
          totalCents: preSale.total_cents,
        },
      });
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_quotes
          SET status = 'convertido', converted_at = ?, updated_at = ?,
              note = COALESCE(note, '') || ' → pré-venda #' || ?
        WHERE id = ?`,
    ).run(now, now, String(preSale.number), input.quoteId);

    return preSale;
  });
}

/**
 * Cancela o documento e devolve o que ele estava segurando.
 *
 * Pré-venda cancelada que não solta a reserva é mercadoria presa para sempre —
 * some do disponível sem nunca ter sido vendida.
 */
export function cancelQuote(input: {
  companyId: string;
  quoteId: string;
  reason?: string;
}): QuoteRecord {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const quote = loadQuote(input.companyId, input.quoteId);

    if (quote.status === 'convertido') {
      throw new ApiError(
        'CORE_QUOTE_ALREADY_CONVERTED',
        'Documento já convertido. Cancele a venda, não o documento.',
        409,
      );
    }
    if (quote.status === 'cancelado') {
      // Cancelar duas vezes não solta a reserva duas vezes.
      return quote as unknown as QuoteRecord;
    }

    if (holdsStock(String(quote.kind) as QuoteKind)) {
      for (const item of quoteItems(input.quoteId)) {
        if (!item.product_id) continue;
        // Cancelamento LIBERA a mercadoria — não é consumo. Rotular errado
        // faria o histórico dizer que a peça saiu quando ela voltou.
        releaseReservation({
          companyId: input.companyId,
          productId: item.product_id,
          quantity: item.quantity,
          kind: 'PRE_SALE_RELEASE',
          referenceType: 'pre_venda',
          referenceId: input.quoteId,
          documentNumber: `Pré-venda #${quote.number}`,
        });
      }
    }

    // A moto segurada por este documento volta a ser de qualquer cliente.
    soltarReservasDoDocumento(input.companyId, input.quoteId);

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_quotes
          SET status = 'cancelado', note = COALESCE(?, note), updated_at = ?
        WHERE id = ?`,
    ).run(input.reason ?? null, now, input.quoteId);

    return db
      .prepare(
        `SELECT id, number, kind, status, total_cents, valid_until, converted_sale_id, created_at
           FROM core_quotes WHERE id = ?`,
      )
      .get(input.quoteId) as unknown as QuoteRecord;
  });
}

/**
 * Marca como expirado o que passou da validade, soltando as reservas.
 *
 * QUEM CHAMA: a ABERTURA DE CAIXA, em `CashService.openSession`. Não existe
 * agendador neste servidor — ele roda dentro da loja e é desligado à noite —,
 * então a varredura precisa de um evento que aconteça todo dia e antes da
 * primeira venda. Abrir o caixa é exatamente isso: acontece uma vez por turno,
 * por decisão de gente, e antes de qualquer peça sair. A mercadoria que uma
 * pré-venda esquecida segurava volta ao disponível antes de o primeiro cliente
 * perguntar por ela.
 *
 * O filtro `valid_until IS NOT NULL` continua aqui e é proposital: um documento
 * sem validade é uma decisão explícita de quem digitou, não um esquecimento —
 * `createQuote` já não deixa nascer nenhum sem validade por omissão.
 */
export function expireOverdueQuotes(companyId: string, now = new Date()): number {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const overdue = db
      .prepare(
        `SELECT id, kind FROM core_quotes
          WHERE company_id = ? AND status = 'aberto'
            AND valid_until IS NOT NULL AND valid_until < ?`,
      )
      .all(companyId, now.toISOString()) as unknown as { id: string; kind: string }[];

    for (const quote of overdue) {
      if (holdsStock(quote.kind as QuoteKind)) {
        for (const item of quoteItems(quote.id)) {
          if (!item.product_id) continue;
          releaseReservation({
            companyId,
            productId: item.product_id,
            quantity: item.quantity,
            kind: 'PRE_SALE_RELEASE',
            referenceType: 'pre_venda',
            referenceId: quote.id,
            documentNumber: 'Vencimento da pré-venda',
          });
        }
      }
      // A leitura já ignora reserva de documento vencido; apagar aqui é
      // arrumação, para a moto não carregar uma reserva morta.
      soltarReservasDoDocumento(companyId, quote.id);
      db.prepare("UPDATE core_quotes SET status = 'expirado', updated_at = ? WHERE id = ?").run(
        now.toISOString(),
        quote.id,
      );
    }
    return overdue.length;
  });
}

export function getQuoteDetail(
  companyId: string,
  quoteId: string,
): Record<string, unknown> | null {
  ensureCoreSchema();
  const db = getConnection();
  const quote = db
    .prepare('SELECT * FROM core_quotes WHERE id = ? AND company_id = ?')
    .get(quoteId, companyId) as Record<string, unknown> | undefined;
  if (!quote) return null;

  /*
    "LIBERADO POR" — o leitor que faltava a `core_quotes.authorization_id`.

    A coluna era escrita na criação do documento e nunca lida por ninguém. Ela
    guarda a liberação de gestor que cobriu a concessão DESTE documento, e o
    `authorizationId` que aparece na rota é outra coisa: aquele vem do CORPO da
    requisição, é o que o PDV está oferecendo AGORA para ser consumido, e morre
    ali. Dois caminhos com nomes parecidos, e nenhum dos dois respondia a
    pergunta que a conferência de caixa faz de verdade — "quem autorizou este
    desconto?".

    A junção fica AQUI, e não numa tela: o nome de quem autorizou mora em
    `core_users`, e o frontend não tem (nem deve ter) como cruzar as duas
    tabelas. O detalhe do documento já é o lugar onde o operador confere prazo,
    itens e total; a assinatura do gestor pertence à mesma folha.

    Nulo é o caso comum e não é falta de dado: significa que a concessão coube
    no limite da operação e ninguém precisou ser chamado.
  */
  const liberacao = quote.authorization_id
    ? (db
        .prepare(
          `SELECT a.id, a.created_at, a.granted_concession_cents, a.granted_gross_cents,
                  a.reason, u.display_name AS autorizado_por
             FROM core_authorizations a
             LEFT JOIN core_users u ON u.id = a.authorized_by
            WHERE a.id = ? AND a.company_id = ?`,
        )
        .get(String(quote.authorization_id), companyId) as Record<string, unknown> | undefined)
      ?? null
    : null;

  /*
    "PISO ASSINADO POR" — o leitor de `core_quotes.floor_authorized_by`
    (A-produto-17#assinado), pela mesma regra do bloco acima: coluna gravada sem
    leitor é ficção. É ela que explica por que este documento vira venda abaixo
    do piso sem pedir liberação no caixa, e a pergunta da conferência é a mesma
    — "quem decidiu este preço?". Nulo: nenhuma linha abaixo do piso, ou o
    documento foi escrito por quem não tem alçada.
  */
  const pisoAssinadoPor = quote.floor_authorized_by
    ? {
        userId: String(quote.floor_authorized_by),
        nome:
          (db
            .prepare('SELECT display_name FROM core_users WHERE id = ?')
            .get(String(quote.floor_authorized_by)) as { display_name: string } | undefined)
            ?.display_name ?? null,
      }
    : null;

  return {
    ...quote,
    // O status guardado pode estar desatualizado; quem lê precisa ver a verdade.
    expired: isExpired(quote.valid_until as string | null),
    liberacao,
    pisoAssinadoPor,
    // As motos que este documento segura, com o chassi (GAP-PRD-111): a tela
    // mostra e o PDV fatura exatamente estas.
    unidadesReservadas: reservasDoDocumento(companyId, quoteId),
    // `serialized` junto do item: é por ele que a tela sabe em qual linha
    // oferecer "Escolher chassi" e o PDV sabe que precisa resolver a unidade.
    items: db
      .prepare(
        `SELECT qi.*, p.serialized
           FROM core_quote_items qi
           LEFT JOIN core_products p ON p.id = qi.product_id
          WHERE qi.quote_id = ?`,
      )
      .all(quoteId) as unknown as Record<string, unknown>[],
  };
}

/**
 * Orçamentos e pré-vendas, do mais novo para o mais antigo — em página.
 *
 * O padrão continua 100; o `offset` e `countQuotes` (o total do mesmo recorte)
 * são o que faltava para a tela saber que existe o 101º (GAP-PRD-070).
 */
export function listQuotes(
  companyId: string,
  options: FiltroDosOrcamentos & { limit?: number; offset?: number } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const filtro = filtroDosOrcamentos(companyId, options);
  const sql = `SELECT * FROM core_quotes WHERE ${filtro.where}
                ORDER BY created_at DESC, number DESC LIMIT ? OFFSET ?`;
  return getConnection()
    .prepare(sql)
    .all(
      ...(filtro.params as string[]),
      limitarPagina(options.limit, 100),
      limitarDeslocamento(options.offset),
    ) as unknown as Record<string, unknown>[];
}

export interface FiltroDosOrcamentos {
  kind?: QuoteKind;
  status?: QuoteStatus;
}

function filtroDosOrcamentos(
  companyId: string,
  options: FiltroDosOrcamentos,
): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let where = 'company_id = ?';
  if (options.kind) {
    where += ' AND kind = ?';
    params.push(options.kind);
  }
  if (options.status) {
    where += ' AND status = ?';
    params.push(options.status);
  }
  return { where, params };
}

/** Quantos documentos o recorte de `listQuotes` tem — o `total` da página. */
export function countQuotes(companyId: string, options: FiltroDosOrcamentos = {}): number {
  ensureCoreSchema();
  const filtro = filtroDosOrcamentos(companyId, options);
  const linha = getConnection()
    .prepare(`SELECT COUNT(*) AS total FROM core_quotes WHERE ${filtro.where}`)
    .get(...(filtro.params as string[])) as { total: number };
  return Number(linha.total);
}
