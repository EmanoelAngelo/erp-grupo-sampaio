/**
 * A CLASSIFICAÇÃO FISCAL QUE O SISTEMA DESCOBRE — E A QUE ELE NÃO DECIDE.
 *
 * ## O defeito que este módulo conserta
 *
 * O NCM, o CEST e a origem de cada item chegam ESCRITOS no XML de entrada. O
 * sistema lia dois deles e jogava fora os outros, e nenhum alcançava o produto
 * casado: o contador redigitava, produto a produto, exatamente o que o
 * fornecedor já tinha declarado no arquivo. Trabalho manual sobre um dado que
 * já estava no banco.
 *
 * A regra mestre é: SE O SISTEMA CONSEGUE DESCOBRIR COM SEGURANÇA, ELE NÃO
 * PERGUNTA. Mas descobrir não é decidir, e a fronteira entre as duas é a razão
 * de este módulo existir em vez de um UPDATE dentro da importação.
 *
 * ## Onde a fronteira passa
 *
 * O XML do fornecedor é a MELHOR matéria-prima disponível para a classificação
 * de uma mercadoria: quem a fabrica ou a distribui já respondeu ao fisco por
 * aquele NCM. Ele NÃO é, porém, decisão desta empresa — e há três motivos
 * duros para nunca virar uma:
 *
 *   1. o fornecedor pode estar errado, e o erro dele viraria o nosso na
 *      primeira nota de saída;
 *   2. dois fornecedores discordam com frequência sobre a mesma mercadoria, e
 *      escolher um "vencedor" seria adivinhar tributação;
 *   3. o CFOP do arquivo é a SAÍDA DELE (venda para nós), nunca a nossa venda
 *      para o cliente. Herdá-lo produz nota autorizada com tributação errada —
 *      pior que nota recusada, porque a recusa aparece na hora e o imposto
 *      errado aparece na fiscalização.
 *
 * Por isso o módulo SUGERE com procedência e contagem, e a confirmação continua
 * sendo ato humano. O que ele tira do caminho não é a decisão: é a DIGITAÇÃO.
 * Confirmar em lote o que trinta notas já disseram é um clique; descobrir o
 * NCM de trinta produtos, um por um, é a tarde do contador.
 *
 * ## O estado é derivado, nunca guardado
 *
 * Cada linha de `core_product_fiscal_suggestions` é um FATO ("a nota X disse
 * Y"), e fatos não se resolvem. O estado da classificação sai da comparação
 * entre os fatos e o cadastro de hoje — o mesmo princípio pelo qual o readiness
 * deriva HOMOLOGATED de um protocolo real em vez de um booleano que alguém liga
 * na mão. Estado guardado envelhece; estado derivado, não.
 *
 * ## CSOSN, CFOP e pCredSN NÃO PASSAM POR AQUI
 *
 * Fica escrito, porque a tentação vai voltar: o regime de saída da empresa é
 * decisão do contador dela, e nenhum arquivo de terceiro o toca. Este módulo
 * cuida da IDENTIDADE da mercadoria (o que ela é), nunca da TRIBUTAÇÃO da
 * venda (quanto se paga por vendê-la).
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

/**
 * Os TRÊS campos que o arquivo do fornecedor pode informar sobre a mercadoria.
 *
 * `cfop` não está aqui, e a ausência é a regra — ver o cabeçalho.
 */
export const CAMPOS_SUGERIVEIS = ['ncm', 'cest', 'origin'] as const;
export type CampoFiscal = (typeof CAMPOS_SUGERIVEIS)[number];

