/**
 * ============================================================================
 * AUDITORIA FASE 10 — A MOTO SERIALIZADA DA PJ MOTORS, PELO FLUXO INTEIRO
 * ============================================================================
 *
 * Tudo aqui passa pela API (supertest + createApp + login real), porque é o
 * fluxo que o operador percorre — os serviços já têm cobertura própria
 * (estoque-serializado, devolucao-serializada, equipamento-no-estoque,
 * plaquinha-nao-congela), mas NENHUM teste existente fazia a venda de uma
 * unidade serializada pela ROTA `POST /core/sales` com `unitIds` (grep em
 * tests/: os arquivos que usam a rota não usam unitIds, e vice-versa).
 *
 * O que este arquivo prova, na ordem do fluxo:
 *
 *  1. a moto entra pela API: saldo + `serialized: true` cria a unidade
 *     (regularização), o chassi entra pelo PATCH, a busca bipada acha;
 *  2. a plaquinha da Oficina (OUTRA empresa — o banco real diz isso) aparece
 *     vinculável, o vínculo escreve dos dois lados e ela some da lista;
 *  3. reserva de UNIDADE específica não existe — afirmado como regra real:
 *     a reserva do sistema é de SALDO (e-commerce), e a unidade só é
 *     escolhida na captura (`pickUnitsFifo` em `consumeReservation`);
 *  4. O CASO CENTRAL: a venda no PDV para cliente com CPF deixa a unidade
 *     `sold` com dono/data/venda carimbados NA PLAQUINHA, o estoque baixa em
 *     centavos exatos, a plaquinha some das vinculáveis — e VENDER DE NOVO a
 *     mesma unidade é RECUSADO (409 CORE_UNIT_NOT_AVAILABLE), sem segunda
 *     venda no banco e sem trocar o dono;
 *  5. a devolução pela rota desfaz o carimbo, a unidade volta, vende de novo
 *     para OUTRO dono — e o histórico da plaquinha conta a vida inteira
 *     (vínculo → venda → devolução → venda);
 *  6. o E2 antigo: saída manual sem venda NÃO deixa a unidade `sold` — ela
 *     sai `baixada` e a plaquinha volta ao pool (a rodada que pendurou
 *     `baixarPelaUnidade` no `applyMovement` consertou; aqui está a prova
 *     PELA ROTA `POST /stock/movements` e pela `POST /units/:id/write-off`);
 *  7. unidade da PJ Motors não vaza para a Oficina nem vice-versa — lista,
 *     busca bipada e unitId dentro da venda; máquina de CLIENTE da Oficina
 *     nunca é vinculável na PJ, nem pelo id;
 *  8. o QR público da plaquinha continua abrindo DEPOIS da venda e não vaza
 *     dono, CPF, id da venda nem preço para quem só tem o link.
 *
 * COMO CADA GUARDA FALHA (conferido lendo o código que cada caso cerca):
 *  - devolva `markUnitsOut` a `movementType === 'out' ? 'sold' : 'baixada'`
 *    e o caso 6 fica vermelho (a unidade da saída manual volta a sair `sold`);
 *  - tire `assertUnitsSellable` do ramo de saída e o caso 4 (revenda) passa a
 *    vender a mesma moto duas vezes;
 *  - tire `venderPelaUnidade` e o carimbo do caso 4 some;
 *  - tire `devolverPelaUnidade` do ramo de entrada e o caso 5 deixa a
 *    plaquinha SOLD com a moto no pátio;
 *  - filtre `plaquinhasVinculaveis` sem `sale_status`/`NOT EXISTS` e a
 *    plaquinha vendida continua na lista do caso 4;
 *  - projete `owner`/`sale_id` em `EquipmentPublicView` e o caso 8 acusa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  ensureOfficialTagCompanies,
  ensureOfficialWorkshops,
} from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Auditoria@Fase10Moto';
const PRECO_MOTO = 1_890_000; // R$ 18.900,00 — a conta fecha em centavos exatos.

let pjMotors: string;
let oficinaCo: string;
let mobilidade: string;
let gerentePj: { Authorization: string };
let gerenteOf: { Authorization: string };

interface Unidade {
  id: string;
  status: string;
  chassis: string | null;
  equipment_id: string | null;
  sale_item_id: string | null;
  exit_reference_type: string | null;
  exit_reference_id: string | null;
  entry_reference_type: string | null;
}

async function ator(login: string, companyId: string, profile: string) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function unidadeDb(companyId: string, unitId: string): Unidade {
  return getConnection()
    .prepare('SELECT * FROM core_product_units WHERE id = ? AND company_id = ?')
    .get(unitId, companyId) as unknown as Unidade;
}

function plaquinhaDb(equipmentId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_equipment WHERE id = ?')
    .get(equipmentId) as Record<string, unknown>;
}

function eventosDaPlaquinha(equipmentId: string): string[] {
  return (
    getConnection()
      .prepare(
        'SELECT event_type FROM core_equipment_events WHERE equipment_id = ? ORDER BY created_at, rowid',
      )
      .all(equipmentId) as unknown as { event_type: string }[]
  ).map((e) => e.event_type);
}

function saldoDb(companyId: string, productId: string): number {
  const linha = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return linha?.quantity ?? 0;
}

function vendasNoBanco(companyId: string): number {
  const linha = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
    .get(companyId) as { n: number };
  return linha.n;
}

async function candidatas(auth: { Authorization: string }): Promise<string[]> {
  const res = await request(app).get('/api/v1/core/units/equipment-candidates').set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as { id: string }[]).map((p) => p.id);
}

/**
 * A moto entra COMO O OPERADOR FAZ na tela: produto, saldo, controle por
 * unidade (a regularização cria a unidade — é o caminho de rota que existe;
 * a entrada de nota faz o mesmo via NfeImportService), chassi pelo PATCH.
 */
