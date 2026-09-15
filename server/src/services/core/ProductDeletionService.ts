/**
 * EXCLUIR PRODUTO — SÓ O QUE NUNCA ACONTECEU SAI DO BANCO.
 *
 * ## Por que não um `DELETE FROM core_products` e a FK que se vire
 *
 * Com `PRAGMA foreign_keys = ON`, as tabelas NO ACTION (venda, nota de entrada,
 * OS, pedido…) barrariam o DELETE sozinhas — mas as CASCADE não barram nada,
 * APAGAM. E entre elas estão o razão de estoque (`core_stock_movements`), as
 * unidades serializadas (chassi, IMEI, placa) e os lotes. Um produto que só
 * teve uma entrada manual sumiria com a entrada junto, sem erro nenhum: o
 * histórico que o razão existe para guardar, apagado pelo próprio cadastro.
 *
 * E a FK nem é a mesma nos dois bancos: em banco migrado, `parent_id` veio por
 * ALTER sem `ON DELETE` (core-migrations.ts), e o que cai em CASCADE num banco
 * novo seria recusado no outro. A decisão não pode depender disso.
 *
 * ## A regra
 *
 * "Tem histórico?" é uma pergunta de NEGÓCIO, respondida por uma lista escrita
 * aqui — `REFERENCIAS_AO_PRODUTO` — que classifica toda tabela que aponta para
 * produto em três destinos:
 *
 *   - `historico`: prende o produto. Qualquer linha dela, no produto ou em uma
 *     das variantes dele, e a exclusão vira 409 com a contagem e a saída
 *     (inativar/arquivar).
 *   - `limpeza`: configuração do próprio cadastro (códigos, fotos, preços,
 *     faixas, promoção nunca usada, campos personalizados, de-para de
 *     fornecedor, carrinho, saldo zerado). Sai junto, EXPLICITAMENTE — não
 *     pelo CASCADE, que no banco migrado pode não existir.
 *   - `variante`: a grade. Sai depois das filhas dela e antes do modelo.
 *
 * `produto-exclusao-conhece-todas-as-filhas.test.ts` confere a lista contra o
 * esquema: a próxima tabela com FK para produto derruba o teste até alguém
 * decidir, por escrito, em qual dos três destinos ela entra.
 *
 * ## O que a exclusão deixa
 *
 * A trilha (`product.deleted`, com o retrato do que era — nome e códigos, porque
 * o id sozinho não diz mais nada a ninguém) e o tombstone da central: o mesmo
 * `product.deactivated` que o Projector já transforma em `deactivated_at`, com
 * a operação `delete`. Os arquivos das fotos saem do disco DEPOIS do commit:
 * um rollback não pode deixar o cadastro apontando para uma foto apagada.
 */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { uploadsDir } from './ProductImageService.js';

export type DestinoDaReferencia = 'historico' | 'limpeza' | 'variante';

export interface ReferenciaAoProduto {
  tabela: string;
  coluna: string;
  destino: DestinoDaReferencia;
  /** Chave estável do motivo na recusa (só `historico`). */
  codigo?: string;
  /** Como a recusa conta: [singular, plural]. */
  rotulo?: readonly [string, string];
  /**
   * O que se conta. `DISTINCT <documento>` quando o que importa para quem lê é
   * QUANTOS documentos (uma venda com duas linhas do mesmo produto é uma venda).
   */
  conta?: string;
  /** Condição extra da linha (a tabela serve a mais de uma entidade). */
  filtro?: string;
}

function historico(
  tabela: string,
  coluna: string,
  codigo: string,
  rotulo: readonly [string, string],
  conta = '*',
): ReferenciaAoProduto {
  return { tabela, coluna, destino: 'historico', codigo, rotulo, conta };
}

function limpeza(tabela: string, coluna = 'product_id', filtro?: string): ReferenciaAoProduto {
  return { tabela, coluna, destino: 'limpeza', filtro };
}

