/**
 * Comissão de venda.
 *
 * ## A decisão: fato gravado, não conta refeita
 *
 * O saldo por local (rodada 6) e o saldo da conta (rodada 9) são DERIVADOS, e
 * por bons motivos. Comissão é diferente por uma razão só, e ela decide:
 * A REGRA MUDA COM O TEMPO.
 *
 * Se o dono subir o percentual em março, uma apuração derivada recalcularia
 * fevereiro — que já foi pago. Dinheiro que saiu não muda de valor depois.
 * Por isso `base_cents` e `rate_bps` são copiados para a linha no momento da
 * venda: ela responde sozinha, para sempre, sem depender do cadastro de hoje.
 *
 * ## O estorno nasce junto, não depois
 *
 * Venda cancelada e devolução geram linha NEGATIVA, com a mesma origem. A
 * positiva original fica onde está — foi o que aconteceu, e apagar esconderia
 * do vendedor por que a comissão dele mudou.
 *
 * Comissão que só sabe somar paga o vendedor duas vezes na primeira venda
 * cancelada, e é o erro mais difícil de consertar depois: o dinheiro já saiu.
 *
 * ## A base é o líquido do desconto de cabeçalho
 *
 * `subtotal - desconto`, e não o total. O acréscimo (juros de cartão, frete)
 * não entra: não é mérito de venda. E o denominador do estorno proporcional é
 * essa MESMA base: desde o GAP-PRD-009 a devolução devolve o líquido do rateio
 * do desconto de cabeçalho, e a venda devolvida inteira estorna a comissão
 * inteira — dividir pelo total (ou pelo subtotal bruto) estornaria a menos em
 * toda venda com desconto de balcão.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { diaDaLojaSql, hojeNaLoja } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';
import { createEntry } from './FinanceService.js';
import { systemCategoryId } from './FinanceSetupService.js';
// O vínculo é a régua de quem atravessa empresa — ver `setMemberGroup`.
import { assertMembership } from '../auth/IdentityService.js';

const agora = () => new Date().toISOString();
const hoje = () => hojeNaLoja();

export interface CommissionGroup {
  id: string;
  company_id: string;
  name: string;
  active: number;
}

export interface CommissionTier {
  id: string;
  group_id: string;
  min_cents: number;
  rate_bps: number;
}

export interface CommissionEntry {
  id: string;
  company_id: string;
  seller_id: string;
  sale_id: string | null;
  origin_type: string;
  origin_id: string;
  base_cents: number;
  rate_bps: number;
  amount_cents: number;
  status: 'aberto' | 'fechado';
  competence_date: string;
  note: string | null;
}

// ------------------------------------------------------------ grupos e faixas

export function listGroups(companyId: string, includeInactive = false): CommissionGroup[] {
  ensureCoreSchema();
  const filtro = includeInactive ? '' : ' AND active = 1';
  return getConnection()
    .prepare(
      `SELECT * FROM core_commission_groups
        WHERE company_id = ?${filtro} ORDER BY name COLLATE NOCASE`,
    )
    .all(companyId) as unknown as CommissionGroup[];
}

export function createGroup(companyId: string, name: string): CommissionGroup {
  ensureCoreSchema();
  const limpo = String(name ?? '').trim();
  if (!limpo) throw new ApiError('CORE_COMMISSION_NAME', 'Informe o nome do grupo.', 400);
  const db = getConnection();
  const id = randomUUID();
  const ts = agora();
  try {
    db.prepare(
      `INSERT INTO core_commission_groups (id, company_id, name, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(id, companyId, limpo, ts, ts);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new ApiError('CORE_COMMISSION_DUPLICATE', `Já existe o grupo "${limpo}".`, 409);
    }
    throw err;
  }
  return db
    .prepare('SELECT * FROM core_commission_groups WHERE id = ?')
    .get(id) as unknown as CommissionGroup;
}

/**
 * Renomear ou desativar um grupo.
 *
 * Desativar NÃO apaga: as linhas já apuradas apontam para faixas dele, e o
 * histórico precisa continuar explicável. Grupo inativo simplesmente para de
 * comissionar — `faixaPara` exige `g.active = 1`.
 */
export function updateGroup(
  companyId: string,
  id: string,
  input: { name?: string; active?: boolean },
): CommissionGroup {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT id FROM core_commission_groups WHERE id = ? AND company_id = ?')
    .get(id, companyId);
  if (!atual) throw new ApiError('CORE_COMMISSION_GROUP_NOT_FOUND', 'Grupo não encontrado.', 404);

  db.prepare(
    `UPDATE core_commission_groups
        SET name = COALESCE(?, name), active = COALESCE(?, active), updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    input.name?.trim() || null,
    input.active === undefined ? null : input.active ? 1 : 0,
    agora(),
    id,
    companyId,
  );
  return db
    .prepare('SELECT * FROM core_commission_groups WHERE id = ?')
    .get(id) as unknown as CommissionGroup;
}

export function listTiers(companyId: string, groupId: string): CommissionTier[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_commission_tiers
        WHERE company_id = ? AND group_id = ? ORDER BY min_cents`,
    )
    .all(companyId, groupId) as unknown as CommissionTier[];
}

