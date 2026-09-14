/**
 * Unidades serializadas — QUAL peça, e não quantas.
 *
 * ## A decisão de desenho
 *
 * `core_stock` continua sendo o saldo autoritativo. Esta tabela NÃO é a fonte
 * da quantidade: ela é a identidade das peças, ao lado do saldo.
 *
 * O acoplamento entre as duas mora num lugar só — dentro de `applyMovement`,
 * que é o único escritor de `core_stock.quantity`. Nenhum caminho move estoque
 * de produto serializado sem virar o status da unidade na MESMA transação, e é
 * isso que impede as duas afirmações de divergirem: o rollback que desfaz o
 * saldo desfaz o status.
 *
 * A alternativa — fazer o saldo ser `COUNT(*)` das unidades em estoque — foi
 * recusada porque trocaria o significado do `CHECK (quantity >= 0)` justamente
 * para os itens de maior valor do negócio, e faria os quinze pontos que leem
 * saldo terem duas semânticas conforme uma coluna do produto.
 *
 * ## Identidade nasce nula, e pode ser corrigida
 *
 * A nota de entrada traz "3 motos" muito antes de alguém ir ao pátio ler os
 * chassis. Por isso a unidade nasce sem identidade e é preenchida depois.
 *
 * Aqui a identidade PODE ser corrigida, com registro de quem corrigiu. Chassi
 * digitado errado sem conserto é defeito, não segurança: quem precisa consertar
 * acaba criando uma segunda unidade e o estoque dobra.
 *
 * ## A promessa sobre `core_equipment`, agora que ela mudou
 *
 * Este cabeçalho dizia que `core_equipment` é write-once e não tem função de
 * atualização. Deixou de ser verdade nesta rodada, e a frase antiga ficaria
 * mentindo justamente no arquivo que passou a escrever lá.
 *
 * A promessa nova: a plaquinha continua sem edição À MÃO depois do cadastro —
 * não existe tela nem rota para digitar chassi de equipamento já criado. O que
 * existe é UM caminho de correção, e ele passa pela unidade: uma vez vinculada
 * (`core_product_units.equipment_id`), a unidade é o lado que manda, e
 * `identifyUnit` propaga a identidade para a plaquinha na mesma transação.
 *
 * A razão de a unidade mandar: é o lado corrigível, e é o número que sai no
 * documento da venda. Duas verdades sobre o mesmo chassi é o defeito; uma
 * fonte, com um caminho de conserto, é o remédio.
 *
 * ## Onde a identidade sai (GAP-PRD-026)
 *
 * Esta frase dizia que a unidade "é o número que sai no documento fiscal" e
 * nenhum documento a lia. Agora a venda carimba `sale_item_id` (SalesService)
 * e UM leitor — `IdentidadeDaUnidadeFiscal.unidadesPorLinha` — alimenta o
 * `infAdProd` da NF-e e da NFC-e, o DANFE, o DANFCE e o cupom da venda. É por
 * isso que `identifyUnit` recusa unidade que já saiu: a identidade dela já
 * pode estar num documento.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordEquipmentEvent } from './EquipmentService.js';

const agora = () => new Date().toISOString();

export type UnitStatus = 'in_stock' | 'sold' | 'baixada';

/** As cinco identidades. A ordem é a que a tela mostra. */
export const UNIT_IDENTITY_FIELDS = [
  'serial_number',
  'imei',
  'chassis',
  'motor_number',
  'plate',
] as const;
export type UnitIdentityField = (typeof UNIT_IDENTITY_FIELDS)[number];

