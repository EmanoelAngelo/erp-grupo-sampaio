/**
 * Locais de estoque — ONDE a mercadoria está.
 *
 * ## A decisão de desenho
 *
 * O caminho óbvio seria pôr o local na chave de `core_stock`, transformando o
 * saldo em uma linha por local. Não foi isso que se fez, por três motivos:
 *
 * 1. `core_stock.quantity` tem `CHECK (quantity >= 0)`. Com o local na chave, o
 *    invariante deixaria de ser "o total nunca fica negativo" e passaria a ser
 *    "nenhum local fica negativo" — o que RECUSARIA vendas legítimas: quem tem
 *    3 na loja e 7 no depósito e vende 5 estaria vendendo o que tem.
 * 2. Vinte pontos do código leem o saldo. Todos precisariam decidir, um a um,
 *    se querem o total ou o de um local.
 * 3. Haveria dois caches para manter em dia (o total e o por local), com o
 *    risco permanente de discordarem.
 *
 * Aqui o local é dimensão do RAZÃO: `core_stock_movements.location_id` diz onde
 * cada movimento aconteceu, e o saldo por local é a SOMA dos movimentos. Uma
 * fonte de verdade só, e `core_stock` continua sendo o total, intocado.
 *
 * O preço disso é que o saldo por local não é uma leitura de chave primária —
 * é uma agregação. Para tela de posição e conferência isso é barato e tem
 * índice; para o caminho quente do PDV o que vale é o total, que segue em cache.
 *
 * ## Local padrão
 *
 * `location_id` nulo significa "o local padrão da empresa". É o que faz TODO
 * movimento anterior a esta tabela continuar íntegro sem reescrever histórico,
 * e o que permite quem não quer trabalhar com locais simplesmente ignorá-los.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement } from './InventoryService.js';
import { isSerialized, pickUnitsFifo } from './ProductUnitService.js';

const agora = () => new Date().toISOString();

export interface StockLocation {
  id: string;
  company_id: string;
  code: string;
  name: string;
  note: string | null;
  is_default: number;
  active: number;
}

export interface LocationBalance {
  locationId: string | null;
  code: string;
  name: string;
  quantity: number;
}

function texto(valor: unknown, campo: string): string {
  const limpo = String(valor ?? '').trim();
  if (!limpo) {
    throw new ApiError('CORE_LOCATION_FIELD_REQUIRED', `Informe ${campo}.`, 400);
  }
  return limpo;
}

/**
 * Garante que a empresa tem um local padrão, criando-o na primeira vez.
 *
 * Nasce como "GERAL" porque é o nome honesto para o que sempre existiu: uma
 * prateleira só, sem separação. Quem quiser dividir depois renomeia.
 */
export function ensureDefaultLocation(companyId: string): StockLocation {
  ensureCoreSchema();
  const db = getConnection();
  const existente = db
    .prepare('SELECT * FROM core_stock_locations WHERE company_id = ? AND is_default = 1')
    .get(companyId) as StockLocation | undefined;
  if (existente) return existente;

  const id = randomUUID();
  const ts = agora();
  db.prepare(
    `INSERT INTO core_stock_locations
       (id, company_id, code, name, note, is_default, active, created_at, updated_at)
     VALUES (?, ?, 'GERAL', 'Estoque geral', NULL, 1, 1, ?, ?)`,
  ).run(id, companyId, ts, ts);
  return db
    .prepare('SELECT * FROM core_stock_locations WHERE id = ?')
    .get(id) as unknown as StockLocation;
}

export function listLocations(companyId: string, includeInactive = false): StockLocation[] {
  ensureCoreSchema();
  ensureDefaultLocation(companyId);
  const filtro = includeInactive ? '' : ' AND active = 1';
  return getConnection()
    .prepare(
      `SELECT * FROM core_stock_locations
        WHERE company_id = ?${filtro}
        ORDER BY is_default DESC, name COLLATE NOCASE`,
    )
    .all(companyId) as unknown as StockLocation[];
}

