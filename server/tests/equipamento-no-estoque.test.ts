/**
 * A ponte entre a UNIDADE de estoque e a PLAQUINHA da oficina.
 *
 * ## O que este arquivo existe para provar
 *
 * A mesma moto física é duas linhas: `core_product_units` na loja (o que o
 * balcão vende) e `core_equipment` na oficina (o que tem plaquinha, QR e
 * histórico). Antes desta rodada elas não se conheciam — o balcão vendia, a
 * unidade virava `sold`, e o equipamento continuava `NOT_SOLD` sem dono. Quem
 * comprava raspava o QR e o portal respondia vazio.
 *
 * Duas colunas do schema — `core_product_units.equipment_id` e
 * `core_equipment.origin_company_id` — existiam sem NENHUM escritor. Metade
 * destes testes é a prova de que agora têm.
 *
 * `core_equipment.linked_product_id` é a terceira, e continua sem escritor DE
 * PROPÓSITO: ela também não tem leitor, e a FK dela não confere empresa — o
 * produto é da loja e a linha é da oficina. Ver o cabeçalho de `vincularUnidade`.
 * Os testes daqui afirmam que ela permanece nula.
 *
 * ## A travessia de empresa é o assunto, e não um descuido
 *
 * A oficina é OUTRA EMPRESA: `createEquipment` exige que a oficina pertença à
 * empresa que cria o equipamento, logo a PJ Motors não pode criar plaquinha. Não
 * existe um `company_id` que contenha a unidade e a plaquinha ao mesmo tempo.
 * Por isso o cenário de TODO teste daqui tem duas empresas de verdade — usar uma
 * só faria a suíte passar por um caminho que a operação nunca percorre.
 *
 * ## O que cada teste tem de conseguir derrubar
 *
 * Cada `it` daqui foi verificado quebrando o guarda que ele cobre — comentando a
 * linha ou invertendo a condição — e conferindo que fica VERMELHO. Teste que
 * continua verde com o guarda desligado não protege nada; ele só custa tempo e
 * dá coragem falsa a quem lê o resultado da suíte.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import type { ApiError } from '../src/utils/errors.js';
import {
  createProduct,
  updateProduct,
  createCustomer,
  findOrCreateCustomer,
} from '../src/services/core/CatalogService.js';
import { applyMovement, getBalance } from '../src/services/core/InventoryService.js';
import { cancelSale, createSale } from '../src/services/core/SalesService.js';
import { createLocation, transferStock } from '../src/services/core/StockLocationService.js';
import { createUnits, getUnit, identifyUnit } from '../src/services/core/ProductUnitService.js';
import { assignOwner, createEquipment } from '../src/services/core/EquipmentService.js';
import {
  assumeOrder,
  completeTechnical,
  createOrder,
} from '../src/services/core/WorkshopCoreService.js';
import {
  baixarPelaUnidade,
  desvincularUnidade,
  plaquinhaDaUnidade,
  plaquinhasVinculaveis,
  venderPelaUnidade,
  vincularUnidade,
} from '../src/services/core/EquipmentStockLink.js';
import {
  confirmarEmail,
  loginCustomer,
  registerCustomerAccount,
} from '../src/services/core/CustomerPortalService.js';
import { listarEquipamentosDoDono } from '../src/services/core/EquipmentPortalService.js';

const SENHA = 'Teste@Ponte2026';

let loja: string;
let outraLoja: string;
let oficinaCo: string;
let precoJustoCo: string;
let mobilidade: string;
let celulares: string;
let vendedor: string;
let mecanico: string;
let moto: string;

/**
 * A recusa como OBJETO, e não como `toThrow(/texto/)`.
 *
 * O código do erro é o contrato que o balcão e o frontend consomem; a mensagem
 * muda de redação sem que nada quebre. Casar por texto deixaria o teste passar
 * quando o guarda certo fosse trocado por outro guarda de mensagem parecida.
 */
function recusa(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Esperava uma recusa, e a chamada passou.');
}

function linhaPlaquinha(equipmentId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_equipment WHERE id = ?')
    .get(equipmentId) as Record<string, unknown>;
}

function eventosDaPlaquinha(equipmentId: string): { event_type: string; description: string | null }[] {
  return getConnection()
    .prepare(
      'SELECT event_type, description FROM core_equipment_events WHERE equipment_id = ? ORDER BY created_at, rowid',
    )
    .all(equipmentId) as unknown as { event_type: string; description: string | null }[];
}

