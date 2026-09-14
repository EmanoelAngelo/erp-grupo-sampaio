/**
 * O TIPO DO PRODUTO — mercadoria de revenda ou peça de bancada.
 *
 * A COLUNA EXISTIA E NÃO TINHA DONO
 *
 * `core_products.kind` e `core_products.workshop_id` estão no schema desde a
 * rodada que criou a oficina, e `WorkshopPartsService` sabe lê-los. O que não
 * existia era um lugar que os ESCREVESSE com regra: `createProduct` gravava o
 * que viesse no corpo, `atualizarProduto` simplesmente ignorava os dois campos
 * (um PUT com `kind: "part"` devolvia 200 e não mudava nada), `generateVariants`
 * copiava do pai por INSERT cru e o clone repassava sem conferir.
 *
 * O resultado, medido no banco real: dezenove produtos, todos `retail`, nenhum
 * com oficina. E a recusa `CORE_PART_OTHER_WORKSHOP`, que existe em `addPart`
 * para impedir a bancada de celulares de consumir peça da bancada de
 * mobilidade, comparava um campo que nunca era preenchido — um guarda vigiando
 * uma porta que ninguém conseguia abrir.
 *
 * POR QUE A DOUTRINA MORA AQUI, E NÃO EM CADA ESCRITOR
 *
 * São QUATRO escritores do par (`kind`, `workshop_id`): o cadastro novo, a
 * alteração, a geração de grade e o clone. Espalhar a regra por eles significa,
 * na prática, ter a regra em um e o contorno nos outros três: bastaria clonar
 * um kit para ter uma peça-kit, ou gerar grade de uma peça para ter meia dúzia
 * de peças sem oficina. `exigirTipoCoerente` é o invariante em UM lugar, e todo
 * escritor passa por ele.
 *
 * E CONVERTER TEM UMA PORTA SÓ
 *
 * O invariante impede o estado incoerente, não a porta larga. `atualizarProduto`
 * NÃO converte: um PUT com `kind` ou `workshopId` diferente do que está gravado
 * é recusado com `CORE_PRODUCT_KIND_BY_ROUTE` apontando para cá. O motivo é
 * permissão e rastro, não coerência — a rota do cadastro é aberta também aos
 * dois `operador_caixa_*`, que `POST /products/:id/tipo` recusa, e o que passa
 * por ela não conta os `efeitos` nem grava auditoria. Corrigir preço é trabalho
 * de balcão; tirar um item da vitrine e mudar o dono do saldo, não.
 *
 * O QUE UMA PEÇA NÃO PODE SER — e por que cada recusa existe
 *
 *   SEM BANCADA        `listParts` filtra por `workshop_id`. Peça sem oficina
 *                      não aparece em bancada nenhuma: some do sistema inteiro
 *                      sem nenhum erro, porque a vitrine também não a mostra.
 *   DE OUTRA EMPRESA   o saldo é por empresa. Apontar a peça do Preço Justo
 *                      para a Oficina faria uma baixa de estoque atravessar
 *                      CNPJ.
 *   EM BANCADA SEM     `capabilitiesFor` diz o que cada oficina faz. Bancada
 *   ESTOQUE DE PEÇAS   sem `parts` não tem onde guardar nem quem requisite.
 *   KIT                a venda de kit desmembra em componentes e dá baixa em
 *                      cada um. Peça não é vendida no balcão: é REQUISITADA
 *                      numa OS, e a baixa vem por outro caminho.
 *   COMPONENTE DE KIT  o inverso do anterior. O kit continuaria explodindo em
 *                      cima de um item que saiu do catálogo de venda.
 *   PESÁVEL / COM PLU  o PLU é o número pelo qual a BALANÇA acha o produto, e
 *                      o arquivo da balança é do caixa da loja. Uma peça na
 *                      balança é um item que o caixa consegue vender por peso.
 *                      Aqui se RECUSA, não se limpa: apagar o PLU calado
 *                      tiraria da balança um item que alguém pôs lá de
 *                      propósito, e a pessoa só descobriria no dia em que a
 *                      balança não achasse mais o produto.
 *   COM GRADE          grade é coisa de mercadoria: tamanho e cor de roupa.
 *                      Cada variante é um produto com pai, e uma grade de peças
 *                      criaria filhos cuja oficina ninguém escolheu.
 *   PUBLICADA          a vitrine vende ao consumidor. Peça de bancada tem preço
 *                      de reposição, não tem foto, e não é o que a loja vende.
 *
 * A VOLTA TEM DE EXISTIR
 *
 * Conversão que só vai numa direção transforma um clique errado em cadastro
 * perdido. `converterParaRevenda` desfaz — e conta o que desfaz, porque o saldo
 * que estava na gaveta da bancada passa a ser saldo de loja no mesmo instante.
 *
 * SOBRE O SALDO: NÃO EXISTE DUAS GAVETAS
 *
 * `core_stock` tem uma linha por (empresa, produto) — não por oficina. O que a
 * conversão muda não é ONDE a quantidade está, é QUEM a conta: como peça, o
 * saldo aparece na tela da bancada (`listParts`); como mercadoria, na busca do
 * PDV e no estoque da loja. Por isso `efeitos.saldoQueMudaDeLado` é um AVISO e
 * não um movimento: nada entra e nada sai do razão, e inventar um movimento
 * aqui criaria estoque que ninguém comprou.
 *
 * E O QUE MUDA DE LADO NÃO É TODO LIVRE
 *
 * O número que muda de lado é o saldo BRUTO — `core_stock.quantity` —, porque é
 * ele que passa a ser contado do outro lado por inteiro. Mas parte dele pode
 * estar prometida: `core_stock.reserved` tem QUATRO origens — OS aberta da
 * oficina (rodada 55), pedido da loja online, pré-venda e contrato de locação —
 * e `addPart` recusa a peça olhando o DISPONÍVEL, que é bruto menos reservado.
 *
 * A lista dizia "orçamento" e estava errada desde sempre: orçamento é papel e
 * não reserva nada; quem reserva é a PRÉ-VENDA.
 *
 * Um aviso que dissesse só "12 passam a ser contadas na gaveta" prometeria à
 * bancada uma dúzia que o lançamento da OS recusaria — e a pessoa descobriria
 * a diferença com o aparelho aberto na mesa. Por isso o efeito carrega os DOIS
 * números, e o nome do campo diz o que ele é: `saldoQueMudaDeLado`, não "saldo
 * na gaveta".
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { capabilitiesFor } from './WorkshopCapabilities.js';

/**
 * O que a conversão MUDA, além do tipo.
 *
 * Existe para a TELA CONTAR — cada campo é uma frase que a pessoa precisa ler
 * antes de confirmar, e nenhum deles é dedutível do produto que volta na
 * resposta. Sem isto a conversão seria silenciosa: o produto sairia da vitrine,
 * perderia o destaque e mudaria de dono do saldo, e a tela só mostraria um
 * "salvo com sucesso".
 */
