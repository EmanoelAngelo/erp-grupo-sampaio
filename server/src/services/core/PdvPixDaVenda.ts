/**
 * O PIX DO BALCÃO DENTRO DA VENDA (GAP-PRD-077) — a parte que a venda e o
 * webhook compartilham.
 *
 * ## O beco que existia
 *
 * PIX no balcão sem maquininha era lançamento manual: a tela dizia que o QR
 * aparecia "na tela do computador" e não aparecia nada; o operador conferia o
 * app do banco e lançava como recebido. E o caminho `pending` — que a API
 * aceitava — era um beco: `core_sale_payments` só tinha um escritor (o INSERT
 * da venda), nenhum webhook tratava origem `sale`, e a linha pendente ficava
 * pendente para sempre, com o título em aberto.
 *
 * ## O que este módulo faz
 *
 *   1. CONFERE a linha de PIX que chega na venda com `paymentIntentId`: a
 *      cobrança tem de ser DESTA operação, do balcão, do mesmo valor, e ainda
 *      não ter fechado outra venda. O status da linha sai da cobrança — paga
 *      entra liquidada, em aberto entra pendente — e nunca do que a tela disse.
 *   2. VINCULA a cobrança à venda, dentro da transação da venda: a partir daí
 *      o webhook sabe qual venda liquidar.
 *   3. LIQUIDA a linha pendente quando o dinheiro entra (webhook, consulta ao
 *      provedor ou confirmação conferida): a linha vira `settled` e o título da
 *      venda recebe a baixa `Asaas <cobrança>` por `settleEntry` — o mesmo
 *      escritor de baixa do resto do sistema.
 *
 * Não importa `PaymentService`: é importado por ele e pela venda, e tem de
 * continuar leve para não fechar ciclo entre os três.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { settleEntry } from './FinanceService.js';

/** Prefixo da cobrança gerada no balcão ANTES de a venda existir. */
export const RASCUNHO_DO_BALCAO = 'pdv-pix:';

export interface PagamentoComPix {
  method: string;
  amountCents: number;
  status?: 'settled' | 'pending';
  provider?: string;
  providerRef?: string;
  paymentIntentId?: string;
}

interface IntencaoDoBalcao {
  id: string;
  company_id: string;
  provider: string;
  origin_type: string;
  origin_id: string;
  method: string;
  amount_cents: number;
  status: string;
  provider_ref: string | null;
}

const emReais = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

function intencao(companyId: string, intentId: string): IntencaoDoBalcao | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE id = ? AND company_id = ?')
    .get(intentId, companyId) as unknown as IntencaoDoBalcao | undefined;
}

/**
 * CONFERE as linhas de PIX do balcão e devolve a lista NOVA — a de entrada não
 * é reescrita (quem chamou recebe de volta o que mandou).
 *
 * A linha só diz QUAL cobrança; o status, o provedor e a referência saem da
 * cobrança. Uma tela que mandasse `settled` num PIX ainda em aberto não
 * conseguiria fechar a venda como paga.
 */
