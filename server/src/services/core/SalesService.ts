/**
 * Vendas — o writer oficial do ERP.
 *
 * Uma venda é UM fato: itens, baixa de estoque, movimento de caixa e
 * lançamento financeiro acontecem na MESMA transação. Ou tudo acontece, ou
 * nada acontece. Não existe caminho em que o estoque baixa e o financeiro não
 * registra.
 *
 * O financeiro recebe exatamente UM lançamento por venda. Caixa, Asaas e
 * fiscal apenas referenciam esse lançamento — nenhum deles cria receita
 * própria, que era a origem da duplicidade financeira apontada na auditoria.
 *
 * A trava é a UNIQUE (origin_type, origin_id, direction, installment_number)
 * de `core_finance_entries`. Este comentário já disse "origin_type+origin_id",
 * duas colunas — constraint que nunca existiu. A diferença é material: com
 * `direction` na chave, o mesmo fato pode ter uma linha de entrada e uma de
 * saída; com `installment_number`, o carnê pode ter uma linha por parcela.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { diaDaLoja, limitesDoPeriodo, somarDias } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement, getAvailable, getBalance } from './InventoryService.js';
import { unitsByExitReference } from './ProductUnitService.js';
import { systemCategoryId } from './FinanceSetupService.js';
import { inserirBaixaEspelho, listEntries } from './FinanceService.js';
import { assertPaymentMethod, isCashMethod } from './PaymentMethods.js';
import { gavetaDoDinheiro } from './GavetaDoDinheiro.js';
import { estornarComissaoDaVenda, registrarComissaoDaVenda } from './CommissionService.js';
import { planForPayment } from './AcquirerService.js';
import {
  faixasAtivasDaEmpresa,
  listKitComponents,
  priceTableForCustomer,
  produtoControlaEstoque,
} from './CatalogAuxService.js';
import { accrueForSale, reversePoints } from './LoyaltyService.js';
import {
  CREDITO_DE_LOJA,
  redeemCredit,
  returnRedeemedCredit,
  revokeCreditFromSale,
} from './CustomerCreditService.js';
import { effectivePriceCents } from './PricingService.js';
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
  type ExcessoDeDesconto,
  type LimiteDeDesconto,
  type LinhaDaConcessao,
  type MedidaDaConcessao,
} from './LimiteDeDesconto.js';
import {
  origemDoPrecoDaGestao,
  pisoDoPreco,
  politicaDaEmpresa,
  type PisoDoPreco,
} from './SalePolicyService.js';
import { quantidadeValida } from './Pricing.js';
import { assertTerminalDaEmpresa } from './TerminalRegistry.js';
import {
  assertCardPaymentBackedByTerminal,
  bindTerminalTransactionToSale,
  ehCobrancaDaMaquininha,
  getTerminalStatus,
} from './PdvTerminalService.js';
import { marcarCobrancasAEstornar } from './EstornoNaMaquininha.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { conferirPixDoBalcaoNaVenda, vincularPixDoBalcaoAVenda } from './PdvPixDaVenda.js';
import { emReais } from './Money.js';
import { reabrirOsDaVendaCancelada } from './WorkshopOrderReopen.js';
import { impressaoDigitalDaMercadoria, outraMercadoria } from './ImpressaoDigitalDaVenda.js';
import { modeloAtivo } from './produtoVendavel.js';
import { limitesDeReembolso, pecasDaLinhaDevolvida } from './SaleReturnService.js';

/**
 * QUEM VENDEU PRECISA SER DA CASA.
 *
 * `seller_id` é TEXT sem chave estrangeira, o corpo da requisição pode mandar
 * qualquer coisa, e ninguém confere no banco. Pior: sem `sellerId`, o servidor
 * grava o USUÁRIO LOGADO — então "vendedor" era, na prática, sinônimo de
 * "operador de caixa que digitou".
 *
 * Isso passa despercebido enquanto ninguém olha o relatório por vendedor. No
 * dia em que houver comissão, vira dinheiro pago à pessoa errada, todo mês,
 * para todas as vendas da loja.
 *
 * A consulta resolve os dois casos: id inventado e pessoa de OUTRA empresa.
 *
 * ## POR QUE ISTO É UMA FUNÇÃO, e não um bloco dentro de `createSale`
 *
 * O DEFEITO: `createQuote` e `updateQuote` gravavam `input.sellerId ?? null`
 * cru. Um vendedor inventado entrava no ORÇAMENTO sem erro nenhum e só
 * estourava na CONVERSÃO — com o cliente esperando no balcão, que é o pior
 * momento possível para descobrir. A pergunta é a mesma nos três lugares, e
 * duas cópias dela divergiriam no primeiro ajuste (uma passaria a aceitar
 * usuário inativo, a outra não), o que é pior do que não conferir: metade dos
 * caminhos protegida dá a sensação de proteção inteira.
 *
 * O usuário LOGADO não é conferido: ele chegou aqui por um token desta
 * empresa, então a pergunta já foi respondida pelo middleware.
 */
export function exigirVendedorDaCasa(input: {
  companyId: string;
  userId: string | null;
  sellerId: string | null | undefined;
}): void {
  if (!input.sellerId || input.sellerId === input.userId) return;
  const daCasa = getConnection()
    .prepare(
      `SELECT 1 FROM core_user_companies uc
         JOIN core_users u ON u.id = uc.user_id
        WHERE uc.user_id = ? AND uc.company_id = ? AND u.active = 1`,
    )
    .get(input.sellerId, input.companyId);
  if (!daCasa) {
    throw new ApiError(
      'CORE_SELLER_NOT_IN_COMPANY',
      'O vendedor informado não faz parte desta operação.',
      400,
      { sellerId: input.sellerId },
    );
  }
}

export interface SaleItemInput {
  productId: string;
  quantity: number;
  unitPriceCents?: number;
  discountCents?: number;
  /**
   * QUAIS peças, para produto serializado (moto, celular).
   *
   * O caixa escolhe: quem leva a moto leva AQUELA moto, e o chassi vai para o
   * documento. Ausente num produto serializado, o `applyMovement` recusa.
   */
  unitIds?: string[];
  /**
   * DE ONDE VEIO O PREÇO DESTA LINHA QUANDO O DOCUMENTO FOI ESCRITO — só a
   * conversão de orçamento e pré-venda preenche, com
   * `core_quote_items.price_source` (A-produto-R01). Não abre nem fecha trava
   * nenhuma: serve só para a recusa do piso dizer a causa certa quando a
   * promoção, a tabela ou a faixa que dava o preço do documento já acabou. Ver
   * `precoDaGestaoQueAcabou` em `createSale`.
   */
  fonteNoDocumento?: string | null;
  /**
   * O preço desta linha foi DIGITADO por alguém (G-offline-sync-07)?
   *
   * O DEFEITO: a linha que entrou no carrinho às 13h50 com o preço de então e
   * foi cobrada às 14h10, depois de o gestor subir o preço, chegava aqui com o
   * unitário velho — e a diferença virava "preço abaixo do vigente", a MESMA
   * origem do preço rebaixado à mão. O relatório de concessão acusava o
   * operador de ter dado um desconto que ninguém digitou, e o diálogo de
   * liberação dizia "vem de preço abaixo do vigente" para quem só retomou uma
   * espera.
   *
   * `false` declara "este é o preço que a busca me deu": a diferença passa a
   * ser contada como PREÇO DE TELA DESATUALIZADO, origem própria. Ela CONTINUA
   * dentro da concessão e da alçada — a tela não tem como provar que o preço
   * era mesmo o da busca, e deixar esta marca tirar valor da alçada reabriria a
   * moto de R$ 12.000 vendida por R$ 1,00. O que muda é o NOME do centavo, que
   * é o que o dono lê. Ausente (clientes antigos, orçamentos) é o de sempre.
   */
  precoNegociado?: boolean;
}

/**
 * Uma linha de mercadoria que entra na venda SEM baixar estoque, porque a
 * baixa já aconteceu por outro caminho (a peça da OS, na conclusão técnica).
 * Ver `CreateSaleInput.linhasJaBaixadas` (GAP-PRD-024).
 */
export interface LinhaJaBaixada {
  productId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  /** Retrato do custo unitário; nulo quando o cadastro não tem custo gravado. */
  costCents: number | null;
}

/** O que efetivamente sai da prateleira quando uma linha é vendida. */
interface BaixaDeEstoque {
  productId: string;
  /** Nome usado na mensagem de erro — precisa ser o que a pessoa procura. */
  name: string;
  quantity: number;
  /** Quando veio de um kit, o nome do kit, para a mensagem fazer sentido. */
  doKit?: string;
}

/**
 * Resolve o que a linha baixa do estoque.
 *
 * KIT NÃO TEM SALDO PRÓPRIO quando é montado na hora — ele existe como preço e
 * como item da nota, e o que sai da prateleira são as PEÇAS. Antes disto a
 * venda de um kit tentava baixar o estoque do kit: ou o `CHECK (quantity >= 0)`
 * recusava a venda inteira, ou o kit tinha um saldo fictício e as peças
 * continuavam contadas depois de vendidas.
 *
 * Quando `kit_explode_on_sale` está desligado, o kit TEM estoque próprio, já
 * montado, e é ele que baixa — por isso a decisão fica no cadastro e não aqui.
 *
 * Um nível só, e de propósito: kit dentro de kit é recusado no cadastro
 * (`setKitComponents`), então não há recursão a fazer nem ciclo a temer.
 *
 * ## O SERVIÇO DE BALCÃO NÃO BAIXA NADA (GAP-V02)
 *
 * Ajuste de bainha, instalação de acessório, aplicação de película: o balcão de
 * varejo vende isso, e até esta rodada não podia. TODA linha que não fosse kit
 * desmembrado ia para `applyMovement`, e o `CHECK (quantity >= 0)` de
 * `core_stock` recusava a venda inteira por falta de saldo — de uma coisa que
 * nunca teve saldo nem vai ter. O contorno real do balcão é lançar entrada
 * fictícia, e ela suja o razão para sempre.
 *
 * A lista VAZIA é a resposta certa, e é o precedente do kit desmembrado usado ao
 * contrário: lá o kit não baixa a si mesmo porque quem sai da prateleira são as
 * peças; aqui não sai NINGUÉM da prateleira. Devolver zero baixas não é "vender
 * sem tirar do estoque" — é dizer que não há estoque a tirar.
 *
 * Quem decide é o cadastro (`produtoControlaEstoque`), e a decisão é a MESMA que
 * o inventário e a posição de estoque consultam. Três cópias da regra
 * divergiriam na primeira manutenção: o serviço sumiria da venda e continuaria
 * aparecendo na contagem.
 */
function baixasDaLinha(
  companyId: string,
  produto: {
    id: string;
    name: string;
    is_kit?: number;
    kit_explode_on_sale?: number;
    stock_control?: number;
  },
  quantidade: number,
): BaixaDeEstoque[] {
  if (!produtoControlaEstoque(produto)) return [];

  const ehKitQueDesmembra = produto.is_kit === 1 && produto.kit_explode_on_sale !== 0;
  if (!ehKitQueDesmembra) {
    return [{ productId: produto.id, name: produto.name, quantity: quantidade }];
  }

  const pecas = listKitComponents(companyId, produto.id);
  // Kit marcado como kit e sem peça é cadastro quebrado. Cair no próprio
  // produto preserva o comportamento antigo em vez de deixar a venda passar
  // sem baixar nada — vender sem tirar do estoque é pior que recusar.
  if (pecas.length === 0) {
    return [{ productId: produto.id, name: produto.name, quantity: quantidade }];
  }

  return pecas.map((p) => ({
    productId: p.component_id,
    name: p.name,
    quantity: p.quantity * quantidade,
    doKit: produto.name,
  }));
}

/**
 * Um item que ENTROU no carrinho e SAIU antes do Finalizar — GAP-V52/V63.
 *
 * O rodapé do PDV contava "Itens cancelados: 0" com um literal fixo, e a
 * remoção de linha era invisível ao servidor: bipar, mostrar o total ao
 * cliente, tirar a linha e fechar por menos não deixava rastro nenhum. A tela
 * agora registra cada remoção localmente e as envia AQUI, junto da venda que
 * fechou — retrato congelado (nome, quantidade, preço da hora), nunca
 * referência viva.
 *
 * Venda abandonada sem finalizar NÃO persiste rastro, e é decisão: o carrinho
 * é estado da tela, e o servidor só fica sabendo da venda no Finalizar. O que
 * este rastro cobre é o desvio clássico do balcão — fechar por menos do que
 * se mostrou —, que por definição termina numa venda fechada.
 */
export interface CancelledItemInput {
  productId?: string | null;
  name?: string;
  quantity: number;
  unitPriceCents?: number;
  /** Hora da remoção, carimbada pela tela. Ausente vira o agora da venda. */
  removedAt?: string;
  reason?: string | null;
}

export interface SalePaymentInput {
  method: string;
  amountCents: number;
  provider?: string;
  providerRef?: string;
  /** Pagamentos assíncronos (PIX) entram como `pending` até confirmação. */
  status?: 'settled' | 'pending';
  /**
   * Em quantas vezes o cliente parcelou no cartão.
   *
   * A maquininha JÁ pergunta isto ao provedor e JÁ grava na transação — o dado
   * existia e era descartado no caminho de volta. É ele que decide em quantas
   * datas o dinheiro cai.
   */
  installments?: number;
  /**
   * O PIX gerado no balcão pelo provedor de cobrança (GAP-PRD-077). A linha só
   * diz QUAL cobrança: o status (paga → liquidada, em aberto → pendente) sai
   * da cobrança, conferida no servidor, e nunca do que a tela afirmou.
   */
  paymentIntentId?: string;
}

/** Uma linha do serviço itemizado de uma OS (GAP-PRD-101) — ver `serviceLines`. */
export interface ServiceSaleLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  /**
   * Custo UNITÁRIO fotografado. Nulo = sem retrato (mão de obra, ou peça
   * baixada antes de a OS passar a fotografar custo) — e é lido como tal pelo
   * CMV, nunca como zero.
   */
  costCents: number | null;
}

/**
 * Confere o serviço itemizado antes de qualquer escrita.
 *
 * A soma das linhas TEM de ser o total do serviço: é ela que o cliente paga, e
 * uma linha a mais ou a menos faria a venda dizer um total e os itens outro.
 * Lista vazia ou ausente é o caminho de sempre (uma linha só).
 */
function conferirLinhasDeServico(
  linhas: ServiceSaleLine[] | undefined,
  serviceTotal: number,
): ServiceSaleLine[] | null {
  if (!Array.isArray(linhas) || linhas.length === 0) return null;
  for (const l of linhas) {
    const custoInvalido =
      l.costCents !== null && (!Number.isInteger(l.costCents) || l.costCents < 0);
    if (
      !String(l.description ?? '').trim()
      || !(Number(l.quantity) > 0)
      || !Number.isInteger(l.unitPriceCents)
      || !Number.isInteger(l.totalCents)
      || l.totalCents < 0
      || custoInvalido
    ) {
      throw new ApiError('CORE_SERVICE_LINE_INVALID', 'Linha de serviço inválida.', 400);
    }
  }
  const soma = linhas.reduce((acc, l) => acc + l.totalCents, 0);
  if (soma !== serviceTotal) {
    throw new ApiError(
      'CORE_SERVICE_LINES_MISMATCH',
      `As linhas do serviço somam ${soma} centavos e o serviço vale ${serviceTotal}.`,
      400,
    );
  }
  return linhas;
}

export interface CreateSaleInput {
  companyId: string;
  userId: string;
  idempotencyKey: string;
  items: SaleItemInput[];
  payments: SalePaymentInput[];
  customerId?: string | null;
  sellerId?: string | null;
  terminalId?: string | null;
  cashSessionId?: string | null;
  /**
   * A venda veio do BALCÃO — `POST /core/sales` e o relançamento da venda
   * guardada offline, que montam a entrada pelo mesmo `vendaDoCorpo`.
   *
   * Existe por causa da gaveta (E-venda-servidor-08 / H-caixa-seguranca-05):
   * a venda de balcão PRECISA cair num turno, qualquer que seja a forma de
   * pagamento, senão ela some do "recebido no turno, por meio" e a
   * conferência da maquininha com o fechamento nunca bate. As outras portas
   * (orçamento convertido na gestão, consignação, OS faturada) não passam por
   * gaveta nenhuma e não mudam. É campo do SERVIDOR: `origin` vem do corpo e
   * qualquer cliente de API o escreve como quiser.
   */
  canal?: 'balcao';
  discountCents?: number;
  surchargeCents?: number;
  origin?: string;
  note?: string | null;
  /** Itens removidos do carrinho antes do Finalizar. Ver CancelledItemInput. */
  cancelledItems?: CancelledItemInput[];
  /**
   * Quanto do CRÉDITO DE LOJA do cliente esta venda consome (GAP-V10/V47).
   *
   * ## Por que é campo próprio, e não mais uma linha em `payments`
   *
   * `payments` é a lista do que o cliente PAGOU, e cada meio dela é um
   * INSTRUMENTO com comportamento amarrado no código: dinheiro mexe na gaveta e
   * admite troco, cartão passa pela maquininha, PIX depende de terminal — é o
   * que `PaymentMethods.ts` diz por extenso, e é por isso que aquele catálogo é
   * código e não cadastro.
   *
   * Crédito de loja não é instrumento nenhum. É a EXTINÇÃO DE UMA DÍVIDA que a
   * loja já tinha com esta pessoa desde uma devolução anterior. Enfiá-lo em
   * `payments` faria `core_sale_payments` — a tabela de "o que entrou" —
   * registrar uma entrada que nunca entrou, e todo relatório por forma de
   * recebimento passaria a contar dinheiro que não existe.
   *
   * ## O que ele NÃO é
   *
   * Não é desconto. Desconto reduz a receita da venda, e a receita aqui é
   * cheia: a loja entregou mercadoria e se livrou de uma dívida do mesmo
   * tamanho. Reduzi-la aqui contaria a devolução duas vezes — uma na ponta que
   * concedeu, outra na que gastou.
   *
   * O que ele faz é LIQUIDAR o recebível da venda, com baixa própria e método
   * próprio (`CREDITO_DE_LOJA`). Sem isso a venda paga com vale ficaria em
   * aberto no contas a receber e alguém cobraria do cliente o que ele não deve.
   *
   * Exige `customerId`, nunca passa do total (crédito não vira troco) e nunca
   * passa do saldo — as três recusas moram em `CustomerCreditService`.
   */
  customerCreditCents?: number;
  /**
   * Valor de serviço (mão de obra + peças já lançadas em uma OS).
   *
   * Entra no total SEM gerar movimento de estoque: as peças de uma ordem de
   * serviço já foram baixadas quando foram lançadas na OS. Repetir a baixa
   * aqui debitaria o estoque duas vezes pela mesma peça.
   */
  serviceTotalCents?: number;
  serviceDescription?: string;
  /**
   * O serviço ITEMIZADO — as peças da OS e a mão de obra, cada uma com a sua
   * linha (GAP-PRD-101).
   *
   * Opcional: sem ele, o serviço entra como UMA linha (`serviceDescription`,
   * custo nulo), como sempre. Com ele, cada linha entra com o custo que a OS
   * fotografou na baixa da peça — é o que leva a peça da oficina ao CMV. As
   * linhas entram SEM produto (`product_id` nulo) e SEM movimento de estoque.
   * A soma TEM de fechar com `serviceTotalCents` — conferido.
   *
   * A VENDA DA OS NÃO USA MAIS ESTE CAMPO para as peças: desde a junção com a
   * frente fiscal (GAP-PRD-024) a peça é mercadoria na nota e entra por
   * `linhasJaBaixadas`, com produto e com o mesmo retrato de custo; a mão de
   * obra entra por `serviceTotalCents`. Fica para serviço itemizado sem
   * mercadoria.
   */
  serviceLines?: ServiceSaleLine[];
  /**
   * Mercadoria que JÁ saiu do estoque por outro caminho — as peças da OS, que
   * baixaram na conclusão técnica (GAP-PRD-024).
   *
   * Viravam parte de `serviceTotalCents`, uma linha "Ordem de serviço #N" sem
   * produto: a nota fiscal não tinha NCM de onde tirar e a peça (ICMS) se
   * misturava à mão de obra (ISS). Aqui cada peça é uma linha COM produto e
   * com o retrato de custo, e continua sem movimento de estoque — a baixa já
   * aconteceu, e repeti-la debitaria a peça duas vezes.
   */
  linhasJaBaixadas?: LinhaJaBaixada[];
  /**
   * QUEM está no balcão, para a alçada da concessão.
   *
   * ## Por que isto entra por parâmetro
   *
   * A conta da concessão só pode ser feita aqui, onde o preço vigente de cada
   * linha é conhecido. Mas QUEM pediu a venda e SE um gestor já liberou são
   * fatos da requisição, e um serviço não tem como descobri-los sozinho.
   *
   * ## O que significa NÃO passar este campo
   *
   * Sem "alcada", a concessão continua sendo CALCULADA e DEVOLVIDA — ela nunca
   * deixa de ser medida —, mas não é barrada AQUI. Isso deixou de ser uma
   * dívida e passou a ser uma decisão, e a decisão inteira está escrita em
   * `convertQuote`, no QuoteService.
   *
   * Em uma frase: a concessão é barrada ONDE O PREÇO É ESCRITO — na criação do
   * orçamento e da pré-venda, longe do caixa — e não onde ele é COBRADO. Quem
   * converte um documento repassa preços que já foram conferidos e aprovados;
   * cobrar de novo ali só produziria um pedido de gestor com o cliente na
   * frente toda vez que a tabela de preços mudasse.
   *
   * O caminho que ORIGINOU esta rodada — o PDV, POST /core/sales — passa
   * sempre, porque ali o preço está sendo escrito e cobrado no mesmo ato.
   */
  alcada?: {
    /** Perfis do usuário que está registrando a venda. */
    profileCodes: string[];
    /** Liberação de gestor já obtida para esta venda, se houver. */
    authorizationId?: string | null;
    /**
     * Os perfis de QUEM VENDEU, quando não é quem envia — a venda guardada sem
     * servidor que a fila reenvia com a sessão de outra pessoa (P0 da Preço
     * Justo / G-offline-sync-M03). O limite de desconto passa a ser o mais
     * ESTREITO das duas pessoas (`limiteDaAlcada`): o caixa de limite largo
     * que reenvia a fila não abre para a atendente o que o perfil dela não abre.
     */
    perfisDeQuemVendeu?: string[] | null;
  };
  /**
   * QUEM está convertendo um documento, só para o PISO DE PREÇO do produto
   * (A-produto-17#orcamento).
   *
   * O DEFEITO: o piso só era conferido com `alcada`, e a conversão de orçamento
   * e pré-venda chama esta função SEM `alcada` — de propósito, pela concessão
   * (ver acima). Um documento escrito antes de o piso existir, com a linha
   * abaixo do mínimo do cadastro, virava venda abaixo do piso sem liberação de
   * ninguém.
   *
   * Por que um campo SEPARADO e não `alcada`: `alcada` também barra a
   * concessão, e barrar a concessão na conversão é exatamente a saída que
   * `convertQuote` recusa (o preço de tabela que subiu pediria gestor com o
   * cliente no caixa). O piso é outra pergunta — "abaixo do mínimo que o dono
   * declarou no produto?" — e ela vale onde o preço é COBRADO.
   *
   * Com `alcada` presente, este campo é ignorado: a alçada já confere o piso.
   */
  alcadaDoPiso?: {
    profileCodes: string[];
    authorizationId?: string | null;
  };
  /**
   * QUANDO a venda guardada sem servidor aconteceu no balcão — o `queuedAt` que
   * o PDV manda em `vendaGuardada` no reenvio da fila (G-offline-sync-14).
   *
   * Só `POST /core/sales` preenche, e só quando o corpo é de venda guardada.
   * Vale como hora da venda (`core_sales.created_at` e a competência) quando
   * passa pelas três conferências de `horaDaVendaGuardada`; fora delas a venda
   * entra com a hora de agora e o resultado diz por quê.
   */
  vendidaEm?: string | null;
}

/**
 * A hora com que a venda entrou, e de onde ela veio (G-offline-sync-14).
 *
 * Só existe quando o pedido trouxe `vendidaEm` — a venda comum do balcão não
 * tem o que explicar.
 */
export interface HoraDaVenda {
  /** O instante gravado em `core_sales.created_at` — e de onde sai a competência. */
  instante: string;
  /** A hora que o PDV disse, como veio. */
  vendidaEm: string | null;
  origem: 'vendida_em' | 'agora';
  /** Por que a hora do PDV NÃO foi usada; nulo quando foi. */
  motivo: string | null;
}

/**
 * TUDO que a loja abriu mão nesta venda, e de onde veio.
 *
 * ## Por que "concessão" e não "desconto"
 *
 * Porque desconto era só um dos três caminhos, e a trava só olhava para ele.
 * Os outros dois passavam inteiros:
 *
 *   1. DESCONTO DE LINHA. item.discountCents entrava sem checagem nenhuma.
 *      Bastava digitar o desconto na linha em vez do rodapé.
 *   2. PREÇO UNITÁRIO REBAIXADO. Havia teto (não se cobra acima do anunciado)
 *      e não havia piso. Uma moto de R$ 12.000 saía por R$ 1,00: a venda
 *      fechava, o estoque baixava, e a comissão era calculada sobre R$ 1,00.
 *
 * Os três são a mesma coisa vista de ângulos diferentes — dinheiro que a loja
 * deixou de receber —, então são somados e medidos juntos.
 *
 * ## O BRUTO É DO SERVIDOR, e é essa a correção mais importante
 *
 * Antes o denominador vinha do corpo da requisição, em estimatedTotalCents: o
 * PDV dizia ao servidor qual era o total, e o servidor calculava o percentual
 * contra o número que o cliente mandou. Um total inflado passava QUALQUER
 * desconto sem gestor. Aqui o bruto é preço vigente vezes quantidade, somado
 * neste arquivo, e nada do corpo da requisição participa dele.
 */
export interface Concessao {
  /** Preço vigente x quantidade, somado no servidor, mais o serviço. */
  brutoCents: number;
  /** Rodapé + linha + preço rebaixado. */
  concedidoCents: number;
  /** concedido / bruto, em pontos percentuais. */
  percentual: number;
  /**
   * De onde veio cada centavo concedido.
   *
   * Existe para a MENSAGEM poder dizer o que reduzir. "Precisa de gestor" sem
   * número manda a pessoa adivinhar qual dos três campos ela mexeu.
   */
  origens: {
    cabecalho: number;
    itens: number;
    precoRebaixado: number;
    /**
     * Preço de tela desatualizado: a linha veio com `precoNegociado: false` e
     * um unitário abaixo do vigente — o preço subiu depois do bipe. Só aparece
     * quando é maior que zero, para o formato de sempre continuar o de sempre.
     * Ver `SaleItemInput.precoNegociado`.
     */
    precoDesatualizado?: number;
  };
}

