/**
 * Auxiliares do catálogo: unidade, grupo tributário, alíquota, tabela de
 * preços, códigos de barras adicionais e componentes de kit.
 *
 * Todos seguem o desenho já usado em `TaxonomyService`: a tabela é a lista do
 * que PODE ser escolhido, e o produto guarda o CÓDIGO em texto. A junção é por
 * `(company_id, code)`. O motivo é o mesmo de lá — trocar para chave
 * estrangeira agora desligaria em silêncio quem já lê `core_products.unit` e
 * `.tax_profile` como texto.
 *
 * O QUE NÃO ESTÁ AQUI: markup e margem. São conta, não cadastro, e vivem em
 * `Pricing.ts`, sem banco e sem empresa.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { custoDoKit } from './Pricing.js';
import { exigirCodigoDeBarrasValido, gtinValido } from './Gtin.js';
import {
  CSOSN_DA_TABELA,
  CST_ICMS_COM_ALIQUOTA,
  CST_ICMS_COM_REDUCAO,
  CST_ICMS_DA_TABELA,
  FORMATO_DO_CBENEF,
} from './TabelasDoIcms.js';

const agora = () => new Date().toISOString();

function texto(valor: unknown, campo: string): string {
  const limpo = String(valor ?? '').trim();
  if (!limpo) {
    throw new ApiError('CORE_CATALOG_FIELD_REQUIRED', `Informe ${campo}.`, 400);
  }
  return limpo;
}

// ------------------------------------------------------------------ unidade

export interface Unidade {
  id: string;
  code: string;
  name: string;
  decimals: number;
  active: number;
  /** Quantos produtos usam esta unidade hoje. */
  usage: number;
}

/**
 * Unidades que toda operação precisa no primeiro dia.
 *
 * Sem uma lista inicial, o cadastro de produto abre com um seletor vazio e a
 * pessoa é obrigada a sair da tela para criar "Unidade" antes de salvar o
 * primeiro item. As casas decimais já vêm certas: peso e volume fracionam,
 * embalagem não.
 */
const UNIDADES_PADRAO: { code: string; name: string; decimals: number }[] = [
  { code: 'UN', name: 'Unidade', decimals: 0 },
  { code: 'PC', name: 'Peça', decimals: 0 },
  { code: 'CX', name: 'Caixa', decimals: 0 },
  { code: 'FD', name: 'Fardo', decimals: 0 },
  { code: 'PAR', name: 'Par', decimals: 0 },
  { code: 'JG', name: 'Jogo', decimals: 0 },
  { code: 'DZ', name: 'Dúzia', decimals: 0 },
  { code: 'KG', name: 'Quilograma', decimals: 3 },
  { code: 'G', name: 'Grama', decimals: 3 },
  { code: 'L', name: 'Litro', decimals: 3 },
  { code: 'ML', name: 'Mililitro', decimals: 0 },
  { code: 'M', name: 'Metro', decimals: 2 },
  { code: 'M2', name: 'Metro quadrado', decimals: 2 },
  { code: 'CM', name: 'Centímetro', decimals: 1 },
  { code: 'AR', name: 'Arroba', decimals: 3 },
];

/**
 * Cria as unidades padrão da operação que ainda não as recebeu.
 *
 * ## O DEFEITO (P00-catalogo-unidade, medido pela verificação adversarial)
 *
 * A saída antecipada era `SELECT COUNT(*) ... if (total.n > 0) return;` — a
 * função concluía "JÁ SEMEEI" a partir de "EXISTE ALGUMA UNIDADE". As duas
 * coisas são diferentes, e `upsertUnit` (POST /core/catalog/units) não chama
 * esta função: numa empresa NOVA, quem cadastrasse uma unidade própria antes
 * de qualquer listagem deixava as padrão de fora PARA SEMPRE, e todo cadastro
 * de produto passava a falhar com 400 CORE_UNIT_NOT_FOUND ("A unidade 'UN' não
 * está cadastrada nesta operação") — inclusive o da tela, que nasce com 'UN'.
 * Sonda pela rota: POST /catalog/units {SC} 201 → POST /core/products 400 →
 * listar as unidades → POST /core/products 400 de novo. Listar não conserta,
 * porque listar também via "existe alguma unidade" e saía cedo. Uma loja
 * implantada por script, importação ou API nascia sem cadastrar produto nenhum.
 *
 * ## O CONSERTO, e por que não é "conferir as quinze"
 *
 * A pergunta passa a ser sobre o VOCABULÁRIO PADRÃO, e não sobre o balcão
 * estar vazio: existe ALGUMA das unidades padrão? Existindo, a operação já
 * nasceu — e o que falta dela foi TIRADO de propósito (`deleteUnit` apaga a
 * unidade sem produto, e desativar mantém a linha). Conferir as quinze uma a
 * uma, como a sugestão original dizia, faria a unidade que o dono excluiu
 * RESSUSCITAR na próxima abertura da tela, que é outro defeito no lugar deste.
 *
 * O INSERT já é `ON CONFLICT DO NOTHING`, então semear de novo nunca duplica;
 * a conferência é só para não escrever à toa e para não desfazer escolha de
 * ninguém.
 */
export function ensureDefaultUnits(companyId: string): void {
  ensureCoreSchema();
  const db = getConnection();
  const marcadores = UNIDADES_PADRAO.map(() => '?').join(', ');
  const jaNasceu = db
    .prepare(
      `SELECT 1 FROM core_units WHERE company_id = ? AND UPPER(code) IN (${marcadores}) LIMIT 1`,
    )
    .get(companyId, ...UNIDADES_PADRAO.map((u) => u.code));
  if (jaNasceu) return;

  const ts = agora();
  withTransaction(() => {
    for (const u of UNIDADES_PADRAO) {
      db.prepare(
        `INSERT INTO core_units (id, company_id, code, name, decimals, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (company_id, code) DO NOTHING`,
      ).run(randomUUID(), companyId, u.code, u.name, u.decimals, ts, ts);
    }
  });
}

export function listUnits(companyId: string): Unidade[] {
  ensureDefaultUnits(companyId);
  return getConnection()
    .prepare(
      `SELECT u.id, u.code, u.name, u.decimals, u.active,
              (SELECT COUNT(*) FROM core_products p
                WHERE p.company_id = u.company_id AND p.unit = u.code) AS usage
         FROM core_units u
        WHERE u.company_id = ?
        ORDER BY u.name`,
    )
    .all(companyId) as unknown as Unidade[];
}

