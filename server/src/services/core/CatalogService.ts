/**
 * Catálogo: produtos, clientes e fornecedores.
 *
 * Todas as consultas são obrigatoriamente filtradas por `companyId`, que vem
 * da sessão — nunca do corpo da requisição. É o que mantém o catálogo da
 * Gringa invisível para o Preço Justo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { effectivePriceCents } from './PricingService.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { countInStock, createUnits } from './ProductUnitService.js';
import { getBalance } from './InventoryService.js';
import { exigirTipoCoerente, normalizarKind } from './ProductKindService.js';
import {
  ensureDefaultUnits,
  findProductByAnyBarcode,
  lerConfigDaEtiquetaDaBalanca,
  lerEtiquetaDaBalanca,
} from './CatalogAuxService.js';
import { exigirCodigoDeBarrasValido } from './Gtin.js';
// O verificador do CNPJ mora na configuração fiscal e é reusado aqui de
// propósito: duas contas de módulo 11 divergiriam na primeira correção.
import { isValidCnpj } from './FiscalConfigService.js';
import { limitarDeslocamento, limitarPagina } from './paginacao.js';
import { modeloAtivo } from './produtoVendavel.js';

// ------------------------------------------------------------------ produtos

export interface ProductInput {
  name: string;
  internalCode?: string;
  sku?: string;
  barcode?: string;
  description?: string;
  category?: string;
  brand?: string;
  unit?: string;
  costCents?: number;
  priceCents?: number;
  minStock?: number;
  supplierId?: string;
  ncm?: string;
  cest?: string;
  cfop?: string;
  origin?: string;
  taxProfile?: string;
  imageUrl?: string;
  active?: boolean;
  /** Publica na loja online. Sem isto o produto é só interno. */
  publishOnline?: boolean;
  /** 'retail' (varejo) ou 'part' (peça de oficina). */
  kind?: string;
  /** Oficina dona da peça — separa o estoque de celulares do de mobilidade. */
  workshopId?: string | null;
  subcategory?: string | null;
  /** Texto que o cliente lê na vitrine, separado da descrição interna. */
  onlineDescription?: string | null;
  /** Código do fabricante — pelo qual se PEDE a peça ao fornecedor. */
  reference?: string | null;
  /**
   * Onde a peça MORA: "Prateleira A3 - Caixa 2". Endereço de cadastro, não
   * dimensão do razão — a pergunta é "onde eu vou pegar", feita por quem está
   * com a moto aberta.
   */
  storageLocation?: string | null;
  /**
   * Piso de preço. Markup e margem NÃO entram aqui: derivam de custo e preço,
   * e uma cópia gravada divergiria no primeiro reajuste. O mínimo é política.
   */
  minPriceCents?: number;
  minMarkupPercent?: number | null;
  minMarginPercent?: number | null;
  /** Preço digitado na venda, não no cadastro. */
  openPrice?: boolean;
  /**
   * Kit: a venda registra as PEÇAS em vez do kit.
   *
   * Desmembrar é o padrão porque é o que dá baixa correta em cada componente.
   * Não desmembrar só faz sentido quando o kit tem estoque próprio, montado.
   *
   * `isKit` não entra aqui de propósito: quem decide se um produto é kit é ter
   * ou não ter composição, e isso é `setKitComponents`. Um campo solto criaria
   * a possibilidade de um kit sem peças e de um produto com peças que não é kit.
   */
  kitExplodeOnSale?: boolean;
  /** O custo do kit passa a ser a soma das peças, em vez do custo digitado. */
  kitCostFromComponents?: boolean;
  /** Vendido por peso — entra no arquivo da balança. */
  weighable?: boolean;
  /** O número pelo qual a balança acha o produto. Texto: zero à esquerda conta. */
  pluCode?: string | null;
  /** Tara da embalagem em gramas, descontada pela balança. */
  tareGrams?: number | null;
  /** Cada unidade tem identidade própria: chassi, IMEI, número de série. */
  serialized?: boolean;
  /**
   * O produto SAI DA PRATELEIRA? (GAP-V02)
   *
   * `false` é o serviço de balcão — ajuste de bainha, instalação, película. A
   * venda dele não baixa estoque, não é recusada por saldo, e ele não aparece
   * na posição nem entra em contagem de inventário. Ausente = `true`, que é o
   * que todo produto já cadastrado significa.
   */
  stockControl?: boolean;
  /**
   * EMBALAGEM DE COMPRA (GAP-V06): quantas unidades vêm na caixa.
   *
   * É PADRÃO SUGERIDO na conferência da nota, e não regra: quem manda na
   * conversão continua sendo o fator da LINHA da nota, porque o fornecedor
   * pode mudar a caixa sem avisar. Nulo = ninguém declarou embalagem.
   */
  packFactor?: number | null;
  /** Como a embalagem se chama na nota do fornecedor ("CX", "FD"). */
  packUnit?: string | null;
  /**
   * Dados de envio, em UNIDADE OFICIAL: peso em GRAMAS, dimensões em
   * CENTÍMETROS. Uma convenção só, porque tela em quilo e adapter em grama é
   * um frete mil vezes errado sem nenhum erro visível.
   */
  weightGrams?: number | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  /**
   * CÓDIGOS ADICIONAIS QUE NASCEM JUNTO COM O PRODUTO (A-produto-01).
   *
   * Antes a tela criava o produto e só DEPOIS subia, um a um, os códigos que a
   * pessoa tinha digitado. Um código recusado (409, já pertence a outro
   * produto) deixava o produto criado e a tela ainda em "Novo": o Salvar
   * seguinte criava o mesmo item de novo. Agora os códigos vão no MESMO POST e
   * são conferidos na MESMA transação do INSERT: ou nasce tudo, ou nada.
   */
  extraBarcodes?: string[];
  /**
   * O QUE A TELA LEU, campo a campo, antes de a pessoa editar (A-produto-07).
   *
   * Só os campos que a pessoa MUDOU vêm aqui, com o valor que ela viu ao abrir
   * a ficha. Se outra pessoa gravou outro valor nesse mesmo campo enquanto
   * isso, o PUT é recusado com 409 em vez de apagar em silêncio a decisão
   * alheia. Campo que a pessoa não tocou nem viaja — e por isso nunca reverte
   * o que o outro gravou.
   */
  expected?: Record<string, unknown>;
}

/**
 * REGRAS QUE SÓ VALEM PARA QUEM CADASTRA PELA TELA OU PELA API.
 *
 * A importação de XML traz a unidade do FORNECEDOR (PCT, FR, KIT…), que a
 * conferência da nota converte depois; exigir que ela já exista no vocabulário
 * da loja travaria a entrada da mercadoria. Quem digita o cadastro, ao
 * contrário, escolhe da lista — e é aí que a unidade livre ("Un", "UND",
 * "CX12") virava decoração (A-produto-26).
 */
export interface RegrasDoCadastro {
  unidadeDoVocabulario?: boolean;
}

/**
 * Texto do cadastro: aparado, e vazio (ou nulo) vira NULO.
 *
 * O `?? ''` implícito em `String(valor)` é o motivo desta função existir:
 * `String(null)` é a palavra "null", que é truthy e seria gravada na coluna.
 */
function textoOuNulo(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
}

/**
 * Na EDIÇÃO: ausente preserva; presente (inclusive vazio) substitui.
 *
 * O DEFEITO (A-produto-03): o mapa do UPDATE usava `input.x ?? current.x`
 * para categoria, marca, NCM, CEST, descrição, EAN… A tela mandava o campo
 * esvaziado como `undefined` e o servidor, de qualquer forma, trataria `''`
 * como "grave vazio" e `null` como "preserve". Tirar o perfume da categoria
 * "Liquidação" (que tem promoção) dizia "Produto atualizado." e o valor antigo
 * voltava — e o PDV continuava dando o desconto.
 */
function textoEditado(valor: unknown, atual: unknown): unknown {
  return valor === undefined ? atual : textoOuNulo(valor);
}

/** Tira só os separadores que se digitam num código fiscal: ponto, traço, barra, espaço. */
function semSeparadores(texto: string): string {
  return texto.replace(/[\s./-]/g, '');
}

/**
 * A CLASSIFICAÇÃO FISCAL É CONFERIDA NO CADASTRO, e não só na tela fiscal
 * (A-produto-04).
 *
 * `updateProductFiscal` já recusava NCM de 6 dígitos; o POST/PUT do produto
 * gravava qualquer coisa. "3303.00" passava, e a primeira NFC-e desse item era
 * recusada na hora da venda, com o cliente no balcão. Aqui se grava SÓ DÍGITOS
 * — o ponto é formatação, e a emissão compara dígitos.
 *
 * Devolve `undefined` para ausente (a edição preserva), `null` para vazio (a
 * edição limpa) e o código validado no resto.
 */
function codigoFiscal(
  valor: unknown,
  campo: 'ncm' | 'cest' | 'cfop' | 'origin',
): string | null | undefined {
  if (valor === undefined) return undefined;
  const texto = textoOuNulo(valor);
  if (texto === null) return null;
  const digitos = semSeparadores(texto);
  if (campo === 'ncm') {
    // "00" é o NCM do item que não é mercadoria (serviço), e o XML do
    // fornecedor o traz assim; o resto tem 8 dígitos.
    if (!/^\d{8}$/.test(digitos) && digitos !== '00') {
      throw new ApiError(
        'CORE_FISCAL_NCM_INVALID',
        `O NCM "${texto}" não é válido: ele tem 8 dígitos (ex.: 3303.00.10). Confira na nota do fornecedor ou com o contador.`,
        400,
      );
    }
    return digitos;
  }
  if (campo === 'cest') {
    if (!/^\d{7}$/.test(digitos)) {
      throw new ApiError(
        'CORE_FISCAL_CEST_INVALID',
        `O CEST "${texto}" não é válido: ele tem 7 dígitos (ex.: 28.001.00). Se o produto não tem substituição tributária, deixe o campo em branco.`,
        400,
      );
    }
    return digitos;
  }
  if (campo === 'cfop') {
    // O CFOP do CADASTRO é o de SAÍDA — o com que a loja vende: 5 (dentro do
    // estado), 6 (fora) ou 7 (exterior). Um 1102 aqui é o CFOP da compra, e
    // iria direto para o cupom.
    if (!/^[567]\d{3}$/.test(digitos)) {
      throw new ApiError(
        'CORE_FISCAL_CFOP_INVALID',
        `O CFOP "${texto}" não é válido para a venda: ele tem 4 dígitos e começa com 5, 6 ou 7 (ex.: 5102). O CFOP da nota do fornecedor é o da compra, não o da venda.`,
        400,
      );
    }
    return digitos;
  }
  if (!/^[0-8]$/.test(digitos)) {
    throw new ApiError(
      'CORE_FISCAL_ORIGIN_INVALID',
      `A origem "${texto}" não é válida: é um dígito de 0 a 8 (0 = nacional, 1 = importação direta, 2 = importada no mercado interno…).`,
      400,
    );
  }
  return digitos;
}

/**
 * Na edição, o código fiscal só é CONFERIDO quando muda.
 *
 * Um cadastro antigo com CEST "2800" não pode travar a correção do preço: a
 * regra vale para o que se grava agora, e reenviar o mesmo valor de sempre
 * não é gravar nada.
 */
function codigoFiscalEditado(
  valor: unknown,
  atual: unknown,
  campo: 'ncm' | 'cest' | 'cfop' | 'origin',
): unknown {
  if (valor === undefined) return atual;
  const pedido = textoOuNulo(valor);
  const gravado = textoOuNulo(atual);
  if (pedido !== null && gravado !== null && semSeparadores(pedido) === semSeparadores(gravado)) {
    return atual;
  }
  return codigoFiscal(valor, campo);
}

/**
 * O GRUPO TRIBUTÁRIO ESCOLHIDO PRECISA EXISTIR E ESTAR ATIVO (A-produto-09).
 *
 * A emissão só aceita grupo ativo (`acharGrupo`, em TributacaoDoItem) e recusa
 * com "não existe ou está inativo" — na hora da venda. O cadastro aceitava
 * qualquer código, e a tela até oferecia o inativo no seletor: "Produto
 * atualizado." e toda venda daquele item travava a NFC-e.
 */
function exigirGrupoTributarioAtivo(companyId: string, codigo: string | null): void {
  if (!codigo) return;
  const grupo = getConnection()
    .prepare(
      'SELECT code, active FROM core_tax_groups WHERE company_id = ? AND upper(trim(code)) = ?',
    )
    .get(companyId, codigo.toUpperCase()) as { code: string; active: number } | undefined;
  if (!grupo) {
    throw new ApiError(
      'CORE_TAX_GROUP_NOT_FOUND',
      `O grupo tributário "${codigo}" não existe nesta operação. Escolha um grupo cadastrado em Catálogo › Auxiliares › Grupos tributários, ou deixe em branco para usar o padrão da operação.`,
      400,
    );
  }
  if (grupo.active !== 1) {
    throw new ApiError(
      'CORE_TAX_GROUP_INACTIVE',
      `O grupo tributário "${grupo.code}" está inativo: a nota fiscal recusaria toda venda deste produto. Escolha um grupo ativo, ou reative este em Catálogo › Auxiliares › Grupos tributários.`,
      400,
    );
  }
}

/**
 * O FORNECEDOR É UM CADASTRO, não um texto (A-produto-10).
 *
 * O campo era livre ("Código ou nome do fornecedor") e a criação gravava o
 * NOME em `supplier_id`: a sugestão de compra e a reprecificação por
 * fornecedor procuram um id e não achavam vínculo nenhum.
 */
function exigirFornecedorDaEmpresa(companyId: string, supplierId: string | null): void {
  if (!supplierId) return;
  const achado = getConnection()
    .prepare('SELECT id FROM core_suppliers WHERE id = ? AND company_id = ?')
    .get(supplierId, companyId) as { id: string } | undefined;
  if (!achado) {
    throw new ApiError(
      'CORE_SUPPLIER_NOT_FOUND',
      'O fornecedor informado não existe nesta operação. Escolha um fornecedor da lista (Cadastros › Fornecedores) ou deixe o campo em branco.',
      400,
    );
  }
}

/**
 * A UNIDADE VEM DO VOCABULÁRIO DA LOJA (A-produto-26).
 *
 * Só para quem cadastra pela tela ou pela API — ver `RegrasDoCadastro`.
 * Unidade inativa também é recusada: desativar é justamente dizer "não use
 * mais esta".
 */
function exigirUnidadeDoVocabulario(companyId: string, unidade: string): void {
  ensureDefaultUnits(companyId);
  const achada = getConnection()
    .prepare('SELECT code, active FROM core_units WHERE company_id = ? AND code = ?')
    .get(companyId, unidade) as { code: string; active: number } | undefined;
  if (!achada || achada.active !== 1) {
    throw new ApiError(
      'CORE_UNIT_NOT_FOUND',
      `A unidade "${unidade}" não está ${achada ? 'ativa' : 'cadastrada'} nesta operação. Escolha uma unidade da lista, ou cadastre-a em Catálogo › Auxiliares › Unidades.`,
      400,
    );
  }
}

/**
 * O ESTOQUE MÍNIMO É UM NÚMERO, maior ou igual a zero (A-produto-19).
 *
 * A tela mandava `Number('2,5') || 0` — o zero engolia a vírgula e o alerta de
 * estoque baixo nunca disparava. O servidor aceitava até negativo e NaN.
 */
function estoqueMinimo(valor: unknown): number | undefined {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return 0;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new ApiError(
      'CORE_MIN_STOCK_INVALID',
      'O estoque mínimo deve ser um número maior ou igual a zero (ex.: 2,5 para produto vendido a granel).',
      400,
    );
  }
  return numero;
}

/**
 * O código interno como a loja o lê: sem espaços e em MAIÚSCULAS (A-produto-M04).
 *
 * O UNIQUE do banco é sensível a caixa: "pj-0105" e "PJ-0105" conviviam como
 * dois produtos com o "mesmo" código, e o PDV não tratava o digitado em outra
 * caixa como exato.
 *
 * Exportada porque a conferência da planilha (`ProductImportService`) precisa
 * ler o código da linha EXATAMENTE como o cadastro vai gravá-lo (PED-prod-01):
 * uma cópia desta regra lá seria a primeira a divergir.
 */
export function codigoInternoNormalizado(valor: unknown): string | null {
  const texto = textoOuNulo(valor);
  return texto === null ? null : texto.replace(/\s+/g, '').toUpperCase();
}

/**
 * O MESMO CÓDIGO NÃO PODE RESPONDER POR DOIS PRODUTOS NO BIPE (A-produto-24).
 *
 * A busca do PDV casa `barcode = ? OR internal_code = ? OR sku = ?` (e os
 * códigos adicionais). O código interno era conferido só contra os outros
 * códigos internos, e o EAN só contra os EANs: "7891000100103" digitado como
 * código interno de A, sendo o EAN de B, fazia o bipe achar os dois — e a
 * lista abria em vez de o item entrar no carrinho.
 *
 * Devolve o nome de quem já usa o código (em qualquer um dos papéis), ou nulo.
 */
