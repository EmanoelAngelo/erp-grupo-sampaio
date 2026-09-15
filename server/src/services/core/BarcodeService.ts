/**
 * Código de barras dos produtos.
 *
 * Produto que já vem com EAN do fabricante mantém o dele. Para os demais o
 * ERP gera um EAN-13 de uso interno, com prefixo 2 — a faixa reservada pelo
 * padrão GS1 justamente para códigos de circulação restrita, que não colidem
 * com EANs registrados por fabricantes.
 *
 * O dígito verificador é calculado de verdade: leitor de balcão recusa código
 * com dígito errado, então inventar o último número quebraria no caixa.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import {
  codigoNaFaixaDaBalanca,
  findProductByAnyBarcode,
  lerConfigDaEtiquetaDaBalanca,
} from './CatalogAuxService.js';
import type { LabelField } from './LabelFormats.js';
import { effectivePriceCents } from './PricingService.js';

/** Prefixo GS1 de uso interno (faixa 20–29). */
const INTERNAL_PREFIX = '2';

/** 11 dígitos de sequência depois do prefixo: o maior número que cabe. */
const LIMITE_DA_SEQUENCIA = 99_999_999_999;

/**
 * Dígito verificador do EAN-13: posições ímpares pesam 1, pares pesam 3
 * (contando a partir da esquerda, 1-indexado), e o dígito é o complemento
 * para a próxima dezena.
 */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) {
    throw new ApiError('CORE_INVALID_BARCODE', 'EAN-13 exige 12 dígitos antes do verificador.', 400);
  }
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Quantas sequências cabem atrás de cada segundo dígito: "20…" é de 0 a 10^10 − 1, "21…" o bloco seguinte. */
const SEQUENCIAS_POR_SUBFAIXA = 10_000_000_000;

/** 1 dígito de prefixo + 11 da sequência = 12, e o 13º é o verificador. */
function eanDaSequencia(seq: number): string {
  const body = `${INTERNAL_PREFIX}${String(seq).padStart(11, '0')}`;
  return `${body}${ean13CheckDigit(body)}`;
}

/**
 * Gera o próximo EAN-13 interno da empresa.
 * A sequência é por empresa, então duas lojas não disputam o mesmo número.
 *
 * ## O gerador não entra na faixa da balança (D-pdv-teclado-16)
 *
 * DEFEITO QUE ISTO CORRIGE: "2 + 11 dígitos de sequência" só fica no "20…"
 * enquanto a sequência não passa de 10^10 − 1. Passando — pelo salto de
 * `ensureBarcode` para depois do MAIOR código "2…" cadastrado, que podia ser um
 * código "21…" posto num produto depois de a balança ser declarada no 21, ou
 * pela simples contagem —, o número seguinte era "21…": a subfaixa que a busca
 * do balcão lê como "PLU + peso". O produto novo ganhava um EAN que, sem
 * casamento exato, virava etiqueta de balança de outro produto. Agora o
 * candidato que cai na faixa declarada (`codigoNaFaixaDaBalanca`, a mesma
 * pergunta que a busca faz) não é entregue: a sequência pula a subfaixa inteira
 * de uma vez, e o próximo número é o primeiro depois dela.
 */
export function generateInternalEan13(companyId: string): string {
  ensureCoreSchema();
  let seq = nextSequenceValue(companyId, 'barcode');
  // A operação declara UMA subfaixa só: um salto basta para sair dela.
  if (seq <= LIMITE_DA_SEQUENCIA && codigoNaFaixaDaBalanca(companyId, eanDaSequencia(seq))) {
    const fimDaSubfaixa = (Math.floor(seq / SEQUENCIAS_POR_SUBFAIXA) + 1) * SEQUENCIAS_POR_SUBFAIXA - 1;
    getConnection()
      .prepare("UPDATE core_sequences SET current = ? WHERE company_id = ? AND name = 'barcode' AND current < ?")
      .run(fimDaSubfaixa, companyId, fimDaSubfaixa);
    seq = nextSequenceValue(companyId, 'barcode');
  }
  if (seq > LIMITE_DA_SEQUENCIA) {
    throw new ApiError(
      'CORE_BARCODE_SEQUENCE_EXHAUSTED',
      'A faixa de códigos de barras internos desta operação acabou (11 dígitos depois do prefixo 2'
        + (lerConfigDaEtiquetaDaBalanca(companyId) ? ', fora a faixa reservada para a etiqueta da balança' : '')
        + '). Cadastre o EAN do fabricante nos produtos novos.',
      409,
    );
  }
  const codigo = eanDaSequencia(seq);
  if (codigoNaFaixaDaBalanca(companyId, codigo)) {
    // Depois do salto, só se a declaração mudasse no meio da conta. Recusa em
    // vez de entregar um código que a busca leria como etiqueta da balança.
    throw new ApiError(
      'CORE_BARCODE_SEQUENCE_EXHAUSTED',
      'Não foi possível reservar um código de barras interno fora da faixa da etiqueta da balança. '
        + 'Cadastre o EAN do fabricante neste produto, ou peça ao suporte para revisar a declaração da balança.',
      409,
    );
  }
  return codigo;
}

