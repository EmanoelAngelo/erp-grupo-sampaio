/**
 * Chamadas tipadas do núcleo do ERP.
 *
 * Nenhuma função recebe `companyId`: o escopo vem da sessão no servidor.
 */
import { apiBinary, apiOrigin, apiRequest, envelope, exigirCampos } from './client';
import type { LogisticsAccess } from './logistica';
import type { AsaasWebhookInfo } from './asaasWebhook';
import type { GavetaDeOutroDia } from './terminais';

export interface Product {
  id: string;
  internal_code: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  unit: string;
  cost_cents: number;
  price_cents: number;
  min_stock: number;
  stock_quantity?: number;
  active: number;
  /**
   * Preço que o balcão realmente cobra, já com a promoção vigente.
   *
   * Existe porque usar `price_cents` no carrinho fazia o PDV cobrar o preço
   * de tabela enquanto a vitrine anunciava o promocional.
   */
  effective_price_cents?: number;
  on_sale?: boolean;
  /** Cada peça tem identidade própria: a venda precisa dizer QUAL sai. */
  serialized?: number;
  /**
   * 1 = controla LOTE E VALIDADE (GAP-V35).
   *
   * Vem em toda linha da busca e do `getProduct` (o servidor seleciona `p.*`).
   * É este campo que faz o formulário de movimento mostrar — ou não — os
   * campos de lote: perguntar lote para um parafuso é exatamente o que a regra
   * do opt-in existe para impedir.
   *
   * Ausente lê como "não controla", que é o que todo produto era antes de a
   * coluna existir.
   */
  tracks_batches?: number;
  /**
   * 1 = o preço do cadastro é SUGESTÃO, não teto. Mão de obra, serviço, o que
   * se combina no balcão.
   *
   * A tela precisa deste campo pelo mesmo motivo que a venda precisa: sem ele,
   * o cálculo da concessão mediria "abaixo do vigente" num preço que é
   * sugestão — e como a sugestão desses produtos costuma ser ZERO, toda mão de
   * obra apareceria no balcão como concessão gigante pedindo gestor. Vem em
   * toda linha da busca e do `getProduct` (o servidor seleciona `p.*`).
   *
   * Ausente lê como preço fechado, que é o que o produto era antes de a coluna
   * existir.
   */
  open_price?: number;
  /**
   * `part` = peça de bancada; `retail` = mercadoria de revenda.
   *
   * O servidor manda este campo em toda linha da busca do PDV desde que a
   * bipagem passou a ACHAR a peça — responder "não encontrado" para um item
   * que está na mão do operador o empurra a cadastrar de novo, e o saldo racha
   * entre dois cadastros. Mas achar sem dizer O QUE achou é pior: a peça
   * entrava no carrinho parecendo mercadoria. Este campo é o que a tela lê
   * para marcar a linha e para PARAR antes do carrinho.
   *
   * Opcional porque nem toda leitura de produto passa pela busca: `getProduct`
   * devolve a linha inteira e a tem, mas listagens antigas não a selecionam.
   * Ausente é tratado como revenda — que é o que ela era antes de a coluna
   * existir.
   */
  kind?: string;
  /**
   * Nome da bancada dona, já resolvido pelo servidor.
   *
   * Nome e não id: "peça da Oficina de Celulares" é uma frase que o operador
   * entende; um UUID não é. Nulo em mercadoria de revenda.
   */
  workshop_name?: string | null;
  /**
   * A MINIATURA do balcão (P0 da Preço Justo): até 160 px e 40 KB, a da foto
   * principal — ou a do modelo, na variante sem galeria. Só a busca do balcão
   * a manda; e a busca NÃO manda `image_url` (o original), de propósito: a
   * tela da venda não tem como baixar o arquivo grande. Nula = sem foto ou
   * foto antiga sem miniatura, e a tela mostra o espaço neutro.
   */
  thumb_url?: string | null;
  /** 1 quando o produto tem foto (com ou sem miniatura). */
  tem_foto?: number | boolean;
  /**
   * Os NOMES dos campos que a NFC-e recusaria ('NCM', 'CFOP', 'origem',
   * 'CEST', 'tributação') — a régua da nota, lida na busca. Nunca valores.
   * Lista vazia ou ausente = nada a avisar.
   */
  fiscal_pendencias?: string[];
}

export interface StockItem {
  product_id: string;
  internal_code: string;
  name: string;
  unit: string;
  quantity: number;
  reserved: number;
  min_stock: number;
  price_cents: number;
  /** Nulo quando a política da empresa reserva o custo à gerência (GAP-PRD-165). */
  cost_cents: number | null;
  /**
   * Saldo × custo (pela régua da empresa), em centavos inteiros, arredondado no
   * servidor. A tela não refaz a multiplicação: quantidade fracionada faria a
   * linha divergir do total geral, e as duas estariam "certas". Nulo pelo mesmo
   * motivo do custo.
   */
  value_cents: number | null;
  /** O custo que a régua usou (GAP-PRD-166). Opcional: servidor anterior não o manda. */
  valuation_cost_cents?: number | null;
  /** 1 quando o disponível está abaixo do mínimo declarado. Quem decide é o servidor. */
  below_minimum: number;
}

/** Valor do estoque da empresa inteira — saldo × custo pela régua escolhida. */
export interface StockValuation {
  /** Nulo quando a política da empresa reserva o custo à gerência (GAP-PRD-165). */
  totalCents: number | null;
  produtosComSaldo: number;
  /** Opcionais: servidor anterior à política de gestão não os manda. */
  oculto?: boolean;
  /** A régua que fez o número (GAP-PRD-166) e quem, do contador, a confirmou. */
  regua?: 'ultimo_custo' | 'custo_medio';
  reguaConfirmadaPor?: string | null;
  reguaConfirmadaEm?: string | null;
  semCustoNoRazao?: number;
}

export interface Customer {
  id: string;
  name: string;
  /**
   * O código curto do cliente ("CLI-042"), quando a loja usa um. A linha
   * inteira do banco sempre o trouxe; ele entrou no tipo quando a busca do
   * balcão passou a achá-lo (GAP-V53) — e a lista do PDV o mostra para o
   * operador conferir que achou a pessoa certa. Opcional pelo mesmo motivo
   * dos campos abaixo: nem todo canto que remonta um `Customer` tem a ficha.
   */
  code?: string | null;
  document: string | null;
  email: string | null;
  phone: string | null;
  /**
   * Por qual tabela de preço este cliente compra.
   *
   * Nulo é o caso normal e precisa continuar sendo: é o que significam todos
   * os clientes que já existiam antes da migração 59 — preço de tabela cheio.
   * Quando há id, a partir da próxima venda essa pessoa paga o preço da tabela,
   * e o desconto combinado deixa de ser digitado à mão no balcão.
   *
   * Opcional porque nem toda leitura de cliente é a linha inteira do banco: o
   * PDV remonta um `Customer` só com id e nome ao retomar uma venda em espera,
   * e a tabela de lá viria do servidor de qualquer forma. Quem decide o preço é
   * `POST /core/pricing/cart`, nunca este campo.
   */
  price_table_id?: string | null;
  /**
   * Endereço e observações vêm na ficha (`GET /core/customers/:id`) e na
   * listagem — o servidor devolve a linha inteira. Opcionais pelo mesmo motivo
   * do `price_table_id`: nem todo canto que remonta um `Customer` carrega a
   * ficha completa.
   */
  address?: string | null;
  notes?: string | null;
  /**
   * 1 ativo, 0 inativado. A listagem só devolve ativos — quem chega com 0 aqui
   * veio da ficha (`GET`) ou da resposta do `PUT` que acabou de inativar.
   */
  active?: number;
  /**
   * A linha veio MASCARADA para o perfil de quem pediu (GAP-PRD-073): CPF e
   * telefone só com os últimos dígitos, sem e-mail, endereço nem observações.
   * Ausente = contato inteiro. Quem decide é o servidor (`projetarCliente`).
   */
  dados_mascarados?: boolean;
  /** Quando o titular foi anonimizado (LGPD). Nulo = cadastro vivo. */
  anonymized_at?: string | null;
}

/**
 * O que a edição da ficha alcança — espelho do `CustomerUpdateInput` do
 * servidor. Campo AUSENTE preserva o que estava; enviado vazio ou nulo LIMPA
 * (menos o nome, obrigatório sempre). A tabela de preço fica de fora de
 * propósito: trocar condição comercial é `setCustomerPriceTable`, com rota e
 * auditoria próprias.
 */
export interface CustomerUpdateInput {
  name?: string;
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  /** `false` tira o cliente de circulação; `true` o devolve à lista. */
  active?: boolean;
}

/**
 * O que `GET /core/cash/open` responde sobre ESTE computador (GAP-PRD-039/131).
 *
 * Os campos novos são opcionais porque servidor antigo não os manda — e aí o
 * PDV se comporta como a gaveta única de sempre.
 */
export interface CaixaDoComputador {
  session: CashSession | null;
  cashWithdrawalLimitCents: number | null;
  /** O caixa a que esta resposta se refere; nulo na gaveta única. */
  terminal?: { id: string; code: string; name: string } | null;
  /** O caixa veio do TOKEN de dispositivo: este computador não escolhe outro. */
  terminalDoDispositivo?: boolean;
  /** O caixa guardado no computador não vale mais (desligado, ou de outra operação). */
  terminalRecusado?: { id: string; motivo: string } | null;
  terminaisAtivos?: number;
  /** A operação tem caixas cadastrados e este computador ainda não disse qual é. */
  exigeTerminal?: boolean;
  /** A gaveta aberta é de um dia da loja anterior a hoje. */
  deOutroDia?: GavetaDeOutroDia | null;
}

export interface CashSession {
  id: string;
  /** O caixa (terminal) desta gaveta; nulo na gaveta única. */
  terminal_id?: string | null;
  opening_cents: number;
  counted_cents: number | null;
  expected_cents: number | null;
  difference_cents: number | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  /**
   * A TRILHA DA REABERTURA — quantas vezes, e o que foi desfeito.
   *
   * `closing_trail` é o JSON dos fechamentos ARQUIVADOS: reabrir o turno não
   * apaga a conferência (a falta de R$ 40,00 que alguém já explicou continua
   * no sistema), ela sai das colunas vivas e entra nesta pilha. `reopen_count`
   * vem em coluna própria para a lista poder marcar o turno sem fazer parse de
   * um texto por linha.
   */
  reopened_at?: string | null;
  reopen_reason?: string | null;
  reopen_count?: number;
  closing_trail?: string | null;
}

/**
 * Um fechamento DESFEITO, como ele volta dentro de `closing_trail`.
 *
 * A tela lê para responder "o que este turno já dizia antes de ser reaberto?"
 * — que é a pergunta de quem confere a gaveta depois de alguém ter mexido nela.
 */
export interface FechamentoArquivado {
  closed_by: string | null;
  closed_at: string | null;
  counted_cents: number | null;
  expected_cents: number | null;
  difference_cents: number | null;
  reopened_at: string;
  reopened_by: string;
  reopen_reason: string | null;
}

/**
 * Um turno na lista do histórico: a sessão + quem abriu e fechou PELO NOME.
 *
 * Os nomes vêm resolvidos do servidor (`listSessions` faz o JOIN com os
 * usuários) porque a pergunta que esta lista responde é "de quem era o caixa
 * que fechou faltando 40?" — e id de usuário não responde pergunta nenhuma.
 */
export interface TurnoDeCaixa extends CashSession {
  opened_by_name: string | null;
  closed_by_name: string | null;
}

export interface Sale {
  id: string;
  number: number;
  total_cents: number;
  /** Troco devolvido ao cliente. Não é receita e não fica na gaveta. */
  change_cents: number;
  status: string;
  created_at: string;
  /**
   * De quem foi a compra — nulo no balcão anônimo, que é a maioria.
   *
   * A coluna sempre viajou (`SELECT *`) e nenhum tipo a declarava. Quem decide
   * se ela importa é a tela de devolução: crédito de loja precisa de dono, e
   * sem este campo ela não teria como avisar antes de o servidor recusar.
   */
  customer_id?: string | null;
}

/**
 * UMA LINHA QUE SAIU DO CARRINHO antes do Finalizar (GAP-V52/V63).
 *
 * O rastro nasceu na onda 1 e ficou sem leitor: a tabela grava, a ficha da
 * venda devolve, e nenhuma tela de gestão mostrava. Prevenção de perda que
 * ninguém lê é banco de dados, não controle.
 *
 * `removed_by` é o ID de quem removeu — carimbado pelo servidor a partir do
 * token, nunca do corpo. Nulo acontece em rastro antigo, gravado antes de o
 * carimbo existir.
 *
 * `removed_by_name` VEM JUNTO, do próprio servidor. Virar nome já foi trabalho
 * da tela, que cruzava com `GET /core/sellers` — rota de balcão que não alcança
 * todo perfil que chega a Vendas (o estoquista tomava 403), e a coluna "quem
 * tirou" caía no UUID para metade dos operadores. Nulo aqui é "não sei o nome"
 * (conta apagada, ou id de fora desta operação), que é diferente de "ninguém
 * removeu": a linha continua na lista, com o identificador.
 */
export interface SaleRemovedItem {
  id: string;
  product_id: string | null;
  /** O retrato em texto: o produto pode ter sido renomeado ou apagado depois. */
  name: string;
  quantity: number;
  unit_price_cents: number;
  removed_by: string | null;
  removed_by_name: string | null;
  removed_at: string;
  reason: string | null;
}

/**
 * A FICHA DA VENDA — o que `GET /core/sales/:id` devolve.
 *
 * A lista de vendas nunca traz nada disto: itens, pagamentos, o que o vale
 * cobriu e o rastro do que saiu do carrinho só existem no detalhe. Ler a ficha
 * da linha da lista devolveria blocos vazios que pareceriam a verdade.
 */
export interface SaleDetail extends Sale {
  subtotal_cents: number;
  discount_cents: number;
  surcharge_cents: number;
  seller_id: string | null;
  note: string | null;
  items: {
    id: string;
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
  }[];
  payments: { id: string; method: string; amount_cents: number; status: string }[];
  /** Quanto do vale do cliente cobriu esta venda — positivo, zero quando nenhum. */
  customerCreditCents: number;
  removedItems: SaleRemovedItem[];
  /**
   * OS TÍTULOS QUE ESTA VENDA GEROU — a volta da rastreabilidade (V22).
   *
   * `SalesService` já os acrescentava à resposta, com teste de servidor verde,
   * e o tipo não declarava o campo: o dado chegava ao navegador e morria ali.
   * A única ocorrência de `financeEntries` em `src/` inteiro estava em mocks
   * de teste — rota sem tela.
   *
   * Vem NA PRÓPRIA FICHA, e não de uma segunda consulta: é a mesma pergunta
   * (`originType='sale'` + `originId`) que a tela de Contas faz na ida, e o
   * servidor já a respondeu aqui. Venda cancelada devolve lista vazia, e isso
   * é o certo: cancelada não é um estado da conta — é a conta não existir.
   */
  financeEntries: FinanceEntry[];
}

export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  active: number;
  /** Quantos produtos usam este nome hoje. */
  usage: number;
  children?: Category[];
}

export interface Brand {
  id: string;
  name: string;
  active: number;
  usage: number;
}

export interface Taxonomy {
  categories: Category[];
  brands: Brand[];
  /** Valores escritos em produtos que ainda não estão na lista. */
  orphans: { categories: string[]; subcategories: string[]; brands: string[] };
}

// ------------------------------------------------- auxiliares do catálogo

export interface Unidade {
  id: string;
  code: string;
  name: string;
  /** Casas decimais aceitas na quantidade. Caixa é 0; quilo é 3. */
  decimals: number;
  active: number;
  usage: number;
}

export interface GrupoTributario {
  id: string;
  code: string;
  name: string;
  regime: string;
  ncm: string | null;
  cest: string | null;
  cfop_internal: string | null;
  cfop_external: string | null;
  origin: string | null;
  cst_icms: string | null;
  csosn: string | null;
  /**
   * Alíquota de crédito do Simples, exigida pelos CSOSN 101 e 201.
   *
   * Estava no servidor e faltava aqui — e a tela de Auxiliares, que grava o
   * grupo INTEIRO a cada salvar, o apagava por não conhecê-lo.
   */
  p_cred_sn: string | null;
  cst_pis: string | null;
  cst_cofins: string | null;
  /**
   * CST do IPI na saída (GAP-V08). Nulo = a operação não destaca IPI, que é o
   * padrão do varejo do Simples — e o que o XML de hoje faz.
   */
  cst_ipi: string | null;
  /** Código da alíquota de IPI (core_tax_rates, kind 'ipi') usada pelo grupo. */
  ipi_rate_code: string | null;
  /** Código da alíquota de ICMS (kind 'icms') — lida nos CST 00, 20 e 90 (GAP-PRD-021). */
  icms_rate_code: string | null;
  /** Percentual de redução da base do ICMS: obrigatório no CST 20, opcional no 90. */
  p_red_bc: string | null;
  /** Código da alíquota do FCP (kind 'fcp'), somada ao ICMS próprio. */
  fcp_rate_code: string | null;
  /** Código de benefício fiscal da UF (cBenef), 8 ou 10 caracteres. */
  c_benef: string | null;
  active: number;
  usage: number;
}

export interface Aliquota {
  id: string;
  code: string;
  name: string;
  kind: string;
  percent: number;
  active: number;
}

export interface TabelaDePreco {
  id: string;
  name: string;
  percent_off: number;
  active: number;
  items: number;
  /**
   * Quantos clientes compram por esta tabela.
   *
   * É o campo que faz a tela de tabelas parar de prometer uma regra sem mostrar
   * efeito nenhum: até esta rodada ela explicava a negociação de atacado e não
   * havia como saber se alguém usava. É também o número que a recusa de
   * exclusão e a de desativação citam — vem da MESMA contagem do servidor, para
   * que a lista e a mensagem de erro não discordem.
   */
  customers: number;
}

export interface CatalogAux {
  units: Unidade[];
  taxGroups: GrupoTributario[];
  taxRates: Aliquota[];
  priceTables: TabelaDePreco[];
}

/**
 * Um preço FIXADO numa tabela — a exceção por item que ganha do percentual.
 *
 * É assim que se negocia: a tabela dá 15% em tudo, MENOS naquele item que foi
 * combinado a um valor fechado. O servidor (`priceInTable`) sempre cumpriu essa
 * regra na venda; o que faltava era a tela conseguir FIXAR e LISTAR o combinado
 * — sem esta lista, o preço fixado só aparecia no cupom, que é tarde demais.
 *
 * `base_price_cents` é o preço de cadastro do produto, para a tela mostrar o
 * "de/por" do combinado sem refazer conta nenhuma.
 */
export interface PrecoFixado {
  product_id: string;
  price_cents: number;
  updated_at: string;
  product_name: string;
  internal_code: string;
  barcode: string | null;
  base_price_cents: number;
}

// ------------------------------------------- o carrinho reprecificado no servidor

/**
 * De ONDE saiu o preço que está valendo — o mesmo vocabulário do
 * `PricingService`.
 *
 * A tela precisa disto para não reimplementar a regra: `'aberto'` é a única
 * resposta que ela interpreta, e interpreta para NÃO fazer nada (ver
 * `pdvReprecificacao`). Os outros três valores servem para explicar o número ao
 * operador, nunca para decidi-lo.
 */
export type FontePreco = 'cadastro' | 'promocao' | 'tabela' | 'faixa' | 'aberto';

/**
 * Uma faixa de preço por quantidade — "a partir de 3, sai por R$ 10" (V04).
 *
 * O preço é UNITÁRIO, não o do combo: o carrinho multiplica por quantidade em
 * todo lugar, e um preço de combo obrigaria cada tela a lembrar de não
 * multiplicar.
 */
export interface FaixaDePreco {
  id: string;
  product_id: string;
  min_quantity: number;
  price_cents: number;
  active: number;
}

/**
 * Um campo personalizado com o valor DESTE produto (GAP-V07).
 *
 * A definição vem sempre, com valor nulo quando ninguém preencheu: o formulário
 * precisa mostrar o campo vazio para que alguém possa preenchê-lo.
 */
export interface ValorPersonalizado {
  field_id: string;
  code: string;
  label: string;
  kind: string;
  /** Opções do tipo 'select', uma por linha. Nulo nos outros tipos. */
  options: string | null;
  value: string | null;
}

/** A definição de um campo personalizado da operação. */
export interface CampoPersonalizado {
  id: string;
  code: string;
  label: string;
  kind: string;
  options: string | null;
  entity: string;
  position: number;
  active: number;
  /** Quantos produtos já têm este campo preenchido. */
  usage: number;
}

