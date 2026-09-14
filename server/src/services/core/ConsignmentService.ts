/**
 * ============================================================================
 * CONSIGNAÇÃO / CONDICIONAL — o ciclo, e não um status (GAP-V65)
 * ============================================================================
 *
 * Gringa e Me Mimei mandam roupa "no condicional" todo dia. PJ Motors manda a
 * peça para o mecânico testar antes de comprar. A mercadoria SAI da loja sem
 * venda, volta em parte e é faturada em parte — e até esta rodada o sistema não
 * conhecia nenhum desses três momentos.
 *
 * Os dois contornos que existiam mentem sobre o estoque:
 *
 *   PRÉ-VENDA. Ela RESERVA: diz que a peça continua na arara, prometida a
 *   alguém. A peça está na casa da cliente. E não aceita retorno parcial nem
 *   venda parcial — é tudo ou nada.
 *
 *   O CADERNO. Não diz nada a ninguém, e o estoque diverge em três das seis
 *   empresas do grupo.
 *
 * ============================================================================
 * A REPRESENTAÇÃO, E POR QUE ELA NÃO É UMA RESERVA
 * ============================================================================
 *
 * A mercadoria consignada SAI DO SALDO. `core_stock.quantity` cai, o razão
 * registra `CONSIGNMENT_OUT`, e quem conta a prateleira no fim do mês encontra
 * exatamente o que o sistema diz.
 *
 * A alternativa — reserva de longo prazo — foi CONSIDERADA e recusada, e o
 * motivo tem nome. Nesta casa `reserved` significa uma coisa só: "está aqui,
 * prometida a alguém". É o que a pré-venda faz, o que a peça prometida a uma OS
 * faz e o que a vitrine faz, e nos três casos a mercadoria está fisicamente
 * dentro da loja — é por isso que soltar a reserva devolve mercadoria de
 * verdade ao disponível. Consignada, ela NÃO está dentro da loja.
 *
 * Uma reserva deixaria `quantity` contando peças que estão na casa da cliente.
 * A contagem de inventário — que é o único mecanismo de reconciliação do ERP —
 * acusaria falta todo mês, nas mesmas três empresas, e o operador aprenderia a
 * ignorar a divergência. Esse é literalmente o risco que este gap descreve:
 * "estoque físico divergente do sistema em três das seis empresas". Escolher a
 * reserva seria implementar o problema.
 *
 * O que está com o cliente vive em `core_consignment_items` — quanto saiu,
 * quanto voltou, quanto virou venda. Isso não é estoque da loja: é custódia de
 * terceiro, e tem razão própria.
 *
 * ============================================================================
 * O FATURAMENTO PASSA PELO RETORNO SIMBÓLICO
 * ============================================================================
 *
 * Quando parte da consignação vira venda, a peça JÁ SAIU na remessa. A venda
 * não pode baixá-la de novo — o `CHECK (quantity >= 0)` recusaria, ou pior,
 * havendo saldo de outra origem, a loja contaria a mesma peça duas vezes.
 *
 * O par gravado é RETORNO SIMBÓLICO (+) seguido de VENDA (−), na MESMA
 * transação. Isso não é um truque para zerar o saldo: é a operação fiscal
 * brasileira da consignação, em que o faturamento exige o retorno simbólico da
 * mercadoria antes da nota de venda. O razão passa a falar a língua do
 * contador, e cada linha diz o que de fato aconteceu.
 *
 * ============================================================================
 * O PREÇO É CONGELADO NA REMESSA — E NINGUÉM O DIGITA
 * ============================================================================
 *
 * `unit_price_cents` é o preço VIGENTE no dia da entrega, resolvido pelo
 * servidor (`effectivePriceCents`, já com a tabela do cliente e a promoção do
 * dia). A cliente levou o vestido por R$ 200 e paga R$ 200 — não R$ 240 porque
 * a tabela subiu enquanto a peça estava no armário dela. É o mesmo congelamento
 * do orçamento, e pelo mesmo motivo: quem assinou o papel tem razão na
 * discussão.
 *
 * E é justamente por o preço NÃO vir da tela que este módulo não abre a porta
 * dos fundos que o cabeçalho de `convertQuote` descreve. Lá o risco é "um
 * segundo caminho de escrita de documento SEM ALÇADA": o operador escreve R$
 * 1,00 num documento e o converte. Aqui não existe campo de preço em lugar
 * nenhum — nem na remessa, nem no faturamento. Não há concessão a medir porque
 * não há preço a digitar, e o desconto continua onde tem alçada: no balcão.
 *
 * A concessão CONTINUA sendo medida por `createSale` (preço congelado abaixo do
 * vigente de hoje é concessão, como em qualquer conversão) e vai para a trilha
 * do faturamento. O que não se faz é barrar: a diferença veio do reajuste da
 * tabela, não de quem está no caixa.
 *
 * ============================================================================
 * NÃO CONFUNDIR COM O EQUIPAMENTO CONSIGNADO DA OFICINA
 * ============================================================================
 *
 * `core_equipment` tem um estado 'consignado' que descreve OUTRA coisa: a moto
 * que o cliente deixou na loja para ser vendida por ela. Ali a mercadoria ENTRA
 * na loja e pertence a terceiro; aqui ela SAI da loja e pertence à loja. Os
 * dois nomes coincidem e os fluxos são opostos — este módulo não toca em nada
 * daquele.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { chaveDoFaturamentoDaConsignacao } from './ChavesDoServidor.js';
import { applyMovement, getAvailable } from './InventoryService.js';
import { effectivePriceCents } from './PricingService.js';
import { priceTableForCustomer, produtoControlaEstoque } from './CatalogAuxService.js';
import { createSale, type SalePaymentInput } from './SalesService.js';
import { modeloAtivo } from './produtoVendavel.js';
import { recordAudit } from '../audit/AuditService.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';

export type ConsignmentStatus = 'aberta' | 'fechada';

export interface ConsignmentLineInput {
  productId: string;
  quantity: number;
}

export interface ConsignmentRecord {
  id: string;
  number: number;
  status: ConsignmentStatus;
  customer_id: string;
  valid_until: string | null;
  created_at: string;
}

export interface ConsignmentItemRow {
  id: string;
  product_id: string;
  description: string;
  delivered_qty: number;
  returned_qty: number;
  sold_qty: number;
  unit_price_cents: number;
  /** O que ainda está COM O CLIENTE. Derivado, nunca gravado — ver abaixo. */
  pending_qty: number;
}