/**
 * ============================================================================
 * O DEFEITO: A FAIXA ENTRAVA NO GRUPO DA VIZINHA
 * ============================================================================
 *
 * `setTier` recebia `groupId` do caminho da rota (`PUT
 * /commissions/groups/:id/tiers`) e NUNCA conferia de quem é o grupo — o irmão
 * ao lado, `setMemberGroup`, confere na linha seguinte à sua, com a mesma
 * consulta. A conferência nasceu num e não no outro, e o silêncio durou.
 *
 * As três consequências, todas medidas pelo HTTP:
 *
 *  1. TRAVESSIA DE EMPRESA, NA ESCRITA. A busca por faixa existente filtra por
 *     `company_id`, logo nunca acha a da vizinha e cai no INSERT. O INSERT
 *     grava `company_id` da SESSÃO e `group_id` da OUTRA empresa — a chave
 *     estrangeira aponta para `core_commission_groups(id)` sem empresa
 *     nenhuma, então o banco aceita. A gerente da Preço Justo escrevia uma
 *     linha pendurada no grupo de comissão da Gringa, e a linha ficava lá:
 *     `DELETE ... ON CASCADE` do grupo da Gringa passa a apagar dado da Preço
 *     Justo, e a apuração da Preço Justo carrega uma faixa de um grupo que ela
 *     não enxerga (`listTiers` filtra pelas duas colunas e não a devolve).
 *
 *  2. ORÁCULO DE EXISTÊNCIA ENTRE EMPRESAS. `UNIQUE (group_id, min_cents)` é
 *     do GRUPO, não da empresa. Repetir o mesmo `minCents` de uma faixa que a
 *     vizinha já tem estourava UNIQUE e virava 500; um valor que ela não tem
 *     dava 200. Dois status diferentes contam ao de fora o que a vizinha
 *     cadastrou — exatamente o oráculo que a regra do grupo proíbe.
 *
 *  3. 500 ONDE O CERTO É 404. Grupo inexistente estourava a chave estrangeira
 *     e subia como `API_UNAVAILABLE` com pilha no log. A varredura de perfis
 *     do RBAC imprimia esse erro em CINCO arquivos a cada corrida, e ninguém
 *     lia: erro que sempre aparece é erro que ninguém vê.
 *
 * O conserto é a conferência que `setMemberGroup` já fazia, na mesma frase e
 * com o mesmo código de erro: grupo de outra empresa responde IGUAL a grupo
 * inexistente — 404, sem contar qual dos dois é.
 */
function grupoDaEmpresa(companyId: string, groupId: string): void {
  const grupo = getConnection()
    .prepare('SELECT id FROM core_commission_groups WHERE id = ? AND company_id = ?')
    .get(groupId, companyId);
  if (!grupo) throw new ApiError('CORE_COMMISSION_GROUP_NOT_FOUND', 'Grupo não encontrado.', 404);
}

