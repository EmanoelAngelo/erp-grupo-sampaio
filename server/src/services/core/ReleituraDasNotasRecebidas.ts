/**
 * ============================================================================
 * RELER AS NOTAS JÁ RECEBIDAS (GAP-PRD-181)
 * ============================================================================
 *
 * O parser da nota de entrada passou a ler o emitente inteiro (IE, endereço,
 * IBGE), o modelo, o destinatário e a tributação declarada em cada item — e a
 * confirmação passou a dizer que o produto nascido da nota tem NCM "do XML".
 * Tudo isso vale para a nota que entra DAQUI PARA A FRENTE.
 *
 * As que já entraram continuavam como estavam: fornecedor só com nome e CNPJ,
 * nenhuma sugestão de classificação (o recurso é posterior a elas) e o produto
 * que nasceu da nota aparecendo "do cadastro". O banco real tinha exatamente
 * isso — dois produtos da PJ com o NCM da nota de 12/08 e procedência nula.
 *
 * Esta função relê o XML GUARDADO de cada nota da empresa e completa o que a
 * leitura antiga deixou para trás. É o caminho de correção dos dados que já
 * existem, disparado por gente, pela tela fiscal — nunca aplicado sozinho no
 * boot.
 *
 * ## O que ela faz, e o limite de cada passo
 *
 *   1. a NOTA ganha modelo e destinatário onde eles estão nulos;
 *   2. o FORNECEDOR ganha, do XML, o que está EM BRANCO no cadastro — o que
 *      alguém digitou nunca é sobrescrito (`completarFornecedorPeloXml`);
 *   3. cada ITEM ganha CEST, origem e a tributação declarada onde estão nulos.
 *      O casamento é pela POSIÇÃO, e só quando a nota tem o mesmo número de
 *      itens do arquivo: se não bater, o item fica como está;
 *   4. as SUGESTÕES de classificação nascem (`recordSuggestionsFromNote`, que
 *      é idempotente pela linha da nota);
 *   5. a PROCEDÊNCIA 'xml_fornecedor' é dada SÓ ao produto que se prova nascido
 *      daquela nota: criado entre a importação e a confirmação dela, com o
 *      nome da linha e o mesmo NCM do arquivo, sem procedência e sem
 *      confirmação de ninguém. Produto que já existia, mesmo com o NCM igual,
 *      continua "do cadastro" — coincidência não é prova.
 *
 * IDEMPOTENTE: tudo acima só preenche o que é nulo. A segunda releitura conta
 * zero em tudo que não seja "notas lidas".
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { recordAudit } from '../audit/AuditService.js';
import { recordSuggestionsFromNote } from './FiscalSuggestionService.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import {
  completarFatoresDasNotasRecebidas,
  completarFornecedorPeloXml,
  parseNfeXml,
  type ParsedNfe,
} from './NfeImportService.js';

export interface ResultadoDaReleitura {
  /** Notas cujo XML guardado foi lido. */
  notasLidas: number;
  /** Notas anteriores à guarda do arquivo: não há o que reler. */
  notasSemArquivo: number;
  /** XML guardado que o parser recusa: fica de fora, contado. */
  notasIlegiveis: number;
  /**
   * Nota de homologação numa empresa em produção: sem validade fiscal, não
   * completa cadastro nem gera sugestão (R3-DFE, GAP-PRD-168).
   */
  notasSemValidadeFiscal: number;
  fornecedoresCompletados: number;
  itensCompletados: number;
  sugestoesNovas: number;
  procedenciasCorrigidas: number;
  /**
   * Linhas de nota RECEBIDA que ganharam o fator de conversão agora
   * (B-estoque-entrada-04) — as confirmadas antes de a confirmação gravá-lo.
   */
  fatoresCompletados: number;
  /** Pedidos de compra amarrados a essas notas, recontados com o fator. */
  pedidosRecalculados: number;
}

