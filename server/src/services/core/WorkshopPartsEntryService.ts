/**
 * A PEÇA ENTRANDO NA GAVETA — rodada 55.
 *
 * ============================================================================
 * O GESTO: BIPAR E RESOLVER
 * ============================================================================
 *
 * É o fluxo do sistema anterior, e ele é bom porque descreve o que a pessoa
 * está fazendo de verdade: chegou peça, ela está na mão, e o leitor decide o
 * que a tela pergunta.
 *
 *   código EXISTE     -> REPOSIÇÃO: quantas chegaram, por qual documento
 *   código NÃO EXISTE -> CADASTRO: com o código já preenchido
 *
 * O ponto do desenho é NÃO deixar a pessoa cadastrar de novo o que já existe.
 * É a mesma doutrina que o balcão já segue (CatalogService): se a busca
 * responde "não encontrado" para algo que está na gaveta, o operador faz a
 * única coisa que a tela deixou — cadastra outra vez —, e aí o saldo racha
 * entre dois cadastros do mesmo item.
 *
 * ============================================================================
 * O DOCUMENTO DE ORIGEM É OBRIGATÓRIO — E NÃO É UMA PORTA NOVA
 * ============================================================================
 *
 * O sistema anterior exigia "número da NF" e não guardava nada além do número.
 * Aqui a exigência é de DOCUMENTO, e ele vai para o razão: `document_number`
 * e `unit_cost_cents` na linha do movimento, com tipo MANUAL_ENTRY, que é o
 * rótulo honesto — alguém declarou que a mercadoria chegou.
 *
 * NÃO substitui a entrada por XML de NF-e, que continua sendo a porta
 * principal e a única que gera contas a pagar e confere item a item. Esta aqui
 * é a peça comprada na loja da esquina para terminar um conserto hoje: existe
 * de verdade na oficina, e fingir que não existe é o que faz o estoque virar
 * ficção.
 *
 * ============================================================================
 * O PREÇO DERIVA DO CUSTO — E A CONTA É A DA CASA
 * ============================================================================
 *
 * O anterior guardava `margemLucro` no cadastro e recalculava `precoVenda` a
 * cada mudança. A conta era `custo * (1 + margem/100)` — que é MARKUP, não
 * margem, e o nome errado é como se perde dinheiro achando que se está
 * ganhando.
 *
 * Aqui a conta já existia (`Pricing.precoPorMarkup`, idêntica) e o percentual
 * NÃO é guardado, por doutrina antiga do repositório: markup e margem derivam
 * de custo e preço, e uma cópia gravada divergiria no primeiro reajuste. O que
 * se guarda é o resultado — o preço — e o percentual é a forma de chegar nele.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement } from './InventoryService.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';
import { createProduct, updateProduct } from './CatalogService.js';
import { precoPorMarkup } from './Pricing.js';
import { capabilitiesFor } from './WorkshopCapabilities.js';

/** O documento que prova a entrada. Sem ele, a peça não entra. */
export interface DocumentoDeEntrada {
  numero: string;
  fornecedor?: string | null;
  valorTotalCents?: number | null;
}

export interface PecaEncontrada {
  id: string;
  name: string;
  internal_code: string;
  barcode: string | null;
  unit: string;
  cost_cents: number;
  price_cents: number;
  min_stock: number;
  storage_location: string | null;
  workshop_id: string | null;
  workshop_name: string | null;
  stock_quantity: number;
  reserved: number;
}

/**
 * O código EXATO acha sempre.
 *
 * Código de barras, código interno e referência do fabricante, todos por
 * igualdade — nunca por LIKE. Bipar é o gesto de quem está com a peça na mão:
 * "quase igual" aqui devolveria a peça errada para dentro de uma gaveta.
 */