export function setTier(
  companyId: string,
  groupId: string,
  minCents: number,
  rateBps: number,
): CommissionTier {
  ensureCoreSchema();
  if (!Number.isInteger(minCents) || minCents < 0) {
    throw new ApiError('CORE_COMMISSION_TIER', 'Valor inicial da faixa inválido.', 400);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new ApiError('CORE_COMMISSION_RATE', 'Percentual inválido.', 400);
  }
  grupoDaEmpresa(companyId, groupId);
  const db = getConnection();
  const existente = db
    .prepare(
      'SELECT id FROM core_commission_tiers WHERE company_id = ? AND group_id = ? AND min_cents = ?',
    )
    .get(companyId, groupId, minCents) as { id: string } | undefined;

  if (existente) {
    db.prepare('UPDATE core_commission_tiers SET rate_bps = ? WHERE id = ?').run(
      rateBps,
      existente.id,
    );
    return db
      .prepare('SELECT * FROM core_commission_tiers WHERE id = ?')
      .get(existente.id) as unknown as CommissionTier;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_commission_tiers (id, company_id, group_id, min_cents, rate_bps, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, companyId, groupId, minCents, rateBps, agora());
  return db
    .prepare('SELECT * FROM core_commission_tiers WHERE id = ?')
    .get(id) as unknown as CommissionTier;
}

/**
 * SUCESSO FALSO: "Faixa removida." sobre uma faixa que continuou lá.
 *
 * O DELETE é escopado por `company_id` (e tem de ser), mas o resultado nunca
 * era olhado: apagar uma linha e não apagar nada devolviam o mesmo 204, e a
 * tela dizia "Faixa removida." nos dois casos. Some justamente no caso em que
 * a pessoa mais precisa saber que nada aconteceu — a faixa órfã que o defeito
 * antigo de `setTier` gravou com a empresa da vizinha, que a dona do grupo vê
 * pagar comissão e não consegue tirar.
 *
 * Não apagou nada é 404, o mesmo de um id que não existe em empresa nenhuma:
 * dizer "essa faixa existe, mas não é sua" contaria ao de fora o que a vizinha
 * cadastrou — é a mesma régua de `grupoDaEmpresa`.
 */
export function removeTier(companyId: string, tierId: string): void {
  ensureCoreSchema();
  const r = getConnection()
    .prepare('DELETE FROM core_commission_tiers WHERE id = ? AND company_id = ?')
    .run(tierId, companyId);
  if (Number(r.changes ?? 0) === 0) {
    throw new ApiError('CORE_COMMISSION_TIER_NOT_FOUND', 'Faixa não encontrada.', 404);
  }
}

// ---------------------------------------------------------------- vendedores

/**
 * O DEFEITO DO OUTRO LADO DA MESMA ROTA: o GRUPO era conferido, a PESSOA não.
 *
 * `PUT /commissions/members/:userId` tira o id da equipe do caminho, e a tela
 * que o chama só lista gente da própria operação — mas a rota é HTTP, e quem
 * digita o id manda quem quiser. Com um id de fora do vínculo, a linha nascia
 * assim mesmo: `core_commission_members` referencia `core_users(id)`, que é a
 * tabela do grupo INTEIRO, então o banco aceitava o mecânico da Oficina como
 * vendedor comissionado da Preço Justo. Duas consequências: a apuração da
 * Preço Justo passava a nomear gente que nunca vendeu nela, e a linha
 * sobrevivia ao desligamento da pessoa na outra operação.
 *
 * A régua é a mesma do resto do sistema — quem atravessa empresa é o VÍNCULO:
 * `assertMembership` lê `core_user_companies` (com a empresa ativa). Sem
 * vínculo, 404 igual ao de quem não existe: dizer "esse usuário existe, mas
 * não é daqui" contaria ao de fora quem trabalha na vizinha.
 */
export function setMemberGroup(companyId: string, userId: string, groupId: string | null): void {
  ensureCoreSchema();
  const db = getConnection();

  /*
    TIRAR A COMISSÃO NÃO PASSA PELO VÍNCULO — e por um motivo de dinheiro.

    A conferência de vínculo nasceu na frente anterior ANTES deste ramo, e o
    ramo é o DELETE. Quem foi desligado da operação (`removerDaOperacao` apaga
    `core_user_companies` e não toca em `core_commission_members`) ficava com
    uma linha de comissão que rota nenhuma removia: o PUT com `groupId: null`
    respondia 404 e a linha continuava lá, `faixaPara` continuava resolvendo a
    faixa dela, e uma readmissão a ressuscitava comissionando sem ninguém ter
    decidido. Era o único caminho de limpeza que existia, e ele fechou.

    Guardar o DELETE não fecha oráculo algum: ele já é escopado por
    `company_id` + `user_id`, apaga no máximo uma linha DESTA empresa, e a rota
    responde 200 para qualquer id — apagar nada e apagar uma linha são
    indistinguíveis de fora. O guarda continua valendo para ATRIBUIR, que é o
    ato que faz uma pessoa de fora aparecer na apuração daqui.
  */
  if (!groupId) {
    db.prepare('DELETE FROM core_commission_members WHERE company_id = ? AND user_id = ?').run(
      companyId,
      userId,
    );
    return;
  }
  if (!assertMembership(userId, companyId)) {
    throw new ApiError('CORE_COMMISSION_MEMBER_NOT_FOUND', 'Pessoa não encontrada na equipe desta operação.', 404);
  }
  grupoDaEmpresa(companyId, groupId);

  db.prepare(
    `INSERT INTO core_commission_members (company_id, user_id, group_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (company_id, user_id) DO UPDATE SET group_id = excluded.group_id`,
  ).run(companyId, userId, groupId, agora());
}

export function listMembers(companyId: string): { user_id: string; group_id: string }[] {
  ensureCoreSchema();
  return getConnection()
    .prepare('SELECT user_id, group_id FROM core_commission_members WHERE company_id = ?')
    .all(companyId) as unknown as { user_id: string; group_id: string }[];
}

/**
 * A faixa que vale para um valor: a maior cujo mínimo o valor alcança.
 *
 * Sem faixa que cubra, devolve nulo — e quem chama NÃO cria linha. Vendedor
 * sem regra não é erro que derruba a venda; é venda sem comissão, e ela
 * aparece contada no balde da apuração.
 */
function faixaPara(companyId: string, userId: string, baseCents: number): CommissionTier | null {
  /*
    A EMPRESA ENTRA NOS DOIS JUNTAS — é dinheiro e é isolamento.

    O `JOIN` juntava a faixa SÓ pelo grupo (`t.group_id = g.id`), e o grupo só
    pelo id (`g.id = m.group_id`). Uma faixa órfã — as que o defeito antigo de
    `setTier` gravava, com `company_id` da vizinha e `group_id` daqui — é
    INVISÍVEL para `listTiers` (que filtra pelas duas colunas) e para
    `removeTier` (idem), mas ENTRAVA nesta apuração: medido, uma faixa de 50%
    escrita assim pagou 1000 centavos numa venda onde a tela prometia 20 (1%),
    sem aparecer em GET /core/commissions/setup e sem sair pelo DELETE da dona
    do grupo.

    O guarda de `setTier` impede que faixas assim NASÇAM; ele não enxerga nem
    limpa as que qualquer banco anterior ao conserto já tenha. Amarrar a
    empresa aqui é a defesa em profundidade que neutraliza o resíduo: faixa e
    grupo têm de ser da MESMA empresa do vínculo que está sendo apurado.
  */
  const row = getConnection()
    .prepare(
      `SELECT t.* FROM core_commission_members m
         JOIN core_commission_groups g
           ON g.id = m.group_id AND g.company_id = m.company_id AND g.active = 1
         JOIN core_commission_tiers t
           ON t.group_id = g.id AND t.company_id = m.company_id
        WHERE m.company_id = ? AND m.user_id = ? AND t.min_cents <= ?
        ORDER BY t.min_cents DESC
        LIMIT 1`,
    )
    .get(companyId, userId, baseCents) as CommissionTier | undefined;
  return row ?? null;
}

// -------------------------------------------------------------- apuração

function gravarLinha(linha: {
  companyId: string;
  sellerId: string;
  saleId: string | null;
  originType: string;
  originId: string;
  baseCents: number;
  rateBps: number;
  amountCents: number;
  competenceDate: string;
  note?: string | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_commission_entries
         (id, company_id, seller_id, sale_id, origin_type, origin_id, base_cents,
          rate_bps, amount_cents, status, competence_date, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto', ?, ?, ?)
       ON CONFLICT (company_id, origin_type, origin_id, seller_id) DO NOTHING`,
    )
    .run(
      randomUUID(),
      linha.companyId,
      linha.sellerId,
      linha.saleId,
      linha.originType,
      linha.originId,
      linha.baseCents,
      linha.rateBps,
      linha.amountCents,
      linha.competenceDate,
      linha.note ?? null,
      agora(),
    );
}

/**
 * Registra a comissão de uma venda. Chamada de DENTRO da transação da venda.
 *
 * Falha em silêncio de propósito quando não há regra: numa loja, parar de
 * vender é o pior desfecho, e a ausência de cadastro de comissão não pode
 * derrubar o balcão. O que não pode é a venda sumir da apuração — por isso a
 * tela de apuração conta e soma as vendas sem comissão num balde à parte.
 */
export function registrarComissaoDaVenda(input: {
  companyId: string;
  saleId: string;
  sellerId: string | null;
  /** Subtotal MENOS desconto de cabeçalho. O acréscimo não entra. */
  baseCents: number;
  competenceDate?: string;
}): void {
  ensureCoreSchema();
  if (!input.sellerId || input.baseCents <= 0) return;

  const faixa = faixaPara(input.companyId, input.sellerId, input.baseCents);
  if (!faixa) return;

  const valor = Math.round((input.baseCents * faixa.rate_bps) / 10_000);
  if (valor <= 0) return;

  gravarLinha({
    companyId: input.companyId,
    sellerId: input.sellerId,
    saleId: input.saleId,
    originType: 'sale',
    originId: input.saleId,
    baseCents: input.baseCents,
    rateBps: faixa.rate_bps,
    amountCents: valor,
    competenceDate: input.competenceDate ?? hoje(),
  });
}

/** O que ainda está vivo de comissão daquela venda — positivo menos estornos. */
function saldoVivoDaVenda(companyId: string, saleId: string): { seller: string; total: number }[] {
  return getConnection()
    .prepare(
      `SELECT seller_id AS seller, SUM(amount_cents) AS total
         FROM core_commission_entries
        WHERE company_id = ? AND sale_id = ?
        GROUP BY seller_id
       HAVING SUM(amount_cents) <> 0`,
    )
    .all(companyId, saleId) as unknown as { seller: string; total: number }[];
}

/**
 * Cancelamento: estorna o que ainda estava vivo.
 *
 * Usa o SALDO, e não a linha original: se já houve devolução parcial, o
 * estorno do cancelamento leva só o que sobrou. Sem isso, devolver metade e
 * depois cancelar tiraria mais do que se pagou.
 */
export function estornarComissaoDaVenda(input: {
  companyId: string;
  saleId: string;
  motivo?: string | null;
}): void {
  ensureCoreSchema();
  for (const { seller, total } of saldoVivoDaVenda(input.companyId, input.saleId)) {
    gravarLinha({
      companyId: input.companyId,
      sellerId: seller,
      saleId: input.saleId,
      originType: 'sale_cancel',
      originId: input.saleId,
      baseCents: 0,
      rateBps: 0,
      amountCents: -total,
      competenceDate: hoje(),
      note: input.motivo ?? 'Venda cancelada',
    });
  }
}

/**
 * Devolução: estorna a proporção devolvida DA COMISSÃO ORIGINAL.
 *
 * O percentual usado é o da LINHA ORIGINAL, não o da faixa de hoje — a regra
 * pode ter mudado entre a venda e a devolução, e o que se desfaz é o que foi
 * pago.
 *
 * ## O RESÍDUO QUE A CONTA ANTIGA DEIXAVA
 *
 * A proporção era aplicada sobre o SALDO VIVO, e não sobre a comissão
 * original. Devolvendo metade duas vezes:
 *
 *     venda R$ 1.000, comissão 10% = R$ 100
 *     1ª devolução de R$ 500 → 50% de 100 = 50   (saldo: 50)
 *     2ª devolução de R$ 500 → 50% de  50 = 25   (saldo: 25)
 *
 * A venda inteira voltou e o vendedor seguia com R$ 25 a receber sobre ela.
 * Em quatro etapas de um quarto sobram R$ 31,64; quanto mais parcelada a
 * devolução, maior o resíduo — e cada parcela isolada parece certa.
 *
 * ## A CONTA CERTA É SOBRE O ACUMULADO
 *
 * Quanto já voltou da venda INTEIRA, contra a comissão ORIGINAL, menos o que
 * já foi estornado. Escrita assim, ela se corrige sozinha: o arredondamento de
 * uma etapa é absorvido na seguinte, em vez de somar.
 */
export function estornarComissaoDaDevolucao(input: {
  companyId: string;
  saleId: string;
  returnId: string;
  /** Valor devolvido NESTA devolução — líquido do desconto de cabeçalho rateado (GAP-PRD-009). */
  devolvidoCents: number;
  /**
   * O denominador: a base comissionável da venda (subtotal − desconto de
   * cabeçalho), na mesma medida do valor devolvido. O nome ficou do tempo em
   * que a devolução era bruta e o denominador era o subtotal.
   */
  subtotalCents: number;
}): void {
  ensureCoreSchema();
  if (input.devolvidoCents <= 0 || input.subtotalCents <= 0) return;
  const db = getConnection();

  /*
    O acumulado sai de `core_sale_returns`, e não da soma dos argumentos: o
    documento desta devolução já está gravado quando chegamos aqui, e as
    anteriores também. Somar só o que veio por parâmetro exigiria que o
    chamador soubesse o histórico — que é como o resíduo nasceu.
  */
  const devolvido = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(total_cents), 0) AS total FROM core_sale_returns
            WHERE company_id = ? AND sale_id = ?`,
        )
        .get(input.companyId, input.saleId) as { total: number }
    ).total,
  );
  const acumulado = Math.max(devolvido, input.devolvidoCents);
  const proporcao = Math.min(1, acumulado / input.subtotalCents);

  const porVendedor = db
    .prepare(
      `SELECT seller_id AS seller,
              COALESCE(SUM(CASE WHEN origin_type = 'sale' THEN amount_cents END), 0) AS original,
              COALESCE(SUM(CASE WHEN origin_type = 'sale_return' THEN amount_cents END), 0) AS estornado
         FROM core_commission_entries
        WHERE company_id = ? AND sale_id = ?
        GROUP BY seller_id`,
    )
    .all(input.companyId, input.saleId) as unknown as {
    seller: string;
    original: number;
    estornado: number;
  }[];

  for (const linha of porVendedor) {
    if (linha.original <= 0) continue;
    // O alvo é quanto DEVERIA estar estornado depois desta devolução.
    const alvo = Math.round(linha.original * proporcao);
    const estorno = alvo + linha.estornado; // `estornado` já é negativo
    if (estorno <= 0) continue;

    gravarLinha({
      companyId: input.companyId,
      sellerId: linha.seller,
      saleId: input.saleId,
      originType: 'sale_return',
      originId: input.returnId,
      baseCents: input.devolvidoCents,
      rateBps: 0,
      amountCents: -estorno,
      competenceDate: hoje(),
      note: 'Devolução de venda',
    });
  }
}

