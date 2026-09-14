/**
 * ============================================================================
 * DEVOLUÇÃO AO FORNECEDOR (GAP-PRD-089)
 * ============================================================================
 *
 * ## O que existia, e por que não servia
 *
 * `cancelPurchaseOrder` dizia "a devolução é outro caminho" — e o caminho não
 * existia. O mais próximo era `estornarNota`, que desfaz a nota INTEIRA e
 * recusa, com razão, quando a dívida já teve baixa ou quando a mercadoria já
 * saiu. A pastilha com defeito de uma compra paga e metade vendida não tinha
 * como voltar ao fornecedor: saída manual com motivo, lançamento avulso no
 * financeiro e a NF-e de devolução por fora — três gestos soltos que nada
 * amarrava à nota de origem.
 *
 * ## O documento
 *
 * Uma devolução aponta para UMA nota de entrada RECEBIDA e diz, por produto,
 * quanto volta. Três coisas acontecem na mesma transação:
 *
 *   1. ESTOQUE — saída com kind próprio (SUPPLIER_RETURN), referência própria
 *      ('devolucao_fornecedor'), o custo com que a mercadoria ENTROU e o
 *      motivo. O limite é o que a nota pôs no estoque menos o que já voltou em
 *      devoluções anteriores, e nunca mais que o DISPONÍVEL: peça reservada
 *      para um cliente não volta ao fornecedor por baixo da reserva.
 *
 *   2. FINANCEIRO — um dos três, escolhido por quem devolve e conferido aqui:
 *        abatimento     a nota ainda deve: o título em aberto DIMINUI;
 *        credito        a nota já foi paga: nasce um título a receber do
 *                       fornecedor, com origem 'devolucao_fornecedor';
 *        sem_financeiro só para nota que não gerou dívida (bonificação).
 *      O valor padrão é o das mercadorias pelo custo de entrada; quem combinou
 *      outro valor com o fornecedor (IPI, frete daquela parte) o informa, e a
 *      soma dos créditos nunca passa do total da nota.
 *
 *   3. FISCAL — a NF-e de devolução (modelo 55, finalidade 4, referenciando a
 *      chave da nota de entrada) nasce PENDENTE. O emissor do DEVORA ainda
 *      não emite devolução de compra (frente fiscal); o gancho é este: a chave
 *      da nota emitida é registrada aqui (validada: 44 dígitos, dígito
 *      verificador, modelo 55), ou declara-se que o fornecedor emite a nota de
 *      entrada dele, ou dispensa-se com justificativa. A pendência aparece na
 *      lista até ser resolvida — nunca some por silêncio.
 *
 * A nota com devolução não pode mais ser ESTORNADA (NfeImportService recusa):
 * o estorno tiraria de novo do estoque a parte que já voltou ao fornecedor.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { abaterTituloPorDevolucao, lancarCreditoDeDevolucao } from './FinanceService.js';
import { systemCategoryId } from './FinanceSetupService.js';
import { isValidAccessKey } from './FiscalKeyService.js';
import { NOTA_ESTORNADA, NOTA_RECEBIDA } from './InboundNoteStatus.js';
import { applyMovement, getAvailable } from './InventoryService.js';
import { isSerialized } from './ProductUnitService.js';

export type ModoFinanceiro = 'abatimento' | 'credito' | 'sem_financeiro';
export type SituacaoFiscal = 'pendente' | 'emitida' | 'nota_do_fornecedor' | 'dispensada';

interface NotaDaDevolucao {
  id: string;
  number: string | null;
  access_key: string;
  doc_type: string | null;
  status: string;
  supplier_id: string | null;
  total_cents: number;
}

function carregarNota(companyId: string, noteId: string): NotaDaDevolucao {
  const nota = getConnection()
    .prepare(
      `SELECT id, number, access_key, doc_type, status, supplier_id, total_cents
         FROM core_inbound_notes WHERE id = ? AND company_id = ?`,
    )
    .get(noteId, companyId) as NotaDaDevolucao | undefined;
  if (!nota) throw new ApiError('CORE_INBOUND_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);
  return nota;
}

function referenciaDaEntrada(nota: NotaDaDevolucao): string {
  return String(nota.doc_type ?? 'nfe') === 'manual' ? 'entrada_manual' : 'nfe_entrada';
}

function rotuloDaNota(nota: NotaDaDevolucao): string {
  return String(nota.doc_type ?? 'nfe') === 'manual'
    ? `Entrada manual ${nota.number ?? nota.id.slice(0, 8)}`
    : `NF-e ${nota.number ?? nota.access_key.slice(25, 34)}`;
}

/** Os títulos a pagar vivos da nota — é deles que o abatimento sai. */
function titulosDaNota(companyId: string, noteId: string) {
  return getConnection()
    .prepare(
      `SELECT id, amount_cents, settled_cents, due_date, installment_number, cancelled_at
         FROM core_finance_entries
        WHERE company_id = ? AND origin_type IN ('nfe_entrada', 'entrada_manual')
          AND origin_id = ? AND direction = 'out'`,
    )
    .all(companyId, noteId) as unknown as {
    id: string;
    amount_cents: number;
    settled_cents: number;
    due_date: string | null;
    installment_number: number;
    cancelled_at: string | null;
  }[];
}

