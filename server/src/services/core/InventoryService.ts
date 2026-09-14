/**
 * Estoque: saldo por empresa+produto e razão imutável de movimentos.
 *
 * Invariantes garantidos pelo banco, não por disciplina de código:
 *
 *  - saldo nunca fica negativo  -> CHECK (quantity >= 0) em core_stock
 *  - baixa acontece UMA vez     -> UNIQUE (company, referência, produto, tipo)
 *
 * Consequência prática: dois PDVs vendendo simultaneamente o último item não
 * conseguem ambos concluir — o segundo COMMIT falha e a venda é rejeitada
 * com erro de estoque, em vez de deixar saldo negativo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { limitesDoPeriodo } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';
import {
  assertUnitsSellable,
  isSerialized,
  markUnitsIn,
  markUnitsOut,
  pickUnitsFifo,
} from './ProductUnitService.js';
import { exigirUnidadesLivres } from './UnitHoldService.js';
/*
  A PONTE COM A PLAQUINHA DA OFICINA ENTRA AQUI PORQUE O ACOPLAMENTO JÁ MORA AQUI.

  `markUnitsOut` e `markUnitsIn` têm UM chamador só em todo o projeto — o ramo
  serializado logo abaixo. Pendurar a plaquinha no mesmo ponto é o que garante
  que ela mude na MESMA transação do saldo e do status da unidade: o rollback
  que desfaz um desfaz os três.

  Sobre o CICLO de importação: `EquipmentStockLink` importa `CatalogService`
  (pelo espelho do cliente) e `CatalogService` importa este arquivo (`getBalance`).
  O ciclo é inofensivo porque nenhum dos três chama nada do outro durante a
  AVALIAÇÃO do módulo — só declarações de função atravessam, e elas são içadas.
  Se algum dia alguém puser trabalho no corpo de um desses módulos, este é o
  parágrafo que explica por que ele quebrou.
*/
import {
  assertUnidadesComPlaquinhaVendiveis,
  baixarPelaUnidade,
  devolverPelaUnidade,
  venderPelaUnidade,
  REFERENCIAS_QUE_DAO_DONO,
} from './EquipmentStockLink.js';
/*
  O LOTE ENTRA AQUI PELO MESMO MOTIVO QUE A UNIDADE SERIALIZADA E O LOCAL.

  Este é o único escritor de `core_stock.quantity` do projeto. Pôr a escolha do
  lote neste ponto é o que garante que NENHUM caminho — venda, devolução,
  transferência, OS, entrada de nota, rota manual, e os que ainda não existem —
  mova saldo de um produto com controle de lote sem dizer de qual lote a
  mercadoria saiu.

  Sobre o CICLO de importação: `BatchService` importa `applyMovement` daqui (a
  alocação é um par de movimentos) e este arquivo importa o FEFO de lá. O ciclo
  é inofensivo pela mesma razão já escrita acima para `EquipmentStockLink`:
  nenhum dos dois chama nada do outro durante a AVALIAÇÃO do módulo — só
  declarações de função atravessam, e elas são içadas.
*/
import { assertBatchUsable, pickBatchFefo } from './BatchService.js';
// A régua do valor do estoque (GAP-PRD-166). Só lê o banco: sem ciclo.
import {
  aplicarRegua,
  politicaDeGestao,
  type ReguaDeValorizacao,
} from './PoliticaDeGestaoService.js';

/**
 * Saídas em que a unidade NÃO sai de verdade: ela volta na perna de entrada.
 *
 * Só a transferência entre locais. Tudo o mais que sai e não é venda é saída
 * DEFINITIVA — e é por isso que a lista é de EXCEÇÕES, e não de casos: módulo
 * novo inventa referência nova, e o padrão tem de ser o desfecho recuperável.
 * Plaquinha solta se vincula de novo em dois cliques; plaquinha congelada só
 * sai com alguém abrindo o banco.
 */
const SAIDAS_DE_PASSAGEM = new Set(['transferencia']);

/** Direção crua do movimento. Faz parte da chave de idempotência. */
export type MovementType = 'in' | 'out' | 'adjust';

/**
 * POR QUE o saldo mudou.
 *
 * A direção sozinha não explica nada: "saiu 2" pode ser venda, consumo de OS,
 * transferência ou perda de inventário, e cada uma dessas exige uma conversa
 * diferente com o gestor. É este campo que a tela de histórico mostra.
 *
 * Só existem aqui tipos que algum fluxo do sistema realmente produz — inventar
 * tipo para módulo que não mexe em estoque só encheria o filtro de opções
 * mortas.
 */
export const MOVEMENT_KINDS = [
  // entrada e saída lançadas à mão pelo balcão ou pelo estoquista
  'MANUAL_ENTRY',
  'MANUAL_EXIT',
  // compra
  'PURCHASE_RECEIPT',
  'XML_RECEIPT',
  /*
    ESTORNO DA ENTRADA — a saída que desfaz uma compra confirmada por engano.

    O gesto existe desde o GAP-V20 e sempre gravou a perna contrária com
    referência PRÓPRIA ('estorno_entrada'), que é o que deduplica o segundo
    clique. O `kind`, porém, era EMPRESTADO: saía como MANUAL_EXIT, rotulado
    "Saída manual" na tela de Movimentações.

    E "saída manual" é outro fato. Quem lê o histórico do produto meses depois
    entende mercadoria que saiu da prateleira — perda, consumo interno,
    brinde — e repõe. O que houve foi o oposto: a mercadoria nunca entrou,
    porque a entrada que a trouxe foi desfeita. Pior no filtro por tipo, onde
    escolher "Saída manual" devolvia estornos misturados com perdas, sem
    nenhuma forma de separá-los fora do banco.

    É a mesma razão que deu quatro rótulos à oficina e três à consignação: um
    rótulo só para "saiu" não distingue fatos que levam a decisões opostas.
  */
  'ENTRY_REVERSAL',
  /*
    CARGA INICIAL POR PLANILHA — a loja que abre e conta o que já tem.

    Merece rótulo PRÓPRIO e não pode se esconder atrás de outro. Cair em
    XML_RECEIPT seria dizer que houve nota fiscal onde houve um arquivo que a
    própria loja digitou. Cair em INVENTORY_ADJUSTMENT_POSITIVE seria pior: o
    primeiro saldo da operação apareceria no histórico como sobra encontrada
    numa contagem que nunca aconteceu, e quem abrir Movimentações daqui a seis
    meses lê uma mentira sem ter como desconfiar.

    O histórico de estoque é o que se consulta quando a prateleira discorda do
    sistema. Ele só serve se cada linha disser de onde o saldo veio.
  */
  'SPREADSHEET_IMPORT',
  // venda
  'SALE',
  'SALE_CANCEL',
  'SALE_RETURN',
  /*
    OFICINA — e são QUATRO rótulos porque são quatro fatos diferentes.

    A peça lançada na OS não sai da prateleira na hora: ela fica PROMETIDA ao
    conserto (rodada 55). O lançamento acontece antes de o cliente decidir — a
    própria oficina exige peça ou mão de obra lançada para poder pedir a
    aprovação —, e um orçamento recusado devolveria a peça só se alguém
    lembrasse. Ninguém lembra.

    Então a reserva tem os dois lados, e cada um diz o que aconteceu de fato:
    RESERVATION quando a peça é prometida, RESERVATION_RELEASE quando a promessa
    cai (cliente recusou, ou a peça voltou para a gaveta antes de ser usada), e
    CONSUMPTION quando ela sai de verdade. Um rótulo só para "soltou" não
    distinguiria a peça que voltou para a prateleira da que foi embora dentro
    da moto — que é a diferença entre ter e não ter mercadoria.
  */
  'WORKSHOP_PART_RESERVATION',
  'WORKSHOP_PART_RESERVATION_RELEASE',
  'WORKSHOP_PART_CONSUMPTION',
  'WORKSHOP_PART_RETURN',
  // entre operações
  'TRANSFER_OUT',
  'TRANSFER_IN',
  // acerto de inventário
  'INVENTORY_ADJUSTMENT_POSITIVE',
  'INVENTORY_ADJUSTMENT_NEGATIVE',
  'INVENTORY_COUNT',
  /*
    O AJUSTE DE SALDO (±) DA TELA DE MOVIMENTAÇÕES — B-estoque-entrada-13.

    Saía rotulado "Acerto de inventário (+)/(−)", o MESMO rótulo do acerto de
    uma contagem de verdade (InventoryCountService). No histórico, o +20 que
    alguém lançou no balcão sem contar nada ficava indistinguível da sobra
    achada numa contagem com esperado, contado e quem contou — e o filtro por
    "acerto de inventário" misturava os dois. São fatos diferentes: um tem
    contagem por trás, o outro é uma afirmação avulsa.
  */
  'MANUAL_ADJUSTMENT_POSITIVE',
  'MANUAL_ADJUSTMENT_NEGATIVE',
  // vitrine: reserva não mexe no físico
  'ECOMMERCE_RESERVATION',
  'ECOMMERCE_RESERVATION_RELEASE',
  'ECOMMERCE_CONSUMPTION',
  // pré-venda: idem
  'PRE_SALE_RESERVATION',
  'PRE_SALE_RELEASE',
  'PRE_SALE_CONSUMPTION',
  /*
    RESERVA SEM ORIGEM LIBERADA (GAP-PRD-087) — o gesto do gestor, e só dele.

    Não é "reserva liberada (loja online)" nem "pré-venda liberada": essas duas
    dizem que a ORIGEM caiu (pedido expirou, pré-venda cancelada). Aqui não há
    origem nenhuma para cair — o número `reserved` segurava mercadoria sem
    pedido, pré-venda, locação ou OS abertos, e alguém decidiu soltá-la com
    motivo. Emprestar um dos rótulos acima esconderia exatamente o fato que a
    conferência existe para mostrar.
  */
  'ORPHAN_RESERVATION_RELEASE',
  /*
    DEVOLUÇÃO AO FORNECEDOR (GAP-PRD-089) — a saída que desfaz PARTE de uma
    compra que continua valendo.

    Não é o estorno da entrada (ENTRY_REVERSAL): o estorno diz que a entrada
    nunca deveria ter acontecido e desfaz a nota inteira. Aqui a nota
    aconteceu, foi paga ou está sendo paga, e parte da mercadoria volta para
    quem vendeu — defeito, sobra, item trocado. E não é "saída manual": a
    saída manual é mercadoria que deixou a prateleira sem destino (perda, uso
    interno), e quem lê isso repõe. A devolução tem destino, documento e
    crédito com o fornecedor.
  */
  'SUPPLIER_RETURN',
  /*
    CONSIGNAÇÃO — e são TRÊS rótulos porque são três fatos diferentes (GAP-V65).

    Ao contrário da reserva, aqui a mercadoria SAI DE VERDADE: ela vai para a
    casa da cliente. O saldo cai, e é isso que faz a contagem do mês fechar.

    REMESSA é a saída. RETORNO é a peça que voltou para a prateleira — física,
    contável, na mão. RETORNO SIMBÓLICO é outra coisa e não pode se esconder
    atrás do primeiro: é a perna de entrada que acompanha o FATURAMENTO da
    peça que o cliente ficou. Ela existe porque a peça já saiu na remessa e a
    venda não pode baixá-la de novo — e é exatamente o documento que a
    legislação brasileira exige antes da nota de venda em consignação.

    Um rótulo só para "voltou" não distinguiria a peça que está de novo na
    arara da peça que foi embora com quem a levou — que é a diferença entre ter
    e não ter mercadoria. É a mesma razão que fez a oficina ter quatro.
  */
  'CONSIGNMENT_OUT',
  'CONSIGNMENT_RETURN',
  'CONSIGNMENT_SYMBOLIC_RETURN',
] as const;

