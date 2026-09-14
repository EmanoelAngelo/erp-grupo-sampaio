/**
 * REORÇAR REPROMETE A PEÇA — senão o cliente fica sem botão nenhum.
 *
 * ============================================================================
 * O CICLO QUE SÓ ANDAVA PARA UM LADO
 * ============================================================================
 *
 * A promessa da peça nasce no lançamento (`prometerPeca`), cai na recusa do
 * orçamento (`soltarPromessasDaOs`) e vira baixa no consumo. Faltava a aresta
 * de volta: **reorçar**.
 *
 * O fluxo real da oficina é esse. O mecânico lança a peça, pede aprovação, o
 * cliente recusa, a oficina liga, negocia, ajusta o orçamento e pede aprovação
 * DE NOVO. Nesse segundo pedido, `pedirAprovacaoOrcamento` só reescrevia
 * `approval_requested_at` — a peça continuava na conta da OS, contando no
 * total que o cliente ia aprovar, mas sem nenhuma reserva de estoque.
 *
 * Daí saem dois danos:
 *
 *   1. O BALCÃO VENDE A PEÇA. O disponível voltou a incluí-la, e nada avisa
 *      que ela está prometida a um conserto.
 *   2. O CLIENTE FICA TRAVADO. Ao aprovar pelo portal, o consumo cai na baixa
 *      direta, o `CHECK (quantity >= 0)` estoura, e o 409 volta com a palavra
 *      "estoque" para alguém que não tem ação nenhuma sobre estoque. Pior: o
 *      rollback desfaz o `approved_at` junto, então o botão fica quebrado para
 *      sempre naquela OS.
 *
 * ============================================================================
 * A SEGUNDA CAMADA, QUE FAZ O CONSERTO ÓBVIO NÃO FUNCIONAR
 * ============================================================================
 *
 * Chamar `prometerPeca` de novo não bastava. `reserveStock` tem um
 * curto-circuito de idempotência: se já existe um movimento `reserve` para
 * aquela referência, ele **retorna em silêncio**. E a referência era a própria
 * linha da OS (`orderId:partId`), que não muda. Quer dizer: uma vez solta,
 * aquela linha nunca mais poderia ser reservada.
 *
 * Por isso a promessa passou a ter CICLO. `soltarPromessaParcial` já tinha
 * resolvido a mesma colisão do mesmo jeito, pondo o acumulado na referência —
 * este é o irmão dele.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection, withTransaction } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createCustomer, createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getAvailable, getBalance } = await import(
  '../src/services/core/InventoryService.js'
);
const {
  estadoDaPeca,
  consumirPromessasDaOs,
  soltarPromessasDaOs,
  reprometerPromessasDaOs,
  prometerPeca,
  SQL_PROMESSAS_ABERTAS,
} = await import('../src/services/core/WorkshopPartsReservation.js');
const { pedirAprovacaoOrcamento } = await import('../src/services/core/WorkshopCoreService.js');

let oficina: string;
let mecanico: string;
let cliente: string;
let peca: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  oficina = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  mecanico = await upsertUser({
    login: 'MEC_REORCA',
    displayName: 'Mecânico',
    password: 'Teste@Reorca2026',
  });
  linkUserToCompany(mecanico, oficina, 'gerente_oficina', true);
  cliente = String(createCustomer(oficina, { name: 'Dona da moto', document: '39053344705' }).id);

  // UMA peça na gaveta. É o número que faz a corrida aparecer.
  peca = createProduct(oficina, { name: 'Pastilha de freio', priceCents: 8_000 }).id;
  applyMovement({
    companyId: oficina,
    productId: peca,
    movementType: 'in',
    quantity: 1,
    referenceType: 'entrada',
    referenceId: 'carga',
  });
});

/** Uma OS com uma linha de peça lançada e prometida. */
function osComPecaPrometida(): { orderId: string; partId: string } {
  const orderId = randomUUID();
  const partId = randomUUID();
  const agora = new Date().toISOString();

  getConnection()
    .prepare(
      `INSERT INTO core_service_orders
         (id, company_id, number, status, complaint, customer_id, created_at, updated_at)
       VALUES (?, ?, 1, 'em_aberto', 'Não freia', ?, ?, ?)`,
    )
    .run(orderId, oficina, cliente, agora, agora);

  // O pedido de aprovação recusa orçamento zerado — a peça é o que o compõe.
  getConnection()
    .prepare('UPDATE core_service_orders SET parts_cents = 8000, total_cents = 8000 WHERE id = ?')
    .run(orderId);

  getConnection()
    .prepare(
      `INSERT INTO core_service_order_parts
         (id, order_id, company_id, product_id, description, quantity, returned_quantity,
          unit_price_cents, total_cents, created_at)
       VALUES (?, ?, ?, ?, 'Pastilha de freio', 1, 0, 8000, 8000, ?)`,
    )
    .run(partId, orderId, oficina, peca, agora);

  withTransaction(() =>
    prometerPeca({
      companyId: oficina,
      orderId,
      partId,
      productId: peca,
      quantity: 1,
      orderNumber: 1,
      userId: mecanico,
    }),
  );

  return { orderId, partId };
}