export interface AssignResult {
  productId: string;
  barcode: string;
  generated: boolean;
}

/**
 * A maior sequência interna já OCUPADA na empresa — no código principal e nos
 * códigos adicionais. EAN-13 com prefixo 2 lido como "2 + 11 dígitos de
 * sequência + verificador", do mesmo jeito que `generateInternalEan13` monta.
 *
 * DEFEITO QUE ISTO CORRIGE (D-pdv-teclado-16): o MAIOR contava também os
 * códigos da subfaixa da balança. Um "21…" cadastrado num produto depois de a
 * balança ser declarada no 21 arrastava a sequência para dentro dela, e o
 * gerador passava a entregar "21…" (ou, com o pulo da subfaixa, queimava o
 * resto do "20…" inteiro). Os códigos da faixa declarada não são da sequência
 * do gerador e ficam fora da conta.
 */
function maiorSequenciaInternaOcupada(companyId: string): number {
  const padrao = `${INTERNAL_PREFIX}${'[0-9]'.repeat(12)}`;
  const balanca = lerConfigDaEtiquetaDaBalanca(companyId);
  // Sem declaração, um padrão que nenhum código de 13 dígitos casa.
  const daBalanca = balanca ? `${balanca.prefixo}${'[0-9]'.repeat(11)}` : 'x';
  const r = getConnection()
    .prepare(
      `SELECT MAX(CAST(substr(barcode, 2, 11) AS INTEGER)) AS maior FROM (
         SELECT barcode FROM core_products WHERE company_id = ? AND barcode GLOB ?
         UNION ALL
         SELECT barcode FROM core_product_barcodes WHERE company_id = ? AND barcode GLOB ?
       ) WHERE barcode NOT GLOB ?`,
    )
    .get(companyId, padrao, companyId, padrao, daBalanca) as { maior: number | null } | undefined;
  return Number(r?.maior ?? 0);
}

/** Quantas vezes o laço aceita pular número ocupado antes de desistir com frase clara. */
const TENTATIVAS_DE_CODIGO = 50;

/**
 * Garante que o produto tenha código de barras.
 *
 * Se já tiver, devolve o existente sem trocar — trocar o código de um produto
 * já etiquetado invalidaria as etiquetas impressas na prateleira.
 *
 * ## A colisão com código que já existe
 *
 * DEFEITO QUE ISTO CORRIGE, em três partes:
 *
 * 1. O laço conferia só `core_products.barcode`. Um código ADICIONAL
 *    (`core_product_barcodes`) igual ao próximo da sequência — a etiqueta
 *    interna do sistema antigo, importada como adicional — não era visto: o
 *    produto novo ganhava o mesmo número, e o bipe no caixa achava um dos dois.
 *    Agora a conferência é a do PDV (`findProductByAnyBarcode`, as duas tabelas).
 * 2. Eram só cinco tentativas, e o sexto número era gravado SEM conferir. Com
 *    seis ou mais EANs internos contíguos já cadastrados (o cadastro antigo
 *    também gerava "2 + sequência"), o UPDATE batia no índice único e toda a
 *    folha de etiquetas caía em 500 — sempre, porque o ROLLBACK devolvia a
 *    sequência ao mesmo ponto. Agora, na primeira colisão, a sequência salta
 *    para depois do maior interno já ocupado (nas duas tabelas); o candidato
 *    só é aceito depois de conferido; e esgotadas as tentativas a resposta é
 *    409 com a frase, não 500.
 * 3. A gravação não emitia o fato para a central, ao contrário da edição do
 *    cadastro: o EAN novo nunca chegava lá. Agora emite `product.upserted`
 *    dentro da mesma transação.
 */
