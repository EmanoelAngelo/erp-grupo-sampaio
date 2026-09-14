/**
 * Oficinas, equipamentos e regra de assumir OS.
 *
 * Executa as operações de verdade contra o banco e confere o estado. Cada
 * teste corresponde a uma regra de negócio declarada pelo cliente.
 *
 * NOTA DA RODADA 52: as conclusões daqui mandam `forcarChecklist: true`. A
 * conferência de entrada passou a segurar a conclusão técnica, e o assunto
 * DESTE arquivo é o dinheiro da OS — o gate da conferência (bloqueio,
 * resposta legítima "não veio", forçar registrado) tem casos próprios em
 * `equipamento-completo.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialWorkshops, migrateCoreSchema } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  linkUserToWorkshop,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { formatPublicId } from '../src/services/core/EquipmentService.js';

const app = createApp();
const PASSWORD = 'Teste@Oficina2026';

interface Actor {
  token: string;
  auth: { Authorization: string };
  userId: string;
}

async function makeActor(
  login: string,
  companyId: string,
  profile: string,
  workshopId?: string,
): Promise<Actor> {
  const userId = await upsertUser({ login, displayName: login, password: PASSWORD });
  linkUserToCompany(userId, companyId, profile, true);
  if (workshopId) linkUserToWorkshop(userId, workshopId, 'mecanico');
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: PASSWORD });
  expect(res.status).toBe(200);
  return { token: res.body.accessToken, auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

function workshopIdOf(slug: string): string {
  const row = getConnection()
    .prepare('SELECT id FROM core_workshops WHERE slug = ?')
    .get(slug) as { id: string };
  return row.id;
}

let oficinaCo: string;
let precoJustoCo: string;
let mobilidade: string;
let celulares: string;

beforeEach(() => {
  resetDbForTests();
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
  upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
  ensureOfficialWorkshops();
  mobilidade = workshopIdOf('oficina-mobilidade');
  celulares = workshopIdOf('oficina-celulares');
});

describe('duas oficinas sem criar empresa nova', () => {
  it('mobilidade fica na Oficina e celulares no Preço Justo', () => {
    const rows = getConnection()
      .prepare(
        `SELECT w.slug, c.slug AS company FROM core_workshops w
           JOIN core_companies c ON c.id = w.company_id ORDER BY w.slug`,
      )
      .all() as unknown as { slug: string; company: string }[];
    expect(rows).toEqual([
      { slug: 'oficina-celulares', company: 'preco-justo' },
      { slug: 'oficina-mobilidade', company: 'oficina' },
    ]);

    // Continuam existindo exatamente seis empresas: nenhuma sétima foi criada.
    const companies = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_companies')
      .get() as { n: number };
    expect(companies.n).toBe(3); // as três criadas neste teste
  });

  it('técnico de celulares não enxerga OS da mobilidade', async () => {
    const mecanico = await makeActor('MEC1', oficinaCo, 'mecanico', mobilidade);
    const tecnico = await makeActor('TEC1', precoJustoCo, 'mecanico', celulares);

    await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mecanico.auth)
      .send({ customerName: 'Dono da moto', complaint: 'Não liga' });

    const res = await request(app).get('/api/v1/core/workshop/orders').set(tecnico.auth);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('técnico não pode pedir uma oficina em que não está vinculado', async () => {
    const tecnico = await makeActor('TEC2', precoJustoCo, 'mecanico', celulares);
    const res = await request(app)
      .get('/api/v1/core/workshop/orders')
      .query({ workshopId: mobilidade })
      .set(tecnico.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_FORBIDDEN');
  });
});

describe('regra de assumir a OS', () => {
  it('OS nasce em aberto e sem responsável', async () => {
    const mecanico = await makeActor('MEC2', oficinaCo, 'mecanico', mobilidade);
    const res = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mecanico.auth)
      .send({ customerName: 'Maria', complaint: 'Freio' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('em_aberto');
    expect(res.body.mechanic_id).toBeNull();
  });

  it('não sai de em aberto sem assumir', async () => {
    const mecanico = await makeActor('MEC3', oficinaCo, 'mecanico', mobilidade);
    const created = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mecanico.auth)
      .send({ customerName: 'Maria' });

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/move`)
      .set(mecanico.auth)
      // Com observação (obrigatória desde a r51) — o guarda em teste é o
      // do assumir, e sem ela o 400 do comentário falaria primeiro.
      .send({ status: 'em_andamento', comment: 'tentando pular o assumir' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_MUST_ASSUME_FIRST');
  });

  it('assumir exige comentário', async () => {
    const mecanico = await makeActor('MEC4', oficinaCo, 'mecanico', mobilidade);
    const created = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mecanico.auth)
      .send({ customerName: 'Maria' });

    const semComentario = await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/assume`)
      .set(mecanico.auth)
      .send({ status: 'em_andamento' });
    expect(semComentario.status).toBe(400);
    expect(semComentario.body.error.code).toBe('CORE_COMMENT_REQUIRED');

    const ok = await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/assume`)
      .set(mecanico.auth)
      .send({ status: 'em_andamento', comment: 'Recebi a moto, iniciando diagnóstico' });
    expect(ok.status).toBe(200);
    expect(ok.body.mechanic_id).toBe(mecanico.userId);
    expect(ok.body.assigned_at).toBeTruthy();
  });

  it('outro mecânico não mexe em OS já assumida', async () => {
    const dono = await makeActor('MEC5', oficinaCo, 'mecanico', mobilidade);
    const outro = await makeActor('MEC6', oficinaCo, 'mecanico', mobilidade);

    const created = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(dono.auth)
      .send({ customerName: 'Maria' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/assume`)
      .set(dono.auth)
      .send({ status: 'em_andamento', comment: 'assumindo' });

    const mover = await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/move`)
      .set(outro.auth)
      .send({ status: 'aguardando_peca', comment: 'tentando mexer na OS alheia' });
    expect(mover.status).toBe(403);
    expect(mover.body.error.code).toBe('CORE_ORDER_NOT_ASSIGNED_TO_YOU');

    const assumir = await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/assume`)
      .set(outro.auth)
      .send({ status: 'em_andamento', comment: 'quero pegar' });
    expect(assumir.status).toBe(409);
    expect(assumir.body.error.code).toBe('CORE_ORDER_ALREADY_ASSIGNED');
  });
});

describe('timeline append-only', () => {
  it('acumula comentários sem sobrescrever', async () => {
    const mecanico = await makeActor('MEC7', oficinaCo, 'mecanico', mobilidade);
    const created = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(mecanico.auth)
      .send({ customerName: 'Maria' });
    const id = created.body.id;

    await request(app)
      .post(`/api/v1/core/workshop/orders/${id}/assume`)
      .set(mecanico.auth)
      .send({ status: 'em_andamento', comment: 'Comentário 1' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${id}/comments`)
      .set(mecanico.auth)
      .send({ body: 'Comentário 2' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${id}/comments`)
      .set(mecanico.auth)
      .send({ body: 'Comentário 3' });

    const detail = await request(app)
      .get(`/api/v1/core/workshop/orders/${id}`)
      .set(mecanico.auth);
    const bodies = detail.body.comments.map((c: { body: string }) => c.body);
    expect(bodies).toEqual(['Comentário 1', 'Comentário 2', 'Comentário 3']);
    expect(detail.body.comments[0].author_name).toBe('MEC7');
  });
});

describe('equipamentos', () => {
  it('gera #ID sequencial único e token opaco sem dado pessoal', async () => {
    const mecanico = await makeActor('MEC8', oficinaCo, 'mecanico', mobilidade);
    const a = await request(app)
      .post('/api/v1/core/equipment')
      .set(mecanico.auth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'PJ', model: 'Sport' });
    const b = await request(app)
      .post('/api/v1/core/equipment')
      .set(mecanico.auth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'PJ', model: 'Urban' });

    expect(a.status).toBe(201);
    expect(b.body.public_id).toBe(a.body.public_id + 1);
    expect(a.body.publicIdLabel).toMatch(/^#\d{4}$/);
    expect(formatPublicId(1)).toBe('#0001');

    // O token do QR é opaco: não deriva do #ID nem carrega dado pessoal, e
    // dois equipamentos consecutivos recebem tokens sem relação entre si.
    // O token não sai na resposta de criação (GAP-PRD-106): lido do banco.
    expect(a.body.public_token).toBeUndefined();
    const tokenDe = (id: string): string =>
      (getConnection().prepare('SELECT public_token FROM core_equipment WHERE id = ?').get(id) as { public_token: string })
        .public_token;
    const tokenA = tokenDe(a.body.id);
    const tokenB = tokenDe(b.body.id);
    expect(tokenA).not.toContain(a.body.publicIdLabel);
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA.length).toBeGreaterThanOrEqual(30);
    expect(tokenA).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('equipamento interno não nasce com proprietário', async () => {
    const mecanico = await makeActor('MEC9', oficinaCo, 'mecanico', mobilidade);
    const res = await request(app)
      .post('/api/v1/core/equipment')
      .set(mecanico.auth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'PJ' });
    expect(res.body.owner_customer_id).toBeNull();
    expect(res.body.sale_status).toBe('NOT_SOLD');
  });

  it('equipamento externo exige proprietário', async () => {
    const mecanico = await makeActor('MEC10', oficinaCo, 'mecanico', mobilidade);
    const res = await request(app)
      .post('/api/v1/core/equipment')
      .set(mecanico.auth)
      .send({ origin: 'EXTERNAL_CUSTOMER', brand: 'Outra' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_OWNER_REQUIRED');
  });

  // A tela de equipamentos oferece UMA caixa de busca e promete achar pela
  // plaquinha. Ela é o identificador que o balcão usa em voz alta — se a busca
  // ignorasse o número, a tela estaria mentindo no próprio placeholder.
  it('busca acha pela plaquinha, com # ou sem, e ainda por marca e chassi', async () => {
    const mecanico = await makeActor('MECBUSCA', oficinaCo, 'mecanico', mobilidade);
    const criado = await request(app)
      .post('/api/v1/core/equipment')
      .set(mecanico.auth)
      .send({
        origin: 'INTERNAL_PJ_MOTORS',
        brand: 'Yamaha',
        model: 'Fluo',
        chassis: 'CHASSI-XYZ-9',
      });
    expect(criado.status).toBe(201);

    const rotulo: string = criado.body.publicIdLabel;
    const numero: number = criado.body.public_id;

    const buscar = async (termo: string) => {
      const res = await request(app)
        .get(`/api/v1/core/equipment?search=${encodeURIComponent(termo)}`)
        .set(mecanico.auth);
      return (res.body.items as { id: string }[]).map((i) => i.id);
    };

    // As três formas que a pessoa digita para a mesma plaquinha.
    expect(await buscar(rotulo)).toContain(criado.body.id);
    expect(await buscar(String(numero).padStart(4, '0'))).toContain(criado.body.id);
    expect(await buscar(String(numero))).toContain(criado.body.id);

    expect(await buscar('yamaha')).toContain(criado.body.id);
    expect(await buscar('CHASSI-XYZ')).toContain(criado.body.id);

    // Um termo que não é nada não pode devolver a lista inteira.
    expect(await buscar('ZZZ-INEXISTENTE')).not.toContain(criado.body.id);
  });

  it('a lista traz a plaquinha já formatada, sem cada tela reinventar o padrão', async () => {
    const mecanico = await makeActor('MECROTULO', oficinaCo, 'mecanico', mobilidade);
    await request(app)
      .post('/api/v1/core/equipment')
      .set(mecanico.auth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'Rotulo' });

    const res = await request(app).get('/api/v1/core/equipment').set(mecanico.auth);
    expect(res.status).toBe(200);
    for (const item of res.body.items as { publicIdLabel: string }[]) {
      expect(item.publicIdLabel).toMatch(/^#\d{4,}$/);
    }
  });

  it('venda vincula proprietário preservando o histórico anterior', async () => {
    const gerente = await makeActor('GER1', oficinaCo, 'gerente_oficina');
    const equipment = await request(app)
      .post('/api/v1/core/equipment')
      .set(gerente.auth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'PJ', model: 'Sport', workshopId: mobilidade });

    const customer = await request(app)
      .post('/api/v1/core/customers')
      .set(gerente.auth)
      .send({ name: 'Comprador' });

    const sold = await request(app)
      .post(`/api/v1/core/equipment/${equipment.body.id}/owner`)
      .set(gerente.auth)
      .send({ customerId: customer.body.id });

    expect(sold.status).toBe(200);
    expect(sold.body.owner_customer_id).toBe(customer.body.id);
    expect(sold.body.sale_status).toBe('SOLD');
    // O registro é o MESMO: id preservado, histórico intacto.
    expect(sold.body.id).toBe(equipment.body.id);
    expect(sold.body.public_id).toBe(equipment.body.public_id);

    const events = getConnection()
      .prepare('SELECT event_type FROM core_equipment_events WHERE equipment_id = ? ORDER BY created_at')
      .all(equipment.body.id) as unknown as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual(['created', 'sold']);
  });
});

describe('OS com custo passa pelo pagamento', () => {
  async function orderWithPart() {
    const gerente = await makeActor('GER2', oficinaCo, 'gerente_oficina', mobilidade);
    const part = await request(app)
      .post('/api/v1/core/products')
      .set(gerente.auth)
      // A oficina passou a ser OBRIGATÓRIA na peça: sem bancada dona, ela não
      // aparece na tela de peças nem na vitrine — some do sistema.
      .send({
        name: 'Pastilha de freio',
        priceCents: 9000,
        kind: 'part',
        workshopId: mobilidade,
      });
    await request(app).post('/api/v1/core/stock/movements').set(gerente.auth).send({
      productId: part.body.id,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'nf-pecas',
    });
    const order = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ customerName: 'Maria', complaint: 'Freio' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${order.body.id}/assume`)
      .set(gerente.auth)
      .send({ status: 'em_andamento', comment: 'assumindo' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${order.body.id}/parts`)
      .set(gerente.auth)
      .send({ productId: part.body.id, quantity: 1 });
    return { gerente, orderId: order.body.id as string, partId: part.body.id as string };
  }

  it('conclusão técnica com custo vai para aguardando pagamento, não finalizada', async () => {
    const { gerente, orderId } = await orderWithPart();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(gerente.auth)
      .send({ diagnosis: 'Trocada a pastilha', hasCost: true, forcarChecklist: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('aguardando_pagamento');
    expect(res.body.total_cents).toBe(9000);
  });

  it('não permite marcar sem custo quando há peça lançada', async () => {
    const { gerente, orderId } = await orderWithPart();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(gerente.auth)
      .send({ diagnosis: 'x', hasCost: false, noCostReason: 'garantia', forcarChecklist: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_HAS_PARTS_COST');
  });

  it('sem custo exige motivo válido', async () => {
    const gerente = await makeActor('GER3', oficinaCo, 'gerente_oficina', mobilidade);
    const order = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ customerName: 'Maria' });
    await request(app)
      .post(`/api/v1/core/workshop/orders/${order.body.id}/assume`)
      .set(gerente.auth)
      .send({ status: 'em_andamento', comment: 'ok' });

    const semMotivo = await request(app)
      .post(`/api/v1/core/workshop/orders/${order.body.id}/complete`)
      .set(gerente.auth)
      .send({ diagnosis: 'Ajuste simples', hasCost: false, noCostReason: 'porque sim', forcarChecklist: true });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_NO_COST_REASON_REQUIRED');

    const garantia = await request(app)
      .post(`/api/v1/core/workshop/orders/${order.body.id}/complete`)
      .set(gerente.auth)
      .send({ diagnosis: 'Ajuste simples', hasCost: false, noCostReason: 'garantia', forcarChecklist: true });
    expect(garantia.status).toBe(200);
    expect(garantia.body.status).toBe('finalizada');
  });

  it('ninguém arrasta a OS direto para finalizada', async () => {
    const { gerente, orderId } = await orderWithPart();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/move`)
      .set(gerente.auth)
      .send({ status: 'finalizada', comment: 'tentando fechar pelo arrasto' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FINALIZE_VIA_PAYMENT');
  });

  it('PDV recebe, gera UM lançamento financeiro e fecha a OS sem rebaixar estoque', async () => {
    const { gerente, orderId, partId } = await orderWithPart();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(gerente.auth)
      .send({ diagnosis: 'ok', hasCost: true, forcarChecklist: true });

    const fila = await request(app).get('/api/v1/core/workshop/pending-payment').set(gerente.auth);
    expect(fila.body.items).toHaveLength(1);

    const checkout = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/checkout`)
      .set(gerente.auth)
      .send({ payments: [{ method: 'dinheiro', amountCents: 9000 }] });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order.status).toBe('finalizada');
    expect(checkout.body.order.paid_at).toBeTruthy();

    // A peça já havia baixado no lançamento: o checkout NÃO baixa de novo.
    const stock = await request(app).get('/api/v1/core/stock').set(gerente.auth);
    const line = stock.body.items.find((i: { product_id: string }) => i.product_id === partId);
    expect(line.quantity).toBe(4);

    // Um único fato econômico.
    const entries = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale'")
      .get() as { n: number };
    expect(entries.n).toBe(1);
  });

  it('reenviar o checkout não duplica venda nem receita', async () => {
    const { gerente, orderId } = await orderWithPart();
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(gerente.auth)
      .send({ diagnosis: 'ok', hasCost: true, forcarChecklist: true });

    const first = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/checkout`)
      .set(gerente.auth)
      .send({ payments: [{ method: 'dinheiro', amountCents: 9000 }] });
    const second = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/checkout`)
      .set(gerente.auth)
      .send({ payments: [{ method: 'dinheiro', amountCents: 9000 }] });

    expect(first.status).toBe(201);
    // O reenvio (mesma chave — aqui a padrão da OS) devolve o recebimento que
    // aconteceu, em vez de 409 (GAP-PRD-209): quem perdeu a resposta a recebe.
    expect(second.status).toBe(200);
    expect(second.body.replay).toBe(true);
    expect(second.body.sale.id).toBe(first.body.sale.id);

    const sales = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales')
      .get() as { n: number };
    expect(sales.n).toBe(1);
  });
});

describe('migração de banco existente', () => {
  it('preserva OS antigas e converte os estados legados', () => {
    const db = getConnection();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_service_orders
         (id, company_id, number, customer_name, status, labor_cents, parts_cents,
          total_cents, created_at, updated_at)
       VALUES ('os-legada', ?, 9999, 'Cliente Antigo', 'em_execucao', 0, 0, 0, ?, ?)`,
    ).run(oficinaCo, now, now);

    // Simula um banco que ainda não passou pela migração.
    db.prepare("DELETE FROM core_meta WHERE key = 'core_schema_version'").run();
    const result = migrateCoreSchema();
    expect(result.to).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT status, customer_name FROM core_service_orders WHERE id = ?')
      .get('os-legada') as { status: string; customer_name: string };
    expect(row.customer_name).toBe('Cliente Antigo');
    expect(row.status).toBe('em_andamento');
  });
});
