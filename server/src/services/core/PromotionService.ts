/**
 * PROMOÇÕES — a regra de ESCRITA (GAP-PRD-032, GAP-PRD-033, GAP-PRD-197,
 * GAP-PRD-194).
 *
 * A regra de LEITURA (qual preço vale agora) mora em `PricingService` e é a
 * mesma do balcão e da loja. Esta aqui responde a outra pergunta: o que pode
 * ser GRAVADO como promoção. Até o lote E5 da remediação a rota aceitava
 * qualquer corpo com um preço ou um percentual:
 *
 *   - preço negativo e percentual acima de 100 eram gravados e ignorados em
 *     silêncio pelo cálculo — promoção "ativa" que não valia nada;
 *   - 100 % era gravado e VALIA: um erro de digitação vendia o produto por
 *     R$ 0,00 na vitrine e no balcão;
 *   - fim antes do início era gravado — promoção que nunca vale;
 *   - o produto era o que viesse no corpo: o CÓDIGO do cadastro (que a tela
 *     pedia) estourava a chave estrangeira em 500 "Erro interno", e o id de um
 *     produto de OUTRA empresa passava (201) e ficava como linha morta.
 *
 * O CONTRATO
 *
 *   - ALVO: UM produto desta empresa — achado pelo id, pelo código interno ou
 *     por qualquer código de barras dele — OU uma categoria que existe (nos
 *     produtos ou em Categorias e marcas). Produto de outra empresa é
 *     "não encontrado", igual a código que não existe: dizer "existe, mas é de
 *     outra empresa" já contaria o que a outra empresa tem.
 *   - DESCONTO: UM preço fixo em centavos inteiros, menor que o de cadastro
 *     (senão a promoção nunca vence a disputa do menor preço) OU um percentual
 *     maior que 0 e no máximo 100.
 *   - GRÁTIS (100 % ou preço zero) só com `confirmarGratis: true`. A tela
 *     pergunta; a API recusa sem a resposta.
 *   - PERÍODO: o fim não vem antes do início. Horário 'HH:MM' da loja, sem
 *     atravessar a meia-noite. Teto de unidades maior que zero.
 *   - EDIÇÃO (GAP-PRD-194): a mesma conferência sobre o registro inteiro já
 *     com a mudança; promoção encerrada não se edita — ela explica o preço das
 *     vendas do período dela.
 *
 * O LEGADO
 *
 * Linha gravada antes desta regra continua no banco (apagar reescreveria a
 * explicação de vendas antigas). O cálculo do preço já a ignora — negativo,
 * acima de 100 %, grátis não confirmado —, e a lista a devolve com
 * `problemas`, escritos, para o gerente encerrar e recriar certo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  comoInstanteFinal,
  comoInstanteInicial,
  diaDaLoja,
} from './CalendarioOperacional.js';
import { saldoDaPromocao, unidadesUsadasSql } from './PricingService.js';

/** A linha de `core_promotions`, como o banco a guarda. */
export interface LinhaDaPromocao {
  id: string;
  company_id: string;
  product_id: string | null;
  category: string | null;
  price_cents: number | null;
  percent_off: number | null;
  starts_at: string;
  ends_at: string | null;
  weekdays: string | null;
  starts_time: string | null;
  ends_time: string | null;
  max_units: number | null;
  free_confirmed: number;
  active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  updated_by: string | null;
}

/** O que é gravado — o corpo depois de conferido e normalizado. */
interface PromocaoConferida {
  product_id: string | null;
  category: string | null;
  price_cents: number | null;
  percent_off: number | null;
  free_confirmed: 0 | 1;
  starts_at: string;
  ends_at: string | null;
  weekdays: string | null;
  starts_time: string | null;
  ends_time: string | null;
  max_units: number | null;
}

const CAMPOS_GRAVADOS: (keyof PromocaoConferida)[] = [
  'product_id',
  'category',
  'price_cents',
  'percent_off',
  'free_confirmed',
  'starts_at',
  'ends_at',
  'weekdays',
  'starts_time',
  'ends_time',
  'max_units',
];

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function invalida(mensagem: string, code = 'CORE_INVALID_PROMOTION', details?: unknown): ApiError {
  return new ApiError(code, mensagem, 400, details);
}

