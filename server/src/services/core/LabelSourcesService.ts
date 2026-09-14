/**
 * De onde vem a lista de produtos a etiquetar.
 *
 * A tela antiga tinha uma origem só — busca no catálogo — e a quantidade era
 * digitada item a item. Etiquetar uma nota de compra de 60 itens era digitar
 * 60 vezes um número que o próprio sistema já conhecia.
 *
 * As sete origens aqui existem porque cada uma corresponde a um momento real
 * da loja em que se precisa de etiqueta:
 *
 * | origem       | o momento                                              |
 * |--------------|--------------------------------------------------------|
 * | `catalogo`   | trocou o preço de um item, quer reetiquetar            |
 * | `estoque`    | vai etiquetar tudo que está na prateleira              |
 * | `compra`     | chegou mercadoria de um pedido de compra               |
 * | `nota`       | confirmou uma nota de entrada (com ou sem pedido)      |
 * | `inventario` | contou e achou peça sem etiqueta                       |
 * | `codigos`    | tem uma lista pronta, colada de planilha               |
 * | `grade`      | etiquetar todos os tamanhos e cores de um modelo       |
 *
 * ## Item problemático não derruba o lote
 *
 * Toda origem devolve `candidates` e `problemas` separados. A rotina de
 * plaquinha de oficina faz o contrário — um equipamento sem plaqueta lança
 * 409 de dentro do `map` e derruba os outros — e o resultado é que o operador
 * não consegue imprimir nada até caçar o item ruim. Aqui o que dá para
 * etiquetar vai, e o que não dá aparece com o motivo escrito.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { desenhoDoCodigo } from './Ean13.js';
import { NOTA_ESTORNADA, NOTA_RECEBIDA } from './InboundNoteStatus.js';
import { SQL_ABAIXO_DO_MINIMO } from './InventoryService.js';
import { effectivePriceCents } from './PricingService.js';

export type LabelSource = 'catalogo' | 'estoque' | 'compra' | 'nota' | 'inventario' | 'codigos' | 'grade';

export const LABEL_SOURCES: {
  id: LabelSource;
  label: string;
  hint: string;
  /** A origem sabe sugerir quantidade a partir de um documento? */
  temQuantidadeDeDocumento: boolean;
}[] = [
  {
    id: 'catalogo',
    label: 'Buscar no catálogo',
    hint: 'Por nome, código interno ou código de barras. A fila guarda o que você marcou entre uma busca e outra.',
    temQuantidadeDeDocumento: false,
  },
  {
    id: 'estoque',
    label: 'Posição de estoque',
    hint: 'O que está na prateleira agora. Dá para filtrar só o que está abaixo do mínimo.',
    temQuantidadeDeDocumento: false,
  },
  {
    id: 'compra',
    label: 'Pedido de compra',
    hint: 'O que chegou na ÚLTIMA entrega do pedido. Para etiquetar outra entrega, use "Nota de entrada".',
    temQuantidadeDeDocumento: true,
  },
  {
    id: 'nota',
    label: 'Nota de entrada',
    hint: 'O que entrou numa nota confirmada (XML ou entrada manual), com ou sem pedido. A quantidade é a desta nota, na unidade do cadastro.',
    temQuantidadeDeDocumento: true,
  },
  {
    id: 'inventario',
    label: 'Contagem de inventário',
    hint: 'O que foi contado. A quantidade vem da contagem.',
    temQuantidadeDeDocumento: true,
  },
  {
    id: 'codigos',
    label: 'Códigos colados',
    hint: 'Cole uma lista de códigos, um por linha. Repetir o código pede mais uma etiqueta.',
    // A lista colada É o documento: repetir a peça três vezes é pedir três
    // etiquetas. Sem isto, a soma de repetições existiria e seria inalcançável,
    // porque só o modo "documento" a usa.
    temQuantidadeDeDocumento: true,
  },
  {
    id: 'grade',
    label: 'Grade do modelo',
    hint: 'Todos os tamanhos e cores de um modelo, de uma vez.',
    temQuantidadeDeDocumento: false,
  },
];