export function donoDoCodigoNoBipe(
  companyId: string,
  codigo: string,
  ignorarProductId: string | null,
): string | null {
  const db = getConnection();
  const direto = db
    .prepare(
      `SELECT name FROM core_products
        WHERE company_id = ? AND id IS NOT ?
          AND (barcode = ? OR upper(internal_code) = upper(?) OR upper(sku) = upper(?))
        LIMIT 1`,
    )
    .get(companyId, ignorarProductId, codigo, codigo, codigo) as { name: string } | undefined;
  if (direto) return direto.name;
  const adicional = db
    .prepare(
      `SELECT p.name FROM core_product_barcodes b
         JOIN core_products p ON p.id = b.product_id
        WHERE b.company_id = ? AND b.barcode = ? AND b.product_id IS NOT ?
        LIMIT 1`,
    )
    .get(companyId, codigo, ignorarProductId) as { name: string } | undefined;
  return adicional?.name ?? null;
}

export function exigirCodigoLivreNoBipe(
  companyId: string,
  codigo: string | null,
  ignorarProductId: string | null,
  papel: 'o código interno' | 'o SKU' | 'o código de barras',
): void {
  if (!codigo) return;
  const dono = donoDoCodigoNoBipe(companyId, codigo, ignorarProductId);
  if (dono) {
    throw new ApiError(
      papel === 'o SKU' ? 'CORE_SKU_DUPLICATE' : 'CORE_CODE_CLASHES_BARCODE',
      `"${codigo}" já identifica "${dono}" (como código de barras, código interno ou SKU). Se ${papel} deste produto for igual, o bipe no balcão acha os dois e o item não entra direto no carrinho. Use outro código.`,
      409,
    );
  }
}

/**
 * O produto que JÁ responde por este código interno, em qualquer caixa
 * (A-produto-M04). Recebe o código já normalizado (`codigoInternoNormalizado`).
 *
 * Uma consulta só para as duas portas que perguntam isto (PED-prod-01): o
 * cadastro, para recusar o repetido, e a conferência da planilha, para casar a
 * linha "pj-0105" com o "PJ-0105" que já existe. A planilha perguntava com
 * `internal_code = ?` — sensível a caixa —, dizia "novo", e o cadastro, que
 * pergunta com `upper()`, estourava no meio da confirmação.
 */
export function produtoDoCodigoInterno(companyId: string, codigoNormalizado: string): string | null {
  const achado = getConnection()
    .prepare('SELECT id FROM core_products WHERE company_id = ? AND upper(internal_code) = ?')
    .get(companyId, codigoNormalizado) as { id: string } | undefined;
  return achado?.id ?? null;
}

/**
 * AS DUAS RECUSAS DO CÓDIGO INTERNO DE UM PRODUTO NOVO, numa função só
 * (PED-prod-01): repetido em outra caixa (`CORE_DUPLICATE_CODE`) e igual ao
 * EAN, a um adicional ou ao SKU de outro produto (`CORE_CODE_CLASHES_BARCODE`).
 *
 * `createProduct` chama esta função, e a conferência da planilha chama A MESMA
 * para marcar o erro na LINHA — antes, a conferência conferia do jeito antigo,
 * a linha passava verde e a confirmação inteira caía no meio, com as outras
 * cento e noventa linhas boas desfeitas junto.
 */
export function exigirCodigoInternoLivre(companyId: string, codigoNormalizado: string): void {
  if (produtoDoCodigoInterno(companyId, codigoNormalizado)) {
    throw new ApiError(
      'CORE_DUPLICATE_CODE',
      `Código interno já usado: ${codigoNormalizado}. Maiúsculas e minúsculas contam como o mesmo código no balcão; escolha outro.`,
      409,
    );
  }
  exigirCodigoLivreNoBipe(companyId, codigoNormalizado, null, 'o código interno');
}

/**
 * Valida uma medida de envio.
 *
 * Vazio é legítimo — produto de retirada não precisa de dimensão. O que não
 * pode é entrar zero, negativo ou texto: a cotação usaria o número e sairia um
 * preço que o transportador não cobra.
 */
function medidaDeEnvio(valor: unknown, campo: string): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new ApiError(
      'CORE_INVALID_SHIPPING_DATA',
      `${campo} deve ser um número maior que zero (peso em gramas, medidas em centímetros).`,
      400,
    );
  }
  return numero;
}

/**
 * O FATOR DA EMBALAGEM, conferido antes de virar padrão (GAP-V06).
 *
 * Vazio é legítimo — a esmagadora maioria dos produtos não vem em caixa
 * declarada. O que não pode entrar é zero, negativo ou fracionado: o fator
 * MULTIPLICA a quantidade da entrada, e um valor errado gravado no cadastro
 * seria sugerido em toda conferência seguinte, multiplicando estoque e custo em
 * silêncio — que é exatamente o defeito que este campo existe para fechar.
 *
 * Inteiro porque caixa tem um número inteiro de unidades. "Caixa com 12,5" não
 * é embalagem: é erro de digitação, e é aqui que ele para.
 */
function fatorDeEmbalagem(valor: unknown): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 1) {
    throw new ApiError(
      'CORE_INVALID_PACK_FACTOR',
      'A embalagem deve conter um número inteiro de unidades, maior que 1 '
        + '(caixa com 1 unidade é a própria unidade).',
      400,
    );
  }
  return numero;
}

/** As quatro medidas, normalizadas e validadas juntas. */
export function normalizeShippingData(input: ProductInput): {
  weightGrams: number | null;
  heightCm: number | null;
  widthCm: number | null;
  lengthCm: number | null;
} {
  return {
    weightGrams: medidaDeEnvio(input.weightGrams, 'Peso'),
    heightCm: medidaDeEnvio(input.heightCm, 'Altura'),
    widthCm: medidaDeEnvio(input.widthCm, 'Largura'),
    lengthCm: medidaDeEnvio(input.lengthCm, 'Comprimento'),
  };
}

/**
 * Dinheiro do cadastro: preço, custo e piso NÃO podem ser negativos.
 *
 * A reprecificação em massa (`applyPrices`) já recusava com este mesmo par
 * código/mensagem; o cadastro unitário — que é por onde a tela salva — deixava
 * passar, na criação e na edição. Um -500 gravado aqui viraria desconto
 * infinito no primeiro carrinho que o `PricingService` somasse. Mesmo código,
 * mesma frase: um fato, uma recusa.
 *
 * Ausente e nulo passam de propósito: significam "não mexa" (edição) ou "zero"
 * (criação) — e zero é legítimo, a peça importada de XML nasce a R$ 0,00 para
 * não inventar margem.
 */
function exigirCentavosNaoNegativos(...valores: unknown[]): void {
  for (const valor of valores) {
    if (valor === undefined || valor === null) continue;
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) {
      throw new ApiError('CORE_PRICE_INVALID', 'Preço inválido.', 400);
    }
    /*
      CENTAVO FRACIONADO NÃO É DINHEIRO (A-produto-19).

      1990.5 passava por `Number.isFinite` e era gravado como REAL numa coluna de
      centavos: o cupom arredonda de um jeito, o relatório soma de outro, e a
      diferença de meio centavo por item vira divergência de caixa no fim do mês.
    */
    if (!Number.isInteger(numero)) {
      throw new ApiError(
        'CORE_PRICE_INVALID',
        'Preço inválido: o valor vai em centavos inteiros (R$ 19,90 é 1990).',
        400,
      );
    }
  }
}

/**
 * Código interno da loja, gerado por sequência própria de cada empresa.
 * Formato legível e estável: PJ-000123.
 */
/**
 * SERVIÇO DE BALCÃO É EXCLUDENTE COM PESO E COM UNIDADE SERIALIZADA (GAP-V02).
 *
 * Os dois descrevem COMO a mercadoria sai da prateleira — a balança pesa o que
 * está lá, a unidade serializada identifica QUAL peça saiu. Um serviço não tem
 * nem uma coisa nem outra, e marcar as duas juntas produziria um estado que
 * nenhuma tela sabe desenhar e que a venda trataria de forma contraditória:
 * `applyMovement` exigiria a unidade escolhida de uma linha que nem chega a
 * movimentar estoque.
 *
 * A frase é do mesmo molde de `CORE_SERIALIZED_AND_WEIGHABLE`, que já existe
 * logo abaixo: um fato, uma recusa, e o estado FINAL é o que conta.
 */
function exigirServicoCoerente(estado: {
  stockControl?: boolean;
  weighable?: boolean;
  serialized?: boolean;
}): void {
  if (estado.stockControl !== false) return;
  if (estado.weighable) {
    throw new ApiError(
      'CORE_SERVICE_AND_WEIGHABLE',
      'Um serviço não é vendido por peso: não há o que pôr na balança.',
      400,
    );
  }
  if (estado.serialized) {
    throw new ApiError(
      'CORE_SERVICE_AND_SERIALIZED',
      'Um serviço não tem unidades com identidade própria: não há chassi nem IMEI a escolher.',
      400,
    );
  }
}

export function generateInternalCode(companyId: string, prefix: string): string {
  const next = nextSequenceValue(companyId, 'product_code');
  return `${prefix.toUpperCase()}-${String(next).padStart(6, '0')}`;
}

/**
 * O próximo código interno LIVRE, reservado — o botão "Gerar código" do
 * cadastro, e o código de quem deixa o campo em branco. Reserva (e não só
 * espia) para dois cadastros abertos ao mesmo tempo não receberem o mesmo
 * número; e PULA o número que alguém já digitou à mão igual ao da sequência —
 * antes, esse caso virava 409 no cadastro seguinte, sem ninguém entender.
 */
export function reservarCodigoInterno(
  companyId: string,
  prefix = 'GS',
  /**
   * Códigos que ainda NÃO estão no banco mas já têm dono — as linhas da
   * planilha que vão nascer no mesmo lote (PED-prod-01). Sem isto, a linha
   * sem código ganhava o "GS-000007" que a linha seguinte trazia escrito, e o
   * lote caía no meio da confirmação.
   */
  evitar?: ReadonlySet<string>,
): string {
  ensureCoreSchema();
  for (let tentativa = 0; tentativa < 50; tentativa += 1) {
    const code = generateInternalCode(companyId, prefix);
    // "Ocupado" é qualquer papel no bipe — código interno (em qualquer caixa),
    // EAN, adicional ou SKU de outro produto (A-produto-24): um código gerado
    // igual ao SKU digitado de outro item faria o balcão achar os dois.
    if (evitar?.has(code)) continue;
    if (!donoDoCodigoNoBipe(companyId, code, null)) return code;
  }
  throw new ApiError('CORE_CODE_EXHAUSTED', 'Não foi possível reservar um código interno livre.', 409);
}

