/**
 * Crédito de loja — o vale que a devolução concede e a venda seguinte gasta.
 *
 * ## O CICLO QUE NÃO FECHAVA (GAP-V10 / GAP-V47)
 *
 * A devolução já sabia devolver "em crédito na loja" desde a rodada 21:
 * `refund_method = 'credito'` era gravado, nenhum lançamento financeiro nascia
 * (com razão — o dinheiro não saiu do caixa) e o DRE NOMEAVA o valor numa
 * ressalva. O que não existia era a outra metade: nenhuma tabela guardava o
 * saldo, nenhuma tela o mostrava e nenhum caminho o consumia na compra
 * seguinte.
 *
 * Na prática o operador dava o crédito pelo sistema e cobrava de volta no
 * papel. O comentário de `SaleReturnService` prometia "vira saldo do cliente" e
 * o de `IncomeStatementService` respondia, na mesma base de código, que "o
 * crédito ainda nem existe como saldo no sistema". A loja ficava devendo de
 * cabeça, e o passivo crescia a cada devolução.
 *
 * ## RAZÃO, NUNCA SALDO MUTÁVEL
 *
 * Uma linha por fato, com SINAL, e o saldo é a SOMA. Não existe `UPDATE` de
 * saldo em lugar nenhum deste arquivo, e é a mesma decisão que a fidelidade
 * tomou pelo mesmo motivo: um total guardado à parte cria duas versões da
 * mesma verdade, e a divergência aparece no balcão, com o cliente afirmando ter
 * mais crédito do que a tela mostra. Aqui doeria mais que no ponto, porque isto
 * é dinheiro que a loja DEVE.
 *
 * ## O SINAL É A SEMÂNTICA, e `kind` é a INTENÇÃO
 *
 * Os dois existem porque respondem perguntas diferentes:
 *
 *   amount_cents  quanto o saldo se moveu — positivo entra, negativo sai. É o
 *                 que a soma usa, e é por isso que ele é SIGNED em vez de um
 *                 valor absoluto ao lado de um "tipo" que toda consulta teria
 *                 de traduzir.
 *   kind          por que se moveu: 'grant' (a devolução concedeu), 'redeem'
 *                 (a venda gastou), 'reversal' (o cancelamento desfez).
 *
 * `reversal` carrega os DOIS sinais — positivo quando devolve um resgate,
 * negativo quando revoga uma concessão —, e por isso ele não pode ser deduzido
 * do sinal. É a mesma forma da razão de pontos, com uma diferença deliberada: a
 * chave única daqui inclui `origin_type`, porque um `reversal` de venda e um
 * `reversal` de devolução são fatos distintos que podem coexistir no mesmo
 * cancelamento.
 *
 * ## A CONTABILIDADE, escrita por extenso porque a pergunta volta
 *
 * A devolução em crédito continua SEM lançamento financeiro, e isso não mudou
 * com esta rodada: nenhum dinheiro saiu do caixa. O que mudou é que o passivo
 * passou a ter nome, dono e valor.
 *
 * O DRE continua com a ressalva que já tinha ("R$ X devolvidos como crédito na
 * loja não aparecem aqui... a receita do período está inflada nesse valor"), e
 * ela continua CERTA — a venda original somou receita e a devolução não
 * subtraiu de lugar nenhum. O período da CONCESSÃO é o que está inflado.
 *
 * O período do RESGATE, por outro lado, não precisa de ressalva nenhuma: a
 * venda paga com crédito reconhece receita cheia porque a loja de fato entregou
 * mercadoria e de fato se livrou de uma dívida do mesmo tamanho. Por isso o
 * resgate NÃO vira desconto na venda (desconto reduziria a receita duas vezes,
 * uma em cada ponta do ciclo) e NÃO vira despesa (não saiu dinheiro).
 *
 * Ele entra como LIQUIDAÇÃO do recebível da venda, com baixa própria e método
 * próprio — ver `CREDITO_DE_LOJA` e o uso dele em `SalesService`. Sem isso a
 * venda paga com crédito ficaria "em aberto" no contas a receber e alguém
 * cobraria do cliente um dinheiro que ele não deve.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { emReais } from './Money.js';

/**
 * Como a BAIXA da venda paga com crédito se chama no financeiro.
 *
 * NÃO é uma forma de pagamento do catálogo (`PaymentMethods.ts`), e isso é
 * decisão. Aquele catálogo existe para validar o que chega como string livre do
 * balcão, e cada item dele tem comportamento de INSTRUMENTO: dinheiro mexe na
 * gaveta e admite troco, cartão passa pela maquininha, PIX depende de terminal.
 * Crédito de loja não é instrumento nenhum — é a extinção de uma dívida que a
 * loja já tinha. Ele não entra em `core_sale_payments` justamente porque ali
 * mora o que o cliente PAGOU; aqui o cliente não pagou, ele cobrou.
 *
 * O nome viaja para `core_finance_settlements.method` para que a conciliação
 * bancária e o regime de caixa possam distinguir esta baixa de uma entrada de
 * dinheiro de verdade. Uma constante, e não a string solta em três arquivos,
 * porque duas cópias divergem na primeira manutenção.
 */