/**
 * Como se decide quantas etiquetas sair de cada item.
 *
 * O modo REESCREVE a coluna de quantidade da fila; depois disso cada linha
 * continua editável à mão. É a diferença entre "preencher para mim" e "decidir
 * por mim" — a segunda coisa irrita quem conhece a própria loja.
 */
export const QUANTITY_MODES: {
  id: 'manual' | 'saldo' | 'documento';
  label: string;
  hint: string;
}[] = [
  {
    id: 'manual',
    label: 'Digitar a quantidade',
    hint: 'Uma etiqueta por item; você ajusta linha a linha.',
  },
  {
    id: 'saldo',
    label: 'Usar o saldo em estoque',
    hint: 'Uma etiqueta para cada peça que existe na prateleira (até 200 por item).',
  },
  {
    id: 'documento',
    label: 'Usar a quantidade do documento',
    hint: 'O que chegou na compra ou na nota, o que foi contado no inventário, ou quantas vezes o código foi colado.',
  },
];

export interface LabelCandidate {
  productId: string;
  name: string;
  internalCode: string;
  barcode: string | null;
  /**
   * O preço VIGENTE — o que a etiqueta vai imprimir e o caixa vai cobrar.
   *
   * A fila mostrava o preço de tabela e a folha saía com o promocional: a
   * conferência antes de imprimir dizia R$ 59,90 e o adesivo, R$ 49,90. O
   * aviso de promoção só aparecia depois de a folha estar gerada.
   */
  priceCents: number;
  /** Preço de tabela, para a fila dizer "promoção; tabela R$ X". */
  listPriceCents: number;
  onSale: boolean;
  /** Saldo atual — alimenta o modo de quantidade "usar o saldo". */
  stockQuantity: number;
  /** Quantidade do documento de origem, quando a origem tem um. */
  documentQuantity: number | null;
  /**
   * O código cadastrado que a etiqueta NÃO consegue desenhar (verificador
   * errado, caractere fora do código de barras) — a fila avisa antes de
   * gastar adesivo, em vez de o papel sair com "código inválido".
   */
  avisoDoCodigo: string | null;
}

export interface LabelProblem {
  descricao: string;
  motivo: string;
}

export interface LabelCandidates {
  source: LabelSource;
  candidates: LabelCandidate[];
  problemas: LabelProblem[];
  /** A busca foi cortada no limite — a tela avisa em vez de mentir. */
  truncado: boolean;
}

/** Limite de candidatos por consulta. Acima disto a tela avisa que cortou. */
const LIMITE = 300;

/**
 * `temFilhos` identifica o MODELO de uma grade — o mesmo critério da busca do
 * PDV, que o exclui (CatalogService): quem sai da prateleira é o tamanho.
 */
const SELECT_BASE = `SELECT p.id AS productId, p.name, p.internal_code AS internalCode,
                            p.barcode, p.price_cents AS priceCents, p.category,
                            COALESCE(s.quantity, 0) AS stockQuantity,
                            EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS temFilhos
                       FROM core_products p
                       LEFT JOIN core_stock s
                         ON s.product_id = p.id AND s.company_id = p.company_id`;

interface LinhaBase {
  productId: string;
  name: string;
  internalCode: string;
  barcode: string | null;
  priceCents: number;
  category: string | null;
  stockQuantity: number;
  temFilhos: number;
}

function avisoDoCodigo(barcode: string | null): string | null {
  if (!barcode) return null;
  const d = desenhoDoCodigo(barcode);
  return d.ok ? null : `Código ${barcode}: ${d.motivo}. A etiqueta sai sem barras até o cadastro ser corrigido.`;
}

/** A linha do banco vira candidato com o preço que o caixa cobra. */
function candidato(companyId: string, l: LinhaBase, documentQuantity: number | null): LabelCandidate {
  const vigente = effectivePriceCents(companyId, l.productId, l.priceCents, l.category);
  return {
    productId: l.productId,
    name: l.name,
    internalCode: l.internalCode ?? '',
    barcode: l.barcode,
    priceCents: vigente.priceCents,
    listPriceCents: l.priceCents,
    onSale: vigente.onSale,
    stockQuantity: l.stockQuantity,
    documentQuantity,
    avisoDoCodigo: avisoDoCodigo(l.barcode),
  };
}