/**
 * A TRILHA DA ALÇADA DESTA VENDA — quem aplicou, com que limite, o que passou
 * dele e quem liberou (P0 da Preço Justo).
 *
 * O DEFEITO que ela fecha: a auditoria de `sale.create` gravava
 * `authorizationId: req.body.authorizationId` — o que o CLIENTE disse. Venda
 * dentro do limite com um id qualquer no corpo ficava na trilha como "liberada
 * pelo gestor"; venda liberada não dizia QUEM assinou nem POR QUÊ sem abrir a
 * tabela de liberações. Tudo aqui é do servidor: o limite é o dos perfis do
 * token, a liberação é a que foi GASTA nesta venda, e o autorizador e o motivo
 * vêm da linha gravada — nunca do corpo. Sem senha nem PIN: nada aqui é
 * credencial.
 */
export interface TrilhaDaAlcada {
  /** Quem registrou a venda (do token). */
  aplicadoPor: string;
  /** Com que limite a concessão foi medida. Nulo quando a venda não passou pela alçada. */
  limite: LimiteDeDesconto | null;
  /** Os tetos que a concessão ultrapassou — vazio quando coube. */
  excessos: ExcessoDeDesconto[];
  /** A liberação GASTA nesta venda, lida do banco. */
  liberacao: { id: string; autorizadoPor: string; justificativa: string | null } | null;
  /** O antes (bruto), a concessão e o depois (total cobrado). */
  brutoCents: number;
  concedidoCents: number;
  percentual: number;
  totalCents: number;
  /** As linhas que concederam alguma coisa, com o bruto de cada uma. */
  linhas: LinhaDaConcessao[];
}

export interface SaleRecord {
  id: string;
  number: number;
  total_cents: number;
  change_cents: number;
  status: string;
  created_at: string;
}

function loadSale(saleId: string): SaleRecord | null {
  const row = getConnection()
    .prepare('SELECT id, number, total_cents, change_cents, status, created_at FROM core_sales WHERE id = ?')
    .get(saleId) as SaleRecord | undefined;
  return row ?? null;
}

/**
 * Soma dias A UM INSTANTE, pelo calendário da loja.
 *
 * ## O DEFEITO QUE ESTA FUNÇÃO EXISTE PARA FECHAR
 *
 * Aqui morava `const diaMais = somarDias`, e o apelido escondia uma troca de
 * tipo: `somarDias` recebe uma DATA DE CALENDÁRIO e começa por
 * `dia.slice(0, 10)`. Quem chamava passava `now`, que é um INSTANTE ISO — e
 * esse recorte responde o dia de GREENWICH.
 *
 * O resultado é que a venda media o mesmo instante por DOIS relógios: a
 * competência saía de `diaDaLoja(now)` (o dia de quem está atrás do balcão) e o
 * vencimento saía do dia de Greenwich. Entre 21h e a meia-noite em Pelotas os
 * dois discordam, e a venda fiada das 22h30 com trinta dias de prazo nascia
 * vencendo TRINTA E UM dias depois da própria competência.
 *
 * O conserto não é somar diferente: é converter o instante para o dia da loja
 * ANTES de somar — o mesmo remédio que a rodada 82 aplicou às leituras. A
 * assinatura passa a dizer o que recebe (`instante`), para o apelido nunca mais
 * poder disfarçar um instante de data de calendário.
 */
function diaMais(instante: string, dias: number): string {
  return somarDias(diaDaLoja(instante), dias);
}

/**
 * A FORMA E O STATUS DE CADA PAGAMENTO, NORMALIZADOS NA ENTRADA
 * (E-venda-servidor-12 e E-venda-servidor-02).
 *
 * ## A forma
 *
 * O DEFEITO: `assertPaymentMethod` normaliza (`trim().toLowerCase()`) para
 * CONFERIR, mas a venda seguia com o texto cru. 'CREDITO' passava na
 * conferência e escapava do portão da maquininha, que compara `=== 'credito'`:
 * com maquininha configurada, uma linha 'Credito' liquidada sem cobrança
 * fechava a venda sem nada ter passado no aparelho — o GAP-V48 reaberto por uma
 * letra maiúscula. E o INSERT gravava 'Credito', que o resumo do turno agrupa
 * separado de 'credito'. A partir daqui a venda inteira só enxerga o código.
 *
 * ## O status
 *
 * O DEFEITO: `status` chegava cru do corpo, e as regras da venda o leem de dois
 * jeitos — troco e liquidação perguntam `=== 'settled'`, a gaveta pergunta
 * `!== 'pending'`. Com 'x', o dinheiro entrava na gaveta e o título ficava em
 * aberto; com dinheiro 'pending', a venda fechava sem espécie na gaveta e com um
 * recebível de ninguém. Só existem dois estados, e 'pending' só existe para o
 * PIX — o único meio que chega depois. Dinheiro e cartão pendentes não são
 * um estado do balcão: eram a porta para a nota sair do caixa sem entrar na
 * gaveta. O PIX pendente continua (é a regra de negócio de "mercadoria sai
 * contra PIX aguardando", e o fechamento do turno trava com ele em aberto);
 * o do balcão tem o status tirado da COBRANÇA (`conferirPixDoBalcaoNaVenda`),
 * nunca do que a tela afirmou.
 */
function normalizarPagamentos(pagamentos: SalePaymentInput[] | undefined | null): SalePaymentInput[] {
  if (!Array.isArray(pagamentos)) return [];
  return pagamentos.map((p) => {
    const metodo = assertPaymentMethod(p?.method).code;
    const status = p?.status as unknown;
    if (status !== undefined && status !== null && status !== 'settled' && status !== 'pending') {
      throw new ApiError(
        'CORE_PAYMENT_STATUS_INVALID',
        `Situação de pagamento inválida em "${metodo}": "${String(status)}". `
          + 'Um pagamento está liquidado ou pendente — confira o que o sistema de origem manda.',
        400,
        { method: metodo, status },
      );
    }
    if (status === 'pending' && metodo !== 'pix') {
      throw new ApiError(
        'CORE_PAYMENT_PENDING_NOT_ALLOWED',
        `Pagamento em "${metodo}" marcado como pendente. Só o PIX fica aguardando confirmação — `
          + 'dinheiro e cartão entram liquidados, no ato. Registre o pagamento como recebido, ou '
          + 'feche a venda sem ele.',
        400,
        { method: metodo },
      );
    }
    const normalizado: SalePaymentInput = { ...p, method: metodo };
    if (status === null) delete normalizado.status;
    return normalizado;
  });
}

/**
 * ============================================================================
 * A FORMA DO PEDIDO — a venda recusa o que não é venda, em vez de estourar 500
 * ============================================================================
 *
 * ## O DEFEITO (auditoria do PDV, P0 da Preço Justo)
 *
 * `createSale` recebia o corpo HTTP com os tipos que a interface PROMETE e o
 * usava cru: `productId`, `customerId`, `cashSessionId`, `sellerId`, `note` e
 * `unitIds` iam direto para o `prepare(...).get()` e para o INSERT. O tipo é
 * uma promessa do compilador sobre quem chama de dentro; quem chama de fora é
 * `req.body`, e ali `{ items: [{ quantity: 1 }] }` é um objeto legítimo de
 * JSON. O resultado, medido contra banco de teste na ROTA MAIS USADA DO
 * SISTEMA:
 *
 *   items: [null] .............. TypeError "Cannot read properties of null"
 *   item sem productId ......... "Provided value cannot be bound to SQLite parameter 1."
 *   productId/customerId/
 *   cashSessionId/sellerId
 *   como objeto ................ "Unknown named parameter 'id'"
 *   unitIds como objeto ........ "unidadesDaLinha is not iterable"
 *   note como objeto ........... "Provided value cannot be bound to SQLite parameter 16."
 *
 * e todos saíam como 500 `API_UNAVAILABLE` — "Erro interno." no balcão. É o
 * pior desfecho possível nesta rota: o operador não fica sabendo o que houve
 * NEM se a venda entrou, e a única saída é tentar de novo com o cliente na
 * frente, arriscando a segunda venda (a chave de idempotência salva o reenvio
 * IGUAL; a tentativa corrigida é outro pedido).
 *
 * Não é caso hipotético: o carrinho do PDV monta a linha a partir do resultado
 * da busca, a fila offline guarda o corpo que o navegador montou meses atrás
 * (e o relança tal e qual), e a pré-venda/OS/consignação montam a mesma
 * entrada por caminhos diferentes. Qualquer um deles perdendo um campo pelo
 * caminho produzia "Erro interno." em vez de dizer QUAL linha está incompleta.
 *
 * ## Onde mora o guarda, e por quê
 *
 * No SERVIÇO, e não na rota — a mesma razão do guarda do terminal algumas
 * linhas abaixo: é aqui que todo chamador passa, inclusive os que ainda não
 * existem. E ANTES da transação, junto das outras conferências de forma, para
 * que nada seja escrito e a numeração da venda não seja consumida.
 *
 * ## O que é aceito
 *
 * Identificador é TEXTO, mas número também passa — convertido, e sem mudar o
 * desfecho: `WHERE id = 7` não acha produto nenhum e continua saindo
 * `CORE_PRODUCT_NOT_FOUND`, como antes. O que passa a ser recusado com nome é
 * o que nunca foi identificador: objeto, lista, booleano, vazio, ausente.
 */
function textoDoPedido(valor: unknown): string | null {
  if (typeof valor === 'string') return valor.trim() || null;
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return null;
}

/**
 * O campo do cabeçalho tem forma de texto?
 *
 * Ausente e nulo passam (são "não informado"), e TEXTO VAZIO também: observação
 * em branco é o caso comum do balcão, e recusá-la seria trocar um defeito por
 * outro. O que não passa é o que nunca foi texto — objeto, lista, booleano.
 */
function forma(valor: unknown): boolean {
  if (valor === undefined || valor === null || typeof valor === 'string') return true;
  return typeof valor === 'number' && Number.isFinite(valor);
}

function conferirFormaDoPedido(input: CreateSaleInput): void {
  if (!Array.isArray(input.items)) {
    throw new ApiError(
      'CORE_SALE_ITEMS_INVALID',
      'Os itens da venda precisam vir como uma lista. Recarregue o PDV e monte o carrinho de novo.',
      400,
    );
  }
  input.items.forEach((bruto, n) => {
    // Por `unknown`: o tipo promete uma linha inteira, e quem chega é `req.body`.
    const item = bruto as unknown as Record<string, unknown> | null | undefined;
    if (item === null || item === undefined || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiError(
        'CORE_SALE_ITEM_INVALID',
        `A linha ${n + 1} do carrinho veio vazia. Recarregue o PDV e monte o carrinho de novo.`,
        400,
        { index: n },
      );
    }
    if (textoDoPedido(item.productId) === null) {
      throw new ApiError(
        'CORE_SALE_ITEM_PRODUCT_REQUIRED',
        `A linha ${n + 1} do carrinho não diz QUAL produto está sendo vendido. `
          + 'Tire a linha, bipe o produto de novo e finalize.',
        400,
        { index: n },
      );
    }
    if (item.unitIds !== undefined && item.unitIds !== null && !Array.isArray(item.unitIds)) {
      throw new ApiError(
        'CORE_SALE_ITEM_UNITS_INVALID',
        `A linha ${n + 1} do carrinho informa as peças (chassi/número de série) num formato que `
          + 'não é uma lista. Escolha as peças de novo na linha e finalize.',
        400,
        { index: n },
      );
    }
  });
  // Os identificadores e o texto livre do cabeçalho — cada um é gravado ou
  // consultado cru mais abaixo, e cada um derrubava a venda com 500.
  const cabecalho: [string, unknown, string][] = [
    ['customerId', input.customerId, 'o cliente da venda'],
    ['sellerId', input.sellerId, 'o vendedor da venda'],
    ['terminalId', input.terminalId, 'o caixa da venda'],
    ['cashSessionId', input.cashSessionId, 'a gaveta da venda'],
    ['note', input.note, 'a observação da venda'],
    ['origin', input.origin, 'a origem da venda'],
  ];
  for (const [campo, valor, oQue] of cabecalho) {
    if (!forma(valor)) {
      throw new ApiError(
        'CORE_SALE_FIELD_INVALID',
        `O campo "${campo}" (${oQue}) veio num formato que o sistema não entende. `
          + 'Recarregue o PDV e finalize de novo.',
        400,
        { field: campo },
      );
    }
  }
}

/**
 * Unidades que fracionam quando a empresa ainda não tem o próprio cadastro de
 * unidades — as mesmas do padrão de `CatalogAuxService` com casas decimais.
 */
const UNIDADES_QUE_FRACIONAM = new Set(['KG', 'G', 'L', 'M', 'M2', 'CM', 'AR']);

/**
 * O produto admite quantidade quebrada? (E-venda-servidor-13 / D-pdv-teclado-14)
 *
 * Pesável sim (a balança manda 0,735 kg). Vendido por metro, litro ou quilo
 * sim — é a unidade que diz, pelas casas decimais do cadastro de unidades. O
 * resto é contado uma a uma: meia camiseta não existe na prateleira.
 */
function vendeFracionado(
  companyId: string,
  produto: { weighable?: number | null; unit?: string | null },
): boolean {
  if (produto.weighable === 1) return true;
  const casas = casasDaUnidade(companyId, produto.unit);
  if (casas !== null) return casas > 0;
  return UNIDADES_QUE_FRACIONAM.has(String(produto.unit ?? 'UN').trim().toUpperCase());
}

/**
 * As casas decimais que o cadastro de unidades dá à unidade do produto — ou
 * `null` quando a unidade não está cadastrada nesta operação.
 */
function casasDaUnidade(companyId: string, unidade: string | null | undefined): number | null {
  const codigo = String(unidade ?? 'UN').trim().toUpperCase();
  const cadastrada = getConnection()
    .prepare('SELECT decimals FROM core_units WHERE company_id = ? AND UPPER(code) = ? LIMIT 1')
    .get(companyId, codigo) as { decimals: number } | undefined;
  return cadastrada ? Number(cadastrada.decimals) : null;
}

/**
 * O TETO DE QUANTIDADE DE UMA LINHA — o mesmo `QTD_MAXIMA_DA_LINHA` do PDV
 * (`src/pages/gs/pdvTypes.ts`), agora também no servidor (D-pdv-teclado-05).
 *
 * O DEFEITO: a tela recusava acima de 99.999, e a API aceitava qualquer
 * número. Nenhuma venda de balcão leva cem mil unidades de um item — e é
 * exatamente esse o tamanho de um código de barras que caiu no campo de
 * quantidade ("3" + "7891234567895" vira 37 trilhões). Pela API, pela fila
 * offline de um PDV antigo ou pela conversão de um orçamento digitado errado, a
 * linha entrava: estoque negativo de trilhões e um total que nenhuma nota
 * fiscal comporta. `convertQuote` passa por `createSale`, então o teto vale lá.
 */
export const QUANTIDADE_MAXIMA_DA_LINHA = 99_999;

/**
 * Até quanto tempo depois de acontecer a venda guardada ainda entra com a hora
 * dela (G-offline-sync-14). Três dias cobrem o fim de semana com a internet
 * fora; mais que isso não é fila de PDV, é uma venda que precisa de conferência.
 */
export const PRAZO_DA_HORA_GUARDADA_MS = 72 * 60 * 60 * 1000;

/**
 * A HORA DA VENDA GUARDADA SEM SERVIDOR (G-offline-sync-14).
 *
 * O DEFEITO: o reenvio da fila mandava `vendaGuardada.queuedAt` e a trilha
 * gravava `vendidaEm`, mas `core_sales.created_at` era a hora da SINCRONIZAÇÃO.
 * A venda das 22h de ontem, sincronizada hoje às 9h, entrava no DRE, na comissão
 * e nos relatórios de HOJE — o fechamento de ontem ficava sem ela, o de hoje com
 * ela a mais, e a comissão do mês virava quando a virada caía no dia 1º.
 *
 * A hora do PDV só vale se passar pelas três conferências — ela vem do cliente,
 * e um relógio errado não pode escrever o passado de ninguém:
 *
 *   - não está no futuro (relógio do computador adiantado);
 *   - tem no máximo 72 horas (`PRAZO_DA_HORA_GUARDADA_MS`);
 *   - não é anterior à abertura da gaveta em que a venda entrou — dinheiro que
 *     "entrou" antes de a gaveta abrir não bate com fechamento nenhum.
 *
 * Fora disso a venda entra com a hora de agora e o motivo volta para a trilha.
 * Número e idempotência não mudam: a hora não entra na impressão digital.
 */
function horaDaVendaGuardada(entrada: {
  vendidaEm: unknown;
  aberturaDaGaveta: string | null;
  agora: string;
}): HoraDaVenda {
  const bruto = typeof entrada.vendidaEm === 'string' ? entrada.vendidaEm.trim() : '';
  const naHoraDeAgora = (motivo: string): HoraDaVenda => ({
    instante: entrada.agora,
    vendidaEm: bruto || null,
    origem: 'agora',
    motivo,
  });
  // Só o instante ISO que o PDV grava (`new Date().toISOString()`): "13/09" ou
  // uma data sem hora não dizem QUANDO, e `Date.parse` aceitaria os dois.
  const quando = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(bruto) ? Date.parse(bruto) : Number.NaN;
  if (!Number.isFinite(quando)) {
    return naHoraDeAgora('a hora da venda guardada não é um instante válido');
  }
  const agoraMs = Date.parse(entrada.agora);
  if (quando > agoraMs) {
    return naHoraDeAgora('a hora da venda guardada está no futuro — o relógio do PDV está adiantado');
  }
  if (agoraMs - quando > PRAZO_DA_HORA_GUARDADA_MS) {
    return naHoraDeAgora('a venda guardada tem mais de 72 horas');
  }
  const abertura = entrada.aberturaDaGaveta ? Date.parse(entrada.aberturaDaGaveta) : Number.NaN;
  if (Number.isFinite(abertura) && quando < abertura) {
    return naHoraDeAgora('a hora da venda guardada é anterior à abertura da gaveta em que ela entrou');
  }
  return { instante: new Date(quando).toISOString(), vendidaEm: bruto, origem: 'vendida_em', motivo: null };
}

/** Como a recusa diz POR QUE o preço de agora é menor que o do carrinho. */
function porQueOPrecoBaixou(fonte: string): string {
  if (fonte === 'promocao') return 'entrou em promoção';
  if (fonte === 'faixa') return 'tem preço por quantidade nesta quantidade';
  if (fonte === 'tabela') return 'sai pela tabela de preço do cliente';
  return 'teve o preço baixado no cadastro';
}