export function createLocation(
  companyId: string,
  input: { code: string; name: string; note?: string | null },
): StockLocation {
  ensureCoreSchema();
  ensureDefaultLocation(companyId);
  const code = texto(input.code, 'o código do local').toUpperCase();
  const name = texto(input.name, 'o nome do local');

  const db = getConnection();
  const repetido = db
    .prepare('SELECT id FROM core_stock_locations WHERE company_id = ? AND code = ?')
    .get(companyId, code);
  if (repetido) {
    throw new ApiError('CORE_LOCATION_DUPLICATE', `Já existe um local com o código ${code}.`, 409);
  }

  const id = randomUUID();
  const ts = agora();
  db.prepare(
    `INSERT INTO core_stock_locations
       (id, company_id, code, name, note, is_default, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`,
  ).run(id, companyId, code, name, input.note?.trim() || null, ts, ts);
  return db
    .prepare('SELECT * FROM core_stock_locations WHERE id = ?')
    .get(id) as unknown as StockLocation;
}

export function updateLocation(
  companyId: string,
  id: string,
  input: { name?: string; note?: string | null; active?: boolean },
): StockLocation {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT * FROM core_stock_locations WHERE company_id = ? AND id = ?')
    .get(companyId, id) as StockLocation | undefined;
  if (!atual) {
    throw new ApiError('CORE_LOCATION_NOT_FOUND', 'Local não encontrado.', 404);
  }

  // O padrão não desliga: se ele sumisse, movimento com local nulo ficaria sem
  // para onde apontar, e é assim que TODO o histórico está gravado.
  if (input.active === false && atual.is_default === 1) {
    throw new ApiError(
      'CORE_LOCATION_DEFAULT_REQUIRED',
      'O local padrão não pode ser desativado.',
      409,
    );
  }

  db.prepare(
    `UPDATE core_stock_locations
        SET name = COALESCE(?, name),
            note = ?,
            active = COALESCE(?, active),
            updated_at = ?
      WHERE company_id = ? AND id = ?`,
  ).run(
    input.name?.trim() || null,
    input.note === undefined ? atual.note : input.note?.trim() || null,
    input.active === undefined ? null : input.active ? 1 : 0,
    agora(),
    companyId,
    id,
  );
  return db
    .prepare('SELECT * FROM core_stock_locations WHERE id = ?')
    .get(id) as unknown as StockLocation;
}

/**
 * Saldo do produto por local, derivado do razão.
 *
 * O `COALESCE` é o que faz o movimento antigo — gravado antes desta coluna
 * existir — aparecer no local padrão em vez de sumir num grupo sem nome.
 */
