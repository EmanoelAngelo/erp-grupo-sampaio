/**
 * ============================================================================
 * QUEM ABRE, QUEM ANOTA E QUEM MEXE NA OS — a régua de cada porta
 * (GAP-PRD-099, 102, 186, 103, 182)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-099: `POST /workshop/orders` e `POST /equipment` nomeiam o caixa
 *     da oficina e o atendente, e `resolveWorkshop` os recusava porque eles
 *     não são membros de bancada (no banco da loja, só os mecânicos são). O
 *     balcão não abria OS nem cadastrava a máquina do cliente.
 *   - GAP-PRD-102: a tela oferece o comentário a atendente e caixa, e o
 *     servidor os tratava como técnico — 403 em toda OS já assumida.
 *   - GAP-PRD-186: cinco portas de escrita usavam `resolveWorkshop(req,false)`,
 *     que devolve nulo para quem atende duas bancadas — e nulo virava "a
 *     empresa inteira". O mecânico de duas bancadas escrevia na terceira.
 *   - GAP-PRD-103: a devolução de peça não conferia responsável nem bancada, e
 *     mudava o total sem derrubar a aprovação do cliente.
 *   - GAP-PRD-182: o portal decidia orçamento de OS que já tinha saído da
 *     bancada, e a conclusão técnica deixava o pedido de aprovação pendurado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  decidirOrcamento,
  equipamentoDoDono,
} from '../src/services/core/EquipmentPortalService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

const OFICINA = 'oficina-qm';
const OUTRA = 'outra-qm';
const CPF_VALIDO = '529.982.247-25';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

let gerente: Ator;
let mec1: Ator;
let mec2: Ator;
let caixa: Ator;
let atendente: Ator;
let gerenteOutra: Ator;
let bancadaA: string;
let bancadaOutra: string;
let seq = 0;

async function entrar(userId: string, empresa: string, perfil: string): Promise<Ator> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

function bancada(id: string, empresa: string, slug: string, nome: string): string {
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, ?, 'mobility', 1, ?)`,
    )
    .run(id, empresa, slug, nome, new Date().toISOString());
  return id;
}

function vincular(workshopId: string, userId: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), workshopId, userId, new Date().toISOString());
}

beforeEach(async () => {
  resetDbForTests();
  seq = 0;
  gerente = await entrar('ger-qm', OFICINA, 'gerente_oficina');
  mec1 = await entrar('mec1-qm', OFICINA, 'mecanico');
  mec2 = await entrar('mec2-qm', OFICINA, 'mecanico');
  caixa = await entrar('cx-qm', OFICINA, 'operador_caixa_oficina');
  atendente = await entrar('at-qm', OFICINA, 'atendente');
  gerenteOutra = await entrar('ger-outra-qm', OUTRA, 'gerente_oficina');

  bancadaA = bancada('wk-qm-a', OFICINA, 'mob-qm-a', 'Bancada A');
  bancadaOutra = bancada('wk-qm-outra', OUTRA, 'mob-qm-outra', 'Bancada da outra empresa');
  // Como no banco da loja: os mecânicos são da bancada; caixa e atendente, NÃO.
  vincular(bancadaA, mec1.userId);
  vincular(bancadaA, mec2.userId);
});

function linhaDaOs(osId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_service_orders WHERE id = ?')
    .get(osId) as Record<string, unknown>;
}

function contar(sql: string, ...params: unknown[]): number {
  return (getConnection().prepare(sql).get(...(params as never[])) as { n: number }).n;
}

async function clienteDoCadastro(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/customers')
    .set(gerente.auth)
    .send({ name: 'Seu Jorge', document: CPF_VALIDO, phone: '53 98888-0000' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

/** OS aberta pelo gerente e assumida pelo mec1. */
async function osAssumida(customerId?: string): Promise<string> {
  seq += 1;
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente.auth)
    .send({ workshopId: bancadaA, customerId, customerName: customerId ? undefined : `Cliente ${seq}`, complaint: 'Não liga' });
  expect(os.status, JSON.stringify(os.body)).toBe(201);
  const id = String(os.body.id);
  const assumiu = await request(app)
    .post(`/api/v1/core/workshop/orders/${id}/assume`)
    .set(mec1.auth)
    .send({ status: 'em_andamento', comment: 'assumindo' });
  expect(assumiu.status, JSON.stringify(assumiu.body)).toBe(200);
  return id;
}