function reais(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function dataBR(instante: string): string {
  const [ano, mes, dia] = diaDaLoja(instante).split('-');
  return `${dia}/${mes}/${ano}`;
}

/** Ausente, nulo ou vazio → nulo. Presente e não numérico → 400. */
function numeroDoCorpo(valor: unknown, campo: string): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (typeof valor === 'boolean' || !Number.isFinite(n)) {
    throw invalida(`${campo}: informe um número.`);
  }
  return n;
}

function textoDoCorpo(valor: unknown): string {
  return valor === undefined || valor === null ? '' : String(valor).trim();
}

const tem = (corpo: Record<string, unknown>, campo: string) =>
  Object.prototype.hasOwnProperty.call(corpo, campo);

// ------------------------------------------------------------------- alvo

interface ProdutoDoAlvo {
  id: string;
  name: string;
  price_cents: number;
  internal_code: string | null;
  category: string | null;
  active: number;
}

/**
 * O produto DESTA empresa que a pessoa quis dizer (GAP-PRD-033/197).
 *
 * A tela pede "o produto" e quem opera tem na mão o código da etiqueta, não o
 * id do banco. A ordem é do mais específico para o menos: o id, o código
 * interno (único na empresa), o código de barras principal e os adicionais.
 * Toda busca leva `company_id`: o produto de outra empresa não é achado — e
 * responde igual a um código que não existe.
 */
function resolverProduto(companyId: string, entrada: unknown): ProdutoDoAlvo {
  const texto = textoDoCorpo(entrada);
  if (!texto) throw invalida('Informe o produto da promoção.', 'CORE_PROMOTION_TARGET');
  const db = getConnection();
  const colunas = 'SELECT id, name, price_cents, internal_code, category, active FROM core_products';
  const achado = (db.prepare(`${colunas} WHERE company_id = ? AND id = ?`).get(companyId, texto)
    ?? db
      .prepare(`${colunas} WHERE company_id = ? AND internal_code = ? ORDER BY active DESC LIMIT 1`)
      .get(companyId, texto)
    ?? db
      .prepare(`${colunas} WHERE company_id = ? AND barcode = ? ORDER BY active DESC LIMIT 1`)
      .get(companyId, texto)
    ?? db
      .prepare(
        `${colunas} WHERE company_id = ?
            AND id IN (SELECT product_id FROM core_product_barcodes WHERE barcode = ?)
          ORDER BY active DESC LIMIT 1`,
      )
      .get(companyId, texto)) as ProdutoDoAlvo | undefined;
  if (!achado) {
    throw new ApiError(
      'CORE_PROMOTION_PRODUCT_NOT_FOUND',
      `Nenhum produto desta empresa com o código "${texto}". Busque pelo nome ou confira o código do cadastro.`,
      404,
      { productId: texto },
    );
  }
  if (!achado.active) {
    throw invalida(
      `"${achado.name}" está inativo: não é vendido em canal nenhum, e a promoção não valeria.`,
      'CORE_PROMOTION_PRODUCT_INACTIVE',
      { productId: achado.id },
    );
  }
  /*
    MODELO COM GRADE NÃO É ALVO. A vitrine e o balcão vendem a VARIANTE (cada
    tamanho/cor tem o próprio id e o próprio preço vigente); a promoção no
    modelo mudaria o preço do card e nunca o do item que o cliente leva — a
    mesma promoção fantasma, com outra cara.
  */
  const temGrade = db
    .prepare('SELECT 1 AS n FROM core_products WHERE parent_id = ? LIMIT 1')
    .get(achado.id) as { n?: number } | undefined;
  if (temGrade?.n) {
    throw invalida(
      `"${achado.name}" tem grade: a loja e o balcão vendem cada tamanho/cor, e a promoção no modelo não valeria em nenhum deles. Crie a promoção na variante ou pela categoria.`,
      'CORE_PRODUCT_HAS_VARIANTS',
      { productId: achado.id },
    );
  }
  return achado;
}

/**
 * A categoria, na GRAFIA do cadastro.
 *
 * O preço compara a categoria da promoção com a do produto por igualdade
 * exata (`PricingService`): "vestuário" digitado para produtos em "Vestuário"
 * seria outra promoção fantasma. A dobra de maiúsculas é feita aqui, em
 * português (o `lower()` do SQLite só dobra ASCII), e grava a grafia mais usada
 * nos produtos. Categoria que só existe em Categorias e marcas (sem produto
 * ainda) é aceita: a promoção vale quando o produto chegar.
 */