export type ClassificationState =
  /** O arquivo disse, e ninguém confirmou ainda. */
  | 'AUTO_DETECTADO'
  /** Gente confirmou. É o único estado que vale como decisão da casa. */
  | 'CONFIRMADO'
  /** Ninguém sabe: nem cadastro, nem arquivo. */
  | 'PENDENTE'
  /** Duas fontes discordam — ou o arquivo discorda do cadastro. */
  | 'DIVERGENTE'
  /** O campo não se aplica a esta mercadoria (CEST fora da ST, por exemplo). */
  | 'NAO_APLICAVEL'
  /** Só alguém de fora resolve (SEFAZ, certificadora, adquirente). */
  | 'BLOQUEADO_EXTERNAMENTE';

/** Um valor visto, e por quantas notas. */
export interface SuggestionEvidence {
  value: string;
  /** Quantas LINHAS DE NOTA distintas declararam este valor. */
  occurrences: number;
  /** Os fornecedores que o declararam, sem repetição. */
  suppliers: string[];
  lastSeenAt: string | null;
  lastNoteId: string | null;
}

export interface ProductFieldClassification {
  field: CampoFiscal;
  /** O que o cadastro tem HOJE. */
  current: string | null;
  state: ClassificationState;
  /** O valor mais apoiado pelas notas, quando há um só. */
  best: SuggestionEvidence | null;
  /** Todos os valores vistos, do mais apoiado ao menos. */
  evidence: SuggestionEvidence[];
  /** De onde veio o que está no cadastro. */
  source: 'cadastro' | 'xml_fornecedor' | null;
}

export interface ProductClassification {
  productId: string;
  name: string;
  sku: string | null;
  internalCode: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  fields: ProductFieldClassification[];
  /**
   * O que o LOTE aplicaria neste produto: campo vazio, um único valor sugerido,
   * produto não confirmado. Divergência nunca entra — o lote é para o que é
   * inequívoco, e escolher entre dois NCMs é decisão, não digitação.
   */
  applicable: { field: CampoFiscal; value: string }[];
}

export interface ClassificationSummary {
  totalProducts: number;
  /** Quantos têm NCM (o campo que trava a emissão). */
  withNcm: number;
  withOrigin: number;
  /** Quantos passaram por confirmação humana. */
  confirmed: number;
  /** Quantos têm sugestão aplicável esperando um clique. */
  pendingSuggestions: number;
  /** Quantos têm ao menos um campo em DIVERGÊNCIA. */
  divergences: number;
}

// ---------------------------------------------------------------- gravação

/**
 * A NOTA VIROU FATO — e o que ela declarou vira sugestão.
 *
 * Chamada na IMPORTAÇÃO e de novo na CONFIRMAÇÃO, de propósito: na importação
 * os itens que já casaram sozinhos rendem sugestão na hora (é quando a tela do
 * conferente pode mostrá-la), e na confirmação entram os que foram vinculados à
 * mão no meio do caminho e os produtos que a própria confirmação criou.
 *
 * Chamar duas vezes é seguro porque a UNIQUE inclui a LINHA DA NOTA: a segunda
 * passada reinsere as mesmas chaves e o INSERT OR IGNORE não faz nada. Sem essa
 * chave, reconfirmar uma nota inflaria a contagem de apoio — confiança
 * fabricada por clique repetido, que é pior que não ter contagem nenhuma.
 */