const MOTIVO_MODELO_DA_GRADE =
  'É o modelo de uma grade: nenhuma peça é vendida com o código dele, e o caixa não o acharia. '
  + 'Etiquete as variantes pela origem "Grade do modelo".';

/**
 * O MODELO de uma grade vai para os problemas, não para a fila.
 *
 * DEFEITO QUE ISTO CORRIGE: catálogo, estoque e códigos colados traziam o
 * modelo junto com as variantes. "Marcar todos" imprimia a etiqueta
 * "Camiseta Básica" com um EAN novo gravado no modelo — e no caixa o bipe
 * respondia "produto não encontrado", porque a busca do PDV exclui o modelo.
 * A origem "Grade" já fazia isso; agora todas fazem.
 */
function separarModelos(companyId: string, linhas: LinhaBase[]): { candidates: LabelCandidate[]; problemas: LabelProblem[] } {
  const candidates: LabelCandidate[] = [];
  const problemas: LabelProblem[] = [];
  for (const l of linhas) {
    if (l.temFilhos) problemas.push({ descricao: l.name, motivo: MOTIVO_MODELO_DA_GRADE });
    else candidates.push(candidato(companyId, l, null));
  }
  return { candidates, problemas };
}

// ------------------------------------------------------------------ catálogo

function daBusca(companyId: string, termo: string): LabelCandidates {
  const t = `%${termo.trim()}%`;
  const linhas = getConnection()
    .prepare(
      `${SELECT_BASE}
        WHERE p.company_id = ? AND p.active = 1
          AND (p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?
               OR EXISTS (SELECT 1 FROM core_product_barcodes b
                           WHERE b.product_id = p.id AND b.barcode = ?))
        ORDER BY p.name COLLATE NOCASE
        LIMIT ?`,
    )
    .all(companyId, t, t, termo.trim(), termo.trim(), LIMITE + 1) as unknown as LinhaBase[];
  return {
    source: 'catalogo',
    ...separarModelos(companyId, linhas.slice(0, LIMITE)),
    truncado: linhas.length > LIMITE,
  };
}

// ------------------------------------------------------------------- estoque

/**
 * Consulta própria em vez de `listStock`.
 *
 * `listStock` não devolve o código de barras, e reaproveitá-lo obrigava a
 * mandar `barcode: null` para todo mundo — a tela então carimbava "gera código
 * ao imprimir" em produto que JÁ tinha código. O aviso perdia o sentido
 * justamente por aparecer sempre.
 */
function doEstoque(companyId: string, lowOnly: boolean): LabelCandidates {
  /*
    A MESMA régua de "abaixo do mínimo" do resto da casa (rodada 55).

    A conta que estava aqui olhava o saldo BRUTO com `<=`: produto sem mínimo
    declarado e sem saldo entrava na lista, porque 0 <= 0 — e quem abre esta
    origem para imprimir etiqueta do que está acabando recebia o catálogo
    inteiro de itens zerados. Era a terceira de três definições diferentes para
    a mesma pergunta.
  */
  const filtro = lowOnly ? ` AND ${SQL_ABAIXO_DO_MINIMO}` : '';
  const linhas = getConnection()
    .prepare(
      `${SELECT_BASE}
        WHERE p.company_id = ? AND p.active = 1${filtro}
        ORDER BY p.name COLLATE NOCASE
        LIMIT ?`,
    )
    .all(companyId, LIMITE + 1) as unknown as LinhaBase[];
  return {
    source: 'estoque',
    ...separarModelos(companyId, linhas.slice(0, LIMITE)),
    truncado: linhas.length > LIMITE,
  };
}

// -------------------------------------------------------------------- compra

/**
 * A ÚLTIMA ENTREGA DO PEDIDO — a nota recebida mais recente amarrada a ele.
 *
 * DEFEITO QUE ISTO CORRIGE (B-estoque-entrada-20 / C-etiquetas-R02): a conta
 * era feita POR PRODUTO — "a última nota que trouxe ESTE produto". Num pedido
 * de parafuso e porca entregue em duas notas (nota 1: parafuso 40 e porca 10;
 * nota 2: só parafuso 60), a origem sugeria parafuso 60, que é a segunda
 * entrega, e também porca 10, que é a PRIMEIRA: dez adesivos repetidos de
 * mercadoria já etiquetada, contra a própria dica da origem ("o que chegou na
 * ÚLTIMA entrega do pedido"). A entrega é uma só para o pedido inteiro, e é
 * achada uma vez, aqui. Nula quando nenhuma nota recebida está amarrada ao
 * pedido (o recebimento veio por outro caminho).
 */