/** Uma alteração de campo na trilha do produto — de → para (GAP-V05). */
export interface MudancaDeCampo {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

/**
 * Uma linha do histórico do produto.
 *
 * `fields` VAZIO é resposta honesta e não erro: as alterações gravadas antes
 * desta rodada não registravam o que mudou, e não há como recuperar.
 */
export interface EventoDoProduto {
  id: string;
  action: string;
  created_at: string;
  user_id: string | null;
  user_name: string | null;
  fields: MudancaDeCampo[];
  /**
   * O que aconteceu, em uma frase, quando o evento não é "campo de → para"
   * (cadastro, EAN gerado, foto…). Nulo = nada além do nome da ação.
   */
  resumo?: string | null;
}

export interface LinhaPrecificada {
  productId: string;
  /** O que vale agora, para ESTE cliente. */
  priceCents: number;
  /** O preço de cadastro, para a tela poder mostrar o "de/por". */
  listPriceCents: number;
  onSale: boolean;
  fonte: FontePreco;
}

/**
 * A resposta de `POST /core/pricing/cart`.
 *
 * `items` traz uma linha por produto RECONHECIDO. Produto inexistente ou
 * inativo é OMITIDO — e omissão significa "mantenha a linha como está", não
 * "zere". Quem recusa a venda de um produto que sumiu é a venda, com a mensagem
 * que nomeia o produto; derrubar a reprecificação inteira por causa de uma
 * linha órfã deixaria o operador sem preço nenhum nas outras.
 */
export interface CarrinhoPrecificado {
  items: LinhaPrecificada[];
  /**
   * A condição comercial do cliente, uma vez para o carrinho inteiro.
   *
   * Nula quando não há cliente, quando ele não tem tabela, ou quando a tabela
   * dele foi desativada. A tela mostra isto porque, sem o aviso, o operador vê
   * os preços caírem sozinhos ao escolher o cliente e a primeira reação é achar
   * que errou de tecla.
   */
  priceTable: { id: string; name: string; percentOff: number } | null;
}

export interface ComponenteDoKit {
  id: string;
  component_id: string;
  name: string;
  internal_code: string;
  unit: string;
  quantity: number;
  cost_cents: number;
}

/**
 * O que o servidor responde sobre um preço.
 *
 * `markupPercent` e `margemPercent` são `null` quando não há do que calcular —
 * custo zero não vira markup zero, que afirmaria "vendo pelo custo".
 */
export interface AvaliacaoPreco {
  priceCents: number;
  markupPercent: number | null;
  margemPercent: number | null;
  abaixoDoCusto: boolean;
  abaixoDoMinimo: boolean;
  motivos: string[];
}

export interface MailInbox {
  id: string;
  address: string;
  host: string;
  port: number;
  secure: number;
  username: string;
  folder: string;
  active: number;
  last_check_at: string | null;
  last_error: string | null;
  /** O que fazer com a mensagem depois de processada (GAP-PRD-035). */
  after_read?: MailAfterRead;
  processed_folder?: string | null;
  /** Quantas ficaram na caixa depois da última leitura. */
  imap_pending?: number | null;
  /** Tipo da última falha (GAP-PRD-128). */
  last_error_kind?: 'credencial' | 'pasta' | 'conexao' | null;
  /** Última vez que a conexão funcionou (leitura ou teste). */
  last_ok_at?: string | null;
}

/** 'lida' marca como lida (padrão), 'mover' leva para uma pasta, 'manter' não mexe. */
export type MailAfterRead = 'lida' | 'mover' | 'manter';

export interface MailInboxStatus {
  configured: boolean;
  /**
   * Nunca 'HOMOLOGATED': depende de credencial do provedor, que é do usuário.
   * CREDENTIAL_REJECTED e CONNECTION_FAILING vêm da última tentativa (GAP-PRD-128).
   */
  readiness: 'READY_FOR_CREDENTIAL' | 'CONFIGURED' | 'CREDENTIAL_REJECTED' | 'CONNECTION_FAILING';
  message: string;
  inbox: MailInbox | null;
}

/** "Testar conexão": entra, abre a pasta e sai — sem ler nota (GAP-PRD-128). */
export interface MailConnectionTest {
  ok: boolean;
  mensagens: number | null;
  naoLidas: number | null;
  tipo: 'credencial' | 'pasta' | 'conexao' | null;
  message: string;
  status: MailInboxStatus;
}

/** Uma leitura da caixa (GAP-PRD-035): quantas foram tratadas e quantas restam. */
export interface MailCheckResult {
  checked: number;
  results: MailMessage[];
  restantes?: number;
  depoisDeLer?: MailAfterRead;
  avisos?: string[];
}

export interface MailSchedule {
  autoEnabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastResult: string | null;
  nextRunAt: string | null;
  /** Preenchido enquanto uma leitura está em curso. */
  lockedUntil: string | null;
}

export interface MailMessage {
  id: string;
  subject: string | null;
  sender: string | null;
  received_at: string | null;
  outcome: 'importado' | 'duplicado' | 'sem_xml' | 'invalido' | 'recusado' | 'frete' | 'ilegivel';
  detail: string | null;
  note_id: string | null;
  access_key: string | null;
  created_at: string;
}

export interface OperationSummary {
  companyId: string;
  tradeName: string;
  salesCount: number;
  revenueCents: number;
  averageTicketCents: number;
  returnsCents: number;
  /** Faturamento menos devoluções: o que de fato ficou. */
  netCents: number;
  /**
   * A parte da loja online (GAP-PRD-132) — já incluída em vendas e
   * faturamento. Opcional: servidor anterior não manda.
   */
  onlineOrdersCount?: number;
  onlineRevenueCents?: number;
}

export type OperationTotals = Omit<OperationSummary, 'companyId' | 'tradeName'>;

export interface InsightProduct {
  name: string;
  internal_code: string | null;
  quantity: number;
  revenue_cents: number;
  operations: number;
}

export interface MarginSummary {
  /** Linhas com custo GRAVADO NA VENDA — a mesma régua do CMV do DRE (GAP-PRD-086). */
  consideredItems: number;
  /** Itens fora do cálculo por terem sido vendidos sem custo cadastrado. */
  skippedNoCost: number;
  /**
   * Itens sem custo gravado (venda anterior ao snapshot, ou serviço). Opcional
   * só para servidor antigo.
   */
  skippedBeforeSnapshot?: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  /** NULO quando não há base — diferente de margem zero. */
  marginPercent: number | null;
}

export interface WorkshopCapabilities {
  kanban: boolean;
  parts: boolean;
  /** Plaquinha com QR. Só onde o aparelho fica. */
  equipmentTags: boolean;
}

export interface Workshop {
  id: string;
  slug: string;
  name: string;
  kind: string;
  capabilities: WorkshopCapabilities;
}

export interface WorkshopMember {
  id: string;
  user_id: string;
  role: string;
  display_name: string;
  login: string;
}

/** Em nome de quem uma bancada imprime. Nulo é "em nome próprio". */
export interface WorkshopBrand {
  workshopId: string;
  workshopName: string;
  brandCompanyId: string | null;
  brandName: string | null;
}

export interface StorefrontSettings {
  company_id: string;
  headline: string | null;
  description: string | null;
  whatsapp: string | null;
  banner_text: string | null;
  banner_active: number;
  logo_url?: string | null;
  cover_url?: string | null;
  /** Em quantas vezes a loja ANUNCIA que vende. Nulo = não anuncia (rodada 56). */
  installments_max?: number | null;
}

export interface StorefrontAdminProduct {
  id: string;
  name: string;
  internal_code: string;
  price_cents: number;
  publish_online: number;
  featured_online: number;
}

export interface BankStatement {
  id: string;
  account_label: string;
  period_start: string | null;
  period_end: string | null;
  line_count: number;
  matched_count: number;
  created_at: string;
}

export interface BankLine {
  id: string;
  occurred_at: string;
  description: string;
  /** Com sinal: positivo entrou, negativo saiu. */
  amount_cents: number;
  document: string | null;
  matched_settlement_id: string | null;
  /**
   * Quando e por QUEM a linha foi casada.
   *
   * O servidor já resolvia os dois (`listLines` faz o JOIN com `core_users`) e
   * o tipo do cliente os descartava — a tela não tinha como mostrar o autor da
   * conferência nem como oferecer o "Desfazer" só a quem tem o que desfazer.
   */
  matched_at?: string | null;
  matched_by_name?: string | null;
}

/** Uma página da lista do extrato, com o que ficou de fora dela (GAP-PRD-177). */
export interface PaginaDoExtrato<T> {
  items: T[];
  /** Quantas existem no filtro — não só as desta página. */
  total: number;
  limit: number;
  offset: number;
  /** Há mais linhas além das devolvidas. */
  truncated: boolean;
}

export interface BankSettlementSuggestion {
  id: string;
  amount_cents: number;
  settled_at: string;
  method: string | null;
  entry_description: string;
}

export type BankDivergenceKind =
  | 'no_extrato_sem_baixa'
  | 'baixado_sem_extrato'
  | 'valor_divergente';

export interface BankReconciliationReport {
  period: { from: string | null; to: string | null };
  bankTotalCents: number;
  financeTotalCents: number;
  differenceCents: number;
  matched: number;
  divergences: {
    kind: BankDivergenceKind;
    occurredAt: string;
    description: string;
    bankCents: number | null;
    financeCents: number | null;
    differenceCents: number;
    lineId: string | null;
    settlementId: string | null;
  }[];
}

export interface WorkshopPart {
  id: string;
  internal_code: string;
  barcode: string | null;
  name: string;
  unit: string;
  price_cents: number;
  /** Ausente para mecânico e técnico — o servidor remove, não esconde. */
  cost_cents?: number;
  min_stock: number;
  workshop_id: string | null;
  workshop_name: string | null;
  stock_quantity: number;
  reserved: number;
  available: number;
  below_minimum: boolean;
  /** Onde a peça mora na oficina: "Prateleira A3 - Caixa 2". */
  storage_location: string | null;
}

/** O documento que prova a entrada da peça. Sem ele, a peça não entra. */
export interface DocumentoDeEntrada {
  numero: string;
  fornecedor?: string | null;
  valorTotalCents?: number | null;
}

/** A resposta do leitor: a peça, ou o código para cadastrar. */
export interface ResultadoDoScan {
  encontrada: WorkshopPart | null;
  codigo: string;
  /** A peça existe, mas é de bancada fora do alcance de quem bipou. */
  foraDoAlcance: boolean;
}

/**
 * O que a conversão de tipo MUDA, além do tipo. Espelha
 * `EfeitosDaConversao` do servidor.
 *
 * Cada campo é uma frase que a tela precisa dizer: sem isto a conversão seria
 * silenciosa — o produto sairia da vitrine, perderia o destaque e mudaria de
 * dono do saldo, e a tela só mostraria "salvo".
 */
export interface EfeitosDaConversao {
  despublicadoDaLoja: boolean;
  destaqueRemovido: boolean;
  /**
   * Quantidade que passa a ser contada do outro lado. NÃO é movimento, e é o
   * saldo BRUTO — parte dele pode estar prometida, ver abaixo.
   */
  saldoQueMudaDeLado: number;
  /**
   * O pedaço desse saldo que já está reservado: pedido da loja, orçamento ou
   * locação. A OS não consegue consumi-lo, então o aviso precisa dizê-lo.
   */
  reservadoEmAberto: number;
  vendasAnteriores: number;
  /** Peça a zero entra na OS por R$ 0,00 — e o lançamento passou a recusar. */
  semPrecoDeVenda: boolean;
}

/**
 * A linha do produto NÃO vem aqui, de propósito.
 *
 * As duas telas que convertem releem o produto pelo caminho normal logo depois
 * — precisam do resto do cadastro junto —, então um `product` na resposta seria
 * campo com escritor e sem leitor, que é o defeito que esta rodada existe para
 * não repetir.
 */
export interface ResultadoDoTipo {
  kind: string;
  workshopId: string | null;
  workshopName: string | null;
  efeitos: EfeitosDaConversao;
  /** Frase pronta do servidor, ou nulo quando nada mudou de fato. */
  aviso: string | null;
}

export type RentalStatus = 'aberto' | 'devolvido' | 'cancelado';

export interface RentalContract {
  id: string;
  number: number;
  customer_id: string;
  customer_name?: string;
  status: RentalStatus;
  starts_at: string;
  ends_at: string;
  returned_at: string | null;
  total_cents: number;
  deposit_cents: number;
  cancel_reason: string | null;
  /** Calculado a cada leitura — estado gravado envelheceria sozinho. */
  atrasado: boolean;
}

export interface RentalContractDetail extends RentalContract {
  customer: { name: string; phone: string | null } | null;
  items: {
    id: string;
    product_id: string;
    name: string;
    internal_code: string;
    quantity: number;
    returned_quantity: number;
    unit_cents: number;
  }[];
}

export interface LoyaltyProgram {
  active: number;
  /** Quantos centavos de compra valem 1 ponto. */
  cents_per_point: number;
  /** Quanto 1 ponto vale de desconto. */
  point_value_cents: number;
  min_points_to_redeem: number;
}

/** O que a loja DEVE em desconto. É passivo, não receita. */
export interface LoyaltyLiability {
  points: number;
  estimatedCents: number;
  customers: number;
}

export interface LoyaltyEntry {
  id: string;
  kind: 'earn' | 'redeem' | 'reversal' | 'adjustment';
  points: number;
  description: string;
  sale_number: number | null;
  created_at: string;
}

/**
 * Uma linha da razão de CRÉDITO DE LOJA (GAP-V10/V47).
 *
 * `amount_cents` vem COM SINAL: positivo concede, negativo consome. O saldo é a
 * soma — não existe total guardado à parte, nem no servidor nem aqui.
 *
 * A origem é polimórfica e navegável: a concessão traz `return_number` (a
 * devolução que a gerou) e o resgate traz `sale_number` (a venda que a gastou).
 * O outro vem nulo — cada linha aponta para UM dos dois.
 */
export interface CustomerCreditEntry {
  id: string;
  kind: 'grant' | 'redeem' | 'reversal';
  amount_cents: number;
  origin_type: 'sale_return' | 'sale';
  origin_id: string;
  description: string;
  return_number: number | null;
  sale_number: number | null;
  created_at: string;
}

export interface CustomerCreditStatement {
  balance: number;
  entries: CustomerCreditEntry[];
}

export type LeadStatus = 'novo' | 'em_contato' | 'qualificado' | 'convertido' | 'perdido';

export interface Lead {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  document: string | null;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  /** Preenchido na conversão — é o vínculo com o cadastro de verdade. */
  customer_id: string | null;
  customer_name?: string | null;
  converted_at: string | null;
  lost_reason: string | null;
  created_at: string;
}

export type OpportunityStatus = 'aberta' | 'ganha' | 'perdida';

export interface Opportunity {
  id: string;
  lead_id: string | null;
  customer_id: string | null;
  lead_name: string | null;
  customer_name: string | null;
  title: string;
  /** ESTIMADO. Não é receita e não entra no financeiro. */
  amount_cents: number;
  status: OpportunityStatus;
  expected_close_at: string | null;
  lost_reason: string | null;
  sale_number: number | null;
  created_at: string;
}

export interface CrmSummary {
  leads: Record<LeadStatus, number>;
  opportunities: {
    abertas: number;
    /** Estimativa do que está em negociação. Não é faturamento. */
    abertoEstimadoCents: number;
    ganhas: number;
    ganhoCents: number;
  };
}

export type InventoryCountStatus = 'aberta' | 'aplicada' | 'cancelada';

export interface InventoryCount {
  id: string;
  number: number;
  status: InventoryCountStatus;
  scope_note: string | null;
  opened_at: string;
  applied_at: string | null;
  apply_reason: string | null;
  cancel_reason: string | null;
  /**
   * O LOCAL CONTADO (GAP-PRD-167). Nulo = a empresa inteira. Opcionais porque
   * servidor anterior não os devolve.
   */
  location_id?: string | null;
  location_code?: string | null;
  location_name?: string | null;
}

export interface InventoryCountDetail extends InventoryCount {
  items: {
    id: string;
    product_id: string;
    name: string;
    internal_code: string;
    /**
     * Os códigos de barras ADICIONAIS do produto, separados por espaço — o
     * filtro e o bipe da contagem também os acham (B-estoque-entrada-16).
     * Opcional: servidor anterior não os manda.
     */
    extra_barcodes?: string | null;
    barcode: string | null;
    /** Saldo congelado quando o item entrou na contagem. */
    expected_quantity: number;
    /** NULO enquanto ninguém contou. Nulo não é zero. */
    counted_quantity: number | null;
    /**
     * QUEM contou, pelo nome — a pergunta de quem investiga 40 peças
     * faltando. A coluna `counted_by` sempre foi gravada; o nome sai de um
     * JOIN com `core_users` no servidor. Nulo enquanto ninguém contou, e
     * opcional porque a resposta anterior à rodada 32 não o trazia.
     */
    counted_by_name?: string | null;
  }[];
  resumo: {
    total: number;
    contados: number;
    pendentes: number;
    divergentes: number;
    sobra: number;
    falta: number;
  };
}

export type RefundMethod = 'dinheiro' | 'credito' | 'estorno_cartao' | 'pix';

/**
 * Uma peça identificada que saiu nesta venda e ainda está com o cliente.
 *
 * A identidade nasce nula de propósito (a nota traz "3 motos" muito antes de
 * alguém ir ao pátio ler os chassis), então todos os números são anuláveis e a
 * tela precisa ter o que dizer quando não há nenhum.
 */
export interface ReturnableUnit {
  id: string;
  serial_number: string | null;
  chassis: string | null;
  motor_number: string | null;
  imei: string | null;
  plate: string | null;
}

export interface ReturnableItem {
  sale_item_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  /** O preço de tabela da linha na venda — o pago por unidade sai do líquido. */
  unit_price_cents?: number;
  total_cents: number;
  /**
   * O que o cliente pagou por esta linha: o total dela menos a parte que lhe
   * cabe do desconto do rodapé (GAP-PRD-009). É daqui que sai o valor da
   * devolução — ver `valorDaDevolucaoDaLinha`.
   */
  net_total_cents?: number;
  /** Quanto deste item já voltou em devoluções anteriores. */
  returned_quantity: number;
  /** Quanto DINHEIRO deste item já voltou — a próxima parcela desconta daqui (GAP-PRD-050). */
  returned_cents?: number;
  /** 1 quando o produto é controlado por unidade: aí a tela escolhe QUAL peça. */
  serialized: number;
  /**
   * As peças desta venda que ainda podem voltar.
   *
   * Vazia para produto não serializado. O servidor EXIGE a escolha quando é
   * serializado — devolver "uma qualquer" registra a moto errada como devolvida.
   */
  units: ReturnableUnit[];
}

/**
 * A DEVOLUÇÃO EM DUAS ETAPAS (Preço Justo): a devolução registra a mercadoria e
 * o valor devolvível; o reembolso é registrado depois, pelo que aconteceu.
 */
export type FluxoDaDevolucao = 'imediato' | 'duas_etapas';
export type SituacaoDoReembolso = 'pendente' | 'parcial' | 'concluido' | 'nao_se_aplica';
export type MeioDoReembolso = 'dinheiro' | 'pix' | 'debito' | 'credito' | 'vale';

export interface ResumoDoReembolso {
  fluxo: FluxoDaDevolucao;
  devolvivelCents: number;
  reembolsadoCents: number;
  pendenteCents: number;
  situacao: SituacaoDoReembolso;
}

export interface RegistroDeReembolso {
  id: string;
  method: MeioDoReembolso;
  amount_cents: number;
  /** Como a venda foi paga, quando o reembolso saiu por outro meio. */
  original_method: string | null;
  method_justification: string | null;
  reference: string | null;
  note: string | null;
  cash_session_id: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
}

export interface MeioDaVendaParaReembolso {
  method: MeioDoReembolso;
  recebidoCents: number;
  reembolsadoCents: number;
  disponivelCents: number;
}

export interface EstadoFiscalDaDevolucao {
  estado: 'nao_fiscal' | 'pendente_regularizacao' | 'nfce_pendente' | 'nfce_cancelada' | 'nfce_rejeitada';
  rotulo: string;
  detalhe: string;
  documentoStatus: string | null;
}

export interface SaleReturn {
  id: string;
  number: number;
  sale_id: string;
  sale_number: number;
  reason: string;
  total_cents: number;
  /** 'em_etapas' na devolução em duas etapas: o dinheiro volta pelos reembolsos. */
  refund_method: RefundMethod | 'em_etapas';
  created_at: string;
  refund_flow?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  /** Pendente, parcial ou concluído — a devolução imediata vem concluída. */
  reembolso?: ResumoDoReembolso;
}

export interface SaleReturnDetail extends SaleReturn {
  items: {
    id: string;
    sale_item_id: string;
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    /** 0 quando a peça não voltou ao estoque vendável (defeito). */
    restock: number;
    /** intacto | defeituoso | quebrado | avariado | improprio */
    item_condition?: string | null;
  }[];
  created_by_name?: string | null;
  approved_by_name?: string | null;
  mercadoria?: { situacao: string; estoque: 'retornou' | 'nao_retornou' | 'parcial' | 'sem_itens' };
  reembolso?: ResumoDoReembolso & {
    registros: RegistroDeReembolso[];
    meiosDaVenda: MeioDaVendaParaReembolso[];
    sugestao: { method: MeioDoReembolso; cents: number }[];
  };
  fiscal?: EstadoFiscalDaDevolucao;
}

/** A venda que está sendo devolvida — o que a tela mostra antes dos itens. */
export interface VendaParaDevolucao {
  id: string;
  number: number;
  created_at: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  surcharge_cents: number;
  total_cents: number;
  change_cents: number;
  customer_id: string | null;
  customer_name: string | null;
  seller_name: string | null;
  operator_name: string | null;
  payments: { method: string; amount_cents: number; status: string }[];
  customerCreditCents: number;
  fiscal: EstadoFiscalDaDevolucao;
  devolucoes: SaleReturn[];
}

/**
 * Transportadora fiscal da nota de ENTRADA.
 *
 * Não confundir com a logística de saída do e-commerce (Melhor Envio,
 * Correios), que vive em `getLogisticsCarriers` e é outro domínio.
 */
export interface Carrier {
  id: string;
  name: string;
  trade_name: string | null;
  document: string | null;
  state_registration: string | null;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
  active: number;
  created_at: string;
}

export interface CarrierInput {
  name: string;
  tradeName?: string | null;
  document?: string | null;
  stateRegistration?: string | null;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
}

/** O que esta transportadora já trouxe — a resposta na hora da avaria. */
export interface CarrierHistory {
  noteCount: number;
  volumesQty: number;
  notes: {
    id: string;
    number: string | null;
    issued_at: string | null;
    total_cents: number;
    supplier_name: string | null;
    volumes_qty: number | null;
    vehicle_plate: string | null;
  }[];
}

/**
 * O que a loja decide uma vez e vale para toda nota que entrar.
 *
 * `defaultSaleCfop` nulo mantém o comportamento antigo: o produto criado pela
 * entrada herda o CFOP do fornecedor.
 */
export interface InboundConfig {
  companyId: string;
  defaultSaleCfop: string | null;
}

/**
 * A política comercial do balcão — o que o operador faz sem chamar o dono.
 *
 * O servidor NUNCA devolve nulo aqui: os três números já vêm resolvidos contra
 * o padrão do sistema. Quem calcula não precisa saber de onde veio cada um.
 *
 * Quem MOSTRA precisa, e é para isso que existe `definidos`. Sem ele a tela
 * exibiria "10" num campo e o dono não teria como distinguir "eu escolhi 10"
 * de "ninguém configurou e o sistema usa 10" — que é a diferença entre uma
 * política decidida e uma política herdada. Ele jurando que configurou 5%
 * enquanto o balcão dá 10% é exatamente o sintoma que esta rodada evita.
 */
export interface PoliticaDeVenda {
  discountLimitPercent: number;
  creditSaleDueDays: number;
  reservationValidDays: number;
  /**
   * Teto da sangria em CENTAVOS — e o único campo desta política que é nulo.
   *
   * Nulo significa SEM TETO, e não "zero". O tipo tem de carregar essa
   * diferença porque ela é oposta: zero é a decisão de que toda sangria chama
   * o gestor, e nulo é a decisão de que nenhuma chama. Um `number` com zero
   * como ausência trocaria "pode tudo" por "não pode nada" no dia em que
   * alguém lesse o campo sem ler este comentário — que é o mesmo argumento
   * escrito em `SalePolicyService`, do outro lado do fio.
   */
  cashWithdrawalLimitCents: number | null;
  /**
   * A OS da oficina pode ser faturada a prazo (GAP-PRD-104). Opcional porque
   * servidor anterior ao campo não o devolve — e ausente lê como desligado.
   */
  workshopCreditEnabled?: boolean;
  /**
   * A liberação de desconto exige MOTIVO digitado (P0 da Preço Justo).
   * Opcional porque servidor anterior ao campo não o devolve.
   */
  discountReasonRequired?: boolean;
  /** Os limites de desconto por perfil gravados nesta operação (P0). */
  limitesPorPerfil?: LimiteDeDescontoDoPerfil[];
  /** Os perfis que ACEITAM limite próprio — é a lista de linhas da tela. */
  perfisComLimite?: string[];
  definidos: {
    discountLimitPercent: boolean;
    creditSaleDueDays: boolean;
    reservationValidDays: boolean;
    /**
     * Aqui `definido` não separa "escolhi" de "herdei do padrão", como nos
     * outros três: separa "escolhi um teto" de "NÃO HÁ TETO". Este campo não
     * tem padrão de sistema para herdar, e é por isso que a tela precisa
     * dizer, com todas as letras, que vazio é ausência de trava.
     */
    cashWithdrawalLimitCents: boolean;
    workshopCreditEnabled?: boolean;
    discountReasonRequired?: boolean;
  };
}

/**
 * O LIMITE DE DESCONTO DE UM PERFIL (P0 da Preço Justo) — como o servidor
 * guarda: percentuais em pontos, valores em CENTAVOS. Nulo = sem este teto,
 * com a exceção que o servidor aplica: `maxPercent` nulo num perfil sem alçada
 * é o limite da operação.
 */
export interface LimiteDeDescontoDoPerfil {
  profileCode: string;
  maxPercent: number | null;
  maxCents: number | null;
  itemMaxPercent: number | null;
  itemMaxCents: number | null;
}

/** Os quatro tetos que valem para QUEM está logado (GET /sales/discount-policy). */
export interface LimiteEfetivoDeDesconto {
  percentual: number | null;
  valorCents: number | null;
  itemPercentual: number | null;
  itemValorCents: number | null;
  doPerfil: boolean;
}

/**
 * O que o servidor manda junto do 403 de desconto acima da alçada.
 *
 * É o corpo de `CORE_DISCOUNT_NEEDS_AUTHORIZATION`, e o motivo de ele ser
 * tipado aqui é que a tela do PDV precisa MOSTRAR estes números. `origens`
 * nasceu no servidor para dizer de onde veio cada centavo concedido; se
 * nenhuma tela ler, é campo sem leitor — o defeito que este projeto já pagou
 * caro duas vezes.
 */
export interface DetalheDeConcessao {
  percentual: number;
  concedidoCents: number;
  brutoCents: number;
  origens: { cabecalho: number; itens: number; precoRebaixado: number };
  /**
   * O teto em % de quem está no balcão. NULO quando o perfil não tem teto em
   * percentual — só em valor ou por item (P0 da Preço Justo). Era lido como
   * zero, e a tela mostraria "limite 0%" para quem não tem limite em %.
   */
  limite: number | null;
}

/**
 * Lê o detalhe do 403 sem confiar em que ele venha.
 *
 * `ApiRequestError.details` é `unknown` de propósito: é corpo de rede. Uma
 * versão anterior do servidor, um proxy que engoliu o corpo ou um erro de
 * outra origem com o mesmo código deixariam a tela lendo `undefined.origens` e
 * quebrando o PDV em cima de uma venda que só precisava de liberação. Devolve
 * nulo, e quem chama mostra a mensagem do servidor sozinha.
 */
export function detalheDeConcessao(details: unknown): DetalheDeConcessao | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  const origens = d.origens as Record<string, unknown> | undefined;
  if (!origens || typeof origens !== 'object') return null;
  const numero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    percentual: numero(d.percentual),
    concedidoCents: numero(d.concedidoCents),
    brutoCents: numero(d.brutoCents),
    origens: {
      cabecalho: numero(origens.cabecalho),
      itens: numero(origens.itens),
      precoRebaixado: numero(origens.precoRebaixado),
    },
    // Ausente ou nulo NÃO é zero: quem lê cai no limite que já conhece.
    limite: typeof d.limite === 'number' && Number.isFinite(d.limite) ? d.limite : null,
  };
}

/**
 * O que vem junto do 403 de sangria acima do teto.
 *
 * É o corpo de `CORE_WITHDRAWAL_NEEDS_AUTHORIZATION`. Existe pelo mesmo motivo
 * de `DetalheDeConcessao`: o modal do caixa precisa MOSTRAR os dois números
 * para que o gestor saiba o que está assinando. "Passa do teto" sem dizer de
 * quanto é a mesma senha digitada no escuro que esta rodada foi consertar no
 * PDV.
 */
export interface DetalheDeSangria {
  tetoCents: number;
  pedidoCents: number;
}

/**
 * Lê o detalhe do 403 da sangria sem confiar em que ele venha.
 *
 * Mesma postura de `detalheDeConcessao`, e pelo mesmo motivo: `details` é
 * corpo de rede. Um proxy que engoliu o corpo deixaria a tela lendo
 * `undefined.tetoCents` e quebrando a gaveta em cima de uma retirada que só
 * precisava de liberação. Devolve nulo, e quem chama mostra a mensagem do
 * servidor sozinha — que já traz os dois valores por extenso.
 *
 * `tetoCents` ZERO é resposta legítima e passa: é a operação que decidiu que
 * toda sangria chama o gestor. Recusá-lo aqui apagaria justamente a
 * configuração mais restritiva.
 */
export function detalheDeSangria(details: unknown): DetalheDeSangria | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  const numero = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const teto = numero(d.tetoCents);
  const pedido = numero(d.pedidoCents);
  if (teto === null || pedido === null) return null;
  return { tetoCents: teto, pedidoCents: pedido };
}

export interface Supplier {
  id: string;
  name: string;
  trade_name: string | null;
  document: string | null;
  state_registration: string | null;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  zip: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  /** Dias para pagar depois do recebimento — alimenta o vencimento da dívida. */
  payment_term_days: number;
  /** Dias entre o pedido e a entrega — alimenta a previsão do pedido. */
  delivery_days: number;
  notes: string | null;
  active: number;
  created_at: string;
}

export interface SupplierInput {
  name: string;
  tradeName?: string | null;
  document?: string | null;
  stateRegistration?: string | null;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  zip?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  paymentTermDays?: number;
  deliveryDays?: number;
  notes?: string | null;
}

export interface SupplierHistory {
  notes: {
    id: string;
    access_key: string;
    number: string | null;
    total_cents: number;
    received_at: string | null;
  }[];
  totalCents: number;
  noteCount: number;
  lastPurchaseAt: string | null;
  openPayableCents: number;
}

export type PurchaseOrderStatus =
  | 'rascunho'
  | 'enviado'
  | 'recebido_parcial'
  | 'recebido'
  | 'cancelado';

export interface PurchaseOrder {
  id: string;
  number: number;
  supplier_id: string;
  supplier_name?: string;
  supplier_trade_name?: string | null;
  status: PurchaseOrderStatus;
  expected_at: string | null;
  notes: string | null;
  total_cents: number;
  cancel_reason: string | null;
  created_at: string;
}

export interface PurchaseOrderItemInput {
  productId?: string | null;
  description?: string;
  quantity: number;
  unitCostCents: number;
}

/**
 * A nota de entrada como `GET /core/purchases/notes` a lista.
 *
 * Só o que a conciliação usa: identificar a nota (número/série/chave), saber
 * de quem ela veio e em que pé está. A lista NÃO diz a qual pedido a nota já
 * está amarrada — `purchase_order_id` não viaja nessa resposta —, e é por
 * isso que a tela de conciliação oferece como candidata toda nota que não
 * está no pedido aberto: quem decide se a amarração vale é o servidor, que
 * recusa fornecedor errado e reprojeta o pedido que perder a nota.
 */
export interface InboundNoteSummary {
  id: string;
  access_key: string;
  number: string | null;
  series: string | null;
  supplier_name: string | null;
  total_cents: number;
  status: string;
  created_at: string;
  issued_at?: string | null;
  received_at?: string | null;
  /**
   * A ESPÉCIE do documento: 'nfe' (XML do fornecedor) ou 'manual' (compra
   * digitada, sem nota fiscal — GAP-V17). É por ela que a tela rotula a
   * linha como "entrada manual (sem nota fiscal)" em vez de exibir uma
   * chave de acesso que não existe. Opcional porque a resposta anterior à
   * rodada não a trazia — ausente lê-se 'nfe', que é a verdade das antigas.
   */
  doc_type?: string;
  /** Quando a entrada confirmada foi DESFEITA (status 'estornada' — GAP-V20). */
  reversed_at?: string | null;
}

/**
 * O item da nota de entrada — o `NoteItemDetail` do servidor, nome a nome.
 *
 * É a matéria-prima da régua da conciliação: `receivedQuantity` nulo é
 * "ninguém conferiu" (vale o faturado), zero é "conferi e não veio";
 * `conversionFactor` diz quantas unidades do CADASTRO vêm em uma da NOTA —
 * a MESMA régua de `recalcReceived` e `confirmNfe` no servidor.
 */
export interface InboundNoteItem {
  supplierCode: string | null;
  barcode: string | null;
  description: string;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  quantity: number;
  unitTrib: string | null;
  quantityTrib: number | null;
  conversionFactor: number | null;
  unitCostCents: number;
  totalCents: number;
  productId: string | null;
  matchedBy: string | null;
  receivedQuantity: number | null;
  divergenceNote: string | null;
}

export interface PurchaseOrderDetail extends PurchaseOrder {
  supplier: { name: string; trade_name: string | null; document: string | null } | null;
  items: {
    id: string;
    product_id: string | null;
    internal_code: string | null;
    description: string;
    quantity: number;
    unit_cost_cents: number;
    total_cents: number;
    received_quantity: number;
  }[];
  /** Notas de entrada amarradas a este pedido. Nome distinto de `notes`, que é a observação. */
  inboundNotes: {
    id: string;
    access_key: string;
    number: string | null;
    /** A série vem do servidor desde sempre; o tipo é que a omitia. */
    series: string | null;
    total_cents: number;
    status: string;
    received_at: string | null;
    /**
     * A ESPÉCIE do documento — 'nfe' ou 'manual'.
     *
     * É ela que decide a origem do lançamento financeiro ('nfe_entrada' ×
     * 'entrada_manual', GAP-V17). Sem ela na resposta, a ficha do pedido
     * perguntava ao financeiro duas vezes por nota e mantinha na tela uma
     * segunda definição de "o que é entrada manual". Use `origemDaNota`, nunca
     * um `=== 'manual'` escrito de novo aqui.
     */
    doc_type: string | null;
  }[];
}

export interface Printer {
  id: string;
  name: string;
  kind: 'cupom' | 'etiqueta' | 'a4';
  transport: 'browser' | 'agent';
  paper_width_mm: number | null;
  is_default: number;
  active: number;
  /** O caixa cujo agente local imprime nela; nulo = o agente da operação (GAP-PRD-082). */
  pdv_terminal_id?: string | null;
  /** Onde o agente escreve os bytes no computador do caixa (tcp:IP:porta, \\PC\FILA, COM3, LPT1). */
  agent_device?: string | null;
}

/** A situação de cada impressora, como o servidor a vê agora (GAP-PRD-082). */
export interface SituacaoDaImpressora {
  printerId: string;
  name: string;
  kind: Printer['kind'];
  transport: Printer['transport'];
  active: boolean;
  pdvTerminalId: string | null;
  pdvTerminalName: string | null;
  agentDevice: string | null;
  agent: { agentId: string; online: boolean; lastSeenAt: string | null } | null;
  lastTest: { jobId: string; status: string; at: string; error: string | null } | null;
  ready: boolean;
  problem: string | null;
}

export interface PrintJob {
  id: string;
  document_type: string;
  document_id: string;
  printer_id: string | null;
  status: string;
  copies: number;
  attempts: number;
  reprint_of: string | null;
  created_at: string;
  printed_at: string | null;
  /** `agent`: o agente local do caixa imprime e confirma; `browser` (ou ausente): a caixa de diálogo. */
  transport?: 'browser' | 'agent' | null;
  open_drawer?: number;
  /** Por que um job de impressora de agente saiu pelo navegador. */
  fallback_reason?: string | null;
  error?: string | null;
}

export interface ProductImage {
  id: string;
  product_id: string;
  url: string;
  file_name: string | null;
  byte_size: number | null;
  position: number;
  is_primary: number;
  created_at: string;
  /** A miniatura do balcão; nula em foto antiga que ainda não ganhou uma. */
  thumb_url?: string | null;
  thumb_bytes?: number | null;
}

/** Uma foto sem miniatura — a fila do preenchimento (`GET /products/fotos-sem-miniatura`). */
export interface FotoSemMiniatura {
  id: string;
  product_id: string;
  product_name: string;
  url: string;
}

export interface VariantStock {
  totalQuantity: number;
  items: {
    id: string;
    internal_code: string;
    barcode: string | null;
    name: string;
    price_cents: number;
    variant_attributes: string | null;
    active: number;
    /** 1 = o tamanho está à venda (ele ativo E o modelo ativo). */
    vendavel?: number;
    quantity: number;
    reserved: number;
  }[];
}

/** Uma linha da razão de estoque, já pronta para a tela. */
// ------------------------------------------------------ etiquetas e balança

export interface LabelSourceOption {
  id: 'catalogo' | 'estoque' | 'compra' | 'nota' | 'inventario' | 'codigos' | 'grade';
  label: string;
  hint: string;
  temQuantidadeDeDocumento: boolean;
}

export interface LabelFormatOption {
  id: string;
  label: string;
  hint: string;
  midia: 'rolo' | 'folha';
  widthMm: number;
  heightMm: number;
  columns: number;
  rows: number | null;
  campos: string[];
}

/** Um campo que o MODELO de etiqueta pode mostrar. */
export interface CampoDeEtiqueta {
  id: string;
  rotulo: string;
}

/** Um MODELO de etiqueta da loja — geometria em milímetro e o que aparece. */
export interface ModeloDeEtiqueta {
  id: string;
  name: string;
  midia: 'rolo' | 'folha';
  paperWidthMm: number;
  paperHeightMm: number | null;
  widthMm: number;
  heightMm: number;
  columns: number;
  rows: number | null;
  gapXmm: number;
  gapYmm: number;
  marginTopMm: number;
  marginLeftMm: number;
  orientation: 'retrato' | 'paisagem';
  scalePercent: number;
  /**
   * Resolução da impressora do modelo: 203, 300 ou 600 dpi. O servidor
   * arredonda o módulo do código de barras para os pontos dela.
   */
  dpi: number;
  fields: string[];
  priceHighlight: boolean;
  complementText: string | null;
  printerId: string | null;
  printerName: string | null;
  isDefault: boolean;
  /*
    A saída e a impressora física (P0 das etiquetas). Opcionais: um servidor
    antigo não os manda, e o modelo sem eles vale o padrão (navegador, sem
    deslocamento, sem corte, sensor de vão).
  */
  /** Perfil de saída que a tela escolhe por padrão (id de `PerfilDeImpressao`). */
  outputProfile?: string | null;
  /** Calibração em mm (−10 a 10). */
  offsetXmm?: number;
  offsetYmm?: number;
  /** Escurecimento 0–30; nulo = o da impressora. */
  darkness?: number | null;
  /** Velocidade em pol/s; nula = a da impressora. */
  printSpeed?: number | null;
  cutMode?: 'nenhum' | 'cada_etiqueta' | 'fim_do_lote';
  mediaType?: 'vao' | 'marca' | 'continua';
  /** Vão (ou marca preta) entre etiquetas do rolo, em mm; nulo = não informado. */
  mediaGapMm?: number | null;
  /** Avanço de papel depois do lote, em mm. */
  feedAfterMm?: number;
}

export type RascunhoDeModelo = Omit<ModeloDeEtiqueta, 'id' | 'printerName'>;

/** Por onde a etiqueta sai: navegador, driver, PDF ou comandos da térmica (ZPL, EPL, TSPL). */
export interface PerfilDeImpressao {
  id: 'navegador' | 'driver_windows' | 'termica_generica' | 'pdf' | 'zpl' | 'epl' | 'tspl';
  rotulo: string;
  dica: string;
  saida: 'html' | 'html_exato' | 'pdf' | 'zpl' | 'epl' | 'tspl';
  mime: string;
  extensao: string;
  aceitaFolha: boolean;
  levaAjustesDaTermica: boolean;
}

/** O que precisa ser conferido numa impressora de verdade antes de confiar na saída. */
export interface ItemDeHomologacao {
  saida: string;
  item: string;
  como: string;
}

/** O arquivo da saída, em base64 (PDF, ZPL, EPL, TSPL ou HTML exato). */
export interface ArquivoDaEtiqueta {
  nome: string;
  mime: string;
  base64: string;
}

/** Uma impressão de etiquetas do histórico da operação. */
export interface ImpressaoDeEtiquetas {
  id: string;
  kind: 'lote' | 'reimpressao' | 'teste';
  profile: string;
  formatId: string;
  templateId: string | null;
  formatName: string;
  items: { productId: string; name: string; quantity: number; priceCents: number; batchId: string | null }[];
  labels: number;
  pages: number;
  startAt: number;
  reprintOf: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
}

/** A resposta de imprimir (folha, reimpressão): a folha/prévia, o arquivo da saída e os avisos. */
export interface RespostaDaImpressaoDeEtiquetas {
  html: string;
  etiquetas: number;
  folhas: number;
  promocoes: string[];
  semPreco: string[];
  /** Produtos que ganharam código de barras interno nesta folha. */
  codigosGerados?: { productId: string; name: string; barcode: string }[];
  /** Sem código e sem permissão para gerar: saíram sem barras. */
  semCodigo?: string[];
  /** Código cadastrado que não virou barra (verificador errado, longo demais…). */
  codigosSemDesenho?: { name: string; motivo: string }[];
  /** A saída usada; ausente num servidor antigo (era sempre o navegador). */
  perfil?: PerfilDeImpressao['id'];
  arquivo?: ArquivoDaEtiqueta | null;
  comandos?: string | null;
  avisos?: string[];
  impressaoId?: string;
}

export interface QuantityModeOption {
  id: 'manual' | 'saldo' | 'documento';
  label: string;
  hint: string;
}

export interface LabelCandidate {
  productId: string;
  name: string;
  internalCode: string;
  barcode: string | null;
  /** O preço VIGENTE — o que a etiqueta imprime e o caixa cobra. */
  priceCents: number;
  /** Preço de tabela e se há promoção valendo: a fila mostra os dois antes de imprimir. */
  listPriceCents?: number;
  onSale?: boolean;
  stockQuantity: number;
  documentQuantity: number | null;
  /** O código cadastrado que a etiqueta não consegue desenhar, com o motivo. */
  avisoDoCodigo?: string | null;
}

export interface LabelProblem {
  descricao: string;
  motivo: string;
}

export interface LabelCandidates {
  source: LabelSourceOption['id'];
  candidates: LabelCandidate[];
  problemas: LabelProblem[];
  truncado: boolean;
}

export interface ScaleFormatOption {
  id: string;
  label: string;
  filename: string;
  confirmado: boolean;
  observacao: string;
}

export interface WeighableProduct {
  productId: string;
  name: string;
  pluCode: string | null;
  priceCents: number;
  weighable: number;
  tareGrams: number | null;
}

/**
 * Como a balança monta a etiqueta que o PDV lê (D-pdv-teclado-16): prefixo de
 * 21 a 29, o PLU logo depois, e o peso (gramas) ou o preço (centavos) até o
 * verificador. Nulo é "leitura desligada" — a busca do PDV é a de sempre.
 */
export interface ScaleLabelConfig {
  prefixo: string;
  digitosDoPlu: 4 | 5;
  valorEmbutido: 'peso' | 'preco';
}

// ------------------------------------------------- operadora de cartão

export interface Acquirer {
  id: string;
  name: string;
  account_id: string | null;
  active: number;
}

export interface AcquirerRate {
  id: string;
  acquirer_id: string;
  payment_method: string;
  installments: number;
  fee_bps: number;
  settlement_days: number;
}

// --------------------------------------------------------------- comissões

export interface CommissionTier {
  id: string;
  group_id: string;
  min_cents: number;
  rate_bps: number;
}

export interface CommissionGroup {
  id: string;
  name: string;
  active: number;
  tiers: CommissionTier[];
}

export interface CommissionSummaryRow {
  sellerId: string;
  sellerName: string | null;
  apuradoCents: number;
  estornadoCents: number;
  saldoCents: number;
  aberto: number;
}

/** Uma forma de recebimento, como o SERVIDOR a declara. */
export interface PaymentMethodOption {
  code: string;
  label: string;
  key: string;
  cash: boolean;
  deferred: boolean;
  active: boolean;
}

// ------------------------------------------- financeiro: os três cadastros

export interface FinanceCategory {
  id: string;
  direction: 'in' | 'out';
  name: string;
  parent_id: string | null;
  system_code: string | null;
  active: number;
}

export interface CostCenter {
  id: string;
  code: string;
  name: string;
  active: number;
}

export interface FinanceAccount {
  id: string;
  name: string;
  kind: 'banco' | 'caixinha' | 'carteira';
  bank_code: string | null;
  agency: string | null;
  account_number: string | null;
  opening_balance_cents: number;
  is_default: number;
  active: number;
  /** Derivado: o de partida mais o que já foi quitado. */
  balanceCents: number;
}

/**
 * Uma plaquinha da oficina que a loja pode adotar para uma unidade.
 *
 * Traz o nome da oficina E o da empresa dela porque a plaquinha vive em OUTRA
 * empresa do grupo: quem escolhe no balcão precisa saber de onde ela vem.
 */