export function ensureBarcode(companyId: string, productId: string): AssignResult {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const product = db
      .prepare('SELECT id, barcode, workshop_id FROM core_products WHERE id = ? AND company_id = ?')
      .get(productId, companyId) as { id: string; barcode: string | null; workshop_id: string | null } | undefined;
    if (!product) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

    if (product.barcode) {
      return { productId, barcode: product.barcode, generated: false };
    }

    let barcode = generateInternalEan13(companyId);
    let saltou = false;
    let tentativas = 0;
    while (findProductByAnyBarcode(companyId, barcode) !== null) {
      tentativas += 1;
      if (tentativas > TENTATIVAS_DE_CODIGO) {
        throw new ApiError(
          'CORE_BARCODE_SEQUENCE_EXHAUSTED',
          'Não foi possível reservar um código de barras interno livre: os próximos números já estão em uso '
            + 'em outros produtos. Cadastre o EAN do fabricante neste produto, ou peça ao suporte para revisar os códigos importados.',
          409,
        );
      }
      if (!saltou) {
        // O cadastro antigo ocupou uma faixa inteira: pula de uma vez para
        // depois dela, em vez de queimar número por número.
        const maior = Math.min(maiorSequenciaInternaOcupada(companyId), LIMITE_DA_SEQUENCIA);
        db.prepare(
          "UPDATE core_sequences SET current = ? WHERE company_id = ? AND name = 'barcode' AND current < ?",
        ).run(maior, companyId, maior);
        saltou = true;
      }
      barcode = generateInternalEan13(companyId);
    }

    db.prepare('UPDATE core_products SET barcode = ?, updated_at = ? WHERE id = ?').run(
      barcode,
      new Date().toISOString(),
      productId,
    );
    const produto = db.prepare('SELECT * FROM core_products WHERE id = ?').get(productId) as Record<string, unknown>;
    recordDomainEvent({
      eventType: 'product.upserted',
      aggregateType: 'product',
      aggregateId: productId,
      companyId,
      operationalUnitId: product.workshop_id ?? null,
      operation: 'update',
      payload: produto,
    });
    return { productId, barcode, generated: true };
  });
}

export interface LabelItem {
  productId: string;
  name: string;
  internalCode: string;
  barcode: string;
  /**
   * O preço que o CAIXA vai cobrar, não o de tabela.
   *
   * Antes disto a etiqueta saía com `price_cents` cru enquanto o balcão cobrava
   * `effectivePriceCents`: com promoção ativa, prateleira e caixa divergiam — e
   * quem descobria era o cliente. Etiqueta serve para dizer quanto custa; se
   * ela discorda do caixa, ela está mentindo.
   */
  priceCents: number;
  /** Preço de tabela, para a etiqueta poder mostrar o "de / por". */
  listPriceCents: number;
  /**
   * Há promoção valendo agora. A tela avisa, porque a etiqueta impressa hoje
   * continua colada depois que a promoção acabar — aí o caixa cobra MAIS que o
   * papel, que é o erro caro.
   */
  onSale: boolean;
  quantity: number;
  /** Tamanho, cor, tom… — vazio quando o produto não tem nada a dizer. */
  attributes: string;
  /** Os campos que só alguns MODELOS de etiqueta mostram. */
  brand: string;
  unit: string;
  sku: string;
  /** A primeira linha da descrição PÚBLICA (a da loja online), curta. */
  shortDescription: string;
  /** Validade do lote da etiqueta (AAAA-MM-DD) — só quando o formato imprime validade ou lote. */
  validade?: string | null;
  /** Código do lote da etiqueta. */
  lote?: string | null;
  /** O lote de onde saíram validade e código (auditoria e reimpressão). */
  batchId?: string | null;
  /** Este lote gravou agora o código interno do produto — vai para a auditoria e para a tela. */
  codigoGerado?: boolean;
  /**
   * Por que o item está sem código: `ao_imprimir` (prévia de produto que ainda
   * não tem código — ele nasce quando a folha for gerada) ou `sem_permissao`
   * (quem imprimiu não pode gravar código no cadastro).
   */
  codigoPendente?: 'ao_imprimir' | 'sem_permissao' | null;
}