function resolverCategoria(companyId: string, entrada: unknown): string {
  const texto = textoDoCorpo(entrada).replace(/\s+/g, ' ');
  if (!texto) throw invalida('Informe a categoria da promoção.', 'CORE_PROMOTION_TARGET');
  const dobra = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  const db = getConnection();
  const dosProdutos = db
    .prepare(
      `SELECT category, COUNT(*) AS n FROM core_products
        WHERE company_id = ? AND category IS NOT NULL AND TRIM(category) <> ''
        GROUP BY category ORDER BY n DESC`,
    )
    .all(companyId) as { category: string; n: number }[];
  const exata = dosProdutos.find((c) => c.category === texto);
  if (exata) return exata.category;
  const dobrada = dosProdutos.find((c) => dobra(c.category) === dobra(texto));
  if (dobrada) return dobrada.category;
  const doVocabulario = (
    db
      .prepare('SELECT name FROM core_categories WHERE company_id = ? AND active = 1')
      .all(companyId) as { name: string }[]
  ).find((c) => dobra(c.name) === dobra(texto));
  if (doVocabulario) return doVocabulario.name;
  throw invalida(
    `Nenhum produto desta empresa está na categoria "${texto}", e ela não existe em Categorias e marcas — confira a grafia.`,
    'CORE_PROMOTION_CATEGORY_EMPTY',
    { category: texto },
  );
}

// ---------------------------------------------------------- conferência

/**
 * Os dias da semana, na forma canônica (GAP-V03): dígitos ordenados, sem
 * repetição; vazio e os sete gravam NULO ("todos os dias").
 */