export interface EfeitosDaConversao {
  /** Estava na vitrine e saiu. Peça não é vendida ao consumidor. */
  despublicadoDaLoja: boolean;
  /** Estava na régua de destaques da home e saiu junto com a publicação. */
  destaqueRemovido: boolean;
  /**
   * Quantidade que muda de lado agora: sai da contagem da loja e passa a ser
   * contada na bancada (ou o contrário, na volta). Não é movimento de estoque.
   *
   * É o saldo BRUTO, e o nome diz isso de propósito. Chamava-se `saldoNaGaveta`
   * e prometia à bancada uma quantidade livre que ela pode não ter.
   */
  saldoQueMudaDeLado: number;
  /**
   * Quanto desse saldo já está prometido a outro compromisso.
   *
   * Três origens: pedido da loja online, orçamento aberto e contrato de
   * locação. Vai junto porque é a diferença entre o número que muda de lado e o
   * número que a OS consegue consumir — `addPart` cobra o disponível, e sem
   * este campo o aviso da conversão mentiria por omissão.
   */
  reservadoEmAberto: number;
  /** Quantas vezes o produto já saiu em venda de balcão. Histórico não some. */
  vendasAnteriores: number;
  /**
   * Preço de venda zerado.
   *
   * É a ponta mais cara desta corrente: `addPart` cobra `price_cents`, e uma
   * peça a zero entra na OS por R$ 0,00 — a loja dá a peça de graça e o
   * fechamento nem reclama, porque a recusa `CORE_HAS_PARTS_COST` só dispara
   * com total maior que zero. Produto criado por importação de XML nasce
   * exatamente assim, de propósito ("não inventamos margem").
   */
  semPrecoDeVenda: boolean;
}