// -------------------------------------------------------------- apuração

export interface CommissionSummaryRow {
  sellerId: string;
  sellerName: string | null;
  apuradoCents: number;
  estornadoCents: number;
  saldoCents: number;
  aberto: number;
}

export function summarize(
  companyId: string,
  from: string,
  to: string,
): { rows: CommissionSummaryRow[]; semComissao: { vendas: number; totalCents: number } } {
  ensureCoreSchema();
  const db = getConnection();

  const rows = db
    .prepare(
      `SELECT e.seller_id AS sellerId, u.display_name AS sellerName,
              COALESCE(SUM(CASE WHEN e.amount_cents > 0 THEN e.amount_cents ELSE 0 END), 0) AS apuradoCents,
              COALESCE(SUM(CASE WHEN e.amount_cents < 0 THEN -e.amount_cents ELSE 0 END), 0) AS estornadoCents,
              COALESCE(SUM(e.amount_cents), 0) AS saldoCents,
              SUM(CASE WHEN e.status = 'aberto' THEN 1 ELSE 0 END) AS aberto
         FROM core_commission_entries e
         LEFT JOIN core_users u ON u.id = e.seller_id
        WHERE e.company_id = ? AND e.competence_date BETWEEN ? AND ?
        GROUP BY e.seller_id, u.display_name
        ORDER BY saldoCents DESC`,
    )
    .all(companyId, from, to) as unknown as CommissionSummaryRow[];

  /*
    O BALDE DAS VENDAS SEM COMISSÃO.

    Venda de vendedor sem grupo, ou cujo valor não alcança nenhuma faixa, não
    gera linha. Sem este contador ela sumiria em silêncio, e o dono acharia que
    a apuração está completa quando metade da loja ficou de fora.
  */
  const semComissao = db
    .prepare(
      `SELECT COUNT(*) AS vendas, COALESCE(SUM(s.total_cents), 0) AS totalCents
         FROM core_sales s
        WHERE s.company_id = ? AND s.status = 'completed'
          AND ${diaDaLojaSql('s.created_at')} BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM core_commission_entries e
             WHERE e.company_id = s.company_id AND e.sale_id = s.id
          )`,
    )
    .get(companyId, from, to) as { vendas: number; totalCents: number };

  return { rows, semComissao };
}