/**
 * O PENDENTE É DERIVADO, e nunca uma quarta coluna.
 *
 * Entregue − devolvido − vendido. Guardá-lo criaria um número que pode
 * discordar dos três que o produzem, e o dia em que discordasse seria o dia em
 * que a loja fecharia a consignação com mercadoria ainda na rua. As três
 * colunas de origem têm CHECK no banco; o pendente não precisa de nenhum.
 */
const SQL_PENDENTE = '(i.delivered_qty - i.returned_qty - i.sold_qty)';

function loadConsignacao(companyId: string, id: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_consignments WHERE id = ? AND company_id = ?')
    .get(id, companyId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new ApiError('CORE_CONSIGNMENT_NOT_FOUND', 'Consignação não encontrada.', 404);
  }
  return row;
}

function itensDaConsignacao(companyId: string, id: string): ConsignmentItemRow[] {
  return getConnection()
    .prepare(
      `SELECT i.id, i.product_id, i.description, i.delivered_qty, i.returned_qty, i.sold_qty,
              i.unit_price_cents, ${SQL_PENDENTE} AS pending_qty
         FROM core_consignment_items i
        WHERE i.consignment_id = ? AND i.company_id = ?
        ORDER BY i.description COLLATE NOCASE`,
    )
    .all(id, companyId) as unknown as ConsignmentItemRow[];
}

function exigirAberta(consignacao: Record<string, unknown>): void {
  if (consignacao.status !== 'aberta') {
    throw new ApiError(
      'CORE_CONSIGNMENT_NOT_OPEN',
      `Esta consignação está ${String(consignacao.status)} e não recebe mais movimento.`,
      409,
      { status: consignacao.status },
    );
  }
}

/**
 * As linhas do evento, conferidas contra o que está COM O CLIENTE.
 *
 * A pergunta é a mesma para o retorno e para o faturamento — "isto ainda está
 * lá fora?" — e a resposta tem de ser a mesma nos dois. Duas conferências
 * separadas divergiriam no primeiro ajuste, e a divergência aqui é mercadoria
 * inventada: um retorno maior que a remessa cria saldo do nada.
 */
function conferirContraOPendente(
  companyId: string,
  consignmentId: string,
  linhas: ConsignmentLineInput[],
  verbo: string,
): { item: ConsignmentItemRow; quantity: number }[] {
  if (!linhas?.length) {
    throw new ApiError('CORE_CONSIGNMENT_EMPTY_EVENT', 'Informe ao menos um item.', 400);
  }
  const itens = itensDaConsignacao(companyId, consignmentId);
  const porProduto = new Map(itens.map((i) => [i.product_id, i]));

  // Duas linhas do MESMO produto no mesmo evento somam antes de conferir:
  // conferir uma a uma deixaria passar 3 + 3 contra um pendente de 4.
  const somadas = new Map<string, number>();
  for (const linha of linhas) {
    const quantidade = Number(linha.quantity);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
    }
    somadas.set(linha.productId, (somadas.get(linha.productId) ?? 0) + quantidade);
  }

  return [...somadas].map(([productId, quantity]) => {
    const item = porProduto.get(productId);
    if (!item) {
      throw new ApiError(
        'CORE_CONSIGNMENT_ITEM_NOT_FOUND',
        'Este produto não saiu nesta consignação.',
        409,
        { productId },
      );
    }
    if (quantity > item.pending_qty) {
      throw new ApiError(
        'CORE_CONSIGNMENT_OVER_PENDING',
        `Não dá para ${verbo} ${quantity} de "${item.description}": estão pendentes `
          + `${item.pending_qty} com o cliente.`,
        409,
        { productId, pending: item.pending_qty, requested: quantity },
      );
    }
    return { item, quantity };
  });
}