export function createSale(entrada: CreateSaleInput): {
  sale: SaleRecord;
  duplicated: boolean;
  /**
   * Nulo apenas no reenvio da mesma venda: ali nada é reprecificado, e
   * recalcular a concessão sobre os preços de HOJE poderia recusar uma venda
   * que já aconteceu ontem.
   */
  concessao: Concessao | null;
  /**
   * Quantas linhas de rastro de item cancelado ESTA chamada gravou. Zero no
   * reenvio idempotente — o rastro da venda original continua lá, intacto.
   */
  cancelados: number;
  /**
   * A hora da venda guardada e se ela valeu (G-offline-sync-14). Nulo na venda
   * comum e no reenvio idempotente.
   */
  horaDaVenda: HoraDaVenda | null;
  /** A trilha da alçada (limite, excessos, liberação). Nulo no reenvio idempotente. */
  alcada: TrilhaDaAlcada | null;
} {
  ensureCoreSchema();
  /*
    A FORMA DO PEDIDO ANTES DE QUALQUER LEITURA (ver `conferirFormaDoPedido`).
    É a primeira linha porque o que ela recusa derrubava a rota com 500 antes
    mesmo de a venda ser conferida: linha sem produto, identificador que é
    objeto, observação que não é texto.
  */
  conferirFormaDoPedido(entrada);
  /*
    O PIX DO BALCÃO É CONFERIDO ANTES DE TUDO (GAP-PRD-077). A linha que chega
    com `paymentIntentId` sai daqui com o status que a COBRANÇA tem — é esse
    status que o troco, a conferência de valor e os títulos da venda leem
    abaixo. A entrada do chamador não é reescrita: a venda trabalha com a cópia.
  */
  const input: CreateSaleInput = {
    ...entrada,
    payments: conferirPixDoBalcaoNaVenda({
      companyId: entrada.companyId,
      idempotencyKey: entrada.idempotencyKey,
      // Forma e status normalizados ANTES de tudo — inclusive antes da
      // impressão digital, que compara reenvios pela forma já canônica.
      payments: normalizarPagamentos(entrada.payments),
    }),
  };
  const serviceTotal = Math.max(0, Math.round(input.serviceTotalCents ?? 0));
  const jaBaixadas = input.linhasJaBaixadas ?? [];
  for (const l of jaBaixadas) {
    if (
      !l.productId
      || !(Number(l.quantity) > 0)
      || !Number.isInteger(l.unitPriceCents)
      || !Number.isInteger(l.totalCents)
      || l.unitPriceCents < 0
      || l.totalCents < 0
    ) {
      throw new ApiError('CORE_INVALID_PAYLOAD', 'Linha de mercadoria já baixada inválida.', 400);
    }
  }
  const totalJaBaixadas = jaBaixadas.reduce((s, l) => s + l.totalCents, 0);
  // O que entra no total sem passar pela precificação do balcão: a mão de obra
  // e as peças da OS, com o valor que a OS já apurou.
  const totalSemBaixa = serviceTotal + totalJaBaixadas;
  if (!input.items.length && totalSemBaixa <= 0 && jaBaixadas.length === 0) {
    throw new ApiError('CORE_EMPTY_SALE', 'Venda sem itens.', 400);
  }
  const linhasDeServico = conferirLinhasDeServico(input.serviceLines, serviceTotal);
  if (!input.idempotencyKey) {
    throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Chave de idempotência obrigatória.', 400);
  }
  // O que este pedido vende — comparado no reenvio e gravado na criação.
  const impressaoDigital = impressaoDigitalDaMercadoria(input);

  const resultado = withTransaction(() => {
    const db = getConnection();

    /*
      Reenvio da mesma venda (ex.: PDV reconectando depois de queda de rede)
      devolve a venda original em vez de criar uma segunda.

      A BUSCA É POR CHAVE, E A CHAVE SÓ DEVOLVE A VENDA DA MESMA MERCADORIA
      (item IDEM). A chave achada com OUTRA mercadoria não é reenvio: devolver
      a venda original ali era dizer 200 a um pedido que não aconteceu — o E2E
      mandou a mesma chave com quantidade 3 em vez de 2 e o caixa ficou
      achando que registrou a venda nova. Agora é 422
      CORE_IDEMPOTENCY_KEY_REUSED, como manda o rascunho IETF do cabeçalho
      Idempotency-Key, e nada é escrito.

      O que se compara é a IMPRESSÃO DIGITAL DO PEDIDO
      (`ImpressaoDigitalDaVenda.ts`), gravada na criação — e não a venda
      reconstruída de `core_sale_items`, onde kit, serviço e peça da OS são
      gravados diferente do que chegam. Entram a mercadoria e o dinheiro
      (desconto, acréscimo, crédito e a forma e o valor de cada pagamento —
      RES-IDEM-VIZ); preço de linha, gaveta, caixa, cliente e observação ficam
      de fora: a mesma cesta reenviada com o preço reajustado, o relançamento
      offline numa gaveta aberta e o PIX já pago (a MESMA linha, com o status
      que a cobrança tem agora) continuam sendo o mesmo pedido. Venda anterior
      à coluna (nula) segue a regra antiga.

      A consequência, medida contra banco de teste, é que a chave PRECISA ser
      única por FATO, e não por sessão de tela: duas pré-vendas diferentes
      convertidas com a mesma Idempotency-Key produziam UMA venda só, e a
      segunda pré-venda saía "faturada" com a reserva solta, sem venda, sem
      pagamento e sem lançamento — uma moto a mais no sistema e uma a menos na
      prateleira.

      Por isso `convertQuote` não desce a chave crua: ela desce com o id do
      documento na frente (`quote:<quoteId>:<chave>`). Qualquer novo caminho que
      chame `createSale` a partir de um DOCUMENTO tem a mesma obrigação — o
      namespace mora em quem conhece o documento, porque aqui não há como saber
      de onde a chave veio.
    */
    const existing = db
      .prepare(
        `SELECT id, number, idempotency_fingerprint FROM core_sales
          WHERE company_id = ? AND idempotency_key = ?`,
      )
      .get(input.companyId, input.idempotencyKey) as
      | { id: string; number: number; idempotency_fingerprint: string | null }
      | undefined;
    if (existing) {
      if (outraMercadoria(existing.idempotency_fingerprint, impressaoDigital)) {
        throw new ApiError(
          'CORE_IDEMPOTENCY_KEY_REUSED',
          `Esta chave de idempotência já registrou a venda #${existing.number}, com outra mercadoria `
            + 'ou outro pagamento — nada foi registrado agora. Uma venda nova precisa de chave nova.',
          422,
          { saleId: existing.id, saleNumber: existing.number },
        );
      }
      return {
        sale: loadSale(existing.id)!,
        duplicated: true,
        concessao: null,
        cancelados: 0,
        horaDaVenda: null,
        // O reenvio não mede nada de novo: a trilha é a da venda original.
        alcada: null,
      };
    }

    /*
      A VENDA OFFLINE QUE A GERÊNCIA DESCARTOU NÃO NASCE DEPOIS
      (G-offline-sync-16).

      O DEFEITO: descartar a pendência em Regularizar ("o cliente desistiu, o
      dinheiro foi devolvido") só mudava o status dela — a CHAVE continuava
      livre. Se a resposta da entrega tinha se perdido, a cópia seguia na fila
      do PDV e o reenvio automático batia aqui: com o estoque de volta, a venda
      que o gestor declarou inexistente nascia, com baixa e dinheiro que não
      existem. A decisão da gerência vale para a chave inteira.

      Depois da busca da venda, e não antes: se a venda já existe com esta
      chave, o reenvio continua devolvendo ela — é o fato, e quem precisa saber
      do conflito é o descarte.
    */
    const descartada = db
      .prepare(
        `SELECT id FROM core_offline_sale_pendings
          WHERE company_id = ? AND idempotency_key = ? AND status = 'descartada'`,
      )
      .get(input.companyId, input.idempotencyKey) as { id: string } | undefined;
    if (descartada) {
      throw new ApiError(
        'CORE_OFFLINE_SALE_DISCARDED',
        'Esta venda guardada offline foi DESCARTADA pela gerência em Regularizar vendas offline, '
          + 'e por isso não é registrada agora. Se ela aconteceu de fato, lance uma venda nova.',
        409,
        { pendenciaId: descartada.id },
      );
    }

    /*
      A GAVETA É DA MESMA EMPRESA, E ESTÁ ABERTA — auditoria de entrega.

      O `cashSessionId` vinha do corpo e era gravado cru: a venda da empresa A
      apontando para o caixa da empresa B entrava na gaveta DELA — um
      fechamento com sobra que ninguém explicava de um lado, falta do outro. A
      devolução (SalesReturnService) valida exatamente isso; a venda, a rota
      mais usada do sistema, não validava. E gaveta FECHADA também não recebe:
      dinheiro depois da conferência é diferença que o relatório nunca acha.
    */
    let terminalDaGaveta: string | null = null;
    if (input.cashSessionId) {
      const sessao = db
        .prepare('SELECT company_id, status, terminal_id FROM core_cash_sessions WHERE id = ?')
        .get(input.cashSessionId) as
        | { company_id: string; status: string; terminal_id: string | null }
        | undefined;
      terminalDaGaveta = sessao?.terminal_id ?? null;
      if (!sessao || sessao.company_id !== input.companyId) {
        throw new ApiError(
          'CORE_CASH_SESSION_INVALID',
          'O caixa informado não é desta operação.',
          400,
        );
      }
      if (sessao.status !== 'open') {
        throw new ApiError(
          'CORE_CASH_SESSION_CLOSED',
          'O caixa informado já foi fechado — abra um caixa para vender.',
          400,
        );
      }
    }

    /*
      O CLIENTE TAMBÉM — mesmo gênero de furo, mesmo conserto. `customerId`
      de outra empresa virava dono de venda (inclusive de fiado): o crediário
      da empresa A cobrando um cadastro que pertence à B.
    */
    if (input.customerId) {
      const cliente = db
        .prepare('SELECT company_id FROM core_customers WHERE id = ?')
        .get(input.customerId) as { company_id: string } | undefined;
      if (!cliente || cliente.company_id !== input.companyId) {
        throw new ApiError(
          'CORE_CUSTOMER_INVALID',
          'O cliente informado não é desta operação.',
          400,
        );
      }
    }

    /*
      O TERCEIRO PONTO DE ENTRADA DO TERMINAL — achado por um atacante da
      rodada 32, depois de a rodada afirmar que eram dois.

      `core_sales.terminal_id` é chave estrangeira para `core_terminals`, que
      está vazia e sem cadastro. A rota de venda aceita `terminalId` do corpo e
      este serviço o inseria cru: venda com terminal fantasma morria no INSERT
      com "FOREIGN KEY constraint failed" — 500 sem uma palavra sobre a causa,
      NA ROTA MAIS USADA DO SISTEMA, alcançável por qualquer operador de caixa.

      O guarda fica no SERVIÇO, e não na rota, pelo mesmo motivo dos outros
      dois pontos: é aqui que todo chamador passa, inclusive os que ainda não
      existem. Com o cadastro de caixas (GAP-PRD-039) ele confere também a
      EMPRESA — e não exige o caixa ligado: a venda feita offline num caixa
      desligado depois ainda aconteceu, e a regularização não pode perdê-la.
    */
    assertTerminalDaEmpresa(input.companyId, input.terminalId);

    /*
      A VENDA DE UM CAIXA NÃO CAI NA GAVETA DO OUTRO (GAP-PRD-039).

      Era o desfecho medido na auditoria: o segundo operador vendendo com o
      `cashSessionId` da gaveta do primeiro. Com uma gaveta por caixa, o caixa
      da venda e o da gaveta têm de ser o MESMO — e quando a venda não diz o
      caixa, ela herda o da gaveta em que caiu, para o relatório por caixa
      contar o dinheiro onde ele está.
    */
    const terminalInformado =
      typeof input.terminalId === 'string' && input.terminalId !== '' ? input.terminalId : null;
    if (input.cashSessionId && terminalInformado && terminalDaGaveta !== terminalInformado) {
      throw new ApiError(
        'CORE_CASH_SESSION_OTHER_TERMINAL',
        'A gaveta informada é de outro caixa. Cada caixa vende na própria gaveta — '
          + 'abra o caixa deste computador para vender.',
        409,
        { terminalDaVenda: terminalInformado, terminalDaGaveta },
      );
    }
    let terminalDaVenda = terminalInformado ?? terminalDaGaveta;

    // A política comercial desta operação, lida UMA vez. Nulo no cadastro
    // significa "o comportamento de hoje", então o que chega aqui já é o
    // número efetivo — 10% de alçada, fiado vencendo hoje — e nenhum trecho
    // abaixo precisa saber se o dono configurou ou não.
    const politica = politicaDaEmpresa(input.companyId);

    /*
      A CONDIÇÃO COMERCIAL DESTE CLIENTE — e por que ela é lida AQUI, uma vez,
      antes de precificar item nenhum.

      É esta linha que resolve a concessão do revendedor sozinha. Com a tabela
      DENTRO do preço vigente, o desconto combinado entra no DENOMINADOR: o
      bruto da venda já nasce com os 15% do atacado, o "preço rebaixado" de cada
      linha fica ZERO, e o revendedor fecha a compra sem chamar gestor mesmo com
      teto de 10%. O que sobra para a alçada medir é só o que o operador
      conceder ALÉM da tabela — que é exatamente o que a alçada existe para
      vigiar.

      Antes disso, o mesmo atendimento era feito digitando 15% de desconto na
      mão: desconto digitado é concessão por definição, e a trava parava o
      balcão em toda venda de atacado.

      Nulo quando não há cliente na venda (o balcão comum), quando o cliente não
      tem tabela, ou quando a tabela dele foi desativada — as três coisas
      querem dizer a mesma coisa para o cálculo, e quem decide isso é
      `priceTableForCustomer`.
    */
    const tabelaDoCliente = priceTableForCustomer(input.companyId, input.customerId ?? null);
    /*
      AS FAIXAS DE QUANTIDADE, UMA LEITURA SÓ PARA A VENDA INTEIRA (GAP-V04).

      Sem elas AQUI, a venda teria um preço e a tela outro: `POST /pricing/cart`
      já devolve o preço da faixa, o operador vê R$ 10,00 na linha de três, e o
      teto conferido no fechamento continuaria sendo o cheio — a diferença
      viraria CONCESSÃO, e a venda de atacado pararia o balcão pedindo gestor.
      É a mesma falha que a tabela de preço tinha antes de entrar no vigente, e
      o conserto é o mesmo: o combinado vive no DENOMINADOR.
    */
    const faixasDaEmpresa = faixasAtivasDaEmpresa(input.companyId);

    /*
      As linhas cujo desconto não cabe no que elas cobram. O laço abaixo anota
      aqui em vez de recusar na primeira, e a recusa sai logo depois dele com a
      lista inteira — o porquê está escrito na anotação, junto do teste.
    */
    const descontosImpossiveis: { productId: string; discountCents: number }[] = [];

    // Preço vem do cadastro, não do cliente: o frontend não define quanto
    // custa. Só o desconto é aceito como entrada.
    const priced = input.items.map((item) => {
      const product = db
        .prepare(
          // `is_kit` e `kit_explode_on_sale` vêm junto porque decidem O QUE
          // baixa do estoque — sem elas a venda de kit baixaria o próprio kit.
          // `open_price` vem junto porque decide se o preço do cadastro é TETO
          // ou SUGESTÃO, e disso depende se a diferença é concessão.
          // `stock_control` vem junto pelo MESMO motivo que as duas do kit: é
          // ela que diz que o serviço de balcão não sai de prateleira nenhuma.
          //
          // `cost_cents` vem junto por outro motivo, e ele é o do GAP-V28: o
          // custo é FOTOGRAFADO na linha da venda. Lê-lo depois, do cadastro,
          // devolveria o custo de agosto para a venda de março — e o DRE
          // recusava ter CMV justamente por isso. É o mesmo padrão do
          // `price_table_percent_off` gravado na venda logo abaixo: retrato do
          // momento, não releitura.
          //
          // O tamanho de um modelo INATIVO também é recusado (`modeloAtivo`): a
          // variante tem `active` próprio, e arquivar o modelo não o reescreve.
          //
          // `weighable` e `unit` vêm junto porque decidem se a quantidade pode
          // ser quebrada (E-venda-servidor-13).
          //
          // Os três mínimos vêm junto porque decidem o PISO da linha
          // (A-produto-17, `pisoDoPreco`).
          `SELECT p.id, p.name, p.price_cents, p.cost_cents, p.category, p.is_kit,
                  p.kit_explode_on_sale, p.open_price, p.stock_control, p.weighable, p.unit,
                  p.min_price_cents, p.min_markup_percent, p.min_margin_percent
             FROM core_products p
            WHERE p.id = ? AND p.company_id = ? AND p.active = 1 AND ${modeloAtivo('p')}`,
        )
        .get(item.productId, input.companyId) as
        | {
            id: string;
            name: string;
            price_cents: number;
            cost_cents?: number | null;
            category: string | null;
            open_price?: number;
            stock_control?: number;
            weighable?: number | null;
            unit?: string | null;
            min_price_cents?: number | null;
            min_markup_percent?: number | null;
            min_margin_percent?: number | null;
          }
        | undefined;
      if (!product) {
        /*
          O PRODUTO INATIVADO DIZ O NOME (G-offline-sync-09).

          O DEFEITO: a recusa era `Produto não encontrado: 3f2a…` — um UUID, sem
          nome e sem `details`. No balcão, com doze linhas no carrinho, o caixa
          não sabia qual tirar; em Regularizar, todo "Relançar" devolvia o mesmo
          UUID. O código continua o mesmo (quem já trata 404 não quebra); o que
          muda é que a pessoa lê QUAL produto, e a tela recebe `productId`,
          `name` e `inativo` para marcar a linha.
        */
        const cadastro = db
          .prepare('SELECT id, name, active FROM core_products WHERE id = ? AND company_id = ?')
          .get(item.productId, input.companyId) as
          | { id: string; name: string; active: number }
          | undefined;
        if (cadastro) {
          throw new ApiError(
            'CORE_PRODUCT_NOT_FOUND',
            `"${cadastro.name}" não pode mais ser vendido: `
              + (cadastro.active === 1
                ? 'o modelo dele foi arquivado em Produtos. '
                : 'ele foi inativado em Produtos. ')
              + 'Tire a linha do carrinho — ou, se a venda já aconteceu, reative o produto e relance.',
            404,
            { productId: cadastro.id, name: cadastro.name, inativo: true },
          );
        }
        throw new ApiError(
          'CORE_PRODUCT_NOT_FOUND',
          'Produto não encontrado nesta operação — tire a linha do carrinho e bipe o produto de novo.',
          404,
          { productId: String(item.productId ?? '') },
        );
      }
      // Modelo com grade não é item de venda: no balcão, "a camiseta" sem
      // tamanho não existe. Vender o modelo daria baixa num saldo que não é o
      // da peça que saiu da prateleira.
      const isModel = db
        .prepare('SELECT 1 AS n FROM core_products WHERE parent_id = ? LIMIT 1')
        .get(product.id) as { n?: number } | undefined;
      if (isModel?.n) {
        throw new ApiError(
          'CORE_PRODUCT_HAS_VARIANTS',
          `"${product.name}" tem grade. Escolha o tamanho/cor.`,
          400,
          { productId: product.id },
        );
      }
      const quantidade = Number(item.quantity);
      if (!Number.isFinite(quantidade) || !(quantidade > 0)) {
        throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
      }
      /*
        PRODUTO VENDIDO POR UNIDADE NÃO SAI EM PEDAÇO (E-venda-servidor-13 /
        D-pdv-teclado-14).

        O DEFEITO: a única conferência era `quantity > 0`. '0,5*7891234567895'
        no balcão, ou 0.5 pela API, numa camiseta UN virava venda de meia
        camiseta: o saldo ia a 9,5, o cupom e a NFC-e saíam com qCom 0,5 UN, e
        o preço cobrado era metade. Pesável e unidade fracionável (kg, metro,
        litro) continuam aceitando — é o que diz `vendeFracionado`.
      */
      // O teto do balcão (D-pdv-teclado-05) — ver `QUANTIDADE_MAXIMA_DA_LINHA`.
      if (quantidade > QUANTIDADE_MAXIMA_DA_LINHA) {
        throw new ApiError(
          'CORE_INVALID_QUANTITY',
          `"${product.name}": ${String(quantidade).replace('.', ',')} numa linha passa do teto de `
            + '99.999 por item. Isso costuma ser um código de barras lido no campo de quantidade — '
            + 'corrija a quantidade da linha.',
          400,
          { productId: product.id, quantity: quantidade, maximo: QUANTIDADE_MAXIMA_DA_LINHA },
        );
      }
      if (!Number.isInteger(quantidade) && !vendeFracionado(input.companyId, product)) {
        throw new ApiError(
          'CORE_QUANTITY_MUST_BE_INTEGER',
          `"${product.name}" é vendido por unidade (${String(product.unit ?? 'UN').toUpperCase()}): `
            + `a quantidade precisa ser inteira, e veio ${String(quantidade).replace('.', ',')}. `
            + 'Corrija a quantidade da linha.',
          400,
          { productId: product.id, quantity: quantidade },
        );
      }
      /*
        AS CASAS DECIMAIS DA UNIDADE GOVERNAM A QUANTIDADE (A-produto-26).

        O DEFEITO: a conferência acima só perguntava "inteiro ou não". A unidade
        que fraciona passava com QUALQUER número de casas: 1,255 m de uma fita
        cadastrada em M (duas casas) virava linha de 1,255 — o cupom e a NFC-e
        saíam com uma quantidade que a própria unidade da loja diz não existir,
        e o total arredondava um centavo que ninguém cobrou. `core_units.decimals`
        existia, o cadastro já exigia a unidade do vocabulário, e a venda não lia.

        Pesável fica de fora: quem decide as casas é a balança (0,735 kg). A
        unidade que não está no cadastro desta operação também — sem cadastro não
        há regra escrita, e o caso inteiro já passou pela conferência de cima.
      */
      if (product.weighable !== 1) {
        const casas = casasDaUnidade(input.companyId, product.unit);
        if (casas !== null && casas > 0 && !quantidadeValida(quantidade, casas)) {
          const unidade = String(product.unit ?? 'UN').trim().toUpperCase();
          throw new ApiError(
            'CORE_QUANTITY_DECIMALS',
            `"${product.name}" é vendido em ${unidade}, que aceita até ${casas} `
              + `${casas === 1 ? 'casa decimal' : 'casas decimais'}, e veio `
              + `${String(quantidade).replace('.', ',')}. Corrija a quantidade da linha.`,
            400,
            { productId: product.id, unit: unidade, casasAceitas: casas, quantity: quantidade },
          );
        }
      }
      /*
        PREÇO ABERTO: o preço do cadastro é SUGESTÃO, não teto.

        open_price existe desde a rodada de produtos, é escrito pelo cadastro,
        DESLIGA markup e margem no formulário — e a venda nunca o leu. É o
        campo de mão de obra, de serviço e do que se combina no balcão: o valor
        nasce na conversa, não na tabela.

        Duas consequências, e as duas são deste trecho:

        1. NÃO HÁ TETO. Aplicar Math.min aqui seria pior que inútil: produto de
           preço aberto costuma ter price_cents ZERO no cadastro, e o teto zero
           fazia toda mão de obra ser vendida por R$ 0,00 — o valor digitado
           pelo atendente era silenciosamente jogado fora.

        2. NÃO HÁ CONCESSÃO NA DIFERENÇA. O bruto da linha passa a ser o que
           foi COBRADO. Medir "abaixo do vigente" num preço que é sugestão
           faria a oficina pedir gestor em toda OS que fechasse por menos que a
           sugestão — e como a sugestão em geral é zero, qualquer valor cobrado
           viraria concessão negativa, ou pior, ruído no denominador.

        O desconto explícito da linha continua contando como concessão nos dois
        casos: ali alguém digitou "estou abrindo mão de tanto", e isso é uma
        concessão em qualquer preço.

        E É O MESMO CAMPO QUE TIRA A LINHA DA TABELA DE PREÇO. Mão de obra não
        entra em desconto de atacado: o valor foi combinado na conversa, e
        aplicar -15% sobre um cadastro que vale zero devolveria zero. A decisão
        desce para `effectivePriceCents` em vez de ser tomada aqui, porque a
        tela precisa tomar a MESMA decisão para não reprecificar a linha quando
        o cliente for escolhido — e duas decisões iguais escritas em dois
        lugares divergem na primeira manutenção.
      */
      const precoAberto = product.open_price === 1;

      const vigente = effectivePriceCents(
        input.companyId,
        product.id,
        product.price_cents,
        product.category,
        {
          priceTableId: tabelaDoCliente?.id ?? null,
          openPrice: precoAberto,
          // A quantidade da LINHA, que é como a faixa é oferecida e conferida.
          quantidade,
          faixas: faixasDaEmpresa,
        },
      );
      const { priceCents } = vigente;

      /*
        O QUE VEIO DA TELA TEM DE SER NÚMERO, e isto é conferido ANTES de
        qualquer conta.

        unitPriceCents e discountCents chegam do corpo da requisição sem
        passar por validação nenhuma. Um valor que não é número vira NaN, e
        NaN atravessa TODAS as travas deste arquivo sem acionar uma só:
        NaN <= 0 é false, NaN < 0 é false, NaN > limite é false. O resultado
        seria uma venda com total NaN gravada no banco e uma alçada que
        aprovaria qualquer coisa — a trava falhando ABERTA, que é o modo de
        falha que esta rodada inteira existe para eliminar.

        Ausente continua sendo legítimo: significa "usa o preço vigente".
      */
      const numeroDaTela = (valor: unknown, campo: string): number | null => {
        if (valor === undefined || valor === null) return null;
        const n = Number(valor);
        if (!Number.isFinite(n)) {
          throw new ApiError(
            'CORE_INVALID_LINE_VALUE',
            `Valor inválido em "${product.name}": ${campo} precisa ser um número.`,
            400,
            { productId: product.id, campo },
          );
        }
        return Math.round(n);
      };

      const precoInformado = numeroDaTela(item.unitPriceCents, 'preço unitário');

      /**
       * O PREÇO VIGENTE É O TETO (para produto de preço fechado).
       *
       * Antes era `item.unitPriceCents ?? priceCents`: o valor vindo da tela
       * ganhava sempre, e a promoção era ignorada. Na prática a vitrine
       * anunciava a Jaqueta por R$ 246,75 e o balcão cobrava R$ 329,00 — o
       * cliente pagava R$ 82,25 a mais do que viu no site.
       *
       * Vender por MENOS continua possível: desconto é do balcão, fica
       * registrado na venda e passa por autorização quando é grande. O que não
       * pode é cobrar mais do que a loja anunciou. Acréscimo legítimo existe
       * em `surchargeCents`, no nível da venda, onde fica visível.
       */
      const unit = precoAberto
        ? Math.max(0, precoInformado ?? priceCents)
        : Math.min(precoInformado ?? priceCents, priceCents);

      /*
        VENDER POR ZERO NÃO É DECISÃO DE NINGUÉM.

        Uma nota de entrada cria dezenas de produtos de uma vez, e eles nascem
        com preço zero até alguém precificar — na Gringa, uma nota criou 200
        SKUs assim. Sem esta recusa, o primeiro deles a ser bipado no balcão
        sai de graça: a venda fecha, o estoque baixa e a comissão é calculada
        sobre nada. Ninguém revisa uma venda que não deu erro.

        A recusa precisa dizer O QUE FAZER, porque quem está no balcão não tem
        como saber que o produto veio de uma nota e ficou sem preço.

        E O BRINDE? Existia um terceiro caminho, e ele MORRE aqui: cadastrar um
        produto "Brinde" com preço zero e vendê-lo. Ele não sobrevive porque é
        indistinguível, na linha do banco, do produto que a nota criou e
        ninguém precificou — mesma coluna, mesmo zero, intenções opostas.
        Continua existindo, por dois caminhos que permanecem abertos de
        propósito, e os dois deixam rastro:
          - no balcão, brinde é concessão de 100% sobre um preço que EXISTE, e
            passa pela alçada como qualquer outra concessão grande — fica
            registrado quem liberou;
          - na oficina, a OS encerra sem cobrar com has_cost = 0 e um motivo
            declarado (garantia, cortesia_autorizada, retrabalho), e nem chega
            a virar linha de produto aqui.
        Os dois deixam rastro. Preço zero por descuido não deixa nenhum, e é só
        esse que está sendo barrado.
      */
      if (unit <= 0) {
        throw new ApiError(
          'CORE_PRODUCT_WITHOUT_PRICE',
          precoAberto
            ? `"${product.name}" é de preço aberto: digite o valor na linha antes de fechar a venda.`
            : `"${product.name}" está sem preço de venda e por isso não pode ser vendido. `
              + 'Defina o preço em Produtos (ou na Alteração rápida) e bipe de novo. '
              + 'Produto criado por entrada de nota nasce sem preço até alguém precificar.',
          409,
          { productId: product.id, name: product.name, openPrice: precoAberto },
        );
      }

      const discount = numeroDaTela(item.discountCents, 'desconto') ?? 0;
      /*
        DESCONTO NEGATIVO NA LINHA — o mesmo defeito do rodapé (ver o bloco
        grande logo abaixo, no desconto da venda), pelo mesmo campo, um nível
        mais fundo.

        Aqui ele é ainda mais silencioso: a linha do cupom passa a mostrar um
        item cujo total é MAIOR que preço × quantidade, sem nada que explique a
        diferença, e `concedidoItens` entra NEGATIVO na soma da concessão —
        encolhendo o total concedido da venda inteira. Um item com
        `discountCents: -50000` compensa R$ 500,00 de desconto real dado em
        outra linha, e a alçada mede a diferença em vez de medir a concessão.

        A recusa é a mesma, e a saída legítima também: acréscimo é no rodapé da
        venda, onde ele é visível e declaradamente fora da concessão.
      */
      if (discount < 0) {
        throw new ApiError(
          'CORE_INVALID_DISCOUNT',
          `Desconto de "${product.name}" não pode ser negativo (${emReais(discount)}). `
            + 'Para cobrar a mais, use o ACRÉSCIMO da venda — desconto só abate.',
          400,
          { productId: product.id, discountCents: discount },
        );
      }
      const total = Math.round(unit * quantidade) - discount;
      if (total < 0) {
        /*
          A RECUSA NOMEIA A LINHA — o que a vizinha logo acima já fazia.

          `CORE_INVALID_DISCOUNT` sai de dois lugares deste laço, e os dois eram
          desiguais: o desconto NEGATIVO leva `productId` no detalhe, e este
          saía com a frase e mais nada.

          O estrago é no balcão. Sem o nome, a tela do PDV re-deriva a linha
          ofensora com a MESMA aritmética daqui e só a marca quando acha
          EXATAMENTE uma fora do teto; com duas estouradas ao mesmo tempo ela
          desiste — marcar uma por chute mandaria consertar o que não está
          quebrado — e o operador volta a receber uma frase e uma lista de doze
          linhas para conferir, com o cliente na frente.

          Quem sabe qual linha é este laço: ele está com o produto na mão. Dizer
          é uma linha, e o `detail` já é o canal — `discountCents` vai junto
          porque é o número que a tela precisa mostrar para explicar o corte.

          E ele diz TODAS, não a primeira.

          Recusar na primeira devolvia um nome por tentativa: com duas linhas
          estouradas o operador consertava uma, clicava em Finalizar, tomava a
          MESMA frase pela outra e recomeçava — com o cliente na frente, uma
          viagem ao servidor por linha quebrada. A tela chegou a compensar
          re-derivando as outras com a aritmética daqui, mas duas aritméticas
          para o mesmo limite é exatamente como o buraco volta.

          Então o laço ANOTA e segue; a recusa sai uma vez, depois dele, com a
          lista inteira. Nada foi escrito ainda — o `map` só calcula, e o
          primeiro INSERT está muitas linhas abaixo —, então adiar a recusa não
          adia efeito nenhum.
        */
        descontosImpossiveis.push({ productId: product.id, discountCents: discount });
      }

      // O BRUTO DA LINHA — o que a loja cobraria sem abrir mão de nada.
      // Preço fechado: o vigente. Preço aberto: o combinado, que é o vigente
      // daquela linha (ver acima).
      const brutoLinha = Math.round((precoAberto ? unit : priceCents) * quantidade);
      // Quanto se deixou de cobrar por ter baixado o preço unitário. Só existe
      // em preço fechado, e é o terceiro buraco da alçada: aqui nunca houve
      // piso, e uma moto de R$ 12.000 podia sair por R$ 1,00.
      const rebaixado = precoAberto ? 0 : Math.round((priceCents - unit) * quantidade);

      /*
        O PREÇO QUE SUBIU DEPOIS DO BIPE, com nome próprio (G-offline-sync-07).
        Continua dentro de `rebaixado` — e portanto da alçada —, só é contado à
        parte para a origem dizer a verdade. Ver `SaleItemInput.precoNegociado`.
      */
      const rebaixadoDesatualizado =
        !precoAberto && item.precoNegociado === false && rebaixado > 0 ? rebaixado : 0;

      /*
        O PREÇO QUE BAIXOU DEPOIS DO BIPE (E-venda-servidor-11 / G-offline-sync-08).

        O teto de cima (`Math.min`) cobra o vigente de AGORA, então a linha
        informada acima dele fecha por menos que a tela mostrou. Anotado aqui,
        e não recusado: com dinheiro a diferença é só troco. A recusa sai lá
        embaixo, e só onde a venda já seria recusada de qualquer jeito — o
        pagamento eletrônico passando do total —, trocando o "troco só sobre
        dinheiro", que ninguém entende, pela causa com o preço novo de cada linha.
      */
      const precoBaixou =
        !precoAberto && precoInformado !== null && precoInformado > priceCents
          ? {
              productId: product.id,
              name: product.name,
              informadoCents: precoInformado,
              vigenteCents: priceCents,
              fonte: vigente.fonte,
            }
          : null;

      // `unitIds` atravessa a precificação intocado: QUAL peça o caixa
      // escolheu não tem nada a ver com quanto ela custa.
      return {
        product,
        quantity: quantidade,
        unit,
        discount,
        total,
        brutoLinha,
        rebaixado,
        rebaixadoDesatualizado,
        precoBaixou,
        unitIds: item.unitIds,
        // A promoção que deu o preço vigente (GAP-PRD-194): é por ela que o
        // saldo da promoção com teto de unidades é contado nos dois canais.
        promotionId: vigente.promocaoId ?? null,
        // O piso que o dono declarou no produto (A-produto-17) — conferido
        // depois do rodapé, que também abate do que a linha cobra.
        piso: pisoDoPreco(product) as PisoDoPreco | null,
        // O preço de venda de AGORA, quando o preço é fechado: é o teto da
        // linha (`Math.min` acima). A recusa do piso precisa dele para não
        // mandar "cobrar ao menos o piso" quando nem o cadastro chega lá.
        vigenteCents: precoAberto ? null : priceCents,
        // DE ONDE veio o vigente (A-produto-R01): promoção, tabela e faixa são
        // preço da GESTÃO, e o piso não os trata como concessão do balcão.
        fonteDoVigente: vigente.fonte,
        // O nome da tabela, para a recusa dizer de onde o preço veio.
        tabelaDoVigente: vigente.fonte === 'tabela' ? (tabelaDoCliente?.name ?? null) : null,
        // O preço escrito no DOCUMENTO e de onde ele veio, só na conversão
        // (A-produto-R01) — ver `precoDaGestaoQueAcabou` na conta do piso.
        precoDoDocumento:
          item.fonteNoDocumento && precoInformado !== null
            ? { fonte: String(item.fonteNoDocumento), precoCents: precoInformado }
            : null,
      };
    });

    /*
      A RECUSA SAI AQUI, UMA VEZ, COM TODAS AS LINHAS.

      `productIds` é a lista; `productId` continua sendo a primeira, para o
      cliente HTTP que só sabia ler o campo antigo não quebrar. `discountCents`
      idem — é o número da primeira, e a lista traz o de cada uma.
    */
    if (descontosImpossiveis.length > 0) {
      throw new ApiError('CORE_INVALID_DISCOUNT', 'Desconto maior que o valor do item.', 400, {
        productId: descontosImpossiveis[0].productId,
        discountCents: descontosImpossiveis[0].discountCents,
        productIds: descontosImpossiveis.map((d) => d.productId),
        linhas: descontosImpossiveis,
      });
    }

    const subtotal = priced.reduce((acc, i) => acc + i.total, 0) + totalSemBaixa;
    // Mesmo motivo das linhas: desconto de rodapé que não é número vira NaN, e
    // NaN passa por toda trava desta função sem acionar nenhuma. Ele é a maior
    // das três parcelas da concessão — deixá-lo entrar como NaN zeraria a
    // alçada inteira.
    const saleDiscount = Math.round(Number(input.discountCents ?? 0));
    const surcharge = Math.round(Number(input.surchargeCents ?? 0));
    if (!Number.isFinite(saleDiscount) || !Number.isFinite(surcharge)) {
      throw new ApiError(
        'CORE_INVALID_LINE_VALUE',
        'Desconto e acréscimo da venda precisam ser números.',
        400,
      );
    }

    /*
      ACRÉSCIMO NEGATIVO É DESCONTO COM OUTRO NOME — e era o quarto caminho da
      concessão, o único que a alçada nem tentava olhar.

      A conta é `total = subtotal - desconto + acréscimo`, e `surchargeCents`
      entrava sem checagem de sinal nenhuma. Um acréscimo de -R$ 11.999,00 numa
      moto de R$ 12.000,00 derrubava o total para R$ 1,00 exatamente como o
      desconto derrubaria — com uma diferença decisiva: o acréscimo está
      declaradamente FORA da concessão (ver o bloco da concessão logo abaixo, e
      o motivo é bom: acréscimo é juros de cartão e frete, e inflar o bruto com
      ele deixaria dar mais desconto quanto mais juros se cobra). Fora da
      concessão e capaz de zerar o total: a alçada media três caminhos e o
      quarto passava inteiro, sem gestor e sem rastro.

      Recusar é melhor que somar o negativo à concessão, por dois motivos. O
      primeiro é de balcão: quem digitou acréscimo negativo quis dar desconto, e
      há um campo para isso — a mensagem manda a pessoa usá-lo, e ali o valor
      passa pela alçada, que é o ponto. O segundo é de código: um único
      significado por campo. Campo que ora acrescenta ora desconta é o tipo de
      ambiguidade que reabre este mesmo buraco na próxima rodada, por outra
      porta.
    */
    if (surcharge < 0) {
      throw new ApiError(
        'CORE_INVALID_SURCHARGE',
        `Acréscimo não pode ser negativo (${emReais(surcharge)}). `
          + 'Se a intenção é abater do total, lance como DESCONTO — é o desconto que passa '
          + 'pela alçada e fica registrado.',
        400,
        { surchargeCents: surcharge },
      );
    }

    /*
      DESCONTO NEGATIVO É ACRÉSCIMO COM OUTRO NOME — o espelho exato do bloco
      acima, e o campo irmão tinha a trava que este não tinha.

      MEDIDO, contra banco de teste: venda da moto de R$ 12.000,00 com
      `discountCents: -100000`. Passou. Gravou `discount_cents = -100000`,
      `total_cents = 1300000` — MAIS que o bruto — e a concessão saiu com
      `percentual: -8.33`.

      Repare que isto NÃO é evasão de alçada: a identidade
      `total = bruto - concedido + acréscimo` continua fechando, e um percentual
      negativo nunca ultrapassa limite nenhum. O estrago é de DADO, e por isso
      mesmo é mais difícil de ver:

        - o cupom e a nota fiscal saem com um desconto negativo impresso, que é
          uma frase que não significa nada para quem lê ("desconto: -R$ 1.000");
        - o total cobrado é maior que o bruto sem que nenhuma linha diga de onde
          veio a diferença — o acréscimo, que é o campo criado exatamente para
          essa diferença e que a nota sabe imprimir, fica zerado;
        - e o percentual negativo VIAJA: vai para a auditoria da venda, para o
          detalhe da conversão de documento e para a faixa de concessão do PDV,
          que passa a mostrar concessão negativa numa tela de balcão.

      A decisão é a mesma do acréscimo, pelo mesmo argumento de UM SIGNIFICADO
      POR CAMPO (está escrito por extenso logo acima, e vale palavra por palavra
      trocando os dois campos de lugar): quem digitou desconto negativo quis
      cobrar a mais, e existe campo para isso. Somar o negativo ao acréscimo
      "para ajudar" seria pior — o campo passaria a ora abater ora somar, que é
      a ambiguidade que reabre o buraco na rodada seguinte por outra porta.
    */
    if (saleDiscount < 0) {
      throw new ApiError(
        'CORE_INVALID_DISCOUNT',
        `Desconto não pode ser negativo (${emReais(saleDiscount)}). `
          + 'Se a intenção é cobrar a mais, lance como ACRÉSCIMO — é ele que aparece '
          + 'separado no cupom e na nota.',
        400,
        { discountCents: saleDiscount },
      );
    }

    const total = subtotal - saleDiscount + surcharge;
    if (total < 0) {
      throw new ApiError('CORE_INVALID_DISCOUNT', 'Desconto maior que o total da venda.', 400);
    }

    /*
      A CONCESSÃO — a conta que fecha os três buracos da alçada de uma vez.

      Ela mora AQUI, e não na rota, porque é aqui que o preço vigente de cada
      linha existe. Na rota só havia o corpo da requisição, e por isso a
      checagem antiga só enxergava um dos três caminhos e ainda confiava no
      cliente para o denominador.

      O SERVIÇO ENTRA NO BRUTO. Mão de obra de OS não tem preço de tabela —
      ela é negociada como o preço aberto —, mas é dinheiro que a loja está
      cobrando nesta venda. Deixá-la fora encolheria o denominador e faria um
      desconto pequeno numa venda grande de serviço parecer enorme: uma OS de
      R$ 2.000 com R$ 50 de desconto numa peça de R$ 100 acusaria 50% de
      concessão e pararia o balcão.

      O ACRÉSCIMO NÃO ENTRA. surchargeCents é juros de parcelamento e frete:
      inflar o bruto com ele deixaria dar mais desconto quanto mais juros se
      cobra do cliente — a conta andaria para o lado errado.
    */
    const concedidoItens = priced.reduce((acc, l) => acc + l.discount, 0);
    const concedidoRebaixa = priced.reduce((acc, l) => acc + l.rebaixado, 0);
    const concedidoDesatualizado = priced.reduce((acc, l) => acc + l.rebaixadoDesatualizado, 0);
    const bruto = priced.reduce((acc, l) => acc + l.brutoLinha, 0) + totalSemBaixa;
    const concedido = saleDiscount + concedidoItens + concedidoRebaixa;
    const concessao: Concessao = {
      brutoCents: bruto,
      concedidoCents: concedido,
      // A conta mora em AuthorizationService, e não aqui, porque é a MESMA que
      // a liberação do gestor compara: duas cópias que divergem no
      // arredondamento fazem a trava recusar venda liberada.
      percentual: percentualDaConcessao(bruto, concedido),
      origens: {
        cabecalho: saleDiscount,
        itens: concedidoItens,
        // O rebaixado DIGITADO; o que só envelheceu na tela vai ao lado.
        precoRebaixado: concedidoRebaixa - concedidoDesatualizado,
        ...(concedidoDesatualizado > 0 ? { precoDesatualizado: concedidoDesatualizado } : {}),
      },
    };

    /*
      O ID DA VENDA NASCE AQUI, antes de qualquer coisa ser gravada.

      Ele subiu de lugar por causa do consumo da liberação: a autorização do
      gestor passa a ser VINCULADA ao documento que a gastou, e para vincular é
      preciso ter o id. Sortear o UUID mais cedo não custa nada e não reserva
      nada — se a venda falhar depois, o id simplesmente não vira linha.
    */
    const saleId = randomUUID();
    /*
      DOIS RELÓGIOS, de propósito (G-offline-sync-14). `agora` é quando o
      servidor recebeu o pedido — é por ele que a liberação do gestor vence e é
      gasta. A hora do FATO (`now`, lá embaixo) só se sabe depois de resolvida a
      gaveta: é a de agora, ou a da venda guardada quando ela passa por
      `horaDaVendaGuardada`.
    */
    const agora = new Date().toISOString();

    /*
      A TRAVA, e a mensagem que ela precisa dar.

      Só roda quando a rota disse QUEM está no balcão (ver CreateSaleInput.
      alcada). A liberação do gestor é conferida aqui dentro, na mesma
      transação da venda: a rota conferia antes e por fora, e uma checagem que
      mora longe do fato é uma checagem que a próxima chamada esquece.

      E agora ela é GASTA, não só consultada. O que existia era um SELECT de
      existência: a liberação valia para sempre, para qualquer valor e para
      qualquer venda seguinte. `consumirLiberacaoDeConcessao` a vincula a ESTA
      venda, carimba a hora, confere se ela cobre ESTA concessão e recusa a
      segunda tentativa — tudo na transação da venda, de modo que uma venda que
      falhe depois devolva a liberação intacta.
    */
    /*
      O PISO DE PREÇO DO PRODUTO TAMBÉM CHAMA O GESTOR (A-produto-17).

      O DEFEITO: a alçada media só o PERCENTUAL concedido sobre a venda inteira.
      Uma camiseta de R$ 26,00 com piso declarado de R$ 25,00 saía a R$ 23,92 —
      8%, dentro dos 10% do operador — e o mínimo que o dono escreveu no produto
      nunca era consultado. Ver `pisoDoPreco`.

      O que se compara é o que a linha de fato COBRA por unidade: o preço, menos
      o desconto da linha, menos a parte dela no desconto do rodapé (pela
      proporção da linha no subtotal, a mesma régua da devolução). O rodapé entra
      porque abate do mesmo jeito: 10% no rodapé sobre um produto no piso deixa
      o produto abaixo do piso tanto quanto 10% digitados na linha.

      A PORTA É A MESMA DA CONCESSÃO — mesmo código de recusa, mesma liberação
      (`consumirLiberacaoDeConcessao`), gasta uma vez nesta venda. Quem tem
      alçada não pede a si mesmo; e, como a concessão, o piso só é barrado onde
      a rota disse quem está no balcão (`input.alcada`): a conversão de
      documento repassa um preço que já foi conferido quando foi escrito.
    */
    /*
      O PREÇO QUE A GESTÃO DEFINIU NÃO É CONCESSÃO DO BALCÃO (A-produto-R01).

      O DEFEITO: a conta abaixo comparava o que a linha cobra com o piso sem
      separar o que veio da GESTÃO do que o operador concedeu. O vigente é o de
      `effectivePriceCents` — promoção, tabela do cliente, faixa por quantidade
      —, e nenhum deles olha o piso quando é criado. Perfume de R$ 29,90 com piso
      de R$ 25,00 e promoção do gerente a R$ 23,92: o caixa bipava SEM desconto
      nenhum e tomava 403, e a recusa culpava "o próprio preço de venda do
      cadastro, R$ 23,92" e mandava corrigir em Produtos — onde o preço estava
      em R$ 29,90. A etiqueta "de/por" estava na prateleira e cada venda do item
      em promoção exigia o gerente: a promoção deixava de funcionar no caixa.

      Agora, quando o vigente vem da gestão e fica abaixo do piso, o mínimo SEM
      liberação daquela linha é o próprio vigente: o balcão cobra o preço
      anunciado sem chamar ninguém, e qualquer rebaixa ALÉM dele — desconto na
      linha ou no rodapé — continua pedindo gestor, porque desce ainda mais
      abaixo do piso que o dono escreveu. O preço do CADASTRO abaixo do piso
      segue como era (a recusa aponta Produtos): ali não há decisão de gestão
      separada do próprio cadastro que o piso deveria respeitar.
    */
    /*
      A PROMOÇÃO QUE DAVA O PREÇO DO DOCUMENTO E JÁ ACABOU (A-produto-R01).

      O DEFEITO: o caixa escreve a pré-venda pelo preço da promoção, abaixo do
      piso — sem liberação, porque o preço é da gestão (a regra logo abaixo). A
      promoção acaba antes da conversão; esta venda corta a linha no preço do
      documento, o piso volta a valer inteiro e o caixa é recusado. O bloqueio
      está certo (a promoção não existe mais), mas a frase dizia que o
      documento "foi escrito abaixo do piso sem liberação" — e ele foi escrito
      certo, pelo preço que a gestão tinha definido. A causa real, a promoção
      que acabou, não aparecia em lugar nenhum.

      O CONSERTO: a conversão passa a fonte gravada na linha do documento
      (`SaleItemInput.fonteNoDocumento`, de `core_quote_items.price_source`).
      Quando ela é promoção, tabela ou faixa, o preço do documento está abaixo
      do piso e esse preço da gestão não vale mais agora — nenhum preço da
      gestão abaixo do piso cobre a linha, ou o que cobre é maior que o do
      documento —, a linha ganha `precoDaGestaoQueAcabou` e a recusa diz qual
      preço acabou. Não muda QUEM é barrado nem o que libera: só a frase. Só a
      conversão (sem `alcada`) monta o campo, e a linha cortada no CADASTRO
      abaixo do piso segue com a frase de Produtos.
    */
    const gestaoQueDavaOPreco = new Map<string, string>([
      ['promocao', 'a promoção'],
      ['tabela', 'a tabela de preço do cliente'],
      ['faixa', 'a faixa de preço por quantidade'],
    ]);
    const abaixoDoPiso = priced.flatMap((l) => {
      if (!l.piso) return [];
      const precoDaGestaoAbaixo =
        l.vigenteCents !== null
        && l.fonteDoVigente !== 'cadastro'
        && l.vigenteCents < l.piso.pisoCents;
      const minimoSemLiberacao = precoDaGestaoAbaixo ? (l.vigenteCents as number) : l.piso.pisoCents;
      const parcelaDoRodape = subtotal > 0 ? Math.round((saleDiscount * l.total) / subtotal) : 0;
      const cobrado = l.total - parcelaDoRodape;
      if (cobrado >= Math.round(minimoSemLiberacao * l.quantity)) return [];
      // O preço do CADASTRO já abaixo do piso (salvo com a confirmação da tela
      // de produto, ou o custo que subiu numa entrada de nota): o balcão não
      // cobra acima do vigente, então "cobre ao menos o piso" é impossível.
      // Só quando o vigente É o cadastro — o preço da gestão tem campo próprio.
      const cadastroAbaixo =
        l.vigenteCents !== null
        && l.fonteDoVigente === 'cadastro'
        && l.vigenteCents < l.piso.pisoCents;
      // A promoção, a tabela ou a faixa do DOCUMENTO que já acabou — ver o
      // bloco acima de `gestaoQueDavaOPreco`.
      const doDocumento = l.precoDoDocumento;
      const origemQueAcabou = doDocumento ? gestaoQueDavaOPreco.get(doDocumento.fonte) : undefined;
      const precoDaGestaoQueAcabou =
        !input.alcada
        && doDocumento
        && origemQueAcabou !== undefined
        && !cadastroAbaixo
        && doDocumento.precoCents < l.piso.pisoCents
        && !(precoDaGestaoAbaixo && doDocumento.precoCents >= (l.vigenteCents as number))
          ? { fonte: doDocumento.fonte, precoCents: doDocumento.precoCents, origem: origemQueAcabou }
          : null;
      return [
        {
          productId: l.product.id,
          name: l.product.name,
          unitarioCobradoCents: Math.round(cobrado / l.quantity),
          pisoCents: l.piso.pisoCents,
          regra: l.piso.regra,
          precoDoCadastroCents: cadastroAbaixo ? l.vigenteCents : null,
          // A promoção, a tabela ou a faixa que já fixa um preço abaixo do
          // piso: é o mínimo sem liberação da linha, e a recusa diz o nome dela.
          precoDaGestao: precoDaGestaoAbaixo
            ? {
                fonte: l.fonteDoVigente,
                precoCents: l.vigenteCents as number,
                origem: origemDoPrecoDaGestao(input.companyId, {
                  fonte: l.fonteDoVigente,
                  promotionId: l.promotionId,
                  tabela: l.tabelaDoVigente,
                }),
              }
            : null,
          // A promoção, a tabela ou a faixa que dava o preço do DOCUMENTO e já
          // acabou (A-produto-R01): a recusa da conversão diz isso, e não que o
          // documento foi escrito abaixo do piso.
          precoDaGestaoQueAcabou,
        },
      ];
    });
    /*
      O LIMITE DE QUEM ESTÁ NO BALCÃO — por perfil, em % e em R$, na venda e em
      cada linha (P0 da Preço Justo).

      O DEFEITO: a pergunta era uma só — `discountNeedsAuthorization(bruto,
      concedido, perfis, limiteDaOperacao)` —, com um percentual igual para a
      operação inteira, sem teto em valor, sem teto por linha, e quem tinha
      perfil de gerente não tinha teto nenhum. 60% numa linha barata cabiam
      dentro dos 10% de uma venda grande; R$ 1.200 de desconto numa moto cabiam
      nos 10% dela.

      Agora a medida é a da venda inteira E a de cada linha, contra os tetos do
      perfil de quem está no balcão (`limiteDaAlcada`). Operação que não
      configurou limite por perfil mede exatamente como antes. A linha mede o
      que ELA concede (desconto + preço rebaixado); o rodapé entra só no teto da
      venda, somado às linhas — item dentro e rodapé dentro podem, juntos,
      passar do teto da venda, e aí passam pela alçada.
    */
    const limiteDaVenda = input.alcada ? limiteDaAlcada(input.companyId, input.alcada) : null;
    const medidaDaConcessao: MedidaDaConcessao = {
      brutoCents: bruto,
      concedidoCents: concedido,
      linhas: priced.map((l) => ({
        productId: l.product.id,
        nome: l.product.name,
        brutoCents: l.brutoLinha,
        concedidoCents: l.discount + l.rebaixado,
      })),
    };
    const excessos = limiteDaVenda ? excessosDaConcessao(limiteDaVenda, medidaDaConcessao) : [];
    const precisaPelaConcessao = excessos.length > 0;
    /** A liberação GASTA nesta venda — lida da linha gravada, para a trilha. */
    let liberacaoDaVenda: TrilhaDaAlcada['liberacao'] = null;
    /*
      QUEM RESPONDE PELO PISO: a alçada do balcão, ou — na conversão de
      documento, que não passa `alcada` — a de quem está convertendo
      (A-produto-17#orcamento). Ver `CreateSaleInput.alcadaDoPiso`.
    */
    const alcadaDoPiso = input.alcada ?? input.alcadaDoPiso;
    const soPeloPisoDoDocumento = !input.alcada && Boolean(input.alcadaDoPiso);
    const precisaPeloPiso = Boolean(
      alcadaDoPiso && abaixoDoPiso.length > 0 && !temAlcadaParaLiberar(alcadaDoPiso.profileCodes),
    );

    if (alcadaDoPiso && (precisaPelaConcessao || precisaPeloPiso)) {
      const autorizacao = alcadaDoPiso.authorizationId
        ? consumirLiberacaoDeConcessao({
            companyId: input.companyId,
            authorizationId: alcadaDoPiso.authorizationId,
            requestedBy: input.userId,
            concedidoCents: concedido,
            // O bruto desta venda desce junto: é ele que diz se a concessão
            // liberada pelo gestor ainda é o mesmo PERCENTUAL depois de o
            // carrinho ter mudado.
            brutoCents: bruto,
            refType: 'sale',
            refId: saleId,
            now: agora,
          })
        : null;

      if (autorizacao) {
        /*
          QUEM ASSINOU PRECISA TER ALÇADA PARA ESTA CONCESSÃO (P0 da Preço
          Justo): a senha do gerente limitado a 20% não libera 70% para o caixa.
          Estoura DENTRO da transação, então o consumo acima é desfeito e a
          liberação continua servindo para uma venda menor.
        */
        conferirAlcadaDoAutorizador({
          companyId: input.companyId,
          authorizedBy: autorizacao.authorizedBy,
          medida: medidaDaConcessao,
        });
        liberacaoDaVenda = {
          id: autorizacao.id,
          autorizadoPor: autorizacao.authorizedBy,
          justificativa: autorizacao.justificativa,
        };
      }

      if (!autorizacao) {
        /*
          "Precisa de gestor" sem número manda a pessoa adivinhar o que reduzir
          — e depois desta rodada ela tem TRÊS campos onde mexer, dois dos
          quais ela talvez nem saiba que mexeu. O preço rebaixado é o pior
          deles: quem carregou um orçamento antigo no PDV não digitou desconto
          nenhum, e ainda assim está concedendo, porque o preço da tabela subiu
          desde que o orçamento foi feito. Dizer só "desconto acima do limite"
          para essa pessoa é mandá-la procurar um desconto que ela não deu.
        */
        const de: string[] = [];
        if (concessao.origens.cabecalho > 0) {
          de.push(`${emReais(concessao.origens.cabecalho)} de desconto no rodapé`);
        }
        if (concessao.origens.itens > 0) {
          de.push(`${emReais(concessao.origens.itens)} de desconto nos itens`);
        }
        if (concessao.origens.precoRebaixado > 0) {
          de.push(
            `${emReais(concessao.origens.precoRebaixado)} de preço abaixo do vigente`,
          );
        }
        if ((concessao.origens.precoDesatualizado ?? 0) > 0) {
          de.push(
            `${emReais(concessao.origens.precoDesatualizado ?? 0)} de preço de tela desatualizado `
              + '(o preço subiu depois que o item entrou no carrinho — atualize o carrinho)',
          );
        }

        // O piso diz a linha, o preço cobrado e de qual mínimo veio — "precisa
        // de gestor" sem o produto manda procurar um desconto que talvez nem
        // tenha sido digitado (o preço de cadastro pode estar abaixo do piso).
        //
        // REVISÃO: quando o próprio preço do cadastro está abaixo do piso, a
        // saída "cobre ao menos o piso" não existe — o servidor corta a linha no
        // preço vigente —, e dizê-la mandava o operador digitar um preço que o
        // balcão joga fora. A frase diz o preço do cadastro e aponta Produtos.
        // A-produto-R01: quando o preço abaixo do piso é da GESTÃO (promoção,
        // tabela, faixa), a frase diz QUAL e que esse preço sai sem liberação —
        // não culpa o cadastro, que pode estar bem acima do piso.
        const doPiso = abaixoDoPiso.map(
          (l) =>
            `"${l.name}" sai a ${emReais(l.unitarioCobradoCents)} a unidade, abaixo do piso de `
            + `${emReais(l.pisoCents)} (${l.regra})`
            + (l.precoDoCadastroCents !== null
              ? ` — e o próprio preço de venda do cadastro, ${emReais(l.precoDoCadastroCents)}, `
                + 'já está abaixo desse piso'
              : '')
            + (l.precoDaGestao
              ? ` — ${l.precoDaGestao.origem} já fixa ${emReais(l.precoDaGestao.precoCents)}, `
                + 'abaixo desse piso: esse preço sai sem liberação, mas o desconto do balcão '
                + 'por cima dele, não'
              : ''),
        );
        const cadastroAbaixoDoPiso = abaixoDoPiso.some((l) => l.precoDoCadastroCents !== null);
        const precoDaGestaoNaRecusa = abaixoDoPiso.some((l) => l.precoDaGestao !== null);
        const pisoComumNaRecusa = abaixoDoPiso.some(
          (l) => l.precoDoCadastroCents === null && l.precoDaGestao === null,
        );
        // REVISÃO (A-produto-17#orcamento): na conversão, a linha cortada no
        // preço do cadastro NÃO foi "escrita abaixo do piso" — o documento pode
        // estar no piso e a venda cobrar o cadastro. A frase do documento só
        // vale para a linha que o documento de fato escreveu abaixo.
        //
        // A-produto-R01 (revisão): nem a linha escrita pelo preço de uma
        // promoção, tabela ou faixa que já acabou — o documento foi escrito
        // certo, e a frase dela diz o que acabou (`precoDaGestaoQueAcabou`).
        const escritaAbaixoNoDocumento = abaixoDoPiso.some(
          (l) => l.precoDoCadastroCents === null && l.precoDaGestaoQueAcabou === null,
        );
        const gestaoQueAcabou = abaixoDoPiso.flatMap((l) =>
          l.precoDaGestaoQueAcabou
            ? [
                `"${l.name}": ${l.precoDaGestaoQueAcabou.origem} que dava `
                  + `${emReais(l.precoDaGestaoQueAcabou.precoCents)} quando o documento foi escrito já `
                  + `acabou, e esse preço está abaixo do piso de ${emReais(l.pisoCents)}`,
              ]
            : [],
        );
        /*
          O TETO ULTRAPASSADO É DITO PELO NOME. Quando é o percentual da venda,
          a frase é a de sempre (a tela e o gestor já a conhecem); os tetos
          novos — valor da venda, percentual e valor por linha — vêm depois,
          cada um com a linha e os números. "Do seu perfil" só quando o limite
          veio da tabela de perfis: dizer isso de um limite da operação mandaria
          o operador reclamar com quem não o configurou.
        */
        const excessoDaVenda = excessos.find((e) => e.regra === 'percentual_venda');
        const outrosTetos = excessos.filter((e) => e.regra !== 'percentual_venda').map(fraseDoExcesso);
        const deQuem = limiteDaVenda?.doPerfil ? 'do seu perfil nesta operação' : 'desta operação';
        const mensagem = precisaPelaConcessao
          ? `Esta venda concede ${emReais(concedido)} sobre ${emReais(bruto)} `
            + `(${concessao.percentual}%)`
            + (excessoDaVenda ? `, acima do limite de ${excessoDaVenda.limite}% ${deQuem}. ` : '. ')
            + (outrosTetos.length > 0
              ? `Passa ${excessoDaVenda ? 'também ' : ''}dos tetos ${deQuem}: ${outrosTetos.join('; ')}. `
              : '')
            + (de.length > 0 ? `Vem de ${de.join(', ')}. ` : '')
            + (doPiso.length > 0 ? `Além disso, ${doPiso.join('; ')}. ` : '')
            + 'Peça a liberação de um gestor ou reduza um desses valores.'
          : `${doPiso.join('; ')}. Vender abaixo do piso de preço do produto precisa da `
            + (soPeloPisoDoDocumento
              // Na conversão o preço vem do DOCUMENTO, não do caixa: "cobre ao
              // menos o piso" mandaria o operador procurar um campo que esta
              // tela não tem. A saída é a liberação, ou corrigir o documento —
              // ou o CADASTRO, quando é ele que está abaixo do piso.
              ? 'liberação de um gestor — '
                + (escritaAbaixoNoDocumento
                  ? 'o preço veio do documento, que foi escrito abaixo do piso sem liberação. '
                    + 'Peça a liberação agora, ou corrija o preço no documento antes de converter.'
                    // A-produto-R01 (revisão): a linha da promoção que acabou
                    // diz a própria causa, junto das escritas à mão.
                    + (gestaoQueAcabou.length > 0 ? ` ${gestaoQueAcabou.join('; ')}.` : '')
                    + (cadastroAbaixoDoPiso
                      ? ' Onde o preço de venda do cadastro já está abaixo do piso, corrija-o em '
                        + 'Produtos: a venda não cobra acima dele.'
                      : '')
                  : gestaoQueAcabou.length > 0
                    // A-produto-R01 (revisão): o documento foi escrito certo,
                    // pelo preço da gestão; o que mudou foi a promoção, a
                    // tabela ou a faixa. A saída é a mesma — liberação, ou o
                    // preço do documento atualizado —, mas sem culpar o papel.
                    ? `${gestaoQueAcabou.join('; ')}. `
                      + 'Peça a liberação agora, ou atualize o preço no documento antes de converter.'
                      + (cadastroAbaixoDoPiso
                        ? ' Onde o preço de venda do cadastro já está abaixo do piso, corrija-o em '
                          + 'Produtos: a venda não cobra acima dele.'
                        : '')
                    : 'a venda cobra no máximo o preço de venda do cadastro, que está abaixo do piso. '
                      + 'Peça a liberação agora, ou corrija o preço de venda em Produtos antes de converter.')
              : cadastroAbaixoDoPiso
                ? 'liberação de um gestor — ou o preço de venda precisa ser corrigido em Produtos, '
                  + 'porque o balcão não cobra acima do preço do cadastro.'
                : precoDaGestaoNaRecusa
                  // A saída real é tirar o desconto do balcão: o preço da
                  // promoção, da tabela ou da faixa passa sem ninguém.
                  ? 'liberação de um gestor — ou tire o desconto dado no balcão e cobre o preço da '
                    + 'promoção, da tabela ou da faixa'
                    + (pisoComumNaRecusa ? ' (e ao menos o piso nas demais linhas).' : '.')
                  : 'liberação de um gestor — ou cobre ao menos o piso.');

        throw new ApiError(
          'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
          mensagem,
          403,
          {
            percentual: concessao.percentual,
            concedidoCents: concedido,
            brutoCents: bruto,
            origens: concessao.origens,
            // O percentual que vale para ESTA pessoa; nulo quando o perfil dela
            // não tem teto em percentual (só em valor ou por linha).
            limite: limiteDaVenda ? limiteDaVenda.percentual : politica.discountLimitPercent,
            ...(limiteDaVenda ? { limites: limiteDaVenda } : {}),
            ...(excessos.length > 0 ? { excessos } : {}),
            ...(abaixoDoPiso.length > 0 ? { abaixoDoPiso } : {}),
          },
        );
      }
    }

    // A trilha sai daqui mesmo quando a venda coube no limite: é a venda que
    // PASSOU que o dono revisa depois (ver `TrilhaDaAlcada`).
    const trilhaDaAlcada: TrilhaDaAlcada | null =
      input.alcada || liberacaoDaVenda
        ? {
            aplicadoPor: input.userId,
            limite: limiteDaVenda,
            excessos,
            liberacao: liberacaoDaVenda,
            brutoCents: bruto,
            concedidoCents: concedido,
            percentual: concessao.percentual,
            totalCents: total,
            linhas: medidaDaConcessao.linhas.filter((l) => l.concedidoCents > 0),
          }
        : null;

    // QUEM VENDEU PRECISA SER DA CASA — a conferência mora em
    // `exigirVendedorDaCasa` (topo deste arquivo), porque o DOCUMENTO precisa
    // fazer a MESMA pergunta antes da venda existir. Ver o cabeçalho de lá.
    exigirVendedorDaCasa({
      companyId: input.companyId,
      userId: input.userId,
      sellerId: input.sellerId ?? null,
    });

    /*
      A FORMA DE PAGAMENTO É CONFERIDA NA ENTRADA.

      `method` era string livre — sem enum, sem validação, sem CHECK. Um método
      digitado errado por integração ou por cliente de API entrava no banco em
      silêncio e depois sumia de todo relatório agrupado por forma de
      pagamento: o dinheiro parecia ter evaporado, e o erro só aparecia meses
      depois, quando já não dava para saber qual venda tinha sido.
    */
    // A forma já chegou conferida e canônica (`normalizarPagamentos`, no topo);
    // aqui fica só o valor.
    for (const p of input.payments) {
      if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
        throw new ApiError(
          'CORE_PAYMENT_AMOUNT_INVALID',
          `Valor inválido na forma de pagamento "${p.method}".`,
          400,
        );
      }
    }

    /*
      O CARTÃO PRECISA DA COBRANÇA QUE O AUTORIZOU (GAP-V48).

      A regra "a venda só fecha depois da confirmação da operadora" morava
      inteira no `PagamentoDialog`. Pela API, com a maquininha configurada e
      ligada, uma linha `credito settled` de R$ 150,00 entrava sem que cobrança
      nenhuma tivesse ido ao aparelho — e a venda saía com estoque baixado e
      recebível liquidado contra dinheiro que ninguém passou.

      A conferência mora no serviço de terminal (`assertCardPaymentBackedByTerminal`),
      porque é lá que a tradução estado-do-provedor → estado-do-balcão já
      existe. Aqui fica só a decisão de QUANDO exigir: com maquininha
      configurada nesta operação, e para as linhas de cartão.

      O carimbo do outro lado (a venda gravada na transação) vem depois, quando
      o id da venda já é um fato.
    */
    const linhasDeCartao: { transactionId: string; amountCents: number }[] = [];
    /** Provedor da cobrança, por linha de pagamento — sem reescrever a entrada. */
    const provedorDaLinha = new Map<SalePaymentInput, string>();
    // A maquininha DO CAIXA desta venda (GAP-PRD-014): o Caixa 2 sem PinPad
    // lança cartão à mão mesmo com o PinPad ligado no Caixa 1. Sem caixa na
    // venda, a leitura é a mais estrita — omitir o caixa não afrouxa nada.
    const maquininha = getTerminalStatus(input.companyId, terminalDaVenda);
    if (maquininha.configured) {
      for (const p of input.payments) {
        if (p.method !== 'credito' && p.method !== 'debito') continue;
        const cobranca = assertCardPaymentBackedByTerminal({
          companyId: input.companyId,
          method: p.method,
          amountInCents: p.amountCents,
          transactionId: p.providerRef ?? null,
        });
        // Duas linhas apontando a MESMA cobrança fechariam a venda cobrando uma
        // vez só. O par (linha, cobrança) é conferido antes de qualquer escrita.
        if (linhasDeCartao.some((l) => l.transactionId === cobranca.transactionId)) {
          throw new ApiError(
            'CORE_SALE_TERMINAL_TX_ALREADY_USED',
            'A mesma cobrança da maquininha foi informada em duas linhas desta venda.',
            409,
            { transactionId: cobranca.transactionId },
          );
        }
        linhasDeCartao.push({
          transactionId: cobranca.transactionId,
          amountCents: p.amountCents,
        });
        // O provedor da cobrança viaja para a linha de pagamento: sem ele, a
        // conferência de maquininha teria a referência e não saberia de quem.
        // Guardado num mapa, e não escrito de volta em `input`: reescrever o
        // corpo da requisição faria o serviço devolver ao chamador um objeto
        // diferente do que ele mandou.
        const provedor = p.provider ?? cobranca.provider ?? maquininha.provider;
        if (provedor) provedorDaLinha.set(p, provedor);
      }
    }

    /*
      O PIX DA MAQUININHA TAMBÉM PAGA A VENDA PELA COBRANÇA (GAP-PRD-078).

      O PIX ficava fora do vínculo porque tem dois caminhos, e o de fora do
      aparelho (provedor de cobrança) não tem cobrança de terminal. Só que o
      de DENTRO do aparelho também ficava de fora: a linha chegava com
      `providerRef` apontando a cobrança e ninguém a conferia nem carimbava.
      Consequência dupla: o PIX ainda pendente pagava venda pela API, e todo
      PIX pago na maquininha parecia "sem venda" — impossível separar o que
      pagou uma venda do que o cliente pagou depois de o operador desistir.

      A regra continua sem exigir nada do PIX do provedor de cobrança: só a
      referência que É uma cobrança da maquininha desta empresa passa pela
      mesma conferência do cartão (aprovada, mesmo meio, mesmo valor, ainda
      não gasta) e é carimbada logo abaixo, com a venda.
    */
    for (const p of input.payments) {
      if (p.method !== 'pix' || !p.providerRef) continue;
      if (!ehCobrancaDaMaquininha(input.companyId, p.providerRef)) continue;
      const cobranca = assertCardPaymentBackedByTerminal({
        companyId: input.companyId,
        method: 'pix',
        amountInCents: p.amountCents,
        transactionId: p.providerRef,
      });
      if (linhasDeCartao.some((l) => l.transactionId === cobranca.transactionId)) {
        throw new ApiError(
          'CORE_SALE_TERMINAL_TX_ALREADY_USED',
          'A mesma cobrança da maquininha foi informada em duas linhas desta venda.',
          409,
          { transactionId: cobranca.transactionId },
        );
      }
      linhasDeCartao.push({ transactionId: cobranca.transactionId, amountCents: p.amountCents });
      const provedor = p.provider ?? cobranca.provider;
      if (provedor) provedorDaLinha.set(p, provedor);
    }

    /*
      O CRÉDITO DE LOJA ENTRA AQUI, ANTES DA CONFERÊNCIA DE VALOR (GAP-V10/V47).

      Ele não é pagamento (ver `CreateSaleInput.customerCreditCents`), mas abate
      o que sobra para os meios cobrarem — e por isso precisa estar resolvido
      antes de a venda perguntar "falta quanto?".

      DUAS RECUSAS MORAM AQUI, e as duas são de balcão:

      1. SEM CLIENTE não há saldo de ninguém a gastar. A mensagem manda
         identificar, que é o gesto que resolve.

      2. ACIMA DO TOTAL, o crédito viraria TROCO — dinheiro de gaveta saindo
         contra um vale. Seria a porta dos fundos para transformar crédito de
         loja em espécie, e ela fica fechada com a mesma clareza com que o troco
         de cartão já é recusado. O excedente continua no saldo do cliente, para
         a próxima compra.

      O CONSUMO em si só acontece depois de a venda existir (o resgate é amarrado
      ao id dela) — mais abaixo, na mesma transação.
    */
    const creditoPedido = Math.round(Number(input.customerCreditCents ?? 0));
    if (!Number.isFinite(creditoPedido) || creditoPedido < 0) {
      throw new ApiError(
        'CORE_CREDIT_AMOUNT_INVALID',
        'Crédito do cliente precisa ser um valor em centavos, nunca negativo.',
        400,
      );
    }
    if (creditoPedido > 0 && !input.customerId) {
      throw new ApiError(
        'CORE_CREDIT_CUSTOMER_REQUIRED',
        'Crédito de loja é de um cliente: identifique o cliente na venda para usar o saldo dele.',
        400,
      );
    }
    if (creditoPedido > total) {
      throw new ApiError(
        'CORE_CREDIT_EXCEEDS_TOTAL',
        `O crédito usado (${emReais(creditoPedido)}) passa do total da venda `
          + `(${emReais(total)}). Crédito de loja não vira troco — use no máximo o total, `
          + 'e o que sobrar continua no saldo do cliente.',
        400,
        { creditCents: creditoPedido, total },
      );
    }

    /**
     * O que os MEIOS DE PAGAMENTO ainda precisam cobrir.
     *
     * O crédito já abateu a sua parte, então "falta receber" e "troco" passam a
     * ser medidos contra este número, e não contra o total. É a mesma conta que
     * o balcão faz de cabeça: "são cem, você tem trinta de vale, então setenta".
     */
    const aCobrarNosMeios = total - creditoPedido;

    const paid = input.payments.reduce((acc, p) => acc + p.amountCents, 0);
    /*
      O TROCO SAI DO DINHEIRO QUE ENTROU, e só dele.

      `paid` soma tudo, inclusive o que está `pending` — e isso é proposital
      para a conferência de valor: mercadoria pode sair contra um PIX
      aguardando confirmação, que é decisão de negócio.

      O TROCO é outra coisa. Calculá-lo sobre `paid` deixava o caixa devolver
      dinheiro contra promessa: R$ 50 em espécie mais um PIX pendente de R$ 30,
      numa compra de R$ 50, liberava R$ 30 de troco. A gaveta ficava com R$ 20
      numa venda de R$ 50, e se o PIX não caísse a loja tinha perdido os R$ 30.

      Por isso o troco vem do que está LIQUIDADO, e o dinheiro em espécie que
      banca o troco também precisa estar liquidado.
    */
    const settledPaid = input.payments
      .filter((p) => (p.status ?? 'settled') === 'settled')
      .reduce((acc, p) => acc + p.amountCents, 0);
    const cashTendered = input.payments
      .filter((p) => isCashMethod(p.method) && (p.status ?? 'settled') === 'settled')
      .reduce((acc, p) => acc + p.amountCents, 0);
    // Contra o que sobrou para os meios, e não contra o total: senão a venda
    // paga inteira com vale devolveria em espécie o que o cliente pagou em
    // dinheiro por engano — e, pior, uma venda coberta pelo crédito acusaria
    // troco do tamanho do crédito.
    const change = Math.max(0, settledPaid - aCobrarNosMeios);

    /*
      VENDA SEM PAGAMENTO NENHUM É VENDA FIADA, e precisa ter dono.

      Com `payments` vazio, todo o bloco de conferência abaixo era pulado: a
      venda era gravada como completa, o estoque baixava e nascia um recebível
      em aberto vencendo no MESMO dia — com `customer_id` nulo quando ninguém
      identificava o cliente. Dinheiro devido por pessoa nenhuma.

      Não é caso de recusar: faturar OS a prazo e vender fiado são práticas
      reais do balcão. O que se exige é o mínimo para a dívida ser cobrável —
      saber de quem ela é.
    */
    if (input.payments.length === 0 && aCobrarNosMeios > 0 && !input.customerId) {
      throw new ApiError(
        'CORE_SALE_WITHOUT_PAYER',
        'Venda sem pagamento fica como conta a receber. Identifique o cliente para saber de quem cobrar.',
        400,
        { total },
      );
    }

    if (input.payments.length > 0) {
      if (paid < aCobrarNosMeios) {
        throw new ApiError(
          'CORE_PAYMENT_MISMATCH',
          // Em reais, como todo o resto do arquivo (E-venda-servidor-15): era
          // `toFixed(2)`, e o caixa lia "Falta 12.50", sem R$ e com ponto.
          `Falta ${emReais(aCobrarNosMeios - paid)} para fechar a venda.`,
          400,
          {
            expected: aCobrarNosMeios,
            received: paid,
            missing: aCobrarNosMeios - paid,
            creditCents: creditoPedido,
          },
        );
      }
      // Só dinheiro admite receber a mais: não existe troco de cartão nem de
      // PIX. Aceitar sobra em meio eletrônico esconderia erro de digitação.
      if (change > 0 && change > cashTendered) {
        // A sobra veio de PREÇO QUE BAIXOU depois do bipe: a causa é essa, e é
        // ela que a recusa diz, com o preço novo de cada linha (E-venda-servidor-11).
        const baixaram = priced
          .map((l) => l.precoBaixou)
          .filter((b): b is NonNullable<typeof b> => b !== null);
        if (baixaram.length > 0) {
          const frases = baixaram.map(
            (b) =>
              `"${b.name}" ${porQueOPrecoBaixou(b.fonte)}: de ${emReais(b.informadoCents)} `
              + `para ${emReais(b.vigenteCents)}`,
          );
          throw new ApiError(
            'CORE_SALE_TOTAL_CHANGED',
            `O preço mudou depois que o item entrou no carrinho — ${frases.join('; ')}. `
              + `A venda agora fecha em ${emReais(aCobrarNosMeios)}, e o pagamento informado `
              + `(${emReais(settledPaid)}) passa disso sem ser em dinheiro. Atualize o carrinho e `
              + 'cobre o valor novo — se o cartão já foi passado, estorne a diferença no aparelho.',
            409,
            {
              totalCents: total,
              aCobrarCents: aCobrarNosMeios,
              recebidoCents: settledPaid,
              diferencaCents: change - cashTendered,
              linhas: baixaram,
            },
          );
        }
        throw new ApiError(
          'CORE_CHANGE_NOT_CASH',
          'Troco só é possível sobre o valor recebido em dinheiro.',
          400,
          { change, cashTendered },
        );
      }

      /*
        OS TETOS DO PAGAMENTO NO SERVIDOR (D-pdv-teclado-M03).

        O DEFEITO: o `PagamentoDialog` recusava antes, e a API aceitava. Duas
        portas ficavam abertas para quem não passa pela tela (integração, fila
        offline de um PDV antigo, cliente HTTP qualquer):

          - CARTÃO E PIX ACIMA DO QUE FALTA. A trava de troco logo acima mede
            só o LIQUIDADO; o PIX pendente não entra nela. Um PIX "aguardando"
            de R$ 150 numa venda de R$ 100 fechava a venda — e o título ficava
            esperando uma cobrança maior que a dívida. Não existe troco de
            cartão nem de PIX, pendente ou não.
          - SOMA ABSURDA. Um código de barras no campo de valor em dinheiro
            virava R$ 7.891.234.567.895,00 com troco do mesmo tamanho, gravado
            na venda e na NFC-e. O teto é cem vezes o que falta receber, com a
            folga de R$ 1.000 acima dele para a nota grande no item pequeno (a
            mesma folga da tela: a nota de R$ 100 para a bala de R$ 0,50 continua
            valendo) — o servidor nunca recusa o que a tela deixou passar.

        Depois das recusas de troco de propósito: elas já dizem a causa certa
        para o cartão liquidado a mais (inclusive o preço que baixou).
      */
      const emCartaoOuPix = input.payments
        .filter((p) => !isCashMethod(p.method))
        .reduce((acc, p) => acc + p.amountCents, 0);
      if (emCartaoOuPix > aCobrarNosMeios) {
        throw new ApiError(
          'CORE_PAYMENT_ABOVE_REMAINING',
          `Cartão e PIX somam ${emReais(emCartaoOuPix)}, e a venda cobra ${emReais(aCobrarNosMeios)} `
            + `nos meios de pagamento (total ${emReais(total)}). Cartão e PIX não passam do que falta `
            + 'receber — troco só sai de dinheiro. Corrija o valor lançado.',
          400,
          { emCartaoOuPixCents: emCartaoOuPix, aCobrarCents: aCobrarNosMeios, totalCents: total },
        );
      }
      const tetoDaSoma = Math.max(100 * aCobrarNosMeios, aCobrarNosMeios + 100_000);
      if (paid > tetoDaSoma) {
        throw new ApiError(
          'CORE_PAYMENT_TOO_LARGE',
          `Os pagamentos somam ${emReais(paid)} numa venda de ${emReais(total)} `
            + `(a receber nos meios: ${emReais(aCobrarNosMeios)}) — passa de ${emReais(tetoDaSoma)}, `
            + 'o máximo aceito. Parece um código de barras lido no campo de valor: confira o valor digitado.',
          400,
          { recebidoCents: paid, totalCents: total, aCobrarCents: aCobrarNosMeios, tetoCents: tetoDaSoma },
        );
      }

      /*
        TROCO NÃO SAI CONTRA PIX PENDENTE (E-venda-servidor-07, lado do servidor).

        O DEFEITO: o `PagamentoDialog` já parava a venda quando havia PIX
        pendente e o recebido passava do total, mas a API aceitava o mesmo
        pagamento vindo de outro cliente HTTP ou da fila offline de um PDV
        antigo. Venda de R$ 100,00 com R$ 60,00 de PIX pendente e R$ 50,00 em
        dinheiro fechava com troco ZERO (o troco sai só do liquidado, e os R$ 50
        não passam dos R$ 100) — a gaveta ficava com R$ 50, o título ficava
        esperando R$ 60 de um PIX que cobre só R$ 50 da dívida, e os R$ 10 a
        mais não eram troco de ninguém: ou o dinheiro foi lançado a mais, ou o
        PIX sobrou. Quando o PIX caísse, entravam R$ 10 no banco sem título.

        A regra é a MESMA da tela, uma só: com PIX pendente na conta, o recebido
        não passa do que falta cobrar nos meios. 409 porque o pedido é válido
        em cada linha e só a combinação não fecha — quem resolve é o operador,
        ajustando um dos dois valores. Depois das recusas acima, que dizem a
        causa mais específica (PIX pendente sozinho acima do total, soma
        absurda).
      */
      const pendenteCents = input.payments
        .filter((p) => p.status === 'pending')
        .reduce((acc, p) => acc + p.amountCents, 0);
      if (pendenteCents > 0 && paid > aCobrarNosMeios) {
        const liquidadoForaDoDinheiro = settledPaid - cashTendered;
        const dinheiroQueFecha = Math.max(0, aCobrarNosMeios - pendenteCents - liquidadoForaDoDinheiro);
        throw new ApiError(
          'CORE_CHANGE_WITH_PENDING',
          `O PIX de ${emReais(pendenteCents)} ainda não caiu, e o recebido (${emReais(paid)}) passa `
            + `do que a venda cobra nos meios de pagamento (${emReais(aCobrarNosMeios)}) em `
            + `${emReais(paid - aCobrarNosMeios)}. Troco não sai contra PIX pendente: receba em `
            + `dinheiro só ${emReais(dinheiroQueFecha)}, ou remova o PIX pendente e receba tudo em dinheiro.`,
          409,
          {
            pendenteCents,
            recebidoCents: paid,
            aCobrarCents: aCobrarNosMeios,
            excedenteCents: paid - aCobrarNosMeios,
            dinheiroQueFechaCents: dinheiroQueFecha,
          },
        );
      }
    }

    /*
      DINHEIRO EM ESPÉCIE ENTRA POR UMA GAVETA (GAP-PRD-134).

      A venda em dinheiro sem `cashSessionId` era aceita com o caixa ABERTO e
      nascia sem movimento de gaveta: o fechamento não enxergava aquele
      dinheiro. A regra morava só no PDV, e toda outra porta (a consignação
      faturada, a conversão chamada por outro cliente HTTP) passava por fora.

      Agora quem decide é o servidor, pela mesma régua da devolução e do
      cancelamento (`GavetaDoDinheiro`): a gaveta do caixa do pedido, ou a
      única aberta; nenhuma, ou mais de uma sem caixa no pedido, é recusa
      nomeada — aqui, antes de gravar qualquer linha. Só o que ENTRA NA GAVETA
      conta: espécie não pendente menos o troco, exatamente o que o movimento
      lá embaixo lança.
    */
    const especieNaGaveta =
      input.payments
        .filter((p) => isCashMethod(p.method) && p.status !== 'pending')
        .reduce((acc, p) => acc + p.amountCents, 0) - change;
    /*
      E A VENDA DE BALCÃO SEM DINHEIRO TAMBÉM CAI NUM TURNO
      (E-venda-servidor-08 / H-caixa-seguranca-05).

      O DEFEITO: só a venda com espécie procurava gaveta. Sem `cashSessionId`
      (a consulta da gaveta falhou na entrada do PDV, ou uma integração não
      mandou), a venda no cartão ou no PIX nascia com `cash_session_id` NULO —
      e o fechamento soma "recebido no turno, por meio" por
      `cash_session_id = ?`: a venda existia e sumia da conferência da
      maquininha. Pior: com TODAS as gavetas fechadas, o cartão passava — o
      "caixa fechado bloqueia venda" valia só para dinheiro.

      Agora a venda de balcão resolve a gaveta pela mesma régua da espécie
      (`GavetaDoDinheiro`): a do caixa do pedido, ou a única aberta; nenhuma,
      ou várias sem caixa no pedido, é recusa nomeada. A operação que nunca
      abriu gaveta continua vendendo sem turno, como sempre.
    */
    let gavetaDaVenda: string | null = input.cashSessionId || null;
    if (!gavetaDaVenda && (especieNaGaveta > 0 || input.canal === 'balcao')) {
      let gaveta: ReturnType<typeof gavetaDoDinheiro>;
      try {
        gaveta = gavetaDoDinheiro({
          companyId: input.companyId,
          operacao: 'venda',
          valorCents: especieNaGaveta,
          terminalId: terminalInformado,
          seInformadaFechada: 'recusar',
        });
      } catch (err) {
        // A régua fala de "dinheiro que a venda recebe"; sem espécie, a frase
        // precisa dizer o que de fato está em jogo — o turno da venda.
        if (
          especieNaGaveta <= 0
          && err instanceof ApiError
          && err.code === 'CORE_CASH_SESSION_REQUIRED'
        ) {
          const detalhe = (err.details ?? {}) as { gavetasAbertas?: unknown[]; terminalId?: string };
          throw new ApiError(
            'CORE_CASH_SESSION_REQUIRED',
            Array.isArray(detalhe.gavetasAbertas)
              ? `Há ${detalhe.gavetasAbertas.length} gavetas abertas e a venda não disse de qual caixa `
                + 'ela é. Escolha o caixa deste computador no PDV: a venda no cartão ou no PIX também '
                + 'entra no fechamento do turno.'
              : detalhe.terminalId
                ? 'O caixa deste computador não tem gaveta aberta. Abra o caixa antes de vender: a venda '
                  + 'no cartão ou no PIX também entra no fechamento do turno.'
                : 'Não há caixa aberto agora. Abra o caixa antes de vender: a venda no cartão ou no PIX '
                  + 'também entra no fechamento do turno, e sem turno ela some da conferência da maquininha.',
            409,
            err.details,
          );
        }
        throw err;
      }
      if (gaveta) {
        gavetaDaVenda = gaveta.sessionId;
        terminalDaVenda = terminalInformado ?? gaveta.terminalId;
      }
    }

    /*
      A HORA DO FATO (G-offline-sync-14) — agora que a gaveta é conhecida.

      Tudo o que descreve a venda daqui para baixo usa `now`: `created_at`, a
      competência do título e da comissão, o vencimento do fiado, o dia do
      repasse da operadora, o evento da central. Na venda comum é a hora de
      agora; na guardada offline, a hora dela quando passa pelas conferências
      de `horaDaVendaGuardada`. O estoque tem relógio próprio (`applyMovement`)
      e a nota fiscal também (`new Date()` na emissão): os dois contam quando o
      SISTEMA viu, e não mudam aqui.
    */
    const horaDaVenda =
      input.vendidaEm === undefined || input.vendidaEm === null
        ? null
        : horaDaVendaGuardada({
            vendidaEm: input.vendidaEm,
            aberturaDaGaveta: gavetaDaVenda
              ? ((
                  db
                    .prepare('SELECT opened_at FROM core_cash_sessions WHERE id = ?')
                    .get(gavetaDaVenda) as { opened_at: string | null } | undefined
                )?.opened_at ?? null)
              : null,
            agora,
          });
    const now = horaDaVenda?.instante ?? agora;

    const number = nextSequenceValue(input.companyId, 'sale');

    db.prepare(
      /*
        A FOTOGRAFIA DA TABELA VAI NO INSERT, e não num LEFT JOIN na consulta.

        Nome e percentual, congelados. A alternativa — guardar o id e juntar com
        `core_price_tables` na hora de mostrar a venda — custaria uma coluna a
        menos e faria a venda de março MUDAR DE HISTÓRIA quando alguém editasse
        a tabela em junho: o mesmo cupom, reimpresso, passaria a dizer que o
        cliente teve 5% quando teve 10%. Isso só é descoberto quando alguém
        contesta um valor, e nessa hora não há como saber qual dos dois números
        era o verdadeiro.
      */
      `INSERT INTO core_sales
         (id, company_id, number, terminal_id, cash_session_id, customer_id, seller_id,
          status, subtotal_cents, discount_cents, surcharge_cents, total_cents,
          change_cents, idempotency_key, idempotency_fingerprint, origin, note,
          price_table_name, price_table_percent_off, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      saleId,
      input.companyId,
      number,
      terminalDaVenda,
      gavetaDaVenda,
      input.customerId ?? null,
      input.sellerId ?? input.userId,
      subtotal,
      saleDiscount,
      surcharge,
      total,
      change,
      input.idempotencyKey,
      impressaoDigital,
      input.origin ?? 'pdv',
      input.note ?? null,
      tabelaDoCliente?.name ?? null,
      tabelaDoCliente?.percentOff ?? null,
      now,
    );

    /*
      O CRÉDITO É GASTO AQUI — na MESMA transação, e depois de a venda existir.

      Depois porque o resgate é amarrado ao id DELA: é essa amarra que impede a
      mesma venda de gastar duas vezes (a chave única da razão) e é ela que o
      cancelamento segue para devolver o vale.

      DENTRO da transação porque o saldo e a mercadoria têm de andar juntos. Se
      qualquer coisa abaixo falhar — saldo de estoque, caixa fechado, chave de
      idempotência —, o resgate volta atrás com o resto e o cliente não perde o
      vale por uma venda que não aconteceu.

      A CONCORRÊNCIA se resolve por onde ela sempre se resolveu aqui:
      `withTransaction` abre `BEGIN IMMEDIATE`, então o lock de escrita já está
      tomado desde a primeira linha desta função. A segunda venda simultânea
      espera, lê o saldo JÁ debitado e é recusada por saldo insuficiente — a
      mesma proteção que impede dois caixas de venderem a última peça.
    */
    if (creditoPedido > 0) {
      redeemCredit({
        companyId: input.companyId,
        customerId: input.customerId ?? null,
        amountCents: creditoPedido,
        saleId,
        description: `Venda #${number}`,
        userId: input.userId,
      });
    }

    /*
      O RASTRO DO ITEM CANCELADO — GAP-V52/V63.

      Antes deste bloco, remover uma linha do carrinho era invisível: o rodapé
      do PDV mostrava um "0" literal e nenhuma tabela guardava o que saiu. O
      retrato viaja no corpo e é gravado AQUI, na mesma transação da venda —
      se a venda falhar, o rastro dela some junto, porque rastro de venda que
      não aconteceu seria acusação sem fato.

      Lixo NÃO entra: quantidade que não é número atravessaria toda leitura
      posterior como NaN (a mesma lição de numeroDaTela, acima), então a venda
      é recusada com mensagem legível em vez de gravar um rastro que mente.

      E o cerco da empresa vale até na trilha: productId de OUTRA empresa (ou
      inexistente) entra com o vínculo NULO e o retrato em texto — recusar a
      venda por causa de um id estranho pararia o balcão, mas gravar a FK de
      outro tenant seria vazamento.
    */
    const rastroDeCancelados = input.cancelledItems ?? [];
    if (rastroDeCancelados.length > 200) {
      throw new ApiError(
        'CORE_INVALID_CANCELLED_ITEM',
        'Rastro de itens cancelados grande demais — no máximo 200 remoções por venda.',
        400,
      );
    }
    const rastroStmt = db.prepare(
      `INSERT INTO core_sale_removed_items
         (id, sale_id, company_id, product_id, name, quantity, unit_price_cents,
          removed_by, removed_at, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const removido of rastroDeCancelados) {
      const qtd = Number(removido?.quantity);
      const preco = Math.round(Number(removido?.unitPriceCents ?? 0));
      if (!Number.isFinite(qtd) || qtd <= 0 || !Number.isFinite(preco) || preco < 0) {
        throw new ApiError(
          'CORE_INVALID_CANCELLED_ITEM',
          'Item cancelado com quantidade ou valor inválido — a venda não foi registrada.',
          400,
        );
      }
      // O vínculo só fica quando o produto é DESTA empresa; senão, cai para
      // nulo e o retrato em texto responde pela linha.
      const produtoDaCasa = removido.productId
        ? (db
            .prepare('SELECT id, name FROM core_products WHERE id = ? AND company_id = ?')
            .get(removido.productId, input.companyId) as
            | { id: string; name: string }
            | undefined)
        : undefined;
      const nome = String(removido.name ?? '').trim() || produtoDaCasa?.name || '';
      if (!nome) {
        throw new ApiError(
          'CORE_INVALID_CANCELLED_ITEM',
          'Item cancelado sem nome — a venda não foi registrada.',
          400,
        );
      }
      rastroStmt.run(
        randomUUID(),
        saleId,
        input.companyId,
        produtoDaCasa?.id ?? null,
        nome,
        qtd,
        preco,
        // Quem removeu é quem operou a venda — autor nunca vem do corpo.
        input.userId,
        typeof removido.removedAt === 'string' && removido.removedAt ? removido.removedAt : now,
        typeof removido.reason === 'string' && removido.reason.trim()
          ? removido.reason.trim()
          : null,
        now,
      );
    }

    const itemStmt = db.prepare(
      /*
        `cost_cents` É O ÚLTIMO CAMPO, e é o retrato do custo no momento da
        venda (GAP-V28). Sem ele o DRE não tinha CMV — e a recusa estava certa,
        porque o custo do cadastro muda a cada nota de entrada e recalcular a
        margem de março com o custo de agosto faria mês fechado mudar sozinho.

        ZERO É GRAVADO como zero, e não como nulo: "o cadastro deste produto
        não tem custo" é um fato, e um fato diferente de "esta venda é anterior
        ao dia em que o sistema passou a fotografar custo". Quem lê o CMV
        separa os dois — o primeiro fica de fora da margem (custo zero devolve
        100%), o segundo é contado como período sem retrato.
      */
      `INSERT INTO core_sale_items
         (id, sale_id, company_id, product_id, description, quantity,
          unit_price_cents, discount_cents, total_cents, cost_cents, promotion_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    /*
      AS BAIXAS SÃO SOMADAS POR PRODUTO ANTES DE IREM PARA O ESTOQUE.

      A chave de idempotência do movimento é
      (empresa, tipo, referência, PRODUTO, movimento) — schema.ts. Numa venda
      com o mesmo produto em duas linhas, as duas baixas produzem a MESMA
      chave: a segunda era lida como reenvio, devolvia `duplicated: true` e não
      debitava nada. Vender 3 + 4 sobre saldo 10 deixava 7 — quatro unidades
      saíam da loja e não saíam do sistema.

      O caso do kit era o mais traiçoeiro, porque quem opera não vê "duas
      linhas do mesmo produto": vê dois kits diferentes que por acaso levam a
      mesma peça. Kit de 2 óleos + kit de 3 óleos baixava 2.

      Somar antes resolve na raiz e, de quebra, faz a checagem de reserva e a
      de saldo valerem sobre o TOTAL — antes cada linha era avaliada sozinha, e
      uma venda que o estoque não cobria passava pela metade.
    */
    const baixasPorProduto = new Map<
      string,
      {
        productId: string;
        quantity: number;
        name: string;
        doKit: string | null;
        unitIds: string[];
      }
    >();

    /*
      QUAL UNIDADE SAIU POR QUAL LINHA (GAP-PRD-026).

      A baixa é somada por produto (logo abaixo), então o funil de estoque só
      sabe que a moto saiu "pela venda" — não por QUAL linha. Com o mesmo
      produto em duas linhas, a nota não teria como dizer qual chassi foi em
      qual item. O id da linha fica guardado aqui e vira `sale_item_id` na
      unidade depois da baixa, na mesma transação.
    */
    const unidadesPorLinha: { saleItemId: string; unitIds: string[] }[] = [];

    for (const line of priced) {
      const saleItemId = randomUUID();
      if (line.unitIds && line.unitIds.length > 0) {
        unidadesPorLinha.push({ saleItemId, unitIds: [...line.unitIds] });
      }
      itemStmt.run(
        saleItemId,
        saleId,
        input.companyId,
        line.product.id,
        line.product.name,
        line.quantity,
        line.unit,
        line.discount,
        line.total,
        // Centavo INTEIRO, e nunca nulo aqui: toda linha de produto sai desta
        // rodada com retrato de custo. Cadastro sem custo grava 0, que é o
        // fato — e é lido como fato, não como ausência.
        Math.trunc(Number(line.product.cost_cents ?? 0)),
        line.promotionId,
      );
      // A VENDA RESPEITA A RESERVA.
      //
      // `applyMovement` protege `quantity >= 0`, e só. Peça reservada continua
      // contando como saldo, então o balcão vendia mercadoria que já tinha
      // dono: a pré-venda ficava sem como ser faturada e o disponível ia a
      // negativo (verificado: 1 em estoque, 1 reservado, a venda passava e
      // deixava `quantity 0, reserved 1`).
      //
      // Quem converte pré-venda solta a reserva ANTES de faturar, então a
      // própria reserva não bloqueia a venda que ela originou.
      // Só entra aqui quando HÁ saldo e ele está comprometido. Faltar
      // mercadoria é outro problema, com outra mensagem: quem ouve "está
      // reservado" sobre uma prateleira vazia vai procurar uma reserva que não
      // existe. Esse caso segue sendo recusado pelo `applyMovement`.
      // O kit desmembra aqui: a LINHA da venda continua sendo o kit — é o que
      // o cliente comprou e o que sai na nota —, mas quem baixa são as peças.
      // O kit desmembra aqui: a LINHA da venda continua sendo o kit — é o que
      // o cliente comprou e o que sai na nota —, mas quem baixa são as peças.
      for (const baixa of baixasDaLinha(input.companyId, line.product, line.quantity)) {
        // As unidades escolhidas pertencem à LINHA, não à peça do kit: só o
        // produto vendido diretamente tem como o caixa apontar qual é. Peça
        // serializada dentro de kit é caso que ainda não existe no negócio, e
        // se aparecer o `applyMovement` recusa em vez de escolher sozinho.
        const unidadesDaLinha =
          baixa.productId === line.product.id ? (line.unitIds ?? []) : [];

        const jaTem = baixasPorProduto.get(baixa.productId);
        if (jaTem) {
          jaTem.quantity += baixa.quantity;
          jaTem.unitIds.push(...unidadesDaLinha);
          // A menção ao kit some quando a mesma peça vem por caminhos
          // diferentes: dizer "peça do kit X" quando parte veio avulsa
          // mandaria quem lê procurar no lugar errado.
          if (jaTem.doKit !== baixa.doKit) jaTem.doKit = null;
        } else {
          baixasPorProduto.set(baixa.productId, {
            productId: baixa.productId,
            quantity: baixa.quantity,
            name: baixa.name,
            doKit: baixa.doKit ?? null,
            unitIds: [...unidadesDaLinha],
          });
        }
      }
    }

    for (const baixa of baixasPorProduto.values()) {
      // A VENDA RESPEITA A RESERVA.
      //
      // `applyMovement` protege `quantity >= 0`, e só. Peça reservada continua
      // contando como saldo, então o balcão vendia mercadoria que já tinha
      // dono: a pré-venda ficava sem como ser faturada e o disponível ia a
      // negativo (verificado: 1 em estoque, 1 reservado, a venda passava e
      // deixava `quantity 0, reserved 1`).
      //
      // Quem converte pré-venda solta a reserva ANTES de faturar, então a
      // própria reserva não bloqueia a venda que ela originou.
      // Só entra aqui quando HÁ saldo e ele está comprometido. Faltar
      // mercadoria é outro problema, com outra mensagem: quem ouve "está
      // reservado" sobre uma prateleira vazia vai procurar uma reserva que não
      // existe. Esse caso segue sendo recusado pelo `applyMovement`.
      const saldo = getBalance(input.companyId, baixa.productId);
      const disponivel = getAvailable(input.companyId, baixa.productId);
      if (baixa.quantity > disponivel && baixa.quantity <= saldo) {
        throw new ApiError(
          'CORE_STOCK_RESERVED',
          `"${baixa.name}"${baixa.doKit ? `, peça do kit "${baixa.doKit}",` : ''} tem `
            + `${disponivel} livre(s): o restante está prometido a pré-venda, pedido `
            // A oficina entrou na lista na rodada 55: peça prometida a uma OS
            // aberta é a origem mais provável quando o item é peça de bancada.
            + 'online, locação ou uma OS aberta da oficina.',
          409,
          {
            productId: baixa.productId,
            requested: baixa.quantity,
            available: disponivel,
            kit: baixa.doKit ?? null,
          },
        );
      }

      // Baixa de estoque na mesma transação. Se faltar saldo, tudo reverte.
      const resultado = applyMovement({
        companyId: input.companyId,
        productId: baixa.productId,
        movementType: 'out',
        quantity: baixa.quantity,
        referenceType: 'sale',
        referenceId: saleId,
        kind: 'SALE',
        documentNumber: `Venda #${number}`,
        userId: input.userId,
        note: baixa.doKit ? `Venda #${number} · kit ${baixa.doKit}` : `Venda #${number}`,
        unitIds: baixa.unitIds.length > 0 ? baixa.unitIds : undefined,
      });

      // Dentro de uma venda NOVA, `duplicated` não significa reenvio — o id da
      // venda acabou de ser sorteado e ninguém mais poderia tê-lo usado.
      // Significa que duas baixas colidiram na chave, que é exatamente o
      // defeito que a soma acima elimina. Falhar alto aqui impede que ele
      // volte em silêncio.
      if (resultado.duplicated) {
        throw new ApiError(
          'CORE_STOCK_MOVEMENT_COLLISION',
          `Baixa duplicada de "${baixa.name}" na mesma venda.`,
          500,
        );
      }
    }

    // A unidade leva o carimbo da LINHA — só a que acabou de sair por esta
    // venda (o funil acima a marcou com a saída `sale`/`saleId`).
    if (unidadesPorLinha.length > 0) {
      const carimbo = db.prepare(
        `UPDATE core_product_units SET sale_item_id = ?
          WHERE id = ? AND company_id = ? AND exit_reference_type = 'sale' AND exit_reference_id = ?`,
      );
      for (const linha of unidadesPorLinha) {
        for (const unitId of linha.unitIds) {
          carimbo.run(linha.saleItemId, unitId, input.companyId, saleId);
        }
      }
    }

    /*
      A MERCADORIA QUE JÁ SAIU (GAP-PRD-024) — as peças da OS.

      Linha COM produto e com retrato de custo, como qualquer mercadoria
      vendida (a nota tira dela NCM, CFOP e origem; o CMV a enxerga), e SEM
      movimento de estoque: a peça baixou na conclusão técnica da OS. O
      produto precisa ser desta empresa — a linha não atravessa CNPJ.
    */
    if (jaBaixadas.length > 0) {
      const daEmpresa = db.prepare('SELECT 1 FROM core_products WHERE id = ? AND company_id = ?');
      const linhaJaBaixada = db.prepare(
        `INSERT INTO core_sale_items
           (id, sale_id, company_id, product_id, description, quantity,
            unit_price_cents, discount_cents, total_cents, cost_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      );
      for (const l of jaBaixadas) {
        if (!daEmpresa.get(l.productId, input.companyId)) {
          throw new ApiError(
            'CORE_PRODUCT_NOT_FOUND',
            `A peça "${l.description}" não é um produto desta operação.`,
            404,
          );
        }
        linhaJaBaixada.run(
          randomUUID(),
          saleId,
          input.companyId,
          l.productId,
          l.description,
          l.quantity,
          l.unitPriceCents,
          l.totalCents,
          // Sem retrato é NULO, nunca zero: o CMV conta a linha como "antes do
          // retrato" (GAP-PRD-101), e zero seria margem inteira inventada.
          l.costCents === null ? null : Math.trunc(l.costCents),
        );
      }
    }

    // Linha de serviço: aparece na venda e no financeiro, mas não move
    // estoque — as peças da OS já foram baixadas no lançamento.
    if (serviceTotal > 0 && linhasDeServico) {
      /*
        O SERVIÇO ITEMIZADO (GAP-PRD-101): a peça da OS com o custo que a OS
        fotografou na baixa, a mão de obra com custo NULO (pelo motivo do
        bloco abaixo). Sem produto e sem movimento — ver `serviceLines`.
      */
      const linhaDeServico = db.prepare(
        `INSERT INTO core_sale_items
           (id, sale_id, company_id, product_id, description, quantity,
            unit_price_cents, discount_cents, total_cents, cost_cents)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?)`,
      );
      for (const linha of linhasDeServico) {
        linhaDeServico.run(
          randomUUID(),
          saleId,
          input.companyId,
          linha.description,
          linha.quantity,
          linha.unitPriceCents,
          linha.totalCents,
          linha.costCents,
        );
      }
    } else if (serviceTotal > 0) {
      db.prepare(
        /*
          `cost_cents` FICA DE FORA desta lista de propósito, e por isso nasce
          NULO: mão de obra não sai de prateleira nenhuma, e gravar 0 aqui a
          faria entrar na conta do CMV como "produto sem custo cadastrado" —
          uma pendência de cadastro que nunca teria conserto, porque não há
          cadastro para consertar.
        */
        `INSERT INTO core_sale_items
           (id, sale_id, company_id, product_id, description, quantity,
            unit_price_cents, discount_cents, total_cents)
         VALUES (?, ?, ?, NULL, ?, 1, ?, 0, ?)`,
      ).run(
        randomUUID(),
        saleId,
        input.companyId,
        input.serviceDescription ?? 'Serviço',
        serviceTotal,
        serviceTotal,
      );
    }

    const paymentStmt = db.prepare(
      `INSERT INTO core_sale_payments
         (id, sale_id, company_id, method, amount_cents, status, provider, provider_ref, created_at,
          payment_intent_id, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A gaveta recebe UM lançamento por venda — a UNIQUE do ledger
    // (session_id, reference_type, reference_id, movement_type) é o que impede
    // que um reenvio credite o caixa duas vezes. Por isso as entradas em
    // espécie são somadas aqui e lançadas uma única vez depois do laço, em vez
    // de um movimento por pagamento.
    let cashToDrawer = 0;
    for (const payment of input.payments) {
      paymentStmt.run(
        randomUUID(),
        saleId,
        input.companyId,
        payment.method,
        payment.amountCents,
        payment.status ?? 'settled',
        payment.provider ?? provedorDaLinha.get(payment) ?? null,
        payment.providerRef ?? null,
        now,
        payment.paymentIntentId ?? null,
        (payment.status ?? 'settled') === 'settled' ? now : null,
      );

      // Dinheiro em espécie afeta a gaveta; os demais meios não. Quem responde
      // por isso é o catálogo, e não uma string repetida aqui — dois lugares
      // decidindo o que é dinheiro divergem no primeiro método novo.
      if (isCashMethod(payment.method) && payment.status !== 'pending') {
        cashToDrawer += payment.amountCents;
      }
    }

    /*
      O OUTRO LADO DO VÍNCULO (GAP-V48): a venda carimbada na cobrança.

      Só agora, porque só agora a venda tem id e número. Roda dentro da MESMA
      transação: se qualquer coisa daqui para a frente falhar, o carimbo volta
      atrás junto com a venda e a cobrança continua disponível — uma cobrança
      marcada como gasta numa venda inexistente seria dinheiro do cliente preso
      sem documento.

      É este carimbo que faz a segunda venda com a mesma cobrança ser recusada,
      e é ele que fecha o ciclo depois de uma reconciliação aprovada: da
      transação dá para chegar na venda.
    */
    for (const cartao of linhasDeCartao) {
      bindTerminalTransactionToSale({
        companyId: input.companyId,
        transactionId: cartao.transactionId,
        saleId,
        saleNumber: number,
      });
    }

    // O que fica na gaveta é o recebido em espécie MENOS o troco devolvido —
    // senão o fechamento acusaria uma sobra que não está lá.
    const netToDrawer = cashToDrawer - change;
    if (gavetaDaVenda && netToDrawer > 0) {
      db.prepare(
        `INSERT INTO core_cash_movements
           (id, session_id, company_id, movement_type, amount_cents, payment_method,
            reference_type, reference_id, user_id, note, created_at)
         VALUES (?, ?, ?, 'sale', ?, 'dinheiro', 'sale', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        gavetaDaVenda,
        input.companyId,
        netToDrawer,
        saleId,
        input.userId,
        `Venda #${number}`,
        now,
      );
    }

    // O ÚNICO lançamento financeiro da venda.
    // O que liquida a venda é o total dela — o troco não vira receita.
    //
    // O CRÉDITO DE LOJA LIQUIDA TAMBÉM, e é preciso dizer por quê: ele não
    // trouxe dinheiro, mas extinguiu o recebível. Deixá-lo de fora deixaria a
    // venda paga com vale "em aberto" no contas a receber, e alguém cobraria do
    // cliente um valor que ele não deve. A baixa dele nasce separada, com método
    // próprio, logo abaixo — é assim que a conciliação bancária distingue esta
    // liquidação de uma entrada de dinheiro de verdade.
    const settledCents = Math.min(
      total,
      creditoPedido
        + input.payments
          .filter((p) => (p.status ?? 'settled') === 'settled')
          .reduce((acc, p) => acc + p.amountCents, 0),
    );
    /*
      O DINHEIRO DO CARTÃO NÃO CAI HOJE, NEM CAI INTEIRO.

      Uma venda de R$ 100 no crédito nascia como R$ 100 quitados no mesmo dia.
      Na prática são ~R$ 96,50 daqui a trinta dias — o sistema confundia
      faturamento com dinheiro em caixa, e errava para cima no meio de
      pagamento que a loja mais usa.

      Com operadora cadastrada, cada pagamento de cartão vira N parcelas a
      receber (com a data em que cada uma cai) mais N linhas de taxa a pagar.
      SEM operadora cadastrada, `planForPayment` devolve nulo e tudo abaixo cai
      no caminho antigo, linha por linha idêntica ao que sempre foi — é o que
      mantém toda instalação que ainda não configurou nada funcionando igual.
    */
    const planos = input.payments.map((p) => ({
      pagamento: p,
      plano:
        (p.status ?? 'settled') === 'settled'
          ? planForPayment(input.companyId, {
              paymentMethod: p.method,
              amountCents: p.amountCents,
              installments: p.installments,
              /*
                O DIA DA VENDA É O DIA DA LOJA, e é dele que a operadora
                conta o repasse. `now.slice(0, 10)` respondia o dia de
                GREENWICH: `planForPayment` soma `settlement_days` em cima
                do que recebe, então a venda das 22h30 ganhava um dia a mais
                em cada parcela — e a conferência da maquininha nunca fechava
                para o fim do expediente. O mesmo relógio da competência, uma
                linha acima.
              */
              saleDate: diaDaLoja(now),
            })
          : null,
    }));

    const inserirLancamento = db.prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at,
          settled_cents, customer_id, description, origin_type, origin_id,
          category_id, competence_date, installment_number, installment_total,
          payment_method, account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Classificação automática: a venda nasce na categoria de sistema. Sem
    // isto o plano de contas existiria e ninguém o usaria — categoria que
    // depende de alguém lembrar de escolher fica vazia.
    const catVenda = systemCategoryId(input.companyId, 'venda');
    // Competência é a data do fato, não a do vencimento: venda de hoje compete
    // hoje, mesmo que a operadora só deposite em trinta dias. E "hoje" é o
    // hoje da LOJA — `now.slice(0, 10)` responderia o dia de Greenwich, e a
    // venda das 22h30 competiria amanhã; na virada do mês, o DRE e o dre.csv
    // do contador escriturariam a receita no mês errado.
    const competencia = diaDaLoja(now);

    /*
      QUANDO VENCE A VENDA FIADA.

      Venda sem NENHUM pagamento na hora é venda a prazo, e o lançamento a
      receber dela nascia vencendo no MESMO dia — o que não é prazo, é a
      ausência de prazo escrita com cara de data. O efeito é o painel
      financeiro acusando atraso no dia seguinte à venda, e o dono aprendendo a
      ignorar o alerta de atraso, que é como um alerta morre.

      SÓ vale para a venda sem pagamento. Venda com PIX pendente também nasce
      em aberto, e ali a data de hoje está CERTA: espera-se que caia hoje, e
      dar trinta dias a ela esconderia um PIX que nunca caiu atrás de um prazo
      que ninguém combinou.

      Nulo na política = zero dias = vence hoje, exatamente como antes.

      E o PRAZO CONTA A PARTIR DA COMPETÊNCIA, pelo mesmo relógio dela.
      `diaMais` recebia o instante e o fatiava, o que respondia o dia de
      Greenwich: das 21h à meia-noite, "trinta dias" viravam trinta e um dias
      depois do dia que o cliente viveu. Um relógio só nos dois lados — é o que
      `venda-noturna-tem-um-relogio-so` cobra, e é por isso que a igualdade
      `vencimento === somarDias(competência, prazo)` vale sempre.
    */
    //
    // VENDA PAGA COM VALE NÃO É FIADA. Ela nasce sem `payments` — o crédito não
    // é meio de pagamento —, e sem esta ressalva cairia no prazo do crediário:
    // um recebível de trinta dias para uma venda que já está quitada. O que
    // decide é se sobrou algo para os meios cobrarem.
    const vencimento =
      input.payments.length === 0 && aCobrarNosMeios > 0
        ? diaMais(now, politica.creditSaleDueDays)
        : competencia;

    if (!planos.some((x) => x.plano)) {
      // CAMINHO ANTIGO: uma linha só para a venda inteira.
      const lancamentoId = randomUUID();
      inserirLancamento.run(
        lancamentoId,
        input.companyId,
        'in',
        total,
        settledCents >= total ? 'settled' : 'open',
        vencimento,
        settledCents >= total ? now : null,
        settledCents,
        input.customerId ?? null,
        `Venda #${number}`,
        saleId,
        catVenda,
        competencia,
        1,
        1,
        null,
        null,
        now,
      );
      /*
        O QUE NASCE QUITADO NASCE COM A BAIXA (V29).

        O DEFEITO: `settled_cents` entrava preenchido SEM linha em
        `core_finance_settlements`. O saldo fechava, mas o histórico não
        contava a história — a conciliação bancária compara extrato contra
        BAIXAS, e a venda à vista não existia para ela (o banco real tinha 7
        de 9 lançamentos quitados e ZERO baixas). Regime de caixa, idem.

        A baixa-espelho entra na MESMA transação da venda, pelo valor que de
        fato liquidou (o troco já ficou de fora do `settledCents`). O meio só
        é gravado quando é um só — em pagamento misto (dinheiro + PIX no
        caminho sem operadora), inventar um dos dois seria mentir com cara de
        dado; nulo é a verdade disponível.

        Lançamentos ANTIGOS quitados sem baixa não são reescritos: baixa
        retroativa com carimbo de hoje sujaria a conciliação de mês vivido.
      */
      /*
        O CRÉDITO DE LOJA TEM BAIXA PRÓPRIA, e nunca se mistura com a do
        dinheiro.

        Duas baixas em vez de uma porque as duas contam fatos diferentes: uma é
        dinheiro que entrou, a outra é dívida que a loja deixou de dever. A
        conciliação bancária lê BAIXAS, e uma linha somada com o vale a mandaria
        procurar no extrato um valor que nunca passou por banco nenhum.

        A soma das duas continua sendo exatamente `settledCents` — é essa
        identidade que `fatia-a-vista-nasce-com-baixa` cobra, e ela vale aqui
        também.
      */
      if (creditoPedido > 0) {
        inserirBaixaEspelho({
          companyId: input.companyId,
          entryId: lancamentoId,
          amountCents: creditoPedido,
          method: CREDITO_DE_LOJA,
          settledAt: now,
          userId: input.userId ?? null,
          note: `Crédito de loja do cliente na venda #${number} — nenhum dinheiro entrou`,
        });
      }
      const recebidoEmMeios = settledCents - creditoPedido;
      if (recebidoEmMeios > 0) {
        const meiosQuitados = [
          ...new Set(
            input.payments
              .filter((p) => (p.status ?? 'settled') === 'settled')
              .map((p) => p.method),
          ),
        ];
        inserirBaixaEspelho({
          companyId: input.companyId,
          entryId: lancamentoId,
          amountCents: recebidoEmMeios,
          method: meiosQuitados.length === 1 ? meiosQuitados[0] : null,
          settledAt: now,
          userId: input.userId ?? null,
          note: `Recebido no ato da venda #${number}`,
        });
      }
    } else {
      /*
        CAMINHO COM OPERADORA. Cada fatia vira uma linha a receber.

        O que é dinheiro na hora (espécie, ou forma sem regra cadastrada) sai
        como uma fatia já quitada, vencendo hoje. O que passa pela operadora
        sai como N fatias em aberto, cada uma com a data em que a operadora
        deposita.
      */
      const fatias: {
        amount: number;
        dueDate: string;
        settled: boolean;
        method: string | null;
        accountId: string | null;
      }[] = [];
      const taxas: { amount: number; dueDate: string; accountId: string | null }[] = [];

      /*
        O CRÉDITO DE LOJA VIRA UMA FATIA JÁ QUITADA, e vem PRIMEIRO.

        Neste caminho cada fatia é um lançamento próprio com o seu meio, e a
        baixa-espelho de cada uma já carrega esse meio — então o vale entra
        aqui, e não como um bloco à parte: uma fatia quitada hoje, de método
        `CREDITO_DE_LOJA`, com o resto da venda seguindo em fatias de operadora.

        Vem primeiro para ficar antes das parcelas do cartão na numeração — o
        que já está liquidado é a primeira linha do carnê, não a última — e o
        laço do troco logo abaixo não a toca, porque ela não é espécie: crédito
        de loja não vira dinheiro na mão, que é a regra desta rodada inteira.
      */
      if (creditoPedido > 0) {
        fatias.push({
          amount: creditoPedido,
          dueDate: competencia,
          settled: true,
          method: CREDITO_DE_LOJA,
          accountId: null,
        });
      }

      for (const { pagamento, plano } of planos) {
        if (!plano) {
          fatias.push({
            amount: pagamento.amountCents,
            dueDate: competencia,
            settled: (pagamento.status ?? 'settled') === 'settled',
            method: pagamento.method,
            accountId: null,
          });
          continue;
        }
        for (const parcela of plano.installments) {
          fatias.push({
            amount: parcela.grossCents,
            dueDate: parcela.dueDate,
            settled: false,
            method: pagamento.method,
            accountId: plano.accountId,
          });
          if (parcela.feeCents > 0) {
            taxas.push({
              amount: parcela.feeCents,
              dueDate: parcela.dueDate,
              accountId: plano.accountId,
            });
          }
        }
      }

      /*
        O TROCO NÃO É RECEITA.

        O desconto de cabeçalho NÃO entra aqui: os pagamentos já somam o total
        líquido dele, e subtrair de novo tiraria o desconto duas vezes — foi o
        que o teste de soma pegou.

        O que precisa sair é o TROCO. Quem paga R$ 120 em espécie numa venda de
        R$ 100 leva R$ 20 de volta; sem este ajuste a loja registraria R$ 120
        de entrada e o financeiro fecharia acima do que de fato entrou.

        Sai da fatia em espécie, que é de onde o troco realmente sai.
      */
      let aTirar = change;
      for (let i = fatias.length - 1; i >= 0 && aTirar > 0; i -= 1) {
        if (!isCashMethod(fatias[i].method ?? '')) continue;
        const corte = Math.min(fatias[i].amount, aTirar);
        fatias[i].amount -= corte;
        aTirar -= corte;
      }

      const comValor = fatias.filter((f) => f.amount > 0);
      comValor.forEach((f, i) => {
        const fatiaId = randomUUID();
        inserirLancamento.run(
          fatiaId,
          input.companyId,
          'in',
          f.amount,
          f.settled ? 'settled' : 'open',
          f.dueDate,
          f.settled ? now : null,
          f.settled ? f.amount : 0,
          input.customerId ?? null,
          comValor.length > 1
            ? `Venda #${number} · ${i + 1}/${comValor.length}`
            : `Venda #${number}`,
          saleId,
          catVenda,
          competencia,
          i + 1,
          comValor.length,
          f.method,
          f.accountId,
          now,
        );
        /*
          A FATIA À VISTA NASCE COM A BAIXA-ESPELHO (V29) — mesma doença do
          caminho antigo, mesmo remédio: `settled_cents` cheio sem linha de
          baixa deixava a conciliação bancária e o regime de caixa cegos para
          o dinheiro que entrou na hora. Aqui cada fatia é de UM meio de
          pagamento, então a baixa carrega o meio de verdade. A fatia da
          operadora continua nascendo em aberto e SEM baixa — o dinheiro dela
          ainda não caiu; a baixa dela nasce quando alguém a registrar.
        */
        if (f.settled) {
          inserirBaixaEspelho({
            companyId: input.companyId,
            entryId: fatiaId,
            amountCents: f.amount,
            method: f.method,
            settledAt: now,
            userId: input.userId ?? null,
            note: `Recebido no ato da venda #${number}`,
          });
        }
      });

      /*
        A TAXA É DESPESA, e não redução de receita.

        Sai como linha própria para aparecer no DRE: no fim do ano o lojista
        precisa saber quanto a maquininha custou. Embutida no líquido, ela
        sumiria dentro da receita e ninguém nunca somaria.

        A direção é 'out', então não colide com as parcelas a receber: a chave
        única inclui a direção.
      */
      const catTaxa = systemCategoryId(input.companyId, 'taxa_cartao');
      taxas.forEach((t, i) => {
        inserirLancamento.run(
          randomUUID(),
          input.companyId,
          'out',
          t.amount,
          'open',
          t.dueDate,
          null,
          0,
          null,
          `Taxa de cartão · venda #${number}`,
          saleId,
          catTaxa,
          competencia,
          i + 1,
          taxas.length,
          null,
          t.accountId,
          now,
        );
      });
    }

    /*
      COMISSÃO — na mesma transação da venda.

      Base = subtotal MENOS o desconto de cabeçalho. O acréscimo (juros de
      cartão, frete) fica de fora: não é mérito de venda.

      Não derruba a venda: sem vendedor, sem grupo ou sem faixa que cubra o
      valor, a função simplesmente não grava nada. Numa loja, parar de vender é
      o pior desfecho — e a venda sem comissão aparece contada no balde da
      tela de apuração, em vez de sumir.
    */
    /*
      A COMISSÃO NÃO NASCE DENTRO DE UM PERÍODO JÁ FECHADO (revisão do
      G-offline-sync-14).

      O DEFEITO: com a hora da venda guardada, a competência da comissão virou o
      dia em que a venda aconteceu — até 72 h atrás. Se nesse meio-tempo o
      período daquele dia já tinha sido fechado para o vendedor (a venda do dia
      31, sincronizada no dia 2, depois do fechamento do mês), a linha nascia
      "aberta" DENTRO de um período fechado: o fechamento seguinte é de outras
      datas e não a alcança, e refechar o mesmo período é recusado
      (`CORE_COMMISSION_PERIOD_CLOSED`). A comissão ficava presa, sem ninguém
      pagar. Nesse caso ela entra no dia de hoje — o mesmo relógio do estorno do
      cancelamento — e o fechamento seguinte a paga. A venda continua com a hora
      dela; só a comissão muda de dia.
    */
    const vendedorDaComissao = input.sellerId ?? input.userId ?? null;
    // O dia da LOJA, como a competência lá em cima: a apuração de comissão
    // corta as vendas por `diaDaLojaSql` — gravar aqui o dia de Greenwich
    // deixaria a comissão da venda noturna fora do dia em que ela aconteceu.
    let competenciaDaComissao = diaDaLoja(now);
    if (vendedorDaComissao && now !== agora) {
      const periodoFechado = db
        .prepare(
          `SELECT 1 AS n FROM core_commission_closings
            WHERE company_id = ? AND seller_id = ? AND period_from <= ? AND period_to >= ?
            LIMIT 1`,
        )
        .get(input.companyId, vendedorDaComissao, competenciaDaComissao, competenciaDaComissao);
      if (periodoFechado) competenciaDaComissao = diaDaLoja(agora);
    }
    registrarComissaoDaVenda({
      companyId: input.companyId,
      saleId,
      sellerId: vendedorDaComissao,
      baseCents: subtotal - saleDiscount,
      competenceDate: competenciaDaComissao,
    });

    // O PIX do balcão ganha a venda (GAP-PRD-077): daqui em diante o webhook
    // sabe qual linha liquidar. Na mesma transação — venda desfeita, vínculo
    // desfeito, e a cobrança volta a poder fechar outra venda.
    vincularPixDoBalcaoAVenda({ companyId: input.companyId, saleId });

    const venda = loadSale(saleId)!;

    // A venda vai para a fila da central AQUI DENTRO, na mesma transação.
    // Se qualquer coisa acima falhar — saldo insuficiente, caixa fechado —, o
    // rollback leva o evento junto e a central nunca fica sabendo de uma venda
    // que não aconteceu.
    recordDomainEvent({
      eventType: 'sale.registered',
      aggregateType: 'sale',
      aggregateId: saleId,
      companyId: input.companyId,
      payload: {
        ...(venda as unknown as Record<string, unknown>),
        customer_id: input.customerId ?? null,
        seller_id: input.sellerId ?? input.userId,
        subtotal_cents: subtotal,
        discount_cents: saleDiscount,
        surcharge_cents: surcharge,
        origin: input.origin ?? 'pdv',
        items: priced.map((l) => ({
          product_id: l.product.id,
          description: l.product.name,
          quantity: l.quantity,
          unit_price_cents: l.unit,
          discount_cents: l.discount,
          total_cents: l.total,
        })),
        payments: input.payments.map((p) => ({
          method: p.method,
          amount_cents: p.amountCents,
          status: p.status ?? 'settled',
        })),
      },
      occurredAt: now,
    });

    // A concessão volta junto com a venda mesmo quando não houve trava: é ela
    // que a rota grava na auditoria. Concessão medida e não registrada em
    // lugar nenhum seria um cálculo sem leitor — o defeito que esta rodada
    // veio consertar, cometido de novo na saída. O mesmo vale para o rastro:
    // a contagem volta para virar detail de auditoria.
    return {
      sale: venda,
      duplicated: false,
      concessao,
      cancelados: rastroDeCancelados.length,
      horaDaVenda,
      alcada: trilhaDaAlcada,
    };
  });

  // Fidelidade acontece DEPOIS da venda estar fechada, e fora da transação
  // dela. Uma falha no programa de pontos não pode desfazer uma venda que o
  // cliente já pagou e levou — o benefício é acessório, o fato econômico não.
  // `accrueForSale` é silencioso quando não se aplica (venda sem cliente,
  // programa desligado, valor abaixo de um ponto).
  if (!resultado.duplicated) {
    try {
      accrueForSale({
        companyId: input.companyId,
        saleId: resultado.sale.id,
        userId: input.userId,
      });
    } catch {
      // Ponto não concedido é problema de benefício, não de caixa. A venda
      // está gravada e o balcão segue.
    }
  }

  return resultado;
}

/**
 * O QUE O CANCELAMENTO DEVOLVEU, E POR ONDE (E-venda-servidor-06).
 *
 * A tela dizia sempre "o cancelamento já repôs tudo, e não há o que devolver"
 * — inclusive na venda de R$ 250 no crédito da maquininha avulsa, em que
 * NINGUÉM estorna nada se a pessoa não for ao aparelho. O título a receber
 * some do financeiro, e o cliente continua cobrado no cartão por uma venda que
 * o sistema diz não existir. Este resumo é o que a tela precisa para escrever
 * uma linha por meio.
 */
export interface ReembolsoDoCancelamento {
  /** Saiu da gaveta agora, pelo movimento de cancelamento. */
  gavetaCents: number;
  /**
   * O que só volta pela mão de alguém: a venda não tinha cobrança integrada
   * nesse meio, então o sistema não tem a quem pedir o estorno.
   */
  aDevolverAMao: { dinheiro: number; credito: number; debito: number; pix: number };
  /** Pedido às cobranças da maquininha integrada (o resultado vem em `estornosNaMaquininha`). */
  maquininhaCents: number;
  /** Vale que esta venda gastou e voltou ao saldo do cliente. */
  valeDevolvidoCents: number;
  /** Vale concedido por devolução desta venda que foi revogado. */
  valeRevogadoCents: number;
  /** O que devoluções anteriores já entregaram em dinheiro, PIX ou cartão — não volta de novo. */
  jaDevolvidoCents: number;
  /**
   * O que o título da venda recebeu DEPOIS, em Contas a receber — a venda a
   * prazo que o cliente veio pagar, o PIX pendente baixado à mão —, menos o que
   * devoluções já devolveram dele (E-venda-servidor-R01). Não passou por gaveta
   * nem por cobrança integrada, e o cancelamento anula a baixa junto com o
   * título: volta ao cliente pela mão de alguém, pelo meio em que entrou
   * (`meios`, o que as baixas registraram; "não informado" quando a baixa não
   * disse).
   */
  recebidoDepois: { cents: number; meios: string[] };
}

/**
 * Cancela a venda e devolve o estoque exatamente uma vez.
 * A UNIQUE do ledger usa referenceType `sale_cancel`, então cancelar duas
 * vezes não repõe o estoque em dobro.
 */
export function cancelSale(input: {
  companyId: string;
  saleId: string;
  userId: string;
  /**
   * Obrigatório, com ao menos 3 letras (E-venda-servidor-M01). Continua
   * opcional no tipo só para a recusa sair NOMEADA, e não como erro de
   * compilação de quem chama com o corpo cru.
   */
  reason?: string;
  /**
   * O caixa de quem cancela (corpo ou token de dispositivo). Decide de qual
   * gaveta sai o dinheiro quando o turno da venda já fechou — ver
   * `GavetaDoDinheiro`.
   */
  terminalId?: string | null;
  /**
   * Venda já cancelada vira recusa (409) em vez de devolver a venda
   * (E-venda-servidor-14). A ROTA liga isto: lá, "cancelar de novo" gastava a
   * liberação do gestor, gravava uma segunda linha `sale.cancel` na auditoria
   * e pedia o estorno à maquininha outra vez. A recusa acontece DENTRO da
   * transação em que a liberação é consumida, então ela volta intacta. Quem
   * chama o serviço por dentro continua com o cancelamento idempotente.
   */
  recusarSeJaCancelada?: boolean;
}): SaleRecord & { reembolso?: ReembolsoDoCancelamento } {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const sale = db
      .prepare('SELECT * FROM core_sales WHERE id = ? AND company_id = ?')
      .get(input.saleId, input.companyId) as
      | {
          id: string;
          number: number;
          status: string;
          cash_session_id: string | null;
          change_cents: number | null;
        }
      | undefined;
    if (!sale) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);
    if (sale.status === 'cancelled') {
      if (input.recusarSeJaCancelada) {
        throw new ApiError(
          'CORE_SALE_ALREADY_CANCELLED',
          `A venda #${sale.number} já estava cancelada — nada foi desfeito de novo, e a liberação `
            + 'do gestor, se houve, continua valendo.',
          409,
          { saleId: sale.id, saleNumber: sale.number },
        );
      }
      return loadSale(input.saleId)!;
    }

    /*
      O MOTIVO É OBRIGATÓRIO (E-venda-servidor-M01).

      O DEFEITO: o cancelamento tira dinheiro da gaveta e desfaz estoque,
      comissão, fidelidade e vale — e aceitava motivo vazio, enquanto a
      devolução, que mexe em menos coisa, exigia três letras. A gaveta recebia
      "Cancelamento da venda #N" e a trilha `reason: null`: no fechamento,
      ninguém sabia dizer por que o dinheiro saiu. Conferido antes de qualquer
      escrita.
    */
    const motivo = String(input.reason ?? '').trim();
    if (motivo.length < 3) {
      throw new ApiError(
        'CORE_CANCEL_REASON_REQUIRED',
        'Informe o motivo do cancelamento (ao menos 3 letras). Ele vai para a auditoria, para o '
          + 'movimento de estoque e para a saída da gaveta — é o que responde "por que esta venda '
          + 'sumiu?" no fechamento.',
        400,
      );
    }

    /*
      NOTA FISCAL VIVA TRAVA O CANCELAMENTO DA VENDA (E-venda-servidor-05).

      O DEFEITO: `cancelSale` nunca olhava `core_fiscal_documents`. Com a
      emissão automática ligada, a venda com NFC-e AUTORIZADA era cancelada na
      tela de Devoluções — estoque de volta, dinheiro fora da gaveta, receita
      fora do DRE — e a nota seguia valendo na SEFAZ: imposto devido, XML no
      pacote do contador, e nenhuma tela avisando que faltava o evento de
      cancelamento, que tem prazo.

      Trava também a nota a caminho (assinada, na fila, em transmissão, em
      contingência): a emissão no Finalizar corre em segundo plano, e cancelar
      a venda enquanto ela sobe deixaria a SEFAZ autorizar a nota de uma venda
      que não existe mais. Rascunho, rejeitada, com erro ou já cancelada não
      travam — nenhuma delas vale como documento.
    */
    const notaViva = db
      .prepare(
        `SELECT id, model, number, access_key, status FROM core_fiscal_documents
          WHERE company_id = ? AND sale_id = ?
            AND status IN ('SIGNED', 'QUEUED', 'SENDING', 'AUTHORIZED', 'CONTINGENCY')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.companyId, input.saleId) as
      | { id: string; model: string; number: number; access_key: string | null; status: string }
      | undefined;
    if (notaViva) {
      const nome = String(notaViva.model) === '55' ? 'NF-e' : 'NFC-e';
      const autorizada = notaViva.status === 'AUTHORIZED';
      const estado = autorizada
        ? 'autorizada na SEFAZ'
        : notaViva.status === 'CONTINGENCY'
          ? 'emitida em contingência'
          : 'a caminho da SEFAZ';
      throw new ApiError(
        'CORE_SALE_HAS_FISCAL_DOCUMENT',
        `A venda #${sale.number} tem a ${nome} nº ${notaViva.number} ${estado}. Cancelar só a venda `
          + 'deixaria a nota valendo — imposto devido e XML no pacote do contador. '
          + (autorizada || notaViva.status === 'CONTINGENCY'
            ? `Cancele a ${nome} no painel fiscal primeiro (a SEFAZ dá 30 minutos para cancelar a `
              + 'NFC-e); passado o prazo, registre a devolução em vez de cancelar a venda.'
            : `Espere a SEFAZ responder e cancele a ${nome} no painel fiscal antes de cancelar a venda.`),
        409,
        {
          documentId: notaViva.id,
          model: notaViva.model,
          number: notaViva.number,
          accessKey: notaViva.access_key,
          status: notaViva.status,
        },
      );
    }

    /*
      O QUE A VENDA RECEBEU, POR MEIO — e o que as devoluções já entregaram
      (E-venda-servidor-01).

      O DEFEITO: o cancelamento só descontava a devolução que tinha saído PELA
      GAVETA. Venda de R$ 100 em dinheiro, devolução de R$ 50 por PIX,
      cancelamento: saíam R$ 100 da gaveta e o cliente recebia R$ 150 por R$ 100
      pagos — e o lançamento do PIX, dinheiro que já tinha saído do banco, era
      cancelado junto. Venda paga com vale e devolvida em dinheiro: o vale
      voltava inteiro e o dinheiro ficava com o cliente.

      A regra que fecha todas as combinações: cada devolução em dinheiro, PIX
      ou cartão tem de caber no que a venda recebeu NAQUELE meio. Aí o
      cancelamento a desconta do próprio meio — a gaveta pelo que a devolução
      tirou dela, a maquininha pelo que ela já estornou — e cada conta (gaveta,
      banco, operadora) fecha em zero sozinha. A devolução que cruzou de meio
      (PIX devolvido de venda em dinheiro, dinheiro devolvido de venda no vale)
      não tem como ser descontada do meio original sem deixar uma conta com
      sobra e a outra com falta: nesse caso a venda não é cancelada, e o resto
      volta pela Devolução, que devolve pelo meio certo e deixa a receita e a
      despesa lado a lado.
    */
    const pagamentos = db
      .prepare(
        `SELECT method, amount_cents, status, provider_ref FROM core_sale_payments
          WHERE sale_id = ? AND company_id = ?`,
      )
      .all(input.saleId, input.companyId) as unknown as {
      method: string;
      amount_cents: number;
      status: string;
      provider_ref: string | null;
    }[];
    const liquidados = pagamentos.filter((p) => p.status === 'settled');
    const pelaMaquininha = (p: { provider_ref: string | null }) =>
      Boolean(p.provider_ref) && ehCobrancaDaMaquininha(input.companyId, String(p.provider_ref));
    const somaDos = (filtro: (p: (typeof liquidados)[number]) => boolean) =>
      liquidados.filter(filtro).reduce((acc, p) => acc + Number(p.amount_cents), 0);
    const recebido = {
      dinheiro: Math.max(
        0,
        somaDos((p) => isCashMethod(p.method)) - Math.max(0, Number(sale.change_cents ?? 0)),
      ),
      pixAMao: somaDos((p) => p.method === 'pix' && !pelaMaquininha(p)),
      creditoAMao: somaDos((p) => p.method === 'credito' && !pelaMaquininha(p)),
      debitoAMao: somaDos((p) => p.method === 'debito' && !pelaMaquininha(p)),
      cartaoNaMaquininha: somaDos(
        (p) => (p.method === 'credito' || p.method === 'debito') && pelaMaquininha(p),
      ),
    };
    const cartaoRecebido = recebido.creditoAMao + recebido.debitoAMao + recebido.cartaoNaMaquininha;

    /*
      E O QUE A VENDA RECEBEU DEPOIS, EM CONTAS A RECEBER (E-venda-servidor-R01).

      O DEFEITO: `recebido` acima só lê `core_sale_payments`, e a baixa feita
      depois em Contas a receber nunca chega lá — `settleEntry` grava o título e
      a baixa, e mais nada. Venda fiada de R$ 200, paga uma semana depois em
      dinheiro no Contas a receber, cancelada quando o cliente devolveu o item:
      o estoque voltava, o título já quitado virava 'cancelled' (os R$ 200
      sumiam do financeiro) e o resumo vinha todo zero — a tela dizia "Nada
      desta venda tinha sido recebido, então não há dinheiro a devolver". O
      cliente que pagou R$ 200 não recebia nada de volta, ou o gerente pagava
      sem nada dizer quanto. O PIX pendente (sem cobrança integrada) baixado à
      mão caía no mesmo buraco.

      A conta é a da DEVOLUÇÃO (`limitesDeReembolso`), para as duas portas não
      divergirem: o que a venda recebeu fora do cartão e do vale é o total menos
      o vale, menos o cartão, menos o que o título ainda não recebeu. O que
      disso NÃO entrou no ato — o liquidado fora do cartão em
      `core_sale_payments`, menos o troco; o PIX confirmado pelo provedor também
      liquida a linha e entra aqui — entrou depois.
    */
    const limites = limitesDeReembolso(input.companyId, input.saleId);
    const recebidoNoAtoForaDoCartao = Math.max(
      0,
      somaDos((p) => p.method !== 'credito' && p.method !== 'debito')
        - Math.max(0, Number(sale.change_cents ?? 0)),
    );
    const recebidoDepoisCents = Math.max(0, limites.dinheiroOuPixCents - recebidoNoAtoForaDoCartao);
    /*
      POR QUAL MEIO entrou: o que as baixas do título registraram, das mais
      recentes para trás até cobrir o valor (a baixa-espelho do ato é sempre a
      mais antiga). Serve só para a frase — o valor vem da conta acima.
    */
    const meiosDoRecebidoDepois: string[] = [];
    if (recebidoDepoisCents > 0) {
      const baixas = db
        .prepare(
          `SELECT s.method AS method, s.amount_cents AS amount
             FROM core_finance_settlements s
             JOIN core_finance_entries e ON e.id = s.entry_id
            WHERE e.company_id = ? AND e.origin_type = 'sale' AND e.origin_id = ?
              AND e.direction = 'in'
              AND (e.payment_method IS NULL OR e.payment_method NOT IN ('credito', 'debito'))
              AND s.reversed_at IS NULL AND s.reverses_id IS NULL
              AND (s.method IS NULL OR s.method <> ?)
            ORDER BY s.settled_at DESC, s.rowid DESC`,
        )
        .all(input.companyId, input.saleId, CREDITO_DE_LOJA) as unknown as {
        method: string | null;
        amount: number;
      }[];
      let falta = recebidoDepoisCents;
      for (const baixa of baixas) {
        if (falta <= 0) break;
        const meio = baixa.method ? String(baixa.method) : 'não informado';
        if (!meiosDoRecebidoDepois.includes(meio)) meiosDoRecebidoDepois.push(meio);
        falta -= Number(baixa.amount);
      }
    }

    const devolvidoPorMeio = db
      .prepare(
        `SELECT refund_method AS metodo, COALESCE(SUM(total_cents), 0) AS total
           FROM core_sale_returns WHERE sale_id = ? AND company_id = ?
          GROUP BY refund_method`,
      )
      .all(input.saleId, input.companyId) as unknown as { metodo: string; total: number }[];
    const devolvidoEm = (metodo: string) =>
      Number(devolvidoPorMeio.find((d) => d.metodo === metodo)?.total ?? 0);
    const devolvido = {
      dinheiro: devolvidoEm('dinheiro'),
      pix: devolvidoEm('pix'),
      cartao: devolvidoEm('estorno_cartao'),
    };
    /*
      A DEVOLUÇÃO DO QUE ENTROU DEPOIS NÃO É "OUTRO MEIO" (E-venda-servidor-R01).

      A devolução em dinheiro ou PIX de uma venda recebida em Contas a receber é
      legítima — a Devolução mede pelo mesmo `limitesDeReembolso` e a aceita. Sem
      isto, a fiada paga depois e devolvida em dinheiro caía aqui como
      "devolvida por um meio diferente do que ela recebeu (ela recebeu R$ 0,00
      em dinheiro)", e a venda não cancelava. O que passa do que entrou no ato
      naquele meio só é cruzado se passar também do que entrou depois.
    */
    const excessoEmDinheiro = Math.max(0, devolvido.dinheiro - recebido.dinheiro);
    const excessoEmPix = Math.max(0, devolvido.pix - recebido.pixAMao);
    const cabeNoRecebidoDepois = excessoEmDinheiro + excessoEmPix <= recebidoDepoisCents;
    const eDepois =
      recebidoDepoisCents > 0
        ? ` (e mais ${emReais(recebidoDepoisCents)} recebidos depois, em Contas a receber)`
        : '';
    const cruzados: string[] = [];
    if (devolvido.dinheiro > recebido.dinheiro && !cabeNoRecebidoDepois) {
      cruzados.push(
        `${emReais(devolvido.dinheiro)} devolvidos em dinheiro, e ela recebeu `
          + `${emReais(recebido.dinheiro)} em dinheiro${eDepois}`,
      );
    }
    if (devolvido.pix > recebido.pixAMao && !cabeNoRecebidoDepois) {
      cruzados.push(
        `${emReais(devolvido.pix)} devolvidos por PIX, e ela recebeu ${emReais(recebido.pixAMao)} `
          + `por PIX fora da maquininha${eDepois}`,
      );
    }
    if (devolvido.cartao > cartaoRecebido) {
      cruzados.push(
        `${emReais(devolvido.cartao)} estornados no cartão, e ela recebeu `
          + `${emReais(cartaoRecebido)} no cartão`,
      );
    }
    if (cruzados.length > 0) {
      throw new ApiError(
        'CORE_SALE_RETURN_OTHER_MEANS',
        `A venda #${sale.number} já teve devolução por um meio diferente do que ela recebeu `
          + `(${cruzados.join('; ')}). Cancelar agora devolveria de novo, pelo meio original, o que `
          + 'a devolução já entregou. Registre a devolução do que ainda está com o cliente em '
          + 'Devoluções — ela devolve pelo meio certo.',
        409,
        { saleId: sale.id, recebido, devolvido, recebidoDepoisCents },
      );
    }
    const jaDevolvidoCents = devolvido.dinheiro + devolvido.pix + devolvido.cartao;

    /**
     * O ESTORNO LÊ O QUE SAIU, NÃO O QUE FOI VENDIDO.
     *
     * Estas duas coisas deixaram de ser a mesma quando o kit passou a
     * desmembrar: a LINHA da venda é o kit, e o que saiu da prateleira são as
     * peças. Devolver pela linha creditava o kit — que não tem estoque
     * próprio — e deixava as peças em falta para sempre. Verificado: vender 2
     * kits e cancelar deixava "Kit 2, Peça A 6, Peça B 8" quando o correto era
     * "Kit 0, Peça A 10, Peça B 10".
     *
     * Ler o movimento também protege de outra coisa: a COMPOSIÇÃO DO KIT PODE
     * TER MUDADO entre a venda e o cancelamento. Recalcular pelas peças de
     * hoje devolveria mercadoria que nunca saiu, e deixaria de devolver a que
     * saiu. O movimento é o que aconteceu; o cadastro é o que vale agora.
     *
     * Linha de serviço não tem `product_id` e nunca gerou movimento — ela
     * simplesmente não aparece aqui, sem precisar de exceção.
     */
    /*
      E DESCONTA O QUE UMA DEVOLUÇÃO JÁ DEVOLVEU.
     *
      Ler só as saídas da venda estava certo enquanto cancelar era a única
      forma de desfazê-la. Com devolução parcial no meio, a conta dobra:
      vender 5, devolver 2 e cancelar devolvia os 5 inteiros de novo — a
      prateleira ganhava 7 por 5 que saíram, e nada acusava, porque cada um dos
      dois movimentos está certo isolado.

      A devolução referencia o id DELA, não o da venda, então o desconto
      atravessa `core_sale_returns`. E soma pelo mesmo critério do estorno —
      o que MOVIMENTOU, não o que a linha do documento diz —, senão o kit
      voltaria a falar pelo kit e não pelas peças.

      Quantidade que zera não vira movimento: `applyMovement` recusa zero, e
      um item devolvido por inteiro simplesmente não tem o que estornar.

      OS SINAIS: no razão, saída é gravada NEGATIVA e entrada POSITIVA. Somar
      os dois lados direto daria "-5 menos 2 = -7" e o cancelamento devolveria
      SETE. Por isso os dois lados entram em módulo, e a subtração acontece
      entre grandezas do mesmo sinal. (O código antigo passava a soma negativa
      adiante e funcionava por acidente: `applyMovement` tira o módulo por
      dentro. Aqui o acidente deixaria de salvar.)
    */
    const saidasMenosDevolvidas = (
      db
        .prepare(
          `SELECT s.product_id AS product_id,
                  s.quantity - COALESCE(d.quantity, 0) AS quantity
             FROM (SELECT product_id, ABS(SUM(quantity)) AS quantity
                     FROM core_stock_movements
                    WHERE company_id = ? AND reference_type = 'sale' AND reference_id = ?
                      AND movement_type = 'out'
                    GROUP BY product_id) AS s
             LEFT JOIN (SELECT m.product_id, ABS(SUM(m.quantity)) AS quantity
                          FROM core_stock_movements m
                          JOIN core_sale_returns r ON r.id = m.reference_id
                         WHERE m.company_id = ? AND m.reference_type = 'sale_return'
                           AND m.movement_type = 'in' AND r.sale_id = ?
                         GROUP BY m.product_id) AS d
               ON d.product_id = s.product_id`,
        )
        .all(input.companyId, input.saleId, input.companyId, input.saleId) as unknown as {
        product_id: string;
        quantity: number;
      }[]
    );

    /*
      E O QUE VOLTOU COM DEFEITO TAMBÉM NÃO VOLTA DE NOVO (E-venda-servidor-01).

      O DEFEITO: o desconto acima só enxerga o que a devolução MOVIMENTOU. A
      devolução "com defeito" (restock = 0) não movimenta nada — é a razão de
      existir dela: peça quebrada não soma ao vendável. Então o cancelamento
      seguinte a devolvia como se ainda estivesse com o cliente, e a peça com
      defeito entrava no saldo vendável. No serializado era pior: a unidade
      'baixada' voltava 'in_stock'.

      A quantidade sai de `core_sale_return_items`, desdobrada pela MESMA regra
      da devolução (`pecasDaLinhaDevolvida`: o kit fala pelas peças, o serviço
      não fala por nada).
    */
    const comDefeito = db
      .prepare(
        `SELECT ri.product_id AS product_id, SUM(ri.quantity) AS quantity
           FROM core_sale_return_items ri
           JOIN core_sale_returns r ON r.id = ri.return_id
          WHERE r.sale_id = ? AND r.company_id = ? AND ri.restock = 0
            AND ri.product_id IS NOT NULL
          GROUP BY ri.product_id`,
      )
      .all(input.saleId, input.companyId) as unknown as { product_id: string; quantity: number }[];
    const naoVoltaPorProduto = new Map<string, number>();
    for (const linha of comDefeito) {
      for (const peca of pecasDaLinhaDevolvida(input.companyId, linha.product_id, Number(linha.quantity))) {
        naoVoltaPorProduto.set(
          peca.productId,
          (naoVoltaPorProduto.get(peca.productId) ?? 0) + peca.quantity,
        );
      }
    }
    const items = saidasMenosDevolvidas
      .map((i) => ({
        product_id: i.product_id,
        quantity: Number(i.quantity) - (naoVoltaPorProduto.get(i.product_id) ?? 0),
      }))
      .filter((i) => i.quantity > 1e-9);

    /*
      As unidades voltam pelo mesmo princípio do estoque: pelo que SAIU.
      `exit_reference` espelha a chave do movimento, então achar as peças da
      venda é uma leitura direta — sem reler `core_sale_items`, que no caso do
      kit fala do kit e não das peças.
    */
    const unidadesQueSairam = unitsByExitReference(input.companyId, 'sale', input.saleId);

    for (const item of items) {
      // Só a peça que AINDA está com o cliente (`sold`): a devolvida em bom
      // estado já voltou, e a baixada por defeito não volta ao vendável.
      const doProduto = unidadesQueSairam
        .filter((u) => u.product_id === item.product_id && u.status === 'sold')
        .map((u) => u.id);
      applyMovement({
        companyId: input.companyId,
        productId: item.product_id,
        movementType: 'in',
        quantity: item.quantity,
        referenceType: 'sale_cancel',
        referenceId: input.saleId,
        kind: 'SALE_CANCEL',
        documentNumber: `Venda #${sale.number}`,
        userId: input.userId,
        reason: motivo,
        note: `Cancelamento da venda #${sale.number}`,
        unitIds: doProduto.length > 0 ? doProduto : undefined,
      });
    }

    // A comissão volta atrás junto com a venda, na mesma transação. Estorna o
    // SALDO vivo: se já houve devolução parcial, leva só o que sobrou.
    estornarComissaoDaVenda({
      companyId: input.companyId,
      saleId: input.saleId,
      motivo,
    });

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE core_sales SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?",
    ).run(now, input.userId, input.saleId);

    /*
      A OS QUE ESTA VENDA PAGOU VOLTA PARA A FILA DO CAIXA (GAP-PRD-105).

      Sem isto a OS ficava "finalizada" apontando para uma venda cancelada: um
      serviço entregue, sem pagamento, que nenhuma fila mostrava. Na mesma
      transação, para a reabertura cair junto se o cancelamento cair. Venda
      que não é de OS passa sem efeito — o porquê da regra está no módulo.
    */
    reabrirOsDaVendaCancelada({
      companyId: input.companyId,
      saleId: input.saleId,
      userId: input.userId,
      reason: motivo,
    });

    /*
      A COBRANÇA DA MAQUININHA VOLTA JUNTO (GAP-PRD-080).

      Era a única coisa que o cancelamento não desfazia: a cobrança seguia
      `authorized`, amarrada a uma venda que não vale mais, sem estorno pedido
      e sem rastro. Aqui, dentro da mesma transação, cada cobrança que pagou a
      venda é marcada "a estornar" pelo que ainda pode voltar (o que uma
      devolução no cartão já estornou não volta de novo). A chamada à
      operadora vem DEPOIS do commit, pela rota (`executarEstornosPendentes`):
      rede não entra em transação de banco, e o estorno que a operadora não
      confirmar fica na fila do gestor em vez de desfazer o cancelamento.
    */
    const naMaquininha = marcarCobrancasAEstornar({
      companyId: input.companyId,
      saleId: input.saleId,
      saleNumber: sale.number,
      userId: input.userId,
      origem: 'cancelamento',
      referenciaId: input.saleId,
      motivo,
      valorCents: null,
    });

    // Cancelou, devolve o ponto. Sem isto o cliente acumularia comprando e
    // desistindo — e o passivo da loja cresceria sobre venda que não houve.
    reversePoints({
      companyId: input.companyId,
      saleId: input.saleId,
      userId: input.userId,
      reason: `Cancelamento da venda #${sale.number}`,
    });

    /*
      E O CRÉDITO DE LOJA VOLTA — nos DOIS sentidos, como o ponto.

      O sentido que protege o CLIENTE: o vale que ESTA venda gastou volta ao
      saldo. Sem isto ele pagaria com o crédito, a venda seria anulada, a
      mercadoria voltaria à prateleira e o vale teria evaporado no caminho.

      O sentido que protege a LOJA: o vale que uma DEVOLUÇÃO desta venda
      concedeu é revogado. Cancelar é dizer que o fato inteiro não valeu — o
      bloco logo acima já derruba os lançamentos financeiros das devoluções
      desta venda pelo mesmo argumento —, e um crédito de pé sobre uma venda
      que o sistema afirma nunca ter acontecido é dinheiro do nada.

      Devolução NÃO se cancela nesta casa: não há rota, serviço nem tela para
      isso, e é decisão registrada no cabeçalho de `SaleReturnService` (o
      documento da devolução nunca deixa de existir). O cancelamento da VENDA é
      o único caminho que anula uma devolução, e é por ele que a revogação
      passa.

      As duas são idempotentes por chave única: cancelar de novo não devolve
      nem revoga em dobro.
    */
    const valeDevolvido = returnRedeemedCredit({
      companyId: input.companyId,
      saleId: input.saleId,
      userId: input.userId,
      reason: `Cancelamento da venda #${sale.number} — crédito usado devolvido ao saldo`,
    });
    const valeRevogado = revokeCreditFromSale({
      companyId: input.companyId,
      saleId: input.saleId,
      userId: input.userId,
      reason: `Cancelamento da venda #${sale.number} — crédito concedido na devolução revogado`,
    });

    /*
      O fato econômico é cancelado, não apagado — a trilha permanece.

      `cancelled_at` entra JUNTO com o status, e não em vez dele, porque os
      dois respondem perguntas diferentes. `status` é derivado do saldo:
      `aplicarStatus` o reescreve a cada baixa e a cada estorno, e uma baixa
      lançada depois do cancelamento devolvia estas linhas para 'open' — a
      receita cancelada voltava para o DRE sozinha. O carimbo não se recalcula,
      e é por ele que o relatório decide o que conta.

      Isto alcança as DUAS direções da venda: a parcela a receber e a taxa de
      cartão, que compartilham `origin_id`. Cancelar a venda e deixar a taxa
      viva mostraria despesa de uma venda que não houve.
    */
    db.prepare(
      `UPDATE core_finance_entries
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?)
        WHERE origin_type = 'sale' AND origin_id = ?`,
    ).run(now, input.saleId);

    /*
      E A DEVOLUÇÃO DESTA VENDA CAI JUNTO — senão o DRE mostra prejuízo do
      tamanho do que foi devolvido.

      O cenário é real e tem três passos: o cliente devolve metade da venda
      (entra uma despesa de R$ 50), depois a venda inteira é cancelada (a
      receita de R$ 100 sai). Fica de pé uma despesa de R$ 50 sem nenhuma
      receita do lado — o relatório do mês passa a acusar um prejuízo que não
      existe, de uma venda que o sistema diz que nunca aconteceu.

      Cancelar a venda é dizer que o fato inteiro não valeu. Uma devolução é a
      desistência PARCIAL de um fato; se o fato todo foi anulado, a desistência
      parcial dele não sobrevive sozinha. O DOCUMENTO da devolução continua
      existindo, com sua numeração e seu histórico — o que é cancelado é o
      lançamento financeiro, exatamente como acontece com a venda.
    */
    db.prepare(
      `UPDATE core_finance_entries
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?)
        WHERE origin_type = 'sale_return'
          AND origin_id IN (SELECT id FROM core_sale_returns
                             WHERE sale_id = ? AND company_id = ?)`,
    ).run(now, input.saleId, input.companyId);

    let gavetaCents = 0;
    if (sale.cash_session_id) {
      const cashTotal = db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM core_cash_movements
            WHERE reference_type = 'sale' AND reference_id = ? AND movement_type = 'sale'`,
        )
        .get(input.saleId) as { total: number };
      /*
        O QUE UMA DEVOLUÇÃO EM DINHEIRO JÁ TIROU DA GAVETA NÃO SAI DE NOVO.

        Medido: venda de R$ 100 em espécie, devolução de metade em dinheiro pela
        gaveta, cancelamento do resto — a gaveta terminava em -R$ 50,00. O
        cancelamento debitava a venda INTEIRA sem descontar os R$ 50 que a
        devolução já tinha entregado: o cliente recebia R$ 150 por R$ 100
        pagos. É a mesma regra da devolução (GAP-PRD-009) — o que volta para o
        cliente nunca passa do que entrou —, e a mesma que o estoque deste
        cancelamento já segue logo acima (desconta o que a devolução repôs).
      */
      const devolvidoPelaGaveta = Number(
        (
          db
            .prepare(
              `SELECT COALESCE(SUM(-m.amount_cents), 0) AS total
                 FROM core_cash_movements m
                 JOIN core_sale_returns r ON r.id = m.reference_id
                WHERE m.company_id = ? AND m.reference_type = 'sale_return'
                  AND m.movement_type = 'sale_return' AND r.sale_id = ?`,
            )
            .get(input.companyId, input.saleId) as { total: number }
        ).total,
      );
      const aDevolverNaGaveta = cashTotal.total - devolvidoPelaGaveta;
      if (aDevolverNaGaveta > 0) {
        /*
          GAVETA JÁ FECHADA NÃO RECEBE MOVIMENTO NOVO.

          Esta era a única das três rotas de dinheiro sem a guarda: `createSale`
          recusa sessão fechada e `createSaleReturn` só lança quando a sessão
          está aberta. Aqui o débito ia direto para `sale.cash_session_id`, e o
          gerente que cancelasse hoje uma venda de ontem punha um lançamento no
          turno de ontem — já contado, conferido e assinado. O fechamento
          daquele dia deixava de bater com o papel guardado, e a diferença era
          inexplicável porque nasceu depois.

          A nota volta para a mão do cliente HOJE, então sai da gaveta de hoje.
        */
        const daVenda = db
          .prepare(`SELECT id, status FROM core_cash_sessions WHERE id = ? AND company_id = ?`)
          .get(sale.cash_session_id, input.companyId) as
          | { id: string; status: string }
          | undefined;

        let destino = daVenda?.status === 'open' ? daVenda.id : null;
        let observacao = `${motivo} · cancelamento da venda #${sale.number}`;

        if (!destino) {
          /*
            A GAVETA DE AGORA É A DO CAIXA DE QUEM CANCELA (GAP-PRD-161, e a
            dependência que o GAP-PRD-039 deixou registrada).

            Era "a gaveta aberta mais recente da empresa". Com um caixa por
            computador, isso é a gaveta do colega que abriu por último: o débito
            caía no fechamento de quem nem viu o cancelamento. A régua agora é a
            mesma da venda e da devolução (`GavetaDoDinheiro`): a gaveta do
            caixa do pedido, ou a única aberta; nenhuma, ou várias sem caixa no
            pedido, é recusa nomeada.
          */
          const gaveta = gavetaDoDinheiro({
            companyId: input.companyId,
            operacao: 'cancelamento',
            valorCents: aDevolverNaGaveta,
            informada: sale.cash_session_id,
            terminalId: input.terminalId ?? null,
            seInformadaFechada: 'procurar_a_de_agora',
          });
          if (!gaveta) {
            // Inalcançável: com a gaveta da venda fechada a régua recusa em
            // vez de devolver nulo. Fica o nome, se um dia deixar de ser.
            throw new ApiError(
              'CORE_CASH_SESSION_REQUIRED',
              'Não há caixa aberto para devolver o dinheiro deste cancelamento.',
              409,
            );
          }
          destino = gaveta.sessionId;
          observacao = `${observacao} · venda #${sale.number} de turno já fechado`;
        }

        db.prepare(
          `INSERT INTO core_cash_movements
             (id, session_id, company_id, movement_type, amount_cents, payment_method,
              reference_type, reference_id, user_id, note, created_at)
           VALUES (?, ?, ?, 'sale_cancel', ?, 'dinheiro', 'sale_cancel', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          destino,
          input.companyId,
          -aDevolverNaGaveta,
          input.saleId,
          input.userId,
          observacao,
          now,
        );
        gavetaCents = aDevolverNaGaveta;
      }
    }

    /*
      O QUE AINDA PRECISA DE UMA MÃO (E-venda-servidor-06): o que a venda
      recebeu num meio sem cobrança integrada, menos o que as devoluções já
      devolveram nele. O estorno de cartão de uma devolução vale primeiro para
      a cobrança integrada — é onde `marcarCobrancasAEstornar` o pôs —, e só o
      que passar dela conta como estornado no aparelho.
    */
    let cartaoJaEstornadoAMao = Math.max(0, devolvido.cartao - recebido.cartaoNaMaquininha);
    const creditoAMao = Math.max(0, recebido.creditoAMao - cartaoJaEstornadoAMao);
    cartaoJaEstornadoAMao = Math.max(0, cartaoJaEstornadoAMao - recebido.creditoAMao);
    const debitoAMao = Math.max(0, recebido.debitoAMao - cartaoJaEstornadoAMao);
    const reembolso: ReembolsoDoCancelamento = {
      gavetaCents,
      aDevolverAMao: {
        // Venda em espécie sem gaveta (a operação que nunca abriu caixa): a
        // nota volta à mão do cliente sem movimento nenhum a registrar.
        dinheiro: sale.cash_session_id ? 0 : Math.max(0, recebido.dinheiro - devolvido.dinheiro),
        credito: creditoAMao,
        debito: debitoAMao,
        pix: Math.max(0, recebido.pixAMao - devolvido.pix),
      },
      maquininhaCents: naMaquininha.reduce((acc, m) => acc + Number(m.amountInCents ?? 0), 0),
      valeDevolvidoCents: valeDevolvido.returned,
      valeRevogadoCents: valeRevogado.revoked,
      jaDevolvidoCents,
      // O que entrou depois, menos o que as devoluções em dinheiro/PIX já
      // tiraram dele (o excesso sobre o recebido no ato — ver `cabeNoRecebidoDepois`).
      recebidoDepois: (() => {
        const cents = Math.max(0, recebidoDepoisCents - excessoEmDinheiro - excessoEmPix);
        return { cents, meios: cents > 0 ? meiosDoRecebidoDepois : [] };
      })(),
    };

    return { ...loadSale(input.saleId)!, reembolso };
  });
}

export function getSaleDetail(companyId: string, saleId: string): Record<string, unknown> | null {
  ensureCoreSchema();
  const db = getConnection();
  const sale = db
    .prepare('SELECT * FROM core_sales WHERE id = ? AND company_id = ?')
    .get(saleId, companyId) as Record<string, unknown> | undefined;
  if (!sale) return null;
  return {
    ...sale,
    items: db.prepare('SELECT * FROM core_sale_items WHERE sale_id = ?').all(saleId),
    payments: db.prepare('SELECT * FROM core_sale_payments WHERE sale_id = ?').all(saleId),
    /*
      O rastro dos itens que saíram do carrinho antes do Finalizar — é a
      superfície pela qual o gestor confere o que foi mostrado e não cobrado.
      A venda já veio cercada por company_id, então o rastro herda o cerco.

      O NOME DE QUEM TIROU VEM JUNTO — conserto de costura.

      A tabela guarda `removed_by`, que é ID. A ficha da venda resolvia esse id
      chamando `GET /core/sellers`, uma rota de balcão que NÃO alcança todo
      perfil que chega à tela de Vendas (o estoquista toma 403): sem alcance, a
      coluna "Quem tirou" caía no identificador cru. Um rastro de prevenção de
      perda que mostra 'a3f1-…' para metade dos operadores não é rastro — a
      pergunta é sobre GENTE, e um UUID não a responde.

      Quem tem a tabela de usuários é o servidor, então é aqui que o id vira
      nome, pelo mesmo caminho de todo histórico da casa (listMovements,
      productHistory): LEFT JOIN, nunca JOIN.

      O LEFT é a decisão, e ela é sobre o que vale mais. Conta apagada depois da
      venda, id de outro tenant, ou rastro antigo sem carimbo de autor não podem
      derrubar a consulta nem sumir com a linha: o gestor precisa ver que ALGUÉM
      tirou a peça, com valor e hora. O nome vem NULO nesses casos e o id
      continua na resposta — "não sei o nome" e "ninguém removeu" são estados
      diferentes, e a tela cai no identificador em vez de apagar a prova.

      E o nome só é resolvido DENTRO da empresa da venda (o passo por
      core_user_companies, que é o mesmo recorte de `listTeam`, de onde vinha o
      /sellers): exibir o display_name de alguém de outro tenant seria vazamento
      — o mesmo cerco que faz o rastro gravar `product_id` nulo quando o produto
      é de outra empresa. O UNIQUE (user_id, company_id) garante que o LEFT JOIN
      não multiplica linha nenhuma.
    */
    removedItems: db
      .prepare(
        `SELECT r.*, u.display_name AS removed_by_name
           FROM core_sale_removed_items r
           LEFT JOIN core_user_companies uc
                  ON uc.user_id = r.removed_by AND uc.company_id = ?
           LEFT JOIN core_users u ON u.id = uc.user_id
          WHERE r.sale_id = ?
          ORDER BY r.removed_at`,
      )
      .all(companyId, saleId),
    /*
      O BLOCO FINANCEIRO DA FICHA (V22): os títulos que esta venda gerou —
      fatia à vista, parcelas da operadora, taxa. A ficha mostrava itens e
      pagamentos; quem queria saber "e a cobrança disso?" tinha de sair dela
      e caçar em Contas pelo texto. É a VOLTA da rastreabilidade, pela mesma
      consulta que a tela de Contas usa para a ida (originType + originId).
      Venda cancelada devolve o bloco vazio, e isso é o certo: cancelada não
      é um estado da conta — é a conta não existir.
    */
    financeEntries: listEntries(companyId, { originType: 'sale', originId: saleId }),
    /*
      QUANTO DESTA VENDA FOI PAGO COM VALE.

      A ficha mostrava `payments` e o total, e crédito de loja não está em
      `payments` — não é instrumento de pagamento, é dívida extinta (ver
      `CreateSaleInput.customerCreditCents`). Sem esta linha, a venda de R$ 100
      paga com R$ 30 de vale apareceria com R$ 70 de pagamento e R$ 100 de
      total, e quem lesse concluiria que faltou dinheiro.

      Positivo porque aqui a pergunta é "quanto o vale cobriu?" — na razão o
      resgate é negativo, porque lá a pergunta é "para onde o saldo foi".
    */
    customerCreditCents: Math.abs(
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
  };
}

/** O recorte que a lista e a contagem compartilham: um WHERE só, dois leitores. */
function recorteDeVendas(
  companyId: string,
  options: { from?: string; to?: string; customerId?: string },
): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let where = ' WHERE company_id = ?';
  /*
    As pontas chegam como DATA e a coluna é INSTANTE. Comparar os dois crus
    perdia o último dia inteiro ('...T14:00:00Z' <= '2026-08-31' é falso) e
    ainda cortava o dia em Greenwich, jogando a venda das 21h30 para o dia
    seguinte. Os limites da loja resolvem as duas coisas de uma vez.
  */
  const limites = limitesDoPeriodo(options.from, options.to);
  if (options.from) {
    where += ' AND created_at >= ?';
    params.push(limites.inicio);
  }
  if (options.to) {
    where += ' AND created_at <= ?';
    params.push(limites.fim);
  }
  // O histórico de compras de UM cliente. O company_id acima continua
  // mandando: pedir por um cliente da vizinha recorta um conjunto vazio, e
  // não as vendas dela.
  if (options.customerId) {
    where += ' AND customer_id = ?';
    params.push(options.customerId);
  }
  return { where, params };
}

export function listSales(
  companyId: string,
  options: {
    from?: string;
    to?: string;
    customerId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const recorte = recorteDeVendas(companyId, options);
  /*
    A ordem tem DESEMPATE de propósito. Num dia cheio, dezenas de vendas
    dividem o mesmo segundo, e `created_at` sozinho deixaria o SQLite livre
    para embaralhar cada página: a mesma venda em duas, outra em nenhuma.
    Com o rowid, quem pagina percorre o dia inteiro sem perder nem duplicar.
  */
  const sql = `SELECT * FROM core_sales${recorte.where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  return getConnection()
    .prepare(sql)
    .all(
      ...(recorte.params as never[]),
      options.limit ?? 200,
      options.offset ?? 0,
    ) as unknown as Record<string, unknown>[];
}

/**
 * Quantas vendas o recorte tem DE VERDADE — independente da página.
 *
 * A lista corta em LIMIT e isso é saudável; o que não era saudável é cortar
 * CALADO: um dia com 205 vendas devolvia 200 e nada avisava, e o invariante
 * "a lista soma o que o painel afirma" quebrava sem erro nenhum. A rota
 * devolve este número junto dos itens, para a tela saber que há mais.
 */
export function countSales(
  companyId: string,
  options: { from?: string; to?: string; customerId?: string } = {},
): number {
  ensureCoreSchema();
  const recorte = recorteDeVendas(companyId, options);
  const linha = getConnection()
    .prepare(`SELECT COUNT(*) AS n FROM core_sales${recorte.where}`)
    .get(...(recorte.params as never[])) as { n: number };
  return linha.n;
}