export function resolverCodigo(
  companyId: string,
  codigo: string,
  workshopId?: string | null,
): PecaEncontrada | null {
  ensureCoreSchema();
  const alvo = String(codigo ?? '').trim();
  if (!alvo) {
    throw new ApiError('CORE_CODE_REQUIRED', 'Bipe ou digite um código.', 400);
  }

  const params: unknown[] = [companyId, alvo, alvo, alvo, alvo];
  let sql = `SELECT p.id, p.name, p.internal_code, p.barcode, p.unit, p.cost_cents,
                    p.price_cents, p.min_stock, p.storage_location, p.workshop_id,
                    w.name AS workshop_name,
                    COALESCE(s.quantity, 0) AS stock_quantity,
                    COALESCE(s.reserved, 0) AS reserved
               FROM core_products p
               LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
               LEFT JOIN core_workshops w ON w.id = p.workshop_id AND w.company_id = p.company_id
              WHERE p.company_id = ? AND p.active = 1 AND p.kind = 'part'
                AND (p.barcode = ? OR p.internal_code = ? OR p.sku = ? OR p.reference = ?)`;

  // A bancada de celulares não repõe a gaveta da de mobilidade: o código que
  // não é dela é, para ela, código que não existe.
  if (workshopId) {
    sql += ' AND p.workshop_id = ?';
    params.push(workshopId);
  }
  sql += ' LIMIT 1';

  const row = getConnection().prepare(sql).all(...(params as never[])) as unknown as PecaEncontrada[];
  return row[0] ?? null;
}

/** O documento, validado uma vez só, para as duas portas usarem a mesma régua. */
function exigirDocumento(doc: DocumentoDeEntrada | undefined): DocumentoDeEntrada {
  const numero = String(doc?.numero ?? '').trim();
  if (!numero) {
    throw new ApiError(
      'CORE_ENTRY_DOCUMENT_REQUIRED',
      'Informe o documento de entrada (nota, cupom ou recibo). Peça que entra sem '
        + 'papel não tem como ser conferida depois.',
      400,
    );
  }
  return {
    numero,
    fornecedor: String(doc?.fornecedor ?? '').trim() || null,
    valorTotalCents:
      doc?.valorTotalCents == null ? null : Math.round(Number(doc.valorTotalCents)),
  };
}

/**
 * A bancada precisa existir, ser da empresa e aceitar peça.
 *
 * ## POR QUE O GUARDA É ESTE, E NÃO A FILIAÇÃO À BANCADA
 *
 * A rota nomeia `estoquista` — e o estoquista NÃO tem linha em
 * `core_workshop_members`: quem tem são os mecânicos. Resolver a bancada pela
 * filiação (`resolveWorkshop`) dava 403 justamente a quem cuida do estoque, na
 * porta que a própria rota abriu para ele. Rota que convida e depois barra é
 * pior que rota fechada: a pessoa lê o próprio perfil na lista e conclui que o
 * sistema está quebrado.
 *
 * A filiação existe para o MECÂNICO, que só pode tocar na própria bancada — e
 * mecânico não alcança esta rota. Para quem dá entrada, a régua certa é a
 * EMPRESA: a peça só pode nascer em bancada da empresa da sessão, e que
 * trabalhe com peça.
 *
 * ## E A BANCADA ÚNICA É ASSUMIDA
 *
 * Sem `workshopId`, se a empresa tem exatamente UMA bancada com peça, ela é a
 * resposta — não há o que escolher. Com mais de uma, RECUSA: escolher a
 * primeira da lista em silêncio poria a peça na gaveta errada, e o erro só
 * apareceria com o mecânico da outra bancada procurando o que nunca esteve lá.
 */