function workshopIdOf(slug: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

/** Cria N unidades E o saldo correspondente, que é como a entrada de nota faz. */
function entrarComUnidades(
  produto: string,
  quantidade: number,
  ref: string,
  locationId?: string,
): string[] {
  const ids = createUnits(loja, produto, quantidade, {
    entryReferenceType: 'ajuste',
    entryReferenceId: ref,
    locationId: locationId ?? null,
  });
  applyMovement({
    companyId: loja,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'ajuste',
    referenceId: ref,
    locationId: locationId ?? null,
    unitIds: ids,
  });
  return ids;
}

/** Uma plaquinha INTERNA na oficina — que é outra empresa. */
function criarPlaquinha(
  identidade: { chassis?: string; motorNumber?: string; serialNumber?: string; model?: string } = {},
) {
  return createEquipment({
    companyId: oficinaCo,
    workshopId: mobilidade,
    userId: mecanico,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'PJ Motors',
    model: identidade.model ?? 'Sport 3000',
    chassis: identidade.chassis,
    motorNumber: identidade.motorNumber,
    serialNumber: identidade.serialNumber,
  });
}

function vender(
  unitIds: string[],
  chave: string,
  customerId?: string | null,
): { saleId: string } {
  const { sale } = createSale({
    companyId: loja,
    userId: vendedor,
    customerId: customerId ?? null,
    items: [{ productId: moto, quantity: unitIds.length, unitIds }],
    payments: [{ method: 'dinheiro', amountCents: 100_000_00 }],
    idempotencyKey: chave,
  });
  return { saleId: sale.id };
}

/**
 * Um pedido da loja online, gravado direto na tabela.
 *
 * O caminho real é checkout + webhook do provedor, e montá-lo aqui arrastaria
 * reserva, FIFO e Asaas para dentro de um teste de ponte. O que a ponte lê do
 * pedido são DUAS colunas — `customer_id` e `number` —, e é exatamente isso que
 * esta linha entrega. Quem cobre o caminho inteiro é a suíte do e-commerce.
 */
let numeroDePedido = 0;
function pedidoOnline(customerId: string | null): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  numeroDePedido += 1;
  getConnection()
    .prepare(
      `INSERT INTO core_orders
         (id, company_id, number, customer_id, customer_name, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, loja, numeroDePedido, customerId, 'Comprador online', `chk-${id}`, agora, agora);
  return id;
}

/** Uma moto pronta para vender: unidade na loja, plaquinha na oficina, vinculadas. */
function motoComPlaquinha(ref: string) {
  const [unitId] = entrarComUnidades(moto, 1, ref);
  const plaquinha = criarPlaquinha();
  vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });
  return { unitId, equipmentId: plaquinha.id, publicId: plaquinha.public_id };
}

/**
 * Abre uma OS e a põe `em_andamento` — a moto DESMONTADA na bancada.
 *
 * `em_andamento` é um dos quatro estados de `OS_MOTO_DESMONTADA`, e é o que a
 * regra 3 de `assertUnidadesComPlaquinhaVendiveis` enxerga. Deixar a OS
 * `em_aberto` também serviria; o que não serve é `aguardando_pagamento`, que
 * LIBERA de propósito porque ali a moto está inteira.
 */
function porNaBancada(equipmentId: string): { id: string; number: number } {
  const os = createOrder({
    companyId: oficinaCo,
    workshopId: mobilidade,
    userId: mecanico,
    equipmentId,
    customerName: 'Montagem interna',
  });
  assumeOrder({
    companyId: oficinaCo,
    workshopId: mobilidade,
    orderId: os.id,
    userId: mecanico,
    userName: 'Mecânico',
    toStatus: 'em_andamento',
    comment: 'Montando a moto',
  });
  return { id: os.id, number: os.number };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  numeroDePedido = 0;

  loja = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
    kind: 'store',
  });
  outraLoja = upsertCompany({
    slug: 'me-mimei',
    legalName: 'Me Mimei Ltda',
    tradeName: 'Me Mimei',
    kind: 'store',
  });
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  precoJustoCo = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  ensureOfficialWorkshops();
  /*
    A REGRA DE OURO, como no grupo de verdade (rodada 53).

    PJ Motors e Oficina usam plaquinha; Me Mimei nao. O teste monta um grupo
    de mentira e precisa dizer o mesmo que o seed diz, senao o vinculo aqui
    passaria a valer para loja de roupa — que e exatamente o que a regra
    proibe.
  */
  ensureOfficialTagCompanies();
  /*
    A MARCA LIGADA NUMA SEGUNDA LOJA — hoje, o retrato de um banco ANTIGO.

    Antes do P0 das plaquinhas esta linha criava "a segunda operacao com
    plaquinha", para provar o cerco entre empresas. Agora plaquinha e
    exclusiva da PJ Motors: a marca gravada na Me Mimei nao vale nada
    (`empresaUsaPlaquinha` exige o slug da PJ), e e exatamente isso que os
    casos do cerco passam a provar — a marca velha de outra loja nao reabre a
    lista nem o vinculo para ela. O vinculo antigo que ela tenha feito e
    montado a mao, como o banco real o guardaria.
  */
  getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1 WHERE id = ?').run(outraLoja);
  mobilidade = workshopIdOf('oficina-mobilidade');
  celulares = workshopIdOf('oficina-celulares');

  vendedor = await upsertUser({ login: 'BALCAO_PONTE', displayName: 'Balcão', password: SENHA });
  linkUserToCompany(vendedor, loja, 'gerente_loja', true);
  mecanico = await upsertUser({ login: 'MEC_PONTE', displayName: 'Mecânico', password: SENHA });
  linkUserToCompany(mecanico, oficinaCo, 'gerente_oficina', true);

  moto = createProduct(loja, { name: 'Honda CG 160', priceCents: 1_800_000 }).id;
  updateProduct(loja, moto, { serialized: true });
});

/* ------------------------------------------------------------------ vínculo */

describe('o vínculo dá escritor às colunas mortas', () => {
  /**
   * As duas existiam no schema, a rota até aceitava `origin_company_id`, e
   * NENHUMA tela enviava. Eram documentação de uma intenção que o sistema nunca
   * cumpriu. Este teste é o que prova que deixaram de ser.
   */
  it('grava equipment_id na unidade e origin_company_id na plaquinha', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    const plaquinha = criarPlaquinha();

    // Antes: as duas nulas. Sem esta metade, o teste passaria mesmo se alguma
    // delas já viesse preenchida de fábrica.
    expect(getUnit(loja, unitId)!.equipment_id).toBeNull();
    expect(linhaPlaquinha(plaquinha.id).origin_company_id).toBeNull();

    vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });

    expect(getUnit(loja, unitId)!.equipment_id).toBe(plaquinha.id);
    expect(linhaPlaquinha(plaquinha.id).origin_company_id).toBe(loja);
  });

  /**
   * E NÃO GRAVA `linked_product_id`.
   *
   * O vínculo já gravou ali `unidade.product_id`, e o grep do projeto inteiro
   * devolvia só escritas: nenhum leitor. Pior, a FK é
   * `REFERENCES core_products(id)` sem conferir empresa — o produto é da LOJA e
   * a linha é da OFICINA —, então a coluna guardava produto de empresa alheia, e
   * quem chegasse depois e fizesse o JOIN filtrando pela empresa do equipamento
   * não acharia nada.
   *
   * Este teste é o guarda da decisão: se alguém devolver a escrita, ele fica
   * vermelho aqui em vez de a coluna voltar calada.
   */
  it('NÃO grava linked_product_id: a coluna não tem leitor e a FK cruza empresa', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    const plaquinha = criarPlaquinha();

    vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });

    expect(linhaPlaquinha(plaquinha.id).linked_product_id).toBeNull();
    // E o vínculo aconteceu de verdade: sem esta linha o teste passaria também
    // se `vincularUnidade` não tivesse feito nada.
    expect(linhaPlaquinha(plaquinha.id).origin_company_id).toBe(loja);
  });

  /**
   * O CASO CENTRAL DA RODADA.
   *
   * A unidade vive na loja, a plaquinha vive na oficina, e não existe empresa
   * que contenha as duas. Se algum dia alguém "consertar" a travessia colocando
   * um `AND company_id = ?` no caminho da plaquinha, é aqui que a suíte grita.
   */
  it('a ponte ATRAVESSA empresa: unidade na loja, plaquinha na empresa da oficina', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    const plaquinha = criarPlaquinha();

    // As duas pontas estão MESMO em empresas diferentes — é o que dá sentido ao
    // resto do teste.
    expect(getUnit(loja, unitId)!.company_id).toBe(loja);
    expect(linhaPlaquinha(plaquinha.id).company_id).toBe(oficinaCo);
    expect(loja).not.toBe(oficinaCo);

    const vinculada = vincularUnidade({
      companyId: loja,
      unitId,
      equipmentId: plaquinha.id,
      userId: vendedor,
    });

    expect(vinculada.id).toBe(plaquinha.id);
    // A leitura devolve DE ONDE a plaquinha vem: quem escolhe no balcão precisa
    // saber que a moto está na bancada de outra empresa do grupo.
    expect(vinculada.workshopCompanyName).toBe('Oficina');
    expect(vinculada.workshopName).toBe('Oficina de Mobilidade Elétrica');
    expect(plaquinhaDaUnidade(loja, unitId)!.id).toBe(plaquinha.id);
  });

  it('a mesma unidade não recebe uma segunda plaquinha', () => {
    const { unitId } = motoComPlaquinha('e1');
    const outra = criarPlaquinha({ model: 'Urban' });

    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: outra.id, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_UNIT_ALREADY_LINKED');
    expect(err.status).toBe(409);
  });

  it('a mesma plaquinha não vira duas unidades de estoque', () => {
    const { equipmentId } = motoComPlaquinha('e1');
    const [outraUnidade] = entrarComUnidades(moto, 1, 'e2');

    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId: outraUnidade, equipmentId, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_ALREADY_LINKED');
    expect(err.status).toBe(409);
  });

  /** Sem conserto, vincular a moto errada seria definitivo. */
  it('desvincular limpa origin_company_id e devolve a plaquinha à lista', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    // Enquanto vinculada ela SAI da lista de candidatas — uma moto é uma linha
    // de estoque só. Sem esta metade, a lista ofereceria de novo, para outra
    // unidade, a plaquinha que já é desta.
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(equipmentId);

    desvincularUnidade({ companyId: loja, unitId, userId: vendedor });

    // `origin_company_id` é o campo COM LEITOR: enquanto ele estiver preenchido,
    // `plaquinhasVinculaveis` esconde a plaquinha de todas as outras empresas.
    // É por isso que a limpeza dele é o que a asserção seguinte comprova.
    expect(getUnit(loja, unitId)!.equipment_id).toBeNull();
    expect(linhaPlaquinha(equipmentId).origin_company_id).toBeNull();
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).toContain(equipmentId);
  });
});

/* ------------------------------------------- a linha entre travessia e vazamento */

describe('a lista de candidatas atravessa empresa sem vazar o que é dos outros', () => {
  it('mostra a plaquinha interna da oficina, que é de outra empresa', () => {
    const plaquinha = criarPlaquinha();
    const candidatas = plaquinhasVinculaveis(loja);

    expect(candidatas.map((p) => p.id)).toContain(plaquinha.id);
    const achada = candidatas.find((p) => p.id === plaquinha.id)!;
    expect(achada.workshopCompanyName).toBe('Oficina');
    expect(achada.publicIdLabel).toMatch(/^#\d{4}$/);
  });

  /**
   * A LINHA QUE IMPEDE A TRAVESSIA DE VIRAR VAZAMENTO.
   *
   * Sem `origin = 'INTERNAL_PJ_MOTORS'`, a loja veria — e adotaria para o
   * próprio estoque — o aparelho que um cliente deixou na oficina da outra
   * empresa do grupo. Não é sutileza de escopo: é a moto de alguém aparecendo à
   * venda.
   */
  it('NUNCA devolve equipamento de cliente, e a rota também recusa se pedirem pelo id', () => {
    const dono = createCustomer(precoJustoCo, { name: 'Dona do celular', document: '39053344705' });
    const doCliente = createEquipment({
      companyId: precoJustoCo,
      workshopId: celulares,
      userId: mecanico,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: String(dono.id),
      brand: 'Samsung',
      model: 'A54',
    });

    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(doCliente.id);

    // A lista é conveniência de tela, e tela não é autorização: quem chamar a
    // operação direto com o id bate na mesma regra.
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: doCliente.id, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_NOT_LINKABLE');
    expect(err.status).toBe(409);
    // A mensagem pina QUAL das três regras recusou. Sem isto o teste passaria
    // com a regra da origem desligada, porque a de `sale_status` recusa junto —
    // e a recusa certa aqui é "é do cliente", não "já foi vendida".
    expect(err.message).toContain('equipamento de cliente');
  });

  /**
   * A ORIGEM SOZINHA TEM DE SEGURAR, e este cenário é o que a isola.
   *
   * `createEquipment` grava `sale_status = 'NOT_APPLICABLE'` para equipamento de
   * cliente, então na prática a cláusula de venda esconde a de origem — e um
   * teste que só usasse `createEquipment` ficaria verde com a origem desligada.
   *
   * Mas a coluna nasce com DEFAULT `'NOT_SOLD'` na DDL. Qualquer outro escritor
   * que omita `sale_status` — importação, migração, uma rota futura — produz
   * exatamente esta linha: aparelho de CLIENTE com `NOT_SOLD`. Aí a origem é a
   * ÚNICA coisa entre o celular de uma pessoa e a lista de estoque da loja.
   */
  it('aparelho de cliente com sale_status vindo do DEFAULT continua fora da lista', () => {
    const dono = createCustomer(precoJustoCo, { name: 'Dona do celular', document: '39053344705' });
    const id = 'eq-cliente-default';
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_equipment
           (id, company_id, workshop_id, public_id, public_token, origin, owner_customer_id,
            brand, model, status, entered_at, created_at, updated_at)
         VALUES (?, ?, ?, 9001, 'tok-cliente-default', 'EXTERNAL_CUSTOMER', ?, 'Samsung', 'A54',
                 'ativo', ?, ?, ?)`,
      )
      .run(id, precoJustoCo, celulares, String(dono.id), agora, agora, agora);

    // A premissa do teste, conferida: a linha está MESMO no estado que só a
    // regra de origem cobre.
    expect(linhaPlaquinha(id).sale_status).toBe('NOT_SOLD');
    expect(linhaPlaquinha(id).origin).toBe('EXTERNAL_CUSTOMER');

    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(id);

    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: id, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_NOT_LINKABLE');
    expect(err.message).toContain('equipamento de cliente');
  });

  /**
   * Plaquinha vendida SEM unidade vinculada — o cenário que isola a cláusula de
   * `sale_status`.
   *
   * Vender pelo balcão deixa a unidade vinculada, e aí a cláusula "sem unidade"
   * esconde a de venda. `assignOwner` é o caminho manual, e ele produz
   * justamente a moto vendida que nunca passou pelo estoque: adotá-la seria pôr
   * à venda uma moto que já está na garagem de alguém.
   */
  it('NUNCA devolve plaquinha já vendida, e a rota também recusa pelo id', () => {
    const plaquinha = criarPlaquinha({ model: 'Vendida na mão' });
    const dono = createCustomer(oficinaCo, { name: 'Dono antigo', document: '52998224725' });
    assignOwner({
      companyId: oficinaCo,
      equipmentId: plaquinha.id,
      customerId: String(dono.id),
      userId: mecanico,
    });

    expect(linhaPlaquinha(plaquinha.id).sale_status).toBe('SOLD');
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(plaquinha.id);

    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_NOT_LINKABLE');
    expect(err.message).toContain('já foi vendida');
  });

  it('a moto vendida no balcão também some da lista', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });
    vender([unitId], 'v1', String(comprador.id));

    expect(linhaPlaquinha(equipmentId).sale_status).toBe('SOLD');
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(equipmentId);
  });

  it('NUNCA devolve plaquinha já adotada por outra loja do grupo', () => {
    // Adoção de verdade, pela outra loja: a plaquinha ganha `origin_company_id`
    // dela e uma unidade vinculada.
    const motoDaOutra = createProduct(outraLoja, { name: 'Honda Biz', priceCents: 1_500_000 }).id;
    updateProduct(outraLoja, motoDaOutra, { serialized: true });
    const [unidadeDaOutra] = createUnits(outraLoja, motoDaOutra, 1, {
      entryReferenceType: 'ajuste',
      entryReferenceId: 'e-outra',
    });
    applyMovement({
      companyId: outraLoja,
      productId: motoDaOutra,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e-outra',
      unitIds: [unidadeDaOutra],
    });
    const adotada = criarPlaquinha({ model: 'Adotada' });
    /*
      A OUTRA LOJA NÃO ADOTA MAIS (P0 das plaquinhas) — mesmo com a marca
      ligada no cadastro dela. A adoção pela rota era o que este caso montava;
      agora ela é recusada, e o vínculo que a Me Mimei fez ANTES da regra é
      gravado à mão, do jeito que o banco real o guarda.
    */
    const recusaDaOutra = recusa(() =>
      vincularUnidade({
        companyId: outraLoja,
        unitId: unidadeDaOutra,
        equipmentId: adotada.id,
        userId: vendedor,
      }),
    );
    expect(recusaDaOutra.code).toBe('CORE_COMPANY_NO_TAGS');
    getConnection()
      .prepare('UPDATE core_product_units SET equipment_id = ? WHERE id = ?')
      .run(adotada.id, unidadeDaOutra);
    getConnection()
      .prepare('UPDATE core_equipment SET origin_company_id = ? WHERE id = ?')
      .run(outraLoja, adotada.id);

    expect(linhaPlaquinha(adotada.id).origin_company_id).toBe(outraLoja);
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(adotada.id);

    const [minhaUnidade] = entrarComUnidades(moto, 1, 'e1');
    const err = recusa(() =>
      vincularUnidade({
        companyId: loja,
        unitId: minhaUnidade,
        equipmentId: adotada.id,
        userId: vendedor,
      }),
    );
    // Duas regras alcançam este caso — o carimbo de outra empresa e a unidade
    // que já ocupa a plaquinha. Quem responde é a PRIMEIRA, a do carimbo, e é a
    // que fala a língua certa: "já pertence ao estoque de outra empresa do
    // grupo" explica de quem é a moto; "já pertence a outra unidade" mandaria o
    // operador procurar uma unidade que ele não enxerga.
    expect(err.code).toBe('CORE_EQUIPMENT_NOT_LINKABLE');
    expect(err.message).toContain('outra empresa do grupo');
  });

  /**
   * `origin_company_id` sozinho, sem unidade vinculada, também tem de excluir.
   * Este estado existe no banco real: é o que sobra de um vínculo antigo cuja
   * unidade foi apagada, e a regra que o cobre é uma condição própria do SQL.
   */
  it('plaquinha carimbada por outra empresa some da lista mesmo sem unidade vinculada', () => {
    const carimbada = criarPlaquinha({ model: 'Carimbada' });
    getConnection()
      .prepare('UPDATE core_equipment SET origin_company_id = ? WHERE id = ?')
      .run(outraLoja, carimbada.id);

    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).not.toContain(carimbada.id);
    /*
      E a "dona" do carimbo também não a vê (P0 das plaquinhas). Antes esta
      linha cobrava o contrário — o carimbo excluía os outros e deixava a dona
      ver. Agora a Me Mimei não tem plaquinha: a lista dela é vazia mesmo com a
      marca ligada no cadastro, e o carimbo antigo continua gravado sem abrir
      nada para ninguém.
    */
    expect(plaquinhasVinculaveis(outraLoja)).toEqual([]);
    expect(linhaPlaquinha(carimbada.id).origin_company_id).toBe(outraLoja);
  });

  it('a busca acha pela plaquinha com #, sem #, e pelo chassi', () => {
    const plaquinha = criarPlaquinha({ chassis: '9C2KC1670PR000001' });
    const rotulo = `#${String(plaquinha.public_id).padStart(4, '0')}`;

    expect(plaquinhasVinculaveis(loja, rotulo).map((p) => p.id)).toEqual([plaquinha.id]);
    expect(plaquinhasVinculaveis(loja, String(plaquinha.public_id)).map((p) => p.id)).toEqual([
      plaquinha.id,
    ]);
    expect(plaquinhasVinculaveis(loja, '9C2KC1670PR').map((p) => p.id)).toEqual([plaquinha.id]);
    expect(plaquinhasVinculaveis(loja, 'ZZZ-INEXISTENTE')).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- identidade */

describe('identidade: o vínculo reconcilia os dois lados', () => {
  it('lado vazio recebe o número do lado preenchido, nos dois sentidos', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(loja, unitId, { motorNumber: 'KC16E0000001' });
    const plaquinha = criarPlaquinha({ chassis: '9C2KC1670PR000001' });

    vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });

    // A oficina já tinha lido o chassi na bancada: a unidade aproveita.
    expect(getUnit(loja, unitId)!.chassis).toBe('9C2KC1670PR000001');
    // E o motor que só a loja tinha desce para a plaquinha.
    expect(linhaPlaquinha(plaquinha.id).motor_number).toBe('KC16E0000001');
  });

  it('divergência é RECUSA, e a recusa diz qual campo e os dois valores', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(loja, unitId, { chassis: '9C2KC1670PR000001' });
    const plaquinha = criarPlaquinha({ chassis: '9C2KC1670PR999999' });

    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_UNIT_EQUIPMENT_IDENTITY_MISMATCH');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({
      campo: 'chassi',
      unidade: '9C2KC1670PR000001',
      plaquinha: '9C2KC1670PR999999',
    });

    // E nada foi escrito: recusa que grava metade é pior que recusa.
    expect(getUnit(loja, unitId)!.equipment_id).toBeNull();
    expect(linhaPlaquinha(plaquinha.id).chassis).toBe('9C2KC1670PR999999');
  });

  /** Caixa e espaço não são divergência: é a mesma pessoa digitando diferente. */
  it('o mesmo chassi em caixa diferente passa sem pedir confirmação', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(loja, unitId, { chassis: '9c2kc1670pr000001 ' });
    const plaquinha = criarPlaquinha({ chassis: '9C2KC1670PR000001' });

    expect(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor }),
    ).not.toThrow();
  });

  /**
   * A VÁLVULA É OBRIGATÓRIA.
   *
   * O erro mais provável do fluxo é o dígito trocado na bancada. Sem a válvula
   * esse erro vira beco sem saída: o vínculo é o único caminho de conserto da
   * plaquinha, e recusar o vínculo tira justamente o conserto.
   */
  it('confirmarPelaUnidade sobrescreve a plaquinha e deixa evento com os DOIS valores', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(loja, unitId, { chassis: '9C2KC1670PR000001' });
    const plaquinha = criarPlaquinha({ chassis: '9C2KC1670PR999999' });

    vincularUnidade({
      companyId: loja,
      unitId,
      equipmentId: plaquinha.id,
      userId: vendedor,
      confirmarPelaUnidade: true,
    });

    expect(linhaPlaquinha(plaquinha.id).chassis).toBe('9C2KC1670PR000001');

    const evento = eventosDaPlaquinha(plaquinha.id).find((e) => e.event_type === 'stock_linked')!;
    expect(evento).toBeDefined();
    // Sobrescrever calado seria trocar um defeito por outro: sem o valor
    // ANTIGO, ninguém reconstitui o que foi apagado.
    expect(evento.description).toContain('9C2KC1670PR999999');
    expect(evento.description).toContain('9C2KC1670PR000001');
  });

  /**
   * A CORREÇÃO ATRAVESSA DEPOIS DO VÍNCULO.
   *
   * `identifyUnit` é o único caminho de conserto que existe. Se ele parasse na
   * unidade, a plaquinha ficaria com o número velho e a moto teria duas
   * verdades — que é exatamente o defeito que esta rodada mata.
   */
  it('identifyUnit propaga o chassi corrigido para a plaquinha vinculada', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    expect(linhaPlaquinha(equipmentId).chassis).toBeNull();

    identifyUnit(loja, unitId, { chassis: '9C2KC1670PR000001', userId: vendedor });
    expect(linhaPlaquinha(equipmentId).chassis).toBe('9C2KC1670PR000001');

    // E a correção de uma correção também desce.
    identifyUnit(loja, unitId, { chassis: '9C2KC1670PR000002', userId: vendedor });
    expect(linhaPlaquinha(equipmentId).chassis).toBe('9C2KC1670PR000002');

    const corrigidos = eventosDaPlaquinha(equipmentId).filter(
      (e) => e.event_type === 'identity_corrected',
    );
    expect(corrigidos).toHaveLength(2);
    expect(corrigidos[1].description).toContain('9C2KC1670PR000001');
    expect(corrigidos[1].description).toContain('9C2KC1670PR000002');
  });

  /**
   * A correção também não pode criar duas plaquinhas com o mesmo chassi. O
   * caminho de conserto é o único escritor da identidade da plaquinha — se ele
   * não conferisse, seria por ele que a ambiguidade entraria.
   */
  it('corrigir a unidade para um chassi que já é de outra plaquinha é recusado', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    criarPlaquinha({ chassis: '9C2KC1670PR000001', model: 'Já cadastrada' });

    const err = recusa(() =>
      identifyUnit(loja, unitId, { chassis: '9C2KC1670PR000001', userId: vendedor }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_DUPLICATE_IDENTITY');
    expect(err.status).toBe(409);

    // E a unidade também não guardou o número: a transação inteira voltou.
    expect(getUnit(loja, unitId)!.chassis).toBeNull();
    expect(linhaPlaquinha(equipmentId).chassis).toBeNull();
  });

  it('vincular com chassi que já é de outra plaquinha da oficina é recusado', () => {
    criarPlaquinha({ chassis: '9C2KC1670PR000001', model: 'Já existente' });
    const vazia = criarPlaquinha({ model: 'Sem chassi' });

    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(loja, unitId, { chassis: '9C2KC1670PR000001' });

    const err = recusa(() =>
      vincularUnidade({ companyId: loja, unitId, equipmentId: vazia.id, userId: vendedor }),
    );
    expect(err.code).toBe('CORE_EQUIPMENT_DUPLICATE_IDENTITY');
    expect(err.status).toBe(409);
  });
});