function diasDaSemana(valor: unknown): string | null {
  const crus: unknown[] = Array.isArray(valor) ? valor : [];
  const dias = [...new Set(crus.map((d) => Number(d)))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
  if (crus.length > 0 && dias.length === 0) {
    throw invalida('Dias da semana inválidos: informe números de 0 (domingo) a 6 (sábado).');
  }
  return dias.length === 0 || dias.length === 7 ? null : dias.join('');
}

function horario(valor: unknown, campo: string): string | null {
  const texto = textoDoCorpo(valor);
  if (!texto) return null;
  if (!HORA.test(texto)) {
    throw invalida(`${campo}: use HH:MM, de 00:00 a 23:59.`, 'CORE_PROMOTION_HOURS');
  }
  return texto;
}

function instante(valor: string, ponta: 'inicio' | 'fim'): string {
  const convertido = ponta === 'inicio' ? comoInstanteInicial(valor) : comoInstanteFinal(valor);
  if (Number.isNaN(Date.parse(convertido))) {
    throw invalida(
      `Data de ${ponta === 'inicio' ? 'início' : 'fim'} inválida: use AAAA-MM-DD.`,
      'CORE_PROMOTION_PERIOD',
    );
  }
  return new Date(convertido).toISOString();
}

/**
 * Confere e normaliza o registro INTEIRO — o da criação, ou o da edição já
 * com as mudanças sobre o que estava gravado (`base`).
 *
 * Na edição, campo ausente no corpo mantém o gravado; presente (mesmo nulo)
 * troca. O ALVO e o DESCONTO trocam em bloco: mandar `category` sem
 * `productId` é mudar o alvo para a categoria — não somar os dois.
 */
function conferir(
  companyId: string,
  corpo: Record<string, unknown>,
  base?: LinhaDaPromocao,
): PromocaoConferida {
  const mudaAlvo = !base || tem(corpo, 'productId') || tem(corpo, 'category');
  const produtoCru = mudaAlvo ? textoDoCorpo(corpo.productId) : (base.product_id ?? '');
  const categoriaCrua = mudaAlvo ? textoDoCorpo(corpo.category) : (base.category ?? '');

  if (produtoCru && categoriaCrua) {
    throw invalida(
      'Escolha UM alvo: um produto OU uma categoria inteira.',
      'CORE_PROMOTION_TARGET',
    );
  }
  if (!produtoCru && !categoriaCrua) {
    throw invalida(
      'Escolha o alvo da promoção: um produto ou uma categoria inteira.',
      'CORE_PROMOTION_TARGET',
    );
  }
  const produto = produtoCru ? resolverProduto(companyId, produtoCru) : null;
  const categoria = categoriaCrua ? resolverCategoria(companyId, categoriaCrua) : null;

  const mudaDesconto = !base || tem(corpo, 'priceCents') || tem(corpo, 'percentOff');
  const preco = mudaDesconto
    ? numeroDoCorpo(corpo.priceCents, 'Preço promocional')
    : base.price_cents;
  let percentual = mudaDesconto
    ? numeroDoCorpo(corpo.percentOff, 'Desconto (%)')
    : base.percent_off;
  const gratisConfirmado =
    corpo.confirmarGratis === true || (!mudaDesconto && Number(base?.free_confirmed ?? 0) === 1);

  if (preco !== null && percentual !== null) {
    throw invalida('Escolha UM tipo de desconto: preço promocional OU percentual.');
  }
  if (preco === null && percentual === null) {
    throw invalida('Informe preço promocional ou percentual de desconto.');
  }
  if (preco !== null) {
    if (!Number.isInteger(preco)) {
      throw invalida('O preço promocional vai em centavos inteiros.');
    }
    if (preco < 0) throw invalida('O preço promocional não pode ser negativo.');
    if (produto && preco >= produto.price_cents) {
      throw invalida(
        `O preço promocional (${reais(preco)}) precisa ser menor que o de cadastro de "${produto.name}" (${reais(produto.price_cents)}) — do contrário a promoção nunca vale.`,
        'CORE_PROMOTION_NOT_A_DISCOUNT',
        { priceCents: preco, productPriceCents: produto.price_cents },
      );
    }
  }
  if (percentual !== null) {
    percentual = Math.round(percentual * 100) / 100;
    if (!(percentual > 0) || percentual > 100) {
      throw invalida('O desconto precisa ser maior que 0 % e no máximo 100 %.');
    }
  }
  const gratis = preco === 0 || percentual === 100;
  if (gratis && !gratisConfirmado) {
    throw invalida(
      preco === 0
        ? 'Preço zero deixa o produto DE GRAÇA na loja online e no balcão. Se é isso mesmo, confirme o grátis.'
        : '100 % de desconto deixa o produto DE GRAÇA na loja online e no balcão. Se é isso mesmo, confirme o grátis.',
      'CORE_PROMOTION_FREE_UNCONFIRMED',
    );
  }

  const inicioCru = tem(corpo, 'startsAt') ? textoDoCorpo(corpo.startsAt) : undefined;
  const fimCru = tem(corpo, 'endsAt') ? textoDoCorpo(corpo.endsAt) : undefined;
  const inicio =
    inicioCru === undefined
      ? (base?.starts_at ?? new Date().toISOString())
      : inicioCru
        ? instante(inicioCru, 'inicio')
        : new Date().toISOString();
  const fim =
    fimCru === undefined ? (base?.ends_at ?? null) : fimCru ? instante(fimCru, 'fim') : null;
  if (fim !== null && fim < inicio) {
    throw invalida(
      `A promoção terminaria antes de começar: o fim (${dataBR(fim)}) é anterior ao início (${dataBR(inicio)}).`,
      'CORE_PROMOTION_PERIOD',
    );
  }

  const weekdays = tem(corpo, 'weekdays') ? diasDaSemana(corpo.weekdays) : (base?.weekdays ?? null);
  const deHora = tem(corpo, 'startsTime')
    ? horario(corpo.startsTime, 'Horário de início')
    : (base?.starts_time ?? null);
  const ateHora = tem(corpo, 'endsTime')
    ? horario(corpo.endsTime, 'Horário de fim')
    : (base?.ends_time ?? null);
  if (deHora && ateHora && ateHora <= deHora) {
    throw invalida(
      'O horário de fim precisa ser depois do de início. A promoção não atravessa a meia-noite — para isso, crie duas.',
      'CORE_PROMOTION_HOURS',
    );
  }

  let teto = tem(corpo, 'maxUnits')
    ? numeroDoCorpo(corpo.maxUnits, 'Limite de unidades')
    : (base?.max_units ?? null);
  if (teto !== null) {
    teto = Math.round(teto * 1000) / 1000;
    if (!(teto > 0)) throw invalida('O limite de unidades precisa ser maior que zero.');
  }

  return {
    product_id: produto?.id ?? null,
    category: categoria,
    price_cents: preco,
    percent_off: percentual,
    free_confirmed: gratis ? 1 : 0,
    starts_at: inicio,
    ends_at: fim,
    weekdays,
    starts_time: deHora,
    ends_time: ateHora,
    max_units: teto,
  };
}

// --------------------------------------------------------- sobreposição

export interface Sobreposicao {
  id: string;
  alvo: string;
}

/**
 * As OUTRAS promoções ativas e não vencidas que alcançam o mesmo produto.
 *
 * Não é erro: quando duas valem ao mesmo tempo, vale o MENOR preço para o
 * cliente (`PricingService`). Não há "prioridade" que escolha a mais cara — a
 * oferta anunciada obriga a loja (CDC, art. 30 e 35), e o cliente que viu as
 * duas tem direito à melhor. O aviso existe para o gerente não criar a
 * segunda achando que ela substitui a primeira.
 */
function sobreposicoes(companyId: string, id: string, p: PromocaoConferida): Sobreposicao[] {
  const db = getConnection();
  const agora = new Date().toISOString();
  const categoriaDoProduto = p.product_id
    ? ((db.prepare('SELECT category FROM core_products WHERE id = ?').get(p.product_id) as
        | { category: string | null }
        | undefined)?.category ?? null)
    : null;
  const linhas = db
    .prepare(
      `SELECT pr.id, pr.product_id, pr.category, p.name AS product_name
         FROM core_promotions pr
         LEFT JOIN core_products p ON p.id = pr.product_id AND p.company_id = pr.company_id
        WHERE pr.company_id = ? AND pr.active = 1 AND pr.id <> ?
          AND (pr.ends_at IS NULL OR pr.ends_at >= ?)
          AND (
                (? IS NOT NULL AND (pr.product_id = ? OR (pr.product_id IS NULL AND pr.category = ?)))
             OR (? IS NOT NULL AND (pr.category = ? OR pr.product_id IN
                   (SELECT id FROM core_products WHERE company_id = ? AND category = ?)))
          )`,
    )
    .all(
      companyId,
      id,
      agora,
      p.product_id,
      p.product_id,
      categoriaDoProduto,
      p.category,
      p.category,
      companyId,
      p.category,
    ) as { id: string; product_id: string | null; category: string | null; product_name: string | null }[];
  return linhas.map((l) => ({
    id: l.id,
    alvo: l.product_id ? (l.product_name ?? 'Produto específico') : `Categoria ${l.category}`,
  }));
}

// --------------------------------------------------------------- escrita

export function criarPromocao(input: {
  companyId: string;
  userId: string | null;
  corpo: Record<string, unknown>;
}): { id: string; promocao: PromocaoConferida; sobreposicoes: Sobreposicao[] } {
  ensureCoreSchema();
  const p = conferir(input.companyId, input.corpo ?? {});
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off, free_confirmed,
          starts_at, ends_at, weekdays, starts_time, ends_time, max_units,
          active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.companyId,
      p.product_id,
      p.category,
      p.price_cents,
      p.percent_off,
      p.free_confirmed,
      p.starts_at,
      p.ends_at,
      p.weekdays,
      p.starts_time,
      p.ends_time,
      p.max_units,
      input.userId,
      new Date().toISOString(),
    );
  return { id, promocao: p, sobreposicoes: sobreposicoes(input.companyId, id, p) };
}