function ultimaEntregaDoPedido(companyId: string, orderId: string): { id: string; number: string | null } | null {
  const r = getConnection()
    .prepare(
      `SELECT n.id, n.number
         FROM core_inbound_notes n
        WHERE n.company_id = ? AND n.purchase_order_id = ? AND n.status = ?
        ORDER BY COALESCE(n.received_at, n.created_at) DESC, n.rowid DESC
        LIMIT 1`,
    )
    .get(companyId, orderId, NOTA_RECEBIDA) as { id: string; number: string | null } | undefined;
  return r ?? null;
}

/**
 * Quanto deste produto entrou NESSA nota — lido do razão, que já está na
 * unidade do cadastro. Nulo quando a nota não trouxe o produto.
 */
function quantidadeNaEntrega(companyId: string, noteId: string, productId: string): number | null {
  const r = getConnection()
    .prepare(
      `SELECT SUM(m.quantity) AS q
         FROM core_stock_movements m
        WHERE m.company_id = ? AND m.reference_id = ? AND m.product_id = ?
          AND m.movement_type = 'in'
          AND m.reference_type IN ('nfe_entrada', 'entrada_manual')`,
    )
    .get(companyId, noteId, productId) as { q: number | null } | undefined;
  const q = r?.q ?? null;
  return q !== null && q > 0 ? q : null;
}