/* -------------------------------------------------------------------- venda */

describe('a venda carimba a plaquinha', () => {
  /**
   * O CARIMBO É A RODADA INTEIRA.
   *
   * Sem ele o balcão vende, a unidade vira `sold`, e o equipamento fica
   * `NOT_SOLD` sem dono e sem `sold_at` — que é o estado que este arquivo
   * existe para tornar impossível.
   */
  it('deixa a plaquinha SOLD, com sold_at, sale_id e dono NA EMPRESA DA OFICINA', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const compradorNaLoja = createCustomer(loja, {
      name: 'João Comprador',
      document: '52998224725',
      email: 'joao@example.com',
      phone: '96999990000',
    });

    const { saleId } = vender([unitId], 'v1', String(compradorNaLoja.id));

    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_status).toBe('SOLD');
    expect(linha.sale_id).toBe(saleId);
    expect(linha.sold_at).toBeTruthy();
    expect(linha.owner_customer_id).toBeTruthy();

    // O DONO NÃO É O CADASTRO DA LOJA. Apontar para lá deixaria o portal mudo:
    // a oficina é outra empresa e busca o cliente com o `company_id` dela.
    expect(linha.owner_customer_id).not.toBe(String(compradorNaLoja.id));
    const espelho = getConnection()
      .prepare('SELECT company_id, document, name FROM core_customers WHERE id = ?')
      .get(String(linha.owner_customer_id)) as {
      company_id: string;
      document: string | null;
      name: string;
    };
    expect(espelho.company_id).toBe(oficinaCo);
    // Unidas pelo DOCUMENTO, que é como `syncLinks` junta os cadastros das
    // várias empresas na mesma conta de portal.
    expect(espelho.document).toBe('52998224725');
    expect(espelho.name).toBe('João Comprador');

    expect(eventosDaPlaquinha(equipmentId).map((e) => e.event_type)).toContain('sold');
  });

  /**
   * O CASO QUE PROVA QUE ISSO IMPORTA.
   *
   * Sem ele a rodada 17 fica decorativa para quem comprou: o portal do dono só
   * lista OS pelo `customer_id` da OFICINA, e converter chamado em OS passa por
   * `resolveVinculos`, que busca o cliente com o `company_id` da oficina.
   */
  it('depois da venda o dono consegue ter OS na oficina — e o cadastro da loja daria 404', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const compradorNaLoja = createCustomer(loja, {
      name: 'Maria Dona',
      document: '39053344705',
    });
    vender([unitId], 'v1', String(compradorNaLoja.id));

    const donoNaOficina = String(linhaPlaquinha(equipmentId).owner_customer_id);

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: mecanico,
      customerId: donoNaOficina,
      equipmentId,
      complaint: 'Revisão de 1.000 km',
    });
    expect(os.customer_id).toBe(donoNaOficina);
    expect(os.equipment_id).toBe(equipmentId);
    expect(os.customer_name).toBe('Maria Dona');
    expect(os.status).toBe('em_aberto');

    // O contraste: o cadastro da LOJA é justamente o que não serve. É este 404
    // que o espelho existe para evitar.
    const err = recusa(() =>
      createOrder({
        companyId: oficinaCo,
        workshopId: mobilidade,
        userId: mecanico,
        customerId: String(compradorNaLoja.id),
        equipmentId,
      }),
    );
    expect(err.code).toBe('CORE_CUSTOMER_NOT_FOUND');
    expect(err.status).toBe(404);
  });

  it('vender duas vezes a mesma pessoa reaproveita o espelho, sem duplicar cadastro', () => {
    const primeira = motoComPlaquinha('e1');
    const segunda = motoComPlaquinha('e2');
    const comprador = createCustomer(loja, { name: 'Repetido', document: '52998224725' });

    vender([primeira.unitId], 'v1', String(comprador.id));
    vender([segunda.unitId], 'v2', String(comprador.id));

    const donos = new Set([
      String(linhaPlaquinha(primeira.equipmentId).owner_customer_id),
      String(linhaPlaquinha(segunda.equipmentId).owner_customer_id),
    ]);
    expect(donos.size).toBe(1);

    const quantos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ? AND document = ?')
      .get(oficinaCo, '52998224725') as { n: number };
    expect(quantos.n).toBe(1);
  });

  it('moto SEM plaquinha vende normalmente, sem exigir cliente', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    expect(() => vender([unitId], 'v1')).not.toThrow();
    expect(getUnit(loja, unitId)!.status).toBe('sold');
  });
});