export function upsertUnit(
  companyId: string,
  input: { id?: string; code?: unknown; name?: unknown; decimals?: unknown; active?: unknown },
): Unidade {
  ensureCoreSchema();
  const code = texto(input.code, 'a sigla').toUpperCase();
  const name = texto(input.name, 'o nome');
  const decimals = Number(input.decimals ?? 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) {
    throw new ApiError('CORE_UNIT_DECIMALS', 'Casas decimais deve ser 0, 1, 2 ou 3.', 400);
  }
  const active = input.active === false || input.active === 0 ? 0 : 1;
  const db = getConnection();
  const ts = agora();

  if (input.id) {
    // A sigla é o que o produto guarda. Mudá-la órfã os produtos que a usam —
    // então ela é imutável depois de criada, e quem errou cria outra.
    const atual = db
      .prepare('SELECT code FROM core_units WHERE id = ? AND company_id = ?')
      .get(input.id, companyId) as { code?: string } | undefined;
    if (!atual) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
    if (atual.code !== code) {
      throw new ApiError(
        'CORE_UNIT_CODE_IMMUTABLE',
        'A sigla não muda depois de criada: os produtos guardam ela. Crie outra unidade.',
        409,
      );
    }
    db.prepare(
      'UPDATE core_units SET name = ?, decimals = ?, active = ?, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(name, decimals, active, ts, input.id, companyId);
  } else {
    const existe = db
      .prepare('SELECT id FROM core_units WHERE company_id = ? AND code = ?')
      .get(companyId, code);
    if (existe) {
      throw new ApiError('CORE_UNIT_DUPLICATE', `Já existe uma unidade com a sigla ${code}.`, 409);
    }
    db.prepare(
      `INSERT INTO core_units (id, company_id, code, name, decimals, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), companyId, code, name, decimals, active, ts, ts);
  }

  const criada = listUnits(companyId).find((u) => u.code === code);
  if (!criada) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
  return criada;
}

export function deleteUnit(companyId: string, id: string): void {
  ensureCoreSchema();
  const db = getConnection();
  const alvo = db
    .prepare('SELECT code FROM core_units WHERE id = ? AND company_id = ?')
    .get(id, companyId) as { code?: string } | undefined;
  if (!alvo?.code) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);

  const emUso = db
    .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND unit = ?')
    .get(companyId, alvo.code) as { n: number };
  if (emUso.n > 0) {
    // Apagar deixaria os produtos apontando para uma sigla que não existe
    // mais. Desativar é a saída: some do seletor e não quebra o que já foi
    // cadastrado.
    throw new ApiError(
      'CORE_UNIT_IN_USE',
      `${emUso.n} produto(s) usam esta unidade. Desative em vez de excluir.`,
      409,
    );
  }
  db.prepare('DELETE FROM core_units WHERE id = ? AND company_id = ?').run(id, companyId);
}

// --------------------------------------------------------- grupo tributário

export interface GrupoTributario {
  id: string;
  code: string;
  name: string;
  regime: string;
  ncm: string | null;
  cest: string | null;
  cfop_internal: string | null;
  cfop_external: string | null;
  origin: string | null;
  cst_icms: string | null;
  csosn: string | null;
  /** Alíquota de crédito do Simples — exigida pelos CSOSN 101 e 201. */
  p_cred_sn: string | null;
  cst_pis: string | null;
  cst_cofins: string | null;
  /** CST do IPI na SAÍDA. Nulo = esta operação não destaca IPI. */
  cst_ipi: string | null;
  /** Código da alíquota (core_tax_rates, kind 'ipi') que este grupo usa. */
  ipi_rate_code: string | null;
  /** Código da alíquota de ICMS (kind 'icms') dos CST 00, 20 e 90 (GAP-PRD-021). */
  icms_rate_code: string | null;
  /** Percentual de redução da base do ICMS: obrigatório no CST 20, opcional no 90. */
  p_red_bc: string | null;
  /** Código da alíquota do FCP (kind 'fcp'), somada ao ICMS próprio. */
  fcp_rate_code: string | null;
  /** Código de benefício fiscal da UF (cBenef), 8 ou 10 caracteres. */
  c_benef: string | null;
  active: number;
  usage: number;
}

const REGIMES = new Set(['simples', 'simples_excesso', 'normal']);

/**
 * OS CST DE IPI QUE UMA SAÍDA PODE TER (GAP-V08).
 *
 * A tabela do layout tem duas metades — entrada (00 a 05 e 49) e saída (50 a
 * 55 e 99) — e este grupo emite NOTA DE SAÍDA. Aceitar um CST de entrada aqui
 * gravaria no cadastro um código que a SEFAZ rejeita meses depois, na primeira
 * emissão, com a venda já feita.
 */
const CST_IPI_SAIDA = new Set(['50', '51', '52', '53', '54', '55', '99']);

/**
 * Os CST de saída que TÊM valor — os únicos que exigem alíquota.
 *
 * 51 a 55 são alíquota zero, isento, não-tributado, imune e suspensão: o bloco
 * do layout leva só o código, sem base nem percentual. Exigir alíquota neles
 * seria pedir um número que não existe; deixar de exigi-la em 50/99 seria
 * gravar um destaque de IPI sem quanto.
 */
export const CST_IPI_COM_VALOR = new Set(['50', '99']);

export function listTaxGroups(companyId: string): GrupoTributario[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM core_products p
                     WHERE p.company_id = g.company_id AND p.tax_profile = g.code) AS usage
         FROM core_tax_groups g
        WHERE g.company_id = ?
        ORDER BY g.name`,
    )
    .all(companyId) as unknown as GrupoTributario[];
}

export function upsertTaxGroup(
  companyId: string,
  input: Record<string, unknown> & { id?: string },
): GrupoTributario {
  ensureCoreSchema();
  const code = texto(input.code, 'o código').toUpperCase();
  const name = texto(input.name, 'o nome');
  const regime = String(input.regime ?? 'simples');
  if (!REGIMES.has(regime)) {
    throw new ApiError('CORE_TAX_GROUP_REGIME', 'Enquadramento inválido.', 400);
  }
  const opcional = (v: unknown) => {
    const s = String(v ?? '').trim();
    return s || null;
  };
  const active = input.active === false || input.active === 0 ? 0 : 1;
  const db = getConnection();
  const ts = agora();

  /*
    O IPI DO GRUPO (GAP-V08) — conferido AQUI, e não na emissão.

    Até esta rodada o XML levava `<vIPI>0.00</vIPI>` cravado e nenhum bloco
    `<IPI>` nos itens, enquanto `core_tax_rates` aceitava `kind = 'ipi'` sem
    ninguém ler: alíquota com escritor e sem leitor.

    Ligar o leitor obriga a conferir o cadastro no momento em que ele é
    escrito. A alternativa — descobrir na emissão — é a pior possível: a recusa
    apareceria com o cliente no balcão, e um CST de ENTRADA gravado num grupo
    de SAÍDA só seria notado pela rejeição da SEFAZ, meses depois.

    Vazio continua sendo a resposta certa para quase todo mundo: varejo do
    Simples não destaca IPI, e sem CST nada muda no XML de hoje.
  */
  const cstIpi = opcional(input.cstIpi);
  if (cstIpi && !CST_IPI_SAIDA.has(cstIpi)) {
    throw new ApiError(
      'CORE_TAX_GROUP_CST_IPI',
      `CST de IPI inválido para saída: ${cstIpi}. `
        + 'Na saída valem 50, 51, 52, 53, 54, 55 e 99 — os de 00 a 49 são de entrada.',
      400,
    );
  }
  const ipiRateCode = opcional(input.ipiRateCode)?.toUpperCase() ?? null;
  if (ipiRateCode) {
    const aliquota = db
      .prepare(
        `SELECT percent FROM core_tax_rates
          WHERE company_id = ? AND code = ? AND kind = 'ipi' AND active = 1`,
      )
      .get(companyId, ipiRateCode) as { percent?: number } | undefined;
    if (!aliquota) {
      throw new ApiError(
        'CORE_TAX_GROUP_IPI_RATE_NOT_FOUND',
        `Não há alíquota ativa de IPI com o código ${ipiRateCode} nesta operação. `
          + 'Cadastre em Catálogo › Alíquotas com o tipo "ipi".',
        404,
      );
    }
  }
  /*
    CST COM VALOR SEM ALÍQUOTA É DESTAQUE SEM QUANTO — a mesma recusa que o
    CSOSN 101 sem pCredSN já leva em `TributacaoDoItem`, pelo mesmo motivo:
    inventar o percentual é inventar imposto.
  */
  if (cstIpi && CST_IPI_COM_VALOR.has(cstIpi) && !ipiRateCode) {
    throw new ApiError(
      'CORE_TAX_GROUP_IPI_RATE_REQUIRED',
      `O CST de IPI ${cstIpi} é tributado e exige a alíquota. `
        + 'Escolha uma alíquota de IPI ou use um CST sem valor (51 a 55).',
      400,
    );
  }

  /*
    O ICMS DO GRUPO (GAP-PRD-021) — conferido AQUI, no momento em que é escrito.

    CSOSN e CST de ICMS eram texto livre: "999" entrava, a tela dizia "Grupo
    salvo." e a recusa só vinha na venda. Agora a tabela do leiaute é a régua
    do cadastro (`TabelasDoIcms`), e os campos que só um CST lê são recusados
    fora dele — alíquota de ICMS num CST 40 seria um número que ninguém lê.
  */
  const csosn = opcional(input.csosn);
  if (csosn && !CSOSN_DA_TABELA.has(csosn)) {
    throw new ApiError(
      'CORE_TAX_GROUP_CSOSN',
      `CSOSN inválido: ${csosn}. A tabela do leiaute tem 101, 102, 103, 201, 202, 203, 300, `
        + '400, 500 e 900.',
      400,
    );
  }
  const cstIcms = opcional(input.cstIcms);
  if (cstIcms && !CST_ICMS_DA_TABELA.has(cstIcms)) {
    throw new ApiError(
      'CORE_TAX_GROUP_CST_ICMS',
      `CST de ICMS inválido: ${cstIcms}. A tabela do leiaute tem 00, 02, 10, 15, 20, 30, 40, `
        + '41, 50, 51, 53, 60, 61, 70 e 90.',
      400,
    );
  }
  const aliquotaAtiva = (codigo: string, kind: 'icms' | 'fcp') =>
    db
      .prepare(
        `SELECT 1 AS ok FROM core_tax_rates
          WHERE company_id = ? AND code = ? AND kind = ? AND active = 1`,
      )
      .get(companyId, codigo, kind);
  const icmsRateCode = opcional(input.icmsRateCode)?.toUpperCase() ?? null;
  if (icmsRateCode) {
    if (!cstIcms || !CST_ICMS_COM_ALIQUOTA.has(cstIcms)) {
      throw new ApiError(
        'CORE_TAX_GROUP_ICMS_RATE_SEM_DESTAQUE',
        'A alíquota de ICMS só vale para os CST 00, 20 e 90 — os que destacam ICMS próprio. '
          + `Com ${cstIcms ? `o CST ${cstIcms}` : 'o grupo sem CST de ICMS'} ela nunca seria lida.`,
        400,
      );
    }
    if (!aliquotaAtiva(icmsRateCode, 'icms')) {
      throw new ApiError(
        'CORE_TAX_GROUP_ICMS_RATE_NOT_FOUND',
        `Não há alíquota ativa de ICMS com o código ${icmsRateCode} nesta operação. `
          + 'Cadastre em Catálogo › Alíquotas com o tipo "icms".',
        404,
      );
    }
  }
  const pRedBcBruto = opcional(input.pRedBc);
  let pRedBc: string | null = null;
  if (pRedBcBruto) {
    const normalizado = pRedBcBruto.replace(',', '.');
    const n = Number(normalizado);
    if (!/^\d{1,2}(\.\d{1,4})?$/.test(normalizado) || !(n > 0 && n < 100)) {
      throw new ApiError(
        'CORE_TAX_GROUP_P_RED_BC',
        `Percentual de redução da base inválido: ${pRedBcBruto}. Informe um percentual maior `
          + 'que 0 e menor que 100, com até 4 casas.',
        400,
      );
    }
    if (!cstIcms || !CST_ICMS_COM_REDUCAO.has(cstIcms)) {
      throw new ApiError(
        'CORE_TAX_GROUP_P_RED_BC',
        'A redução da base do ICMS só se aplica aos CST 20 (obrigatória) e 90.',
        400,
      );
    }
    pRedBc = normalizado;
  }
  const fcpRateCode = opcional(input.fcpRateCode)?.toUpperCase() ?? null;
  if (fcpRateCode) {
    if (!icmsRateCode) {
      throw new ApiError(
        'CORE_TAX_GROUP_FCP_SEM_ICMS',
        'O FCP se soma ao ICMS próprio: escolha antes a alíquota de ICMS do grupo.',
        400,
      );
    }
    if (!aliquotaAtiva(fcpRateCode, 'fcp')) {
      throw new ApiError(
        'CORE_TAX_GROUP_FCP_RATE_NOT_FOUND',
        `Não há alíquota ativa de FCP com o código ${fcpRateCode} nesta operação. `
          + 'Cadastre em Catálogo › Alíquotas com o tipo "fcp".',
        404,
      );
    }
  }
  const cBenef = opcional(input.cBenef)?.toUpperCase() ?? null;
  if (cBenef && !FORMATO_DO_CBENEF.test(cBenef)) {
    throw new ApiError(
      'CORE_TAX_GROUP_CBENEF',
      `Código de benefício fiscal inválido: ${cBenef}. O leiaute aceita 8 ou 10 caracteres `
        + '(da tabela da SEFAZ do estado) ou "SEM CBENEF".',
      400,
    );
  }

  const campos = [
    name,
    regime,
    opcional(input.ncm),
    opcional(input.cest),
    opcional(input.cfopInternal),
    opcional(input.cfopExternal),
    opcional(input.origin),
    cstIcms,
    csosn,
    // O UPDATE tem `p_cred_sn = ?` — esta linha faltava, e QUALQUER edição
    // por id estourava em contagem de parâmetros: o grupo salvava uma vez e
    // virava pedra, com a alíquota do CSOSN 101 incorrigível pela rota.
    opcional(input.pCredSn),
    opcional(input.cstPis),
    opcional(input.cstCofins),
    cstIpi,
    ipiRateCode,
    icmsRateCode,
    pRedBc,
    fcpRateCode,
    cBenef,
    active,
    ts,
  ];

  if (input.id) {
    const atual = db
      .prepare('SELECT code FROM core_tax_groups WHERE id = ? AND company_id = ?')
      .get(input.id, companyId) as { code?: string } | undefined;
    if (!atual) throw new ApiError('CORE_TAX_GROUP_NOT_FOUND', 'Grupo não encontrado.', 404);
    if (atual.code !== code) {
      throw new ApiError(
        'CORE_TAX_GROUP_CODE_IMMUTABLE',
        'O código não muda depois de criado: os produtos guardam ele.',
        409,
      );
    }
    db.prepare(
      `UPDATE core_tax_groups SET name = ?, regime = ?, ncm = ?, cest = ?,
              cfop_internal = ?, cfop_external = ?, origin = ?, cst_icms = ?,
              csosn = ?, p_cred_sn = ?, cst_pis = ?, cst_cofins = ?,
              cst_ipi = ?, ipi_rate_code = ?, icms_rate_code = ?, p_red_bc = ?,
              fcp_rate_code = ?, c_benef = ?, active = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(...campos, input.id, companyId);
  } else {
    const existe = db
      .prepare('SELECT id FROM core_tax_groups WHERE company_id = ? AND code = ?')
      .get(companyId, code);
    if (existe) {
      throw new ApiError('CORE_TAX_GROUP_DUPLICATE', `Já existe o grupo ${code}.`, 409);
    }
    /*
      O INSERT usa a MESMA lista `campos` do UPDATE (e a data de criação no
      fim). Eram duas listas escritas à mão, e a do INSERT relia o corpo cru —
      a próxima coluna teria de ser lembrada duas vezes, e a conferência do
      ICMS acima valeria só para a edição.
    */
    db.prepare(
      `INSERT INTO core_tax_groups
         (id, company_id, code, name, regime, ncm, cest, cfop_internal, cfop_external,
          origin, cst_icms, csosn, p_cred_sn, cst_pis, cst_cofins,
          cst_ipi, ipi_rate_code, icms_rate_code, p_red_bc, fcp_rate_code, c_benef,
          active, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), companyId, code, ...campos, ts);
  }

  const salvo = listTaxGroups(companyId).find((g) => g.code === code);
  if (!salvo) throw new ApiError('CORE_TAX_GROUP_NOT_FOUND', 'Grupo não encontrado.', 404);
  return salvo;
}

export function deleteTaxGroup(companyId: string, id: string): void {
  ensureCoreSchema();
  const db = getConnection();
  const alvo = db
    .prepare('SELECT code FROM core_tax_groups WHERE id = ? AND company_id = ?')
    .get(id, companyId) as { code?: string } | undefined;
  if (!alvo?.code) throw new ApiError('CORE_TAX_GROUP_NOT_FOUND', 'Grupo não encontrado.', 404);

  const emUso = db
    .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND tax_profile = ?')
    .get(companyId, alvo.code) as { n: number };
  if (emUso.n > 0) {
    throw new ApiError(
      'CORE_TAX_GROUP_IN_USE',
      `${emUso.n} produto(s) usam este grupo. Desative em vez de excluir.`,
      409,
    );
  }
  db.prepare('DELETE FROM core_tax_groups WHERE id = ? AND company_id = ?').run(id, companyId);
}

// ----------------------------------------------------------------- alíquota

export interface Aliquota {
  id: string;
  code: string;
  name: string;
  kind: string;
  percent: number;
  active: number;
}

/*
  OS TIPOS QUE ALGUÉM LÊ — e 'icms' não é um deles.

  A lista oferecia quatro; três têm leitor na emissão (pis e cofins desde a
  rodada do leitor de contribuição, ipi desde a do IPI). `kind='icms'` nunca
  teve: grep por `core_tax_rates` no servidor inteiro não devolve nenhuma
  consulta por esse tipo, e a recusa do ICMS por CST chama `faltou()` sem
  sequer olhar a tabela.

  Continuar oferecendo era convidar o contador a cadastrar 18% de ICMS,
  acreditar que a operação está configurada e receber a mesma recusa na
  emissão. Cadastro com escritor e sem leitor é promessa que a tela faz e o
  sistema não cumpre — e no fiscal a conta chega com a venda parada.

  Volta no dia em que o ICMS por CST for emitido de verdade; é o mesmo gesto de
  uma linha, do lado certo da ordem.

  E VOLTOU (GAP-PRD-021), do lado certo da ordem: o ICMS por CST passou a ser
  emitido, e o grupo tributário lê a alíquota de ICMS pelo código
  (`icms_rate_code`, CST 00, 20 e 90). Com ele entra 'fcp' — o fundo de
  combate à pobreza, lido pelo `fcp_rate_code` e somado ao ICMS próprio.
*/
const TIPOS_ALIQUOTA = new Set(['pis', 'cofins', 'ipi', 'icms', 'fcp']);

export function listTaxRates(companyId: string): Aliquota[] {
  ensureCoreSchema();
  return getConnection()
    .prepare('SELECT id, code, name, kind, percent, active FROM core_tax_rates WHERE company_id = ? ORDER BY kind, name')
    .all(companyId) as unknown as Aliquota[];
}

export function upsertTaxRate(
  companyId: string,
  input: { id?: string; code?: unknown; name?: unknown; kind?: unknown; percent?: unknown; active?: unknown },
): Aliquota {
  ensureCoreSchema();
  const code = texto(input.code, 'o código').toUpperCase();
  const name = texto(input.name, 'o nome');
  const kind = String(input.kind ?? 'icms');
  if (!TIPOS_ALIQUOTA.has(kind)) {
    throw new ApiError('CORE_TAX_RATE_KIND', 'Tipo de alíquota inválido.', 400);
  }
  const percent = Number(input.percent ?? 0);
  if (!Number.isFinite(percent) || percent < 0) {
    throw new ApiError('CORE_TAX_RATE_PERCENT', 'Percentual inválido.', 400);
  }
  const active = input.active === false || input.active === 0 ? 0 : 1;
  const db = getConnection();
  const ts = agora();

  if (input.id) {
    db.prepare(
      'UPDATE core_tax_rates SET code = ?, name = ?, kind = ?, percent = ?, active = ?, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(code, name, kind, percent, active, ts, input.id, companyId);
  } else {
    db.prepare(
      `INSERT INTO core_tax_rates (id, company_id, code, name, kind, percent, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), companyId, code, name, kind, percent, active, ts, ts);
  }

  const salvo = listTaxRates(companyId).find((a) => a.code === code);
  if (!salvo) throw new ApiError('CORE_TAX_RATE_NOT_FOUND', 'Alíquota não encontrada.', 404);
  return salvo;
}

export function deleteTaxRate(companyId: string, id: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare('DELETE FROM core_tax_rates WHERE id = ? AND company_id = ?')
    .run(id, companyId);
}

// ---------------------------------------------------------- tabela de preços

export interface TabelaDePreco {
  id: string;
  name: string;
  percent_off: number;
  active: number;
  /** Quantos produtos têm preço fixado nesta tabela. */
  items: number;
  /**
   * Quantos CLIENTES compram por esta tabela hoje.
   *
   * Sem este número a tela prometia uma regra de negociação e não mostrava
   * efeito nenhum: dava para cadastrar "Atacado -15%", olhar a lista e não ter
   * como saber se aquilo valia para alguém. Ele é também o número que a recusa
   * de exclusão e de desativação devolve, e vem da MESMA contagem — duas
   * consultas diferentes acabariam discordando no dia em que uma delas
   * esquecesse o `company_id`.
   */
  customers: number;
}

export function listPriceTables(companyId: string): TabelaDePreco[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT t.id, t.name, t.percent_off, t.active,
              (SELECT COUNT(*) FROM core_price_table_items i WHERE i.price_table_id = t.id) AS items,
              (SELECT COUNT(*) FROM core_customers c
                WHERE c.company_id = t.company_id AND c.price_table_id = t.id) AS customers
         FROM core_price_tables t
        WHERE t.company_id = ?
        ORDER BY t.name`,
    )
    .all(companyId) as unknown as TabelaDePreco[];
}

/**
 * Quantos clientes desta operação compram por esta tabela.
 *
 * Uma função só, usada pela lista, pela recusa de exclusão e pela recusa de
 * desativação. É o número que aparece na mensagem de erro, e é ele que diz ao
 * gerente o tamanho do trabalho que ele teria de fazer antes ("15 clientes
 * precisam ser trocados de tabela"), em vez de um "não pode" sem saída.
 */
export function countCustomersUsingPriceTable(companyId: string, priceTableId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      'SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ? AND price_table_id = ?',
    )
    .get(companyId, priceTableId) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * A tabela do cliente — o único caminho por onde um id de tabela entra na
 * precificação.
 *
 * Duas decisões moram aqui, e as duas são de propósito:
 *
 *   1. SÓ TABELA ATIVA. Desativar tem de ter efeito de verdade. Se o filtro
 *      ficasse em cada chamador, bastaria um esquecer para a tabela desativada
 *      continuar dando desconto — e a diferença entre "desativei" e "continua
 *      valendo" não dá erro, só dá margem a menos.
 *   2. CLIENTE SEM TABELA DEVOLVE NULO, e nulo é o preço normal. É o que todo
 *      cliente que já existe significa hoje, e precisa continuar significando
 *      depois da migração 59.
 */
export function priceTableForCustomer(
  companyId: string,
  customerId: string | null | undefined,
): { id: string; name: string; percentOff: number } | null {
  ensureCoreSchema();
  if (!customerId) return null;
  const row = getConnection()
    .prepare(
      `SELECT t.id, t.name, t.percent_off
         FROM core_customers c
         JOIN core_price_tables t
           ON t.id = c.price_table_id AND t.company_id = c.company_id
        WHERE c.id = ? AND c.company_id = ? AND t.active = 1`,
    )
    .get(customerId, companyId) as
    | { id: string; name: string; percent_off: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, percentOff: Number(row.percent_off ?? 0) };
}

/**
 * A recusa que a exclusão e a desativação COMPARTILHAM.
 *
 * Desativar é a porta ao lado de excluir: as duas fazem a tabela parar de
 * valer para quem está vinculado a ela. Trancar só uma seria não trancar
 * nenhuma — quem quisesse sumir com a tabela em uso simplesmente desmarcaria
 * "ativa" e teria o mesmo efeito, sem aviso e sem rastro. O cliente
 * continuaria vinculado a uma tabela que não existe mais no cálculo, e passaria
 * a pagar preço cheio na próxima compra sem que ninguém tivesse decidido isso.
 */
/**
 * Quantos ORÇAMENTOS ainda apontam para esta tabela.
 *
 * `core_quotes.price_table_id` é chave estrangeira para `core_price_tables`, e
 * documento em aberto continua apontando depois de aprovado — é assim que a
 * conversão sabe de qual tabela ele falava.
 */
function countQuotesUsingPriceTable(companyId: string, priceTableId: string): number {
  const row = getConnection()
    .prepare(
      'SELECT COUNT(*) AS n FROM core_quotes WHERE company_id = ? AND price_table_id = ?',
    )
    .get(companyId, priceTableId) as { n: number };
  return row.n;
}

/**
 * A recusa conta CLIENTE **e** DOCUMENTO — e contar só um era pior que não
 * contar nenhum.
 *
 * A versão anterior olhava apenas `core_customers`. Com um orçamento apontando
 * para a tabela e nenhum cliente ligado, a recusa não disparava, o DELETE
 * chegava ao banco e a chave estrangeira o derrubava com erro cru: 500, sem
 * mensagem que explicasse nada.
 *
 * E havia um detalhe cruel: a mensagem do 409 manda "trocar a tabela desses
 * clientes antes". Quem seguisse a instrução desvincularia os clientes, tentaria
 * de novo — e cairia exatamente no 500, conduzido até o buraco pelo texto que
 * deveria ajudar.
 */
function recusarSeTemCliente(companyId: string, priceTableId: string, verbo: string): void {
  const clientes = countCustomersUsingPriceTable(companyId, priceTableId);
  const orcamentos = countQuotesUsingPriceTable(companyId, priceTableId);
  if (clientes === 0 && orcamentos === 0) return;

  const partes: string[] = [];
  if (clientes > 0) {
    partes.push(`${clientes} ${clientes === 1 ? 'cliente compra' : 'clientes compram'} por ela`);
  }
  if (orcamentos > 0) {
    partes.push(
      `${orcamentos} ${orcamentos === 1 ? 'orçamento aponta' : 'orçamentos apontam'} para ela`,
    );
  }

  throw new ApiError(
    'CORE_PRICE_TABLE_IN_USE',
    `Esta tabela não pode ser ${verbo}: ${partes.join(' e ')}. `
      + (clientes > 0 ? 'Troque a tabela desses clientes' : 'Feche ou cancele esses orçamentos')
      + ' antes.',
    409,
    { priceTableId, customers: clientes, quotes: orcamentos },
  );
}

export function upsertPriceTable(
  companyId: string,
  input: { id?: string; name?: unknown; percentOff?: unknown; active?: unknown },
): TabelaDePreco {
  ensureCoreSchema();
  const name = texto(input.name, 'o nome');
  const percentOff = Number(input.percentOff ?? 0);
  if (!Number.isFinite(percentOff) || percentOff < 0 || percentOff >= 100) {
    throw new ApiError(
      'CORE_PRICE_TABLE_PERCENT',
      'O desconto da tabela precisa ficar entre 0 e 100.',
      400,
    );
  }
  const active = input.active === false || input.active === 0 ? 0 : 1;
  const db = getConnection();
  const ts = agora();

  if (input.id) {
    /*
      A TRANSIÇÃO 1 -> 0 É A MESMA PORTA DA EXCLUSÃO.

      Só a transição, e não "está inativa": salvar de novo uma tabela que já
      estava desativada não pode ser recusado — seria impossível corrigir o
      nome ou o percentual de uma tabela antiga. O que se barra é o ATO de
      tirar do ar uma tabela que tem cliente comprando por ela.
    */
    const antes = db
      .prepare('SELECT active FROM core_price_tables WHERE id = ? AND company_id = ?')
      .get(input.id, companyId) as { active?: number } | undefined;
    if (antes && Number(antes.active) === 1 && active === 0) {
      recusarSeTemCliente(companyId, String(input.id), 'desativada');
    }
    db.prepare(
      'UPDATE core_price_tables SET name = ?, percent_off = ?, active = ?, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(name, percentOff, active, ts, input.id, companyId);
  } else {
    db.prepare(
      `INSERT INTO core_price_tables (id, company_id, name, percent_off, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), companyId, name, percentOff, active, ts, ts);
  }

  const salva = listPriceTables(companyId).find((t) => t.name === name);
  if (!salva) throw new ApiError('CORE_PRICE_TABLE_NOT_FOUND', 'Tabela não encontrada.', 404);
  return salva;
}

/**
 * Apagar tabela: só a que ninguém usa.
 *
 * Antes o DELETE era direto, e com o vínculo `core_customers.price_table_id`
 * isso passa a ser destrutivo em silêncio: o revendedor que tem 15% combinado
 * perde a tabela, o `LEFT JOIN` da precificação passa a não achar nada, e a
 * próxima compra dele sai por preço cheio. Ninguém recebe erro — nem quem
 * apagou, nem quem vendeu. O cliente descobre no cupom.
 */
export function deletePriceTable(companyId: string, id: string): void {
  ensureCoreSchema();
  recusarSeTemCliente(companyId, id, 'excluída');
  getConnection()
    .prepare('DELETE FROM core_price_tables WHERE id = ? AND company_id = ?')
    .run(id, companyId);
}

/**
 * Preço de um produto numa tabela.
 *
 * A exceção por item ganha do percentual geral — é assim que se negocia: a
 * tabela dá 5% em tudo, MENOS naquele item que foi combinado a um valor.
 */
export function priceInTable(
  companyId: string,
  priceTableId: string,
  productId: string,
  precoBaseCents: number,
): number {
  ensureCoreSchema();
  const db = getConnection();
  const item = db
    .prepare(
      'SELECT price_cents FROM core_price_table_items WHERE company_id = ? AND price_table_id = ? AND product_id = ?',
    )
    .get(companyId, priceTableId, productId) as { price_cents?: number } | undefined;
  if (item?.price_cents != null) return item.price_cents;

  const tabela = db
    .prepare('SELECT percent_off FROM core_price_tables WHERE id = ? AND company_id = ?')
    .get(priceTableId, companyId) as { percent_off?: number } | undefined;
  const desconto = tabela?.percent_off ?? 0;
  return Math.round(precoBaseCents * (1 - desconto / 100));
}

export function setPriceTableItem(
  companyId: string,
  priceTableId: string,
  productId: string,
  priceCents: number,
): void {
  ensureCoreSchema();
  // Zero incluído na recusa: preço fixado em R$ 0,00 é produto DE GRAÇA no
  // cupom, sem erro para ninguém — e nenhuma negociação de tabela combina
  // "de graça". Brinde é outro fluxo, com outro rastro.
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new ApiError(
      'CORE_PRICE_TABLE_ITEM_PRICE',
      'Preço fixado inválido: informe um valor inteiro em centavos, maior que zero.',
      400,
    );
  }
  const ts = agora();
  getConnection()
    .prepare(
      `INSERT INTO core_price_table_items
         (id, company_id, price_table_id, product_id, price_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (price_table_id, product_id)
       DO UPDATE SET price_cents = excluded.price_cents, updated_at = excluded.updated_at`,
    )
    .run(randomUUID(), companyId, priceTableId, productId, priceCents, ts, ts);
}

export function removePriceTableItem(
  companyId: string,
  priceTableId: string,
  productId: string,
): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      'DELETE FROM core_price_table_items WHERE company_id = ? AND price_table_id = ? AND product_id = ?',
    )
    .run(companyId, priceTableId, productId);
}

/**
 * Os preços fixados de uma tabela, com o produto pelo nome.
 *
 * É a metade de LER da funcionalidade que `setPriceTableItem` escreve: a tela
 * de tabelas precisa mostrar "capacete: R$ 120,00 fixo" para que alguém possa
 * conferir e remover o combinado — sem esta lista, o preço fixado só
 * apareceria no cupom, que é tarde demais. O JOIN traz nome e códigos porque
 * um `product_id` cru não diz a ninguém QUAL item foi negociado.
 */
export function listPriceTableItems(
  companyId: string,
  priceTableId: string,
): Record<string, unknown>[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT i.product_id, i.price_cents, i.updated_at,
              p.name AS product_name, p.internal_code, p.barcode,
              p.price_cents AS base_price_cents
         FROM core_price_table_items i
         JOIN core_products p ON p.id = i.product_id
        WHERE i.company_id = ? AND i.price_table_id = ?
        ORDER BY p.name`,
    )
    .all(companyId, priceTableId) as unknown as Record<string, unknown>[];
}

// -------------------------------------------------- códigos de barras extras

export function listProductBarcodes(companyId: string, productId: string): string[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      'SELECT barcode FROM core_product_barcodes WHERE company_id = ? AND product_id = ? ORDER BY created_at',
    )
    .all(companyId, productId) as unknown as { barcode: string }[];
  return linhas.map((l) => l.barcode);
}

/**
 * Acrescenta um código ao produto.
 *
 * Um código só pode apontar para UM produto na operação — e a checagem olha os
 * dois lugares onde código mora: o principal, em `core_products.barcode`, e os
 * adicionais. Sem olhar o principal, o leitor do PDV passaria a ter duas
 * respostas para o mesmo bipe.
 */
export function addProductBarcode(
  companyId: string,
  productId: string,
  barcode: unknown,
): string[] {
  ensureCoreSchema();
  const db = getConnection();

  /*
    O PRODUTO É DA MESMA OPERAÇÃO — e esta conferência NÃO EXISTIA (P00-prod-01).

    O DEFEITO: o `productId` vinha da URL e ia direto para o INSERT, junto com
    o `company_id` de QUEM CHAMOU. A Gringa mandava o id de um produto da Preço
    Justo e recebia 201: nascia uma linha em `core_product_barcodes` com a
    empresa de uma loja e a mercadoria de outra. Todas as rotas irmãs do mesmo
    produto (grade, clone, faixas de preço, kit, foto, PUT) já respondiam 404
    nesse caso; esta era a porta que faltava.

    As duas consequências, nenhuma delas com tela que a explique:

      - o código ficava QUEIMADO para quem o gravou. `findProductByAnyBarcode`
        procura pela empresa e acha a linha torta, então o cadastro do MESMO EAN
        no produto certo passava a ser recusado com "já pertence a outro
        produto" — sobre um produto que a operação não enxerga em lugar nenhum;
      - e o balcão da OUTRA loja passava a atender ao bipe daquele código,
        porque a busca casava o adicional sem olhar a empresa da linha (ver
        `searchProducts`).

    404, e não 403: para esta operação o produto não existe — é a mesma resposta
    de um id inventado, e é ela que impede a rota de confirmar que o id é real.
  */
  const dono = db
    .prepare('SELECT id FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { id?: string } | undefined;
  if (!dono?.id) {
    throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
  }

  const code = texto(barcode, 'o código de barras');
  exigirCodigoDeBarrasValido(code);

  const principal = db
    .prepare('SELECT id FROM core_products WHERE company_id = ? AND barcode = ? AND id <> ?')
    .get(companyId, code, productId) as { id?: string } | undefined;
  const extra = db
    .prepare(
      'SELECT product_id FROM core_product_barcodes WHERE company_id = ? AND barcode = ? AND product_id <> ?',
    )
    .get(companyId, code, productId) as { product_id?: string } | undefined;

  if (principal?.id || extra?.product_id) {
    throw new ApiError(
      'CORE_BARCODE_DUPLICATE',
      'Este código de barras já pertence a outro produto.',
      409,
    );
  }
  /*
    O ADICIONAL TAMBÉM NÃO PODE SER O CÓDIGO INTERNO OU O SKU DE OUTRO PRODUTO
    (A-produto-24). A busca do PDV casa os três papéis no mesmo campo: um
    adicional igual ao código interno de outro item fazia o bipe achar os dois,
    e a lista abria em vez de o item entrar no carrinho.
  */
  const outroPapel = db
    .prepare(
      `SELECT name FROM core_products
        WHERE company_id = ? AND id <> ?
          AND (upper(internal_code) = upper(?) OR upper(sku) = upper(?))
        LIMIT 1`,
    )
    .get(companyId, productId, code, code) as { name?: string } | undefined;
  if (outroPapel?.name) {
    throw new ApiError(
      'CORE_CODE_CLASHES_BARCODE',
      `"${code}" já é o código interno (ou SKU) de "${outroPapel.name}". Se ele for também um código de barras deste produto, o bipe no balcão acha os dois e o item não entra direto no carrinho. Use outro código.`,
      409,
    );
  }

  db.prepare(
    `INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (company_id, barcode) DO NOTHING`,
  ).run(randomUUID(), companyId, productId, code, agora());

  return listProductBarcodes(companyId, productId);
}

export function removeProductBarcode(
  companyId: string,
  productId: string,
  barcode: string,
): string[] {
  ensureCoreSchema();
  getConnection()
    .prepare(
      'DELETE FROM core_product_barcodes WHERE company_id = ? AND product_id = ? AND barcode = ?',
    )
    .run(companyId, productId, barcode);
  return listProductBarcodes(companyId, productId);
}

/** Acha o produto por qualquer um dos códigos — o principal ou um adicional. */
export function findProductByAnyBarcode(companyId: string, barcode: string): string | null {
  ensureCoreSchema();
  const db = getConnection();
  const principal = db
    .prepare('SELECT id FROM core_products WHERE company_id = ? AND barcode = ?')
    .get(companyId, barcode) as { id?: string } | undefined;
  if (principal?.id) return principal.id;
  /*
    A JUNÇÃO COM O PRODUTO CONFERE A EMPRESA (P00-prod-01).

    Sem ela, a linha torta que `addProductBarcode` deixava nascer (empresa de
    uma loja, mercadoria de outra) fazia esta função devolver o id de um produto
    que a operação não enxerga: o cadastro do MESMO código no produto certo era
    recusado com "já pertence a outro produto", para sempre e sem tela que
    explicasse. Com a conferência, a linha herdada de um banco antigo fica
    inerte — o código volta a estar livre para quem é dono dele.
  */
  const extra = db
    .prepare(
      `SELECT b.product_id FROM core_product_barcodes b
         JOIN core_products p ON p.id = b.product_id AND p.company_id = b.company_id
        WHERE b.company_id = ? AND b.barcode = ?`,
    )
    .get(companyId, barcode) as { product_id?: string } | undefined;
  return extra?.product_id ?? null;
}

// ------------------------------------------------------------ kit de produtos

export interface ComponenteDoKit {
  id: string;
  component_id: string;
  name: string;
  internal_code: string;
  unit: string;
  quantity: number;
  cost_cents: number;
}

export function listKitComponents(companyId: string, kitId: string): ComponenteDoKit[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT k.id, k.component_id, k.quantity,
              p.name, p.internal_code, p.unit, p.cost_cents
         FROM core_kit_components k
         JOIN core_products p ON p.id = k.component_id
        WHERE k.company_id = ? AND k.kit_id = ?
        ORDER BY p.name`,
    )
    .all(companyId, kitId) as unknown as ComponenteDoKit[];
}

/**
 * Define a composição do kit, substituindo a anterior.
 *
 * Substituir em vez de acumular: a tela edita a lista inteira, e um "adicionar"
 * que só soma deixaria peça removida na tela reaparecer no banco.
 *
 * KIT DENTRO DE KIT É RECUSADO. A baixa de estoque teria de descer níveis, e
 * um ciclo (A contém B, B contém A) travaria a venda em laço. Um nível resolve
 * o que a loja precisa e não tem esse risco.
 */
export function setKitComponents(
  companyId: string,
  kitId: string,
  componentes: { componentId: string; quantity: number }[],
): ComponenteDoKit[] {
  ensureCoreSchema();
  const db = getConnection();

  const kit = db
    .prepare('SELECT id, kind FROM core_products WHERE id = ? AND company_id = ?')
    .get(kitId, companyId) as { id: string; kind: string | null } | undefined;
  if (!kit) throw new ApiError('CORE_KIT_NOT_FOUND', 'Produto não encontrado.', 404);

  /*
    KIT E PEÇA DE OFICINA NÃO SE MISTURAM — nos dois sentidos.

    `ProductKindService` recusa converter em peça um produto que é kit ou que é
    componente de um. Sem a recusa AQUI, o mesmo estado proibido seria montado
    pelo outro lado: bastaria virar peça primeiro e compor o kit depois.

    E o motivo é o mesmo dos dois lados: a venda de kit desmembra em componentes
    e dá baixa em cada um, enquanto peça sai do estoque por requisição de ordem
    de serviço. Um item que é as duas coisas teria duas portas de saída para o
    mesmo saldo.
  */
  if (String(kit.kind ?? 'retail') === 'part' && componentes.length > 0) {
    throw new ApiError(
      'CORE_PART_CANNOT_BE_KIT',
      'Peça de oficina não é kit: kit é vendido no balcão e desmembrado na venda, peça sai por requisição de ordem de serviço.',
      409,
    );
  }

  for (const c of componentes) {
    if (c.componentId === kitId) {
      throw new ApiError('CORE_KIT_SELF', 'Um kit não pode conter a si mesmo.', 400);
    }
    if (!Number.isFinite(c.quantity) || c.quantity <= 0) {
      throw new ApiError('CORE_KIT_QUANTITY', 'Quantidade da peça deve ser maior que zero.', 400);
    }
    const peca = db
      .prepare('SELECT is_kit, kind, name FROM core_products WHERE id = ? AND company_id = ?')
      .get(c.componentId, companyId) as
      | { is_kit?: number; kind?: string | null; name?: string }
      | undefined;
    if (!peca) {
      throw new ApiError('CORE_KIT_COMPONENT_NOT_FOUND', 'Peça do kit não encontrada.', 404);
    }
    // O outro sentido: peça de oficina não entra na composição de um kit de
    // venda. É o par da recusa `CORE_PART_IS_KIT_COMPONENT` da conversão.
    if (String(peca.kind ?? 'retail') === 'part') {
      throw new ApiError(
        'CORE_PART_IS_KIT_COMPONENT',
        `"${peca.name ?? 'O item'}" é peça de oficina e não entra em kit de venda: o saldo dela sai por requisição de ordem de serviço.`,
        409,
      );
    }
    if (peca.is_kit) {
      throw new ApiError(
        'CORE_KIT_NESTED',
        'Kit dentro de kit não é aceito: a baixa de estoque entraria em laço.',
        400,
      );
    }
  }

  const ts = agora();
  withTransaction(() => {
    db.prepare('DELETE FROM core_kit_components WHERE company_id = ? AND kit_id = ?').run(
      companyId,
      kitId,
    );
    for (const c of componentes) {
      db.prepare(
        `INSERT INTO core_kit_components (id, company_id, kit_id, component_id, quantity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), companyId, kitId, c.componentId, c.quantity, ts, ts);
    }
    db.prepare('UPDATE core_products SET is_kit = ?, updated_at = ? WHERE id = ? AND company_id = ?')
      .run(componentes.length > 0 ? 1 : 0, ts, kitId, companyId);
  });

  return listKitComponents(companyId, kitId);
}

/** Custo do kit somando as peças — usado quando o cadastro pede isso. */
export function kitCostCents(companyId: string, kitId: string): number {
  return custoDoKit(
    listKitComponents(companyId, kitId).map((c) => ({
      quantity: c.quantity,
      costCents: c.cost_cents,
    })),
  );
}

// ------------------------------------------------- o produto sai da prateleira?

/**
 * ESTE PRODUTO MOVIMENTA ESTOQUE? (GAP-V02)
 *
 * ## O defeito
 *
 * Não existia produto SEM controle de estoque. Toda linha de venda que não
 * fosse kit desmembrado ia para `applyMovement`, e o `CHECK (quantity >= 0)` de
 * `core_stock` recusava a venda inteira por falta de saldo — de um serviço que
 * nunca teve saldo nem vai ter. Ajuste de bainha, instalação de acessório e
 * aplicação de película eram, pela tela, invendáveis: o contorno real do balcão
 * é lançar uma entrada fictícia, e ela suja o razão para sempre. Serviço só
 * existia dentro da OS da oficina (`serviceTotalCents`), que é outro fluxo,
 * com outra tela e outro prazo.
 *
 * ## Por que a pergunta mora aqui, e não em cada chamador
 *
 * Pelo mesmo motivo de `openPrice` em `PricingService`: quem vende, quem conta
 * inventário e quem lista posição precisam tomar a MESMA decisão, e três cópias
 * da regra divergem na primeira manutenção — o serviço sumiria da venda e
 * continuaria aparecendo na contagem, ou o contrário.
 *
 * ## Nulo é 1
 *
 * Linha gravada antes desta rodada não tem a coluna preenchida em banco que
 * subiu por reconciliação. Ausência quer dizer "controla", que é o que toda
 * linha existente sempre significou.
 */
export function produtoControlaEstoque(
  produto: { stock_control?: number | null } | null | undefined,
): boolean {
  return produto?.stock_control !== 0;
}

/**
 * A pergunta, pelo id, para quem só tem o id na mão.
 *
 * Produto que não existe responde `true`: quem não encontrou o cadastro tem de
 * levar a recusa de "produto não encontrado" do próprio chamador, e não uma
 * baixa silenciosamente pulada.
 */
export function produtoControlaEstoquePorId(companyId: string, productId: string): boolean {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT stock_control FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { stock_control?: number } | undefined;
  return produtoControlaEstoque(linha);
}

// ----------------------------------------------- preço por faixa de quantidade

export interface FaixaDePreco {
  id: string;
  product_id: string;
  min_quantity: number;
  price_cents: number;
  active: number;
}

/**
 * As faixas ATIVAS de um produto, da maior quantidade para a menor.
 *
 * A ordem é a da decisão: quem leva 12 satisfaz as faixas de 12, de 6 e de 3, e
 * a que vale é a de MAIOR piso — a mais vantajosa por construção, porque
 * comprar mais nunca pode sair mais caro por unidade. Ordenar do outro lado
 * obrigaria o chamador a varrer a lista inteira para descobrir isso.
 */
export function listPriceTiers(companyId: string, productId: string): FaixaDePreco[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT id, product_id, min_quantity, price_cents, active
         FROM core_product_price_tiers
        WHERE company_id = ? AND product_id = ?
        ORDER BY min_quantity DESC`,
    )
    .all(companyId, productId) as unknown as FaixaDePreco[];
}

/**
 * TODAS as faixas ativas da empresa, numa consulta só.
 *
 * Existe pelo mesmo motivo de `promocoesVigentes`: a vitrine e o carrinho
 * precificam muitos produtos de uma vez, e `node:sqlite` é síncrono no mesmo
 * processo que atende o balcão. A REGRA continua em `effectivePriceCents`; o
 * que muda é de onde vêm as linhas.
 */
export function faixasAtivasDaEmpresa(companyId: string): FaixaDePreco[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT id, product_id, min_quantity, price_cents, active
         FROM core_product_price_tiers
        WHERE company_id = ? AND active = 1
        ORDER BY min_quantity DESC`,
    )
    .all(companyId) as unknown as FaixaDePreco[];
}

/**
 * Cria ou corrige uma faixa. O piso é a CHAVE: regravar o mesmo piso troca o
 * preço, e não cria uma segunda resposta para a mesma pergunta.
 */
export function setPriceTier(
  companyId: string,
  productId: string,
  minQuantity: number,
  priceCents: number,
): FaixaDePreco[] {
  ensureCoreSchema();
  const db = getConnection();
  const produto = db
    .prepare('SELECT id, price_cents FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { id: string; price_cents: number } | undefined;
  if (!produto) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

  if (!Number.isFinite(minQuantity) || minQuantity <= 0) {
    throw new ApiError(
      'CORE_PRICE_TIER_QUANTITY',
      'A quantidade mínima da faixa deve ser maior que zero.',
      400,
    );
  }
  /*
    FAIXA A PARTIR DE 1 NÃO É FAIXA — é o preço de tabela com outro nome, e
    escrito em outro lugar. Aceitá-la criaria duas verdades sobre quanto custa
    uma unidade, e a segunda venceria calada em `effectivePriceCents`, sem
    aparecer no cadastro de preço nem em relatório nenhum.
  */
  if (minQuantity <= 1) {
    throw new ApiError(
      'CORE_PRICE_TIER_QUANTITY',
      'A faixa começa a partir de 2 unidades. Para mudar o preço de uma, altere o preço de venda.',
      400,
    );
  }
  // Centavo inteiro, como todo dinheiro desta casa. Zero é "de graça" e não é
  // negociação de volume — brinde é outro fluxo, com outro rastro.
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new ApiError(
      'CORE_PRICE_TIER_PRICE',
      'Preço da faixa inválido: informe um valor inteiro em centavos, maior que zero.',
      400,
    );
  }
  /*
    FAIXA MAIS CARA QUE O PREÇO DE VENDA é armadilha e não oferta: quem levasse
    três pagaria mais por unidade do que quem leva uma. E, como a disputa é
    pelo MENOR preço, ela nunca venceria — ficaria gravada, visível no cadastro
    e sem nenhum efeito, que é a definição do campo decorativo que esta casa
    remove em vez de manter.
  */
  if (priceCents > produto.price_cents) {
    throw new ApiError(
      'CORE_PRICE_TIER_ABOVE_LIST',
      'O preço da faixa é maior que o preço de venda: levar mais sairia mais caro por unidade.',
      400,
    );
  }

  const ts = agora();
  db.prepare(
    `INSERT INTO core_product_price_tiers
       (id, company_id, product_id, min_quantity, price_cents, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (product_id, min_quantity)
     DO UPDATE SET price_cents = excluded.price_cents, active = 1, updated_at = excluded.updated_at`,
  ).run(randomUUID(), companyId, productId, minQuantity, priceCents, ts, ts);

  return listPriceTiers(companyId, productId);
}

export function removePriceTier(
  companyId: string,
  productId: string,
  minQuantity: number,
): FaixaDePreco[] {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `DELETE FROM core_product_price_tiers
        WHERE company_id = ? AND product_id = ? AND min_quantity = ?`,
    )
    .run(companyId, productId, minQuantity);
  return listPriceTiers(companyId, productId);
}

// ------------------------------------------------------- campos personalizados

export interface CampoPersonalizado {
  id: string;
  code: string;
  label: string;
  kind: string;
  options: string | null;
  entity: string;
  position: number;
  active: number;
  /** Quantos produtos já têm este campo preenchido. */
  usage: number;
}

const TIPOS_DE_CAMPO = new Set(['text', 'number', 'date', 'select']);

export function listCustomFields(companyId: string, entity = 'product'): CampoPersonalizado[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT f.id, f.code, f.label, f.kind, f.options, f.entity, f.position, f.active,
              (SELECT COUNT(*) FROM core_custom_field_values v
                WHERE v.field_id = f.id AND v.value IS NOT NULL AND TRIM(v.value) <> '') AS usage
         FROM core_custom_fields f
        WHERE f.company_id = ? AND f.entity = ?
        ORDER BY f.position, f.label`,
    )
    .all(companyId, entity) as unknown as CampoPersonalizado[];
}

/**
 * Cria ou corrige a DEFINIÇÃO de um campo próprio da operação (GAP-V07).
 *
 * O código é imutável depois de criado, pela mesma razão do grupo tributário e
 * da unidade: é ele que o VALOR guarda, e trocá-lo órfã tudo o que já foi
 * preenchido. O rótulo, esse, se corrige à vontade — quem escreveu "Voltagen"
 * precisa poder consertar sem perder os cem produtos já preenchidos.
 */
export function upsertCustomField(
  companyId: string,
  input: Record<string, unknown> & { id?: string },
): CampoPersonalizado {
  ensureCoreSchema();
  const code = texto(input.code, 'o código do campo').toUpperCase().replace(/\s+/g, '_');
  const label = texto(input.label, 'o rótulo do campo');
  const kind = String(input.kind ?? 'text');
  if (!TIPOS_DE_CAMPO.has(kind)) {
    throw new ApiError(
      'CORE_CUSTOM_FIELD_KIND',
      'Tipo de campo inválido: use texto, número, data ou lista.',
      400,
    );
  }
  const entity = String(input.entity ?? 'product');
  /*
    LISTA SEM OPÇÃO É UM SELETOR VAZIO — o campo aparece no formulário e não
    deixa escolher nada. Recusar aqui é mais barato que descobrir na tela.
  */
  const options = String(input.options ?? '')
    .split(/\r?\n/)
    .map((o) => o.trim())
    .filter(Boolean);
  if (kind === 'select' && options.length === 0) {
    throw new ApiError(
      'CORE_CUSTOM_FIELD_OPTIONS',
      'Campo de lista precisa de pelo menos uma opção.',
      400,
    );
  }
  const active = input.active === false || input.active === 0 ? 0 : 1;
  const position = Number(input.position ?? 0) || 0;
  const db = getConnection();
  const ts = agora();

  if (input.id) {
    const atual = db
      .prepare('SELECT code FROM core_custom_fields WHERE id = ? AND company_id = ?')
      .get(input.id, companyId) as { code?: string } | undefined;
    if (!atual) throw new ApiError('CORE_CUSTOM_FIELD_NOT_FOUND', 'Campo não encontrado.', 404);
    if (atual.code !== code) {
      throw new ApiError(
        'CORE_CUSTOM_FIELD_CODE_IMMUTABLE',
        'O código não muda depois de criado: os valores gravados apontam para ele.',
        409,
      );
    }
    db.prepare(
      `UPDATE core_custom_fields
          SET label = ?, kind = ?, options = ?, position = ?, active = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(
      label,
      kind,
      options.length > 0 ? options.join('\n') : null,
      position,
      active,
      ts,
      input.id,
      companyId,
    );
  } else {
    const existe = db
      .prepare('SELECT id FROM core_custom_fields WHERE company_id = ? AND entity = ? AND code = ?')
      .get(companyId, entity, code);
    if (existe) {
      throw new ApiError('CORE_CUSTOM_FIELD_DUPLICATE', `Já existe o campo ${code}.`, 409);
    }
    db.prepare(
      `INSERT INTO core_custom_fields
         (id, company_id, code, label, kind, options, entity, position, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      companyId,
      code,
      label,
      kind,
      options.length > 0 ? options.join('\n') : null,
      entity,
      position,
      active,
      ts,
      ts,
    );
  }

  const salvo = listCustomFields(companyId, entity).find((f) => f.code === code);
  if (!salvo) throw new ApiError('CORE_CUSTOM_FIELD_NOT_FOUND', 'Campo não encontrado.', 404);
  return salvo;
}

/**
 * Apaga a DEFINIÇÃO — e, com ela, os valores.
 *
 * Recusa quando alguém já preencheu, como o grupo tributário em uso: apagar
 * levaria junto um dado que a operação digitou e que não está em mais lugar
 * nenhum. Desativar esconde do formulário e preserva o que existe.
 */
export function deleteCustomField(companyId: string, id: string): void {
  ensureCoreSchema();
  const db = getConnection();
  const alvo = db
    .prepare('SELECT id, entity FROM core_custom_fields WHERE id = ? AND company_id = ?')
    .get(id, companyId) as { id: string; entity: string } | undefined;
  if (!alvo) throw new ApiError('CORE_CUSTOM_FIELD_NOT_FOUND', 'Campo não encontrado.', 404);

  const preenchidos = db
    .prepare(
      `SELECT COUNT(*) AS n FROM core_custom_field_values
        WHERE field_id = ? AND value IS NOT NULL AND TRIM(value) <> ''`,
    )
    .get(id) as { n: number };
  if (preenchidos.n > 0) {
    throw new ApiError(
      'CORE_CUSTOM_FIELD_IN_USE',
      `${preenchidos.n} produto(s) já têm este campo preenchido. Desative em vez de excluir.`,
      409,
    );
  }
  db.prepare('DELETE FROM core_custom_fields WHERE id = ? AND company_id = ?').run(id, companyId);
}

export interface ValorPersonalizado {
  field_id: string;
  code: string;
  label: string;
  kind: string;
  options: string | null;
  value: string | null;
}

/**
 * A FICHA de campos próprios de uma entidade: a definição ATIVA junto do valor.
 *
 * LEFT JOIN pela definição, e não pelo valor: o formulário precisa mostrar o
 * campo vazio para que alguém possa preenchê-lo. Listar só o que já tem valor
 * faria o campo novo nunca aparecer.
 */
export function listCustomValues(
  companyId: string,
  entityId: string,
  entity = 'product',
): ValorPersonalizado[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT f.id AS field_id, f.code, f.label, f.kind, f.options, v.value
         FROM core_custom_fields f
         LEFT JOIN core_custom_field_values v
                ON v.field_id = f.id AND v.entity_id = ? AND v.entity = f.entity
        WHERE f.company_id = ? AND f.entity = ? AND f.active = 1
        ORDER BY f.position, f.label`,
    )
    .all(entityId, companyId, entity) as unknown as ValorPersonalizado[];
}

/**
 * O QUE MUDOU nos campos próprios, no MESMO formato da trilha do cadastro
 * (A-produto-18): `{ field, label, from, to }`.
 *
 * O PUT gravava `fields: ['VOLTAGEM']` — os códigos, sem de/para — e a aba
 * Histórico desenhava ": — → —" a cada Salvar, porque o formulário manda os
 * campos próprios junto com o cadastro. Comparando o antes com o depois, só o
 * que mudou de verdade entra; lista vazia = nada a registrar.
 */
export function diferencasDosCamposProprios(
  antes: ValorPersonalizado[],
  depois: ValorPersonalizado[],
): { field: string; label: string; from: string | null; to: string | null }[] {
  const limpo = (v: unknown) => {
    const t = v === null || v === undefined ? '' : String(v).trim();
    return t === '' ? null : t;
  };
  const anterior = new Map(antes.map((c) => [c.code, limpo(c.value)]));
  const mudancas: { field: string; label: string; from: string | null; to: string | null }[] = [];
  for (const campo of depois) {
    const de = anterior.has(campo.code) ? (anterior.get(campo.code) ?? null) : null;
    const para = limpo(campo.value);
    if (de === para) continue;
    mudancas.push({ field: `custom:${campo.code}`, label: campo.label, from: de, to: para });
  }
  return mudancas;
}

/**
 * Grava os valores de campo próprio de um produto.
 *
 * Recebe o mapa `{ CODIGO: valor }` e escreve só o que o mapa MENCIONA: o
 * formulário manda o objeto inteiro, mas uma integração pode mandar um campo
 * só, e apagar o resto por omissão seria destruir dado que ninguém mandou
 * apagar. Valor vazio LIMPA — é como se tira um atributo que não se aplica mais.
 */
export function setCustomValues(
  companyId: string,
  entityId: string,
  valores: Record<string, unknown>,
  entity = 'product',
): ValorPersonalizado[] {
  ensureCoreSchema();
  const db = getConnection();

  /*
    O PRODUTO É DA MESMA OPERAÇÃO (P00-prod-04).

    O DEFEITO: `entityId` vinha da URL e ia direto para o INSERT. As definições
    eram conferidas pela empresa da sessão, mas a ENTIDADE não: bastava a outra
    loja ter um campo com o mesmo código ("VOLTAGEM" é o exemplo do próprio
    cadastro) para ela gravar valores presos ao id de um produto que não é dela
    — e lê-los de volta, porque `listCustomValues` procura pelos campos DELA. É
    o mesmo buraco de `addProductBarcode`, na mesa ao lado.

    A conferência vale para a entidade 'product', que é a única que existe hoje.
    A entidade nova que vier declara a própria porta em vez de herdar uma regra
    que não a descreve — e é por isso que a condição nomeia o caso em vez de
    procurar numa tabela qualquer.
  */
  if (entity === 'product') {
    const dono = db
      .prepare('SELECT id FROM core_products WHERE id = ? AND company_id = ?')
      .get(entityId, companyId) as { id?: string } | undefined;
    if (!dono?.id) {
      throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
    }
  }

  const definicoes = db
    .prepare(
      `SELECT id, code, kind, options FROM core_custom_fields
        WHERE company_id = ? AND entity = ? AND active = 1`,
    )
    .all(companyId, entity) as unknown as {
      id: string;
      code: string;
      kind: string;
      options: string | null;
    }[];

  const ts = agora();
  withTransaction(() => {
    for (const [codigo, bruto] of Object.entries(valores ?? {})) {
      const campo = definicoes.find((d) => d.code === String(codigo).toUpperCase());
      /*
        CÓDIGO QUE NÃO EXISTE É RECUSA, e não silêncio. Ignorar seria a
        requisição que devolve 200 e não faz — o defeito que esta casa
        persegue: quem digitou "voltage" em vez de "VOLTAGEM" veria "salvo" e
        o valor não estaria em lugar nenhum.
      */
      if (!campo) {
        throw new ApiError(
          'CORE_CUSTOM_FIELD_NOT_FOUND',
          `Não existe campo personalizado com o código ${codigo} nesta operação.`,
          404,
        );
      }
      const valor = String(bruto ?? '').trim();
      if (!valor) {
        db.prepare('DELETE FROM core_custom_field_values WHERE field_id = ? AND entity_id = ?').run(
          campo.id,
          entityId,
        );
        continue;
      }
      /*
        O TIPO É CONFERIDO NA GRAVAÇÃO porque o valor mora como texto: sem esta
        porta, "doze" entraria num campo de número e só quebraria no relatório
        que somasse, longe de quem digitou.

        A data usa o formato de calendário AAAA-MM-DD, e não instante: campo
        próprio de produto responde "que dia", não "que momento" — e converter
        para instante aqui recuaria um dia na exibição, que é uma mordida que
        este projeto já levou duas vezes.
      */
      if (campo.kind === 'number' && !Number.isFinite(Number(valor.replace(',', '.')))) {
        throw new ApiError(
          'CORE_CUSTOM_FIELD_VALUE',
          `O campo ${campo.code} é numérico e recebeu "${valor}".`,
          400,
        );
      }
      if (campo.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        throw new ApiError(
          'CORE_CUSTOM_FIELD_VALUE',
          `O campo ${campo.code} é uma data e espera o formato AAAA-MM-DD.`,
          400,
        );
      }
      if (campo.kind === 'select') {
        const opcoes = String(campo.options ?? '')
          .split(/\r?\n/)
          .map((o) => o.trim())
          .filter(Boolean);
        if (!opcoes.includes(valor)) {
          throw new ApiError(
            'CORE_CUSTOM_FIELD_VALUE',
            `"${valor}" não é uma das opções de ${campo.code}: ${opcoes.join(', ')}.`,
            400,
          );
        }
      }
      db.prepare(
        `INSERT INTO core_custom_field_values
           (id, company_id, field_id, entity, entity_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (field_id, entity_id)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(randomUUID(), companyId, campo.id, entity, entityId, valor, ts);
    }
  });

  return listCustomValues(companyId, entityId, entity);
}

// ------------------------------------------------------ etiqueta da balança

/**
 * A ETIQUETA QUE A BALANÇA IMPRIME, LIDA NO BALCÃO (D-pdv-teclado-16).
 *
 * ## O defeito
 *
 * A balança de varejo imprime um EAN-13 próprio: prefixo, PLU do produto e o
 * PESO (ou o PREÇO) embutido, mais o verificador. O produto já guarda o PLU
 * (`plu_code`, único por empresa), mas a busca do balcão só casava código
 * CADASTRADO: bipar a etiqueta do tomate dava "nenhum produto encontrado", e o
 * operador pesava de novo ou digitava o peso na mão.
 *
 * ## Por que uma subfaixa DECLARADA, e não "todo código que começa com 2"
 *
 * O próprio sistema gera EAN-13 interno com prefixo 2 (`BarcodeService`,
 * "2" + sequência + verificador — na prática, sempre "20…"). Decodificar todo
 * "2…" como balança transformaria a etiqueta interna de uma camiseta num PLU
 * e num peso inventados. Por isso a leitura só existe quando a operação DECLARA
 * como a balança dela monta o código: prefixo de DOIS dígitos (21 a 29 — o 20 é
 * o do gerador interno e é recusado), quantos dígitos tem o PLU (4 ou 5), e se
 * o valor que vem depois é peso em gramas ou preço em centavos. O valor ocupa o
 * que sobra até o verificador: 6 dígitos com PLU de 4, 5 com PLU de 5.
 *
 * Sem declaração, NADA muda: a busca continua exatamente como era.
 *
 * ## Por que uma tabela tipada, e criada aqui
 *
 * O schema recusa chave/valor (ver o comentário de `core_sale_policies`): com
 * texto livre, "vinte e três" viraria configuração que ninguém lê. A tabela
 * abaixo segue o mesmo desenho — uma linha por empresa, colunas com CHECK — e
 * nasce na primeira gravação (`CREATE TABLE IF NOT EXISTS`), para funcionar
 * sem migração. A leitura NÃO cria nada: sem a tabela, é "sem declaração".
 * O DDL é exportado para o schema canônico poder adotá-lo tal como está.
 */
export type ValorEmbutidoNaBalanca = 'peso' | 'preco';

export interface ConfigDaEtiquetaDaBalanca {
  /** Os dois primeiros dígitos da etiqueta, de "21" a "29". */
  prefixo: string;
  /** Quantos dígitos do PLU vêm logo depois do prefixo. */
  digitosDoPlu: 4 | 5;
  /** O que vem depois do PLU, até o verificador. */
  valorEmbutido: ValorEmbutidoNaBalanca;
}

export const TABELA_DA_ETIQUETA_DA_BALANCA = 'core_scale_label_settings';

export const DDL_DA_ETIQUETA_DA_BALANCA = `CREATE TABLE IF NOT EXISTS core_scale_label_settings (
     company_id     TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     -- Os dois primeiros dígitos da etiqueta. 21 a 29: a faixa 2x do GS1 é de
     -- circulação interna, e o 20 é a dos códigos que o próprio sistema gera
     -- para produto sem EAN — declarar o 20 faria a etiqueta interna de um
     -- produto qualquer ser lida como PLU e peso.
     prefix         TEXT NOT NULL CHECK (prefix GLOB '2[1-9]'),
     -- Quantos dígitos do PLU vêm depois do prefixo. O valor ocupa o resto até
     -- o verificador: 6 dígitos com PLU de 4, 5 com PLU de 5.
     plu_digits     INTEGER NOT NULL CHECK (plu_digits IN (4, 5)),
     -- 'peso': gramas (0,352 kg vem como 000352). 'preco': centavos do total
     -- que a balança calculou (R$ 19,90 vem como 001990).
     embedded_value TEXT NOT NULL CHECK (embedded_value IN ('peso', 'preco')),
     updated_at     TEXT NOT NULL,
     updated_by     TEXT
   )`;

function tabelaDaBalancaExiste(): boolean {
  return Boolean(
    getConnection()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(TABELA_DA_ETIQUETA_DA_BALANCA),
  );
}

/** A declaração da operação, ou nulo — e nulo é "a busca de sempre". */
export function lerConfigDaEtiquetaDaBalanca(companyId: string): ConfigDaEtiquetaDaBalanca | null {
  ensureCoreSchema();
  if (!tabelaDaBalancaExiste()) return null;
  const row = getConnection()
    .prepare(
      `SELECT prefix, plu_digits, embedded_value FROM ${TABELA_DA_ETIQUETA_DA_BALANCA}
        WHERE company_id = ?`,
    )
    .get(companyId) as { prefix: string; plu_digits: number; embedded_value: string } | undefined;
  if (!row) return null;
  return {
    prefixo: row.prefix,
    digitosDoPlu: row.plu_digits === 5 ? 5 : 4,
    valorEmbutido: row.embedded_value === 'preco' ? 'preco' : 'peso',
  };
}

/**
 * Grava (ou, com `null`, apaga) a declaração da etiqueta da balança.
 *
 * Tudo é conferido antes de gravar, com a frase de como resolver: um prefixo
 * errado não dá erro nenhum adiante — a etiqueta simplesmente não é lida, e o
 * operador conclui que "a balança não funciona com o sistema".
 */
export function gravarConfigDaEtiquetaDaBalanca(
  companyId: string,
  input: { prefixo?: unknown; digitosDoPlu?: unknown; valorEmbutido?: unknown } | null,
  userId: string | null = null,
): ConfigDaEtiquetaDaBalanca | null {
  ensureCoreSchema();
  const db = getConnection();
  db.exec(DDL_DA_ETIQUETA_DA_BALANCA);

  if (input === null) {
    db.prepare(`DELETE FROM ${TABELA_DA_ETIQUETA_DA_BALANCA} WHERE company_id = ?`).run(companyId);
    return null;
  }

  const prefixo = String(input.prefixo ?? '').trim();
  if (prefixo === '20') {
    throw new ApiError(
      'CORE_SCALE_PREFIX_RESERVED',
      'O prefixo 20 é o dos códigos de barras internos que o sistema gera para produto sem EAN (ex.: 2000000000015). '
        + 'Configure a balança para imprimir a etiqueta com um prefixo de 21 a 29 e informe o mesmo aqui.',
      400,
    );
  }
  if (!/^2[1-9]$/.test(prefixo)) {
    throw new ApiError(
      'CORE_SCALE_PREFIX_INVALID',
      'O prefixo da etiqueta da balança tem dois dígitos, de 21 a 29: é o começo do código que a balança imprime. '
        + 'Confira no menu ou no manual da balança.',
      400,
    );
  }
  const digitos = Number(input.digitosDoPlu);
  if (digitos !== 4 && digitos !== 5) {
    throw new ApiError(
      'CORE_SCALE_PLU_DIGITS_INVALID',
      'O PLU na etiqueta da balança tem 4 ou 5 dígitos. Confira como a balança monta o código: prefixo, PLU e o valor.',
      400,
    );
  }
  const valor = String(input.valorEmbutido ?? '').trim().toLowerCase();
  if (valor !== 'peso' && valor !== 'preco') {
    throw new ApiError(
      'CORE_SCALE_EMBEDDED_VALUE_INVALID',
      'Diga o que a balança põe na etiqueta depois do PLU: "peso" (em gramas) ou "preco" (o total, em centavos).',
      400,
    );
  }

  /*
    A FAIXA JÁ OCUPADA NÃO É DECLARADA.

    Um código de barras cadastrado que começa com o prefixo (etiqueta de um
    sistema antigo, código interno de outro fornecedor) teria duas leituras: o
    produto dele e "PLU + valor". E o gerador de EAN interno, quando esbarra num
    número ocupado, salta para depois do MAIOR código "2…" cadastrado — que
    estaria dentro da faixa da balança. Recusar aqui mantém a faixa só dela.
  */
  const padrao = `${prefixo}${'[0-9]'.repeat(11)}`;
  const ocupado = db
    .prepare(
      `SELECT p.name, x.barcode FROM (
         SELECT id AS product_id, barcode FROM core_products WHERE company_id = ? AND barcode GLOB ?
         UNION ALL
         SELECT product_id, barcode FROM core_product_barcodes WHERE company_id = ? AND barcode GLOB ?
       ) x JOIN core_products p ON p.id = x.product_id
       LIMIT 1`,
    )
    .get(companyId, padrao, companyId, padrao) as { name: string; barcode: string } | undefined;
  if (ocupado) {
    throw new ApiError(
      'CORE_SCALE_PREFIX_IN_USE',
      `O código de barras ${ocupado.barcode}, do produto "${ocupado.name}", já começa com ${prefixo}. `
        + 'Com a balança nessa faixa, o bipe desse produto e a etiqueta da balança se confundiriam. '
        + 'Escolha na balança outro prefixo de 21 a 29, ou troque esse código no cadastro do produto.',
      409,
    );
  }

  db.prepare(
    `INSERT INTO ${TABELA_DA_ETIQUETA_DA_BALANCA}
       (company_id, prefix, plu_digits, embedded_value, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET
       prefix = excluded.prefix, plu_digits = excluded.plu_digits,
       embedded_value = excluded.embedded_value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(companyId, prefixo, digitos, valor, agora(), userId);
  return lerConfigDaEtiquetaDaBalanca(companyId);
}

export interface EtiquetaDaBalancaLida {
  /** O PLU como veio impresso, com os zeros à esquerda. */
  plu: string;
  /** O PLU sem os zeros à esquerda — "0105" e "105" são o mesmo número para a balança. */
  pluSemZeros: string;
  /** Gramas (peso) ou centavos (preço), conforme a declaração. */
  valor: number;
}

/**
 * Lê uma etiqueta da balança segundo a declaração — sem banco, só a conta.
 *
 * Nulo para tudo que não é etiqueta DESTA balança: outro comprimento, outro
 * prefixo, verificador errado (a leitora pode ter errado um dígito), PLU zerado
 * ou valor zero. Na dúvida, não inventa peso nenhum.
 */
export function lerEtiquetaDaBalanca(
  config: ConfigDaEtiquetaDaBalanca,
  codigo: string,
): EtiquetaDaBalancaLida | null {
  const c = String(codigo ?? '').trim();
  if (!/^\d{13}$/.test(c) || !c.startsWith(config.prefixo) || !gtinValido(c)) return null;
  const inicio = config.prefixo.length;
  const plu = c.slice(inicio, inicio + config.digitosDoPlu);
  const pluSemZeros = plu.replace(/^0+/, '');
  const valor = Number(c.slice(inicio + config.digitosDoPlu, 12));
  if (!pluSemZeros || !Number.isFinite(valor) || valor <= 0) return null;
  return { plu, pluSemZeros, valor };
}

/**
 * O código cai na faixa que a balança desta operação usa?
 *
 * É a pergunta que o gerador de EAN interno precisa fazer antes de entregar um
 * número (D-pdv-teclado-16): um EAN interno dentro da faixa seria lido como
 * etiqueta da balança quando não houvesse casamento exato.
 */
export function codigoNaFaixaDaBalanca(companyId: string, codigo: string): boolean {
  const config = lerConfigDaEtiquetaDaBalanca(companyId);
  return Boolean(config && /^\d{13}$/.test(codigo) && codigo.startsWith(config.prefixo));
}