export function conferirPixDoBalcaoNaVenda<T extends PagamentoComPix>(input: {
  companyId: string;
  idempotencyKey: string;
  payments: T[];
}): T[] {
  const usadas = new Set<string>();
  return input.payments.map((p) => {
    if (!p.paymentIntentId) return p;
    const id = String(p.paymentIntentId);
    if (usadas.has(id)) {
      throw new ApiError(
        'CORE_PIX_BALCAO_DUPLICADO',
        'O mesmo PIX do balcão foi informado em duas linhas desta venda.',
        409,
      );
    }
    usadas.add(id);

    const pix = intencao(input.companyId, id);
    // 404 e não 403: cobrança de outra operação simplesmente não está aqui.
    if (!pix || pix.origin_type !== 'sale' || pix.provider !== 'asaas') {
      throw new ApiError('CORE_PIX_BALCAO_NOT_FOUND', 'PIX do balcão não encontrado nesta operação.', 404);
    }
    if (!pix.origin_id.startsWith(RASCUNHO_DO_BALCAO)) {
      // Já fechou uma venda. Só o REENVIO da mesma venda passa — é ele que a
      // trava de idempotência da venda devolve sem criar outra.
      const dona = getConnection()
        .prepare('SELECT idempotency_key FROM core_sales WHERE id = ? AND company_id = ?')
        .get(pix.origin_id, input.companyId) as { idempotency_key: string } | undefined;
      if (!dona || dona.idempotency_key !== input.idempotencyKey) {
        throw new ApiError(
          'CORE_PIX_BALCAO_JA_USADO',
          'Este PIX já fechou outra venda — gere um novo QR para esta.',
          409,
        );
      }
    }
    if (p.method !== 'pix') {
      throw new ApiError('CORE_PIX_BALCAO_METODO', 'A cobrança do balcão é PIX: a linha tem de ser PIX.', 400);
    }
    if (p.amountCents !== pix.amount_cents) {
      throw new ApiError(
        'CORE_PIX_BALCAO_VALOR',
        `O PIX gerado é de ${emReais(pix.amount_cents)} e a linha diz ${emReais(p.amountCents)}. Gere um QR com o valor certo.`,
        400,
      );
    }
    let status: 'settled' | 'pending';
    if (pix.status === 'confirmed') status = 'settled';
    else if (pix.status === 'pending' || pix.status === 'overdue') status = 'pending';
    else {
      throw new ApiError(
        'CORE_PIX_BALCAO_INDISPONIVEL',
        `Este PIX está como "${pix.status}" e não fecha venda. Gere um novo QR.`,
        409,
      );
    }
    return { ...p, status, provider: 'asaas', providerRef: pix.provider_ref ?? undefined, paymentIntentId: id };
  });
}

/**
 * A baixa que a linha pendente precisa: a do título DESTA venda com saldo.
 *
 * No caminho com operadora cada meio vira um título próprio — prefere-se o do
 * PIX; no caminho antigo, é o título único da venda.
 */
function tituloComSaldo(companyId: string, saleId: string, valor: number): string | null {
  const linhas = getConnection()
    .prepare(
      `SELECT id, payment_method FROM core_finance_entries
        WHERE company_id = ? AND origin_type = 'sale' AND origin_id = ? AND direction = 'in'
          AND cancelled_at IS NULL AND amount_cents - settled_cents >= ?
        ORDER BY CASE WHEN payment_method = 'pix' THEN 0 ELSE 1 END, installment_number`,
    )
    .all(companyId, saleId, valor) as { id: string; payment_method: string | null }[];
  return linhas[0]?.id ?? null;
}

/**
 * LIQUIDA uma linha PENDENTE da venda: a linha vira `settled` e o título
 * recebe a baixa. Idempotente — a linha já liquidada responde e não baixa de
 * novo. Roda dentro da transação de quem chamou.
 */
export function liquidarLinhaPendenteDaVenda(input: {
  companyId: string;
  saleId: string;
  paymentId: string;
  /** A nota da baixa: `Asaas <cobrança>` pelo provedor, ou o motivo da confirmação. */
  note: string;
  userId?: string | null;
  providerRef?: string | null;
}): { liquidada: boolean; detail: string } {
  const db = getConnection();
  const linha = db
    .prepare('SELECT * FROM core_sale_payments WHERE id = ? AND sale_id = ? AND company_id = ?')
    .get(input.paymentId, input.saleId, input.companyId) as
    | { id: string; amount_cents: number; status: string; method: string }
    | undefined;
  if (!linha) throw new ApiError('CORE_SALE_PAYMENT_NOT_FOUND', 'Pagamento da venda não encontrado.', 404);
  const venda = db
    .prepare('SELECT number, status FROM core_sales WHERE id = ? AND company_id = ?')
    .get(input.saleId, input.companyId) as { number: number; status: string };
  if (linha.status === 'settled') {
    return { liquidada: false, detail: `O PIX da venda #${venda.number} já estava liquidado.` };
  }
  if (venda.status === 'cancelled') {
    return { liquidada: false, detail: `A venda #${venda.number} foi cancelada: o PIX não liquida uma venda que não existe mais.` };
  }

  const agora = new Date().toISOString();
  db.prepare(
    `UPDATE core_sale_payments
        SET status = 'settled', settled_at = ?, provider_ref = COALESCE(provider_ref, ?)
      WHERE id = ?`,
  ).run(agora, input.providerRef ?? null, linha.id);

  const titulo = tituloComSaldo(input.companyId, input.saleId, linha.amount_cents);
  if (!titulo) {
    return {
      liquidada: true,
      detail: `PIX da venda #${venda.number} liquidado; o título da venda já não tinha saldo em aberto — confira em Contas a receber.`,
    };
  }
  settleEntry({
    companyId: input.companyId,
    entryId: titulo,
    amountCents: linha.amount_cents,
    method: linha.method,
    note: input.note,
    userId: input.userId ?? null,
  });
  return { liquidada: true, detail: `PIX do balcão confirmado: a venda #${venda.number} foi liquidada.` };
}