export function balanceByLocation(companyId: string, productId: string): LocationBalance[] {
  ensureCoreSchema();
  const padrao = ensureDefaultLocation(companyId);
  const linhas = getConnection()
    .prepare(
      `SELECT COALESCE(m.location_id, ?) AS location_id,
              SUM(m.quantity)            AS quantity
         FROM core_stock_movements m
        WHERE m.company_id = ? AND m.product_id = ?
        GROUP BY COALESCE(m.location_id, ?)`,
    )
    .all(padrao.id, companyId, productId, padrao.id) as unknown as {
    location_id: string;
    quantity: number;
  }[];

  const locais = new Map(listLocations(companyId, true).map((l) => [l.id, l]));
  return linhas
    .map((linha) => {
      const local = locais.get(linha.location_id);
      return {
        locationId: linha.location_id,
        code: local?.code ?? '—',
        name: local?.name ?? 'Local removido',
        quantity: linha.quantity,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/**
 * Transferir mercadoria entre locais.
 *
 * São DOIS movimentos com a mesma referência: saída de um local e entrada no
 * outro. O total da empresa não muda — e é por isso que o `CHECK` de
 * `core_stock` não é acionado nem atrapalha: ele guarda o total, que ficou
 * igual.
 *
 * A validação de "tem o suficiente NAQUELE local" é feita aqui, no serviço,
 * porque o banco só conhece o total. É uma checagem de negócio, não um
 * invariante estrutural: o pior caso de uma falha aqui é um relatório de
 * posição errado, nunca estoque total negativo.
 */
export function transferStock(input: {
  companyId: string;
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  userId?: string | null;
  note?: string | null;
}): { reference: string } {
  ensureCoreSchema();
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade inválida.', 400);
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new ApiError('CORE_LOCATION_SAME', 'Origem e destino são o mesmo local.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const valido = (id: string) =>
      db
        .prepare('SELECT id FROM core_stock_locations WHERE company_id = ? AND id = ? AND active = 1')
        .get(input.companyId, id);
    if (!valido(input.fromLocationId) || !valido(input.toLocationId)) {
      throw new ApiError('CORE_LOCATION_NOT_FOUND', 'Local não encontrado ou inativo.', 404);
    }

    const naOrigem =
      balanceByLocation(input.companyId, input.productId).find(
        (l) => l.locationId === input.fromLocationId,
      )?.quantity ?? 0;
    if (naOrigem < input.quantity) {
      throw new ApiError(
        'CORE_LOCATION_INSUFFICIENT',
        `Saldo insuficiente no local de origem: há ${naOrigem}.`,
        409,
      );
    }

    // Referência compartilhada pelas duas pernas: é o que permite ler a
    // transferência como UM fato ao olhar o histórico.
    const reference = randomUUID();

    /*
      Produto serializado: AS MESMAS peças nas duas pernas.

      Escolher no local de ORIGEM e repetir os ids na entrada é o que faz a
      unidade mudar de `location_id` em vez de virar outra unidade. Escolher
      duas vezes deixaria uma peça marcada como saída e outra como entrada — o
      total fecharia e a posição por local mentiria.
    */
    const unidades = isSerialized(input.companyId, input.productId)
      ? pickUnitsFifo(input.companyId, input.productId, input.quantity, input.fromLocationId, {
          // A moto segurada para um cliente pode mudar de prateleira (GAP-PRD-111):
          // transferir não a entrega a ninguém. Só vai por último.
          incluirReservadas: true,
        })
      : undefined;

    /*
      O `kind` VAI EXPLÍCITO NAS DUAS PERNAS, e a falta dele era um defeito.

      Sem ele, `applyMovement` cai em `inferKind`, que não conhecia a
      referência 'transferencia' e deduzia pela direção crua: a saída virava
      MANUAL_EXIT e a entrada MANUAL_ENTRY. `TRANSFER_OUT` e `TRANSFER_IN` já
      existiam em `MOVEMENT_KINDS`, com rótulo em português, e já apareciam no
      menu do filtro da tela de Movimentações — escolher "Transferência —
      saída" devolvia ZERO LINHAS, porque nenhuma linha tinha sido gravada com
      esse tipo.

      E o estrago não parava no filtro vazio: as mesmas pernas apareciam sob
      "Saída manual" e "Entrada manual", ao lado das perdas e dos consumos
      internos. Quem confere prateleira contra sistema lia saída DEFINITIVA
      onde houve só mudança de prateleira — e a mercadoria "sumida" de um
      local estava inteira no outro.
    */
    applyMovement({
      companyId: input.companyId,
      productId: input.productId,
      movementType: 'out',
      quantity: input.quantity,
      referenceType: 'transferencia',
      referenceId: `${reference}:saida`,
      kind: 'TRANSFER_OUT',
      locationId: input.fromLocationId,
      userId: input.userId ?? null,
      reason: 'Transferência entre locais',
      note: input.note ?? null,
      unitIds: unidades,
    });
    applyMovement({
      companyId: input.companyId,
      productId: input.productId,
      movementType: 'in',
      quantity: input.quantity,
      referenceType: 'transferencia',
      referenceId: `${reference}:entrada`,
      kind: 'TRANSFER_IN',
      locationId: input.toLocationId,
      userId: input.userId ?? null,
      reason: 'Transferência entre locais',
      note: input.note ?? null,
      unitIds: unidades,
    });
    return { reference };
  });
}