/** Peça da bancada A, com preço, custo e saldo. */
async function peca(nome: string, qtd: number, precoCents = 5000, custoCents = 3000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: nome, priceCents: precoCents, costCents: custoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  getConnection()
    .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
    .run(bancadaA, p.body.id);
  const entrada = await request(app).post('/api/v1/core/stock/movements').set(gerente.auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id as string}`,
  });
  expect(entrada.status, JSON.stringify(entrada.body)).toBeLessThan(300);
  return String(p.body.id);
}

// ============================================================================

describe('GAP-PRD-099 — o balcão abre OS e cadastra a máquina na bancada da empresa', () => {
  it('o caixa da oficina, sem vínculo de bancada, abre a OS na única bancada da empresa', async () => {
    const res = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(caixa.auth)
      .send({ customerName: 'Dona Célia', complaint: 'Não carrega' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.workshop_id).toBe(bancadaA);
    expect(res.body.status).toBe('em_aberto');
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'workshop.order.create' AND entity_id = ?",
        res.body.id,
      ),
    ).toBe(1);
  });

  it('o atendente abre a OS e cadastra o equipamento do cliente', async () => {
    const customerId = await clienteDoCadastro();
    const eq = await request(app)
      .post('/api/v1/core/equipment')
      .set(atendente.auth)
      .send({ origin: 'EXTERNAL_CUSTOMER', ownerCustomerId: customerId, brand: 'Shineray', model: 'PT2' });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    expect(eq.body.workshop_id).toBe(bancadaA);

    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(atendente.auth)
      .send({ customerId, equipmentId: eq.body.id, complaint: 'Freio fraco' });
    expect(os.status, JSON.stringify(os.body)).toBe(201);
    expect(os.body.workshop_id).toBe(bancadaA);
    expect(os.body.equipment_id).toBe(eq.body.id);
  });

  it('o caixa cadastra equipamento', async () => {
    const customerId = await clienteDoCadastro();
    const eq = await request(app)
      .post('/api/v1/core/equipment')
      .set(caixa.auth)
      .send({ origin: 'EXTERNAL_CUSTOMER', ownerCustomerId: customerId, brand: 'Honda', model: 'Pop' });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
  });

  it('empresa com duas bancadas: o balcão escolhe a bancada, e não alcança a de outra empresa', async () => {
    const bancadaB = bancada('wk-qm-b', OFICINA, 'mob-qm-b', 'Bancada B');

    const semEscolha = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(caixa.auth)
      .send({ customerName: 'Dona Célia', complaint: 'Não carrega' });
    expect(semEscolha.status).toBe(400);
    expect(semEscolha.body.error.code).toBe('CORE_WORKSHOP_REQUIRED');

    const naB = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(atendente.auth)
      .send({ workshopId: bancadaB, customerName: 'Dona Célia', complaint: 'Não carrega' });
    expect(naB.status, JSON.stringify(naB.body)).toBe(201);
    expect(naB.body.workshop_id).toBe(bancadaB);

    const alheia = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(caixa.auth)
      .send({ workshopId: bancadaOutra, customerName: 'Intruso', complaint: 'x' });
    expect(alheia.status).toBe(403);
    expect(alheia.body.error.code).toBe('CORE_WORKSHOP_FORBIDDEN');

    // A lista de bancadas de entrada diz ao balcão onde ele pode abrir.
    const entrada = await request(app).get('/api/v1/core/workshop/entrada').set(caixa.auth);
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(200);
    expect((entrada.body.items as { id: string }[]).map((w) => w.id).sort()).toEqual(
      [bancadaA, bancadaB].sort(),
    );
  });

  it('a filiação continua valendo para o mecânico: ele só abre na bancada dele', async () => {
    const bancadaB = bancada('wk-qm-b', OFICINA, 'mob-qm-b', 'Bancada B');
    const naDele = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mec1.auth)
      .send({ customerName: 'Moto', complaint: 'x' });
    expect(naDele.status, JSON.stringify(naDele.body)).toBe(201);
    expect(naDele.body.workshop_id).toBe(bancadaA);

    const naOutra = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mec1.auth)
      .send({ workshopId: bancadaB, customerName: 'Moto', complaint: 'x' });
    expect(naOutra.status).toBe(403);
    expect(naOutra.body.error.code).toBe('CORE_WORKSHOP_FORBIDDEN');

    const entrada = await request(app).get('/api/v1/core/workshop/entrada').set(mec1.auth);
    expect((entrada.body.items as { id: string }[]).map((w) => w.id)).toEqual([bancadaA]);

    // Mecânico sem vínculo nenhum não vira "balcão": a recusa diz o porquê.
    const solto = await entrar('mec-solto-qm', OFICINA, 'mecanico');
    const semBancada = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(solto.auth)
      .send({ customerName: 'Moto', complaint: 'x' });
    expect(semBancada.status).toBe(403);
    expect(semBancada.body.error.code).toBe('CORE_WORKSHOP_FORBIDDEN');
  });

  it('perfil fora da oficina continua sem abrir OS', async () => {
    const loja = await entrar('ger-loja-qm', OFICINA, 'gerente_loja');
    const res = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(loja.auth)
      .send({ customerName: 'x', complaint: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('GAP-PRD-102 — o balcão anota na linha do tempo de qualquer OS da empresa', () => {
  it('atendente e caixa comentam em OS assumida, com a voz do balcão', async () => {
    const osId = await osAssumida();

    const doAtendente = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/comments`)
      .set(atendente.auth)
      .send({ body: 'Cliente ligou perguntando do prazo.' });
    expect(doAtendente.status, JSON.stringify(doAtendente.body)).toBe(201);

    const doCaixa = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/comments`)
      .set(caixa.auth)
      .send({ body: 'Cliente deixou sinal de R$ 50.' });
    expect(doCaixa.status, JSON.stringify(doCaixa.body)).toBe(201);

    const detalhe = await request(app).get(`/api/v1/core/workshop/orders/${osId}`).set(gerente.auth);
    const comentarios = detalhe.body.comments as { body: string; author_kind: string }[];
    expect(comentarios.find((c) => c.body.startsWith('Cliente ligou'))?.author_kind).toBe('balcao');
    expect(comentarios.find((c) => c.body.startsWith('Cliente deixou'))?.author_kind).toBe('balcao');
  });

  it('o mecânico que não assumiu continua sem falar pela OS alheia', async () => {
    const osId = await osAssumida();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/comments`)
      .set(mec2.auth)
      .send({ body: 'palpite' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_ORDER_NOT_ASSIGNED_TO_YOU');
  });

  it('o gerente fala como gestão, e o balcão não comenta OS de outra empresa', async () => {
    const osId = await osAssumida();
    const g = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/comments`)
      .set(gerente.auth)
      .send({ body: 'Prioridade alta.' });
    expect(g.status).toBe(201);
    const kinds = (
      getConnection()
        .prepare('SELECT author_kind FROM core_service_order_comments WHERE order_id = ? AND body = ?')
        .all(osId, 'Prioridade alta.') as { author_kind: string }[]
    ).map((c) => c.author_kind);
    expect(kinds).toEqual(['gestor']);

    const alheia = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/comments`)
      .set(gerenteOutra.auth)
      .send({ body: 'invasão' });
    expect(alheia.status).toBe(404);
  });
});