/**
 * A LINHA DO PRODUTO NÃO VOLTA AQUI.
 *
 * `product` existia com a linha inteira de `core_products` dentro, e atravessava
 * serviço, rota e cliente sem que nenhuma tela lesse um campo sequer: as duas
 * que chamam a conversão (o cadastro do produto e a entrada de notas) releem o
 * produto pelo caminho normal logo depois, porque precisam do resto do cadastro
 * junto. Era o defeito que esta rodada existe para não repetir — escritor sem
 * leitor —, e no pior formato: um `Record<string, unknown>` que carregava
 * inclusive o custo para quem pediu a conversão.
 */
export interface ResultadoDoTipo {
  kind: string;
  workshopId: string | null;
  workshopName: string | null;
  efeitos: EfeitosDaConversao;
  /** Uma frase pronta com o que aconteceu, ou nulo quando nada mudou de fato. */
  aviso: string | null;
}

interface LinhaDeProduto {
  id: string;
  name: string;
  kind: string | null;
  workshop_id: string | null;
  publish_online: number;
  featured_online: number;
  price_cents: number;
  weighable: number;
  plu_code: string | null;
  is_kit: number;
}

// `parent_id` saiu daqui junto com a recusa de grade: quem confere a grade agora
// é `exigirQueNaoTenhaGrade`, que consulta o pai e os filhos por conta própria.
const CAMPOS_DO_TIPO = `id, name, kind, workshop_id, publish_online, featured_online,
   price_cents, weighable, plu_code, is_kit`;

function carregarProduto(companyId: string, productId: string): LinhaDeProduto {
  const linha = getConnection()
    .prepare(
      `SELECT ${CAMPOS_DO_TIPO} FROM core_products WHERE id = ? AND company_id = ?`,
    )
    .get(productId, companyId) as LinhaDeProduto | undefined;
  if (!linha) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
  return linha;
}

/** Nome da bancada, para a tela dizer QUAL oficina — "a oficina" não basta. */
function nomeDaBancada(workshopId: string | null): string | null {
  if (!workshopId) return null;
  const linha = getConnection()
    .prepare('SELECT name FROM core_workshops WHERE id = ?')
    .get(workshopId) as { name: string } | undefined;
  return linha?.name ?? null;
}

/** O produto é componente de algum kit desta empresa? */
function ehComponenteDeKit(companyId: string, productId: string): boolean {
  const linha = getConnection()
    .prepare(
      `SELECT k.name AS nome
         FROM core_kit_components c
         JOIN core_products k ON k.id = c.kit_id
        WHERE c.company_id = ? AND c.component_id = ?
        LIMIT 1`,
    )
    .get(companyId, productId) as { nome: string } | undefined;
  return Boolean(linha);
}

/**
 * GRADE E PEÇA NÃO CONVIVEM — nos dois papéis, e para TODO chamador.
 *
 * Esta recusa morava dentro de `converterParaPeca`, e por isso valia só para a
 * rota de conversão: quem chegasse pelo cadastro passava por cima dela e
 * produzia justamente o estado que `CORE_PART_CANNOT_HAVE_VARIANTS` existe para
 * impedir — um modelo de grade virado peça com seis variantes de loja
 * penduradas nele, ou uma variante virada peça cujo modelo continua sendo
 * mercadoria. Meia grade na bancada, meia na vitrine.
 *
 * Aqui dentro do invariante ela vale para os quatro escritores do par.
 *
 * As DUAS frases são diferentes de propósito: quem tem grade e quem É grade
 * precisam fazer coisas opostas. Uma frase só mandaria metade das pessoas
 * procurar o que não existe.
 */