function exigirBancadaComPeca(companyId: string, workshopId: string): { id: string; name: string } {
  if (!String(workshopId ?? '').trim()) {
    const candidatas = getConnection()
      .prepare('SELECT id, name, kind FROM core_workshops WHERE company_id = ? AND active = 1')
      .all(companyId) as unknown as { id: string; name: string; kind: string }[];
    const comPeca = candidatas.filter((w) => capabilitiesFor(w.kind).parts);
    if (comPeca.length === 1) return { id: comPeca[0].id, name: comPeca[0].name };
    throw new ApiError(
      'CORE_WORKSHOP_REQUIRED',
      comPeca.length === 0
        ? 'Esta empresa não tem bancada que trabalhe com peças.'
        : 'Informe a bancada dona da peça — esta empresa tem mais de uma.',
      400,
    );
  }

  const bancada = getConnection()
    .prepare('SELECT id, name, kind, company_id FROM core_workshops WHERE id = ?')
    .get(workshopId) as { id: string; name: string; kind: string; company_id: string } | undefined;
  if (!bancada || bancada.company_id !== companyId) {
    throw new ApiError('CORE_WORKSHOP_NOT_FOUND', 'Bancada não encontrada.', 404);
  }
  if (!capabilitiesFor(bancada.kind).parts) {
    throw new ApiError(
      'CORE_WORKSHOP_WITHOUT_PARTS',
      'Esta bancada não trabalha com estoque de peças.',
      409,
    );
  }
  return { id: bancada.id, name: bancada.name };
}

/**
 * O preço que sai do custo e do percentual.
 *
 * `null` quando ninguém informou percentual — e aí quem manda é o preço
 * digitado. Inventar markup padrão aqui daria à peça um preço que ninguém
 * decidiu, e o número apareceria na conta do cliente como se alguém tivesse.
 */
export function precoDerivado(
  custoCents: number,
  markupPercent: number | null | undefined,
): number | null {
  if (markupPercent == null || !Number.isFinite(Number(markupPercent))) return null;
  const percentual = Number(markupPercent);
  if (percentual < 0) {
    throw new ApiError('CORE_INVALID_MARKUP', 'O percentual não pode ser negativo.', 400);
  }
  return precoPorMarkup(Math.round(custoCents), percentual);
}

export interface CadastroDePeca {
  companyId: string;
  workshopId: string;
  userId: string;
  name: string;
  barcode?: string | null;
  internalCode?: string | null;
  unit?: string | null;
  costCents: number;
  /** Percentual sobre o CUSTO. Com ele, o preço é calculado e não digitado. */
  markupPercent?: number | null;
  priceCents?: number | null;
  quantity: number;
  minStock?: number | null;
  storageLocation?: string | null;
  supplierId?: string | null;
  documento: DocumentoDeEntrada;
  /** `Idempotency-Key` do gesto. Sem ela a entrada é recusada. */
  entryKey: string;
}

/**
 * Cadastra a peça E dá a entrada, na mesma transação.
 *
 * As duas coisas juntas de propósito: peça cadastrada sem saldo é peça que o
 * mecânico procura, encontra no sistema, e não acha na gaveta — e peça com
 * saldo sem cadastro não existe. Foi o mesmo gesto na mão da pessoa, é o mesmo
 * fato no banco.
 */