async function motoNoEstoque(nome: string, chassi: string) {
  const produto = await request(app)
    .post('/api/v1/core/products')
    .set(gerentePj)
    .send({ name: nome, priceCents: PRECO_MOTO });
  expect(produto.status, JSON.stringify(produto.body)).toBe(201);
  const produtoId = String(produto.body.id);

  const entrada = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(gerentePj)
    .send({
      productId: produtoId,
      movementType: 'in',
      quantity: 1,
      referenceType: 'entrada',
      referenceId: `nf-${nome}`,
    });
  expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);

  const serializa = await request(app)
    .put(`/api/v1/core/products/${produtoId}`)
    .set(gerentePj)
    .send({ serialized: true });
  expect(serializa.status, JSON.stringify(serializa.body)).toBe(200);

  const lista = await request(app).get(`/api/v1/core/units/${produtoId}`).set(gerentePj);
  expect(lista.status).toBe(200);
  expect(lista.body.items).toHaveLength(1);
  const unitId = String(lista.body.items[0].id);

  const identifica = await request(app)
    .patch(`/api/v1/core/units/${unitId}`)
    .set(gerentePj)
    .send({ chassis: chassi });
  expect(identifica.status, JSON.stringify(identifica.body)).toBe(200);

  return { produtoId, unitId };
}