export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Rótulo em português para a tela do gestor. */
export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  MANUAL_ENTRY: 'Entrada manual',
  MANUAL_EXIT: 'Saída manual',
  PURCHASE_RECEIPT: 'Recebimento de compra',
  XML_RECEIPT: 'Entrada por XML',
  ENTRY_REVERSAL: 'Estorno de entrada',
  SPREADSHEET_IMPORT: 'Carga inicial por planilha',
  SALE: 'Venda',
  SALE_CANCEL: 'Cancelamento de venda',
  SALE_RETURN: 'Devolução de venda',
  WORKSHOP_PART_RESERVATION: 'Peça prometida a uma OS',
  WORKSHOP_PART_RESERVATION_RELEASE: 'Promessa de peça desfeita',
  WORKSHOP_PART_CONSUMPTION: 'Peça consumida em OS',
  WORKSHOP_PART_RETURN: 'Peça devolvida da OS',
  TRANSFER_OUT: 'Transferência — saída',
  TRANSFER_IN: 'Transferência — entrada',
  INVENTORY_ADJUSTMENT_POSITIVE: 'Acerto de inventário (+)',
  INVENTORY_ADJUSTMENT_NEGATIVE: 'Acerto de inventário (−)',
  INVENTORY_COUNT: 'Contagem de inventário',
  MANUAL_ADJUSTMENT_POSITIVE: 'Ajuste manual de saldo (+)',
  MANUAL_ADJUSTMENT_NEGATIVE: 'Ajuste manual de saldo (−)',
  ECOMMERCE_RESERVATION: 'Reserva da loja online',
  ECOMMERCE_RESERVATION_RELEASE: 'Reserva liberada (loja online)',
  ECOMMERCE_CONSUMPTION: 'Baixa da loja online',
  PRE_SALE_RESERVATION: 'Reserva de pré-venda',
  PRE_SALE_RELEASE: 'Reserva de pré-venda liberada',
  PRE_SALE_CONSUMPTION: 'Baixa de pré-venda',
  ORPHAN_RESERVATION_RELEASE: 'Reserva sem origem liberada',
  SUPPLIER_RETURN: 'Devolução ao fornecedor',
  CONSIGNMENT_OUT: 'Remessa em consignação',
  CONSIGNMENT_RETURN: 'Retorno de consignação',
  CONSIGNMENT_SYMBOLIC_RETURN: 'Retorno simbólico (faturamento da consignação)',
};

/**
 * Quando o chamador não informa a semântica, deduz da referência.
 *
 * Existe para que nenhum ponto de chamada antigo passe a gravar histórico sem
 * explicação — e não para dispensar o `kind` explícito em código novo.
 */
function inferKind(referenceType: string, movementType: MovementType, delta: number): MovementKind {
  /*
    A TRANSFERÊNCIA DEPENDE DA DIREÇÃO, e por isso não cabe na tabela abaixo:
    uma referência, dois fatos. Ela está aqui — e não só no `kind` explícito de
    `transferStock` — porque foi exatamente esta falta que fez as duas pernas
    saírem como MANUAL_EXIT/MANUAL_ENTRY por rodadas a fio, com o filtro da
    tela oferecendo "Transferência" e devolvendo lista vazia. O conserto de
    verdade é o kind explícito lá; isto é a rede embaixo, para o próximo ponto
    de chamada que esquecer.
  */
  if (referenceType === 'transferencia') {
    return movementType === 'in' ? 'TRANSFER_IN' : 'TRANSFER_OUT';
  }

  const byReference: Record<string, MovementKind> = {
    sale: 'SALE',
    sale_cancel: 'SALE_CANCEL',
    nfe_entrada: 'XML_RECEIPT',
    service_order: 'WORKSHOP_PART_CONSUMPTION',
    ecommerce_order: 'ECOMMERCE_CONSUMPTION',
    entrada: 'MANUAL_ENTRY',
    // Mesma rede, para a saída que desfaz uma entrada confirmada por engano.
    estorno_entrada: 'ENTRY_REVERSAL',
    // E para a devolução de parte da compra ao fornecedor (GAP-PRD-089).
    devolucao_fornecedor: 'SUPPLIER_RETURN',
  };
  const known = byReference[referenceType];
  if (known) return known;
  if (movementType === 'in') return 'MANUAL_ENTRY';
  if (movementType === 'out') return 'MANUAL_EXIT';
  /*
    O 'adjust' sem `kind` explícito só nasce do lançamento avulso (B-13): a
    contagem e a baixa de unidade informam o kind. O acerto de INVENTÁRIO é o
    da referência 'inventory_count'; o resto é ajuste manual, com rótulo
    próprio — nunca mais "acerto de inventário" sem contagem por trás.
  */
  if (referenceType === 'inventory_count') {
    return delta < 0 ? 'INVENTORY_ADJUSTMENT_NEGATIVE' : 'INVENTORY_ADJUSTMENT_POSITIVE';
  }
  return delta < 0 ? 'MANUAL_ADJUSTMENT_NEGATIVE' : 'MANUAL_ADJUSTMENT_POSITIVE';
}

/*
  A LISTA DAS REFERÊNCIAS QUE DÃO DONO NÃO MORA MAIS AQUI — E ISSO FOI UM CONSERTO.

  Este arquivo tinha `REFERENCIAS_DE_VENDA`, cópia literal de
  `REFERENCIAS_QUE_DAO_DONO` (importada logo acima). Duas listas para a MESMA
  decisão, sem nenhum teste afirmando que eram iguais.

  Elas divergiram, e o estrago tem nome: enquanto a de lá já incluía
  `ecommerce_order` e a daqui ainda dizia só `'sale'`, o atendimento do canal
  online era CÓDIGO MORTO — a moto vendida pelo site saía do estoque e a
  plaquinha continuava `NOT_SOLD`, sem dono, que é exatamente o defeito que a
  ponte existe para matar, só que pelo outro canal.

  A de lá decide o que fazer com cada referência e é onde a decisão de domínio
  está documentada por extenso (inclusive por que cada referência ficou de fora);
  a daqui só decidia quando perguntar. Uma pergunta que precisa concordar com a
  resposta não pode ter fonte própria.
*/