export function cadastrarPecaComEntrada(input: CadastroDePeca): {
  productId: string;
  priceCents: number;
  quantity: number;
  duplicada: boolean;
} {
  ensureCoreSchema();
  const nome = String(input.name ?? '').trim();
  if (!nome) {
    throw new ApiError('CORE_INVALID_PAYLOAD', 'Nome da peça é obrigatório.', 400);
  }
  const quantidade = Number(input.quantity);
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
  }
  const custo = Math.round(Number(input.costCents ?? 0));
  if (!Number.isFinite(custo) || custo < 0) {
    throw new ApiError('CORE_INVALID_COST', 'Custo inválido.', 400);
  }

  const documento = exigirDocumento(input.documento);
  const chave = exigirChaveDeEntrada(input.entryKey);
  const bancada = exigirBancadaComPeca(input.companyId, input.workshopId);

  const derivado = precoDerivado(custo, input.markupPercent);
  const preco = derivado ?? Math.round(Number(input.priceCents ?? 0));
  /*
    SEM PREÇO, A PEÇA NASCE IMPRESTÁVEL.

    `addPart` recusa lançar peça com preço zero — ela entraria na OS por
    R$ 0,00 e o conserto fecharia sem custo nenhum. Descobrir isso aqui, com a
    peça na mão e o formulário aberto, é muito melhor que descobrir meia hora
    depois com a moto desmontada.
  */
  if (!(preco > 0)) {
    throw new ApiError(
      'CORE_PART_WITHOUT_PRICE',
      'Informe o preço de venda ou o percentual sobre o custo: peça sem preço não '
        + 'pode ser lançada em nenhuma OS.',
      400,
    );
  }

  // O que ESTE gesto pede — a peça, a carga e o papel (RES-IDEM-VIZ).
  const impressao = Impressao.impressaoDe({
    gesto: 'cadastro',
    bancada: bancada.id,
    nome,
    codigo: Impressao.texto(input.barcode),
    codigoInterno: Impressao.texto(input.internalCode),
    unidade: Impressao.texto(input.unit),
    custo,
    preco,
    quantidade,
    documento: documentoDaImpressao(documento),
  });

  return withTransaction(() => {
    /*
      O GESTO REPETIDO DEVOLVE A PEÇA QUE ELE MESMO CRIOU.

      No cadastro a idempotência do razão chega tarde: o `createProduct` roda
      primeiro, e o segundo clique já teria criado a peça duplicada — ou
      batido no código de barras e devolvido 409 dizendo que o código "já é
      da peça X", que é a própria peça que ele acabou de criar. O recibo do
      primeiro gesto é o movimento no razão, e é nele que se pergunta.

      E a mesma chave com OUTRO gesto (outra quantidade, outra peça) não é o
      clique repetido: é 422, e nada nasce (RES-IDEM-VIZ).
    */
    const jaCadastrada = entradaDaChave(input.companyId, chave);
    if (jaCadastrada) {
      if (Impressao.outraImpressao(jaCadastrada.impressao, impressao)) {
        throw Impressao.chaveReusada('outra entrada de peça', { productId: jaCadastrada.productId });
      }
      const antiga = getConnection()
        .prepare('SELECT price_cents FROM core_products WHERE id = ? AND company_id = ?')
        .get(jaCadastrada.productId, input.companyId) as { price_cents: number } | undefined;
      return {
        productId: jaCadastrada.productId,
        priceCents: Number(antiga?.price_cents ?? preco),
        quantity: quantidade,
        duplicada: true,
      };
    }

    const codigoBipado = String(input.barcode ?? '').trim() || null;
    if (codigoBipado) {
      const jaExiste = resolverCodigo(input.companyId, codigoBipado);
      if (jaExiste) {
        throw new ApiError(
          'CORE_PART_CODE_TAKEN',
          `O código ${codigoBipado} já é da peça "${jaExiste.name}". Use a reposição em `
            + 'vez de cadastrar de novo — dois cadastros do mesmo item rachariam o saldo.',
          409,
          { productId: jaExiste.id, name: jaExiste.name },
        );
      }
    }

    const produto = createProduct(input.companyId, {
      name: nome,
      barcode: codigoBipado ?? undefined,
      internalCode: String(input.internalCode ?? '').trim() || undefined,
      unit: String(input.unit ?? '').trim() || undefined,
      costCents: custo,
      priceCents: preco,
      minStock: input.minStock == null ? undefined : Number(input.minStock),
      storageLocation: input.storageLocation ?? null,
      supplierId: input.supplierId ?? undefined,
      kind: 'part',
      workshopId: bancada.id,
    });

    const productId = String(produto.id);
    entradaNaGaveta({
      companyId: input.companyId,
      productId,
      quantity: quantidade,
      unitCostCents: custo,
      documento,
      userId: input.userId,
      workshopId: bancada.id,
      nota: `Cadastro de peça: ${nome}`,
      entryKey: chave,
      impressao,
    });

    return { productId, priceCents: preco, quantity: quantidade, duplicada: false };
  });
}