describe('as recusas que rodam ANTES de baixar o estoque', () => {
  it('venda sem cliente é recusada, e o estoque não se mexe', () => {
    const { unitId } = motoComPlaquinha('e1');

    const err = recusa(() => vender([unitId], 'v1'));
    expect(err.code).toBe('CORE_SALE_EQUIPMENT_WITHOUT_CUSTOMER');
    expect(err.status).toBe(409);

    // ANTES, e não durante: recusar com o saldo já escrito significaria
    // desfazer, e desfazer a plaquinha é o caminho que não existe.
    expect(getBalance(loja, moto)).toBe(1);
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
  });

  it('cliente sem CPF/CNPJ é recusado — sem documento não há espelho confiável', () => {
    const { unitId } = motoComPlaquinha('e1');
    const semDocumento = createCustomer(loja, { name: 'Sem documento' });

    const err = recusa(() => vender([unitId], 'v1', String(semDocumento.id)));
    expect(err.code).toBe('CORE_SALE_EQUIPMENT_CUSTOMER_WITHOUT_DOCUMENT');
    expect(err.status).toBe(409);
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
  });

  it('moto desmontada na bancada não sai do estoque, e a recusa diz qual OS', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: mecanico,
      equipmentId,
      customerName: 'Montagem interna',
    });
    assumeOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      toStatus: 'em_andamento',
      comment: 'Montando a moto',
    });

    const err = recusa(() => vender([unitId], 'v1', String(comprador.id)));
    expect(err.code).toBe('CORE_SALE_EQUIPMENT_IN_WORKSHOP');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ ordem: os.number, situacao: 'em_andamento' });
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
  });

  it('a moto PARADA NO SETOR também não sai — a trava conhece a coluna nova', () => {
    /*
      A rodada 51 acrescentou a coluna `parada_setor`, e a lista desta trava
      era escrita por COMPLEMENTO ("os quatro que existiam"): a moto parada no
      setor — desmontada, esperando o técnico voltar — virava vendível. Hoje a
      pergunta "está viva na bancada?" tem uma fonte só
      (`ORDER_STATUSES_ON_BENCH`), e este caso morde essa fonte.
    */
    const { unitId, equipmentId } = motoComPlaquinha('e-parada');
    const comprador = createCustomer(loja, { name: 'Comprador 2', document: '11144477735' });

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: mecanico,
      equipmentId,
      customerName: 'Montagem interna',
    });
    assumeOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      toStatus: 'parada_setor',
      comment: 'Parada esperando o torno',
    });

    const err = recusa(() => vender([unitId], 'v-parada', String(comprador.id)));
    expect(err.code).toBe('CORE_SALE_EQUIPMENT_IN_WORKSHOP');
    expect(err.details).toEqual({ ordem: os.number, situacao: 'parada_setor' });
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
  });

  /**
   * A RECUSA DA BANCADA FALAVA DE VENDA NUMA BAIXA.
   *
   * `assertUnidadesComPlaquinhaVendiveis` roda em TODA saída de estoque, e a
   * regra 3 não olhava a referência: baixar uma moto ACIDENTADA que está
   * desmontada na bancada devolvia `CORE_SALE_EQUIPMENT_IN_WORKSHOP` e a frase
   * "Conclua o serviço antes de entregar a moto" — uma entrega a um cliente que
   * não existe, numa operação que não tem comprador nenhum.
   *
   * É o mesmo defeito de mensagem falsa que a rodada consertou em
   * `desvincularUnidade`, e pior que enganar: a OS de montagem interna com peças
   * não tem caminho para `finalizada`, então a moto batida ficaria presa no
   * estoque PARA SEMPRE, inflando o saldo com uma moto que virou sucata.
   *
   * O guarda que este teste protege é a saída antecipada `referenceType !==
   * 'sale'`. Removê-la faz a baixa voltar a ser recusada, e o `expect` do saldo
   * fica vermelho.
   */
  it('baixa de moto na bancada é LIBERADA — não há cliente a quem entregar', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const os = porNaBancada(equipmentId);

    // O caminho real de `POST /units/:id/write-off`: ajuste negativo, que faz
    // `markUnitsOut` gravar `baixada` e `applyMovement` chamar
    // `baixarPelaUnidade` na mesma transação.
    expect(() =>
      applyMovement({
        companyId: loja,
        productId: moto,
        movementType: 'adjust',
        quantity: -1,
        referenceType: 'unit_write_off',
        referenceId: unitId,
        kind: 'INVENTORY_ADJUSTMENT_NEGATIVE',
        reason: 'Batida no pátio',
        userId: vendedor,
        unitIds: [unitId],
      }),
    ).not.toThrow();

    // A moto saiu DE VERDADE: sem isto o teste passaria com uma baixa que não
    // baixou nada.
    expect(getBalance(loja, moto)).toBe(0);
    expect(getUnit(loja, unitId)!.status).toBe('baixada');

    // E nenhum dono foi inventado: a baixa não é venda.
    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();

    // Liberar não é ficar calado. A bancada continua com a moto desmontada e a
    // OS aberta, e é o histórico da plaquinha que conta isso — com o NÚMERO da
    // OS, que é por onde a oficina acha o serviço que ficou sem moto.
    const baixa = eventosDaPlaquinha(equipmentId).find(
      (e) => e.event_type === 'stock_written_off',
    );
    expect(baixa).toBeDefined();
    expect(baixa!.description).toContain(`OS nº ${os.number}`);

    // Solta e adotável de novo — a plaquinha não fica congelada.
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).toContain(equipmentId);
  });

  /**
   * E A MESMA FRASE DE VENDA APARECIA NUMA TRANSFERÊNCIA.
   *
   * `transferStock` é troca de PRATELEIRA dentro da mesma empresa: duas pernas
   * `out`/`in` com a mesma referência. A unidade nem sai do estoque — volta na
   * perna de entrada com outro `location_id` —, o vínculo com a plaquinha não é
   * tocado e nenhum dono é inventado. Não há fato sobre o qual recusar.
   *
   * E a recusa era perversa: o lugar certo de uma moto desmontada é justamente o
   * local da oficina, que é para onde a transferência estava levando.
   */
  it('transferência de moto na bancada é LIBERADA — a moto muda de prateleira, não de dono', () => {
    const deposito = createLocation(loja, { code: 'DEP', name: 'Depósito' }).id;
    const bancada = createLocation(loja, { code: 'OFIC', name: 'Oficina' }).id;
    const [unitId] = entrarComUnidades(moto, 1, 'e1', deposito);
    const plaquinha = criarPlaquinha();
    vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });
    porNaBancada(plaquinha.id);

    expect(() =>
      transferStock({
        companyId: loja,
        productId: moto,
        fromLocationId: deposito,
        toLocationId: bancada,
        quantity: 1,
      }),
    ).not.toThrow();

    // A transferência ACONTECEU: a unidade é a mesma, no outro local, e continua
    // em estoque. Sem estas linhas o teste passaria com uma transferência que
    // não transferiu.
    expect(getUnit(loja, unitId)!.location_id).toBe(bancada);
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
    expect(getBalance(loja, moto)).toBe(1);

    // O vínculo sobrevive inteiro, e a plaquinha não virou vendida.
    expect(getUnit(loja, unitId)!.equipment_id).toBe(plaquinha.id);
    const linha = linhaPlaquinha(plaquinha.id);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();
    expect(linha.origin_company_id).toBe(loja);
  });

  /**
   * O ESPELHO, E O CASO QUE MAIS IMPORTA DESTE ARQUIVO.
   *
   * A OS de montagem interna COM PEÇAS não tem caminho para `finalizada`:
   * `closeOrder` recusa encerrar sem custo quando `total_cents > 0` e, com
   * custo, grava `aguardando_pagamento`; a única saída de lá é `settleOrder`,
   * que EXIGE `saleId` — e ninguém emite venda para cobrar a loja por montar a
   * própria moto. A OS fica presa para sempre.
   *
   * Se esta recusa passar a olhar "OS != finalizada", TODA moto que passou pela
   * bancada vira invendável. É por isso que `aguardando_pagamento` LIBERA: a
   * moto está inteira, que é o que importa para entregá-la.
   */
  it('OS em aguardando_pagamento LIBERA a venda — senão toda moto montada ficaria invendável', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: mecanico,
      equipmentId,
      customerName: 'Montagem interna',
    });
    assumeOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      toStatus: 'em_andamento',
      comment: 'Montando a moto',
    });
    const concluida = completeTechnical({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      diagnosis: 'Moto montada',
      hasCost: true,
      // Rodada 52: a conferência de entrada segura a conclusão. O assunto
      // DESTE arquivo é a venda da moto, não a conferência — que tem casos
      // próprios em `equipamento-completo.test.ts`.
      forcarChecklist: true,
    });
    // A OS está PRESA aqui — e é justamente daqui que a moto tem de poder sair.
    expect(concluida.status).toBe('aguardando_pagamento');

    expect(() => vender([unitId], 'v1', String(comprador.id))).not.toThrow();
    expect(linhaPlaquinha(equipmentId).sale_status).toBe('SOLD');
    expect(getUnit(loja, unitId)!.status).toBe('sold');
  });

  it('OS finalizada também libera', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: mecanico,
      equipmentId,
      customerName: 'Montagem interna',
    });
    assumeOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      toStatus: 'em_andamento',
      comment: 'Montando',
    });
    const concluida = completeTechnical({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      diagnosis: 'Montada, sem cobrança',
      hasCost: false,
      noCostReason: 'garantia',
      forcarChecklist: true,
    });
    expect(concluida.status).toBe('finalizada');

    expect(() => vender([unitId], 'v1', String(comprador.id))).not.toThrow();
    expect(linhaPlaquinha(equipmentId).sale_status).toBe('SOLD');
  });

  /**
   * NENHUMA RECUSA VALE PARA O CANAL ONLINE, E ISSO É DINHEIRO.
   *
   * A primeira versão desta ponte recusava vender moto com plaquinha pela loja
   * online. A recusa roda em `consumeReservation`, que roda dentro de
   * `handlePaymentWebhook` — DEPOIS de o pagamento ser capturado. O webhook não
   * abre transação e já gravou a intent antes de chamar `markOrderPaid`: o 409
   * deixava o pedido em `aguardando_pagamento` para sempre, porque a re-entrega
   * do provedor bate no dedupe do topo e responde 200 sem processar. Dinheiro
   * capturado, pedido travado, reserva presa — e sem balcão do outro lado para
   * consertar. Pior: quem escolheu a moto vinculada foi o `pickUnitsFifo`.
   */
  it('a loja online NÃO é mais recusada: a saída acontece e o estoque baixa', () => {
    const { unitId } = motoComPlaquinha('e1');
    const pedido = pedidoOnline(null);

    expect(() =>
      applyMovement({
        companyId: loja,
        productId: moto,
        movementType: 'out',
        quantity: 1,
        referenceType: 'ecommerce_order',
        referenceId: pedido,
        unitIds: [unitId],
      }),
    ).not.toThrow();

    expect(getBalance(loja, moto)).toBe(0);
    expect(getUnit(loja, unitId)!.status).toBe('sold');
  });

  /**
   * A ASSIMETRIA É O ASSUNTO: a MESMA moto, na MESMA bancada, recusada no
   * balcão e liberada online. Não é frouxidão de um lado — é que só um dos dois
   * lados tem quem conserte a recusa. No balcão o operador está na frente da
   * tela e a venda ainda não fechou; online o dinheiro já entrou.
   */
  it('moto na bancada: recusa no balcão, passa na loja online', () => {
    const balcao = motoComPlaquinha('e1');
    const online = motoComPlaquinha('e2');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });

    for (const equipmentId of [balcao.equipmentId, online.equipmentId]) {
      const os = createOrder({
        companyId: oficinaCo,
        workshopId: mobilidade,
        userId: mecanico,
        equipmentId,
        customerName: 'Montagem interna',
      });
      assumeOrder({
        companyId: oficinaCo,
        workshopId: mobilidade,
        orderId: os.id,
        userId: mecanico,
        userName: 'Mecânico',
        toStatus: 'em_andamento',
        comment: 'Montando a moto',
      });
    }

    const err = recusa(() => vender([balcao.unitId], 'v1', String(comprador.id)));
    expect(err.code).toBe('CORE_SALE_EQUIPMENT_IN_WORKSHOP');
    expect(getUnit(loja, balcao.unitId)!.status).toBe('in_stock');

    expect(() =>
      applyMovement({
        companyId: loja,
        productId: moto,
        movementType: 'out',
        quantity: 1,
        referenceType: 'ecommerce_order',
        referenceId: pedidoOnline(String(comprador.id)),
        unitIds: [online.unitId],
      }),
    ).not.toThrow();
    expect(getUnit(loja, online.unitId)!.status).toBe('sold');
  });

  /** Sem cliente e sem documento o online também passa — nada ali recusa. */
  it('pedido online sem cliente nenhum não é recusado', () => {
    const { unitId } = motoComPlaquinha('e1');
    const semDocumento = createCustomer(loja, { name: 'Sem documento' });

    expect(() =>
      applyMovement({
        companyId: loja,
        productId: moto,
        movementType: 'out',
        quantity: 1,
        referenceType: 'ecommerce_order',
        referenceId: pedidoOnline(String(semDocumento.id)),
        unitIds: [unitId],
      }),
    ).not.toThrow();
    expect(getUnit(loja, unitId)!.status).toBe('sold');
  });

  it('moto SEM plaquinha continua saindo pela loja online', () => {
    const [unitId] = entrarComUnidades(moto, 1, 'e1');
    expect(() =>
      applyMovement({
        companyId: loja,
        productId: moto,
        movementType: 'out',
        quantity: 1,
        referenceType: 'ecommerce_order',
        referenceId: 'pedido-online-2',
        unitIds: [unitId],
      }),
    ).not.toThrow();
    expect(getBalance(loja, moto)).toBe(0);
  });
});