const estado = (o: { orderId: string; partId: string }) =>
  estadoDaPeca(oficina, o.orderId, o.partId, peca);

/**
 * Soltar, reprometer e consumir escrevem FATO — e o razão exige que o evento
 * da central saia na mesma transação. Fora dela, um rollback deixaria a
 * central com um fato que não aconteceu, e o próprio serviço recusa.
 */
const soltar = (orderId: string) =>
  withTransaction(() =>
    soltarPromessasDaOs({ companyId: oficina, orderId, orderNumber: 1, userId: mecanico }),
  );
const reprometer = (orderId: string) =>
  withTransaction(() =>
    reprometerPromessasDaOs({ companyId: oficina, orderId, orderNumber: 1, userId: mecanico }),
  );
const consumir = (orderId: string) =>
  withTransaction(() =>
    consumirPromessasDaOs({ companyId: oficina, orderId, orderNumber: 1, userId: mecanico }),
  );

// ============================================================================

describe('a promessa volta quando a oficina reorça', () => {
  it('recusar solta a peça — o comportamento que já existia', () => {
    const os = osComPecaPrometida();
    expect([estado(os), getAvailable(oficina, peca)]).toEqual(['prometida', 0]);

    soltar(os.orderId);

    expect([estado(os), getAvailable(oficina, peca)]).toEqual(['solta', 1]);
  });

  it('reorçar promete DE NOVO, e o disponível cai outra vez', () => {
    const os = osComPecaPrometida();
    soltar(os.orderId);

    const repromedidas = reprometer(os.orderId);

    expect(repromedidas).toBe(1);
    expect([estado(os), getAvailable(oficina, peca)]).toEqual(['prometida', 0]);
  });

  it('e o balcão não vende mais a peça no intervalo', () => {
    const os = osComPecaPrometida();
    soltar(os.orderId);
    reprometer(os.orderId);

    // O disponível é o que a venda de balcão consulta antes de baixar.
    expect(getAvailable(oficina, peca)).toBe(0);
    // E o físico continua lá: a peça está na prateleira, com dono.
    expect(getBalance(oficina, peca)).toBe(1);
  });

  it('a aprovação depois do reorçamento CONSOME a promessa, sem estourar', () => {
    /*
      Era aqui que o cliente ficava preso: sem promessa, o consumo caía na
      baixa direta, o CHECK do saldo estourava, e o 409 desfazia o
      `approved_at` junto. O botão "Aprovar" ficava quebrado para sempre
      naquela OS, com uma mensagem sobre estoque para quem não tem ação sobre
      estoque.
    */
    const os = osComPecaPrometida();
    soltar(os.orderId);
    reprometer(os.orderId);

    const consumidas = consumir(os.orderId);

    expect(consumidas).toBe(1);
    expect([estado(os), getBalance(oficina, peca), getAvailable(oficina, peca)]).toEqual([
      'consumida',
      0,
      0,
    ]);
  });

  it('recusar de novo depois de reorçar solta de novo — o ciclo anda nos dois sentidos', () => {
    const os = osComPecaPrometida();
    for (let volta = 0; volta < 3; volta += 1) {
      soltar(os.orderId);
      expect([volta, estado(os), getAvailable(oficina, peca)]).toEqual([volta, 'solta', 1]);

      reprometer(os.orderId);
      expect([volta, estado(os), getAvailable(oficina, peca)]).toEqual([volta, 'prometida', 0]);
    }
  });
});

// ============================================================================