export interface ReposicaoDePeca {
  companyId: string;
  productId: string;
  userId: string;
  quantity: number;
  /** Custo da carga que chegou. Ausente preserva o custo do cadastro. */
  costCents?: number | null;
  /** Com percentual, o preço é recalculado sobre o custo NOVO. */
  markupPercent?: number | null;
  documento: DocumentoDeEntrada;
  /** `Idempotency-Key` do gesto. Sem ela a entrada é recusada. */
  entryKey: string;
}

/**
 * Repõe a gaveta.
 *
 * ## O CUSTO NOVO NÃO REPREÇA SOZINHO
 *
 * O sistema anterior recalculava o preço em silêncio a cada mudança de custo
 * ou margem. Preço que muda sozinho é preço que ninguém decidiu — e o número
 * aparece na conta do cliente sem que a loja saiba que aumentou. Aqui o
 * repreço só acontece quando quem está repondo informa o percentual: o gesto
 * é explícito, e a tela mostra o preço que vai valer antes de gravar.
 */
export function reporPeca(input: ReposicaoDePeca): {
  quantity: number;
  costCents: number;
  priceCents: number;
  reprecificada: boolean;
  duplicada: boolean;
} {
  ensureCoreSchema();
  const quantidade = Number(input.quantity);
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
  }
  const documento = exigirDocumento(input.documento);
  const chave = exigirChaveDeEntrada(input.entryKey);
  // O que ESTE gesto pede — a peça, a carga e o papel (RES-IDEM-VIZ).
  const impressao = Impressao.impressaoDe({
    gesto: 'reposicao',
    peca: input.productId,
    quantidade,
    custo: input.costCents == null ? null : Math.round(Number(input.costCents)),
    markup: input.markupPercent == null ? null : Impressao.numero(input.markupPercent),
    documento: documentoDaImpressao(documento),
  });

  return withTransaction(() => {
    /*
      A MESMA CHAVE COM OUTRA CARGA NÃO É O CLIQUE REPETIDO (RES-IDEM-VIZ).

      A conferência vem ANTES de tudo: o custo novo é gravado no cadastro
      antes da entrada, e o reenvio diferente reprecificava a peça mesmo
      quando o razão respondia "duplicado". Entrada anterior à impressão
      (nula) segue a regra de sempre.
    */
    const ja = entradaDaChave(input.companyId, chave);
    if (ja && Impressao.outraImpressao(ja.impressao, impressao)) {
      throw Impressao.chaveReusada('outra entrada de peça', { productId: ja.productId });
    }
    const peca = getConnection()
      .prepare(
        `SELECT id, name, kind, workshop_id, cost_cents, price_cents
           FROM core_products WHERE id = ? AND company_id = ? AND active = 1`,
      )
      .get(input.productId, input.companyId) as
      | {
          id: string;
          name: string;
          kind: string;
          workshop_id: string | null;
          cost_cents: number;
          price_cents: number;
        }
      | undefined;
    if (!peca) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Peça não encontrada.', 404);
    if (peca.kind !== 'part') {
      throw new ApiError(
        'CORE_NOT_A_PART',
        `"${peca.name}" é mercadoria de revenda, não peça de bancada. A entrada de `
          + 'revenda é pela nota do fornecedor.',
        409,
      );
    }

    const custo =
      input.costCents == null ? Number(peca.cost_cents) : Math.round(Number(input.costCents));
    if (!Number.isFinite(custo) || custo < 0) {
      throw new ApiError('CORE_INVALID_COST', 'Custo inválido.', 400);
    }

    const novoPreco = precoDerivado(custo, input.markupPercent);
    const reprecificada = novoPreco != null && novoPreco !== Number(peca.price_cents);

    if (input.costCents != null || novoPreco != null) {
      updateProduct(input.companyId, peca.id, {
        name: peca.name,
        costCents: custo,
        ...(novoPreco != null ? { priceCents: novoPreco } : {}),
      });
    }

    const { duplicada } = entradaNaGaveta({
      companyId: input.companyId,
      productId: peca.id,
      quantity: quantidade,
      unitCostCents: custo,
      documento,
      userId: input.userId,
      workshopId: peca.workshop_id,
      nota: `Reposição: ${peca.name}`,
      entryKey: chave,
      impressao,
    });

    return {
      quantity: quantidade,
      costCents: custo,
      priceCents: novoPreco ?? Number(peca.price_cents),
      reprecificada,
      duplicada,
    };
  });
}