/* ------------------------------------------------------- a venda online */

/**
 * `venderPelaUnidade` é chamada DIRETO nestes testes, e não por `applyMovement`.
 *
 * O gancho de `applyMovement` decide por `REFERENCIAS_QUE_DAO_DONO` — hoje a
 * MESMA lista, exportada por `EquipmentStockLink` e importada pelo
 * `InventoryService`, depois de as duas cópias terem divergido uma vez. O que se
 * prova aqui é o que a ponte faz QUANDO chamada com um pedido online — que é a
 * metade que mora aqui.
 */
describe('a venda online carimba a plaquinha, e registra o que não pôde afirmar', () => {
  it('comprador online com documento vira dono, com espelho na empresa da oficina', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, {
      name: 'Compradora Online',
      document: '39053344705',
      email: 'online@example.com',
    });
    const pedido = pedidoOnline(String(comprador.id));

    venderPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'ecommerce_order',
      referenceId: pedido,
      userId: vendedor,
    });

    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_status).toBe('SOLD');
    expect(linha.sold_at).toBeTruthy();
    expect(linha.owner_customer_id).toBeTruthy();
    expect(linha.owner_customer_id).not.toBe(String(comprador.id));

    // `sale_id` REFERENCIA `core_sales`, e o pedido online não é uma venda de
    // balcão — no momento do webhook nem existe linha lá. Gravar o id do pedido
    // estouraria a FOREIGN KEY; o rastro fica no evento.
    expect(linha.sale_id).toBeNull();

    const espelho = getConnection()
      .prepare('SELECT company_id, document FROM core_customers WHERE id = ?')
      .get(String(linha.owner_customer_id)) as { company_id: string; document: string | null };
    expect(espelho.company_id).toBe(oficinaCo);
    expect(espelho.document).toBe('39053344705');

    const eventos = eventosDaPlaquinha(equipmentId);
    expect(eventos.map((e) => e.event_type)).toContain('sold');
    expect(eventos.map((e) => e.event_type)).not.toContain('owner_unknown');
  });

  /**
   * MEIA-VERDADE REGISTRADA É MELHOR QUE DIVERGÊNCIA SILENCIOSA.
   *
   * A moto FOI vendida — isso é fato, e `sale_status = 'SOLD'` afirma. Quem é o
   * dono para efeito de portal é que ficou desconhecido, e o histórico diz isso
   * com todas as letras: sem esse evento, meses depois, o `owner_customer_id`
   * nulo vira "bug" para quem lê.
   */
  it('comprador online sem documento: SOLD, dono NULO e evento dizendo por quê', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const semDocumento = createCustomer(loja, { name: 'Sem documento' });

    venderPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'ecommerce_order',
      referenceId: pedidoOnline(String(semDocumento.id)),
      userId: vendedor,
    });

    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_status).toBe('SOLD');
    expect(linha.sold_at).toBeTruthy();
    expect(linha.owner_customer_id).toBeNull();

    const evento = eventosDaPlaquinha(equipmentId).find((e) => e.event_type === 'owner_unknown');
    expect(evento).toBeTruthy();
    expect(evento!.description).toContain('CPF/CNPJ');

    // E NENHUM cadastro solto foi criado na oficina para tapar o buraco.
    const naOficina = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ?')
      .get(oficinaCo) as { n: number };
    expect(naOficina.n).toBe(0);
  });

  it('pedido sem cliente nenhum também vende, e o evento diz que o pedido não tem cliente', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    venderPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'ecommerce_order',
      referenceId: pedidoOnline(null),
      userId: vendedor,
    });

    expect(linhaPlaquinha(equipmentId).sale_status).toBe('SOLD');
    const evento = eventosDaPlaquinha(equipmentId).find((e) => e.event_type === 'owner_unknown');
    expect(evento!.description).toContain('não tem cliente vinculado');
  });

  /** Saiu vendida estando desmontada: não recusa, mas o histórico diz qual OS. */
  it('venda online de moto na bancada registra evento com o número da OS', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });

    const os = createOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      userId: mecanico,
      equipmentId,
      customerName: 'Montagem interna',
    });
    assumeOrder({
      companyId: oficinaCo,
      workshopId: mobilidade,
      orderId: os.id,
      userId: mecanico,
      userName: 'Mecânico',
      toStatus: 'em_andamento',
      comment: 'Montando',
    });

    venderPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'ecommerce_order',
      referenceId: pedidoOnline(String(comprador.id)),
      userId: vendedor,
    });

    expect(linhaPlaquinha(equipmentId).sale_status).toBe('SOLD');
    const evento = eventosDaPlaquinha(equipmentId).find((e) => e.event_type === 'sold_in_workshop');
    expect(evento).toBeTruthy();
    expect(evento!.description).toContain(`nº ${os.number}`);
  });

  /** A venda de balcão continua lendo `core_sales`, e não o pedido online. */
  it('o balcão continua carimbando com sale_id, lendo a venda', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Balcão', document: '52998224725' });
    const { saleId } = vender([unitId], 'v1', String(comprador.id));

    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_id).toBe(saleId);
    expect(linha.owner_customer_id).toBeTruthy();
  });
});