describe('quem chama a repromessa é o PEDIDO DE APROVAÇÃO', () => {
  /**
   * O teste acima prova que a peça sabe voltar. Este prova que ALGUÉM a manda
   * voltar — e que esse alguém é o gesto real da oficina: reorçar.
   *
   * Sem esta ligação, `reprometerPromessasDaOs` seria mais uma função escrita,
   * testada e sem chamador — que é exatamente o padrão que este projeto já
   * encontrou quatro vezes (a contingência, o `recoverStaleItems`, o
   * `findCompanyByAsaasWebhookToken`, a conciliação de pedido de compra).
   */
  it('pedir aprovação de novo repromete a peça solta', () => {
    const os = osComPecaPrometida();
    soltar(os.orderId);
    expect([estado(os), getAvailable(oficina, peca)]).toEqual(['solta', 1]);

    pedirAprovacaoOrcamento({
      companyId: oficina,
      workshopId: null,
      orderId: os.orderId,
      userId: mecanico,
      userName: 'Mecânico',
      isManager: true,
    });

    expect([estado(os), getAvailable(oficina, peca)]).toEqual(['prometida', 0]);
  });

  it('e a linha do tempo da OS registra que a peça voltou para a gaveta', () => {
    const os = osComPecaPrometida();
    soltar(os.orderId);

    pedirAprovacaoOrcamento({
      companyId: oficina,
      workshopId: null,
      orderId: os.orderId,
      userId: mecanico,
      userName: 'Mecânico',
      isManager: true,
    });

    const comentarios = getConnection()
      .prepare('SELECT body FROM core_service_order_comments WHERE order_id = ?')
      .all(os.orderId) as { body: string }[];

    expect(comentarios.some((c) => /voltou a ficar reservada/i.test(c.body))).toBe(true);
  });

  it('o PRIMEIRO pedido de aprovação não repromete nada — não há peça solta', () => {
    const os = osComPecaPrometida();

    pedirAprovacaoOrcamento({
      companyId: oficina,
      workshopId: null,
      orderId: os.orderId,
      userId: mecanico,
      userName: 'Mecânico',
      isManager: true,
    });

    // Continua prometida UMA vez: a peça não pode ser reservada em dobro.
    expect([estado(os), getAvailable(oficina, peca), getBalance(oficina, peca)]).toEqual([
      'prometida',
      0,
      1,
    ]);
  });
});

// ============================================================================

describe('a recusa aparece para a OFICINA, e não para o cliente', () => {
  it('se a peça foi vendida no intervalo, reorçar é que falha', () => {
    /*
      O ponto do conserto não é só "a reserva volta": é ONDE a falta de estoque
      aparece. Reorçando, ela aparece para quem tem ação — a oficina pode
      comprar, trocar a peça ou tirar a linha. Na aprovação, aparecia para o
      cliente, que não pode fazer nada e ainda perdia o clique.
    */
    const os = osComPecaPrometida();
    soltar(os.orderId);

    // O balcão vendeu a única que havia.
    applyMovement({
      companyId: oficina,
      productId: peca,
      movementType: 'out',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'venda-do-balcao',
      reason: 'Vendida no balcão',
    });
    expect(getBalance(oficina, peca)).toBe(0);

    expect(() => reprometer(os.orderId)).toThrow(/estoque/i);
  });
});

// ============================================================================

describe('a reconciliação enxerga a promessa do ciclo novo', () => {
  it('a peça reprometida aparece como promessa ABERTA', () => {
    /*
      A conciliação de estoque cruza `core_stock.reserved` com as origens
      legítimas de reserva. Se a promessa do ciclo novo não casasse com o SQL
      dela, o sistema passaria a acusar reserva sem origem — um alarme falso
      todo dia, que ensina a ignorar o alarme.
    */
    const os = osComPecaPrometida();
    soltar(os.orderId);
    reprometer(os.orderId);

    const abertas = getConnection()
      .prepare(SQL_PROMESSAS_ABERTAS)
      .all(oficina) as { product_id: string; quantidade: number }[];

    expect(abertas).toEqual([{ product_id: peca, quantidade: 1 }]);
  });

  it('e some quando a promessa é consumida', () => {
    const os = osComPecaPrometida();
    soltar(os.orderId);
    reprometer(os.orderId);
    consumir(os.orderId);

    expect(getConnection().prepare(SQL_PROMESSAS_ABERTAS).all(oficina)).toEqual([]);
  });
});