export interface AjusteDePeca {
  companyId: string;
  productId: string;
  minStock?: number | null;
  storageLocation?: string | null;
  costCents?: number | null;
  priceCents?: number | null;
  markupPercent?: number | null;
}

/**
 * Ajusta o CADASTRO da peça — nunca o saldo.
 *
 * Mínimo, endereço na gaveta e preço. Saldo não entra aqui de propósito: o
 * único jeito de mudar saldo é movimento registrado, e uma porta de "corrigir
 * a quantidade" nesta tela seria o acerto de inventário sem o rastro que o
 * acerto de inventário tem.
 */
export function ajustarPeca(input: AjusteDePeca): Record<string, unknown> {
  ensureCoreSchema();
  const peca = getConnection()
    .prepare(
      `SELECT id, name, kind, cost_cents, price_cents
         FROM core_products WHERE id = ? AND company_id = ? AND active = 1`,
    )
    .get(input.productId, input.companyId) as
    | { id: string; name: string; kind: string; cost_cents: number; price_cents: number }
    | undefined;
  if (!peca) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Peça não encontrada.', 404);
  if (peca.kind !== 'part') {
    throw new ApiError(
      'CORE_NOT_A_PART',
      `"${peca.name}" é mercadoria de revenda: o cadastro dela é em Produtos.`,
      409,
    );
  }

  if (input.minStock != null) {
    const minimo = Number(input.minStock);
    if (!Number.isFinite(minimo) || minimo < 0) {
      throw new ApiError('CORE_INVALID_MIN_STOCK', 'Estoque mínimo inválido.', 400);
    }
  }

  const custo = input.costCents == null ? Number(peca.cost_cents) : Math.round(Number(input.costCents));
  // A MESMA régua das outras duas portas. Sem ela esta era a única que aceitava
  // custo negativo ou texto: `Math.round(Number('abc'))` é NaN, e NaN gravado
  // em `cost_cents` faz markup, margem e relatório de lucro pararem de fechar
  // sem que nada tenha reclamado.
  if (!Number.isFinite(custo) || custo < 0) {
    throw new ApiError('CORE_INVALID_COST', 'Custo inválido.', 400);
  }
  const derivado = precoDerivado(custo, input.markupPercent);
  const preco =
    derivado ?? (input.priceCents == null ? null : Math.round(Number(input.priceCents)));
  if (preco != null && !(preco > 0)) {
    throw new ApiError(
      'CORE_PART_WITHOUT_PRICE',
      'Peça sem preço de venda não pode ser lançada em nenhuma OS.',
      400,
    );
  }

  return updateProduct(input.companyId, peca.id, {
    name: peca.name,
    ...(input.minStock == null ? {} : { minStock: Number(input.minStock) }),
    ...(input.storageLocation === undefined ? {} : { storageLocation: input.storageLocation }),
    ...(input.costCents == null ? {} : { costCents: custo }),
    ...(preco == null ? {} : { priceCents: preco }),
  });
}