export interface MovementInput {
  companyId: string;
  productId: string;
  movementType: MovementType;
  /** Sempre positiva; o sinal é definido por `movementType`. */
  quantity: number;
  referenceType: string;
  referenceId: string;
  /** Por que o saldo mudou. Deduzido da referência quando omitido. */
  kind?: MovementKind;
  /** Número do documento de origem (NF-e, venda, OS) para o gestor achar o papel. */
  documentNumber?: string | null;
  workshopId?: string | null;
  unitCostCents?: number;
  userId?: string | null;
  reason?: string | null;
  note?: string | null;
  /**
   * Onde a mercadoria entrou ou saiu. Omitir cai no local padrão da empresa —
   * é o que mantém todo chamador anterior a esta coluna funcionando sem
   * alteração, e o que faz o movimento antigo continuar legível.
   */
  locationId?: string | null;
  /**
   * QUAIS peças se moveram, para produto serializado.
   *
   * Obrigatório quando `core_products.serialized = 1`, e a ausência é RECUSA,
   * não um padrão: o funil não escolhe unidade sozinho. A quantidade tem de
   * bater exatamente com o tamanho desta lista.
   */
  unitIds?: string[];
  /**
   * O que o pedido com chave DO CLIENTE pediu — `v1:` de `ImpressaoDaRequisicao`
   * (RES-IDEM-VIZ).
   *
   * Só passa quem recebe a referência de fora: a rota manual (a referência é a
   * chave de quem chama) e a entrada de peça de bancada (Idempotency-Key). Com
   * ela, o movimento repetido com outra carga é 422 em vez de "duplicado", e a
   * impressão fica gravada na linha. Os chamadores internos (venda, nota, OS)
   * não passam: a referência deles é o próprio documento, e o reprocessamento
   * do mesmo documento é o mesmo movimento.
   */
  impressao?: string | null;
  /**
   * DE QUAL LOTE, para produto com `tracks_batches = 1`.
   *
   * Omitir é o caminho normal e NÃO é descuido: na SAÍDA o FEFO escolhe (o que
   * vence primeiro sai primeiro) e grava a escolha no movimento; na ENTRADA,
   * omitir significa "mercadoria sem lote declarado", que é um estado honesto
   * — o XML da nota traz quantidade e custo, nunca lote — e vira pendência de
   * conferência na tela de Validade.
   *
   * Informar é o gesto deliberado: a entrada da doca que já leu a validade
   * impressa, ou a saída por perda que descarta AQUELE lote.
   *
   * Em produto SEM controle de lote, informar é RECUSA e não silêncio — o
   * mesmo desenho de `unitIds` em produto não serializado. Chamada que parece
   * funcionar e não faz nada é pior que erro.
   */
  batchId?: string | null;
  /**
   * "Esta saída vem do balde SEM LOTE, e não é para o FEFO escolher."
   *
   * Existe por causa da ALOCAÇÃO (`allocateToBatch`), que é o único caminho em
   * que tirar do balde é a intenção — sem esta bandeira o FEFO escolheria um
   * lote declarado e a alocação roubaria saldo de quem já estava certo. Um
   * `batchId: null` explícito não serviria: `null` e ausente são o mesmo valor
   * para quem chama sem o campo.
   */
  semLote?: boolean;
}

export interface StockBalance {
  company_id: string;
  product_id: string;
  quantity: number;
  reserved: number;
}