export interface UnidadeDevolvivel {
  id: string;
  identificacao: string;
}

export interface ItemDevolvivel {
  productId: string;
  name: string;
  internalCode: string | null;
  unit: string | null;
  /** O que a nota pôs no estoque, na unidade do cadastro (lido do razão). */
  entrou: number;
  jaDevolvido: number;
  /** O saldo livre de hoje (saldo − reservado). */
  disponivel: number;
  /** O máximo que esta devolução aceita: min(entrou − já devolvido, disponível). */
  podeDevolver: number;
  unitCostCents: number;
  serializado: boolean;
  /** Para serializado: as peças DESTA nota ainda em estoque, para escolher quais voltam. */
  unidades: UnidadeDevolvivel[];
}

export interface Devolviveis {
  nota: {
    id: string;
    rotulo: string;
    accessKey: string;
    status: string;
    supplierId: string | null;
    supplierName: string | null;
    totalCents: number;
  };
  itens: ItemDevolvivel[];
  /** O que a nota ainda deve ao fornecedor (títulos vivos). */
  saldoEmAbertoCents: number;
  temTitulo: boolean;
  /** Créditos já combinados em devoluções anteriores desta nota. */
  jaCreditadoCents: number;
}

/** O que dá para devolver desta nota, hoje. */
export function itensDevolviveis(companyId: string, noteId: string): Devolviveis {
  ensureCoreSchema();
  const db = getConnection();
  const nota = carregarNota(companyId, noteId);
  const fornecedor = nota.supplier_id
    ? (db
        .prepare('SELECT COALESCE(trade_name, name) AS nome FROM core_suppliers WHERE id = ?')
        .get(nota.supplier_id) as { nome: string } | undefined)
    : undefined;

  /*
    O QUE ENTROU é lido do RAZÃO, como no estorno: a confirmação já aplicou
    conferência, fator de conversão e agrupamento por produto. Recalcular dos
    itens da nota daria outro número.
  */
  const entradas = db
    .prepare(
      `SELECT m.product_id, SUM(m.quantity) AS quantidade, MAX(m.unit_cost_cents) AS custo,
              p.name, p.internal_code, p.unit
         FROM core_stock_movements m
         JOIN core_products p ON p.id = m.product_id
        WHERE m.company_id = ? AND m.reference_type = ? AND m.reference_id = ?
          AND m.movement_type = 'in'
        GROUP BY m.product_id`,
    )
    .all(companyId, referenciaDaEntrada(nota), noteId) as unknown as {
    product_id: string;
    quantidade: number;
    custo: number | null;
    name: string;
    internal_code: string | null;
    unit: string | null;
  }[];

  const devolvidoPorProduto = new Map(
    (
      db
        .prepare(
          `SELECT i.product_id, SUM(i.quantity) AS q
             FROM core_supplier_return_items i
             JOIN core_supplier_returns r ON r.id = i.return_id
            WHERE r.company_id = ? AND r.note_id = ?
            GROUP BY i.product_id`,
        )
        .all(companyId, noteId) as unknown as { product_id: string; q: number }[]
    ).map((l) => [l.product_id, Number(l.q)]),
  );

  const itens: ItemDevolvivel[] = entradas.map((e) => {
    const entrou = Number(e.quantidade);
    const jaDevolvido = devolvidoPorProduto.get(e.product_id) ?? 0;
    const disponivel = getAvailable(companyId, e.product_id);
    const serializado = isSerialized(companyId, e.product_id);
    const unidades = serializado
      ? (
          db
            .prepare(
              `SELECT id, serial_number, imei, chassis, plate FROM core_product_units
                WHERE company_id = ? AND product_id = ? AND status = 'in_stock'
                  AND entry_reference_type = ? AND entry_reference_id = ?
                ORDER BY created_at`,
            )
            .all(companyId, e.product_id, referenciaDaEntrada(nota), noteId) as unknown as {
            id: string;
            serial_number: string | null;
            imei: string | null;
            chassis: string | null;
            plate: string | null;
          }[]
        ).map((u) => ({
          id: u.id,
          identificacao:
            [u.chassis, u.serial_number, u.imei, u.plate].filter(Boolean).join(' · ')
            || `sem identificação (${u.id.slice(0, 8)})`,
        }))
      : [];
    return {
      productId: e.product_id,
      name: e.name,
      internalCode: e.internal_code,
      unit: e.unit,
      entrou,
      jaDevolvido,
      disponivel,
      podeDevolver: Math.max(0, Math.min(entrou - jaDevolvido, disponivel)),
      unitCostCents: Number(e.custo ?? 0),
      serializado,
      unidades,
    };
  });

  const titulos = titulosDaNota(companyId, noteId).filter((t) => !t.cancelled_at);
  const jaCreditado = db
    .prepare(
      'SELECT COALESCE(SUM(credit_cents), 0) AS c FROM core_supplier_returns WHERE company_id = ? AND note_id = ?',
    )
    .get(companyId, noteId) as { c: number };

  return {
    nota: {
      id: nota.id,
      rotulo: rotuloDaNota(nota),
      accessKey: nota.access_key,
      status: nota.status,
      supplierId: nota.supplier_id,
      supplierName: fornecedor?.nome ?? null,
      totalCents: Number(nota.total_cents ?? 0),
    },
    itens,
    saldoEmAbertoCents: titulos.reduce(
      (s, t) => s + Math.max(0, Number(t.amount_cents) - Number(t.settled_cents)),
      0,
    ),
    temTitulo: titulos.length > 0,
    jaCreditadoCents: Number(jaCreditado.c),
  };
}