/**
 * Toda tabela que aponta para um produto, e o que ela significa para excluí-lo.
 */
export const REFERENCIAS_AO_PRODUTO: readonly ReferenciaAoProduto[] = [
  // --------------------------------------------- documentos (FK NO ACTION)
  historico('core_sale_items', 'product_id', 'vendas', ['venda', 'vendas'], 'DISTINCT sale_id'),
  historico('core_sale_return_items', 'product_id', 'devolucoes_de_venda', ['devolução de venda', 'devoluções de venda'], 'DISTINCT return_id'),
  historico('core_sale_removed_items', 'product_id', 'retirados_de_venda', ['item retirado do carrinho de uma venda', 'itens retirados do carrinho de vendas']),
  historico('core_quote_items', 'product_id', 'orcamentos', ['orçamento ou pré-venda', 'orçamentos ou pré-vendas'], 'DISTINCT quote_id'),
  historico('core_consignment_items', 'product_id', 'consignacoes', ['consignação', 'consignações'], 'DISTINCT consignment_id'),
  historico('core_rental_contract_items', 'product_id', 'locacoes', ['contrato de locação', 'contratos de locação'], 'DISTINCT contract_id'),
  historico('core_inventory_count_items', 'product_id', 'inventarios', ['contagem de inventário', 'contagens de inventário'], 'DISTINCT count_id'),
  historico('core_purchase_order_items', 'product_id', 'pedidos_de_compra', ['pedido de compra', 'pedidos de compra'], 'DISTINCT order_id'),
  historico('core_inbound_note_items', 'product_id', 'notas_de_entrada', ['nota de entrada', 'notas de entrada'], 'DISTINCT note_id'),
  historico('core_supplier_return_items', 'product_id', 'devolucoes_a_fornecedor', ['devolução a fornecedor', 'devoluções a fornecedor'], 'DISTINCT return_id'),
  historico('core_import_batch_items', 'product_id', 'importacoes', ['importação de planilha', 'importações de planilha'], 'DISTINCT batch_id'),
  historico('core_service_order_parts', 'product_id', 'ordens_de_servico', ['ordem de serviço', 'ordens de serviço'], 'DISTINCT order_id'),
  historico('core_order_items', 'product_id', 'pedidos_online', ['pedido online', 'pedidos online'], 'DISTINCT order_id'),
  historico('core_equipment', 'linked_product_id', 'equipamentos', ['equipamento vinculado', 'equipamentos vinculados']),

  // ------------------------------- histórico que a FK apagaria (CASCADE)
  // O razão é append-only justamente para que nenhum gesto de cadastro o
  // reescreva; uma entrada manual já é histórico.
  historico('core_stock_movements', 'product_id', 'movimentos_estoque', ['movimento de estoque', 'movimentos de estoque']),
  historico('core_product_units', 'product_id', 'unidades_serializadas', ['unidade serializada (chassi, IMEI, placa)', 'unidades serializadas (chassi, IMEI, placa)']),
  historico('core_product_unit_holds', 'product_id', 'reservas_de_unidade', ['reserva de unidade', 'reservas de unidade']),
  historico('core_product_batches', 'product_id', 'lotes', ['lote', 'lotes']),
  historico('core_product_fiscal_suggestions', 'product_id', 'sugestoes_fiscais', ['sugestão fiscal vinda de nota', 'sugestões fiscais vindas de notas']),
  historico('core_product_reviews', 'product_id', 'avaliacoes', ['avaliação de cliente', 'avaliações de clientes']),
  // RESTRICT: um kit que usa este produto como componente se desmonta antes.
  historico('core_kit_components', 'component_id', 'componente_de_kit', ['kit que usa este produto como componente', 'kits que usam este produto como componente'], 'DISTINCT kit_id'),

  // ------------------------------------------- configuração do cadastro
  limpeza('core_product_barcodes'),
  limpeza('core_product_images'),
  limpeza('core_price_table_items'),
  limpeza('core_product_price_tiers'),
  // Promoção USADA em venda ou pedido é conferida à parte (`promocaoUsada`).
  limpeza('core_promotions'),
  limpeza('core_custom_field_values', 'entity_id', "entity = 'product'"),
  limpeza('core_supplier_item_codes'),
  limpeza('core_customer_cart_items'),
  // Saldo DIFERENTE DE ZERO é conferido à parte (`saldoEmEstoque`).
  limpeza('core_stock'),
  // O produto é o KIT: a receita dele sai junto.
  limpeza('core_kit_components', 'kit_id'),

  // ------------------------------------------------------------------ grade
  { tabela: 'core_products', coluna: 'parent_id', destino: 'variante' },
];