export function createProduct(
  companyId: string,
  input: ProductInput,
  companyPrefix = 'GS',
  regras: RegrasDoCadastro = {},
): Record<string, unknown> {
  ensureCoreSchema();
  if (!input.name?.trim()) {
    throw new ApiError('CORE_INVALID_PAYLOAD', 'Nome do produto é obrigatório.', 400);
  }
  // Valida ANTES de abrir a transação: erro de digitação no peso não deve
  // chegar a gravar metade do produto.
  const envio = normalizeShippingData(input);
  // O dinheiro passa pela mesma alfândega das medidas: sinal trocado não abre
  // transação nenhuma.
  exigirCentavosNaoNegativos(input.priceCents, input.costCents, input.minPriceCents);
  const embalagem = fatorDeEmbalagem(input.packFactor);
  const minimoDeEstoque = estoqueMinimo(input.minStock) ?? 0;
  // A classificação fiscal é conferida antes de abrir a transação, como as
  // medidas: NCM de 6 dígitos não chega a gravar metade do produto.
  const fiscal = {
    ncm: codigoFiscal(input.ncm, 'ncm') ?? null,
    cest: codigoFiscal(input.cest, 'cest') ?? null,
    cfop: codigoFiscal(input.cfop, 'cfop') ?? null,
    origin: codigoFiscal(input.origin, 'origin') ?? null,
  };
  const grupoTributario = textoOuNulo(input.taxProfile)?.toUpperCase() ?? null;
  const fornecedor = textoOuNulo(input.supplierId);
  const unidade = textoOuNulo(input.unit)?.toUpperCase() ?? 'UN';
  if (regras.unidadeDoVocabulario) exigirUnidadeDoVocabulario(companyId, unidade);
  /*
    O CÓDIGO DE BARRAS É NORMALIZADO UMA VEZ SÓ (A-produto-04).

    A validação usava o texto aparado, a checagem de duplicidade usava o texto
    cru e o INSERT gravava o cru: " 7891000100103" colado com espaço escapava
    da duplicidade e ficava gravado com o espaço — e o bipe, que compara
    `barcode = ?`, nunca mais casava. E `barcode: ''` vindo de uma integração
    pulava o `if` e gravava '', que colide no índice único parcial no segundo
    produto: 500 "Erro interno.". Agora: aparado, e vazio vira NULO.
  */
  const codigoDeBarras = textoOuNulo(input.barcode);
  const sku = textoOuNulo(input.sku);
  /*
    SERVIÇO NÃO É PESÁVEL, NEM SERIALIZADO, NEM KIT — e a recusa vem antes de
    gravar. Os três descrevem COMO a mercadoria sai da prateleira, e quem não
    tem prateleira não tem como. Um produto marcado como serviço e pesável
    travaria a venda de um jeito difícil de diagnosticar: a balança manda
    quantidade fracionada para uma linha que não baixa saldo nenhum.
  */
  exigirServicoCoerente({
    stockControl: input.stockControl,
    weighable: input.weighable,
    serialized: input.serialized,
  });

  /*
    O TIPO PASSA PELO MESMO INVARIANTE QUE A CONVERSÃO.

    Este é o caminho do CLONE: `cloneProduct` repassa `kind` e `workshopId` do
    original e chega aqui. Sem esta chamada, clonar seria o contorno de todas as
    recusas — um clique para ter a peça pesável, a peça sem oficina ou a peça na
    bancada de outra empresa que a rota de conversão recusaria.

    Produto novo não é kit (quem faz um kit é `setKitComponents`, depois) e não
    pode ser componente de nada, então não há `productId` a conferir.
  */
  const tipo = exigirTipoCoerente({
    companyId,
    kind: input.kind,
    workshopId: input.workshopId,
    weighable: input.weighable,
    pluCode: input.pluCode,
  });
  exigirQueNaoPubliquePeca(tipo.kind, input.publishOnline === true, true);

  return withTransaction(() => {
    const db = getConnection();
    exigirGrupoTributarioAtivo(companyId, grupoTributario);
    exigirFornecedorDaEmpresa(companyId, fornecedor);
    const code = codigoInternoNormalizado(input.internalCode)
      || reservarCodigoInterno(companyId, companyPrefix);

    // Em qualquer caixa: "pj-0105" e "PJ-0105" são o mesmo código para quem
    // digita no balcão (A-produto-M04). A mesma função que a conferência da
    // planilha usa (PED-prod-01): uma regra, duas portas.
    exigirCodigoInternoLivre(companyId, code);
    exigirCodigoLivreNoBipe(companyId, sku, null, 'o SKU');
    /*
      O CÓDIGO DE BARRAS MORA EM DOIS LUGARES, E ESTA CHECAGEM OLHAVA UM SÓ.

      Um produto tem o código principal em `core_products.barcode` e quantos
      quiser em `core_product_barcodes` — a caixa da embalagem, o do fabricante
      e o da caixa fechada apontam todos para a mesma peça.

      A consulta antiga via só a primeira tabela, e o índice único também cobre
      só ela. Então um código que já vivia em `core_product_barcodes` NÃO
      colidia com nada: passava pela checagem, passava pelo índice, e o produto
      nascia. O resultado é o pior tipo de defeito que este cadastro pode ter —
      dois produtos respondendo ao MESMO bipe, sem erro nenhum, sem aviso
      nenhum. No PDV a leitora encontra um dos dois; qual, depende da consulta.
      A venda sai do produto errado e o saldo do certo nunca baixa.

      `findProductByAnyBarcode` já existia em `CatalogAuxService` fazendo
      exatamente esta pergunta nas duas tabelas — e não tinha nenhum chamador.
      Este é o primeiro.

      O código de erro é o mesmo de `addProductBarcode`, que já checava as duas:
      um fato, uma mensagem. Antes eram dois códigos diferentes para a mesma
      recusa, o que é o começo de as duas divergirem.
    */
    if (codigoDeBarras) {
      // GTIN com o verificador errado nunca é lido pelo scanner: recusa antes de gravar.
      exigirCodigoDeBarrasValido(codigoDeBarras);
      if (findProductByAnyBarcode(companyId, codigoDeBarras)) {
        throw new ApiError(
          'CORE_BARCODE_DUPLICATE',
          'Este código de barras já pertence a outro produto.',
          409,
        );
      }
      exigirCodigoLivreNoBipe(companyId, codigoDeBarras, null, 'o código de barras');
    }
    /*
      OS ADICIONAIS PASSAM PELA MESMA ALFÂNDEGA DO PRINCIPAL, DENTRO DA MESMA
      TRANSAÇÃO (A-produto-01). Um código recusado desfaz o produto inteiro —
      é isso que impede o segundo Salvar de criar o item de novo.

      Repetido na própria lista, ou igual ao principal, não é erro: é o mesmo
      código digitado duas vezes, e entra uma vez só.
    */
    const adicionais: string[] = [];
    for (const bruto of Array.isArray(input.extraBarcodes) ? input.extraBarcodes : []) {
      const codigo = textoOuNulo(bruto);
      if (!codigo || codigo === codigoDeBarras || adicionais.includes(codigo)) continue;
      exigirCodigoDeBarrasValido(codigo);
      if (findProductByAnyBarcode(companyId, codigo)) {
        throw new ApiError(
          'CORE_BARCODE_DUPLICATE',
          `O código adicional ${codigo} já pertence a outro produto. Tire-o da lista (ou confira os números) e salve de novo — nada foi gravado.`,
          409,
          { barcode: codigo },
        );
      }
      exigirCodigoLivreNoBipe(companyId, codigo, null, 'o código de barras');
      adicionais.push(codigo);
    }
    exigirPluLivre(companyId, input.pluCode, null);
    // Serializado e pesável são excludentes: o que se pesa não se conta uma a
    // uma, e um produto marcado como os dois travaria toda venda — a balança
    // manda quantidade fracionada e a unidade exige inteiro.
    if (input.serialized && input.weighable) {
      throw new ApiError(
        'CORE_SERIALIZED_AND_WEIGHABLE',
        'Um produto não pode ser vendido por peso e controlado por unidade ao mesmo tempo.',
        400,
      );
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, sku, barcode, name, description, category, brand,
          unit, cost_cents, price_cents, min_stock, supplier_id, ncm, cest, cfop, origin,
          tax_profile, image_url, active, publish_online, kind, workshop_id,
          subcategory, online_description, weight_grams, height_cm, width_cm, length_cm,
          reference, storage_location, min_price_cents, min_markup_percent,
          min_margin_percent, open_price,
          weighable, plu_code, tare_grams, serialized,
          stock_control, pack_factor, pack_unit,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      companyId,
      code,
      sku,
      codigoDeBarras,
      input.name.trim(),
      textoOuNulo(input.description),
      textoOuNulo(input.category),
      textoOuNulo(input.brand),
      unidade,
      input.costCents ?? 0,
      input.priceCents ?? 0,
      minimoDeEstoque,
      fornecedor,
      fiscal.ncm,
      fiscal.cest,
      fiscal.cfop,
      fiscal.origin,
      grupoTributario,
      input.imageUrl ?? null,
      input.active === false ? 0 : 1,
      input.publishOnline ? 1 : 0,
      // O par normalizado, não o que veio no corpo: peça de revenda não carrega
      // oficina, e peça sem oficina já foi recusada acima.
      tipo.kind,
      tipo.workshopId,
      textoOuNulo(input.subcategory),
      textoOuNulo(input.onlineDescription),
      envio.weightGrams,
      envio.heightCm,
      envio.widthCm,
      envio.lengthCm,
      textoOuNulo(input.reference),
      String(input.storageLocation ?? '').trim() || null,
      input.minPriceCents ?? 0,
      input.minMarkupPercent ?? null,
      input.minMarginPercent ?? null,
      input.openPrice ? 1 : 0,
      input.weighable ? 1 : 0,
      String(input.pluCode ?? '').trim() || null,
      input.tareGrams ?? null,
      input.serialized ? 1 : 0,
      // Ausente = controla, que é o que todo produto significou até esta
      // rodada. Só o `false` explícito cria o serviço de balcão.
      input.stockControl === false ? 0 : 1,
      embalagem,
      String(input.packUnit ?? '').trim().toUpperCase() || null,
      now,
      now,
    );
    const inserirAdicional = db.prepare(
      `INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const codigo of adicionais) {
      inserirAdicional.run(randomUUID(), companyId, id, codigo, now);
    }
    const produto = getProduct(companyId, id)!;
    recordDomainEvent({
      eventType: 'product.upserted',
      aggregateType: 'product',
      aggregateId: id,
      companyId,
      operationalUnitId: tipo.workshopId,
      payload: produto,
    });
    return produto;
  });
}

/**
 * PEÇA NÃO VAI PARA A VITRINE.
 *
 * `publish_online = 1` e `kind = 'part'` são estados incompatíveis: a loja
 * online vende ao consumidor, e peça de bancada tem preço de reposição, não tem
 * foto e não é o que a loja vende.
 *
 * Os escritores de `publish_online` são DOIS, e os dois passam por aqui:
 * `createProduct` e `atualizarProduto` — e é por `atualizarProduto` que
 * `publishReadyProducts` (a publicação em massa) também fica coberta, porque
 * ela publica chamando `updateProduct`. O destaque da home
 * (`StorefrontSettingsService.setFeatured`) já exige produto publicado, então
 * peça nenhuma o alcança.
 *
 * RECUSA em vez de ignorar em silêncio: devolver 200 e não publicar seria
 * repetir exatamente o defeito que esta rodada conserta — a requisição que diz
 * "feito" e não faz. E DESPUBLICAR calado, aqui, seria a outra metade do mesmo
 * defeito: o item sumiria da vitrine sem ninguém ter pedido nem visto. Tirar da
 * loja é trabalho da conversão, que CONTA o que tirou.
 *
 * O caso NÃO EXPLÍCITO sobrou para uma coisa só, depois que a alteração parou de
 * converter: a linha suja: peça JÁ publicada, que nenhum caminho de hoje produz
 * (a conversão despublica no mesmo movimento) e que o banco antigo tem, porque
 * até esta rodada ninguém validava o par. Um PUT que nem menciona a vitrine
 * gravaria o `publish_online = 1` que já estava lá e daria a esse estado mais
 * uma vida. A frase, por isso, pede a decisão em vez de escolher por conta
 * própria: ou o item sai da vitrine, ou ele deixa de ser peça.
 */
function exigirQueNaoPubliquePeca(
  kind: string,
  publicacaoFinal: boolean,
  pedidoExplicito: boolean,
): void {
  if (kind !== 'part' || !publicacaoFinal) return;
  if (pedidoExplicito) {
    throw new ApiError(
      'CORE_PART_CANNOT_BE_PUBLISHED',
      'Peça de oficina não vai para a loja online. Converta o item em mercadoria de revenda antes de publicá-lo.',
      409,
    );
  }
  throw new ApiError(
    'CORE_PART_CANNOT_BE_PUBLISHED',
    'Este produto é peça de oficina e está publicado na loja online — dois estados que não podem conviver. Tire-o da vitrine (publicação desligada) ou converta-o em mercadoria de revenda antes de salvar o cadastro.',
    409,
  );
}

/**
 * MUDAR O TIPO NÃO É EDITAR UM CAMPO — e por isso não se faz por aqui.
 *
 * Trocar entre mercadoria de loja e peça de bancada tira o item da vitrine,
 * derruba o destaque da home e muda de dono o saldo em estoque. Quem faz isso
 * precisa VER a conta antes de confirmar, e a conta é `ResultadoDoTipo.efeitos`,
 * que só a rota de conversão devolve — junto com a auditoria que responde, seis
 * meses depois, "quem tirou este item da vitrine".
 *
 * RECUSA ALTO, e não em silêncio. Ignorar o campo devolvendo 200 é exatamente o
 * defeito que esta rodada conserta: a requisição que diz "feito" e não faz.
 *
 * MAS O MESMO VALOR NÃO É MUDANÇA, e este ponto é o que decide se a tela
 * continua utilizável: o formulário do produto manda o objeto INTEIRO toda vez
 * que salva, com `kind` e `workshopId` dentro. Recusar a simples presença do
 * campo travaria toda e qualquer edição de qualquer peça já existente — trocar o
 * preço de uma bateria devolveria 409. Só o valor DIFERENTE do que está gravado
 * é um pedido de conversão.
 *
 * A bancada só é comparada quando o produto JÁ É peça. Para mercadoria de
 * revenda o campo não significa nada — `exigirTipoCoerente` o normaliza para
 * nulo de qualquer maneira —, e um `workshopId` esquecido no estado da tela de
 * um produto de loja não é pedido de conversão nenhum.
 */
function exigirQueOTipoNaoMudeAqui(
  input: ProductInput,
  kindAtual: string,
  bancadaAtual: string | null,
): void {
  // Tipo inventado é erro de quem chamou, e é denunciado como tal ANTES da
  // comparação: mandá-lo para a rota de conversão seria mandar procurar lá o
  // valor que lá também não existe.
  const kindPedido = input.kind === undefined ? kindAtual : normalizarKind(input.kind);
  const bancadaPedida =
    input.workshopId === undefined ? bancadaAtual : String(input.workshopId ?? '').trim() || null;

  const mudouOTipo = kindPedido !== kindAtual;
  const mudouABancada = kindAtual === 'part' && bancadaPedida !== bancadaAtual;
  if (!mudouOTipo && !mudouABancada) return;

  throw new ApiError(
    'CORE_PRODUCT_KIND_BY_ROUTE',
    mudouOTipo
      ? `Mudar entre mercadoria de revenda e peça de oficina não se faz na edição do cadastro: é a ação própria de conversão, porque mexe em vitrine, estoque e bancada. O produto continua como "${kindAtual === 'part' ? 'peça de oficina' : 'mercadoria de revenda'}".`
      : 'Trocar a peça de bancada não se faz na edição do cadastro: é a ação própria de conversão, porque o saldo em estoque muda de gaveta. A bancada atual foi mantida.',
    409,
  );
}

/**
 * O PLU é único por empresa.
 *
 * Dois produtos com o mesmo PLU fariam a balança vender um pelo preço do
 * outro — e ninguém descobriria até o cliente reclamar no caixa.
 *
 * A checagem vive aqui, e não só no índice do banco, porque o índice nasce na
 * migração 42 e a DDL canônica (que é o que cria banco novo em teste) não pode
 * declará-lo: ela roda antes das migrações, quando a coluna ainda não existe.
 * Um invariante que só vale em produção não é invariante.
 */
function exigirPluLivre(
  companyId: string,
  plu: string | null | undefined,
  productId: string | null,
): void {
  const limpo = String(plu ?? '').trim();
  if (!limpo) return;
  const dono = getConnection()
    .prepare(
      `SELECT id, name FROM core_products
        WHERE company_id = ? AND plu_code = ? AND id IS NOT ?`,
    )
    .get(companyId, limpo, productId) as { id: string; name: string } | undefined;
  if (dono) {
    throw new ApiError(
      'CORE_PLU_DUPLICATE',
      `O PLU ${limpo} já é usado por "${dono.name}".`,
      409,
    );
  }
}

/**
 * Como cada campo do formulário é LIDO do banco, para comparar com o que a tela
 * viu ao abrir a ficha. As regras espelham `carregar()` da tela: o campo de
 * texto vazio e o nulo são o mesmo; "ligado por padrão" (ativo, controla
 * estoque, desmembra o kit) lê nulo como ligado; o piso zerado é "sem piso".
 */
type LeituraDoCampo =
  | 'texto'
  | 'maiusculo'
  | 'fiscal'
  | 'numeroOuZero'
  | 'numeroOuNulo'
  | 'booleano'
  | 'ligadoPorPadrao';

const CAMPOS_DO_FORMULARIO: Record<string, { coluna: string; leitura: LeituraDoCampo }> = {
  name: { coluna: 'name', leitura: 'texto' },
  description: { coluna: 'description', leitura: 'texto' },
  sku: { coluna: 'sku', leitura: 'texto' },
  barcode: { coluna: 'barcode', leitura: 'texto' },
  brand: { coluna: 'brand', leitura: 'texto' },
  category: { coluna: 'category', leitura: 'texto' },
  subcategory: { coluna: 'subcategory', leitura: 'texto' },
  onlineDescription: { coluna: 'online_description', leitura: 'texto' },
  reference: { coluna: 'reference', leitura: 'texto' },
  supplierId: { coluna: 'supplier_id', leitura: 'texto' },
  storageLocation: { coluna: 'storage_location', leitura: 'texto' },
  pluCode: { coluna: 'plu_code', leitura: 'texto' },
  unit: { coluna: 'unit', leitura: 'maiusculo' },
  taxProfile: { coluna: 'tax_profile', leitura: 'maiusculo' },
  packUnit: { coluna: 'pack_unit', leitura: 'maiusculo' },
  ncm: { coluna: 'ncm', leitura: 'fiscal' },
  cest: { coluna: 'cest', leitura: 'fiscal' },
  cfop: { coluna: 'cfop', leitura: 'fiscal' },
  origin: { coluna: 'origin', leitura: 'fiscal' },
  costCents: { coluna: 'cost_cents', leitura: 'numeroOuZero' },
  priceCents: { coluna: 'price_cents', leitura: 'numeroOuZero' },
  minPriceCents: { coluna: 'min_price_cents', leitura: 'numeroOuZero' },
  minStock: { coluna: 'min_stock', leitura: 'numeroOuZero' },
  minMarkupPercent: { coluna: 'min_markup_percent', leitura: 'numeroOuNulo' },
  minMarginPercent: { coluna: 'min_margin_percent', leitura: 'numeroOuNulo' },
  weightGrams: { coluna: 'weight_grams', leitura: 'numeroOuNulo' },
  heightCm: { coluna: 'height_cm', leitura: 'numeroOuNulo' },
  widthCm: { coluna: 'width_cm', leitura: 'numeroOuNulo' },
  lengthCm: { coluna: 'length_cm', leitura: 'numeroOuNulo' },
  tareGrams: { coluna: 'tare_grams', leitura: 'numeroOuNulo' },
  packFactor: { coluna: 'pack_factor', leitura: 'numeroOuNulo' },
  publishOnline: { coluna: 'publish_online', leitura: 'booleano' },
  openPrice: { coluna: 'open_price', leitura: 'booleano' },
  weighable: { coluna: 'weighable', leitura: 'booleano' },
  serialized: { coluna: 'serialized', leitura: 'booleano' },
  kitCostFromComponents: { coluna: 'kit_cost_from_components', leitura: 'booleano' },
  active: { coluna: 'active', leitura: 'ligadoPorPadrao' },
  stockControl: { coluna: 'stock_control', leitura: 'ligadoPorPadrao' },
  kitExplodeOnSale: { coluna: 'kit_explode_on_sale', leitura: 'ligadoPorPadrao' },
};

function mesmoValor(leitura: LeituraDoCampo, visto: unknown, gravado: unknown): boolean {
  switch (leitura) {
    case 'texto':
      return comoTexto(visto) === comoTexto(gravado);
    case 'maiusculo':
      return (comoTexto(visto)?.toUpperCase() ?? null) === (comoTexto(gravado)?.toUpperCase() ?? null);
    case 'fiscal': {
      const a = comoTexto(visto);
      const b = comoTexto(gravado);
      return (a === null ? null : semSeparadores(a)) === (b === null ? null : semSeparadores(b));
    }
    case 'numeroOuZero':
      return Number(comoTexto(visto) ?? 0) === Number(comoTexto(gravado) ?? 0);
    case 'numeroOuNulo': {
      const a = comoTexto(visto);
      const b = comoTexto(gravado);
      if (a === null || b === null) return a === b;
      return Number(a) === Number(b);
    }
    case 'booleano':
      return Boolean(visto) === (Number(gravado) === 1);
    case 'ligadoPorPadrao':
      return Boolean(visto) === (Number(gravado ?? 1) !== 0);
  }
}

/**
 * NINGUÉM MUDOU O MESMO CAMPO ENQUANTO EU EDITAVA? (A-produto-07)
 *
 * O DEFEITO: o formulário mandava o objeto INTEIRO em todo Salvar, e o UPDATE
 * era `WHERE id = ?` sem conferir nada. 10:00 o gestor A abre o perfume a
 * R$ 39,90; 10:05 o gestor B baixa para R$ 29,90 na Alteração rápida e imprime
 * as etiquetas; 10:10 A corrige só a descrição e salva — o preço volta a
 * R$ 39,90 sem aviso, e a trilha ainda atribui a "mudança" a A.
 *
 * O CONSERTO tem duas metades. A tela manda só o que a pessoa MUDOU (então a
 * descrição de A não arrasta o preço antigo), e manda em `expected` o valor que
 * ela VIU em cada um desses campos. Se o banco já não tem o que ela viu, outra
 * pessoa gravou por cima nesse meio-tempo: recusa com 409 em vez de escolher
 * um vencedor calado. Campo que não veio em `expected` não é conferido — os
 * outros chamadores (publicação em massa, importação, bancada) não mudam.
 *
 * Por que valor a valor, e não `updated_at`: imprimir etiqueta grava um EAN
 * interno e muda o `updated_at` sem mexer em nada do que a pessoa estava
 * editando. Recusar por isso seria alarme falso a cada impressão.
 */
function exigirQueNinguemMudouOMesmoCampo(
  expected: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
): void {
  if (!expected || typeof expected !== 'object') return;
  const mudados: { field: string; label: string; agora: string | null }[] = [];
  for (const [chave, visto] of Object.entries(expected)) {
    const campo = CAMPOS_DO_FORMULARIO[chave];
    if (!campo) continue;
    const gravado = current[campo.coluna];
    if (mesmoValor(campo.leitura, visto, gravado)) continue;
    const trilha = CAMPOS_DA_TRILHA.find((c) => c.coluna === campo.coluna);
    const texto = comoTexto(gravado);
    mudados.push({
      field: campo.coluna,
      label: trilha?.rotulo ?? campo.coluna,
      agora:
        trilha?.dinheiro && texto !== null
          ? `R$ ${(Number(texto) / 100).toFixed(2).replace('.', ',')}`
          : texto,
    });
  }
  if (mudados.length === 0) return;
  const lista = mudados
    .map((m) => `${m.label} (agora ${m.agora ?? 'em branco'})`)
    .join('; ');
  throw new ApiError(
    'CORE_PRODUCT_STALE',
    `Enquanto você editava, este produto foi alterado por outra pessoa ou outra tela: ${lista}. `
      + 'Nada foi gravado, para não desfazer a alteração dela. Recarregue o produto, confira o valor atual e refaça a sua mudança.',
    409,
    { fields: mudados },
  );
}

/** Percentual do piso: ausente preserva, vazio limpa, texto é recusado. */
function percentualEditado(valor: unknown, atual: unknown, rotulo: string): unknown {
  if (valor === undefined) return atual;
  if (valor === null || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) {
    throw new ApiError('CORE_PRICE_FLOOR_INVALID', `${rotulo} deve ser um número (ex.: 30 para 30%).`, 400);
  }
  return numero;
}

export function updateProduct(
  companyId: string,
  productId: string,
  input: ProductInput,
  regras: RegrasDoCadastro = {},
): Record<string, unknown> {
  // Transacional: a alteração do cadastro e o fato para a central saem juntos
  // ou não saem. Aninhada em outra transação, vira SAVEPOINT.
  return withTransaction(() => atualizarProduto(companyId, productId, input, regras));
}

function atualizarProduto(
  companyId: string,
  productId: string,
  input: ProductInput,
  regras: RegrasDoCadastro,
): Record<string, unknown> {
  ensureCoreSchema();
  const db = getConnection();
  const current = getProduct(companyId, productId);
  if (!current) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
  // Antes de qualquer outra conta: se outra pessoa gravou por cima do que esta
  // tela viu, nada do resto importa (A-produto-07).
  exigirQueNinguemMudouOMesmoCampo(input.expected, current);
  // O mesmo invariante da criação: a edição tampouco aceita dinheiro negativo.
  // Sem esta linha o PUT era o contorno do POST — o -500 recusado na criação
  // entrava pela alteração rápida de preço.
  exigirCentavosNaoNegativos(input.priceCents, input.costCents, input.minPriceCents);
  if (input.pluCode !== undefined) exigirPluLivre(companyId, input.pluCode, productId);
  /*
    NOME VAZIO NO PUT (A-produto-19). Só a criação exigia nome: um PUT com
    `name: ''` (integração, API) deixava o produto sem nome no PDV, e a NFC-e
    saía com <xProd> vazio — rejeição. Ausente preserva; presente tem de ter
    texto.
  */
  if (input.name !== undefined && !textoOuNulo(input.name)) {
    throw new ApiError(
      'CORE_INVALID_PAYLOAD',
      'O nome do produto não pode ficar em branco: é ele que sai no cupom e na busca do balcão.',
      400,
    );
  }
  const minimoDeEstoque = estoqueMinimo(input.minStock);
  const grupoFinal =
    input.taxProfile === undefined
      ? ((current.tax_profile as string | null) ?? null)
      : (textoOuNulo(input.taxProfile)?.toUpperCase() ?? null);
  // Só o grupo que MUDA é conferido: um cadastro antigo com grupo depois
  // desativado não pode travar a correção do preço (A-produto-09).
  if ((grupoFinal ?? '') !== String(current.tax_profile ?? '').trim().toUpperCase()) {
    exigirGrupoTributarioAtivo(companyId, grupoFinal);
  }
  const fornecedorFinal =
    input.supplierId === undefined
      ? ((current.supplier_id as string | null) ?? null)
      : textoOuNulo(input.supplierId);
  if (fornecedorFinal !== ((current.supplier_id as string | null) ?? null)) {
    exigirFornecedorDaEmpresa(companyId, fornecedorFinal);
  }
  const unidadeFinal =
    input.unit === undefined
      ? current.unit
      : (textoOuNulo(input.unit)?.toUpperCase() ?? current.unit);
  if (regras.unidadeDoVocabulario && unidadeFinal !== current.unit) {
    exigirUnidadeDoVocabulario(companyId, String(unidadeFinal));
  }
  const skuFinal = input.sku === undefined ? (current.sku as string | null) : textoOuNulo(input.sku);
  if (skuFinal && skuFinal !== current.sku) {
    exigirCodigoLivreNoBipe(companyId, skuFinal, productId, 'o SKU');
  }

  /*
    O CÓDIGO DE BARRAS TAMBÉM É CONFERIDO NA EDIÇÃO — e não era.

    `createProduct` pergunta nas duas tabelas antes de gravar. Aqui não se
    perguntava nada, e o desfecho dependia de qual das duas o código já
    ocupava:

      - em `core_products`, sobrava o índice único, e a tela do cadastro
        recebia um 500 cru em cima de "SQLITE_CONSTRAINT";
      - em `core_product_barcodes` não há índice nenhum que cubra o cruzamento,
        e o UPDATE passava. Dois produtos respondendo ao MESMO bipe, sem erro e
        sem aviso: a leitora acha um dos dois, a venda sai do produto errado e
        o saldo do certo nunca baixa.

    O segundo é o defeito de verdade; o 500 é só o mais barulhento. Mesma
    pergunta, mesmo código de recusa e mesma mensagem da criação — um fato, uma
    frase.
  */
  // Aparado UMA vez e usado igual na validação, na duplicidade e no UPDATE
  // (A-produto-04): antes a conferência via o texto aparado e o UPDATE gravava
  // o cru, com o espaço que o bipe nunca casa. Vazio LIMPA (A-produto-03).
  const codigoPedido = input.barcode === undefined ? undefined : textoOuNulo(input.barcode);
  if (codigoPedido) {
    exigirCodigoDeBarrasValido(codigoPedido);
    const dono = findProductByAnyBarcode(companyId, codigoPedido);
    if (dono && dono !== productId) {
      throw new ApiError(
        'CORE_BARCODE_DUPLICATE',
        'Este código de barras já pertence a outro produto.',
        409,
      );
    }
    if (codigoPedido !== current.barcode) {
      exigirCodigoLivreNoBipe(companyId, codigoPedido, productId, 'o código de barras');
    }
  }
  const codigoFinal = codigoPedido === undefined ? ((current.barcode as string | null) ?? null) : codigoPedido;

  // O estado FINAL é o que importa: ligar um sem desligar o outro no mesmo
  // PATCH deixaria o produto nos dois.
  const ficaSerializado = input.serialized ?? current.serialized === 1;
  const ficaPesavel = input.weighable ?? current.weighable === 1;
  const controlaEstoque = input.stockControl ?? current.stock_control !== 0;
  // O mesmo invariante da criação, sobre o estado FINAL: sem esta linha o PUT
  // seria o contorno do POST — o serviço pesável recusado no cadastro entraria
  // pela edição, ligando "pesável" num produto já marcado como serviço.
  exigirServicoCoerente({
    stockControl: controlaEstoque,
    weighable: ficaPesavel,
    serialized: ficaSerializado,
  });
  if (ficaSerializado && ficaPesavel) {
    throw new ApiError(
      'CORE_SERIALIZED_AND_WEIGHABLE',
      'Um produto não pode ser vendido por peso e controlado por unidade ao mesmo tempo.',
      400,
    );
  }

  /*
    O TIPO — este mapa NÃO É A PORTA DE CONVERSÃO.

    A história: `kind` e `workshop_id` estavam em `ProductInput`, a rota
    repassava o corpo inteiro e o formulário mandava os dois, mas eles não
    existiam no mapa `fields` — o PUT devolvia 200 OK e nada mudava. Foi por isso
    que, no banco real, nenhum dos dezenove produtos tinha oficina. O conserto
    ingênuo seria passar a gravá-los aqui. Isso abriria uma SEGUNDA PORTA de
    conversão, e ela seria a porta larga: esta rota é liberada também para
    `operador_caixa_loja` e `operador_caixa_oficina`, que a rota de conversão
    recusa com 403; e o que passasse por aqui não teria os `efeitos` contados nem
    o rastro de auditoria que a conversão grava.

    Então a conversão tem UMA PORTA SÓ: `POST /products/:id/tipo`. Aqui o par é
    LIDO do que já está gravado e devolve ao mapa normalizado (é isso que impede
    uma mercadoria de continuar carregando a oficina de um cadastro antigo), mas
    nunca vem do corpo da requisição.

    O que este mapa continua cobrando é o ESTADO FINAL dos outros campos contra o
    tipo que o produto JÁ TEM, como em serializado/pesável logo acima: um PUT não
    consegue marcar como pesável, nem dar PLU, nem publicar na vitrine o produto
    que já é peça. O invariante vale nos dois sentidos.
  */
  const kindAtual = normalizarKind(current.kind as string | null);
  const bancadaAtual = (current.workshop_id as string | null) ?? null;
  exigirQueOTipoNaoMudeAqui(input, kindAtual, bancadaAtual);

  const pluFinal = input.pluCode === undefined
    ? (current.plu_code as string | null)
    : String(input.pluCode).trim() || null;
  const tipo = exigirTipoCoerente({
    companyId,
    kind: kindAtual,
    workshopId: bancadaAtual,
    weighable: ficaPesavel,
    pluCode: pluFinal,
    isKit: current.is_kit === 1,
    productId,
  });
  exigirQueNaoPubliquePeca(
    tipo.kind,
    input.publishOnline === undefined ? current.publish_online === 1 : input.publishOnline === true,
    input.publishOnline === true,
  );

  /*
    LIGAR "controlado por unidade" num produto que JÁ TEM saldo.

    O saldo diz "3" e não existe nenhuma unidade cadastrada. Deixar assim faria
    a próxima venda ser recusada por falta de unidade, com o estoque dizendo
    que há três — e ninguém entenderia por quê.

    Três unidades anônimas são criadas na hora, marcadas como regularização.
    Elas nascem sem identidade justamente para aparecerem na tela pedindo o
    chassi: é a fila de trabalho de quem acabou de ligar a chave.

    Desligar não mexe em nada. As unidades ficam onde estão, e religar
    reaproveita as que já existiam — desligar por engano não pode custar o
    cadastro de identidade já feito.
  */
  if (input.serialized === true && current.serialized !== 1) {
    const saldo = getBalance(companyId, productId);
    const jaTem = countInStock(companyId, productId);
    const faltam = Math.round(saldo) - jaTem;
    if (!Number.isInteger(saldo)) {
      throw new ApiError(
        'CORE_SERIALIZED_FRACTIONAL',
        `"${current.name}" tem saldo fracionado (${saldo}) e não pode ser controlado por unidade.`,
        409,
      );
    }
    if (faltam > 0) {
      createUnits(companyId, productId, faltam, {
        entryReferenceType: 'regularizacao',
        entryReferenceId: productId,
        note: 'Criada ao ligar o controle por unidade — falta identificar.',
      });
    }
  }

  /*
    DESLIGAR O CONTROLE DE ESTOQUE DE QUEM AINDA TEM SALDO (GAP-V02).

    O saldo diz "7" e, a partir do salvar, ninguém mais o baixa nem o conta: as
    sete unidades saem da posição de estoque, saem do valor do estoque e saem da
    contagem de inventário, sem nenhum movimento que explique para onde foram. O
    razão passa a ter uma entrada sem a saída correspondente — e ele é
    append-only justamente para que isso não aconteça.

    A recusa nomeia o saldo e o caminho: zerar por movimento registrado é o
    gesto que DEIXA rastro, e é o que a pessoa faria de qualquer forma se o
    sistema não a deixasse escapar por aqui.

    LIGAR o controle de volta não precisa de recusa nenhuma: o saldo é zero por
    construção (nunca houve movimento) e o produto volta a contar do zero, que é
    a verdade.
  */
  if (input.stockControl === false && current.stock_control !== 0) {
    const saldo = getBalance(companyId, productId);
    if (saldo !== 0) {
      throw new ApiError(
        'CORE_STOCK_CONTROL_WITH_BALANCE',
        `"${current.name}" ainda tem ${saldo} em estoque e não pode virar serviço: o saldo `
          + 'sumiria da posição sem nenhum movimento que explicasse para onde foi. '
          + 'Zere o saldo por um movimento registrado e tente de novo.',
        409,
        { productId, saldo },
      );
    }
  }
  const envio = normalizeShippingData(input);
  const embalagem = fatorDeEmbalagem(input.packFactor);

  const fields: Record<string, unknown> = {
    name: input.name === undefined ? current.name : textoOuNulo(input.name),
    sku: skuFinal,
    barcode: codigoFinal,
    /*
      AUSENTE PRESERVA, VAZIO LIMPA — agora também em descrição, categoria,
      marca, subcategoria, NCM, CEST, CFOP, origem, EAN, referência, fornecedor
      e descrição da vitrine (A-produto-03). Era só em grupo tributário, PLU,
      endereço e embalagem; nos outros, `input.x ?? current.x` fazia o campo
      apagado voltar ao salvar — com "Produto atualizado." na tela.
    */
    description: textoEditado(input.description, current.description),
    category: textoEditado(input.category, current.category),
    brand: textoEditado(input.brand, current.brand),
    unit: unidadeFinal,
    cost_cents: input.costCents ?? current.cost_cents,
    price_cents: input.priceCents ?? current.price_cents,
    min_stock: minimoDeEstoque ?? current.min_stock,
    // Conferidos só quando MUDAM, e gravados só com dígitos (A-produto-04).
    ncm: codigoFiscalEditado(input.ncm, current.ncm, 'ncm'),
    cest: codigoFiscalEditado(input.cest, current.cest, 'cest'),
    cfop: codigoFiscalEditado(input.cfop, current.cfop, 'cfop'),
    /*
      O FORNECEDOR NÃO ESTAVA NO MAPA (A-produto-10): a tela o mandava, o PUT
      devolvia "Produto atualizado." e o valor antigo voltava ao recarregar.
    */
    supplier_id: fornecedorFinal,
    /*
      GRUPO TRIBUTÁRIO: ausente PRESERVA, vazio LIMPA (GAP-V01).

      A distinção nasce com o seletor da tela. Sem ela, escolher um grupo por
      engano seria irreversível pela interface: "usar o padrão da operação" é
      uma opção legítima do formulário, e ela precisa de um jeito de dizer
      "nenhum" — exatamente como o PLU e o endereço da prateleira.

      O `?? ''` não é decoração: `String(null)` é a palavra "null", que é
      truthy, e sem ele limpar o campo gravaria o texto `null` na coluna — que
      `tributacaoDoItem` procuraria como CÓDIGO de grupo e não acharia,
      travando a emissão com uma mensagem sobre um perfil que ninguém digitou.

      MAIÚSCULAS porque é assim que o grupo é buscado (`code = ?` com
      `perfil.toUpperCase()`): guardar minúsculo aqui funcionaria por acaso e
      falharia no dia em que a busca parasse de normalizar.
    */
    // Normalizado lá em cima, e conferido contra os grupos ATIVOS quando muda
    // (A-produto-09).
    tax_profile: grupoFinal,
    image_url: input.imageUrl ?? current.image_url,
    active: input.active === undefined ? current.active : input.active ? 1 : 0,
    publish_online:
      input.publishOnline === undefined ? current.publish_online : input.publishOnline ? 1 : 0,
    // Medida enviada substitui; medida ausente preserva a que estava. Zerar
    // sem querer tiraria o produto da entrega sem ninguém pedir.
    weight_grams: envio.weightGrams ?? current.weight_grams,
    height_cm: envio.heightCm ?? current.height_cm,
    width_cm: envio.widthCm ?? current.width_cm,
    length_cm: envio.lengthCm ?? current.length_cm,
    subcategory: textoEditado(input.subcategory, current.subcategory),
    online_description: textoEditado(input.onlineDescription, current.online_description),
    origin: codigoFiscalEditado(input.origin, current.origin, 'origin'),
    reference: textoEditado(input.reference, current.reference),
    /*
      String vazia (ou nulo) LIMPA o endereço; AUSENTE preserva. Quem tira a
      peça da prateleira precisa poder dizer que ela não tem mais lugar fixo.

      O `?? ''` não é decoração: `String(null)` é a palavra "null", que é
      truthy — sem ele, limpar o campo gravaria o texto `null` na coluna, e a
      tela passaria a mostrar "null" como se fosse o nome da prateleira.
    */
    storage_location:
      input.storageLocation === undefined
        ? current.storage_location
        : String(input.storageLocation ?? '').trim() || null,
    // Ausente preserva o que estava, como nas medidas de envio: zerar um piso
    // sem querer liberaria a venda abaixo do que alguém decidiu. Mas NULO (ou
    // vazio) é o pedido explícito de TIRAR o piso (A-produto-03): antes não
    // havia como apagar um mínimo digitado errado, e o aviso "viola o mínimo"
    // continuava aparecendo. Preço mínimo sem piso é 0, como na criação.
    min_price_cents:
      input.minPriceCents === undefined
        ? current.min_price_cents
        : input.minPriceCents === null || (input.minPriceCents as unknown) === ''
          ? 0
          : Number(input.minPriceCents),
    min_markup_percent: percentualEditado(
      input.minMarkupPercent,
      current.min_markup_percent,
      'O markup mínimo',
    ),
    min_margin_percent: percentualEditado(
      input.minMarginPercent,
      current.min_margin_percent,
      'A margem mínima',
    ),
    open_price: input.openPrice === undefined ? current.open_price : input.openPrice ? 1 : 0,
    kit_explode_on_sale:
      input.kitExplodeOnSale === undefined
        ? current.kit_explode_on_sale
        : input.kitExplodeOnSale
          ? 1
          : 0,
    kit_cost_from_components:
      input.kitCostFromComponents === undefined
        ? current.kit_cost_from_components
        : input.kitCostFromComponents
          ? 1
          : 0,
    weighable: input.weighable === undefined ? current.weighable : input.weighable ? 1 : 0,
    serialized: input.serialized === undefined ? current.serialized : input.serialized ? 1 : 0,
    // String vazia limpa o PLU; ausente preserva. Sem essa distinção não
    // haveria como TIRAR um produto da balança sem apagar o cadastro.
    plu_code:
      input.pluCode === undefined ? current.plu_code : String(input.pluCode).trim() || null,
    tare_grams: input.tareGrams === undefined ? current.tare_grams : (input.tareGrams ?? null),
    // Ausente preserva; só o booleano explícito muda de lado. Ver a recusa de
    // saldo logo acima: desligar com estoque não chega até aqui.
    stock_control: controlaEstoque ? 1 : 0,
    /*
      Fator AUSENTE preserva; fator VAZIO limpa. A distinção é a mesma do PLU e
      do endereço da prateleira, e existe pela mesma razão: sem ela não haveria
      como dizer "este produto não vem mais em caixa" sem apagar o cadastro.
      `fatorDeEmbalagem` devolve nulo tanto para ausente quanto para vazio, por
      isso quem decide qual dos dois é o `input.packFactor === undefined`.
    */
    pack_factor: input.packFactor === undefined ? current.pack_factor : embalagem,
    pack_unit:
      input.packUnit === undefined
        ? current.pack_unit
        : String(input.packUnit ?? '').trim().toUpperCase() || null,
    // O par sai normalizado de `exigirTipoCoerente`, nunca do corpo cru: é ele
    // que garante que revenda não fique carregando oficina de cadastro antigo.
    kind: tipo.kind,
    workshop_id: tipo.workshopId,
  };

  // As colunas são montadas a partir das CHAVES de `fields`, não escritas à
  // mão. Antes a lista era fixa: bastava acrescentar um campo ao objeto e os
  // parâmetros saíam de ordem, gravando cada valor na coluna errada — sem
  // nenhum erro visível.
  const colunas = Object.keys(fields);
  db.prepare(
    `UPDATE core_products SET ${colunas.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    ...(Object.values(fields) as never[]),
    new Date().toISOString(),
    productId,
    companyId,
  );

  /*
    TROCAR O CÓDIGO PRINCIPAL NÃO APAGA O ANTIGO (A-produto-08).

    `barcode: input.barcode ?? current.barcode` gravava o novo e descartava o
    anterior. As 40 etiquetas já coladas na prateleira com o EAN interno
    antigo passavam a dar "nenhum produto encontrado" no bipe — e o caixa
    cadastrava o item de novo. O próprio `ensureBarcode` já dizia que trocar o
    código de um produto etiquetado invalida as etiquetas impressas; o PUT não
    respeitava isso.

    O antigo passa a ADICIONAL, na mesma transação: o bipe da etiqueta velha
    continua achando o produto, e quem quiser aposentá-lo remove na aba
    Códigos. Se o novo principal era um adicional deste mesmo produto, ele sai
    da lista de adicionais — senão apareceria duas vezes. LIMPAR o principal
    (vazio) não guarda nada: é o gesto de quem diz que o código estava errado.
  */
  const codigoAnterior = (current.barcode as string | null) ?? null;
  if (codigoFinal && codigoAnterior && codigoFinal !== codigoAnterior) {
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (company_id, barcode) DO NOTHING`,
    ).run(randomUUID(), companyId, productId, codigoAnterior, agora);
  }
  if (codigoFinal && codigoFinal !== codigoAnterior) {
    db.prepare(
      'DELETE FROM core_product_barcodes WHERE company_id = ? AND product_id = ? AND barcode = ?',
    ).run(companyId, productId, codigoFinal);
  }

  const produto = getProduct(companyId, productId)!;
  // Cadastro não é apagado: produto que já saiu em venda antiga precisa
  // continuar existindo na central para a nota e o histórico fazerem sentido.
  // Desativar é mudança de estado, e vai como tal.
  recordDomainEvent({
    eventType: produto.active === 0 ? 'product.deactivated' : 'product.upserted',
    aggregateType: 'product',
    aggregateId: productId,
    companyId,
    // A oficina dona vai junto: para a central, o fato de uma peça pertence à
    // bancada, como já acontece no cadastro novo.
    operationalUnitId: tipo.workshopId,
    operation: 'update',
    payload: produto,
  });
  return produto;
}

// -------------------------------------------------- o que mudou no cadastro

/**
 * OS CAMPOS QUE A TRILHA NOMEIA, e como se chamam para quem lê (GAP-V05).
 *
 * A auditoria gravava `product.update` sem `detail` nenhum: sabia-se QUE houve
 * alteração, nunca O QUE mudou. "Quem baixou o preço de 39,90 para 29,90?" era
 * pergunta sem resposta — vinte alterações no banco real, nenhuma com conteúdo.
 *
 * O mapa é EXPLÍCITO, e não "todas as colunas": `updated_at` muda em todo
 * salvar e não é decisão de ninguém; `id` e `company_id` não mudam nunca. Uma
 * lista automática encheria a trilha de ruído e faria a mudança de preço se
 * perder no meio dele.
 *
 * O rótulo vem junto porque quem lê a ficha do produto não conhece o nome da
 * coluna. `min_markup_percent` não diz nada; "markup mínimo (%)" diz.
 */
const CAMPOS_DA_TRILHA: { coluna: string; rotulo: string; dinheiro?: boolean }[] = [
  { coluna: 'name', rotulo: 'Nome' },
  { coluna: 'description', rotulo: 'Descrição' },
  { coluna: 'sku', rotulo: 'SKU' },
  { coluna: 'barcode', rotulo: 'Código de barras' },
  { coluna: 'category', rotulo: 'Categoria' },
  { coluna: 'subcategory', rotulo: 'Subcategoria' },
  { coluna: 'brand', rotulo: 'Marca' },
  { coluna: 'unit', rotulo: 'Unidade' },
  { coluna: 'cost_cents', rotulo: 'Custo', dinheiro: true },
  { coluna: 'price_cents', rotulo: 'Preço de venda', dinheiro: true },
  { coluna: 'min_price_cents', rotulo: 'Preço mínimo', dinheiro: true },
  { coluna: 'min_markup_percent', rotulo: 'Markup mínimo (%)' },
  { coluna: 'min_margin_percent', rotulo: 'Margem mínima (%)' },
  { coluna: 'min_stock', rotulo: 'Estoque mínimo' },
  { coluna: 'ncm', rotulo: 'NCM' },
  { coluna: 'cest', rotulo: 'CEST' },
  { coluna: 'cfop', rotulo: 'CFOP' },
  { coluna: 'origin', rotulo: 'Origem' },
  { coluna: 'tax_profile', rotulo: 'Grupo tributário' },
  { coluna: 'supplier_id', rotulo: 'Fornecedor' },
  { coluna: 'reference', rotulo: 'Referência do fabricante' },
  { coluna: 'storage_location', rotulo: 'Endereço na prateleira' },
  { coluna: 'active', rotulo: 'Ativo' },
  { coluna: 'publish_online', rotulo: 'Publicado na loja' },
  { coluna: 'featured_online', rotulo: 'Destaque na loja' },
  { coluna: 'online_description', rotulo: 'Descrição da vitrine' },
  { coluna: 'open_price', rotulo: 'Preço aberto' },
  { coluna: 'weighable', rotulo: 'Vendido por peso' },
  { coluna: 'plu_code', rotulo: 'PLU da balança' },
  { coluna: 'tare_grams', rotulo: 'Tara (g)' },
  { coluna: 'serialized', rotulo: 'Controlado por unidade' },
  { coluna: 'stock_control', rotulo: 'Controla estoque' },
  { coluna: 'pack_factor', rotulo: 'Unidades por embalagem' },
  { coluna: 'pack_unit', rotulo: 'Sigla da embalagem' },
  { coluna: 'kit_explode_on_sale', rotulo: 'Desmembra o kit na venda' },
  { coluna: 'kit_cost_from_components', rotulo: 'Custo do kit vem das peças' },
  { coluna: 'weight_grams', rotulo: 'Peso (g)' },
  { coluna: 'height_cm', rotulo: 'Altura (cm)' },
  { coluna: 'width_cm', rotulo: 'Largura (cm)' },
  { coluna: 'length_cm', rotulo: 'Comprimento (cm)' },
  { coluna: 'kind', rotulo: 'Tipo' },
  { coluna: 'workshop_id', rotulo: 'Oficina dona' },
];

export interface MudancaDeCampo {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

/** Nulo, indefinido e string vazia são a MESMA coisa para quem lê a trilha. */
function comoTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
}

/**
 * O DIFF entre duas fotografias do MESMO produto.
 *
 * Compara as LINHAS GRAVADAS, e não o corpo da requisição contra o banco. A
 * diferença decide se a trilha diz a verdade: o corpo do PUT traz o objeto
 * inteiro do formulário toda vez, com quarenta campos iguais aos que já estão
 * lá; e o servidor normaliza (maiúsculas na sigla, vazio virando nulo, o par
 * tipo/oficina saindo de `exigirTipoCoerente`). Uma trilha montada sobre o
 * corpo listaria quarenta "alterações" a cada salvar e ainda erraria o valor
 * final de várias delas.
 *
 * O padrão é o mesmo já usado em `fiscal.product_updated` (detail.fields) —
 * um jeito só de contar o que mudou num cadastro.
 */
export function diferencasDoProduto(
  antes: Record<string, unknown> | null | undefined,
  depois: Record<string, unknown> | null | undefined,
): MudancaDeCampo[] {
  if (!antes || !depois) return [];
  const mudancas: MudancaDeCampo[] = [];
  for (const campo of CAMPOS_DA_TRILHA) {
    const de = comoTexto(antes[campo.coluna]);
    const para = comoTexto(depois[campo.coluna]);
    if (de === para) continue;
    /*
      O DINHEIRO SAI EM REAIS NA TRILHA, e centavos ficam no banco.

      Quem lê o histórico é gente: "3990 → 2990" faz a pessoa dividir por cem de
      cabeça para conferir se o preço caiu dez reais ou cem. A conversão é só de
      APRESENTAÇÃO — nada aqui volta para conta nenhuma.
    */
    const emReais = (v: string | null) =>
      v === null ? null : (Number(v) / 100).toFixed(2).replace('.', ',');
    mudancas.push({
      field: campo.coluna,
      label: campo.rotulo,
      from: campo.dinheiro ? emReais(de) : de,
      to: campo.dinheiro ? emReais(para) : para,
    });
  }
  return mudancas;
}

/**
 * O HISTÓRICO de um produto, lido da trilha central (GAP-V05).
 *
 * Não há tabela nova: `core_audit_log` já guarda quem, quando e sobre qual
 * entidade, e a partir desta rodada guarda TAMBÉM o que mudou. Uma segunda
 * tabela de histórico divergiria da auditoria no primeiro caminho que
 * esquecesse de escrever nas duas.
 *
 * A pergunta que isto responde é a do GERENTE, e é por isso que existe fora da
 * AuditoriaPage: aquela tela é restrita aos donos do grupo, e quem precisa
 * saber por que o preço mudou é quem cuida do catálogo.
 */
export function productHistory(
  companyId: string,
  productId: string,
  limit = 50,
): Record<string, unknown>[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT a.id, a.action, a.created_at, a.detail, a.user_id,
              u.display_name AS user_name
         FROM core_audit_log a
         LEFT JOIN core_users u ON u.id = a.user_id
        WHERE a.company_id = ? AND a.entity_type = 'product' AND a.entity_id = ?
        ORDER BY a.created_at DESC
        LIMIT ?`,
    )
    .all(companyId, productId, limit) as unknown as {
      id: string;
      action: string;
      created_at: string;
      detail: string | null;
      user_id: string | null;
      user_name: string | null;
    }[];

  return linhas.map((l) => {
    /*
      DETALHE ILEGÍVEL NÃO DERRUBA O HISTÓRICO. A trilha é append-only e tem
      linhas de todas as rodadas anteriores, com formatos diferentes de
      `detail` — inclusive as vinte de `product.update` que não têm nenhum.
      Um JSON.parse solto aqui faria a aba inteira falhar por causa da linha
      mais antiga.
    */
    let detail: unknown;
    try {
      detail = l.detail ? JSON.parse(l.detail) : null;
    } catch {
      detail = null;
    }
    const brutos = (detail as { fields?: unknown } | null)?.fields;
    /*
      SÓ O QUE TEM FORMA DE MUDANÇA VIRA LINHA DE "DE → PARA" (A-produto-18).

      Algumas rotas gravavam `fields` como lista de CÓDIGOS (strings) — o PUT de
      campos próprios e a tela fiscal. Repassada crua, a tela desenhava
      ": — → —" com chave indefinida a cada Salvar. As strings saem daqui e
      viram o `resumo`, que diz o que se sabe delas.
    */
    const fields = (Array.isArray(brutos) ? brutos : []).filter(
      (f): f is MudancaDeCampo =>
        Boolean(f)
        && typeof f === 'object'
        && typeof (f as MudancaDeCampo).field === 'string'
        && typeof (f as MudancaDeCampo).label === 'string',
    );
    const codigos = (Array.isArray(brutos) ? brutos : []).filter(
      (f): f is string => typeof f === 'string',
    );
    return {
      id: l.id,
      action: l.action,
      created_at: l.created_at,
      user_id: l.user_id,
      user_name: l.user_name,
      // Alteração antiga (antes desta rodada) tem lista VAZIA, e é a verdade
      // sobre ela: o que mudou não foi registrado e não há como recuperar.
      fields,
      resumo: resumoDoEvento(l.action, detail, codigos, l.detail !== null),
    };
  });
}

/**
 * O QUE ACONTECEU, em uma frase, para o evento que não é "campo de → para"
 * (A-produto-18).
 *
 * A aba dizia "Registro anterior ao detalhamento — o que mudou não foi
 * guardado" para a CRIAÇÃO do produto e para o EAN gerado, o que é falso: esses
 * eventos são novos e o detalhe deles está gravado. Nulo = não há o que dizer
 * além do nome da ação (e, para `product.update` sem detalhe, a tela mantém a
 * frase honesta sobre o registro antigo).
 */
function resumoDoEvento(
  acao: string,
  detail: unknown,
  codigos: string[],
  temDetalhe: boolean,
): string | null {
  const d = (detail ?? {}) as Record<string, unknown>;
  const reais = (centavos: unknown) =>
    `R$ ${(Number(centavos ?? 0) / 100).toFixed(2).replace('.', ',')}`;
  switch (acao) {
    case 'product.create':
      return 'Produto cadastrado.';
    case 'catalog.product.clone':
      return 'Produto criado como cópia de outro.';
    case 'product.barcode_generated':
    case 'product.barcode.generate':
      return d.barcode ? `Código de barras interno gerado: ${String(d.barcode)}.` : 'Código de barras interno gerado.';
    case 'product.image.add':
      return 'Foto acrescentada.';
    case 'product.image.remove':
      return 'Foto removida.';
    case 'product.kind.to_part':
      return 'Convertido em peça de oficina.';
    case 'product.kind.to_retail':
      return 'Convertido em mercadoria de revenda.';
    case 'product.batch_control':
      return d.tracksBatches ? 'Controle de lote e validade ligado.' : 'Controle de lote e validade desligado.';
    case 'catalog.kit.set':
      return `Composição do kit gravada (${Number(d.components ?? 0)} peça(s)).`;
    case 'catalog.price_tier.set':
      return `Preço por quantidade: a partir de ${String(d.minQuantity ?? '?')}, ${reais(d.priceCents)} cada.`;
    case 'catalog.price_tier.remove':
      return `Preço por quantidade a partir de ${String(d.minQuantity ?? '?')} removido.`;
    case 'product.update':
      // Detalhe presente e lista vazia é o "salvar sem mexer em nada"; detalhe
      // ausente é o registro antigo, que a tela explica.
      return temDetalhe ? 'Salvo sem mudança de campo.' : null;
    default:
      if (codigos.length > 0) {
        return `Campos alterados: ${codigos.join(', ')} (os valores não foram guardados neste registro).`;
      }
      return null;
  }
}

export function getProduct(companyId: string, productId: string): Record<string, unknown> | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as Record<string, unknown> | undefined;
  return row ?? null;
}

/**
 * Busca do PDV: código interno, código de barras, SKU ou nome.
 *
 * Modelo com grade fica DE FORA: quem sai da prateleira é o tamanho, não o
 * modelo. Se ele aparecesse, o operador escolheria "Camiseta Polo", levaria
 * uma recusa no fechamento e teria que buscar de novo. As variantes aparecem
 * normalmente, cada uma com o nome completo ("Camiseta Polo · M · Azul") e o
 * próprio saldo.
 *
 * PEÇA DE OFICINA: DEPENDE DE COMO SE PROCURA. Ver `incluirPecas` abaixo — a
 * regra tem duas metades e as duas importam.
 */
export function searchProducts(
  companyId: string,
  term: string,
  limit = 30,
  options: {
    /**
     * `excludeKits` serve à tela de montar kit.
     *
     * Kit dentro de kit é recusado pelo servidor — a baixa de estoque desceria
     * níveis e um ciclo travaria a venda. Oferecer o kit na busca e recusá-lo
     * no salvar ensina a pessoa a desconfiar da tela; melhor não oferecer.
     */
    excludeKits?: boolean;
    /**
     * Trazer TAMBÉM as peças de bancada na busca por texto. Padrão: não.
     *
     * Existe para a tela que quiser oferecer as peças de propósito — a venda
     * de balcão de uma peça avulsa acontece. Não muda nada na busca por
     * código: essa acha peça de qualquer jeito, ligada ou desligada.
     */
    includeParts?: boolean;
  } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const like = `%${term}%`;
  const semKits = options.excludeKits ? 'AND p.is_kit = 0' : '';

  /*
    A PEÇA SAI DA BUSCA POR NOME E FICA NA BUSCA POR CÓDIGO.

    São dois gestos diferentes no mesmo campo, e tratá-los igual erra de um dos
    dois lados:

    BUSCA POR NOME é o operador procurando o que vender. Digitar "bateria" e ver
    quarenta baterias da bancada de celulares junto com as duas que a loja
    revende esconde o produto certo no meio do estoque de conserto — e a peça
    tem preço de reposição, então a chance de vender pelo valor errado é real.
    Por isso peça fica fora por padrão.

    BIPAGEM DE CÓDIGO DE BARRAS é outra coisa: o item está na mão da pessoa. Se
    a busca responder "produto não encontrado" para algo que existe na gaveta,
    o operador faz a única coisa que a tela deixou: cadastra de novo. E aí o
    mesmo item passa a ter dois cadastros, o saldo racha entre eles, e nenhum
    dos dois diz a verdade — o pior desfecho possível, muito pior que mostrar
    uma peça onde não se esperava. Então o código EXATO acha sempre, e a linha
    volta com `kind` e `workshop_name` para a tela poder dizer o que é aquilo.

    Quem decide é a tela. A busca não mente sobre o que existe.
  */
  const pecaNaBuscaPorTexto = options.includeParts ? '1 = 1' : `p.kind <> 'part'`;

  const linhas = getConnection()
    .prepare(
      /*
       * OS CÓDIGOS ADICIONAIS ENTRAM AQUI, E É AQUI QUE ELES PASSAM A EXISTIR.
       *
       * Um produto tem mais de um código na prática: o do fabricante, o do
       * fardo, o da etiqueta antiga que ainda circula. Guardá-los sem ensinar a
       * BUSCA a enxergá-los deixava o cadastro decorativo — bipar o segundo
       * código no balcão não achava nada.
       *
       * `EXISTS` e não `JOIN`: junção multiplicaria a linha do produto por
       * código cadastrado, e o balcão veria o mesmo item três vezes. Com
       * `EXISTS` não precisa de DISTINCT.
       *
       * O casamento por código adicional conta como EXATO na ordenação — quem
       * bipa espera o item bipado em primeiro, não importa por qual dos códigos
       * dele o leitor acertou.
       *
       * `core_workshops` entra por LEFT JOIN e não por subconsulta porque
       * `workshop_id` é nulo na esmagadora maioria das linhas: a junção não
       * multiplica nada (a oficina é uma só) e o nome vem na mesma passada.
       * Nome, e não só o id: "esta é peça da Oficina de Celulares" é uma frase
       * que a tela consegue mostrar; um UUID não é.
       */
      /*
       * `matched_exact` (A-produto-M01): a linha diz se casou por CÓDIGO — o
       * principal, o interno ou um ADICIONAL. O PDV decidia "exato" comparando
       * `barcode`/`internal_code` com o termo, e o adicional (que só esta
       * consulta conhece) caía em "lista": bipar o EAN da caixa fechada abria a
       * lista em vez de pôr o item no carrinho. É a MESMA expressão da
       * ordenação, para as duas nunca discordarem.
       *
       * O código interno é comparado em QUALQUER CAIXA (A-produto-M04): quem
       * digita "pj-0105" no balcão procura o "PJ-0105".
       */
      `SELECT p.*, COALESCE(s.quantity, 0) AS stock_quantity,
              w.name AS workshop_name,
              CASE WHEN p.barcode = ? OR upper(p.internal_code) = upper(?)
                     OR EXISTS (SELECT 1 FROM core_product_barcodes b3
                                 WHERE b3.product_id = p.id AND b3.barcode = ?)
                   THEN 1 ELSE 0 END AS matched_exact
         FROM core_products p
         LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
         LEFT JOIN core_workshops w ON w.id = p.workshop_id AND w.company_id = p.company_id
        WHERE p.company_id = ? AND p.active = 1
          AND ${modeloAtivo('p')}
          AND NOT EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id)
          ${semKits}
          AND (
                p.barcode = ? OR upper(p.internal_code) = upper(?) OR p.sku = ?
                OR EXISTS (SELECT 1 FROM core_product_barcodes b
                            WHERE b.product_id = p.id AND b.barcode = ?)
                OR (${pecaNaBuscaPorTexto}
                    AND (p.name LIKE ? OR p.internal_code LIKE ?))
              )
        ORDER BY
          CASE WHEN p.barcode = ? OR upper(p.internal_code) = upper(?)
                 OR EXISTS (SELECT 1 FROM core_product_barcodes b2
                             WHERE b2.product_id = p.id AND b2.barcode = ?)
               THEN 0 ELSE 1 END,
          p.name
        LIMIT ?`,
    )
    .all(
      term,
      term,
      term,
      companyId,
      term,
      term,
      term,
      term,
      like,
      like,
      term,
      term,
      term,
      limit,
    ) as unknown as Record<string, unknown>[];

  /**
   * O preço VIGENTE acompanha o resultado.
   *
   * Sem isto o balcão perdia a promoção: a busca devolvia só o preço de
   * tabela, o operador punha esse valor no carrinho, e o cliente que viu
   * R$ 246,75 no site pagava R$ 329,00 na loja. O preço de tabela continua
   * vindo junto, para a tela mostrar o "de/por".
   */
  const achados = linhas.map((linha) => comPrecoVigente(companyId, linha));

  /*
    A ETIQUETA DA BALANÇA, SÓ QUANDO NENHUM CÓDIGO CADASTRADO CASOU
    (D-pdv-teclado-16).

    O casamento exato vence sempre: um código cadastrado é a palavra do
    cadastro, e a etiqueta da balança é uma LEITURA do código. Só sem ele, e só
    na subfaixa que a operação declarou, o PLU e o valor são extraídos.

    A linha vem com `balanca` (a quantidade em kg, ou o total impresso) e com
    `matched_exact` em ZERO de propósito: a tela que ainda não lê `balanca`
    manda o achado para a lista, onde a pessoa digita o peso — em vez de pôr
    "1 kg" no carrinho, que é o que o casamento exato faria.
  */
  if (achados.some((l) => Number(l.matched_exact) === 1)) return achados;
  const daBalanca = itensDaEtiquetaDaBalanca(companyId, term, semKits);
  if (daBalanca.length === 0) return achados;
  const jaVieram = new Set(daBalanca.map((l) => String(l.id)));
  return [...daBalanca, ...achados.filter((l) => !jaVieram.has(String(l.id)))].slice(0, limit);
}

/**
 * O preço VIGENTE acompanha o resultado.
 *
 * Sem isto o balcão perdia a promoção: a busca devolvia só o preço de
 * tabela, o operador punha esse valor no carrinho, e o cliente que viu
 * R$ 246,75 no site pagava R$ 329,00 na loja. O preço de tabela continua
 * vindo junto, para a tela mostrar o "de/por".
 */
function comPrecoVigente(companyId: string, linha: Record<string, unknown>): Record<string, unknown> {
  const vigente = effectivePriceCents(
    companyId,
    String(linha.id),
    Number(linha.price_cents ?? 0),
    (linha.category as string | null) ?? null,
  );
  return {
    ...linha,
    effective_price_cents: vigente.priceCents,
    on_sale: vigente.onSale,
  };
}

/**
 * O produto da etiqueta da balança, com o que a etiqueta diz (D-pdv-teclado-16).
 *
 * Mesmas portas da busca por código: ativo, sem modelo de grade, sem kit quando
 * a tela pediu. O PLU é comparado sem os zeros à esquerda — a balança imprime
 * "0105" para o PLU 105. A etiqueta — de PESO ou de PREÇO — só vale para
 * produto pesável: 0,352 de uma camiseta vendida por unidade não é quantidade.
 *
 * `balanca.quantidade` é o que vai na linha da venda: o peso em kg, ou — na
 * etiqueta de PREÇO — o total dividido pelo preço vigente (3 casas; nulo sem
 * preço). `balanca.precoTotalCents` é o total impresso na etiqueta de preço,
 * para a tela conferir com o que ela vai cobrar.
 */
function itensDaEtiquetaDaBalanca(
  companyId: string,
  term: string,
  semKits: string,
): Record<string, unknown>[] {
  // Só um EAN-13 pode ser etiqueta da balança. Sem esta porta, TODA busca por
  // nome sem casamento exato lia a declaração no banco a cada tecla.
  if (!/^\d{13}$/.test(String(term ?? '').trim())) return [];
  const config = lerConfigDaEtiquetaDaBalanca(companyId);
  if (!config) return [];
  const etiqueta = lerEtiquetaDaBalanca(config, term);
  if (!etiqueta) return [];
  /*
    SÓ PRODUTO PESÁVEL, NOS DOIS TIPOS DE ETIQUETA (revisão de D-pdv-teclado-16).

    O DEFEITO: a porta `weighable = 1` valia só para a etiqueta de PESO. Na de
    PREÇO, um PLU que sobrou num produto vendido por unidade (desmarcado
    "pesável", PLU mantido) voltava com quantidade = total ÷ preço — 2,214 UN
    de uma camiseta —, e a venda recusava depois com
    CORE_QUANTITY_MUST_BE_INTEGER. A balança só conhece o que a exportação
    mandou para ela, e a exportação (`ScaleExportService`) só manda pesável:
    etiqueta com PLU de produto não pesável é etiqueta velha, não item.
  */
  const linhas = getConnection()
    .prepare(
      `SELECT p.*, COALESCE(s.quantity, 0) AS stock_quantity,
              w.name AS workshop_name, 0 AS matched_exact
         FROM core_products p
         LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
         LEFT JOIN core_workshops w ON w.id = p.workshop_id AND w.company_id = p.company_id
        WHERE p.company_id = ? AND p.active = 1
          AND ${modeloAtivo('p')}
          AND NOT EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id)
          ${semKits}
          AND p.weighable = 1
          AND p.plu_code IS NOT NULL
          AND ltrim(trim(p.plu_code), '0') = ?
        LIMIT 2`,
    )
    .all(companyId, etiqueta.pluSemZeros) as Record<string, unknown>[];

  return linhas.map((linha) => {
    const achado = comPrecoVigente(companyId, linha);
    const unitario = Number(achado.effective_price_cents ?? 0);
    const balanca = config.valorEmbutido === 'peso'
      ? {
          codigo: term,
          plu: etiqueta.plu,
          tipo: 'peso' as const,
          quantidade: etiqueta.valor / 1000,
          precoTotalCents: null,
        }
      : {
          codigo: term,
          plu: etiqueta.plu,
          tipo: 'preco' as const,
          quantidade: unitario > 0 ? Math.round((etiqueta.valor / unitario) * 1000) / 1000 : null,
          precoTotalCents: etiqueta.valor,
        };
    return { ...achado, balanca };
  });
}

/**
 * O que impede a entrega, em SQL — uma definição só.
 *
 * A mesma condição vale na vitrine (`shippingReadiness`), na cotação e aqui.
 * Duplicar a regra faria a listagem do gestor discordar da loja sobre quais
 * produtos podem ser enviados.
 *
 * Só produto PUBLICADO entra: item interno sem medidas não é pendência, é
 * item que nunca vai ser enviado.
 */
const SEM_DADOS_DE_ENVIO = `
  p.active = 1 AND p.publish_online = 1
  AND (p.weight_grams IS NULL OR p.weight_grams <= 0
    OR p.height_cm IS NULL OR p.height_cm <= 0
    OR p.width_cm  IS NULL OR p.width_cm  <= 0
    OR p.length_cm IS NULL OR p.length_cm <= 0)`;

/** Quantos produtos publicados ainda não podem ser entregues, nesta operação. */
export function countProductsMissingShippingData(companyId: string): number {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT COUNT(*) AS total FROM core_products p
        WHERE p.company_id = ? AND ${SEM_DADOS_DE_ENVIO}`,
    )
    .get(companyId) as { total: number };
  return Number(linha.total);
}

/**
 * A LISTA DE CADASTRO — e por que a peça de bancada CONTINUA nela.
 *
 * Esta é a listagem de gestão, não a busca de venda: é dela que vivem a
 * etiqueta, a alteração rápida de preço, o inventário e a conferência de
 * estoque. Tirar a peça daqui seria o oposto do que se quer — a peça é
 * justamente o item que costuma nascer sem preço de venda (a importação de XML
 * cria com R$ 0,00 de propósito, para não inventar margem) e a tela de alteração
 * rápida é onde alguém conserta isso. Escondê-la deixaria a peça a zero para
 * sempre, e sem etiqueta na gaveta.
 *
 * Quem não pode receber peça é a VENDA, e a recusa mora em cada porta de venda:
 * `searchProducts` a tira da busca por texto do balcão, a vitrine não a lista
 * (`PRODUTO_VISIVEL_NA_LOJA`), a locação a recusa e o kit a recusa nos dois
 * sentidos. A linha devolvida aqui já carrega `kind` e `workshop_id` — vêm no
 * `p.*` —, então quem lista consegue marcar o que é peça sem consulta extra.
 */
export function listProducts(
  companyId: string,
  options: {
    search?: string;
    limit?: number;
    offset?: number;
    /**
     * Só os publicados que ainda não podem ser entregues.
     *
     * A regra é a MESMA da vitrine e da cotação — as quatro medidas maiores
     * que zero. Reescrevê-la aqui criaria duas verdades sobre o que é
     * "pronto para envio", e elas divergiriam na primeira mudança.
     */
    missingShippingData?: boolean;
    /** Ativos, inativos (arquivados) ou todos — ver `lerSituacaoDoCadastro`. */
    situacao?: SituacaoDoCadastro;
  } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const filtro = filtroDeProdutos(companyId, options);
  /*
    O `p.id` no fim da ordem é o que faz a página ser página: dois produtos com
    o MESMO nome (a importação de XML cria vários "CABO USB") trocariam de
    lugar entre uma consulta e outra, e um apareceria nas duas páginas enquanto
    o outro não apareceria em nenhuma.
  */
  const sql = `SELECT p.*, COALESCE(s.quantity, 0) AS stock_quantity
                 FROM core_products p
                 LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
                WHERE ${filtro.where}
                ORDER BY p.name, p.id LIMIT ? OFFSET ?`;
  // O teto vale aqui também, e não só na rota: `?limit=1000000` devolvia o
  // catálogo inteiro numa resposta só (GAP-PRD-070).
  const params = [
    ...filtro.params,
    limitarPagina(options.limit, 100),
    limitarDeslocamento(options.offset),
  ];
  return getConnection().prepare(sql).all(...(params as never[])) as unknown as Record<
    string,
    unknown
  >[];
}

/**
 * Quantos produtos o recorte de `listProducts` tem — sem o LIMIT.
 *
 * É o `total` da resposta: sem ele a tela desenhava os 100 primeiros como se
 * fossem o catálogo inteiro (GAP-PRD-070). O filtro é o MESMO da lista, para a
 * contagem nunca descrever outro universo.
 */
export function countProducts(
  companyId: string,
  options: { search?: string; missingShippingData?: boolean; situacao?: SituacaoDoCadastro } = {},
): number {
  ensureCoreSchema();
  const filtro = filtroDeProdutos(companyId, options);
  const linha = getConnection()
    .prepare(`SELECT COUNT(*) AS total FROM core_products p WHERE ${filtro.where}`)
    .get(...(filtro.params as never[])) as { total: number };
  return Number(linha.total);
}

/**
 * A SITUAÇÃO NO CADASTRO: ativos, inativos (arquivados) ou todos.
 *
 * `active = 0` é o arquivamento — a saída do produto que tem histórico e por
 * isso não pode ser excluído. A tela de Produtos mostra só os ativos por
 * padrão e oferece "mostrar inativos"; sem o filtro, o arquivado ficava
 * misturado ao catálogo vivo e parecia vendável.
 *
 * Valor desconhecido é "todos": é o que a rota sempre devolveu.
 */
export type SituacaoDoCadastro = 'ativos' | 'inativos' | 'todos';

export function lerSituacaoDoCadastro(valor: unknown): SituacaoDoCadastro {
  return valor === 'ativos' || valor === 'inativos' ? valor : 'todos';
}

/**
 * Há algum produto ATIVO nesta operação?
 *
 * É a diferença entre "nenhum produto encontrado" (procure de outro jeito) e
 * "nenhum produto cadastrado" (cadastre o primeiro) na busca do balcão.
 */
export function catalogoSemProdutoAtivo(companyId: string): boolean {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT 1 AS n FROM core_products WHERE company_id = ? AND active = 1 LIMIT 1')
    .get(companyId) as { n?: number } | undefined;
  return !linha?.n;
}

/** O WHERE da lista de cadastro — um só, para a lista e para a contagem. */
function filtroDeProdutos(
  companyId: string,
  options: { search?: string; missingShippingData?: boolean; situacao?: SituacaoDoCadastro },
): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let where = 'p.company_id = ?';
  if (options.situacao === 'ativos') where += ' AND p.active = 1';
  if (options.situacao === 'inativos') where += ' AND p.active = 0';
  if (options.search) {
    // Os códigos adicionais também respondem aqui: quem procura um produto na
    // tela de cadastro tem na mão a etiqueta que estiver no item, e ela pode
    // ser qualquer um dos códigos dele.
    where += ` AND (p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?
                  OR EXISTS (SELECT 1 FROM core_product_barcodes b
                              WHERE b.product_id = p.id AND b.barcode = ?))`;
    params.push(
      `%${options.search}%`,
      `%${options.search}%`,
      options.search,
      options.search,
    );
  }
  if (options.missingShippingData) {
    where += ` AND ${SEM_DADOS_DE_ENVIO}`;
  }
  return { where, params };
}

// ------------------------------------------------------------------ clientes

export interface CustomerInput {
  name: string;
  document?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  code?: string;
  /**
   * Por qual tabela de preço este cliente compra.
   *
   * Ausente ou nulo = preço normal, que é o que todo cliente já cadastrado
   * significa. Só o cadastro de balcão informa isto; os caminhos automáticos
   * (checkout da loja, espelhamento entre empresas) não passam nada — condição
   * de atacado é decisão de gente, não consequência de uma compra online.
   */
  priceTableId?: string | null;
}

/**
 * Só dígitos: CPF/CNPJ com e sem máscara é a MESMA pessoa.
 *
 * A regra já valia no fornecedor (`SupplierService.normalizeDocument`) e no
 * checkout (`findOrCreateCustomer`); o cadastro de balcão tinha ficado de
 * fora — gravava o documento CRU e comparava string com string, e a mesma
 * pessoa virava dois clientes com metade do histórico cada. Vazio vira nulo.
 */
function normalizarDocumento(value: unknown): string | null {
  const digitos = String(value ?? '').replace(/\D/g, '');
  return digitos === '' ? null : digitos;
}

/**
 * Dígitos verificadores do CPF — módulo 11, como manda a Receita.
 *
 * Espelho de `isValidCnpj` (FiscalConfigService), que já barrava CNPJ errado
 * na configuração fiscal. O CPF do cliente merece a mesma porta: o documento
 * gravado aqui desagua em `<CPF>` do XML da NFC-e (`FiscalXmlNfce`), e um
 * dígito trocado vira rejeição da SEFAZ na hora da venda — meses depois do
 * erro de digitação, com o cliente no balcão.
 */
export function isValidCpf(value: string | null | undefined): boolean {
  const cpf = (value ?? '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  // Todos os dígitos iguais fecham a conta e não são CPF.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const dv = (base: string, pesoInicial: number): string => {
    const soma = base
      .split('')
      .reduce((acc, digito, i) => acc + Number(digito) * (pesoInicial - i), 0);
    const resto = soma % 11;
    return resto < 2 ? '0' : String(11 - resto);
  };

  return cpf[9] === dv(cpf.slice(0, 9), 10) && cpf[10] === dv(cpf.slice(0, 10), 11);
}

/**
 * O documento do cliente, quando tem cara de CPF (11 dígitos) ou de CNPJ (14),
 * tem de fechar o módulo 11. Outras larguras passam sem conta: o campo também
 * guarda documento estrangeiro e registro antigo, e recusá-los barraria
 * cadastro legítimo por excesso de zelo.
 */
function exigirDocumentoValido(documento: string): void {
  if (documento.length === 11 && !isValidCpf(documento)) {
    throw new ApiError('CORE_INVALID_DOCUMENT', 'CPF inválido: os dígitos não conferem.', 400);
  }
  if (documento.length === 14 && !isValidCnpj(documento)) {
    throw new ApiError('CORE_INVALID_DOCUMENT', 'CNPJ inválido: os dígitos não conferem.', 400);
  }
}

/**
 * Quem já usa este documento nesta empresa?
 *
 * A comparação normaliza OS DOIS LADOS, não só o de quem chega: o banco tem
 * cadastro antigo gravado com máscara (desta rodada para trás ninguém
 * normalizava no INSERT), e comparar o documento limpo com a coluna crua
 * deixaria passar exatamente a duplicata que esta pergunta existe para
 * impedir. A varredura é em memória porque o SQLite não tira máscara sozinho —
 * e a lista de clientes de uma loja cabe nela com folga.
 */
function clientePorDocumento(
  companyId: string,
  documento: string,
  exceptId?: string,
): { id: string } | undefined {
  const linhas = getConnection()
    .prepare(
      'SELECT id, document FROM core_customers WHERE company_id = ? AND document IS NOT NULL',
    )
    .all(companyId) as { id: string; document: string }[];
  return linhas.find(
    (l) => l.id !== exceptId && String(l.document).replace(/\D/g, '') === documento,
  );
}

/**
 * A tabela existe, é desta empresa e está ativa?
 *
 * Vincular cliente a uma tabela de outra empresa vazaria a condição comercial
 * entre operações — e este banco tem duas, com CNPJ próprio. Vincular a uma
 * tabela DESATIVADA seria pior que inútil: `priceTableForCustomer` só enxerga
 * tabela ativa, então o vínculo existiria no banco e não teria efeito nenhum no
 * preço. O cadastro mostraria "Atacado -15%" e o cupom sairia cheio.
 */
function tabelaDePrecoValida(companyId: string, priceTableId: string): void {
  const existe = getConnection()
    .prepare(
      'SELECT 1 AS n FROM core_price_tables WHERE id = ? AND company_id = ? AND active = 1',
    )
    .get(priceTableId, companyId) as { n?: number } | undefined;
  if (!existe?.n) {
    throw new ApiError(
      'CORE_PRICE_TABLE_NOT_FOUND',
      'Tabela de preço não encontrada ou desativada.',
      404,
      { priceTableId },
    );
  }
}

/**
 * Trocar (ou tirar) a tabela de preço de um cliente que já existe.
 *
 * Fica separado do cadastro porque é a operação que MUDA DINHEIRO: a partir da
 * próxima venda, este cliente passa a pagar outro preço. Uma rota própria dá
 * a essa decisão um registro de auditoria próprio, em vez de escondê-la num
 * "salvar cliente" junto com a correção de um telefone.
 *
 * `null` remove o vínculo e devolve o cliente ao preço normal — e é preciso
 * que remover seja possível, senão a única saída para desfazer um vínculo
 * errado seria apagar o cliente.
 */
export function setCustomerPriceTable(
  companyId: string,
  customerId: string,
  priceTableId: string | null,
): Record<string, unknown> {
  ensureCoreSchema();
  const cliente = getCustomer(companyId, customerId);
  if (!cliente) {
    throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
  }
  if (priceTableId) tabelaDePrecoValida(companyId, priceTableId);
  getConnection()
    .prepare(
      'UPDATE core_customers SET price_table_id = ?, updated_at = ? WHERE id = ? AND company_id = ?',
    )
    .run(priceTableId, new Date().toISOString(), customerId, companyId);
  return getCustomer(companyId, customerId)!;
}

export function createCustomer(companyId: string, input: CustomerInput): Record<string, unknown> {
  ensureCoreSchema();
  // Transacional porque o cadastro e o evento para a central precisam existir
  // ou desaparecer juntos — a trava do outbox recusa qualquer outra coisa.
  return withTransaction(() => criarCliente(companyId, input));
}

function criarCliente(companyId: string, input: CustomerInput): Record<string, unknown> {
  if (!input.name?.trim()) {
    throw new ApiError('CORE_INVALID_PAYLOAD', 'Nome do cliente é obrigatório.', 400);
  }
  const db = getConnection();
  // Só dígitos no INSERT e no dedupe, como o checkout já fazia. É a coluna
  // crua que `FiscalXmlNfce` escreve em `<CPF>` do XML: máscara gravada seria
  // rejeição da SEFAZ mesmo com o dedupe certo.
  const documento = normalizarDocumento(input.document);
  if (documento) {
    exigirDocumentoValido(documento);
    if (clientePorDocumento(companyId, documento)) {
      throw new ApiError('CORE_DUPLICATE_DOCUMENT', 'Já existe cliente com este CPF/CNPJ.', 409);
    }
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  // A tabela é conferida ANTES do INSERT: um id inventado gravado aqui viraria
  // um vínculo que não resolve, e o cliente pagaria preço cheio enquanto o
  // cadastro jura que ele é revendedor.
  if (input.priceTableId) tabelaDePrecoValida(companyId, input.priceTableId);
  // 'balcao': quem cadastra aqui é gente da loja, com a pessoa na frente — é o
  // documento que o portal aceita como prova entre operações (GAP-PRD-006).
  db.prepare(
    `INSERT INTO core_customers
       (id, company_id, code, name, document, email, phone, address, notes, active,
        price_table_id, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'balcao', ?, ?)`,
  ).run(
    id,
    companyId,
    input.code ?? null,
    input.name.trim(),
    documento,
    input.email ?? null,
    input.phone ?? null,
    input.address ?? null,
    input.notes ?? null,
    input.priceTableId ?? null,
    now,
    now,
  );
  const cliente = getCustomer(companyId, id)!;
  recordDomainEvent({
    eventType: 'customer.upserted',
    aggregateType: 'customer',
    aggregateId: id,
    companyId,
    payload: cliente,
  });
  return cliente;
}

/**
 * Os campos que a edição do cadastro alcança.
 *
 * A tabela de preço fica de fora DE PROPÓSITO: trocar condição comercial é
 * `setCustomerPriceTable`, com rota, perfil e auditoria próprios — a doutrina
 * está escrita lá. E `companyId` nunca entra aqui: vem do vínculo da sessão,
 * como em todo o resto deste arquivo.
 */
export interface CustomerUpdateInput {
  name?: string;
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  /**
   * `false` tira o cliente de circulação. `listCustomers` sempre filtrou
   * `active = 1` — o reflexo no balcão estava pronto, esperando um escritor.
   */
  active?: boolean;
}

export function updateCustomer(
  companyId: string,
  customerId: string,
  input: CustomerUpdateInput,
): Record<string, unknown> {
  ensureCoreSchema();
  // Transacional pela mesma razão do createCustomer: o cadastro alterado e o
  // fato para a central existem ou desaparecem juntos.
  return withTransaction(() => atualizarCliente(companyId, customerId, input));
}

/**
 * A METADE QUE FALTAVA DO CICLO: o cadastro de cliente era write-once.
 *
 * Telefone digitado errado era eterno — não havia rota nem função de edição, e
 * a coluna `active` tinha leitor e nenhum escritor. Esta função fecha o ciclo:
 * corrige contato, troca documento e inativa/reativa.
 *
 * O documento passa pela MESMA porta da criação — dígitos, verificador e
 * dedupe. Sem isso o PUT seria o contorno do POST: o CPF inválido recusado no
 * cadastro entraria pela correção.
 *
 * Campo AUSENTE preserva o que estava; enviado vazio ou nulo LIMPA (menos o
 * nome, que é obrigatório sempre). A distinção importa: quem corrige um
 * telefone não pode apagar o e-mail sem querer, e quem descobre que o e-mail
 * era de outra pessoa precisa poder apagá-lo.
 */
function atualizarCliente(
  companyId: string,
  customerId: string,
  input: CustomerUpdateInput,
): Record<string, unknown> {
  const atual = getCustomer(companyId, customerId);
  if (!atual) throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
  if (input.name !== undefined && !String(input.name ?? '').trim()) {
    throw new ApiError('CORE_INVALID_PAYLOAD', 'Nome do cliente é obrigatório.', 400);
  }

  // Ausente preserva o valor gravado CRU, como estiver: normalizar um campo
  // que ninguém tocou mexeria em dado sem pedido. Enviado, entra só dígitos.
  const documento =
    input.document === undefined
      ? ((atual.document as string | null) ?? null)
      : normalizarDocumento(input.document);
  if (input.document !== undefined && documento) {
    exigirDocumentoValido(documento);
    // O dono atual fica fora da pergunta: reenviar o próprio documento — o
    // formulário manda a ficha inteira — não é duplicata.
    if (clientePorDocumento(companyId, documento, customerId)) {
      throw new ApiError('CORE_DUPLICATE_DOCUMENT', 'Já existe cliente com este CPF/CNPJ.', 409);
    }
  }

  const contato = (valor: string | null | undefined, gravado: unknown): string | null =>
    valor === undefined
      ? ((gravado as string | null) ?? null)
      : String(valor ?? '').trim() || null;

  const campos: Record<string, unknown> = {
    name: input.name === undefined ? atual.name : String(input.name).trim(),
    document: documento,
    email: contato(input.email, atual.email),
    phone: contato(input.phone, atual.phone),
    address: contato(input.address, atual.address),
    notes: contato(input.notes, atual.notes),
    active: input.active === undefined ? atual.active : input.active ? 1 : 0,
  };

  // Colunas montadas das CHAVES de `campos`, como no produto: lista escrita à
  // mão sai de ordem no primeiro campo novo e grava valor na coluna errada.
  const colunas = Object.keys(campos);
  getConnection()
    .prepare(
      `UPDATE core_customers SET ${colunas.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    )
    .run(
      ...(Object.values(campos) as never[]),
      new Date().toISOString(),
      customerId,
      companyId,
    );

  const cliente = getCustomer(companyId, customerId)!;
  // Cadastro não se apaga: cliente de venda antiga precisa continuar existindo
  // na central para a nota e o histórico fazerem sentido. Inativar viaja como
  // atualização do mesmo agregado — a projeção regrava a linha inteira.
  recordDomainEvent({
    eventType: 'customer.upserted',
    aggregateType: 'customer',
    aggregateId: customerId,
    companyId,
    operation: 'update',
    payload: cliente,
  });
  return cliente;
}

/**
 * Por qual dado o cadastro que já existe é RECONHECIDO.
 *
 * `document_or_email` é o critério histórico do checkout: o documento manda e o
 * e-mail é segunda chance, para quem comprou sem informar CPF. É o padrão
 * porque é o que todo chamador anterior a esta opção esperava.
 *
 * `document` é o critério de quem está ESPELHANDO uma pessoa de uma empresa
 * para outra. Ver a doutrina inteira em `CustomerPortalService.syncLinks`,
 * escrita na rodada 17.
 */
export type CustomerMatchBy = 'document_or_email' | 'document';

/**
 * De onde veio o cadastro criado por `findOrCreateCustomer` (GAP-PRD-006).
 * 'loja_online': o checkout público, com o CPF que alguém digitou. O balcão
 * (`createCustomer`) grava 'balcao' sozinho e não passa por aqui.
 */
export type CustomerOrigin = 'loja_online';

/**
 * Cliente do pedido: acha o que já existe, ou cria.
 *
 * `createCustomer` recusa CPF repetido, e faz bem: no balcão, cadastrar duas
 * vezes a mesma pessoa é erro de digitação. No checkout é o contrário — o
 * cliente que já comprou mês passado vai comprar de novo, e recusar seria
 * barrar a venda.
 *
 * O cliente é DA OPERAÇÃO. Mesmo CPF na Gringa e no Preço Justo são dois
 * cadastros, porque são duas empresas com CNPJ próprio; unificar criaria um
 * cadastro que nenhuma das duas controla.
 *
 * Cadastro achado NÃO é reescrito (GAP-PRD-006): nem o contato que chega vazio
 * apaga o que estava, nem o contato que chega preenchido troca o que estava —
 * quem chama esta função não sabe quem digitou o CPF. Ver o bloco `existente`.
 *
 * ## `matchBy: 'document'` — O MESMO CRITÉRIO DA RODADA 17, PELO MESMO MOTIVO
 *
 * A queda para e-mail é generosa no checkout e é SEQUESTRO quando quem chama
 * está espelhando uma pessoa em OUTRA empresa. `syncLinks` já passou por isto
 * (`CustomerPortalService.ts`, rodada 17): a regra era `email = ? OR document =
 * ?`, e nada impede que o meu cadastro carregue o e-mail de outra pessoa —
 * basta tê-lo informado num balcão. O `OR` casava o cadastro DELA, e eu passava
 * a ler o histórico dela.
 *
 * Aqui é pior, porque esta função ESCREVE: ao casar por e-mail ela grava
 * `document = COALESCE(document, ?)`, carimbando o CPF do comprador no cadastro
 * do estranho — e quem espelha em seguida aponta `owner_customer_id` para essa
 * pessoa, que passa a ver a moto e o histórico dela no portal.
 *
 * Com `matchBy: 'document'`, quem identifica é o DOCUMENTO e mais nada. Sem
 * documento não há como afirmar que duas linhas são a mesma pessoa: a função
 * NÃO casa e NÃO cria — devolve `null`, e quem chamou decide o que registrar
 * sobre esse desconhecimento. Inventar um cadastro por e-mail seria repetir,
 * por outro caminho, o defeito que a rodada 17 consertou.
 */
export function findOrCreateCustomer(
  companyId: string,
  input: CustomerInput,
  options?: { matchBy?: 'document_or_email'; origin?: CustomerOrigin },
): Record<string, unknown>;
export function findOrCreateCustomer(
  companyId: string,
  input: CustomerInput,
  options: { matchBy: 'document'; origin?: CustomerOrigin },
): Record<string, unknown> | null;
export function findOrCreateCustomer(
  companyId: string,
  input: CustomerInput,
  options: { matchBy?: CustomerMatchBy; origin?: CustomerOrigin } = {},
): Record<string, unknown> | null {
  ensureCoreSchema();
  if (!input.name?.trim()) {
    throw new ApiError('CORE_INVALID_PAYLOAD', 'Nome do cliente é obrigatório.', 400);
  }
  const db = getConnection();
  const documento = input.document?.replace(/\D/g, '') || null;
  const soPorDocumento = options.matchBy === 'document';

  // Sem documento, quem pediu identidade por documento não recebe um palpite.
  // Devolver `null` é a resposta honesta: não dá para dizer QUEM é esta pessoa.
  if (soPorDocumento && !documento) return null;

  // O documento identifica a pessoa. E-mail é segunda chance, para quem
  // comprou sem informar CPF — e só para quem aceitou essa segunda chance.
  const existente = (documento
    ? (db
        .prepare('SELECT * FROM core_customers WHERE company_id = ? AND document = ?')
        .get(companyId, documento) as Record<string, unknown> | undefined)
    : undefined)
    ?? (!soPorDocumento && input.email
      ? (db
          .prepare(
            'SELECT * FROM core_customers WHERE company_id = ? AND email = ? AND document IS NULL',
          )
          .get(companyId, input.email.trim()) as Record<string, unknown> | undefined)
      : undefined);

  if (existente) {
    /*
      CADASTRO QUE JÁ EXISTE NÃO É REESCRITO POR QUEM ACHOU O CPF (GAP-PRD-006).

      Aqui era `email = COALESCE(?, email)`, e o mesmo para telefone e
      endereço: o contato NOVO ganhava do antigo. Os dois chamadores desta
      função são automáticos — o checkout PÚBLICO da loja e o espelho do
      equipamento vendido online —, e nenhum dos dois sabe quem digitou o CPF.
      Quem soubesse o CPF de outra pessoa trocava o e-mail do cadastro dela
      pelo próprio, passava a receber os e-mails dela e ainda FABRICAVA a
      co-prova (e-mail + documento no mesmo cadastro) que o portal usava para
      entregar o histórico de compras.

      Nem "só preencher o vazio" serve: o cadastro de balcão costuma nascer sem
      e-mail, e preenchê-lo com o e-mail de quem digitou o CPF é a mesma
      co-prova fabricada. O pedido guarda a CÓPIA do que foi digitado nele
      (`core_orders.customer_*`, endereço de entrega); o cadastro só muda por
      quem tem autoridade sobre ele — o balcão, ou o dono logado na conta.

      Resta o carimbo do DOCUMENTO no cadastro que casou pelo e-mail, no modo
      padrão — cadastro sem documento nenhum, que o comprador sem CPF criou.
    */
    if (documento && !normalizarDocumento(existente.document)) {
      db.prepare(
        `UPDATE core_customers SET document = ?, updated_at = ?
          WHERE id = ? AND (document IS NULL OR TRIM(document) = '')`,
      ).run(documento, new Date().toISOString(), String(existente.id));
    }
    return getCustomer(companyId, String(existente.id))!;
  }

  const id = randomUUID();
  const agora = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_customers
       (id, company_id, code, name, document, email, phone, address, notes, active, origin,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    companyId,
    input.code ?? null,
    input.name.trim(),
    documento,
    input.email?.trim() || null,
    input.phone?.trim() || null,
    input.address?.trim() || null,
    input.notes ?? null,
    // Quem chama diz de onde veio o dado; sem dizer, fica nulo — e nulo NÃO
    // é prova de documento para o portal (GAP-PRD-006).
    options.origin ?? null,
    agora,
    agora,
  );
  return getCustomer(companyId, id)!;
}

/**
 * O convite do portal é CREDENCIAL, e não sai em resposta nenhuma (GAP-PRD-073).
 *
 * Guarda-se o SHA-256 justamente para um vazamento do arquivo não virar
 * acesso — e o `SELECT *` do cadastro o entregava a todo perfil que lia um
 * cliente. Quem precisa das três colunas (`EquipmentPortalService`) as lê
 * com consulta própria; a leitura de cadastro as tira aqui, na fonte, para
 * valer em toda rota que devolva um cliente.
 */
export const COLUNAS_DO_CONVITE = ['portal_invite_hash', 'portal_invite_expires_at', 'portal_invite_used_at'] as const;

export function semSegredoDoConvite(linha: Record<string, unknown>): Record<string, unknown> {
  const limpa = { ...linha };
  for (const coluna of COLUNAS_DO_CONVITE) delete limpa[coluna];
  return limpa;
}

export function getCustomer(companyId: string, customerId: string): Record<string, unknown> | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_customers WHERE id = ? AND company_id = ?')
    .get(customerId, companyId) as Record<string, unknown> | undefined;
  return row ? semSegredoDoConvite(row) : null;
}

/**
 * Clientes ativos, em ordem de nome.
 *
 * O `limit` daqui NÃO tem teto, de propósito: a busca do balcão
 * (`GET /customers` com termo) varre a lista inteira de ativos em memória para
 * tirar a máscara dos dois lados, e pede com um limite enorme. O teto de página
 * da API mora na ROTA (`lerPagina`), que é a porta de fora (GAP-PRD-070).
 */
export function listCustomers(
  companyId: string,
  options: { search?: string; limit?: number; offset?: number } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const filtro = filtroDeClientes(companyId, options.search);
  // `id` desempata homônimos — sem ele, dois "José da Silva" trocariam de
  // página entre uma consulta e outra.
  const sql = `SELECT * FROM core_customers WHERE ${filtro.where} ORDER BY name, id LIMIT ? OFFSET ?`;
  const params = [...filtro.params, options.limit ?? 100, limitarDeslocamento(options.offset)];
  const linhas = getConnection().prepare(sql).all(...(params as never[])) as unknown as Record<
    string,
    unknown
  >[];
  return linhas.map(semSegredoDoConvite);
}

/** Quantos clientes ativos o recorte de `listCustomers` tem — o `total` da página. */
export function countCustomers(companyId: string, search?: string): number {
  ensureCoreSchema();
  const filtro = filtroDeClientes(companyId, search);
  const linha = getConnection()
    .prepare(`SELECT COUNT(*) AS total FROM core_customers WHERE ${filtro.where}`)
    .get(...(filtro.params as never[])) as { total: number };
  return Number(linha.total);
}

function filtroDeClientes(companyId: string, search?: string): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let where = 'company_id = ? AND active = 1';
  if (search) {
    where += ' AND (name LIKE ? OR document LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  return { where, params };
}

/**
 * Um AVISO: o produto vende online, mas falta algo que a loja deveria ter.
 *
 * `sem_foto` era impedimento e virou aviso (GAP-PRD-207): o PUT do produto
 * publica sem foto, a vitrine mostra o "Foto em breve" de propósito, e a foto
 * só pode subir depois que o produto existe. Chamar de bloqueio o que está
 * vendendo era a segunda verdade sobre o mesmo produto.
 */
export type OnlineWarning = 'sem_foto';

/** Um impedimento concreto para o produto ser vendido online. */
export type OnlineBlocker =
  | 'sem_preco'
  | 'sem_medidas'
  | 'sem_saldo'
  | 'nao_publicado'
  | 'inativo'
  | 'modelo_com_grade';

export interface OnlineReadinessRow {
  id: string;
  name: string;
  internalCode: string;
  priceCents: number;
  publishOnline: boolean;
  blockers: OnlineBlocker[];
  /** O que falta sem impedir a venda — hoje, a foto. */
  warnings: OnlineWarning[];
  /** Pronto para vender: sem impedimento nenhum (aviso não impede). */
  ready: boolean;
  /** Só falta publicar — o resto está no lugar. */
  readyToPublish: boolean;
}

/**
 * O que falta em cada produto para ele ser vendido na loja online.
 *
 * POR QUE ESTA FUNÇÃO EXISTE
 *
 * "Publique tudo" não é um botão possível: dos produtos reais, nenhum tinha
 * foto e nenhum tinha peso e dimensões. Publicar assim colocaria na vitrine um
 * item sem imagem, que o cliente não compra, e sem medidas, que o frete não
 * consegue cotar — a loja pareceria quebrada.
 *
 * Foto, peso, medida, preço e saldo são dados do DONO. O sistema não os
 * inventa; o que ele pode fazer é dizer exatamente o que falta, produto por
 * produto, para a lista virar uma tarefa em vez de um mistério.
 *
 * A regra de medidas é a MESMA de `SEM_DADOS_DE_ENVIO`, usada na vitrine e na
 * cotação. Duplicar faria as três telas discordarem.
 *
 * PEÇA DE OFICINA FICA DE FORA — e não é cosmética.
 *
 * Peça não vai para a loja online por invariante, então listá-la aqui seria
 * cobrar foto e medidas de um item que nunca vai ser publicado: pendência falsa
 * numa tela que existe para virar tarefa. Pior, `publishReadyProducts` publica
 * TUDO que sai daqui pronto — uma peça com preço, foto, medidas e saldo entraria
 * no lote e a publicação em massa inteira morreria na recusa
 * `CORE_PART_CANNOT_BE_PUBLISHED`, levando junto os produtos de loja que iam
 * publicar bem.
 */
export function listOnlineReadiness(companyId: string): OnlineReadinessRow[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT p.id, p.name, p.internal_code, p.price_cents, p.publish_online, p.active,
              p.weight_grams, p.height_cm, p.width_cm, p.length_cm,
              COALESCE(s.quantity, 0) AS saldo,
              (SELECT COUNT(*) FROM core_product_images i WHERE i.product_id = p.id) AS fotos,
              (SELECT COUNT(*) FROM core_products f WHERE f.parent_id = p.id) AS filhos
         FROM core_products p
         LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
        WHERE p.company_id = ? AND p.kind <> 'part'
        ORDER BY p.name`,
    )
    .all(companyId) as unknown as Record<string, unknown>[];

  return linhas.map((l) => {
    const blockers: OnlineBlocker[] = [];
    const warnings: OnlineWarning[] = [];

    if (!Number(l.active)) blockers.push('inativo');
    // Modelo com grade não é vendável: quem vai para a vitrine são as
    // variantes, cada uma com saldo e código próprios.
    if (Number(l.filhos) > 0) blockers.push('modelo_com_grade');
    if (!Number(l.price_cents)) blockers.push('sem_preco');
    // Sem foto vende (a vitrine mostra "Foto em breve"): é aviso, não
    // impedimento — a mesma régua do PUT e da vitrine (GAP-PRD-207).
    if (!Number(l.fotos)) warnings.push('sem_foto');
    if (
      !Number(l.weight_grams)
      || !Number(l.height_cm)
      || !Number(l.width_cm)
      || !Number(l.length_cm)
    ) {
      blockers.push('sem_medidas');
    }
    if (Number(l.saldo) <= 0) blockers.push('sem_saldo');

    const publicado = Boolean(Number(l.publish_online));
    if (!publicado) blockers.push('nao_publicado');

    // "Pronto para publicar" ignora a própria falta de publicação: é o que a
    // ação em massa consegue resolver sozinha.
    const semContarPublicacao = blockers.filter((b) => b !== 'nao_publicado');

    return {
      id: String(l.id),
      name: String(l.name),
      internalCode: String(l.internal_code ?? ''),
      priceCents: Number(l.price_cents ?? 0),
      publishOnline: publicado,
      blockers,
      warnings,
      ready: blockers.length === 0,
      readyToPublish: !publicado && semContarPublicacao.length === 0,
    };
  });
}

/**
 * Publica de uma vez os produtos que já estão prontos.
 *
 * Só entra o que passou por `listOnlineReadiness` sem nenhum impedimento além
 * da própria publicação. Sem medida o frete não cota: é impedimento.
 *
 * SEM FOTO É AVISO, E A DECISÃO EM MASSA É DO GESTOR (GAP-PRD-207). O produto
 * sem foto vende (a vitrine mostra "Foto em breve") e o PUT de um produto o
 * publica. Mas publicar em lote é decidir por muitos de uma vez: os sem foto
 * só entram quando o pedido diz `incluirSemFoto`, e a resposta conta quantos
 * ficaram esperando essa decisão (`semFoto`).
 */
export function publishReadyProducts(
  companyId: string,
  opcoes: { incluirSemFoto?: boolean } = {},
): { published: string[]; skipped: number; semFoto: number } {
  const linhas = listOnlineReadiness(companyId);
  const prontos = linhas.filter((l) => l.readyToPublish);
  const escolhidos = opcoes.incluirSemFoto
    ? prontos
    : prontos.filter((l) => !l.warnings.includes('sem_foto'));
  const escolhidosIds = new Set(escolhidos.map((p) => p.id));

  return withTransaction(() => {
    for (const produto of escolhidos) {
      updateProduct(companyId, produto.id, { name: produto.name, publishOnline: true });
    }
    return {
      published: escolhidos.map((p) => p.id),
      skipped: linhas.filter((l) => !l.publishOnline && !escolhidosIds.has(l.id)).length,
      semFoto: prontos.length - escolhidos.length,
    };
  });
}