/**
 * Fecha o período de um vendedor e gera a conta a pagar.
 *
 * É o único ponto em que comissão vira dinheiro, então é aqui que mora a
 * trava contra pagar duas vezes: a UNIQUE de `core_commission_closings`
 * recusa o mesmo período para a mesma pessoa.
 *
 * Estorno que chegar DEPOIS não reabre o período. Ele nasce aberto, com a data
 * do fato, e entra no fechamento seguinte — reabrir período já pago faria a
 * conta a pagar mudar de valor depois de emitida.
 */
export function fecharPeriodo(input: {
  companyId: string;
  sellerId: string;
  from: string;
  to: string;
  userId?: string | null;
  dueDate?: string | null;
}): { closingId: string; totalCents: number; financeEntryId: string | null } {
  ensureCoreSchema();

  /*
    TRÊS ESCRITAS, UM ATO SÓ.

    O fechamento cria a conta a pagar, grava o fechamento e marca as linhas
    como fechadas. Sem transação em volta, uma falha no meio deixava a conta a
    pagar ÓRFÃ — dinheiro a pagar sem fechamento que o explique — E as linhas
    ainda abertas, de modo que o fechamento seguinte pagava o mesmo período
    outra vez. É o único ponto do sistema em que apuração vira dinheiro.

    `withTransaction` é reentrante: o `createEntry` de dentro abre um SAVEPOINT
    em vez de uma segunda transação.
  */
  return withTransaction(() => fecharPeriodoNaTransacao(input));
}