export interface PlaquinhaCandidata {
  id: string;
  publicId: number;
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  chassis: string | null;
  motorNumber: string | null;
  serialNumber: string | null;
  workshopName: string;
  workshopCompanyName: string;
}

/** A plaquinha JÁ vinculada a uma unidade. */
export interface PlaquinhaDaUnidade {
  id: string;
  publicId: number;
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  saleStatus: string;
  status: string;
  workshopName: string;
  workshopCompanyName: string;
  /** Quantas OS deixam a moto DESMONTADA agora — com uma delas, não se vende. */
  ordensAbertas: number;
}

/**
 * O adesivo do lote da PJ Motors colado nesta unidade (P0 das plaquinhas) —
 * sem máquina: o QR dele abre a página da moto pela unidade.
 */
export interface PlaquinhaDoPoolDaUnidade {
  tagId: string;
  publicId: number;
  publicIdLabel: string;
  associatedAt: string;
}

/** Uma peça física, com identidade própria. */
export interface ProductUnit {
  id: string;
  company_id: string;
  product_id: string;
  status: 'in_stock' | 'sold' | 'baixada';
  serial_number: string | null;
  imei: string | null;
  chassis: string | null;
  motor_number: string | null;
  plate: string | null;
  location_id: string | null;
  cost_cents: number | null;
  entry_reference_type: string | null;
  exit_reference_type: string | null;
  equipment_id: string | null;
  note: string | null;
  created_at: string;
  /** Vem preenchida na listagem por produto; `null` quando não há vínculo. */
  plaquinha?: PlaquinhaDaUnidade | null;
  /**
   * O adesivo da PJ colado na unidade, na listagem por produto (só na PJ
   * Motors); `null` quando não há. Exclui `plaquinha`: é uma ou outra.
   */
  plaquinhaDoPool?: PlaquinhaDoPoolDaUnidade | null;
  /**
   * A pré-venda VIVA que segura esta moto (GAP-PRD-111), na listagem por
   * produto. O PDV não a escolhe para outro cliente, e a tela diz para quem é.
   */
  reserva?: ReservaDaUnidade | null;
}

/** A moto segurada por uma pré-venda, com o chassi para o balcão conferir. */
export interface ReservaDaUnidade {
  unitId: string;
  productId: string;
  quoteId: string;
  quoteNumber: number;
  customerName: string | null;
  validUntil: string | null;
  rotulo: string;
}

export interface StockLocation {
  id: string;
  company_id: string;
  code: string;
  name: string;
  note: string | null;
  is_default: number;
  active: number;
}

/** Saldo somado do razão para um local — nunca lido de cache. */
export interface LocationBalance {
  locationId: string | null;
  code: string;
  name: string;
  quantity: number;
}

export interface StockMovement {
  id: string;
  product_id: string;
  product_name: string;
  internal_code: string;
  movement_type: string;
  kind: string | null;
  /** Rótulo em português, vindo do servidor. */
  kind_label: string;
  quantity: number;
  quantity_before: number | null;
  reserved_delta: number;
  reserved_after: number | null;
  reference_type: string;
  reference_id: string;
  document_number: string | null;
  balance_after: number;
  /** Nulo quando o perfil não pode ver custo — removido, não escondido. */
  unit_cost_cents: number | null;
  user_name: string | null;
  reason: string | null;
  note: string | null;
  /**
   * De qual LOTE saiu, ou em qual entrou (GAP-V35). Nulo é o normal: ou o
   * produto não controla lote, ou a mercadoria entrou sem lote declarado.
   */
  batch_id: string | null;
  /** O código impresso na embalagem — a tela nunca mostra o id técnico. */
  batch_code: string | null;
  batch_expires_on: string | null;
  batch_quantity_before: number | null;
  batch_balance_after: number | null;
  created_at: string;
}

export interface MovementKindOption {
  kind: string;
  label: string;
}

// ------------------------------------------------------- lotes e validade
//
// GAP-V35. O saldo por lote é DERIVADO do razão no servidor — a tela não soma
// nada e não guarda nada: ela pergunta.

/** As faixas do alerta, do mais urgente ao mais tranquilo. */
export type FaixaDeValidade =
  | 'vencido'
  | 'vence_em_7'
  | 'vence_em_15'
  | 'vence_em_30'
  | 'em_dia'
  | 'sem_validade';

export interface ProductBatch {
  id: string;
  company_id: string;
  product_id: string;
  product_name: string;
  internal_code: string;
  unit: string;
  code: string;
  manufactured_on: string | null;
  expires_on: string | null;
  location_id: string | null;
  location_name: string | null;
  /** Nulo enquanto ninguém conferiu. Nulo NÃO é "reprovado". */
  checked_at: string | null;
  checked_by: string | null;
  checked_by_name: string | null;
  note: string | null;
  created_at: string;
  /** Somado do razão pelo servidor. */
  quantity: number;
  /** Saldo × custo do cadastro, em centavos INTEIROS, arredondado no servidor. */
  value_cents: number;
  faixa: FaixaDeValidade;
  /** Negativo quando já venceu; nulo sem validade declarada. */
  dias_para_vencer: number | null;
}

export interface BatchBalance {
  /** Nulo é o balde "sem lote declarado" — pendência, não buraco. */
  batchId: string | null;
  code: string | null;
  expiresOn: string | null;
  quantity: number;
}

export interface FaixaDoAlerta {
  faixa: FaixaDeValidade;
  label: string;
  lotes: number;
  quantity: number;
  valueCents: number;
}

export interface PendenciaSemLote {
  productId: string;
  productName: string;
  internalCode: string;
  unit: string;
  quantity: number;
}

export interface BatchAlerts {
  /** O dia da medição, no fuso da loja — a tela nunca calcula "hoje". */
  hoje: string;
  faixas: FaixaDoAlerta[];
  naoConferidos: number;
  produtosComSaldoSemLote: number;
  quantidadeSemLote: number;
  pendencias: PendenciaSemLote[];
}

/** Estados da cobrança na maquininha, como o operador enxerga. */
export type TerminalState =
  | 'aguardando_terminal'
  | 'aguardando_cliente'
  | 'processando'
  | 'aprovado'
  | 'recusado'
  | 'cancelado'
  | 'timeout_nao_confirmado'
  | 'erro';

/** Uma pendência eletrônica do turno (GAP-PRD-081) — o que o fechamento confere. */
export type TipoDePendenciaEletronica =
  | 'nao_confirmada'
  | 'em_andamento'
  | 'aprovada_sem_venda'
  | 'estorno_pendente';

/** O dinheiro eletrônico do turno ainda indefinido: cobranças da maquininha e PIX pendente de venda. */
export interface PendenciasEletronicas {
  cobrancas: {
    transactionId: string;
    tipo: TipoDePendenciaEletronica;
    state: string;
    method: string;
    amountInCents: number;
    simulated: boolean;
    startedAt: string | null;
    saleId: string | null;
  }[];
  pagamentosPendentes: {
    paymentId: string;
    saleId: string;
    saleNumber: number | null;
    method: string;
    amountCents: number;
  }[];
  /**
   * Venda guardada sem servidor que o servidor recusou e ainda não foi
   * relançada nem descartada (GAP-PRD-045): o dinheiro dela está NA gaveta.
   * Opcional: servidor anterior a esta versão não manda.
   */
  vendasOffline?: {
    id: string;
    label: string | null;
    receivedCents: number;
    queuedAt: string | null;
    errorMessage: string | null;
  }[];
  quantidade: number;
  totalCents: number;
}

/** O que aconteceu com o estorno na maquininha ao cancelar/devolver a venda (GAP-PRD-080). */
export interface EstornoNaMaquininha {
  transactionId: string;
  amountInCents: number;
  resultado: 'estornado' | 'enviado_ao_agente' | 'pendente';
  message: string;
  code?: string;
}

export interface TerminalPayment {
  transactionId: string;
  state: TerminalState;
  message: string;
  /** Só `true` quando o provedor confirmou. É isto que libera a venda. */
  settled: boolean;
  /** `true` quando ninguém sabe o que aconteceu — exige conferência humana. */
  needsReconciliation: boolean;
  amountInCents: number;
  method: string;
  maskedCard?: string | null;
  authorizationCode?: string | null;
  /** Resposta de adaptador simulado, não cobrança real. */
  simulated: boolean;
  /**
   * Copia-e-cola do PIX, enquanto pendente (GAP-V49).
   *
   * O servidor já devolvia este campo — `PdvTerminalService.toResult` o
   * preenche desde que o fluxo assíncrono do PIX foi implementado. O tipo do
   * cliente o descartava, e por isso a tela não tinha como mostrar o código:
   * o PIX na maquininha era backend inteiro sem superfície nenhuma.
   *
   * A maquininha exibe o QR no próprio aparelho; a tela mostra o mesmo código
   * para o caso de o aparelho estar longe do operador (ou do cliente que
   * prefere copiar e colar no aplicativo do banco).
   */
  qrPayload?: string | null;
  /**
   * Ainda andando no aparelho (agente local, GAP-PRD-014): a tela consulta de
   * novo em alguns segundos — sem cobrar outra vez.
   */
  pending?: boolean;
  /** Por onde a cobrança foi feita (`local_agent`, `mock`). */
  channel?: string | null;
}

/** Situação do certificado A1 de uma operação. */
/**
 * A resposta da SEFAZ ao `statusServico` — o teste de comunicação (rodada 58).
 *
 * `online: false` NÃO é erro: é o fisco dizendo que está parado, e a
 * diferença entre isso e "não consegui falar com a SEFAZ" decide para que
 * lado quem está na tela vai olhar.
 */
export interface SefazStatusView {
  online: boolean;
  /** Código do fisco: 107 = serviço em operação. */
  cStat: string | null;
  /** O motivo, com as palavras da SEFAZ. Chega inteiro. */
  xMotivo: string | null;
  checkedAt: string;
  uf: string;
  environment: string;
  certificate: {
    subject: string;
    cnpj: string;
    validTo: string;
    /**
     * Quantos certificados o .pfx trouxe. 1 = só a folha, sem as autoridades
     * — a SEFAZ pode recusar o handshake mesmo com o nosso lado certo, e o
     * conserto é regerar o arquivo com a cadeia (rodada 59).
     */
    chainLength: number;
  };
}

/**
 * O AVISO PROATIVO DE VENCIMENTO — GAP-V40.
 *
 * Estado DERIVADO: uma função da validade e do relógio, calculada no servidor
 * a cada leitura. Não existe fila de avisos nem "já enviado", porque não
 * existe agendador — e porque aviso que pode falhar é aviso que ninguém
 * confere. Vem `null` enquanto há folga: banner que aparece todo dia deixa de
 * ser lido.
 */
export interface CertificateAlert {
  /** 90, 60, 30, 15, 7 — ou 0, que é o vencido. */
  band: number;
  /** Dias restantes de verdade. Negativo quando já venceu. */
  days: number;
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

/**
 * O que o `.pfx` informou, extraído no envio.
 *
 * NENHUM destes campos é digitado por ninguém: se o arquivo diz, o sistema não
 * pergunta. Campos `null` são de registros gravados antes da autodetecção —
 * reenviar o arquivo preenche todos.
 */
export interface CertificateCard {
  subject?: string | null;
  issuer?: string | null;
  cnpj?: string | null;
  serialNumber?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  holderName?: string | null;
  documentType?: 'CNPJ' | 'CPF' | null;
  documentNumber?: string | null;
  subjectDn?: string | null;
  issuerDn?: string | null;
  fingerprintSha256?: string | null;
  chainLength?: number | null;
  selfSigned?: boolean | null;
  /** 'conferido' | 'raiz' | 'sem_referencia' — o veredito do CNPJ (GAP-V39). */
  cnpjConference?: string | null;
  cnpjConferenceWarning?: string | null;
  /** A senha está selada no cofre? Booleano — a senha nunca volta. */
  senhaGuardada?: boolean | null;
}

export interface CertificateView {
  configured: boolean;
  situation: 'nao_configurado' | 'valido' | 'proximo_do_vencimento' | 'vencido';
  message: string;
  /** Nunca é 'HOMOLOGATED': isso exige teste real contra a SEFAZ. */
  readiness: 'READY_FOR_CERTIFICATE' | 'CERTIFICATE_LOADED';
  daysRemaining: number | null;
  alerta: CertificateAlert | null;
  /** Já vem sem o arquivo, sem a chave e sem nada que aponte para o segredo. */
  certificate: CertificateCard | null;
}

/** Uma linha da visão consolidada das seis operações (GAP-V41). */
export interface GroupCertificateItem {
  companyId: string;
  slug: string;
  tradeName: string;
  legalName: string;
  configured: boolean;
  situation: CertificateView['situation'];
  message: string;
  daysRemaining: number | null;
  alerta: CertificateAlert | null;
  holderName: string | null;
  documentNumber: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  senhaGuardada: boolean;
}

/**
 * O parecer honesto sobre a liberação da produção (GAP-V42).
 *
 * `canUnlock` falso com `blockingReasons` cheio é o estado normal: a produção
 * só abre depois de uma autorização REAL na SEFAZ de homologação — a do
 * simulador não conta.
 */
export interface ProductionUnlock {
  companyId: string;
  unlocked: boolean;
  unlockedAt: string | null;
  unlockedBy: string | null;
  canUnlock: boolean;
  blockingReasons: string[];
  evidence: {
    model: string;
    serie: number;
    number: number;
    protocol: string;
    authorizedAt: string | null;
  } | null;
  /** O que ainda falta DEPOIS deste ato — destravar não liga produção. */
  remainingSteps: string[];
  alreadyUnlocked?: boolean;
}

/**
 * Equipamento identificado por plaquinha.
 *
 * `publicIdLabel` é o `#0001` que fica colado na máquina — é por ele que o
 * balcão e o mecânico conversam, então vem pronto do servidor em vez de cada
 * tela reinventar o formato.
 */
export interface Equipment {
  id: string;
  public_id: number;
  publicIdLabel: string;
  /**
   * A credencial da plaquinha — e ela NÃO vem na listagem.
   *
   * `public_token` abre `/equipamento/:token` sem sessão, não expira e não se
   * revoga. A listagem de equipamentos deixou de entregá-lo, então o campo é
   * opcional: quem o recebe é quem acabou de cadastrar o aparelho, porque é
   * essa pessoa que imprime a plaquinha.
   *
   * Declarar `string` aqui era uma promessa que o servidor deixou de cumprir.
   * Ninguém lê o campo em tela nenhuma hoje — mas quem escrevesse
   * `e.public_token` receberia `undefined` com o compilador jurando que é
   * texto, e o portão de tipos ficaria verde.
   */
  public_token?: string;
  origin: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  color: string | null;
  serial_number: string | null;
  motor_number: string | null;
  chassis: string | null;
  battery: string | null;
  battery_serial: string | null;
  owner_customer_id: string | null;
  /**
   * A ficha completa da máquina (rodada 52).
   *
   * `warranty_months` é o COMBINADO, não o estado. O sistema anterior gravava
   * o estado e nunca o recalculava — a moto seguia em garantia anos depois de
   * vencer. Aqui o estado sai da conta, e a conta é do SERVIDOR: vem em
   * `warranty`, para que lista e ficha nunca respondam coisas diferentes.
   */
  warranty_months: number | null;
  /** Garantia derivada na leitura. Ausente em respostas anteriores à rodada 52. */
  warranty?: {
    months: number | null;
    baseKind: 'venda' | 'entrada' | null;
    /** Dia de calendário (AAAA-MM-DD) — nunca um instante. */
    baseDate: string | null;
    /** Dia de calendário (AAAA-MM-DD) — nunca um instante. */
    expiresAt: string | null;
    status: 'sem_garantia' | 'vigente' | 'vence_em_breve' | 'vencida';
    daysLeft: number | null;
  } | null;
  entered_at: string | null;
  assembly_mechanic_id: string | null;
  assembled_at: string | null;
  sale_status: string;
  /**
   * Quando a plaquinha ganhou dono.
   *
   * Só existe com `sale_status = 'SOLD'`. Sem esta data, "Vendido" na tela é uma
   * afirmação sem prova: quem confere a garantia precisa saber DESDE QUANDO ela
   * conta, e a data da venda é a única resposta que o registro guarda.
   */
  sold_at: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  /**
   * A unidade de estoque que esta plaquinha representa, quando a loja a adotou.
   *
   * `null` para o aparelho do cliente e para a moto interna ainda não vinculada.
   * É o que deixa a tela da oficina distinguir "moto da loja, à venda" de "moto
   * que alguém trouxe".
   */
  estoque: {
    unitId: string;
    unitStatus: string;
    productName: string;
    companyName: string;
  } | null;
}

/**
 * Pessoa da equipe.
 *
 * Não existe entidade separada para mecânico: é o mesmo usuário, com perfil
 * vindo do vínculo de empresa e oficinas vindas do vínculo de oficina. Nada
 * relacionado à senha trafega — nem hash, nem algoritmo, nem versão de sessão.
 */
export interface TeamMember {
  id: string;
  login: string;
  displayName: string;
  email: string | null;
  profileCode: string;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  workshops: { id: string; name: string; slug: string; role: string }[];
}

/**
 * Uma operação do grupo.
 *
 * `retail` é loja; `workshop` é oficina — e a diferença NÃO é rótulo: a
 * oficina nasce com uma bancada e o primeiro gerente dela é `gerente_oficina`,
 * que sem bancada o servidor recusa.
 */
export type CompanyKind = 'retail' | 'workshop';

export interface Company {
  id: string;
  /** Pedaço do endereço da vitrine. Derivado do nome fantasia no servidor. */
  slug: string;
  legalName: string;
  tradeName: string;
  /** Só dígitos, ou nulo. Opcional na criação, mas conferido se vier. */
  cnpj: string | null;
  kind: CompanyKind | string;
  active: boolean;
  /** Usa plaquinha com QR (GAP-PRD-185). Ausente em servidor antigo. */
  usesEquipmentTags?: boolean;
}

/**
 * O que volta de `POST /core/companies` — e é MAIS do que a empresa.
 *
 * A tela precisa de cada pedaço para dizer, depois, exatamente o que aconteceu:
 * qual login nasceu, se uma bancada foi criada junto, e quantos
 * administradores do grupo passaram a enxergar a operação nova. Sem isso, quem
 * criou sairia da tela sabendo só que "deu certo".
 *
 * A SENHA NÃO VOLTA AQUI, e é de propósito: o servidor guarda o hash e nunca
 * devolve o texto. A única cópia é a que a pessoa digitou.
 */
export interface CompanyCreated {
  company: Company;
  workshop: { id: string; slug: string; name: string } | null;
  manager: TeamMember;
  /** Ids dos administradores do grupo que ganharam vínculo na empresa nova. */
  linkedGroupAdmins: string[];
}

/**
 * Conta a receber ou a pagar — o mesmo lançamento visto dos dois lados.
 * `balanceCents` e `overdue` vêm calculados do servidor para a tela não
 * recalcular de um jeito ligeiramente diferente.
 */
export interface FinanceEntry {
  id: string;
  direction: 'in' | 'out';
  description: string;
  amountCents: number;
  settledCents: number;
  balanceCents: number;
  status: string;
  dueDate: string | null;
  settledAt: string | null;
  overdue: boolean;
  counterpartyName: string | null;
  originType: string;
  /**
   * O id do documento que gerou o título — a metade que faltava da
   * rastreabilidade. Com ele a linha vira LINK; sem ele, quem cobrava saía
   * caçando a venda pelo texto da descrição.
   */
  originId: string;
  /**
   * Rótulo legível da origem ('Venda #7', 'Nota 4711 — Fornecedor X'),
   * resolvido pelo servidor. Nulo quando não há superfície para onde ir
   * (lançamento manual) — a tela só oferece link de porta que abre.
   */
  originLabel: string | null;
  /** Qual parcela é esta, e de quantas. 1 de 1 é o lançamento comum. */
  installmentNumber: number;
  installmentTotal: number;
  /**
   * Para que foi o dinheiro.
   *
   * Vem na linha porque a lista ganhou FILTRO por categoria: filtrar por um
   * campo que a linha não mostra deixa quem filtrou sem como conferir se o
   * recorte é o que pediu — e um filtro que não se confere é um filtro em que
   * ninguém confia.
   */
  categoryId: string | null;
  categoryName: string | null;
  /**
   * DE QUEM É a despesa (ou a receita) — o centro de custo (GAP-V25).
   *
   * A coluna era gravada em todo lançamento e nenhuma superfície a lia. Vem na
   * linha pelo mesmo motivo da categoria: a lista ganhou filtro por centro, e
   * filtrar por um campo invisível deixa quem filtrou sem como conferir.
   */
  costCenterId: string | null;
  costCenterName: string | null;
  /** Carimbo do cancelamento. Preenchido = o fato não conta em relatório. */
  cancelledAt: string | null;
  createdAt: string;
}

/** Uma linha do período por centro de custo. */
export interface CostCenterReportLine {
  /** Nulo é a casa do que ninguém atribuiu. */
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string;
  revenueCents: number;
  expenseCents: number;
  resultCents: number;
  entryCount: number;
}

/**
 * O período por centro de custo — o irmão do DRE (GAP-V25).
 *
 * Mesma competência e mesmo critério de cancelamento do DRE, para que as duas
 * telas possam ser comparadas lado a lado sem que uma contradiga a outra.
 */
export interface CostCenterReport {
  from: string;
  to: string;
  lines: CostCenterReportLine[];
  revenueTotalCents: number;
  expenseTotalCents: number;
  resultCents: number;
  entryCount: number;
  /** Quanto do período ainda não tem dono. É a régua do rateio. */
  unassigned: { entryCount: number; revenueCents: number; expenseCents: number };
}

/** O vencido por IDADE — as cinco faixas da casa, saldo a saldo. */
export interface FinanceAging {
  notDueCents: number;
  days1to30Cents: number;
  days31to60Cents: number;
  days61to90Cents: number;
  over90Cents: number;
}

export interface FinanceSettlement {
  id: string;
  amountCents: number;
  method: string | null;
  settledAt: string;
  note: string | null;
  reversedAt: string | null;
  reversesId: string | null;
}

export interface FinanceSummary {
  openCents: number;
  overdueCents: number;
  settledCents: number;
  /** Todos os lançamentos vivos do lado, quitados inclusive. */
  count: number;
  /**
   * Quantos ainda devem — a contagem que acompanha `openCents` (GAP-PRD-208).
   * Opcional só para servidor antigo; ausente, a tela não inventa número.
   */
  openCount?: number;
  /** Quantos dos abertos já venceram. */
  overdueCount?: number;
}

// ------------------------------------------- cobrança online do título (V70)

/**
 * A intenção de pagamento como ela SAI do servidor.
 *
 * Campos em `snake_case` porque é a linha da tabela devolvida como está — o
 * mesmo formato que o pedido online já consome. Renomear aqui criaria um
 * segundo vocabulário para o mesmo dado.
 */
export interface PaymentIntentRow {
  id: string;
  company_id: string;
  provider: string;
  environment: string;
  origin_type: string;
  origin_id: string;
  method: string;
  amount_cents: number;
  status: string;
  provider_ref: string | null;
  qr_payload: string | null;
  invoice_url: string | null;
  last_error: string | null;
  attempts?: number;
  created_at: string;
}

/** Uma parcela do carnê gerado pela cobrança parcelada. */
export interface FinanceChargeInstallment {
  entryId: string;
  number: number;
  total: number;
  amountCents: number;
  dueDate: string | null;
  intentId: string;
  providerRef: string | null;
  status: string;
  invoiceUrl: string | null;
}

/**
 * O que a tela mostra depois de cobrar: copia-e-cola do PIX, linha digitável
 * do boleto, link da fatura. `status` é o da cobrança — `pending` é o certo
 * logo após gerar, porque MOSTRAR O QR NÃO É RECEBER.
 */
export interface FinanceCharge {
  intent: PaymentIntentRow;
  pixPayload: string | null;
  pixImageBase64: string | null;
  bankSlipUrl: string | null;
  identificationField: string | null;
  dueDate: string | null;
  invoiceUrl: string | null;
  status: string;
  environment: string;
  installments: FinanceChargeInstallment[];
}

/** A cobrança na LISTA de status — com o erro e as tentativas visíveis. */
export interface PaymentIntentView {
  id: string;
  originType: string;
  originId: string;
  originLabel: string | null;
  method: string;
  provider: string;
  environment: string;
  amountCents: number;
  status: string;
  providerRef: string | null;
  invoiceUrl: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  /**
   * A baixa que esta cobrança produziu no título ainda está de pé (GAP-PRD-092).
   * Nula fora de cobrança de título. Opcional: servidor antigo não manda.
   */
  settlementStanding?: boolean | null;
  /** Cartão parcelado (GAP-PRD-114): em quantas vezes. Opcional: servidor antigo não manda. */
  installmentCount?: number;
}

// ------------------------------------------------------- DRE (competência)

/** Uma linha do demonstrativo: uma categoria, de um lado só. */
export interface IncomeStatementLine {
  /** Nulo é a casa própria do que ninguém classificou. */
  categoryId: string | null;
  categoryName: string;
  systemCode: string | null;
  totalCents: number;
  entryCount: number;
}

export interface IncomeStatementSide {
  lines: IncomeStatementLine[];
  totalCents: number;
  entryCount: number;
}

/** Uma parcela NOMEADA da diferença entre o painel e o DRE. */
export interface ReconciliationLine {
  key: string;
  label: string;
  cents: number;
}

/**
 * Por que o painel e o DRE mostram números diferentes.
 *
 * O servidor já decompõe a diferença em parcelas com nome e CONFERE que elas
 * somam exatamente `differenceCents`. A tela renderiza a lista inteira: um
 * link mudo entre dois números que discordam é pior que não ter link, porque
 * quem vê os dois conclui que um deles está errado.
 */
export interface IncomeStatementReconciliation {
  panelRevenueCents: number;
  statementRevenueCents: number;
  differenceCents: number;
  lines: ReconciliationLine[];
}

/**
 * O CUSTO DA MERCADORIA VENDIDA no período — GAP-V28.
 *
 * As três contagens não são detalhe: elas dizem SOBRE QUANTO o número ao lado
 * fala. Sem elas, "CMV do mês" seria lido como o custo do mês inteiro quando é
 * o custo das linhas que TÊM custo — e a tela renderiza as três pelo mesmo
 * motivo que renderiza a lista inteira de `caveats`.
 */
export interface CostOfGoodsSold {
  costCents: number;
  revenueCents: number;
  marginCents: number;
  /** Nulo é "não dá para saber" — diferente de margem zero. */
  marginPercent: number | null;
  itemsWithCost: number;
  /** Produto vendido com o cadastro sem custo: pendência de cadastro. */
  itemsWithoutCost: number;
  /** Venda anterior ao snapshot, ou linha de serviço: não tem custo e nunca terá. */
  itemsBeforeSnapshot: number;
}

export interface IncomeStatement {
  companyId: string;
  from: string;
  to: string;
  revenue: IncomeStatementSide;
  expense: IncomeStatementSide;
  resultCents: number;
  /**
   * O CMV vem AO LADO do resultado, e nunca dentro dele: a compra da
   * mercadoria já é despesa no mesmo relatório, no título da nota de entrada.
   */
  cogs: CostOfGoodsSold;
  uncategorized: {
    entryCount: number;
    revenueCents: number;
    expenseCents: number;
  };
  reconciliation: IncomeStatementReconciliation;
  /**
   * As frases da ressalva, prontas, vindas do servidor.
   *
   * A tela renderiza a LISTA INTEIRA e não escolhe nenhuma. Se cada frase
   * fosse texto solto no componente, a primeira reescrita da tela deixaria de
   * fora justamente a que incomoda — e um DRE que omite a própria limitação é
   * um número que o contador usa para pagar imposto.
   */
  caveats: string[];
}

export interface FiscalConfig {
  companyId: string;
  legalName: string | null;
  tradeName: string | null;
  cnpj: string | null;
  ie: string | null;
  im: string | null;
  crt: string | null;
  zip: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  cityName: string | null;
  cityIbge: string | null;
  uf: string | null;
  phone: string | null;
  environment: 'homologation' | 'production';
  productionUnlocked: boolean;
  updatedAt: string | null;
}

/** Produto que ainda não pode entrar numa nota, e o motivo exato. */
export interface ProductFiscalPendency {
  id: string;
  name: string;
  sku: string | null;
  internalCode: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  origin: string | null;
  taxProfile: string | null;
  missing: string[];
}

/** Documento fiscal. Valor e cliente vêm da venda por junção, não são cópia. */
export interface FiscalDocumentRow {
  id: string;
  model: string;
  serie: number;
  number: number;
  accessKey: string | null;
  environment: string;
  status: string;
  protocol: string | null;
  cStat: string | null;
  xMotivo: string | null;
  saleId: string | null;
  saleNumber: number | null;
  /** Destinatário da NF-e; na falta dele, o cliente da venda. */
  customerName: string | null;
  recipientDocument: string | null;
  totalCents: number | null;
  authorizedAt: string | null;
  createdAt: string;
}

// -------------------------------------------------------------- integrações

/** Uma credencial guardada: dica mascarada e origem. Nunca o valor. */
export interface AsaasSecretSlot {
  configured: boolean;
  maskedHint?: string;
  source: 'vault' | 'env' | 'none';
}

export interface AsaasCredentialStatus {
  sandbox: AsaasSecretSlot;
  production: AsaasSecretSlot;
  webhook: AsaasSecretSlot;
}

export interface AsaasStatus {
  provider: string;
  configured: boolean;
  environment: string;
  readiness: 'READY_FOR_CREDENTIAL' | 'READY_FOR_SANDBOX_TEST' | 'PRODUCTION_ENABLED';
  /** Trancas ainda fechadas entre esta operação e cobrar de verdade. */
  productionBlockedBy: string[];
}

export interface AsaasState {
  companyId: string;
  environment: string;
  /** Selo da chave de SANDBOX (a homologação o exige). */
  connectionVerified: boolean;
  lastConnectionTestAt: string | null;
  /**
   * Selo da chave de PRODUÇÃO, testada em api.asaas.com (GAP-PRD-170). É o
   * que a tranca de produção lê — antes, o teste do sandbox a satisfazia.
   */
  productionConnectionVerified?: boolean;
  productionConnectionTestedAt?: string | null;
  productionConnectionError?: string | null;
  sandboxHomologated: boolean;
  homologationStatus: string;
  lastHomologationAt: string | null;
}

/** O teste de UMA chave, no próprio ambiente (GAP-PRD-170). */
export interface TesteDaChaveAsaas {
  environment: 'sandbox' | 'production';
  /** Falso quando não houve chamada (sem chave, ou produção desligada no servidor). */
  tested: boolean;
  ok: boolean;
  detail: string;
}

/**
 * O resultado da homologação do sandbox (rodada 62).
 *
 * `status: 'failed'` NÃO é erro de chamada: a homologação rodou e o resultado
 * é que não passou. Quem diz o que consertar são os PASSOS — dezesseis, cada
 * um com o próprio veredito e, quando falha, o motivo que o Asaas devolveu.
 */
export interface HomologacaoAsaas {
  status: string;
  sandboxHomologated?: boolean;
  steps: {
    key: string;
    label: string;
    category: string;
    /**
     * `error` é o que o serviço grava no passo que caiu — não `failed`.
     * Procurar a palavra errada fez o passo culpado sair com a mesma marca
     * dos que nem rodaram (rodada 63).
     */
    status: 'success' | 'error' | 'failed' | 'running' | 'pending' | 'skipped' | string;
    /** O motivo do provedor. É aqui que o serviço grava — não em `detail`. */
    message?: string;
    detail?: string;
  }[];
}

export interface AsaasIntegration {
  status: AsaasStatus;
  credentials: AsaasCredentialStatus;
  state: AsaasState;
  envFallbackAllowed: boolean;
  /** URL do webhook desta operação e o último aviso recebido (GAP-PRD-002). */
  webhook?: AsaasWebhookInfo;
}

export interface FiscalEvent {
  eventType: string;
  detail: string | null;
  sequence: number;
  protocol: string | null;
  cStat: string | null;
  xMotivo: string | null;
  createdAt: string;
}

/** Situação fiscal de uma venda, como o PDV precisa ver. */
export interface FiscalSaleStatus {
  document: FiscalDocumentRow;
  /** Frase pronta em português — o caixa não precisa aprender a máquina de estados. */
  statusLabel: string;
  terminal: boolean;
  isTest: boolean;
  queue?: {
    attempts: number;
    nextAttemptAt: string | null;
    /** pending | retry | sending | done | dead — o PDV diz "nova tentativa às…" (GAP-PRD-020). */
    status?: string;
    errorMessage?: string | null;
  } | null;
  /** NFC-e emitida em contingência off-line (tpEmis 9) — o DANFCE de contingência vale no balcão (GAP-PRD-098). */
  contingencia?: { offline: true; pendente: boolean; prazoDeTransmissao: string | null } | null;
}

/** Pendência fiscal que o operador precisa resolver. */
export interface FiscalPendency {
  documentId: string;
  saleId: string | null;
  number: number;
  status: string;
  kind:
    | 'REJECTED'
    | 'ERROR'
    | 'SENDING_TOO_LONG'
    | 'CONTINGENCY_PENDING'
    | 'QUEUE_DEAD'
    | 'TRANSMISSION_DELAYED'
    | 'CONTINGENCY_OVERDUE';
  label: string;
  /** Até quando a NFC-e off-line precisa chegar à SEFAZ (GAP-PRD-098). */
  deadline?: string | null;
  since: string;
}

/**
 * Resumo fiscal do balcão.
 *
 * `situacao` nunca é 'READY' enquanto o que existe for fixture — o caminho
 * para READY passa por autorização real registrada.
 */
export interface FiscalPdvSummary {
  situacao: 'READY' | 'TEST_ONLY' | 'PENDING' | 'NOT_CONFIGURED';
  readiness: string;
  canEmit: boolean;
  /** Ambiente em que a operação emite — em homologação a nota não tem valor fiscal. */
  ambiente?: 'homologation' | 'production';
  /** Uma frase pronta: o que falta e quem resolve (auditoria P0). */
  resumo?: string;
  /** O que trava, item a item, no texto do balcão — nunca com segredo. */
  faltas?: {
    key: string;
    label: string;
    texto: string;
    quemResolve: 'administrador' | 'contador' | 'SEFAZ';
    onde: string;
  }[];
  /** Quando o servidor conferiu. */
  verificadoEm?: string;
  blocking: { key: string; label: string; detail: string | null }[];
  pendencies: FiscalPendency[];
  pendencyCount: number;
  /** Período de contingência off-line aberto na operação (GAP-PRD-098). */
  contingencia?: {
    iniciadoEm: string;
    motivoRotulo: string;
    origem: 'AUTOMATICA' | 'MANUAL';
  } | null;
}

/** Resultado do pedido de cancelamento. `accepted: false` = a nota continua valendo. */
export interface FiscalCancelResult {
  document: FiscalDocumentRow;
  accepted: boolean;
  eventId: string;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
}

export interface FiscalCorrectionResult {
  accepted: boolean;
  eventId: string;
  /** Decidida pelo servidor — o cliente não escolhe. */
  sequence: number;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
}

export interface FiscalVoidRange {
  id: string;
  model: string;
  serie: number;
  from: number;
  to: number;
  justification: string | null;
  status: 'AUTHORIZED' | 'REJECTED' | 'REQUESTED';
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
  createdAt: string;
}

export interface FiscalVoidResult {
  accepted: boolean;
  eventId: string;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
}

export interface ReconciliationIssue {
  check: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  summary: string;
  impact: string;
  action: string;
  documentIds: string[];
  count: number;
}

export interface ReconciliationReport {
  companyId: string;
  checkedAt: string;
  healthy: boolean;
  critical: number;
  warnings: number;
  issues: ReconciliationIssue[];
}

/**
 * O ESTADO do item no assistente de prontidão — o eixo que o `status` não tem.
 *
 * `status` é o PORTÃO (o que bloqueia a emissão); `state` é o que a pessoa
 * precisa saber para agir. Um certificado a três dias de vencer é PASS e
 * AUTO_DETECTADO; a autorização da SEFAZ é PENDING e BLOQUEADO_EXTERNAMENTE —
 * e no segundo caso não há botão nenhum a apertar aqui dentro.
 */
export type ReadinessState =
  | 'AUTO_DETECTADO'
  | 'CONFIRMADO'
  | 'PENDENTE'
  | 'DIVERGENTE'
  | 'NAO_APLICAVEL'
  | 'BLOQUEADO_EXTERNAMENTE';

/** DE ONDE VEIO O DADO. Dado sem origem é dado sem responsável. */
export type ReadinessSource =
  | 'cadastro'
  | 'certificado'
  | 'xml_fornecedor'
  | 'confirmacao_humana'
  | 'sefaz'
  | 'cofre';

/** QUEM RESOLVE. Sem isto a tela manda o gestor caçar botão que não existe. */
export type ReadinessOwner = 'dono' | 'gestor' | 'contador' | 'sefaz';

export interface ReadinessItem {
  key: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'PENDING';
  detail: string | null;
  state: ReadinessState;
  source: ReadinessSource | null;
  owner: ReadinessOwner;
  /** O que já sabemos — o valor que está lá hoje. */
  known: string | null;
  /** "93% dos produtos classificados". Só nos itens de catálogo. */
  counts: { done: number; total: number; percent: number } | null;
}

// --------------------------------------------------- classificação sugerida

export type CampoFiscal = 'ncm' | 'cest' | 'origin';

/** Um valor visto no XML de entrada, e por quantas notas. */
export interface SuggestionEvidence {
  value: string;
  occurrences: number;
  suppliers: string[];
  lastSeenAt: string | null;
  lastNoteId: string | null;
}

export interface ProductFieldClassification {
  field: CampoFiscal;
  current: string | null;
  state: ReadinessState;
  best: SuggestionEvidence | null;
  evidence: SuggestionEvidence[];
  source: 'cadastro' | 'xml_fornecedor' | null;
}

export interface ProductClassification {
  productId: string;
  name: string;
  sku: string | null;
  internalCode: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  fields: ProductFieldClassification[];
  /** O que o lote aplicaria: campo vazio, um único valor sugerido. */
  applicable: { field: CampoFiscal; value: string }[];
}

export interface ClassificationSummary {
  totalProducts: number;
  withNcm: number;
  withOrigin: number;
  confirmed: number;
  pendingSuggestions: number;
  divergences: number;
}

/** `readiness` é calculado no servidor e nunca é 'HOMOLOGATED' por otimismo. */
export interface ReadinessReport {
  companyId: string;
  model: string;
  readiness: 'READY_FOR_CERTIFICATE' | 'READY_FOR_SEFAZ_HOMOLOGATION' | 'HOMOLOGATED';
  canEmit: boolean;
  items: ReadinessItem[];
  blockingReasons: string[];
  /**
   * A faixa de aviso do certificado (GAP-V40), ou `null` com folga.
   *
   * Viaja no relatório para que a tela de configuração — que não é a tela do
   * certificado — também avise. O aviso que só uma tela dá não avisa ninguém.
   */
  certificateAlert: CertificateAlert | null;
}

/**
 * O CSC como o navegador tem direito de vê-lo: se existe, qual o ID, em que
 * ambiente. O TOKEN NUNCA VEM. Ele é gravado cifrado no cofre do servidor e
 * só sai de lá para assinar o QR Code do cupom — quem precisar trocá-lo
 * digita o novo, não lê o antigo.
 */
export interface NfceCscSetting {
  operationalUnitId: string;
  cscId: string | null;
  configured: boolean;
  /** Um CSC por ambiente (GAP-PRD-022): a lista traz até dois. */
  environment: 'homologation' | 'production';
  updatedAt?: string | null;
}

/** A mesma pergunta, recortada por VENDA — é o que o balcão precisa saber. */
export interface SaleEmissionReadiness {
  canEmit: boolean;
  alreadyEmitted: boolean;
  reasons: string[];
}

export interface LogisticsChecklistItem {
  key: string;
  label: string;
  status: 'ok' | 'pending' | 'blocked';
  message?: string;
}

export interface LogisticsProvider {
  carrier: string;
  configured: boolean;
  homologated: boolean;
  /** O que a credencial permite e o que trava (GAP-PRD-126). */
  access?: LogisticsAccess;
  items: LogisticsChecklistItem[];
  blockingReasons: string[];
}

export interface LogisticsReadiness {
  readyForHomologation: boolean;
  readyForProduction: boolean;
  productionBlocked: boolean;
  externalEnabled: boolean;
  overallStatus: string;
  providers: LogisticsProvider[];
  blockingReasons: string[];
  /** CEP de onde a mercadoria sai, vindo da configuração fiscal da operação. */
  originZip: string | null;
  /** O checkout está cobrando transportadora? Dito pelo contrato, não pela flag. */
  checkoutCarrier?: { active: boolean; carriers: string[]; message: string };
  /** A trava do servidor (`LOGISTICS_PRODUCTION_ENABLED`). */
  processProductionEnabled?: boolean;
}

export interface LogisticsCarrierStatus {
  carrier: string;
  configured: boolean;
  environment: string;
  /** Os quatro últimos caracteres do token guardado — o token nunca volta. */
  maskedHint?: string | null;
  contactEmail?: string | null;
  updatedAt?: string | null;
  lastTestAt?: string;
  lastTestStatus?: string;
  /** Resultado do ÚLTIMO teste pedido pelo gestor; abrir a tela não testa nada. */
  connection: {
    ok: boolean;
    real: boolean;
    simulated: boolean;
    tested?: boolean;
    testedAt?: string | null;
    message?: string;
  };
  lastQuote?: { ok: boolean; at: string | null; message: string | null } | null;
  access?: LogisticsAccess;
}

/**
 * Resultado da cotação.
 *
 * `simulated` e `real` NÃO são decoração: preço simulado lido como preço de
 * transportadora vira prejuízo por pedido.
 */
export interface LogisticsQuote {
  options: {
    carrier: string;
    /**
     * O nome do serviço. O servidor manda `serviceName`; `service` ficou do
     * contrato antigo, que a tela lia e o servidor nunca preencheu.
     */
    serviceName?: string;
    serviceCode?: string;
    service?: string;
    priceInCents: number;
    estimatedDays?: number | null;
    simulated?: boolean;
    real?: boolean;
    /** `sandbox`: preço REAL de ambiente de teste — não vale para cobrar. */
    environment?: 'sandbox' | 'production' | null;
  }[];
  simulated: boolean;
  real: boolean;
  code?: string;
  missing?: string[];
  message?: string;
}

/**
 * O município do endereço da nota que a tabela oficial do IBGE desmente
 * (R3-IBGE): o pedido fechado antes da tabela guarda o código que o cliente
 * digitou. A ficha oferece a correção, com a cidade sugerida pelo nome.
 */
export interface MunicipioDaNotaDoPedido {
  /** De onde o destinatário sai: o retrato do faturamento, o da entrega, ou o endereço da conta. */
  lado: 'faturamento' | 'entrega' | 'cadastro';
  uf: string;
  cidade: string;
  /** O código que a tabela desmente. */
  codigo: string;
  motivo: string;
  /** A cidade da UF com o nome escrito, quando há uma só. */
  sugestao: { codigo: string; nome: string; uf: string } | null;
  /**
   * O município do próprio código, quando ele é de OUTRA UF (retrato da 84 com
   * a UF marcada errada): a ficha oferece manter o código e trocar a UF.
   * Opcional: servidor anterior não manda.
   */
  doCodigo?: { codigo: string; nome: string; uf: string } | null;
}

/** E por PEDIDO online, onde a nota é NF-e 55 e exige destinatário completo. */
export interface OrderInvoiceReadiness {
  canEmit: boolean;
  alreadyEmitted: boolean;
  documentId: string | null;
  reasons: string[];
  /** Opcional: servidor anterior ao R3-IBGE não manda — a ficha só não oferece a correção. */
  municipio?: MunicipioDaNotaDoPedido | null;
}

/** Orçamento ou pré-venda. Nenhum dos dois é venda. */
export interface Quote {
  id: string;
  number: number;
  kind: 'orcamento' | 'pre_venda';
  status: 'aberto' | 'convertido' | 'expirado' | 'cancelado';
  customer_id: string | null;
  total_cents: number;
  discount_cents: number;
  valid_until: string | null;
  converted_sale_id: string | null;
  note: string | null;
  created_at: string;
}

export interface QuoteDetail extends Quote {
  /** A validade real agora — o status guardado pode estar desatualizado. */
  expired: boolean;
  /**
   * QUEM VENDEU (GAP-V67). A coluna sempre existiu e a rota sempre a devolveu
   * dentro do `quote.*`; o tipo é que não a declarava, e por isso a tela de
   * edição não tinha como reabrir o documento com o vendedor que ele já tem —
   * salvar apagaria o vendedor de quem só quis trocar a quantidade.
   */
  seller_id: string | null;
  /**
   * A LIBERAÇÃO DE GESTOR que cobriu a concessão deste documento.
   *
   * Nula é o caso comum: o desconto coube no limite da operação e ninguém
   * precisou ser chamado. Quando existe, é a assinatura que responde "quem
   * autorizou este desconto?" na conferência de caixa — e é o servidor quem
   * junta o nome, porque ele mora em outra tabela.
   */
  liberacao: {
    id: string;
    created_at: string;
    autorizado_por: string | null;
    granted_concession_cents: number | null;
    granted_gross_cents: number | null;
    reason: string | null;
  } | null;
  /** As motos que este documento segura (GAP-PRD-111). Ausente em servidor antigo. */
  unidadesReservadas?: ReservaDaUnidade[];
  items: {
    id: string;
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    /** 1 quando o produto é controlado por unidade (a moto tem chassi). */
    serialized?: number | null;
  }[];
}

/**
 * CONSIGNAÇÃO / CONDICIONAL — mercadoria que saiu da loja sem venda (GAP-V65).
 *
 * Não confundir com o equipamento 'consignado' da oficina, que é o oposto: lá a
 * moto do cliente ENTRA na loja para ser vendida por ela.
 */
export interface Consignment {
  id: string;
  number: number;
  status: 'aberta' | 'fechada';
  customer_id: string;
  customer_name: string | null;
  valid_until: string | null;
  created_at: string;
  /** Quanto ainda está COM O CLIENTE. É a coluna que se olha na lista. */
  pending_qty: number;
  /** Quanto vale o que está lá fora, pelo valor declarado na remessa. */
  pending_value_cents: number;
}

export interface ConsignmentItem {
  id: string;
  product_id: string;
  description: string;
  delivered_qty: number;
  returned_qty: number;
  sold_qty: number;
  /** O valor DECLARADO na remessa. A venda reprecifica pelo preço do dia. */
  unit_price_cents: number;
  /** Entregue − devolvido − vendido. Derivado no servidor, nunca gravado. */
  pending_qty: number;
}

export interface ConsignmentDetail {
  id: string;
  number: number;
  status: 'aberta' | 'fechada';
  customer_id: string;
  customer_name: string | null;
  seller_id: string | null;
  valid_until: string | null;
  note: string | null;
  created_at: string;
  closed_at: string | null;
  items: ConsignmentItem[];
  /** A razão da custódia: remessa, retornos, faturamentos e fechamento. */
  events: {
    id: string;
    kind: string;
    sale_id: string | null;
    sale_number: number | null;
    user_name: string | null;
    detail: string | null;
    created_at: string;
  }[];
}

/** Liberação de um gestor para uma ação restrita do balcão. */
export interface Authorization {
  id: string;
  action: string;
  authorizedBy: string;
  authorizedByName: string;
  createdAt: string;
  /** O ALVO do "sim" — a venda ou o turno. Nulo nas ações medidas por valor. */
  referenceId: string | null;
  /** Onde a senha foi digitada. Nulo quando a sessão não é de terminal. */
  terminalId: string | null;
  ip: string | null;
  /** Até quando o bilhete vale — derivado, não gravado. */
  expiresAt: string;
  /** O motivo digitado na liberação (P0 da Preço Justo). Opcional: servidor antigo não manda. */
  justificativa?: string | null;
}

/**
 * UMA LIBERAÇÃO NA LISTA — a linha crua da tabela, com os DOIS nomes.
 *
 * Vem como a coluna se chama (`snake_case`) porque a rota devolve `a.*` com os
 * dois JOINs de nome, e traduzir no cliente criaria um segundo vocabulário para
 * a mesma linha. Os dois nomes importam igualmente: quem ASSINOU responde pelo
 * "sim", e quem PEDIU é o padrão que a lista existe para revelar — "o caixa
 * novo pediu seis liberações esta semana" não se lê num uuid.
 */
export interface LiberacaoDeGestor {
  id: string;
  action: string;
  requested_by: string;
  requested_by_name: string | null;
  authorized_by: string;
  authorized_by_name: string | null;
  reason: string | null;
  /** O motivo digitado por gente (P0); `reason` é a frase montada pela tela. */
  justification?: string | null;
  reference_id: string | null;
  granted_concession_cents: number | null;
  consumed_ref_type: string | null;
  consumed_ref_id: string | null;
  consumed_at: string | null;
  terminal_id: string | null;
  ip: string | null;
  created_at: string;
}

// --------------------------------------------- Central de Relatórios (V37)

/**
 * O tipo da coluna manda na FORMATAÇÃO, e é por isso que ele viaja.
 *
 * `money` é CENTAVO INTEIRO até chegar aqui: a tela divide por 100 só para
 * escrever na célula, e o CSV (que o servidor monta) escreve com vírgula para
 * o Excel somar. Sem o tipo, a tela teria de adivinhar pelo nome da coluna —
 * e adivinharia errado no primeiro relatório com uma coluna chamada "valor"
 * que não é dinheiro.
 */
export type ReportColumnKind =
  | 'text'
  | 'money'
  | 'quantity'
  | 'number'
  | 'date'
  | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ReportColumnKind;
}