/**
 * Quanto depois da CONFIRMAÇÃO da nota o produto ainda conta como nascido
 * dela. A criação acontece dentro da própria confirmação (mesma transação); a
 * folga cobre só relógio e arredondamento, não "um produto cadastrado na
 * semana seguinte".
 */
const FOLGA_DA_CONFIRMACAO_MS = 5 * 60_000;

/** As colunas do item que a releitura completa, e de onde vem cada valor. */
function valoresDoItem(item: ParsedNfe['items'][number]): [coluna: string, valor: string | number | null][] {
  const t = item.taxes;
  return [
    ['ncm', item.ncm],
    ['cest', item.cest],
    ['origin', item.origin],
    ['icms_cst', t?.icmsCst ?? null],
    ['icms_csosn', t?.icmsCsosn ?? null],
    ['icms_cents', t?.icmsCents ?? null],
    ['icms_st_cents', t?.icmsStCents ?? null],
    ['ipi_cst', t?.ipiCst ?? null],
    ['ipi_cents', t?.ipiCents ?? null],
    ['pis_cst', t?.pisCst ?? null],
    ['pis_cents', t?.pisCents ?? null],
    ['cofins_cst', t?.cofinsCst ?? null],
    ['cofins_cents', t?.cofinsCents ?? null],
  ];
}

const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