/**
 * A entrada em si, com o documento amarrado ao movimento.
 *
 * ## A CHAVE VEM DE QUEM DEU O GESTO
 *
 * A referência era `randomUUID()`, e o motivo declarado estava certo: duas
 * cargas da MESMA nota acontecem — o fornecedor entrega em duas viagens —, e
 * amarrar a chave só ao número do documento faria a segunda ser engolida em
 * silêncio pela idempotência do razão. A peça chegaria e o saldo não subiria.
 *
 * A conclusão é que estava errada. Inventar a chave AQUI desarma o guarda: o
 * `UNIQUE` do razão nunca colide, e o clique repetido do estoquista entra a
 * carga duas vezes. Chave de idempotência não se inventa no servidor — se
 * inventasse, não seria idempotência.
 *
 * Ela vem do chamador (`Idempotency-Key`), que é quem sabe distinguir os dois
 * casos: duas viagens são dois gestos e trazem duas chaves; um clique repetido
 * é UM gesto e o navegador reenvia a mesma.
 */
function entradaNaGaveta(input: {
  companyId: string;
  productId: string;
  quantity: number;
  unitCostCents: number;
  documento: DocumentoDeEntrada;
  userId: string;
  workshopId: string | null;
  nota: string;
  entryKey: string;
  /** O que o gesto pediu — gravado no movimento (RES-IDEM-VIZ). */
  impressao: string;
}): { duplicada: boolean } {
  const detalhe = [
    input.nota,
    input.documento.fornecedor ? `Fornecedor: ${input.documento.fornecedor}` : null,
    input.documento.valorTotalCents != null
      ? `Total do documento: R$ ${(input.documento.valorTotalCents / 100).toFixed(2).replace('.', ',')}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const { duplicated } = applyMovement({
    companyId: input.companyId,
    productId: input.productId,
    movementType: 'in',
    quantity: input.quantity,
    referenceType: 'entrada_bancada',
    referenceId: input.entryKey,
    kind: 'MANUAL_ENTRY',
    documentNumber: input.documento.numero,
    unitCostCents: input.unitCostCents,
    workshopId: input.workshopId,
    userId: input.userId,
    note: detalhe,
    impressao: input.impressao,
  });
  return { duplicada: duplicated };
}

/**
 * A chave, conferida na porta do serviço.
 *
 * Aqui e não só na rota porque a rota não é a única porta: quem chamar o
 * serviço de um job, de um script ou de outra rota amanhã passa pelo mesmo
 * guarda. Sem chave a entrada não acontece — a omissão NÃO é tratada como
 * "então gera uma", que é exatamente o defeito que estamos consertando.
 */
function exigirChaveDeEntrada(entryKey: string | null | undefined): string {
  const chave = String(entryKey ?? '').trim();
  if (!chave) {
    throw new ApiError(
      'CORE_IDEMPOTENCY_REQUIRED',
      'Header Idempotency-Key é obrigatório na entrada de peça — sem ele um clique '
        + 'repetido soma a carga duas vezes na gaveta.',
      400,
    );
  }
  return chave;
}

/**
 * A entrada que já nasceu desta mesma chave, se o gesto foi repetido: a peça
 * e o que o gesto pediu (nula na entrada anterior à impressão, RES-IDEM-VIZ).
 */
function entradaDaChave(
  companyId: string,
  entryKey: string,
): { productId: string; impressao: string | null } | null {
  const linha = getConnection()
    .prepare(
      `SELECT product_id, idempotency_fingerprint FROM core_stock_movements
        WHERE company_id = ? AND reference_type = 'entrada_bancada' AND reference_id = ?
        LIMIT 1`,
    )
    .get(companyId, entryKey) as { product_id: string; idempotency_fingerprint: string | null } | undefined;
  return linha ? { productId: String(linha.product_id), impressao: linha.idempotency_fingerprint } : null;
}

/** O papel da entrada, como a impressão o compara: ausente é vazio. */
function documentoDaImpressao(documento: DocumentoDeEntrada): Record<string, unknown> {
  return {
    numero: Impressao.texto(documento.numero),
    fornecedor: Impressao.texto(documento.fornecedor),
    valor: documento.valorTotalCents == null ? null : Impressao.numero(documento.valorTotalCents),
  };
}