export interface ProductUnit {
  id: string;
  company_id: string;
  product_id: string;
  status: UnitStatus;
  serial_number: string | null;
  imei: string | null;
  chassis: string | null;
  motor_number: string | null;
  plate: string | null;
  location_id: string | null;
  cost_cents: number | null;
  entry_reference_type: string | null;
  entry_reference_id: string | null;
  exit_reference_type: string | null;
  exit_reference_id: string | null;
  sale_item_id: string | null;
  equipment_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnitIdentity {
  serialNumber?: string | null;
  imei?: string | null;
  chassis?: string | null;
  motorNumber?: string | null;
  plate?: string | null;
}

/** Texto vazio vira nulo: string em branco colidiria no índice único parcial. */
function limpo(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim();
  return t || null;
}

export function isSerialized(companyId: string, productId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT serialized FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { serialized: number } | undefined;
  return row?.serialized === 1;
}

/** O nome do produto, para a mensagem de erro dizer de quem se trata. */
function nomeDoProduto(companyId: string, productId: string): string {
  const row = getConnection()
    .prepare('SELECT name FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { name: string } | undefined;
  return row?.name ?? 'produto';
}

export function listUnits(
  companyId: string,
  productId: string,
  options: { status?: UnitStatus } = {},
): ProductUnit[] {
  ensureCoreSchema();
  const filtro = options.status ? ' AND status = ?' : '';
  const params: unknown[] = [companyId, productId];
  if (options.status) params.push(options.status);
  return getConnection()
    .prepare(
      `SELECT * FROM core_product_units
        WHERE company_id = ? AND product_id = ?${filtro}
        ORDER BY created_at`,
    )
    .all(...(params as never[])) as unknown as ProductUnit[];
}

/**
 * Achar a unidade por qualquer uma das identidades.
 *
 * Igualdade primeiro, porque é o que os índices únicos parciais cobrem — bipar
 * um IMEI no balcão tem de ser instantâneo. O LIKE só entra se a igualdade não
 * achou nada, e vem limitado: ele é varredura.
 */
export function searchUnit(companyId: string, termo: string, limite = 20): ProductUnit[] {
  ensureCoreSchema();
  const t = String(termo ?? '').trim();
  if (!t) return [];
  const db = getConnection();

  const exato = db
    .prepare(
      `SELECT * FROM core_product_units
        WHERE company_id = ?
          AND (serial_number = ? OR imei = ? OR chassis = ? OR motor_number = ? OR plate = ?)
        LIMIT ?`,
    )
    .all(companyId, t, t, t, t, t, limite) as unknown as ProductUnit[];
  if (exato.length > 0) return exato;

  const parcial = `%${t}%`;
  return db
    .prepare(
      `SELECT * FROM core_product_units
        WHERE company_id = ?
          AND (serial_number LIKE ? OR imei LIKE ? OR chassis LIKE ?
               OR motor_number LIKE ? OR plate LIKE ?)
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(companyId, parcial, parcial, parcial, parcial, parcial, limite) as unknown as ProductUnit[];
}

export function getUnit(companyId: string, unitId: string): ProductUnit | undefined {
  ensureCoreSchema();
  return getConnection()
    .prepare('SELECT * FROM core_product_units WHERE id = ? AND company_id = ?')
    .get(unitId, companyId) as ProductUnit | undefined;
}

/**
 * Cria N unidades em estoque.
 *
 * Chamada pela entrada de nota e pela regularização de saldo que já existia.
 * As unidades nascem SEM identidade — ver o cabeçalho deste arquivo.
 *
 * Assume que já está dentro de uma transação do chamador: `withTransaction`
 * aninhado vira SAVEPOINT, então quem entra por aqui e falha não deixa
 * unidade órfã.
 */
export function createUnits(
  companyId: string,
  productId: string,
  quantidade: number,
  dados: {
    entryReferenceType?: string | null;
    entryReferenceId?: string | null;
    locationId?: string | null;
    costCents?: number | null;
    note?: string | null;
    identidades?: UnitIdentity[];
  } = {},
): string[] {
  ensureCoreSchema();
  if (!Number.isInteger(quantidade) || quantidade <= 0) {
    throw new ApiError(
      'CORE_SERIALIZED_FRACTIONAL',
      `"${nomeDoProduto(companyId, productId)}" é controlado por unidade: a quantidade tem de ser um número inteiro maior que zero.`,
      400,
    );
  }

  const db = getConnection();
  const ts = agora();
  const ids: string[] = [];
  const stmt = db.prepare(
    `INSERT INTO core_product_units
       (id, company_id, product_id, status, serial_number, imei, chassis, motor_number,
        plate, location_id, cost_cents, entry_reference_type, entry_reference_id,
        note, created_at, updated_at)
     VALUES (?, ?, ?, 'in_stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < quantidade; i += 1) {
    const id = randomUUID();
    const ident = dados.identidades?.[i] ?? {};
    stmt.run(
      id,
      companyId,
      productId,
      limpo(ident.serialNumber),
      limpo(ident.imei),
      limpo(ident.chassis),
      limpo(ident.motorNumber),
      limpo(ident.plate),
      dados.locationId ?? null,
      dados.costCents ?? null,
      dados.entryReferenceType ?? null,
      dados.entryReferenceId ?? null,
      dados.note ?? null,
      ts,
      ts,
    );
    ids.push(id);
  }
  return ids;
}

/**
 * Os três números que existem dos DOIS lados — unidade e plaquinha.
 *
 * `imei` e `plate` ficam de fora porque `core_equipment` não tem essas colunas:
 * a plaquinha da oficina descreve a MÁQUINA, e a placa é do emplacamento, que
 * muda de estado e de dono sem a moto mudar.
 */
const IDENTIDADE_COMPARTILHADA_COM_A_PLAQUINHA = [
  'chassis',
  'motor_number',
  'serial_number',
] as const;

/**
 * Leva a identidade corrigida da unidade para a plaquinha vinculada.
 *
 * ## Por que o UPDATE está escrito AQUI e não em `EquipmentStockLink`
 *
 * A ponte publica o vínculo, a venda e a devolução — as operações que cruzam
 * empresa e precisam de regra própria. Esta é outra coisa: é a consequência
 * direta de `identifyUnit`, e ela tem de acontecer na MESMA transação da
 * correção da unidade. Escrever no ponto onde a correção acontece é o que
 * impede o caso de a unidade gravar e a plaquinha não.
 *
 * ## A unidade manda, INCLUSIVE quando apaga
 *
 * O espelho é exato: o que vale é o que a unidade tem depois da correção. Se o
 * operador limpou um campo, a plaquinha limpa junto. Copiar só valores
 * preenchidos deixaria a plaquinha com um número que a unidade não tem mais —
 * que é a divergência que esta rodada existe para matar, só que mais difícil de
 * enxergar.
 *
 * Só grava quando algo de fato mudou: evento repetido a cada salvamento de tela
 * transformaria o histórico da plaquinha em ruído.
 */
function propagarIdentidadeParaPlaquinha(
  unidade: ProductUnit,
  userId: string | null,
): void {
  if (!unidade.equipment_id) return;

  const db = getConnection();
  // Sem filtro de empresa DE PROPÓSITO: a plaquinha vive na oficina, que é
  // outra empresa. Quem autoriza é a unidade, já conferida contra `companyId`
  // por `getUnit` lá em cima.
  const plaquinha = db
    .prepare(
      `SELECT id, company_id, public_id, chassis, motor_number, serial_number
         FROM core_equipment WHERE id = ?`,
    )
    .get(unidade.equipment_id) as
    | {
        id: string;
        company_id: string;
        public_id: number;
        chassis: string | null;
        motor_number: string | null;
        serial_number: string | null;
      }
    | undefined;
  // Plaquinha some sem o vínculo sumir é estado que não deveria existir; travar
  // a correção da unidade por causa disso só tiraria o conserto de quem precisa.
  if (!plaquinha) return;

  const mudancas: string[] = [];
  for (const coluna of IDENTIDADE_COMPARTILHADA_COM_A_PLAQUINHA) {
    const naUnidade = unidade[coluna];
    const naPlaquinha = plaquinha[coluna];
    if (String(naUnidade ?? '') === String(naPlaquinha ?? '')) continue;
    mudancas.push(`${coluna}: ${naPlaquinha ?? '(vazio)'} → ${naUnidade ?? '(vazio)'}`);
  }
  if (mudancas.length === 0) return;

  // O chassi identifica a moto na oficina inteira. A checagem é feita À MÃO
  // porque `ux_equipment_chassis` nasce na migração, e os testes rodam contra a
  // DDL canônica pura — regra que só existisse no índice seria regra que nenhum
  // teste alcança. O `catch` abaixo é a rede para o banco real.
  if (unidade.chassis) {
    const outra = db
      .prepare(
        'SELECT public_id FROM core_equipment WHERE company_id = ? AND chassis = ? AND id <> ? LIMIT 1',
      )
      .get(plaquinha.company_id, unidade.chassis, plaquinha.id) as
      | { public_id: number }
      | undefined;
    if (outra) {
      throw new ApiError(
        'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
        `A plaquinha #${String(outra.public_id).padStart(4, '0')} desta oficina já usa o chassi ` +
          `${unidade.chassis}. Confira o número digitado.`,
        409,
      );
    }
  }

  try {
    db.prepare(
      `UPDATE core_equipment
          SET chassis = ?, motor_number = ?, serial_number = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      unidade.chassis,
      unidade.motor_number,
      unidade.serial_number,
      agora(),
      plaquinha.id,
    );
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new ApiError(
        'CORE_EQUIPMENT_DUPLICATE_IDENTITY',
        'Já existe outra plaquinha desta oficina com esse chassi. Confira o número digitado.',
        409,
      );
    }
    throw err;
  }

  // O evento vive na empresa da OFICINA, que é onde o histórico da plaquinha é
  // lido, e guarda OS DOIS valores: sem o que estava, ninguém reconstitui o que
  // foi sobrescrito.
  recordEquipmentEvent({
    equipmentId: plaquinha.id,
    companyId: plaquinha.company_id,
    eventType: 'identity_corrected',
    description: `Identidade corrigida pela unidade de estoque — ${mudancas.join('; ')}`,
    userId,
  });
}

/**
 * Corrigir ou preencher a identidade.
 *
 * Só em unidade que ainda está em estoque: mexer no chassi de uma moto já
 * vendida mudaria o que está escrito no documento do cliente.
 *
 * Quando a unidade tem plaquinha vinculada, a correção ATRAVESSA para a oficina
 * na mesma transação — ver `propagarIdentidadeParaPlaquinha` e o cabeçalho do
 * arquivo.
 */
export function identifyUnit(
  companyId: string,
  unitId: string,
  identidade: UnitIdentity & { note?: string | null; userId?: string | null },
): ProductUnit {
  ensureCoreSchema();

  // A transação abraça as duas escritas. `withTransaction` aninhado vira
  // SAVEPOINT, então quem já entrou aqui dentro de uma transação maior continua
  // funcionando igual.
  return withTransaction(() => {
    const atual = getUnit(companyId, unitId);
    if (!atual) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
    if (atual.status !== 'in_stock') {
      throw new ApiError(
        'CORE_UNIT_NOT_EDITABLE',
        'Esta unidade já saiu do estoque. A identidade dela consta em documento e não muda mais.',
        409,
      );
    }

    const campo = (novo: string | null | undefined, antigo: string | null) =>
      novo === undefined ? antigo : limpo(novo);

    const db = getConnection();
    try {
      db.prepare(
        `UPDATE core_product_units
            SET serial_number = ?, imei = ?, chassis = ?, motor_number = ?, plate = ?,
                note = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(
        campo(identidade.serialNumber, atual.serial_number),
        campo(identidade.imei, atual.imei),
        campo(identidade.chassis, atual.chassis),
        campo(identidade.motorNumber, atual.motor_number),
        campo(identidade.plate, atual.plate),
        identidade.note === undefined ? atual.note : limpo(identidade.note),
        agora(),
        unitId,
        companyId,
      );
    } catch (err) {
      // O índice único parcial recusa identidade repetida. O erro cru do SQLite
      // não diz QUAL campo colidiu, e quem está no balcão precisa saber.
      if (String(err).includes('UNIQUE')) {
        throw new ApiError(
          'CORE_UNIT_DUPLICATE_IDENTITY',
          'Já existe outra unidade com essa identidade nesta empresa. Confira o número digitado.',
          409,
        );
      }
      throw err;
    }

    const atualizada = getUnit(companyId, unitId)!;
    propagarIdentidadeParaPlaquinha(atualizada, identidade.userId ?? null);
    return atualizada;
  });
}

/**
 * O id do local padrão da empresa, só para leitura.
 *
 * Não usa `ensureDefaultLocation` de propósito, por dois motivos. O primeiro é
 * que `StockLocationService` já importa ESTE arquivo — chamar de volta criaria
 * um ciclo entre os dois módulos. O segundo é mais importante: aquela função
 * CRIA a linha quando falta, e um caminho de leitura como o FIFO não deve
 * escrever no banco como efeito colateral de uma consulta.
 *
 * Devolver `null` quando não há padrão é seguro: aí o `COALESCE` compara
 * `NULL = <local pedido>`, que é falso, e o comportamento é o mesmo de antes.
 * Na prática isso não acontece — criar qualquer local já garante o padrão, e
 * sem local nenhum ninguém tem um id para pedir.
 */
function localPadraoId(companyId: string): string | null {
  const linha = getConnection()
    .prepare('SELECT id FROM core_stock_locations WHERE company_id = ? AND is_default = 1')
    .get(companyId) as { id?: string } | undefined;
  return linha?.id ?? null;
}

/**
 * As unidades mais antigas em estoque, para os caminhos SEM operador.
 *
 * Usada quando não há ninguém para escolher: separação de pedido no depósito,
 * consumo de peça em OS, transferência entre locais. Quem separa pega a que
 * está na frente, e a mais antiga é a que deve girar primeiro.
 *
 * Nunca é chamada de dentro do `applyMovement`: escolher unidade por conta
 * própria no funil esconderia a decisão de quem lê o código. Cada chamador
 * decide explicitamente que quer FIFO.
 *
 * ## O `COALESCE` do filtro de local, e por que ele é obrigatório
 *
 * `location_id` nulo NÃO significa "sem local": significa o local PADRÃO da
 * empresa. É semântica declarada na coluna e respeitada por
 * `balanceByLocation`, que agrupa por `COALESCE(location_id, <padrão>)`.
 *
 * Aqui o filtro era `AND location_id = ?`, e no SQLite `NULL = 'loc-geral'` é
 * falso. As duas camadas passaram a discordar sobre a mesma peça: a posição
 * por local dizia que havia 3 motos no GERAL, e a transferência do GERAL
 * respondia "tem 0 unidade(s) em estoque neste local". Os dois números saíam
 * do mesmo banco, no mesmo instante.
 *
 * E não era um canto raro: TODA unidade nascida de NF-e está assim, porque a
 * entrada de nota não informa local. O caminho normal de receber mercadoria
 * produzia o defeito.
 *
 * Comparar pelo mesmo `COALESCE` que o saldo usa é o que faz as duas camadas
 * voltarem a falar do mesmo lugar — inclusive para o histórico já gravado, que
 * uma correção só "daqui para a frente" deixaria quebrado para sempre.
 */
export function pickUnitsFifo(
  companyId: string,
  productId: string,
  quantidade: number,
  locationId?: string | null,
  /**
   * A MOTO SEGURADA PARA OUTRO CLIENTE NÃO SAI PELO FIFO (GAP-PRD-111).
   *
   * Por padrão, a unidade que uma pré-venda VIVA segura (ver
   * `core_product_unit_holds`) fica fora da escolha — a não ser que a pré-venda
   * seja `documento`, que é quem está convertendo. Sem isto a moto negociada no
   * balcão saía pelo primeiro pedido online que o webhook capturasse.
   *
   * `incluirReservadas` é para quem não entrega a moto a ninguém (transferência
   * entre locais): a reservada pode mudar de prateleira, e só vai por último.
   * `excetoIds` tira da escolha o que o chamador já escolheu por outro caminho.
   */
  opcoes: { documento?: string | null; excetoIds?: string[]; incluirReservadas?: boolean } = {},
): string[] {
  ensureCoreSchema();
  const filtro = locationId ? ' AND COALESCE(u.location_id, ?) = ?' : '';
  const params: unknown[] = [companyId, productId];
  if (locationId) params.push(localPadraoId(companyId), locationId);
  const exceto = opcoes.excetoIds ?? [];
  const filtroExceto = exceto.length > 0 ? ` AND u.id NOT IN (${exceto.map(() => '?').join(', ')})` : '';
  params.push(...exceto);

  const agoraIso = agora();
  const reservada = sqlReservadaPorOutro('u');
  const paramsDaReserva = [agoraIso, opcoes.documento ?? ''];
  let filtroReserva = '';
  let ordem = 'u.created_at';
  if (opcoes.incluirReservadas) {
    ordem = `CASE WHEN ${reservada} THEN 1 ELSE 0 END, u.created_at`;
  } else {
    filtroReserva = ` AND NOT ${reservada}`;
    params.push(...paramsDaReserva);
  }
  if (opcoes.incluirReservadas) params.push(...paramsDaReserva);
  params.push(quantidade);

  const linhas = getConnection()
    .prepare(
      `SELECT u.id FROM core_product_units u
        WHERE u.company_id = ? AND u.product_id = ? AND u.status = 'in_stock'${filtro}${filtroExceto}${filtroReserva}
        ORDER BY ${ordem}
        LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as { id: string }[];

  if (linhas.length < quantidade) {
    // Quantas ficaram de fora por estarem seguradas: sem isto a recusa diria
    // "tem 0 em estoque" com três motos no pátio, e o operador iria contar.
    const seguradas = opcoes.incluirReservadas
      ? 0
      : (
          getConnection()
            .prepare(
              `SELECT COUNT(*) AS n FROM core_product_units u
                WHERE u.company_id = ? AND u.product_id = ? AND u.status = 'in_stock' AND ${reservada}`,
            )
            .get(companyId, productId, ...paramsDaReserva) as { n: number }
        ).n;
    throw new ApiError(
      'CORE_UNITS_INSUFFICIENT',
      `"${nomeDoProduto(companyId, productId)}" tem ${linhas.length} unidade(s) em estoque` +
        `${locationId ? ' neste local' : ''}, e foram pedidas ${quantidade}.` +
        (seguradas > 0
          ? ` Outras ${seguradas} estão reservadas para pré-venda de outro cliente.`
          : ''),
      409,
      { seguradas },
    );
  }
  return linhas.map((l) => l.id);
}

/**
 * A unidade `alias` está segurada por uma pré-venda VIVA que não é a de `?`?
 *
 * Fragmento SQL com DOIS parâmetros, nesta ordem: o instante de agora (a
 * validade do documento) e o id do documento que NÃO conta (vazio = nenhum).
 * "Viva" é aberta e dentro da validade — pré-venda vencida ou cancelada solta a
 * moto no mesmo instante, sem depender da varredura da abertura de caixa.
 */
export function sqlReservadaPorOutro(alias: string): string {
  return `EXISTS (SELECT 1 FROM core_product_unit_holds h
                    JOIN core_quotes q ON q.id = h.reference_id AND q.company_id = h.company_id
                   WHERE h.unit_id = ${alias}.id
                     AND h.reference_type = 'pre_venda'
                     AND q.status = 'aberto'
                     AND (q.valid_until IS NULL OR q.valid_until >= ?)
                     AND h.reference_id <> ?)`;
}

/**
 * As unidades existem, são desta empresa e deste produto, e estão em estoque?
 *
 * Sem identidade NÃO impede a venda: a moto pode sair do pátio antes de alguém
 * cadastrar o chassi, e travar o balcão por isso empurraria o operador a
 * inventar um número. O que se faz é registrar e cobrar depois, na tela.
 */
export function assertUnitsSellable(
  companyId: string,
  productId: string,
  unitIds: string[],
): ProductUnit[] {
  ensureCoreSchema();
  const unidades: ProductUnit[] = [];
  const vistos = new Set<string>();

  for (const id of unitIds) {
    if (vistos.has(id)) {
      throw new ApiError(
        'CORE_UNIT_REPEATED',
        'A mesma unidade foi informada duas vezes.',
        400,
      );
    }
    vistos.add(id);

    const u = getUnit(companyId, id);
    if (!u) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
    if (u.product_id !== productId) {
      throw new ApiError(
        'CORE_UNIT_WRONG_PRODUCT',
        'Esta unidade pertence a outro produto.',
        409,
      );
    }
    if (u.status !== 'in_stock') {
      throw new ApiError(
        'CORE_UNIT_NOT_AVAILABLE',
        u.status === 'sold'
          ? 'Esta unidade já foi vendida.'
          : 'Esta unidade recebeu baixa e não está em estoque.',
        409,
      );
    }
    unidades.push(u);
  }
  return unidades;
}

/** Tira as unidades do estoque, carimbando por onde saíram. */
export function markUnitsOut(
  companyId: string,
  unitIds: string[],
  saida: {
    referenceType: string;
    referenceId: string;
    saleItemId?: string | null;
    status?: Extract<UnitStatus, 'sold' | 'baixada'>;
    note?: string | null;
  },
): void {
  if (unitIds.length === 0) return;
  const db = getConnection();
  const stmt = db.prepare(
    `UPDATE core_product_units
        SET status = ?, exit_reference_type = ?, exit_reference_id = ?,
            sale_item_id = COALESCE(?, sale_item_id), note = COALESCE(?, note), updated_at = ?
      WHERE id = ? AND company_id = ? AND status = 'in_stock'`,
  );
  const ts = agora();
  for (const id of unitIds) {
    stmt.run(
      saida.status ?? 'sold',
      saida.referenceType,
      saida.referenceId,
      saida.saleItemId ?? null,
      saida.note ?? null,
      ts,
      id,
      companyId,
    );
  }
}

/**
 * Devolve as unidades ao estoque.
 *
 * Limpa a referência de saída porque a unidade volta a estar disponível — se
 * ela ficasse com o carimbo da venda cancelada, o próximo estorno acharia a
 * mesma unidade duas vezes.
 */
export function markUnitsIn(companyId: string, unitIds: string[], locationId?: string | null): void {
  if (unitIds.length === 0) return;
  const db = getConnection();
  const stmt = db.prepare(
    `UPDATE core_product_units
        SET status = 'in_stock', exit_reference_type = NULL, exit_reference_id = NULL,
            sale_item_id = NULL, location_id = COALESCE(?, location_id), updated_at = ?
      WHERE id = ? AND company_id = ?`,
  );
  const ts = agora();
  for (const id of unitIds) stmt.run(locationId ?? null, ts, id, companyId);
}

/**
 * As unidades que saíram por uma referência — é assim que o estorno as acha.
 *
 * A ORDEM É FIXA, e isso não é o mesmo que estar certa.
 *
 * Sem `ORDER BY`, o SQLite devolve na ordem que lhe convém, e quem cortasse a
 * lista com um `slice` estaria escolhendo a moto por sorteio — duas motos iguais
 * na mesma venda, o cliente devolve a B e o sistema podia registrar a A. Ordenar
 * torna o resultado repetível, o que é o mínimo para depurar; o que impede o
 * sorteio de verdade é o chamador dizer QUAL peça voltou, e é isso que
 * `SaleReturnService` passou a exigir.
 */
export function unitsByExitReference(
  companyId: string,
  referenceType: string,
  referenceId: string,
): ProductUnit[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_product_units
        WHERE company_id = ? AND exit_reference_type = ? AND exit_reference_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(companyId, referenceType, referenceId) as unknown as ProductUnit[];
}

/**
 * A peça VOLTOU FISICAMENTE, e não volta a ser vendável.
 *
 * ## Por que existe uma escrita de status FORA do `applyMovement`
 *
 * A regra da casa é que status de unidade serializada só muda dentro do
 * `applyMovement`, na mesma transação do saldo — é o que impede as duas
 * afirmações de divergirem. Aqui a divergência é o PONTO: a devolução "com
 * defeito" existe justamente para o saldo NÃO subir. Somar peça quebrada ao
 * vendável cria estoque que não existe, e a falta só aparece meses depois,
 * quando alguém for vender e não achar.
 *
 * Passar por `applyMovement` exigiria uma entrada seguida de uma saída — dois
 * movimentos que se anulam, poluindo a razão do produto com um vaivém que nunca
 * aconteceu. O que aconteceu foi uma coisa só: a moto voltou para o pátio e não
 * pode ser vendida.
 *
 * Por isso a unidade sai de `sold` para `baixada` sem tocar em `core_stock`, e o
 * `WHERE status = 'sold'` garante que a chamada só age sobre o que de fato saiu
 * vendido — repetir a devolução, ou apontar para uma peça já baixada, não faz
 * nada em vez de reescrever história.
 *
 * A REFERÊNCIA DE SAÍDA FICA COMO ESTÁ, de propósito: a peça saiu naquela venda,
 * e isso continua sendo verdade. É ela que liga a moto do pátio ao documento em
 * que ela foi entregue.
 */
export function markUnitsWrittenOff(
  companyId: string,
  unitIds: string[],
  note?: string | null,
): void {
  if (unitIds.length === 0) return;
  const db = getConnection();
  const stmt = db.prepare(
    `UPDATE core_product_units
        SET status = 'baixada', note = COALESCE(?, note), updated_at = ?
      WHERE id = ? AND company_id = ? AND status = 'sold'`,
  );
  const ts = agora();
  for (const id of unitIds) stmt.run(note ?? null, ts, id, companyId);
}

/** Quantas unidades estão em estoque — para CONFERIR o saldo, nunca para substituí-lo. */
export function countInStock(companyId: string, productId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n FROM core_product_units
        WHERE company_id = ? AND product_id = ? AND status = 'in_stock'`,
    )
    .get(companyId, productId) as { n: number };
  return row.n;
}