/**
 * Edita uma promoção ATIVA (GAP-PRD-194) — em vez de encerrar e recriar.
 *
 * A mesma conferência da criação, sobre o registro inteiro. Devolve o que
 * mudou, campo a campo, para a trilha: "por que o preço caiu na quarta e não
 * na quinta" precisa de resposta mesmo depois da edição.
 */
export function editarPromocao(input: {
  companyId: string;
  userId: string | null;
  id: string;
  corpo: Record<string, unknown>;
}): {
  id: string;
  mudancas: Record<string, { de: unknown; para: unknown }>;
  sobreposicoes: Sobreposicao[];
} {
  ensureCoreSchema();
  const db = getConnection();
  const base = db
    .prepare('SELECT * FROM core_promotions WHERE id = ? AND company_id = ?')
    .get(input.id, input.companyId) as LinhaDaPromocao | undefined;
  if (!base) {
    throw new ApiError('CORE_PROMOTION_NOT_FOUND', 'Promoção não encontrada.', 404);
  }
  if (!base.active) {
    throw new ApiError(
      'CORE_PROMOTION_ENDED',
      'Promoção encerrada não se edita: ela explica o preço das vendas do período dela. Crie outra.',
      409,
    );
  }
  const p = conferir(input.companyId, input.corpo ?? {}, base);
  const mudancas: Record<string, { de: unknown; para: unknown }> = {};
  for (const campo of CAMPOS_GRAVADOS) {
    const de = base[campo as keyof LinhaDaPromocao] ?? null;
    const para = p[campo] ?? null;
    if (de !== para) mudancas[campo] = { de, para };
  }
  if (Object.keys(mudancas).length > 0) {
    db.prepare(
      `UPDATE core_promotions
          SET product_id = ?, category = ?, price_cents = ?, percent_off = ?, free_confirmed = ?,
              starts_at = ?, ends_at = ?, weekdays = ?, starts_time = ?, ends_time = ?,
              max_units = ?, updated_at = ?, updated_by = ?
        WHERE id = ? AND company_id = ?`,
    ).run(
      p.product_id,
      p.category,
      p.price_cents,
      p.percent_off,
      p.free_confirmed,
      p.starts_at,
      p.ends_at,
      p.weekdays,
      p.starts_time,
      p.ends_time,
      p.max_units,
      new Date().toISOString(),
      input.userId,
      input.id,
      input.companyId,
    );
  }
  return { id: input.id, mudancas, sobreposicoes: sobreposicoes(input.companyId, input.id, p) };
}