export function relerNotasRecebidas(input: {
  companyId: string;
  userId: string | null;
}): ResultadoDaReleitura {
  ensureCoreSchema();
  const db = getConnection();
  const { companyId, userId } = input;

  const resultado: ResultadoDaReleitura = {
    notasLidas: 0,
    notasSemArquivo: 0,
    notasIlegiveis: 0,
    notasSemValidadeFiscal: 0,
    fornecedoresCompletados: 0,
    itensCompletados: 0,
    sugestoesNovas: 0,
    procedenciasCorrigidas: 0,
    fatoresCompletados: 0,
    pedidosRecalculados: 0,
  };
  const fornecedoresCompletados = new Set<string>();
  const empresaEmProducao = getFiscalConfig(companyId).environment === 'production';

  // Só a nota de FORNECEDOR: a entrada digitada ('manual') nunca teve arquivo.
  const notas = db
    .prepare(
      `SELECT id, supplier_id, xml_original, created_at, received_at
         FROM core_inbound_notes
        WHERE company_id = ? AND COALESCE(doc_type, 'nfe') = 'nfe'
        ORDER BY created_at, rowid`,
    )
    .all(companyId) as {
    id: string;
    supplier_id: string | null;
    xml_original: string | null;
    created_at: string;
    received_at: string | null;
  }[];

  for (const nota of notas) {
    const xml = String(nota.xml_original ?? '');
    if (!xml.trim()) {
      resultado.notasSemArquivo += 1;
      continue;
    }
    let parsed: ParsedNfe;
    try {
      parsed = parseNfeXml(xml);
    } catch {
      resultado.notasIlegiveis += 1;
      continue;
    }
    // A nota de teste numa empresa em produção não é fonte de nada (R3-DFE).
    if (empresaEmProducao && parsed.environment === 'homologation') {
      resultado.notasSemValidadeFiscal += 1;
      continue;
    }
    resultado.notasLidas += 1;

    // 1. a nota
    db.prepare(
      `UPDATE core_inbound_notes
          SET model = COALESCE(model, ?),
              recipient_document = COALESCE(recipient_document, ?),
              recipient_name = COALESCE(recipient_name, ?)
        WHERE id = ? AND company_id = ?`,
    ).run(parsed.model, parsed.recipient.document, parsed.recipient.name, nota.id, companyId);

    // 2. o fornecedor — só o que está em branco
    if (nota.supplier_id) {
      const campos = completarFornecedorPeloXml({
        companyId,
        supplierId: nota.supplier_id,
        parsed,
        userId,
      });
      if (campos.length > 0) fornecedoresCompletados.add(nota.supplier_id);
    }

    // 3. os itens, pela posição — e só quando a contagem bate
    const linhas = db
      .prepare(
        `SELECT * FROM core_inbound_note_items WHERE note_id = ? AND company_id = ? ORDER BY rowid`,
      )
      .all(nota.id, companyId) as Record<string, unknown>[];
    if (linhas.length === parsed.items.length) {
      linhas.forEach((linha, i) => {
        const faltando = valoresDoItem(parsed.items[i]).filter(
          ([coluna, valor]) => valor !== null && valor !== undefined && linha[coluna] == null,
        );
        if (faltando.length === 0) return;
        db.prepare(
          `UPDATE core_inbound_note_items
              SET ${faltando.map(([coluna]) => `${coluna} = ?`).join(', ')}
            WHERE id = ? AND company_id = ?`,
        ).run(...faltando.map(([, valor]) => valor), String(linha.id), companyId);
        resultado.itensCompletados += 1;
      });
    }

    // 4. as sugestões (idempotente pela linha da nota)
    resultado.sugestoesNovas += recordSuggestionsFromNote(companyId, nota.id);

    // 5. a procedência de quem se prova nascido desta nota
    if (!nota.received_at) continue;
    const inicio = Date.parse(nota.created_at);
    const fim = Date.parse(nota.received_at) + FOLGA_DA_CONFIRMACAO_MS;
    const candidatos = db
      .prepare(
        `SELECT p.id, p.name, p.ncm, p.created_at, i.description, i.ncm AS item_ncm
           FROM core_inbound_note_items i
           JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
          WHERE i.note_id = ? AND i.company_id = ?
            AND p.fiscal_classification_source IS NULL
            AND p.fiscal_confirmed_at IS NULL
            AND p.ncm IS NOT NULL AND p.ncm <> ''`,
      )
      .all(nota.id, companyId) as {
      id: string;
      name: string;
      ncm: string;
      created_at: string;
      description: string;
      item_ncm: string | null;
    }[];
    for (const c of candidatos) {
      const criadoEm = Date.parse(c.created_at);
      const nasceuDaNota =
        Number.isFinite(criadoEm)
        && criadoEm >= inicio
        && criadoEm <= fim
        && c.name === c.description
        && soDigitos(c.ncm) !== ''
        && soDigitos(c.ncm) === soDigitos(c.item_ncm);
      if (!nasceuDaNota) continue;
      const r = db
        .prepare(
          `UPDATE core_products SET fiscal_classification_source = 'xml_fornecedor'
            WHERE id = ? AND company_id = ? AND fiscal_classification_source IS NULL`,
        )
        .run(c.id, companyId);
      if (Number(r.changes) > 0) resultado.procedenciasCorrigidas += 1;
    }
  }

  resultado.fornecedoresCompletados = fornecedoresCompletados.size;

  /*
    6. O FATOR DAS NOTAS RECEBIDAS ANTES DA CORREÇÃO (B-estoque-entrada-04).

    `completarFatoresDasNotasRecebidas` existia e não tinha chamador: a nota
    confirmada antes de a confirmação gravar o fator continuava com
    `conversion_factor` nulo, e o pedido amarrado a ela seguia contando caixas
    como unidades ("faltam 110" para sempre). Esta rota já é o gesto de "reler
    as notas recebidas", disparado por gente — é aqui que a correção dos dados
    antigos passa a acontecer. Idempotente: só preenche o que é nulo, e a
    segunda releitura conta zero.
  */
  const fatores = completarFatoresDasNotasRecebidas(companyId);
  resultado.fatoresCompletados = fatores.linhasCompletadas;
  resultado.pedidosRecalculados = fatores.pedidosRecalculados;

  recordAudit({
    companyId,
    userId,
    action: 'fiscal.inbound_notes_reread',
    entityType: 'company',
    entityId: companyId,
    detail: { ...resultado },
  });

  return resultado;
}