/** A plaquinha nasce na OFICINA — outra empresa — como moto do pátio. */
async function plaquinhaDoPatio(chassi?: string) {
  const res = await request(app)
    .post('/api/v1/core/equipment')
    .set(gerenteOf)
    .send({
      workshopId: mobilidade,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'PJ Motors',
      model: 'Sport 3000',
      chassis: chassi,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const token = getConnection()
    .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
    .get(res.body.id) as { public_token: string };
  return { equipmentId: String(res.body.id), publicToken: token.public_token };
}

async function vincular(unitId: string, equipmentId: string) {
  const res = await request(app)
    .post(`/api/v1/core/units/${unitId}/equipment`)
    .set(gerentePj)
    .send({ equipmentId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.plaquinha as { publicId: number };
}

async function clienteComCpf(nome: string, cpf: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/customers')
    .set(gerentePj)
    .send({ name: nome, document: cpf });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function corpoDaVenda(produtoId: string, unitId: string, customerId: string, chave: string) {
  return {
    idempotencyKey: chave,
    customerId,
    items: [{ productId: produtoId, quantity: 1, unitIds: [unitId] }],
    payments: [{ method: 'dinheiro', amountCents: PRECO_MOTO }],
  };
}

/** Uma moto completa, pronta para o PDV: unidade + chassi + plaquinha vinculada. */
async function motoCompleta(nome: string, chassi: string) {
  const { produtoId, unitId } = await motoNoEstoque(nome, chassi);
  const { equipmentId, publicToken } = await plaquinhaDoPatio(chassi);
  await vincular(unitId, equipmentId);
  return { produtoId, unitId, equipmentId, publicToken };
}

beforeEach(async () => {
  resetDbForTests();
  pjMotors = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
    kind: 'store',
  });
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  // O que o banco real diz: PJ Motors e Oficina são empresas DISTINTAS que
  // usam plaquinha, e a bancada de mobilidade vive na Oficina.
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  mobilidade = (
    getConnection()
      .prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'")
      .get() as { id: string }
  ).id;

  gerentePj = await ator('GERENTE.PJ.F10', pjMotors, 'gerente_loja');
  gerenteOf = await ator('GERENTE.OF.F10', oficinaCo, 'gerente_oficina');
});

/* ========================================================================== */
/* 1. A entrada                                                               */
/* ========================================================================== */

describe('a moto entra pela API e vira unidade com chassi', () => {
  it('saldo + serialized cria a unidade, o chassi entra pelo PATCH e a busca bipada acha', async () => {
    const { produtoId, unitId } = await motoNoEstoque('Moto Elétrica Sport', 'CH-F10-0001');

    // A unidade nasceu da regularização, em estoque e SEM identidade — o
    // chassi só existe depois que alguém foi ao pátio ler o número.
    const u = unidadeDb(pjMotors, unitId);
    expect(u.status).toBe('in_stock');
    expect(u.entry_reference_type).toBe('regularizacao');
    expect(u.chassis).toBe('CH-F10-0001');

    // O saldo e a contagem de unidades dizem o MESMO número.
    const estoque = await request(app).get('/api/v1/core/stock').set(gerentePj);
    expect(estoque.status).toBe(200);
    const linha = (estoque.body.items as { product_id: string; quantity: number }[]).find(
      (i) => i.product_id === produtoId,
    );
    expect(linha?.quantity).toBe(1);

    // Bipar o chassi no balcão acha exatamente esta peça.
    const busca = await request(app).get('/api/v1/core/units?q=CH-F10-0001').set(gerentePj);
    expect(busca.status).toBe(200);
    expect((busca.body.items as { id: string }[]).map((i) => i.id)).toEqual([unitId]);
  });
});

/* ========================================================================== */
/* 2. O vínculo                                                               */
/* ========================================================================== */

describe('a plaquinha da Oficina aparece vinculável e o vínculo escreve dos dois lados', () => {
  it('antes do vínculo ela está na lista; depois, some — e a unidade a carrega', async () => {
    const { produtoId, unitId } = await motoNoEstoque('Moto Elétrica City', 'CH-F10-0002');
    const { equipmentId } = await plaquinhaDoPatio('CH-F10-0002');

    // A travessia de empresa é DE PROPÓSITO: a plaquinha vive na Oficina e a
    // lista da PJ Motors a mostra.
    expect(await candidatas(gerentePj)).toContain(equipmentId);

    const plaquinha = await vincular(unitId, equipmentId);
    expect(plaquinha.publicId).toBeGreaterThan(0);

    // A unidade responde com a plaquinha junto — é na lista que o operador decide.
    const lista = await request(app).get(`/api/v1/core/units/${produtoId}`).set(gerentePj);
    expect(lista.body.items[0].equipment_id).toBe(equipmentId);
    expect(lista.body.items[0].plaquinha.publicId).toBe(plaquinha.publicId);

    // E uma moto é UMA linha de estoque: a plaquinha adotada sai da lista.
    expect(await candidatas(gerentePj)).not.toContain(equipmentId);
  });

  /**
   * "RESERVA (SE EXISTIR)" — não existe, e esta é a regra real, afirmada.
   *
   * Não há rota de reserva de unidade específica (`core_product_units` só
   * conhece in_stock/sold/baixada). A reserva do sistema é de SALDO
   * (`core_stock.reserved`, e-commerce): a peça só é ESCOLHIDA na captura do
   * pagamento (`pickUnitsFifo` dentro de `consumeReservation`). Este caso
   * congela a afirmação: se um dia a rota nascer, ele fica vermelho e obriga
   * a fase a ganhar os casos de reserva de verdade.
   */
  it('reserva de unidade específica não existe: a rota responde 404 e nada é reservado', async () => {
    const { produtoId, unitId } = await motoNoEstoque('Moto Elétrica Trail', 'CH-F10-0003');

    const res = await request(app)
      .post(`/api/v1/core/units/${unitId}/reserve`)
      .set(gerentePj)
      .send({});
    expect(res.status).toBe(404);

    expect(unidadeDb(pjMotors, unitId).status).toBe('in_stock');
    const stock = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(pjMotors, produtoId) as { reserved: number };
    expect(stock.reserved).toBe(0);
  });
});

/* ========================================================================== */
/* 3. O CASO CENTRAL — a venda, o carimbo, e a revenda recusada               */
/* ========================================================================== */

describe('a venda do PDV carimba a plaquinha e a unidade vendida não continua disponível', () => {
  it('sold com dono/data/venda, estoque baixa em centavos exatos, plaquinha some — e vender DE NOVO é recusado', async () => {
    const moto = await motoCompleta('Moto Elétrica GT', 'CH-F10-0100');
    const comprador = await clienteComCpf('Rafaela Compradora', '52998224725');

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .send(corpoDaVenda(moto.produtoId, moto.unitId, comprador, 'f10-venda-1'));
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const saleId = String(venda.body.id);

    // A MATEMÁTICA EXATA: uma moto de 1.890.000 centavos, paga em dinheiro,
    // total da venda igual ao pago, sem um centavo de folga.
    expect(venda.body.total_cents).toBe(PRECO_MOTO);
    const itemDaVenda = getConnection()
      .prepare('SELECT id, total_cents, quantity FROM core_sale_items WHERE sale_id = ?')
      .get(saleId) as { id: string; total_cents: number; quantity: number };
    expect(itemDaVenda.total_cents).toBe(PRECO_MOTO);
    expect(itemDaVenda.quantity).toBe(1);

    // A unidade ficou sold, carimbada com a venda por onde saiu. A devolução
    // continua achando a peça pela REFERÊNCIA DE SAÍDA (`returnableItems`:
    // "as peças são da VENDA e do produto"). O que mudou, DE PROPÓSITO, é
    // `sale_item_id`: era nulo porque nenhum caminho o gravava, e por isso
    // nenhum documento sabia qual chassi foi em qual linha. A venda passou a
    // carimbar a linha (GAP-PRD-026) — é o que leva o chassi à nota e ao cupom.
    const u = unidadeDb(pjMotors, moto.unitId);
    expect(u.status).toBe('sold');
    expect(u.exit_reference_type).toBe('sale');
    expect(u.exit_reference_id).toBe(saleId);
    expect(u.sale_item_id).toBe(itemDaVenda.id);

    // O estoque baixou junto — saldo e contagem de unidades, os dois.
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(0);
    const emEstoque = await request(app)
      .get(`/api/v1/core/units/${moto.produtoId}?status=in_stock`)
      .set(gerentePj);
    expect(emEstoque.body.items).toHaveLength(0);

    // A VENDA CARIMBOU A PLAQUINHA — na empresa da OFICINA: dono, data e venda.
    const p = plaquinhaDb(moto.equipmentId);
    expect(p.sale_status).toBe('SOLD');
    expect(p.sold_at).toBeTruthy();
    expect(p.sale_id).toBe(saleId);
    expect(p.owner_customer_id).not.toBeNull();
    // O dono é o ESPELHO do comprador na Oficina, casado pelo CPF — não o
    // cadastro da loja: a oficina é outra empresa e o portal lê o dela.
    const dono = getConnection()
      .prepare('SELECT company_id, document FROM core_customers WHERE id = ?')
      .get(String(p.owner_customer_id)) as { company_id: string; document: string };
    expect(dono.company_id).toBe(oficinaCo);
    expect(dono.document).toBe('52998224725');

    // A ficha da Oficina conta a venda no histórico.
    const ficha = await request(app)
      .get(`/api/v1/core/equipment/${moto.equipmentId}`)
      .set(gerenteOf);
    expect(ficha.status).toBe(200);
    expect(ficha.body.equipment.sale_status).toBe('SOLD');
    expect(
      (ficha.body.events as { event_type: string }[]).map((e) => e.event_type),
    ).toContain('sold');

    // A plaquinha vendida SOME das vinculáveis.
    expect(await candidatas(gerentePj)).not.toContain(moto.equipmentId);

    // ------------------------------------------------------------------
    // O CASO CENTRAL DA FASE: vender DE NOVO a mesma unidade é RECUSADO.
    // ------------------------------------------------------------------
    const outro = await clienteComCpf('Otávio Segundo', '39053344705');
    const revenda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .send(corpoDaVenda(moto.produtoId, moto.unitId, outro, 'f10-venda-2'));
    expect(revenda.status, JSON.stringify(revenda.body)).toBe(409);
    expect(revenda.body.error.code).toBe('CORE_UNIT_NOT_AVAILABLE');
    expect(revenda.body.error.message).toMatch(/já foi vendida/i);

    // E nada mudou: uma venda só no banco, saldo em zero, o dono é o PRIMEIRO.
    expect(vendasNoBanco(pjMotors)).toBe(1);
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(0);
    const depois = plaquinhaDb(moto.equipmentId);
    expect(depois.owner_customer_id).toBe(p.owner_customer_id);
    expect(depois.sale_id).toBe(saleId);
  });

  it('o reenvio da MESMA venda (mesma chave) não vende a moto duas vezes', async () => {
    const moto = await motoCompleta('Moto Elétrica Max', 'CH-F10-0101');
    const comprador = await clienteComCpf('Rafaela Compradora', '52998224725');
    const corpo = corpoDaVenda(moto.produtoId, moto.unitId, comprador, 'f10-repetida');

    const primeira = await request(app).post('/api/v1/core/sales').set(gerentePj).send(corpo);
    expect(primeira.status).toBe(201);

    // O PDV caiu e reenviou: mesma chave, mesma venda, nenhum efeito novo.
    const reenvio = await request(app).post('/api/v1/core/sales').set(gerentePj).send(corpo);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);

    expect(vendasNoBanco(pjMotors)).toBe(1);
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(0);
    expect(unidadeDb(pjMotors, moto.unitId).status).toBe('sold');
  });
});

/* ========================================================================== */
/* 4. A devolução, e a vida inteira contada                                   */
/* ========================================================================== */

describe('a devolução desfaz o carimbo e a plaquinha conta a vida inteira', () => {
  it('a moto volta, o dono deixa de ser dono, ela vende de novo — e o histórico narra tudo', async () => {
    const moto = await motoCompleta('Moto Elétrica Tour', 'CH-F10-0200');
    const primeiro = await clienteComCpf('Rafaela Compradora', '52998224725');

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .send(corpoDaVenda(moto.produtoId, moto.unitId, primeiro, 'f10-dev-1'));
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const saleId = String(venda.body.id);

    // A tela de devolução OFERECE a peça daquela venda, com o chassi.
    const devolviveis = await request(app)
      .get(`/api/v1/core/sales/${saleId}/returnable`)
      .set(gerentePj);
    expect(devolviveis.status).toBe(200);
    const linha = (devolviveis.body.items as Record<string, unknown>[]).find(
      (i) => i.product_id === moto.produtoId,
    )!;
    expect(linha.serialized).toBe(1);
    expect((linha.units as { id: string; chassis: string }[]).map((x) => x.chassis)).toEqual([
      'CH-F10-0200',
    ]);

    const devolucao = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(gerentePj)
      .send({
        saleId,
        reason: 'Arrependimento no prazo',
        items: [{ saleItemId: linha.sale_item_id, quantity: 1, unitIds: [moto.unitId] }],
      });
    expect(devolucao.status, JSON.stringify(devolucao.body)).toBe(201);
    // O dinheiro devolvido é EXATAMENTE o da moto.
    expect(devolucao.body.total_cents).toBe(PRECO_MOTO);

    // A unidade voltou LIMPA (sem o carimbo da venda desfeita), e ainda com a
    // MESMA plaquinha — o QR colado na moto continua valendo.
    const u = unidadeDb(pjMotors, moto.unitId);
    expect(u.status).toBe('in_stock');
    expect(u.sale_item_id).toBeNull();
    expect(u.exit_reference_id).toBeNull();
    expect(u.equipment_id).toBe(moto.equipmentId);
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(1);

    // O dono deixou de ser dono — o carimbo inteiro se desfez.
    const p = plaquinhaDb(moto.equipmentId);
    expect(p.sale_status).toBe('NOT_SOLD');
    expect(p.owner_customer_id).toBeNull();
    expect(p.sold_at).toBeNull();
    expect(p.sale_id).toBeNull();

    // E a moto vende DE NOVO, para OUTRO dono.
    const segundo = await clienteComCpf('Otávio Segundo', '39053344705');
    const revenda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .send(corpoDaVenda(moto.produtoId, moto.unitId, segundo, 'f10-dev-2'));
    expect(revenda.status, JSON.stringify(revenda.body)).toBe(201);

    const p2 = plaquinhaDb(moto.equipmentId);
    expect(p2.sale_status).toBe('SOLD');
    expect(p2.sale_id).toBe(String(revenda.body.id));
    expect(p2.owner_customer_id).not.toBe(p.owner_customer_id);
    const novoDono = getConnection()
      .prepare('SELECT document FROM core_customers WHERE id = ?')
      .get(String(p2.owner_customer_id)) as { document: string };
    expect(novoDono.document).toBe('39053344705');

    // A VIDA INTEIRA, na ordem: vínculo → venda → devolução → venda. Apagar
    // qualquer passagem seria mentir sobre a moto.
    const marcos = eventosDaPlaquinha(moto.equipmentId).filter((e) =>
      ['stock_linked', 'sold', 'sale_reverted'].includes(e),
    );
    expect(marcos).toEqual(['stock_linked', 'sold', 'sale_reverted', 'sold']);
  });
});

/* ========================================================================== */
/* 5. O E2 antigo — saída sem venda passa pela baixa da plaquinha             */
/* ========================================================================== */

describe('saída sem venda NÃO deixa a unidade sold — a plaquinha é baixada e volta ao pool', () => {
  it('saída manual pela rota: unidade baixada, plaquinha solta e vinculável de novo', async () => {
    const moto = await motoCompleta('Moto Elétrica Work', 'CH-F10-0300');

    const saida = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerentePj)
      .send({
        productId: moto.produtoId,
        movementType: 'out',
        quantity: 1,
        referenceType: 'manual',
        referenceId: 'f10-saida-manual',
        reason: 'Sumiu do pátio na contagem',
        unitIds: [moto.unitId],
      });
    expect(saida.status, JSON.stringify(saida.body)).toBe(201);

    // O E2 ANTIGO: a saída manual deixava a unidade `sold` — e aí nem a venda
    // rodava (não é venda) nem a baixa (não era `baixada`): plaquinha
    // CONGELADA. A prova de que a rodada consertou é o status certo AQUI.
    const u = unidadeDb(pjMotors, moto.unitId);
    expect(u.status).not.toBe('sold');
    expect(u.status).toBe('baixada');
    expect(u.equipment_id).toBeNull();
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(0);

    // A plaquinha foi SOLTA, sem dono inventado, e voltou às vinculáveis.
    const p = plaquinhaDb(moto.equipmentId);
    expect(p.sale_status).toBe('NOT_SOLD');
    expect(p.owner_customer_id).toBeNull();
    expect(p.origin_company_id).toBeNull();
    expect(eventosDaPlaquinha(moto.equipmentId)).toContain('stock_written_off');
    expect(await candidatas(gerentePj)).toContain(moto.equipmentId);
  });

  it('a baixa dedicada (/units/:id/write-off) exige motivo e faz o mesmo caminho', async () => {
    const moto = await motoCompleta('Moto Elétrica Delivery', 'CH-F10-0301');

    // Sem motivo, nada acontece — o histórico é o que explica a prateleira.
    const semMotivo = await request(app)
      .post(`/api/v1/core/units/${moto.unitId}/write-off`)
      .set(gerentePj)
      .send({});
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_REASON_REQUIRED');
    expect(unidadeDb(pjMotors, moto.unitId).status).toBe('in_stock');
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(1);

    const baixa = await request(app)
      .post(`/api/v1/core/units/${moto.unitId}/write-off`)
      .set(gerentePj)
      .send({ reason: 'Quadro trincado — devolvida ao fornecedor' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);

    const u = unidadeDb(pjMotors, moto.unitId);
    expect(u.status).toBe('baixada');
    expect(u.equipment_id).toBeNull();
    expect(saldoDb(pjMotors, moto.produtoId)).toBe(0);
    expect(plaquinhaDb(moto.equipmentId).sale_status).toBe('NOT_SOLD');
    expect(await candidatas(gerentePj)).toContain(moto.equipmentId);
  });
});

/* ========================================================================== */
/* 6. PJ Motors e Oficina não se misturam                                     */
/* ========================================================================== */

describe('a unidade não vaza entre PJ Motors e Oficina', () => {
  it('nem na lista, nem na busca bipada, nem dentro da venda', async () => {
    const daPj = await motoNoEstoque('Moto Elétrica Urbana', 'CH-F10-PJ-1');

    // Uma peça serializada DA OFICINA (peça de bancada com número de série).
    const produtoOf = await request(app)
      .post('/api/v1/core/products')
      .set(gerenteOf)
      .send({ name: 'Controladora 72V', priceCents: 120_000 });
    expect(produtoOf.status).toBe(201);
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerenteOf)
      .send({
        productId: produtoOf.body.id,
        movementType: 'in',
        quantity: 1,
        referenceType: 'entrada',
        referenceId: 'nf-of-1',
      })
      .expect(201);
    await request(app)
      .put(`/api/v1/core/products/${produtoOf.body.id}`)
      .set(gerenteOf)
      .send({ serialized: true })
      .expect(200);
    const unidadesOf = await request(app)
      .get(`/api/v1/core/units/${produtoOf.body.id}`)
      .set(gerenteOf);
    const unitOf = String(unidadesOf.body.items[0].id);
    await request(app)
      .patch(`/api/v1/core/units/${unitOf}`)
      .set(gerenteOf)
      .send({ serialNumber: 'SER-OF-777' })
      .expect(200);

    // A Oficina não lê a unidade da PJ pelo produto nem pelo chassi bipado.
    const listaCruzada = await request(app)
      .get(`/api/v1/core/units/${daPj.produtoId}`)
      .set(gerenteOf);
    expect(listaCruzada.status).toBe(200);
    expect(listaCruzada.body.items).toHaveLength(0);
    const buscaCruzada = await request(app).get('/api/v1/core/units?q=CH-F10-PJ-1').set(gerenteOf);
    expect(buscaCruzada.body.items).toHaveLength(0);

    // E a PJ não lê a peça da Oficina.
    const buscaDaPj = await request(app).get('/api/v1/core/units?q=SER-OF-777').set(gerentePj);
    expect(buscaDaPj.body.items).toHaveLength(0);

    // DENTRO DA VENDA: unitId alheio responde IGUAL a id inexistente — sem
    // oráculo de existência entre empresas, e sem mexer em nada.
    const comprador = await clienteComCpf('Rafaela Compradora', '52998224725');
    const vendaCruzada = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .send(corpoDaVenda(daPj.produtoId, unitOf, comprador, 'f10-cruzada'));
    expect(vendaCruzada.status, JSON.stringify(vendaCruzada.body)).toBe(404);
    expect(vendaCruzada.body.error.code).toBe('CORE_UNIT_NOT_FOUND');

    expect(unidadeDb(oficinaCo, unitOf).status).toBe('in_stock');
    expect(saldoDb(pjMotors, daPj.produtoId)).toBe(1);
    expect(vendasNoBanco(pjMotors)).toBe(0);
  });

  it('a máquina de CLIENTE da Oficina nunca é vinculável na PJ — nem pelo id', async () => {
    const dono = await request(app)
      .post('/api/v1/core/customers')
      .set(gerenteOf)
      .send({ name: 'Cliente da Oficina', document: '98765432100' });
    expect(dono.status).toBe(201);

    const doCliente = await request(app)
      .post('/api/v1/core/equipment')
      .set(gerenteOf)
      .send({
        workshopId: mobilidade,
        origin: 'EXTERNAL_CUSTOMER',
        ownerCustomerId: String(dono.body.id),
        brand: 'Honda',
        model: 'Biz do cliente',
        chassis: 'CH-CLIENTE-9',
      });
    expect(doCliente.status, JSON.stringify(doCliente.body)).toBe(201);

    // A lista não a oferece...
    expect(await candidatas(gerentePj)).not.toContain(String(doCliente.body.id));

    // ...e o id direto é recusado dizendo QUAL regra pegou: é do cliente.
    const { unitId } = await motoNoEstoque('Moto Elétrica Street', 'CH-F10-PJ-2');
    const vinculo = await request(app)
      .post(`/api/v1/core/units/${unitId}/equipment`)
      .set(gerentePj)
      .send({ equipmentId: String(doCliente.body.id) });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(409);
    expect(vinculo.body.error.message).toMatch(/cliente/i);
    expect(unidadeDb(pjMotors, unitId).equipment_id).toBeNull();
  });
});

/* ========================================================================== */
/* 7. O QR público depois da venda                                            */
/* ========================================================================== */

describe('o QR público da plaquinha, com a moto já vendida', () => {
  it('a página continua abrindo, mostra a moto — e cala sobre dono, CPF, venda e preço', async () => {
    const moto = await motoCompleta('Moto Elétrica GT', 'CH-F10-0400');
    const comprador = await clienteComCpf('Rafaela Compradora', '52998224725');
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .send(corpoDaVenda(moto.produtoId, moto.unitId, comprador, 'f10-qr-1'));
    expect(venda.status).toBe(201);

    // SEM sessão: é quem tem o link — o QR fica exposto na moto, na rua.
    const publica = await request(app).get(`/api/v1/loja/equipamento/${moto.publicToken}`);
    expect(publica.status, JSON.stringify(publica.body)).toBe(200);

    // Mostra o que deve: o que a máquina É, e quem atende.
    expect(publica.body.brand).toBe('PJ Motors');
    expect(publica.body.model).toBe('Sport 3000');
    expect(publica.body.companyName).toBeTruthy();

    // E NUNCA o que a venda carimbou: a plaquinha agora guarda dono, CPF e
    // venda — nada disso pode sair para quem só tem o link.
    const corpo = JSON.stringify(publica.body);
    expect(corpo).not.toContain('Rafaela');
    expect(corpo).not.toContain('52998224725');
    expect(corpo).not.toContain(String(venda.body.id));
    expect(corpo).not.toContain(moto.unitId);
    const minusculo = corpo.toLowerCase();
    for (const proibido of ['owner', 'sold', 'cents', 'price', 'valor', 'document', 'cpf']) {
      expect(minusculo, `a página pública vazou "${proibido}"`).not.toContain(proibido);
    }
  });
});