export const CREDITO_DE_LOJA = 'credito_loja';

export interface CreditEntry {
  id: string;
  company_id: string;
  customer_id: string;
  kind: string;
  amount_cents: number;
  origin_type: string;
  origin_id: string;
  description: string;
  created_by: string | null;
  created_at: string;
}

/**
 * Saldo do cliente — a SOMA da razão, sempre.
 *
 * Escopo de empresa no WHERE, e não só no id do cliente: o mesmo CPF pode estar
 * cadastrado nas seis operações do grupo, com ids diferentes, e crédito
 * concedido pela loja A não é gastável na oficina B. Quem devolveu a mercadoria
 * foi para uma delas.
 */
export function creditBalanceCents(companyId: string, customerId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS saldo
         FROM core_customer_credits
        WHERE company_id = ? AND customer_id = ?`,
    )
    .get(companyId, customerId) as { saldo: number };
  return Number(row.saldo);
}

/** A linha desta origem, se ela já existe. É a trava contra o dobro, lida. */
function linhaDaOrigem(
  companyId: string,
  kind: string,
  originType: string,
  originId: string,
): CreditEntry | undefined {
  return getConnection()
    .prepare(
      `SELECT * FROM core_customer_credits
        WHERE company_id = ? AND kind = ? AND origin_type = ? AND origin_id = ?`,
    )
    .get(companyId, kind, originType, originId) as CreditEntry | undefined;
}

function inserirLinha(input: {
  companyId: string;
  customerId: string;
  kind: string;
  amountCents: number;
  originType: string;
  originId: string;
  description: string;
  userId?: string | null;
}): CreditEntry {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_customer_credits
         (id, company_id, customer_id, kind, amount_cents, origin_type, origin_id,
          description, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.companyId,
      input.customerId,
      input.kind,
      input.amountCents,
      input.originType,
      input.originId,
      input.description,
      input.userId ?? null,
      new Date().toISOString(),
    );
  return getConnection()
    .prepare('SELECT * FROM core_customer_credits WHERE id = ?')
    .get(id) as unknown as CreditEntry;
}

/**
 * A devolução concede crédito.
 *
 * IDEMPOTENTE POR ORIGEM: a mesma devolução não concede duas vezes, e a trava
 * não é só o `UNIQUE` da tabela — é a leitura ANTES do INSERT, para que um
 * chamador repetido receba a linha existente em vez de uma exceção de banco que
 * derrubaria a transação inteira da devolução.
 *
 * EXIGE CLIENTE, e a recusa é legível. Crédito sem dono é exatamente o passivo
 * invisível que esta rodada veio eliminar: um valor que a loja deve a ninguém,
 * que nenhuma tela mostra e que nenhuma venda consome. O balcão precisa ouvir
 * "identifique o cliente", e não descobrir meses depois que o vale sumiu.
 */
export function grantCredit(input: {
  companyId: string;
  customerId: string | null;
  amountCents: number;
  /**
   * 'sale_return': o vale da devolução imediata. 'sale_return_refund': o vale
   * registrado como reembolso da devolução em duas etapas — a origem é o
   * registro do reembolso, e a chave única prende o vale a ele.
   */
  originType: 'sale_return' | 'sale_return_refund';
  originId: string;
  description: string;
  userId?: string | null;
}): { entry: CreditEntry | null; granted: number; balance: number } {
  ensureCoreSchema();
  const valor = Math.round(Number(input.amountCents));
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new ApiError('CORE_CREDIT_AMOUNT_INVALID', 'Valor de crédito inválido.', 400);
  }
  if (!input.customerId) {
    throw new ApiError(
      'CORE_CREDIT_CUSTOMER_REQUIRED',
      'Devolução em crédito de loja precisa de cliente identificado: o crédito é um vale, '
        + 'e vale sem dono é dinheiro que a loja deve a ninguém. '
        + 'Identifique o cliente na venda, ou devolva em dinheiro, PIX ou estorno no cartão.',
      400,
    );
  }

  return withTransaction(() => {
    const jaConcedido = linhaDaOrigem(input.companyId, 'grant', input.originType, input.originId);
    if (jaConcedido) {
      return {
        entry: jaConcedido,
        granted: 0,
        balance: creditBalanceCents(input.companyId, input.customerId!),
      };
    }
    const entry = inserirLinha({
      companyId: input.companyId,
      customerId: input.customerId!,
      kind: 'grant',
      amountCents: valor,
      originType: input.originType,
      originId: input.originId,
      description: input.description,
      userId: input.userId,
    });
    return {
      entry,
      granted: valor,
      balance: creditBalanceCents(input.companyId, input.customerId!),
    };
  });
}

/**
 * A venda gasta crédito.
 *
 * ## POR QUE A CONFERÊNCIA DE SALDO MORA AQUI, e não na tela
 *
 * A tela do PDV já esconde o meio quando o saldo é zero — e isso é conveniência,
 * não trava. Dois caixas atendendo o mesmo cliente ao mesmo tempo veem os dois o
 * saldo cheio; quem decide é quem escreve.
 *
 * ## A CONCORRÊNCIA, e por que ela não precisa de nada além disto
 *
 * `withTransaction` abre `BEGIN IMMEDIATE`: o lock de escrita é tomado na
 * ABERTURA, antes de qualquer leitura. Como esta função é chamada de DENTRO da
 * transação da venda, a leitura do saldo e a gravação do resgate acontecem sob o
 * mesmo lock — não existe janela entre "ler R$ 50" e "gastar R$ 50" para uma
 * segunda venda entrar. A segunda transação espera, lê o saldo JÁ debitado e é
 * recusada por saldo insuficiente. É a mesma proteção que impede dois caixas de
 * venderem a última peça do estoque, e vem do mesmo lugar.
 *
 * A trava de trás é o `UNIQUE (company, kind, origin_type, origin_id)`: mesmo
 * que alguém chame duas vezes pela MESMA venda, a segunda linha não entra.
 */
export function redeemCredit(input: {
  companyId: string;
  customerId: string | null;
  amountCents: number;
  saleId: string;
  description: string;
  userId?: string | null;
}): { redeemed: number; balanceAfter: number } {
  ensureCoreSchema();
  const valor = Math.round(Number(input.amountCents));
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new ApiError(
      'CORE_CREDIT_AMOUNT_INVALID',
      'Valor de crédito inválido: informe quanto do saldo será usado nesta venda.',
      400,
    );
  }
  if (!input.customerId) {
    throw new ApiError(
      'CORE_CREDIT_CUSTOMER_REQUIRED',
      'Crédito de loja é de um cliente: identifique o cliente na venda para usar o saldo dele.',
      400,
    );
  }

  return withTransaction(() => {
    /*
      O cliente é DESTA operação — conferido aqui, e não só em quem chama.

      `createSale` já recusa cliente de outra empresa, e mesmo assim a conferência
      se repete: esta função é a porta do saldo, e uma trava que mora só no
      chamador é uma trava que o próximo chamador esquece. O crédito da loja A
      não se gasta na oficina B, nem que o id venha inteiro no corpo.
    */
    const cliente = getConnection()
      .prepare('SELECT id FROM core_customers WHERE id = ? AND company_id = ?')
      .get(input.customerId, input.companyId) as { id: string } | undefined;
    if (!cliente) {
      throw new ApiError(
        'CORE_CREDIT_CUSTOMER_INVALID',
        'O cliente informado não é desta operação — o crédito dele não vale aqui.',
        400,
      );
    }

    const saldo = creditBalanceCents(input.companyId, input.customerId!);
    if (valor > saldo) {
      throw new ApiError(
        'CORE_CREDIT_INSUFFICIENT',
        `Crédito insuficiente: o cliente tem ${emReais(saldo)} de saldo e a venda `
          + `pediu ${emReais(valor)}. Complete o restante em outra forma de pagamento.`,
        409,
        { balanceCents: saldo, requestedCents: valor },
      );
    }

    const jaGastou = linhaDaOrigem(input.companyId, 'redeem', 'sale', input.saleId);
    if (jaGastou) {
      throw new ApiError(
        'CORE_CREDIT_ALREADY_REDEEMED',
        'Esta venda já consumiu crédito do cliente.',
        409,
      );
    }

    inserirLinha({
      companyId: input.companyId,
      customerId: input.customerId!,
      kind: 'redeem',
      // NEGATIVO: o saldo é a soma, e consumir é somar um número negativo.
      amountCents: -valor,
      originType: 'sale',
      originId: input.saleId,
      description: input.description,
      userId: input.userId,
    });

    return {
      redeemed: valor,
      balanceAfter: creditBalanceCents(input.companyId, input.customerId!),
    };
  });
}

/**
 * Cancelar a venda devolve o crédito que ela gastou.
 *
 * Espelho exato do que a fidelidade já faz em `reversePoints`: venda cancelada
 * é venda que não aconteceu, e o cliente não pode perder o vale com que pagou
 * uma compra que o sistema afirma nunca ter existido.
 *
 * Silencioso quando não há o que devolver — venda que não usou crédito, ou
 * cancelamento repetido (a chave única já ocupada pelo primeiro). Recusar aqui
 * derrubaria o cancelamento inteiro por causa de um acessório.
 */
export function returnRedeemedCredit(input: {
  companyId: string;
  saleId: string;
  reason: string;
  userId?: string | null;
}): { returned: number } {
  ensureCoreSchema();
  return withTransaction(() => {
    const gasto = linhaDaOrigem(input.companyId, 'redeem', 'sale', input.saleId);
    if (!gasto) return { returned: 0 };

    const jaDevolvido = linhaDaOrigem(input.companyId, 'reversal', 'sale', input.saleId);
    if (jaDevolvido) return { returned: 0 };

    // O gasto está gravado negativo; devolver é somar o mesmo valor positivo.
    const valor = Math.abs(gasto.amount_cents);
    inserirLinha({
      companyId: input.companyId,
      customerId: gasto.customer_id,
      kind: 'reversal',
      amountCents: valor,
      originType: 'sale',
      originId: input.saleId,
      description: input.reason,
      userId: input.userId,
    });
    return { returned: valor };
  });
}

/**
 * Cancelar a venda também REVOGA o crédito que uma devolução dela concedeu.
 *
 * ## O buraco que isto fecha
 *
 * Devolução não se cancela nesta casa — não existe rota, serviço nem tela para
 * isso, e a decisão está registrada no cabeçalho de `SaleReturnService`: a
 * devolução é registro NOVO apontando para a venda, e o documento dela nunca
 * deixa de existir. O que existe é o cancelamento da VENDA, e ele já derruba os
 * lançamentos financeiros das devoluções daquela venda pelo motivo escrito lá
 * ("se o fato todo foi anulado, a desistência parcial dele não sobrevive
 * sozinha").
 *
 * O crédito concedido tinha de cair pelo mesmo argumento, e não caía: o cliente
 * ficava com um vale de uma venda que o sistema afirma nunca ter acontecido.
 *
 * ## E se ele JÁ gastou o vale?
 *
 * O saldo fica NEGATIVO, de propósito. É dívida real: a loja entregou mercadoria
 * contra um crédito que a anulação da venda desfez. Zerar por baixo esconderia o
 * rombo justamente do único lugar que poderia mostrá-lo — o extrato do cliente,
 * onde o número aparece em vermelho para quem estiver no balcão. Uma concessão
 * futura o absorve; um resgate futuro é recusado enquanto ele existir, porque
 * `redeemCredit` compara contra o saldo, que está abaixo de zero.
 */
export function revokeCreditFromSale(input: {
  companyId: string;
  saleId: string;
  reason: string;
  userId?: string | null;
}): { revoked: number } {
  ensureCoreSchema();
  return withTransaction(() => {
    const concedidos = getConnection()
      .prepare(
        `SELECT c.* FROM core_customer_credits c
           JOIN core_sale_returns r ON r.id = c.origin_id
          WHERE c.company_id = ? AND c.kind = 'grant' AND c.origin_type = 'sale_return'
            AND r.sale_id = ? AND r.company_id = ?`,
      )
      .all(input.companyId, input.saleId, input.companyId) as unknown as CreditEntry[];

    let total = 0;
    for (const concessao of concedidos) {
      const jaRevogado = linhaDaOrigem(
        input.companyId,
        'reversal',
        'sale_return',
        concessao.origin_id,
      );
      if (jaRevogado) continue;
      inserirLinha({
        companyId: input.companyId,
        customerId: concessao.customer_id,
        kind: 'reversal',
        amountCents: -concessao.amount_cents,
        originType: 'sale_return',
        originId: concessao.origin_id,
        description: input.reason,
        userId: input.userId,
      });
      total += concessao.amount_cents;
    }
    return { revoked: total };
  });
}

/**
 * O extrato do cliente — saldo e movimento, com a origem NAVEGÁVEL.
 *
 * O número da devolução e o número da venda vêm juntos porque "R$ 250,00
 * concedidos" sem dizer de onde manda quem lê procurar num histórico inteiro. É
 * a mesma lição do extrato de pontos, e o `LEFT JOIN` é duplo porque a origem é
 * polimórfica: cada linha aponta para UM dos dois, nunca para os dois.
 */
export function creditStatement(
  companyId: string,
  customerId: string,
): {
  balance: number;
  entries: Record<string, unknown>[];
} {
  ensureCoreSchema();
  const entries = getConnection()
    .prepare(
      `SELECT c.*,
              r.number AS return_number,
              s.number AS sale_number
         FROM core_customer_credits c
         LEFT JOIN core_sale_returns r
           ON r.id = c.origin_id AND c.origin_type = 'sale_return'
         LEFT JOIN core_sales s
           ON s.id = c.origin_id AND c.origin_type = 'sale'
        WHERE c.company_id = ? AND c.customer_id = ?
        ORDER BY c.created_at DESC, c.rowid DESC
        LIMIT 200`,
    )
    .all(companyId, customerId) as unknown as Record<string, unknown>[];
  return { balance: creditBalanceCents(companyId, customerId), entries };
}

/**
 * Quanto a operação deve em vale.
 *
 * É passivo, e mais duro que o da fidelidade: ponto é desconto prometido, vale é
 * mercadoria já devolvida e ainda não reposta. Só os saldos POSITIVOS somam — o
 * cliente com saldo negativo (ver `revokeCreditFromSale`) deve à loja, e abater
 * a dívida dele do passivo faria uma coisa esconder a outra.
 */
export function creditLiability(companyId: string): { cents: number; customers: number } {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(saldo), 0) AS total, COUNT(*) AS clientes FROM (
         SELECT SUM(amount_cents) AS saldo
           FROM core_customer_credits
          WHERE company_id = ?
          GROUP BY customer_id
         HAVING SUM(amount_cents) > 0)`,
    )
    .get(companyId) as { total: number; clientes: number };
  return { cents: Number(row.total), customers: Number(row.clientes) };
}