/**
 * A linha de detalhe da etiqueta.
 *
 * `variant_attributes` é JSON livre (`{"tamanho":"M","cor":"Azul"}`), então a
 * etiqueta NÃO decide o que é roupa e o que é maquiagem: imprime o que o
 * produto tiver. Camiseta traz tamanho e cor, batom traz tom, peça de oficina
 * traz o que o cadastro disser — sem lista fechada de categoria para manter.
 *
 * Sem isso, numa arara de camisetas as etiquetas de P, M e G ficam idênticas e
 * só o leitor distingue — o que obriga a bipar peça por peça para saber o que
 * se está segurando.
 *
 * Mora aqui, e não no renderizador, porque a MESMA linha vale para a etiqueta
 * impressa pelo servidor e para a tela de etiquetas. Duas formatações
 * diferentes para o mesmo produto seriam duas etiquetas diferentes.
 */
export function labelAttributes(p: {
  variant_attributes?: unknown;
  brand?: unknown;
  category?: unknown;
}): string {
  if (p.variant_attributes) {
    try {
      const attrs = JSON.parse(String(p.variant_attributes)) as Record<string, unknown>;
      const partes = Object.entries(attrs)
        .filter(([, v]) => String(v ?? '').trim() !== '')
        .map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)} ${String(v)}`);
      if (partes.length) return partes.join(' · ');
    } catch {
      // Cadastro com JSON torto não pode impedir a etiqueta de sair: o produto
      // ainda tem nome, preço e código de barras, que é o que o balcão precisa.
    }
  }
  // Produto solto não tem grade. O que sobra de útil é marca e categoria.
  return [p.brand, p.category]
    .filter((v) => String(v ?? '').trim() !== '')
    .map(String)
    .join(' · ');
}

/** Teto por item: acima disto, outra folha. A tela limita a sugestão ao mesmo número. */
export const TETO_POR_ITEM = 200;

/**
 * Teto do LOTE inteiro.
 *
 * Só havia teto de 1000 LINHAS: "Posição de estoque" + "Marcar todos" + modo
 * saldo chegava a 60 mil etiquetas (≈130 MB de HTML montados e serializados
 * de forma síncrona, com o PDV da loja parado esperando), e pela API 1000 ×
 * 200 = 200 mil. Três mil etiquetas são 100 folhas A4 de 30 — mais do que
 * qualquer impressão de uma vez.
 */
export const TETO_DA_FOLHA = 3000;

export interface OpcoesDaFolha {
  /**
   * Os campos do formato escolhido. Sem eles (a rota antiga de dados), vale o
   * comportamento de antes: gera código para quem não tem e o título é o nome
   * do modelo da grade.
   */
  campos?: readonly LabelField[];
  /**
   * Quem pediu pode gravar código no cadastro (`products.manage`)? Sem isso, o
   * item sem código sai SEM barras e com o aviso — reimprimir etiqueta é
   * operacional, carimbar EAN no cadastro não é.
   */
  podeGerarCodigo?: boolean;
}

interface LinhaDaEtiqueta {
  id: string;
  name: string;
  nome_pai: string | null;
  parent_id: string | null;
  internal_code: string;
  barcode: string | null;
  price_cents: number;
  variant_attributes: string | null;
  brand: string | null;
  category: string | null;
  unit: string | null;
  sku: string | null;
  descricao_publica: string | null;
  tem_filhos: number;
}

/*
  A DESCRIÇÃO é a PÚBLICA (a da loja online), nunca `description`: o
  cadastro chama esta de "Descrição interna — anotação para a equipe, não
  aparece na vitrine", e ela ia parar no adesivo da gôndola. A variante não
  tem descrição online própria (a grade copia só a interna do modelo), então
  herda a do modelo.
*/
const SELECT_DA_ETIQUETA = `
  SELECT p.id, p.name, pai.name AS nome_pai, p.parent_id, p.internal_code, p.barcode, p.price_cents,
         p.variant_attributes, p.brand, p.category, p.unit, p.sku,
         COALESCE(NULLIF(TRIM(p.online_description), ''), pai.online_description) AS descricao_publica,
         EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_filhos
    FROM core_products p
    LEFT JOIN core_products pai ON pai.id = p.parent_id
   WHERE p.id = ? AND p.company_id = ?`;

/**
 * O título da etiqueta.
 *
 * Variante se chama "Camiseta Gola V · Azul · M": o nome JÁ carrega a grade.
 * Quando o formato imprime a linha da grade ("atributos"), o título usa o
 * nome do MODELO e a variação fica com os atributos, como em etiqueta de loja.
 *
 * DEFEITO QUE ISTO CORRIGE: o título era SEMPRE o nome do modelo, e o modelo
 * novo, o formato padrão e o rolo 33 × 22 não marcam "atributos" — P, M, G e
 * GG saíam com quatro etiquetas "Camiseta Básica" idênticas, que só o código
 * de barras distinguia. Sem a linha da grade, o título é o nome COMPLETO da
 * variante.
 */
function tituloDaEtiqueta(p: LinhaDaEtiqueta, campos?: readonly LabelField[]): string {
  if (!p.parent_id || !p.nome_pai) return p.name;
  if (!campos) return p.nome_pai;
  return campos.includes('atributos') ? p.nome_pai : p.name;
}

/**
 * A quantidade de um item, conferida.
 *
 * DEFEITO QUE ISTO CORRIGE: `Math.max(1, Math.min(200, Math.round(q)))`
 * cortava 350 para 200 EM SILÊNCIO enquanto a tela prometia 350 — metade da
 * mercadoria ficava sem adesivo e ninguém percebia até a prateleira. E
 * `quantity: "abc"` virava NaN, o laço gerava zero etiquetas e o resumo e a
 * auditoria gravavam NaN. Agora o que não é inteiro de 1 a 200 é recusado,
 * dizendo o produto.
 */
function quantidadeDoItem(bruta: unknown, nome: string, productId: string): number {
  if (bruta === undefined || bruta === null || bruta === '') return 1;
  const n = typeof bruta === 'number' ? bruta : typeof bruta === 'string' ? Number(bruta.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > TETO_POR_ITEM) {
    throw new ApiError(
      'CORE_LABEL_QUANTITY_INVALID',
      `Quantidade de etiquetas de "${nome}": informe um número inteiro de 1 a ${TETO_POR_ITEM} (veio "${String(bruta)}"). `
        + `Para mais de ${TETO_POR_ITEM}, gere outra folha.`,
      400,
      { productId, quantidade: bruta },
    );
  }
  return n;
}

/**
 * Monta os dados das etiquetas a imprimir, gerando código para quem não tem
 * quando o formato imprime código e quem pediu pode gravar no cadastro.
 *
 * ## Tudo conferido antes da primeira escrita, e numa transação só
 *
 * DEFEITO QUE ISTO CORRIGE: cada item chamava `ensureBarcode` com o próprio
 * commit, antes de conferir o próximo. Numa lista de 300 com o último item
 * apagado entre listar e gerar, os 299 anteriores ganhavam EAN gravado, a
 * resposta era 404, não saía folha e nenhuma auditoria dizia quais códigos
 * nasceram. Agora existência, modelo de grade, quantidade e teto do lote são
 * conferidos para TODOS antes de gravar, e a gravação é uma transação.
 *
 * ## Código só quando a etiqueta imprime código
 *
 * O cartaz de gôndola não tem código de barras — e mesmo assim cada produto
 * sem código ganhava um EAN interno, consumindo a sequência sem ninguém pedir.
 */
export function buildLabels(
  companyId: string,
  requests: { productId: string; quantity?: unknown; batchId?: unknown }[],
  opcoes: OpcoesDaFolha = {},
): LabelItem[] {
  ensureCoreSchema();
  const db = getConnection();
  const { campos, podeGerarCodigo = true } = opcoes;
  const precisaDeCodigo = !campos || campos.includes('barras') || campos.includes('ean');
  const precisaDeLote = Boolean(campos && (campos.includes('validade') || campos.includes('lote')));

  const linhas = requests.map((request) => {
    const id = String(request?.productId ?? '');
    const p = db.prepare(SELECT_DA_ETIQUETA).get(id, companyId) as LinhaDaEtiqueta | undefined;
    if (!p) {
      throw new ApiError(
        'CORE_PRODUCT_NOT_FOUND',
        `Produto não encontrado (${id || 'sem identificação'}): ele pode ter sido excluído depois de entrar na fila. `
          + 'Recarregue a lista e gere a folha de novo — nenhum código foi gravado.',
        404,
        { productId: id },
      );
    }
    // O modelo de uma grade não é vendido: a busca do PDV o exclui, então um
    // EAN gravado nele seria "produto não encontrado" no caixa.
    if (p.tem_filhos) {
      throw new ApiError(
        'CORE_LABEL_GRID_MODEL',
        `"${p.name}" é o MODELO de uma grade: nenhuma peça é vendida com o código dele e o leitor do caixa não o acharia. `
          + 'Etiquete as variantes (origem "Grade do modelo").',
        400,
        { productId: id },
      );
    }
    return {
      p,
      quantidade: quantidadeDoItem(request?.quantity, p.name, id),
      // Conferido aqui, antes de qualquer escrita, como o resto do lote.
      lote: loteDaEtiqueta(companyId, p.id, request?.batchId, precisaDeLote),
    };
  });

  const total = linhas.reduce((t, l) => t + l.quantidade, 0);
  if (total > TETO_DA_FOLHA) {
    throw new ApiError(
      'CORE_LABELS_TOO_MANY',
      `O lote pede ${total.toLocaleString('pt-BR')} etiquetas e o limite é ${TETO_DA_FOLHA.toLocaleString('pt-BR')} por folha gerada. `
        + 'Divida em mais de uma impressão (por exemplo, marque menos produtos ou reduza as quantidades).',
      400,
      { total, teto: TETO_DA_FOLHA },
    );
  }

  return withTransaction(() =>
    linhas.map(({ p, quantidade, lote }) => {
      let barcode = p.barcode ?? '';
      let codigoGerado = false;
      let codigoPendente: LabelItem['codigoPendente'] = null;
      if (!barcode && precisaDeCodigo) {
        if (podeGerarCodigo) {
          const r = ensureBarcode(companyId, p.id);
          barcode = r.barcode;
          codigoGerado = r.generated;
        } else {
          codigoPendente = 'sem_permissao';
        }
      }
      // O preço vigente vem da MESMA função que o balcão usa. É o que impede a
      // prateleira de anunciar um valor e o caixa cobrar outro.
      const vigente = effectivePriceCents(companyId, p.id, p.price_cents, p.category);
      return {
        productId: p.id,
        name: tituloDaEtiqueta(p, campos),
        internalCode: p.internal_code,
        barcode,
        priceCents: vigente.priceCents,
        listPriceCents: p.price_cents,
        onSale: vigente.onSale,
        quantity: quantidade,
        attributes: labelAttributes(p),
        brand: p.brand ?? '',
        unit: p.unit ?? '',
        sku: p.sku ?? '',
        shortDescription: descricaoCurta(p.descricao_publica),
        validade: lote?.expires_on ?? null,
        lote: lote?.code ?? null,
        batchId: lote?.id ?? null,
        codigoGerado,
        codigoPendente,
      };
    }),
  );
}

/**
 * O LOTE da etiqueta, quando o formato imprime validade ou lote.
 *
 * Com `batchId`, é aquele lote — conferido contra o produto E a empresa (o id
 * de outra operação é "não encontrado", nunca a validade de outra loja). Sem,
 * o lote COM SALDO que vence primeiro: é o que está na prateleira para sair
 * antes (FEFO), o critério da baixa. Produto sem lote declarado sai sem a
 * linha — inventar validade seria pior que não ter.
 */
function loteDaEtiqueta(
  companyId: string,
  productId: string,
  batchId: unknown,
  precisa: boolean,
): { id: string; code: string; expires_on: string | null } | null {
  const db = getConnection();
  const id = batchId === undefined || batchId === null || batchId === '' ? null : String(batchId);
  if (id) {
    const l = db
      .prepare('SELECT id, code, expires_on FROM core_product_batches WHERE id = ? AND company_id = ? AND product_id = ?')
      .get(id, companyId, productId) as { id: string; code: string; expires_on: string | null } | undefined;
    if (!l) {
      throw new ApiError('CORE_BATCH_NOT_FOUND', `O lote informado (${id}) não é deste produto nesta operação.`, 404, { productId, batchId: id });
    }
    return l;
  }
  if (!precisa) return null;
  const l = db
    .prepare(
      `SELECT b.id, b.code, b.expires_on
         FROM core_product_batches b
        WHERE b.company_id = ? AND b.product_id = ?
          AND (SELECT COALESCE(SUM(m.quantity), 0) FROM core_stock_movements m
                WHERE m.batch_id = b.id AND m.company_id = b.company_id) > 0
        ORDER BY (b.expires_on IS NULL), b.expires_on ASC, b.created_at ASC
        LIMIT 1`,
    )
    .get(companyId, productId) as { id: string; code: string; expires_on: string | null } | undefined;
  return l ?? null;
}

/** A primeira linha da descrição, até 60 caracteres. */
function descricaoCurta(descricao: string | null | undefined): string {
  const linha = String(descricao ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  return linha.length > 60 ? `${linha.slice(0, 59)}…` : linha;
}

/**
 * O EAN-13 da AMOSTRA da prévia.
 *
 * DEFEITO QUE ISTO CORRIGE: a amostra era '200000000001' + verificador — o
 * MESMO número que `generateInternalEan13` dá à sequência 1, ou seja, o código
 * real do primeiro produto da loja que ganhou EAN interno. Quem imprimisse a
 * prévia, ou bipasse a tela para testar, vendia aquele produto. A amostra usa
 * o prefixo 040 (circulação restrita DENTRO de uma empresa, que o gerador
 * desta casa nunca usa: ele só usa o 2).
 */
export const EAN_DE_AMOSTRA = (() => {
  const corpo = '040000000000';
  return `${corpo}${ean13CheckDigit(corpo)}`;
})();

/**
 * A amostra da prévia é o PIOR CASO, e não o caso bonito.
 *
 * Com "R$ 19,90" e nome curto a prévia parecia perfeita num modelo onde um
 * preço de quatro dígitos, ou uma promoção com o "de", vazava do adesivo. O
 * gestor confere o desenho com o que vai dar errado primeiro: nome de 60
 * letras, preço de R$ 9.999,99 em promoção com o "de" R$ 12.999,99.
 */
const AMOSTRA_DE_PIOR_CASO: Omit<LabelItem, 'quantity'> = {
  productId: 'amostra',
  name: 'Kit hidratante corporal de amêndoas com óleo de argan 500 ml',
  internalCode: 'GS-000123',
  barcode: EAN_DE_AMOSTRA,
  priceCents: 999_999,
  listPriceCents: 1_299_999,
  onSale: true,
  attributes: 'Tamanho GG · Cor Azul-marinho',
  brand: 'Marca',
  unit: 'UN',
  sku: 'SKU-0123',
  shortDescription: 'Descrição do produto na loja online',
  // A amostra traz validade e lote: o modelo que os marca mostra a linha na prévia.
  validade: '2026-12-31',
  lote: 'L2409-0001',
};

/**
 * O item da PRÉVIA de um modelo de etiqueta. Só LÊ: ao contrário de
 * `buildLabels`, não grava código de barras em produto nenhum — conferir o
 * desenho não pode mudar o cadastro. Sem produto, a amostra de pior caso.
 *
 * Produto real SEM código não ganha mais a amostra no lugar do dele (a prévia
 * mostrava um número que não era o que ia sair): vai sem barras, com o aviso
 * de que o código nasce ao imprimir.
 */
export function itemParaPrevia(
  companyId: string,
  productId: string | null,
  quantity: unknown = 1,
  campos?: readonly LabelField[],
): LabelItem {
  ensureCoreSchema();
  const quantidade = Math.max(1, Math.min(60, Math.round(Number(quantity) || 1)));
  if (!productId) return { ...AMOSTRA_DE_PIOR_CASO, quantity: quantidade };
  const p = getConnection().prepare(SELECT_DA_ETIQUETA).get(productId, companyId) as LinhaDaEtiqueta | undefined;
  if (!p) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
  const vigente = effectivePriceCents(companyId, p.id, p.price_cents, p.category);
  // O lote que a folha usaria (só leitura): a prévia mostra a validade que vai sair.
  const lote = campos && (campos.includes('validade') || campos.includes('lote')) ? loteDaEtiqueta(companyId, p.id, null, true) : null;
  return {
    productId: p.id,
    name: tituloDaEtiqueta(p, campos),
    internalCode: p.internal_code,
    barcode: p.barcode ?? '',
    priceCents: vigente.priceCents,
    listPriceCents: p.price_cents,
    onSale: vigente.onSale,
    quantity: quantidade,
    attributes: labelAttributes(p),
    brand: p.brand ?? '',
    unit: p.unit ?? '',
    sku: p.sku ?? '',
    shortDescription: descricaoCurta(p.descricao_publica),
    validade: lote?.expires_on ?? null,
    lote: lote?.code ?? null,
    batchId: lote?.id ?? null,
    codigoPendente: p.barcode ? null : 'ao_imprimir',
  };
}