/** Os filtros que a Central sabe desenhar. Cada relatório declara os SEUS. */
export type ReportFilterName = 'periodo' | 'situacao' | 'direcao' | 'categoria' | 'busca';

export interface ReportDefinition {
  id: string;
  label: string;
  group: string;
  description: string;
  /**
   * A tela desenha SÓ estes. Oferecer um seletor que o relatório ignora é a
   * promessa que o sistema não cumpre — o mesmo defeito do botão que não fazia
   * nada.
   */
  filters: ReportFilterName[];
  columns: ReportColumn[];
  /** A ressalva, quando existe. Vem do servidor para a tela não poder esquecê-la. */
  caveat?: string;
}

export interface ReportResult {
  report: ReportDefinition;
  from: string;
  to: string;
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  generatedAt: string;
  /** O corte existe e é DECLARADO — nunca silencioso. */
  truncated: boolean;
  rowCount: number;
}

export interface ReportFilters {
  from?: string;
  to?: string;
  situacao?: string;
  direcao?: 'in' | 'out';
  categoria?: string;
  busca?: string;
  formato?: 'csv';
}

/** A query dos dois caminhos (dados e CSV), escrita uma vez só. */
function queryDoRelatorio(filtros: ReportFilters): string {
  const qs = new URLSearchParams();
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
      qs.set(chave, String(valor));
    }
  }
  const texto = qs.toString();
  return texto ? `?${texto}` : '';
}

/** Uma linha do recorte por marca — GAP-V44. */
export interface BrandSummary {
  brand: string;
  quantity: number;
  revenue_cents: number;
  sales_count: number;
}

export interface DashboardData {
  /*
    Os campos de DINHEIRO chegam nulos quando a política de gestão da empresa
    os reserva à gerência (GAP-PRD-165) — `dinheiroOculto` diz isso, e a tela
    não os lê nesse caso.
  */
  revenueCents: number;
  salesCount: number;
  /**
   * Os pedidos da loja online PAGOS no recorte, pelo dia do pagamento
   * (GAP-PRD-132). Ficam FORA de `revenueCents` (que é venda de balcão) e são
   * ditos ao lado. Opcionais: servidor anterior não manda.
   */
  onlineRevenueCents?: number | null;
  onlineOrdersCount?: number;
  averageTicketCents: number;
  openReceivablesCents: number;
  /** Opcional: servidor anterior à política de gestão não o manda. */
  dinheiroOculto?: boolean;
  byDay: { day: string; sales_count: number; revenue_cents: number }[];
  topProducts: { product_id: string; description: string; quantity: number; revenue_cents: number }[];
  bySeller: {
    seller_id: string;
    seller_name: string;
    sales_count: number;
    revenue_cents: number;
  }[];
  /** Vendas por marca no recorte — "Sem marca" é um GRUPO, não um filtro. */
  byBrand: BrandSummary[];
  /**
   * O que o recorte por marca NÃO alcança: o desconto (ou acréscimo) de rodapé
   * da venda, que não tem dono entre as linhas. Vem nomeado em vez de rateado,
   * para a soma das marcas + esta parcela fechar com o faturamento.
   */
  byBrandUnallocatedCents: number;
  /** A operação que estes números descrevem — GAP-V46. */
  companyId: string;
  /**
   * As operações do VÍNCULO desta pessoa, para o seletor do painel.
   *
   * Vem no mesmo payload de propósito: `GET /core/companies` é rota de DONO, e
   * o gerente com duas lojas não conseguiria montar o próprio seletor com ela.
   */
  companies: { id: string; tradeName: string }[];
  lowStock: StockItem[];
  /**
   * Quantos produtos estão abaixo do mínimo — `lowStock` traz só os 10
   * primeiros (GAP-PRD-164). Opcional: servidor anterior não o manda.
   */
  lowStockTotal?: number;
  /**
   * O aviso de vencimento do A1 desta operação (GAP-V40), ou `null`.
   *
   * O painel é a tela que o gestor abre todo dia; a do certificado, quase
   * nunca. Só o aviso viaja — nada do titular nem do CNPJ.
   */
  certificateAlert: CertificateAlert | null;
}

export interface SaleItemInput {
  productId: string;
  quantity: number;
  unitPriceCents?: number;
  discountCents?: number;
  /** QUAIS peças, para produto controlado por unidade. */
  unitIds?: string[];
  /**
   * O preço desta linha foi DIGITADO no balcão (G-offline-sync-07)? `false` diz
   * "é o preço que a busca me deu": se ele ficou abaixo do vigente, o servidor
   * conta a diferença como preço de tela desatualizado, e não como desconto do
   * operador. Ausente é o de sempre.
   */
  precoNegociado?: boolean;
}

export interface SalePaymentInput {
  method: string;
  amountCents: number;
  status?: 'settled' | 'pending';
  /**
   * A COBRANÇA DA MAQUININHA QUE AUTORIZOU ESTA LINHA (GAP-V48).
   *
   * Com maquininha integrada na operação, o servidor RECUSA linha de cartão
   * sem uma transação aprovada, do mesmo valor e ainda não gasta em outra
   * venda. A garantia "só fecha depois da confirmação da operadora" morava só
   * nesta tela; agora ela viaja como fato e é conferida do outro lado.
   */
  providerRef?: string;
  /**
   * O PIX do balcão gerado pelo provedor de cobrança (GAP-PRD-077). O servidor
   * confere a cobrança e decide o status da linha pelo que o provedor disse.
   */
  paymentIntentId?: string;
}

// ------------------------------------------------------------- auditoria

/**
 * Uma linha da trilha de auditoria, como o servidor a devolve.
 *
 * `user_name` vem de um JOIN com `core_users` — quem lê a trilha pergunta por
 * GENTE, e um uuid não responde. O `user_id` continua na linha porque o nome
 * pode mudar (ou o usuário ser removido) depois do fato; o id é o que não
 * mente. `detail` é o JSON que o escritor gravou, cru: quem o torna legível é
 * a tela, porque cada leitor formata do seu jeito.
 */
export interface RegistroDeAuditoria {
  id: string;
  company_id: string | null;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string | null;
  created_at: string;
}

/**
 * A página pedida E o universo dela.
 *
 * `total` respeita os filtros — sem isso a tela numeraria páginas de um
 * universo errado. `actions` são as ações que EXISTEM nesta empresa, para o
 * seletor: uma lista fixa aqui envelheceria a cada escritor novo, e são 128.
 */
export interface PaginaDeAuditoria {
  items: RegistroDeAuditoria[];
  total: number;
  actions: string[];
}