function exigirQueNaoTenhaGrade(companyId: string, productId: string): void {
  const linha = getConnection()
    .prepare(
      `SELECT p.parent_id AS pai, m.name AS modelo
         FROM core_products p
         LEFT JOIN core_products m ON m.id = p.parent_id
        WHERE p.id = ? AND p.company_id = ?`,
    )
    .get(productId, companyId) as { pai: string | null; modelo: string | null } | undefined;
  if (!linha) return;

  if (linha.pai) {
    throw new ApiError(
      'CORE_PART_CANNOT_HAVE_VARIANTS',
      `Este produto é uma variante de "${linha.modelo ?? 'um modelo de grade'}"; grade é coisa de mercadoria de venda, não de item de bancada.`,
      409,
    );
  }

  const filho = getConnection()
    .prepare('SELECT 1 AS n FROM core_products WHERE company_id = ? AND parent_id = ? LIMIT 1')
    .get(companyId, productId) as { n?: number } | undefined;
  if (filho?.n) {
    throw new ApiError(
      'CORE_PART_CANNOT_HAVE_VARIANTS',
      'Este produto é um modelo de grade e as variantes dele continuariam sendo mercadoria de loja. Converta a variante, não o modelo.',
      409,
    );
  }
}

/**
 * O `kind` é um dos DOIS, e a recusa é do invariante.
 *
 * Mora numa função própria porque tem dois cobradores: este arquivo e o
 * `atualizarProduto`, que precisa recusar `kind: "peça"` de uma integração mal
 * escrita ANTES de comparar o valor com o que está gravado — senão um tipo
 * inventado seria denunciado como "mudança pela rota errada", mandando quem
 * escreveu a integração para uma porta que também recusaria o valor.
 */
export function normalizarKind(kind: string | null | undefined): string {
  const limpo = String(kind ?? '').trim() || 'retail';
  if (limpo !== 'part' && limpo !== 'retail') {
    throw new ApiError(
      'CORE_INVALID_PAYLOAD',
      `Tipo de produto desconhecido: "${limpo}". Os tipos são "retail" (revenda) e "part" (peça).`,
      400,
    );
  }
  return limpo;
}

/**
 * O INVARIANTE DO TIPO — para os OUTROS escritores chamarem.
 *
 * Devolve o par já normalizado: quem escreve grava o que sai daqui, e não o que
 * chegou no corpo da requisição. É por isso que a função devolve valor em vez
 * de só validar — retornar `workshopId` nulo para revenda é o que impede um
 * produto de loja ficar carregando a oficina de um cadastro antigo.
 *
 * `productId` é opcional porque nem todo chamador tem um: no cadastro NOVO o
 * produto ainda não existe, e não há como ele já ser componente de kit. Quando
 * vem, a recusa `CORE_PART_IS_KIT_COMPONENT` também é conferida — e é isso que
 * fecha o contorno de fazer pelo PUT o que a rota de conversão recusaria.
 */