/* ------------------------------------------- o espelho não sequestra ninguém */

/**
 * O MESMO VAZAMENTO QUE A RODADA 17 CONSERTOU EM `syncLinks`.
 *
 * `findOrCreateCustomer` casa por documento e, não achando, CAI PARA E-MAIL —
 * e ao casar grava `document = COALESCE(document, ?)`. Espelhando entre
 * empresas isso é sequestro: o cadastro do comprador na loja pode carregar o
 * e-mail de outra pessoa (basta tê-lo informado num balcão), e na oficina pode
 * existir um cliente antigo, sem CPF, com aquele e-mail. Sem a opção
 * `matchBy: 'document'`, o espelho casa com ELE.
 */
describe('o espelho casa SÓ por documento', () => {
  it('cliente antigo da oficina com o mesmo e-mail NÃO vira dono da moto alheia', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    // O terceiro: cadastro antigo na OFICINA, sem CPF, com um e-mail que outra
    // pessoa também informou no balcão da loja.
    const estranho = createCustomer(oficinaCo, {
      name: 'Cliente Antigo da Oficina',
      email: 'compartilhado@example.com',
    });
    const comprador = createCustomer(loja, {
      name: 'Comprador de Verdade',
      document: '52998224725',
      email: 'compartilhado@example.com',
    });

    vender([unitId], 'v1', String(comprador.id));

    const dono = String(linhaPlaquinha(equipmentId).owner_customer_id);
    // A MOTO NÃO É DELE. Com a queda para e-mail, era.
    expect(dono).not.toBe(String(estranho.id));

    // E o CPF do comprador NÃO foi carimbado no cadastro do estranho.
    const linhaEstranho = getConnection()
      .prepare('SELECT document, name FROM core_customers WHERE id = ?')
      .get(String(estranho.id)) as { document: string | null; name: string };
    expect(linhaEstranho.document).toBeNull();
    expect(linhaEstranho.name).toBe('Cliente Antigo da Oficina');

    // O espelho é um cadastro NOVO, com o documento do comprador.
    const linhaDono = getConnection()
      .prepare('SELECT document, company_id, name FROM core_customers WHERE id = ?')
      .get(dono) as { document: string | null; company_id: string; name: string };
    expect(linhaDono.document).toBe('52998224725');
    expect(linhaDono.company_id).toBe(oficinaCo);
    expect(linhaDono.name).toBe('Comprador de Verdade');
  });

  /**
   * O PADRÃO NÃO MUDOU PARA QUEM JÁ CHAMAVA.
   *
   * `StorefrontService` depende da queda para e-mail: é o cliente que comprou
   * sem informar CPF e volta. Se a opção nova tivesse virado o padrão, o
   * checkout passaria a duplicar cadastro a cada compra.
   */
  it('sem a opção, a queda para e-mail continua existindo — e com ela, não', () => {
    const antigo = createCustomer(loja, { name: 'Antigo', email: 'volta@example.com' });

    const porEmail = findOrCreateCustomer(loja, {
      name: 'Antigo',
      email: 'volta@example.com',
    });
    expect(String(porEmail.id)).toBe(String(antigo.id));

    const soPorDocumento = findOrCreateCustomer(
      loja,
      { name: 'Antigo', email: 'volta@example.com' },
      { matchBy: 'document' },
    );
    // Não casa E não cria: sem documento não há como dizer quem é esta pessoa.
    expect(soPorDocumento).toBeNull();
    const quantos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ? AND email = ?')
      .get(loja, 'volta@example.com') as { n: number };
    expect(quantos.n).toBe(1);
  });
});

/* ---------------------------------------------- documento é DÍGITO, não texto */

/**
 * "ISENTO" É O CASO REAL.
 *
 * A guarda conferia texto não-vazio; `findOrCreateCustomer` normaliza com
 * `replace(/\D/g, '')` e guarda só DÍGITOS. "ISENTO" passava a guarda, a venda
 * seguia, e o espelho nascia com `document` NULL — e aí `syncLinks`, que une os
 * cadastros pelo documento, nunca unia nada. Guarda e escrita têm de medir a
 * MESMA coisa.
 */
describe('a guarda de documento mede o mesmo que o cadastro grava', () => {
  it('documento sem nenhum dígito é recusado no balcão', () => {
    const { unitId } = motoComPlaquinha('e1');
    const isento = createCustomer(loja, { name: 'Isento', document: 'ISENTO' });

    const err = recusa(() => vender([unitId], 'v1', String(isento.id)));
    expect(err.code).toBe('CORE_SALE_EQUIPMENT_CUSTOMER_WITHOUT_DOCUMENT');
    expect(err.status).toBe(409);
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
  });

  /** Pontuação NÃO é ausência de documento: CPF formatado tem 11 dígitos. */
  it('CPF com ponto e traço continua passando, e o espelho guarda só os dígitos', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, {
      name: 'Formatado',
      document: '529.982.247-25',
    });

    expect(() => vender([unitId], 'v1', String(comprador.id))).not.toThrow();
    const espelho = getConnection()
      .prepare('SELECT document FROM core_customers WHERE id = ?')
      .get(String(linhaPlaquinha(equipmentId).owner_customer_id)) as { document: string };
    expect(espelho.document).toBe('52998224725');
  });
});

/* --------------------------------------------------- a baixa solta a plaquinha */

/**
 * A BAIXA CONGELAVA A PLAQUINHA PARA SEMPRE.
 *
 * `POST /units/:id/write-off` deixa a unidade `baixada` com `equipment_id`
 * ainda apontando para a plaquinha. `plaquinhasVinculaveis` exclui toda
 * plaquinha que tenha unidade apontando para ela, e `desvincularUnidade` recusa
 * soltar unidade fora do estoque: a moto sumia da lista de adotáveis e a única
 * saída era mexer no banco à mão.
 */