/**
 * O LADO DO WEBHOOK: o dinheiro do PIX do balcão entrou.
 *
 * Cobrança ainda sem venda (o QR está na tela do caixa) só fica confirmada —
 * a tela, que consulta, fecha a venda com a linha liquidada. Cobrança já
 * vinculada liquida a linha pendente dela.
 */
export function aplicarConfirmacaoNoBalcao(input: {
  intent: { id: string; company_id: string; origin_id: string };
  providerRef: string;
}): string {
  const { intent } = input;
  if (intent.origin_id.startsWith(RASCUNHO_DO_BALCAO)) {
    return 'PIX do balcão confirmado — a venda ainda não foi fechada; o caixa vê a confirmação na tela.';
  }
  const db = getConnection();
  const venda = db
    .prepare('SELECT id, status FROM core_sales WHERE id = ? AND company_id = ?')
    .get(intent.origin_id, intent.company_id) as { id: string; status: string } | undefined;
  const linha = venda
    ? (db
        .prepare('SELECT id FROM core_sale_payments WHERE sale_id = ? AND payment_intent_id = ?')
        .get(venda.id, intent.id) as { id: string } | undefined)
    : undefined;
  if (!venda || !linha) {
    db.prepare('UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?').run(
      'PIX confirmado, mas a linha da venda não foi encontrada — conferir.',
      new Date().toISOString(),
      intent.id,
    );
    return 'PIX confirmado, linha da venda não encontrada.';
  }
  if (venda.status === 'cancelled') {
    db.prepare(
      "UPDATE core_payment_intents SET status = 'paid_after_cancel', last_error = ?, updated_at = ? WHERE id = ?",
    ).run(
      'PIX pago numa venda de balcão já cancelada — decidir entre estornar e refazer a venda.',
      new Date().toISOString(),
      intent.id,
    );
    return 'PIX pago numa venda cancelada — pendente de regularização.';
  }
  return liquidarLinhaPendenteDaVenda({
    companyId: intent.company_id,
    saleId: venda.id,
    paymentId: linha.id,
    note: `Asaas ${input.providerRef}`,
    providerRef: input.providerRef,
  }).detail;
}

/**
 * VINCULA as cobranças do balcão à venda que acabou de nascer — dentro da
 * transação da venda.
 *
 * E fecha a janela entre a conferência e a gravação: se o webhook confirmou o
 * PIX nesse meio-tempo (a cobrança estava sem venda, então ele só a marcou
 * paga), a linha que entrou pendente é liquidada aqui mesmo.
 */
export function vincularPixDoBalcaoAVenda(input: { companyId: string; saleId: string }): void {
  const db = getConnection();
  const linhas = db
    .prepare(
      `SELECT id, payment_intent_id, status FROM core_sale_payments
        WHERE sale_id = ? AND company_id = ? AND payment_intent_id IS NOT NULL`,
    )
    .all(input.saleId, input.companyId) as { id: string; payment_intent_id: string; status: string }[];
  for (const linha of linhas) {
    db.prepare(
      `UPDATE core_payment_intents SET origin_id = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND origin_id LIKE '${RASCUNHO_DO_BALCAO}%'`,
    ).run(input.saleId, new Date().toISOString(), linha.payment_intent_id, input.companyId);
    const pix = intencao(input.companyId, linha.payment_intent_id);
    if (linha.status === 'pending' && pix?.status === 'confirmed') {
      liquidarLinhaPendenteDaVenda({
        companyId: input.companyId,
        saleId: input.saleId,
        paymentId: linha.id,
        note: `Asaas ${pix.provider_ref ?? ''}`.trim(),
        providerRef: pix.provider_ref,
      });
    }
  }
}