describe('GAP-PRD-186 — o mecânico de duas bancadas não escreve na terceira', () => {
  let bancadaB: string;
  let bancadaC: string;
  let duplo: Ator;

  beforeEach(async () => {
    bancadaB = bancada('wk-qm-b', OFICINA, 'mob-qm-b', 'Bancada B');
    bancadaC = bancada('wk-qm-c', OFICINA, 'mob-qm-c', 'Bancada C');
    duplo = await entrar('mec-duplo-qm', OFICINA, 'mecanico');
    vincular(bancadaA, duplo.userId);
    vincular(bancadaB, duplo.userId);
  });

  async function osNaC(): Promise<string> {
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ workshopId: bancadaC, customerName: 'Cliente C', complaint: 'x' });
    expect(os.status, JSON.stringify(os.body)).toBe(201);
    return String(os.body.id);
  }

  it('comentário, mão de obra, peça, pedido de aprovação e conclusão na bancada C: 404', async () => {
    const osId = await osNaC();
    // A OS está "com ele" (vínculo antigo com a C, desfeito depois): nem assim.
    getConnection()
      .prepare("UPDATE core_service_orders SET mechanic_id = ?, status = 'em_andamento' WHERE id = ?")
      .run(duplo.userId, osId);
    getConnection()
      .prepare('UPDATE core_service_orders SET labor_cents = 1000, total_cents = 1000 WHERE id = ?')
      .run(osId);
    const pecaA = await peca('Parafuso', 5);

    const tentativas = [
      request(app).post(`/api/v1/core/workshop/orders/${osId}/comments`).set(duplo.auth).send({ body: 'oi' }),
      request(app).post(`/api/v1/core/workshop/orders/${osId}/labor`).set(duplo.auth).send({ laborCents: 9000 }),
      request(app)
        .post(`/api/v1/core/workshop/orders/${osId}/parts`)
        .set(duplo.auth)
        .send({ productId: pecaA, quantity: 1 }),
      request(app).post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`).set(duplo.auth).send({}),
      request(app)
        .post(`/api/v1/core/workshop/orders/${osId}/complete`)
        .set(duplo.auth)
        .send({ diagnosis: 'feito', hasCost: true, forcarChecklist: true }),
    ];
    for (const t of tentativas) {
      const r = await t;
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(r.body.error.code).toBe('CORE_ORDER_NOT_FOUND');
    }
    const depois = linhaDaOs(osId);
    expect(depois.labor_cents).toBe(1000);
    expect(depois.status).toBe('em_andamento');
    expect(depois.approval_requested_at).toBeNull();
    expect(contar('SELECT COUNT(*) AS n FROM core_service_order_comments WHERE order_id = ?', osId)).toBe(0);
  });

  it('nas bancadas dele, as mesmas portas continuam abertas', async () => {
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ workshopId: bancadaB, customerName: 'Cliente B', complaint: 'x' });
    const osId = String(os.body.id);
    const assumiu = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/assume`)
      .set(duplo.auth)
      .send({ status: 'em_andamento', comment: 'meu' });
    expect(assumiu.status, JSON.stringify(assumiu.body)).toBe(200);
    const labor = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/labor`)
      .set(duplo.auth)
      .send({ laborCents: 9000 });
    expect(labor.status, JSON.stringify(labor.body)).toBe(200);
    const comentario = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/comments`)
      .set(duplo.auth)
      .send({ body: 'andando' });
    expect(comentario.status).toBe(201);
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/complete`)
      .set(duplo.auth)
      .send({ diagnosis: 'feito', hasCost: true, forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);
  });
});

describe('GAP-PRD-103 — a devolução de peça tem dono e derruba a aprovação', () => {
  /** OS do mec1 com 2 peças lançadas e orçamento aceito pelo cliente (telefone). */
  async function osAprovadaComPeca(): Promise<{ osId: string; partId: string; productId: string }> {
    const customerId = await clienteDoCadastro();
    const osId = await osAssumida(customerId);
    const productId = await peca('Controlador', 5, 5000, 3000);
    const lanc = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts`)
      .set(mec1.auth)
      .send({ productId, quantity: 2 });
    expect(lanc.status, JSON.stringify(lanc.body)).toBe(201);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`).set(mec1.auth).send({}).expect(200);
    const aceite = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/decidir-orcamento`)
      .set(atendente.auth)
      .send({ approved: true });
    expect(aceite.status, JSON.stringify(aceite.body)).toBe(200);
    const partId = (
      getConnection().prepare('SELECT id FROM core_service_order_parts WHERE order_id = ?').get(osId) as {
        id: string;
      }
    ).id;
    expect(linhaDaOs(osId).approved_at).toBeTruthy();
    expect(linhaDaOs(osId).total_cents).toBe(10000);
    return { osId, partId, productId };
  }

  it('o mecânico que não assumiu a OS não devolve a peça dela', async () => {
    const { osId, partId } = await osAprovadaComPeca();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(mec2.auth)
      .send({ quantity: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_ORDER_NOT_ASSIGNED_TO_YOU');
    const linha = getConnection()
      .prepare('SELECT returned_quantity FROM core_service_order_parts WHERE id = ?')
      .get(partId) as { returned_quantity: number };
    expect(linha.returned_quantity).toBe(0);
    expect(linhaDaOs(osId).total_cents).toBe(10000);
    expect(linhaDaOs(osId).approved_at).toBeTruthy();
  });

  it('o responsável devolve: o total cai E a aprovação cai junto, com o registro na linha do tempo', async () => {
    const { osId, partId } = await osAprovadaComPeca();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(mec1.auth)
      .send({ quantity: 1, reason: 'sobrou' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const depois = linhaDaOs(osId);
    expect(depois.total_cents).toBe(5000);
    expect(depois.approved_at).toBeNull();
    expect(depois.approval_requested_at).toBeNull();
    const aviso = getConnection()
      .prepare(
        "SELECT body FROM core_service_order_comments WHERE order_id = ? AND body LIKE 'Orçamento alterado%'",
      )
      .all(osId) as { body: string }[];
    expect(aviso).toHaveLength(1);
    expect(aviso[0].body).toContain('R$ 100,00');
    expect(aviso[0].body).toContain('R$ 50,00');
    const auditoria = getConnection()
      .prepare(
        "SELECT detail FROM core_audit_log WHERE action = 'workshop.part_returned' AND entity_id = ?",
      )
      .get(osId) as { detail: string };
    expect(JSON.parse(auditoria.detail)).toMatchObject({ partId, quantity: 1 });
  });

  it('o gerente da oficina devolve peça de OS de outro técnico', async () => {
    const { osId, partId } = await osAprovadaComPeca();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(gerente.auth)
      .send({ quantity: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(linhaDaOs(osId).total_cents).toBe(0);
    expect(linhaDaOs(osId).approved_at).toBeNull();
  });

  it('mecânico de outra bancada não devolve peça (404) e outra empresa também não', async () => {
    const { osId, partId } = await osAprovadaComPeca();
    const bancadaB = bancada('wk-qm-b', OFICINA, 'mob-qm-b', 'Bancada B');
    const deB = await entrar('mec-b-qm', OFICINA, 'mecanico');
    vincular(bancadaB, deB.userId);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(deB.auth)
      .send({ quantity: 1 });
    expect(res.status).toBe(404);
    const alheia = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(gerenteOutra.auth)
      .send({ quantity: 1 });
    expect(alheia.status).toBe(404);
    expect(linhaDaOs(osId).total_cents).toBe(10000);
  });

  it('devolução sem aprovação de pé não inventa aviso', async () => {
    const osId = await osAssumida();
    const productId = await peca('Pastilha', 3, 2000, 1000);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts`)
      .set(mec1.auth)
      .send({ productId, quantity: 2 })
      .expect(201);
    const partId = (
      getConnection().prepare('SELECT id FROM core_service_order_parts WHERE order_id = ?').get(osId) as {
        id: string;
      }
    ).id;
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(mec1.auth)
      .send({ quantity: 1 })
      .expect(200);
    expect(linhaDaOs(osId).total_cents).toBe(2000);
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_service_order_comments WHERE order_id = ? AND body LIKE 'Orçamento alterado%'",
        osId,
      ),
    ).toBe(0);
  });
});

describe('GAP-PRD-182 — orçamento só se decide com a OS na bancada', () => {
  async function osPedidaEConcluida(): Promise<{ osId: string; customerId: string }> {
    const customerId = await clienteDoCadastro();
    const osId = await osAssumida(customerId);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/labor`).set(mec1.auth).send({ laborCents: 8000 }).expect(200);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`).set(mec1.auth).send({}).expect(200);
    expect(linhaDaOs(osId).approval_requested_at).toBeTruthy();
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/complete`)
      .set(mec1.auth)
      .send({ diagnosis: 'feito sem esperar', hasCost: true, forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);
    expect(fim.body.status).toBe('aguardando_pagamento');
    return { osId, customerId };
  }

  it('concluir com pedido pendente encerra o pedido e diz na linha do tempo', async () => {
    const { osId } = await osPedidaEConcluida();
    const linha = linhaDaOs(osId);
    expect(linha.approval_requested_at).toBeNull();
    expect(linha.approved_at).toBeNull();
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_service_order_comments WHERE order_id = ? AND body LIKE 'Pedido de aprovação encerrado%'",
        osId,
      ),
    ).toBe(1);
  });

  it('o portal recusa decidir OS que saiu da bancada (estado legado com pedido pendurado)', async () => {
    const { osId, customerId } = await osPedidaEConcluida();
    // O estado que o código antigo deixava: pedido de pé numa OS na fila do caixa.
    const pendurado = '2026-09-01T10:00:00.000Z';
    getConnection()
      .prepare('UPDATE core_service_orders SET approval_requested_at = ? WHERE id = ?')
      .run(pendurado, osId);

    expect(() => decidirOrcamento([customerId], osId, 'recusar')).toThrowError(
      expect.objectContaining({ code: 'PORTAL_ORDER_NOT_ON_BENCH', status: 409 }),
    );
    expect(() => decidirOrcamento([customerId], osId, 'aprovar')).toThrowError(
      expect.objectContaining({ code: 'PORTAL_ORDER_NOT_ON_BENCH' }),
    );
    // Nada mudou: o pedido não foi apagado, nem a fala do cliente registrada.
    expect(linhaDaOs(osId).approval_requested_at).toBe(pendurado);
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_service_order_comments WHERE order_id = ? AND author_kind = 'proprietario'",
        osId,
      ),
    ).toBe(0);

    // O balcão (aceite por telefone) usa a mesma decisão e recebe a mesma recusa.
    const balcao = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/decidir-orcamento`)
      .set(atendente.auth)
      .send({ approved: false });
    expect(balcao.status).toBe(409);
    expect(balcao.body.error.code).toBe('PORTAL_ORDER_NOT_ON_BENCH');
  });

  it('o portal do dono não oferece a decisão fora da bancada', async () => {
    const customerId = await clienteDoCadastro();
    const eq = await request(app)
      .post('/api/v1/core/equipment')
      .set(gerente.auth)
      .send({ workshopId: bancadaA, origin: 'EXTERNAL_CUSTOMER', ownerCustomerId: customerId, brand: 'X', model: 'Y' });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ workshopId: bancadaA, customerId, equipmentId: eq.body.id, complaint: 'x' });
    const osId = String(os.body.id);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/assume`).set(mec1.auth).send({ status: 'em_andamento', comment: 'ok' }).expect(200);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/labor`).set(mec1.auth).send({ laborCents: 8000 }).expect(200);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`).set(mec1.auth).send({}).expect(200);

    let ficha = equipamentoDoDono([customerId], String(eq.body.id));
    expect(ficha?.ordens[0].aguardandoDecisao).toBe(true);

    // Estado legado: o pedido pendurado numa OS que já está na fila do caixa.
    getConnection()
      .prepare("UPDATE core_service_orders SET status = 'aguardando_pagamento' WHERE id = ?")
      .run(osId);
    ficha = equipamentoDoDono([customerId], String(eq.body.id));
    expect(ficha?.ordens[0].aguardandoDecisao).toBe(false);
  });

  it('na bancada, a decisão do portal continua valendo', async () => {
    const customerId = await clienteDoCadastro();
    const osId = await osAssumida(customerId);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/labor`).set(mec1.auth).send({ laborCents: 8000 }).expect(200);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`).set(mec1.auth).send({}).expect(200);
    const r = decidirOrcamento([customerId], osId, 'aprovar');
    expect(r.ordem.approvedAt).toBeTruthy();
  });
});