describe('a baixa desfaz o vínculo e devolve a plaquinha à lista', () => {
  it('limpa os três campos, registra evento e a plaquinha volta a ser adotável', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      referenceId: 'perda-1',
      unitIds: [unitId],
    });
    baixarPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'unit_write_off',
      userId: vendedor,
    });

    expect(getUnit(loja, unitId)!.equipment_id).toBeNull();
    const linha = linhaPlaquinha(equipmentId);
    // O campo com leitor: limpo, a plaquinha volta à lista de candidatas — que é
    // o que a última asserção deste teste confere.
    expect(linha.origin_company_id).toBeNull();
    // A moto saiu do estoque, mas NÃO foi vendida: continua sem dono.
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();

    expect(eventosDaPlaquinha(equipmentId).map((e) => e.event_type)).toContain(
      'stock_written_off',
    );
    expect(plaquinhasVinculaveis(loja).map((p) => p.id)).toContain(equipmentId);
  });

  it('a plaquinha solta pela baixa pode ser vinculada a outra unidade', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      referenceId: 'perda-1',
      unitIds: [unitId],
    });
    baixarPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'unit_write_off',
      userId: vendedor,
    });

    const [outra] = entrarComUnidades(moto, 1, 'e2');
    expect(() =>
      vincularUnidade({ companyId: loja, unitId: outra, equipmentId, userId: vendedor }),
    ).not.toThrow();
    expect(getUnit(loja, outra)!.equipment_id).toBe(equipmentId);
  });

  /**
   * DECIDE POR ESTADO, como `devolverPelaUnidade`.
   *
   * Plaquinha vendida tem dono, e o vínculo é o que sustenta o portal dele:
   * soltar ali apagaria o caminho entre a pessoa e a moto dela.
   */
  it('plaquinha JÁ VENDIDA não é solta, mesmo se a função for chamada', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Dono', document: '52998224725' });
    vender([unitId], 'v1', String(comprador.id));

    baixarPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'unit_write_off',
      userId: vendedor,
    });

    expect(getUnit(loja, unitId)!.equipment_id).toBe(equipmentId);
    expect(linhaPlaquinha(equipmentId).origin_company_id).toBe(loja);
    expect(eventosDaPlaquinha(equipmentId).map((e) => e.event_type)).not.toContain(
      'stock_written_off',
    );
  });

  /** Referência que dá dono não passa por aqui: quem manda lá é a venda. */
  it('referência de venda não desamarra nada', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    baixarPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'sale',
      userId: vendedor,
    });
    baixarPelaUnidade({
      companyId: loja,
      unitIds: [unitId],
      referenceType: 'ecommerce_order',
      userId: vendedor,
    });

    expect(getUnit(loja, unitId)!.equipment_id).toBe(equipmentId);
    expect(linhaPlaquinha(equipmentId).origin_company_id).toBe(loja);
  });

  /**
   * A MENSAGEM TEM DE DESCREVER O ESTADO CERTO.
   *
   * A frase única falava de VENDA, e a unidade baixada caía nela: o operador
   * era mandado procurar uma venda que não existe. Mensagem que descreve o
   * estado errado é pior que nenhuma.
   */
  it('desvincular unidade baixada fala de BAIXA; unidade vendida fala de VENDA', () => {
    const baixada = motoComPlaquinha('e1');
    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      referenceId: 'perda-1',
      unitIds: [baixada.unitId],
    });

    /*
      A LINHA ANTIGA, RECRIADA À MÃO — e é o único jeito de chegar neste estado.

      Desde que a baixa passou a soltar a plaquinha dentro do `applyMovement`,
      unidade `baixada` com `equipment_id` preenchido não nasce mais: o vínculo
      se desfaz na mesma transação da saída. Sem esta linha, `desvincularUnidade`
      recusa antes, por `CORE_UNIT_NOT_LINKED`, e a mensagem sob teste nunca é
      alcançada.

      O estado continua existindo no banco real: toda unidade baixada ANTES
      daquele conserto está assim. É para ela que a frase precisa estar certa —
      quem a encontra é o operador de hoje, e mandá-lo procurar uma venda que
      nunca existiu é o defeito que este teste cobre.
    */
    getConnection()
      .prepare('UPDATE core_product_units SET equipment_id = ? WHERE id = ?')
      .run(baixada.equipmentId, baixada.unitId);

    const erroDaBaixa = recusa(() =>
      desvincularUnidade({ companyId: loja, unitId: baixada.unitId, userId: vendedor }),
    );
    expect(erroDaBaixa.code).toBe('CORE_UNIT_NOT_AVAILABLE');
    expect(erroDaBaixa.message).toContain('baixa');
    // A frase antiga mandava procurar uma venda que nunca existiu.
    expect(erroDaBaixa.message).not.toContain('venda');

    const vendida = motoComPlaquinha('e2');
    const comprador = createCustomer(loja, { name: 'Dono', document: '52998224725' });
    vender([vendida.unitId], 'v1', String(comprador.id));

    const erroDaVenda = recusa(() =>
      desvincularUnidade({ companyId: loja, unitId: vendida.unitId, userId: vendedor }),
    );
    expect(erroDaVenda.code).toBe('CORE_UNIT_NOT_AVAILABLE');
    expect(erroDaVenda.message).toContain('vendida');
  });
});

/* ---------------------------------------------- saída que NÃO é venda */

describe('só a venda dá dono', () => {
  /** A moto muda de prateleira, não de dono. */
  it('transferência entre locais não carimba a plaquinha como vendida', () => {
    const deposito = createLocation(loja, { code: 'DEP', name: 'Depósito' }).id;
    const balcao = createLocation(loja, { code: 'LOJA', name: 'Loja' }).id;
    const [unitId] = entrarComUnidades(moto, 1, 'e1', deposito);
    const plaquinha = criarPlaquinha();
    vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });

    transferStock({
      companyId: loja,
      productId: moto,
      fromLocationId: deposito,
      toLocationId: balcao,
      quantity: 1,
    });

    const linha = linhaPlaquinha(plaquinha.id);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();
    expect(linha.sold_at).toBeNull();
    expect(linha.sale_id).toBeNull();
    // A unidade continua a MESMA, só que no outro local.
    expect(getUnit(loja, unitId)!.location_id).toBe(balcao);
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');
  });

  /** Perda, quebra ou devolução ao fornecedor: não há comprador para nomear. */
  it('baixa por perda não carimba a plaquinha como vendida', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      referenceId: 'perda-1',
      unitIds: [unitId],
    });

    expect(getUnit(loja, unitId)!.status).toBe('baixada');
    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();
    expect(linha.sold_at).toBeNull();
    expect(eventosDaPlaquinha(equipmentId).map((e) => e.event_type)).not.toContain('sold');
  });

  /**
   * QUEM DECIDE É O TIPO DA REFERÊNCIA, NÃO O ID.
   *
   * Os dois testes acima não conseguem separar a decisão de
   * `REFERENCIAS_QUE_DAO_DONO`
   * do acaso: transferência e baixa usam ids que não existem em `core_sales`, e
   * a busca do comprador falharia de qualquer jeito. O guarda ficaria removível
   * sem nenhum teste ficar vermelho.
   *
   * Aqui a baixa carrega o id de uma venda DE VERDADE — com comprador
   * documentado, pronto para ser espelhado. Só o tipo da referência separa esta
   * perda de uma venda, e é exatamente isso que a lista de referências existe
   * para decidir.
   */
  it('baixa cujo id coincide com o de uma venda real continua não dando dono', () => {
    const vendida = motoComPlaquinha('e1');
    const perdida = motoComPlaquinha('e2');
    const comprador = createCustomer(loja, { name: 'Comprador', document: '52998224725' });
    const { saleId } = vender([vendida.unitId], 'v1', String(comprador.id));

    applyMovement({
      companyId: loja,
      productId: moto,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      // O MESMO id da venda acima. Se a decisão fosse pelo id, a moto perdida
      // ganharia o comprador da outra.
      referenceId: saleId,
      unitIds: [perdida.unitId],
    });

    const linha = linhaPlaquinha(perdida.equipmentId);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();
    expect(linha.sale_id).toBeNull();
    // E a moto que de fato foi vendida continua vendida: a baixa não mexeu nela.
    expect(linhaPlaquinha(vendida.equipmentId).sale_status).toBe('SOLD');
  });
});

/* --------------------------------------------------------------- devolução */

describe('a devolução desfaz o carimbo', () => {
  it('cancelar a venda devolve a plaquinha a NOT_SOLD, sem dono e sem sold_at', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Arrependido', document: '52998224725' });
    const { saleId } = vender([unitId], 'v1', String(comprador.id));
    expect(linhaPlaquinha(equipmentId).sale_status).toBe('SOLD');

    cancelSale({ companyId: loja, saleId, userId: vendedor, reason: 'desistência' });

    const linha = linhaPlaquinha(equipmentId);
    expect(linha.sale_status).toBe('NOT_SOLD');
    expect(linha.owner_customer_id).toBeNull();
    expect(linha.sold_at).toBeNull();
    expect(linha.sale_id).toBeNull();
    expect(getUnit(loja, unitId)!.status).toBe('in_stock');

    // O histórico NÃO apaga a passagem: houve dono, e ele deixou de ser.
    const tipos = eventosDaPlaquinha(equipmentId).map((e) => e.event_type);
    expect(tipos).toContain('sold');
    expect(tipos).toContain('sale_reverted');
  });

  it('a moto devolvida volta a poder ser vendida, com outro dono', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const primeiro = createCustomer(loja, { name: 'Primeiro', document: '52998224725' });
    const segundo = createCustomer(loja, { name: 'Segundo', document: '39053344705' });

    const { saleId } = vender([unitId], 'v1', String(primeiro.id));
    cancelSale({ companyId: loja, saleId, userId: vendedor, reason: 'desistência' });
    vender([unitId], 'v2', String(segundo.id));

    const dono = getConnection()
      .prepare('SELECT name, company_id FROM core_customers WHERE id = ?')
      .get(String(linhaPlaquinha(equipmentId).owner_customer_id)) as {
      name: string;
      company_id: string;
    };
    expect(dono.name).toBe('Segundo');
    expect(dono.company_id).toBe(oficinaCo);
  });

  /**
   * A volta não é filtrada por referência, e a assimetria é proposital: quem
   * estorna não sabe se aquela unidade chegou a ter dono. Uma moto com
   * plaquinha que nunca foi vendida não pode derrubar o estorno inteiro.
   */
  it('estornar entrada de unidade que nunca teve dono não quebra nada', () => {
    const { unitId, equipmentId } = motoComPlaquinha('e1');

    expect(() =>
      applyMovement({
        companyId: loja,
        productId: moto,
        movementType: 'in',
        quantity: 1,
        referenceType: 'ajuste',
        referenceId: 'reentrada-1',
        unitIds: [unitId],
      }),
    ).not.toThrow();
    expect(linhaPlaquinha(equipmentId).sale_status).toBe('NOT_SOLD');
    expect(eventosDaPlaquinha(equipmentId).map((e) => e.event_type)).not.toContain('sale_reverted');
  });
});

/* ---------------------------------------------------- a regra mora no código */