export function exigirTipoCoerente(input: {
  companyId: string;
  kind: string | null | undefined;
  workshopId: string | null | undefined;
  weighable?: boolean;
  pluCode?: string | null;
  isKit?: boolean;
  productId?: string;
}): { kind: string; workshopId: string | null } {
  ensureCoreSchema();
  const kind = normalizarKind(input.kind);
  const workshopId = String(input.workshopId ?? '').trim() || null;

  // Mercadoria de revenda não tem bancada. Deixar o `workshop_id` de um
  // cadastro antigo sobreviver à volta faria a peça continuar aparecendo na
  // gaveta depois de ter virado produto de loja.
  if (kind === 'retail') return { kind, workshopId: null };

  if (!workshopId) {
    throw new ApiError(
      'CORE_PART_WORKSHOP_REQUIRED',
      'Peça precisa de uma oficina. Sem bancada dona, ela não aparece na tela de peças nem na vitrine — some do sistema.',
      400,
    );
  }

  const bancada = getConnection()
    .prepare('SELECT id, company_id, name, kind FROM core_workshops WHERE id = ?')
    .get(workshopId) as
    | { id: string; company_id: string; name: string; kind: string }
    | undefined;

  if (!bancada) {
    throw new ApiError('CORE_WORKSHOP_NOT_FOUND', 'Oficina não encontrada.', 404);
  }
  // O saldo é por empresa: apontar a peça para a bancada de outra faria a baixa
  // de estoque atravessar CNPJ.
  if (bancada.company_id !== input.companyId) {
    throw new ApiError(
      'CORE_WORKSHOP_OTHER_COMPANY',
      `A oficina "${bancada.name}" é de outra empresa. O estoque de peças pertence a quem tem o CNPJ.`,
      403,
    );
  }
  if (!capabilitiesFor(bancada.kind).parts) {
    throw new ApiError(
      'CORE_WORKSHOP_WITHOUT_PARTS',
      `A oficina "${bancada.name}" não trabalha com estoque de peças.`,
      409,
    );
  }

  if (input.isKit) {
    throw new ApiError(
      'CORE_PART_CANNOT_BE_KIT',
      'Kit não vira peça: a venda de kit desmembra em componentes e dá baixa em cada um, e peça não é vendida no balcão — é requisitada na ordem de serviço.',
      409,
    );
  }
  // Grade, nos dois papéis. Como a recusa de componente de kit, só é conferível
  // com o produto na mão: no cadastro NOVO não há pai nem filho a consultar.
  if (input.productId) exigirQueNaoTenhaGrade(input.companyId, input.productId);
  if (input.productId && ehComponenteDeKit(input.companyId, input.productId)) {
    throw new ApiError(
      'CORE_PART_IS_KIT_COMPONENT',
      'Este produto é componente de um kit. Vire peça só depois de tirá-lo da composição, senão o kit continua dando baixa em algo que saiu do catálogo de venda.',
      409,
    );
  }
  // Recusa, e NÃO limpa o PLU: apagar calado tiraria da balança um produto que
  // alguém pôs lá de propósito, e a falta só apareceria no dia em que a balança
  // não achasse mais o item.
  if (input.weighable) {
    throw new ApiError(
      'CORE_PART_CANNOT_BE_WEIGHABLE',
      'Peça não é vendida por peso. Desmarque "vendido por peso" antes de converter — o campo não é limpo sozinho.',
      409,
    );
  }
  if (String(input.pluCode ?? '').trim()) {
    throw new ApiError(
      'CORE_PART_CANNOT_BE_WEIGHABLE',
      `Este produto tem o PLU ${String(input.pluCode).trim()} e é procurado pela balança do caixa. Tire o PLU antes de convertê-lo em peça — ele não é apagado sozinho.`,
      409,
    );
  }

  return { kind: 'part', workshopId };
}

/**
 * Quantas vezes o produto já saiu em venda.
 *
 * Não impede nada: a venda antiga continua tendo acontecido e a nota dela
 * continua válida. É aviso — quem converte um item que já vendeu doze vezes no
 * balcão precisa saber que está tirando do catálogo de venda algo que os
 * clientes compram.
 */
function vendasDoProduto(companyId: string, productId: string): number {
  const linha = getConnection()
    .prepare(
      'SELECT COUNT(*) AS total FROM core_sale_items WHERE company_id = ? AND product_id = ?',
    )
    .get(companyId, productId) as { total: number };
  return Number(linha.total ?? 0);
}

/**
 * O saldo do produto, nas DUAS metades que a conversão precisa contar.
 *
 * O bruto é o que muda de lado. O reservado é o pedaço dele que já está
 * prometido — e é ele que faz `addPart` recusar a peça mesmo com a gaveta
 * cheia. Ler só o bruto aqui era o que transformava o aviso numa promessa que o
 * lançamento da OS não cumpria.
 */