export const coreApi = {
  // produtos
  listProducts: (search?: string) =>
    apiRequest<{ items: Product[] }>(
      `/core/products${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ).then(envelope('items')),

  /**
   * Listagem com a pendência de envio junto.
   *
   * A contagem vem SEMPRE, mesmo com o filtro desligado: é ela que diz ao
   * gestor que existem produtos publicados que ninguém consegue enviar.
   */
  listProductsWithShipping: (
    options: {
      search?: string;
      missingShippingData?: boolean;
      /** A rota já paginava; só o cliente não sabia pedir. */
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.missingShippingData) params.set('missingShippingData', '1');
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.offset != null) params.set('offset', String(options.offset));
    const qs = params.toString();
    return apiRequest<{ items: Product[]; missingShippingDataCount: number }>(
      `/core/products${qs ? `?${qs}` : ''}`,
    );
  },

  /**
   * `excludeKits` é a tela de montar kit pedindo só o que pode virar peça.
   * Kit dentro de kit o servidor recusa — oferecer e depois negar ensina a
   * pessoa a desconfiar da tela.
   *
   * `includeParts` é o interruptor "Incluir peças da oficina" do PDV. Sem ele
   * a busca POR TEXTO devolve só mercadoria de revenda: digitar "bateria" e
   * receber quarenta baterias da bancada esconde o produto certo no meio do
   * estoque de conserto. A busca por CÓDIGO acha a peça de qualquer jeito,
   * ligado ou desligado — essa metade da regra é do servidor e não passa por
   * aqui.
   */
  searchProducts: (
    term: string,
    options: { excludeKits?: boolean; includeParts?: boolean } = {},
  ) =>
    apiRequest<{ items: Product[] }>(
      `/core/products/search?q=${encodeURIComponent(term)}`
        + (options.excludeKits ? '&excludeKits=1' : '')
        + (options.includeParts ? '&includeParts=1' : ''),
    ).then(envelope('items')),

  createProduct: (input: Record<string, unknown>) =>
    apiRequest<Product>('/core/products', { method: 'POST', body: input }),

  updateProduct: (id: string, input: Record<string, unknown>) =>
    apiRequest<Product>(`/core/products/${id}`, { method: 'PUT', body: input }),

  /**
   * A busca do BALCÃO, com a pergunta que só ele faz: a lista voltou vazia
   * porque nada casou, ou porque a operação não tem produto ativo nenhum?
   * "Nenhum produto encontrado" e "nenhum produto cadastrado" pedem gestos
   * diferentes — procurar de outro jeito, ou cadastrar o primeiro.
   */
  buscarNoBalcao: (
    term: string,
    options: { includeParts?: boolean } = {},
  ): Promise<{ items: Product[]; catalogoVazio: boolean }> =>
    apiRequest<{ items: Product[]; catalogoVazio?: boolean }>(
      `/core/products/search?q=${encodeURIComponent(term)}`
        + (options.includeParts ? '&includeParts=1' : ''),
    ).then((r) => ({ items: r.items ?? [], catalogoVazio: r.catalogoVazio === true })),

  /**
   * Exclui o produto que nunca aconteceu. Com histórico o servidor responde
   * 409 `CORE_PRODUCT_HAS_HISTORY` com `details.historico` (o que prende, já
   * contado) e `details.saida: 'inativar'` — quem chama oferece o arquivamento.
   */
  deleteProduct: (id: string) =>
    apiRequest<{ deleted: true; id: string; name: string }>(`/core/products/${id}`, {
      method: 'DELETE',
    }),

  // estoque
  listStock: (options: { low?: boolean; search?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.low) params.set('low', 'true');
    if (options.search) params.set('search', options.search);
    const qs = params.toString();
    return apiRequest<{ items: StockItem[] }>(`/core/stock${qs ? `?${qs}` : ''}`).then(envelope('items'));
  },

  /**
   * Lançamento manual de estoque — entrada, saída ou ajuste.
   *
   * `referenceId` é a IDENTIDADE do movimento: reenviar o mesmo id (clique
   * repetido, retentativa após falha de rede) não duplica a baixa — o servidor
   * responde o saldo corrente com `duplicated: true`. Quem chama gera o id UMA
   * vez por intenção e só o troca depois do sucesso.
   *
   * `reason` é obrigatório no que TIRA do estoque (saída e ajuste negativo) —
   * regra do servidor, espelhada na tela para a recusa não chegar depois do
   * formulário preenchido.
   */
  addStockMovement: (input: {
    productId: string;
    movementType: 'in' | 'out' | 'adjust';
    quantity: number;
    referenceType: string;
    referenceId: string;
    reason?: string;
    locationId?: string;
    unitCostCents?: number;
    note?: string;
    /**
     * O LOTE, para produto que controla validade (GAP-V35).
     *
     * `batchId` escolhe um lote da lista; `batchCode` é o que o conferente LÊ
     * NA EMBALAGEM — na ENTRADA o servidor cria o lote se ele ainda não
     * existir, e numa SAÍDA um código desconhecido é recusa (criar o lote ali
     * faria nascer um lote de saldo negativo).
     *
     * Omitir os dois é o caminho normal: na saída o servidor aplica FEFO e
     * grava a escolha; na entrada, a mercadoria fica "sem lote declarado", que
     * é a pendência que a tela de Validade mostra.
     */
    batchId?: string;
    batchCode?: string;
    expiresOn?: string;
    manufacturedOn?: string;
  }) => apiRequest<{ balance: number; duplicated: boolean }>('/core/stock/movements', {
    method: 'POST',
    body: input,
  }),

  /** Quanto vale o estoque da empresa — saldo × custo do cadastro, somado no servidor. */
  stockValuation: () => apiRequest<StockValuation>('/core/stock/valuation'),

  // clientes
  listCustomers: (search?: string) =>
    apiRequest<{ items: Customer[] }>(
      `/core/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ).then(envelope('items')),

  createCustomer: (input: Record<string, unknown>) =>
    apiRequest<Customer>('/core/customers', { method: 'POST', body: input }),

  /**
   * A ficha inteira, como está AGORA no servidor.
   *
   * É daqui que o formulário de edição parte — nunca da linha da lista, que
   * pode estar velha: editar em cima do que outro balcão já corrigiu
   * sobrescreveria a correção de volta.
   */
  getCustomer: (customerId: string) => apiRequest<Customer>(`/core/customers/${customerId}`),

  /**
   * Salva a ficha — a metade que faltava do ciclo do cliente.
   *
   * O servidor valida documento e recusa duplicata pela MESMA porta do
   * cadastro (`CORE_INVALID_DOCUMENT`, `CORE_DUPLICATE_DOCUMENT`); a tela só
   * mostra a frase que vier. A inativação viaja no campo `active`, como no
   * produto: cadastro não se apaga (a venda antiga precisa do cliente para
   * fazer sentido), sai de circulação.
   */
  updateCustomer: (customerId: string, input: CustomerUpdateInput) =>
    apiRequest<Customer>(`/core/customers/${customerId}`, { method: 'PUT', body: input }),

  /**
   * Troca (ou desfaz) a tabela de preço de um cliente que já existe.
   *
   * Rota própria, e não um "salvar cliente": é a decisão que MUDA DINHEIRO, e
   * o servidor lhe dá uma linha de auditoria própria — quem for descobrir
   * depois por que o revendedor passou a ter 15% acha nome e hora, em vez de
   * ter de deduzi-lo de um salvamento que também trocou um telefone.
   *
   * `null` remove o vínculo e devolve o cliente ao preço normal.
   */
  setCustomerPriceTable: (customerId: string, priceTableId: string | null) =>
    apiRequest<Customer>(`/core/customers/${customerId}/price-table`, {
      method: 'PUT',
      body: { priceTableId },
    }),

  /**
   * O extrato de CRÉDITO DE LOJA do cliente — saldo e movimento (GAP-V10/V47).
   *
   * Serve às duas pontas do ciclo. No BALCÃO é o que diz ao PDV se há vale a
   * oferecer: sem esta pergunta, o operador cobraria o valor inteiro de quem
   * tem saldo. No ESCRITÓRIO é a ficha do cliente respondendo "de onde veio
   * esse crédito?", com o número da devolução que o concedeu.
   *
   * Cliente de outra operação volta com saldo ZERO e lista vazia — que é a
   * verdade daqui, e não um vazamento disfarçado de erro.
   */
  customerCredits: (customerId: string) =>
    apiRequest<CustomerCreditStatement>(`/core/customers/${customerId}/credits`).then((r) =>
      // O contrato é conferido na BORDA, e não no meio do render: uma resposta
      // sem `entries` quebraria a ficha do cliente inteira ao tentar contar as
      // linhas — a tela some e ninguém sabe por quê. Aqui a falha vira
      // `ApiRequestError`, que quem chama já sabe engolir (o extrato não
      // aparece) sem derrubar o formulário ao lado.
      exigirCampos(r, 'balance', 'entries'),
    ),

  /** Quanto a operação DEVE em vale, somado. Passivo, e é de gerência. */
  customerCreditLiability: () =>
    apiRequest<{ cents: number; customers: number }>('/core/customer-credits/liability'),

  // ------------------------------------------------------- preço do carrinho

  /**
   * O carrinho reprecificado para um cliente.
   *
   * NENHUMA REGRA DE PREÇO NASCE NO NAVEGADOR. A tela pergunta e desenha; quem
   * decide quanto custa é o `PricingService`, o mesmo arquivo que a venda usa
   * para conferir. Se o PDV calculasse o desconto do revendedor por conta
   * própria, a primeira divergência apareceria como venda recusada por alçada
   * num carrinho que a tela mostrava dentro do limite — e o balcão não teria
   * como saber quem está certo.
   *
   * `customerId: null` é legítimo e é o que a tela manda quando o operador TIRA
   * o cliente do carrinho: volta com os preços normais e `priceTable: null`.
   *
   * `items` vazio também é legítimo: serve para a tela anunciar a condição do
   * cliente antes do primeiro bipe.
   *
   * `quantity` viaja porque o carrinho a conhece, mas HOJE não influencia o
   * preço — tabela por faixa de quantidade ficou fora desta rodada. Quando
   * existir, a conta muda no servidor e nenhuma tela precisa ser tocada.
   */
  priceCart: (input: {
    customerId: string | null;
    items: { productId: string; quantity: number }[];
  }) => apiRequest<CarrinhoPrecificado>('/core/pricing/cart', { method: 'POST', body: input }),

  // caixa

  /**
   * O caixa aberto deste terminal E o teto da sangria, na mesma resposta.
   *
   * O `.then(envelope('session'))` que morava aqui jogava fora metade do que o
   * servidor manda. E ela não é acessória: `cashWithdrawalLimitCents` é o
   * ÚNICO caminho pelo qual o operador de caixa fica sabendo quanto pode tirar
   * da gaveta — `GET /core/sale-policies` exige perfil de gerente, e quem está
   * no PDV não é gerente. Descartar o campo aqui condenava a tela a descobrir
   * o teto pela recusa, depois de o operador já ter digitado o valor.
   *
   * `null` é SEM TETO, e não "não veio": é a resposta de uma operação que não
   * configurou trava nenhuma, e a tela usa exatamente isso para não desenhar
   * aviso algum.
   */
  getOpenCash: (terminalId?: string | null) =>
    apiRequest<CaixaDoComputador>(
      terminalId ? `/core/cash/open?terminalId=${encodeURIComponent(terminalId)}` : '/core/cash/open',
    ),

  openCash: (openingCents: number, terminalId?: string | null) =>
    apiRequest<CashSession>('/core/cash/open', {
      method: 'POST',
      body: { openingCents, terminalId: terminalId ?? undefined },
    }),

  /**
   * O histórico de turnos da gaveta, mais recente primeiro.
   *
   * `limit` obrigatório de propósito: o servidor corta em 200 de qualquer
   * forma ("o histórico completo é caso de exportação, não de tela"), e um
   * padrão aqui deixaria a tela pedir sem pensar quanto.
   */
  listCashSessions: (limit: number) =>
    apiRequest<{ items: TurnoDeCaixa[] }>(`/core/cash/sessions?limit=${limit}`),

  /**
   * Suprimento e sangria da gaveta.
   *
   * `authorizationId` só tem efeito na SANGRIA acima do teto da operação — é a
   * liberação que `CashService.addMovement` consome. No suprimento ele é
   * ignorado do outro lado, e não vale a pena uma segunda função por isso:
   * pôr dinheiro na gaveta nunca precisou de gestor.
   *
   * `idempotencyKey` (H-caixa-seguranca-09): a mesma chave em todo reenvio do
   * MESMO movimento. Sem ela, a resposta perdida no Wi-Fi e o segundo clique
   * gravavam a sangria duas vezes. Vai só no cabeçalho — o movimento de gaveta
   * NÃO entra na fila offline: dinheiro que sai da gaveta sem o servidor saber
   * seria pior do que o erro na tela.
   */
  cashMovement: (
    sessionId: string,
    movementType: 'supply' | 'withdrawal',
    amountCents: number,
    note?: string,
    authorizationId?: string,
    idempotencyKey?: string,
  ) =>
    apiRequest<{ balance: number; repetido?: boolean }>(`/core/cash/${sessionId}/movements`, {
      method: 'POST',
      body: { movementType, amountCents, note, authorizationId },
      idempotencyKey,
    }),

  cashSummary: (sessionId: string) =>
    apiRequest<{
      session: CashSession;
      expectedCents: number;
      byMethod: { method: string; total: number }[];
      /** O troco devolvido no turno: entregue em espécie − troco = gaveta. */
      changeCents: number;
      movements: Record<string, unknown>[];
      /** O dinheiro eletrônico do turno ainda indefinido (GAP-PRD-081). Nulo em turno fechado. */
      pendenciasEletronicas?: PendenciasEletronicas | null;
    }>(`/core/cash/${sessionId}/summary`),

  /**
   * Fecha o turno. Com pendência eletrônica no turno (GAP-PRD-081) o servidor
   * recusa com `CORE_CASH_CLOSE_ELECTRONIC_PENDING` e a lista; fechar assim
   * mesmo exige `pendencias: { ciente: true, motivo }`.
   */
  closeCash: (
    sessionId: string,
    countedCents: number,
    note?: string,
    pendencias?: { ciente: boolean; motivo: string },
  ) =>
    apiRequest<CashSession>(`/core/cash/${sessionId}/close`, {
      method: 'POST',
      body: {
        countedCents,
        note,
        ...(pendencias ? { pendenciasCiente: pendencias.ciente, pendenciasMotivo: pendencias.motivo } : {}),
      },
    }),

  /**
   * Reabre o último turno fechado — a porta que não existia.
   *
   * `authorizationId` é o bilhete do gestor, e vai só quando quem clica não tem
   * alçada: o servidor recusa com `CORE_REOPEN_NEEDS_AUTHORIZATION` e a tela
   * pede a credencial ali mesmo. Quem tem alçada não manda nada — mandar seria
   * pedir liberação para si mesmo, que é justamente o que o mecanismo recusa.
   */
  reopenCash: (sessionId: string, reason: string, authorizationId?: string) =>
    apiRequest<CashSession>(`/core/cash/${sessionId}/reopen`, {
      method: 'POST',
      body: { reason, authorizationId },
    }),

  // vendas
  createSale: (
    input: {
      items: SaleItemInput[];
      payments: SalePaymentInput[];
      customerId?: string | null;
      /**
       * QUEM vendeu — diferente de quem digitou.
       *
       * Sem isto o servidor grava o usuário logado, e "vendas por vendedor"
       * vira "vendas por operador de caixa". Omitido, o comportamento antigo
       * continua valendo.
       */
      sellerId?: string | null;
      cashSessionId?: string | null;
      /**
       * O caixa deste computador (GAP-PRD-039). O servidor recusa com 409 a
       * venda cujo caixa não é o da gaveta informada.
       */
      terminalId?: string | null;
      discountCents?: number;
      /**
       * Juros de parcelamento e frete, lançados no pagamento.
       *
       * Fica FORA da base da concessão de propósito: inflar o bruto com juros
       * deixaria dar mais desconto quanto mais juros se cobra do cliente.
       */
      surchargeCents?: number;
      note?: string;
      /** Total estimado pelo PDV, usado só para aferir a alçada do desconto. */
      estimatedTotalCents?: number;
      /** Liberação obtida em `authorize`, quando o desconto passa do limite. */
      authorizationId?: string;
      /**
       * Itens que ENTRARAM no carrinho e SAÍRAM antes do Finalizar (GAP-V52).
       *
       * Retrato congelado da remoção — nome, quantidade e preço da hora — que
       * o servidor grava em core_sale_removed_items. Quem removeu é o usuário
       * do TOKEN: o servidor ignora qualquer autor vindo do corpo.
       */
      cancelledItems?: {
        productId: string;
        name: string;
        quantity: number;
        unitPriceCents: number;
        removedAt: string;
      }[];
      /**
       * Quanto do CRÉDITO DE LOJA do cliente esta venda abate (GAP-V10/V47).
       *
       * Fica FORA de `payments` de propósito, e o servidor exige que fique: ali
       * mora o que o cliente PAGOU, e crédito de loja é o contrário disso — é a
       * loja quitando uma dívida que já tinha com ele desde uma devolução. Posto
       * como forma de pagamento, ele apareceria em todo relatório de recebimento
       * como dinheiro que nunca entrou.
       *
       * Só o VALOR viaja: de quem é o saldo já está dito em `customerId`. Sem
       * cliente, acima do total (vale não vira troco) ou acima do saldo, o
       * servidor recusa — a tela evita chegar lá, mas quem decide é ele.
       */
      customerCreditCents?: number;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<Sale>('/core/sales', {
      method: 'POST',
      body: input,
      idempotencyKey,
      // A ÚNICA escrita que entra na fila quando o servidor não responde.
      // Numa loja, parar de vender é o pior desfecho — e a chave acima é o que
      // torna o reenvio seguro: a mesma chave devolve a venda original.
      queueWhenOffline: true,
      queueLabel: 'venda do PDV',
    }),

  getProduct: (id: string) => apiRequest<Product>(`/core/products/${id}`).then((r) => exigirCampos(r, 'id', 'internal_code', 'sku', 'barcode', 'name', 'category', 'brand', 'unit', 'cost_cents', 'price_cents', 'min_stock', 'active')),

  /**
   * O HISTÓRICO do produto: o que mudou, de quanto para quanto, por quem (V05).
   *
   * Lê a MESMA trilha de auditoria que a AuditoriaPage — recortada a um
   * produto e a esta empresa. Não há segunda tabela de histórico: ela
   * divergiria da auditoria no primeiro caminho que esquecesse de escrever nas
   * duas.
   */
  productHistory: (productId: string) =>
    apiRequest<{ items: EventoDoProduto[] }>(`/core/products/${productId}/history`).then(
      (r) => r.items ?? [],
    ),

  /** As faixas por quantidade de um produto (GAP-V04). */
  listPriceTiers: (productId: string) =>
    apiRequest<{ tiers: FaixaDePreco[] }>(`/core/products/${productId}/price-tiers`).then(
      (r) => r.tiers ?? [],
    ),

  /**
   * Cria ou corrige uma faixa. O PISO é a chave: regravar o mesmo piso troca o
   * preço em vez de criar uma segunda resposta para a mesma pergunta.
   */
  savePriceTier: (productId: string, minQuantity: number, priceCents: number) =>
    apiRequest<{ tiers: FaixaDePreco[] }>(`/core/products/${productId}/price-tiers`, {
      method: 'PUT',
      body: { minQuantity, priceCents },
    }).then(envelope('tiers')),

  removePriceTier: (productId: string, minQuantity: number) =>
    apiRequest<{ tiers: FaixaDePreco[] }>(
      `/core/products/${productId}/price-tiers/${minQuantity}`,
      { method: 'DELETE' },
    ).then(envelope('tiers')),

  /** Os campos personalizados deste produto, com valor (GAP-V07). */
  listProductCustomFields: (productId: string) =>
    apiRequest<{ values: ValorPersonalizado[] }>(
      `/core/products/${productId}/custom-fields`,
    ).then(envelope('values')),

  /**
   * Grava os valores. O mapa é `{ CODIGO: valor }` e só o que ele MENCIONA é
   * escrito — vazio limpa, ausente preserva.
   */
  saveProductCustomFields: (productId: string, values: Record<string, string>) =>
    apiRequest<{ values: ValorPersonalizado[] }>(`/core/products/${productId}/custom-fields`, {
      method: 'PUT',
      body: { values },
    }).then(envelope('values')),

  // ------------------------------------------------------ categorias e marcas

  // auxiliares do catálogo
  getCatalogAux: () => apiRequest<CatalogAux>('/core/catalog/aux').then((r) => exigirCampos(r, 'units', 'taxGroups', 'taxRates', 'priceTables')),

  /**
   * Só os grupos tributários (GAP-V01).
   *
   * O cadastro de produto precisa de UM seletor; `getCatalogAux` traz quatro
   * listas, e o formulário abre muito mais vezes que a tela de Auxiliares.
   */
  listTaxGroups: () =>
    apiRequest<{ taxGroups: GrupoTributario[] }>('/core/catalog/tax-groups').then(
      (r) => r.taxGroups ?? [],
    ),

  /** As definições de campo personalizado da operação (GAP-V07). */
  listCustomFields: () =>
    apiRequest<{ fields: CampoPersonalizado[] }>('/core/catalog/custom-fields').then(
      (r) => r.fields ?? [],
    ),

  saveCustomField: (input: Record<string, unknown>) =>
    apiRequest<CampoPersonalizado>('/core/catalog/custom-fields', { method: 'POST', body: input }),

  deleteCustomField: (id: string) =>
    apiRequest<{ fields: CampoPersonalizado[] }>(`/core/catalog/custom-fields/${id}`, {
      method: 'DELETE',
    }),

  saveUnit: (input: Partial<Unidade> & { code: string; name: string; decimals: number }) =>
    apiRequest<Unidade>('/core/catalog/units', { method: 'POST', body: input }).then((r) => exigirCampos(r, 'id', 'code', 'name', 'active', 'usage')),

  deleteUnit: (id: string) =>
    apiRequest<{ units: Unidade[] }>(`/core/catalog/units/${id}`, { method: 'DELETE' }),

  saveTaxGroup: (input: Record<string, unknown>) =>
    apiRequest<GrupoTributario>('/core/catalog/tax-groups', { method: 'POST', body: input }),

  deleteTaxGroup: (id: string) =>
    apiRequest<{ taxGroups: GrupoTributario[] }>(`/core/catalog/tax-groups/${id}`, {
      method: 'DELETE',
    }),

  saveTaxRate: (input: Record<string, unknown>) =>
    apiRequest<Aliquota>('/core/catalog/tax-rates', { method: 'POST', body: input }),

  deleteTaxRate: (id: string) =>
    apiRequest<{ taxRates: Aliquota[] }>(`/core/catalog/tax-rates/${id}`, { method: 'DELETE' }),

  savePriceTable: (input: { id?: string; name: string; percentOff: number; active?: boolean }) =>
    apiRequest<TabelaDePreco>('/core/catalog/price-tables', { method: 'POST', body: input }),

  deletePriceTable: (id: string) =>
    apiRequest<{ priceTables: TabelaDePreco[] }>(`/core/catalog/price-tables/${id}`, {
      method: 'DELETE',
    }),

  // Os preços fixados de uma tabela. As três rotas devolvem a MESMA lista
  // atualizada: a tela re-renderiza o que o servidor afirma, não o que ela
  // acha que aconteceu.
  listPriceTableItems: (tableId: string) =>
    apiRequest<{ items: PrecoFixado[] }>(`/core/catalog/price-tables/${tableId}/items`),

  setPriceTableItem: (tableId: string, productId: string, priceCents: number) =>
    apiRequest<{ items: PrecoFixado[] }>(
      `/core/catalog/price-tables/${tableId}/items/${productId}`,
      { method: 'PUT', body: { priceCents } },
    ),

  removePriceTableItem: (tableId: string, productId: string) =>
    apiRequest<{ items: PrecoFixado[] }>(
      `/core/catalog/price-tables/${tableId}/items/${productId}`,
      { method: 'DELETE' },
    ),

  /**
   * Clona um produto.
   *
   * Vão junto: cadastro, peças do kit, preços em tabela e as fotos (com o
   * arquivo duplicado). Ficam de fora: código de barras, estoque, variantes e
   * a publicação na loja. O porquê de cada uma está em `ProductCloneService`.
   */
  cloneProduct: (productId: string, name?: string) =>
    apiRequest<Product>(`/core/products/${productId}/clone`, {
      method: 'POST',
      body: name ? { name } : {},
    }),

  /**
   * Mercadoria de revenda <-> peça de oficina.
   *
   * Rota PRÓPRIA, e não um campo do PUT, porque trocar o tipo não é editar um
   * campo: o produto sai da vitrine, perde o destaque e o saldo dele muda de
   * dono na mesma hora. Só esta rota devolve os `efeitos` — e é por eles que a
   * tela consegue contar o que aconteceu em vez de dizer "salvo com sucesso".
   */
  definirTipoProduto: (
    productId: string,
    input: { kind: 'part' | 'retail'; workshopId?: string | null },
  ) =>
    apiRequest<ResultadoDoTipo>(`/core/products/${productId}/tipo`, {
      method: 'POST',
      body: input,
    }),

  // códigos de barras adicionais do produto
  listProductBarcodes: (productId: string) =>
    apiRequest<{ barcodes: string[] }>(`/core/products/${productId}/barcodes`),

  addProductBarcode: (productId: string, barcode: string) =>
    apiRequest<{ barcodes: string[] }>(`/core/products/${productId}/barcodes`, {
      method: 'POST',
      body: { barcode },
    }),

  removeProductBarcode: (productId: string, barcode: string) =>
    apiRequest<{ barcodes: string[] }>(
      `/core/products/${productId}/barcodes/${encodeURIComponent(barcode)}`,
      { method: 'DELETE' },
    ),

  // kit
  getKit: (productId: string) =>
    apiRequest<{ components: ComponenteDoKit[]; costCents: number }>(
      `/core/products/${productId}/kit`,
    ),

  setKit: (productId: string, components: { componentId: string; quantity: number }[]) =>
    apiRequest<{ components: ComponenteDoKit[]; costCents: number }>(
      `/core/products/${productId}/kit`,
      { method: 'PUT', body: { components } },
    ),

  /**
   * Markup e margem: a conta vive no servidor.
   *
   * Repetir a fórmula aqui criaria uma segunda implementação da mesma regra, e
   * as duas divergiriam no arredondamento — a tela mostraria um preço e o
   * cadastro salvaria outro.
   */
  pricingPreview: (input: {
    costCents: number;
    priceCents?: number;
    markupPercent?: number;
    marginPercent?: number;
    minPriceCents?: number | null;
    minMarkupPercent?: number | null;
    minMarginPercent?: number | null;
  }) => apiRequest<AvaliacaoPreco>('/core/catalog/pricing/preview', { method: 'POST', body: input }),

  getTaxonomy: () =>
    apiRequest<Taxonomy>('/core/taxonomy').then((r) => exigirCampos(r, 'categories')),

  saveCategory: (input: { id?: string; name: string; parentId?: string | null }) =>
    apiRequest<Category>('/core/taxonomy/categories', { method: 'POST', body: input }),

  /** Migra os produtos da origem e apaga a origem. */
  mergeCategory: (sourceId: string, targetId: string) =>
    apiRequest<Category>('/core/taxonomy/categories/merge', {
      method: 'POST',
      body: { sourceId, targetId },
    }),

  removeCategory: (id: string) =>
    apiRequest<{ categories: Category[] }>(`/core/taxonomy/categories/${id}`, {
      method: 'DELETE',
    }),

  saveBrand: (input: { id?: string; name: string }) =>
    apiRequest<Brand>('/core/taxonomy/brands', { method: 'POST', body: input }),

  mergeBrand: (sourceId: string, targetId: string) =>
    apiRequest<Brand>('/core/taxonomy/brands/merge', {
      method: 'POST',
      body: { sourceId, targetId },
    }),

  removeBrand: (id: string) =>
    apiRequest<{ brands: Brand[] }>(`/core/taxonomy/brands/${id}`, { method: 'DELETE' }),

  // --------------------------------------------- entrada de NF-e por e-mail

  getMailInbox: () => apiRequest<MailInboxStatus>('/core/mail/inbox'),

  getMailSchedule: () => apiRequest<MailSchedule | null>('/core/mail/schedule'),

  /** Liga/desliga a leitura automática, que roda no backend. */
  setMailSchedule: (enabled: boolean, intervalMinutes?: number) =>
    apiRequest<MailSchedule>('/core/mail/schedule', {
      method: 'POST',
      body: { enabled, intervalMinutes },
    }),

  /** A senha vai uma vez e fica cifrada no cofre do backend. */
  saveMailInbox: (input: {
    address: string;
    host: string;
    port?: number;
    folder?: string;
    password?: string;
    afterRead?: MailAfterRead;
    processedFolder?: string | null;
  }) => apiRequest<MailInboxStatus>('/core/mail/inbox', { method: 'POST', body: input }),

  removeMailInbox: () => apiRequest<MailInboxStatus>('/core/mail/inbox', { method: 'DELETE' }),

  /** Testa a senha sem ler nenhuma nota (GAP-PRD-128). */
  testMailInbox: () =>
    apiRequest<MailConnectionTest>('/core/mail/inbox/test', { method: 'POST' }),

  listMailMessages: () =>
    apiRequest<{ items: MailMessage[] }>('/core/mail/messages').then(envelope('items')),

  /** Lê a caixa agora. Não movimenta estoque: gera notas em conferência. */
  checkMailInbox: () =>
    apiRequest<MailCheckResult>('/core/mail/check', {
      method: 'POST',
    }),

  // ------------------------------------------------------------- impressão

  printReadiness: () =>
    apiRequest<{
      configured: boolean;
      readiness: 'READY_FOR_HARDWARE' | 'BROWSER_ONLY' | 'AGENT_READY' | string;
      message: string;
      /** Cada impressora: caixa, endereço, agente no ar, último teste (GAP-PRD-082). */
      printers?: SituacaoDaImpressora[];
    }>('/core/print/readiness'),

  listPrinters: () => apiRequest<{ items: Printer[] }>('/core/print/printers').then(envelope('items')),

  savePrinter: (input: {
    id?: string;
    name: string;
    kind: 'cupom' | 'etiqueta' | 'a4';
    transport?: 'browser' | 'agent';
    paperWidthMm?: number | null;
    isDefault?: boolean;
    active?: boolean;
    /** Impressora de agente: o caixa e o endereço dela naquele computador (GAP-PRD-082). */
    pdvTerminalId?: string | null;
    agentDevice?: string | null;
  }) => apiRequest<Printer>('/core/print/printers', { method: 'POST', body: input }),

  /** Enfileira a impressão. Não cria venda, nota, receita nem baixa. */
  createPrintJob: (input: {
    documentType: string;
    documentId: string;
    copies?: number;
    /** O caixa deste computador: escolhe a térmica dele (GAP-PRD-082). */
    terminalId?: string | null;
    /** Abrir a gaveta junto do cupom — só pelo agente, só cupom de venda. */
    openDrawer?: boolean;
  }) =>
    apiRequest<PrintJob>('/core/print/jobs', { method: 'POST', body: input }),

  reprintJob: (jobId: string) =>
    apiRequest<PrintJob>(`/core/print/jobs/${jobId}/reprint`, { method: 'POST' }),

  listPrintJobs: (documentId?: string) =>
    apiRequest<{ items: PrintJob[] }>(
      `/core/print/jobs${documentId ? `?documentId=${documentId}` : ''}`,
    ).then(envelope('items')),

  /**
   * DESISTE do cupom que o agente local AINDA NÃO PEGOU — num passo só, no
   * servidor (F-cupom-fiscal-09).
   *
   * Era "reler o job e, se ainda `ready`, mandar `cancelled`": entre a
   * releitura e o cancelamento o agente podia pegar o cupom, e o servidor
   * aceita `printing → cancelled` — a tela dizia "cancelado" e o papel saía
   * depois. A rota cancela só se o job AINDA está `ready`, na mesma instrução;
   * se o agente já pegou, responde 409 `CORE_PRINT_JOB_TAKEN`.
   */
  desistirDoJobDeImpressao: (jobId: string, motivo: string) =>
    apiRequest<PrintJob>(`/core/print/jobs/${encodeURIComponent(jobId)}/desistir`, {
      method: 'POST',
      body: { motivo },
    }),

  advancePrintJob: (jobId: string, status: string, error?: string) =>
    apiRequest<PrintJob>(`/core/print/jobs/${jobId}/status`, {
      method: 'POST',
      body: { status, error },
    }),

  /*
    NÃO EXISTE `printDocumentUrl`, e a ausência é o conserto.

    Existiu, e o que ela devolvia era uma URL que ninguém consegue abrir:
    `GET /core/print/jobs/:id/document` passa por `authMiddleware`, que lê o
    token só de `Authorization`. Janela aberta por URL não manda cabeçalho, e a
    rota respondia 401 — o PDV mostrava erro de autenticação no lugar do cupom,
    todo dia. Um construtor de URL para rota autenticada é um convite a repetir
    isso; o caminho é `apiBinary` + `blob:`, em `src/lib/print.ts`.
  */

  // ------------------------------------------------------ fotos do produto

  /**
   * As imagens são servidas pela API, não pelo Vite. O caminho vindo do banco
   * é relativo à API — montá-lo aqui evita que cada tela tenha que saber disso.
   */
  imageUrl: (path: string) => (path.startsWith('http') ? path : `${apiOrigin()}${path}`),

  listProductImages: (productId: string) =>
    apiRequest<{ items: ProductImage[] }>(`/core/products/${productId}/images`).then(envelope('items')),

  /**
   * `thumbDataUrl` é a miniatura do balcão, gerada em `normalizeImage` — sobe
   * junto com a foto. Ausente, a foto entra na fila do preenchimento.
   */
  addProductImage: (
    productId: string,
    input: { dataUrl: string; fileName?: string; mimeType?: string; thumbDataUrl?: string | null },
  ) =>
    apiRequest<ProductImage>(`/core/products/${productId}/images`, {
      method: 'POST',
      body: input,
    }),

  /** Preenche a miniatura de uma foto antiga (409 se ela já tem uma). */
  definirMiniatura: (productId: string, imageId: string, dataUrl: string) =>
    apiRequest<ProductImage>(`/core/products/${productId}/images/${imageId}/thumbnail`, {
      method: 'PUT',
      body: { dataUrl },
    }),

  /** As fotos da empresa sem miniatura, principal primeiro. */
  fotosSemMiniatura: (limit = 200) =>
    apiRequest<{ items: FotoSemMiniatura[]; total: number }>(
      `/core/products/fotos-sem-miniatura?limit=${limit}`,
    ),

  setPrimaryImage: (productId: string, imageId: string) =>
    apiRequest<{ items: ProductImage[] }>(
      `/core/products/${productId}/images/${imageId}/primary`,
      { method: 'POST' },
    ).then(envelope('items')),

  removeProductImage: (productId: string, imageId: string) =>
    apiRequest<{ items: ProductImage[] }>(`/core/products/${productId}/images/${imageId}`, {
      method: 'DELETE',
    }).then(envelope('items')),

  reorderProductImages: (productId: string, orderedIds: string[]) =>
    apiRequest<{ items: ProductImage[] }>(`/core/products/${productId}/images/reorder`, {
      method: 'POST',
      body: { orderedIds },
    }).then(envelope('items')),

  // Devolve as CAPACIDADES junto: qual oficina usa plaquinha é regra do
  // servidor, e a tela não pode ter uma segunda cópia dela.
  listWorkshops: () =>
    apiRequest<{ items: Workshop[] }>('/core/workshops').then(envelope('items')),

  /**
   * EM NOME DE QUEM CADA BANCADA IMPRIME.
   *
   * A OS da Oficina saía com o nome PJ MOTORS porque essa escolha morava numa
   * migração, reimposta a cada subida do servidor. O vínculo é legítimo — quem
   * vendeu a moto responde pela garantia dela —, mas é decisão de negócio, e
   * decisão de negócio tem tela.
   */
  listWorkshopBrands: () =>
    apiRequest<{ items: WorkshopBrand[] }>('/core/workshops/brands').then(envelope('items')),

  setWorkshopBrand: (workshopId: string, brandCompanyId: string | null) =>
    apiRequest<WorkshopBrand>(`/core/workshops/${workshopId}/brand`, {
      method: 'PUT',
      body: { brandCompanyId },
    }),

  // ----------------------------------------------------------------- fiscal

  getFiscalConfig: () => apiRequest<FiscalConfig>('/core/fiscal/config'),

  listProductFiscalPendencies: () =>
    apiRequest<{ items: ProductFiscalPendency[] }>('/core/fiscal/product-pendencies').then(envelope('items')),

  updateProductFiscal: (
    productId: string,
    patch: { ncm?: string; cest?: string; cfop?: string; origin?: string },
  ) =>
    apiRequest<ProductFiscalPendency | null>(`/core/fiscal/product-pendencies/${productId}`, {
      method: 'PATCH',
      body: patch,
    }),

  updateFiscalConfig: (patch: Partial<FiscalConfig>) =>
    apiRequest<FiscalConfig>('/core/fiscal/config', { method: 'PATCH', body: patch }),

  getFiscalPdvSummary: () => apiRequest<FiscalPdvSummary>('/core/fiscal/pdv-summary'),

  listFiscalDocuments: (filters: Record<string, string> = {}) => {
    const q = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v) as [string, string][],
    );
    const qs = q.toString();
    return apiRequest<{ items: FiscalDocumentRow[] }>(
      `/core/fiscal/documents${qs ? `?${qs}` : ''}`,
    ).then(envelope('items'));
  },

  getFiscalDocument: (id: string) =>
    apiRequest<{ document: FiscalDocumentRow; events: FiscalEvent[] }>(
      `/core/fiscal/documents/${id}`,
    ).then((r) => exigirCampos(r, 'document', 'events')),

  /*
    OS ATOS COM A SEFAZ NÃO ESCOLHEM O PROVIDER (GAP-PRD-005).

    Os três mandavam `developmentMode: true` — e com isso nenhum caminho de
    tela chegava à SEFAZ: a nota real era dada como cancelada com protocolo de
    ensaio, e em produção o botão morria. Quem decide o caminho é o servidor,
    pela procedência da nota (ver `fiscalAtosApi.plano`). A senha do A1 só vai
    quando alguém a digitou — pela política do dono ou porque o cofre não a tem.
  */
  cancelFiscalDocument: (documentId: string, justification: string, certificatePassword?: string) =>
    apiRequest<FiscalCancelResult>(`/core/fiscal/documents/${documentId}/cancel`, {
      method: 'POST',
      body: { justification, ...(certificatePassword ? { certificatePassword } : {}) },
    }),

  createCorrectionLetter: (documentId: string, text: string, certificatePassword?: string) =>
    apiRequest<FiscalCorrectionResult>(
      `/core/fiscal/documents/${documentId}/correction-letter`,
      { method: 'POST', body: { text, ...(certificatePassword ? { certificatePassword } : {}) } },
    ),

  getCorrectionLetterNotice: () =>
    apiRequest<{ notice: string }>('/core/fiscal/correction-letter/notice').then(envelope('notice')),

  listVoidRanges: () =>
    apiRequest<{ items: FiscalVoidRange[] }>('/core/fiscal/void-ranges').then(envelope('items')),

  createVoidRange: (input: {
    model: string;
    serie: number;
    year: number;
    from: number;
    to: number;
    justification: string;
    certificatePassword?: string;
  }) => {
    const { certificatePassword, ...pedido } = input;
    return apiRequest<FiscalVoidResult>('/core/fiscal/void-ranges', {
      method: 'POST',
      body: { ...pedido, ...(certificatePassword ? { certificatePassword } : {}) },
    });
  },

  getFiscalReconciliation: () =>
    apiRequest<ReconciliationReport>('/core/fiscal/reconciliation').then((r) =>
      exigirCampos(r, 'issues', 'critical', 'warnings'),
    ),

  emitNfceForSale: (saleId: string, developmentMode = false) =>
    apiRequest<FiscalSaleStatus>(`/core/fiscal/sales/${saleId}/emit`, {
      method: 'POST',
      body: { developmentMode },
    }),

  getFiscalStatusForSale: (saleId: string) =>
    apiRequest<FiscalSaleStatus | null>(`/core/fiscal/sales/${saleId}/status`),

  /**
   * Dá para emitir a nota DESTA venda? Perguntado antes de mostrar o botão.
   *
   * Não é o mesmo que o checklist da operação: pendência de catálogo (produto
   * sem NCM que ninguém vendeu) não pode esconder o botão, e operação em ordem
   * não autoriza uma venda com item incompleto.
   */
  getEmissionReadinessForSale: (saleId: string) =>
    apiRequest<SaleEmissionReadiness>(`/core/fiscal/sales/${saleId}/emission-readiness`),

  getLogisticsReadiness: () =>
    apiRequest<LogisticsReadiness>('/core/logistics/readiness').then((r) =>
      exigirCampos(r, 'providers'),
    ),

  getLogisticsCarriers: () =>
    apiRequest<{ items: LogisticsCarrierStatus[]; productionBlocked: boolean }>(
      '/core/logistics/carriers',
    ),

  /** Cotação de conferência. Sem peso e dimensão o servidor recusa, de propósito. */
  quoteShipping: (input: {
    originZipCode?: string;
    destinationZipCode: string;
    weightGrams: number;
    heightCm: number;
    widthCm: number;
    lengthCm: number;
    declaredValueInCents?: number;
  }) => apiRequest<LogisticsQuote>('/core/logistics/quote', { method: 'POST', body: input }),

  getOrderInvoiceReadiness: (orderId: string) =>
    apiRequest<OrderInvoiceReadiness>(`/core/orders/${orderId}/nfe/readiness`),

  /**
   * Corrige o município do endereço da nota do pedido (R3-IBGE): só quando a
   * tabela do IBGE desmente o código de hoje, e só antes da nota. Devolve a
   * prontidão recalculada.
   */
  corrigirMunicipioDaNotaDoPedido: (orderId: string, cityIbge: string) =>
    apiRequest<OrderInvoiceReadiness>(`/core/orders/${orderId}/nfe/municipio`, {
      method: 'POST',
      body: { cityIbge },
    }),

  /**
   * Emite a NF-e do pedido online.
   *
   * A nota REFERENCIA o pedido; não cria venda, não baixa estoque e não lança
   * receita — isso já aconteceu no checkout e no pagamento.
   */
  emitNfeForOrder: (orderId: string, developmentMode = false) =>
    apiRequest<FiscalSaleStatus>(`/core/orders/${orderId}/nfe`, {
      method: 'POST',
      body: { developmentMode },
    }),

  /**
   * O checklist E o parecer da produção, numa chamada só.
   *
   * O envelope inteiro sobe para a tela de propósito: o botão de liberar
   * produção precisa saber, no primeiro render, se está ligado e por quê — e
   * uma segunda chamada o faria piscar.
   */
  getFiscalReadiness: (model?: string) =>
    apiRequest<{
      items: ReadinessReport[];
      productionUnlock: ProductionUnlock;
      /** O resumo do catálogo vem uma vez, e não uma por modelo. */
      classification: ClassificationSummary;
    }>(`/core/fiscal/readiness${model ? `?model=${model}` : ''}`),

  /**
   * O que o XML do fornecedor sugeriu, produto a produto.
   *
   * Sem `all`, devolve só quem tem algo a resolver — sugestão aplicável ou
   * divergência. É o que a tela quer: a lista some à medida que o trabalho
   * acaba, em vez de continuar cobrando o que já foi feito.
   */
  listProductClassifications: (options: { all?: boolean; productId?: string } = {}) =>
    apiRequest<{ items: ProductClassification[]; summary: ClassificationSummary }>(
      `/core/fiscal/classification${
        options.productId
          ? `?productId=${encodeURIComponent(options.productId)}`
          : options.all
            ? '?all=1'
            : ''
      }`,
    ),

  /**
   * Confirma as sugestões. Sem `items`, confirma tudo que é inequívoco.
   *
   * Com `items`, é escolha explícita — e é o único caminho para resolver uma
   * DIVERGÊNCIA, porque escolher entre dois NCMs é decidir, e decidir é o que
   * uma pessoa faz e um lote não.
   */
  confirmProductClassification: (
    items?: { productId: string; field: CampoFiscal; value: string }[],
  ) =>
    apiRequest<{
      confirmed: number;
      products: number;
      applied: { productId: string; field: CampoFiscal; value: string }[];
    }>('/core/fiscal/classification/confirm', { method: 'POST', body: items ? { items } : {} }),

  getFiscalSeries: () =>
    apiRequest<{
      items: {
        model: string;
        series: {
          serie: number;
          nextNumber: number;
          active?: boolean;
          /** A que ambiente a série serve; `null` = aos dois (auditoria P0). */
          environment?: 'homologation' | 'production' | null;
          /** Quantas notas já usaram números da série, por ambiente. */
          usadas?: { homologation: number; production: number };
        }[];
      }[];
    }>('/core/fiscal/series').then(envelope('items')),

  setFiscalSeries: (
    model: string,
    serie: number,
    nextNumber: number,
    /** Ausente = não mexe no ambiente gravado; `null` = a série serve aos dois. */
    environment?: 'homologation' | 'production' | null,
  ) =>
    apiRequest<{ items: { serie: number; nextNumber: number }[] }>('/core/fiscal/series', {
      method: 'POST',
      body: environment === undefined ? { model, serie, nextNumber } : { model, serie, nextNumber, environment },
    }).then(envelope('items')),

  /*
    O CSC mora no núcleo (GAP-PRD-075): `/core/fiscal/nfce/csc`. Morava no
    `nfceRouter` legado (`/fiscal/nfce/csc`), a última porta fiscal fora do
    `coreRouter` — saiu com ele. O dado é o mesmo (`nfce_settings`), e é o que
    a NFC-e do núcleo lê para assinar o QR Code.
  */
  getNfceCsc: () =>
    apiRequest<{ items: NfceCscSetting[] }>('/core/fiscal/nfce/csc').then(envelope('items')),

  /**
   * Grava CSC ID + token. O token SOBE e não desce: a resposta é a versão
   * sanitizada, sem segredo. A chave de idempotência é exigida pela rota —
   * dois cliques no botão não podem virar duas gravações diferentes.
   */
  setNfceCsc: (
    input: {
      cscId: string;
      cscToken: string;
      /** O ambiente DESTE código — a SEFAZ emite um para cada (GAP-PRD-022). */
      environment: 'homologation' | 'production';
    },
    idempotencyKey: string,
  ) =>
    /*
      A unidade não viaja (GAP-PRD-180): o CSC é da operação, e o servidor
      recusa qualquer outra unidade em vez de gravar onde a NFC-e não lê.
    */
    apiRequest<NfceCscSetting>('/core/fiscal/nfce/csc', {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  // ------------------------------------------------------------ financeiro

  listFinanceEntries: (filters: {
    /**
     * O lado do dinheiro — OPCIONAL, porque a rota sempre soube responder sem
     * ele.
     *
     * A assinatura exigia direção e o servidor não: `GET /finance/entries` sem
     * `direction` devolve os dois lados, com `summary` e `aging` nulos (é o
     * próprio código da rota, e o tipo abaixo agora diz isso). Quem quer os
     * títulos de UM DOCUMENTO — a ficha da nota, a do pedido — não tem lado a
     * escolher: a nota gera dívida, a venda gera recebível, e uma delas
     * poderia gerar as duas amanhã. Exigir a direção obrigaria a ficha a
     * adivinhar de que lado o seu próprio título nasceu, e a adivinhação
     * erraria em silêncio: o bloco financeiro apareceria vazio, que é
     * indistinguível de "este documento não gerou título nenhum".
     */
    direction?: 'in' | 'out';
    situation?: string;
    dueFrom?: string;
    dueTo?: string;
    search?: string;
    /** Id da categoria, ou `sem-categoria` para o avesso do filtro. */
    categoryId?: string;
    /**
     * Id do centro de custo, ou `sem-centro-de-custo` para o avesso (GAP-V25).
     *
     * O primeiro leitor de uma coluna que era escrita há rodadas e não
     * respondia nada.
     */
    costCenterId?: string;
    /**
     * A VOLTA da rastreabilidade: os lançamentos de UM documento. É a
     * consulta que a ficha da venda/nota/pedido faz para listar os seus
     * títulos. Os dois viajam juntos — o servidor ignora metade do par.
     */
    originType?: string;
    originId?: string;
  }) => {
    const q = new URLSearchParams();
    if (filters.direction) q.set('direction', filters.direction);
    if (filters.situation) q.set('situation', filters.situation);
    if (filters.dueFrom) q.set('dueFrom', filters.dueFrom);
    if (filters.dueTo) q.set('dueTo', filters.dueTo);
    if (filters.search) q.set('search', filters.search);
    if (filters.categoryId) q.set('categoryId', filters.categoryId);
    if (filters.costCenterId) q.set('costCenterId', filters.costCenterId);
    if (filters.originType && filters.originId) {
      q.set('originType', filters.originType);
      q.set('originId', filters.originId);
    }
    return apiRequest<{
      items: FinanceEntry[];
      /**
       * Os totais do lado pedido. NULO quando não se pediu lado — e o tipo
       * dizia `FinanceSummary` seco, o que era mentira comprovada pela própria
       * rota: ela devolve `summary: direction ? summarize(...) : null`. Um
       * campo tipado como sempre-presente que chega nulo é `undefined` vazando
       * para dentro da tela sem nenhum aviso do compilador.
       */
      summary: FinanceSummary | null;
      /** As faixas de atraso do lado pedido. Nulo quando não há direção. */
      aging: FinanceAging | null;
    }>(`/core/finance/entries?${q.toString()}`);
  },

  /**
   * O lançamento avulso — agora COM a classificação.
   *
   * Os quatro campos do fim viajavam sem existir: o serviço os aceitava e
   * gravava, a rota montava o objeto nomeando seis campos e os descartava em
   * silêncio. Escrevê-los aqui sem que a rota os repasse produziria de novo o
   * formulário que oferece categoria e grava nulo — por isso o teste desta
   * tela olha o CORPO DA REQUISIÇÃO, e não a mensagem de sucesso.
   */
  createFinanceEntry: (input: {
    direction: 'in' | 'out';
    description: string;
    amountCents: number;
    dueDate?: string | null;
    customerId?: string | null;
    supplierId?: string | null;
    categoryId?: string | null;
    costCenterId?: string | null;
    accountId?: string | null;
    competenceDate?: string | null;
    /**
     * O carnê: parcelar em N vencimentos mensais a partir de `dueDate`.
     * O TOTAL viaja inteiro em `amountCents` — quem divide em centavos
     * exatos (resto na primeira parcela) é o servidor; dividir aqui criaria
     * uma segunda aritmética para divergir da primeira.
     */
    installments?: number;
  }) => apiRequest<FinanceEntry>('/core/finance/entries', { method: 'POST', body: input }),

  /**
   * As categorias do plano de contas, só para SELETOR.
   *
   * Rota própria, e não `/finance/setup`: aquela exige gerente e devolve o
   * saldo de todas as contas bancárias junto. A tela de Contas é ROTA_GESTAO —
   * estoquista e atendente chegam nela —, e um seletor que responde 403 para
   * quem a tela deixou entrar é tela quebrada em produção.
   */
  financeCategories: (direction?: 'in' | 'out') =>
    apiRequest<{ items: FinanceCategory[] }>(
      `/core/finance/categories${direction ? `?direction=${direction}` : ''}`,
    ).then(envelope('items')),

  /**
   * Os centros de custo ATIVOS, só para seletor e filtro (GAP-V25).
   *
   * Rota própria pelo mesmo motivo das categorias: `/finance/setup` exige
   * gerente e traz saldo bancário junto, e a tela de Contas recebe estoquista
   * e atendente. Nada de valor viaja aqui — só código e nome.
   */
  /**
   * A VERDADE SOBRE A GAVETA, nesta operação (GAP-V55).
   *
   * `byCommand` é `false` sempre que não houver agente local registrado —
   * porque o navegador não abre gaveta por comando, e nunca vai abrir: ele não
   * expõe porta de impressora a uma página, e o caminho de impressão dele passa
   * pelo driver, que rasteriza. Bytes de comando dentro de um HTML saem
   * IMPRESSOS, não executados.
   *
   * A tela usa isto para decidir o que dizer ao operador — e para não desenhar
   * um botão que às vezes não faz nada.
   */
  drawerReadiness: (terminalId?: string | null) =>
    apiRequest<{
      byCommand: boolean;
      agentPrinters: number;
      message: string;
      /** O pulso ESC/POS em base64, para quem TEM a porta da impressora. */
      command: string;
      /** A térmica de agente deste caixa e se o agente dela está no ar (GAP-PRD-082). */
      printerId?: string | null;
      agentOnline?: boolean;
      /** A bobina do cupom deste caixa, em qualquer transporte: o comprovante offline sai nela (PED-pdv-01). */
      paperWidthMm?: 58 | 80;
      /**
       * A loja como o cabeçalho do cupom a diz (F-cupom-fiscal-20#reauditoria):
       * o PDV guarda junto com a largura, para o comprovante offline dizer de
       * qual CNPJ o cliente comprou e para onde voltar.
       */
      loja?: { nome: string; cnpj: string | null; endereco: string | null; telefone: string | null };
    }>(terminalId ? `/core/print/drawer?terminalId=${encodeURIComponent(terminalId)}` : '/core/print/drawer'),

  financeCostCenters: () =>
    apiRequest<{ items: { id: string; code: string; name: string; active: number }[] }>(
      '/core/finance/cost-centers',
    ).then(envelope('items')),

  /**
   * O DRE do período, por competência.
   *
   * As datas são inclusivas nas duas pontas e vão como `YYYY-MM-DD` — a mesma
   * forma que o servidor compara. Mandar um timestamp aqui faria o recorte da
   * conciliação divergir do recorte do relatório, que é justamente o defeito
   * que fazia o último dia do mês sumir do painel.
   */
  incomeStatement: (from: string, to: string) =>
    apiRequest<IncomeStatement>(
      `/core/finance/income-statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ).then((r) => exigirCampos(r, 'companyId', 'from', 'to', 'revenue', 'expense', 'resultCents', 'uncategorized', 'reconciliation')),

  /**
   * O mesmo período, pela outra pergunta: por centro de custo (GAP-V25).
   *
   * Rota irmã do DRE, com a MESMA competência e o mesmo critério de
   * cancelamento — as duas telas precisam somar o mesmo conjunto, ou uma
   * contradiz a outra sem que nenhuma esteja obviamente errada.
   */
  costCenterReport: (from: string, to: string) =>
    apiRequest<CostCenterReport>(
      `/core/finance/cost-centers/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ).then((r) =>
      // A conferência de forma vale mais aqui do que em quase qualquer outra
      // rota: a tela do DRE trata este recorte como AUXILIAR e engole a falha
      // para não derrubar o relatório principal. Uma resposta com a forma
      // errada, sem esta trava, chegaria ao render e quebraria a tela inteira
      // — que é o oposto do que "auxiliar" deveria significar.
      exigirCampos(r, 'lines', 'revenueTotalCents', 'expenseTotalCents', 'unassigned'),
    ),

  listSettlements: (entryId: string) =>
    apiRequest<{ items: FinanceSettlement[] }>(
      `/core/finance/entries/${entryId}/settlements`,
    ).then(envelope('items')),

  /**
   * Dá baixa. `idempotencyKey` (GAP-PRD-173) é a chave do PEDIDO: o reenvio
   * da mesma baixa — clique duplo, resposta perdida — devolve a baixa já
   * feita (`replayed: true`) em vez de gravar outra.
   */
  settleEntry: (
    entryId: string,
    amountCents: number,
    method?: string,
    note?: string,
    idempotencyKey?: string,
  ) =>
    apiRequest<{ entry: FinanceEntry; settlements: FinanceSettlement[]; replayed?: boolean }>(
      `/core/finance/entries/${entryId}/settle`,
      { method: 'POST', body: { amountCents, method, note }, idempotencyKey },
    ),

  reverseSettlement: (settlementId: string, note?: string) =>
    apiRequest<{ entry: FinanceEntry; settlements: FinanceSettlement[] }>(
      `/core/finance/settlements/${settlementId}/reverse`,
      { method: 'POST', body: { note } },
    ),

  // ----------------------------------------- cobrança online do título (V70)
  //
  // O botão que faltava: o título do contas a receber vira PIX, boleto ou
  // link de cartão na conta DA OPERAÇÃO, e o webhook baixa o título quando o
  // dinheiro entra. Sem credencial configurada o servidor RECUSA com estado
  // honesto (409 CORE_ASAAS_UNCONFIGURED) — a tela mostra o motivo e o
  // caminho, em vez de fingir uma cobrança que não existe.

  chargeFinanceEntry: (
    entryId: string,
    input: { method: 'pix' | 'boleto' | 'cartao'; installmentCount?: number | null },
  ) =>
    apiRequest<FinanceCharge>(`/core/finance/entries/${entryId}/charge`, {
      method: 'POST',
      body: input,
    }),

  /** As cobranças DESTE título — status, erro e tentativas. */
  financeEntryCharges: (entryId: string) =>
    apiRequest<{ items: PaymentIntentRow[] }>(
      `/core/finance/entries/${entryId}/charges`,
    ).then(envelope('items')),

  /**
   * Cancela no provedor as cobranças VIVAS deste título.
   *
   * Existia o equivalente para o pedido e nada para o título: um PIX/boleto que
   * perdeu a razão de ser continuava de pé no Asaas, e o cliente podia pagá-lo.
   * A contagem volta como veio — `failed > 0` é o provedor tendo recusado
   * derrubar a cobrança, e a tela precisa dizer isso em vez de "cancelada".
   */
  cancelFinanceEntryCharges: (entryId: string) =>
    apiRequest<{ cancelled: number; failed: number }>(
      `/core/finance/entries/${entryId}/charges/cancel`,
      { method: 'POST' },
    ),

  /** A lista de status das cobranças da operação (V75). */
  listPaymentIntents: (filtros: { status?: string; originType?: string } = {}) => {
    const q = new URLSearchParams();
    if (filtros.status) q.set('status', filtros.status);
    if (filtros.originType) q.set('originType', filtros.originType);
    const query = q.toString();
    return apiRequest<{ items: PaymentIntentView[] }>(
      `/core/payment-intents${query ? `?${query}` : ''}`,
    ).then(envelope('items'));
  },

  /**
   * Tentar de novo a cobrança que falhou (V76).
   *
   * Reusa a MESMA intenção: não é uma segunda cobrança. O servidor recusa
   * (409) quando a cobrança já existe no provedor.
   */
  retryPaymentIntent: (intentId: string) =>
    // Sem `installments`: o retry é de UMA cobrança, e o carnê já existe do
    // lado de cá desde a primeira vez.
    apiRequest<Omit<FinanceCharge, 'installments'>>(
      `/core/payment-intents/${intentId}/retry`,
      { method: 'POST' },
    ),

  // --------------------------------------------------------------- empresas
  //
  // As duas únicas chamadas do frontend que falam do GRUPO, e não da operação
  // da sessão. Guardadas no servidor por `requireProfile(req)` sem perfil
  // extra — `admin_geral` e `gestor`. Quem não é responde 403, e a tela que as
  // consome só é alcançável por esses dois (ver `DONOS_DO_GRUPO`).

  listCompanies: () =>
    apiRequest<{ items: Company[] }>('/core/companies').then(envelope('items')),

  /**
   * Abre uma operação nova — empresa, gerente e, quando é oficina, a primeira
   * bancada, tudo numa transação só no servidor.
   *
   * NÃO existe `companyId` nem `userId` no corpo, e não é esquecimento: o
   * servidor ignora esses campos e usa a sessão. Mandá-los daqui sugeriria que
   * a tela escolhe o tenant — foi por um `body.companyId` assim que a rota
   * fantasma de `organizations` vazava escopo.
   */
  createCompany: (input: {
    legalName: string;
    tradeName?: string;
    cnpj?: string | null;
    kind: CompanyKind;
    /** Tipo da primeira bancada, quando é oficina. Ausente = mobilidade. */
    workshopKind?: 'mobility' | 'phones';
    /** Usa plaquinha com QR (GAP-PRD-185). Ausente = o padrão da bancada. */
    usesEquipmentTags?: boolean;
    manager: {
      login: string;
      displayName: string;
      email?: string | null;
      /** Provisória: o servidor grava `must_change_password = 1`. */
      password: string;
      profileCode?: string;
    };
  }) => apiRequest<CompanyCreated>('/core/companies', { method: 'POST', body: input }),

  // ----------------------------------------------------------------- equipe

  /**
   * Quem pode vender nesta loja — id, nome e ativo, nada mais.
   *
   * O PDV usava `listTeam`, que exige gerente: o 403 caía num catch silencioso
   * e o seletor de vendedor nunca aparecia para quem opera o caixa. Toda venda
   * saía em nome do operador, e a comissão junto.
   */
  listSellers: () =>
    apiRequest<{ items: { id: string; displayName: string; active: boolean }[] }>(
      '/core/sellers',
    ).then(envelope('items')),

  listTeam: (options: { workshopId?: string; search?: string; workshopStaff?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (options.workshopId) q.set('workshopId', options.workshopId);
    if (options.search) q.set('search', options.search);
    if (options.workshopStaff) q.set('workshopStaff', '1');
    const qs = q.toString();
    return apiRequest<{ items: TeamMember[] }>(`/core/team${qs ? `?${qs}` : ''}`).then(envelope('items'));
  },

  listAssignableProfiles: () =>
    apiRequest<{ items: string[] }>('/core/team/profiles').then(envelope('items')),

  createTeamMember: (input: {
    login: string;
    displayName: string;
    email?: string | null;
    profileCode: string;
    password: string;
    workshopIds?: string[];
  }) => apiRequest<TeamMember>('/core/team', { method: 'POST', body: input }),

  updateTeamMember: (
    id: string,
    input: {
      displayName?: string;
      email?: string | null;
      profileCode?: string;
      workshopIds?: string[];
    },
  ) => apiRequest<TeamMember>(`/core/team/${id}`, { method: 'PATCH', body: input }),

  setTeamMemberActive: (id: string, active: boolean) =>
    apiRequest<TeamMember>(`/core/team/${id}/active`, { method: 'POST', body: { active } }),

  resetTeamMemberPassword: (id: string, password: string) =>
    apiRequest<TeamMember>(`/core/team/${id}/password`, { method: 'POST', body: { password } }),

  // ---------------------------------------------------------- equipamentos

  listEquipment: (search?: string) =>
    apiRequest<{ items: Equipment[] }>(
      `/core/equipment${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ).then(envelope('items')),

  createEquipment: (input: {
    /** A bancada da máquina, quando há mais de uma no alcance (GAP-PRD-099). */
    workshopId?: string;
    origin: 'INTERNAL_PJ_MOTORS' | 'EXTERNAL_CUSTOMER';
    category?: string;
    brand?: string;
    model?: string;
    year?: number;
    version?: string;
    color?: string;
    serialNumber?: string;
    motorNumber?: string;
    chassis?: string;
    battery?: string;
    batterySerial?: string;
    ownerCustomerId?: string | null;
    notes?: string;
    // Ficha completa (rodada 52): o combinado de garantia, quando a máquina
    // entrou e quem a montou.
    warrantyMonths?: number;
    enteredAt?: string;
    assembledAt?: string;
    assemblyMechanicId?: string | null;
    /**
     * O número da plaquinha JÁ COLADA na máquina (rodada 53).
     *
     * Ausente = a máquina chegou sem adesivo e o número é sorteado. Informado,
     * a plaquinha tem que estar liberada: o servidor recusa a que ainda não
     * foi ao papel, com a frase que ensina o caminho.
     */
    tagPublicId?: number;
    /** Placa e quilometragem da máquina na entrada (GAP-PRD-106). */
    plate?: string;
    odometerKm?: number;
  }) => apiRequest<Equipment>('/core/equipment', { method: 'POST', body: input }),

  // ------------------------------------------------------------- variantes

  getVariants: (productId: string) =>
    apiRequest<VariantStock>(`/core/products/${productId}/variants`),

  generateVariants: (productId: string, axes: Record<string, string[]>) =>
    apiRequest<{ created: unknown[]; existing: unknown[] }>(
      `/core/products/${productId}/variants`,
      { method: 'POST', body: { axes } },
    ),

  // ------------------------------------------------------ razão de estoque

  listStockMovements: (
    filters: {
      productId?: string;
      kind?: string;
      from?: string;
      to?: string;
      document?: string;
      search?: string;
      limit?: number;
      /** A rota já aceitava; só o cliente não sabia pedir a página seguinte. */
      offset?: number;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    const query = qs.toString();
    return apiRequest<{ items: StockMovement[] }>(
      `/core/stock/movements${query ? `?${query}` : ''}`,
    ).then(envelope('items'));
  },

  listMovementKinds: () =>
    apiRequest<{ items: MovementKindOption[] }>('/core/stock/movement-kinds').then(envelope('items')),

  // ---------------------------------------------------------- etiquetas
  //
  // A FOLHA é desenhada no servidor, em milímetro. A tela não desenha mais
  // etiqueta: pixel não tem tamanho físico, e o adesivo saía errado.

  labelCatalog: () =>
    apiRequest<{
      sources: LabelSourceOption[];
      formats: LabelFormatOption[];
      defaultFormat: string;
      quantityModes: QuantityModeOption[];
      /** As saídas de impressão; ausentes num servidor antigo (só havia o navegador). */
      perfis?: PerfilDeImpressao[];
      perfilPadrao?: PerfilDeImpressao['id'];
      /** O que cada saída ainda precisa conferir numa impressora de verdade. */
      homologacao?: ItemDeHomologacao[];
    }>('/core/labels/catalog').then((r) => exigirCampos(r, 'sources', 'formats', 'defaultFormat', 'quantityModes')),

  labelCandidates: (query: {
    source: LabelSourceOption['id'];
    search?: string;
    lowOnly?: boolean;
    purchaseOrderId?: string;
    /** Origem "Nota de entrada": o id da nota confirmada. */
    noteId?: string;
    countId?: string;
    productId?: string;
  }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '' && v !== false) qs.set(k, String(v));
    }
    return apiRequest<LabelCandidates>(`/core/labels/candidates?${qs.toString()}`);
  },

  /** POST porque a lista colada pode ter centenas de linhas e não cabe na URL. */
  labelCandidatesFromCodes: (codes: string) =>
    apiRequest<LabelCandidates>('/core/labels/candidates/codes', {
      method: 'POST',
      body: { codes },
    }),

  labelSheet: (input: {
    formatId?: string;
    templateId?: string;
    /** Posição da primeira folha onde a impressão começa (reaproveitar folha já usada). */
    startAt?: number;
    /** A saída (perfil de impressão). Sem ela, o navegador — o comportamento de sempre. */
    perfil?: PerfilDeImpressao['id'];
    items: { productId: string; quantity: number }[];
  }) => apiRequest<RespostaDaImpressaoDeEtiquetas>('/core/labels/sheet', { method: 'POST', body: input }),

  /** O histórico de impressão de etiquetas da operação: quem, quando, o quê, por qual saída. */
  labelPrints: async () => {
    const r = await apiRequest<{ items?: unknown }>('/core/labels/prints');
    return Array.isArray(r?.items) ? (r.items as ImpressaoDeEtiquetas[]) : [];
  },
  /** Reimprime um lote do histórico: os mesmos produtos e quantidades, com o preço de hoje. */
  reprintLabels: (id: string, input: { perfil?: PerfilDeImpressao['id']; startAt?: number } = {}) =>
    apiRequest<RespostaDaImpressaoDeEtiquetas>(`/core/labels/prints/${encodeURIComponent(id)}/reprint`, { method: 'POST', body: input }),
  /** A etiqueta de teste (amostra que não é de produto nenhum + moldura de calibração) na saída escolhida. */
  labelTestPrint: (input: { templateId?: string; formatId?: string; perfil?: PerfilDeImpressao['id'] }) =>
    apiRequest<{
      html: string;
      etiquetas: number;
      folhas: number;
      perfil: PerfilDeImpressao['id'];
      arquivo: ArquivoDaEtiqueta | null;
      comandos: string | null;
      avisos: string[];
      impressaoId: string;
    }>('/core/labels/test', { method: 'POST', body: input }),

  // ------------------------------------------------ modelos de etiqueta (Preço Justo)

  // A lista chega normalizada: resposta fora do contrato vira "nenhum modelo", e as
  // três telas que a leem (Etiquetas, editor de modelos, etiqueta do produto) não quebram.
  labelTemplates: async () => {
    const r = await apiRequest<{ items?: unknown; campos?: unknown }>('/core/labels/templates');
    return {
      items: Array.isArray(r?.items) ? (r.items as ModeloDeEtiqueta[]) : [],
      campos: Array.isArray(r?.campos) ? (r.campos as CampoDeEtiqueta[]) : [],
    };
  },
  // O salvar devolve também os AVISOS do modelo (barra abaixo do mínimo GS1, campos que não cabem).
  createLabelTemplate: (input: RascunhoDeModelo) =>
    apiRequest<ModeloDeEtiqueta & { avisos?: string[] }>('/core/labels/templates', { method: 'POST', body: input }),
  updateLabelTemplate: (id: string, input: RascunhoDeModelo) =>
    apiRequest<ModeloDeEtiqueta & { avisos?: string[] }>(`/core/labels/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
  deleteLabelTemplate: (id: string) =>
    apiRequest<{ ok: true; id: string; name: string }>(`/core/labels/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** Prévia só de leitura: modelo salvo (templateId) ou em edição (template). */
  previewLabelTemplate: (input: { templateId?: string; template?: RascunhoDeModelo; productId?: string; quantity?: number }) =>
    apiRequest<{ html: string; etiquetas: number; folhas: number; avisos?: string[] }>('/core/labels/templates/preview', { method: 'POST', body: input }),

  // ------------------------------------------------ códigos do cadastro

  /** Reserva o próximo código interno livre desta operação. */
  generateInternalCode: () => apiRequest<{ code: string }>('/core/products/codes/next', { method: 'POST', body: {} }),
  /** EAN-13 de uso interno (prefixo 2) para o produto sem código do fabricante. */
  generateInternalBarcode: (productId: string) =>
    apiRequest<{ productId: string; barcode: string; generated: boolean }>(
      `/core/products/${encodeURIComponent(productId)}/barcode/internal`,
      { method: 'POST', body: {} },
    ),

  // ------------------------------------------------------------- balança

  scaleFormats: () =>
    apiRequest<{ formats: ScaleFormatOption[] }>('/core/scales/formats').then(envelope('formats')),

  weighableProducts: () =>
    apiRequest<{ items: WeighableProduct[] }>('/core/scales/products').then(envelope('items')),

  /** Devolve JSON e não o arquivo: a tela mostra o que ficou de fora antes de baixar. */
  scaleExport: (input: { formatId: string; productIds?: string[] }) =>
    apiRequest<{
      filename: string;
      content: string;
      lineCount: number;
      confirmado: boolean;
      skipped: { productId: string; name: string; reason: string }[];
    }>('/core/scales/export', { method: 'POST', body: input }),

  /**
   * O formato da etiqueta que a balança imprime e o PDV lê (D-pdv-teclado-16).
   * `null` é "leitura desligada" — a busca do PDV é a de sempre.
   *
   * `exigirCampos` e não `envelope`: aqui NULO é resposta (nada declarado), e só
   * a AUSÊNCIA do campo é contrato quebrado.
   */
  scaleLabelConfig: () =>
    apiRequest<{ config: ScaleLabelConfig | null }>('/core/catalog/scale-label').then(
      (r) => exigirCampos(r, 'config').config,
    ),

  /** Declara o formato; `null` desliga a leitura (vai como `{ config: null }`). */
  saveScaleLabelConfig: (corpo: ScaleLabelConfig | null) =>
    apiRequest<{ config: ScaleLabelConfig | null }>('/core/catalog/scale-label', {
      method: 'PUT',
      body: corpo ?? { config: null },
    }).then((r) => exigirCampos(r, 'config').config),

  // --------------------------------------------- operadora de cartão

  acquirerSetup: () =>
    apiRequest<{
      acquirers: Acquirer[];
      rates: AcquirerRate[];
      methods: PaymentMethodOption[];
    }>('/core/acquirers').then((r) => exigirCampos(r, 'acquirers', 'rates', 'methods')),

  createAcquirer: (input: { name: string; accountId?: string | null }) =>
    apiRequest<{ acquirer: Acquirer }>('/core/acquirers', {
      method: 'POST',
      body: input,
    }).then(envelope('acquirer')),

  updateAcquirer: (
    id: string,
    input: { name?: string; accountId?: string | null; active?: boolean },
  ) =>
    apiRequest<{ acquirer: Acquirer }>(`/core/acquirers/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('acquirer')),

  setAcquirerRate: (
    acquirerId: string,
    input: {
      paymentMethod: string;
      installments: number;
      feeBps: number;
      settlementDays: number;
    },
  ) =>
    apiRequest<{ rate: AcquirerRate }>(`/core/acquirers/${acquirerId}/rates`, {
      method: 'PUT',
      body: input,
    }).then(envelope('rate')),

  removeAcquirerRate: (id: string) =>
    apiRequest<void>(`/core/acquirers/rates/${id}`, { method: 'DELETE' }),

  // ----------------------------------------------------------- comissões

  commissionSetup: () =>
    apiRequest<{
      groups: CommissionGroup[];
      members: { user_id: string; group_id: string }[];
    }>('/core/commissions/setup'),

  createCommissionGroup: (name: string) =>
    apiRequest<{ group: CommissionGroup }>('/core/commissions/groups', {
      method: 'POST',
      body: { name },
    }).then(envelope('group')),

  updateCommissionGroup: (id: string, input: { name?: string; active?: boolean }) =>
    apiRequest<{ group: CommissionGroup }>(`/core/commissions/groups/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('group')),

  setCommissionTier: (groupId: string, minCents: number, rateBps: number) =>
    apiRequest<{ tier: CommissionTier }>(`/core/commissions/groups/${groupId}/tiers`, {
      method: 'PUT',
      body: { minCents, rateBps },
    }).then(envelope('tier')),

  removeCommissionTier: (tierId: string) =>
    apiRequest<void>(`/core/commissions/tiers/${tierId}`, { method: 'DELETE' }),

  setCommissionMember: (userId: string, groupId: string | null) =>
    apiRequest<{ ok: boolean }>(`/core/commissions/members/${userId}`, {
      method: 'PUT',
      body: { groupId },
    }),

  commissionSummary: (from: string, to: string) =>
    apiRequest<{
      rows: CommissionSummaryRow[];
      semComissao: { vendas: number; totalCents: number };
    }>(`/core/commissions/summary?from=${from}&to=${to}`),

  closeCommission: (input: {
    sellerId: string;
    from: string;
    to: string;
    dueDate?: string | null;
  }) =>
    apiRequest<{ closingId: string; totalCents: number; financeEntryId: string | null }>(
      '/core/commissions/close',
      { method: 'POST', body: input },
    ),

  /**
   * As formas de recebimento aceitas. Vem do servidor, que é quem grava —
   * duas listas divergem no dia em que uma muda.
   */
  paymentMethods: () =>
    apiRequest<{ methods: PaymentMethodOption[] }>('/core/payment-methods').then(envelope('methods')),

  // --------------------------------------- financeiro: os três cadastros
  //
  // Uma chamada só: a tela precisa das três listas juntas para montar os
  // seletores, e três idas ao servidor fariam a tela piscar em três tempos.

  financeSetup: () =>
    apiRequest<{
      categories: FinanceCategory[];
      costCenters: CostCenter[];
      accounts: FinanceAccount[];
    }>('/core/finance/setup'),

  createFinanceCategory: (input: {
    direction: 'in' | 'out';
    name: string;
    parentId?: string | null;
  }) =>
    apiRequest<{ category: FinanceCategory }>('/core/finance/categories', {
      method: 'POST',
      body: input,
    }).then(envelope('category')),

  updateFinanceCategory: (id: string, input: { name?: string; active?: boolean }) =>
    apiRequest<{ category: FinanceCategory }>(`/core/finance/categories/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('category')),

  createCostCenter: (input: { code: string; name: string }) =>
    apiRequest<{ costCenter: CostCenter }>('/core/finance/cost-centers', {
      method: 'POST',
      body: input,
    }).then(envelope('costCenter')),

  updateCostCenter: (id: string, input: { name?: string; active?: boolean }) =>
    apiRequest<{ costCenter: CostCenter }>(`/core/finance/cost-centers/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('costCenter')),

  createFinanceAccount: (input: {
    name: string;
    kind?: 'banco' | 'caixinha' | 'carteira';
    bankCode?: string | null;
    agency?: string | null;
    accountNumber?: string | null;
    openingBalanceCents?: number;
  }) =>
    apiRequest<{ account: FinanceAccount }>('/core/finance/accounts', {
      method: 'POST',
      body: input,
    }).then(envelope('account')),

  updateFinanceAccount: (
    id: string,
    input: { name?: string; active?: boolean; isDefault?: boolean },
  ) =>
    apiRequest<{ account: FinanceAccount }>(`/core/finance/accounts/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('account')),

  // ------------------------------------------- unidades serializadas

  /**
   * O tamanho da fila de vínculo, da empresa inteira.
   *
   * Vem do servidor porque a tela nunca tem a empresa inteira em mãos: ela
   * carrega um produto por vez, ou o que casou com o termo bipado. Somar no
   * navegador daria o total do que já está carregado — um número menor que a
   * verdade, que some sozinho quando a fila esvazia por engano.
   */
  unitsSummary: () =>
    apiRequest<{
      semPlaquinha: number;
      /** Vendidas sem plaquinha: a fila do vínculo tardio (GAP-PRD-108). */
      vendidasSemPlaquinha?: number;
      /** O dia 1 da operação de motos (GAP-PRD-112). */
      produtosSerializados?: number;
      semIdentidade?: number;
    }>('/core/units/summary'),

  listUnits: (productId: string, status?: ProductUnit['status']) =>
    apiRequest<{ items: ProductUnit[] }>(
      `/core/units/${productId}${status ? `?status=${status}` : ''}`,
    ).then(envelope('items')),

  /** Bipar o IMEI ou o chassi e achar a peça. */
  searchUnit: (termo: string) =>
    apiRequest<{ items: ProductUnit[] }>(
      `/core/units?q=${encodeURIComponent(termo)}`,
    ).then(envelope('items')),

  identifyUnit: (
    id: string,
    identidade: {
      serialNumber?: string | null;
      imei?: string | null;
      chassis?: string | null;
      motorNumber?: string | null;
      plate?: string | null;
      note?: string | null;
    },
  ) =>
    apiRequest<{ unit: ProductUnit }>(`/core/units/${id}`, {
      method: 'PATCH',
      body: identidade,
    }).then(envelope('unit')),

  writeOffUnit: (id: string, reason: string) =>
    apiRequest<{ ok: boolean }>(`/core/units/${id}/write-off`, {
      method: 'POST',
      body: { reason },
    }),

  // ------------------------------- a ponte com a plaquinha da oficina
  //
  // A mesma moto é uma UNIDADE no estoque da loja e um EQUIPAMENTO com plaquinha
  // na oficina — que é outra empresa. Estas três chamadas são o que liga os dois
  // cadastros: sem o vínculo, o balcão vende, a unidade vira "sold" e a plaquinha
  // continua sem dono, com o portal mudo para quem acabou de comprar.

  /** Plaquinhas do grupo que a loja pode adotar. */
  listPlaquinhasVinculaveis: (termo?: string, unitId?: string) => {
    // A unidade que recebe: vendida, o servidor filtra pela identidade dela
    // (vínculo tardio, GAP-PRD-108).
    const busca = new URLSearchParams();
    if (termo) busca.set('termo', termo);
    if (unitId) busca.set('unitId', unitId);
    const qs = busca.toString();
    return apiRequest<{ items: PlaquinhaCandidata[] }>(
      `/core/units/equipment-candidates${qs ? `?${qs}` : ''}`,
    ).then(envelope('items'));
  },

  /**
   * Adota a plaquinha para esta unidade.
   *
   * `confirmarPelaUnidade` só é necessário depois de um 409
   * `CORE_UNIT_EQUIPMENT_IDENTITY_MISMATCH`: a unidade manda, e o operador
   * confirma que o número certo é o dela antes de corrigir a plaquinha.
   */
  linkUnitEquipment: (unitId: string, equipmentId: string, confirmarPelaUnidade = false) =>
    apiRequest<{ plaquinha: PlaquinhaDaUnidade }>(`/core/units/${unitId}/equipment`, {
      method: 'POST',
      body: { equipmentId, confirmarPelaUnidade },
    }).then(envelope('plaquinha')),

  /** Desfaz o vínculo — só enquanto a unidade está em estoque. */
  unlinkUnitEquipment: (unitId: string) =>
    apiRequest<void>(`/core/units/${unitId}/equipment`, { method: 'DELETE' }),

  // --------------------------------------------------- locais de estoque
  //
  // O saldo por local é DERIVADO do razão, e não um segundo cache — por isso
  // vem de uma rota própria por produto, e não junto da posição geral.

  listStockLocations: (incluirInativos = false) =>
    apiRequest<{ locations: StockLocation[] }>(
      `/core/stock/locations${incluirInativos ? '?incluirInativos=true' : ''}`,
    ).then(envelope('locations')),

  createStockLocation: (input: { code: string; name: string; note?: string | null }) =>
    apiRequest<{ location: StockLocation }>('/core/stock/locations', {
      method: 'POST',
      body: input,
    }).then(envelope('location')),

  updateStockLocation: (
    id: string,
    input: { name?: string; note?: string | null; active?: boolean },
  ) =>
    apiRequest<{ location: StockLocation }>(`/core/stock/locations/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('location')),

  stockBalanceByLocation: (productId: string) =>
    apiRequest<{ balances: LocationBalance[] }>(
      `/core/stock/locations/balance/${productId}`,
    ).then(envelope('balances')),

  transferStock: (input: {
    productId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: number;
    note?: string | null;
  }) =>
    apiRequest<{ reference: string }>('/core/stock/transfers', {
      method: 'POST',
      body: input,
    }),

  // ----------------------------------------------------- lotes e validade
  //
  // GAP-V35. Nenhuma destas funções calcula nada: faixa, saldo, valor e o
  // próprio "hoje" vêm do servidor. A tela que refizesse a conta divergiria da
  // régua do FEFO no primeiro produto de quantidade fracionada — e as duas
  // estariam "certas".

  listBatches: (
    options: {
      productId?: string;
      faixa?: FaixaDeValidade;
      search?: string;
      incluirZerados?: boolean;
      naoConferidos?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.productId) params.set('productId', options.productId);
    if (options.faixa) params.set('faixa', options.faixa);
    if (options.search) params.set('search', options.search);
    if (options.incluirZerados) params.set('incluirZerados', 'true');
    if (options.naoConferidos) params.set('naoConferidos', 'true');
    const qs = params.toString();
    return apiRequest<{ items: ProductBatch[] }>(
      `/core/stock/batches${qs ? `?${qs}` : ''}`,
    ).then(envelope('items'));
  },

  /** Faixas, pendências e o "hoje" da loja — tudo numa chamada só. */
  batchAlerts: () => apiRequest<BatchAlerts>('/core/stock/batches/alertas'),

  batchBalances: (productId: string) =>
    apiRequest<{ balances: BatchBalance[] }>(
      `/core/stock/batches/saldos/${productId}`,
    ).then(envelope('balances')),

  createBatch: (input: {
    productId: string;
    code: string;
    manufacturedOn?: string | null;
    expiresOn?: string | null;
    locationId?: string | null;
    note?: string | null;
  }) =>
    apiRequest<{ batch: ProductBatch }>('/core/stock/batches', {
      method: 'POST',
      body: input,
    }).then(envelope('batch')),

  updateBatch: (
    id: string,
    input: {
      manufacturedOn?: string | null;
      expiresOn?: string | null;
      locationId?: string | null;
      note?: string | null;
    },
  ) =>
    apiRequest<{ batch: ProductBatch }>(`/core/stock/batches/${id}`, {
      method: 'PATCH',
      body: input,
    }).then(envelope('batch')),

  /** A conferência da doca. Idempotente: o segundo clique responde 200. */
  conferirBatch: (id: string) =>
    apiRequest<{ batch: ProductBatch; duplicated: boolean }>(
      `/core/stock/batches/${id}/conferir`,
      { method: 'POST', body: {} },
    ),

  /** O saldo sem lote declarado passa a ter lote — um par de movimentos. */
  alocarEmBatch: (id: string, input: { productId: string; quantity: number; note?: string }) =>
    apiRequest<{ reference: string; quantity: number }>(`/core/stock/batches/${id}/alocar`, {
      method: 'POST',
      body: input,
    }),

  /**
   * Liga ou desliga o controle de lote de um produto.
   *
   * Rota PRÓPRIA, e não um campo do `PUT /products/:id`: o módulo do lote é
   * dono do próprio interruptor e das próprias recusas (serializado, serviço
   * sem estoque, modelo de grade). É o mesmo desenho da grade e do kit.
   */
  setBatchControl: (productId: string, tracksBatches: boolean) =>
    apiRequest<{ productId: string; tracksBatches: boolean }>(
      `/core/stock/batch-control/${productId}`,
      { method: 'PATCH', body: { tracksBatches } },
    ),

  // ------------------------------------------------ certificado digital

  getCertificate: () => apiRequest<CertificateView>('/core/fiscal/certificate'),

  /**
   * Os A1 das operações em que esta pessoa tem VÍNCULO (GAP-V41).
   *
   * Não é "as seis": é o que houver em `core_user_companies`. Quem só tem uma
   * loja vê uma — o certificado e o CNPJ das outras não são dele.
   */
  listGroupCertificates: () =>
    apiRequest<{ items: GroupCertificateItem[] }>('/core/fiscal/certificates/group').then(
      envelope('items'),
    ),

  /**
   * O ato administrativo que libera a produção (GAP-V42).
   *
   * Só passa com autorização REAL na homologação. Liberar NÃO liga produção:
   * o ambiente da operação continua onde está, e a resposta traz os passos
   * que ainda faltam.
   */
  unlockFiscalProduction: () =>
    apiRequest<ProductionUnlock>('/core/fiscal/production-unlock', { method: 'POST', body: {} }),

  /**
   * Pergunta à SEFAZ do estado se o serviço está no ar — a única conversa com
   * o fisco que não cria documento (rodada 58).
   *
   * A senha vai no corpo e não fica em lugar nenhum: nem no navegador, nem no
   * cofre. É pedida a cada teste, de propósito.
   */
  testSefazStatus: (certificatePassword: string) =>
    apiRequest<SefazStatusView>('/core/fiscal/sefaz/status', {
      method: 'POST',
      body: { certificatePassword },
    }),

  /** O .pfx vai em base64 por HTTPS; quem cifra e guarda é o cofre do backend. */
  uploadCertificate: (input: {
    pfxBase64: string;
    certificatePassword: string;
    expectedCnpj?: string;
  }) => apiRequest<CertificateView>('/core/fiscal/certificate', { method: 'POST', body: input }),

  revokeCertificate: (reason: string) =>
    apiRequest<CertificateView>('/core/fiscal/certificate/revoke', {
      method: 'POST',
      body: { reason },
    }),

  // ---------------------------------------------------- maquininha no PDV

  /** A maquininha DESTE caixa (GAP-PRD-014): sem caixa, a da operação. */
  terminalStatus: (terminalId?: string | null) =>
    apiRequest<{
      configured: boolean;
      provider: string | null;
      readiness: 'READY_FOR_HARDWARE' | 'CONFIGURED';
      message: string;
      /** Maquininha de TESTE: cobrança simulada, sem dinheiro (GAP-PRD-001). */
      simulated?: boolean;
      /** Por onde a cobrança chega ao aparelho (GAP-PRD-014). */
      channel?: 'mock' | 'local_agent' | 'cloud' | null;
      /** O caminho está de pé agora? `false` com `configured` = o cartão exige o aparelho e ele não responde. */
      channelReady?: boolean;
      /** Só maquininhas presas a caixas, e este computador não escolheu o dele. */
      requiresTerminal?: boolean;
    }>(
      terminalId
        ? `/core/pdv/terminal/status?terminalId=${encodeURIComponent(terminalId)}`
        : '/core/pdv/terminal/status',
    ),

  /**
   * Dispara a cobrança na maquininha.
   *
   * A chave de idempotência é obrigatória: sem ela, um reenvio por queda de
   * rede cobraria o cliente duas vezes. O caixa diz QUAL maquininha cobra
   * (GAP-PRD-014).
   */
  chargeOnTerminal: (
    input: {
      method: string;
      amountInCents: number;
      installments?: number;
      scenario?: string;
      terminalId?: string | null;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<TerminalPayment>('/core/pdv/terminal/charge', {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  listUncertainTerminalPayments: () =>
    apiRequest<{ items: TerminalPayment[] }>('/core/pdv/terminal/uncertain').then(envelope('items')),

  getTerminalPayment: (id: string) => apiRequest<TerminalPayment>(`/core/pdv/terminal/${id}`),

  /**
   * Confirma um PIX no provedor de TESTE (GAP-V49).
   *
   * Existe para que o fluxo assíncrono seja percorrível sem aparelho físico. O
   * servidor RECUSA fora do provedor mock — com adquirente real quem confirma
   * é ela, e esta porta não abre. A tela só oferece o botão quando a resposta
   * vem marcada como `simulated`.
   */
  confirmarPixDeTeste: (id: string) =>
    apiRequest<TerminalPayment>(`/core/pdv/terminal/${id}/confirmar-teste`, { method: 'POST' }),

  reconcileTerminalPayment: (id: string, outcome: 'aprovado' | 'recusado', reason: string) =>
    apiRequest<TerminalPayment>(`/core/pdv/terminal/${id}/reconcile`, {
      method: 'POST',
      body: { outcome, reason },
    }),

  // ------------------------------------------------ orçamento e pré-venda

  listQuotes: (params: { kind?: string; status?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set('kind', params.kind);
    if (params.status) qs.set('status', params.status);
    const query = qs.toString();
    return apiRequest<{ items: Quote[] }>(`/core/quotes${query ? `?${query}` : ''}`).then(envelope('items'));
  },

  getQuote: (id: string) => apiRequest<QuoteDetail>(`/core/quotes/${id}`),

  createQuote: (input: {
    kind: 'orcamento' | 'pre_venda';
    items: { productId: string; quantity: number; unitPriceCents?: number }[];
    customerId?: string | null;
    /**
     * QUEM VENDEU — e a ausência disto aqui movia dinheiro de bolso (GAP-V67).
     *
     * A coluna existe, a rota sempre aceitou, `convertQuote` propaga
     * `quote.seller_id` e `createSale` faz `sellerId ?? userId`. O elo que
     * faltava era este tipo e o campo na tela: sem eles o documento nascia com
     * vendedor NULO, a conversão propagava nulo, e o `??` caía em quem estava
     * no CAIXA na hora de faturar. Em loja com comissionamento ativo, a
     * comissão da vendedora do salão nascia para o operador do caixa — sem
     * erro em lugar nenhum, e sem ninguém notar.
     */
    sellerId?: string | null;
    discountCents?: number;
    validUntil?: string | null;
    note?: string | null;
    /** A liberação do gestor, quando a concessão passa da alçada. */
    authorizationId?: string | null;
  }) => apiRequest<Quote>('/core/quotes', { method: 'POST', body: input }),

  /**
   * EDITA O DOCUMENTO ABERTO, sem perder o número (GAP-V66).
   *
   * `customerId` e `sellerId` ausentes significam "não mexa"; `null` significa
   * "consumidor final" / "sem vendedor". São coisas diferentes, e o servidor as
   * separa — confundi-las rebaixaria o documento do revendedor para o preço de
   * balcão em toda edição que não citasse o cliente.
   */
  updateQuote: (
    id: string,
    input: {
      items: { productId: string; quantity: number; unitPriceCents?: number }[];
      customerId?: string | null;
      sellerId?: string | null;
      discountCents?: number;
      note?: string | null;
      authorizationId?: string | null;
    },
  ) => apiRequest<Quote>(`/core/quotes/${id}`, { method: 'PATCH', body: input }),

  /**
   * RENOVA A VALIDADE — o beco que três mensagens anunciavam (GAP-V66).
   *
   * O servidor recusava converter e aprovar com "renove a validade antes", e a
   * tela repetia a frase; não havia rota nenhuma para renovar. Só a validade
   * muda: preço, itens e reserva ficam onde estão.
   *
   * `validUntil` vai como DATA pura — quem a fecha no último instante do dia da
   * LOJA é o servidor, que é também quem expira o documento depois. Ausente,
   * vale a validade da política da operação, contada de hoje.
   */
  renewQuote: (id: string, validUntil?: string | null, reason?: string) =>
    apiRequest<Quote>(`/core/quotes/${id}/renew`, {
      method: 'POST',
      body: { validUntil: validUntil ?? null, reason },
    }),

  /**
   * Orçamento aprovado vira pré-venda e passa a segurar o estoque.
   *
   * `authorizationId` cobre UM caso, e ele é frequente: o orçamento anterior à
   * rodada da trava nasceu sem `concession_cents` — quer dizer, ninguém nunca
   * conferiu aquele preço —, e aprovar é a primeira vez que alguém olha para
   * ele. Nesse caminho o servidor cobra alçada e devolve
   * `CORE_DISCOUNT_NEEDS_AUTHORIZATION`; a tela pede a liberação e reenvia por
   * aqui. Documento criado desta rodada em diante passa direto, e o parâmetro
   * fica ausente como sempre esteve.
   */
  promoteQuote: (id: string, validUntil?: string | null, authorizationId?: string) =>
    apiRequest<Quote>(`/core/quotes/${id}/promote`, {
      method: 'POST',
      body: { validUntil: validUntil ?? null, authorizationId },
    }),

  convertQuote: (
    id: string,
    input: {
      payments: SalePaymentInput[];
      cashSessionId?: string | null;
      /**
       * O VALE DO CLIENTE ABATENDO A CONVERSÃO (GAP-V10/V47).
       *
       * A venda direta sempre aceitou o campo; a conversão não — e não recusava:
       * o número era descartado no servidor e a venda fechava pelo total cheio,
       * com o saldo do cliente intacto. O PDV chegou a preferir recusar na tela
       * ("Pré-venda ainda não aceita crédito de loja"), porque descartar em
       * silêncio era pior. Agora a rota recebe e gasta pelo MESMO caminho da
       * venda direta.
       *
       * Só o VALOR viaja: de quem é o saldo já está dito pelo DOCUMENTO, e a
       * tela não tem voto nisso. Quem confere saldo, dono e teto é o servidor,
       * na mesma transação da conversão.
       */
      customerCreditCents?: number;
      /**
       * QUAL MOTO SAI (GAP-PRD-025): o chassi que o balcão conferiu, por
       * produto. Ausente, o servidor leva a que o documento segura ou a mais
       * antiga livre do pátio.
       */
      unidades?: { productId: string; unitIds: string[] }[];
      /**
       * A liberação do gestor para o PISO de preço (A-produto-17#orcamento): o
       * servidor recusa com 403 CORE_DISCOUNT_NEEDS_AUTHORIZATION a conversão de
       * documento com linha abaixo do piso do produto, quando quem converte não
       * tem alçada e o documento não foi liberado ao ser escrito.
       */
      authorizationId?: string | null;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<{ saleId: string; number: number }>(`/core/quotes/${id}/convert`, {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  cancelQuote: (id: string, reason?: string) =>
    apiRequest<Quote>(`/core/quotes/${id}/cancel`, { method: 'POST', body: { reason } }),

  expireOverdueQuotes: () =>
    apiRequest<{ expired: number }>('/core/quotes/expire-overdue', { method: 'POST' }),

  // ------------------------------------------- consignação / condicional

  listConsignments: (params: { status?: 'aberta' | 'fechada'; customerId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.customerId) qs.set('customerId', params.customerId);
    const query = qs.toString();
    return apiRequest<{ items: Consignment[] }>(
      `/core/consignments${query ? `?${query}` : ''}`,
    ).then(envelope('items'));
  },

  getConsignment: (id: string) => apiRequest<ConsignmentDetail>(`/core/consignments/${id}`),

  /**
   * A remessa: a mercadoria SAI do estoque agora, e não vira receita.
   *
   * A chave é obrigatória, como no retorno e no faturamento — e pelo mesmo
   * motivo, que aqui é ainda mais forte: um reenvio de rede criaria DUAS
   * consignações sob dois números e tiraria a mesma mercadoria do saldo duas
   * vezes, sem nenhum CHECK do banco para reagir.
   */
  createConsignment: (
    input: {
      customerId: string;
      sellerId?: string | null;
      items: { productId: string; quantity: number }[];
      validUntil?: string | null;
      note?: string | null;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<Consignment>('/core/consignments', {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  /**
   * O que voltou volta ao disponível. Parcial é o caso NORMAL.
   *
   * A chave é obrigatória e não é decoração: o clique duplo devolveria ao saldo
   * mercadoria que continua na casa da cliente.
   */
  returnConsignment: (
    id: string,
    input: { items: { productId: string; quantity: number }[]; note?: string | null },
    idempotencyKey: string,
  ) =>
    apiRequest<{ eventId: string; duplicated: boolean }>(`/core/consignments/${id}/retorno`, {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  /** O que ficou vira venda de verdade — e a receita nasce aqui, não antes. */
  invoiceConsignment: (
    id: string,
    input: {
      items: { productId: string; quantity: number }[];
      payments: SalePaymentInput[];
      cashSessionId?: string | null;
      note?: string | null;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<{ saleId: string; number: number; totalCents: number; duplicated: boolean }>(
      `/core/consignments/${id}/faturar`,
      { method: 'POST', body: input, idempotencyKey },
    ),

  /** Só fecha quando não sobrou nada com o cliente — o servidor confere. */
  closeConsignment: (id: string) =>
    apiRequest<Consignment>(`/core/consignments/${id}/fechar`, { method: 'POST', body: {} }),

  /**
   * O limite de desconto que vale para quem está no balcão AGORA.
   *
   * Os nomes dos dois campos estavam ERRADOS aqui: a assinatura prometia
   * `limitPercent` e `needsAuthorization`, e o servidor sempre respondeu
   * `operatorLimitPercent` e `canAuthorizeSelf`. Nenhuma tela chamava, então o
   * erro dormia; a primeira que chamasse leria `undefined` e mostraria "NaN%"
   * de limite — ou pior, compararia contra `undefined` e concluiria que nada
   * precisa de gestor. Corrigido antes de o PDV passar a ser o primeiro leitor.
   *
   * Esta é a rota que o CAIXA alcança. `/core/sale-policies` exige perfil de
   * gerente (é lá que se EDITA a política), e por isso não serve ao PDV.
   */
  discountPolicy: () =>
    apiRequest<{
      operatorLimitPercent: number;
      canAuthorizeSelf: boolean;
      /** Os tetos DESTA pessoa (P0). Opcional: servidor antigo não manda. */
      limiteDoPerfil?: LimiteEfetivoDeDesconto;
      /** A liberação de desconto exige motivo nesta operação (P0). */
      motivoObrigatorio?: boolean;
    }>('/core/sales/discount-policy'),

  // ------------------------------------------- política comercial do balcão

  /**
   * Só gerente_loja/gerente_oficina (e admin_geral/gestor por cima) leem.
   *
   * A rota do roteador é ROTA_GESTAO, que também abre para estoquista e
   * atendente — a casca é mais larga que o servidor de propósito, e quem
   * chama tem de tratar o 403 dizendo o que houve, e não como falha de rede.
   */
  getSalePolicy: () => apiRequest<PoliticaDeVenda>('/core/sale-policies').then((r) => exigirCampos(r, 'discountLimitPercent', 'creditSaleDueDays', 'reservationValidDays', 'definidos')),

  /**
   * VAI O TEXTO CRU DO CAMPO, e é o formato do fio que decide isto.
   *
   * A tela tinha a intenção certa e o número errado: ela mandava `Number.NaN`
   * para o que não era número, contando que o servidor recusasse. Só que
   * `JSON.stringify({ a: NaN })` produz `{"a":null}` — NaN não existe em JSON.
   * E `null`, do outro lado, significa a coisa OPOSTA de recusa: significa
   * "volta ao padrão do sistema". O dono digitava "dez" no lugar de 10 e o
   * limite de desconto VOLTAVA para 10%, em silêncio, em vez de a gravação ser
   * recusada. A trava falhava ABERTA — o modo de falha que esta rodada inteira
   * existe para evitar.
   *
   * Com texto cru, os três estados chegam DISTINGUÍVEIS ao servidor, que é
   * quem tem a régua: `''` é campo apagado (volta ao padrão), `'0'` é a decisão
   * legítima e oposta (nenhuma concessão sem gestor), e `'dez'` é erro de
   * digitação — recusado com a mensagem dele, em `numeroOuPadrao`. Nenhum
   * deles colapsa no outro no meio do caminho.
   *
   * Nada de número aqui, nem "por conveniência": um `number | string` na
   * assinatura reabriria a porta no dia em que alguém voltasse a converter na
   * tela.
   */
  saveSalePolicy: (input: {
    discountLimitPercent: string;
    creditSaleDueDays: string;
    reservationValidDays: string;
    /**
     * O teto da sangria em REAIS — a unidade está no nome de propósito, e é a
     * mesma decisão que o servidor tomou na assinatura de `salvarPolitica`.
     *
     * A coluna guarda CENTAVOS e o dono digita REAIS. Um campo chamado
     * `cashWithdrawalLimit` sem unidade convida ao erro de cem vezes: quem
     * manda 500 pensando em reais grava R$ 5,00 e passa a ser chamado para
     * toda sangria sem entender por quê. Texto pelo mesmo motivo dos outros
     * três (ver acima), e aqui a distinção pesa ainda mais: `''` é "sem teto"
     * e `'0'` é "toda sangria chama o gestor" — as duas pontas opostas da
     * mesma régua, separadas por um caractere.
     */
    cashWithdrawalLimitReais: string;
    /**
     * Faturar a OS a prazo (GAP-PRD-104). Booleano de verdade — o servidor
     * recusa texto, e ausente volta ao padrão, que é desligado.
     */
    workshopCreditEnabled?: boolean;
    /**
     * Exigir motivo na liberação de desconto (P0). Ausente MANTÉM o gravado —
     * é trava de segurança, e o servidor não a desliga por omissão.
     */
    discountReasonRequired?: boolean;
    /**
     * A lista INTEIRA de limites por perfil (P0), em TEXTO como os campos de
     * cima e com a mesma razão: `''` é "sem este teto", e o erro de digitação
     * é recusado pelo servidor com o nome do campo. Valores em REAIS.
     * Ausente = a lista gravada fica como está.
     */
    limitesPorPerfil?: {
      profileCode: string;
      maxPercent: string;
      maxReais: string;
      itemMaxPercent: string;
      itemMaxReais: string;
    }[];
  }) => apiRequest<PoliticaDeVenda>('/core/sale-policies', { method: 'PUT', body: input }),

  /**
   * Pede a liberação de um gestor para uma ação restrita.
   *
   * A credencial vai só nesta chamada: não cria sessão, não devolve token e
   * nunca é guardada no navegador.
   *
   * ## O QUE ESTÁ SENDO LIBERADO VAI EM NÚMERO, e não só na frase
   *
   * `reason` continua — é o que a pessoa lê na tela de autorizações, e nenhum
   * par de inteiros substitui "Concessão de R$ 3.400,00 (28%) sobre R$ 12.000,00
   * na venda X". O que ele não faz é COMPARAR: texto não se mede contra o
   * carrinho na hora de gastar a liberação. Enquanto os números viviam só na
   * frase, a liberação nascia sem teto e valia UMA vez para QUALQUER valor — o
   * gestor autorizava 28% e o operador fechava com 60% usando o mesmo "sim".
   *
   * Com os dois campos, `consumirLiberacaoDeConcessao` recalcula o percentual
   * liberado e recusa o documento que concede mais, com os dois números na
   * mensagem.
   *
   * ## O nome do campo é `concedidoCents`, e ele importa
   *
   * É assim que `POST /core/authorizations` o lê (`req.body?.concedidoCents`,
   * repassado a `AuthorizationService` como `concessao.concedidoCents`).
   * Qualquer outro nome atravessa o fio, é ignorado do outro lado, e a
   * liberação volta a nascer sem teto — em silêncio, que é o pior desfecho
   * possível para uma trava. Ambos são opcionais porque quem pede uma
   * liberação que não é sobre dinheiro não tem número para declarar.
   */
  authorize: (input: {
    action: string;
    login: string;
    password: string;
    reason?: string;
    referenceId?: string;
    /** Quanto a loja deixa de cobrar, em centavos. O teto da liberação. */
    concedidoCents?: number;
    /** O denominador: sem ele o teto não vira percentual e não compara. */
    brutoCents?: number;
    /**
     * O MOTIVO digitado por gente (P0 da Preço Justo) — obrigatório na
     * liberação de desconto onde a operação exige. `reason` continua sendo a
     * frase com os números, montada pela tela.
     */
    justificativa?: string;
  }) => apiRequest<Authorization>('/core/authorizations', { method: 'POST', body: input }),

  /**
   * AS LIBERAÇÕES DE GESTOR DA OPERAÇÃO — a rota que era órfã.
   *
   * `GET /core/authorizations` existia desde a primeira rodada da alçada e
   * nenhuma tela a chamava: cada senha de gerente digitada no balcão virava
   * linha no banco e o dono só a alcançava abrindo o SQLite. Quem a consome é a
   * seção "Liberações de gestor" da Auditoria, e o guarda dela é o mesmo da
   * tela — `admin_geral` e `gestor`, porque esta lista nomeia o gerente que
   * ASSINOU e ninguém deve ler a própria vigilância.
   */
  listAuthorizations: (limit?: number) =>
    apiRequest<{ items: LiberacaoDeGestor[] }>(
      `/core/authorizations${limit ? `?limit=${limit}` : ''}`,
    ).then(envelope('items')),

  listSales: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return apiRequest<{ items: Sale[] }>(`/core/sales${qs ? `?${qs}` : ''}`).then(envelope('items'));
  },

  /**
   * A FICHA DA VENDA — a rota que existia sem nenhum leitor no frontend.
   *
   * `GET /core/sales/:id` devolve itens, pagamentos, os títulos que a venda
   * gerou, quanto do vale a cobriu e o RASTRO DOS ITENS CANCELADOS no carrinho.
   * O último é o que mais custava a ausência: ele existe para prevenção de
   * perda — "fechou por menos do que mostrou ao cliente" — e nenhuma tela de
   * gestão o exibia. Só a lista era chamada, e a lista não traz nada disso.
   *
   * Mesmo alcance da lista (balcão e escritório): ler o que se vendeu não é
   * desfazer, e o cancelamento ao lado continua exigindo gerente.
   */
  getSale: (id: string) => apiRequest<SaleDetail>(`/core/sales/${id}`),

  /**
   * O RASTRO DO CARRINHO QUE O F6 APAGOU (D-pdv-teclado-12).
   *
   * O carrinho é local: cancelado, sumia sem registro. Isto conta ao servidor o
   * que saiu da tela, e ele carimba quem e quando na trilha de auditoria. Não é
   * venda — não mexe em estoque nem em caixa. Não entra na fila offline: sem
   * servidor, o PDV avisa que o registro não subiu.
   */
  recordAbandonedCart: (input: {
    saleKey: string;
    terminalId?: string | null;
    customerId?: string | null;
    items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
  }) =>
    apiRequest<{ ok: true; totalCents: number }>('/core/sales/abandoned', {
      method: 'POST',
      body: input,
    }),

  /**
   * Cancela a venda — direto, ou com o bilhete do gestor.
   *
   * `authorizationId` só viaja quando quem clica NÃO tem alçada: a rota recusa
   * com `CORE_CANCEL_NEEDS_AUTHORIZATION`, a tela pede a credencial do gestor
   * no diálogo e repete a chamada com o id. Quem tem alçada continua cancelando
   * sem pedir nada a ninguém — mandar um bilhete aqui seria pedir liberação
   * para si mesmo, e o servidor recusa isso com `CORE_SELF_AUTHORIZATION`.
   */
  cancelSale: (
    id: string,
    reason?: string,
    authorizationId?: string,
    /** O caixa deste computador: de qual gaveta sai o dinheiro de turno já fechado (GAP-PRD-161). */
    terminalId?: string | null,
  ) =>
    // A resposta diz o que aconteceu com o estorno na maquininha (GAP-PRD-080)
    // e, meio a meio, o que o cancelamento devolveu e o que ainda precisa de
    // uma mão (E-venda-servidor-06) — ver `ReembolsoDoCancelamento` no
    // `SalesService`. Opcional: servidor antigo não manda.
    apiRequest<Sale & {
      estornosNaMaquininha?: EstornoNaMaquininha[];
      reembolso?: {
        gavetaCents: number;
        aDevolverAMao: { dinheiro: number; credito: number; debito: number; pix: number };
        maquininhaCents: number;
        valeDevolvidoCents: number;
        valeRevogadoCents: number;
        jaDevolvidoCents: number;
        /**
         * O que entrou DEPOIS, em Contas a receber, e ainda volta ao cliente
         * pela mão de alguém (E-venda-servidor-R01). Opcional: servidor antigo
         * não manda.
         */
        recebidoDepois?: { cents: number; meios: string[] };
      };
    }>(`/core/sales/${id}/cancel`, {
      method: 'POST',
      body: { reason, authorizationId, terminalId: terminalId ?? undefined },
    }),

  // ------------------------------------------------------- integrações
  //
  // A API key NUNCA volta destas rotas. O que volta é dica mascarada, origem
  // e estado — o suficiente para a tela dizer "está configurada" sem que a
  // credencial passe pelo navegador.

  getAsaasIntegration: () => apiRequest<AsaasIntegration>('/core/integrations/asaas').then((r) => exigirCampos(r, 'status', 'credentials', 'state', 'envFallbackAllowed')),

  saveAsaasApiKey: (environment: 'sandbox' | 'production', apiKey: string) =>
    apiRequest<{ credentials: AsaasCredentialStatus }>('/core/integrations/asaas/credentials', {
      method: 'PUT',
      body: { environment, apiKey },
    }).then((r) => exigirCampos(r, 'credentials')),

  saveAsaasWebhookToken: (webhookToken: string) =>
    apiRequest<{ credentials: AsaasCredentialStatus }>('/core/integrations/asaas/webhook-token', {
      method: 'PUT',
      body: { webhookToken },
    }),

  removeAsaasApiKey: (environment: 'sandbox' | 'production') =>
    apiRequest<{ credentials: AsaasCredentialStatus }>(
      `/core/integrations/asaas/credentials/${environment}`,
      { method: 'DELETE' },
    ),

  requestAsaasEnvironment: (environment: 'sandbox' | 'production') =>
    apiRequest<{ status: AsaasStatus; state: AsaasState }>('/core/integrations/asaas', {
      method: 'PATCH',
      body: { environment },
    }),

  /**
   * Testa as chaves configuradas, cada uma no próprio ambiente (GAP-PRD-170).
   * Sem `environment`, as duas; `results` diz o que cada uma respondeu.
   */
  testAsaasConnection: (environment?: 'sandbox' | 'production') =>
    apiRequest<{ ok: boolean; detail: string; results?: TesteDaChaveAsaas[]; status: AsaasStatus }>(
      '/core/integrations/asaas/test',
      { method: 'POST', body: environment ? { environment } : {} },
    ),

  /**
   * Roda a homologação do sandbox — os dezesseis passos que exercitam a
   * integração ponta a ponta (rodada 62).
   *
   * É a trava que o dono não tinha como abrir: o motor existia, a rota antiga
   * exigia uma permissão que nenhum perfil tem, e nenhuma tela chamava
   * qualquer uma das duas.
   */
  homologarAsaas: () =>
    apiRequest<HomologacaoAsaas>('/core/integrations/asaas/homologar', { method: 'POST' }),

  /**
   * "O aviso do Asaas chegou?" (GAP-PRD-169). O passo final da homologação só
   * fica verde quando um aviso do próprio Asaas sobre as cobranças de teste
   * chega por fora; isto confere de novo sem rodar tudo.
   */
  conferirAvisoDaHomologacaoAsaas: () =>
    apiRequest<{ step: HomologacaoAsaas['steps'][number] | null; steps: HomologacaoAsaas['steps'] }>(
      '/core/integrations/asaas/homologar/conferir-aviso',
      { method: 'POST' },
    ),

  // ------------------------------------------------------ transportadoras
  //
  // Quem trouxe a mercadoria até a porta. Nasce sozinha na importação do XML,
  // e a tela existe para completar o que o arquivo não traz: telefone, contato
  // e inscrição estadual.

  listCarriers: (params: { search?: string; includeInactive?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.includeInactive) qs.set('includeInactive', '1');
    const q = qs.toString();
    return apiRequest<{ items: Carrier[] }>(`/core/carriers${q ? `?${q}` : ''}`).then(envelope('items'));
  },

  getCarrier: (id: string) =>
    apiRequest<{ carrier: Carrier; history: CarrierHistory }>(`/core/carriers/${id}`),

  createCarrier: (input: CarrierInput) =>
    apiRequest<{ carrier: Carrier }>('/core/carriers', { method: 'POST', body: input }),

  updateCarrier: (id: string, input: Partial<CarrierInput>) =>
    apiRequest<{ carrier: Carrier }>(`/core/carriers/${id}`, { method: 'PATCH', body: input }),

  setCarrierActive: (id: string, active: boolean) =>
    apiRequest<{ carrier: Carrier }>(`/core/carriers/${id}/active`, {
      method: 'POST',
      body: { active },
    }),

  // ------------------------------------------------ configuração da entrada

  getInboundConfig: () => apiRequest<InboundConfig>('/core/inbound/config'),

  setInboundConfig: (input: { defaultSaleCfop: string | null }) =>
    apiRequest<InboundConfig>('/core/inbound/config', { method: 'PUT', body: input }),

  // ------------------------------------------------------------- compras
  //
  // O fornecedor nascia como efeito da importação de XML. Comprar exige prazo
  // de entrega e de pagamento — e o pedido NÃO movimenta estoque: quem dá
  // entrada é a conferência da nota.

  listSuppliers: (params: { search?: string; includeInactive?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.includeInactive) qs.set('includeInactive', 'true');
    const q = qs.toString();
    return apiRequest<{ items: Supplier[] }>(`/core/suppliers${q ? `?${q}` : ''}`).then(envelope('items'));
  },

  getSupplier: (id: string) =>
    apiRequest<Supplier & { history: SupplierHistory }>(`/core/suppliers/${id}`),

  createSupplier: (input: SupplierInput) =>
    apiRequest<Supplier>('/core/suppliers', { method: 'POST', body: input }),

  updateSupplier: (id: string, input: Partial<SupplierInput>) =>
    apiRequest<Supplier>(`/core/suppliers/${id}`, { method: 'PATCH', body: input }),

  setSupplierActive: (id: string, active: boolean) =>
    apiRequest<Supplier>(`/core/suppliers/${id}/active`, { method: 'POST', body: { active } }),

  listPurchaseOrders: (params: { status?: string; supplierId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.supplierId) qs.set('supplierId', params.supplierId);
    const q = qs.toString();
    return apiRequest<{ items: PurchaseOrder[] }>(
      `/core/purchase-orders${q ? `?${q}` : ''}`,
    ).then(envelope('items'));
  },

  getPurchaseOrder: (id: string) => apiRequest<PurchaseOrderDetail>(`/core/purchase-orders/${id}`),

  createPurchaseOrder: (input: {
    supplierId: string;
    items: PurchaseOrderItemInput[];
    expectedAt?: string | null;
    notes?: string | null;
  }) => apiRequest<PurchaseOrder>('/core/purchase-orders', { method: 'POST', body: input }),

  updatePurchaseOrderItems: (id: string, items: PurchaseOrderItemInput[]) =>
    apiRequest<PurchaseOrder>(`/core/purchase-orders/${id}/items`, {
      method: 'PUT',
      body: { items },
    }),

  sendPurchaseOrder: (id: string) =>
    apiRequest<PurchaseOrder>(`/core/purchase-orders/${id}/send`, { method: 'POST' }),

  cancelPurchaseOrder: (id: string, reason: string) =>
    apiRequest<PurchaseOrder>(`/core/purchase-orders/${id}/cancel`, {
      method: 'POST',
      body: { reason },
    }),

  linkNoteToPurchaseOrder: (orderId: string, noteId: string) =>
    apiRequest<PurchaseOrder>(`/core/purchase-orders/${orderId}/notes/${noteId}`, {
      method: 'POST',
    }),

  // ------------------------------------------- nota de entrada (conciliação)
  //
  // A Entrada de Notas chama estas rotas com `apiRequest` cru desde antes de
  // existirem aqui; as funções nasceram com a tela de conciliação, que precisa
  // das MESMAS portas — importar/preview/repricing continuam lá, porque só lá
  // alguém os usa.

  listInboundNotes: () =>
    apiRequest<{ items: InboundNoteSummary[] }>('/core/purchases/notes').then(envelope('items')),

  listInboundNoteItems: (noteId: string) =>
    apiRequest<{ items: InboundNoteItem[] }>(`/core/purchases/notes/${noteId}/items`).then(
      envelope('items'),
    ),

  /** Registra o que a doca CONTOU num item da nota — o índice é a posição no arquivo. */
  conferirInboundNoteItem: (
    noteId: string,
    input: {
      itemIndex: number;
      receivedQuantity: number;
      divergenceNote?: string;
      conversionFactor?: number | null;
    },
  ) =>
    apiRequest<{ items: InboundNoteItem[] }>(`/core/purchases/notes/${noteId}/conferir`, {
      method: 'POST',
      body: input,
    }).then(envelope('items')),

  /** Aplica a entrada: estoque e contas a pagar andam, e o pedido amarrado junto. */
  confirmInboundNote: (noteId: string, opts: { createMissing?: boolean } = {}) =>
    apiRequest<{ noteId: string; movedItems: number; createdProducts: number }>(
      `/core/purchases/notes/${noteId}/confirm`,
      { method: 'POST', body: opts },
    ),

  /**
   * Entrada manual — a compra SEM nota fiscal (GAP-V17).
   *
   * Cria o documento (doc_type 'manual', que nunca finge ser NF-e) já no
   * funil de conferência: a confirmação é a MESMA da NF-e. A
   * `idempotencyKey` é gerada quando o formulário abre — reenviar o mesmo
   * formulário devolve a MESMA nota, como reimportar o mesmo XML.
   */
  createManualInboundEntry: (input: {
    supplierId: string;
    documentNumber?: string | null;
    idempotencyKey?: string | null;
    items: { productId: string; quantity: number; unitCostCents: number }[];
  }) =>
    apiRequest<{
      noteId: string;
      duplicated: boolean;
      status: string;
      totalCents: number;
      items: InboundNoteItem[];
    }>('/core/purchases/manual', { method: 'POST', body: input }),

  /**
   * Estorno da entrada CONFIRMADA (GAP-V20): movimento contrário no razão,
   * dívida aberta cancelada, pedido amarrado reprojetado — o servidor recusa
   * (com a frase dele) dívida já baixada e mercadoria que já saiu.
   */
  estornarInboundNote: (noteId: string, reason: string) =>
    apiRequest<{
      noteId: string;
      status: string;
      reversedMovements: number;
      financeCancelled: boolean;
      alreadyReversed: boolean;
    }>(`/core/purchases/notes/${noteId}/estornar`, { method: 'POST', body: { reason } }),

  // ---------------------------------------------------------- devoluções
  //
  // Devolver não é cancelar: a venda aconteceu e continua tendo acontecido. A
  // devolução é registro novo apontando para ela.

  returnableItems: (saleId: string) =>
    apiRequest<{ items: ReturnableItem[] }>(`/core/sales/${saleId}/returnable`).then(envelope('items')),

  /**
   * A mesma leitura, inteira: os itens, COMO esta operação devolve o dinheiro
   * (a Preço Justo em duas etapas) e a venda — quem, quando, como pagou,
   * fiscal e o que já voltou. `fluxo` e `venda` ausentes = servidor de antes.
   */
  returnableSale: (saleId: string) =>
    apiRequest<{ items: ReturnableItem[]; fluxo?: FluxoDaDevolucao; venda?: VendaParaDevolucao }>(
      `/core/sales/${saleId}/returnable`,
    ).then((r) => ({ ...r, items: envelope('items')(r) })),

  listSaleReturns: (params: { saleId?: string } = {}) => {
    const qs = params.saleId ? `?saleId=${encodeURIComponent(params.saleId)}` : '';
    return apiRequest<{ items: SaleReturn[] }>(`/core/sale-returns${qs}`).then(envelope('items'));
  },

  getSaleReturn: (id: string) => apiRequest<SaleReturnDetail>(`/core/sale-returns/${id}`),

  createSaleReturn: (input: {
    saleId: string;
    reason: string;
    /** Duas etapas: o motivo em lista e a observação ("outro" exige). */
    reasonCode?: string;
    reasonNote?: string;
    refundMethod?: RefundMethod;
    items: {
      saleItemId: string;
      quantity: number;
      restock?: boolean;
      /** intacto | defeituoso | quebrado | avariado | improprio — só o intacto volta ao estoque. */
      condition?: string;
      /** QUAIS peças voltaram. Obrigatório em produto serializado. */
      unitIds?: string[];
    }[];
    cashSessionId?: string | null;
    /** O caixa deste computador: a gaveta da devolução em dinheiro é a dele (GAP-PRD-161). */
    terminalId?: string | null;
    /** O bilhete do gestor, quando quem registra não tem alçada. */
    authorizationId?: string;
  },
  /**
   * A chave desta TENTATIVA de devolução (E-venda-servidor-09): a mesma em todo
   * reenvio — o servidor devolve a devolução já gravada em vez de gravar outra.
   */
  idempotencyKey?: string,
  ) =>
    // Devolução no cartão: a resposta diz o que aconteceu com o estorno na maquininha (GAP-PRD-080).
    apiRequest<SaleReturnDetail & { estornosNaMaquininha?: EstornoNaMaquininha[] }>('/core/sale-returns', {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  /**
   * REGISTRAR DEVOLUÇÃO AO CLIENTE — um reembolso da devolução em duas etapas:
   * o dinheiro entregue da gaveta, o PIX feito pela conta, o estorno feito na
   * maquininha, o crédito de loja. A chave é a da TENTATIVA: o clique duplo e o
   * reenvio devolvem o mesmo registro.
   */
  registerReturnRefund: (
    returnId: string,
    input: {
      method: MeioDoReembolso;
      amountCents: number;
      reference?: string;
      note?: string;
      /** Obrigatória quando o meio não é o que a venda recebeu (só gestor). */
      justification?: string;
      cashSessionId?: string | null;
      terminalId?: string | null;
      authorizationId?: string;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<SaleReturnDetail & { refundId: string; estornosNaMaquininha?: EstornoNaMaquininha[] }>(
      `/core/sale-returns/${returnId}/refunds`,
      { method: 'POST', body: input, idempotencyKey },
    ),

  // ---------------------------------------------------------- auditoria

  /**
   * A trilha de auditoria, paginada e filtrada NO SERVIDOR.
   *
   * Os filtros viajam na consulta de propósito: filtrar no navegador só
   * filtraria a página carregada, e "quem cancelou essa venda em março?" mora
   * em páginas que a tela nunca puxou. O guarda da rota é `requireProfile`
   * sem nomes — só `admin_geral` e `gestor` —, o mesmo alcance declarado no
   * roteador e no menu (`DONOS_DO_GRUPO`).
   */
  listAudit: (opts: { limit?: number; offset?: number; action?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set('limit', String(opts.limit));
    if (opts.offset != null) qs.set('offset', String(opts.offset));
    if (opts.action) qs.set('action', opts.action);
    if (opts.q) qs.set('q', opts.q);
    const q = qs.toString();
    return apiRequest<PaginaDeAuditoria>(`/core/audit${q ? `?${q}` : ''}`).then((r) =>
      exigirCampos(r, 'items', 'total'),
    );
  },

  // ---------------------------------------------------------- inventário
  //
  // Contar não mexe em estoque; só o acerto mexe. E o acerto é a diferença
  // entre o contado e o esperado congelado, nunca o valor contado como saldo.

  listInventoryCounts: (params: { status?: string } = {}) => {
    const qs = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
    return apiRequest<{ items: InventoryCount[] }>(`/core/inventory-counts${qs}`).then(envelope('items'));
  },

  getInventoryCount: (id: string) =>
    apiRequest<InventoryCountDetail>(`/core/inventory-counts/${id}`),

  /**
   * Abre a contagem. Sem recorte, congela o catálogo ativo inteiro (inventário
   * geral); `category` e/ou `search` congelam SÓ o recorte — é a contagem
   * parcial do corredor, sem travar o resto da loja.
   */
  openInventoryCount: (input: {
    scopeNote?: string | null;
    productIds?: string[];
    category?: string | null;
    search?: string | null;
    /** Contar só este local (GAP-PRD-167): o esperado é o saldo dele. */
    locationId?: string | null;
  }) =>
    apiRequest<InventoryCountDetail>('/core/inventory-counts', { method: 'POST', body: input }),

  recordCount: (countId: string, productId: string, countedQuantity: number) =>
    apiRequest<InventoryCountDetail>(`/core/inventory-counts/${countId}/items`, {
      method: 'POST',
      body: { productId, countedQuantity },
    }),

  /**
   * O BIPE do leitor na contagem (B-estoque-entrada-16): o servidor acha o
   * produto pelo código lido e SOMA 1 ao que já foi contado.
   */
  recordCountBipe: (countId: string, barcode: string) =>
    apiRequest<InventoryCountDetail>(`/core/inventory-counts/${countId}/items`, {
      method: 'POST',
      body: { barcode, increment: 1 },
    }),

  applyInventoryCount: (countId: string, reason: string) =>
    apiRequest<InventoryCountDetail>(`/core/inventory-counts/${countId}/apply`, {
      method: 'POST',
      body: { reason },
    }),

  cancelInventoryCount: (countId: string, reason: string) =>
    apiRequest<InventoryCountDetail>(`/core/inventory-counts/${countId}/cancel`, {
      method: 'POST',
      body: { reason },
    }),

  // ----------------------------------------------------------------- CRM
  //
  // Lead não é cliente: só vira, e apontando para `core_customers`. O valor da
  // oportunidade é estimativa — não é receita.

  listLeads: (params: { status?: string; search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.search) qs.set('search', params.search);
    const q = qs.toString();
    return apiRequest<{ items: Lead[] }>(`/core/leads${q ? `?${q}` : ''}`).then(envelope('items'));
  },

  createLead: (input: {
    name: string;
    phone?: string | null;
    email?: string | null;
    document?: string | null;
    source?: string | null;
    notes?: string | null;
  }) => apiRequest<Lead>('/core/leads', { method: 'POST', body: input }),

  updateLeadStatus: (id: string, status: LeadStatus, lostReason?: string) =>
    apiRequest<Lead>(`/core/leads/${id}/status`, {
      method: 'PATCH',
      body: { status, lostReason },
    }),

  convertLead: (id: string) =>
    apiRequest<{ lead: Lead; customerId: string; reusedExisting: boolean }>(
      `/core/leads/${id}/convert`,
      { method: 'POST' },
    ),

  listOpportunities: (params: { status?: string } = {}) => {
    const qs = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
    return apiRequest<{ items: Opportunity[] }>(`/core/opportunities${qs}`).then(envelope('items'));
  },

  createOpportunity: (input: {
    title: string;
    amountCents: number;
    leadId?: string | null;
    customerId?: string | null;
    expectedCloseAt?: string | null;
  }) => apiRequest<Opportunity>('/core/opportunities', { method: 'POST', body: input }),

  closeOpportunity: (id: string, status: 'ganha' | 'perdida', extra: { lostReason?: string; saleId?: string } = {}) =>
    apiRequest<Opportunity>(`/core/opportunities/${id}/close`, {
      method: 'POST',
      body: { status, ...extra },
    }),

  crmSummary: () => apiRequest<CrmSummary>('/core/crm/summary'),

  // ---------------------------------------------------------- fidelidade
  //
  // Ponto acumulado é dívida da loja, não receita: tem razão própria e não
  // passa pelo financeiro.

  getLoyaltyProgram: () =>
    apiRequest<{ program: LoyaltyProgram; liability: LoyaltyLiability }>('/core/loyalty/program'),

  updateLoyaltyProgram: (input: {
    active?: boolean;
    centsPerPoint?: number;
    pointValueCents?: number;
    minPointsToRedeem?: number;
  }) => apiRequest<LoyaltyProgram>('/core/loyalty/program', { method: 'PUT', body: input }),

  loyaltyStatement: (customerId: string) =>
    apiRequest<{ balance: number; entries: LoyaltyEntry[] }>(
      `/core/loyalty/customers/${customerId}`,
    ),

  redeemPoints: (customerId: string, points: number, saleId?: string) =>
    apiRequest<{ points: number; discountCents: number; balanceAfter: number }>(
      '/core/loyalty/redeem',
      { method: 'POST', body: { customerId, points, saleId } },
    ),

  // ------------------------------------------------------------- locação
  //
  // Locar reserva em vez de dar baixa: o bem continua sendo da loja e volta.

  listRentals: (params: { status?: string } = {}) => {
    const qs = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
    return apiRequest<{ items: RentalContract[] }>(`/core/rentals${qs}`).then(envelope('items'));
  },

  getRental: (id: string) => apiRequest<RentalContractDetail>(`/core/rentals/${id}`),

  createRental: (input: {
    customerId: string;
    endsAt: string;
    startsAt?: string | null;
    depositCents?: number;
    notes?: string | null;
    items: { productId: string; quantity: number; unitCents?: number }[];
  }) => apiRequest<RentalContractDetail>('/core/rentals', { method: 'POST', body: input }),

  returnRental: (id: string, items: { productId: string; quantity: number }[]) =>
    apiRequest<RentalContractDetail>(`/core/rentals/${id}/return`, {
      method: 'POST',
      body: { items },
    }),

  cancelRental: (id: string, reason: string) =>
    apiRequest<RentalContractDetail>(`/core/rentals/${id}/cancel`, {
      method: 'POST',
      body: { reason },
    }),

  // --------------------------------------------------------------- peças
  //
  // O mecânico não vê custo: o campo é REMOVIDO da resposta pelo servidor, e
  // por isso `cost_cents` é opcional aqui.

  listParts: (params: { workshopId?: string; search?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.workshopId) qs.set('workshopId', params.workshopId);
    if (params.search) qs.set('search', params.search);
    const q = qs.toString();
    return apiRequest<{ items: WorkshopPart[] }>(`/core/workshop/parts${q ? `?${q}` : ''}`).then(envelope('items'));
  },

  /**
   * LANÇA a peça na OS e baixa do estoque na mesma transação.
   *
   * Era o elo que faltava: o servidor tinha a rota desde a rodada da OS, o
   * cliente tinha só a DEVOLUÇÃO logo abaixo, e nenhuma tela chamava. A OS
   * mostrava a tabela "Peças aplicadas" com o estado vazio e nenhum caminho de
   * encher — lia e nunca escrevia.
   *
   * `workshopId` NÃO vai no corpo de propósito: a rota resolve a oficina pela
   * sessão, e mandá-la daqui deixaria a tela decidir um escopo que é do
   * servidor.
   *
   * E o RETORNO NÃO É DECLARADO. O servidor devolve a ordem inteira, e havia
   * aqui uma `ServiceOrderResumo` com seis campos que nenhuma tela lia: a OS é
   * RELIDA depois do lançamento, porque a tela precisa junto das peças
   * aplicadas, dos comentários e da linha do tempo, que o retorno do
   * lançamento não traz. Declarar os seis campos de novo era escritor sem
   * leitor — o mesmo defeito que esta rodada conserta em outro lugar.
   */
  lancarPeca: (orderId: string, input: { productId: string; quantity: number }) =>
    apiRequest<void>(`/core/workshop/orders/${orderId}/parts`, {
      method: 'POST',
      body: input,
    }),

  returnPart: (orderId: string, partId: string, quantity: number, reason?: string) =>
    apiRequest<{ returned: number }>(
      `/core/workshop/orders/${orderId}/parts/${partId}/return`,
      { method: 'POST', body: { quantity, reason } },
    ),

  // ----------------------------------------- a gaveta da bancada (rodada 55)
  //
  // Bipar resolve: a peça existe e se repõe, ou não existe e se cadastra. O
  // documento de origem é obrigatório nas duas portas e vai para o razão.

  scanPeca: (codigo: string, workshopId?: string) => {
    const qs = new URLSearchParams({ codigo });
    if (workshopId) qs.set('workshopId', workshopId);
    return apiRequest<ResultadoDoScan>(`/core/workshop/parts/scan?${qs.toString()}`);
  },

  cadastrarPeca: (input: {
    workshopId: string;
    name: string;
    barcode?: string | null;
    internalCode?: string | null;
    unit?: string | null;
    costCents: number;
    markupPercent?: number | null;
    priceCents?: number | null;
    quantity: number;
    minStock?: number | null;
    storageLocation?: string | null;
    documento: DocumentoDeEntrada;
  },
  /*
    A CHAVE DO GESTO, não da chamada.

    Entrada de peça é escrita que soma saldo, e o servidor recusa sem ela.
    Quem a inventa é a TELA, no momento em que o formulário nasce — se
    fosse inventada aqui, cada clique traria uma chave nova e o clique
    repetido voltaria a entrar a carga duas vezes.
  */
  idempotencyKey: string,
) =>
    apiRequest<{
      productId: string;
      priceCents: number;
      quantity: number;
      duplicada: boolean;
    }>('/core/workshop/parts', { method: 'POST', body: input, idempotencyKey }),

  reporPeca: (
    productId: string,
    input: {
      quantity: number;
      costCents?: number | null;
      markupPercent?: number | null;
      documento: DocumentoDeEntrada;
    },
    /** Ver `cadastrarPeca`: a chave é do gesto, e nasce na tela. */
    idempotencyKey: string,
  ) =>
    apiRequest<{
      quantity: number;
      costCents: number;
      priceCents: number;
      reprecificada: boolean;
      duplicada: boolean;
    }>(`/core/workshop/parts/${productId}/reposicao`, {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  ajustarPeca: (
    productId: string,
    input: {
      minStock?: number | null;
      storageLocation?: string | null;
      costCents?: number | null;
      priceCents?: number | null;
      markupPercent?: number | null;
    },
  ) =>
    apiRequest<Record<string, unknown>>(`/core/workshop/parts/${productId}`, {
      method: 'PATCH',
      body: input,
    }),

  // ------------------------------------------- conciliação bancária
  //
  // Compara e RELATA. Não corrige, e não casa sozinha: o sistema sugere e
  // quem confere confirma.

  listBankStatements: () =>
    apiRequest<{ items: BankStatement[] }>('/core/bank/statements').then(envelope('items')),

  listBankLines: (params: { statementId?: string; onlyUnmatched?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.statementId) qs.set('statementId', params.statementId);
    if (params.onlyUnmatched) qs.set('onlyUnmatched', 'true');
    const q = qs.toString();
    return apiRequest<{ items: BankLine[] }>(`/core/bank/lines${q ? `?${q}` : ''}`).then(envelope('items'));
  },

  /**
   * A página de linhas do extrato COM o que ficou de fora (GAP-PRD-177).
   *
   * O servidor devolvia 500 linhas sem dizer que havia mais. Agora `total` e
   * `truncated` vêm junto, e `offset` pede a próxima página. Servidor antigo
   * (sem `total`) cai em "o que veio é tudo" — que era o que ele afirmava.
   */
  listBankLinesPage: async (
    params: {
      statementId?: string;
      onlyUnmatched?: boolean;
      onlyMatched?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginaDoExtrato<BankLine>> => {
    const qs = new URLSearchParams();
    if (params.statementId) qs.set('statementId', params.statementId);
    if (params.onlyUnmatched) qs.set('onlyUnmatched', 'true');
    if (params.onlyMatched) qs.set('onlyMatched', 'true');
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    const q = qs.toString();
    const r = await apiRequest<Partial<PaginaDoExtrato<BankLine>> & { items: BankLine[] }>(
      `/core/bank/lines${q ? `?${q}` : ''}`,
    );
    // Sem `items` o contrato quebrou: vira o erro que a tela já sabe mostrar,
    // em vez de uma lista vazia que diria "nada a conciliar".
    const items = envelope('items')(r);
    const offset = r.offset ?? params.offset ?? 0;
    return {
      items,
      total: r.total ?? offset + items.length,
      limit: r.limit ?? items.length,
      offset,
      truncated: r.truncated ?? false,
    };
  },

  importBankStatement: (input: {
    accountLabel: string;
    sourceName?: string | null;
    lines: {
      occurredAt: string;
      description: string;
      amountCents: number;
      externalId?: string | null;
    }[];
  }) =>
    apiRequest<{ statementId: string; imported: number; skipped: number }>(
      '/core/bank/statements',
      { method: 'POST', body: input },
    ),

  bankSuggestions: (lineId: string) =>
    apiRequest<{ items: BankSettlementSuggestion[] }>(
      `/core/bank/lines/${lineId}/suggestions`,
    ).then(envelope('items')),

  matchBankLine: (lineId: string, settlementId: string) =>
    apiRequest<BankLine>(`/core/bank/lines/${lineId}/match`, {
      method: 'POST',
      body: { settlementId },
    }),

  unmatchBankLine: (lineId: string) =>
    apiRequest<{ ok: boolean }>(`/core/bank/lines/${lineId}/match`, { method: 'DELETE' }),

  bankReconciliation: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const q = qs.toString();
    return apiRequest<BankReconciliationReport>(`/core/bank/conciliacao${q ? `?${q}` : ''}`);
  },

  // ------------------------------------------ administração da loja
  //
  // Identidade da vitrine por operação. O CATÁLOGO não passa por aqui: quem
  // decide o que aparece é `publish_online` no produto.

  getStorefrontSettings: () =>
    apiRequest<{
      settings: StorefrontSettings;
      products: StorefrontAdminProduct[];
      /** Que negócio esta loja faz. Mora em `core_companies` (rodada 56). */
      preset: string | null;
    }>('/core/storefront/settings').then((r) => exigirCampos(r, 'settings', 'products')),

  updateStorefrontSettings: (input: {
    headline?: string | null;
    description?: string | null;
    whatsapp?: string | null;
    bannerText?: string | null;
    bannerActive?: boolean;
    /**
     * De 1 a 24, ou nulo para não anunciar parcelamento (rodada 56).
     *
     * Aceita TEXTO porque é o que o campo tem para mandar. Convertê-lo aqui
     * faria "seis" virar `NaN`, que o JSON serializa como `null` — e o
     * servidor leria "limpar o campo" onde a pessoa quis dizer seis, gravando
     * "não anuncia" com a tela dizendo "Salvo". Quem recusa é ele.
     */
    installmentsMax?: number | string | null;
    /** Que negócio esta loja faz — decide o ARRANJO da vitrine (rodada 56). */
    storefrontPreset?: string | null;
  }) => apiRequest<StorefrontSettings>('/core/storefront/settings', { method: 'PUT', body: input }),

  setFeatured: (productId: string, featured: boolean) =>
    apiRequest<{ id: string; featured_online: number }>(
      `/core/storefront/featured/${productId}`,
      { method: 'POST', body: { featured } },
    ),

  /** Logo ou capa da página da marca. A imagem sobe em base64 (rodada 40). */
  setStoreImage: (tipo: 'logo' | 'capa', dataUrl: string) =>
    apiRequest<StorefrontSettings>('/core/storefront/imagem', {
      method: 'POST',
      body: { tipo, dataUrl },
    }),

  removeStoreImage: (tipo: 'logo' | 'capa') =>
    apiRequest<StorefrontSettings>(`/core/storefront/imagem/${tipo}`, { method: 'DELETE' }),

  // ------------------------------------------------------------ oficinas
  //
  // As capacidades vêm do servidor: a tela não repete a regra de qual oficina
  // usa plaquinha, senão as duas divergem na primeira mudança.

  listWorkshopMembers: (workshopId: string) =>
    apiRequest<{ items: WorkshopMember[] }>(`/core/workshops/${workshopId}/members`).then(envelope('items')),

  addWorkshopMember: (workshopId: string, userId: string, role = 'mecanico') =>
    apiRequest<{ id: string; alreadyMember: boolean }>(
      `/core/workshops/${workshopId}/members`,
      { method: 'POST', body: { userId, role } },
    ),

  removeWorkshopMember: (workshopId: string, userId: string) =>
    apiRequest<{ ok: boolean }>(`/core/workshops/${workshopId}/members/${userId}`, {
      method: 'DELETE',
    }),

  // ------------------------------------------------------------------ BI
  //
  // Compara as operações a que a pessoa está VINCULADA. Margem só onde o custo
  // é confiável — e a resposta diz quantos itens ficaram de fora.

  insightsOperations: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const q = qs.toString();
    return apiRequest<{ operations: OperationSummary[]; totals: OperationTotals }>(
      `/core/insights/operations${q ? `?${q}` : ''}`,
    );
  },

  insightsProducts: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const q = qs.toString();
    return apiRequest<{ items: InsightProduct[] }>(
      `/core/insights/products${q ? `?${q}` : ''}`,
    ).then(envelope('items'));
  },

  insightsMargin: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const q = qs.toString();
    return apiRequest<MarginSummary>(`/core/insights/margin${q ? `?${q}` : ''}`);
  },

  /** Vendas por MARCA nas operações do vínculo — GAP-V44. */
  insightsBrands: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const q = qs.toString();
    return apiRequest<{ items: BrandSummary[] }>(
      `/core/insights/brands${q ? `?${q}` : ''}`,
    ).then(envelope('items'));
  },

  // --------------------------------------------- Central de Relatórios
  //
  // GAP-V37. O catálogo é DADO no servidor (`ReportsService`): a tela desenha
  // o que ele diz — os filtros que cada relatório de fato usa, as colunas e o
  // tipo delas. Nada aqui repete a lista, senão ela envelheceria calada no dia
  // em que nascesse o décimo quinto relatório.

  reportsCatalog: () =>
    apiRequest<{ items: ReportDefinition[] }>('/core/reports').then(envelope('items')),

  report: (id: string, filtros: ReportFilters = {}) =>
    apiRequest<ReportResult>(`/core/reports/${encodeURIComponent(id)}${queryDoRelatorio(filtros)}`),

  /**
   * O CSV do relatório, já em bytes e com o nome que o servidor deu.
   *
   * `apiBinary` e não `<a href>`: `authMiddleware` lê o token SÓ do cabeçalho
   * `Authorization`, e navegação disparada por link não manda cabeçalho
   * nenhum — o resultado seria 401 no lugar do arquivo. É o mesmo caminho já
   * provado no pacote do contador.
   */
  reportCsv: (id: string, filtros: ReportFilters = {}) =>
    apiBinary(
      `/core/reports/${encodeURIComponent(id)}${queryDoRelatorio({ ...filtros, formato: 'csv' })}`,
      `${id}.csv`,
    ),

  // painel
  dashboard: (from?: string, to?: string, companyId?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    /*
      A OPERAÇÃO PEDIDA (GAP-V46) — e ela atravessa pelo VÍNCULO, conferido no
      servidor: pedir uma empresa fora do vínculo recebe 403, não os números
      dela. Sem o parâmetro, nada muda; o painel é o da sessão.
    */
    if (companyId) params.set('companyId', companyId);
    const qs = params.toString();
    return apiRequest<DashboardData>(`/core/dashboard${qs ? `?${qs}` : ''}`);
  },
};