/**
 * O evento já aconteceu com esta chave?
 *
 * O clique duplo do balcão é o caso comum, e é o mais caro aqui: um retorno
 * parcial repetido devolve ao saldo mercadoria que continua na casa da cliente,
 * e o CHECK do banco só reagiria quando a soma estourasse a remessa — um
 * retorno de 2 em 5 passaria duas vezes caladinho.
 */
function eventoJaRegistrado(
  companyId: string,
  idempotencyKey: string | null | undefined,
): Record<string, unknown> | null {
  if (!idempotencyKey) return null;
  return (
    (getConnection()
      .prepare(
        'SELECT * FROM core_consignment_events WHERE company_id = ? AND idempotency_key = ?',
      )
      .get(companyId, idempotencyKey) as Record<string, unknown> | undefined) ?? null
  );
}

/**
 * O que a chave pediu — a impressão digital do evento (RES-IDEM-VIZ).
 *
 * `eventoJaRegistrado` casava só pela chave, e o reenvio com OUTRO corpo
 * devolvia o evento antigo, calado: a remessa de 3 peças respondia pela de 2,
 * o retorno de 2 pelo de 1, e a chave de uma remessa reusada num retorno
 * respondia "retorno já feito" com o id da remessa. O tipo e a consignação
 * entram na impressão por isso. A mercadoria entra sem ordem; no faturamento,
 * o dinheiro também (forma e valor de cada pagamento) — o mesmo critério da
 * venda que ele cria.
 */
function impressaoDoEvento(input: {
  kind: 'remessa' | 'retorno' | 'venda';
  consignmentId?: string | null;
  customerId?: string | null;
  items: ConsignmentLineInput[];
  payments?: SalePaymentInput[];
}): string {
  return Impressao.impressaoDe({
    tipo: input.kind,
    consignacao: input.consignmentId ?? null,
    cliente: input.customerId ?? null,
    itens: (Array.isArray(input.items) ? input.items : [])
      .map((i) => JSON.stringify([String(i?.productId ?? ''), Impressao.numero(i?.quantity)]))
      .sort(Impressao.porCodigo),
    pagamentos: (Array.isArray(input.payments) ? input.payments : [])
      .map((p) => JSON.stringify([String(p?.method ?? ''), Impressao.inteiro(p?.amountCents)]))
      .sort(Impressao.porCodigo),
  });
}

/** A chave achada com outro pedido é 422, antes de qualquer escrita. */
function recusarSeOutroPedido(jaFeito: Record<string, unknown>, impressao: string): void {
  if (Impressao.outraImpressao(jaFeito.idempotency_fingerprint, impressao)) {
    throw Impressao.chaveReusada(`um evento de consignação (${String(jaFeito.kind)})`, {
      consignmentId: jaFeito.consignment_id,
      eventId: jaFeito.id,
    });
  }
}

function gravarEvento(input: {
  companyId: string;
  consignmentId: string;
  kind: string;
  saleId?: string | null;
  idempotencyKey?: string | null;
  impressao?: string | null;
  detail: unknown;
  userId: string | null;
}): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_consignment_events
         (id, consignment_id, company_id, kind, sale_id, idempotency_key, detail, user_id, created_at,
          idempotency_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.consignmentId,
      input.companyId,
      input.kind,
      input.saleId ?? null,
      input.idempotencyKey ?? null,
      JSON.stringify(input.detail),
      input.userId,
      new Date().toISOString(),
      input.impressao ?? null,
    );
  return id;
}

// --------------------------------------------------------------- a REMESSA

/**
 * Cria a consignação E ENTREGA a mercadoria — os dois no mesmo ato.
 *
 * Não existe rascunho, e isso é decisão. Um estado "criada mas não entregue"
 * seria mercadoria prometida e não retirada, quer dizer: uma reserva — e a
 * reserva é justamente o que este módulo recusa por mentir sobre onde a peça
 * está. No balcão os dois momentos são um só: a cliente está ali levando as
 * roupas enquanto a vendedora digita.
 *
 * ## A CHAVE DE IDEMPOTÊNCIA É OBRIGATÓRIA — e faltava só aqui
 *
 * O DEFEITO: dos TRÊS eventos de estoque deste módulo, a remessa era o único
 * sem chave. `/retorno` e `/faturar` a exigem desde que nasceram, e o
 * argumento delas (ver `eventoJaRegistrado`) vale IGUAL aqui — na verdade
 * vale mais: a remessa não tem CHECK nenhum para segurá-la por baixo. Um
 * reenvio de rede, uma aba duplicada ou qualquer outro cliente HTTP criava
 * DUAS consignações, sob DOIS números, e tirava a mercadoria do saldo DUAS
 * VEZES. A tela protegia com `loading={busy}`, que segura o clique duplo do
 * mesmo navegador e mais nada.
 *
 * O reenvio devolve a consignação que JÁ existe, com `duplicated: true` — a
 * mesma resposta do retorno e do faturamento, para a tela não comemorar uma
 * saída que não aconteceu.
 */