function saldoDoProduto(
  companyId: string,
  productId: string,
): { bruto: number; reservado: number } {
  const linha = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number } | undefined;
  return { bruto: Number(linha?.quantity ?? 0), reservado: Number(linha?.reserved ?? 0) };
}

/** A frase pronta. Nula quando não há nada que a pessoa precise saber. */
function montarAviso(efeitos: EfeitosDaConversao, destino: string | null): string | null {
  const partes: string[] = [];
  if (efeitos.despublicadoDaLoja) partes.push('saiu da loja online');
  if (efeitos.destaqueRemovido) partes.push('deixou de ser destaque na vitrine');
  if (efeitos.saldoQueMudaDeLado > 0) {
    partes.push(
      destino
        ? `${efeitos.saldoQueMudaDeLado} em estoque passam a ser contados na gaveta de ${destino}`
        : `${efeitos.saldoQueMudaDeLado} em estoque voltam a ser contados como mercadoria da loja`,
    );
    /*
      A RESSALVA VEM COLADA NO NÚMERO, e não no fim da frase.

      O que muda de lado é o bruto; o que a OS consegue consumir é o bruto menos
      o reservado. Sem esta parte, o aviso prometeria à bancada uma quantidade
      que `addPart` recusaria — e as origens são nomeadas juntas porque culpar
      uma só descreveria o estado errado na maioria dos casos.

      A lista dizia "orçamento", que não reserva (é papel) — quem reserva é a
      PRÉ-VENDA. E desde a rodada 55 a oficina reserva também: peça prometida a
      uma OS ainda não autorizada.
    */
    if (efeitos.reservadoEmAberto > 0) {
      partes.push(
        `desse total, ${efeitos.reservadoEmAberto} está prometido a compromisso já assumido `
          + '(OS aberta, pedido da loja online, pré-venda ou contrato de locação) e não fica livre',
      );
    }
  }
  if (efeitos.vendasAnteriores > 0) {
    partes.push(`já saiu em ${efeitos.vendasAnteriores} venda(s) de balcão`);
  }
  if (efeitos.semPrecoDeVenda) {
    partes.push('está sem preço de venda e entraria na ordem de serviço por R$ 0,00');
  }
  if (partes.length === 0) return null;
  const texto = partes.join('; ');
  return `${texto.charAt(0).toUpperCase()}${texto.slice(1)}.`;
}

/**
 * MERCADORIA -> PEÇA.
 *
 * Despublica e tira o destaque no mesmo movimento, porque `publish_online = 1`
 * e `kind = 'part'` são estados incompatíveis: a vitrine venderia ao consumidor
 * um item de bancada. Não é efeito colateral escondido — vai contado em
 * `efeitos` justamente para a tela dizer antes e confirmar depois.
 */
export function converterParaPeca(input: {
  companyId: string;
  productId: string;
  workshopId: string;
  userId?: string | null;
}): ResultadoDoTipo {
  ensureCoreSchema();
  return withTransaction(() => {
    const produto = carregarProduto(input.companyId, input.productId);

    // A recusa de GRADE não está mais aqui: subiu para `exigirTipoCoerente`, com
    // as outras. Enquanto morava nesta função valia só para quem entrasse por
    // esta porta — e o cadastro entra por outra.
    const tipo = exigirTipoCoerente({
      companyId: input.companyId,
      kind: 'part',
      workshopId: input.workshopId,
      weighable: produto.weighable === 1,
      pluCode: produto.plu_code,
      isKit: produto.is_kit === 1,
      productId: produto.id,
    });

    const saldo = saldoDoProduto(input.companyId, produto.id);
    const efeitos: EfeitosDaConversao = {
      despublicadoDaLoja: produto.publish_online === 1,
      destaqueRemovido: produto.featured_online === 1,
      saldoQueMudaDeLado: saldo.bruto,
      reservadoEmAberto: saldo.reservado,
      vendasAnteriores: vendasDoProduto(input.companyId, produto.id),
      semPrecoDeVenda: Number(produto.price_cents ?? 0) <= 0,
    };

    getConnection()
      .prepare(
        `UPDATE core_products
            SET kind = ?, workshop_id = ?, publish_online = 0, featured_online = 0,
                updated_at = ?
          WHERE id = ? AND company_id = ?`,
      )
      .run(tipo.kind, tipo.workshopId, new Date().toISOString(), produto.id, input.companyId);

    const atualizado = getConnection()
      .prepare('SELECT * FROM core_products WHERE id = ? AND company_id = ?')
      .get(produto.id, input.companyId) as Record<string, unknown>;

    // O fato vai para a central com a OFICINA como unidade operacional: é ela
    // que passa a ser dona do item, e é assim que `createProduct` já marca.
    recordDomainEvent({
      eventType: 'product.upserted',
      aggregateType: 'product',
      aggregateId: produto.id,
      companyId: input.companyId,
      operationalUnitId: tipo.workshopId,
      operation: 'update',
      payload: atualizado,
    });

    const nome = nomeDaBancada(tipo.workshopId);
    return {
      kind: tipo.kind,
      workshopId: tipo.workshopId,
      workshopName: nome,
      efeitos,
      aviso: montarAviso(efeitos, nome),
    };
  });
}