export function getBalance(companyId: string, productId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function signedDelta(type: MovementType, quantity: number): number {
  /*
    'in' e 'out' só chegam aqui com quantidade POSITIVA — `applyMovement`
    recusa o resto na porta. O sinal é decidido pelo TIPO, nunca adivinhado do
    número: o `Math.abs` que morava nestas duas linhas transformava uma
    entrada de −5 em +5 em silêncio, e quem digitou o sinal errado querendo
    tirar 5 ganhava um erro de 10 unidades sem nenhum aviso.
  */
  if (type === 'out') return -quantity;
  if (type === 'in') return quantity;
  return quantity; // 'adjust' aceita delta com sinal explícito
}

/**
 * DE ONDE A MERCADORIA SAIU, quando o chamador não sabe dizer.
 *
 * `location_id` é preenchido por UM chamador em todo o projeto: a rota de
 * movimento manual. Venda, consumo de peça em OS, entrada de nota e
 * devolução gravam NULL — e `balanceByLocation` cobra o NULL do local
 * padrão. Com a mercadoria transferida para a Vitrine, o padrão ficava
 * devendo o que nunca esteve lá: GERAL −3, Vitrine cheia.
 *
 * O total da empresa continuava certo (o CHECK cuida disso). A DISTRIBUIÇÃO
 * é que virava ficção — e `transferStock` valida contra ela: oferecia
 * devolver da Vitrine peça que já tinha saído pela porta, e recusava
 * transferência legítima do padrão envenenado.
 *
 * A escolha aqui não inventa nada — ela procura o local que TEM:
 *
 *   1. o padrão, se cobrir a saída. É onde a mercadoria está quando
 *      ninguém mexeu em local nenhum, que é o caso de quase toda empresa,
 *      e nada pode mudar para elas;
 *   2. senão, o local com mais saldo que cubra a saída inteira;
 *   3. senão, o local com mais saldo.
 *
 * O passo 3 é o resto honesto. Mercadoria espalhada em pedaços menores que
 * a saída precisaria de VÁRIAS linhas de movimento, e rachar a linha
 * quebraria a chave de idempotência do razão — UNIQUE (empresa, tipo de
 * referência, referência, produto, tipo de movimento) — que é a proteção
 * mais forte deste sistema. O local mais cheio fica devendo e o relatório
 * mostra isso, o que é diferente de cobrar do padrão um saldo que nunca
 * esteve lá.
 */
function localDaSaida(
  companyId: string,
  productId: string,
  quantidade: number,
): string | null {
  const db = getConnection();
  const padrao = db
    .prepare('SELECT id FROM core_stock_locations WHERE company_id = ? AND is_default = 1')
    .get(companyId) as { id: string } | undefined;
  // Sem local padrão a empresa não usa locais: o NULL de sempre.
  if (!padrao) return null;

  /*
    UM LOCAL SÓ NÃO TEM ESCOLHA A FAZER.

    É o caso de quase toda empresa, e é o caminho de TODA venda de balcão —
    esta função roda em cada saída de estoque. Somar o razão inteiro do produto
    para concluir "vai para o único local que existe" seria cobrar de quem
    nunca usou a funcionalidade o preço de quem usa.
  */
  const quantos = db
    .prepare(
      'SELECT COUNT(*) AS n FROM core_stock_locations WHERE company_id = ? AND active = 1',
    )
    .get(companyId) as { n: number };
  if (quantos.n <= 1) return padrao.id;

  const saldos = db
    .prepare(
      `SELECT COALESCE(location_id, ?) AS location_id, SUM(quantity) AS saldo
         FROM core_stock_movements
        WHERE company_id = ? AND product_id = ?
        GROUP BY COALESCE(location_id, ?)
        ORDER BY saldo DESC`,
    )
    .all(padrao.id, companyId, productId, padrao.id) as unknown as {
    location_id: string;
    saldo: number;
  }[];

  const noPadrao = saldos.find((l) => l.location_id === padrao.id)?.saldo ?? 0;
  if (noPadrao >= quantidade) return padrao.id;

  const cobre = saldos.find((l) => l.saldo >= quantidade);
  if (cobre) return cobre.location_id;

  return saldos[0]?.location_id ?? padrao.id;
}

/**
 * A referência do cliente voltou com OUTRA carga? (RES-IDEM-VIZ)
 *
 * Confere o movimento que já existe com a mesma identidade (empresa, tipo de
 * referência, referência, produto, direção) contra a impressão do pedido de
 * agora, e recusa com 422 CORE_IDEMPOTENCY_KEY_REUSED. Exposta para a rota
 * conferir ANTES de qualquer escrita dela (o lote novo pelo código);
 * `applyMovement` confere de novo, dentro da própria transação.
 */
export function conferirReenvioDoMovimento(input: {
  companyId: string;
  referenceType: string;
  referenceId: string;
  productId: string;
  movementType: MovementType;
  impressao: string;
}): void {
  ensureCoreSchema();
  const ja = getConnection()
    .prepare(
      `SELECT idempotency_fingerprint FROM core_stock_movements
        WHERE company_id = ? AND reference_type = ? AND reference_id = ?
          AND product_id = ? AND movement_type = ?`,
    )
    .get(input.companyId, input.referenceType, input.referenceId, input.productId, input.movementType) as
    | { idempotency_fingerprint: string | null }
    | undefined;
  if (ja && Impressao.outraImpressao(ja.idempotency_fingerprint, input.impressao)) {
    throw Impressao.chaveReusada(`o movimento de estoque "${input.referenceId}"`, { referenceId: input.referenceId });
  }
}

/**
 * Aplica um movimento de estoque. Deve ser chamada dentro de uma transação
 * quando fizer parte de uma operação maior (venda, entrada de nota).
 *
 * Idempotente por (empresa, referenceType, referenceId, produto, tipo):
 * reprocessar a mesma venda não debita o estoque de novo — retorna o saldo
 * corrente e sinaliza `duplicated`.
 */
export function applyMovement(input: MovementInput): { balance: number; duplicated: boolean } {
  ensureCoreSchema();
  if (!Number.isFinite(input.quantity) || input.quantity === 0) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade inválida.', 400);
  }
  /*
    EM 'in'/'out' O SINAL É DO TIPO, E QUANTIDADE NEGATIVA É RECUSA.

    O contrato sempre disse "sempre positiva; o sinal é definido por
    movementType" — mas ninguém cobrava, e `signedDelta` aplicava `Math.abs`:
    uma entrada de −5 virava +5 em silêncio. Quem digitou −5 querendo tirar 5
    recebia o CONTRÁRIO do que pediu, e o histórico registrava uma entrada que
    ninguém fez. Chamada que parece funcionar e faz o oposto é pior que erro.

    Só 'adjust' carrega sinal, porque nele o sinal É a informação — o acerto
    de contagem diz para que lado a prateleira discorda do sistema.
  */
  if (input.movementType !== 'adjust' && input.quantity < 0) {
    throw new ApiError(
      'CORE_INVALID_QUANTITY',
      'Quantidade deve ser positiva: em entrada e saída, o sinal é dado pelo tipo do movimento.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();

    /*
      O PRODUTO É DA MESMA EMPRESA — auditoria de entrega.

      O `productId` vinha do corpo e era gravado cru: a empresa A conseguia
      criar SALDO-FANTASMA para um produto da B — uma linha de estoque com
      `company_id` da A apontando para produto que não é dela. Inventário,
      reposição e relatório passavam a discordar para sempre, e nenhuma tela
      mostrava o porquê: o produto nem aparece no catálogo da A.

      A validação mora AQUI, no serviço, porque é onde todo chamador passa —
      a rota manual, a venda, a devolução, a entrada por XML e os que ainda
      não existem.
    */
    const dono = db
      .prepare(
        `SELECT p.company_id, p.name, p.is_kit, p.kit_explode_on_sale, p.tracks_batches,
                EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
           FROM core_products p WHERE p.id = ?`,
      )
      .get(input.productId) as
      | {
          company_id: string;
          name: string;
          is_kit: number;
          kit_explode_on_sale: number;
          /*
            DE CARONA no SELECT que já existia, e é assim que a regra 1 do
            módulo de lote se cumpre de graça: produto sem controle não paga
            NENHUMA consulta a mais por causa dele. Uma chamada a
            `productTracksBatches` aqui somaria um SELECT a cada baixa de cada
            venda de cada loja, para responder 0 em quase todas.
          */
          tracks_batches: number;
          tem_grade: number;
        }
      | undefined;
    if (!dono || dono.company_id !== input.companyId) {
      throw new ApiError(
        'CORE_PRODUCT_INVALID',
        'O produto informado não é desta operação.',
        400,
      );
    }

    /*
      ================================================================
      MODELO DE GRADE E KIT NÃO RECEBEM NEM ENTREGAM SALDO
      ================================================================

      O sistema já tinha decidido isso e cumpria em cinco lugares — a venda
      recusa com `CORE_PRODUCT_HAS_VARIANTS`, o orçamento recusa, a busca do
      PDV esconde, a contagem de inventário nem lista. Só que a regra estava
      replicada por consulta ad-hoc em cada um desses chamadores, e o funil por
      onde TODOS passam não a conhecia.

      O resultado é mercadoria real presa num produto que ninguém consegue
      vender, contar ou corrigir: ela APARECE na tela de Estoque, SOME do PDV,
      escapa da contagem — que é o único mecanismo de reconciliação do ERP — e
      ainda CRESCE, porque a entrada de nota continua casando o item do
      fornecedor com o código de barras e o nome do modelo, que a geração da
      grade não limpa.

      O KIT TEM DOIS FEITIOS, e só um deles é virtual. O que DESMEMBRA na venda
      (o padrão) não tem saldo próprio: o dele é a soma dos componentes, e
      somar de novo no kit contaria a mesma mercadoria duas vezes. O que NÃO
      desmembra foi montado antes e está na prateleira como uma unidade — esse
      tem saldo próprio, e movimentá-lo é o certo.

      A recusa é aqui porque aqui é onde todo chamador passa — inclusive os que
      ainda não existem.
    */
    if (dono.tem_grade) {
      throw new ApiError(
        'CORE_PRODUCT_IS_GRID_MODEL',
        `"${dono.name}" é um modelo de grade: o saldo fica na variante (tamanho/cor), `
          + 'e não no modelo. Escolha a variante.',
        400,
        { productId: input.productId },
      );
    }
    if (dono.is_kit && dono.kit_explode_on_sale) {
      throw new ApiError(
        'CORE_PRODUCT_IS_KIT',
        `"${dono.name}" é um kit que desmembra na venda: o saldo dele é o dos componentes, `
          + 'e movimentar o kit contaria a mesma mercadoria duas vezes.',
        400,
        { productId: input.productId },
      );
    }

    const already = db
      .prepare(
        `SELECT balance_after, idempotency_fingerprint FROM core_stock_movements
          WHERE company_id = ? AND reference_type = ? AND reference_id = ?
            AND product_id = ? AND movement_type = ?`,
      )
      .get(
        input.companyId,
        input.referenceType,
        input.referenceId,
        input.productId,
        input.movementType,
      ) as { balance_after: number; idempotency_fingerprint: string | null } | undefined;
    if (already) {
      // A referência do cliente com outra carga não é reprocessamento (RES-IDEM-VIZ).
      if (input.impressao && Impressao.outraImpressao(already.idempotency_fingerprint, input.impressao)) {
        throw Impressao.chaveReusada(`o movimento de estoque "${input.referenceId}"`, {
          referenceId: input.referenceId,
        });
      }
      return { balance: already.balance_after, duplicated: true };
    }

    const delta = signedDelta(input.movementType, input.quantity);
    const now = new Date().toISOString();

    /*
      O LOCAL É RESOLVIDO AQUI, e não deixado em NULL para o relatório
      adivinhar depois.

      Só para SAÍDA: entrada sem local declarado continua caindo no padrão
      pelo COALESCE da leitura, que é o que mantém legível o movimento
      gravado antes desta coluna existir. E só quando o chamador NÃO diz:
      a rota de movimento manual existe para o operador declarar o que
      aconteceu na prateleira, e o sistema não corrige a escolha dele.
    */
    const locationId =
      input.locationId ?? (delta < 0 ? localDaSaida(input.companyId, input.productId, Math.abs(delta)) : null);

    /*
      O ACOPLAMENTO COM AS UNIDADES SERIALIZADAS MORA AQUI, E SÓ AQUI.

      Este é o único escritor de `core_stock.quantity` no projeto. Pôr o guard
      neste ponto é o que garante que nenhum caminho — venda, devolução,
      transferência, OS, entrada de nota, rota manual — consiga mover saldo de
      um produto serializado sem dizer QUAIS peças se moveram.

      Vem DEPOIS do desvio de idempotência lá em cima: movimento repetido não
      pode virar status de unidade de novo. E vem ANTES da escrita do saldo,
      na mesma transação — o rollback que desfaz o saldo desfaz o status.

      A ausência de `unitIds` num produto serializado é RECUSA, nunca um
      padrão silencioso: escolher a unidade por conta própria aqui esconderia
      a decisão de quem lê o código. Quem quer FIFO chama `pickUnitsFifo` no
      próprio chamador, à vista.
    */
    const serializado = isSerialized(input.companyId, input.productId);
    if (serializado) {
      if (!Number.isInteger(input.quantity)) {
        throw new ApiError(
          'CORE_SERIALIZED_FRACTIONAL',
          'Produto controlado por unidade não aceita quantidade fracionada.',
          400,
        );
      }
      // Em MÓDULO por causa do 'adjust': a baixa de unidade chama com −1 e
      // uma unitId. ('in'/'out' negativos nem chegam aqui — a recusa na porta
      // do `applyMovement` os barra antes.)
      const esperado = Math.abs(input.quantity);
      const unitIds = input.unitIds ?? [];
      if (unitIds.length !== esperado) {
        throw new ApiError(
          'CORE_UNITS_REQUIRED',
          `Este produto é controlado por unidade: informe exatamente ${esperado} ` +
            `unidade(s). Vieram ${unitIds.length}.`,
          400,
          { productId: input.productId, esperado, recebido: unitIds.length },
        );
      }

      if (delta < 0) {
        assertUnitsSellable(input.companyId, input.productId, unitIds);

        // A MOTO SEGURADA PARA OUTRO CLIENTE NÃO SAI NO BALCÃO (GAP-PRD-111).
        // Só na venda: a pré-venda que converte já soltou as reservas dela, e
        // baixa ou transferência não entregam a moto a ninguém.
        if (input.referenceType === 'sale') exigirUnidadesLivres(input.companyId, unitIds);

        // ANTES de baixar, e não depois: recusar com o saldo já escrito
        // significaria desfazer, e o caminho de desfazer a plaquinha é
        // justamente o que esta rodada descobriu não existir.
        //
        // Toda saída passa por aqui, mas só a VENDA DE BALCÃO chega a ser
        // recusada: a referência vai junto justamente para que a função possa
        // separar. Baixa e transferência liberam, e o porquê de cada uma está
        // escrito lá dentro — a moto batida sai do estoque, e a moto que muda de
        // prateleira nem chega a sair.
        assertUnidadesComPlaquinhaVendiveis({
          companyId: input.companyId,
          unitIds,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        });

        /*
          QUEM DECIDE É A REFERÊNCIA, e não o tipo do movimento.

          Aqui estava `input.movementType === 'out' ? 'sold' : 'baixada'`, com o
          comentário certo logo acima — "saída por ajuste ou perda não é venda".
          Só que `movementType` não separa nada: venda de balcão, ajuste manual,
          perda e consumo de peça em OS são TODOS `'out'`.

          O efeito era uma PLAQUINHA CONGELADA. A unidade ficava `sold`, e aí
          nem `venderPelaUnidade` rodava (a referência não é venda) nem
          `baixarPelaUnidade` (o status não era `baixada`). O `equipment_id`
          continuava apontando para a plaquinha, `plaquinhasVinculaveis` a
          excluía e `desvincularUnidade` recusava soltá-la — a moto sumia da
          lista de adotáveis com a mensagem "já foi vendida", para uma moto que
          ninguém vendeu. Só saía mexendo no banco à mão.

          A transferência fica de fora porque ali a unidade NÃO sai: ela volta
          na perna de entrada, e soltar a plaquinha no meio do caminho a
          desamarraria de uma moto que só mudou de prateleira.

          Referência desconhecida cai em `baixada`, e isso é escolha: plaquinha
          solta se vincula de novo em dois cliques; plaquinha congelada, não.
        */
        const ehVenda = REFERENCIAS_QUE_DAO_DONO.has(input.referenceType);
        const statusDaSaida =
          ehVenda || SAIDAS_DE_PASSAGEM.has(input.referenceType) ? 'sold' : 'baixada';

        markUnitsOut(input.companyId, unitIds, {
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          status: statusDaSaida,
        });

        // Só VENDA carimba dono na plaquinha — ver `REFERENCIAS_QUE_DAO_DONO`
        // em `EquipmentStockLink.ts`, que é onde cada exclusão está
        // justificada. Depois de `markUnitsOut` para que a plaquinha só mude com
        // a unidade já fora do estoque, e na mesma transação para que as duas
        // afirmações nunca divirjam.
        if (ehVenda) {
          venderPelaUnidade({
            companyId: input.companyId,
            unitIds,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            userId: input.userId ?? null,
          });
        }

        /*
          A BAIXA SOLTA A PLAQUINHA, E PENDURA-SE AQUI PELO MESMO MOTIVO QUE A VENDA.

          `POST /units/:id/write-off` deixava a unidade `baixada` com
          `equipment_id` ainda apontando para a plaquinha, e ninguém desfazia o
          vínculo. O resultado era uma plaquinha CONGELADA: `plaquinhasVinculaveis`
          exclui toda plaquinha que tenha unidade apontando para ela, e
          `desvincularUnidade` recusa soltar unidade que não está em estoque. A
          moto sumia da lista de adotáveis e a única saída era mexer no banco à mão.

          A condição é o STATUS GRAVADO, e não a referência: é ele que diz se a
          moto saiu vendida ou baixada, e é a mesma decisão que `markUnitsOut`
          acabou de escrever na unidade. Derivar de novo da referência criaria uma
          segunda regra sobre o mesmo fato, livre para divergir da primeira.

          `baixarPelaUnidade` decide por ESTADO e ignora as referências que dão
          dono, então chamar as duas na mesma saída nunca desamarra o que a venda
          acabou de amarrar — e unidade sem plaquinha simplesmente não faz nada.
        */
        if (statusDaSaida === 'baixada') {
          baixarPelaUnidade({
            companyId: input.companyId,
            unitIds,
            referenceType: input.referenceType,
            userId: input.userId ?? null,
          });
        }
      } else {
        markUnitsIn(input.companyId, unitIds, locationId);

        // A volta NÃO é filtrada por referência, e a assimetria é proposital:
        // quem estorna é o cancelamento, a devolução ou um acerto de entrada, e
        // nenhum deles sabe se aquela unidade chegou a ter dono.
        // `devolverPelaUnidade` decide pelo ESTADO da plaquinha — unidade que
        // nunca foi vendida simplesmente não faz nada, em vez de derrubar o
        // estorno inteiro por causa de uma moto que nem plaquinha tinha.
        devolverPelaUnidade({
          companyId: input.companyId,
          unitIds,
          userId: input.userId ?? null,
        });
      }
    } else if (input.unitIds && input.unitIds.length > 0) {
      // Chamada que parece funcionar e não faz nada é pior que erro.
      throw new ApiError(
        'CORE_UNITS_NOT_APPLICABLE',
        'Este produto não é controlado por unidade.',
        400,
      );
    }

    /*
      ================================================================
      DE QUAL LOTE — a dimensão de validade do razão (GAP-V35)
      ================================================================

      Tudo abaixo só acontece para produto com `tracks_batches = 1`. Para todo o
      resto do catálogo — que é quase todo ele — este bloco é um `if` falso e
      uma coluna nula, e essa é a regra dura do módulo: quem não usa não sente.

      A escolha vem DEPOIS do desvio de idempotência lá em cima (movimento
      repetido não escolhe lote de novo) e ANTES da escrita do saldo, na MESMA
      transação — o rollback que desfaz o saldo desfaz a escolha do lote.

      A recusa por lote vencido acontece AQUI e não depois: recusar com o saldo
      já escrito significaria desfazer, e desfazer é o caminho que esta casa
      aprendeu a não ter.
    */
    const controlaLote = dono.tracks_batches === 1;
    let batchId: string | null = null;
    if (controlaLote) {
      if (input.batchId) {
        /*
          Lote nomeado pelo chamador. A DIREÇÃO importa nas duas perguntas que
          `assertBatchUsable` faz além do tenant:

          - saldo só se cobra na SAÍDA (na entrada o lote está recebendo);
          - VALIDADE também só na saída, e isso é decisão. Receber mercadoria
            num lote já vencido é legítimo e acontece: é a caixa que chegou
            vencida do fornecedor, e o sistema precisa conseguir REGISTRAR isso
            para que ela apareça no relatório e volte para quem a mandou.
            Recusar a entrada empurraria o conferente a lançar sem lote — e a
            mercadoria vencida sumiria do único lugar que a mostra.
        */
        assertBatchUsable({
          companyId: input.companyId,
          productId: input.productId,
          batchId: input.batchId,
          quantity: Math.abs(delta),
          direction: delta < 0 ? 'out' : 'in',
          referenceType: input.referenceType,
        });
        batchId = input.batchId;
      } else if (delta < 0 && !input.semLote) {
        /*
          FEFO: o que vence primeiro sai primeiro, e a escolha fica GRAVADA no
          movimento. Sem gravá-la, o saldo por lote seria uma opinião — dois
          relatórios rodando em dias diferentes chegariam a lotes diferentes
          para a mesma venda de ontem.
        */
        batchId = pickBatchFefo({
          companyId: input.companyId,
          productId: input.productId,
          quantity: Math.abs(delta),
          referenceType: input.referenceType,
        });
      }
      // ENTRADA sem lote declarado cai no balde, de propósito: é o que a nota
      // fiscal produz, e nomeá-lo como pendência é melhor que recusar a
      // entrada da mercadoria na doca.
    } else if (input.batchId) {
      // Chamada que parece funcionar e não faz nada é pior que erro — o mesmo
      // desenho de `CORE_UNITS_NOT_APPLICABLE` logo acima.
      throw new ApiError(
        'CORE_BATCH_NOT_APPLICABLE',
        `"${dono.name}" não controla lote e validade.`,
        400,
        { productId: input.productId },
      );
    }

    /*
      O SALDO DO LOTE ANTES, pelo mesmo motivo do saldo do produto: a linha do
      histórico tem de fechar a conta sozinha. Uma consulta a mais, e só para
      quem controla lote.
    */
    const batchQuantityBefore = controlaLote
      ? ((
          db
            .prepare(
              `SELECT COALESCE(SUM(quantity), 0) AS saldo FROM core_stock_movements
                WHERE company_id = ? AND product_id = ?
                  AND (batch_id = ? OR (? IS NULL AND batch_id IS NULL))`,
            )
            .get(input.companyId, input.productId, batchId, batchId) as { saldo: number }
        ).saldo)
      : null;

    // Saldo ANTES, lido dentro da mesma transação. É o que faz a conta fechar
    // no histórico: anterior + delta = posterior.
    const antes = getConnection()
      .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(input.companyId, input.productId) as
      | { quantity: number; reserved: number }
      | undefined;
    const quantityBefore = antes?.quantity ?? 0;
    const reservedBefore = antes?.reserved ?? 0;

    // Duas etapas em vez de um upsert com o delta: o SQLite avalia o CHECK da
    // coluna sobre a linha candidata ANTES de resolver o ON CONFLICT, então
    // inserir um delta negativo violaria `quantity >= 0` mesmo quando o saldo
    // final seria positivo. Garantimos a linha com saldo zero e só então
    // aplicamos o delta — aí o CHECK incide sobre o resultado, que é o que
    // queremos proteger.
    db.prepare(
      `INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at)
       VALUES (?, ?, 0, 0, ?)
       ON CONFLICT (company_id, product_id) DO NOTHING`,
    ).run(input.companyId, input.productId, now);

    try {
      db.prepare(
        `UPDATE core_stock SET quantity = quantity + ?, updated_at = ?
          WHERE company_id = ? AND product_id = ?`,
      ).run(delta, now, input.companyId, input.productId);
    } catch (err) {
      // Violação do CHECK (quantity >= 0): não há saldo suficiente.
      if (String(err).includes('CHECK')) {
        throw new ApiError(
          'CORE_INSUFFICIENT_STOCK',
          'Estoque insuficiente para concluir a operação.',
          409,
          { productId: input.productId, requested: Math.abs(delta) },
        );
      }
      throw err;
    }

    const balance = getBalance(input.companyId, input.productId);

    // O id é gerado antes do INSERT porque o evento da central precisa
    // referenciar exatamente esta linha: o mesmo fato tem a mesma identidade
    // nos dois bancos.
    const movementId = randomUUID();

    db.prepare(
      `INSERT INTO core_stock_movements
         (id, company_id, product_id, movement_type, kind, quantity, quantity_before,
          reserved_before, reserved_delta, reserved_after, unit_cost_cents,
          reference_type, reference_id, document_number, workshop_id,
          balance_after, user_id, reason, note, location_id,
          batch_id, batch_quantity_before, batch_balance_after, created_at, idempotency_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      movementId,
      input.companyId,
      input.productId,
      input.movementType,
      input.kind ?? inferKind(input.referenceType, input.movementType, delta),
      delta,
      quantityBefore,
      reservedBefore,
      // Movimento de saldo físico não mexe na reserva.
      reservedBefore,
      input.unitCostCents ?? null,
      input.referenceType,
      input.referenceId,
      input.documentNumber ?? null,
      input.workshopId ?? null,
      balance,
      input.userId ?? null,
      input.reason ?? null,
      input.note ?? null,
      locationId,
      batchId,
      /*
        A IDENTIDADE DO LOTE, gravada na linha: anterior + delta = posterior,
        exatamente como no par do produto. Nulo para quem não controla lote —
        duas colunas de nada em toda linha do histórico não ajudariam ninguém.
      */
      batchQuantityBefore,
      batchQuantityBefore === null ? null : batchQuantityBefore + delta,
      new Date().toISOString(),
      input.impressao ?? null,
    );

    // Fato para a central, na MESMA transação. Se o saldo estourar o CHECK
    // logo acima, o rollback leva o evento junto — a central nunca vê um
    // movimento que o estoque recusou.
    recordDomainEvent({
      eventType: 'inventory.moved',
      aggregateType: 'inventory_movement',
      aggregateId: movementId,
      companyId: input.companyId,
      operationalUnitId: input.workshopId ?? null,
      payload: {
        id: movementId,
        product_id: input.productId,
        movement_type: input.movementType,
        quantity: delta,
        quantity_before: quantityBefore,
        balance_after: balance,
        reference_type: input.referenceType,
        reference_id: input.referenceId,
        document_number: input.documentNumber ?? null,
        unit_cost_cents: input.unitCostCents ?? null,
        // `location_id` NÃO vai para a central, e isso é decisão, não
        // esquecimento: `erp_inventory_ledger` é tabela remota que não dá para
        // inspecionar nem migrar daqui, e mandar coluna que lá não existe
        // derrubaria a sincronia de TODO movimento. O local é organização
        // interna da loja — prateleira, corredor —, não fato consolidado.
        // Quando a central for acessível, entra aqui, no `Projector` e no
        // espelho do bootstrap, nesta ordem.
      },
    });

    return { balance, duplicated: false };
  });
}

/** Saldo realmente vendável: o que existe menos o que está reservado. */
export function getAvailable(companyId: string, productId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number } | undefined;
  if (!row) return 0;
  return row.quantity - row.reserved;
}

/**
 * Reserva estoque para um pedido ainda não pago.
 *
 * A reserva NÃO baixa o estoque — ela impede que a mesma peça seja prometida
 * duas vezes enquanto o pagamento não confirma. O CHECK `reserved >= 0` e a
 * verificação de disponível são o que impedem vender mais do que existe.
 */
export function reserveStock(input: {
  companyId: string;
  productId: string;
  quantity: number;
  kind?: MovementKind;
  referenceType?: string;
  referenceId?: string;
  documentNumber?: string | null;
  userId?: string | null;
}): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();

    /*
      A MESMA PROMESSA NÃO É FEITA DUAS VEZES.

      `applyMovement` sempre teve este pré-cheque; a reserva não tinha. A UNIQUE
      do razão pegava o caso, mas como violação CRUA de constraint — 500 sem
      mensagem, num caminho em que o certo é não fazer nada. Reenviar a mesma
      requisição é comum (rede ruim, clique duplo), e a resposta correta é
      "isto já está reservado", não uma pilha de erro.
    */
    if (input.referenceType && input.referenceId) {
      const jaExiste = db
        .prepare(
          `SELECT 1 FROM core_stock_movements
            WHERE company_id = ? AND reference_type = ? AND reference_id = ?
              AND product_id = ? AND movement_type = 'reserve'`,
        )
        .get(input.companyId, input.referenceType, input.referenceId, input.productId);
      if (jaExiste) return;
    }

    const available = getAvailable(input.companyId, input.productId);
    if (available < input.quantity) {
      throw new ApiError(
        'CORE_INSUFFICIENT_STOCK',
        'Estoque insuficiente para reservar.',
        409,
        { productId: input.productId, available, requested: input.quantity },
      );
    }
    const antes = currentStock(input.companyId, input.productId);
    db.prepare(
      `UPDATE core_stock SET reserved = reserved + ?, updated_at = ?
        WHERE company_id = ? AND product_id = ?`,
    ).run(input.quantity, new Date().toISOString(), input.companyId, input.productId);

    recordReservationMovement({
      ...input,
      kind: input.kind ?? 'PRE_SALE_RESERVATION',
      reservedDelta: input.quantity,
      antes,
    });
  });
}

/** Libera reserva (pedido cancelado / expirado). */
export function releaseReservation(input: {
  companyId: string;
  productId: string;
  quantity: number;
  kind?: MovementKind;
  referenceType?: string;
  referenceId?: string;
  documentNumber?: string | null;
  userId?: string | null;
  /**
   * Por que a reserva caiu, quando foi GENTE que a soltou (GAP-PRD-087). As
   * liberações automáticas (pedido expirado, pré-venda cancelada) têm a origem
   * como explicação e não passam motivo.
   */
  reason?: string | null;
}): void {
  ensureCoreSchema();
  const db = getConnection();
  const row = db
    .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(input.companyId, input.productId) as { reserved: number } | undefined;
  if (!row) return;
  const antes = currentStock(input.companyId, input.productId);
  // Nunca deixa a reserva negativa, mesmo se chamada duas vezes.
  const next = Math.max(0, row.reserved - input.quantity);
  db.prepare(
    'UPDATE core_stock SET reserved = ?, updated_at = ? WHERE company_id = ? AND product_id = ?',
  ).run(next, new Date().toISOString(), input.companyId, input.productId);

  // A liberação só entra no histórico se algo mudou de fato: chamar duas vezes
  // não gera duas linhas dizendo que a mercadoria voltou duas vezes.
  if (next !== row.reserved) {
    recordReservationMovement({
      ...input,
      kind: input.kind ?? 'PRE_SALE_RELEASE',
      reservedDelta: next - row.reserved,
      antes,
    });
  }
}

function currentStock(
  companyId: string,
  productId: string,
): { quantity: number; reserved: number } {
  const row = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number } | undefined;
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0 };
}

/**
 * Registra reserva/liberação na razão.
 *
 * O saldo FÍSICO não muda: `quantity` entra com delta 0 e `balance_after` é o
 * mesmo de antes. O que muda é `reserved`. Assim o gestor vê o evento no
 * histórico sem que o relatório de estoque passe a mentir sobre o que está na
 * prateleira.
 *
 * A direção é `reserve`/`release`, não `adjust`: são eixos diferentes, e usar
 * `adjust` faria a linha de reserva colidir com a chave de idempotência do
 * saldo físico para o mesmo documento. Além de correto, deixa a coluna de
 * direção legível — o gestor vê "reserva", não "ajuste".
 */
function recordReservationMovement(input: {
  companyId: string;
  productId: string;
  kind: MovementKind;
  reservedDelta: number;
  antes: { quantity: number; reserved: number };
  referenceType?: string;
  referenceId?: string;
  documentNumber?: string | null;
  userId?: string | null;
  reason?: string | null;
}): void {
  const movementId = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_stock_movements
         (id, company_id, product_id, movement_type, kind, quantity, quantity_before,
          reserved_before, reserved_delta, reserved_after, reference_type, reference_id,
          document_number, balance_after, user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      movementId,
      input.companyId,
      input.productId,
      input.reservedDelta >= 0 ? 'reserve' : 'release',
      input.kind,
      input.antes.quantity,
      input.antes.reserved,
      input.reservedDelta,
      input.antes.reserved + input.reservedDelta,
      input.referenceType ?? 'reserva',
      input.referenceId ?? randomUUID(),
      input.documentNumber ?? null,
      input.antes.quantity,
      input.userId ?? null,
      input.reason ?? null,
      new Date().toISOString(),
    );

  // Reserva também é fato para a central: sem ela, o disponível consolidado
  // ficaria maior que o real e o site anunciaria peça já comprometida.
  recordDomainEvent({
    eventType: input.reservedDelta >= 0 ? 'inventory.reserved' : 'inventory.reservation_released',
    aggregateType: 'inventory_reservation',
    aggregateId: movementId,
    companyId: input.companyId,
    payload: {
      id: movementId,
      product_id: input.productId,
      reserved_delta: input.reservedDelta,
      reserved_before: input.antes.reserved,
      reserved_after: input.antes.reserved + input.reservedDelta,
      quantity: input.antes.quantity,
      kind: input.kind,
      reference_type: input.referenceType ?? 'reserva',
      reference_id: input.referenceId ?? null,
    },
  });
}

/**
 * Converte reserva em saída definitiva: libera a reserva e baixa o estoque,
 * na mesma transação. É o passo do pagamento confirmado — e como usa o ledger
 * comum, a baixa continua acontecendo uma única vez por referência.
 */
export function consumeReservation(input: {
  companyId: string;
  productId: string;
  quantity: number;
  referenceType: string;
  referenceId: string;
  /** Semântica da BAIXA. A liberação da reserva é rotulada em separado. */
  kind?: MovementKind;
  /**
   * Semântica da LIBERAÇÃO que acompanha a baixa. Explícita quando o chamador
   * sabe de onde vem; sem ela, deduz-se da referência — e a dedução só conhece
   * as origens que existiam antes de haver um parâmetro.
   */
  releaseKind?: MovementKind;
  documentNumber?: string | null;
  userId?: string | null;
  note?: string;
  /**
   * O custo unitário da mercadoria que saiu, para o razão (GAP-PRD-101). Quem
   * conhece o momento do custo é quem chama — a peça da OS fotografa o custo
   * do cadastro na baixa. Ausente, a saída sai sem custo, como sempre saiu.
   */
  unitCostCents?: number;
}): void {
  ensureCoreSchema();
  withTransaction(() => {
    // A reserva sai como "consumida", não como "liberada": a mercadoria não
    // voltou para a prateleira, ela foi embora com o cliente.
    releaseReservation({
      ...input,
      kind:
        input.releaseKind
        ?? (input.referenceType === 'ecommerce_order'
          ? 'ECOMMERCE_CONSUMPTION'
          : 'PRE_SALE_CONSUMPTION'),
    });
    // Aqui NÃO há operador para escolher a peça: quem separa o pedido no
    // depósito pega a que está na frente. A escolha é do sistema, e por isso
    // está escrita à vista em vez de escondida dentro do `applyMovement`.
    const unidades = isSerialized(input.companyId, input.productId)
      ? pickUnitsFifo(input.companyId, input.productId, Math.abs(input.quantity))
      : undefined;

    applyMovement({
      companyId: input.companyId,
      productId: input.productId,
      movementType: 'out',
      quantity: input.quantity,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      kind: input.kind,
      documentNumber: input.documentNumber,
      userId: input.userId,
      note: input.note,
      unitIds: unidades,
      unitCostCents: input.unitCostCents,
    });
  });
}

export interface StockListItem {
  product_id: string;
  internal_code: string;
  name: string;
  unit: string;
  quantity: number;
  reserved: number;
  min_stock: number;
  price_cents: number;
  cost_cents: number;
  /**
   * Saldo × custo do cadastro, em centavos INTEIROS, arredondado no servidor.
   * Ver `SQL_VALOR_DO_ITEM`: a tela não refaz a multiplicação, senão a linha
   * e o rodapé divergiriam no primeiro produto de quantidade fracionada.
   */
  value_cents: number;
  /**
   * Vem do SERVIDOR, e a tela não recalcula. Cada tela que refazia a conta
   * chegava a um resultado diferente — foi assim que as três definições de
   * "abaixo do mínimo" nasceram.
   */
  below_minimum: number;
}

/**
 * ABAIXO DO MÍNIMO — uma definição só, para a mesma pergunta.
 *
 * Havia TRÊS respostas diferentes convivendo, e a mais grave era a do filtro
 * de posição de estoque, que olhava o saldo BRUTO com `<=`: produto sem
 * mínimo declarado (`min_stock = 0`) e sem saldo entrava na lista de "está
 * acabando", porque 0 <= 0. Quem abre essa tela para saber o que comprar
 * recebia o catálogo inteiro de itens zerados junto do que realmente falta —
 * e um alerta que lista tudo não aponta nada.
 *
 * A régua certa tem duas metades:
 *
 *   MÍNIMO MAIOR QUE ZERO. Zero não é "mínimo zero", é "ninguém declarou
 *   mínimo". Tratar como piso faria o sistema opinar sobre produto que a loja
 *   nunca disse que quer manter em estoque.
 *
 *   O QUE CONTA É O DISPONÍVEL, não o bruto. Peça prometida a uma OS está na
 *   prateleira e não pode ser usada em outra coisa — contá-la como saldo
 *   adiaria a compra até o dia em que o mecânico abre a gaveta e não tem.
 *
 * O SQL e a função em TypeScript ficam lado a lado porque são a MESMA regra
 * escrita para dois leitores diferentes; separá-las é como as três versões
 * anteriores nasceram.
 */
export const SQL_ABAIXO_DO_MINIMO =
  'p.min_stock > 0 AND (COALESCE(s.quantity, 0) - COALESCE(s.reserved, 0)) < p.min_stock';

export function abaixoDoMinimo(disponivel: number, minStock: number): boolean {
  return Number(minStock) > 0 && Number(disponivel) < Number(minStock);
}

/**
 * QUANTO VALE cada item — saldo × custo, decidido num lugar só.
 *
 * O custo é o DO CADASTRO (`core_products.cost_cents` de agora), e não um
 * custo médio ponderado. É decisão declarada, não atalho: custo médio exigiria
 * reconstruir o histórico de entradas — que nem sempre carrega custo — e
 * produziria um número com cara de contabilidade sem sê-lo. O que este valor
 * responde é "quanto custaria repor a prateleira hoje, pelo último custo
 * conhecido", e a tela repete isso em palavras.
 *
 * DINHEIRO É CENTAVO INTEIRO. Quantidade pode ser fracionada (0,5 kg), e
 * 0,5 × 333 daria 166,5 centavos — um valor que não existe. O arredondamento
 * acontece POR ITEM, aqui no SQL, e o total é a soma dos itens já
 * arredondados: é o que faz o rodapé bater com a soma da coluna, sempre. A
 * expressão vive numa constante pelo mesmo motivo de `SQL_ABAIXO_DO_MINIMO` —
 * a linha da posição e o total da empresa são a MESMA conta, e duas cópias
 * divergiriam no primeiro ajuste.
 */
export const SQL_VALOR_DO_ITEM =
  'CAST(ROUND(COALESCE(s.quantity, 0) * p.cost_cents) AS INTEGER)';

export interface StockValuation {
  /** Soma de saldo × custo (pela régua escolhida), arredondado por item. */
  totalCents: number;
  /** Quantos produtos têm saldo — o número que se confere contra a prateleira. */
  produtosComSaldo: number;
  /** A régua que produziu o total (GAP-PRD-166). */
  regua?: ReguaDeValorizacao;
  /** Custo médio: produtos com saldo sem nenhuma entrada com custo no razão. */
  semCustoNoRazao?: number;
}

/** Valor do estoque da empresa inteira. Sempre filtrado pelo tenant da sessão. */
export function stockValuation(companyId: string): StockValuation {
  ensureCoreSchema();
  /*
    CUSTO MÉDIO: o total é a soma das linhas JÁ valorizadas pela régua — a mesma
    conta de `listStock`, para o rodapé e a coluna continuarem batendo.
  */
  if (politicaDeGestao(companyId).reguaDeValorizacao === 'custo_medio') {
    const base = getConnection()
      .prepare(
        `SELECT p.id AS product_id, COALESCE(s.quantity, 0) AS quantity, p.cost_cents,
                ${SQL_VALOR_DO_ITEM} AS value_cents
           FROM core_products p
           LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
          WHERE p.company_id = ? AND p.active = 1 AND p.stock_control = 1`,
      )
      .all(companyId) as unknown as { product_id: string; quantity: number; cost_cents: number; value_cents: number }[];
    const r = aplicarRegua(companyId, base);
    return {
      totalCents: r.linhas.reduce((s, l) => s + l.value_cents, 0),
      produtosComSaldo: base.filter((l) => Number(l.quantity) > 0).length,
      regua: r.regua,
      semCustoNoRazao: r.semCustoNoRazao,
    };
  }
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(${SQL_VALOR_DO_ITEM}), 0) AS total_cents,
              COALESCE(SUM(CASE WHEN COALESCE(s.quantity, 0) > 0 THEN 1 ELSE 0 END), 0)
                AS produtos_com_saldo
         FROM core_products p
         LEFT JOIN core_stock s
           ON s.product_id = p.id AND s.company_id = p.company_id
        WHERE p.company_id = ? AND p.active = 1
          AND p.stock_control = 1`,
    )
    .get(companyId) as { total_cents: number; produtos_com_saldo: number };
  return {
    totalCents: row.total_cents,
    produtosComSaldo: row.produtos_com_saldo,
    regua: 'ultimo_custo',
    semCustoNoRazao: 0,
  };
}

/**
 * Posição de estoque da empresa. Sempre filtrada pelo tenant da sessão.
 *
 * O SERVIÇO DE BALCÃO FICA DE FORA (GAP-V02): quem não controla estoque não tem
 * posição de estoque. Deixá-lo entrar poria "Instalação de película — 0 un" na
 * tela da conferência e na conta do valor do estoque, com um zero que nunca vai
 * mudar e que a pessoa passaria a conferir todo mês. A regra é a MESMA que a
 * venda e a contagem consultam — `stock_control`.
 */
export function listStock(companyId: string, options: { lowOnly?: boolean; search?: string } = {}): StockListItem[] {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = `SELECT p.id AS product_id, p.internal_code, p.name, p.unit,
                    COALESCE(s.quantity, 0) AS quantity,
                    COALESCE(s.reserved, 0) AS reserved,
                    p.min_stock, p.price_cents, p.cost_cents,
                    ${SQL_VALOR_DO_ITEM} AS value_cents,
                    CASE WHEN ${SQL_ABAIXO_DO_MINIMO} THEN 1 ELSE 0 END AS below_minimum
               FROM core_products p
               LEFT JOIN core_stock s
                 ON s.product_id = p.id AND s.company_id = p.company_id
              WHERE p.company_id = ? AND p.active = 1
                AND p.stock_control = 1`;
  if (options.search) {
    sql += ' AND (p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?)';
    params.push(`%${options.search}%`, `%${options.search}%`, options.search);
  }
  if (options.lowOnly) sql += ` AND ${SQL_ABAIXO_DO_MINIMO}`;
  sql += ' ORDER BY p.name';
  const linhas = getConnection().prepare(sql).all(...(params as never[])) as unknown as StockListItem[];
  /*
    A RÉGUA ESCOLHIDA PELO DONO (GAP-PRD-166). Com 'ultimo_custo' (o padrão)
    nada muda — `value_cents` é o do SQL acima. Com 'custo_medio', o valor da
    linha é refeito pela média móvel do razão, e `valuation_cost_cents` diz qual
    custo a régua usou. É aqui, e não na rota, para a posição, o painel e os
    relatórios da Central valorizarem pela MESMA régua.
  */
  return aplicarRegua(companyId, linhas).linhas;
}

export interface MovementRow {
  id: string;
  product_id: string;
  product_name: string;
  internal_code: string;
  movement_type: string;
  kind: string | null;
  kind_label: string;
  quantity: number;
  quantity_before: number | null;
  reserved_delta: number;
  reserved_after: number | null;
  reference_type: string;
  reference_id: string;
  document_number: string | null;
  balance_after: number;
  unit_cost_cents: number | null;
  user_id: string | null;
  user_name: string | null;
  reason: string | null;
  note: string | null;
  /** De qual lote saiu / em qual entrou. Nulo é o normal — ver `batchId`. */
  batch_id: string | null;
  /** O código legível do lote, para a tela não mostrar um id técnico. */
  batch_code: string | null;
  batch_expires_on: string | null;
  batch_quantity_before: number | null;
  batch_balance_after: number | null;
  created_at: string;
}

export interface MovementFilters {
  productId?: string;
  /** O razão de UM lote — é o que a tela de Validade abre ao clicar na linha. */
  batchId?: string;
  /** Um tipo semântico, ou vários. */
  kind?: string | string[];
  from?: string;
  to?: string;
  documentNumber?: string;
  userId?: string;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * Mecânico não vê custo. Ele precisa saber o que tem e por quanto revende —
   * quanto a empresa pagou no fornecedor não é assunto dele.
   */
  hideCost?: boolean;
}

/**
 * Histórico de estoque para a tela do gestor.
 *
 * Traz o nome do produto e de quem lançou junto, porque uma tabela de ids não
 * é história que alguém consiga ler.
 */
export function listMovements(companyId: string, options: MovementFilters = {}): MovementRow[] {
  ensureCoreSchema();
  const filtro = filtroDosMovimentos(companyId, options);
  /*
    O `limit` daqui não tem teto: a Central de relatórios lê o razão com o
    teto DELA. O teto de página da tela (500) mora na rota, que é a porta de
    fora (GAP-PRD-070).
  */
  const sql = `
    SELECT m.*,
           p.name          AS product_name,
           p.internal_code AS internal_code,
           u.display_name  AS user_name,
           -- O CÓDIGO do lote, e não só o id: a linha do histórico é lida por
           -- gente que tem a embalagem na mão, e nela está impresso o código.
           b.code          AS batch_code,
           b.expires_on    AS batch_expires_on
      FROM core_stock_movements m
      JOIN core_products p ON p.id = m.product_id
      LEFT JOIN core_users u ON u.id = m.user_id
      LEFT JOIN core_product_batches b ON b.id = m.batch_id
     WHERE ${filtro.where}
     ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`;
  const params = [...filtro.params, options.limit ?? 200, options.offset ?? 0];

  const rows = getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as MovementRow[];

  return rows.map((row) => ({
    ...row,
    kind_label: MOVEMENT_KIND_LABEL[row.kind as MovementKind] ?? row.movement_type,
    // O custo é removido do resultado, não escondido só na tela: quem não pode
    // ver não recebe o número.
    unit_cost_cents: options.hideCost ? null : row.unit_cost_cents,
  }));
}

/**
 * Quantos movimentos o recorte de `listMovements` tem — o `total` da página.
 *
 * O histórico já andava de página em página, mas não sabia quantas eram: a
 * tela só descobria o fim quando uma página vinha incompleta (GAP-PRD-070).
 */
export function countMovements(companyId: string, options: MovementFilters = {}): number {
  ensureCoreSchema();
  const filtro = filtroDosMovimentos(companyId, options);
  /*
    O histórico é a tabela que mais cresce, e esta contagem roda a cada
    página. Sem busca por produto, ela não precisa do JOIN: anda só pelo
    índice (company_id, …) do próprio movimento. O JOIN não tira linha: o
    produto é chave estrangeira obrigatória, com cascata — ele só é preciso
    quando a busca olha o nome do produto.
  */
  const junta = options.search ? 'JOIN core_products p ON p.id = m.product_id' : '';
  const linha = getConnection()
    .prepare(
      `SELECT COUNT(*) AS total
         FROM core_stock_movements m
         ${junta}
        WHERE ${filtro.where}`,
    )
    .get(...(filtro.params as never[])) as { total: number };
  return Number(linha.total);
}

/** O WHERE do histórico — um só, para a lista e para a contagem. */
function filtroDosMovimentos(
  companyId: string,
  options: MovementFilters,
): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let sql = 'm.company_id = ?';

  if (options.productId) {
    sql += ' AND m.product_id = ?';
    params.push(options.productId);
  }
  if (options.batchId) {
    sql += ' AND m.batch_id = ?';
    params.push(options.batchId);
  }
  if (options.kind) {
    const kinds = Array.isArray(options.kind) ? options.kind : [options.kind];
    sql += ` AND m.kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  // Data na ponta, instante na coluna: os limites da loja fazem a ponte.
  const limitesDaBusca = limitesDoPeriodo(options.from, options.to);
  if (options.from) {
    sql += ' AND m.created_at >= ?';
    params.push(limitesDaBusca.inicio);
  }
  if (options.to) {
    sql += ' AND m.created_at <= ?';
    params.push(limitesDaBusca.fim);
  }
  if (options.documentNumber) {
    sql += ' AND (m.document_number = ? OR m.reference_id = ?)';
    params.push(options.documentNumber, options.documentNumber);
  }
  if (options.userId) {
    sql += ' AND m.user_id = ?';
    params.push(options.userId);
  }
  if (options.search) {
    sql += ' AND (p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?)';
    params.push(`%${options.search}%`, `%${options.search}%`, options.search);
  }
  return { where: sql, params };
}