export function criarConsignacao(input: {
  companyId: string;
  userId: string;
  customerId: string;
  sellerId?: string | null;
  items: ConsignmentLineInput[];
  validUntil?: string | null;
  note?: string | null;
  idempotencyKey: string;
}): ConsignmentRecord & { duplicated: boolean } {
  ensureCoreSchema();

  if (!String(input.idempotencyKey ?? '').trim()) {
    throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Chave de idempotência é obrigatória.', 400);
  }

  if (!input.customerId) {
    throw new ApiError(
      'CORE_CONSIGNMENT_CUSTOMER_REQUIRED',
      'Escolha o cliente: mercadoria que sai da loja sem venda precisa ter dono conhecido.',
      400,
    );
  }
  if (!input.items?.length) {
    throw new ApiError('CORE_CONSIGNMENT_EMPTY', 'Informe ao menos um item.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();

    /*
      O REENVIO É CONFERIDO ANTES DE QUALQUER LEITURA DE PREÇO OU DE SALDO.

      Vindo pela mesma chave, a remessa JÁ aconteceu: devolver a consignação
      existente é a resposta verdadeira. Conferir aqui, e não depois, evita o
      caso em que a segunda tentativa toma "estoque insuficiente" justamente
      porque a primeira já tirou a mercadoria.
    */
    const impressao = impressaoDoEvento({ kind: 'remessa', customerId: input.customerId, items: input.items });
    const jaFeito = eventoJaRegistrado(input.companyId, input.idempotencyKey);
    if (jaFeito) {
      recusarSeOutroPedido(jaFeito, impressao);
      const existente = db
        .prepare(
          `SELECT id, number, status, customer_id, valid_until, created_at
             FROM core_consignments WHERE id = ? AND company_id = ?`,
        )
        .get(String(jaFeito.consignment_id), input.companyId) as unknown as
        | ConsignmentRecord
        | undefined;
      if (existente) return { ...existente, duplicated: true };
    }

    const cliente = db
      .prepare('SELECT id, name FROM core_customers WHERE id = ? AND company_id = ?')
      .get(input.customerId, input.companyId) as { id: string; name: string } | undefined;
    if (!cliente) {
      throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
    }

    const consignmentId = randomUUID();
    const number = nextSequenceValue(input.companyId, 'consignacao');
    const tabelaDoCliente = priceTableForCustomer(input.companyId, input.customerId);

    /*
      A PRECIFICAÇÃO INTEIRA ANTES DE QUALQUER SAÍDA — a mesma ordem do
      orçamento, e pela mesma razão: a consignação é recusada pelo QUE ELA É,
      antes de tirar mercadoria da prateleira de ninguém.
    */
    const linhas = input.items.map((item) => {
      const quantidade = Number(item.quantity);
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
      }
      // O tamanho de um modelo INATIVO também fica fora (`modeloAtivo`): a
      // remessa tiraria da prateleira mercadoria que a loja arquivou, e só
      // estouraria no faturamento, com a peça já na casa do cliente.
      const produto = db
        .prepare(
          `SELECT p.id, p.name, p.price_cents, p.category, p.open_price, p.stock_control, p.serialized
             FROM core_products p
            WHERE p.id = ? AND p.company_id = ? AND p.active = 1 AND ${modeloAtivo('p')}`,
        )
        .get(item.productId, input.companyId) as
        | {
            id: string;
            name: string;
            price_cents: number;
            category: string | null;
            open_price?: number;
            stock_control?: number;
            serialized?: number;
          }
        | undefined;
      if (!produto) {
        throw new ApiError(
          'CORE_PRODUCT_NOT_FOUND',
          `Produto não encontrado: ${item.productId}`,
          404,
        );
      }

      /*
        SERVIÇO NÃO SAI DA LOJA PORQUE NUNCA ESTEVE NELA (GAP-V02).

        Ajuste de bainha não vai no condicional. A recusa é explícita porque o
        silêncio seria pior: `applyMovement` baixaria saldo de um produto que
        não tem saldo, e o CHECK derrubaria a remessa inteira com "estoque
        insuficiente" — mandando a vendedora procurar mercadoria que não existe.
      */
      if (!produtoControlaEstoque(produto)) {
        throw new ApiError(
          'CORE_PRODUCT_WITHOUT_STOCK',
          `"${produto.name}" é serviço e não controla estoque: não há o que mandar no `
            + 'condicional.',
          400,
          { productId: produto.id },
        );
      }

      /*
        PRODUTO SERIALIZADO NÃO ENTRA — e a recusa é honesta, não uma lacuna.

        Moto e celular têm identidade própria, e a plaquinha do equipamento
        carrega o DONO da peça. Mandar uma moto no condicional exigiria decidir
        o que acontece com a plaquinha durante a custódia — ela não foi vendida
        (não tem dono) e não está na loja (não é vendível) —, e essa decisão é
        do módulo do equipamento, não deste. Uma consignação que soltasse a
        plaquinha em silêncio deixaria a moto voltar sem vínculo nenhum.

        A recusa diz o caminho que existe: mercadoria de identidade própria sai
        com pré-venda ou com o consignado de equipamento da oficina, que é
        outro conceito e tem tela própria.
      */
      if (produto.serialized === 1) {
        throw new ApiError(
          'CORE_CONSIGNMENT_SERIALIZED',
          `"${produto.name}" é controlado por unidade (chassi/IMEI) e não entra em `
            + 'consignação: a plaquinha diz de quem é a peça, e a remessa não transfere '
            + 'propriedade. Use pré-venda para segurar a unidade.',
          409,
          { productId: produto.id },
        );
      }

      const disponivel = getAvailable(input.companyId, produto.id);
      if (disponivel < quantidade) {
        throw new ApiError(
          'CORE_INSUFFICIENT_STOCK',
          `Estoque insuficiente para "${produto.name}": disponível ${disponivel}.`,
          409,
          { productId: produto.id, available: disponivel },
        );
      }

      // O valor DECLARADO na remessa — ver o cabeçalho: não é o preço da venda.
      const unitPriceCents = effectivePriceCents(
        input.companyId,
        produto.id,
        produto.price_cents,
        produto.category,
        {
          priceTableId: tabelaDoCliente?.id ?? null,
          openPrice: produto.open_price === 1,
        },
      ).priceCents;

      return { produto, quantidade, unitPriceCents };
    });

    db.prepare(
      `INSERT INTO core_consignments
         (id, company_id, number, customer_id, seller_id, status, valid_until, note,
          created_by, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, 'aberta', ?, ?, ?, ?, ?, NULL)`,
    ).run(
      consignmentId,
      input.companyId,
      number,
      input.customerId,
      input.sellerId ?? null,
      input.validUntil ?? null,
      input.note ?? null,
      input.userId,
      now,
      now,
    );

    const itemStmt = db.prepare(
      `INSERT INTO core_consignment_items
         (id, consignment_id, company_id, product_id, description, delivered_qty,
          returned_qty, sold_qty, unit_price_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    );

    let valorTotal = 0;
    for (const linha of linhas) {
      itemStmt.run(
        randomUUID(),
        consignmentId,
        input.companyId,
        linha.produto.id,
        linha.produto.name,
        linha.quantidade,
        linha.unitPriceCents,
      );
      valorTotal += Math.round(linha.unitPriceCents * linha.quantidade);

      /*
        A SAÍDA DE VERDADE. `applyMovement` é o único escritor de
        `core_stock.quantity` do projeto, e é ele quem cobra grade, kit,
        lote e tenant — reimplementar a baixa aqui seria abrir a sexta cópia
        dessas regras.
      */
      applyMovement({
        companyId: input.companyId,
        productId: linha.produto.id,
        movementType: 'out',
        quantity: linha.quantidade,
        kind: 'CONSIGNMENT_OUT',
        referenceType: 'consignacao',
        referenceId: consignmentId,
        documentNumber: `Consignação #${number}`,
        userId: input.userId,
        note: `Remessa em consignação para ${cliente.name}`,
      });
    }

    gravarEvento({
      companyId: input.companyId,
      consignmentId,
      kind: 'remessa',
      // A CHAVE FICA GRAVADA NO EVENTO — é ela que o reenvio encontra lá em
      // cima. Sem gravá-la, exigir o header seria teatro: a segunda chamada
      // não teria como saber que a primeira existiu.
      idempotencyKey: input.idempotencyKey,
      impressao,
      detail: {
        itens: linhas.map((l) => ({
          productId: l.produto.id,
          description: l.produto.name,
          quantity: l.quantidade,
          unitPriceCents: l.unitPriceCents,
        })),
        valorTotalCents: valorTotal,
      },
      userId: input.userId,
    });

    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'consignment.create',
      entityType: 'consignment',
      entityId: consignmentId,
      detail: {
        number,
        customerId: input.customerId,
        itens: linhas.length,
        valorTotalCents: valorTotal,
        validUntil: input.validUntil ?? null,
      },
    });

    const criada = db
      .prepare(
        `SELECT id, number, status, customer_id, valid_until, created_at
           FROM core_consignments WHERE id = ?`,
      )
      .get(consignmentId) as unknown as ConsignmentRecord;
    return { ...criada, duplicated: false };
  });
}