export interface MotivoDoHistorico {
  codigo: string;
  rotulo: string;
  quantidade: number;
}

function marcas(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

function contar(db: DatabaseSync, sql: string, params: string[]): number {
  const linha = db.prepare(sql).get(...params) as { n: number | null } | undefined;
  return Number(linha?.n ?? 0);
}

function rotuloDe(quantidade: number, rotulo: readonly [string, string]): string {
  return `${quantidade} ${quantidade === 1 ? rotulo[0] : rotulo[1]}`;
}

/**
 * O que prende o produto (e as variantes dele), contado. Lista vazia = pode
 * excluir.
 */
function historicoDe(db: DatabaseSync, ids: string[], companyId: string): MotivoDoHistorico[] {
  const motivos: MotivoDoHistorico[] = [];
  const emIds = marcas(ids);
  const anotar = (codigo: string, rotulo: readonly [string, string], quantidade: number) => {
    if (quantidade > 0) motivos.push({ codigo, rotulo: rotuloDe(quantidade, rotulo), quantidade });
  };

  for (const ref of REFERENCIAS_AO_PRODUTO) {
    if (ref.destino !== 'historico') continue;
    const filtro = ref.filtro ? ` AND ${ref.filtro}` : '';
    anotar(
      ref.codigo!,
      ref.rotulo!,
      contar(
        db,
        `SELECT COUNT(${ref.conta ?? '*'}) AS n FROM ${ref.tabela} WHERE ${ref.coluna} IN (${emIds})${filtro}`,
        ids,
      ),
    );
  }

  // Saldo que não é zero: há mercadoria (ou promessa dela) contada em nome do
  // produto. Apagar o cadastro faria o saldo sumir sem movimento que explique.
  anotar(
    'saldo_em_estoque',
    ['cadastro com saldo em estoque', 'cadastros com saldo em estoque'],
    contar(
      db,
      `SELECT COUNT(*) AS n FROM core_stock
        WHERE product_id IN (${emIds}) AND (quantity <> 0 OR reserved <> 0)`,
      ids,
    ),
  );

  // Promoção deste produto que já deu preço a uma venda ou a um pedido. O
  // `promotion_id` das linhas não tem FK: apagar a promoção deixaria o id
  // pendurado no histórico e quebraria a conta do teto de unidades.
  anotar(
    'promocao_usada',
    ['venda ou pedido feito pela promoção do produto', 'vendas ou pedidos feitos pela promoção do produto'],
    contar(
      db,
      `SELECT (SELECT COUNT(*) FROM core_sale_items WHERE promotion_id IN (SELECT id FROM core_promotions WHERE product_id IN (${emIds})))
            + (SELECT COUNT(*) FROM core_order_items WHERE promotion_id IN (SELECT id FROM core_promotions WHERE product_id IN (${emIds}))) AS n`,
      [...ids, ...ids],
    ),
  );

  // VENDA OFFLINE PENDENTE: o PDV vendeu com o servidor fora do ar, o reenvio
  // foi recusado de vez (gaveta fechada, saldo que acabou) e a venda foi
  // ENTREGUE como pendência — o dinheiro dela já está na gaveta. O relançamento
  // chama `createSale` com o corpo guardado, que aponta o produto por id dentro
  // de um JSON sem FK. Apagar o cadastro tornaria o relançamento 404 para
  // sempre: a venda que aconteceu não teria mais como ser registrada. Só a
  // PENDENTE prende — regularizada já é venda (conta acima), descartada não vai
  // existir. Corpo ilegível é ignorado (não é deste produto que se sabe nada).
  anotar(
    'vendas_offline_pendentes',
    ['venda feita offline esperando relançamento', 'vendas feitas offline esperando relançamento'],
    contar(
      db,
      `SELECT COUNT(*) AS n FROM core_offline_sale_pendings o
        WHERE o.company_id = ? AND o.status = 'pendente'
          AND EXISTS (
            SELECT 1
              FROM json_each(CASE WHEN json_valid(o.request_body) THEN o.request_body ELSE '{}' END, '$.items') j
             WHERE j.type = 'object' AND json_extract(j.value, '$.productId') IN (${emIds})
          )`,
      [companyId, ...ids],
    ),
  );

  return motivos;
}

export interface ProdutoExcluido {
  id: string;
  name: string;
  internal_code: string | null;
  barcode: string | null;
  sku: string | null;
  barcodes: string[];
  variants: { id: string; name: string; internal_code: string | null; barcode: string | null }[];
  images: number;
}

/**
 * Exclui o produto se ele nunca aconteceu; senão, 409 com o que o prende.
 *
 * Tudo numa transação: a pergunta "tem histórico?" e a exclusão enxergam o
 * mesmo banco, e uma venda que chegue no meio não encontra metade do cadastro.
 */
export function excluirProduto(input: {
  companyId: string;
  productId: string;
  userId?: string | null;
}): ProdutoExcluido {
  ensureCoreSchema();
  const arquivos: string[] = [];

  const retrato = withTransaction(() => {
    const db = getConnection();
    const produto = db
      .prepare('SELECT * FROM core_products WHERE id = ? AND company_id = ?')
      .get(input.productId, input.companyId) as Record<string, unknown> | undefined;
    // Outra empresa é "não existe", como em toda leitura por id.
    if (!produto) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

    const variantes = db
      .prepare('SELECT * FROM core_products WHERE parent_id = ? AND company_id = ? ORDER BY internal_code')
      .all(input.productId, input.companyId) as Record<string, unknown>[];
    const ids = [input.productId, ...variantes.map((v) => String(v.id))];
    const nome = String(produto.name ?? '');

    const motivos = historicoDe(db, ids, input.companyId);
    if (motivos.length > 0) {
      throw new ApiError(
        'CORE_PRODUCT_HAS_HISTORY',
        `"${nome}" não pode ser excluído: ele já tem histórico (${motivos.map((m) => m.rotulo).join(', ')}). `
          + 'Excluir apagaria o que já aconteceu. Inative (arquive) o produto: ele sai da venda, da busca e '
          + 'da loja, e o histórico continua de pé.',
        409,
        {
          productId: input.productId,
          historico: motivos,
          saida: 'inativar',
          ativo: Number(produto.active) === 1,
        },
      );
    }

    // O retrato ANTES de apagar: é o que a trilha guarda.
    const barcodes = (
      db
        .prepare('SELECT barcode FROM core_product_barcodes WHERE product_id = ? ORDER BY created_at, barcode')
        .all(input.productId) as { barcode: string }[]
    ).map((b) => b.barcode);
    const imagens = db
      .prepare(`SELECT url, thumb_url FROM core_product_images WHERE product_id IN (${marcas(ids)})`)
      .all(...ids) as { url: string; thumb_url: string | null }[];
    for (const imagem of imagens) {
      // Só o NOME do arquivo decide o caminho, como em `removeProductImage`:
      // a URL gravada nunca vira caminho de disco inteira. A miniatura do
      // balcão sai junto com o original — sem a linha, nada mais a cita.
      for (const caminho of [imagem.url, imagem.thumb_url]) {
        const arquivo = String(caminho ?? '').split('/').pop();
        if (arquivo) arquivos.push(arquivo);
      }
    }
    const retratoDoProduto: ProdutoExcluido = {
      id: input.productId,
      name: nome,
      internal_code: (produto.internal_code as string | null) ?? null,
      barcode: (produto.barcode as string | null) ?? null,
      sku: (produto.sku as string | null) ?? null,
      barcodes,
      variants: variantes.map((v) => ({
        id: String(v.id),
        name: String(v.name ?? ''),
        internal_code: (v.internal_code as string | null) ?? null,
        barcode: (v.barcode as string | null) ?? null,
      })),
      images: imagens.length,
    };

    try {
      for (const ref of REFERENCIAS_AO_PRODUTO) {
        if (ref.destino !== 'limpeza') continue;
        const filtro = ref.filtro ? ` AND ${ref.filtro}` : '';
        db.prepare(`DELETE FROM ${ref.tabela} WHERE ${ref.coluna} IN (${marcas(ids)})${filtro}`).run(...ids);
      }
      // A grade antes do modelo: no banco migrado `parent_id` não tem CASCADE.
      db.prepare('DELETE FROM core_products WHERE parent_id = ? AND company_id = ?').run(
        input.productId,
        input.companyId,
      );
      db.prepare('DELETE FROM core_products WHERE id = ? AND company_id = ?').run(
        input.productId,
        input.companyId,
      );
    } catch (err) {
      /*
        Uma FK que a lista não conhece (tabela de um banco antigo, fora do
        esquema canônico) recusa o DELETE. Isso não é erro interno: é histórico
        que ninguém classificou — e a resposta segura é a mesma, inativar.
      */
      if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
        throw new ApiError(
          'CORE_PRODUCT_HAS_HISTORY',
          `"${nome}" não pode ser excluído: outro registro do banco ainda aponta para ele. `
            + 'Inative (arquive) o produto: ele sai da venda, da busca e da loja, e o histórico continua de pé.',
          409,
          { productId: input.productId, historico: [], saida: 'inativar', ativo: Number(produto.active) === 1 },
        );
      }
      throw err;
    }

    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: 'product.deleted',
      entityType: 'product',
      entityId: input.productId,
      detail: retratoDoProduto,
    });

    // O tombstone da central: o mesmo evento da desativação, que o Projector já
    // grava como `deactivated_at`, marcado com a operação de exclusão. Um
    // TAMANHO excluído sozinho vai como variante: a central guarda variante em
    // `erp_product_variants`, e um `product.deactivated` com o id dele criaria
    // em `erp_products` uma linha que nunca foi produto lá.
    const agora = new Date().toISOString();
    const ehVariante = Boolean(produto.parent_id);
    recordDomainEvent({
      eventType: ehVariante ? 'product_variant.upserted' : 'product.deactivated',
      aggregateType: ehVariante ? 'product_variant' : 'product',
      aggregateId: input.productId,
      companyId: input.companyId,
      operationalUnitId: (produto.workshop_id as string | null) ?? null,
      operation: 'delete',
      payload: { ...produto, active: 0, deleted: true, updated_at: agora },
      occurredAt: agora,
    });
    for (const v of variantes) {
      recordDomainEvent({
        eventType: 'product_variant.upserted',
        aggregateType: 'product_variant',
        aggregateId: String(v.id),
        companyId: input.companyId,
        operation: 'delete',
        payload: { ...v, active: 0, deleted: true, updated_at: agora },
        occurredAt: agora,
      });
    }

    return retratoDoProduto;
  });

  // Os arquivos saem DEPOIS do commit. Arquivo já ausente não é motivo de
  // falha: o objetivo é a foto deixar de existir.
  for (const arquivo of arquivos) {
    try {
      unlinkSync(join(uploadsDir(), arquivo));
    } catch {
      /* já não estava lá */
    }
  }
  return retrato;
}