/**
 * PEÇA -> MERCADORIA.
 *
 * A volta é honesta em dois pontos. Primeiro: o saldo que estava sendo contado
 * na gaveta passa a ser saldo de loja NA HORA, e por isso vai em
 * `efeitos.saldoNaGaveta` — a tela avisa ANTES, e quem converte sabe que vai
 * aparecer mercadoria na busca do PDV.
 *
 * Segundo: NÃO republica. O produto volta ao catálogo de venda despublicado,
 * mesmo que estivesse na vitrine antes de virar peça. Republicar por herança
 * poria à venda algo que ninguém revisou desde então — e publicar de novo é um
 * clique deliberado de quem cuida da loja.
 */
export function converterParaRevenda(input: {
  companyId: string;
  productId: string;
  userId?: string | null;
}): ResultadoDoTipo {
  ensureCoreSchema();
  return withTransaction(() => {
    const produto = carregarProduto(input.companyId, input.productId);
    const eraPeca = String(produto.kind ?? 'retail') === 'part';

    const tipo = exigirTipoCoerente({
      companyId: input.companyId,
      kind: 'retail',
      workshopId: null,
    });

    /*
      Nada de publicação muda na volta, então os dois primeiros efeitos são
      falsos por definição — o campo continua existindo porque a tela usa a
      MESMA estrutura nas duas direções, e um campo que some conforme o sentido
      obrigaria a tela a ter dois desenhos para a mesma pergunta.

      O saldo só é notícia quando o produto ERA peça: converter para revenda o
      que já era revenda não move nada de lugar.
    */
    const saldo = saldoDoProduto(input.companyId, produto.id);
    const efeitos: EfeitosDaConversao = {
      despublicadoDaLoja: false,
      destaqueRemovido: false,
      saldoQueMudaDeLado: eraPeca ? saldo.bruto : 0,
      reservadoEmAberto: eraPeca ? saldo.reservado : 0,
      vendasAnteriores: vendasDoProduto(input.companyId, produto.id),
      semPrecoDeVenda: Number(produto.price_cents ?? 0) <= 0,
    };

    getConnection()
      .prepare(
        `UPDATE core_products
            SET kind = ?, workshop_id = NULL, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      )
      .run(tipo.kind, new Date().toISOString(), produto.id, input.companyId);

    const atualizado = getConnection()
      .prepare('SELECT * FROM core_products WHERE id = ? AND company_id = ?')
      .get(produto.id, input.companyId) as Record<string, unknown>;

    recordDomainEvent({
      eventType: 'product.upserted',
      aggregateType: 'product',
      aggregateId: produto.id,
      companyId: input.companyId,
      operationalUnitId: null,
      operation: 'update',
      payload: atualizado,
    });

    return {
      kind: tipo.kind,
      workshopId: null,
      workshopName: null,
      efeitos,
      aviso: eraPeca
        ? montarAviso(efeitos, null)
        : 'Este produto já era mercadoria de revenda: nada mudou.',
    };
  });
}