// ---------------------------------------------------------------- leitura

export interface PromocaoDaLista extends LinhaDaPromocao {
  product_name: string | null;
  product_code: string | null;
  units_used: number;
  /** Quanto resta do estoque promocional; nulo = sem teto. */
  units_left: number | null;
  /**
   * O que torna esta linha inválida pela regra de hoje (legado). Vazio = ok.
   * Com problema, o preço já a ignora; a tela mostra o texto para o gerente
   * encerrar e recriar certo.
   */
  problemas: string[];
}

function problemasDaLinha(
  l: LinhaDaPromocao & { product_name: string | null; product_price_cents: number | null },
): string[] {
  const problemas: string[] = [];
  if (!l.product_id && !l.category) problemas.push('Sem produto nem categoria: não vale para nada.');
  if (l.product_id && l.product_name === null) {
    problemas.push('O produto não é desta empresa ou foi removido: esta promoção não vale para nada.');
  }
  if (l.price_cents !== null && l.percent_off !== null) {
    problemas.push('Tem preço fixo e percentual ao mesmo tempo.');
  }
  if (l.price_cents === null && l.percent_off === null) problemas.push('Sem desconto nenhum.');
  const gratis = Number(l.free_confirmed ?? 0) === 1;
  if (l.price_cents !== null) {
    if (l.price_cents < 0) problemas.push('Preço promocional negativo: não vale no preço.');
    else if (l.price_cents === 0 && !gratis) {
      problemas.push('Preço zero sem a confirmação do grátis: não vale no preço.');
    } else if (l.product_price_cents !== null && l.price_cents >= l.product_price_cents) {
      problemas.push('O preço promocional não é menor que o de cadastro: nunca vale.');
    }
  }
  if (l.percent_off !== null) {
    if (!(l.percent_off > 0) || l.percent_off > 100) {
      problemas.push('Percentual fora de 0 a 100 %: não vale no preço.');
    } else if (l.percent_off === 100 && !gratis) {
      problemas.push('100 % sem a confirmação do grátis: não vale no preço.');
    }
  }
  if (l.ends_at && l.ends_at < l.starts_at) problemas.push('Termina antes de começar: nunca vale.');
  return problemas;
}

export function listarPromocoes(companyId: string): PromocaoDaLista[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT pr.*, p.name AS product_name, p.internal_code AS product_code,
              p.price_cents AS product_price_cents,
              ${unidadesUsadasSql('pr')} AS units_used
         FROM core_promotions pr
         LEFT JOIN core_products p ON p.id = pr.product_id AND p.company_id = pr.company_id
        WHERE pr.company_id = ?
        ORDER BY pr.created_at DESC`,
    )
    .all(companyId) as unknown as (LinhaDaPromocao & {
    product_name: string | null;
    product_code: string | null;
    product_price_cents: number | null;
    units_used: number;
  })[];
  return linhas.map(({ product_price_cents: _preco, ...l }) => ({
    ...l,
    units_used: Number(l.units_used ?? 0),
    units_left: saldoDaPromocao(l),
    problemas: problemasDaLinha({ ...l, product_price_cents: _preco }),
  }));
}
