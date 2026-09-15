/**
 * Clonar produto — e as seis decisões que isso obriga a tomar.
 *
 * "Copiar o produto" parece uma linha e não é. Cada campo copiado é uma
 * escolha, e as erradas só aparecem depois: código de barras duplicado que o
 * banco recusa no meio do cadastro, estoque inventado que ninguém comprou,
 * foto que some do original quando alguém apaga a do clone.
 *
 * O QUE VAI JUNTO
 *
 *  - Todos os campos de cadastro: nome, descrição, preços, pisos, tributação,
 *    medidas de envio, unidade, categoria, marca, oficina.
 *  - As PEÇAS DO KIT. Clonar um kit sem a composição devolveria uma casca —
 *    e as linhas apontam para produtos que continuam existindo, então copiar
 *    é barato e não duplica cadastro nenhum.
 *  - Os PREÇOS EM TABELA. Mesmo motivo: quem clona um item de atacado espera
 *    o acordo junto.
 *  - As FOTOS, com o ARQUIVO duplicado. Esta é a decisão menos óbvia: copiar
 *    só a linha do banco faria os dois produtos apontarem para o mesmo arquivo,
 *    e `removeProductImage` faz `unlinkSync` — apagar a foto de um quebraria a
 *    do outro, em silêncio, meses depois.
 *
 * O QUE NÃO VAI
 *
 *  - CÓDIGO DE BARRAS, principal e adicionais. São únicos por empresa, e o
 *    próprio insert recusa duplicata. Um código identifica UM item físico; o
 *    clone é outro item e precisa do seu.
 *  - ESTOQUE. Cadastro não é mercadoria. Copiar saldo inventaria peça que
 *    ninguém comprou, e o razão de movimentos não teria de onde ter vindo.
 *  - VARIANTES. Uma variante é um produto com pai — clonar o modelo seria
 *    clonar N produtos, cada um precisando do próprio código de barras. É
 *    outra operação, e fingir que cabe aqui entregaria uma grade sem códigos.
 *  - CÓDIGO INTERNO. Vem da sequência da empresa, como em qualquer produto novo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { createProduct, getProduct } from './CatalogService.js';
import {
  addProductImage,
  listProductImages,
  uploadsDir,
} from './ProductImageService.js';
import { listKitComponents, setKitComponents } from './CatalogAuxService.js';
import { setBatchControl } from './BatchService.js';

/** Sufixo do nome do clone. Dois produtos com nome idêntico confundem a busca. */
const SUFIXO = '(cópia)';

function nomeDoClone(original: string, pedido?: string | null): string {
  const escolhido = String(pedido ?? '').trim();
  if (escolhido) return escolhido;
  return `${original} ${SUFIXO}`.slice(0, 200);
}