// --------------------------------------------------------------- o RETORNO

/**
 * A mercadoria que voltou volta ao disponível — nem mais, nem menos.
 *
 * Parcial é o caso NORMAL, não a exceção: a cliente leva cinco peças e devolve
 * três. É por isso que o retorno é um evento com itens próprios, e não um botão
 * de "devolver tudo".
 */
export function registrarRetorno(input: {
  companyId: string;
  userId: string;
  consignmentId: string;
  idempotencyKey: string;
  items: ConsignmentLineInput[];
  note?: string | null;
}): { eventId: string; duplicated: boolean } {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const consignacao = loadConsignacao(input.companyId, input.consignmentId);

    // A idempotência é conferida ANTES do estado: o reenvio de um retorno que
    // já fechou a consignação é o mesmo retorno, e responder "está fechada"
    // faria a tela mostrar erro para uma operação que deu certo.
    const impressao = impressaoDoEvento({ kind: 'retorno', consignmentId: input.consignmentId, items: input.items });
    const jaFeito = eventoJaRegistrado(input.companyId, input.idempotencyKey);
    if (jaFeito) {
      recusarSeOutroPedido(jaFeito, impressao);
      return { eventId: String(jaFeito.id), duplicated: true };
    }

    exigirAberta(consignacao);
    const conferidas = conferirContraOPendente(
      input.companyId,
      input.consignmentId,
      input.items,
      'devolver',
    );

    const eventId = randomUUID();
    const numero = String(consignacao.number);

    for (const { item, quantity } of conferidas) {
      /*
        A REFERÊNCIA É DO EVENTO, e não da consignação.

        A UNIQUE do razão é (empresa, tipo de referência, referência, produto,
        tipo de movimento). Com a consignação como referência, o SEGUNDO
        retorno parcial do mesmo produto colidiria — e `applyMovement`
        responderia `duplicated: true` em silêncio, deixando o item marcado
        como devolvido sem que o saldo subisse. Mercadoria sumida, sem erro.
      */
      applyMovement({
        companyId: input.companyId,
        productId: item.product_id,
        movementType: 'in',
        quantity,
        kind: 'CONSIGNMENT_RETURN',
        referenceType: 'consignacao_retorno',
        referenceId: eventId,
        documentNumber: `Consignação #${numero}`,
        userId: input.userId,
        note: input.note ?? 'Retorno de consignação',
      });

      db.prepare(
        `UPDATE core_consignment_items
            SET returned_qty = returned_qty + ?
          WHERE id = ? AND company_id = ?`,
      ).run(quantity, item.id, input.companyId);
    }

    db.prepare(
      `INSERT INTO core_consignment_events
         (id, consignment_id, company_id, kind, sale_id, idempotency_key, detail, user_id, created_at,
          idempotency_fingerprint)
       VALUES (?, ?, ?, 'retorno', NULL, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.consignmentId,
      input.companyId,
      input.idempotencyKey,
      JSON.stringify({
        itens: conferidas.map((c) => ({
          productId: c.item.product_id,
          description: c.item.description,
          quantity: c.quantity,
        })),
        note: input.note ?? null,
      }),
      input.userId,
      new Date().toISOString(),
      impressao,
    );

    db.prepare('UPDATE core_consignments SET updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      input.consignmentId,
    );

    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'consignment.return',
      entityType: 'consignment',
      entityId: input.consignmentId,
      detail: {
        number: consignacao.number,
        eventId,
        itens: conferidas.map((c) => ({
          productId: c.item.product_id,
          description: c.item.description,
          quantity: c.quantity,
        })),
      },
    });

    return { eventId, duplicated: false };
  });
}

// ---------------------------------------------------------------- a VENDA

/**
 * O que a cliente ficou vira venda de verdade — e a receita nasce AQUI.
 *
 * A venda é feita pelo `SalesService`, com todas as regras de sempre: preço do
 * dia, comissão, lançamento financeiro, gaveta, idempotência e o caminho fiscal
 * que a nota vai usar depois. Este módulo não duplica nenhuma delas.
 *
 * O que é próprio da consignação é a perna de ENTRADA que precede a venda — o
 * retorno simbólico. Ver o cabeçalho do arquivo: a peça já saiu na remessa, e
 * sem essa perna a venda tentaria baixar de novo o que já baixou.
 */
export function faturarConsignacao(input: {
  companyId: string;
  userId: string;
  consignmentId: string;
  idempotencyKey: string;
  items: ConsignmentLineInput[];
  payments: SalePaymentInput[];
  cashSessionId?: string | null;
  note?: string | null;
}): { saleId: string; number: number; totalCents: number; duplicated: boolean } {
  ensureCoreSchema();

  if (!input.idempotencyKey) {
    throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Chave de idempotência é obrigatória.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const consignacao = loadConsignacao(input.companyId, input.consignmentId);

    const impressao = impressaoDoEvento({
      kind: 'venda',
      consignmentId: input.consignmentId,
      items: input.items,
      payments: input.payments,
    });
    const jaFeito = eventoJaRegistrado(input.companyId, input.idempotencyKey);
    if (jaFeito) {
      recusarSeOutroPedido(jaFeito, impressao);
      const venda = db
        .prepare('SELECT id, number, total_cents FROM core_sales WHERE id = ?')
        .get(String(jaFeito.sale_id)) as
        | { id: string; number: number; total_cents: number }
        | undefined;
      if (venda) {
        return {
          saleId: venda.id,
          number: venda.number,
          totalCents: venda.total_cents,
          duplicated: true,
        };
      }
    }

    exigirAberta(consignacao);
    const conferidas = conferirContraOPendente(
      input.companyId,
      input.consignmentId,
      input.items,
      'faturar',
    );

    const eventId = randomUUID();
    const numero = String(consignacao.number);

    /*
      O RETORNO SIMBÓLICO VEM ANTES DA VENDA, e a ordem é o que faz a conta
      fechar dentro da transação: a venda baixa o que esta perna acabou de
      devolver, e o saldo termina exatamente onde estava. Invertidas, o
      `CHECK (quantity >= 0)` derrubaria a operação em toda loja cujo saldo
      daquele produto já estivesse zerado — que é o caso comum quando a
      consignação levou as últimas peças.
    */
    for (const { item, quantity } of conferidas) {
      applyMovement({
        companyId: input.companyId,
        productId: item.product_id,
        movementType: 'in',
        quantity,
        kind: 'CONSIGNMENT_SYMBOLIC_RETURN',
        referenceType: 'consignacao_faturamento',
        referenceId: eventId,
        documentNumber: `Consignação #${numero}`,
        userId: input.userId,
        note: 'Retorno simbólico para faturar a consignação',
      });
    }

    /*
      A CHAVE DESCE COM O DOCUMENTO NO NOME, pelo mesmo motivo de
      `convertQuote`: a busca de idempotência do `SalesService` casa por
      (empresa, chave) sem olhar CONTEÚDO, e duas consignações faturadas com a
      mesma chave — aba duplicada, script que gera a chave uma vez por sessão —
      virariam UMA venda só, com mercadoria sumindo pelo caminho.
    */
    const { sale, duplicated, concessao } = createSale({
      companyId: input.companyId,
      userId: input.userId,
      idempotencyKey: chaveDoFaturamentoDaConsignacao(input.consignmentId, input.idempotencyKey),
      items: conferidas.map((c) => ({
        productId: c.item.product_id,
        quantity: c.quantity,
        /*
          O PREÇO CONGELADO NA REMESSA — e ele não veio de tela nenhuma.

          É o vigente do dia da entrega, resolvido pelo servidor com a tabela da
          cliente. Reprecificar aqui faria a peça que ela levou por R$ 200
          custar R$ 240 no dia de pagar, porque a tabela subiu no meio — e quem
          explicaria isso é a vendedora, que não teve parte na decisão. É o
          mesmo congelamento do orçamento.

          Sem `alcada`, pela mesma razão de `convertQuote`: nenhum valor deste
          faturamento vem do corpo da requisição, então não há concessão NOVA
          para medir. O que houver de diferença veio do cadastro de preços.
        */
        unitPriceCents: c.item.unit_price_cents,
      })),
      payments: input.payments,
      customerId: String(consignacao.customer_id),
      sellerId: (consignacao.seller_id as string | null) ?? null,
      cashSessionId: input.cashSessionId ?? null,
      origin: 'consignacao',
      note: input.note ?? `Faturamento da consignação #${numero}`,
    });

    if (duplicated) {
      /*
        CINTO E SUSPENSÓRIO, como em `convertQuote`. Com o prefixo, `duplicated`
        só pode se referir a ESTA consignação — e o evento dela teria sido
        encontrado lá em cima, porque venda e evento moram na mesma transação.
        Vindo assim, o banco não está no estado que este código supõe, e o
        desfecho inaceitável é justamente o que aconteceria em silêncio: o
        retorno simbólico já entrou, a venda é de outra operação, e a loja fica
        com mercadoria a mais no sistema. Estourar derruba a transação inteira.
      */
      throw new ApiError(
        'CORE_CONSIGNMENT_KEY_CONFLICT',
        `Este faturamento esbarrou na venda #${sale.number}, que já existe para uma chave que `
          + 'deveria ser exclusiva desta consignação. Nada foi alterado: nem estoque, nem '
          + 'financeiro. Confira a consignação e a venda antes de tentar de novo.',
        409,
        { consignmentId: input.consignmentId, saleId: sale.id },
      );
    }

    for (const { item, quantity } of conferidas) {
      db.prepare(
        `UPDATE core_consignment_items
            SET sold_qty = sold_qty + ?
          WHERE id = ? AND company_id = ?`,
      ).run(quantity, item.id, input.companyId);
    }

    db.prepare(
      `INSERT INTO core_consignment_events
         (id, consignment_id, company_id, kind, sale_id, idempotency_key, detail, user_id, created_at,
          idempotency_fingerprint)
       VALUES (?, ?, ?, 'venda', ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.consignmentId,
      input.companyId,
      sale.id,
      input.idempotencyKey,
      JSON.stringify({
        saleId: sale.id,
        saleNumber: sale.number,
        totalCents: sale.total_cents,
        itens: conferidas.map((c) => ({
          productId: c.item.product_id,
          description: c.item.description,
          quantity: c.quantity,
        })),
      }),
      input.userId,
      new Date().toISOString(),
      impressao,
    );

    db.prepare('UPDATE core_consignments SET updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      input.consignmentId,
    );

    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'consignment.invoice',
      entityType: 'consignment',
      entityId: input.consignmentId,
      detail: {
        number: consignacao.number,
        saleId: sale.id,
        saleNumber: sale.number,
        totalCents: sale.total_cents,
        /*
          A CONCESSÃO MEDIDA, na trilha — pelo mesmo motivo de
          `quote.convert.concessao_aumentou`: o preço congelado na remessa pode
          ter ficado abaixo da tabela de hoje, e isso é legítimo mas é um FATO
          ECONÔMICO que o dono precisa enxergar. Barrado, viraria uma venda
          cancelada e redigitada, e sumiria.
        */
        concessaoCents: concessao?.concedidoCents ?? 0,
        brutoCents: concessao?.brutoCents ?? sale.total_cents,
        percentual: concessao?.percentual ?? 0,
        itens: conferidas.map((c) => ({
          productId: c.item.product_id,
          description: c.item.description,
          quantity: c.quantity,
        })),
      },
    });

    return {
      saleId: sale.id,
      number: sale.number,
      totalCents: sale.total_cents,
      duplicated: false,
    };
  });
}

// ----------------------------------------------------------- o FECHAMENTO

/**
 * Fecha a consignação — e só fecha quando não sobrou nada com o cliente.
 *
 * A recusa NOMEIA o que falta, e isso é o ponto: "não pode fechar" sem dizer o
 * quê mandaria a vendedora conferir cinco linhas à mão. Fechar com pendência
 * seria pior que não ter o botão — a mercadoria continuaria na rua, fora do
 * estoque e fora de qualquer lista que alguém volte a abrir.
 */
export function fecharConsignacao(input: {
  companyId: string;
  userId: string;
  consignmentId: string;
}): ConsignmentRecord {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const consignacao = loadConsignacao(input.companyId, input.consignmentId);

    // Fechar duas vezes não é erro: é o clique repetido. Devolve o que já está
    // e não grava uma segunda trilha dizendo que fechou de novo.
    if (consignacao.status === 'fechada') {
      return db
        .prepare(
          `SELECT id, number, status, customer_id, valid_until, created_at
             FROM core_consignments WHERE id = ?`,
        )
        .get(input.consignmentId) as unknown as ConsignmentRecord;
    }

    const pendentes = itensDaConsignacao(input.companyId, input.consignmentId).filter(
      (i) => i.pending_qty > 0,
    );
    if (pendentes.length > 0) {
      throw new ApiError(
        'CORE_CONSIGNMENT_HAS_PENDING',
        'Ainda há mercadoria com o cliente: '
          + pendentes.map((i) => `${i.pending_qty} de "${i.description}"`).join(', ')
          + '. Registre o retorno ou fature antes de fechar.',
        409,
        {
          pendentes: pendentes.map((i) => ({
            productId: i.product_id,
            description: i.description,
            pending: i.pending_qty,
          })),
        },
      );
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE core_consignments SET status = 'fechada', closed_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, input.consignmentId);

    gravarEvento({
      companyId: input.companyId,
      consignmentId: input.consignmentId,
      kind: 'fechamento',
      detail: { number: consignacao.number },
      userId: input.userId,
    });

    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'consignment.close',
      entityType: 'consignment',
      entityId: input.consignmentId,
      detail: { number: consignacao.number },
    });

    return db
      .prepare(
        `SELECT id, number, status, customer_id, valid_until, created_at
           FROM core_consignments WHERE id = ?`,
      )
      .get(input.consignmentId) as unknown as ConsignmentRecord;
  });
}

// ------------------------------------------------------------- as LEITURAS

export interface ConsignmentListRow {
  id: string;
  number: number;
  status: ConsignmentStatus;
  customer_id: string;
  customer_name: string | null;
  valid_until: string | null;
  created_at: string;
  /** Quanto ainda está com o cliente, somado. É a coluna que se olha. */
  pending_qty: number;
  /** Quanto vale o que está lá fora, pelo valor declarado na remessa. */
  pending_value_cents: number;
}

export function listConsignacoes(
  companyId: string,
  options: { status?: ConsignmentStatus; customerId?: string; limit?: number } = {},
): ConsignmentListRow[] {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = `
    SELECT c.id, c.number, c.status, c.customer_id, c.valid_until, c.created_at,
           cu.name AS customer_name,
           COALESCE((SELECT SUM(${SQL_PENDENTE})
                       FROM core_consignment_items i
                      WHERE i.consignment_id = c.id), 0) AS pending_qty,
           COALESCE((SELECT SUM(CAST(ROUND(${SQL_PENDENTE} * i.unit_price_cents) AS INTEGER))
                       FROM core_consignment_items i
                      WHERE i.consignment_id = c.id), 0) AS pending_value_cents
      FROM core_consignments c
      LEFT JOIN core_customers cu ON cu.id = c.customer_id
     WHERE c.company_id = ?`;
  if (options.status) {
    sql += ' AND c.status = ?';
    params.push(options.status);
  }
  if (options.customerId) {
    sql += ' AND c.customer_id = ?';
    params.push(options.customerId);
  }
  sql += ' ORDER BY c.created_at DESC LIMIT ?';
  params.push(options.limit ?? 100);

  return getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as ConsignmentListRow[];
}

export function getConsignacao(
  companyId: string,
  consignmentId: string,
): (Record<string, unknown> & { items: ConsignmentItemRow[] }) | null {
  ensureCoreSchema();
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT c.*, cu.name AS customer_name
         FROM core_consignments c
         LEFT JOIN core_customers cu ON cu.id = c.customer_id
        WHERE c.id = ? AND c.company_id = ?`,
    )
    .get(consignmentId, companyId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    ...row,
    items: itensDaConsignacao(companyId, consignmentId),
    // A razão da custódia, na mesma folha: é ela que responde "quando voltaram
    // as três peças?" sem obrigar ninguém a cruzar o razão de estoque por hora.
    events: db
      .prepare(
        `SELECT e.*, s.number AS sale_number, u.display_name AS user_name
           FROM core_consignment_events e
           LEFT JOIN core_sales s ON s.id = e.sale_id
           LEFT JOIN core_users u ON u.id = e.user_id
          WHERE e.consignment_id = ? AND e.company_id = ?
          ORDER BY e.created_at`,
      )
      .all(consignmentId, companyId) as unknown as Record<string, unknown>[],
  };
}