export interface ItemDaDevolucaoInput {
  productId: string;
  quantity: number;
  /** Obrigatório para produto serializado: QUAIS peças voltam. */
  unitIds?: string[];
}

export function registrarDevolucao(input: {
  companyId: string;
  userId: string;
  noteId: string;
  reason: string;
  items: ItemDaDevolucaoInput[];
  financeMode: ModoFinanceiro;
  /** Valor combinado do crédito/abatimento; omitido = valor das mercadorias. */
  creditCents?: number | null;
  /** Vencimento do crédito a receber (modo 'credito'); omitido = hoje + 30. */
  dueDate?: string | null;
}): DevolucaoDetalhe {
  ensureCoreSchema();
  const motivo = String(input.reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError(
      'CORE_SUPPLIER_RETURN_REASON_REQUIRED',
      'Informe o motivo da devolução — defeito, sobra, item trocado. É ele que explica a saída.',
      400,
    );
  }
  if (!['abatimento', 'credito', 'sem_financeiro'].includes(input.financeMode)) {
    throw new ApiError(
      'CORE_SUPPLIER_RETURN_FINANCE_MODE',
      'Escolha como o financeiro fica: abater da dívida da nota, crédito a receber do fornecedor, '
        + 'ou sem efeito (só para nota que não gerou dívida).',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const nota = carregarNota(input.companyId, input.noteId);
    if (nota.status === NOTA_ESTORNADA) {
      throw new ApiError(
        'CORE_NOTE_REVERSED',
        'Nota estornada não tem o que devolver: a entrada dela já foi desfeita.',
        409,
      );
    }
    if (nota.status !== NOTA_RECEBIDA) {
      throw new ApiError(
        'CORE_NOTE_NOT_RECEIVED',
        'Só nota recebida tem mercadoria para devolver — esta ainda está em conferência. '
          + 'Na conferência, o que não veio é informado como recebido a menos.',
        409,
      );
    }

    const devolviveis = itensDevolviveis(input.companyId, input.noteId);
    const porProduto = new Map(devolviveis.itens.map((i) => [i.productId, i]));

    // O mesmo produto repetido na requisição é UMA linha: somar antes de conferir.
    const pedidos = new Map<string, { quantidade: number; unitIds: string[] }>();
    for (const item of Array.isArray(input.items) ? input.items : []) {
      const quantidade = Number(item.quantity);
      if (!item.productId || !Number.isFinite(quantidade) || quantidade <= 0) continue;
      const antes = pedidos.get(String(item.productId));
      pedidos.set(String(item.productId), {
        quantidade: (antes?.quantidade ?? 0) + quantidade,
        unitIds: [...(antes?.unitIds ?? []), ...(Array.isArray(item.unitIds) ? item.unitIds.map(String) : [])],
      });
    }
    if (pedidos.size === 0) {
      throw new ApiError(
        'CORE_SUPPLIER_RETURN_EMPTY',
        'Informe ao menos um item com quantidade a devolver.',
        400,
      );
    }

    /*
      TODAS AS LINHAS CONFERIDAS ANTES DA PRIMEIRA ESCRITA, e a recusa nomeia
      todas — a regra da confirmação e do estorno: quem está com o problema na
      mão resolve tudo de uma vez.
    */
    const problemas: string[] = [];
    for (const [productId, pedido] of pedidos) {
      const item = porProduto.get(productId);
      if (!item) {
        problemas.push(`o produto ${productId.slice(0, 8)} não entrou no estoque por esta nota`);
        continue;
      }
      const restante = item.entrou - item.jaDevolvido;
      if (pedido.quantidade > restante + 1e-9) {
        problemas.push(
          `"${item.name}": a nota pôs ${item.entrou} e já voltaram ${item.jaDevolvido} — `
            + `cabe devolver no máximo ${restante}`,
        );
      } else if (pedido.quantidade > item.disponivel + 1e-9) {
        problemas.push(
          `"${item.name}": só ${item.disponivel} livre(s) no estoque agora (o resto foi vendido `
            + 'ou está reservado)',
        );
      }
      if (item.serializado && pedido.unitIds.length !== pedido.quantidade) {
        problemas.push(
          `"${item.name}" é controlado por unidade: escolha exatamente ${pedido.quantidade} `
            + 'peça(s) desta nota',
        );
      }
      if (item.serializado) {
        const daNota = new Set(item.unidades.map((u) => u.id));
        const fora = pedido.unitIds.filter((u) => !daNota.has(u));
        if (fora.length > 0) {
          problemas.push(`"${item.name}": ${fora.length} peça(s) escolhida(s) não são desta nota ou já saíram`);
        }
      }
    }
    if (problemas.length > 0) {
      throw new ApiError(
        'CORE_SUPPLIER_RETURN_INVALID_ITEMS',
        `A devolução não fecha: ${problemas.join('; ')}.`,
        409,
        { itens: problemas },
      );
    }

    const linhas = [...pedidos].map(([productId, pedido]) => {
      const item = porProduto.get(productId)!;
      return {
        productId,
        nome: item.name,
        quantidade: pedido.quantidade,
        unitIds: item.serializado ? pedido.unitIds : undefined,
        custo: item.unitCostCents,
        total: Math.round(pedido.quantidade * item.unitCostCents),
      };
    });
    const mercadorias = linhas.reduce((s, l) => s + l.total, 0);

    const credito =
      input.financeMode === 'sem_financeiro'
        ? 0
        : input.creditCents === undefined || input.creditCents === null
          ? mercadorias
          : Math.round(Number(input.creditCents));
    if (input.financeMode !== 'sem_financeiro') {
      if (!Number.isInteger(credito) || credito <= 0) {
        throw new ApiError(
          'CORE_SUPPLIER_RETURN_CREDIT_INVALID',
          'O valor do crédito com o fornecedor tem de ser maior que zero.',
          400,
        );
      }
      const teto = Number(nota.total_cents ?? 0) - devolviveis.jaCreditadoCents;
      if (credito > teto) {
        throw new ApiError(
          'CORE_SUPPLIER_RETURN_CREDIT_EXCEEDS_NOTE',
          `O crédito (${(credito / 100).toFixed(2)}) passa do que a nota ainda comporta `
            + `(${(teto / 100).toFixed(2)}): a soma das devoluções não pode passar do total da nota.`,
          409,
        );
      }
    }

    const titulosVivos = titulosDaNota(input.companyId, input.noteId).filter((t) => !t.cancelled_at);
    const saldoAberto = titulosVivos.reduce(
      (s, t) => s + Math.max(0, Number(t.amount_cents) - Number(t.settled_cents)),
      0,
    );
    if (input.financeMode === 'sem_financeiro' && titulosVivos.length > 0) {
      throw new ApiError(
        'CORE_SUPPLIER_RETURN_FINANCE_REQUIRED',
        'Esta nota gerou dívida com o fornecedor: a devolução tem de abater o título ou virar '
          + 'crédito a receber. "Sem efeito financeiro" é só para nota sem dívida (bonificação).',
        409,
      );
    }
    if (input.financeMode === 'abatimento' && saldoAberto < credito) {
      throw new ApiError(
        'CORE_SUPPLIER_RETURN_OPEN_BALANCE',
        saldoAberto === 0
          ? 'A dívida desta nota já está paga: não há o que abater. Registre como crédito a receber do fornecedor.'
          : `A nota deve só ${(saldoAberto / 100).toFixed(2)} ao fornecedor — menos que o crédito `
            + `(${(credito / 100).toFixed(2)}). Abata um valor menor ou registre como crédito a receber.`,
        409,
        { saldoAbertoCents: saldoAberto },
      );
    }

    const id = randomUUID();
    const numero = nextSequenceValue(input.companyId, 'supplier_return');
    const agora = new Date().toISOString();
    const rotulo = `Devolução #${numero} — ${rotuloDaNota(nota)}`;

    // 1. ESTOQUE — uma saída por produto, com referência própria.
    for (const l of linhas) {
      applyMovement({
        companyId: input.companyId,
        productId: l.productId,
        movementType: 'out',
        quantity: l.quantidade,
        referenceType: 'devolucao_fornecedor',
        referenceId: `${id}:${l.productId}`,
        kind: 'SUPPLIER_RETURN',
        documentNumber: rotulo,
        unitCostCents: l.custo,
        userId: input.userId,
        reason: motivo,
        note: `Devolvido ao fornecedor — ${rotuloDaNota(nota)}`,
        unitIds: l.unitIds,
      });
    }

    db.prepare(
      `INSERT INTO core_supplier_returns
         (id, company_id, number, note_id, supplier_id, reason, goods_cents, credit_cents,
          finance_mode, fiscal_status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
    ).run(
      id,
      input.companyId,
      numero,
      input.noteId,
      nota.supplier_id,
      motivo,
      mercadorias,
      credito,
      input.financeMode,
      input.userId,
      agora,
    );
    const inserirItem = db.prepare(
      `INSERT INTO core_supplier_return_items
         (id, return_id, company_id, product_id, quantity, unit_cost_cents, total_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of linhas) {
      inserirItem.run(randomUUID(), id, input.companyId, l.productId, l.quantidade, l.custo, l.total, agora);
    }

    // 2. FINANCEIRO.
    if (input.financeMode === 'abatimento') {
      /*
        DAS ÚLTIMAS PARCELAS PARA AS PRIMEIRAS: a mercadoria que voltou reduz o
        que falta pagar lá na frente, e a parcela que vence amanhã continua
        sendo a que foi combinada — é o que o fornecedor espera receber.
      */
      const ordem = [...titulosVivos].sort(
        (a, b) =>
          String(b.due_date ?? '').localeCompare(String(a.due_date ?? ''))
          || Number(b.installment_number) - Number(a.installment_number),
      );
      let falta = credito;
      const detalhe: { entryId: string; abatidoCents: number; antesCents: number; depoisCents: number; cancelado: boolean }[] = [];
      for (const t of ordem) {
        if (falta <= 0) break;
        const aberto = Math.max(0, Number(t.amount_cents) - Number(t.settled_cents));
        if (aberto <= 0) continue;
        const abate = Math.min(aberto, falta);
        const r = abaterTituloPorDevolucao({
          companyId: input.companyId,
          entryId: t.id,
          amountCents: abate,
          observacao: `Abatido ${(abate / 100).toFixed(2).replace('.', ',')} pela devolução #${numero}`,
        });
        detalhe.push({ entryId: t.id, abatidoCents: abate, ...r });
        falta -= abate;
      }
      db.prepare('UPDATE core_supplier_returns SET finance_entry_id = ?, finance_detail = ? WHERE id = ?').run(
        detalhe[0]?.entryId ?? null,
        JSON.stringify(detalhe),
        id,
      );
    } else if (input.financeMode === 'credito') {
      const vencimento = String(input.dueDate ?? '').trim() || somarDias(hojeNaLoja(), 30);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) {
        throw new ApiError('CORE_SUPPLIER_RETURN_DUE_DATE', 'Vencimento do crédito inválido (use AAAA-MM-DD).', 400);
      }
      const entryId = lancarCreditoDeDevolucao({
        companyId: input.companyId,
        returnId: id,
        supplierId: nota.supplier_id,
        amountCents: credito,
        dueDate: vencimento,
        description: `Crédito da devolução #${numero} — ${rotuloDaNota(nota)}`,
        /*
          "Outras receitas" é a categoria de SISTEMA do lado de entrada que não
          é venda nem serviço. A classificação contábil do crédito de
          devolução (redutor de compras × receita) é decisão do contador: a
          categoria é editável no título, e o DRE a mostra pelo nome.
        */
        categoryId: systemCategoryId(input.companyId, 'outras_receitas'),
      });
      db.prepare('UPDATE core_supplier_returns SET finance_entry_id = ? WHERE id = ?').run(entryId, id);
    }

    return getDevolucao(input.companyId, id);
  });
}