export function recordSuggestionsFromNote(companyId: string, noteId: string): number {
  ensureCoreSchema();
  const db = getConnection();

  const nota = db
    .prepare(
      `SELECT n.id, n.issued_at, s.name AS supplier_name
         FROM core_inbound_notes n
         LEFT JOIN core_suppliers s ON s.id = n.supplier_id
        WHERE n.id = ? AND n.company_id = ?`,
    )
    .get(noteId, companyId) as Record<string, unknown> | undefined;
  if (!nota) return 0;

  const itens = db
    .prepare(
      `SELECT id, product_id, ncm, cest, origin
         FROM core_inbound_note_items
        WHERE note_id = ? AND company_id = ? AND product_id IS NOT NULL`,
    )
    .all(noteId, companyId) as unknown as Record<string, unknown>[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO core_product_fiscal_suggestions
       (id, company_id, product_id, field, value, source, source_ref, note_id,
        supplier_name, issued_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'supplier_xml', ?, ?, ?, ?, ?)`,
  );

  const agora = new Date().toISOString();
  let gravadas = 0;
  for (const item of itens) {
    for (const campo of CAMPOS_SUGERIVEIS) {
      const bruto = normalizar(campo, item[campo] as string | null | undefined);
      if (!bruto) continue;
      const r = insert.run(
        randomUUID(),
        companyId,
        String(item.product_id),
        campo,
        bruto,
        String(item.id),
        noteId,
        (nota.supplier_name as string | null) ?? null,
        (nota.issued_at as string | null) ?? null,
        agora,
      );
      if (Number(r.changes) > 0) gravadas += 1;
    }
  }
  return gravadas;
}

/**
 * O formato canônico de cada campo, e a recusa do que não é do formato.
 *
 * Sugestão fora do formato é lixo com cara de dado: um NCM de 7 dígitos vindo
 * de um XML mal preenchido apareceria na tela como candidato legítimo, alguém o
 * confirmaria em lote, e a recusa só viria da SEFAZ, com a venda feita. Filtrar
 * na entrada é o único momento barato.
 */
function normalizar(campo: CampoFiscal, valor: string | null | undefined): string | null {
  const so = String(valor ?? '').replace(/\D/g, '');
  if (!so) return null;
  if (campo === 'ncm') return so.length === 8 ? so : null;
  if (campo === 'cest') return so.length === 7 ? so : null;
  // Origem é UM dígito, de 0 a 8 — o domínio fechado do layout da NF-e.
  return so.length === 1 && Number(so) <= 8 ? so : null;
}

// ---------------------------------------------------------------- leitura

interface LinhaDeSugestao {
  product_id: string;
  field: CampoFiscal;
  value: string;
  occurrences: number;
  suppliers: string | null;
  last_seen: string | null;
  last_note: string | null;
}

/**
 * O painel de classificação do catálogo.
 *
 * Uma consulta por sugestões e uma por produtos — e não uma por produto, que é
 * o N+1 clássico que faz a tela de 2 000 SKUs demorar meio minuto.
 */
export function listProductClassifications(
  companyId: string,
  options: { onlyOpen?: boolean; productId?: string } = {},
): ProductClassification[] {
  ensureCoreSchema();
  const db = getConnection();

  /*
    UM PRODUTO quando a ficha do cadastro pergunta, o catálogo quando é a tela
    fiscal. A ficha do produto precisa da MESMA resposta — de onde veio este
    NCM, quem confirmou — e mandá-la baixar o catálogo inteiro para achar uma
    linha seria o tipo de desperdício que só aparece na loja com 4 000 SKUs.

    O filtro por produto ignora `active`: quem abre a ficha de um produto
    desativado tem o mesmo direito de saber de onde veio a classificação dele.
  */
  const produtos = (
    options.productId
      ? db.prepare(
          `SELECT id, name, sku, internal_code, ncm, cest, origin,
                  fiscal_confirmed_at, fiscal_confirmed_by, fiscal_classification_source
             FROM core_products
            WHERE company_id = ? AND id = ?`,
        )
      : db.prepare(
          `SELECT id, name, sku, internal_code, ncm, cest, origin,
                  fiscal_confirmed_at, fiscal_confirmed_by, fiscal_classification_source
             FROM core_products
            WHERE company_id = ? AND active = 1
            ORDER BY name`,
        )
  ).all(
    ...(options.productId ? [companyId, options.productId] : [companyId]),
  ) as unknown as Record<string, unknown>[];

  /*
    GROUP_CONCAT DOS FORNECEDORES, e não uma segunda consulta por valor.

    `DISTINCT` dentro do GROUP_CONCAT do SQLite não aceita separador
    personalizado — a vírgula padrão serve, e o nome de fornecedor com vírgula
    no meio é o preço aceito: quem lê a lista quer saber QUANTAS casas
    concordam, e o nome exato está na trilha da nota.
  */
  const linhas = db
    .prepare(
      `SELECT product_id, field, value,
              COUNT(*) AS occurrences,
              GROUP_CONCAT(DISTINCT supplier_name) AS suppliers,
              MAX(created_at) AS last_seen,
              MAX(note_id) AS last_note
         FROM core_product_fiscal_suggestions
        WHERE company_id = ?
        GROUP BY product_id, field, value
        ORDER BY occurrences DESC, value`,
    )
    .all(companyId) as unknown as LinhaDeSugestao[];

  const porProduto = new Map<string, Map<CampoFiscal, SuggestionEvidence[]>>();
  for (const l of linhas) {
    const doProduto = porProduto.get(l.product_id) ?? new Map<CampoFiscal, SuggestionEvidence[]>();
    const doCampo = doProduto.get(l.field) ?? [];
    doCampo.push({
      value: l.value,
      occurrences: Number(l.occurrences),
      suppliers: (l.suppliers ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      lastSeenAt: l.last_seen,
      lastNoteId: l.last_note,
    });
    doProduto.set(l.field, doCampo);
    porProduto.set(l.product_id, doProduto);
  }

  const resultado: ProductClassification[] = [];
  for (const p of produtos) {
    const id = String(p.id);
    const confirmedAt = (p.fiscal_confirmed_at as string | null) ?? null;
    const sugestoes = porProduto.get(id) ?? new Map<CampoFiscal, SuggestionEvidence[]>();
    const fields: ProductFieldClassification[] = [];
    const applicable: { field: CampoFiscal; value: string }[] = [];

    for (const campo of CAMPOS_SUGERIVEIS) {
      const atual = normalizar(campo, p[campo] as string | null);
      const evidence = sugestoes.get(campo) ?? [];
      const distintos = new Set(evidence.map((e) => e.value));

      /*
        ====================================================================
        A ÁRVORE DE ESTADOS, na ordem em que a dúvida importa
        ====================================================================

        DIVERGENTE vem primeiro por um motivo prático: um produto confirmado
        cujo fornecedor passou a declarar outro NCM PRECISA aparecer, e se o
        teste de "confirmado" viesse antes, ele sumiria dentro do CONFIRMADO —
        que é exatamente a mentira tranquila que este módulo existe para não
        contar.

        A DIVERGÊNCIA JÁ PESADA POR GENTE NÃO CONTINUA GRITANDO.

        Sem esta janela, um produto cujo dono examinou as duas notas e escolheu
        um NCM ficaria DIVERGENTE para sempre — o painel cobraria uma decisão
        que já foi tomada, em toda abertura da tela, até alguém aprender a
        ignorar o vermelho. Alarme que toca sempre é alarme que não avisa nada,
        e esta base já recusou esse desenho no vencimento da dívida do
        fornecedor.

        A régua é o RELÓGIO, e não um botão de "dispensar": a divergência volta
        a valer enquanto a nota que discorda for MAIS NOVA que a confirmação.
        Nota que chegou DEPOIS da decisão é informação nova e pede revisão;
        nota que já estava na mesa quando a pessoa decidiu, não. Um botão de
        dispensar guardaria estado que envelhece sozinho — a comparação de
        datas se recalcula sempre certa.

        O CARIMBO É DO PRODUTO, e por isso a janela só vale para o campo que
        TEM valor. `fiscal_confirmed_at` é uma coluna por produto: confirmar o
        NCM carimba a linha inteira. Se a janela valesse para todos os campos,
        confirmar o NCM calaria em silêncio um conflito de CEST que ninguém
        olhou — o carimbo de uma decisão passaria por decisão sobre outra
        coisa. Campo vazio nunca foi decidido, e conflito nele continua sendo
        conflito.
      */
      const pesadaPorGente = (e: SuggestionEvidence): boolean =>
        Boolean(confirmedAt) && Boolean(e.lastSeenAt) && e.lastSeenAt! <= confirmedAt!;

      const divergente = atual
        ? evidence.some((e) => e.value !== atual && !pesadaPorGente(e))
        : distintos.size > 1;
      const divergeEntreSi = distintos.size > 1;

      let state: ClassificationState;
      if (divergente) state = 'DIVERGENTE';
      else if (atual && confirmedAt) state = 'CONFIRMADO';
      else if (atual) state = 'AUTO_DETECTADO';
      else if (distintos.size === 1) state = 'AUTO_DETECTADO';
      else state = campo === 'cest' ? 'NAO_APLICAVEL' : 'PENDENTE';

      const best = evidence.length > 0 && !divergeEntreSi ? evidence[0] : null;

      fields.push({
        field: campo,
        current: atual,
        state,
        best,
        evidence,
        source: atual
          ? ((p.fiscal_classification_source as 'cadastro' | 'xml_fornecedor' | null) ?? 'cadastro')
          : null,
      });

      // Só entra no lote o que é inequívoco: campo vazio, um único valor.
      if (!atual && best && !divergeEntreSi) applicable.push({ field: campo, value: best.value });
    }

    const temAlgoAResolver =
      applicable.length > 0 || fields.some((f) => f.state === 'DIVERGENTE');
    if (options.onlyOpen && !temAlgoAResolver) continue;

    resultado.push({
      productId: id,
      name: String(p.name),
      sku: (p.sku as string | null) ?? null,
      internalCode: (p.internal_code as string | null) ?? null,
      confirmedAt,
      confirmedBy: (p.fiscal_confirmed_by as string | null) ?? null,
      fields,
      applicable,
    });
  }

  return resultado;
}

/** O resumo que o assistente de prontidão exibe no topo. */
export function summarizeClassification(companyId: string): ClassificationSummary {
  const itens = listProductClassifications(companyId);
  const campo = (p: ProductClassification, f: CampoFiscal) =>
    p.fields.find((x) => x.field === f)!;

  return {
    totalProducts: itens.length,
    withNcm: itens.filter((p) => campo(p, 'ncm').current).length,
    withOrigin: itens.filter((p) => campo(p, 'origin').current).length,
    confirmed: itens.filter((p) => p.confirmedAt).length,
    pendingSuggestions: itens.filter((p) => p.applicable.length > 0).length,
    divergences: itens.filter((p) => p.fields.some((f) => f.state === 'DIVERGENTE')).length,
  };
}

// -------------------------------------------------------------- confirmação

export interface ConfirmInput {
  companyId: string;
  userId: string;
  /**
   * O que confirmar. VAZIO significa "tudo que é inequívoco" — o lote que tira
   * a digitação do caminho. Com itens, é escolha explícita de gente, e aí até
   * uma divergência pode ser resolvida: escolher entre dois NCMs é decisão, e
   * decisão é justamente o que um humano pode tomar.
   */
  items?: { productId: string; field: string; value: string }[];
  now?: Date;
}

export interface ConfirmResult {
  /** Quantos campos mudaram de fato. Zero na segunda chamada — idempotente. */
  confirmed: number;
  /** Quantos produtos foram tocados. */
  products: number;
  /** O detalhe que vai para a trilha: produto, campo, valor. */
  applied: { productId: string; field: CampoFiscal; value: string }[];
}

/**
 * CONFIRMAR É ATO HUMANO — em lote, mas humano.
 *
 * O lote não é uma exceção à regra "sugestão nunca vira confirmação sozinha":
 * ele é a mesma confirmação, feita de uma vez sobre o que já é inequívoco. O
 * que ele NUNCA faz é decidir por alguém —
 *
 *   - produto já CONFIRMADO não é reescrito pelo lote. A decisão anterior tem
 *     autor e data; o arquivo de um fornecedor não a revoga;
 *   - campo com DIVERGÊNCIA não entra no lote. Escolher entre dois valores é
 *     decisão, e o lote só executa o que não exige nenhuma;
 *   - campo já preenchido não é sobrescrito pelo lote, ainda que o produto não
 *     esteja confirmado: alguém digitou aquilo, e digitação também é gente.
 *
 * IDEMPOTENTE: a segunda chamada devolve `confirmed: 0` porque não há mais nada
 * inequívoco a aplicar. Quem chama grava a trilha só quando houve mudança —
 * senão a auditoria encheria de linhas idênticas e o ato original, o que tem
 * autor e data, sumiria no meio delas.
 */
export function confirmClassification(input: ConfirmInput): ConfirmResult {
  ensureCoreSchema();
  const agora = (input.now ?? new Date()).toISOString();

  const explicitos = input.items ?? [];
  const alvos: { productId: string; field: CampoFiscal; value: string }[] = [];

  if (explicitos.length > 0) {
    for (const item of explicitos) {
      const field = String(item.field) as CampoFiscal;
      if (!CAMPOS_SUGERIVEIS.includes(field)) {
        throw new ApiError(
          'CORE_FISCAL_FIELD_INVALID',
          `Campo "${item.field}" não é classificação de mercadoria. `
            + 'CFOP, CSOSN e pCredSN são tributação da SAÍDA e não vêm do XML do fornecedor.',
          400,
        );
      }
      const valor = normalizar(field, item.value);
      if (!valor) throw erroDeFormato(field);
      alvos.push({ productId: String(item.productId), field, value: valor });
    }
  } else {
    for (const p of listProductClassifications(input.companyId, { onlyOpen: true })) {
      for (const a of p.applicable) alvos.push({ productId: p.productId, ...a });
    }
  }

  if (alvos.length === 0) return { confirmed: 0, products: 0, applied: [] };

  return withTransaction(() => {
    const db = getConnection();
    const aplicados: { productId: string; field: CampoFiscal; value: string }[] = [];
    const produtos = new Set<string>();

    for (const alvo of alvos) {
      const atual = db
        .prepare(
          `SELECT ncm, cest, origin, fiscal_confirmed_at
             FROM core_products WHERE id = ? AND company_id = ?`,
        )
        .get(alvo.productId, input.companyId) as Record<string, unknown> | undefined;
      if (!atual) {
        throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado nesta operação.', 404);
      }

      const valorAtual = normalizar(alvo.field, atual[alvo.field] as string | null);
      const jaConfirmado = Boolean(atual.fiscal_confirmed_at);
      // Nada a fazer: o cadastro já diz isso, e já foi confirmado por gente.
      if (valorAtual === alvo.value && jaConfirmado) continue;

      db.prepare(
        `UPDATE core_products
            SET ${alvo.field} = ?,
                fiscal_confirmed_at = ?,
                fiscal_confirmed_by = ?,
                fiscal_classification_source = 'xml_fornecedor',
                updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(alvo.value, agora, input.userId, agora, alvo.productId, input.companyId);

      aplicados.push(alvo);
      produtos.add(alvo.productId);
    }

    return { confirmed: aplicados.length, products: produtos.size, applied: aplicados };
  });
}

function erroDeFormato(campo: CampoFiscal): ApiError {
  if (campo === 'ncm') return new ApiError('CORE_FISCAL_NCM_INVALID', 'O NCM tem 8 dígitos.', 400);
  if (campo === 'cest') return new ApiError('CORE_FISCAL_CEST_INVALID', 'O CEST tem 7 dígitos.', 400);
  return new ApiError(
    'CORE_FISCAL_ORIGIN_INVALID',
    'A origem da mercadoria é um dígito de 0 a 8.',
    400,
  );
}