export function cloneProduct(
  companyId: string,
  productId: string,
  options: { name?: string | null } = {},
): Record<string, unknown> {
  ensureCoreSchema();

  const origem = getProduct(companyId, productId) as unknown as Record<string, unknown> | null;
  if (!origem) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

  // Variante não se clona: ela existe em função de um modelo, e um clone solto
  // ficaria órfão de grade, com atributos que não descrevem nada.
  if (origem.parent_id) {
    throw new ApiError(
      'CORE_CLONE_VARIANT',
      'Variante não é clonada sozinha. Clone o produto-modelo e monte a grade dele.',
      400,
    );
  }

  const texto = (v: unknown) => (v == null ? undefined : String(v));
  const numero = (v: unknown) => (v == null ? undefined : Number(v));

  /*
    O FORNECEDOR SÓ VAI SE FOR UM CADASTRO DE VERDADE (A-produto-10).

    Cadastros antigos guardavam o NOME digitado em `supplier_id` ("Distribuidora
    Beleza"), e o cadastro agora recusa id que não seja de um fornecedor desta
    operação. Copiar esse texto faria o clone inteiro ser recusado por um
    vínculo que nunca funcionou no original — então ele não é herdado.
  */
  const fornecedorOrigem = texto(origem.supplier_id);
  const fornecedorValido = fornecedorOrigem
    && getConnection()
      .prepare('SELECT 1 AS ok FROM core_suppliers WHERE id = ? AND company_id = ?')
      .get(fornecedorOrigem, companyId)
    ? fornecedorOrigem
    : undefined;

  const clone = createProduct(companyId, {
    name: nomeDoClone(String(origem.name ?? ''), options.name),
    description: texto(origem.description),
    // `barcode` e `sku` ficam de fora: são únicos por empresa.
    category: texto(origem.category),
    subcategory: texto(origem.subcategory),
    brand: texto(origem.brand),
    unit: texto(origem.unit),
    costCents: numero(origem.cost_cents),
    priceCents: numero(origem.price_cents),
    minStock: numero(origem.min_stock),
    supplierId: fornecedorValido,
    ncm: texto(origem.ncm),
    cest: texto(origem.cest),
    cfop: texto(origem.cfop),
    origin: texto(origem.origin),
    taxProfile: texto(origem.tax_profile),
    active: origem.active !== 0,
    // O clone nasce FORA da vitrine, mesmo que o original esteja publicado.
    // Produto recém-copiado ainda não tem código de barras nem foto conferida;
    // publicar por herança poria à venda algo que ninguém revisou.
    publishOnline: false,
    onlineDescription: texto(origem.online_description),
    kind: texto(origem.kind),
    workshopId: texto(origem.workshop_id) ?? null,
    weightGrams: numero(origem.weight_grams),
    heightCm: numero(origem.height_cm),
    widthCm: numero(origem.width_cm),
    lengthCm: numero(origem.length_cm),
    reference: texto(origem.reference),
    minPriceCents: numero(origem.min_price_cents),
    minMarkupPercent: numero(origem.min_markup_percent),
    minMarginPercent: numero(origem.min_margin_percent),
    openPrice: origem.open_price === 1,
    kitExplodeOnSale: origem.kit_explode_on_sale !== 0,
    kitCostFromComponents: origem.kit_cost_from_components === 1,
    /*
      COMO A MERCADORIA SAI DA PRATELEIRA TAMBÉM É CADASTRO (A-produto-14).

      O clone não repassava nada disto, e `createProduct` lê `stockControl`
      ausente como "controla": clonar "Aplicação de película" (serviço, sem
      estoque) gerava um produto com saldo 0 que controla estoque — e a
      primeira venda no PDV era recusada por falta de saldo de algo que nunca
      teve prateleira. Embalagem, endereço, peso, tara e unidade serializada
      são o mesmo tipo de fato. O PLU fica de fora: é único por empresa, como
      o código de barras.
    */
    stockControl: origem.stock_control !== 0,
    packFactor: numero(origem.pack_factor) ?? null,
    packUnit: texto(origem.pack_unit) ?? null,
    storageLocation: texto(origem.storage_location) ?? null,
    serialized: origem.serialized === 1,
    weighable: origem.weighable === 1,
    tareGrams: numero(origem.tare_grams) ?? null,
  });

  const cloneId = String(clone.id);

  // Lote e validade têm rota e dono próprios (BatchService): o clone de um
  // iogurte continua exigindo o lote na entrada, como o original.
  if (origem.tracks_batches === 1) {
    setBatchControl({ companyId, productId: cloneId, tracksBatches: true });
  }

  // Peças do kit.
  const pecas = listKitComponents(companyId, productId);
  if (pecas.length > 0) {
    setKitComponents(
      companyId,
      cloneId,
      pecas.map((p) => ({ componentId: p.component_id, quantity: p.quantity })),
    );
  }

  // Preços em tabela.
  const db = getConnection();
  const precos = db
    .prepare(
      'SELECT price_table_id, price_cents FROM core_price_table_items WHERE company_id = ? AND product_id = ?',
    )
    .all(companyId, productId) as unknown as { price_table_id: string; price_cents: number }[];

  if (precos.length > 0) {
    const agora = new Date().toISOString();
    withTransaction(() => {
      for (const p of precos) {
        db.prepare(
          `INSERT INTO core_price_table_items
             (id, company_id, price_table_id, product_id, price_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (price_table_id, product_id) DO NOTHING`,
        ).run(
          randomUUID(),
          companyId,
          p.price_table_id,
          cloneId,
          p.price_cents,
          agora,
          agora,
        );
      }
    });
  }

  /**
   * Fotos: o ARQUIVO é duplicado, não só a linha.
   *
   * Passar pelo `addProductImage` reaproveita a validação de formato, o limite
   * de tamanho e a geração do nome no disco — e garante que cada produto seja
   * dono do próprio arquivo. Foto que não puder ser lida é PULADA: o clone não
   * deve falhar porque um arquivo antigo sumiu do disco.
   */
  const comoDataUrl = (url: string): string => {
    const nomeNoDisco = url.split('/').pop() ?? '';
    const bytes = readFileSync(join(uploadsDir(), nomeNoDisco));
    const extensao = nomeNoDisco.split('.').pop()?.toLowerCase() ?? 'jpg';
    const mime =
      extensao === 'png' ? 'image/png' : extensao === 'webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  };
  for (const foto of listProductImages(companyId, productId)) {
    try {
      /*
        A MINIATURA DO BALCÃO VAI JUNTO, também como arquivo próprio. Sem ela o
        clone nasceria com foto e sem miniatura — e o PDV mostraria o espaço
        neutro para um produto que tem foto. Miniatura que não puder ser lida
        não impede a foto: o clone fica na fila do preenchimento.
      */
      let thumbDataUrl: string | null = null;
      if (foto.thumb_url) {
        try {
          thumbDataUrl = comoDataUrl(foto.thumb_url);
        } catch {
          thumbDataUrl = null;
        }
      }
      addProductImage({
        companyId,
        productId: cloneId,
        dataUrl: comoDataUrl(foto.url),
        fileName: foto.file_name,
        thumbDataUrl,
      });
    } catch {
      // Arquivo ausente ou ilegível não derruba o clone.
    }
  }

  return getProduct(companyId, cloneId) as unknown as Record<string, unknown>;
}