function fecharPeriodoNaTransacao(input: {
  companyId: string;
  sellerId: string;
  from: string;
  to: string;
  userId?: string | null;
  dueDate?: string | null;
}): { closingId: string; totalCents: number; financeEntryId: string | null } {
  const db = getConnection();

  const jaFechado = db
    .prepare(
      `SELECT id FROM core_commission_closings
        WHERE company_id = ? AND seller_id = ? AND period_from = ? AND period_to = ?`,
    )
    .get(input.companyId, input.sellerId, input.from, input.to);
  if (jaFechado) {
    throw new ApiError(
      'CORE_COMMISSION_PERIOD_CLOSED',
      'Este período já foi fechado para este vendedor.',
      409,
    );
  }

  const abertas = db
    .prepare(
      `SELECT id, amount_cents FROM core_commission_entries
        WHERE company_id = ? AND seller_id = ? AND status = 'aberto'
          AND competence_date BETWEEN ? AND ?`,
    )
    .all(input.companyId, input.sellerId, input.from, input.to) as unknown as {
    id: string;
    amount_cents: number;
  }[];

  if (abertas.length === 0) {
    throw new ApiError(
      'CORE_COMMISSION_NOTHING_TO_CLOSE',
      'Não há comissão em aberto neste período para este vendedor.',
      400,
    );
  }

  const total = abertas.reduce((acc, l) => acc + l.amount_cents, 0);
  const closingId = randomUUID();
  let financeEntryId: string | null = null;

  /*
    Saldo zero ou negativo não vira conta a pagar.

    Acontece quando as devoluções do mês passaram do que foi vendido. Criar uma
    conta a pagar negativa produziria um "crédito" que ninguém sabe cobrar; o
    certo é o saldo seguir para o próximo fechamento, e é o que acontece — as
    linhas ficam marcadas como fechadas e a diferença aparece no período em que
    o vendedor voltar a vender.
  */
  if (total > 0) {
    const nome = (
      db.prepare('SELECT display_name FROM core_users WHERE id = ?').get(input.sellerId) as
        | { display_name: string }
        | undefined
    )?.display_name;
    const lanc = createEntry({
      companyId: input.companyId,
      direction: 'out',
      description: `Comissão ${nome ?? 'vendedor'} · ${input.from} a ${input.to}`,
      amountCents: total,
      dueDate: input.dueDate ?? null,
      categoryId: systemCategoryId(input.companyId, 'folha'),
      // A competência é o FIM do período apurado, não o dia do fechamento:
      // comissão de fevereiro fechada em março é despesa de fevereiro.
      competenceDate: input.to,
      // O título aponta para o fechamento que o gerou (GAP-PRD-174): do
      // contas a pagar se chega ao fechamento, e não só o contrário.
      origin: { type: 'commission_closing', id: closingId },
    });
    financeEntryId = lanc.id;
  }

  db.prepare(
    `INSERT INTO core_commission_closings
       (id, company_id, seller_id, period_from, period_to, total_cents,
        finance_entry_id, closed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    closingId,
    input.companyId,
    input.sellerId,
    input.from,
    input.to,
    total,
    financeEntryId,
    input.userId ?? null,
    agora(),
  );

  const marcar = db.prepare(
    "UPDATE core_commission_entries SET status = 'fechado', closing_id = ? WHERE id = ?",
  );
  for (const linha of abertas) marcar.run(closingId, linha.id);

  return { closingId, totalCents: total, financeEntryId };
}

/*
  ============================================================================
  O HISTÓRICO DE FECHAMENTOS — o leitor nasce com a tela (GAP-PRD-174)
  ============================================================================

  Aqui existiu um `listClosings` sem chamador, e ele saiu medido: "quando a
  tela de histórico de fechamentos existir, o leitor nasce COM ela". A tela
  existe agora (Comissões › Fechamentos), e é para lá que o título da
  comissão no contas a pagar leva. O fechamento responde as três perguntas de
  quem audita "que fechamento gerou esta conta": de quem, de que período, e
  sobre quais vendas — com o título e a situação dele ao lado.

  Tudo cercado pela empresa: o id do fechamento de outra operação responde
  404, como qualquer documento que não é seu.
*/
export interface CommissionClosing {
  id: string;
  sellerId: string;
  sellerName: string | null;
  periodFrom: string;
  periodTo: string;
  totalCents: number;
  financeEntryId: string | null;
  /** Situação do título gerado: quanto falta pagar. Nulo sem título. */
  entryBalanceCents: number | null;
  entryCancelled: boolean;
  closedBy: string | null;
  closedByName: string | null;
  createdAt: string;
  /** Quantas linhas de comissão (venda, estorno) o fechamento levou. */
  lineCount: number;
}

function paraFechamento(r: Record<string, unknown>): CommissionClosing {
  return {
    id: String(r.id),
    sellerId: String(r.seller_id),
    sellerName: (r.seller_name as string | null) ?? null,
    periodFrom: String(r.period_from),
    periodTo: String(r.period_to),
    totalCents: Number(r.total_cents),
    financeEntryId: (r.finance_entry_id as string | null) ?? null,
    entryBalanceCents:
      r.entry_amount_cents === null || r.entry_amount_cents === undefined
        ? null
        : Number(r.entry_amount_cents) - Number(r.entry_settled_cents ?? 0),
    entryCancelled: Boolean(r.entry_cancelled_at),
    closedBy: (r.closed_by as string | null) ?? null,
    closedByName: (r.closed_by_name as string | null) ?? null,
    createdAt: String(r.created_at),
    lineCount: Number(r.line_count ?? 0),
  };
}

const SELECT_FECHAMENTO = `SELECT f.*, vend.display_name AS seller_name, quem.display_name AS closed_by_name,
         e.amount_cents AS entry_amount_cents, e.settled_cents AS entry_settled_cents,
         e.cancelled_at AS entry_cancelled_at,
         (SELECT COUNT(*) FROM core_commission_entries l
           WHERE l.company_id = f.company_id AND l.closing_id = f.id) AS line_count
    FROM core_commission_closings f
    LEFT JOIN core_users vend ON vend.id = f.seller_id
    LEFT JOIN core_users quem ON quem.id = f.closed_by
    LEFT JOIN core_finance_entries e ON e.id = f.finance_entry_id AND e.company_id = f.company_id`;

export function listClosings(
  companyId: string,
  filtros: { sellerId?: string; limit?: number } = {},
): CommissionClosing[] {
  ensureCoreSchema();
  const params: unknown[] = [companyId];
  let sql = `${SELECT_FECHAMENTO} WHERE f.company_id = ?`;
  if (filtros.sellerId) {
    sql += ' AND f.seller_id = ?';
    params.push(filtros.sellerId);
  }
  sql += ' ORDER BY f.period_to DESC, f.created_at DESC LIMIT ?';
  params.push(Math.min(Math.max(Math.trunc(Number(filtros.limit ?? 200)) || 200, 1), 1000));
  return (
    getConnection().prepare(sql).all(...(params as never[])) as unknown as Record<string, unknown>[]
  ).map(paraFechamento);
}

export interface CommissionClosingLine {
  id: string;
  saleId: string | null;
  saleNumber: number | null;
  originType: string;
  baseCents: number;
  rateBps: number;
  amountCents: number;
  competenceDate: string;
  note: string | null;
}

export function getClosing(
  companyId: string,
  closingId: string,
): { closing: CommissionClosing; lines: CommissionClosingLine[] } {
  ensureCoreSchema();
  const db = getConnection();
  const row = db
    .prepare(`${SELECT_FECHAMENTO} WHERE f.company_id = ? AND f.id = ?`)
    .get(companyId, closingId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new ApiError('CORE_COMMISSION_CLOSING_NOT_FOUND', 'Fechamento não encontrado.', 404);
  }
  const lines = (
    db
      .prepare(
        `SELECT l.id, l.sale_id, s.number AS sale_number, l.origin_type, l.base_cents,
                l.rate_bps, l.amount_cents, l.competence_date, l.note
           FROM core_commission_entries l
           LEFT JOIN core_sales s ON s.id = l.sale_id AND s.company_id = l.company_id
          WHERE l.company_id = ? AND l.closing_id = ?
          ORDER BY l.competence_date, l.created_at`,
      )
      .all(companyId, closingId) as unknown as Record<string, unknown>[]
  ).map((l) => ({
    id: String(l.id),
    saleId: (l.sale_id as string | null) ?? null,
    saleNumber: l.sale_number === null || l.sale_number === undefined ? null : Number(l.sale_number),
    originType: String(l.origin_type),
    baseCents: Number(l.base_cents),
    rateBps: Number(l.rate_bps),
    amountCents: Number(l.amount_cents),
    competenceDate: String(l.competence_date),
    note: (l.note as string | null) ?? null,
  }));
  return { closing: paraFechamento(row), lines };
}

export function listEntries(
  companyId: string,
  filtros: { sellerId?: string; from?: string; to?: string } = {},
): CommissionEntry[] {
  ensureCoreSchema();
  const cond: string[] = ['company_id = ?'];
  const params: unknown[] = [companyId];
  if (filtros.sellerId) {
    cond.push('seller_id = ?');
    params.push(filtros.sellerId);
  }
  if (filtros.from) {
    cond.push('competence_date >= ?');
    params.push(filtros.from);
  }
  if (filtros.to) {
    cond.push('competence_date <= ?');
    params.push(filtros.to);
  }
  return getConnection()
    .prepare(
      `SELECT * FROM core_commission_entries
        WHERE ${cond.join(' AND ')} ORDER BY competence_date DESC, created_at DESC`,
    )
    .all(...(params as never[])) as unknown as CommissionEntry[];
}