describe('chassi repetido é recusa do CÓDIGO, não do índice', () => {
  /**
   * A PROVA DE QUE A REGRA NÃO ESTÁ PENDURADA NO ÍNDICE.
   *
   * `ux_equipment_chassis` nasce na MIGRAÇÃO, e `resetDbForTests` só chama
   * `ensureCoreSchema` — a DDL canônica pura. Este teste confere primeiro que o
   * índice NÃO existe aqui, e só então cobra a recusa: se a regra vivesse apenas
   * no índice, nenhum teste a alcançaria, e o defeito só apareceria em
   * produção.
   */
  it('o índice único não existe no banco de teste — e a recusa acontece assim mesmo', () => {
    const indice = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_equipment_chassis'")
      .get() as { name: string } | undefined;
    expect(indice).toBeUndefined();

    const primeira = criarPlaquinha({ chassis: '9C2KC1670PR000001' });

    const err = recusa(() => criarPlaquinha({ chassis: '9C2KC1670PR000001', model: 'Clone' }));
    expect(err.code).toBe('CORE_EQUIPMENT_DUPLICATE_IDENTITY');
    expect(err.status).toBe(409);
    // A recusa diz QUAL plaquinha já usa o número: sem isso, quem está na
    // bancada não sabe se digitou errado ou se a moto já foi cadastrada.
    expect(err.message).toContain(`#${String(primeira.public_id).padStart(4, '0')}`);

    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_equipment WHERE chassis = ?')
      .get('9C2KC1670PR000001') as { n: number };
    expect(quantas.n).toBe(1);
  });

  /** O chassi é único DENTRO da empresa: outra oficina pode ter o mesmo número. */
  it('a mesma identidade em empresa diferente não colide', () => {
    criarPlaquinha({ chassis: '9C2KC1670PR000001' });
    expect(() =>
      createEquipment({
        companyId: precoJustoCo,
        workshopId: celulares,
        userId: mecanico,
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Outra',
        chassis: '9C2KC1670PR000001',
      }),
    ).not.toThrow();
  });

  /** Em branco não é identidade, e duas plaquinhas em branco não colidem. */
  it('chassi em branco não vira identidade repetida', () => {
    expect(() => criarPlaquinha({ chassis: '   ', model: 'Sem chassi 1' })).not.toThrow();
    expect(() => criarPlaquinha({ chassis: '', model: 'Sem chassi 2' })).not.toThrow();
    const nulos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_equipment WHERE chassis IS NULL')
      .get() as { n: number };
    expect(nulos.n).toBe(2);
  });
});

/* ------------------------------------------ o último elo: o dono vê no portal */

/**
 * A CORRENTE INTEIRA, DA VENDA ATÉ A TELA DO COMPRADOR.
 *
 * Tudo o que este arquivo cobra acima termina numa promessa: quem comprou raspa
 * o QR, entra, e vê a moto. O elo que faltava era o ÚLTIMO, e ele arrebentava
 * exatamente no caso normal do balcão.
 *
 * A cadeia, elo por elo:
 *
 *  1. o comprador é cadastrado no balcão com nome e CPF — SEM e-mail, que é
 *     como a loja cadastra quem está na frente dela;
 *  2. `venderPelaUnidade` espelha esse cadastro na empresa da OFICINA por
 *     `matchBy: 'document'`, herdando o e-mail do cadastro da loja: NULO;
 *  3. `loginCustomer` chamava `syncLinks` com documento nulo — porque
 *     `core_customer_accounts` não guarda documento — e caía no ramo do e-mail;
 *  4. o espelho tem e-mail NULO, então nunca entrava em
 *     `core_customer_account_links`;
 *  5. `listarEquipamentosDoDono` filtra `owner_customer_id IN (vínculos)` e
 *     devolvia ZERO.
 *
 * Medido com controle: cadastro de balcão SEM e-mail dava 0 equipamentos; o
 * MESMO cenário com e-mail dava 1. A venda chega a EXIGIR o CPF dizendo por
 * escrito que "é por ele que a oficina reconhece o dono no portal" — e era uma
 * promessa que o login não cumpria.
 */
describe('o comprador de balcão enxerga a moto no portal', () => {
  const CPF = '52998224725';
  const SENHA_PORTAL = 'PortalDoDono@2026';

  /**
   * A conta do e-commerce: e-mail E documento no MESMO cadastro, que é a única
   * prova que `registerCustomerAccount` aceita. Ela nasce noutra operação do
   * grupo — a pessoa comprou uma capa de chuva no Preço Justo antes de comprar
   * a moto na PJ Motors.
   */
  async function contaDoEcommerce(email: string): Promise<void> {
    createCustomer(precoJustoCo, {
      name: 'Dona da Moto',
      document: CPF,
      email,
    });
    const sessao = await registerCustomerAccount({ termsAccepted: true, email, document: CPF, password: SENHA_PORTAL });
    // Rodada 50: a co-prova espera o código — prova a caixa na hora, como o
    // dono dela faria (a espera em si mora em cadastro-por-email.test.ts).
    const linha = getConnection()
      .prepare(
        `SELECT id FROM core_email_queue
          WHERE template = 'verificacao_email' AND to_address = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(email) as { id: string } | undefined;
    const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
    expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy(); confirmarEmail({ accountId: sessao.account.id, codigo });
  }

  /** A venda de balcão do jeito que ela acontece: nome, CPF, e nenhum e-mail. */
  function vendaDeBalcaoSemEmail(ref: string, chave: string): string {
    const { unitId, equipmentId } = motoComPlaquinha(ref);
    const comprador = createCustomer(loja, { name: 'Dona da Moto', document: CPF });
    // O cadastro do balcão REALMENTE não tem e-mail — é a premissa do caso.
    expect(
      (
        getConnection()
          .prepare('SELECT email FROM core_customers WHERE id = ?')
          .get(String(comprador.id)) as { email: string | null }
      ).email,
    ).toBeNull();
    vender([unitId], chave, String(comprador.id));
    return equipmentId;
  }

  it('conta do e-commerce + venda de balcão sem e-mail: a moto aparece', async () => {
    const email = 'dona@exemplo.com';
    await contaDoEcommerce(email);
    const equipmentId = vendaDeBalcaoSemEmail('e1', 'v1');

    // O espelho na oficina existe e é MUDO para o e-mail: é ele que o vínculo
    // por e-mail nunca alcançaria.
    const espelho = getConnection()
      .prepare('SELECT id, email, document, company_id FROM core_customers WHERE id = ?')
      .get(String(linhaPlaquinha(equipmentId).owner_customer_id)) as {
      id: string;
      email: string | null;
      document: string;
      company_id: string;
    };
    expect(espelho.email).toBeNull();
    expect(espelho.document).toBe(CPF);
    expect(espelho.company_id).toBe(oficinaCo);

    const sessao = await loginCustomer({ email, password: SENHA_PORTAL });
    const motos = listarEquipamentosDoDono(sessao.customers.map((c) => c.customerId));

    // O QUE A RODADA PROMETE. Antes do conserto: [].
    expect(motos.map((m) => m.id)).toContain(equipmentId);
    expect(motos).toHaveLength(1);
  });

  /**
   * O CONTROLE que mediu o defeito: o MESMO cenário, mudando só o e-mail no
   * cadastro do balcão, já funcionava antes. Se este passar e o de cima falhar,
   * o defeito é exatamente o que o cabeçalho descreve — e não outra coisa.
   */
  it('e o mesmo cenário COM e-mail no balcão continua funcionando', async () => {
    const email = 'dona@exemplo.com';
    await contaDoEcommerce(email);

    const { unitId, equipmentId } = motoComPlaquinha('e1');
    const comprador = createCustomer(loja, { name: 'Dona da Moto', document: CPF, email });
    vender([unitId], 'v1', String(comprador.id));

    const sessao = await loginCustomer({ email, password: SENHA_PORTAL });
    const motos = listarEquipamentosDoDono(sessao.customers.map((c) => c.customerId));
    expect(motos.map((m) => m.id)).toContain(equipmentId);
  });

  /**
   * O VÍNCULO É RECALCULADO A CADA LOGIN, e é isso que faz a moto aparecer para
   * quem já tinha conta antes de comprar. Sem isso, a compra de hoje só seria
   * vista por quem criasse uma conta amanhã.
   */
  it('a moto comprada DEPOIS do login anterior aparece no login seguinte', async () => {
    const email = 'dona@exemplo.com';
    await contaDoEcommerce(email);

    const antes = await loginCustomer({ email, password: SENHA_PORTAL });
    expect(listarEquipamentosDoDono(antes.customers.map((c) => c.customerId))).toEqual([]);

    const equipmentId = vendaDeBalcaoSemEmail('e1', 'v1');

    const depois = await loginCustomer({ email, password: SENHA_PORTAL });
    expect(
      listarEquipamentosDoDono(depois.customers.map((c) => c.customerId)).map((m) => m.id),
    ).toContain(equipmentId);
  });

  /**
   * O CONTRÁRIO, que é o que impede o conserto de virar o vazamento da rodada
   * 17 outra vez: alcançar documento NÃO pode transformar o e-mail em chave.
   * A moto de OUTRA pessoa, num cadastro que carrega o meu e-mail e não tem
   * documento, continua fora da minha lista.
   */
  it('moto de terceiro num cadastro com o MEU e-mail e sem CPF não entra na minha lista', async () => {
    const email = 'dona@exemplo.com';
    await contaDoEcommerce(email);
    const minhaMoto = vendaDeBalcaoSemEmail('e1', 'v1');

    // A moto da outra pessoa, na oficina, cujo cadastro carrega o MEU e-mail e
    // nenhum documento — o cadastro antigo que o balcão preenche torto.
    const alheia = criarPlaquinha({ model: 'Moto da outra pessoa' });
    const terceiro = createCustomer(oficinaCo, { name: 'Outra Pessoa', email });
    assignOwner({
      companyId: oficinaCo,
      equipmentId: alheia.id,
      customerId: String(terceiro.id),
      userId: mecanico,
    });

    const sessao = await loginCustomer({ email, password: SENHA_PORTAL });
    const ids = listarEquipamentosDoDono(sessao.customers.map((c) => c.customerId)).map((m) => m.id);

    expect(ids).toContain(minhaMoto);
    expect(ids).not.toContain(alheia.id);
  });
});