function doPedidoDeCompra(companyId: string, orderId: string): LabelCandidates {
  const db = getConnection();
  const pedido = db
    .prepare('SELECT id FROM core_purchase_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId);
  if (!pedido) {
    throw new ApiError('CORE_PURCHASE_ORDER_NOT_FOUND', 'Pedido de compra não encontrado.', 404);
  }

  const itens = db
    .prepare(
      `SELECT i.product_id AS productId, i.description, i.quantity, i.received_quantity,
              p.name, p.internal_code AS internalCode, p.barcode, p.price_cents AS priceCents,
              p.category, COALESCE(s.quantity, 0) AS stockQuantity,
              EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS temFilhos
         FROM core_purchase_order_items i
         LEFT JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
         LEFT JOIN core_stock s ON s.product_id = i.product_id AND s.company_id = i.company_id
        WHERE i.order_id = ? AND i.company_id = ?
        ORDER BY i.created_at`,
    )
    .all(orderId, companyId) as unknown as (Omit<LinhaBase, 'name' | 'productId'> & {
    productId: string | null;
    name: string | null;
    description: string;
    quantity: number;
    received_quantity: number;
  })[];

  const candidates: LabelCandidate[] = [];
  const problemas: LabelProblem[] = [];
  // Uma vez para o pedido inteiro: a última entrega é do PEDIDO, não de cada produto.
  const ultimaEntrega = ultimaEntregaDoPedido(companyId, orderId);
  for (const i of itens) {
    // Item do PEDIDO sem produto no cadastro. A frase dizia "item da nota" e
    // mandava vincular na Entrada de notas — onde este item não existe.
    if (!i.productId || !i.name) {
      problemas.push({
        descricao: i.description,
        motivo: 'Item do pedido sem produto no cadastro. Vincule o item a um produto no pedido de compra (Compras › Pedidos) para etiquetar.',
      });
      continue;
    }
    if (i.temFilhos) {
      problemas.push({ descricao: i.name, motivo: MOTIVO_MODELO_DA_GRADE });
      continue;
    }
    /*
      O QUE CHEGOU NESTA ENTREGA, e não o pedido nem o acumulado.

      DEFEITO QUE ISTO CORRIGE: sem nada recebido, a sugestão era a quantidade
      PEDIDA — etiqueta para mercadoria que não está na mão. Com o pedido
      entregue em duas notas (40 e 60), a sugestão era o RECEBIDO ACUMULADO
      (100): na segunda entrega saíam 40 adesivos a mais, duplicando os já
      colados. Agora: nada recebido vai para os problemas; recebido, a
      sugestão é a quantidade da ÚLTIMA nota amarrada ao pedido (do razão, na
      unidade do cadastro) — e cada entrega tem a sua origem própria, "Nota
      de entrada".
    */
    if (!(i.received_quantity > 0)) {
      problemas.push({
        descricao: i.name,
        motivo: 'Nada deste item chegou ainda: não há mercadoria na mão para etiquetar. Quando a nota entrar, use a origem "Nota de entrada".',
      });
      continue;
    }
    /*
      O ITEM QUE NÃO VEIO NA ÚLTIMA ENTREGA não entra na fila (C-etiquetas-R02):
      o que ele recebeu é de uma entrega ANTERIOR, já etiquetada — sugerir a
      quantidade dela é reimprimir adesivo de mercadoria que já está colada.
      Vai para os problemas, dizendo como etiquetar aquela outra entrega.
      Sem nenhuma nota amarrada ao pedido (recebido por outro caminho), vale o
      recebido, como sempre.
    */
    if (ultimaEntrega) {
      const nestaEntrega = quantidadeNaEntrega(companyId, ultimaEntrega.id, i.productId);
      if (nestaEntrega === null) {
        problemas.push({
          descricao: i.name,
          motivo: `Não veio na última entrega do pedido (nota ${ultimaEntrega.number ?? 'sem número'}): o que `
            + 'chegou dele foi numa entrega anterior. Para etiquetar aquela entrega, use a origem "Nota de entrada".',
        });
        continue;
      }
      candidates.push(candidato(companyId, { ...i, productId: i.productId, name: i.name }, nestaEntrega));
      continue;
    }
    candidates.push(candidato(companyId, { ...i, productId: i.productId, name: i.name }, i.received_quantity));
  }
  return { source: 'compra', candidates, problemas, truncado: false };
}

// ----------------------------------------------------------- nota de entrada

/**
 * O que ENTROU numa nota de entrada confirmada.
 *
 * DEFEITO QUE ISTO CORRIGE: a única origem "de compra" era o pedido. A loja
 * recebe a maior parte das compras por XML, sem pedido — e depois de
 * confirmar uma nota de 60 itens a pessoa ia a Etiquetas buscar item por item
 * e digitar a quantidade de cada um, exatamente o trabalho que as origens
 * existem para eliminar.
 *
 * Lê o RAZÃO (`core_stock_movements` da nota, direção 'in'), e não as linhas
 * do XML: o razão já está na UNIDADE DO CADASTRO (1 CX de 12 entrou como 12
 * UN) e agrupado por produto (duas linhas do mesmo produto viram uma), e só
 * tem o que de fato entrou — item conferido com zero não aparece.
 */
function doNotaDeEntrada(companyId: string, noteId: string): LabelCandidates {
  const db = getConnection();
  const nota = db
    .prepare('SELECT id, status, number, doc_type FROM core_inbound_notes WHERE id = ? AND company_id = ?')
    .get(noteId, companyId) as { id: string; status: string; number: string | null; doc_type: string | null } | undefined;
  if (!nota) {
    throw new ApiError('CORE_INBOUND_NOTE_NOT_FOUND', 'Nota de entrada não encontrada nesta operação.', 404);
  }
  const rotulo = `${String(nota.doc_type ?? 'nfe') === 'manual' ? 'A entrada manual' : 'A nota'}${nota.number ? ` ${nota.number}` : ''}`;
  if (nota.status === NOTA_ESTORNADA) {
    throw new ApiError(
      'CORE_LABEL_NOTE_REVERSED',
      `${rotulo} foi estornada: o que ela trouxe saiu do estoque, e não há mercadoria dela para etiquetar.`,
      409,
    );
  }
  if (nota.status !== NOTA_RECEBIDA) {
    throw new ApiError(
      'CORE_LABEL_NOTE_NOT_RECEIVED',
      `${rotulo} ainda está em conferência: nada dela entrou no estoque. Confirme a entrada em Compras › Entrada de notas e depois etiquete.`,
      409,
    );
  }

  const linhas = db
    .prepare(
      `SELECT p.id AS productId, p.name, p.internal_code AS internalCode, p.barcode,
              p.price_cents AS priceCents, p.category,
              COALESCE((SELECT SUM(s.quantity) FROM core_stock s
                         WHERE s.product_id = p.id AND s.company_id = p.company_id), 0) AS stockQuantity,
              0 AS temFilhos,
              SUM(m.quantity) AS recebido
         FROM core_stock_movements m
         JOIN core_products p ON p.id = m.product_id AND p.company_id = m.company_id
        WHERE m.company_id = ? AND m.reference_id = ? AND m.movement_type = 'in'
          AND m.reference_type IN ('nfe_entrada', 'entrada_manual')
        GROUP BY p.id
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all(companyId, noteId) as unknown as (LinhaBase & { recebido: number })[];

  const problemas: LabelProblem[] = [];
  if (linhas.length === 0) {
    problemas.push({
      descricao: rotulo,
      motivo: 'Nenhum item desta nota entrou no estoque (itens de serviço, ou conferidos com zero).',
    });
  }
  return {
    source: 'nota',
    candidates: linhas.map((l) => candidato(companyId, l, l.recebido)),
    problemas,
    truncado: false,
  };
}

// ----------------------------------------------------------------- inventário

function daContagem(companyId: string, countId: string): LabelCandidates {
  const db = getConnection();
  const contagem = db
    .prepare('SELECT id FROM core_inventory_counts WHERE id = ? AND company_id = ?')
    .get(countId, companyId);
  if (!contagem) {
    throw new ApiError('CORE_INVENTORY_COUNT_NOT_FOUND', 'Contagem não encontrada.', 404);
  }

  const itens = db
    .prepare(
      `SELECT ci.product_id AS productId, ci.counted_quantity, ci.expected_quantity,
              p.name, p.internal_code AS internalCode, p.barcode, p.price_cents AS priceCents,
              p.category, COALESCE(s.quantity, 0) AS stockQuantity,
              EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS temFilhos
         FROM core_inventory_count_items ci
         JOIN core_products p ON p.id = ci.product_id
         LEFT JOIN core_stock s ON s.product_id = ci.product_id AND s.company_id = ci.company_id
        WHERE ci.count_id = ? AND ci.company_id = ?
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all(countId, companyId) as unknown as (LinhaBase & {
    counted_quantity: number | null;
    expected_quantity: number;
  })[];

  const candidates: LabelCandidate[] = [];
  const problemas: LabelProblem[] = [];
  for (const i of itens) {
    // Nulo NÃO é zero: item que a contagem não alcançou não foi contado como
    // nenhum. Sugerir 0 etiquetas seria transformar "não contei" em "não tem".
    if (i.counted_quantity == null) {
      problemas.push({ descricao: i.name, motivo: 'Ainda não foi contado.' });
      continue;
    }
    if (i.temFilhos) {
      problemas.push({ descricao: i.name, motivo: MOTIVO_MODELO_DA_GRADE });
      continue;
    }
    candidates.push(candidato(companyId, i, i.counted_quantity));
  }
  return { source: 'inventario', candidates, problemas, truncado: false };
}

// ------------------------------------------------------------------- códigos

function dosCodigos(companyId: string, texto: string): LabelCandidates {
  const db = getConnection();
  // Aceita separação por linha, vírgula e ponto-e-vírgula: quem cola de
  // planilha não sabe qual vai sair, e recusar por causa disso é atrito à toa.
  const brutos = texto
    .split(/[\r\n,;]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const vistos = new Map<string, number>();
  const modelosVistos = new Set<string>();
  const problemas: LabelProblem[] = [];
  const candidates: LabelCandidate[] = [];

  for (const codigo of brutos) {
    const achado = db
      .prepare(
        `${SELECT_BASE}
          WHERE p.company_id = ? AND p.active = 1
            AND (p.internal_code = ? OR p.barcode = ?
                 OR EXISTS (SELECT 1 FROM core_product_barcodes b
                             WHERE b.product_id = p.id AND b.barcode = ?))
          LIMIT 1`,
      )
      .get(companyId, codigo, codigo, codigo) as LinhaBase | undefined;

    if (!achado) {
      problemas.push({ descricao: codigo, motivo: 'Nenhum produto com este código interno ou de barras.' });
      continue;
    }
    if (achado.temFilhos) {
      if (!modelosVistos.has(achado.productId)) {
        modelosVistos.add(achado.productId);
        problemas.push({ descricao: `${codigo} (${achado.name})`, motivo: MOTIVO_MODELO_DA_GRADE });
      }
      continue;
    }
    // Código repetido na lista SOMA quantidade em vez de virar duas linhas:
    // colar a mesma peça três vezes quer dizer três etiquetas.
    const jaTem = vistos.get(achado.productId);
    if (jaTem !== undefined) {
      candidates[jaTem].documentQuantity = (candidates[jaTem].documentQuantity ?? 0) + 1;
      continue;
    }
    vistos.set(achado.productId, candidates.length);
    candidates.push(candidato(companyId, achado, 1));
  }

  return { source: 'codigos', candidates, problemas, truncado: false };
}

// --------------------------------------------------------------------- grade

function daGrade(companyId: string, productId: string): LabelCandidates {
  const db = getConnection();
  const alvo = db
    .prepare('SELECT id, parent_id FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { id: string; parent_id: string | null } | undefined;
  if (!alvo) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

  // Vale tanto escolher o MODELO quanto uma variante: quem clicou numa peça da
  // grade quer as irmãs dela, não só ela.
  const modelo = alvo.parent_id ?? alvo.id;
  const linhas = db
    .prepare(
      `${SELECT_BASE}
        WHERE p.company_id = ? AND p.active = 1 AND (p.id = ? OR p.parent_id = ?)
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all(companyId, modelo, modelo) as unknown as LinhaBase[];

  const problemas: LabelProblem[] = [];
  // Um modelo com grade não é vendido nem etiquetado como si próprio: quem vai
  // para a prateleira é cada tamanho. Sair na lista faria imprimir uma etiqueta
  // que nenhuma peça pode receber.
  const variantes = linhas.filter((l) => l.productId !== modelo);
  const escolhidos = variantes.length > 0 ? variantes : linhas;
  if (variantes.length === 0) {
    problemas.push({
      descricao: linhas[0]?.name ?? '',
      motivo: 'Este produto não tem grade. Saiu a peça sozinha.',
    });
  }

  return {
    source: 'grade',
    candidates: escolhidos.map((l) => candidato(companyId, l, null)),
    problemas,
    truncado: false,
  };
}

// ------------------------------------------------------------------ despacho

export interface LabelSourceQuery {
  source: LabelSource;
  /** `catalogo`. */
  search?: string;
  /** `estoque`. */
  lowOnly?: boolean;
  /** `compra`. */
  purchaseOrderId?: string;
  /** `nota`. */
  noteId?: string;
  /** `inventario`. */
  countId?: string;
  /** `codigos`. */
  codes?: string;
  /** `grade`. */
  productId?: string;
}

export function listLabelCandidates(
  companyId: string,
  query: LabelSourceQuery,
): LabelCandidates {
  ensureCoreSchema();
  const exigir = (v: string | undefined, campo: string): string => {
    const t = String(v ?? '').trim();
    if (!t) throw new ApiError('CORE_LABEL_SOURCE_ARG', `Informe ${campo}.`, 400);
    return t;
  };

  switch (query.source) {
    case 'catalogo':
      return daBusca(companyId, exigir(query.search, 'o que buscar'));
    case 'estoque':
      return doEstoque(companyId, query.lowOnly === true);
    case 'compra':
      return doPedidoDeCompra(companyId, exigir(query.purchaseOrderId, 'o pedido de compra'));
    case 'nota':
      return doNotaDeEntrada(companyId, exigir(query.noteId, 'a nota de entrada'));
    case 'inventario':
      return daContagem(companyId, exigir(query.countId, 'a contagem'));
    case 'codigos':
      return dosCodigos(companyId, exigir(query.codes, 'os códigos'));
    case 'grade':
      return daGrade(companyId, exigir(query.productId, 'o produto'));
    default:
      throw new ApiError('CORE_LABEL_SOURCE_UNKNOWN', 'Origem de etiqueta desconhecida.', 400);
  }
}