export interface DevolucaoResumo {
  id: string;
  number: number;
  noteId: string;
  noteLabel: string;
  noteAccessKey: string;
  supplierName: string | null;
  reason: string;
  goodsCents: number;
  creditCents: number;
  financeMode: ModoFinanceiro;
  fiscalStatus: SituacaoFiscal;
  fiscalAccessKey: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface DevolucaoDetalhe extends DevolucaoResumo {
  items: {
    productId: string;
    name: string;
    internalCode: string | null;
    quantity: number;
    unitCostCents: number;
    totalCents: number;
  }[];
  financeEntryId: string | null;
  financeDetail: { entryId: string; abatidoCents: number; antesCents: number; depoisCents: number; cancelado: boolean }[];
  fiscalNote: string | null;
  /** O que falta do lado fiscal, em palavras — nulo quando resolvido. */
  pendenciaFiscal: string | null;
}

const SELECT_DEVOLUCAO = `
  SELECT r.*, n.number AS note_number, n.access_key AS note_access_key, n.doc_type AS note_doc_type,
         COALESCE(s.trade_name, s.name) AS supplier_name, u.display_name AS created_by_name
    FROM core_supplier_returns r
    JOIN core_inbound_notes n ON n.id = r.note_id
    LEFT JOIN core_suppliers s ON s.id = r.supplier_id
    LEFT JOIN core_users u ON u.id = r.created_by`;

function resumo(row: Record<string, unknown>): DevolucaoResumo {
  const manual = String(row.note_doc_type ?? 'nfe') === 'manual';
  return {
    id: String(row.id),
    number: Number(row.number),
    noteId: String(row.note_id),
    noteLabel: manual
      ? `Entrada manual ${row.note_number ?? ''}`.trim()
      : `NF-e ${row.note_number ?? String(row.note_access_key).slice(25, 34)}`,
    noteAccessKey: String(row.note_access_key),
    supplierName: (row.supplier_name as string | null) ?? null,
    reason: String(row.reason),
    goodsCents: Number(row.goods_cents),
    creditCents: Number(row.credit_cents),
    financeMode: row.finance_mode as ModoFinanceiro,
    fiscalStatus: row.fiscal_status as SituacaoFiscal,
    fiscalAccessKey: (row.fiscal_access_key as string | null) ?? null,
    createdAt: String(row.created_at),
    createdByName: (row.created_by_name as string | null) ?? null,
  };
}

function pendenciaFiscal(r: DevolucaoResumo, manual: boolean): string | null {
  if (r.fiscalStatus !== 'pendente') return null;
  if (manual) {
    return 'A compra entrou sem nota fiscal (entrada manual): confirme com o contador se a '
      + 'devolução precisa de documento fiscal e registre a decisão.';
  }
  return 'Emitir a NF-e de devolução (modelo 55, finalidade 4 — devolução) referenciando a chave '
    + `${r.noteAccessKey}. O emissor do sistema ainda não emite devolução de compra: emita pelo `
    + 'emissor do contador e registre aqui a chave da nota — ou, se o fornecedor emitir a nota de '
    + 'entrada dele, registre isso.';
}

export function getDevolucao(companyId: string, id: string): DevolucaoDetalhe {
  ensureCoreSchema();
  const db = getConnection();
  const row = db.prepare(`${SELECT_DEVOLUCAO} WHERE r.id = ? AND r.company_id = ?`).get(id, companyId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new ApiError('CORE_SUPPLIER_RETURN_NOT_FOUND', 'Devolução não encontrada.', 404);
  }
  const base = resumo(row);
  const items = (
    db
      .prepare(
        `SELECT i.product_id, p.name, p.internal_code, i.quantity, i.unit_cost_cents, i.total_cents
           FROM core_supplier_return_items i
           JOIN core_products p ON p.id = i.product_id
          WHERE i.return_id = ? ORDER BY p.name`,
      )
      .all(id) as unknown as Record<string, unknown>[]
  ).map((i) => ({
    productId: String(i.product_id),
    name: String(i.name),
    internalCode: (i.internal_code as string | null) ?? null,
    quantity: Number(i.quantity),
    unitCostCents: Number(i.unit_cost_cents),
    totalCents: Number(i.total_cents),
  }));
  let financeDetail: DevolucaoDetalhe['financeDetail'];
  try {
    financeDetail = row.finance_detail ? JSON.parse(String(row.finance_detail)) : [];
  } catch {
    // Detalhe ilegível não derruba a ficha: o documento e os itens valem sozinhos.
    financeDetail = [];
  }
  return {
    ...base,
    items,
    financeEntryId: (row.finance_entry_id as string | null) ?? null,
    financeDetail,
    fiscalNote: (row.fiscal_note as string | null) ?? null,
    pendenciaFiscal: pendenciaFiscal(base, String(row.note_doc_type ?? 'nfe') === 'manual'),
  };
}

export function listarDevolucoes(
  companyId: string,
  filtros: { noteId?: string; fiscalStatus?: string } = {},
): DevolucaoResumo[] {
  ensureCoreSchema();
  let sql = `${SELECT_DEVOLUCAO} WHERE r.company_id = ?`;
  const params: string[] = [companyId];
  if (filtros.noteId) {
    sql += ' AND r.note_id = ?';
    params.push(filtros.noteId);
  }
  if (filtros.fiscalStatus) {
    sql += ' AND r.fiscal_status = ?';
    params.push(filtros.fiscalStatus);
  }
  sql += ' ORDER BY r.number DESC LIMIT 200';
  return (getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[]).map(resumo);
}

/**
 * O GANCHO FISCAL: registrar o que aconteceu com o documento da devolução.
 *
 *   emitida             a NF-e de devolução existe — a chave é obrigatória,
 *                       conferida (44 dígitos, DV, modelo 55) e não pode ser
 *                       a própria chave da nota de entrada;
 *   nota_do_fornecedor  o fornecedor emite a nota de entrada dele (a chave é
 *                       opcional — ele manda quando emitir);
 *   dispensada          sem documento, com justificativa (troca em garantia
 *                       combinada com o contador, por exemplo).
 */
export function registrarSituacaoFiscal(input: {
  companyId: string;
  userId: string;
  id: string;
  status: SituacaoFiscal;
  accessKey?: string | null;
  note?: string | null;
}): DevolucaoDetalhe {
  ensureCoreSchema();
  const atual = getDevolucao(input.companyId, input.id);
  const chave = String(input.accessKey ?? '').replace(/\D/g, '');
  const nota = String(input.note ?? '').trim();

  if (!['emitida', 'nota_do_fornecedor', 'dispensada'].includes(input.status)) {
    throw new ApiError(
      'CORE_SUPPLIER_RETURN_FISCAL_STATUS',
      'Situação fiscal inválida: use emitida, nota_do_fornecedor ou dispensada.',
      400,
    );
  }
  if (input.status === 'emitida' || (input.status === 'nota_do_fornecedor' && chave)) {
    if (!isValidAccessKey(chave) || chave.slice(20, 22) !== '55') {
      throw new ApiError(
        'CORE_SUPPLIER_RETURN_ACCESS_KEY',
        'A chave informada não é de uma NF-e válida: são 44 dígitos, modelo 55, com o dígito '
          + 'verificador certo. Copie-a do DANFE ou do XML da nota de devolução.',
        400,
      );
    }
    if (chave === atual.noteAccessKey) {
      throw new ApiError(
        'CORE_SUPPLIER_RETURN_ACCESS_KEY',
        'Esta é a chave da nota de ENTRADA. Informe a chave da nota de devolução, que é outra.',
        400,
      );
    }
  }
  if (input.status === 'dispensada' && nota.length < 3) {
    throw new ApiError(
      'CORE_SUPPLIER_RETURN_FISCAL_NOTE',
      'Diga por que a devolução fica sem documento fiscal — é essa frase que o contador vai ler.',
      400,
    );
  }

  getConnection()
    .prepare(
      `UPDATE core_supplier_returns
          SET fiscal_status = ?, fiscal_access_key = ?, fiscal_note = ?,
              fiscal_updated_by = ?, fiscal_updated_at = ?
        WHERE id = ? AND company_id = ?`,
    )
    .run(
      input.status,
      chave || null,
      nota || null,
      input.userId,
      new Date().toISOString(),
      input.id,
      input.companyId,
    );
  return getDevolucao(input.companyId, input.id);
}

/** A nota tem devolução? — a pergunta do estorno. */
export function notaTemDevolucao(companyId: string, noteId: string): boolean {
  ensureCoreSchema();
  return Boolean(
    getConnection()
      .prepare('SELECT 1 FROM core_supplier_returns WHERE company_id = ? AND note_id = ? LIMIT 1')
      .get(companyId, noteId),
  );
}
